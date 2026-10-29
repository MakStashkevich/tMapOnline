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
    private static readonly JsonSerializerOptions JsonOptions = new();
    private readonly ConcurrentDictionary<int, string> _clientUuids = new();
    private readonly System.Collections.Generic.Dictionary<int, PlayerSession> _sessions = new();
    private readonly ConcurrentDictionary<int, byte> _teleportedSlots = new();
    private readonly System.Collections.Generic.List<PendingPlayerDeath> _pendingPlayerDeaths = new();
    private readonly System.Collections.Generic.Dictionary<int, System.Collections.Generic.Dictionary<string, object?>> _cachedPlayers = new();
    private object[] _cachedNpcs = Array.Empty<object>();
    private object[] _cachedCoins = Array.Empty<object>();
    private object[] _cachedPylons = Array.Empty<object>();
    private string[] _cachedActiveBosses = Array.Empty<string>();
    private object[] _cachedBossDiagnostics = Array.Empty<object>();
    private string[] _cachedDefeatedBosses = Array.Empty<string>();
    private System.Collections.Generic.Dictionary<string, bool?> _cachedCalamityBosses = new();
    private System.Collections.Generic.Dictionary<string, int> _cachedBossDefeatCounts = new();
    private bool _cachedCalamityAvailable;
    private TelemetryStreamServer? _telemetryStream;
    private MapTileNameCatalog? _mapTileNames;
    private MapTileDataCapture? _mapTileData;
    private WorldEntitySnapshotBuilder? _worldEntities;
    private PlayerMapCapture? _playerMapCapture;
    private WorldMapScanner? _mapScanner;
    private bool _loggedFirstSnapshot;
    private bool _loggedUpdateHook;
    private readonly int _playerPositionIntervalTicks = ReadPositiveEnvironmentInteger(
        "TERRARIA_TELEMETRY_PLAYER_POSITION_INTERVAL_TICKS", 6);
    private readonly int _entityIntervalTicks = ReadPositiveEnvironmentInteger(
        "TERRARIA_TELEMETRY_ENTITY_INTERVAL_TICKS", 6);
    private readonly int _mapCaptureIntervalTicks = ReadPositiveEnvironmentInteger(
        "TERRARIA_TELEMETRY_MAP_CAPTURE_INTERVAL_TICKS", 30);
    private readonly int _mapTileUpdateIntervalTicks = ReadPositiveEnvironmentInteger(
        "TERRARIA_TELEMETRY_MAP_TILE_UPDATE_INTERVAL_TICKS", 1);
    private readonly int _worldScanIntervalTicks = ReadPositiveEnvironmentInteger(
        "TERRARIA_TELEMETRY_WORLD_SCAN_INTERVAL_TICKS", 1);
    private readonly int _deathRetentionSeconds = ReadNonNegativeEnvironmentInteger(
        "TERRARIA_TELEMETRY_DEATH_RETENTION_SECONDS", 3600);
    private long _serverTickCount;
    private long _nextSnapshotId;

    public override void Load()
    {
        var portText = Environment.GetEnvironmentVariable("TERRARIA_TELEMETRY_PORT");
        var port = int.TryParse(portText, out var configuredPort) && configuredPort is >= 1 and <= 65535
            ? configuredPort
            : 38762;

        Terraria.On_MessageBuffer.GetData += CaptureClientPackets;
        On_WorldGen.PlaceTile += CaptureTilePlacement;
        On_WorldGen.KillTile += CaptureTileBreak;
        On_WorldGen.PlaceWall += CaptureWallPlacement;
        On_WorldGen.KillWall += CaptureWallBreak;
        On_Player.Teleport += CapturePlayerTeleport;
        On_Player.KillMe += CapturePlayerDeath;
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
        On_WorldGen.PlaceTile -= CaptureTilePlacement;
        On_WorldGen.KillTile -= CaptureTileBreak;
        On_WorldGen.PlaceWall -= CaptureWallPlacement;
        On_WorldGen.KillWall -= CaptureWallBreak;
        On_Player.Teleport -= CapturePlayerTeleport;
        On_Player.KillMe -= CapturePlayerDeath;
        Main.OnTickForThirdPartySoftwareOnly -= OnServerTick;
        _telemetryStream?.Dispose();
        _telemetryStream = null;
        _clientUuids.Clear();
        _teleportedSlots.Clear();
        _sessions.Clear();
        _pendingPlayerDeaths.Clear();
        _cachedPlayers.Clear();
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

    private bool CaptureTilePlacement(
        On_WorldGen.orig_PlaceTile orig, int i, int j, int type, bool mute, bool forced, int player, int style
    )
    {
        var placed = orig(i, j, type, mute, forced, player, style);
        if (placed)
            _mapScanner?.MarkTileChanged(i, j);
        return placed;
    }

    private void CaptureTileBreak(
        On_WorldGen.orig_KillTile orig, int i, int j, bool fail, bool effectOnly, bool noItem
    )
    {
        var existed = InWorld(i, j) && Main.tile[i, j].HasTile;
        orig(i, j, fail, effectOnly, noItem);
        if (existed && InWorld(i, j) && !Main.tile[i, j].HasTile)
            _mapScanner?.MarkTileChanged(i, j);
    }

    private void CaptureWallPlacement(On_WorldGen.orig_PlaceWall orig, int i, int j, int type, bool mute)
    {
        var previousWall = InWorld(i, j) ? Main.tile[i, j].WallType : (ushort)0;
        orig(i, j, type, mute);
        if (InWorld(i, j) && Main.tile[i, j].WallType != previousWall)
            _mapScanner?.MarkTileChanged(i, j);
    }

    private void CaptureWallBreak(On_WorldGen.orig_KillWall orig, int i, int j, bool fail)
    {
        var hadWall = InWorld(i, j) && Main.tile[i, j].WallType != WallID.None;
        orig(i, j, fail);
        if (hadWall && InWorld(i, j) && Main.tile[i, j].WallType == WallID.None)
            _mapScanner?.MarkTileChanged(i, j);
    }

    private static bool InWorld(int x, int y) =>
        x >= 0 && y >= 0 && x < Main.maxTilesX && y < Main.maxTilesY;

    private void OnServerTick()
    {
        if (Main.netMode != NetmodeID.Server)
            return;

        AcknowledgeDeliveredDeaths();
        RemoveExpiredPendingDeaths();
        _serverTickCount++;
        var playerPositionDue = _serverTickCount % _playerPositionIntervalTicks == 0;
        var entityUpdateDue = _serverTickCount % _entityIntervalTicks == 0;
        var mapCaptureDue = _serverTickCount % _mapCaptureIntervalTicks == 0;
        var mapTileUpdateDue = _serverTickCount % _mapTileUpdateIntervalTicks == 0;
        if (_serverTickCount % _worldScanIntervalTicks == 0)
            _mapScanner?.CaptureNextChunk();

        // Advance expensive data categories independently, then publish one compact
        // combined snapshot whenever any category has fresh values.
        var mapChangesReady = mapTileUpdateDue && _mapScanner?.HasPendingTileChanges == true;
        if (playerPositionDue || entityUpdateDue || mapCaptureDue || mapChangesReady || _nextSnapshotId == 0)
            UpdateSnapshotIfDue(playerPositionDue, entityUpdateDue, mapCaptureDue, mapTileUpdateDue, mapCaptureDue);
    }

    private void CapturePlayerDeath(On_Player.orig_KillMe orig, Player self,
        PlayerDeathReason damageSource, double damage, int hitDirection, bool pvp)
    {
        orig(self, damageSource, damage, hitDirection, pvp);
        if (Main.netMode != NetmodeID.Server || !self.dead || self.whoAmI < 0 || self.whoAmI >= Main.maxPlayers)
            return;

        var name = self.name?.Trim();
        if (string.IsNullOrWhiteSpace(name) || name is "." or ".." or "...")
            return;

        _pendingPlayerDeaths.Add(new PendingPlayerDeath(
            Guid.NewGuid().ToString("N"),
            name,
            ReadClientUuid(self.whoAmI),
            (int)Math.Floor(self.Center.X / 16.0),
            (int)Math.Floor(self.Center.Y / 16.0),
            DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
    }

    private void AcknowledgeDeliveredDeaths()
    {
        var lastAcknowledged = _telemetryStream?.LastAcknowledgedSnapshotId ?? 0;
        if (lastAcknowledged > 0)
            _pendingPlayerDeaths.RemoveAll(death => death.LastSentSnapshotId > 0
                && death.LastSentSnapshotId <= lastAcknowledged);
    }

    private void RemoveExpiredPendingDeaths()
    {
        if (_deathRetentionSeconds <= 0)
            return;

        var cutoff = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - _deathRetentionSeconds;
        _pendingPlayerDeaths.RemoveAll(death => death.Timestamp < cutoff);
    }

    public override void OnWorldLoad()
    {
        Mod.Logger.Info($"World loaded for telemetry (netMode={Main.netMode}, world='{Main.worldName}').");
        // World load can run on a worker thread. Let the game update hook reset
        // the scanner and its queue on the thread that owns them.
        UpdateSnapshotIfDue(true, true, true, true, true);
    }

    private void UpdateSnapshotIfDue(
        bool playerPositionDue,
        bool entityUpdateDue,
        bool mapCaptureDue,
        bool mapTileUpdateDue,
        bool includePlayerMapCaptures
    )
    {
        if (!_loggedUpdateHook)
        {
            _loggedUpdateHook = true;
            Mod.Logger.Info($"Telemetry update hook invoked (netMode={Main.netMode}, world='{Main.worldName}').");
        }
        if (Main.netMode != NetmodeID.Server)
            return;

        try
        {
            var initialPlayerSnapshot = _cachedPlayers.Count == 0;
            var updatePlayerPositions = playerPositionDue || initialPlayerSnapshot;
            if (updatePlayerPositions)
                ReconcilePlayers();
            if (updatePlayerPositions || mapCaptureDue)
                UpdateCachedPlayers(updatePlayerPositions, mapCaptureDue, entityUpdateDue || initialPlayerSnapshot);
            if (entityUpdateDue || _nextSnapshotId == 0)
                UpdateCachedEntities();
            PublishSnapshot(includePlayerMapCaptures, mapTileUpdateDue);
        }
        catch (Exception exception)
        {
            Mod.Logger.Error($"Could not create telemetry snapshot: {exception.GetType().Name}: {exception.Message}");
        }
    }

    private void UpdateCachedPlayers(bool updatePositions, bool updateMapCaptures, bool updateAppearance)
    {
        var activeSlots = new System.Collections.Generic.HashSet<int>();
        foreach (var pair in _sessions.OrderBy(pair => pair.Key))
        {
            var slot = pair.Key;
            var player = Main.player[slot];
            if (player is null || !player.active)
                continue;

            activeSlots.Add(slot);
            if (!_cachedPlayers.TryGetValue(slot, out var payload))
            {
                payload = new System.Collections.Generic.Dictionary<string, object?>();
                _cachedPlayers[slot] = payload;
            }

            if (updatePositions)
            {
                var session = pair.Value;
                var teleported = _teleportedSlots.TryRemove(slot, out _);
                payload["slot"] = slot;
                payload["name"] = session.Name;
                payload["uuid"] = session.Uuid;
                payload["joinedAtUnix"] = session.JoinedAtUnix;
                payload["sessionSeconds"] = Math.Max(
                    0,
                    DateTimeOffset.UtcNow.ToUnixTimeSeconds() - session.JoinedAtUnix
                );
                payload["team"] = (int)player.team;
                payload["direction"] = player.direction;
                payload["teleported"] = teleported;
                payload["position"] = new
                {
                    tileX = (int)Math.Floor(player.position.X / 16.0),
                    tileY = (int)Math.Floor(player.position.Y / 16.0),
                    x = player.position.X / 16.0,
                    y = player.position.Y / 16.0
                };
                payload["velocity"] = new { x = player.velocity.X, y = player.velocity.Y };
                if (updateAppearance || !payload.ContainsKey("appearance"))
                    payload["appearance"] = PlayerAppearanceSnapshotBuilder.Capture(player);
                if (teleported)
                    payload["mapCapture"] = null;
            }

            if (updateMapCaptures)
            {
                var wasTeleported = payload.TryGetValue("teleported", out var value)
                    && value is true;
                payload["mapCapture"] = wasTeleported
                    ? null
                    : _playerMapCapture!.Capture(player, pair.Value.Uuid ?? pair.Value.Name);
            }
        }

        foreach (var slot in _cachedPlayers.Keys.Where(slot => !activeSlots.Contains(slot)).ToArray())
            _cachedPlayers.Remove(slot);
    }

    private void UpdateCachedEntities()
    {
        var progress = BossProgressSnapshotReader.ReadCalamityBossProgress();
        _cachedCalamityAvailable = progress.Available;
        _cachedCalamityBosses = progress.Bosses;
        _cachedDefeatedBosses = BossProgressSnapshotReader.DefeatedBosses(progress.Bosses);
        _cachedBossDefeatCounts = BossVictoryTracker.SnapshotCounts();
        _cachedActiveBosses = Main.npc
            .Where(npc => npc.active && npc.boss)
            .Select(MapTileNameCatalog.GetLocalizedNpcName)
            .Distinct()
            .ToArray();
        _cachedBossDiagnostics = Main.npc
            .Where(npc => npc.active && npc.boss)
            .Select(npc => (object)new
            {
                slot = npc.whoAmI,
                type = npc.type,
                name = MapTileNameCatalog.GetLocalizedNpcName(npc),
                mod = npc.ModNPC?.Mod?.Name,
                modName = npc.ModNPC?.Name,
                life = npc.life,
                lifeMax = npc.lifeMax
            })
            .ToArray();
        _cachedNpcs = _worldEntities!.CaptureActiveNpcs();
        _cachedCoins = _worldEntities.CaptureDroppedCoins();
        var pylons = _worldEntities.CapturePylons();
        if (pylons is not null)
            _cachedPylons = pylons;
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
            if (!_sessions.TryGetValue(slot, out var session) || !string.Equals(session.Name, name, StringComparison.Ordinal))
                _sessions[slot] = new PlayerSession(name, ReadClientUuid(slot), DateTimeOffset.UtcNow.ToUnixTimeSeconds());
            else if (ReadClientUuid(slot) is { } uuid && !string.Equals(session.Uuid, uuid, StringComparison.Ordinal))
                _sessions[slot] = session with { Uuid = uuid };
        }

        foreach (var slot in _sessions.Keys.Where(slot => !activeSlots.Contains(slot)).ToArray())
        {
            _sessions.Remove(slot);
            _clientUuids.TryRemove(slot, out _);
            _teleportedSlots.TryRemove(slot, out _);
        }
    }

    private void PublishSnapshot(bool includePlayerMapCaptures, bool includeBaseMapTileUpdates)
    {
        var snapshotId = ++_nextSnapshotId;
        foreach (var death in _pendingPlayerDeaths)
            death.LastSentSnapshotId = snapshotId;
        var playerDeaths = _pendingPlayerDeaths
            .Select(death => new
            {
                id = death.Id,
                name = death.Name,
                uuid = death.Uuid,
                x = death.TileX,
                y = death.TileY,
                at = death.Timestamp
            })
            .ToArray();
        var players = _cachedPlayers
            .OrderBy(pair => pair.Key)
            .Select(pair =>
            {
                // Map windows change much less often than positions. Send them
                // only on their capture tick instead of repeating the same
                // potentially large pixel payload in every live snapshot.
                var player = new System.Collections.Generic.Dictionary<string, object?>(pair.Value);
                if (!includePlayerMapCaptures)
                    player.Remove("mapCapture");
                return (object)player;
            })
            .ToArray();

        var mode = Main.GameMode;
        var snapshot = new
        {
            schemaVersion = 1,
            snapshotId,
            generatedAtUnix = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            server = new
            {
                version = Main.versionNumber,
                serverAssemblyVersion = typeof(Main).Assembly.GetName().Version?.ToString(),
                dedicated = Main.netMode == NetmodeID.Server,
                maxPlayers = Main.maxPlayers,
                playersOnline = _cachedPlayers.Count
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
                activeBosses = _cachedActiveBosses,
                bossDiagnostics = _cachedBossDiagnostics,
                activeNpcs = _cachedNpcs,
                droppedCoins = _cachedCoins,
                defeatedBosses = _cachedDefeatedBosses,
                bossDefeatCounts = _cachedBossDefeatCounts,
                bossStatus = new
                {
                    calamityAvailable = _cachedCalamityAvailable,
                    calamityBosses = _cachedCalamityBosses
                }
            },
            pylons = _cachedPylons,
            baseMapTileUpdates = includeBaseMapTileUpdates
                ? _mapScanner?.CapturePendingTileChanges(512)
                : null,
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

    private static int ReadPositiveEnvironmentInteger(string key, int fallback)
    {
        var value = Environment.GetEnvironmentVariable(key);
        return int.TryParse(value, out var parsed) && parsed > 0 ? parsed : fallback;
    }

    private static int ReadNonNegativeEnvironmentInteger(string key, int fallback)
    {
        var value = Environment.GetEnvironmentVariable(key);
        return int.TryParse(value, out var parsed) && parsed >= 0 ? parsed : fallback;
    }

    private sealed record PlayerSession(string Name, string? Uuid, long JoinedAtUnix);
    private sealed class PendingPlayerDeath(string id, string name, string? uuid, int tileX, int tileY, long timestamp)
    {
        public string Id { get; } = id;
        public string Name { get; } = name;
        public string? Uuid { get; } = uuid;
        public int TileX { get; } = tileX;
        public int TileY { get; } = tileY;
        public long Timestamp { get; } = timestamp;
        public long LastSentSnapshotId { get; set; }
    }
}
