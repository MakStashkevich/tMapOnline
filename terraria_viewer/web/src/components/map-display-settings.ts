export type MapDisplaySettings = {
  players: boolean;
  routes: boolean;
  npcs: boolean;
  bosses: boolean;
  movement: boolean;
  interpolationMs: number;
  updateIntervalMs: number;
};

const STORAGE_KEY = 'terraria-world-map-display-settings';
const defaults: MapDisplaySettings = {
  players: true,
  routes: true,
  npcs: true,
  bosses: true,
  movement: true,
  interpolationMs: 160,
  updateIntervalMs: 250,
};

export function readMapDisplaySettings(): MapDisplaySettings {
  try {
    const value = JSON.parse(
      localStorage.getItem(STORAGE_KEY) || '{}',
    ) as Partial<MapDisplaySettings>;
    return {
      players: value.players !== false,
      routes: value.routes !== false,
      npcs: value.npcs !== false,
      bosses: value.bosses !== false,
      movement: value.movement !== false,
      interpolationMs: clamp(value.interpolationMs, 80, 300, defaults.interpolationMs),
      updateIntervalMs: clamp(value.updateIntervalMs, 50, 1000, defaults.updateIntervalMs),
    };
  } catch {
    return { ...defaults };
  }
}

export function createMapDisplaySettingsPanel(): HTMLElement {
  const settings = readMapDisplaySettings();
  const panel = document.createElement('section');
  panel.className = 'map-display-settings';
  panel.setAttribute('aria-label', 'Настройки отображения карты');

  const toggles: Array<
    [keyof Pick<MapDisplaySettings, 'players' | 'routes' | 'npcs' | 'bosses' | 'movement'>, string]
  > = [
    ['players', 'Игроки'],
    ['routes', 'Маршруты игроков'],
    ['npcs', 'Жители и NPC'],
    ['bosses', 'Боссы'],
    ['movement', 'Анимация перемещений'],
  ];
  for (const [key, label] of toggles) {
    const row = document.createElement('label');
    row.className = 'map-setting-toggle';
    const text = document.createElement('span');
    text.textContent = label;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = settings[key];
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      save(settings);
    });
    row.append(text, input);
    panel.append(row);
  }

  addRange(panel, settings, {
    key: 'interpolationMs',
    label: 'Плавность движения',
    min: 80,
    max: 300,
    step: 10,
    format: (value) => `${value} мс`,
  });
  addRange(panel, settings, {
    key: 'updateIntervalMs',
    label: 'Частота обновления карты',
    min: 50,
    max: 1000,
    step: 50,
    format: (value) => `${(1000 / value).toFixed(1)} раза/с`,
  });
  return panel;
}

function addRange(
  panel: HTMLElement,
  settings: MapDisplaySettings,
  options: {
    key: 'interpolationMs' | 'updateIntervalMs';
    label: string;
    min: number;
    max: number;
    step: number;
    format: (value: number) => string;
  },
): void {
  const row = document.createElement('label');
  row.className = 'map-setting-range';
  const header = document.createElement('span');
  header.className = 'map-setting-range-header';
  const title = document.createElement('span');
  title.textContent = options.label;
  const value = document.createElement('output');
  value.textContent = options.format(settings[options.key]);
  header.append(title, value);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step);
  input.value = String(settings[options.key]);
  updateRangeFill(input);
  input.addEventListener('input', () => {
    settings[options.key] = Number(input.value);
    value.textContent = options.format(settings[options.key]);
    updateRangeFill(input);
    save(settings);
  });
  row.append(header, input);
  panel.append(row);
}

function updateRangeFill(input: HTMLInputElement): void {
  const min = Number(input.min);
  const max = Number(input.max);
  const current = Number(input.value);
  const progress = ((current - min) / (max - min)) * 100;
  input.style.setProperty('--range-fill', `${progress}%`);
}

function save(settings: MapDisplaySettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The live map controls still work for this page if browser storage is unavailable.
  }
  window.dispatchEvent(
    new CustomEvent<MapDisplaySettings>('terraria:map-display-settings', {
      detail: { ...settings },
    }),
  );
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
