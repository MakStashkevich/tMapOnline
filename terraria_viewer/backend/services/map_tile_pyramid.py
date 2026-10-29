"""Build and cache map tiles at the resolution requested by the browser."""

from __future__ import annotations

import base64
import zlib
from collections import OrderedDict
from io import BytesIO
from threading import Lock
from typing import Any, Iterable, cast

from PIL import Image


class MapTilePyramid:
    """Compose only the requested world rectangle, then downsample it to one tile."""

    TILE_SIZE = 256
    CHUNK_SIZE = 64

    def __init__(self, cache_limit: int = 96) -> None:
        self._cache_limit = cache_limit
        self._cache: OrderedDict[str, bytes] = OrderedDict()
        self._lock = Lock()

    def render(
        self,
        cache_key: str,
        world_width: int,
        world_height: int,
        level: int,
        tile_x: int,
        tile_y: int,
        chunks: Iterable[tuple[int, int, str]],
    ) -> bytes:
        """Return a PNG tile; higher levels cover larger world rectangles."""
        with self._lock:
            cached = self._cache.get(cache_key)
            if cached is not None:
                self._cache.move_to_end(cache_key)
                return cached

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

        buffer = BytesIO()
        output.save(buffer, format="PNG", optimize=False)
        tile = buffer.getvalue()
        output.close()

        with self._lock:
            self._cache[cache_key] = tile
            self._cache.move_to_end(cache_key)
            while len(self._cache) > self._cache_limit:
                self._cache.popitem(last=False)
        return tile
