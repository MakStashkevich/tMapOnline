import { activateModules } from '../core/modules';
import { renderIcons } from '../core/icons';
import { MapChunkCodec, type MapChunkSource } from './map-chunk-codec';
import { MapViewportController } from './map-viewport-controller';
import { MapEntityLayer } from './map-entity-layer';
import { MapTooltipController } from './map-tooltip-controller';
import { MapPlayerPathService } from './map-player-path-service';
import { MapRouteLayer } from './map-route-layer';
import { MapDiagnosticsPanel } from './map-diagnostics-panel';
import { MapPyramidLayerRenderer } from './map-pyramid-layer-renderer';
import { MapExplorationMask } from './map-exploration-mask';
import { MapImageExporter } from './map-image-exporter';
import { MapRenderDebugPanel } from './map-render-debug-panel';

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
        <label class="setting-option"><input id="map-render-debug-toggle" type="checkbox"><span><strong>Нагрузка веб-рендера</strong><small>FPS, длительность задач, чанки и оценка памяти браузерных холстов.</small></span></label>
      </div>
    </dialog><pre id="map-debug-window" aria-live="polite" hidden></pre><section id="map-render-debug-window" class="render-debug-panel" aria-live="polite" hidden></section>`,
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
  const ANIMATED_MARKER_ZOOM_THRESHOLD = 15;
  let data = null,
    scale = 1,
    fitScale = 1,
    fitMode = 'explored',
    requestActive = false,
    renderKey = '';
  let exploredPercent = 0,
    pollTimer = null,
    livePollTimer = null,
    liveRequestActive = false,
    liveSince = 0,
    mapRevision = 0;
  let liveEventSource: EventSource | null = null;
  let liveStreamConnected = false;
  let liveStreamIntervalMs = 0;
  let liveApplyQueue: Promise<void> = Promise.resolve();
  let lastLiveArrivalAt = 0;
  let lastNetworkPingAt = 0;
  const networkRttSamples: number[] = [];
  const liveArrivalSamples: number[] = [];
  let mapViewActive = true;
  let fullMapEnabled = false;
  let debugWindowEnabled = false;
  let renderDebugWindowEnabled = false;
  try {
    fullMapEnabled = localStorage.getItem('terraria-world-map-show-full') === 'true';
  } catch {}
  try {
    debugWindowEnabled =
      debugMode && localStorage.getItem('terraria-world-map-debug-window') === 'true';
  } catch {}
  try {
    const savedRenderDebugPreference = localStorage.getItem('terraria-world-map-render-debug');
    renderDebugWindowEnabled = debugMode && savedRenderDebugPreference !== 'false';
  } catch {}
  let chunkOwners = new Map(),
    explorationImageCache = new Map();
  let maskCanvas = null,
    fogCanvas = $('fog-layer') as HTMLCanvasElement,
    explorationMask = null,
    maskPlayersKey = '',
    routeKey = '',
    markerKey = '',
    entityRenderKey = '',
    coinRenderKey = '',
    deathRenderKey = '',
    pylonRenderKey = '',
    spawnRenderKey = '',
    toggleKey = '',
    canvasWorld = '',
    chunkSize = 64;
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
  const chunkLayerRenderer = new MapPyramidLayerRenderer({
    layer: $('chunk-layer'),
    viewport: $('viewport'),
    stage: $('stage'),
    getWorld: () => (data?.world ? data.world : null),
    getScale: () => scale,
    onError: (error) =>
      status(
        `Не удалось загрузить фрагмент карты: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  const renderDebugPanel = debugMode
    ? new MapRenderDebugPanel($('map-render-debug-window'), () => {
        const mask = maskCanvas;
        return {
          ...chunkLayerRenderer.getDebugMetrics(),
          extraCanvasBytes: mask ? mask.width * mask.height * 4 : 0,
          spawnMarkerVisible: Boolean($('spawn')?.querySelector('.spawn-marker')),
        };
      })
    : null;
  renderDebugPanel?.setEnabled(renderDebugWindowEnabled);
  const mapEntityLayer = new MapEntityLayer($('stage'), (x, y) => {
    const viewport = getVisibleViewport();
    const padding = Number(data?.chunk_size || 64);
    return Boolean(
      viewport &&
      x >= viewport.worldLeft - padding &&
      x <= viewport.worldLeft + viewport.worldWidth + padding &&
      y >= viewport.worldTop - padding &&
      y <= viewport.worldTop + viewport.worldHeight + padding,
    );
  });
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
  const getVisibleViewport = () => {
    if (!data) return null;
    const viewport = $('viewport');
    const stage = $('stage');
    const viewportRect = viewport.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const contentLeft = stageRect.left - viewportRect.left + viewport.scrollLeft;
    const contentTop = stageRect.top - viewportRect.top + viewport.scrollTop;
    const screenLeft = viewport.scrollLeft - contentLeft;
    const screenTop = viewport.scrollTop - contentTop;

    return {
      worldLeft: screenLeft / scale,
      worldTop: screenTop / scale,
      worldWidth: viewport.clientWidth / scale,
      worldHeight: viewport.clientHeight / scale,
      screenLeft,
      screenTop,
      screenWidth: viewport.clientWidth,
      screenHeight: viewport.clientHeight,
    };
  };
  const drawOverview = () => {
    const visibleArea = getVisibleViewport();
    if (!data || !visibleArea) return;

    const paths = $('paths');
    paths.setAttribute(
      'viewBox',
      `${visibleArea.worldLeft} ${visibleArea.worldTop} ${visibleArea.worldWidth} ${visibleArea.worldHeight}`,
    );
    paths.style.left = `${visibleArea.screenLeft}px`;
    paths.style.top = `${visibleArea.screenTop}px`;
    paths.style.width = `${visibleArea.screenWidth}px`;
    paths.style.height = `${visibleArea.screenHeight}px`;
  };
  const layoutFogCanvas = () => {
    if (!data?.world) return;
    fogCanvas.style.width = `${data.world.width * scale}px`;
    fogCanvas.style.height = `${data.world.height * scale}px`;
  };
  const updateFogCanvas = () => {
    if (!maskCanvas || !data?.world) return;
    const context = fogCanvas.getContext('2d');
    if (!context) return;

    if (fogCanvas.width !== maskCanvas.width || fogCanvas.height !== maskCanvas.height) {
      fogCanvas.width = maskCanvas.width;
      fogCanvas.height = maskCanvas.height;
    }
    layoutFogCanvas();
    fogCanvas.style.display = fullMapEnabled ? 'none' : 'block';
    context.clearRect(0, 0, fogCanvas.width, fogCanvas.height);
    if (fullMapEnabled) return;

    context.fillStyle = '#05090d';
    context.fillRect(0, 0, fogCanvas.width, fogCanvas.height);
    context.globalCompositeOperation = 'destination-out';
    context.imageSmoothingEnabled = false;
    context.drawImage(maskCanvas, 0, 0);
    context.globalCompositeOperation = 'source-over';
  };
  let liveBoundsTimer: ReturnType<typeof setTimeout> | null = null;
  let liveSubscriptionKey = '';
  let renderedViewportKey = '';
  const appendLiveViewportParams = (params: URLSearchParams) => {
    const viewport = getVisibleViewport();
    if (!viewport || !data) return;
    const chunk = Number(data.chunk_size || 64);
    const left = Math.max(0, Math.floor((viewport.worldLeft - chunk) / chunk) * chunk);
    const top = Math.max(0, Math.floor((viewport.worldTop - chunk) / chunk) * chunk);
    const right = Math.min(
      Number(data.world.width),
      Math.ceil((viewport.worldLeft + viewport.worldWidth + chunk) / chunk) * chunk,
    );
    const bottom = Math.min(
      Number(data.world.height),
      Math.ceil((viewport.worldTop + viewport.worldHeight + chunk) / chunk) * chunk,
    );
    params.set('left', String(left));
    params.set('top', String(top));
    params.set('right', String(Math.max(left + 1, right)));
    params.set('bottom', String(Math.max(top + 1, bottom)));
    params.set('coins', viewport.worldWidth <= 256 && viewport.worldHeight <= 256 ? '1' : '0');
  };
  const getLiveViewportKey = () => {
    const params = new URLSearchParams();
    appendLiveViewportParams(params);
    return params.toString();
  };
  const scheduleVisibleLiveRefresh = () => {
    if (liveBoundsTimer) clearTimeout(liveBoundsTimer);
    liveBoundsTimer = setTimeout(() => {
      liveBoundsTimer = null;
      const nextViewportKey = getLiveViewportKey();
      if (nextViewportKey === renderedViewportKey) return;
      renderedViewportKey = nextViewportKey;
      markerKey = '';
      entityRenderKey = '';
      coinRenderKey = '';
      deathRenderKey = '';
      renderLiveLayers();
      updateLiveStreamCadence();
    }, 300);
  };
  const downloadMapImage = async () => {
    if (!data?.world?.id) return;

    const currentData = data;
    try {
      const params = new URLSearchParams({ world: String(currentData.world.id) });
      const response = await fetch(`/api/world-map?${params}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      // The complete chunk set is fetched only for an explicit full-resolution export.
      data = await response.json();
      updateChunkOwners(
        Number(data.world.width),
        Number(data.world.height),
        Number(data.chunk_size || 64),
        data.players || [],
      );
      await mapImageExporter.download();
    } catch (error) {
      status(
        `Не удалось подготовить PNG: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      data = currentData;
      updateChunkOwners(
        Number(data.world.width),
        Number(data.world.height),
        Number(data.chunk_size || 64),
        data.players || [],
      );
      requestVisibleChunkRender();
    }
  };
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const setScale = (next, anchorX = null, anchorY = null) => {
    if (!data) return;
    $('viewport').classList.add('map-loaded');
    const worldPoint = anchorX == null ? null : worldPointAt(anchorX, anchorY);
    scale = Math.max(fitScale, Math.min(16, next));
    mapEntityLayer.setAnimationEnabled(scale > fitScale * ANIMATED_MARKER_ZOOM_THRESHOLD);
    updateLiveStreamCadence();
    const width = Math.max(1, Math.round(data.world.width * scale)),
      height = Math.max(1, Math.round(data.world.height * scale));
    $('stage').style.width = `${width}px`;
    $('stage').style.height = `${height}px`;
    $('stage').classList.toggle('detail-zoom', chunkLayerRenderer.isDetailZoom());
    mapEntityLayer.refreshMarkerPositions();
    $('stage').classList.toggle('pixelated', scale >= 1);
    layoutVisibleChunks();
    layoutFogCanvas();
    $('zoom-level').textContent = `${Math.round((scale / fitScale) * 100)}%`;
    if (worldPoint) placeWorldPoint(worldPoint.x, worldPoint.y, anchorX, anchorY);
    scheduleViewportLayerUpdate();
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
    const chunkSize = Number(data.chunk_size || 64);
    const positions = (data.players || []).flatMap((player) => [
      ...(player.positions || []),
      ...(player.position ? [player.position] : []),
    ]);
    if (!positions.length) {
      fitMap();
      return;
    }
    const playerX = (point) => Number(point.tileX ?? point.x);
    const playerY = (point) => Number(point.tileY ?? point.y);
    const minX = Math.min(...positions.map(playerX));
    const maxX = Math.max(...positions.map(playerX));
    const minY = Math.min(...positions.map(playerY));
    const maxY = Math.max(...positions.map(playerY));
    const padding = Math.max(96, chunkSize),
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
  const resizeViewport = () => {
    if (!data) return;
    fitScale = worldFitScale();
    const viewport = $('viewport');

    // Safari changes the visual viewport as its browser bars move. Keep the map zoomed
    // around the current center instead of snapping back to the fit or exploration view.
    setScale(scale, viewport.clientWidth / 2, viewport.clientHeight / 2);
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
  let viewportLayerFrame: number | null = null;
  const scheduleViewportLayerUpdate = () => {
    if (viewportLayerFrame !== null) return;
    viewportLayerFrame = requestAnimationFrame(() => {
      viewportLayerFrame = null;
      drawOverview();
      requestVisibleChunkRender();
      scheduleVisibleLiveRefresh();
    });
  };
  const requestVisibleChunkRender = () => {
    chunkLayerRenderer.requestRender();
  };
  const updateChunkOwners = (width, height, size, players) => {
    const worldKey = `${data.world?.id}:${width}x${height}`;
    if (canvasWorld !== worldKey) {
      chunkLayerRenderer.clear();
      playerPaths.clear();
      maskPlayersKey = '';
      routeKey = '';
      markerKey = '';
      entityRenderKey = '';
      coinRenderKey = '';
      deathRenderKey = '';
      pylonRenderKey = '';
      spawnRenderKey = '';
      canvasWorld = worldKey;
      maskCanvas = document.createElement('canvas');
      maskCanvas.width = Math.ceil(width * MASK_SCALE);
      maskCanvas.height = Math.ceil(height * MASK_SCALE);
      if (fogCanvas.width !== maskCanvas.width || fogCanvas.height !== maskCanvas.height) {
        fogCanvas.width = maskCanvas.width;
        fogCanvas.height = maskCanvas.height;
      }
      fogCanvas.style.width = `${width * scale}px`;
      fogCanvas.style.height = `${height * scale}px`;
      explorationMask = new MapExplorationMask(maskCanvas, MASK_SCALE);
    }
    chunkSize = size;
    const previousOwners = chunkOwners,
      nextOwners = new Map();
    for (const chunk of data.base_chunks || []) {
      const x = Number(chunk.x),
        y = Number(chunk.y);
      if (Number.isInteger(x) && Number.isInteger(y)) {
        const key = `${x},${y}`;
        const previous = previousOwners.get(key);
        const keepPixelUpdates = previous?.base === chunk.data;
        nextOwners.set(key, {
          base: chunk.data,
          overlays: [],
          pixelUpdates: keepPixelUpdates ? previous.pixelUpdates : new Map(),
          updateRevision: keepPixelUpdates ? previous.updateRevision || 0 : 0,
        });
      }
    }
    for (const player of players)
      for (const chunk of player.chunks || []) {
        const x = Number(chunk.x),
          y = Number(chunk.y);
        if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
        const key = `${x},${y}`,
          owner = nextOwners.get(key) || {
            base: null,
            overlays: [],
            pixelUpdates: new Map(),
            updateRevision: 0,
          };
        owner.overlays.push(chunk.data);
        nextOwners.set(key, owner);
      }
    chunkOwners = nextOwners;
    mapRevision = Number(data.map_revision) || mapRevision;
  };
  const applyMapTileUpdates = (batches) => {
    let changed = false;
    const changedPoints: Array<{ x: number; y: number }> = [];
    for (const batch of batches) {
      for (const update of batch.updates || []) {
        const x = Number(update.x);
        const y = Number(update.y);
        const color = update.color;
        if (
          !Number.isInteger(x) ||
          !Number.isInteger(y) ||
          x < 0 ||
          y < 0 ||
          x >= data.world.width ||
          y >= data.world.height ||
          !Array.isArray(color) ||
          color.length !== 4
        )
          continue;

        const chunkX = Math.floor(x / chunkSize);
        const chunkY = Math.floor(y / chunkSize);
        const key = `${chunkX},${chunkY}`;
        const owner = chunkOwners.get(key) || {
          base: null,
          overlays: [],
          pixelUpdates: new Map(),
          updateRevision: 0,
        };
        const pixelUpdates = owner.pixelUpdates || new Map();
        const offset = (y % chunkSize) * chunkSize + (x % chunkSize);
        pixelUpdates.set(offset, color as [number, number, number, number]);
        owner.pixelUpdates = pixelUpdates;
        owner.updateRevision = (owner.updateRevision || 0) + 1;
        chunkOwners.set(key, owner);
        changedPoints.push({ x, y });
        changed = true;
      }
    }

    if (changed) {
      chunkLayerRenderer.invalidateMapTiles(changedPoints);
    }
  };
  const renderLiveLayers = () => {
    if (!data) return;
    const players = data.players || [];
    const routed = modules['world_map.routes']
      ? playerPaths.withPaths(
          players.filter((player) => playerOptions(player).route),
          data.world,
        )
      : [];
    const nextRouteKey = JSON.stringify(routed.map((player) => [player.id, player.pathKey]));
    if (nextRouteKey !== routeKey) {
      routeLayer.render(routed, players);
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
        player.velocity?.x,
        player.velocity?.y,
        player.teleported,
      ]),
    );
    if (nextMarkerKey !== markerKey) {
      mapEntityLayer.drawMarkers(markerPlayers);
      markerKey = nextMarkerKey;
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
    const deathKey = modules['world_map.players']
      ? JSON.stringify([data.world?.id, data.deaths || []])
      : 'off';
    if (deathKey !== deathRenderKey) {
      mapEntityLayer.drawDeaths(modules['world_map.players'] ? data.deaths : []);
      deathRenderKey = deathKey;
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
      updateFogCanvas();
    }
    drawOverview();
    renderLiveLayers();
    const pylonKey = modules['world_map.pylons'] ? JSON.stringify(data.pylons || []) : 'off';
    if (pylonKey !== pylonRenderKey) {
      mapEntityLayer.drawPylons(modules['world_map.pylons'] ? data.pylons : []);
      pylonRenderKey = pylonKey;
    }
    if (modules['world_map.spawn']) {
      mapEntityLayer.setWorld(data.world);
      mapEntityLayer.drawSpawn(data.world);
    } else $('spawn').querySelector('.spawn-marker')?.remove();
    $('title').textContent = data.world?.name
      ? `Карта мира — ${data.world.name}`
      : 'Карта исследования';
    $('subtitle').textContent =
      `${width.toLocaleString('ru-RU')} × ${height.toLocaleString('ru-RU')} тайлов — изучено ${Math.round(exploredPercent)}% карты`;
    renderToggles();
    updateMapImportOptions();
    const hasMap =
      Number(data.map_version || data.map_revision || 0) > 0 ||
      explored.some((player) => player.exploration_url || player.positions?.length);
    status(
      hasMap
        ? ''
        : 'Карта станет видна, когда появятся данные карты и обычных перемещений игроков.',
    );
    requestVisibleChunkRender();
  };
  const refresh = async (initial) => {
    if (requestActive) return;
    requestActive = true;
    try {
      const query = new URLSearchParams(location.search).get('world');
      const params = new URLSearchParams();
      if (query) params.set('world', query);
      params.set('tiles', '1');
      if (data?.updated_at) params.set('since', String(data.updated_at));
      if (liveSince > 0) params.set('live_since', String(liveSince));
      const response = await fetchWithTimeout(
        `/api/world-map${params.size ? `?${params}` : ''}`,
        { cache: 'no-store' },
        30000,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = await response.json();
      for (const player of next.players || []) {
        for (const point of player.positions || []) {
          liveSince = Math.max(liveSince, Number(point.time) || 0);
        }
      }
      const sameWorld =
        data &&
        String(data.world?.id) === String(next.world?.id) &&
        data.world?.name === next.world?.name;
      const mapVersionChanged =
        Boolean(data) && Number(data.map_version || 0) !== Number(next.map_version || 0);
      if (sameWorld) {
        // A stale telemetry response is not evidence that every NPC despawned.
        // Keep the last authoritative snapshot until a fresh one arrives.
        if (next.active_npcs_fresh !== true) {
          next.active_npcs = data.active_npcs || [];
        }
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
          const previousPlayer = previousPlayers.get(player.id);
          const oldPositions = new Map<string, any>(
            (previousPlayer?.positions || []).map((point) => [
              `${point.time}:${point.x}:${point.y}`,
              point,
            ]),
          );
          for (const point of player.positions || []) {
            oldPositions.set(`${point.time}:${point.x}:${point.y}`, point);
            liveSince = Math.max(liveSince, Number(point.time) || 0);
          }
          const oldChunks = new Map<string, any>(
            (previousPlayer?.chunks || []).map((chunk) => [`${chunk.x},${chunk.y}`, chunk]),
          );
          for (const chunk of player.chunks || []) oldChunks.set(`${chunk.x},${chunk.y}`, chunk);
          return {
            ...player,
            positions: [...oldPositions.values()].sort((left, right) => left.time - right.time),
            chunks: [...oldChunks.values()],
          };
        });
      }
      const key = JSON.stringify([
        next.updated_at,
        next.map_version,
        next.map_revision,
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
      const hadMapData = Boolean(data);
      data = next;
      renderDebugPanel?.setData(next);
      await render();
      if (mapVersionChanged) chunkLayerRenderer.invalidateVisibleTiles();
      if (!hadMapData || !sameWorld) focusMap();
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
      Number(
        data?.telemetry?.configured_intervals?.[
          debugMode && $('map-settings').open
            ? 'browser_debug_poll_interval_ms'
            : 'browser_map_poll_interval_ms'
        ],
      ) || (debugMode && $('map-settings').open ? 1000 : 5000),
    );
  }
  async function refreshLive() {
    if (!mapViewActive || liveRequestActive) return;
    liveRequestActive = true;
    try {
      const params = new URLSearchParams();
      const requestedWorld = new URLSearchParams(location.search).get('world');
      if (requestedWorld) params.set('world', requestedWorld);
      if (liveSince > 0) params.set('since', String(liveSince));
      params.set('map_since', String(mapRevision));
      appendLiveViewportParams(params);
      const requestStartedAt = performance.now();
      const response = await fetchWithTimeout(
        `/api/world-map/live${params.size ? `?${params}` : ''}`,
        { cache: 'no-store' },
        10000,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const responseText = await response.text();
      const payload = JSON.parse(responseText);
      recordNetworkArrival(performance.now(), false);
      await applyLivePayload(payload, responseText, performance.now() - requestStartedAt);
      void measureNetworkRtt();
    } catch (error) {
      console.warn('Live map update failed:', error);
    } finally {
      liveRequestActive = false;
    }
  }
  function recordNetworkArrival(now: number, fromStream: boolean): void {
    if (lastLiveArrivalAt > 0) {
      const interval = now - lastLiveArrivalAt;
      if (interval > 0 && interval < 10000) {
        liveArrivalSamples.push(interval);
        if (liveArrivalSamples.length > 120) liveArrivalSamples.shift();
        const sorted = [...liveArrivalSamples].sort((left, right) => left - right);
        const median = percentile(sorted, 0.5);
        const p95 = percentile(sorted, 0.95);
        // Keep the normal delay at 80 ms and add only the measured tail jitter.
        mapEntityLayer.setInterpolationDelay(
          Math.max(80, Math.min(300, 80 + Math.max(0, p95 - median) * 1.5)),
        );
      }
    }
    lastLiveArrivalAt = now;
    if (data) {
      const sorted = [...liveArrivalSamples].sort((left, right) => left - right);
      const median = percentile(sorted, 0.5);
      const p95 = percentile(sorted, 0.95);
      data.live_network = {
        ...(data.live_network || {}),
        stream_state: liveStreamConnected ? 'Подключён' : 'Резервный опрос',
        arrival_p50_ms: median,
        arrival_p95_ms: p95,
        interpolation_delay_ms: Math.max(80, Math.min(300, 80 + Math.max(0, p95 - median) * 1.5)),
      };
      if (fromStream) data.live_network.stream_state = 'SSE';
    }
  }
  function percentile(sortedSamples: number[], fraction: number): number {
    if (sortedSamples.length === 0) return 0;
    return sortedSamples[
      Math.min(sortedSamples.length - 1, Math.floor((sortedSamples.length - 1) * fraction))
    ];
  }
  async function measureNetworkRtt(): Promise<void> {
    if (!mapViewActive || (lastNetworkPingAt > 0 && performance.now() - lastNetworkPingAt < 15000))
      return;
    lastNetworkPingAt = performance.now();
    const startedAt = performance.now();
    try {
      const response = await fetch('/api/ping', { cache: 'no-store' });
      if (!response.ok) return;
      networkRttSamples.push(performance.now() - startedAt);
      if (networkRttSamples.length > 20) networkRttSamples.shift();
      if (data) {
        const sorted = [...networkRttSamples].sort((a, b) => a - b);
        data.live_network = {
          ...(data.live_network || {}),
          rtt_p50_ms: percentile(sorted, 0.5),
          rtt_p95_ms: percentile(sorted, 0.95),
        };
      }
    } catch {
      // A diagnostic ping must never interrupt the live map stream.
    }
  }
  async function applyLivePayload(
    payload: any,
    responseText: string,
    requestMs: number | null,
  ): Promise<void> {
    if (!data || String(data.world?.id) !== String(payload.world?.id)) return;
    if (payload.map_delta_reset) {
      await refresh(false);
      mapRevision = Number(data?.map_revision) || 0;
      return;
    }
    applyMapTileUpdates(payload.map_tile_updates || []);
    liveSince = Math.max(liveSince, Number(payload.position_cursor) || 0);
    mapRevision = Number(payload.map_revision) || mapRevision;
    data.map_revision = mapRevision;
    if (payload.map_tile_updates?.length) data.map_version = Date.now();

    const playersById = new Map<string, any>(
      (data.players || []).map((player) => [player.id, player]),
    );
    for (const incoming of payload.players || []) {
      const current = playersById.get(incoming.id) || {
        chunks: [],
        positions: [],
        has_imported_map: false,
      };
      const positions: any[] = current.positions || [];
      const incomingPositions: any[] = incoming.positions || [];
      let appendOnly = true;
      let latestPositionTime = Number(positions.at(-1)?.time) || 0;

      for (const point of incomingPositions) {
        const pointTime = Number(point.time) || 0;
        if (pointTime <= latestPositionTime) appendOnly = false;
        latestPositionTime = Math.max(latestPositionTime, pointTime);
        liveSince = Math.max(liveSince, Number(point.time) || 0);
      }

      if (appendOnly) {
        positions.push(...incomingPositions);
      } else if (incomingPositions.length > 0) {
        // Out-of-order samples are rare; keep the full dedupe path off the normal live-update path.
        const mergedPositions = new Map<string, any>(
          positions.map((point) => [`${point.time}:${point.x}:${point.y}`, point]),
        );
        for (const point of incomingPositions) {
          mergedPositions.set(`${point.time}:${point.x}:${point.y}`, point);
        }
        current.positions = [...mergedPositions.values()].sort(
          (left, right) => left.time - right.time,
        );
      }

      playersById.set(incoming.id, {
        ...current,
        ...incoming,
        positions: current.positions || positions,
      });
    }
    const onlinePlayerIds = new Set(payload.online_player_ids || []);
    data.players = [...playersById.values()].map((player) => ({
      ...player,
      online: onlinePlayerIds.has(player.id),
      team: onlinePlayerIds.has(player.id) ? player.team : null,
      direction: onlinePlayerIds.has(player.id) ? player.direction : null,
      session_seconds: onlinePlayerIds.has(player.id) ? player.session_seconds : null,
    }));
    for (const death of payload.deaths || []) {
      liveSince = Math.max(liveSince, Number(death.timestamp) || 0);
    }
    data.deaths = payload.deaths || [];
    // Polling and viewport stream reconnects can briefly return stale telemetry.
    // Only a fresh snapshot may add or remove markers from the map.
    if (payload.active_npcs_fresh === true) {
      data.active_npcs = payload.active_npcs || [];
    }
    data.coins = payload.coins || [];
    data.telemetry = payload.telemetry;
    data.live_payload_bytes = new Blob([responseText]).size;
    data.live_request_ms = requestMs;
    data.live_updated_at = payload.updated_at;
    renderDebugPanel?.setData(data);
    const renderStartedAt = performance.now();
    renderLiveLayers();
    data.live_render_ms = performance.now() - renderStartedAt;
    renderScanStatus();
  }
  function connectLiveStream(): void {
    if (!mapViewActive || liveEventSource) return;
    const params = new URLSearchParams();
    const requestedWorld = new URLSearchParams(location.search).get('world');
    if (requestedWorld) params.set('world', requestedWorld);
    if (liveSince > 0) params.set('since', String(liveSince));
    params.set('map_since', String(mapRevision));
    appendLiveViewportParams(params);
    const closeUp = scale > fitScale * ANIMATED_MARKER_ZOOM_THRESHOLD;
    const configuredInterval =
      Number(data?.telemetry?.configured_intervals?.browser_live_poll_interval_ms) || 50;
    const overviewInterval =
      Number(data?.telemetry?.configured_intervals?.browser_overview_poll_interval_ms) || 250;
    liveStreamIntervalMs = closeUp
      ? configuredInterval
      : Math.max(configuredInterval, overviewInterval);
    params.set('interval_ms', String(liveStreamIntervalMs));
    liveSubscriptionKey = getLiveViewportKey();
    const stream = new EventSource(`/api/world-map/stream?${params}`);
    liveEventSource = stream;
    stream.onopen = () => {
      liveStreamConnected = true;
      clearTimeout(livePollTimer);
      void measureNetworkRtt();
    };
    stream.onmessage = (event) => {
      const arrivalAt = performance.now();
      try {
        const payload = JSON.parse(event.data);
        const responseText = event.data as string;
        recordNetworkArrival(arrivalAt, true);
        data && (data.live_network.stream_state = 'SSE');
        liveApplyQueue = liveApplyQueue
          .then(() => applyLivePayload(payload, responseText, null))
          .catch((error) => console.warn('Live map event update failed:', error));
        void measureNetworkRtt();
      } catch (error) {
        console.warn('Invalid live map event:', error);
      }
    };
    stream.onerror = () => {
      liveStreamConnected = false;
      if (data) {
        data.live_network = { ...(data.live_network || {}), stream_state: 'Переподключение' };
      }
      scheduleLiveRefresh();
    };
  }
  function updateLiveStreamCadence(): void {
    const closeUp = scale > fitScale * ANIMATED_MARKER_ZOOM_THRESHOLD;
    const configuredInterval =
      Number(data?.telemetry?.configured_intervals?.browser_live_poll_interval_ms) || 50;
    const overviewInterval =
      Number(data?.telemetry?.configured_intervals?.browser_overview_poll_interval_ms) || 250;
    const desiredInterval = closeUp
      ? configuredInterval
      : Math.max(configuredInterval, overviewInterval);
    const desiredViewportKey = getLiveViewportKey();
    if (
      liveEventSource &&
      (desiredInterval !== liveStreamIntervalMs || desiredViewportKey !== liveSubscriptionKey)
    ) {
      liveEventSource.close();
      liveEventSource = null;
      liveStreamConnected = false;
    }
    connectLiveStream();
  }
  function scheduleLiveRefresh() {
    clearTimeout(livePollTimer);
    if (!mapViewActive || liveStreamConnected) return;
    const closeUp = scale > fitScale * ANIMATED_MARKER_ZOOM_THRESHOLD;
    const configuredInterval =
      Number(data?.telemetry?.configured_intervals?.browser_live_poll_interval_ms) || 50;
    const overviewInterval =
      Number(data?.telemetry?.configured_intervals?.browser_overview_poll_interval_ms) || 250;
    const pollInterval = closeUp
      ? configuredInterval
      : Math.max(configuredInterval, overviewInterval);

    livePollTimer = setTimeout(
      async () => {
        await refreshLive();
        if (liveStreamConnected) return;
        scheduleLiveRefresh();
      },
      Math.max(50, pollInterval),
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
      updateFogCanvas();
    });
    $('map-debug-toggle').addEventListener('change', (event) => {
      debugWindowEnabled = event.currentTarget.checked;
      try {
        localStorage.setItem('terraria-world-map-debug-window', String(debugWindowEnabled));
      } catch {}
      renderScanStatus();
    });
    $('map-render-debug-toggle').checked = renderDebugWindowEnabled;
    $('map-render-debug-toggle').addEventListener('change', (event) => {
      renderDebugWindowEnabled = event.currentTarget.checked;
      try {
        localStorage.setItem('terraria-world-map-render-debug', String(renderDebugWindowEnabled));
      } catch {}
      renderDebugPanel?.setEnabled(renderDebugWindowEnabled);
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
    resizeViewport,
    renderVisibleChunks: scheduleViewportLayerUpdate,
    downloadMapImage,
  });
  viewportController.bind();
  refresh(true)
    .then(() => refreshLive())
    .then(() => {
      connectLiveStream();
      scheduleRefresh();
      scheduleLiveRefresh();
    });
  window.addEventListener('terraria:view-change', (event) => {
    mapViewActive = (event as CustomEvent<{ view?: string }>).detail?.view === 'map';
    clearTimeout(pollTimer);
    clearTimeout(livePollTimer);
    if (!mapViewActive) {
      liveEventSource?.close();
      liveEventSource = null;
      liveStreamConnected = false;
    }
    if (mapViewActive) {
      connectLiveStream();
      refresh(false)
        .then(() => refreshLive())
        .finally(() => {
          scheduleRefresh();
          scheduleLiveRefresh();
        });
    }
  });
})();
