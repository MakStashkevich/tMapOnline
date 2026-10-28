#!/usr/bin/env python3
"""Local-only HTTP dashboard for the Terraria tunnel supervisor."""

from __future__ import annotations

import hashlib
import html
import base64
import json
import math
import os
import re
import shutil
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit


HOME = Path.home()
GAME_LOG = (
    HOME
    / "Library/Application Support/Steam/steamapps/common/tModLoader/tModLoader-Logs/server.log"
)
EVENTS_FILE = HOME / "Library/Application Support/TerrariaTunnel/dashboard-events.json"
HISTORY_FILE = HOME / "Library/Application Support/TerrariaTunnel/monitor-history.json"
PLAYERS_FILE = HOME / "Library/Application Support/TerrariaTunnel/player-history.json"
METRICS_FILE = HOME / "Library/Application Support/TerrariaTunnel/server-metrics.json"
PLAYER_AVATARS_DIR = HOME / "Library/Application Support/TerrariaTunnel/player-avatars"
NPC_SPRITES_DIR = HOME / "Library/Application Support/TerrariaTunnel/npc-sprites"
NPC_TEXTURES_DIR = HOME / "Library/Application Support/TerrariaTunnel/npc-textures"
MAP_SPRITES_DIR = HOME / "Library/Application Support/TerrariaTunnel/map-sprites"
TERRARIA_CLIENT_IMAGES = Path(os.environ.get(
    "TERRARIA_CLIENT_IMAGES",
    str(HOME / "Library/Application Support/Steam/steamapps/common/Terraria/Terraria.app/Contents/Resources/Content/Images"),
))
SPRITE_RENDERER_SOURCE = Path(__file__).resolve().parents[1] / "sprite_renderer" / "java"
SPRITE_RENDERER_CACHE = HOME / "Library/Caches/TerrariaTunnel/player-sprite-renderer"
PLAYER_MOVEMENTS_DIR = HOME / "Library/Application Support/TerrariaTunnel/player-movements"
BOSS_CACHE_DIR = HOME / "Library/Application Support/TerrariaTunnel/boss-cache"
HISTORY_RETENTION_SECONDS = 7 * 24 * 60 * 60
HISTORY_SAMPLE_INTERVAL = 60
AVATAR_RENDERER_VERSION = 5
WORLD_MAP_FILE = Path(__file__).resolve().parents[1] / "web" / "world-map" / "index.html"
VPS_HOST = "terka.stashkevich.com"
VPS_IP = "5.187.0.105"
GAME_PORT = 7777
WORLD_MAP_CHUNK_SIZE = 64
WORLD_MAP_EXPLORATION_DIR = HOME / "Library/Application Support/TerrariaTunnel/world-exploration"
PLAYER_NAME_PLACEHOLDERS = {
    ".", "..", "...", "сервер запущен", "сервер работает", "server started", "server is running",
}


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def _is_valid_png(data: bytes) -> bool:
    """Check PNG structure and chunk checksums before advertising an image URL."""
    if len(data) < 45 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return False
    offset = 8
    saw_header = saw_image_data = saw_end = False
    while offset + 12 <= len(data):
        length = struct.unpack_from(">I", data, offset)[0]
        end = offset + 12 + length
        if length > 64 * 1024 * 1024 or end > len(data):
            return False
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        expected_crc = struct.unpack_from(">I", data, offset + 8 + length)[0]
        if zlib.crc32(kind + payload) & 0xFFFFFFFF != expected_crc:
            return False
        if kind == b"IHDR":
            if offset != 8 or length != 13:
                return False
            width, height = struct.unpack_from(">II", payload)
            if not (0 < width <= 8192 and 0 < height <= 8192):
                return False
            saw_header = True
        elif kind == b"IDAT":
            saw_image_data = True
        elif kind == b"IEND":
            if length != 0 or end != len(data):
                return False
            saw_end = True
            break
        offset = end
    return saw_header and saw_image_data and saw_end


def _read_map_mask_png(data: bytes) -> tuple[int, int, bytearray]:
    """Read the simple RGBA/filter-0 PNG masks produced by this module."""
    if not _is_valid_png(data):
        raise ValueError("Сохранённая маска карты повреждена.")
    offset = 8
    width = height = 0
    image_data = bytearray()
    while offset + 12 <= len(data):
        length = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        offset += length + 12
        if kind == b"IHDR":
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
            if bit_depth != 8 or color_type != 6 or compression or filtering or interlace:
                raise ValueError("Формат сохранённой маски карты не поддерживается.")
        elif kind == b"IDAT":
            image_data.extend(payload)
        elif kind == b"IEND":
            break
    try:
        decoded = zlib.decompress(image_data)
    except zlib.error as error:
        raise ValueError("Не удалось прочитать сохранённую маску карты.") from error
    stride = width * 4
    if width < 1 or height < 1 or len(decoded) != (stride + 1) * height:
        raise ValueError("Размер сохранённой маски карты некорректен.")
    rgba = bytearray(stride * height)
    for y in range(height):
        start = y * (stride + 1)
        if decoded[start] != 0:
            raise ValueError("Фильтр сохранённой маски карты не поддерживается.")
        rgba[y * stride:(y + 1) * stride] = decoded[start + 1:start + stride + 1]
    return width, height, rgba


def _write_map_mask_png(width: int, height: int, rgba: bytearray) -> bytes:
    stride = width * 4
    scanlines = bytearray()
    for y in range(height):
        scanlines.append(0)
        scanlines.extend(rgba[y * stride:(y + 1) * stride])
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + _png_chunk(b"IDAT", zlib.compress(scanlines, 6))
        + _png_chunk(b"IEND", b"")
    )


def _union_map_masks(existing_png: bytes, incoming_png: bytes, width: int, height: int) -> tuple[bytes, int]:
    old_width, old_height, old_rgba = _read_map_mask_png(existing_png)
    new_width, new_height, new_rgba = _read_map_mask_png(incoming_png)
    if (old_width, old_height) != (new_width, new_height) or (new_width, new_height) != (width, height):
        raise ValueError("Размер сохранённой карты не совпадает с новой картой этого мира.")
    opened_tiles = 0
    for offset in range(3, len(old_rgba), 4):
        if new_rgba[offset] or old_rgba[offset]:
            old_rgba[offset - 3:offset + 1] = b"\xff\xff\xff\xff"
            pixel_index = offset // 4
            pixel_x, pixel_y = pixel_index % new_width, pixel_index // new_width
            opened_tiles += min(4, width - pixel_x * 4) * min(4, height - pixel_y * 4)
    return _write_map_mask_png(old_width, old_height, old_rgba), opened_tiles


def _draw_route_mask(
    mask: bytearray, mask_width: int, mask_height: int, width: int, height: int,
    positions: list[dict[str, Any]], visited_tiles: list[Any],
) -> None:
    """Add explored route strokes at the same roughly 16-tile radius as the map UI."""
    offsets = [(dx, dy) for dy in range(-4, 5) for dx in range(-4, 5) if dx * dx + dy * dy <= 16]

    def mark_point(x: float, y: float) -> None:
        cx, cy = round((x + 0.5) / 4), round((y + 0.5) / 4)
        for ox, oy in offsets:
            px, py = cx + ox, cy + oy
            if 0 <= px < mask_width and 0 <= py < mask_height:
                mask[py * mask_width + px] = 1

    def mark_segment(x0: float, y0: float, x1: float, y1: float) -> None:
        ax, ay, bx, by = (x0 + 0.5) / 4, (y0 + 0.5) / 4, (x1 + 0.5) / 4, (y1 + 0.5) / 4
        dx, dy = bx - ax, by - ay
        steps = max(1, int(max(abs(dx), abs(dy)) * 2))
        for step in range(steps + 1):
            t = step / steps
            cx, cy = round(ax + dx * t), round(ay + dy * t)
            for ox, oy in offsets:
                px, py = cx + ox, cy + oy
                if 0 <= px < mask_width and 0 <= py < mask_height:
                    mask[py * mask_width + px] = 1

    previous = None
    for raw in positions:
        try:
            point = {"x": float(raw["x"]), "y": float(raw["y"]), "time": float(raw.get("time", 0)), "teleport": raw.get("teleport") is True}
        except (KeyError, TypeError, ValueError, OverflowError):
            previous = None
            continue
        if not (0 <= point["x"] < width and 0 <= point["y"] < height):
            previous = None
            continue
        if previous is None:
            if not point["teleport"]:
                mark_point(point["x"], point["y"])
        else:
            elapsed = point["time"] - previous["time"]
            distance = math.hypot(point["x"] - previous["x"], point["y"] - previous["y"])
            teleport = (
                point["teleport"]
                or distance > max(1000, width * 0.35)
                or (distance >= 250 and elapsed <= 15 and distance / max(elapsed, 1) >= 45)
            )
            if not teleport and elapsed > 0:
                mark_segment(previous["x"], previous["y"], point["x"], point["y"])
        previous = point

    for tile in visited_tiles:
        try:
            x_text, y_text = str(tile).split(",", 1)
            x, y = int(x_text), int(y_text)
        except (TypeError, ValueError):
            continue
        if 0 <= x < width and 0 <= y < height:
            mark_point(x, y)


def _encode_player_map_rows(mask: bytearray, mask_width: int, mask_height: int, width: int, height: int) -> bytes:
    """Encode a binary explored mask as Terraria row runs (tile class 1)."""
    output = bytearray()

    def emit_run(target: bytearray, tile_class: int, length: int) -> None:
        repeat = length - 1
        flags = tile_class << 1
        if repeat:
            flags |= 0x40 if repeat <= 255 else 0x80
        target.append(flags)
        if tile_class == 1:
            target.append(0)  # palette entry zero: valid and portable across map headers
        if repeat:
            target.extend((repeat.to_bytes(1, "little") if flags & 0x40 else struct.pack("<H", repeat)))

    for mask_y in range(mask_height):
        runs: list[tuple[int, int]] = []
        x = 0
        for mask_x in range(mask_width):
            state = 1 if mask[mask_y * mask_width + mask_x] else 0
            run = min(4, width - x * 4)
            if run <= 0:
                break
            if runs and runs[-1][0] == state:
                runs[-1] = (state, runs[-1][1] + run)
            else:
                runs.append((state, run))
            x += 1
        row = bytearray()
        for tile_class, run_length in runs:
            emit_run(row, tile_class, run_length)
        repeat_rows = min(4, height - mask_y * 4)
        for _ in range(repeat_rows):
            output.extend(row)
    return bytes(output)


def _decode_player_map(data: bytes) -> tuple[dict[str, Any], bytes, int]:
    """Decode explored tiles from a Terraria character .map into a quarter-scale PNG mask."""
    if len(data) > 32 * 1024 * 1024 or len(data) < 64:
        raise ValueError("Размер файла карты недопустим.")
    offset = 0
    version = struct.unpack_from("<I", data, offset)[0]; offset += 4
    if data[offset:offset + 8] != b"relogic\x01":
        raise ValueError("Это не файл карты Terraria (.map).")
    offset += 8 + 4 + 8
    name_length = 0
    shift = 0
    while True:
        byte = data[offset]; offset += 1
        name_length |= (byte & 0x7F) << shift
        if not byte & 0x80:
            break
        shift += 7
        if shift > 28:
            raise ValueError("Повреждено имя мира в заголовке карты.")
    world_name = data[offset:offset + name_length].decode("utf-8", errors="replace"); offset += name_length
    world_id, height, width = struct.unpack_from("<III", data, offset); offset += 12
    if width < 1 or height < 1 or width > 12000 or height > 6000:
        raise ValueError("Размер мира в файле карты недопустим.")
    mask_width, mask_height = (width + 3) // 4, (height + 3) // 4
    rgba = bytearray(mask_width * mask_height * 4)
    opened_tiles = 0

    def decode_rows(raw: bytes, paint: bool) -> tuple[bool, int]:
        nonlocal opened_tiles
        cursor = 0
        for y in range(height):
            x = 0
            while x < width:
                if cursor >= len(raw):
                    return False, cursor
                flags = raw[cursor]; cursor += 1
                tile_class = (flags >> 1) & 7
                if flags & 1:
                    cursor += 1
                if tile_class in (1, 2, 7):
                    cursor += 2 if flags & 0x10 else 1
                if flags & 0x20:
                    cursor += 1
                if flags & 0x40:
                    if cursor >= len(raw): return False, cursor
                    repeat = raw[cursor]; cursor += 1
                elif flags & 0x80:
                    if cursor + 2 > len(raw): return False, cursor
                    repeat = struct.unpack_from("<H", raw, cursor)[0]; cursor += 2
                else:
                    repeat = 0
                run = repeat + 1
                if run < 1 or x + run > width:
                    return False, cursor
                if paint and tile_class > 0:
                    opened_tiles += run
                    yy = y // 4
                    first, last = x // 4, (x + run - 1) // 4
                    row_start = yy * mask_width * 4
                    for mx in range(first, last + 1):
                        pixel = row_start + mx * 4
                        rgba[pixel:pixel + 4] = b"\xff\xff\xff\xff"
                x += run
                if repeat and (flags & 0x20) and tile_class > 0:
                    cursor += repeat
                if cursor > len(raw):
                    return False, cursor
        return cursor == len(raw), cursor

    # Modern Terraria map headers add variant metadata before a raw DEFLATE stream.
    # Locate the stream by validating the first complete row, then validate all rows.
    stream_start = None
    raw_map = None
    for candidate in range(offset, min(len(data) - 8, offset + 4096)):
        try:
            decoder = zlib.decompressobj(-15)
            prefix = decoder.decompress(data[candidate:], 65536)
            # The bounded prefix ends before all rows, so validate the first row separately.
            cursor = 0; row_width = 0
            while row_width < width and cursor < len(prefix):
                flags = prefix[cursor]; cursor += 1
                tile_class = (flags >> 1) & 7
                if flags & 1: cursor += 1
                if tile_class in (1, 2, 7): cursor += 2 if flags & 0x10 else 1
                if flags & 0x20: cursor += 1
                if flags & 0x40:
                    repeat = prefix[cursor]; cursor += 1
                elif flags & 0x80:
                    repeat = int.from_bytes(prefix[cursor:cursor + 2], "little"); cursor += 2
                else: repeat = 0
                row_width += repeat + 1
                if repeat and (flags & 0x20) and tile_class > 0: cursor += repeat
                if row_width > width: break
            if row_width == width:
                full_decoder = zlib.decompressobj(-15)
                raw_map = full_decoder.decompress(data[candidate:])
                opened_tiles = 0
                rgba[:] = b"\0" * len(rgba)
                exact, consumed = decode_rows(raw_map, True)
                if exact and full_decoder.eof:
                    stream_start = candidate
                    break
                rgba[:] = b"\0" * len(rgba)
        except (IndexError, ValueError, zlib.error, struct.error):
            continue
    if stream_start is None or raw_map is None:
        raise ValueError("Не удалось распознать данные открытия карты в .map.")
    scanlines = bytearray()
    stride = mask_width * 4
    for y in range(mask_height):
        scanlines.append(0)
        scanlines.extend(rgba[y * stride:(y + 1) * stride])
    png = b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", mask_width, mask_height, 8, 6, 0, 0, 0)) + _png_chunk(b"IDAT", zlib.compress(scanlines, 6)) + _png_chunk(b"IEND", b"")
    return {"version": version, "world_name": world_name, "world_id": world_id, "width": width, "height": height, "mask_width": mask_width, "mask_height": mask_height, "stream_offset": stream_start}, png, opened_tiles


def _is_valid_player_name(value: Any) -> bool:
    name = " ".join(str(value or "").split())
    return bool(name) and name.casefold() not in PLAYER_NAME_PLACEHOLDERS
