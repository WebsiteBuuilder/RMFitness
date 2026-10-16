// audit-C: Spell/Trap cards of group C (cards-03 / cards-04) checked against their real card text (run: npx tsx tests/spells-c.test.ts)
// Each card is activated through the engine's real actions in a duel and its main outcome (and key restrictions) is checked.
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
const fake = (info: Partial<CardInfo> & { name: string }) => {
  if (DB.get(info.name)) return;
  const full = { id: 970000 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
fake({ name: 'D/D/D Test Overlord', sub: 'Fusion', level: 8, atk: 3000, def: 2000, race: 'Fiend', attribute: 'DARK', desc: '2 "D/D" monsters' });
fake({ name: 'D/D Test Imp', level: 4, atk: 1000, def: 1000, race: 'Fiend', attribute: 'DARK' });
for (const x of ['I', 'N', 'A', 'L']) fake({ name: `Spirit Message "${x}"`, kind: 'trap', sub: 'Continuous', desc: 'This card cannot be activated normally.' });
fake({ name: 'Dododo Test Warrior', level: 4, atk: 1800, def: 1000, race: 'Warrior', attribute: 'EARTH' });

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
const inHand = (e: Engine, p: Pid, name: string) => e.player(p).hand.some((c) => c.name === name);
const hand = (e: Engine, p: Pid) => e.player(p).hand.length;
const graveFx = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'GRAVE_EFFECT', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const clearHand = (e: Engine, p: Pid) => {
  const ps = e.player(p);
  ps.gy.push(...ps.hand.splice(0));
};
const D = (...names: string[]) => [FILL, FILL, FILL, ...names];
const TIGER = 'Crystal Beast Topaz Tiger';
const CAT = 'Crystal Beast Amethyst Cat';
const DD = 'Destiny HERO - Diamond Dude';
const CARDS = new Set<string>();
const FIXED = new Set([
  'Cosmos Channelling',
  'Cursed Eldland',
  'Curse of Aging',
  'Cyber Energy Shock',
  'D - Chain',
  'Dark Deal',
  'Dark World Lightning',
  'Dark Smog',
  'Dark Fusion',
  'Dark Calling',
  'Dramatic Rescue',
  'Double Spell',
  'Cyberdark Impact!',
  'Crystal Miracle',
  'Crystal Brilliance',
]);
const card = (name: string) => {
  CARDS.add(name);
  section(name);
};

// ======================= cards-03 =======================
card('Contact with Gusto');
{
  const e = duel(['Contact with Gusto', 'Caam, Serenity of Gusto', 'Musto, Oracle of Gusto'], [FILL]);
  const a = toGy(e, 0, 'Caam, Serenity of Gusto');
  const b = toGy(e, 0, 'Musto, Oracle of Gusto');
  const foe = place(e, 1, FILL)!;
  const c = grab(e, 0, 'Contact with Gusto');
  act(e, 0, c.uid, { pick: ['Caam, Serenity of Gusto', 'Musto, Oracle of Gusto'] }, { pick: [FILL] });
  check(zone(e, a) === 'deck' && zone(e, b) === 'deck' && grave(e, foe) && grave(e, c), 'shuffles 2 "Gusto" monsters from your GY into the Deck, then destroys the targeted card your opponent controls');
}
{
  const e = duel(['Contact with Gusto', 'Caam, Serenity of Gusto'], [FILL]);
  toGy(e, 0, 'Caam, Serenity of Gusto');
  place(e, 1, FILL);
  check(!e.canActivateMain(0, grab(e, 0, 'Contact with Gusto').uid), 'needs 2 "Gusto" monsters in your GY');
}

card('Contract with the Void');
{
  const e = duel(['Contract with the Void', 'Infernity Beast']);
  const ib = toGy(e, 0, 'Infernity Beast');
  playSpell(e, 0, 'Contract with the Void', 'yes', { pick: ['Infernity Beast'] });
  check(hand(e, 0) === 0 && zone(e, ib) === 'mz' && e.player(0).gy.filter((c) => c.name === FILL).length === 4, 'discards your entire hand, then you can Special Summon an "Infernity" monster from your GY');
}
{
  const e = duel(['Contract with the Void']);
  const c = grab(e, 0, 'Contract with the Void');
  clearHand(e, 0);
  e.toHandOf(c.uid, 0);
  grab(e, 0, FILL);
  grab(e, 0, FILL);
  check(!e.canActivateMain(0, c.uid), 'needs 3 or more other cards in your hand');
}

card('Convert Contact');
{
  const e = duel(['Convert Contact', 'Neo-Spacian Grand Mole', 'Neo-Spacian Air Hummingbird']);
  grab(e, 0, 'Neo-Spacian Grand Mole');
  const h = hand(e, 0);
  playSpell(e, 0, 'Convert Contact', { pick: ['Neo-Spacian Grand Mole'] });
  check(e.player(0).gy.filter((c) => c.name.startsWith('Neo-Spacian')).length === 2 && hand(e, 0) === h - 1 + 2 - 1 + 1, 'sends a Neo-Spacian from the hand and 1 from the Deck to the GY, then draws 2');
}
{
  const e = duel(['Convert Contact', 'Neo-Spacian Grand Mole', 'Neo-Spacian Air Hummingbird']);
  grab(e, 0, 'Neo-Spacian Grand Mole');
  place(e, 0, FILL);
  check(!e.canActivateMain(0, grab(e, 0, 'Convert Contact').uid), 'only if you control no monsters');
}

card('Cosmos Channelling');
{
  const e = duel(['Cosmos Channelling', 'Cosmos Channelling', 'Cyber Dragon', 'Cyber Dragon'], ['Gemini Elf', 'Mystical Elf']);
  const c1 = playSpell(e, 0, 'Cosmos Channelling')!;
  const c2 = playSpell(e, 0, 'Cosmos Channelling')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  const elf2 = place(e, 1, 'Mystical Elf')!;
  e.takeControl(elf.uid, 0);
  e.takeControl(elf2.uid, 0);
  grab(e, 0, 'Cyber Dragon');
  grab(e, 0, 'Cyber Dragon');
  effect(e, 0, c1, { pick: ['Gemini Elf'] }, { pick: ['Cyber Dragon'] });
  check(grave(e, elf) && e.player(1).gy.some((c) => c.uid === elf.uid) && e.monsters(0).some((m) => m.name === 'Cyber Dragon'), 'sends a monster you control owned by your opponent to the GY to Special Summon a Machine from your hand');
  check(active(e, c1), 'it is a Continuous Spell: it stays on the field');
  check(!e.canUseMonsterEffect(0, c2), 'each effect of "Cosmos Channelling" only once per turn (a second copy cannot use it)');
}

card('Counter Cleaner');
{
  const e = duel(['Counter Cleaner', 'Crystal Tree'], [FILL]);
  const m = place(e, 1, FILL)!;
  m.counters = 2;
  const tree = playSpell(e, 0, 'Crystal Tree')!;
  tree.counters = 3;
  const cc = playSpell(e, 0, 'Counter Cleaner');
  check(m.counters === 0 && tree.counters === 0 && lp(e, 0) === 3500 && !cc, 'pay 500 LP: removes all counters on the field (monsters and Spells), then goes to the GY');
}

card('Court of Cards');
{
  const e = duel(['Court of Cards', "Queen's Knight", "King's Knight", "Jack's Knight"]);
  const court = playTrap(e, 0, 'Court of Cards')!;
  toGy(e, 0, "Queen's Knight");
  effect(e, 0, court, { pick: ['Special Summon a Knight from your hand or GY'] }, { pick: ["Queen's Knight"] });
  check(e.monsters(0).some((m) => m.name === "Queen's Knight") && active(e, court), 'no monsters: Special Summons a Knight from the GY; the Continuous Trap stays');
}
{
  const e = duel(['Court of Cards', "Queen's Knight"]);
  const court = playTrap(e, 0, 'Court of Cards')!;
  grab(e, 0, "Queen's Knight");
  place(e, 0, FILL);
  e.player(0).deck.length = 0;
  check(!e.canUseMonsterEffect(0, court), 'not while you control a monster other than the Knights');
}

card('Covering Fire');
{
  const e = duel(['Covering Fire', 'Gemini Elf'], ['Blue-Eyes White Dragon']);
  const c = place(e, 0, FILL)!;
  place(e, 0, 'Gemini Elf');
  putST(e, 0, 'Covering Fire');
  endTurn(e);
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  toBattle(e);
  attack(e, bewd, c, { respond: 'Covering Fire' }, { pick: ['Gemini Elf'] });
  check(grave(e, bewd) && lp(e, 1) === 4000 - 300 && e.atkOf(c) === 1400, 'the attacked monster gains the other monster\'s ATK for that battle only');
}

card('Creature Seizure');
{
  const e = duel(['Creature Seizure', 'Gemini Elf'], ['Blue-Eyes White Dragon']);
  const elf = place(e, 0, 'Gemini Elf')!;
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  playSpell(e, 0, 'Creature Seizure');
  check(e.controller(elf.uid) === 1 && e.controller(bewd.uid) === 0, 'each player gives their opponent a face-up Normal Monster');
}
{
  const e = duel(['Creature Seizure', 'Kuriboh'], ['Blue-Eyes White Dragon']);
  place(e, 0, 'Kuriboh');
  place(e, 1, 'Blue-Eyes White Dragon');
  check(!e.canActivateMain(0, grab(e, 0, 'Creature Seizure').uid), 'needs a face-up Normal Monster on each side');
}

card('Creature Swap');
{
  const e = duel(['Creature Swap', 'Kuriboh'], ['Blue-Eyes White Dragon']);
  const k = place(e, 0, 'Kuriboh')!;
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  playSpell(e, 0, 'Creature Swap');
  check(e.controller(k.uid) === 1 && e.controller(bewd.uid) === 0, 'each player switches control of 1 monster they control');
  bewd.placedTurn = -1;
  bewd.posChanged = false;
  check(!e.canChangePosition(0, bewd), 'they cannot change their battle positions this turn');
}

card('Creeping Darkness');
{
  const e = duel(['Creeping Darkness', 'Infernity Beast', 'Dark Magician', 'Feral Imp']);
  toGy(e, 0, 'Infernity Beast');
  toGy(e, 0, 'Dark Magician');
  playSpell(e, 0, 'Creeping Darkness', { pick: ['Infernity Beast', 'Dark Magician'] }, { pick: ['Feral Imp'] });
  check(e.player(0).removed.length === 2 && inHand(e, 0, 'Feral Imp'), 'banishes 2 DARK monsters from your GY to add a Level 4 DARK monster from the Deck');
}

card('Crystal Aegis');
{
  const e = duel(['Crystal Aegis', TIGER]);
  const tiger = place(e, 0, TIGER)!;
  playSpell(e, 0, 'Crystal Aegis', { pick: [TIGER] }, 'no');
  const tok = e.monsters(0).find((m) => m.name === 'Crystal Beast Token');
  check(grave(e, tiger) && !!tok && e.atkOf(tok) === 1600 && e.defOf(tok) === 1000 && e.raceOf(tok) === 'Beast', 'destroys the Crystal Beast, then Special Summons a Crystal Beast Token with its original stats');
}

card('Crystal Beacon');
{
  const e = duel(['Crystal Beacon', TIGER, CAT, 'Crystal Beast Cobalt Eagle']);
  cbToST(e, 0, TIGER);
  const beacon = grab(e, 0, 'Crystal Beacon');
  check(!e.canActivateMain(0, beacon.uid), 'needs 2 or more Crystal Beast cards in your Spell & Trap Zone');
  cbToST(e, 0, CAT);
  playSpell(e, 0, 'Crystal Beacon', { pick: ['Crystal Beast Cobalt Eagle'] });
  check(e.monsters(0).some((m) => m.name === 'Crystal Beast Cobalt Eagle'), 'Special Summons a Crystal Beast from the Deck');
}

card('Crystal Blessing');
{
  const e = duel(['Crystal Blessing', TIGER, CAT]);
  const a = toGy(e, 0, TIGER);
  const b = toGy(e, 0, CAT);
  const bl = grab(e, 0, 'Crystal Blessing');
  act(e, 0, bl.uid, { pick: [TIGER, CAT] });
  check(zone(e, a) === 'sz' && zone(e, b) === 'sz' && grave(e, bl), 'places up to 2 Crystal Beasts from the GY face-up in the Spell & Trap Zone');
}

card('Crystal Boon');
{
  const e = duel(['Crystal Boon', TIGER, CAT]);
  cbToST(e, 0, TIGER);
  cbToST(e, 0, CAT);
  playTrap(e, 0, 'Crystal Boon', { pick: [TIGER, CAT] });
  check(e.monsters(0).length === 2 && lp(e, 0) === 4000 + 1600 + 1200, 'Special Summons 2 Crystal Beasts from the Spell & Trap Zone and gains their combined original ATK');
}

card('Crystal Brilliance');
{
  const e = duel(['Crystal Brilliance', TIGER]);
  const br = playTrap(e, 0, 'Crystal Brilliance')!;
  const tiger = place(e, 0, TIGER)!;
  const f = place(e, 0, FILL)!;
  check(active(e, br) && e.atkOf(tiger) === 1600 + 1000 && e.atkOf(f) === 1400, 'each Crystal Beast you control gains ATK equal to its original DEF (others do not)');
}

{
  const e = duel(['Crystal Brilliance', 'Crystal Aegis', TIGER]);
  playTrap(e, 0, 'Crystal Brilliance');
  place(e, 0, TIGER);
  playSpell(e, 0, 'Crystal Aegis', { pick: [TIGER] }, 'no');
  const tok = e.monsters(0).find((m) => m.name === 'Crystal Beast Token');
  check(!!tok && e.atkOf(tok) === 1600 + 1000, "a Crystal Beast Token gains its own original DEF (the copied monster's)");
}

card('Crystal Conclave');
{
  const e = duel(['Crystal Conclave', TIGER, CAT], [FILL]);
  const cc = playTrap(e, 0, 'Crystal Conclave')!;
  const tiger = place(e, 0, TIGER)!;
  kill(e, [tiger], 1, 'no', 'yes', { pick: [CAT] });
  check(e.monsters(0).some((m) => m.name === CAT) && active(e, cc), 'a face-up Crystal Beast destroyed: Special Summon a Crystal Beast from the Deck');
}

card('Crystal Miracle');
{
  const e = duel(['Crystal Miracle', TIGER, 'Pot of Greed']);
  const tiger = place(e, 0, TIGER)!;
  putST(e, 0, 'Crystal Miracle');
  const pot = grab(e, 0, 'Pot of Greed');
  const h = hand(e, 0);
  act(e, 0, pot.uid, { respond: 'Crystal Miracle' }, { pick: [TIGER] }, 'no');
  check(grave(e, tiger) && hand(e, 0) === h - 1 && grave(e, pot), 'destroys a Crystal Beast you control to negate the activation and destroy that card');
}

{
  const e = duel(['Crystal Miracle', TIGER, FILL, 'Kuriboh'], ['Dark Smog', 'Archfiend Soldier']);
  place(e, 0, TIGER);
  putST(e, 0, 'Crystal Miracle');
  toGy(e, 0, 'Kuriboh');
  const sm = putST(e, 1, 'Dark Smog');
  sm.faceUp = true;
  sm.active = true;
  grab(e, 1, 'Archfiend Soldier');
  const f = grab(e, 0, FILL);
  e.apply({ type: 'SUMMON', player: 0, uid: f.uid, zone: 1, pos: 'atk', faceUp: true });
  let offered = false;
  let smogUsed = false;
  for (let i = 0; i < 50 && e.state.prompt; i++) {
    const pr = e.state.prompt;
    if (pr.kind === 'response' && pr.player === 1 && !smogUsed) {
      const k = pr.options.findIndex((o) => o.label.startsWith('Dark Smog'));
      if (k >= 0) {
        smogUsed = true;
        e.apply({ type: 'CHOOSE', player: 1, picks: [k] });
        continue;
      }
    }
    if (pr.kind === 'response' && pr.player === 0 && smogUsed && pr.options.some((o) => o.label.startsWith('Crystal Miracle'))) offered = true;
    if (pr.kind === 'response') e.apply({ type: 'PASS', player: pr.player });
    else if (pr.kind === 'yesno') e.apply({ type: 'NO', player: pr.player });
    else e.apply({ type: 'CHOOSE', player: pr.player, picks: [0] });
  }
  check(smogUsed && !offered, 'not against the effect of a Spell/Trap already on the field (only card activations and monster effects)');
}

card('Crystal Promise');
{
  const e = duel(['Crystal Promise', TIGER]);
  const tiger = cbToST(e, 0, TIGER);
  playSpell(e, 0, 'Crystal Promise', { pick: [TIGER] });
  check(zone(e, tiger) === 'mz', 'Special Summons the targeted Crystal Beast from the Spell & Trap Zone');
}

card('Crystal Raigeki');
{
  const e = duel(['Crystal Raigeki', TIGER], [FILL]);
  const tiger = cbToST(e, 0, TIGER);
  const foe = place(e, 1, FILL)!;
  playTrap(e, 0, 'Crystal Raigeki', { pick: [TIGER] }, { pick: [FILL] });
  check(grave(e, tiger) && grave(e, foe), 'sends a Crystal Beast from your Spell & Trap Zone to the GY to destroy a card your opponent controls');
}

card('Crystal Release');
{
  const e = duel(['Crystal Release', TIGER, CAT]);
  const tiger = place(e, 0, TIGER)!;
  place(e, 0, FILL);
  const rel = playSpell(e, 0, 'Crystal Release', { pick: [TIGER] })!;
  check(e.atkOf(tiger) === 2400, 'equipped Crystal Beast gains 800 ATK');
  kill(e, [rel], 1, 'yes', { pick: [CAT] });
  check(e.player(0).sz.some((c) => c?.name === CAT), 'sent from the field to the GY: places a Crystal Beast from the Deck in the Spell & Trap Zone');
}

card('Crystal Tree');
{
  const e = duel(['Crystal Tree', TIGER, CAT]);
  const tree = playSpell(e, 0, 'Crystal Tree')!;
  cbToST(e, 0, TIGER);
  check(tree.counters === 1, 'a Crystal Beast placed in the Spell & Trap Zone: 1 Crystal Counter');
  effect(e, 0, tree, { pick: [CAT] });
  check(grave(e, tree) && e.player(0).sz.some((c) => c?.name === CAT), 'send it to the GY: place that many Crystal Beasts from the Deck');
}

card('Cup of Ace');
{
  const e = duel(['Cup of Ace']);
  e.roll = () => 1;
  const h = hand(e, 0);
  playSpell(e, 0, 'Cup of Ace');
  check(hand(e, 0) === h + 2, 'Heads: you draw 2');
}
{
  const e = duel(['Cup of Ace']);
  e.roll = () => 2;
  const h = hand(e, 1);
  playSpell(e, 0, 'Cup of Ace');
  check(hand(e, 1) === h + 2, 'Tails: your opponent draws 2');
}

card('Curse of Aging');
{
  const e = duel(['Curse of Aging'], ['Gemini Elf', 'Mystical Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  const down = place(e, 1, 'Mystical Elf', 'def', false)!;
  const h = hand(e, 0);
  playTrap(e, 0, 'Curse of Aging', { pick: [FILL] });
  check(e.atkOf(elf) === 1400 && e.defOf(elf) === 400 && hand(e, 0) === h - 1, "discard 1: your opponent's face-up monsters lose 500 ATK/DEF");
  down.faceUp = true;
  check(e.atkOf(down) === 800 && e.defOf(down) === 2000, 'a face-down monster is not affected (flipped later, it keeps its stats)');
  endTurn(e);
  check(e.atkOf(elf) === 1900, 'until the end of the turn');
}

card('Curse of Anubis');
{
  const e = duel(['Curse of Anubis', 'Cyber Gymnast', 'Gemini Elf']);
  const g = place(e, 0, 'Cyber Gymnast')!;
  const elf = place(e, 0, 'Gemini Elf')!;
  playTrap(e, 0, 'Curse of Anubis');
  check(g.pos === 'def' && e.defOf(g) === 0 && elf.pos === 'atk', 'Effect Monsters change to Defense Position with 0 original DEF (Normal Monsters are not affected)');
  g.placedTurn = -1;
  g.posChanged = false;
  check(!e.canChangePosition(0, g), 'their battle positions cannot be changed this turn');
}

card('Cursed Eldland');
{
  const e = duel(['Cursed Eldland', 'Cursed Eldland', 'Conquistador of the Golden Land', 'Conquistador of the Golden Land'], [FILL]);
  const el = playSpell(e, 0, 'Cursed Eldland')!;
  const el2 = playSpell(e, 0, 'Cursed Eldland')!;
  effect(e, 0, el, { pick: ['Conquistador of the Golden Land'] });
  check(inHand(e, 0, 'Conquistador of the Golden Land') && lp(e, 0) === 3200, 'pay 800 LP: add a "Golden Land" Spell/Trap from the Deck');
  check(!e.canUseMonsterEffect(0, el2), 'only once per turn (a second copy cannot use it)');
  kill(e, [el], 1, 'yes');
  check(e.player(0).gy.some((x) => x.name === 'Conquistador of the Golden Land'), 'sent from the Spell & Trap Zone to the GY: send a "Golden Land" card from the Deck to the GY');
}
{
  const e = duel(['Cursed Eldland', 'Armored Zombie'], [FILL]);
  playSpell(e, 0, 'Cursed Eldland');
  const c = place(e, 0, FILL)!;
  const z = place(e, 0, 'Armored Zombie')!;
  place(e, 1, FILL);
  toTurn3(e);
  toBattle(e);
  check(!e.canAttackWith(0, c) && e.canAttackWith(0, z), 'you cannot declare attacks except with Zombie monsters');
}

card('Cursed Seal of the Forbidden Spell');
{
  const e = duel(['Cursed Seal of the Forbidden Spell', 'Dark Hole'], ['Pot of Greed', 'Pot of Greed']);
  putST(e, 0, 'Cursed Seal of the Forbidden Spell');
  grab(e, 0, 'Dark Hole');
  endTurn(e);
  const pot = grab(e, 1, 'Pot of Greed');
  const h = hand(e, 1);
  act(e, 1, pot.uid, { respond: 'Cursed Seal of the Forbidden Spell' }, { pick: ['Dark Hole'] });
  check(grave(e, pot) && hand(e, 1) === h - 1 && e.player(0).gy.some((c) => c.name === 'Dark Hole'), 'discard a Spell: negate the Spell activation and destroy it');
  check(!e.canActivateMain(1, grab(e, 1, 'Pot of Greed').uid), 'your opponent cannot activate Spells with that name for the rest of the Duel');
}

card('Cyber Energy Shock');
{
  const e = duel(['Cyber Energy Shock', 'Jinzo'], ['Mirror Force']);
  const jinzo = place(e, 0, 'Jinzo')!;
  const mf = putST(e, 1, 'Mirror Force');
  playSpell(e, 0, 'Cyber Energy Shock', { pick: ['Face-down card'] }, { pick: ['All "Jinzo" you control gain 800 ATK'] });
  check(grave(e, mf) && e.atkOf(jinzo) === 2400 + 800, 'destroys a card; it was a Trap: "Jinzo" gains 800 ATK');
}
{
  const e = duel(['Cyber Energy Shock', 'Jinzo'], ['Trap Hole', 'Messenger of Peace']);
  place(e, 0, 'Jinzo');
  const th = putST(e, 1, 'Trap Hole');
  const mop = putST(e, 1, 'Messenger of Peace');
  mop.faceUp = true;
  mop.active = true;
  playSpell(e, 0, 'Cyber Energy Shock', { pick: ['Face-down card'] }, { pick: ['Negate the effects of a face-up card'] }, { pick: ['Messenger of Peace'] });
  check(grave(e, th) && e.isNegated(mop) && !e.liveST().some((x) => x.c.uid === mop.uid), 'it was a Trap: can negate the effects of a face-up Spell/Trap until the end of the turn');
  endTurn(e);
  check(!e.isNegated(mop), 'only until the end of that turn');
}
{
  const e = duel(['Cyber Energy Shock']);
  const ces = grab(e, 0, 'Cyber Energy Shock');
  place(e, 0, FILL);
  check(!e.canActivateMain(0, ces.uid), 'needs a "Jinzo"');
}

card('Cyber Network');
{
  const e = duel(['Cyber Network', 'Cyber Dragon', 'Cyber Dragon Core', 'Crystal Tree'], [FILL]);
  const net = playTrap(e, 0, 'Cyber Network')!;
  place(e, 0, 'Cyber Dragon');
  effect(e, 0, net, { pick: ['Cyber Dragon Core'] });
  const core = e.player(0).removed.find((c) => c.name === 'Cyber Dragon Core');
  check(!!core, 'with "Cyber Dragon" on the field: banishes a LIGHT Machine from the Deck');
  const tree = playSpell(e, 0, 'Crystal Tree')!;
  kill(e, [net], 1);
  check(zone(e, core) === 'mz' && grave(e, tree), 'sent from the field to the GY: Special Summons the banished LIGHT Machines, then destroys your Spells/Traps');
}
{
  const e = duel(['Cyber Network']);
  const net = playTrap(e, 0, 'Cyber Network')!;
  for (let i = 0; i < 4; i++) endTurn(e);
  check(zone(e, net) === 'sz', 'still on the field after 2 of your Standby Phases');
  endTurn(e);
  endTurn(e);
  check(grave(e, net), 'destroyed during your 3rd Standby Phase after activation');
}

card('Cyber Repair Plant');
{
  const e = duel(['Cyber Repair Plant', 'Cyber Dragon', 'Cyber Dragon Core']);
  toGy(e, 0, 'Cyber Dragon');
  playSpell(e, 0, 'Cyber Repair Plant', { pick: ['Add a LIGHT Machine from your Deck'] }, { pick: ['Cyber Dragon Core'] });
  check(inHand(e, 0, 'Cyber Dragon Core'), 'with "Cyber Dragon" in the GY: adds a LIGHT Machine from the Deck');
  check(!e.canActivateMain(0, grab(e, 0, 'Cyber Repair Plant').uid), 'only 1 activation per turn');
}
{
  const e = duel(['Cyber Repair Plant', 'Cyber Dragon', 'Cyber Dragon', 'Cyber Dragon', 'Cyber Dragon Core']);
  for (let i = 0; i < 3; i++) toGy(e, 0, 'Cyber Dragon');
  playSpell(e, 0, 'Cyber Repair Plant', { pick: ['Both'] }, { pick: ['Cyber Dragon'] }, { pick: ['Cyber Dragon Core'] });
  check(inHand(e, 0, 'Cyber Dragon Core') && e.player(0).gy.filter((c) => c.name === 'Cyber Dragon').length === 2, '3 "Cyber Dragon" in the GY: both effects (search, and shuffle a LIGHT Machine from the GY into the Deck)');
}

card('Cyber Shadow Gardna');
{
  const e = duel(['Cyber Shadow Gardna'], ['Mystical Elf', FILL]);
  const g = putST(e, 0, 'Cyber Shadow Gardna');
  endTurn(e);
  const elf = place(e, 1, 'Mystical Elf', 'atk', true, { respond: 'Cyber Shadow Gardna' })!;
  const gm = e.fieldCard(g.uid)!;
  check(zone(e, g) === 'mz' && e.raceOf(gm) === 'Machine' && e.atkOf(gm) === 0, "opponent's Main Phase: Special Summoned as a Machine monster with ATK/DEF ?");
  toBattle(e);
  attack(e, elf, gm);
  check(zone(e, g) === 'mz' && e.defOf(e.fieldCard(g.uid)!) === 2000, "attacked: its ATK/DEF become the attacker's");
  endTurn(e);
  check(zone(e, g) === 'sz' && !e.fieldCard(g.uid)!.faceUp, "opponent's End Phase: Set again in its Spell & Trap Zone");
}

card('Cyberdark Impact!');
{
  const e = duel(['Cyberdark Impact!', 'Cyberdark Horn', 'Cyberdark Edge', 'Cyberdark Keel'], [], ['Cyberdark Dragon']);
  grab(e, 0, 'Cyberdark Horn');
  toGy(e, 0, 'Cyberdark Edge');
  place(e, 0, 'Cyberdark Keel', 'def', false);
  playSpell(e, 0, 'Cyberdark Impact!', { pick: ['Cyberdark Horn'] }, { pick: ['Cyberdark Edge'] }, { pick: ['Cyberdark Keel'] });
  const cd = e.monsters(0).find((m) => m.name === 'Cyberdark Dragon');
  check(!!cd && ['Cyberdark Horn', 'Cyberdark Edge', 'Cyberdark Keel'].every((n) => e.player(0).deck.some((c) => c.name === n)), 'returns Horn, Edge and Keel (hand, GY, field) to the Deck to Fusion Summon "Cyberdark Dragon"');
}

{
  // A Cyberdark monster equipped (by Cyberdark Edge's effect) sits in the Spell & Trap Zone: still "on your field".
  const e = duel(['Cyberdark Impact!', 'Cyberdark Horn', 'Cyberdark Edge', 'Cyberdark Keel'], [], ['Cyberdark Dragon']);
  const edge = place(e, 0, 'Cyberdark Edge')!;
  const keel = putST(e, 0, 'Cyberdark Keel');
  keel.faceUp = true;
  keel.active = true;
  keel.equippedTo = edge.uid;
  edge.equips.push(keel.uid);
  grab(e, 0, 'Cyberdark Horn');
  playSpell(e, 0, 'Cyberdark Impact!', { pick: ['Cyberdark Horn'] }, { pick: ['Cyberdark Edge'] }, { pick: ['Cyberdark Keel'] });
  check(!!keel && e.monsters(0).some((m) => m.name === 'Cyberdark Dragon') && zone(e, keel) === 'deck' && zone(e, edge) === 'deck', 'can return a Cyberdark monster equipped in your Spell & Trap Zone');
}

card('Cybernetic Horizon');
{
  const e = duel(['Cybernetic Horizon', 'Cyber Dragon', 'Cyberdark Horn', 'Cyber Dragon Core'], [], ['Cyber End Dragon', 'Cyberse Desavewurm']);
  grab(e, 0, 'Cyber Dragon');
  playSpell(e, 0, 'Cybernetic Horizon', { pick: ['Cyber Dragon'] }, { pick: ['Cyberdark Horn'] }, { pick: ['Cyber Dragon Core'] }, { pick: ['Cyber End Dragon'] });
  check(e.player(0).gy.some((c) => c.name === 'Cyber Dragon') && e.player(0).gy.some((c) => c.name === 'Cyberdark Horn') && inHand(e, 0, 'Cyber Dragon Core') && e.player(0).gy.some((c) => c.name === 'Cyber End Dragon'), 'sends 2 "Cyber" monsters (hand + Deck, different Attributes), adds 1, sends a Machine "Cyber" Fusion from the Extra Deck');
  const wurm = e.player(0).fusion.find((c) => c.name === 'Cyberse Desavewurm')!;
  check(e.summonBlocked(0, wurm, 'special', 'fusion'), 'only Machine monsters can be Special Summoned from the Extra Deck this turn');
}

card('Cynet Rollback');
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
  check(e.player(0).hand.filter((x) => x.name === 'Danmari @Ignister').length === 2 && zone(e, rb) === 'removed', 'LP 2000 or less: banish it to add 2 banished Cyberse monsters');
}

card('D - Chain');
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
{
  const e = duel([DD, 'D - Chain'], ['Gemini Elf']);
  const dd = place(e, 0, DD)!;
  playTrap(e, 0, 'D - Chain', { pick: [DD] });
  endTurn(e);
  const elf = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, elf, dd);
  check(grave(e, elf) && lp(e, 1) === 4000 - 500 - 500, 'also when the equipped monster is attacked and destroys the attacker by battle');
}

card('D - Counter');
{
  const e = duel([DD, 'D - Counter'], ['Gemini Elf']);
  const dd = place(e, 0, DD)!;
  putST(e, 0, 'D - Counter');
  endTurn(e);
  const elf = place(e, 1, 'Gemini Elf')!;
  toBattle(e);
  attack(e, elf, dd, { respond: 'D - Counter' });
  check(grave(e, elf) && zone(e, dd) === 'mz' && lp(e, 0) === 4000, 'a "Destiny HERO" targeted for an attack: destroys the attacking monster');
}

card('D - Spirit');
{
  const e = duel(['D - Spirit', DD, DD]);
  grab(e, 0, DD);
  playSpell(e, 0, 'D - Spirit', { pick: [DD] });
  check(e.monsters(0).some((m) => m.name === DD), 'Special Summons a Level 4 or lower "Destiny HERO" from the hand');
  grab(e, 0, DD);
  check(!e.canActivateMain(0, grab(e, 0, 'D - Spirit').uid), 'not while you control a face-up "Destiny HERO"');
}

card('Damage Condenser');
{
  const e = duel(['Damage Condenser', 'Gemini Elf', 'Blue-Eyes White Dragon'], ['Gemini Elf']);
  putST(e, 0, 'Damage Condenser');
  endTurn(e);
  const elf = place(e, 1, 'Gemini Elf')!;
  toBattle(e);
  attack(e, elf, null, { respond: 'Damage Condenser' }, { pick: [FILL] }, { pick: ['Gemini Elf'] });
  check(lp(e, 0) === 4000 - 1900 && e.monsters(0).some((m) => m.name === 'Gemini Elf' && m.pos === 'atk' && m.faceUp), 'battle damage: discard 1 to Special Summon a monster with ATK up to that damage in Attack Position');
}

// ======================= cards-04 =======================
card('Dark Calling');
{
  const e = duel(['Dark Calling', 'Elemental HERO Avian', 'Elemental HERO Burstinatrix'], D(), ['Evil HERO Inferno Wing']);
  const av = grab(e, 0, 'Elemental HERO Avian');
  const bu = toGy(e, 0, 'Elemental HERO Burstinatrix');
  playSpell(e, 0, 'Dark Calling');
  check(e.monsters(0).some((m) => m.name === 'Evil HERO Inferno Wing') && zone(e, av) === 'removed' && zone(e, bu) === 'removed', 'banishes the listed materials from the hand and GY: Fusion Summons a "Dark Fusion" monster');
}
{
  const e = duel(['Dark Calling', 'Archfiend Soldier', 'Giant Soldier of Stone'], D(), ['Evil HERO Dark Gaia']);
  const a = toGy(e, 0, 'Archfiend Soldier');
  const b = grab(e, 0, 'Giant Soldier of Stone');
  playSpell(e, 0, 'Dark Calling');
  const g = e.monsters(0).find((m) => m.name === 'Evil HERO Dark Gaia');
  check(!!g && zone(e, a) === 'removed' && zone(e, b) === 'removed', 'also a monster whose materials are kinds of monsters (Dark Gaia: 1 Fiend + 1 Rock)');
}

card('Dark City');
{
  const e = duel(['Dark City', DD], D('Gemini Elf'));
  playSpell(e, 0, 'Dark City');
  const dd = place(e, 0, DD)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  check(e.atkOf(dd) === 1400, 'no bonus outside battle');
  toTurn3(e);
  toBattle(e);
  attack(e, dd, elf);
  check(grave(e, elf) && zone(e, dd) === 'mz' && lp(e, 1) === 4000 - 500 && e.atkOf(dd) === 1400, 'a weaker "Destiny HERO" attacking gains 1000 ATK for the battle only');
}

card('Dark Contract with Patent License');
{
  const e = duel(['Dark Contract with Patent License', 'D/D Test Imp'], D(), ['D/D/D Test Overlord'], ['Flame Swordsman', 'Flame Swordsman']);
  const dc = playSpell(e, 0, 'Dark Contract with Patent License')!;
  place(e, 0, 'D/D/D Test Overlord');
  endTurn(e);
  place(e, 1, 'Flame Swordsman', 'atk', true, 'yes');
  check(lp(e, 1) === 3000, 'your opponent Special Summons a monster of the same card type as your "D/D/D": 1000 damage');
  const fs2 = e.player(1).fusion.find((c) => c.name === 'Flame Swordsman')!;
  check(e.summonBlocked(1, fs2, 'special', 'fusion'), 'they cannot Special Summon that card type for the rest of this turn');
  const imp = toGy(e, 0, 'D/D Test Imp');
  kill(e, [dc], 1, 'yes');
  check(zone(e, imp) === 'hand', 'sent to the GY: add a "D/D" monster from your GY to your hand');
}

card('Dark Deal');
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

card('Dark Eruption');
{
  const e = duel(['Dark Eruption', 'Dark Mimic LV1', 'Summoned Skull']);
  const m = toGy(e, 0, 'Dark Mimic LV1');
  const sk = toGy(e, 0, 'Summoned Skull');
  const de = grab(e, 0, 'Dark Eruption');
  act(e, 0, de.uid);
  check(zone(e, m) === 'hand' && grave(e, sk), 'adds a DARK monster with 1500 or less ATK from your GY (not a stronger one)');
}

card('Dark Factory of Mass Production');
{
  const e = duel(['Dark Factory of Mass Production', 'Gemini Elf', 'Mystical Elf']);
  const a = toGy(e, 0, 'Gemini Elf');
  const b = toGy(e, 0, 'Mystical Elf');
  playSpell(e, 0, 'Dark Factory of Mass Production', { pick: ['Gemini Elf', 'Mystical Elf'] });
  check(zone(e, a) === 'hand' && zone(e, b) === 'hand', 'adds 2 Normal Monsters from your GY to your hand');
}

card('Dark Fusion');
{
  const e = duel(['Dark Fusion', 'Elemental HERO Avian', 'Elemental HERO Burstinatrix'], D(), ['Evil HERO Inferno Wing']);
  grab(e, 0, 'Elemental HERO Avian');
  grab(e, 0, 'Elemental HERO Burstinatrix');
  playSpell(e, 0, 'Dark Fusion');
  const iw = e.monsters(0).find((m) => m.name === 'Evil HERO Inferno Wing')!;
  e.actor = 1;
  const oppNo = !!iw && e.untargetable(iw);
  e.actor = 0;
  check(!!iw && oppNo, 'Fusion Summons a Fiend Fusion Monster; your opponent cannot target it with card effects this turn');
}
{
  const e = duel(['Dark Fusion', 'Archfiend Soldier', 'Giant Soldier of Stone'], D(), ['Evil HERO Dark Gaia']);
  grab(e, 0, 'Giant Soldier of Stone');
  place(e, 0, 'Archfiend Soldier');
  playSpell(e, 0, 'Dark Fusion');
  const g = e.monsters(0).find((m) => m.name === 'Evil HERO Dark Gaia');
  check(!!g && e.atkOf(g) === 1900 + 1300, 'materials by kind work too (Evil HERO Dark Gaia from 1 Fiend + 1 Rock, hand and field)');
}
{
  const e = duel(['Dark Fusion', 'Evil HERO Malicious Edge', 'Summoned Skull'], D(), ['Evil HERO Malicious Fiend']);
  grab(e, 0, 'Evil HERO Malicious Edge');
  grab(e, 0, 'Summoned Skull');
  playSpell(e, 0, 'Dark Fusion');
  check(e.monsters(0).some((m) => m.name === 'Evil HERO Malicious Fiend'), '"Evil HERO Malicious Edge" + 1 Level 6 or higher Fiend monster: Evil HERO Malicious Fiend');
}

card('Dark Magic Attack');
{
  const e = duel(['Dark Magic Attack', 'Dark Magician'], D('Mirror Force', 'Messenger of Peace'));
  place(e, 0, 'Dark Magician');
  const a = putST(e, 1, 'Mirror Force');
  const b = putST(e, 1, 'Messenger of Peace');
  b.faceUp = true;
  b.active = true;
  playSpell(e, 0, 'Dark Magic Attack');
  check(grave(e, a) && grave(e, b), 'you control "Dark Magician": destroys all Spells/Traps your opponent controls');
}
{
  const e = duel(['Dark Magic Attack'], D('Mirror Force'));
  putST(e, 1, 'Mirror Force');
  check(!e.canActivateMain(0, grab(e, 0, 'Dark Magic Attack').uid), 'needs "Dark Magician"');
}

card('Dark Magic Curtain');
{
  const e = duel(['Dark Magic Curtain', 'Dark Magician']);
  playSpell(e, 0, 'Dark Magic Curtain');
  check(lp(e, 0) === 2000 && e.monsters(0).some((m) => m.name === 'Dark Magician'), 'pay half your LP: Special Summon "Dark Magician" from your Deck');
  const f = grab(e, 0, FILL);
  check(e.summonBlocked(0, f, 'normal', 'hand') && !e.summonBlocked(0, f, 'set', 'hand'), 'you cannot Summon other monsters this turn (but you can Set)');
}

card('Dark Renewal');
{
  const e = duel(['Dark Renewal', 'Gemini Elf', 'Dark Magician'], D());
  const elf = place(e, 0, 'Gemini Elf')!;
  putST(e, 0, 'Dark Renewal');
  endTurn(e);
  const f = grab(e, 1, FILL);
  e.apply({ type: 'SUMMON', player: 1, uid: f.uid, zone: 0, pos: 'atk', faceUp: true });
  settle(e, { respond: 'Dark Renewal' }, 'yes');
  check(grave(e, f) && grave(e, elf) && e.monsters(0).some((m) => m.name === 'Dark Magician'), 'the Summoned monster and your Spellcaster go to the GY, then a DARK Spellcaster is Special Summoned from the Deck');
}

card('Dark Smog');
{
  const e = duel(['Dark Smog', 'Archfiend Soldier'], D('Gemini Elf'));
  const g = toGy(e, 1, 'Gemini Elf');
  grab(e, 0, 'Archfiend Soldier');
  const sm = playTrap(e, 0, 'Dark Smog')!;
  effect(e, 0, sm, { pick: ['Gemini Elf'] }, { pick: ['Archfiend Soldier'] });
  check(zone(e, g) === 'removed' && e.player(0).gy.some((c) => c.name === 'Archfiend Soldier') && active(e, sm), "discard a Fiend: banish the targeted monster in your opponent's GY");
}
{
  const e = duel(['Dark Smog', 'Archfiend Soldier', 'Summoned Skull'], D('Gemini Elf', 'Kuriboh'));
  const g = toGy(e, 1, 'Gemini Elf');
  toGy(e, 1, 'Kuriboh');
  grab(e, 0, 'Archfiend Soldier');
  grab(e, 0, 'Summoned Skull');
  const sm = playTrap(e, 0, 'Dark Smog')!;
  endTurn(e);
  const f = grab(e, 1, FILL);
  e.apply({ type: 'SUMMON', player: 1, uid: f.uid, zone: 0, pos: 'atk', faceUp: true });
  settle(e, { respond: 'Dark Smog' }, { pick: ['Gemini Elf'] }, { pick: ['Archfiend Soldier'] });
  check(zone(e, g) === 'removed', "usable on your opponent's turn too (a Continuous Trap effect)");
  const before = e.player(1).removed.length;
  e.apply({ type: 'NEXT_PHASE', player: 1 });
  settle(e, { respond: 'Dark Smog' }, { pick: ['Kuriboh'] }, { pick: ['Summoned Skull'] });
  check(e.player(1).removed.length === before && !!sm, 'only once per turn');
}

card("Dark Spirit's Mastery");
{
  const e = duel(["Dark Spirit's Mastery", 'Destiny Board']);
  const h = hand(e, 0);
  playSpell(e, 0, "Dark Spirit's Mastery", { pick: [FILL] }, { pick: ['Destiny Board'] });
  const ms = e.player(0).gy.find((c) => c.name === "Dark Spirit's Mastery")!;
  check(inHand(e, 0, 'Destiny Board') && hand(e, 0) === h && e.player(0).gy.some((c) => c.name === FILL), 'discard 1: add "Destiny Board" from the Deck');
  check(!e.canUseGraveEffect(0, ms.uid), 'its GY effect cannot be used the turn it was sent to the GY');
  toTurn3(e);
  const h2 = hand(e, 0);
  graveFx(e, 0, ms, { pick: ['Destiny Board'] });
  check(zone(e, ms) === 'removed' && hand(e, 0) === h2, 'banish it: put "Destiny Board" on the bottom of the Deck and draw 1');
}

card('Dark World Lightning');
{
  const e = duel(['Dark World Lightning'], D('Mirror Force'));
  const mf = putST(e, 1, 'Mirror Force');
  const h = hand(e, 0);
  playSpell(e, 0, 'Dark World Lightning');
  check(grave(e, mf) && hand(e, 0) === h - 1, 'destroys the targeted Set card, then you discard 1 card');
}
{
  const e = duel(['Dark World Lightning'], D('Mystical Space Typhoon'));
  const mst = putST(e, 1, 'Mystical Space Typhoon');
  const dwl = grab(e, 0, 'Dark World Lightning');
  const h = hand(e, 0);
  act(e, 0, dwl.uid, { pick: ['Face-down card'] }, { respond: 'Mystical Space Typhoon' });
  check(grave(e, mst) && hand(e, 0) === h - 1 && !e.player(0).gy.some((c) => c.name === FILL), 'the target was not destroyed by it (activated in response): no discard');
}

card('Darklord Contact');
{
  const e = duel(['Darklord Contact', 'Darklord Contact', 'Darklord Nasten', 'Darklord Nasten']);
  const n = toGy(e, 0, 'Darklord Nasten');
  toGy(e, 0, 'Darklord Nasten');
  playSpell(e, 0, 'Darklord Contact');
  const m = e.fieldCard(n.uid);
  check(!!m && m.pos === 'def', 'Special Summons a "Darklord" monster from your GY in Defense Position');
  check(!e.canActivateMain(0, grab(e, 0, 'Darklord Contact').uid), 'only 1 activation per turn');
}

card('Darklord Enchantment');
{
  const e = duel(['Darklord Enchantment', 'Darklord Nasten'], D('Gemini Elf'));
  grab(e, 0, 'Darklord Nasten');
  const elf = place(e, 1, 'Gemini Elf')!;
  playTrap(e, 0, 'Darklord Enchantment');
  check(e.controller(elf.uid) === 0 && e.player(0).gy.some((c) => c.name === 'Darklord Nasten'), 'send a "Darklord" to the GY: take control of a face-up monster your opponent controls');
  endTurn(e);
  check(e.controller(elf.uid) === 1, 'until the End Phase');
}

card('De-Fusion');
{
  const e = duel(['De-Fusion', 'Flame Manipulator', 'Masaki the Legendary Swordsman'], D(), ['Flame Swordsman']);
  const fs = place(e, 0, 'Flame Swordsman')!;
  const a = toGy(e, 0, 'Flame Manipulator');
  const b = toGy(e, 0, 'Masaki the Legendary Swordsman');
  playSpell(e, 0, 'De-Fusion', 'yes');
  check(zone(e, fs) === 'fusion' && zone(e, a) === 'mz' && zone(e, b) === 'mz', 'returns the Fusion Monster to the Extra Deck, then Special Summons its materials from your GY');
}
{
  const e = duel(['De-Fusion'], D(), [], ['Flame Swordsman']);
  const fs = place(e, 1, 'Flame Swordsman')!;
  const df = putST(e, 0, 'De-Fusion');
  endTurn(e);
  const f = grab(e, 1, FILL);
  e.apply({ type: 'SUMMON', player: 1, uid: f.uid, zone: 1, pos: 'atk', faceUp: true });
  settle(e, { respond: 'De-Fusion' });
  check(zone(e, fs) === 'fusion' && grave(e, df), "a Quick-Play Spell: Set, it works on your opponent's turn against their Fusion Monster");
}

card('Destiny Board');
{
  const e = duel(['Destiny Board', 'Spirit Message "I"', 'Spirit Message "N"'], D());
  const board = playTrap(e, 0, 'Destiny Board')!;
  check(active(e, board), 'Destiny Board stays on the field');
  endTurn(e);
  endTurn(e);
  const i = e.spells(0).find((c) => c.name === 'Spirit Message "I"');
  check(!!i && i.faceUp, "your opponent's End Phase: places \"Spirit Message I\" face-up from the Deck");
  kill(e, [i], 1);
  check(grave(e, board), 'a "Spirit Message" leaving the field sends Destiny Board to the GY');
}

card('Destiny Signal');
{
  const e = duel(['Destiny Signal', DD], D('Gemini Elf'));
  const f = place(e, 0, FILL)!;
  putST(e, 0, 'Destiny Signal');
  endTurn(e);
  const elf = place(e, 1, 'Gemini Elf')!;
  toBattle(e);
  attack(e, elf, f, { respond: 'Destiny Signal' });
  check(grave(e, f) && e.monsters(0).some((m) => m.name === DD), 'your monster destroyed by battle: Special Summon a Level 4 or lower "Destiny HERO" from the Deck');
}

card('Destruction Swordsman Fusion');
{
  const e = duel(['Destruction Swordsman Fusion', 'Dark Magician', 'Buster Blader'], D(), ['Dark Paladin']);
  grab(e, 0, 'Dark Magician');
  place(e, 0, 'Buster Blader');
  const dsf = grab(e, 0, 'Destruction Swordsman Fusion');
  act(e, 0, dsf.uid);
  check(e.monsters(0).some((m) => m.name === 'Dark Paladin'), 'Fusion Summons a monster that lists "Buster Blader" as material');
  toTurn3(e);
  graveFx(e, 0, dsf);
  check(zone(e, dsf) === 'hand', 'in the GY: send 1 card from your hand to the GY to add it to your hand');
}
{
  const e = duel(['Destruction Swordsman Fusion', 'Dark Magician'], D('Buster Blader'), ['Dark Paladin']);
  grab(e, 0, 'Dark Magician');
  const bb = place(e, 1, 'Buster Blader')!;
  playSpell(e, 0, 'Destruction Swordsman Fusion');
  check(e.monsters(0).some((m) => m.name === 'Dark Paladin') && grave(e, bb), "can use a monster on your opponent's side of the field as material");
}

card('Dicephoon');
{
  const e = duel(['Dicephoon'], D('Mirror Force', 'Trap Hole'));
  const mf = putST(e, 1, 'Mirror Force');
  const th = putST(e, 1, 'Trap Hole');
  e.roll = () => 5;
  playSpell(e, 0, 'Dicephoon');
  check(grave(e, mf) && grave(e, th), 'roll 5: destroy 2 Spells/Traps');
}
{
  const e = duel(['Dicephoon'], D('Mirror Force'));
  const mf = putST(e, 1, 'Mirror Force');
  e.roll = () => 1;
  playSpell(e, 0, 'Dicephoon');
  check(lp(e, 0) === 3000 && zone(e, mf) === 'sz', 'roll 1 or 6: you take 1000 damage');
}

card('Different Dimension Capsule');
{
  const e = duel(['Different Dimension Capsule', 'Pot of Greed']);
  const cap = playSpell(e, 0, 'Different Dimension Capsule', { pick: ['Pot of Greed'] });
  const pot = e.player(0).removed.find((c) => c.name === 'Pot of Greed');
  check(!!cap && active(e, cap) && !!pot, 'banishes a card from the Deck and stays on the field');
  toTurn3(e);
  check(zone(e, cap) === 'sz' && zone(e, pot) === 'removed', 'not yet at your 1st Standby Phase');
  toTurn3(e);
  check(grave(e, cap) && zone(e, pot) === 'hand', 'your 2nd Standby Phase: destroyed and the banished card is added to your hand');
}

card('Different Dimension Encounter');
{
  const e = duel(['Different Dimension Encounter', 'Gemini Elf'], D('Mystical Elf'));
  const a = e.player(0).deck.find((c) => c.name === 'Gemini Elf')!;
  e.banish(a.uid);
  const b = e.player(1).deck.find((c) => c.name === 'Mystical Elf')!;
  e.banish(b.uid);
  playTrap(e, 0, 'Different Dimension Encounter');
  const ma = e.fieldCard(a.uid);
  const mb = e.fieldCard(b.uid);
  check(!!ma && !!mb && !ma.faceUp && !mb.faceUp && ma.pos === 'def' && e.controller(b.uid) === 1, 'each player Special Summons 1 of their banished monsters in face-down Defense Position');
}
{
  const e = duel(['Different Dimension Encounter', 'Gemini Elf'], D());
  e.banish(e.player(0).deck.find((c) => c.name === 'Gemini Elf')!.uid);
  const t = putST(e, 0, 'Different Dimension Encounter');
  check(!e.canActivateMain(0, t.uid), 'both players need a banished monster');
}

card('Different Dimension Gate');
{
  const e = duel(['Different Dimension Gate'], D('Gemini Elf'));
  const mine = place(e, 0, FILL)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  const g = playSpell(e, 0, 'Different Dimension Gate')!;
  check(zone(e, mine) === 'removed' && zone(e, elf) === 'removed' && active(e, g), 'banishes the targeted monster on each side of the field');
  kill(e, [g], 1);
  check(zone(e, mine) === 'mz' && e.controller(elf.uid) === 1, 'destroyed and sent to the GY: the banished monsters return to the field');
}

card('Disposable Learner Device');
{
  const e = duel(['Disposable Learner Device', 'Gemini Elf', 'Mystical Elf']);
  const m = place(e, 0, FILL)!;
  toGy(e, 0, 'Gemini Elf');
  toGy(e, 0, 'Mystical Elf');
  const dld = playSpell(e, 0, 'Disposable Learner Device')!;
  check(e.atkOf(m) === 1400 + 400, 'the equipped monster gains 200 ATK for each monster in your GY');
  kill(e, [dld], 1);
  endTurn(e, 'yes');
  check(zone(e, dld) === 'sz', 'sent from the field to the GY this turn: Set it during the End Phase');
  kill(e, [e.fieldCard(dld.uid)], 1);
  check(zone(e, dld) === 'removed', 'banished when it leaves the field');
}

card('Doble Passe');
{
  const e = duel(['Doble Passe'], D('Gemini Elf'));
  const f = place(e, 0, FILL)!;
  putST(e, 0, 'Doble Passe');
  endTurn(e);
  const elf = place(e, 1, 'Gemini Elf')!;
  toBattle(e);
  attack(e, elf, f, { respond: 'Doble Passe' });
  check(lp(e, 1) === 4000 - 1400 && lp(e, 0) === 4000 - 1900 && zone(e, f) === 'mz', "the attack becomes direct; your opponent takes damage equal to your monster's ATK");
  endTurn(e);
  check(e.canAttackDirectly(f), 'your monster can attack directly during your next turn');
}

card('Dodododraw');
{
  const e = duel(['Dodododraw', 'Dodododraw', 'Dododo Test Warrior', 'Dododo Test Warrior']);
  grab(e, 0, 'Dododo Test Warrior');
  grab(e, 0, 'Dododo Test Warrior');
  grab(e, 0, 'Dodododraw');
  const h = hand(e, 0);
  playSpell(e, 0, 'Dodododraw');
  check(hand(e, 0) === h - 2 + 2 && e.player(0).gy.some((c) => c.name === 'Dododo Test Warrior'), 'send a "Dododo" monster to the GY: draw 2 cards');
  check(!e.canActivateMain(0, grab(e, 0, 'Dodododraw').uid), 'only 1 activation per turn');
}

card('Double Cyclone');
{
  const e = duel(['Double Cyclone', 'Mirror Force'], D('Mirror Force'));
  const mine = putST(e, 0, 'Mirror Force');
  const theirs = putST(e, 1, 'Mirror Force');
  const dc = putST(e, 0, 'Double Cyclone');
  endTurn(e);
  const f = grab(e, 1, FILL);
  e.apply({ type: 'SUMMON', player: 1, uid: f.uid, zone: 0, pos: 'atk', faceUp: true });
  settle(e, { respond: 'Double Cyclone' });
  check(grave(e, mine) && grave(e, theirs) && grave(e, dc), "Quick-Play (Set, on your opponent's turn): destroys 1 Spell/Trap you control and 1 your opponent controls");
}

card('Double Snare');
{
  const e = duel(['Double Snare'], D('Jinzo'));
  const j = place(e, 1, 'Jinzo')!;
  playSpell(e, 0, 'Double Snare');
  check(grave(e, j), 'destroys a face-up card with an effect that negates Traps');
}

card('Double Spell');
{
  const e = duel(['Double Spell', 'Pot of Greed'], D('Ookazi'));
  toGy(e, 1, 'Ookazi');
  grab(e, 0, 'Pot of Greed');
  playSpell(e, 0, 'Double Spell', { pick: ['Pot of Greed'] });
  check(lp(e, 1) === 4000 - 800 && e.player(0).gy.some((c) => c.name === 'Pot of Greed'), "discard a Spell: use a Spell in your opponent's GY as if you used it");
}

{
  const e = duel(['Double Spell', 'Pot of Greed'], D('Messenger of Peace'));
  const mop = toGy(e, 1, 'Messenger of Peace');
  grab(e, 0, 'Pot of Greed');
  playSpell(e, 0, 'Double Spell', { pick: ['Pot of Greed'] }, { pick: ['Messenger of Peace'] });
  check(zone(e, mop) === 'sz' && e.controller(mop.uid) === 0 && active(e, e.fieldCard(mop.uid)), 'a Continuous Spell is placed face-up on your side of the field and stays there');
}
{
  const e = duel(['Double Spell', 'Pot of Greed'], D('Black Pendant'));
  const bp = toGy(e, 1, 'Black Pendant');
  const m = place(e, 0, FILL)!;
  grab(e, 0, 'Pot of Greed');
  playSpell(e, 0, 'Double Spell', { pick: ['Pot of Greed'] });
  check(zone(e, bp) === 'sz' && e.atkOf(m) === 1400 + 500, 'an Equip Spell is placed on your field and equipped to your monster');
}
{
  const e = duel(['Double Spell', 'Pot of Greed'], D('Dark City'));
  const dc = toGy(e, 1, 'Dark City');
  grab(e, 0, 'Pot of Greed');
  playSpell(e, 0, 'Double Spell', { pick: ['Pot of Greed'] }, { pick: ['Dark City'] });
  check(e.player(0).field?.uid === dc.uid && !!e.player(0).field?.active, 'a Field Spell goes to your Field Zone');
}

card('Double Summon');
{
  const e = duel(['Double Summon']);
  playSpell(e, 0, 'Double Summon');
  const ps = e.player(0);
  for (let i = 0; i < 2; i++) {
    const c = grab(e, 0, FILL);
    e.apply({ type: 'SUMMON', player: 0, uid: c.uid, zone: ps.mz.findIndex((z) => z === null), pos: 'atk', faceUp: true });
    settle(e);
  }
  check(e.monsters(0).length === 2 && !e.canNormalSummon(0, grab(e, 0, FILL)), '2 Normal Summons this turn (not 3)');
}
{
  const e = duel(['Double Summon']);
  summon(e, 0, FILL);
  playSpell(e, 0, 'Double Summon');
  check(e.canNormalSummon(0, grab(e, 0, FILL)), 'activated after the Normal Summon: one more');
}
{
  const e = duel(['Double Summon']);
  playSpell(e, 0, 'Double Summon');
  const ps = e.player(0);
  const c = grab(e, 0, FILL);
  e.apply({ type: 'SUMMON', player: 0, uid: c.uid, zone: ps.mz.findIndex((z) => z === null), pos: 'def', faceUp: false });
  settle(e);
  check(e.monsters(0).length === 1 && e.canNormalSummon(0, grab(e, 0, FILL)), 'activated first, then a Set: one Normal Summon is still left');
}

card('Draconnection');
{
  const e = duel(['Draconnection', 'Luster Dragon', 'Luster Dragon']);
  const a = grab(e, 0, 'Luster Dragon');
  playSpell(e, 0, 'Draconnection');
  const lusters = e.player(0).hand.filter((c) => c.name === 'Luster Dragon');
  check(zone(e, a) === 'deck' && lusters.length === 1 && lusters[0].uid !== a.uid, 'reveal a Dragon: add a Dragon with the same Level from the Deck, shuffle the revealed one into the Deck');
}

card('Dragged Down into the Grave');
{
  const e = duel(['Dragged Down into the Grave'], D());
  const h0 = hand(e, 0);
  const h1 = hand(e, 1);
  playSpell(e, 0, 'Dragged Down into the Grave');
  check(hand(e, 0) === h0 && hand(e, 1) === h1 && e.player(1).gy.length === 1 && e.player(0).gy.length === 2, 'each player discards the card the other chose from their hand, then both draw 1');
}

card('Dragon Revival Rhapsody');
{
  const e = duel(['Dragon Revival Rhapsody', 'Red-Eyes Black Dragon', 'Luster Dragon', 'Dark Magician']);
  place(e, 0, 'Dark Magician');
  const r = toGy(e, 0, 'Red-Eyes Black Dragon');
  const l = toGy(e, 0, 'Luster Dragon');
  playSpell(e, 0, 'Dragon Revival Rhapsody', { pick: ['Red-Eyes Black Dragon', 'Luster Dragon'] });
  check(zone(e, r) === 'mz' && zone(e, l) === 'mz', 'you control a Spellcaster: Special Summon up to 2 Dragons from your GY');
  e.damage(1, 500);
  check(lp(e, 1) === 4000, 'your opponent takes no damage this turn');
}

card('Dragon Shrine');
{
  const e = duel(['Dragon Shrine', 'Red-Eyes Black Dragon', 'Luster Dragon']);
  playSpell(e, 0, 'Dragon Shrine', { pick: ['Red-Eyes Black Dragon'] }, 'yes');
  const gy = e.player(0).gy.map((c) => c.name);
  check(gy.includes('Red-Eyes Black Dragon') && gy.includes('Luster Dragon'), 'send a Dragon from the Deck to the GY; a Dragon Normal Monster lets you send 1 more');
}

card("Dragon's Gunfire");
{
  const e = duel(["Dragon's Gunfire", "Dragon's Gunfire", 'Luster Dragon'], D('Kuriboh'));
  place(e, 0, 'Luster Dragon');
  playSpell(e, 0, "Dragon's Gunfire", { pick: ['Inflict 800 damage'] });
  check(lp(e, 1) === 3200, 'you control a Dragon: inflict 800 damage');
  const k = place(e, 1, 'Kuriboh')!;
  playSpell(e, 0, "Dragon's Gunfire", { pick: ['Destroy a monster with 800 or less DEF'] }, { pick: ['Kuriboh'] });
  check(grave(e, k), 'or destroy a monster with 800 or less DEF');
}

card("Dragon's Rebirth");
{
  const e = duel(["Dragon's Rebirth", 'Luster Dragon', 'Red-Eyes Black Dragon']);
  const l = place(e, 0, 'Luster Dragon')!;
  const r = toGy(e, 0, 'Red-Eyes Black Dragon');
  playTrap(e, 0, "Dragon's Rebirth", { pick: ['Luster Dragon'] }, { pick: ['Red-Eyes Black Dragon'] });
  check(zone(e, l) === 'removed' && zone(e, r) === 'mz', 'banishes the targeted Dragon you control: Special Summon a Dragon from your hand or GY');
}

card('Draining Shield');
{
  const e = duel(['Draining Shield'], D('Gemini Elf'));
  putST(e, 0, 'Draining Shield');
  endTurn(e);
  const elf = place(e, 1, 'Gemini Elf')!;
  toBattle(e);
  attack(e, elf, null, { respond: 'Draining Shield' });
  check(lp(e, 0) === 4000 + 1900, "negates the attack and gains LP equal to the attacker's ATK");
}

card('Dramatic Rescue');
{
  const e = duel(['Dramatic Rescue', 'Amazoness Fighter', 'Gemini Elf'], D('Book of Moon'));
  const am = place(e, 0, 'Amazoness Fighter')!;
  grab(e, 0, 'Gemini Elf');
  putST(e, 0, 'Dramatic Rescue');
  endTurn(e);
  const bom = grab(e, 1, 'Book of Moon');
  act(e, 1, bom.uid, { pick: ['Amazoness Fighter'] }, { respond: 'Dramatic Rescue' }, { pick: ['Gemini Elf'] });
  check(zone(e, am) === 'hand' && e.monsters(0).some((m) => m.name === 'Gemini Elf'), 'a card targets your "Amazoness" monster: return it to the hand and Special Summon another monster from your hand');
}
{
  const e = duel(['Dramatic Rescue', 'Gemini Elf'], D('Amazoness Fighter', 'Book of Moon'));
  const am = place(e, 1, 'Amazoness Fighter')!;
  grab(e, 0, 'Gemini Elf');
  putST(e, 0, 'Dramatic Rescue');
  endTurn(e);
  const bom = grab(e, 1, 'Book of Moon');
  act(e, 1, bom.uid, { pick: ['Amazoness Fighter'] }, { respond: 'Dramatic Rescue' }, { pick: ['Gemini Elf'] });
  check(zone(e, am) === 'hand' && e.player(1).hand.some((c) => c.uid === am.uid) && e.monsters(0).some((m) => m.name === 'Gemini Elf'), "any \"Amazoness\" monster targeted (here your opponent's): it returns to its owner's hand");
}

card('E - Emergency Call');
{
  const e = duel(['E - Emergency Call', 'Elemental HERO Sparkman']);
  playSpell(e, 0, 'E - Emergency Call');
  check(inHand(e, 0, 'Elemental HERO Sparkman'), 'adds an "Elemental HERO" monster from the Deck to your hand');
}

card('EN Shuffle');
{
  const e = duel(['EN Shuffle', 'Elemental HERO Sparkman', 'Elemental HERO Clayman', 'Elemental HERO Neos']);
  const sp = place(e, 0, 'Elemental HERO Sparkman')!;
  playSpell(e, 0, 'EN Shuffle', { pick: ['Elemental HERO Clayman'] });
  check(zone(e, sp) === 'deck' && e.monsters(0).some((m) => m.name === 'Elemental HERO Clayman'), 'shuffle an "Elemental HERO" you control into the Deck: Special Summon one with a different name from the Deck');
  const en = e.player(0).gy.find((c) => c.name === 'EN Shuffle')!;
  const neos = toGy(e, 0, 'Elemental HERO Neos');
  toTurn3(e);
  const h = hand(e, 0);
  graveFx(e, 0, en, { pick: ['1 "Elemental HERO Neos"'] });
  check(zone(e, en) === 'removed' && zone(e, neos) !== 'gy' && hand(e, 0) === h + 1, 'banish it from the GY: shuffle "Elemental HERO Neos" into the Deck, then draw 1');
}

card('Earthquake');
{
  const e = duel(['Earthquake'], D('Gemini Elf'));
  const a = place(e, 0, FILL)!;
  const b = place(e, 1, 'Gemini Elf')!;
  const eq = grab(e, 0, 'Earthquake');
  act(e, 0, eq.uid);
  check(a.pos === 'def' && b.pos === 'def' && grave(e, eq), 'changes all face-up monsters on the field to Defense Position');
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
console.log(`C: ${CARDS.size} cards checked, ${[...FIXED].filter((n) => CARDS.has(n)).length} fixed`);
process.exit(fails ? 1 : 0);
