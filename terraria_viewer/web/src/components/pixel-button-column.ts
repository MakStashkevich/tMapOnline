/** Reusable Terraria-style panel for vertically arranged pixel buttons. */
export class PixelButtonColumn {
  constructor(readonly element: HTMLElement) {
    this.element.classList.add('pixel-button-column');
  }

  replaceChildren(...children: Node[]): void {
    this.element.replaceChildren(...children);
  }

  append(child: Node): void {
    this.element.append(child);
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
  }

  centerOn(anchor: HTMLElement, bounds: HTMLElement): void {
    const boundsRect = bounds.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const columnHeight = this.element.getBoundingClientRect().height;
    const anchorCenter = anchorRect.top + anchorRect.height / 2 - boundsRect.top;
    const maxTop = Math.max(0, boundsRect.height - columnHeight);
    const top = Math.min(maxTop, Math.max(0, anchorCenter - columnHeight / 2));
    this.element.style.top = `${top}px`;
  }

  resetPosition(): void {
    this.element.style.removeProperty('top');
  }
}
