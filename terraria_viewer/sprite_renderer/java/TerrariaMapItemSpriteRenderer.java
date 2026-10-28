package com.github.antag99.textract.extract;

import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.imageio.ImageIO;

/** Exports a vanilla Terraria map item sprite from its XNB texture. */
public final class TerrariaMapItemSpriteRenderer {
    private TerrariaMapItemSpriteRenderer() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            throw new IllegalArgumentException("usage: <source.xnb> <output.png>");
        }
        BufferedImage texture = TerrariaPlayerSpriteRenderer.texture(Path.of(args[0]));
        BufferedImage sprite = cropTransparentBounds(texture);
        Files.createDirectories(Path.of(args[1]).getParent());
        if (!ImageIO.write(sprite, "png", Path.of(args[1]).toFile())) {
            throw new IOException("No PNG writer is available");
        }
    }

    private static BufferedImage cropTransparentBounds(BufferedImage image) throws IOException {
        int left = image.getWidth(), top = image.getHeight(), right = -1, bottom = -1;
        for (int y = 0; y < image.getHeight(); y++) {
            for (int x = 0; x < image.getWidth(); x++) {
                if ((image.getRGB(x, y) >>> 24) == 0) continue;
                left = Math.min(left, x);
                top = Math.min(top, y);
                right = Math.max(right, x);
                bottom = Math.max(bottom, y);
            }
        }
        if (right < left || bottom < top) throw new IOException("Item texture is fully transparent");
        return image.getSubimage(left, top, right - left + 1, bottom - top + 1);
    }
}
