package com.github.antag99.textract.extract;

import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.imageio.ImageIO;

/** CPU-only avatar compositor using the same vanilla texture layers as tModLoader. */
public final class TerrariaPlayerSpriteRenderer {
    private TerrariaPlayerSpriteRenderer() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 16) {
            throw new IllegalArgumentException("usage: <images-dir> <output.png> <skinVariant> <hair> <head> <hairColor> <skinColor> <eyeColor> <fullHair> <hatHair> <hideHair> <backHairDraw> <backHairWithoutHeadgear> <mod-head-texture.png-or-empty> <mod-face-texture.png-or-empty> <mod-beard-texture.png-or-empty>");
        }
        Path images = Path.of(args[0]);
        Path output = Path.of(args[1]);
        int skinVariant = Integer.parseInt(args[2]);
        int hairId = Integer.parseInt(args[3]);
        int headId = Integer.parseInt(args[4]);
        int hairColor = parseColor(args[5]);
        int skinColor = parseColor(args[6]);
        int eyeColor = parseColor(args[7]);
        boolean fullHair = Boolean.parseBoolean(args[8]);
        boolean hatHair = Boolean.parseBoolean(args[9]);
        boolean hideHair = Boolean.parseBoolean(args[10]);
        boolean backHairDraw = Boolean.parseBoolean(args[11]);
        boolean backHairWithoutHeadgear = Boolean.parseBoolean(args[12]);
        String modHeadTexture = args[13];
        String modFaceTexture = args[14];
        String modBeardTexture = args[15];

        // Terraria shares the player base textures for variants 0-9, with a
        // second special texture set for variants 10 and 11.
        int textureSet = skinVariant >= 10 ? 10 : 0;
        BufferedImage canvas = new BufferedImage(40, 56, BufferedImage.TYPE_INT_ARGB);

        boolean hasHeadgear = headId >= 0;
        if (hairId >= 0 && !hideHair && backHairDraw
                && (!hasHeadgear || fullHair || backHairWithoutHeadgear)) {
            BufferedImage backHair = texture(images.resolve("Player_Hair_" + hairId + ".xnb"));
            composite(canvas, frame(backHair, 0, 40, 56), hairColor, false);
        }

        BufferedImage face = texture(images.resolve("Player_" + textureSet + "_0.xnb"));
        BufferedImage eyesWhite = texture(images.resolve("Player_" + textureSet + "_1.xnb"));
        BufferedImage eyes = texture(images.resolve("Player_" + textureSet + "_2.xnb"));
        composite(canvas, frame(face, 0, 40, 56), skinColor, false);
        composite(canvas, frame(eyesWhite, 0, 40, 56), 0xFFFFFFFF, false);
        composite(canvas, frame(eyes, 0, 40, 56), eyeColor, false);

        if (headId >= 0) {
            Path headgearPath = modHeadTexture.isBlank()
                    ? images.resolve("Armor_Head_" + headId + ".xnb")
                    : Path.of(modHeadTexture);
            BufferedImage headgear = texture(headgearPath);
            composite(canvas, frame(headgear, 0, 40, 56), 0xFFFFFFFF, true);
        }
        if (hairId >= 0 && !hideHair && (fullHair || hatHair || !hasHeadgear)) {
            String hairTexture = hatHair ? "Player_HairAlt_" : "Player_Hair_";
            BufferedImage frontHair = texture(images.resolve(hairTexture + hairId + ".xnb"));
            composite(canvas, frame(frontHair, 0, 40, 56), hairColor, false);
        }
        compositeOptionalHeadLayer(canvas, modBeardTexture);
        compositeOptionalHeadLayer(canvas, modFaceTexture);

        // Remove transparent frame padding so the dashboard scales the actual
        // head sprite instead of mostly empty space.
        BufferedImage cropped = cropTransparentBounds(canvas);
        Files.createDirectories(output.getParent());
        if (!ImageIO.write(cropped, "png", output.toFile())) {
            throw new IOException("No PNG writer is available");
        }
    }

    private static BufferedImage cropTransparentBounds(BufferedImage image) {
        int left = image.getWidth();
        int top = image.getHeight();
        int right = -1;
        int bottom = -1;
        for (int y = 0; y < image.getHeight(); y++) {
            for (int x = 0; x < image.getWidth(); x++) {
                if ((image.getRGB(x, y) >>> 24) == 0) continue;
                left = Math.min(left, x);
                top = Math.min(top, y);
                right = Math.max(right, x);
                bottom = Math.max(bottom, y);
            }
        }
        if (right < left || bottom < top) return image;
        return image.getSubimage(left, top, right - left + 1, bottom - top + 1);
    }

    private static int parseColor(String value) {
        String clean = value.startsWith("#") ? value.substring(1) : value;
        return 0xFF000000 | Integer.parseInt(clean, 16);
    }

    private static void compositeOptionalHeadLayer(BufferedImage canvas, String texturePath) throws Exception {
        if (texturePath == null || texturePath.isBlank()) return;
        try {
            composite(canvas, frame(texture(Path.of(texturePath)), 0, 40, 56), 0xFFFFFFFF, true);
        } catch (Exception ignored) {
            // Some accessory sprites use a different frame size; keep the base portrait.
        }
    }

    private static BufferedImage frame(BufferedImage sheet, int frame, int width, int height) {
        int y = Math.multiplyExact(frame, height);
        if (sheet.getWidth() < width || sheet.getHeight() < y + height) {
            throw new IllegalArgumentException("Texture frame is outside its sprite sheet");
        }
        return sheet.getSubimage(0, y, width, height);
    }

    private static void composite(BufferedImage destination, BufferedImage source, int tint, boolean preserveSourceColor) {
        int tr = (tint >>> 16) & 255;
        int tg = (tint >>> 8) & 255;
        int tb = tint & 255;
        for (int y = 0; y < Math.min(destination.getHeight(), source.getHeight()); y++) {
            for (int x = 0; x < Math.min(destination.getWidth(), source.getWidth()); x++) {
                int pixel = source.getRGB(x, y);
                int alpha = pixel >>> 24;
                if (alpha == 0) continue;
                int red = (pixel >>> 16) & 255;
                int green = (pixel >>> 8) & 255;
                int blue = pixel & 255;
                if (!preserveSourceColor) {
                    red = red * tr / 255;
                    green = green * tg / 255;
                    blue = blue * tb / 255;
                }
                int sourceAlpha = alpha;
                int target = destination.getRGB(x, y);
                int targetAlpha = target >>> 24;
                int outAlpha = sourceAlpha + targetAlpha * (255 - sourceAlpha) / 255;
                if (outAlpha == 0) continue;
                int targetRed = (target >>> 16) & 255;
                int targetGreen = (target >>> 8) & 255;
                int targetBlue = target & 255;
                int outRed = (red * sourceAlpha + targetRed * targetAlpha * (255 - sourceAlpha) / 255) / outAlpha;
                int outGreen = (green * sourceAlpha + targetGreen * targetAlpha * (255 - sourceAlpha) / 255) / outAlpha;
                int outBlue = (blue * sourceAlpha + targetBlue * targetAlpha * (255 - sourceAlpha) / 255) / outAlpha;
                destination.setRGB(x, y, (outAlpha << 24) | (outRed << 16) | (outGreen << 8) | outBlue);
            }
        }
    }

    static BufferedImage texture(Path path) throws Exception {
        if (!Files.isRegularFile(path)) throw new IOException("Missing Terraria texture: " + path.getFileName());
        byte[] raw = Files.readAllBytes(path);
        if (raw.length >= 8 && raw[0] == (byte) 0x89 && raw[1] == 'P' && raw[2] == 'N' && raw[3] == 'G') {
            BufferedImage png = ImageIO.read(path.toFile());
            if (png == null) throw new IOException("Invalid PNG texture: " + path.getFileName());
            return png;
        }
        ByteBuffer bytes = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN);
        if (bytes.get() != 'X' || bytes.get() != 'N' || bytes.get() != 'B') throw new IOException("Not an XNB texture");
        bytes.get();
        int version = bytes.get() & 255;
        if (version != 5) throw new IOException("Unsupported XNB version: " + version);
        boolean compressed = (bytes.get() & 0x80) != 0;
        int compressedSize = bytes.getInt();
        int dataSize = compressed ? bytes.getInt() : compressedSize;
        if (compressed) {
            ByteBuffer expanded = ByteBuffer.allocate(dataSize).order(ByteOrder.LITTLE_ENDIAN);
            new LzxDecoder().decompress(bytes, compressedSize - 14, expanded, dataSize);
            expanded.position(0);
            bytes = expanded;
        }
        int readerCount = read7BitInt(bytes);
        String type = readString(bytes);
        bytes.getInt();
        for (int i = 1; i < readerCount; i++) {
            readString(bytes);
            bytes.getInt();
        }
        if (read7BitInt(bytes) != 0 || read7BitInt(bytes) != 1) throw new IOException("Unexpected XNB asset references");
        if (!type.startsWith("Microsoft.Xna.Framework.Content.Texture2DReader")) throw new IOException("XNB is not a Texture2D");
        int format = bytes.getInt();
        int width = bytes.getInt();
        int height = bytes.getInt();
        int mipmaps = bytes.getInt();
        int dataLength = bytes.getInt();
        if (format != 0 || mipmaps != 1 || dataLength != width * height * 4) throw new IOException("Unsupported Terraria texture format");
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                int red = bytes.get() & 255;
                int green = bytes.get() & 255;
                int blue = bytes.get() & 255;
                int alpha = bytes.get() & 255;
                image.setRGB(x, y, (alpha << 24) | (red << 16) | (green << 8) | blue);
            }
        }
        return image;
    }

    private static int read7BitInt(ByteBuffer bytes) {
        int result = 0;
        int shift = 0;
        int current;
        do {
            current = bytes.get() & 255;
            result |= (current & 127) << shift;
            shift += 7;
            if (shift > 28) throw new IllegalArgumentException("Malformed XNB integer");
        } while ((current & 128) != 0);
        return result;
    }

    private static String readString(ByteBuffer bytes) {
        int length = read7BitInt(bytes);
        byte[] value = new byte[length];
        bytes.get(value);
        return new String(value, java.nio.charset.StandardCharsets.UTF_8);
    }
}
