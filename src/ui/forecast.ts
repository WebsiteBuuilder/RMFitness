import type { Engine } from '../eds/engine';
import { other } from '../eds/engine';
import { sandbox } from '../eds/aiEval';
import { aiAction } from '../eds/ai';
import type { Action, Pid } from '../eds/types';

export interface Forecast {
  /** "1500 vs 1700" */
  vs: string;
  /** what happens */
  text: string;
  tone: 'good' | 'mid' | 'bad';
}

/**
 * What an attack would do, shown while it is aimed. The battle is played out on a copy of the duel
 * (so damage that bounces back, monsters that can't be destroyed, and boosts in battle all count),
 * with nobody springing a Set card or a card from the hand: those stay a surprise. A face-down
 * target is never looked at.
 */
export function attackForecast(e: Engine, uid: number, target: number | null): Forecast | null {
  // (worked out once per position: a drag re-renders on every finger move)
  const key = `${e.state.seed}:${e.state.turn}:${e.state.log.length}:${e.state.lastEvent?.seq ?? 0}:${uid}:${target}`;
  if (cache.has(key)) return cache.get(key)!;
  const f = compute(e, uid, target);
  if (cache.size > 64) cache.clear();
  cache.set(key, f);
  return f;
}
const cache = new Map<string, Forecast | null>();

function compute(e: Engine, uid: number, target: number | null): Forecast | null {
  const a = e.fieldCard(uid);
  if (!a) return null;
  const atk = e.atkOf(a);
  const t = target === null ? null : e.fieldCard(target);
  if (target !== null && !t) return null;
  if (t && !t.faceUp) return { vs: `${atk} vs ?`, text: 'face-down: flips when hit', tone: 'mid' };
  const vs = t === null ? `${atk} direct` : t.pos === 'atk' ? `${atk} vs ${e.atkOf(t)}` : `${atk} vs DEF ${e.defOf(t)}`;
  const sim = play(e, uid, target);
  if (!sim) return plain(e, atk, t, vs);
  const me = e.controller(uid) as Pid;
  const opp = other(me);
  const took = e.player(me).lp - sim.player(me).lp;
  const dealt = e.player(opp).lp - sim.player(opp).lp;
  const lostMine = !sim.fieldCard(uid);
  const killed = t !== null && !sim.fieldCard(t.uid);
  if (sim.state.winner === me) return { vs, text: 'wins the duel', tone: 'good' };
  const bits: string[] = [];
  if (killed && lostMine) bits.push('both destroyed');
  else if (killed) bits.push('destroys it');
  else if (lostMine) bits.push('yours is destroyed');
  if (dealt > 0) bits.push(`${dealt} damage`);
  if (took > 0) bits.push(`you take ${took}`);
  if (!bits.length) bits.push(t === null ? 'no damage' : 'nothing happens');
  const tone = took > 0 || (lostMine && !killed) ? 'bad' : killed || dealt > 0 ? 'good' : 'mid';
  return { vs, text: bits.join(' · '), tone };
}

/** The attack played out on a copy; null when it can't be told (the copy stopped somewhere odd). */
function play(e: Engine, uid: number, target: number | null): Engine | null {
  if (e.state.prompt || e.state.winner !== null) return null;
  const me = e.controller(uid) as Pid;
  try {
    const sim = sandbox(e);
    sim.apply({ type: 'ATTACK', player: me, uid, target });
    const turn = sim.state.turn;
    for (let i = 0; i < 60 && sim.state.prompt && sim.state.winner === null; i++) {
      const pr = sim.state.prompt;
      let a: Action | null;
      if (pr.kind === 'response') a = { type: 'PASS', player: pr.player };
      else if (pr.kind === 'yesno') a = { type: pr.player === me ? 'YES' : 'NO', player: pr.player };
      else a = aiAction(sim, pr.player);
      if (!a) return null;
      sim.apply(a);
    }
    if (sim.state.prompt || sim.state.turn !== turn) return sim.state.winner !== null ? sim : null;
    return sim;
  } catch {
    return null;
  }
}

/** ATK against ATK or DEF, when the battle can't be played out. */
function plain(e: Engine, atk: number, t: ReturnType<Engine['fieldCard']>, vs: string): Forecast {
  if (!t) return { vs, text: `${atk} damage`, tone: 'good' };
  if (t.pos === 'atk') {
    const v = e.atkOf(t);
    if (atk > v) return { vs, text: `destroys it · ${atk - v} damage`, tone: 'good' };
    if (atk === v) return { vs, text: 'both destroyed', tone: 'mid' };
    return { vs, text: `yours is destroyed · you take ${v - atk}`, tone: 'bad' };
  }
  const d = e.defOf(t);
  if (atk > d) return { vs, text: 'destroys it · no damage', tone: 'good' };
  if (atk === d) return { vs, text: 'nothing happens', tone: 'mid' };
  return { vs, text: `you take ${d - atk}`, tone: 'bad' };
}
