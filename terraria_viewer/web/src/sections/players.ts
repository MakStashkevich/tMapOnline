import type { PlayerRecord } from '../core/viewer-types';
import {
  createOutlinedSprite,
  defaultPlayerSprite,
  loadSprite,
  playerOutlineColor,
} from '../core/sprite-renderer';

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
  root.replaceChildren();
  const summary = document.createElement('div');
  summary.className = 'section-summary';
  summary.textContent = `Сейчас онлайн: ${data.online?.count ?? 0} · Всего игроков: ${(data.players || []).length}`;
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
    avatar.setAttribute('aria-hidden', 'true');
    header.append(avatar);
    void renderPlayerAvatar(avatar, player.avatar_url, online.has(player.id) ? player.team : null);
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
    stats.textContent = `Всего в игре: ${formatDuration(player.total_seconds)} · Сессий: ${(player.sessions || []).length} · Впервые: ${formatDate(player.first_seen_at)} · Последний раз: ${formatDate(player.last_seen_at)}`;
    card.append(stats);
    const identity = document.createElement('p');
    identity.className = 'player-identity';
    identity.textContent = `UUID: ${player.uuid || 'не получен, учёт по нику'} · Смерти: ${player.deaths ?? '—'} · PvP: ${player.pvp_deaths ?? '—'}`;
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
      row.textContent = `${formatDate(session.started_at)} — ${session.ended_at ? formatDate(session.ended_at) : 'сейчас'} · ${formatDuration(session.duration_seconds)}`;
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
}

async function renderPlayerAvatar(
  container: HTMLElement,
  avatarUrl: string | undefined,
  team: number | null | undefined,
): Promise<void> {
  const source = (await loadSprite(avatarUrl || '')) || (await loadSprite(defaultPlayerSprite()));
  if (!source || !container.isConnected) return;
  const outlinedSprite = createOutlinedSprite(source, playerOutlineColor(team));
  if (!outlinedSprite) return;
  outlinedSprite.className = 'player-card-avatar-sprite';
  container.replaceChildren(outlinedSprite);
}
