using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Terraria;
using Terraria.ID;
using Terraria.ModLoader;

namespace tMapOnline;

/// <summary>
/// Counts completed boss encounters once per world and stores the analytics in JSON.
/// Vanilla downed flags only say whether a boss was ever defeated; they do not retain repeat wins.
/// </summary>
public sealed class BossVictoryTracker : GlobalNPC
{
    internal static Dictionary<string, int> SnapshotCounts() => BossVictoryStore.Snapshot();

    private static readonly Dictionary<int, string> VanillaBossTypes = new()
    {
        [NPCID.KingSlime] = "king-slime",
        [NPCID.EyeofCthulhu] = "eye-of-cthulhu",
        [NPCID.EaterofWorldsHead] = "eater-of-worlds",
        [NPCID.BrainofCthulhu] = "brain-of-cthulhu",
        [NPCID.QueenBee] = "queen-bee",
        [NPCID.Deerclops] = "deerclops",
        [NPCID.SkeletronHead] = "skeletron",
        [NPCID.WallofFlesh] = "wall-of-flesh",
        [NPCID.QueenSlimeBoss] = "queen-slime",
        [NPCID.Retinazer] = "the-twins",
        [NPCID.TheDestroyer] = "the-destroyer",
        [NPCID.SkeletronPrime] = "skeletron-prime",
        [NPCID.Plantera] = "plantera",
        [NPCID.Golem] = "golem",
        [NPCID.DukeFishron] = "duke-fishron",
        [NPCID.HallowBoss] = "empress-of-light",
        [NPCID.CultistBoss] = "lunatic-cultist",
        [NPCID.MoonLordCore] = "moon-lord",
        [NPCID.DD2DarkMageT1] = "dark-mage",
        [NPCID.DD2OgreT2] = "ogre",
        [NPCID.DD2Betsy] = "betsy",
        [NPCID.MourningWood] = "mourning-wood",
        [NPCID.Pumpking] = "pumpking",
        [NPCID.Everscream] = "everscream",
        [NPCID.SantaNK1] = "santa-nk1",
        [NPCID.IceQueen] = "ice-queen",
        [NPCID.MartianSaucerCore] = "martian-saucer",
        [NPCID.LunarTowerSolar] = "solar-pillar",
        [NPCID.LunarTowerNebula] = "nebula-pillar",
        [NPCID.LunarTowerVortex] = "vortex-pillar",
        [NPCID.LunarTowerStardust] = "stardust-pillar"
    };

    public override void OnKill(NPC npc)
    {
        if (Main.netMode != NetmodeID.Server)
            return;

        if (VanillaBossTypes.TryGetValue(npc.type, out var vanillaId))
        {
            if (vanillaId == "the-twins")
            {
                var otherTwin = npc.type == NPCID.Retinazer ? NPCID.Spazmatism : NPCID.Retinazer;
                if (NPC.AnyNPCs(otherTwin))
                    return;
            }
            BossVictoryStore.Record(vanillaId);
            return;
        }

        CalamityBossProgressAdapter.RecordVictory(npc);
    }

    internal static class BossVictoryStore
    {
        private static readonly object Gate = new();
        private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
        private static readonly string FilePath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "tMapOnline", "boss-victories.json");
        private static Dictionary<string, Dictionary<string, int>> _worldCounts = new(StringComparer.Ordinal);
        private static string? _activeWorldKey;

        public static void EnsureWorldLoaded()
        {
            lock (Gate)
                LoadWorldLocked();
        }

        public static void Record(string bossId)
        {
            lock (Gate)
            {
                LoadWorldLocked();
                if (_activeWorldKey == null)
                    return;

                var counts = _worldCounts[_activeWorldKey];
                counts[bossId] = counts.TryGetValue(bossId, out var current) ? current + 1 : 1;
                SaveLocked();
            }
        }

        public static Dictionary<string, int> Snapshot()
        {
            lock (Gate)
            {
                LoadWorldLocked();
                return _activeWorldKey != null && _worldCounts.TryGetValue(_activeWorldKey, out var counts)
                    ? new Dictionary<string, int>(counts, StringComparer.Ordinal)
                    : new Dictionary<string, int>(StringComparer.Ordinal);
            }
        }

        private static void LoadWorldLocked()
        {
            var worldKey = Main.ActiveWorldFileData == null
                ? null
                : $"{Main.worldID}:{Main.worldName}";
            if (string.Equals(worldKey, _activeWorldKey, StringComparison.Ordinal))
                return;

            _activeWorldKey = worldKey;
            _worldCounts = new Dictionary<string, Dictionary<string, int>>(StringComparer.Ordinal);
            try
            {
                if (File.Exists(FilePath))
                {
                    var json = File.ReadAllText(FilePath);
                    _worldCounts = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, int>>>(json)
                        ?? new Dictionary<string, Dictionary<string, int>>(StringComparer.Ordinal);
                }
            }
            catch (Exception exception) when (exception is IOException || exception is JsonException || exception is UnauthorizedAccessException)
            {
                // Preserve the existing file on disk; start this process with empty in-memory counts.
                _worldCounts = new Dictionary<string, Dictionary<string, int>>(StringComparer.Ordinal);
            }

            if (_activeWorldKey != null && !_worldCounts.ContainsKey(_activeWorldKey))
                _worldCounts[_activeWorldKey] = new Dictionary<string, int>(StringComparer.Ordinal);
        }

        private static void SaveLocked()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
                var temporaryPath = FilePath + ".tmp";
                File.WriteAllText(temporaryPath, JsonSerializer.Serialize(_worldCounts, JsonOptions));
                File.Move(temporaryPath, FilePath, true);
            }
            catch (Exception exception) when (exception is IOException || exception is UnauthorizedAccessException)
            {
                // A failed analytics write must never interfere with killing an NPC or the server tick.
            }
        }
    }
}
