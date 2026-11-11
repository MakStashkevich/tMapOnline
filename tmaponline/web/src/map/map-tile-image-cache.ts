/** Keeps compressed PNG tile data in a small, reusable least-recently-used cache. */
export class MapTileImageCache {
  private readonly blobs = new Map<string, Blob>();
  private readonly pendingLoads = new Map<string, PendingBlobLoad>();
  private cachedBytes = 0;
  private hits = 0;
  private misses = 0;
  private sharedLoads = 0;
  private evictions = 0;

  constructor(
    private readonly capacity: number,
    private readonly byteCapacity = 4 * 1024 * 1024,
  ) {}

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
      entries: this.blobs.size,
      bytes: this.cachedBytes,
      byteCapacity: this.byteCapacity,
      hits: this.hits,
      misses: this.misses,
      sharedLoads: this.sharedLoads,
      evictions: this.evictions,
      pendingLoads: this.pendingLoads.size,
    };
  }

  getOrLoad(key: string, load: () => Promise<Blob>): Promise<Blob> {
    const cached = this.blobs.get(key);
    if (cached) {
      this.hits += 1;
      this.blobs.delete(key);
      this.blobs.set(key, cached);
      return Promise.resolve(cached);
    }

    const existingLoad = this.pendingLoads.get(key);
    if (existingLoad?.promise) {
      this.sharedLoads += 1;
      return existingLoad.promise;
    }
    this.misses += 1;

    const request: PendingBlobLoad = { promise: null, valid: true };
    const pendingLoad = Promise.resolve()
      .then(load)
      .then((blob) => {
        if (request.valid) this.keep(key, blob);
        return blob;
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

    const blob = this.blobs.get(key);
    if (!blob) return;

    this.blobs.delete(key);
    this.cachedBytes -= blob.size;
  }

  clear(): void {
    for (const pendingLoad of this.pendingLoads.values()) pendingLoad.valid = false;
    this.pendingLoads.clear();
    this.blobs.clear();
    this.cachedBytes = 0;
  }

  private keep(key: string, blob: Blob): void {
    this.blobs.set(key, blob);
    this.cachedBytes += blob.size;
    while (this.blobs.size > this.capacity || this.cachedBytes > this.byteCapacity) {
      const oldestKey = this.blobs.keys().next().value;
      if (oldestKey === undefined) return;

      const oldestBlob = this.blobs.get(oldestKey);
      this.blobs.delete(oldestKey);
      if (oldestBlob) this.cachedBytes -= oldestBlob.size;
      this.evictions += 1;
    }
  }
}

type PendingBlobLoad = { promise: Promise<Blob> | null; valid: boolean };
