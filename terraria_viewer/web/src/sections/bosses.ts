import { createOutlinedSprite, loadSprite } from '../core/sprite-renderer';

type BossSprite = { id: number; name: string; icon_url: string };
type BossPayload = {
  bosses?: BossSprite[];
  active_bosses?: string[];
  defeated_bosses?: string[];
  boss_defeat_counts?: Record<string, number>;
  boss_status?: { calamityAvailable?: boolean; calamityBosses?: Record<string, boolean | null> };
};

const bossNames: Record<string, string> = {
  'king-slime': 'Король слизней',
  'eye-of-cthulhu': 'Глаз Ктулху',
  'eater-of-worlds': 'Пожиратель миров',
  'brain-of-cthulhu': 'Мозг Ктулху',
  'queen-bee': 'Королева пчёл',
  deerclops: 'Олененок',
  skeletron: 'Скелетрон',
  'wall-of-flesh': 'Стена плоти',
  'queen-slime': 'Королева слизней',
  'the-twins': 'Близнецы',
  'the-destroyer': 'Уничтожитель',
  'skeletron-prime': 'Скелетрон Прайм',
  plantera: 'Плантера',
  golem: 'Голем',
  'duke-fishron': 'Герцог Рыбокрыл',
  'empress-of-light': 'Императрица света',
  'lunatic-cultist': 'Безумный культист',
  'moon-lord': 'Лунный лорд',
  'desert-scourge': 'Пустынный бич',
  crabulon: 'Крабулон',
  'hive-mind': 'Улейный разум',
  perforators: 'Перфораторы',
  'slime-god': 'Бог слизней',
  cryogen: 'Криоген',
  'aquatic-scourge': 'Водный бич',
  'brimstone-elemental': 'Элементаль серы',
  'calamitas-clone': 'Клон Каламитас',
  'leviathan-anahita': 'Левиафан и Анахьита',
  'astrum-aureus': 'Аструм Ауреус',
  'plaguebringer-goliath': 'Чумной голиаф',
  ravager: 'Опустошитель',
  'astrum-deus': 'Аструм Деус',
  providence: 'Провиденс',
  'storm-weaver': 'Ткач бурь',
  'ceaseless-void': 'Бесконечная пустота',
  signus: 'Сигнус',
  polterghast: 'Полтергаст',
  'old-duke': 'Старый герцог',
  'devourer-of-gods': 'Пожиратель богов',
  yharon: 'Ярон',
  'exo-mechs': 'Экзо-мехи',
  'supreme-calamitas': 'Верховная Каламитас',
};

export async function mount(root: HTMLElement): Promise<void> {
  const response = await fetch('/api/section-data?section=bosses', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as BossPayload;
  root.replaceChildren();

  const defeats = document.createElement('section');
  defeats.className = 'boss-progress';
  const title = document.createElement('h3');
  title.textContent = 'Побеждённые';
  defeats.append(title);
  const defeated = new Set(payload.defeated_bosses || []);
  const counts = payload.boss_defeat_counts || {};
  const calamity = payload.boss_status?.calamityBosses || {};
  const defeatedRows = [
    ...[...defeated].map((name) => ({ name, count: 0 })),
    ...Object.entries(counts).map(([id, count]) => ({ name: bossNames[id] || id, count })),
    ...Object.entries(calamity)
      .filter(([, value]) => value === true)
      .map(([id]) => ({ name: bossNames[id] || id, count: 0 })),
  ];
  const uniqueRows = new Map<string, number>();
  for (const row of defeatedRows)
    uniqueRows.set(row.name, Math.max(uniqueRows.get(row.name) || 0, row.count));
  if (uniqueRows.size === 0) {
    const empty = document.createElement('p');
    empty.className = 'section-empty';
    empty.textContent = 'Данные о победах появятся после получения телеметрии мира.';
    defeats.append(empty);
  } else {
    const list = document.createElement('ul');
    list.className = 'boss-victory-list';
    for (const [name, count] of uniqueRows) {
      const item = document.createElement('li');
      item.textContent = count > 0 ? `${name} — побед: ${count}` : name;
      list.append(item);
    }
    defeats.append(list);
  }
  root.append(defeats);

  if (payload.boss_status?.calamityAvailable) {
    const calamityTitle = document.createElement('h3');
    calamityTitle.textContent = 'Calamity';
    const statusList = document.createElement('ul');
    statusList.className = 'boss-victory-list';
    for (const [id, value] of Object.entries(calamity)) {
      const item = document.createElement('li');
      item.textContent = `${value === true ? '✓' : value === false ? '·' : '?'} ${bossNames[id] || id}`;
      statusList.append(item);
    }
    root.append(calamityTitle, statusList);
  }

  const active = payload.bosses || [];
  if (active.length) {
    const activeTitle = document.createElement('h3');
    activeTitle.textContent = 'Сейчас в мире';
    const list = document.createElement('div');
    list.className = 'boss-list';
    for (const boss of active) {
      const row = document.createElement('div');
      row.className = 'boss-row';
      const spriteFrame = document.createElement('span');
      spriteFrame.className = 'boss-sprite-frame';
      void loadSprite(boss.icon_url).then((source) => {
        if (!source || !row.isConnected) return;
        const sprite = createOutlinedSprite(source, '#ffffff');
        if (sprite) {
          sprite.className = 'boss-sprite';
          spriteFrame.replaceChildren(sprite);
        }
      });
      const name = document.createElement('span');
      name.textContent = boss.name || 'Босс';
      row.append(spriteFrame, name);
      list.append(row);
    }
    root.append(activeTitle, list);
  }
}
