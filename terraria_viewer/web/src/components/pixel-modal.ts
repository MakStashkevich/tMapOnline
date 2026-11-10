export class PixelModal {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLElement;
  private readonly content: HTMLElement;
  private readonly focusTarget: HTMLElement;
  private readonly tooltip = document.querySelector<HTMLElement>('#map-menu-tooltip');
  private returnFocus: HTMLElement | null = null;

  constructor() {
    this.dialog = document.querySelector<HTMLDialogElement>('#pixel-modal')!;
    this.title = document.querySelector<HTMLElement>('#pixel-modal-title')!;
    this.content = document.querySelector<HTMLElement>('#pixel-section-content')!;
    this.focusTarget = document.querySelector<HTMLElement>('#pixel-modal-content')!;
    this.dialog.querySelector('.pixel-modal-close')?.addEventListener('click', () => this.close());
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.close();
    });
    this.dialog.addEventListener('close', () => {
      if (this.tooltip?.parentElement === this.dialog) document.body.append(this.tooltip);
      document.body.classList.remove('modal-open');
      this.returnFocus?.focus();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.dialog.open) this.close();
    });
  }

  open(title: string, content: HTMLElement, trigger: HTMLElement): void {
    this.returnFocus = trigger;
    this.title.textContent = title;
    this.content.replaceChildren(content);
    if (this.tooltip) this.dialog.append(this.tooltip);
    this.dialog.showModal();
    document.body.classList.add('modal-open');
    this.focusTarget.focus();
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }
}
