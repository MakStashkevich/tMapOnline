using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using Terraria;
using Terraria.ID;

namespace TerrariaTunnelTelemetry;

/// <summary>Captures one chunk's block IDs and their current localized labels.</summary>
internal sealed class MapTileDataCapture
{
    private readonly MapTileNameCatalog _names;

    public MapTileDataCapture(MapTileNameCatalog names)
    {
        _names = names;
    }

    public (string Data, Dictionary<string, string> Names, List<Microsoft.Xna.Framework.Point> LightSources) Capture(int x, int y, int width, int height)
    {
        // Each tile is stored as two little-endian ushort values; zero means no tile or wall.
        var raw = new byte[checked(width * height * 4)];
        var tileTypes = new HashSet<ushort>();
        var wallTypes = new HashSet<ushort>();
        var lightSources = new List<Microsoft.Xna.Framework.Point>();

        for (var row = 0; row < height; row++)
        for (var column = 0; column < width; column++)
        {
            var tile = Main.tile[x + column, y + row];
            if (tile.HasTile && tile.TileType < Main.tileLighted.Length && Main.tileLighted[tile.TileType])
                lightSources.Add(new Microsoft.Xna.Framework.Point(x + column, y + row));
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

        return (Convert.ToBase64String(compressed.ToArray()), _names.GetNamesForChunk(tileTypes, wallTypes), lightSources);
    }

    public (ushort TileType, ushort WallType, bool IsLightSource, Dictionary<string, string> Names) CaptureTile(int x, int y)
    {
        var tile = Main.tile[x, y];
        var tileType = tile.HasTile ? checked((ushort)(tile.TileType + 1)) : (ushort)0;
        var wallType = tile.WallType == WallID.None ? (ushort)0 : checked((ushort)(tile.WallType + 1));
        var tileTypes = tileType == 0 ? new HashSet<ushort>() : new HashSet<ushort> { (ushort)(tileType - 1) };
        var wallTypes = wallType == 0 ? new HashSet<ushort>() : new HashSet<ushort> { (ushort)(wallType - 1) };
        var isLightSource = tile.HasTile && tile.TileType < Main.tileLighted.Length && Main.tileLighted[tile.TileType];
        return (tileType, wallType, isLightSource, _names.GetNamesForChunk(tileTypes, wallTypes));
    }
}
