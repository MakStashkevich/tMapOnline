/** Keeps decoded tile images in a small, reusable least-recently-used cache. */
export class MapTileBitmapCache {
  private readonly bitmaps = new Map<string, ImageBitmap>();
  private readonly pendingLoads = new Map<string, PendingBitmapLoad>();
  private cachedBytes = 0;
  private hits = 0;
  private misses = 0;
  private sharedLoads = 0;
  private evictions = 0;

  constructor(
    private readonly capacity: number,
    private readonly byteCapacity = 4 * 1024 * 1024,
  ) {}

  get size(): number {
    return this.bitmaps.size;
  }

  getMetrics(): {
    entries: number;
    bytes: number;
    byteCapacity: number;
    hits: number;
    misses: number;
    sharedLoads: number;
    evictions: number;
    pendingLoads: number;
  } {
    return {
      entries: this.bitmaps.size,
      bytes: this.cachedBytes,
      byteCapacity: this.byteCapacity,
      hits: this.hits,
      misses: this.misses,
      sharedLoads: this.sharedLoads,
      evictions: this.evictions,
      pendingLoads: this.pendingLoads.size,
    };
  }

  getOrLoad(key: string, load: () => Promise<ImageBitmap>): Promise<ImageBitmap> {
    const cached = this.bitmaps.get(key);
    if (cached) {
      this.hits += 1;
      this.bitmaps.delete(key);
      this.bitmaps.set(key, cached);
      return Promise.resolve(cached);
    }

    const existingLoad = this.pendingLoads.get(key);
    if (existingLoad?.promise) {
      this.sharedLoads += 1;
      return existingLoad.promise;
    }
    this.misses += 1;

    const request: PendingBitmapLoad = { promise: null, valid: true };
    const pendingLoad = Promise.resolve()
      .then(load)
      .then((bitmap) => {
        if (!request.valid) {
          bitmap.close();
          return bitmap;
        }

        this.keep(key, bitmap);
        return bitmap;
      })
      .finally(() => {
        if (this.pendingLoads.get(key) === request) this.pendingLoads.delete(key);
      });

    request.promise = pendingLoad;
    this.pendingLoads.set(key, request);
    return pendingLoad;
  }

  invalidate(key: string): void {
    const pendingLoad = this.pendingLoads.get(key);
    if (pendingLoad) pendingLoad.valid = false;
    this.pendingLoads.delete(key);

    const bitmap = this.bitmaps.get(key);
    if (!bitmap) return;

    this.bitmaps.delete(key);
    this.cachedBytes -= bitmap.width * bitmap.height * 4;
    bitmap.close();
  }

  clear(): void {
    for (const pendingLoad of this.pendingLoads.values()) pendingLoad.valid = false;
    this.pendingLoads.clear();
    for (const bitmap of this.bitmaps.values()) bitmap.close();
    this.bitmaps.clear();
    this.cachedBytes = 0;
  }

  private keep(key: string, bitmap: ImageBitmap): void {
    this.bitmaps.set(key, bitmap);
    this.cachedBytes += bitmap.width * bitmap.height * 4;
    while (this.bitmaps.size > this.capacity || this.cachedBytes > this.byteCapacity) {
      const oldestKey = this.bitmaps.keys().next().value;
      if (oldestKey === undefined) return;

      const oldestBitmap = this.bitmaps.get(oldestKey);
      this.bitmaps.delete(oldestKey);
      if (oldestBitmap) this.cachedBytes -= oldestBitmap.width * oldestBitmap.height * 4;
      oldestBitmap?.close();
      this.evictions += 1;
    }
  }
}

type PendingBitmapLoad = { promise: Promise<ImageBitmap> | null; valid: boolean };
