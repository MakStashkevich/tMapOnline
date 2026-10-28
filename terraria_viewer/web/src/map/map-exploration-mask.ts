type TilePoint = { x: number; y: number };
type ExplorationPlayer = { id: string; exploreTracks: TilePoint[][] };

/** Converts imported maps and player routes into the map's quarter-scale visibility mask. */
export class MapExplorationMask {
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly scale: number,
  ) {}

  rebuild(players: ExplorationPlayer[], importedMaps: Map<string, ImageBitmap>): number {
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Could not create the exploration mask canvas context.');

    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Imported map files already use quarter-scale world coordinates.
    // Route points are tile-based, so only those paths need a scaled context.
    for (const player of players) {
      const importedMap = importedMaps.get(player.id);
      if (importedMap) context.drawImage(importedMap, 0, 0, this.canvas.width, this.canvas.height);
    }

    context.save();
    context.scale(this.scale, this.scale);
    for (const player of players) {
      for (const track of player.exploreTracks) {
        if (!track.length) continue;

        context.beginPath();
        track.forEach((point, index) => {
          if (index === 0) context.moveTo(point.x + 0.5, point.y + 0.5);
          else context.lineTo(point.x + 0.5, point.y + 0.5);
        });
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.globalCompositeOperation = 'lighter';

        for (const [width, alpha] of [
          [40, 0.08],
          [32, 0.15],
          [24, 0.32],
          [16, 0.62],
          [8, 1],
        ]) {
          context.strokeStyle = `rgba(255,255,255,${alpha})`;
          context.lineWidth = width;
          context.stroke();
        }
      }
    }
    context.restore();

    return this.measureExploredPercent(context);
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
