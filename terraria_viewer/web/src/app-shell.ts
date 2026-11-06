import type { SectionModule, SectionView, View } from './core/viewer-types';
import { renderIcons, setIcon } from './core/icons';

type ViewConfig = { title: string; description: string };
type SiteConfig = { sections?: Partial<Record<SectionView, boolean>> };

class ViewerApplication {
  private readonly views: Record<View, ViewConfig> = {
    map: { title: 'Карта мира', description: 'Карта исследования и текущее состояние мира.' },
    world: {
      title: 'Данные карты',
      description: 'Исследование мира, сканирование и объекты карты.',
    },
    players: { title: 'Игроки', description: 'Онлайн, история игроков и игровые сессии.' },
    bosses: {
      title: 'Боссы',
      description: 'Активные боссы мира. Нажмите, чтобы открыть страницу Terraria Wiki.',
    },
    server: { title: 'Сервер', description: 'Состояние Terraria, туннеля и соединения.' },
    activity: {
      title: 'Нагрузка и события',
      description: 'Ресурсы компьютера, доступность и журнал событий.',
    },
  };

  private readonly sectionLoaders: Record<SectionView, () => Promise<SectionModule>> = {
    world: () => import('./sections/world'),
    players: () => import('./sections/players'),
    bosses: () => import('./sections/bosses'),
    server: () => import('./sections/server'),
    activity: () => import('./sections/activity'),
  };

  private readonly sectionModules = new Map<SectionView, SectionModule>();
  private currentView: View = 'map';
  private sectionRequest = 0;

  private element<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Required page element is missing: #${id}`);
    return element as T;
  }

  start(): void {
    renderIcons();
    this.applySavedTheme();
    this.bindNavigation();
    this.loadEnabledSections();
    void this.openView(this.currentView);
  }

  private applySavedTheme(): void {
    let savedTheme: string | null = null;
    try {
      savedTheme = localStorage.getItem('terraria-viewer-theme');
    } catch {
      // Storage may be disabled; the page still works with its default theme.
    }
    this.applyTheme(savedTheme);
  }

  private applyTheme(theme: string | null): void {
    const selectedTheme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = selectedTheme;

    try {
      localStorage.setItem('terraria-viewer-theme', selectedTheme);
    } catch {
      // Keep the selected theme for this page load even when persistence is unavailable.
    }

    const themeButton = this.element('theme-toggle');
    setIcon(themeButton, selectedTheme === 'dark' ? 'Sun' : 'Moon');
    themeButton.setAttribute(
      'aria-label',
      selectedTheme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему',
    );
  }

  private bindNavigation(): void {
    this.element('theme-toggle').addEventListener('click', () => {
      const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      this.applyTheme(nextTheme);
    });
    this.element('sidebar-toggle').addEventListener('click', () => {
      this.setDrawer(!document.body.classList.contains('drawer-open'));
    });
    this.element('section-menu-toggle').addEventListener('click', () => this.setDrawer(true));
    this.element('sidebar-close').addEventListener('click', () => this.setDrawer(false));
    this.element('sidebar-backdrop').addEventListener('click', () => this.setDrawer(false));

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && document.body.classList.contains('drawer-open')) {
        this.setDrawer(false);
      }
    });

    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
      button.addEventListener('click', () => {
        const view = button.dataset.view as View;
        if (view in this.views) void this.openView(view);
      });
    });
  }

  private setDrawer(open: boolean): void {
    const drawer = this.element('map-sidebar');
    const backdrop = this.element('sidebar-backdrop');
    const toggleButton = this.element('sidebar-toggle');

    document.body.classList.toggle('drawer-open', open);
    drawer.inert = !open;
    drawer.setAttribute('aria-hidden', String(!open));
    toggleButton.setAttribute('aria-expanded', String(open));
    backdrop.hidden = !open;
  }

  private async loadSectionStyle(section: SectionView): Promise<void> {
    const existingStyle = document.querySelector<HTMLLinkElement>(
      `link[data-section-style="${section}"]`,
    );
    if (existingStyle) return;

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `/assets/sections/${section}.css`;
    link.dataset.sectionStyle = section;
    document.head.append(link);

    await new Promise<void>((resolve, reject) => {
      link.onload = () => resolve();
      link.onerror = () => {
        link.remove();
        reject(new Error(`Could not load styles for the ${section} section`));
      };
    });
  }

  private async openView(view: View): Promise<void> {
    this.currentView = view;
    this.setDrawer(false);
    this.updateNavigationState(view);
    this.updatePageVisibility(view);
    window.dispatchEvent(new CustomEvent('terraria:view-change', { detail: { view } }));

    if (view === 'map') return;

    this.showSectionLoading(view);
    const requestId = ++this.sectionRequest;

    try {
      await this.loadSectionStyle(view);
      const section = await this.loadSection(view);
      if (requestId === this.sectionRequest) {
        await section.mount(this.element('section-content'));
      }
    } catch (error) {
      if (requestId === this.sectionRequest) this.showSectionError(view, error);
    }
  }

  private updateNavigationState(view: View): void {
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
      const isActive = button.dataset.view === view;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-current', isActive ? 'page' : 'false');
    });
  }

  private updatePageVisibility(view: View): void {
    const showingMap = view === 'map';
    this.element('map-pane').hidden = !showingMap;
    this.element('section-pane').hidden = showingMap;
    document.body.classList.toggle('section-view', !showingMap);
  }

  private showSectionLoading(view: SectionView): void {
    const viewConfig = this.views[view];
    this.element('section-title').textContent = viewConfig.title;
    this.element('section-description').textContent = viewConfig.description;

    const loadingMessage = document.createElement('div');
    loadingMessage.className = 'section-loading';
    loadingMessage.textContent = 'Загружаю данные…';
    this.element('section-content').replaceChildren(loadingMessage);
  }

  private async loadSection(view: SectionView): Promise<SectionModule> {
    const cachedSection = this.sectionModules.get(view);
    if (cachedSection) return cachedSection;

    const loadedSection = await this.sectionLoaders[view]();
    this.sectionModules.set(view, loadedSection);
    return loadedSection;
  }

  private showSectionError(view: SectionView, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const panel = document.createElement('div');
    panel.className = 'section-error';
    panel.textContent = `Не удалось загрузить раздел: ${message}`;

    const retryButton = document.createElement('button');
    retryButton.className = 'tool';
    retryButton.innerHTML =
      '<i data-lucide="activity" class="ui-icon" aria-hidden="true"></i><span>Повторить</span>';
    renderIcons(retryButton);
    retryButton.addEventListener('click', () => void this.openView(view));
    panel.append(retryButton);

    this.element('section-content').replaceChildren(panel);
  }

  private async loadEnabledSections(): Promise<void> {
    try {
      const response = await fetch('/api/site-config', { cache: 'no-store' });
      if (!response.ok) return;

      const config = (await response.json()) as SiteConfig;
      document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
        const view = button.dataset.view;
        if (view && view !== 'map' && config.sections?.[view as SectionView] === false) {
          button.hidden = true;
        }
      });
    } catch {
      // Keep configured sections visible when the optional config endpoint is unavailable.
    }
  }
}

new ViewerApplication().start();
