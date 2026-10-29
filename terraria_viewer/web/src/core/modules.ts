type FeaturePage = 'world_map';
type FeatureMap = Record<string, string[]>;
type SiteConfig = { modules?: Record<string, boolean> };

const targets: Record<FeaturePage, FeatureMap> = {
  world_map: {
    'world_map.exploration': ['#chunk-layer'],
    'world_map.routes': ['#paths'],
    'world_map.players': ['#players', '#markers'],
    'world_map.entities': ['#entities'],
    'world_map.coins': ['#coins'],
    'world_map.pylons': ['#pylons'],
    'world_map.spawn': ['#spawn'],
    'world_map.debug': ['#map-settings-button', '#map-settings', '#map-debug-window'],
    'world_map.tooltips': ['#map-tooltip'],
  },
};

export async function activateModules(page: FeaturePage): Promise<Record<string, boolean>> {
  let config: SiteConfig;
  try {
    const response = await fetch('/api/site-config', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    config = (await response.json()) as SiteConfig;
  } catch {
    config = { modules: {} };
  }

  const enabled: Record<string, boolean> = {};
  for (const [name, selectors] of Object.entries(targets[page])) {
    enabled[name] = config.modules?.[name] !== false;
    if (enabled[name]) continue;
    for (const selector of selectors) {
      document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
        element.hidden = true;
      });
    }
  }
  document.documentElement.dataset.page = page;
  return enabled;
}
