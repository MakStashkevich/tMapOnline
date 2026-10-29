/** Keeps decoded tile images in a small, reusable least-recently-used cache. */
export class MapTileBitmapCache {
  private readonly bitmaps = new Map<string, ImageBitmap>();
  private readonly pendingLoads = new Map<string, PendingBitmapLoad>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.bitmaps.size;
  }

  getOrLoad(key: string, load: () => Promise<ImageBitmap>): Promise<ImageBitmap> {
    const cached = this.bitmaps.get(key);
    if (cached) {
      this.bitmaps.delete(key);
      this.bitmaps.set(key, cached);
      return Promise.resolve(cached);
    }

    const existingLoad = this.pendingLoads.get(key);
    if (existingLoad?.promise) return existingLoad.promise;

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
    bitmap.close();
  }

  clear(): void {
    for (const pendingLoad of this.pendingLoads.values()) pendingLoad.valid = false;
    this.pendingLoads.clear();
    for (const bitmap of this.bitmaps.values()) bitmap.close();
    this.bitmaps.clear();
  }

  private keep(key: string, bitmap: ImageBitmap): void {
    this.bitmaps.set(key, bitmap);
    while (this.bitmaps.size > this.capacity) {
      const oldestKey = this.bitmaps.keys().next().value;
      if (oldestKey === undefined) return;

      const oldestBitmap = this.bitmaps.get(oldestKey);
      this.bitmaps.delete(oldestKey);
      oldestBitmap?.close();
    }
  }
}

type PendingBitmapLoad = { promise: Promise<ImageBitmap> | null; valid: boolean };
