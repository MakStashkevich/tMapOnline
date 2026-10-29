const val = (number, suffix = '') =>
  number == null ? '—' : `${Number(number).toFixed(1)}${suffix}`;
function chart(samples, key, color, label) {
  const values = samples.map((item) => Number(item[key])).filter(Number.isFinite);
  const card = document.createElement('article');
  card.className = 'chart-card';
  const title = document.createElement('h3');
  title.textContent = label;
  card.append(title);
  if (values.length < 2) {
    const empty = document.createElement('p');
    empty.textContent = 'Недостаточно измерений';
    card.append(empty);
    return card;
  }
  const width = 720,
    height = 160,
    pad = 12,
    min = Math.min(0, ...values),
    max = Math.max(1, ...values),
    span = max - min || 1;
  const points = samples
    .map(
      (item, index) =>
        `${pad + (index * (width - 2 * pad)) / (samples.length - 1)},${height - pad - ((Number(item[key]) - min) * (height - 2 * pad)) / span}`,
    )
    .filter((_, i) => Number.isFinite(Number(samples[i][key])));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const line = document.createElementNS(svg.namespaceURI, 'polyline');
  line.setAttribute('points', points.join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '3');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(line);
  card.append(svg);
  const foot = document.createElement('div');
  foot.className = 'chart-range';
  foot.textContent = `Сейчас: ${val(values.at(-1), key === 'cpu_percent' ? '%' : '')}`;
  card.append(foot);
  return card;
}
export async function mount(root: HTMLElement): Promise<void> {
  const response = await fetch('/api/section-data?section=activity', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  root.replaceChildren();
  const metrics = data.host_metrics || {},
    summary = document.createElement('div');
  summary.className = 'metric-grid';
  for (const [label, value] of [
    ['CPU', val(metrics.cpu_percent, '%')],
    [
      'Память',
      metrics.memory_mb == null ? '—' : `${(Number(metrics.memory_mb) / 1024).toFixed(1)} ГБ`,
    ],
    [
      'Данные Terraria',
      metrics.terraria_disk_gb == null ? '—' : `${Number(metrics.terraria_disk_gb).toFixed(2)} ГБ`,
    ],
  ]) {
    const card = document.createElement('div');
    card.className = 'metric-card';
    const name = document.createElement('span');
    name.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = value;
    card.append(name, strong);
    summary.append(card);
  }
  root.append(summary);
  const history = document.createElement('div');
  history.className = 'chart-grid';
  for (const [key, color, label] of [
    ['cpu_percent', '#64d9a2', 'CPU'],
    ['memory_mb', '#70b7ff', 'Память, МБ'],
    ['terraria_disk_gb', '#eabf67', 'Размер данных Terraria, ГБ'],
  ])
    history.append(chart(data.health || [], key, color, label));
  root.append(history);
  const section = document.createElement('section');
  section.className = 'section-block';
  const heading = document.createElement('h3');
  heading.textContent = 'События и ошибки — 24 часа';
  section.append(heading);
  const events = document.createElement('div');
  events.className = 'event-list';
  for (const event of [...(data.events || [])].reverse()) {
    const row = document.createElement('article');
    row.className = `event-row ${event.severity || ''}`;
    const meta = document.createElement('div');
    meta.className = 'event-meta';
    meta.textContent = `${event.source || 'Событие'} — ${event.time ? new Date(Number(event.time) * 1000).toLocaleString('ru-RU') : '—'}`;
    const message = document.createElement('p');
    message.textContent = event.message || '';
    row.append(meta, message);
    events.append(row);
  }
  if (!events.childElementCount) {
    const empty = document.createElement('div');
    empty.className = 'section-empty';
    empty.textContent = 'За последние сутки событий нет.';
    events.append(empty);
  }
  section.append(events);
  root.append(section);
}
