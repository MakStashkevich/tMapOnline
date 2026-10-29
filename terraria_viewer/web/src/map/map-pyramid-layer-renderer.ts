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
const MAX_VISIBLE_TILES = 10;
const TILE_RENDER_DEBOUNCE_MS = 45;
const TILE_RENDER_BATCH_SIZE = 4;

function isCanvasContextLost(context: CanvasRenderingContext2D): boolean {
  // Safari versions without this optional API still provide a usable 2D context.
  return typeof context.isContextLost === 'function' && context.isContextLost();
}

/** Fetches only map pyramid tiles intersecting the current viewport. */
export class MapPyramidLayerRenderer {
  private readonly canvases = new Map<string, HTMLCanvasElement>();
  private readonly invalidatedTiles = new Set<string>();
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private renderRunning = false;
  private renderPending = false;
  private renderVersion = 0;
  private renderAbortController: AbortController | null = null;
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
    this.renderAbortController?.abort();
    this.renderVersion++;
    this.renderTimer = setTimeout(() => void this.renderLatestViewport(), TILE_RENDER_DEBOUNCE_MS);
  }

  clear(): void {
    this.renderVersion++;
    this.renderAbortController?.abort();
    this.renderAbortController = null;
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
    const firstX = Math.max(0, Math.floor(visibleBounds.left / tileWorldSize));
    const firstY = Math.max(0, Math.floor(visibleBounds.top / tileWorldSize));
    const lastX = Math.min(
      Math.ceil(world.width / tileWorldSize),
      Math.ceil(visibleBounds.right / tileWorldSize),
    );
    const lastY = Math.min(
      Math.ceil(world.height / tileWorldSize),
      Math.ceil(visibleBounds.bottom / tileWorldSize),
    );
    const tiles: Array<{ x: number; y: number; key: string }> = [];

    for (let y = firstY; y < lastY; y++) {
      for (let x = firstX; x < lastX; x++) {
        const address = `${world.id}:${level}:${x}:${y}`;
        tiles.push({ x, y, key: address });
      }
    }
    if (tiles.length === 0) return;
    this.lastRenderTileCount = tiles.length;

    const abortController = new AbortController();
    this.renderAbortController = abortController;
    const loadedTiles = new Map<string, ImageBitmap>();
    let failedTiles = false;
    for (let start = 0; start < tiles.length; start += TILE_RENDER_BATCH_SIZE) {
      if (version !== this.renderVersion) {
        this.closeBitmaps(loadedTiles);
        return;
      }
      const tilesToLoad = tiles.slice(start, start + TILE_RENDER_BATCH_SIZE).filter(({ key }) => {
        return !this.canvases.has(key) || this.invalidatedTiles.has(key);
      });
      const results = await Promise.allSettled(
        tilesToLoad.map(async (tile) => ({
          tile,
          bitmap: await this.loadTileBitmap(
            world,
            level,
            tile.x,
            tile.y,
            version,
            abortController.signal,
          ),
        })),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          loadedTiles.set(result.value.tile.key, result.value.bitmap);
        } else if (!abortController.signal.aborted) {
          failedTiles = true;
        }
      }
      if (version !== this.renderVersion) {
        this.closeBitmaps(loadedTiles);
        return;
      }
      if (start + TILE_RENDER_BATCH_SIZE < tiles.length) await this.nextFrame();
    }

    if (version !== this.renderVersion || abortController.signal.aborted) {
      this.closeBitmaps(loadedTiles);
      return;
    }
    // Keep the previous viewport intact unless every replacement tile is ready.
    if (
      failedTiles ||
      loadedTiles.size +
        tiles.filter(({ key }) => this.canvases.has(key) && !this.invalidatedTiles.has(key))
          .length !==
        tiles.length
    ) {
      this.closeBitmaps(loadedTiles);
      this.failedRenderCount++;
      if (this.failedRenderCount === 3) {
        this.options.onError(
          new Error('Несколько фрагментов карты не загрузились. Повторяю загрузку.'),
        );
      }
      this.renderTimer = setTimeout(() => this.requestRender(), 1200);
      return;
    }
    if (!this.commitTileSet(tiles, loadedTiles, tileWorldSize, version)) {
      this.scheduleRetry();
      return;
    }
    this.failedRenderCount = 0;
  }

  private async loadTileBitmap(
    world: WorldSize,
    level: number,
    tileX: number,
    tileY: number,
    version: number,
    signal: AbortSignal,
  ): Promise<ImageBitmap> {
    if (version !== this.renderVersion) throw new Error('Map tile request was superseded.');

    const query = new URLSearchParams({
      world: String(world.id),
      level: String(level),
      x: String(tileX),
      y: String(tileY),
    });
    let bitmap: ImageBitmap;
    try {
      const response = await this.fetchTile(query, version, signal);
      bitmap = await createImageBitmap(await response.blob());
    } catch (error) {
      throw error;
    }
    if (version !== this.renderVersion) {
      bitmap.close();
      throw new Error('Map tile request was superseded.');
    }
    return bitmap;
  }

  private commitTileSet(
    tiles: Array<{ x: number; y: number; key: string }>,
    loadedTiles: Map<string, ImageBitmap>,
    tileWorldSize: number,
    version: number,
  ): boolean {
    const nextCanvases = new Map<string, HTMLCanvasElement>();
    const stagedCanvases: HTMLCanvasElement[] = [];

    try {
      for (const tile of tiles) {
        if (version !== this.renderVersion) return false;

        const retainedCanvas = this.canvases.get(tile.key);
        const bitmap = loadedTiles.get(tile.key);
        if (retainedCanvas && !bitmap) {
          nextCanvases.set(tile.key, retainedCanvas);
          continue;
        }
        if (!bitmap) return false;

        // Render replacements off-screen so a failed Safari context never clears a visible tile.
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        if (!context || isCanvasContextLost(context)) return false;

        context.imageSmoothingEnabled = false;
        context.drawImage(bitmap, 0, 0);
        if (isCanvasContextLost(context)) return false;

        canvas.className = 'map-pyramid-tile';
        canvas.dataset.worldLeft = String(tile.x * tileWorldSize);
        canvas.dataset.worldTop = String(tile.y * tileWorldSize);
        canvas.dataset.tileAddress = tile.key;
        canvas.dataset.worldWidth = String(canvas.width * (tileWorldSize / TILE_SIZE));
        canvas.dataset.worldHeight = String(canvas.height * (tileWorldSize / TILE_SIZE));
        canvas.addEventListener('contextlost', (event) => {
          event.preventDefault();
          if (this.canvases.get(tile.key) !== canvas) return;

          this.invalidatedTiles.add(tile.key);
          this.requestRender();
        });
        stagedCanvases.push(canvas);
        nextCanvases.set(tile.key, canvas);
      }
    } catch {
      // Keep the previous complete tile set and retry instead of exposing a blank canvas.
      return false;
    } finally {
      this.closeBitmaps(loadedTiles);
    }

    if (version !== this.renderVersion) {
      for (const canvas of stagedCanvases) canvas.remove();
      return false;
    }
    for (const canvas of stagedCanvases) {
      const context = canvas.getContext('2d');
      if (!context || isCanvasContextLost(context)) return false;
    }

    for (const canvas of this.canvases.values()) {
      if (!nextCanvases.has(canvas.dataset.tileAddress || '')) canvas.remove();
    }
    for (const canvas of nextCanvases.values()) {
      if (!canvas.isConnected) this.options.layer.append(canvas);
      this.positionCanvas(canvas, this.options.getScale());
    }
    this.canvases.clear();
    for (const [key, canvas] of nextCanvases) this.canvases.set(key, canvas);
    for (const canvas of stagedCanvases) {
      this.invalidatedTiles.delete(canvas.dataset.tileAddress || '');
    }
    return true;
  }

  private scheduleRetry(): void {
    this.failedRenderCount++;
    if (this.failedRenderCount === 3) {
      this.options.onError(new Error('Фрагменты карты не удалось отрисовать. Повторяю загрузку.'));
    }
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.requestRender(), 1200);
  }

  private closeBitmaps(bitmaps: Map<string, ImageBitmap>): void {
    for (const bitmap of bitmaps.values()) bitmap.close();
    bitmaps.clear();
  }

  private async fetchTile(
    query: URLSearchParams,
    version: number,
    signal: AbortSignal,
  ): Promise<Response> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (version !== this.renderVersion) throw new Error('Map tile request was superseded.');
      try {
        // Let the browser validate its ETag cache instead of forcing an uncached download.
        const response = await fetch(`/api/world-map/tile?${query}`, { cache: 'default', signal });
        if (response.ok) return response;
        if (response.status < 500 && response.status !== 429) {
          throw new Error(`Map tile request failed with HTTP ${response.status}`);
        }
        lastError = new Error(`Map tile request failed with HTTP ${response.status}`);
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private chooseLevel(): number {
    const scale = this.options.getScale();
    const world = this.options.getWorld();
    if (!world) return 0;

    let level = Math.max(0, Math.min(MAX_LEVEL, Math.ceil(Math.log2(1 / scale))));
    const bounds = this.getVisibleWorldBounds(world);
    // Prefer the sharpest level that still fits in the fixed ten-tile memory budget.
    while (level < MAX_LEVEL && this.countVisibleTiles(bounds, level) > MAX_VISIBLE_TILES) {
      level += 1;
    }
    return level;
  }

  private countVisibleTiles(
    bounds: { left: number; top: number; right: number; bottom: number },
    level: number,
  ): number {
    const tileWorldSize = TILE_SIZE * (1 << level);
    const columns = Math.max(
      1,
      Math.ceil(bounds.right / tileWorldSize) - Math.floor(bounds.left / tileWorldSize),
    );
    const rows = Math.max(
      1,
      Math.ceil(bounds.bottom / tileWorldSize) - Math.floor(bounds.top / tileWorldSize),
    );
    return columns * rows;
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
