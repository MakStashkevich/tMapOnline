import { PixelButton } from '../components/pixel-button';

export class MapZoomControls {
  private readonly root = document.querySelector<HTMLElement>('#zoom-tools')!;
  private readonly level = this.root.querySelector<HTMLElement>('#zoom-level')!;

  bind(onZoomIn: () => void, onZoomOut: () => void, onFit: () => void): void {
    const zoomIn = this.root.querySelector<HTMLButtonElement>('#zoom-in');
    const zoomOut = this.root.querySelector<HTMLButtonElement>('#zoom-out');
    const fit = document.querySelector<HTMLButtonElement>('#fit');
    const download = document.querySelector<HTMLButtonElement>('#download-map');
    if (zoomIn) PixelButton.adopt(zoomIn, 'icon');
    if (zoomOut) PixelButton.adopt(zoomOut, 'icon');
    if (fit) PixelButton.adopt(fit, 'text');
    if (download) PixelButton.adopt(download, 'text');
    zoomIn?.addEventListener('click', onZoomIn);
    zoomOut?.addEventListener('click', onZoomOut);
    fit?.addEventListener('click', onFit);
  }

  setLevel(value: string): void {
    this.level.textContent = value;
  }
}
