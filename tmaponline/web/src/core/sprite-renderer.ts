const imagePromises = new Map<string, Promise<HTMLImageElement | null>>();
const SPRITE_LOAD_RETRY_DELAYS_MS = [150, 400, 900];

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

  const request = loadSpriteWithRetry(source);
  imagePromises.set(source, request);
  void request.then((image) => {
    // Do not cache failures: a transient request error should not hide a sprite forever.
    if (!image && imagePromises.get(source) === request) imagePromises.delete(source);
  });
  return request;
}

async function loadSpriteWithRetry(source: string): Promise<HTMLImageElement | null> {
  for (let attempt = 0; attempt <= SPRITE_LOAD_RETRY_DELAYS_MS.length; attempt += 1) {
    const image = await loadImage(source, attempt);
    if (image) return image;

    const retryDelay = SPRITE_LOAD_RETRY_DELAYS_MS[attempt];
    if (retryDelay !== undefined) await delay(retryDelay);
  }

  return null;
}

function loadImage(source: string, attempt: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image.naturalWidth > 0 ? image : null);
    image.onerror = () => resolve(null);
    image.src = retryUrl(source, attempt);

    if (image.complete && image.naturalWidth > 0) resolve(image);
  });
}

function retryUrl(source: string, attempt: number): string {
  if (attempt === 0 || source.startsWith('data:')) return source;

  try {
    const url = new URL(source, window.location.href);
    url.searchParams.set('_sprite_retry', String(attempt));
    return url.href;
  } catch {
    return source;
  }
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs));
}

export function playerOutlineColor(team: number | null | undefined): string {
  return TEAM_COLORS[Number(team)] || TEAM_COLORS[0];
}

/** Build the same two contour-only outline passes used by the map markers. */
export function createOutlinedSprite(
  source: HTMLImageElement,
  innerOutlineColor: string,
): HTMLImageElement | null {
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

  // Keep a stable image surface for Safari instead of leaving a canvas in the live marker layer.
  const sprite = new Image();
  sprite.alt = '';
  sprite.decoding = 'async';
  sprite.src = canvas.toDataURL('image/png');
  return sprite;
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
