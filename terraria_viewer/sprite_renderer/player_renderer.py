"""Compose Terraria player appearances into small transparent portraits."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from .xnb_texture import XnbTextureReader


@dataclass(frozen=True)
class PlayerAppearance:
    """The appearance layers and colors needed to render one player head."""

    skin_variant: int
    hair_id: int
    head_id: int
    hair_color: tuple[int, int, int]
    skin_color: tuple[int, int, int]
    eye_color: tuple[int, int, int]
    full_hair: bool = False
    hat_hair: bool = False
    hide_hair: bool = False
    back_hair_draw: bool = True
    back_hair_without_headgear: bool = False
    mod_head_texture: Path | None = None
    mod_face_texture: Path | None = None
    mod_beard_texture: Path | None = None


class PlayerSpriteRenderer:
    """Build head portraits by compositing Terraria's own texture layers."""

    _FRAME_WIDTH = 40
    _FRAME_HEIGHT = 56
    _OPAQUE_WHITE = (255, 255, 255)

    def __init__(self, texture_reader: XnbTextureReader | None = None) -> None:
        self._texture_reader = texture_reader or XnbTextureReader()

    def render(self, images_directory: Path, output_path: Path, appearance: PlayerAppearance) -> None:
        """Write one transparent player portrait to the requested PNG path."""
        canvas = Image.new("RGBA", (self._FRAME_WIDTH, self._FRAME_HEIGHT), (0, 0, 0, 0))
        has_headgear = appearance.head_id >= 0

        if (
            appearance.hair_id >= 0
            and not appearance.hide_hair
            and appearance.back_hair_draw
            and (not has_headgear or appearance.full_hair or appearance.back_hair_without_headgear)
        ):
            back_hair = self._read_frame(images_directory / f"Player_Hair_{appearance.hair_id}.xnb")
            self._composite(canvas, back_hair, appearance.hair_color)

        texture_set = 10 if appearance.skin_variant >= 10 else 0
        face = self._read_frame(images_directory / f"Player_{texture_set}_0.xnb")
        eyes_white = self._read_frame(images_directory / f"Player_{texture_set}_1.xnb")
        eyes = self._read_frame(images_directory / f"Player_{texture_set}_2.xnb")
        self._composite(canvas, face, appearance.skin_color)
        self._composite(canvas, eyes_white, self._OPAQUE_WHITE)
        self._composite(canvas, eyes, appearance.eye_color)

        if appearance.head_id >= 0:
            headgear_path = appearance.mod_head_texture or images_directory / f"Armor_Head_{appearance.head_id}.xnb"
            self._composite(canvas, self._read_frame(headgear_path), self._OPAQUE_WHITE, preserve_source_color=True)

        if appearance.hair_id >= 0 and not appearance.hide_hair and (
            appearance.full_hair or appearance.hat_hair or not has_headgear
        ):
            hair_prefix = "Player_HairAlt_" if appearance.hat_hair else "Player_Hair_"
            front_hair = self._read_frame(images_directory / f"{hair_prefix}{appearance.hair_id}.xnb")
            self._composite(canvas, front_hair, appearance.hair_color)

        for optional_layer in (appearance.mod_beard_texture, appearance.mod_face_texture):
            if optional_layer is not None:
                try:
                    self._composite(canvas, self._read_frame(optional_layer), self._OPAQUE_WHITE, True)
                except (OSError, ValueError):
                    # Optional mod accessories should not hide the base portrait.
                    continue

        cropped = self._crop_transparent_bounds(canvas)
        output_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        cropped.save(output_path, format="PNG")

    def _read_frame(self, path: Path) -> Image.Image:
        texture = self._texture_reader.read(path).to_image()
        if texture.width < self._FRAME_WIDTH or texture.height < self._FRAME_HEIGHT:
            raise ValueError(f"Player texture frame is too small: {path.name}")
        return texture.crop((0, 0, self._FRAME_WIDTH, self._FRAME_HEIGHT))

    @staticmethod
    def _composite(
        destination: Image.Image,
        source: Image.Image,
        tint: tuple[int, int, int],
        preserve_source_color: bool = False,
    ) -> None:
        """Apply source-over blending with integer rounding matching the Java renderer."""
        destination_bytes = destination.tobytes()  # pyright: ignore[reportUnknownMemberType]
        source_pixels = source.tobytes()  # pyright: ignore[reportUnknownMemberType]
        destination_pixels = bytearray(destination_bytes)
        for y in range(min(destination.height, source.height)):
            for x in range(min(destination.width, source.width)):
                offset = (y * source.width + x) * 4
                red, green, blue, source_alpha = source_pixels[offset:offset + 4]
                if source_alpha == 0:
                    continue
                if not preserve_source_color:
                    red = red * tint[0] // 255
                    green = green * tint[1] // 255
                    blue = blue * tint[2] // 255

                target_offset = (y * destination.width + x) * 4
                target_red, target_green, target_blue, target_alpha = destination_pixels[
                    target_offset:target_offset + 4
                ]
                output_alpha = source_alpha + target_alpha * (255 - source_alpha) // 255
                if output_alpha == 0:
                    continue
                inverse_source_alpha = 255 - source_alpha
                output_red = (
                    red * source_alpha + target_red * target_alpha * inverse_source_alpha // 255
                ) // output_alpha
                output_green = (
                    green * source_alpha + target_green * target_alpha * inverse_source_alpha // 255
                ) // output_alpha
                output_blue = (
                    blue * source_alpha + target_blue * target_alpha * inverse_source_alpha // 255
                ) // output_alpha
                destination_pixels[target_offset:target_offset + 4] = bytes(
                    (output_red, output_green, output_blue, output_alpha)
                )
        destination.frombytes(bytes(destination_pixels))  # pyright: ignore[reportUnknownMemberType]

    @staticmethod
    def _crop_transparent_bounds(image: Image.Image) -> Image.Image:
        bounds = image.getchannel("A").getbbox()
        return image.crop(bounds) if bounds is not None else image
