// Group B Spell/Trap audit: every card checked against its real text (run: npx tsx tests/spells-b.test.ts)
// Each card gets at least one check that plays it through the engine (ACTIVATE, responses, effects) and looks at the outcome.
import { Engine } from '../src/eds/engine';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';
import { existsSync, readFileSync } from 'node:fs';
import { attrOf, levelOf } from '../src/eds/speed/helpers';
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

// ---------- group B helpers ----------
const fake = (info: Partial<CardInfo> & { name: string }) => {
  const full = { id: 990000 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
fake({ name: 'Eldlixir of Test B', kind: 'trap', sub: 'Normal' });
/** Sends a card of `p` (deck or hand) to the GY. */
function toGY(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.sendToGrave(c.uid, 'mill'));
  return c;
}
const inHand = (e: Engine, p: Pid, name: string) => e.player(p).hand.some((c) => c.name === name);
const inGy = (e: Engine, p: Pid, name: string) => e.player(p).gy.some((c) => c.name === name);
const onField = (e: Engine, p: Pid, name: string) => e.monsters(p).find((m) => m.name === name) ?? null;
const graveFx = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'GRAVE_EFFECT', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const canAct = (e: Engine, p: Pid, name: string) => e.canActivateMain(p, grab(e, p, name).uid);
const atk = (e: Engine, m: FieldCard | null) => (m ? e.atkOf(m) : -1);
const oppBattle = (e: Engine) => {
  endTurn(e);
  toBattle(e);
};
/** A duel whose current turn (player `first`) may already conduct a Battle Phase. */
function fight(d0: string[], d1: string[] = [], first: Pid = 0): Engine {
  const e = duel(d0, d1, [], [], first);
  e.state.firstTurn = false;
  return e;
}
const clearHand = (e: Engine, p: Pid) => {
  const ps = e.player(p);
  ps.gy.push(...ps.hand.splice(0));
};
const cards = new Set<string>();
const FIXED = new Set<string>();
const card = (name: string, fixed = false) => {
  cards.add(name);
  if (fixed) FIXED.add(name);
  section(name);
};

// ======================= effects2.ts: Equip Spells =======================
card('7 Completed');
{
  const e = duel(['7 Completed', 'Barrel Dragon']);
  check(!canAct(e, 0, '7 Completed'), 'cannot be activated without a Machine monster');
  const m = place(e, 0, 'Barrel Dragon')!;
  const eq = playSpell(e, 0, '7 Completed', 'no');
  check(active(e, eq) && atk(e, m) === 2600 && e.defOf(m) === 2900, 'choosing DEF: the Machine gains 700 DEF');
  const e2 = duel(['7 Completed', 'Barrel Dragon']);
  const m2 = place(e2, 0, 'Barrel Dragon')!;
  playSpell(e2, 0, '7 Completed', 'yes');
  check(atk(e2, m2) === 3300 && e2.defOf(m2) === 2200, 'choosing ATK: the Machine gains 700 ATK');
}

card('Insect Armor with Laser Cannon');
{
  const e = duel(['Insect Armor with Laser Cannon', 'Basic Insect']);
  place(e, 0, FILL);
  check(!canAct(e, 0, 'Insect Armor with Laser Cannon'), 'only an Insect monster can be equipped');
  const m = place(e, 0, 'Basic Insect')!;
  const eq = playSpell(e, 0, 'Insect Armor with Laser Cannon', { pick: ['Basic Insect'] });
  check(active(e, eq) && atk(e, m) === 1200 && e.defOf(m) === 700, 'the Insect gains 700 ATK');
}

card('Laser Cannon Armor');
{
  const e = duel(['Laser Cannon Armor', 'Basic Insect']);
  const m = place(e, 0, 'Basic Insect')!;
  playSpell(e, 0, 'Laser Cannon Armor', { pick: ['Basic Insect'] });
  check(atk(e, m) === 800 && e.defOf(m) === 1000, 'the Insect gains 300 ATK/DEF');
}

card('Power of Kaishin');
{
  const e = duel(['Power of Kaishin', 'Mermail Abyssgunde']);
  place(e, 0, FILL);
  check(!canAct(e, 0, 'Power of Kaishin'), 'only an Aqua monster can be equipped');
  const m = place(e, 0, 'Mermail Abyssgunde')!;
  playSpell(e, 0, 'Power of Kaishin', { pick: ['Mermail Abyssgunde'] });
  check(atk(e, m) === 1700 && e.defOf(m) === 1100, 'the Aqua gains 300 ATK/DEF');
}

card('Sword of Deep-Seated');
{
  const e = duel(['Sword of Deep-Seated']);
  const m = place(e, 0, FILL)!;
  const sw = playSpell(e, 0, 'Sword of Deep-Seated')!;
  check(atk(e, m) === 1900 && e.defOf(m) === 1700, 'the equipped monster gains 500 ATK/DEF');
  kill(e, [sw], 1);
  check(e.player(0).deck[0]?.uid === sw.uid, 'sent to the GY: placed on top of the Deck');
}

card("Sword of Dragon's Soul");
{
  const e = duel(["Sword of Dragon's Soul"], ['Blue-Eyes White Dragon']);
  const w = place(e, 0, FILL)!;
  playSpell(e, 0, "Sword of Dragon's Soul");
  check(atk(e, w) === 2100, 'the Warrior gains 700 ATK');
  const bewd = place(e, 1, 'Blue-Eyes White Dragon', 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, w, bewd);
  check(zone(e, bewd) === 'mz', 'the Dragon is not destroyed by the battle itself');
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  settle(e);
  check(zone(e, bewd) === 'gy', 'it battled a Dragon: destroyed at the end of the Battle Phase');
}

// ======================= cards-01.ts =======================
card('A Hero Emerges');
{
  const e = duel(['A Hero Emerges'], ['Gemini Elf']);
  putST(e, 0, 'A Hero Emerges');
  const elf = place(e, 1, 'Gemini Elf')!;
  e.rand = () => 0;
  oppBattle(e);
  attack(e, elf, null, { respond: 'A Hero Emerges' });
  check(e.monsters(0).some((m) => m.name === FILL), 'when attacked: a random monster from the hand is Special Summoned');
  const e2 = duel(['A Hero Emerges', 'Pot of Greed'], ['Gemini Elf']);
  putST(e2, 0, 'A Hero Emerges');
  clearHand(e2, 0);
  grab(e2, 0, 'Pot of Greed');
  const elf2 = place(e2, 1, 'Gemini Elf')!;
  oppBattle(e2);
  attack(e2, elf2, null, { respond: 'A Hero Emerges' });
  check(inGy(e2, 0, 'Pot of Greed') && e2.monsters(0).length === 0, 'a chosen non-monster is sent to the GY');
}

card('A Hero Lives');
{
  const e = duel(['A Hero Lives', 'Elemental HERO Clayman', 'Elemental HERO Bladedge']);
  playSpell(e, 0, 'A Hero Lives', { pick: ['Elemental HERO Clayman'] });
  check(lp(e, 0) === 2000 && !!onField(e, 0, 'Elemental HERO Clayman'), 'pay half your LP: Special Summon a Level 4 or lower "Elemental HERO" from the Deck');
  const e2 = duel(['A Hero Lives', 'Elemental HERO Clayman']);
  place(e2, 0, FILL);
  check(!canAct(e2, 0, 'A Hero Lives'), 'not while you control a face-up monster');
}

card('A Legendary Ocean');
{
  const e = duel(['A Legendary Ocean', 'Mermail Abyssgunde', 'Mermail Abyssteus'], ['Mermail Abyssgunde']);
  playSpell(e, 0, 'A Legendary Ocean');
  const m = place(e, 0, 'Mermail Abyssgunde')!;
  const o = place(e, 1, 'Mermail Abyssgunde')!;
  const f = place(e, 0, FILL)!;
  check(atk(e, m) === 1600 && e.defOf(m) === 1000 && atk(e, o) === 1600 && atk(e, f) === 1400, 'all WATER monsters on the field gain 200 ATK/DEF (others do not)');
  check(levelOf(e, m) === 2 && levelOf(e, o) === 2, 'WATER monsters on the field are 1 Level lower');
  const teus = grab(e, 0, 'Mermail Abyssteus');
  check(levelOf(e, teus) === 6, 'WATER monsters in the hand are 1 Level lower');
  check(!!e.anyActive('Umi'), 'its name is treated as "Umi"');
}

card('Abyss Prop - Wild Wagon');
{
  const e = duel(['Abyss Prop - Wild Wagon', 'Abyss Actor - Extras'], ['Gemini Elf']);
  const ex = place(e, 0, 'Abyss Actor - Extras')!;
  const wagon = playSpell(e, 0, 'Abyss Prop - Wild Wagon');
  check(active(e, wagon), 'stays on the field as a Continuous Spell');
  effect(e, 0, wagon, { pick: ['Abyss Actor - Extras'] });
  (e as any).actor = 1;
  check(e.untargetable(ex), 'the targeted "Abyss Actor" cannot be targeted by the opponent');
  (e as any).actor = null;
  const elf = place(e, 1, 'Gemini Elf')!;
  oppBattle(e);
  attack(e, elf, ex);
  check(zone(e, ex) === 'mz', 'the first time it would be destroyed by battle each turn, it is not');
}

card('Abyss Script - Rise of the Abyss King');
{
  const e = duel(['Abyss Script - Rise of the Abyss King', 'Abyss Actor - Extras'], [FILL, 'Gemini Elf']);
  place(e, 0, 'Abyss Actor - Extras');
  const foe = place(e, 1, FILL)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  playSpell(e, 0, 'Abyss Script - Rise of the Abyss King', { pick: [FILL, 'Gemini Elf'] });
  check(zone(e, foe) === 'gy' && zone(e, elf) === 'mz', 'destroys face-up cards, up to the number of "Abyss Actor" monsters (1 here)');
}

card('Abyss-squall');
{
  const e = duel(['Abyss-squall', 'Mermail Abyssgunde', 'Mermail Abyssgunde', 'Mermail Abyssteus']);
  for (const n of ['Mermail Abyssgunde', 'Mermail Abyssgunde', 'Mermail Abyssteus']) toGY(e, 0, n);
  playTrap(e, 0, 'Abyss-squall', { pick: ['Mermail Abyssgunde', 'Mermail Abyssgunde', 'Mermail Abyssteus'] });
  const ms = e.monsters(0);
  check(ms.length === 3 && ms.every((m) => m.pos === 'def' && m.faceUp && e.isNegated(m) && m.cannotAttack), 'Special Summons 3 "Mermail" in Defense Position, negated, unable to attack');
  endTurn(e);
  check(e.monsters(0).length === 0, 'they are destroyed during the End Phase');
}

card('Adhesion Trap Hole');
{
  const e = duel(['Adhesion Trap Hole'], ['Gemini Elf']);
  putST(e, 0, 'Adhesion Trap Hole');
  endTurn(e);
  const elf = summon(e, 1, 'Gemini Elf', true, { respond: 'Adhesion Trap Hole' })!;
  check(atk(e, elf) === 950, "halves the Summoned monster's original ATK");
  endTurn(e);
  check(atk(e, elf) === 950, 'it stays halved');
}

card('Advanced Ritual Art');
{
  const e = duel(['Advanced Ritual Art', 'Hungry Burger', 'Basic Insect']);
  grab(e, 0, 'Hungry Burger');
  grab(e, 0, 'Advanced Ritual Art');
  const deck = e.player(0).deck.length;
  playSpell(e, 0, 'Advanced Ritual Art', { pick: ['Hungry Burger'] }, { pick: [FILL, 'Basic Insect'] });
  check(!!onField(e, 0, 'Hungry Burger') && e.player(0).deck.length === deck - 2 && inGy(e, 0, 'Basic Insect'), 'Ritual Summons with Normal Monsters from the Deck whose Levels add up to its Level');
}

card('Aegis of Gaia');
{
  const e = duel(['Aegis of Gaia']);
  const ag = playTrap(e, 0, 'Aegis of Gaia');
  check(lp(e, 0) === 7000 && active(e, ag), 'gain 3000 LP (it stays on the field)');
  kill(e, [ag], 1);
  check(lp(e, 0) === 4000, 'when it leaves the field: take 3000 damage');
}

card('Allure of Darkness');
{
  const e = duel(['Allure of Darkness', 'Kuriboh', 'Pot of Greed']);
  playSpell(e, 0, 'Allure of Darkness', { pick: ['Kuriboh'] });
  check(e.player(0).removed.some((c) => c.name === 'Kuriboh') && inHand(e, 0, 'Pot of Greed'), 'draw 2, then banish a DARK monster from the hand');
  const e2 = duel(['Allure of Darkness', 'Pot of Greed', 'Book of Moon']);
  clearHand(e2, 0);
  playSpell(e2, 0, 'Allure of Darkness');
  check(e2.player(0).hand.length === 0 && inGy(e2, 0, 'Pot of Greed'), 'no DARK monster: the whole hand goes to the GY');
}

card('Amazoness Archers', true);
{
  const e = duel(['Amazoness Archers', 'Amazoness Fighter'], ['Gemini Elf', 'Mystical Elf']);
  place(e, 0, 'Amazoness Fighter');
  putST(e, 0, 'Amazoness Archers');
  const elf = place(e, 1, 'Gemini Elf')!;
  const myst = place(e, 1, 'Mystical Elf', 'def', false)!;
  oppBattle(e);
  e.apply({ type: 'ATTACK', player: 1, uid: elf.uid, target: e.monsters(0)[0].uid });
  settle(e, { respond: 'Amazoness Archers' });
  check(myst.faceUp && myst.pos === 'atk' && atk(e, myst) === 300, "the opponent's monsters go to face-up Attack Position and lose 500 ATK");
  check(zone(e, elf) === 'gy', 'the weakened attacker (1400) loses to the 1500 ATK Fighter');
  endTurn(e);
  check(atk(e, myst) === 300, 'the ATK loss does not wear off at the end of the turn');
}

card('Amazoness Call');
{
  const e = duel(['Amazoness Call', 'Amazoness Fighter']);
  playSpell(e, 0, 'Amazoness Call', { pick: ['Add to hand'] });
  check(inHand(e, 0, 'Amazoness Fighter'), 'takes an "Amazoness" card from the Deck to the hand');
  check(!canAct(e, 0, 'Amazoness Call'), 'only 1 "Amazoness Call" per turn');
  const e2 = duel(['Amazoness Call', 'Amazoness Paladin']);
  playSpell(e2, 0, 'Amazoness Call', { pick: ['Send to GY'] });
  check(inGy(e2, 0, 'Amazoness Paladin'), '...or sends it to the GY');
}
{
  const e = duel(['Amazoness Call', 'Amazoness Fighter'], [FILL, 'Basic Insect']);
  const f = place(e, 0, 'Amazoness Fighter')!;
  const other0 = place(e, 0, FILL)!;
  const a = place(e, 1, FILL, 'def')!;
  const b = place(e, 1, 'Basic Insect')!;
  const call = toGY(e, 0, 'Amazoness Call');
  toTurn3(e);
  graveFx(e, 0, call, { pick: ['Amazoness Fighter'] });
  check(zone(e, call) === 'removed', 'GY: banished to grant the effect');
  toBattle(e);
  check(!e.canAttackWith(0, other0), 'your other monsters cannot attack');
  attack(e, f, a);
  attack(e, f, b);
  check(zone(e, b) === 'gy', 'it can attack each of the opponent\'s monsters once');
}

card('Amazoness Fighting Spirit', true);
{
  const e = duel(['Amazoness Fighting Spirit', 'Amazoness Fighter'], ['Gemini Elf']);
  const f = place(e, 0, 'Amazoness Fighter')!;
  playSpell(e, 0, 'Amazoness Fighting Spirit');
  const elf = place(e, 1, 'Gemini Elf')!;
  check(atk(e, f) === 1500, 'no bonus outside battle');
  toTurn3(e);
  toBattle(e);
  attack(e, f, elf);
  check(zone(e, elf) === 'gy' && lp(e, 1) === 4000 - 600, 'attacking a monster with higher ATK: it gains 1000 ATK for that battle');
}
{
  // The card says "an Amazoness monster": the opponent's Amazoness gets it too.
  const e = duel(['Amazoness Fighting Spirit'], ['Amazoness Fighter']);
  playSpell(e, 0, 'Amazoness Fighting Spirit');
  const g = place(e, 0, FILL)!;
  g.atkMod = 400; // 1800 ATK
  const f = place(e, 1, 'Amazoness Fighter')!;
  oppBattle(e);
  attack(e, f, g);
  check(zone(e, g) === 'gy' && zone(e, f) === 'mz', "an opponent's Amazoness attacking a stronger monster gains 1000 ATK too");
}

card('Amazoness Onslaught');
{
  const e = duel(['Amazoness Onslaught', 'Amazoness Fighter', 'Amazoness Paladin'], [FILL, 'Basic Insect']);
  const ons = playTrap(e, 0, 'Amazoness Onslaught');
  check(active(e, ons), 'stays on the field as a Continuous Trap');
  grab(e, 0, 'Amazoness Fighter');
  const war = place(e, 0, FILL)!;
  const ins = place(e, 1, 'Basic Insect')!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, war, ins, { respond: 'Amazoness Onslaught' }, 'no');
  const f = onField(e, 0, 'Amazoness Fighter');
  check(!!f && atk(e, f) === 2000, 'during the Battle Phase: Special Summon an "Amazoness" from the hand, +500 ATK');
  attack(e, f!, foe, 'yes');
  check(zone(e, foe) === 'removed', "after damage calculation: banish the opponent's monster it battled");
  endTurn(e);
  check(!!f && atk(e, f) === 1500, 'the 500 ATK lasts until the end of the turn');
  toGY(e, 0, 'Amazoness Paladin');
  kill(e, [ons], 1, 'yes', { pick: ['Amazoness Paladin'] });
  check(!!onField(e, 0, 'Amazoness Paladin'), 'destroyed: Special Summon an "Amazoness" from the GY');
}

card('Amazoness Shamanism');
{
  const e = duel(['Amazoness Shamanism', 'Amazoness Fighter', 'Amazoness Paladin', 'Amazoness Sage']);
  place(e, 0, 'Amazoness Fighter');
  place(e, 0, 'Amazoness Paladin');
  toGY(e, 0, 'Amazoness Sage');
  playTrap(e, 0, 'Amazoness Shamanism', 'yes', { pick: ['Amazoness Sage', 'Amazoness Fighter'] });
  const ms = e.monsters(0);
  check(ms.length === 2 && ms.every((m) => m.pos === 'def') && ms.some((m) => m.name === 'Amazoness Sage'), 'destroys your face-up "Amazoness", then revives up to that many Level 4 or lower in Defense Position');
}

card('Amazoness Spellcaster');
{
  const e = duel(['Amazoness Spellcaster', 'Amazoness Fighter'], ['Gemini Elf']);
  const f = place(e, 0, 'Amazoness Fighter')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  playSpell(e, 0, 'Amazoness Spellcaster', { pick: ['Amazoness Fighter'] }, { pick: ['Gemini Elf'] });
  check(atk(e, f) === 1900 && atk(e, elf) === 1500, 'switches the original ATK of the 2 targets');
  endTurn(e);
  check(atk(e, f) === 1500 && atk(e, elf) === 1900, 'until the end of the turn');
}

card('Amazoness Village');
{
  const e = duel(['Amazoness Village', 'Amazoness Fighter', 'Amazoness Sage', 'Amazoness Queen'], ['Amazoness Paladin']);
  playSpell(e, 0, 'Amazoness Village');
  const f = place(e, 0, 'Amazoness Fighter')!;
  const pal = place(e, 1, 'Amazoness Paladin')!;
  check(atk(e, f) === 1700 && atk(e, pal) === 1700 + 100 + 200, 'all "Amazoness" monsters gain 200 ATK (the opponent\'s too)');
  kill(e, [f], 1, 'yes', { pick: ['Amazoness Sage'] });
  check(!!onField(e, 0, 'Amazoness Sage') && !onField(e, 0, 'Amazoness Queen'), 'an "Amazoness" is destroyed: Special Summon one with an equal or lower Level from the Deck');
  kill(e, [onField(e, 0, 'Amazoness Sage')], 1, 'yes');
  check(e.monsters(0).length === 0, 'only once per turn');
}

card('Amazoness Willpower', true);
{
  const e = duel(['Amazoness Willpower', 'Amazoness Fighter']);
  toGY(e, 0, 'Amazoness Fighter');
  const wp = playTrap(e, 0, 'Amazoness Willpower', { pick: ['Amazoness Fighter'] });
  const f = onField(e, 0, 'Amazoness Fighter');
  check(!!f && f.pos === 'atk' && f.cannotChangePos === true && active(e, wp), 'Special Summons an "Amazoness" from the GY in Attack Position; it cannot change position');
  kill(e, [wp], 1);
  check(zone(e, f) === 'gy', 'when this card leaves the field, that monster is destroyed');
}
{
  const e = duel(['Amazoness Willpower', 'Amazoness Fighter']);
  toGY(e, 0, 'Amazoness Fighter');
  const wp = playTrap(e, 0, 'Amazoness Willpower', { pick: ['Amazoness Fighter'] });
  const f = onField(e, 0, 'Amazoness Fighter')!;
  const since = e.state.log.length;
  kill(e, [f], 1);
  check(zone(e, wp) === 'gy' && logHas(e, 'Amazoness Willpower', since), 'when that monster is destroyed, this card is destroyed');
}
{
  const e = duel(['Amazoness Willpower', 'Amazoness Fighter']);
  toGY(e, 0, 'Amazoness Fighter');
  const wp = playTrap(e, 0, 'Amazoness Willpower', { pick: ['Amazoness Fighter'] });
  const f = onField(e, 0, 'Amazoness Fighter')!;
  e.toHand(f.uid);
  settle(e);
  endTurn(e);
  check(active(e, wp), 'that monster returned to the hand (not destroyed): this card stays');
}

card('Amulet of Ambition');
{
  const e = duel(['Amulet of Ambition'], ['Gaia The Fierce Knight']);
  const fill = place(e, 0, FILL)!;
  const am = playSpell(e, 0, 'Amulet of Ambition', { pick: [FILL] });
  const gaia = place(e, 1, 'Gaia The Fierce Knight')!;
  toTurn3(e);
  toBattle(e);
  attack(e, fill, gaia);
  check(zone(e, gaia) === 'gy' && zone(e, fill) === 'mz', 'battling a higher Level monster: +500 ATK per Level of difference');
  check(atk(e, fill) === 1400, 'only during that battle');
  kill(e, [fill], 1, 'yes');
  check(e.player(0).deck[0]?.uid === am?.uid, 'sent to the GY: it can be placed on top of the Deck');
}

card('Arcana Reading');
{
  const e = duel(['Arcana Reading', 'Twin-Barrel Dragon']);
  e.roll = () => 1;
  playSpell(e, 0, 'Arcana Reading', { pick: ['Twin-Barrel Dragon'] });
  check(inHand(e, 0, 'Twin-Barrel Dragon'), 'Heads: add a coin-tossing card from the Deck');
  const e2 = duel(['Arcana Reading']);
  e2.roll = () => 2;
  const h1 = e2.player(1).hand.length;
  playSpell(e2, 0, 'Arcana Reading');
  check(e2.player(1).hand.length === h1 + 1, 'Tails: the opponent adds a card from their Deck');
}
{
  const e = duel(['Arcana Reading', 'Arcana Force IV - The Emperor']);
  e.roll = () => 1;
  const ar = toGY(e, 0, 'Arcana Reading');
  const em = grab(e, 0, 'Arcana Force IV - The Emperor');
  summon(e, 0, FILL);
  graveFx(e, 0, ar, { pick: ['Arcana Force IV - The Emperor'] });
  check(zone(e, ar) === 'removed' && zone(e, em) === 'mz', 'GY: banish it to Normal Summon an "Arcana Force" monster');
}

card("Archfiend's Oath");
{
  const e = duel(["Archfiend's Oath", 'Pot of Greed']);
  const o = playSpell(e, 0, "Archfiend's Oath");
  effect(e, 0, o, { pick: ['Pot of Greed'] });
  check(lp(e, 0) === 3500 && inHand(e, 0, 'Pot of Greed'), 'pay 500 LP and declare a card: the right top card goes to the hand');
  check(!e.canUseMonsterEffect(0, o!), 'once per turn');
  endTurn(e);
  endTurn(e);
  const top = e.player(0).deck[0];
  effect(e, 0, o, { pick: ['Pot of Greed'] });
  check(top.name !== 'Pot of Greed' && zone(e, top) === 'gy', 'otherwise the excavated card is sent to the GY');
}

card("Archfiend's Roar");
{
  const e = duel(["Archfiend's Roar", 'Archfiend Soldier']);
  toGY(e, 0, 'Archfiend Soldier');
  playTrap(e, 0, "Archfiend's Roar", { pick: ['Archfiend Soldier'] });
  const s = onField(e, 0, 'Archfiend Soldier');
  check(!!s && lp(e, 0) === 3500, 'pay 500 LP: Special Summon an "Archfiend" from the GY');
  check(!!s && e.untributable(s), 'it cannot be Tributed');
  endTurn(e);
  check(!!s && zone(e, s) === 'gy', 'destroyed during the End Phase');
}

card('Assault on GHQ');
{
  const e = duel(['Assault on GHQ']);
  const f = place(e, 0, FILL)!;
  const deck = e.player(1).deck.length;
  playTrap(e, 0, 'Assault on GHQ', { pick: [FILL] });
  check(zone(e, f) === 'gy' && e.player(1).deck.length === deck - 2 && e.player(1).gy.length === 2, "destroy your monster, then send the top 2 cards of the opponent's Deck to the GY");
}

card('Backup Squad', true);
{
  const e = duel(['Backup Squad'], ['Gemini Elf']);
  playSpell(e, 0, 'Backup Squad');
  const elf = place(e, 1, 'Gemini Elf')!;
  oppBattle(e);
  const hand = e.player(0).hand.length;
  attack(e, elf, null, { respond: 'Backup Squad' });
  check(lp(e, 0) === 2100 && e.player(0).hand.length === hand + 1, "1900 damage from the opponent's attack: draw 1");
}
{
  const e = duel(['Backup Squad'], ['Tremendous Fire']);
  playSpell(e, 0, 'Backup Squad');
  endTurn(e);
  const hand = e.player(0).hand.length;
  playSpell(e, 1, 'Tremendous Fire', { respond: 'Backup Squad' });
  check(lp(e, 0) === 3000 && e.player(0).hand.length === hand + 1, "1000 damage from the opponent's card effect: draw 1");
}
{
  const e = duel(['Backup Squad']);
  playSpell(e, 0, 'Backup Squad');
  (e as any).run(e.as(0, (function* () {
    e.damage(0, 1500);
    yield* e.damageWindow(false);
  })()));
  check(lp(e, 0) === 2500 && !hasPrompt(e, 0, 'Backup Squad'), 'damage from your own card effect does not count');
  settle(e);
  (e as any).run(e.as(1, (function* () {
    e.damage(0, 2000);
    yield* e.damageWindow(false);
  })()));
  const hand = e.player(0).hand.length;
  check(hasPrompt(e, 0, 'Backup Squad'), "...the opponent's card effect does, even during your turn");
  settle(e, { respond: 'Backup Squad' });
  check(e.player(0).hand.length === hand + 2, 'draw 1 for every 1000 damage (2000: 2 cards)');
}
{
  const e = fight(['Backup Squad', 'Basic Insect'], ['Barrel Dragon']);
  playSpell(e, 0, 'Backup Squad');
  const ins = place(e, 0, 'Basic Insect')!;
  const bd = place(e, 1, 'Barrel Dragon')!;
  toBattle(e);
  e.apply({ type: 'ATTACK', player: 0, uid: ins.uid, target: bd.uid });
  let offered = false;
  for (let i = 0; i < 50 && e.state.prompt; i++) {
    if (hasPrompt(e, 0, 'Backup Squad')) offered = true;
    settle(e, 'pass');
  }
  check(lp(e, 0) === 1900 && !offered, 'battle damage from your own attack does not count');
}

card('Banishment of the Darklords');
{
  const e = duel(['Banishment of the Darklords', 'Darklord Nasten', 'Banishment of the Darklords', 'Darklord Contact']);
  playSpell(e, 0, 'Banishment of the Darklords', { pick: ['Darklord Nasten'] });
  check(inHand(e, 0, 'Darklord Nasten'), 'adds a "Darklord" card from the Deck');
  check(!canAct(e, 0, 'Banishment of the Darklords'), 'only 1 per turn');
}

card('Bark of Dark Ruler');
{
  const e = duel(['Bark of Dark Ruler', 'Archfiend Soldier'], ['Gemini Elf']);
  const so = place(e, 0, 'Archfiend Soldier')!;
  putST(e, 0, 'Bark of Dark Ruler');
  const elf = place(e, 1, 'Gemini Elf')!;
  toTurn3(e);
  toBattle(e);
  attack(e, so, elf, { respond: 'Bark of Dark Ruler' }, { pick: ['500 LP'] });
  check(lp(e, 0) === 3500 && zone(e, elf) === 'gy' && zone(e, so) === 'mz', "pay LP: the opponent's battling monster loses that much ATK and DEF");
}

card('Battleguard Rage', true);
{
  const e = duel(['Battleguard Rage'], ['Gemini Elf']);
  const f = place(e, 0, FILL)!;
  const br = playTrap(e, 0, 'Battleguard Rage', { pick: [FILL] });
  check(atk(e, f) === 2400 && active(e, br), 'the Warrior gains 1000 ATK');
  const elf = place(e, 1, 'Gemini Elf')!;
  toTurn3(e);
  toBattle(e);
  attack(e, f, elf);
  check(zone(e, elf) === 'hand', 'a monster it destroys by battle goes back to the hand');
  const since = e.state.log.length;
  e.toHand(f.uid);
  settle(e);
  (e as any).run((function* () {})());
  settle(e);
  check(zone(e, br) === 'gy' && logHas(e, 'Battleguard Rage', since), 'when the monster leaves the field, this card is destroyed');
}

// ======================= cards-02.ts =======================
card('Big Wave Small Wave');
{
  const e = duel(['Amazon of the Seas', 'Amazon of the Seas', '7 Colored Fish', '7 Colored Fish', 'Big Wave Small Wave']);
  const a = place(e, 0, 'Amazon of the Seas');
  const b = place(e, 0, 'Amazon of the Seas');
  grab(e, 0, '7 Colored Fish');
  e.toHandOf(e.player(0).deck.find((c) => c.name === '7 Colored Fish')!.uid, 0);
  playSpell(e, 0, 'Big Wave Small Wave', 'yes', { pick: ['7 Colored Fish', '7 Colored Fish'] });
  check(zone(e, a) === 'gy' && zone(e, b) === 'gy' && e.monsters(0).filter((m) => m.name === '7 Colored Fish').length === 2, 'destroys your face-up WATER monsters, then Special Summons that many WATER monsters from the hand');
}

card('Birthright', true);
{
  const e = duel(['Birthright', 'Amazon of the Seas']);
  toGY(e, 0, 'Amazon of the Seas');
  const br = playTrap(e, 0, 'Birthright', { pick: ['Amazon of the Seas'] });
  const m = onField(e, 0, 'Amazon of the Seas');
  check(!!m && m.pos === 'atk' && m.faceUp && active(e, br), 'Special Summons a Normal Monster from the GY in face-up Attack Position');
  kill(e, [br], 1);
  check(zone(e, m) === 'gy', 'when it leaves the field, the monster is destroyed');
}
{
  const e = duel(['Birthright', 'Amazon of the Seas']);
  toGY(e, 0, 'Amazon of the Seas');
  const br = playTrap(e, 0, 'Birthright', { pick: ['Amazon of the Seas'] });
  const m = onField(e, 0, 'Amazon of the Seas')!;
  const since = e.state.log.length;
  kill(e, [m], 1);
  check(zone(e, br) === 'gy' && logHas(e, 'Birthright: its monster left the field', since), 'when that monster leaves the field, this card is destroyed');
}

card('Black Sonic', true);
{
  const e = fight(['Black Sonic', 'Blackwing - Calima the Haze'], ['Vorse Raider', 'Axe Raider'], 1);
  const bw = place(e, 0, 'Blackwing - Calima the Haze')!;
  const v = place(e, 1, 'Vorse Raider')!;
  const a = place(e, 1, 'Axe Raider', 'def')!;
  putST(e, 0, 'Black Sonic');
  toBattle(e);
  attack(e, v, bw, { respond: 'Black Sonic' });
  check(zone(e, v) === 'removed' && zone(e, a) === 'mz', "an attack on a \"Blackwing\": banishes the opponent's face-up Attack Position monsters");
}
{
  const bw3 = ['Blackwing - Calima the Haze', 'Blackwing - Calima the Haze', 'Blackwing - Calima the Haze'];
  const e = fight(['Black Sonic', ...bw3], ['Vorse Raider'], 1);
  for (let i = 0; i < 3; i++) place(e, 0, 'Blackwing - Calima the Haze');
  const v = place(e, 1, 'Vorse Raider')!;
  const bs = grab(e, 0, 'Black Sonic');
  toBattle(e);
  attack(e, v, e.monsters(0)[0], { respond: 'Black Sonic' });
  check(zone(e, v) === 'removed' && zone(e, bs) === 'gy', 'with exactly 3 "Blackwing" monsters it can be activated from the hand');
  const e2 = fight(['Black Sonic', 'Blackwing - Calima the Haze', 'Blackwing - Calima the Haze'], ['Vorse Raider'], 1);
  place(e2, 0, 'Blackwing - Calima the Haze');
  place(e2, 0, 'Blackwing - Calima the Haze');
  const v2 = place(e2, 1, 'Vorse Raider')!;
  grab(e2, 0, 'Black Sonic');
  toBattle(e2);
  e2.apply({ type: 'ATTACK', player: 1, uid: v2.uid, target: e2.monsters(0)[0].uid });
  check(!hasPrompt(e2, 0, 'Black Sonic'), 'not from the hand with only 2 "Blackwing" monsters');
  settle(e2);
}

card('Blaze Accelerator');
{
  const e = duel(['Blaze Accelerator', 'Flame Viper'], ['Vorse Raider']);
  const v = place(e, 1, 'Vorse Raider');
  grab(e, 0, 'Flame Viper');
  const ba = playSpell(e, 0, 'Blaze Accelerator');
  check(active(e, ba), 'stays on the field as a Continuous Spell');
  effect(e, 0, ba);
  check(zone(e, v) === 'gy' && inGy(e, 0, 'Flame Viper'), 'sends a Pyro with 500 or less ATK from the hand to destroy the target');
  const m = place(e, 0, FILL);
  e.state.firstTurn = false;
  toBattle(e);
  check(!e.canAttackWith(0, m!), 'no attacks the turn its effect is used');
}

card('Bonding - D2O');
{
  const e = duel(['Bonding - D2O', 'Duoterion', 'Duoterion', 'Oxygeddon', 'Water Dragon']);
  grab(e, 0, 'Duoterion');
  e.toHandOf(e.player(0).deck.find((c) => c.name === 'Duoterion')!.uid, 0);
  grab(e, 0, 'Oxygeddon');
  playSpell(e, 0, 'Bonding - D2O');
  const wd = onField(e, 0, 'Water Dragon');
  check(!!wd && inGy(e, 0, 'Duoterion') && inGy(e, 0, 'Oxygeddon') && inGy(e, 0, 'Bonding - D2O'), 'Tributes 2 Duoterion + 1 Oxygeddon from the hand to Special Summon "Water Dragon" from the Deck');
  kill(e, [wd], 1);
  check(inHand(e, 0, 'Bonding - D2O'), '"Water Dragon" sent from the field to the GY: this card returns to the hand');
}

card('Bonding - DHO');
{
  const e = duel(['Bonding - DHO', 'Duoterion', 'Hydrogeddon', 'Oxygeddon', 'Water Dragon Cluster', 'Water Dragon']);
  grab(e, 0, 'Duoterion');
  toGY(e, 0, 'Hydrogeddon');
  grab(e, 0, 'Oxygeddon');
  grab(e, 0, 'Water Dragon Cluster');
  playTrap(e, 0, 'Bonding - DHO');
  check(!!onField(e, 0, 'Water Dragon Cluster') && !inGy(e, 0, 'Hydrogeddon') && !inHand(e, 0, 'Duoterion'), 'shuffles the 3 materials into the Deck to Special Summon "Water Dragon Cluster"');
  const c = e.player(0).gy.find((x) => x.name === 'Bonding - DHO')!;
  graveFx(e, 0, c, { pick: ['Water Dragon'] });
  check(zone(e, c) === 'removed' && inHand(e, 0, 'Water Dragon'), 'banished from the GY to add "Water Dragon"');
}

card('Bonding - H2O');
{
  const e = duel(['Bonding - H2O', 'Hydrogeddon', 'Hydrogeddon', 'Oxygeddon', 'Water Dragon']);
  place(e, 0, 'Hydrogeddon');
  place(e, 0, 'Hydrogeddon');
  place(e, 0, 'Oxygeddon');
  playSpell(e, 0, 'Bonding - H2O');
  check(!!onField(e, 0, 'Water Dragon') && e.monsters(0).length === 1, 'Tributes 2 Hydrogeddon + 1 Oxygeddon to Special Summon "Water Dragon"');
  const e2 = duel(['Bonding - H2O', 'Hydrogeddon', 'Hydrogeddon', 'Oxygeddon', 'Water Dragon']);
  grab(e2, 0, 'Hydrogeddon');
  place(e2, 0, 'Hydrogeddon');
  place(e2, 0, 'Oxygeddon');
  check(!canAct(e2, 0, 'Bonding - H2O'), 'the materials must be on the field (not in the hand)');
}

card('Book of Life');
{
  const e = duel(['Book of Life', 'Dragon Zombie'], ['Vorse Raider']);
  toGY(e, 0, 'Dragon Zombie');
  const v = toGY(e, 1, 'Vorse Raider');
  playSpell(e, 0, 'Book of Life');
  check(!!onField(e, 0, 'Dragon Zombie') && zone(e, v) === 'removed', "revives a Zombie and banishes a monster from the opponent's GY");
}

card('Book of Taiyou');
{
  const e = duel(['Book of Taiyou'], ['Man-Eater Bug']);
  const own = place(e, 0, FILL)!;
  const fd = place(e, 1, 'Man-Eater Bug', 'def', false)!;
  playSpell(e, 0, 'Book of Taiyou');
  check(fd.faceUp && fd.pos === 'atk' && zone(e, own) === 'gy', 'flips a face-down monster into face-up Attack Position (its FLIP effect activates)');
}

card('Branded Sword');
{
  const e = duel(['Branded Sword', 'Branded Fusion']);
  toGY(e, 0, 'Branded Fusion');
  playTrap(e, 0, 'Branded Sword');
  const t = onField(e, 0, 'Iceblade Token');
  check(!!t && atk(e, t) === 2500 && levelOf(e, t) === 8 && e.player(0).removed.some((c) => c.name === 'Branded Fusion'), 'banishes a "Branded" Spell/Trap from the GY to Special Summon an Iceblade Token');
  const e2 = duel(['Branded Sword', 'Fallen of Albaz']);
  e2.banish(e2.player(0).deck.find((c) => c.name === 'Fallen of Albaz')!.uid);
  const bs = toGY(e2, 0, 'Branded Sword');
  graveFx(e2, 0, bs);
  check(zone(e2, bs) === 'removed' && inHand(e2, 0, 'Fallen of Albaz'), 'banished from the GY to add a banished "Fallen of Albaz"');
}

card('Break! Draw!');
{
  const e = fight(['Cyber Falcon', 'Break! Draw!'], ['Mammoth Graveyard']);
  const f = place(e, 0, 'Cyber Falcon')!;
  const bd = playSpell(e, 0, 'Break! Draw!');
  const m = place(e, 1, 'Mammoth Graveyard')!;
  const hand = e.player(0).hand.length;
  toBattle(e);
  attack(e, f, m);
  check(active(e, bd) && zone(e, m) === 'gy' && e.player(0).hand.length === hand + 1, 'the equipped Machine destroys a monster by battle: draw 1');
  const e3 = duel(['Cyber Falcon', 'Break! Draw!']);
  place(e3, 0, 'Cyber Falcon');
  const bd3 = playSpell(e3, 0, 'Break! Draw!');
  for (let i = 0; i < 4; i++) endTurn(e3);
  const still = active(e3, bd3);
  endTurn(e3);
  check(still && zone(e3, bd3) === 'gy', 'destroyed during your 3rd End Phase after activation');
}

card('Burst Stream of Destruction', true);
{
  const e = duel(['Blue-Eyes White Dragon', 'Burst Stream of Destruction', 'Blue-Eyes White Dragon'], ['Vorse Raider', 'Axe Raider']);
  check(!canAct(e, 0, 'Burst Stream of Destruction'), 'needs "Blue-Eyes White Dragon"');
  const b = place(e, 0, 'Blue-Eyes White Dragon');
  place(e, 1, 'Vorse Raider');
  place(e, 1, 'Axe Raider');
  playSpell(e, 0, 'Burst Stream of Destruction');
  e.state.firstTurn = false;
  toBattle(e);
  check(e.monsters(1).length === 0 && !e.canAttackWith(0, b!), "destroys all the opponent's monsters; Blue-Eyes cannot attack this turn");
  const b2 = place(e, 0, 'Blue-Eyes White Dragon')!;
  check(!e.canAttackWith(0, b2), 'a "Blue-Eyes White Dragon" that arrives later that turn cannot attack either');
}

card('Call of the Mummy');
{
  const e = duel(['Call of the Mummy', 'Dragon Zombie']);
  grab(e, 0, 'Dragon Zombie');
  const com = playSpell(e, 0, 'Call of the Mummy');
  effect(e, 0, com);
  check(!!onField(e, 0, 'Dragon Zombie'), 'Special Summons a Zombie from the hand while you control no monsters');
  check(!e.canUseMonsterEffect(0, com!), 'not again (once per turn, and you control a monster)');
}

card('Cestus of Dagla');
{
  const e = fight(['Dunames Dark Witch', 'Cestus of Dagla']);
  const d = place(e, 0, 'Dunames Dark Witch');
  playSpell(e, 0, 'Cestus of Dagla');
  toBattle(e);
  attack(e, d, null);
  check(lp(e, 1) === 4000 - 2300 && lp(e, 0) === 4000 + 2300, 'the Fairy gains 500 ATK; battle damage it inflicts is gained as LP');
}

card("Champion's Vigilance");
{
  const e = duel(["Champion's Vigilance", 'Dark Magician'], ['Dian Keto the Cure Master'], [], [], 1);
  place(e, 0, 'Dark Magician');
  putST(e, 0, "Champion's Vigilance");
  playSpell(e, 1, 'Dian Keto the Cure Master', { respond: "Champion's Vigilance" });
  check(lp(e, 1) === 4000 && inGy(e, 1, 'Dian Keto the Cure Master') && inGy(e, 0, "Champion's Vigilance"), 'with a Level 7+ Normal Monster: negates a Spell activation and destroys it');
  const e2 = duel(["Champion's Vigilance", 'Dark Magician'], ['Vorse Raider'], [], [], 1);
  place(e2, 0, 'Dark Magician');
  putST(e2, 0, "Champion's Vigilance");
  const v = summon(e2, 1, 'Vorse Raider', true, { respond: "Champion's Vigilance" });
  check(!v && inGy(e2, 1, 'Vorse Raider'), '...or a Summon, destroying the monster');
}

card('Chaos Trap Hole');
{
  const e = duel(['Chaos Trap Hole'], ['Vorse Raider'], [], [], 1);
  putST(e, 0, 'Chaos Trap Hole');
  const v = summon(e, 1, 'Vorse Raider', true, { respond: 'Chaos Trap Hole' });
  check(!v && lp(e, 0) === 2000 && e.player(1).removed.some((c) => c.name === 'Vorse Raider'), 'pays 2000 LP to negate the Summon of a DARK monster and banish it');
}

card('Cloudian Aerosol');
{
  const e = duel(['Cloudian Aerosol', 'Cloudian - Altus'], ['Vorse Raider']);
  grab(e, 0, 'Cloudian - Altus');
  const v = place(e, 1, 'Vorse Raider');
  playSpell(e, 0, 'Cloudian Aerosol', { pick: ['Cloudian - Altus'] }, { pick: ['Vorse Raider'] });
  check(inGy(e, 0, 'Cloudian - Altus') && v!.tags?.fog === 4, "discards a \"Cloudian\" to place Fog Counters equal to the target's Level");
  const e2 = duel(['Cloudian Aerosol', 'Cloudian - Altus', 'Cloudian - Cirrostratus']);
  const ca = toGY(e2, 0, 'Cloudian Aerosol');
  toGY(e2, 0, 'Cloudian - Altus');
  graveFx(e2, 0, ca);
  check(zone(e2, ca) === 'removed' && !!onField(e2, 0, 'Cloudian - Cirrostratus'), 'banished with a "Cloudian" from the GY to Special Summon a "Cloudian" from the Deck');
}

card('Cloudian Squall');
{
  const e = duel(['Cloudian Squall'], ['Vorse Raider']);
  playSpell(e, 0, 'Cloudian Squall');
  const v = place(e, 1, 'Vorse Raider');
  endTurn(e);
  const theirs = v!.tags?.fog ?? 0;
  endTurn(e);
  check(theirs === 0 && v!.tags?.fog === 1, 'during your Standby Phase: a Fog Counter on every face-up monster');
}

card('Common Charity');
{
  const e = duel(['Common Charity', 'Amazon of the Seas', 'Petit Moth']);
  const cc = putST(e, 0, 'Common Charity');
  const hand = e.player(0).hand.length;
  act(e, 0, cc.uid, { pick: ['Amazon of the Seas'] });
  check(e.player(0).hand.length === hand + 1 && e.player(0).removed.some((c) => c.name === 'Amazon of the Seas'), 'draws 2, then banishes a Normal Monster from the hand');
  const e2 = duel(['Common Charity', 'Black Ptera', 'Bitelon']);
  clearHand(e2, 0);
  playTrap(e2, 0, 'Common Charity');
  check(e2.player(0).hand.length === 0 && inGy(e2, 0, 'Black Ptera') && inGy(e2, 0, 'Bitelon'), 'no Normal Monster: the whole hand goes to the GY');
}

card('Conquistador of the Golden Land');
{
  const e = duel(['Conquistador of the Golden Land', 'Eldlich the Golden Lord'], ['Trap Hole']);
  place(e, 0, 'Eldlich the Golden Lord');
  const th = putST(e, 1, 'Trap Hole');
  th.faceUp = true;
  const c = playTrap(e, 0, 'Conquistador of the Golden Land', { pick: ['Attack Position'] }, { pick: ['Trap Hole'] });
  check(!!c && zone(e, c) === 'mz' && levelOf(e, c) === 5 && e.raceOf(c) === 'Zombie' && attrOf(e, c) === 'LIGHT' && atk(e, c) === 500, 'Special Summoned as a Zombie/LIGHT/Level 5 500/1800 monster');
  check(zone(e, th) === 'gy', 'with "Eldlich the Golden Lord": destroys a face-up card');
  const e2 = duel(['Conquistador of the Golden Land', 'Eldlixir of Test B']);
  const c2 = toGY(e2, 0, 'Conquistador of the Golden Land');
  endTurn(e2, 'yes');
  const set = e2.player(0).sz.find((x) => x?.name === 'Eldlixir of Test B');
  check(zone(e2, c2) === 'removed' && !!set && !set.faceUp, 'End Phase: banished from the GY to Set an "Eldlixir" from the Deck');
}

card('Conscription');
{
  const e = duel(['Conscription'], ['Vorse Raider']);
  playTrap(e, 0, 'Conscription');
  check(!!onField(e, 0, 'Vorse Raider'), "the opponent's top card is a Normal Summonable monster: Special Summoned to your field");
  const e2 = duel(['Conscription'], ['Dian Keto the Cure Master']);
  playTrap(e2, 0, 'Conscription');
  check(inHand(e2, 1, 'Dian Keto the Cure Master'), "otherwise it goes to the opponent's hand");
}

card('Contact Gate');
{
  const e = duel(['Contact Gate', 'Neo-Spacian Aqua Dolphin', 'Neo-Spacian Dark Panther', 'Neo-Spacian Air Hummingbird', 'Neo-Spacian Glow Moss'], [], ['Gaia the Dragon Champion', 'Hi-Speedroid Puzzle']);
  toGY(e, 0, 'Neo-Spacian Aqua Dolphin');
  toGY(e, 0, 'Neo-Spacian Dark Panther');
  playSpell(e, 0, 'Contact Gate');
  const ns = e.monsters(0).filter((m) => m.name.startsWith('Neo-Spacian'));
  check(e.player(0).removed.length === 2 && ns.length === 2 && ns[0].name !== ns[1].name, 'banishes 2 "Neo-Spacian" from the GY to Special Summon 2 with different names');
  const syn = e.player(0).fusion.find((c) => c.name === 'Hi-Speedroid Puzzle')!;
  const fus = e.player(0).fusion.find((c) => c.name === 'Gaia the Dragon Champion')!;
  check(e.summonBlocked(0, syn, 'special', 'fusion') && !e.summonBlocked(0, fus, 'special', 'fusion'), 'no Special Summons from the Extra Deck this turn, except Fusion Monsters');
}

// ======================= effects2.ts: Spells and Traps =======================
card('Acid Trap Hole');
{
  const e = duel(['Acid Trap Hole'], ['Petit Moth']);
  const m = place(e, 1, FILL, 'def', false)!;
  playTrap(e, 0, 'Acid Trap Hole');
  check(zone(e, m) === 'gy', 'flips the face-down target; DEF 2000 or less: destroyed');
  const e2 = duel(['Acid Trap Hole'], ['Barrel Dragon']);
  const m2 = place(e2, 1, 'Barrel Dragon', 'def', false)!;
  playTrap(e2, 0, 'Acid Trap Hole');
  check(zone(e2, m2) === 'mz' && !m2.faceUp, 'DEF more than 2000: returned face-down');
}

card('Aqua Chorus', true);
{
  const e = duel(['Aqua Chorus', 'Petit Moth']);
  const a = place(e, 0, FILL)!;
  const b = place(e, 0, FILL)!;
  const c = place(e, 0, 'Petit Moth')!;
  const ac = playTrap(e, 0, 'Aqua Chorus');
  check(active(e, ac) && atk(e, a) === 1900 && e.defOf(b) === 1700 && atk(e, c) === 300, 'monsters sharing a name gain 500 ATK/DEF (others do not)');
  const d = place(e, 1, FILL, 'def', false)!;
  check(e.defOf(d) === 1200, 'a face-down monster with that name gains nothing');
}

card('DNA Surgery');
{
  const e = duel(['DNA Surgery'], ['Gemini Elf']);
  const m = place(e, 0, FILL)!;
  const o = place(e, 1, 'Gemini Elf')!;
  const dna = playTrap(e, 0, 'DNA Surgery', { pick: ['Dragon'] });
  check(e.raceOf(m) === 'Dragon' && e.raceOf(o) === 'Dragon', 'all face-up monsters on the field become the declared Type');
  kill(e, [dna], 1);
  check(e.raceOf(m) === 'Warrior', 'only while it stays on the field');
}

card('Exchange');
{
  const e = duel(['Exchange', 'Pot of Greed'], ['Waboku']);
  clearHand(e, 0);
  clearHand(e, 1);
  grab(e, 0, 'Pot of Greed');
  grab(e, 1, 'Waboku');
  playSpell(e, 0, 'Exchange');
  check(inHand(e, 0, 'Waboku') && inHand(e, 1, 'Pot of Greed'), 'each player adds 1 card from the other hand');
}

card('Last Day of Witch');
{
  const e = duel(['Last Day of Witch', 'Dark Magician'], ['Gemini Elf', 'Mystical Elf']);
  const dm = place(e, 0, 'Dark Magician')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  const fd = place(e, 1, 'Mystical Elf', 'def', false)!;
  const f = place(e, 0, FILL)!;
  playSpell(e, 0, 'Last Day of Witch');
  check(zone(e, dm) === 'gy' && zone(e, elf) === 'gy' && zone(e, fd) === 'mz' && zone(e, f) === 'mz', 'destroys all face-up Spellcasters (both sides); face-down and other monsters stay');
}

card('Lightforce Sword');
{
  const e = duel(['Lightforce Sword']);
  const n = e.player(1).hand.length;
  playTrap(e, 0, 'Lightforce Sword');
  const c = e.player(1).removed[0];
  check(!!c && e.player(1).hand.length === n - 1, "banishes 1 random card from the opponent's hand");
  for (let i = 0; i < 5; i++) endTurn(e);
  check(zone(e, c) === 'removed', '(still banished at their 3rd Standby Phase)');
  endTurn(e);
  endTurn(e);
  check(zone(e, c) === 'hand', "returned during the opponent's 4th Standby Phase after activation");
}

card('Magical Arm Shield', true);
{
  const e = duel(['Magical Arm Shield'], ['Barrel Dragon', 'Vorse Raider']);
  place(e, 0, FILL);
  putST(e, 0, 'Magical Arm Shield');
  endTurn(e);
  const a = place(e, 1, FILL)!;
  const v = place(e, 1, 'Vorse Raider')!;
  const b = place(e, 1, 'Barrel Dragon')!;
  toBattle(e);
  e.apply({ type: 'ATTACK', player: 1, uid: a.uid, target: e.monsters(0)[0].uid });
  settle(e, { respond: 'Magical Arm Shield' }, { pick: ['Barrel Dragon'] });
  check(zone(e, a) === 'gy' && zone(e, v) === 'mz' && lp(e, 1) === 4000 - 1200, "takes control of the targeted opponent's monster (not the attacker) and it is attacked instead");
  check(e.controller(b.uid) === 0, 'controlled until the end of the Battle Phase');
  e.apply({ type: 'NEXT_PHASE', player: 1 });
  settle(e);
  check(e.controller(b.uid) === 1, 'control returns at the end of the Battle Phase');
}
{
  // The target is chosen on activation: it is asked before the opponent may respond.
  const e = duel(['Magical Arm Shield'], ['Barrel Dragon']);
  place(e, 0, FILL);
  putST(e, 0, 'Magical Arm Shield');
  endTurn(e);
  const a = place(e, 1, FILL)!;
  place(e, 1, 'Barrel Dragon');
  toBattle(e);
  e.apply({ type: 'ATTACK', player: 1, uid: a.uid, target: e.monsters(0)[0].uid });
  const k = e.state.prompt?.kind === 'response' ? e.state.prompt.options.findIndex((o) => o.label.startsWith('Magical Arm Shield')) : -1;
  e.apply({ type: 'CHOOSE', player: 0, picks: [k] });
  const asked = e.state.prompt?.kind === 'select' && e.state.prompt.player === 0 && /Magical Arm Shield/.test(e.state.prompt.title);
  check(asked && e.state.chain.length === 0, 'the monster is targeted when the card is activated');
  settle(e);
}

card('Magical Hats', true);
{
  const e = duel(['Magical Hats', 'Barrel Dragon', 'Pot of Greed', 'Waboku']);
  const m = place(e, 0, 'Barrel Dragon')!;
  putST(e, 0, 'Magical Hats');
  endTurn(e);
  const a = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, a, m, { respond: 'Magical Hats' });
  check(logHas(e, 'Magical Hats shuffles') && !m.faceUp && m.pos === 'def' && zone(e, m) === 'mz', 'your monster is Set and hidden among the hats');
  e.apply({ type: 'NEXT_PHASE', player: 1 });
  settle(e);
  check(e.monsters(0).length === 1 && inGy(e, 0, 'Pot of Greed') && inGy(e, 0, 'Waboku'), 'the 2 Spell/Trap hats are destroyed at the end of the Battle Phase');
}
{
  const e = duel(['Magical Hats', 'Barrel Dragon', 'Pot of Greed']);
  const m = place(e, 0, 'Barrel Dragon')!;
  putST(e, 0, 'Magical Hats');
  for (const c of e.player(0).deck.filter((x) => e.info(x.name).kind !== 'monster' && x.name !== 'Pot of Greed')) e.toHandOf(c.uid, 0);
  endTurn(e);
  const a = place(e, 1, FILL)!;
  toBattle(e);
  e.apply({ type: 'ATTACK', player: 1, uid: a.uid, target: m.uid });
  check(!hasPrompt(e, 0, 'Magical Hats'), 'it cannot be activated with fewer than 2 Spells/Traps in the Deck');
  settle(e);
}

card('Mirror Wall', true);
{
  const e = duel(['Mirror Wall']);
  putST(e, 0, 'Mirror Wall');
  endTurn(e);
  const a = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, a, null, { respond: 'Mirror Wall' });
  check(atk(e, a) === 700 && lp(e, 0) === 3300, "the attacking monster's ATK is halved");
  const mw = e.player(0).sz.find((c) => c?.name === 'Mirror Wall')!;
  endTurn(e, 'no');
  check(zone(e, mw) === 'gy' && atk(e, a) === 1400, 'your Standby Phase: not paying 2000 LP destroys it (the ATK comes back)');
}
{
  const e = duel(['Mirror Wall'], [FILL]);
  const mw = playTrap(e, 0, 'Mirror Wall');
  check(active(e, mw), 'it can be activated without an attack (the card has no activation condition)');
  endTurn(e);
  const a = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, a, null);
  check(atk(e, a) === 700 && lp(e, 0) === 3300, 'a monster that attacks while it is face-up has its ATK halved');
  endTurn(e, 'yes');
  check(active(e, mw) && lp(e, 0) === 1300, 'your Standby Phase: pay 2000 LP to keep it');
}

card('Nobleman of Crossout');
{
  const e = duel(['Nobleman of Crossout'], ['Man-Eater Bug', 'Man-Eater Bug']);
  const m = place(e, 1, 'Man-Eater Bug', 'def', false)!;
  playSpell(e, 0, 'Nobleman of Crossout');
  check(zone(e, m) === 'removed', 'destroys and banishes the face-down target');
  check(!e.player(1).deck.some((c) => c.name === 'Man-Eater Bug'), 'a Flip monster: the copies in the Deck are banished too');
  const e2 = duel(['Nobleman of Crossout']);
  place(e2, 1, FILL);
  check(!canAct(e2, 0, 'Nobleman of Crossout'), 'needs a face-down monster');
}

card('Nobleman of Extermination');
{
  const e = duel(['Nobleman of Extermination'], ['Waboku', 'Waboku']);
  const t = putST(e, 1, 'Waboku');
  playSpell(e, 0, 'Nobleman of Extermination');
  check(zone(e, t) === 'removed' && !e.player(1).deck.some((c) => c.name === 'Waboku'), 'destroys and banishes a Set Trap, and the copies in the Decks');
  const e2 = duel(['Nobleman of Extermination'], ['Pot of Greed', 'Pot of Greed']);
  const s2 = putST(e2, 1, 'Pot of Greed');
  playSpell(e2, 0, 'Nobleman of Extermination');
  check(zone(e2, s2) === 'removed' && e2.player(1).deck.some((c) => c.name === 'Pot of Greed'), 'a Spell: only that card is banished');
}

card("Sebek's Blessing", true);
{
  const e = duel(["Sebek's Blessing"]);
  toTurn3(e);
  const m = place(e, 0, FILL)!;
  putST(e, 0, "Sebek's Blessing");
  toBattle(e);
  attack(e, m, null, { respond: "Sebek's Blessing" });
  check(lp(e, 1) === 2600 && lp(e, 0) === 5400, 'direct attack damage: gain that much LP');
}
{
  const e = duel(["Sebek's Blessing"]);
  toTurn3(e);
  const m = place(e, 0, FILL)!;
  const sb = grab(e, 0, "Sebek's Blessing");
  toBattle(e);
  attack(e, m, null, { respond: "Sebek's Blessing" });
  check(lp(e, 1) === 2600 && lp(e, 0) === 5400 && zone(e, sb) === 'gy', 'a Quick-Play Spell: it can be activated from the hand during your turn');
}

card('Shield & Sword');
{
  const e = duel(['Shield & Sword', 'Barrel Dragon'], ['Gemini Elf']);
  const m = place(e, 0, FILL)!;
  const o = place(e, 1, 'Gemini Elf')!;
  playSpell(e, 0, 'Shield & Sword');
  const later = place(e, 0, 'Barrel Dragon')!;
  check(atk(e, m) === 1200 && e.defOf(m) === 1400 && atk(e, o) === 900, 'switches the original ATK and DEF of all face-up monsters');
  check(atk(e, later) === 2600, 'a monster Summoned afterwards keeps its stats');
  endTurn(e);
  check(atk(e, m) === 1400, 'until the end of the turn');
}

card('Soul Release', true);
{
  const e = duel(['Soul Release'], [FILL]);
  const m = place(e, 1, FILL)!;
  kill(e, [m]);
  const mine = toGY(e, 0, FILL);
  playSpell(e, 0, 'Soul Release', { pick: [FILL, FILL] });
  check(zone(e, m) === 'removed' && zone(e, mine) === 'removed', 'banishes the targeted cards in any GY');
}
{
  const e = duel(['Soul Release'], [FILL]);
  const m = place(e, 1, FILL)!;
  kill(e, [m]);
  const c = grab(e, 0, 'Soul Release');
  e.apply({ type: 'ACTIVATE', player: 0, uid: c.uid, zone: 0 });
  const asked = e.state.prompt?.kind === 'select' && /Soul Release/.test(e.state.prompt.title);
  settle(e);
  check(asked && zone(e, m) === 'removed', 'the cards are targeted when it is activated');
}

card('The Eye of Truth');
{
  const e = duel(['The Eye of Truth'], ['Pot of Greed']);
  clearHand(e, 1);
  grab(e, 1, 'Pot of Greed');
  const eye = playTrap(e, 0, 'The Eye of Truth');
  check(active(e, eye) && e.handRevealed(1), "the opponent's hand is kept revealed");
  endTurn(e);
  check(lp(e, 1) === 5000, "the opponent's Standby Phase with a Spell in hand: they gain 1000 LP");
}

card('The Flute of Summoning Dragon');
{
  const e = duel(['The Flute of Summoning Dragon', 'Lord of D.', 'Baby Dragon', 'Blue-Eyes White Dragon']);
  check(!canAct(e, 0, 'The Flute of Summoning Dragon'), 'needs "Lord of D." on the field');
  place(e, 0, 'Lord of D.');
  grab(e, 0, 'Baby Dragon');
  grab(e, 0, 'Blue-Eyes White Dragon');
  playSpell(e, 0, 'The Flute of Summoning Dragon', { pick: ['Baby Dragon', 'Blue-Eyes White Dragon'] });
  check(!!onField(e, 0, 'Baby Dragon') && !!onField(e, 0, 'Blue-Eyes White Dragon'), 'Special Summons up to 2 Dragons from the hand');
}

card('Time Machine');
{
  const e = duel(['Time Machine', 'Petit Moth']);
  const m = place(e, 0, 'Petit Moth')!;
  putST(e, 0, 'Time Machine');
  endTurn(e);
  const a = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, a, m, { respond: 'Time Machine' });
  check(zone(e, m) === 'mz' && e.controller(m.uid) === 0 && e.fieldCard(m.uid)?.pos === 'atk', 'a monster destroyed by battle returns to the same field in the same position');
}

card('Toon World');
{
  const e = duel(['Toon World']);
  const tw = playSpell(e, 0, 'Toon World');
  check(active(e, tw) && lp(e, 0) === 3000, 'activated by paying 1000 LP (it stays on the field)');
}

card('Windstorm of Etaqua');
{
  const e = duel(['Windstorm of Etaqua']);
  const a = place(e, 1, FILL)!;
  const b = place(e, 1, FILL, 'def')!;
  const own = place(e, 0, FILL)!;
  playTrap(e, 0, 'Windstorm of Etaqua');
  check(a.pos === 'def' && b.pos === 'atk' && own.pos === 'atk', "changes the battle positions of all face-up monsters the opponent controls");
}

// ---------- the whole group ----------
{
  const list = '/tmp/claude-0/st/group-B.json';
  const group = existsSync(list) ? (JSON.parse(readFileSync(list, 'utf8')) as { name: string }[]) : [];
  const missing = group.filter((c) => !cards.has(c.name)).map((c) => c.name);
  check(missing.length === 0, `every group B card has a check${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
}
console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
console.log(`B: ${cards.size} cards checked, ${FIXED.size} fixed`);
process.exit(fails ? 1 : 0);
