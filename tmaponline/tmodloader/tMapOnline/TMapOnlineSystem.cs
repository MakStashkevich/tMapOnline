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
using Terraria.GameContent.NetModules;
using Terraria.Net;

namespace tMapOnline;

public sealed class TMapOnlineSystem : ModSystem
{
    private static readonly JsonSerializerOptions JsonOptions = new();
    private readonly ConcurrentDictionary<int, string> _clientUuids = new();
    private readonly System.Collections.Generic.Dictionary<int, PlayerSession> _sessions = new();
    private readonly System.Collections.Generic.Dictionary<int, (int TileX, int TileY)>
        _pendingRespawnPositions = new();
    private readonly ConcurrentDictionary<int, byte> _teleportedSlots = new();
    private readonly ConcurrentQueue<(string CommandId, float X, float Y)> _pendingMapPings = new();
    private readonly ConcurrentQueue<(int Slot, float X, float Y, double Timestamp)> _pendingPlayerMapPings = new();
    private readonly List<MapPingEvent> _activeMapPings = new();
    private readonly System.Collections.Generic.List<PendingPlayerDeath> _pendingPlayerDeaths = new();
    private readonly System.Collections.Generic.Dictionary<int, System.Collections.Generic.Dictionary<string, object?>> _cachedPlayers = new();
    private object[] _cachedNpcs = Array.Empty<object>();
    private object[]? _cachedBossCatalog;
    private object[] _cachedCoins = Array.Empty<object>();
    private object[] _cachedPylons = Array.Empty<object>();
    private string[] _cachedActiveBosses = Array.Empty<string>();
    private object[] _cachedBossDiagnostics = Array.Empty<object>();
    private string[] _cachedDefeatedBosses = Array.Empty<string>();
    private Dictionary<string, bool?> _cachedCalamityBosses = new();
    private Dictionary<string, int> _cachedBossDefeatCounts = new();
    private bool _cachedCalamityAvailable;
    private TelemetryStreamServer? _telemetryStream;
    private MapTileNameCatalog? _mapTileNames;
    private MapTileDataCapture? _mapTileData;
    private WorldEntitySnapshotBuilder? _worldEntities;
    private PlayerMapChangeRevealer? _playerMapChangeRevealer;
    private WorldMapScanner? _mapScanner;
    private bool _loggedFirstSnapshot;
    private bool _loggedUpdateHook;
    private bool _loggedTilePacketWarning;
    private readonly int _playerPositionIntervalTicks = ReadPositiveEnvironmentInteger(
        "TERRARIA_TELEMETRY_PLAYER_POSITION_INTERVAL_TICKS", 6);
    private readonly int _entityIntervalTicks = ReadPositiveEnvironmentInteger(
        "TERRARIA_TELEMETRY_ENTITY_INTERVAL_TICKS", 6);
    private readonly int _mapCaptureIntervalTicks = ReadPositiveEnvironmentInteger(
        "TERRARIA_TELEMETRY_MAP_CAPTURE_INTERVAL_TICKS", 30);
    private readonly int _mapTileUpdateIntervalTicks = ReadPositiveEnvironmentInteger(
        "TERRARIA_TELEMETRY_MAP_TILE_UPDATE_INTERVAL_TICKS", 1);
    private readonly bool _initialWorldScanEnabled = ReadBooleanEnvironmentVariable(
        "TERRARIA_TELEMETRY_INITIAL_WORLD_SCAN_ENABLED", true);
    private readonly bool _mapPingsFromPlayersToWeb = ReadBooleanEnvironmentVariable(
        "TERRARIA_TELEMETRY_MAP_PINGS_FROM_PLAYERS_TO_WEB", true);
    private readonly bool _mapPingsFromWebToPlayers = ReadBooleanEnvironmentVariable(
        "TERRARIA_TELEMETRY_MAP_PINGS_FROM_WEB_TO_PLAYERS", true);
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
        Terraria.Net.On_NetManager.Read += CapturePlayerMapPingModule;
        On_Player.Teleport += CapturePlayerTeleport;
        On_Player.KillMe += CapturePlayerDeath;
        Main.OnTickForThirdPartySoftwareOnly += OnServerTick;
        _telemetryStream = new TelemetryStreamServer(Mod);
        _telemetryStream.MapPingRequested += QueueMapPing;
        _mapTileNames = new MapTileNameCatalog(Mod);
        _mapTileData = new MapTileDataCapture(_mapTileNames);
        _mapScanner = new WorldMapScanner(
            Mod,
            _mapTileNames,
            _mapTileData,
            _initialWorldScanEnabled
        );
        _worldEntities = new WorldEntitySnapshotBuilder(Mod);
        _playerMapChangeRevealer = new PlayerMapChangeRevealer(_mapScanner);
        _telemetryStream.Start(port);
    }

    public override void Unload()
    {
        Terraria.On_MessageBuffer.GetData -= CaptureClientPackets;
        Terraria.Net.On_NetManager.Read -= CapturePlayerMapPingModule;
        On_Player.Teleport -= CapturePlayerTeleport;
        On_Player.KillMe -= CapturePlayerDeath;
        Main.OnTickForThirdPartySoftwareOnly -= OnServerTick;
        _telemetryStream?.Dispose();
        if (_telemetryStream is not null)
            _telemetryStream.MapPingRequested -= QueueMapPing;
        _telemetryStream = null;
        _clientUuids.Clear();
        _teleportedSlots.Clear();
        while (_pendingMapPings.TryDequeue(out _)) { }
        while (_pendingPlayerMapPings.TryDequeue(out _)) { }
        _activeMapPings.Clear();
        _pendingRespawnPositions.Clear();
        _sessions.Clear();
        _pendingPlayerDeaths.Clear();
        _cachedPlayers.Clear();
        _mapScanner = null;
        _mapTileNames = null;
        _mapTileData = null;
        _worldEntities = null;
        _playerMapChangeRevealer = null;
    }

    private void CapturePlayerTeleport(On_Player.orig_Teleport orig, Player self, Vector2 newPosition, int style, int extraInfo)
    {
        orig(self, newPosition, style, extraInfo);
        if (Main.netMode == NetmodeID.Server && self.whoAmI >= 0 && self.whoAmI < Main.maxPlayers)
            _teleportedSlots[self.whoAmI] = 1;
    }

    private void RecordWorldTileChange(int x, int y)
    {
        if (WorldGen.IsGeneratingHardMode)
            _mapScanner?.MarkConvertedTileChanged(x, y);
        else
            _mapScanner?.MarkTileChanged(x, y);
    }

    private static bool InWorld(int x, int y) =>
        x >= 0 && y >= 0 && x < Main.maxTilesX && y < Main.maxTilesY;

    private void OnServerTick()
    {
        if (Main.netMode != NetmodeID.Server)
            return;

        AcknowledgeDeliveredDeaths();
        _mapScanner?.AcknowledgeTileChanges(_telemetryStream?.LastAcknowledgedSnapshotId ?? 0);
        RemoveExpiredPendingDeaths();
        _serverTickCount++;
        CapturePendingPlayerMapPings();
        BroadcastPendingMapPings();
        var playerPositionDue = _serverTickCount % _playerPositionIntervalTicks == 0;
        var entityUpdateDue = _serverTickCount % _entityIntervalTicks == 0;
        var mapCaptureDue = _serverTickCount % _mapCaptureIntervalTicks == 0;
        var mapTileUpdateDue = _serverTickCount % _mapTileUpdateIntervalTicks == 0;
        if (_initialWorldScanEnabled && _serverTickCount % _worldScanIntervalTicks == 0)
            _mapScanner?.CaptureNextChunk();
        else
            _mapScanner?.PrepareWorld();

        // Advance expensive data categories independently, then publish one compact
        // combined snapshot whenever any category has fresh values.
        var mapChangesReady = mapTileUpdateDue && _mapScanner?.HasPendingTileChanges == true;
        if (playerPositionDue || entityUpdateDue || mapCaptureDue || mapChangesReady || _nextSnapshotId == 0)
            UpdateSnapshotIfDue(playerPositionDue, entityUpdateDue, mapCaptureDue, mapTileUpdateDue);
    }

    private void QueueMapPing(string commandId, float x, float y)
    {
        if (!_mapPingsFromWebToPlayers)
            return;
        if (string.IsNullOrWhiteSpace(commandId)
            || commandId.Length > 64
            || float.IsNaN(x)
            || float.IsInfinity(x)
            || float.IsNaN(y)
            || float.IsInfinity(y))
            return;

        _pendingMapPings.Enqueue((commandId, x, y));
        Mod.Logger.Info($"Received web map ping command {commandId} at ({x:0.##}, {y:0.##}) pixels.");
    }

    private void BroadcastPendingMapPings()
    {
        // Keep all Terraria state access and packet sends on the game thread.
        for (var count = 0; count < 8 && _pendingMapPings.TryDequeue(out var ping); count++)
        {
            if (ping.X < 0 || ping.Y < 0 || ping.X >= Main.maxTilesX * 16f || ping.Y >= Main.maxTilesY * 16f)
            {
                Mod.Logger.Warn($"Rejected out-of-world map ping command {ping.CommandId}.");
                continue;
            }

            // The browser API uses pixel coordinates; Terraria's map packet uses tiles.
            var packet = NetPingModule.Serialize(new Vector2(ping.X / 16f, ping.Y / 16f));
            NetManager.Instance.Broadcast(packet);
            _activeMapPings.Add(new MapPingEvent(
                ping.CommandId,
                "Веб",
                ping.X / 16f,
                ping.Y / 16f,
                DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                "web",
                Main.worldID
            ));
            Mod.Logger.Info($"Broadcast web map ping command {ping.CommandId} to connected players.");
        }
    }

    private void CapturePendingPlayerMapPings()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        while (_pendingPlayerMapPings.TryDequeue(out var ping))
        {
            // NetPingModule carries map coordinates in tiles.
            if (ping.Slot < 0 || ping.Slot >= Main.player.Length
                || ping.X < 0 || ping.Y < 0
                || ping.X >= Main.maxTilesX || ping.Y >= Main.maxTilesY)
                continue;

            var playerName = _sessions.TryGetValue(ping.Slot, out var session)
                ? session.Name
                : $"Игрок {ping.Slot + 1}";
            _activeMapPings.Add(new MapPingEvent(
                Guid.NewGuid().ToString("N"),
                playerName,
                ping.X,
                ping.Y,
                (long)ping.Timestamp,
                "player",
                Main.worldID
            ));
        }

        _activeMapPings.RemoveAll(ping => now - ping.Timestamp >= 15);
    }

    private void CapturePlayerDeath(On_Player.orig_KillMe orig, Player self,
        PlayerDeathReason damageSource, double damage, int hitDirection, bool pvp)
    {
        orig(self, damageSource, damage, hitDirection, pvp);
        if (Main.netMode != NetmodeID.Server || !self.dead || self.whoAmI < 0 || self.whoAmI >= Main.maxPlayers)
            return;

        _pendingRespawnPositions[self.whoAmI] = (
            (int)Math.Floor(self.position.X / 16.0),
            (int)Math.Floor(self.position.Y / 16.0)
        );

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
        UpdateSnapshotIfDue(true, true, true, true);
    }

    private void UpdateSnapshotIfDue(
        bool playerPositionDue,
        bool entityUpdateDue,
        bool mapCaptureDue,
        bool mapTileUpdateDue
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
            PublishSnapshot(mapTileUpdateDue);
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
                var tileX = (int)Math.Floor(player.position.X / 16.0);
                var tileY = (int)Math.Floor(player.position.Y / 16.0);
                var respawnPending = player.dead;
                if (_pendingRespawnPositions.TryGetValue(slot, out var deathPosition))
                {
                    if (!player.dead &&
                        (tileX != deathPosition.TileX || tileY != deathPosition.TileY))
                        _pendingRespawnPositions.Remove(slot);
                    else
                        respawnPending = true;
                }

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
                payload["respawnPending"] = respawnPending;
                payload["position"] = new
                {
                    tileX,
                    tileY,
                    x = player.position.X / 16.0,
                    y = player.position.Y / 16.0
                };
                payload["velocity"] = new { x = player.velocity.X, y = player.velocity.Y };
                if (updateAppearance || !payload.ContainsKey("appearance"))
                    payload["appearance"] = PlayerAppearanceSnapshotBuilder.Capture(player);
            }

            if (updatePositions)
            {
                var wasTeleported = payload.TryGetValue("teleported", out var value)
                    && value is true;
                _playerMapChangeRevealer?.RevealPlayerView(
                    player,
                    pair.Value.Uuid ?? pair.Value.Name,
                    wasTeleported
                );
            }
        }

        foreach (var slot in _cachedPlayers.Keys.Where(slot => !activeSlots.Contains(slot)).ToArray())
            _cachedPlayers.Remove(slot);
    }

    private void UpdateCachedEntities()
    {
        _cachedNpcs = _worldEntities!.CaptureActiveNpcs();
        _cachedBossCatalog ??= _worldEntities.CaptureBossCatalog();
        _cachedCoins = _worldEntities.CaptureDroppedCoins();
        BossVictoryTracker.BossVictoryStore.EnsureWorldLoaded();
        var calamity = CalamityBossProgressAdapter.Read();
        _cachedCalamityAvailable = calamity.Available;
        _cachedCalamityBosses = calamity.Bosses;
        _cachedDefeatedBosses = BossProgressSnapshotReader.DefeatedBosses();
        _cachedBossDefeatCounts = BossVictoryTracker.SnapshotCounts();
        _cachedActiveBosses = Main.npc
            .Where(npc => npc.active && npc.boss)
            .Select(MapTileNameCatalog.GetLocalizedNpcName)
            .Distinct()
            .ToArray();
        _cachedBossDiagnostics = Main.npc
            .Where(npc => npc.active && npc.boss)
            .Select(npc => (object)new { slot = npc.whoAmI, type = npc.type, name = MapTileNameCatalog.GetLocalizedNpcName(npc) })
            .ToArray();
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
            _pendingRespawnPositions.Remove(slot);
        }
    }

    private void PublishSnapshot(bool includeBaseMapTileUpdates)
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
            .Select(pair => (object)new System.Collections.Generic.Dictionary<string, object?>(pair.Value))
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
                bossCatalog = _cachedBossCatalog,
                droppedCoins = _cachedCoins,
                defeatedBosses = _cachedDefeatedBosses,
                bossDefeatCounts = _cachedBossDefeatCounts,
                bossStatus = new { calamityAvailable = _cachedCalamityAvailable, calamityBosses = _cachedCalamityBosses },
            },
            pylons = _cachedPylons,
            baseMapTileUpdates = includeBaseMapTileUpdates || _mapScanner?.HasUnacknowledgedTileChanges == true
                ? _mapScanner?.CapturePendingTileChanges(512, snapshotId)
                : null,
            players = new
            {
                online = players.Length,
                list = players
            },
            playerDeaths,
            mapPings = _activeMapPings
                .Where(ping => ping.WorldId == Main.worldID)
                .Select(ping => new
            {
                id = ping.Id,
                playerName = ping.PlayerName,
                x = ping.X,
                y = ping.Y,
                timestamp = ping.Timestamp,
                source = ping.Source
            }).ToArray(),
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
        if (messageType == MessageID.TileManipulation)
        {
            CaptureTileManipulationPacket(messageBuffer, start, length);
            return;
        }
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

    private void CapturePlayerMapPingModule(
        Terraria.Net.On_NetManager.orig_Read orig,
        NetManager netManager,
        BinaryReader reader,
        int slot,
        int readLength
    )
    {
        if (!_mapPingsFromPlayersToWeb || Main.netMode != NetmodeID.Server
            || slot < 0 || slot >= Netplay.Clients.Length)
        {
            orig(netManager, reader, slot, readLength);
            return;
        }

        var stream = reader.BaseStream;
        var originalPosition = stream.Position;
        float x;
        float y;
        try
        {
            if (reader.ReadUInt16() != NetManager.Instance.GetId<NetPingModule>())
            {
                stream.Position = originalPosition;
                orig(netManager, reader, slot, readLength);
                return;
            }

            x = reader.ReadSingle();
            y = reader.ReadSingle();
        }
        catch (Exception exception)
        {
            stream.Position = originalPosition;
            Mod.Logger.Warn($"Could not inspect NetPingModule from player slot {slot}: {exception.GetType().Name}.");
            orig(netManager, reader, slot, readLength);
            return;
        }

        // Restore the packet reader before vanilla relays the module to the other clients.
        stream.Position = originalPosition;
        orig(netManager, reader, slot, readLength);

        if (!float.IsFinite(x) || !float.IsFinite(y))
            return;

        _pendingPlayerMapPings.Enqueue((slot, x, y, DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
        Mod.Logger.Info($"Captured player map ping from slot {slot} at ({x:0.##}, {y:0.##}) tiles.");
    }

    private void CaptureTileManipulationPacket(MessageBuffer messageBuffer, int start, int length)
    {
        if (start < 0 || length < 8 || start + length > messageBuffer.readBuffer.Length)
            return;

        try
        {
            using var stream = new MemoryStream(messageBuffer.readBuffer, start + 1, length - 1, writable: false);
            using var reader = new BinaryReader(stream, Encoding.UTF8, leaveOpen: false);
            _ = reader.ReadByte(); // Tile manipulation action.
            var tileX = reader.ReadInt16();
            var tileY = reader.ReadInt16();
            RecordWorldTileChange(tileX, tileY);
        }
        catch (Exception exception)
        {
            if (!_loggedTilePacketWarning)
            {
                _loggedTilePacketWarning = true;
                Mod.Logger.Warn(
                    $"Could not decode tile-manipulation packet for map refresh: {exception.GetType().Name}."
                );
            }
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

    private static bool ReadBooleanEnvironmentVariable(string key, bool fallback)
    {
        var value = Environment.GetEnvironmentVariable(key);
        return bool.TryParse(value, out var parsed) ? parsed : fallback;
    }

    private sealed record PlayerSession(string Name, string? Uuid, long JoinedAtUnix);

    private sealed record MapPingEvent(
        string Id,
        string PlayerName,
        float X,
        float Y,
        long Timestamp,
        string Source,
        int WorldId
    );
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
