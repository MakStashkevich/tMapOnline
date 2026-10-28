import { MapChunkCodec, type MapChunkSource } from './map-chunk-codec';

type ExportWorld = { id?: string | number; name?: string; width: number; height: number };

type MapImageExporterOptions = {
  button: HTMLButtonElement;
  codec: MapChunkCodec;
  getWorld: () => ExportWorld | null;
  getChunkOwners: () => Map<string, MapChunkSource>;
  getChunkSize: () => number;
  getMaskCanvas: () => HTMLCanvasElement | null;
  isFullMapEnabled: () => boolean;
  nextFrame: () => Promise<void>;
  onError: (error: unknown) => void;
};

/** Exports the map exactly as currently shown, including the explored-area mask. */
export class MapImageExporter {
  constructor(private readonly options: MapImageExporterOptions) {}

  async download(): Promise<void> {
    const { button } = this.options;
    const defaultLabel = 'Скачать PNG';
    button.disabled = true;

    try {
      const world = this.options.getWorld();
      const chunkOwners = this.options.getChunkOwners();
      if (!world || !chunkOwners.size) throw new Error('Данные карты ещё не загружены.');

      const width = Math.trunc(Number(world.width));
      const height = Math.trunc(Number(world.height));
      const output = document.createElement('canvas');
      output.width = width;
      output.height = height;
      const context = output.getContext('2d');
      if (!context) throw new Error('Браузер не смог создать изображение карты.');

      const background = [5, 9, 13, 255];
      context.fillStyle = '#05090d';
      context.fillRect(0, 0, width, height);

      const maskCanvas = this.options.getMaskCanvas();
      const maskWidth = maskCanvas?.width || 0;
      const maskPixels =
        !this.options.isFullMapEnabled() && maskCanvas
          ? maskCanvas.getContext('2d')?.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
              .data
          : null;
      const chunks = [...chunkOwners.entries()];
      const chunkSize = this.options.getChunkSize();

      for (let start = 0; start < chunks.length; start += 64) {
        for (const [key, source] of chunks.slice(start, start + 64)) {
          const [chunkX, chunkY] = this.parseKey(key);
          const pixels = await this.options.codec.compose(source, chunkSize);

          this.applyClosedAreaBackground(
            pixels,
            chunkSize,
            chunkX,
            chunkY,
            width,
            height,
            maskPixels,
            maskWidth,
            background,
          );
          context.putImageData(
            new ImageData(new Uint8ClampedArray(pixels) as ImageDataArray, chunkSize, chunkSize),
            chunkX * chunkSize,
            chunkY * chunkSize,
          );
        }

        const percent = Math.min(
          99,
          Math.round((Math.min(chunks.length, start + 64) / chunks.length) * 100),
        );
        button.textContent = `${percent}%`;
        if (start + 64 < chunks.length) await this.options.nextFrame();
      }

      button.textContent = '100%';
      const blob = await this.toBlob(output);
      this.saveBlob(blob, world.name || 'terraria-world');
    } catch (error) {
      this.options.onError(error);
    } finally {
      button.textContent = defaultLabel;
      button.disabled = false;
    }
  }

  private applyClosedAreaBackground(
    pixels: Uint8Array,
    chunkSize: number,
    chunkX: number,
    chunkY: number,
    worldWidth: number,
    worldHeight: number,
    maskPixels: Uint8ClampedArray | null | undefined,
    maskWidth: number,
    background: number[],
  ): void {
    for (let localY = 0; localY < chunkSize; localY++) {
      const worldY = chunkY * chunkSize + localY;
      if (worldY >= worldHeight) break;

      for (let localX = 0; localX < chunkSize; localX++) {
        const worldX = chunkX * chunkSize + localX;
        if (worldX >= worldWidth) break;

        const pixelOffset = (localY * chunkSize + localX) * 4;
        const closedArea =
          maskPixels?.[((worldY >> 2) * maskWidth + (worldX >> 2)) * 4 + 3] !== undefined &&
          maskPixels[((worldY >> 2) * maskWidth + (worldX >> 2)) * 4 + 3] < 32;
        if (!closedArea && pixels[pixelOffset + 3] !== 0) continue;

        pixels[pixelOffset] = background[0];
        pixels[pixelOffset + 1] = background[1];
        pixels[pixelOffset + 2] = background[2];
        pixels[pixelOffset + 3] = background[3];
      }
    }
  }

  private toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Не удалось сформировать PNG.'))),
        'image/png',
      );
    });
  }

  private saveBlob(blob: Blob, worldName: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeName = String(worldName).replace(/[^\p{L}\p{N}_-]+/gu, '_');
    link.href = url;
    link.download = `${safeName}-map.png`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private parseKey(key: string): [number, number] {
    const [chunkX, chunkY] = key.split(',').map(Number);
    return [chunkX, chunkY];
  }
}
