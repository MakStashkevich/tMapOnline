#!/usr/bin/env python3
"""Keep the typed telemetry model aligned with the existing JSONL contract."""

from __future__ import annotations

import unittest

from tmaponline.models import LiveTelemetrySnapshot


class LiveTelemetryModelTests(unittest.TestCase):
    def test_snapshot_converts_raw_entities_to_typed_models(self) -> None:
        snapshot = LiveTelemetrySnapshot.from_payload({
            "server": {"version": "1.4.4"},
            "world": {
                "name": "calamity2",
                "activeNpcs": [{
                    "id": "npc-1",
                    "type": 50,
                    "name": "King Slime",
                    "boss": True,
                    "x": 120,
                    "y": 80,
                }],
                "droppedCoins": [{"id": "coin-1", "type": 73, "x": 121, "y": 80, "stack": 4}],
            },
            "players": {"list": [{"name": "Toha", "uuid": "player-1", "position": {"tileX": 120, "tileY": 80}}]},
            "pylons": [{"x": 300, "y": 90, "type": "Forest"}],
            "baseMapCaptures": [{"x": 0, "y": 0, "width": 1, "height": 1}],
            "mapScan": {"active": True},
        })

        self.assertEqual(snapshot.npcs[0].npc_type, 50)
        self.assertTrue(snapshot.npcs[0].is_boss)
        self.assertEqual(snapshot.npcs[0].tile_x, 120)
        self.assertEqual(snapshot.coins[0].item_type, 73)
        self.assertEqual(snapshot.players[0].name, "Toha")
        self.assertEqual(snapshot.pylons[0].pylon_type, "Forest")
        self.assertTrue(snapshot.map_scan["active"] if snapshot.map_scan else False)

    def test_invalid_entity_rows_are_skipped_without_changing_the_snapshot(self) -> None:
        snapshot = LiveTelemetrySnapshot.from_payload({
            "server": {},
            "world": {
                "activeNpcs": [{"type": "not-a-number", "x": 10, "y": 20}],
                "droppedCoins": [{"type": 99, "x": 1, "y": 1, "stack": 1}],
            },
            "players": {"list": [{"name": ""}, {"name": "besty"}]},
            "pylons": [{"x": -1, "y": 10, "type": "Forest"}],
        })

        self.assertEqual(snapshot.npcs, ())
        self.assertEqual(snapshot.coins, ())
        self.assertEqual([player.name for player in snapshot.players], ["besty"])
        self.assertEqual(snapshot.pylons, ())

    def test_player_model_keeps_legacy_store_keys_at_serialization_boundary(self) -> None:
        snapshot = LiveTelemetrySnapshot.from_payload({
            "server": {},
            "world": {},
            "players": {"list": [{
                "name": "Toha",
                "joinedAtUnix": 123.0,
                "sessionSeconds": 45,
                "position": {"tileX": 10, "tileY": 20},
                "teleported": True,
                "mapCapture": {"encoding": "rgba-zlib-base64"},
            }]},
        })

        player = snapshot.players[0]
        self.assertEqual(player.joined_at, 123.0)
        self.assertEqual(player.session_seconds, 45.0)
        self.assertTrue(player.teleported)
        self.assertEqual(set(player.to_store_payload()), {
            "name", "uuid", "joined_at", "session_seconds", "position",
            "teleported", "mapCapture", "appearance",
        })


if __name__ == "__main__":
    unittest.main()
