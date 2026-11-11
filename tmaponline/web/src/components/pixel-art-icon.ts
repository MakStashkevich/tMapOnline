const iconFiles = {
  player: 'icon_profile.png',
  world: 'icon_map.png',
  server: 'icon_controller.png',
  debug: 'icon_search.png',
  settings: 'icon_gear.png',
  routes: 'icon_party.png',
  bosses: 'icon_trophy.png',
  activity: 'icon_bell.png',
} as const;

export type PixelArtIconName = keyof typeof iconFiles;

export function createPixelArtIcon(name: PixelArtIconName): HTMLImageElement {
  const icon = document.createElement('img');
  icon.className = 'pixel-art-icon';
  icon.src = `/assets/ui/larchrow/icons/${iconFiles[name]}`;
  icon.alt = '';
  icon.setAttribute('aria-hidden', 'true');
  icon.decoding = 'async';
  return icon;
}
