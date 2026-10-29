# Map cache payloads retain backwards-compatible JSON shapes and are validated at read sites.
# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false
from __future__ import annotations

import urllib.parse
import math

from ..store_common import (
    Any,
    WORLD_MAP_CHUNK_SIZE,
    as_json_object,
    StoreMixinContract,
    decode_player_map,
    draw_route_mask,
    encode_player_map_rows,
    read_map_mask_png,
    union_map_masks,
    base64,
    hashlib,
    re,
    struct,
    time,
    zlib,
)


def _compact_positions(points: list[Any]) -> list[dict[str, Any]]:
    """Reduce redundant straight-path samples without changing the visible route."""
    normalized = [point for point in points if isinstance(point, dict)]
    if len(normalized) < 3:
        return [dict(point) for point in normalized]

    kept_indices = {0, len(normalized) - 1}
    anchors = [0]
    anchors.extend(
        index for index, point in enumerate(normalized[1:-1], 1)
        if point.get("teleport") is True
    )
    anchors.append(len(normalized) - 1)
    anchors = sorted(set(anchors))

    for anchor_index in range(len(anchors) - 1):
        start, end = anchors[anchor_index], anchors[anchor_index + 1]
        pending = [(start, end)]
        while pending:
            segment_start, segment_end = pending.pop()
            if segment_end - segment_start < 2:
                continue
            first, last = normalized[segment_start], normalized[segment_end]
            try:
                first_x, first_y = float(first["x"]), float(first["y"])
                last_x, last_y = float(last["x"]), float(last["y"])
                first_time = float(first.get("time", 0) or 0)
                last_time = float(last.get("time", 0) or 0)
            except (KeyError, TypeError, ValueError, OverflowError):
                split = (segment_start + segment_end) // 2
                kept_indices.add(split)
                pending.extend(((segment_start, split), (split, segment_end)))
                continue

            distance = math.hypot(last_x - first_x, last_y - first_y)
            if distance > 24 or last_time - first_time > 15:
                split = (segment_start + segment_end) // 2
                kept_indices.add(split)
                pending.extend(((segment_start, split), (split, segment_end)))
                continue

            dx, dy = last_x - first_x, last_y - first_y
            length_squared = dx * dx + dy * dy
            greatest_error = 2.0
            split_index = -1
            for index in range(segment_start + 1, segment_end):
                point = normalized[index]
                try:
                    x, y = float(point["x"]), float(point["y"])
                except (KeyError, TypeError, ValueError, OverflowError):
                    split_index = index
                    break
                if length_squared == 0:
                    error = math.hypot(x - first_x, y - first_y)
                else:
                    progress = max(0.0, min(1.0, ((x - first_x) * dx + (y - first_y) * dy) / length_squared))
                    error = math.hypot(x - (first_x + progress * dx), y - (first_y + progress * dy))
                if error > greatest_error:
                    greatest_error = error
                    split_index = index

            if split_index >= 0:
                kept_indices.add(split_index)
                pending.extend(((segment_start, split_index), (split_index, segment_end)))

    return [dict(normalized[index]) for index in sorted(kept_indices)]


def _positions_after(points: list[Any], timestamp: float) -> list[dict[str, Any]]:
    """Read only new movement samples from the append-only position history."""
    result: list[dict[str, Any]] = []
    for point in reversed(points):
        if not isinstance(point, dict):
            continue
        try:
            point_time = float(point.get("time", 0) or 0)
        except (TypeError, ValueError, OverflowError):
            continue
        if point_time <= timestamp:
            break
        result.append(dict(point))
    result.reverse()
    return result


class WorldMapMixin(StoreMixinContract):
    def world_map_summary(self) -> dict[str, Any]:
        """Compact current-world counters for the on-demand map-data view."""
        with self._lock:
            world_id = self._server_info.get("world_id")
            world_name = str(self._server_info.get("world") or "")
            width = self._server_info.get("world_width")
            height = self._server_info.get("world_height")
            pylons: list[dict[str, Any]] = []
            for cache in self._world_map_cache.values():
                if world_id is not None and str(cache.get("world_id")) != str(world_id):
                    continue
                if world_name and str(cache.get("world_name") or "").casefold() != world_name.casefold():
                    continue
                width = cache.get("width", width)
                height = cache.get("height", height)
                if isinstance(cache.get("pylons"), list):
                    pylons = [item for item in cache["pylons"] if isinstance(item, dict)]
                break
            scan = self._server_info.get("map_scan")
            age = None if self._telemetry_received_at is None else max(0, time.time() - self._telemetry_received_at)
            entities = len(self._active_npcs) if age is not None and age <= 5 else 0
            coins = len(self._active_coins) if age is not None and age <= 5 else 0
            return {
                "world": {"id": world_id, "name": world_name or None, "width": width, "height": height},
                "scan": dict(scan) if isinstance(scan, dict) else None,
                "pylons": len(pylons),
                "entities": entities,
                "coins": coins,
                "updated_at": self._telemetry_received_at,
            }

    def player_map(self, player_id: str) -> dict[str, Any] | None:
        with self._lock:
            record = self._players.get(player_id)
            if record is None:
                return None
            movement = self._load_movement(player_id)
            return {
                "id": player_id,
                "name": record.get("name"),
                "avatar_url": record.get("avatar_url"),
                "worlds": {
                    key: {
                        **{field: value for field, value in world.items() if field not in {"visited_tiles", "positions"}},
                        "visited_tiles": list(world.get("visited_tiles", [])),
                        "positions": [dict(point) for point in world.get("positions", []) if isinstance(point, dict)],
                    }
                    for key, world in as_json_object(movement.get("worlds")).items()
                },
            }

    def world_map(
        self,
        world_id: str | None = None,
        since: float = 0,
        live_since: float = 0,
        include_chunks: bool = True,
    ) -> dict[str, Any]:
        with self._lock:
            active_id = self._server_info.get("world_id")
            requested = str(world_id if world_id not in (None, "") else active_id or "")
            active_name = str(self._server_info.get("world") or "")
            players = []
            death_markers = []
            online_player_ids = set(self._online_player_ids)
            telemetry_age = None if self._telemetry_received_at is None else max(0, time.time() - self._telemetry_received_at)
            active_npcs_fresh = (
                telemetry_age is not None
                and telemetry_age <= 5
                and self._active_npcs_world_id in {str(active_id), active_name}
                and (not requested or requested in {self._active_npcs_world_id, active_name})
            )
            active_npcs = []
            if active_npcs_fresh:
                active_npcs = [item.to_payload() for item in self._active_npcs]
            active_coins = []
            if telemetry_age is not None and telemetry_age <= 5 and self._active_coins_world_id in {str(active_id), active_name}:
                if not requested or requested in {self._active_coins_world_id, active_name}:
                    active_coins = [item.to_payload() for item in self._active_coins]
            selected_world: dict[str, Any] | None = None
            base_chunks_raw: dict[str, Any] = {}
            base_chunk_times: dict[str, Any] = {}
            pylons: list[dict[str, Any]] = []
            map_updated_at = 0.0
            tile_info_updated_at = 0.0
            for world_cache in self._world_map_cache.values():
                stored_id = world_cache.get("world_id")
                name = str(world_cache.get("world_name") or "")
                if requested and requested not in {str(stored_id or ""), name}:
                    continue
                if not requested and active_name and name.casefold() != active_name.casefold():
                    continue
                selected_world = world_cache
                if isinstance(world_cache.get("pylons"), list):
                    pylons = [item for item in world_cache["pylons"] if isinstance(item, dict)]
                if include_chunks and isinstance(world_cache.get("base_map_chunks"), dict):
                    base_chunks_raw.update(world_cache["base_map_chunks"])
                if isinstance(world_cache.get("base_map_chunk_times"), dict):
                    base_chunk_times.update(world_cache["base_map_chunk_times"])
                try:
                    tile_info_updated_at = max(tile_info_updated_at, float(world_cache.get("tile_info_updated_at", 0)))
                except (TypeError, ValueError):
                    pass
                try:
                    map_updated_at = max(map_updated_at, float(world_cache.get("map_updated_at", 0)))
                except (TypeError, ValueError):
                    pass
            for player_id, record in self._players.items():
                for death in record.get("death_locations", []):
                    if not isinstance(death, dict):
                        continue
                    death_world_id = str(death.get("world_id") or "")
                    death_world_name = str(death.get("world_name") or "")
                    if requested and requested not in {death_world_id, death_world_name}:
                        continue
                    death_markers.append({
                        "id": f"{player_id}:{death.get('timestamp', 0)}",
                        "player_id": player_id,
                        "name": record.get("name"),
                        "x": death.get("x"),
                        "y": death.get("y"),
                        "timestamp": death.get("timestamp"),
                    })
                movement = self._load_movement(player_id)
                for key, world in as_json_object(movement.get("worlds")).items():
                    stored_id = world.get("world_id")
                    name = str(world.get("world_name") or "")
                    if requested and requested not in {str(key), str(stored_id or ""), name}:
                        continue
                    if not requested and active_name and name.casefold() != active_name.casefold():
                        continue
                    selected_world = selected_world or world
                    # Read earlier per-player caches for backward compatibility.
                    if include_chunks:
                        base_chunks_raw.update(world.get("base_map_chunks", {}) if isinstance(world.get("base_map_chunks"), dict) else {})
                    base_chunk_times.update(world.get("base_map_chunk_times", {}) if isinstance(world.get("base_map_chunk_times"), dict) else {})
                    for stamp in world.get("base_map_chunk_times", {}).values() if isinstance(world.get("base_map_chunk_times"), dict) else ():
                        try:
                            map_updated_at = max(map_updated_at, float(stamp))
                        except (TypeError, ValueError):
                            pass
                    try:
                        map_updated_at = max(map_updated_at, float(world.get("map_updated_at", 0)))
                    except (TypeError, ValueError):
                        pass
                    try:
                        tile_info_updated_at = max(tile_info_updated_at, float(world.get("tile_info_updated_at", 0)))
                    except (TypeError, ValueError):
                        pass
                    chunks = []
                    if include_chunks:
                        raw_chunks = as_json_object(world.get("map_chunks"))
                        for chunk_key, data in raw_chunks.items():
                            try:
                                chunk_x, chunk_y = (int(value) for value in str(chunk_key).split(",", 1))
                            except (TypeError, ValueError):
                                continue
                            chunks.append({"x": chunk_x, "y": chunk_y, "data": data})
                    exploration = world.get("map_exploration")
                    expected_exploration_filename = f"{stored_id}-{hashlib.sha256(player_id.encode('utf-8')).hexdigest()[:32]}.png"
                    has_imported_map = (
                        isinstance(exploration, dict)
                        and exploration.get("filename") == expected_exploration_filename
                        and (self._exploration_dir / expected_exploration_filename).is_file()
                    )
                    is_online = player_id in online_player_ids
                    active_session = None
                    sessions = record.get("sessions", [])
                    if sessions and sessions[-1].get("ended_at") is None:
                        active_session = sessions[-1]
                    session_seconds = record.get("online_session_seconds")
                    if session_seconds is None and active_session is not None:
                        session_seconds = active_session.get("duration_seconds")
                    raw_positions = world.get("positions", [])
                    if live_since <= 0:
                        positions = _compact_positions(raw_positions)
                    else:
                        positions = _positions_after(raw_positions, live_since)
                    players.append({
                        "id": player_id,
                        "name": record.get("name"),
                        "avatar_url": record.get("avatar_url"),
                        "online": is_online,
                        "team": record.get("team") if is_online else None,
                        "direction": record.get("direction") if is_online else None,
                        "velocity": record.get("velocity") if is_online else None,
                        "teleported": record.get("teleported", False) if is_online else False,
                        "session_seconds": session_seconds if is_online else None,
                        "position": record.get("position"),
                        "positions": positions,
                        "chunks": chunks,
                        "has_imported_map": has_imported_map,
                        "can_export_map": (
                            bool(world.get("positions") or world.get("visited_tiles") or has_imported_map)
                            and stored_id is not None
                            and (self._exploration_dir / f"{stored_id}.header").is_file()
                        ),
                        "exploration_url": (
                            f"/api/world-map/exploration?id={urllib.parse.quote(player_id, safe='')}&world={urllib.parse.quote(str(stored_id or ''), safe='')}&v={int(float(world['map_exploration'].get('updated_at', 0)) * 1000)}"
                            if isinstance(world.get("map_exploration"), dict) else None
                        ),
                    })
            selected_world = selected_world or {}
            map_revision = int(selected_world.get("map_tile_revision", 0) or 0)
            scan = self._server_info.get("map_scan")
            if isinstance(scan, dict) and requested and str(scan.get("worldId")) != requested:
                scan = None
            elif isinstance(scan, dict):
                scan = dict(scan)
                telemetry_age = None if self._telemetry_received_at is None else max(0, int(time.time() - self._telemetry_received_at))
                scan["telemetryAgeSeconds"] = telemetry_age
                if not self._game_running or telemetry_age is None or telemetry_age > 5:
                    scan["active"] = False
                    scan["stale"] = True
            return {
                "world": {
                    "id": selected_world.get("world_id", active_id),
                    "name": selected_world.get("world_name", active_name),
                    "width": selected_world.get("width", self._server_info.get("world_width")),
                    "height": selected_world.get("height", self._server_info.get("world_height")),
                    "surface_y": selected_world.get("surface_y", self._server_info.get("world_surface")),
                    "spawn_x": selected_world.get("spawn_x"),
                    "spawn_y": selected_world.get("spawn_y"),
                },
                "chunk_size": WORLD_MAP_CHUNK_SIZE,
                "base_chunks": [
                    {"x": int(key.split(",", 1)[0]), "y": int(key.split(",", 1)[1]), "data": value}
                    for key, value in base_chunks_raw.items()
                    if since <= 0 or float(base_chunk_times.get(key, 0)) > since
                ],
                "players": players,
                "deaths": death_markers,
                "active_npcs": active_npcs,
                "active_npcs_fresh": active_npcs_fresh,
                "coins": active_coins,
                "pylons": pylons,
                "scan": scan,
                "updated_at": map_updated_at,
                "tile_info_updated_at": tile_info_updated_at,
                "map_revision": map_revision,
                "map_version": max(map_revision, int(map_updated_at * 1000)),
                "tile_cache": self._map_tile_pyramid.get_metrics(),
                "telemetry": {
                    "snapshot_id": self._telemetry_snapshot_id,
                    "received_at": self._telemetry_received_at,
                    "age_seconds": telemetry_age,
                    "interval_ms": self._telemetry_interval_ms,
                    "configured_intervals": dict(self._server_info.get("telemetry_intervals", {})),
                },
            }

    def world_map_image_tile(
        self, world_id: str | None, level: int, tile_x: int, tile_y: int
    ) -> tuple[bytes, int] | None:
        """Compose one visible pyramid tile without serializing the entire map."""
        with self._lock:
            active_id = str(self._server_info.get("world_id") or "")
            active_name = str(self._server_info.get("world") or "")
            requested = str(world_id or active_id)
            matching_caches = [
                cache
                for cache in self._world_map_cache.values()
                if requested in {
                    str(cache.get("world_id") or ""),
                    str(cache.get("world_name") or ""),
                }
            ]
            matching_worlds: list[dict[str, Any]] = []
            for player_id in self._players:
                movement = self._load_movement(player_id)
                for key, world in as_json_object(movement.get("worlds")).items():
                    if requested in {str(key), str(world.get("world_id") or ""), str(world.get("world_name") or "")}:
                        matching_worlds.append(world)

            candidates: list[dict[str, Any]] = [*matching_caches, *matching_worlds]
            if not candidates and requested not in {active_id, active_name}:
                return None

            selected = candidates[0] if candidates else {}
            width = int(selected.get("width") or self._server_info.get("world_width") or 0)
            height = int(selected.get("height") or self._server_info.get("world_height") or 0)
            if width < 1 or height < 1:
                return None
            factor = 1 << max(0, min(level, 8))
            world_left = tile_x * 256 * factor
            world_top = tile_y * 256 * factor
            if world_left >= width or world_top >= height:
                return None
            world_right = min(width, world_left + 256 * factor)
            world_bottom = min(height, world_top + 256 * factor)
            first_chunk_x = world_left // WORLD_MAP_CHUNK_SIZE
            first_chunk_y = world_top // WORLD_MAP_CHUNK_SIZE
            last_chunk_x = (world_right - 1) // WORLD_MAP_CHUNK_SIZE
            last_chunk_y = (world_bottom - 1) // WORLD_MAP_CHUNK_SIZE

            chunks: list[tuple[int, int, str]] = []
            tile_fingerprint = hashlib.blake2b(digest_size=8)
            for candidate_index, world in enumerate(candidates):
                chunk_times = world.get("base_map_chunk_times")
                if not isinstance(chunk_times, dict):
                    chunk_times = {}
                for field in ("base_map_chunks", "map_chunks"):
                    raw_chunks = world.get(field)
                    if not isinstance(raw_chunks, dict):
                        continue
                    # Address only chunks intersecting this tile. The old path
                    # parsed every saved chunk key on every image request.
                    for chunk_y in range(first_chunk_y, last_chunk_y + 1):
                        for chunk_x in range(first_chunk_x, last_chunk_x + 1):
                            chunk_key = f"{chunk_x},{chunk_y}"
                            encoded = raw_chunks.get(chunk_key)
                            if not isinstance(encoded, str):
                                continue

                            chunks.append((chunk_x, chunk_y, encoded))
                            tile_fingerprint.update(
                                f"{candidate_index}:{field}:{chunk_key}:".encode("ascii")
                            )
                            stamp = chunk_times.get(chunk_key) if field == "base_map_chunks" else None
                            if stamp is not None:
                                # Normal writes stamp changed chunks, so cache
                                # validation avoids re-hashing their large base64 payloads.
                                tile_fingerprint.update(str(stamp).encode("ascii"))
                            else:
                                # Imported and legacy chunks may not have revision stamps.
                                tile_fingerprint.update(encoded.encode("ascii"))

            fingerprint = int.from_bytes(tile_fingerprint.digest(), "big")
            cache_key = f"{requested}:{width}x{height}:{fingerprint}:{level}:{tile_x}:{tile_y}"

        with self._map_tile_generation_lock:
            image = self._map_tile_pyramid.render(
                cache_key, width, height, level, tile_x, tile_y, chunks
            )
        return image, fingerprint

    def world_map_live(
        self,
        world_id: str | None = None,
        since: float = 0,
        map_since: int = 0,
        bounds: tuple[float, float, float, float] | None = None,
        include_coins: bool = True,
    ) -> dict[str, Any]:
        """Return live changes for the viewport without streaming off-screen detail."""
        with self._lock:
            active_id = self._server_info.get("world_id")
            active_name = str(self._server_info.get("world") or "")
            requested = str(world_id if world_id not in (None, "") else active_id or "")
            received_at = self._telemetry_received_at
            age = None if received_at is None else max(0.0, time.time() - received_at)
            same_world = not requested or requested in {str(active_id or ""), active_name}
            online_ids = set(self._online_player_ids) if same_world and age is not None and age <= 5 else set()
            players: list[dict[str, Any]] = []
            deaths: list[dict[str, Any]] = []
            position_cursor = since

            def is_visible(x_value: Any, y_value: Any) -> bool:
                if bounds is None:
                    return True
                try:
                    x, y = float(x_value), float(y_value)
                except (TypeError, ValueError, OverflowError):
                    return False
                left, top, right, bottom = bounds
                return left <= x <= right and top <= y <= bottom

            for player_id, record in self._players.items():
                is_online = player_id in online_ids
                movement = self._load_movement(player_id)
                for key, world in as_json_object(movement.get("worlds")).items():
                    stored_id = world.get("world_id")
                    name = str(world.get("world_name") or "")
                    if requested and requested not in {str(key), str(stored_id or ""), name}:
                        continue
                    positions: list[dict[str, Any]] = []
                    latest_time = since
                    # Movement samples are appended in timestamp order, so scan
                    # backward and stop as soon as the client's cursor is reached.
                    for point in reversed(world.get("positions", [])):
                        if not isinstance(point, dict):
                            continue
                        try:
                            point_time = float(point.get("time", 0) or 0)
                        except (TypeError, ValueError, OverflowError):
                            continue
                        if point_time <= since:
                            break
                        latest_time = max(latest_time, point_time)
                        position_cursor = max(position_cursor, point_time)
                        if is_visible(point.get("x", point.get("tileX")), point.get("y", point.get("tileY"))):
                            positions.append(dict(point))
                    positions.reverse()
                    if is_online or positions:
                        players.append({
                            "id": player_id,
                            "name": record.get("name"),
                            "avatar_url": record.get("avatar_url"),
                            "online": is_online,
                            "team": record.get("team") if is_online else None,
                            "direction": record.get("direction") if is_online else None,
                            "teleported": record.get("teleported", False) if is_online else False,
                            "session_seconds": record.get("online_session_seconds") if is_online else None,
                            "position": record.get("position") if is_online else None,
                            "velocity": record.get("velocity") if is_online else None,
                            "positions": positions,
                            "position_cursor": latest_time,
                        })
                for death in record.get("death_locations", []):
                    if not isinstance(death, dict):
                        continue
                    if requested and requested not in {str(death.get("world_id") or ""), str(death.get("world_name") or "")}:
                        continue
                    if not is_visible(death.get("x"), death.get("y")):
                        continue
                    deaths.append({
                        "id": f"{player_id}:{death.get('timestamp', 0)}",
                        "player_id": player_id,
                        "name": record.get("name"),
                        "x": death.get("x"),
                        "y": death.get("y"),
                        "timestamp": death.get("timestamp"),
                    })

            telemetry_is_fresh = same_world and age is not None and age <= 5
            map_cache = next(
                (
                    cache for cache in self._world_map_cache.values()
                    if str(cache.get("world_id", "")) == str(active_id or "")
                    and str(cache.get("world_name") or "").casefold() == active_name.casefold()
                ),
                {},
            )
            map_revision = int(map_cache.get("map_tile_revision", 0) or 0)
            map_changes = map_cache.get("map_tile_updates", [])
            if not isinstance(map_changes, list):
                map_changes = []
            oldest_revision = (
                int(map_changes[0].get("revision", map_revision))
                if map_changes and isinstance(map_changes[0], dict)
                else map_revision
            )
            map_delta_reset = map_since > 0 and map_since < oldest_revision - 1
            latest_visible_updates: dict[tuple[int, int], dict[str, Any]] = {}
            if not map_delta_reset:
                for batch in map_changes:
                    if not isinstance(batch, dict) or int(batch.get("revision", 0) or 0) <= map_since:
                        continue
                    for update in batch.get("updates", []):
                        if not isinstance(update, dict) or not is_visible(update.get("x"), update.get("y")):
                            continue
                        try:
                            coordinate = (int(update["x"]), int(update["y"]))
                        except (KeyError, TypeError, ValueError, OverflowError):
                            continue
                        # Edits replace a pixel's color, so only the latest
                        # visible value for each coordinate needs transmission.
                        latest_visible_updates[coordinate] = update
            map_tile_updates = (
                [{"revision": map_revision, "updates": list(latest_visible_updates.values())}]
                if latest_visible_updates
                else []
            )
            active_npcs = [
                item.to_payload()
                for item in self._active_npcs
                if telemetry_is_fresh and is_visible(item.tile_x, item.tile_y)
            ]
            visible_coins = [
                item.to_payload()
                for item in self._active_coins
                if include_coins and telemetry_is_fresh and is_visible(item.tile_x, item.tile_y)
            ]
            return {
                "world": {"id": active_id, "name": active_name or None},
                "updated_at": time.time(),
                "online_player_ids": sorted(online_ids),
                "players": players,
                "deaths": deaths,
                "position_cursor": position_cursor,
                "map_tile_updates": map_tile_updates,
                "map_revision": map_revision,
                "map_delta_reset": map_delta_reset,
                "tile_cache": self._map_tile_pyramid.get_metrics(),
                "active_npcs": active_npcs,
                "active_npcs_fresh": telemetry_is_fresh,
                "coins": visible_coins,
                "telemetry": {
                    "snapshot_id": self._telemetry_snapshot_id,
                    "received_at": received_at,
                    "age_seconds": age,
                    "interval_ms": self._telemetry_interval_ms,
                    "configured_intervals": dict(self._server_info.get("telemetry_intervals", {})),
                },
            }

    def world_map_tile(self, world_id: str | None, tile_x: int, tile_y: int) -> dict[str, Any] | None:
        with self._lock:
            requested = str(world_id or self._server_info.get("world_id") or "")
            selected: dict[str, Any] | None = None
            for world_cache in self._world_map_cache.values():
                if requested and requested not in {
                    str(world_cache.get("world_id") or ""),
                    str(world_cache.get("world_name") or ""),
                }:
                    continue
                selected = world_cache
                break
            tile_chunks: dict[str, str] = {}
            tile_names: dict[str, str] = {}
            if selected is not None:
                if isinstance(selected.get("tile_chunks"), dict):
                    tile_chunks.update(selected["tile_chunks"])
                if isinstance(selected.get("tile_names"), dict):
                    tile_names.update(selected["tile_names"])
            for player_id in self._players:
                movement = self._load_movement(player_id)
                for key, world in as_json_object(movement.get("worlds")).items():
                    if requested and requested not in {
                        str(key), str(world.get("world_id") or ""), str(world.get("world_name") or "")
                    }:
                        continue
                    if selected is None:
                        selected = world
                    if isinstance(world.get("tile_chunks"), dict):
                        tile_chunks.update(world["tile_chunks"])
                    if isinstance(world.get("tile_names"), dict):
                        tile_names.update(world["tile_names"])
            if selected is None:
                return None
            try:
                if tile_x < 0 or tile_y < 0 or tile_x >= int(selected.get("width", 0)) or tile_y >= int(selected.get("height", 0)):
                    return None
            except (TypeError, ValueError):
                return None
            chunk_size = WORLD_MAP_CHUNK_SIZE
            key = f"{tile_x // chunk_size},{tile_y // chunk_size}"
            encoded = tile_chunks.get(key)
            if isinstance(selected.get("tile_names"), dict):
                # The server-side localized map catalog is authoritative over
                # older per-player movement captures, which may contain stale
                # or numeric fallback names.
                tile_names = {**tile_names, **selected["tile_names"]}
            if not encoded:
                return None
            try:
                raw = zlib.decompress(base64.b64decode(encoded, validate=True))
                if len(raw) != chunk_size * chunk_size * 4:
                    return None
                offset = ((tile_y % chunk_size) * chunk_size + tile_x % chunk_size) * 4
                tile_value, wall_value = struct.unpack_from("<HH", raw, offset)
            except (TypeError, ValueError, zlib.error, struct.error):
                return None
            tile_id = tile_value - 1 if tile_value else None
            wall_id = wall_value - 1 if wall_value else None
            return {
                "x": tile_x,
                "y": tile_y,
                "tile_id": tile_id,
                "tile_name": tile_names.get(f"t{tile_id}") if tile_id is not None else None,
                "wall_id": wall_id,
                "wall_name": tile_names.get(f"w{wall_id}") if wall_id is not None else None,
            }

    def import_player_map(self, player_id: str, data: bytes, world_id: str | None = None) -> dict[str, Any]:
        info, png, opened_tiles = decode_player_map(data)
        if world_id and str(info["world_id"]) != str(world_id):
            raise ValueError("Файл карты относится к другому миру.")
        if info["world_id"] is None:
            raise ValueError("В файле карты отсутствует ID мира.")
        with self._lock:
            telemetry_age = None if self._telemetry_received_at is None else max(0, time.time() - self._telemetry_received_at)
            if telemetry_age is None or telemetry_age > 10:
                raise ValueError("Не удалось подтвердить текущий мир сервера: нет свежих данных телеметрии.")
            movement = self._load_movement(player_id)
            player = movement.get("player", {}) if isinstance(movement.get("player"), dict) else {}
            if not player.get("name") and player_id in self._players:
                player = {**player, "name": self._players[player_id].get("name")}
                movement["player"] = player
            if not player.get("name"):
                raise ValueError("Не найден игрок для выбранного ID.")
            current_world_id = self._server_info.get("world_id")
            current_name = str(self._server_info.get("world") or "")
            width = self._server_info.get("world_width")
            height = self._server_info.get("world_height")
            if current_world_id in (None, "") or not current_name or not width or not height:
                raise ValueError("Не удалось подтвердить ID и размер текущего мира сервера.")
            if str(current_world_id) != str(info["world_id"]):
                raise ValueError("Файл карты относится к другому миру.")
            if current_name.casefold() != str(info["world_name"]).casefold():
                raise ValueError("Имя мира в файле не совпадает с текущим миром.")
            if int(width) != info["width"] or int(height) != info["height"]:
                raise ValueError("Размер мира в файле не совпадает с текущим миром.")
            _world_key, world = self._world_movement_record(movement, {
                "id": info["world_id"], "name": info["world_name"],
                "width": info["width"], "height": info["height"],
            })
            digest = hashlib.sha256(player_id.encode("utf-8")).hexdigest()[:32]
            filename = f"{info['world_id']}-{digest}.png"
            self._exploration_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            target = self._exploration_dir / filename
            merged_png = png
            merged_opened_tiles = opened_tiles
            previous_exploration = world.get("map_exploration")
            merged_existing = isinstance(previous_exploration, dict)
            if merged_existing:
                previous_filename = str(previous_exploration.get("filename") or "")
                if previous_filename != filename:
                    raise ValueError("Сохранённая карта игрока не прошла проверку и не была изменена.")
                try:
                    previous_png = target.read_bytes()
                except OSError as error:
                    raise ValueError("Не удалось прочитать предыдущую карту игрока; она не была заменена.") from error
                merged_png, merged_opened_tiles = union_map_masks(
                    previous_png, png, info["mask_width"], info["mask_height"],
                )
            temporary = target.with_suffix(".png.tmp")
            temporary.write_bytes(merged_png)
            temporary.replace(target)
            header_path = self._exploration_dir / f"{info['world_id']}.header"
            header_temporary = header_path.with_suffix(".header.tmp")
            header_temporary.write_bytes(data[:info["stream_offset"]])
            header_temporary.replace(header_path)
            updated_at = time.time()
            world["map_exploration"] = {
                "filename": filename,
                "world_id": info["world_id"], "world_name": info["world_name"],
                "width": info["width"], "height": info["height"],
                "mask_width": info["mask_width"], "mask_height": info["mask_height"],
                "opened_tiles": merged_opened_tiles, "updated_at": updated_at,
            }
            movement["updated_at"] = updated_at
            self._save_movement(player_id)
        return {"player": player.get("name"), "world": info["world_name"], "opened_tiles": merged_opened_tiles, "merged": merged_existing, "mask_width": info["mask_width"], "mask_height": info["mask_height"], "updated_at": updated_at}

    def player_exploration_image(self, player_id: str, world_id: str) -> bytes | None:
        with self._lock:
            movement = self._load_movement(player_id)
            for key, world in as_json_object(movement.get("worlds")).items():
                if str(world.get("world_id") or key.split(":", 1)[0]) != str(world_id):
                    continue
                exploration = world.get("map_exploration")
                if not isinstance(exploration, dict):
                    continue
                filename = str(exploration.get("filename") or "")
                if filename != f"{world_id}-{hashlib.sha256(player_id.encode('utf-8')).hexdigest()[:32]}.png":
                    continue
                try:
                    return (self._exploration_dir / filename).read_bytes()
                except OSError:
                    return None
        return None

    def clear_player_imported_map(self, player_id: str, world_id: str) -> dict[str, Any]:
        """Remove only the imported .map mask; keep movement-derived exploration intact."""
        if not player_id or len(player_id) > 128 or not world_id or len(world_id) > 64:
            raise ValueError("Не выбран игрок или мир.")
        with self._lock:
            if str(self._server_info.get("world_id") or "") != str(world_id):
                raise ValueError("Можно очистить импорт только для текущего мира сервера.")
            movement = self._load_movement(player_id)
            removed = False
            removed_filename = None
            for world_key, world in as_json_object(movement.get("worlds")).items():
                if str(world.get("world_id") or str(world_key).split(":", 1)[0]) != str(world_id):
                    continue
                exploration = world.get("map_exploration")
                if not isinstance(exploration, dict):
                    continue
                filename = str(exploration.get("filename") or "")
                expected = f"{world_id}-{hashlib.sha256(player_id.encode('utf-8')).hexdigest()[:32]}.png"
                if filename != expected:
                    raise ValueError("Файл импортированной карты игрока не прошёл проверку.")
                world.pop("map_exploration", None)
                removed = True
                removed_filename = filename
                break
            if removed:
                self._save_movement(player_id)
                try:
                    if removed_filename is not None:
                        (self._exploration_dir / removed_filename).unlink()
                except FileNotFoundError:
                    pass
            player = movement.get("player", {})
            return {"player": player.get("name") or player_id, "world_id": world_id, "removed": removed}

    def export_player_map(self, player_id: str, world_id: str) -> tuple[bytes, str]:
        """Build a Terraria .map from saved imported masks and movement exploration."""
        if not player_id or len(player_id) > 128 or not world_id or len(world_id) > 64:
            raise ValueError("Не выбран игрок или мир.")
        with self._lock:
            if str(self._server_info.get("world_id") or "") != str(world_id):
                raise ValueError("Можно скачать карту только для текущего мира сервера.")
            movement = self._load_movement(player_id)
            world = next((item for key, item in as_json_object(movement.get("worlds")).items()
                          if str(item.get("world_id") or str(key).split(":", 1)[0]) == str(world_id)), None)
            if world is None:
                raise ValueError("Для этого игрока пока нет сохранённых данных карты.")
            width, height = int(world.get("width") or 0), int(world.get("height") or 0)
            if not width or not height:
                width = int(self._server_info.get("world_width") or 0)
                height = int(self._server_info.get("world_height") or 0)
            if not width or not height:
                raise ValueError("Не удалось определить размер мира для карты.")
            header_path = self._exploration_dir / f"{world_id}.header"
            try:
                header = header_path.read_bytes()
            except OSError as error:
                raise ValueError("Сначала загрузите любой .map этого мира, чтобы сохранить совместимый заголовок.") from error
            exploration = world.get("map_exploration")
            imported_png = None
            if isinstance(exploration, dict):
                expected = f"{world_id}-{hashlib.sha256(player_id.encode('utf-8')).hexdigest()[:32]}.png"
                if str(exploration.get("filename") or "") != expected:
                    raise ValueError("Сохранённая карта игрока не прошла проверку.")
                try:
                    imported_png = (self._exploration_dir / expected).read_bytes()
                except OSError as error:
                    raise ValueError("Не удалось прочитать импортированную карту игрока.") from error
            positions = [dict(point) for point in world.get("positions", []) if isinstance(point, dict)]
            visited_tiles = list(world.get("visited_tiles", []))
            player_name = str(movement.get("player", {}).get("name") or player_id)

        mask_width, mask_height = (width + 3) // 4, (height + 3) // 4
        mask = bytearray(mask_width * mask_height)
        if imported_png is not None:
            png_width, png_height, rgba = read_map_mask_png(imported_png)
            if (png_width, png_height) != (mask_width, mask_height):
                raise ValueError("Размер сохранённой карты игрока не совпадает с текущим миром.")
            for index, alpha in enumerate(rgba[3::4]):
                if alpha:
                    mask[index] = 1
        draw_route_mask(mask, mask_width, mask_height, width, height, positions, visited_tiles)
        raw_map = encode_player_map_rows(mask, mask_width, mask_height, width, height)
        compressor = zlib.compressobj(level=6, wbits=-15)
        map_file = header + compressor.compress(raw_map) + compressor.flush()
        safe_name = re.sub(r"[^A-Za-z0-9_-]+", "_", player_name).strip("_") or "player"
        return map_file, f"{safe_name}-{world_id}.map"
