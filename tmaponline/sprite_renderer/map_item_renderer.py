"""Render Terraria map-item icons such as dropped coins."""

from __future__ import annotations

from pathlib import Path

from .xnb_texture import XnbTextureReader


class MapItemSpriteRenderer:
    """Trim transparent edges from map-item textures and save the PNG icon."""

    def __init__(self, texture_reader: XnbTextureReader | None = None) -> None:
        self._texture_reader = texture_reader or XnbTextureReader()

    def render(self, source_path: Path, output_path: Path) -> None:
        texture = self._texture_reader.read(source_path).to_image()
        bounds = texture.getchannel("A").getbbox()
        if bounds is None:
            raise ValueError("Item texture is fully transparent")
        output_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        texture.crop(bounds).save(output_path, format="PNG")
