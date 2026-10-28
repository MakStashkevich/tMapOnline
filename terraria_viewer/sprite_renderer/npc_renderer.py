"""Extract native-size NPC head portraits for the map."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

from .xnb_texture import XnbTextureReader


class NpcSpriteRenderer:
    """Render either a registered NPC head icon or a crop from its body sheet."""

    def __init__(self, texture_reader: XnbTextureReader | None = None) -> None:
        self._texture_reader = texture_reader or XnbTextureReader()

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
        if not head_texture:
            alpha_bounds = portrait.getchannel("A").getbbox()
            if alpha_bounds is None:
                raise ValueError("NPC sprite frame is transparent")
            portrait = portrait.crop(alpha_bounds)

        output_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        # Keep the game texture untouched. The browser applies Terraria's two
        # outline passes at the current map scale, just like its map renderer.
        portrait.save(output_path, format="PNG")

    @staticmethod
    def _first_visible_frame(sheet: Image.Image, width: int, height: int) -> Image.Image | None:
        for y in range(0, sheet.height - height + 1, height):
            for x in range(0, sheet.width - width + 1, width):
                frame = sheet.crop((x, y, x + width, y + height))
                if frame.getchannel("A").getbbox() is not None:
                    return frame
        return None
