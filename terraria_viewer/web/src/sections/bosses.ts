const normalize = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '');
type Boss = {
  id: string;
  name: string;
  alias: string;
  kind: string;
  category?: string;
  wikiBase: string;
  wikiPage: string;
  wiki: string;
  image: string;
};
const vanillaBosses = [
  ['king-slime', 'Король слизней', 'King Slime'],
  ['eye-of-cthulhu', 'Глаз Ктулху', 'Eye of Cthulhu'],
  ['eater-of-worlds', 'Пожиратель миров', 'Eater of Worlds'],
  ['brain-of-cthulhu', 'Мозг Ктулху', 'Brain of Cthulhu'],
  ['queen-bee', 'Королева пчёл', 'Queen Bee'],
  ['deerclops', 'Циклоп-олень', 'Deerclops'],
  ['skeletron', 'Скелетрон', 'Skeletron'],
  ['wall-of-flesh', 'Стена плоти', 'Wall of Flesh'],
  ['queen-slime', 'Королева слизней', 'Queen Slime'],
  ['the-twins', 'Близнецы', 'The Twins'],
  ['the-destroyer', 'Уничтожитель', 'The Destroyer'],
  ['skeletron-prime', 'Скелетрон Прайм', 'Skeletron Prime'],
  ['plantera', 'Плантера', 'Plantera'],
  ['golem', 'Голем', 'Golem'],
  ['duke-fishron', 'Герцог Рыбокрыл', 'Duke Fishron'],
  ['empress-of-light', 'Императрица света', 'Empress of Light'],
  ['lunatic-cultist', 'Лунатик-культист', 'Lunatic Cultist'],
  ['moon-lord', 'Лунный повелитель', 'Moon Lord'],
  ['dark-mage', 'Тёмный маг', 'Dark Mage'],
  ['ogre', 'Огр', 'Ogre'],
  ['betsy', 'Бетси', 'Betsy'],
  ['flying-dutchman', 'Летучий голландец', 'Flying Dutchman'],
  ['mourning-wood', 'Плакучий древень', 'Mourning Wood'],
  ['pumpking', 'Тыквенный король', 'Pumpking'],
  ['everscream', 'Вечновизжащий', 'Everscream'],
  ['santa-nk1', 'Санта-НК1', 'Santa-NK1'],
  ['ice-queen', 'Ледяная королева', 'Ice Queen'],
  ['martian-saucer', 'Марсианская тарелка', 'Martian Saucer'],
  ['solar-pillar', 'Солнечный столп', 'Solar Pillar'],
  ['nebula-pillar', 'Столп туманности', 'Nebula Pillar'],
  ['vortex-pillar', 'Вихревой столп', 'Vortex Pillar'],
  ['stardust-pillar', 'Столп звёздной пыли', 'Stardust Pillar'],
  ['mechdusa', 'Мехдуза', 'Mechdusa'],
].map(([id, name, alias]) => {
  const wikiPage = name.replaceAll(' ', '_');
  return {
    id,
    name,
    alias,
    kind: 'Terraria',
    wikiBase: 'https://terraria.wiki.gg',
    wikiPage,
    wiki: `https://terraria.wiki.gg/ru/wiki/${encodeURIComponent(wikiPage)}`,
    image: '',
  };
});
const calamityMiniBossIds = new Set([
  'giant-clam',
  'cragmaw-mire',
  'great-sand-shark',
  'mauler',
  'nuclear-terror',
]);
const calamityBosses = [
  ['desert-scourge', 'Пустынный бич', 'Desert Scourge'],
  ['crabulon', 'Крабулон', 'Crabulon'],
  ['hive-mind', 'Разум улья', 'The Hive Mind'],
  ['perforators', 'Перфораторы', 'The Perforators'],
  ['slime-god', 'Бог слизней', 'The Slime God'],
  ['cryogen', 'Криоген', 'Cryogen'],
  ['aquatic-scourge', 'Акватический бич', 'Aquatic Scourge'],
  ['brimstone-elemental', 'Серный элементаль', 'Brimstone Elemental'],
  ['calamitas-clone', 'Клон Каламитас', 'Calamitas Clone'],
  ['leviathan-anahita', 'Левиафан и Анахита', 'Leviathan and Anahita'],
  ['astrum-aureus', 'Аструм Ареус', 'Astrum Aureus'],
  ['plaguebringer-goliath', 'Предвестница чумы, Голиаф', 'The Plaguebringer Goliath'],
  ['ravager', 'Разрушитель', 'The Ravager'],
  ['astrum-deus', 'Аструм Деус', 'Astrum Deus'],
  ['profaned-guardians', 'Осквернённые стражи', 'Profaned Guardians'],
  ['dragonfolly', 'Псевдодракон', 'Dragonfolly'],
  ['providence', 'Провиденс, Осквернённая богиня', 'Providence, the Profaned Goddess'],
  ['storm-weaver', 'Штормовой ткач', 'Storm Weaver'],
  ['ceaseless-void', 'Нескончаемая пустота', 'Ceaseless Void'],
  ['signus', 'Сигнус, Посланник Пожирателя', 'Signus, Envoy of the Devourer'],
  ['polterghast', 'Полтергаст', 'Polterghast'],
  ['old-duke', 'Старый герцог', 'The Old Duke'],
  ['devourer-of-gods', 'Пожиратель богов', 'The Devourer of Gods'],
  ['yharon', 'Ярон, Дракон возрождения', 'Yharon, Dragon of Rebirth'],
  ['exo-mechs', 'Экзо-механизмы', 'Exo Mechs'],
  ['supreme-calamitas', 'Высшая ведьма, Каламитас', 'Supreme Witch, Calamitas'],
  ['primordial-wyrm', 'Первозданный змий', 'Primordial Wyrm'],
  ['hecate', 'XB-∞ Геката', 'ХВ-∞ Геката'],
  ['permafrost', 'Высший ультрамаг, Пермафрост', 'Supreme Ultramage, Permafrost'],
  ['lord', 'THE LORDE', 'ЛОРД'],
  ['giant-clam', 'Гигантский моллюск', 'Giant Clam'],
  ['cragmaw-mire', 'Болотистый скалозев', 'Cragmaw Mire'],
  ['great-sand-shark', 'Большая песчаная акула', 'Great Sand Shark'],
  ['mauler', 'Мучитель', 'Mauler'],
  ['nuclear-terror', 'Ядерный террор', 'Nuclear Terror'],
].map(([id, name, alias]) => {
  const wikiPage = { lord: 'ЛОРД', hecate: 'ХВ-∞_Геката' }[id] || name.replaceAll(' ', '_');
  return {
    id,
    name,
    alias,
    kind: 'Calamity',
    category: calamityMiniBossIds.has(id) ? 'mini' : 'boss',
    wikiBase: 'https://calamitymod.wiki.gg',
    wikiPage,
    wiki: `https://calamitymod.wiki.gg/ru/wiki/${encodeURIComponent(wikiPage)}`,
    image: '',
  };
});

const bossCatalog: Boss[] = [...vanillaBosses, ...calamityBosses];
const imageCacheKey = 'terraria-boss-image-urls-v1';
let imageCache = {};
try {
  const stored = JSON.parse(localStorage.getItem(imageCacheKey) || '{}');
  if (stored && typeof stored === 'object') imageCache = stored;
} catch {}
const persistImageCache = () => {
  try {
    localStorage.setItem(imageCacheKey, JSON.stringify(imageCache));
  } catch {}
};
const resolveImage = async (boss: Boss, image: HTMLImageElement) => {
  const valid = (url) => {
    try {
      const parsed = new URL(url);
      return (
        parsed.protocol === 'https:' &&
        (parsed.hostname === 'wiki.gg' || parsed.hostname.endsWith('.wiki.gg')) &&
        parsed.pathname.startsWith('/images/')
      );
    } catch {
      return false;
    }
  };
  let imageUrl = imageCache[boss.id];
  if (!valid(imageUrl)) {
    const endpoint = new URL('/ru/api.php', boss.wikiBase);
    endpoint.search = new URLSearchParams({
      action: 'parse',
      page: boss.wikiPage,
      prop: 'text',
      format: 'json',
      origin: '*',
    }).toString();
    const response = await fetch(`/api/wiki-cache?url=${encodeURIComponent(endpoint.href)}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json(),
      html = data?.parse?.text?.['*'];
    if (!html) return;
    const doc = new DOMParser().parseFromString(html, 'text/html'),
      node = doc.querySelector('.infobox .section.images img,.infobox > img');
    if (!node) return;
    const candidates = [
      node.getAttribute('src'),
      node.getAttribute('data-src'),
      node.getAttribute('data-original'),
      ...(node.getAttribute('srcset') || '')
        .split(',')
        .map((value) => value.trim().split(/\s+/)[0])
        .reverse(),
    ];
    imageUrl = candidates
      .map((value) => {
        try {
          return new URL(value, boss.wikiBase).href;
        } catch {
          return '';
        }
      })
      .find(valid);
    if (imageUrl) {
      imageCache[boss.id] = imageUrl;
      persistImageCache();
    }
  }
  if (imageUrl && valid(imageUrl) && image.isConnected) {
    image.onload = () => {
      image.hidden = false;
      image.closest('.boss-sprite-wrap')?.classList.add('loaded');
    };
    image.onerror = () => {
      image.hidden = true;
    };
    image.src = `/api/wiki-cache?url=${encodeURIComponent(imageUrl)}`;
  }
};
export async function mount(root: HTMLElement): Promise<void> {
  const response = await fetch('/api/section-data?section=bosses', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const info = (await response.json()).server_info || {};
  root.replaceChildren();
  const activeNames = (info.active_bosses || []).map(normalize),
    defeatedNames = (info.defeated_bosses || []).map(normalize),
    counts: Record<string, number> = info.boss_defeat_counts || {},
    calamity = info.boss_status?.calamityBosses || {};
  const isDefeated = (b) =>
    Number(counts[b.id] || 0) > 0 ||
    (b.kind === 'Calamity' && typeof calamity[b.id] === 'boolean'
      ? calamity[b.id]
      : defeatedNames.some((name) => {
          if (name.includes('eaterofworldsbrainofcthulhu')) {
            if (b.id === 'eater-of-worlds') return !info.crimson;
            if (b.id === 'brain-of-cthulhu') return !!info.crimson;
          }
          return name === normalize(b.alias);
        }));
  const defeated = bossCatalog.filter(isDefeated),
    active = bossCatalog.filter((b) => activeNames.includes(normalize(b.alias))),
    total = (Object.values(counts) as number[]).reduce((sum, n) => sum + (Number(n) || 0), 0);
  const metrics = document.createElement('div');
  metrics.className = 'metric-grid';
  const metricRows: Array<[number, string]> = [
    [active.length, 'Активных сейчас'],
    [total, 'Новых побед'],
    [defeated.length, `Побеждено из ${bossCatalog.length}`],
  ];
  for (const [value, title] of metricRows) {
    const card = document.createElement('div');
    card.className = 'metric-card';
    const strong = document.createElement('strong');
    strong.textContent = String(value);
    const caption = document.createElement('span');
    caption.textContent = title;
    card.append(strong, caption);
    metrics.append(card);
  }
  root.append(metrics);
  const imageObserver =
    'IntersectionObserver' in window
      ? new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const card = entry.target as HTMLElement & { _boss?: Boss };
            imageObserver.unobserve(card);
            const image = card.querySelector('img');
            if (card._boss && image) resolveImage(card._boss, image).catch(() => {});
          }
        })
      : null;
  const groups: Array<[string, Boss[], boolean]> = [
    ['Сейчас в мире', active, false],
    ['Побеждены', defeated, true],
    ['Остальные боссы / нет данных', bossCatalog.filter((b) => !isDefeated(b)), false],
  ];
  for (const [title, items, wasDefeated] of groups) {
    const section = document.createElement('section');
    section.className = 'section-block';
    const heading = document.createElement('h3');
    heading.textContent = `${title} · ${items.length}`;
    section.append(heading);
    const list = document.createElement('div');
    list.className = 'boss-list';
    for (const boss of items) {
      const row = document.createElement('article') as HTMLElement & { _boss?: Boss };
      row.className = `boss-row boss-entry${activeNames.includes(normalize(boss.alias)) ? ' active' : ''}`;
      row._boss = boss;
      const wrap = document.createElement('span');
      wrap.className = 'boss-sprite-wrap';
      const image = document.createElement('img');
      image.className = 'boss-sprite';
      image.alt = '';
      image.loading = 'lazy';
      image.hidden = true;
      wrap.append(image);
      const link = document.createElement('a');
      link.href = boss.wiki;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = boss.name;
      link.title = 'Открыть страницу босса в русской вики';
      const right = document.createElement('strong');
      right.textContent = wasDefeated ? `Побед: ${Number(counts[boss.id] || 0)}` : boss.kind;
      row.append(wrap, link, right);
      list.append(row);
      if (imageObserver) imageObserver.observe(row);
      else resolveImage(boss, image).catch(() => {});
    }
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'section-empty';
      empty.textContent =
        title === 'Сейчас в мире' ? 'Активных боссов сейчас нет.' : 'Нет данных для этого списка.';
      list.append(empty);
    }
    section.append(list);
    root.append(section);
  }
  const world = document.createElement('p');
  world.className = 'section-footnote';
  world.textContent = `Мир: ${info.world || '—'} · Режим: ${info.game_mode || '—'}${info.hardmode ? ' · Хардмод' : ''}${info.crimson ? ' · Багрянец' : ''}`;
  root.append(world);
}
