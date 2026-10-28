using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using Terraria;
using Terraria.ID;
using Terraria.Localization;
using Terraria.ModLoader;
using Terraria.Map;

namespace TerrariaTunnelTelemetry;

/// <summary>Scans the world in small chunks and emits Terraria-colored map data.</summary>
internal sealed class WorldMapScanner
{
    private const int ChunkSize = 32;
    private readonly Mod _mod;
    private readonly MapTileNameCatalog _tileNames;
    private readonly MapTileDataCapture _tileData;
    private readonly Queue<object> _pendingCaptures = new();
    private bool _initializedPalette;
    private WorldMap? _serverMapLookup;
    private int _nextChunk;
    private int _worldId = -1;
    private int _scannedChunks;
    private int _failedChunks;
    private int _failedTiles;
    private bool _loggedScanStart;
    private bool _loggedWarning;
    private bool _loggedMapWorkaround;

    public WorldMapScanner(Mod mod, MapTileNameCatalog tileNames, MapTileDataCapture tileData)
    {
        _mod = mod;
        _tileNames = tileNames;
        _tileData = tileData;
    }

    internal object[] DrainCaptures()
    {
        var captures = new List<object>(64);
        while (captures.Count < 64 && _pendingCaptures.Count > 0)
            captures.Add(_pendingCaptures.Dequeue());
        return captures.ToArray();
    }

    internal object GetStatus()
    {
        const int chunkSize = ChunkSize;
        var columns = Main.maxTilesX > 0 ? (Main.maxTilesX + chunkSize - 1) / chunkSize : 0;
        var rows = Main.maxTilesY > 0 ? (Main.maxTilesY + chunkSize - 1) / chunkSize : 0;
        var total = columns * rows;
        var attempted = Math.Min(_nextChunk, total);
        return new
        {
            enabled = true,
            active = Main.netMode == NetmodeID.Server && total > 0 && attempted < total,
            complete = total > 0 && attempted >= total,
            scannedChunks = _scannedChunks,
            attemptedChunks = attempted,
            failedChunks = _failedChunks,
            failedTiles = _failedTiles,
            totalChunks = total,
            remainingChunks = Math.Max(0, total - attempted),
            percent = total == 0 ? 0 : Math.Round(attempted * 100d / total, 1),
            worldId = Main.worldID,
            worldName = Main.worldName,
            width = Main.maxTilesX,
            height = Main.maxTilesY
        };
    }

    internal void CaptureNextChunk()
    {
        if (Main.netMode != NetmodeID.Server || Main.maxTilesX <= 0 || Main.maxTilesY <= 0)
            return;
        if (_worldId != Main.worldID)
        {
            _worldId = Main.worldID;
            _nextChunk = 0;
            _scannedChunks = 0;
            _failedChunks = 0;
            _failedTiles = 0;
            _pendingCaptures.Clear();
            _loggedScanStart = false;
            _loggedWarning = false;
        }
        const int chunkSize = ChunkSize;
        var columns = (Main.maxTilesX + chunkSize - 1) / chunkSize;
        var rows = (Main.maxTilesY + chunkSize - 1) / chunkSize;
        if (!_loggedScanStart)
        {
            _loggedScanStart = true;
            _mod.Logger.Info($"World map scan started on the server tick loop: {Main.maxTilesX}x{Main.maxTilesY} tiles, {columns * rows} chunks.");
        }
        if (_nextChunk >= columns * rows)
            return;

        var index = _nextChunk++;
        var chunkX = index % columns;
        var chunkY = index / columns;
        var x = chunkX * chunkSize;
        var y = chunkY * chunkSize;
        var width = Math.Min(chunkSize, Main.maxTilesX - x);
        var height = Math.Min(chunkSize, Main.maxTilesY - y);
        var originalMap = Main.Map;
        try
        {
            EnsurePalette();
            if (originalMap is null)
            {
                if (_serverMapLookup is null
                    || _serverMapLookup.MaxWidth != Main.maxTilesX
                    || _serverMapLookup.MaxHeight != Main.maxTilesY)
                    _serverMapLookup = new WorldMap(Main.maxTilesX, Main.maxTilesY);
                Main.Map = _serverMapLookup;
            }
            var pixels = new byte[width * height * 4];
            var tileInfo = _tileData.Capture(x, y, width, height);
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
                    _failedTiles++;
                    if (!_loggedWarning)
                    {
                        _loggedWarning = true;
                        var tile = Main.tile[tileX, tileY];
                        _mod.Logger.Warn($"Could not render Terraria map tile ({tileX},{tileY}), type={tile.TileType}, wall={tile.WallType}; using black fallback: {exception}");
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
            _pendingCaptures.Enqueue(new
            {
                x, y, width, height, encoding = "rgba-zlib-base64",
                data = Convert.ToBase64String(compressed.ToArray()),
                tileInfo = tileInfo.Data,
                tileNames = tileInfo.Names,
                tileNamesLanguage = Language.ActiveCulture.Name,
                tileNamesVersion = 6
            });
            _scannedChunks++;
        }
        catch (Exception exception)
        {
            _failedChunks++;
            if (!_loggedWarning)
            {
                _loggedWarning = true;
                _mod.Logger.Warn($"Could not render Terraria base map chunk ({chunkX},{chunkY}) at tile ({x},{y}); telemetry continues without it: {exception}.");
            }
        }
        finally
        {
            // CreateMapTile may inspect neighboring map pixels; restore Main.Map even when rendering fails.
            RestoreMap(originalMap);
        }
    }

    internal void EnsurePalette()
    {
        if (_initializedPalette)
            return;

        MapHelper.Initialize();
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

        var tileCount = MapTileNameCatalog.GetRegisteredContentCount("Terraria.ModLoader.TileLoader", "TileCount");
        var wallCount = MapTileNameCatalog.GetRegisteredContentCount("Terraria.ModLoader.WallLoader", "WallCount");
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
        _tileNames.BuildLocalizedMapNameCatalog();
        _initializedPalette = true;
        _mod.Logger.Info($"Initialized dedicated-server map palette without changing Main.dedServ or Main.myPlayer; loaded {_tileNames.LocalizedNameCount} localized tile and wall names for {Language.ActiveCulture.Name}.");
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

    internal bool InstallLookupMapIfNeeded()
    {
        if (Main.Map is not null)
            return false;

        if (_serverMapLookup is null
            || _serverMapLookup.MaxWidth != Main.maxTilesX
            || _serverMapLookup.MaxHeight != Main.maxTilesY)
            _serverMapLookup = new WorldMap(Main.maxTilesX, Main.maxTilesY);

        Main.Map = _serverMapLookup;
        if (!_loggedMapWorkaround)
        {
            _loggedMapWorkaround = true;
            _mod.Logger.Info("Dedicated-server map capture is using a temporary Terraria WorldMap lookup.");
        }
        return true;
    }

    internal void RestoreMap(WorldMap? originalMap)
    {
        if (!ReferenceEquals(Main.Map, originalMap))
            Main.Map = originalMap;
    }

}
