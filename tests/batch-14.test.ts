// Speed Duel card scripts of batch 14 (run: npx tsx tests/batch-14.test.ts)
// One or more targeted checks per card: its main effect really happens in a duel.
import { Engine } from '../src/eds/engine';
import { getEffect } from '../src/eds/effects';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};
const FILL = 'Celtic Guardian';

// ---------- duel kit (as in cont-d.test.ts) ----------
type Ans = 'yes' | 'no' | 'pass' | { pick: string[] } | { respond: string };
/** Answers every pending prompt: planned answers first (in order), then pass / no / the first options. Returns how many planned answers were not used. */
function settle(e: Engine, ...ans: Ans[]): number {
  const q = [...ans];
  for (let i = 0; i < 400 && e.state.prompt && e.state.winner === null; i++) {
    const pr = e.state.prompt;
    const h = q[0];
    if (pr.kind === 'yesno') {
      if (h === 'yes' || h === 'no') {
        q.shift();
        e.apply({ type: h === 'yes' ? 'YES' : 'NO', player: pr.player });
      } else e.apply({ type: 'NO', player: pr.player });
    } else if (pr.kind === 'response') {
      if (h && typeof h === 'object' && 'respond' in h) {
        const k = pr.options.findIndex((o) => o.label.startsWith(h.respond));
        if (k >= 0) {
          q.shift();
          e.apply({ type: 'CHOOSE', player: pr.player, picks: [k] });
          continue;
        }
      }
      if (h === 'pass') q.shift();
      e.apply({ type: 'PASS', player: pr.player });
    } else if (h && typeof h === 'object' && 'pick' in h) {
      q.shift();
      const picks: number[] = [];
      for (const l of h.pick) {
        const k = pr.options.findIndex((o, j) => o.label === l && !picks.includes(j));
        if (k >= 0) picks.push(k);
      }
      e.apply({ type: 'CHOOSE', player: pr.player, picks });
    } else e.apply({ type: 'CHOOSE', player: pr.player, picks: pr.options.map((_, j) => j).slice(0, Math.max(1, pr.min)) });
  }
  return q.length;
}
function duel(d0: string[], d1: string[] = [], x0: string[] = [], x1: string[] = [], first: Pid = 0): Engine {
  const e = new Engine(DB);
  e.shuffle = <T,>(a: T[]) => a.slice();
  const pad = (d: string[]) => [...Array(4).fill(FILL), ...d, ...Array(Math.max(0, 30 - d.length)).fill(FILL)];
  e.apply({ type: 'START', first, seed: 1, names: ['A', 'B'], decks: [pad(d0), pad(d1)], fusions: [x0, x1], mode: 'speed', skills: [null, null] });
  settle(e);
  return e;
}
const run = (e: Engine, step: Generator<any, any, any>, ...ans: Ans[]) => {
  (e as any).run(step);
  return settle(e, ...ans);
};
const zone = (e: Engine, c: Card | null | undefined) => (c ? e.find(c.uid)?.loc.zone : undefined);
function grab(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.hand, ...ps.deck, ...ps.gy, ...ps.removed].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  if (zone(e, c) !== 'hand') e.toHandOf(c.uid, p);
  return c;
}
function place(e: Engine, p: Pid, name: string, pos: Pos = 'atk', faceUp = true, ...ans: Ans[]): FieldCard | null {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.gy, ...ps.fusion, ...ps.hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.specialSummon(c.uid, p, pos, faceUp), ...ans);
  const f = e.fieldCard(c.uid);
  if (f && !faceUp) f.placedTurn = -1;
  return f;
}
function putST(e: Engine, p: Pid, name: string, faceUp = false): FieldCard {
  const c = grab(e, p, name);
  const ps = e.player(p);
  ps.hand.splice(ps.hand.findIndex((x) => x.uid === c.uid), 1);
  const z = ps.sz.findIndex((x) => x === null);
  const fc: FieldCard = { ...c, pos: 'atk', faceUp, placedTurn: -1, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, ...(faceUp ? { active: true } : {}) };
  ps.sz[z] = fc;
  return fc;
}
const act = (e: Engine, p: Pid, uid: number, ...ans: Ans[]) => {
  e.apply({ type: 'ACTIVATE', player: p, uid, zone: e.player(p).sz.findIndex((z) => z === null) });
  return settle(e, ...ans);
};
function playSpell(e: Engine, p: Pid, name: string, ...ans: Ans[]): Card {
  const c = grab(e, p, name);
  act(e, p, c.uid, ...ans);
  return c;
}
function playTrap(e: Engine, p: Pid, name: string, ...ans: Ans[]): FieldCard | null {
  const fc = putST(e, p, name);
  act(e, p, fc.uid, ...ans);
  return e.fieldCard(fc.uid);
}
function summon(e: Engine, p: Pid, name: string, faceUp = true, ...ans: Ans[]): FieldCard | null {
  const c = grab(e, p, name);
  e.player(p).normalSummoned = false;
  e.apply({ type: 'SUMMON', player: p, uid: c.uid, zone: e.player(p).mz.findIndex((z) => z === null), pos: faceUp ? 'atk' : 'def', faceUp });
  settle(e, ...ans);
  return e.fieldCard(c.uid);
}
const kill = (e: Engine, cards: (Card | null | undefined)[], by?: Pid, ...ans: Ans[]) => {
  const uids = cards.filter((c): c is Card => !!c).map((c) => c.uid);
  return run(e, by === undefined ? e.destroy(uids) : e.as(by, e.destroy(uids)), ...ans);
};
const endTurn = (e: Engine, ...ans: Ans[]) => {
  e.apply({ type: 'END_TURN', player: e.state.turnPlayer });
  return settle(e, ...ans);
};
const toBattle = (e: Engine) => {
  for (let i = 0; i < 3 && e.state.phase !== 'BP'; i++) {
    e.apply({ type: 'NEXT_PHASE', player: e.state.turnPlayer });
    settle(e);
  }
};
const attack = (e: Engine, a: FieldCard | null, t: FieldCard | null, ...ans: Ans[]) => {
  e.apply({ type: 'ATTACK', player: e.state.turnPlayer, uid: a!.uid, target: t ? t.uid : null });
  return settle(e, ...ans);
};
const effect = (e: Engine, p: Pid, c: Card | null, ...ans: Ans[]) => {
  e.apply({ type: 'MONSTER_EFFECT', player: p, uid: c!.uid });
  return settle(e, ...ans);
};
const quickNow = (e: Engine, p: Pid, c: Card | null, ...ans: Ans[]) => {
  e.apply({ type: 'QUICK_EFFECT', player: p, uid: c!.uid });
  return settle(e, ...ans);
};
const logHas = (e: Engine, text: string, since = 0) => e.state.log.slice(since).some((l) => l.text.includes(text));
const section = (s: string) => console.log(`\n--- ${s}`);
/** Plays to the given player's next turn (Main Phase 1). */
const toTurnOf = (e: Engine, p: Pid, ...ans: Ans[]) => {
  for (let i = 0; i < 3 && e.state.turnPlayer !== p; i++) endTurn(e, ...ans);
};

// ======================= Effect Monsters =======================
section('Amaterasu');
{
  const e = duel(['Amaterasu'], ['Axe Raider', 'Ookazi']);
  const ama = grab(e, 0, 'Amaterasu');
  check(e.summonBlocked(0, ama, 'normal', 'hand') && e.summonBlocked(0, ama, 'special', 'hand'), 'cannot be Normal or Special Summoned');
  check(!place(e, 0, 'Amaterasu'), 'a Special Summon does not happen');
  place(e, 0, FILL);
  place(e, 0, FILL);
  const set = summon(e, 0, 'Amaterasu', false);
  check(set && !set.faceUp && e.monsters(0).length === 1, 'it can be Set by Tributing 2 monsters');
  set!.placedTurn = -1;
  const axe = place(e, 1, 'Axe Raider');
  const oo = putST(e, 1, 'Ookazi');
  toTurnOf(e, 0);
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: set!.uid });
  settle(e);
  check(zone(e, axe) === 'removed' && zone(e, oo) === 'removed' && zone(e, set) === 'mz', 'flipped face-up: all other cards on the field are banished');
  endTurn(e);
  check(zone(e, set) === 'hand', 'End Phase of the turn it was flipped: it returns to the hand');
}

section('Ancient Gear Engineer');
{
  const e = duel(['Ancient Gear Engineer'], ['Trap Hole', 'Ookazi', 'Kuriboh'], [], [], 1);
  const th = putST(e, 1, 'Trap Hole');
  toTurnOf(e, 0);
  place(e, 0, FILL);
  const age = summon(e, 0, 'Ancient Gear Engineer', true, { respond: 'Trap Hole' });
  check(age && zone(e, age) === 'mz' && zone(e, th) === 'gy' && logHas(e, 'Ancient Gear Engineer destroys Trap Hole'), 'a Trap targeting it is negated and destroyed');
  toTurnOf(e, 1);
  const st = putST(e, 1, 'Ookazi');
  const weak = place(e, 1, 'Kuriboh');
  toTurnOf(e, 0);
  toBattle(e);
  attack(e, age, weak);
  check(zone(e, weak) === 'gy' && zone(e, st) === 'gy', 'after it attacks: it destroys a Spell/Trap the opponent controls');
}

section('Angel O7 / Blast Magician');
{
  const e = duel(['Angel O7', 'Blast Magician', 'Pot of Greed'], ['Kuriboh']);
  const bm = place(e, 0, 'Blast Magician');
  const kb = place(e, 1, 'Kuriboh');
  playSpell(e, 0, 'Pot of Greed', { respond: 'Blast Magician' });
  check(bm!.counters === 1, 'Blast Magician: a Spell activation places a Spell Counter');
  place(e, 0, FILL);
  place(e, 0, FILL);
  const o7 = summon(e, 0, 'Angel O7', true, { pick: [FILL, FILL] });
  check(o7 && o7.tags?.o7 === 1, 'Angel O7 is Tribute Summoned and gains its effect');
  effect(e, 0, bm);
  check(zone(e, kb) === 'mz' && logHas(e, "Blast Magician's effect was negated"), 'Angel O7: the effects of Effect Monsters cannot be activated (negated)');
  kill(e, [o7]);
  bm!.effectUsed = false;
  effect(e, 0, bm);
  check(zone(e, kb) === 'gy' && bm!.counters === 0, 'Blast Magician: remove a counter to destroy a monster with 700 or less ATK');
}

section('Artifact Moralltach');
{
  const e = duel(['Artifact Moralltach'], ['Axe Raider']);
  const art = grab(e, 0, 'Artifact Moralltach');
  effect(e, 0, art);
  check(zone(e, art) === 'sz' && !e.fieldCard(art.uid)!.faceUp, 'it can be Set in the Spell & Trap Zone');
  toTurnOf(e, 1);
  const axe = place(e, 1, 'Axe Raider');
  kill(e, [art], 1, 'yes', 'yes');
  check(zone(e, art) === 'mz', "destroyed while Set during the opponent's turn: it is Special Summoned");
  check(zone(e, axe) === 'gy', "Special Summoned during the opponent's turn: it destroys a face-up card they control");
}

section('Charging Gaia the Fierce Knight');
{
  const e = duel(['Charging Gaia the Fierce Knight', 'Black Luster Soldier', 'Ancient Gear Engineer']);
  const cg = grab(e, 0, 'Charging Gaia the Fierce Knight');
  effect(e, 0, cg);
  const m = e.fieldCard(cg.uid);
  check(m && e.atkOf(m) === 1900 && e.player(0).normalSummoned, 'Normal Summoned without Tributing, its original ATK is 1900');
  summon(e, 0, 'Ancient Gear Engineer', true, 'yes');
  check(zone(e, cg) === 'gy' && e.player(0).hand.some((c) => c.name === 'Black Luster Soldier'), 'Tributed: it adds a "Black Luster Soldier" monster from the Deck');
}

section('Converging Wills Dragon');
{
  const e = duel(['Converging Wills Dragon', 'Converging Wills Dragon']);
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  const drawn = e.player(0).hand.find((c) => c.name === 'Converging Wills Dragon')!;
  const other = e.player(0).deck.find((c) => c.name === 'Converging Wills Dragon')!;
  check(!!drawn && e.canUseMonsterEffect(0, drawn), 'the copy drawn this turn can be revealed');
  effect(e, 0, drawn);
  check(zone(e, drawn) === 'mz', 'it is Special Summoned from the hand');
  e.toHandOf(other.uid, 0);
  check(!e.canUseMonsterEffect(0, other) && e.summonBlocked(0, other, 'special', 'hand'), 'a copy not drawn this turn cannot; only 1 Special Summon per turn');
}

section('D.D. Survivor');
{
  const e = duel(['D.D. Survivor']);
  const dd = place(e, 0, 'D.D. Survivor');
  run(e, (function* () {
    e.banish(dd!.uid);
  })());
  check(zone(e, dd) === 'removed', 'it is banished face-up from the field');
  endTurn(e);
  check(zone(e, dd) === 'mz', 'End Phase: it is Special Summoned back');
}

section('Des Wombat');
{
  const e = duel(['Des Wombat'], ['Ookazi']);
  place(e, 0, 'Des Wombat');
  toTurnOf(e, 1);
  playSpell(e, 1, 'Ookazi');
  check(e.player(0).lp === 4000 && logHas(e, 'Ookazi'), 'damage from a card effect becomes 0');
}

section('Djinn Prognosticator of Rituals / Ritual Raven');
{
  const e = duel(['Djinn Prognosticator of Rituals', 'Black Magic Ritual', 'Magician of Black Chaos']);
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  const dj = grab(e, 0, 'Djinn Prognosticator of Rituals');
  run(e, e.sendToGrave(dj.uid, 'discard'));
  grab(e, 0, 'Magician of Black Chaos');
  playSpell(e, 0, 'Black Magic Ritual', { pick: ['Djinn Prognosticator of Rituals', FILL, FILL] });
  const mobc = e.monsters(0).find((m) => m.name === 'Magician of Black Chaos');
  check(mobc && zone(e, dj) === 'removed', 'Djinn is banished from the GY as one of the Ritual materials');
  const hand = e.player(1).hand.length;
  toBattle(e);
  attack(e, mobc!, null);
  check(e.player(1).hand.length === hand - 1 && logHas(e, 'Djinn Prognosticator of Rituals:'), 'the Ritual Monster inflicts battle damage: the opponent discards 1 card');
}
{
  const e = duel(['Ritual Raven', 'Black Magic Ritual', 'Magician of Black Chaos']);
  const rr = place(e, 0, 'Ritual Raven');
  grab(e, 0, 'Magician of Black Chaos');
  playSpell(e, 0, 'Black Magic Ritual', { pick: ['Ritual Raven'] });
  check(zone(e, rr) === 'gy' && e.monsters(0).some((m) => m.name === 'Magician of Black Chaos'), 'Ritual Raven alone is the entire Tribute for a DARK Ritual Monster');
}

section('Evil HERO Infernal Gainer');
{
  const e = duel(['Evil HERO Infernal Gainer', 'Archfiend Soldier']);
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  const g = place(e, 0, 'Evil HERO Infernal Gainer');
  const f = place(e, 0, 'Archfiend Soldier');
  effect(e, 0, g, { pick: ['Archfiend Soldier'] });
  check(zone(e, g) === 'removed' && f!.tags?.extraAttacks === 1, 'banished: a Fiend can make a second attack');
  toBattle(e);
  attack(e, f, null);
  attack(e, f, null);
  check(e.player(1).lp === 4000 - 2 * 1900, 'the Fiend attacks twice');
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  check(zone(e, g) === 'removed', 'not back at the first Standby Phase');
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  check(zone(e, g) === 'mz', 'Special Summoned at the second Standby Phase after it was banished');
}

section('Falchion Beta');
{
  const e = duel(['Falchion Beta', 'Falchion Beta', 'Falchion Beta'], ['Kuriboh']);
  const fb = place(e, 0, 'Falchion Beta');
  const kb = place(e, 1, 'Kuriboh');
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  toBattle(e);
  attack(e, fb, kb);
  check(zone(e, kb) === 'gy' && e.player(0).gy.some((c) => c.name === 'Falchion Beta'), 'it destroys a monster: a LIGHT Machine goes from the Deck to the GY');
}

section('Freed the Matchless General');
{
  const e = duel(['Freed the Matchless General'], ['Change of Heart']);
  const fr = place(e, 0, 'Freed the Matchless General');
  toTurnOf(e, 1);
  const coh = playSpell(e, 1, 'Change of Heart');
  check(e.controller(fr!.uid) === 0 && zone(e, coh) === 'gy' && logHas(e, 'Freed the Matchless General destroys Change of Heart'), 'a Spell targeting it is negated and destroyed');
  const deck = e.player(0).deck.length;
  const hand = e.player(0).hand.length;
  toTurnOf(e, 0, 'yes');
  check(logHas(e, 'gives up the normal draw') && e.player(0).hand.length === hand + 1 && e.player(0).deck.length === deck - 1, 'it adds a Level 4 or lower Warrior instead of the normal draw');
}

section('Gimmick Puppet Gear Changer');
{
  const e = duel(['Gimmick Puppet Gear Changer', 'Gimmick Puppet Des Troy']);
  const gc = e.player(0).deck.find((c) => c.name === 'Gimmick Puppet Gear Changer')!;
  check(e.summonBlocked(0, gc, 'special', 'deck'), 'cannot be Special Summoned from the Deck');
  e.toHandOf(gc.uid, 0);
  const m = place(e, 0, 'Gimmick Puppet Gear Changer');
  place(e, 0, 'Gimmick Puppet Des Troy');
  effect(e, 0, m);
  check(e.state.fx.declLevel?.[m!.uid] === DB.get('Gimmick Puppet Des Troy')!.level, 'its Level becomes that of another "Gimmick Puppet" monster');
}

section('Helpoemer');
{
  const e = duel(['Helpoemer'], ['Blue-Eyes White Dragon']);
  const hp = place(e, 0, 'Helpoemer');
  toTurnOf(e, 1);
  const bewd = place(e, 1, 'Blue-Eyes White Dragon');
  toBattle(e);
  attack(e, bewd, hp);
  const gy = e.player(1).gy.length;
  endTurn(e);
  check(zone(e, hp) === 'gy' && e.player(1).gy.length === gy + 1 && logHas(e, 'Helpoemer:'), "destroyed by battle: at the end of the opponent's turn they discard a random card");
  check(e.summonBlocked(0, hp!, 'special', 'gy'), 'cannot be Special Summoned from the GY');
}

section("Joker's Knight");
{
  const e = duel(["Joker's Knight", "Queen's Knight"]);
  const jk = grab(e, 0, "Joker's Knight");
  effect(e, 0, jk);
  check(zone(e, jk) === 'mz' && e.player(0).gy.some((c) => c.name === "Queen's Knight"), 'sends a Knight from the Deck to the GY and Special Summons itself');
  kill(e, [jk]);
  endTurn(e, 'yes');
  check(zone(e, jk) === 'hand' && !e.player(0).gy.some((c) => c.name === "Queen's Knight"), 'End Phase in the GY: shuffles a LIGHT Warrior into the Deck and returns to the hand');
}

section('Magical Reflect Slime');
{
  const e = duel(['Magical Reflect Slime'], ['Blue-Eyes White Dragon']);
  const sl = place(e, 0, 'Magical Reflect Slime');
  effect(e, 0, sl);
  check(sl!.tags?.gemini === 1, 'Normal Summoned again: it becomes an Effect Monster');
  toTurnOf(e, 1);
  const bewd = place(e, 1, 'Blue-Eyes White Dragon');
  toBattle(e);
  attack(e, bewd, sl);
  check(e.player(0).lp === 4000 && e.player(1).lp === 4000 - 2300, 'the opponent takes the battle damage instead');
}

section('Marauding Captain');
{
  const e = duel(['Marauding Captain'], ['Axe Raider']);
  const mc = summon(e, 0, 'Marauding Captain', true, 'yes');
  check(mc && e.monsters(0).length === 2, 'Normal Summoned: it Special Summons a Level 4 or lower monster from the hand');
  const axe = place(e, 1, 'Axe Raider');
  const targets = e.legalTargets(1, axe!).map((m) => m.name);
  check(targets.length === 1 && targets[0] === 'Marauding Captain', 'the opponent can only attack it, not the other Warrior');
}

section('Morpho Butterspy');
{
  const e = duel(['Morpho Butterspy'], ['Axe Raider']);
  place(e, 0, 'Morpho Butterspy');
  const axe = place(e, 1, 'Axe Raider');
  toTurnOf(e, 1);
  e.apply({ type: 'CHANGE_POS', player: 1, uid: axe!.uid });
  settle(e, 'yes');
  check(e.atkOf(axe!) === 700 && e.defOf(axe!) === 150, "an opponent's monster changes position: it loses 1000 ATK and DEF");
}

section('Performapal Extra Slinger');
{
  const e = duel(['Performapal Extra Slinger']);
  const m = summon(e, 0, 'Performapal Extra Slinger');
  check(!!getEffect('Performapal Extra Slinger') && m && zone(e, m) === 'mz', 'it can be played (its effects need Pendulum Zones)');
}

section('Prime Material Dragon');
{
  const e = duel(['Prime Material Dragon'], ['Ookazi', 'Fissure']);
  const pmd = place(e, 0, 'Prime Material Dragon');
  toTurnOf(e, 1);
  playSpell(e, 1, 'Ookazi');
  check(e.player(0).lp === 4800, 'effect damage makes the player gain that much LP instead');
  const fis = playSpell(e, 1, 'Fissure', { respond: 'Prime Material Dragon' });
  check(zone(e, pmd) === 'mz' && zone(e, fis) === 'gy' && logHas(e, 'Fissure is negated'), 'it negates and destroys a card that would destroy a monster');
}

section('Terrorking Archfiend');
{
  const e = duel(['Terrorking Archfiend', 'Archfiend Soldier'], ['Change of Heart']);
  const tk = grab(e, 0, 'Terrorking Archfiend');
  check(e.summonBlocked(0, tk, 'normal', 'hand'), 'cannot be Normal Summoned without an Archfiend');
  place(e, 0, 'Archfiend Soldier');
  check(!e.summonBlocked(0, tk, 'normal', 'hand'), 'can be with an Archfiend face-up');
  const m = summon(e, 0, 'Terrorking Archfiend');
  toTurnOf(e, 1);
  e.roll = () => 2;
  const coh = playSpell(e, 1, 'Change of Heart', { pick: ['Terrorking Archfiend'] });
  check(e.controller(m!.uid) === 0 && zone(e, coh) === 'gy' && logHas(e, 'Terrorking Archfiend rolls a 2'), 'targeted by the opponent: a 2 negates and destroys that card');
  toTurnOf(e, 0);
  check(e.player(0).lp === 3200, 'Standby Phase: its controller pays 800 LP');
}

section('Twin-Headed Wolf');
{
  const e = duel(['Twin-Headed Wolf', 'Archfiend Soldier'], ['Man-Eater Bug']);
  const w = place(e, 0, 'Twin-Headed Wolf');
  place(e, 0, 'Archfiend Soldier');
  const bug = place(e, 1, 'Man-Eater Bug', 'def', false);
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  toBattle(e);
  attack(e, w, bug);
  check(zone(e, bug) === 'gy' && e.monsters(0).length === 2 && logHas(e, "negates Man-Eater Bug's FLIP effect"), 'the FLIP effect of a Flip monster it destroys is negated');
}

section('Warrior of Atlantis');
{
  const e = duel(['Warrior of Atlantis', 'A Legendary Ocean']);
  const w = grab(e, 0, 'Warrior of Atlantis');
  effect(e, 0, w);
  check(zone(e, w) === 'gy' && e.player(0).hand.some((c) => c.name === 'A Legendary Ocean'), 'discarded: adds "A Legendary Ocean" from the Deck');
}

// ======================= Fusion and Ritual Monsters =======================
section('Brigrand the Glory Dragon');
{
  const e = duel([], ['Blue-Eyes White Dragon'], ['Brigrand the Glory Dragon']);
  const br = place(e, 0, 'Brigrand the Glory Dragon');
  const f = place(e, 0, FILL);
  e.actor = 1;
  const shielded = e.untargetable(f!) && !e.untargetable(br!);
  e.actor = null;
  check(shielded, 'the opponent cannot target the other monsters you control');
  toTurnOf(e, 1);
  const bewd = place(e, 1, 'Blue-Eyes White Dragon');
  toBattle(e);
  attack(e, bewd, br);
  check(zone(e, br) === 'mz' && e.player(0).lp === 3500, 'cannot be destroyed by battle');
}

section('Destiny HERO - Dangerous');
{
  const e = duel(['Destiny HERO - Malicious'], [], ['Destiny HERO - Dangerous']);
  const d = place(e, 0, 'Destiny HERO - Dangerous');
  quickNow(e, 0, d);
  check(e.player(0).gy.some((c) => c.name === 'Destiny HERO - Malicious') && e.atkOf(d!) === 2200, 'discard 1: send a "Destiny HERO" to the GY; "Destiny HERO" monsters gain 200 ATK for each in the GY');
}

section('Elemental HERO Dark Neos');
{
  const e = duel([], ['Kuriboh'], ['Elemental HERO Dark Neos']);
  const dn = place(e, 0, 'Elemental HERO Dark Neos');
  const kb = place(e, 1, 'Kuriboh');
  effect(e, 0, dn);
  check(e.isNegated(kb!), "it negates a face-up Effect Monster's effects");
  endTurn(e);
  check(e.player(0).fusion.some((c) => c.uid === dn!.uid) && !e.isNegated(kb!), 'End Phase: shuffled into the Extra Deck, the negation ends');
}

section('Evil HERO Dark Gaia');
{
  const e = duel(['Archfiend Soldier', 'Giant Soldier of Stone'], ['Axe Raider'], ['Evil HERO Dark Gaia']);
  const dg = place(e, 0, 'Evil HERO Dark Gaia');
  const mats = ['Archfiend Soldier', 'Giant Soldier of Stone'].map((n) => e.player(0).deck.find((c) => c.name === n)!);
  for (const c of mats) run(e, e.sendToGrave(c.uid, 'used'));
  e.state.fx.fusionMatList = { [dg!.uid]: mats.map((c) => c.uid) };
  check(e.atkOf(dg!) === 1900 + 1300, 'its original ATK is the combined original ATK of its materials');
  check(e.summonBlocked(0, mats[0], 'special', 'gy') === false && e.summonBlocked(0, dg!, 'special', 'gy'), 'it cannot be Special Summoned except from the Extra Deck');
  const axe = place(e, 1, 'Axe Raider', 'def', false);
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  toBattle(e);
  attack(e, dg, axe, 'yes');
  check(logHas(e, 'change to face-up Attack Position') && zone(e, axe) === 'gy' && e.player(1).lp === 4000 - (3200 - 1700), 'declaring an attack: Defense Position monsters change to face-up Attack Position');
}

section('Black Luster Soldier - Legendary Swordsman');
{
  const e = duel(['Black Luster Soldier - Legendary Swordsman', 'Black Luster Ritual', 'Black Luster Ritual'], ['Negate Attack', 'Kuriboh', 'Ookazi']);
  const bls = grab(e, 0, 'Black Luster Soldier - Legendary Swordsman');
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  const deck = e.player(0).deck.length;
  effect(e, 0, bls);
  check(e.player(0).hand.some((c) => c.name === 'Black Luster Ritual') && e.player(0).deck.length === deck && logHas(e, 'gives up the normal draw'), 'reveal it: give up the normal draw to add a Ritual Spell');
  const m = place(e, 0, 'Black Luster Soldier - Legendary Swordsman');
  const kb = place(e, 1, 'Kuriboh');
  const na = putST(e, 1, 'Negate Attack');
  const oo = putST(e, 1, 'Ookazi');
  toBattle(e);
  attack(e, m, kb, { respond: 'Negate Attack' }, 'yes');
  check(zone(e, na) === 'gy' && logHas(e, "Negate Attack's effect was negated"), 'the opponent cannot activate cards during your Battle Phase');
  check(zone(e, kb) === 'gy' && zone(e, oo) === 'deck' && e.monsters(1).length === 0, 'it destroys a monster: all cards the opponent controls are shuffled into the Deck');
}

// ======================= Spells =======================
section('Bashing Shield');
{
  const e = duel(['Bashing Shield'], ['Blue-Eyes White Dragon']);
  const f = summon(e, 0, FILL);
  const bewd = place(e, 1, 'Blue-Eyes White Dragon');
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  playSpell(e, 0, 'Bashing Shield');
  check(e.atkOf(f!) === 2400, 'the equipped monster gains 1000 ATK');
  toBattle(e);
  attack(e, f, bewd);
  check(e.player(0).lp === 4000 && zone(e, f) === 'gy', 'no battle damage from attacks involving it');
}

section('Ancient City - Rainbow Ruins');
{
  const e = duel(['Ancient City - Rainbow Ruins', 'Crystal Beast Ruby Carbuncle', 'Crystal Beast Topaz Tiger', 'Crystal Beast Amethyst Cat', 'Crystal Beast Sapphire Pegasus'], ['Ookazi', 'Axe Raider']);
  const rr = playSpell(e, 0, 'Ancient City - Rainbow Ruins');
  putST(e, 0, 'Crystal Beast Ruby Carbuncle', true);
  kill(e, [rr]);
  check(zone(e, rr) === 'field', '1+: it cannot be destroyed by card effects');
  putST(e, 0, 'Crystal Beast Topaz Tiger', true);
  putST(e, 0, 'Crystal Beast Amethyst Cat', true);
  const peg = place(e, 0, 'Crystal Beast Sapphire Pegasus');
  toTurnOf(e, 1);
  const oo = playSpell(e, 1, 'Ookazi', { respond: 'Ancient City - Rainbow Ruins' });
  check(zone(e, oo) === 'gy' && zone(e, peg) === 'gy' && e.player(0).lp === 4000, '3+: send a "Crystal Beast" monster to negate a Spell activation');
  const att = place(e, 1, 'Axe Raider');
  toBattle(e);
  attack(e, att, null, { respond: 'Ancient City - Rainbow Ruins' });
  check(e.player(0).lp === 4000 - 850, '2+: the battle damage is halved');
}

section('Oracle of Zefra');
{
  const e = duel(['Oracle of Zefra', 'Satellarknight Zefrathuban', 'Black Magic Ritual', 'Magician of Black Chaos'], ['Axe Raider']);
  playSpell(e, 0, 'Oracle of Zefra');
  check(e.player(0).hand.some((c) => c.name === 'Satellarknight Zefrathuban'), 'activated: it adds a "Zefra" monster from the Deck');
  const axe = place(e, 1, 'Axe Raider');
  grab(e, 0, 'Magician of Black Chaos');
  playSpell(e, 0, 'Black Magic Ritual', { pick: ['Satellarknight Zefrathuban', FILL] }, 'yes', { pick: ['Axe Raider'] });
  check(zone(e, axe) === 'deck', 'Ritual Summon using a "Zefra" monster: shuffle 1 monster on the field into the Deck');
}

section('Branded Fusion');
{
  const e = duel(['Beastking of the Swamps', 'Blue-Eyes White Dragon', 'Branded Fusion'], [], ['Brigrand the Glory Dragon']);
  grab(e, 0, 'Beastking of the Swamps');
  playSpell(e, 0, 'Branded Fusion');
  check(e.monsters(0).some((m) => m.name === 'Brigrand the Glory Dragon') && e.player(0).gy.some((c) => c.name === 'Blue-Eyes White Dragon'), 'Fusion Summons a Fusion Monster that lists "Fallen of Albaz", with a material from the Deck');
}

section('Diffusion Wave-Motion');
{
  const e = duel(['Diffusion Wave-Motion', 'Dark Magician'], ['Kuriboh', 'Kuriboh']);
  const dm = place(e, 0, 'Dark Magician');
  const f = place(e, 0, FILL);
  const k1 = place(e, 1, 'Kuriboh', 'def');
  const k2 = place(e, 1, 'Kuriboh', 'def');
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  playSpell(e, 0, 'Diffusion Wave-Motion');
  check(e.player(0).lp === 3000, 'pay 1000 LP');
  toBattle(e);
  check(!e.canAttackWith(0, f!), 'other monsters cannot attack');
  attack(e, dm, k1);
  attack(e, dm, k2);
  check(zone(e, k1) === 'gy' && zone(e, k2) === 'gy', 'the Spellcaster attacks each monster the opponent controls');
}

section('Heat Wave');
{
  const e = duel(['Heat Wave', 'Kuriboh', 'Blue-Eyes White Dragon'], ['Kuriboh']);
  const hw = playSpell(e, 0, 'Heat Wave');
  check(e.summonBlocked(0, grab(e, 0, 'Kuriboh'), 'normal', 'hand') && !e.summonBlocked(0, grab(e, 0, FILL), 'normal', 'hand'), 'Effect Monsters cannot be Normal Summoned; Normal Monsters can');
  check(!place(e, 0, 'Kuriboh') && !!place(e, 0, 'Blue-Eyes White Dragon'), 'nor Special Summoned');
  toTurnOf(e, 1);
  check(e.summonBlocked(1, grab(e, 1, 'Kuriboh'), 'normal', 'hand'), "it lasts through the opponent's turn");
  toTurnOf(e, 0);
  check(zone(e, hw) === 'gy' && !e.summonBlocked(0, grab(e, 0, 'Kuriboh'), 'normal', 'hand'), 'it ends at your next turn');
}

section('The Big Cattle Drive');
{
  const e = duel(['The Big Cattle Drive', 'Gazelle the King of Mythical Beasts', 'Harpie Lady']);
  place(e, 0, 'Gazelle the King of Mythical Beasts');
  place(e, 0, 'Harpie Lady');
  grab(e, 0, 'The Big Cattle Drive');
  const hand = e.player(0).hand.length;
  playSpell(e, 0, 'The Big Cattle Drive');
  check(e.player(0).hand.length === hand + 1, 'draw 1 card for each of Beast, Beast-Warrior, Winged Beast you control (2)');
}

section('Berserk Scales');
{
  const e = duel(['Berserk Scales']);
  const f = place(e, 0, FILL);
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  playSpell(e, 0, 'Berserk Scales');
  check(e.atkOf(f!) === 2400, 'it gains 1000 ATK');
  toBattle(e);
  check(!e.canAttackWith(0, f!), 'it cannot attack directly');
  endTurn(e);
  check(e.atkOf(f!) === 400, 'End Phase: it loses 2000 ATK');
}

// ======================= Traps =======================
section('By Order of the Emperor');
{
  const e = duel(['By Order of the Emperor'], ['Marauding Captain']);
  playTrap(e, 0, 'By Order of the Emperor');
  toTurnOf(e, 1);
  const hand = e.player(1).hand.length;
  let left = 0;
  const c = grab(e, 1, 'Marauding Captain');
  e.apply({ type: 'SUMMON', player: 1, uid: c.uid, zone: 0, pos: 'atk', faceUp: true });
  left = settle(e, { respond: 'By Order of the Emperor' }, 'yes');
  check(left === 1 && e.monsters(1).length === 1 && e.player(1).hand.length === hand + 1 - 1 + 0, 'the Normal Summon effect is negated (no Special Summon) and its controller draws 1');
}

section('Barrel Behind the Door');
{
  const e = duel(['Barrel Behind the Door'], ['Ookazi']);
  putST(e, 0, 'Barrel Behind the Door');
  toTurnOf(e, 1);
  playSpell(e, 1, 'Ookazi', { respond: 'Barrel Behind the Door' });
  check(e.player(0).lp === 4000 && e.player(1).lp === 3200, 'the opponent takes the effect damage instead');
}

section('Horn of the Phantom Beast');
{
  const e = duel(['Horn of the Phantom Beast', 'Gazelle the King of Mythical Beasts'], ['Kuriboh']);
  const gz = place(e, 0, 'Gazelle the King of Mythical Beasts');
  const kb = place(e, 1, 'Kuriboh');
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  const horn = playTrap(e, 0, 'Horn of the Phantom Beast');
  check(horn && horn.equippedTo === gz!.uid && e.atkOf(gz!) === 1500 + 800, 'it equips to a Beast: +800 ATK');
  const hand = e.player(0).hand.length;
  toBattle(e);
  attack(e, gz, kb);
  check(zone(e, kb) === 'gy' && e.player(0).hand.length === hand + 1, 'the equipped monster destroys a monster by battle: draw 1');
}

section('Massivemorph');
{
  const e = duel(['Massivemorph'], ['Axe Raider']);
  const axe = place(e, 1, 'Axe Raider');
  playTrap(e, 0, 'Massivemorph');
  check(e.atkOf(axe!) === 3400 && e.defOf(axe!) === 2300, 'its ATK and DEF are doubled');
  e.monsters(0).forEach((m) => run(e, e.sendToGrave(m.uid, 'used')));
  toTurnOf(e, 1);
  toBattle(e);
  check(!e.canAttackWith(1, axe!), 'it cannot attack directly');
}

section('Raging Cloudian');
{
  const e = duel(['Raging Cloudian', 'Cloudian - Altus']);
  place(e, 0, 'Cloudian - Altus', 'def');
  const alt = e.player(0).gy.find((c) => c.name === 'Cloudian - Altus');
  check(zone(e, alt) === 'gy', 'a Cloudian in face-up Defense Position destroys itself');
  playTrap(e, 0, 'Raging Cloudian');
  const m = e.fieldCard(alt!.uid);
  check(m && m.pos === 'atk' && m.tags?.fog === 1, 'it is Special Summoned in Attack Position with a Fog Counter');
}

section('Shadow of Eyes');
{
  const e = duel(['Shadow of Eyes'], ['Axe Raider', 'Ookazi']);
  putST(e, 0, 'Shadow of Eyes');
  toTurnOf(e, 1);
  const axe = summon(e, 1, 'Axe Raider', false);
  playSpell(e, 1, 'Ookazi', { respond: 'Shadow of Eyes' });
  check(axe!.faceUp && axe!.pos === 'atk', 'the Set monster is changed to face-up Attack Position');
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
if (fails) process.exit(1);
