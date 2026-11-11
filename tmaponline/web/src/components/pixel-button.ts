export type PixelButtonVariant = 'icon' | 'text';

export type PixelButtonOptions = {
  label: string;
  variant: PixelButtonVariant;
  classes?: string[];
  pressed?: boolean;
  icon?: Node;
  text?: string;
  content?: Node;
};

/** Owns the shared accessible behavior and base styling contract for pixel UI buttons. */
export class PixelButton {
  private constructor(readonly element: HTMLButtonElement) {}

  static create(options: PixelButtonOptions): PixelButton {
    const element = document.createElement('button');
    element.type = 'button';
    element.classList.add(
      'pixel-button',
      `pixel-${options.variant}-button`,
      ...(options.classes ?? []),
    );
    element.setAttribute('aria-label', options.label);
    if (options.pressed !== undefined) {
      element.setAttribute('aria-pressed', String(options.pressed));
    }
    if (options.variant === 'text' && (options.icon || options.text)) {
      if (options.icon) {
        const icon = document.createElement('span');
        icon.className = 'pixel-button-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.append(options.icon);
        element.append(icon);
      }
      if (options.text) {
        const text = document.createElement('span');
        text.className = 'pixel-button-label';
        text.textContent = options.text;
        element.append(text);
      }
    } else if (options.content) {
      element.append(options.content);
    }
    return new PixelButton(element);
  }

  static adopt(element: HTMLButtonElement, variant?: PixelButtonVariant): PixelButton {
    element.classList.add('pixel-button');
    const hasIconAndLabel = element.querySelector('img') && element.querySelector('span');
    const resolvedVariant = variant ?? (hasIconAndLabel ? 'text' : 'icon');
    element.classList.add(`pixel-${resolvedVariant}-button`);
    return new PixelButton(element);
  }

  setPressed(pressed: boolean): void {
    this.element.setAttribute('aria-pressed', String(pressed));
    this.element.classList.toggle('active', pressed);
  }
}
