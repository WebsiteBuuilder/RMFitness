// Speed Duel Skills of Speed Duel GX: Midterm Destruction (skills-2024b; run: npx tsx tests/skills-2024b.test.ts)
// One targeted check per Skill: what its text does really happens in a duel.
import { Engine } from '../src/eds/engine';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';
import { SKILLS } from '../src/eds/skills';

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
  if (!ok && process.env.DBG && cur) console.log(cur.state.log.slice(-25).map((l) => '    ' + l.text).join('\n'));
};
let cur: Engine | null = null;
const FILL = 'Celtic Guardian';

// ---------- duel kit (from tests/batch-16.test.ts; duels start with Skills) ----------
type Ans = 'yes' | 'no' | 'pass' | { pick: string[] } | { respond: string };
function settle(e: Engine, ...ans: Ans[]): number {
  const q = [...ans];
  for (let i = 0; i < 400 && e.state.prompt && e.state.winner === null; i++) {
    const pr = e.state.prompt;
    const h = q[0];
    if (pr.kind === 'select' && pr.max === 0) {
      e.apply({ type: 'CHOOSE', player: pr.player, picks: [] }); // a reveal
      continue;
    }
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
        const k = pr.options.findIndex((o, j) => (o.label === l || o.label.startsWith(l)) && !picks.includes(j));
        if (k >= 0) picks.push(k);
      }
      e.apply({ type: 'CHOOSE', player: pr.player, picks });
    } else e.apply({ type: 'CHOOSE', player: pr.player, picks: pr.options.map((_, j) => j).slice(0, Math.max(1, pr.min)) });
  }
  return q.length;
}
/** A Speed Duel where player 0 has Skill `s0` (and player 1 `s1`); each Deck holds 4 fillers (the opening hand), then the listed cards. */
function sd(s0: string | null, d0: string[] = [], d1: string[] = [], x0: string[] = [], x1: string[] = [], s1: string | null = null, ...ans: Ans[]): Engine {
  const e = new Engine(DB);
  cur = e;
  e.shuffle = <T,>(a: T[]) => a.slice();
  const pad = (d: string[]) => [...Array(4).fill(FILL), ...d, ...Array(Math.max(0, 30 - d.length)).fill(FILL)];
  e.apply({ type: 'START', first: 0, seed: 1, names: ['A', 'B'], decks: [pad(d0), pad(d1)], fusions: [x0, x1], mode: 'speed', skills: [s0, s1] });
  settle(e, ...ans);
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
function place(e: Engine, p: Pid, name: string, pos: Pos = 'atk', faceUp = true, ...ans: Ans[]): FieldCard {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.gy, ...ps.fusion, ...ps.hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  e.state.fx.ignoreCond = c.uid; // test setup: place it ignoring Summoning conditions
  run(e, e.specialSummon(c.uid, p, pos, faceUp), ...ans);
  const f = e.fieldCard(c.uid);
  if (!f) throw new Error(`${name} did not arrive`);
  if (!faceUp) f.placedTurn = -1;
  return f;
}
function putST(e: Engine, p: Pid, name: string, faceUp = false): FieldCard {
  const c = grab(e, p, name);
  const ps = e.player(p);
  ps.hand.splice(ps.hand.findIndex((x) => x.uid === c.uid), 1);
  const z = ps.sz.findIndex((x) => x === null);
  const fc: FieldCard = { ...c, pos: 'atk', faceUp, placedTurn: -1, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: faceUp };
  ps.sz[z] = fc;
  return fc;
}
const toGY = (e: Engine, p: Pid, ...names: string[]) => {
  for (const n of names) run(e, e.sendToGrave(grab(e, p, n).uid, 'cost'));
};
const act = (e: Engine, p: Pid, uid: number, ...ans: Ans[]) => {
  e.apply({ type: 'ACTIVATE', player: p, uid, zone: e.player(p).sz.findIndex((z) => z === null) });
  return settle(e, ...ans);
};
const kill = (e: Engine, cards: (Card | null | undefined)[], by?: Pid, ...ans: Ans[]) => {
  const uids = cards.filter((c): c is Card => !!c).map((c) => c.uid);
  return run(e, by === undefined ? e.destroy(uids) : e.as(by, e.destroy(uids)), ...ans);
};
const endTurn = (e: Engine, ...ans: Ans[]) => {
  e.apply({ type: 'END_TURN', player: e.state.turnPlayer });
  return settle(e, ...ans);
};
/** Ends turns until it is `p`'s next turn (Main Phase 1). */
const turnOf = (e: Engine, p: Pid, ...ans: Ans[]) => {
  endTurn(e, ...ans);
  if (e.state.turnPlayer !== p) endTurn(e, ...ans);
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
const use = (e: Engine, p: Pid, ...ans: Ans[]) => {
  const before = e.player(p).skillUses ?? 0;
  e.apply({ type: 'SKILL', player: p });
  settle(e, ...ans);
  return (e.player(p).skillUses ?? 0) > before;
};
const can = (e: Engine, p: Pid = 0) => e.canUseSkill(p);
const lp = (e: Engine, p: Pid) => e.player(p).lp;
const handHas = (e: Engine, p: Pid, n: string) => e.player(p).hand.some((c) => c.name === n);
const gyHas = (e: Engine, p: Pid, n: string) => e.player(p).gy.some((c) => c.name === n);
const fieldHas = (e: Engine, p: Pid, n: string) => e.monsters(p).some((m) => m.name === n);
const mon = (e: Engine, p: Pid, n: string) => e.monsters(p).find((m) => m.name === n)!;
const logHas = (e: Engine, text: string, since = 0) => e.state.log.slice(since).some((l) => l.text.includes(text));
const tested = new Set<string>();
function T(skill: string, fn: () => void) {
  console.log(`\n--- ${skill}`);
  if (!SKILLS[skill]) check(false, `${skill}: no script`);
  tested.add(skill);
  try {
    fn();
  } catch (err) {
    check(false, `${skill}: threw ${(err as Error).stack?.split('\n').slice(0, 3).join(' | ')}`);
  }
}

// ======================================================================
const S = (e: Engine, p: Pid, k: string) => ((e.state.fx.skillData ?? {}) as Record<string, number>)[`${p}|${k}`] ?? 0;
const stateChecks = (e: Engine) => run(e, (e as any).withStateChecks((function* () {})()));
const equipTo = (e: Engine, eq: FieldCard, host: FieldCard) => {
  eq.equippedTo = host.uid;
  host.equips.push(eq.uid);
};

// ======================================================================
T('Straight out of Neo Space!', () => {
  const e = sd('Straight out of Neo Space!', ['Elemental HERO Neos', 'Gilasaurus']);
  check(e.player(0).skillRevealed && !can(e), 'face-up from the start; not usable while the opponent controls no monster');
  place(e, 1, FILL);
  grab(e, 0, 'Elemental HERO Neos');
  check(can(e) && use(e, 0) && fieldHas(e, 0, 'Elemental HERO Neos'), 'only the opponent controls a monster: Special Summon Neos from the hand');
  const g = grab(e, 0, 'Gilasaurus');
  check(e.summonBlocked(0, g, 'special', 'hand') && !e.summonBlocked(0, 'Neo-Spacian Aqua Dolphin', 'special', 'hand'), 'for the rest of the turn: only "Elemental HERO"/"Neo-Spacian" monsters can be Special Summoned');
  endTurn(e);
  check(!e.summonBlocked(0, g, 'special', 'hand'), 'the lock ends with the turn');

  const f = sd('Straight out of Neo Space!', ['Elemental HERO Neos'], [], ['Elemental HERO Grand Neos']);
  place(f, 0, 'Elemental HERO Grand Neos');
  endTurn(f, 'yes');
  check(f.player(0).fusion.some((c) => c.name === 'Elemental HERO Grand Neos') && fieldHas(f, 0, 'Elemental HERO Neos') && !f.player(0).deck.some((c) => c.name === 'Elemental HERO Neos'), 'End Phase: a Fusion Monster returned to the Extra Deck -> Special Summon Neos from the Deck');
});

T('Destructive Fate', () => {
  const e = sd('Destructive Fate');
  check(e.player(0).skillRevealed && can(e), 'face-up from the start, usable during your turn');
  check(use(e, 0, { pick: ['a Monster'] }, { pick: ['Tails'] }) && lp(e, 0) === 2000, 'lose half your LP to declare the result');
  let r = 0;
  run(e, e.as(0, (function* () { r = e.roll(2); })()));
  check(r === 2, 'your next coin toss shows the declared result (Tails)');
  check(can(e), 'once per turn for each card type: the Spell one is still available');
  use(e, 0, { pick: ['Heads'] });
  check(!can(e) && lp(e, 0) === 1000, 'both card types used this turn');
  turnOf(e, 0);
  check(can(e), 'usable again next turn');
  turnOf(e, 0);
  endTurn(e);
  check(S(e, 0, 'fateTurns') === 3 && !e.player(0).skillRevealed, 'End Phase of your 3rd turn: flipped face-down');
  endTurn(e);
  check(!can(e), 'no longer usable');
});

T('Food Chain', () => {
  const e = sd('Food Chain', ['Black Ptera', 'Black Stego', 'Duoterion', 'Uraby', 'Tomozaurus']);
  const b = place(e, 0, 'Black Ptera');
  check(!e.player(0).skillRevealed && can(e), 'face-down until used; a Level 3 Dinosaur and a Level 4 Dinosaur in the Deck');
  use(e, 0, { pick: ['Destroy a Dinosaur'] }, { pick: ['Black Ptera'] }, { pick: ['Black Stego'] });
  check(zone(e, b) !== 'mz' && fieldHas(e, 0, 'Black Stego') && e.player(0).skillRevealed, 'destroy the Level 3 Dinosaur, then Special Summon the Level 4 Dinosaur from the Deck');
  check(!can(e), 'once per turn');
  turnOf(e, 0);
  toGY(e, 0, 'Uraby', 'Tomozaurus');
  const d = grab(e, 0, 'Duoterion');
  use(e, 0, { pick: ['Tribute Summon'] }, { pick: ['Duoterion'] });
  const m = e.fieldCard(d.uid);
  check(!!m && fieldHas(e, 0, 'Black Stego') && e.player(0).removed.filter((c) => ['Uraby', 'Tomozaurus', 'Black Ptera'].includes(c.name)).length === 2 && !!m.tags?.tribS && e.player(0).normalSummoned, 'Tribute Summon a Dinosaur by banishing 2 Dinosaur/Reptile monsters from the GY (it uses the Normal Summon)');
});

T('Major in Paleontology', () => {
  const e = sd('Major in Paleontology', ['Labyrinth Wall'], ['Giant Soldier of Stone'], ['Fossil Warrior Skull Knight']);
  check(e.player(0).skillRevealed && can(e), 'face-up from the start');
  const h = e.player(0).hand[0];
  use(e, 0, { pick: ['Banish 1 card'] }, { pick: [h.name] });
  check(zone(e, h) === 'removed' && S(e, 0, 'dig') === 1, 'banish 1 card from the hand face-down: 1 Dig Counter');
  toGY(e, 0, 'Labyrinth Wall');
  toGY(e, 1, 'Giant Soldier of Stone');
  check(can(e), 'the other Skill is usable the same turn');
  use(e, 0, { pick: ['Remove the Dig Counter'] });
  const k = e.monsters(0).find((m) => m.name === 'Fossil Warrior Skull Knight');
  check(!!k && !!k.tags?.fusS && S(e, 0, 'dig') === 0 && e.player(0).removed.some((c) => c.name === 'Labyrinth Wall') && e.player(1).removed.some((c) => c.name === 'Giant Soldier of Stone'), 'remove the counter: Fusion Summon a "Fossil" Fusion Monster by banishing its materials from any GYs');
  check(!can(e), 'each part once per turn');
  kill(e, [k], 1, 'yes');
  check(S(e, 0, 'dig') === 1, 'a "Fossil" Fusion Monster destroyed by a card effect: place 1 Dig Counter');
});

T('Wise Man Neos', () => {
  const e = sd('Wise Man Neos', ['Elemental HERO Neos'], ['Gilasaurus']);
  const n = place(e, 0, 'Elemental HERO Neos');
  const o = place(e, 1, 'Gilasaurus');
  turnOf(e, 0);
  toBattle(e);
  attack(e, n, o, 'yes');
  check(lp(e, 1) === 4000 - 700 - 1100, 'before damage calculation: damage equal to half the original ATK of the monster it battles');
  const f = sd('Wise Man Neos', [], ['Gilasaurus'], ['Elemental HERO Brave Neos']);
  const b = place(f, 0, 'Elemental HERO Brave Neos');
  const g = place(f, 1, 'Gilasaurus');
  endTurn(f);
  toBattle(f);
  attack(f, g, b, 'yes');
  check(lp(f, 1) === 4000 - 700 - 1100, 'a Fusion Monster that mentions Neos as material, also when it is attacked');
});

T("Magician's Scales", () => {
  const e = sd("Magician's Scales", ['Arcana Force VII - The Chariot', 'Card Advance', 'Gilasaurus']);
  e.state.fx.fixedRoll = { p: 0, coin: 1 }; // its own coin toss: Heads
  const a = place(e, 0, 'Arcana Force VII - The Chariot');
  check(can(e) && use(e, 0, { pick: ['Card Advance'] }), 'usable with an "Arcana Force" monster');
  check(zone(e, a) === 'gy' && handHas(e, 0, 'Card Advance'), 'Tribute it and add 1 Normal Spell from the Deck');
  const g = grab(e, 0, 'Gilasaurus');
  check(!e.canNormalSummon(0, g, true) && e.summonBlocked(0, g, 'special', 'hand') && !e.summonBlocked(0, 'Arcana Force I - The Magician', 'special', 'hand'), 'for the rest of the Duel: only "Arcana Force" monsters can be Summoned');
  turnOf(e, 0);
  check(!e.canNormalSummon(0, g, true) && !can(e), 'still locked next turn; once per Duel');
});

T('Dino Brain Immunity', () => {
  const e = sd('Dino Brain Immunity', ['Black Tyranno', 'Black Stego'], ['Windstorm of Etaqua', 'Book of Moon']);
  const t = place(e, 0, 'Black Tyranno');
  const s = place(e, 0, FILL);
  endTurn(e);
  const w = putST(e, 1, 'Windstorm of Etaqua');
  act(e, 1, w.uid);
  check(t.pos === 'atk' && s.pos === 'def', 'a Trap changing battle positions: the Dinosaur keeps its position, others change');
  const spell = grab(e, 1, 'Book of Moon');
  (e as any).resolving = 1;
  (e as any).levelSource = spell.uid;
  const lv4 = place(e, 0, 'Black Stego');
  const ok = e.untargetable(t) && !e.untargetable(lv4);
  (e as any).resolving = 0;
  (e as any).levelSource = null;
  check(ok && !e.untargetable(t), 'Level 7 or higher Dinosaurs cannot be targeted by Spell effects');
});

T('Dig Site Inspection', () => {
  const e = sd('Dig Site Inspection', ['Gilasaurus', 'Black Stego', 'Uraby', 'Tomozaurus']);
  turnOf(e, 0, 'yes', { pick: ['Bottom of the Deck'] });
  const d = e.player(0).deck;
  check(handHas(e, 0, 'Black Stego') && !handHas(e, 0, 'Gilasaurus') && d[d.length - 1].name === 'Gilasaurus', 'Draw Phase: excavate the top card, put it on the bottom, then draw');
  turnOf(e, 0, 'yes', { pick: ['Top of the Deck'] });
  check(handHas(e, 0, 'Uraby') && S(e, 0, 'digBottom') === 1, 'kept on top: it is the card drawn');
  turnOf(e, 0, 'yes', { pick: ['Bottom of the Deck'] });
  check(!e.player(0).skillRevealed && S(e, 0, 'digBottom') === 2, 'after a second card is placed on the bottom: flipped over');
  const n = e.player(0).hand.length;
  turnOf(e, 0, 'yes', { pick: ['Bottom of the Deck'] });
  check(e.player(0).hand.length >= n && !logHas(e, 'uses the Skill Dig Site', e.state.log.length - 6), 'no longer used: a normal draw');
});

T('"Invitation" to the Society', () => {
  const e = sd('"Invitation" to the Society', ['White Veil'], ['Gilasaurus']);
  const g = place(e, 1, 'Gilasaurus');
  const v = putST(e, 0, 'White Veil', true);
  equipTo(e, v, g);
  stateChecks(e);
  check(e.controller(g.uid) === 0, 'your White Veil equipped to an opponent\'s monster: take control of it');
  run(e, e.sendToGrave(v.uid, 'destroyed'));
  stateChecks(e);
  check(e.controller(g.uid) === 1, 'White Veil gone: control returns');
  const f = sd('"Invitation" to the Society', ['White Veil', 'Gilasaurus']);
  const a = place(f, 0, 'Gilasaurus');
  const b = place(f, 0, FILL);
  turnOf(f, 0);
  const w = putST(f, 0, 'White Veil', true);
  equipTo(f, w, a);
  ((f.state.fx.skillData ??= {}) as Record<string, number>)['0|veilTurn'] = f.state.turn; // as the Skill records when you activate White Veil
  toBattle(f);
  check(f.canAttackWith(0, a) && !f.canAttackWith(0, b), 'the turn you activate White Veil: only monsters equipped with it can attack');
});

T('Mokey Mokey Madness', () => {
  const e = sd('Mokey Mokey Madness', ['Mokey Mokey', 'Mokey Mokey', 'Mokey Mokey Smackdown'], ['Gilasaurus', 'Black Ptera']);
  place(e, 0, 'Mokey Mokey');
  check(!e.player(0).skillRevealed && use(e, 0) && e.player(0).skillRevealed, 'flip the Skill over');
  endTurn(e);
  const g = place(e, 1, 'Gilasaurus');
  toBattle(e);
  check(!e.canAttackWith(1, g), 'all your monsters are "Mokey Mokey": an Effect Monster cannot attack the turn it is Summoned');
  turnOf(e, 1);
  toBattle(e);
  check(e.canAttackWith(1, g), 'it can attack the next turn');
  turnOf(e, 1);
  const bp = place(e, 1, 'Black Ptera', 'def', false); // Set on an earlier turn
  e.apply({ type: 'FLIP_SUMMON', player: 1, uid: bp.uid });
  settle(e);
  toBattle(e);
  check(bp.faceUp && bp.placedTurn !== e.state.turn && !e.canAttackWith(1, bp), 'a monster Set earlier and Flip Summoned this turn cannot attack either');
  turnOf(e, 0);
  const m2 = place(e, 0, 'Mokey Mokey');
  for (const c of e.player(0).hand.filter((x) => x.name === 'Mokey Mokey Smackdown')) e.toDeckTop(c.uid);
  use(e, 0, { pick: ['Place a "Mokey Mokey"'] }, { pick: ['Mokey Mokey Smackdown'] }, { pick: ['Mokey Mokey'] });
  check(e.spells(0).some((c) => c.name === 'Mokey Mokey Smackdown' && c.faceUp) && e.monsters(0).length === 1, 'control 2 Fairy monsters: place a "Mokey Mokey" Continuous Spell from the Deck, then destroy 1 monster you control');
  check(!can(e), 'once per turn by the engine; the King part needs 3 Mokey Mokey');
  void m2;
  const f = sd('Mokey Mokey Madness', ['Mokey Mokey', 'Mokey Mokey', 'Mokey Mokey'], [], ['Mokey Mokey King']);
  place(f, 0, 'Mokey Mokey');
  for (const c of f.player(0).deck.filter((x) => x.name === 'Mokey Mokey')) f.toHandOf(c.uid, 0);
  use(f, 0, 'yes', { pick: [FILL] });
  check(fieldHas(f, 0, 'Mokey Mokey King') && f.player(0).gy.filter((c) => c.name === 'Mokey Mokey').length === 3 && gyHas(f, 0, FILL), 'discard 1 card: Fusion Summon "Mokey Mokey King" from the hand/field');
});

T('Cyberdark Scheme', () => {
  const e = sd('Cyberdark Scheme', ['Cyberdark Horn', 'Cyberdark Edge']);
  const h = place(e, 0, 'Cyberdark Horn');
  grab(e, 0, 'Cyberdark Edge');
  use(e, 0, 'yes', { pick: ['Cyberdark Edge'] });
  check(zone(e, h) === 'hand' && fieldHas(e, 0, 'Cyberdark Edge') && e.player(0).normalSummoned && e.player(0).skillRevealed, 'return a "Cyberdark" monster to the hand, then Normal Summon a "Cyberdark" monster');
  const f = sd('Cyberdark Scheme', ['Koumori Dragon'], ['Gilasaurus'], ['Cyberdark Dragon']);
  const d = place(f, 0, 'Cyberdark Dragon');
  const k = putST(f, 0, 'Koumori Dragon', true);
  equipTo(f, k, d);
  const g = place(f, 1, 'Gilasaurus');
  const before = f.atkOf(d);
  use(f, 0, { pick: ['Send an equipped'] }, { pick: ['Koumori Dragon'] }, { pick: ['Gilasaurus'] });
  const after = f.atkOf(d);
  check(gyHas(f, 0, 'Koumori Dragon') && zone(f, g) === 'sz' && g.equippedTo === d.uid && f.monsters(1).length === 0, 'send the equipped Monster Card to the GY, then equip the opponent\'s monster to the Cyberdark Fusion');
  check(after - (before + 100) === 1400, `it gains the equipped monster's original ATK (${before} -> ${after}; +100 for Koumori in the GY)`);
});

T('Shouldering a Destiny', () => {
  const e = sd('Shouldering a Destiny', ['Destiny HERO - Plasma', 'Gilasaurus'], ['Black Ptera']);
  check(e.player(0).hand.length === 3, 'draw 1 less card at the start of the Duel');
  check(can(e) && use(e, 0, 'yes', { pick: ['Destiny HERO - Plasma'] }) && handHas(e, 0, 'Destiny HERO - Plasma') && e.spells(0).some((c) => c.name === 'Shouldering a Destiny'), 'activated as a Continuous Spell: add "Destiny HERO - Plasma" from the Deck');
  toGY(e, 0, 'Gilasaurus');
  const p = place(e, 0, 'Destiny HERO - Plasma');
  check(e.atkOf(p) === 1900 + 100, 'Plasma gains 100 ATK for each monster in the GYs');
  check(e.extraAttacks(p) >= 1, 'Plasma can make a second attack');
  kill(e, [p], 1);
  check(!!e.fieldCard(p.uid), "Plasma cannot be destroyed by the opponent's card effects");
  const n = e.player(0).hand.length;
  turnOf(e, 0);
  check(e.player(0).hand.length === n, 'while you control Plasma: you cannot draw during the Draw Phase');
});

// ======================================================================
const mine = ['Straight out of Neo Space!', 'Destructive Fate', 'Food Chain', 'Major in Paleontology', 'Wise Man Neos', "Magician's Scales", 'Dino Brain Immunity', 'Dig Site Inspection', '"Invitation" to the Society', 'Mokey Mokey Madness', 'Cyberdark Scheme', 'Shouldering a Destiny'];
const missing = mine.filter((s) => !tested.has(s) || !SKILLS[s]);
check(missing.length === 0, `every Skill has a script and a check (missing: ${missing.join(', ')})`);
console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
if (fails) process.exit(1);
