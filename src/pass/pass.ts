// The Duel Pass: a 50-tier road of cosmetics that a month of duelling climbs. Each season is a
// calendar month (the same months as Ranked). Duels that count earn Pass XP, with a daily cap;
// every 400 XP is a tier. The free lane pays on every second tier; the Duel Chips lane (opened
// once a season for Duel Chips) pays on every tier, back to tier 1 when it's opened late.
//
// What counts is what Duelist Requests count: the Millennium Road, the Labyrinth, Ranked, Duel
// the Computer and duels with another player, all with a collection deck. Practice, watching,
// "Anything goes" decks, duels given up before they got going and duels that left early earn
// nothing. Setting the phone's clock back freezes the pass until the real date catches up, and
// rewards a season reached but never claimed are handed over when the next season starts.
import { chipsOf } from '../collection/economy';
import type { SpeedSave } from '../eds/speedSave';
import { hasSleeve, sleeveDef } from '../sleeves/sleeves';
import { hasPlaymat, playmatDef } from '../playmats/playmats';
import { hasMate, mateDef } from '../mates/roster';
import { FRAMES, PLATES, ROAD, TIERS, TITLES, frameDef, plateDef, seasonName, titleName, type PassReward, type Tier } from './road';
import { passOf, type PassFields, type PassTrack } from './owned';

export * from './road';
export { passOwns, passOf, type PassTrack } from './owned';

export const TIER_XP = 400;
/** The most Pass XP one day can earn (two and a half tiers): about 20 days of play reach tier 50. */
export const DAY_CAP = 1000;
export const XP_WIN = 120;
export const XP_LOSS = 60;
export const XP_FIRST_WIN = 150;
export const XP_REQUEST = 100;
/** What the Duel Chips lane costs, once a season. */
export const PREM_PRICE = 30;
export const MAX_XP = TIERS * TIER_XP;

type PS = SpeedSave & PassFields;

const pad = (n: number) => String(n).padStart(2, '0');
/** The season a moment falls in: its local calendar month ("2026-11"). */
export const passSeason = (now = Date.now()) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const dayOf = (now: number) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** Whole days left in the season (1 on its last day). */
export function passDaysLeft(now = Date.now()): number {
  const d = new Date(now);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return Math.max(1, Math.ceil((end - now) / 86400000));
}
export const passSeasonName = (now = Date.now()) => seasonName(passSeason(now));

const freshTrack = (season: string, day: string): PassTrack => ({ season, xp: 0, prem: false, gotF: [], gotP: [], day, dayXp: 0, firstWin: false });

/** This season's track as it stands (a new season or day starts fresh; null: the clock reads earlier than a day already played). */
export function trackOf(s: SpeedSave, now = Date.now()): PassTrack | null {
  const t = passOf(s)?.pass;
  const season = passSeason(now);
  const day = dayOf(now);
  if (!t) return freshTrack(season, day);
  if (t.season > season || t.day > day) return null;
  if (t.season < season) return freshTrack(season, day);
  return t.day === day ? t : { ...t, day, dayXp: 0, firstWin: false };
}
/** The track to show even while the clock is behind (frozen: nothing earned, nothing claimed). */
export const shownTrack = (s: SpeedSave, now = Date.now()): PassTrack => trackOf(s, now) ?? passOf(s)!.pass!;

export const tierAt = (xp: number) => Math.min(TIERS, Math.floor(Math.max(0, xp) / TIER_XP));
/** XP into the tier being climbed, and what that tier needs ([have, need]; the top tier: full). */
export function tierProgress(xp: number): [number, number] {
  if (tierAt(xp) >= TIERS) return [TIER_XP, TIER_XP];
  return [Math.max(0, xp) % TIER_XP, TIER_XP];
}

// ---------- owning and wearing ----------

const ownList = (s: SpeedSave) => passOf(s)?.passOwn ?? [];
const withOwn = (s: SpeedSave, key: string): SpeedSave => (ownList(s).includes(key) ? s : ({ ...(s as PS), passOwn: [...ownList(s), key] } as SpeedSave));

/** Is this reward already the duelist's (from the pass or any other way)? */
export function ownsReward(s: SpeedSave, r: PassReward, season: string): boolean {
  switch (r.k) {
    case 'sleeve':
      return hasSleeve(s, r.id);
    case 'mat':
      return hasPlaymat(s, r.id);
    case 'mate':
      return hasMate(s, r.id);
    case 'stitle':
      return ownList(s).includes(`title:${r.id}@${season}`);
    default:
      return ownList(s).includes(`${r.k}:${r.id}`);
  }
}

/** Hands a reward over for good (one already owned: nothing changes). */
export function giveReward(s: SpeedSave, r: PassReward, season: string): SpeedSave {
  if (ownsReward(s, r, season)) return s;
  const x = s as PS & { sleeves?: string[]; playmats?: string[] };
  switch (r.k) {
    case 'sleeve':
      // (a Duel Chip sleeve lands on the bought list; a pass-only one on the pass's own)
      return sleeveDef(r.id) && 'chips' in sleeveDef(r.id)!.cost ? ({ ...x, sleeves: [...(x.sleeves ?? []), r.id] } as SpeedSave) : withOwn(s, `sleeve:${r.id}`);
    case 'mat':
      return playmatDef(r.id) && 'chips' in playmatDef(r.id)!.cost ? ({ ...x, playmats: [...(x.playmats ?? []), r.id] } as SpeedSave) : withOwn(s, `mat:${r.id}`);
    case 'mate':
      return { ...s, mates: [...(s.mates ?? []), r.id] };
    case 'stitle':
      return withOwn(s, `title:${r.id}@${season}`);
    default:
      return withOwn(s, `${r.k}:${r.id}`);
  }
}

/** What a reward is called, and what kind of thing it is. */
export function rewardName(r: PassReward, season: string): { name: string; kind: string } {
  switch (r.k) {
    case 'sleeve':
      return { name: sleeveDef(r.id)?.name ?? r.id, kind: 'Sleeve' };
    case 'mat':
      return { name: playmatDef(r.id)?.name ?? r.id, kind: 'Playmat' };
    case 'mate':
      return { name: mateDef(r.id)?.name ?? r.id, kind: 'Mate' };
    case 'frame':
      return { name: frameDef(r.id)?.name ?? r.id, kind: 'Avatar frame' };
    case 'plate':
      return { name: `${plateDef(r.id)?.name ?? r.id}`, kind: 'Name plate' };
    case 'title':
      return { name: titleName(r.id) ?? r.id, kind: 'Title' };
    case 'stitle':
      return { name: titleName(`${r.id}@${season}`) ?? r.id, kind: 'Season title' };
  }
}
/** Only on the Duel Pass (never sold anywhere else). */
export function passOnly(r: PassReward): boolean {
  if (r.k === 'sleeve') return !!sleeveDef(r.id) && 'pass' in sleeveDef(r.id)!.cost;
  if (r.k === 'mat') return !!playmatDef(r.id) && 'pass' in playmatDef(r.id)!.cost;
  return r.k !== 'mate';
}

/** Titles, plates and frames this duelist has (ids). */
export const ownedTitles = (s: SpeedSave) => ownList(s).filter((k) => k.startsWith('title:') && titleName(k.slice(6))).map((k) => k.slice(6));
export const ownedPlates = (s: SpeedSave) => PLATES.filter((p) => ownList(s).includes(`plate:${p.id}`)).map((p) => p.id);
export const ownedFrames = (s: SpeedSave) => FRAMES.filter((f) => ownList(s).includes(`frame:${f.id}`)).map((f) => f.id);

export type WearKind = 'title' | 'plate' | 'frame';
/** What this duelist wears (only things they still have). */
export function worn(s: SpeedSave | null | undefined): { title: string | null; plate: string | null; frame: string | null } {
  const w = passOf(s)?.wear ?? {};
  const own = s ? ownList(s) : [];
  const ok = (k: WearKind) => (w[k] && own.includes(`${k}:${w[k]}`) ? w[k]! : null);
  return { title: ok('title') && titleName(w.title) ? w.title! : null, plate: ok('plate'), frame: ok('frame') };
}
/** Puts on (or, with null, takes off) a title, plate or frame the duelist has. */
export function wear(s: SpeedSave, kind: WearKind, id: string | null): SpeedSave | null {
  if (id !== null && !ownList(s).includes(`${kind}:${id}`)) return null;
  const w = { ...(passOf(s)?.wear ?? {}) };
  if (id === null) delete w[kind];
  else w[kind] = id;
  return { ...(s as PS), wear: w } as SpeedSave;
}

// ---------- the season ----------

export interface Claimed {
  tier: number;
  lane: 'free' | 'prem';
  reward: PassReward;
  /** it was already theirs: nothing new */
  dup: boolean;
}

const tierDef = (n: number): Tier => ROAD[n - 1];

/** Rewards reached on a track and not claimed yet. */
export function unclaimed(t: PassTrack): { tier: number; lane: 'free' | 'prem'; reward: PassReward }[] {
  const out: { tier: number; lane: 'free' | 'prem'; reward: PassReward }[] = [];
  const top = tierAt(t.xp);
  for (let n = 1; n <= top; n++) {
    const d = tierDef(n);
    if (d.free && !t.gotF.includes(n)) out.push({ tier: n, lane: 'free', reward: d.free });
    if (t.prem && !t.gotP.includes(n)) out.push({ tier: n, lane: 'prem', reward: d.prem });
  }
  return out;
}
export const toClaim = (s: SpeedSave, now = Date.now()) => {
  const t = trackOf(s, now);
  return t ? unclaimed(t).length : 0;
};

/**
 * A new season: the last one's rewards reached but never claimed are handed over, and the
 * track starts again from tier 0 (the Chips lane closed). Nothing to do: the same save back.
 */
export function rollSeason(s: SpeedSave, now = Date.now()): { save: SpeedSave; carried: Claimed[] } {
  const old = passOf(s)?.pass;
  if (!old || old.season >= passSeason(now)) return { save: s, carried: [] };
  let save = s;
  const carried: Claimed[] = [];
  for (const u of unclaimed(old)) {
    const dup = ownsReward(save, u.reward, old.season);
    save = giveReward(save, u.reward, old.season);
    carried.push({ ...u, dup });
  }
  return { save: { ...(save as PS), pass: freshTrack(passSeason(now), dayOf(now)) } as SpeedSave, carried };
}

/** Claims everything reached (null: nothing to claim, or the clock is behind). */
export function claimAll(s: SpeedSave, now = Date.now()): { save: SpeedSave; got: Claimed[] } | null {
  const rolled = rollSeason(s, now).save;
  const t = trackOf(rolled, now);
  if (!t) return null;
  const list = unclaimed(t);
  if (!list.length) return null;
  let save = rolled;
  const got: Claimed[] = [];
  const gotF = [...t.gotF];
  const gotP = [...t.gotP];
  for (const u of list) {
    const dup = ownsReward(save, u.reward, t.season);
    save = giveReward(save, u.reward, t.season);
    got.push({ ...u, dup });
    (u.lane === 'free' ? gotF : gotP).push(u.tier);
  }
  return { save: { ...(save as PS), pass: { ...t, gotF, gotP } } as SpeedSave, got };
}

/** Why the Chips lane can't be opened now (null: it can). */
export function cantOpenPrem(s: SpeedSave, now = Date.now()): string | null {
  const t = trackOf(rollSeason(s, now).save, now);
  if (!t) return "Your phone's clock is behind: the pass waits for the real date";
  if (t.prem) return 'Already open this season';
  if (chipsOf(s) < PREM_PRICE) return `Needs ${PREM_PRICE} Duel Chips (you have ${chipsOf(s)})`;
  return null;
}
/** Opens this season's Duel Chips lane (every tier already reached is ready to claim). */
export function openPrem(s: SpeedSave, now = Date.now()): SpeedSave | null {
  if (cantOpenPrem(s, now)) return null;
  const rolled = rollSeason(s, now).save;
  const t = trackOf(rolled, now)!;
  return { ...(rolled as PS), chips: chipsOf(rolled) - PREM_PRICE, pass: { ...t, prem: true } } as SpeedSave;
}

// ---------- earning ----------

/** What one finished duel did, as far as the pass cares. */
export interface PassDuel {
  /** the duel counts (see the top of this file) */
  counts: boolean;
  result: 'w' | 'l' | 'd';
  /** given up or over before it got going: no XP */
  quick: boolean;
  /** Duelist Requests this duel finished */
  requests: number;
}

export interface PassGain {
  season: string;
  /** XP before and after */
  from: number;
  to: number;
  /** the pieces, for the result screen ("Win +120", "First win today +150") */
  parts: { label: string; xp: number }[];
  /** the day's cap stopped some of it */
  capped: boolean;
}

/** Moves the pass on after a duel (gain null: it earned nothing). */
export function earnPass(s: SpeedSave, d: PassDuel, now = Date.now()): { save: SpeedSave; gain: PassGain | null; carried: Claimed[] } {
  if (!d.counts) return { save: s, gain: null, carried: [] };
  const { save: rolled, carried } = rollSeason(s, now);
  const t = trackOf(rolled, now);
  if (!t || t.xp >= MAX_XP) return { save: rolled, gain: null, carried };
  const parts: { label: string; xp: number }[] = [];
  let firstWin = t.firstWin;
  if (!d.quick) parts.push(d.result === 'w' ? { label: 'Win', xp: XP_WIN } : { label: d.result === 'd' ? 'Draw' : 'Duel played', xp: XP_LOSS });
  if (!d.quick && d.result === 'w' && !firstWin) {
    parts.push({ label: 'First win today', xp: XP_FIRST_WIN });
    firstWin = true;
  }
  if (d.requests > 0) parts.push({ label: d.requests === 1 ? 'Duelist Request done' : `${d.requests} Duelist Requests done`, xp: d.requests * XP_REQUEST });
  const want = parts.reduce((a, p) => a + p.xp, 0);
  const room = Math.max(0, Math.min(DAY_CAP - t.dayXp, MAX_XP - t.xp));
  const xp = Math.min(room, want);
  if (xp <= 0) return { save: rolled, gain: want > 0 ? { season: t.season, from: t.xp, to: t.xp, parts, capped: true } : null, carried };
  const next: PassTrack = { ...t, xp: t.xp + xp, dayXp: t.dayXp + xp, firstWin };
  return { save: { ...(rolled as PS), pass: next } as SpeedSave, gain: { season: t.season, from: t.xp, to: next.xp, parts, capped: xp < want }, carried };
}

/** XP still to earn today. */
export const xpLeftToday = (s: SpeedSave, now = Date.now()) => {
  const t = trackOf(s, now);
  return t ? Math.max(0, Math.min(DAY_CAP - t.dayXp, MAX_XP - t.xp)) : 0;
};

/** Every title a duelist could wear, for checking one that came from the other phone. */
export const knownTitle = (id: unknown): id is string => typeof id === 'string' && id.length <= 32 && !!titleName(id);
export const knownPlate = (id: unknown): id is string => typeof id === 'string' && !!plateDef(id);
export { TITLES };
