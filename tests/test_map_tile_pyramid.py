from __future__ import annotations

import base64
import zlib
from io import BytesIO
from pathlib import Path
import sys
import unittest
from typing import Any, cast

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from terraria_viewer.backend.services.map_tile_pyramid import MapTilePyramid


class MapTilePyramidTests(unittest.TestCase):
    def setUp(self) -> None:
        red_chunk = bytes((220, 40, 30, 255)) * (64 * 64)
        encoded = base64.b64encode(zlib.compress(red_chunk)).decode("ascii")
        self.chunks = [
            (chunk_x, chunk_y, encoded)
            for chunk_y in range(4)
            for chunk_x in range(4)
        ]

    def test_renders_pixels_and_reuses_the_cached_png(self) -> None:
        pyramid = MapTilePyramid()

        png = pyramid.render("world:0:0:0", 256, 256, 0, 0, 0, self.chunks)
        with Image.open(BytesIO(png)) as image:
            self.assertEqual(image.size, (256, 256))
            pixel = cast(Any, image).getpixel((128, 128))
            self.assertEqual(pixel, (220, 40, 30, 255))

        self.assertEqual(pyramid.render("world:0:0:0", 256, 256, 0, 0, 0, []), png)
        metrics = pyramid.get_metrics()
        self.assertEqual(metrics["entries"], 1)
        self.assertEqual(metrics["hits"], 1)
        self.assertEqual(metrics["renders"], 1)

    def test_png_cache_obeys_byte_budget_and_reports_evictions(self) -> None:
        pyramid = MapTilePyramid(cache_byte_limit=1024)

        first = pyramid.render("first", 256, 256, 0, 0, 0, self.chunks)
        pyramid.render("second", 256, 256, 0, 0, 0, self.chunks)

        metrics = pyramid.get_metrics()
        self.assertLessEqual(metrics["bytes"], metrics["byte_limit"])
        self.assertEqual(metrics["entries"], 1)
        self.assertEqual(metrics["evictions"], 1)
        self.assertGreater(len(first), 0)


if __name__ == "__main__":
    unittest.main()
