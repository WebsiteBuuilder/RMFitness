// The Duel Pass road: 50 tiers, a free lane on every second tier and a Duel Chips lane on every
// tier. Every reward is a cosmetic from the game's own systems (sleeves, playmats, Mates) or the
// pass's own (titles, name plates and avatar frames, plus a few pass-only sleeves and mats).
// Nothing on it touches a duel. Plain data: the screens and the duel can read it cheaply.
import type { SleeveId } from '../sleeves/roster';
import type { PlaymatId } from '../playmats/roster';
import type { MateId } from '../mates/roster';

export const TIERS = 50;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "November 2026" (the same months as Ranked's seasons: one pass season a calendar month). */
export function seasonName(season: string): string {
  const [y, mo] = season.split('-').map(Number);
  return `${MONTHS[(mo - 1) % 12] ?? '?'} ${y}`;
}

/** An avatar frame: a ring round your picture on the menus. */
export interface FrameDef {
  id: string;
  name: string;
  /** the ring's colours (a conic sweep) */
  ring: string[];
  /** it turns slowly (the top ones) */
  spin?: boolean;
  glow: string;
}
export const FRAMES: FrameDef[] = [
  { id: 'bronze', name: 'Bronze Ring', ring: ['#f0b878', '#8a4a1a', '#e8a060', '#6a3410'], glow: '#d08040' },
  { id: 'silver', name: 'Silver Ring', ring: ['#ffffff', '#8a96aa', '#e8eef8', '#6a7488'], glow: '#cfe0ff' },
  { id: 'frost', name: 'Frost Ring', ring: ['#e8fbff', '#5ac8ff', '#ffffff', '#2a7ac8'], glow: '#7ad8ff' },
  { id: 'gold', name: 'Gold Ring', ring: ['#fff6c8', '#c8902a', '#ffe08a', '#8a5a10'], glow: '#ffd56a' },
  { id: 'flame', name: 'Flame Ring', ring: ['#fff2a0', '#ff7a1a', '#c81a0a', '#ffb04a'], spin: true, glow: '#ff7a1a' },
  { id: 'royal', name: 'Royal Ring', ring: ['#e8c8ff', '#7a2ac8', '#ffd56a', '#4a1a8a'], glow: '#b06aff' },
  { id: 'holo', name: 'Holo Ring', ring: ['#ff6ad5', '#94d0ff', '#8cffd8', '#fff59a', '#ffb37a', '#ff6ad5'], spin: true, glow: '#ff9ae8' },
  { id: 'champion', name: 'Champion Ring', ring: ['#ffffff', '#ffd56a', '#ff4a7a', '#ffd56a', '#4ad0ff', '#ffffff'], spin: true, glow: '#fff2c0' },
];

/** A name plate: the banner behind your name and title on the duel's face-off and your profile. */
export interface PlateDef {
  id: string;
  name: string;
  /** the banner (a CSS background) */
  bg: string;
  /** its edge and the title's colour */
  edge: string;
  /** a light runs along it */
  shine?: boolean;
}
export const PLATES: PlateDef[] = [
  { id: 'ember', name: 'Ember', bg: 'linear-gradient(90deg,#3a0a04,#a8300e 55%,#ff8a2a)', edge: '#ffb04a' },
  { id: 'tide', name: 'Tide', bg: 'linear-gradient(90deg,#03142e,#0a4a8a 55%,#3ac0ff)', edge: '#8ae0ff' },
  { id: 'forest', name: 'Forest', bg: 'linear-gradient(90deg,#061a0c,#14602a 55%,#6ad08a)', edge: '#a8f0b8' },
  { id: 'royal', name: 'Royal', bg: 'linear-gradient(90deg,#14062a,#5a1a9a 55%,#c08aff)', edge: '#ffd56a' },
  { id: 'neon', name: 'Neon City', bg: 'linear-gradient(90deg,#10061e,#6a0a5a 45%,#0a6a8a)', edge: '#ff7ac0', shine: true },
  { id: 'shadow', name: 'Shadow Realm', bg: 'linear-gradient(90deg,#000,#2a0a3a 60%,#6a2a8a)', edge: '#c070ff' },
  { id: 'gold', name: 'Solid Gold', bg: 'linear-gradient(90deg,#4a2a06,#c8902a 50%,#fff0a0)', edge: '#fff6c8', shine: true },
  { id: 'holo', name: 'Holo Foil', bg: 'linear-gradient(90deg,#ff6ad5,#94d0ff 30%,#8cffd8 55%,#fff59a 80%,#ffb37a)', edge: '#ffffff', shine: true },
  { id: 'champion', name: 'Champion', bg: 'linear-gradient(90deg,#1a0a2a,#6a3a0a 40%,#ffd56a 70%,#fff6d0)', edge: '#ffffff', shine: true },
];

/** A title, worn under your name. A season title names its month ("Pass Champion · November 2026"). */
export interface TitleDef {
  id: string;
  name: string;
}
const T = (id: string, name: string): TitleDef => ({ id, name });
export const TITLES: TitleDef[] = [
  T('rookie', 'Pass Rookie'),
  T('shark', 'Card Shark'),
  T('heart', 'Heart of the Cards'),
  T('believer', 'Believer in the Cards'),
  T('trapmaster', 'Trap Master'),
  T('nevergiveup', 'Never Gives Up'),
  T('elite', 'Elite Duelist'),
  T('spellbinder', 'Spellbinder'),
  T('tamer', 'Monster Tamer'),
  T('combo', 'Combo Artist'),
  T('fusion', 'Fusion Fanatic'),
  T('commander', 'Field Commander'),
  T('glasscannon', 'Glass Cannon'),
  T('comeback', 'The Comeback Kid'),
  T('trapfan', 'Trap Card Enthusiast'),
  T('topdecker', 'Top Decker'),
  T('diskace', 'Duel Disk Ace'),
  T('bandit', 'Life Point Bandit'),
  T('graveyard', 'Graveyard Shift'),
  T('whisperer', 'Card Whisperer'),
  T('legendmaking', 'Legend in the Making'),
  T('destiny', 'Destiny Draw'),
  T('unstoppable', 'Unstoppable'),
  T('hill', 'King of the Hill'),
  T('mind', 'Millennium Mind'),
];
/** The two season titles: their id carries the season ("champion@2026-11"). */
export const SEASON_TITLES = { champion: 'Pass Champion', legend: 'Pass Legend' } as const;
export type SeasonTitle = keyof typeof SEASON_TITLES;

const TITLE_BY_ID = new Map(TITLES.map((t) => [t.id, t]));
/** A title's words from its id (null: not a title this game knows). */
export function titleName(id: string | null | undefined): string | null {
  if (!id) return null;
  const plain = TITLE_BY_ID.get(id);
  if (plain) return plain.name;
  const m = /^(champion|legend)@(\d{4}-\d{2})$/.exec(id);
  return m ? `${SEASON_TITLES[m[1] as SeasonTitle]} · ${seasonName(m[2])}` : null;
}
export const frameDef = (id: string | null | undefined) => FRAMES.find((f) => f.id === id);
export const plateDef = (id: string | null | undefined) => PLATES.find((p) => p.id === id);

/** One reward on the road. */
export type PassReward =
  | { k: 'sleeve'; id: SleeveId }
  | { k: 'mat'; id: PlaymatId }
  | { k: 'mate'; id: MateId }
  | { k: 'frame'; id: string }
  | { k: 'plate'; id: string }
  | { k: 'title'; id: string }
  /** a season title: its id is made with the season when it's claimed */
  | { k: 'stitle'; id: SeasonTitle };

export interface Tier {
  n: number;
  free: PassReward | null;
  prem: PassReward;
  /** a big moment on the road (shown larger, with its own fanfare) */
  big?: boolean;
}

const s = (id: SleeveId): PassReward => ({ k: 'sleeve', id });
const m = (id: PlaymatId): PassReward => ({ k: 'mat', id });
const mt = (id: MateId): PassReward => ({ k: 'mate', id });
const fr = (id: string): PassReward => ({ k: 'frame', id });
const pl = (id: string): PassReward => ({ k: 'plate', id });
const ti = (id: string): PassReward => ({ k: 'title', id });

/** The free lane (even tiers) and the Chips lane (every tier). */
const FREE: Record<number, PassReward> = {
  2: ti('rookie'),
  4: mt('wkuriboh'),
  6: fr('bronze'),
  8: s('light'),
  10: ti('shark'),
  12: m('light'),
  14: mt('mokeymokey'),
  16: s('dark'),
  18: ti('heart'),
  20: s('seasoncrest'),
  22: fr('silver'),
  24: m('dark'),
  26: ti('believer'),
  28: mt('ojama'),
  30: s('water'),
  32: ti('trapmaster'),
  34: m('water'),
  36: fr('frost'),
  38: s('wind'),
  40: ti('nevergiveup'),
  42: m('wind'),
  44: mt('sangan'),
  46: s('earth'),
  48: fr('gold'),
  50: { k: 'stitle', id: 'champion' },
};
const PREM: PassReward[] = [
  s('fire'), pl('ember'), ti('elite'), mt('penguin'), fr('flame'),
  ti('spellbinder'), m('fire'), pl('tide'), ti('tamer'), s('pyramid'),
  ti('combo'), mt('timewizard'), pl('forest'), ti('fusion'), m('earth'),
  ti('commander'), s('chrome'), pl('royal'), ti('glasscannon'), fr('royal'),
  ti('comeback'), m('city'), ti('trapfan'), mt('redeyes'), m('summit'),
  ti('topdecker'), pl('neon'), ti('diskace'), m('castle'), s('dragonflare'),
  ti('bandit'), pl('shadow'), ti('graveyard'), fr('holo'), s('gold'),
  ti('whisperer'), m('dome'), pl('gold'), ti('legendmaking'), mt('darkmagician'),
  ti('destiny'), pl('holo'), ti('unstoppable'), ti('hill'), s('champion'),
  ti('mind'), pl('champion'), fr('champion'), { k: 'stitle', id: 'legend' }, m('champion'),
];
const BIG = new Set([10, 20, 25, 30, 40, 45, 50]);

export const ROAD: Tier[] = Array.from({ length: TIERS }, (_, i) => ({ n: i + 1, free: FREE[i + 1] ?? null, prem: PREM[i], big: BIG.has(i + 1) || undefined }));
