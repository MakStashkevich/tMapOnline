"""Extract compact NPC portraits and add the map's pixel outline."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

from .xnb_texture import XnbTextureReader


class NpcSpriteRenderer:
    """Render either a registered NPC head icon or a crop from its body sheet."""

    def __init__(self, texture_reader: XnbTextureReader | None = None, outline_radius: int = 2) -> None:
        self._texture_reader = texture_reader or XnbTextureReader()
        self._outline_radius = max(0, outline_radius)

    def render(
        self,
        source_path: Path,
        output_path: Path,
        frame_width: int,
        frame_height: int,
        head_texture: bool,
    ) -> None:
        """Crop the first visible frame, make a head-sized icon, and save it."""
        sheet = self._texture_reader.read(source_path).to_image()
        width = sheet.width if head_texture else min(sheet.width, frame_width)
        height = sheet.height if head_texture else min(sheet.height, frame_height)
        if width < 1 or height < 1:
            raise ValueError("NPC sprite frame is empty")

        frame = self._first_visible_frame(sheet, width, height)
        if frame is None:
            raise ValueError("NPC texture has no visible frame")

        # Head-sheet entries are complete portraits; body textures need a square top crop.
        portrait_size = min(width, height) if head_texture else min(width, max(12, (height * 44 + 99) // 100))
        portrait_size = min(portrait_size, height)
        crop_left = max(0, (width - portrait_size) // 2)
        portrait = frame.crop((crop_left, 0, crop_left + portrait_size, portrait_size))
        alpha_bounds = portrait.getchannel("A").getbbox()
        if alpha_bounds is None:
            raise ValueError("NPC sprite frame is transparent")

        portrait = portrait.crop(alpha_bounds)
        outlined = self._add_pixel_outline(portrait)
        output_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        outlined.save(output_path, format="PNG")

    @staticmethod
    def _first_visible_frame(sheet: Image.Image, width: int, height: int) -> Image.Image | None:
        for y in range(0, sheet.height - height + 1, height):
            for x in range(0, sheet.width - width + 1, width):
                frame = sheet.crop((x, y, x + width, y + height))
                if frame.getchannel("A").getbbox() is not None:
                    return frame
        return None

    def _add_pixel_outline(self, sprite: Image.Image) -> Image.Image:
        radius = self._outline_radius
        if radius == 0:
            return sprite
        outlined = Image.new(
            "RGBA",
            (sprite.width + radius * 2, sprite.height + radius * 2),
            (255, 255, 255, 0),
        )
        source_alpha = sprite.getchannel("A").tobytes()  # pyright: ignore[reportUnknownMemberType]
        binary_alpha = bytes(255 if value else 0 for value in source_alpha)
        alpha = Image.frombytes("L", sprite.size, binary_alpha)  # pyright: ignore[reportUnknownMemberType]
        outline_alpha = Image.new("L", outlined.size, 0)
        for offset_y in range(-radius, radius + 1):
            for offset_x in range(-radius, radius + 1):
                if offset_x == 0 and offset_y == 0:
                    continue
                shifted = Image.new("L", outlined.size, 0)
                shifted.paste(alpha, (radius + offset_x, radius + offset_y))
                base_pixels = outline_alpha.tobytes()  # pyright: ignore[reportUnknownMemberType]
                shifted_pixels = shifted.tobytes()  # pyright: ignore[reportUnknownMemberType]
                outline_pixels = bytes(max(left, right) for left, right in zip(base_pixels, shifted_pixels))
                outline_alpha = Image.frombytes(  # pyright: ignore[reportUnknownMemberType]
                    "L",
                    outlined.size,
                    outline_pixels,
                )
        outlined.putalpha(outline_alpha)
        outlined.paste(sprite, (radius, radius))
        return outlined
