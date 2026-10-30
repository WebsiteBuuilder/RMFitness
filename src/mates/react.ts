// What a Mate does when: its reactions (animation, face, symbol) and the duel moments it
// reacts to by itself. Pure, so tests can run it without a screen.
import type { EngineEvent, Pid } from '../eds/types';
import type { Face } from './MateArt';
import type { MateReact } from './roster';

export interface ReactSpec {
  face: Face;
  /** the little symbol over its head */
  emote: 'note' | 'star' | 'bang' | 'sweat' | 'dots' | 'anger' | 'heart' | 'zzz' | 'ha' | null;
  /** how long it plays (ms); a win or loss loops until the duel screen closes */
  ms: number;
  loop?: boolean;
}

export const REACT_SPEC: Record<MateReact, ReactSpec> = {
  wave: { face: 'happy', emote: 'note', ms: 1200 },
  hop: { face: 'happy', emote: null, ms: 800 },
  spin: { face: 'laugh', emote: 'star', ms: 1000 },
  cheer: { face: 'laugh', emote: 'bang', ms: 1400 },
  laugh: { face: 'laugh', emote: 'ha', ms: 1400 },
  wow: { face: 'wow', emote: 'bang', ms: 1200 },
  hurt: { face: 'hurt', emote: 'sweat', ms: 1100 },
  sad: { face: 'sad', emote: 'dots', ms: 1800 },
  angry: { face: 'angry', emote: 'anger', ms: 1400 },
  love: { face: 'love', emote: 'heart', ms: 1400 },
  sleep: { face: 'sleep', emote: 'zzz', ms: 3000 },
  win: { face: 'laugh', emote: 'star', ms: 0, loop: true },
  lose: { face: 'sad', emote: 'dots', ms: 0, loop: true },
};

/** Which reaction wins when one moment brings several (a summon that cost a monster: the summon). */
const RANK: Record<MateReact, number> = { win: 9, lose: 9, sad: 7, cheer: 6, hurt: 5, wow: 4, angry: 4, laugh: 3, love: 2, spin: 2, wave: 1, hop: 1, sleep: 0 };

export interface Cue {
  player: Pid;
  react: MateReact;
}

const otherSeat = (p: Pid): Pid => (p === 0 ? 1 : 0);

/**
 * The reactions to a batch of new duel events, at most one per seat: each Mate reacts for
 * its own duelist (their big summon is a cheer; the other side's is a wow).
 * `big(ev)`: a summon worth cheering (level 7+, Fusion, Ritual...). `lost`: monsters each
 * seat lost from the field in the batch.
 */
export function cuesFor(evs: EngineEvent[], big: (ev: EngineEvent) => boolean, lost: [number, number] = [0, 0]): Cue[] {
  const best: [MateReact | null, MateReact | null] = [null, null];
  const offer = (p: Pid | undefined, r: MateReact) => {
    if (p !== 0 && p !== 1) return;
    const cur = best[p];
    if (!cur || RANK[r] > RANK[cur]) best[p] = r;
  };
  for (const ev of evs) {
    if (ev.kind === 'summon' && ev.player !== undefined) {
      const huge = big(ev);
      offer(ev.player, huge ? 'cheer' : 'hop');
      if (huge) offer(otherSeat(ev.player), 'wow');
    } else if (ev.kind === 'damage' && ev.player !== undefined && (ev.amount ?? 0) > 0) {
      const a = ev.amount ?? 0;
      offer(ev.player, a >= 2000 ? 'sad' : 'hurt');
      offer(otherSeat(ev.player), a >= 1000 ? 'laugh' : 'hop');
    }
  }
  for (const p of [0, 1] as Pid[]) if (lost[p] > 0) offer(p, 'sad');
  const out: Cue[] = [];
  for (const p of [0, 1] as Pid[]) {
    const r = best[p];
    if (r) out.push({ player: p, react: r });
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
