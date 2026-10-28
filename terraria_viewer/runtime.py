from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
import platform
from pathlib import Path
from typing import Any, cast

from .backend.http import ServerLogFollower, start_dashboard
from .backend.store import StatusStore
from .telemetry.stream import TelemetryStreamClient

logger = logging.getLogger("terraria_viewer")
STOP = threading.Event()


def _path(value: str | Path) -> Path:
    return Path(value).expanduser().resolve()


def _make_store(config: dict[str, Any]) -> StatusStore:
    data = _path(config["storage"]["data_dir"])
    return StatusStore(
        events_file=data / "dashboard-events.json",
        history_file=data / "monitor-history.json",
        players_file=data / "player-history.json",
        metrics_file=data / "server-metrics.json",
        avatars_dir=data / "player-avatars",
        movements_dir=data / "player-movements",
        boss_cache_dir=data / "boss-cache",
        exploration_dir=data / "world-exploration",
        npc_sprites_dir=data / "npc-sprites",
        npc_textures_dir=data / "npc-textures",
        map_sprites_dir=data / "map-sprites",
    )


def _server_command(config: dict[str, Any]) -> tuple[list[str], Path]:
    game = config["terraria"]
    game_dir = _path(game["game_dir"])
    launcher = game_dir / "start-tModLoaderServer.sh"
    world = _path(game["world"])
    if not launcher.is_file() or not os.access(launcher, os.X_OK):
        raise FileNotFoundError(f"tModLoader server launcher is unavailable: {launcher}")
    if not world.is_file():
        raise FileNotFoundError(f"Terraria world file is unavailable: {world}")
    command = [str(launcher), "-nosteam", "-world", str(world), "-port", str(game["game_port"]), "-maxplayers", str(game["max_players"]), "-secure"]
    if sys.platform == "darwin" and platform.machine() == "x86_64":
        command.insert(0, "/usr/bin/arch")
        command.insert(1, "-x86_64")
    return command, game_dir


def _read_tunnel_status(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return cast(dict[str, Any], value) if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def run_local(config: dict[str, Any], *, run_game: bool) -> int:
    server_config = config["server"]
    game_config = config["terraria"]
    store = _make_store(config)
    store.set_server_info(port=game_config["game_port"], max_players=game_config["max_players"], world=_path(game_config["world"]).stem)
    store.update(game_running=False, listener_up=False, tunnel_ready=False, game_started_at=None, tunnel_reconnecting=False)
    dashboard = start_dashboard(store, server_config["port"], config.get("site", {}), server_config["host"])
    logger.info("Viewer listening at http://%s:%s", server_config["host"], server_config["port"])
    def handle_telemetry_connection(connected: bool) -> None:
        store.set_server_info(telemetry_connected=connected)
        logger.info("Telemetry %s", "connected" if connected else "disconnected")

    telemetry = TelemetryStreamClient(
        store.set_live_telemetry,
        handle_telemetry_connection,
        host=server_config["telemetry_host"],
        port=server_config["telemetry_port"],
    )
    telemetry.start()
    game_process: subprocess.Popen[bytes] | None = None
    game_log_handle = None
    game_started = time.time() if run_game else None
    try:
        if run_game:
            command, cwd = _server_command(config)
            log_path = _path(config["terraria"]["game_dir"]) / "tModLoader-Logs" / "server.log"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_follower = ServerLogFollower(log_path)
            game_log_handle = log_path.open("a", encoding="utf-8", buffering=1)
            started_process = subprocess.Popen(
                command,
                cwd=cwd,
                stdin=subprocess.PIPE,
                stdout=game_log_handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            game_process = started_process
            logger.info("Started local tModLoader process %s; SSH tunnel is not managed here.", started_process.pid)
        else:
            log_follower = None

        tunnel_status_path = _path(config.get("tunnel_status_file", "~/Library/Application Support/TerrariaTunnel/tunnel-status.json"))
        while not STOP.is_set():
            now = time.time()
            if run_game and game_process is not None:
                alive = game_process.poll() is None
                store.update(game_running=alive, listener_up=alive, tunnel_ready=False, game_started_at=game_started)
                if log_follower is not None:
                    log_follower.read_new_errors(store)
                if not alive:
                    store.record_error("tModLoader", f"Server process exited with code {game_process.returncode}.")
                    return game_process.returncode or 1
            tunnel_status = _read_tunnel_status(tunnel_status_path)
            tunnel_updated = float(tunnel_status.get("updated_at", 0) or 0)
            tunnel_fresh = now - tunnel_updated < 30
            tunnel_ready = tunnel_fresh and tunnel_status.get("connected") is True
            store.update(
                tunnel_ready=tunnel_ready,
                game_running=game_process is not None and game_process.poll() is None,
                listener_up=game_process is not None and game_process.poll() is None,
                game_started_at=game_started,
                tunnel_reconnecting=tunnel_fresh and tunnel_status.get("reconnecting") is True,
                network_interface=tunnel_status.get("interface"),
                network_gateway=tunnel_status.get("gateway"),
                vpn_active=tunnel_status.get("tun_active") is True,
            )
            STOP.wait(1)
        return 0
    finally:
        if game_process is not None and game_process.poll() is None:
            logger.info("Stopping tModLoader gracefully to save the world.")
            try:
                os.killpg(game_process.pid, signal.SIGINT)
            except ProcessLookupError:
                pass
            try:
                game_process.wait(timeout=180)
            except subprocess.TimeoutExpired:
                logger.error("tModLoader did not stop within 180 seconds; sending SIGTERM.")
                try:
                    os.killpg(game_process.pid, signal.SIGTERM)
                    game_process.wait(timeout=15)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    pass
        telemetry.stop()
        if game_log_handle is not None:
            game_log_handle.close()
        store.update(game_running=False, listener_up=False, tunnel_ready=False, game_started_at=game_started, tunnel_reconnecting=False)
        dashboard.shutdown()
        dashboard.server_close()


def request_stop(_signum: int, _frame: object) -> None:
    STOP.set()


signal.signal(signal.SIGINT, request_stop)
signal.signal(signal.SIGTERM, request_stop)
