# Player session snapshots are persisted JSON with legacy optional fields.
# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false
from __future__ import annotations

from ...models import PlayerSnapshot

from ..store_common import (
    Any,
    StoreMixinContract,
    GAME_PORT,
    HISTORY_RETENTION_SECONDS,
    HISTORY_SAMPLE_INTERVAL,
    VPS_HOST,
    VPS_IP,
    is_valid_player_name,
    time,
)


class MonitoringMixin(StoreMixinContract):
    def set_players_online(
        self, count: int, players: list[PlayerSnapshot] | None = None, *, world: dict[str, Any] | None = None
    ) -> None:
        now = time.time()
        with self._lock:
            valid_players = [
                player for player in players or []
                if is_valid_player_name(player.name)
            ] if players is not None else None
            self._players_online = len(valid_players) if valid_players is not None else max(0, count)
            self._player_names = [player.name.strip() for player in valid_players] if valid_players is not None else None
            self._players_checked_at = now
            self._players_updated_at = now
            if valid_players is not None:
                # Discard placeholder sessions from older monitor versions;
                # they are transient Terraria connection slots, not players.
                for player_id, record in list(self._players.items()):
                    if not is_valid_player_name(record.get("name")):
                        self._players.pop(player_id, None)
                seen_ids: set[str] = set()
                for player in valid_players:
                    name = player.name.strip()[:64]
                    uuid = str(player.uuid or "").strip() or None
                    name_key = f"name:{name.casefold()}"
                    player_id = f"uuid:{uuid.casefold()}" if uuid else name_key
                    if uuid and name_key in self._players:
                        self._merge_player_movement(name_key, player_id, name, uuid)
                        old_record = self._players.pop(name_key)
                        if player_id not in self._players:
                            self._players[player_id] = old_record
                        else:
                            known_record = self._players[player_id]
                            known_record["sessions"] = sorted(
                                [*known_record.get("sessions", []), *old_record.get("sessions", [])],
                                key=lambda session: float(session.get("started_at", 0)),
                            )
                            known_record["first_seen_at"] = min(
                                float(known_record.get("first_seen_at", now)),
                                float(old_record.get("first_seen_at", now)),
                            )
                            known_record["total_seconds"] = sum(
                                float(session.get("duration_seconds", 0))
                                for session in known_record["sessions"]
                            )
                    record = self._players.setdefault(player_id, {
                        "id": player_id,
                        "name": name,
                        "uuid": uuid,
                        "first_seen_at": now,
                        "last_seen_at": now,
                        "total_seconds": 0,
                        "sessions": [],
                    })
                    record["id"] = player_id
                    record["name"] = name
                    if uuid:
                        record["uuid"] = uuid
                    if player.team is None:
                        record.pop("team", None)
                    else:
                        record["team"] = player.team
                    if player.direction is None:
                        record.pop("direction", None)
                    else:
                        record["direction"] = player.direction
                    record["teleported"] = player.teleported
                    if player.session_seconds is not None:
                        record["online_session_seconds"] = max(0, player.session_seconds)
                    appearance = player.appearance
                    if isinstance(appearance, dict):
                        # Keep every equipment slot current, but rebuild the image
                        # only when a field that affects its pixels has changed.
                        if appearance != record.get("appearance"):
                            record["appearance"] = appearance
                        render_signature = self._appearance_signature(appearance)
                        if record.get("avatar_render_signature") != render_signature:
                            record["avatar_url"] = self._write_player_sprite(player_id, name, appearance)
                            record["avatar_render_signature"] = render_signature
                    elif (
                        not str(record.get("avatar_url", "")).endswith(".png")
                        and record.get("avatar_render_signature") != self._appearance_signature(record.get("appearance", {}))
                    ):
                        record["avatar_url"] = self._write_player_sprite(
                            player_id, name, record.get("appearance", {})
                        )
                        record["avatar_render_signature"] = self._appearance_signature(record.get("appearance", {}))
                    position: tuple[int, int] | None = None
                    if player.position is not None:
                        position = (player.position.tile_x, player.position.tile_y)
                        record["position"] = {
                            **player.position.to_payload(),
                            "updated_at": now,
                        }
                    if player.velocity is not None:
                        record["velocity"] = player.velocity.to_payload()
                    else:
                        record.pop("velocity", None)
                    if position is not None:
                        self._record_player_movement(
                            player_id, name, uuid, position, world or {}, now, player.map_capture,
                            player.teleported,
                        )
                    record["last_seen_at"] = now
                    sessions = record.setdefault("sessions", [])
                    active = sessions[-1] if sessions and sessions[-1].get("ended_at") is None else None
                    if active is None:
                        try:
                            joined_at = float(player.joined_at or now)
                        except (TypeError, ValueError):
                            joined_at = now
                        try:
                            session_seconds = max(0, float(player.session_seconds or 0))
                        except (TypeError, ValueError):
                            session_seconds = 0
                        sessions.append({
                            "started_at": min(now, joined_at),
                            "last_seen_at": now,
                            "ended_at": None,
                            "duration_seconds": session_seconds,
                        })
                    else:
                        elapsed = min(max(0, now - float(active.get("last_seen_at", now))), 30)
                        active["duration_seconds"] = float(active.get("duration_seconds", 0)) + elapsed
                        active["last_seen_at"] = now
                    record["total_seconds"] = sum(float(session.get("duration_seconds", 0)) for session in sessions)
                    seen_ids.add(player_id)

                for player_id, record in self._players.items():
                    if player_id in seen_ids:
                        continue
                    sessions = record.get("sessions", [])
                    if sessions and sessions[-1].get("ended_at") is None:
                        sessions[-1]["ended_at"] = now
                        record["last_seen_at"] = sessions[-1].get("last_seen_at", now)
                self._online_player_ids = sorted(seen_ids)
                if time.monotonic() - self._players_last_saved_monotonic >= 1.0:
                    self._save_players_locked()
            self._updated_at = now

    def update(
        self,
        *,
        game_running: bool,
        listener_up: bool,
        tunnel_ready: bool,
        game_started_at: float | None,
        tunnel_reconnecting: bool = False,
        network_interface: str | None = None,
        network_gateway: str | None = None,
        vpn_active: bool = False,
    ) -> None:
        now = time.time()
        with self._lock:
            was_tunnel_ready = self._tunnel_ready
            was_game_running = self._game_running
            if was_game_running and not game_running and self._online_player_ids:
                for player_id in self._online_player_ids:
                    record = self._players.get(player_id)
                    sessions = record.get("sessions", []) if record else []
                    if sessions and sessions[-1].get("ended_at") is None:
                        sessions[-1]["ended_at"] = now
                self._online_player_ids = []
                self._players_online = 0
                self._player_names = []
                self._players_updated_at = now
                self._save_players_locked()
            if self._listener_up and not listener_up and game_running:
                self._append_event_locked(
                    "tModLoader", "Локальный слушатель TCP 7777 пропал во время работы сервера.", now
                )
                self._save_events_locked()
            if self._tunnel_ready and not tunnel_ready and game_running:
                self._append_event_locked(
                    "SSH", "Проверка SSH ControlMaster не прошла; туннель переподключается.", now
                )
                self._save_events_locked()
            self._game_running = game_running
            self._listener_up = listener_up
            self._tunnel_ready = tunnel_ready
            self._tunnel_reconnecting = tunnel_reconnecting
            self._network_interface = network_interface
            self._network_gateway = network_gateway
            self._vpn_active = vpn_active
            self._game_started_at = game_started_at
            if tunnel_ready and not was_tunnel_ready:
                self._tunnel_started_at = now
            elif not tunnel_ready:
                self._tunnel_started_at = None
            self._updated_at = now

            last_sample = float(self._history[-1]["time"]) if self._history else 0
            if now - last_sample >= HISTORY_SAMPLE_INTERVAL:
                self._history.append({
                    "time": now,
                    "game_running": game_running,
                    "listening": listener_up,
                    "tunnel_connected": tunnel_ready,
                    "tunnel_reconnecting": tunnel_reconnecting,
                    "route_available": network_interface is not None,
                    "vpn_active": vpn_active,
                    "monitor_available": True,
                    "cpu_percent": self._host_metrics.get("cpu_percent"),
                    "memory_mb": self._host_metrics.get("memory_mb"),
                    "terraria_disk_gb": self._host_metrics.get("terraria_disk_gb"),
                })
                history_cutoff = now - HISTORY_RETENTION_SECONDS
                self._history = [
                    item for item in self._history if item["time"] >= history_cutoff
                ]
                self._save_history_locked()

    def resource_history(self, days: int = 1) -> list[dict[str, Any]]:
        """Return compact CPU, RAM, and Terraria-disk samples from the last 1-7 days."""
        days = max(1, min(7, days))
        cutoff = time.time() - days * 24 * 60 * 60
        with self._lock:
            return [
                {
                    "time": item["time"],
                    "cpu_percent": item.get("cpu_percent"),
                    "memory_mb": item.get("memory_mb"),
                    "terraria_disk_gb": item.get("terraria_disk_gb"),
                }
                for item in self._history if item.get("time", 0) >= cutoff
            ]

    def snapshot(self) -> dict[str, Any]:
        now = time.time()
        with self._lock:
            events = list(self._events)
            history = list(self._history)
            game_running = self._game_running
            listener_up = self._listener_up
            tunnel_ready = self._tunnel_ready
            tunnel_reconnecting = self._tunnel_reconnecting
            network_interface = self._network_interface
            network_gateway = self._network_gateway
            vpn_active = self._vpn_active
            game_started_at = self._game_started_at
            tunnel_started_at = self._tunnel_started_at
            updated_at = self._updated_at
            players_online = self._players_online
            player_names = self._player_names
            players_checked_at = self._players_checked_at
            players = [
                {
                    **record,
                    "sessions": [dict(session) for session in record.get("sessions", [])],
                }
                for record in self._players.values()
            ]
            online_player_ids = list(self._online_player_ids)
            players_updated_at = self._players_updated_at
            server_info = dict(self._server_info)
            host_metrics = dict(self._host_metrics)

        cutoff = now - 24 * 60 * 60
        events = [event for event in events if event["time"] >= cutoff]
        history = [item for item in history if item["time"] >= cutoff]
        return {
            "updated_at": now,
            "state_updated_at": updated_at,
            "server": {
                "running": game_running,
                "listening": listener_up,
                "started_at": game_started_at,
                "uptime_seconds": max(0, now - game_started_at) if game_running and game_started_at else 0,
                "players_online": players_online,
                "player_names": player_names,
                "players_checked_at": players_checked_at,
            },
            "tunnel": {
                "connected": tunnel_ready,
                "reconnecting": tunnel_reconnecting,
                "connected_since": tunnel_started_at,
                "uptime_seconds": max(0, now - tunnel_started_at) if tunnel_ready and tunnel_started_at else 0,
            },
            "network": {
                "interface": network_interface,
                "gateway": network_gateway,
                "route_available": network_interface is not None,
                "vpn_active": vpn_active,
            },
            "connection": {
                "hostname": VPS_HOST,
                "ip": VPS_IP,
                "game_port": GAME_PORT,
                "game_address": f"{VPS_HOST}:{GAME_PORT}",
                "dashboard_url": f"https://{VPS_HOST}/",
                "external_game_port_verified": False,
            },
            "errors": events,
            "history": history,
            "player_analytics": {
                "players": players,
                "online_player_ids": online_player_ids,
                "updated_at": players_updated_at,
                "identity_note": "Ник используется как идентификатор, если UUID недоступен из ответа игрового сервера.",
            },
            "server_info": server_info,
            "host_metrics": host_metrics,
            "history_retained_days": 7,
        }

    def sidebar_snapshot(self) -> dict[str, Any]:
        """Small live status payload for the map drawer; avoid sending history and player sessions."""
        now = time.time()
        with self._lock:
            server_info = self._server_info
            return {
                "updated_at": now,
                "server": {
                    "running": self._game_running,
                    "listening": self._listener_up,
                    "players_online": self._players_online,
                    "player_names": list(self._player_names or []),
                    "players_checked_at": self._players_checked_at,
                },
                "tunnel": {
                    "connected": self._tunnel_ready,
                    "reconnecting": self._tunnel_reconnecting,
                },
                "server_info": {
                    key: server_info.get(key)
                    for key in (
                        "world", "world_width", "world_height", "version",
                        "telemetry_connected", "telemetry_updated_at", "map_scan",
                        "active_bosses", "boss_defeat_counts",
                    )
                },
                "host_metrics": {
                    key: self._host_metrics.get(key)
                    for key in ("cpu_percent", "memory_mb", "terraria_disk_gb", "updated_at")
                },
            }

    def section_snapshot(self, section: str) -> dict[str, Any]:
        """Build only the requested tab payload instead of serializing full history for every view."""
        now = time.time()
        if section == "world":
            return {"section": section, "updated_at": now, "world_map": self.world_map_summary()}
        with self._lock:
            if section == "players":
                players = []
                for player in self._players.values():
                    players.append({
                        key: player.get(key)
                        for key in (
                            "id", "name", "uuid", "first_seen_at", "last_seen_at",
                            "total_seconds", "avatar_url", "deaths", "pvp_deaths",
                        )
                    } | {
                        "sessions": [dict(session) for session in player.get("sessions", [])],
                    })
                return {
                    "section": section,
                    "updated_at": now,
                    "online": {
                        "count": self._players_online,
                        "names": list(self._player_names or []),
                        "checked_at": self._players_checked_at,
                        "ids": list(self._online_player_ids),
                    },
                    "players": players,
                }

            if section == "bosses":
                keys = (
                    "boss_status", "active_bosses", "defeated_bosses", "boss_defeat_counts",
                    "game_mode", "crimson", "hardmode", "version", "world",
                )
                return {
                    "section": section,
                    "updated_at": now,
                    "server_info": {key: self._server_info.get(key) for key in keys},
                }

            if section == "server":
                server_info_keys = (
                    "world", "world_width", "world_height", "version", "telemetry_connected",
                    "telemetry_updated_at", "boss_status", "active_bosses", "defeated_bosses",
                    "boss_defeat_counts", "game_mode", "crimson", "hardmode", "day",
                    "world_time", "game_time",
                )
                return {
                    "section": section,
                    "updated_at": now,
                    "server": {
                        "running": self._game_running,
                        "listening": self._listener_up,
                        "started_at": self._game_started_at,
                        "uptime_seconds": max(0, now - self._game_started_at) if self._game_running and self._game_started_at else 0,
                        "players_online": self._players_online,
                        "player_names": list(self._player_names or []),
                        "players_checked_at": self._players_checked_at,
                    },
                    "tunnel": {
                        "connected": self._tunnel_ready,
                        "reconnecting": self._tunnel_reconnecting,
                        "connected_since": self._tunnel_started_at,
                    },
                    "network": {
                        "interface": self._network_interface,
                        "gateway": self._network_gateway,
                        "route_available": self._network_interface is not None,
                        "vpn_active": self._vpn_active,
                    },
                    "server_info": {key: self._server_info.get(key) for key in server_info_keys},
                    "host_metrics": dict(self._host_metrics),
                    "connection": {
                        "hostname": VPS_HOST,
                        "ip": VPS_IP,
                        "game_port": GAME_PORT,
                        "game_address": f"{VPS_HOST}:{GAME_PORT}",
                        "dashboard_url": f"https://{VPS_HOST}/",
                    },
                }

            if section == "activity":
                cutoff = now - 24 * 60 * 60
                return {
                    "section": section,
                    "updated_at": now,
                    "events": [dict(event) for event in self._events if event.get("time", 0) >= cutoff],
                    "health": [dict(sample) for sample in self._history if sample.get("time", 0) >= cutoff],
                    "host_metrics": dict(self._host_metrics),
                }

        raise ValueError("Unknown data section")
