import {
  Activity,
  createIcons,
  Database,
  Download,
  Map,
  Menu,
  Minus,
  Moon,
  Plus,
  Server,
  Settings,
  Skull,
  Sun,
  Users,
  X,
} from 'lucide';

const iconSet = {
  Activity,
  Database,
  Download,
  Map,
  Menu,
  Minus,
  Moon,
  Plus,
  Server,
  Settings,
  Skull,
  Sun,
  Users,
  X,
};

export type IconName = keyof typeof iconSet;

export function renderIcons(root: Element | Document | DocumentFragment = document): void {
  createIcons({ icons: iconSet, root });
}

export function setIcon(element: HTMLElement, name: IconName): void {
  const placeholder = document.createElement('i');
  placeholder.dataset.lucide = name.toLowerCase();
  placeholder.setAttribute('aria-hidden', 'true');
  placeholder.className = 'ui-icon';
  element.replaceChildren(placeholder);
  renderIcons(element);
}
