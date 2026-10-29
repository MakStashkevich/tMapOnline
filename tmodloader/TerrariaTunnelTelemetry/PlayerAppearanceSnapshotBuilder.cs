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
using Terraria.ID;
using Terraria.ModLoader;
using Terraria.GameContent;

namespace TerrariaTunnelTelemetry;

/// <summary>Builds the appearance payload and exports modded textures used by player snapshots.</summary>
internal static class PlayerAppearanceSnapshotBuilder
{
    private static readonly JsonSerializerOptions JsonOptions = new();
    private static readonly ConcurrentDictionary<string, string> ExportedEquipTextures = new(StringComparer.Ordinal);

    internal static object Capture(Player player)
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
            ["face"] = ReadPlayerInt(player, "face"),
            ["faceHead"] = ReadPlayerInt(player, "faceHead"),
            ["faceFlower"] = ReadPlayerInt(player, "faceFlower"),
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

    internal static byte[] ReadModTexturePng(Mod mod, string texturePath)
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

        var head = ReadPlayerInt(player, "head") ?? -1;
        var face = ReadPlayerInt(player, "face") ?? -1;
        result["drawHead"] = ReadSetFlag(ArmorIDs.Head.Sets.DrawHead, head, true);
        result["drawBeard"] = head < 0 || !ReadSetFlag(ArmorIDs.Head.Sets.PreventBeardDraw, head, false);
        result["beardUsesHairColor"] = ReadSetFlag(
            ArmorIDs.Beard.Sets.UseHairColor,
            ReadPlayerInt(player, "beard") ?? -1,
            false
        );
        result["faceUnderHair"] = ReadSetFlag(ArmorIDs.Face.Sets.DrawInFaceUnderHairLayer, face, false);
        return result;
    }

    private static bool ReadSetFlag(bool[] flags, int index, bool defaultValue) =>
        index >= 0 && index < flags.Length ? flags[index] : defaultValue;

    private static object?[] ReadPlayerItemSlots(Player player, string name)
    {
        if (ReadPlayerMember(player, name) is not IEnumerable items)
            return Array.Empty<object?>();

        return items.Cast<object?>().Select((item, slotIndex) => item == null ? null : new
        {
            slotIndex,
            type = ReadPlayerInt(item, "type"),
            netId = ReadPlayerInt(item, "netID"),
            stack = ReadPlayerInt(item, "stack"),
            prefix = ReadPlayerInt(item, "prefix"),
            dye = ReadPlayerInt(item, "dye"),
            modName = (item as Item)?.ModItem?.Mod?.Name,
            modItemName = (item as Item)?.ModItem?.Name,
            headSlot = ReadPlayerInt(item, "headSlot"),
            bodySlot = ReadPlayerInt(item, "bodySlot"),
            legSlot = ReadPlayerInt(item, "legSlot"),
            faceSlot = ReadPlayerInt(item, "faceSlot"),
            beardSlot = ReadPlayerInt(item, "beardSlot"),
            backSlot = ReadPlayerInt(item, "backSlot"),
            frontSlot = ReadPlayerInt(item, "frontSlot"),
            shoeSlot = ReadPlayerInt(item, "shoeSlot"),
            waistSlot = ReadPlayerInt(item, "waistSlot"),
            neckSlot = ReadPlayerInt(item, "neckSlot"),
            handOnSlot = ReadPlayerInt(item, "handOnSlot"),
            handOffSlot = ReadPlayerInt(item, "handOffSlot"),
            shieldSlot = ReadPlayerInt(item, "shieldSlot"),
            wingSlot = ReadPlayerInt(item, "wingSlot")
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
}
