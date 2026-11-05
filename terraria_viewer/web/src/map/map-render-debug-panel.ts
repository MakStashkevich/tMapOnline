type RenderMetrics = {
  visibleCanvases: number;
  lastRenderDurationMs: number;
  lastRenderChunkCount: number;
  rendering: boolean;
  canvasBytes: number;
  decodedChunkCount: number;
  decodedBitmapBytes?: number;
  bitmapCacheHits?: number;
  bitmapCacheMisses?: number;
  sharedTileLoads?: number;
  bitmapCacheEvictions?: number;
  pendingTileLoads?: number;
  failedRenderCount?: number;
  extraCanvasBytes: number;
  spawnMarkerVisible: boolean;
};

type TileCacheMetrics = {
  entries?: number;
  bytes?: number;
  byte_limit?: number;
  hits?: number;
  misses?: number;
  evictions?: number;
  renders?: number;
  last_render_ms?: number;
  disk_entries?: number;
  disk_bytes?: number;
  disk_byte_limit?: number;
  disk_hits?: number;
  disk_misses?: number;
  disk_evictions?: number;
};

type DebugChunk = { data?: string | null };
type DebugPlayer = {
  chunks?: DebugChunk[];
  positions?: unknown[];
  online?: boolean;
  position?: { tileX?: number; tileY?: number };
};
type DebugMapData = {
  base_chunks?: DebugChunk[];
  players?: DebugPlayer[];
  active_npcs?: unknown[];
  coins?: unknown[];
  pylons?: unknown[];
  telemetry?: {
    interval_ms?: number | null;
    age_seconds?: number | null;
    configured_intervals?: Record<string, number>;
  };
  tile_cache?: TileCacheMetrics;
  live_payload_bytes?: number;
  live_render_ms?: number;
  live_request_ms?: number;
  live_network?: {
    stream_state?: string;
    rtt_p50_ms?: number;
    rtt_p95_ms?: number;
    arrival_p50_ms?: number;
    arrival_p95_ms?: number;
    interpolation_delay_ms?: number;
  };
  world?: { width?: number; height?: number; spawn_x?: number; spawn_y?: number };
};

type BrowserMemory = Performance & {
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
};

/** Reports browser-side map rendering load, separately from server scanning. */
export class MapRenderDebugPanel {
  private enabled = false;
  private animationFrame: number | null = null;
  private observer: PerformanceObserver | null = null;
  private lastFrameAt = 0;
  private sampleStartedAt = 0;
  private sampleFrameCount = 0;
  private sampleFrameTimeMs = 0;
  private slowFrameCount = 0;
  private longTaskCount = 0;
  private longTaskTimeMs = 0;
  private longTaskMetricsAvailable = false;
  private data: DebugMapData | null = null;

  constructor(
    private readonly panel: HTMLElement,
    private readonly getRenderMetrics: () => RenderMetrics,
  ) {}

  setData(data: DebugMapData | null): void {
    this.data = data;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.panel.hidden = !enabled;

    if (enabled) {
      this.sampleStartedAt = performance.now();
      this.lastFrameAt = 0;
      this.startLongTaskObserver();
      this.animationFrame = requestAnimationFrame(this.sampleFrame);
      this.renderPanel();
      return;
    }

    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.observer?.disconnect();
    this.observer = null;
  }

  private readonly sampleFrame = (timestamp: number): void => {
    if (!this.enabled) return;

    if (this.lastFrameAt > 0) {
      const frameTime = timestamp - this.lastFrameAt;
      this.sampleFrameCount += 1;
      this.sampleFrameTimeMs += frameTime;
      if (frameTime > 33.3) this.slowFrameCount += 1;
    }
    this.lastFrameAt = timestamp;

    if (timestamp - this.sampleStartedAt >= 1000) {
      this.renderPanel(timestamp);
      this.sampleStartedAt = timestamp;
      this.sampleFrameCount = 0;
      this.sampleFrameTimeMs = 0;
      this.slowFrameCount = 0;
      this.longTaskCount = 0;
      this.longTaskTimeMs = 0;
    }

    this.animationFrame = requestAnimationFrame(this.sampleFrame);
  };

  private renderPanel(now = performance.now()): void {
    const duration = Math.max(1, now - this.sampleStartedAt);
    const fps = Math.round((this.sampleFrameCount * 1000) / duration);
    const averageFrameMs = this.sampleFrameCount
      ? this.sampleFrameTimeMs / this.sampleFrameCount
      : 0;
    const slowPercent = this.sampleFrameCount
      ? Math.round((this.slowFrameCount / this.sampleFrameCount) * 100)
      : 0;
    const render = this.getRenderMetrics();
    const data = this.data;
    const players = data?.players || [];
    const baseChunkCount = data?.base_chunks?.length || 0;
    const playerChunkCount = players.reduce(
      (total, player) => total + (player.chunks?.length || 0),
      0,
    );
    const routePointCount = players.reduce(
      (total, player) => total + (player.positions?.length || 0),
      0,
    );
    const chunkPayloadBytes = this.estimateEncodedChunkBytes(data);
    const memory = (performance as BrowserMemory).memory;
    const memoryValue = memory
      ? `${this.formatBytes(memory.usedJSHeapSize)} / ${this.formatBytes(memory.jsHeapSizeLimit)}`
      : 'Недоступно';
    const world = data?.world;
    const escapeHtml = (value: string): string =>
      value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    const card = (label: string, value: string, detail = '') => `
      <div class="render-debug-card">
        <span class="render-debug-label">${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        ${detail ? `<small>${escapeHtml(detail)}</small>` : ''}
      </div>`;
    const row = (label: string, value: string) => `
      <div class="render-debug-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;

    this.panel.innerHTML = `
      <header class="render-debug-heading">
        <strong>Рендер карты</strong>
        <span class="render-debug-live">LIVE</span>
      </header>
      <div class="render-debug-section-title">Производительность</div>
      <div class="render-debug-grid">
        ${card('Частота кадров', `${fps} FPS`, `Кадр ${averageFrameMs.toFixed(1)} мс`)}
        ${card('Медленные кадры', `${slowPercent}%`, 'Дольше 33 мс')}
        ${card('Долгие задачи', this.longTaskMetricsAvailable ? String(this.longTaskCount) : '—', this.longTaskMetricsAvailable ? `${this.longTaskTimeMs.toFixed(0)} мс за секунду` : 'Недоступно')}
        ${card('Последний рендер', `${render.lastRenderDurationMs.toFixed(1)} мс`, `${render.lastRenderChunkCount} чанков, ${render.rendering ? 'выполняется' : 'ожидание'}`)}
      </div>
      <div class="render-debug-section-title">Память</div>
      <div class="render-debug-rows">
        ${row('JavaScript', memoryValue)}
        ${row('Холсты карты', `~${this.formatBytes(render.canvasBytes + render.extraCanvasBytes)}`)}
        ${row('Холсты чанков', String(render.visibleCanvases))}
        ${row('Декодированные тайлы', `${render.decodedChunkCount} — ~${this.formatBytes(render.decodedBitmapBytes ?? render.decodedChunkCount * 64 * 64 * 4)}`)}
        ${row('Кэш браузера', `${render.bitmapCacheHits ?? 0} попаданий, ${render.bitmapCacheMisses ?? 0} запросов, ${render.pendingTileLoads ?? 0} ожидает`)}
        ${row('Повторно использовано запросов', String(render.sharedTileLoads ?? 0))}
        ${row('Повторов рендера', String(render.failedRenderCount ?? 0))}
      </div>
      <div class="render-debug-section-title">Карта и слои</div>
      <div class="render-debug-rows">
        ${row('Данные чанков', `${baseChunkCount} базовых, ${playerChunkCount} игрока`)}
        ${row('Объём данных', `~${this.formatBytes(chunkPayloadBytes)}`)}
        ${row('Сущности', `${data?.active_npcs?.length || 0} NPC/боссов, ${data?.pylons?.length || 0} пилонов, ${data?.coins?.length || 0} монет`)}
        ${row('Игроки', `${players.filter((player) => player.online).length} онлайн, ${routePointCount} точек пути`)}
        ${row('Точка появления', `${world?.spawn_x ?? '—'}, ${world?.spawn_y ?? '—'}  ${render.spawnMarkerVisible ? 'спрайт загружен' : 'спрайт отсутствует'}`)}
        ${row('Размер мира', `${world?.width || 0} × ${world?.height || 0}`)}
      </div>`;

    const tileCache = data?.tile_cache;
    this.panel.insertAdjacentHTML(
      'beforeend',
      `<div class="render-debug-section-title">Кэш изображений сервера</div>
      <div class="render-debug-rows">
        ${row('Занято памяти', `${this.formatBytes(tileCache?.bytes || 0)} из ${this.formatBytes(tileCache?.byte_limit || 0)}`)}
        ${row('Тайлы в кэше', `${tileCache?.entries || 0} записей`)}
        ${row('Попадания и промахи', `${tileCache?.hits || 0} и ${tileCache?.misses || 0}`)}
        ${row('Повторные построения', `${tileCache?.renders || 0}, вытеснено ${tileCache?.evictions || 0}`)}
        ${row('Последний рендер тайла', `${(tileCache?.last_render_ms || 0).toFixed(1)} мс`)}
        ${row('Дисковый PNG-кэш', `${this.formatBytes(tileCache?.disk_bytes || 0)} из ${this.formatBytes(tileCache?.disk_byte_limit || 0)}, ${tileCache?.disk_entries || 0} тайлов`)}
        ${row('Диск: попадания / промахи', `${tileCache?.disk_hits || 0} / ${tileCache?.disk_misses || 0}, вытеснено ${tileCache?.disk_evictions || 0}`)}
      </div>`,
    );

    const intervals = data?.telemetry?.configured_intervals || {};
    this.panel.insertAdjacentHTML(
      'beforeend',
      `<div class="render-debug-section-title">Обновления телеметрии</div>
      <div class="render-debug-rows">
        ${row('Канал обновлений', data?.live_network?.stream_state || 'Подключение')}
        ${row('Сетевой RTT', data?.live_network?.rtt_p50_ms == null ? 'Нет данных' : `медиана ${data.live_network.rtt_p50_ms.toFixed(1)} мс, p95 ${(data.live_network.rtt_p95_ms || 0).toFixed(1)} мс`)}
        ${row('Интервал live-событий', data?.live_network?.arrival_p50_ms == null ? 'Нет данных' : `медиана ${data.live_network.arrival_p50_ms.toFixed(1)} мс, p95 ${(data.live_network.arrival_p95_ms || 0).toFixed(1)} мс`)}
        ${row('Буфер интерполяции', data?.live_network?.interpolation_delay_ms == null ? '80 мс' : `${data.live_network.interpolation_delay_ms.toFixed(0)} мс`)}
        ${row('Время HTTP-запроса', data?.live_request_ms == null ? 'SSE' : `${data.live_request_ms.toFixed(1)} мс`)}
        ${row('Получение снимков', data?.telemetry?.interval_ms == null ? 'Нет данных' : `${data.telemetry.interval_ms.toFixed(1)} мс`)}
        ${row('Возраст данных', data?.telemetry?.age_seconds == null ? 'Нет данных' : `${(data.telemetry.age_seconds * 1000).toFixed(0)} мс`)}
        ${row('Позиции игроков', `${intervals.player_position_interval_ticks ?? '—'} тиков`)}
        ${row('NPC и боссы', `${intervals.entity_interval_ticks ?? '—'} тиков`)}
        ${row('Снимок карты', `${intervals.map_capture_interval_ticks ?? '—'} тиков`)}
        ${row('Сканер мира', `${intervals.world_scan_interval_ticks ?? '—'} тиков`)}
        ${row('Пакет для браузера', this.formatBytes(data?.live_payload_bytes || 0))}
        ${row('Перерисовка живых слоёв', `${(data?.live_render_ms || 0).toFixed(1)} мс`)}
      </div>`,
    );
  }

  private startLongTaskObserver(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
      this.longTaskMetricsAvailable = true;
      this.observer = new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
          this.longTaskCount += 1;
          this.longTaskTimeMs += entry.duration;
        }
      });
      this.observer.observe({ type: 'longtask', buffered: false });
    } catch {
      this.observer = null;
    }
  }

  private estimateEncodedChunkBytes(data: DebugMapData | null): number {
    if (!data) return 0;
    let base64Length = 0;
    const countChunk = (chunk: DebugChunk): void => {
      if (typeof chunk.data === 'string') base64Length += chunk.data.length;
    };
    data.base_chunks?.forEach(countChunk);
    data.players?.forEach((player) => player.chunks?.forEach(countChunk));
    return Math.ceil((base64Length * 3) / 4);
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${Math.round(bytes)} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КиБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МиБ`;
  }
}
