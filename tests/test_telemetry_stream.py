#!/usr/bin/env python3
"""Test the telemetry TCP/JSONL exchange with synthetic data; no game is started."""

from __future__ import annotations

import json
import socket
import threading
import time
import tempfile
from pathlib import Path
from typing import Any
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tmaponline.telemetry.stream import TelemetryStreamClient
from tmaponline.backend.store import StatusStore


def main() -> None:
    fixture = {
        "schemaVersion": 1,
        "generatedAtUnix": 1_798_000_000,
        "server": {"version": "1.4.4.9", "world": "telemetry-test", "playersOnline": 1},
        "world": {
            "id": 42,
            "name": "telemetry-test",
            "width": 8400,
            "height": 2400,
            "gameMode": {"name": "expert"},
            "defeatedBosses": ["King Slime"],
            "bossDefeatCounts": {"eye-of-cthulhu": 2},
            "bossStatus": {
                "calamityAvailable": True,
                "calamityBosses": {"crabulon": True, "yharon": False},
            },
        },
        "players": {
            "online": 1,
            "list": [{
                "slot": 0,
                "name": "TestPlayer",
                "uuid": "test-uuid",
                "position": {"tileX": 123, "tileY": 456},
                "appearance": {"head": 3, "hair": 12, "signature": "test-signature"},
            }],
        },
    }

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    received: list[dict[str, object]] = []
    connected = threading.Event()
    received_snapshot = threading.Event()
    temp_dir = tempfile.TemporaryDirectory(prefix="terraria-telemetry-test-")
    data_dir = Path(temp_dir.name)
    store = StatusStore(
        events_file=data_dir / "events.json",
        history_file=data_dir / "monitor.json",
        players_file=data_dir / "players.json",
        metrics_file=data_dir / "metrics.json",
        avatars_dir=data_dir / "avatars",
        movements_dir=data_dir / "movements",
    )

    def serve_fixture() -> None:
        try:
            connection, _ = listener.accept()
            with connection:
                connection.sendall((json.dumps(fixture, separators=(",", ":")) + "\n").encode("utf-8"))
                time.sleep(0.2)
        finally:
            listener.close()

    server_thread = threading.Thread(target=serve_fixture, daemon=True)
    server_thread.start()
    def receive_snapshot(snapshot: dict[str, Any]) -> None:
        received.append(snapshot)
        store.set_live_telemetry(snapshot)
        received_snapshot.set()

    client = TelemetryStreamClient(
        receive_snapshot,
        lambda state: connected.set() if state else None,
        port=port,
    )
    client.start()
    try:
        if not connected.wait(3) or not received_snapshot.wait(3):
            raise RuntimeError("The synthetic telemetry snapshot was not received.")
        if received[0]["players"] != fixture["players"]:
            raise AssertionError("Player data changed during JSONL transport.")
        if received[0]["world"] != fixture["world"]:
            raise AssertionError("World data changed during JSONL transport.")
        monitor_snapshot = store.snapshot()
        if monitor_snapshot["server"]["players_online"] != 1:
            raise AssertionError("Live player count was not applied to monitor state.")
        if monitor_snapshot["player_analytics"]["players"][0]["uuid"] != "test-uuid":
            raise AssertionError("Live player identity was not applied to analytics.")
        if monitor_snapshot["player_analytics"]["players"][0]["appearance"]["signature"] != "test-signature":
            raise AssertionError("Live player appearance was not applied to analytics.")
        if monitor_snapshot["server_info"]["defeated_bosses"] != ["King Slime"]:
            raise AssertionError("World progression was not applied to monitor state.")
        boss_section = store.section_snapshot("bosses")
        if boss_section["boss_defeat_counts"] != {"eye-of-cthulhu": 2}:
            raise AssertionError("Repeat boss victory counts were not exposed in the boss section.")
        if boss_section["boss_status"]["calamityBosses"]["crabulon"] is not True:
            raise AssertionError("Optional mod boss status was not exposed in the boss section.")
        player_map = store.player_map("uuid:test-uuid")
        if player_map is None or player_map["worlds"]["42:telemetry-test"]["positions"][-1]["x"] != 123:
            raise AssertionError("Live player coordinates were not persisted to their world map.")
        if player_map["worlds"]["42:telemetry-test"]["visited_tiles"] != ["123,456"]:
            raise AssertionError("Visited player tile was not persisted.")
    finally:
        client.stop()
        server_thread.join(timeout=2)
        temp_dir.cleanup()

    print("PASS: synthetic telemetry JSONL received intact; no Terraria process was launched.")


if __name__ == "__main__":
    main()
