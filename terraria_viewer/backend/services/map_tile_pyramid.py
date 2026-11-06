"""Build and cache map tiles at the resolution requested by the browser."""

from __future__ import annotations

import base64
import hashlib
import os
import tempfile
import time
import zlib
from collections import OrderedDict
from io import BytesIO
from pathlib import Path
from threading import Lock
from typing import Any, Iterable, cast

from PIL import Image


class MapTilePyramid:
    """Compose only the requested world rectangle, then downsample it to one tile."""

    TILE_SIZE = 256
    CHUNK_SIZE = 64
    CACHE_FORMAT_VERSION = 1

    def __init__(
        self,
        cache_limit: int = 128,
        cache_byte_limit: int = 32 * 1024 * 1024,
        disk_cache_directory: Path | None = None,
        disk_cache_byte_limit: int = 512 * 1024 * 1024,
    ) -> None:
        self._cache_limit = cache_limit
        self._cache_byte_limit = cache_byte_limit
        self._disk_cache_directory = disk_cache_directory
        self._disk_cache_byte_limit = disk_cache_byte_limit
        self._cache: OrderedDict[str, bytes] = OrderedDict()
        self._cache_bytes = 0
        self._disk_cache_bytes = 0
        self._disk_cache_entries = 0
        self._cache_hits = 0
        self._cache_misses = 0
        self._cache_evictions = 0
        self._disk_cache_hits = 0
        self._disk_cache_misses = 0
        self._disk_cache_evictions = 0
        self._render_count = 0
        self._last_render_ms = 0.0
        self._lock = Lock()
        self._disk_lock = Lock()
        if self._disk_cache_directory is not None:
            self._initialize_disk_cache()

    def _initialize_disk_cache(self) -> None:
        directory = self._disk_cache_directory
        if directory is None:
            return
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        entries = list(directory.glob("*.png"))
        self._disk_cache_entries = len(entries)
        for path in entries:
            try:
                self._disk_cache_bytes += path.stat().st_size
            except OSError:
                continue
        self._evict_disk_cache_if_needed()

    def get_metrics(self) -> dict[str, int | float]:
        """Return bounded-cache and last-render metrics for the debug view."""
        with self._lock:
            return {
                "entries": len(self._cache),
                "bytes": self._cache_bytes,
                "byte_limit": self._cache_byte_limit,
                "hits": self._cache_hits,
                "misses": self._cache_misses,
                "evictions": self._cache_evictions,
                "renders": self._render_count,
                "last_render_ms": round(self._last_render_ms, 2),
                "disk_entries": self._disk_cache_entries,
                "disk_bytes": self._disk_cache_bytes,
                "disk_byte_limit": self._disk_cache_byte_limit,
                "disk_hits": self._disk_cache_hits,
                "disk_misses": self._disk_cache_misses,
                "disk_evictions": self._disk_cache_evictions,
            }

    def _disk_path(self, cache_key: str) -> Path | None:
        if self._disk_cache_directory is None:
            return None
        versioned_key = f"{self.CACHE_FORMAT_VERSION}:{cache_key}"
        filename = hashlib.blake2b(versioned_key.encode("utf-8"), digest_size=20).hexdigest()
        return self._disk_cache_directory / f"{filename}.png"

    def _read_disk_cache(self, cache_key: str) -> bytes | None:
        path = self._disk_path(cache_key)
        if path is None:
            return None
        with self._disk_lock:
            try:
                tile = path.read_bytes()
            except FileNotFoundError:
                with self._lock:
                    self._disk_cache_misses += 1
                return None
            except OSError:
                with self._lock:
                    self._disk_cache_misses += 1
                return None
            if not tile.startswith(b"\x89PNG\r\n\x1a\n"):
                try:
                    path.unlink()
                except OSError:
                    pass
                with self._lock:
                    self._disk_cache_entries = max(0, self._disk_cache_entries - 1)
                    self._disk_cache_bytes = max(0, self._disk_cache_bytes - len(tile))
                    self._disk_cache_misses += 1
                return None
            try:
                os.utime(path, None)
            except OSError:
                pass
        with self._lock:
            self._disk_cache_hits += 1
        return tile

    def _write_disk_cache(self, cache_key: str, tile: bytes) -> None:
        path = self._disk_path(cache_key)
        if path is None or len(tile) > self._disk_cache_byte_limit:
            return
        with self._disk_lock:
            try:
                previous_size = path.stat().st_size
            except OSError:
                previous_size = 0
            temporary_path: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="wb", dir=path.parent, prefix=".map-tile-", suffix=".tmp", delete=False
                ) as temporary:
                    temporary.write(tile)
                    temporary_path = Path(temporary.name)
                os.replace(temporary_path, path)
            except OSError:
                if temporary_path is not None:
                    try:
                        temporary_path.unlink()
                    except OSError:
                        pass
                return

            with self._lock:
                if previous_size == 0:
                    self._disk_cache_entries += 1
                self._disk_cache_bytes += len(tile) - previous_size
            self._evict_disk_cache_if_needed()

    def _evict_disk_cache_if_needed(self) -> None:
        if self._disk_cache_bytes <= self._disk_cache_byte_limit or self._disk_cache_directory is None:
            return
        entries: list[tuple[float, Path, int]] = []
        for path in self._disk_cache_directory.glob("*.png"):
            try:
                stat = path.stat()
            except OSError:
                continue
            entries.append((float(stat.st_mtime), path, int(stat.st_size)))
        entries.sort(key=lambda item: item[0])
        for _, path, size in entries:
            if self._disk_cache_bytes <= self._disk_cache_byte_limit:
                break
            try:
                path.unlink()
            except OSError:
                continue
            with self._lock:
                self._disk_cache_entries = max(0, self._disk_cache_entries - 1)
                self._disk_cache_bytes = max(0, self._disk_cache_bytes - size)
                self._disk_cache_evictions += 1

    def render(
        self,
        cache_key: str,
        world_width: int,
        world_height: int,
        level: int,
        tile_x: int,
        tile_y: int,
        chunks: Iterable[tuple[int, int, str]],
        visibility_mask: bytes | None = None,
    ) -> bytes:
        """Return a PNG tile; higher levels cover larger world rectangles."""
        with self._lock:
            cached = self._cache.get(cache_key)
            if cached is not None:
                self._cache_hits += 1
                self._cache.move_to_end(cache_key)
                return cached
            self._cache_misses += 1

        cached = self._read_disk_cache(cache_key)
        if cached is not None:
            with self._lock:
                previous = self._cache.pop(cache_key, None)
                if previous is not None:
                    self._cache_bytes -= len(previous)
                self._cache[cache_key] = cached
                self._cache_bytes += len(cached)
                while len(self._cache) > self._cache_limit or self._cache_bytes > self._cache_byte_limit:
                    _, evicted = self._cache.popitem(last=False)
                    self._cache_bytes -= len(evicted)
                    self._cache_evictions += 1
            return cached

        started_at = time.perf_counter()

        factor = 1 << max(0, min(level, 8))
        world_left = tile_x * self.TILE_SIZE * factor
        world_top = tile_y * self.TILE_SIZE * factor
        width = max(1, min(self.TILE_SIZE * factor, world_width - world_left))
        height = max(1, min(self.TILE_SIZE * factor, world_height - world_top))
        output_width = max(1, (width + factor - 1) // factor)
        output_height = max(1, (height + factor - 1) // factor)
        output = Image.new("RGBA", (output_width, output_height), (0, 0, 0, 0))
        output_pixels = cast(Any, output.load())

        # Match Pillow's nearest-neighbour downsampling while keeping only the
        # final 256x256 tile in memory, even when a coarse tile covers the world.
        sample_x = [world_left + (index * width // output_width) for index in range(output_width)]
        sample_y = [world_top + (index * height // output_height) for index in range(output_height)]
        output_x_by_chunk: dict[int, list[tuple[int, int]]] = {}
        output_y_by_chunk: dict[int, list[tuple[int, int]]] = {}
        for output_x, world_x in enumerate(sample_x):
            chunk_x = world_x // self.CHUNK_SIZE
            output_x_by_chunk.setdefault(chunk_x, []).append(
                (output_x, world_x % self.CHUNK_SIZE)
            )
        for output_y, world_y in enumerate(sample_y):
            chunk_y = world_y // self.CHUNK_SIZE
            output_y_by_chunk.setdefault(chunk_y, []).append(
                (output_y, world_y % self.CHUNK_SIZE)
            )

        for chunk_x, chunk_y, encoded in chunks:
            tile_x_samples = output_x_by_chunk.get(chunk_x)
            tile_y_samples = output_y_by_chunk.get(chunk_y)
            if not tile_x_samples or not tile_y_samples:
                continue

            try:
                pixels = zlib.decompress(base64.b64decode(encoded, validate=True))
                if len(pixels) != self.CHUNK_SIZE * self.CHUNK_SIZE * 4:
                    continue
                # Pillow's runtime module exposes this factory with incomplete
                # stubs, so keep the untyped boundary local to this call.
                image_factory = cast(Any, Image)
                chunk = image_factory.frombytes(
                    "RGBA", (self.CHUNK_SIZE, self.CHUNK_SIZE), pixels
                )
            except (ValueError, zlib.error):
                continue

            chunk_pixels = chunk.load()
            for output_y, source_y in tile_y_samples:
                for output_x, source_x in tile_x_samples:
                    source_color = chunk_pixels[source_x, source_y]
                    source_alpha = source_color[3]
                    if source_alpha == 255:
                        output_pixels[output_x, output_y] = source_color
                        continue
                    if source_alpha == 0:
                        continue

                    destination_color = output_pixels[output_x, output_y]
                    destination_alpha = destination_color[3]
                    output_alpha = source_alpha + destination_alpha * (255 - source_alpha) // 255
                    if output_alpha == 0:
                        output_pixels[output_x, output_y] = (0, 0, 0, 0)
                        continue

                    # Composite transparent layers over the existing world pixel.
                    destination_weight = destination_alpha * (255 - source_alpha)
                    output_pixels[output_x, output_y] = (
                        (source_color[0] * source_alpha * 255 + destination_color[0] * destination_weight)
                        // (output_alpha * 255),
                        (source_color[1] * source_alpha * 255 + destination_color[1] * destination_weight)
                        // (output_alpha * 255),
                        (source_color[2] * source_alpha * 255 + destination_color[2] * destination_weight)
                        // (output_alpha * 255),
                        output_alpha,
                    )
            chunk.close()

        mask_width = (world_width + 3) // 4
        mask_height = (world_height + 3) // 4
        if visibility_mask is not None and len(visibility_mask) == mask_width * mask_height:
            for output_y, world_y in enumerate(sample_y):
                mask_row = min(mask_height - 1, world_y // 4) * mask_width
                for output_x, world_x in enumerate(sample_x):
                    visibility = visibility_mask[mask_row + min(mask_width - 1, world_x // 4)]
                    if visibility == 0:
                        output_pixels[output_x, output_y] = (5, 9, 13, 255)
                    elif visibility < 255:
                        color = output_pixels[output_x, output_y]
                        output_pixels[output_x, output_y] = (
                            color[0] * visibility // 255,
                            color[1] * visibility // 255,
                            color[2] * visibility // 255,
                            color[3],
                        )

        try:
            buffer = BytesIO()
            output.save(buffer, format="PNG", optimize=False)
            tile = buffer.getvalue()
            output.close()
        except BaseException:
            output.close()
            raise

        with self._lock:
            self._render_count += 1
            self._last_render_ms = (time.perf_counter() - started_at) * 1000
            if len(tile) <= self._cache_byte_limit:
                previous = self._cache.pop(cache_key, None)
                if previous is not None:
                    self._cache_bytes -= len(previous)
                self._cache[cache_key] = tile
                self._cache_bytes += len(tile)
                while (
                    len(self._cache) > self._cache_limit
                    or self._cache_bytes > self._cache_byte_limit
                ):
                    _, evicted = self._cache.popitem(last=False)
                    self._cache_bytes -= len(evicted)
                    self._cache_evictions += 1
        self._write_disk_cache(cache_key, tile)
        return tile
