// Card database for the remake: built from public/cards/cards.json (snapshot of
// the YGOPRODeck data for every card in The Eternal Duelist Soul).
import type { CardInfo } from './types';

interface RawCard {
  id: number;
  name: string;
  type: string;
  frame: string;
  desc: string;
  atk?: number;
  def?: number;
  level?: number;
  race?: string;
  attribute?: string;
  img?: boolean;
  n?: number;
  password?: string | null;
  /** legacy (EDS-era) name when YGOPRODeck renamed the card */
  alias?: string;
  /** Skill Cards: whose Skill it is */
  character?: string;
  /** Link Monsters: Link Rating */
  linkval?: number;
  /** Speed Duel products it was printed in */
  sets?: string[];
}

// (import.meta.env is missing when tests load this file under Node)
const BASE = import.meta.env?.BASE_URL ?? '/';
declare const __BUILD_ID__: string;
/** A Map that notes every change, so the lookup caches below know when they are stale. */
class CardMap extends Map<string, CardInfo> {
  set(k: string, v: CardInfo) {
    dbFills++;
    return super.set(k, v);
  }
  delete(k: string) {
    dbFills++;
    return super.delete(k);
  }
  clear() {
    dbFills++;
    super.clear();
  }
}
/** bumped by every change to DB (and every load); the lookup caches compare it */
let dbFills = 0;
export const DB: Map<string, CardInfo> = new CardMap();
const byId = new Map<number, CardInfo>();
const noImage = new Set<number>();
let loaded = false;
const dbStamp = () => `${dbFills}:${DB.size}`;
let byNorm: Map<string, CardInfo> | null = null;
let byNormAt = '';

export function norm(name: string): string {
  return name.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
}

/** A monster with no effect at all: Normal Monsters, Fusions that only list materials, plain Ritual Monsters. */
export function isVanilla(r: { type: string; desc: string }): boolean {
  if (r.type === 'Normal Monster' || r.type === 'Ritual Monster') return true;
  if (r.type !== 'Fusion Monster') return false;
  return r.desc.replace(/^("[^"]+")(\s*\+\s*"[^"]+")+/, '').trim() === '';
}

/** Tuners; Xyz Monsters have a Rank instead of a Level; Link Monsters have a Link Rating. */
function extraStats(r: { type: string; level?: number; linkval?: number; desc: string }, sub: string) {
  const out: { tuner?: boolean; rank?: number; level?: number; linkRating?: number } = {};
  if (/Tuner/.test(r.type)) out.tuner = true;
  if (sub === 'Xyz') (out.rank = r.level), (out.level = undefined);
  if (sub === 'Link') out.linkRating = r.linkval ?? Number(r.desc.match(/^(\d+)/)?.[1] ?? 1);
  return out;
}

function toInfo(r: RawCard): CardInfo {
  const t = r.type;
  let kind: CardInfo['kind'] = 'monster';
  let sub = 'Normal';
  if (t === 'Spell Card') {
    kind = 'spell';
    sub = r.race ?? 'Normal';
  } else if (t === 'Trap Card') {
    kind = 'trap';
    sub = r.race ?? 'Normal';
  } else if (t === 'Ticket Card') {
    kind = 'spell';
    sub = 'Ticket';
  } else if (t === 'Skill Card') {
    kind = 'spell';
    sub = 'Skill';
  } else if (/XYZ|Synchro|Link/.test(t)) sub = t.includes('XYZ') ? 'Xyz' : t.includes('Synchro') ? 'Synchro' : 'Link'; else if (/Fusion/.test(t)) sub = 'Fusion';
  else if (/Ritual/.test(t)) sub = 'Ritual';
  else if (/Effect|Flip|Tuner|Spirit|Toon|Union|Gemini/.test(t)) sub = 'Effect';
  return { id: r.id, name: r.name, kind, sub, atk: r.atk, def: r.def, level: r.level, attribute: r.attribute, race: kind === 'monster' ? r.race : undefined, desc: r.desc, n: r.n, password: r.password, alias: r.alias, character: r.character, vanilla: isVanilla(r), ...extraStats(r, sub) };
}

/** Changes with every deploy, so phones never reuse a card list from an older version of the site. */
const BUILD = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
/** The EDS card list has about 810 cards, each with its EDS number. Anything else is a stale copy. */
const looksCurrent = (list: unknown): list is RawCard[] => Array.isArray(list) && list.length >= 800 && list.every((r) => r && typeof r.name === 'string') && list.filter((r) => typeof r.n === 'number').length >= 800;

async function fetchList(query: string, cache: RequestCache): Promise<RawCard[] | null> {
  try {
    const res = await fetch(`${BASE}cards/cards.json?v=${query}`, { cache });
    if (!res.ok) return null;
    const list: unknown = await res.json();
    return looksCurrent(list) ? list : null;
  } catch {
    return null;
  }
}

export async function loadDb(): Promise<boolean> {
  if (loaded) return true;
  // Ask the server each time (cheap when nothing changed); if a stale or broken copy
  // still comes back, force a fresh download.
  const list = (await fetchList(BUILD, 'no-cache')) ?? (await fetchList(`${BUILD}-${Date.now()}`, 'reload'));
  if (!list) return false;
  for (const r of list) {
    const info = toInfo(r);
    DB.set(info.name, info);
    DB.set(norm(info.name), info);
    byId.set(info.id, info);
    if (r.alias) {
      DB.set(r.alias, info);
      DB.set(norm(r.alias), info);
    }
    if (r.img === false) noImage.add(r.id);
  }
  dbFills++;
  loaded = true;
  return true;
}

// ---------- Speed Duel card pool ----------
let speedLoaded = false;
/** The Speed Duel list has about 1,500 cards and 100+ Skills. */
const looksLikeSpeed = (list: unknown): list is RawCard[] => Array.isArray(list) && list.length >= 1000 && list.every((r) => r && typeof r.name === 'string') && list.some((r) => r.type === 'Skill Card');

async function fetchSpeed(query: string, cache: RequestCache): Promise<RawCard[] | null> {
  try {
    const res = await fetch(`${BASE}cards/speed.json?v=${query}`, { cache });
    if (!res.ok) return null;
    const list: unknown = await res.json();
    return looksLikeSpeed(list) ? list : null;
  } catch {
    return null;
  }
}

/** Adds the Speed Duel cards and Skills to the card database (cards also in EDS keep their EDS entry). */
export function addSpeedCards(list: RawCard[]) {
  for (const r of list) {
    // Some reprints carry a different id in the Speed Duel list (Monster Reborn, Polymerization): match the EDS card by name too.
    const known = byId.get(r.id) ?? (r.type !== 'Skill Card' && DB.get(r.name)?.name === r.name ? DB.get(r.name) : undefined);
    if (known && r.type !== 'Skill Card') {
      known.speed = true;
      if (r.sets) known.speedSets = [...new Set([...(known.speedSets ?? []), ...r.sets])];
      if (known.name !== r.name && !DB.has(r.name)) (DB.set(r.name, known), DB.set(norm(r.name), known));
      continue;
    }
    const info = { ...toInfo(r), speed: true, speedSets: r.sets };
    if (!DB.has(info.name)) DB.set(info.name, info);
    if (!DB.has(norm(info.name))) DB.set(norm(info.name), info);
    byId.set(info.id, info);
    if (r.img === false) noImage.add(r.id);
  }
  dbFills++;
}

export async function loadSpeedDb(): Promise<boolean> {
  if (speedLoaded) return true;
  if (!loaded && !(await loadDb())) return false;
  const list = (await fetchSpeed(BUILD, 'no-cache')) ?? (await fetchSpeed(`${BUILD}-${Date.now()}`, 'reload'));
  if (!list) return false;
  addSpeedCards(list);
  speedLoaded = true;
  return true;
}

export function speedDbLoaded(): boolean {
  return speedLoaded;
}

/**
 * The sorted pool lists below are built once per DB fill (sorting ~1,500 names with
 * localeCompare is slow on a phone, and menus, the deck editor and Deck chat ask often).
 * Callers get their own copy, so sorting or editing one never touches the cache.
 */
let poolCache: { at: string; speed: CardInfo[]; skills: CardInfo[] } | null = null;
function pools() {
  if (poolCache && poolCache.at === dbStamp()) return poolCache;
  const seenA = new Set<number>();
  const speed = [...DB.values()]
    .filter((c) => c.speed && c.sub !== 'Skill' && (seenA.has(c.id) ? false : (seenA.add(c.id), true)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const seenB = new Set<number>();
  const skills = [...DB.values()].filter((c) => c.sub === 'Skill' && (seenB.has(c.id) ? false : (seenB.add(c.id), true))).sort((a, b) => a.name.localeCompare(b.name));
  return (poolCache = { at: dbStamp(), speed, skills });
}

/** Every card in the Speed Duel pool (no Skills), sorted by name. */
export function speedCards(): CardInfo[] {
  return pools().speed.slice();
}

/** Every Skill Card. */
export function skillCards(): CardInfo[] {
  return pools().skills.slice();
}

export function dbLoaded(): boolean {
  return loaded;
}

/**
 * Every card by its normalized real name (the first one in DB order, exactly what a scan of
 * DB.values() would find), so a name that isn't a DB key costs one lookup, not a scan of
 * every card. Rebuilt whenever DB grows or a load fills it.
 */
function cardByNorm(n: string): CardInfo | undefined {
  if (!byNorm || byNormAt !== dbStamp()) {
    byNorm = new Map();
    for (const c of DB.values()) {
      const k = norm(c.name);
      if (!byNorm.has(k)) byNorm.set(k, c);
    }
    byNormAt = dbStamp();
  }
  return byNorm.get(n);
}

export function card(name: string): CardInfo | undefined {
  return DB.get(name) ?? cardByNorm(norm(name));
}

export function imageUrl(name: string): string | null {
  const c = card(name);
  if (!c || c.id === 0 || noImage.has(c.id)) return null;
  return `${BASE}cards/img/${c.id}.webp`;
}

export function cardByPassword(pw: string): CardInfo | undefined {
  // EDS passwords only: Speed Duel-only cards cannot be typed into the EDS trunk.
  const hit = [...DB.values()].find((c) => c.password === pw) ?? byId.get(Number(pw));
  return hit && hit.n !== undefined ? hit : undefined;
}

/** All EDS cards sorted by their in-game number (falls back to name). */
export function allCards(): CardInfo[] {
  const seen = new Set<number>();
  return [...DB.values()]
    .filter((c) => c.n !== undefined && (seen.has(c.id) ? false : (seen.add(c.id), true)))
    .sort((a, b) => (a.n ?? 9999) - (b.n ?? 9999) || a.name.localeCompare(b.name));
}
