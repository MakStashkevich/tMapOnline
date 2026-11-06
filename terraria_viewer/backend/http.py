from __future__ import annotations

import json
import gzip
import mimetypes
import re
import threading
import time
import struct
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, cast
from urllib.parse import parse_qs, urlsplit

from .store import GAME_LOG, WORLD_MAP_FILE, StatusStore
from .store_common import is_valid_png
from ..config import page_enabled

ASSET_ROOT = Path(__file__).resolve().parents[1] / "web" / "assets"


class ServerLogFollower:
    ERROR_MARKERS = (
        "error",
        "exception",
        "fatal",
        "no route to host",
        "nodename nor servname",
    )

    def __init__(self, path: Path = GAME_LOG) -> None:
        self.path = path
        try:
            self.offset = path.stat().st_size
        except OSError:
            self.offset = 0

    def read_new_errors(self, store: StatusStore) -> None:
        try:
            size = self.path.stat().st_size
            if size < self.offset:
                self.offset = 0
            with self.path.open("r", encoding="utf-8", errors="replace") as log_file:
                log_file.seek(self.offset)
                lines = log_file.readlines()
                self.offset = log_file.tell()
        except OSError:
            return

        for line in lines:
            lowered = line.lower()
            if any(marker in lowered for marker in self.ERROR_MARKERS):
                store.record_error("tModLoader", line)


class DashboardHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    store: StatusStore
    site_config: dict[str, Any] = {}
    map_ping_sender: Callable[[float, float, str], bool] | None = None

    def do_GET(self) -> None:
        request = urlsplit(self.path)
        path = request.path
        if path == "/api/site-config":
            body = json.dumps(self.site_config, ensure_ascii=False).encode("utf-8")
            self._send(200, body, "application/json; charset=utf-8")
        elif path == "/api/status":
            body = json.dumps(self.store.snapshot(), ensure_ascii=False).encode("utf-8")
            self._send(200, body, "application/json; charset=utf-8")
        elif path == "/api/sidebar-status":
            body = json.dumps(self.store.sidebar_snapshot(), ensure_ascii=False).encode("utf-8")
            self._send(200, body, "application/json; charset=utf-8")
        elif path == "/api/section-data":
            section = parse_qs(request.query).get("section", [""])[0]
            if section not in {"world", "players", "bosses", "server", "activity"}:
                self._send(404, b"unknown section\n", "text/plain; charset=utf-8")
                return
            if self.site_config.get("sections", {}).get(section, True) is not True:
                self._send(404, b"section disabled\n", "text/plain; charset=utf-8")
                return
            try:
                body = json.dumps(self.store.section_snapshot(section), ensure_ascii=False).encode("utf-8")
            except ValueError:
                self._send(404, b"unknown section\n", "text/plain; charset=utf-8")
                return
            self._send(200, body, "application/json; charset=utf-8", cache_control="no-store")
        elif path == "/api/player-avatar":
            player_id = parse_qs(request.query).get("id", [""])[0]
            avatar_url = self.store.player_avatar_url(player_id)
            if avatar_url is None:
                self._send(404, b"player not found\n", "text/plain; charset=utf-8")
                return
            body = json.dumps({"avatar_url": avatar_url}, ensure_ascii=False).encode("utf-8")
            self._send(200, body, "application/json; charset=utf-8", cache_control="no-store")
        elif path == "/api/player-map":
            player_id = parse_qs(request.query).get("id", [""])[0]
            player_map = self.store.player_map(player_id)
            if player_map is None:
                self._send(404, b"player not found\n", "text/plain; charset=utf-8")
            else:
                body = json.dumps(player_map, ensure_ascii=False).encode("utf-8")
                self._send(200, body, "application/json; charset=utf-8")
        elif path == "/api/world-map/tile-info":
            params = parse_qs(request.query)
            try:
                tile_x, tile_y = int(params.get("x", [""])[0]), int(params.get("y", [""])[0])
            except (TypeError, ValueError):
                self._send(400, b"invalid tile coordinates\n", "text/plain; charset=utf-8")
                return
            world_id = params.get("world", [None])[0]
            profile_id = params.get("profile", [None])[0]
            if not self.store.world_map_profile_allows_tile(profile_id, world_id, tile_x, tile_y):
                self._send(404, b"tile details are hidden by map profile\n", "text/plain; charset=utf-8")
                return
            tile = self.store.world_map_tile(world_id, tile_x, tile_y)
            if tile is None:
                self._send(404, b"tile details not available\n", "text/plain; charset=utf-8")
            else:
                self._send(200, json.dumps(tile, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", cache_control="no-store")
        elif path == "/api/world-map/tile":
            params = parse_qs(request.query)
            try:
                level = int(params.get("level", ["0"])[0])
                tile_x = int(params.get("x", ["0"])[0])
                tile_y = int(params.get("y", ["0"])[0])
            except (TypeError, ValueError):
                self._send(400, b"invalid map tile coordinates\n", "text/plain; charset=utf-8")
                return
            if level < 0 or level > 8 or tile_x < 0 or tile_y < 0:
                self._send(400, b"map tile coordinates are out of range\n", "text/plain; charset=utf-8")
                return
            tile = self.store.world_map_image_tile(
                params.get("world", [None])[0],
                level,
                tile_x,
                tile_y,
                params.get("profile", [None])[0],
            )
            if tile is None:
                self._send(404, b"map tile is unavailable\n", "text/plain; charset=utf-8")
            else:
                body, version = tile
                entity_tag = f'"{version:x}"'
                cache_control = "public, max-age=0, must-revalidate"
                if self.headers.get("If-None-Match") == entity_tag:
                    self.send_response(304)
                    self.send_header("ETag", entity_tag)
                    self.send_header("Cache-Control", cache_control)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", cache_control)
                self.send_header("ETag", entity_tag)
                self.send_header("X-Map-Tile-Version", str(version))
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(body)
        elif path == "/api/world-map/live":
            params = parse_qs(request.query)
            world_id = params.get("world", [None])[0]
            try:
                since = max(0.0, float(params.get("since", ["0"])[0]))
            except (TypeError, ValueError):
                since = 0.0
            try:
                map_since = max(0, int(params.get("map_since", ["0"])[0]))
            except (TypeError, ValueError):
                map_since = 0
            bounds = self._live_view_bounds(params)
            include_coins = params.get("coins", ["0"])[0] == "1"
            body = json.dumps(
                self.store.world_map_live(
                    world_id, since, map_since, bounds, include_coins
                ),
                ensure_ascii=False,
            ).encode("utf-8")
            self._send(200, body, "application/json; charset=utf-8", cache_control="no-store")
        elif path == "/api/world-map/stream":
            self._stream_world_map_live(request.query)
        elif path == "/api/world-map":
            params = parse_qs(request.query)
            world_id = params.get("world", [None])[0]
            try:
                since = max(0.0, float(params.get("since", ["0"])[0]))
            except (TypeError, ValueError):
                since = 0.0
            try:
                live_since = max(0.0, float(params.get("live_since", ["0"])[0]))
            except (TypeError, ValueError):
                live_since = 0.0
            include_positions = params.get("positions", ["1"])[0] != "0"
            # Keep raw map pixels out of the default response. A caller that
            # explicitly needs the legacy full payload can pass tiles=0.
            include_chunks = params.get("tiles", ["1"])[0] == "0"
            body = json.dumps(
                self.store.world_map(
                    world_id, since, live_since, include_chunks, include_positions
                ),
                ensure_ascii=False,
            ).encode("utf-8")
            accepts_gzip = "gzip" in self.headers.get("Accept-Encoding", "").lower()
            content_encoding = None
            if accepts_gzip and len(body) >= 1024:
                body = gzip.compress(body, compresslevel=1, mtime=0)
                content_encoding = "gzip"
            self._send(
                200,
                body,
                "application/json; charset=utf-8",
                cache_control="no-store",
                content_encoding=content_encoding,
            )
        elif path == "/api/world-map/exploration":
            params = parse_qs(request.query)
            player_id = params.get("id", [""])[0]
            world_id = params.get("world", [""])[0]
            body = self.store.player_exploration_image(player_id, world_id)
            if body is None:
                self._send(404, b"map exploration not found\n", "text/plain; charset=utf-8")
            else:
                self._send(200, body, "image/png", cache_control="public, max-age=31536000, immutable")
        elif path == "/api/resource-history":
            try:
                days = int(parse_qs(request.query).get("days", ["1"])[0])
            except (TypeError, ValueError):
                days = 1
            days = max(1, min(7, days))
            body = json.dumps(
                {"days": days, "samples": self.store.resource_history(days)},
                ensure_ascii=False,
            ).encode("utf-8")
            self._send(200, body, "application/json; charset=utf-8")
        elif path == "/healthz":
            self._send(200, b"ok\n", "text/plain; charset=utf-8")
        elif path == "/api/ping":
            self._send(204, b"", "text/plain; charset=utf-8", cache_control="no-store")
        elif path.startswith("/player-avatars/"):
            filename = path.rsplit("/", 1)[-1]
            if not re.fullmatch(r"[0-9a-f]{32}\.(?:svg|png)", filename):
                self._send(404, b"not found\n", "text/plain; charset=utf-8")
                return
            try:
                body = (self.store.avatar_directory / filename).read_bytes()
            except OSError:
                self._send(404, b"not found\n", "text/plain; charset=utf-8")
                return
            if filename.endswith(".png") and not is_valid_png(body):
                self._send(404, b"invalid image\n", "text/plain; charset=utf-8")
                return
            content_type = "image/png" if filename.endswith(".png") else "image/svg+xml; charset=utf-8"
            self._send(200, body, content_type, cache_control="public, max-age=31536000, immutable")
        elif path.startswith("/npc-sprites/"):
            filename = path.rsplit("/", 1)[-1]
            if not re.fullmatch(r"[0-9a-f]{32}\.png", filename):
                self._send(404, b"not found\n", "text/plain; charset=utf-8")
                return
            try:
                body = (self.store.npc_sprite_directory / filename).read_bytes()
            except OSError:
                self._send(404, b"not found\n", "text/plain; charset=utf-8")
                return
            if not is_valid_png(body):
                self._send(404, b"invalid image\n", "text/plain; charset=utf-8")
                return
            self._send(200, body, "image/png", cache_control="public, max-age=31536000, immutable")
        elif path.startswith("/map-sprites/"):
            filename = path.rsplit("/", 1)[-1]
            if not re.fullmatch(r"coin-(?:71|72|73|74)\.png", filename):
                self._send(404, b"not found\n", "text/plain; charset=utf-8")
                return
            try:
                body = (self.store.map_sprite_directory / filename).read_bytes()
            except OSError:
                self._send(404, b"not found\n", "text/plain; charset=utf-8")
                return
            if not is_valid_png(body):
                self._send(404, b"invalid image\n", "text/plain; charset=utf-8")
                return
            self._send(200, body, "image/png", cache_control="public, max-age=31536000, immutable")
        elif path in {"/world-map", "/world-map.html", "/debug"}:
            if not page_enabled({"site": self.site_config}, "world_map"):
                self._send(404, b"page disabled\n", "text/plain; charset=utf-8")
                return
            try:
                body = WORLD_MAP_FILE.read_bytes()
            except OSError:
                self._send(500, b"World map HTML is unavailable.\n", "text/plain; charset=utf-8")
                return
            self._send(200, body, "text/html; charset=utf-8")
        elif path == "/" or path == "/index.html":
            if not page_enabled({"site": self.site_config}, "world_map"):
                self._send(404, b"page disabled\n", "text/plain; charset=utf-8")
                return
            try:
                body = WORLD_MAP_FILE.read_bytes()
            except OSError:
                self._send(500, b"World map HTML is unavailable.\n", "text/plain; charset=utf-8")
                return
            self._send(200, body, "text/html; charset=utf-8")
        elif path.startswith("/assets/"):
            relative = path.removeprefix("/assets/")
            candidate = (ASSET_ROOT / relative).resolve()
            if not candidate.is_relative_to(ASSET_ROOT.resolve()) or not candidate.is_file():
                self._send(404, b"not found\n", "text/plain; charset=utf-8")
                return
            content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
                content_type += "; charset=utf-8"
            self._send(200, candidate.read_bytes(), content_type, cache_control="no-cache")
        else:
            self._send(404, b"not found\n", "text/plain; charset=utf-8")

    def do_POST(self) -> None:
        request = urlsplit(self.path)
        if request.path == "/api/world-map/ping":
            origin = urlsplit(self.headers.get("Origin", ""))
            forwarded_proto = self.headers.get("X-Forwarded-Proto", "http").split(",", 1)[0].strip()
            request_origin = f"{forwarded_proto}://{self.headers.get('Host', '')}".rstrip("/")
            if origin.scheme not in {"http", "https"} or f"{origin.scheme}://{origin.netloc}" != request_origin:
                self._send(403, b"Map ping requests must come from this site.\n", "text/plain; charset=utf-8")
                return
            if self.map_ping_sender is None:
                self._send(503, b"Game telemetry is not connected.\n", "text/plain; charset=utf-8")
                return
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                content_length = 0
            if not 2 <= content_length <= 4096 or "application/json" not in self.headers.get("Content-Type", ""):
                self._send(400, b"Invalid map ping request.\n", "text/plain; charset=utf-8")
                return
            try:
                payload = json.loads(self.rfile.read(content_length))
                if not isinstance(payload, dict):
                    raise ValueError
                x = payload.get("x")
                y = payload.get("y")
                ping_id = payload.get("id")
                if isinstance(x, bool) or isinstance(y, bool):
                    raise ValueError
                x = float(x)
                y = float(y)
                if (
                    not isinstance(ping_id, str)
                    or not 1 <= len(ping_id) <= 64
                    or not (x >= 0 and y >= 0 and x < 10_000_000 and y < 10_000_000)
                ):
                    raise ValueError
            except (ValueError, TypeError, json.JSONDecodeError):
                self._send(400, b"Map ping coordinates are invalid.\n", "text/plain; charset=utf-8")
                return
            if not self.map_ping_sender(x, y, ping_id):
                self._send(503, b"Game telemetry is not connected.\n", "text/plain; charset=utf-8")
                return
            self._send(202, b'{"queued":true}', "application/json; charset=utf-8", cache_control="no-store")
            return
        if request.path == "/api/world-map/render-profile":
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                content_length = 0
            if not 2 <= content_length <= 64 * 1024:
                self._send(400, b"invalid map render profile request\n", "text/plain; charset=utf-8")
                return
            try:
                payload: Any = json.loads(self.rfile.read(content_length))
                if not isinstance(payload, dict):
                    raise ValueError("Профиль карты должен быть объектом.")
                payload = cast(dict[str, Any], payload)
                raw_explore_ids = payload.get("explore_players", [])
                raw_route_ids = payload.get("route_players", [])
                explore_values = cast(list[Any], raw_explore_ids) if isinstance(raw_explore_ids, list) else None
                route_values = cast(list[Any], raw_route_ids) if isinstance(raw_route_ids, list) else None
                if explore_values is None or not all(
                    isinstance(value, str) for value in explore_values
                ):
                    raise ValueError("Список игроков исследования некорректен.")
                if route_values is None or not all(
                    isinstance(value, str) for value in route_values
                ):
                    raise ValueError("Список игроков маршрутов некорректен.")
                explore_ids = cast(list[str], explore_values)
                route_ids = cast(list[str], route_values)
                profile = self.store.create_map_render_profile(
                    str(payload.get("world") or "") or None,
                    explore_ids,
                    route_ids,
                    str(payload.get("period") or "7d"),
                    payload.get("full_map") is True,
                )
                body = json.dumps(profile, ensure_ascii=False).encode("utf-8")
                content_encoding = None
                if "gzip" in self.headers.get("Accept-Encoding", "").lower() and len(body) >= 1024:
                    body = gzip.compress(body, compresslevel=1, mtime=0)
                    content_encoding = "gzip"
            except (ValueError, OSError, zlib.error) as error:
                self._send(400, str(error).encode("utf-8"), "text/plain; charset=utf-8")
                return
            self._send(
                200,
                body,
                "application/json; charset=utf-8",
                cache_control="no-store",
                content_encoding=content_encoding,
            )
            return
        if request.path == "/api/world-map/export-player-map":
            origin = urlsplit(self.headers.get("Origin", ""))
            forwarded_proto = self.headers.get("X-Forwarded-Proto", "http").split(",", 1)[0].strip()
            request_origin = f"{forwarded_proto}://{self.headers.get('Host', '')}".rstrip("/")
            allowed_source = (
                origin.scheme in {"http", "https"}
                and f"{origin.scheme}://{origin.netloc}" == request_origin
                and self.headers.get("X-Terraria-Map-Debug-Page") == "1"
            )
            if not allowed_source:
                self._send(403, b"Map export is available from the debug page only.\n", "text/plain; charset=utf-8")
                return
            params = parse_qs(request.query)
            try:
                map_file, filename = self.store.export_player_map(
                    params.get("id", [""])[0], params.get("world", [""])[0]
                )
            except (ValueError, OSError, zlib.error, struct.error) as error:
                self._send(400, str(error).encode("utf-8"), "text/plain; charset=utf-8")
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(map_file)))
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Cache-Control", "no-store, max-age=0")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(map_file)
            return
        if request.path != "/api/world-map/import-player-map":
            self._send(404, b"not found\n", "text/plain; charset=utf-8")
            return
        referer_value = self.headers.get("Referer", "")
        if referer_value:
            referer = urlsplit(referer_value)
            allowed_source = referer.path.rstrip("/") == "/debug"
        else:
            # Nginx deliberately sends Referrer-Policy: no-referrer. Safari
            # therefore omits Referer even for this same-origin debug-page POST.
            origin = urlsplit(self.headers.get("Origin", ""))
            forwarded_proto = self.headers.get("X-Forwarded-Proto", "http").split(",", 1)[0].strip()
            request_origin = f"{forwarded_proto}://{self.headers.get('Host', '')}".rstrip("/")
            allowed_source = (
                origin.scheme in {"http", "https"}
                and f"{origin.scheme}://{origin.netloc}" == request_origin
                and self.headers.get("X-Terraria-Map-Debug-Page") == "1"
            )
        if not allowed_source:
            self._send(403, b"Map import is available from the debug page only.\n", "text/plain; charset=utf-8")
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if not 64 <= content_length <= 32 * 1024 * 1024:
            self._send(400, "Недопустимый размер файла карты.\n".encode("utf-8"), "text/plain; charset=utf-8")
            return
        player_id = parse_qs(request.query).get("id", [""])[0]
        if not player_id or len(player_id) > 128:
            self._send(400, "Не выбран игрок.\n".encode("utf-8"), "text/plain; charset=utf-8")
            return
        try:
            result = self.store.import_player_map(player_id, self.rfile.read(content_length))
        except (ValueError, OSError, zlib.error, struct.error) as error:
            self._send(400, str(error).encode("utf-8"), "text/plain; charset=utf-8")
            return
        self._send(200, json.dumps(result, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_DELETE(self) -> None:
        request = urlsplit(self.path)
        if request.path != "/api/world-map/import-player-map":
            self._send(404, b"not found\n", "text/plain; charset=utf-8")
            return
        origin = urlsplit(self.headers.get("Origin", ""))
        forwarded_proto = self.headers.get("X-Forwarded-Proto", "http").split(",", 1)[0].strip()
        request_origin = f"{forwarded_proto}://{self.headers.get('Host', '')}".rstrip("/")
        allowed_source = (
            origin.scheme in {"http", "https"}
            and f"{origin.scheme}://{origin.netloc}" == request_origin
            and self.headers.get("X-Terraria-Map-Debug-Page") == "1"
        )
        if not allowed_source:
            self._send(403, b"Map cleanup is available from the debug page only.\n", "text/plain; charset=utf-8")
            return
        params = parse_qs(request.query)
        player_id = params.get("id", [""])[0]
        world_id = params.get("world", [""])[0]
        try:
            result = self.store.clear_player_imported_map(player_id, world_id)
        except (ValueError, OSError) as error:
            self._send(400, str(error).encode("utf-8"), "text/plain; charset=utf-8")
            return
        self._send(200, json.dumps(result, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", cache_control="no-store")

    def _send(
        self,
        status: int,
        body: bytes,
        content_type: str,
        *,
        cache_control: str = "no-store, max-age=0",
        content_encoding: str | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if content_encoding:
            self.send_header("Content-Encoding", content_encoding)
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache_control)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _stream_world_map_live(self, query: str) -> None:
        """Stream compact live deltas, keeping map tiles and old history out of the feed."""
        params = parse_qs(query)
        world_id = params.get("world", [None])[0]
        bounds = self._live_view_bounds(params)
        include_coins = params.get("coins", ["0"])[0] == "1"
        try:
            since = max(0.0, float(params.get("since", ["0"])[0]))
            map_since = max(0, int(params.get("map_since", ["0"])[0]))
            interval_ms = max(50, min(1000, int(params.get("interval_ms", ["50"])[0])))
        except (TypeError, ValueError):
            since, map_since, interval_ms = 0.0, 0, 50

        # EventSource reconnects with the last acknowledged position/map cursors.
        last_event_id = self.headers.get("Last-Event-ID", "")
        if last_event_id:
            try:
                saved_since, saved_map_since = last_event_id.split(",", maxsplit=1)
                since = max(since, float(saved_since))
                map_since = max(map_since, int(saved_map_since))
            except (TypeError, ValueError):
                pass

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()

        sequence = self.store.live_update_sequence()
        started_at = time.monotonic()
        last_sent_at = 0.0
        try:
            while time.monotonic() - started_at < 55:
                updated_sequence = self.store.wait_for_live_update(sequence, 15)
                if updated_sequence == sequence:
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
                    continue

                sequence = updated_sequence
                while True:
                    elapsed = time.monotonic() - last_sent_at
                    remaining = interval_ms / 1000 - elapsed
                    if remaining <= 0:
                        break
                    updated_sequence = self.store.wait_for_live_update(sequence, remaining)
                    sequence = updated_sequence
                payload = self.store.world_map_live(
                    world_id, since, map_since, bounds, include_coins
                )
                since = max(since, float(payload.get("position_cursor", since) or since))
                live_players = cast(list[dict[str, Any]], payload.get("players", []))
                for player in live_players:
                    points = cast(list[dict[str, Any]], player.get("positions", []))
                    for point in points:
                        try:
                            since = max(since, float(point.get("time", 0) or 0))
                        except (TypeError, ValueError, OverflowError):
                            continue
                map_since = max(map_since, int(payload.get("map_revision", map_since) or map_since))
                body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                event = f"id: {since:.6f},{map_since}\ndata: {body}\n\n".encode("utf-8")
                self.wfile.write(event)
                self.wfile.flush()
                last_sent_at = time.monotonic()
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            return

    @staticmethod
    def _live_view_bounds(
        params: dict[str, list[str]],
    ) -> tuple[float, float, float, float] | None:
        """Parse a viewport rectangle; malformed bounds fall back to legacy full updates."""
        try:
            bounds = tuple(float(params[key][0]) for key in ("left", "top", "right", "bottom"))
        except (KeyError, IndexError, TypeError, ValueError, OverflowError):
            return None
        left, top, right, bottom = bounds
        if right <= left or bottom <= top:
            return None
        return left, top, right, bottom

    def log_message(self, format: str, *args: object) -> None:
        return


def start_dashboard(
    store: StatusStore,
    port: int = 8765,
    site_config: dict[str, Any] | None = None,
    host: str = "127.0.0.1",
) -> ThreadingHTTPServer:
    handler = type(
        "BoundDashboardHandler",
        (DashboardHandler,),
        {"store": store, "site_config": site_config or {}},
    )
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, name="terraria-dashboard", daemon=True)
    thread.start()
    return server
