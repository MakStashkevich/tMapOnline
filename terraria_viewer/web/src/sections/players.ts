import type { PlayerRecord } from '../core/viewer-types';
import { loadSprite } from '../core/sprite-renderer';

type PlayersPayload = {
  online?: { count?: number; ids?: string[] };
  players?: PlayerRecord[];
};

const formatDuration = (value?: number): string => {
  let seconds = Math.max(0, Math.floor(Number(value) || 0));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days ? `${days} д ` : ''}${hours} ч ${minutes} мин`;
};
const formatDate = (value?: number): string =>
  value ? new Date(Number(value) * 1000).toLocaleString('ru-RU') : '—';

export async function mount(root: HTMLElement): Promise<void> {
  const response = await fetch('/api/section-data?section=players', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as PlayersPayload;
  const online = new Set(data.online?.ids || []);
  const avatarTargets: PlayerAvatarTarget[] = [];
  root.replaceChildren();
  const summary = document.createElement('div');
  summary.className = 'section-summary';
  summary.textContent = `Сейчас онлайн: ${data.online?.count ?? 0} — Всего игроков: ${(data.players || []).length}`;
  root.append(summary);
  const list = document.createElement('div');
  list.className = 'player-cards';

  for (const player of [...(data.players || [])].sort(
    (a, b) =>
      Number(online.has(b.id)) - Number(online.has(a.id)) ||
      Number(b.total_seconds || 0) - Number(a.total_seconds || 0),
  )) {
    const card = document.createElement('article');
    card.className = 'viewer-card';
    const header = document.createElement('div');
    header.className = 'viewer-card-head';
    const avatar = document.createElement('span');
    avatar.className = 'player-card-avatar';
    avatar.setAttribute('aria-label', `Портрет игрока ${player.name || 'Игрок'}`);
    avatar.append(createPixelAvatarLoader());
    header.append(avatar);
    avatarTargets.push({
      playerId: player.id,
      container: avatar,
      currentUrl: '',
      shouldRefresh: online.has(player.id),
    });
    if (player.avatar_url) {
      void renderPlayerAvatar(avatarTargets[avatarTargets.length - 1], player.avatar_url);
    }
    const title = document.createElement('h3');
    title.textContent = player.name || 'Игрок';
    header.append(title);
    if (online.has(player.id)) {
      const badge = document.createElement('span');
      badge.className = 'viewer-badge online';
      badge.textContent = 'В игре';
      header.append(badge);
    }
    card.append(header);
    const stats = document.createElement('p');
    stats.textContent = `Всего в игре: ${formatDuration(player.total_seconds)} — Сессий: ${(player.sessions || []).length} — Впервые: ${formatDate(player.first_seen_at)} — Последний раз: ${formatDate(player.last_seen_at)}`;
    card.append(stats);
    const identity = document.createElement('p');
    identity.className = 'player-identity';
    identity.textContent = `UUID: ${player.uuid || 'не получен, учёт по нику'} — Смерти: ${player.deaths ?? '—'} — PvP: ${player.pvp_deaths ?? '—'}`;
    card.append(identity);
    const sessions = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'История сессий';
    sessions.append(summary);
    const rows = document.createElement('div');
    rows.className = 'session-list';
    for (const session of [...(player.sessions || [])].reverse()) {
      const row = document.createElement('div');
      row.className = 'session-row';
      row.textContent = `${formatDate(session.started_at)} — ${session.ended_at ? formatDate(session.ended_at) : 'сейчас'} — ${formatDuration(session.duration_seconds)}`;
      rows.append(row);
    }
    if (!rows.childElementCount) rows.textContent = 'Сессий пока нет';
    sessions.append(rows);
    card.append(sessions);
    list.append(card);
  }
  if (!list.childElementCount) {
    const empty = document.createElement('div');
    empty.className = 'section-empty';
    empty.textContent = 'История игроков пока пуста.';
    list.append(empty);
  }
  root.append(list);
  scheduleAvatarRefresh(avatarTargets);
}

type PlayerAvatarTarget = {
  playerId: string;
  container: HTMLElement;
  currentUrl: string;
  shouldRefresh: boolean;
};

function createPixelAvatarLoader(): HTMLElement {
  const loader = document.createElement('span');
  loader.className = 'player-avatar-loader';
  loader.setAttribute('aria-hidden', 'true');
  for (let pixel = 0; pixel < 16; pixel += 1) {
    loader.append(document.createElement('span'));
  }
  return loader;
}

async function renderPlayerAvatar(target: PlayerAvatarTarget, avatarUrl: string): Promise<boolean> {
  const source = await loadSprite(avatarUrl);
  if (!source || !target.container.isConnected) return false;

  // Player cards use the raw head pixels; map-only team outlines do not belong in this menu.
  const image = document.createElement('img');
  image.className = 'player-card-avatar-sprite';
  image.alt = '';
  image.decoding = 'async';
  image.src = source.src;
  target.currentUrl = avatarUrl;
  target.container.replaceChildren(image);
  return true;
}

function scheduleAvatarRefresh(targets: PlayerAvatarTarget[]): void {
  const activeTargets = targets.filter(
    (target) => target.container.isConnected && (target.shouldRefresh || !target.currentUrl),
  );
  if (activeTargets.length === 0) return;

  window.setTimeout(() => {
    void refreshPlayerAvatars(activeTargets);
  }, 2500);
}

async function refreshPlayerAvatars(targets: PlayerAvatarTarget[]): Promise<void> {
  await Promise.all(
    targets.map(async (target) => {
      if (!target.container.isConnected) return;
      try {
        const query = new URLSearchParams({ id: target.playerId });
        const response = await fetch(`/api/player-avatar?${query}`, { cache: 'no-store' });
        if (!response.ok) return;
        const payload = (await response.json()) as { avatar_url?: string };
        const avatarUrl = payload.avatar_url || '';
        if (avatarUrl && avatarUrl !== target.currentUrl) {
          await renderPlayerAvatar(target, avatarUrl);
        }
      } catch {
        // Keep the pixel loader visible and retry while this player card remains on screen.
      }
    }),
  );
  scheduleAvatarRefresh(targets);
}
