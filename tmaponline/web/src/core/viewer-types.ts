export type SectionView = 'world' | 'players' | 'bosses' | 'server' | 'activity';
export type View = 'map' | SectionView;
export type SectionModule = { mount(root: HTMLElement): void | Promise<void> };

export type PlayerSession = {
  started_at?: number;
  ended_at?: number | null;
  duration_seconds?: number;
};

export type PlayerRecord = {
  id: string;
  name: string;
  uuid?: string | null;
  first_seen_at?: number;
  last_seen_at?: number;
  total_seconds?: number;
  avatar_url?: string;
  team?: number | null;
  deaths?: number;
  pvp_deaths?: number;
  sessions?: PlayerSession[];
};
