using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Terraria;
using Terraria.ModLoader;
using Terraria.ModLoader.IO;

namespace TerrariaWorldViewerTelemetry;

/// <summary>Optional Calamity-specific downed flag adapter; vanilla progress has no dependency on it.</summary>
internal static class CalamityBossProgressAdapter
{
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
    private static HashSet<string> _savedCalamityDownedFlags = new(StringComparer.Ordinal);
    internal static (bool Available, Dictionary<string, bool?> Bosses) Read()
    {
        var statuses = new Dictionary<string, bool?>();
        if (!ModLoader.TryGetMod("CalamityMod", out var calamity))
            return (false, statuses);

        try
        {
            RefreshSavedCalamityDownedFlags();
            const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;
            var system = calamity.Code.GetType("CalamityMod.DownedBossSystem", false);
            foreach (var boss in CalamityBossFlags)
            {
                var property = system?.GetProperty(boss.Field, flags);
                var field = system?.GetField("_" + boss.Field, flags);
                var value = property?.GetValue(null) ?? field?.GetValue(null);
                var saved = _savedCalamityDownedFlags.Contains(boss.SaveKey);
                if (boss.Id == "giant-clam")
                {
                    var hardmodeProperty = system?.GetProperty("downedCLAMHardMode", flags);
                    var hardmodeField = system?.GetField("_downedCLAMHardMode", flags);
                    saved |= _savedCalamityDownedFlags.Contains("clamHardmode")
                        || (hardmodeProperty?.GetValue(null) ?? hardmodeField?.GetValue(null)) is true;
                }
                statuses[boss.Id] = value is bool defeated ? defeated || saved : saved ? true : null;
            }
        }
        catch (Exception)
        {
            foreach (var boss in CalamityBossFlags) statuses[boss.Id] = null;
        }
        return (true, statuses);
    }

    internal static void RecordVictory(NPC npc)
    {
        var modNpc = npc.ModNPC;
        if (modNpc?.Mod?.Name != "CalamityMod" || !CalamityBossIds.TryGetValue(modNpc.Name, out var bossId))
            return;
        if (bossId == "exo-mechs" && Main.npc.Any(other => other.active && other.whoAmI != npc.whoAmI && IsExoMech(other)))
            return;
        BossVictoryTracker.BossVictoryStore.Record(bossId);
    }

    private static bool IsExoMech(NPC npc)
    {
        var modNpc = npc.ModNPC;
        return modNpc?.Mod?.Name == "CalamityMod"
            && modNpc.Name is "AresBody" or "ThanatosHead" or "Artemis" or "Apollo";
    }

    private static readonly Dictionary<string, string> CalamityBossIds = new(StringComparer.OrdinalIgnoreCase)
    {
        ["DesertScourgeHead"] = "desert-scourge", ["Crabulon"] = "crabulon", ["HiveMind"] = "hive-mind",
        ["PerforatorHead"] = "perforators", ["SlimeGodCore"] = "slime-god", ["Cryogen"] = "cryogen",
        ["AquaticScourgeHead"] = "aquatic-scourge", ["BrimstoneElemental"] = "brimstone-elemental",
        ["CalamitasClone"] = "calamitas-clone", ["Leviathan"] = "leviathan-anahita", ["AstrumAureus"] = "astrum-aureus",
        ["PlaguebringerGoliath"] = "plaguebringer-goliath", ["RavagerBody"] = "ravager", ["AstrumDeusHead"] = "astrum-deus",
        ["ProfanedGuardianCommander"] = "profaned-guardians", ["Bumblefuck"] = "dragonfolly", ["Providence"] = "providence",
        ["StormWeaverHead"] = "storm-weaver", ["CeaselessVoid"] = "ceaseless-void", ["Signus"] = "signus",
        ["Polterghast"] = "polterghast", ["BoomerDuke"] = "old-duke", ["DevourerofGodsHead"] = "devourer-of-gods",
        ["Yharon"] = "yharon", ["AresBody"] = "exo-mechs", ["ThanatosHead"] = "exo-mechs",
        ["Artemis"] = "exo-mechs", ["Apollo"] = "exo-mechs", ["SupremeCalamitas"] = "supreme-calamitas",
        ["AdultEidolonWyrmHead"] = "primordial-wyrm", ["GiantClam"] = "giant-clam", ["CragmawMire"] = "cragmaw-mire",
        ["GreatSandShark"] = "great-sand-shark", ["Mauler"] = "mauler", ["NuclearTerror"] = "nuclear-terror"
    };

    private static void RefreshSavedCalamityDownedFlags()
    {
        var worldPath = Main.ActiveWorldFileData?.Path;
        if (string.IsNullOrWhiteSpace(worldPath)) return;
        var savePath = Path.ChangeExtension(worldPath, ".twld");
        if (!File.Exists(savePath)) return;
        try
        {
            var writeTime = File.GetLastWriteTimeUtc(savePath);
            if (string.Equals(savePath, _cachedWorldSavePath, StringComparison.Ordinal) && writeTime == _cachedWorldSaveWriteTimeUtc) return;
            var root = TagIO.FromFile(savePath);
            var data = root.GetList<TagCompound>("modData").FirstOrDefault(entry =>
                entry.GetString("mod") == "CalamityMod" && entry.GetString("name") == "DownedBossSystem");
            var saved = data?.GetCompound("data").GetList<string>("downedFlags");
            _savedCalamityDownedFlags = saved == null ? new HashSet<string>(StringComparer.Ordinal) : new HashSet<string>(saved, StringComparer.Ordinal);
            _cachedWorldSavePath = savePath;
            _cachedWorldSaveWriteTimeUtc = writeTime;
        }
        catch (IOException) { }
    }
}
