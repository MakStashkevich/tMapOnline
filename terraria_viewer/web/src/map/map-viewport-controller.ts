import { MapZoomControls } from './map-zoom-controls';

type WorldPoint = { x: number; y: number };
type PointerPosition = { x: number; y: number };
type DragStart = PointerPosition & { left: number; top: number };
type PinchStart = WorldPoint & { distance: number; scale: number };
type PinchUpdate = { scale: number; anchorX: number; anchorY: number };

export type MapViewportBindings = {
  getScale(): number;
  setScale(scale: number, anchorX?: number, anchorY?: number): void;
  worldPointAt(anchorX: number, anchorY: number): WorldPoint;
  placeWorldPoint(x: number, y: number, anchorX: number, anchorY: number): void;
  hideTooltip(): void;
  scheduleTooltip(event: PointerEvent): void;
  fitMap(): void;
  resizeViewport(): void;
  renderVisibleChunks(): void;
  prioritizeWorldPoint?(point: WorldPoint): void;
  downloadMapImage(): void;
  onMapPing?(point: WorldPoint): void;
};

/** Owns map zoom, drag, pinch, and viewport-related browser events. */
export class MapViewportController {
  private readonly pointers = new Map<number, PointerPosition>();
  private pinchStart: PinchStart | null = null;
  private dragStart: DragStart | null = null;
  private resizeFrame: number | null = null;
  private pinchFrame: number | null = null;
  private pendingPinchUpdate: PinchUpdate | null = null;
  private lastTap: { at: number; x: number; y: number } | null = null;
  private readonly zoomControls = new MapZoomControls();

  constructor(
    private readonly viewport: HTMLElement,
    private readonly bindings: MapViewportBindings,
  ) {}

  bind(): void {
    this.zoomControls.bind(
      () => this.zoomBy(1.4),
      () => this.zoomBy(1 / 1.4),
      this.bindings.fitMap,
    );
    document
      .getElementById('download-map')
      ?.addEventListener('click', this.bindings.downloadMapImage);

    this.viewport.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    this.viewport.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.viewport.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.viewport.addEventListener('pointerup', (event) => this.onPointerEnd(event));
    this.viewport.addEventListener('pointercancel', (event) => this.onPointerEnd(event));
    this.viewport.addEventListener('pointerleave', (event) => this.onPointerLeave(event));
    this.viewport.addEventListener('scroll', this.bindings.renderVisibleChunks, {
      passive: true,
    });
    window.addEventListener('resize', this.onResize);
    window.visualViewport?.addEventListener('resize', this.onResize);
  }

  setZoomLabel(value: string): void {
    this.zoomControls.setLevel(value);
  }

  private zoomBy(multiplier: number): void {
    const anchorX = this.viewport.clientWidth / 2;
    const anchorY = this.viewport.clientHeight / 2;
    this.bindings.prioritizeWorldPoint?.(this.bindings.worldPointAt(anchorX, anchorY));
    this.bindings.setScale(this.bindings.getScale() * multiplier, anchorX, anchorY);
  }

  private onWheel(event: WheelEvent): void {
    this.bindings.hideTooltip();
    event.preventDefault();

    const viewportBounds = this.viewport.getBoundingClientRect();
    const anchorX = event.clientX - viewportBounds.left;
    const anchorY = event.clientY - viewportBounds.top;
    this.bindings.prioritizeWorldPoint?.(this.bindings.worldPointAt(anchorX, anchorY));
    const multiplier = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    this.bindings.setScale(this.bindings.getScale() * multiplier, anchorX, anchorY);
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    event.preventDefault();
    if (event.pointerType === 'mouse') this.bindings.hideTooltip();
    else this.bindings.scheduleTooltip(event);

    this.viewport.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.pointers.size === 2) {
      this.beginPinch();
      return;
    }

    this.beginDrag(event.clientX, event.clientY);
  }

  private beginPinch(): void {
    const [first, second] = [...this.pointers.values()];
    const bounds = this.viewport.getBoundingClientRect();
    const anchorX = (first.x + second.x) / 2 - bounds.left;
    const anchorY = (first.y + second.y) / 2 - bounds.top;

    // Keep the point between the fingers fixed while the map scales around it.
    this.pinchStart = {
      distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
      scale: this.bindings.getScale(),
      ...this.bindings.worldPointAt(anchorX, anchorY),
    };
    this.dragStart = null;
  }

  private beginDrag(clientX: number, clientY: number): void {
    this.dragStart = {
      x: clientX,
      y: clientY,
      left: this.viewport.scrollLeft,
      top: this.viewport.scrollTop,
    };
    this.viewport.classList.add('dragging');
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.pointers.has(event.pointerId)) {
      if (event.pointerType === 'mouse' || event.pointerType === 'pen') {
        this.bindings.scheduleTooltip(event);
      }
      return;
    }

    if (event.pointerType !== 'mouse') this.bindings.scheduleTooltip(event);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (
      this.dragStart &&
      Math.hypot(event.clientX - this.dragStart.x, event.clientY - this.dragStart.y) > 12
    ) {
      this.lastTap = null;
    }

    if (this.pointers.size >= 2 && this.pinchStart) {
      this.updatePinch();
    } else if (this.dragStart && this.pointers.size === 1) {
      this.viewport.scrollLeft = this.dragStart.left - (event.clientX - this.dragStart.x);
      this.viewport.scrollTop = this.dragStart.top - (event.clientY - this.dragStart.y);
    }
  }

  private updatePinch(): void {
    const [first, second] = [...this.pointers.values()];
    const currentDistance = Math.hypot(first.x - second.x, first.y - second.y);
    const bounds = this.viewport.getBoundingClientRect();
    const anchorX = (first.x + second.x) / 2 - bounds.left;
    const anchorY = (first.y + second.y) / 2 - bounds.top;

    this.pendingPinchUpdate = {
      scale: (this.pinchStart!.scale * currentDistance) / this.pinchStart!.distance,
      anchorX,
      anchorY,
    };
    if (this.pinchFrame !== null) return;

    this.pinchFrame = requestAnimationFrame(() => {
      this.pinchFrame = null;
      this.applyPendingPinchUpdate();
    });
  }

  private applyPendingPinchUpdate(): void {
    const update = this.pendingPinchUpdate;
    this.pendingPinchUpdate = null;
    if (!update || !this.pinchStart) return;

    this.bindings.prioritizeWorldPoint?.({ x: this.pinchStart.x, y: this.pinchStart.y });
    this.bindings.setScale(update.scale);
    this.bindings.placeWorldPoint(
      this.pinchStart.x,
      this.pinchStart.y,
      update.anchorX,
      update.anchorY,
    );
  }

  private onPointerEnd(event: PointerEvent): void {
    this.flushPendingPinchUpdate();
    const endedPointer = this.pointers.get(event.pointerId);
    const dragStart = this.dragStart;
    const wasTap =
      event.type === 'pointerup' &&
      endedPointer !== undefined &&
      dragStart !== null &&
      Math.hypot(endedPointer.x - dragStart.x, endedPointer.y - dragStart.y) <= 12;
    this.pointers.delete(event.pointerId);

    if (this.pointers.size === 1) {
      const remainingPointer = [...this.pointers.values()][0];
      this.pinchStart = null;
      this.beginDrag(remainingPointer.x, remainingPointer.y);
      return;
    }

    if (this.pointers.size === 0) {
      if (wasTap && dragStart) this.detectMapPing(event, dragStart);
      this.pinchStart = null;
      this.dragStart = null;
      this.viewport.classList.remove('dragging');
    }
  }

  private flushPendingPinchUpdate(): void {
    if (this.pinchFrame !== null) {
      cancelAnimationFrame(this.pinchFrame);
      this.pinchFrame = null;
    }
    this.applyPendingPinchUpdate();
  }

  private detectMapPing(event: PointerEvent, start: DragStart): void {
    if (!this.bindings.onMapPing) return;
    const now = performance.now();
    const bounds = this.viewport.getBoundingClientRect();
    const tapX = (start.x + event.clientX) / 2;
    const tapY = (start.y + event.clientY) / 2;
    const previous = this.lastTap;
    this.lastTap = { at: now, x: tapX, y: tapY };
    if (
      !previous ||
      now - previous.at > 500 ||
      Math.hypot(tapX - previous.x, tapY - previous.y) > 28
    ) {
      return;
    }

    this.lastTap = null;
    this.bindings.onMapPing(this.bindings.worldPointAt(tapX - bounds.left, tapY - bounds.top));
  }

  private onPointerLeave(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && !this.pointers.has(event.pointerId)) {
      this.bindings.hideTooltip();
    }
  }

  private readonly onResize = (): void => {
    if (this.resizeFrame !== null) return;
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = null;
      this.bindings.resizeViewport();
    });
  };
}
