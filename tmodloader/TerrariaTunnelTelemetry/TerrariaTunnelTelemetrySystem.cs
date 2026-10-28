using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
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
    private static readonly (string Id, string Name, string Field, string SaveKey)[] CalamityBossFlags =
    {
        ("desert-scourge", "Desert Scourge", "downedDesertScourge", "desertScourge"),
        ("crabulon", "Crabulon", "downedCrabulon", "crabulon"),
        ("hive-mind", "The Hive Mind", "downedHiveMind", "hiveMind"),
        ("perforators", "The Perforators", "downedPerforator", "perforator"),
        ("slime-god", "The Slime God", "downedSlimeGod", "slimeGod"),
        ("cryogen", "Cryogen", "downedCryogen", "cryogen"),
        ("aquatic-scourge", "Aquatic Scourge", "downedAquaticScourge", "aquaticScourge"),
        ("brimstone-elemental", "Brimstone Elemental", "downedBrimstoneElemental", "brimstoneElemental"),
        ("calamitas-clone", "Calamitas Clone", "downedCalamitasClone", "calamitas"),
        ("leviathan-anahita", "Leviathan and Anahita", "downedLeviathan", "leviathan"),
        ("astrum-aureus", "Astrum Aureus", "downedAstrumAureus", "astrageldon"),
        ("plaguebringer-goliath", "The Plaguebringer Goliath", "downedPlaguebringer", "plaguebringerGoliath"),
        ("ravager", "The Ravager", "downedRavager", "scavenger"),
        ("astrum-deus", "Astrum Deus", "downedAstrumDeus", "starGod"),
        ("profaned-guardians", "Profaned Guardians", "downedGuardians", "guardians"),
        ("dragonfolly", "Dragonfolly", "downedDragonfolly", "bumblebirb"),
        ("providence", "Providence, the Profaned Goddess", "downedProvidence", "providence"),
        ("storm-weaver", "Storm Weaver", "downedStormWeaver", "stormWeaver"),
        ("ceaseless-void", "Ceaseless Void", "downedCeaselessVoid", "ceaselessVoid"),
        ("signus", "Signus, Envoy of the Devourer", "downedSignus", "signus"),
        ("polterghast", "Polterghast", "downedPolterghast", "polterghast"),
        ("old-duke", "The Old Duke", "downedBoomerDuke", "oldDuke"),
        ("devourer-of-gods", "The Devourer of Gods", "downedDoG", "devourerOfGods"),
        ("yharon", "Yharon, Dragon of Rebirth", "downedYharon", "yharon"),
        ("exo-mechs", "Exo Mechs", "downedExoMechs", "exoMechs"),
        ("supreme-calamitas", "Supreme Witch, Calamitas", "downedCalamitas", "supremeCalamitas"),
        ("primordial-wyrm", "Primordial Wyrm", "downedPrimordialWyrm", "adultEidolonWyrm"),
        ("giant-clam", "Giant Clam", "downedCLAM", "clam"),
        ("cragmaw-mire", "Cragmaw Mire", "downedCragmawMire", "cragmawMire"),
        ("great-sand-shark", "Great Sand Shark", "downedGSS", "greatSandShark"),
        ("mauler", "Mauler", "downedMauler", "mauler"),
        ("nuclear-terror", "Nuclear Terror", "downedNuclearTerror", "nuclearTerror")
    };
    private static string? _cachedWorldSavePath;
    private static DateTime _cachedWorldSaveWriteTimeUtc;
    private static System.Collections.Generic.HashSet<string> _savedCalamityDownedFlags = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<int, TelemetryClient> _clients = new();
    private readonly ConcurrentDictionary<int, string> _clientUuids = new();
    private static readonly ConcurrentDictionary<string, string> ExportedEquipTextures = new(StringComparer.Ordinal);
    private static Dictionary<string, string> _localizedMapNames = new(StringComparer.Ordinal);
    private static Dictionary<string, string> _activeCultureTranslations = new(StringComparer.Ordinal);
    private static string? _localizedMapNamesCulture;
    private static int _localizedMapNamesSendIndex;
    private static int _localizedMapNamesSendRounds;
    private const int LocalizedMapNamesBatchSize = 64;
    private const int LocalizedMapNamesSendRounds = 4;
    private readonly System.Collections.Generic.Dictionary<int, PlayerSession> _sessions = new();
    private readonly ConcurrentDictionary<int, byte> _teleportedSlots = new();
    private readonly System.Collections.Generic.Dictionary<string, System.Collections.Generic.Dictionary<long, DateTime>> _capturedMapRegions = new(StringComparer.Ordinal);
    private readonly Queue<object> _pendingBaseMapCaptures = new();
    private TcpListener? _listener;
    private CancellationTokenSource? _shutdown;
    private string? _latestSnapshot;
    private bool _loggedFirstSnapshot;
    private bool _loggedUpdateHook;
    private bool _loggedMapCaptureWarning;
    private bool _loggedServerMapWorkaround;
    private bool _initializedServerMapPalette;
    private WorldMap? _serverMapLookup;
    private DateTime _lastSnapshotUtc = DateTime.MinValue;
    private int _nextClientId;
    private int _nextBaseMapChunk;
    private int _baseMapChunkWorldId = -1;
    private int _baseMapScannedChunks;
    private int _baseMapFailedChunks;
    private int _baseMapFailedTiles;
    private bool _loggedBaseMapScanStart;
    private bool _loggedBaseMapWarning;

    public override void Load()
    {
        var portText = Environment.GetEnvironmentVariable("TERRARIA_TELEMETRY_PORT");
        var port = int.TryParse(portText, out var configuredPort) && configuredPort is >= 1 and <= 65535
            ? configuredPort
            : 38762;

        _shutdown = new CancellationTokenSource();
        Terraria.On_MessageBuffer.GetData += CaptureClientPackets;
        On_Player.Teleport += CapturePlayerTeleport;
        Main.OnTickForThirdPartySoftwareOnly += OnServerTick;
        _listener = new TcpListener(IPAddress.Loopback, port);
        try
        {
            _listener.Start();
            _ = AcceptClientsAsync(_listener, _shutdown.Token);
            Mod.Logger.Info($"Telemetry JSONL stream listening on 127.0.0.1:{port}.");
        }
        catch (Exception exception)
        {
            Mod.Logger.Error($"Could not start telemetry listener; telemetry is disabled: {exception.Message}");
            _shutdown.Cancel();
            _listener.Stop();
            _listener = null;
            _shutdown.Dispose();
            _shutdown = null;
        }
    }

    public override void Unload()
    {
        Terraria.On_MessageBuffer.GetData -= CaptureClientPackets;
        On_Player.Teleport -= CapturePlayerTeleport;
        Main.OnTickForThirdPartySoftwareOnly -= OnServerTick;
        _shutdown?.Cancel();
        _listener?.Stop();
        foreach (var client in _clients.Values)
            client.Stop();
        _clients.Clear();
        _clientUuids.Clear();
        _teleportedSlots.Clear();
        _sessions.Clear();
        _capturedMapRegions.Clear();
        _serverMapLookup = null;
        _latestSnapshot = null;
        _listener = null;
        _shutdown?.Dispose();
        _shutdown = null;
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
        CaptureNextBaseMapChunk();
        UpdateSnapshotIfDue();
    }

    public override void OnWorldLoad()
    {
        Mod.Logger.Info($"World loaded for telemetry (netMode={Main.netMode}, world='{Main.worldName}').");
        // World load can run on a worker thread. Let the game update hook reset
        // the scanner and its queue on the thread that owns them.
        _baseMapChunkWorldId = -1;
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

    private void PublishSnapshot(DateTime now)
    {
        var calamityProgress = ReadCalamityBossProgress();
        var bossDefeatCounts = BossVictoryTracker.SnapshotCounts();
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
                    teleported,
                    position = new
                    {
                        tileX = (int)Math.Floor(entry.player.position.X / 16.0),
                        tileY = (int)Math.Floor(entry.player.position.Y / 16.0)
                    },
                    mapCapture = teleported ? null : CaptureMapView(entry.player, entry.uuid ?? entry.name),
                    appearance = ReadPlayerAppearance(entry.player)
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
                    .Select(npc => GetLocalizedNpcName(npc))
                    .Distinct()
                    .ToArray(),
                bossDiagnostics = Main.npc
                    .Where(npc => npc.active && npc.boss)
                    .Select(npc => new
                    {
                        slot = npc.whoAmI,
                        type = npc.type,
                        name = GetLocalizedNpcName(npc),
                        mod = npc.ModNPC?.Mod?.Name,
                        modName = npc.ModNPC?.Name,
                        life = npc.life,
                        lifeMax = npc.lifeMax
                    })
                    .ToArray(),
                activeNpcs = CaptureActiveNpcs(),
                droppedCoins = CaptureDroppedCoins(),
                defeatedBosses = DefeatedBosses(calamityProgress.Bosses),
                bossDefeatCounts,
                bossStatus = new
                {
                    calamityAvailable = calamityProgress.Available,
                    calamityBosses = calamityProgress.Bosses
                }
            },
            pylons = CapturePylons(),
            players = new
            {
                online = players.Length,
                list = players
            },
            mapScan = GetBaseMapScanStatus(),
            baseMapCaptures = DrainBaseMapCaptures()
        };

        // Keep each complete JSON document on one line for robust JSONL framing.
        var jsonLine = JsonSerializer.Serialize(snapshot, JsonOptions) + "\n";
        Volatile.Write(ref _latestSnapshot, jsonLine);
        if (!_loggedFirstSnapshot)
        {
            _loggedFirstSnapshot = true;
            Mod.Logger.Info("First live telemetry snapshot generated.");
        }
        foreach (var client in _clients.Values)
            client.Publish(jsonLine);
    }

    private object[]? CapturePylons()
    {
        try
        {
            // The PylonSystem list can be empty on the dedicated server even
            // when pylons are loaded in the world. Read the authoritative tile
            // entities instead; their positions and biome type are persisted
            // with the world and are the same data used by the in-game map.
            return TileEntity.ByID.Values
                .OfType<TETeleportationPylon>()
                .Where(pylon => pylon.TryGetPylonType(out _))
                .Select(pylon =>
                {
                    pylon.TryGetPylonType(out var type);
                    return new
                    {
                        x = pylon.Position.X,
                        y = pylon.Position.Y,
                        type = type.ToString()
                    };
                })
                .ToArray();
        }
        catch (Exception exception)
        {
            // An empty list means "the world has no pylons" to the dashboard.
            // Do not erase the last known pylon positions when the tModLoader
            // API is temporarily unavailable or a modded pylon throws.
            Mod.Logger.Warn($"Could not capture pylon positions; keeping the last known map data. {exception}");
            return null;
        }
    }

    private object[] DrainBaseMapCaptures()
    {
        var captures = new List<object>(64);
        while (captures.Count < 64 && _pendingBaseMapCaptures.Count > 0)
            captures.Add(_pendingBaseMapCaptures.Dequeue());
        return captures.ToArray();
    }

    private object[] CaptureActiveNpcs()
    {
        return Main.npc
            .Where(npc => npc.active && npc.type != NPCID.None && (npc.boss || npc.townNPC))
            .Select(npc =>
            {
                var modNpc = npc.ModNPC;
                var asset = modNpc?.Mod == null ? null : ExportNpcTexture(modNpc.Mod, modNpc.Texture);
                var headSlot = TownNPCProfiles.GetHeadIndexSafe(npc);
                var bossHeadSlot = npc.boss ? npc.GetBossHeadTextureIndex() : -1;
                var headAsset = modNpc?.Mod == null
                    ? null
                    : ExportNpcTexture(modNpc.Mod, npc.boss ? modNpc.BossHeadTexture : modNpc.HeadTexture);
                return new
                {
                    id = npc.whoAmI,
                    type = npc.type,
                    name = GetLocalizedNpcName(npc),
                    boss = npc.boss,
                    x = (int)Math.Floor(npc.Center.X / 16.0),
                    y = (int)Math.Floor(npc.Center.Y / 16.0),
                    frameWidth = Math.Max(1, npc.frame.Width > 1 ? npc.frame.Width : npc.width),
                    frameHeight = Math.Max(1, npc.frame.Height > 1 ? npc.frame.Height : npc.height),
                    modTexture = asset,
                    headSlot,
                    bossHeadSlot,
                    headTexture = headAsset
                };
            })
            .ToArray();
    }

    private object[] CaptureDroppedCoins()
    {
        return Main.item
            .Where(item => item.active && item.stack > 0 && IsCoinItem(item.type))
            .Select(item => new
            {
                id = item.whoAmI,
                type = item.type,
                name = Lang.GetItemNameValue(item.type),
                x = (int)Math.Floor(item.Center.X / 16.0),
                y = (int)Math.Floor(item.Center.Y / 16.0),
                stack = item.stack
            })
            .ToArray();
    }

    private static bool IsCoinItem(int type) => type is ItemID.CopperCoin or ItemID.SilverCoin or ItemID.GoldCoin or ItemID.PlatinumCoin;

    private static readonly ConcurrentDictionary<string, string> ExportedNpcTextures = new(StringComparer.Ordinal);

    private static string? ExportNpcTexture(Mod mod, string texturePath)
    {
        if (string.IsNullOrWhiteSpace(texturePath))
            return null;
        var normalizedPath = texturePath.StartsWith(mod.Name + "/", StringComparison.Ordinal)
            ? texturePath[(mod.Name.Length + 1)..]
            : texturePath;
        var key = $"{mod.Name}/{normalizedPath}";
        return ExportedNpcTextures.GetOrAdd(key, _ =>
        {
            try
            {
                var bytes = ReadModTexturePng(mod, normalizedPath);
                if (bytes.Length == 0)
                    return string.Empty;
                var digest = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
                var directory = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "TerrariaTunnel", "npc-textures");
                Directory.CreateDirectory(directory);
                var destination = Path.Combine(directory, digest + ".png");
                if (!File.Exists(destination))
                    File.WriteAllBytes(destination, bytes);
                return digest;
            }
            catch
            {
                return string.Empty;
            }
        });
    }

    private object GetBaseMapScanStatus()
    {
        const int chunkSize = 32;
        var columns = Main.maxTilesX > 0 ? (Main.maxTilesX + chunkSize - 1) / chunkSize : 0;
        var rows = Main.maxTilesY > 0 ? (Main.maxTilesY + chunkSize - 1) / chunkSize : 0;
        var total = columns * rows;
        var attempted = Math.Min(_nextBaseMapChunk, total);
        return new
        {
            enabled = true,
            active = Main.netMode == NetmodeID.Server && total > 0 && attempted < total,
            complete = total > 0 && attempted >= total,
            scannedChunks = _baseMapScannedChunks,
            attemptedChunks = attempted,
            failedChunks = _baseMapFailedChunks,
            failedTiles = _baseMapFailedTiles,
            totalChunks = total,
            remainingChunks = Math.Max(0, total - attempted),
            percent = total == 0 ? 0 : Math.Round(attempted * 100d / total, 1),
            worldId = Main.worldID,
            worldName = Main.worldName,
            width = Main.maxTilesX,
            height = Main.maxTilesY
        };
    }

    // Scan one 32x32 tile chunk per world tick. Terraria's own map palette is
    // used; the monitor persists each chunk and overlays it through exploration fog.
    private void CaptureNextBaseMapChunk()
    {
        if (Main.netMode != NetmodeID.Server || Main.maxTilesX <= 0 || Main.maxTilesY <= 0)
            return;
        if (_baseMapChunkWorldId != Main.worldID)
        {
            _baseMapChunkWorldId = Main.worldID;
            _nextBaseMapChunk = 0;
            _baseMapScannedChunks = 0;
            _baseMapFailedChunks = 0;
            _baseMapFailedTiles = 0;
            _pendingBaseMapCaptures.Clear();
            _loggedBaseMapScanStart = false;
            _loggedBaseMapWarning = false;
        }
        const int chunkSize = 32;
        var columns = (Main.maxTilesX + chunkSize - 1) / chunkSize;
        var rows = (Main.maxTilesY + chunkSize - 1) / chunkSize;
        if (!_loggedBaseMapScanStart)
        {
            _loggedBaseMapScanStart = true;
            Mod.Logger.Info($"World map scan started on the server tick loop: {Main.maxTilesX}x{Main.maxTilesY} tiles, {columns * rows} chunks.");
        }
        if (_nextBaseMapChunk >= columns * rows)
            return;

        var index = _nextBaseMapChunk++;
        var chunkX = index % columns;
        var chunkY = index / columns;
        var x = chunkX * chunkSize;
        var y = chunkY * chunkSize;
        var width = Math.Min(chunkSize, Main.maxTilesX - x);
        var height = Math.Min(chunkSize, Main.maxTilesY - y);
        var originalMap = Main.Map;
        try
        {
            if (!_initializedServerMapPalette)
            {
                MapHelper.Initialize();
                InitializeModdedServerMapPalette();
                _initializedServerMapPalette = true;
            }
            if (originalMap is null)
            {
                if (_serverMapLookup is null
                    || _serverMapLookup.MaxWidth != Main.maxTilesX
                    || _serverMapLookup.MaxHeight != Main.maxTilesY)
                    _serverMapLookup = new WorldMap(Main.maxTilesX, Main.maxTilesY);
                Main.Map = _serverMapLookup;
            }
            var pixels = new byte[width * height * 4];
            var tileInfo = CaptureTileInfo(x, y, width, height);
            for (var row = 0; row < height; row++)
            for (var column = 0; column < width; column++)
            {
                var tileX = x + column;
                var tileY = y + row;
                Microsoft.Xna.Framework.Color color;
                try
                {
                    var mapTile = MapHelper.CreateMapTile(tileX, tileY, byte.MaxValue);
                    color = MapHelper.GetMapTileXnaColor(ref mapTile);
                }
                catch (IndexOutOfRangeException exception)
                {
                    _baseMapFailedTiles++;
                    if (!_loggedBaseMapWarning)
                    {
                        _loggedBaseMapWarning = true;
                        var tile = Main.tile[tileX, tileY];
                        Mod.Logger.Warn($"Could not render Terraria map tile ({tileX},{tileY}), type={tile.TileType}, wall={tile.WallType}; using black fallback: {exception}");
                    }
                    color = Microsoft.Xna.Framework.Color.Black;
                }
                var offset = (row * width + column) * 4;
                pixels[offset] = color.R; pixels[offset + 1] = color.G;
                pixels[offset + 2] = color.B; pixels[offset + 3] = 255;
            }
            using var compressed = new MemoryStream();
            using (var zlib = new ZLibStream(compressed, CompressionLevel.Fastest, leaveOpen: true))
                zlib.Write(pixels, 0, pixels.Length);
            _pendingBaseMapCaptures.Enqueue(new
            {
                x, y, width, height, encoding = "rgba-zlib-base64",
                data = Convert.ToBase64String(compressed.ToArray()),
                tileInfo = tileInfo.Data,
                tileNames = tileInfo.Names,
                tileNamesLanguage = Language.ActiveCulture.Name,
                tileNamesVersion = 6
            });
            _baseMapScannedChunks++;
        }
        catch (Exception exception)
        {
            _baseMapFailedChunks++;
            if (!_loggedBaseMapWarning)
            {
                _loggedBaseMapWarning = true;
                Mod.Logger.Warn($"Could not render Terraria base map chunk ({chunkX},{chunkY}) at tile ({x},{y}); telemetry continues without it: {exception}.");
            }
        }
        finally
        {
            // CreateMapTile reads Main.Map, including nearby map pixels when it
            // selects underground snow shading. Preserve any map installed by
            // another system and restore it even if rendering fails.
            if (!ReferenceEquals(Main.Map, originalMap))
                Main.Map = originalMap;
        }
    }

    private static (string Data, Dictionary<string, string> Names) CaptureTileInfo(int x, int y, int width, int height)
    {
        // Two little-endian ushort values per tile: tile type + 1 (zero means
        // empty), and wall type + 1 (zero means no wall).
        var raw = new byte[checked(width * height * 4)];
        var tileTypes = new HashSet<ushort>();
        var wallTypes = new HashSet<ushort>();
        for (var row = 0; row < height; row++)
        for (var column = 0; column < width; column++)
        {
            var tile = Main.tile[x + column, y + row];
            var tileType = tile.HasTile ? checked((ushort)(tile.TileType + 1)) : (ushort)0;
            var wallType = tile.WallType == WallID.None ? (ushort)0 : checked((ushort)(tile.WallType + 1));
            if (tileType > 0) tileTypes.Add((ushort)(tileType - 1));
            if (wallType > 0) wallTypes.Add((ushort)(wallType - 1));
            var offset = (row * width + column) * 4;
            raw[offset] = (byte)tileType;
            raw[offset + 1] = (byte)(tileType >> 8);
            raw[offset + 2] = (byte)wallType;
            raw[offset + 3] = (byte)(wallType >> 8);
        }
        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(compressed, CompressionLevel.Fastest, leaveOpen: true))
            zlib.Write(raw, 0, raw.Length);
        var names = new Dictionary<string, string>();
        if (_localizedMapNamesSendRounds < LocalizedMapNamesSendRounds && _localizedMapNames.Count > 0)
        {
            foreach (var pair in _localizedMapNames.Skip(_localizedMapNamesSendIndex).Take(LocalizedMapNamesBatchSize))
                names[pair.Key] = pair.Value;
            _localizedMapNamesSendIndex += LocalizedMapNamesBatchSize;
            if (_localizedMapNamesSendIndex >= _localizedMapNames.Count)
            {
                _localizedMapNamesSendRounds++;
                _localizedMapNamesSendIndex = 0;
            }
        }
        foreach (var type in tileTypes)
        {
            var key = $"t{type}";
            if (!names.ContainsKey(key) && TryGetLocalizedMapName("Tile", type, out var name))
                names[key] = name;
        }
        foreach (var type in wallTypes)
        {
            var key = $"w{type}";
            if (!names.ContainsKey(key) && TryGetLocalizedMapName("Wall", type, out var name))
                names[key] = name;
        }
        return (Convert.ToBase64String(compressed.ToArray()), names);
    }

    private static string GetLocalizedNpcName(NPC npc)
    {
        // FullName includes Terraria/tModLoader localization and any assigned
        // town-NPC name. Lang is a fallback for NPCs without a live name.
        var name = npc.FullName;
        if (!string.IsNullOrWhiteSpace(name))
            return name;
        try
        {
            return Lang.GetNPCNameValue(npc.type);
        }
        catch
        {
            return npc.TypeName;
        }
    }

    private static bool TryGetLocalizedMapName(string kind, int id, out string name)
    {
        // Lang.GetMapObjectName reads Main.Map, which is null on a dedicated
        // server. Read Terraria's localized MapLegend entry directly instead;
        // this is the same source used by the in-game map for vanilla and modded content.
        // A few registered content IDs have no map legend entry. Use the
        // content's map localization or placeable item's localized name for
        // those, then use Terraria's registered internal ID name as a final
        // label instead of searching legacy MapObject/ItemName keys.
        var exactCultureName = GetExactCultureValue(GetMapEntryLocalizedText(kind, id))
            ?? GetExactCultureValue(GetMapTypeLocalizedText(kind == "Tile" ? "Terraria.ModLoader.TileLoader" : "Terraria.ModLoader.WallLoader",
                kind == "Tile" ? "GetTile" : "GetWall", id))
            ?? GetExactCultureValue(GetPlaceableItemLocalizedText(kind, id));
        var localized = exactCultureName
            ?? GetMapEntryName(kind, id)
            ?? GetMapTypeName(kind == "Tile" ? "Terraria.ModLoader.TileLoader" : "Terraria.ModLoader.WallLoader",
                kind == "Tile" ? "GetTile" : "GetWall", id)
            ?? GetPlaceableItemName(kind, id)
            ?? GetInternalMapName(kind, id)
            ?? GetMapTypeInternalName(kind, id);
        name = localized ?? string.Empty;
        return !string.IsNullOrWhiteSpace(name);
    }

    private static object? GetMapEntryLocalizedText(string kind, int id)
    {
        try
        {
            var legend = Lang._mapLegendCache;
            if (legend is null || id < 0)
                return null;
            int mapLookup;
            if (kind == "Tile")
            {
                if (MapHelper.tileLookup is null || id >= MapHelper.tileLookup.Length
                    || MapHelper.tileOptionCounts is null || id >= MapHelper.tileOptionCounts.Length
                    || MapHelper.tileOptionCounts[id] <= 0)
                    return null;
                mapLookup = MapHelper.TileToLookup(id, 0);
            }
            else
            {
                if (MapHelper.wallLookup is null || id >= MapHelper.wallLookup.Length
                    || MapHelper.wallOptionCounts is null || id >= MapHelper.wallOptionCounts.Length
                    || MapHelper.wallOptionCounts[id] <= 0)
                    return null;
                mapLookup = MapHelper.wallLookup[id];
            }
            return legend[mapLookup];
        }
        catch { return null; }
    }

    private static object? GetMapTypeLocalizedText(string typeName, string methodName, int id)
    {
        try
        {
            var loader = typeof(Mod).Assembly.GetType(typeName);
            var method = loader?.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                .FirstOrDefault(candidate => candidate.Name == methodName
                    && candidate.GetParameters() is { Length: 1 } parameters
                    && parameters[0].ParameterType == typeof(int));
            var modType = method?.Invoke(null, new object[] { id });
            var createName = modType?.GetType().GetMethod("CreateMapEntryName",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
                binder: null, Type.EmptyTypes, modifiers: null);
            return createName?.Invoke(modType, null);
        }
        catch { return null; }
    }

    private static object? GetPlaceableItemLocalizedText(string kind, int id)
    {
        try
        {
            int itemType;
            if (kind == "Tile")
            {
                var loader = typeof(Mod).Assembly.GetType("Terraria.ModLoader.TileLoader");
                var method = loader?.GetMethod("GetItemDropFromTypeAndStyle", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic,
                    binder: null, new[] { typeof(int), typeof(int) }, modifiers: null);
                itemType = Convert.ToInt32(method?.Invoke(null, new object[] { id, 0 }), System.Globalization.CultureInfo.InvariantCulture);
            }
            else
            {
                var loader = typeof(Mod).Assembly.GetType("Terraria.ModLoader.WallLoader");
                var mapping = loader?.GetField("wallTypeToItemType", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                    ?.GetValue(null) as System.Collections.IDictionary;
                itemType = mapping is not null && mapping.Contains(id)
                    ? Convert.ToInt32(mapping[id], System.Globalization.CultureInfo.InvariantCulture)
                    : 0;
            }
            var values = typeof(Lang).GetField("_itemNameCache", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                ?.GetValue(null) as Array;
            return itemType > 0 && values is not null && itemType < values.Length ? values.GetValue(itemType) : null;
        }
        catch { return null; }
    }

    private static string? GetExactCultureValue(object? localizedText)
    {
        try
        {
            var key = localizedText?.GetType().GetField("Key", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                ?.GetValue(localizedText)?.ToString();
            return key is not null && _activeCultureTranslations.TryGetValue(key, out var value)
                ? CleanMapName(value)
                : null;
        }
        catch { return null; }
    }

    private static string? GetMapEntryName(string kind, int id)
    {
        try
        {
            var legend = Lang._mapLegendCache;
            if (legend is null || id < 0)
                return null;

            int mapLookup;
            if (kind == "Tile")
            {
                if (MapHelper.tileLookup is null || id >= MapHelper.tileLookup.Length
                    || MapHelper.tileOptionCounts is null || id >= MapHelper.tileOptionCounts.Length
                    || MapHelper.tileOptionCounts[id] <= 0)
                    return null;
                mapLookup = MapHelper.TileToLookup(id, 0);
            }
            else
            {
                if (MapHelper.wallLookup is null || id >= MapHelper.wallLookup.Length
                    || MapHelper.wallOptionCounts is null || id >= MapHelper.wallOptionCounts.Length
                    || MapHelper.wallOptionCounts[id] <= 0)
                    return null;
                mapLookup = MapHelper.wallLookup[id];
            }

            return CleanMapName(legend[mapLookup]?.Value);
        }
        catch { return null; }
    }

    private static string? GetPlaceableItemName(string kind, int id)
    {
        try
        {
            int itemType;
            if (kind == "Tile")
            {
                var loader = typeof(Mod).Assembly.GetType("Terraria.ModLoader.TileLoader");
                var method = loader?.GetMethod("GetItemDropFromTypeAndStyle", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic,
                    binder: null, new[] { typeof(int), typeof(int) }, modifiers: null);
                itemType = Convert.ToInt32(method?.Invoke(null, new object[] { id, 0 }), System.Globalization.CultureInfo.InvariantCulture);
            }
            else
            {
                var loader = typeof(Mod).Assembly.GetType("Terraria.ModLoader.WallLoader");
                var mapping = loader?.GetField("wallTypeToItemType", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                    ?.GetValue(null) as System.Collections.IDictionary;
                itemType = mapping is not null && mapping.Contains(id)
                    ? Convert.ToInt32(mapping[id], System.Globalization.CultureInfo.InvariantCulture)
                    : 0;
            }

            return itemType > 0 ? CleanMapName(Lang.GetItemNameValue(itemType)) : null;
        }
        catch { return null; }
    }

    private static string? GetInternalMapName(string kind, int id)
    {
        try
        {
            var internalName = kind == "Tile" ? TileID.Search.GetName(id) : WallID.Search.GetName(id);
            return CleanMapName(System.Text.RegularExpressions.Regex.Replace(internalName, "(?<=[a-z0-9])(?=[A-Z])", " "));
        }
        catch { return null; }
    }

    private static string? GetMapTypeInternalName(string kind, int id)
    {
        try
        {
            var loader = typeof(Mod).Assembly.GetType(kind == "Tile" ? "Terraria.ModLoader.TileLoader" : "Terraria.ModLoader.WallLoader");
            var method = loader?.GetMethod(kind == "Tile" ? "GetTile" : "GetWall",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic,
                binder: null, new[] { typeof(int) }, modifiers: null);
            var value = method?.Invoke(null, new object[] { id });
            var fullName = value?.GetType().GetProperty("FullName", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                ?.GetValue(value)?.ToString();
            return CleanMapName(fullName?.Replace('/', ' '));
        }
        catch { return null; }
    }

    private void BuildLocalizedMapNameCatalog()
    {
        var culture = Language.ActiveCulture.Name;
        if (string.Equals(_localizedMapNamesCulture, culture, StringComparison.Ordinal)
            && _localizedMapNames.Count > 0)
            return;

        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        _activeCultureTranslations = LoadActiveCultureTranslations();
        // tileOptionCounts and wallLookup are indexed by map-atlas lookup IDs,
        // not by Terraria's tile/wall type IDs stored in tileInfo. Building a
        // t{id}/w{id} catalog from those arrays shifts names onto unrelated
        // blocks. Enumerate the actual registered content IDs instead.
        var tileCount = GetRegisteredContentCount("Terraria.ModLoader.TileLoader", "TileCount");
        var wallCount = GetRegisteredContentCount("Terraria.ModLoader.WallLoader", "WallCount");
        var mapLegendNames = 0;
        var contentNames = 0;
        var itemNames = 0;
        var internalNames = 0;
        var unnamed = 0;
        for (var id = 0; id < tileCount; id++)
        {
            AddLocalizedMapName("Tile", id, $"t{id}", names, ref mapLegendNames, ref contentNames,
                ref itemNames, ref internalNames, ref unnamed);
        }
        for (var id = 0; id < wallCount; id++)
        {
            AddLocalizedMapName("Wall", id, $"w{id}", names, ref mapLegendNames, ref contentNames,
                ref itemNames, ref internalNames, ref unnamed);
        }
        _localizedMapNames = names;
        _localizedMapNamesCulture = culture;
        _localizedMapNamesSendIndex = 0;
        _localizedMapNamesSendRounds = 0;
        Mod.Logger.Info($"Map-name coverage: {names.Count}/{tileCount + wallCount} tile/wall IDs; exact {culture} localization keys={_activeCultureTranslations.Count}, MapLegend={mapLegendNames}, content localization={contentNames}, placeable item localization={itemNames}, internal names={internalNames}, unnamed={unnamed}; culture={culture}.");
    }

    private Dictionary<string, string> LoadActiveCultureTranslations()
    {
        var translations = new Dictionary<string, string>(StringComparer.Ordinal);
        try
        {
            var loaderType = typeof(Mod).Assembly.GetType("Terraria.ModLoader.LocalizationLoader");
            var load = loaderType?.GetMethod("LoadTranslations", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic,
                binder: null, new[] { typeof(Mod), typeof(GameCulture) }, modifiers: null);
            if (load is null)
                return translations;

            // Read each loaded mod's files for the selected culture without
            // changing the live localization table. Language packs can then
            // override an English MapLegend fallback for the same key.
            foreach (var mod in ModLoader.Mods)
            {
                if (mod is null)
                    continue;
                try
                {
                    if (load.Invoke(null, new object[] { mod, Language.ActiveCulture }) is not System.Collections.IEnumerable entries)
                        continue;
                    foreach (var entry in entries)
                    {
                        if (entry is null)
                            continue;
                        var type = entry.GetType();
                        var key = type.GetField("Item1")?.GetValue(entry)?.ToString();
                        var value = type.GetField("Item2")?.GetValue(entry)?.ToString();
                        if (!string.IsNullOrWhiteSpace(key) && !string.IsNullOrWhiteSpace(value))
                            translations[key] = value;
                    }
                }
                catch (Exception exception)
                {
                    Mod.Logger.Warn($"Could not read {Language.ActiveCulture.Name} map-name translations from mod {mod.Name}: {exception.Message}");
                }
            }
        }
        catch (Exception exception)
        {
            Mod.Logger.Warn($"Could not enumerate {Language.ActiveCulture.Name} map-name translations: {exception.Message}");
        }
        return translations;
    }

    private static void AddLocalizedMapName(string kind, int id, string key, Dictionary<string, string> names,
        ref int mapLegendNames, ref int contentNames, ref int itemNames, ref int internalNames, ref int unnamed)
    {
        var name = GetExactCultureValue(GetMapEntryLocalizedText(kind, id))
            ?? GetExactCultureValue(GetMapTypeLocalizedText(kind == "Tile" ? "Terraria.ModLoader.TileLoader" : "Terraria.ModLoader.WallLoader",
                kind == "Tile" ? "GetTile" : "GetWall", id))
            ?? GetExactCultureValue(GetPlaceableItemLocalizedText(kind, id));
        if (name is not null)
        {
            contentNames++;
        }
        else
        {
            name = GetMapEntryName(kind, id);
            if (name is not null)
                mapLegendNames++;
            else
            {
                name = GetMapTypeName(kind == "Tile" ? "Terraria.ModLoader.TileLoader" : "Terraria.ModLoader.WallLoader",
                    kind == "Tile" ? "GetTile" : "GetWall", id);
                if (name is not null)
                    contentNames++;
                else
                {
                    name = GetPlaceableItemName(kind, id);
                    if (name is not null)
                        itemNames++;
                    else
                    {
                        name = GetInternalMapName(kind, id) ?? GetMapTypeInternalName(kind, id);
                        if (name is null)
                        {
                            name = $"{(kind == "Tile" ? "Tile" : "Wall")} #{id}";
                            unnamed++;
                        }
                        else
                            internalNames++;
                    }
                }
            }
        }

        if (name is not null)
            names[key] = name;
    }

    private static int GetRegisteredContentCount(string typeName, string propertyName)
    {
        try
        {
            var loader = typeof(Mod).Assembly.GetType(typeName);
            var value = loader?.GetProperty(propertyName, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(null);
            if (value is int count && count > 0)
                return count;
        }
        catch { }
        return 0;
    }

    private static string? CleanMapName(string? name)
    {
        return string.IsNullOrWhiteSpace(name) || name.StartsWith("[", StringComparison.Ordinal)
            ? null
            : name;
    }

    private static string? GetMapTypeName(string typeName, string methodName, int id)
    {
        try
        {
            var loader = typeof(Mod).Assembly.GetType(typeName);
            var method = loader?.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                .FirstOrDefault(candidate => candidate.Name == methodName
                    && candidate.GetParameters() is { Length: 1 } parameters
                    && parameters[0].ParameterType == typeof(int));
            var value = method?.Invoke(null, new object[] { id });
            if (value is null)
                return null;

            // ModTile and ModWall expose their map localization through
            // CreateMapEntryName(), not DisplayName.
            var createName = value.GetType().GetMethod("CreateMapEntryName",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
                binder: null, Type.EmptyTypes, modifiers: null);
            var localizedName = createName?.Invoke(value, null);
            var name = localizedName?.GetType().GetProperty("Value")?.GetValue(localizedName)?.ToString();
            return CleanMapName(name);
        }
        catch { return null; }
    }

    private static string? ReadLocalizedName(string fieldName, int id)
    {
        try
        {
            var owner = typeof(Main).Assembly.GetType("Terraria.Lang");
            var values = owner?.GetField(fieldName, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(null) as Array;
            if (values is null || id < 0 || id >= values.Length) return null;
            var entry = values.GetValue(id);
            var value = entry?.GetType().GetProperty("Value")?.GetValue(entry)?.ToString();
            return string.IsNullOrWhiteSpace(value) ? null : value;
        }
        catch { return null; }
    }

    private void InitializeModdedServerMapPalette()
    {
        var mapLoader = typeof(ModSystem).Assembly.GetType("Terraria.ModLoader.MapLoader");
        if (mapLoader is null)
            throw new InvalidOperationException("tModLoader MapLoader was not found.");

        // MapLoader.FinishSetup returns immediately on a dedicated server.
        // Reproduce only its map palette registration here without flipping
        // Main.dedServ, which is a process-wide runtime mode flag.
        var tileEntries = ReadStaticDictionary(mapLoader, "tileEntries");
        var wallEntries = ReadStaticDictionary(mapLoader, "wallEntries");
        var entryToTile = ReadStaticDictionary(mapLoader, "entryToTile");
        var entryToWall = ReadStaticDictionary(mapLoader, "entryToWall");
        var nameFuncs = ReadStaticDictionary(mapLoader, "nameFuncs");
        var modPosition = ReadStaticInt(typeof(MapHelper), "modPosition");
        var colorLookupField = typeof(MapHelper).GetField("colorLookup", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("MapHelper.colorLookup was not found.");
        var colors = colorLookupField.GetValue(null) as Microsoft.Xna.Framework.Color[]
            ?? throw new InvalidOperationException("MapHelper.colorLookup is not initialized.");

        var tileCount = GetRegisteredContentCount("Terraria.ModLoader.TileLoader", "TileCount");
        var wallCount = GetRegisteredContentCount("Terraria.ModLoader.WallLoader", "WallCount");
        if (tileCount <= 0 || wallCount <= 0)
            throw new InvalidOperationException($"Could not read tModLoader tile/wall counts (tiles={tileCount}, walls={wallCount}).");
        Array.Resize(ref MapHelper.tileLookup, Math.Max(MapHelper.tileLookup.Length, tileCount));
        Array.Resize(ref MapHelper.wallLookup, Math.Max(MapHelper.wallLookup.Length, wallCount));
        Array.Resize(ref MapHelper.tileOptionCounts, Math.Max(MapHelper.tileOptionCounts.Length, tileCount));
        Array.Resize(ref MapHelper.wallOptionCounts, Math.Max(MapHelper.wallOptionCounts.Length, wallCount));
        entryToTile.Clear();
        entryToWall.Clear();
        nameFuncs.Clear();

        var entriesTotal = CountMapEntries(tileEntries) + CountMapEntries(wallEntries);
        var palette = new Microsoft.Xna.Framework.Color[checked(modPosition + entriesTotal)];
        Array.Copy(colors, palette, Math.Min(colors.Length, modPosition));
        var legend = Lang._mapLegendCache ??= new MapLegend(MapHelper.LookupCount());
        var resizeLegend = typeof(MapLegend).GetMethod("Resize", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("MapLegend.Resize was not found.");
        resizeLegend.Invoke(legend, new object[] { palette.Length });
        var paletteOffset = 0;
        AddModMapEntries(tileEntries, MapHelper.tileLookup, MapHelper.tileOptionCounts, palette, modPosition, ref paletteOffset, entryToTile, nameFuncs, legend);
        AddModMapEntries(wallEntries, MapHelper.wallLookup, MapHelper.wallOptionCounts, palette, modPosition, ref paletteOffset, entryToWall, nameFuncs, legend);
        colorLookupField.SetValue(null, palette);

        var initializedField = mapLoader.GetField("initialized", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        initializedField?.SetValue(null, true);
        BuildLocalizedMapNameCatalog();
        Mod.Logger.Info($"Initialized dedicated-server map palette without changing Main.dedServ or Main.myPlayer; loaded {_localizedMapNames.Count} localized tile and wall names for {Language.ActiveCulture.Name}.");
    }

    private static System.Collections.IDictionary ReadStaticDictionary(Type owner, string fieldName)
    {
        var field = owner.GetField(fieldName, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException($"{owner.FullName}.{fieldName} was not found.");
        return field.GetValue(null) as System.Collections.IDictionary
            ?? throw new InvalidOperationException($"{owner.FullName}.{fieldName} is not a dictionary.");
    }

    private static int ReadStaticInt(Type owner, string fieldName)
    {
        var field = owner.GetField(fieldName, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException($"{owner.FullName}.{fieldName} was not found.");
        return Convert.ToInt32(field.GetValue(null), System.Globalization.CultureInfo.InvariantCulture);
    }

    private static int CountMapEntries(System.Collections.IDictionary entries)
    {
        var count = 0;
        foreach (System.Collections.DictionaryEntry group in entries)
            if (group.Value is System.Collections.ICollection values)
                count = checked(count + values.Count);
        return count;
    }

    private static void AddModMapEntries(
        System.Collections.IDictionary entries,
        ushort[] lookup,
        int[] optionCounts,
        Microsoft.Xna.Framework.Color[] palette,
        int modPosition,
        ref int paletteOffset,
        System.Collections.IDictionary entryToContent,
        System.Collections.IDictionary nameFuncs,
        MapLegend legend)
    {
        foreach (System.Collections.DictionaryEntry group in entries)
        {
            var contentType = Convert.ToUInt16(group.Key, System.Globalization.CultureInfo.InvariantCulture);
            if (contentType >= lookup.Length || contentType >= optionCounts.Length
                || group.Value is not System.Collections.ICollection mapEntryCollection
                || group.Value is not System.Collections.IEnumerable mapEntries)
                throw new InvalidOperationException($"Invalid registered map content type {contentType}.");

            lookup[contentType] = checked((ushort)(modPosition + paletteOffset));
            optionCounts[contentType] = mapEntryCollection.Count;
            foreach (var mapEntry in mapEntries)
            {
                if (mapEntry is null)
                    continue;
                var entryType = mapEntry.GetType();
                var color = ReadMapEntryMember(entryType, mapEntry, "color");
                var localizedName = ReadMapEntryMember(entryType, mapEntry, "name") as LocalizedText;
                var getName = ReadMapEntryMember(entryType, mapEntry, "getName") as Delegate;
                if (color is not Microsoft.Xna.Framework.Color mapColor || localizedName is null || getName is null)
                    throw new InvalidOperationException($"Map entry for content {contentType} is missing its name delegate or localized name.");

                var mapType = checked((ushort)(modPosition + paletteOffset));
                palette[mapType] = mapColor;
                entryToContent[mapType] = contentType;
                nameFuncs[mapType] = getName;
                legend[mapType] = localizedName;
                paletteOffset++;
            }
        }
    }

    private static object? ReadMapEntryMember(Type owner, object instance, string memberName)
    {
        var field = owner.GetField(memberName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (field is not null)
            return field.GetValue(instance);
        var property = owner.GetProperty(memberName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        return property?.GetValue(instance);
    }

    // Dedicated servers do not know each client's window size or its private
    // .map file. Capture the current screen-sized world region around players,
    // using Terraria's own map palette (including loaded mod map entries).
    // The monitor merges these overlapping RGBA patches into persistent maps.
    private object? CaptureMapView(Player player, string playerKey)
    {
        const int viewWidth = 96;
        const int viewHeight = 54;
        const int regionWidth = 32;
        const int regionHeight = 18;
        var tileX = (int)Math.Floor(player.position.X / 16.0);
        var tileY = (int)Math.Floor(player.position.Y / 16.0);
        if (tileX < 0 || tileY < 0 || tileX >= Main.maxTilesX || tileY >= Main.maxTilesY)
            return null;

        var regionX = tileX / regionWidth;
        var regionY = tileY / regionHeight;
        var regionKey = ((long)regionX << 32) | (uint)regionY;
        if (!_capturedMapRegions.TryGetValue(playerKey, out var captured))
        {
            captured = new System.Collections.Generic.Dictionary<long, DateTime>();
            _capturedMapRegions[playerKey] = captured;
        }
        var now = DateTime.UtcNow;
        if (captured.TryGetValue(regionKey, out var lastCapture) && now - lastCapture < TimeSpan.FromSeconds(30))
            return null;
        captured[regionKey] = now;

        var x = Math.Max(0, tileX - viewWidth / 2);
        var y = Math.Max(0, tileY - viewHeight / 2);
        var width = Math.Min(viewWidth, Main.maxTilesX - x);
        var height = Math.Min(viewHeight, Main.maxTilesY - y);
        var originalMap = Main.Map;
        var installedLookupMap = originalMap is null;
        try
        {
            // Dedicated servers skip the client map setup path. Initialize the
            // vanilla and modded palettes without changing Main.dedServ.
            if (!_initializedServerMapPalette)
            {
                MapHelper.Initialize();
                InitializeModdedServerMapPalette();
                _initializedServerMapPalette = true;
                Mod.Logger.Info("Initialized Terraria map palettes for dedicated-server map capture.");
            }

            // MapHelper.CreateMapTile computes Terraria's exact map palette from Main.tile,
            // including modded tile map entries, but it unconditionally reads Main.Map first.
            // Dedicated servers leave Main.Map null because they do not render a client map.
            // A scratch WorldMap supplies that otherwise-unused lookup; keep it installed only
            // while this synchronous capture runs so other server systems never see it.
            if (installedLookupMap)
            {
                if (_serverMapLookup is null
                    || _serverMapLookup.MaxWidth != Main.maxTilesX
                    || _serverMapLookup.MaxHeight != Main.maxTilesY)
                {
                    _serverMapLookup = new WorldMap(Main.maxTilesX, Main.maxTilesY);
                }
                Main.Map = _serverMapLookup;
                if (!_loggedServerMapWorkaround)
                {
                    _loggedServerMapWorkaround = true;
                    Mod.Logger.Info("Dedicated-server map capture is using a temporary Terraria WorldMap lookup.");
                }
            }

            var pixels = new byte[checked(width * height * 4)];
            var tileInfo = CaptureTileInfo(x, y, width, height);
            for (var row = 0; row < height; row++)
            {
                for (var column = 0; column < width; column++)
                {
                    var sampleX = x + column;
                    var sampleY = y + row;
                    Microsoft.Xna.Framework.Color color;
                    try
                    {
                        var mapTile = MapHelper.CreateMapTile(sampleX, sampleY, byte.MaxValue);
                        color = MapHelper.GetMapTileXnaColor(ref mapTile);
                    }
                    catch (IndexOutOfRangeException exception)
                    {
                        if (!_loggedMapCaptureWarning)
                        {
                            _loggedMapCaptureWarning = true;
                            var tile = Main.tile[sampleX, sampleY];
                            Mod.Logger.Warn($"Could not render map pixel ({sampleX},{sampleY}), tile={tile.TileType}, wall={tile.WallType}; using black fallback: {exception.Message}");
                        }
                        color = Microsoft.Xna.Framework.Color.Black;
                    }
                    var offset = (row * width + column) * 4;
                    pixels[offset] = color.R;
                    pixels[offset + 1] = color.G;
                    pixels[offset + 2] = color.B;
                    pixels[offset + 3] = 255;
                }
            }

            using var compressed = new MemoryStream();
            using (var zlib = new ZLibStream(compressed, CompressionLevel.Fastest, leaveOpen: true))
                zlib.Write(pixels, 0, pixels.Length);

            return new
            {
                x,
                y,
                width,
                height,
                encoding = "rgba-zlib-base64",
                data = Convert.ToBase64String(compressed.ToArray()),
                tileInfo = tileInfo.Data,
                tileNames = tileInfo.Names
            };
        }
        catch (Exception exception)
        {
            captured.Remove(regionKey);
            if (!_loggedMapCaptureWarning)
            {
                _loggedMapCaptureWarning = true;
                Mod.Logger.Warn($"Could not read Terraria map colors; telemetry continues without map captures: {exception.GetType().Name}.");
            }
            return null;
        }
        finally
        {
            if (!ReferenceEquals(Main.Map, originalMap))
                Main.Map = originalMap;
        }
    }

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

    private static object ReadPlayerAppearance(Player player)
    {
        var hairSettings = ReadHairSettings(player);
        var appearance = new Dictionary<string, object?>
        {
            ["head"] = ReadPlayerInt(player, "head"),
            ["equippedHead"] = ReadEquippedHead(player),
            ["body"] = ReadPlayerInt(player, "body"),
            ["legs"] = ReadPlayerInt(player, "legs"),
            ["hair"] = ReadPlayerInt(player, "hair"),
            ["beard"] = ReadPlayerInt(player, "beard"),
            ["skinVariant"] = ReadPlayerInt(player, "skinVariant"),
            ["hairColor"] = ReadPlayerColor(player, "hairColor"),
            ["skinColor"] = ReadPlayerColor(player, "skinColor"),
            ["eyeColor"] = ReadPlayerColor(player, "eyeColor"),
            ["armor"] = ReadPlayerItemSlots(player, "armor"),
            ["dyes"] = ReadPlayerItemSlots(player, "dye"),
            ["miscEquips"] = ReadPlayerItemSlots(player, "miscEquips"),
            ["miscDyes"] = ReadPlayerItemSlots(player, "miscDyes"),
            ["modEquipTextures"] = ExportModdedEquipTextures(player),
            ["hideVisibleAccessory"] = ReadPlayerBooleanSlots(player, "hideVisibleAccessory"),
            ["hideMisc"] = ReadPlayerBooleanSlots(player, "hideMisc"),
            ["hairSettings"] = hairSettings
        };
        appearance["signature"] = Convert.ToHexString(
            SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(appearance, JsonOptions))
        ).ToLowerInvariant();
        return appearance;
    }

    // tModLoader stores modded equipment sprites inside .tmod archives. Export
    // only equip textures used by this player's worn items so the local CPU
    // renderer can compose Calamity and other modded gear without a GPU.
    private static Dictionary<string, string> ExportModdedEquipTextures(Player player)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        var assetDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "TerrariaTunnel", "mod-textures");
        var equipTypes = new[]
        {
            EquipType.Head, EquipType.Body, EquipType.Legs, EquipType.Face, EquipType.Beard,
            EquipType.Back, EquipType.Front, EquipType.Wings, EquipType.Shoes, EquipType.Waist,
            EquipType.Neck, EquipType.HandsOn, EquipType.HandsOff, EquipType.Shield, EquipType.Balloon
        };

        foreach (var item in EnumerateEquippedItems(player))
        {
            var modItem = item.ModItem;
            if (modItem?.Mod == null)
                continue;

            // Calamity's TransformationAccessory registers its vanity equip
            // textures only on clients, so dedicated servers need to read the
            // equip declarations from the item type and extract those textures
            // directly from the loaded .tmod archive.
            ExportDeclaredTransformationTextures(modItem, result, assetDirectory);
            ExportKnownCalamityTransformationTextures(modItem, result, assetDirectory);

            foreach (var equipType in equipTypes)
            {
                try
                {
                    var slot = EquipLoader.GetEquipSlot(modItem.Mod, modItem.Name, equipType);
                    if (slot < 0)
                        continue;
                    var equipTexture = EquipLoader.GetEquipTexture(equipType, slot);
                    if (equipTexture == null || string.IsNullOrWhiteSpace(equipTexture.Texture))
                        continue;

                    var assetKey = $"{modItem.Mod.Name}/{equipTexture.Texture}";
                    var exportedPath = ExportedEquipTextures.GetOrAdd(assetKey, _ =>
                    {
                        var relativePath = equipTexture.Texture.StartsWith(modItem.Mod.Name + "/", StringComparison.Ordinal)
                            ? equipTexture.Texture[(modItem.Mod.Name.Length + 1)..]
                            : equipTexture.Texture;
                        var bytes = ReadModTexturePng(modItem.Mod, relativePath);
                        if (bytes.Length == 0)
                            return string.Empty;
                        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(assetKey))).ToLowerInvariant();
                        Directory.CreateDirectory(assetDirectory);
                        var destination = Path.Combine(assetDirectory, hash + ".png");
                        if (!File.Exists(destination))
                            File.WriteAllBytes(destination, bytes);
                        return destination;
                    });

                    if (!string.IsNullOrEmpty(exportedPath))
                        result[equipType.ToString()] = exportedPath;
                }
                catch (Exception)
                {
                    // An unavailable/custom texture should not interrupt telemetry snapshots.
                }
            }
        }

        return result;
    }

    private static void ExportKnownCalamityTransformationTextures(
        ModItem modItem,
        Dictionary<string, string> result,
        string assetDirectory)
    {
        // HapuFruit's transformation uses the shared Heart_* textures. Reading
        // its declared EquipSlots through reflection is not reliable across
        // Calamity builds, so keep this known mapping explicit as a fallback.
        if (modItem.Mod?.Name != "CalamityMod" || modItem.Name != "HapuFruit")
            return;

        foreach (var equipType in new[] { EquipType.Head, EquipType.Body, EquipType.Legs, EquipType.Back })
        {
            try
            {
                var assetKey = $"CalamityMod/Items/Accessories/Vanity/Heart_{equipType}";
                // Use a distinct cache key so a previous failed reflective
                // lookup cannot poison this direct archive lookup.
                var cacheKey = $"hapu-fruit:{assetKey}";
                var exportedPath = ExportedEquipTextures.GetOrAdd(cacheKey, _ =>
                {
                    var bytes = ReadModTexturePng(modItem.Mod, $"Items/Accessories/Vanity/Heart_{equipType}");
                    if (bytes.Length == 0)
                        return string.Empty;
                    var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(assetKey))).ToLowerInvariant();
                    Directory.CreateDirectory(assetDirectory);
                    var destination = Path.Combine(assetDirectory, hash + ".png");
                    if (!File.Exists(destination))
                        File.WriteAllBytes(destination, bytes);
                    return destination;
                });
                if (!string.IsNullOrEmpty(exportedPath))
                    result[$"Transformation{equipType}"] = exportedPath;
            }
            catch (Exception)
            {
                // Keep telemetry running if a Calamity build renames an asset.
            }
        }
    }

    private static void ExportDeclaredTransformationTextures(ModItem modItem, Dictionary<string, string> result, string assetDirectory)
    {
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        var type = modItem.GetType();
        var isTransformationAccessory = false;
        for (var current = type; current != null; current = current.BaseType)
        {
            if (current.Name == "TransformationAccessory")
            {
                isTransformationAccessory = true;
                break;
            }
        }
        if (!isTransformationAccessory)
            return;

        try
        {
            var assetPath = type.GetProperty("AssetPath", flags)?.GetValue(modItem) as string
                ?? "CalamityMod/Items/Accessories/Vanity/";
            if (type.GetProperty("AssetPath", flags) == null)
            {
                for (var current = type.BaseType; current != null; current = current.BaseType)
                {
                    var property = current.GetProperty("AssetPath", flags);
                    if (property != null)
                    {
                        assetPath = property.GetValue(modItem) as string ?? assetPath;
                        break;
                    }
                }
            }

            var slotsProperty = type.GetProperty("EquipSlots", flags);
            if (slotsProperty == null)
            {
                for (var current = type.BaseType; current != null; current = current.BaseType)
                {
                    slotsProperty = current.GetProperty("EquipSlots", flags);
                    if (slotsProperty != null)
                        break;
                }
            }
            if (slotsProperty?.GetValue(modItem) is not IEnumerable slots)
                return;

            foreach (var slot in slots)
            {
                if (slot == null)
                    continue;
                var tupleType = slot.GetType();
                var equipType = tupleType.GetField("Item1")?.GetValue(slot)?.ToString();
                var assetName = tupleType.GetField("Item2")?.GetValue(slot) as string;
                if (string.IsNullOrWhiteSpace(equipType) || string.IsNullOrWhiteSpace(assetName))
                    continue;

                var textureAsset = $"{assetPath}{assetName}_{equipType}";
                var modPrefix = modItem.Mod.Name + "/";
                var relativePath = textureAsset.StartsWith(modPrefix, StringComparison.Ordinal)
                    ? textureAsset[modPrefix.Length..]
                    : textureAsset;
                var exportedPath = ExportedEquipTextures.GetOrAdd(textureAsset, _ =>
                {
                    var bytes = ReadModTexturePng(modItem.Mod, relativePath);
                    if (bytes.Length == 0)
                        return string.Empty;
                    var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(textureAsset))).ToLowerInvariant();
                    Directory.CreateDirectory(assetDirectory);
                    var destination = Path.Combine(assetDirectory, hash + ".png");
                    if (!File.Exists(destination))
                        File.WriteAllBytes(destination, bytes);
                    return destination;
                });
                if (!string.IsNullOrEmpty(exportedPath))
                    result[$"Transformation{equipType}"] = exportedPath;
            }
        }
        catch (Exception)
        {
            // Custom transformations are optional telemetry; never break the snapshot.
        }
    }

    private static byte[] ReadModTexturePng(Mod mod, string texturePath)
    {
        var png = mod.GetFileBytes(texturePath + ".png");
        if (png is { Length: > 0 })
            return png;

        // tModLoader packages source images as .rawimg, not .png. RawImg v1 is
        // three little-endian Int32 values (version, width, height), followed
        // by width*height RGBA bytes. Convert it directly to PNG so the local
        // headless sprite renderer can use mod textures without graphics APIs.
        var rawImage = mod.GetFileBytes(texturePath + ".rawimg");
        if (rawImage == null || rawImage.Length < 12)
            return Array.Empty<byte>();

        using var input = new MemoryStream(rawImage, writable: false);
        using var reader = new BinaryReader(input);
        var version = reader.ReadInt32();
        var width = reader.ReadInt32();
        var height = reader.ReadInt32();
        if (version != 1 || width < 1 || height < 1 || width > 8192 || height > 8192)
            return Array.Empty<byte>();

        var rgbaLength = checked(width * height * 4);
        var rgba = reader.ReadBytes(rgbaLength);
        if (rgba.Length != rgbaLength || input.Position != input.Length)
            return Array.Empty<byte>();

        var scanlineLength = checked(width * 4 + 1);
        var scanlines = new byte[checked(scanlineLength * height)];
        for (var row = 0; row < height; row++)
            Buffer.BlockCopy(rgba, row * width * 4, scanlines, row * scanlineLength + 1, width * 4);

        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(compressed, CompressionLevel.Fastest, leaveOpen: true))
            zlib.Write(scanlines, 0, scanlines.Length);

        using var output = new MemoryStream();
        output.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
        var header = new byte[13];
        WriteUInt32BigEndian(header, 0, (uint)width);
        WriteUInt32BigEndian(header, 4, (uint)height);
        header[8] = 8; // bit depth
        header[9] = 6; // RGBA
        WritePngChunk(output, "IHDR", header);
        WritePngChunk(output, "IDAT", compressed.ToArray());
        WritePngChunk(output, "IEND", Array.Empty<byte>());
        return output.ToArray();
    }

    private static void WritePngChunk(Stream output, string type, byte[] data)
    {
        WriteUInt32BigEndian(output, (uint)data.Length);
        var typeBytes = Encoding.ASCII.GetBytes(type);
        output.Write(typeBytes, 0, typeBytes.Length);
        output.Write(data, 0, data.Length);
        var crc = 0xffffffffu;
        foreach (var value in typeBytes.Concat(data))
        {
            crc ^= value;
            for (var bit = 0; bit < 8; bit++)
                crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xedb88320u : crc >> 1;
        }
        WriteUInt32BigEndian(output, ~crc);
    }

    private static void WriteUInt32BigEndian(Stream stream, uint value)
    {
        stream.WriteByte((byte)(value >> 24));
        stream.WriteByte((byte)(value >> 16));
        stream.WriteByte((byte)(value >> 8));
        stream.WriteByte((byte)value);
    }

    private static void WriteUInt32BigEndian(byte[] buffer, int offset, uint value)
    {
        buffer[offset] = (byte)(value >> 24);
        buffer[offset + 1] = (byte)(value >> 16);
        buffer[offset + 2] = (byte)(value >> 8);
        buffer[offset + 3] = (byte)value;
    }

    private static IEnumerable<Item> EnumerateEquippedItems(Player player)
    {
        foreach (var slotName in new[] { "armor", "miscEquips" })
        {
            if (ReadPlayerMember(player, slotName) is not IEnumerable items)
                continue;
            foreach (var item in items.Cast<object?>().OfType<Item>())
            {
                if (item.stack > 0)
                    yield return item;
            }
        }
    }

    private static int? ReadEquippedHead(Player player)
    {
        if (ReadPlayerMember(player, "armor") is not IEnumerable items)
            return null;

        foreach (var item in items.Cast<object?>())
        {
            if (item == null || ReadPlayerInt(item, "stack") is not > 0)
                continue;
            var headSlot = ReadPlayerInt(item, "headSlot");
            if (headSlot is >= 0)
                return headSlot;
        }

        return null;
    }

    private static Dictionary<string, bool> ReadHairSettings(Player player)
    {
        var result = new Dictionary<string, bool>(StringComparer.Ordinal);
        var method = player.GetType().GetMethod(
            "GetHairSettings",
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
        );
        var arguments = new object?[] { false, false, false, false, false };
        try
        {
            method?.Invoke(player, arguments);
        }
        catch (Exception)
        {
            // Keep safe defaults if a tModLoader version changes this helper.
        }

        result["fullHair"] = arguments[0] is true;
        result["hatHair"] = arguments[1] is true;
        result["hideHair"] = arguments[2] is true;
        result["backHairDraw"] = arguments[3] is true;
        result["backHairWithoutHeadgear"] = arguments[4] is true;
        return result;
    }

    private static object?[] ReadPlayerItemSlots(Player player, string name)
    {
        if (ReadPlayerMember(player, name) is not IEnumerable items)
            return Array.Empty<object?>();

        return items.Cast<object?>().Select(item => item == null ? null : new
        {
            type = ReadPlayerInt(item, "type"),
            stack = ReadPlayerInt(item, "stack"),
            prefix = ReadPlayerInt(item, "prefix"),
            modName = (item as Item)?.ModItem?.Mod?.Name,
            modItemName = (item as Item)?.ModItem?.Name,
            headSlot = ReadPlayerInt(item, "headSlot"),
            bodySlot = ReadPlayerInt(item, "bodySlot"),
            legSlot = ReadPlayerInt(item, "legSlot")
        }).ToArray();
    }

    private static bool[] ReadPlayerBooleanSlots(Player player, string name) =>
        ReadPlayerMember(player, name) is IEnumerable values
            ? values.Cast<object?>().Select(value => value is bool flag && flag).ToArray()
            : Array.Empty<bool>();

    private static int? ReadPlayerInt(object player, string name)
    {
        var value = ReadPlayerMember(player, name);
        try { return value == null ? null : Convert.ToInt32(value); }
        catch (Exception) { return null; }
    }

    private static string? ReadPlayerColor(Player player, string name)
    {
        var color = ReadPlayerMember(player, name);
        if (color == null)
            return null;

        var red = ReadColorChannel(color, "R");
        var green = ReadColorChannel(color, "G");
        var blue = ReadColorChannel(color, "B");
        return red.HasValue && green.HasValue && blue.HasValue
            ? $"#{red.Value:X2}{green.Value:X2}{blue.Value:X2}"
            : null;
    }

    private static object? ReadPlayerMember(object player, string name)
    {
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        var type = player.GetType();
        try
        {
            return type.GetField(name, flags)?.GetValue(player)
                ?? type.GetProperty(name, flags)?.GetValue(player);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static int? ReadColorChannel(object color, string name)
    {
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        try
        {
            var type = color.GetType();
            var value = type.GetField(name, flags)?.GetValue(color)
                ?? type.GetProperty(name, flags)?.GetValue(color);
            return value == null ? null : Convert.ToInt32(value);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private async Task AcceptClientsAsync(TcpListener listener, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            TcpClient socket;
            try
            {
                socket = await listener.AcceptTcpClientAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (SocketException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (ObjectDisposedException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }

            socket.NoDelay = true;
            var id = Interlocked.Increment(ref _nextClientId);
            var client = new TelemetryClient(socket, () => _clients.TryRemove(id, out _));
            _clients[id] = client;
            if (Volatile.Read(ref _latestSnapshot) is { } latest)
                client.Publish(latest);
            _ = client.RunAsync(cancellationToken);
            Mod.Logger.Info($"Tunnel monitor connected ({_clients.Count} telemetry client(s)).");
        }
    }

    private sealed class TelemetryClient
    {
        private readonly TcpClient _socket;
        private readonly Action _onClosed;
        private readonly Channel<string> _pending = Channel.CreateBounded<string>(new BoundedChannelOptions(1)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false
        });

        public TelemetryClient(TcpClient socket, Action onClosed)
        {
            _socket = socket;
            _onClosed = onClosed;
        }

        public void Publish(string json) => _pending.Writer.TryWrite(json);

        public async Task RunAsync(CancellationToken cancellationToken)
        {
            try
            {
                var stream = _socket.GetStream();
                await foreach (var json in _pending.Reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
                {
                    var bytes = Encoding.UTF8.GetBytes(json);
                    await stream.WriteAsync(bytes.AsMemory(), cancellationToken).ConfigureAwait(false);
                    await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) { }
            catch (IOException) { }
            catch (SocketException) { }
            catch (ObjectDisposedException) { }
            finally
            {
                Stop();
                _onClosed();
            }
        }

        public void Stop()
        {
            _pending.Writer.TryComplete();
            try { _socket.Close(); } catch { }
        }
    }

    private static (bool Available, System.Collections.Generic.Dictionary<string, bool?> Bosses) ReadCalamityBossProgress()
    {
        var statuses = new System.Collections.Generic.Dictionary<string, bool?>();
        if (!ModLoader.TryGetMod("CalamityMod", out var calamity))
            return (false, statuses);

        try
        {
            RefreshSavedCalamityDownedFlags();
            const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;
            var downedBossSystem = calamity.Code.GetType("CalamityMod.DownedBossSystem", false);
            foreach (var boss in CalamityBossFlags)
            {
                var property = downedBossSystem?.GetProperty(boss.Field, flags);
                var field = downedBossSystem?.GetField("_" + boss.Field, flags);
                var value = property?.GetValue(null) ?? field?.GetValue(null);
                var defeatedInSave = _savedCalamityDownedFlags.Contains(boss.SaveKey);
                if (boss.Id == "giant-clam")
                {
                    var hardmodeProperty = downedBossSystem?.GetProperty("downedCLAMHardMode", flags);
                    var hardmodeField = downedBossSystem?.GetField("_downedCLAMHardMode", flags);
                    defeatedInSave |= _savedCalamityDownedFlags.Contains("clamHardmode")
                        || (hardmodeProperty?.GetValue(null) ?? hardmodeField?.GetValue(null)) is true;
                }
                statuses[boss.Id] = value is bool defeated ? defeated || defeatedInSave : defeatedInSave ? true : null;
            }
        }
        catch (Exception)
        {
            foreach (var boss in CalamityBossFlags)
                statuses[boss.Id] = null;
        }

        return (true, statuses);
    }

    private static void RefreshSavedCalamityDownedFlags()
    {
        var worldPath = Main.ActiveWorldFileData?.Path;
        if (string.IsNullOrWhiteSpace(worldPath))
            return;

        var savePath = Path.ChangeExtension(worldPath, ".twld");
        if (!File.Exists(savePath))
            return;

        try
        {
            var writeTime = File.GetLastWriteTimeUtc(savePath);
            if (string.Equals(savePath, _cachedWorldSavePath, StringComparison.Ordinal)
                && writeTime == _cachedWorldSaveWriteTimeUtc)
                return;

            var root = TagIO.FromFile(savePath);
            var modData = root.GetList<TagCompound>("modData");
            var downedSystem = modData.FirstOrDefault(entry =>
                entry.GetString("mod") == "CalamityMod"
                && entry.GetString("name") == "DownedBossSystem");
            var savedFlags = downedSystem?.GetCompound("data").GetList<string>("downedFlags");
            _savedCalamityDownedFlags = savedFlags == null
                ? new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal)
                : new System.Collections.Generic.HashSet<string>(savedFlags, StringComparer.Ordinal);
            _cachedWorldSavePath = savePath;
            _cachedWorldSaveWriteTimeUtc = writeTime;
        }
        catch (IOException)
        {
            // Keep the last successfully read save snapshot and live Calamity flags.
        }
    }

    private static string[] DefeatedBosses(System.Collections.Generic.Dictionary<string, bool?> calamityStatuses)
    {
        var bosses = new System.Collections.Generic.List<string>();
        if (NPC.downedSlimeKing) bosses.Add("King Slime");
        if (NPC.downedBoss1) bosses.Add("Eye of Cthulhu");
        if (NPC.downedBoss2) bosses.Add("Eater of Worlds / Brain of Cthulhu");
        if (NPC.downedQueenBee) bosses.Add("Queen Bee");
        if (NPC.downedBoss3) bosses.Add("Skeletron");
        if (NPC.downedDeerclops) bosses.Add("Deerclops");
        if (Main.hardMode) bosses.Add("Wall of Flesh / hardmode");
        if (NPC.downedQueenSlime) bosses.Add("Queen Slime");
        if (NPC.downedMechBoss1) bosses.Add("The Destroyer");
        if (NPC.downedMechBoss2) bosses.Add("The Twins");
        if (NPC.downedMechBoss3) bosses.Add("Skeletron Prime");
        if (NPC.downedPlantBoss) bosses.Add("Plantera");
        if (NPC.downedGolemBoss) bosses.Add("Golem");
        if (NPC.downedFishron) bosses.Add("Duke Fishron");
        if (NPC.downedEmpressOfLight) bosses.Add("Empress of Light");
        if (NPC.downedAncientCultist) bosses.Add("Lunatic Cultist");
        if (NPC.downedMoonlord) bosses.Add("Moon Lord");
        if (NPC.downedTowerSolar) bosses.Add("Solar Pillar");
        if (NPC.downedTowerVortex) bosses.Add("Vortex Pillar");
        if (NPC.downedTowerNebula) bosses.Add("Nebula Pillar");
        if (NPC.downedTowerStardust) bosses.Add("Stardust Pillar");
        if (NPC.downedGoblins) bosses.Add("Goblin Army");
        if (NPC.downedFrost) bosses.Add("Frost Legion");
        if (NPC.downedPirates) bosses.Add("Pirate Invasion");
        if (NPC.downedMartians) bosses.Add("Martian Madness");
        if (NPC.downedHalloweenTree) bosses.Add("Pumpkin Moon: Mourning Wood");
        if (NPC.downedHalloweenKing) bosses.Add("Pumpkin Moon: Pumpking");
        if (NPC.downedChristmasIceQueen) bosses.Add("Frost Moon: Ice Queen");
        if (NPC.downedChristmasSantank) bosses.Add("Frost Moon: Santa-NK1");
        if (NPC.downedChristmasTree) bosses.Add("Frost Moon: Everscream");
        if (NPC.downedClown) bosses.Add("Clown");
        foreach (var boss in CalamityBossFlags)
        {
            if (calamityStatuses.TryGetValue(boss.Id, out var defeated) && defeated == true)
                bosses.Add(boss.Name);
        }
        return bosses.ToArray();
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
}
