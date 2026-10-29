from __future__ import annotations

import json
import hashlib
import gzip
import mimetypes
import re
import threading
import time
import urllib.error
import urllib.request
import struct
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, cast
from urllib.parse import SplitResult, parse_qs, urlsplit

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
            tile = self.store.world_map_tile(params.get("world", [None])[0], tile_x, tile_y)
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
                params.get("world", [None])[0], level, tile_x, tile_y
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
            include_chunks = params.get("tiles", ["0"])[0] != "1"
            body = json.dumps(
                self.store.world_map(world_id, since, live_since, include_chunks),
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
        elif path == "/api/wiki-cache":
            raw_url = parse_qs(request.query).get("url", [""])[0]
            try:
                body, content_type, max_age = self._cached_wiki_resource(raw_url)
            except (ValueError, urllib.error.URLError, TimeoutError) as error:
                self._send(502, str(error).encode("utf-8"), "text/plain; charset=utf-8", cache_control="no-store")
                return
            self._send(200, body, content_type, cache_control=f"public, max-age={max_age}")
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

    def _cached_wiki_resource(self, raw_url: str) -> tuple[bytes, str, int]:
        parsed = urlsplit(raw_url)
        hostname = parsed.hostname or ""
        if parsed.scheme != "https" or not (hostname == "wiki.gg" or hostname.endswith(".wiki.gg")):
            raise ValueError("Разрешены только HTTPS-ресурсы wiki.gg.")
        if parsed.username or parsed.password or not parsed.path.startswith(("/ru/api.php", "/images/", "/ru/wiki/")):
            raise ValueError("Недопустимый адрес ресурса вики.")
        cache_seconds = 30 * 24 * 60 * 60 if parsed.path.startswith("/images/") else 7 * 24 * 60 * 60
        digest = hashlib.sha256(raw_url.encode("utf-8")).hexdigest()
        body_path = self.store.boss_cache_directory / f"{digest}.body"
        meta_path = self.store.boss_cache_directory / f"{digest}.json"
        now = time.time()
        with self.store.boss_cache_lock:
            try:
                metadata = json.loads(meta_path.read_text(encoding="utf-8"))
                cached_body = body_path.read_bytes()
                age = max(0, int(now - float(metadata["stored_at"])))
                if age < cache_seconds:
                    return cached_body, str(metadata["content_type"]), max(60, cache_seconds - age)
            except (OSError, ValueError, TypeError, KeyError):
                metadata = None
                cached_body = None
            req = urllib.request.Request(raw_url, headers={"User-Agent": "TerrariaTunnelDashboard/1.0"})
            try:
                with urllib.request.urlopen(req, timeout=12) as response:
                    final = cast(SplitResult, urlsplit(response.geturl()))
                    final_host: str = final.hostname or ""
                    if final.scheme != "https" or not (final_host == "wiki.gg" or final_host.endswith(".wiki.gg")):
                        raise ValueError("Вики перенаправила на недопустимый адрес.")
                    content_type = response.headers.get_content_type()
                    if parsed.path.startswith("/images/"):
                        if not content_type.startswith("image/"):
                            raise ValueError("Вики вернула не изображение.")
                    elif content_type not in {"application/json", "text/html", "text/plain"}:
                        raise ValueError("Вики вернула неподдерживаемый формат.")
                    body = response.read(12 * 1024 * 1024 + 1)
                    if len(body) > 12 * 1024 * 1024:
                        raise ValueError("Ресурс вики слишком большой.")
            except (urllib.error.URLError, TimeoutError):
                if cached_body is not None and metadata:
                    return cached_body, str(metadata["content_type"]), 300
                raise
            self.store.boss_cache_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            temporary_body = body_path.with_suffix(".body.tmp")
            temporary_meta = meta_path.with_suffix(".json.tmp")
            temporary_body.write_bytes(body)
            temporary_meta.write_text(json.dumps({"stored_at": now, "content_type": content_type}), encoding="utf-8")
            temporary_body.replace(body_path)
            temporary_meta.replace(meta_path)
            return body, content_type, cache_seconds

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
