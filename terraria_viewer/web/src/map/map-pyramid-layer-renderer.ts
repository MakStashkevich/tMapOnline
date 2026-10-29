type WorldSize = { id: string | number; width: number; height: number };

type PyramidLayerOptions = {
  layer: HTMLElement;
  viewport: HTMLElement;
  stage: HTMLElement;
  getWorld: () => WorldSize | null;
  getScale: () => number;
  onError: (error: unknown) => void;
};

const TILE_SIZE = 256;
const MAX_LEVEL = 8;
const TILE_RENDER_DEBOUNCE_MS = 45;
const TILE_RENDER_BATCH_SIZE = 4;

/** Fetches only map pyramid tiles intersecting the current viewport. */
export class MapPyramidLayerRenderer {
  private readonly canvases = new Map<string, HTMLCanvasElement>();
  private readonly invalidatedTiles = new Set<string>();
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private renderRunning = false;
  private renderPending = false;
  private renderVersion = 0;
  private lastRenderDurationMs = 0;
  private lastRenderTileCount = 0;
  private failedRenderCount = 0;

  constructor(private readonly options: PyramidLayerOptions) {}

  layout(): void {
    const scale = this.options.getScale();
    for (const canvas of this.canvases.values()) this.positionCanvas(canvas, scale);
  }

  isDetailZoom(): boolean {
    return this.chooseLevel() === 0;
  }

  requestRender(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderVersion++;
    this.renderTimer = setTimeout(() => void this.renderLatestViewport(), TILE_RENDER_DEBOUNCE_MS);
  }

  clear(): void {
    this.renderVersion++;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.renderPending = false;
    for (const canvas of this.canvases.values()) canvas.remove();
    this.canvases.clear();
    this.invalidatedTiles.clear();
  }

  invalidateMapTiles(points: Array<{ x: number; y: number }>): void {
    if (points.length === 0) return;
    const affected = new Set<string>();
    for (const point of points) {
      for (let level = 0; level <= MAX_LEVEL; level += 1) {
        const tileWorldSize = TILE_SIZE * (1 << level);
        affected.add(
          `${this.options.getWorld()?.id ?? ''}:${level}:${Math.floor(point.x / tileWorldSize)}:${Math.floor(point.y / tileWorldSize)}`,
        );
      }
    }

    for (const address of affected) this.invalidatedTiles.add(address);
    this.requestRender();
  }

  invalidateVisibleTiles(): void {
    const world = this.options.getWorld();
    if (!world) return;
    const level = this.chooseLevel();
    const tileWorldSize = TILE_SIZE * (1 << level);
    const bounds = this.getVisibleWorldBounds(world);
    const firstX = Math.max(0, Math.floor(bounds.left / tileWorldSize));
    const firstY = Math.max(0, Math.floor(bounds.top / tileWorldSize));
    const lastX = Math.ceil(bounds.right / tileWorldSize);
    const lastY = Math.ceil(bounds.bottom / tileWorldSize);
    const affected = new Set<string>();
    for (let y = firstY; y < lastY; y += 1) {
      for (let x = firstX; x < lastX; x += 1) {
        affected.add(`${world.id}:${level}:${x}:${y}`);
      }
    }
    for (const address of affected) this.invalidatedTiles.add(address);
    this.requestRender();
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
      lastRenderChunkCount: this.lastRenderTileCount,
      rendering: this.renderRunning,
      canvasBytes,
      decodedChunkCount: 0,
    };
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
      const version = this.renderVersion;
      const startedAt = performance.now();
      try {
        await this.renderVisibleTiles(version);
      } catch (error) {
        this.options.onError(error);
      }
      this.lastRenderDurationMs = performance.now() - startedAt;
    } while (this.renderPending);
    this.renderRunning = false;
  }

  private async renderVisibleTiles(version: number): Promise<void> {
    const world = this.options.getWorld();
    if (!world) return;

    const level = this.chooseLevel();
    const factor = 1 << level;
    const tileWorldSize = TILE_SIZE * factor;
    const visibleBounds = this.getVisibleWorldBounds(world);
    const firstX = Math.max(0, Math.floor(visibleBounds.left / tileWorldSize) - 1);
    const firstY = Math.max(0, Math.floor(visibleBounds.top / tileWorldSize) - 1);
    const lastX = Math.min(
      Math.ceil(world.width / tileWorldSize),
      Math.ceil(visibleBounds.right / tileWorldSize) + 1,
    );
    const lastY = Math.min(
      Math.ceil(world.height / tileWorldSize),
      Math.ceil(visibleBounds.bottom / tileWorldSize) + 1,
    );
    // Keep the previous level visible as a low-resolution fallback until the new
    // viewport has loaded. This prevents black flashes during zoom and pan.
    const tiles: Array<{ x: number; y: number; key: string }> = [];

    for (let y = firstY; y < lastY; y++) {
      for (let x = firstX; x < lastX; x++) {
        const address = `${world.id}:${level}:${x}:${y}`;
        tiles.push({ x, y, key: address });
      }
    }
    this.lastRenderTileCount = tiles.length;

    let failedTiles = false;
    for (let start = 0; start < tiles.length; start += TILE_RENDER_BATCH_SIZE) {
      if (version !== this.renderVersion) return;
      const results = await Promise.allSettled(
        tiles
          .slice(start, start + TILE_RENDER_BATCH_SIZE)
          .map((tile) =>
            this.renderTile(tile.key, world, level, tile.x, tile.y, tileWorldSize, version),
          ),
      );
      failedTiles ||= results.some((result) => result.status === 'rejected');
      if (start + TILE_RENDER_BATCH_SIZE < tiles.length) await this.nextFrame();
    }

    if (version !== this.renderVersion) return;
    // If a tile failed, retain the old level so the user keeps a useful map and
    // retry after a short pause instead of flashing to black or flooding the API.
    if (failedTiles) {
      this.failedRenderCount++;
      if (this.failedRenderCount === 3) {
        this.options.onError(
          new Error('Несколько фрагментов карты не загрузились. Повторяю загрузку.'),
        );
      }
      this.renderTimer = setTimeout(() => this.requestRender(), 1200);
      return;
    }
    this.failedRenderCount = 0;

    const currentKeys = new Set(tiles.map((tile) => tile.key));
    for (const [key, canvas] of this.canvases) {
      if (!currentKeys.has(key)) {
        canvas.remove();
        this.canvases.delete(key);
      }
    }
  }

  private async renderTile(
    key: string,
    world: WorldSize,
    level: number,
    tileX: number,
    tileY: number,
    tileWorldSize: number,
    version: number,
  ): Promise<void> {
    const address = `${world.id}:${level}:${tileX}:${tileY}`;
    const currentCanvas = this.canvases.get(key);
    const needsMapRefresh = this.invalidatedTiles.has(address);
    if (currentCanvas && !needsMapRefresh) return;
    if (version !== this.renderVersion) return;

    const query = new URLSearchParams({
      world: String(world.id),
      level: String(level),
      x: String(tileX),
      y: String(tileY),
    });
    let bitmap: ImageBitmap;
    try {
      const response = await this.fetchTile(query, version);
      bitmap = await createImageBitmap(await response.blob());
    } catch (error) {
      throw error;
    }
    if (version !== this.renderVersion) {
      bitmap.close();
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.className = 'map-pyramid-tile';
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.dataset.worldLeft = String(tileX * tileWorldSize);
    canvas.dataset.worldTop = String(tileY * tileWorldSize);
    canvas.dataset.tileAddress = address;
    canvas.dataset.worldWidth = String(bitmap.width * (1 << level));
    canvas.dataset.worldHeight = String(bitmap.height * (1 << level));

    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      throw new Error('Could not create a map tile canvas context.');
    }
    context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();

    if (version !== this.renderVersion) return;
    this.positionCanvas(canvas, this.options.getScale());
    currentCanvas?.replaceWith(canvas);
    if (!currentCanvas) this.options.layer.append(canvas);
    this.canvases.set(key, canvas);
    this.invalidatedTiles.delete(address);
  }

  private async fetchTile(query: URLSearchParams, version: number): Promise<Response> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (version !== this.renderVersion) throw new Error('Map tile request was superseded.');
      try {
        // Let the browser validate its ETag cache instead of forcing an uncached download.
        const response = await fetch(`/api/world-map/tile?${query}`, { cache: 'default' });
        if (response.ok) return response;
        if (response.status < 500 && response.status !== 429) {
          throw new Error(`Map tile request failed with HTTP ${response.status}`);
        }
        lastError = new Error(`Map tile request failed with HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private chooseLevel(): number {
    const scale = this.options.getScale();
    return Math.max(0, Math.min(MAX_LEVEL, Math.ceil(Math.log2(1 / scale))));
  }

  private getVisibleWorldBounds(world: WorldSize): {
    left: number;
    top: number;
    right: number;
    bottom: number;
  } {
    const { viewport, stage } = this.options;
    const viewportRect = viewport.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const contentLeft = stageRect.left - viewportRect.left + viewport.scrollLeft;
    const contentTop = stageRect.top - viewportRect.top + viewport.scrollTop;
    const scale = this.options.getScale();
    return {
      left: Math.max(0, (viewport.scrollLeft - contentLeft) / scale),
      top: Math.max(0, (viewport.scrollTop - contentTop) / scale),
      right: Math.min(
        world.width,
        (viewport.scrollLeft + viewport.clientWidth - contentLeft) / scale,
      ),
      bottom: Math.min(
        world.height,
        (viewport.scrollTop + viewport.clientHeight - contentTop) / scale,
      ),
    };
  }

  private positionCanvas(canvas: HTMLCanvasElement, scale: number): void {
    const left = Math.floor(Number(canvas.dataset.worldLeft) * scale);
    const top = Math.floor(Number(canvas.dataset.worldTop) * scale);
    const right = Math.ceil(
      (Number(canvas.dataset.worldLeft) + Number(canvas.dataset.worldWidth)) * scale,
    );
    const bottom = Math.ceil(
      (Number(canvas.dataset.worldTop) + Number(canvas.dataset.worldHeight)) * scale,
    );
    canvas.style.left = `${left}px`;
    canvas.style.top = `${top}px`;
    canvas.style.width = `${right - left}px`;
    canvas.style.height = `${bottom - top}px`;
  }

  private nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
}
