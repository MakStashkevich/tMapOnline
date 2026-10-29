import { MapTileBitmapCache } from './map-tile-bitmap-cache';

type WorldSize = { id: string | number; width: number; height: number };
type MapTile = { x: number; y: number; key: string };

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
const MAX_ACTIVE_TILE_CANVASES = 16;
const MAX_CACHED_BITMAPS = 16;
const TILE_RENDER_DEBOUNCE_MS = 45;
const TILE_RENDER_BATCH_SIZE = 4;

function isCanvasContextLost(context: CanvasRenderingContext2D): boolean {
  // Safari versions without this optional API still provide a usable 2D context.
  return typeof context.isContextLost === 'function' && context.isContextLost();
}

/** Fetches only map pyramid tiles intersecting the current viewport. */
export class MapPyramidLayerRenderer {
  private readonly canvases = new Map<string, HTMLCanvasElement>();
  private readonly bitmapCache = new MapTileBitmapCache(MAX_CACHED_BITMAPS);
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
    this.bitmapCache.clear();
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

    for (const address of affected) {
      this.invalidatedTiles.add(address);
      this.bitmapCache.invalidate(address);
    }
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
        for (let ancestorLevel = level; ancestorLevel <= MAX_LEVEL; ancestorLevel += 1) {
          const difference = ancestorLevel - level;
          affected.add(
            `${world.id}:${ancestorLevel}:${Math.floor(x / (1 << difference))}:${Math.floor(y / (1 << difference))}`,
          );
        }
      }
    }
    for (const address of affected) {
      this.invalidatedTiles.add(address);
      this.bitmapCache.invalidate(address);
    }
    this.requestRender();
  }

  getDebugMetrics(): {
    visibleCanvases: number;
    lastRenderDurationMs: number;
    lastRenderChunkCount: number;
    rendering: boolean;
    canvasBytes: number;
    decodedChunkCount: number;
    decodedBitmapBytes: number;
    bitmapCacheHits: number;
    bitmapCacheMisses: number;
    sharedTileLoads: number;
    bitmapCacheEvictions: number;
    pendingTileLoads: number;
    failedRenderCount: number;
  } {
    let canvasBytes = 0;
    for (const canvas of this.canvases.values()) {
      canvasBytes += canvas.width * canvas.height * 4;
    }
    const bitmapCache = this.bitmapCache.getMetrics();
    return {
      visibleCanvases: this.canvases.size,
      lastRenderDurationMs: this.lastRenderDurationMs,
      lastRenderChunkCount: this.lastRenderTileCount,
      rendering: this.renderRunning,
      canvasBytes,
      decodedChunkCount: bitmapCache.entries,
      decodedBitmapBytes: bitmapCache.bytes,
      bitmapCacheHits: bitmapCache.hits,
      bitmapCacheMisses: bitmapCache.misses,
      sharedTileLoads: bitmapCache.sharedLoads,
      bitmapCacheEvictions: bitmapCache.evictions,
      pendingTileLoads: bitmapCache.pendingLoads,
      failedRenderCount: this.failedRenderCount,
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
    const tiles: MapTile[] = [];

    for (let y = firstY; y < lastY; y++) {
      for (let x = firstX; x < lastX; x++) {
        const address = `${world.id}:${level}:${x}:${y}`;
        tiles.push({ x, y, key: address });
      }
    }
    if (tiles.length === 0) return;
    this.lastRenderTileCount = tiles.length;

    const desiredTileKeys = new Set(tiles.map(({ key }) => key));
    const needsNewDetailTiles = tiles.some(
      ({ key }) => !this.canvases.has(key) || this.invalidatedTiles.has(key),
    );
    if (!needsNewDetailTiles) {
      this.removeCanvasesOutside(desiredTileKeys);
      return;
    }

    // Load one coarser level first. It covers new view areas while sharp tiles arrive.
    if (level < MAX_LEVEL) {
      const fallbackTiles = this.parentTilesFor(tiles, world.id, level + 1);
      const fallback = await this.loadTileBitmaps(fallbackTiles, world, level + 1, version);
      if (version !== this.renderVersion) return;

      const fallbackCanvases = this.createTileCanvases(
        fallbackTiles,
        fallback.bitmaps,
        TILE_SIZE * (1 << (level + 1)),
        level + 1,
      );
      if (!fallbackCanvases) {
        this.scheduleRetry();
        return;
      }
      this.installTileCanvases(fallbackCanvases);
      this.removeCanvasesOutside(
        new Set([...desiredTileKeys, ...fallbackTiles.map(({ key }) => key)]),
      );
      if (fallback.failed) this.scheduleRetry();
    }

    const prioritizedTiles = [...tiles].sort((left, right) => {
      const leftDistance = Math.hypot(
        left.x + 0.5 - (firstX + lastX) / 2,
        left.y + 0.5 - (firstY + lastY) / 2,
      );
      const rightDistance = Math.hypot(
        right.x + 0.5 - (firstX + lastX) / 2,
        right.y + 0.5 - (firstY + lastY) / 2,
      );
      return leftDistance - rightDistance;
    });

    let failedTiles = false;
    for (let start = 0; start < prioritizedTiles.length; start += TILE_RENDER_BATCH_SIZE) {
      if (version !== this.renderVersion) return;

      const batch = prioritizedTiles.slice(start, start + TILE_RENDER_BATCH_SIZE);
      const result = await this.loadTileBitmaps(batch, world, level, version);
      if (version !== this.renderVersion) return;

      const canvases = this.createTileCanvases(batch, result.bitmaps, tileWorldSize, level);
      if (!canvases) {
        failedTiles = true;
      } else {
        this.installTileCanvases(canvases);
      }
      failedTiles ||= result.failed;
      this.removeCoveredFallbackTiles(tiles, level);
      this.removeCanvasesOutside(this.getRequiredTileKeys(tiles, level));

      if (start + TILE_RENDER_BATCH_SIZE < prioritizedTiles.length) await this.nextFrame();
    }

    if (failedTiles) {
      this.scheduleRetry();
      return;
    }
    this.failedRenderCount = 0;
  }

  private parentTilesFor(tiles: MapTile[], worldId: string | number, level: number): MapTile[] {
    const parents = new Map<string, MapTile>();
    for (const tile of tiles) {
      const x = Math.floor(tile.x / 2);
      const y = Math.floor(tile.y / 2);
      const key = `${worldId}:${level}:${x}:${y}`;
      parents.set(key, { x, y, key });
    }
    return [...parents.values()];
  }

  private async loadTileBitmaps(
    tiles: MapTile[],
    world: WorldSize,
    level: number,
    version: number,
  ): Promise<{ bitmaps: Map<string, ImageBitmap>; failed: boolean }> {
    const bitmaps = new Map<string, ImageBitmap>();
    let failed = false;

    for (let start = 0; start < tiles.length; start += TILE_RENDER_BATCH_SIZE) {
      if (version !== this.renderVersion) return { bitmaps, failed };

      const requestedTiles = tiles
        .slice(start, start + TILE_RENDER_BATCH_SIZE)
        .filter(({ key }) => !this.canvases.has(key) || this.invalidatedTiles.has(key));
      const results = await Promise.allSettled(
        requestedTiles.map(async (tile) => ({
          tile,
          bitmap: await this.bitmapCache.getOrLoad(tile.key, () =>
            this.loadTileBitmap(world, level, tile.x, tile.y),
          ),
        })),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') bitmaps.set(result.value.tile.key, result.value.bitmap);
        else failed = true;
      }

      if (start + TILE_RENDER_BATCH_SIZE < tiles.length) await this.nextFrame();
    }

    return { bitmaps, failed };
  }

  private createTileCanvases(
    tiles: MapTile[],
    bitmaps: Map<string, ImageBitmap>,
    tileWorldSize: number,
    level: number,
  ): Map<string, HTMLCanvasElement> | null {
    const canvases = new Map<string, HTMLCanvasElement>();
    try {
      for (const tile of tiles) {
        const bitmap = bitmaps.get(tile.key);
        if (!bitmap) continue;

        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        if (!context || isCanvasContextLost(context)) return null;

        context.imageSmoothingEnabled = false;
        context.drawImage(bitmap, 0, 0);
        if (isCanvasContextLost(context)) return null;

        canvas.className = 'map-pyramid-tile';
        canvas.dataset.worldLeft = String(tile.x * tileWorldSize);
        canvas.dataset.worldTop = String(tile.y * tileWorldSize);
        canvas.dataset.tileAddress = tile.key;
        canvas.dataset.worldWidth = String(canvas.width * (tileWorldSize / TILE_SIZE));
        canvas.dataset.worldHeight = String(canvas.height * (tileWorldSize / TILE_SIZE));
        canvas.style.zIndex = String(MAX_LEVEL - level);
        canvas.addEventListener('contextlost', (event) => {
          event.preventDefault();
          if (this.canvases.get(tile.key) !== canvas) return;

          this.invalidatedTiles.add(tile.key);
          this.requestRender();
        });
        canvases.set(tile.key, canvas);
      }
    } catch {
      return null;
    }

    return canvases;
  }

  private installTileCanvases(canvases: Map<string, HTMLCanvasElement>): void {
    for (const [key, canvas] of canvases) {
      const previousCanvas = this.canvases.get(key);
      if (!canvas.isConnected) this.options.layer.append(canvas);
      this.positionCanvas(canvas, this.options.getScale());
      this.canvases.set(key, canvas);
      previousCanvas?.remove();
      this.invalidatedTiles.delete(key);
    }
  }

  private removeCoveredFallbackTiles(tiles: MapTile[], level: number): void {
    if (level >= MAX_LEVEL) return;

    const childrenByParent = new Map<string, string[]>();
    for (const tile of tiles) {
      const parentKey = `${this.options.getWorld()?.id ?? ''}:${level + 1}:${Math.floor(tile.x / 2)}:${Math.floor(tile.y / 2)}`;
      const childKeys = childrenByParent.get(parentKey) || [];
      childKeys.push(tile.key);
      childrenByParent.set(parentKey, childKeys);
    }

    for (const [parentKey, childKeys] of childrenByParent) {
      if (!childKeys.every((key) => this.canvases.has(key) && !this.invalidatedTiles.has(key)))
        continue;
      this.canvases.get(parentKey)?.remove();
      this.canvases.delete(parentKey);
    }
  }

  private getRequiredTileKeys(tiles: MapTile[], level: number): Set<string> {
    const required = new Set(tiles.map(({ key }) => key));
    if (level >= MAX_LEVEL) return required;

    const worldId = this.options.getWorld()?.id ?? '';
    for (const tile of tiles) {
      const parentKey = `${worldId}:${level + 1}:${Math.floor(tile.x / 2)}:${Math.floor(tile.y / 2)}`;
      if (!this.canvases.has(tile.key) || this.invalidatedTiles.has(tile.key))
        required.add(parentKey);
    }
    return required;
  }

  private removeCanvasesOutside(requiredKeys: Set<string>): void {
    const retainedKeys = new Set([...requiredKeys].slice(0, MAX_ACTIVE_TILE_CANVASES));
    for (const [key, canvas] of this.canvases) {
      if (retainedKeys.has(key)) continue;
      canvas.remove();
      this.canvases.delete(key);
    }
  }

  private async loadTileBitmap(
    world: WorldSize,
    level: number,
    tileX: number,
    tileY: number,
  ): Promise<ImageBitmap> {
    const query = new URLSearchParams({
      world: String(world.id),
      level: String(level),
      x: String(tileX),
      y: String(tileY),
    });
    const response = await this.fetchTile(query);
    return createImageBitmap(await response.blob());
  }

  private scheduleRetry(): void {
    this.failedRenderCount++;
    if (this.failedRenderCount === 3) {
      this.options.onError(new Error('Фрагменты карты не удалось отрисовать. Повторяю загрузку.'));
    }
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.requestRender(), 1200);
  }

  private async fetchTile(query: URLSearchParams): Promise<Response> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
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
