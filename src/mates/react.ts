// What a Mate does when: its reactions (animation, face, symbol) and the duel moments it
// reacts to by itself. Pure, so tests can run it without a screen.
import type { EngineEvent, Pid } from '../eds/types';
import type { Face } from './MateArt';
import type { MateReact } from './roster';

/** The speech bubble over its head. */
export type Bubble = 'note' | 'star' | 'yay' | 'wow' | 'sweat' | 'dots' | 'anger' | 'heart' | 'zzz' | 'ha' | 'gg' | 'taunt';

export interface ReactSpec {
  face: Face;
  /** the little symbol over its head */
  emote: Bubble | null;
  /** how long it plays (ms); a win or loss loops until the duel screen closes */
  ms: number;
  loop?: boolean;
}

export const REACT_SPEC: Record<MateReact, ReactSpec> = {
  wave: { face: 'happy', emote: 'note', ms: 1200 },
  hop: { face: 'happy', emote: 'note', ms: 900 },
  spin: { face: 'laugh', emote: 'star', ms: 1000 },
  cheer: { face: 'laugh', emote: 'yay', ms: 1500 },
  laugh: { face: 'laugh', emote: 'ha', ms: 1400 },
  wow: { face: 'wow', emote: 'wow', ms: 1300 },
  hurt: { face: 'hurt', emote: 'sweat', ms: 1100 },
  sad: { face: 'sad', emote: 'dots', ms: 1800 },
  angry: { face: 'angry', emote: 'anger', ms: 1400 },
  love: { face: 'love', emote: 'heart', ms: 1400 },
  sleep: { face: 'sleep', emote: 'zzz', ms: 3000 },
  win: { face: 'laugh', emote: 'gg', ms: 0, loop: true },
  lose: { face: 'sad', emote: 'dots', ms: 0, loop: true },
  // (the duel's own moments: an attack coming at it, Life Points running low, a gloat, a sprung Trap)
  flinch: { face: 'wow', emote: 'sweat', ms: 900 },
  sweat: { face: 'nervous', emote: 'sweat', ms: 1700 },
  grin: { face: 'smirk', emote: null, ms: 1300 },
  taunt: { face: 'smirk', emote: 'taunt', ms: 2400 },
};

/** Which reaction wins when one moment brings several (a summon that cost a monster: the summon). */
const RANK: Record<MateReact, number> = { win: 9, lose: 9, taunt: 8, sad: 7, sweat: 6, cheer: 6, flinch: 5, hurt: 5, wow: 4, angry: 4, laugh: 3, grin: 3, love: 2, spin: 2, wave: 1, hop: 1, sleep: 0 };

export interface Cue {
  player: Pid;
  react: MateReact;
  /** a taunt's words in its bubble */
  line?: string;
}

/** What a Mate says when its duelist's Trap catches the other side. */
export const TAUNTS = ['Gotcha!', 'Saw that coming!', 'Trap card!', 'Walked right into it!', 'Too easy!', 'Nice try!', 'Sprung!', 'Got you now!'];
/** Life Points this low or under and a Mate starts to sweat. */
export const LOW_LP = 1000;

const otherSeat = (p: Pid): Pid => (p === 0 ? 1 : 0);

/**
 * The reactions to a batch of new duel events, at most one per seat: each Mate reacts for
 * its own duelist (their big summon is a cheer; the other side's is a wow). Each phone works
 * them out from the same events, so an online room sees the same reactions with nothing sent.
 * `big(ev)`: a summon worth cheering (level 7+, Fusion, Ritual...). `lost`: monsters each
 * seat lost from the field in the batch. `sprung(ev)`: a Trap's activation answering the
 * other side's card (its attack, its Summon, its card): the seat it caught, or null.
 */
export function cuesFor(evs: EngineEvent[], big: (ev: EngineEvent) => boolean, lost: [number, number] = [0, 0], sprung: (ev: EngineEvent) => Pid | null = () => null): Cue[] {
  const best: [MateReact | null, MateReact | null] = [null, null];
  const lines: [string | undefined, string | undefined] = [undefined, undefined];
  const offer = (p: Pid | undefined, r: MateReact, line?: string) => {
    if (p !== 0 && p !== 1) return;
    const cur = best[p];
    if (!cur || RANK[r] > RANK[cur]) (best[p] = r), (lines[p] = line);
  };
  for (const ev of evs) {
    if (ev.kind === 'summon' && ev.player !== undefined) {
      const huge = big(ev);
      offer(ev.player, huge ? 'cheer' : 'hop');
      if (huge) offer(otherSeat(ev.player), 'wow');
    } else if (ev.kind === 'attack' && ev.player !== undefined) {
      // (the monster coming at it, or straight at its duelist)
      offer(otherSeat(ev.player), 'flinch');
    } else if (ev.kind === 'activate' && ev.player !== undefined) {
      const caught = sprung(ev);
      if (caught !== null && caught !== ev.player) {
        // (the line comes from the event itself, so both phones pick the same one)
        offer(ev.player, 'taunt', TAUNTS[ev.seq % TAUNTS.length]);
        offer(caught, 'flinch');
      }
    } else if (ev.kind === 'damage' && ev.player !== undefined && (ev.amount ?? 0) > 0) {
      const a = ev.amount ?? 0;
      const left = ev.from !== undefined ? ev.from - a : null;
      offer(ev.player, a >= 2000 ? 'sad' : left !== null && left > 0 && left <= LOW_LP ? 'sweat' : 'hurt');
      offer(otherSeat(ev.player), a >= 1000 ? 'laugh' : 'grin');
    }
  }
  for (const p of [0, 1] as Pid[])
    if (lost[p] > 0) {
      offer(p, 'sad');
      // (the side that knocked it off looks pleased with itself)
      if (!lost[otherSeat(p)]) offer(otherSeat(p), 'grin');
    }
  const out: Cue[] = [];
  for (const p of [0, 1] as Pid[]) {
    const r = best[p];
    if (r) out.push(lines[p] ? { player: p, react: r, line: lines[p] } : { player: p, react: r });
  }
  return out;
}

/** The end of the duel: the winner's Mate celebrates, the loser's slumps (a draw: both gasp). */
export function endCues(winner: Pid | 'draw'): Cue[] {
  if (winner === 'draw') return [{ player: 0, react: 'wow' }, { player: 1, react: 'wow' }];
  return [
    { player: winner, react: 'win' },
    { player: otherSeat(winner), react: 'lose' },
  ];
}

/** This phone's own sends: a short wait between reactions, so tapping fast doesn't flood the room. */
export const SEND_GAP_MS = 1000;
export function canSend(last: number, now = Date.now()): boolean {
  return now - last >= SEND_GAP_MS;
}

/** A tap's reaction: one of the mate's own, never the same twice in a row when it has others. */
export function tapReact(taps: MateReact[], last: MateReact | null, roll = Math.random()): MateReact {
  const pool = taps.length > 1 ? taps.filter((t) => t !== last) : taps;
  return pool[Math.min(pool.length - 1, Math.floor(roll * pool.length))] ?? 'hop';
}
