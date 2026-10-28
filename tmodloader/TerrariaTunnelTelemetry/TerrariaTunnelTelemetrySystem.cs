using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Xna.Framework;
using Terraria;
using Terraria.DataStructures;
using Terraria.GameContent;
using Terraria.GameContent.Tile_Entities;
using Terraria.ID;
using Terraria.ModLoader;
using Terraria.ModLoader.IO;
using Terraria.Map;
using Terraria.Localization;

namespace TerrariaTunnelTelemetry;

public sealed class TerrariaTunnelTelemetrySystem : ModSystem
{
    private static readonly TimeSpan SnapshotInterval = TimeSpan.FromSeconds(1);
    private static readonly JsonSerializerOptions JsonOptions = new();
    private readonly ConcurrentDictionary<int, string> _clientUuids = new();
    private readonly System.Collections.Generic.Dictionary<int, PlayerSession> _sessions = new();
    private readonly ConcurrentDictionary<int, byte> _teleportedSlots = new();
    private readonly System.Collections.Generic.HashSet<int> _deadPlayerSlots = new();
    private readonly System.Collections.Generic.List<PendingPlayerDeath> _pendingPlayerDeaths = new();
    private TelemetryStreamServer? _telemetryStream;
    private MapTileNameCatalog? _mapTileNames;
    private MapTileDataCapture? _mapTileData;
    private WorldEntitySnapshotBuilder? _worldEntities;
    private PlayerMapCapture? _playerMapCapture;
    private WorldMapScanner? _mapScanner;
    private bool _loggedFirstSnapshot;
    private bool _loggedUpdateHook;
    private DateTime _lastSnapshotUtc = DateTime.MinValue;

    public override void Load()
    {
        var portText = Environment.GetEnvironmentVariable("TERRARIA_TELEMETRY_PORT");
        var port = int.TryParse(portText, out var configuredPort) && configuredPort is >= 1 and <= 65535
            ? configuredPort
            : 38762;

        Terraria.On_MessageBuffer.GetData += CaptureClientPackets;
        On_Player.Teleport += CapturePlayerTeleport;
        Main.OnTickForThirdPartySoftwareOnly += OnServerTick;
        _telemetryStream = new TelemetryStreamServer(Mod);
        _mapTileNames = new MapTileNameCatalog(Mod);
        _mapTileData = new MapTileDataCapture(_mapTileNames);
        _mapScanner = new WorldMapScanner(Mod, _mapTileNames, _mapTileData);
        _worldEntities = new WorldEntitySnapshotBuilder(Mod);
        _playerMapCapture = new PlayerMapCapture(Mod, _mapScanner, _mapTileData);
        _telemetryStream.Start(port);
    }

    public override void Unload()
    {
        Terraria.On_MessageBuffer.GetData -= CaptureClientPackets;
        On_Player.Teleport -= CapturePlayerTeleport;
        Main.OnTickForThirdPartySoftwareOnly -= OnServerTick;
        _telemetryStream?.Dispose();
        _telemetryStream = null;
        _clientUuids.Clear();
        _teleportedSlots.Clear();
        _sessions.Clear();
        _deadPlayerSlots.Clear();
        _pendingPlayerDeaths.Clear();
        _mapScanner = null;
        _mapTileNames = null;
        _mapTileData = null;
        _worldEntities = null;
        _playerMapCapture = null;
    }

    private void CapturePlayerTeleport(On_Player.orig_Teleport orig, Player self, Vector2 newPosition, int style, int extraInfo)
    {
        orig(self, newPosition, style, extraInfo);
        if (Main.netMode == NetmodeID.Server && self.whoAmI >= 0 && self.whoAmI < Main.maxPlayers)
            _teleportedSlots[self.whoAmI] = 1;
    }

    private void OnServerTick()
    {
        if (Main.netMode != NetmodeID.Server)
            return;
        _mapScanner?.CaptureNextChunk();
        UpdateSnapshotIfDue();
    }

    public override void OnWorldLoad()
    {
        Mod.Logger.Info($"World loaded for telemetry (netMode={Main.netMode}, world='{Main.worldName}').");
        // World load can run on a worker thread. Let the game update hook reset
        // the scanner and its queue on the thread that owns them.
        UpdateSnapshotIfDue();
    }

    private void UpdateSnapshotIfDue()
    {
        if (!_loggedUpdateHook)
        {
            _loggedUpdateHook = true;
            Mod.Logger.Info($"Telemetry update hook invoked (netMode={Main.netMode}, world='{Main.worldName}').");
        }
        if (Main.netMode != NetmodeID.Server)
            return;

        var now = DateTime.UtcNow;
        if (now - _lastSnapshotUtc < SnapshotInterval)
            return;
        _lastSnapshotUtc = now;

        try
        {
            ReconcilePlayers();
            PublishSnapshot(now);
        }
        catch (Exception exception)
        {
            Mod.Logger.Error($"Could not create telemetry snapshot: {exception.GetType().Name}: {exception.Message}");
        }
    }

    private void ReconcilePlayers()
    {
        var activeSlots = new System.Collections.Generic.HashSet<int>();
        for (var slot = 0; slot < Main.player.Length; slot++)
        {
            var player = Main.player[slot];
            var name = player?.name?.Trim();
            if (player is null || !player.active || string.IsNullOrWhiteSpace(name)
                || name is "." or ".." or "...")
                continue;

            activeSlots.Add(slot);
            if (player.dead)
            {
                if (_deadPlayerSlots.Add(slot))
                {
                    _pendingPlayerDeaths.Add(new PendingPlayerDeath(
                        name,
                        ReadClientUuid(slot),
                        (int)Math.Floor(player.Center.X / 16.0),
                        (int)Math.Floor(player.Center.Y / 16.0),
                        DateTimeOffset.UtcNow.ToUnixTimeSeconds()
                    ));
                }
            }
            else
            {
                _deadPlayerSlots.Remove(slot);
            }
            if (!_sessions.TryGetValue(slot, out var session) || !string.Equals(session.Name, name, StringComparison.Ordinal))
                _sessions[slot] = new PlayerSession(name, ReadClientUuid(slot), DateTimeOffset.UtcNow.ToUnixTimeSeconds());
            else if (ReadClientUuid(slot) is { } uuid && !string.Equals(session.Uuid, uuid, StringComparison.Ordinal))
                _sessions[slot] = session with { Uuid = uuid };
        }

        foreach (var slot in _sessions.Keys.Where(slot => !activeSlots.Contains(slot)).ToArray())
        {
            _sessions.Remove(slot);
            _deadPlayerSlots.Remove(slot);
            _clientUuids.TryRemove(slot, out _);
            _teleportedSlots.TryRemove(slot, out _);
        }
    }

    private void PublishSnapshot(DateTime now)
    {
        var calamityProgress = BossProgressSnapshotReader.ReadCalamityBossProgress();
        var bossDefeatCounts = BossVictoryTracker.SnapshotCounts();
        var playerDeaths = _pendingPlayerDeaths
            .Select(death => new
            {
                name = death.Name,
                uuid = death.Uuid,
                x = death.TileX,
                y = death.TileY,
                at = death.Timestamp
            })
            .ToArray();
        _pendingPlayerDeaths.Clear();
        var players = _sessions
            .OrderBy(pair => pair.Key)
            .Select(pair => new
            {
                player = Main.player[pair.Key],
                slot = pair.Key,
                name = pair.Value.Name,
                uuid = pair.Value.Uuid,
                joinedAtUnix = pair.Value.JoinedAtUnix,
                sessionSeconds = Math.Max(0, DateTimeOffset.UtcNow.ToUnixTimeSeconds() - pair.Value.JoinedAtUnix)
            })
            .Select(entry =>
            {
                var teleported = _teleportedSlots.TryRemove(entry.slot, out _);
                return new
                {
                    entry.slot,
                    entry.name,
                    entry.uuid,
                    entry.joinedAtUnix,
                    entry.sessionSeconds,
                    team = (int)entry.player.team,
                    direction = entry.player.direction,
                    teleported,
                    position = new
                    {
                        tileX = (int)Math.Floor(entry.player.position.X / 16.0),
                        tileY = (int)Math.Floor(entry.player.position.Y / 16.0)
                    },
                    mapCapture = teleported ? null : _playerMapCapture!.Capture(entry.player, entry.uuid ?? entry.name),
                    appearance = PlayerAppearanceSnapshotBuilder.Capture(entry.player)
                };
            })
            .ToArray();

        var mode = Main.GameMode;
        var snapshot = new
        {
            schemaVersion = 1,
            generatedAtUnix = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            server = new
            {
                version = Main.versionNumber,
                serverAssemblyVersion = typeof(Main).Assembly.GetName().Version?.ToString(),
                dedicated = Main.netMode == NetmodeID.Server,
                maxPlayers = Main.maxPlayers,
                playersOnline = players.Length
            },
            world = new
            {
                name = Main.worldName,
                id = Main.worldID,
                width = Main.maxTilesX,
                height = Main.maxTilesY,
                surface = Main.worldSurface,
                language = Language.ActiveCulture.Name,
                spawnX = Main.spawnTileX,
                spawnY = Main.spawnTileY,
                gameMode = new { id = mode, name = GameModeName(mode) },
                hardmode = Main.hardMode,
                crimson = WorldGen.crimson,
                day = Main.dayTime,
                time = Main.time,
                moonPhase = Main.moonPhase,
                bloodMoon = Main.bloodMoon,
                eclipse = Main.eclipse,
                raining = Main.raining,
                slimeRain = Main.slimeRain,
                activeBosses = Main.npc
                    .Where(npc => npc.active && npc.boss)
                    .Select(npc => MapTileNameCatalog.GetLocalizedNpcName(npc))
                    .Distinct()
                    .ToArray(),
                bossDiagnostics = Main.npc
                    .Where(npc => npc.active && npc.boss)
                    .Select(npc => new
                    {
                        slot = npc.whoAmI,
                        type = npc.type,
                        name = MapTileNameCatalog.GetLocalizedNpcName(npc),
                        mod = npc.ModNPC?.Mod?.Name,
                        modName = npc.ModNPC?.Name,
                        life = npc.life,
                        lifeMax = npc.lifeMax
                    })
                    .ToArray(),
                activeNpcs = _worldEntities!.CaptureActiveNpcs(),
                droppedCoins = _worldEntities!.CaptureDroppedCoins(),
                defeatedBosses = BossProgressSnapshotReader.DefeatedBosses(calamityProgress.Bosses),
                bossDefeatCounts,
                bossStatus = new
                {
                    calamityAvailable = calamityProgress.Available,
                    calamityBosses = calamityProgress.Bosses
                }
            },
            pylons = _worldEntities!.CapturePylons(),
            players = new
            {
                online = players.Length,
                list = players
            },
            playerDeaths,
            mapScan = _mapScanner?.GetStatus(),
            baseMapCaptures = _mapScanner?.DrainCaptures() ?? Array.Empty<object>()
        };

        // Keep each complete JSON document on one line for robust JSONL framing.
        var jsonLine = JsonSerializer.Serialize(snapshot, JsonOptions) + "\n";
        if (!_loggedFirstSnapshot)
        {
            _loggedFirstSnapshot = true;
            Mod.Logger.Info("First live telemetry snapshot generated.");
        }
        _telemetryStream?.Publish(jsonLine);
    }

    // Dedicated servers do not know each client's window size or its private
    // .map file. Capture the current screen-sized world region around players,
    // using Terraria's own map palette (including loaded mod map entries).
    // The monitor merges these overlapping RGBA patches into persistent maps.
    private string? ReadClientUuid(int slot)
    {
        try
        {
            if (_clientUuids.TryGetValue(slot, out var capturedUuid))
                return capturedUuid;
            var client = Netplay.Clients[slot];
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            var property = client.GetType().GetProperty("ClientUUID", flags);
            var field = client.GetType().GetField("ClientUUID", flags);
            return (property?.GetValue(client) ?? field?.GetValue(client)) as string;
        }
        catch
        {
            return null;
        }
    }

    private void CaptureClientPackets(
        Terraria.On_MessageBuffer.orig_GetData orig,
        MessageBuffer messageBuffer,
        int start,
        int length,
        out int messageType
    )
    {
        orig(messageBuffer, start, length, out messageType);
        if (Main.netMode != NetmodeID.Server)
            return;

        var slot = messageBuffer.whoAmI;
        if (slot < 0 || slot >= Netplay.Clients.Length)
            return;
        if (messageType == 1)
        {
            _clientUuids.TryRemove(slot, out _);
            return;
        }
        // Vanilla mirrors, pylons and other arbitrary-coordinate teleports
        // arrive as TeleportEntity. Recall/conch-style teleports can use the
        // server-requested teleport packet instead. Capture the packet on the
        // server because some clients synchronize position without invoking
        // Player.Teleport in the server process.
        if (messageType == MessageID.TeleportEntity
            || messageType == MessageID.RequestTeleportationByServer)
        {
            _teleportedSlots[slot] = 1;
            return;
        }
        if (messageType != 68 || start < 0 || length < 2 || start + length > messageBuffer.readBuffer.Length)
            return;

        try
        {
            using var stream = new MemoryStream(messageBuffer.readBuffer, start + 1, length - 1, writable: false);
            using var reader = new BinaryReader(stream, Encoding.UTF8, leaveOpen: false);
            var uuid = reader.ReadString().Trim();
            if (uuid.Length is 0 or > 128 || uuid.Any(char.IsControl))
                return;

            _clientUuids[slot] = uuid;
            Mod.Logger.Debug($"Captured client UUID for player slot {slot}.");
        }
        catch (Exception exception)
        {
            Mod.Logger.Warn($"Could not decode ClientUUID packet for player slot {slot}: {exception.GetType().Name}.");
        }
    }

    private static string GameModeName(int mode) => mode switch
    {
        0 => "classic",
        1 => "expert",
        2 => "master",
        3 => "journey",
        _ => "unknown"
    };

    private sealed record PlayerSession(string Name, string? Uuid, long JoinedAtUnix);
    private sealed record PendingPlayerDeath(string Name, string? Uuid, int TileX, int TileY, long Timestamp);
}
