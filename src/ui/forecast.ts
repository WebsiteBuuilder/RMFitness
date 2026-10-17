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
  let cache = caches.get(e);
  if (!cache) caches.set(e, (cache = new Map()));
  const key = `${e.state.seed}:${e.state.turn}:${e.state.log.length}:${e.state.lastEvent?.seq ?? 0}:${uid}:${target}`;
  if (cache.has(key)) return cache.get(key)!;
  const f = compute(e, uid, target);
  if (cache.size > 64) cache.clear();
  cache.set(key, f);
  return f;
}
/** per duel (two duels can share a seed) */
const caches = new WeakMap<Engine, Map<string, Forecast | null>>();

function compute(e: Engine, uid: number, target: number | null): Forecast | null {
  const a = e.fieldCard(uid);
  if (!a) return null;
  const atk = e.atkOf(a);
  const t = target === null ? null : e.fieldCard(target);
  if (target !== null && !t) return null;
  if (t && !t.faceUp) return { vs: `${atk} vs ?`, text: 'face-down: flips when hit', tone: 'mid' };
  const vs = t === null ? `${atk} direct` : t.pos === 'atk' ? `${atk} vs ${e.atkOf(t)}` : `${atk} vs DEF ${e.defOf(t)}`;
  const sim = play(e, uid, target, 0);
  if (!sim) return plain(e, atk, t, vs);
  const me = e.controller(uid) as Pid;
  const first = outcome(e, sim, uid, t, me);
  // a dice or coin in the battle (Skull Dice, Graceful Dice, Jirai Gumo...): throw it again several times and,
  // if the ending changes, say so and name the two likeliest endings (only if the battle threw anything)
  const threw = sim.state.rngState !== ((sandbox(e).state.rngState) >>> 0);
  if (!threw) return { vs, ...first };
  const seen = new Map<string, { n: number; o: Outcome }>([[first.text, { n: 1, o: first }]]);
  for (let i = 1; i <= 11; i++) {
    const o = play(e, uid, target, Math.imul(0x9e3779b9, i) >>> 0);
    if (!o) continue;
    const r = outcome(e, o, uid, t, me);
    const got = seen.get(r.text);
    if (got) got.n++;
    else seen.set(r.text, { n: 1, o: r });
  }
  if (seen.size < 2) return { vs, ...first };
  // what both endings share is said plainly; only the part the throw decides is put as luck
  const [la, lb] = [...seen.values()].sort((x, y) => y.n - x.n).slice(0, 2).map((x) => x.o.text.split(' · '));
  const same = la.filter((x) => lb.includes(x));
  const da = la.filter((x) => !same.includes(x)).join(' · ');
  const db = lb.filter((x) => !same.includes(x)).join(' · ');
  const luck = !da || !db ? `luck: maybe ${da || db}` : `luck: ${da} or ${db}`;
  return { vs, text: [...same, luck].join(' · '), tone: 'mid' };
}

type Outcome = { text: string; tone: Forecast['tone'] };
function outcome(e: Engine, sim: Engine, uid: number, t: ReturnType<Engine['fieldCard']>, me: Pid): Outcome {
  const opp = other(me);
  if (sim.state.winner === me) return { text: 'wins the duel', tone: 'good' };
  if (sim.state.winner === opp) return { text: 'you lose the duel', tone: 'bad' };
  const took = e.player(me).lp - sim.player(me).lp;
  const dealt = e.player(opp).lp - sim.player(opp).lp;
  const lostMine = !sim.fieldCard(uid);
  const killed = t !== null && !sim.fieldCard(t.uid);
  const bits: string[] = [];
  if (killed && lostMine) bits.push('both destroyed');
  else if (killed) bits.push('destroys it');
  else if (lostMine) bits.push('yours is destroyed');
  if (dealt > 0) bits.push(`${dealt} damage`);
  if (took > 0) bits.push(`you take ${took}`);
  if (!bits.length) bits.push(t === null ? 'no damage' : 'nothing happens');
  // an even trade is neither a win nor a loss (the Trade chip)
  const tone = took > 0 || (lostMine && !killed) ? 'bad' : killed && lostMine && dealt === 0 ? 'mid' : killed || dealt > 0 ? 'good' : 'mid';
  return { text: bits.join(' · '), tone };
}

/** The attack played out on a copy; null when it can't be told (the copy stopped somewhere odd). */
function play(e: Engine, uid: number, target: number | null, salt: number): Engine | null {
  if (e.state.prompt || e.state.winner !== null) return null;
  const me = e.controller(uid) as Pid;
  try {
    const sim = sandbox(e);
    sim.state.rngState = (sim.state.rngState ^ salt) >>> 0;
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
