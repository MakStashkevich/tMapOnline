export type MapPing = {
  id: string;
  player_name?: string;
  playerName?: string;
  x: number;
  y: number;
  timestamp?: number;
  source?: string;
};

/** Displays native Terraria map-ping frames for their fifteen-second lifetime. */
export class MapPingLayer {
  private readonly markers = new Map<string, HTMLDivElement>();
  private width = 0;
  private height = 0;
  private worldId: string | null = null;

  constructor(private readonly root: HTMLElement) {}

  setWorld(width: number, height: number, worldId: string | number | null): void {
    const nextWorldId = worldId === null ? null : String(worldId);
    if (this.worldId !== nextWorldId) this.clear();
    this.worldId = nextWorldId;
    this.width = width;
    this.height = height;
  }

  add(ping: MapPing): void {
    if (
      !ping.id ||
      this.markers.has(ping.id) ||
      !Number.isFinite(ping.x) ||
      !Number.isFinite(ping.y) ||
      this.width <= 0 ||
      this.height <= 0 ||
      ping.x < 0 ||
      ping.y < 0 ||
      ping.x >= this.width ||
      ping.y >= this.height
    ) {
      return;
    }

    const marker = document.createElement('div');
    marker.className = 'map-ping-marker';
    marker.style.left = `${(ping.x / this.width) * 100}%`;
    marker.style.top = `${(ping.y / this.height) * 100}%`;
    const name = ping.player_name || ping.playerName || 'Игрок';
    marker.title = `Пинг: ${name}`;
    marker.setAttribute('aria-label', `Пинг игрока ${name}`);
    marker.innerHTML = '<span class="map-ping-sprite" aria-hidden="true"></span>';
    this.root.append(marker);
    this.markers.set(ping.id, marker);

    const timestamp = Number(ping.timestamp) * 1000;
    const age = Number.isFinite(timestamp) && timestamp > 0 ? Date.now() - timestamp : 0;
    const remainingMs = Math.max(0, 15_000 - age);
    if (remainingMs <= 0) {
      this.remove(ping.id);
      return;
    }

    window.setTimeout(() => marker.classList.add('fading'), Math.max(0, remainingMs - 2_500));
    window.setTimeout(() => this.remove(ping.id), remainingMs);
  }

  clear(): void {
    for (const marker of this.markers.values()) marker.remove();
    this.markers.clear();
  }

  private remove(id: string): void {
    this.markers.get(id)?.remove();
    this.markers.delete(id);
  }
}
