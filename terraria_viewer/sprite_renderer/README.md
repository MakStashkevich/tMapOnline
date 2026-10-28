# Terraria player sprite renderer

This headless Java helper decodes the XNB `Texture2D` player, eye, hair, and armor-head sheets shipped with Terraria, then composites a transparent 40×56 PNG frame from the player's appearance metadata. It uses no GPU and does not launch Terraria. The Python monitor compiles it into `~/Library/Caches/TerrariaTunnel/player-sprite-renderer/` on first use and stores generated player PNGs in `~/Library/Application Support/TerrariaTunnel/player-avatars/`.

The source sprite sheets remain in the user's local Terraria installation and are not copied into this repository. The renderer accepts mod texture PNGs exported by the telemetry mod and applies compatible head, face, and beard layers to the portrait. It keeps the vanilla portrait if an accessory uses a different sprite frame size. Body, legs, and other visible accessory textures are exported and included in appearance metadata, but the current portrait remains head-only.

`LzxDecoder.java` is derived from TExtract's Java LZX decoder and retains its source license header. It is dual-licensed under LGPL-2.1 and MS-PL; copies of both license texts are in `java/licenses/`.

- TExtract: https://github.com/Antag99/TExtract
- Terraria's decompiled `PlayerDrawLayers` and `LegacyPlayerRenderer` informed the layer ordering and 40×56 frame layout.
