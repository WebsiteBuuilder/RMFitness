// Speed Duel card scripts of batch 08, audited card by card (run: npx tsx tests/audit-08.test.ts)
// One or more targeted checks per card: its main effect really happens in a duel (and, where cheap, does not when it should not).
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
  const full = { id: 980000 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
fake({ name: 'Temple of the Kings', kind: 'spell', sub: 'Continuous', desc: 'Test stand-in.' });
fake({ name: 'Noble Arms - Test Blade', kind: 'spell', sub: 'Equip', desc: 'Test stand-in.' });
fake({ name: 'Noble Arms - Test Shield', kind: 'spell', sub: 'Equip', desc: 'Test stand-in.' });
fake({ name: 'Noble Arms - Test Lance', kind: 'spell', sub: 'Equip', desc: 'Test stand-in.' });
fake({ name: 'Nordic Test Beast', sub: 'Normal', level: 4, atk: 1500, def: 1000, race: 'Beast', attribute: 'EARTH' });
fake({ name: 'Nordic Relic Test Ring', kind: 'spell', sub: 'Normal', desc: 'Test stand-in.' });
fake({ name: 'Alien Test Grey', sub: 'Normal', level: 4, atk: 1600, def: 1000, race: 'Reptile', attribute: 'LIGHT' });
fake({ name: 'Magic Hand', sub: 'Normal', level: 4, atk: 1600, def: 1000, race: 'Fiend', attribute: 'DARK' });
fake({ name: 'Test Overload Machine', sub: 'Fusion', level: 8, atk: 2800, def: 2000, race: 'Machine', attribute: 'DARK', desc: '"Stealthroid" + "Drillroid"' });
fake({ name: 'Gem-Knight Test Fusion', sub: 'Fusion', level: 6, atk: 2400, def: 1800, race: 'Rock', attribute: 'EARTH', desc: '"Gem-Knight Emerald" + "Celtic Guardian"' });
fake({ name: 'Test Ninja Dragon', sub: 'Normal', level: 5, atk: 2000, def: 1000, race: 'Dragon', attribute: 'DARK' });
const atk = (e: Engine, c: FieldCard | null) => (c ? e.atkOf(c) : -1);
/** Puts a face-up, active Continuous/Field Spell or Trap on the field directly. */
function activeST(e: Engine, p: Pid, name: string): FieldCard {
  const fc = putST(e, p, name);
  fc.faceUp = true;
  fc.active = true;
  return fc;
}
/** Special Summons a card ignoring its Summoning conditions. */
function placeAny(e: Engine, p: Pid, name: string, pos: Pos = 'atk'): FieldCard | null {
  const c = [...e.player(p).deck, ...e.player(p).gy, ...e.player(p).fusion, ...e.player(p).hand].find((x) => x.name === name)!;
  e.state.fx.ignoreCond = c.uid;
  e.state.fx.contactSummon = c.uid;
  const f = place(e, p, name, pos);
  e.state.fx.ignoreCond = undefined;
  e.state.fx.contactSummon = undefined;
  return f;
}
const inHand = (e: Engine, p: Pid, name: string) => e.player(p).hand.some((c) => c.name === name);
const toGy = (e: Engine, p: Pid, ...names: string[]) => {
  for (const n of names) {
    const c = [...e.player(p).deck, ...e.player(p).hand].find((x) => x.name === n);
    if (!c) throw new Error(`no ${n}`);
    run(e, e.sendToGrave(c.uid, 'cost'));
  }
};
/** Turn 3, player 0's Battle Phase. */
const battle = (e: Engine) => {
  toTurn3(e);
  toBattle(e);
};

// ======================= M =======================
section('Mixeroid');
{
  const e = duel(['Mixeroid', 'Drillroid', 'Gyroid']);
  const mix = place(e, 0, 'Mixeroid')!;
  effect(e, 0, mix, { pick: ['Mixeroid'] }, { pick: ['Drillroid'] });
  check(zone(e, mix) === 'gy' && e.monsters(0).some((m) => m.name === 'Drillroid'), 'Tribute a Machine: Special Summon a non-WIND "roid" from the Deck');
  check(e.player(0).deck.some((c) => c.name === 'Gyroid'), 'a WIND "roid" cannot be chosen');
}
{
  const e = duel(['Mixeroid', 'Drillroid', 'Stealthroid', 'Steamroid', 'Truckroid', 'Expressroid'], [], ['Steam Gyroid']);
  const mix = grab(e, 0, 'Mixeroid');
  toGy(e, 0, 'Mixeroid', 'Drillroid', 'Stealthroid');
  check(!e.canUseGraveEffect(0, mix.uid), 'needs as many Machines in the GY as the Fusion Monster\'s Level');
  toGy(e, 0, 'Steamroid', 'Truckroid', 'Expressroid');
  const before = lp(e, 0);
  e.apply({ type: 'GRAVE_EFFECT', player: 0, uid: mix.uid });
  settle(e, { pick: ['Steam Gyroid'] }, { pick: ['Drillroid', 'Stealthroid', 'Steamroid', 'Truckroid', 'Expressroid'] });
  const sg = e.monsters(0).find((m) => m.name === 'Steam Gyroid');
  check(!!sg && lp(e, 0) === before / 2 && zone(e, mix) === 'removed' && e.player(0).removed.length === 6, 'pay half LP, banish 6 Machines incl. itself: Special Summon a Level 6 "roid" Fusion');
  endTurn(e);
  check(!!sg && zone(e, sg) !== 'mz', 'the Fusion Monster is destroyed during the End Phase');
}

section('Mobius the Frost Monarch');
{
  const e = duel(['Mobius the Frost Monarch'], ['Trap Hole', 'Mirror Force']);
  place(e, 0, FILL);
  const a = activeST(e, 1, 'Trap Hole');
  const b = activeST(e, 1, 'Mirror Force');
  const m = summon(e, 0, 'Mobius the Frost Monarch', true, 'yes', { pick: ['Trap Hole', 'Mirror Force'] });
  check(!!m && zone(e, a) === 'gy' && zone(e, b) === 'gy', 'Tribute Summoned: destroys up to 2 Spell/Trap Cards');
}

section('Moisture Creature');
{
  const e = duel(['Moisture Creature'], ['Trap Hole', 'Mirror Force']);
  for (let i = 0; i < 3; i++) place(e, 0, FILL);
  const a = activeST(e, 1, 'Trap Hole');
  const mc = grab(e, 0, 'Moisture Creature');
  check(e.canSpecialProc(0, mc), 'can be Tribute Summoned with 3 Tributes');
  e.apply({ type: 'SPECIAL', player: 0, uid: mc.uid });
  settle(e);
  check(zone(e, mc) === 'mz' && e.monsters(0).length === 1 && e.player(0).normalSummoned, 'Tributes 3 monsters and uses the Normal Summon');
  check(zone(e, a) === 'gy', 'destroys all Spells/Traps the opponent controls');
  check(!logHas(e, 'Special Summoned Moisture'), 'it is a Tribute Summon, not a Special Summon');
}
{
  const e = duel(['Moisture Creature'], ['Trap Hole']);
  place(e, 0, FILL);
  place(e, 0, FILL);
  const a = activeST(e, 1, 'Trap Hole');
  summon(e, 0, 'Moisture Creature');
  check(e.monsters(0).some((m) => m.name === 'Moisture Creature') && zone(e, a) === 'sz', 'a 2-Tribute Summon destroys nothing');
}

section('Mokey Mokey Adrift');
{
  const e = duel(['Mokey Mokey Adrift', 'Mokey Mokey', 'Mokey Mokey Smackdown']);
  const adr = grab(e, 0, 'Mokey Mokey Adrift');
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: adr.uid });
  settle(e, { pick: ['Mokey Mokey'] });
  check(zone(e, adr) === 'gy' && inHand(e, 0, 'Mokey Mokey'), 'discard it: add a "Mokey Mokey" card from the Deck');
  const f = place(e, 0, 'Mokey Mokey Adrift')!;
  check(e.effectOn(f)?.fieldName?.(e, f) === 'Mokey Mokey', 'its name becomes "Mokey Mokey" on the field');
}

section('Mokey Mokey King');
{
  const e = duel(['Mokey Mokey', 'Mokey Mokey', 'Mokey Mokey Adrift'], [FILL], ['Mokey Mokey King']);
  toGy(e, 0, 'Mokey Mokey', 'Mokey Mokey', 'Mokey Mokey Adrift');
  const k = place(e, 0, 'Mokey Mokey King')!;
  run(e, e.as(1, (function* () {
    e.toHand(k.uid);
    yield* e.flushLeaves();
  })()), 'yes');
  check(e.monsters(0).length === 3 && e.player(0).fusion.some((c) => c.name === 'Mokey Mokey King'), 'removed from the field (returned): Special Summons as many "Mokey Mokey" as possible from the GY');
}

section('Mokey Mokey Smackdown');
{
  const e = duel(['Mokey Mokey Smackdown', 'Mokey Mokey', 'Mudora'], [FILL]);
  playSpell(e, 0, 'Mokey Mokey Smackdown');
  const mm = place(e, 0, 'Mokey Mokey')!;
  const f = place(e, 0, FILL)!;
  kill(e, [f], 1);
  check(atk(e, mm) === 300, 'a non-Fairy destroyed: nothing happens');
  const elf = place(e, 0, 'Mudora')!;
  kill(e, [elf], 1);
  check(atk(e, mm) === 3000, 'a Fairy you control is destroyed by a card effect: each "Mokey Mokey" becomes 3000 ATK');
  endTurn(e);
  check(atk(e, mm) === 300, 'until the end of the turn');
}

section('Monster Rebirth');
{
  const e = duel(['Monster Rebirth', 'Monster Reborn'], ['Gemini Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  const me = place(e, 0, FILL)!;
  const me2 = place(e, 0, FILL)!;
  const rb = putST(e, 0, 'Monster Rebirth');
  check(!e.canActivateMain(0, rb.uid), 'cannot be activated before a monster is destroyed by battle this turn');
  battle(e);
  me.atkMod = 2000;
  attack(e, me, elf);
  check(zone(e, elf) === 'gy', 'a monster was destroyed by battle');
  // later in the turn (the next attack declaration) it can be activated
  attack(e, me2, null, { respond: 'Monster Rebirth' }, { pick: ['Monster Reborn'] }, { pick: ['Gemini Elf'] });
  check(zone(e, elf) === 'mz' && e.controller(elf.uid) === 0 && e.player(0).gy.some((c) => c.name === 'Monster Reborn'), 'later that turn: sends "Monster Reborn" from the Deck, then Special Summons a monster from either GY');
}

section('Moray of Greed');
{
  const e = duel(['Moray of Greed', 'Needle Sunfish', 'Oyster Meister']);
  grab(e, 0, 'Needle Sunfish');
  grab(e, 0, 'Oyster Meister');
  const hand = e.player(0).hand.length;
  playSpell(e, 0, 'Moray of Greed', { pick: ['Needle Sunfish', 'Oyster Meister'] });
  check(logHas(e, 'drew 3 cards') && e.player(0).hand.length === hand - 2 + 3, 'shuffles 2 WATER monsters from the hand into the Deck, then draws 3');
}

section('Mudora');
{
  const e = duel(['Mudora', 'Mokey Mokey Adrift', 'Mokey Mokey']);
  const m = place(e, 0, 'Mudora')!;
  toGy(e, 0, 'Mokey Mokey Adrift', 'Mokey Mokey', FILL);
  check(atk(e, m) === 1500 + 400, 'gains 200 ATK for each Fairy in your GY');
}

section('Mudora the Sword Oracle');
{
  const e = duel(['Mudora the Sword Oracle', 'Mudora', "Gravekeeper's Trap"], ['Gemini Elf', 'Mystical Elf']);
  const mo = grab(e, 0, 'Mudora the Sword Oracle');
  grab(e, 0, 'Mudora');
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: mo.uid });
  settle(e, { pick: ['Mudora'] }, 'yes');
  check(zone(e, mo) === 'mz' && e.player(0).gy.some((c) => c.name === 'Mudora'), 'discard another EARTH Fairy: Special Summon it from the hand');
  check(e.player(0).sz.some((c) => c?.name === "Gravekeeper's Trap" && c.faceUp), 'then places "Gravekeeper\'s Trap" from the Deck face-up');
  toGy(e, 1, 'Gemini Elf', 'Mystical Elf');
  e.apply({ type: 'QUICK_EFFECT', player: 0, uid: mo.uid });
  settle(e, { pick: ['Gemini Elf', 'Mystical Elf'] });
  check(zone(e, mo) === 'removed' && e.player(1).gy.length === 0, 'Quick Effect: banish it, shuffle up to 3 cards from the GYs into the Deck');
}

section('Multiplication of Ants');
{
  const e = duel(['Multiplication of Ants', 'Pinch Hopper', 'Mobius the Frost Monarch']);
  const ph = place(e, 0, 'Pinch Hopper')!;
  playSpell(e, 0, 'Multiplication of Ants');
  const ants = e.monsters(0).filter((m) => m.name === 'Army Ant Token');
  check(zone(e, ph) === 'gy' && ants.length === 2 && atk(e, ants[0]) === 500 && e.defOf(ants[0]) === 1200, 'Tribute an Insect: Special Summon 2 "Army Ant Tokens" (500/1200)');
  check(!e.canNormalSummon(0, grab(e, 0, 'Mobius the Frost Monarch'), true), 'the tokens cannot be Tributed for a Tribute Summon');
}

section('Musto, Oracle of Gusto');
{
  const e = duel(['Musto, Oracle of Gusto', 'Caam, Serenity of Gusto'], ['Mudora']);
  const m = place(e, 0, 'Musto, Oracle of Gusto')!;
  toGy(e, 0, 'Caam, Serenity of Gusto');
  const md = place(e, 1, 'Mudora')!;
  effect(e, 0, m, { pick: ['Mudora'] });
  check(e.player(0).deck.some((c) => c.name === 'Caam, Serenity of Gusto') && e.isNegated(md), 'shuffles a "Gusto" monster from the GY into the Deck and negates a face-up monster');
  endTurn(e);
  check(!e.isNegated(md), 'until the End Phase');
}

section('Mysterious Guard');
{
  const e = duel(['Mysterious Guard'], ['Gemini Elf', 'Mystical Elf']);
  const w = place(e, 0, FILL)!;
  const g = place(e, 0, 'Mysterious Guard', 'def', false)!;
  const a = place(e, 1, 'Gemini Elf')!;
  const b = place(e, 1, 'Mystical Elf')!;
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: g.uid });
  settle(e, { pick: ['Gemini Elf'] }, 'yes', { pick: ['Mystical Elf'] });
  check(e.player(1).deck[0]?.uid === a.uid && zone(e, b) === 'hand' && !!w, 'FLIP: 1 monster to the top of the Deck, and (with a Warrior) 1 more to the hand');
}

section('Mystical Beast of Serket');
{
  const e = duel(['Mystical Beast of Serket', 'Temple of the Kings'], ['Gemini Elf']);
  const t = activeST(e, 0, 'Temple of the Kings');
  const s = place(e, 0, 'Mystical Beast of Serket')!;
  check(zone(e, s) === 'mz', 'stays while you control "Temple of the Kings"');
  const elf = place(e, 1, 'Gemini Elf')!;
  battle(e);
  attack(e, s, elf);
  check(zone(e, elf) === 'removed' && atk(e, s) === 3000, 'the monster it destroys by battle is banished, and it gains 500 ATK');
  run(e, e.sendToGrave(t.uid, 'cost'));
  check(zone(e, s) === 'gy', 'without "Temple of the Kings" it is destroyed');
}


// ======================= N =======================
fake({ name: 'Test Rank 3 Xyz', sub: 'Xyz', rank: 3, atk: 2000, def: 1000, race: 'Warrior', attribute: 'LIGHT', desc: '2 Level 3 monsters' });
/** Moves a card of `p` to the top of the Deck (the next draw). */
const onTop = (e: Engine, p: Pid, name: string) => {
  const ps = e.player(p);
  const from = ps.deck.some((c) => c.name === name) ? ps.deck : ps.hand;
  const i = from.findIndex((c) => c.name === name);
  ps.deck.unshift(from.splice(i, 1)[0]);
};

section('NEXT');
{
  const e = duel(['NEXT', 'Neo-Spacian Air Hummingbird', 'Neo-Spacian Glow Moss', 'Neo-Spacian Grand Mole']);
  grab(e, 0, 'Neo-Spacian Air Hummingbird');
  toGy(e, 0, 'Neo-Spacian Glow Moss');
  playTrap(e, 0, 'NEXT', { pick: ['Neo-Spacian Air Hummingbird'] }, { pick: ['Neo-Spacian Glow Moss'] }, 'pass');
  const ms = e.monsters(0);
  check(ms.length === 2 && ms.every((m) => m.pos === 'def' && e.isNegated(m)), 'Special Summons "Neo-Spacian" monsters from the hand and GY in Defense Position, with their effects negated');
  check(e.summonBlocked(0, 'Test Rank 3 Xyz', 'special', 'fusion') && !e.summonBlocked(0, 'Elemental HERO Flame Wingman', 'special', 'fusion'), 'while you control them, only Fusion Monsters can be Special Summoned from the Extra Deck');
  const n2 = putST(e, 0, 'NEXT');
  check(!e.canActivateMain(0, n2.uid), 'only 1 "NEXT" per turn');
}
{
  const e = duel(['NEXT', 'Neo-Spacian Grand Mole']);
  grab(e, 0, 'Neo-Spacian Grand Mole');
  const n = grab(e, 0, 'NEXT');
  check(e.canUseQuickNow(0, n.uid), 'if you control no cards, it can be activated from the hand');
  e.apply({ type: 'QUICK_EFFECT', player: 0, uid: n.uid });
  settle(e, { pick: ['Neo-Spacian Grand Mole'] });
  check(e.monsters(0).some((m) => m.name === 'Neo-Spacian Grand Mole') && zone(e, n) === 'gy', 'activated from the hand: the monster is Summoned and NEXT goes to the GY');
}

section('Needle Sunfish');
{
  const e = duel(['Needle Sunfish'], ['Gemini Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  toGy(e, 0, 'Needle Sunfish');
  check(atk(e, elf) === 1900 - 500, "sent to the GY: an opponent's face-up monster loses 500 ATK");
}

section('Neo Space');
{
  const e = duel(['Neo Space', 'Elemental HERO Neos'], [], ['Elemental HERO Aqua Neos']);
  playSpell(e, 0, 'Neo Space');
  const neos = place(e, 0, 'Elemental HERO Neos')!;
  const aq = placeAny(e, 0, 'Elemental HERO Aqua Neos')!;
  check(atk(e, neos) === 3000 && atk(e, aq) === 3000, '"Elemental HERO Neos" and Fusions that list it gain 500 ATK');
  endTurn(e);
  check(zone(e, aq) === 'mz', 'those Fusion Monsters do not return to the Extra Deck in the End Phase');
}
{
  const e = duel(['Elemental HERO Neos'], [], ['Elemental HERO Aqua Neos']);
  const aq = placeAny(e, 0, 'Elemental HERO Aqua Neos')!;
  endTurn(e);
  check(zone(e, aq) === 'fusion', 'without Neo Space, Aqua Neos returns to the Extra Deck');
}

section('Neo-Spacian Air Hummingbird');
{
  const e = duel(['Neo-Spacian Air Hummingbird']);
  const h = place(e, 0, 'Neo-Spacian Air Hummingbird')!;
  const n = e.player(1).hand.length;
  effect(e, 0, h);
  check(lp(e, 0) === 4000 + 500 * n, "gains 500 LP for each card in the opponent's hand");
}

section('Neo-Spacian Aqua Dolphin');
{
  const e = duel(['Neo-Spacian Aqua Dolphin']);
  const d = place(e, 0, 'Neo-Spacian Aqua Dolphin')!;
  place(e, 0, FILL);
  const n = e.player(1).hand.length;
  effect(e, 0, d, { pick: [FILL] });
  check(e.player(1).hand.length === n - 1 && lp(e, 1) === 3500, 'discard 1: destroys a monster in the opponent\'s hand you can match in ATK, and inflicts 500 damage');
}
{
  const e = duel(['Neo-Spacian Aqua Dolphin']);
  const d = place(e, 0, 'Neo-Spacian Aqua Dolphin')!;
  effect(e, 0, d, { pick: [FILL] });
  check(lp(e, 0) === 3500 && e.player(1).hand.length === 4, 'otherwise you take 500 damage');
}

section('Neo-Spacian Glow Moss');
{
  const e = duel(['Neo-Spacian Glow Moss'], [FILL, 'Pot of Greed', 'Trap Hole']);
  const g = place(e, 0, 'Neo-Spacian Glow Moss')!;
  const t = place(e, 1, FILL, 'def')!;
  battle(e);
  onTop(e, 1, 'Trap Hole');
  attack(e, g, t);
  check(inHand(e, 1, 'Trap Hole') && g.pos === 'def' && zone(e, t) === 'mz', 'attacks: the opponent draws a Trap, so it changes to Defense Position');
}
{
  const e = duel(['Neo-Spacian Glow Moss', 'Neo-Spacian Glow Moss'], [FILL, 'Pot of Greed']);
  const g = place(e, 0, 'Neo-Spacian Glow Moss')!;
  const t = place(e, 1, FILL, 'def')!;
  battle(e);
  onTop(e, 1, 'Pot of Greed');
  attack(e, g, t, 'yes');
  check(lp(e, 1) === 4000 - 300, 'a Spell: it can attack directly instead');
}
{
  const e = duel(['Neo-Spacian Glow Moss'], [FILL, 'Gemini Elf']);
  const g = place(e, 0, 'Neo-Spacian Glow Moss')!;
  const f2 = place(e, 0, FILL)!;
  place(e, 1, FILL, 'def');
  battle(e);
  onTop(e, 1, 'Gemini Elf');
  attack(e, g, e.monsters(1)[0]);
  check(!e.canAttackWith(0, f2) && e.monsters(1).length === 1, 'a Monster: the Battle Phase ends');
}

section('Neo-Spacian Grand Mole');
{
  const e = duel(['Neo-Spacian Grand Mole'], ['Gemini Elf']);
  const m = place(e, 0, 'Neo-Spacian Grand Mole')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  battle(e);
  attack(e, m, elf, { respond: 'Neo-Spacian Grand Mole' });
  check(zone(e, m) === 'hand' && zone(e, elf) === 'hand', 'returns both battling monsters to the hand');
}

section('Neos Force');
{
  const e = duel(['Neos Force', 'Elemental HERO Neos'], ['Gemini Elf']);
  toTurn3(e);
  const neos = place(e, 0, 'Elemental HERO Neos')!;
  const nf = playSpell(e, 0, 'Neos Force')!;
  check(atk(e, neos) === 3300, 'equipped "Elemental HERO Neos" gains 800 ATK');
  const elf = place(e, 1, 'Gemini Elf')!;
  toBattle(e);
  attack(e, neos, elf);
  check(lp(e, 1) === 4000 - 1400 - 1900, 'destroys a monster by battle: inflicts damage equal to its original ATK');
  endTurn(e);
  check(e.player(0).deck.some((c) => c.uid === nf.uid), 'shuffled into the Deck during the End Phase');
}

section('Newdoria');
{
  const e = duel(['Newdoria'], ['Gemini Elf', FILL]);
  const n = place(e, 0, 'Newdoria')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  place(e, 1, FILL);
  battle(e);
  attack(e, n, elf, { pick: ['Gemini Elf'] });
  check(zone(e, n) === 'gy' && zone(e, elf) === 'gy', 'destroyed by battle: destroys a monster on the field');
}

section('Night Assailant');
{
  const e = duel(['Night Assailant', 'Mysterious Guard', 'Night Assailant'], ['Gemini Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  const na = place(e, 0, 'Night Assailant', 'def', false)!;
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: na.uid });
  settle(e);
  check(zone(e, elf) === 'gy', "FLIP: destroys a monster the opponent controls");
  toGy(e, 0, 'Mysterious Guard');
  const na2 = grab(e, 0, 'Night Assailant');
  run(e, e.discard(0, na2.uid));
  check(inHand(e, 0, 'Mysterious Guard'), 'sent from the hand to the GY: returns a Flip monster from the GY to the hand');
}

section('Night Beam');
{
  const e = duel(['Night Beam'], ['Quantum Cat']);
  const q = putST(e, 1, 'Quantum Cat');
  playSpell(e, 0, 'Night Beam', { respond: 'Quantum Cat' });
  check(zone(e, q) === 'gy' && !e.monsters(1).length, 'destroys a Set Spell/Trap, which cannot be activated in response');
}

section('Nightmare Penguin');
{
  const e = duel(['Nightmare Penguin', 'Needle Sunfish'], ['Gemini Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  const s = place(e, 0, 'Needle Sunfish')!;
  const np = place(e, 0, 'Nightmare Penguin', 'def', false)!;
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: np.uid });
  settle(e);
  check(zone(e, elf) === 'hand', 'flipped face-up: returns a card the opponent controls to the hand');
  check(atk(e, s) === 1700 && atk(e, np) === 1100, 'face-up WATER monsters you control gain 200 ATK');
}

section('Nightmare Wheel');
{
  const e = duel(['Nightmare Wheel'], ['Gemini Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  playTrap(e, 0, 'Nightmare Wheel');
  endTurn(e);
  check(!e.canAttackWith(1, elf) && (e.state.phase !== 'BP' || true), 'the target cannot attack');
  check(!e.canChangePosition(1, elf), 'nor change its battle position');
  const before = lp(e, 1);
  endTurn(e);
  check(lp(e, 1) === before - 500, 'during your Standby Phase: 500 damage');
  kill(e, [elf], 0);
  check(!e.player(0).sz.some((c) => c?.name === 'Nightmare Wheel'), 'it leaves the field with the monster');
}

section('Ninjitsu Art of Super-Transformation');
{
  const e = duel(['Ninjitsu Art of Super-Transformation', 'Strike Ninja', 'Test Ninja Dragon', 'Blue-Eyes White Dragon'], ['Gemini Elf']);
  const ninja = place(e, 0, 'Strike Ninja')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  const card = playTrap(e, 0, 'Ninjitsu Art of Super-Transformation', { pick: ['Strike Ninja'] }, { pick: ['Gemini Elf'] }, { pick: ['Test Ninja Dragon'] });
  const dr = e.monsters(0).find((m) => m.name === 'Test Ninja Dragon');
  check(zone(e, ninja) === 'gy' && zone(e, elf) === 'gy' && !!dr, 'sends both targets to the GY and Special Summons a Dragon whose Level fits their combined original Levels');
  kill(e, [card], 1);
  check(!!dr && zone(e, dr) === 'removed', 'when it leaves the field, that monster is banished');
}

section('Noble Knight Borz');
{
  const e = duel(['Noble Knight Borz', 'Noble Arms - Test Blade', 'Noble Arms - Test Shield', 'Noble Arms - Test Lance', 'Noble Arms - Test Blade']);
  const b = place(e, 0, 'Noble Knight Borz')!;
  check(levelOf(e, b) === 4 && !e.canUseMonsterEffect(0, b), 'unequipped: Level 4 and no effect');
  const eq = putST(e, 0, 'Noble Arms - Test Blade');
  eq.faceUp = true;
  eq.active = true;
  eq.equippedTo = b.uid;
  b.equips.push(eq.uid);
  run(e, (function* () {})());
  check(levelOf(e, b) === 5 && e.state.fx.declAttr?.[b.uid] === 'DARK', 'equipped with a "Noble Arms": DARK and its Level increases by 1');
  effect(e, 0, b, { pick: ['Noble Arms - Test Blade', 'Noble Arms - Test Shield', 'Noble Arms - Test Lance'] });
  check(e.player(0).hand.filter((c) => c.name.startsWith('Noble Arms')).length === 1 && e.player(0).gy.filter((c) => c.name.startsWith('Noble Arms')).length === 2, 'reveals 3 "Noble Arms": 1 random one to the hand, the rest to the GY');
}

section('Nopenguin');
{
  const e = duel(['Nopenguin', 'Penguin Knight']);
  const no = grab(e, 0, 'Nopenguin');
  toGy(e, 0, 'Nopenguin');
  const pk = grab(e, 0, 'Penguin Knight');
  const link = { card: pk, loc: e.find(pk.uid)!.loc, player: 0 as Pid, label: pk.name, negated: false, payload: { effect: 'quick' } };
  check(e.responsesFor(0, 'effect', { uid: pk.uid, link }).some((o) => o.uid === no.uid), 'when an effect of a "Penguin" monster is activated: it can be Special Summoned from the GY');
}
{
  const e = duel(['Nopenguin', 'Nightmare Penguin'], ['Gemini Elf']);
  place(e, 0, 'Nopenguin');
  const elf = place(e, 1, 'Gemini Elf')!;
  const np = place(e, 0, 'Nightmare Penguin', 'def', false)!;
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: np.uid });
  settle(e);
  check(zone(e, elf) === 'removed', 'a card a "Penguin" effect would return to the hand is banished instead');
}

section('Nordic Relic Draupnir');
{
  const e = duel(['Nordic Relic Draupnir', 'Nordic Test Beast', 'Nordic Relic Test Ring']);
  const b = place(e, 0, 'Nordic Test Beast')!;
  const d = playSpell(e, 0, 'Nordic Relic Draupnir')!;
  check(atk(e, b) === 2300, 'equipped "Nordic" monster gains 800 ATK');
  kill(e, [d], 1, 'yes', { pick: ['Nordic Relic Test Ring'] });
  check(inHand(e, 0, 'Nordic Relic Test Ring'), 'destroyed by a card effect: adds a "Nordic Relic" card from the Deck');
}

section('Nordic Relic Laevateinn');
{
  const e = duel([FILL], ['Nordic Relic Laevateinn', 'Mudora']);
  const me = place(e, 0, FILL)!;
  const foe = place(e, 1, 'Mudora', 'def')!;
  const lv = putST(e, 1, 'Nordic Relic Laevateinn');
  battle(e);
  check(!e.responsesFor(1, 'attack', { uid: me.uid }).some((o) => o.uid === lv.uid), 'cannot be activated before a monster destroyed one by battle');
  me.atkMod = 1000;
  attack(e, me, foe, { respond: 'Nordic Relic Laevateinn' });
  check(zone(e, foe) === 'gy' && zone(e, me) === 'gy', 'destroys the monster that destroyed a monster by battle this turn');
}


// ======================= O =======================
section('O - Oversoul');
{
  const e = duel(['O - Oversoul', 'Elemental HERO Avian']);
  toGy(e, 0, 'Elemental HERO Avian');
  playSpell(e, 0, 'O - Oversoul');
  check(e.monsters(0).some((m) => m.name === 'Elemental HERO Avian'), 'Special Summons an "Elemental HERO" Normal Monster from the GY');
}

section('Obnoxious Celtic Guard');
{
  const e = duel(['Obnoxious Celtic Guard'], ['Gemini Elf', FILL]);
  const g = place(e, 0, 'Obnoxious Celtic Guard')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  battle(e);
  attack(e, g, elf);
  check(zone(e, g) === 'mz' && lp(e, 0) === 3500, 'not destroyed by battle with a monster with 1900 or more ATK');
}
{
  const e = duel(['Obnoxious Celtic Guard'], ['Gemini Elf']);
  const g = place(e, 0, 'Obnoxious Celtic Guard')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  battle(e);
  elf.atkMod = -200;
  attack(e, g, elf);
  check(zone(e, g) === 'gy', 'a 1700 ATK monster destroys it');
}

section('Obsidian Dragon');
{
  const e = duel(['Obsidian Dragon', 'Offerings to the Doomed']);
  const o = place(e, 0, 'Obsidian Dragon')!;
  playSpell(e, 0, 'Offerings to the Doomed');
  check(zone(e, o) === 'mz' && e.player(0).gy.some((c) => c.name === 'Offerings to the Doomed'), 'a Spell that targets only it (a DARK monster you control) is negated and leaves the field');
}

section('Ocean Dragon Lord - Neo-Daedalus');
{
  const e = duel(['Ocean Dragon Lord - Neo-Daedalus', 'Levia-Dragon - Daedalus', 'Umi', 'Ocean Dragon Lord - Neo-Daedalus'], ['Gemini Elf', 'Trap Hole']);
  const nd2 = e.player(0).deck.filter((c) => c.name === 'Ocean Dragon Lord - Neo-Daedalus')[1];
  run(e, e.sendToGrave(nd2.uid, 'cost'));
  check(e.summonBlocked(0, nd2, 'special', 'gy'), 'cannot be Special Summoned except by its own procedure');
  place(e, 0, 'Levia-Dragon - Daedalus');
  const nd = grab(e, 0, 'Ocean Dragon Lord - Neo-Daedalus');
  e.apply({ type: 'SPECIAL', player: 0, uid: nd.uid });
  settle(e);
  check(zone(e, nd) === 'mz' && e.player(0).gy.some((c) => c.name === 'Levia-Dragon - Daedalus'), 'Special Summoned by Tributing "Levia-Dragon - Daedalus"');
  playSpell(e, 0, 'Umi');
  place(e, 1, 'Gemini Elf');
  activeST(e, 1, 'Trap Hole');
  effect(e, 0, nd);
  check(zone(e, nd) === 'mz' && e.player(0).hand.length === 0 && e.player(1).hand.length === 0 && !e.monsters(1).length && !e.spells(1).length && !e.player(0).field, 'sends "Umi": every other card in the hands and on the field goes to the GY');
}

section('Offerings to the Doomed');
{
  const e = duel(['Offerings to the Doomed'], ['Gemini Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  playSpell(e, 0, 'Offerings to the Doomed');
  check(zone(e, elf) === 'gy', 'destroys a face-up monster');
  const n = e.player(0).hand.length;
  toTurn3(e);
  check(e.player(0).hand.length === n && logHas(e, 'Draw Phase is skipped'), 'and you skip your next Draw Phase');
}

section('Ojama Blue');
{
  const e = duel(['Ojama Blue', FILL, 'Ojama Green', 'Ojama Yellow'], ['Gemini Elf']);
  const b = place(e, 0, 'Ojama Blue')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  battle(e);
  attack(e, b, elf, 'yes');
  check(zone(e, b) === 'gy' && inHand(e, 0, 'Ojama Green') && inHand(e, 0, 'Ojama Yellow'), 'destroyed by battle: adds 2 "Ojama" cards from the Deck');
}

section('Ojama Country');
{
  const e = duel(['Ojama Country', 'Ojama Green', 'Ojama Yellow', 'Ojama Black'], ['Gemini Elf']);
  playSpell(e, 0, 'Ojama Country');
  const elf = place(e, 1, 'Gemini Elf')!;
  check(atk(e, elf) === 1900, 'no face-up "Ojama": nothing changes');
  const g = place(e, 0, 'Ojama Green')!;
  check(atk(e, elf) === 900 && e.defOf(elf) === 1900 && atk(e, g) === 1000 && e.defOf(g) === 0, 'with a face-up "Ojama": original ATK and DEF of all monsters are switched');
  toGy(e, 0, 'Ojama Black');
  grab(e, 0, 'Ojama Yellow');
  const oc = e.player(0).field!;
  effect(e, 0, oc, { pick: ['Ojama Yellow'] });
  check(e.monsters(0).some((m) => m.name === 'Ojama Black'), 'send an "Ojama" card from the hand: Special Summon an "Ojama" from the GY');
}

section('Ojama Delta Hurricane!!');
{
  const e = duel(['Ojama Delta Hurricane!!', 'Ojama Green', 'Ojama Yellow', 'Ojama Black'], ['Gemini Elf', 'Trap Hole']);
  for (const n of ['Ojama Green', 'Ojama Yellow', 'Ojama Black']) place(e, 0, n);
  place(e, 1, 'Gemini Elf');
  activeST(e, 1, 'Trap Hole');
  playSpell(e, 0, 'Ojama Delta Hurricane!!');
  check(!e.monsters(1).length && !e.spells(1).length, 'with the 3 Ojamas: destroys every card the opponent controls');
}

section('Ojama Red');
{
  const e = duel(['Ojama Red', 'Ojama Green', 'Ojama Yellow']);
  grab(e, 0, 'Ojama Green');
  grab(e, 0, 'Ojama Yellow');
  summon(e, 0, 'Ojama Red', true, 'yes', { pick: ['Ojama Green', 'Ojama Yellow'] });
  check(e.monsters(0).length === 3, 'Normal Summoned: Special Summons "Ojama" monsters from the hand');
}

section('Ojamagic');
{
  const e = duel(['Ojamagic', 'Ojama Green', 'Ojama Yellow', 'Ojama Black']);
  playSpell(e, 0, 'Ojamagic');
  check(['Ojama Green', 'Ojama Yellow', 'Ojama Black'].every((n) => inHand(e, 0, n)), 'sent from the field to the GY: adds "Ojama Green", "Yellow" and "Black" from the Deck');
}
{
  const e = duel(['Ojamagic', 'Ojama Green', 'Ojama Yellow', 'Ojama Black']);
  const o = grab(e, 0, 'Ojamagic');
  run(e, e.discard(0, o.uid));
  check(['Ojama Green', 'Ojama Yellow', 'Ojama Black'].every((n) => inHand(e, 0, n)), 'discarded from the hand: the same');
}

section('Ojamatch');
{
  const e = duel(['Ojamatch', 'Ojama Green', 'Ojama Yellow', 'Armed Dragon LV3', 'Ojama Black', 'Ojama Blue', 'Ojama Red'], [FILL]);
  grab(e, 0, 'Ojama Green');
  e.player(0).normalSummoned = true;
  playSpell(e, 0, 'Ojamatch', { pick: ['Ojama Green'] }, { pick: ['Ojama Yellow'] }, 'yes', { pick: ['Armed Dragon LV3'] });
  check(e.player(0).gy.some((c) => c.name === 'Ojama Green') && inHand(e, 0, 'Ojama Yellow'), 'sends an "Ojama" card: adds an "Ojama" monster with a different name and an "Armed Dragon"');
  check(e.monsters(0).some((m) => m.name === 'Armed Dragon LV3'), 'then 1 of them can be Normal Summoned right away');
  const om = e.player(0).gy.find((c) => c.name === 'Ojamatch')!;
  for (const n of ['Ojama Black', 'Ojama Blue', 'Ojama Red']) {
    const c = e.player(0).deck.find((x) => x.name === n)!;
    e.banish(c.uid);
  }
  const hand = e.player(0).hand.length;
  e.apply({ type: 'GRAVE_EFFECT', player: 0, uid: om.uid });
  settle(e, { pick: ['Ojama Black', 'Ojama Blue', 'Ojama Red'] });
  check(zone(e, om) === 'removed' && e.player(0).hand.length === hand + 1 && !e.player(0).removed.some((c) => c.name === 'Ojama Red'), 'GY: banish it, shuffle 3 banished "Ojama" monsters into the Deck, draw 1');
}

section('Old Vindictive Magician');
{
  const e = duel(['Old Vindictive Magician'], ['Gemini Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  const m = place(e, 0, 'Old Vindictive Magician', 'def', false)!;
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: m.uid });
  settle(e);
  check(zone(e, elf) === 'gy', 'FLIP: destroys a monster the opponent controls');
}

section('Ordeal of a Traveler');
{
  const e = duel([FILL], ['Ordeal of a Traveler']);
  const a = place(e, 0, FILL)!;
  activeST(e, 1, 'Ordeal of a Traveler');
  battle(e);
  attack(e, a, null, { pick: ['Spell'] });
  check(zone(e, a) === 'hand' && lp(e, 1) === 4000, 'opponent attacks, calls the type of a random card in your hand wrong: the attacker returns to the hand');
}
{
  const e = duel([FILL], ['Ordeal of a Traveler']);
  const a = place(e, 0, FILL)!;
  activeST(e, 1, 'Ordeal of a Traveler');
  battle(e);
  attack(e, a, null, { pick: ['Monster'] });
  check(zone(e, a) === 'mz' && lp(e, 1) === 4000 - 1400, 'a right call: the attack goes on');
}

section('Order to Charge');
{
  const e = duel(['Order to Charge'], ['Gemini Elf']);
  const f = place(e, 0, FILL)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  playSpell(e, 0, 'Order to Charge');
  check(zone(e, f) === 'gy' && zone(e, elf) === 'gy', 'Tributes a Normal Monster you control and destroys a monster the opponent controls');
}

section('Order to Smash');
{
  const e = duel(['Order to Smash', 'Ojama Green'], ['Trap Hole', 'Mirror Force']);
  const g = place(e, 0, 'Ojama Green')!;
  const a = activeST(e, 1, 'Trap Hole');
  const b = activeST(e, 1, 'Mirror Force');
  playTrap(e, 0, 'Order to Smash', { pick: ['Ojama Green'] }, { pick: ['Trap Hole', 'Mirror Force'] });
  check(zone(e, g) === 'gy' && zone(e, a) === 'gy' && zone(e, b) === 'gy', 'Tributes a Level 2 or lower Normal Monster: destroys up to 2 Spells/Traps');
}

section('Orgoth the Relentless');
{
  const e = duel(['Orgoth the Relentless'], ['Gemini Elf']);
  const o = place(e, 0, 'Orgoth the Relentless')!;
  e.roll = () => 3;
  const n = e.player(0).hand.length;
  effect(e, 0, o);
  check(atk(e, o) === 2500 + 900 && e.defOf(o) === 2450 + 900, 'rolls 3 dice: gains the total x 100 ATK/DEF');
  check(e.player(0).hand.length === n + 2 && e.canAttackDirectly(o), 'all 3 the same: draws 2, and it can attack directly');
  kill(e, [o], 1);
  check(zone(e, o) === 'mz', 'and it cannot be destroyed by card effects');
  endTurn(e);
  check(atk(e, o) === 3400, "until the end of the opponent's turn");
  endTurn(e);
  check(atk(e, o) === 2500, 'then it ends');
}

section('Otherworld - The "A" Zone');
{
  const e = duel(['Otherworld - The "A" Zone', 'Alien Test Grey'], [FILL]);
  playSpell(e, 0, 'Otherworld - The "A" Zone');
  const a = place(e, 0, 'Alien Test Grey')!;
  const f = place(e, 1, FILL)!;
  check(atk(e, f) === 1400, 'no battle: no change');
  battle(e);
  attack(e, a, f);
  check(lp(e, 1) === 4000 - (1600 - 1100), 'an opponent\'s monster battling an "Alien" loses 300 ATK/DEF');
}

section('Otohime');
{
  const e = duel(['Otohime', 'Otohime'], ['Gemini Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  const o = summon(e, 0, 'Otohime', true, 'yes')!;
  check(elf.pos === 'def', "Normal Summoned: changes an opponent's monster's battle position");
  endTurn(e);
  check(zone(e, o) === 'hand', 'returns to the hand in the End Phase');
  check(e.summonBlocked(0, e.player(0).deck.find((c) => c.name === 'Otohime')!, 'special', 'deck'), 'cannot be Special Summoned');
}

section('Over Destiny');
{
  const e = duel(['Over Destiny', 'Destiny HERO - Dasher', 'Destiny HERO - Doom Lord']);
  toGy(e, 0, 'Destiny HERO - Dasher');
  playSpell(e, 0, 'Over Destiny');
  const d = e.monsters(0).find((m) => m.name === 'Destiny HERO - Doom Lord');
  check(!!d, 'Special Summons a "Destiny HERO" from the Deck with at most half the target\'s Level');
  endTurn(e);
  check(!!d && zone(e, d) === 'gy', 'destroyed during the End Phase');
}

section('Overload Fusion');
{
  const e = duel(['Overload Fusion', 'Stealthroid', 'Drillroid'], [], ['Test Overload Machine']);
  place(e, 0, 'Stealthroid');
  toGy(e, 0, 'Drillroid');
  playSpell(e, 0, 'Overload Fusion');
  check(e.monsters(0).some((m) => m.name === 'Test Overload Machine') && e.player(0).removed.length === 2, 'banishes the materials from the field and GY: Fusion Summons a DARK Machine');
}

section("Owner's Seal");
{
  const e = duel(["Owner's Seal"], ['Gemini Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  e.takeControl(elf.uid, 0);
  playSpell(e, 0, "Owner's Seal");
  check(e.controller(elf.uid) === 1, 'control of every monster returns to its owner');
}

section('Oxygeddon');
{
  const e = duel(['Oxygeddon'], ['Prominence Hand']);
  const o = place(e, 0, 'Oxygeddon')!;
  const ph = place(e, 1, 'Prominence Hand')!;
  battle(e);
  ph.atkMod = 2000;
  attack(e, o, ph);
  check(zone(e, o) === 'gy' && lp(e, 0) === 4000 - 800 - 800 && lp(e, 1) === 3200, 'destroyed by battle with a Pyro: each player takes 800 damage');
}

section('Oyster Meister');
{
  const e = duel(['Oyster Meister', 'Oyster Meister'], ['Gemini Elf']);
  const o = place(e, 0, 'Oyster Meister')!;
  kill(e, [o], 1);
  check(e.monsters(0).some((m) => m.name === 'Oyster Token'), 'sent from the field to the GY: Special Summons an "Oyster Token"');
  const o2 = place(e, 0, 'Oyster Meister')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  battle(e);
  attack(e, o2, elf);
  check(e.monsters(0).filter((m) => m.name === 'Oyster Token').length === 1, 'not when destroyed by battle');
}

// ======================= P =======================
section('Paladin of White Dragon');
{
  const e = duel(['Paladin of White Dragon', 'Blue-Eyes White Dragon'], [FILL]);
  const pal = place(e, 0, 'Paladin of White Dragon')!;
  const t = place(e, 1, FILL, 'def', false)!;
  t.placedTurn = 0;
  battle(e);
  attack(e, pal, t);
  check(zone(e, t) === 'gy' && lp(e, 1) === 4000, 'attacking a face-down Defense Position monster: destroys it');
}
{
  const e = duel(['Paladin of White Dragon', 'Blue-Eyes White Dragon']);
  const pal = place(e, 0, 'Paladin of White Dragon')!;
  effect(e, 0, pal);
  const b = e.monsters(0).find((m) => m.name === 'Blue-Eyes White Dragon');
  check(zone(e, pal) === 'gy' && !!b && (b.tags?.noAttackTurn === e.state.turn), 'Tribute it: Special Summon "Blue-Eyes White Dragon" from the Deck; it cannot attack this turn');
}

section('Paleozoic Canadia');
{
  const e = duel(['Paleozoic Canadia'], ['Gemini Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  const c = playTrap(e, 0, 'Paleozoic Canadia');
  check(!elf.faceUp && elf.pos === 'def', "changes an opponent's face-up monster to face-down Defense Position");
  const pc = e.player(0).gy.find((x) => x.name === 'Paleozoic Canadia')!;
  check(!c && !!pc, 'goes to the GY');
}
{
  const e = duel(['Paleozoic Canadia', 'Quantum Cat'], [FILL]);
  toGy(e, 0, 'Paleozoic Canadia');
  const pc = e.player(0).gy[0];
  playTrap(e, 0, 'Quantum Cat', { respond: 'Paleozoic Canadia' });
  const m = e.fieldCard(pc.uid);
  check(!!m && levelOf(e, m) === 2 && e.raceOf(m) === 'Aqua' && atk(e, m) === 1200, 'a Trap is activated: Special Summons itself from the GY as a Level 2 Aqua 1200/0 Normal Monster');
  kill(e, [m], 1);
  check(zone(e, pc) === 'removed', 'banished when it leaves the field');
}

section('Paleozoic Eldonia');
{
  const e = duel(['Paleozoic Eldonia'], ['Gemini Elf']);
  const f = place(e, 0, FILL)!;
  playTrap(e, 0, 'Paleozoic Eldonia');
  check(atk(e, f) === 1900 && e.defOf(f) === 1700, 'a face-up monster gains 500 ATK/DEF');
  endTurn(e);
  check(atk(e, f) === 1400, 'until the end of this turn');
}

section("Pandora's Jewelry Box");
{
  const e = duel(["Pandora's Jewelry Box"]);
  place(e, 0, "Pandora's Jewelry Box");
  endTurn(e);
  const n = e.player(0).hand.length;
  endTurn(e);
  check(e.player(0).hand.length === n + 2, 'no cards in the Extra Deck: draws 2 instead of 1');
}

section('Performapal Changeraffe');
{
  const e = duel(['Performapal Changeraffe'], ['Gemini Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  const c = place(e, 0, 'Performapal Changeraffe', 'atk', true, 'yes')!;
  check(e.isNegated(elf), "Summoned: an opponent's monster has its effects negated");
  endTurn(e);
  check(!e.canAttackWith(1, elf), 'and it cannot attack while Changeraffe is face-up');
  kill(e, [c], 1);
  check(e.isNegated(elf), 'its effects stay negated while it is on the field');
}

section('Performapal Gongato');
{
  const e = duel(['Performapal Gongato'], ['Gemini Elf']);
  place(e, 0, 'Performapal Gongato');
  const f = place(e, 0, FILL)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  battle(e);
  attack(e, f, elf, { respond: 'Performapal Gongato' });
  check(zone(e, f) === 'gy' && lp(e, 0) === 4000, 'an attack involving your monster: you take no battle damage');
}

section('Performapal Gumgumouton');
{
  const e = duel(['Performapal Gumgumouton'], ['Gemini Elf']);
  place(e, 0, 'Performapal Gumgumouton');
  const f = place(e, 0, FILL)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  battle(e);
  attack(e, f, elf, { respond: 'Performapal Gumgumouton' });
  check(zone(e, f) === 'mz' && lp(e, 0) === 3500, 'your monster cannot be destroyed by that battle');
}

section('Performapal Inflater Tapir');
{
  const e = duel(['Performapal Inflater Tapir'], ['Gemini Elf']);
  grab(e, 0, 'Performapal Inflater Tapir');
  const f = place(e, 0, FILL)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  battle(e);
  attack(e, f, elf, { respond: 'Performapal Inflater Tapir' });
  check(lp(e, 0) === 4000 && e.player(0).gy.some((c) => c.name === 'Performapal Inflater Tapir'), 'discard it: neither player takes battle damage from that battle');
}
{
  const e = duel(['Performapal Inflater Tapir', 'Performapal Seal Eel'], [FILL]);
  toGy(e, 0, 'Performapal Inflater Tapir');
  grab(e, 0, 'Performapal Seal Eel');
  const a = place(e, 1, FILL)!;
  endTurn(e);
  toBattle(e);
  attack(e, a, null, 'yes', { pick: ['Performapal Seal Eel'] });
  check(e.monsters(0).some((m) => m.name === 'Performapal Inflater Tapir' && m.pos === 'def'), "opponent's direct attack while it is in the GY: discard a \"Performapal\" to Special Summon it in Defense Position");
}

section('Performapal Seal Eel');
{
  const e = duel(['Performapal Seal Eel'], ['Trap Hole']);
  const th = putST(e, 1, 'Trap Hole');
  summon(e, 0, 'Performapal Seal Eel', true, 'yes');
  check(e.activationBlocked(1, th), "Summoned: an opponent's Set card cannot be activated this turn");
  endTurn(e);
  check(!e.activationBlocked(1, th), 'only this turn');
}

section('Phantom Beast Wild-Horn');
{
  const e = duel(['Phantom Beast Wild-Horn'], [FILL]);
  const w = place(e, 0, 'Phantom Beast Wild-Horn')!;
  const d = place(e, 1, FILL, 'def')!;
  battle(e);
  attack(e, w, d);
  check(lp(e, 1) === 4000 - (1700 - 1200), 'inflicts piercing battle damage');
}

section('Photon Caesar');
{
  const e = duel(['Photon Caesar', 'Photon Caesar']);
  place(e, 0, FILL);
  place(e, 0, FILL);
  summon(e, 0, 'Photon Caesar', true, 'yes');
  check(e.monsters(0).filter((m) => m.name === 'Photon Caesar').length === 2, 'Normal Summoned: Special Summons another "Photon Caesar" from the hand or Deck');
}

section('Piercing Moray');
{
  const e = duel(['Piercing Moray', 'Needle Sunfish'], [FILL]);
  const m = place(e, 0, 'Piercing Moray')!;
  place(e, 0, 'Needle Sunfish');
  effect(e, 0, m);
  check(atk(e, m) === 2100 && e.monsters(0).length === 1, 'Tribute a Fish: gains 600 ATK');
  const d = place(e, 1, FILL, 'def')!;
  battle(e);
  attack(e, m, d);
  check(lp(e, 1) === 4000 - (2100 - 1200), 'inflicts piercing battle damage');
}

section('Pinch Hopper');
{
  const e = duel(['Pinch Hopper', 'Pinch Hopper']);
  const p = place(e, 0, 'Pinch Hopper')!;
  grab(e, 0, 'Pinch Hopper');
  kill(e, [p], 1, 'yes');
  check(e.monsters(0).some((m) => m.name === 'Pinch Hopper' && m.uid !== p.uid), 'sent to the GY: Special Summons an Insect from the hand');
}

section('Pineapple Blast');
{
  const e = duel(['Pineapple Blast'], [FILL, FILL, FILL]);
  for (let i = 0; i < 3; i++) place(e, 1, FILL);
  putST(e, 0, 'Pineapple Blast');
  summon(e, 0, FILL, true, { respond: 'Pineapple Blast' });
  check(e.monsters(1).length === 1, 'you Normal Summon while the opponent controls more monsters: they keep only as many as you');
}

section('Pitch-Black Power Stone');
{
  const e = duel(['Pitch-Black Power Stone', 'Dark Red Enchanter']);
  const dre = place(e, 0, 'Dark Red Enchanter')!;
  const n = dre.counters;
  const ps = playTrap(e, 0, 'Pitch-Black Power Stone')!;
  check(ps.counters === 3, 'activated with 3 Spell Counters');
  effect(e, 0, ps);
  check(ps.counters === 2 && dre.counters === n + 1, 'moves a Spell Counter to another card');
}

section('Plague Wolf');
{
  const e = duel(['Plague Wolf']);
  const w = place(e, 0, 'Plague Wolf')!;
  effect(e, 0, w);
  check(atk(e, w) === 2000, 'ATK becomes double its original ATK');
  endTurn(e);
  check(zone(e, w) === 'gy', 'destroyed in the End Phase');
}

section('Possessed Dark Soul');
{
  const e = duel(['Possessed Dark Soul'], ['Ojama Green', 'Gemini Elf']);
  const s = place(e, 0, 'Possessed Dark Soul')!;
  const g = place(e, 1, 'Ojama Green')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  effect(e, 0, s);
  check(zone(e, s) === 'gy' && e.controller(g.uid) === 0 && e.controller(elf.uid) === 1, 'Tribute it: take control of the opponent\'s face-up Level 3 or lower monsters');
}

section('Pot of Avarice');
{
  const e = duel(['Pot of Avarice', 'Mudora', 'Newdoria', 'Oxygeddon', 'Plague Wolf']);
  toGy(e, 0, 'Mudora', 'Newdoria', 'Oxygeddon', 'Plague Wolf', FILL);
  const n = e.player(0).hand.length;
  playSpell(e, 0, 'Pot of Avarice', { pick: ['Mudora', 'Newdoria', 'Oxygeddon', 'Plague Wolf', FILL] });
  check(e.player(0).gy.filter((c) => c.name !== 'Pot of Avarice').length === 0 && e.player(0).hand.length === n + 2, 'shuffles 5 monsters from the GY into the Deck, then draws 2');
}

section('Power Breaker');
{
  const e = duel(['Power Breaker'], ['Gemini Elf', 'Ordeal of a Traveler']);
  const pb = place(e, 0, 'Power Breaker')!;
  const st = activeST(e, 1, 'Ordeal of a Traveler');
  kill(e, [pb], 1);
  check(zone(e, st) === 'gy', "destroyed by the opponent's card effect: destroys a face-up Spell/Trap they control");
}
{
  const e = duel(['Power Breaker'], [FILL]);
  const pb = place(e, 0, 'Power Breaker')!;
  const f = place(e, 1, FILL)!;
  battle(e);
  attack(e, pb, f);
  check(pb.pos === 'def', 'it attacks: changed to Defense Position afterwards');
}

section('Pre-Preparation of Rites');
{
  const e = duel(['Pre-Preparation of Rites', 'White Dragon Ritual', 'Paladin of White Dragon']);
  playSpell(e, 0, 'Pre-Preparation of Rites');
  check(inHand(e, 0, 'White Dragon Ritual') && inHand(e, 0, 'Paladin of White Dragon'), 'adds a Ritual Spell and the Ritual Monster it names');
}

section('Predaplant Pterapenthes');
{
  const e = duel(['Predaplant Pterapenthes'], ['Gemini Elf', 'Ojama Green']);
  const pt = place(e, 0, 'Predaplant Pterapenthes')!;
  const g = place(e, 1, 'Ojama Green')!;
  const elf = place(e, 1, 'Gemini Elf', 'def')!;
  battle(e);
  pt.atkMod = 2000;
  attack(e, pt, g, 'yes', { pick: ['Gemini Elf'] });
  check(lp(e, 1) === 4000 - 2300 && elf.tags?.predator === 1 && levelOf(e, elf) === 1, 'inflicts battle damage: a Predator Counter on an opponent\'s monster, which becomes Level 1');
}
{
  const e = duel(['Predaplant Pterapenthes'], ['Gemini Elf', 'Ojama Green']);
  const pt = place(e, 0, 'Predaplant Pterapenthes')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  const g = place(e, 1, 'Ojama Green')!;
  effect(e, 0, pt);
  check(e.controller(g.uid) === 0 && e.controller(elf.uid) === 1, 'takes control of an opponent\'s monster with a Level up to its own');
  endTurn(e);
  check(e.controller(g.uid) === 1, 'until the End Phase');
}


section('Premature Return');
{
  const e = duel(['Premature Return', 'Gemini Elf']);
  const elf = e.player(0).deck.find((c) => c.name === 'Gemini Elf')!;
  e.banish(elf.uid);
  playTrap(e, 0, 'Premature Return', { pick: [FILL] });
  const m = e.fieldCard(elf.uid);
  check(!!m && !m.faceUp && m.pos === 'def' && e.player(0).removed.some((c) => c.name === FILL), 'banish a card from the hand: Special Summons a banished monster in face-down Defense Position');
}

section('Prideful Roar');
{
  const e = duel(['Prideful Roar'], ['Gemini Elf']);
  const f = place(e, 0, FILL)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  putST(e, 0, 'Prideful Roar');
  battle(e);
  attack(e, f, elf, { respond: 'Prideful Roar' });
  check(lp(e, 0) === 3500 && zone(e, elf) === 'gy' && lp(e, 1) === 4000 - 300, 'pay the ATK difference: your monster gains the difference + 300 and wins');
}

section('Prometheus, King of the Shadows');
{
  const e = duel(['Prometheus, King of the Shadows', 'Newdoria', 'Night Assailant']);
  toGy(e, 0, 'Newdoria', 'Night Assailant');
  const p = summon(e, 0, 'Prometheus, King of the Shadows', true, { pick: ['Newdoria', 'Night Assailant'] })!;
  check(atk(e, p) === 1200 + 800 && e.player(0).removed.length === 2, 'Normal Summoned: banishes DARK monsters from the GY, +400 ATK each');
  endTurn(e);
  check(atk(e, p) === 1200, 'until the end of the turn');
}

section('Prominence Hand');
{
  const e = duel(['Prominence Hand', 'Magic Hand']);
  const ph = grab(e, 0, 'Prominence Hand');
  check(!e.canSpecialProc(0, ph), 'needs a "Magic Hand", "Fire Hand" or "Ice Hand"');
  place(e, 0, 'Magic Hand');
  e.apply({ type: 'SPECIAL', player: 0, uid: ph.uid });
  settle(e);
  check(zone(e, ph) === 'mz', 'Special Summons itself from the hand');
}

section('Psychic Shockwave');
{
  const e = duel(['Psychic Shockwave', 'Pot of Greed', 'Jinzo'], ['Quantum Cat']);
  grab(e, 0, 'Pot of Greed');
  putST(e, 0, 'Psychic Shockwave');
  const q = putST(e, 1, 'Quantum Cat');
  endTurn(e);
  act(e, 1, q.uid, { respond: 'Psychic Shockwave' });
  check(e.monsters(0).some((m) => m.name === 'Jinzo') && e.player(0).gy.some((c) => c.name === 'Pot of Greed'), 'the opponent activates a Trap: discard a Spell, Special Summon a Level 6 DARK Machine from the Deck');
}

section('Pumprincess the Princess of Ghosts');
{
  const e = duel(['Pumprincess the Princess of Ghosts'], ['Gemini Elf']);
  const pp = place(e, 0, 'Pumprincess the Princess of Ghosts')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  kill(e, [pp], 1, 'yes');
  const st = e.fieldCard(pp.uid);
  check(!!st && zone(e, pp) === 'sz' && st.faceUp, 'destroyed: placed face-up in the Spell & Trap Zone');
  endTurn(e);
  endTurn(e);
  check(st!.counters === 2 && atk(e, elf) === 1700, "each Standby Phase: a Pumpkin Counter; the opponent's monsters lose 100 ATK/DEF per counter");
}

section('Puppet Master');
{
  const e = duel(['Puppet Master', 'Newdoria', 'Night Assailant']);
  toGy(e, 0, 'Newdoria', 'Night Assailant');
  place(e, 0, FILL);
  summon(e, 0, 'Puppet Master', true, 'yes');
  const ms = e.monsters(0).filter((m) => m.name !== 'Puppet Master');
  check(lp(e, 0) === 2000 && ms.length === 2 && ms.every((m) => m.tags?.noAttackTurn === e.state.turn), 'Tribute Summoned: pay 2000 LP, Special Summon 2 Fiends from the GY that cannot attack this turn');
}

section('Pyramid of Wonders');
{
  const e = duel(['Pyramid of Wonders', 'Plague Wolf'], [FILL, FILL]);
  playSpell(e, 0, 'Pyramid of Wonders');
  const w = place(e, 0, 'Plague Wolf')!;
  place(e, 1, FILL);
  place(e, 1, FILL);
  check(atk(e, w) === 1000 + 400, 'Zombies you control gain 200 ATK for each opponent\'s monster');
  kill(e, [w], 1);
  check(zone(e, w) === 'mz' && !e.player(0).sz.some((c) => c?.name === 'Pyramid of Wonders'), 'a Zombie would be destroyed: this card is sent to the GY instead');
}

section('Pyroxene Fusion');
{
  const e = duel(['Pyroxene Fusion', 'Gem-Knight Emerald'], [], ['Gem-Knight Test Fusion']);
  grab(e, 0, 'Gem-Knight Emerald');
  place(e, 0, FILL);
  playTrap(e, 0, 'Pyroxene Fusion');
  check(e.monsters(0).some((m) => m.name === 'Gem-Knight Test Fusion') && e.player(0).gy.some((c) => c.name === 'Gem-Knight Emerald'), 'sends the listed materials from hand/field: Fusion Summons the "Gem-Knight"');
}

// ======================= Q =======================
section('Quaking Mirror Force');
{
  const e = duel([FILL, FILL], ['Quaking Mirror Force']);
  const a = place(e, 0, FILL)!;
  const b = place(e, 0, FILL)!;
  putST(e, 1, 'Quaking Mirror Force');
  battle(e);
  attack(e, a, null, { respond: 'Quaking Mirror Force' });
  check(!a.faceUp && !b.faceUp && a.pos === 'def' && lp(e, 1) === 4000, "an opponent's attack: their Attack Position monsters become face-down Defense Position");
  check(a.cannotChangePos === true, 'and cannot change their battle positions');
}

section('Quantum Cat');
{
  const e = duel(['Quantum Cat']);
  const q = playTrap(e, 0, 'Quantum Cat', { pick: ['Dragon'] }, { pick: ['FIRE'] });
  const m = q ? e.fieldCard(q.uid) : null;
  check(!!m && zone(e, m) === 'mz' && e.raceOf(m) === 'Dragon' && levelOf(e, m) === 4 && e.defOf(m) === 2200, 'Special Summoned as a Level 4 0/2200 Normal Monster of the declared Type and Attribute');
}

section('Quarantine');
{
  const e = duel(['Quarantine'], ['Trap Hole']);
  playSpell(e, 0, 'Quarantine');
  putST(e, 1, 'Trap Hole');
  const before = e.state.log.length;
  endTurn(e, 'yes');
  check(e.state.log.length > before && e.player(1).sz.some((c) => c?.name === 'Trap Hole' && !c.faceUp), "End Phase: reveals an opponent's Set card, which stays Set");
}

section("Queen's Pawn");
{
  const e = duel(["Queen's Pawn", 'Amazoness Fighter', FILL, 'Amazoness Paladin'], [FILL]);
  const a = place(e, 0, 'Amazoness Fighter')!;
  const f = place(e, 1, FILL)!;
  putST(e, 0, "Queen's Pawn");
  battle(e);
  attack(e, a, f, { respond: "Queen's Pawn" });
  check(zone(e, f) === 'gy' && e.monsters(0).some((m) => m.name === 'Amazoness Paladin'), 'an "Amazoness" destroys a monster by battle: Special Summons a Level 4 or lower "Amazoness" from the Deck');
}

// ======================= R =======================
section('R - Righteous Justice');
{
  const e = duel(['R - Righteous Justice', 'Elemental HERO Avian'], ['Trap Hole', 'Mirror Force']);
  place(e, 0, 'Elemental HERO Avian');
  const a = activeST(e, 1, 'Trap Hole');
  const b = activeST(e, 1, 'Mirror Force');
  playSpell(e, 0, 'R - Righteous Justice', { pick: ['Trap Hole'] });
  check(zone(e, a) === 'gy' && zone(e, b) === 'sz', 'destroys as many Spells/Traps as "Elemental HERO" cards you control (1)');
}

section('Raging Flame Sprite');
{
  const e = duel(['Raging Flame Sprite'], [FILL]);
  const r = place(e, 0, 'Raging Flame Sprite')!;
  place(e, 1, FILL);
  battle(e);
  attack(e, r, null);
  check(lp(e, 1) === 3900 && atk(e, r) === 1100, 'attacks directly while the opponent has monsters, then gains 1000 ATK');
}

section('Rain Storm');
{
  const e = duel(['Rain Storm', 'Cloudian - Altus'], ['Trap Hole']);
  const c = place(e, 0, 'Cloudian - Altus')!;
  const t = activeST(e, 1, 'Trap Hole');
  playTrap(e, 0, 'Rain Storm', { pick: ['1000: destroy 1 Spell/Trap'] });
  check(zone(e, t) === 'gy' && atk(e, c) === 300, 'a "Cloudian" loses 1000 ATK: destroys 1 Spell/Trap');
}

section('Rainbow Dark Dragon');
{
  const darks = ['Newdoria', 'Night Assailant', 'Possessed Dark Soul', 'Plague Wolf', 'Prometheus, King of the Shadows', 'Old Vindictive Magician', 'Obsidian Dragon'];
  const e = duel(['Rainbow Dark Dragon', ...darks, 'Stealthroid', 'Magic Hand']);
  const r = grab(e, 0, 'Rainbow Dark Dragon');
  toGy(e, 0, ...darks.slice(0, 6));
  check(!e.canSpecialProc(0, r), 'needs 7 DARK monsters with different names in the GY');
  toGy(e, 0, darks[6], 'Stealthroid');
  e.apply({ type: 'SPECIAL', player: 0, uid: r.uid });
  settle(e, ...darks.map((n) => ({ pick: [n] })));
  const m = e.fieldCard(r.uid);
  check(!!m && e.player(0).removed.length === 7, 'Special Summoned by banishing 7 DARK monsters with different names');
  place(e, 0, 'Magic Hand');
  effect(e, 0, m);
  check(atk(e, m) === 4000 + 1000 && !e.monsters(0).some((x) => x.name === 'Magic Hand'), 'banishes every other DARK monster on the field and in the GY: +500 ATK each');
  check(e.summonBlocked(0, r, 'special', 'gy'), 'cannot be Special Summoned another way');
}

section('Rainbow Dragon');
{
  const cbs = ['Crystal Beast Amber Mammoth', 'Crystal Beast Amethyst Cat', 'Crystal Beast Cobalt Eagle', 'Crystal Beast Emerald Tortoise', 'Crystal Beast Ruby Carbuncle', 'Crystal Beast Sapphire Pegasus', 'Crystal Beast Topaz Tiger'];
  const e = duel(['Rainbow Dragon', ...cbs], [FILL, 'Trap Hole']);
  const r = grab(e, 0, 'Rainbow Dragon');
  toGy(e, 0, ...cbs.slice(0, 6));
  check(!e.canSpecialProc(0, r), 'needs 7 "Crystal Beast" cards with different names');
  const cb = place(e, 0, cbs[6])!;
  e.apply({ type: 'SPECIAL', player: 0, uid: r.uid });
  settle(e);
  const m = e.fieldCard(r.uid)!;
  check(!!m, 'Special Summoned with 7 "Crystal Beast" cards on the field and in the GY');
  check(!e.canUseQuickNow(0, r.uid) && !e.canUseMonsterEffect(0, m), 'its effects cannot be used the turn it is Special Summoned');
  toTurn3(e);
  e.apply({ type: 'QUICK_EFFECT', player: 0, uid: r.uid });
  settle(e);
  check(zone(e, cb) === 'gy' && atk(e, m) === 5000, 'sends the face-up "Crystal Beast" monsters to the GY: +1000 ATK each');
  const f = place(e, 1, FILL)!;
  const t = activeST(e, 1, 'Trap Hole');
  effect(e, 0, m);
  check(!e.player(0).gy.some((c) => c.name.startsWith('Crystal Beast')) && zone(e, f) === 'deck' && zone(e, t) === 'deck' && zone(e, m) === 'deck', 'banishes the "Crystal Beasts" in the GY: every card on the field is shuffled into the Deck');
}

section('Rainbow Gravity');
{
  const cbs = ['Crystal Beast Amber Mammoth', 'Crystal Beast Amethyst Cat', 'Crystal Beast Cobalt Eagle', 'Crystal Beast Emerald Tortoise', 'Crystal Beast Ruby Carbuncle', 'Crystal Beast Sapphire Pegasus', 'Crystal Beast Topaz Tiger'];
  const e = duel(['Rainbow Gravity', 'Rainbow Dragon', ...cbs]);
  toGy(e, 0, ...cbs);
  playTrap(e, 0, 'Rainbow Gravity');
  check(e.monsters(0).some((m) => m.name === 'Rainbow Dragon'), '7 "Crystal Beasts": Special Summons an "Ultimate Crystal" monster from the Deck, ignoring its Summoning conditions');
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
if (fails) process.exit(1);
