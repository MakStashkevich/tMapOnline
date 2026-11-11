"""Read Terraria Texture2D assets from PNG or XNB files."""

from __future__ import annotations

import struct
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from PIL import Image

from .lzx import LZXDecoder


@dataclass(frozen=True)
class TerrariaTexture:
    """Immutable RGBA texture decoded from a Terraria asset."""

    width: int
    height: int
    pixels: bytes

    def to_image(self) -> Image.Image:
        """Create a Pillow image without changing the pixel bytes."""
        return Image.frombytes("RGBA", (self.width, self.height), self.pixels)  # pyright: ignore[reportUnknownMemberType]


class _BinaryReader:
    """Read bounded little-endian values from an XNB payload."""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.position = 0

    def read(self, length: int) -> bytes:
        end = self.position + length
        if length < 0 or end > len(self.data):
            raise ValueError("XNB texture data is truncated")
        value = self.data[self.position:end]
        self.position = end
        return value

    def read_int32(self) -> int:
        return struct.unpack("<i", self.read(4))[0]

    def read_7bit_int(self) -> int:
        value = 0
        shift = 0
        while shift <= 28:
            current = self.read(1)[0]
            value |= (current & 0x7F) << shift
            if current < 0x80:
                return value
            shift += 7
        raise ValueError("Malformed XNB variable-length integer")

    def read_string(self) -> str:
        length = self.read_7bit_int()
        if length > 1_048_576:
            raise ValueError("XNB reader name is unreasonably long")
        return self.read(length).decode("utf-8")


class XnbTextureReader:
    """Decode the XNB Texture2D subset used by Terraria's image assets."""

    _MAX_TEXTURE_BYTES = 256 * 1024 * 1024
    _READER_NAME = "Microsoft.Xna.Framework.Content.Texture2DReader"

    def read(self, path: Path) -> TerrariaTexture:
        """Load a PNG directly or parse one supported XNB Texture2D asset."""
        if not path.is_file():
            raise FileNotFoundError(f"Missing Terraria texture: {path.name}")
        stat = path.stat()
        return self._read_cached(str(path.resolve()), stat.st_mtime_ns, stat.st_size)

    @lru_cache(maxsize=64)
    def _read_cached(self, path_string: str, modified_ns: int, size_bytes: int) -> TerrariaTexture:
        """Reuse decoded textures, invalidating entries when a source file changes."""
        del modified_ns, size_bytes
        path = Path(path_string)
        if path.suffix.lower() == ".png":
            with Image.open(path) as image:
                rgba = image.convert("RGBA")
                pixels = rgba.tobytes()  # pyright: ignore[reportUnknownMemberType]
                return TerrariaTexture(rgba.width, rgba.height, pixels)
        return self._read_xnb(path.read_bytes())

    def _read_xnb(self, data: bytes) -> TerrariaTexture:
        if len(data) < 14 or data[:3] != b"XNB":
            raise ValueError("Not a valid XNB texture")
        if data[3:4] != b"w":
            raise ValueError("Only Windows XNB texture assets are supported")
        if data[4] != 5:
            raise ValueError(f"Unsupported XNB version: {data[4]}")

        flags = data[5]
        declared_file_size = struct.unpack_from("<I", data, 6)[0]
        if declared_file_size != len(data):
            raise ValueError("XNB file size header does not match the file")

        if flags & 0x80:
            expected_size = struct.unpack_from("<I", data, 10)[0]
            if expected_size <= 0 or expected_size > self._MAX_TEXTURE_BYTES:
                raise ValueError("XNB decompressed data size is invalid")
            payload = self._decompress_xnb_lzx(data[14:], expected_size)
        else:
            payload = data[10:]

        return self._read_texture_payload(payload)

    def _decompress_xnb_lzx(self, payload: bytes, expected_size: int) -> bytes:
        """Strip XNB frame headers and decode their concatenated LZX stream."""
        offset = 0
        frame_sizes: list[int] = []
        compressed_frames: list[bytes] = []
        decoded_size = 0

        while offset < len(payload):
            if offset + 2 > len(payload):
                raise ValueError("Incomplete XNB LZX frame header")
            first, second = payload[offset], payload[offset + 1]
            offset += 2

            if first == 0xFF:
                if offset + 3 > len(payload):
                    raise ValueError("Incomplete extended XNB LZX frame header")
                frame_size = (second << 8) | payload[offset]
                compressed_size = (payload[offset + 1] << 8) | payload[offset + 2]
                offset += 3
            else:
                frame_size = 0x8000
                compressed_size = (first << 8) | second

            if frame_size == 0 or compressed_size == 0:
                break
            end = offset + compressed_size
            if end > len(payload):
                raise ValueError("XNB LZX frame exceeds the file boundary")
            frame_sizes.append(frame_size)
            compressed_frames.append(payload[offset:end])
            decoded_size += frame_size
            offset = end

        if not compressed_frames or decoded_size != expected_size:
            raise ValueError("XNB LZX frame sizes do not match the declared data size")

        decoder = LZXDecoder(window_bits=16)
        result = decoder.decompress(b"".join(compressed_frames), expected_size)
        if len(result) != expected_size:
            raise ValueError("XNB LZX decoder returned an incomplete texture")
        return result

    def _read_texture_payload(self, payload: bytes) -> TerrariaTexture:
        reader = _BinaryReader(payload)
        reader_count = reader.read_7bit_int()
        if not 1 <= reader_count <= 64:
            raise ValueError("XNB texture reader table is invalid")

        reader_names: list[str] = []
        for _ in range(reader_count):
            reader_names.append(reader.read_string())
            reader.read_int32()
        if not reader_names[0].startswith(self._READER_NAME):
            raise ValueError("XNB asset is not a Texture2D")

        shared_resources = reader.read_7bit_int()
        asset_count = reader.read_7bit_int()
        if shared_resources != 0 or asset_count != 1:
            raise ValueError("XNB texture has unexpected asset references")

        format_id = reader.read_int32()
        width = reader.read_int32()
        height = reader.read_int32()
        mipmaps = reader.read_int32()
        if format_id != 0 or mipmaps != 1:
            raise ValueError("Unsupported Terraria Texture2D format")
        if width <= 0 or height <= 0 or width * height * 4 > self._MAX_TEXTURE_BYTES:
            raise ValueError("XNB texture dimensions are invalid")

        data_length = reader.read_int32()
        expected_length = width * height * 4
        if data_length != expected_length:
            raise ValueError("XNB RGBA texture data length does not match dimensions")
        return TerrariaTexture(width, height, reader.read(data_length))
