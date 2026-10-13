// Speed Duel Continuous Spells/Traps, batch A (run: npx tsx tests/cont-a.test.ts).
// Each card: it activates when its text allows, stays face-up, its ongoing effect works
// (repeatedly where the text says so), and the effect stops once the card leaves the field.
import { Engine } from '../src/eds/engine';
import type { Card, FieldCard, Pid, Pos, Step } from '../src/eds/types';
import { DB } from './speedkit';

let fails = 0;
let current = '';
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${current}: ${what}`);
  if (!ok) fails++;
};

// ---------- scripted answers ----------
type Ans = { k: 'respond'; label: string } | { k: 'pick'; label?: string; uid?: number; uids?: number[] } | { k: 'yes' } | { k: 'no' } | { k: 'cancel' };
const R = (label: string): Ans => ({ k: 'respond', label });
const P = (label: string): Ans => ({ k: 'pick', label });
const U = (...uids: number[]): Ans => (uids.length === 1 ? { k: 'pick', uid: uids[0] } : { k: 'pick', uids });
const Y: Ans = { k: 'yes' };
const N: Ans = { k: 'no' };
const C: Ans = { k: 'cancel' };

/** Labels of every response option offered to each player while settling. */
let offered: string[][] = [[], []];
/** Titles of every prompt shown while settling. */
let titles: string[] = [];

/**
 * Answers every prompt. For each prompt the first scripted answer of the matching kind is used
 * (a pick only when its card/label is among the options: the engine skips prompts with one forced choice);
 * otherwise defaults apply (pass responses, YES, the first options).
 */
function settle(e: Engine, answers: Ans[] = []) {
  const q = [...answers];
  offered = [[], []];
  titles = [];
  const take = (test: (a: Ans) => boolean) => {
    const i = q.findIndex(test);
    return i >= 0 ? q.splice(i, 1)[0] : undefined;
  };
  for (let guard = 0; e.state.prompt && guard < 300; guard++) {
    const pr = e.state.prompt;
    const p = pr.player;
    titles.push(pr.title);
    if (pr.kind === 'response') {
      offered[p].push(...pr.options.map((o) => o.label));
      const a = take((x) => x.k === 'respond' && pr.options.some((o) => o.label.includes(x.label)));
      if (a?.k === 'respond') e.apply({ type: 'CHOOSE', player: p, picks: [pr.options.findIndex((o) => o.label.includes(a.label))] });
      else e.apply({ type: 'PASS', player: p });
      continue;
    }
    if (pr.kind === 'yesno') {
      const a = take((x) => x.k === 'yes' || x.k === 'no');
      e.apply({ type: a?.k === 'no' ? 'NO' : 'YES', player: p });
      continue;
    }
    const idx = (a: Ans): number[] => {
      if (a.k === 'cancel') return [];
      if (a.k !== 'pick') return [];
      if (a.uids) {
        const r = a.uids.map((u) => pr.options.findIndex((o) => o.uid === u));
        return r.every((i) => i >= 0) ? r : [];
      }
      if (a.uid !== undefined) return [pr.options.findIndex((o) => o.uid === a.uid)].filter((i) => i >= 0);
      return [pr.options.findIndex((o) => o.label === a.label)].filter((i) => i >= 0);
    };
    const a = take((x) => (x.k === 'cancel' && pr.cancel) || idx(x).length > 0);
    if (a?.k === 'cancel') e.apply({ type: 'CANCEL', player: p });
    else if (a) e.apply({ type: 'CHOOSE', player: p, picks: idx(a) });
    else {
      const n = Math.max(pr.min, pr.max > 0 ? 1 : 0);
      e.apply({ type: 'CHOOSE', player: p, picks: Array.from({ length: Math.min(n, pr.options.length) }, (_, i) => i) });
    }
  }
  const left = q.filter((x) => x.k !== 'pick');
  if (left.length) check(false, `unused scripted answers ${JSON.stringify(left)} (prompts: ${titles.join(' | ')})`);
}

// ---------- setting up ----------
const FILLER = 'Headless Knight'; // Normal Fiend 1450/1700
function duel(): Engine {
  const e = new Engine(DB);
  const deck = Array.from({ length: 30 }, () => FILLER);
  e.apply({ type: 'START', first: 0, seed: 7, names: ['Me', 'Opp'], decks: [deck, deck], fusions: [[], []], mode: 'speed', skills: [null, null] });
  settle(e);
  e.state.firstTurn = false; // allow a Battle Phase on turn 1
  // empty hands so the tests control exactly what is there
  for (const p of [0, 1] as Pid[]) e.player(p).deck.push(...e.player(p).hand.splice(0));
  return e;
}
const newCard = (e: Engine, p: Pid, name: string): Card => ({ uid: e.state.uidCounter++, name, owner: p });
/** A card in the hand. */
function hand(e: Engine, p: Pid, name: string): Card {
  const c = newCard(e, p, name);
  e.player(p).hand.push(c);
  return c;
}
function grave(e: Engine, p: Pid, name: string): Card {
  const c = newCard(e, p, name);
  e.player(p).gy.push(c);
  return c;
}
function deckTop(e: Engine, p: Pid, name: string): Card {
  const c = newCard(e, p, name);
  e.player(p).deck.unshift(c);
  return c;
}
const fieldOf = (c: Card, pos: Pos, faceUp: boolean, turn: number): FieldCard => ({ ...c, pos, faceUp, placedTurn: turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 });
/** A monster already on the field (placed last turn). */
function mon(e: Engine, p: Pid, name: string, pos: Pos = 'atk', faceUp = true): FieldCard {
  const ps = e.player(p);
  const z = ps.mz.findIndex((x) => x === null);
  if (z < 0) throw new Error('no monster zone');
  const fc = fieldOf(newCard(e, p, name), pos, faceUp, e.state.turn - 1);
  ps.mz[z] = fc;
  return fc;
}
/** A Spell/Trap Set last turn. */
function setST(e: Engine, p: Pid, name: string): FieldCard {
  const ps = e.player(p);
  const z = ps.sz.findIndex((x) => x === null);
  if (z < 0) throw new Error('no S/T zone');
  const fc = fieldOf(newCard(e, p, name), 'atk', false, e.state.turn - 1);
  ps.sz[z] = fc;
  return fc;
}
const zone = (e: Engine, uid: number) => e.find(uid)?.loc.zone;
const fc = (e: Engine, uid: number) => e.fieldCard(uid);
const activeUp = (e: Engine, uid: number) => {
  const f = e.fieldCard(uid);
  return !!f && f.faceUp && !!f.active && zone(e, uid) === 'sz';
};
const run = (e: Engine, step: Step, answers: Ans[] = []) => {
  (e as unknown as { run(g: Step): void }).run(step);
  settle(e, answers);
};
/** Activates a card from the hand or a Set card (Main Phase). */
function activate(e: Engine, p: Pid, uid: number, answers: Ans[] = []) {
  e.apply({ type: 'ACTIVATE', player: p, uid });
  settle(e, answers);
}
/** Uses an ignition effect of a monster or face-up Spell/Trap. */
function ignite(e: Engine, p: Pid, uid: number, answers: Ans[] = []) {
  e.apply({ type: 'MONSTER_EFFECT', player: p, uid });
  settle(e, answers);
}
function summon(e: Engine, p: Pid, uid: number, answers: Ans[] = [], pos: Pos = 'atk') {
  e.apply({ type: 'SUMMON', player: p, uid, zone: e.player(p).mz.findIndex((z) => z === null), pos, faceUp: true });
  settle(e, answers);
}
function toBP(e: Engine, answers: Ans[] = []) {
  e.apply({ type: 'NEXT_PHASE', player: e.state.turnPlayer });
  settle(e, answers);
}
function attack(e: Engine, uid: number, target: number | null, answers: Ans[] = []) {
  e.apply({ type: 'ATTACK', player: e.state.turnPlayer, uid, target });
  settle(e, answers);
}
function endTurn(e: Engine, answers: Ans[] = []) {
  e.apply({ type: 'END_TURN', player: e.state.turnPlayer });
  settle(e, answers);
}
/** Destroys cards with a card effect controlled by `by`. */
const destroyBy = (e: Engine, by: Pid, uids: number[], answers: Ans[] = []) => run(e, e.as(by, e.destroy(uids)), answers);
/** Mystical Space Typhoon from `p`'s hand on `target` (Main Phase of p's turn). */
function mst(e: Engine, p: Pid, target: number, answers: Ans[] = []) {
  const c = hand(e, p, 'Mystical Space Typhoon');
  activate(e, p, c.uid, [U(target), ...answers]);
}
const lp = (e: Engine, p: Pid) => e.player(p).lp;

// =====================================================================
current = 'Abyss Prop - Wild Wagon';
{
  const e = duel();
  const w = hand(e, 0, current);
  const actor = mon(e, 0, 'Abyss Actor - Extras');
  activate(e, 0, w.uid);
  check(activeUp(e, w.uid), 'activates from the hand and stays face-up');
  check(e.canUseMonsterEffect(0, fc(e, w.uid)!), 'its targeting effect can be used');
  ignite(e, 0, w.uid, [U(actor.uid)]);
  e.actor = 1;
  check(e.untargetable(actor), 'the opponent cannot target the chosen Abyss Actor');
  e.actor = 0;
  check(!e.untargetable(actor), 'its controller can still target it');
  e.actor = null;
  check(!e.canUseMonsterEffect(0, fc(e, w.uid)!), 'targeting effect is once per turn');
  endTurn(e);
  e.actor = 1;
  check(e.untargetable(actor), 'protection lasts until the end of the opponent\'s turn');
  e.actor = null;
  const a1 = mon(e, 1, FILLER);
  const a2 = mon(e, 1, FILLER);
  toBP(e);
  attack(e, a1.uid, actor.uid);
  check(zone(e, actor.uid) === 'mz', 'the first battle destruction each turn is prevented');
  check(lp(e, 0) === 4000 - 1350, 'battle damage is still taken');
  attack(e, a2.uid, actor.uid);
  check(zone(e, actor.uid) === 'gy', 'the second battle destruction that turn happens');
  check(activeUp(e, w.uid), 'Wild Wagon is still face-up');
  endTurn(e);
  e.actor = 1;
  const again = mon(e, 0, 'Abyss Actor - Extras');
  check(!e.untargetable(again), 'an Abyss Actor that was not chosen can be targeted');
  e.actor = null;
}
{
  const e = duel();
  const w = hand(e, 0, current);
  const actor = mon(e, 0, 'Abyss Actor - Extras');
  activate(e, 0, w.uid);
  ignite(e, 0, w.uid, [U(actor.uid)]);
  mst(e, 0, w.uid);
  check(zone(e, w.uid) === 'gy', 'destroyed by Mystical Space Typhoon');
  e.actor = 1;
  check(e.untargetable(actor), 'the targeting protection stays even after Wild Wagon left the field');
  e.actor = null;
  endTurn(e);
  const a1 = mon(e, 1, FILLER);
  toBP(e);
  attack(e, a1.uid, actor.uid);
  check(zone(e, actor.uid) === 'gy', 'without Wild Wagon the Abyss Actor is destroyed by battle');
}

// =====================================================================
current = 'Amazoness Fighting Spirit';
{
  const e = duel();
  const s = hand(e, 0, current);
  const pal = mon(e, 0, 'Amazoness Paladin'); // 1700 + 100 (itself)
  const big = mon(e, 1, 'Flame Cerebrus'); // 2100
  activate(e, 0, s.uid);
  check(activeUp(e, s.uid), 'activates from the hand and stays face-up');
  check(e.atkOf(pal) === 1800, 'no ATK gain outside of battle');
  toBP(e);
  attack(e, pal.uid, big.uid);
  check(zone(e, big.uid) === 'gy' && zone(e, pal.uid) === 'mz', 'Amazoness gains 1000 ATK attacking a stronger monster (2800 > 2100)');
  check(lp(e, 1) === 4000 - 700, 'battle damage uses the boosted ATK');
  check(e.atkOf(pal) === 1800, 'the gain is gone after the battle');
  endTurn(e);
  endTurn(e);
  const weak = mon(e, 1, FILLER);
  toBP(e);
  attack(e, pal.uid, weak.uid);
  check(lp(e, 1) === 3300 - 350, 'no gain when attacking a weaker monster');
  endTurn(e);
  endTurn(e);
  const big2 = mon(e, 1, 'Flame Cerebrus');
  const big3 = mon(e, 1, 'Flame Cerebrus');
  const pal2 = mon(e, 0, 'Amazoness Paladin');
  toBP(e);
  attack(e, pal2.uid, big2.uid);
  check(zone(e, big2.uid) === 'gy', 'works again on a later turn (each time)');
  // Now the opponent's monster attacks: the Amazoness is not attacking, no gain.
  endTurn(e);
  toBP(e);
  attack(e, big3.uid, pal.uid);
  check(zone(e, pal.uid) === 'gy', 'no gain when the Amazoness is the one attacked');
}
{
  const e = duel();
  const s = hand(e, 0, current);
  const pal = mon(e, 0, 'Amazoness Paladin');
  const big = mon(e, 1, 'Flame Cerebrus');
  activate(e, 0, s.uid);
  mst(e, 0, s.uid);
  check(zone(e, s.uid) === 'gy', 'destroyed by Mystical Space Typhoon');
  toBP(e);
  attack(e, pal.uid, big.uid);
  check(zone(e, pal.uid) === 'gy' && zone(e, big.uid) === 'mz', 'without it the Amazoness loses the battle');
}

// =====================================================================
current = "Archfiend's Oath";
{
  const e = duel();
  const o = hand(e, 0, current);
  activate(e, 0, o.uid);
  check(activeUp(e, o.uid), 'activates from the hand and stays face-up');
  const top = deckTop(e, 0, 'Flame Cerebrus');
  const handBefore = e.player(0).hand.length;
  ignite(e, 0, o.uid, [P('Flame Cerebrus')]);
  check(lp(e, 0) === 3500, 'pays 500 LP');
  check(zone(e, top.uid) === 'hand' && e.player(0).hand.length === handBefore + 1, 'the declared card on top is added to the hand');
  check(!e.canUseMonsterEffect(0, fc(e, o.uid)!), 'once per turn');
  check(activeUp(e, o.uid), 'still face-up after using it');
  endTurn(e);
  endTurn(e);
  const top2 = deckTop(e, 0, 'Flame Cerebrus');
  ignite(e, 0, o.uid, [P(FILLER)]);
  check(lp(e, 0) === 3000, 'pays 500 LP again next turn');
  check(zone(e, top2.uid) === 'gy', 'a wrong declaration sends the excavated card to the GY');
  endTurn(e);
  endTurn(e);
  mst(e, 0, o.uid);
  check(zone(e, o.uid) === 'gy', 'destroyed by Mystical Space Typhoon (no effect left to use)');
}

// =====================================================================
current = 'Backup Squad';
{
  const e = duel();
  e.player(0).lp = 8000;
  const b = hand(e, 0, current);
  activate(e, 0, b.uid);
  check(activeUp(e, b.uid), 'activates from the hand and stays face-up');
  endTurn(e);
  const big = mon(e, 1, 'Flame Cerebrus');
  toBP(e);
  let h0 = e.player(0).hand.length;
  attack(e, big.uid, null, [R('Backup Squad')]);
  check(lp(e, 0) === 5900, 'took 2100 battle damage from the opponent\'s attack');
  check(e.player(0).hand.length === h0 + 2, 'draws 1 card per 1000 damage from an attack (2)');
  endTurn(e);
  endTurn(e);
  // Opponent's card effect: Tremendous Fire (1000).
  h0 = e.player(0).hand.length;
  const tf = hand(e, 1, 'Tremendous Fire');
  activate(e, 1, tf.uid, [R('Backup Squad')]);
  check(e.player(0).hand.length === h0 + 1, 'draws 1 for 1000 damage from the opponent\'s card effect (each time)');
  h0 = e.player(0).hand.length;
  const ook = hand(e, 1, 'Ookazi');
  activate(e, 1, ook.uid);
  check(!offered[0].some((l) => l.includes('Backup Squad')) && e.player(0).hand.length === h0, 'less than 1000 damage: no draw');
  endTurn(e);
  // My own monster attacks into a stronger one: my own attack, no draw.
  const mine = mon(e, 0, FILLER);
  toBP(e);
  attack(e, mine.uid, big.uid);
  check(lp(e, 0) === 5900 - 1000 - 800 - 650 && !offered[0].some((l) => l.includes('Backup Squad')), 'damage from my own attack does not trigger it');
  endTurn(e);
  mst(e, 1, b.uid);
  check(zone(e, b.uid) === 'gy', 'destroyed by the opponent\'s Mystical Space Typhoon');
  const tf2 = hand(e, 1, 'Tremendous Fire');
  h0 = e.player(0).hand.length;
  activate(e, 1, tf2.uid);
  check(!offered[0].some((l) => l.includes('Backup Squad')) && e.player(0).hand.length === h0, 'no draw once it left the field');
}

// =====================================================================
current = 'Aegis of Gaia';
{
  const e = duel();
  const a = setST(e, 0, current);
  endTurn(e);
  const m = hand(e, 1, FILLER);
  summon(e, 1, m.uid, [R('Aegis of Gaia')]);
  check(lp(e, 0) === 7000, 'activated on the opponent\'s turn: gain 3000 LP');
  check(activeUp(e, a.uid), 'stays face-up');
  endTurn(e);
  endTurn(e);
  check(lp(e, 0) === 7000 && activeUp(e, a.uid), 'no further LP change while it stays');
  mst(e, 1, a.uid);
  check(zone(e, a.uid) === 'gy' && lp(e, 0) === 4000, 'removed from the field: take 3000 damage');
}
{
  const e = duel();
  const a = setST(e, 0, current);
  mst(e, 0, a.uid);
  check(lp(e, 0) === 4000, 'destroyed while Set: no damage');
}

// =====================================================================
current = 'Amazoness Onslaught';
{
  const e = duel();
  const o = setST(e, 0, current);
  activate(e, 0, o.uid);
  check(activeUp(e, o.uid), 'activates and stays face-up');
  const pal = mon(e, 0, 'Amazoness Paladin');
  const inHand = hand(e, 0, 'Amazoness Fighter');
  const foe = mon(e, 1, FILLER);
  const foe2 = mon(e, 1, FILLER);
  toBP(e);
  attack(e, pal.uid, foe.uid, [R('Amazoness Onslaught'), U(inHand.uid), Y]);
  const ss = fc(e, inHand.uid);
  check(!!ss && zone(e, inHand.uid) === 'mz', 'during the Battle Phase: Special Summons an Amazoness from the hand');
  check(!!ss && e.atkOf(ss) === 1500 + 500, 'it gains 500 ATK');
  check(zone(e, foe.uid) === 'removed', 'after damage calculation the opponent\'s monster that battled an Amazoness is banished');
  check(activeUp(e, o.uid), 'still face-up');
  attack(e, ss!.uid, foe2.uid, [N]);
  check(!offered[0].some((l) => l.includes('Amazoness Onslaught')), 'Special Summon effect is once per turn');
  check(zone(e, foe2.uid) === 'gy', 'banishing is optional ("you can")');
  endTurn(e);
  check(e.atkOf(fc(e, inHand.uid)!) === 1500, 'the 500 ATK lasts only until the end of the turn');
  // Opponent attacks my Amazoness: still "battled", can banish.
  const att = mon(e, 1, 'Flame Cerebrus');
  toBP(e);
  attack(e, att.uid, pal.uid, [Y]);
  check(zone(e, att.uid) === 'removed', 'also banishes a monster that attacked an Amazoness');
  // MST from the opponent: revive an Amazoness from the GY.
  e.state.phase = 'M1';
  mst(e, 1, o.uid, [Y, U(pal.uid)]);
  check(zone(e, o.uid) === 'gy', 'destroyed by Mystical Space Typhoon');
  check(zone(e, pal.uid) === 'mz', 'when destroyed: Special Summons an Amazoness from the GY');
  endTurn(e);
  const foe3 = mon(e, 1, FILLER);
  toBP(e);
  attack(e, pal.uid, foe3.uid);
  check(zone(e, foe3.uid) === 'gy', 'no banishing once it left the field');
}

// =====================================================================
current = 'Amazoness Willpower';
{
  const e = duel();
  const w = setST(e, 0, current);
  const dead = grave(e, 0, 'Amazoness Paladin');
  activate(e, 0, w.uid, [U(dead.uid)]);
  const m = fc(e, dead.uid);
  check(!!m && m.pos === 'atk' && m.faceUp, 'Special Summons the Amazoness from the GY in Attack Position');
  check(fc(e, w.uid)?.faceUp === true && zone(e, w.uid) === 'sz', 'stays face-up');
  endTurn(e);
  endTurn(e);
  check(!e.canChangePosition(0, fc(e, dead.uid)!), 'it cannot change its battle position');
  mst(e, 0, w.uid);
  check(zone(e, w.uid) === 'gy' && zone(e, dead.uid) === 'gy', 'when Willpower leaves the field the monster is destroyed');
}
{
  const e = duel();
  const w = setST(e, 0, current);
  const dead = grave(e, 0, 'Amazoness Paladin');
  activate(e, 0, w.uid, [U(dead.uid)]);
  endTurn(e);
  const big = mon(e, 1, 'Flame Cerebrus');
  toBP(e);
  attack(e, big.uid, dead.uid);
  check(zone(e, dead.uid) === 'gy' && zone(e, w.uid) === 'gy', 'when the monster is destroyed, Willpower is destroyed');
}

// =====================================================================
current = 'Battleguard Rage';
{
  const e = duel();
  const r = setST(e, 0, current);
  const q = mon(e, 0, "Queen's Knight"); // Warrior 1500
  activate(e, 0, r.uid, [U(q.uid)]);
  check(fc(e, r.uid)?.faceUp === true && zone(e, r.uid) === 'sz', 'activates targeting a Warrior and stays face-up');
  check(e.atkOf(q) === 2500, 'the Warrior gains 1000 ATK');
  const foe = mon(e, 1, FILLER);
  toBP(e);
  attack(e, q.uid, foe.uid);
  check(zone(e, foe.uid) === 'hand' && e.find(foe.uid)?.loc.player === 1, 'a monster it destroys by battle (attacking) returns to the hand');
  endTurn(e);
  const foe2 = mon(e, 1, FILLER);
  toBP(e);
  attack(e, foe2.uid, q.uid);
  check(zone(e, foe2.uid) === 'hand', 'a monster destroyed by battle with it (attacked) returns to the hand too');
  e.state.phase = 'M1';
  mst(e, 1, r.uid);
  check(zone(e, r.uid) === 'gy' && e.atkOf(q) === 1500, 'once it leaves the field the ATK gain is gone');
}
{
  const e = duel();
  const r = setST(e, 0, current);
  const q = mon(e, 0, "Queen's Knight");
  activate(e, 0, r.uid, [U(q.uid)]);
  endTurn(e);
  const big = mon(e, 1, 'Blue-Eyes White Dragon');
  toBP(e);
  attack(e, big.uid, q.uid);
  check(zone(e, q.uid) === 'gy' && zone(e, r.uid) === 'gy', 'when the Warrior leaves the field Battleguard Rage is destroyed');
  check(zone(e, big.uid) === 'mz', 'the winner of that battle stays on the field');
}

// =====================================================================
current = 'Blaze Accelerator';
{
  const e = duel();
  const b = hand(e, 0, current);
  activate(e, 0, b.uid);
  check(activeUp(e, b.uid), 'activates from the hand and stays face-up');
  const mine = mon(e, 0, FILLER);
  const t1 = mon(e, 1, 'Flame Cerebrus');
  const t2 = mon(e, 1, FILLER);
  const p1 = hand(e, 0, 'Charcoal Inpachi');
  const p2 = hand(e, 0, 'Charcoal Inpachi');
  const big = hand(e, 0, 'Flame Cerebrus'); // Pyro with 2100 ATK: not usable
  ignite(e, 0, b.uid, [U(t1.uid), U(p1.uid)]);
  check(zone(e, t1.uid) === 'gy' && zone(e, p1.uid) === 'gy', 'sends a low-ATK Pyro from the hand to destroy the target');
  check(zone(e, big.uid) === 'hand', 'a Pyro with more than 500 ATK is not a legal cost');
  check(e.canUseMonsterEffect(0, fc(e, b.uid)!), 'no once-per-turn limit');
  ignite(e, 0, b.uid, [U(t2.uid), U(p2.uid)]);
  check(zone(e, t2.uid) === 'gy', 'used a second time the same turn');
  check(!e.canUseMonsterEffect(0, fc(e, b.uid)!), 'needs a Pyro in hand and a target');
  const late = hand(e, 0, FILLER);
  summon(e, 0, late.uid);
  toBP(e);
  check(!e.canAttackWith(0, mine) && !e.canAttackWith(0, fc(e, late.uid)!), 'no attacks the turn the effect was used (even for a monster Summoned later)');
  endTurn(e);
  endTurn(e);
  toBP(e);
  check(e.canAttackWith(0, mine), 'attacks are allowed again next turn');
  e.state.phase = 'M1';
  mst(e, 0, b.uid);
  check(zone(e, b.uid) === 'gy', 'destroyed by Mystical Space Typhoon');
}

// =====================================================================
current = 'Call of the Mummy';
{
  const e = duel();
  const c = hand(e, 0, current);
  activate(e, 0, c.uid);
  check(activeUp(e, c.uid), 'activates from the hand and stays face-up');
  const z = hand(e, 0, 'Regenerating Mummy');
  const z2 = hand(e, 0, 'Heavy Knight of the Flame');
  const nz = hand(e, 0, FILLER);
  check(e.canUseMonsterEffect(0, fc(e, c.uid)!), 'usable with no monsters and a Zombie in hand');
  ignite(e, 0, c.uid, [U(z.uid), P('Attack Position')]);
  check(zone(e, z.uid) === 'mz', 'Special Summons a Zombie from the hand');
  check(zone(e, nz.uid) === 'hand', 'only Zombies');
  check(!e.canUseMonsterEffect(0, fc(e, c.uid)!), 'not while you control a monster / once per turn');
  endTurn(e);
  const big = mon(e, 1, 'Blue-Eyes White Dragon');
  toBP(e);
  attack(e, big.uid, z.uid);
  endTurn(e);
  check(e.monsters(0).length === 0 && e.canUseMonsterEffect(0, fc(e, c.uid)!), 'usable again next turn with no monsters');
  ignite(e, 0, c.uid, [U(z2.uid), P('Defense Position')]);
  check(fc(e, z2.uid)?.pos === 'def', 'Special Summons again (each turn)');
  endTurn(e);
  endTurn(e);
  mst(e, 0, c.uid);
  check(zone(e, c.uid) === 'gy', 'destroyed by Mystical Space Typhoon');
}

// =====================================================================
current = 'Cloudian Squall';
{
  const e = duel();
  const s = hand(e, 0, current);
  activate(e, 0, s.uid);
  check(activeUp(e, s.uid), 'activates from the hand and stays face-up');
  const mine = mon(e, 0, FILLER);
  const down = mon(e, 0, FILLER, 'def', false);
  const theirs = mon(e, 1, FILLER);
  const fog = (m: FieldCard) => m.tags?.fog ?? 0;
  endTurn(e);
  check(fog(mine) === 0 && fog(theirs) === 0, 'nothing during the opponent\'s Standby Phase');
  endTurn(e);
  check(fog(mine) === 1 && fog(theirs) === 1, 'my Standby Phase: 1 Fog Counter on every face-up monster (both sides)');
  check(fog(down) === 0, 'face-down monsters get none');
  endTurn(e);
  endTurn(e);
  check(fog(mine) === 2 && fog(theirs) === 2, 'again on my next Standby Phase');
  mst(e, 0, s.uid);
  endTurn(e);
  endTurn(e);
  check(zone(e, s.uid) === 'gy' && fog(mine) === 2, 'no more counters once it left the field');
}

// =====================================================================
current = 'Birthright';
{
  const e = duel();
  const b = setST(e, 0, current);
  const n = grave(e, 0, 'Flame Cerebrus');
  endTurn(e);
  const x = hand(e, 1, FILLER);
  summon(e, 1, x.uid, [R('Birthright'), U(n.uid)]);
  const m = fc(e, n.uid);
  check(!!m && m.faceUp && m.pos === 'atk', 'activated on the opponent\'s turn: Special Summons the Normal Monster in Attack Position');
  check(fc(e, b.uid)?.faceUp === true && zone(e, b.uid) === 'sz', 'stays face-up');
  mst(e, 1, b.uid);
  check(zone(e, b.uid) === 'gy' && zone(e, n.uid) === 'gy', 'when Birthright leaves the field the monster is destroyed');
}
{
  const e = duel();
  const b = setST(e, 0, current);
  const eff = grave(e, 0, 'Amazoness Paladin');
  check(!e.canActivateMain(0, b.uid), 'cannot be activated without a Normal Monster in the GY');
  const n = grave(e, 0, FILLER);
  activate(e, 0, b.uid, [U(n.uid)]);
  check(zone(e, n.uid) === 'mz' && zone(e, eff.uid) === 'gy', 'only Normal Monsters');
  endTurn(e);
  const big = mon(e, 1, 'Flame Cerebrus');
  toBP(e);
  attack(e, big.uid, n.uid);
  check(zone(e, n.uid) === 'gy' && zone(e, b.uid) === 'gy', 'when the monster leaves the field Birthright is destroyed');
}

// =====================================================================
current = 'Conquistador of the Golden Land';
{
  const e = duel();
  const c = setST(e, 0, current);
  const c2 = setST(e, 0, current);
  activate(e, 0, c.uid, [P('Defense Position')]);
  const m = fc(e, c.uid);
  check(!!m && zone(e, c.uid) === 'mz' && m.faceUp && m.pos === 'def', 'Special Summons itself as a monster and stays on the field');
  check(!!m && e.atkOf(m) === 500 && e.defOf(m) === 1800, 'it is 500 ATK / 1800 DEF');
  check(!e.canActivateMain(0, c2.uid), 'only 1 Conquistador effect per turn');
  endTurn(e);
  const foe = mon(e, 1, FILLER);
  toBP(e);
  attack(e, foe.uid, c.uid);
  check(zone(e, c.uid) === 'mz' && lp(e, 1) === 4000 - 350, 'it battles as a 1800 DEF monster');
  endTurn(e);
  // With "Eldlich the Golden Lord": destroy 1 face-up card.
  mon(e, 0, 'Eldlich the Golden Lord');
  const spell = hand(e, 1, 'Cloudian Squall');
  e.player(1).sz[2] = { ...fieldOf(spell, 'atk', true, e.state.turn - 1), active: true };
  e.player(1).hand = e.player(1).hand.filter((x) => x.uid !== spell.uid);
  activate(e, 0, c2.uid, [P('Attack Position'), U(spell.uid)]);
  check(zone(e, c2.uid) === 'mz' && zone(e, spell.uid) === 'gy', 'with Eldlich the Golden Lord it destroys a face-up card');
  destroyBy(e, 1, [c.uid]);
  check(zone(e, c.uid) === 'gy', 'destroyed as a monster it goes to the GY');
}

// =====================================================================
current = 'Cosmos Channelling';
{
  const e = duel();
  const c = hand(e, 0, current);
  activate(e, 0, c.uid);
  check(activeUp(e, c.uid), 'activates from the hand and stays face-up');
  const mine = mon(e, 0, FILLER);
  const borrowed = mon(e, 1, 'Flame Cerebrus');
  const mach = hand(e, 0, 'Cyber Dragon');
  const machGy = grave(e, 0, 'Jinzo');
  check(!e.canUseMonsterEffect(0, fc(e, c.uid)!), 'needs a monster you control that the opponent owns');
  e.takeControl(borrowed.uid, 0);
  ignite(e, 0, c.uid, [U(borrowed.uid), U(mach.uid)]);
  check(zone(e, borrowed.uid) === 'gy' && e.find(borrowed.uid)?.loc.player === 1, 'sends the opponent-owned monster to the GY (its owner\'s)');
  check(zone(e, mach.uid) === 'mz', 'Special Summons a Machine from the hand');
  check(zone(e, mine.uid) === 'mz', 'my own monster is not a legal cost');
  const b2 = mon(e, 1, FILLER);
  e.takeControl(b2.uid, 0);
  check(!e.canUseMonsterEffect(0, fc(e, c.uid)!), 'once per turn');
  endTurn(e);
  endTurn(e);
  ignite(e, 0, c.uid, [U(b2.uid), U(machGy.uid)]);
  check(zone(e, machGy.uid) === 'mz', 'next turn: Special Summons a Machine from the GY');
  mst(e, 0, c.uid);
  const b3 = mon(e, 1, FILLER);
  e.takeControl(b3.uid, 0);
  check(zone(e, c.uid) === 'gy' && zone(e, b3.uid) === 'mz', 'destroyed by Mystical Space Typhoon: effect gone');
}

// =====================================================================
current = 'Crystal Tree';
{
  const e = duel();
  const t = hand(e, 0, current);
  activate(e, 0, t.uid);
  check(activeUp(e, t.uid), 'activates from the hand and stays face-up');
  const cb = mon(e, 0, 'Crystal Beast Topaz Tiger');
  destroyBy(e, 1, [cb.uid], [Y]);
  check(zone(e, cb.uid) === 'sz', 'a destroyed Crystal Beast is placed in the Spell & Trap Zone');
  check(fc(e, t.uid)!.counters === 1, '1 Crystal Counter when a Crystal Beast is placed in my zone');
  const ocb = mon(e, 1, 'Crystal Beast Amber Mammoth');
  destroyBy(e, 0, [ocb.uid], [Y]);
  check(zone(e, ocb.uid) === 'sz' && fc(e, t.uid)!.counters === 2, 'and when one is placed in the opponent\'s zone');
  const d1 = deckTop(e, 0, 'Crystal Beast Emerald Tortoise');
  const d2 = deckTop(e, 0, 'Crystal Beast Amethyst Cat');
  deckTop(e, 0, 'Crystal Beast Sapphire Pegasus');
  ignite(e, 0, t.uid, [U(d1.uid, d2.uid)]);
  check(zone(e, t.uid) === 'gy', 'sent to the GY');
  check(zone(e, d1.uid) === 'sz' && zone(e, d2.uid) === 'sz' && fc(e, d1.uid)!.faceUp, 'places exactly 2 Crystal Beasts (its counters) from the Deck');
}
{
  const e = duel();
  const t = hand(e, 0, current);
  activate(e, 0, t.uid);
  check(!e.canUseMonsterEffect(0, fc(e, t.uid)!), 'cannot be sent with no counters');
  mst(e, 0, t.uid);
  const cb = mon(e, 0, 'Crystal Beast Topaz Tiger');
  destroyBy(e, 1, [cb.uid], [Y]);
  check(zone(e, t.uid) === 'gy' && zone(e, cb.uid) === 'sz', 'destroyed: no more counters to place');
}

// =====================================================================
current = 'Cursed Eldland';
{
  const e = duel();
  const c = hand(e, 0, current);
  activate(e, 0, c.uid);
  check(activeUp(e, c.uid), 'activates from the hand and stays face-up');
  const nz = mon(e, 0, FILLER);
  const z = mon(e, 0, 'Regenerating Mummy');
  const eld = deckTop(e, 0, 'Eldlich the Golden Lord');
  ignite(e, 0, c.uid, [U(eld.uid)]);
  check(lp(e, 0) === 3200 && zone(e, eld.uid) === 'hand', 'pays 800 LP to add an "Eldlich" monster from the Deck');
  check(!e.canUseMonsterEffect(0, fc(e, c.uid)!), 'search is once per turn');
  toBP(e);
  check(!e.canAttackWith(0, nz), 'non-Zombie monsters cannot attack');
  check(e.canAttackWith(0, z), 'Zombie monsters can attack');
  endTurn(e);
  const foe = mon(e, 1, FILLER);
  toBP(e);
  check(e.canAttackWith(1, foe), 'the opponent is not restricted');
  endTurn(e);
  toBP(e);
  check(!e.canAttackWith(0, nz), 'still restricted on later turns');
  e.state.phase = 'M1';
  const eld2 = deckTop(e, 0, 'Eldlich the Golden Lord');
  mst(e, 0, c.uid, [Y, U(eld2.uid)]);
  check(zone(e, c.uid) === 'gy' && zone(e, eld2.uid) === 'gy', 'sent from the S/T Zone to the GY: sends an "Eldlich" from the Deck to the GY');
  toBP(e);
  check(e.canAttackWith(0, nz), 'non-Zombies can attack once it left the field');
}

// =====================================================================
current = 'Court of Cards';
{
  const e = duel();
  const c = setST(e, 0, current);
  activate(e, 0, c.uid);
  check(activeUp(e, c.uid), 'activates and stays face-up');
  const q = hand(e, 0, "Queen's Knight");
  ignite(e, 0, c.uid, [P('Special Summon a Knight from your hand or GY'), U(q.uid)]);
  check(zone(e, q.uid) === 'mz', 'with no monsters: Special Summons a Knight from the hand');
  check(!e.canUseMonsterEffect(0, fc(e, c.uid)!), 'only 1 Court of Cards effect per turn');
  endTurn(e);
  endTurn(e);
  const k = grave(e, 0, "King's Knight");
  ignite(e, 0, c.uid, [P('Special Summon a Knight from your hand or GY'), U(k.uid)]);
  check(zone(e, k.uid) === 'mz', 'while I control only Knights: Special Summons one from the GY');
  endTurn(e);
  endTurn(e);
  const j = grave(e, 0, "Jack's Knight");
  const q2 = hand(e, 0, "Queen's Knight");
  mon(e, 0, FILLER);
  const h0 = e.player(0).hand.length;
  ignite(e, 0, c.uid, [P('Banish Knights to draw'), U(j.uid, q2.uid)]);
  check(zone(e, j.uid) === 'removed' && zone(e, q2.uid) === 'removed', 'banishes Knights from the hand/GY');
  check(e.player(0).hand.length === h0 - 1 + 2, 'draws 1 card per banished Knight');
  endTurn(e);
  endTurn(e);
  const q3 = hand(e, 0, "Queen's Knight");
  ignite(e, 0, c.uid, [P('Banish Knights to draw'), U(q3.uid)]);
  check(zone(e, q3.uid) === 'removed', 'with a non-Knight on the field only the banish effect is available');
  endTurn(e);
  mst(e, 1, c.uid);
  check(zone(e, c.uid) === 'gy', 'destroyed by Mystical Space Typhoon');
}

// =====================================================================
current = 'Crystal Brilliance';
{
  const e = duel();
  const b = setST(e, 0, current);
  const b2 = setST(e, 0, current);
  const tiger = mon(e, 0, 'Crystal Beast Topaz Tiger'); // 1600 / 1000
  const other = mon(e, 0, FILLER);
  const foe = mon(e, 1, 'Crystal Beast Amber Mammoth');
  activate(e, 0, b.uid);
  check(activeUp(e, b.uid), 'activates and stays face-up');
  check(e.atkOf(tiger) === 2600, 'my Crystal Beast gains ATK equal to its original DEF');
  check(e.atkOf(other) === 1450 && e.atkOf(foe) === 1700, 'other monsters and the opponent\'s Crystal Beasts are unaffected');
  check(!e.canActivateMain(0, b2.uid), 'you can only control 1 Crystal Brilliance');
  const amb = hand(e, 0, 'Crystal Beast Amber Mammoth');
  destroyBy(e, 1, [tiger.uid], [Y, Y, U(amb.uid)]);
  check(zone(e, tiger.uid) === 'sz', 'a Crystal Beast is placed in my Spell & Trap Zone');
  check(zone(e, b.uid) === 'gy' && zone(e, amb.uid) === 'mz', 'then it is sent to the GY to Special Summon a Crystal Beast from the hand');
  check(e.atkOf(fc(e, amb.uid)!) === 1700, 'the bonus is gone once it left the field');
  e.damage(0, 1000);
  check(lp(e, 0) === 3500, 'damage I take this turn is halved');
  endTurn(e);
  e.damage(0, 1000);
  check(lp(e, 0) === 2500, 'only this turn');
  activate(e, 1, hand(e, 1, 'Mystical Space Typhoon').uid, [U(b2.uid)]);
}

// =====================================================================
current = 'Crystal Conclave';
{
  const e = duel();
  const c = setST(e, 0, current);
  activate(e, 0, c.uid);
  check(activeUp(e, c.uid), 'activates and stays face-up');
  const cb = mon(e, 0, 'Crystal Beast Topaz Tiger');
  const cb2 = mon(e, 0, 'Crystal Beast Emerald Tortoise');
  const d = deckTop(e, 0, 'Crystal Beast Amber Mammoth');
  deckTop(e, 0, 'Crystal Beast Amethyst Cat');
  destroyBy(e, 1, [cb.uid], [N, Y, U(d.uid)]);
  check(zone(e, cb.uid) === 'gy' && zone(e, d.uid) === 'mz', 'a Crystal Beast of mine destroyed: Special Summons one from the Deck');
  destroyBy(e, 1, [cb2.uid], [N]);
  check(!titles.some((t) => t.startsWith('Crystal Conclave')), 'only once per turn');
  endTurn(e);
  const big = mon(e, 1, 'Blue-Eyes White Dragon');
  toBP(e);
  attack(e, big.uid, d.uid, [N, Y, P('Crystal Beast Amethyst Cat')]);
  check(zone(e, d.uid) === 'gy' && e.monsters(0).some((m) => m.name === 'Crystal Beast Amethyst Cat'), 'next turn: destroyed by battle also triggers it');
  endTurn(e);
  const cat = e.monsters(0).find((m) => m.name === 'Crystal Beast Amethyst Cat')!;
  ignite(e, 0, c.uid, [U(cat.uid), U(big.uid)]);
  check(zone(e, c.uid) === 'gy', 'sent to the GY for its second effect');
  check(zone(e, cat.uid) === 'hand' && zone(e, big.uid) === 'hand' && e.find(big.uid)?.loc.player === 1, 'returns my Crystal Beast and another card to the hand');
  const cb3 = mon(e, 0, 'Crystal Beast Topaz Tiger');
  deckTop(e, 0, 'Crystal Beast Amber Mammoth');
  endTurn(e);
  destroyBy(e, 1, [cb3.uid], [N]);
  check(!titles.some((t) => t.startsWith('Crystal Conclave')), 'no trigger once it left the field');
}

// =====================================================================
current = 'Cyber Network';
{
  const e = duel();
  const n = setST(e, 0, current);
  activate(e, 0, n.uid);
  check(activeUp(e, n.uid), 'activates and stays face-up');
  check(!e.canUseMonsterEffect(0, fc(e, n.uid)!), 'needs "Cyber Dragon" on the field');
  mon(e, 0, 'Cyber Dragon');
  const lm = deckTop(e, 0, 'Proto-Cyber Dragon');
  const lm2 = deckTop(e, 0, 'Cyber Dragon Core');
  ignite(e, 0, n.uid, [U(lm.uid)]);
  check(zone(e, lm.uid) === 'removed', 'banishes a LIGHT Machine from the Deck');
  check(!e.canUseMonsterEffect(0, fc(e, n.uid)!), 'once per turn');
  endTurn(e);
  endTurn(e); // my 1st Standby Phase after activation (turn 3)
  ignite(e, 0, n.uid, [U(lm2.uid)]);
  check(zone(e, lm2.uid) === 'removed', 'banishes again next turn');
  const other = hand(e, 0, 'Cloudian Squall');
  activate(e, 0, other.uid);
  endTurn(e);
  endTurn(e); // 2nd (turn 5)
  check(activeUp(e, n.uid), 'still on the field after my 2nd Standby Phase');
  endTurn(e);
  endTurn(e, [U(lm.uid, lm2.uid)]); // 3rd (turn 7)
  check(zone(e, n.uid) === 'gy', 'destroyed during my 3rd Standby Phase after activation');
  check(zone(e, lm.uid) === 'mz' && zone(e, lm2.uid) === 'mz', 'sent to the GY: Special Summons the banished LIGHT Machines');
  check(zone(e, other.uid) === 'gy', 'then destroys all my Spells and Traps');
  check(e.isNegated(fc(e, lm.uid)!), 'the summoned monsters cannot activate their effects');
  toBP(e);
  check(!e.canAttackWith(0, fc(e, lm.uid)!), 'no Battle Phase that turn');
}

// =====================================================================
current = 'Cyber Shadow Gardna';
{
  const e = duel();
  const g = setST(e, 0, current);
  check(!e.canActivateMain(0, g.uid), 'cannot be activated during my own turn');
  endTurn(e);
  const x = hand(e, 1, FILLER);
  summon(e, 1, x.uid, [R('Cyber Shadow Gardna')]);
  const m = fc(e, g.uid);
  check(!!m && zone(e, g.uid) === 'mz' && m.pos === 'def', 'during the opponent\'s Main Phase: Special Summons itself as a monster');
  check(!!m && e.atkOf(m) === 0 && e.defOf(m) === 0, 'its ATK/DEF start at 0 (?)');
  toBP(e);
  attack(e, x.uid, g.uid);
  check(zone(e, g.uid) === 'mz' && e.atkOf(fc(e, g.uid)!) === 1450 && e.defOf(fc(e, g.uid)!) === 1700, 'attacked: its ATK/DEF become the attacker\'s');
  check(lp(e, 1) === 4000 - 250, 'it battles with the copied DEF');
  endTurn(e);
  check(zone(e, g.uid) === 'sz' && fc(e, g.uid)!.faceUp === false, 'Set again in the S/T Zone during the opponent\'s End Phase');
  endTurn(e);
  const y = hand(e, 1, FILLER);
  summon(e, 1, y.uid, [R('Cyber Shadow Gardna')]);
  check(zone(e, g.uid) === 'mz' && e.atkOf(fc(e, g.uid)!) === 0, 'can be used again (fresh ATK/DEF)');
  destroyBy(e, 1, [g.uid]);
  check(zone(e, g.uid) === 'gy', 'destroyed as a monster it goes to the GY');
}

// =====================================================================
// The Continuous Traps without a specific trigger can also be activated on the opponent's turn.
for (const [name, prep] of [
  ['Amazoness Onslaught', () => {}],
  ['Amazoness Willpower', (e: Engine) => grave(e, 0, 'Amazoness Paladin')],
  ['Battleguard Rage', (e: Engine) => mon(e, 0, "Queen's Knight")],
  ['Conquistador of the Golden Land', () => {}],
  ['Court of Cards', () => {}],
  ['Crystal Brilliance', () => {}],
  ['Crystal Conclave', () => {}],
  ['Cyber Network', () => {}],
] as [string, (e: Engine) => unknown][]) {
  current = name;
  const e = duel();
  const t = setST(e, 0, name);
  prep(e);
  endTurn(e);
  const x = hand(e, 1, FILLER);
  summon(e, 1, x.uid, [R(name)]);
  check(offered[0].includes(name) && !!e.find(t.uid) && (zone(e, t.uid) === 'mz' || activeUp(e, t.uid)), 'can be activated on the opponent\'s turn and stays on the field');
}

console.log(fails ? `${fails} FAILURES` : 'ALL OK');
process.exit(fails ? 1 : 0);
