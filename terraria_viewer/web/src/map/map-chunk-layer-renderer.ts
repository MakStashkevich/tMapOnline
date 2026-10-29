import { MapChunkCodec, type MapChunkSource } from './map-chunk-codec';

type WorldSize = { width: number; height: number };

type ChunkLayerOptions = {
  layer: HTMLElement;
  viewport: HTMLElement;
  stage: HTMLElement;
  codec: MapChunkCodec;
  getWorld: () => WorldSize | null;
  getScale: () => number;
  getFitScale: () => number;
  getChunkSize: () => number;
  getMaskCanvas: () => HTMLCanvasElement | null;
  getMaskVersion: () => number;
  isFullMapEnabled: () => boolean;
  getChunkOwners: () => Map<string, MapChunkSource>;
  onError: (error: unknown) => void;
  maskScale: number;
};

/** Owns the visible map canvases and their delayed rendering lifecycle. */
export class MapChunkLayerRenderer {
  private readonly canvases = new Map<string, HTMLCanvasElement>();
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private renderRunning = false;
  private renderPending = false;
  private lastRenderDurationMs = 0;
  private lastRenderChunkCount = 0;

  constructor(private readonly options: ChunkLayerOptions) {}

  layout(): void {
    const { getScale, getChunkSize } = this.options;
    const scale = getScale();
    const chunkSize = getChunkSize();

    for (const [key, canvas] of this.canvases) {
      const [chunkX, chunkY] = this.parseKey(key);
      canvas.style.left = `${chunkX * chunkSize * scale}px`;
      canvas.style.top = `${chunkY * chunkSize * scale}px`;
      canvas.style.width = `${chunkSize * scale}px`;
      canvas.style.height = `${chunkSize * scale}px`;
    }
  }

  requestRender(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      void this.renderLatestViewport();
    }, 45);
  }

  clear(): void {
    for (const canvas of this.canvases.values()) canvas.remove();
    this.canvases.clear();
    this.options.codec.clear();
  }

  getDebugMetrics(): {
    visibleCanvases: number;
    lastRenderDurationMs: number;
    lastRenderChunkCount: number;
    rendering: boolean;
    canvasBytes: number;
    decodedChunkCount: number;
  } {
    let canvasBytes = 0;
    for (const canvas of this.canvases.values()) {
      canvasBytes += canvas.width * canvas.height * 4;
    }
    return {
      visibleCanvases: this.canvases.size,
      lastRenderDurationMs: this.lastRenderDurationMs,
      lastRenderChunkCount: this.lastRenderChunkCount,
      rendering: this.renderRunning,
      canvasBytes,
      decodedChunkCount: this.options.codec.getCachedChunkCount(),
    };
  }

  invalidateExplorationMask(): void {
    for (const canvas of this.canvases.values()) canvas.dataset.maskVersion = '';
  }

  private async renderLatestViewport(): Promise<void> {
    this.renderTimer = null;
    if (this.renderRunning) {
      this.renderPending = true;
      return;
    }

    this.renderRunning = true;
    do {
      this.renderPending = false;
      const startedAt = performance.now();
      try {
        await this.renderVisibleChunks();
      } catch (error) {
        this.options.onError(error);
      } finally {
        this.lastRenderDurationMs = performance.now() - startedAt;
      }
    } while (this.renderPending);
    this.renderRunning = false;
  }

  private async renderVisibleChunks(): Promise<void> {
    const world = this.options.getWorld();
    const maskCanvas = this.options.getMaskCanvas();
    if (!world || !maskCanvas) return;

    const scale = this.options.getScale();
    if (scale < this.options.getFitScale() * 4) {
      this.removeAllCanvases();
      this.lastRenderChunkCount = 0;
      return;
    }

    const { viewport, stage, getChunkSize } = this.options;
    const chunkSize = getChunkSize();
    const viewportRect = viewport.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const contentLeft = stageRect.left - viewportRect.left + viewport.scrollLeft;
    const contentTop = stageRect.top - viewportRect.top + viewport.scrollTop;
    const left = Math.max(0, (viewport.scrollLeft - contentLeft) / scale - chunkSize);
    const top = Math.max(0, (viewport.scrollTop - contentTop) / scale - chunkSize);
    const right = Math.min(
      world.width,
      (viewport.scrollLeft + viewport.clientWidth - contentLeft) / scale + chunkSize,
    );
    const bottom = Math.min(
      world.height,
      (viewport.scrollTop + viewport.clientHeight - contentTop) / scale + chunkSize,
    );
    const owners = this.options.getChunkOwners();
    const visible = new Map<string, MapChunkSource>();
    const firstChunkX = Math.max(0, Math.floor(left / chunkSize));
    const firstChunkY = Math.max(0, Math.floor(top / chunkSize));
    const endChunkX = Math.min(Math.ceil(world.width / chunkSize), Math.ceil(right / chunkSize));
    const endChunkY = Math.min(Math.ceil(world.height / chunkSize), Math.ceil(bottom / chunkSize));

    for (let chunkY = firstChunkY; chunkY < endChunkY; chunkY++) {
      for (let chunkX = firstChunkX; chunkX < endChunkX; chunkX++) {
        const key = `${chunkX},${chunkY}`;
        const source = owners.get(key);
        if (source) visible.set(key, source);
      }
    }
    this.lastRenderChunkCount = visible.size;

    for (const [key, canvas] of this.canvases) {
      if (!visible.has(key)) {
        canvas.remove();
        this.canvases.delete(key);
      }
    }

    await Promise.all(
      [...visible].map(([key, source]) =>
        this.renderChunk(key, source, maskCanvas, scale, chunkSize),
      ),
    );
  }

  private async renderChunk(
    key: string,
    source: MapChunkSource,
    maskCanvas: HTMLCanvasElement,
    scale: number,
    chunkSize: number,
  ): Promise<void> {
    const encodedSource = JSON.stringify([source.base, source.overlays]);
    const previous = this.canvases.get(key);
    const replace = !previous || previous.dataset.encoded !== encodedSource;
    const canvas = replace ? document.createElement('canvas') : previous;

    if (replace) {
      canvas.className = 'map-chunk';
      canvas.width = chunkSize;
      canvas.height = chunkSize;
      canvas.dataset.encoded = encodedSource;
      canvas.dataset.maskVersion = '';
    }

    const fullMapEnabled = this.options.isFullMapEnabled();
    const maskToken = fullMapEnabled ? 'full-map' : `explored-${this.options.getMaskVersion()}`;
    if (canvas.dataset.maskVersion !== maskToken) {
      const pixels = await this.options.codec.compose(source, chunkSize);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not create a map chunk canvas context.');

      context.putImageData(
        new ImageData(new Uint8ClampedArray(pixels) as ImageDataArray, chunkSize, chunkSize),
        0,
        0,
      );
      if (!fullMapEnabled) this.applyExplorationMask(context, maskCanvas, key, chunkSize);
      canvas.dataset.maskVersion = maskToken;
    }

    const [chunkX, chunkY] = this.parseKey(key);
    canvas.style.left = `${chunkX * chunkSize * scale}px`;
    canvas.style.top = `${chunkY * chunkSize * scale}px`;
    canvas.style.width = `${chunkSize * scale}px`;
    canvas.style.height = `${chunkSize * scale}px`;
    if (replace) {
      this.options.layer.append(canvas);
      this.canvases.set(key, canvas);
      previous?.remove();
    }
  }

  private applyExplorationMask(
    context: CanvasRenderingContext2D,
    maskCanvas: HTMLCanvasElement,
    key: string,
    chunkSize: number,
  ): void {
    const [chunkX, chunkY] = this.parseKey(key);
    const maskChunkSize = chunkSize * this.options.maskScale;
    context.save();
    context.globalCompositeOperation = 'destination-in';
    context.drawImage(
      maskCanvas,
      chunkX * maskChunkSize,
      chunkY * maskChunkSize,
      maskChunkSize,
      maskChunkSize,
      0,
      0,
      chunkSize,
      chunkSize,
    );
    context.restore();
  }

  private removeAllCanvases(): void {
    for (const canvas of this.canvases.values()) canvas.remove();
    this.canvases.clear();
  }

  private parseKey(key: string): [number, number] {
    const [chunkX, chunkY] = key.split(',').map(Number);
    return [chunkX, chunkY];
  }
}
