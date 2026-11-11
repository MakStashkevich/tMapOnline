const duration = (value) => {
  let seconds = Math.floor(Number(value) || 0);
  const d = Math.floor(seconds / 86400),
    h = Math.floor((seconds % 86400) / 3600),
    m = Math.floor((seconds % 3600) / 60);
  return `${d ? `${d} д ` : ''}${h} ч ${m} мин`;
};
const metric = (label, value, detail = '') => {
  const card = document.createElement('article');
  card.className = 'metric-card';
  const title = document.createElement('span');
  title.textContent = label;
  const strong = document.createElement('strong');
  strong.textContent = value;
  card.append(title, strong);
  if (detail) {
    const note = document.createElement('small');
    note.textContent = detail;
    card.append(note);
  }
  return card;
};
export async function mount(root: HTMLElement): Promise<void> {
  const response = await fetch('/api/section-data?section=server', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json(),
    server = data.server || {},
    info = data.server_info || {},
    metrics = data.host_metrics || {};
  root.replaceChildren();
  const grid = document.createElement('div');
  grid.className = 'metric-grid';
  grid.append(
    metric(
      'Terraria',
      server.running ? 'Работает' : 'Остановлена',
      server.listening ? 'Порт принимает подключения' : 'Порт пока недоступен',
    ),
    metric(
      'Игроки онлайн',
      String(server.players_online ?? 0),
      (server.player_names || []).join(', ') || 'Сейчас никто не играет',
    ),
    metric('Время работы', duration(server.uptime_seconds)),
    metric(
      'CPU',
      metrics.cpu_percent == null ? 'Нет данных' : `${Number(metrics.cpu_percent).toFixed(1)}%`,
    ),
    metric(
      'Память',
      metrics.memory_mb == null
        ? 'Нет данных'
        : `${(Number(metrics.memory_mb) / 1024).toFixed(1)} ГБ`,
    ),
    metric(
      'Размер данных Terraria',
      metrics.terraria_disk_gb == null
        ? 'Нет данных'
        : `${Number(metrics.terraria_disk_gb).toFixed(2)} ГБ`,
    ),
    metric(
      'Телеметрия',
      info.telemetry_connected ? 'Подключена' : 'Нет связи',
      info.telemetry_updated_at
        ? `Обновлено ${new Date(Number(info.telemetry_updated_at) * 1000).toLocaleTimeString('ru-RU')}`
        : '',
    ),
  );
  root.append(grid);
  const section = document.createElement('section');
  section.className = 'section-block';
  const heading = document.createElement('h3');
  heading.textContent = 'Игровой сервер';
  section.append(heading);
  const dl = document.createElement('dl');
  dl.className = 'detail-list';
  for (const [key, value] of [
    ['Порт игры', info.port],
    ['Мир', info.world],
    [
      'Размер карты',
      info.world_width && info.world_height
        ? `${info.world_width} × ${info.world_height} тайлов`
        : null,
    ],
    ['Версия Terraria', info.version],
  ]) {
    const row = document.createElement('div'),
      dt = document.createElement('dt'),
      dd = document.createElement('dd');
    dt.textContent = key;
    dd.textContent = value == null || value === '' ? '—' : String(value);
    row.append(dt, dd);
    dl.append(row);
  }
  section.append(dl);
  root.append(section);
}
