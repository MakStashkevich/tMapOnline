import { MapActionMenu, type MapAction, type MapCategory } from './components/map-action-menu';
import { PixelModal } from './components/pixel-modal';
import { createMapDisplaySettingsPanel } from './components/map-display-settings';
import type { SectionModule, SectionView } from './core/viewer-types';

type SiteConfig = { sections?: Partial<Record<SectionView, boolean>> };
type SectionContent = { root: HTMLElement; title: string; dataRoot: HTMLElement };

const sections: Record<SectionView, { title: string; loader: () => Promise<SectionModule> }> = {
  world: { title: 'Данные мира', loader: () => import('./sections/world') },
  players: { title: 'Игроки и маршруты', loader: () => import('./sections/players') },
  bosses: { title: 'Победы над боссами', loader: () => import('./sections/bosses') },
  server: { title: 'Состояние сервера', loader: () => import('./sections/server') },
  activity: { title: 'События и нагрузка', loader: () => import('./sections/activity') },
};

const categories: MapCategory[] = [
  {
    id: 'players',
    label: 'Игроки',
    icon: 'player',
    actions: [{ id: 'players', label: 'Игроки и маршруты', icon: 'player', view: 'players' }],
  },
  {
    id: 'world',
    label: 'Мир',
    icon: 'world',
    actions: [
      { id: 'world', label: 'Данные мира', icon: 'world', view: 'world' },
      { id: 'bosses', label: 'Прогресс боссов', icon: 'bosses', view: 'bosses' },
    ],
  },
  {
    id: 'server',
    label: 'Сервер',
    icon: 'server',
    actions: [
      { id: 'server', label: 'Состояние сервера', icon: 'server', view: 'server' },
      { id: 'activity', label: 'События и нагрузка', icon: 'activity', view: 'activity' },
    ],
  },
  {
    id: 'debug',
    label: 'Отладка',
    icon: 'debug',
    actions: [{ id: 'debug', label: 'Диагностика карты', icon: 'debug', view: 'debug' }],
  },
  {
    id: 'settings',
    label: 'Настройки карты',
    icon: 'settings',
    actions: [{ id: 'display-settings', label: 'Слои и движение карты', icon: 'settings' }],
  },
];

class TMapOnlineApplication {
  private readonly modal = new PixelModal();
  private readonly menu: MapActionMenu;
  private readonly sectionModules = new Map<SectionView, SectionModule>();
  private readonly contents = new Map<SectionView, SectionContent>();

  constructor() {
    this.menu = new MapActionMenu((action, trigger) => void this.openAction(action, trigger));
  }

  async start(): Promise<void> {
    const availableCategories = await this.availableCategories();
    this.menu.render(availableCategories);
  }

  private async availableCategories(): Promise<MapCategory[]> {
    let config: SiteConfig = {};
    try {
      const response = await fetch('/api/site-config', { cache: 'no-store' });
      if (response.ok) config = (await response.json()) as SiteConfig;
    } catch {
      /* Keep default actions available if the optional config endpoint is offline. */
    }

    const enabled = (view: SectionView): boolean => config.sections?.[view] !== false;
    return categories
      .map((category) => ({
        ...category,
        actions: category.actions.filter((action) =>
          action.view === 'debug'
            ? /^\/debug\/?$/.test(location.pathname)
            : enabled(action.view as SectionView),
        ),
      }))
      .filter((category) => category.actions.length > 0);
  }

  private async openAction(action: MapAction, trigger: HTMLElement): Promise<void> {
    if (action.id === 'display-settings') {
      this.modal.open('Настройки карты', createMapDisplaySettingsPanel(), trigger);
      return;
    }
    if (action.view === 'debug') {
      window.dispatchEvent(new Event('terraria:open-debug-settings'));
      return;
    }
    const view = action.view as SectionView;
    try {
      const content = await this.loadSection(view);
      this.modal.open(content.title, content.root, trigger);
      window.dispatchEvent(new CustomEvent('terraria:view-change', { detail: { view: 'map' } }));
    } catch (error) {
      const panel = document.createElement('p');
      panel.className = 'section-error';
      panel.textContent = `Не удалось загрузить раздел: ${error instanceof Error ? error.message : String(error)}`;
      this.modal.open(sections[view].title, panel, trigger);
    }
  }

  private async loadSection(view: SectionView): Promise<SectionContent> {
    const cached = this.contents.get(view);
    if (cached) {
      await this.sectionModules.get(view)?.mount(cached.dataRoot);
      return cached;
    }
    await this.loadSectionStyle(view);
    const module = this.sectionModules.get(view) ?? (await sections[view].loader());
    this.sectionModules.set(view, module);
    const root = document.createElement('div');
    root.className = `section-content section-${view}`;
    const sectionContent = document.createElement('div');
    sectionContent.className = 'section-data-content';
    root.append(sectionContent);
    await module.mount(sectionContent);
    const content = { root, title: sections[view].title, dataRoot: sectionContent };
    this.contents.set(view, content);
    return content;
  }

  private async loadSectionStyle(view: SectionView): Promise<void> {
    if (document.querySelector(`link[data-section-style="${view}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `/assets/sections/${view}.css`;
    link.dataset.sectionStyle = view;
    document.head.append(link);
    await new Promise<void>((resolve, reject) => {
      link.onload = () => resolve();
      link.onerror = () => {
        link.remove();
        reject(new Error(`Не удалось загрузить стили: ${view}`));
      };
    });
  }
}

void new TMapOnlineApplication().start();
