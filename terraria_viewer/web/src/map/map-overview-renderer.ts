import { MapChunkCodec, type MapChunkSource } from './map-chunk-codec';

type WorldDimensions = { id: string | number; width: number; height: number };

type OverviewRendererOptions = {
  canvas: HTMLCanvasElement;
  codec: MapChunkCodec;
  overviewScale: number;
  getWorld: () => WorldDimensions | null;
  getChunkSize: () => number;
  getChunkOwners: () => Map<string, MapChunkSource>;
  getDirtyChunks: () => Set<string>;
  clearDirtyChunks: () => void;
  getMaskCanvas: () => HTMLCanvasElement | null;
  isFullMapEnabled: () => boolean;
  getRevision: () => number;
  onReady: () => void;
  onError: (error: unknown) => void;
};

/** Builds and displays the low-resolution world overview without blanking a complete preview. */
export class MapOverviewRenderer {
  private sourceCanvas: HTMLCanvasElement | null = null;
  private sourceReady = false;
  private readyKey = '';
  private requestedKey = '';
  private buildToken = 0;
  private buildRunning = false;
  private buildPending = false;

  constructor(private readonly options: OverviewRendererOptions) {}

  get isReady(): boolean {
    return this.sourceReady && this.sourceCanvas !== null;
  }

  get source(): HTMLCanvasElement | null {
    return this.sourceCanvas;
  }

  resetWorld(width: number, height: number): void {
    this.buildToken++;
    this.sourceCanvas = null;
    this.sourceReady = false;
    this.readyKey = '';
    this.requestedKey = '';
    this.options.canvas.width = Math.ceil(width * this.options.overviewScale);
    this.options.canvas.height = Math.ceil(height * this.options.overviewScale);
  }

  draw(): void {
    if (!this.sourceReady || !this.sourceCanvas) return;
    const context = this.options.canvas.getContext('2d');
    if (!context) return;

    context.globalCompositeOperation = 'source-over';
    context.clearRect(0, 0, this.options.canvas.width, this.options.canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      this.sourceCanvas,
      0,
      0,
      this.options.canvas.width,
      this.options.canvas.height,
    );

    const maskCanvas = this.options.getMaskCanvas();
    if (!this.options.isFullMapEnabled() && maskCanvas) {
      context.globalCompositeOperation = 'destination-in';
      context.drawImage(maskCanvas, 0, 0, this.options.canvas.width, this.options.canvas.height);
      context.globalCompositeOperation = 'source-over';
    }
  }

  async restore(blob: Blob | null): Promise<boolean> {
    const world = this.options.getWorld();
    if (!blob || !world) return false;

    try {
      const bitmap = await createImageBitmap(blob);
      const expectedWidth = Math.ceil(world.width * this.options.overviewScale);
      const expectedHeight = Math.ceil(world.height * this.options.overviewScale);
      if (bitmap.width !== expectedWidth || bitmap.height !== expectedHeight) {
        bitmap.close();
        return false;
      }

      this.options.canvas.width = expectedWidth;
      this.options.canvas.height = expectedHeight;
      this.sourceCanvas = document.createElement('canvas');
      this.sourceCanvas.width = expectedWidth;
      this.sourceCanvas.height = expectedHeight;
      this.sourceCanvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      bitmap.close();
      this.sourceReady = true;
      this.readyKey = this.currentKey();
      return true;
    } catch {
      return false;
    }
  }

  async build(): Promise<void> {
    if (!this.options.getChunkOwners().size || !this.options.getMaskCanvas()) return;
    if (this.buildRunning) {
      this.buildPending = true;
      return;
    }

    this.buildRunning = true;
    try {
      do {
        this.buildPending = false;
        const key = this.currentKey();
        if (key === this.readyKey) continue;

        this.requestedKey = key;
        const token = ++this.buildToken;
        const maskCanvas = this.options.getMaskCanvas();
        if (!maskCanvas) return;
        const width = maskCanvas.width;
        const height = maskCanvas.height;
        const nextCanvas = document.createElement('canvas');
        nextCanvas.width = width;
        nextCanvas.height = height;
        const context = nextCanvas.getContext('2d');
        if (!context) throw new Error('Could not create the overview canvas context.');

        // Compose into a hidden buffer and swap only after every dirty chunk is ready.
        if (this.sourceReady && this.sourceCanvas) context.drawImage(this.sourceCanvas, 0, 0);
        const chunkSize = this.options.getChunkSize();
        const overviewChunkSize = Math.max(1, Math.round(chunkSize * this.options.overviewScale));
        const downsampleFactor = Math.max(1, Math.round(chunkSize / overviewChunkSize));
        const owners = this.options.getChunkOwners();
        const dirtyKeys = this.sourceReady
          ? [...this.options.getDirtyChunks()]
          : [...owners.keys()];
        this.options.clearDirtyChunks();
        const entries = dirtyKeys.map(
          (chunkKey) => [chunkKey, owners.get(chunkKey) || null] as const,
        );
        let cancelled = false;

        for (let start = 0; start < entries.length; start += 128) {
          if (token !== this.buildToken) {
            cancelled = true;
            break;
          }

          const batch = entries.slice(start, start + 128);
          const decodedChunks = await Promise.all(
            batch.map(([, source]) =>
              source ? this.options.codec.compose(source, chunkSize) : null,
            ),
          );
          if (token !== this.buildToken) {
            cancelled = true;
            break;
          }

          for (let index = 0; index < batch.length; index++) {
            const [chunkKey, source] = batch[index];
            const [chunkX, chunkY] = this.parseKey(chunkKey);
            const pixels = decodedChunks[index];
            const x = Math.round(chunkX * chunkSize * this.options.overviewScale);
            const y = Math.round(chunkY * chunkSize * this.options.overviewScale);

            if (!source || !pixels) {
              context.clearRect(x, y, overviewChunkSize, overviewChunkSize);
              continue;
            }

            const reduced = this.downsample(pixels, chunkSize, overviewChunkSize, downsampleFactor);
            context.putImageData(
              new ImageData(reduced as ImageDataArray, overviewChunkSize, overviewChunkSize),
              x,
              y,
            );
          }

          if (start + 128 < entries.length) await this.nextFrame();
        }

        if (cancelled) {
          this.requestedKey = '';
          this.buildPending = true;
          continue;
        }

        this.sourceCanvas = nextCanvas;
        this.sourceReady = true;
        this.readyKey = key;
        this.requestedKey = '';
        this.draw();
        if (this.currentKey() !== key || this.options.getDirtyChunks().size) {
          this.buildPending = true;
        } else {
          this.options.onReady();
        }
      } while (this.buildPending);
    } catch (error) {
      this.options.onError(error);
    } finally {
      this.buildRunning = false;
      if (this.currentKey() !== this.readyKey || this.options.getDirtyChunks().size) {
        void this.build();
      }
    }
  }

  private currentKey(): string {
    const world = this.options.getWorld();
    return world ? `${world.id}:${world.width}x${world.height}:${this.options.getRevision()}` : '';
  }

  private downsample(
    source: Uint8Array,
    chunkSize: number,
    outputSize: number,
    factor: number,
  ): Uint8ClampedArray {
    const reduced = new Uint8ClampedArray(outputSize * outputSize * 4);
    for (let outputY = 0; outputY < outputSize; outputY++) {
      for (let outputX = 0; outputX < outputSize; outputX++) {
        let red = 0;
        let green = 0;
        let blue = 0;
        let alpha = 0;

        for (let offsetY = 0; offsetY < factor; offsetY++) {
          for (let offsetX = 0; offsetX < factor; offsetX++) {
            const sourceOffset =
              ((outputY * factor + offsetY) * chunkSize + outputX * factor + offsetX) * 4;
            const sourceAlpha = source[sourceOffset + 3];
            red += source[sourceOffset] * sourceAlpha;
            green += source[sourceOffset + 1] * sourceAlpha;
            blue += source[sourceOffset + 2] * sourceAlpha;
            alpha += sourceAlpha;
          }
        }

        const targetOffset = (outputY * outputSize + outputX) * 4;
        if (alpha > 0) {
          reduced[targetOffset] = red / alpha;
          reduced[targetOffset + 1] = green / alpha;
          reduced[targetOffset + 2] = blue / alpha;
        }
        reduced[targetOffset + 3] = alpha / (factor * factor);
      }
    }
    return reduced;
  }

  private parseKey(key: string): [number, number] {
    const [chunkX, chunkY] = key.split(',').map(Number);
    return [chunkX, chunkY];
  }

  private nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
}
