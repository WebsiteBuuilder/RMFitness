// Speed Duel card scripts of batch 04, audited card by card (run: npx tsx tests/audit-04.test.ts)
// One or more targeted checks per scripted card: its main effect really happens in a duel.
import { Engine } from '../src/eds/engine';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';
import { attrOf } from '../src/eds/speed/helpers';
import type { CardInfo } from '../src/eds/types';

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

const toTurn3 = (e: Engine) => {
  endTurn(e);
  endTurn(e);
};
const hasPrompt = (e: Engine, p: Pid, name: string) => e.state.prompt?.kind === 'response' && e.state.prompt.player === p && e.state.prompt.options.some((o) => o.label.startsWith(name));
const lp = (e: Engine, p: Pid) => e.player(p).lp;

// ---------- audit-04 helpers ----------
// Cards this game's pool lacks ("D/D/D" monsters, "Spirit Message" cards, "Dododo" monsters): test-only stand-ins.
const fake = (info: Partial<CardInfo> & { name: string }) => {
  const full = { id: 980000 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
fake({ name: 'D/D/D Test Overlord', sub: 'Fusion', level: 8, atk: 3000, def: 2000, race: 'Fiend', attribute: 'DARK', desc: '2 "D/D" monsters' });
fake({ name: 'D/D Test Imp', level: 4, atk: 1000, def: 1000, race: 'Fiend', attribute: 'DARK' });
for (const x of ['I', 'N', 'A', 'L']) fake({ name: `Spirit Message "${x}"`, kind: 'trap', sub: 'Continuous', desc: 'This card cannot be activated normally.' });
fake({ name: 'Dododo Test Warrior', level: 4, atk: 1800, def: 1000, race: 'Warrior', attribute: 'EARTH' });

/** Sends a card of `p` from the Deck (or hand) to the GY. */
function toGY(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.hand, ...ps.fusion].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.sendToGrave(c.uid, 'mill'));
  return c;
}
/** Puts a card of `p` on top of the Deck. */
function toTop(e: Engine, p: Pid, name: string): Card {
  const d = e.player(p).deck;
  const i = d.findIndex((x) => x.name === name);
  if (i < 0) throw new Error(`no ${name} in the Deck of ${p}`);
  const [c] = d.splice(i, 1);
  d.unshift(c);
  return c;
}
const inHand = (e: Engine, p: Pid, name: string) => e.player(p).hand.some((c) => c.name === name);
const hand = (e: Engine, p: Pid) => e.player(p).hand.length;
const graveEffect = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'GRAVE_EFFECT', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const special = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'SPECIAL', player: p, uid: c.uid });
  return settle(e, ...ans);
};
/** Empties a player's hand into the GY (without discard effects mattering for the test). */
const clearHand = (e: Engine, p: Pid) => {
  const ps = e.player(p);
  ps.gy.push(...ps.hand.splice(0));
};
const D = (...names: string[]) => [FILL, FILL, FILL, ...names];

// ======================= Monsters =======================
section('Danipon');
{
  const e = duel([FILL], D('Danipon', 'Man-Eater Bug'));
  const dan = place(e, 1, 'Danipon')!;
  const att = place(e, 0, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, att, dan, 'yes');
  check(zone(e, dan) === 'gy' && inHand(e, 1, 'Man-Eater Bug'), 'destroyed by battle: adds an Insect with 1000 or less DEF from the Deck');
}

section('Danmari @Ignister');
{
  const e = duel(['Danmari @Ignister'], D('Gemini Elf'), ['Dark Infant @Ignister']);
  const infant = place(e, 0, 'Dark Infant @Ignister')!;
  const dan = grab(e, 0, 'Danmari @Ignister');
  endTurn(e);
  const foe = place(e, 1, 'Gemini Elf')!;
  toBattle(e);
  attack(e, foe, infant, { respond: 'Danmari' });
  check(zone(e, dan) === 'mz' && zone(e, infant) === 'mz' && lp(e, 0) === 4000, 'an attack on your "@Ignister" monster: Special Summon it from the hand and negate the attack');
}

section('Dark Catapulter');
{
  const e = duel(['Dark Catapulter'], D('Mirror Force'));
  const cat = place(e, 0, 'Dark Catapulter', 'def')!;
  const f = place(e, 0, FILL)!;
  kill(e, [f]);
  const mf = putST(e, 1, 'Mirror Force');
  toTurn3(e);
  check(cat.counters === 1, 'gets a counter in your Standby Phase while in Defense Position');
  effect(e, 0, cat);
  check(zone(e, mf) === 'gy' && zone(e, f) === 'removed' && cat.counters === 0, 'banish 1 card from the GY per counter: destroy that many Spells/Traps, then remove the counters');
}

section('Dark Jeroid');
{
  const e = duel(['Dark Jeroid'], D('Gemini Elf'));
  const elf = place(e, 1, 'Gemini Elf')!;
  summon(e, 0, 'Dark Jeroid', true, { pick: ['Gemini Elf'] });
  check(e.atkOf(elf) === 1100, 'Summoned: the targeted monster loses 800 ATK');
}

section('Dark Lucius LV4');
{
  const e = duel(['Dark Lucius LV4', 'Dark Lucius LV6'], D('Danipon', 'Man-Eater Bug'));
  const lu = place(e, 0, 'Dark Lucius LV4')!;
  const dan = place(e, 1, 'Danipon')!;
  toTurn3(e);
  toBattle(e);
  const h1 = hand(e, 1);
  attack(e, lu, dan, 'yes');
  check(zone(e, dan) === 'gy' && hand(e, 1) === h1 && !inHand(e, 1, 'Man-Eater Bug'), "the effects of the opponent's monsters it destroys by battle are negated");
  endTurn(e);
  endTurn(e, 'yes');
  const lv6 = e.monsters(0).find((m) => m.name === 'Dark Lucius LV6');
  check(zone(e, lu) === 'gy' && !!lv6, 'the Standby Phase of your next turn: sent to the GY to Special Summon "Dark Lucius LV6"');
}

section('Dark Lucius LV6');
{
  const e = duel(['Dark Lucius LV6'], D('Danipon', 'Man-Eater Bug', 'Danipon', 'Man-Eater Bug'));
  const lu = place(e, 0, 'Dark Lucius LV6')!;
  (e.state.fx.lucius6 ??= {})[lu.uid] = 1; // as if Special Summoned by Dark Lucius LV4
  const dan = place(e, 1, 'Danipon')!;
  toTurn3(e);
  toBattle(e);
  attack(e, lu, dan, 'yes');
  check(zone(e, dan) === 'gy' && !inHand(e, 1, 'Man-Eater Bug'), 'Special Summoned by LV4: negates the effects of monsters it destroys by battle');
  check(lu.tags?.luciusKill === e.state.turn, 'it remembers negating an effect (for its LV8 effect)');
}
{
  const e = duel(['Dark Lucius LV6'], D('Danipon', 'Man-Eater Bug'));
  const lu = place(e, 0, 'Dark Lucius LV6')!;
  const dan = place(e, 1, 'Danipon')!;
  toTurn3(e);
  toBattle(e);
  attack(e, lu, dan, 'yes');
  check(inHand(e, 1, 'Man-Eater Bug'), 'not Special Summoned by LV4: no negation');
}

section('Dark Lucius LV8');
{
  const e = duel(['Dark Lucius LV8'], D('Danipon', 'Man-Eater Bug'));
  const lu = place(e, 0, 'Dark Lucius LV8')!;
  (e.state.fx.lucius8 ??= {})[lu.uid] = 1; // as if Special Summoned by Dark Lucius LV6
  const dan = place(e, 1, 'Danipon')!;
  toTurn3(e);
  toBattle(e);
  attack(e, lu, dan, 'yes');
  check(zone(e, dan) === 'removed' && !inHand(e, 1, 'Man-Eater Bug'), 'Special Summoned by LV6: banishes the monsters it destroys by battle and negates their effects');
}

section('Dark Mimic LV1 / LV3');
{
  const e = duel(['Dark Mimic LV1', 'Dark Mimic LV3'], D('Gemini Elf'));
  const m = place(e, 0, 'Dark Mimic LV1', 'def', false)!;
  const h = hand(e, 0);
  run(e, e.flipEffect(m.uid, 0));
  check(hand(e, 0) === h + 1, 'LV1 FLIP: draw 1 card');
  m.faceUp = true;
  endTurn(e);
  endTurn(e, 'yes');
  const lv3 = e.monsters(0).find((x) => x.name === 'Dark Mimic LV3')!;
  check(zone(e, m) === 'gy' && !!lv3, 'LV1: in your Standby Phase, send it to the GY to Special Summon LV3 from the Deck');
  endTurn(e);
  const elf = place(e, 1, 'Gemini Elf')!;
  toBattle(e);
  const h2 = hand(e, 0);
  attack(e, elf, lv3);
  check(zone(e, lv3) === 'gy' && hand(e, 0) === h2 + 2, 'LV3 Special Summoned by LV1, destroyed by battle: draw 2 cards');
}
{
  const e = duel(['Dark Mimic LV3'], D('Gemini Elf'));
  const lv3 = place(e, 0, 'Dark Mimic LV3')!;
  endTurn(e);
  const elf = place(e, 1, 'Gemini Elf')!;
  toBattle(e);
  const h = hand(e, 0);
  attack(e, elf, lv3);
  check(hand(e, 0) === h + 1, 'LV3 Summoned another way: draw 1 card');
}

section('Dark Paladin');
{
  const e = duel(['Blue-Eyes White Dragon', FILL], D('Pot of Greed'), ['Dark Paladin']);
  const dp = place(e, 0, 'Dark Paladin')!;
  toGY(e, 0, 'Blue-Eyes White Dragon');
  check(e.atkOf(dp) === 3400, 'gains 500 ATK for each Dragon on the field and in the GY');
  endTurn(e);
  const h0 = hand(e, 0);
  const pot = grab(e, 1, 'Pot of Greed');
  const h1 = hand(e, 1);
  act(e, 1, pot.uid, { respond: 'Dark Paladin' });
  check(zone(e, pot) === 'gy' && hand(e, 1) === h1 - 1 && hand(e, 0) === h0 - 1, 'discard 1 card: negates a Spell activation and destroys it');
  check(e.summonBlocked(0, dp, 'special', 'gy'), 'must be Fusion Summoned (it cannot be Special Summoned from the GY)');
}

section('Dark Scorpion - Chick the Yellow');
{
  const e = duel(['Dark Scorpion - Chick the Yellow'], D('Mirror Force'));
  const ch = place(e, 0, 'Dark Scorpion - Chick the Yellow')!;
  const mf = putST(e, 1, 'Mirror Force');
  toTurn3(e);
  toBattle(e);
  attack(e, ch, null, { pick: ['Return 1 card on the field to the hand'] }, { pick: ['Face-down card'] });
  check(zone(e, mf) === 'hand', 'battle damage: return 1 card on the field to the hand');
}

section('Dark Scorpion - Cliff the Trap Remover');
{
  const e = duel(['Dark Scorpion - Cliff the Trap Remover'], D());
  const cl = place(e, 0, 'Dark Scorpion - Cliff the Trap Remover')!;
  toTurn3(e);
  toBattle(e);
  const gy = e.player(1).gy.length;
  attack(e, cl, null, { pick: ["Send the top 2 cards of your opponent's Deck to the GY"] });
  check(e.player(1).gy.length === gy + 2, "battle damage: send the top 2 cards of the opponent's Deck to the GY");
}

section('Dark Scorpion - Gorg the Strong');
{
  const e = duel(['Dark Scorpion - Gorg the Strong'], D('Gemini Elf'));
  const g = place(e, 0, 'Dark Scorpion - Gorg the Strong')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  const f = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, g, f, { pick: ["Return 1 of your opponent's monsters to the top of the Deck"] }, { pick: ['Gemini Elf'] });
  check(e.player(1).deck[0]?.uid === elf.uid, "battle damage: return 1 of the opponent's monsters to the top of the Deck");
}

section('Dark Scorpion - Meanae the Thorn');
{
  const e = duel(['Dark Scorpion - Meanae the Thorn', 'Dark Scorpion - Chick the Yellow'], D());
  const m = place(e, 0, 'Dark Scorpion - Meanae the Thorn')!;
  toTurn3(e);
  toBattle(e);
  attack(e, m, null, { pick: ['Add 1 "Dark Scorpion" card from your Deck to your hand'] });
  check(inHand(e, 0, 'Dark Scorpion - Chick the Yellow'), 'battle damage: add 1 "Dark Scorpion" card from the Deck');
}

section('Don Zaloog');
{
  const e = duel(['Don Zaloog'], D());
  const dz = place(e, 0, 'Don Zaloog')!;
  toTurn3(e);
  toBattle(e);
  const h = hand(e, 1);
  attack(e, dz, null, { pick: ["Discard 1 random card from your opponent's hand"] });
  check(hand(e, 1) === h - 1, "battle damage: discard 1 random card from the opponent's hand");
}

section('Dark Driceratops / Elemental HERO Bladedge');
for (const name of ['Dark Driceratops', 'Elemental HERO Bladedge']) {
  const e = duel([name], D());
  const m = place(e, 0, name)!;
  const d = place(e, 1, FILL, 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, m, d);
  check(lp(e, 1) === 4000 - (e.atkOf(m) - 1200), `${name}: piercing battle damage`);
}

section('Dark Summoning Beast');
{
  const e = duel(['Dark Summoning Beast', 'Raviel, Lord of Phantasms', 'Hamon, Lord of Striking Thunder']);
  const b = place(e, 0, 'Dark Summoning Beast')!;
  effect(e, 0, b, { pick: ['Raviel, Lord of Phantasms'] });
  check(zone(e, b) === 'gy' && e.monsters(0).some((m) => m.name === 'Raviel, Lord of Phantasms'), 'Tribute it: Special Summon a Sacred Beast from the Deck, ignoring its Summoning conditions');
  check((e.state.fx.noDeclare as number[])[0] === e.state.turn, 'your monsters cannot attack for the rest of the turn');
  graveEffect(e, 0, b);
  check(zone(e, b) === 'removed' && inHand(e, 0, 'Hamon, Lord of Striking Thunder'), 'banished from the GY: add a Sacred Beast from the Deck');
}

section('Darklord Nasten');
{
  const e = duel(['Darklord Nasten', 'Darklord Contact', 'Darklord Enchantment'], D('Gemini Elf'));
  const n = grab(e, 0, 'Darklord Nasten');
  grab(e, 0, 'Darklord Contact');
  const ench = grab(e, 0, 'Darklord Enchantment');
  effect(e, 0, n, { pick: ['Darklord Contact', 'Darklord Enchantment'] });
  check(zone(e, n) === 'mz' && zone(e, ench) === 'gy', 'discard 2 other "Darklord" cards: Special Summon it from the hand');
  const elf = place(e, 1, 'Gemini Elf')!;
  e.apply({ type: 'QUICK_EFFECT', player: 0, uid: n.uid });
  settle(e, { pick: ['Darklord Enchantment'] }, { pick: ['Gemini Elf'] });
  check(lp(e, 0) === 3000 && e.controller(elf.uid) === 0 && zone(e, ench) === 'deck', 'pay 1000 LP: apply a "Darklord" Spell/Trap in the GY, then shuffle it into the Deck');
}

section('Decayed Commander');
{
  const e = duel(['Decayed Commander', 'Zombie Tiger'], D());
  grab(e, 0, 'Zombie Tiger');
  const dc = summon(e, 0, 'Decayed Commander', true, 'yes');
  check(e.monsters(0).some((m) => m.name === 'Zombie Tiger'), 'Normal Summoned: Special Summon "Zombie Tiger" from the hand');
  toTurn3(e);
  toBattle(e);
  const h = hand(e, 1);
  attack(e, dc, null);
  check(hand(e, 1) === h - 1, 'battle damage by a direct attack: discard 1 random card from the opponent\'s hand');
}

section('Dekoichi the Battlechanted Locomotive');
{
  const e = duel(['Dekoichi the Battlechanted Locomotive', 'Bokoichi the Freightening Car']);
  place(e, 0, 'Bokoichi the Freightening Car');
  const d = place(e, 0, 'Dekoichi the Battlechanted Locomotive', 'def', false)!;
  const h = hand(e, 0);
  run(e, e.flipEffect(d.uid, 0));
  check(hand(e, 0) === h + 2, 'FLIP: draw 1 card, +1 for each face-up "Bokoichi"');
}

section('Delta The Magnet Warrior');
{
  const e = duel(['Delta The Magnet Warrior', 'Alpha The Magnet Warrior', 'Beta The Magnet Warrior', 'Alpha The Magnet Warrior', 'Valkyrion the Magna Warrior']);
  const d = place(e, 0, 'Delta The Magnet Warrior', 'atk', true, 'yes', { pick: ['Alpha The Magnet Warrior'] })!;
  check(e.player(0).gy.some((c) => c.name === 'Alpha The Magnet Warrior'), 'Summoned: send a Level 4 or lower "Magnet Warrior" from the Deck to the GY');
  toGY(e, 0, 'Beta The Magnet Warrior');
  toGY(e, 0, 'Alpha The Magnet Warrior');
  kill(e, [d], 0, 'yes');
  check(e.monsters(0).some((m) => m.name === 'Valkyrion the Magna Warrior') && e.player(0).removed.length === 3, 'sent to the GY: banish 3 "Magnet Warriors" to Special Summon Valkyrion from the Deck');
}

section('Delta Tri');
{
  const e = duel(['Delta Tri', 'Machina Peacekeeper'], D('Bokoichi the Freightening Car'));
  const dt = place(e, 0, 'Delta Tri')!;
  const pk = toGY(e, 0, 'Machina Peacekeeper');
  const b = place(e, 1, 'Bokoichi the Freightening Car')!;
  toTurn3(e);
  toBattle(e);
  attack(e, dt, b, { pick: ['Equip a Union monster from your GY to it'] });
  check(zone(e, pk) === 'sz' && dt.equips.includes(pk.uid), 'destroys a monster by battle: equip an appropriate Union monster from the GY to it');
}
{
  const e = duel(['Delta Tri'], D('Bokoichi the Freightening Car'));
  const dt = place(e, 0, 'Delta Tri')!;
  const b = place(e, 1, 'Bokoichi the Freightening Car')!;
  toTurn3(e);
  toBattle(e);
  const h = hand(e, 0);
  attack(e, dt, b);
  check(logHas(e, 'Delta Tri is put into the Deck') && zone(e, dt) !== 'mz' && hand(e, 0) === h + 1, 'or: return a LIGHT Machine monster you control to the Deck and draw 1 card');
}

section('Des Feral Imp');
{
  const e = duel(['Des Feral Imp', 'Pot of Greed']);
  const pot = toGY(e, 0, 'Pot of Greed');
  const m = place(e, 0, 'Des Feral Imp', 'def', false)!;
  run(e, e.flipEffect(m.uid, 0));
  check(zone(e, pot) === 'deck', 'FLIP: shuffle a card from your GY into the Deck');
}

section('Des Kangaroo');
{
  const e = duel(['Des Kangaroo'], D());
  const k = place(e, 0, 'Des Kangaroo', 'def')!;
  endTurn(e);
  const f = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, f, k);
  check(zone(e, f) === 'gy' && zone(e, k) === 'mz', 'attacked in Defense Position by a monster with less ATK than its DEF: destroy the attacker');
}

section('Des Koala');
{
  const e = duel(['Des Koala'], D());
  const k = place(e, 0, 'Des Koala', 'def', false)!;
  const n = hand(e, 1);
  run(e, e.flipEffect(k.uid, 0));
  check(lp(e, 1) === 4000 - 400 * n, "FLIP: 400 damage for each card in the opponent's hand");
}

section('Des Lacooda');
{
  const e = duel(['Des Lacooda']);
  const l = place(e, 0, 'Des Lacooda')!;
  effect(e, 0, l);
  check(!l.faceUp && l.pos === 'def', 'once per turn: change it to face-down Defense Position');
  toTurn3(e);
  const h = hand(e, 0);
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: l.uid });
  settle(e);
  check(l.faceUp && hand(e, 0) === h + 1, 'Flip Summoned: draw 1 card');
}

section('Desert Twister');
{
  const e = duel(['Desert Twister', 'Harpie Lady', 'Elemental HERO Avian'], D('Mirror Force'));
  toGY(e, 0, 'Harpie Lady');
  toGY(e, 0, 'Elemental HERO Avian');
  const f = place(e, 0, FILL)!;
  kill(e, [f]);
  const tw = grab(e, 0, 'Desert Twister');
  check(!e.canNormalSummon(0, tw), 'cannot be Normal Summoned');
  special(e, 0, tw);
  check(zone(e, tw) === 'mz' && e.player(0).removed.length === 3, 'Special Summoned from the hand by banishing 2 WIND and 1 EARTH monsters from the GY');
  const mf = putST(e, 1, 'Mirror Force');
  effect(e, 0, tw);
  check(zone(e, mf) === 'gy', 'discard 1 card: destroy a Spell/Trap');
}

section('Despair from the Dark');
{
  const e = duel(['Despair from the Dark', 'Despair from the Dark', 'Despair from the Dark'], D());
  const a = grab(e, 0, 'Despair from the Dark');
  run(e, e.as(1, e.discard(0, a.uid)));
  check(zone(e, a) === 'mz', "discarded by the opponent's card effect: Special Summon it");
  const b = e.player(0).deck.find((c) => c.name === 'Despair from the Dark')!;
  run(e, e.as(1, e.sendToGrave(b.uid, 'mill')));
  check(zone(e, b) === 'mz', "sent from the Deck by the opponent's card effect: Special Summon it");
  const c = grab(e, 0, 'Despair from the Dark');
  run(e, e.as(0, e.discard(0, c.uid)));
  check(zone(e, c) === 'gy', 'by your own card effect: it stays in the GY');
}

section('Destiny End Dragoon');
{
  const e = duel(['Destiny HERO - Diamond Dude'], D('Gemini Elf'), ['Destiny End Dragoon']);
  const dr = place(e, 0, 'Destiny End Dragoon')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  effect(e, 0, dr);
  check(zone(e, elf) === 'gy' && lp(e, 1) === 4000 - 1900, "destroys an opponent's monster and inflicts damage equal to its ATK");
  check((e.state.fx.noDeclare as number[])[0] === e.state.turn, 'you cannot conduct your Battle Phase that turn');
  kill(e, [dr]);
  toGY(e, 0, 'Destiny HERO - Diamond Dude');
  endTurn(e);
  endTurn(e, 'yes');
  check(zone(e, dr) === 'mz', 'in your Standby Phase: banish a "Destiny HERO" card from the GY to Special Summon it');
}

section('Destiny HERO - Blade Master');
{
  const e = duel(['Destiny HERO - Diamond Dude', 'Destiny HERO - Blade Master'], D('Gemini Elf'));
  const dd = place(e, 0, 'Destiny HERO - Diamond Dude')!;
  const bm = grab(e, 0, 'Destiny HERO - Blade Master');
  endTurn(e);
  const elf = place(e, 1, 'Gemini Elf')!;
  toBattle(e);
  attack(e, elf, dd, { respond: 'Destiny HERO - Blade Master' });
  check(zone(e, bm) === 'gy' && zone(e, elf) === 'gy' && zone(e, dd) === 'mz', "during the opponent's Battle Phase: discard it, your \"Destiny HERO\" monsters gain 800 ATK");
}

section('Destiny HERO - Dasher');
{
  const e = duel(['Destiny HERO - Dasher'], D());
  const da = place(e, 0, 'Destiny HERO - Dasher')!;
  const f = place(e, 0, FILL)!;
  effect(e, 0, da, { pick: [FILL] });
  check(zone(e, f) === 'gy' && e.atkOf(da) === 3100, 'Tribute 1 other monster: it gains 1000 ATK');
  toTurn3(e);
  toBattle(e);
  attack(e, da, null);
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  settle(e);
  check(da.pos === 'def', 'it attacked: changed to Defense Position at the end of the Battle Phase');
}
{
  const e = duel(['Destiny HERO - Dasher', 'Gemini Elf']);
  const da = toGY(e, 0, 'Destiny HERO - Dasher');
  endTurn(e);
  toTop(e, 0, 'Gemini Elf');
  endTurn(e, 'yes');
  check(e.monsters(0).some((m) => m.name === 'Gemini Elf') && zone(e, da) === 'gy', 'in the GY: reveal a monster drawn in the Draw Phase and Special Summon it');
}

section('Destiny HERO - Diamond Dude');
{
  const e = duel(['Destiny HERO - Diamond Dude', 'Pot of Greed']);
  const dd = place(e, 0, 'Destiny HERO - Diamond Dude')!;
  const pot = toTop(e, 0, 'Pot of Greed');
  effect(e, 0, dd);
  check(zone(e, pot) === 'gy', 'excavates the top card: a Normal Spell goes to the GY');
  toTurn3(e);
  const h = hand(e, 0);
  effect(e, 0, dd, { pick: ['Apply the Spell excavated last turn'] });
  check(hand(e, 0) === h + 2, 'next turn: apply that Spell\'s effect from the GY');
}

section('Destiny HERO - Dogma');
{
  const e = duel(['Destiny HERO - Dogma', 'Destiny HERO - Diamond Dude'], D());
  place(e, 0, 'Destiny HERO - Diamond Dude');
  place(e, 0, FILL);
  place(e, 0, FILL);
  const dg = grab(e, 0, 'Destiny HERO - Dogma');
  check(!e.canNormalSummon(0, dg), 'cannot be Normal Summoned');
  special(e, 0, dg, { pick: ['Destiny HERO - Diamond Dude', FILL, FILL] });
  check(zone(e, dg) === 'mz', 'Special Summoned by Tributing 3 monsters including a "Destiny HERO"');
  endTurn(e);
  check(lp(e, 1) === 2000, "the opponent's next Standby Phase: halves their LP");
}

section('Destiny HERO - Fear Monger');
{
  const e = duel(['Destiny HERO - Fear Monger', 'Destiny HERO - Diamond Dude'], D('Gemini Elf'));
  const fm = place(e, 0, 'Destiny HERO - Fear Monger')!;
  toGY(e, 0, 'Destiny HERO - Diamond Dude');
  endTurn(e);
  const elf = place(e, 1, 'Gemini Elf')!;
  toBattle(e);
  attack(e, elf, fm);
  check(zone(e, fm) === 'gy', 'destroyed by battle');
  endTurn(e);
  check(e.monsters(0).some((m) => m.name === 'Destiny HERO - Diamond Dude'), 'your next Standby Phase: Special Summon a "Destiny HERO" from the GY');
}

section('Destiny HERO - Malicious');
{
  const e = duel(['Destiny HERO - Malicious', 'Destiny HERO - Malicious']);
  const a = toGY(e, 0, 'Destiny HERO - Malicious');
  graveEffect(e, 0, a);
  check(zone(e, a) === 'removed' && e.monsters(0).some((m) => m.name === 'Destiny HERO - Malicious'), 'banish it from the GY: Special Summon a "Destiny HERO - Malicious" from the Deck');
}

section('Destiny HERO - Plasma');
{
  const e = duel(['Destiny HERO - Plasma'], D('Kuriboh', 'Gemini Elf'));
  const ku = place(e, 1, 'Kuriboh')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  place(e, 0, FILL);
  place(e, 0, FILL);
  place(e, 0, FILL);
  const pl = grab(e, 0, 'Destiny HERO - Plasma');
  special(e, 0, pl);
  check(zone(e, pl) === 'mz' && e.monsters(0).length === 1, 'Special Summoned by Tributing 3 monsters');
  check(e.isNegated(ku), "the effects of face-up monsters the opponent controls are negated");
  effect(e, 0, pl, { pick: ['Gemini Elf'] });
  const me = e.fieldCard(pl.uid)!;
  check(zone(e, elf) === 'sz' && me.equips.includes(elf.uid) && e.atkOf(me) === 1900 + 950, "equips an opponent's monster to it and gains half its original ATK");
  kill(e, [pl]);
  check(!e.isNegated(ku), 'the negation ends when it leaves the field');
}

section('Destroyersaurus');
{
  const e = duel(['Destroyersaurus', 'Jurassic World']);
  const d = grab(e, 0, 'Destroyersaurus');
  effect(e, 0, d);
  check(zone(e, d) === 'gy' && inHand(e, 0, 'Jurassic World'), 'discard it: add "Jurassic World" from the Deck');
}

section('Destructotron');
{
  const e = duel(['Destructotron'], D('Mirror Force'));
  const d = place(e, 0, 'Destructotron')!;
  const mf = putST(e, 1, 'Mirror Force');
  effect(e, 0, d);
  check(zone(e, mf) === 'gy' && lp(e, 0) === 3000, "pay 1000 LP: destroy a Set Spell/Trap the opponent controls");
  endTurn(e);
  check(zone(e, d) === 'gy', 'End Phase: destroyed while it is the only Psychic you control');
}

section('Dimensional Alchemist');
{
  const e = duel(['Dimensional Alchemist', 'Gemini Elf']);
  const a = place(e, 0, 'Dimensional Alchemist')!;
  const top = toTop(e, 0, 'Gemini Elf');
  effect(e, 0, a);
  check(zone(e, top) === 'removed' && e.atkOf(a) === 1800, 'banish the top card of the Deck: it gains 500 ATK');
  kill(e, [a], 1, 'yes');
  check(zone(e, top) === 'hand', 'destroyed: add 1 of your banished monsters to the hand');
}

section('Diskblade Rider');
{
  const e = duel(['Diskblade Rider', 'Mirror Force']);
  const d = place(e, 0, 'Diskblade Rider')!;
  const mf = toGY(e, 0, 'Mirror Force');
  effect(e, 0, d);
  check(zone(e, mf) === 'removed' && e.atkOf(d) === 2200, 'banish a Normal Trap from the GY: it gains 500 ATK');
  endTurn(e);
  check(e.atkOf(d) === 2200, "...until the end of the opponent's turn");
  endTurn(e);
  check(e.atkOf(d) === 1700, 'then it ends');
}

section('Divine Dragon Lord Felgrand');
{
  const e = duel(['Divine Dragon Lord Felgrand', 'Red-Eyes Black Dragon'], D('Gemini Elf', FILL));
  toGY(e, 0, 'Divine Dragon Lord Felgrand');
  const elf = place(e, 1, 'Gemini Elf')!;
  const fg = place(e, 0, 'Divine Dragon Lord Felgrand', 'atk', true, 'yes', { pick: ['Gemini Elf'] })!;
  check(zone(e, elf) === 'removed' && e.atkOf(fg) === 3200, "Special Summoned from the GY: banish an opponent's monster, gain its Level x100 ATK/DEF");
  const red = toGY(e, 0, 'Red-Eyes Black Dragon');
  const f = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, fg, f, 'yes');
  check(zone(e, red) === 'mz', 'destroys a monster by battle: Special Summon a Level 7 or 8 Dragon from a GY');
}
{
  const e = duel(['Divine Dragon Lord Felgrand'], D('Gemini Elf'));
  place(e, 1, 'Gemini Elf');
  const fg = place(e, 0, 'Divine Dragon Lord Felgrand', 'atk', true, 'yes')!;
  check(e.atkOf(fg) === 2800 && e.monsters(1).length === 1, 'Special Summoned from the Deck: no banish');
}

section('Dogoran, the Mad Flame Kaiju');
{
  const e = duel(['Dogoran, the Mad Flame Kaiju', 'Dogoran, the Mad Flame Kaiju'], D());
  const f = place(e, 1, FILL)!;
  const dg = grab(e, 0, 'Dogoran, the Mad Flame Kaiju');
  special(e, 0, dg);
  check(zone(e, f) === 'gy' && e.controller(dg.uid) === 1, "Tribute 1 monster the opponent controls: Special Summon it to their field");
  check(e.summonBlocked(1, e.player(0).deck.find((c) => c.name === 'Dogoran, the Mad Flame Kaiju')!, 'special', 'hand'), 'you can only control 1 "Kaiju" monster');
}

section('Doomcaliber Knight');
{
  const e = duel(['Doomcaliber Knight'], D('Destiny HERO - Diamond Dude'));
  check(e.summonBlocked(0, e.player(0).deck.find((c) => c.name === 'Doomcaliber Knight')!, 'special', 'deck'), 'cannot be Special Summoned');
  const dk = summon(e, 0, 'Doomcaliber Knight')!;
  endTurn(e);
  const dd = place(e, 1, 'Destiny HERO - Diamond Dude')!;
  effect(e, 1, dd, { respond: 'Doomcaliber Knight' });
  check(zone(e, dk) === 'gy' && zone(e, dd) === 'gy', 'Tribute it: negate a monster effect activation and destroy that monster');
}

section('Doomdog Octhros');
{
  const e = duel(['Doomdog Octhros', 'Invader of Darkness']);
  const d = place(e, 0, 'Doomdog Octhros')!;
  kill(e, [d]);
  check(inHand(e, 0, 'Invader of Darkness'), 'sent from the field to the GY: add a Level 8 Fiend from the Deck');
}

section('Dr. Frankenderp');
{
  const e = duel(['Dr. Frankenderp', 'Pot of Greed']);
  const pot = toTop(e, 0, 'Pot of Greed');
  summon(e, 0, 'Dr. Frankenderp', true, 'yes', { pick: ['Add it to your hand (skip your next Draw Phase)'] });
  check(lp(e, 0) === 3500 && zone(e, pot) === 'hand' && e.state.fx.skipDraw === 0, 'pay 500 LP: add the top card to the hand and skip your next Draw Phase');
}

section('Drillago');
{
  const e = duel(['Drillago'], D('Gemini Elf'));
  const dr = place(e, 0, 'Drillago')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  check(e.canAttackDirectly(dr), 'the opponent controls only face-up monsters with 1600+ ATK: it can attack directly');
  place(e, 1, FILL);
  check(!e.canAttackDirectly(dr) && !!elf, 'not with a weaker monster there');
}

section('Drillroid');
{
  const e = duel(['Drillroid'], D('Mystical Elf'));
  const dr = place(e, 0, 'Drillroid')!;
  const elf = place(e, 1, 'Mystical Elf', 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, dr, elf);
  check(zone(e, elf) === 'gy' && lp(e, 0) === 4000 && zone(e, dr) === 'mz', 'attacking a Defense Position monster: destroys it before damage calculation');
}

section('Duoterion');
{
  const e = duel(['Duoterion', 'Duoterion', 'Bonding - H2O', 'Hydrogeddon']);
  const d = grab(e, 0, 'Duoterion');
  effect(e, 0, d);
  check(zone(e, d) === 'gy' && inHand(e, 0, 'Bonding - H2O'), 'discard it: add a "Bonding" Spell/Trap from the Deck');
  const hy = toGY(e, 0, 'Hydrogeddon');
  place(e, 0, 'Duoterion', 'atk', true, 'yes', { pick: ['Hydrogeddon'] });
  check(zone(e, hy) === 'mz', 'Summoned: Special Summon "Hydrogeddon"/"Oxygeddon"/"Duoterion" from the GY');
}

section('Dust Knight');
{
  const e = duel(['Dust Knight', 'Masaki the Legendary Swordsman']);
  const d = place(e, 0, 'Dust Knight', 'def', false)!;
  run(e, e.flipEffect(d.uid, 0), { pick: ['Masaki the Legendary Swordsman'] });
  check(e.player(0).gy.some((c) => c.name === 'Masaki the Legendary Swordsman'), 'FLIP: send an EARTH monster from the Deck to the GY');
}

section('Dweller in the Depths');
{
  const e = duel(['Dweller in the Depths', 'Frightfur Sanctuary']);
  const d = place(e, 0, 'Dweller in the Depths')!;
  const fs = putST(e, 0, 'Frightfur Sanctuary');
  fs.faceUp = true;
  fs.active = true;
  check(e.atkOf(d) === 1800, 'gains 300 ATK for each Continuous Spell in your Spell & Trap Zone');
}

section('Dyna Base');
{
  const e = duel(['Dyna Base', 'Hydrogeddon'], D(), ['Dyna Tank']);
  e.player(0).lp = 3000;
  const db = grab(e, 0, 'Dyna Base');
  special(e, 0, db);
  check(zone(e, db) === 'mz', 'your LP are lower: Special Summon it from the hand');
  grab(e, 0, 'Hydrogeddon');
  effect(e, 0, db);
  check(e.monsters(0).some((m) => m.name === 'Dyna Tank') && zone(e, db) === 'gy', 'Fusion Summon using it and a monster from the hand');
}

section('Eater of Millions');
{
  const e = duel(['Eater of Millions'], D('Gemini Elf'), ['Flame Swordsman', 'Flame Swordsman', 'Flame Swordsman', 'Flame Swordsman', 'Flame Swordsman']);
  const eat = grab(e, 0, 'Eater of Millions');
  check(!e.canNormalSummon(0, eat), 'cannot be Normal Summoned');
  special(e, 0, eat, { pick: ['Flame Swordsman', 'Flame Swordsman', 'Flame Swordsman', 'Flame Swordsman', 'Flame Swordsman'] });
  const me = e.fieldCard(eat.uid)!;
  check(!!me && e.atkOf(me) === 500 && e.defOf(me) === 500, 'Special Summoned by banishing 5 cards face-down; gains 100 ATK/DEF for each');
  check(e.untributable(me), 'cannot be Tributed');
  const elf = place(e, 1, 'Gemini Elf')!;
  toTurn3(e);
  toBattle(e);
  attack(e, me, elf, 'yes');
  check(zone(e, elf) === 'removed' && e.atkOf(me) === 600, 'battling an opponent\'s monster: banish it face-down');
}

section('Edge Imp Chain');
{
  const e = duel(['Edge Imp Chain', 'Edge Imp Chain', 'Frightfur Sanctuary'], D());
  const c = place(e, 0, 'Edge Imp Chain')!;
  toTurn3(e);
  toBattle(e);
  e.apply({ type: 'ATTACK', player: 0, uid: c.uid, target: null });
  settle(e, { respond: 'Edge Imp Chain' });
  check(e.player(0).hand.filter((x) => x.name === 'Edge Imp Chain').length === 1, 'declares an attack: add "Edge Imp Chain" from the Deck');
}
{
  const e = duel(['Edge Imp Chain', 'Frightfur Sanctuary']);
  const c = place(e, 0, 'Edge Imp Chain')!;
  kill(e, [c], 0, 'yes');
  check(inHand(e, 0, 'Frightfur Sanctuary'), 'sent from the field to the GY: add a "Frightfur" card from the Deck');
}

section('Element Saurus');
{
  const e = duel(['Element Saurus', 'Elemental HERO Burstinatrix'], D('Danipon', 'Man-Eater Bug'));
  const s = place(e, 0, 'Element Saurus')!;
  check(e.atkOf(s) === 1500, 'no FIRE monster: no bonus');
  place(e, 0, 'Elemental HERO Burstinatrix');
  check(e.atkOf(s) === 2000, 'FIRE monster on the field: gains 500 ATK');
  place(e, 0, FILL); // EARTH
  const dan = place(e, 1, 'Danipon')!;
  toTurn3(e);
  toBattle(e);
  attack(e, s, dan, 'yes');
  check(zone(e, dan) === 'gy' && !inHand(e, 1, 'Man-Eater Bug'), 'EARTH monster on the field: negates the effects of monsters it destroys by battle');
}

section('Elemental HERO Blazeman');
{
  const e = duel(['Elemental HERO Blazeman', 'Polymerization']);
  summon(e, 0, 'Elemental HERO Blazeman', true, 'yes');
  check(inHand(e, 0, 'Polymerization'), 'Summoned: add "Polymerization" from the Deck');
}
{
  const e = duel(['Elemental HERO Blazeman', 'Elemental HERO Sparkman']);
  const b = place(e, 0, 'Elemental HERO Blazeman')!;
  effect(e, 0, b);
  check(e.player(0).gy.some((c) => c.name === 'Elemental HERO Sparkman') && e.atkOf(b) === 1600 && e.defOf(b) === 1400 && attrOf(e, b) === 'LIGHT', 'send an "Elemental HERO" to the GY: it takes its Attribute and ATK/DEF');
  check(e.summonBlocked(0, grab(e, 0, FILL), 'special', 'hand') && !e.summonBlocked(0, 'Flame Swordsman', 'special', 'fusion'), 'you cannot Special Summon except Fusion Monsters this turn');
  endTurn(e);
  check(attrOf(e, b) === 'FIRE' && e.atkOf(b) === 1200, 'until the end of the turn');
}

section('Elemental HERO Bubbleman');
{
  const e = duel(['Elemental HERO Bubbleman']);
  clearHand(e, 0);
  const b = grab(e, 0, 'Elemental HERO Bubbleman');
  special(e, 0, b, 'yes');
  check(zone(e, b) === 'mz' && hand(e, 0) === 2, 'the only card in the hand: Special Summon it; then draw 2 with no other cards');
}

// ======================= Spells =======================
section('Dark Calling');
{
  const e = duel(['Dark Calling', 'Elemental HERO Avian', 'Elemental HERO Burstinatrix'], D(), ['Evil HERO Inferno Wing']);
  const av = grab(e, 0, 'Elemental HERO Avian');
  const bu = toGY(e, 0, 'Elemental HERO Burstinatrix');
  playSpell(e, 0, 'Dark Calling');
  check(e.monsters(0).some((m) => m.name === 'Evil HERO Inferno Wing') && zone(e, av) === 'removed' && zone(e, bu) === 'removed', 'banish the materials from the hand and GY: Fusion Summon a "Dark Fusion" monster');
}

section('Dark City');
{
  const e = duel(['Dark City', 'Destiny HERO - Diamond Dude'], D('Gemini Elf'));
  playSpell(e, 0, 'Dark City');
  const dd = place(e, 0, 'Destiny HERO - Diamond Dude')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  toTurn3(e);
  toBattle(e);
  attack(e, dd, elf);
  check(zone(e, elf) === 'gy' && zone(e, dd) === 'mz', 'a weaker "Destiny HERO" attacking gains 1000 ATK');
}

section('Dark Contract with Patent License');
{
  const e = duel(['Dark Contract with Patent License', 'D/D Test Imp'], D(), ['D/D/D Test Overlord'], ['Flame Swordsman', 'Flame Swordsman']);
  const dc = playSpell(e, 0, 'Dark Contract with Patent License')!;
  place(e, 0, 'D/D/D Test Overlord');
  endTurn(e);
  place(e, 1, 'Flame Swordsman', 'atk', true, 'yes');
  check(lp(e, 1) === 3000, 'the opponent Special Summons a monster of the same card type as your "D/D/D": 1000 damage');
  const fs2 = e.player(1).fusion.find((c) => c.name === 'Flame Swordsman')!;
  check(e.summonBlocked(1, fs2, 'special', 'fusion') && !e.summonBlocked(1, grab(e, 1, FILL), 'special', 'hand'), 'they cannot Special Summon that card type again this turn');
  const imp = toGY(e, 0, 'D/D Test Imp');
  kill(e, [dc], 1, 'yes');
  check(zone(e, imp) === 'hand', 'sent to the GY: add a "D/D" monster from the GY to the hand');
}

section('Dark Eruption');
{
  const e = duel(['Dark Eruption', 'Dark Mimic LV1']);
  const m = toGY(e, 0, 'Dark Mimic LV1');
  playSpell(e, 0, 'Dark Eruption');
  check(zone(e, m) === 'hand', 'adds a DARK monster with 1500 or less ATK from the GY');
}

section('Dark Factory of Mass Production');
{
  const e = duel(['Dark Factory of Mass Production', 'Gemini Elf', 'Mystical Elf']);
  const a = toGY(e, 0, 'Gemini Elf');
  const b = toGY(e, 0, 'Mystical Elf');
  playSpell(e, 0, 'Dark Factory of Mass Production', { pick: ['Gemini Elf', 'Mystical Elf'] });
  check(zone(e, a) === 'hand' && zone(e, b) === 'hand', 'adds 2 Normal Monsters from the GY');
}

section('Dark Fusion');
{
  const e = duel(['Dark Fusion', 'Elemental HERO Avian', 'Elemental HERO Burstinatrix'], D(), ['Evil HERO Inferno Wing']);
  grab(e, 0, 'Elemental HERO Avian');
  grab(e, 0, 'Elemental HERO Burstinatrix');
  playSpell(e, 0, 'Dark Fusion');
  const iw = e.monsters(0).find((m) => m.name === 'Evil HERO Inferno Wing')!;
  check(!!iw, 'Fusion Summons a Fiend Fusion Monster using monsters from the hand');
  e.actor = 1;
  const oppNo = e.untargetable(iw);
  e.actor = 0;
  check(oppNo && !e.untargetable(iw), 'the opponent cannot target it with card effects this turn');
}

section('Dark Magic Attack');
{
  const e = duel(['Dark Magic Attack', 'Dark Magician'], D('Mirror Force', 'Pot of Greed'));
  place(e, 0, 'Dark Magician');
  const a = putST(e, 1, 'Mirror Force');
  const b = putST(e, 1, 'Pot of Greed');
  playSpell(e, 0, 'Dark Magic Attack');
  check(zone(e, a) === 'gy' && zone(e, b) === 'gy', 'you control "Dark Magician": destroy all Spells/Traps the opponent controls');
}

section('Dark Magic Curtain');
{
  const e = duel(['Dark Magic Curtain', 'Dark Magician']);
  playSpell(e, 0, 'Dark Magic Curtain');
  check(lp(e, 0) === 2000 && e.monsters(0).some((m) => m.name === 'Dark Magician'), 'pay half your LP: Special Summon "Dark Magician" from the Deck');
  const f = grab(e, 0, FILL);
  check(e.summonBlocked(0, f, 'normal', 'hand') && e.summonBlocked(0, f, 'special', 'hand') && !e.summonBlocked(0, f, 'set', 'hand'), 'you cannot Summon other monsters this turn (but you can Set)');
}

section('Dark Spirit\'s Mastery');
{
  const e = duel(["Dark Spirit's Mastery", 'Destiny Board']);
  const m = playSpell(e, 0, "Dark Spirit's Mastery", { pick: ['Destiny Board'] });
  const ms = e.player(0).gy.find((c) => c.name === "Dark Spirit's Mastery")!;
  check(!m && inHand(e, 0, 'Destiny Board'), 'discard 1: add "Destiny Board" from the Deck');
  check(!e.canUseGraveEffect(0, ms.uid), 'its GY effect cannot be used the turn it was sent there');
  toTurn3(e);
  const h = hand(e, 0);
  graveEffect(e, 0, ms, { pick: ['Destiny Board'] });
  check(zone(e, ms) === 'removed' && !inHand(e, 0, 'Destiny Board') && hand(e, 0) === h, 'banish it: place "Destiny Board" on the bottom of the Deck and draw 1 card');
}

section('Dark World Lightning');
{
  const e = duel(['Dark World Lightning'], D('Mirror Force'));
  const mf = putST(e, 1, 'Mirror Force');
  const h = hand(e, 0);
  playSpell(e, 0, 'Dark World Lightning');
  check(zone(e, mf) === 'gy' && hand(e, 0) === h - 1, 'destroys a Set card, then you discard 1 card');
}

section('Darklord Contact');
{
  const e = duel(['Darklord Contact', 'Darklord Nasten']);
  const n = toGY(e, 0, 'Darklord Nasten');
  playSpell(e, 0, 'Darklord Contact');
  const m = e.fieldCard(n.uid);
  check(!!m && m.pos === 'def', 'Special Summons a "Darklord" monster from the GY in Defense Position');
}

section('De-Fusion');
{
  const e = duel(['De-Fusion', 'Flame Manipulator', 'Masaki the Legendary Swordsman'], D(), ['Flame Swordsman']);
  const fs = place(e, 0, 'Flame Swordsman')!;
  const a = toGY(e, 0, 'Flame Manipulator');
  const b = toGY(e, 0, 'Masaki the Legendary Swordsman');
  playSpell(e, 0, 'De-Fusion', 'yes');
  check(zone(e, fs) === 'fusion' && zone(e, a) === 'mz' && zone(e, b) === 'mz', 'returns a Fusion Monster to the Extra Deck, then Special Summons its materials from the GY');
}

section('Destruction Swordsman Fusion');
{
  const e = duel(['Destruction Swordsman Fusion', 'Dark Magician', 'Buster Blader'], D(), ['Dark Paladin']);
  grab(e, 0, 'Dark Magician');
  place(e, 0, 'Buster Blader');
  const dsf = grab(e, 0, 'Destruction Swordsman Fusion');
  act(e, 0, dsf.uid);
  check(e.monsters(0).some((m) => m.name === 'Dark Paladin'), 'Fusion Summons a monster that lists "Buster Blader" as material');
  toTurn3(e);
  graveEffect(e, 0, dsf);
  check(zone(e, dsf) === 'hand', 'in the GY: send 1 card from the hand to the GY to add it to the hand');
}

section('Dicephoon');
{
  const e = duel(['Dicephoon'], D('Mirror Force'));
  const mf = putST(e, 1, 'Mirror Force');
  e.roll = () => 3;
  playSpell(e, 0, 'Dicephoon');
  check(zone(e, mf) === 'gy', 'roll 2-4: destroy 1 Spell/Trap');
}
{
  const e = duel(['Dicephoon']);
  e.roll = () => 6;
  playSpell(e, 0, 'Dicephoon');
  check(lp(e, 0) === 3000, 'roll 1 or 6: you take 1000 damage');
}

section('Different Dimension Capsule');
{
  const e = duel(['Different Dimension Capsule', 'Pot of Greed']);
  const cap = playSpell(e, 0, 'Different Dimension Capsule', { pick: ['Pot of Greed'] });
  const pot = e.player(0).removed.find((c) => c.name === 'Pot of Greed');
  check(!!cap && active(e, cap) && !!pot, 'banishes a card from the Deck and stays on the field');
  toTurn3(e);
  check(zone(e, cap) === 'sz' && zone(e, pot) === 'removed', 'not yet at your 1st Standby Phase');
  toTurn3(e);
  check(zone(e, cap) === 'gy' && zone(e, pot) === 'hand', 'your 2nd Standby Phase: it is destroyed and the card is added to the hand');
}

section('Different Dimension Gate');
{
  const e = duel(['Different Dimension Gate'], D('Gemini Elf'));
  const mine = place(e, 0, FILL)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  const g = playSpell(e, 0, 'Different Dimension Gate')!;
  check(zone(e, mine) === 'removed' && zone(e, elf) === 'removed', 'banishes 1 monster on each side of the field');
  kill(e, [g], 1);
  check(zone(e, mine) === 'mz' && e.controller(elf.uid) === 1, 'destroyed: the banished monsters return to the field');
}

section('Disposable Learner Device');
{
  const e = duel(['Disposable Learner Device', 'Gemini Elf', 'Mystical Elf']);
  const m = place(e, 0, FILL)!;
  toGY(e, 0, 'Gemini Elf');
  toGY(e, 0, 'Mystical Elf');
  const dld = playSpell(e, 0, 'Disposable Learner Device')!;
  check(e.atkOf(m) === 1400 + 400, 'the equipped monster gains 200 ATK for each monster in your GY');
  kill(e, [dld], 1);
  endTurn(e, 'yes');
  check(zone(e, dld) === 'sz', 'sent from the field to the GY this turn: Set it in the End Phase');
  kill(e, [e.fieldCard(dld.uid)], 1);
  check(zone(e, dld) === 'removed', 'banished when it leaves the field');
}

section('Dodododraw');
{
  const e = duel(['Dodododraw', 'Dododo Test Warrior']);
  grab(e, 0, 'Dododo Test Warrior');
  grab(e, 0, 'Dodododraw');
  const h = hand(e, 0);
  playSpell(e, 0, 'Dodododraw');
  check(hand(e, 0) === h - 2 + 2 && e.player(0).gy.some((c) => c.name === 'Dododo Test Warrior'), 'send a "Dododo" monster to the GY: draw 2 cards');
}

section('Double Cyclone');
{
  const e = duel(['Double Cyclone', 'Mirror Force'], D('Mirror Force'));
  const mine = putST(e, 0, 'Mirror Force');
  const theirs = putST(e, 1, 'Mirror Force');
  playSpell(e, 0, 'Double Cyclone');
  check(zone(e, mine) === 'gy' && zone(e, theirs) === 'gy', 'destroys 1 Spell/Trap you control and 1 your opponent controls');
}

section('Double Snare');
{
  const e = duel(['Double Snare'], D('Jinzo'));
  const j = place(e, 1, 'Jinzo')!;
  playSpell(e, 0, 'Double Snare');
  check(zone(e, j) === 'gy', 'destroys a face-up card that negates Trap effects');
}

section('Double Spell');
{
  const e = duel(['Double Spell', 'Pot of Greed'], D('Pot of Greed'));
  toGY(e, 1, 'Pot of Greed');
  grab(e, 0, 'Pot of Greed');
  grab(e, 0, 'Double Spell');
  const h = hand(e, 0);
  playSpell(e, 0, 'Double Spell');
  check(hand(e, 0) === h - 2 + 2, "discard a Spell: use a Spell in the opponent's GY as if it were yours");
}

section('Double Summon');
{
  const e = duel(['Double Summon']);
  playSpell(e, 0, 'Double Summon');
  const ps = e.player(0);
  for (let i = 0; i < 2; i++) {
    const c = grab(e, 0, FILL);
    e.apply({ type: 'SUMMON', player: 0, uid: c.uid, zone: ps.mz.findIndex((z) => z === null), pos: 'atk', faceUp: true });
    settle(e);
  }
  check(e.monsters(0).length === 2, 'activated first: 2 Normal Summons this turn');
  check(!e.canNormalSummon(0, grab(e, 0, FILL)), 'not a third');
}
{
  const e = duel(['Double Summon']);
  summon(e, 0, FILL);
  playSpell(e, 0, 'Double Summon');
  check(e.canNormalSummon(0, grab(e, 0, FILL)), 'activated after the Normal Summon: one more');
}

section('Draconnection');
{
  const e = duel(['Draconnection', 'Luster Dragon', 'Luster Dragon']);
  const a = grab(e, 0, 'Luster Dragon');
  playSpell(e, 0, 'Draconnection');
  const lusters = e.player(0).hand.filter((c) => c.name === 'Luster Dragon');
  check(zone(e, a) === 'deck' && lusters.length === 1 && lusters[0].uid !== a.uid, 'reveal a Dragon: add a Dragon of the same Level from the Deck, shuffle the revealed one in');
}

section('Dragged Down into the Grave');
{
  const e = duel(['Dragged Down into the Grave'], D());
  const h0 = hand(e, 0);
  const h1 = hand(e, 1);
  playSpell(e, 0, 'Dragged Down into the Grave');
  check(hand(e, 0) === h0 - 1 + 1 && hand(e, 1) === h1 - 1 + 1 && e.player(1).gy.length === 1 && e.player(0).gy.length === 2, 'each player discards a card chosen by the other, then both draw 1');
}

section('Dragon Revival Rhapsody');
{
  const e = duel(['Dragon Revival Rhapsody', 'Red-Eyes Black Dragon', 'Luster Dragon', 'Dark Magician']);
  place(e, 0, 'Dark Magician');
  const r = toGY(e, 0, 'Red-Eyes Black Dragon');
  const l = toGY(e, 0, 'Luster Dragon');
  playSpell(e, 0, 'Dragon Revival Rhapsody', { pick: ['Red-Eyes Black Dragon', 'Luster Dragon'] });
  check(zone(e, r) === 'mz' && zone(e, l) === 'mz', 'you control a Spellcaster: Special Summon up to 2 Dragons from the GY');
  e.damage(1, 500);
  check(lp(e, 1) === 4000, 'your opponent takes no damage this turn');
}

section('Dragon Shrine');
{
  const e = duel(['Dragon Shrine', 'Red-Eyes Black Dragon', 'Luster Dragon']);
  playSpell(e, 0, 'Dragon Shrine', { pick: ['Red-Eyes Black Dragon'] }, 'yes');
  const gy = e.player(0).gy.map((c) => c.name);
  check(gy.includes('Red-Eyes Black Dragon') && gy.includes('Luster Dragon'), 'send a Dragon from the Deck to the GY; a Dragon Normal Monster lets you send 1 more');
}

section("Dragon's Gunfire");
{
  const e = duel(["Dragon's Gunfire", "Dragon's Gunfire", 'Luster Dragon'], D('Kuriboh'));
  place(e, 0, 'Luster Dragon');
  playSpell(e, 0, "Dragon's Gunfire", { pick: ['Inflict 800 damage'] });
  check(lp(e, 1) === 3200, 'you control a Dragon: inflict 800 damage');
  const k = place(e, 1, 'Kuriboh')!;
  playSpell(e, 0, "Dragon's Gunfire", { pick: ['Destroy a monster with 800 or less DEF'] }, { pick: ['Kuriboh'] });
  check(zone(e, k) === 'gy', 'or destroy a monster with 800 or less DEF');
}

section('E - Emergency Call');
{
  const e = duel(['E - Emergency Call', 'Elemental HERO Sparkman']);
  playSpell(e, 0, 'E - Emergency Call');
  check(inHand(e, 0, 'Elemental HERO Sparkman'), 'adds an "Elemental HERO" monster from the Deck');
}

section('EN Shuffle');
{
  const e = duel(['EN Shuffle', 'Elemental HERO Sparkman', 'Elemental HERO Clayman', 'Elemental HERO Neos']);
  const sp = place(e, 0, 'Elemental HERO Sparkman')!;
  playSpell(e, 0, 'EN Shuffle', { pick: ['Elemental HERO Clayman'] });
  check(zone(e, sp) === 'deck' && e.monsters(0).some((m) => m.name === 'Elemental HERO Clayman'), 'shuffle an "Elemental HERO" you control into the Deck: Special Summon one with a different name');
  const en = e.player(0).gy.find((c) => c.name === 'EN Shuffle')!;
  const neos = toGY(e, 0, 'Elemental HERO Neos');
  toTurn3(e);
  const h = hand(e, 0);
  graveEffect(e, 0, en, { pick: ['1 "Elemental HERO Neos"'] });
  check(zone(e, en) === 'removed' && zone(e, neos) !== 'gy' && hand(e, 0) === h + 1, 'banish it from the GY: shuffle "Elemental HERO Neos" into the Deck, draw 1');
}

section('Earthquake');
{
  const e = duel(['Earthquake'], D('Gemini Elf'));
  const a = place(e, 0, FILL)!;
  const b = place(e, 1, 'Gemini Elf')!;
  playSpell(e, 0, 'Earthquake');
  check(a.pos === 'def' && b.pos === 'def', 'changes all face-up monsters to Defense Position');
}

// ======================= Traps =======================
section('Dark Deal');
{
  const e = duel(['Dark Deal'], D('Pot of Greed'));
  endTurn(e);
  putST(e, 0, 'Dark Deal');
  const pot = grab(e, 1, 'Pot of Greed');
  const h0 = hand(e, 0);
  const h1 = hand(e, 1);
  act(e, 1, pot.uid, { respond: 'Dark Deal' });
  check(lp(e, 0) === 3000 && hand(e, 1) === h1 - 1 && hand(e, 0) === h0 - 1, 'pay 1000 LP: the Normal Spell\'s effect becomes "your opponent discards 1 random card"');
}

section('Dark Renewal');
{
  const e = duel(['Dark Renewal', 'Gemini Elf', 'Dark Magician'], D());
  const elf = place(e, 0, 'Gemini Elf')!;
  putST(e, 0, 'Dark Renewal');
  endTurn(e);
  const f = grab(e, 1, FILL);
  e.apply({ type: 'SUMMON', player: 1, uid: f.uid, zone: 0, pos: 'atk', faceUp: true });
  settle(e, { respond: 'Dark Renewal' }, 'yes');
  check(zone(e, f) === 'gy' && zone(e, elf) === 'gy' && e.monsters(0).some((m) => m.name === 'Dark Magician'), 'the Summoned monster and your Spellcaster go to the GY, then a DARK Spellcaster is Special Summoned');
}

section('Dark Smog');
{
  const e = duel(['Dark Smog', 'Archfiend Soldier'], D('Gemini Elf'));
  const g = toGY(e, 1, 'Gemini Elf');
  grab(e, 0, 'Archfiend Soldier');
  const sm = playTrap(e, 0, 'Dark Smog')!;
  effect(e, 0, sm, { pick: ['Gemini Elf'] }, { pick: ['Archfiend Soldier'] });
  check(zone(e, g) === 'removed' && e.player(0).gy.some((c) => c.name === 'Archfiend Soldier'), "discard a Fiend: banish a monster in the opponent's GY");
}

section('Darklord Enchantment');
{
  const e = duel(['Darklord Enchantment', 'Darklord Nasten'], D('Gemini Elf'));
  grab(e, 0, 'Darklord Nasten');
  const elf = place(e, 1, 'Gemini Elf')!;
  playTrap(e, 0, 'Darklord Enchantment');
  check(e.controller(elf.uid) === 0 && e.player(0).gy.some((c) => c.name === 'Darklord Nasten'), 'send a "Darklord" to the GY: take control of an opponent\'s monster');
  endTurn(e);
  check(e.controller(elf.uid) === 1, 'until the End Phase');
}

section('Destiny Board / Spirit Messages');
{
  const e = duel(['Destiny Board', 'Spirit Message "I"', 'Spirit Message "N"'], D());
  const board = playTrap(e, 0, 'Destiny Board')!;
  check(active(e, board), 'Destiny Board stays on the field');
  endTurn(e);
  endTurn(e);
  const i = e.spells(0).find((c) => c.name === 'Spirit Message "I"');
  check(!!i && i.faceUp, "the opponent's End Phase: places \"Spirit Message I\" face-up from the Deck");
  kill(e, [i], 1);
  check(zone(e, board) === 'gy', 'a "Spirit Message" leaving the field sends Destiny Board to the GY');
}
{
  const e = duel(['Destiny Board', 'Spirit Message "I"'], D());
  const board = playTrap(e, 0, 'Destiny Board')!;
  endTurn(e);
  endTurn(e);
  const i = e.spells(0).find((c) => c.name === 'Spirit Message "I"')!;
  kill(e, [board], 1);
  check(zone(e, i) === 'gy', 'Destiny Board leaving the field sends the "Spirit Message" cards to the GY');
}
{
  // All 4 messages: with only 3 Spell & Trap Zones in Speed Duel, test the win check directly.
  const e = duel(['Destiny Board'], D());
  const board = playTrap(e, 0, 'Destiny Board')!;
  const ps = e.player(0);
  ps.sz = [...ps.sz, null, null, null, null];
  for (const x of ['I', 'N', 'A', 'L']) {
    const c = { uid: 900000 + x.charCodeAt(0), name: `Spirit Message "${x}"`, owner: 0 as Pid };
    const z = ps.sz.findIndex((s) => s === null);
    ps.sz[z] = { ...c, pos: 'atk', faceUp: true, placedTurn: 1, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true };
  }
  endTurn(e);
  endTurn(e);
  check(e.state.winner === 0 && !!board, 'Destiny Board and all 4 "Spirit Message" cards on your field: you win');
}

for (const x of ['Spirit Message "N"', 'Spirit Message "A"', 'Spirit Message "L"']) {
  const e = duel(['Destiny Board', x], D());
  const board = playTrap(e, 0, 'Destiny Board')!;
  const msg = putST(e, 0, x);
  msg.faceUp = true;
  msg.active = true;
  kill(e, [msg], 1);
  check(zone(e, board) === 'gy', `${x} leaving the field sends Destiny Board to the GY`);
}

section('Destiny Signal');
{
  const e = duel(['Destiny Signal', 'Destiny HERO - Diamond Dude'], D('Gemini Elf'));
  const f = place(e, 0, FILL)!;
  putST(e, 0, 'Destiny Signal');
  endTurn(e);
  const elf = place(e, 1, 'Gemini Elf')!;
  toBattle(e);
  attack(e, elf, f, { respond: 'Destiny Signal' });
  check(zone(e, f) === 'gy' && e.monsters(0).some((m) => m.name === 'Destiny HERO - Diamond Dude'), 'your monster destroyed by battle: Special Summon a Level 4 or lower "Destiny HERO" from the Deck');
}

section('Different Dimension Encounter');
{
  const e = duel(['Different Dimension Encounter', 'Gemini Elf'], D('Mystical Elf'));
  const a = e.player(0).deck.find((c) => c.name === 'Gemini Elf')!;
  e.banish(a.uid);
  const b = e.player(1).deck.find((c) => c.name === 'Mystical Elf')!;
  e.banish(b.uid);
  playTrap(e, 0, 'Different Dimension Encounter');
  const ma = e.fieldCard(a.uid);
  const mb = e.fieldCard(b.uid);
  check(!!ma && !!mb && !ma.faceUp && !mb.faceUp && ma.pos === 'def', 'each player Special Summons a banished monster in face-down Defense Position');
}

section('Doble Passe');
{
  const e = duel(['Doble Passe'], D('Gemini Elf'));
  const f = place(e, 0, FILL)!;
  putST(e, 0, 'Doble Passe');
  endTurn(e);
  const elf = place(e, 1, 'Gemini Elf')!;
  toBattle(e);
  attack(e, elf, f, { respond: 'Doble Passe' });
  check(lp(e, 1) === 4000 - 1400 && lp(e, 0) === 4000 - 1900 && zone(e, f) === 'mz', 'the attack becomes direct and the opponent takes damage equal to your monster\'s ATK');
  endTurn(e);
  check(e.canAttackDirectly(f) && !!elf, 'your monster can attack directly during your next turn');
}

section('Dragon\'s Rebirth');
{
  const e = duel(["Dragon's Rebirth", 'Luster Dragon', 'Red-Eyes Black Dragon']);
  const l = place(e, 0, 'Luster Dragon')!;
  const r = grab(e, 0, 'Red-Eyes Black Dragon');
  playTrap(e, 0, "Dragon's Rebirth", { pick: ['Luster Dragon'] }, { pick: ['Red-Eyes Black Dragon'] });
  check(zone(e, l) === 'removed' && zone(e, r) === 'mz', 'banish a Dragon you control: Special Summon a Dragon from the hand or GY');
}

section('Draining Shield');
{
  const e = duel(['Draining Shield'], D('Gemini Elf'));
  putST(e, 0, 'Draining Shield');
  endTurn(e);
  const elf = place(e, 1, 'Gemini Elf')!;
  toBattle(e);
  attack(e, elf, null, { respond: 'Draining Shield' });
  check(lp(e, 0) === 4000 + 1900, 'negates the attack and gains LP equal to the attacker\'s ATK');
}

section('Dramatic Rescue');
{
  const e = duel(['Dramatic Rescue', 'Amazoness Fighter', 'Gemini Elf'], D('Book of Moon'));
  const am = place(e, 0, 'Amazoness Fighter')!;
  grab(e, 0, 'Gemini Elf');
  putST(e, 0, 'Dramatic Rescue');
  endTurn(e);
  const bom = grab(e, 1, 'Book of Moon');
  act(e, 1, bom.uid, { pick: ['Amazoness Fighter'] }, { respond: 'Dramatic Rescue' }, { pick: ['Gemini Elf'] });
  check(zone(e, am) === 'hand' && e.monsters(0).some((m) => m.name === 'Gemini Elf'), 'a card targets your "Amazoness" monster: return it to the hand and Special Summon another monster from the hand');
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
if (fails) process.exit(1);
