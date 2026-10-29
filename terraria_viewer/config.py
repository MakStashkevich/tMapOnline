from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any, cast

import yaml


DEFAULT_CONFIG: dict[str, Any] = {
    "version": 1,
    "server": {"host": "127.0.0.1", "port": 8765, "telemetry_host": "127.0.0.1", "telemetry_port": 38762},
    "terraria": {
        "game_dir": "~/Library/Application Support/Steam/steamapps/common/tModLoader",
        "world": "~/Library/Application Support/Terraria/tModLoader/Worlds/calamity2.wld",
        "game_port": 7777,
        "max_players": 8,
    },
    "storage": {
        "data_dir": "~/Library/Application Support/TerrariaTunnel",
        "death_retention_seconds": 3600,
    },
    # Each category has its own cadence in Terraria server ticks.
    "telemetry": {
        "player_position_interval_ticks": 6,
        "entity_interval_ticks": 6,
        "map_capture_interval_ticks": 30,
        "map_tile_update_interval_ticks": 1,
        "world_scan_interval_ticks": 1,
        "browser_live_poll_interval_ms": 50,
        "browser_map_poll_interval_ms": 5000,
        "browser_debug_poll_interval_ms": 1000,
    },
    "tunnel_status_file": "~/Library/Application Support/TerrariaTunnel/tunnel-status.json",
    "site": {
        "pages": {
            "world_map": {"enabled": True},
        },
        "sections": {
            "world": True,
            "players": True,
            "bosses": True,
            "server": True,
            "activity": True,
        },
        "modules": {
            "world_map.exploration": True,
            "world_map.routes": True,
            "world_map.players": True,
            "world_map.entities": True,
            "world_map.coins": True,
            "world_map.pylons": True,
            "world_map.spawn": True,
            "world_map.tooltips": True,
            "world_map.debug": True,
        },
    },
}


def _merge(defaults: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(defaults)
    for key, value in user.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge(
                cast(dict[str, Any], result[key]),
                cast(dict[str, Any], value),
            )
        else:
            result[key] = value
    return result


def load_config(path: str | Path) -> dict[str, Any]:
    config_path = Path(path).expanduser().resolve()
    if not config_path.exists():
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(yaml.safe_dump(DEFAULT_CONFIG, allow_unicode=True, sort_keys=False), encoding="utf-8")
        return deepcopy(DEFAULT_CONFIG)
    loaded: Any = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    if not isinstance(loaded, dict):
        raise ValueError(f"Configuration root must be a mapping: {config_path}")
    config = _merge(DEFAULT_CONFIG, cast(dict[str, Any], loaded))
    if config.get("version") != 1:
        raise ValueError(f"Unsupported configuration version: {config.get('version')!r}")
    for key in ("port", "telemetry_port"):
        value = config["server"].get(key)
        if not isinstance(value, int) or not 1 <= value <= 65535:
            raise ValueError(f"server.{key} must be an integer from 1 to 65535")
    death_retention = config["storage"].get("death_retention_seconds")
    if type(death_retention) is not int or death_retention < 0:
        raise ValueError("storage.death_retention_seconds must be a non-negative integer")
    for key in (
        "player_position_interval_ticks",
        "entity_interval_ticks",
        "map_capture_interval_ticks",
        "map_tile_update_interval_ticks",
        "world_scan_interval_ticks",
    ):
        value = config["telemetry"].get(key)
        if type(value) is not int or value < 1:
            raise ValueError(f"telemetry.{key} must be a positive integer")
    for key in (
        "browser_live_poll_interval_ms",
        "browser_map_poll_interval_ms",
        "browser_debug_poll_interval_ms",
    ):
        interval = config["telemetry"].get(key)
        minimum = 50 if key == "browser_live_poll_interval_ms" else 100
        if type(interval) is not int or not minimum <= interval <= 30000:
            raise ValueError(
                f"telemetry.{key} must be an integer from {minimum} to 30000"
            )
    return config


def page_enabled(config: dict[str, Any], page: str) -> bool:
    return config.get("site", {}).get("pages", {}).get(page, {}).get("enabled", True) is True


def site_config_enabled(config: dict[str, Any], page: str, module: str | None = None) -> bool:
    if not page_enabled(config, page):
        return False
    if module is None:
        return True
    return config.get("site", {}).get("modules", {}).get(module, True) is True
