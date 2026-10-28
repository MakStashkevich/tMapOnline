type ScanSnapshot = {
  scannedChunks?: number;
  attemptedChunks?: number;
  totalChunks?: number;
  remainingChunks?: number;
  failedChunks?: number;
  percent?: number;
  active?: boolean;
  complete?: boolean;
  stale?: boolean;
  telemetryAgeSeconds?: number;
  worldId?: number;
  worldName?: string;
  width?: number;
  height?: number;
};

/** Renders scanner diagnostics without coupling them to map rendering state. */
export class MapDiagnosticsPanel {
  constructor(private readonly enabled: boolean) {}

  render(
    data: any,
    exploredPercent: number,
    fullMapEnabled: boolean,
    debugWindowEnabled: boolean,
  ): void {
    if (!this.enabled) return;

    const scan: ScanSnapshot | undefined = data?.scan;
    const progress = document.getElementById('scan-progress');
    const progressBar = document.getElementById('scan-progress-bar');
    const cache = document.getElementById('scan-cache');
    const fullMapToggle = document.getElementById('full-map-toggle') as HTMLInputElement | null;
    const debugToggle = document.getElementById('map-debug-toggle') as HTMLInputElement | null;

    if (progress && progressBar) {
      if (!scan || !scan.totalChunks) {
        progress.textContent = 'Сканер пока не передал состояние.';
        progressBar.style.width = '0%';
      } else {
        const scanned = Number(scan.scannedChunks || 0);
        const total = Number(scan.totalChunks || 0);
        const remaining = Number(scan.remainingChunks || 0);
        const percent = Math.max(0, Math.min(100, Number(scan.percent || 0)));
        const state = scan.stale
          ? 'Нет свежей телеметрии от сервера'
          : scan.complete
            ? 'Сканирование завершено'
            : scan.active
              ? 'Сканирование идёт'
              : 'Сканирование приостановлено';
        progress.textContent = `${state}: ${scanned.toLocaleString('ru-RU')} из ${total.toLocaleString('ru-RU')} участков (${percent}%). Осталось ${remaining.toLocaleString('ru-RU')}.`;
        if (scan.stale && Number.isFinite(Number(scan.telemetryAgeSeconds))) {
          progress.textContent += ` Последний снимок ${Number(scan.telemetryAgeSeconds).toLocaleString('ru-RU')} сек. назад.`;
        }
        if (Number(scan.failedChunks || 0) > 0) {
          progress.textContent += ` Ошибок: ${Number(scan.failedChunks).toLocaleString('ru-RU')}.`;
        }
        progressBar.style.width = `${percent}%`;
      }
    }

    if (cache) {
      cache.textContent = `В кэше веба: ${(data?.base_chunks || []).length.toLocaleString('ru-RU')} участков карты`;
    }
    if (fullMapToggle) fullMapToggle.checked = fullMapEnabled;
    if (debugToggle) debugToggle.checked = debugWindowEnabled;
    this.renderDebugWindow(data, exploredPercent, fullMapEnabled, debugWindowEnabled);
  }

  private renderDebugWindow(
    data: any,
    exploredPercent: number,
    fullMapEnabled: boolean,
    enabled: boolean,
  ): void {
    const panel = document.getElementById('map-debug-window');
    if (!(panel instanceof HTMLElement)) return;

    panel.hidden = !enabled;
    if (panel.hidden) return;

    const world = data?.world || {};
    const scan: ScanSnapshot = data?.scan || {};
    const players = data?.players || [];
    const mapWidth = Number(world.width || scan.width || 0);
    const mapHeight = Number(world.height || scan.height || 0);
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
}
