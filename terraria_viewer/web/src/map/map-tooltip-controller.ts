import { MapEntityLayer } from './map-entity-layer';

type TooltipObject = {
  key: string;
  title: string;
  description: string;
  playerId?: string;
  sessionSeconds?: number | null;
};
type TooltipMapData = any;
type PlayerSessionCache = { fetchedAt: number; secondsByPlayerId: Map<string, number> };

type MapTooltipBindings = {
  stage: HTMLElement;
  tooltip: HTMLElement;
  getData(): TooltipMapData;
  getScale(): number;
  getMaskCanvas(): HTMLCanvasElement | null;
  isEnabled(): boolean;
  isFullMapEnabled(): boolean;
  getPlayerPoint(player: any): { x: number; y: number } | null;
};

/** Delays hover lookups and owns the tooltip cache and its visible state. */
export class MapTooltipController {
  private readonly tileInfoCache = new Map<string, any>();
  private playerSessionCache: PlayerSessionCache | null = null;
  private playerSessionRequest: Promise<Map<string, number> | null> | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverKey = '';
  private hoverToken = 0;

  constructor(private readonly bindings: MapTooltipBindings) {}

  hide = (): void => {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    this.hoverKey = '';
    this.hoverToken++;
    this.bindings.tooltip.hidden = true;
  };

  schedule = (event: PointerEvent): void => {
    if (!this.bindings.isEnabled()) return;

    const data = this.bindings.getData();
    const stageBounds = this.bindings.stage.getBoundingClientRect();
    const scale = this.bindings.getScale();
    const x = Math.floor((event.clientX - stageBounds.left) / scale);
    const y = Math.floor((event.clientY - stageBounds.top) / scale);

    if (!data || x < 0 || y < 0 || x >= data.world.width || y >= data.world.height) {
      this.hide();
      return;
    }

    const object = this.objectAt(x + 0.5, y + 0.5, data, scale);
    const key = object?.key || `tile:${x},${y}`;
    if (key === this.hoverKey) return;

    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverKey = key;
    const token = ++this.hoverToken;
    this.bindings.tooltip.hidden = true;
    const cursor = { clientX: event.clientX, clientY: event.clientY };

    // Wait for the cursor to settle before requesting block data over the network.
    this.hoverTimer = setTimeout(() => {
      void this.showAfterDelay(token, cursor, object, data, x, y);
    }, 2000);
  };

  private async showAfterDelay(
    token: number,
    cursor: { clientX: number; clientY: number },
    object: TooltipObject | null,
    data: TooltipMapData,
    x: number,
    y: number,
  ): Promise<void> {
    if (token !== this.hoverToken) return;
    if (object) {
      if (object.playerId) {
        const sessionSeconds =
          object.sessionSeconds ?? (await this.getPlayerSessionSeconds(object.playerId));
        if (token !== this.hoverToken) return;
        const gameTime =
          sessionSeconds === null ? 'время не получено' : this.formatGameTime(sessionSeconds);
        this.show(cursor, object.title, `Играет ${gameTime} — ${object.description}`);
        return;
      }
      this.show(cursor, object.title, object.description);
      return;
    }

    if (this.isPixelHidden(x, y)) return;
    const info = await this.getTileInfo(data, x, y);
    if (token !== this.hoverToken) return;

    if (info.unavailable) {
      this.show(cursor, 'Данные блока ещё не собраны', `Плитка ${x}, ${y}`);
      return;
    }

    const title = info.tile_name || (info.tile_id == null ? 'Пустой блок' : 'Неизвестный блок');
    const details = [`Плитка ${x}, ${y}`];
    if (info.wall_name) details.push(`Стена: ${info.wall_name}`);
    else if (info.wall_id != null) details.push('Неизвестная стена');
    this.show(cursor, title, details.join(' — '));
  }

  private isPixelHidden(x: number, y: number): boolean {
    if (this.bindings.isFullMapEnabled()) return false;

    const mask = this.bindings.getMaskCanvas();
    if (!mask) return false;

    const maskX = Math.floor(x * 0.25);
    const maskY = Math.floor(y * 0.25);
    if (maskX < 0 || maskY < 0 || maskX >= mask.width || maskY >= mask.height) return true;
    return mask.getContext('2d')?.getImageData(maskX, maskY, 1, 1).data[3] < 32;
  }

  private async getTileInfo(data: TooltipMapData, x: number, y: number): Promise<any> {
    const cacheKey = `${data.world.id}:${data.tile_info_updated_at || 0}:${x},${y}`;
    const cached = this.tileInfoCache.get(cacheKey);
    if (cached) return cached;

    try {
      const query = new URLSearchParams({
        world: String(data.world.id ?? ''),
        x: String(x),
        y: String(y),
      });
      const response = await fetch(`/api/world-map/tile-info?${query}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const info = await response.json();
      this.tileInfoCache.set(cacheKey, info);
      if (this.tileInfoCache.size > 500) {
        this.tileInfoCache.delete(this.tileInfoCache.keys().next().value);
      }
      return info;
    } catch {
      return { x, y, unavailable: true };
    }
  }

  private objectAt(
    x: number,
    y: number,
    data: TooltipMapData,
    scale: number,
  ): TooltipObject | null {
    const isNear = (objectX: number, objectY: number, radius: number): boolean =>
      Math.abs(x - objectX) * scale <= radius && Math.abs(y - objectY) * scale <= radius;

    for (const death of data.deaths || []) {
      const deathX = Number(death.x) + 0.5;
      const deathY = Number(death.y) + 0.5;
      if (isNear(deathX, deathY, 18)) {
        return {
          key: `death:${death.id}`,
          title: `Место смерти: ${death.name || 'Игрок'}`,
          description: `Плитка ${Math.floor(deathX)}, ${Math.floor(deathY)}`,
        };
      }
    }

    for (const coin of data.coins || []) {
      const coinX = Number(coin.x) + 0.5;
      const coinY = Number(coin.y) + 0.5;
      if (isNear(coinX, coinY, 16)) {
        return {
          key: `coin:${coin.id}:${coin.type}`,
          title: `${coin.name || 'Монета'} × ${Number(coin.stack || 0).toLocaleString('ru-RU')}`,
          description: `Выпала на земле — плитка ${Math.floor(coinX)}, ${Math.floor(coinY)}`,
        };
      }
    }

    for (const entity of data.active_npcs || []) {
      const entityX = Number(entity.x) + 0.5;
      const entityY = Number(entity.y) + 0.5;
      if (isNear(entityX, entityY, entity.boss ? 22 : 18)) {
        return {
          key: `entity:${entity.id}`,
          title: entity.name || (entity.boss ? 'Босс' : 'NPC'),
          description: `${entity.boss ? 'Босс' : 'NPC'} — плитка ${Math.floor(entityX)}, ${Math.floor(entityY)}`,
        };
      }
    }

    for (const pylon of data.pylons || []) {
      const type = String(pylon.type || '');
      const details = MapEntityLayer.pylonDetails(type) || [`${type || 'Пилон'}`];
      if (isNear(Number(pylon.x) + 0.5, Number(pylon.y) + 0.5, 20)) {
        return {
          key: `pylon:${pylon.x},${pylon.y}`,
          title: details[0],
          description: `Пилон биома — плитка ${pylon.x}, ${pylon.y}`,
        };
      }
    }

    for (const player of data.players || []) {
      if (player.online !== true) continue;
      const point = this.bindings.getPlayerPoint(player);
      if (point && isNear(point.x, point.y, 20)) {
        const rawSessionSeconds = Number(player.session_seconds);
        return {
          key: `player:${player.id}`,
          title: player.name || 'Игрок',
          description: `Плитка ${Math.floor(point.x)}, ${Math.floor(point.y)}`,
          playerId: String(player.id),
          sessionSeconds:
            player.session_seconds !== null &&
            player.session_seconds !== undefined &&
            Number.isFinite(rawSessionSeconds)
              ? rawSessionSeconds
              : null,
        };
      }
    }

    const spawnX = Number(data.world?.spawn_x);
    const spawnY = Number(data.world?.spawn_y);
    if (
      Number.isFinite(spawnX) &&
      Number.isFinite(spawnY) &&
      isNear(spawnX + 0.5, spawnY + 0.5, 17)
    ) {
      return {
        key: 'spawn',
        title: 'Точка появления игрока',
        description: `Место появления в мире — плитка ${spawnX}, ${spawnY}`,
      };
    }

    return null;
  }

  private formatGameTime(seconds: number): string {
    const totalMinutes = Math.floor(Math.max(0, seconds) / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
  }

  private async getPlayerSessionSeconds(playerId: string): Promise<number | null> {
    const cacheIsFresh =
      this.playerSessionCache !== null && Date.now() - this.playerSessionCache.fetchedAt < 10_000;
    if (!cacheIsFresh) {
      this.playerSessionRequest ??= this.loadPlayerSessions().finally(() => {
        this.playerSessionRequest = null;
      });
      const secondsByPlayerId = await this.playerSessionRequest;
      if (secondsByPlayerId) {
        this.playerSessionCache = { fetchedAt: Date.now(), secondsByPlayerId };
      }
    }
    return this.playerSessionCache?.secondsByPlayerId.get(playerId) ?? null;
  }

  private async loadPlayerSessions(): Promise<Map<string, number> | null> {
    try {
      // The map endpoint stays compact; fetch session history only when a player tooltip is opened.
      const response = await fetch('/api/section-data?section=players', { cache: 'no-store' });
      if (!response.ok) return null;
      const data = await response.json();
      const secondsByPlayerId = new Map<string, number>();
      for (const player of data.players || []) {
        const sessions = Array.isArray(player.sessions) ? player.sessions : [];
        const activeSession = sessions.at(-1);
        if (!activeSession || activeSession.ended_at !== null) continue;
        const seconds = Number(activeSession.duration_seconds);
        if (Number.isFinite(seconds)) secondsByPlayerId.set(String(player.id), seconds);
      }
      return secondsByPlayerId;
    } catch {
      return null;
    }
  }

  private show(
    cursor: { clientX: number; clientY: number },
    title: string,
    description: string,
  ): void {
    const tooltip = this.bindings.tooltip;
    const titleElement = tooltip.querySelector('strong');
    const descriptionElement = tooltip.querySelector('span');
    if (!titleElement || !descriptionElement) return;

    titleElement.textContent = title;
    descriptionElement.textContent = description;
    tooltip.hidden = false;

    const bounds = tooltip.getBoundingClientRect();
    const margin = 12;
    tooltip.style.left = `${Math.max(margin, Math.min(innerWidth - bounds.width - margin, cursor.clientX + 14))}px`;
    tooltip.style.top = `${Math.max(margin, Math.min(innerHeight - bounds.height - margin, cursor.clientY + 14))}px`;
  }
}
