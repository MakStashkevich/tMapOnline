import assert from 'node:assert/strict';
import test from 'node:test';

import { MapTileBitmapCache } from '../../tmaponline/web/src/map/map-tile-bitmap-cache.ts';

function makeBitmap() {
  return {
    width: 256,
    height: 256,
    closeCount: 0,
    close() {
      this.closeCount += 1;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test('shares an in-flight tile request and reuses the decoded bitmap', async () => {
  const cache = new MapTileBitmapCache(4);
  const response = deferred();
  let loadCount = 0;
  const load = () => {
    loadCount += 1;
    return response.promise;
  };

  const firstRequest = cache.getOrLoad('world:0:1:2', load);
  const secondRequest = cache.getOrLoad('world:0:1:2', load);
  const bitmap = makeBitmap();
  response.resolve(bitmap);

  assert.equal(await firstRequest, bitmap);
  assert.equal(await secondRequest, bitmap);
  assert.equal(loadCount, 1);
  assert.equal(await cache.getOrLoad('world:0:1:2', load), bitmap);
  assert.equal(loadCount, 1);
  assert.equal(bitmap.closeCount, 0);
});

test('evicts the least recently used bitmap and closes it', async () => {
  const cache = new MapTileBitmapCache(2);
  const first = makeBitmap();
  const second = makeBitmap();
  const third = makeBitmap();

  await cache.getOrLoad('first', async () => first);
  await cache.getOrLoad('second', async () => second);
  await cache.getOrLoad('first', async () => makeBitmap());
  await cache.getOrLoad('third', async () => third);

  assert.equal(cache.size, 2);
  assert.equal(first.closeCount, 0);
  assert.equal(second.closeCount, 1);
  assert.equal(third.closeCount, 0);
  assert.equal(cache.getMetrics().bytes, 2 * 256 * 256 * 4);
  assert.equal(cache.getMetrics().evictions, 1);
});

test('does not cache a response invalidated while it was loading', async () => {
  const cache = new MapTileBitmapCache(2);
  const oldResponse = deferred();
  const newResponse = deferred();
  const oldBitmap = makeBitmap();
  const newBitmap = makeBitmap();

  const oldRequest = cache.getOrLoad('tile', () => oldResponse.promise);
  await Promise.resolve();
  cache.invalidate('tile');
  const newRequest = cache.getOrLoad('tile', () => newResponse.promise);

  oldResponse.resolve(oldBitmap);
  newResponse.resolve(newBitmap);
  await oldRequest;
  await newRequest;

  assert.equal(oldBitmap.closeCount, 1);
  assert.equal(newBitmap.closeCount, 0);
  assert.equal(await cache.getOrLoad('tile', async () => makeBitmap()), newBitmap);
});
