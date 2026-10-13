// audit-03: Speed Duel card scripts of batch 03 (run: npx tsx tests/audit-03.test.ts)
// One or more targeted checks per scripted card: its main effect really happens in a duel.
import { Engine } from '../src/eds/engine';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';
import { levelOf } from '../src/eds/speed/helpers';

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
import type { CardInfo } from '../src/eds/types';
import { getEffect } from '../src/eds/effects';
import { attrOf } from '../src/eds/speed/helpers';

// Cards this game's pool lacks: test-only stand-ins added to the card database.
const fake = (info: Partial<CardInfo> & { name: string }) => {
  const full = { id: 993000 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
fake({ name: 'Crystron Test Tuner', tuner: true, level: 2, atk: 500, def: 500, race: 'Machine', attribute: 'WATER' });
fake({ name: 'Crystron Test Spell', kind: 'spell', sub: 'Normal' });
fake({ name: 'Test Cyberse Fusion', sub: 'Fusion', level: 6, atk: 2000, def: 2000, race: 'Cyberse', attribute: 'DARK', desc: '"Cyberse Sage" + "Celtic Guardian"' });

const other = (p: Pid): Pid => (p === 0 ? 1 : 0);
/** Moves a card of `p` from the Deck or hand straight to the GY (no effects). */
function toGy(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  for (const z of ['deck', 'hand'] as const) {
    const i = ps[z].findIndex((c) => c.name === name);
    if (i >= 0) {
      const [c] = ps[z].splice(i, 1);
      ps.gy.push(c);
      return c;
    }
  }
  throw new Error(`no ${name} for player ${p}`);
}
/** Moves a card of `p` from the Deck or hand straight to banishment. */
function toRemoved(e: Engine, p: Pid, name: string): Card {
  const c = toGy(e, p, name);
  const ps = e.player(p);
  ps.gy.splice(ps.gy.indexOf(c), 1);
  ps.removed.push(c);
  return c;
}
/** A Crystal Beast of `p` destroyed in the Monster Zone and placed in the Spell & Trap Zone. */
function cbToST(e: Engine, p: Pid, name: string): FieldCard {
  const m = place(e, p, name)!;
  kill(e, [m], other(p), 'yes');
  return e.fieldCard(m.uid)!;
}
const grave = (e: Engine, c: Card | null | undefined) => !!c && e.find(c.uid)?.loc.zone === 'gy';
const handHas = (e: Engine, p: Pid, name: string) => e.player(p).hand.some((c) => c.name === name);
const quickNow = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'QUICK_EFFECT', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const graveFx = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'GRAVE_EFFECT', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const TIGER = 'Crystal Beast Topaz Tiger';
const CAT = 'Crystal Beast Amethyst Cat';

// ======================= Crystal Beasts =======================
section('Crystal Beast Amber Mammoth');
{
  const e = duel(['Crystal Beast Amber Mammoth', TIGER], [FILL]);
  const mam = place(e, 0, 'Crystal Beast Amber Mammoth')!;
  const tiger = place(e, 0, TIGER)!;
  endTurn(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, tiger, { respond: 'Crystal Beast Amber Mammoth' });
  check(logHas(e, 'Amber Mammoth takes the attack instead') && zone(e, tiger) === 'mz' && zone(e, foe) === 'gy', 'becomes the attack target instead of another Crystal Beast');
  kill(e, [mam], 1, 'yes');
  check(zone(e, mam) === 'sz' && e.fieldCard(mam.uid)?.faceUp, 'destroyed face-up: placed in the Spell & Trap Zone instead');
}
{
  const e = duel(['Crystal Beast Amber Mammoth']);
  const mam = place(e, 0, 'Crystal Beast Amber Mammoth', 'def', false)!;
  kill(e, [mam], 1, 'yes');
  check(zone(e, mam) === 'gy', 'destroyed face-down: goes to the GY');
}

section('Crystal Beast Amethyst Cat');
{
  const e = duel([CAT], [FILL]);
  const cat = place(e, 0, CAT)!;
  place(e, 1, FILL);
  toTurn3(e);
  toBattle(e);
  attack(e, cat, null);
  check(lp(e, 1) === 4000 - 600, 'attacks directly, battle damage halved');
}

section('Crystal Beast Cobalt Eagle');
{
  const e = duel(['Crystal Beast Cobalt Eagle', TIGER]);
  const eagle = place(e, 0, 'Crystal Beast Cobalt Eagle')!;
  const tiger = place(e, 0, TIGER)!;
  effect(e, 0, eagle, { pick: [TIGER] });
  check(e.player(0).deck[0]?.uid === tiger.uid, 'returns a face-up Crystal Beast card to the top of the Deck');
}

section('Crystal Beast Emerald Tortoise');
{
  const e = duel(['Crystal Beast Emerald Tortoise']);
  const tort = place(e, 0, 'Crystal Beast Emerald Tortoise')!;
  const c = place(e, 0, FILL)!;
  check(!e.canUseMonsterEffect(0, tort), 'no monster attacked this turn: cannot be used');
  c.attacked = true;
  effect(e, 0, tort, { pick: [FILL] });
  check(c.pos === 'def', 'a monster that attacked this turn is changed to Defense Position');
}

section('Crystal Beast Ruby Carbuncle');
{
  const e = duel(['Crystal Beast Ruby Carbuncle', TIGER, CAT]);
  const tiger = cbToST(e, 0, TIGER);
  const cat = cbToST(e, 0, CAT);
  place(e, 0, 'Crystal Beast Ruby Carbuncle', 'atk', true, 'yes');
  check(zone(e, tiger) === 'mz' && zone(e, cat) === 'mz', 'Special Summoned: Special Summons the Crystal Beasts from the Spell & Trap Zone');
}

section('Crystal Beast Sapphire Pegasus');
{
  const e = duel(['Crystal Beast Sapphire Pegasus', TIGER]);
  summon(e, 0, 'Crystal Beast Sapphire Pegasus', true, 'yes', { pick: [TIGER] });
  const t = e.player(0).sz.find((c) => c?.name === TIGER);
  check(!!t && t.faceUp, 'Summoned: places a Crystal Beast from the Deck in the Spell & Trap Zone');
}

section('Crystal Beast Topaz Tiger');
{
  const e = duel([TIGER], [FILL]);
  const tiger = place(e, 0, TIGER)!;
  const foe = place(e, 1, FILL)!;
  check(e.atkOf(tiger) === 1600, 'no bonus outside an attack');
  toTurn3(e);
  toBattle(e);
  attack(e, tiger, foe);
  check(lp(e, 1) === 4000 - 600, 'attacking a monster: +400 ATK during the Damage Step');
}

section('Crystal Aegis (and Crystal Beast Token)');
{
  const e = duel(['Crystal Aegis', TIGER]);
  const tiger = place(e, 0, TIGER)!;
  playSpell(e, 0, 'Crystal Aegis', { pick: [TIGER] }, 'no');
  const tok = e.monsters(0).find((m) => m.name === 'Crystal Beast Token');
  check(zone(e, tiger) === 'gy' && !!tok && e.atkOf(tok) === 1600 && e.defOf(tok) === 1000 && e.raceOf(tok) === 'Beast', 'destroys a Crystal Beast, then Special Summons a Crystal Beast Token with its stats');
}
{
  const e = duel(['Crystal Aegis', 'Crystal Aegis', TIGER]);
  const tiger = place(e, 0, TIGER)!;
  playSpell(e, 0, 'Crystal Aegis', { pick: [TIGER] }, 'yes');
  check(zone(e, tiger) === 'sz' && e.monsters(0).some((m) => m.name === 'Crystal Beast Token'), 'a Crystal Beast placed in the Spell & Trap Zone instead still counts as destroyed');
  playSpell(e, 0, 'Crystal Aegis', { pick: [TIGER] });
  check(zone(e, tiger) === 'gy' && e.monsters(0).filter((m) => m.name === 'Crystal Beast Token').length === 2, 'can target a Crystal Beast in the Spell & Trap Zone');
}
{
  const e = duel(['Crystal Aegis', CAT]);
  const aegis = toGy(e, 0, 'Crystal Aegis');
  const cat = place(e, 0, CAT)!;
  kill(e, [cat], 1, 'yes', 'yes');
  check(zone(e, cat) === 'mz' && e.find(aegis.uid)?.loc.zone === 'removed', 'in the GY: banished to Special Summon a Crystal Beast placed in the Spell & Trap Zone');
}

section('Crystal Beacon');
{
  const e = duel(['Crystal Beacon', TIGER, CAT, 'Crystal Beast Cobalt Eagle']);
  cbToST(e, 0, TIGER);
  const beacon = grab(e, 0, 'Crystal Beacon');
  check(!e.canActivateMain(0, beacon.uid), 'needs 2 Crystal Beast cards in the Spell & Trap Zone');
  cbToST(e, 0, CAT);
  playSpell(e, 0, 'Crystal Beacon', { pick: ['Crystal Beast Cobalt Eagle'] });
  check(e.monsters(0).some((m) => m.name === 'Crystal Beast Cobalt Eagle'), 'Special Summons a Crystal Beast from the Deck');
}

section('Crystal Blessing');
{
  const e = duel(['Crystal Blessing', TIGER, CAT]);
  const a = toGy(e, 0, TIGER);
  const b = toGy(e, 0, CAT);
  playSpell(e, 0, 'Crystal Blessing', { pick: [TIGER, CAT] });
  check(zone(e, a) === 'sz' && zone(e, b) === 'sz', 'places up to 2 Crystal Beasts from the GY in the Spell & Trap Zone');
}

section('Crystal Boon');
{
  const e = duel(['Crystal Boon', TIGER, CAT]);
  cbToST(e, 0, TIGER);
  cbToST(e, 0, CAT);
  playTrap(e, 0, 'Crystal Boon', { pick: [TIGER, CAT] });
  check(e.monsters(0).length === 2 && lp(e, 0) === 4000 + 1600 + 1200, 'Special Summons 2 Crystal Beasts from the Spell & Trap Zone and gains their original ATK');
}
{
  const e = duel(['Crystal Boon', TIGER, CAT]);
  const boon = toGy(e, 0, 'Crystal Boon');
  const tiger = place(e, 0, TIGER)!;
  const d = e.player(0).deck;
  d.unshift(...d.splice(d.findIndex((c) => c.name === CAT), 1));
  kill(e, [tiger], 1, 'yes', 'yes');
  check(e.find(boon.uid)?.loc.zone === 'removed' && handHas(e, 0, CAT), 'in the GY: excavates a Crystal Beast and adds it to the hand');
}

section('Crystal Brilliance');
{
  const e = duel(['Crystal Brilliance', TIGER, CAT, 'Crystal Brilliance']);
  const br = playTrap(e, 0, 'Crystal Brilliance')!;
  const tiger = place(e, 0, TIGER)!;
  check(e.atkOf(tiger) === 1600 + 1000, 'Crystal Beasts gain ATK equal to their original DEF');
  const second = putST(e, 0, 'Crystal Brilliance');
  check(!e.canActivateMain(0, second.uid), 'you can only control 1');
  toGy(e, 0, CAT);
  kill(e, [tiger], 1, 'yes', 'yes', { pick: [CAT] });
  check(zone(e, br) === 'gy' && e.monsters(0).some((m) => m.name === CAT), 'a Crystal Beast placed: sends itself to Special Summon a Crystal Beast from the GY');
  e.damage(0, 1000);
  check(lp(e, 0) === 3500, 'damage you take this turn is halved');
}

section('Crystal Conclave');
{
  const e = duel(['Crystal Conclave', TIGER, CAT], [FILL]);
  const cc = playTrap(e, 0, 'Crystal Conclave')!;
  const tiger = place(e, 0, TIGER)!;
  kill(e, [tiger], 1, 'no', 'yes', { pick: [CAT] });
  const cat = e.monsters(0).find((m) => m.name === CAT);
  check(!!cat, 'a face-up Crystal Beast destroyed: Special Summons a Crystal Beast from the Deck');
  const foe = place(e, 1, FILL)!;
  effect(e, 0, cc, { pick: [CAT] }, { pick: [FILL] });
  check(zone(e, cc) === 'gy' && zone(e, cat) === 'hand' && zone(e, foe) === 'hand', 'sends itself to return a Crystal Beast you control and a card on the field to the hand');
}

section('Crystal Miracle');
{
  const e = duel(['Crystal Miracle', TIGER, 'Pot of Greed']);
  const tiger = place(e, 0, TIGER)!;
  putST(e, 0, 'Crystal Miracle');
  const pot = grab(e, 0, 'Pot of Greed');
  const hand = e.player(0).hand.length;
  act(e, 0, pot.uid, { respond: 'Crystal Miracle' }, { pick: [TIGER] }, 'no');
  check(zone(e, tiger) === 'gy' && e.player(0).hand.length === hand - 1 && zone(e, pot) === 'gy', 'destroys a Crystal Beast you control to negate and destroy the activated card');
}

section('Crystal Promise');
{
  const e = duel(['Crystal Promise', TIGER]);
  const tiger = cbToST(e, 0, TIGER);
  playSpell(e, 0, 'Crystal Promise', { pick: [TIGER] });
  check(zone(e, tiger) === 'mz', 'Special Summons a Crystal Beast from the Spell & Trap Zone');
}

section('Crystal Raigeki');
{
  const e = duel(['Crystal Raigeki', TIGER], [FILL]);
  const tiger = cbToST(e, 0, TIGER);
  const foe = place(e, 1, FILL)!;
  playTrap(e, 0, 'Crystal Raigeki', { pick: [TIGER] }, { pick: [FILL] });
  check(zone(e, tiger) === 'gy' && zone(e, foe) === 'gy', 'sends a Crystal Beast from the Spell & Trap Zone to destroy a card the opponent controls');
}

section('Crystal Release');
{
  const e = duel(['Crystal Release', TIGER, CAT]);
  const tiger = place(e, 0, TIGER)!;
  const rel = playSpell(e, 0, 'Crystal Release', { pick: [TIGER] })!;
  check(e.atkOf(tiger) === 2400, 'equipped Crystal Beast gains 800 ATK');
  kill(e, [rel], 1, 'yes', { pick: [CAT] });
  check(e.player(0).sz.some((c) => c?.name === CAT), 'sent from the field to the GY: places a Crystal Beast from the Deck in the Spell & Trap Zone');
}

section('Crystal Seer');
{
  const e = duel(['Crystal Seer', 'Pot of Greed', 'Dark Hole']);
  const seer = place(e, 0, 'Crystal Seer', 'def', false)!;
  run(e, e.flipEffect(seer.uid, 0), { pick: ['Dark Hole'] });
  const d = e.player(0).deck;
  check(handHas(e, 0, 'Dark Hole') && d[d.length - 1].name === 'Pot of Greed', 'FLIP: adds 1 of the top 2 cards to the hand, the other goes to the bottom');
}

section('Crystal Tree');
{
  const e = duel(['Crystal Tree', TIGER, CAT]);
  const tree = playSpell(e, 0, 'Crystal Tree')!;
  cbToST(e, 0, TIGER);
  check(tree.counters === 1, 'a Crystal Beast placed in the Spell & Trap Zone: 1 Crystal Counter');
  effect(e, 0, tree, { pick: [CAT] });
  check(zone(e, tree) === 'gy' && e.player(0).sz.some((c) => c?.name === CAT), 'sent to the GY: places that many Crystal Beasts from the Deck');
}

// ======================= Cyberdark =======================
section('Cyberdark Edge');
{
  const e = duel(['Cyberdark Edge', 'Cyberdark Cannon'], [FILL]);
  const cannon = toGy(e, 0, 'Cyberdark Cannon');
  const edge = summon(e, 0, 'Cyberdark Edge', true, { pick: ['Cyberdark Cannon'] })!;
  check(zone(e, cannon) === 'sz' && edge.equips.includes(cannon.uid) && e.atkOf(edge) === 800 + 1600, 'Normal Summoned: equips a Level 3 or lower Dragon from the GY and gains its original ATK');
  place(e, 1, FILL);
  toTurn3(e);
  toBattle(e);
  attack(e, edge, null);
  check(lp(e, 1) === 4000 - 1200, 'attacks directly with its ATK halved');
}

section('Cyberdark Horn');
{
  const e = duel(['Cyberdark Horn', 'Cyberdark Cannon'], [FILL, 'Blue-Eyes White Dragon']);
  const cannon = toGy(e, 0, 'Cyberdark Cannon');
  const horn = summon(e, 0, 'Cyberdark Horn', true, { pick: ['Cyberdark Cannon'] })!;
  const foe = place(e, 1, FILL, 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, horn, foe);
  check(lp(e, 1) === 4000 - (2400 - 1200), 'attacking a Defense Position monster: piercing damage');
  endTurn(e);
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  toBattle(e);
  attack(e, bewd, horn);
  check(zone(e, horn) === 'mz' && grave(e, cannon), 'would be destroyed by battle: the equipped monster is destroyed instead');
}

section('Cyberdark Keel');
{
  const e = duel(['Cyberdark Keel', 'Cyberdark Cannon'], [FILL]);
  toGy(e, 0, 'Cyberdark Cannon');
  const keel = summon(e, 0, 'Cyberdark Keel', true, { pick: ['Cyberdark Cannon'] })!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, keel, foe);
  check(lp(e, 1) === 4000 - 1000 - 300, 'destroys a monster by battle: 300 damage');
}

section('Cyberdark Impact! / Cyberdark Dragon');
{
  const e = duel(['Cyberdark Impact!', 'Cyberdark Horn', 'Cyberdark Edge', 'Cyberdark Keel', 'Cyberdark Claw'], [], ['Cyberdark Dragon']);
  grab(e, 0, 'Cyberdark Horn');
  toGy(e, 0, 'Cyberdark Edge');
  place(e, 0, 'Cyberdark Keel', 'def', false);
  const claw = toGy(e, 0, 'Cyberdark Claw');
  playSpell(e, 0, 'Cyberdark Impact!', { pick: ['Cyberdark Horn'] }, { pick: ['Cyberdark Edge'] }, { pick: ['Cyberdark Keel'] }, { pick: ['Cyberdark Claw'] });
  const cd = e.monsters(0).find((m) => m.name === 'Cyberdark Dragon');
  check(!!cd && e.player(0).deck.filter((c) => c.name.startsWith('Cyberdark ') && ['Cyberdark Horn', 'Cyberdark Edge', 'Cyberdark Keel'].includes(c.name)).length === 3, 'Impact!: returns Horn, Edge and Keel (hand, GY, face-down on the field) to the Deck to Fusion Summon Cyberdark Dragon');
  check(!!cd && zone(e, claw) === 'sz' && e.atkOf(cd) === 1000 + 1600 + 100 * e.player(0).gy.filter((c) => DB.get(c.name)?.kind === 'monster').length, 'Cyberdark Dragon: equips a Dragon from the GY, gains its ATK and 100 per monster in the GY');
  check(e.summonBlocked(0, cd!, 'special', 'gy') && !e.summonBlocked(0, cd!, 'special', 'fusion'), 'Cyberdark Dragon cannot be Special Summoned except by Fusion Summon');
}

section('Cyberdark Cannon');
{
  const e = duel(['Cyberdark Cannon', 'Cyberdark Edge', 'Cyberdark Horn', 'Cyberdark Cannon', 'Gemini Elf'], [FILL]);
  const cannon = grab(e, 0, 'Cyberdark Cannon');
  effect(e, 0, cannon, { pick: ['Cyberdark Edge'] });
  check(grave(e, cannon) && handHas(e, 0, 'Cyberdark Edge'), 'discard it: adds a Machine "Cyberdark" monster from the Deck');
  const horn = summon(e, 0, 'Cyberdark Horn', true, { pick: ['Cyberdark Cannon'] })!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, horn, foe, { respond: 'Cyberdark Cannon' }, { pick: ['Gemini Elf'] });
  check(e.player(0).gy.some((c) => c.name === 'Gemini Elf'), 'its equipped monster battles: sends a monster from the Deck to the GY');
  const hand = e.player(0).hand.length;
  kill(e, [e.fieldCard(cannon.uid)], 1, 'yes');
  check(e.player(0).hand.length === hand + 1, 'sent to the GY while equipped: draws 1 card');
}

section('Cyberdark Claw');
{
  const e = duel(['Cyberdark Claw', 'Cyberdark Impact!', 'Cyberdark Horn', 'Cyberdark Claw', 'Cyberdark Keel'], [FILL], ['Cyberdark Dragon']);
  const claw = grab(e, 0, 'Cyberdark Claw');
  effect(e, 0, claw, { pick: ['Cyberdark Impact!'] });
  check(grave(e, claw) && handHas(e, 0, 'Cyberdark Impact!'), 'discard it: adds a "Cyberdark" Spell/Trap from the Deck');
  const keel = toGy(e, 0, 'Cyberdark Keel');
  const horn = summon(e, 0, 'Cyberdark Horn', true, { pick: ['Cyberdark Claw'] })!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, horn, foe, { respond: 'Cyberdark Claw' }, { pick: ['Cyberdark Dragon'] });
  check(e.player(0).gy.some((c) => c.name === 'Cyberdark Dragon'), 'its equipped monster battles: sends a monster from the Extra Deck to the GY');
  const claw2 = e.player(0).sz.find((c) => c?.name === 'Cyberdark Claw')!;
  kill(e, [claw2], 1, 'yes', { pick: ['Cyberdark Keel'] });
  check(zone(e, keel) === 'hand', 'sent to the GY while equipped: adds a "Cyberdark" monster from the GY');
}

section('Cyberdark Chimera');
{
  const e = duel(['Cyberdark Chimera', 'Cyberdark Horn', 'Pot of Greed']);
  const ch = place(e, 0, 'Cyberdark Chimera')!;
  check(!e.canUseMonsterEffect(0, ch), 'no "Power Bond" in the Deck: its search cannot be used');
  kill(e, [ch], 1, 'yes', { pick: ['Cyberdark Horn'] });
  check(e.player(0).gy.some((c) => c.name === 'Cyberdark Horn'), 'sent to the GY: sends a "Cyberdark" monster with a new name from the Deck to the GY');
}

section('Cybernetic Horizon');
{
  const e = duel(['Cybernetic Horizon', 'Cyber Dragon', 'Cyberdark Horn', 'Cyber Dragon Core'], [], ['Cyber End Dragon', 'Cyberse Desavewurm']);
  grab(e, 0, 'Cyber Dragon');
  playSpell(e, 0, 'Cybernetic Horizon', { pick: ['Cyber Dragon'] }, { pick: ['Cyberdark Horn'] }, { pick: ['Cyber Dragon Core'] }, { pick: ['Cyber End Dragon'] });
  check(e.player(0).gy.some((c) => c.name === 'Cyber Dragon') && e.player(0).gy.some((c) => c.name === 'Cyberdark Horn'), 'sends a Dragon/Machine "Cyber" monster from the hand and one with another Attribute from the Deck');
  check(handHas(e, 0, 'Cyber Dragon Core') && e.player(0).gy.some((c) => c.name === 'Cyber End Dragon'), 'adds a "Cyber" monster, then sends a Machine "Cyber" Fusion Monster from the Extra Deck to the GY');
  const wurm = e.player(0).fusion.find((c) => c.name === 'Cyberse Desavewurm')!;
  check(e.summonBlocked(0, wurm, 'special', 'fusion') && !e.summonBlocked(0, grab(e, 0, 'Cyber Dragon Core'), 'special', 'hand'), 'only Machine monsters can be Special Summoned from the Extra Deck this turn');
}

// ======================= Cyber =======================
section('Cyber Dragon Core');
{
  const e = duel(['Cyber Dragon Core', 'Cyber Repair Plant', FILL, FILL, 'Cyber Dragon'], [FILL]);
  const core = summon(e, 0, 'Cyber Dragon Core')!;
  check(handHas(e, 0, 'Cyber Repair Plant'), 'Normal Summoned: adds a "Cyber" Spell/Trap from the Deck');
  check(getEffect('Cyber Dragon Core')?.fieldName?.(e, core) === 'Cyber Dragon', 'its name becomes "Cyber Dragon" on the field');
  run(e, e.sendToGrave(core.uid, 'cost'));
  place(e, 1, FILL);
  endTurn(e);
  endTurn(e);
  graveFx(e, 0, core, { pick: ['Cyber Dragon'] });
  check(e.monsters(0).some((m) => m.name === 'Cyber Dragon') && e.find(core.uid)?.loc.zone === 'removed', 'only the opponent controls a monster: banish it from the GY to Special Summon a "Cyber Dragon" from the Deck');
}

section('Cyber End Dragon');
{
  const e = duel(['Cyber Dragon', 'Cyber Dragon', 'Beastking of the Swamps', 'Polymerization'], [FILL], ['Cyber End Dragon']);
  place(e, 0, 'Cyber Dragon');
  place(e, 0, 'Cyber Dragon');
  place(e, 0, 'Beastking of the Swamps');
  const poly = grab(e, 0, 'Polymerization');
  check(!e.canActivateMain(0, poly.uid), 'its Fusion Summon can only use the listed Fusion Materials (no substitutes)');
  const ced = place(e, 0, 'Cyber End Dragon');
  void ced;
}
{
  const e = duel([], [FILL], ['Cyber End Dragon']);
  const ced = place(e, 0, 'Cyber End Dragon')!;
  const foe = place(e, 1, FILL, 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, ced, foe);
  check(lp(e, 1) === 4000 - (4000 - 1200), 'attacking a Defense Position monster: piercing damage');
}

section('Cyber Harpie Lady');
{
  const e = duel(['Cyber Harpie Lady']);
  const chl = place(e, 0, 'Cyber Harpie Lady')!;
  check(getEffect('Cyber Harpie Lady')?.fieldName?.(e, chl) === 'Harpie Lady', 'its name is treated as "Harpie Lady"');
}

section('Cyber Energy Shock');
{
  const e = duel(['Cyber Energy Shock', 'Jinzo'], ['Mirror Force']);
  const jinzo = place(e, 0, 'Jinzo')!;
  const mf = putST(e, 1, 'Mirror Force');
  playSpell(e, 0, 'Cyber Energy Shock', { pick: ['Face-down card'] }, { pick: ['All "Jinzo" you control gain 800 ATK'] });
  check(grave(e, mf) && e.atkOf(jinzo) === 2400 + 800, 'destroys a card; it was a Trap: "Jinzo" gains 800 ATK');
}
{
  const e = duel(['Cyber Energy Shock']);
  const ces = grab(e, 0, 'Cyber Energy Shock');
  place(e, 0, FILL);
  check(!e.canActivateMain(0, ces.uid), 'needs a "Jinzo"');
}

section('Cyber Gymnast');
{
  const e = duel(['Cyber Gymnast'], [FILL]);
  const g = place(e, 0, 'Cyber Gymnast')!;
  const foe = place(e, 1, FILL)!;
  const hand = e.player(0).hand.length;
  effect(e, 0, g, { pick: [FILL] }, { pick: [FILL] });
  check(grave(e, foe) && e.player(0).hand.length === hand - 1, 'discards 1 card to destroy a face-up Attack Position monster');
}

section('Cyber Network');
{
  const e = duel(['Cyber Network', 'Cyber Dragon', 'Cyber Dragon Core', 'Crystal Tree'], [FILL]);
  const net = playTrap(e, 0, 'Cyber Network')!;
  place(e, 0, 'Cyber Dragon');
  effect(e, 0, net, { pick: ['Cyber Dragon Core'] });
  const core = e.player(0).removed.find((c) => c.name === 'Cyber Dragon Core');
  check(!!core, 'with "Cyber Dragon" on the field: banishes a LIGHT Machine from the Deck');
  const tree = playSpell(e, 0, 'Crystal Tree')!;
  kill(e, [net], 1);
  check(zone(e, core) === 'mz' && grave(e, tree) && e.isNegated(e.fieldCard(core!.uid)!), 'sent to the GY: Special Summons the banished LIGHT Machines (effects negated) and destroys your Spells/Traps');
  toBattle(e);
  check(!e.canAttackWith(0, e.fieldCard(core!.uid)!), 'you cannot conduct your Battle Phase that turn');
}
{
  const e = duel(['Cyber Network']);
  const net = playTrap(e, 0, 'Cyber Network')!;
  for (let i = 0; i < 4; i++) endTurn(e);
  check(zone(e, net) === 'sz', 'still on the field after 2 of your Standby Phases');
  endTurn(e);
  endTurn(e);
  check(grave(e, net), 'destroyed during your 3rd Standby Phase');
}

section('Cyber Phoenix');
{
  const e = duel(['Cyber Phoenix'], ['Change of Heart', 'Blue-Eyes White Dragon']);
  const ph = place(e, 0, 'Cyber Phoenix')!;
  endTurn(e);
  playSpell(e, 1, 'Change of Heart', { pick: ['Cyber Phoenix'] });
  check(e.controller(ph.uid) === 0 && logHas(e, 'Cyber Phoenix negates Change of Heart'), 'in Attack Position: negates a Spell/Trap effect that targets a Machine you control');
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  toBattle(e);
  const hand = e.player(0).hand.length;
  attack(e, bewd, ph, 'yes');
  check(grave(e, ph) && e.player(0).hand.length === hand + 1, 'destroyed by battle: draws 1 card');
}

section('Cyber Prima');
{
  const e = duel(['Cyber Prima', 'Crystal Tree'], ['Crystal Tree']);
  const t0 = playSpell(e, 0, 'Crystal Tree')!;
  place(e, 0, FILL);
  summon(e, 0, 'Cyber Prima', true, { pick: [FILL] });
  check(grave(e, t0) && e.monsters(0).some((m) => m.name === 'Cyber Prima'), 'Tribute Summoned: destroys all face-up Spells');
}

section('Cyber Raider');
{
  const e = duel(['Cyber Raider', 'Cyber Raider'], ['Black Pendant', 'Black Pendant']);
  const foe = place(e, 1, FILL)!;
  const bp = e.player(1).deck.find((c) => c.name === 'Black Pendant')!;
  // Black Pendant equipped to the opponent's monster.
  const ps = e.player(1);
  ps.deck.splice(ps.deck.indexOf(bp), 1);
  const z = ps.sz.findIndex((x) => x === null);
  ps.sz[z] = { ...bp, pos: 'atk', faceUp: true, placedTurn: -1, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true, equippedTo: foe.uid };
  foe.equips.push(bp.uid);
  const raider = summon(e, 0, 'Cyber Raider', true, { pick: ['Equip an Equip Card to Cyber Raider'] }, { pick: ['Black Pendant'] })!;
  check(raider.equips.includes(bp.uid) && e.controller(bp.uid) === 0 && e.atkOf(raider) === 1400 + 500, 'Summoned: takes an Equip Card and equips it to itself');
  const r2 = place(e, 0, 'Cyber Raider', 'atk', true, { pick: ['Destroy an Equip Card'] }, { pick: ['Black Pendant'] });
  check(!!r2 && grave(e, bp), 'or destroys an Equip Card');
}

section('Cyber Repair Plant');
{
  const e = duel(['Cyber Repair Plant', 'Cyber Dragon', 'Cyber Dragon Core']);
  toGy(e, 0, 'Cyber Dragon');
  playSpell(e, 0, 'Cyber Repair Plant', { pick: ['Add a LIGHT Machine from your Deck'] }, { pick: ['Cyber Dragon Core'] });
  check(handHas(e, 0, 'Cyber Dragon Core'), 'with "Cyber Dragon" in the GY: adds a LIGHT Machine from the Deck');
}

section('Cyber Shadow Gardna');
{
  const e = duel(['Cyber Shadow Gardna'], ['Gemini Elf', FILL]);
  const g = putST(e, 0, 'Cyber Shadow Gardna');
  endTurn(e);
  summon(e, 1, FILL, true, { respond: 'Cyber Shadow Gardna' });
  const gm = e.fieldCard(g.uid)!;
  check(zone(e, g) === 'mz' && e.raceOf(gm) === 'Machine' && levelOf(e, gm) === 4 && attrOf(e, gm) === 'EARTH', "opponent's Main Phase: Special Summoned as a Level 4 EARTH Machine monster");
  endTurn(e);
  check(zone(e, g) === 'sz' && !e.fieldCard(g.uid)!.faceUp, "opponent's End Phase: Set again in the Spell & Trap Zone");
}
{
  const e = duel(['Cyber Shadow Gardna'], ['Mystical Elf', FILL]);
  const g = putST(e, 0, 'Cyber Shadow Gardna');
  endTurn(e);
  const elf = place(e, 1, 'Mystical Elf', 'atk', true, { respond: 'Cyber Shadow Gardna' })!;
  const gm = e.fieldCard(g.uid)!;
  check(e.atkOf(gm) === 0 && e.defOf(gm) === 0, 'its ATK/DEF start at 0');
  toBattle(e);
  e.apply({ type: 'ATTACK', player: 1, uid: elf.uid, target: g.uid });
  settle(e);
  check(zone(e, g) === 'mz' && e.defOf(e.fieldCard(g.uid)!) === 2000 && lp(e, 1) === 4000 - 1200, "attacked: its ATK/DEF become the attacker's (Mystical Elf 800 ATK bounces off DEF 2000)");
}

section('Cyber Tutu');
{
  const e = duel(['Cyber Tutu'], ['Gemini Elf', 'Crystal Seer']);
  const tutu = place(e, 0, 'Cyber Tutu')!;
  place(e, 1, 'Gemini Elf');
  check(e.canAttackDirectly(tutu), "every opponent's monster has more ATK: it can attack directly");
  place(e, 1, 'Crystal Seer');
  check(!e.canAttackDirectly(tutu), 'not when one has less ATK');
}

section('Cyber Valley');
{
  const e = duel(['Cyber Valley'], [FILL]);
  const cv = place(e, 0, 'Cyber Valley')!;
  endTurn(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  const hand = e.player(0).hand.length;
  attack(e, foe, cv, { respond: 'Cyber Valley' });
  check(e.find(cv.uid)?.loc.zone === 'removed' && e.player(0).hand.length === hand + 1 && !e.canAttackWith(1, foe), 'targeted for an attack: banish it to draw 1 and end the Battle Phase');
}
{
  const e = duel(['Cyber Valley']);
  const cv = place(e, 0, 'Cyber Valley')!;
  const c = place(e, 0, FILL)!;
  const hand = e.player(0).hand.length;
  effect(e, 0, cv, { pick: ['Banish it and a monster you control, then draw 2'] }, { pick: [FILL] });
  check(e.find(cv.uid)?.loc.zone === 'removed' && e.find(c.uid)?.loc.zone === 'removed' && e.player(0).hand.length === hand + 2, 'banish it and a monster you control: draw 2');
}

section('Cyber Blader');
{
  const e = duel([], [FILL, FILL, FILL, 'Pot of Greed'], ['Cyber Blader']);
  const cb = place(e, 0, 'Cyber Blader')!;
  const f1 = place(e, 1, FILL)!;
  check(e.shielded(cb, 'battle'), 'opponent controls 1 monster: cannot be destroyed by battle');
  place(e, 1, FILL);
  check(e.atkOf(cb) === 4200 && !e.shielded(cb, 'battle'), 'opponent controls 2 monsters: its ATK is doubled');
  place(e, 1, FILL);
  endTurn(e);
  const hand = e.player(1).hand.length;
  playSpell(e, 1, 'Pot of Greed');
  check(e.player(1).hand.length === hand - 1 && logHas(e, 'Cyber Blader negates Pot of Greed'), "opponent controls 3 monsters: the opponent's Spell effects are negated");
  void f1;
}
{
  const e = duel(['Etoile Cyber', 'Beastking of the Swamps', 'Polymerization'], [], ['Cyber Blader']);
  grab(e, 0, 'Etoile Cyber');
  grab(e, 0, 'Beastking of the Swamps');
  check(!e.canActivateMain(0, grab(e, 0, 'Polymerization').uid), 'its Fusion Summon can only use the listed Fusion Materials');
}

// ======================= Cyber Angels =======================
section('Cyber Angel Benten');
{
  const e = duel(['Cyber Angel Benten', 'Cyber Angel Idaten'], [FILL]);
  const bt = place(e, 0, 'Cyber Angel Benten')!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, bt, foe);
  check(grave(e, foe) && lp(e, 1) === 4000 - 400 - 1200, "destroys a monster by battle: damage equal to its original DEF");
  run(e, e.sendToGrave(bt.uid, 'tribute'), 'yes', { pick: ['Cyber Angel Idaten'] });
  check(handHas(e, 0, 'Cyber Angel Idaten'), 'Tributed: adds a LIGHT Fairy from the Deck');
}

section('Cyber Angel Idaten');
{
  const e = duel(['Cyber Angel Idaten', 'Machine Angel Ritual', 'Machine Angel Ritual', 'Cyber Angel Benten']);
  grab(e, 0, 'Cyber Angel Idaten');
  playSpell(e, 0, 'Machine Angel Ritual', { pick: ['Cyber Angel Idaten'] }, { pick: [FILL, FILL] }, 'yes', { pick: ['Machine Angel Ritual'] });
  const id = e.monsters(0).find((m) => m.name === 'Cyber Angel Idaten');
  check(!!id && handHas(e, 0, 'Machine Angel Ritual'), 'Ritual Summoned: adds a Ritual Spell from the Deck');
  const bt = place(e, 0, 'Cyber Angel Benten')!;
  run(e, e.sendToGrave(id!.uid, 'tribute'), 'yes');
  check(e.atkOf(bt) === 1800 + 1000 && e.defOf(bt) === 1500 + 1000, 'Tributed: your Ritual Monsters gain 1000 ATK/DEF');
}
{
  const e = duel(['Cyber Angel Idaten', 'Machine Angel Ritual']);
  const hand = e.player(0).hand.length;
  place(e, 0, 'Cyber Angel Idaten', 'atk', true, 'yes');
  check(e.player(0).hand.length === hand, 'Special Summoned some other way: no search');
}

section('Cyber Angel Izana');
{
  const e = duel(['Cyber Angel Izana', 'Machine Angel Ritual'], ['Mirror Force']);
  const mf = putST(e, 1, 'Mirror Force');
  grab(e, 0, 'Cyber Angel Izana');
  playSpell(e, 0, 'Machine Angel Ritual', { pick: ['Cyber Angel Izana'] }, { pick: [FILL, FILL] }, 'yes');
  check(e.monsters(0).some((m) => m.name === 'Cyber Angel Izana') && grave(e, mf), 'Ritual Summoned: the opponent sends a Spell/Trap they control to the GY');
}
{
  const e = duel(['Cyber Angel Izana'], [FILL, FILL]);
  const iz = place(e, 0, 'Cyber Angel Izana')!;
  const f1 = place(e, 1, FILL)!;
  place(e, 1, FILL);
  toTurn3(e);
  toBattle(e);
  attack(e, iz, f1, 'yes');
  check(grave(e, f1) && e.canAttackWith(0, iz), 'destroys a monster by battle: it can make a second attack');
}

// ======================= Cyberse =======================
section('Cyberse Sage');
{
  const e = duel(['Cyberse Sage'], [], ['Test Cyberse Fusion']);
  const sage = place(e, 0, 'Cyberse Sage')!;
  const c = toGy(e, 0, FILL);
  effect(e, 0, sage, { pick: ['Test Cyberse Fusion'] });
  check(e.monsters(0).some((m) => m.name === 'Test Cyberse Fusion') && e.find(sage.uid)?.loc.zone === 'removed' && e.find(c.uid)?.loc.zone === 'removed', 'Fusion Summons by banishing the materials from the field/GY, including a Cyberse monster');
}
{
  const e = duel(['Cyberse Sage', 'Machine Angel Ritual'], [], ['Chaos Ruler, the Chaotic Magical Dragon']);
  const sage = place(e, 0, 'Cyberse Sage')!;
  const c = place(e, 0, FILL)!;
  const mar = toGy(e, 0, 'Machine Angel Ritual');
  const ruler = e.player(0).fusion.find((x) => x.name === 'Chaos Ruler, the Chaotic Magical Dragon')!;
  run(e, e.extraSummon(0, ruler.uid, [sage.uid, c.uid], 'Synchro'), 'yes', { pick: ['Machine Angel Ritual'] });
  check(zone(e, mar) === 'hand', 'sent to the GY as Synchro Material: adds a Cyberse monster or Ritual Spell from the GY');
}

section('Cynet Rollback');
{
  const e = duel(['Cynet Rollback', 'Danmari @Ignister', 'Danmari @Ignister', 'Danmari @Ignister']);
  const d1 = toRemoved(e, 0, 'Danmari @Ignister');
  const rb = grab(e, 0, 'Cynet Rollback');
  act(e, 0, rb.uid, { pick: ['Danmari @Ignister'] });
  check(zone(e, d1) === 'mz', 'Special Summons a banished Cyberse monster');
  toRemoved(e, 0, 'Danmari @Ignister');
  toRemoved(e, 0, 'Danmari @Ignister');
  check(!e.canUseGraveEffect(0, rb.uid), 'its GY effect needs 2000 LP or less');
  e.player(0).lp = 2000;
  graveFx(e, 0, rb);
  check(e.player(0).hand.filter((x) => x.name === 'Danmari @Ignister').length === 2 && e.find(rb.uid)?.loc.zone === 'removed', 'LP 2000 or less: banish it from the GY to add 2 banished Cyberse monsters');
}

// ======================= Destiny HERO / D.D. / D/D =======================
const DD = 'Destiny HERO - Diamond Dude';
section('D - Chain');
{
  const e = duel([DD, 'D - Chain'], [FILL]);
  const dd = place(e, 0, DD)!;
  const foe = place(e, 1, FILL)!;
  const ch = playTrap(e, 0, 'D - Chain', { pick: [DD] });
  check(zone(e, ch) === 'sz' && e.atkOf(dd) === 1900, 'equips itself to a "Destiny HERO": +500 ATK');
  toTurn3(e);
  toBattle(e);
  attack(e, dd, foe);
  check(lp(e, 1) === 4000 - 500 - 500, 'it destroys a monster by battle: 500 damage');
}

section('D - Counter');
{
  const e = duel([DD, 'D - Counter'], ['Gemini Elf']);
  const dd = place(e, 0, DD)!;
  putST(e, 0, 'D - Counter');
  endTurn(e);
  const elf = place(e, 1, 'Gemini Elf')!;
  toBattle(e);
  attack(e, elf, dd, { respond: 'D - Counter' });
  check(grave(e, elf) && zone(e, dd) === 'mz', 'a "Destiny HERO" targeted for an attack: destroys the attacker');
}

section('D - Spirit');
{
  const e = duel(['D - Spirit', DD, DD]);
  grab(e, 0, DD);
  playSpell(e, 0, 'D - Spirit', { pick: [DD] });
  check(e.monsters(0).some((m) => m.name === DD), 'Special Summons a Level 4 or lower "Destiny HERO" from the hand');
  grab(e, 0, DD);
  check(!e.canActivateMain(0, grab(e, 0, 'D - Spirit').uid), 'not while you control a face-up "Destiny HERO"');
}

section('D-Boyz');
{
  const e = duel(['D-Boyz', 'D-Boyz', 'D-Boyz']);
  const db = place(e, 0, 'D-Boyz', 'def', false)!;
  run(e, e.flipEffect(db.uid, 0), { pick: ['D-Boyz', 'D-Boyz'] });
  check(e.monsters(0).filter((m) => m.name === 'D-Boyz').length === 3 && lp(e, 0) === 2000, 'FLIP: Special Summons "D-Boyz" from the Deck, 1000 damage each');
}

section('D.D. Crow');
{
  const e = duel(['D.D. Crow'], ['Pot of Greed']);
  const pot = toGy(e, 1, 'Pot of Greed');
  const crow = grab(e, 0, 'D.D. Crow');
  quickNow(e, 0, crow, { pick: ['Pot of Greed'] });
  check(grave(e, crow) && e.find(pot.uid)?.loc.zone === 'removed', "discard it: banishes a card from the opponent's GY");
}

section('D.D. Warrior Lady');
{
  const e = duel(['D.D. Warrior Lady'], ['Blue-Eyes White Dragon']);
  const dd = place(e, 0, 'D.D. Warrior Lady')!;
  endTurn(e);
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  toBattle(e);
  attack(e, bewd, dd, 'yes');
  check(e.find(bewd.uid)?.loc.zone === 'removed' && e.find(dd.uid)?.loc.zone === 'removed' && lp(e, 0) === 4000 - 1500, 'after damage calculation: banishes the monster it battled and itself (even if it lost)');
}

section('D.D.M. - Different Dimension Master');
{
  const e = duel(['D.D.M. - Different Dimension Master', 'Gemini Elf', 'Pot of Greed']);
  const ddm = place(e, 0, 'D.D.M. - Different Dimension Master')!;
  const elf = toRemoved(e, 0, 'Gemini Elf');
  grab(e, 0, 'Pot of Greed');
  effect(e, 0, ddm, { pick: ['Pot of Greed'] });
  check(zone(e, elf) === 'mz' && e.player(0).gy.some((c) => c.name === 'Pot of Greed'), 'discard a Spell: Special Summons a banished monster');
}

section('D/D Gryphon');
{
  const e = duel(['D/D Gryphon', 'D/D Savant Nikola', 'D/D Savant Thomas']);
  place(e, 0, 'D/D Savant Nikola');
  const g = grab(e, 0, 'D/D Gryphon');
  e.apply({ type: 'SPECIAL', player: 0, uid: g.uid });
  settle(e);
  check(zone(e, g) === 'mz' && e.fieldCard(g.uid)!.pos === 'def', 'you control a "D/D" monster: Special Summons itself from the hand in Defense Position');
}
{
  const e = duel(['D/D Gryphon', 'D/D Savant Thomas']);
  toGy(e, 0, 'D/D Gryphon');
  place(e, 0, 'D/D Gryphon', 'atk', true, 'yes', { pick: ['D/D Savant Thomas'] });
  check(handHas(e, 0, 'D/D Savant Thomas'), 'Special Summoned from the GY: adds a "D/D" card from the Deck');
}

section('D/D Savant Nikola / D/D Savant Thomas');
{
  // Their effects need Pendulum Zones, which this game does not have: they play as plain monsters.
  const e = duel(['D/D Savant Nikola', 'D/D Savant Thomas']);
  const n = place(e, 0, 'D/D Savant Nikola');
  const t = place(e, 0, 'D/D Savant Thomas');
  check(!!getEffect('D/D Savant Nikola') && !!getEffect('D/D Savant Thomas') && !!n && !!t, 'scripted as monsters without usable effects');
}

section('DUCKER Mobile Cannon');
{
  const e = duel(['DUCKER Mobile Cannon', 'Gemini Elf']);
  const elf = toGy(e, 0, 'Gemini Elf');
  const dk = place(e, 0, 'DUCKER Mobile Cannon', 'def', false)!;
  run(e, e.flipEffect(dk.uid, 0), { pick: ['Gemini Elf'] });
  check(zone(e, elf) === 'hand', 'FLIP: adds a Level 4 monster from the GY');
}

section('Damage Condenser');
{
  const e = duel(['Damage Condenser', 'Gemini Elf'], ['Gemini Elf']);
  putST(e, 0, 'Damage Condenser');
  endTurn(e);
  const elf = place(e, 1, 'Gemini Elf')!;
  toBattle(e);
  attack(e, elf, null, { respond: 'Damage Condenser' }, { pick: [FILL] }, { pick: ['Gemini Elf'] });
  check(lp(e, 0) === 4000 - 1900 && e.monsters(0).some((m) => m.name === 'Gemini Elf' && m.pos === 'atk'), 'battle damage: discard 1 to Special Summon a monster with ATK up to that damage');
}

section('Damage Mage');
{
  const e = duel(['Damage Mage'], ['Hinotama']);
  grab(e, 0, 'Damage Mage');
  endTurn(e);
  playSpell(e, 1, 'Hinotama', { respond: 'Damage Mage' });
  check(e.monsters(0).some((m) => m.name === 'Damage Mage') && lp(e, 0) === 4000, 'effect damage: Special Summons itself from the hand and gains that much LP');
}

section('Dandylion');
{
  const e = duel(['Dandylion', 'Cyber Dragon']);
  const d = grab(e, 0, 'Dandylion');
  run(e, e.sendToGrave(d.uid, 'discard'));
  const toks = e.monsters(0).filter((m) => m.name === 'Fluff Token');
  check(toks.length === 2 && toks.every((t) => t.pos === 'def' && e.raceOf(t) === 'Plant'), 'sent to the GY: 2 Fluff Tokens in Defense Position');
  check(!e.canNormalSummon(0, grab(e, 0, 'Cyber Dragon')), 'the Tokens cannot be Tributed the turn they are Special Summoned');
}

// ======================= C... =======================
section('Contact with Gusto');
{
  const e = duel(['Contact with Gusto', 'Caam, Serenity of Gusto', 'Musto, Oracle of Gusto'], [FILL]);
  const a = toGy(e, 0, 'Caam, Serenity of Gusto');
  const b = toGy(e, 0, 'Musto, Oracle of Gusto');
  const foe = place(e, 1, FILL)!;
  playSpell(e, 0, 'Contact with Gusto', { pick: ['Caam, Serenity of Gusto', 'Musto, Oracle of Gusto'] }, { pick: [FILL] });
  check(zone(e, a) === 'deck' && zone(e, b) === 'deck' && grave(e, foe), 'shuffles 2 "Gusto" monsters from the GY into the Deck, then destroys a card the opponent controls');
}

section('Contract with the Void');
{
  const e = duel(['Contract with the Void', 'Infernity Beast']);
  const ib = toGy(e, 0, 'Infernity Beast');
  playSpell(e, 0, 'Contract with the Void', 'yes', { pick: ['Infernity Beast'] });
  check(e.player(0).hand.length === 0 && zone(e, ib) === 'mz', 'discards the entire hand, then Special Summons an "Infernity" monster from the GY');
}
{
  const e = duel(['Contract with the Void', 'Chaos Ruler, the Chaotic Magical Dragon']);
  const cr = toGy(e, 0, 'Chaos Ruler, the Chaotic Magical Dragon');
  playSpell(e, 0, 'Contract with the Void', 'yes', { pick: ['Chaos Ruler, the Chaotic Magical Dragon'] });
  check(zone(e, cr) === 'mz', 'or a Level 8 DARK Dragon Synchro Monster');
}

section('Convert Contact');
{
  const e = duel(['Convert Contact', 'Neo-Spacian Grand Mole', 'Neo-Spacian Air Hummingbird']);
  grab(e, 0, 'Neo-Spacian Grand Mole');
  const hand = e.player(0).hand.length;
  playSpell(e, 0, 'Convert Contact', { pick: ['Neo-Spacian Grand Mole'] });
  check(e.player(0).gy.filter((c) => c.name.startsWith('Neo-Spacian')).length === 2 && e.player(0).hand.length === hand + 1, 'sends a Neo-Spacian from the hand and one from the Deck, then draws 2');
}

section('Copycat');
{
  const e = duel(['Copycat'], ['Gemini Elf']);
  place(e, 1, 'Gemini Elf');
  const cc = place(e, 0, 'Copycat', 'atk', true, { pick: ['Gemini Elf'] })!;
  check(e.atkOf(cc) === 1900 && e.defOf(cc) === 900, "Summoned: its ATK/DEF become the target's original ATK/DEF");
}

section('Core of Chaos');
{
  const e = duel(['Core of Chaos', 'Infernity Beast'], [], ['Cyber End Dragon', 'Chaos Ruler, the Chaotic Magical Dragon']);
  const ib = toGy(e, 0, 'Infernity Beast');
  const core = grab(e, 0, 'Core of Chaos');
  check(!e.canNormalSummon(0, core), 'cannot be Normal Summoned');
  effect(e, 0, core, { pick: ['Infernity Beast'] });
  check(zone(e, core) === 'mz' && e.find(ib.uid)?.loc.zone === 'removed', 'banish a DARK monster from the GY: Special Summons itself from the hand');
  const ced = e.player(0).fusion.find((c) => c.name === 'Cyber End Dragon')!;
  const cr = e.player(0).fusion.find((c) => c.name.startsWith('Chaos Ruler'))!;
  check(e.summonBlocked(0, ced, 'special', 'fusion') && !e.summonBlocked(0, cr, 'special', 'fusion'), 'only LIGHT or DARK Synchro Monsters from the Extra Deck this turn');
  kill(e, [e.fieldCard(core.uid)], 1);
  check(e.find(core.uid)?.loc.zone === 'removed', 'leaving the field: banished instead');
}

section('Cosmos Channelling');
{
  const e = duel(['Cosmos Channelling', 'Cyber Dragon'], ['Gemini Elf']);
  const cc = playSpell(e, 0, 'Cosmos Channelling')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  e.takeControl(elf.uid, 0);
  grab(e, 0, 'Cyber Dragon');
  effect(e, 0, cc, { pick: ['Gemini Elf'] }, { pick: ['Cyber Dragon'] });
  check(grave(e, elf) && e.monsters(0).some((m) => m.name === 'Cyber Dragon'), 'sends a monster you control owned by the opponent to Special Summon a Machine');
}
{
  const e = duel(['Cosmos Channelling', 'Jinzo']);
  const cc = playSpell(e, 0, 'Cosmos Channelling')!;
  place(e, 0, 'Jinzo');
  const hand = e.player(0).hand.length;
  endTurn(e, 'yes', { pick: ['Monster'] });
  check(grave(e, cc) && e.player(0).hand.length === hand + 1, "opponent's normal draw while you control Jinzo: declared the right type, so it is sent to the GY to draw 1");
}

section('Counter Cleaner');
{
  const e = duel(['Counter Cleaner']);
  const c = place(e, 0, FILL)!;
  c.counters = 2;
  playSpell(e, 0, 'Counter Cleaner');
  check(c.counters === 0 && lp(e, 0) === 3500, 'pay 500 LP: removes all counters');
}

section('Couple of Aces');
{
  const e = duel(['Couple of Aces']);
  e.roll = () => 1;
  const ca = grab(e, 0, 'Couple of Aces');
  const hand = e.player(0).hand.length;
  effect(e, 0, ca);
  check(zone(e, ca) === 'mz' && e.controller(ca.uid) === 0 && e.player(0).hand.length === hand - 1 + 2, 'Heads: Special Summons itself to your field and draws 2');
}
{
  const e = duel(['Couple of Aces']);
  e.roll = () => 2;
  const ca = grab(e, 0, 'Couple of Aces');
  effect(e, 0, ca);
  check(e.controller(ca.uid) === 1, "Tails: Special Summoned to the opponent's field");
}

section('Court of Cards');
{
  const e = duel(['Court of Cards', "Queen's Knight", "King's Knight", "Jack's Knight"]);
  const court = playTrap(e, 0, 'Court of Cards')!;
  grab(e, 0, "Queen's Knight");
  effect(e, 0, court, { pick: ['Special Summon a Knight from your hand or GY'] }, { pick: ["Queen's Knight"] });
  check(e.monsters(0).some((m) => m.name === "Queen's Knight"), "no monsters: Special Summons a Knight from the hand");
  toGy(e, 0, "King's Knight");
  grab(e, 0, "Jack's Knight");
  effect(e, 0, court);
  check(e.player(0).removed.length === 0, 'only 1 "Court of Cards" effect per turn');
  endTurn(e);
  endTurn(e);
  const hand = e.player(0).hand.length;
  effect(e, 0, court, { pick: ['Banish Knights to draw'] }, { pick: ["King's Knight", "Jack's Knight"] });
  check(e.player(0).removed.length === 2 && e.player(0).hand.length === hand - 1 + 2, 'banishes Knights from the hand/GY to draw that many');
}

section('Covering Fire');
{
  const e = duel(['Covering Fire', 'Gemini Elf'], ['Blue-Eyes White Dragon']);
  const c = place(e, 0, FILL)!;
  place(e, 0, 'Gemini Elf');
  putST(e, 0, 'Covering Fire');
  endTurn(e);
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  toBattle(e);
  attack(e, bewd, c, { respond: 'Covering Fire' }, { pick: ['Gemini Elf'] });
  check(grave(e, bewd) && lp(e, 1) === 4000 - 300, 'the attacked monster gains the ATK of another monster you control');
  check(e.atkOf(c) === 1400, 'only during that battle');
}

section('Creature Seizure');
{
  const e = duel(['Creature Seizure', 'Gemini Elf'], ['Blue-Eyes White Dragon']);
  const elf = place(e, 0, 'Gemini Elf')!;
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  playSpell(e, 0, 'Creature Seizure');
  check(e.controller(elf.uid) === 1 && e.controller(bewd.uid) === 0, 'each player gives the other a face-up Normal Monster');
}

section('Creature Swap');
{
  const e = duel(['Creature Swap', 'Gemini Elf'], ['Blue-Eyes White Dragon']);
  const elf = place(e, 0, 'Gemini Elf')!;
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  playSpell(e, 0, 'Creature Swap');
  check(e.controller(elf.uid) === 1 && e.controller(bewd.uid) === 0, 'the players switch control of 1 monster each');
  bewd.placedTurn = -1;
  bewd.posChanged = false;
  check(!e.canChangePosition(0, bewd), 'they cannot change their battle positions this turn');
}

section('Creeping Darkness');
{
  const e = duel(['Creeping Darkness', 'Infernity Beast', 'Dark Magician', 'Feral Imp']);
  toGy(e, 0, 'Infernity Beast');
  toGy(e, 0, 'Dark Magician');
  playSpell(e, 0, 'Creeping Darkness', { pick: ['Infernity Beast', 'Dark Magician'] }, { pick: ['Feral Imp'] });
  check(e.player(0).removed.length === 2 && handHas(e, 0, 'Feral Imp'), 'banishes 2 DARK monsters from the GY to add a Level 4 DARK monster');
}

section('Cross Keeper');
{
  const e = duel(['Cross Keeper', 'Elemental HERO Avian']);
  const av = toGy(e, 0, 'Elemental HERO Avian');
  const ck = grab(e, 0, 'Cross Keeper');
  effect(e, 0, ck, { pick: ['Elemental HERO Avian'] });
  check(grave(e, ck) && zone(e, av) === 'mz' && e.isNegated(e.fieldCard(av.uid)!), 'sends itself from the hand to Special Summon an "Elemental HERO" from the GY (effects negated)');
}
{
  const e = duel(['Cross Keeper'], [], ['Elemental HERO Flame Wingman']);
  const ck = toGy(e, 0, 'Cross Keeper');
  const hand = e.player(0).hand.length;
  place(e, 0, 'Elemental HERO Flame Wingman', 'atk', true, { respond: 'Cross Keeper' });
  check(e.find(ck.uid)?.loc.zone === 'removed' && e.player(0).hand.length === hand + 1, 'an "Elemental HERO" Fusion Monster Special Summoned: banish it to draw 2, then put 1 card on the bottom of the Deck');
}

section('Cross Porter');
{
  const e = duel(['Cross Porter', 'Neo-Spacian Grand Mole', 'Neo-Spacian Air Hummingbird']);
  const cp = place(e, 0, 'Cross Porter')!;
  grab(e, 0, 'Neo-Spacian Grand Mole');
  effect(e, 0, cp, { pick: ['Cross Porter'] }, 'yes', { pick: ['Neo-Spacian Grand Mole'] });
  check(grave(e, cp) && e.monsters(0).some((m) => m.name === 'Neo-Spacian Grand Mole'), 'sends a monster you control to Special Summon a Neo-Spacian from the hand');
  check(handHas(e, 0, 'Neo-Spacian Air Hummingbird'), 'sent to the GY: adds a Neo-Spacian from the Deck');
}

section('Cross-Sword Beetle');
{
  const e = duel(['Cross-Sword Beetle', 'Basic Insect'], ['Crystal Seer']);
  const bt = place(e, 0, 'Cross-Sword Beetle')!;
  const seer = place(e, 1, 'Crystal Seer', 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, bt, seer);
  check(lp(e, 1) === 4000, 'no other Insect: no piercing damage');
}
{
  const e = duel(['Cross-Sword Beetle', 'Basic Insect'], ['Crystal Seer']);
  place(e, 0, 'Cross-Sword Beetle');
  const bi = place(e, 0, 'Basic Insect')!;
  const seer = place(e, 1, 'Crystal Seer', 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, bi, seer);
  check(lp(e, 1) === 4000 - 400, 'another Insect you control attacking a Defense Position monster inflicts piercing damage');
}

section('Crowley, the Magistus of Grimoires');
{
  const e = duel(['Crowley, the Magistus of Grimoires', 'Gemini Elf']);
  const elf = place(e, 0, 'Gemini Elf')!;
  const cr = grab(e, 0, 'Crowley, the Magistus of Grimoires');
  effect(e, 0, cr, { pick: ['Gemini Elf'] });
  check(zone(e, cr) === 'mz' && grave(e, elf), 'sends a Spellcaster to Special Summon itself from the hand');
  const m = e.fieldCard(cr.uid)!;
  effect(e, 0, m, { pick: ['LIGHT'] });
  check(attrOf(e, m) === 'LIGHT', 'declares an Attribute: it becomes that Attribute');
  endTurn(e);
  check(attrOf(e, m) === 'DARK', 'until the end of the turn');
}

section('Crystal Shark');
{
  const e = duel(['Crystal Shark', 'Beastking of the Swamps'], [], ['Cyber End Dragon']);
  const bk = place(e, 0, 'Beastking of the Swamps')!;
  const sh = grab(e, 0, 'Crystal Shark');
  effect(e, 0, sh, { pick: ['Beastking of the Swamps'] });
  check(zone(e, sh) === 'mz' && e.atkOf(bk) === 500, "targets a WATER monster: Special Summons itself and halves that monster's ATK");
  check(e.summonBlocked(0, e.player(0).fusion[0], 'special', 'fusion'), 'only Xyz Monsters from the Extra Deck this turn');
  kill(e, [e.fieldCard(sh.uid)], 1);
  check(e.find(sh.uid)?.loc.zone === 'removed', 'banished when it leaves the field');
}

section('Crystron Smiger');
{
  const e = duel(['Crystron Smiger', 'Crystron Test Tuner']);
  const sm = place(e, 0, 'Crystron Smiger')!;
  const c = place(e, 0, FILL)!;
  effect(e, 0, sm, { pick: [FILL] });
  check(grave(e, c) && e.monsters(0).some((m) => m.name === 'Crystron Test Tuner'), 'destroys a face-up card you control to Special Summon a "Crystron" Tuner from the Deck');
}
{
  const e = duel(['Crystron Smiger', 'Crystron Test Spell']);
  const sm = toGy(e, 0, 'Crystron Smiger');
  graveFx(e, 0, sm);
  check(handHas(e, 0, 'Crystron Test Spell') && e.find(sm.uid)?.loc.zone === 'removed', 'banish it from the GY: adds a "Crystron" Spell/Trap');
}

section('Cup of Ace');
{
  const e = duel(['Cup of Ace']);
  e.roll = () => 1;
  const hand = e.player(0).hand.length;
  playSpell(e, 0, 'Cup of Ace');
  check(e.player(0).hand.length === hand + 2, 'Heads: you draw 2');
}
{
  const e = duel(['Cup of Ace']);
  e.roll = () => 2;
  const hand = e.player(1).hand.length;
  playSpell(e, 0, 'Cup of Ace');
  check(e.player(1).hand.length === hand + 2, 'Tails: the opponent draws 2');
}

section('Cupid Fore');
{
  const e = duel(['Cupid Fore', 'Sangan']);
  place(e, 0, 'Sangan');
  const cf = grab(e, 0, 'Cupid Fore');
  e.apply({ type: 'SPECIAL', player: 0, uid: cf.uid });
  settle(e);
  check(zone(e, cf) === 'mz', 'all your monsters have 600 DEF: Special Summons itself from the hand');
}
{
  const e = duel(['Cupid Fore'], ['Gemini Elf']);
  const cf = place(e, 0, 'Cupid Fore')!;
  place(e, 1, 'Gemini Elf');
  const hand = e.player(0).hand.length;
  quickNow(e, 0, cf, { pick: [FILL] });
  check(levelOf(e, cf) === 4 && e.player(0).hand.length === hand - 1, "discard 1: your LIGHT Fairy's Level becomes the other monster's Level");
  endTurn(e);
  check(levelOf(e, cf) === 6, 'until the end of the turn');
}

section('Curse of Aging');
{
  const e = duel(['Curse of Aging'], ['Gemini Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  playTrap(e, 0, 'Curse of Aging', { pick: [FILL] });
  check(e.atkOf(elf) === 1400 && e.defOf(elf) === 400, "discard 1: the opponent's monsters lose 500 ATK/DEF");
  endTurn(e);
  check(e.atkOf(elf) === 1900, 'until the end of the turn');
}

section('Curse of Anubis');
{
  const e = duel(['Curse of Anubis', 'Cyber Gymnast', 'Gemini Elf']);
  const g = place(e, 0, 'Cyber Gymnast')!;
  const elf = place(e, 0, 'Gemini Elf')!;
  playTrap(e, 0, 'Curse of Anubis');
  check(g.pos === 'def' && e.defOf(g) === 0 && elf.pos === 'atk', 'Effect Monsters change to Defense Position with 0 DEF (Normal Monsters are not affected)');
  g.placedTurn = -1;
  g.posChanged = false;
  check(!e.canChangePosition(0, g), 'their battle positions cannot be changed this turn');
}

section('Cursed Eldland');
{
  const e = duel(['Cursed Eldland', 'Conquistador of the Golden Land', 'Conquistador of the Golden Land'], [FILL]);
  const el = playSpell(e, 0, 'Cursed Eldland')!;
  const c = place(e, 0, FILL)!;
  place(e, 1, FILL);
  effect(e, 0, el, { pick: ['Conquistador of the Golden Land'] });
  check(handHas(e, 0, 'Conquistador of the Golden Land') && lp(e, 0) === 3200, 'pay 800 LP: adds a "Golden Land" Spell/Trap from the Deck');
  kill(e, [el], 1, 'yes');
  check(e.player(0).gy.some((x) => x.name === 'Conquistador of the Golden Land'), 'sent from the Spell & Trap Zone to the GY: sends a "Golden Land" card from the Deck to the GY');
  void c;
}
{
  const e = duel(['Cursed Eldland', 'Armored Zombie'], [FILL]);
  playSpell(e, 0, 'Cursed Eldland');
  const c = place(e, 0, FILL)!;
  const z = place(e, 0, 'Armored Zombie')!;
  place(e, 1, FILL);
  toTurn3(e);
  toBattle(e);
  check(!e.canAttackWith(0, c) && e.canAttackWith(0, z), 'only Zombie monsters can attack');
}

section('Cursed Seal of the Forbidden Spell');
{
  const e = duel(['Cursed Seal of the Forbidden Spell', 'Dark Hole'], ['Pot of Greed', 'Pot of Greed']);
  putST(e, 0, 'Cursed Seal of the Forbidden Spell');
  grab(e, 0, 'Dark Hole');
  endTurn(e);
  const pot = grab(e, 1, 'Pot of Greed');
  const hand = e.player(1).hand.length;
  act(e, 1, pot.uid, { respond: 'Cursed Seal of the Forbidden Spell' }, { pick: ['Dark Hole'] });
  check(grave(e, pot) && e.player(1).hand.length === hand - 1, 'discard a Spell: negates the Spell activation and destroys it');
  check(!e.canActivateMain(1, grab(e, 1, 'Pot of Greed').uid), 'the opponent cannot activate Spells with that name for the rest of the Duel');
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
if (fails) process.exit(1);
