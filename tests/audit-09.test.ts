// Speed Duel card scripts of batch 09 (run: npx tsx tests/audit-09.test.ts)
// audit-09: one targeted check per card of batch 09 (Rare Metalmorph ... Tail Swipe): its main effect really happens in a duel.
import { Engine } from '../src/eds/engine';
import type { Card, CardInfo, FieldCard, Pid, Pos } from '../src/eds/types';
import { getEffect } from '../src/eds/effects';
import { DB } from './speedkit';

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};
const FILL = 'Celtic Guardian';

// ---------- duel kit ----------
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
/** Moves a card of `p` (deck, GY, banished or hand) into the hand. */
function grab(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.hand, ...ps.deck, ...ps.gy, ...ps.removed].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  if (zone(e, c) !== 'hand') e.toHandOf(c.uid, p);
  return c;
}
/** Special Summons a card of `p` from wherever it is (Extra Deck included). Null when it did not arrive. */
function place(e: Engine, p: Pid, name: string, pos: Pos = 'atk', faceUp = true, ...ans: Ans[]): FieldCard | null {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.gy, ...ps.fusion, ...ps.hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.specialSummon(c.uid, p, pos, faceUp), ...ans);
  const f = e.fieldCard(c.uid);
  if (f && !faceUp) f.placedTurn = -1;
  return f;
}
/** Puts a card face-down in a Spell/Trap Zone (ready to be activated this turn). */
function putST(e: Engine, p: Pid, name: string): FieldCard {
  const c = grab(e, p, name);
  const ps = e.player(p);
  ps.hand.splice(ps.hand.findIndex((x) => x.uid === c.uid), 1);
  const z = ps.sz.findIndex((x) => x === null);
  const fc: FieldCard = { ...c, pos: 'atk', faceUp: false, placedTurn: -1, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
  ps.sz[z] = fc;
  return fc;
}
const act = (e: Engine, p: Pid, uid: number, ...ans: Ans[]) => {
  e.apply({ type: 'ACTIVATE', player: p, uid, zone: e.player(p).sz.findIndex((z) => z === null) });
  return settle(e, ...ans);
};
/** Activates a Spell from the hand (it is fetched there first). */
function playSpell(e: Engine, p: Pid, name: string, ...ans: Ans[]): FieldCard | null {
  const c = grab(e, p, name);
  act(e, p, c.uid, ...ans);
  return e.fieldCard(c.uid);
}
/** Sets a Trap and activates it in the Main Phase. */
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
const active = (e: Engine, c: FieldCard | null) => !!c && zone(e, c) === 'sz' && c.faceUp && !!c.active;
const logHas = (e: Engine, text: string, since = 0) => e.state.log.slice(since).some((l) => l.text.includes(text));
const section = (s: string) => console.log(`\n--- ${s}`);

// ---------- audit-09 extras ----------
// Cards this game's pool lacks: test-only stand-ins added to the card database.
const fake = (info: Partial<CardInfo> & { name: string }) => {
  const full = { id: 991000 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
fake({ name: 'Red Dragon Archfiend', sub: 'Synchro', level: 8, atk: 3000, def: 2000, race: 'Dragon', attribute: 'DARK' });
fake({ name: 'Test Tuner One', sub: 'Effect', tuner: true, level: 1, atk: 300, def: 300, race: 'Dragon', attribute: 'DARK' });
fake({ name: 'SPYRAL Super Agent', sub: 'Effect', level: 4, atk: 1900, def: 1200, race: 'Warrior', attribute: 'EARTH' });
fake({ name: 'Venom Test Serpent', sub: 'Effect', level: 3, atk: 1000, def: 1000, race: 'Reptile', attribute: 'DARK' });
const atk = (e: Engine, c: FieldCard | null) => (c ? e.atkOf(c) : -1);
/** A duel on player 0's second turn (Main Phase 1), so attacks are possible. */
function turn2(d0: string[], d1: string[] = [], x0: string[] = [], x1: string[] = []): Engine {
  const e = duel(d0, d1, x0, x1, 1);
  endTurn(e);
  return e;
}
/** Sends a card of `p` (deck/hand/GY) to the GY as if by a cost. */
function toGy(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.hand].find((x) => x.name === name) ?? ps.gy.find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  if (zone(e, c) !== 'gy') run(e, e.sendToGrave(c.uid, 'cost'));
  return c;
}
/** A face-up, active Spell/Trap in a Spell & Trap Zone (or the Field Zone). */
function putActive(e: Engine, p: Pid, name: string): FieldCard {
  const fc = putST(e, p, name);
  fc.faceUp = true;
  fc.active = true;
  if (e.info(name).sub === 'Field') {
    const ps = e.player(p);
    ps.sz[ps.sz.findIndex((x) => x?.uid === fc.uid)] = null;
    ps.field = fc;
  }
  return fc;
}
/** Puts a monster straight onto the field (no Summon). */
function putMZ(e: Engine, p: Pid, name: string, pos: Pos = 'atk', faceUp = true): FieldCard {
  const c = grab(e, p, name);
  const ps = e.player(p);
  ps.hand.splice(ps.hand.findIndex((x) => x.uid === c.uid), 1);
  const fc: FieldCard = { ...c, pos, faceUp, placedTurn: -1, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
  ps.mz[ps.mz.findIndex((x) => x === null)] = fc;
  return fc;
}
const gyHas = (e: Engine, p: Pid, name: string) => e.player(p).gy.some((c) => c.name === name);
const handHas = (e: Engine, p: Pid, name: string) => e.player(p).hand.some((c) => c.name === name);
const onField = (e: Engine, p: Pid, name: string) => e.monsters(p).find((m) => m.name === name) ?? null;
const graveEffect = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'GRAVE_EFFECT', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const setRoll = (e: Engine, n: number) => ((e as unknown as { roll: () => number }).roll = () => n);

// ================= R =================
section('Rare Metalmorph');
{
  const e = duel(['Cycroid', 'Rare Metalmorph'], ['Shield Crush']);
  const m = place(e, 0, 'Cycroid', 'def');
  const before = atk(e, m);
  const mm = playTrap(e, 0, 'Rare Metalmorph');
  check(before === 800 && atk(e, m) === 1300 && m!.equips.includes(mm!.uid), 'Rare Metalmorph: the Machine gains 500 ATK');
  endTurn(e);
  playSpell(e, 1, 'Shield Crush', { respond: 'Rare Metalmorph' });
  check(!!e.fieldCard(m!.uid) && gyHas(e, 1, 'Shield Crush'), 'Rare Metalmorph: negates the Spell that targets its monster');
  kill(e, [m]);
  check(gyHas(e, 0, 'Rare Metalmorph'), 'Rare Metalmorph: leaves the field with its monster');
}

section('Rare Value');
{
  const e = duel(['Crystal Beast Topaz Tiger', 'Crystal Beast Amber Mammoth', 'Rare Value']);
  putActive(e, 0, 'Crystal Beast Topaz Tiger');
  putActive(e, 0, 'Crystal Beast Amber Mammoth');
  grab(e, 0, 'Rare Value');
  const h = e.player(0).hand.length;
  playSpell(e, 0, 'Rare Value');
  const sent = e.player(0).gy.filter((c) => c.name.startsWith('Crystal Beast')).length;
  check(sent === 1 && e.player(0).hand.length === h - 1 + 2, 'Rare Value: 1 "Crystal Beast" goes to the GY, then draw 2');
}

section('Raviel, Lord of Phantasms');
{
  const e = duel(['Raviel, Lord of Phantasms', 'Archfiend Soldier', 'Archfiend Soldier', 'Archfiend Soldier', 'Monster Reborn'], [], [], []);
  for (let i = 0; i < 3; i++) place(e, 0, 'Archfiend Soldier');
  const r = grab(e, 0, 'Raviel, Lord of Phantasms');
  check(e.canSpecialProc(0, r), 'Raviel: its Summon procedure is offered with 3 Fiends');
  e.apply({ type: 'SPECIAL', player: 0, uid: r.uid });
  settle(e);
  const rv = e.fieldCard(r.uid);
  check(!!rv && e.player(0).gy.filter((c) => c.name === 'Archfiend Soldier').length === 3, 'Raviel: Special Summoned by Tributing 3 Fiends');
  place(e, 0, FILL);
  effect(e, 0, rv);
  check(atk(e, rv) === 4000 + 1400 && e.monsters(0).length === 1, 'Raviel: Tributes 1 monster and gains its original ATK');
  endTurn(e);
  summon(e, 1, FILL);
  const tok = onField(e, 0, 'Phantasm Token');
  check(!!tok && tok.cannotAttack === true, 'Raviel: a Phantasm Token (cannot attack) when the opponent Normal Summons');
  kill(e, [rv]);
  endTurn(e);
  act(e, 0, grab(e, 0, 'Monster Reborn').uid, { pick: ['Raviel, Lord of Phantasms'] }, 'yes');
  check(zone(e, rv) === 'gy', 'Raviel: cannot be Special Summoned from the GY by other ways');
}

section('Re-Fusion');
{
  const e = duel(['Re-Fusion'], [], ['Flame Swordsman']);
  const fs = place(e, 0, 'Flame Swordsman');
  kill(e, [fs]);
  const rf = playSpell(e, 0, 'Re-Fusion');
  const back = e.fieldCard(fs!.uid);
  check(e.player(0).lp === 3200 && !!back && !!rf && back.equips.includes(rf.uid), 'Re-Fusion: pays 800 LP, revives the Fusion Monster and equips to it');
  kill(e, [rf]);
  check(zone(e, fs) === 'removed', 'Re-Fusion: when it is destroyed, the monster is banished');
}

section('Reactor Slime');
{
  const e = duel(['Reactor Slime', 'Obelisk the Tormentor']);
  const s = place(e, 0, 'Reactor Slime');
  effect(e, 0, s);
  const fill = e.player(0).hand.find((c) => c.name === FILL)!;
  check(e.monsters(0).filter((m) => m.name === 'Slime Token').length === 2, 'Reactor Slime: 2 Slime Tokens');
  check(e.summonBlocked(0, fill, 'normal', 'hand') && e.summonBlocked(0, fill, 'special', 'hand') && !e.summonBlocked(0, 'Obelisk the Tormentor', 'special', 'hand'), 'Reactor Slime: no other Summons this turn, except Divine-Beasts');
  const e2 = turn2(['Reactor Slime', 'Metal Reflect Slime']);
  const s2 = place(e2, 0, 'Reactor Slime');
  const a = place(e2, 0, FILL);
  toBattle(e2);
  attack(e2, a, null, { respond: 'Reactor Slime' });
  const mrs = e2.player(0).sz.find((c) => c?.name === 'Metal Reflect Slime');
  check(zone(e2, s2) === 'gy' && !!mrs && !mrs.faceUp && mrs.placedTurn < e2.state.turn, 'Reactor Slime: Tributed in the Battle Phase to Set Metal Reflect Slime (usable this turn)');
}

section('Ready for Intercepting');
{
  const e = duel(['Ready for Intercepting']);
  const c = place(e, 1, FILL);
  playTrap(e, 0, 'Ready for Intercepting');
  check(!c!.faceUp && c!.pos === 'def', 'Ready for Intercepting: the Warrior goes face-down Defense Position');
}

section('Recurring Nightmare');
{
  const e = duel(['Stealthroid', 'Steelswarm Sting', 'Recurring Nightmare']);
  toGy(e, 0, 'Stealthroid');
  toGy(e, 0, 'Steelswarm Sting');
  playSpell(e, 0, 'Recurring Nightmare');
  check(handHas(e, 0, 'Stealthroid') && handHas(e, 0, 'Steelswarm Sting'), 'Recurring Nightmare: 2 DARK 0-DEF monsters back to the hand');
}

section('Red Screen');
{
  const e = duel(['Red Screen']);
  playTrap(e, 0, 'Red Screen');
  endTurn(e);
  check(e.player(0).lp === 3000, 'Red Screen: 1000 LP in your End Phase');
  const m = place(e, 1, FILL);
  toBattle(e);
  check(!e.canAttackWith(1, m!), "Red Screen: the opponent's monsters cannot attack");
  const e2 = duel(['Red Screen', 'Red Dragon Archfiend', 'Test Tuner One']);
  const rs = playTrap(e2, 0, 'Red Screen');
  toGy(e2, 0, 'Test Tuner One');
  check(!e2.canUseMonsterEffect(0, rs!), 'Red Screen: its last effect needs Red Dragon Archfiend');
  place(e2, 0, 'Red Dragon Archfiend');
  effect(e2, 0, rs);
  check(zone(e2, rs) === 'gy' && !!onField(e2, 0, 'Test Tuner One'), 'Red Screen: destroys itself to Special Summon a Level 1 Tuner');
}

section('Red-Eyes Baby Dragon');
{
  const e = turn2(['Gaia The Fierce Knight'], ['Red-Eyes Baby Dragon', 'Red-Eyes Black Dragon', "Black Dragon's Chick"]);
  const baby = place(e, 1, 'Red-Eyes Baby Dragon');
  const g = place(e, 0, 'Gaia The Fierce Knight');
  toBattle(e);
  attack(e, g, baby, 'yes');
  const red = onField(e, 1, 'Red-Eyes Black Dragon');
  check(!!red && zone(e, baby) === 'sz' && atk(e, red) === 2700, 'Red-Eyes Baby Dragon: Special Summons a Red-Eyes from the Deck and equips to it (+300 ATK)');
  kill(e, [red], undefined, 'yes');
  check(handHas(e, 1, "Black Dragon's Chick"), 'Red-Eyes Baby Dragon: sent to the GY while equipped, adds a Level 1 Dragon');
}

section('Red-Eyes Darkness Dragon');
{
  const e = duel(['Red-Eyes Black Dragon', 'Red-Eyes Darkness Dragon', 'Monster Reborn']);
  place(e, 0, 'Red-Eyes Black Dragon');
  const d = grab(e, 0, 'Red-Eyes Darkness Dragon');
  e.apply({ type: 'SPECIAL', player: 0, uid: d.uid });
  settle(e);
  const m = e.fieldCard(d.uid);
  check(!!m && gyHas(e, 0, 'Red-Eyes Black Dragon') && atk(e, m) === 2700, 'Red-Eyes Darkness Dragon: Summoned by Tributing Red-Eyes B. Dragon, +300 per Dragon in the GY');
  kill(e, [m]);
  act(e, 0, grab(e, 0, 'Monster Reborn').uid, { pick: ['Red-Eyes Darkness Dragon'] }, 'yes');
  check(zone(e, d) === 'gy', 'Red-Eyes Darkness Dragon: cannot be Special Summoned by other ways');
}

section('Red-Eyes Spirit');
{
  const e = duel(['Red-Eyes Black Dragon', 'Red-Eyes Spirit']);
  toGy(e, 0, 'Red-Eyes Black Dragon');
  playTrap(e, 0, 'Red-Eyes Spirit');
  check(!!onField(e, 0, 'Red-Eyes Black Dragon'), 'Red-Eyes Spirit: revives a "Red-Eyes" monster');
}

section('Reflect Bounder');
{
  const e = turn2([], ['Reflect Bounder']);
  const b = place(e, 1, 'Reflect Bounder');
  const a = place(e, 0, FILL);
  toBattle(e);
  attack(e, a, b);
  check(e.player(0).lp === 4000 - 1400 - 300 && zone(e, b) === 'gy', "Reflect Bounder: damage equal to the attacker's ATK, then it is destroyed");
}

section('Regenerating Mummy');
{
  const e = duel(['Regenerating Mummy']);
  const m = grab(e, 0, 'Regenerating Mummy');
  run(e, e.as(1, e.discard(0, m.uid)));
  check(zone(e, m) === 'hand', "Regenerating Mummy: discarded by the opponent's effect, it returns to the hand");
  run(e, e.discard(0, m.uid));
  check(zone(e, m) === 'gy', 'Regenerating Mummy: not when you discard it yourself');
}

section('Reign-Beaux, Overlord of Dark World');
{
  const e = duel(['Reign-Beaux, Overlord of Dark World']);
  place(e, 1, FILL);
  const r = grab(e, 0, 'Reign-Beaux, Overlord of Dark World');
  run(e, e.as(1, e.discard(0, r.uid)), { pick: ['Destroy all monsters your opponent controls'] });
  check(!!e.fieldCard(r.uid) && e.monsters(1).length === 0, "Reign-Beaux: discarded by the opponent, it is Special Summoned and destroys the opponent's monsters");
}

section('Release Restraint');
{
  const e = duel(['Gearfried the Iron Knight', 'Gearfried the Swordmaster', 'Release Restraint']);
  place(e, 0, 'Gearfried the Iron Knight');
  playSpell(e, 0, 'Release Restraint');
  check(!!onField(e, 0, 'Gearfried the Swordmaster') && gyHas(e, 0, 'Gearfried the Iron Knight'), 'Release Restraint: Tributes the Iron Knight for the Swordmaster');
}

section('Rescueroid');
{
  const e = duel(['Rescueroid', 'Cycroid'], ['Gaia The Fierce Knight']);
  place(e, 0, 'Rescueroid');
  const c = place(e, 0, 'Cycroid');
  endTurn(e);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  toBattle(e);
  attack(e, g, c, { respond: 'Rescueroid' });
  check(zone(e, c) === 'hand', 'Rescueroid: the "roid" destroyed by battle returns to the hand');
}

section('Resonance Insect');
{
  const e = duel(['Resonance Insect', 'Hercules Beetle', 'Basic Insect']);
  const r = place(e, 0, 'Resonance Insect');
  kill(e, [r], undefined, 'yes');
  check(handHas(e, 0, 'Hercules Beetle'), 'Resonance Insect: sent from the field to the GY, adds a Level 5+ Insect');
  run(e, (function* () {
    e.banish(r!.uid);
  })(), 'yes');
  check(zone(e, r) === 'removed' && gyHas(e, 0, 'Basic Insect'), 'Resonance Insect: banished, sends an Insect from the Deck to the GY');
}

section('Reversible Beetle');
{
  const e = duel(['Reversible Beetle']);
  const opp = [place(e, 1, FILL), place(e, 1, FILL), place(e, 1, FILL)];
  const b = summon(e, 0, 'Reversible Beetle');
  check(e.find(b!.uid)?.loc.index === 0 && !b!.faceUp && !opp[2]!.faceUp && opp[0]!.faceUp && opp[1]!.faceUp, 'Reversible Beetle: it and the facing monster in its column go face-down');
  const e2 = duel(['Reversible Beetle']);
  const opp2 = [place(e2, 1, FILL), place(e2, 1, FILL), place(e2, 1, FILL)];
  const b2 = place(e2, 0, 'Reversible Beetle', 'def', false);
  e2.apply({ type: 'FLIP_SUMMON', player: 0, uid: b2!.uid });
  settle(e2);
  check(zone(e2, b2) === 'deck' && zone(e2, opp2[2]) === 'deck' && zone(e2, opp2[0]) === 'mz', 'Reversible Beetle: FLIP, it and the face-up monsters in its column are shuffled into the Deck');
}

section('Revival Jam');
{
  const e = duel(['Revival Jam'], ['Gaia The Fierce Knight']);
  const j = place(e, 0, 'Revival Jam');
  endTurn(e);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  toBattle(e);
  attack(e, g, j, 'yes');
  check(zone(e, j) === 'gy' && e.player(0).lp === 4000 - 800 - 1000, 'Revival Jam: destroyed by battle, its controller pays 1000 LP');
  endTurn(e);
  const back = e.fieldCard(j!.uid);
  check(!!back && back.faceUp && back.pos === 'def', 'Revival Jam: back in face-up Defense Position in the next Standby Phase');
}

section('Riryoku Field');
{
  const e = duel(['Riryoku Field'], ['Shield Crush'], [], [], 1);
  const m = place(e, 0, FILL, 'def');
  putST(e, 0, 'Riryoku Field');
  playSpell(e, 1, 'Shield Crush', { respond: 'Riryoku Field' });
  check(!!e.fieldCard(m!.uid) && gyHas(e, 1, 'Shield Crush') && gyHas(e, 0, 'Riryoku Field'), 'Riryoku Field: negates the Spell that targets 1 monster');
}

section('Rising Energy');
{
  const e = duel(['Rising Energy']);
  const m = place(e, 0, FILL);
  const h = e.player(0).hand.length;
  playTrap(e, 0, 'Rising Energy');
  check(atk(e, m) === 2900 && e.player(0).hand.length === h - 1, 'Rising Energy: discards 1 card, +1500 ATK');
}

section('Rite of Spirit');
{
  const e = duel(["Gravekeeper's Assailant", 'Rite of Spirit'], ['Necrovalley']);
  putActive(e, 1, 'Necrovalley');
  toGy(e, 0, "Gravekeeper's Assailant");
  check(!place(e, 0, "Gravekeeper's Assailant"), 'Rite of Spirit: setup, Necrovalley keeps the GY locked');
  playTrap(e, 0, 'Rite of Spirit');
  check(!!onField(e, 0, "Gravekeeper's Assailant"), 'Rite of Spirit: revives a "Gravekeeper\'s" monster, unaffected by Necrovalley');
}

section('Ritual Beast Tamer Zefrawendi');
{
  const e = duel(['Ritual Beast Tamer Zefrawendi', 'Ritual Beast Tamer Zefrawendi']);
  const a = place(e, 0, 'Ritual Beast Tamer Zefrawendi');
  const b = place(e, 0, 'Ritual Beast Tamer Zefrawendi');
  check(!!a && !b, 'Ritual Beast Tamer Zefrawendi: only one Special Summon of it per turn');
}

section('Ritual Weapon');
{
  const e = duel(['Performance of Sword', 'Ritual Weapon']);
  const m = place(e, 0, 'Performance of Sword');
  playSpell(e, 0, 'Ritual Weapon');
  const i = e.info('Performance of Sword');
  check(atk(e, m) === i.atk! + 1500 && e.defOf(m!) === i.def! + 1500, 'Ritual Weapon: a Level 6 Ritual Monster gains 1500 ATK/DEF');
}

section("Robbin' Zombie");
{
  const e = turn2(["Robbin' Zombie"]);
  playTrap(e, 0, "Robbin' Zombie");
  const a = place(e, 0, FILL);
  const n = e.player(1).gy.length;
  toBattle(e);
  attack(e, a, null);
  check(e.player(1).gy.length === n + 1, "Robbin' Zombie: battle damage mills the top card of the opponent's Deck");
}

section('Rock Bombardment');
{
  const e = duel(['Giant Soldier of Stone', 'Rock Bombardment']);
  playTrap(e, 0, 'Rock Bombardment');
  check(gyHas(e, 0, 'Giant Soldier of Stone') && e.player(1).lp === 3500, 'Rock Bombardment: a Rock monster to the GY, 500 damage');
}

section('Rocket Warrior');
{
  const e = turn2(['Rocket Warrior'], ['Gaia The Fierce Knight']);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  const r = place(e, 0, 'Rocket Warrior');
  toBattle(e);
  attack(e, r, g);
  check(!!e.fieldCard(r!.uid) && e.player(0).lp === 4000 && atk(e, g) === 1800, 'Rocket Warrior: survives, no damage, the target loses 500 ATK');
}

section('Rope of Life');
{
  const e = duel(['Rope of Life'], ['Gaia The Fierce Knight']);
  const m = place(e, 0, FILL);
  putST(e, 0, 'Rope of Life');
  endTurn(e);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  toBattle(e);
  attack(e, g, m, { respond: 'Rope of Life' });
  const back = e.fieldCard(m!.uid);
  check(!!back && atk(e, back) === 2200 && e.player(0).hand.length === 0, 'Rope of Life: discards the hand, revives the monster with +800 ATK');
}

section('Roulette Spider');
{
  const e = duel(['Roulette Spider'], ['Gaia The Fierce Knight']);
  putST(e, 0, 'Roulette Spider');
  endTurn(e);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  toBattle(e);
  setRoll(e, 6);
  attack(e, g, null, { respond: 'Roulette Spider' });
  check(zone(e, g) === 'gy' && e.player(0).lp === 4000, 'Roulette Spider: a 6 destroys the attacker');
  const e2 = duel(['Roulette Spider'], ['Gaia The Fierce Knight']);
  putST(e2, 0, 'Roulette Spider');
  endTurn(e2);
  const g2 = place(e2, 1, 'Gaia The Fierce Knight');
  toBattle(e2);
  setRoll(e2, 5);
  attack(e2, g2, null, { respond: 'Roulette Spider' });
  check(e2.player(0).lp === 4000 && e2.player(1).lp === 4000 - 2300, "Roulette Spider: a 5 negates the attack and burns for the attacker's ATK");
}

section('Royal Firestorm Guards');
{
  const e = duel(['Royal Firestorm Guards', 'Spirit of Flames', 'Spirit of Flames', 'Spirit of Flames', 'Spirit of Flames']);
  for (let i = 0; i < 4; i++) toGy(e, 0, 'Spirit of Flames');
  grab(e, 0, 'Royal Firestorm Guards');
  const h = e.player(0).hand.length;
  summon(e, 0, 'Royal Firestorm Guards');
  check(!gyHas(e, 0, 'Spirit of Flames') && e.player(0).hand.length === h - 1 + 2, 'Royal Firestorm Guards: 4 Pyros back into the Deck, draw 2');
}

section('Ryu Kokki');
{
  const e = turn2(['Ryu Kokki']);
  const w = place(e, 1, FILL, 'def');
  w!.defMod = 2000;
  const k = place(e, 0, 'Ryu Kokki');
  toBattle(e);
  attack(e, k, w);
  check(zone(e, w) === 'gy' && !!e.fieldCard(k!.uid), 'Ryu Kokki: the Warrior it battled is destroyed at the end of the Damage Step');
}

section('Ryu Senshi');
{
  const e = duel([], ['Shield Crush'], ['Ryu Senshi'], [], 1);
  const r = place(e, 0, 'Ryu Senshi', 'def');
  playSpell(e, 1, 'Shield Crush');
  check(!!e.fieldCard(r!.uid) && gyHas(e, 1, 'Shield Crush'), 'Ryu Senshi: a Spell that targets it is negated and destroyed');
  const e2 = duel([], ['Shield Spear'], ['Ryu Senshi'], [], 1);
  place(e2, 0, 'Ryu Senshi');
  const c = place(e2, 1, FILL);
  playTrap(e2, 1, 'Shield Spear', { pick: [FILL] }, { respond: 'Ryu Senshi' });
  check(e2.player(0).lp === 3000 && atk(e2, c) === 1400, 'Ryu Senshi: pays 1000 LP to negate a Normal Trap');
}

section('Ryu-Kishin Clown');
{
  const e = duel(['Ryu-Kishin Clown'], ['Gaia The Fierce Knight']);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  summon(e, 0, 'Ryu-Kishin Clown', true, { pick: ['Gaia The Fierce Knight'] });
  check(g!.pos === 'def', 'Ryu-Kishin Clown: changes the battle position of a face-up monster when Summoned');
}

// ================= S (SPYRAL ... Shrink) =================
section('SPYRAL GEAR - Big Red');
{
  const e = duel(['SPYRAL GEAR - Drone', 'SPYRAL GEAR - Big Red']);
  const d = toGy(e, 0, 'SPYRAL GEAR - Drone');
  const br = playSpell(e, 0, 'SPYRAL GEAR - Big Red');
  const m = e.fieldCard(d.uid);
  check(!!m && !!br && m.equips.includes(br.uid) && e.shielded(m, 'battle'), 'SPYRAL GEAR - Big Red: revives a "SPYRAL" monster, equipped; it cannot be destroyed by battle');
}

section('SPYRAL GEAR - Drone');
{
  const e = duel(['SPYRAL GEAR - Drone', 'SPYRAL GEAR - Drone'], ['Gaia The Fierce Knight', 'Baby Dragon', 'Hyozanryu']);
  summon(e, 0, 'SPYRAL GEAR - Drone', true, 'yes', { pick: ['Hyozanryu'] }, { pick: ['Baby Dragon'] });
  check(e.player(1).deck.slice(0, 3).map((c) => c.name).join() === 'Hyozanryu,Baby Dragon,Gaia The Fierce Knight', "SPYRAL GEAR - Drone: rearranges the top 3 cards of the opponent's Deck");
  const d1 = e.monsters(0)[0];
  const d2 = place(e, 0, 'SPYRAL GEAR - Drone');
  place(e, 1, FILL);
  place(e, 1, FILL);
  e.apply({ type: 'QUICK_EFFECT', player: 0, uid: d1.uid });
  settle(e);
  check(zone(e, d1) === 'gy' && atk(e, d2) === 100 + 1000, 'SPYRAL GEAR - Drone: Tributed, a "SPYRAL" monster gains 500 ATK per opponent card');
  const e2 = duel(['SPYRAL GEAR - Drone', 'SPYRAL Super Agent', 'SPYRAL GEAR - Big Red']);
  const dr = toGy(e2, 0, 'SPYRAL GEAR - Drone');
  const ag = toGy(e2, 0, 'SPYRAL Super Agent');
  const br = toGy(e2, 0, 'SPYRAL GEAR - Big Red');
  graveEffect(e2, 0, dr);
  check(zone(e2, ag) === 'hand' && zone(e2, dr) === 'removed' && zone(e2, br) === 'removed', 'SPYRAL GEAR - Drone: banished with a "SPYRAL" card to add SPYRAL Super Agent');
}

section('SPYRAL MISSION - Assault');
{
  const e = turn2(['SPYRAL MISSION - Assault', 'SPYRAL GEAR - Drone']);
  const t = place(e, 1, FILL);
  const as = playSpell(e, 0, 'SPYRAL MISSION - Assault');
  const d = place(e, 0, 'SPYRAL GEAR - Drone');
  d!.atkMod = 3000;
  const h = e.player(0).hand.length;
  toBattle(e);
  attack(e, d, t, { respond: 'SPYRAL MISSION - Assault' });
  check(zone(e, t) === 'gy' && e.player(0).hand.length === h + 1, 'SPYRAL MISSION - Assault: a "SPYRAL" monster destroys a monster by battle, draw 1');
  for (let i = 0; i < 4; i++) endTurn(e);
  check(active(e, as), 'SPYRAL MISSION - Assault: still there after 2 of your End Phases');
  endTurn(e);
  check(zone(e, as) === 'gy', 'SPYRAL MISSION - Assault: destroyed in your 3rd End Phase after activation');
  const e2 = duel(['SPYRAL MISSION - Assault', 'SPYRAL GEAR - Drone']);
  const a2 = toGy(e2, 0, 'SPYRAL MISSION - Assault');
  const d2 = grab(e2, 0, 'SPYRAL GEAR - Drone');
  graveEffect(e2, 0, a2);
  check(zone(e2, a2) === 'removed' && !!e2.fieldCard(d2.uid), 'SPYRAL MISSION - Assault: banished from the GY to Special Summon a "SPYRAL" monster from the hand');
}

section('SPYRAL Resort');
{
  const e = duel(['SPYRAL Resort', 'SPYRAL GEAR - Drone']);
  const r = putActive(e, 0, 'SPYRAL Resort');
  effect(e, 0, r);
  check(handHas(e, 0, 'SPYRAL GEAR - Drone'), 'SPYRAL Resort: adds a "SPYRAL" monster from the Deck');
  const d = place(e, 0, 'SPYRAL GEAR - Drone');
  e.actor = 1;
  const shielded = e.untargetable(d!);
  e.actor = 0;
  check(shielded && !e.untargetable(d!), 'SPYRAL Resort: the opponent cannot target the other "SPYRAL" cards');
  endTurn(e);
  check(zone(e, r) === 'gy', 'SPYRAL Resort: destroyed in your End Phase when no monster can be shuffled from the GY');
  const e2 = duel(['SPYRAL Resort']);
  const r2 = putActive(e2, 0, 'SPYRAL Resort');
  const f = toGy(e2, 0, FILL);
  endTurn(e2);
  check(!!e2.fieldCard(r2.uid) && zone(e2, f) === 'deck', 'SPYRAL Resort: or shuffles a monster from the GY into the Deck');
}

section("Sabatiel - The Philosopher's Stone");
{
  const e = duel(['Winged Kuriboh', 'Polymerization', "Sabatiel - The Philosopher's Stone"]);
  toGy(e, 0, 'Winged Kuriboh');
  playSpell(e, 0, "Sabatiel - The Philosopher's Stone");
  check(e.player(0).lp === 2000 && handHas(e, 0, 'Polymerization'), 'Sabatiel: pays half the LP to add a Polymerization');
  const S = "Sabatiel - The Philosopher's Stone";
  const e2 = duel([S, S, S], ['Gaia The Fierce Knight']);
  const c = toGy(e2, 0, S);
  toGy(e2, 0, S);
  toGy(e2, 0, S);
  const m = place(e2, 0, FILL);
  place(e2, 1, 'Gaia The Fierce Knight');
  graveEffect(e2, 0, c, { pick: [FILL] });
  check(atk(e2, m) === 1400 + 2300 && e2.player(0).removed.length === 3, 'Sabatiel: 3 copies banished, a monster gains the highest ATK on the field');
}

section("Sage's Stone");
{
  const e = duel(['Dark Magician Girl', 'Dark Magician', "Sage's Stone"]);
  place(e, 0, 'Dark Magician Girl');
  playSpell(e, 0, "Sage's Stone");
  check(!!onField(e, 0, 'Dark Magician'), "Sage's Stone: Special Summons Dark Magician from the Deck");
}

section('Salvage');
{
  const e = duel(['Slushy', 'Aqua Madoor', 'Salvage']);
  toGy(e, 0, 'Slushy');
  toGy(e, 0, 'Aqua Madoor');
  playSpell(e, 0, 'Salvage');
  check(handHas(e, 0, 'Slushy') && handHas(e, 0, 'Aqua Madoor'), 'Salvage: 2 WATER monsters with 1500 or less ATK back to the hand');
}

section('Sand Moth');
{
  const e = duel(['Sand Moth']);
  const m = place(e, 0, 'Sand Moth', 'def', false);
  kill(e, [m], 1);
  const back = e.fieldCard(m!.uid);
  check(!!back && back.faceUp && atk(e, back) === 2000 && e.defOf(back) === 1000, 'Sand Moth: destroyed face-down by an effect, it comes back with ATK and DEF switched');
}

section('Santa Claws');
{
  const e = duel(['Santa Claws']);
  const t = place(e, 1, FILL);
  const s = grab(e, 0, 'Santa Claws');
  e.apply({ type: 'SPECIAL', player: 0, uid: s.uid });
  settle(e);
  const m = e.fieldCard(s.uid);
  check(zone(e, t) === 'gy' && !!m && e.controller(s.uid) === 1 && m.pos === 'def', "Santa Claws: Tributes an opponent's monster to go to their field in Defense Position");
  const h = e.player(0).hand.length;
  endTurn(e, 'yes');
  check(e.player(0).hand.length === h + 1, 'Santa Claws: draw 1 in the End Phase');
}

section('Sasuke Samurai');
{
  const e = turn2(['Sasuke Samurai']);
  const t = place(e, 1, FILL, 'def', false);
  t!.defMod = 3000;
  const s = place(e, 0, 'Sasuke Samurai');
  toBattle(e);
  attack(e, s, t);
  check(zone(e, t) === 'gy' && e.player(0).lp === 4000 && !logHas(e, 'flipped face-up'), 'Sasuke Samurai: destroys the face-down monster it attacks before it is flipped');
}

section('Satellarknight Zefrathuban');
{
  const e = duel(['Ritual Beast Tamer Zefrawendi', 'Satellarknight Zefrathuban']);
  const z = place(e, 0, 'Ritual Beast Tamer Zefrawendi');
  const t = place(e, 1, FILL);
  summon(e, 0, 'Satellarknight Zefrathuban', true, 'yes');
  check(zone(e, z) === 'gy' && zone(e, t) === 'gy', 'Satellarknight Zefrathuban: destroys 1 of your "Zefra" cards and 1 face-up opponent card');
}

section('Scrum Force');
{
  const e = duel(['Scrum Force', 'Shield Spear']);
  const sf = playTrap(e, 0, 'Scrum Force');
  const a = place(e, 0, FILL, 'def');
  place(e, 0, FILL, 'def');
  e.actor = 1;
  const safe = e.untargetable(a!);
  e.actor = 0;
  kill(e, [a], 1);
  check(safe && !!e.fieldCard(a!.uid), "Scrum Force: with 2 face-up Defense Position monsters, they cannot be targeted or destroyed by the opponent's effects");
  const sub = putST(e, 0, 'Shield Spear');
  kill(e, [sf], 1);
  check(!!e.fieldCard(sf!.uid) && zone(e, sub) === 'gy', 'Scrum Force: another card in your Spell & Trap Zone is destroyed instead');
}

section('Sea Koala');
{
  const e = duel(['Sea Koala', 'Dark Rabbit'], ['Gaia The Fierce Knight']);
  const k = place(e, 0, 'Sea Koala');
  const g = place(e, 1, 'Gaia The Fierce Knight');
  check(!e.canUseMonsterEffect(0, k!), 'Sea Koala: needs another Beast');
  place(e, 0, 'Dark Rabbit');
  effect(e, 0, k);
  check(atk(e, g) === 0, "Sea Koala: an opponent's monster's ATK becomes 0");
}

section('Sealing Ceremony of Mokuton');
{
  const e = duel(['Sealing Ceremony of Mokuton']);
  const s = playTrap(e, 0, 'Sealing Ceremony of Mokuton');
  const m = place(e, 0, FILL);
  toGy(e, 1, FILL);
  toGy(e, 1, FILL);
  effect(e, 0, s, { pick: [FILL] }, { pick: [FILL, FILL] });
  check(zone(e, m) === 'gy' && e.player(1).removed.length === 2, "Sealing Ceremony of Mokuton: Tributes an EARTH monster to banish 2 cards from the opponent's GY");
}

section('Sealing Ceremony of Suiton');
{
  const e = duel(['Sealing Ceremony of Suiton', 'Slushy']);
  const s = playTrap(e, 0, 'Sealing Ceremony of Suiton');
  grab(e, 0, 'Slushy');
  toGy(e, 1, FILL);
  effect(e, 0, s);
  check(gyHas(e, 0, 'Slushy') && e.player(1).removed.length === 1, "Sealing Ceremony of Suiton: a WATER monster from the hand to banish 1 card from the opponent's GY");
}

section('Security Orb');
{
  const e = duel(['Security Orb'], ['Gaia The Fierce Knight']);
  putST(e, 0, 'Security Orb');
  endTurn(e);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  toBattle(e);
  attack(e, g, null, { respond: 'Security Orb' });
  check(g!.pos === 'def' && e.player(0).lp === 4000, "Security Orb: the attacker's battle position changes (the attack stops)");
  const e2 = duel(['Security Orb'], ['Mystical Space Typhoon', 'Gaia The Fierce Knight'], [], [], 1);
  putST(e2, 0, 'Security Orb');
  const g2 = place(e2, 1, 'Gaia The Fierce Knight');
  playSpell(e2, 1, 'Mystical Space Typhoon');
  check(gyHas(e2, 0, 'Security Orb') && zone(e2, g2) === 'gy', "Security Orb: Set and destroyed by the opponent's Spell, it destroys 1 monster");
}

section('Shadowknight Archfiend');
{
  const e = turn2(['Shadowknight Archfiend']);
  const s = place(e, 0, 'Shadowknight Archfiend');
  toBattle(e);
  attack(e, s, null);
  check(e.player(1).lp === 3000, 'Shadowknight Archfiend: its battle damage is halved');
  endTurn(e);
  endTurn(e);
  check(e.player(0).lp === 3100, 'Shadowknight Archfiend: 900 LP in your Standby Phase');
  const e2 = duel([], ['Shield Crush', 'Shield Crush'], [], [], 1);
  const s2 = putMZ(e2, 0, FILL, 'def');
  s2.name = 'Shadowknight Archfiend';
  setRoll(e2, 3);
  playSpell(e2, 1, 'Shield Crush');
  check(!!e2.fieldCard(s2.uid) && gyHas(e2, 1, 'Shield Crush'), 'Shadowknight Archfiend: a 3 negates the targeting effect');
  setRoll(e2, 4);
  playSpell(e2, 1, 'Shield Crush');
  check(!e2.fieldCard(s2.uid), 'Shadowknight Archfiend: any other result does not');
}

section('Shard of Greed');
{
  const e = duel(['Shard of Greed']);
  const s = playSpell(e, 0, 'Shard of Greed');
  for (let i = 0; i < 4; i++) endTurn(e);
  check(s!.counters === 2, 'Shard of Greed: a Greed Counter for each normal draw');
  const h = e.player(0).hand.length;
  effect(e, 0, s);
  check(zone(e, s) === 'gy' && e.player(0).hand.length === h + 2, 'Shard of Greed: sent to the GY with 2 counters, draw 2');
}

section('Shield Crush');
{
  const e = duel(['Shield Crush']);
  const t = place(e, 1, FILL, 'def');
  playSpell(e, 0, 'Shield Crush');
  check(zone(e, t) === 'gy', 'Shield Crush: destroys a Defense Position monster');
}

section('Shield Spear');
{
  const e = duel(['Shield Spear']);
  const m = place(e, 0, FILL);
  playTrap(e, 0, 'Shield Spear');
  check(atk(e, m) === 1800 && e.defOf(m!) === 1600, 'Shield Spear: +400 ATK/DEF');
}

section('Shinobird Pigeon');
{
  const e = duel(['Shinobird Pigeon', 'Shinobird Pigeon'], ['Asura Priest']);
  check(!place(e, 0, 'Shinobird Pigeon'), 'Shinobird Pigeon: cannot be Special Summoned');
  const a = putMZ(e, 1, 'Asura Priest');
  const p = summon(e, 0, 'Shinobird Pigeon');
  effect(e, 0, p);
  check(zone(e, a) === 'hand', 'Shinobird Pigeon: returns a Spirit monster to the hand');
  endTurn(e);
  check(zone(e, p) === 'hand', 'Shinobird Pigeon: Normal Summoned this turn, it returns to the hand in the End Phase');
}

section('Shore Knight');
{
  const e = duel(['Shore Knight', 'Aqua Madoor']);
  const k = place(e, 0, 'Shore Knight');
  k!.placedTurn = -1;
  e.apply({ type: 'CHANGE_POS', player: 0, uid: k!.uid });
  settle(e);
  check(k!.pos === 'def' && gyHas(e, 0, 'Aqua Madoor'), 'Shore Knight: its position changes, a WATER monster from the Deck to the GY');
}

section('Shrink');
{
  const e = duel(['Shrink'], ['Gaia The Fierce Knight']);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  playSpell(e, 0, 'Shrink');
  check(atk(e, g) === 1150, 'Shrink: original ATK halved');
}

// ================= S (Silent Doom ... Swing of Memories), T =================
section('Silent Doom');
{
  const e = duel(['Gaia The Fierce Knight', 'Silent Doom']);
  toGy(e, 0, 'Gaia The Fierce Knight');
  playSpell(e, 0, 'Silent Doom');
  const g = onField(e, 0, 'Gaia The Fierce Knight');
  check(!!g && g.pos === 'def' && g.faceUp && g.cannotAttack === true, 'Silent Doom: a Normal Monster back in face-up Defense Position; it cannot attack');
}

section('Skill Successor');
{
  const e = duel(['Skill Successor']);
  const m = place(e, 0, FILL);
  playTrap(e, 0, 'Skill Successor');
  check(atk(e, m) === 1800, 'Skill Successor: +400 ATK');
  const card = e.player(0).gy.find((c) => c.name === 'Skill Successor')!;
  check(!e.canUseGraveEffect(0, card.uid), 'Skill Successor: not the turn it was sent to the GY');
  endTurn(e);
  endTurn(e);
  graveEffect(e, 0, card);
  check(atk(e, m) === 2200 && zone(e, card) === 'removed', 'Skill Successor: banished from the GY, +800 ATK');
}

section('Skilled Blue Magician');
{
  const A = "Summoner's Art";
  const G = 'Gaia The Fierce Knight';
  const e = duel(['Skilled Blue Magician', A, A, A, A, G, G, G, G, 'Skilled Red Magician']);
  const b = place(e, 0, 'Skilled Blue Magician');
  for (let i = 0; i < 2; i++) playSpell(e, 0, A);
  check(b!.counters === 2, 'Skilled Blue Magician: a Spell Counter each time a Spell resolves');
  for (let i = 0; i < 2; i++) playSpell(e, 0, A);
  check(b!.counters === 3, 'Skilled Blue Magician: max. 3');
  effect(e, 0, b);
  check(zone(e, b) === 'gy' && !!onField(e, 0, G), 'Skilled Blue Magician: Tributed with 3 counters for a "Gaia The Fierce Knight" monster');
  const r = place(e, 0, 'Skilled Red Magician');
  graveEffect(e, 0, b!);
  check(zone(e, b) === 'removed' && r!.counters === 1, 'Skilled Blue Magician: banished from the GY, a Spell Counter on a card you control');
}

section('Skilled Dark Magician');
{
  const e = duel(['Skilled Dark Magician', 'Dark Magician']);
  const m = place(e, 0, 'Skilled Dark Magician');
  m!.counters = 3;
  effect(e, 0, m);
  check(zone(e, m) === 'gy' && !!onField(e, 0, 'Dark Magician'), 'Skilled Dark Magician: Tributed with 3 counters for Dark Magician');
}

section('Skilled Red Magician');
{
  const e = duel(['Skilled Red Magician', 'Archfiend Soldier', 'Skilled White Magician']);
  const m = place(e, 0, 'Skilled Red Magician');
  m!.counters = 3;
  effect(e, 0, m);
  check(zone(e, m) === 'gy' && !!onField(e, 0, 'Archfiend Soldier'), 'Skilled Red Magician: Tributed with 3 counters for an "Archfiend" monster');
  const w = place(e, 0, 'Skilled White Magician');
  graveEffect(e, 0, m!);
  check(zone(e, m) === 'removed' && w!.counters === 1, 'Skilled Red Magician: banished from the GY, a Spell Counter on a card you control');
}

section('Skilled White Magician');
{
  const e = duel(['Skilled White Magician', 'Buster Blader']);
  const m = place(e, 0, 'Skilled White Magician');
  m!.counters = 3;
  effect(e, 0, m);
  check(zone(e, m) === 'gy' && !!onField(e, 0, 'Buster Blader'), 'Skilled White Magician: Tributed with 3 counters for Buster Blader');
}

section('Skreech');
{
  const e = duel(['Skreech', 'Aqua Madoor', 'Slushy'], ['Gaia The Fierce Knight']);
  const s = place(e, 0, 'Skreech');
  endTurn(e);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  toBattle(e);
  attack(e, g, s);
  check(gyHas(e, 0, 'Aqua Madoor') && gyHas(e, 0, 'Slushy'), 'Skreech: destroyed by battle, 2 WATER monsters from the Deck to the GY');
}

section('Skull Archfiend of Lightning');
{
  const e = turn2(['Skull Archfiend of Lightning']);
  place(e, 0, 'Skull Archfiend of Lightning');
  endTurn(e);
  endTurn(e);
  check(e.player(0).lp === 3500, 'Skull Archfiend of Lightning: 500 LP in your Standby Phase');
  const e2 = duel([], ['Shield Crush'], [], [], 1);
  const s2 = putMZ(e2, 0, FILL, 'def');
  s2.name = 'Skull Archfiend of Lightning';
  setRoll(e2, 6);
  playSpell(e2, 1, 'Shield Crush');
  check(!!e2.fieldCard(s2.uid) && gyHas(e2, 1, 'Shield Crush'), 'Skull Archfiend of Lightning: a 6 negates the targeting effect and destroys that card');
}

section('Skyscraper');
{
  const e = turn2(['Skyscraper', 'Elemental HERO Sparkman'], ['Gaia The Fierce Knight']);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  playSpell(e, 0, 'Skyscraper');
  const s = place(e, 0, 'Elemental HERO Sparkman');
  toBattle(e);
  attack(e, s, g);
  check(zone(e, g) === 'gy' && !!e.fieldCard(s!.uid) && e.player(1).lp === 3700, 'Skyscraper: the "Elemental HERO" gains 1000 ATK attacking a stronger monster');
}

section('Skyscraper 2 - Hero City');
{
  const e = turn2(['Elemental HERO Sparkman', 'Skyscraper 2 - Hero City', 'Elemental HERO Avian'], ['Gaia The Fierce Knight']);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  const s = place(e, 0, 'Elemental HERO Sparkman');
  toGy(e, 0, 'Elemental HERO Avian');
  toBattle(e);
  attack(e, s, g);
  endTurn(e);
  endTurn(e);
  const hc = playSpell(e, 0, 'Skyscraper 2 - Hero City');
  effect(e, 0, hc, { pick: ['Elemental HERO Sparkman'] });
  check(!!e.fieldCard(s!.uid) && gyHas(e, 0, 'Elemental HERO Avian'), 'Skyscraper 2 - Hero City: revives an "Elemental HERO" destroyed by battle (not one sent otherwise)');
}

section('Slushy');
{
  const e = duel(['Slushy', 'Slushy', 'Slushy', 'Kairyu-Shin']);
  summon(e, 0, 'Slushy', true, 'yes');
  check(e.player(0).gy.filter((c) => c.name === 'Slushy').length === 1, 'Slushy: Normal Summoned, sends a Slushy from the Deck to the GY');
  const e2 = duel(['Slushy', 'Slushy', 'Slushy', 'Kairyu-Shin']);
  const s = toGy(e2, 0, 'Slushy');
  toGy(e2, 0, 'Slushy');
  toGy(e2, 0, 'Slushy');
  toGy(e2, 0, 'Kairyu-Shin');
  graveEffect(e2, 0, s);
  check(zone(e2, s) === 'removed' && !!onField(e2, 0, 'Kairyu-Shin'), 'Slushy: 3 Slushy, banished to revive a Level 5+ Sea Serpent');
}

section("Snake Deity's Command");
{
  const e = duel(['Venom Test Serpent', "Snake Deity's Command"], ['Shield Crush'], [], [], 1);
  const m = place(e, 0, FILL, 'def');
  grab(e, 0, 'Venom Test Serpent');
  putST(e, 0, "Snake Deity's Command");
  playSpell(e, 1, 'Shield Crush', { respond: "Snake Deity's Command" });
  check(!!e.fieldCard(m!.uid) && gyHas(e, 0, "Snake Deity's Command"), "Snake Deity's Command: showing a \"Venom\" monster negates the opponent's Spell");
}

section('Snake Rain');
{
  const e = duel(['Gagagigo', 'Gagagigo', 'Gagagigo', 'Gagagigo', 'Snake Rain']);
  playSpell(e, 0, 'Snake Rain');
  check(e.player(0).gy.filter((c) => c.name === 'Gagagigo').length === 4, 'Snake Rain: discards 1, sends 4 Reptiles from the Deck to the GY');
}

section('Solemn Wishes');
{
  const e = duel(['Solemn Wishes']);
  playTrap(e, 0, 'Solemn Wishes');
  e.draw(0, 1);
  check(e.player(0).lp === 4500, 'Solemn Wishes: 500 LP for a draw');
  endTurn(e);
  endTurn(e);
  check(e.player(0).lp === 5000, 'Solemn Wishes: 500 LP for the normal draw');
}

section('Solitary Sword of Poison');
{
  const e = turn2(['Solitary Sword of Poison'], ['Gaia The Fierce Knight']);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  const m = place(e, 0, FILL);
  const sw = playSpell(e, 0, 'Solitary Sword of Poison');
  check(!!sw && m!.equips.includes(sw.uid) && atk(e, m) === 1400, 'Solitary Sword of Poison: equipped; no change outside battle');
  toBattle(e);
  attack(e, m, g);
  check(zone(e, g) === 'gy' && e.player(1).lp === 4000 - 500, 'Solitary Sword of Poison: original ATK doubled in battle with an opponent monster');
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  settle(e);
  place(e, 0, FILL);
  check(zone(e, sw) === 'gy', 'Solitary Sword of Poison: sent to the GY once you control another monster');
}

section('Sonic Shooter');
{
  const e = turn2(['Sonic Shooter'], ['Shield Spear']);
  place(e, 1, FILL);
  const s = place(e, 0, 'Sonic Shooter');
  toBattle(e);
  attack(e, s, null);
  check(e.player(1).lp === 2700, "Sonic Shooter: attacks directly when the opponent's Spell & Trap Zone is empty");
  putST(e, 1, 'Shield Spear');
  check(!e.canAttackDirectly(s!), 'Sonic Shooter: not when they have a card there');
}

section('Soul Demolition');
{
  const e = duel(['Soul Demolition', 'Archfiend Soldier', 'Gaia The Fierce Knight']);
  const s = playTrap(e, 0, 'Soul Demolition');
  place(e, 0, 'Archfiend Soldier');
  toGy(e, 0, 'Gaia The Fierce Knight');
  toGy(e, 1, FILL);
  effect(e, 0, s);
  check(e.player(0).lp === 3500 && e.player(0).removed.length === 1 && e.player(1).removed.length === 1, "Soul Demolition: pay 500 LP; each player banishes a monster from the other's GY");
}

section('Spacetime Transcendence');
{
  const e = duel(['Tomozaurus', 'Tomozaurus', 'Uraby', 'Spacetime Transcendence']);
  toGy(e, 0, 'Tomozaurus');
  toGy(e, 0, 'Tomozaurus');
  grab(e, 0, 'Uraby');
  playSpell(e, 0, 'Spacetime Transcendence');
  const u = onField(e, 0, 'Uraby');
  check(!!u && e.player(0).removed.length === 2 && u.tags?.noAttackTurn === e.state.turn, 'Spacetime Transcendence: banishes Dinosaurs (Levels 2+2) to Summon a Level 4 Dinosaur; it cannot attack');
}

section('Spark Blaster');
{
  const e = duel(['Elemental HERO Sparkman', 'Spark Blaster'], ['Gaia The Fierce Knight']);
  place(e, 0, 'Elemental HERO Sparkman');
  const g = place(e, 1, 'Gaia The Fierce Knight');
  const sb = playSpell(e, 0, 'Spark Blaster');
  effect(e, 0, sb, { pick: ['Gaia The Fierce Knight'] });
  check(g!.pos === 'def', 'Spark Blaster: changes the battle position of a monster');
  effect(e, 0, sb, { pick: ['Gaia The Fierce Knight'] });
  effect(e, 0, sb, { pick: ['Gaia The Fierce Knight'] });
  check(zone(e, sb) === 'gy', 'Spark Blaster: destroyed after 3 uses');
}

section('Spear Dragon');
{
  const e = turn2(['Spear Dragon']);
  const t = place(e, 1, FILL, 'def');
  const s = place(e, 0, 'Spear Dragon');
  toBattle(e);
  attack(e, s, t);
  check(e.player(1).lp === 4000 - 700 && s!.pos === 'def', 'Spear Dragon: piercing damage, then it goes to Defense Position');
}

section('Spell Power Grasp');
{
  const e = duel(['Skilled Dark Magician', 'Spell Power Grasp', 'Spell Power Grasp']);
  const m = place(e, 0, 'Skilled Dark Magician');
  playSpell(e, 0, 'Spell Power Grasp', 'yes');
  check(m!.counters === 2 && handHas(e, 0, 'Spell Power Grasp'), 'Spell Power Grasp: a Spell Counter on the target (plus its own for the Spell), then another copy from the Deck');
  const g = e.player(0).hand.find((c) => c.name === 'Spell Power Grasp')!;
  check(!e.canActivateMain(0, g.uid), 'Spell Power Grasp: only 1 activation per turn');
}

section('Spell Purification');
{
  const e = duel(['Spell Purification'], ['Shard of Greed']);
  const s = putActive(e, 1, 'Shard of Greed');
  playTrap(e, 0, 'Spell Purification');
  check(zone(e, s) === 'gy', 'Spell Purification: destroys the face-up Continuous Spells');
}

section('Spell Shattering Arrow');
{
  const e = duel(['Spell Shattering Arrow'], ['Shard of Greed', 'Shard of Greed']);
  putActive(e, 1, 'Shard of Greed');
  putActive(e, 1, 'Shard of Greed');
  playSpell(e, 0, 'Spell Shattering Arrow');
  check(e.player(1).gy.filter((c) => c.name === 'Shard of Greed').length === 2 && e.player(1).lp === 3000, "Spell Shattering Arrow: destroys the opponent's face-up Spells, 500 damage each");
}

section('Spell Striker');
{
  const e = duel(['Shield Crush', 'Spell Striker']);
  const sc = toGy(e, 0, 'Shield Crush');
  const s = grab(e, 0, 'Spell Striker');
  e.apply({ type: 'SPECIAL', player: 0, uid: s.uid });
  settle(e);
  const m = e.fieldCard(s.uid);
  check(!!m && zone(e, sc) === 'removed' && e.canAttackDirectly(m), 'Spell Striker: Special Summoned by banishing a Spell; can attack directly');
}

section('Sphere Kuriboh');
{
  const e = duel(['Sphere Kuriboh'], ['Gaia The Fierce Knight']);
  const k = grab(e, 0, 'Sphere Kuriboh');
  endTurn(e);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  toBattle(e);
  attack(e, g, null, { respond: 'Sphere Kuriboh' });
  check(zone(e, k) === 'gy' && g!.pos === 'def' && e.player(0).lp === 4000, 'Sphere Kuriboh: sent from the hand, the attacker goes to Defense Position');
  check(!!getEffect('Sphere Kuriboh')?.ritualFromGrave, 'Sphere Kuriboh: can be banished from the GY for a Ritual Summon');
}

section('Spider Egg');
{
  const e = duel(['Basic Insect', 'Basic Insect', 'Basic Insect', 'Spider Egg'], ['Gaia The Fierce Knight']);
  for (let i = 0; i < 3; i++) toGy(e, 0, 'Basic Insect');
  putST(e, 0, 'Spider Egg');
  endTurn(e);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  toBattle(e);
  attack(e, g, null, { respond: 'Spider Egg' });
  check(e.player(0).lp === 4000 && e.monsters(0).filter((m) => m.name === 'Spider Token').length === 3, 'Spider Egg: negates the direct attack, 3 Spider Tokens');
}

section('Spirit Ryu');
{
  const e = turn2(['Spirit Ryu', 'Baby Dragon']);
  const t = place(e, 1, FILL);
  const r = place(e, 0, 'Spirit Ryu');
  grab(e, 0, 'Baby Dragon');
  toBattle(e);
  attack(e, r, t, { respond: 'Spirit Ryu' });
  check(gyHas(e, 0, 'Baby Dragon') && atk(e, r) === 2000 && zone(e, t) === 'gy', 'Spirit Ryu: discards a Dragon in battle for +1000 ATK/DEF');
}

section('Spirit of Flames');
{
  const e = turn2(['Flame Manipulator', 'Spirit of Flames']);
  const f = toGy(e, 0, 'Flame Manipulator');
  const s = grab(e, 0, 'Spirit of Flames');
  e.apply({ type: 'SPECIAL', player: 0, uid: s.uid });
  settle(e);
  const m = e.fieldCard(s.uid);
  check(!!m && zone(e, f) === 'removed' && atk(e, m) === 1700, 'Spirit of Flames: Special Summoned by banishing a FIRE monster');
  toBattle(e);
  check(atk(e, m) === 2000, 'Spirit of Flames: +300 ATK during your Battle Phase');
}

section('Spirit of the Pharaoh');
{
  const e = duel(['Spirit of the Pharaoh', 'Skull Servant', 'Skull Servant', 'The First Sarcophagus']);
  check(!place(e, 0, 'Spirit of the Pharaoh'), 'Spirit of the Pharaoh: cannot be Special Summoned by other effects');
  toGy(e, 0, 'Skull Servant');
  toGy(e, 0, 'Skull Servant');
  toGy(e, 0, 'The First Sarcophagus');
  e.state.phase = 'EP';
  const sp = place(e, 0, 'Spirit of the Pharaoh', 'atk', true, { pick: ['Skull Servant', 'Skull Servant'] });
  e.state.phase = 'M1';
  check(!!sp && e.monsters(0).filter((m) => m.name === 'Skull Servant').length === 2, 'Spirit of the Pharaoh: Summoned by The First Sarcophagus, revives Level 2 or lower Zombie Normal Monsters');
}

section('Spiritual Forest');
{
  const e = duel(['Spiritual Forest', 'Dark Rabbit'], ['Gaia The Fierce Knight', 'Blue-Eyes White Dragon']);
  playSpell(e, 0, 'Spiritual Forest');
  const r = place(e, 0, 'Dark Rabbit');
  endTurn(e);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  const b = place(e, 1, 'Blue-Eyes White Dragon');
  toBattle(e);
  attack(e, g, r);
  check(!!e.fieldCard(r!.uid), 'Spiritual Forest: the first Beast that would be destroyed by battle this turn is not');
  attack(e, b, r);
  check(zone(e, r) === 'gy', 'Spiritual Forest: only the first one each turn');
}

section('Stamping Destruction');
{
  const e = duel(['Baby Dragon', 'Stamping Destruction'], ['Shield Spear']);
  place(e, 0, 'Baby Dragon');
  const t = putST(e, 1, 'Shield Spear');
  playSpell(e, 0, 'Stamping Destruction');
  check(zone(e, t) === 'gy' && e.player(1).lp === 3500, 'Stamping Destruction: destroys a Spell/Trap, 500 damage to its controller');
}

section('Statue of the Wicked');
{
  const e = duel(['Statue of the Wicked']);
  const s = putST(e, 0, 'Statue of the Wicked');
  kill(e, [s], 1);
  check(!!onField(e, 0, 'Wicked Token'), 'Statue of the Wicked: destroyed face-down, a Wicked Token');
}

section('Stealthroid');
{
  const e = turn2(['Stealthroid', 'Cycroid'], ['Shield Spear']);
  const t = putST(e, 1, 'Shield Spear');
  const s = place(e, 0, 'Stealthroid');
  place(e, 0, 'Cycroid');
  toBattle(e);
  attack(e, s, null);
  check(!!e.fieldCard(t.uid), 'Stealthroid: setup, nothing destroyed during the Battle Phase');
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  settle(e);
  check(zone(e, t) === 'gy', 'Stealthroid: it attacked, a Spell/Trap is destroyed at the end of the Battle Phase');
}

section('Steamroid');
{
  const e = turn2(['Steamroid'], ['Gaia The Fierce Knight']);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  const s = place(e, 0, 'Steamroid');
  toBattle(e);
  attack(e, s, g);
  check(zone(e, g) === 'gy' && zone(e, s) === 'gy', 'Steamroid: +500 ATK attacking (2300 vs 2300)');
  const e2 = duel(['Steamroid']);
  const s2 = place(e2, 0, 'Steamroid');
  endTurn(e2);
  const a = place(e2, 1, FILL);
  toBattle(e2);
  attack(e2, a, s2);
  check(zone(e2, s2) === 'gy' && e2.player(0).lp === 4000 - 100, 'Steamroid: -500 ATK when attacked (1300 vs 1400)');
}

section('Steelswarm Sting');
{
  const e = duel(['Steelswarm Sting'], [], [], ['Flame Swordsman']);
  const f = place(e, 1, 'Flame Swordsman');
  const s = place(e, 0, 'Steelswarm Sting');
  kill(e, [s]);
  check(zone(e, f) === 'gy', 'Steelswarm Sting: sent to the GY, destroys a Fusion Monster');
}

section('Stone Statue of the Aztecs');
{
  const e = duel(['Stone Statue of the Aztecs']);
  const s = place(e, 0, 'Stone Statue of the Aztecs', 'def');
  endTurn(e);
  const a = place(e, 1, FILL);
  toBattle(e);
  attack(e, a, s);
  check(e.player(1).lp === 4000 - 1200, 'Stone Statue of the Aztecs: the attacker takes double battle damage');
}

section('Storm');
{
  const e = duel(['Shield Spear', 'Shield Spear', 'Storm'], ['Shield Spear', 'Shield Spear', 'Shield Spear']);
  putST(e, 0, 'Shield Spear');
  putST(e, 0, 'Shield Spear');
  for (let i = 0; i < 3; i++) putST(e, 1, 'Shield Spear');
  e.player(0).sz[2] = null;
  const st = grab(e, 0, 'Storm');
  e.apply({ type: 'ACTIVATE', player: 0, uid: st.uid, zone: 2 });
  settle(e);
  check(e.spells(0).length === 0 && e.spells(1).length === 1, "Storm: destroys your Spells/Traps (2), then as many of the opponent's");
}

section('Straight Flush');
{
  const e = duel(['Straight Flush'], ['Shield Spear', 'Shield Spear', 'Shield Spear']);
  const sf = putST(e, 0, 'Straight Flush');
  putST(e, 1, 'Shield Spear');
  putST(e, 1, 'Shield Spear');
  check(!e.canActivateMain(0, sf.uid), 'Straight Flush: needs all their Spell & Trap Zones occupied');
  putST(e, 1, 'Shield Spear');
  act(e, 0, sf.uid);
  check(e.spells(1).length === 0, "Straight Flush: destroys all cards in the opponent's Spell & Trap Zones");
}

section('Stray Lambs');
{
  const e = duel(['Stray Lambs']);
  playSpell(e, 0, 'Stray Lambs');
  const fill = e.player(0).hand.find((c) => c.name === FILL)!;
  check(e.monsters(0).filter((m) => m.name === 'Lamb Token' && m.pos === 'def').length === 2, 'Stray Lambs: 2 Lamb Tokens in Defense Position');
  check(e.summonBlocked(0, fill, 'normal', 'hand') && !e.summonBlocked(0, fill, 'set', 'hand'), 'Stray Lambs: no other Summons this turn (Sets allowed)');
}

section('Submarineroid');
{
  const e = turn2(['Submarineroid'], ['Gaia The Fierce Knight']);
  place(e, 1, 'Gaia The Fierce Knight');
  const s = place(e, 0, 'Submarineroid');
  toBattle(e);
  attack(e, s, null, 'yes');
  check(e.player(1).lp === 3200 && s!.pos === 'def', 'Submarineroid: attacks directly for its original ATK, then can go to Defense Position');
}

section('Subterror Behemoth Stalagmo');
{
  const S = 'Subterror Behemoth Stalagmo';
  const e = turn2([S, S]);
  const m = place(e, 0, S, 'def', false);
  grab(e, 0, S);
  const h = e.player(0).hand.length;
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: m!.uid });
  settle(e, 'yes');
  check(e.player(0).hand.length === h - 1 + 2 && gyHas(e, 0, S), 'Subterror Behemoth Stalagmo: FLIP, discard a "Subterror" monster to draw 2');
  const e2 = turn2(['Swarm of Locusts', S]);
  const l = place(e2, 0, 'Swarm of Locusts');
  l!.placedTurn = -1;
  const st = grab(e2, 0, S);
  effect(e2, 0, l, 'yes');
  const sm = e2.fieldCard(st.uid);
  check(!l!.faceUp && !!sm && sm.pos === 'def', 'Subterror Behemoth Stalagmo: your last face-up monster flipped face-down, it is Special Summoned from the hand');
}

section('Summon Cloud');
{
  const e = duel(['Summon Cloud', 'Cloudian - Smoke Ball']);
  const sc = playSpell(e, 0, 'Summon Cloud');
  toGy(e, 0, 'Cloudian - Smoke Ball');
  effect(e, 0, sc);
  check(!!onField(e, 0, 'Cloudian - Smoke Ball') && zone(e, sc) === 'gy', 'Summon Cloud: Special Summons a "Cloudian" from the GY, then it is destroyed');
}

section("Summoner's Art");
{
  const e = duel(['Gaia The Fierce Knight', "Summoner's Art"]);
  playSpell(e, 0, "Summoner's Art");
  check(handHas(e, 0, 'Gaia The Fierce Knight'), "Summoner's Art: adds a Level 5+ Normal Monster");
}

section('Super Polymerization');
{
  const e = duel(['Steamroid', 'Drillroid', 'Super Polymerization'], ['Submarineroid'], ['Super Vehicroid Jumbo Drill']);
  place(e, 0, 'Steamroid');
  place(e, 0, 'Drillroid');
  const sub = place(e, 1, 'Submarineroid');
  playSpell(e, 0, 'Super Polymerization');
  const j = onField(e, 0, 'Super Vehicroid Jumbo Drill');
  check(!!j && j.tags?.fusS === 1 && zone(e, sub) === 'gy', "Super Polymerization: discard 1, Fusion Summon with a monster from the opponent's field");
}

section('Super Rush Recklessly');
{
  const e = duel(['Dark Rabbit', 'Super Rush Recklessly'], ['Gaia The Fierce Knight']);
  const r = place(e, 0, 'Dark Rabbit');
  const g = place(e, 1, 'Gaia The Fierce Knight');
  playTrap(e, 0, 'Super Rush Recklessly');
  check(zone(e, r) === 'gy' && zone(e, g) === 'deck', "Super Rush Recklessly: destroys your Beast and shuffles the opponent's monster into the Deck");
}

section('Super Vehicroid Jumbo Drill');
{
  const e = turn2([], [], ['Super Vehicroid Jumbo Drill']);
  const t = place(e, 1, FILL, 'def');
  const j = place(e, 0, 'Super Vehicroid Jumbo Drill');
  toBattle(e);
  attack(e, j, t);
  check(e.player(1).lp === 4000 - 1800, 'Super Vehicroid Jumbo Drill: piercing battle damage');
}

section('Supercharge');
{
  const e = duel(['Cycroid', 'Supercharge'], ['Gaia The Fierce Knight']);
  const c = place(e, 0, 'Cycroid');
  putST(e, 0, 'Supercharge');
  endTurn(e);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  const h = e.player(0).hand.length;
  toBattle(e);
  attack(e, g, c, { respond: 'Supercharge' });
  check(e.player(0).hand.length === h + 2, 'Supercharge: only "roid" Machines and the opponent attacks, draw 2');
}

section('Surface');
{
  const e = duel(['Slushy', 'Surface']);
  toGy(e, 0, 'Slushy');
  playSpell(e, 0, 'Surface');
  const s = onField(e, 0, 'Slushy');
  check(!!s && s.pos === 'def' && s.faceUp, 'Surface: a Level 3 or lower Aqua back in face-up Defense Position');
}

section('Swarm of Locusts');
{
  const e = turn2(['Swarm of Locusts'], ['Shield Spear']);
  const t = putST(e, 1, 'Shield Spear');
  const l = place(e, 0, 'Swarm of Locusts', 'def', false);
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: l!.uid });
  settle(e);
  check(zone(e, t) === 'gy', 'Swarm of Locusts: Flip Summoned, destroys an opponent Spell/Trap');
}

section('Swarm of Scarabs');
{
  const e = turn2(['Swarm of Scarabs']);
  const t = place(e, 1, FILL);
  const l = place(e, 0, 'Swarm of Scarabs', 'def', false);
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: l!.uid });
  settle(e);
  check(zone(e, t) === 'gy', 'Swarm of Scarabs: Flip Summoned, destroys an opponent monster');
  e.state.turn += 2;
  l!.posChanged = false;
  effect(e, 0, l);
  check(!l!.faceUp && l!.pos === 'def', 'Swarm of Scarabs: changes itself to face-down Defense Position');
}

section('Swift Gaia the Fierce Knight');
{
  const e = duel(['Swift Gaia the Fierce Knight']);
  const g = grab(e, 0, 'Swift Gaia the Fierce Knight');
  check(!e.canNormalSummon(0, g, true), 'Swift Gaia: not without Tributes while you hold other cards');
  const ps = e.player(0);
  for (const c of ps.hand.filter((x) => x.uid !== g.uid)) run(e, e.sendToGrave(c.uid, 'cost'));
  e.apply({ type: 'SUMMON', player: 0, uid: g.uid, zone: 0, pos: 'atk', faceUp: true });
  settle(e);
  check(!!e.fieldCard(g.uid) && ps.normalSummoned && !e.fieldCard(g.uid)!.tags?.ss, 'Swift Gaia: Normal Summoned without Tributing as the only card in the hand');
}

section('Swing of Memories');
{
  const e = duel(['Gaia The Fierce Knight', 'Swing of Memories']);
  toGy(e, 0, 'Gaia The Fierce Knight');
  playSpell(e, 0, 'Swing of Memories');
  const g = onField(e, 0, 'Gaia The Fierce Knight');
  check(!!g, 'Swing of Memories: revives a Normal Monster');
  endTurn(e);
  check(zone(e, g) === 'gy', 'Swing of Memories: destroyed in the End Phase');
}

section('Tail Swipe');
{
  const e = duel(['Megazowler', 'Tail Swipe'], ['Gaia The Fierce Knight']);
  place(e, 0, 'Megazowler');
  const a = place(e, 1, FILL);
  const b = place(e, 1, 'Gaia The Fierce Knight');
  const c = place(e, 1, FILL, 'def', false);
  playSpell(e, 0, 'Tail Swipe', { pick: ['Megazowler'] }, { pick: [FILL, 'Face-down card'] });
  check(zone(e, a) === 'hand' && zone(e, c) === 'hand' && zone(e, b) === 'mz', 'Tail Swipe: returns up to 2 lower-Level or face-down opponent monsters to the hand');
}

console.log(fails ? `\n${fails} FAILED` : "\nALL OK");
process.exit(fails ? 1 : 0);
