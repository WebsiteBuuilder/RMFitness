// Audit of the Speed Duel card scripts of batches 00 and 01 (run: npx tsx tests/audit-00.test.ts)
// One or more targeted checks per scripted card: its main effect really happens in a duel (and, where cheap, not when it should not).
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

// Cards this game's pool lacks: test-only stand-ins added to the card database.
const fake = (info: Partial<CardInfo> & { name: string }) => {
  const full = { id: 990000 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
fake({ name: 'Abyss Actor - Test Star', level: 7, atk: 2500, def: 2000, race: 'Fiend', attribute: 'DARK' });
fake({ name: 'Atlantean Test Serpent', level: 4, atk: 1600, def: 1000, race: 'Sea Serpent', attribute: 'WATER' });
const atk = (e: Engine, c: FieldCard | null | undefined) => (c ? e.atkOf(c) : -1);
const special = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'SPECIAL', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const graveFx = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'GRAVE_EFFECT', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const toGy = (e: Engine, p: Pid, name: string) => {
  const ps = e.player(p);
  const c = [...ps.hand, ...ps.deck].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.sendToGrave(c.uid, 'cost'));
  return c;
};
/** Player 1's first turn (turn 2), in the Battle Phase. */
const oppBattle = (e: Engine) => {
  endTurn(e);
  toBattle(e);
};

// ======================= batch 00 =======================
section('Book of Moon');
{
  const e = duel(['Book of Moon'], [FILL]);
  const foe = place(e, 1, FILL)!;
  playSpell(e, 0, 'Book of Moon', { pick: [FILL] });
  check(!foe.faceUp && foe.pos === 'def', 'the target is turned face-down Defense Position');
}

section('Foolish Burial');
{
  const e = duel(['Foolish Burial', 'Mystic Tomato']);
  playSpell(e, 0, 'Foolish Burial', { pick: ['Mystic Tomato'] });
  check(e.player(0).gy.some((c) => c.name === 'Mystic Tomato'), 'sends a monster from the Deck to the GY');
}

section('Reinforcement of the Army');
{
  const e = duel(['Reinforcement of the Army', 'Command Knight', 'Gaia The Fierce Knight']);
  playSpell(e, 0, 'Reinforcement of the Army', { pick: ['Command Knight'] });
  check(e.player(0).hand.some((c) => c.name === 'Command Knight'), 'adds a Level 4 or lower Warrior to the hand');
}

section('Command Knight');
{
  const e = duel(['Command Knight'], [FILL]);
  const ck = place(e, 0, 'Command Knight')!;
  check(e.legalTargets(1, place(e, 1, FILL)!).some((m) => m.uid === ck.uid), 'alone it can be attacked');
  const war = place(e, 0, FILL)!;
  check(atk(e, war) === 1800 && atk(e, ck) === 1600, 'Warriors you control gain 400 ATK');
  check(!e.legalTargets(1, e.monsters(1)[0]).some((m) => m.uid === ck.uid), 'with another monster it cannot be attacked');
}

section('Cyber Dragon');
{
  const e = duel(['Cyber Dragon'], [FILL]);
  const cd = grab(e, 0, 'Cyber Dragon');
  check(!e.canSpecialProc(0, cd), 'no Special Summon while the opponent controls no monster');
  place(e, 1, FILL);
  special(e, 0, cd);
  check(zone(e, cd) === 'mz', 'Special Summoned from the hand when only the opponent controls a monster');
}

section('Twin-Barrel Dragon');
{
  const e = duel(['Twin-Barrel Dragon'], ['Mirror Force']);
  e.roll = () => 1;
  const mf = putST(e, 1, 'Mirror Force');
  place(e, 0, 'Twin-Barrel Dragon');
  check(zone(e, mf) === 'gy', '2 Heads: destroys the targeted card');
  const e2 = duel(['Twin-Barrel Dragon'], ['Mirror Force']);
  e2.roll = () => 2;
  const mf2 = putST(e2, 1, 'Mirror Force');
  place(e2, 0, 'Twin-Barrel Dragon');
  check(zone(e2, mf2) === 'sz', 'otherwise the card stays');
}

section('Divine Wrath');
{
  const e = duel(['Bazoo the Soul-Eater', 'Gemini Elf'], ['Divine Wrath']);
  toGy(e, 0, 'Gemini Elf');
  const dw = putST(e, 1, 'Divine Wrath');
  const bazoo = place(e, 0, 'Bazoo the Soul-Eater')!;
  effect(e, 0, bazoo, { respond: 'Divine Wrath' });
  check(zone(e, dw) === 'gy' && zone(e, bazoo) === 'gy' && e.player(1).hand.length === 3, 'discard 1: negates the monster effect and destroys that monster');
  check(e.player(0).gy.some((c) => c.name === 'Gemini Elf'), 'the negated effect did not happen');
}

section('Breakthrough Skill');
{
  const e = duel(['Breakthrough Skill'], ['Command Knight', 'Command Knight']);
  place(e, 1, 'Command Knight');
  const foe = place(e, 1, FILL)!;
  check(atk(e, foe) === 1800, 'Command Knight boosts its Warriors');
  const bs = playTrap(e, 0, 'Breakthrough Skill', { pick: ['Command Knight'] });
  check(!bs && atk(e, foe) === 1400, 'negates the targeted Effect Monster until the end of the turn');
  const card = e.player(0).gy.find((c) => c.name === 'Breakthrough Skill')!;
  check(!e.canUseGraveEffect(0, card.uid), 'its GY effect cannot be used the turn it was sent there');
  toTurn3(e);
  check(atk(e, foe) === 1800, 'the negation ended with the turn');
  graveFx(e, 0, card, { pick: ['Command Knight'] });
  check(zone(e, card) === 'removed' && atk(e, foe) === 1400, 'GY: banish it to negate an Effect Monster');
}

section('Cosmic Cyclone');
{
  const e = duel(['Cosmic Cyclone'], ['Mirror Force']);
  const mf = putST(e, 1, 'Mirror Force');
  playSpell(e, 0, 'Cosmic Cyclone', { pick: ['Face-down card'] });
  check(zone(e, mf) === 'removed' && lp(e, 0) === 3000, 'from the hand: pay 1000 LP and banish the only Spell/Trap on the field');
}

section('Jar of Avarice');
{
  const e = duel(['Jar of Avarice', 'Gemini Elf', 'Mystic Tomato', 'Command Knight', 'Pot of Greed', 'Kuriboh']);
  for (const n of ['Gemini Elf', 'Mystic Tomato', 'Command Knight', 'Pot of Greed', 'Kuriboh']) toGy(e, 0, n);
  const deck = e.player(0).deck.length;
  const hand = e.player(0).hand.length;
  playTrap(e, 0, 'Jar of Avarice', { pick: ['Gemini Elf', 'Mystic Tomato', 'Command Knight', 'Pot of Greed', 'Kuriboh'] });
  check(e.player(0).gy.length === 1 && e.player(0).deck.length === deck - 1 + 5 - 1 && e.player(0).hand.length === hand + 1, 'shuffles 5 GY cards into the Deck, then draws 1');
}

section('Arcana Force XIV - Temperance');
{
  const e = duel(['Arcana Force XIV - Temperance'], ['Gemini Elf']);
  e.roll = () => 1;
  const t = place(e, 0, 'Arcana Force XIV - Temperance')!;
  check(t.tags?.coin === 1, 'tosses a coin when Summoned (Heads)');
  const fill = place(e, 0, FILL)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  oppBattle(e);
  attack(e, elf, fill);
  check(lp(e, 0) === 4000 - 250, 'Heads: battle damage you take is halved');
}
{
  const e = duel(['Arcana Force XIV - Temperance'], ['Gemini Elf']);
  e.roll = () => 2;
  place(e, 0, 'Arcana Force XIV - Temperance');
  const fill = place(e, 0, FILL)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  oppBattle(e);
  attack(e, elf, fill);
  check(lp(e, 0) === 4000 - 500, 'Tails: your own battle damage is not halved');
}
{
  const e = duel(['Arcana Force XIV - Temperance'], ['Gemini Elf']);
  grab(e, 0, 'Arcana Force XIV - Temperance');
  const elf = place(e, 1, 'Gemini Elf')!;
  oppBattle(e);
  attack(e, elf, null, { respond: 'Arcana Force XIV - Temperance' });
  check(lp(e, 0) === 4000 && e.player(0).gy.some((c) => c.name === 'Arcana Force XIV - Temperance'), 'discard it from the hand: no battle damage from that battle');
}

section('Amazoness Heirloom');
{
  const e = duel(['Amazoness Fighter', 'Amazoness Heirloom'], ['Gemini Elf']);
  const f = place(e, 0, 'Amazoness Fighter')!;
  const eq = playSpell(e, 0, 'Amazoness Heirloom', { pick: ['Amazoness Fighter'] });
  check(!!eq && eq.equippedTo === f.uid, 'equips to an "Amazoness" monster');
  const elf = place(e, 1, 'Gemini Elf')!;
  toTurn3(e);
  toBattle(e);
  attack(e, f, elf);
  check(zone(e, f) === 'mz' && zone(e, elf) === 'gy', 'the equipped monster is not destroyed by battle, and destroys the monster it attacked');
}

// ======================= batch 01: A ... Amazoness =======================
section('A Cat of Ill Omen');
{
  const e = duel(['A Cat of Ill Omen', 'Mirror Force']);
  const cat = place(e, 0, 'A Cat of Ill Omen', 'def', false)!;
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: cat.uid });
  settle(e, { pick: ['Mirror Force'] });
  check(e.player(0).deck[0]?.name === 'Mirror Force', 'FLIP: a Trap from the Deck goes on top of the Deck');
}
{
  const e = duel(['A Cat of Ill Omen', 'Mirror Force', 'Necrovalley']);
  playSpell(e, 0, 'Necrovalley');
  const cat = place(e, 0, 'A Cat of Ill Omen', 'def', false)!;
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: cat.uid });
  settle(e, 'yes');
  check(e.player(0).hand.some((c) => c.name === 'Mirror Force'), 'with Necrovalley on the field it can be added to the hand instead');
}

section('A Hero Emerges');
{
  const e = duel(['A Hero Emerges'], ['Gemini Elf']);
  putST(e, 0, 'A Hero Emerges');
  const elf = place(e, 1, 'Gemini Elf')!;
  e.rand = () => 0;
  oppBattle(e);
  attack(e, elf, null, { respond: 'A Hero Emerges' });
  check(e.state.log.some((l) => l.text.includes(`Special Summoned ${FILL}`)), 'a random monster from the hand is Special Summoned (the attack is then replayed)');
}
{
  const e = duel(['A Hero Emerges', 'Pot of Greed'], ['Gemini Elf']);
  putST(e, 0, 'A Hero Emerges');
  grab(e, 0, 'Pot of Greed');
  const elf = place(e, 1, 'Gemini Elf')!;
  e.rand = () => 0.999;
  oppBattle(e);
  attack(e, elf, null, { respond: 'A Hero Emerges' });
  check(e.player(0).gy.some((c) => c.name === 'Pot of Greed') && e.monsters(0).length === 0, 'a chosen non-monster is sent to the GY');
}

section('A Hero Lives');
{
  const e = duel(['A Hero Lives', 'Elemental HERO Clayman']);
  playSpell(e, 0, 'A Hero Lives', { pick: ['Elemental HERO Clayman'] });
  check(lp(e, 0) === 2000 && e.monsters(0).some((m) => m.name === 'Elemental HERO Clayman'), 'pay half your LP: Special Summon a Level 4 or lower "Elemental HERO" from the Deck');
  const e2 = duel(['A Hero Lives', 'Elemental HERO Clayman']);
  place(e2, 0, FILL);
  check(!e2.canActivateMain(0, grab(e2, 0, 'A Hero Lives').uid), 'not while you control a face-up monster');
}

section('A Legendary Ocean');
{
  const e = duel(['A Legendary Ocean', 'Mermail Abyssgunde', 'Mermail Abyssteus']);
  playSpell(e, 0, 'A Legendary Ocean');
  const m = place(e, 0, 'Mermail Abyssgunde')!;
  check(atk(e, m) === 1600 && e.defOf(m) === 1000, 'WATER monsters gain 200 ATK/DEF');
  check(levelOf(e, m) === 2, 'WATER monsters on the field are 1 Level lower');
  const teus = grab(e, 0, 'Mermail Abyssteus');
  check(levelOf(e, teus) === 6 && e.tributeNeed(0, teus) === 1, 'WATER monsters in the hand are 1 Level lower (a Level 7 needs 1 Tribute)');
  check(!!e.anyActive('Umi'), 'its name is treated as "Umi"');
}

section('Absolute Crusader');
{
  const e = duel(['Absolute Crusader'], ["Jack's Knight", 'Gemini Elf']);
  const ac = place(e, 0, 'Absolute Crusader')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  check(zone(e, ac) === 'mz' && zone(e, elf) === 'mz', 'a Level 4 Special Summon does not trigger it');
  const jk = place(e, 1, "Jack's Knight", 'atk', true, { respond: 'Absolute Crusader' });
  check(zone(e, ac) === 'gy' && !jk, 'Tribute it: destroy the Special Summoned Level 5 or higher monster');
}

section('Absorbing Jar');
{
  const e = duel(['Absorbing Jar', 'Pot of Greed', 'Book of Moon'], ['Mirror Force']);
  const mine = putST(e, 0, 'Pot of Greed');
  const theirs = putST(e, 1, 'Mirror Force');
  const jar = place(e, 0, 'Absorbing Jar', 'def', false)!;
  const h0 = e.player(0).hand.length;
  const h1 = e.player(1).hand.length;
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: jar.uid });
  settle(e);
  check(zone(e, mine) === 'gy' && zone(e, theirs) === 'gy', 'FLIP: destroys all Set Spells/Traps');
  check(e.player(0).hand.length === h0 + 1 && e.player(1).hand.length === h1 + 1, 'each player draws 1 for each of their cards destroyed');
  const bom = grab(e, 0, 'Book of Moon');
  check(!e.canSet(0, bom) && !e.canNormalSummon(0, grab(e, 0, FILL), false), 'you cannot Set cards this turn');
}

section('Abyss Prop - Wild Wagon');
{
  const e = duel(['Abyss Prop - Wild Wagon', 'Abyss Actor - Extras'], ['Gemini Elf']);
  const ex = place(e, 0, 'Abyss Actor - Extras')!;
  const wagon = playSpell(e, 0, 'Abyss Prop - Wild Wagon');
  check(active(e, wagon), 'activated as a Continuous Spell');
  effect(e, 0, wagon, { pick: ['Abyss Actor - Extras'] });
  (e as any).actor = 1;
  check(e.untargetable(ex), 'the targeted "Abyss Actor" cannot be targeted by the opponent');
  (e as any).actor = null;
  const elf = place(e, 1, 'Gemini Elf')!;
  oppBattle(e);
  e.monsters(0)[0].pos = 'atk';
  attack(e, elf, ex);
  check(zone(e, ex) === 'mz', 'the first time it would be destroyed by battle this turn, it is not');
  check(e.untargetable((() => ((e as any).actor = 1, ex))()), 'still untargetable during the opponent\'s turn');
  (e as any).actor = null;
}

section('Abyss Script - Rise of the Abyss King');
{
  const e = duel(['Abyss Script - Rise of the Abyss King', 'Abyss Actor - Extras'], [FILL, 'Cosmic Cyclone']);
  place(e, 0, 'Abyss Actor - Extras');
  const foe = place(e, 1, FILL)!;
  playSpell(e, 0, 'Abyss Script - Rise of the Abyss King', { pick: [FILL] });
  check(zone(e, foe) === 'gy', 'destroys face-up cards, up to the number of "Abyss Actor" monsters in Attack Position');
}
{
  const e = duel(['Abyss Script - Rise of the Abyss King', 'Abyss Actor - Test Star'], [FILL, 'Cosmic Cyclone']);
  place(e, 0, 'Abyss Actor - Test Star');
  const foe = place(e, 1, FILL)!;
  const cc = putST(e, 1, 'Cosmic Cyclone');
  const as = grab(e, 0, 'Abyss Script - Rise of the Abyss King');
  e.apply({ type: 'ACTIVATE', player: 0, uid: as.uid, zone: 0 });
  settle(e, { pick: [FILL] });
  check(zone(e, foe) === 'gy' && zone(e, cc) === 'sz' && !cc.faceUp, 'with a Level 7+ "Abyss Actor" the opponent cannot respond');
  check(e.state.fx.unchainable === undefined, 'the lock ends with the card');
}

section('Abyss Warrior');
{
  const e = duel(['Abyss Warrior', 'Mermail Abyssgunde'], ['Gemini Elf']);
  toGy(e, 1, 'Gemini Elf');
  grab(e, 0, 'Mermail Abyssgunde');
  const aw = place(e, 0, 'Abyss Warrior')!;
  effect(e, 0, aw, { pick: ['Mermail Abyssgunde'] }, { pick: ['Gemini Elf'] }, { pick: ['Bottom'] });
  const d = e.player(1).deck;
  check(e.player(0).gy.some((c) => c.name === 'Mermail Abyssgunde') && d[d.length - 1]?.name === 'Gemini Elf', 'discard a WATER monster: a monster in a GY goes to the bottom of the Deck');
}

section('Abyss-squall');
{
  const e = duel(['Abyss-squall', 'Mermail Abyssgunde', 'Mermail Abyssgunde', 'Mermail Abyssteus']);
  for (const n of ['Mermail Abyssgunde', 'Mermail Abyssgunde', 'Mermail Abyssteus']) toGy(e, 0, n);
  playTrap(e, 0, 'Abyss-squall', { pick: ['Mermail Abyssgunde', 'Mermail Abyssgunde', 'Mermail Abyssteus'] });
  const ms = e.monsters(0);
  check(ms.length === 3 && ms.every((m) => m.pos === 'def' && m.faceUp && e.isNegated(m) && m.cannotAttack), 'Special Summons 3 "Mermail" in Defense Position, negated, unable to attack');
  endTurn(e);
  check(e.monsters(0).length === 0, 'they are destroyed during the End Phase');
}

section('Adhesion Trap Hole');
{
  const e = duel(['Adhesion Trap Hole'], ['Gemini Elf']);
  putST(e, 0, 'Adhesion Trap Hole');
  endTurn(e);
  const elf = summon(e, 1, 'Gemini Elf', true, { respond: 'Adhesion Trap Hole' })!;
  check(atk(e, elf) === 950, "halves the Summoned monster's original ATK");
}

section('Advanced Ritual Art');
{
  const e = duel(['Advanced Ritual Art', 'Hungry Burger', 'Basic Insect']);
  grab(e, 0, 'Hungry Burger');
  const deck = e.player(0).deck.length;
  playSpell(e, 0, 'Advanced Ritual Art', { pick: ['Hungry Burger'] }, { pick: [FILL, 'Basic Insect'] });
  check(e.monsters(0).some((m) => m.name === 'Hungry Burger') && e.player(0).deck.length === deck - 3, 'Ritual Summons with Normal Monsters from the Deck whose Levels add up to its Level');
}

section('Aegis of Gaia');
{
  const e = duel(['Aegis of Gaia']);
  const ag = playTrap(e, 0, 'Aegis of Gaia');
  check(lp(e, 0) === 7000, 'gain 3000 LP');
  kill(e, [ag], 1);
  check(lp(e, 0) === 4000, 'when it leaves the field: take 3000 damage');
}

section('Agido');
{
  const e = duel(['Agido', 'Arcana Force III - The Empress']);
  toGy(e, 0, 'Arcana Force III - The Empress');
  const ag = place(e, 0, 'Agido')!;
  e.roll = (n: number) => (n === 6 ? 4 : 2);
  run(e, e.as(1, e.destroy([ag.uid], 'destroyed', true)), 'yes', { pick: ['Arcana Force III - The Empress'] });
  check(e.monsters(0).some((m) => m.name === 'Arcana Force III - The Empress'), 'destroyed by battle: rolls a die and revives a Fairy of that Level');
}

section('Airknight Parshath');
{
  const e = duel(['Airknight Parshath'], [FILL]);
  const ap = place(e, 0, 'Airknight Parshath')!;
  const foe = place(e, 1, FILL, 'def')!;
  toTurn3(e);
  toBattle(e);
  const hand = e.player(0).hand.length;
  attack(e, ap, foe);
  check(lp(e, 1) === 4000 - (1900 - 1200), 'piercing battle damage');
  check(e.player(0).hand.length === hand + 1, 'draws 1 card after inflicting battle damage');
}

section('Alchemist of Black Spells');
{
  const e = duel(['Alchemist of Black Spells', 'Breaker the Magical Warrior']);
  const al = place(e, 0, 'Alchemist of Black Spells')!;
  check(!e.canUseMonsterEffect(0, al), 'no card that can hold a Spell Counter: no effect (it cannot hold one itself)');
  const br = place(e, 0, 'Breaker the Magical Warrior')!;
  effect(e, 0, al, { pick: ['Breaker the Magical Warrior'] });
  check(al.pos === 'def' && br.counters === 1, 'switches to Defense Position and places a Spell Counter');
}

section('Allure of Darkness');
{
  const e = duel(['Allure of Darkness', 'Kuriboh', 'Pot of Greed']);
  playSpell(e, 0, 'Allure of Darkness', { pick: ['Kuriboh'] });
  check(e.player(0).removed.some((c) => c.name === 'Kuriboh') && e.player(0).hand.some((c) => c.name === 'Pot of Greed'), 'draw 2, then banish a DARK monster');
  const e2 = duel(['Allure of Darkness', 'Pot of Greed', 'Book of Moon']);
  playSpell(e2, 0, 'Allure of Darkness');
  check(e2.player(0).hand.length === 0, 'no DARK monster: the whole hand goes to the GY');
}

section('Ally of Justice Core Destroyer');
{
  const e = duel(['Ally of Justice Core Destroyer'], ['Mystical Elf']);
  const ac = place(e, 0, 'Ally of Justice Core Destroyer')!;
  const elf = place(e, 1, 'Mystical Elf', 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, ac, elf);
  check(zone(e, elf) === 'gy' && lp(e, 0) === 4000, 'battling a LIGHT monster: destroys it at the start of the Damage Step');
  const e2 = duel(['Ally of Justice Core Destroyer'], ['Mystical Elf']);
  const ac2 = place(e2, 0, 'Ally of Justice Core Destroyer')!;
  const elf2 = place(e2, 1, 'Mystical Elf', 'def', false)!;
  toTurn3(e2);
  toBattle(e2);
  attack(e2, ac2, elf2);
  check(zone(e2, elf2) === 'mz' && lp(e2, 0) === 4000 - 800, 'a face-down LIGHT monster is still face-down then');
}

// ======================= batch 01: Amazoness ... Archfiend =======================
section('Amazoness Archers');
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
}

section('Amazoness Call');
{
  const e = duel(['Amazoness Call', 'Amazoness Fighter']);
  playSpell(e, 0, 'Amazoness Call', { pick: ['Add to hand'] });
  check(e.player(0).hand.some((c) => c.name === 'Amazoness Fighter'), 'takes an "Amazoness" card from the Deck to the hand');
}
{
  const e = duel(['Amazoness Call', 'Amazoness Fighter'], [FILL, 'Basic Insect']);
  const f = place(e, 0, 'Amazoness Fighter')!;
  const other0 = place(e, 0, FILL)!;
  const a = place(e, 1, FILL, 'def')!;
  const b = place(e, 1, 'Basic Insect')!;
  const call = toGy(e, 0, 'Amazoness Call');
  toTurn3(e);
  graveFx(e, 0, call, { pick: ['Amazoness Fighter'] });
  check(zone(e, call) === 'removed', 'GY: banished to grant the effect');
  toBattle(e);
  check(!e.canAttackWith(0, other0), 'your other monsters cannot attack');
  attack(e, f, a);
  check(e.canAttackWith(0, f) && !e.legalTargets(0, f).some((m) => m.uid === a.uid), 'it can attack again, but not the same monster');
  attack(e, f, b);
  check(zone(e, b) === 'gy' && !e.canAttackWith(0, f), 'it attacked each of the opponent\'s monsters once');
}

section('Amazoness Chain Master');
{
  const e = duel(['Amazoness Chain Master'], [FILL]);
  const cm = place(e, 0, 'Amazoness Chain Master')!;
  run(e, e.as(1, e.destroy([cm.uid], 'destroyed', true)), 'yes');
  check(lp(e, 0) === 2500 && e.player(0).hand.some((c) => c.owner === 1), "destroyed by battle: pay 1500 LP to take a monster from the opponent's hand");
}

section('Amazoness Fighter');
{
  const e = duel(['Amazoness Fighter'], ['Gemini Elf']);
  const f = place(e, 0, 'Amazoness Fighter')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  oppBattle(e);
  attack(e, elf, f);
  check(zone(e, f) === 'gy' && lp(e, 0) === 4000, 'you take no battle damage from its battles');
}

section('Amazoness Fighting Spirit');
{
  const e = duel(['Amazoness Fighting Spirit', 'Amazoness Fighter'], ['Gemini Elf']);
  const f = place(e, 0, 'Amazoness Fighter')!;
  playSpell(e, 0, 'Amazoness Fighting Spirit');
  const elf = place(e, 1, 'Gemini Elf')!;
  check(atk(e, f) === 1500, 'no bonus outside battle');
  toTurn3(e);
  toBattle(e);
  attack(e, f, elf);
  check(zone(e, elf) === 'gy' && lp(e, 1) === 4000 - 600, 'attacking a stronger monster it gains 1000 ATK for that battle');
}

section('Amazoness Onslaught');
{
  const e = duel(['Amazoness Onslaught', 'Amazoness Fighter', 'Amazoness Paladin'], [FILL, 'Basic Insect']);
  const ons = playTrap(e, 0, 'Amazoness Onslaught');
  grab(e, 0, 'Amazoness Fighter');
  const war = place(e, 0, FILL)!;
  const ins = place(e, 1, 'Basic Insect')!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, war, ins, { respond: 'Amazoness Onslaught' }, 'no');
  const f = e.monsters(0).find((m) => m.name === 'Amazoness Fighter');
  check(!!f && atk(e, f) === 2000, 'during the Battle Phase: Special Summon an "Amazoness" from the hand, +500 ATK');
  attack(e, f!, foe, 'yes');
  check(zone(e, foe) === 'removed', "after damage calculation: banish the opponent's monster it battled");
  toGy(e, 0, 'Amazoness Paladin');
  kill(e, [ons], 1, 'yes', { pick: ['Amazoness Paladin'] });
  check(e.monsters(0).some((m) => m.name === 'Amazoness Paladin'), 'destroyed: Special Summon an "Amazoness" from the GY');
}

section('Amazoness Paladin');
{
  const e = duel(['Amazoness Paladin', 'Amazoness Fighter']);
  const p = place(e, 0, 'Amazoness Paladin')!;
  place(e, 0, 'Amazoness Fighter');
  check(atk(e, p) === 1900, 'gains 100 ATK for each "Amazoness" monster you control');
}

section('Amazoness Princess');
{
  const e = duel(['Amazoness Princess', 'Amazoness Call', FILL, 'Amazoness Fighter'], ['Gemini Elf']);
  const pr = summon(e, 0, 'Amazoness Princess', true, 'yes')!;
  check(e.player(0).hand.some((c) => c.name === 'Amazoness Call'), 'Normal Summoned: adds an "Amazoness" Spell/Trap');
  check(e.effectOn(pr)?.fieldName?.(e, pr) === 'Amazoness Queen', 'named "Amazoness Queen" on the field');
  const elf = place(e, 1, 'Gemini Elf')!;
  toTurn3(e);
  toBattle(e);
  attack(e, pr, elf, { respond: 'Amazoness Princess' }, { pick: ['Amazoness Call'] });
  const f = e.monsters(0).find((m) => m.name === 'Amazoness Fighter');
  check(!!f && f.pos === 'def' && e.player(0).gy.some((c) => c.name === 'Amazoness Call'), 'declares an attack: send a card to Special Summon an "Amazoness" from the Deck in Defense Position');
}

section('Amazoness Queen');
{
  const e = duel(['Amazoness Queen', 'Amazoness Fighter']);
  place(e, 0, 'Amazoness Queen');
  const f = place(e, 0, 'Amazoness Fighter')!;
  run(e, e.as(1, e.destroy([f.uid], 'destroyed', true)));
  check(zone(e, f) === 'mz', '"Amazoness" monsters you control cannot be destroyed by battle');
}

section('Amazoness Sage');
{
  const e = duel(['Amazoness Sage'], ['Basic Insect', 'Mirror Force']);
  const s = place(e, 0, 'Amazoness Sage')!;
  const ins = place(e, 1, 'Basic Insect')!;
  const mf = putST(e, 1, 'Mirror Force');
  toTurn3(e);
  toBattle(e);
  attack(e, s, ins);
  check(zone(e, mf) === 'gy', "after it attacks: destroys a Spell/Trap the opponent controls");
}

section('Amazoness Shamanism');
{
  const e = duel(['Amazoness Shamanism', 'Amazoness Fighter', 'Amazoness Paladin', 'Amazoness Sage']);
  place(e, 0, 'Amazoness Fighter');
  place(e, 0, 'Amazoness Paladin');
  toGy(e, 0, 'Amazoness Sage');
  playTrap(e, 0, 'Amazoness Shamanism', 'yes', { pick: ['Amazoness Sage', 'Amazoness Fighter'] });
  const ms = e.monsters(0);
  check(ms.length === 2 && ms.every((m) => m.pos === 'def') && ms.some((m) => m.name === 'Amazoness Sage'), 'destroys your face-up "Amazoness", then revives that many Level 4 or lower in Defense Position');
}

section('Amazoness Spellcaster');
{
  const e = duel(['Amazoness Spellcaster', 'Amazoness Fighter'], ['Gemini Elf']);
  const f = place(e, 0, 'Amazoness Fighter')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  playSpell(e, 0, 'Amazoness Spellcaster', { pick: ['Amazoness Fighter'] }, { pick: ['Gemini Elf'] });
  check(atk(e, f) === 1900 && atk(e, elf) === 1500, 'switches the original ATK');
  endTurn(e);
  check(atk(e, f) === 1500 && atk(e, elf) === 1900, 'until the end of the turn');
}

section('Amazoness Spy');
{
  const e = duel(['Amazoness Spy', 'Amazoness Fighter', 'Amazoness Paladin']);
  const spy = grab(e, 0, 'Amazoness Spy');
  grab(e, 0, 'Amazoness Fighter');
  special(e, 0, spy, { pick: ['Amazoness Fighter'] });
  check(zone(e, spy) === 'mz', 'reveal another "Amazoness": Special Summon it from the hand');
  toGy(e, 0, 'Amazoness Paladin');
  run(e, e.as(1, e.destroy([spy.uid], 'destroyed', true)), 'yes', { pick: ['Hand'] });
  check(e.player(0).hand.some((c) => c.name === 'Amazoness Paladin'), 'destroyed by battle: an "Amazoness" in the GY returns to the hand');
}

section('Amazoness Swords Woman');
{
  const e = duel(['Amazoness Swords Woman'], ['Gemini Elf']);
  const sw = place(e, 0, 'Amazoness Swords Woman')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  oppBattle(e);
  attack(e, elf, sw);
  check(lp(e, 0) === 4000 && lp(e, 1) === 4000 - 400, 'the opponent takes the battle damage you would have taken');
}

section('Amazoness Trainee');
{
  const e = duel(['Amazoness Trainee'], ['Basic Insect']);
  const t = place(e, 0, 'Amazoness Trainee')!;
  const ins = place(e, 1, 'Basic Insect')!;
  toTurn3(e);
  toBattle(e);
  attack(e, t, ins);
  const d = e.player(1).deck;
  check(d[d.length - 1]?.uid === ins.uid && !e.player(1).gy.some((c) => c.uid === ins.uid), 'the destroyed monster goes to the bottom of the Deck, not the GY');
  check(atk(e, t) === 1700, 'it gains 200 ATK');
}

section('Amazoness Village');
{
  const e = duel(['Amazoness Village', 'Amazoness Fighter', 'Amazoness Sage', 'Amazoness Queen']);
  playSpell(e, 0, 'Amazoness Village');
  const f = place(e, 0, 'Amazoness Fighter')!;
  check(atk(e, f) === 1700, '"Amazoness" monsters gain 200 ATK');
  kill(e, [f], 1, 'yes', { pick: ['Amazoness Sage'] });
  check(e.monsters(0).some((m) => m.name === 'Amazoness Sage') && !e.monsters(0).some((m) => m.name === 'Amazoness Queen'), 'destroyed by a card effect: Special Summon an "Amazoness" with an equal or lower Level from the Deck');
  const s = e.monsters(0)[0];
  kill(e, [s], 1, 'yes');
  check(e.monsters(0).length === 0, 'only once per turn');
}

section('Amazoness Willpower');
{
  const e = duel(['Amazoness Willpower', 'Amazoness Fighter']);
  toGy(e, 0, 'Amazoness Fighter');
  const wp = playTrap(e, 0, 'Amazoness Willpower', { pick: ['Amazoness Fighter'] });
  const f = e.monsters(0).find((m) => m.name === 'Amazoness Fighter');
  check(!!f && f.pos === 'atk' && f.cannotChangePos === true, 'Special Summons an "Amazoness" from the GY in Attack Position; it cannot change position');
  kill(e, [wp], 1);
  check(zone(e, f) === 'gy', 'when this card leaves the field, that monster is destroyed');
}

section('Ambulance Rescueroid');
{
  const e = duel([], ['Gemini Elf'], ['Ambulance Rescueroid']);
  const ar = place(e, 0, 'Ambulance Rescueroid')!;
  const fill = place(e, 0, FILL)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  oppBattle(e);
  attack(e, elf, fill, { respond: 'Ambulance Rescueroid' });
  check(zone(e, fill) === 'mz' && fill.uid === e.monsters(0).find((m) => m.name === FILL)?.uid && e.fieldCard(fill.uid)?.pos === 'def', 'a monster you control destroyed by battle comes back in Defense Position');
  run(e, e.sendToGrave(ar.uid, 'used'));
  check(e.summonBlocked(0, ar, 'special', 'gy'), 'cannot be Special Summoned except by Fusion Summon');
}

section('Amulet of Ambition');
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
  check(e.player(0).deck[0]?.uid === am?.uid, 'sent to the GY: it can go on top of the Deck');
}

section('Anarchist Monk Ranshin');
{
  const e = duel(['Anarchist Monk Ranshin'], ['Gemini Elf']);
  const r = place(e, 0, 'Anarchist Monk Ranshin')!;
  const g = toGy(e, 1, 'Gemini Elf');
  kill(e, [r], 0);
  check(zone(e, g) === 'gy', 'destroyed by your own card: nothing happens');
  const e2 = duel(['Anarchist Monk Ranshin'], ['Gemini Elf']);
  const r2 = place(e2, 0, 'Anarchist Monk Ranshin')!;
  const g2 = toGy(e2, 1, 'Gemini Elf');
  kill(e2, [r2], 1);
  check(zone(e2, g2) === 'removed', "sent to the GY by the opponent's card: banishes a monster from their GY");
}

section('Ancient Dragon');
{
  const e = duel(['Ancient Dragon']);
  const d = place(e, 0, 'Ancient Dragon')!;
  toTurn3(e);
  toBattle(e);
  attack(e, d, null, 'yes');
  check(levelOf(e, d) === 5 && atk(e, d) === 1900, 'direct attack damage: Level +1 and ATK +500');
}

section('Ancient Gear');
{
  const e = duel(['Ancient Gear', 'Ancient Gear']);
  const a = grab(e, 0, 'Ancient Gear');
  check(!e.canSpecialProc(0, a), 'needs an "Ancient Gear" on the field');
  place(e, 0, 'Ancient Gear');
  special(e, 0, a);
  check(e.fieldCard(a.uid)?.pos === 'atk', 'Special Summoned from the hand in Attack Position');
}

section('Ancient Lamp');
{
  const e = duel(['Ancient Lamp', 'La Jinn the Mystical Genie of the Lamp']);
  const l = place(e, 0, 'Ancient Lamp')!;
  grab(e, 0, 'La Jinn the Mystical Genie of the Lamp');
  effect(e, 0, l);
  check(e.monsters(0).some((m) => m.name === 'La Jinn the Mystical Genie of the Lamp'), 'Special Summons La Jinn from the hand');
}
{
  const e = duel(['Ancient Lamp'], ['Gemini Elf', 'Basic Insect']);
  const l = place(e, 0, 'Ancient Lamp', 'def', false)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  const ins = place(e, 1, 'Basic Insect')!;
  oppBattle(e);
  attack(e, elf, l, 'yes', { pick: ['Basic Insect'] });
  check(zone(e, l) === 'mz' && l.faceUp && zone(e, ins) === 'gy' && lp(e, 1) === 4000 - 1400 && lp(e, 0) === 4000, 'attacked while face-down: the attacker attacks another of its controller\'s monsters instead');
}

section('Angel O1');
{
  const e = duel(['Angel O1', 'Gaia The Fierce Knight', FILL]);
  const a = grab(e, 0, 'Angel O1');
  const g = grab(e, 0, 'Gaia The Fierce Knight');
  special(e, 0, a, { pick: ['Gaia The Fierce Knight'] });
  check(zone(e, a) === 'mz', 'reveal a Level 7 or higher monster: Special Summon it from the hand');
  const f = grab(e, 0, FILL);
  e.apply({ type: 'SUMMON', player: 0, uid: f.uid, zone: e.player(0).mz.findIndex((z) => z === null), pos: 'atk', faceUp: true });
  settle(e);
  check(e.player(0).normalSummoned && e.canNormalSummon(0, g), 'after the Normal Summon, a Level 7 or higher can still be Tribute Summoned');
  e.apply({ type: 'SUMMON', player: 0, uid: g.uid, zone: 0, pos: 'atk', faceUp: true });
  settle(e, { pick: ['Angel O1', FILL] });
  check(zone(e, g) === 'mz', 'that additional Tribute Summon works');
}

section('Animadorned Archosaur');
{
  const e = duel(['Animadorned Archosaur', 'Gilasaurus', 'Big Evolution Pill']);
  grab(e, 0, 'Gilasaurus');
  place(e, 0, 'Animadorned Archosaur', 'atk', true, 'yes');
  check(e.player(0).gy.some((c) => c.name === 'Gilasaurus') && e.player(0).hand.some((c) => c.name === 'Big Evolution Pill'), 'Summoned: destroy a Dinosaur in the hand, then add an "Evolution Pill" Spell');
}

section('Annihilator Archfiend');
{
  const e = duel(['Annihilator Archfiend', 'Archfiend Soldier'], [FILL]);
  const an = place(e, 0, 'Annihilator Archfiend')!;
  const so = place(e, 0, 'Archfiend Soldier')!;
  const foe = place(e, 1, FILL)!;
  effect(e, 0, an, { pick: ['Archfiend Soldier'] }, { pick: [FILL] });
  check(zone(e, so) === 'gy' && zone(e, foe) === 'gy' && atk(e, an) === 2000 + 950, 'destroys 1 card of each player; gains half a destroyed Fiend\'s original ATK');
}

section('Apprentice Magician');
{
  const e = duel(['Apprentice Magician', 'Breaker the Magical Warrior', 'Old Vindictive Magician']);
  const br = place(e, 0, 'Breaker the Magical Warrior')!;
  const ap = place(e, 0, 'Apprentice Magician')!;
  check(br.counters === 1, 'Summoned: places a Spell Counter on a card that can hold one');
  run(e, e.as(1, e.destroy([ap.uid], 'destroyed', true)), 'yes');
  const ov = e.monsters(0).find((m) => m.name === 'Old Vindictive Magician');
  check(!!ov && !ov.faceUp && ov.pos === 'def', 'destroyed by battle: a Level 2 or lower Spellcaster from the Deck in face-down Defense Position');
}

section('Aqua Spirit');
{
  const e = duel(['Aqua Spirit', 'Mermail Abyssgunde'], [FILL]);
  const aq = grab(e, 0, 'Aqua Spirit');
  check(!e.canNormalSummon(0, aq), 'cannot be Normal Summoned');
  const w = toGy(e, 0, 'Mermail Abyssgunde');
  special(e, 0, aq);
  check(zone(e, aq) === 'mz' && zone(e, w) === 'removed', 'Special Summoned by banishing a WATER monster from the GY');
  const foe = place(e, 1, FILL)!;
  endTurn(e, 'yes');
  check(foe.pos === 'def' && !e.canChangePosition(1, foe), "the opponent's Standby Phase: changes a monster's position, locked for the turn");
}

section('Arcana Force 0 - The Fool');
{
  const e = duel(['Arcana Force 0 - The Fool'], ['Book of Moon']);
  e.roll = () => 2;
  putST(e, 1, 'Book of Moon');
  const fool = place(e, 0, 'Arcana Force 0 - The Fool', 'atk', true, { respond: 'Book of Moon' }, { pick: ['Arcana Force 0 - The Fool'] })!;
  check(fool.tags?.coin === 2, 'tosses a coin when Summoned');
  check(fool.faceUp && e.player(1).gy.some((c) => c.name === 'Book of Moon'), "Tails: the opponent's effect targeting it is negated and destroyed");
  check(e.shielded(fool, 'battle') && !e.canChangePosition(0, fool), 'cannot be destroyed by battle or changed to Defense Position');
}

section('Arcana Force EX - The Light Ruler');
{
  const e = duel(['Arcana Force EX - The Light Ruler'], ['Book of Moon']);
  e.roll = () => 2;
  for (let i = 0; i < 3; i++) place(e, 0, FILL);
  const lr = grab(e, 0, 'Arcana Force EX - The Light Ruler');
  check(!e.canNormalSummon(0, lr), 'cannot be Normal Summoned');
  special(e, 0, lr);
  const m = e.fieldCard(lr.uid);
  check(!!m && e.player(0).gy.length === 3 && m.tags?.coin === 2, 'Special Summoned by sending 3 monsters to the GY; tosses a coin');
  putST(e, 1, 'Book of Moon');
  endTurn(e);
  const bom = e.player(1).sz.find((c) => c?.name === 'Book of Moon')!;
  act(e, 1, bom.uid, { pick: ['Arcana Force EX - The Light Ruler'] });
  check(m!.faceUp && atk(e, m) === 3000 && zone(e, bom) === 'gy', 'Tails: an effect targeting it is negated and destroyed; it loses 1000 ATK');
  run(e, e.sendToGrave(lr.uid, 'used'));
  check(e.summonBlocked(0, lr, 'special', 'gy'), 'cannot be Special Summoned other ways');
}

section('Arcana Force III - The Empress');
{
  const e = duel(['Arcana Force III - The Empress', 'Arcana Force IV - The Emperor'], [FILL]);
  e.roll = () => 1;
  place(e, 0, 'Arcana Force III - The Empress');
  grab(e, 0, 'Arcana Force IV - The Emperor');
  endTurn(e);
  summon(e, 1, FILL, false, 'yes');
  check(e.monsters(0).some((m) => m.name === 'Arcana Force IV - The Emperor'), 'Heads: when the opponent Sets a monster, Special Summon an "Arcana Force" from the hand');
}
{
  const e = duel(['Arcana Force III - The Empress'], [FILL]);
  e.roll = () => 2;
  place(e, 0, 'Arcana Force III - The Empress');
  endTurn(e);
  const hand = e.player(0).hand.length;
  summon(e, 1, FILL, true);
  check(e.player(0).hand.length === hand - 1, 'Tails: when the opponent Normal Summons, send a card from your hand to the GY');
}

section('Arcana Force IV - The Emperor');
{
  const e = duel(['Arcana Force IV - The Emperor']);
  e.roll = () => 1;
  const m = place(e, 0, 'Arcana Force IV - The Emperor')!;
  check(atk(e, m) === 1900, 'Heads: "Arcana Force" monsters you control gain 500 ATK');
  const e2 = duel(['Arcana Force IV - The Emperor']);
  e2.roll = () => 2;
  const m2 = place(e2, 0, 'Arcana Force IV - The Emperor')!;
  check(atk(e2, m2) === 900, 'Tails: they lose 500 ATK');
}

section('Arcana Force VII - The Chariot');
{
  const e = duel(['Arcana Force VII - The Chariot'], ['Basic Insect']);
  e.roll = () => 1;
  const ch = place(e, 0, 'Arcana Force VII - The Chariot')!;
  const ins = place(e, 1, 'Basic Insect')!;
  toTurn3(e);
  toBattle(e);
  attack(e, ch, ins, 'yes');
  check(e.controller(ins.uid) === 0, 'Heads: a monster it destroys by battle is Special Summoned to your field');
  const e2 = duel(['Arcana Force VII - The Chariot']);
  e2.roll = () => 2;
  const ch2 = place(e2, 0, 'Arcana Force VII - The Chariot')!;
  check(e2.controller(ch2.uid) === 1, 'Tails: the opponent gains control of it');
}

section('Arcana Force XVIII - The Moon');
{
  const e = duel(['Arcana Force XVIII - The Moon']);
  e.roll = () => 1;
  place(e, 0, 'Arcana Force XVIII - The Moon');
  endTurn(e);
  endTurn(e, 'yes');
  check(e.monsters(0).some((m) => m.name === 'Moon Token'), 'Heads: your Standby Phase: Special Summon a "Moon Token"');
  const e2 = duel(['Arcana Force XVIII - The Moon']);
  e2.roll = () => 2;
  const moon = place(e2, 0, 'Arcana Force XVIII - The Moon')!;
  endTurn(e2);
  check(e2.controller(moon.uid) === 1, 'Tails: your End Phase: give control of a monster to the opponent');
}

section('Arcana Knight Joker');
{
  const e = duel(['Pot of Greed'], ['Book of Moon'], ['Arcana Knight Joker']);
  const j = place(e, 0, 'Arcana Knight Joker')!;
  grab(e, 0, 'Pot of Greed');
  const bom = putST(e, 1, 'Book of Moon');
  endTurn(e);
  act(e, 1, bom.uid, { pick: ['Arcana Knight Joker'] }, { respond: 'Arcana Knight Joker' }, { pick: ['Pot of Greed'] });
  check(j.faceUp && e.player(0).gy.some((c) => c.name === 'Pot of Greed'), 'discard a card of the same type: negates an effect targeting it');
}

section('Arcana Reading');
{
  const e = duel(['Arcana Reading', 'Twin-Barrel Dragon']);
  e.roll = () => 1;
  playSpell(e, 0, 'Arcana Reading', { pick: ['Twin-Barrel Dragon'] });
  check(e.player(0).hand.some((c) => c.name === 'Twin-Barrel Dragon'), 'Heads: add a coin-tossing card from the Deck');
  const e2 = duel(['Arcana Reading']);
  e2.roll = () => 2;
  const h1 = e2.player(1).hand.length;
  playSpell(e2, 0, 'Arcana Reading');
  check(e2.player(1).hand.length === h1 + 1, 'Tails: the opponent adds a card from their Deck');
}
{
  const e = duel(['Arcana Reading', 'Arcana Force IV - The Emperor']);
  e.roll = () => 1;
  const ar = toGy(e, 0, 'Arcana Reading');
  const em = grab(e, 0, 'Arcana Force IV - The Emperor');
  summon(e, 0, FILL);
  graveFx(e, 0, ar, { pick: ['Arcana Force IV - The Emperor'] });
  check(zone(e, ar) === 'removed' && zone(e, em) === 'mz', 'GY: banish it to Normal Summon an "Arcana Force" monster (after the usual Normal Summon)');
}

section('Arcana Triumph Joker');
{
  const e = duel(['Arcana Triumph Joker', "Queen's Knight", "King's Knight", "Jack's Knight", 'Pot of Greed'], [FILL]);
  const j = grab(e, 0, 'Arcana Triumph Joker');
  for (const n of ["Queen's Knight", "King's Knight", "Jack's Knight"]) grab(e, 0, n);
  special(e, 0, j);
  const m = e.fieldCard(j.uid);
  check(!!m && ["Queen's Knight", "King's Knight", "Jack's Knight"].every((n) => e.player(0).gy.some((c) => c.name === n)), 'send the 3 Knights: Special Summon it');
  const hands = e.player(0).hand.length + e.player(1).hand.length;
  check(atk(e, m) === 500 * hands, 'gains 500 ATK for each card in both hands');
  const foe = place(e, 1, FILL)!;
  effect(e, 0, m, { pick: [FILL] });
  check(zone(e, foe) === 'gy', 'discard a monster: destroys the face-up monsters the opponent controls');
}

section('Archfiend General');
{
  const e = duel(['Archfiend General', 'Pandemonium', 'Archfiend General']);
  const g = grab(e, 0, 'Archfiend General');
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: g.uid });
  settle(e);
  check(zone(e, g) === 'gy' && e.player(0).hand.some((c) => c.name === 'Pandemonium'), 'discard it: add "Pandemonium" from the Deck');
  const g2 = place(e, 0, 'Archfiend General');
  check(!g2, 'without "Pandemonium" on the field it is destroyed');
  playSpell(e, 0, 'Pandemonium');
  run(e, e.specialSummon(g.uid, 0, 'atk'));
  check(zone(e, g) === 'mz', 'with "Pandemonium" it stays');
}

section('Archfiend of Gilfer');
{
  const e = duel(['Archfiend of Gilfer'], ['Gemini Elf']);
  const gi = place(e, 0, 'Archfiend of Gilfer')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  kill(e, [gi], 1, 'yes');
  check(zone(e, gi) === 'sz' && elf.equips.includes(gi.uid) && atk(e, elf) === 1400, 'sent to the GY: equips to a monster, which loses 500 ATK');
}

section("Archfiend's Oath");
{
  const e = duel(["Archfiend's Oath", 'Pot of Greed']);
  const o = playSpell(e, 0, "Archfiend's Oath");
  effect(e, 0, o, { pick: ['Pot of Greed'] });
  check(lp(e, 0) === 3500 && e.player(0).hand.some((c) => c.name === 'Pot of Greed'), 'pay 500 LP and declare a card: the right top card goes to the hand');
  check(!e.canUseMonsterEffect(0, o!), 'once per turn');
}

section("Archfiend's Roar");
{
  const e = duel(["Archfiend's Roar", 'Archfiend Soldier']);
  toGy(e, 0, 'Archfiend Soldier');
  playTrap(e, 0, "Archfiend's Roar", { pick: ['Archfiend Soldier'] });
  const s = e.monsters(0).find((m) => m.name === 'Archfiend Soldier');
  check(!!s && lp(e, 0) === 3500, 'pay 500 LP: Special Summon an "Archfiend" from the GY');
  check(!!s && e.untributable(s), 'it cannot be Tributed');
  endTurn(e);
  check(!!s && zone(e, s) === 'gy', 'destroyed during the End Phase');
}

// ======================= batch 01: Armed Dragon ... Berfomet =======================
section('Armed Dragon LV10');
{
  const e = duel(['Armed Dragon LV10', 'Armed Dragon LV7', 'Pot of Greed'], [FILL, 'Gemini Elf']);
  const lv10 = grab(e, 0, 'Armed Dragon LV10');
  check(!e.canNormalSummon(0, lv10) && !e.canSpecialProc(0, lv10), 'cannot be Normal Summoned; needs "Armed Dragon LV7"');
  place(e, 0, 'Armed Dragon LV7');
  special(e, 0, lv10);
  const m = e.fieldCard(lv10.uid);
  check(!!m && e.player(0).gy.some((c) => c.name === 'Armed Dragon LV7'), 'Special Summoned by Tributing "Armed Dragon LV7"');
  const a = place(e, 1, FILL)!;
  const b = place(e, 1, 'Gemini Elf')!;
  grab(e, 0, 'Pot of Greed');
  effect(e, 0, m, { pick: ['Pot of Greed'] });
  check(zone(e, a) === 'gy' && zone(e, b) === 'gy', 'send a card from the hand: destroys all face-up monsters the opponent controls');
}

section('Armed Dragon LV10 White');
{
  const e = duel(['Armed Dragon LV10 White', 'Armed Dragon LV3', 'Armed Dragon LV7'], [FILL]);
  toGy(e, 0, 'Armed Dragon LV3');
  toGy(e, 0, 'Armed Dragon LV7');
  const w = grab(e, 0, 'Armed Dragon LV10 White');
  check(!e.canNormalSummon(0, w), 'cannot be Normal Summoned');
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: w.uid });
  settle(e, { pick: ['Armed Dragon LV3', 'Armed Dragon LV7'] });
  const m = e.fieldCard(w.uid);
  check(!!m && e.player(0).removed.length === 2, 'banish "Armed Dragon" monsters with total Level 10: Special Summon it from the hand');
  run(e, e.as(1, (function* () {
    e.damage(0, 500);
  })()));
  check(lp(e, 0) === 4000, 'you take no effect damage');
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, m, foe, 'yes', { pick: [FILL] });
  check(zone(e, foe) === 'gy' && lp(e, 1) === 4000, 'when it attacks, at the start of the Damage Step: destroy a card on the field');
  run(e, e.sendToGrave(w.uid, 'used'));
  check(e.summonBlocked(0, w, 'special', 'gy'), 'it can only be Special Summoned by its own effect');
}

section('Armed Dragon LV3');
{
  const e = duel(['Armed Dragon LV3', 'Armed Dragon LV5']);
  const lv3 = place(e, 0, 'Armed Dragon LV3')!;
  endTurn(e);
  endTurn(e, 'yes');
  check(zone(e, lv3) === 'gy' && e.monsters(0).some((m) => m.name === 'Armed Dragon LV5'), 'your Standby Phase: send it to the GY to Special Summon "Armed Dragon LV5" from the Deck');
}

section('Armed Dragon LV5');
{
  const e = duel(['Armed Dragon LV5', 'Gemini Elf'], [FILL, 'Gaia The Fierce Knight']);
  const lv5 = place(e, 0, 'Armed Dragon LV5')!;
  const a = place(e, 1, FILL)!;
  const g = place(e, 1, 'Gaia The Fierce Knight')!;
  grab(e, 0, 'Gemini Elf');
  effect(e, 0, lv5, { pick: ['Gemini Elf'] });
  check(zone(e, a) === 'gy' && zone(e, g) === 'mz', 'send a monster from the hand: destroy a monster with ATK up to its ATK');
}
{
  const e = duel(['Armed Dragon LV5', FILL, 'Armed Dragon LV7'], ['Basic Insect']);
  const lv5 = place(e, 0, 'Armed Dragon LV5')!;
  const ins = place(e, 1, 'Basic Insect')!;
  toTurn3(e);
  toBattle(e);
  attack(e, lv5, ins);
  endTurn(e, 'yes');
  check(zone(e, lv5) === 'gy' && e.monsters(0).some((m) => m.name === 'Armed Dragon LV7'), 'End Phase after destroying a monster by battle: becomes "Armed Dragon LV7"');
}

section('Armed Dragon LV7');
{
  const e = duel(['Armed Dragon LV7', 'Gemini Elf'], [FILL, 'Basic Insect', 'Gaia The Fierce Knight']);
  const lv7 = grab(e, 0, 'Armed Dragon LV7');
  check(!e.canNormalSummon(0, lv7), 'cannot be Normal Summoned');
  const m = place(e, 0, 'Armed Dragon LV7')!;
  const a = place(e, 1, FILL)!;
  const b = place(e, 1, 'Basic Insect')!;
  const g = place(e, 1, 'Gaia The Fierce Knight')!;
  grab(e, 0, 'Gemini Elf');
  effect(e, 0, m, { pick: ['Gemini Elf'] });
  check(zone(e, a) === 'gy' && zone(e, b) === 'gy' && zone(e, g) === 'mz', "send a monster from the hand: destroy every opponent's monster with ATK up to its ATK");
}

section('Assault on GHQ');
{
  const e = duel(['Assault on GHQ']);
  const f = place(e, 0, FILL)!;
  const deck = e.player(1).deck.length;
  playTrap(e, 0, 'Assault on GHQ', { pick: [FILL] });
  check(zone(e, f) === 'gy' && e.player(1).deck.length === deck - 2 && e.player(1).gy.length === 2, "destroy your monster, then send the top 2 cards of the opponent's Deck to the GY");
}

section('Asura Priest');
{
  const e = duel(['Asura Priest'], [FILL, 'Basic Insect']);
  const a = grab(e, 0, 'Asura Priest');
  check(e.summonBlocked(0, a, 'special', 'hand'), 'cannot be Special Summoned');
  const m = summon(e, 0, 'Asura Priest')!;
  endTurn(e);
  check(zone(e, a) === 'hand', 'returns to the hand in the End Phase of the turn it was Normal Summoned');
  const x = place(e, 1, FILL)!;
  const y = place(e, 1, 'Basic Insect')!;
  endTurn(e);
  const m2 = summon(e, 0, 'Asura Priest')!;
  void m;
  m2.placedTurn = -1;
  toBattle(e);
  attack(e, m2, y);
  attack(e, m2, x);
  check(zone(e, y) === 'gy' && zone(e, x) === 'gy', 'it attacks each of the opponent\'s monsters once');
}
{
  const e = duel(['Asura Priest'], ['Basic Insect']);
  const a = place(e, 0, FILL)!;
  void a;
  const ap = grab(e, 0, 'Asura Priest');
  e.apply({ type: 'SUMMON', player: 0, uid: ap.uid, zone: 1, pos: 'def', faceUp: false });
  settle(e);
  const elf = place(e, 1, 'Basic Insect')!;
  oppBattle(e);
  attack(e, elf, e.fieldCard(ap.uid));
  endTurn(e);
  check(zone(e, ap) === 'hand', 'flipped face-up by an attack: returns to the hand in that End Phase');
}

section('Atlantean Marksman');
{
  const e = duel(['Atlantean Marksman', FILL, 'Atlantean Test Serpent'], ['Basic Insect']);
  const am = place(e, 0, 'Atlantean Marksman')!;
  const ins = place(e, 1, 'Basic Insect')!;
  toTurn3(e);
  toBattle(e);
  attack(e, am, ins, 'yes');
  check(e.monsters(0).some((m) => m.name === 'Atlantean Test Serpent'), 'battle damage: Special Summon a Level 4 or lower "Atlantean" Sea Serpent from the Deck');
}
{
  const e = duel(['Atlantean Marksman', 'Abyss Warrior', 'Gemini Elf'], ['Mirror Force']);
  const mf = putST(e, 1, 'Mirror Force');
  toGy(e, 0, 'Gemini Elf');
  grab(e, 0, 'Atlantean Marksman');
  const aw = place(e, 0, 'Abyss Warrior')!;
  effect(e, 0, aw, { pick: ['Atlantean Marksman'] }, { pick: ['Gemini Elf'] }, { pick: ['Top'] });
  check(zone(e, mf) === 'gy', 'sent to the GY for a WATER monster\'s effect: destroys a Set card the opponent controls');
}

section('Babycerasaurus');
{
  const e = duel(['Babycerasaurus', 'Gilasaurus']);
  const b = place(e, 0, 'Babycerasaurus')!;
  kill(e, [b], 1);
  check(e.monsters(0).some((m) => m.name === 'Gilasaurus'), 'destroyed by a card effect: Special Summon a Level 4 or lower Dinosaur from the Deck');
  const e2 = duel(['Babycerasaurus', 'Gilasaurus']);
  const b2 = place(e2, 0, 'Babycerasaurus')!;
  run(e2, e2.as(1, e2.destroy([b2.uid], 'destroyed', true)));
  check(e2.monsters(0).length === 0, 'not when destroyed by battle');
}

section('Backup Squad');
{
  const e = duel(['Backup Squad'], ['Gemini Elf']);
  playSpell(e, 0, 'Backup Squad');
  const elf = place(e, 1, 'Gemini Elf')!;
  oppBattle(e);
  const hand = e.player(0).hand.length;
  attack(e, elf, null, { respond: 'Backup Squad' });
  check(lp(e, 0) === 2100 && e.player(0).hand.length === hand + 1, "taking 1000 or more damage from the opponent's attack: draw 1 for every 1000");
}

section('Banishment of the Darklords');
{
  const e = duel(['Banishment of the Darklords', 'Darklord Nasten', 'Banishment of the Darklords', 'Darklord Contact']);
  playSpell(e, 0, 'Banishment of the Darklords', { pick: ['Darklord Nasten'] });
  check(e.player(0).hand.some((c) => c.name === 'Darklord Nasten'), 'adds a "Darklord" card from the Deck');
  check(!e.canActivateMain(0, grab(e, 0, 'Banishment of the Darklords').uid), 'only 1 per turn');
}

section('Bark of Dark Ruler');
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

section('Battleguard Rage');
{
  const e = duel(['Battleguard Rage'], ['Gemini Elf']);
  const f = place(e, 0, FILL)!;
  const br = playTrap(e, 0, 'Battleguard Rage', { pick: [FILL] });
  check(atk(e, f) === 2400, 'the Warrior gains 1000 ATK');
  const elf = place(e, 1, 'Gemini Elf')!;
  toTurn3(e);
  toBattle(e);
  attack(e, f, elf);
  check(zone(e, elf) === 'hand', 'a monster it destroys by battle goes back to the hand');
  kill(e, [f], 1);
  check(zone(e, br) === 'gy', 'when the monster leaves the field, this card is destroyed');
}

section('Bazoo the Soul-Eater');
{
  const e = duel(['Bazoo the Soul-Eater', 'Gemini Elf', 'Mystic Tomato']);
  toGy(e, 0, 'Gemini Elf');
  toGy(e, 0, 'Mystic Tomato');
  const bz = place(e, 0, 'Bazoo the Soul-Eater')!;
  effect(e, 0, bz, { pick: ['Gemini Elf', 'Mystic Tomato'] });
  check(atk(e, bz) === 2200 && e.player(0).removed.length === 2, 'banish up to 3 monsters from the GY: +300 ATK each');
  endTurn(e);
  check(atk(e, bz) === 2200, "until the end of the opponent's turn");
  endTurn(e);
  check(atk(e, bz) === 1600, 'then it ends');
}

section('Bee List Soldier');
{
  const e = duel(['Bee List Soldier', 'Big Insect']);
  const b = place(e, 0, 'Bee List Soldier')!;
  const i = place(e, 0, 'Big Insect')!;
  const hand = e.player(0).hand.length;
  effect(e, 0, b);
  check(zone(e, b) === 'gy' && zone(e, i) === 'gy' && e.player(0).hand.length === hand + 2, 'Tribute it and another Insect: draw 2');
}

section('Beetron');
{
  const e = duel(['Beetron', 'Big Insect', "Archfiend's Oath"]);
  toGy(e, 0, 'Big Insect');
  const o = playSpell(e, 0, "Archfiend's Oath");
  const bt = place(e, 0, 'Beetron')!;
  effect(e, 0, bt);
  const bi = e.monsters(0).find((m) => m.name === 'Big Insect');
  check(zone(e, o) === 'gy' && !!bi && bi.pos === 'def', 'send a face-up Spell/Trap to the GY: Special Summon a Level 4 or lower Insect from the GY in Defense Position');
}

section('Behemoth the King of All Animals');
{
  const e = duel(['Behemoth the King of All Animals', 'Gazelle the King of Mythical Beasts', 'Big Insect']);
  toGy(e, 0, 'Gazelle the King of Mythical Beasts');
  place(e, 0, FILL);
  const b = grab(e, 0, 'Behemoth the King of All Animals');
  check(e.canNormalSummon(0, b), 'can be Normal Summoned with 1 Tribute');
  e.apply({ type: 'SUMMON', player: 0, uid: b.uid, zone: 1, pos: 'atk', faceUp: true });
  settle(e, 'yes');
  const m = e.fieldCard(b.uid);
  check(!!m && atk(e, m) === 2000, 'with 1 Tribute its original ATK becomes 2000');
  check(e.player(0).hand.some((c) => c.name === 'Gazelle the King of Mythical Beasts'), 'Tribute Summoned: returns as many Beasts from the GY to the hand as it Tributed');
}
{
  const e = duel(['Behemoth the King of All Animals']);
  place(e, 0, FILL);
  place(e, 0, FILL);
  const b = grab(e, 0, 'Behemoth the King of All Animals');
  e.apply({ type: 'SUMMON', player: 0, uid: b.uid, zone: 2, pos: 'atk', faceUp: true });
  settle(e);
  const m = e.fieldCard(b.uid);
  check(!!m && atk(e, m) === 2700 && e.monsters(0).length === 1, 'with 2 Tributes it keeps 2700 ATK');
}

section('Berfomet');
{
  const e = duel(['Berfomet', 'Gazelle the King of Mythical Beasts']);
  summon(e, 0, FILL);
  e.player(0).normalSummoned = false;
  const b = grab(e, 0, 'Berfomet');
  e.apply({ type: 'SUMMON', player: 0, uid: b.uid, zone: 1, pos: 'atk', faceUp: true });
  settle(e, { pick: [FILL] }, 'yes');
  check(e.player(0).hand.some((c) => c.name === 'Gazelle the King of Mythical Beasts'), 'Normal Summoned: adds "Gazelle the King of Mythical Beasts" from the Deck');
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
if (fails) process.exit(1);
