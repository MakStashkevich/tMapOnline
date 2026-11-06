import { createOutlinedSprite, loadSprite } from '../core/sprite-renderer';

type BossSprite = {
  id: number;
  name: string;
  icon_url: string;
};

const TERRARIA_BOSSES_WIKI = 'https://terraria.wiki.gg/ru/wiki/Боссы';

export async function mount(root: HTMLElement): Promise<void> {
  const response = await fetch('/api/section-data?section=bosses', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const payload = (await response.json()) as { bosses?: BossSprite[] };
  const bosses = payload.bosses || [];
  root.replaceChildren();

  const wikiLink = document.createElement('a');
  wikiLink.className = 'boss-wiki-link';
  wikiLink.href = TERRARIA_BOSSES_WIKI;
  wikiLink.textContent = 'Открыть страницу боссов Terraria Wiki';
  root.append(wikiLink);

  if (!bosses.length) {
    const empty = document.createElement('p');
    empty.className = 'section-empty';
    empty.textContent = 'Сейчас в мире нет активных боссов.';
    root.append(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'boss-list';

  for (const boss of bosses) {
    const link = document.createElement('a');
    link.className = 'boss-row';
    link.href = TERRARIA_BOSSES_WIKI;
    link.title = 'Открыть страницу боссов Terraria Wiki';

    const spriteFrame = document.createElement('span');
    spriteFrame.className = 'boss-sprite-frame';
    void loadSprite(boss.icon_url).then((source) => {
      if (!source || !link.isConnected) return;
      const sprite = createOutlinedSprite(source, '#ffffff');
      if (sprite) {
        sprite.className = 'boss-sprite';
        spriteFrame.replaceChildren(sprite);
      }
    });

    const name = document.createElement('span');
    name.textContent = boss.name || 'Босс';

    link.append(spriteFrame, name);
    list.append(link);
  }

  root.append(list);
}
