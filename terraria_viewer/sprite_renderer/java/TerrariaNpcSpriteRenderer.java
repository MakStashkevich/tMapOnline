package com.github.antag99.textract.extract;

import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.imageio.ImageIO;

/** Extracts a head-sized portrait from the first Terraria NPC animation frame. */
public final class TerrariaNpcSpriteRenderer {
    private TerrariaNpcSpriteRenderer() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 5) {
            throw new IllegalArgumentException("usage: <source.xnb-or.png> <output.png> <frame-width> <frame-height> <head-texture>");
        }
        BufferedImage sheet = TerrariaPlayerSpriteRenderer.texture(Path.of(args[0]));
        boolean headTexture = Boolean.parseBoolean(args[4]);
        int width = headTexture ? sheet.getWidth() : Math.min(sheet.getWidth(), Integer.parseInt(args[2]));
        int height = headTexture ? sheet.getHeight() : Math.min(sheet.getHeight(), Integer.parseInt(args[3]));
        if (width < 1 || height < 1) throw new IOException("NPC sprite frame is empty");

        BufferedImage frame = firstVisibleFrame(sheet, width, height);
        if (frame == null) throw new IOException("NPC texture has no visible frame");
        // Registered Terraria NPC/boss head textures are already complete
        // portraits. For other NPCs, approximate the head from the upper body
        // frame and keep a square centered on the sprite rather than clipping
        // an arbitrary top-left corner.
        int portraitSize = headTexture
                ? Math.min(width, height)
                : Math.min(width, Math.max(12, (int) Math.ceil(height * 0.44)));
        portraitSize = Math.min(portraitSize, height);
        int cropLeft = headTexture ? Math.max(0, (width - portraitSize) / 2) : Math.max(0, (width - portraitSize) / 2);
        BufferedImage portrait = frame.getSubimage(cropLeft, 0, portraitSize, portraitSize);

        int left = portraitSize, top = portraitSize, right = -1, bottom = -1;
        for (int y = 0; y < portraitSize; y++) {
            for (int x = 0; x < portraitSize; x++) {
                if ((portrait.getRGB(x, y) >>> 24) == 0) continue;
                left = Math.min(left, x);
                top = Math.min(top, y);
                right = Math.max(right, x);
                bottom = Math.max(bottom, y);
            }
        }
        if (right < left || bottom < top) throw new IOException("NPC sprite frame is transparent");
        Files.createDirectories(Path.of(args[1]).getParent());
        BufferedImage cropped = portrait.getSubimage(left, top, right - left + 1, bottom - top + 1);
        if (!ImageIO.write(addPixelOutline(cropped), "png", Path.of(args[1]).toFile())) {
            throw new IOException("No PNG writer is available");
        }
    }

    private static BufferedImage addPixelOutline(BufferedImage sprite) {
        final int outlineRadius = 2;
        BufferedImage outlined = new BufferedImage(
                sprite.getWidth() + outlineRadius * 2,
                sprite.getHeight() + outlineRadius * 2,
                BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < sprite.getHeight(); y++) {
            for (int x = 0; x < sprite.getWidth(); x++) {
                if ((sprite.getRGB(x, y) >>> 24) == 0) continue;
                for (int dy = -outlineRadius; dy <= outlineRadius; dy++) {
                    for (int dx = -outlineRadius; dx <= outlineRadius; dx++) {
                        if (dx == 0 && dy == 0) continue;
                        outlined.setRGB(x + outlineRadius + dx, y + outlineRadius + dy, 0xFFFFFFFF);
                    }
                }
            }
        }
        for (int y = 0; y < sprite.getHeight(); y++) {
            for (int x = 0; x < sprite.getWidth(); x++) {
                int pixel = sprite.getRGB(x, y);
                if ((pixel >>> 24) != 0) outlined.setRGB(x + outlineRadius, y + outlineRadius, pixel);
            }
        }
        return outlined;
    }

    private static BufferedImage firstVisibleFrame(BufferedImage sheet, int width, int height) {
        int stepX = Math.max(1, width), stepY = Math.max(1, height);
        for (int y = 0; y + height <= sheet.getHeight(); y += stepY) {
            for (int x = 0; x + width <= sheet.getWidth(); x += stepX) {
                BufferedImage candidate = sheet.getSubimage(x, y, width, height);
                for (int py = 0; py < height; py++) {
                    for (int px = 0; px < width; px++) {
                        if ((candidate.getRGB(px, py) >>> 24) != 0) return candidate;
                    }
                }
            }
        }
        return null;
    }
}
