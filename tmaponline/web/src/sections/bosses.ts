type BossSprite = { id: number; name: string; icon_url: string };
type BossCatalogEntry = {
  id: string;
  type: number;
  name: string;
  mod: string;
  icon_url: string | null;
};
type BossPayload = {
  bosses?: BossSprite[];
  boss_catalog?: BossCatalogEntry[];
  active_bosses?: string[];
  defeated_bosses?: string[];
  boss_defeat_counts?: Record<string, number>;
  boss_status?: { calamityAvailable?: boolean; calamityBosses?: Record<string, boolean | null> };
};

const normalize = (name: string): string =>
  name.toLocaleLowerCase('ru').replace(/[^a-z0-9а-яё]+/gi, '');

const vanillaWikiPages: Record<string, string> = {
  kingslime: 'King_Slime',
  eyeofcthulhu: 'Eye_of_Cthulhu',
  eaterofworlds: 'Eater_of_Worlds',
  brainofcthulhu: 'Brain_of_Cthulhu',
  queenbee: 'Queen_Bee',
  deerclops: 'Deerclops',
  skeletron: 'Skeletron',
  golemhead: 'Golem',
  wallofflesh: 'Wall_of_Flesh',
  queenslime: 'Queen_Slime',
  thetwins: 'The_Twins',
  thedestroyer: 'The_Destroyer',
  skeletronprime: 'Skeletron_Prime',
  plantera: 'Plantera',
  golem: 'Golem',
  dukefishron: 'Duke_Fishron',
  empressoflight: 'Empress_of_Light',
  lunaticcultist: 'Lunatic_Cultist',
  moonlord: 'Moon_Lord',
  darkmage: 'Dark_Mage',
  ogre: 'Ogre',
  betsy: 'Betsy',
  flyingdutchman: 'Flying_Dutchman',
  mourningwood: 'Mourning_Wood',
  pumpking: 'Pumpking',
  everscream: 'Everscream',
  santank1: 'Santa-NK1',
  icequeen: 'Ice_Queen',
  martiansaucer: 'Martian_Saucer',
  solarpillar: 'Solar_Pillar',
  nebulapillar: 'Nebula_Pillar',
  vortexpillar: 'Vortex_Pillar',
  stardustpillar: 'Stardust_Pillar',
  mechdusa: 'Mechdusa',
};

const calamityWikiPages: Record<string, string> = {
  desertscourge: 'Desert_Scourge',
  desertnuisance: 'Desert_Scourge',
  crabulon: 'Crabulon',
  hivemind: 'The_Hive_Mind',
  thehivemind: 'The_Hive_Mind',
  perforators: 'The_Perforators',
  perforator: 'The_Perforators',
  theperforator: 'The_Perforators',
  perforatorhive: 'The_Perforators',
  slimegod: 'The_Slime_God',
  theslimegod: 'The_Slime_God',
  slimegodcore: 'The_Slime_God',
  crimulanpaladin: 'The_Slime_God',
  ebonianpaladin: 'The_Slime_God',
  splitcrimulanpaladin: 'The_Slime_God',
  splitebonianpaladin: 'The_Slime_God',
  cryogen: 'Cryogen',
  aquaticscourge: 'Aquatic_Scourge',
  brimstoneelemental: 'Brimstone_Elemental',
  calamitasclone: 'Calamitas_Clone',
  leviathan: 'Leviathan_and_Anahita',
  anahita: 'Leviathan_and_Anahita',
  astrumaureus: 'Astrum_Aureus',
  plaguebringer: 'The_Plaguebringer_Goliath',
  plaguebringergoliath: 'The_Plaguebringer_Goliath',
  theplaguebringergoliath: 'The_Plaguebringer_Goliath',
  ravager: 'The_Ravager',
  astrumdeus: 'Astrum_Deus',
  profanedguardians: 'Profaned_Guardians',
  guardiancommander: 'Profaned_Guardians',
  guardiandefender: 'Profaned_Guardians',
  guardianhealer: 'Profaned_Guardians',
  dragonfolly: 'Dragonfolly',
  providence: 'Providence',
  provspawndefense: 'Providence',
  provspawnhealer: 'Providence',
  provspawnoffense: 'Providence',
  stormweaver: 'Storm_Weaver',
  ceaselessvoid: 'Ceaseless_Void',
  signus: 'Signus',
  polterghast: 'Polterghast',
  polterphantom: 'Polterghast',
  oldduke: 'The_Old_Duke',
  theoldduke: 'The_Old_Duke',
  devourerofgods: 'The_Devourer_of_Gods',
  thedevourerofgods: 'The_Devourer_of_Gods',
  yharon: 'Yharon,_Dragon_of_Rebirth',
  exomechs: 'Exo_Mechs',
  ares: 'Exo_Mechs',
  aresbody: 'Exo_Mechs',
  supremewitchcalamitas: 'Supreme_Calamitas',
  supremecalamitas: 'Supreme_Calamitas',
  cataclysm: 'Cataclysm',
  cataclysmicconstruct: 'Cataclysm',
  catastrophe: 'Catastrophe',
  catastrophicconstruct: 'Catastrophe',
  primordialwyrm: 'Primordial_Wyrm',
  hecate: 'XB-∞_Hekate',
  xbhekate: 'XB-∞_Hekate',
  thelorde: 'THE_LORDE',
  giantclam: 'Giant_Clam',
  cragmawmire: 'Cragmaw_Mire',
  greatsandshark: 'Great_Sand_Shark',
  mauler: 'Mauler',
  nuclearterror: 'Nuclear_Terror',
  aquaticeel: 'Aquatic_Eel',
};

const calamityDefeatKeys: Record<string, string> = {
  desertscourge: 'desert-scourge',
  crabulon: 'crabulon',
  hivemind: 'hive-mind',
  perforators: 'perforators',
  perforator: 'perforators',
  theperforator: 'perforators',
  perforatorhive: 'perforators',
  slimegod: 'slime-god',
  theslimegod: 'slime-god',
  slimegodcore: 'slime-god',
  crimulanpaladin: 'slime-god',
  ebonianpaladin: 'slime-god',
  splitcrimulanpaladin: 'slime-god',
  splitebonianpaladin: 'slime-god',
  cryogen: 'cryogen',
  aquaticscourge: 'aquatic-scourge',
  brimstoneelemental: 'brimstone-elemental',
  calamitasclone: 'calamitas-clone',
  leviathan: 'leviathan-anahita',
  anahita: 'leviathan-anahita',
  astrumaureus: 'astrum-aureus',
  plaguebringer: 'plaguebringer-goliath',
  plaguebringergoliath: 'plaguebringer-goliath',
  ravager: 'ravager',
  astrumdeus: 'astrum-deus',
  profanedguardians: 'profaned-guardians',
  guardiancommander: 'profaned-guardians',
  guardiandefender: 'profaned-guardians',
  guardianhealer: 'profaned-guardians',
  dragonfolly: 'dragonfolly',
  providence: 'providence',
  provspawndefense: 'providence',
  provspawnhealer: 'providence',
  provspawnoffense: 'providence',
  stormweaver: 'storm-weaver',
  ceaselessvoid: 'ceaseless-void',
  signus: 'signus',
  polterghast: 'polterghast',
  polterphantom: 'polterghast',
  oldduke: 'old-duke',
  theoldduke: 'old-duke',
  devourerofgods: 'devourer-of-gods',
  yharon: 'yharon',
  exomechs: 'exo-mechs',
  ares: 'exo-mechs',
  aresbody: 'exo-mechs',
  supremewitchcalamitas: 'supreme-calamitas',
  supremecalamitas: 'supreme-calamitas',
  cataclysm: 'supreme-calamitas',
  cataclysmicconstruct: 'supreme-calamitas',
  catastrophe: 'supreme-calamitas',
  catastrophicconstruct: 'supreme-calamitas',
  primordialwyrm: 'primordial-wyrm',
  giantclam: 'giant-clam',
  cragmawmire: 'cragmaw-mire',
  greatsandshark: 'great-sand-shark',
  mauler: 'mauler',
  nuclearterror: 'nuclear-terror',
};

const wikiUrlForBoss = (boss: BossCatalogEntry): string => {
  const nameKey = normalize(boss.name);
  const internalName = boss.id.split(':').at(-1) || boss.name;
  if (boss.mod === 'CalamityMod') {
    const page =
      calamityWikiPages[normalize(internalName)] ??
      calamityWikiPages[nameKey] ??
      internalName.replace(/([a-z])([A-Z])/g, '$1_$2');
    return `https://calamitymod.wiki.gg/wiki/${encodeURIComponent(page.replaceAll(' ', '_'))}`;
  }

  const page =
    vanillaWikiPages[normalize(internalName)] ??
    vanillaWikiPages[nameKey] ??
    internalName.replace(/([a-z])([A-Z])/g, '$1_$2');
  if (boss.mod === 'Terraria') {
    return `https://terraria.wiki.gg/wiki/${encodeURIComponent(page.replaceAll(' ', '_'))}`;
  }

  const search = encodeURIComponent(`${boss.name} ${boss.mod}`);
  return `https://terraria.wiki.gg/wiki/Special:Search?search=${search}`;
};

const isBossDefeated = (boss: BossCatalogEntry, payload: BossPayload): boolean => {
  const calamity = payload.boss_status?.calamityBosses || {};
  if (boss.mod === 'CalamityMod') {
    const key =
      calamityDefeatKeys[normalize(boss.id.split(':').at(-1) || boss.name)] ??
      calamityDefeatKeys[normalize(boss.name)];
    if (key && calamity[key] === true) return true;
  }

  const defeatedNames = new Set((payload.defeated_bosses || []).map(normalize));
  const bossName = normalize(boss.name);
  const directAliases: Record<string, string[]> = {
    eaterofworlds: ['eaterofworldsbrainofcthulhu'],
    brainofcthulhu: ['eaterofworldsbrainofcthulhu'],
    wallofflesh: ['walloffleshhardmode'],
    twins: ['thetwins'],
    retinazer: ['thetwins'],
    spazmatism: ['thetwins'],
    golemhead: ['golem'],
    mourningwood: ['pumpkinmoonmourningwood'],
    pumpking: ['pumpkinmoonpumpking'],
  };
  if (
    defeatedNames.has(bossName) ||
    (directAliases[bossName] || []).some((alias) => defeatedNames.has(alias))
  ) {
    return true;
  }

  const defeatCounts = payload.boss_defeat_counts || {};
  return Object.entries(defeatCounts).some(
    ([id, count]) =>
      count > 0 && (normalize(id) === normalize(boss.id) || normalize(id) === bossName),
  );
};

const bindDefeatedTooltip = (element: HTMLElement): void => {
  const tooltip = document.querySelector<HTMLElement>('#map-menu-tooltip');
  if (!tooltip) return;

  const position = (x: number, y: number): void => {
    tooltip.textContent = 'Побеждён';
    tooltip.hidden = false;
    const edge = 12;
    tooltip.style.left = `${Math.min(x + edge, window.innerWidth - tooltip.offsetWidth - edge)}px`;
    tooltip.style.top = `${Math.min(y + edge, window.innerHeight - tooltip.offsetHeight - edge)}px`;
  };

  element.addEventListener('pointerenter', (event) => position(event.clientX, event.clientY));
  element.addEventListener('pointermove', (event) => position(event.clientX, event.clientY));
  element.addEventListener('pointerleave', () => {
    tooltip.hidden = true;
  });
  element.addEventListener('focus', () => {
    const bounds = element.getBoundingClientRect();
    position(bounds.right, bounds.top + bounds.height / 2);
  });
  element.addEventListener('blur', () => {
    tooltip.hidden = true;
  });
};

export async function mount(root: HTMLElement): Promise<void> {
  const response = await fetch('/api/section-data?section=bosses', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as BossPayload;
  root.replaceChildren();

  const catalog = payload.boss_catalog || [];
  const catalogSection = document.createElement('section');
  catalogSection.className = 'section-block';
  const catalogTitle = document.createElement('h3');
  catalogTitle.textContent = `Боссы игры и установленных модов · ${catalog.length}`;
  catalogSection.append(catalogTitle);
  if (catalog.length) {
    const list = document.createElement('div');
    list.className = 'boss-list boss-catalog-list';
    const sortedCatalog = [...catalog].sort(
      (left, right) =>
        left.mod.localeCompare(right.mod, 'ru') || left.name.localeCompare(right.name, 'ru'),
    );
    const activeNames = new Set((payload.active_bosses || []).map(normalize));
    for (const boss of sortedCatalog) {
      const row = document.createElement('article');
      row.className = 'boss-row boss-catalog-row';
      const spriteFrame = document.createElement('span');
      spriteFrame.className = 'boss-sprite-frame';
      const iconUrl = boss.icon_url;
      if (iconUrl) {
        spriteFrame.append(createBossSprite(iconUrl, boss.name));
      }
      const identity = document.createElement('span');
      identity.className = 'boss-catalog-identity';
      const nameLine = document.createElement('span');
      nameLine.className = 'boss-name-line';
      const name = document.createElement('strong');
      name.textContent = boss.name;
      nameLine.append(name);
      if (isBossDefeated(boss, payload)) {
        const defeated = document.createElement('span');
        defeated.className = 'boss-defeated-check';
        defeated.textContent = '✓';
        defeated.setAttribute('role', 'img');
        defeated.setAttribute('aria-label', 'Побеждён');
        defeated.tabIndex = 0;
        bindDefeatedTooltip(defeated);
        nameLine.append(defeated);
      }
      const source = document.createElement('small');
      source.textContent = boss.mod === 'Terraria' ? 'Terraria' : boss.mod;
      identity.append(nameLine, source);
      if (activeNames.has(normalize(boss.name))) {
        const active = document.createElement('span');
        active.className = 'boss-active-badge';
        active.textContent = 'Сейчас в мире';
        identity.append(active);
      }
      const wiki = document.createElement('a');
      wiki.className = 'pixel-button boss-wiki-link';
      wiki.target = '_blank';
      wiki.rel = 'noopener noreferrer';
      wiki.textContent = 'Вики';
      wiki.setAttribute('aria-label', `Открыть вики: ${boss.name}`);
      wiki.href = wikiUrlForBoss(boss);
      row.append(spriteFrame, identity, wiki);
      list.append(row);
    }
    catalogSection.append(list);
  } else {
    const empty = document.createElement('p');
    empty.className = 'section-empty';
    empty.textContent = 'Каталог появится после подключения телеметрии мира.';
    catalogSection.append(empty);
  }
  root.append(catalogSection);

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
      spriteFrame.append(createBossSprite(boss.icon_url, boss.name || 'Босс'));
      const name = document.createElement('span');
      name.textContent = boss.name || 'Босс';
      row.append(spriteFrame, name);
      list.append(row);
    }
    root.append(activeTitle, list);
  }
}

function createBossSprite(source: string, name: string): HTMLImageElement {
  const image = document.createElement('img');
  image.className = 'boss-sprite';
  image.src = source;
  image.alt = `Спрайт: ${name}`;
  image.loading = 'eager';
  image.decoding = 'async';
  image.draggable = false;
  return image;
}
