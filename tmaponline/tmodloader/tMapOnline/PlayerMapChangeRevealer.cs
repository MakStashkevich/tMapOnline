using System;
using System.Collections.Generic;
using Terraria;

namespace tMapOnline;

/// <summary>Reveals deferred world conversions only when an online player visits them.</summary>
internal sealed class PlayerMapChangeRevealer
{
    private const int ViewWidth = 96;
    private const int ViewHeight = 54;
    private static readonly TimeSpan CheckInterval = TimeSpan.FromMilliseconds(250);

    private readonly WorldMapScanner _scanner;
    private readonly Dictionary<string, DateTime> _lastChecks = new(StringComparer.Ordinal);
    private readonly Dictionary<string, VisibleArea> _lastAreas = new(StringComparer.Ordinal);

    public PlayerMapChangeRevealer(WorldMapScanner scanner)
    {
        _scanner = scanner;
    }

    internal void RevealPlayerView(Player player, string playerKey, bool teleported)
    {
        if (Main.hardMode && WorldGen.IsGeneratingHardMode)
            return;

        var now = DateTime.UtcNow;
        if (_lastChecks.TryGetValue(playerKey, out var lastCheck)
            && now - lastCheck < CheckInterval)
            return;
        _lastChecks[playerKey] = now;

        var tileX = (int)Math.Floor(player.position.X / 16.0);
        var tileY = (int)Math.Floor(player.position.Y / 16.0);
        if (tileX < 0 || tileY < 0 || tileX >= Main.maxTilesX || tileY >= Main.maxTilesY)
            return;

        var x = Math.Max(0, tileX - ViewWidth / 2);
        var y = Math.Max(0, tileY - ViewHeight / 2);
        var width = Math.Min(ViewWidth, Main.maxTilesX - x);
        var height = Math.Min(ViewHeight, Main.maxTilesY - y);

        var currentArea = new VisibleArea(x, y, width, height);
        if (teleported || !_lastAreas.TryGetValue(playerKey, out var previousArea))
        {
            // A teleport changes the baseline only; it must not expose a map-wide
            // corridor between the old and new positions.
            _lastAreas[playerKey] = currentArea;
            return;
        }

        if (currentArea != previousArea)
        {
            _scanner.RevealNewlyVisibleTiles(
                currentArea.X,
                currentArea.Y,
                currentArea.Width,
                currentArea.Height,
                previousArea.X,
                previousArea.Y,
                previousArea.Width,
                previousArea.Height
            );
            _lastAreas[playerKey] = currentArea;
        }

        _scanner.RevealConvertedTilesInArea(x, y, width, height);
    }

    private readonly record struct VisibleArea(int X, int Y, int Width, int Height);
}
