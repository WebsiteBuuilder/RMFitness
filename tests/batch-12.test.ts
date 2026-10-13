// Speed Duel cards of batch 12 (run: npx tsx tests/batch-12.test.ts)
// One or more targeted checks per card: its main effect really happens in a duel.
import { Engine } from '../src/eds/engine';
import { getEffect } from '../src/eds/effects';
import type { Card, ChainLink, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
  if (!ok && process.env.DEBUG && cur) console.log('   ' + cur.state.log.slice(-10).map((l) => l.text).join('\n   '));
};
let cur: Engine | null = null;
const FILL = 'Celtic Guardian';

// ---------- duel kit (same as tests/cont-d.test.ts) ----------
type Ans = 'yes' | 'no' | 'pass' | { pick: string[] } | { respond: string };
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
  cur = e;
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
/** Moves a card of `p` into its GY. */
function toGy(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.hand, ...ps.deck, ...ps.fusion].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  for (const arr of [ps.hand, ps.deck, ps.fusion]) {
    const i = arr.findIndex((x) => x.uid === c.uid);
    if (i >= 0) arr.splice(i, 1);
  }
  ps.gy.push(c);
  return c;
}
function place(e: Engine, p: Pid, name: string, pos: Pos = 'atk', faceUp = true, ...ans: Ans[]): FieldCard | null {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.gy, ...ps.fusion, ...ps.hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.specialSummon(c.uid, p, pos, faceUp), ...ans);
  const f = e.fieldCard(c.uid);
  if (f) f.placedTurn = -1;
  return f;
}
/** Puts a monster straight into a Monster Zone (no summon at all). */
function putMZ(e: Engine, p: Pid, name: string, tags?: Record<string, number>, pos: Pos = 'atk'): FieldCard {
  const ps = e.player(p);
  const c = [...ps.hand, ...ps.deck, ...ps.gy, ...ps.fusion].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  for (const arr of [ps.hand, ps.deck, ps.gy, ps.fusion]) {
    const i = arr.findIndex((x) => x.uid === c.uid);
    if (i >= 0) arr.splice(i, 1);
  }
  const fc: FieldCard = { ...c, pos, faceUp: true, placedTurn: -1, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, tags: tags ? { ...tags } : undefined };
  ps.mz[ps.mz.findIndex((x) => x === null)] = fc;
  return fc;
}
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
function playSpell(e: Engine, p: Pid, name: string, ...ans: Ans[]): FieldCard | null {
  const c = grab(e, p, name);
  act(e, p, c.uid, ...ans);
  return e.fieldCard(c.uid);
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
const kill = (e: Engine, cards: (Card | null | undefined)[], ...ans: Ans[]) => run(e, e.destroy(cards.filter((c): c is Card => !!c).map((c) => c.uid)), ...ans);
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
/** Makes a name the database does not know behave like a card with these stats (archetype cards missing from the pool). */
const fake = (e: Engine, name: string, info: Record<string, unknown>) => (((e.state.fx.tokens ??= {}) as Record<string, unknown>)[name] = info);

// ======================= monsters =======================
section('Pendulum / Xyz-only cards');
check(!!getEffect('Abyss Actor - Extras') && !!getEffect('Express Train Trolley Olley'), 'Abyss Actor - Extras and Express Train Trolley Olley are scripted (no effect can apply)');

section('Ambulanceroid');
{
  const e = duel(['Ambulanceroid', 'Gyroid']);
  place(e, 0, 'Ambulanceroid');
  const g = toGy(e, 0, 'Gyroid');
  check(!e.canUseQuickNow(0, e.monsters(0)[0].uid), 'nothing to do before a "roid" comes back');
  e.toHandOf(g.uid, 0);
  quickNow(e, 0, e.monsters(0)[0]);
  check(zone(e, g) === 'mz', 'a "roid" monster added from the GY to the hand is Special Summoned');
}

section('Ancient Gear Knight');
{
  const e = duel(['Ancient Gear Knight']);
  const k = summon(e, 0, 'Ancient Gear Knight')!;
  e.state.battle = { attacker: k.uid, target: null };
  check(!e.activationLocked(1, 'spell'), 'as a Normal Monster it locks nothing');
  e.state.battle = null;
  e.player(0).normalSummoned = false;
  effect(e, 0, k);
  check(k.tags?.gemini === 1 && e.player(0).normalSummoned, 'Normal Summoned again: it becomes an Effect Monster');
  e.state.battle = { attacker: k.uid, target: null };
  check(e.activationLocked(1, 'spell') && e.activationLocked(1, 'trap') && !e.activationLocked(0, 'trap'), 'while it attacks, the opponent cannot activate Spells/Traps');
  e.state.battle = null;
  check(!e.activationLocked(1, 'trap'), 'after the Damage Step they can again');
}

section('Arcana Force XXI - The World');
{
  const e = duel(['Arcana Force XXI - The World']);
  const w = place(e, 0, 'Arcana Force XXI - The World')!;
  check(w.tags?.coin === 1 || w.tags?.coin === 2, 'a coin is tossed when it is Summoned');
  w.tags!.coin = 1;
  place(e, 0, FILL);
  place(e, 0, FILL);
  const t = e.state.turn;
  endTurn(e, 'yes', { pick: [FILL, FILL] });
  check(e.state.turnPlayer === 0 && e.state.turn === t + 2 && logHas(e, "turn is skipped"), "Heads: send 2 monsters in the End Phase to skip the opponent's next turn");
}
{
  const e = duel(['Arcana Force XXI - The World'], ['Axe Raider']);
  const w = place(e, 0, 'Arcana Force XXI - The World')!;
  w.tags!.coin = 2;
  const axe = toGy(e, 1, 'Axe Raider');
  endTurn(e);
  check(zone(e, axe) === 'hand' && e.find(axe.uid)!.loc.player === 1, "Tails: the top card of the opponent's GY goes to their hand on their turn");
}

section('Blackwing - Brisote the Tailwind');
{
  const e = duel(['Blackwing - Brisote the Tailwind', 'Blackwing - Calima the Haze', 'Blackwing - Calima the Haze']);
  const b = grab(e, 0, 'Blackwing - Brisote the Tailwind');
  const a = place(e, 0, 'Blackwing - Calima the Haze');
  check(!e.canSpecialProc(0, b), 'no Blackwings destroyed: cannot be Special Summoned');
  kill(e, [a]);
  check(!e.canSpecialProc(0, b), '1 destroyed: still not');
  kill(e, [place(e, 0, 'Blackwing - Calima the Haze')]);
  e.apply({ type: 'SPECIAL', player: 0, uid: b.uid });
  settle(e);
  check(zone(e, b) === 'mz', '2 face-up Blackwings destroyed this turn: Special Summoned from the hand');
}

section('Chaos Command Magician');
{
  const e = duel(['Chaos Command Magician'], ['Sangan']);
  const ccm = place(e, 0, 'Chaos Command Magician')!;
  const s = place(e, 1, 'Sangan')!;
  const other: ChainLink = { card: s, loc: e.find(s.uid)!.loc, player: 1, label: s.name, negated: false, targetUid: ccm.uid, payload: { effect: 'quick' } };
  const q = getEffect('Chaos Command Magician')!.quick!;
  check(q.can(e, ccm, 0, 'effect', { link: other }), 'a monster effect targeting it can be answered');
  const mine: ChainLink = { card: ccm, loc: e.find(ccm.uid)!.loc, player: 0, label: ccm.name, negated: false, payload: { effect: 'quick', ctx: { link: other } } };
  run(e, q.run(e, ccm, 0, mine));
  check(other.negated, 'that monster effect is negated');
}

section('Clock Arc');
{
  const e = duel(['Clock Arc', 'Clock Arc']);
  const a = place(e, 0, 'Clock Arc');
  check(a === null, 'Special Summoned outside the center Main Monster Zone: destroyed');
  place(e, 0, FILL);
  const b = place(e, 0, 'Clock Arc')!;
  check(!!b && e.player(0).mz[1]?.uid === b.uid, 'in the center zone it stays');
  check(e.shielded(b, 'battle'), 'cannot be destroyed by battle');
}

section('D.D. Destroyer');
{
  const e = duel(['D.D. Destroyer'], ['Axe Raider']);
  const d = place(e, 0, 'D.D. Destroyer')!;
  const axe = place(e, 1, 'Axe Raider');
  e.banish(d.uid);
  run(e, e.flushLeaves(), 'yes');
  check(zone(e, axe) === 'gy', 'removed from play from the field: destroys a face-up card of the opponent');
}

section('Dark Ruler Ha Des');
{
  const e = duel(['Dark Ruler Ha Des']);
  const h = toGy(e, 0, 'Dark Ruler Ha Des');
  run(e, e.specialSummon(h.uid, 0, 'atk'));
  check(zone(e, h) === 'gy', 'cannot be Special Summoned from the GY');
}
{
  const e = duel(['Dark Ruler Ha Des', 'Feral Imp', 'Axe Raider'], ['Sangan', 'Sangan']);
  e.state.firstTurn = false;
  place(e, 0, 'Dark Ruler Ha Des');
  const imp = place(e, 0, 'Feral Imp');
  const s = place(e, 1, 'Sangan');
  const hand = e.player(1).hand.length;
  toBattle(e);
  attack(e, imp, s);
  check(zone(e, s) === 'gy' && e.player(1).hand.length === hand, "Sangan destroyed by a Fiend: its effect is negated (no search)");
}
{
  const e = duel(['Axe Raider'], ['Sangan']);
  e.state.firstTurn = false;
  const axe = place(e, 0, 'Axe Raider');
  const s = place(e, 1, 'Sangan');
  const hand = e.player(1).hand.length;
  toBattle(e);
  attack(e, axe, s);
  check(zone(e, s) === 'gy' && e.player(1).hand.length === hand + 1, 'without Ha Des Sangan still searches (control)');
}

section('Destiny HERO - Doom Lord');
{
  const e = duel(['Destiny HERO - Doom Lord', 'Axe Raider'], ['Gyroid']);
  e.state.firstTurn = false;
  const d = place(e, 0, 'Destiny HERO - Doom Lord')!;
  const axe = place(e, 0, 'Axe Raider')!;
  const g = place(e, 1, 'Gyroid', 'def')!;
  const t0 = e.state.turn;
  effect(e, 0, d);
  check(zone(e, g) === 'removed', "banishes the opponent's monster");
  toBattle(e);
  check(!e.canAttackWith(0, axe), 'no attacks this turn');
  endTurn(e);
  endTurn(e);
  check(zone(e, g) === 'removed', 'still gone at your next Standby Phase');
  endTurn(e);
  endTurn(e);
  check(e.state.turn === t0 + 4 && zone(e, g) === 'mz' && e.find(g.uid)!.loc.player === 1 && e.fieldCard(g.uid)!.pos === 'def', 'returns to its side in the same position on your 2nd Standby Phase');
}

section('Elemental HERO Wildheart');
{
  const e = duel(['Elemental HERO Wildheart'], ['Trap Hole']);
  putST(e, 1, 'Trap Hole');
  const w = summon(e, 0, 'Elemental HERO Wildheart', true, { respond: 'Trap Hole' });
  check(zone(e, w) === 'mz' && logHas(e, 'activates Trap Hole'), 'Trap Hole is activated but cannot destroy it (unaffected by Traps)');
  const h = duel(['Elemental HERO Wildheart']);
  const w2 = place(h, 0, 'Elemental HERO Wildheart')!;
  kill(h, [w2]);
  check(zone(h, w2) === 'gy', 'other effects still destroy it');
}

section('Fog King');
{
  const e = duel(['Fog King', 'Axe Raider']);
  place(e, 0, 'Axe Raider');
  const f = grab(e, 0, 'Fog King');
  effect(e, 0, f, { pick: ['Tribute 1 monster'] }, { pick: ['Axe Raider'] });
  const fk = e.fieldCard(f.uid);
  check(!!fk && fk.faceUp && e.player(0).normalSummoned && e.atkOf(fk) === 1700, 'Normal Summoned with 1 Tribute: ATK = the Tribute\'s original ATK (1700)');
}
{
  const e = duel(['Fog King']);
  const f = grab(e, 0, 'Fog King');
  effect(e, 0, f, { pick: ['Tribute no monsters'] });
  check(zone(e, f) === 'mz' && e.atkOf(e.fieldCard(f.uid)!) === 0, 'Normal Summoned with no Tributes: 0 ATK');
}

section('Gearfried the Swordmaster');
{
  const e = duel(['Gearfried the Swordmaster', 'Release Restraint', 'Gearfried the Iron Knight', 'Axe of Despair'], ['Axe Raider']);
  const gs = grab(e, 0, 'Gearfried the Swordmaster');
  run(e, e.specialSummon(gs.uid, 0, 'atk'));
  check(zone(e, gs) === 'hand', 'cannot be Special Summoned by other effects');
  e.player(0).hand.splice(e.player(0).hand.findIndex((c) => c.uid === gs.uid), 1);
  e.player(0).deck.unshift(gs);
  place(e, 0, 'Gearfried the Iron Knight');
  playSpell(e, 0, 'Release Restraint');
  check(zone(e, gs) === 'mz', 'Release Restraint Special Summons it');
  const axe = place(e, 1, 'Axe Raider');
  playSpell(e, 0, 'Axe of Despair', { pick: ['Gearfried the Swordmaster'] });
  quickNow(e, 0, gs, { pick: ['Axe Raider'] });
  check(zone(e, axe) === 'gy', 'an Equip Card was equipped to it: destroys 1 opponent monster');
}

section('Heavy Knight of the Flame');
{
  const e = duel(['Heavy Knight of the Flame'], ['Gyroid', 'Axe Raider']);
  const k = summon(e, 0, 'Heavy Knight of the Flame')!;
  k.placedTurn = -1;
  e.player(0).normalSummoned = false;
  effect(e, 0, k);
  const g = place(e, 1, 'Gyroid');
  e.state.firstTurn = false;
  toBattle(e);
  attack(e, k, g, { respond: 'Heavy Knight' });
  check(zone(e, g) === 'removed', 'it attacks a Special Summoned monster: banished');
}

section('Infernity Dwarf');
{
  const e = duel(['Infernity Dwarf', 'Axe Raider']);
  place(e, 0, 'Infernity Dwarf');
  const axe = place(e, 0, 'Axe Raider');
  const g = place(e, 1, FILL, 'def');
  for (const c of e.player(0).hand.slice()) e.player(0).deck.push(e.player(0).hand.splice(0, 1)[0]);
  e.state.firstTurn = false;
  toBattle(e);
  const lp = e.player(1).lp;
  attack(e, axe, g);
  check(zone(e, g) === 'gy' && e.player(1).lp === lp - 500, 'no cards in hand: attacks on Defense Position monsters pierce (500)');
}

section('Legion the Fiend Jester');
{
  const e = duel(['Legion the Fiend Jester', 'Dark Magician', 'Dark Magician', 'Axe Raider']);
  const l = place(e, 0, 'Legion the Fiend Jester')!;
  place(e, 0, 'Axe Raider');
  e.player(0).normalSummoned = true;
  const dm = grab(e, 0, 'Dark Magician');
  effect(e, 0, l, { pick: ['Dark Magician'] }, { pick: ['Legion the Fiend Jester', 'Axe Raider'] }, 'yes');
  check(zone(e, dm) === 'mz' && zone(e, l) === 'gy', 'an extra Tribute Summon of a Spellcaster after the Normal Summon');
  check(e.player(0).hand.some((c) => c.name === 'Dark Magician'), 'sent from the field to the GY: adds a Spellcaster Normal Monster');
}

section('Makyura the Destructor');
{
  const e = duel(['Makyura the Destructor', "Pikeru's Circle of Enchantment"]);
  const m = place(e, 0, 'Makyura the Destructor');
  const t = grab(e, 0, "Pikeru's Circle of Enchantment");
  kill(e, [m]);
  quickNow(e, 0, m);
  const fc = e.fieldCard(t.uid);
  check(!!fc && e.canActivateMain(0, t.uid), 'sent from the Monster Zone to the GY: a Trap from the hand can be activated this turn');
  act(e, 0, t.uid);
  check(zone(e, t) === 'gy' && logHas(e, 'no damage from card effects'), 'the Trap is activated');
}

section('Mechanical Hound');
{
  const e = duel(['Mechanical Hound']);
  place(e, 0, 'Mechanical Hound');
  check(!e.activationLocked(1, 'spell'), 'with cards in your hand nothing happens');
  e.player(0).deck.push(...e.player(0).hand.splice(0));
  check(e.activationLocked(1, 'spell') && !e.activationLocked(1, 'trap') && !e.activationLocked(0, 'spell'), 'no cards in hand: the opponent cannot activate Spells');
}

section('Patrician of Darkness');
{
  const e = duel(['Axe Raider'], ['Patrician of Darkness', 'Gyroid']);
  const axe = place(e, 0, 'Axe Raider');
  place(e, 1, 'Patrician of Darkness');
  const g = place(e, 1, 'Gyroid')!;
  e.state.firstTurn = false;
  toBattle(e);
  attack(e, axe, e.monsters(1).find((m) => m.name === 'Patrician of Darkness')!, { respond: 'Patrician of Darkness' }, { pick: ['Gyroid'] });
  check(logHas(e, 'Patrician of Darkness: Axe Raider attacks Gyroid') && e.player(1).lp === 4000 - 700 && !!g, 'the Patrician player picks the attack target');
}

section('Pitch-Black Warwolf');
{
  const e = duel(['Pitch-Black Warwolf']);
  place(e, 0, 'Pitch-Black Warwolf');
  check(!e.activationLocked(1, 'trap'), 'Main Phase: Traps are fine');
  e.state.phase = 'BP';
  check(e.activationLocked(1, 'trap') && !e.activationLocked(1, 'spell'), 'Battle Phase: the opponent cannot activate Traps');
}

section('Red-Eyes Wyvern');
{
  const e = duel(['Red-Eyes Wyvern', 'Red-Eyes Black Dragon']);
  const w = toGy(e, 0, 'Red-Eyes Wyvern');
  const r = toGy(e, 0, 'Red-Eyes Black Dragon');
  endTurn(e, 'yes');
  check(zone(e, w) === 'removed' && zone(e, r) === 'mz', 'End Phase, no Normal Summon: banish it to revive a "Red-Eyes" monster');
}
{
  const e = duel(['Red-Eyes Wyvern', 'Red-Eyes Black Dragon']);
  toGy(e, 0, 'Red-Eyes Wyvern');
  const r = toGy(e, 0, 'Red-Eyes Black Dragon');
  summon(e, 0, FILL);
  endTurn(e, 'yes');
  check(zone(e, r) === 'gy', 'not after a Normal Summon');
}

section('Strike Ninja');
{
  const e = duel(['Strike Ninja', 'Ancient Brain', 'Armored Zombie']);
  const n = place(e, 0, 'Strike Ninja')!;
  const a = toGy(e, 0, 'Ancient Brain');
  const b = toGy(e, 0, 'Armored Zombie');
  quickNow(e, 0, n);
  check(zone(e, n) === 'removed' && zone(e, a) === 'removed' && zone(e, b) === 'removed', 'banish 2 DARK monsters from the GY: it is banished');
  endTurn(e);
  check(zone(e, n) === 'mz' && e.find(n.uid)!.loc.player === 0, 'it returns in the End Phase');
}

section('The Trojan Horse');
{
  const e = duel(['The Trojan Horse', 'Mechanical Hound']);
  const t = place(e, 0, 'The Trojan Horse');
  const h = summon(e, 0, 'Mechanical Hound');
  check(!!h && zone(e, t) === 'gy', 'it alone Tributes for a Level 7 EARTH monster');
}

section('Vilepawn Archfiend');
{
  const e = duel(['Vilepawn Archfiend', 'Terrorking Archfiend'], ['Axe Raider']);
  const v = place(e, 0, 'Vilepawn Archfiend')!;
  const tk = place(e, 0, 'Terrorking Archfiend')!;
  const axe = place(e, 1, 'Axe Raider')!;
  check(e.legalTargets(1, axe).every((m) => m.uid !== tk.uid) && e.legalTargets(1, axe).some((m) => m.uid === v.uid), 'the opponent can attack Vilepawn but not other Archfiends');
  endTurn(e);
  endTurn(e);
  check(e.player(0).lp === 3500, 'pays 500 LP in each of your Standby Phases');
  const link: ChainLink = { card: axe, loc: e.find(axe.uid)!.loc, player: 1, label: 'x', negated: false, targetUid: v.uid };
  let hit = false;
  for (let i = 0; i < 30 && !hit; i++) {
    link.negated = false;
    const mine: ChainLink = { card: v, loc: e.find(v.uid)!.loc, player: 0, label: v.name, negated: false, payload: { effect: 'quick', ctx: { link } } };
    run(e, getEffect('Vilepawn Archfiend')!.quick!.run(e, v, 0, mine));
    hit = link.negated;
  }
  check(hit && zone(e, axe) === 'gy', "targeted by the opponent: on a 3 the effect is negated and that card destroyed");
}

// ======================= Fusion Monsters =======================
section("Alligator's Sword Dragon");
{
  const e = duel([], ['Axe Raider', 'Gyroid'], ["Alligator's Sword Dragon"]);
  const asd = place(e, 0, "Alligator's Sword Dragon")!;
  place(e, 1, 'Axe Raider');
  check(e.canAttackDirectly(asd), 'only EARTH/WATER/FIRE face-up monsters: direct attack');
  place(e, 1, 'Gyroid');
  check(!e.canAttackDirectly(asd), 'a WIND monster stops it');
}

section('Curse of Dragon, the Magical Knight Dragon');
{
  const e = duel(['Spiral Spear Strike'], [], ['Curse of Dragon, the Magical Knight Dragon']);
  const s = toGy(e, 0, 'Spiral Spear Strike');
  place(e, 0, 'Curse of Dragon, the Magical Knight Dragon', 'atk', true, 'yes');
  check(zone(e, s) === 'hand', 'Summoned from the Extra Deck: adds a Spell/Trap that mentions "Gaia the Dragon Champion"');
}

section('Elemental HERO Aqua Neos / Grand Neos');
{
  const e = duel(['Elemental HERO Neos', 'Neo-Spacian Aqua Dolphin', FILL], [], ['Elemental HERO Aqua Neos', 'Elemental HERO Grand Neos']);
  const aq = e.player(0).fusion.find((c) => c.name === 'Elemental HERO Aqua Neos')!;
  run(e, e.specialSummon(aq.uid, 0, 'atk'));
  check(zone(e, aq) === 'fusion', 'cannot be Special Summoned except by its own procedure');
  check(!e.canUseQuickNow(0, aq.uid), 'without the materials it cannot be Contact Fused');
  const n = place(e, 0, 'Elemental HERO Neos')!;
  const d = place(e, 0, 'Neo-Spacian Aqua Dolphin')!;
  quickNow(e, 0, aq);
  check(zone(e, aq) === 'mz' && zone(e, n) === 'deck' && zone(e, d) === 'deck', 'shuffling Neos + Aqua Dolphin into the Deck: Special Summoned from the Extra Deck');
  const opp = e.player(1).hand.length;
  effect(e, 0, aq);
  check(e.player(1).hand.length === opp - 1, 'discard 1: destroys a random card in the opponent\'s hand');
  endTurn(e);
  check(zone(e, aq) === 'fusion', 'End Phase: shuffled back into the Extra Deck');
}
{
  const e = duel(['Elemental HERO Neos', 'Neo-Spacian Grand Mole'], ['Axe Raider'], ['Elemental HERO Grand Neos']);
  const gn = e.player(0).fusion[0];
  place(e, 0, 'Elemental HERO Neos');
  place(e, 0, 'Neo-Spacian Grand Mole');
  quickNow(e, 0, gn);
  const axe = place(e, 1, 'Axe Raider');
  effect(e, 0, gn);
  check(zone(e, gn) === 'mz' && zone(e, axe) === 'hand', 'Grand Neos: Contact Fused, then returns an opponent monster to the hand');
}

section('Fossil Dragon Skullgios');
{
  const e = duel([], ['Gyroid'], ['Fossil Dragon Skullgios']);
  const f = e.player(0).fusion[0];
  run(e, e.specialSummon(f.uid, 0, 'atk'));
  check(zone(e, f) === 'fusion', 'must first be Special Summoned with "Fossil Fusion"');
  const sk = putMZ(e, 0, 'Fossil Dragon Skullgios', { ss: 1, ssExtra: 1 });
  const g = place(e, 1, 'Gyroid', 'def')!;
  e.state.firstTurn = false;
  toBattle(e);
  e.player(1).lp = 10000;
  attack(e, sk, g);
  check(e.player(1).lp === 10000 - 2 * (3500 - 1000), 'piercing, and doubled when Fusion Summoned (5000)');
}
{
  const e = duel([], ['Axe Raider'], ['Fossil Dragon Skullgios']);
  const sk = putMZ(e, 0, 'Fossil Dragon Skullgios');
  const axe = place(e, 1, 'Axe Raider')!;
  e.state.firstTurn = false;
  toBattle(e);
  attack(e, sk, axe, { respond: 'Fossil Dragon Skullgios' });
  check(logHas(e, "switches Axe Raider's ATK and DEF") && e.player(1).lp === 4000 - (3500 - 1150), 'switches the opponent monster\'s ATK and DEF before damage');
}

section('UFOroid Fighter');
{
  const e = duel(['UFOroid', 'Axe Raider'], [], ['UFOroid Fighter']);
  const u = toGy(e, 0, 'UFOroid');
  const a = toGy(e, 0, 'Axe Raider');
  const f = e.player(0).fusion[0];
  (e.state.fx.fusionMatList ??= {})[f.uid] = [u.uid, a.uid];
  const m = place(e, 0, 'UFOroid Fighter')!;
  check(e.atkOf(m) === 2900 && e.defOf(m) === 2900, 'ATK/DEF = the materials\' combined original ATK (1200 + 1700)');
}

// ======================= Spells =======================
section('Frightfur Sanctuary');
{
  const e = duel(['Frightfur Sanctuary'], [], ['Frightfur Tiger', 'Frightfur Wolf']);
  fake(e, 'Frightfur Tiger', { sub: 'Fusion', level: 6, atk: 1900, def: 1200 });
  fake(e, 'Frightfur Wolf', { sub: 'Fusion', level: 6, atk: 2000, def: 1500 });
  const hand = e.player(0).hand.length;
  const fs = playSpell(e, 0, 'Frightfur Sanctuary');
  check(!!fs?.active && e.player(0).gy.filter((c) => c.name.startsWith('Frightfur')).length === 2 && e.player(0).hand.length === hand - 1, 'activated by discarding 1 and sending 2 "Frightfur" monsters from the Extra Deck');
  kill(e, [fs], 'yes');
  check(e.player(0).fusion.some((c) => c.name.startsWith('Frightfur')), 'sent to the GY: a "Frightfur" Fusion returns to the Extra Deck');
}

section('Scroll of Bewitchment');
{
  const e = duel(['Scroll of Bewitchment', 'Axe Raider']);
  const axe = place(e, 0, 'Axe Raider')!;
  const s = playSpell(e, 0, 'Scroll of Bewitchment', { pick: ['Axe Raider'] }, { pick: ['WATER'] });
  check(e.state.fx.declAttr?.[axe.uid] === 'WATER' && s?.equippedTo === axe.uid, 'the equipped monster becomes the chosen Attribute');
  kill(e, [s]);
  check(!e.state.fx.declAttr?.[axe.uid], 'it leaves the field: the Attribute is back');
}

section('Light Barrier');
{
  const e = duel(['Light Barrier', 'Arcana Force XXI - The World'], ['Axe Raider']);
  const lb = playSpell(e, 0, 'Light Barrier');
  check(!!lb?.active && e.player(0).field?.uid === lb.uid, 'activates in the Field Zone');
  const w = place(e, 0, 'Arcana Force XXI - The World', 'atk', true, { pick: ['Tails'] });
  check(w?.tags?.coin === 2 && logHas(e, 'chosen with Light Barrier'), 'an Arcana Force Summoned: you choose the coin result');
  const axe = place(e, 1, 'Axe Raider');
  e.state.firstTurn = false;
  toBattle(e);
  const lp = e.player(0).lp;
  attack(e, w, axe);
  check(zone(e, axe) === 'gy' && e.player(0).lp === lp + 1700, 'an Arcana Force destroys a monster by battle: gain its original ATK');
}

section('Advanced Heraldry Art');
{
  const e = duel(['Advanced Heraldry Art', 'Heraldic Beast Aberconway', 'Heraldic Beast Aberconway']);
  const a = toGy(e, 0, 'Heraldic Beast Aberconway');
  const b = toGy(e, 0, 'Heraldic Beast Aberconway');
  playSpell(e, 0, 'Advanced Heraldry Art');
  check(zone(e, a) === 'mz' && zone(e, b) === 'mz', 'both "Heraldic Beast" monsters are Special Summoned (no Xyz Summon follows)');
}

section('Checkmate');
{
  const e = duel(['Checkmate', 'Terrorking Archfiend', 'Vilepawn Archfiend'], ['Axe Raider']);
  const tk = place(e, 0, 'Terrorking Archfiend')!;
  const v = place(e, 0, 'Vilepawn Archfiend');
  place(e, 1, 'Axe Raider');
  playSpell(e, 0, 'Checkmate', { pick: ['Vilepawn Archfiend'] });
  check(zone(e, v) === 'gy' && e.canAttackDirectly(tk), 'Tribute an Archfiend: Terrorking Archfiend can attack directly this turn');
}

section('Fusion Recovery');
{
  const e = duel(['Polymerization', 'Flame Manipulator', 'Masaki the Legendary Swordsman', 'Fusion Recovery'], [], ['Flame Swordsman']);
  const fm = grab(e, 0, 'Flame Manipulator');
  grab(e, 0, 'Masaki the Legendary Swordsman');
  const poly = grab(e, 0, 'Polymerization');
  playSpell(e, 0, 'Polymerization');
  check(e.monsters(0).some((m) => m.name === 'Flame Swordsman'), '(Polymerization fuses Flame Swordsman)');
  playSpell(e, 0, 'Fusion Recovery', { pick: ['Polymerization'] }, { pick: ['Flame Manipulator'] });
  check(zone(e, poly) === 'hand' && zone(e, fm) === 'hand', 'adds Polymerization and a Fusion Material monster from the GY');
}

section('Soul Exchange');
{
  const e = duel(['Soul Exchange', 'Summoned Skull'], ['Axe Raider']);
  const axe = place(e, 1, 'Axe Raider')!;
  playSpell(e, 0, 'Soul Exchange', { pick: ['Axe Raider'] });
  check(e.controller(axe.uid) === 0, "the opponent's monster can be Tributed by you this turn");
  const gaia = summon(e, 0, 'Summoned Skull', true, { pick: ['Axe Raider'] });
  check(!!gaia && zone(e, axe) === 'gy' && e.find(axe.uid)!.loc.player === 1, 'it is Tributed for a Tribute Summon');
  e.state.firstTurn = false;
  toBattle(e);
  check(!e.canAttackWith(0, gaia!), 'no Battle Phase that turn');
}

section('Anti-Magic Arrows');
{
  const e = duel(['Anti-Magic Arrows'], ["Pikeru's Circle of Enchantment"]);
  e.state.firstTurn = false;
  const t = putST(e, 1, "Pikeru's Circle of Enchantment");
  playSpell(e, 0, 'Anti-Magic Arrows');
  check(e.activationLocked(0, 'spell') && e.activationLocked(1, 'trap') && !e.responsesFor(1, 'main', {}).some((o) => o.uid === t.uid), 'Spell/Trap Cards cannot be activated for the rest of the turn');
  endTurn(e);
  check(!e.activationLocked(1, 'trap'), 'next turn: allowed again');
}

section('Half Shut');
{
  const e = duel(['Half Shut', 'Axe Raider'], ['Gaia The Fierce Knight']);
  const axe = place(e, 0, 'Axe Raider')!;
  const gaia = place(e, 1, 'Gaia The Fierce Knight')!;
  playSpell(e, 0, 'Half Shut', { pick: ['Gaia The Fierce Knight'] });
  check(e.atkOf(gaia) === 1150, 'its ATK is halved');
  e.state.firstTurn = false;
  toBattle(e);
  attack(e, axe, gaia);
  check(zone(e, gaia) === 'mz', 'it cannot be destroyed by battle this turn');
}

// ======================= Traps =======================
section('Number Wall');
{
  const e = duel(['Number Wall', 'Number 49: Fortune Tune']);
  const t = putST(e, 0, 'Number Wall');
  check(!e.canActivateMain(0, t.uid), 'no "Number" monster: cannot be activated');
  const n = putMZ(e, 0, 'Number 49: Fortune Tune');
  act(e, 0, t.uid);
  check(!!e.fieldCard(t.uid)?.active, 'with a "Number" monster: activated');
  kill(e, [n]);
  check(zone(e, n) === 'mz', '"Number" monsters cannot be destroyed by card effects');
  e.state.battle = { attacker: n.uid, target: null };
  check(e.shielded(n, 'battle'), '... nor by battle with a non-"Number" monster');
}

section('A Major Upset');
{
  const e = duel(['A Major Upset', 'Basic Insect'], ['Gaia The Fierce Knight', 'Axe Raider']);
  place(e, 0, 'Basic Insect');
  const g = place(e, 1, 'Gaia The Fierce Knight');
  const axe = place(e, 1, 'Axe Raider');
  playTrap(e, 0, 'A Major Upset');
  check(zone(e, g) === 'hand' && zone(e, axe) === 'mz', 'Tribute a Level 2 or lower: Level 7+ Special Summoned monsters return to the hand');
}

section('Blasting Fuse');
{
  const e = duel(['Blasting Fuse', 'Axe Raider'], ['Gyroid', 'Gyroid', 'Gyroid', 'Trap Hole', 'Trap Hole', 'Trap Hole']);
  const t = putST(e, 0, 'Blasting Fuse');
  check(!e.canActivateMain(0, t.uid), 'column not full: cannot be activated');
  const mine = place(e, 0, 'Axe Raider')!;
  const theirs = [place(e, 1, 'Gyroid'), place(e, 1, 'Gyroid'), place(e, 1, 'Gyroid')];
  const sets = [putST(e, 1, 'Trap Hole'), putST(e, 1, 'Trap Hole'), putST(e, 1, 'Trap Hole')];
  act(e, 0, t.uid);
  check(zone(e, mine) === 'gy' && zone(e, theirs[2]) === 'gy' && zone(e, sets[2]) === 'gy' && zone(e, theirs[0]) === 'mz' && zone(e, sets[0]) === 'sz', 'destroys every card in its column (and nothing else)');
}

section('D.D.D. - Different Dimension Derby');
{
  const e = duel(['Polymerization', 'Flame Manipulator', 'Masaki the Legendary Swordsman', 'D.D.D. - Different Dimension Derby'], ['Axe Raider'], ['Flame Swordsman']);
  const axe = place(e, 1, 'Axe Raider');
  const t = putST(e, 0, 'D.D.D. - Different Dimension Derby');
  check(!e.canActivateMain(0, t.uid), 'no qualifying monster: cannot be activated');
  grab(e, 0, 'Flame Manipulator');
  grab(e, 0, 'Masaki the Legendary Swordsman');
  playSpell(e, 0, 'Polymerization');
  act(e, 0, t.uid, { pick: ['Axe Raider'] });
  check(zone(e, axe) === 'removed', 'a monster Fusion Summoned with Normal Monster materials: banish 1 card on the field');
}

section('Fusion Fright Waltz');
{
  const e = duel(['Fusion Fright Waltz', 'Axe Raider'], ['Gyroid'], ['Frightfur Tiger'], ['Flame Swordsman']);
  fake(e, 'Frightfur Tiger', { sub: 'Fusion', level: 6, atk: 1900, def: 1200 });
  const ft = place(e, 0, 'Frightfur Tiger')!;
  const fs = place(e, 1, 'Flame Swordsman')!;
  const g = place(e, 1, 'Gyroid');
  const axe = place(e, 0, 'Axe Raider');
  const lp0 = e.player(0).lp;
  const lp1 = e.player(1).lp;
  playTrap(e, 0, 'Fusion Fright Waltz');
  check(zone(e, g) === 'gy' && zone(e, axe) === 'gy' && zone(e, ft) === 'mz' && zone(e, fs) === 'mz', 'destroys the other Special Summoned monsters');
  check(e.player(0).lp === lp0 - 3700 && e.player(1).lp === lp1 - 3700, 'each player who lost a monster takes the targets\' combined ATK (3700)');
}

section('Lost Wind');
{
  const e = duel(['Lost Wind'], ['Gaia The Fierce Knight']);
  const g = place(e, 1, 'Gaia The Fierce Knight')!;
  playTrap(e, 0, 'Lost Wind');
  check(e.isNegated(g) && e.atkOf(g) === 1150, "a Special Summoned monster's effects are negated and its original ATK halved");
}
{
  const e = duel(['Lost Wind'], [], [], ['Flame Swordsman']);
  const lw = toGy(e, 0, 'Lost Wind');
  place(e, 1, 'Flame Swordsman', 'atk', true, { respond: 'Lost Wind' });
  const fc = e.fieldCard(lw.uid);
  check(!!fc && !fc.faceUp, 'a monster Special Summoned from the opponent\'s Extra Deck: it Sets itself from the GY');
  kill(e, [fc]);
  check(zone(e, lw) === 'removed', 'banished when it leaves the field');
}

section("Pikeru's Circle of Enchantment");
{
  const e = duel(["Pikeru's Circle of Enchantment"], ['Axe Raider']);
  playTrap(e, 0, "Pikeru's Circle of Enchantment");
  e.damage(0, 800);
  check(e.player(0).lp === 4000, 'damage from card effects becomes 0');
  const axe = place(e, 1, 'Axe Raider');
  e.state.firstTurn = false;
  e.state.turnPlayer = 1;
  toBattle(e);
  attack(e, axe, null);
  check(e.player(0).lp === 2300, 'battle damage still applies');
}

section('Rise of the Snake Deity');
{
  const e = duel(['Rise of the Snake Deity', 'Vennominon the King of Poisonous Snakes', 'Vennominaga the Deity of Poisonous Snakes']);
  fake(e, 'Vennominon the King of Poisonous Snakes', { sub: 'Effect', level: 6, atk: 0, def: 0 });
  fake(e, 'Vennominaga the Deity of Poisonous Snakes', { sub: 'Effect', level: 10, atk: 0, def: 0 });
  const t = putST(e, 0, 'Rise of the Snake Deity');
  check(!e.canActivateMain(0, t.uid), 'nothing destroyed: cannot be activated');
  const v = place(e, 0, 'Vennominon the King of Poisonous Snakes');
  kill(e, [v]);
  act(e, 0, t.uid);
  check(e.monsters(0).some((m) => m.name === 'Vennominaga the Deity of Poisonous Snakes'), 'Vennominon destroyed by an effect: Vennominaga is Special Summoned from the Deck');
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
process.exit(fails ? 1 : 0);
