using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using Terraria;
using Terraria.ID;
using Terraria.Localization;
using Terraria.ModLoader;
using Terraria.Map;

namespace TerrariaTunnelTelemetry;

/// <summary>Captures map regions revealed around online players.</summary>
internal sealed class PlayerMapCapture
{
    private const int ViewWidth = 96;
    private const int ViewHeight = 54;
    private const int RegionWidth = 32;
    private const int RegionHeight = 18;

    private readonly Mod _mod;
    private readonly WorldMapScanner _scanner;
    private readonly MapTileDataCapture _tileData;
    private readonly Dictionary<string, Dictionary<long, DateTime>> _capturedRegions = new(StringComparer.Ordinal);
    private bool _loggedCaptureWarning;

    public PlayerMapCapture(Mod mod, WorldMapScanner scanner, MapTileDataCapture tileData)
    {
        _mod = mod;
        _scanner = scanner;
        _tileData = tileData;
    }

    internal object? Capture(Player player, string playerKey)
    {
        var tileX = (int)Math.Floor(player.position.X / 16.0);
        var tileY = (int)Math.Floor(player.position.Y / 16.0);
        if (tileX < 0 || tileY < 0 || tileX >= Main.maxTilesX || tileY >= Main.maxTilesY)
            return null;

        var regionX = tileX / RegionWidth;
        var regionY = tileY / RegionHeight;
        var regionKey = ((long)regionX << 32) | (uint)regionY;
        if (!_capturedRegions.TryGetValue(playerKey, out var captured))
        {
            captured = new Dictionary<long, DateTime>();
            _capturedRegions[playerKey] = captured;
        }
        var now = DateTime.UtcNow;
        if (captured.TryGetValue(regionKey, out var lastCapture) && now - lastCapture < TimeSpan.FromSeconds(30))
            return null;
        captured[regionKey] = now;

        var x = Math.Max(0, tileX - ViewWidth / 2);
        var y = Math.Max(0, tileY - ViewHeight / 2);
        var width = Math.Min(ViewWidth, Main.maxTilesX - x);
        var height = Math.Min(ViewHeight, Main.maxTilesY - y);
        var originalMap = Main.Map;
        try
        {
            // Dedicated servers skip the client map setup path. Initialize the
            // vanilla and modded palettes without changing Main.dedServ.
            _scanner.EnsurePalette();

            // MapHelper.CreateMapTile computes Terraria's exact map palette from Main.tile,
            // including modded tile map entries, but it unconditionally reads Main.Map first.
            // Dedicated servers leave Main.Map null because they do not render a client map.
            // A scratch WorldMap supplies that otherwise-unused lookup; keep it installed only
            // while this synchronous capture runs so other server systems never see it.
            _scanner.InstallLookupMapIfNeeded();

            var pixels = new byte[checked(width * height * 4)];
            var tileInfo = _tileData.Capture(x, y, width, height);
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
                        if (!_loggedCaptureWarning)
                        {
                            _loggedCaptureWarning = true;
                            var tile = Main.tile[sampleX, sampleY];
                            _mod.Logger.Warn($"Could not render map pixel ({sampleX},{sampleY}), tile={tile.TileType}, wall={tile.WallType}; using black fallback: {exception.Message}");
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
            if (!_loggedCaptureWarning)
            {
                _loggedCaptureWarning = true;
                _mod.Logger.Warn($"Could not read Terraria map colors; telemetry continues without map captures: {exception.GetType().Name}.");
            }
            return null;
        }
        finally
        {
            _scanner.RestoreMap(originalMap);
        }
    }
}
