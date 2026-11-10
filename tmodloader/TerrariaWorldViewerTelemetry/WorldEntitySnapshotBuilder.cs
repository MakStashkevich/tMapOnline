using System;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using Microsoft.Xna.Framework;
using Terraria;
using Terraria.GameContent;
using Terraria.DataStructures;
using Terraria.GameContent.Tile_Entities;
using Terraria.ID;
using Terraria.Localization;
using Terraria.ModLoader;
using Terraria.ModLoader.Default;

namespace TerrariaWorldViewerTelemetry;

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
            // Match vanilla's TeleportPylonsSystem: scan registered pylon tile
            // entities by position so both vanilla and modded pylons are found.
            return TileEntity.ByPosition.Values
                .OfType<TileEntity>()
                .Where(entity => entity is IPylonTileEntity)
                .Select(entity =>
                {
                    string? typeName = null;
                    if (entity is TETeleportationPylon vanillaPylon
                        && vanillaPylon.TryGetPylonType(out var vanillaType))
                    {
                        typeName = vanillaType.ToString();
                    }
                    else if (TEModdedPylon.GetModPylonFromCoords(
                        entity.Position.X,
                        entity.Position.Y,
                        out var modPylon))
                    {
                        typeName = modPylon.PylonType.ToString();
                    }

                    return typeName == null
                        ? null
                        : new
                        {
                            x = entity.Position.X,
                            y = entity.Position.Y,
                            type = typeName
                        };
                })
                .Where(pylon => pylon != null)
                .Cast<object>()
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
            .Where(npc => npc.active && npc.type != NPCID.None)
            .Select(npc => new
            {
                Npc = npc,
                HeadSlot = TownNPCProfiles.GetHeadIndexSafe(npc),
                // Match Main's map renderer: some boss-head markers, including
                // the Celestial Pillars, have a map head without npc.boss set.
                BossHeadSlot = npc.GetBossHeadTextureIndex()
            })
            // Terraria's fullscreen map shows NPCs with a map head profile and
            // bosses with a boss-head texture. townNPC alone is not sufficient:
            // some modded NPCs expose a valid map head without setting that flag.
            .Where(entry => entry.HeadSlot > 0 || entry.BossHeadSlot != -1)
            .Select(entry =>
            {
                var npc = entry.Npc;
                var mapPosition = GetMapPosition(npc, entry.BossHeadSlot);
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
                    direction = npc.direction,
                    x = mapPosition.X / 16.0,
                    y = mapPosition.Y / 16.0,
                    velocity = new { x = npc.velocity.X, y = npc.velocity.Y },
                    frameWidth = Math.Max(1, npc.frame.Width > 1 ? npc.frame.Width : npc.width),
                    frameHeight = Math.Max(1, npc.frame.Height > 1 ? npc.frame.Height : npc.height),
                    modTexture = texture,
                    headSlot = entry.HeadSlot,
                    bossHeadSlot = entry.BossHeadSlot,
                    headTexture
                };
            })
            .ToArray();
    }

    private static Vector2 GetMapPosition(NPC npc, int bossHeadSlot)
    {
        if (bossHeadSlot == -1)
        {
            // Main's fullscreen map centers friendly heads on the NPC hitbox.
            // Its Y coordinate also follows gfxOffY, which is important for
            // NPCs whose drawn sprite bobs or is vertically offset from the hitbox.
            return new Vector2(
                npc.position.X + npc.netOffset.X + npc.width / 2,
                npc.position.Y + npc.gfxOffY + npc.netOffset.Y + npc.height / 2
            );
        }

        var position = npc.Center + new Vector2(0f, npc.gfxOffY) + npc.netOffset;
        if (npc.type != NPCID.TheDestroyer)
            return position;

        // Terraria groups the head for the segmented Destroyer at the
        // average center of its linked body segments.
        var center = npc.Center;
        var count = 1;
        var nextIndex = (int)npc.ai[0];
        while (count < 15 && nextIndex >= 0 && nextIndex < Main.npc.Length)
        {
            var next = Main.npc[nextIndex];
            if (
                !next.active
                || next.type < NPCID.TheDestroyer
                || next.type > NPCID.TheDestroyerTail
            )
                break;
            center += next.Center;
            count++;
            nextIndex = (int)next.ai[0];
        }

        return center / count;
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
                    "TerrariaWorldViewer", "npc-textures");
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
