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
}

const BASE = import.meta.env.BASE_URL;
declare const __BUILD_ID__: string;
export const DB = new Map<string, CardInfo>();
const byId = new Map<number, CardInfo>();
const noImage = new Set<number>();
let loaded = false;

export function norm(name: string): string {
  return name.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
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
  } else if (/Fusion/.test(t)) sub = 'Fusion';
  else if (/Ritual/.test(t)) sub = 'Ritual';
  else if (/Effect|Flip|Tuner|Spirit|Toon|Union|Gemini/.test(t)) sub = 'Effect';
  return { id: r.id, name: r.name, kind, sub, atk: r.atk, def: r.def, level: r.level, attribute: r.attribute, race: kind === 'monster' ? r.race : undefined, desc: r.desc, n: r.n, password: r.password, alias: r.alias };
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
  loaded = true;
  return true;
}

export function dbLoaded(): boolean {
  return loaded;
}

export function card(name: string): CardInfo | undefined {
  return DB.get(name) ?? [...DB.values()].find((c) => norm(c.name) === norm(name));
}

export function imageUrl(name: string): string | null {
  const c = card(name);
  if (!c || c.id === 0 || noImage.has(c.id)) return null;
  return `${BASE}cards/img/${c.id}.webp`;
}

export function cardByPassword(pw: string): CardInfo | undefined {
  return [...DB.values()].find((c) => c.password === pw) ?? byId.get(Number(pw));
}

/** All EDS cards sorted by their in-game number (falls back to name). */
export function allCards(): CardInfo[] {
  const seen = new Set<number>();
  return [...DB.values()]
    .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
    .sort((a, b) => (a.n ?? 9999) - (b.n ?? 9999) || a.name.localeCompare(b.name));
}
