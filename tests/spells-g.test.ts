// Group G audit: Speed Duel Spell/Trap scripts of cards-10.ts / cards-11.ts checked against the real card text (run: npx tsx tests/spells-g.test.ts)
// One or more behavioral checks per card: each is activated through the engine's real actions and its main outcome is checked.
import { Engine } from '../src/eds/engine';
import type { Card, CardInfo, ChainLink, FieldCard, Pid, Pos } from '../src/eds/types';
import { getEffect } from '../src/eds/effects';
import { DB } from './speedkit';
import { levelOf } from '../src/eds/speed/helpers';

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};
const FILL = 'Celtic Guardian';

// ---------- duel kit (from tests/batch-16.test.ts) ----------
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
  e.state.fx.ignoreCond = c.uid; // test setup: place it ignoring Summoning conditions (Toon "must be Special Summoned from the hand")
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

// ---------- more helpers ----------
/** Sends a card of `p` (deck or hand) to the GY. */
function bury(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} to bury for player ${p}`);
  run(e, e.sendToGrave(c.uid, 'mill'));
  return c;
}
/** Banishes a card of `p` (deck or hand). */
function banishOne(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.hand].find((x) => x.name === name)!;
  e.banish(c.uid);
  return c;
}
/** Places an Extra Deck monster ignoring its Summoning conditions (Contact Fusions). */
function placeX(e: Engine, p: Pid, name: string, pos: Pos = 'atk'): FieldCard | null {
  const c = e.player(p).fusion.find((x) => x.name === name)!;
  e.state.fx.ignoreCond = c.uid;
  const f = place(e, p, name, pos);
  e.state.fx.ignoreCond = undefined;
  return f;
}
const inHand = (e: Engine, p: Pid, name: string) => e.player(p).hand.filter((c) => c.name === name).length;
const inGy = (e: Engine, p: Pid, name: string) => e.player(p).gy.filter((c) => c.name === name).length;
const onField = (e: Engine, p: Pid, name: string) => e.monsters(p).filter((m) => m.name === name);
const special = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'SPECIAL', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const graveFx = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'GRAVE_EFFECT', player: p, uid: c.uid });
  return settle(e, ...ans);
};
/** Clears a player's hand into the GY. */
const emptyHand = (e: Engine, p: Pid) => {
  for (const c of e.player(p).hand.slice()) run(e, e.sendToGrave(c.uid, 'mill'));
};
const atk = (e: Engine, c: FieldCard | null | undefined) => (c ? e.atkOf(c) : -1);
const def = (e: Engine, c: FieldCard | null | undefined) => (c ? e.defOf(c) : -1);
void levelOf;
void logHas;
let cards = 0;
const fixedCards = new Set<string>();
const section2 = (name: string, fixed = false) => {
  cards++;
  if (fixed) fixedCards.add(name);
  section(name);
};
// Test-only stand-ins for cards the pool lacks.
const fake = (i: Partial<CardInfo> & { name: string }) => {
  const full = { id: 990000 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...i } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
fake({ name: 'G Test Rock', sub: 'Normal', level: 4, atk: 1000, def: 1000, race: 'Rock', attribute: 'EARTH' });



// ======================= cards-11.ts: Continuous Spells =======================
section2('Ancient Gear Castle');
{
  const e = duel(['Ancient Gear Castle', 'Ancient Gear', 'Ancient Gear Golem'], ['Ancient Gear', 'Axe Raider']);
  const castle = playSpell(e, 0, 'Ancient Gear Castle');
  const ag = summon(e, 0, 'Ancient Gear');
  const theirs = place(e, 1, 'Ancient Gear');
  check(active(e, castle) && atk(e, ag) === 400 && atk(e, theirs) === 400, 'every "Ancient Gear" monster on the field gains 300 ATK');
  summon(e, 0, FILL, false);
  check(castle!.counters === 2, 'a counter for each Normal Summon and each Set');
  place(e, 0, FILL);
  check(castle!.counters === 2, 'a Special Summon adds no counter');
  endTurn(e);
  endTurn(e);
  const before = e.monsters(0).length;
  kill(e, [e.monsters(0).find((m) => m.name === FILL && m.faceUp)]);
  e.apply({ type: 'SUMMON', player: 0, uid: grab(e, 0, 'Ancient Gear Golem').uid, zone: e.player(0).mz.findIndex((z) => z === null), pos: 'atk', faceUp: true });
  settle(e, 'yes');
  check(zone(e, castle) === 'gy' && onField(e, 0, 'Ancient Gear Golem').length === 1 && e.monsters(0).length === before, 'with 2 counters it is Tributed instead of 2 monsters for an "Ancient Gear" Tribute Summon');
}

section2('Arcane Barrier');
{
  const e = duel(['Arcane Barrier', 'Mystical Elf', 'Gemini Elf'], ['Dark Magician Girl']);
  const ab = playSpell(e, 0, 'Arcane Barrier');
  kill(e, [place(e, 1, 'Dark Magician Girl')]);
  kill(e, [place(e, 0, 'Mystical Elf')]);
  check(ab!.counters === 2, "a face-up Spellcaster destroyed (either side): 1 Spell Counter");
  const ge = place(e, 0, 'Gemini Elf');
  const hand = e.player(0).hand.length;
  effect(e, 0, ab, { pick: ['Gemini Elf'] });
  check(zone(e, ab) === 'gy' && zone(e, ge) === 'gy' && e.player(0).hand.length === hand + 2, 'send it and a Spellcaster to the GY: draw 1 card per counter');
}

section2('Attack the Moon!');
{
  const e = duel(['Attack the Moon!', 'Giant Soldier of Stone'], ['Hinotama']);
  playSpell(e, 0, 'Attack the Moon!');
  const rock = place(e, 0, 'Giant Soldier of Stone')!;
  rock.placedTurn = -1;
  const t = putST(e, 1, 'Hinotama');
  e.apply({ type: 'CHANGE_POS', player: 0, uid: rock.uid });
  settle(e, 'yes');
  check(zone(e, t) === 'gy', "your Rock monster changes battle position: destroy 1 of the opponent's Spells/Traps");
}

section2('Branded Disciple');
{
  const e = duel(['Branded Disciple'], ['Cyber Valley', 'Axe Raider'], ['Evil HERO Wild Cyclone']);
  playSpell(e, 0, 'Branded Disciple');
  place(e, 0, 'Evil HERO Wild Cyclone');
  endTurn(e);
  const valley = place(e, 1, 'Cyber Valley');
  place(e, 1, 'Axe Raider');
  const hand = e.player(1).hand.length;
  effect(e, 1, valley, { respond: 'Branded Disciple' });
  check(e.player(1).hand.length === hand && zone(e, valley) === 'mz', "negates the effect of an opponent's 0 ATK monster while you control a Level 8+ Fiend Fusion");
}

section2('Cerulean Skyfire', true);
{
  const e = duel(['Cerulean Skyfire', 'Hamon, Lord of Striking Thunder'], ['Hinotama', 'Hinotama']);
  playSpell(e, 0, 'Cerulean Skyfire');
  const ham = place(e, 0, 'Hamon, Lord of Striking Thunder')!;
  endTurn(e);
  playSpell(e, 1, 'Hinotama', { respond: 'Cerulean Skyfire' });
  check(lp(e, 0) === 4000 && ham.pos === 'def', "negates an opponent's Spell effect, then Hamon goes to Defense Position");
  ham.pos = 'atk';
  playSpell(e, 1, 'Hinotama', { respond: 'Cerulean Skyfire' });
  check(lp(e, 0) === 3500, 'only once per turn');
}
{
  const e = duel(['Cerulean Skyfire', 'Hamon, Lord of Striking Thunder'], ['Hinotama']);
  playSpell(e, 0, 'Cerulean Skyfire');
  const ham = place(e, 0, 'Hamon, Lord of Striking Thunder')!;
  endTurn(e);
  run(e, e.as(1, (function* () { e.banish(ham.uid); })()));
  playSpell(e, 1, 'Hinotama');
  check(zone(e, ham) === 'removed' && lp(e, 0) === 4000, 'a Sacred Beast you control leaves the field (banished, not only sent to the GY): you take no damage this turn');
}

section2('Constellar Belt');
{
  const e = duel(['Constellar Belt', 'Divine Wrath'], ['Cyber Valley', 'Axe Raider']);
  playSpell(e, 0, 'Constellar Belt');
  putST(e, 0, 'Divine Wrath');
  endTurn(e);
  const valley = place(e, 1, 'Cyber Valley');
  place(e, 1, 'Axe Raider');
  const mark = e.state.log.length;
  effect(e, 1, valley, { respond: 'Divine Wrath' });
  check(logHas(e, 'cannot be negated', mark) && !logHas(e, 'Cyber Valley is negated', mark), "the activation of a LIGHT monster's effect cannot be negated");
}

section2('Hidden Temples of Necrovalley');
{
  const e = duel(['Hidden Temples of Necrovalley', "Gravekeeper's Spy", "Gravekeeper's Priestess"], ['Axe Raider']);
  const ht = grab(e, 0, 'Hidden Temples of Necrovalley');
  place(e, 0, "Gravekeeper's Spy");
  const pr = place(e, 0, "Gravekeeper's Priestess");
  act(e, 0, ht.uid);
  check(place(e, 1, 'Axe Raider') === null, 'neither player can Special Summon non-"Gravekeeper\'s" monsters');
  kill(e, [pr]);
  check(zone(e, ht) === 'gy', 'destroyed when "Necrovalley" is no longer on the field');
}

section2('Jam Breeding Machine');
{
  const e = duel(['Jam Breeding Machine', 'Axe Raider']);
  playSpell(e, 0, 'Jam Breeding Machine');
  check(!e.canNormalSummon(0, grab(e, 0, 'Axe Raider'), true) && e.canNormalSummon(0, grab(e, 0, 'Axe Raider'), false), 'you cannot Summon, but you can Set');
  toTurn3(e);
  const slime = e.monsters(0).find((m) => m.name === 'Slime Token');
  check(!!slime && atk(e, slime) === 500 && slime.pos === 'atk', 'your Standby Phase: a 500/500 Slime Token in Attack Position');
}

section2('Machine Assembly Line');
{
  const e = duel(['Machine Assembly Line', 'Mechanicalchaser'], ['Cyber Dragon']);
  const line = playSpell(e, 0, 'Machine Assembly Line');
  const ch = place(e, 0, 'Mechanicalchaser');
  const cd = place(e, 1, 'Cyber Dragon');
  check(atk(e, ch) === 2050 && atk(e, cd) === 2300, 'all Machines on the field gain 200 ATK');
  kill(e, [ch]);
  kill(e, [cd]);
  check(line!.counters === 4, '2 Junk Counters each time a face-up Machine is destroyed');
  effect(e, 0, line, { pick: ['Mechanicalchaser'] });
  check(zone(e, line) === 'gy' && onField(e, 0, 'Mechanicalchaser').length === 1, 'send it to the GY: Special Summon a Machine with Level up to the counters');
}

section2('Millennium Revelation');
{
  const e = duel(['Millennium Revelation', 'Slifer the Sky Dragon', 'Monster Reborn']);
  const mr = playSpell(e, 0, 'Millennium Revelation');
  grab(e, 0, 'Slifer the Sky Dragon');
  effect(e, 0, mr, { pick: ['Send a Divine-Beast: add "Monster Reborn"'] }, { pick: ['Slifer the Sky Dragon'] });
  check(inGy(e, 0, 'Slifer the Sky Dragon') === 1 && inHand(e, 0, 'Monster Reborn') === 1, 'send a Divine-Beast from the hand: add "Monster Reborn" from the Deck');
  effect(e, 0, mr);
  check(zone(e, mr) === 'gy' && e.state.fx.revelation?.[0] === e.state.turn, 'send it to the GY: Ra can be revived with Monster Reborn this turn');
}

section2('Spiral Spear Strike');
{
  const e = duel(['Spiral Spear Strike', 'Gaia The Fierce Knight']);
  playSpell(e, 0, 'Spiral Spear Strike');
  const g = place(e, 0, 'Gaia The Fierce Knight')!;
  const d = place(e, 1, FILL, 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, g, d);
  check(lp(e, 1) === 4000 - (2300 - 1200), '"Gaia The Fierce Knight" inflicts piercing damage');
}

section2('Supply Squad');
{
  const e = duel(['Supply Squad']);
  playSpell(e, 0, 'Supply Squad');
  const n = e.player(0).hand.length;
  kill(e, [place(e, 0, FILL)], 1);
  kill(e, [place(e, 0, FILL)], 1);
  check(e.player(0).hand.length === n + 1, 'a monster you control is destroyed: draw 1 (once per turn)');
}

section2('Talisman of Trap Sealing');
{
  const e = duel(['Talisman of Trap Sealing', 'Sealmaster Meisei'], ['Coffin Seller']);
  const m = place(e, 0, 'Sealmaster Meisei');
  const t = playSpell(e, 0, 'Talisman of Trap Sealing');
  endTurn(e);
  const set = putST(e, 1, 'Coffin Seller');
  check(active(e, t) && !e.canActivateMain(1, set.uid), 'Traps cannot be activated while it is face-up');
  kill(e, [m]);
  check(zone(e, t) === 'gy' && e.canActivateMain(1, set.uid), '"Sealmaster Meisei" leaves the field: it is destroyed');
}

section2('Veil of Darkness', true);
{
  const e = duel(['Veil of Darkness', 'Feral Imp']);
  playSpell(e, 0, 'Veil of Darkness');
  const imp = grab(e, 0, 'Feral Imp');
  e.toDeckTop(imp.uid);
  endTurn(e);
  const hand = e.player(0).hand.length;
  endTurn(e, 'yes', 'yes');
  check(zone(e, imp) === 'gy' && e.player(0).hand.length === hand + 1, 'draw a DARK monster: reveal it, send it to the GY, then draw 1 more');
}

section2('Verdant Sanctuary');
{
  const e = duel(['Verdant Sanctuary', 'Big Insect', 'Gokibore']);
  playSpell(e, 0, 'Verdant Sanctuary');
  kill(e, [place(e, 0, 'Big Insect')], 1, 'yes');
  check(inHand(e, 0, 'Gokibore') === 1, 'an Insect is destroyed: add an Insect with the same Level from the Deck');
}

// ======================= cards-11.ts: Continuous Traps =======================
section2('Awakening of the Sacred Beasts');
{
  const e = duel(['Awakening of the Sacred Beasts', 'Uria, Lord of Searing Flames', 'Coffin Seller', 'Dragon\'s Rage']);
  const aw = playTrap(e, 0, 'Awakening of the Sacred Beasts');
  e.state.fx.ignoreCond = e.player(0).deck.find((c) => c.name === 'Uria, Lord of Searing Flames')!.uid;
  place(e, 0, 'Uria, Lord of Searing Flames');
  e.state.fx.ignoreCond = undefined;
  endTurn(e);
  summon(e, 1, FILL);
  check(lp(e, 0) === 4000 + 1400, 'a Sacred Beast: gain LP equal to the ATK of a monster the opponent Summons');
  endTurn(e);
  run(e, e.sendToGrave(grab(e, 0, 'Coffin Seller').uid, 'cost'));
  run(e, e.sendToGrave(grab(e, 0, "Dragon's Rage").uid, 'cost'));
  effect(e, 0, aw, { pick: ['Coffin Seller'] });
  check(inHand(e, 0, 'Coffin Seller') === 1, 'with a Level 10 monster: add a Continuous Trap from the GY');
  check(!e.canUseMonsterEffect(0, aw!), 'only once per turn');
}

section2('Battle-Scarred');
{
  const e = duel(['Battle-Scarred', 'Shadowknight Archfiend']);
  const arch = place(e, 0, 'Shadowknight Archfiend')!;
  const bs = playTrap(e, 0, 'Battle-Scarred');
  toTurn3(e);
  check(lp(e, 0) === 3100 && lp(e, 1) === 3100, 'your Standby Phase: the opponent pays the same LP as your Archfiend');
  kill(e, [bs]);
  check(zone(e, arch) === 'gy', 'Battle-Scarred leaves the field: the selected monster is destroyed');
}

section2('Chain Ignition');
{
  const e = duel(['Chain Ignition'], ['Axe Raider']);
  playTrap(e, 0, 'Chain Ignition');
  const axe = place(e, 1, 'Axe Raider');
  kill(e, [place(e, 1, FILL)], 1, 'yes', { pick: ['Axe Raider'] });
  check(zone(e, axe) === 'gy', "the opponent's effect destroys their own monster: destroy 1 card on the field");
}

section2('Coffin Seller');
{
  const e = duel(['Coffin Seller']);
  playTrap(e, 0, 'Coffin Seller');
  kill(e, [place(e, 1, FILL)]);
  check(lp(e, 1) === 3700, "a monster is sent to the opponent's GY: 300 damage");
}

section2('Copy Knight');
{
  const e = duel(['Copy Knight', 'Masaki the Legendary Swordsman']);
  const ck = putST(e, 0, 'Copy Knight');
  summon(e, 0, 'Masaki the Legendary Swordsman', true, { respond: 'Copy Knight' }, 'yes');
  const m = e.fieldCard(ck.uid);
  check(zone(e, ck) === 'mz' && atk(e, m) === 0 && e.raceOf(m!) === 'Warrior' && levelOf(e, m!) === 4 && e.isNamed(m!, 'Masaki the Legendary Swordsman'), 'Special Summoned as a 0/0 LIGHT Warrior with the same name and Level');
}

section2("Dragon's Rage");
{
  const e = duel(["Dragon's Rage", 'Luster Dragon']);
  playTrap(e, 0, "Dragon's Rage");
  const ld = place(e, 0, 'Luster Dragon')!;
  const d = place(e, 1, FILL, 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, ld, d);
  check(lp(e, 1) === 4000 - 700, 'your Dragon inflicts piercing damage');
}

section2('Human-Wave Tactics');
{
  const e = duel(['Human-Wave Tactics', 'Petit Moth', 'Mokey Mokey'], ['Axe Raider']);
  playTrap(e, 0, 'Human-Wave Tactics');
  const pm = place(e, 0, 'Petit Moth')!;
  endTurn(e);
  const axe = place(e, 1, 'Axe Raider')!;
  toBattle(e);
  attack(e, axe, pm);
  endTurn(e);
  check(onField(e, 0, 'Mokey Mokey').length === 1, 'End Phase: Special Summon as many Level 2 or lower Normal Monsters from the Deck as were destroyed by battle');
}

section2('Loop of Destruction');
{
  const e = duel(['Loop of Destruction'], ['Axe Raider']);
  const loop = playTrap(e, 0, 'Loop of Destruction');
  check(e.isNamed(loop!, 'Ring of Destruction'), 'its name is "Ring of Destruction" on the field');
  const axe = place(e, 1, 'Axe Raider');
  kill(e, [place(e, 1, FILL)], 0, 'yes', { pick: ['Axe Raider'] });
  check(zone(e, axe) === 'gy' && lp(e, 0) === 3500 && lp(e, 1) === 3500, 'a monster destroyed by an effect: destroy 1 monster, each player takes 500');
}

section2('Machine King - 3000 B.C.', true);
{
  const e = duel(['Machine King - 3000 B.C.', 'Mechanicalchaser', FILL]);
  const fd = place(e, 0, FILL, 'def', false)!;
  endTurn(e);
  endTurn(e);
  const mk = playTrap(e, 0, 'Machine King - 3000 B.C.', 'yes');
  check(zone(e, mk) === 'mz' && atk(e, mk) === 1000 && e.raceOf(mk!) === 'Machine', 'Special Summoned as a 1000 ATK Machine monster');
  check(place(e, 0, 'Mechanicalchaser') === null && !e.canNormalSummon(0, grab(e, 0, FILL), true), 'no other Normal or Special Summons this turn');
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: fd.uid });
  settle(e);
  check(fd.faceUp, 'a Flip Summon is still allowed (the text only stops Normal and Special Summons)');
  toTurn3(e);
  const ch = place(e, 0, 'Mechanicalchaser')!;
  effect(e, 0, mk, { pick: ['Mechanicalchaser'] });
  check(zone(e, ch) === 'gy' && atk(e, mk) === 1000 + 1850, 'Tribute a Machine: gains its ATK');
  endTurn(e);
  check(atk(e, mk) === 1000, 'until the end of the turn');
}
{
  // The Tribute is a cost: it is gone before the opponent can respond.
  const e = duel(['Machine King - 3000 B.C.', 'Mechanicalchaser']);
  const mk = playTrap(e, 0, 'Machine King - 3000 B.C.', 'yes')!;
  toTurn3(e);
  const ch = place(e, 0, 'Mechanicalchaser')!;
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: mk.uid });
  for (let i = 0; i < 5 && e.state.prompt && e.state.prompt.kind !== 'response'; i++) e.apply({ type: 'CHOOSE', player: e.state.prompt.player, picks: [0] });
  check(zone(e, ch) === 'gy', 'the Machine is Tributed when the effect is activated (cost), not when it resolves');
  settle(e);
}

section2('Macro Cosmos');
{
  const e = duel(['Macro Cosmos', 'Helios - The Primordial Sun']);
  const mc = playTrap(e, 0, 'Macro Cosmos', 'yes');
  const f = place(e, 1, FILL);
  kill(e, [f]);
  check(active(e, mc) && onField(e, 0, 'Helios - The Primordial Sun').length === 1 && zone(e, f) === 'removed', 'Special Summons Helios; cards sent to the GY are banished instead');
}

section2('Summon Gate');
{
  const e = duel(['Summon Gate'], [], Array(4).fill('Gaia the Dragon Champion'));
  playTrap(e, 0, 'Summon Gate');
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const c = e.player(0).fusion[0];
    run(e, e.specialSummon(c.uid, 0, 'atk'));
    const m = e.fieldCard(c.uid);
    if (m) n++;
    kill(e, [m]);
  }
  check(n === 3, 'at most 3 Special Summons from the Extra Deck per turn');
}

section2('Swamp Mirrorer');
{
  const e = duel(['Swamp Mirrorer']);
  const sm = playTrap(e, 0, 'Swamp Mirrorer', { pick: ['Dragon'] }, { pick: ['DARK'] }, 'yes');
  check(zone(e, sm) === 'mz' && atk(e, sm) === 1800 && def(e, sm) === 1000 && e.raceOf(sm!) === 'Dragon' && levelOf(e, sm!) === 4, 'Special Summoned as a Level 4 1800/1000 monster of the declared Type');
}

section2('Talisman of Spell Sealing');
{
  const e = duel(['Talisman of Spell Sealing', 'Sealmaster Meisei'], ['Hinotama']);
  const m = place(e, 0, 'Sealmaster Meisei');
  const t = playTrap(e, 0, 'Talisman of Spell Sealing');
  endTurn(e);
  const h = grab(e, 1, 'Hinotama');
  check(active(e, t) && !e.canActivateMain(1, h.uid), 'Spells cannot be activated');
  kill(e, [m]);
  check(zone(e, t) === 'gy' && e.canActivateMain(1, h.uid), '"Sealmaster Meisei" leaves: it is destroyed');
}

// ======================= cards-10.ts =======================
section2('The Beginning of the End');
{
  const e = duel([...Array(7).fill('Dark Blade'), 'The Beginning of the End']);
  for (let i = 0; i < 7; i++) bury(e, 0, 'Dark Blade');
  grab(e, 0, 'The Beginning of the End');
  const hand = e.player(0).hand.length;
  playSpell(e, 0, 'The Beginning of the End');
  check(e.player(0).removed.length === 5 && e.player(0).hand.length === hand - 1 + 3, 'banishes 5 DARK monsters from the GY, draws 3');
}

section2('The Big March of Animals');
{
  const e = duel(['Silver Fang', 'Silver Fang', 'The Big March of Animals'], ['Silver Fang']);
  const a = place(e, 0, 'Silver Fang');
  place(e, 0, 'Silver Fang');
  const theirs = place(e, 1, 'Silver Fang');
  playSpell(e, 0, 'The Big March of Animals');
  check(atk(e, a) === 1200 + 400 && atk(e, theirs) === 1200, 'your Beasts gain 200 ATK per Beast you control (not the opponent\'s)');
  endTurn(e);
  check(atk(e, a) === 1200, 'until the end of the turn');
}

section2('The First Sarcophagus');
{
  const e = duel(['The First Sarcophagus', 'The Second Sarcophagus', 'The Third Sarcophagus', 'Spirit of the Pharaoh']);
  playTrap(e, 0, 'The First Sarcophagus');
  endTurn(e);
  endTurn(e);
  check(e.spells(0).some((c) => c.name === 'The Second Sarcophagus' && c.faceUp), "opponent's End Phase: The Second Sarcophagus is placed");
  endTurn(e);
  endTurn(e);
  check(onField(e, 0, 'Spirit of the Pharaoh').length === 1 && inGy(e, 0, 'The Third Sarcophagus') === 1, 'all 3: sent to the GY to Special Summon Spirit of the Pharaoh');
}

section2('The Second Sarcophagus');
{
  const e = duel(['The Second Sarcophagus']);
  check(!e.canActivateMain(0, grab(e, 0, 'The Second Sarcophagus').uid), 'cannot be activated by itself');
}

section2('The Third Sarcophagus');
{
  const e = duel(['The Third Sarcophagus']);
  check(!e.canActivateMain(0, grab(e, 0, 'The Third Sarcophagus').uid), 'cannot be activated by itself');
}

section2('The Forceful Checkpoint');
{
  const e = duel([], ['The Forceful Checkpoint']);
  const a = place(e, 0, FILL);
  putST(e, 1, 'The Forceful Checkpoint');
  toTurn3(e);
  toBattle(e);
  const n = inGy(e, 0, FILL);
  attack(e, a, null, { respond: 'The Forceful Checkpoint' });
  check(lp(e, 1) === 4000 && inGy(e, 0, FILL) === n + 1, 'the attack is negated and a monster in their hand is discarded');
}

section2('The Fountain in the Sky');
{
  const e = duel(['Mystical Elf', 'The Fountain in the Sky']);
  playSpell(e, 0, 'The Fountain in the Sky');
  const elf = place(e, 0, 'Mystical Elf');
  endTurn(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, elf, { respond: 'The Fountain in the Sky' });
  check(zone(e, elf) === 'removed' && lp(e, 0) === 4000 - 600 + 800, 'a LIGHT monster destroyed by battle: banish it, gain LP equal to its ATK');
}

section2('The Golden Apples');
{
  const e = duel(['The Golden Apples']);
  putST(e, 0, 'The Golden Apples');
  endTurn(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, null, { respond: 'The Golden Apples' });
  const tok = e.monsters(0).find((m) => m.name === 'Malus Token');
  check(lp(e, 0) === 4000 && !!tok && atk(e, tok) === 1400 && def(e, tok) === 1400, 'gain the battle damage back and Special Summon a Malus Token with that ATK/DEF');
}

section2('The Grave of Enkindling');
{
  const e = duel(['Mystical Elf', 'The Grave of Enkindling'], ['Dark Blade']);
  const elf = place(e, 0, 'Mystical Elf');
  putST(e, 0, 'The Grave of Enkindling');
  bury(e, 1, 'Dark Blade');
  endTurn(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, elf, { respond: 'The Grave of Enkindling' });
  const mine = onField(e, 0, 'Mystical Elf')[0];
  const theirs = onField(e, 1, 'Dark Blade')[0];
  check(mine?.pos === 'def' && theirs?.pos === 'def' && !!theirs.cannotChangePos, 'each player Special Summons 1 monster from their GY in Defense Position; they cannot change position');
}

section2('The Mask of Remnants');
{
  const e = duel(['The Mask of Remnants']);
  const c = grab(e, 0, 'The Mask of Remnants');
  act(e, 0, c.uid);
  check(zone(e, c) === 'deck', "shuffled into its owner's Deck");
}

section2('The Melody of Awakening Dragon');
{
  const e = duel(['The Melody of Awakening Dragon', 'Blue-Eyes White Dragon', 'Blue-Eyes White Dragon', 'Fissure']);
  grab(e, 0, 'Fissure');
  playSpell(e, 0, 'The Melody of Awakening Dragon', { pick: ['Fissure'] }, { pick: ['Blue-Eyes White Dragon', 'Blue-Eyes White Dragon'] });
  check(inGy(e, 0, 'Fissure') === 1 && inHand(e, 0, 'Blue-Eyes White Dragon') === 2, 'discard 1 card: add up to 2 Dragons with 3000+ ATK and 2500- DEF');
}

section2('The Puppet Magic of Dark Ruler');
{
  const e = duel(['The Puppet Magic of Dark Ruler', 'Summoned Skull', 'Giant Germ', 'Kuriboh']);
  bury(e, 0, 'Summoned Skull');
  const a = place(e, 0, FILL);
  const b = place(e, 0, 'Giant Germ');
  playSpell(e, 0, 'The Puppet Magic of Dark Ruler', { pick: ['Summoned Skull'] }, { pick: [FILL, 'Giant Germ'] });
  check(zone(e, a) === 'removed' && zone(e, b) === 'removed' && onField(e, 0, 'Summoned Skull').length === 1, 'banish monsters whose Levels add up to the Fiend\'s Level (4+2=6), then Special Summon it');
}

section2('The Warrior Returning Alive');
{
  const e = duel(['The Warrior Returning Alive', 'Dark Blade']);
  bury(e, 0, 'Dark Blade');
  playSpell(e, 0, 'The Warrior Returning Alive');
  check(inHand(e, 0, 'Dark Blade') === 1, 'adds a Warrior from the GY to the hand');
}

section2('Thousand Knives');
{
  const e = duel(['Thousand Knives', 'Dark Magician']);
  const foe = place(e, 1, FILL);
  check(!e.canActivateMain(0, grab(e, 0, 'Thousand Knives').uid), 'needs "Dark Magician"');
  place(e, 0, 'Dark Magician');
  playSpell(e, 0, 'Thousand Knives');
  check(zone(e, foe) === 'gy', "destroys the targeted opponent's monster");
}

section2('Token Stampede');
{
  const e = duel(['Token Stampede']);
  const tok = e.createToken('Audit Token', 0, 'atk', true, { atk: 500, def: 500, level: 1 })!;
  const tok2 = e.createToken('Audit Token', 1, 'atk', true, { atk: 500, def: 500, level: 1 })!;
  playTrap(e, 0, 'Token Stampede');
  check(atk(e, tok) === 1500 && atk(e, tok2) === 1500 && e.shielded(tok, 'battle'), 'all Attack Position Tokens gain 1000 ATK and cannot be destroyed by battle');
}

section2('Token Sundae');
{
  const e = duel(['Token Sundae'], [FILL]);
  e.createToken('Audit Token', 0, 'atk', true, { atk: 0, def: 0, level: 1 });
  const a = place(e, 1, FILL);
  playSpell(e, 0, 'Token Sundae', { pick: [FILL] });
  check(e.monsters(0).length === 0 && zone(e, a) === 'gy', 'destroys your Tokens, then up to that many cards on the field');
}

section2('Toon Defense');
{
  const e = duel(['Toon Defense', 'Toon Mermaid'], ['Dark Blade']);
  const mer = place(e, 0, 'Toon Mermaid')!;
  playTrap(e, 0, 'Toon Defense');
  endTurn(e);
  const foe = place(e, 1, 'Dark Blade')!;
  toBattle(e);
  attack(e, foe, mer, { respond: 'Toon Defense' });
  check(zone(e, mer) === 'mz' && lp(e, 0) === 4000 - 1800, 'the attack on a Level 4 or lower Toon becomes a direct attack');
}

section2('Toon Mask');
{
  const e = duel(['Toon World', 'Toon Mask', 'Toon Mermaid']);
  place(e, 1, FILL);
  playSpell(e, 0, 'Toon World');
  playTrap(e, 0, 'Toon Mask', { pick: [FILL] }, { pick: ['Toon Mermaid'] });
  check(onField(e, 0, 'Toon Mermaid').length === 1, 'Special Summons a Toon with Level at most the target\'s from the hand or Deck');
}

section2('Toon Rollback');
{
  const e = duel(['Toon World', 'Toon Rollback', 'Toon Mermaid']);
  playSpell(e, 0, 'Toon World');
  const mer = place(e, 0, 'Toon Mermaid')!;
  toTurn3(e);
  playSpell(e, 0, 'Toon Rollback');
  toBattle(e);
  attack(e, mer, null);
  attack(e, mer, null);
  check(lp(e, 1) === 4000 - 2800, 'the Toon attacks twice');
}

section2('Toon Table of Contents');
{
  const e = duel(['Toon Table of Contents', 'Toon World']);
  playSpell(e, 0, 'Toon Table of Contents');
  check(inHand(e, 0, 'Toon World') === 1, 'adds a "Toon" card from the Deck');
}

section2('Tornado Wall');
{
  const e = duel(['Umi', 'Tornado Wall'], ['Dark Blade']);
  const umi = playSpell(e, 0, 'Umi');
  const tw = playTrap(e, 0, 'Tornado Wall');
  endTurn(e);
  const foe = place(e, 1, 'Dark Blade')!;
  toBattle(e);
  attack(e, foe, null);
  check(lp(e, 0) === 4000, 'no battle damage from attacking monsters while "Umi" is on the field');
  kill(e, [umi], 1);
  check(zone(e, tw) === 'gy', 'destroyed when "Umi" leaves');
}

section2('Trap Jammer');
{
  const e = duel(['Trap Jammer'], ['Waboku']);
  const a = place(e, 0, FILL)!;
  putST(e, 0, 'Trap Jammer');
  const wb = putST(e, 1, 'Waboku');
  toTurn3(e);
  toBattle(e);
  attack(e, a, null, { respond: 'Waboku' }, { respond: 'Trap Jammer' });
  check(zone(e, wb) === 'gy' && lp(e, 1) === 4000 - 1400, "negates the opponent's Trap activated during the Battle Phase and destroys it");
}

section2('Tri-Blaze Accelerator');
{
  const e = duel(['Blaze Accelerator', 'Tri-Blaze Accelerator', 'Blazing Inpachi']);
  const ba = playSpell(e, 0, 'Blaze Accelerator');
  const t = playSpell(e, 0, 'Tri-Blaze Accelerator');
  const foe = place(e, 1, FILL);
  grab(e, 0, 'Blazing Inpachi');
  effect(e, 0, t, { pick: ['Blazing Inpachi'] });
  check(zone(e, ba) === 'gy' && zone(e, foe) === 'gy' && lp(e, 1) === 3500, 'send a Pyro from the hand: destroy 1 opponent\'s monster and inflict 500');
}

section2('Tri-Wight');
{
  const e = duel(['Petit Dragon', 'Skull Servant', 'Mokey Mokey', 'Tri-Wight']);
  for (const n of ['Petit Dragon', 'Skull Servant', 'Mokey Mokey']) bury(e, 0, n);
  playSpell(e, 0, 'Tri-Wight', { pick: ['Petit Dragon', 'Skull Servant', 'Mokey Mokey'] });
  check(e.monsters(0).length === 3, 'Special Summons 3 Level 2 or lower Normal Monsters from the GY');
}

section2('Tribute Doll');
{
  const e = duel(['Tribute Doll', 'Dark Magician']);
  const f = place(e, 0, FILL);
  grab(e, 0, 'Dark Magician');
  playSpell(e, 0, 'Tribute Doll');
  const dm = onField(e, 0, 'Dark Magician')[0];
  check(zone(e, f) === 'gy' && !!dm && dm.tags?.noAttackTurn === e.state.turn, 'Tribute 1 monster: Special Summon a Level 7 from the hand, it cannot attack this turn');
}

section2('Tutan Mask', true);
{
  const e = duel(['Thousand Knives', 'Dark Magician'], ['Tutan Mask', 'Armored Zombie', 'Armored Zombie']);
  place(e, 0, 'Dark Magician');
  const z = place(e, 1, 'Armored Zombie');
  const tm = putST(e, 1, 'Tutan Mask');
  playSpell(e, 0, 'Thousand Knives', { pick: ['Armored Zombie'] }, { respond: 'Tutan Mask' });
  check(zone(e, z) === 'mz' && zone(e, tm) === 'gy' && inGy(e, 0, 'Thousand Knives') === 1, 'negates a Spell that targets 1 Zombie and destroys it');
  // Not against the effect of a Continuous card already face-up (only a Spell/Trap Card activation).
  const z2 = place(e, 1, 'Armored Zombie')!;
  const fake: ChainLink = { card: e.player(0).gy.find((c) => c.name === 'Thousand Knives')!, loc: { zone: 'sz', player: 0, index: 0 }, player: 0, label: 'x', negated: false, targetUid: z2.uid, payload: { effect: 'quick' } } as ChainLink;
  check(!getEffect('Tutan Mask')!.canActivate!(e, tm, 1, 'spell', { link: fake }), 'not against the effect of a face-up Spell/Trap (only a card activation)');
}

section2('Twister');
{
  const e = duel(['Twister'], ['Umi']);
  endTurn(e);
  const umi = playSpell(e, 1, 'Umi');
  endTurn(e);
  playSpell(e, 0, 'Twister');
  check(zone(e, umi) === 'gy' && lp(e, 0) === 3500, 'pay 500 LP: destroy a face-up Spell/Trap');
}

section2('Ultra Evolution Pill');
{
  const e = duel(['Ultra Evolution Pill', 'Ancient Lizard Warrior', 'Mammoth Graveyard']);
  const r = place(e, 0, 'Ancient Lizard Warrior');
  grab(e, 0, 'Mammoth Graveyard');
  playSpell(e, 0, 'Ultra Evolution Pill');
  check(zone(e, r) === 'gy' && onField(e, 0, 'Mammoth Graveyard').length === 1, 'Tribute a Reptile: Special Summon a Dinosaur from the hand');
}

section2('Unbreakable Spirit');
{
  const e = duel(['Unbreakable Spirit'], ['Petit Angel', FILL]);
  const m = place(e, 0, FILL);
  place(e, 1, 'Petit Angel');
  place(e, 1, FILL);
  playTrap(e, 0, 'Unbreakable Spirit');
  check(atk(e, m) === 1400 + 600, "your only monster gains the ATK of the opponent's lowest-ATK monster");
  endTurn(e);
  check(atk(e, m) === 1400, 'until the end of the turn');
}

section2('Unending Nightmare');
{
  const e = duel(['Unending Nightmare'], ['Umi']);
  endTurn(e);
  const umi = playSpell(e, 1, 'Umi');
  endTurn(e);
  const un = playTrap(e, 0, 'Unending Nightmare')!;
  effect(e, 0, un);
  check(zone(e, umi) === 'gy' && lp(e, 0) === 3000, 'pay 1000 LP: destroy a face-up Spell/Trap');
}

section2('Union Hangar');
{
  const e = duel(['Union Hangar', 'W-Wing Catapult', 'Y-Dragon Head', 'Z-Metal Tank']);
  playSpell(e, 0, 'Union Hangar', 'yes', { pick: ['W-Wing Catapult'] });
  check(inHand(e, 0, 'W-Wing Catapult') === 1, 'adds a LIGHT Machine Union monster when activated');
  const y = summon(e, 0, 'Y-Dragon Head', true, 'yes');
  const z = e.spells(0).find((c) => c.name === 'Z-Metal Tank');
  check(!!z && y!.equips.includes(z.uid), 'a LIGHT Machine Union is Summoned: equip a different one from the Deck to it');
}

section2('Union Scramble');
{
  const e = duel(['Union Scramble', 'V-Tiger Jet', 'X-Head Cannon']);
  banishOne(e, 0, 'V-Tiger Jet');
  banishOne(e, 0, 'X-Head Cannon');
  playTrap(e, 0, 'Union Scramble', { pick: ['V-Tiger Jet', 'X-Head Cannon'] });
  check(onField(e, 0, 'V-Tiger Jet').length === 1 && onField(e, 0, 'X-Head Cannon').length === 1, 'Special Summons banished LIGHT Machine Normal/Union monsters');
}

section2('United We Stand');
{
  const e = duel(['United We Stand']);
  const m = place(e, 0, FILL);
  place(e, 0, FILL);
  place(e, 1, FILL);
  playSpell(e, 0, 'United We Stand', { pick: [FILL] });
  check(atk(e, m) === 1400 + 1600 && def(e, m) === 1200 + 1600, 'gains 800 ATK/DEF for each face-up monster you control');
}

section2('Valhalla, Hall of the Fallen');
{
  const e = duel(['Valhalla, Hall of the Fallen', 'Petit Angel']);
  const v = playSpell(e, 0, 'Valhalla, Hall of the Fallen')!;
  grab(e, 0, 'Petit Angel');
  effect(e, 0, v);
  check(onField(e, 0, 'Petit Angel').length === 1 && !e.canUseMonsterEffect(0, v), 'Special Summons a Fairy from the hand while you control no monsters');
}

section2('Vampire Awakening');
{
  const e = duel(['Vampire Awakening', 'Vampire Lady']);
  playTrap(e, 0, 'Vampire Awakening');
  const lady = onField(e, 0, 'Vampire Lady')[0];
  check(!!lady, 'Special Summons a "Vampire" monster from the Deck');
  endTurn(e);
  check(zone(e, lady) === 'gy', 'destroyed during the End Phase');
}

section2("Vampire's Desire");
{
  const e = duel(["Vampire's Desire", 'Vampire Lady', 'Vampire Lord']);
  bury(e, 0, 'Vampire Lord');
  const f = place(e, 0, FILL);
  playSpell(e, 0, "Vampire's Desire", { pick: ['Revive a Vampire from the GY'] }, { pick: ['Vampire Lord'] }, { pick: [FILL] });
  check(zone(e, f) === 'gy' && onField(e, 0, 'Vampire Lord').length === 1, 'send a monster you control to the GY: Special Summon the targeted Vampire');
}

section2('Vehicroid Connection Zone');
{
  const e = duel(['Vehicroid Connection Zone', 'Steamroid', 'Drillroid', 'Submarineroid'], [], ['Super Vehicroid Jumbo Drill']);
  for (const n of ['Steamroid', 'Drillroid', 'Submarineroid']) grab(e, 0, n);
  playSpell(e, 0, 'Vehicroid Connection Zone');
  const jd = onField(e, 0, 'Super Vehicroid Jumbo Drill')[0];
  kill(e, [jd], 1);
  check(!!jd && zone(e, jd) === 'mz', 'Fusion Summons a "Vehicroid"; it cannot be destroyed by card effects');
}

section2('Waking the Dragon', true);
{
  const e = duel(['Waking the Dragon', 'Blue-Eyes White Dragon']);
  const w = putST(e, 0, 'Waking the Dragon');
  kill(e, [w], 1, 'yes', { pick: ['Blue-Eyes White Dragon'] });
  check(onField(e, 0, 'Blue-Eyes White Dragon').length === 1, "Set card destroyed by the opponent's effect: Special Summon a monster from the Deck");
}
{
  const e = duel(['Waking the Dragon', 'Blue-Eyes White Dragon']);
  const w = putST(e, 0, 'Waking the Dragon');
  run(e, e.as(1, (function* () { e.toHand(w.uid); })()), 'yes', { pick: ['Blue-Eyes White Dragon'] });
  run(e, e.flushLeaves(), 'yes', { pick: ['Blue-Eyes White Dragon'] });
  check(zone(e, w) === 'hand' && e.monsters(0).length === 0, 'not when the opponent returns it to the hand (it must be in the GY or banished)');
}

section2('Wall of Disruption');
{
  const e = duel(['Wall of Disruption'], ['Blue-Eyes White Dragon', 'Dark Blade']);
  putST(e, 0, 'Wall of Disruption');
  endTurn(e);
  const a = place(e, 1, 'Blue-Eyes White Dragon')!;
  const b = place(e, 1, 'Dark Blade')!;
  toBattle(e);
  attack(e, a, null, { respond: 'Wall of Disruption' });
  check(atk(e, a) === 3000 - 1600 && atk(e, b) === 1800 - 1600, 'their Attack Position monsters lose 800 ATK per monster they control');
}

section2('Water Hazard');
{
  const e = duel(['Water Hazard', 'Penguin Soldier']);
  const w = playSpell(e, 0, 'Water Hazard')!;
  grab(e, 0, 'Penguin Soldier');
  effect(e, 0, w);
  check(onField(e, 0, 'Penguin Soldier').length === 1, 'Special Summons a Level 4 or lower WATER monster from the hand');
}

section2('Weapon Change');
{
  const e = duel(['Weapon Change']);
  const m = place(e, 0, FILL)!;
  playSpell(e, 0, 'Weapon Change');
  endTurn(e);
  endTurn(e, 'yes');
  check(atk(e, m) === 1200 && def(e, m) === 1400 && lp(e, 0) === 3300, "Standby Phase: pay 700 LP to switch a Warrior's ATK and DEF");
  endTurn(e);
  endTurn(e);
  check(atk(e, m) === 1400 && def(e, m) === 1200, "back after the end of the opponent's next turn");
}

section2('White Dragon Ritual');
{
  const e = duel(['White Dragon Ritual', 'Paladin of White Dragon']);
  place(e, 0, FILL);
  grab(e, 0, 'Paladin of White Dragon');
  playSpell(e, 0, 'White Dragon Ritual');
  check(onField(e, 0, 'Paladin of White Dragon').length === 1, 'Ritual Summons Paladin of White Dragon');
}

section2("White Elephant's Gift");
{
  const e = duel(["White Elephant's Gift"]);
  const m = place(e, 0, FILL);
  const hand = e.player(0).hand.length;
  playSpell(e, 0, "White Elephant's Gift");
  check(zone(e, m) === 'gy' && e.player(0).hand.length === hand + 2, 'send a face-up non-Effect monster to the GY: draw 2');
}

section2('Wicked-Breaking Flamberge - Baou');
{
  const e = duel(['Wicked-Breaking Flamberge - Baou', 'Blue-Eyes White Dragon', 'Fissure']);
  const b = place(e, 0, 'Blue-Eyes White Dragon')!;
  grab(e, 0, 'Fissure');
  playSpell(e, 0, 'Wicked-Breaking Flamberge - Baou', { pick: ['Fissure'] }, { pick: ['Blue-Eyes White Dragon'] });
  check(inGy(e, 0, 'Fissure') === 1 && atk(e, b) === 3500, 'send a card from the hand, equip: +500 ATK');
}

section2('Wild Fire');
{
  const e = duel(['Blaze Accelerator', 'Wild Fire'], [FILL]);
  const ba = playSpell(e, 0, 'Blaze Accelerator');
  const b = place(e, 1, FILL);
  playSpell(e, 0, 'Wild Fire');
  const tok = e.monsters(0).find((m) => m.name === 'Wild Fire Token');
  check(zone(e, ba) === 'gy' && zone(e, b) === 'gy' && lp(e, 0) === 3500 && !!tok && atk(e, tok) === 1000, 'pay 500: destroy Blaze Accelerator and all monsters, then a Wild Fire Token');
}

section2("Wild Nature's Release");
{
  const e = duel(["Wild Nature's Release", 'Silver Fang']);
  const s = place(e, 0, 'Silver Fang');
  playSpell(e, 0, "Wild Nature's Release");
  check(atk(e, s) === 2000, 'gains ATK equal to its DEF');
  endTurn(e);
  check(zone(e, s) === 'gy', 'destroyed during the End Phase');
}

section2('Wild Tornado', true);
{
  const e = duel(['Wild Tornado'], ['Toon World', 'Fissure']);
  endTurn(e);
  const tw = playSpell(e, 1, 'Toon World');
  grab(e, 1, 'Fissure');
  endTurn(e);
  playTrap(e, 0, 'Wild Tornado', { pick: ['Toon World'] }, 'yes', { pick: ['Fissure'] });
  check(zone(e, tw) === 'gy' && e.spells(1).some((c) => c.name === 'Fissure' && !c.faceUp), 'destroys a face-up card in the Spell & Trap Zone; its controller can Set a Spell/Trap');
}
{
  const e = duel(['Wild Tornado', 'Toon World'], ['Macro Cosmos']);
  const toon = playSpell(e, 0, 'Toon World');
  endTurn(e);
  playTrap(e, 1, 'Macro Cosmos');
  endTurn(e);
  const w = putST(e, 0, 'Wild Tornado');
  kill(e, [w], 1);
  check(zone(e, w) === 'removed' && zone(e, toon) === 'sz', 'destroyed but banished (not sent to the GY): no effect');
}

section2('Wonder Garage', true);
{
  const e = duel(['Wonder Garage', 'Truckroid']);
  const w = putST(e, 0, 'Wonder Garage');
  grab(e, 0, 'Truckroid');
  kill(e, [w], 1, 'yes');
  check(onField(e, 0, 'Truckroid').length === 1, 'face-down card destroyed and sent to the GY: Special Summon a "roid" from the hand');
}
{
  const e = duel(['Wonder Garage', 'Truckroid'], ['Macro Cosmos']);
  endTurn(e);
  playTrap(e, 1, 'Macro Cosmos');
  endTurn(e);
  const w = putST(e, 0, 'Wonder Garage');
  grab(e, 0, 'Truckroid');
  kill(e, [w], 1, 'yes');
  check(zone(e, w) === 'removed' && onField(e, 0, 'Truckroid').length === 0, 'destroyed but banished: no effect');
}

section2('Wonder Wand');
{
  const e = duel(['Wonder Wand', 'Mystical Elf']);
  const s = place(e, 0, 'Mystical Elf');
  const w = playSpell(e, 0, 'Wonder Wand', { pick: ['Mystical Elf'] });
  check(atk(e, s) === 1300, 'equipped Spellcaster gains 500 ATK');
  const hand = e.player(0).hand.length;
  effect(e, 0, w);
  check(zone(e, s) === 'gy' && zone(e, w) === 'gy' && e.player(0).hand.length === hand + 2, 'send both to the GY: draw 2');
}

section2('Zero Gravity', true);
{
  const e = duel(['Zero Gravity'], [FILL]);
  const a = place(e, 0, FILL)!;
  const b = place(e, 1, FILL, 'def')!;
  playTrap(e, 0, 'Zero Gravity');
  check(a.pos === 'def' && b.pos === 'atk', 'all face-up monsters change their battle positions');
}
{
  const e = duel(['Zero Gravity', 'Attack the Moon!', 'Giant Soldier of Stone'], ['Hinotama']);
  playSpell(e, 0, 'Attack the Moon!');
  place(e, 0, 'Giant Soldier of Stone');
  const t = putST(e, 1, 'Hinotama');
  playTrap(e, 0, 'Zero Gravity', 'yes');
  check(zone(e, t) === 'gy', 'the position changes are seen by other cards (Attack the Moon! triggers)');
}

section2('Zoma the Spirit', true);
{
  const e = duel(['Zoma the Spirit'], ['Dark Blade']);
  const z = playTrap(e, 0, 'Zoma the Spirit')!;
  check(zone(e, z) === 'mz' && z.pos === 'def' && atk(e, z) === 1800 && e.raceOf(z) === 'Zombie', 'Special Summoned in Defense Position as a 1800/500 Zombie');
  endTurn(e);
  const foe = place(e, 1, 'Dark Blade')!;
  toBattle(e);
  attack(e, foe, z);
  check(zone(e, z) === 'gy' && lp(e, 1) === 4000 - 1800, 'destroyed by battle: damage equal to the ATK of the monster that destroyed it');
}
{
  const e = duel(['Zoma the Spirit'], ['Dark Blade']);
  const z = playTrap(e, 0, 'Zoma the Spirit')!;
  z.pos = 'atk';
  const foe = place(e, 1, 'Dark Blade')!;
  toTurn3(e);
  toBattle(e);
  attack(e, z, foe);
  check(zone(e, z) === 'gy' && zone(e, foe) === 'gy' && lp(e, 1) === 4000 - 1800, 'also when the monster that destroyed it was destroyed in the same battle');
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
console.log(`G: ${cards} cards checked, ${fixedCards.size} fixed`);
process.exit(fails ? 1 : 0);
