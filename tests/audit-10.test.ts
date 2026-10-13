// Audit of the Speed Duel card scripts of batch 10 (run: npx tsx tests/audit-10.test.ts)
// One or more targeted checks per scripted card: its main effect really happens in a duel (and, where cheap, that it does not when it should not).
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

// ======================= Spells / Traps / Monsters, in batch order =======================
section('The Beginning of the End');
{
  const e = duel([...Array(7).fill('Dark Blade'), 'The Beginning of the End']);
  for (let i = 0; i < 6; i++) bury(e, 0, 'Dark Blade');
  const card = grab(e, 0, 'The Beginning of the End');
  check(!e.canActivateMain(0, card.uid), 'cannot be activated with only 6 DARK monsters in the GY');
  bury(e, 0, 'Dark Blade');
  const hand = e.player(0).hand.length;
  playSpell(e, 0, 'The Beginning of the End');
  check(e.player(0).removed.length === 5 && inGy(e, 0, 'Dark Blade') === 2, 'banishes 5 DARK monsters from the GY');
  check(e.player(0).hand.length === hand - 1 + 3, 'draws 3 cards');
}

section('The Big March of Animals');
{
  const e = duel(['Silver Fang', 'Silver Fang', 'The Big March of Animals']);
  const a = place(e, 0, 'Silver Fang');
  const b = place(e, 0, 'Silver Fang');
  const c = place(e, 0, FILL);
  playSpell(e, 0, 'The Big March of Animals');
  check(atk(e, a) === 1600 && atk(e, b) === 1600 && atk(e, c) === 1400, 'each Beast gains 200 ATK for each Beast you control');
  endTurn(e);
  check(atk(e, a) === 1200, 'only until the end of the turn');
}

section('The Fiend Megacyber');
{
  const e = duel(['The Fiend Megacyber'], [FILL, FILL]);
  const mc = grab(e, 0, 'The Fiend Megacyber');
  place(e, 1, FILL);
  check(!e.canSpecialProc(0, mc), 'cannot be Special Summoned while the opponent controls only 1 more monster');
  place(e, 1, FILL);
  special(e, 0, mc);
  check(zone(e, mc) === 'mz', 'Special Summoned from the hand while the opponent controls 2 more monsters');
}

section('The First / Second / Third Sarcophagus');
{
  const e = duel(['The First Sarcophagus', 'The Second Sarcophagus', 'The Third Sarcophagus', 'Spirit of the Pharaoh']);
  const second = grab(e, 0, 'The Second Sarcophagus');
  check(!e.canActivateMain(0, second.uid), 'The Second Sarcophagus cannot be activated by itself');
  e.toDeckTop(second.uid);
  const first = playTrap(e, 0, 'The First Sarcophagus');
  check(active(e, first), 'The First Sarcophagus stays face-up');
  endTurn(e);
  check(!e.spells(0).some((c) => c.name === 'The Second Sarcophagus'), 'nothing is placed in your own End Phase');
  endTurn(e);
  check(e.spells(0).some((c) => c.name === 'The Second Sarcophagus' && c.faceUp), "the opponent's End Phase places The Second Sarcophagus");
  endTurn(e);
  endTurn(e);
  const spirit = onField(e, 0, 'Spirit of the Pharaoh')[0];
  check(!!spirit && inGy(e, 0, 'The First Sarcophagus') + inGy(e, 0, 'The Second Sarcophagus') + inGy(e, 0, 'The Third Sarcophagus') === 3, 'with all 3 out, they go to the GY and Spirit of the Pharaoh is Special Summoned');
}
{
  const e = duel(['The First Sarcophagus', 'The Second Sarcophagus', 'The Third Sarcophagus']);
  playTrap(e, 0, 'The First Sarcophagus');
  endTurn(e);
  endTurn(e);
  const second = e.spells(0).find((c) => c.name === 'The Second Sarcophagus');
  kill(e, [second], 1);
  check(inGy(e, 0, 'The First Sarcophagus') === 1, 'if 1 Sarcophagus is removed, all of them are sent to the GY');
}

section('The Forceful Checkpoint');
{
  const e = duel([], ['The Forceful Checkpoint']);
  const a = place(e, 0, FILL);
  const fc = putST(e, 1, 'The Forceful Checkpoint');
  toTurn3(e);
  toBattle(e);
  const hand = e.player(0).hand.length;
  attack(e, a, null, { respond: 'The Forceful Checkpoint' });
  check(zone(e, fc) === 'gy' && lp(e, 1) === 4000, 'the attack is negated');
  check(e.player(0).hand.length === hand - 1 && inGy(e, 0, FILL) === 1, "a monster in the attacking player's hand is discarded");
}

section('The Fountain in the Sky');
{
  const e = duel(['Mystical Elf', 'The Fountain in the Sky']);
  playSpell(e, 0, 'The Fountain in the Sky');
  const elf = place(e, 0, 'Mystical Elf');
  endTurn(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, elf, { respond: 'The Fountain in the Sky' });
  check(e.player(0).removed.some((c) => c.name === 'Mystical Elf'), 'the LIGHT monster destroyed by battle is banished');
  check(lp(e, 0) === 4000 - 600 + 800, 'its controller gains LP equal to its ATK');
}

section('The Golden Apples');
{
  const e = duel(['The Golden Apples']);
  const ga = putST(e, 0, 'The Golden Apples');
  endTurn(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, null, { respond: 'The Golden Apples' });
  const tok = e.monsters(0).find((m) => m.name === 'Malus Token');
  check(zone(e, ga) === 'gy' && lp(e, 0) === 4000, 'gains LP equal to the battle damage taken');
  check(!!tok && atk(e, tok) === 1400 && def(e, tok) === 1400, 'Special Summons a Malus Token with that ATK/DEF');
}
{
  const e = duel(['The Golden Apples'], ['Dark Blade']);
  const mine = place(e, 0, FILL);
  const ga = putST(e, 0, 'The Golden Apples');
  endTurn(e);
  const foe = place(e, 1, 'Dark Blade')!;
  toBattle(e);
  attack(e, foe, mine, { respond: 'The Golden Apples' });
  check(lp(e, 0) === 3600 && zone(e, ga) === 'sz' && !ga.faceUp, 'cannot be activated while you control a monster');
}

section('The Grave of Enkindling');
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
  check(!!mine && mine.pos === 'def' && !!theirs && theirs.pos === 'def', 'each player Special Summons a monster from their GY in Defense Position');
  check(!!theirs && !e.canChangePosition(1, theirs) && !!mine?.cannotChangePos, 'they cannot change their battle positions');
}

section('The King of D.');
{
  const e = duel(['The King of D.', 'The Flute of Summoning Dragon', 'Fissure', 'Blue-Eyes White Dragon']);
  grab(e, 0, 'Fissure');
  const king = summon(e, 0, 'The King of D.', true, 'yes', { pick: ['Fissure'] });
  check(inHand(e, 0, 'The Flute of Summoning Dragon') === 1 && inGy(e, 0, 'Fissure') === 1, 'discards a Spell to add The Flute of Summoning Dragon');
  grab(e, 0, 'Blue-Eyes White Dragon');
  const flute = e.player(0).hand.find((c) => c.name === 'The Flute of Summoning Dragon')!;
  check(!!king && e.canActivateMain(0, flute.uid), 'its name is "Lord of D." on the field (The Flute can be activated)');
}

section('The Legendary Fisherman II');
{
  const e = duel(['The Legendary Fisherman II', 'Levia-Dragon - Daedalus']);
  const f = place(e, 0, 'The Legendary Fisherman II')!;
  check(e.effectOn(f)?.fieldName?.(e, f) === 'The Legendary Fisherman', 'its name is "The Legendary Fisherman" on the field');
  kill(e, [f], 1, 'yes');
  check(inHand(e, 0, 'Levia-Dragon - Daedalus') === 1, "destroyed by the opponent's card effect: adds a Level 7 WATER monster");
}
{
  const e = duel(['The Legendary Fisherman II', 'Levia-Dragon - Daedalus']);
  const f = place(e, 0, 'The Legendary Fisherman II')!;
  kill(e, [f], 0, 'yes');
  check(inHand(e, 0, 'Levia-Dragon - Daedalus') === 0, 'not when its own controller destroys it');
}
{
  const e = duel(['The Legendary Fisherman II', 'Umi'], ['Tribe-Shocking Virus', FILL, FILL]);
  playSpell(e, 0, 'Umi');
  const f = place(e, 0, 'The Legendary Fisherman II')!;
  const g = place(e, 0, FILL)!;
  endTurn(e);
  const v = place(e, 1, 'Tribe-Shocking Virus');
  grab(e, 1, FILL);
  effect(e, 1, v, { pick: [FILL] });
  check(zone(e, g) === 'gy' && zone(e, f) === 'mz', 'with "Umi" out, it is unaffected by other monsters\' effects');
}

section('The Mask of Remnants');
{
  const e = duel(['The Mask of Remnants']);
  const c = grab(e, 0, 'The Mask of Remnants');
  playSpell(e, 0, 'The Mask of Remnants');
  check(zone(e, c) === 'deck', 'shuffles itself into the Deck');
}

section('The Melody of Awakening Dragon');
{
  const e = duel(['The Melody of Awakening Dragon', 'Blue-Eyes White Dragon', 'Blue-Eyes White Dragon', 'Fissure']);
  grab(e, 0, 'Fissure');
  playSpell(e, 0, 'The Melody of Awakening Dragon', { pick: ['Fissure'] }, { pick: ['Blue-Eyes White Dragon', 'Blue-Eyes White Dragon'] });
  check(inGy(e, 0, 'Fissure') === 1 && inHand(e, 0, 'Blue-Eyes White Dragon') === 2, 'discards 1 card to add 2 Dragons with 3000+ ATK and 2500 or less DEF');
}

section('The Puppet Magic of Dark Ruler');
{
  const e = duel(['Summoned Skull', 'Petit Dragon', 'The Puppet Magic of Dark Ruler']);
  bury(e, 0, 'Summoned Skull');
  const a = place(e, 0, FILL);
  const b = place(e, 0, 'Petit Dragon');
  playSpell(e, 0, 'The Puppet Magic of Dark Ruler', { pick: ['Summoned Skull'] }, { pick: [FILL, 'Petit Dragon'] });
  check(zone(e, a) === 'removed' && zone(e, b) === 'removed', 'banishes monsters whose Levels add up to the Fiend\'s Level (4 + 2 = 6)');
  check(onField(e, 0, 'Summoned Skull').length === 1, 'then Special Summons the Fiend from the GY');
}

section('The Rock Spirit');
{
  const e = duel(['The Rock Spirit']);
  const rs = grab(e, 0, 'The Rock Spirit');
  check(!e.canNormalSummon(0, rs), 'cannot be Normal Summoned');
  check(!e.canSpecialProc(0, rs), 'needs an EARTH monster in the GY');
  const earth = bury(e, 0, FILL);
  special(e, 0, rs);
  const m = e.fieldCard(rs.uid);
  check(!!m && zone(e, earth) === 'removed', 'Special Summoned by banishing an EARTH monster from the GY');
  check(e.summonBlocked(0, { uid: -5, name: 'The Rock Spirit', owner: 0 }, 'special', 'deck'), 'cannot be Special Summoned by other ways');
  check(atk(e, m) === 1700, 'normal ATK on your turn');
  e.state.turnPlayer = 1;
  e.state.phase = 'BP';
  check(atk(e, m) === 2000, "gains 300 ATK during the opponent's Battle Phase");
}

section('The Warrior Returning Alive');
{
  const e = duel(['The Warrior Returning Alive']);
  const w = bury(e, 0, FILL);
  playSpell(e, 0, 'The Warrior Returning Alive');
  check(zone(e, w) === 'hand', 'adds a Warrior from the GY to the hand');
}

section('Theban Nightmare');
{
  const e = duel(['Theban Nightmare', 'Fissure']);
  const t = place(e, 0, 'Theban Nightmare');
  check(atk(e, t) === 1500, 'no bonus while you have cards in hand');
  emptyHand(e, 0);
  check(atk(e, t) === 3000, 'gains 1500 ATK with no cards in hand or Spell & Trap Zones');
  putST(e, 0, 'Fissure');
  check(atk(e, t) === 1500, 'no bonus with a card in the Spell & Trap Zone');
}

section('Thestalos the Firestorm Monarch');
{
  const e = duel(['Thestalos the Firestorm Monarch']);
  place(e, 0, FILL);
  const hand = e.player(1).hand.length;
  summon(e, 0, 'Thestalos the Firestorm Monarch');
  check(e.player(1).hand.length === hand - 1, "Tribute Summoned: discards a random card from the opponent's hand");
  check(lp(e, 1) === 4000 - 400, "it was a Level 4 monster: 400 damage");
}

section('Thousand Knives');
{
  const e = duel(['Thousand Knives', 'Dark Magician']);
  const foe = place(e, 1, FILL);
  const tk = grab(e, 0, 'Thousand Knives');
  check(!e.canActivateMain(0, tk.uid), 'needs "Dark Magician"');
  place(e, 0, 'Dark Magician');
  playSpell(e, 0, 'Thousand Knives');
  check(zone(e, foe) === 'gy', 'destroys the targeted monster');
}

section('Thousand-Eyes Restrict');
{
  const e = duel([], [FILL, FILL], ['Thousand-Eyes Restrict']);
  const ter = place(e, 0, 'Thousand-Eyes Restrict')!;
  const foe = place(e, 1, FILL)!;
  effect(e, 0, ter);
  check(zone(e, foe) === 'sz' && atk(e, ter) === 1400 && def(e, ter) === 1200, 'equips an opponent\'s monster and takes its ATK/DEF');
  endTurn(e);
  const other = place(e, 1, FILL)!;
  toBattle(e);
  check(!e.canAttackWith(1, other), 'other monsters cannot attack');
}
{
  const e = duel([], [FILL], ['Thousand-Eyes Restrict']);
  const foe = place(e, 1, FILL)!;
  place(e, 0, 'Thousand-Eyes Restrict');
  endTurn(e);
  check(!e.canChangePosition(1, foe), 'other monsters cannot change their battle positions');
}
{
  const e = duel([FILL], ['Dark Blade'], ['Thousand-Eyes Restrict']);
  const ter = place(e, 0, 'Thousand-Eyes Restrict')!;
  const foe = place(e, 1, FILL)!;
  effect(e, 0, ter);
  const db = place(e, 1, 'Dark Blade')!;
  toTurn3(e);
  void db;
  const sub = (e.effectOn(ter)?.battleSubstitute as any)?.(e, ter);
  check(sub === foe.uid, 'if it would be destroyed by battle, the equipped monster is destroyed instead');
}

section('Token Stampede');
{
  const e = duel(['Token Stampede']);
  const tok = e.createToken('Audit Token', 0, 'atk', true, { atk: 500, def: 500, level: 1 })!;
  const tokD = e.createToken('Audit Token', 0, 'def', true, { atk: 500, def: 500, level: 1 })!;
  playTrap(e, 0, 'Token Stampede');
  check(atk(e, tok) === 1500 && atk(e, tokD) === 500, 'Tokens in Attack Position gain 1000 ATK');
  check(e.shielded(tok, 'battle') && !e.shielded(tok, 'effect'), 'they cannot be destroyed by battle');
}

section('Token Sundae');
{
  const e = duel(['Token Sundae'], [FILL, FILL]);
  e.createToken('Malus Token', 0, 'atk', true, { atk: 0, def: 0, level: 1 });
  e.createToken('Malus Token', 0, 'atk', true, { atk: 0, def: 0, level: 1 });
  const a = place(e, 1, FILL);
  const b = place(e, 1, FILL);
  playSpell(e, 0, 'Token Sundae', { pick: [FILL, FILL] });
  check(e.monsters(0).length === 0 && zone(e, a) === 'gy' && zone(e, b) === 'gy', 'destroys your Tokens, then up to that many cards on the field');
}

// ----- Toons -----
section('Toon Ancient Gear Golem');
{
  const e = duel(['Toon World', 'Toon Ancient Gear Golem'], ['Mirror Force']);
  playSpell(e, 0, 'Toon World');
  const g = place(e, 0, 'Toon Ancient Gear Golem')!;
  check(!e.canAttackWith(0, g), 'cannot attack the turn it is Summoned');
  endTurn(e);
  const d = place(e, 1, FILL, 'def')!;
  const mf = putST(e, 1, 'Mirror Force');
  endTurn(e);
  toBattle(e);
  check(e.canAttackDirectly(g), 'with Toon World and no opposing Toons, it can attack directly');
  e.apply({ type: 'ATTACK', player: 0, uid: g.uid, target: d.uid });
  check(!hasPrompt(e, 1, 'Mirror Force'), 'when it attacks, the opponent cannot activate Spell/Trap Cards');
  settle(e);
  check(zone(e, mf) === 'sz' && zone(e, d) === 'gy' && lp(e, 1) === 4000 - (3000 - 1200), 'inflicts piercing battle damage');
}

section('Toon Barrel Dragon');
{
  const e = duel(['Toon Barrel Dragon']);
  const b = place(e, 0, 'Toon Barrel Dragon')!;
  const foe = place(e, 1, FILL);
  e.roll = () => 1;
  effect(e, 0, b, { pick: [FILL] });
  check(zone(e, foe) === 'gy', '2+ Heads: destroys the targeted card');
}
{
  const e = duel(['Toon Barrel Dragon']);
  const b = place(e, 0, 'Toon Barrel Dragon')!;
  const foe = place(e, 1, FILL);
  e.roll = () => 2;
  effect(e, 0, b, { pick: [FILL] });
  check(zone(e, foe) === 'mz', 'Tails: nothing is destroyed');
}

section('Toon Buster Blader');
{
  const e = duel(['Toon Buster Blader'], ['Blue-Eyes White Dragon', 'Petit Dragon']);
  const t = place(e, 0, 'Toon Buster Blader');
  place(e, 1, 'Blue-Eyes White Dragon');
  bury(e, 1, 'Petit Dragon');
  check(atk(e, t) === 2600 + 1000, 'gains 500 ATK for each Dragon the opponent controls or has in their GY');
}

section('Toon Dark Magician');
{
  const e = duel(['Toon Dark Magician', 'Toon World', 'Toon Mermaid', 'Toon Table of Contents']);
  const dm = place(e, 0, 'Toon Dark Magician')!;
  grab(e, 0, 'Toon World');
  effect(e, 0, dm, { pick: ['Toon World'] }, { pick: ['Special Summon a Toon monster from the Deck'] });
  const mer = onField(e, 0, 'Toon Mermaid')[0];
  check(inGy(e, 0, 'Toon World') === 1 && !!mer, 'discards a "Toon" card to Special Summon a Toon monster from the Deck');
  check(!!mer && mer.tags?.toonTurn === e.state.turn, 'the Summoned Toon cannot attack that turn');
}
{
  const e = duel(['Toon Dark Magician', 'Toon World', 'Toon Table of Contents']);
  const dm = place(e, 0, 'Toon Dark Magician')!;
  grab(e, 0, 'Toon World');
  effect(e, 0, dm, { pick: ['Toon World'] });
  check(inHand(e, 0, 'Toon Table of Contents') === 1, 'or adds a "Toon" Spell/Trap from the Deck');
}

section('Toon Gemini Elf');
{
  const e = duel(['Toon Gemini Elf', 'Toon World']);
  playSpell(e, 0, 'Toon World');
  const elf = place(e, 0, 'Toon Gemini Elf')!;
  toTurn3(e);
  toBattle(e);
  const hand = e.player(1).hand.length;
  attack(e, elf, null);
  check(lp(e, 1) === 4000 - 1900 && e.player(1).hand.length === hand - 1, "battle damage: discards a random card from the opponent's hand");
  const tw = e.spells(0).find((c) => c.name === 'Toon World');
  kill(e, [tw], 1);
  check(zone(e, elf) === 'gy', 'destroyed when Toon World is destroyed');
}

section('Toon Masked Sorcerer');
{
  const e = duel(['Toon Masked Sorcerer', 'Toon World']);
  playSpell(e, 0, 'Toon World');
  const ms = place(e, 0, 'Toon Masked Sorcerer')!;
  toTurn3(e);
  toBattle(e);
  const hand = e.player(0).hand.length;
  attack(e, ms, null);
  check(e.player(0).hand.length === hand + 1, 'battle damage: draws 1 card');
  const tw = e.spells(0).find((c) => c.name === 'Toon World');
  kill(e, [tw], 1);
  check(zone(e, ms) === 'gy', 'destroyed when Toon World is destroyed');
}

section('Toon Defense');
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

section('Toon Mask');
{
  const e = duel(['Toon World', 'Toon Mask', 'Toon Mermaid', 'Toon Summoned Skull']);
  const tm = putST(e, 0, 'Toon Mask');
  place(e, 1, FILL);
  check(!e.canActivateMain(0, tm.uid), 'needs Toon World');
  playSpell(e, 0, 'Toon World');
  act(e, 0, tm.uid, { pick: [FILL] }, { pick: ['Toon Summoned Skull'] });
  const mer = onField(e, 0, 'Toon Mermaid')[0];
  check(!!mer && onField(e, 0, 'Toon Summoned Skull').length === 0, "Special Summons a Toon whose Level is at most the target's (Level 4)");
}

section('Toon Rollback');
{
  const e = duel(['Toon World', 'Toon Rollback', 'Toon Mermaid']);
  playSpell(e, 0, 'Toon World');
  const mer = place(e, 0, 'Toon Mermaid')!;
  toTurn3(e);
  playSpell(e, 0, 'Toon Rollback');
  toBattle(e);
  attack(e, mer, null);
  attack(e, mer, null);
  check(lp(e, 1) === 4000 - 2800, 'the Toon attacks twice this turn');
}

section('Toon Table of Contents');
{
  const e = duel(['Toon Table of Contents', 'Toon World']);
  playSpell(e, 0, 'Toon Table of Contents');
  check(inHand(e, 0, 'Toon World') === 1, 'adds a "Toon" card from the Deck');
}

section('Tornado Wall');
{
  const e = duel(['Umi', 'Tornado Wall'], ['Dark Blade']);
  const tw = putST(e, 0, 'Tornado Wall');
  check(!e.canActivateMain(0, tw.uid), 'can only be activated while "Umi" is on the field');
  const umi = playSpell(e, 0, 'Umi');
  act(e, 0, tw.uid);
  endTurn(e);
  const foe = place(e, 1, 'Dark Blade')!;
  toBattle(e);
  attack(e, foe, null);
  check(lp(e, 0) === 4000, 'no battle damage from attacking monsters');
  kill(e, [umi], 1);
  check(zone(e, tw) === 'gy', 'destroyed when "Umi" leaves the field');
}

section('Totem Dragon');
{
  const e = duel(['Totem Dragon', 'Blue-Eyes White Dragon']);
  place(e, 0, 'Totem Dragon');
  const bewd = grab(e, 0, 'Blue-Eyes White Dragon');
  check(e.canNormalSummon(0, bewd), 'counts as 2 Tributes for a Dragon');
  summon(e, 0, 'Blue-Eyes White Dragon', true, 'yes');
  check(zone(e, bewd) === 'mz' && inGy(e, 0, 'Totem Dragon') === 1, 'Tribute Summons a Level 8 Dragon alone');
}
{
  const e = duel(['Totem Dragon']);
  const t = bury(e, 0, 'Totem Dragon');
  endTurn(e);
  e.apply({ type: 'END_TURN', player: 1 });
  settle(e, 'yes');
  const m = e.fieldCard(t.uid);
  check(!!m && m.pos === 'atk', 'in the GY during your Standby Phase with no monsters: Special Summoned in Attack Position');
  kill(e, [m], 1);
  check(zone(e, t) === 'removed', 'banished when it leaves the field');
}
{
  const e = duel(['Totem Dragon']);
  bury(e, 0, 'Totem Dragon');
  bury(e, 0, FILL);
  endTurn(e);
  e.apply({ type: 'END_TURN', player: 1 });
  settle(e, 'yes');
  check(e.monsters(0).length === 0, 'not with a non-Dragon monster in the GY');
}

section('Trap Jammer');
{
  const e = duel(['Trap Jammer'], ['Waboku']);
  const a = place(e, 0, FILL)!;
  const tj = putST(e, 0, 'Trap Jammer');
  const wb = putST(e, 1, 'Waboku');
  toTurn3(e);
  toBattle(e);
  attack(e, a, null, { respond: 'Waboku' }, { respond: 'Trap Jammer' });
  check(zone(e, tj) === 'gy' && zone(e, wb) === 'gy' && lp(e, 1) === 4000 - 1400, 'negates a Trap activated in the Battle Phase and destroys it');
}

section('Tri-Blaze Accelerator');
{
  const e = duel(['Blaze Accelerator', 'Tri-Blaze Accelerator', 'Blazing Inpachi']);
  const tri = grab(e, 0, 'Tri-Blaze Accelerator');
  check(!e.canActivateMain(0, tri.uid), 'needs a face-up "Blaze Accelerator" to send');
  const ba = playSpell(e, 0, 'Blaze Accelerator');
  const t = playSpell(e, 0, 'Tri-Blaze Accelerator');
  check(zone(e, ba) === 'gy' && active(e, t), 'activated by sending Blaze Accelerator to the GY');
  const foe = place(e, 1, FILL);
  grab(e, 0, 'Blazing Inpachi');
  effect(e, 0, t, { pick: ['Blazing Inpachi'] });
  check(zone(e, foe) === 'gy' && lp(e, 1) === 3500 && inGy(e, 0, 'Blazing Inpachi') === 1, 'sends a Pyro from the hand: destroys a monster and inflicts 500 damage');
  const m = place(e, 0, FILL)!;
  e.state.firstTurn = false;
  toBattle(e);
  check(!e.canAttackWith(0, m), 'you cannot declare an attack that turn');
}

section('Tri-Wight');
{
  const e = duel(['Petit Dragon', 'Skull Servant', 'Clown Zombie', 'Tri-Wight']);
  bury(e, 0, 'Petit Dragon');
  bury(e, 0, 'Skull Servant');
  bury(e, 0, 'Clown Zombie');
  playSpell(e, 0, 'Tri-Wight', { pick: ['Petit Dragon', 'Skull Servant', 'Clown Zombie'] });
  check(e.monsters(0).length === 3, 'Special Summons 3 Level 2 or lower Normal Monsters from the GY');
}

section('Tribe-Shocking Virus');
{
  const e = duel(['Tribe-Shocking Virus', 'Elemental HERO Clayman'], [FILL, 'Blue-Eyes White Dragon']);
  const v = place(e, 0, 'Tribe-Shocking Virus')!;
  const foe = place(e, 1, FILL);
  const dragon = place(e, 1, 'Blue-Eyes White Dragon');
  const clay = grab(e, 0, 'Elemental HERO Clayman');
  effect(e, 0, v, { pick: ['Elemental HERO Clayman'] });
  check(zone(e, clay) === 'removed', 'banishes a monster from the hand');
  check(zone(e, foe) === 'gy' && zone(e, dragon) === 'mz', 'destroys the face-up monsters of that Type (Warrior)');
}

section('Tribute Doll');
{
  const e = duel(['Tribute Doll', 'Dark Magician']);
  const f = place(e, 0, FILL);
  grab(e, 0, 'Dark Magician');
  playSpell(e, 0, 'Tribute Doll');
  const dm = onField(e, 0, 'Dark Magician')[0];
  check(zone(e, f) === 'gy' && !!dm, 'Tributes 1 monster to Special Summon a Level 7 monster from the hand');
  check(dm?.tags?.noAttackTurn === e.state.turn, 'it cannot attack this turn');
}

section('Troop Dragon');
{
  const e = duel(['Troop Dragon', 'Troop Dragon'], ['Dark Blade']);
  const td = place(e, 0, 'Troop Dragon');
  endTurn(e);
  const foe = place(e, 1, 'Dark Blade')!;
  toBattle(e);
  attack(e, foe, td);
  check(zone(e, td) === 'gy' && onField(e, 0, 'Troop Dragon').length === 1, 'destroyed by battle: Special Summons another Troop Dragon from the Deck');
}

section('Truckroid');
{
  const e = duel(['Truckroid'], ['Petit Angel']);
  const t = place(e, 0, 'Truckroid')!;
  const foe = place(e, 1, 'Petit Angel')!;
  toTurn3(e);
  toBattle(e);
  attack(e, t, foe);
  check(zone(e, foe) === 'sz' && t.equips.includes(foe.uid) && atk(e, t) === 1600, 'equips the monster it destroyed and gains its ATK');
}

section('Tutan Mask');
{
  const e = duel(['Thousand Knives', 'Dark Magician'], ['Tutan Mask', 'Armored Zombie']);
  place(e, 0, 'Dark Magician');
  const z = place(e, 1, 'Armored Zombie');
  const tm = putST(e, 1, 'Tutan Mask');
  playSpell(e, 0, 'Thousand Knives', { pick: ['Armored Zombie'] }, { respond: 'Tutan Mask' });
  check(zone(e, z) === 'mz' && zone(e, tm) === 'gy' && inGy(e, 0, 'Thousand Knives') === 1, 'negates a Spell that targets 1 Zombie and destroys it');
}

section('Twister');
{
  const e = duel(['Twister'], ['Umi']);
  endTurn(e);
  const umi = playSpell(e, 1, 'Umi');
  endTurn(e);
  playSpell(e, 0, 'Twister');
  check(zone(e, umi) === 'gy' && lp(e, 0) === 3500, 'pays 500 LP to destroy a face-up Spell/Trap');
}

section('UFOroid');
{
  const e = duel(['UFOroid', 'Submarineroid'], ['Dark Blade']);
  const u = place(e, 0, 'UFOroid');
  endTurn(e);
  const foe = place(e, 1, 'Dark Blade')!;
  toBattle(e);
  attack(e, foe, u, 'yes');
  check(onField(e, 0, 'Submarineroid').length === 1, 'destroyed by battle: Special Summons a Machine with 1500 or less ATK from the Deck');
}

section('Ultra Evolution Pill');
{
  const e = duel(['Ultra Evolution Pill', 'Ancient Lizard Warrior', 'Mammoth Graveyard']);
  const r = place(e, 0, 'Ancient Lizard Warrior', 'def', false);
  grab(e, 0, 'Mammoth Graveyard');
  playSpell(e, 0, 'Ultra Evolution Pill');
  check(zone(e, r) === 'gy' && onField(e, 0, 'Mammoth Graveyard').length === 1, 'Tributes a Reptile (even face-down) to Special Summon a Dinosaur from the hand');
}

section('Unbreakable Spirit');
{
  const e = duel(['Unbreakable Spirit'], ['Petit Angel', FILL]);
  const m = place(e, 0, FILL);
  place(e, 1, 'Petit Angel');
  place(e, 1, FILL);
  playTrap(e, 0, 'Unbreakable Spirit');
  check(atk(e, m) === 1400 + 600, "gains the ATK of the opponent's lowest-ATK monster");
}
{
  const e = duel(['Unbreakable Spirit'], [FILL]);
  place(e, 0, FILL);
  place(e, 0, FILL);
  place(e, 1, FILL);
  const us = putST(e, 0, 'Unbreakable Spirit');
  check(!e.canActivateMain(0, us.uid), 'not while you control 2 face-up monsters');
}

section('Unending Nightmare');
{
  const e = duel(['Unending Nightmare'], ['Umi']);
  endTurn(e);
  const umi = playSpell(e, 1, 'Umi');
  endTurn(e);
  const un = playTrap(e, 0, 'Unending Nightmare')!;
  effect(e, 0, un);
  check(zone(e, umi) === 'gy' && lp(e, 0) === 3000, 'pays 1000 LP to destroy a face-up Spell/Trap');
}

section('Union Hangar');
{
  const e = duel(['Union Hangar', 'W-Wing Catapult', 'Y-Dragon Head', 'Z-Metal Tank', 'V-Tiger Jet']);
  playSpell(e, 0, 'Union Hangar', 'yes', { pick: ['W-Wing Catapult'] });
  check(inHand(e, 0, 'W-Wing Catapult') === 1, 'adds a LIGHT Machine Union monster when activated');
  summon(e, 0, 'V-Tiger Jet', true, 'yes');
  check(!e.spells(0).some((c) => c.name === 'W-Wing Catapult' || c.name === 'Z-Metal Tank'), 'nothing happens for a non-Union monster');
  const y = summon(e, 0, 'Y-Dragon Head', true, 'yes');
  const z = e.spells(0).find((c) => c.name === 'Z-Metal Tank');
  check(!!z && y!.equips.includes(z.uid) && atk(e, y) === 2100, 'a LIGHT Machine Union is Summoned: equips an appropriate Union with a different name from the Deck');
  check(z?.tags?.noSS === e.state.turn, 'the equipped Union cannot be Special Summoned this turn');
}

section('Union Scramble');
{
  const e = duel(['Union Scramble', 'V-Tiger Jet', 'X-Head Cannon']);
  banishOne(e, 0, 'V-Tiger Jet');
  banishOne(e, 0, 'X-Head Cannon');
  const us = playTrap(e, 0, 'Union Scramble', { pick: ['V-Tiger Jet', 'X-Head Cannon'] });
  check(!us && onField(e, 0, 'V-Tiger Jet').length === 1 && onField(e, 0, 'X-Head Cannon').length === 1, 'Special Summons banished LIGHT Machine Normal/Union monsters');
  const card = e.player(0).gy.find((c) => c.name === 'Union Scramble')!;
  check(!e.canUseGraveEffect(0, card.uid), 'its GY effect is not usable the turn it was sent there');
  const v = onField(e, 0, 'V-Tiger Jet')[0];
  e.banish(v.uid);
  toTurn3(e);
  graveFx(e, 0, card);
  check(zone(e, card) === 'removed' && inHand(e, 0, 'V-Tiger Jet') === 1, 'later: banishes itself to return a banished one to the hand');
}

section('United We Stand');
{
  const e = duel(['United We Stand']);
  const m = place(e, 0, FILL);
  place(e, 0, FILL);
  playSpell(e, 0, 'United We Stand');
  check(atk(e, m) === 1400 + 1600 && def(e, m) === 1200 + 1600, 'gains 800 ATK/DEF for each face-up monster you control');
}

section('Uria, Lord of Searing Flames');
{
  const e = duel(['Uria, Lord of Searing Flames', 'Token Stampede', 'Token Stampede', 'Token Stampede'], ['Fissure']);
  for (let i = 0; i < 3; i++) playTrap(e, 0, 'Token Stampede');
  const u = grab(e, 0, 'Uria, Lord of Searing Flames');
  check(!e.canNormalSummon(0, u) && e.summonBlocked(0, u, 'special', 'hand'), 'cannot be Normal Summoned or Special Summoned by other ways');
  special(e, 0, u, { pick: ['Token Stampede', 'Token Stampede', 'Token Stampede'] });
  const m = e.fieldCard(u.uid);
  check(!!m && inGy(e, 0, 'Token Stampede') === 3, 'Special Summoned by sending 3 face-up Traps to the GY');
  check(atk(e, m) === 3000, 'gains 1000 ATK for each Continuous Trap in your GY');
  const set = putST(e, 1, 'Fissure');
  effect(e, 0, m);
  check(zone(e, set) === 'gy', 'destroys a Set Spell/Trap the opponent controls');
}

// ----- Union monsters and Contact Fusions -----
section('W-Wing Catapult');
{
  const e = duel(['W-Wing Catapult', 'V-Tiger Jet']);
  const v = place(e, 0, 'V-Tiger Jet')!;
  const w = place(e, 0, 'W-Wing Catapult')!;
  effect(e, 0, w);
  check(zone(e, w) === 'sz' && atk(e, v) === 2000 && def(e, v) === 2200, 'equips to V-Tiger Jet: +400 ATK/DEF');
  kill(e, [v], 1);
  check(zone(e, v) === 'mz' && zone(e, w) === 'gy', 'destroyed instead of the equipped monster');
}
{
  const e = duel(['W-Wing Catapult', 'V-Tiger Jet']);
  place(e, 0, 'V-Tiger Jet');
  const w = place(e, 0, 'W-Wing Catapult')!;
  effect(e, 0, w);
  toTurn3(e);
  effect(e, 0, e.fieldCard(w.uid));
  check(zone(e, w) === 'mz', 'unequips and Special Summons itself');
}

section('Y-Dragon Head');
{
  const e = duel(['Y-Dragon Head', 'X-Head Cannon']);
  const x = place(e, 0, 'X-Head Cannon')!;
  const y = place(e, 0, 'Y-Dragon Head')!;
  effect(e, 0, y);
  check(zone(e, y) === 'sz' && atk(e, x) === 2200, 'equips to X-Head Cannon: +400 ATK');
}

section('Z-Metal Tank');
{
  const e = duel(['Z-Metal Tank', 'Y-Dragon Head']);
  const y = place(e, 0, 'Y-Dragon Head')!;
  const z = place(e, 0, 'Z-Metal Tank')!;
  effect(e, 0, z);
  check(zone(e, z) === 'sz' && atk(e, y) === 2100 && def(e, y) === 2200, 'equips to Y-Dragon Head: +600 ATK/DEF');
}

section('Zombie Tiger');
{
  const e = duel(['Zombie Tiger', 'Decayed Commander'], ['Petit Angel']);
  const d = place(e, 0, 'Decayed Commander')!;
  const z = place(e, 0, 'Zombie Tiger')!;
  effect(e, 0, z);
  check(zone(e, z) === 'sz' && atk(e, d) === 1500, 'equips to Decayed Commander: +500 ATK');
  const foe = place(e, 1, 'Petit Angel')!;
  toTurn3(e);
  toBattle(e);
  const hand = e.player(1).hand.length;
  attack(e, d, foe);
  check(zone(e, foe) === 'gy' && e.player(1).hand.length === hand - 1, 'the equipped monster destroys a monster: a random card is discarded');
  kill(e, [d], 1);
  check(zone(e, d) === 'gy', 'it does not protect from destruction by card effects');
}

section('VW-Tiger Catapult');
{
  const e = duel(['V-Tiger Jet', 'W-Wing Catapult'], [FILL], ['VW-Tiger Catapult']);
  const vw = e.player(0).fusion[0];
  check(e.summonBlocked(0, vw, 'special', 'fusion'), 'cannot be Special Summoned with "Polymerization" or other effects');
  const v = place(e, 0, 'V-Tiger Jet');
  const w = place(e, 0, 'W-Wing Catapult');
  check(e.canSpecialProc(0, vw), 'its procedure is open with V-Tiger Jet + W-Wing Catapult');
  special(e, 0, vw);
  check(zone(e, vw) === 'mz' && zone(e, v) === 'removed' && zone(e, w) === 'removed', 'Special Summoned by banishing the materials');
  const foe = place(e, 1, FILL)!;
  effect(e, 0, e.fieldCard(vw.uid), { pick: [FILL] });
  check(foe.pos === 'def', "discards 1 card to change an opponent's monster's position");
}

section('XY-Dragon Cannon');
{
  const e = duel(['X-Head Cannon', 'Y-Dragon Head'], ['Umi'], ['XY-Dragon Cannon']);
  const xy = e.player(0).fusion[0];
  place(e, 0, 'X-Head Cannon');
  place(e, 0, 'Y-Dragon Head');
  special(e, 0, xy);
  const m = e.fieldCard(xy.uid)!;
  check(!!m, 'Contact Fusion of X-Head Cannon + Y-Dragon Head');
  endTurn(e);
  const umi = playSpell(e, 1, 'Umi');
  endTurn(e);
  effect(e, 0, m);
  check(zone(e, umi) === 'gy', 'discards 1 card to destroy a face-up Spell/Trap the opponent controls');
  kill(e, [m]);
  check(e.summonBlocked(0, xy, 'special', 'gy'), 'cannot be Special Summoned from the GY');
}

section('XZ-Tank Cannon');
{
  const e = duel(['X-Head Cannon', 'Z-Metal Tank'], ['Fissure'], ['XZ-Tank Cannon']);
  const xz = e.player(0).fusion[0];
  place(e, 0, 'X-Head Cannon');
  place(e, 0, 'Z-Metal Tank');
  special(e, 0, xz);
  const set = putST(e, 1, 'Fissure');
  effect(e, 0, e.fieldCard(xz.uid));
  check(zone(e, set) === 'gy', 'discards 1 card to destroy a Set Spell/Trap the opponent controls');
}

section('YZ-Tank Dragon');
{
  const e = duel(['Y-Dragon Head', 'Z-Metal Tank'], [FILL], ['YZ-Tank Dragon']);
  const yz = e.player(0).fusion[0];
  place(e, 0, 'Y-Dragon Head');
  place(e, 0, 'Z-Metal Tank');
  special(e, 0, yz);
  const fd = place(e, 1, FILL, 'def', false);
  effect(e, 0, e.fieldCard(yz.uid));
  check(zone(e, fd) === 'gy', 'discards 1 card to destroy a face-down monster');
}

section('XYZ-Dragon Cannon');
{
  const e = duel(['X-Head Cannon', 'Y-Dragon Head', 'Z-Metal Tank'], [FILL], ['XYZ-Dragon Cannon']);
  const xyz = e.player(0).fusion[0];
  place(e, 0, 'X-Head Cannon');
  place(e, 0, 'Y-Dragon Head');
  place(e, 0, 'Z-Metal Tank');
  special(e, 0, xyz);
  check(zone(e, xyz) === 'mz' && e.player(0).removed.length === 3, 'Contact Fusion of X + Y + Z');
  const foe = place(e, 1, FILL);
  effect(e, 0, e.fieldCard(xyz.uid));
  check(zone(e, foe) === 'gy', 'discards 1 card to destroy a card the opponent controls');
}

section('VWXYZ-Dragon Catapult Cannon');
{
  const e = duel([], [FILL, 'Dark Blade'], ['VW-Tiger Catapult', 'XYZ-Dragon Cannon', 'VWXYZ-Dragon Catapult Cannon']);
  placeX(e, 0, 'VW-Tiger Catapult');
  placeX(e, 0, 'XYZ-Dragon Cannon');
  const big = e.player(0).fusion.find((c) => c.name === 'VWXYZ-Dragon Catapult Cannon')!;
  special(e, 0, big);
  const m = e.fieldCard(big.uid)!;
  check(!!m && e.player(0).removed.length === 2, 'Contact Fusion of VW + XYZ');
  const foe = place(e, 1, FILL);
  effect(e, 0, m);
  check(zone(e, foe) === 'removed', 'once per turn: banishes a card the opponent controls');
  const db = place(e, 1, 'Dark Blade')!;
  toTurn3(e);
  toBattle(e);
  attack(e, m, db, { respond: 'VWXYZ-Dragon Catapult Cannon' });
  check(zone(e, db) === 'gy' && lp(e, 1) === 4000, "declares an attack: changes the target's position (it is destroyed in Defense Position)");
}

section('Valhalla, Hall of the Fallen');
{
  const e = duel(['Valhalla, Hall of the Fallen', 'Petit Angel']);
  const v = playSpell(e, 0, 'Valhalla, Hall of the Fallen')!;
  grab(e, 0, 'Petit Angel');
  effect(e, 0, v);
  check(onField(e, 0, 'Petit Angel').length === 1, 'Special Summons a Fairy from the hand while you control no monsters');
  check(!e.canUseMonsterEffect(0, v), 'not while you control a monster');
}

section('Water Hazard');
{
  const e = duel(['Water Hazard', 'Penguin Soldier']);
  const w = playSpell(e, 0, 'Water Hazard')!;
  grab(e, 0, 'Penguin Soldier');
  effect(e, 0, w);
  check(onField(e, 0, 'Penguin Soldier').length === 1, 'Special Summons a Level 4 or lower WATER monster from the hand');
}

// ----- Vampires -----
section('Vampire Awakening');
{
  const e = duel(['Vampire Awakening', 'Vampire Lady', 'Vampire Awakening']);
  playTrap(e, 0, 'Vampire Awakening');
  const lady = onField(e, 0, 'Vampire Lady')[0];
  check(!!lady, 'Special Summons a "Vampire" monster from the Deck');
  const second = putST(e, 0, 'Vampire Awakening');
  check(!e.canActivateMain(0, second.uid), 'only 1 "Vampire Awakening" per turn');
  endTurn(e);
  check(zone(e, lady) === 'gy', 'it is destroyed during the End Phase');
}

section('Vampire Baby');
{
  const e = duel(['Vampire Baby'], ['Petit Angel']);
  const b = place(e, 0, 'Vampire Baby')!;
  const foe = place(e, 1, 'Petit Angel')!;
  toTurn3(e);
  toBattle(e);
  attack(e, b, foe);
  check(zone(e, foe) === 'gy', 'destroys a monster by battle (nothing yet)');
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  settle(e, 'yes');
  check(e.controller(foe.uid) === 0, 'at the end of the Battle Phase: Special Summons that monster to your field');
}

section('Vampire Familiar');
{
  const e = duel(['Vampire Familiar', 'Vampire Lady', 'Vampire Retainer']);
  place(e, 0, 'Vampire Familiar', 'atk', true, 'yes', { pick: ['Vampire Lady'] });
  check(inHand(e, 0, 'Vampire Lady') === 1 && lp(e, 0) === 3500, 'Special Summoned: pays 500 LP to add a "Vampire" monster');
}
{
  const e = duel(['Vampire Familiar', 'Vampire Lady']);
  const f = bury(e, 0, 'Vampire Familiar');
  grab(e, 0, 'Vampire Lady');
  graveFx(e, 0, f, { pick: ['Vampire Lady'] });
  const m = e.fieldCard(f.uid);
  check(!!m && inGy(e, 0, 'Vampire Lady') === 1, 'from the GY: sends a "Vampire" card from the hand to Special Summon itself');
  kill(e, [m], 1);
  check(zone(e, f) === 'removed', 'banished when it leaves the field');
}

section('Vampire Retainer');
{
  const e = duel(['Vampire Retainer', "Vampire's Desire"]);
  place(e, 0, 'Vampire Retainer', 'atk', true, 'yes');
  check(inHand(e, 0, "Vampire's Desire") === 1 && lp(e, 0) === 3500, 'Special Summoned: pays 500 LP to add a "Vampire" Spell/Trap');
}
{
  const e = duel(['Vampire Retainer', 'Vampire Lady']);
  const r = bury(e, 0, 'Vampire Retainer');
  grab(e, 0, 'Vampire Lady');
  graveFx(e, 0, r, { pick: ['Vampire Lady'] });
  check(zone(e, r) === 'mz', 'from the GY: sends a "Vampire" card to Special Summon itself');
}

section('Vampire Genesis');
{
  const e = duel(['Vampire Genesis', 'Vampire Lord', 'Vampire Lord', 'Vampire Lady']);
  const g = grab(e, 0, 'Vampire Genesis');
  check(!e.canNormalSummon(0, g) && !e.canSpecialProc(0, g), 'needs a "Vampire Lord" to banish');
  check(e.summonBlocked(0, g, 'special', 'gy'), 'cannot be Special Summoned by other ways');
  const lord = place(e, 0, 'Vampire Lord');
  special(e, 0, g);
  const m = e.fieldCard(g.uid);
  check(!!m && zone(e, lord) === 'removed', 'Special Summoned by banishing Vampire Lord');
  bury(e, 0, 'Vampire Lady');
  grab(e, 0, 'Vampire Lord');
  effect(e, 0, m, { pick: ['Vampire Lord'] }, { pick: ['Vampire Lady'] });
  check(onField(e, 0, 'Vampire Lady').length === 1 && inGy(e, 0, 'Vampire Lord') === 1, 'discards a Zombie to Special Summon a lower-Level Zombie from the GY');
}

section('Vampire Hunter');
{
  const e = duel(['Vampire Hunter'], ['Dark Blade']);
  const h = place(e, 0, 'Vampire Hunter')!;
  const db = place(e, 1, 'Dark Blade')!;
  toTurn3(e);
  toBattle(e);
  attack(e, h, db);
  check(zone(e, db) === 'gy' && zone(e, h) === 'mz' && lp(e, 0) === 4000, 'battling a DARK monster: destroys it at the start of the Damage Step');
}
{
  const e = duel(['Vampire Hunter'], ['Dark Blade']);
  const h = place(e, 0, 'Vampire Hunter')!;
  endTurn(e);
  const db = place(e, 1, 'Dark Blade')!;
  toBattle(e);
  attack(e, db, h);
  check(zone(e, db) === 'gy' && zone(e, h) === 'mz', 'also when attacked by a DARK monster');
}

section('Vampire Lady');
{
  const e = duel(['Vampire Lady'], [FILL, 'Fissure']);
  const v = place(e, 0, 'Vampire Lady')!;
  toTurn3(e);
  toBattle(e);
  attack(e, v, null, { pick: ['Spell'] }, { pick: ['Fissure'] });
  check(inGy(e, 1, 'Fissure') === 1, 'battle damage: the opponent sends a card of the declared type from the Deck to the GY');
}
{
  const e = duel(['Vampire Lady'], ['Petit Angel', 'Fissure']);
  const v = place(e, 0, 'Vampire Lady')!;
  endTurn(e);
  const foe = place(e, 1, 'Petit Angel')!;
  toBattle(e);
  attack(e, foe, v, { pick: ['Spell'] }, { pick: ['Fissure'] });
  check(lp(e, 1) === 4000 - 950 && inGy(e, 1, 'Fissure') === 1, 'also when it inflicts battle damage while being attacked');
}

section('Vampire Lord');
{
  const e = duel(['Vampire Lord'], [FILL, 'Fissure']);
  const v = place(e, 0, 'Vampire Lord')!;
  toTurn3(e);
  toBattle(e);
  attack(e, v, null, { pick: ['Spell'] }, { pick: ['Fissure'] });
  check(inGy(e, 1, 'Fissure') === 1, 'battle damage: declares a type, the opponent mills one');
}
{
  const e = duel(['Vampire Lord']);
  const v = place(e, 0, 'Vampire Lord')!;
  endTurn(e);
  kill(e, [v], 1);
  check(zone(e, v) === 'gy', 'destroyed by an opponent\'s card effect');
  endTurn(e);
  check(zone(e, v) === 'mz', 'Special Summoned from the GY during your next Standby Phase');
}
{
  const e = duel(['Vampire Lord']);
  const v = place(e, 0, 'Vampire Lord')!;
  kill(e, [v], 0);
  toTurn3(e);
  check(zone(e, v) === 'gy', 'not when destroyed by your own card');
}

section('Vampire Sorcerer');
{
  const e = duel(['Vampire Sorcerer', 'Vampire Lord']);
  const s = place(e, 0, 'Vampire Sorcerer')!;
  kill(e, [s], 1, 'yes');
  check(inHand(e, 0, 'Vampire Lord') === 1, "sent to the GY by the opponent's card: adds a DARK Vampire monster");
}
{
  const e = duel(['Vampire Sorcerer', 'Vampire Lord']);
  const s = place(e, 0, 'Vampire Sorcerer')!;
  kill(e, [s], 0, 'yes');
  check(inHand(e, 0, 'Vampire Lord') === 0, 'not by your own card');
  const lord = grab(e, 0, 'Vampire Lord');
  check(!e.canNormalSummon(0, lord), 'Vampire Lord normally needs a Tribute');
  graveFx(e, 0, s);
  check(zone(e, s) === 'removed' && e.canNormalSummon(0, lord), 'banished from the GY: a DARK Vampire can be Normal Summoned without Tributing');
  summon(e, 0, 'Vampire Lord');
  check(zone(e, lord) === 'mz', 'Vampire Lord is Normal Summoned with no Tribute');
}

section("Vampire's Curse");
{
  const e = duel(["Vampire's Curse"], ['Blue-Eyes White Dragon']);
  const c = place(e, 0, "Vampire's Curse")!;
  endTurn(e);
  const foe = place(e, 1, 'Blue-Eyes White Dragon')!;
  toBattle(e);
  attack(e, foe, c, 'yes');
  check(zone(e, c) === 'gy' && lp(e, 0) === 4000 - 1000 - 500, 'destroyed by battle: pays 500 LP');
  endTurn(e);
  const m = e.fieldCard(c.uid);
  check(!!m && atk(e, m) === 2500, 'Special Summoned during the next Standby Phase with 500 more ATK');
}
{
  const e = duel(["Vampire's Curse"], ['Blue-Eyes White Dragon']);
  const c = place(e, 0, "Vampire's Curse")!;
  const foe = place(e, 1, 'Blue-Eyes White Dragon')!;
  toTurn3(e);
  toBattle(e);
  attack(e, c, foe, 'yes');
  check(zone(e, c) === 'gy', 'destroyed by battle on your own turn');
  endTurn(e);
  check(zone(e, c) === 'mz', "revived during the next turn's Standby Phase (the opponent's)");
}

section("Vampire's Desire");
{
  const e = duel(["Vampire's Desire", 'Vampire Lady', 'Vampire Lord']);
  const lady = place(e, 0, 'Vampire Lady')!;
  playSpell(e, 0, "Vampire's Desire", { pick: ['Send a Vampire from the Deck to the GY'] }, { pick: ['Vampire Lady'] }, { pick: ['Vampire Lord'] });
  check(inGy(e, 0, 'Vampire Lord') === 1 && levelOf(e, lady) === 5, 'sends a Vampire with a different Level from the Deck: the target becomes that Level');
  endTurn(e);
  check(levelOf(e, lady) === 4, 'until the end of the turn');
}
{
  const e = duel(["Vampire's Desire", 'Vampire Lady', 'Vampire Lord']);
  bury(e, 0, 'Vampire Lord');
  const f = place(e, 0, FILL);
  playSpell(e, 0, "Vampire's Desire", { pick: ['Revive a Vampire from the GY'] }, { pick: ['Vampire Lord'] }, { pick: [FILL] });
  check(zone(e, f) === 'gy' && onField(e, 0, 'Vampire Lord').length === 1, 'sends a monster you control to the GY to Special Summon the targeted Vampire');
}

section('Vampiric Koala');
{
  const e = duel(['Vampiric Koala'], ['Petit Angel']);
  const k = place(e, 0, 'Vampiric Koala')!;
  const foe = place(e, 1, 'Petit Angel')!;
  toTurn3(e);
  toBattle(e);
  attack(e, k, foe);
  check(lp(e, 1) === 4000 - 1200 && lp(e, 0) === 4000 + 1200, 'gains LP equal to the battle damage it inflicted');
}
{
  const e = duel(['Vampiric Koala']);
  const k = place(e, 0, 'Vampiric Koala')!;
  toTurn3(e);
  toBattle(e);
  attack(e, k, null);
  check(lp(e, 0) === 4000, 'not for a direct attack (not "by battle with a monster")');
}

section('Vanguard of the Dragon');
{
  const e = duel(['Vanguard of the Dragon', 'Petit Dragon']);
  const v = place(e, 0, 'Vanguard of the Dragon')!;
  grab(e, 0, 'Petit Dragon');
  effect(e, 0, v);
  check(atk(e, v) === 2000 && inGy(e, 0, 'Petit Dragon') === 1, 'sends a Dragon from the hand to the GY: gains 300 ATK');
  run(e, e.as(1, e.sendToGrave(v.uid, 'destroyed')), 'yes');
  check(onField(e, 0, 'Petit Dragon').length === 1, "sent to the GY by the opponent's effect: Special Summons a Dragon Normal Monster from a GY");
}

section('Vehicroid Connection Zone');
{
  const e = duel(['Vehicroid Connection Zone', 'Steamroid', 'Drillroid', 'Submarineroid'], [], ['Super Vehicroid Jumbo Drill']);
  for (const n of ['Steamroid', 'Drillroid', 'Submarineroid']) grab(e, 0, n);
  playSpell(e, 0, 'Vehicroid Connection Zone');
  const jd = onField(e, 0, 'Super Vehicroid Jumbo Drill')[0];
  check(!!jd && inGy(e, 0, 'Steamroid') + inGy(e, 0, 'Drillroid') + inGy(e, 0, 'Submarineroid') === 3, 'Fusion Summons a "Vehicroid" Fusion Monster');
  kill(e, [jd], 1);
  check(zone(e, jd) === 'mz', 'it cannot be destroyed by card effects');
  jd.tags!.negated = 1;
  check(!e.isNegated(jd), 'its effects cannot be negated');
}

section('Victory Viper XX03');
{
  const e = duel(['Victory Viper XX03'], ['Petit Angel']);
  const v = place(e, 0, 'Victory Viper XX03')!;
  const foe = place(e, 1, 'Petit Angel')!;
  toTurn3(e);
  toBattle(e);
  attack(e, v, foe, { pick: ['Gain 400 ATK'] });
  check(atk(e, v) === 1600, 'destroys a monster by battle: gains 400 ATK');
}
{
  const e = duel(['Victory Viper XX03'], ['Petit Angel']);
  const v = place(e, 0, 'Victory Viper XX03')!;
  const foe = place(e, 1, 'Petit Angel')!;
  toTurn3(e);
  toBattle(e);
  attack(e, v, foe, { pick: ['Special Summon an Option Token'] });
  const tok = onField(e, 0, 'Option Token')[0];
  check(!!tok && atk(e, tok) === 1200 && levelOf(e, tok) === 4, 'or Special Summons an Option Token with its stats');
  kill(e, [v], 1);
  check(onField(e, 0, 'Option Token').length === 0, 'the Option Token leaves the field with it');
}

section('Viser Des');
{
  const e = duel(['Viser Des'], [FILL]);
  const foe = place(e, 1, FILL);
  const v = summon(e, 0, 'Viser Des', true, { pick: [FILL] })!;
  check(v.tags?.viserTarget === foe!.uid, 'Normal Summoned: targets an opponent\'s monster');
  check(e.shielded(v, 'battle'), 'cannot be destroyed by battle while the target is on the field');
  toTurn3(e);
  check(zone(e, foe) === 'mz', 'not yet after 1 Standby Phase');
  toTurn3(e);
  toTurn3(e);
  check(zone(e, foe) === 'gy', 'the target is destroyed during your third Standby Phase');
}

section('Volcanic Blaster');
{
  const e = duel(['Volcanic Blaster', 'Volcanic Rocket'], ['Dark Blade']);
  const b = place(e, 0, 'Volcanic Blaster');
  endTurn(e);
  const foe = place(e, 1, 'Dark Blade')!;
  toBattle(e);
  attack(e, foe, b, 'yes');
  check(e.player(0).deck[0]?.name === 'Volcanic Rocket', 'destroyed by battle: puts a "Volcanic" monster on top of the Deck');
}

section('Volcanic Doomfire');
{
  const e = duel(['Volcanic Doomfire', 'Blaze Accelerator', 'Tri-Blaze Accelerator'], [FILL, FILL, 'Petit Angel']);
  const d = grab(e, 0, 'Volcanic Doomfire');
  check(!e.canNormalSummon(0, d) && !e.canSpecialProc(0, d), 'needs a face-up Tri-Blaze Accelerator');
  playSpell(e, 0, 'Blaze Accelerator');
  playSpell(e, 0, 'Tri-Blaze Accelerator');
  special(e, 0, d);
  const m = e.fieldCard(d.uid)!;
  check(!!m && inGy(e, 0, 'Tri-Blaze Accelerator') === 1, 'Special Summoned by sending Tri-Blaze Accelerator to the GY');
  const other = place(e, 0, FILL)!;
  endTurn(e);
  const a = place(e, 1, FILL)!;
  check(e.legalTargets(1, a).every((t) => t.uid === m.uid) && !e.legalTargets(1, a).some((t) => t.uid === other.uid), 'the opponent can only attack this monster');
  const b = place(e, 1, FILL);
  const angel = place(e, 1, 'Petit Angel')!;
  endTurn(e);
  toBattle(e);
  attack(e, m, angel);
  check(zone(e, a) === 'gy' && zone(e, b) === 'gy' && lp(e, 1) === 4000 - 2400 - 1000, 'destroys a monster: destroys all opponent\'s monsters, 500 damage each');
}

section('Volcanic Hammerer');
{
  const e = duel(['Volcanic Hammerer', 'Volcanic Rocket', 'Volcanic Blaster']);
  bury(e, 0, 'Volcanic Rocket');
  bury(e, 0, 'Volcanic Blaster');
  const h = place(e, 0, 'Volcanic Hammerer')!;
  toTurn3(e);
  effect(e, 0, h);
  check(lp(e, 1) === 4000 - 400, 'inflicts 200 damage for each "Volcanic" monster in the GY');
  toBattle(e);
  check(!e.canAttackWith(0, h), 'it cannot attack that turn');
}

section('Volcanic Rocket');
{
  const e = duel(['Volcanic Rocket', 'Blaze Accelerator']);
  summon(e, 0, 'Volcanic Rocket', true, 'yes');
  check(inHand(e, 0, 'Blaze Accelerator') === 1, 'Summoned: adds a "Blaze Accelerator" card from the Deck');
}
{
  const e = duel(['Volcanic Rocket', 'Tri-Blaze Accelerator']);
  bury(e, 0, 'Tri-Blaze Accelerator');
  place(e, 0, 'Volcanic Rocket', 'atk', true, 'yes');
  check(inHand(e, 0, 'Tri-Blaze Accelerator') === 1, 'Special Summoned too, and from the GY');
}

section('Volcanic Shell');
{
  const e = duel(['Volcanic Shell', 'Volcanic Shell']);
  const s = bury(e, 0, 'Volcanic Shell');
  graveFx(e, 0, s);
  check(inHand(e, 0, 'Volcanic Shell') === 1 && lp(e, 0) === 3500, 'in the GY: pays 500 LP to add a Volcanic Shell from the Deck');
  check(!e.canUseGraveEffect(0, s.uid), 'once per turn');
}

section('Vortex Trooper');
{
  const e = duel(['Vortex Trooper']);
  const hand = e.player(0).hand.length;
  const v = summon(e, 0, 'Vortex Trooper', true, 'yes');
  check(e.player(0).hand.length === hand && logHas(e, 'drew 2 cards'), 'Normal Summoned: shuffles 2 cards into the Deck, then draws 2');
  kill(e, [v], 1);
  check(e.player(0).hand.length === hand + 1, 'destroyed: draws 1 card');
}

section('Waking the Dragon');
{
  const e = duel(['Waking the Dragon', 'Blue-Eyes White Dragon']);
  const w = putST(e, 0, 'Waking the Dragon');
  kill(e, [w], 1, 'yes', { pick: ['Blue-Eyes White Dragon'] });
  check(onField(e, 0, 'Blue-Eyes White Dragon').length === 1, "Set card destroyed by the opponent: Special Summons a monster from the Deck");
}
{
  const e = duel(['Waking the Dragon', 'Blue-Eyes White Dragon']);
  const w = putST(e, 0, 'Waking the Dragon');
  e.as(1, (function* () {})());
  (e as any).actor = 1;
  e.banish(w.uid);
  (e as any).actor = null;
  run(e, e.flushLeaves(), 'yes', { pick: ['Blue-Eyes White Dragon'] });
  check(onField(e, 0, 'Blue-Eyes White Dragon').length === 1, 'also when banished by the opponent');
}
{
  const e = duel(['Waking the Dragon', 'Blue-Eyes White Dragon']);
  const w = putST(e, 0, 'Waking the Dragon');
  kill(e, [w], 0, 'yes');
  check(e.monsters(0).length === 0, 'not when you destroy it yourself');
}

section('Wall of Disruption');
{
  const e = duel(['Wall of Disruption'], ['Blue-Eyes White Dragon', 'Dark Blade']);
  putST(e, 0, 'Wall of Disruption');
  endTurn(e);
  const a = place(e, 1, 'Blue-Eyes White Dragon')!;
  const b = place(e, 1, 'Dark Blade')!;
  toBattle(e);
  attack(e, a, null, { respond: 'Wall of Disruption' });
  check(atk(e, a) === 3000 - 1600 && atk(e, b) === 1800 - 1600, 'all their Attack Position monsters lose 800 ATK for each monster they control');
}

section('Warrior Lady of the Wasteland');
{
  const e = duel(['Warrior Lady of the Wasteland', 'Elemental HERO Clayman'], ['Dark Blade']);
  const w = place(e, 0, 'Warrior Lady of the Wasteland');
  endTurn(e);
  const foe = place(e, 1, 'Dark Blade')!;
  toBattle(e);
  attack(e, foe, w, 'yes', { pick: ['Elemental HERO Clayman'] });
  check(onField(e, 0, 'Elemental HERO Clayman').length === 1, 'destroyed by battle: Special Summons an EARTH Warrior with 1500 or less ATK');
}

section('Water Dragon');
{
  const e = duel(['Water Dragon', 'Hydrogeddon', 'Hydrogeddon', 'Oxygeddon', 'Bonding - H2O'], ['Blazing Inpachi']);
  const wd = grab(e, 0, 'Water Dragon');
  check(!e.canNormalSummon(0, wd) && e.summonBlocked(0, wd, 'special', 'hand'), 'cannot be Normal Summoned or Special Summoned by other ways');
  place(e, 0, 'Hydrogeddon');
  place(e, 0, 'Hydrogeddon');
  place(e, 0, 'Oxygeddon');
  playSpell(e, 0, 'Bonding - H2O');
  const m = e.fieldCard(wd.uid)!;
  check(!!m, 'Special Summoned with "Bonding - H2O"');
  const pyro = place(e, 1, 'Blazing Inpachi');
  check(atk(e, pyro) === 0, 'FIRE / Pyro monsters have 0 ATK');
  kill(e, [m], 1, 'yes');
  check(onField(e, 0, 'Hydrogeddon').length === 2 && onField(e, 0, 'Oxygeddon').length === 1, 'destroyed: Special Summons 2 Hydrogeddon and 1 Oxygeddon from the GY');
}

section('Water Dragon Cluster');
{
  const e = duel(['Water Dragon Cluster', 'Water Dragon', 'Water Dragon'], ['Mystic Tomato']);
  const t = place(e, 1, 'Mystic Tomato')!;
  const c = e.player(0).deck.find((x) => x.name === 'Water Dragon Cluster')!;
  check(e.summonBlocked(0, c, 'special', 'deck'), 'must be Special Summoned with a "Bonding" card');
  e.state.fx.ignoreCond = c.uid;
  place(e, 0, 'Water Dragon Cluster', 'atk', true, 'yes');
  e.state.fx.ignoreCond = undefined;
  check(atk(e, t) === 0 && e.isNegated(t), "Special Summoned: the opponent's Effect Monsters have 0 ATK and no effects this turn");
  e.apply({ type: 'QUICK_EFFECT', player: 0, uid: c.uid });
  settle(e);
  const wds = onField(e, 0, 'Water Dragon');
  check(zone(e, c) === 'gy' && wds.length === 2 && wds.every((m) => m.pos === 'def'), 'Tributes itself to Special Summon 2 Water Dragon in Defense Position');
}

section('Weapon Change');
{
  const e = duel(['Weapon Change']);
  const m = place(e, 0, FILL)!;
  playSpell(e, 0, 'Weapon Change');
  toTurn3(e);
  settle(e);
  const e2 = duel(['Weapon Change']);
  const m2 = place(e2, 0, FILL)!;
  playSpell(e2, 0, 'Weapon Change');
  endTurn(e2);
  e2.apply({ type: 'END_TURN', player: 1 });
  settle(e2, 'yes');
  check(atk(e2, m2) === 1200 && def(e2, m2) === 1400 && lp(e2, 0) === 3300, 'Standby Phase: pays 700 LP to switch a Warrior\'s ATK and DEF');
  endTurn(e2);
  check(atk(e2, m2) === 1200, 'still switched during the opponent\'s turn');
  endTurn(e2);
  check(atk(e2, m2) === 1400 && def(e2, m2) === 1200, 'back after the end of the opponent\'s next turn');
  void m;
}

section('White Dragon Ritual');
{
  const e = duel(['White Dragon Ritual', 'Paladin of White Dragon']);
  place(e, 0, FILL);
  grab(e, 0, 'Paladin of White Dragon');
  playSpell(e, 0, 'White Dragon Ritual');
  check(onField(e, 0, 'Paladin of White Dragon').length === 1 && inGy(e, 0, FILL) === 1, 'Ritual Summons Paladin of White Dragon by Tributing Level 4');
}

section("White Elephant's Gift");
{
  const e = duel(["White Elephant's Gift"]);
  const m = place(e, 0, FILL);
  const hand = e.player(0).hand.length;
  playSpell(e, 0, "White Elephant's Gift");
  check(zone(e, m) === 'gy' && e.player(0).hand.length === hand + 2, 'sends a face-up non-Effect monster to the GY: draws 2');
}
{
  const e = duel(["White Elephant's Gift", 'Mystic Tomato']);
  place(e, 0, 'Mystic Tomato');
  const g = grab(e, 0, "White Elephant's Gift");
  check(!e.canActivateMain(0, g.uid), 'not with only an Effect Monster');
}

section('Wicked-Breaking Flamberge - Baou');
{
  const e = duel(['Wicked-Breaking Flamberge - Baou', 'Blue-Eyes White Dragon', 'Fissure'], ['UFOroid', 'Submarineroid']);
  const b = place(e, 0, 'Blue-Eyes White Dragon')!;
  const u = place(e, 1, 'UFOroid')!;
  grab(e, 0, 'Fissure');
  const eq = playSpell(e, 0, 'Wicked-Breaking Flamberge - Baou', { pick: ['Fissure'] }, { pick: ['Blue-Eyes White Dragon'] });
  check(!!eq && inGy(e, 0, 'Fissure') === 1 && atk(e, b) === 3500, 'sends a card from the hand, equips: +500 ATK');
  toTurn3(e);
  toBattle(e);
  attack(e, b, u, 'yes');
  check(zone(e, u) === 'gy' && onField(e, 1, 'Submarineroid').length === 0, 'the effects of monsters it destroys by battle are negated');
}

section('Wild Fire');
{
  const e = duel(['Blaze Accelerator', 'Wild Fire'], [FILL]);
  const ba = playSpell(e, 0, 'Blaze Accelerator');
  const a = place(e, 0, FILL);
  const b = place(e, 1, FILL);
  playSpell(e, 0, 'Wild Fire');
  const tok = e.monsters(0).find((m) => m.name === 'Wild Fire Token');
  check(zone(e, ba) === 'gy' && zone(e, a) === 'gy' && zone(e, b) === 'gy' && lp(e, 0) === 3500, 'pays 500 LP, destroys Blaze Accelerator and all monsters');
  check(!!tok && atk(e, tok) === 1000, 'then Special Summons a Wild Fire Token');
  check(((e.state.fx.noDeclare ?? []) as number[])[0] === e.state.turn, 'you cannot declare an attack this turn');
}

section("Wild Nature's Release");
{
  const e = duel(["Wild Nature's Release", 'Silver Fang']);
  const s = place(e, 0, 'Silver Fang');
  playSpell(e, 0, "Wild Nature's Release");
  check(atk(e, s) === 1200 + 800, 'the Beast gains ATK equal to its DEF');
  endTurn(e);
  check(zone(e, s) === 'gy', 'destroyed during the End Phase');
}

section('Wild Tornado');
{
  const e = duel(['Wild Tornado'], [FILL, 'Toon World', 'Fissure']);
  endTurn(e);
  const tw = playSpell(e, 1, 'Toon World');
  grab(e, 1, 'Fissure');
  endTurn(e);
  playTrap(e, 0, 'Wild Tornado', { pick: ['Toon World'] }, 'yes', { pick: ['Fissure'] });
  check(zone(e, tw) === 'gy', 'destroys a face-up card in the Spell & Trap Zone');
  check(e.spells(1).some((c) => c.name === 'Fissure' && !c.faceUp), 'then its controller can Set a Spell/Trap from the hand');
}
{
  const e = duel(['Wild Tornado', 'Toon World']);
  playSpell(e, 0, 'Toon World');
  const w = putST(e, 0, 'Wild Tornado');
  kill(e, [w], 1);
  check(inGy(e, 0, 'Toon World') === 1, 'this Set card is destroyed: destroys a face-up card on the field');
}

section('Winged Kuriboh');
{
  const e = duel(['Winged Kuriboh'], ['Dark Blade', 'Dark Blade']);
  const k = place(e, 0, 'Winged Kuriboh', 'def');
  endTurn(e);
  const a = place(e, 1, 'Dark Blade')!;
  const b = place(e, 1, 'Dark Blade')!;
  toBattle(e);
  attack(e, a, k);
  attack(e, b, null);
  check(zone(e, k) === 'gy' && lp(e, 0) === 4000, 'destroyed: you take no battle damage for the rest of the turn');
}

section('Wonder Garage');
{
  const e = duel(['Wonder Garage', 'Truckroid']);
  const w = putST(e, 0, 'Wonder Garage');
  grab(e, 0, 'Truckroid');
  kill(e, [w], 1, 'yes');
  check(onField(e, 0, 'Truckroid').length === 1, 'face-down card destroyed: Special Summons a "roid" from the hand');
}

section('Wonder Wand');
{
  const e = duel(['Wonder Wand', 'Mystical Elf']);
  const s = place(e, 0, 'Mystical Elf');
  place(e, 0, FILL);
  const w = playSpell(e, 0, 'Wonder Wand', { pick: ['Mystical Elf'] });
  check(atk(e, s) === 1300, 'equipped Spellcaster gains 500 ATK');
  const hand = e.player(0).hand.length;
  effect(e, 0, w);
  check(zone(e, s) === 'gy' && zone(e, w) === 'gy' && e.player(0).hand.length === hand + 2, 'sends both to the GY to draw 2');
}

section('Wroughtweiler');
{
  const e = duel(['Wroughtweiler', 'Elemental HERO Avian', 'Polymerization'], ['Dark Blade']);
  bury(e, 0, 'Elemental HERO Avian');
  bury(e, 0, 'Polymerization');
  const w = place(e, 0, 'Wroughtweiler');
  endTurn(e);
  const foe = place(e, 1, 'Dark Blade')!;
  toBattle(e);
  attack(e, foe, w);
  check(inHand(e, 0, 'Elemental HERO Avian') === 1 && inHand(e, 0, 'Polymerization') === 1, 'destroyed by battle: adds an "Elemental HERO" and Polymerization from the GY');
}

section('Yomi Ship');
{
  const e = duel(['Yomi Ship'], ['Dark Blade']);
  const y = place(e, 0, 'Yomi Ship');
  endTurn(e);
  const foe = place(e, 1, 'Dark Blade')!;
  toBattle(e);
  attack(e, foe, y);
  check(zone(e, y) === 'gy' && zone(e, foe) === 'gy', 'destroyed by battle: destroys the monster that destroyed it');
}

section('Zero Gravity');
{
  const e = duel(['Zero Gravity'], [FILL]);
  const a = place(e, 0, FILL)!;
  const b = place(e, 1, FILL, 'def')!;
  playTrap(e, 0, 'Zero Gravity');
  check(a.pos === 'def' && b.pos === 'atk', 'changes the battle positions of all face-up monsters');
}

section('Zolga');
{
  const e = duel(['Zolga', 'Summoned Skull']);
  place(e, 0, 'Zolga');
  summon(e, 0, 'Summoned Skull');
  check(lp(e, 0) === 6000, 'Tributed for a Tribute Summon: its owner gains 2000 LP');
}
{
  const e = duel(['Zolga', 'Tribute Doll', 'Dark Magician']);
  place(e, 0, 'Zolga');
  grab(e, 0, 'Dark Magician');
  playSpell(e, 0, 'Tribute Doll');
  check(lp(e, 0) === 4000, 'not when Tributed by a card effect');
}

section('Zoma the Spirit');
{
  const e = duel(['Zoma the Spirit'], ['Blue-Eyes White Dragon']);
  const z = playTrap(e, 0, 'Zoma the Spirit')!;
  check(zone(e, z) === 'mz' && z.pos === 'def' && atk(e, z) === 1800 && def(e, z) === 500, 'Special Summoned as a monster (ATK 1800 / DEF 500) in Defense Position');
  endTurn(e);
  const foe = place(e, 1, 'Blue-Eyes White Dragon')!;
  toBattle(e);
  attack(e, foe, z);
  check(zone(e, z) === 'gy' && lp(e, 1) === 1000, 'destroyed by battle: inflicts damage equal to the destroying monster\'s ATK');
}

section('Zombina');
{
  const e = duel(['Zombina', 'Petit Angel']);
  bury(e, 0, 'Petit Angel');
  const z = place(e, 0, 'Zombina');
  kill(e, [z], 1, 'yes');
  check(onField(e, 0, 'Petit Angel').length === 1, "destroyed by the opponent's card: Special Summons a Level 4 or lower monster from the GY");
}
{
  const e = duel(['Zombina', 'Petit Angel']);
  bury(e, 0, 'Petit Angel');
  const z = place(e, 0, 'Zombina');
  kill(e, [z], 0, 'yes');
  check(e.monsters(0).length === 0, 'not when you destroy it yourself');
}

section('Zombyra the Dark');
{
  const e = duel(['Zombyra the Dark'], ['Petit Angel']);
  const z = place(e, 0, 'Zombyra the Dark')!;
  toTurn3(e);
  toBattle(e);
  check(!e.canAttackWith(0, z), 'cannot attack directly');
  const foe = place(e, 1, 'Petit Angel')!;
  attack(e, z, foe);
  check(zone(e, foe) === 'gy' && atk(e, z) === 1900, 'destroys a monster by battle: loses 200 ATK');
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
if (fails) process.exit(1);
