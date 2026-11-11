type ExportWorld = { id: string | number; name?: string; width: number; height: number };

type MapImageExporterOptions = {
  button: HTMLButtonElement;
  getWorld: () => ExportWorld | null;
  getProfile: () => string | null;
  onError: (error: unknown) => void;
};

const TILE_SIZE = 256;

/** Downloads a full-resolution image assembled from the active server-rendered map profile. */
export class MapImageExporter {
  constructor(private readonly options: MapImageExporterOptions) {}

  async download(): Promise<void> {
    const { button } = this.options;
    const defaultLabel = 'Скачать PNG';
    button.disabled = true;

    try {
      const world = this.options.getWorld();
      if (!world) throw new Error('Данные карты ещё не загружены.');

      const canvas = document.createElement('canvas');
      canvas.width = world.width;
      canvas.height = world.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Браузер не смог создать изображение карты.');

      context.fillStyle = '#05090d';
      context.fillRect(0, 0, canvas.width, canvas.height);

      const columns = Math.ceil(world.width / TILE_SIZE);
      const rows = Math.ceil(world.height / TILE_SIZE);
      const total = columns * rows;
      let completed = 0;

      for (let tileY = 0; tileY < rows; tileY += 1) {
        for (let tileX = 0; tileX < columns; tileX += 1) {
          const query = new URLSearchParams({
            world: String(world.id),
            level: '0',
            x: String(tileX),
            y: String(tileY),
          });
          const profile = this.options.getProfile();
          if (profile) query.set('profile', profile);

          const response = await fetch(`/api/world-map/tile?${query}`, { cache: 'default' });
          if (!response.ok)
            throw new Error(`Не удалось получить PNG-чанк: HTTP ${response.status}`);

          const bitmap = await createImageBitmap(await response.blob());
          context.drawImage(bitmap, tileX * TILE_SIZE, tileY * TILE_SIZE);
          bitmap.close();

          completed += 1;
          button.textContent = `${Math.round((completed / total) * 100)}%`;
        }
      }

      const blob = await this.toBlob(canvas);
      this.saveBlob(blob, world.name || 'terraria-world');
    } catch (error) {
      this.options.onError(error);
    } finally {
      button.textContent = defaultLabel;
      button.disabled = false;
    }
  }

  private toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Не удалось сформировать PNG.'))),
        'image/png',
      );
    });
  }

  private saveBlob(blob: Blob, worldName: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeName = String(worldName).replace(/[^\p{L}\p{N}_-]+/gu, '_');
    link.href = url;
    link.download = `${safeName}-map.png`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
