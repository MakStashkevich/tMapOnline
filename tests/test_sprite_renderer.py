from __future__ import annotations

import struct
import tempfile
import unittest
import hashlib
import os
from pathlib import Path
from typing import cast

from PIL import Image

from tmaponline.sprite_renderer import (
    MapItemSpriteRenderer,
    NpcSpriteRenderer,
    XnbTextureReader,
)

_TERRARIA_IMAGES = Path(os.environ.get(
    "TERRARIA_CLIENT_IMAGES",
    str(Path.home() / "Library/Application Support/Steam/steamapps/common/Terraria/Terraria.app/Contents/Resources/Content/Images"),
))
_VANILLA_HEAD = _TERRARIA_IMAGES / "NPC_Head_0.xnb"


def get_rgba_pixel(image: Image.Image, position: tuple[int, int]) -> tuple[int, int, int, int]:
    return cast(tuple[int, int, int, int], image.getpixel(position))  # pyright: ignore[reportUnknownMemberType]


def encode_7bit_int(value: int) -> bytes:
    encoded = bytearray()
    while value >= 0x80:
        encoded.append((value & 0x7F) | 0x80)
        value >>= 7
    encoded.append(value)
    return bytes(encoded)


def make_xnb_texture_payload(pixels: bytes, width: int, height: int) -> bytes:
    reader_name = b"Microsoft.Xna.Framework.Content.Texture2DReader, Test"
    return b"".join(
        (
            b"\x01",
            encode_7bit_int(len(reader_name)),
            reader_name,
            struct.pack("<i", 0),
            b"\x00\x01",
            struct.pack("<iiii", 0, width, height, 1),
            struct.pack("<i", len(pixels)),
            pixels,
        )
    )


def make_uncompressed_lzx_block(data: bytes) -> bytes:
    """Build one valid LZX uncompressed block for decoder tests."""
    if len(data) >= 1 << 24:
        raise ValueError("Test LZX block is too large")
    header_bits = "0" + format(3, "03b") + format(len(data), "024b")
    header_bits += "0" * (-len(header_bits) % 16)
    header = b"".join(
        int(header_bits[offset:offset + 16], 2).to_bytes(2, "little")
        for offset in range(0, len(header_bits), 16)
    )
    return header + struct.pack("<III", 1, 1, 1) + data


def make_compressed_xnb(payload: bytes) -> bytes:
    compressed_frame = make_uncompressed_lzx_block(payload)
    frame_header = b"\xff" + len(payload).to_bytes(2, "big") + len(compressed_frame).to_bytes(2, "big")
    frame = frame_header + compressed_frame
    total_size = 14 + len(frame)
    return b"XNBw\x05\x80" + struct.pack("<II", total_size, len(payload)) + frame


class TerrariaSpriteRendererTests(unittest.TestCase):
    @unittest.skipUnless(_VANILLA_HEAD.is_file(), "requires local Terraria XNB textures")
    def test_decodes_real_compressed_terraria_xnb_pixels(self) -> None:
        texture = XnbTextureReader().read(_VANILLA_HEAD)

        self.assertEqual((16, 24), (texture.width, texture.height))
        self.assertEqual(
            "abd37028abdafe95122415637c4a790852bbe30204cb4b5d8cdec5ec4026d6cd",
            hashlib.sha256(texture.pixels).hexdigest(),
        )

    def test_reads_compressed_xnb_texture(self) -> None:
        pixels = bytes((12, 34, 56, 255, 90, 80, 70, 128))
        payload = make_xnb_texture_payload(pixels, width=2, height=1)
        xnb = make_compressed_xnb(payload)

        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "tiny-texture.xnb"
            path.write_bytes(xnb)
            texture = XnbTextureReader().read(path)

        self.assertEqual((2, 1), (texture.width, texture.height))
        self.assertEqual(pixels, texture.pixels)

    def test_map_item_renderer_crops_transparent_padding(self) -> None:
        pixels = bytes(
            (
                0, 0, 0, 0, 14, 28, 42, 255, 0, 0, 0, 0,
                0, 0, 0, 0, 56, 70, 84, 255, 0, 0, 0, 0,
            )
        )
        xnb = make_compressed_xnb(make_xnb_texture_payload(pixels, width=3, height=2))

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "item.xnb"
            output = root / "item.png"
            source.write_bytes(xnb)
            MapItemSpriteRenderer().render(source, output)
            with Image.open(output) as image:
                self.assertEqual((1, 2), image.size)
                self.assertEqual((14, 28, 42, 255), get_rgba_pixel(image, (0, 0)))

    def test_npc_head_keeps_native_pixels_without_a_name_card(self) -> None:
        pixels = bytes((200, 100, 50, 255))
        xnb = make_compressed_xnb(make_xnb_texture_payload(pixels, width=1, height=1))

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "head.xnb"
            output = root / "head.png"
            source.write_bytes(xnb)
            NpcSpriteRenderer().render(source, output, 32, 32, True)
            with Image.open(output) as image:
                self.assertEqual((1, 1), image.size)
                self.assertEqual((200, 100, 50, 255), get_rgba_pixel(image, (0, 0)))


if __name__ == "__main__":
    unittest.main()
