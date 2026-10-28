# Terraria sprite renderer

The Viewer renders player portraits, NPC/boss heads, and map item icons in a
pure-Python package. It reads the same local Terraria `.xnb` and mod-exported
PNG textures as before, then writes cached PNGs under the Viewer data folder.
The tModLoader mod remains C#; this package only replaces the separate Java
image helper.

`XnbTextureReader` validates the XNB header, asset reader table, dimensions,
pixel format, and byte count before returning RGBA pixels. For compressed XNB
assets it strips the 32 KiB frame headers and decodes the LZX stream in
Python. Player layers are composited in their existing order, NPC textures are
cropped to a head portrait and receive the pixel outline, and map item textures
are trimmed to visible pixels.

Pillow is the only added runtime dependency. It reads mod-exported PNGs and
writes the cached output; LZX decoding and the source-over pixel compositor
are Python code. Java and `javac` are no longer needed to start the Viewer or
generate these sprites.

The LZX decoder is distributed under the MIT license. Its required license
notice is included as `LICENSE-lzx.txt`.
