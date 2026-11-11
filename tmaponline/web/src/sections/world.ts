const row = (label, value) => {
  const item = document.createElement('div'),
    dt = document.createElement('dt'),
    dd = document.createElement('dd');
  dt.textContent = label;
  dd.textContent = value == null || value === '' ? '—' : String(value);
  item.append(dt, dd);
  return item;
};
export async function mount(root: HTMLElement): Promise<void> {
  const response = await fetch('/api/section-data?section=world', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()).world_map || {},
    world = data.world || {},
    scan = data.scan || {};
  root.replaceChildren();
  const metrics = document.createElement('div');
  metrics.className = 'metric-grid';
  for (const [label, value] of [
    ['Пилоны', data.pylons],
    ['NPC и боссы на карте', data.entities],
    ['Монеты на земле', data.coins],
  ]) {
    const card = document.createElement('article');
    card.className = 'metric-card';
    const title = document.createElement('span');
    title.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = String(value ?? 0);
    card.append(title, strong);
    metrics.append(card);
  }
  root.append(metrics);
  const section = document.createElement('section');
  section.className = 'section-block';
  const heading = document.createElement('h3');
  heading.textContent = 'Мир и сканирование';
  section.append(heading);
  const details = document.createElement('dl');
  details.className = 'detail-list';
  details.append(
    row('Мир', world.name),
    row(
      'Размер',
      world.width && world.height
        ? `${Number(world.width).toLocaleString('ru-RU')} × ${Number(world.height).toLocaleString('ru-RU')} тайлов`
        : null,
    ),
    row('Открыто картой', scan.percent == null ? null : `${Number(scan.percent).toFixed(1)}%`),
    row(
      'Участки обработаны',
      scan.totalChunks == null
        ? null
        : `${Number(scan.scannedChunks || 0).toLocaleString('ru-RU')} / ${Number(scan.totalChunks).toLocaleString('ru-RU')}`,
    ),
    row(
      'Осталось',
      scan.remainingChunks == null ? null : Number(scan.remainingChunks).toLocaleString('ru-RU'),
    ),
    row(
      'Ошибки сканирования',
      scan.failedChunks == null ? null : Number(scan.failedChunks).toLocaleString('ru-RU'),
    ),
    row(
      'Состояние',
      scan.complete
        ? 'Сканирование завершено'
        : scan.active
          ? 'Идёт сканирование'
          : scan.stale
            ? 'Данные сканера устарели'
            : 'Ожидание телеметрии',
    ),
  );
  section.append(details);
  if (scan.percent != null) {
    const track = document.createElement('div');
    track.className = 'world-progress';
    const bar = document.createElement('span');
    bar.style.width = `${Math.max(0, Math.min(100, Number(scan.percent)))}%`;
    track.append(bar);
    section.append(track);
  }
  root.append(section);
}
