"""Extract compact NPC portraits and add the map's pixel outline."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from .xnb_texture import XnbTextureReader


class NpcSpriteRenderer:
    """Render either a registered NPC head icon or a crop from its body sheet."""

    def __init__(self, texture_reader: XnbTextureReader | None = None, outline_radius: int = 1) -> None:
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

        if head_texture:
            # Registered NPC head icons can be wider than they are tall (slimes
            # are a common example), so keep the complete source frame intact.
            portrait = frame
        else:
            # Body-sheet fallbacks use a square crop around the top of humanoid NPCs.
            portrait_size = min(width, max(12, (height * 44 + 99) // 100))
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

        # Outline the visible sprite silhouette, rather than its rectangular canvas.
        source_alpha = sprite.getchannel("A")
        solid_shape = source_alpha.point(lambda value: 255 if value else 0)
        solid_shape = self._fill_enclosed_transparency(solid_shape)

        output_size = (sprite.width + radius * 2, sprite.height + radius * 2)
        expanded_shape = Image.new("L", output_size, 0)
        expanded_shape.paste(solid_shape, (radius, radius))
        expanded_shape = expanded_shape.filter(ImageFilter.MaxFilter(radius * 2 + 1))

        original_shape = Image.new("L", output_size, 0)
        original_shape.paste(solid_shape, (radius, radius))
        outline_alpha = ImageChops.subtract(expanded_shape, original_shape)

        result = Image.new("RGBA", output_size, (255, 255, 255, 0))
        result.putalpha(outline_alpha)
        result.alpha_composite(sprite, (radius, radius))
        return result

    @staticmethod
    def _fill_enclosed_transparency(mask: Image.Image) -> Image.Image:
        """Mark enclosed transparent pixels as part of the silhouette."""
        pixels = mask.load()
        width, height = mask.size
        exterior = 128

        # Flood-fill every transparent region connected to the canvas edge. Any
        # transparent pixels left afterward are holes inside the face silhouette.
        edge_points = (
            [(x, 0) for x in range(width)]
            + [(x, height - 1) for x in range(width)]
            + [(0, y) for y in range(height)]
            + [(width - 1, y) for y in range(height)]
        )
        for point in edge_points:
            if pixels[point] == 0:
                ImageDraw.floodfill(mask, point, exterior, thresh=0)

        return mask.point(lambda value: 0 if value == exterior else 255)
