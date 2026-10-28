const imagePromises = new Map<string, Promise<HTMLImageElement | null>>();

// This tiny pixel portrait keeps player lists readable when no appearance has been exported yet.
const DEFAULT_PLAYER_SPRITE =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="24" viewBox="0 0 20 24" shape-rendering="crispEdges">
    <path fill="#49372f" d="M4 2h11v2h2v3h1v8h-2v-2h-2V9H8v3H5v3H2V6h2z"/>
    <path fill="#e6b38a" d="M5 6h10v2h2v7h-2v4H6v-3H4V9h1z"/>
    <path fill="#49372f" d="M5 17h2v2h7v-2h2v4H5z"/>
    <path fill="#547b9d" d="M12 9h2v4h-2z"/>
    <path fill="#ffffff" d="M12 9h1v2h-1z"/>
  </svg>`);

const TEAM_COLORS: Record<number, string> = {
  0: '#ffffff',
  1: '#da3b3b',
  2: '#3bda55',
  3: '#3b95da',
  4: '#f2dd64',
  5: '#e064f2',
};

/** Load and reuse browser image objects so repeated map refreshes use the same decoded sprite. */
export function loadSprite(source: string): Promise<HTMLImageElement | null> {
  if (!source) return Promise.resolve(null);
  const cached = imagePromises.get(source);
  if (cached) return cached;

  const request = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image.naturalWidth > 0 ? image : null);
    image.onerror = () => resolve(null);
    image.src = source;
    if (image.complete && image.naturalWidth > 0) resolve(image);
  });
  imagePromises.set(source, request);
  void request.then((image) => {
    // Do not cache failures: a transient request error should not hide a sprite forever.
    if (!image && imagePromises.get(source) === request) imagePromises.delete(source);
  });
  return request;
}

export function defaultPlayerSprite(): string {
  return DEFAULT_PLAYER_SPRITE;
}

export function playerOutlineColor(team: number | null | undefined): string {
  return TEAM_COLORS[Number(team)] || TEAM_COLORS[0];
}

/** Build the same two contour-only outline passes used by the map markers. */
export function createOutlinedSprite(
  source: HTMLImageElement,
  innerOutlineColor: string,
): HTMLCanvasElement | null {
  if (source.naturalWidth < 1 || source.naturalHeight < 1) return null;

  const padding = 4;
  const canvas = document.createElement('canvas');
  canvas.width = source.naturalWidth + padding * 2;
  canvas.height = source.naturalHeight + padding * 2;
  const context = canvas.getContext('2d');
  if (!context) return null;

  const blackSilhouette = createTintedSilhouette(source, '#000000');
  const teamSilhouette = createTintedSilhouette(source, innerOutlineColor);
  if (!blackSilhouette || !teamSilhouette) return null;

  context.imageSmoothingEnabled = false;
  drawOutlineRing(context, blackSilhouette, padding, 4);
  drawOutlineRing(context, teamSilhouette, padding, 2);
  context.drawImage(source, padding, padding);
  return canvas;
}

function createTintedSilhouette(source: HTMLImageElement, color: string): HTMLCanvasElement | null {
  const silhouette = document.createElement('canvas');
  silhouette.width = source.naturalWidth;
  silhouette.height = source.naturalHeight;
  const context = silhouette.getContext('2d');
  if (!context) return null;

  context.imageSmoothingEnabled = false;
  context.drawImage(source, 0, 0);
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = color;
  context.fillRect(0, 0, silhouette.width, silhouette.height);
  context.globalCompositeOperation = 'source-over';
  return silhouette;
}

function drawOutlineRing(
  destination: CanvasRenderingContext2D,
  silhouette: HTMLCanvasElement,
  padding: number,
  radius: number,
): void {
  for (let offsetY = -radius; offsetY <= radius; offsetY += 2) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 2) {
      if (Math.abs(offsetX) + Math.abs(offsetY) !== radius) continue;
      destination.drawImage(silhouette, padding + offsetX, padding + offsetY);
    }
  }
}
