type MapPosition = { x: number; y: number; time: number; teleport: boolean };
type PlayerPaths = { routeTracks: MapPosition[][]; exploreTracks: MapPosition[][] };
type PlayerWithPositions = { id: string; positions?: any[]; [field: string]: any };
type WorldSize = { width: number; height: number };

type CachedPlayerPaths = PlayerPaths & { key: string };

/** Normalizes player history and separates map exploration at teleport boundaries. */
export class MapPlayerPathService {
  private readonly pathCache = new Map<string, CachedPlayerPaths>();

  clear(): void {
    this.pathCache.clear();
  }

  withPaths<TPlayer extends PlayerWithPositions>(
    players: TPlayer[],
    world: WorldSize,
  ): (TPlayer & PlayerPaths & { pathKey: string })[] {
    return players.map((player) => {
      const positions = Array.isArray(player.positions) ? player.positions : [];
      const last = positions.at(-1);
      const pathKey = `${positions.length}:${last?.time}:${last?.x}:${last?.y}`;
      const cached = this.pathCache.get(player.id);
      if (cached?.key === pathKey) {
        return {
          ...player,
          routeTracks: cached.routeTracks,
          exploreTracks: cached.exploreTracks,
          pathKey,
        };
      }

      const paths = this.buildPaths(player, world);
      this.pathCache.set(player.id, { key: pathKey, ...paths });
      return { ...player, ...paths, pathKey };
    });
  }

  private buildPaths(player: PlayerWithPositions, world: WorldSize): PlayerPaths {
    const points = (Array.isArray(player.positions) ? player.positions : [])
      .map((position) => ({
        x: Number(position.x),
        y: Number(position.y),
        time: Number(position.time),
        teleport: position.teleport === true,
      }))
      .filter(
        (position) =>
          Number.isFinite(position.x) &&
          Number.isFinite(position.y) &&
          position.x >= 0 &&
          position.y >= 0 &&
          position.x < world.width &&
          position.y < world.height,
      );

    if (!points.length) return { routeTracks: [], exploreTracks: [] };

    // Keep teleport jumps visible as route lines, but split exploration so the jump never reveals the map between endpoints.
    const routeTracks = [points];
    const exploreTracks: MapPosition[][] = [];
    let previous = points[0];
    let track = [previous];
    let teleportArrival: MapPosition | null = null;

    for (const point of points.slice(1)) {
      const elapsed = point.time - previous.time;
      const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
      const worldScaleJump = distance > Math.max(1000, world.width * 0.35);
      const suddenJump = distance >= 250 && elapsed <= 15 && distance / Math.max(elapsed, 1) >= 45;
      const isTeleport = point.teleport || worldScaleJump || suddenJump;
      point.teleport = isTeleport;

      if (isTeleport || elapsed <= 0) {
        if (track.length) exploreTracks.push(track);
        track = [];
        teleportArrival = point;
      } else {
        if (!track.length) track = teleportArrival ? [teleportArrival, point] : [previous, point];
        else track.push(point);
        teleportArrival = null;
      }
      previous = point;
    }

    if (track.length) exploreTracks.push(track);
    return { routeTracks, exploreTracks };
  }
}
