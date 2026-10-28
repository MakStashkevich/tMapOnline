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

/** Renders map objects as DOM layers while keeping their sprite and fallback rules together. */
export class MapEntityLayer {
  private world: MapEntityWorld = {};
  private spawnRenderKey = '';
  private headScale = 1;

  constructor(private readonly root: HTMLElement) {}

  setWorld(world: MapEntityWorld): void {
    this.world = world;
  }

  setMapScale(mapScale: number): void {
    // Terraria uses this same capped curve for head icons on the full map.
    this.headScale = Math.min(1, (mapScale * 0.4 + 1) / 3);
    this.root.style.setProperty('--map-icon-scale', String(this.headScale));
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
  makeAvatar(player: MapPlayerMarker) {
    if (player.avatar_url) {
      const img = document.createElement('img');
      img.src = player.avatar_url;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => {
        const fallback = document.createElement('span');
        fallback.className = 'avatar-fallback';
        fallback.textContent = (player.name || '?').slice(0, 1).toUpperCase();
        img.replaceWith(fallback);
      };
      return img;
    }
    const fallback = document.createElement('span');
    fallback.className = 'avatar-fallback';
    fallback.textContent = (player.name || '?').slice(0, 1).toUpperCase();
    return fallback;
  }
  drawMarkers(players: MapPlayerMarker[]) {
    const layer = this.layer('markers');
    layer.replaceChildren();
    for (const player of players) {
      const point = this.markerPosition(player);
      if (!point) continue;
      const marker = document.createElement('div');
      marker.className = 'player-marker';
      marker.style.left = `${(point.x / this.world.width) * 100}%`;
      marker.style.top = `${(point.y / this.world.height) * 100}%`;
      marker.setAttribute('aria-label', `Игрок ${player.name || 'без имени'}`);
      const avatar = this.makeAvatar(player);
      if (avatar instanceof HTMLImageElement) {
        avatar.classList.add('player-head-sprite');
        if (player.direction === -1) avatar.classList.add('facing-left');
        const outlineAvatar = () => {
          if (!avatar.complete || avatar.naturalWidth < 1) return;
          const outlinedAvatar = this.createOutlinedSprite(
            avatar,
            this.playerTeamColor(player.team),
          );
          if (outlinedAvatar && avatar.isConnected) {
            outlinedAvatar.className = avatar.className;
            avatar.replaceWith(outlinedAvatar);
          }
        };
        avatar.addEventListener('load', outlineAvatar, { once: true });
        marker.append(avatar);
        layer.append(marker);
        // Cached images may finish before a load listener can run.
        if (avatar.complete && avatar.naturalWidth > 0) outlineAvatar();
        continue;
      }
      marker.append(avatar);
      layer.append(marker);
    }
  }

  private playerTeamColor(team: number | null | undefined): string {
    // Keep the game palette local so dedicated-server rendering never depends on client graphics state.
    const teamColors: Record<number, string> = {
      0: '#ffffff',
      1: '#e62814',
      2: '#14c81e',
      3: '#4b5aff',
      4: '#c8b400',
      5: '#ff69b4',
    };
    return teamColors[Number(team)] || teamColors[0];
  }

  private createOutlinedSprite(
    source: HTMLImageElement,
    innerOutlineColor: string,
  ): HTMLCanvasElement | null {
    const sourceWidth = source.naturalWidth;
    const sourceHeight = source.naturalHeight;
    if (sourceWidth < 1 || sourceHeight < 1) return null;

    const padding = 4;
    const width = sourceWidth + padding * 2;
    const height = sourceHeight + padding * 2;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;

    try {
      context.imageSmoothingEnabled = false;
      context.drawImage(source, padding, padding);
      const original = context.getImageData(padding, padding, sourceWidth, sourceHeight).data;
      const output = context.createImageData(width, height);
      const outputPixels = output.data;
      const color = this.parseHexColor(innerOutlineColor);

      this.drawOutlineRing(outputPixels, original, sourceWidth, sourceHeight, width, 4, [0, 0, 0]);
      this.drawOutlineRing(outputPixels, original, sourceWidth, sourceHeight, width, 2, color);
      this.drawOriginalSprite(outputPixels, original, sourceWidth, sourceHeight, width, padding);

      context.putImageData(output, 0, 0);
      return canvas;
    } catch {
      return null;
    }
  }

  private drawOutlineRing(
    destination: Uint8ClampedArray,
    source: Uint8ClampedArray,
    sourceWidth: number,
    sourceHeight: number,
    destinationWidth: number,
    radius: number,
    color: [number, number, number],
  ): void {
    const padding = 4;
    for (let offsetY = -radius; offsetY <= radius; offsetY += 2) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 2) {
        if (Math.abs(offsetX) + Math.abs(offsetY) !== radius) continue;
        for (let y = 0; y < sourceHeight; y++) {
          for (let x = 0; x < sourceWidth; x++) {
            const sourceOffset = (y * sourceWidth + x) * 4;
            const alpha = source[sourceOffset + 3];
            if (alpha === 0) continue;
            const targetX = x + padding + offsetX;
            const targetY = y + padding + offsetY;
            const targetOffset = (targetY * destinationWidth + targetX) * 4;
            destination[targetOffset] = color[0];
            destination[targetOffset + 1] = color[1];
            destination[targetOffset + 2] = color[2];
            destination[targetOffset + 3] = Math.max(destination[targetOffset + 3], alpha);
          }
        }
      }
    }
  }

  private drawOriginalSprite(
    destination: Uint8ClampedArray,
    source: Uint8ClampedArray,
    sourceWidth: number,
    sourceHeight: number,
    destinationWidth: number,
    padding: number,
  ): void {
    for (let y = 0; y < sourceHeight; y++) {
      for (let x = 0; x < sourceWidth; x++) {
        const sourceOffset = (y * sourceWidth + x) * 4;
        const targetOffset = ((y + padding) * destinationWidth + x + padding) * 4;
        destination[targetOffset] = source[sourceOffset];
        destination[targetOffset + 1] = source[sourceOffset + 1];
        destination[targetOffset + 2] = source[sourceOffset + 2];
        destination[targetOffset + 3] = source[sourceOffset + 3];
      }
    }
  }

  private parseHexColor(value: string): [number, number, number] {
    const match = /^#([0-9a-f]{6})$/i.exec(value);
    const color = match ? Number.parseInt(match[1], 16) : 0xffffff;
    return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
  }

  drawEntities(entities: MapNpcMarker[]) {
    const layer = this.layer('entities');
    layer.replaceChildren();
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
      const marker = document.createElement('div');
      marker.className = `entity-marker${entity.boss ? ' boss' : ''}`;
      marker.style.left = `${((x + 0.5) / this.world.width) * 100}%`;
      marker.style.top = `${((y + 0.5) / this.world.height) * 100}%`;
      marker.title = entity.name || (entity.boss ? 'Босс' : 'NPC');
      const icon = document.createElement('img');
      icon.alt = '';
      icon.draggable = false;
      const outlineIcon = () => {
        if (!icon.complete || icon.naturalWidth < 1) return;
        const outlinedIcon = this.createOutlinedSprite(icon, '#ffffff');
        if (outlinedIcon && icon.isConnected) {
          outlinedIcon.className = 'entity-head-sprite';
          icon.replaceWith(outlinedIcon);
        }
      };
      icon.addEventListener('load', outlineIcon, { once: true });
      icon.addEventListener('error', () => {
        const retryCount = Number(icon.dataset.retryCount || 0);
        if (retryCount < 3) {
          const nextRetry = retryCount + 1;
          icon.dataset.retryCount = String(nextRetry);
          window.setTimeout(() => {
            if (!marker.isConnected) return;
            icon.src = `${entity.icon_url}?retry=${Date.now()}-${nextRetry}`;
          }, nextRetry * 500);
          return;
        }
        marker.remove();
      });
      marker.append(icon);
      layer.append(marker);
      icon.src = entity.icon_url;
      if (icon.complete && icon.naturalWidth > 0) outlineIcon();
    }
  }
  drawDroppedCoins(coins: MapCoinMarker[]) {
    const layer = this.layer('coins');
    layer.replaceChildren();
    const coinClasses = { 71: 'copper', 72: 'silver', 73: 'gold', 74: 'platinum' };
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
      const name =
        coin.name ||
        {
          71: 'Медная монета',
          72: 'Серебряная монета',
          73: 'Золотая монета',
          74: 'Платиновая монета',
        }[Number(coin.type)] ||
        'Монета';
      const marker = document.createElement('div');
      marker.className = 'coin-marker';
      marker.style.left = `${((x + 0.5) / this.world.width) * 100}%`;
      marker.style.top = `${((y + 0.5) / this.world.height) * 100}%`;
      marker.title = `${name} × ${stack.toLocaleString('ru-RU')}`;
      const icon = document.createElement('img');
      icon.src = coin.icon_url || '';
      icon.alt = '';
      icon.draggable = false;
      icon.addEventListener('error', () => {
        const fallback = document.createElement('span');
        fallback.className = `coin-fallback ${coinClasses[Number(coin.type)] || 'copper'}`;
        marker.replaceChild(fallback, icon);
      });
      const amount = document.createElement('span');
      amount.className = 'coin-stack';
      amount.textContent = stack.toLocaleString('ru-RU');
      marker.append(icon, amount);
      layer.append(marker);
    }
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
      const marker = document.createElement('div');
      marker.className = 'pylon-marker';
      marker.style.left = `${((x + 0.5) / this.world.width) * 100}%`;
      marker.style.top = `${((y + 0.5) / this.world.height) * 100}%`;
      marker.setAttribute('aria-label', label);
      const icon = document.createElement('img');
      icon.className = 'pylon-icon';
      icon.src = this.pylonSpriteData[sprite] || this.pylonSpriteData.Forest;
      icon.alt = '';
      icon.width = 28;
      icon.height = 38;
      icon.draggable = false;
      marker.append(icon);
      layer.append(marker);
    }
  }
  drawSpawn(world: MapEntityWorld) {
    const layer = this.layer('pylons'),
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
    const marker = document.createElement('div');
    marker.className = 'spawn-marker';
    marker.style.left = `${((x + 0.5) / width) * 100}%`;
    marker.style.top = `${((y + 0.5) / height) * 100}%`;
    marker.setAttribute('aria-label', 'Точка появления');
    const icon = document.createElement('img');
    icon.className = 'spawn-icon';
    icon.src = this.spawnSpriteData;
    icon.alt = '';
    icon.width = 22;
    icon.height = 24;
    icon.draggable = false;
    marker.append(icon);
    layer.append(marker);
  }
}
