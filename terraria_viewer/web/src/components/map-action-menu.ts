import { createPixelArtIcon, type PixelArtIconName } from './pixel-art-icon';
import { PixelButton } from './pixel-button';
import { PixelButtonColumn } from './pixel-button-column';

export type MapAction = { id: string; label: string; icon: PixelArtIconName; view?: string };
export type MapCategory = {
  id: string;
  label: string;
  icon: PixelArtIconName;
  actions: MapAction[];
};

export class MapActionMenu {
  private readonly root = document.querySelector<HTMLElement>('#map-action-menu')!;
  private readonly categoryColumn = new PixelButtonColumn(
    document.querySelector<HTMLElement>('#map-category-list')!,
  );
  private readonly submenuColumn = new PixelButtonColumn(
    document.querySelector<HTMLElement>('#map-submenu')!,
  );
  private readonly toggle = document.querySelector<HTMLButtonElement>('#map-menu-toggle')!;
  private readonly toggleButton = PixelButton.adopt(this.toggle);
  private readonly tooltip = document.querySelector<HTMLElement>('#map-menu-tooltip')!;
  private selectedCategory: string | null = null;
  private expanded = false;

  constructor(private readonly onAction: (action: MapAction, trigger: HTMLElement) => void) {
    this.toggleButton.setPressed(false);
    this.toggle.setAttribute('aria-label', 'Настройки карты');
    this.toggle.dataset.tooltip = 'Настройки карты';
    this.bindToggleTooltip();
    this.toggle.addEventListener('click', () => this.setExpanded(!this.expanded));
    document.addEventListener('click', (event) => {
      if (this.expanded && !this.root.contains(event.target as Node)) this.setExpanded(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.setExpanded(false);
    });
  }

  render(categories: MapCategory[]): void {
    this.categoryColumn.replaceChildren();
    for (const category of categories) {
      const button = PixelButton.create({
        label: category.label,
        variant: 'icon',
        classes: ['map-category-button'],
        pressed: false,
        content: createPixelArtIcon(category.icon),
      }).element;
      button.dataset.category = category.id;
      button.setAttribute('aria-pressed', 'false');
      this.bindTooltip(button, category.label);
      button.addEventListener('click', () => this.selectCategory(category));
      this.categoryColumn.append(button);
    }
  }

  private selectCategory(category: MapCategory): void {
    if (category.actions.length < 2) {
      this.selectedCategory = category.id;
      this.submenuColumn.setVisible(false);
      this.submenuColumn.replaceChildren();
      this.submenuColumn.resetPosition();
      this.categoryColumn.element
        .querySelectorAll<HTMLButtonElement>('.active')
        .forEach((item) => PixelButton.adopt(item).setPressed(false));
      const categoryButton = this.categoryColumn.element.querySelector<HTMLButtonElement>(
        `[data-category="${category.id}"]`,
      );
      if (categoryButton) PixelButton.adopt(categoryButton).setPressed(true);
      if (category.actions.length === 1) this.onAction(category.actions[0], this.toggle);
      return;
    }

    if (this.selectedCategory === category.id && !this.submenuColumn.element.hidden) {
      this.selectedCategory = null;
      this.submenuColumn.setVisible(false);
      this.submenuColumn.resetPosition();
      this.categoryColumn.element
        .querySelectorAll<HTMLButtonElement>('.active')
        .forEach((item) => PixelButton.adopt(item).setPressed(false));
      return;
    }
    this.selectedCategory = category.id;
    this.categoryColumn.element
      .querySelectorAll<HTMLButtonElement>('.active')
      .forEach((item) => PixelButton.adopt(item).setPressed(false));
    const categoryButton = this.categoryColumn.element.querySelector<HTMLButtonElement>(
      `[data-category="${category.id}"]`,
    );
    if (categoryButton) PixelButton.adopt(categoryButton).setPressed(true);
    const selectedButton = this.categoryColumn.element.querySelector<HTMLElement>(
      `[data-category="${category.id}"]`,
    );
    const submenuButtons: HTMLButtonElement[] = [];
    for (const action of category.actions) {
      const button = PixelButton.create({
        label: action.label,
        variant: 'icon',
        classes: ['map-submenu-button'],
        pressed: false,
      }).element;
      button.setAttribute('aria-pressed', 'false');
      this.bindTooltip(button, action.label);
      const icon = document.createElement('span');
      icon.className = 'map-submenu-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.append(createPixelArtIcon(action.icon));
      button.append(icon);
      button.addEventListener('click', () => {
        this.submenuColumn.element
          .querySelectorAll<HTMLButtonElement>('[aria-pressed="true"]')
          .forEach((item) => PixelButton.adopt(item).setPressed(false));
        PixelButton.adopt(button).setPressed(true);
        this.onAction(action, this.toggle);
      });
      submenuButtons.push(button);
    }
    this.submenuColumn.replaceChildren(...submenuButtons);
    this.submenuColumn.setVisible(true);
    if (selectedButton) this.submenuColumn.centerOn(selectedButton, this.root);
  }

  private bindTooltip(button: HTMLElement, label: string): void {
    button.addEventListener('pointerenter', (event) => this.showTooltip(label, event));
    button.addEventListener('pointermove', (event) => this.positionTooltip(event));
    button.addEventListener('pointerleave', () => {
      this.tooltip.hidden = true;
    });
    button.addEventListener('focus', () => {
      const bounds = button.getBoundingClientRect();
      this.tooltip.textContent = label;
      this.tooltip.hidden = false;
      this.positionTooltipAt(bounds.right, bounds.top + bounds.height / 2);
    });
    button.addEventListener('blur', () => {
      this.tooltip.hidden = true;
    });
  }

  private showTooltip(label: string, event: PointerEvent): void {
    this.tooltip.textContent = label;
    this.tooltip.hidden = false;
    this.positionTooltip(event);
  }

  private positionTooltip(event: PointerEvent): void {
    this.positionTooltipAt(event.clientX, event.clientY);
  }

  private positionTooltipAt(x: number, y: number): void {
    const edge = 12;
    this.tooltip.style.left = `${Math.min(x + edge, window.innerWidth - this.tooltip.offsetWidth - edge)}px`;
    this.tooltip.style.top = `${Math.min(y + edge, window.innerHeight - this.tooltip.offsetHeight - edge)}px`;
  }

  private setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.root.classList.toggle('expanded', expanded);
    this.toggleButton.setPressed(expanded);
    this.toggle.setAttribute('aria-expanded', String(expanded));
    this.toggle.setAttribute(
      'aria-label',
      expanded ? 'Закрыть настройки карты' : 'Настройки карты',
    );
    this.toggle.dataset.tooltip = expanded ? 'Закрыть настройки карты' : 'Настройки карты';
    if (!expanded) {
      this.submenuColumn.setVisible(false);
      this.submenuColumn.resetPosition();
    }
  }

  private bindToggleTooltip(): void {
    this.toggle.addEventListener('pointerenter', (event) =>
      this.showTooltip(this.toggle.dataset.tooltip ?? 'Настройки карты', event),
    );
    this.toggle.addEventListener('pointermove', (event) => this.positionTooltip(event));
    this.toggle.addEventListener('pointerleave', () => {
      this.tooltip.hidden = true;
    });
    this.toggle.addEventListener('focus', () => {
      const bounds = this.toggle.getBoundingClientRect();
      this.tooltip.textContent = this.toggle.dataset.tooltip ?? 'Настройки карты';
      this.tooltip.hidden = false;
      this.positionTooltipAt(bounds.right, bounds.top + bounds.height / 2);
    });
    this.toggle.addEventListener('blur', () => {
      this.tooltip.hidden = true;
    });
  }
}
