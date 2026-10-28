type TilePoint = { x: number; y: number };
type ExplorationPlayer = { id: string; exploreTracks: TilePoint[][] };

const OVERWORLD_WINDOW = { width: 96, height: 54 };

/** Converts imported maps and player routes into the map's quarter-scale visibility mask. */
export class MapExplorationMask {
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly scale: number,
  ) {}

  rebuild(
    players: ExplorationPlayer[],
    importedMaps: Map<string, ImageBitmap>,
    surfaceY: number | null,
  ): number {
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Could not create the exploration mask canvas context.');

    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Imported map files already use quarter-scale world coordinates.
    // Route points are tile-based, so only those paths need a scaled context.
    for (const player of players) {
      const importedMap = importedMaps.get(player.id);
      if (importedMap) context.drawImage(importedMap, 0, 0, this.canvas.width, this.canvas.height);
    }

    for (const player of players) {
      for (const track of player.exploreTracks) {
        if (!track.length) continue;

        for (let index = 0; index < track.length; index++) {
          const current = track[index];
          const previous = track[index - 1] ?? current;
          const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
          const tileStep = 1 / this.scale;
          const steps = Math.max(1, Math.ceil(distance / tileStep));

          // Stamp the full in-game view rectangle along the path. A diagonal fall
          // naturally sweeps a wider area than a single camera window.
          for (let step = 0; step <= steps; step++) {
            const progress = step / steps;
            const x = previous.x + (current.x - previous.x) * progress + 0.5;
            const y = previous.y + (current.y - previous.y) * progress + 0.5;
            if (surfaceY !== null && y < surfaceY) {
              this.fillOverworldWindow(context, x, y);
            } else {
              this.drawUndergroundTrail(context, previous, current, step, steps);
            }
          }
        }
      }
    }

    return this.measureExploredPercent(context);
  }

  private fillOverworldWindow(context: CanvasRenderingContext2D, x: number, y: number): void {
    const left = Math.floor((x - OVERWORLD_WINDOW.width / 2) * this.scale);
    const top = Math.floor((y - OVERWORLD_WINDOW.height / 2) * this.scale);
    const width = Math.ceil(OVERWORLD_WINDOW.width * this.scale);
    const height = Math.ceil(OVERWORLD_WINDOW.height * this.scale);

    // Drawing on integer mask pixels keeps the edge hard instead of anti-aliased.
    context.fillStyle = '#fff';
    context.fillRect(left, top, width, height);
  }

  private drawUndergroundTrail(
    context: CanvasRenderingContext2D,
    start: TilePoint,
    end: TilePoint,
    step: number,
    steps: number,
  ): void {
    const progress = step / steps;
    const x = start.x + (end.x - start.x) * progress + 0.5;
    const y = start.y + (end.y - start.y) * progress + 0.5;
    const maskX = Math.round(x * this.scale);
    const maskY = Math.round(y * this.scale);
    const radius = Math.ceil(20 * this.scale);

    // Keep the original narrow underground footprint while the surface uses a view-sized window.
    context.fillStyle = '#fff';
    for (let offsetY = -radius; offsetY <= radius; offsetY++) {
      for (let offsetX = -radius; offsetX <= radius; offsetX++) {
        if (offsetX * offsetX + offsetY * offsetY > radius * radius) continue;
        const pixelX = maskX + offsetX;
        const pixelY = maskY + offsetY;
        if (
          pixelX >= 0 &&
          pixelY >= 0 &&
          pixelX < this.canvas.width &&
          pixelY < this.canvas.height
        ) {
          context.fillRect(pixelX, pixelY, 1, 1);
        }
      }
    }
  }

  private measureExploredPercent(context: CanvasRenderingContext2D): number {
    const pixels = context.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
    let openPixels = 0;
    for (let alphaOffset = 3; alphaOffset < pixels.length; alphaOffset += 4) {
      if (pixels[alphaOffset] >= 32) openPixels++;
    }

    return (openPixels / (this.canvas.width * this.canvas.height)) * 100;
  }
}
