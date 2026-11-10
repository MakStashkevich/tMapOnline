import { MapTileImageCache } from './map-tile-image-cache';

type WorldSize = { id: string | number; width: number; height: number };
type MapTile = { x: number; y: number; key: string };
type WorldPoint = { x: number; y: number };

type PyramidLayerOptions = {
  layer: HTMLElement;
  viewport: HTMLElement;
  stage: HTMLElement;
  getWorld: () => WorldSize | null;
  getScale: () => number;
  getProfile: () => string | null;
  getPriorityPoint?: () => WorldPoint | null;
  onError: (error: unknown) => void;
};

const TILE_SIZE = 256;
const MAX_LEVEL = 8;
const MAX_VISIBLE_TILES = 10;
const MAX_ACTIVE_TILE_IMAGES = 16;
const MAX_CACHED_TILE_IMAGES = 16;
// Keep the currently displayed pyramid level in place during active pinch zoom.
// Mobile browsers can flash while repeatedly tearing down and replacing image layers.
const TILE_RENDER_DEBOUNCE_MS = 160;
const TILE_RENDER_BATCH_SIZE = 4;

/** Fetches only map pyramid tiles intersecting the current viewport. */
export class MapPyramidLayerRenderer {
  private readonly tiles = new Map<string, HTMLImageElement>();
  private readonly pinnedOverviewKeys = new Set<string>();
  private readonly imageCache = new MapTileImageCache(MAX_CACHED_TILE_IMAGES);
  private readonly invalidatedTiles = new Set<string>();
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private renderRunning = false;
  private renderPending = false;
  private renderVersion = 0;
  private lastRenderDurationMs = 0;
  private lastRenderTileCount = 0;
  private failedRenderCount = 0;
  private activeRenderController: AbortController | null = null;

  constructor(private readonly options: PyramidLayerOptions) {}

  layout(): void {
    const scale = this.options.getScale();
    for (const image of this.tiles.values()) this.positionTile(image, scale);
  }

  isDetailZoom(): boolean {
    return this.chooseLevel() === 0;
  }

  requestRender(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderVersion++;
    this.renderTimer = setTimeout(() => {
      this.activeRenderController?.abort();
      void this.renderLatestViewport();
    }, TILE_RENDER_DEBOUNCE_MS);
  }

  clear(): void {
    this.activeRenderController?.abort();
    this.activeRenderController = null;
    this.renderVersion++;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.renderPending = false;
    for (const image of this.tiles.values()) this.removeTile(image);
    this.tiles.clear();
    this.pinnedOverviewKeys.clear();
    this.invalidatedTiles.clear();
    this.imageCache.clear();
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
      this.imageCache.invalidate(address);
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
      this.imageCache.invalidate(address);
    }
    this.requestRender();
  }

  getDebugMetrics(): {
    visibleTiles: number;
    lastRenderDurationMs: number;
    lastRenderChunkCount: number;
    rendering: boolean;
    cachedPngBytes: number;
    cachedPngTiles: number;
    imageCacheHits: number;
    imageCacheMisses: number;
    sharedTileLoads: number;
    imageCacheEvictions: number;
    pendingTileLoads: number;
    failedRenderCount: number;
  } {
    const imageCache = this.imageCache.getMetrics();
    return {
      visibleTiles: this.tiles.size,
      lastRenderDurationMs: this.lastRenderDurationMs,
      lastRenderChunkCount: this.lastRenderTileCount,
      rendering: this.renderRunning,
      cachedPngBytes: imageCache.bytes,
      cachedPngTiles: imageCache.entries,
      imageCacheHits: imageCache.hits,
      imageCacheMisses: imageCache.misses,
      sharedTileLoads: imageCache.sharedLoads,
      imageCacheEvictions: imageCache.evictions,
      pendingTileLoads: imageCache.pendingLoads,
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
      const controller = new AbortController();
      this.activeRenderController = controller;
      const startedAt = performance.now();
      try {
        await this.renderVisibleTiles(version, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) this.options.onError(error);
      }
      if (this.activeRenderController === controller) this.activeRenderController = null;
      this.lastRenderDurationMs = performance.now() - startedAt;
    } while (this.renderPending);
    this.renderRunning = false;
  }

  private async renderVisibleTiles(version: number, signal: AbortSignal): Promise<void> {
    const world = this.options.getWorld();
    if (!world) return;

    await this.ensurePinnedOverview(world, version, signal);
    if (version !== this.renderVersion) return;

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
    const priorityPoint = this.options.getPriorityPoint?.();

    const desiredTileKeys = new Set(tiles.map(({ key }) => key));
    const needsNewDetailTiles = tiles.some(
      ({ key }) => !this.tiles.has(key) || this.invalidatedTiles.has(key),
    );
    if (!needsNewDetailTiles) {
      this.removeTilesOutside(desiredTileKeys);
      return;
    }

    // Load one coarser level first. It covers new view areas while sharp tiles arrive.
    if (level < MAX_LEVEL) {
      const fallbackLevel = level + 1;
      const fallbackTileWorldSize = TILE_SIZE * (1 << fallbackLevel);
      const fallbackCenterX = priorityPoint
        ? priorityPoint.x / fallbackTileWorldSize
        : (visibleBounds.left + visibleBounds.right) / 2 / fallbackTileWorldSize;
      const fallbackCenterY = priorityPoint
        ? priorityPoint.y / fallbackTileWorldSize
        : (visibleBounds.top + visibleBounds.bottom) / 2 / fallbackTileWorldSize;
      const fallbackTiles = this.parentTilesFor(tiles, world.id, fallbackLevel).sort(
        (left, right) => {
          const leftDistance = Math.hypot(
            left.x + 0.5 - fallbackCenterX,
            left.y + 0.5 - fallbackCenterY,
          );
          const rightDistance = Math.hypot(
            right.x + 0.5 - fallbackCenterX,
            right.y + 0.5 - fallbackCenterY,
          );
          return leftDistance - rightDistance;
        },
      );
      const fallback = await this.loadTileImages(fallbackTiles, world, level + 1, version, signal);
      if (version !== this.renderVersion) return;

      const fallbackImages = await this.createTileImages(
        fallbackTiles,
        fallback.blobs,
        world,
        TILE_SIZE * (1 << (level + 1)),
        level + 1,
      );
      if (!fallbackImages) {
        this.scheduleRetry();
        return;
      }
      if (version !== this.renderVersion) {
        this.disposeTileImages(fallbackImages);
        return;
      }
      this.installTileImages(fallbackImages);
      this.removeTilesOutside(
        new Set([...desiredTileKeys, ...fallbackTiles.map(({ key }) => key)]),
        true,
      );
      if (fallback.failed) this.scheduleRetry();
    }

    const priorityTileX = priorityPoint
      ? Math.min(lastX - 0.5, Math.max(firstX + 0.5, priorityPoint.x / tileWorldSize))
      : (firstX + lastX) / 2;
    const priorityTileY = priorityPoint
      ? Math.min(lastY - 0.5, Math.max(firstY + 0.5, priorityPoint.y / tileWorldSize))
      : (firstY + lastY) / 2;
    const prioritizedTiles = [...tiles].sort((left, right) => {
      const leftDistance = Math.hypot(left.x + 0.5 - priorityTileX, left.y + 0.5 - priorityTileY);
      const rightDistance = Math.hypot(
        right.x + 0.5 - priorityTileX,
        right.y + 0.5 - priorityTileY,
      );
      return leftDistance - rightDistance;
    });

    let failedTiles = false;
    for (let start = 0; start < prioritizedTiles.length; start += TILE_RENDER_BATCH_SIZE) {
      if (version !== this.renderVersion) return;

      const batch = prioritizedTiles.slice(start, start + TILE_RENDER_BATCH_SIZE);
      const result = await this.loadTileImages(batch, world, level, version, signal);
      if (version !== this.renderVersion) return;

      const images = await this.createTileImages(batch, result.blobs, world, tileWorldSize, level);
      if (!images) {
        failedTiles = true;
      } else {
        if (version !== this.renderVersion) {
          this.disposeTileImages(images);
          return;
        }
        this.installTileImages(images);
      }
      failedTiles ||= result.failed;
      this.removeCoveredFallbackTiles(tiles, level);
      this.removeTilesOutside(this.getRequiredTileKeys(tiles, level), true);

      if (start + TILE_RENDER_BATCH_SIZE < prioritizedTiles.length) await this.nextFrame();
    }

    if (failedTiles) {
      this.scheduleRetry();
      return;
    }
    this.removeTilesOutside(this.getRequiredTileKeys(tiles, level));
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

  private async ensurePinnedOverview(
    world: WorldSize,
    version: number,
    signal: AbortSignal,
  ): Promise<void> {
    const overviewTileWorldSize = TILE_SIZE * (1 << MAX_LEVEL);
    const columns = Math.ceil(world.width / overviewTileWorldSize);
    const rows = Math.ceil(world.height / overviewTileWorldSize);
    const overviewTiles: MapTile[] = [];

    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        const key = `${world.id}:${MAX_LEVEL}:${x}:${y}`;
        overviewTiles.push({ x, y, key });
        this.pinnedOverviewKeys.add(key);
      }
    }
    const worldCenterX = world.width / 2 / overviewTileWorldSize;
    const worldCenterY = world.height / 2 / overviewTileWorldSize;
    overviewTiles.sort((left, right) => {
      const leftDistance = Math.hypot(left.x + 0.5 - worldCenterX, left.y + 0.5 - worldCenterY);
      const rightDistance = Math.hypot(right.x + 0.5 - worldCenterX, right.y + 0.5 - worldCenterY);
      return leftDistance - rightDistance;
    });

    const missingTiles = overviewTiles.filter(
      ({ key }) => !this.tiles.has(key) || this.invalidatedTiles.has(key),
    );
    if (missingTiles.length === 0) return;

    const result = await this.loadTileImages(missingTiles, world, MAX_LEVEL, version, signal);
    if (version !== this.renderVersion) return;

    const images = await this.createTileImages(
      missingTiles,
      result.blobs,
      world,
      overviewTileWorldSize,
      MAX_LEVEL,
    );
    if (!images) {
      this.scheduleRetry();
      return;
    }
    if (version !== this.renderVersion) {
      this.disposeTileImages(images);
      return;
    }

    this.installTileImages(images);
    if (result.failed) this.scheduleRetry();
  }

  private async loadTileImages(
    tiles: MapTile[],
    world: WorldSize,
    level: number,
    version: number,
    signal: AbortSignal,
  ): Promise<{ blobs: Map<string, Blob>; failed: boolean }> {
    const blobs = new Map<string, Blob>();
    let failed = false;

    for (let start = 0; start < tiles.length; start += TILE_RENDER_BATCH_SIZE) {
      if (version !== this.renderVersion) return { blobs, failed };

      const requestedTiles = tiles
        .slice(start, start + TILE_RENDER_BATCH_SIZE)
        .filter(({ key }) => !this.tiles.has(key) || this.invalidatedTiles.has(key));
      const results = await Promise.allSettled(
        requestedTiles.map(async (tile) => ({
          tile,
          blob: await this.imageCache.getOrLoad(tile.key, () =>
            this.loadTileBlob(world, level, tile.x, tile.y, signal),
          ),
        })),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') blobs.set(result.value.tile.key, result.value.blob);
        else failed = true;
      }

      if (start + TILE_RENDER_BATCH_SIZE < tiles.length) await this.nextFrame();
    }

    return { blobs, failed };
  }

  private async createTileImages(
    tiles: MapTile[],
    blobs: Map<string, Blob>,
    world: WorldSize,
    tileWorldSize: number,
    level: number,
  ): Promise<Map<string, HTMLImageElement> | null> {
    const images = new Map<string, HTMLImageElement>();
    for (const tile of tiles) {
      const blob = blobs.get(tile.key);
      if (!blob) continue;

      const image = document.createElement('img');
      const objectUrl = URL.createObjectURL(blob);
      image.className = 'map-pyramid-tile';
      image.alt = '';
      image.decoding = 'async';
      image.dataset.worldLeft = String(tile.x * tileWorldSize);
      image.dataset.worldTop = String(tile.y * tileWorldSize);
      image.dataset.tileAddress = tile.key;
      image.dataset.worldWidth = String(
        Math.min(tileWorldSize, world.width - tile.x * tileWorldSize),
      );
      image.dataset.worldHeight = String(
        Math.min(tileWorldSize, world.height - tile.y * tileWorldSize),
      );
      image.dataset.objectUrl = objectUrl;
      image.style.zIndex = String(MAX_LEVEL - level);
      image.src = objectUrl;

      try {
        await image.decode();
      } catch {
        if (image.naturalWidth === 0) {
          this.removeTile(image);
          this.disposeTileImages(images);
          return null;
        }
      }
      image.style.width = `${image.naturalWidth}px`;
      image.style.height = `${image.naturalHeight}px`;
      images.set(tile.key, image);
    }

    return images;
  }

  private installTileImages(images: Map<string, HTMLImageElement>): void {
    for (const [key, image] of images) {
      const previousImage = this.tiles.get(key);
      if (!image.isConnected) this.options.layer.append(image);
      this.positionTile(image, this.options.getScale());
      this.tiles.set(key, image);
      if (previousImage) this.removeTile(previousImage);
      this.invalidatedTiles.delete(key);
    }
  }

  private removeTile(image: HTMLImageElement): void {
    image.remove();
    const objectUrl = image.dataset.objectUrl;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }

  private disposeTileImages(images: Map<string, HTMLImageElement>): void {
    for (const image of images.values()) this.removeTile(image);
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
      if (this.pinnedOverviewKeys.has(parentKey)) continue;
      if (!childKeys.every((key) => this.tiles.has(key) && !this.invalidatedTiles.has(key)))
        continue;
      const parentImage = this.tiles.get(parentKey);
      if (parentImage) this.removeTile(parentImage);
      this.tiles.delete(parentKey);
    }
  }

  private getRequiredTileKeys(tiles: MapTile[], level: number): Set<string> {
    const required = new Set(tiles.map(({ key }) => key));
    if (level >= MAX_LEVEL) return required;

    const worldId = this.options.getWorld()?.id ?? '';
    for (const tile of tiles) {
      const parentKey = `${worldId}:${level + 1}:${Math.floor(tile.x / 2)}:${Math.floor(tile.y / 2)}`;
      if (!this.tiles.has(tile.key) || this.invalidatedTiles.has(tile.key)) required.add(parentKey);
    }
    return required;
  }

  private removeTilesOutside(requiredKeys: Set<string>, preserveVisible = false): void {
    // Only count installed images toward the active limit. Counting requested-but-not-yet-loaded
    // detail tiles can evict their visible parent fallback and expose the viewport background.
    const retainedKeys = new Set(
      [...requiredKeys].filter((key) => this.tiles.has(key)).slice(0, MAX_ACTIVE_TILE_IMAGES),
    );
    for (const key of this.pinnedOverviewKeys) {
      if (this.tiles.has(key)) retainedKeys.add(key);
    }

    if (preserveVisible && retainedKeys.size < MAX_ACTIVE_TILE_IMAGES) {
      const world = this.options.getWorld();
      if (world) {
        const bounds = this.getVisibleWorldBounds(world);
        const existingVisibleTiles = [...this.tiles.entries()]
          .filter(([key, image]) => {
            if (retainedKeys.has(key)) return false;
            const left = Number(image.dataset.worldLeft);
            const top = Number(image.dataset.worldTop);
            const right = left + Number(image.dataset.worldWidth);
            const bottom = top + Number(image.dataset.worldHeight);
            return (
              right > bounds.left &&
              left < bounds.right &&
              bottom > bounds.top &&
              top < bounds.bottom
            );
          })
          .sort(([, left], [, right]) => {
            const leftLevel = MAX_LEVEL - Number(left.style.zIndex);
            const rightLevel = MAX_LEVEL - Number(right.style.zIndex);
            return leftLevel - rightLevel;
          });

        for (const [key] of existingVisibleTiles) {
          if (retainedKeys.size >= MAX_ACTIVE_TILE_IMAGES) break;
          retainedKeys.add(key);
        }
      }
    }

    for (const [key, image] of this.tiles) {
      if (retainedKeys.has(key)) continue;
      this.removeTile(image);
      this.tiles.delete(key);
    }
  }

  private async loadTileBlob(
    world: WorldSize,
    level: number,
    tileX: number,
    tileY: number,
    signal: AbortSignal,
  ): Promise<Blob> {
    const query = new URLSearchParams({
      world: String(world.id),
      level: String(level),
      x: String(tileX),
      y: String(tileY),
    });
    const profile = this.options.getProfile();
    if (profile) query.set('profile', profile);
    const response = await this.fetchTile(query, signal);
    const blob = await response.blob();
    if (signal.aborted) throw new DOMException('Map tile request was superseded', 'AbortError');
    return blob;
  }

  private scheduleRetry(): void {
    this.failedRenderCount++;
    if (this.failedRenderCount === 3) {
      this.options.onError(new Error('Фрагменты карты не удалось отрисовать. Повторяю загрузку.'));
    }
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.requestRender(), 1200);
  }

  private async fetchTile(query: URLSearchParams, signal: AbortSignal): Promise<Response> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal.aborted) throw new DOMException('Map tile request was superseded', 'AbortError');
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
      if (attempt < 2) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, 200 * (attempt + 1));
          signal.addEventListener('abort', finish, { once: true });
          if (signal.aborted) finish();
        });
      }
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

  private positionTile(image: HTMLImageElement, scale: number): void {
    const left = Math.floor(Number(image.dataset.worldLeft) * scale);
    const top = Math.floor(Number(image.dataset.worldTop) * scale);
    const right = Math.ceil(
      (Number(image.dataset.worldLeft) + Number(image.dataset.worldWidth)) * scale,
    );
    const bottom = Math.ceil(
      (Number(image.dataset.worldTop) + Number(image.dataset.worldHeight)) * scale,
    );
    image.style.left = `${left}px`;
    image.style.top = `${top}px`;
    image.style.width = `${right - left}px`;
    image.style.height = `${bottom - top}px`;
  }

  private nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
}
