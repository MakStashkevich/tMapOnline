const val = (number, suffix = '') =>
  number == null ? '—' : `${Number(number).toFixed(1)}${suffix}`;

const svgElement = (svg, name, attributes, text = null) => {
  const element = document.createElementNS(svg.namespaceURI, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text != null) element.textContent = text;
  return element;
};

const formatTime = (timestamp) =>
  timestamp == null
    ? ''
    : new Date(Number(timestamp) * 1000).toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      });

const formatOccurrences = (count) => {
  const lastTwo = count % 100;
  const lastDigit = count % 10;
  const noun =
    lastTwo >= 11 && lastTwo <= 14
      ? 'раз'
      : lastDigit === 1
        ? 'раз'
        : lastDigit >= 2 && lastDigit <= 4
          ? 'раза'
          : 'раз';
  return `Повторилась ${count} ${noun}`;
};

function chart(samples, key, color, label) {
  const points = samples
    .map((item) => ({ time: Number(item.time), value: Number(item[key]) }))
    .filter((item) => Number.isFinite(item.time) && Number.isFinite(item.value));
  const values = points.map((item) => item.value);
  const card = document.createElement('article');
  card.className = 'chart-card';
  const title = document.createElement('h3');
  title.textContent = label;
  card.append(title);
  if (points.length < 2) {
    const empty = document.createElement('p');
    empty.textContent = 'Недостаточно измерений';
    card.append(empty);
    return card;
  }
  const width = 720;
  const height = 220;
  const plot = { left: 58, right: 12, top: 14, bottom: 34 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const range = rawMax - rawMin;
  const padding = range > 0 ? range * 0.12 : Math.max(Math.abs(rawMax) * 0.12, 1);
  const min = Math.max(0, rawMin - padding);
  const max = rawMax + padding || 1;
  const span = max - min || 1;
  const coordinates = points.map((point, index) => ({
    x: plot.left + (index * plotWidth) / (points.length - 1),
    y: plot.top + ((max - point.value) * plotHeight) / span,
    ...point,
  }));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const tickCount = 4;
  for (let index = 0; index <= tickCount; index += 1) {
    const fraction = index / tickCount;
    const y = plot.top + fraction * plotHeight;
    const value = max - fraction * span;
    svg.append(
      svgElement(svg, 'line', {
        x1: plot.left,
        x2: width - plot.right,
        y1: y,
        y2: y,
        class: 'chart-grid-line',
      }),
      svgElement(
        svg,
        'text',
        { x: plot.left - 8, y: y + 4, 'text-anchor': 'end', class: 'chart-y-label' },
        val(value, key === 'cpu_percent' ? '%' : ''),
      ),
    );
  }
  svg.append(
    svgElement(svg, 'line', {
      x1: plot.left,
      x2: plot.left,
      y1: plot.top,
      y2: plot.top + plotHeight,
      class: 'chart-axis-line',
    }),
    svgElement(svg, 'line', {
      x1: plot.left,
      x2: width - plot.right,
      y1: plot.top + plotHeight,
      y2: plot.top + plotHeight,
      class: 'chart-axis-line',
    }),
  );
  const linePoints = coordinates.map((point) => `${point.x},${point.y}`).join(' ');
  const area = `${plot.left},${plot.top + plotHeight} ${linePoints} ${width - plot.right},${plot.top + plotHeight}`;
  svg.append(
    svgElement(svg, 'polygon', { points: area, fill: color, class: 'chart-area' }),
    svgElement(svg, 'polyline', { points: linePoints, stroke: color, class: 'chart-line' }),
  );
  for (const point of coordinates)
    svg.append(
      svgElement(svg, 'circle', {
        cx: point.x,
        cy: point.y,
        r: 3.5,
        fill: color,
        class: 'chart-point',
      }),
    );
  const timeIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  for (const index of timeIndexes) {
    const point = coordinates[index];
    svg.append(
      svgElement(
        svg,
        'text',
        {
          x: point.x,
          y: height - 8,
          'text-anchor': index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle',
          class: 'chart-x-label',
        },
        formatTime(point.time),
      ),
    );
  }
  card.append(svg);
  const foot = document.createElement('div');
  foot.className = 'chart-range';
  foot.textContent = `Сейчас: ${val(points.at(-1)?.value, key === 'cpu_percent' ? '%' : '')}`;
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
  for (const event of (data.events || []).slice(0, 50)) {
    const row = document.createElement('article');
    row.className = `event-row ${event.severity || ''}`;
    const meta = document.createElement('div');
    meta.className = 'event-meta';
    const occurrences = Math.max(1, Number(event.occurrences) || 1);
    meta.textContent = `${event.source || 'Событие'} — ${event.time ? new Date(Number(event.time) * 1000).toLocaleString('ru-RU') : '—'}${occurrences > 1 ? ` — ${formatOccurrences(occurrences)}` : ''}`;
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
