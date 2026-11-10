using System.Collections.Generic;
using Terraria;

namespace TerrariaWorldViewerTelemetry;

/// <summary>Reads built-in world progression flags on the game thread.</summary>
internal static class BossProgressSnapshotReader
{
    internal static string[] DefeatedBosses()
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
        return bosses.ToArray();
    }
}
