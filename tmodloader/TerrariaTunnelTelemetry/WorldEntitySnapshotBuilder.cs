using System;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using Terraria;
using Terraria.GameContent;
using Terraria.DataStructures;
using Terraria.GameContent.Tile_Entities;
using Terraria.ID;
using Terraria.Localization;
using Terraria.ModLoader;

namespace TerrariaTunnelTelemetry;

/// <summary>Collects the world objects displayed as map markers in the Viewer.</summary>
internal sealed class WorldEntitySnapshotBuilder
{
    private static readonly ConcurrentDictionary<string, string> ExportedNpcTextures = new(StringComparer.Ordinal);
    private readonly Mod _mod;

    public WorldEntitySnapshotBuilder(Mod mod)
    {
        _mod = mod;
    }

    internal object[]? CapturePylons()
    {
        try
        {
            // Tile entities remain authoritative on a dedicated server even when the client-only pylon list is empty.
            return TileEntity.ByID.Values
                .OfType<TETeleportationPylon>()
                .Where(pylon => pylon.TryGetPylonType(out _))
                .Select(pylon =>
                {
                    pylon.TryGetPylonType(out var type);
                    return new { x = pylon.Position.X, y = pylon.Position.Y, type = type.ToString() };
                })
                .ToArray();
        }
        catch (Exception exception)
        {
            // A temporary API failure must not look like every pylon disappeared from the world.
            _mod.Logger.Warn($"Could not capture pylon positions; keeping the last known map data. {exception}");
            return null;
        }
    }

    internal object[] CaptureActiveNpcs()
    {
        return Main.npc
            .Where(npc => npc.active && npc.type != NPCID.None && (npc.boss || npc.townNPC))
            .Select(npc =>
            {
                var modNpc = npc.ModNPC;
                var texture = modNpc?.Mod == null ? null : ExportNpcTexture(modNpc.Mod, modNpc.Texture);
                var headTexture = modNpc?.Mod == null
                    ? null
                    : ExportNpcTexture(modNpc.Mod, npc.boss ? modNpc.BossHeadTexture : modNpc.HeadTexture);
                return new
                {
                    id = npc.whoAmI,
                    type = npc.type,
                    name = MapTileNameCatalog.GetLocalizedNpcName(npc),
                    boss = npc.boss,
                    x = (int)Math.Floor(npc.Center.X / 16.0),
                    y = (int)Math.Floor(npc.Center.Y / 16.0),
                    frameWidth = Math.Max(1, npc.frame.Width > 1 ? npc.frame.Width : npc.width),
                    frameHeight = Math.Max(1, npc.frame.Height > 1 ? npc.frame.Height : npc.height),
                    modTexture = texture,
                    headSlot = TownNPCProfiles.GetHeadIndexSafe(npc),
                    bossHeadSlot = npc.boss ? npc.GetBossHeadTextureIndex() : -1,
                    headTexture
                };
            })
            .ToArray();
    }

    internal object[] CaptureDroppedCoins()
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

    private static bool IsCoinItem(int type) =>
        type is ItemID.CopperCoin or ItemID.SilverCoin or ItemID.GoldCoin or ItemID.PlatinumCoin;

    private static string? ExportNpcTexture(Mod mod, string texturePath)
    {
        if (string.IsNullOrWhiteSpace(texturePath)) return null;

        var normalizedPath = texturePath.StartsWith(mod.Name + "/", StringComparison.Ordinal)
            ? texturePath[(mod.Name.Length + 1)..]
            : texturePath;
        var key = $"{mod.Name}/{normalizedPath}";
        return ExportedNpcTextures.GetOrAdd(key, _ =>
        {
            try
            {
                var bytes = PlayerAppearanceSnapshotBuilder.ReadModTexturePng(mod, normalizedPath);
                if (bytes.Length == 0) return string.Empty;

                var digest = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
                var directory = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "TerrariaTunnel", "npc-textures");
                Directory.CreateDirectory(directory);
                var destination = Path.Combine(directory, digest + ".png");
                if (!File.Exists(destination)) File.WriteAllBytes(destination, bytes);
                return digest;
            }
            catch
            {
                return string.Empty;
            }
        });
    }
}
