import { activateModules } from '../core/modules';
import { renderIcons } from '../core/icons';
import { MapSnapshotCache } from './map-snapshot-cache';
import { MapChunkCodec, type MapChunkSource } from './map-chunk-codec';
import { MapViewportController } from './map-viewport-controller';
import { MapEntityLayer } from './map-entity-layer';
import { MapTooltipController } from './map-tooltip-controller';
import { MapPlayerPathService } from './map-player-path-service';
import { MapRouteLayer } from './map-route-layer';
import { MapDiagnosticsPanel } from './map-diagnostics-panel';
import { MapChunkLayerRenderer } from './map-chunk-layer-renderer';
import { MapExplorationMask } from './map-exploration-mask';
import { MapOverviewRenderer } from './map-overview-renderer';
import { MapImageExporter } from './map-image-exporter';

const modules = await activateModules('world_map');

(() => {
  const $ = (id: string): any => document.getElementById(id);
  // The explicit debug URL is the access switch for diagnostics and map import tools.
  // Keep these controls absent from the regular map, regardless of module defaults.
  const debugMode = /^\/debug\/?$/.test(location.pathname);
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
  let chunkOwners = new Map(),
    explorationImageCache = new Map(),
    overviewDirtyChunks = new Set();
  let maskCanvas = null,
    explorationMask = null,
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
    chunkSize = 64;
  let overviewSaveTimer = null;
  let baseMapRevision = 0,
    lastSnapshotSavedAt = 0;
  const mapSnapshotCache = new MapSnapshotCache<any>();
  const mapChunkCodec = new MapChunkCodec();
  const mapImageExporter = new MapImageExporter({
    button: $('download-map'),
    codec: mapChunkCodec,
    getWorld: () => data?.world || null,
    getChunkOwners: () => chunkOwners as Map<string, MapChunkSource>,
    getChunkSize: () => chunkSize,
    getMaskCanvas: () => maskCanvas,
    isFullMapEnabled: () => fullMapEnabled,
    nextFrame: () => nextFrame(),
    onError: (error) =>
      status(`Не удалось скачать карту: ${error instanceof Error ? error.message : String(error)}`),
  });
  const overviewRenderer = new MapOverviewRenderer({
    canvas: $('map-preview'),
    codec: mapChunkCodec,
    overviewScale: OVERVIEW_SCALE,
    getWorld: () => data?.world || null,
    getChunkSize: () => chunkSize,
    getChunkOwners: () => chunkOwners,
    getDirtyChunks: () => overviewDirtyChunks as Set<string>,
    clearDirtyChunks: () => overviewDirtyChunks.clear(),
    getMaskCanvas: () => maskCanvas,
    isFullMapEnabled: () => fullMapEnabled,
    getRevision: () => baseMapRevision,
    onReady: () => {
      queueMapSnapshotSave();
      requestVisibleChunkRender();
    },
    onError: (error) =>
      status(
        `Не удалось подготовить обзор карты: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  const chunkLayerRenderer = new MapChunkLayerRenderer({
    layer: $('chunk-layer'),
    viewport: $('viewport'),
    stage: $('stage'),
    codec: mapChunkCodec,
    getWorld: () => (data?.world ? data.world : null),
    getScale: () => scale,
    getFitScale: () => fitScale,
    getChunkSize: () => chunkSize,
    getMaskCanvas: () => maskCanvas,
    getMaskVersion: () => maskVersion,
    isFullMapEnabled: () => fullMapEnabled,
    getChunkOwners: () => chunkOwners,
    drawOverview: () => drawOverview(),
    onError: (error) =>
      status(
        `Не удалось отрисовать карту: ${error instanceof Error ? error.message : String(error)}`,
      ),
    maskScale: MASK_SCALE,
  });
  const mapEntityLayer = new MapEntityLayer($('stage'));
  const routeLayer = new MapRouteLayer($('route-layer'), colors);
  const mapDiagnostics = new MapDiagnosticsPanel(Boolean(debugMode));
  const playerPaths = new MapPlayerPathService();
  const mapTooltip = new MapTooltipController({
    stage: $('stage'),
    tooltip: $('map-tooltip'),
    getData: () => data,
    getScale: () => scale,
    getMaskCanvas: () => maskCanvas,
    isEnabled: () => Boolean(modules['world_map.tooltips']),
    isFullMapEnabled: () => fullMapEnabled,
    getPlayerPoint: (player) => mapEntityLayer.markerPosition(player),
  });
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
  const readMapSnapshot = () => mapSnapshotCache.read();
  const saveMapSnapshot = async (preview) => {
    if (!data || !preview) return;

    // Cache the API snapshot and preview together so startup can paint before the next API request.
    await mapSnapshotCache.save({
      data,
      preview,
      previewVersion: OVERVIEW_VERSION,
      baseMapRevision,
      savedAt: Date.now(),
    });
    lastSnapshotSavedAt = Date.now();
  };
  const queueMapSnapshotSave = () => {
    const sourceCanvas = overviewRenderer.source;
    if (!data || !overviewRenderer.isReady || !sourceCanvas?.toBlob) return;
    if (Date.now() - lastSnapshotSavedAt < 20000) return;
    clearTimeout(overviewSaveTimer);
    overviewSaveTimer = setTimeout(
      () =>
        sourceCanvas.toBlob((blob) => {
          if (blob) saveMapSnapshot(blob).catch(() => {});
        }, 'image/png'),
      800,
    );
  };
  const drawOverview = () => overviewRenderer.draw();
  const downloadMapImage = () => mapImageExporter.download();
  const restoreOverview = (blob) => overviewRenderer.restore(blob);
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const buildOverview = () => overviewRenderer.build();
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
  const redrawVisiblePaths = () => {
    if (!data) return;
    routeLayer.render(
      playerPaths
        .withPaths(data?.players || [], data.world)
        .filter((player) => playerOptions(player).route),
      data.players || [],
    );
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
        button.append(mapEntityLayer.makeAvatar(player));
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
    chunkLayerRenderer.layout();
  };
  const requestVisibleChunkRender = () => {
    chunkLayerRenderer.requestRender();
  };
  const updateChunkOwners = (width, height, size, players) => {
    const worldKey = `${data.world?.id}:${width}x${height}`;
    if (canvasWorld !== worldKey) {
      chunkLayerRenderer.clear();
      playerPaths.clear();
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
      explorationMask = new MapExplorationMask(maskCanvas, MASK_SCALE);
      maskVersion++;
      overviewRenderer.resetWorld(width, height);
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
    const players = playerPaths.withPaths(data?.players || [], data.world),
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
    // Older telemetry lacks Main.worldSurface; the world spawn is a safe temporary boundary.
    const worldSurface = data.world?.surface_y ?? data.world?.spawn_y;
    const surfaceY = Number.isFinite(Number(worldSurface)) ? Number(worldSurface) : null;
    const nextMaskPlayersKey = JSON.stringify([
      surfaceY,
      explored.map((player) => [player.id, player.pathKey, player.exploration_url]),
    ]);
    const rebuildMask = nextMaskPlayersKey !== maskPlayersKey;
    if (rebuildMask && explorationMask) {
      exploredPercent = explorationMask.rebuild(explored, explorationImages, surfaceY);
      maskPlayersKey = nextMaskPlayersKey;
    }
    if (rebuildMask) maskVersion++;
    drawOverview();
    void buildOverview();
    const nextRouteKey = JSON.stringify(routed.map((player) => [player.id, player.pathKey]));
    if (nextRouteKey !== routeKey) {
      routeLayer.render(routed, data.players || []);
      routeKey = nextRouteKey;
    }
    mapEntityLayer.setWorld(data.world);
    const markerPlayers = modules['world_map.players']
      ? players.filter((player) => player.online === true)
      : [];
    const nextMarkerKey = JSON.stringify(
      markerPlayers.map((player) => [
        player.id,
        player.name,
        player.avatar_url,
        player.online,
        player.team,
        player.direction,
        player.session_seconds,
        player.position?.tileX,
        player.position?.tileY,
        player.position?.x,
        player.position?.y,
      ]),
    );
    if (nextMarkerKey !== markerKey) {
      mapEntityLayer.drawMarkers(markerPlayers);
      markerKey = nextMarkerKey;
    }
    const pylonKey = modules['world_map.pylons'] ? JSON.stringify(data.pylons || []) : 'off';
    if (pylonKey !== pylonRenderKey) {
      mapEntityLayer.drawPylons(modules['world_map.pylons'] ? data.pylons : []);
      pylonRenderKey = pylonKey;
    }
    const entityKey = modules['world_map.entities']
      ? JSON.stringify(data.active_npcs || [])
      : 'off';
    if (entityKey !== entityRenderKey) {
      mapEntityLayer.drawEntities(modules['world_map.entities'] ? data.active_npcs : []);
      entityRenderKey = entityKey;
    }
    const coinKey = modules['world_map.coins'] ? JSON.stringify(data.coins || []) : 'off';
    if (coinKey !== coinRenderKey) {
      mapEntityLayer.drawDroppedCoins(modules['world_map.coins'] ? data.coins : []);
      coinRenderKey = coinKey;
    }
    if (modules['world_map.spawn']) {
      mapEntityLayer.setWorld(data.world);
      mapEntityLayer.drawSpawn(data.world);
    } else $('pylons').querySelector('.spawn-marker')?.remove();
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
    mapDiagnostics.render(data, exploredPercent, fullMapEnabled, debugWindowEnabled);
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
      overviewRenderer.resetWorld(Number(data.world.width) || 1, Number(data.world.height) || 1);
      if (cached.previewVersion === OVERVIEW_VERSION && (await restoreOverview(cached.preview))) {
        drawOverview();
      } else void buildOverview();
      render();
      focusMap();
      renderScanStatus();
      renderKey = '';
    } catch {}
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
      chunkLayerRenderer.invalidateExplorationMask();
      render();
    });
    $('map-debug-toggle').addEventListener('change', (event) => {
      debugWindowEnabled = event.currentTarget.checked;
      try {
        localStorage.setItem('terraria-world-map-debug-window', String(debugWindowEnabled));
      } catch {}
      renderScanStatus();
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
  const viewportController = new MapViewportController($('viewport'), {
    getScale: () => scale,
    setScale,
    worldPointAt,
    placeWorldPoint,
    hideTooltip: mapTooltip.hide,
    scheduleTooltip: mapTooltip.schedule,
    fitMap,
    focusMap,
    hasMapData: () => Boolean(data),
    usesExploredFit: () => fitMode === 'explored',
    renderVisibleChunks: requestVisibleChunkRender,
    downloadMapImage,
  });
  viewportController.bind();
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
