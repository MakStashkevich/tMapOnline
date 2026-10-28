using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Terraria;
using Terraria.ModLoader;
using Terraria.ModLoader.IO;

namespace TerrariaTunnelTelemetry;

/// <summary>Reads vanilla and Calamity progression without mixing it into the telemetry lifecycle.</summary>
internal static class BossProgressSnapshotReader
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
    internal static (bool Available, Dictionary<string, bool?> Bosses) ReadCalamityBossProgress()
    {
        var statuses = new Dictionary<string, bool?>();
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
                ? new HashSet<string>(StringComparer.Ordinal)
                : new HashSet<string>(savedFlags, StringComparer.Ordinal);
            _cachedWorldSavePath = savePath;
            _cachedWorldSaveWriteTimeUtc = writeTime;
        }
        catch (IOException)
        {
            // Keep the last successfully read save snapshot and live Calamity flags.
        }
    }

    internal static string[] DefeatedBosses(Dictionary<string, bool?> calamityStatuses)
    {
        var bosses = new List<string>();
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

}
