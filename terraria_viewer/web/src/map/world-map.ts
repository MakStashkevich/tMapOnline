import { activateModules } from '../core/modules';
import { renderIcons } from '../core/icons';

const modules = await activateModules('world_map');

(() => {
  const $ = (id: string): any => document.getElementById(id);
  const debugMode = modules['world_map.debug'] && /^\/world-map\/debug\/?$/.test(location.pathname);
  if (debugMode) {
    document
      .querySelector('.zoom-tools')
      .insertAdjacentHTML(
        'afterbegin',
        '<button class="tool" id="map-settings-button" type="button" aria-label="Настройки карты" title="Настройки карты"><i data-lucide="settings" class="ui-icon" aria-hidden="true"></i></button>',
      );
    document.body.insertAdjacentHTML(
      'beforeend',
      `<dialog id="map-settings" aria-labelledby="settings-title">
      <div class="settings-head"><h2 id="settings-title">Настройки карты</h2><button class="tool" id="close-settings" type="button" aria-label="Закрыть настройки"><i data-lucide="x" class="ui-icon" aria-hidden="true"></i></button></div>
      <div class="settings-body">
        <section class="scan-panel" aria-live="polite"><div class="scan-title">Сканирование мира</div><div id="scan-progress">Ожидаю данные сканера…</div><div id="scan-cache">В кэше веба: 0 участков карты</div><div class="scan-track" aria-hidden="true"><span id="scan-progress-bar"></span></div></section>
        <section class="scan-panel"><div class="scan-title">Карта игрока</div><div>Загрузите файл <code>.map</code>, скачайте текущую карту или удалите импортированное открытие. При новой загрузке открытые области объединяются; очистка удаляет только импорт, собранное модом по перемещениям остаётся.</div><div class="map-import-row"><select id="map-import-player" aria-label="Игрок для импорта, скачивания или очистки"></select><button id="map-import-button" type="button">Выбрать .map</button><input id="map-import-file" type="file" accept=".map,application/octet-stream" hidden></div><div class="map-import-row"><button class="download-player-map" id="download-player-map" type="button" hidden>Скачать текущую карту .map</button></div><div class="map-import-row"><button class="clear-imported-map" id="clear-imported-map" type="button" hidden>Очистить загруженную карту</button></div><div id="map-import-status" role="status"></div></section>
        <label class="setting-option"><input id="full-map-toggle" type="checkbox"><span><strong>Показывать всю карту</strong><small>Показывает все уже отсканированные участки мира, включая не исследованные игроками.</small></span></label>
        <label class="setting-option"><input id="map-debug-toggle" type="checkbox"><span><strong>Показывать отладочное окно</strong><small>Постоянная панель слева снизу с состоянием карты и сканера.</small></span></label>
      </div>
    </dialog><pre id="map-debug-window" aria-live="polite" hidden></pre>`,
    );
    renderIcons(document.querySelector('#map-settings'));
    renderIcons(document.querySelector('#map-settings-button'));
  }
  const colors = [
    '#56d49a',
    '#70b7ff',
    '#f1c568',
    '#d99bff',
    '#ff8e78',
    '#65d6d8',
    '#f17cbb',
    '#b8d87a',
  ];
  const MASK_SCALE = 0.25;
  const OVERVIEW_SCALE = MASK_SCALE;
  // Bump whenever overview composition or its pixel scale changes. IndexedDB
  // keeps this bitmap across reloads, so a stale preview can otherwise hide a
  // correct map assembled from the current chunks indefinitely.
  const OVERVIEW_VERSION = 6;
  let data = null,
    scale = 1,
    fitScale = 1,
    fitMode = 'explored',
    requestActive = false,
    renderKey = '';
  let exploredPercent = 0,
    pollTimer = null;
  let mapViewActive = true;
  let fullMapEnabled = false;
  let debugWindowEnabled = false;
  try {
    fullMapEnabled = localStorage.getItem('terraria-world-map-show-full') === 'true';
  } catch {}
  try {
    debugWindowEnabled =
      debugMode && localStorage.getItem('terraria-world-map-debug-window') === 'true';
  } catch {}
  let decodedChunkCache = new Map(),
    chunkOwners = new Map(),
    chunkElements = new Map(),
    pathCache = new Map(),
    explorationImageCache = new Map(),
    overviewDirtyChunks = new Set();
  let maskCanvas = null,
    maskPlayersKey = '',
    maskVersion = 0,
    routeKey = '',
    markerKey = '',
    entityRenderKey = '',
    coinRenderKey = '',
    pylonRenderKey = '',
    spawnRenderKey = '',
    toggleKey = '',
    canvasWorld = '',
    chunkSize = 64,
    chunkRenderTimer = null,
    chunkRenderRunning = false,
    chunkRenderPending = false;
  let overviewSourceCanvas = null,
    overviewSourceReady = false,
    overviewReadyKey = '',
    overviewRequestedKey = '',
    overviewBuildToken = 0,
    overviewBuildRunning = false,
    overviewBuildPending = false,
    overviewSaveTimer = null;
  let mapDbPromise = null,
    baseMapRevision = 0,
    lastSnapshotSavedAt = 0;
  const overviewCanvas = $('map-preview');
  // Diagnostics UI is created only on the dedicated debug route.
  let toggleState = {};
  try {
    toggleState = JSON.parse(localStorage.getItem('terraria-world-map-players') || '{}') || {};
  } catch {}
  const playerOptions = (player) => {
    const value = toggleState[player.id];
    return typeof value === 'object' && value !== null
      ? { explore: value.explore !== false, route: value.route === true }
      : value === undefined
        ? { explore: true, route: false }
        : { explore: value !== false, route: true };
  };
  const status = (message) => {
    $('status').textContent = message;
    $('status').hidden = !message;
  };
  const fetchWithTimeout = async (url, options = {}, timeoutMs = 20000) => {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  const worldPointAt = (anchorX, anchorY) => {
    const view = $('viewport'),
      stage = $('stage'),
      viewRect = view.getBoundingClientRect(),
      stageRect = stage.getBoundingClientRect();
    const contentLeft = stageRect.left - viewRect.left + view.scrollLeft,
      contentTop = stageRect.top - viewRect.top + view.scrollTop;
    return {
      x: (view.scrollLeft + anchorX - contentLeft) / scale,
      y: (view.scrollTop + anchorY - contentTop) / scale,
    };
  };
  const placeWorldPoint = (worldX, worldY, anchorX, anchorY) => {
    const view = $('viewport'),
      stage = $('stage'),
      viewRect = view.getBoundingClientRect(),
      stageRect = stage.getBoundingClientRect();
    const contentLeft = stageRect.left - viewRect.left + view.scrollLeft,
      contentTop = stageRect.top - viewRect.top + view.scrollTop;
    view.scrollLeft = contentLeft + worldX * scale - anchorX;
    view.scrollTop = contentTop + worldY * scale - anchorY;
  };
  const decodeChunk = async (encoded) => {
    if (decodedChunkCache.has(encoded)) {
      const value = decodedChunkCache.get(encoded);
      decodedChunkCache.delete(encoded);
      decodedChunkCache.set(encoded, value);
      return value;
    }
    if (!('DecompressionStream' in window))
      throw new Error('Браузер не поддерживает распаковку данных карты.');
    const decoded = (async () => {
      const binary = atob(encoded),
        bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    })();
    decodedChunkCache.set(encoded, decoded);
    while (decodedChunkCache.size > 64)
      decodedChunkCache.delete(decodedChunkCache.keys().next().value);
    try {
      return await decoded;
    } catch (error) {
      decodedChunkCache.delete(encoded);
      throw error;
    }
  };
  const composeChunk = async (source) => {
    const expectedLength = chunkSize * chunkSize * 4;
    let raw = source.base ? await decodeChunk(source.base) : new Uint8Array(expectedLength);
    if (raw.length !== expectedLength) raw = new Uint8Array(expectedLength);
    else raw = new Uint8Array(raw);
    for (const overlay of source.overlays) {
      const patch = await decodeChunk(overlay);
      if (patch.length !== expectedLength) continue;
      for (let pixel = 3; pixel < expectedLength; pixel += 4)
        if (patch[pixel]) {
          raw[pixel - 3] = patch[pixel - 3];
          raw[pixel - 2] = patch[pixel - 2];
          raw[pixel - 1] = patch[pixel - 1];
          raw[pixel] = patch[pixel];
        }
    }
    return raw;
  };
  const openMapCache = () => {
    if (mapDbPromise) return mapDbPromise;
    mapDbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB is unavailable'));
        return;
      }
      const request = indexedDB.open('terraria-world-map-cache', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('snapshots'))
          request.result.createObjectStore('snapshots');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open map cache'));
    });
    return mapDbPromise;
  };
  const readMapSnapshot = async () => {
    const db = await openMapCache();
    return new Promise<any>((resolve, reject) => {
      const request = db
        .transaction('snapshots', 'readonly')
        .objectStore('snapshots')
        .get('active');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Could not read map cache'));
    });
  };
  const saveMapSnapshot = async (blob) => {
    if (!data || !blob) return;
    const db = await openMapCache();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('snapshots', 'readwrite');
      transaction.objectStore('snapshots').put(
        {
          data,
          preview: blob,
          previewVersion: OVERVIEW_VERSION,
          baseMapRevision,
          savedAt: Date.now(),
        },
        'active',
      );
      transaction.oncomplete = () => {
        lastSnapshotSavedAt = Date.now();
        resolve();
      };
      transaction.onerror = () =>
        reject(transaction.error || new Error('Could not save map cache'));
    });
  };
  const queueMapSnapshotSave = () => {
    if (!data || !overviewSourceReady || !overviewSourceCanvas || !overviewSourceCanvas.toBlob)
      return;
    if (Date.now() - lastSnapshotSavedAt < 20000) return;
    clearTimeout(overviewSaveTimer);
    overviewSaveTimer = setTimeout(
      () =>
        overviewSourceCanvas.toBlob((blob) => {
          if (blob) saveMapSnapshot(blob).catch(() => {});
        }, 'image/png'),
      800,
    );
  };
  const drawOverview = () => {
    if (!overviewSourceReady || !overviewSourceCanvas) return;
    const context = overviewCanvas.getContext('2d');
    context.globalCompositeOperation = 'source-over';
    context.clearRect(0, 0, overviewCanvas.width, overviewCanvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(overviewSourceCanvas, 0, 0, overviewCanvas.width, overviewCanvas.height);
    if (!fullMapEnabled && maskCanvas) {
      context.globalCompositeOperation = 'destination-in';
      context.drawImage(maskCanvas, 0, 0, overviewCanvas.width, overviewCanvas.height);
      context.globalCompositeOperation = 'source-over';
    }
  };
  const downloadMapImage = async () => {
    const button = $('download-map'),
      buttonLabel = 'Скачать PNG';
    button.disabled = true;
    try {
      if (!data?.world || !chunkOwners.size) throw new Error('Данные карты ещё не загружены.');
      const width = Math.trunc(Number(data.world.width)),
        height = Math.trunc(Number(data.world.height));
      const output = document.createElement('canvas');
      output.width = width;
      output.height = height;
      const context = output.getContext('2d');
      if (!context) throw new Error('Браузер не смог создать изображение карты.');
      const background = [5, 9, 13, 255];
      context.fillStyle = '#05090d';
      context.fillRect(0, 0, width, height);
      const maskWidth = maskCanvas?.width || 0;
      const maskPixels =
        !fullMapEnabled && maskCanvas
          ? maskCanvas.getContext('2d').getImageData(0, 0, maskCanvas.width, maskCanvas.height).data
          : null;
      const chunks = [...chunkOwners.entries()];
      for (let start = 0; start < chunks.length; start += 64) {
        for (const [key, source] of chunks.slice(start, start + 64)) {
          if (!source) continue;
          const [cx, cy] = key.split(',').map(Number),
            rgba = await composeChunk(source);
          for (let localY = 0; localY < chunkSize; localY++) {
            const worldY = cy * chunkSize + localY;
            if (worldY >= height) break;
            for (let localX = 0; localX < chunkSize; localX++) {
              const worldX = cx * chunkSize + localX;
              if (worldX >= width) break;
              const pixel = (localY * chunkSize + localX) * 4;
              const closed =
                maskPixels && maskPixels[((worldY >> 2) * maskWidth + (worldX >> 2)) * 4 + 3] < 32;
              if (closed || rgba[pixel + 3] === 0) {
                rgba[pixel] = background[0];
                rgba[pixel + 1] = background[1];
                rgba[pixel + 2] = background[2];
                rgba[pixel + 3] = background[3];
              }
            }
          }
          const pixels = new ImageData(new Uint8ClampedArray(rgba), chunkSize, chunkSize);
          context.putImageData(pixels, cx * chunkSize, cy * chunkSize);
        }
        const percent = Math.min(
          99,
          Math.round((Math.min(chunks.length, start + 64) / chunks.length) * 100),
        );
        button.textContent = `${percent}%`;
        if (start + 64 < chunks.length) await nextFrame();
      }
      button.textContent = '100%';
      const blob = await new Promise<Blob>((resolve, reject) =>
        output.toBlob(
          (value) => (value ? resolve(value) : reject(new Error('Не удалось сформировать PNG.'))),
          'image/png',
        ),
      );
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      const worldName = String(data.world.name || 'terraria-world').replace(
        /[^\p{L}\p{N}_-]+/gu,
        '_',
      );
      link.href = url;
      link.download = `${worldName}-map.png`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      status(`Не удалось скачать карту: ${error.message}`);
    } finally {
      button.textContent = buttonLabel;
      button.disabled = false;
    }
  };
  const restoreOverview = async (blob) => {
    if (!blob || !data?.world) return false;
    try {
      const bitmap = await createImageBitmap(blob),
        width = Math.ceil(Number(data.world.width) * MASK_SCALE),
        height = Math.ceil(Number(data.world.height) * MASK_SCALE);
      if (bitmap.width !== width || bitmap.height !== height) {
        bitmap.close();
        return false;
      }
      overviewCanvas.width = Math.ceil(Number(data.world.width) * OVERVIEW_SCALE);
      overviewCanvas.height = Math.ceil(Number(data.world.height) * OVERVIEW_SCALE);
      overviewSourceCanvas = document.createElement('canvas');
      overviewSourceCanvas.width = width;
      overviewSourceCanvas.height = height;
      overviewSourceCanvas.getContext('2d').drawImage(bitmap, 0, 0);
      bitmap.close();
      overviewSourceReady = true;
      return true;
    } catch {
      return false;
    }
  };
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const overviewKey = () =>
    `${data?.world?.id}:${data?.world?.width}x${data?.world?.height}:${baseMapRevision}`;
  const buildOverview = async () => {
    if (!chunkOwners.size || !maskCanvas) return;
    if (overviewBuildRunning) {
      overviewBuildPending = true;
      return;
    }
    overviewBuildRunning = true;
    try {
      do {
        overviewBuildPending = false;
        const key = overviewKey();
        if (key === overviewReadyKey) continue;
        overviewRequestedKey = key;
        const token = ++overviewBuildToken;
        const width = maskCanvas.width,
          height = maskCanvas.height;
        const nextSource = document.createElement('canvas');
        nextSource.width = width;
        nextSource.height = height;
        const context = nextSource.getContext('2d');
        // Build into a hidden buffer. Keep the previous complete overview on
        // screen while chunks are composed, then swap it in one frame.
        if (overviewSourceReady && overviewSourceCanvas)
          context.drawImage(overviewSourceCanvas, 0, 0);
        const overviewChunkSize = Math.max(1, Math.round(chunkSize * OVERVIEW_SCALE));
        const downsampleFactor = Math.max(1, Math.round(chunkSize / overviewChunkSize));
        const dirtyKeys = overviewSourceReady ? [...overviewDirtyChunks] : [...chunkOwners.keys()];
        overviewDirtyChunks.clear();
        const entries = dirtyKeys.map((chunkKey) => [chunkKey, chunkOwners.get(chunkKey) || null]);
        let cancelled = false;
        for (let start = 0; start < entries.length; start += 128) {
          if (token !== overviewBuildToken) {
            cancelled = true;
            break;
          }
          const batch = entries.slice(start, start + 128);
          const decoded = await Promise.all(
            batch.map(([, source]) => (source ? composeChunk(source) : null)),
          );
          if (token !== overviewBuildToken) {
            cancelled = true;
            break;
          }
          for (let index = 0; index < batch.length; index++) {
            const [chunkKey, source] = batch[index],
              [cx, cy] = chunkKey.split(',').map(Number),
              raw = decoded[index];
            const x = Math.round(cx * chunkSize * OVERVIEW_SCALE),
              y = Math.round(cy * chunkSize * OVERVIEW_SCALE);
            if (!source) {
              context.clearRect(x, y, overviewChunkSize, overviewChunkSize);
              continue;
            }
            // Use identical area averaging across browsers to avoid block seams.
            const reduced = new Uint8ClampedArray(overviewChunkSize * overviewChunkSize * 4);
            for (let oy = 0; oy < overviewChunkSize; oy++)
              for (let ox = 0; ox < overviewChunkSize; ox++) {
                let red = 0,
                  green = 0,
                  blue = 0,
                  alpha = 0;
                for (let dy = 0; dy < downsampleFactor; dy++)
                  for (let dx = 0; dx < downsampleFactor; dx++) {
                    const sourceIndex =
                        ((oy * downsampleFactor + dy) * chunkSize + ox * downsampleFactor + dx) * 4,
                      a = raw[sourceIndex + 3];
                    red += raw[sourceIndex] * a;
                    green += raw[sourceIndex + 1] * a;
                    blue += raw[sourceIndex + 2] * a;
                    alpha += a;
                  }
                const targetIndex = (oy * overviewChunkSize + ox) * 4;
                if (alpha) {
                  reduced[targetIndex] = red / alpha;
                  reduced[targetIndex + 1] = green / alpha;
                  reduced[targetIndex + 2] = blue / alpha;
                }
                reduced[targetIndex + 3] = alpha / (downsampleFactor * downsampleFactor);
              }
            context.putImageData(
              new ImageData(reduced, overviewChunkSize, overviewChunkSize),
              x,
              y,
            );
          }
          if (start + 128 < entries.length) await nextFrame();
        }
        if (cancelled) {
          overviewRequestedKey = '';
          overviewBuildPending = true;
          continue;
        }
        overviewSourceCanvas = nextSource;
        overviewSourceReady = true;
        overviewReadyKey = key;
        overviewRequestedKey = '';
        drawOverview();
        if (overviewKey() !== key || overviewDirtyChunks.size) overviewBuildPending = true;
        else {
          queueMapSnapshotSave();
          requestVisibleChunkRender();
        }
      } while (overviewBuildPending);
    } finally {
      overviewBuildRunning = false;
      if (overviewKey() !== overviewReadyKey || overviewDirtyChunks.size)
        buildOverview().catch((error) =>
          status(`Не удалось подготовить обзор карты: ${error.message}`),
        );
    }
  };
  const getPath = (player) => {
    const source = Array.isArray(player.positions) ? player.positions : [];
    const points = source
      .map((p) => ({
        x: Number(p.x),
        y: Number(p.y),
        time: Number(p.time),
        teleport: p.teleport === true,
      }))
      .filter(
        (p) =>
          Number.isFinite(p.x) &&
          Number.isFinite(p.y) &&
          p.x >= 0 &&
          p.y >= 0 &&
          p.x < data.world.width &&
          p.y < data.world.height,
      );
    if (!points.length) return { routeTracks: [], exploreTracks: [] };
    const routeTracks = [points];
    const exploreTracks = [];
    let previous = points[0],
      track = [previous],
      teleportArrival = null;
    for (const point of points.slice(1)) {
      const elapsed = point.time - previous.time;
      const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
      // Preserve a straight route line through teleports, but don't reveal the
      // map along the jump. The speed fallback also classifies old history and
      // server-side position syncs that bypass Player.Teleport.
      const worldScaleJump = distance > Math.max(1000, data.world.width * 0.35);
      const suddenJump = distance >= 250 && elapsed <= 15 && distance / Math.max(elapsed, 1) >= 45;
      const teleport = point.teleport === true || worldScaleJump || suddenJump;
      point.teleport = teleport;
      if (teleport || elapsed <= 0) {
        if (track.length) exploreTracks.push(track);
        track = [];
        teleportArrival = point;
      } else {
        if (!track.length) track = teleportArrival ? [teleportArrival, point] : [previous, point];
        else track.push(point);
        teleportArrival = null;
      }
      previous = point;
    }
    if (track.length) exploreTracks.push(track);
    return { routeTracks, exploreTracks };
  };
  const playersWithPaths = () =>
    (data?.players || []).map((player) => {
      const positions = Array.isArray(player.positions) ? player.positions : [],
        last = positions.at(-1);
      const pathKey = `${positions.length}:${last?.time}:${last?.x}:${last?.y}`;
      const cached = pathCache.get(player.id);
      if (cached?.key === pathKey)
        return {
          ...player,
          routeTracks: cached.routeTracks,
          exploreTracks: cached.exploreTracks,
          pathKey,
        };
      const paths = getPath(player);
      pathCache.set(player.id, { key: pathKey, ...paths });
      return { ...player, ...paths, pathKey };
    });
  const setScale = (next, anchorX = null, anchorY = null) => {
    if (!data) return;
    const worldPoint = anchorX == null ? null : worldPointAt(anchorX, anchorY);
    scale = Math.max(fitScale, Math.min(16, next));
    const width = Math.max(1, Math.round(data.world.width * scale)),
      height = Math.max(1, Math.round(data.world.height * scale));
    $('stage').style.width = `${width}px`;
    $('stage').style.height = `${height}px`;
    const paths = $('paths');
    paths.setAttribute('viewBox', `0 0 ${data.world.width} ${data.world.height}`);
    paths.style.width = `${width}px`;
    paths.style.height = `${height}px`;
    $('stage').classList.toggle('pixelated', scale >= 1);
    layoutVisibleChunks();
    $('zoom-level').textContent = `${Math.round((scale / fitScale) * 100)}%`;
    if (worldPoint) placeWorldPoint(worldPoint.x, worldPoint.y, anchorX, anchorY);
    requestVisibleChunkRender();
  };
  const worldFitScale = () => {
    if (!data) return;
    const view = $('viewport');
    return Math.max(
      0.01,
      Math.min(
        (view.clientWidth - 24) / data.world.width,
        (view.clientHeight - 24) / data.world.height,
        1,
      ),
    );
  };
  const centerOn = (worldX, worldY) =>
    placeWorldPoint(worldX, worldY, $('viewport').clientWidth / 2, $('viewport').clientHeight / 2);
  const fitMap = () => {
    if (!data) return;
    fitMode = 'world';
    fitScale = worldFitScale();
    setScale(fitScale);
    centerOn(data.world.width / 2, data.world.height / 2);
    if (data) redrawVisiblePaths();
  };
  const focusMap = () => {
    if (!data) return;
    fitMode = 'explored';
    fitScale = worldFitScale();
    const chunkSize = Number(data.chunk_size || 64),
      chunks = (data.players || []).flatMap((player) => player.chunks || []);
    if (!chunks.length) {
      fitMap();
      return;
    }
    const minX = Math.min(...chunks.map((chunk) => Number(chunk.x) * chunkSize)),
      maxX = Math.max(...chunks.map((chunk) => (Number(chunk.x) + 1) * chunkSize));
    const minY = Math.min(...chunks.map((chunk) => Number(chunk.y) * chunkSize)),
      maxY = Math.max(...chunks.map((chunk) => (Number(chunk.y) + 1) * chunkSize));
    const padding = Math.max(24, chunkSize / 2),
      width = maxX - minX + padding * 2,
      height = maxY - minY + padding * 2,
      view = $('viewport');
    const focusedScale = Math.min(
      16,
      (view.clientWidth - 48) / width,
      (view.clientHeight - 48) / height,
    );
    setScale(Math.max(fitScale, focusedScale));
    centerOn((minX + maxX) / 2, (minY + maxY) / 2);
    redrawVisiblePaths();
  };
  const markerPosition = (player) => {
    const position = player.position || player.positions?.at(-1);
    if (!position) return null;
    const x = Number(position.tileX ?? position.x),
      y = Number(position.tileY ?? position.y);
    return Number.isFinite(x) &&
      Number.isFinite(y) &&
      x >= 0 &&
      y >= 0 &&
      x < data.world.width &&
      y < data.world.height
      ? { x, y }
      : null;
  };
  const makeAvatar = (player, className) => {
    if (player.avatar_url) {
      const img = document.createElement('img');
      img.src = player.avatar_url;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => {
        const fallback = document.createElement('span');
        fallback.className = 'avatar-fallback';
        fallback.textContent = (player.name || '?').slice(0, 1).toUpperCase();
        img.replaceWith(fallback);
      };
      return img;
    }
    const fallback = document.createElement('span');
    fallback.className = 'avatar-fallback';
    fallback.textContent = (player.name || '?').slice(0, 1).toUpperCase();
    return fallback;
  };
  const drawMarkers = (players) => {
    const layer = $('markers');
    layer.replaceChildren();
    for (const player of players) {
      const point = markerPosition(player);
      if (!point) continue;
      const marker = document.createElement('div');
      marker.className = 'marker';
      marker.style.left = `${(point.x / data.world.width) * 100}%`;
      marker.style.top = `${(point.y / data.world.height) * 100}%`;
      marker.append(makeAvatar(player, 'marker-avatar'));
      const name = document.createElement('span');
      name.className = 'marker-name';
      name.textContent = player.name || 'Игрок';
      marker.append(name);
      layer.append(marker);
    }
  };
  const drawEntities = (entities) => {
    const layer = $('entities');
    layer.replaceChildren();
    for (const entity of entities || []) {
      const x = Number(entity.x),
        y = Number(entity.y);
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= data.world.width ||
        y >= data.world.height ||
        !entity.icon_url
      )
        continue;
      const marker = document.createElement('div');
      marker.className = `entity-marker${entity.boss ? ' boss' : ''}`;
      marker.style.left = `${((x + 0.5) / data.world.width) * 100}%`;
      marker.style.top = `${((y + 0.5) / data.world.height) * 100}%`;
      marker.title = entity.name || (entity.boss ? 'Босс' : 'NPC');
      const icon = document.createElement('img');
      icon.src = entity.icon_url;
      icon.alt = '';
      icon.draggable = false;
      icon.addEventListener('error', () => {
        if (!icon.dataset.retried) {
          icon.dataset.retried = 'true';
          icon.src = `${entity.icon_url}?retry=${Date.now()}`;
          return;
        }
        const fallback = document.createElement('span');
        fallback.className = 'entity-image-fallback';
        fallback.textContent =
          String(entity.name || (entity.boss ? 'B' : 'N'))
            .trim()
            .charAt(0)
            .toUpperCase() || 'N';
        marker.replaceChildren(fallback);
      });
      marker.append(icon);
      layer.append(marker);
    }
  };
  const drawDroppedCoins = (coins) => {
    const layer = $('coins');
    layer.replaceChildren();
    const coinClasses = { 71: 'copper', 72: 'silver', 73: 'gold', 74: 'platinum' };
    for (const coin of coins || []) {
      const x = Number(coin.x),
        y = Number(coin.y),
        stack = Math.max(0, Math.trunc(Number(coin.stack) || 0));
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        stack < 1 ||
        x < 0 ||
        y < 0 ||
        x >= data.world.width ||
        y >= data.world.height
      )
        continue;
      const name =
        coin.name ||
        {
          71: 'Медная монета',
          72: 'Серебряная монета',
          73: 'Золотая монета',
          74: 'Платиновая монета',
        }[Number(coin.type)] ||
        'Монета';
      const marker = document.createElement('div');
      marker.className = 'coin-marker';
      marker.style.left = `${((x + 0.5) / data.world.width) * 100}%`;
      marker.style.top = `${((y + 0.5) / data.world.height) * 100}%`;
      marker.title = `${name} × ${stack.toLocaleString('ru-RU')}`;
      const icon = document.createElement('img');
      icon.src = coin.icon_url || '';
      icon.alt = '';
      icon.draggable = false;
      icon.addEventListener('error', () => {
        const fallback = document.createElement('span');
        fallback.className = `coin-fallback ${coinClasses[Number(coin.type)] || 'copper'}`;
        marker.replaceChild(fallback, icon);
      });
      const amount = document.createElement('span');
      amount.className = 'coin-stack';
      amount.textContent = stack.toLocaleString('ru-RU');
      marker.append(icon, amount);
      layer.append(marker);
    }
  };
  const pylonTypes = {
    Purity: ['Пилон леса', '#8be58e', 'Forest'],
    Forest: ['Пилон леса', '#8be58e', 'Forest'],
    Jungle: ['Пилон джунглей', '#75db65', 'Jungle'],
    Hallow: ['Пилон освящения', '#f3a8fa', 'Hallow'],
    Cavern: ['Пилон пещер', '#c5b5ff', 'Cavern'],
    Underground: ['Пилон пещер', '#c5b5ff', 'Cavern'],
    Ocean: ['Пилон океана', '#71d8f0', 'Ocean'],
    Desert: ['Пилон пустыни', '#eacb78', 'Desert'],
    Snow: ['Пилон снежного биома', '#bce8ff', 'Snow'],
    Mushroom: ['Пилон грибного биома', '#83d9d6', 'Mushroom'],
    Universal: ['Универсальный пилон', '#f3eaff', 'Universal'],
    Underworld: ['Пилон преисподней', '#ff916c', 'Underworld'],
    Aether: ['Эфирный пилон', '#9cdbff', 'Aether'],
  };
  // Exact vanilla Terraria pylon map-icon sprites (white outline included), from terraria.wiki.gg/wiki/Category:Pylon_map_icons.
  const pylonSpriteData = {
    Aether:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAAXNSR0IB2cksfwAAAARnQU1BAACxjwv8YQUAAAAgY0hSTQAAeiYAAICEAAD6AAAAgOgAAHUwAADqYAAAOpgAABdwnLpRPAAAACRQTFRFAQEB////9PX58vnB3eq7/cfnserQb7T7rJPcg2rcbRyrAAAAaIMecAAAAAF0Uk5TAEDm2GYAAABnSURBVHjaldJBDcAwDAPAUSiFUgiFUCiFUQiFUhiFUQi5VYosf9xJ9ce6t31VMqsls7UUhMaEScrthUnI3AImocVZ1uyK0GJZ0N32dLPusWHcw3pEPILlAZ0Qhk4IUyQNCW73/f/GB9+8jwsyM3XxAAAAAElFTkSuQmCC',
    Cavern:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJFBMVEVHcEz////9/+v44enjteGrkcp0dLJUY59USoRINGYeEzMAAAB4bbjdAAAAAXRSTlMAQObYZgAAAGdJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVSGIVQKIVRCLlViix/3En1x7q3fVUyqyWztRSExoRJyu2FScjcAiahxVnW7IrQYlnQ3fZ0s+6xYdzDekQ8guUBnRCGTghTJA0Jbvf9/8YH5cmSwzkCf2kAAAAASUVORK5CYII=',
    Desert:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJFBMVEVHcEz/////++z/8Z//3T77twvejQexbyCHTRBxOglbIRYAAAAuj7TgAAAAAXRSTlMAQObYZgAAAGdJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVSGIVQKIVRCLlViix/3En1x7q3fVUyqyWztRSExoRJyu2FScjcAiahxVnW7IrQYlnQ3fZ0s+6xYdzDekQ8guUBnRCGTghTJA0Jbvf9/8YH5cmSwzkCf2kAAAAASUVORK5CYII=',
    Forest:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJFBMVEVHcEz////h/8a4+Zx38I5YyXQ4nWYifmwWX1ARTUgOPEsAAACxjhmaAAAAAXRSTlMAQObYZgAAAGdJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVSGIVQKIVRCLlViix/3En1x7q3fVUyqyWztRSExoRJyu2FScjcAiahxVnW7IrQYlnQ3fZ0s+6xYdzDekQ8guUBnRCGTghTJA0Jbvf9/8YH5cmSwzkCf2kAAAAASUVORK5CYII=',
    Hallow:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJ1BMVEVHcEz////9/+v93tr4pO3dY9mwT8RyYdF5QrVPOJU5KnsvFGMAAABwJysIAAAAAXRSTlMAQObYZgAAAGpJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVQGIVRCIVSGIWAWqXIyseZNH+se9tHJiKbMsYIQsgWXCypPHAREhWHi9DmSnNORmgzTagqPVVkqjf002S6+02YNugPYajhxQiXimWIsN33+xsvOfmeUcqn4vUAAAAASUVORK5CYII=',
    Jungle:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJFBMVEVHcEz////9/+v7/5bj8mGh5zRVyDUdmlgUfRISZgkOQ0gAAACTJFRUAAAAAXRSTlMAQObYZgAAAGdJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVSGIVQKIVRCLlViix/3En1x7q3fVUyqyWztRSExoRJyu2FScjcAiahxVnW7IrQYlnQ3fZ0s+6xYdzDekQ8guUBnRCGTghTJA0Jbvf9/8YH5cmSwzkCf2kAAAAASUVORK5CYII=',
    Mushroom:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJFBMVEVHcEz////P3P/Lyv+6rv+QlPhib99IUcI4OKkmJJYaGkAAAACnBs0MAAAAAXRSTlMAQObYZgAAAGdJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVSGIVQKIVRCLlViix/3En1x7q3fVUyqyWztRSExoRJyu2FScjcAiahxVnW7IrQYlnQ3fZ0s+6xYdzDekQ8guUBnRCGTghTJA0Jbvf9/8YH5cmSwzkCf2kAAAAASUVORK5CYII=',
    Ocean:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJFBMVEVHcEz////g//288P+G1v9IresljdYaY8Y3RKA/LoMyFGMAAABlpVC2AAAAAXRSTlMAQObYZgAAAGdJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVSGIVQKIVRCLlViix/3En1x7q3fVUyqyWztRSExoRJyu2FScjcAiahxVnW7IrQYlnQ3fZ0s+6xYdzDekQ8guUBnRCGTghTJA0Jbvf9/8YH5cmSwzkCf2kAAAAASUVORK5CYII=',
    Snow: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJFBMVEVHcEz////7+/vr8vTO5uuU4edgyt08nsU4Yq8ySJAZOmAAAABKR8/9AAAAAXRSTlMAQObYZgAAAGdJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVSGIVQKIVRCLlViix/3En1x7q3fVUyqyWztRSExoRJyu2FScjcAiahxVnW7IrQYlnQ3fZ0s+6xYdzDekQ8guUBnRCGTghTJA0Jbvf9/8YH5cmSwzkCf2kAAAAASUVORK5CYII=',
    Underworld:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAAXNSR0IB2cksfwAAAARnQU1BAACxjwv8YQUAAAAgY0hSTQAAeiYAAICEAAD6AAAAgOgAAHUwAADqYAAAOpgAABdwnLpRPAAAACRQTFRFAQEB////+v/r7eSU/8ds/54n82QS50uJyAkjixpDcgUbAAAAKZziKwAAAAF0Uk5TAEDm2GYAAABnSURBVHjaldJBDcAwDAPAUSiFUgiFUBiFUhiFUCiFUQi5VYosf9xJ9ce6t31VMqsls7UUhMaEScrthUnI3AImocVZ1uyK0GJZ0N32dLPusWHcw3pEPILlAZ0Qhk4IUyQNCW73/f/GB+XJksM5An9pAAAAAElFTkSuQmCC',
    Universal:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJFBMVEVHcEz//////tXx6Z7axGLUq4CagYp1ZoJaTFA7NjUrF0IAAADgpUE/AAAAAXRSTlMAQObYZgAAAGdJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVSGIVQKIVRCLlViix/3En1x7q3fVUyqyWztRSExoRJyu2FScjcAiahxVnW7IrQYlnQ3fZ0s+6xYdzDekQ8guUBnRCGTghTJA0Jbvf9/8YH5cmSwzkCf2kAAAAASUVORK5CYII=',
  };
  // Vanilla Terraria map spawn icon (22x24), from terraria.wiki.gg/wiki/Category:Minimap_icons.
  const spawnSpriteData =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAYBAMAAAAMkBB4AAAAFVBMVEUBAQH///9Z/I8u42oBpjgAYyEAAAAoKqKrAAAAAXRSTlMAQObYZgAAAE9JREFUeNp1yVEJwFAMQ9FaiIVaqIVaiIX4lzACg9K3vfuTAwknyXNaAHTaJAn9uS+ur82sJDSew9w2m01o2azMLELj93DmcgjO3A652H4AHOEsO8xMR64AAAAASUVORK5CYII=';
  const drawPylons = (pylons) => {
    const layer = $('pylons');
    layer.querySelectorAll('.pylon-marker').forEach((marker) => marker.remove());
    for (const pylon of pylons || []) {
      const x = Number(pylon.x),
        y = Number(pylon.y);
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= data.world.width ||
        y >= data.world.height
      )
        continue;
      const type = String(pylon.type || '');
      const [label, , sprite] = pylonTypes[type] || [`${type || 'Пилон'}`, '#d9e7f4', 'Forest'];
      const marker = document.createElement('div');
      marker.className = 'pylon-marker';
      marker.style.left = `${((x + 0.5) / data.world.width) * 100}%`;
      marker.style.top = `${((y + 0.5) / data.world.height) * 100}%`;
      marker.setAttribute('aria-label', label);
      const icon = document.createElement('img');
      icon.className = 'pylon-icon';
      icon.src = pylonSpriteData[sprite] || pylonSpriteData.Forest;
      icon.alt = '';
      icon.width = 28;
      icon.height = 38;
      icon.draggable = false;
      marker.append(icon);
      layer.append(marker);
    }
  };
  const drawSpawn = (world) => {
    const layer = $('pylons'),
      key = JSON.stringify([world?.spawn_x, world?.spawn_y, world?.width, world?.height]);
    if (key === spawnRenderKey) return;
    layer.querySelector('.spawn-marker')?.remove();
    spawnRenderKey = key;
    const x = Number(world?.spawn_x),
      y = Number(world?.spawn_y),
      width = Number(world?.width),
      height = Number(world?.height);
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      x < 0 ||
      y < 0 ||
      x >= width ||
      y >= height
    )
      return;
    const marker = document.createElement('div');
    marker.className = 'spawn-marker';
    marker.style.left = `${((x + 0.5) / width) * 100}%`;
    marker.style.top = `${((y + 0.5) / height) * 100}%`;
    marker.setAttribute('aria-label', 'Точка появления');
    const icon = document.createElement('img');
    icon.className = 'spawn-icon';
    icon.src = spawnSpriteData;
    icon.alt = '';
    icon.width = 22;
    icon.height = 24;
    icon.draggable = false;
    marker.append(icon);
    layer.append(marker);
  };
  let hoverTimer = null,
    hoverKey = '',
    hoverToken = 0;
  const tileInfoCache = new Map();
  const hideMapTooltip = () => {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    hoverKey = '';
    hoverToken++;
    $('map-tooltip').hidden = true;
  };
  const showMapTooltip = (event, title, description) => {
    const tooltip = $('map-tooltip');
    tooltip.querySelector('strong').textContent = title;
    tooltip.querySelector('span').textContent = description;
    tooltip.hidden = false;
    const rect = tooltip.getBoundingClientRect(),
      margin = 12;
    tooltip.style.left = `${Math.max(margin, Math.min(innerWidth - rect.width - margin, event.clientX + 14))}px`;
    tooltip.style.top = `${Math.max(margin, Math.min(innerHeight - rect.height - margin, event.clientY + 14))}px`;
  };
  const mapObjectAt = (x, y) => {
    const near = (objectX, objectY, radius) =>
      Math.abs(x - objectX) * scale <= radius && Math.abs(y - objectY) * scale <= radius;
    for (const coin of data?.coins || []) {
      const coinX = Number(coin.x) + 0.5,
        coinY = Number(coin.y) + 0.5;
      if (near(coinX, coinY, 16))
        return {
          key: `coin:${coin.id}:${coin.type}`,
          title: `${coin.name || 'Монета'} × ${Number(coin.stack || 0).toLocaleString('ru-RU')}`,
          description: `Выпала на земле · плитка ${Math.floor(coinX)}, ${Math.floor(coinY)}`,
        };
    }
    for (const entity of data?.active_npcs || []) {
      const entityX = Number(entity.x) + 0.5,
        entityY = Number(entity.y) + 0.5;
      if (near(entityX, entityY, entity.boss ? 22 : 18)) {
        return {
          key: `entity:${entity.id}`,
          title: entity.name || (entity.boss ? 'Босс' : 'NPC'),
          description: `${entity.boss ? 'Босс' : 'NPC'} · плитка ${Math.floor(entityX)}, ${Math.floor(entityY)}`,
        };
      }
    }
    for (const pylon of data?.pylons || []) {
      const type = String(pylon.type || ''),
        details = pylonTypes[type] || [`${type || 'Пилон'}`, '#d9e7f4', 'Forest'];
      if (near(Number(pylon.x) + 0.5, Number(pylon.y) + 0.5, 20))
        return {
          key: `pylon:${pylon.x},${pylon.y}`,
          title: details[0],
          description: `Пилон биома · плитка ${pylon.x}, ${pylon.y}`,
        };
    }
    for (const player of data?.players || []) {
      if (player.online !== true) continue;
      const point = markerPosition(player);
      if (point && near(point.x, point.y, 34))
        return {
          key: `player:${player.id}`,
          title: player.name || 'Игрок',
          description: `Игрок в мире · плитка ${Math.floor(point.x)}, ${Math.floor(point.y)}`,
        };
    }
    const spawnX = Number(data?.world?.spawn_x),
      spawnY = Number(data?.world?.spawn_y);
    if (Number.isFinite(spawnX) && Number.isFinite(spawnY) && near(spawnX + 0.5, spawnY + 0.5, 17))
      return {
        key: 'spawn',
        title: 'Точка появления игрока',
        description: `Место появления в мире · плитка ${spawnX}, ${spawnY}`,
      };
    return null;
  };
  const scheduleMapTooltip = (event) => {
    if (!modules['world_map.tooltips']) return;
    const stageRect = $('stage').getBoundingClientRect();
    const x = Math.floor((event.clientX - stageRect.left) / scale),
      y = Math.floor((event.clientY - stageRect.top) / scale);
    if (!data || x < 0 || y < 0 || x >= data.world.width || y >= data.world.height) {
      hideMapTooltip();
      return;
    }
    const object = mapObjectAt(x + 0.5, y + 0.5);
    const key = object?.key || `tile:${x},${y}`;
    if (key === hoverKey) return;
    clearTimeout(hoverTimer);
    hoverKey = key;
    const token = ++hoverToken;
    $('map-tooltip').hidden = true;
    const cursor = { clientX: event.clientX, clientY: event.clientY };
    hoverTimer = setTimeout(async () => {
      if (token !== hoverToken) return;
      if (object) {
        showMapTooltip(cursor, object.title, object.description);
        return;
      }
      if (!fullMapEnabled && maskCanvas) {
        const maskX = Math.floor(x * MASK_SCALE),
          maskY = Math.floor(y * MASK_SCALE);
        if (
          maskX < 0 ||
          maskY < 0 ||
          maskX >= maskCanvas.width ||
          maskY >= maskCanvas.height ||
          maskCanvas.getContext('2d').getImageData(maskX, maskY, 1, 1).data[3] < 32
        )
          return;
      }
      const cacheKey = `${data.world.id}:${data.tile_info_updated_at || 0}:${x},${y}`;
      let info = tileInfoCache.get(cacheKey);
      if (!info) {
        try {
          const query = new URLSearchParams({
            world: String(data.world.id ?? ''),
            x: String(x),
            y: String(y),
          });
          const response = await fetch(`/api/world-map/tile-info?${query}`, { cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          info = await response.json();
          tileInfoCache.set(cacheKey, info);
          if (tileInfoCache.size > 500) tileInfoCache.delete(tileInfoCache.keys().next().value);
        } catch {
          info = { x, y, unavailable: true };
        }
      }
      if (token !== hoverToken) return;
      if (info.unavailable) {
        showMapTooltip(cursor, 'Данные блока ещё не собраны', `Плитка ${x}, ${y}`);
        return;
      }
      const title = info.tile_name || (info.tile_id == null ? 'Пустой блок' : 'Неизвестный блок');
      const parts = [`Плитка ${x}, ${y}`];
      if (info.wall_name) parts.push(`Стена: ${info.wall_name}`);
      else if (info.wall_id != null) parts.push('Неизвестная стена');
      showMapTooltip(cursor, title, parts.join(' · '));
    }, 2000);
  };
  const drawPaths = (players) => {
    const layer = $('route-layer');
    layer.replaceChildren();
    players.forEach((player) => {
      const color =
        colors[(data.players || []).findIndex((item) => item.id === player.id) % colors.length];
      for (const track of player.routeTracks) {
        if (!track.length) continue;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-width', '2.5');
        if (track.length === 1) {
          path.setAttribute('d', `M ${track[0].x + 0.5} ${track[0].y + 0.5} l .01 0`);
        } else
          path.setAttribute(
            'd',
            track
              .map((point, index) => `${index ? 'L' : 'M'} ${point.x + 0.5} ${point.y + 0.5}`)
              .join(' '),
          );
        layer.append(path);
      }
    });
  };
  const redrawVisiblePaths = () => {
    if (!data) return;
    drawPaths(playersWithPaths().filter((player) => playerOptions(player).route));
  };
  const addExplorationPoints = (players, reset = false, explorationImages = new Map()) => {
    const mask = maskCanvas.getContext('2d');
    if (!reset) return false;
    mask.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    // The imported .map mask already uses quarter-scale world dimensions.
    // Draw it in canvas coordinates before scaling the context for tile-based
    // player routes; otherwise it gets scaled to one quarter a second time.
    for (const player of players) {
      const bitmap = explorationImages.get(player.id);
      if (bitmap) mask.drawImage(bitmap, 0, 0, maskCanvas.width, maskCanvas.height);
    }
    mask.save();
    mask.scale(MASK_SCALE, MASK_SCALE);
    for (const player of players)
      for (const track of player.exploreTracks) {
        if (!track.length) continue;
        mask.beginPath();
        track.forEach((point, index) =>
          index
            ? mask.lineTo(point.x + 0.5, point.y + 0.5)
            : mask.moveTo(point.x + 0.5, point.y + 0.5),
        );
        mask.lineCap = 'round';
        mask.lineJoin = 'round';
        mask.globalCompositeOperation = 'lighter';
        for (const [width, alpha] of [
          [40, 0.08],
          [32, 0.15],
          [24, 0.32],
          [16, 0.62],
          [8, 1],
        ]) {
          mask.strokeStyle = `rgba(255,255,255,${alpha})`;
          mask.lineWidth = width;
          mask.stroke();
        }
      }
    mask.restore();
    const pixels = mask.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
    let open = 0;
    for (let alpha = 3; alpha < pixels.length; alpha += 4) if (pixels[alpha] >= 32) open++;
    exploredPercent = (open / (maskCanvas.width * maskCanvas.height)) * 100;
    return true;
  };
  const getExplorationBitmap = async (url) => {
    if (!url) return null;
    if (!explorationImageCache.has(url)) {
      const promise = fetchWithTimeout(url, { cache: 'force-cache' }, 10000)
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.blob();
        })
        .then((blob) => createImageBitmap(blob));
      explorationImageCache.set(url, promise);
      while (explorationImageCache.size > 16) {
        const [oldUrl, oldPromise] = explorationImageCache.entries().next().value;
        explorationImageCache.delete(oldUrl);
        oldPromise.then((bitmap) => bitmap.close()).catch(() => {});
      }
    }
    try {
      return await explorationImageCache.get(url);
    } catch {
      explorationImageCache.delete(url);
      return null;
    }
  };
  const renderToggles = () => {
    const signature = JSON.stringify(
      (data.players || []).map((player, index) => [
        player.id,
        player.name,
        player.avatar_url,
        playerOptions(player),
        index,
      ]),
    );
    if (signature === toggleKey) return;
    toggleKey = signature;
    const buildNav = (nav) => {
      nav.replaceChildren();
      const label = document.createElement('span');
      label.className = 'players-label';
      label.textContent = 'Игроки:';
      nav.append(label);
      for (const [index, player] of (data.players || []).entries()) {
        const options = playerOptions(player),
          color = colors[index % colors.length],
          control = document.createElement('span');
        control.className = 'player-control';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'player-toggle';
        button.setAttribute('aria-pressed', String(options.explore));
        button.setAttribute(
          'aria-label',
          `${options.explore ? 'Скрыть' : 'Показать'} исследованную область игрока ${player.name || 'Игрок'}`,
        );
        button.title = 'Показать или скрыть исследованную область';
        button.append(makeAvatar(player, 'toggle-avatar'));
        const name = document.createElement('span');
        name.textContent = player.name || 'Игрок';
        button.append(name);
        const dot = document.createElement('i');
        dot.style.cssText = `width:9px;height:9px;border-radius:50%;background:${color}`;
        button.insertBefore(dot, name);
        button.addEventListener('click', () => {
          toggleState[player.id] = { ...playerOptions(player), explore: !options.explore };
          saveOptions();
          render();
        });
        const route = document.createElement('button');
        route.type = 'button';
        route.className = 'route-toggle';
        route.setAttribute('aria-pressed', String(options.route));
        route.setAttribute(
          'aria-label',
          `${options.route ? 'Скрыть' : 'Показать'} полосу пути игрока ${player.name || 'Игрок'}`,
        );
        route.title = 'Показать или скрыть цветную полосу пути';
        route.style.setProperty('--route-color', color);
        const line = document.createElement('i');
        line.className = 'route-sample';
        route.append(line);
        route.addEventListener('click', () => {
          toggleState[player.id] = { ...playerOptions(player), route: !options.route };
          saveOptions();
          render();
        });
        control.append(button, route);
        nav.append(control);
      }
      if (!(data.players || []).length) {
        const empty = document.createElement('span');
        empty.className = 'players-label';
        empty.textContent = 'Игроков пока нет';
        nav.append(empty);
      }
    };
    buildNav($('players'));
    buildNav($('drawer-players'));
  };
  const saveOptions = () => {
    try {
      localStorage.setItem('terraria-world-map-players', JSON.stringify(toggleState));
    } catch {}
  };
  const updateMapImportOptions = () => {
    const select = $('map-import-player');
    if (!select) return;
    const updateActions = () => {
      const player = (data?.players || []).find((item) => item.id === select.value);
      $('clear-imported-map').hidden = !player?.has_imported_map;
      $('download-player-map').hidden = !player?.can_export_map;
    };
    const players = data?.players || [],
      selected = select.value;
    const signature = JSON.stringify(players.map((player) => [player.id, player.name]));
    if (select.dataset.signature === signature) {
      updateActions();
      return;
    }
    select.dataset.signature = signature;
    select.replaceChildren();
    for (const player of players) {
      const option = document.createElement('option');
      option.value = player.id;
      option.textContent = player.name || player.id;
      select.append(option);
    }
    if (players.some((player) => player.id === selected)) select.value = selected;
    else {
      const toha = players.find(
        (player) => String(player.name || '').toLocaleLowerCase('ru-RU') === 'toha',
      );
      if (toha) select.value = toha.id;
    }
    updateActions();
  };
  const layoutVisibleChunks = () => {
    for (const [key, canvas] of chunkElements) {
      const [cx, cy] = key.split(',').map(Number);
      canvas.style.left = `${cx * chunkSize * scale}px`;
      canvas.style.top = `${cy * chunkSize * scale}px`;
      canvas.style.width = `${chunkSize * scale}px`;
      canvas.style.height = `${chunkSize * scale}px`;
    }
  };
  const renderVisibleChunks = async () => {
    if (!data || !maskCanvas) return;
    drawOverview();
    if (scale < fitScale * 4) {
      for (const canvas of chunkElements.values()) canvas.remove();
      chunkElements.clear();
      return;
    }
    const view = $('viewport'),
      stage = $('stage'),
      viewRect = view.getBoundingClientRect(),
      stageRect = stage.getBoundingClientRect();
    const contentLeft = stageRect.left - viewRect.left + view.scrollLeft,
      contentTop = stageRect.top - viewRect.top + view.scrollTop;
    const left = Math.max(0, (view.scrollLeft - contentLeft) / scale - chunkSize),
      top = Math.max(0, (view.scrollTop - contentTop) / scale - chunkSize);
    const right = Math.min(
        data.world.width,
        (view.scrollLeft + view.clientWidth - contentLeft) / scale + chunkSize,
      ),
      bottom = Math.min(
        data.world.height,
        (view.scrollTop + view.clientHeight - contentTop) / scale + chunkSize,
      );
    const visible = new Map();
    for (const [key, source] of chunkOwners) {
      const [cx, cy] = key.split(',').map(Number),
        x = cx * chunkSize,
        y = cy * chunkSize;
      if (x + chunkSize > left && x < right && y + chunkSize > top && y < bottom)
        visible.set(key, source);
    }
    for (const [key, canvas] of chunkElements)
      if (!visible.has(key)) {
        canvas.remove();
        chunkElements.delete(key);
      }
    await Promise.all(
      [...visible].map(async ([key, source]) => {
        const encoded = JSON.stringify([source.base, source.overlays]);
        const previous = chunkElements.get(key),
          replace = !previous || previous.dataset.encoded !== encoded;
        const canvas = replace ? document.createElement('canvas') : previous;
        if (replace) {
          canvas.className = 'map-chunk';
          canvas.width = chunkSize;
          canvas.height = chunkSize;
          canvas.dataset.encoded = encoded;
          canvas.dataset.maskVersion = '';
        }
        const maskToken = fullMapEnabled ? 'full-map' : `explored-${maskVersion}`;
        if (canvas.dataset.maskVersion !== maskToken) {
          const raw = await composeChunk(source);
          const context = canvas.getContext('2d');
          context.putImageData(
            new ImageData(new Uint8ClampedArray(raw), chunkSize, chunkSize),
            0,
            0,
          );
          if (!fullMapEnabled) {
            const [cx, cy] = key.split(',').map(Number);
            context.save();
            context.globalCompositeOperation = 'destination-in';
            context.drawImage(
              maskCanvas,
              cx * chunkSize * MASK_SCALE,
              cy * chunkSize * MASK_SCALE,
              chunkSize * MASK_SCALE,
              chunkSize * MASK_SCALE,
              0,
              0,
              chunkSize,
              chunkSize,
            );
            context.restore();
          }
          canvas.dataset.maskVersion = maskToken;
        }
        const [cx, cy] = key.split(',').map(Number);
        canvas.style.left = `${cx * chunkSize * scale}px`;
        canvas.style.top = `${cy * chunkSize * scale}px`;
        canvas.style.width = `${chunkSize * scale}px`;
        canvas.style.height = `${chunkSize * scale}px`;
        if (replace) {
          $('chunk-layer').append(canvas);
          chunkElements.set(key, canvas);
          previous?.remove();
        }
      }),
    );
  };
  const requestVisibleChunkRender = () => {
    clearTimeout(chunkRenderTimer);
    chunkRenderTimer = setTimeout(async () => {
      if (chunkRenderRunning) {
        chunkRenderPending = true;
        return;
      }
      chunkRenderRunning = true;
      do {
        chunkRenderPending = false;
        try {
          await renderVisibleChunks();
        } catch (error) {
          status(`Не удалось отрисовать карту: ${error.message}`);
        }
      } while (chunkRenderPending);
      chunkRenderRunning = false;
    }, 45);
  };
  const updateChunkOwners = (width, height, size, players) => {
    const worldKey = `${data.world?.id}:${width}x${height}`;
    if (canvasWorld !== worldKey) {
      for (const canvas of chunkElements.values()) canvas.remove();
      chunkElements.clear();
      decodedChunkCache.clear();
      pathCache.clear();
      overviewDirtyChunks.clear();
      maskPlayersKey = '';
      routeKey = '';
      markerKey = '';
      pylonRenderKey = '';
      spawnRenderKey = '';
      canvasWorld = worldKey;
      maskCanvas = document.createElement('canvas');
      maskCanvas.width = Math.ceil(width * MASK_SCALE);
      maskCanvas.height = Math.ceil(height * MASK_SCALE);
      maskVersion++;
      overviewBuildToken++;
      overviewReadyKey = '';
      overviewRequestedKey = '';
      overviewSourceReady = false;
      overviewCanvas.width = Math.ceil(width * OVERVIEW_SCALE);
      overviewCanvas.height = Math.ceil(height * OVERVIEW_SCALE);
    }
    chunkSize = size;
    const previousOwners = chunkOwners,
      nextOwners = new Map();
    for (const chunk of data.base_chunks || []) {
      const x = Number(chunk.x),
        y = Number(chunk.y);
      if (Number.isInteger(x) && Number.isInteger(y))
        nextOwners.set(`${x},${y}`, { base: chunk.data, overlays: [] });
    }
    for (const player of players)
      for (const chunk of player.chunks || []) {
        const x = Number(chunk.x),
          y = Number(chunk.y);
        if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
        const key = `${x},${y}`,
          owner = nextOwners.get(key) || { base: null, overlays: [] };
        owner.overlays.push(chunk.data);
        nextOwners.set(key, owner);
      }
    let changed = false;
    for (const key of new Set([...previousOwners.keys(), ...nextOwners.keys()])) {
      const before = previousOwners.get(key),
        after = nextOwners.get(key);
      const same =
        before === after ||
        (before &&
          after &&
          before.base === after.base &&
          before.overlays.length === after.overlays.length &&
          before.overlays.every((value, index) => value === after.overlays[index]));
      if (!same) {
        overviewDirtyChunks.add(key);
        changed = true;
      }
    }
    chunkOwners = nextOwners;
    if (changed) {
      baseMapRevision++;
      overviewBuildPending = true;
    }
  };
  const render = async () => {
    const width = Number(data.world?.width),
      height = Number(data.world?.height),
      size = Number(data.chunk_size || 64);
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 12000 ||
      height > 6000
    )
      throw new Error('Размер мира некорректен.');
    updateChunkOwners(width, height, size, data.players || []);
    const players = playersWithPaths(),
      explored = modules['world_map.exploration']
        ? players.filter((player) => playerOptions(player).explore)
        : [],
      routed = modules['world_map.routes']
        ? players.filter((player) => playerOptions(player).route)
        : [];
    const explorationImages = new Map();
    await Promise.all(
      explored
        .filter((player) => player.exploration_url)
        .map(async (player) => {
          const bitmap = await getExplorationBitmap(player.exploration_url);
          if (bitmap) explorationImages.set(player.id, bitmap);
        }),
    );
    const nextMaskPlayersKey = JSON.stringify(
      explored.map((player) => [player.id, player.pathKey, player.exploration_url]),
    );
    const rebuildMask = nextMaskPlayersKey !== maskPlayersKey;
    const maskChanged = addExplorationPoints(explored, rebuildMask, explorationImages);
    if (rebuildMask) maskPlayersKey = nextMaskPlayersKey;
    if (maskChanged) maskVersion++;
    drawOverview();
    buildOverview().catch((error) =>
      status(`Не удалось подготовить обзор карты: ${error.message}`),
    );
    const nextRouteKey = JSON.stringify(routed.map((player) => [player.id, player.pathKey]));
    if (nextRouteKey !== routeKey) {
      drawPaths(routed);
      routeKey = nextRouteKey;
    }
    const markerPlayers = modules['world_map.players']
      ? players.filter((player) => player.online === true)
      : [];
    const nextMarkerKey = JSON.stringify(
      markerPlayers.map((player) => [
        player.id,
        player.name,
        player.avatar_url,
        player.online,
        player.position?.tileX,
        player.position?.tileY,
        player.position?.x,
        player.position?.y,
      ]),
    );
    if (nextMarkerKey !== markerKey) {
      drawMarkers(markerPlayers);
      markerKey = nextMarkerKey;
    }
    const pylonKey = modules['world_map.pylons'] ? JSON.stringify(data.pylons || []) : 'off';
    if (pylonKey !== pylonRenderKey) {
      drawPylons(modules['world_map.pylons'] ? data.pylons : []);
      pylonRenderKey = pylonKey;
    }
    const entityKey = modules['world_map.entities']
      ? JSON.stringify(data.active_npcs || [])
      : 'off';
    if (entityKey !== entityRenderKey) {
      drawEntities(modules['world_map.entities'] ? data.active_npcs : []);
      entityRenderKey = entityKey;
    }
    const coinKey = modules['world_map.coins'] ? JSON.stringify(data.coins || []) : 'off';
    if (coinKey !== coinRenderKey) {
      drawDroppedCoins(modules['world_map.coins'] ? data.coins : []);
      coinRenderKey = coinKey;
    }
    if (modules['world_map.spawn']) drawSpawn(data.world);
    else $('pylons').querySelector('.spawn-marker')?.remove();
    $('title').textContent = data.world?.name
      ? `Карта мира · ${data.world.name}`
      : 'Карта исследования';
    $('subtitle').textContent =
      `${width.toLocaleString('ru-RU')} × ${height.toLocaleString('ru-RU')} тайлов · изучено ${Math.round(exploredPercent)}% карты`;
    renderToggles();
    updateMapImportOptions();
    const hasMap =
      (data.base_chunks?.length || 0) > 0 ||
      explored.some((player) => player.chunks?.length || player.exploration_url);
    status(
      hasMap
        ? ''
        : 'Карта станет видна, когда появятся данные карты и обычных перемещений игроков.',
    );
    queueMapSnapshotSave();
    requestVisibleChunkRender();
  };
  const refresh = async (initial) => {
    if (requestActive) return;
    requestActive = true;
    try {
      const query = new URLSearchParams(location.search).get('world');
      const params = new URLSearchParams();
      if (query) params.set('world', query);
      if (data?.updated_at) params.set('since', String(data.updated_at));
      const response = await fetchWithTimeout(
        `/api/world-map${params.size ? `?${params}` : ''}`,
        { cache: 'no-store' },
        30000,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = await response.json();
      const sameWorld =
        data &&
        String(data.world?.id) === String(next.world?.id) &&
        data.world?.name === next.world?.name;
      if (sameWorld) {
        const cached = new Map<string, any>(
          (data.base_chunks || []).map((chunk) => [`${chunk.x},${chunk.y}`, chunk]),
        );
        for (const chunk of next.base_chunks || []) {
          const chunkKey = `${chunk.x},${chunk.y}`;
          cached.set(chunkKey, chunk);
        }
        next.base_chunks = [...cached.values()];
        const previousPlayers = new Map<string, any>(
          (data.players || []).map((player) => [player.id, player]),
        );
        next.players = (next.players || []).map((player) => {
          const oldChunks = new Map<string, any>(
            (previousPlayers.get(player.id)?.chunks || []).map((chunk) => [
              `${chunk.x},${chunk.y}`,
              chunk,
            ]),
          );
          for (const chunk of player.chunks || []) oldChunks.set(`${chunk.x},${chunk.y}`, chunk);
          return { ...player, chunks: [...oldChunks.values()] };
        });
      }
      const key = JSON.stringify([
        next.updated_at,
        next.tile_info_updated_at,
        next.base_chunks?.length,
        next.scan?.scannedChunks,
        next.scan?.attemptedChunks,
        next.scan?.failedChunks,
        next.scan?.complete,
        next.active_npcs,
        next.coins,
        (next.players || []).map((p) => [
          p.id,
          p.position?.tileX,
          p.position?.tileY,
          p.positions?.length,
          p.chunks?.length,
          p.exploration_url,
        ]),
      ]);
      if (!initial && key === renderKey) return;
      const oldScale = scale,
        oldLeft = $('viewport').scrollLeft,
        oldTop = $('viewport').scrollTop;
      data = next;
      await render();
      if (initial || !renderKey) focusMap();
      else {
        setScale(oldScale);
        $('viewport').scrollLeft = oldLeft;
        $('viewport').scrollTop = oldTop;
      }
      renderKey = key;
      renderScanStatus();
    } catch (error) {
      status(`Не удалось загрузить карту: ${error.message}`);
    } finally {
      requestActive = false;
    }
  };
  function renderScanStatus() {
    if (!debugMode) return;
    const scan = data?.scan;
    if (!scan || !scan.totalChunks) {
      $('scan-progress').textContent = 'Сканер пока не передал состояние.';
      $('scan-progress-bar').style.width = '0%';
    } else {
      const scanned = Number(scan.scannedChunks || 0),
        total = Number(scan.totalChunks || 0),
        remaining = Number(scan.remainingChunks || 0),
        percent = Math.max(0, Math.min(100, Number(scan.percent || 0)));
      const state = scan.stale
        ? 'Нет свежей телеметрии от сервера'
        : scan.complete
          ? 'Сканирование завершено'
          : scan.active
            ? 'Сканирование идёт'
            : 'Сканирование приостановлено';
      $('scan-progress').textContent =
        `${state}: ${scanned.toLocaleString('ru-RU')} из ${total.toLocaleString('ru-RU')} участков (${percent}%). Осталось ${remaining.toLocaleString('ru-RU')}.`;
      if (scan.stale && Number.isFinite(Number(scan.telemetryAgeSeconds)))
        $('scan-progress').textContent +=
          ` Последний снимок ${Number(scan.telemetryAgeSeconds).toLocaleString('ru-RU')} сек. назад.`;
      if (Number(scan.failedChunks || 0) > 0)
        $('scan-progress').textContent +=
          ` Ошибок: ${Number(scan.failedChunks).toLocaleString('ru-RU')}.`;
      $('scan-progress-bar').style.width = `${percent}%`;
    }
    $('scan-cache').textContent =
      `В кэше веба: ${(data?.base_chunks || []).length.toLocaleString('ru-RU')} участков карты`;
    $('full-map-toggle').checked = fullMapEnabled;
    $('map-debug-toggle').checked = debugWindowEnabled;
    renderDebugWindow();
  }
  async function restoreCachedMap() {
    try {
      const cached = await readMapSnapshot();
      if (!cached?.data || data) return;
      const requested = new URLSearchParams(location.search).get('world');
      if (
        requested &&
        ![String(cached.data.world?.id || ''), String(cached.data.world?.name || '')].includes(
          requested,
        )
      )
        return;
      data = cached.data;
      baseMapRevision = Number(cached.baseMapRevision || 0);
      await render();
      overviewBuildToken++;
      overviewRequestedKey = '';
      overviewReadyKey = '';
      overviewSourceReady = false;
      overviewSourceCanvas = null;
      if (cached.previewVersion === OVERVIEW_VERSION && (await restoreOverview(cached.preview))) {
        overviewReadyKey = overviewKey();
        drawOverview();
      } else buildOverview().catch(() => {});
      render();
      focusMap();
      renderScanStatus();
      renderKey = '';
    } catch {}
  }
  function renderDebugWindow() {
    const panel = $('map-debug-window');
    if (!panel) return;
    panel.hidden = !debugWindowEnabled;
    if (panel.hidden) return;
    const world = data?.world || {},
      scan = data?.scan || {},
      players = data?.players || [];
    const mapWidth = Number(world.width || scan.width || 0),
      mapHeight = Number(world.height || scan.height || 0);
    const activePlayers = players.filter(
      (player) => player.position && player.position.tileX != null && player.position.tileY != null,
    );
    const lines = [
      'ОТЛАДКА КАРТЫ',
      `Мир: ${world.name || scan.worldName || '—'} · ID ${world.id ?? scan.worldId ?? '—'}`,
      `Размер: ${mapWidth.toLocaleString('ru-RU')} × ${mapHeight.toLocaleString('ru-RU')} тайлов`,
      `Исследовано игроками: ${exploredPercent.toFixed(2)}%`,
      `Сканер: ${!data?.scan ? 'нет данных' : scan.complete ? 'завершён' : scan.active ? 'работает' : scan.stale ? 'нет связи / данные устарели' : 'приостановлен'}`,
      `Участки: ${Number(scan.scannedChunks || 0).toLocaleString('ru-RU')} отсканировано · ${Number(scan.attemptedChunks || 0).toLocaleString('ru-RU')} обработано · ${Number(scan.remainingChunks || 0).toLocaleString('ru-RU')} осталось`,
      `Ошибки сканирования: ${Number(scan.failedChunks || 0).toLocaleString('ru-RU')} · всего: ${Number(scan.totalChunks || 0).toLocaleString('ru-RU')}`,
      `Кэш браузера: ${(data?.base_chunks || []).length.toLocaleString('ru-RU')} участков · режим всей карты: ${fullMapEnabled ? 'вкл' : 'выкл'}`,
      `Игроки с координатами: ${activePlayers.length}/${players.length}`,
      ...players.map(
        (player) =>
          `  ${player.name || player.id}: ${player.position?.tileX ?? '—'}, ${player.position?.tileY ?? '—'} · позиции ${player.positions?.length || 0} · участки ${player.chunks?.length || 0}`,
      ),
    ];
    panel.textContent = lines.join('\n');
  }
  async function readImportedMapIdentity(file) {
    const bytes = new Uint8Array(await file.slice(0, 8192).arrayBuffer()),
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 32 || new TextDecoder().decode(bytes.subarray(4, 12)) !== 'relogic\x01')
      throw new Error('Это не файл карты Terraria.');
    let offset = 24,
      nameLength = 0,
      shift = 0;
    for (;;) {
      if (offset >= bytes.length || shift > 28) throw new Error('Поврежден заголовок файла карты.');
      const byte = bytes[offset++];
      nameLength |= (byte & 127) << shift;
      if (!(byte & 128)) break;
      shift += 7;
    }
    if (nameLength < 1 || offset + nameLength + 12 > bytes.length)
      throw new Error('В файле карты нет данных о мире.');
    const name = new TextDecoder().decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    return {
      name,
      id: view.getUint32(offset, true),
      height: view.getUint32(offset + 4, true),
      width: view.getUint32(offset + 8, true),
    };
  }
  function scheduleRefresh() {
    clearTimeout(pollTimer);
    if (!mapViewActive) return;
    pollTimer = setTimeout(
      async () => {
        await refresh(false);
        scheduleRefresh();
      },
      debugMode && $('map-settings').open ? 1000 : 5000,
    );
  }
  if (debugMode) {
    $('map-settings-button').addEventListener('click', () => {
      renderScanStatus();
      $('map-settings').showModal();
      scheduleRefresh();
    });
    $('close-settings').addEventListener('click', () => $('map-settings').close());
    $('map-settings').addEventListener('click', (event) => {
      if (event.target === $('map-settings')) $('map-settings').close();
    });
    $('map-settings').addEventListener('close', scheduleRefresh);
    $('full-map-toggle').addEventListener('change', (event) => {
      fullMapEnabled = event.currentTarget.checked;
      try {
        localStorage.setItem('terraria-world-map-show-full', String(fullMapEnabled));
      } catch {}
      // Rebuild the explored mask when returning from full-map mode so every
      // cached chunk is clipped again by the current player exploration paths.
      maskPlayersKey = '';
      for (const canvas of chunkElements.values()) canvas.dataset.maskVersion = '';
      render();
    });
    $('map-debug-toggle').addEventListener('change', (event) => {
      debugWindowEnabled = event.currentTarget.checked;
      try {
        localStorage.setItem('terraria-world-map-debug-window', String(debugWindowEnabled));
      } catch {}
      renderDebugWindow();
    });
    $('map-import-button').addEventListener('click', () => {
      $('map-import-file').click();
    });
    $('map-import-player').addEventListener('change', updateMapImportOptions);
    $('download-player-map').addEventListener('click', async () => {
      const playerId = $('map-import-player').value,
        player = data?.players?.find((item) => item.id === playerId),
        worldId = data?.world?.id;
      if (!playerId || !worldId) {
        $('map-import-status').textContent =
          'Не удалось определить выбранного игрока или текущий мир.';
        return;
      }
      $('download-player-map').disabled = true;
      $('map-import-status').textContent = `Готовлю карту игрока ${player?.name || 'Игрок'}…`;
      try {
        const response = await fetch(
          `/api/world-map/export-player-map?id=${encodeURIComponent(playerId)}&world=${encodeURIComponent(worldId)}`,
          { method: 'POST', headers: { 'X-Terraria-Map-Debug-Page': '1' } },
        );
        if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
        const blob = await response.blob(),
          url = URL.createObjectURL(blob),
          link = document.createElement('a');
        const safeName = (player?.name || 'player').replace(/[^A-Za-z0-9_-]+/g, '_');
        link.href = url;
        link.download = `${safeName}-${worldId}.map`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        $('map-import-status').textContent = `Карта игрока ${player?.name || 'Игрок'} скачана.`;
      } catch (error) {
        $('map-import-status').textContent = `Не удалось скачать карту: ${error.message}`;
      } finally {
        $('download-player-map').disabled = false;
      }
    });
    $('clear-imported-map').addEventListener('click', async () => {
      const playerId = $('map-import-player').value,
        player = data?.players?.find((item) => item.id === playerId),
        worldId = data?.world?.id;
      if (!playerId || !worldId) {
        $('map-import-status').textContent =
          'Не удалось определить выбранного игрока или текущий мир.';
        return;
      }
      if (
        !confirm(
          `Удалить загруженную карту игрока ${player?.name || 'Игрок'}? Открытие по данным мода сохранится.`,
        )
      )
        return;
      $('clear-imported-map').disabled = true;
      $('map-import-status').textContent =
        `Очищаю импортированную карту игрока ${player?.name || 'Игрок'}…`;
      try {
        const response = await fetch(
          `/api/world-map/import-player-map?id=${encodeURIComponent(playerId)}&world=${encodeURIComponent(worldId)}`,
          { method: 'DELETE', headers: { 'X-Terraria-Map-Debug-Page': '1' } },
        );
        const message = await response.text();
        if (!response.ok) throw new Error(message || `HTTP ${response.status}`);
        const result = JSON.parse(message);
        $('map-import-status').textContent = result.removed
          ? `Импортированная карта игрока ${result.player} очищена. Данные мода сохранены.`
          : `У игрока ${result.player} нет импортированной карты для этого мира.`;
        renderKey = '';
        await refresh(false);
      } catch (error) {
        $('map-import-status').textContent = `Не удалось очистить карту: ${error.message}`;
      } finally {
        $('clear-imported-map').disabled = false;
      }
    });
    $('map-import-file').addEventListener('change', async (event) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = '';
      if (!file) return;
      const playerId = $('map-import-player').value;
      if (!playerId) {
        $('map-import-status').textContent = 'Сначала выберите игрока.';
        return;
      }
      $('map-import-button').disabled = true;
      $('map-import-status').textContent = `Читаю ${file.name}…`;
      try {
        const importedWorld = await readImportedMapIdentity(file),
          currentWorld = data?.world;
        if (
          !currentWorld?.id ||
          !currentWorld?.name ||
          !currentWorld?.width ||
          !currentWorld?.height
        )
          throw new Error('Не удалось подтвердить текущий мир сервера.');
        if (
          String(importedWorld.id) !== String(currentWorld.id) ||
          importedWorld.name.toLocaleLowerCase() !==
            String(currentWorld.name).toLocaleLowerCase() ||
          importedWorld.width !== Number(currentWorld.width) ||
          importedWorld.height !== Number(currentWorld.height)
        )
          throw new Error('Этот файл карты относится не к текущему миру сервера.');
        const response = await fetch(
          `/api/world-map/import-player-map?id=${encodeURIComponent(playerId)}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Terraria-Map-Debug-Page': '1',
            },
            body: file,
          },
        );
        const message = await response.text();
        if (!response.ok) throw new Error(message || `HTTP ${response.status}`);
        const result = JSON.parse(message);
        $('map-import-status').textContent =
          `${result.merged ? 'Области карты объединены' : 'Карта загружена'} для ${result.player}: ${Number(result.opened_tiles).toLocaleString('ru-RU')} открытых тайлов.`;
        renderKey = '';
        await refresh(false);
      } catch (error) {
        $('map-import-status').textContent = `Не удалось загрузить карту: ${error.message}`;
      } finally {
        $('map-import-button').disabled = false;
      }
    });
  }
  $('zoom-in').addEventListener('click', () =>
    setScale(scale * 1.4, $('viewport').clientWidth / 2, $('viewport').clientHeight / 2),
  );
  $('zoom-out').addEventListener('click', () =>
    setScale(scale / 1.4, $('viewport').clientWidth / 2, $('viewport').clientHeight / 2),
  );
  $('fit').addEventListener('click', fitMap);
  $('viewport').addEventListener(
    'wheel',
    (event) => {
      hideMapTooltip();
      event.preventDefault();
      const rect = $('viewport').getBoundingClientRect();
      setScale(
        scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    },
    { passive: false },
  );
  const pointers = new Map();
  let pinchStart = null,
    dragStart = null;
  $('viewport').addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    if (event.pointerType === 'mouse') hideMapTooltip();
    else scheduleMapTooltip(event);
    $('viewport').setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const p = [...pointers.values()],
        rect = $('viewport').getBoundingClientRect(),
        cx = (p[0].x + p[1].x) / 2 - rect.left,
        cy = (p[0].y + p[1].y) / 2 - rect.top;
      pinchStart = {
        distance: Math.max(1, Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)),
        scale,
        ...worldPointAt(cx, cy),
      };
      dragStart = null;
    } else {
      dragStart = {
        x: event.clientX,
        y: event.clientY,
        left: $('viewport').scrollLeft,
        top: $('viewport').scrollTop,
      };
      $('viewport').classList.add('dragging');
    }
  });
  $('viewport').addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) {
      if (event.pointerType === 'mouse' || event.pointerType === 'pen') scheduleMapTooltip(event);
      return;
    }
    if (event.pointerType !== 'mouse') scheduleMapTooltip(event);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2 && pinchStart) {
      const p = [...pointers.values()],
        distance = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y),
        cx = (p[0].x + p[1].x) / 2,
        cy = (p[0].y + p[1].y) / 2,
        rect = $('viewport').getBoundingClientRect(),
        anchorX = cx - rect.left,
        anchorY = cy - rect.top;
      setScale((pinchStart.scale * distance) / pinchStart.distance);
      placeWorldPoint(pinchStart.x, pinchStart.y, anchorX, anchorY);
    } else if (dragStart && pointers.size === 1) {
      $('viewport').scrollLeft = dragStart.left - (event.clientX - dragStart.x);
      $('viewport').scrollTop = dragStart.top - (event.clientY - dragStart.y);
    }
  });
  const endPointer = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size === 1) {
      const remaining = [...pointers.values()][0];
      pinchStart = null;
      dragStart = {
        x: remaining.x,
        y: remaining.y,
        left: $('viewport').scrollLeft,
        top: $('viewport').scrollTop,
      };
    } else if (!pointers.size) {
      pinchStart = null;
      dragStart = null;
      $('viewport').classList.remove('dragging');
    }
  };
  $('viewport').addEventListener('pointerup', endPointer);
  $('viewport').addEventListener('pointercancel', endPointer);
  $('viewport').addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse' && !pointers.has(event.pointerId)) hideMapTooltip();
  });
  $('viewport').addEventListener('scroll', requestVisibleChunkRender, { passive: true });
  $('download-map').addEventListener('click', downloadMapImage);
  window.addEventListener('resize', () => {
    if (data) {
      if (fitMode === 'explored') focusMap();
      else fitMap();
    }
  });
  if (debugMode) {
    // The full bootstrap response contains thousands of compressed chunks.
    // Restore the regular page's cached snapshot first so Safari can request
    // only changes. A stale IndexedDB read must not block the debug page.
    const restore = restoreCachedMap();
    const cacheDeadline = new Promise((resolve) => setTimeout(resolve, 2500));
    Promise.race([restore, cacheDeadline])
      .then(() => refresh(true))
      .then(scheduleRefresh);
  } else {
    restoreCachedMap().finally(() => refresh(true).then(scheduleRefresh));
  }
  window.addEventListener('terraria:view-change', (event) => {
    mapViewActive = (event as CustomEvent<{ view?: string }>).detail?.view === 'map';
    clearTimeout(pollTimer);
    if (mapViewActive) {
      refresh(false).finally(scheduleRefresh);
    }
  });
})();
