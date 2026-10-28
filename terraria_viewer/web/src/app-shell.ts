import type { SectionModule, SectionView, View } from './core/viewer-types';
import { renderIcons, setIcon } from './core/icons';

type ViewConfig = { title: string; description: string };
type SiteConfig = { sections?: Partial<Record<SectionView, boolean>> };

const views: Record<View, ViewConfig> = {
  map: { title: 'Карта мира', description: 'Карта исследования и текущее состояние мира.' },
  world: { title: 'Данные карты', description: 'Исследование мира, сканирование и объекты карты.' },
  players: { title: 'Игроки', description: 'Онлайн, история игроков и игровые сессии.' },
  bosses: { title: 'Боссы и прогресс', description: 'Активные боссы, победы и прогресс мира.' },
  server: { title: 'Сервер', description: 'Состояние Terraria, туннеля и соединения.' },
  activity: {
    title: 'Нагрузка и события',
    description: 'Ресурсы компьютера, доступность и журнал событий.',
  },
};

const sectionLoaders: Record<SectionView, () => Promise<SectionModule>> = {
  world: () => import('./sections/world'),
  players: () => import('./sections/players'),
  bosses: () => import('./sections/bosses'),
  server: () => import('./sections/server'),
  activity: () => import('./sections/activity'),
};
const sectionModules = new Map<SectionView, SectionModule>();
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
renderIcons();
let currentView: View = 'map';
let sectionRequest = 0;

const setDrawer = (open: boolean): void => {
  const drawer = $('map-sidebar');
  const backdrop = $('sidebar-backdrop');
  const button = $('sidebar-toggle');
  document.body.classList.toggle('drawer-open', open);
  drawer.inert = !open;
  drawer.setAttribute('aria-hidden', String(!open));
  button.setAttribute('aria-expanded', String(open));
  backdrop.hidden = !open;
};

const loadSectionStyle = async (name: SectionView): Promise<void> => {
  const existing = document.querySelector<HTMLLinkElement>(`link[data-section-style="${name}"]`);
  if (existing) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `/assets/sections/${name}.css`;
  link.dataset.sectionStyle = name;
  document.head.append(link);
  await new Promise<void>((resolve, reject) => {
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      reject(new Error('Не удалось загрузить стили раздела'));
    };
  });
};

const openView = async (view: View): Promise<void> => {
  currentView = view;
  setDrawer(false);
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((item) => {
    const active = item.dataset.view === view;
    item.classList.toggle('active', active);
    item.setAttribute('aria-current', active ? 'page' : 'false');
  });

  const isMap = view === 'map';
  $('map-pane').hidden = !isMap;
  $('section-pane').hidden = isMap;
  document.body.classList.toggle('section-view', !isMap);
  window.dispatchEvent(
    new CustomEvent<{ view: View }>('terraria:view-change', { detail: { view } }),
  );
  if (isMap) return;

  const viewConfig = views[view];
  $('section-title').textContent = viewConfig.title;
  $('section-description').textContent = viewConfig.description;
  const content = $('section-content');
  const requestId = ++sectionRequest;
  const loading = document.createElement('div');
  loading.className = 'section-loading';
  loading.textContent = 'Загружаю данные…';
  content.replaceChildren(loading);

  try {
    await loadSectionStyle(view);
    let section = sectionModules.get(view);
    if (!section) {
      section = await sectionLoaders[view]();
      sectionModules.set(view, section);
    }
    if (requestId === sectionRequest) await section.mount(content);
  } catch (error) {
    if (requestId !== sectionRequest) return;
    content.replaceChildren();
    const panel = document.createElement('div');
    panel.className = 'section-error';
    panel.textContent = `Не удалось загрузить раздел: ${error instanceof Error ? error.message : String(error)}`;
    const retry = document.createElement('button');
    retry.className = 'tool';
    retry.innerHTML =
      '<i data-lucide="activity" class="ui-icon" aria-hidden="true"></i><span>Повторить</span>';
    renderIcons(retry);
    retry.addEventListener('click', () => void openView(view));
    panel.append(retry);
    content.append(panel);
  }
};

const applyTheme = (theme: string | null): void => {
  const selected = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = selected;
  try {
    localStorage.setItem('terraria-viewer-theme', selected);
  } catch {
    /* Storage can be disabled. */
  }
  setIcon($('theme-toggle'), selected === 'dark' ? 'Sun' : 'Moon');
  $('theme-toggle').setAttribute(
    'aria-label',
    selected === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему',
  );
};

try {
  applyTheme(localStorage.getItem('terraria-viewer-theme'));
} catch {
  applyTheme('dark');
}
$('theme-toggle').addEventListener('click', () =>
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'),
);
$('sidebar-toggle').addEventListener('click', () =>
  setDrawer(!document.body.classList.contains('drawer-open')),
);
$('section-menu-toggle').addEventListener('click', () => setDrawer(true));
$('sidebar-close').addEventListener('click', () => setDrawer(false));
$('sidebar-backdrop').addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('drawer-open')) setDrawer(false);
});
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((item) => {
  item.addEventListener('click', () => {
    const view = item.dataset.view as View;
    if (view in views) void openView(view);
  });
});

fetch('/api/site-config', { cache: 'no-store' })
  .then((response) => (response.ok ? (response.json() as Promise<SiteConfig>) : null))
  .then((config) => {
    if (!config) return;
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((item) => {
      const view = item.dataset.view;
      if (view && view !== 'map' && config.sections?.[view as SectionView] === false)
        item.hidden = true;
    });
  })
  .catch(() => undefined);

void openView(currentView);
