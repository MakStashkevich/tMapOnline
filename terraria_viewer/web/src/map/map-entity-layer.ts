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
  velocity?: { x?: number; y?: number } | null;
  teleported?: boolean;
  position?: { tileX?: number; tileY?: number; x?: number; y?: number };
  positions?: Array<{ x: number; y: number; tileX?: number; tileY?: number }>;
};
type MapNpcMarker = {
  id: number | string;
  x: number;
  y: number;
  name?: string;
  boss?: boolean;
  icon_url?: string;
  direction?: number | null;
  velocity?: { x?: number; y?: number } | null;
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

type MarkerMotion = {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  sampledAt: number;
  samples: MotionSample[];
  element: HTMLElement | null;
  spriteUrl: string;
  direction: number | null | undefined;
};

type MotionSample = {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  receivedAt: number;
};

const TERRARIA_TICKS_PER_SECOND = 60;
const TERRARIA_PIXELS_PER_TILE = 16;
const DEFAULT_INTERPOLATION_DELAY_MS = 80;
const MAX_EXTRAPOLATION_SECONDS = 0.12;
const MAX_MOTION_SAMPLES = 24;

/** Renders map objects as DOM layers while keeping their sprite and fallback rules together. */
export class MapEntityLayer {
  private interpolationDelayMs = DEFAULT_INTERPOLATION_DELAY_MS;
  private world: MapEntityWorld = {};
  private spawnRenderKey = '';
  private coinRenderVersion = 0;
  private deathRenderVersion = 0;
  private pylonRenderVersion = 0;
  private spawnRenderVersion = 0;
  private readonly playerMotions = new Map<string, MarkerMotion>();
  private readonly entityMotions = new Map<string, MarkerMotion>();
  private animationFrame: number | null = null;
  private animationEnabled = true;

  constructor(
    private readonly root: HTMLElement,
    private readonly isPointVisible: (x: number, y: number) => boolean = () => true,
  ) {}

  setWorld(world: MapEntityWorld): void {
    this.world = world;
  }

  setInterpolationDelay(delayMs: number): void {
    this.interpolationDelayMs = Math.max(80, Math.min(300, delayMs));
  }

  refreshMarkerPositions(): void {
    const now = performance.now();
    for (const motion of this.playerMotions.values()) {
      if (motion.element) {
        const point = this.predictedPosition(motion, now);
        this.positionMarker(motion.element, point.x, point.y);
      }
    }
    for (const motion of this.entityMotions.values()) {
      if (motion.element) {
        const point = this.predictedPosition(motion, now);
        this.positionMarker(motion.element, point.x, point.y);
      }
    }
  }

  setAnimationEnabled(enabled: boolean): void {
    if (this.animationEnabled === enabled) return;
    this.animationEnabled = enabled;

    if (!enabled && this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
      for (const motion of this.playerMotions.values()) {
        if (motion.element) this.positionMarker(motion.element, motion.x, motion.y);
      }
      for (const motion of this.entityMotions.values()) {
        if (motion.element) this.positionMarker(motion.element, motion.x, motion.y);
      }
      return;
    }

    if (enabled) this.ensureAnimationFrame();
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
    const x = Number(position.x ?? position.tileX),
      y = Number(position.y ?? position.tileY);
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
    const activeIds = new Set<string>();
    for (const player of players) {
      const point = this.markerPosition(player);
      if (!point || !player.avatar_url || !this.isPointVisible(point.x, point.y)) continue;
      activeIds.add(player.id);
      let motion = this.playerMotions.get(player.id);
      if (motion && motion.spriteUrl !== player.avatar_url) {
        motion.element?.remove();
        this.playerMotions.delete(player.id);
        motion = undefined;
      }
      if (!motion) {
        motion = this.createMotion(
          point.x,
          point.y,
          player.velocity,
          player.avatar_url,
          player.direction,
        );
        this.playerMotions.set(player.id, motion);
        void this.appendPlayerMarker(layer, player, motion);
      } else {
        const resetMotion =
          player.teleported === true || this.isLargeJump(motion, point.x, point.y);
        this.updateMotion(motion, point.x, point.y, player.velocity, resetMotion);
        motion.direction = player.direction;
        this.updateMarkerDirection(motion.element, 'player-head-sprite', player.direction === -1);
      }
    }
    for (const [id, motion] of this.playerMotions) {
      if (!activeIds.has(id)) {
        motion.element?.remove();
        this.playerMotions.delete(id);
      }
    }
    this.ensureAnimationFrame();
  }

  private async appendPlayerMarker(
    layer: HTMLElement,
    player: MapPlayerMarker,
    motion: MarkerMotion,
  ): Promise<void> {
    const source = await loadSprite(motion.spriteUrl);
    if (!source || this.playerMotions.get(player.id) !== motion) return;
    const sprite = createOutlinedSprite(source, playerOutlineColor(player.team));
    if (!sprite) return;

    const marker = document.createElement('div');
    marker.className = 'player-marker';
    marker.setAttribute('aria-label', `Игрок ${player.name || 'без имени'}`);
    sprite.className = 'player-head-sprite';
    if (player.direction === -1) sprite.classList.add('facing-left');
    marker.append(sprite);
    layer.append(marker);
    motion.element = marker;
    const point = this.predictedPosition(motion, performance.now());
    this.positionMarker(marker, point.x, point.y);
  }

  drawEntities(entities: MapNpcMarker[]) {
    const layer = this.layer('entities');
    const activeIds = new Set<string>();
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
        !entity.icon_url ||
        !this.isPointVisible(x, y)
      )
        continue;
      const id = String(entity.id);
      activeIds.add(id);
      let motion = this.entityMotions.get(id);
      if (motion && motion.spriteUrl !== entity.icon_url) {
        motion.element?.remove();
        this.entityMotions.delete(id);
        motion = undefined;
      }
      if (!motion) {
        motion = this.createMotion(x, y, entity.velocity, entity.icon_url, entity.direction);
        this.entityMotions.set(id, motion);
        void this.appendEntityMarker(layer, entity, motion);
      } else {
        this.updateMotion(motion, x, y, entity.velocity, this.isLargeJump(motion, x, y));
        motion.direction = entity.direction;
        this.updateMarkerDirection(motion.element, 'entity-head-sprite', entity.direction === 1);
      }
    }
    for (const [id, motion] of this.entityMotions) {
      if (!activeIds.has(id)) {
        motion.element?.remove();
        this.entityMotions.delete(id);
      }
    }
    this.ensureAnimationFrame();
  }

  private async appendEntityMarker(
    layer: HTMLElement,
    entity: MapNpcMarker,
    motion: MarkerMotion,
  ): Promise<void> {
    const source = await loadSprite(motion.spriteUrl);
    const id = String(entity.id);
    if (!source || this.entityMotions.get(id) !== motion) return;
    const sprite = createOutlinedSprite(source, '#ffffff');
    if (!sprite) return;
    const marker = document.createElement('div');
    marker.className = `entity-marker${entity.boss ? ' boss' : ''}`;
    marker.title = entity.name || (entity.boss ? 'Босс' : 'NPC');
    sprite.className = 'entity-head-sprite';
    // Terraria draws NPC sprites flipped when spriteDirection is 1.
    if (entity.direction === 1) sprite.classList.add('facing-left');
    marker.append(sprite);
    layer.append(marker);
    motion.element = marker;
    const point = this.predictedPosition(motion, performance.now());
    this.positionMarker(marker, point.x, point.y);
  }

  private createMotion(
    x: number,
    y: number,
    velocity: { x?: number; y?: number } | null | undefined,
    spriteUrl: string,
    direction: number | null | undefined,
  ): MarkerMotion {
    const receivedAt = performance.now();
    const velocityX = Number(velocity?.x) || 0;
    const velocityY = Number(velocity?.y) || 0;
    return {
      x,
      y,
      velocityX,
      velocityY,
      sampledAt: receivedAt,
      samples: [{ x, y, velocityX, velocityY, receivedAt }],
      element: null,
      spriteUrl,
      direction,
    };
  }

  private updateMotion(
    motion: MarkerMotion,
    x: number,
    y: number,
    velocity: { x?: number; y?: number } | null | undefined,
    snap: boolean,
  ): void {
    const receivedAt = performance.now();
    const velocityX = snap ? 0 : Number(velocity?.x) || 0;
    const velocityY = snap ? 0 : Number(velocity?.y) || 0;

    // Buffer authoritative samples so uneven HTTP polling does not move markers in visible steps.
    motion.x = x;
    motion.y = y;
    motion.velocityX = velocityX;
    motion.velocityY = velocityY;
    motion.sampledAt = receivedAt;
    if (!this.animationEnabled) {
      motion.samples = [{ x, y, velocityX, velocityY, receivedAt }];
      if (motion.element) this.positionMarker(motion.element, x, y);
      return;
    }

    if (snap) {
      motion.samples = [{ x, y, velocityX, velocityY, receivedAt }];
      if (motion.element) this.positionMarker(motion.element, x, y);
      return;
    }

    const lastSample = motion.samples.at(-1);
    if (lastSample && receivedAt <= lastSample.receivedAt) {
      lastSample.x = x;
      lastSample.y = y;
      lastSample.velocityX = velocityX;
      lastSample.velocityY = velocityY;
      return;
    }

    motion.samples.push({ x, y, velocityX, velocityY, receivedAt });
    if (motion.samples.length > MAX_MOTION_SAMPLES) motion.samples.shift();
  }

  private isLargeJump(motion: MarkerMotion, x: number, y: number): boolean {
    const predicted = this.predictedPosition(motion, performance.now());
    return Math.hypot(x - predicted.x, y - predicted.y) > 48;
  }

  private predictedPosition(motion: MarkerMotion, now: number): { x: number; y: number } {
    const renderTime = now - this.interpolationDelayMs;
    const samples = motion.samples;
    if (samples.length === 0) return { x: motion.x, y: motion.y };
    if (renderTime <= samples[0].receivedAt) {
      return { x: samples[0].x, y: samples[0].y };
    }

    while (samples.length > 2 && samples[1].receivedAt < renderTime - this.interpolationDelayMs) {
      samples.shift();
    }

    for (let index = 0; index < samples.length - 1; index += 1) {
      const start = samples[index];
      const end = samples[index + 1];
      if (renderTime < start.receivedAt || renderTime > end.receivedAt) continue;

      const durationSeconds = (end.receivedAt - start.receivedAt) / 1000;
      if (durationSeconds <= 0) return { x: end.x, y: end.y };
      const amount = (renderTime - start.receivedAt) / (end.receivedAt - start.receivedAt);
      const tilesPerSecond = TERRARIA_TICKS_PER_SECOND / TERRARIA_PIXELS_PER_TILE;
      return {
        x: this.hermitePosition(
          start.x,
          end.x,
          start.velocityX * tilesPerSecond,
          end.velocityX * tilesPerSecond,
          durationSeconds,
          amount,
        ),
        y: this.hermitePosition(
          start.y,
          end.y,
          start.velocityY * tilesPerSecond,
          end.velocityY * tilesPerSecond,
          durationSeconds,
          amount,
        ),
      };
    }

    const latest = samples[samples.length - 1];
    const elapsedSeconds = Math.min(
      Math.max(0, (renderTime - latest.receivedAt) / 1000),
      MAX_EXTRAPOLATION_SECONDS,
    );
    const tilesPerSecond = TERRARIA_TICKS_PER_SECOND / TERRARIA_PIXELS_PER_TILE;
    return {
      x: latest.x + latest.velocityX * tilesPerSecond * elapsedSeconds,
      y: latest.y + latest.velocityY * tilesPerSecond * elapsedSeconds,
    };
  }

  private hermitePosition(
    start: number,
    end: number,
    startVelocity: number,
    endVelocity: number,
    durationSeconds: number,
    amount: number,
  ): number {
    const amountSquared = amount * amount;
    const amountCubed = amountSquared * amount;
    const startWeight = 2 * amountCubed - 3 * amountSquared + 1;
    const startTangentWeight = amountCubed - 2 * amountSquared + amount;
    const endWeight = -2 * amountCubed + 3 * amountSquared;
    const endTangentWeight = amountCubed - amountSquared;
    const interpolated =
      startWeight * start +
      startTangentWeight * durationSeconds * startVelocity +
      endWeight * end +
      endTangentWeight * durationSeconds * endVelocity;

    // Network velocity can briefly disagree with position after collision corrections.
    const margin = Math.abs(end - start) * 0.15 + 0.05;
    const lowerBound = Math.min(start, end) - margin;
    const upperBound = Math.max(start, end) + margin;
    return Math.max(lowerBound, Math.min(upperBound, interpolated));
  }

  private positionMarker(marker: HTMLElement, x: number, y: number): void {
    const width = Number(this.world.width || 1);
    const height = Number(this.world.height || 1);
    const pixelX = (x / width) * this.root.clientWidth;
    const pixelY = (y / height) * this.root.clientHeight;

    // Keep moving sprites on the compositor instead of triggering layout every animation frame.
    marker.style.left = '0';
    marker.style.top = '0';
    marker.style.translate = `${pixelX}px ${pixelY}px`;
  }

  private updateMarkerDirection(
    marker: HTMLElement | null,
    spriteClass: string,
    facingLeft: boolean,
  ): void {
    const sprite = marker?.querySelector<HTMLElement>(`.${spriteClass}`);
    sprite?.classList.toggle('facing-left', facingLeft);
  }

  private ensureAnimationFrame(): void {
    if (!this.animationEnabled || this.animationFrame !== null) return;
    this.animationFrame = requestAnimationFrame((now) => this.animateMarkers(now));
  }

  private animateMarkers(now: number): void {
    this.animationFrame = null;
    if (!this.animationEnabled) return;
    let hasRecentMovement = false;
    const animate = (motions: Map<string, MarkerMotion>) => {
      for (const motion of motions.values()) {
        if (!motion.element) continue;
        const age = (now - motion.sampledAt) / 1000;
        const point = this.predictedPosition(motion, now);
        this.positionMarker(motion.element, point.x, point.y);
        const hasBufferedSamples =
          motion.samples.length > 1 &&
          now - this.interpolationDelayMs < motion.samples[motion.samples.length - 1].receivedAt;
        if (
          hasBufferedSamples ||
          (age < MAX_EXTRAPOLATION_SECONDS && (motion.velocityX !== 0 || motion.velocityY !== 0))
        ) {
          hasRecentMovement = true;
        }
      }
    };
    animate(this.playerMotions);
    animate(this.entityMotions);
    if (hasRecentMovement) this.ensureAnimationFrame();
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
        y >= this.world.height ||
        !this.isPointVisible(x, y)
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
        y >= this.world.height ||
        !this.isPointVisible(x, y)
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
        y >= this.world.height ||
        !this.isPointVisible(x, y)
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
