// The Ranked leaderboard everyone shares: each duelist's rank this season goes up to the online
// service (net/rk/<season>/<duelist>), and every phone reads the whole season back, so you see
// your brother's rank even when he isn't online, and anyone else who plays the game.
//
// Lines are stored as JSON text, like the rest of online play. It's bragging rights only: nothing reads it to pay a prize, because a phone could post
// anything. What comes back is cleaned before it's shown. With no online service the
// leaderboard falls back to the duelists this phone knows (see Rankings.tsx).
import { checkCloud, onlineDb } from '../sync/cloud';
import { KING, TOP, starsAt, tierFloor, type RankedProgress } from '../eds/speedCampaign/ranked';

/** One duelist's line on the shared leaderboard. */
export interface BoardPost {
  /** the duelist's key (their shared account id, or their profile id) */
  id: string;
  name: string;
  color: string;
  step: number;
  stars: number;
  /** Pharaoh Points */
  kp: number;
  w: number;
  l: number;
  /** when it was posted */
  at: number;
}

/** Most duelists a season's board keeps showing. */
export const BOARD_MAX = 100;

const keyOf = (id: string) => id.replace(/[.#$[\]/]/g, '_').slice(0, 64) || 'x';
const path = (season: string) => `net/rk/${season}`;

/** How far up the whole ladder a rank is, in stars (a Pharaoh Point counts as one): sorts the board. */
export function ladderScore(step: number, stars: number, kp: number): number {
  let n = 0;
  for (let i = 0; i < Math.min(step, TOP); i++) n += starsAt(i);
  return step >= TOP ? n + kp : n + stars;
}

/** Keeps a posted line sane (it comes from another phone). */
export function cleanPost(id: string, x: unknown): BoardPost | null {
  const o = x as Partial<BoardPost> | null;
  if (!o || typeof o !== 'object' || typeof o.name !== 'string') return null;
  const n = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0);
  const name = o.name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24);
  if (!name) return null;
  const step = n(o.step, TOP);
  const w = n(o.w, 1e6);
  const stars = step === TOP ? 0 : Math.min(n(o.stars, 9), starsAt(step) - 1);
  // every Pharaoh Point is a win; and nobody climbs faster than 3 stars a win above where a season can start them
  const kp = step === TOP ? Math.min(n(o.kp, 100000), w) : 0;
  if (ladderScore(step, stars, kp) > ladderScore(tierFloor(KING - 1), 0, 0) + 3 * w) return null;
  return {
    id,
    name,
    color: typeof o.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(o.color) ? o.color : '#888888',
    step,
    stars,
    kp,
    w,
    l: n(o.l, 1e6),
    at: n(o.at, 1e14),
  };
}

/** The board's lines from what the service holds for a season, best first. */
export function boardFrom(raw: unknown): BoardPost[] {
  if (!raw || typeof raw !== 'object') return [];
  const out: BoardPost[] = [];
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    let body = v;
    if (typeof v === 'string')
      try {
        body = JSON.parse(v);
      } catch {
        continue;
      }
    const p = cleanPost(id, body);
    if (p) out.push(p);
  }
  out.sort((a, b) => ladderScore(b.step, b.stars, b.kp) - ladderScore(a.step, a.stars, a.kp) || b.w - a.w || a.at - b.at);
  return out.slice(0, BOARD_MAX);
}

/** The line a duelist posts for their rank now. */
export function postOf(id: string, name: string, color: string, p: RankedProgress, at = Date.now()): BoardPost {
  return { id: keyOf(id), name: name.slice(0, 24), color, step: p.step, stars: p.stars, kp: p.kp, w: p.w, l: p.l, at };
}

let last = '';

/** Puts this duelist's rank on the shared board (quietly does nothing without the online service). */
export async function postRanked(id: string, name: string, color: string, p: RankedProgress | undefined): Promise<void> {
  if (!p || p.w + p.l + (p.d ?? 0) === 0) return;
  const post = postOf(id, name, color, p);
  const { id: key, ...body } = post;
  const sig = JSON.stringify([p.season, key, { ...body, at: 0 }]);
  if (sig === last) return;
  try {
    if ((await checkCloud()) !== 'on') return;
    const db = await onlineDb();
    await db.set(`${path(p.season)}/${key}`, JSON.stringify(body));
    last = sig;
  } catch (e) {
    console.warn('ranked board:', e);
  }
}

/** Follows a season's shared board. `cb` gets the lines, best first; null while there's no online service. */
export function watchRanked(season: string, cb: (rows: BoardPost[] | null) => void): () => void {
  let stop: (() => void) | null = null;
  let done = false;
  cb(null);
  void (async () => {
    try {
      if ((await checkCloud()) !== 'on' || done) return;
      const db = await onlineDb();
      if (done) return;
      stop = db.onValue(path(season), (v) => cb(boardFrom(v)), () => cb(null));
    } catch {
      cb(null);
    }
  })();
  return () => {
    done = true;
    stop?.();
  };
}

// ---------- the board as shown ----------

/** One line of the leaderboard as shown: from the shared board, this phone or a friend. */
export interface LadderRow {
  name: string;
  color: string;
  step: number;
  stars: number;
  kp: number;
  w: number;
  l: number;
  kind: 'me' | 'phone' | 'friend' | 'world';
  online?: boolean;
}

/** A ladder line from a rank. */
export const rowOf = (name: string, color: string, rp: Pick<RankedProgress, 'step' | 'stars' | 'kp' | 'w' | 'l'>, kind: LadderRow['kind'], isOn?: boolean): LadderRow => ({
  name,
  color,
  step: rp.step,
  stars: rp.step === TOP ? 0 : rp.stars,
  kp: rp.step === TOP ? rp.kp : 0,
  w: rp.w,
  l: rp.l,
  kind,
  ...(isOn ? { online: true } : {}),
});

const score = (r: LadderRow) => ladderScore(r.step, r.stars, r.kp);

/** Both lists as one board: one line a name (yours always from this phone), best first. */
export function mergeLadder(local: LadderRow[], world: BoardPost[] | null, myKey?: string): LadderRow[] {
  const m = new Map<string, LadderRow>();
  for (const r of local) m.set(r.name.toLowerCase(), r);
  const mine = myKey === undefined ? null : keyOf(myKey);
  for (const p of world ?? []) {
    // your own post (even under an old name) is already your line from this phone
    if (p.id === mine) continue;
    // a duelist this phone knows (its profiles, friends) keeps the line it has: a post can't take it over
    if (m.has(p.name.toLowerCase())) continue;
    m.set(`#${p.id}`, rowOf(p.name, p.color, p, 'world'));
  }
  return [...m.values()].sort((a, b) => score(b) - score(a) || b.w - a.w || a.name.localeCompare(b.name));
}

/** Stars between two rows ("3 stars"), for the rival line. */
export const starsBetween = (a: LadderRow, b: LadderRow) => Math.max(0, score(a) - score(b));

