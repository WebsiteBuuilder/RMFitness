// The computer's sense of the board: a quick score of a position, a one-move lookahead on a
// throwaway copy of the duel, and what its attacks could do this turn (lethal, kills a boost
// would enable). Everything here only reads public information plus the computer's own cards:
// face-down cards of the opponent are guessed, and the lookahead re-seeds the dice so it
// can't see the future.
import { Engine, other } from './engine';
import type { Action, FieldCard, Pid } from './types';

export const WIN = 1e6;

/** Life Points are worth more the fewer you have. */
const lpValue = (lp: number) => Math.max(0, lp) + Math.max(0, 1500 - lp) * 0.6;

function monsterValue(e: Engine, m: FieldCard, viewer: Pid, owner: Pid): number {
  if (!m.faceUp && owner !== viewer) return 900;
  const atk = m.faceUp ? e.atkOf(m) : (e.info(m.name).atk ?? 0);
  const def = m.faceUp ? e.defOf(m) : (e.info(m.name).def ?? 0);
  return 200 + 0.7 * Math.max(atk, def * 0.8);
}

function sideValue(e: Engine, p: Pid, viewer: Pid): number {
  const ps = e.player(p);
  let v = lpValue(ps.lp);
  for (const m of e.monsters(p)) v += monsterValue(e, m, viewer, p);
  for (const c of e.spells(p)) v += c.equippedTo !== undefined ? 0 : c.faceUp ? 250 : 350;
  if (ps.field) v += 200;
  v += 300 * Math.min(ps.hand.length, 6) + 100 * Math.max(0, ps.hand.length - 6);
  // Running out of cards loses the Duel.
  if (ps.deck.length === 0) v -= 3000;
  else if (ps.deck.length <= 3) v -= (4 - ps.deck.length) * 300;
  return v;
}

/** How good the position is for `me` (higher is better; a won Duel is WIN). */
export function evaluate(e: Engine, me: Pid): number {
  const w = e.state.winner;
  if (w === me) return WIN;
  if (w === other(me)) return -WIN;
  if (w === 'draw') return -WIN / 4;
  return sideValue(e, me, me) - sideValue(e, other(me), me);
}

/** A throwaway copy of the duel (log trimmed to this turn, dice re-seeded so the copy can't read the future). */
export function sandbox(e: Engine): Engine {
  const st = e.state;
  const sim = new Engine(e.db, true);
  sim.state = structuredClone({ ...st, log: st.log.filter((l) => l.turn === st.turn), events: [], lastEvent: null });
  sim.state.rngState = (st.rngState ^ 0x5bd1e995) >>> 0;
  return sim;
}

export type Chooser = (e: Engine, p: Pid) => Action | null;

/**
 * Plays `action` on a copy of the duel until it has finished (both players' prompts answered:
 * `me` by `choose`, the opponent by `choose` too except that it never springs a card in
 * response, since the computer can't know what the Set cards are). Returns how much the
 * position changed for `me`, or null when it can't be told.
 */
export function lookahead(e: Engine, me: Pid, action: Action, choose: Chooser): number | null {
  if (e.state.prompt || e.state.winner !== null) return null;
  return playOut(e, me, action, choose);
}

/**
 * Like lookahead, but from an open question (a "Respond?" window): answers it with `action`
 * and plays the chain and the rest of that battle out. Used to judge a response before springing it.
 */
export function lookaheadAnswer(e: Engine, me: Pid, action: Action, choose: Chooser): number | null {
  if (!e.state.prompt || e.state.winner !== null) return null;
  return playOut(e, me, action, choose);
}

function playOut(e: Engine, me: Pid, action: Action, choose: Chooser): number | null {
  const r = playOutSim(e, me, action, choose);
  return r && r.value;
}

/**
 * A play that only pays off with the next one (Toon World before a Toon, a Spell that frees a
 * Tribute): the play, then the best Summon it opened up, judged together. Returns the better of
 * the play alone and the play plus that Summon, or null when it can't be told.
 */
export function lookaheadCombo(e: Engine, me: Pid, action: Action, choose: Chooser): number | null {
  if (e.state.prompt || e.state.winner !== null) return null;
  const first = playOutSim(e, me, action, choose);
  if (!first) return null;
  const sim = first.sim;
  if (sim.state.winner !== null || sim.state.turnPlayer !== me || !sim.inMainPhase()) return first.value;
  const ps = sim.player(me);
  const before = e.player(me);
  const follow: Action[] = [];
  for (const c of ps.hand) {
    const was = before.hand.find((x) => x.uid === c.uid);
    if (sim.canSpecialProc(me, c) && !(was && e.canSpecialProc(me, was))) follow.push({ type: 'SPECIAL', player: me, uid: c.uid });
    else if (!ps.normalSummoned && sim.canNormalSummon(me, c, true) && !(was && e.canNormalSummon(me, was, true)) && sim.freeMonsterZone(me) >= 0)
      follow.push({ type: 'SUMMON', player: me, uid: c.uid, zone: sim.freeMonsterZone(me), pos: 'atk', faceUp: true });
  }
  let best = first.value;
  const base = evaluate(e, me);
  for (const a of follow.slice(0, 4)) {
    const r = playOutSim(sim, me, a, choose);
    if (r) best = Math.max(best, evaluate(r.sim, me) - base);
  }
  return best;
}

function playOutSim(e: Engine, me: Pid, action: Action, choose: Chooser): { sim: Engine; value: number } | null {
  let sim: Engine;
  try {
    sim = sandbox(e);
  } catch {
    return null;
  }
  const before = evaluate(e, me);
  const turn = sim.state.turn;
  try {
    sim.apply(action);
    for (let i = 0; i < 120 && sim.state.prompt && sim.state.winner === null; i++) {
      const pr = sim.state.prompt;
      let a: Action | null;
      if (pr.kind === 'response') a = { type: 'PASS', player: pr.player };
      else if (pr.kind === 'yesno' && pr.player !== me) a = { type: 'NO', player: pr.player };
      else a = choose(sim, pr.player);
      if (!a) return null;
      sim.apply(a);
    }
  } catch {
    return null;
  }
  if (sim.state.prompt && sim.state.winner === null) return null;
  if (sim.state.turn !== turn && sim.state.winner === null) return null;
  return { sim, value: evaluate(sim, me) - before };
}

/** What a monster on the opponent's side needs to be beaten (face-down ones are a guess). */
export function wall(e: Engine, t: FieldCard): number {
  if (!t.faceUp) return 1500;
  return t.pos === 'atk' ? e.atkOf(t) : e.defOf(t);
}

/** Monsters of `p` that could attack this turn (ignoring the phase: used from Main Phase 1 too). */
export function attackers(e: Engine, p: Pid): FieldCard[] {
  const s = e.state;
  if (s.firstTurn || s.turnPlayer !== p) return [];
  return e.monsters(p).filter((m) => {
    if (!m.faceUp || m.pos !== 'atk' || m.cannotAttack) return false;
    if ((m.tags?.noAttackTurn ?? -1) === s.turn) return false;
    if (s.phase === 'BP') return e.canAttackWith(p, m);
    return !m.attacked;
  });
}

export interface AttackPlan {
  steps: { uid: number; target: number | null }[];
  damage: number;
}

/**
 * The most damage `p`'s attacks can do this turn, the simple way: the weakest attacker that
 * beats each blocker takes it out, everyone else attacks directly. `bonus` adds ATK
 * (to try a Skill or a boost before using it).
 */
export function attackPlan(e: Engine, p: Pid, bonus: (m: FieldCard) => number = () => 0): AttackPlan {
  const opp = other(p);
  const mine = attackers(e, p).map((m) => ({ m, atk: e.atkOf(m) + bonus(m), direct: e.canAttackDirectly(m) }));
  const blockers = e.monsters(opp).slice().sort((a, b) => wall(e, b) - wall(e, a));
  const steps: AttackPlan['steps'] = [];
  let damage = 0;
  const free = mine.filter((x) => !x.direct).sort((a, b) => a.atk - b.atk);
  const left = blockers.slice();
  for (const t of blockers) {
    const need = wall(e, t);
    const i = free.findIndex((x) => x.atk > need);
    if (i < 0) continue;
    const a = free.splice(i, 1)[0];
    steps.push({ uid: a.m.uid, target: t.uid });
    if (t.faceUp && t.pos === 'atk') damage += a.atk - need;
    left.splice(left.indexOf(t), 1);
  }
  // Direct attacks: only once every blocker is gone (or for monsters that can always attack directly).
  for (const x of mine.filter((y) => y.direct)) (steps.push({ uid: x.m.uid, target: null }), (damage += x.atk));
  if (left.length === 0) for (const x of free) (steps.push({ uid: x.m.uid, target: null }), (damage += x.atk));
  return { steps, damage };
}

/** A plan that wins this turn (by battle), or null. */
export function lethalPlan(e: Engine, p: Pid): AttackPlan | null {
  const plan = attackPlan(e, p);
  return plan.steps.length && plan.damage >= e.player(other(p)).lp ? plan : null;
}

/** Would giving these ATK bonuses let `p` destroy something it can't now, or win this turn? */
export function boostHelps(e: Engine, p: Pid, bonus: (m: FieldCard) => number): boolean {
  const opp = other(p);
  const lp = e.player(opp).lp;
  const now = attackPlan(e, p);
  const boosted = attackPlan(e, p, bonus);
  if (now.damage < lp && boosted.damage >= lp) return true;
  const kills = (pl: AttackPlan) => pl.steps.filter((s) => s.target !== null).length;
  if (kills(boosted) > kills(now)) return true;
  // A face-up monster of theirs no attacker beats now but one would with the boost.
  for (const a of attackers(e, p)) {
    const atk = e.atkOf(a);
    const plus = bonus(a);
    if (plus <= 0) continue;
    for (const t of e.monsters(opp)) if (t.faceUp && atk <= wall(e, t) && atk + plus > wall(e, t)) return true;
  }
  return false;
}

/** Would weakening `t` by `n` ATK/DEF let one of `p`'s attackers beat it? */
export function weakenHelps(e: Engine, p: Pid, n: number): boolean {
  for (const t of e.monsters(other(p))) {
    if (!t.faceUp) continue;
    const w = wall(e, t);
    if (attackers(e, p).some((a) => e.atkOf(a) <= w && e.atkOf(a) > w - n)) return true;
  }
  return false;
}

/** A cheap deterministic coin for the computer's "mistakes" (never touches the duel's own dice). */
export function coin(e: Engine, key: string, odds: number): boolean {
  let h = (e.state.seed ^ (e.state.turn * 2654435761)) >>> 0;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  return (h % 1000) / 1000 < odds;
}
