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

SERVER_STARTUP_TIMEOUT_SECONDS = 180
SERVER_LISTENER_LOSS_GRACE_SECONDS = 15
SERVER_HEALTHY_RESET_SECONDS = 60
SERVER_RESTART_BACKOFF_SECONDS = (5, 10, 20, 40, 60)


def _path(value: str | Path) -> Path:
    return Path(value).expanduser().resolve()


def _make_store(config: dict[str, Any]) -> StatusStore:
    data = _path(config["storage"]["data_dir"])
    store = StatusStore(
        events_file=data / "dashboard-events.json",
        history_file=data / "monitor-history.json",
        players_file=data / "player-history.json",
        metrics_file=data / "server-metrics.json",
        avatars_dir=data / "player-avatars",
        movements_dir=data / "player-movements",
        exploration_dir=data / "world-exploration",
        npc_sprites_dir=data / "npc-sprites",
        npc_textures_dir=data / "npc-textures",
        map_sprites_dir=data / "map-sprites",
        death_retention_seconds=config["storage"]["death_retention_seconds"],
        event_retention_seconds=config["storage"]["event_retention_seconds"],
        event_max_entries=config["storage"]["event_max_entries"],
    )
    store.set_server_info(
        telemetry_intervals={
            key: value
            for key, value in config["telemetry"].items()
        }
    )
    return store


def _server_command(config: dict[str, Any]) -> tuple[list[str], Path]:
    game = config["terraria"]
    game_dir = _path(game["game_dir"])
    launcher = game_dir / "LaunchUtils" / "ScriptCaller.sh"
    world = _path(game["world"])
    if not launcher.is_file() or not os.access(launcher, os.X_OK):
        raise FileNotFoundError(f"tModLoader launch script is unavailable: {launcher}")
    if not world.is_file():
        raise FileNotFoundError(f"Terraria world file is unavailable: {world}")
    command = [
        str(launcher),
        "-server",
        "-world",
        str(world),
        "-port",
        str(game["game_port"]),
        "-maxplayers",
        str(game["max_players"]),
        "-config",
        "serverconfig.txt",
    ]
    if sys.platform == "darwin" and platform.machine() in {"arm64", "x86_64"}:
        # The current tModLoader server bundle is x86_64 even when Viewer runs natively on Apple Silicon.
        command.insert(0, "/usr/bin/arch")
        command.insert(1, "-x86_64")
    return command, game_dir


def _read_tunnel_status(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return cast(dict[str, Any], value) if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _game_listener_is_open(port: int) -> bool:
    """Check the listening socket without opening a game connection."""
    try:
        result = subprocess.run(
            ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
            capture_output=True,
            check=False,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired):
        logger.exception("Could not inspect the Terraria listening port %s.", port)
        return False
    return result.returncode == 0 and bool(result.stdout.strip())


def _start_game_process(
    config: dict[str, Any], cwd: Path, log_handle: Any
) -> subprocess.Popen[bytes]:
    command, _ = _server_command(config)
    return subprocess.Popen(
        command,
        cwd=cwd,
        stdin=subprocess.PIPE,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        env={
            **os.environ,
            "TERRARIA_TELEMETRY_PLAYER_POSITION_INTERVAL_TICKS": str(
                config["telemetry"]["player_position_interval_ticks"]
            ),
            "TERRARIA_TELEMETRY_ENTITY_INTERVAL_TICKS": str(
                config["telemetry"]["entity_interval_ticks"]
            ),
            "TERRARIA_TELEMETRY_MAP_CAPTURE_INTERVAL_TICKS": str(
                config["telemetry"]["map_capture_interval_ticks"]
            ),
            "TERRARIA_TELEMETRY_MAP_TILE_UPDATE_INTERVAL_TICKS": str(
                config["telemetry"]["map_tile_update_interval_ticks"]
            ),
            "TERRARIA_TELEMETRY_MAP_PINGS_FROM_PLAYERS_TO_WEB": str(
                config["telemetry"]["map_pings_from_players_to_web"]
            ).lower(),
            "TERRARIA_TELEMETRY_MAP_PINGS_FROM_WEB_TO_PLAYERS": str(
                config["telemetry"]["map_pings_from_web_to_players"]
            ).lower(),
            "TERRARIA_TELEMETRY_INITIAL_WORLD_SCAN_ENABLED": str(
                config["telemetry"]["initial_world_scan_enabled"]
            ).lower(),
            "TERRARIA_TELEMETRY_WORLD_SCAN_INTERVAL_TICKS": str(
                config["telemetry"]["world_scan_interval_ticks"]
            ),
            "TERRARIA_TELEMETRY_DEATH_RETENTION_SECONDS": str(
                config["storage"]["death_retention_seconds"]
            ),
        },
    )


def _stop_game_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return

    logger.info("Stopping tModLoader gracefully so it can save the world.")
    try:
        os.killpg(process.pid, signal.SIGINT)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=90)
        return
    except subprocess.TimeoutExpired:
        logger.error("tModLoader did not stop within 90 seconds; sending SIGTERM.")

    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=15)
    except ProcessLookupError:
        return
    except subprocess.TimeoutExpired:
        logger.critical("tModLoader ignored SIGTERM; sending SIGKILL as a last resort.")
        try:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            logger.exception("Could not fully stop the failed tModLoader process.")


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
    dashboard.RequestHandlerClass.map_ping_sender = (
        telemetry.send_map_ping
        if config["telemetry"]["map_pings_from_web_to_players"]
        else None
    )
    telemetry.start()
    game_process: subprocess.Popen[bytes] | None = None
    game_log_handle = None
    game_started = time.time() if run_game else None
    launch_time = time.monotonic()
    listener_missing_since: float | None = None
    listener_healthy_since: float | None = None
    listener_was_ready = False
    restart_attempt = 0
    game_cwd = _path(game_config["game_dir"])
    try:
        if run_game:
            _server_command(config)
            log_path = _path(config["terraria"]["game_dir"]) / "tModLoader-Logs" / "server.log"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_follower = ServerLogFollower(log_path)
            game_log_handle = log_path.open("a", encoding="utf-8", buffering=1)
            try:
                game_process = _start_game_process(config, game_cwd, game_log_handle)
            except OSError as error:
                store.record_error("tModLoader", f"Initial server launch failed: {error}")
                logger.exception("Initial tModLoader launch failed; automatic retry is enabled.")
            else:
                logger.info(
                    "Started local tModLoader process %s; waiting for TCP port %s. SSH tunnel is not managed here.",
                    game_process.pid,
                    game_config["game_port"],
                )
        else:
            log_follower = None

        tunnel_status_path = _path(config.get("tunnel_status_file", "~/Library/Application Support/TerrariaTunnel/tunnel-status.json"))
        while not STOP.is_set():
            now = time.time()
            monotonic_now = time.monotonic()
            listener_up = _game_listener_is_open(game_config["game_port"])

            if run_game and game_process is not None:
                if log_follower is not None:
                    log_follower.read_new_errors(store)

                process_alive = game_process.poll() is None
                if listener_up:
                    listener_missing_since = None
                    if listener_healthy_since is None:
                        listener_healthy_since = monotonic_now
                    if not listener_was_ready:
                        logger.info("Terraria game port %s is listening.", game_config["game_port"])
                    listener_was_ready = True
                    if monotonic_now - listener_healthy_since >= SERVER_HEALTHY_RESET_SECONDS:
                        restart_attempt = 0
                else:
                    listener_healthy_since = None
                    if listener_missing_since is None:
                        listener_missing_since = monotonic_now

                startup_expired = (
                    not listener_was_ready
                    and monotonic_now - launch_time >= SERVER_STARTUP_TIMEOUT_SECONDS
                )
                listener_lost = (
                    listener_was_ready
                    and listener_missing_since is not None
                    and monotonic_now - listener_missing_since
                    >= SERVER_LISTENER_LOSS_GRACE_SECONDS
                )

                if not process_alive or startup_expired or listener_lost:
                    if not process_alive:
                        reason = f"process exited with code {game_process.returncode}"
                    elif startup_expired:
                        reason = (
                            f"TCP port {game_config['game_port']} did not start listening "
                            f"within {SERVER_STARTUP_TIMEOUT_SECONDS} seconds"
                        )
                    else:
                        reason = (
                            f"TCP port {game_config['game_port']} stopped listening for "
                            f"{SERVER_LISTENER_LOSS_GRACE_SECONDS} seconds"
                        )

                    logger.error("tModLoader is unhealthy: %s. Restarting it.", reason)
                    store.record_error("tModLoader", f"{reason}; automatic restart scheduled.")
                    _stop_game_process(game_process)

                    if STOP.is_set():
                        break

                    backoff_index = min(restart_attempt, len(SERVER_RESTART_BACKOFF_SECONDS) - 1)
                    delay = SERVER_RESTART_BACKOFF_SECONDS[backoff_index]
                    restart_attempt += 1
                    logger.warning("Retrying tModLoader in %s seconds (attempt %s).", delay, restart_attempt)
                    if STOP.wait(delay):
                        break

                    try:
                        game_process = _start_game_process(config, game_cwd, game_log_handle)
                    except OSError as error:
                        game_process = None
                        store.record_error("tModLoader", f"Automatic restart failed: {error}")
                        logger.exception("Could not start tModLoader; it will be retried.")
                        launch_time = time.monotonic() - SERVER_STARTUP_TIMEOUT_SECONDS
                    else:
                        launch_time = time.monotonic()
                        logger.info("Restarted local tModLoader process %s.", game_process.pid)
                    listener_missing_since = None
                    listener_healthy_since = None
                    listener_was_ready = False
                    continue

                store.update(
                    game_running=process_alive,
                    listener_up=listener_up,
                    tunnel_ready=False,
                    game_started_at=game_started,
                )

            elif run_game and game_process is None:
                backoff_index = min(restart_attempt, len(SERVER_RESTART_BACKOFF_SECONDS) - 1)
                delay = SERVER_RESTART_BACKOFF_SECONDS[backoff_index]
                restart_attempt += 1
                logger.warning("Retrying unavailable tModLoader launch in %s seconds.", delay)
                if STOP.wait(delay):
                    break
                try:
                    game_process = _start_game_process(config, game_cwd, game_log_handle)
                except OSError as error:
                    store.record_error("tModLoader", f"Automatic restart failed: {error}")
                    logger.exception("Could not start tModLoader; it will be retried.")
                else:
                    launch_time = time.monotonic()
                    listener_missing_since = None
                    listener_healthy_since = None
                    listener_was_ready = False
                    logger.info("Restarted local tModLoader process %s.", game_process.pid)
                continue

            tunnel_status = _read_tunnel_status(tunnel_status_path)
            tunnel_updated = float(tunnel_status.get("updated_at", 0) or 0)
            tunnel_fresh = now - tunnel_updated < 30
            tunnel_ready = tunnel_fresh and tunnel_status.get("connected") is True
            store.update(
                tunnel_ready=tunnel_ready,
                game_running=game_process is not None and game_process.poll() is None,
                listener_up=listener_up,
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
            _stop_game_process(game_process)
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
