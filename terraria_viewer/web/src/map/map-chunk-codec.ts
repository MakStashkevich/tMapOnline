export type MapChunkSource = {
  base: string | null;
  overlays: string[];
};

/** Decodes compressed chunks and applies later snapshots as alpha-masked patches. */
export class MapChunkCodec {
  private readonly decodedChunks = new Map<string, Promise<Uint8Array>>();

  constructor(private readonly cacheLimit = 64) {}

  clear(): void {
    this.decodedChunks.clear();
  }

  getCachedChunkCount(): number {
    return this.decodedChunks.size;
  }

  async compose(source: MapChunkSource, chunkSize: number): Promise<Uint8Array> {
    const expectedLength = chunkSize * chunkSize * 4;
    const basePixels = source.base
      ? await this.decode(source.base)
      : new Uint8Array(expectedLength);
    const result =
      basePixels.length === expectedLength
        ? new Uint8Array(basePixels)
        : new Uint8Array(expectedLength);

    for (const encodedPatch of source.overlays) {
      const patchPixels = await this.decode(encodedPatch);
      if (patchPixels.length !== expectedLength) continue;

      for (let alphaOffset = 3; alphaOffset < expectedLength; alphaOffset += 4) {
        if (patchPixels[alphaOffset] === 0) continue;

        result[alphaOffset - 3] = patchPixels[alphaOffset - 3];
        result[alphaOffset - 2] = patchPixels[alphaOffset - 2];
        result[alphaOffset - 1] = patchPixels[alphaOffset - 1];
        result[alphaOffset] = patchPixels[alphaOffset];
      }
    }

    return result;
  }

  private async decode(encodedChunk: string): Promise<Uint8Array> {
    const cachedChunk = this.decodedChunks.get(encodedChunk);
    if (cachedChunk) {
      this.touch(encodedChunk, cachedChunk);
      return cachedChunk;
    }

    if (!('DecompressionStream' in window)) {
      throw new Error('This browser does not support compressed map data.');
    }

    const decodedChunk = this.decodeBytes(encodedChunk);
    this.decodedChunks.set(encodedChunk, decodedChunk);
    this.evictOldChunks();

    try {
      return await decodedChunk;
    } catch (error) {
      this.decodedChunks.delete(encodedChunk);
      throw error;
    }
  }

  private async decodeBytes(encodedChunk: string): Promise<Uint8Array> {
    const binary = atob(encodedChunk);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }

    const compressedStream = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(compressedStream).arrayBuffer());
  }

  private touch(encodedChunk: string, decodedChunk: Promise<Uint8Array>): void {
    this.decodedChunks.delete(encodedChunk);
    this.decodedChunks.set(encodedChunk, decodedChunk);
  }

  private evictOldChunks(): void {
    while (this.decodedChunks.size > this.cacheLimit) {
      const oldestKey = this.decodedChunks.keys().next().value;
      if (oldestKey === undefined) return;
      this.decodedChunks.delete(oldestKey);
    }
  }
}
