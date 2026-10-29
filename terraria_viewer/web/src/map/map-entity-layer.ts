import { createOutlinedSprite, loadSprite, playerOutlineColor } from '../core/sprite-renderer';

const PYLON_TYPES: Record<string, string[]> = {
  Purity: ['Пилон леса', '#8be58e', 'Forest'],
  Forest: ['Пилон леса', '#8be58e', 'Forest'],
  Jungle: ['Пилон джунглей', '#75db65', 'Jungle'],
  Hallow: ['Пилон освящения', '#f3a8fa', 'Hallow'],
  Cavern: ['Пилон пещер', '#c5b5ff', 'Cavern'],
  Underground: ['Пилон пещер', '#c5b5ff', 'Cavern'],
  Ocean: ['Пилон океана', '#71d8f0', 'Ocean'],
  Desert: ['Пилон пустыни', '#eacb78', 'Desert'],
  Snow: ['Пилон снежного биома', '#bce8ff', 'Snow'],
  Mushroom: ['Пилон грибного биома', '#83d9d6', 'Mushroom'],
  Universal: ['Универсальный пилон', '#f3eaff', 'Universal'],
  Underworld: ['Пилон преисподней', '#ff916c', 'Underworld'],
  Aether: ['Эфирный пилон', '#9cdbff', 'Aether'],
};

type MapEntityWorld = { width?: number; height?: number; spawn_x?: number; spawn_y?: number };
type MapPlayerMarker = {
  id: string;
  name?: string;
  avatar_url?: string;
  team?: number | null;
  direction?: number | null;
  session_seconds?: number | null;
  position?: { tileX?: number; tileY?: number; x?: number; y?: number };
  positions?: Array<{ x: number; y: number; tileX?: number; tileY?: number }>;
};
type MapNpcMarker = {
  id: number;
  x: number;
  y: number;
  name?: string;
  boss?: boolean;
  icon_url?: string;
  direction?: number | null;
};
type MapCoinMarker = {
  id: number;
  type: number;
  x: number;
  y: number;
  name?: string;
  stack: number;
  icon_url?: string;
};
type MapPylonMarker = { x: number; y: number; type?: string };
type MapDeathMarker = { id: string; name?: string; x: number; y: number; timestamp?: number };

// This is Terraria's native MapDeath texture, drawn directly without extra decoration.
const DEATH_SPRITE = '/assets/map-death.png';

/** Renders map objects as DOM layers while keeping their sprite and fallback rules together. */
export class MapEntityLayer {
  private world: MapEntityWorld = {};
  private spawnRenderKey = '';
  private playerRenderVersion = 0;
  private entityRenderVersion = 0;
  private coinRenderVersion = 0;
  private deathRenderVersion = 0;
  private pylonRenderVersion = 0;
  private spawnRenderVersion = 0;

  constructor(private readonly root: HTMLElement) {}

  setWorld(world: MapEntityWorld): void {
    this.world = world;
  }

  private layer(name: string): HTMLElement {
    const layer = this.root.querySelector<HTMLElement>(`#${name}`);
    if (!layer) throw new Error(`Map layer is missing: #${name}`);
    return layer;
  }

  static pylonDetails(type: string): string[] | undefined {
    return PYLON_TYPES[type];
  }

  markerPosition(player: MapPlayerMarker) {
    const position = player.position || player.positions?.at(-1);
    if (!position) return null;
    const x = Number(position.tileX ?? position.x),
      y = Number(position.tileY ?? position.y);
    return Number.isFinite(x) &&
      Number.isFinite(y) &&
      x >= 0 &&
      y >= 0 &&
      x < this.world.width &&
      y < this.world.height
      ? { x, y }
      : null;
  }
  makeAvatar(player: MapPlayerMarker): HTMLElement {
    const container = document.createElement('span');
    container.className = 'player-toggle-avatar';
    container.setAttribute('aria-hidden', 'true');
    container.append(this.createAvatarLoader());
    void this.renderPlayerAvatar(container, player);
    return container;
  }

  private async renderPlayerAvatar(container: HTMLElement, player: MapPlayerMarker): Promise<void> {
    const source = player.avatar_url ? await loadSprite(player.avatar_url) : null;
    if (source && container.isConnected) {
      container.replaceChildren(this.createRawPlayerSprite(source));
      return;
    }
    await this.loadPlayerAvatarFromSavedAppearance(container, player.id);
  }

  private async loadPlayerAvatarFromSavedAppearance(
    container: HTMLElement,
    playerId: string,
  ): Promise<void> {
    if (!container.isConnected) return;

    try {
      const query = new URLSearchParams({ id: playerId });
      const response = await fetch(`/api/player-avatar?${query}`, { cache: 'no-store' });
      if (response.ok) {
        const payload = (await response.json()) as { avatar_url?: string };
        if (payload.avatar_url) {
          const source = await loadSprite(payload.avatar_url);
          if (source && container.isConnected) {
            container.replaceChildren(this.createRawPlayerSprite(source));
            return;
          }
        }
      }
    } catch {
      // Keep the loader visible and retry while the map menu is still mounted.
    }

    if (container.isConnected) {
      window.setTimeout(() => {
        void this.loadPlayerAvatarFromSavedAppearance(container, playerId);
      }, 2500);
    }
  }

  private createAvatarLoader(): HTMLElement {
    const loader = document.createElement('span');
    loader.className = 'player-avatar-loader';
    for (let pixel = 0; pixel < 16; pixel += 1) {
      loader.append(document.createElement('span'));
    }
    return loader;
  }

  private createRawPlayerSprite(source: HTMLImageElement): HTMLImageElement {
    const sprite = document.createElement('img');
    sprite.className = 'player-toggle-avatar-sprite';
    sprite.alt = '';
    sprite.decoding = 'async';
    sprite.src = source.src;
    return sprite;
  }

  drawMarkers(players: MapPlayerMarker[]) {
    const layer = this.layer('markers');
    layer.replaceChildren();
    const renderVersion = ++this.playerRenderVersion;
    for (const player of players) {
      const point = this.markerPosition(player);
      if (!point) continue;
      void this.appendPlayerMarker(layer, player, point, renderVersion);
    }
  }

  private async appendPlayerMarker(
    layer: HTMLElement,
    player: MapPlayerMarker,
    point: { x: number; y: number },
    renderVersion: number,
  ): Promise<void> {
    if (!player.avatar_url) return;
    const source = await loadSprite(player.avatar_url);
    if (!source || renderVersion !== this.playerRenderVersion) return;
    const sprite = createOutlinedSprite(source, playerOutlineColor(player.team));
    if (!sprite) return;

    const marker = document.createElement('div');
    marker.className = 'player-marker';
    marker.style.left = `${(point.x / this.world.width) * 100}%`;
    marker.style.top = `${(point.y / this.world.height) * 100}%`;
    marker.setAttribute('aria-label', `Игрок ${player.name || 'без имени'}`);
    sprite.className = 'player-head-sprite';
    if (player.direction === -1) sprite.classList.add('facing-left');
    marker.append(sprite);
    layer.append(marker);
  }

  drawEntities(entities: MapNpcMarker[]) {
    const layer = this.layer('entities');
    layer.replaceChildren();
    const renderVersion = ++this.entityRenderVersion;
    for (const entity of entities || []) {
      const x = Number(entity.x),
        y = Number(entity.y);
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= this.world.width ||
        y >= this.world.height ||
        !entity.icon_url
      )
        continue;
      void this.appendEntityMarker(layer, entity, x, y, renderVersion);
    }
  }

  private async appendEntityMarker(
    layer: HTMLElement,
    entity: MapNpcMarker,
    x: number,
    y: number,
    renderVersion: number,
  ): Promise<void> {
    const source = await loadSprite(entity.icon_url || '');
    if (!source || renderVersion !== this.entityRenderVersion) return;
    const sprite = createOutlinedSprite(source, '#ffffff');
    if (!sprite) return;
    const marker = document.createElement('div');
    marker.className = `entity-marker${entity.boss ? ' boss' : ''}`;
    marker.style.left = `${((x + 0.5) / this.world.width) * 100}%`;
    marker.style.top = `${((y + 0.5) / this.world.height) * 100}%`;
    marker.title = entity.name || (entity.boss ? 'Босс' : 'NPC');
    sprite.className = 'entity-head-sprite';
    // Terraria draws NPC sprites flipped when spriteDirection is 1.
    if (entity.direction === 1) sprite.classList.add('facing-left');
    marker.append(sprite);
    layer.append(marker);
  }

  drawDroppedCoins(coins: MapCoinMarker[]) {
    const layer = this.layer('coins');
    layer.replaceChildren();
    const renderVersion = ++this.coinRenderVersion;
    for (const coin of coins || []) {
      const x = Number(coin.x),
        y = Number(coin.y),
        stack = Math.max(0, Math.trunc(Number(coin.stack) || 0));
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        stack < 1 ||
        x < 0 ||
        y < 0 ||
        x >= this.world.width ||
        y >= this.world.height
      )
        continue;
      void this.appendCoinMarker(layer, coin, x, y, stack, renderVersion);
    }
  }

  private async appendCoinMarker(
    layer: HTMLElement,
    coin: MapCoinMarker,
    x: number,
    y: number,
    stack: number,
    renderVersion: number,
  ): Promise<void> {
    const source = await loadSprite(coin.icon_url || '');
    if (!source || renderVersion !== this.coinRenderVersion) return;
    const sprite = createOutlinedSprite(source, '#ffffff');
    if (!sprite) return;

    const marker = document.createElement('div');
    marker.className = 'coin-marker';
    marker.style.left = `${((x + 0.5) / this.world.width) * 100}%`;
    marker.style.top = `${((y + 0.5) / this.world.height) * 100}%`;
    marker.title = `${coin.name || 'Монета'} × ${stack.toLocaleString('ru-RU')}`;
    sprite.className = 'coin-sprite';
    marker.append(sprite);
    layer.append(marker);
  }

  drawDeaths(deaths: MapDeathMarker[]) {
    const layer = this.layer('deaths');
    layer.replaceChildren();
    const renderVersion = ++this.deathRenderVersion;
    for (const death of deaths || []) {
      const x = Number(death.x);
      const y = Number(death.y);
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= this.world.width ||
        y >= this.world.height
      )
        continue;
      void this.appendDeathMarker(layer, death, x, y, renderVersion);
    }
  }

  private async appendDeathMarker(
    layer: HTMLElement,
    death: MapDeathMarker,
    x: number,
    y: number,
    renderVersion: number,
  ): Promise<void> {
    const source = await loadSprite(DEATH_SPRITE);
    if (!source || renderVersion !== this.deathRenderVersion) return;

    const marker = document.createElement('div');
    marker.className = 'death-marker';
    marker.style.left = `${((x + 0.5) / this.world.width) * 100}%`;
    marker.style.top = `${((y + 0.5) / this.world.height) * 100}%`;
    marker.title = `Место смерти: ${death.name || 'Игрок'}`;
    const sprite = source.cloneNode(false) as HTMLImageElement;
    sprite.className = 'death-sprite';
    marker.append(sprite);
    layer.append(marker);
  }

  // Exact vanilla Terraria pylon map-icon sprites (white outline included), from terraria.wiki.gg/wiki/Category:Pylon_map_icons.
  private readonly pylonSpriteData: Record<string, string> = {
    Aether:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAAXNSR0IB2cksfwAAAARnQU1BAACxjwv8YQUAAAAgY0hSTQAAeiYAAICEAAD6AAAAgOgAAHUwAADqYAAAOpgAABdwnLpRPAAAACRQTFRFAQEB////9PX58vnB3eq7/cfnserQb7T7rJPcg2rcbRyrAAAAaIMecAAAAAF0Uk5TAEDm2GYAAABnSURBVHjaldJBDcAwDAPAUSiFUgiFUCiFUQiFUhiFUQi5VYosf9xJ9ce6t31VMqsls7UUhMaEScrthUnI3AImocVZ1uyK0GJZ0N32dLPusWHcw3pEPILlAZ0Qhk4IUyQNCW73/f/GB9+8jwsyM3XxAAAAAElFTkSuQmCC',
    Cavern:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJFBMVEVHcEz////9/+v44enjteGrkcp0dLJUY59USoRINGYeEzMAAAB4bbjdAAAAAXRSTlMAQObYZgAAAGdJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVSGIVQKIVRCLlViix/3En1x7q3fVUyqyWztRSExoRJyu2FScjcAiahxVnW7IrQYlnQ3fZ0s+6xYdzDekQ8guUBnRCGTghTJA0Jbvf9/8YH5cmSwzkCf2kAAAAASUVORK5CYII=',
    Desert:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJFBMVEVHcEz/////++z/8Z//3T77twvejQexbyCHTRBxOglbIRYAAAAuj7TgAAAAAXRSTlMAQObYZgAAAGdJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVSGIVQKIVRCLlViix/3En1x7q3fVUyqyWztRSExoRJyu2FScjcAiahxVnW7IrQYlnQ3fZ0s+6xYdzDekQ8guUBnRCGTghTJA0Jbvf9/8YH5cmSwzkCf2kAAAAASUVORK5CYII=',
    Forest:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJFBMVEVHcEz////h/8a4+Zx38I5YyXQ4nWYifmwWX1ARTUgOPEsAAACxjhmaAAAAAXRSTlMAQObYZgAAAGdJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVSGIVQKIVRCLlViix/3En1x7q3fVUyqyWztRSExoRJyu2FScjcAiahxVnW7IrQYlnQ3fZ0s+6xYdzDekQ8guUBnRCGTghTJA0Jbvf9/8YH5cmSwzkCf2kAAAAASUVORK5CYII=',
    Hallow:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJ1BMVEVHcEz////9/+v93tr4pO3dY9mwT8RyYdF5QrVPOJU5KnsvFGMAAABwJysIAAAAAXRSTlMAQObYZgAAAGpJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVQGIVRCIVSGIWAWqXIyseZNH+se9tHJiKbMsYIQsgWXCypPHAREhWHi9DmSnNORmgzTagqPVVkqjf002S6+02YNugPYajhxQiXimWIsN33+xsvOfmeUcqn4vUAAAAASUVORK5CYII=',
    Jungle:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJFBMVEVHcEz////9/+v7/5bj8mGh5zRVyDUdmlgUfRISZgkOQ0gAAACTJFRUAAAAAXRSTlMAQObYZgAAAGdJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVSGIVQKIVRCLlViix/3En1x7q3fVUyqyWztRSExoRJyu2FScjcAiahxVnW7IrQYlnQ3fZ0s+6xYdzDekQ8guUBnRCGTghTJA0Jbvf9/8YH5cmSwzkCf2kAAAAASUVORK5CYII=',
    Mushroom:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJFBMVEVHcEz////P3P/Lyv+6rv+QlPhib99IUcI4OKkmJJYaGkAAAACnBs0MAAAAAXRSTlMAQObYZgAAAGdJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVSGIVQKIVRCLlViix/3En1x7q3fVUyqyWztRSExoRJyu2FScjcAiahxVnW7IrQYlnQ3fZ0s+6xYdzDekQ8guUBnRCGTghTJA0Jbvf9/8YH5cmSwzkCf2kAAAAASUVORK5CYII=',
    Ocean:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJFBMVEVHcEz////g//288P+G1v9IresljdYaY8Y3RKA/LoMyFGMAAABlpVC2AAAAAXRSTlMAQObYZgAAAGdJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVSGIVQKIVRCLlViix/3En1x7q3fVUyqyWztRSExoRJyu2FScjcAiahxVnW7IrQYlnQ3fZ0s+6xYdzDekQ8guUBnRCGTghTJA0Jbvf9/8YH5cmSwzkCf2kAAAAASUVORK5CYII=',
    Snow: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJFBMVEVHcEz////7+/vr8vTO5uuU4edgyt08nsU4Yq8ySJAZOmAAAABKR8/9AAAAAXRSTlMAQObYZgAAAGdJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVSGIVQKIVRCLlViix/3En1x7q3fVUyqyWztRSExoRJyu2FScjcAiahxVnW7IrQYlnQ3fZ0s+6xYdzDekQ8guUBnRCGTghTJA0Jbvf9/8YH5cmSwzkCf2kAAAAASUVORK5CYII=',
    Underworld:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAAXNSR0IB2cksfwAAAARnQU1BAACxjwv8YQUAAAAgY0hSTQAAeiYAAICEAAD6AAAAgOgAAHUwAADqYAAAOpgAABdwnLpRPAAAACRQTFRFAQEB////+v/r7eSU/8ds/54n82QS50uJyAkjixpDcgUbAAAAKZziKwAAAAF0Uk5TAEDm2GYAAABnSURBVHjaldJBDcAwDAPAUSiFUgiFUBiFUhiFUCiFUQi5VYosf9xJ9ce6t31VMqsls7UUhMaEScrthUnI3AImocVZ1uyK0GJZ0N32dLPusWHcw3pEPILlAZ0Qhk4IUyQNCW73/f/GB+XJksM5An9pAAAAAElFTkSuQmCC',
    Universal:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAmBAMAAAAlwuZsAAAAJFBMVEVHcEz//////tXx6Z7axGLUq4CagYp1ZoJaTFA7NjUrF0IAAADgpUE/AAAAAXRSTlMAQObYZgAAAGdJREFUeNqV0kENwDAMA8BRKIVSCIVQGIVSGIVQKIVRCLlViix/3En1x7q3fVUyqyWztRSExoRJyu2FScjcAiahxVnW7IrQYlnQ3fZ0s+6xYdzDekQ8guUBnRCGTghTJA0Jbvf9/8YH5cmSwzkCf2kAAAAASUVORK5CYII=',
  };

  // Vanilla Terraria map spawn icon (22x24), from terraria.wiki.gg/wiki/Category:Minimap_icons.
  private readonly spawnSpriteData =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAYBAMAAAAMkBB4AAAAFVBMVEUBAQH///9Z/I8u42oBpjgAYyEAAAAoKqKrAAAAAXRSTlMAQObYZgAAAE9JREFUeNp1yVEJwFAMQ9FaiIVaqIVaiIX4lzACg9K3vfuTAwknyXNaAHTaJAn9uS+ur82sJDSew9w2m01o2azMLELj93DmcgjO3A652H4AHOEsO8xMR64AAAAASUVORK5CYII=';
  drawPylons(pylons: MapPylonMarker[]) {
    const layer = this.layer('pylons');
    layer.querySelectorAll('.pylon-marker').forEach((marker) => marker.remove());
    const renderVersion = ++this.pylonRenderVersion;
    for (const pylon of pylons || []) {
      const x = Number(pylon.x),
        y = Number(pylon.y);
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= this.world.width ||
        y >= this.world.height
      )
        continue;
      const type = String(pylon.type || '');
      const [label, , sprite] = PYLON_TYPES[type] || [`${type || 'Пилон'}`, '#d9e7f4', 'Forest'];
      void this.appendPylonMarker(layer, x, y, label, sprite, renderVersion);
    }
  }

  private async appendPylonMarker(
    layer: HTMLElement,
    x: number,
    y: number,
    label: string,
    spriteName: string,
    renderVersion: number,
  ): Promise<void> {
    const source = await loadSprite(
      this.pylonSpriteData[spriteName] || this.pylonSpriteData.Forest,
    );
    if (!source || renderVersion !== this.pylonRenderVersion) return;
    const marker = document.createElement('div');
    marker.className = 'pylon-marker';
    marker.style.left = `${((x + 0.5) / this.world.width) * 100}%`;
    marker.style.top = `${((y + 0.5) / this.world.height) * 100}%`;
    marker.setAttribute('aria-label', label);
    const icon = source.cloneNode() as HTMLImageElement;
    icon.className = 'pylon-icon';
    icon.alt = '';
    icon.width = 28;
    icon.height = 38;
    icon.draggable = false;
    marker.append(icon);
    layer.append(marker);
  }
  drawSpawn(world: MapEntityWorld) {
    const layer = this.layer('spawn'),
      key = JSON.stringify([world?.spawn_x, world?.spawn_y, world?.width, world?.height]);
    // The feature toggle can remove the element without changing its coordinates.
    // Confirm the node still exists before treating the cached render as current.
    if (key === this.spawnRenderKey && layer.querySelector('.spawn-marker')) return;
    layer.querySelector('.spawn-marker')?.remove();
    this.spawnRenderKey = key;
    const x = Number(world?.spawn_x),
      y = Number(world?.spawn_y),
      width = Number(world?.width),
      height = Number(world?.height);
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      x < 0 ||
      y < 0 ||
      x >= width ||
      y >= height
    )
      return;
    const renderVersion = ++this.spawnRenderVersion;
    void this.appendSpawnMarker(layer, x, y, width, height, renderVersion);
  }

  private async appendSpawnMarker(
    layer: HTMLElement,
    x: number,
    y: number,
    width: number,
    height: number,
    renderVersion: number,
  ): Promise<void> {
    const source = await loadSprite(this.spawnSpriteData);
    if (!source || renderVersion !== this.spawnRenderVersion) return;
    const marker = document.createElement('div');
    marker.className = 'spawn-marker';
    marker.style.left = `${((x + 0.5) / width) * 100}%`;
    marker.style.top = `${((y + 0.5) / height) * 100}%`;
    marker.setAttribute('aria-label', 'Точка появления');
    const icon = source.cloneNode() as HTMLImageElement;
    icon.className = 'spawn-icon';
    icon.alt = '';
    icon.width = 22;
    icon.height = 24;
    icon.draggable = false;
    marker.append(icon);
    layer.append(marker);
  }
}
