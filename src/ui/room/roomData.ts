// The Duelist Room (the 3D home hub on the Duel tab): what sits on its shelves and boards.
// Pure: reads the saves, never writes them, so the room is cosmetic and navigation only.
import type { SpeedSave } from '../../eds/speedSave';
import type { SoloSave } from '../../eds/speedCampaign/save';
import { rankedProgress, pharaohLevel, stepName, TOP } from '../../eds/speedCampaign/ranked';
import { aceOf, bondTitle, type AceInfo } from '../../ace/ace';
import { boardOf, requestText } from '../../collection/requests';
import { bestCrown } from '../../collection/economy';
import { lessonsDone, LESSONS } from '../../eds/tutorial';

/** One trophy on the shelf. */
export type Trophy =
  | { kind: 'rank'; step: number; asc: number; level: number; label: string }
  | { kind: 'cup'; metal: 'bronze' | 'silver' | 'gold'; wins: number; label: string }
  | { kind: 'crown'; rival: string; label: string }
  | { kind: 'school'; label: string }
  | { kind: 'bond'; lv: number; label: string };

/** Wins needed for each cup. */
export const CUPS = [
  { metal: 'gold', at: 100 },
  { metal: 'silver', at: 25 },
  { metal: 'bronze', at: 1 },
] as const;

/** The shelf, best first; at most `max` trophies (the shelf only holds so many). */
export function trophiesOf(save: SpeedSave, solo: SoloSave | null, max = 5): Trophy[] {
  const out: Trophy[] = [];
  if (solo) {
    const rp = rankedProgress(solo);
    const best = Math.max(rp.peak, ...rp.history.map((h) => h.peak));
    if (rp.w + rp.l > 0 || rp.history.length > 0) {
      // this season's rank while it's played, otherwise the best one ever reached
      const step = rp.w + rp.l > 0 ? rp.step : best;
      out.push({ kind: 'rank', step, asc: rp.w + rp.l > 0 ? (rp.asc ?? 0) : 0, level: step === TOP && rp.w + rp.l > 0 ? pharaohLevel(rp.kp) : 0, label: stepName(step) });
    }
  }
  const crown = bestCrown(save);
  if (crown) out.push({ kind: 'crown', rival: crown.rival, label: `King of Games over ${crown.rival}` });
  const cup = CUPS.find((c) => save.wins >= c.at);
  if (cup) out.push({ kind: 'cup', metal: cup.metal, wins: save.wins, label: `${save.wins} ${save.wins === 1 ? 'win' : 'wins'}` });
  const ace = aceOf(save);
  if (ace && ace.lv >= 2) out.push({ kind: 'bond', lv: ace.lv, label: `${bondTitle(ace.lv)} ${ace.name}` });
  if (lessonsDone(save).length >= LESSONS.length) out.push({ kind: 'school', label: 'Duel School graduate' });
  return out.slice(0, max);
}

/** The missions board: today's Duelist Requests as pinned notes. */
export interface BoardNote {
  who: string;
  text: string;
  have: number;
  need: number;
  done: boolean;
}
export function boardNotes(save: SpeedSave, now = Date.now()): { notes: BoardNote[]; done: number } {
  const b = boardOf(save, now);
  if (!b) return { notes: [], done: 0 };
  const notes = b.list.map((r) => ({ who: r.giver, text: requestText(r), have: Math.min(r.have, r.need), need: r.need, done: r.done }));
  return { notes, done: notes.filter((n) => n.done).length };
}

/** The monster standing behind you: your chosen Ace, else the deck's strongest monster. */
export function roomAce(save: SpeedSave, deckAce: string | null): { name: string; ace: AceInfo | null } | null {
  const a = aceOf(save);
  if (a) return { name: a.name, ace: a };
  return deckAce ? { name: deckAce, ace: null } : null;
}

// ---------- the setting: the room, or the plain menu ----------

/** The room is sized in container units: an older phone browser without them (before iOS 16 or
 *  Chrome 105) keeps the plain menu instead of a collapsed room. */
export function roomSupported(): boolean {
  try {
    return typeof CSS !== 'undefined' && CSS.supports('container-type: size') && CSS.supports('height: 1cqh');
  } catch {
    return false;
  }
}

export type HomeLook = 'room' | 'plain';
const KEY = 'eds.homeLook';
const subs = new Set<() => void>();
/** the last pick this session (when the phone won't store it) */
let mem: HomeLook | null = null;

export function homeLook(): HomeLook {
  if (mem) return mem;
  try {
    return globalThis.localStorage?.getItem(KEY) === 'plain' ? 'plain' : 'room';
  } catch {
    return 'room';
  }
}
export function setHomeLook(v: HomeLook): void {
  mem = v;
  try {
    globalThis.localStorage?.setItem(KEY, v);
  } catch {
    /* private mode: just this session */
  }
  for (const f of subs) f();
}
export function onHomeLook(f: () => void): () => void {
  subs.add(f);
  return () => void subs.delete(f);
}
