using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Terraria;
using Terraria.ID;
using Terraria.Localization;
using Terraria.ModLoader;
using Terraria.Map;

namespace TerrariaTunnelTelemetry;

/// <summary>Resolves and streams localized tile and wall names for map chunks.</summary>
internal sealed class MapTileNameCatalog
{
    private const int BatchSize = 64;
    private const int MaxSendRounds = 4;

    private readonly Mod _mod;
    private Dictionary<string, string> _localizedNames = new(StringComparer.Ordinal);
    private Dictionary<string, string> _cultureTranslations = new(StringComparer.Ordinal);
    private string? _cultureName;
    private int _sendIndex;
    private int _sendRounds;

    public MapTileNameCatalog(Mod mod)
    {
        _mod = mod;
    }

    public int LocalizedNameCount => _localizedNames.Count;

    public Dictionary<string, string> GetNamesForChunk(
        IEnumerable<ushort> tileTypes,
        IEnumerable<ushort> wallTypes
    )
    {
        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        AddNextCatalogBatch(names);
        AddChunkNames("Tile", tileTypes, names);
        AddChunkNames("Wall", wallTypes, names);
        return names;
    }

    private void AddNextCatalogBatch(Dictionary<string, string> names)
    {
        if (_sendRounds >= MaxSendRounds || _localizedNames.Count == 0)
            return;

        foreach (var pair in _localizedNames.Skip(_sendIndex).Take(BatchSize))
            names[pair.Key] = pair.Value;

        _sendIndex += BatchSize;
        if (_sendIndex >= _localizedNames.Count)
        {
            _sendRounds++;
            _sendIndex = 0;
        }
    }

    private void AddChunkNames(
        string kind,
        IEnumerable<ushort> types,
        Dictionary<string, string> names
    )
    {
        foreach (var id in types)
        {
            var key = $"{(kind == "Tile" ? 't' : 'w')}{id}";
            if (!names.ContainsKey(key) && TryGetLocalizedMapName(kind, id, out var name))
                names[key] = name;
        }
    }

    internal static string GetLocalizedNpcName(NPC npc)
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

    internal bool TryGetLocalizedMapName(string kind, int id, out string name)
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

    private string? GetExactCultureValue(object? localizedText)
    {
        try
        {
            var key = localizedText?.GetType().GetField("Key", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                ?.GetValue(localizedText)?.ToString();
            return key is not null && _cultureTranslations.TryGetValue(key, out var value)
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

    internal void BuildLocalizedMapNameCatalog()
    {
        var culture = Language.ActiveCulture.Name;
        if (string.Equals(_cultureName, culture, StringComparison.Ordinal)
            && _localizedNames.Count > 0)
            return;

        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        _cultureTranslations = LoadActiveCultureTranslations();
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
        _localizedNames = names;
        _cultureName = culture;
        _sendIndex = 0;
        _sendRounds = 0;
        _mod.Logger.Info($"Map-name coverage: {names.Count}/{tileCount + wallCount} tile/wall IDs; exact {culture} localization keys={_cultureTranslations.Count}, MapLegend={mapLegendNames}, content localization={contentNames}, placeable item localization={itemNames}, internal names={internalNames}, unnamed={unnamed}; culture={culture}.");
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
                    _mod.Logger.Warn($"Could not read {Language.ActiveCulture.Name} map-name translations from mod {mod.Name}: {exception.Message}");
                }
            }
        }
        catch (Exception exception)
        {
            _mod.Logger.Warn($"Could not enumerate {Language.ActiveCulture.Name} map-name translations: {exception.Message}");
        }
        return translations;
    }

    private void AddLocalizedMapName(string kind, int id, string key, Dictionary<string, string> names,
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

    internal static int GetRegisteredContentCount(string typeName, string propertyName)
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
}
