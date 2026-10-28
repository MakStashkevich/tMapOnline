type RoutePoint = { x: number; y: number };
type RoutePlayer = { id: string; routeTracks: RoutePoint[][] };
type PlayerIdentity = { id: string };

/** Draws movement history while leaving teleport-aware exploration to MapPlayerPathService. */
export class MapRouteLayer {
  constructor(
    private readonly layer: SVGElement,
    private readonly colors: string[],
  ) {}

  render(players: RoutePlayer[], allPlayers: PlayerIdentity[]): void {
    this.layer.replaceChildren();

    players.forEach((player) => {
      const colorIndex = allPlayers.findIndex((item) => item.id === player.id);
      const color = this.colors[colorIndex % this.colors.length];

      for (const track of player.routeTracks) {
        if (!track.length) continue;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-width', '2.5');
        if (track.length === 1) {
          path.setAttribute('d', `M ${track[0].x + 0.5} ${track[0].y + 0.5} l .01 0`);
        } else {
          path.setAttribute(
            'd',
            track
              .map((point, index) => `${index ? 'L' : 'M'} ${point.x + 0.5} ${point.y + 0.5}`)
              .join(' '),
          );
        }
        this.layer.append(path);
      }
    });
  }
}
