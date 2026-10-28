export interface MapSnapshot<TData> {
  data: TData;
  preview: Blob;
  previewVersion: number;
  baseMapRevision: number;
  savedAt: number;
}

/** Owns IndexedDB access for the cached world snapshot and overview image. */
export class MapSnapshotCache<TData> {
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly databaseName = 'terraria-world-map-cache',
    private readonly storeName = 'snapshots',
    private readonly snapshotKey = 'active',
  ) {}

  async read(): Promise<MapSnapshot<TData> | null> {
    const database = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const request = database
        .transaction(this.storeName, 'readonly')
        .objectStore(this.storeName)
        .get(this.snapshotKey);

      request.onsuccess = () => resolve((request.result as MapSnapshot<TData> | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('Could not read map cache'));
    });
  }

  async save(snapshot: MapSnapshot<TData>): Promise<void> {
    const database = await this.openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(this.storeName, 'readwrite');
      transaction.objectStore(this.storeName).put(snapshot, this.snapshotKey);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Could not save map cache'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Map cache write aborted'));
    });
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;

    this.databasePromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB is unavailable'));
        return;
      }

      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) {
          request.result.createObjectStore(this.storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open map cache'));
      request.onblocked = () => reject(new Error('Map cache upgrade is blocked by another tab'));
    });

    return this.databasePromise;
  }
}
