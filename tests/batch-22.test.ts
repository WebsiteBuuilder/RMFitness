// Speed Duel card scripts of batch 22 (run: npx tsx tests/batch-22.test.ts)
// One targeted check per scripted card: its main effect really happens in a duel.
import { Engine } from '../src/eds/engine';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';

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
import { setSpiritPlaceHook } from '../src/eds/speed/helpers';

const toMain = (e: Engine) => {
  while (e.state.phase !== 'M1' && e.state.winner === null) (e.apply({ type: 'NEXT_PHASE', player: e.state.turnPlayer }), settle(e));
};
/** Steps to the next turn's Main Phase 1. */
function nextTurn(e: Engine, ...ans: Ans[]) {
  endTurn(e, ...ans);
  toMain(e);
}
const atk = (e: Engine, c: FieldCard | null) => (c ? e.atkOf(c) : -1);
const inGy = (e: Engine, p: Pid, name: string) => e.player(p).gy.some((c) => c.name === name);
const inHand = (e: Engine, p: Pid, name: string) => e.player(p).hand.some((c) => c.name === name);
const MSG = ['Spirit Message "I"', 'Spirit Message "N"', 'Spirit Message "A"', 'Spirit Message "L"'];

section('Sakuretsu Armor');
{
  const e = duel(['Sakuretsu Armor']);
  putST(e, 0, 'Sakuretsu Armor');
  nextTurn(e);
  const a = place(e, 1, FILL);
  toBattle(e);
  attack(e, a, null, { respond: 'Sakuretsu Armor' });
  check(zone(e, a) === 'gy' && e.player(0).lp === 4000 && inGy(e, 0, 'Sakuretsu Armor'), 'Sakuretsu Armor: destroys the attacking monster before the direct attack lands');
}

section('Shadow Spell');
{
  const e = duel(['Shadow Spell']);
  const m = place(e, 1, FILL);
  const ss = playTrap(e, 0, 'Shadow Spell', { pick: [FILL] });
  check(active(e, ss) && atk(e, m) === 1400 - 700, 'Shadow Spell: the target loses 700 ATK');
  nextTurn(e);
  check(!e.canChangePosition(1, m!), 'Shadow Spell: it cannot change its battle position');
  toBattle(e);
  attack(e, m, null);
  check(e.player(0).lp === 4000, 'Shadow Spell: it cannot attack');
  kill(e, [m], 0);
  check(zone(e, ss) === 'gy', 'Shadow Spell: destroyed when the monster leaves the field');
}

section("Shinato's Ark / Shinato, King of a Higher Plane");
{
  const e = duel(["Shinato's Ark", 'Shinato, King of a Higher Plane'], ['Blue-Eyes White Dragon'], [], [], 1);
  toMain(e);
  place(e, 1, 'Blue-Eyes White Dragon', 'def');
  nextTurn(e);
  place(e, 0, FILL);
  place(e, 0, FILL);
  grab(e, 0, 'Shinato, King of a Higher Plane');
  playSpell(e, 0, "Shinato's Ark", { pick: [FILL, FILL] });
  const s = e.monsters(0).find((m) => m.name === 'Shinato, King of a Higher Plane') ?? null;
  check(!!s && inGy(e, 0, "Shinato's Ark") && e.player(0).gy.filter((c) => c.name === FILL).length === 2, "Shinato's Ark: Ritual Summons Shinato by Tributing Levels 4+4");
  toBattle(e);
  attack(e, s, e.monsters(1)[0]);
  check(inGy(e, 1, 'Blue-Eyes White Dragon') && e.player(1).lp === 4000 - 3000, 'Shinato: destroying a Defense Position monster inflicts its original ATK (3000)');
}

section('Snipe Hunter');
{
  const e = duel(['Snipe Hunter']);
  const sh = place(e, 0, 'Snipe Hunter');
  const t = place(e, 1, FILL);
  const hand = e.player(0).hand.length;
  e.state.fx.fixedRoll = { p: 0, die: 3 };
  effect(e, 0, sh, { pick: [FILL] }, { pick: [FILL] });
  check(zone(e, t) === 'gy' && e.player(0).hand.length === hand - 1, 'Snipe Hunter: discard 1, roll a 3: the target is destroyed');
  const t2 = place(e, 1, FILL);
  e.state.fx.fixedRoll = { p: 0, die: 6 };
  effect(e, 0, sh, { pick: [FILL] }, { pick: [FILL] });
  check(!!e.fieldCard(t2!.uid), 'Snipe Hunter: a 6 destroys nothing');
}

section('Sol and Luna');
{
  const e = duel(['Sol and Luna']);
  const mine = place(e, 0, FILL);
  const theirs = place(e, 1, FILL, 'def', false);
  playSpell(e, 0, 'Sol and Luna');
  check(!!mine && !mine.faceUp && mine.pos === 'def', 'Sol and Luna: the face-up monster goes face-down Defense');
  check(!!theirs && theirs.faceUp && theirs.pos === 'def', 'Sol and Luna: the face-down monster goes face-up Defense');
  const again = grab(e, 0, 'Sol and Luna');
  check(!e.canActivateMain(0, again.uid), 'Sol and Luna: only 1 per turn');
}

section('Spirit Reaper');
{
  const e = duel(['Spirit Reaper'], ['Blue-Eyes White Dragon']);
  const r = place(e, 0, 'Spirit Reaper');
  nextTurn(e);
  const b = place(e, 1, 'Blue-Eyes White Dragon');
  toBattle(e);
  attack(e, b, r);
  check(!!e.fieldCard(r!.uid) && e.player(0).lp === 4000 - 2700, 'Spirit Reaper: cannot be destroyed by battle');
}
{
  const e = duel(['Spirit Reaper'], ['Shadow Spell']);
  const r = place(e, 0, 'Spirit Reaper');
  nextTurn(e);
  const ss = playTrap(e, 1, 'Shadow Spell', { pick: ['Spirit Reaper'] });
  check(zone(e, r) === 'gy', 'Spirit Reaper: destroyed after resolving an effect that targets it');
  check(!ss && inGy(e, 1, 'Shadow Spell'), 'Spirit Reaper: (Shadow Spell then destroys itself, its monster gone)');
}
{
  // A monster effect that picks its target as it resolves (Sea Koala) is seen too; a monster it did not target is not.
  const koala = (pickReaper: boolean) => {
    const e = duel(['Sea Koala', 'Dark Rabbit'], ['Spirit Reaper', FILL]);
    const r = place(e, 1, 'Spirit Reaper');
    place(e, 1, FILL);
    const k = place(e, 0, 'Sea Koala');
    place(e, 0, 'Dark Rabbit');
    effect(e, 0, k, { pick: [pickReaper ? 'Spirit Reaper' : FILL] });
    return zone(e, r);
  };
  check(koala(true) === 'gy', "Spirit Reaper: destroyed after a monster effect that chose it as its target resolves (Sea Koala)");
  check(koala(false) === 'mz', 'Spirit Reaper: not when the monster effect targeted another monster');
}
{
  const e = duel(['Spirit Reaper'], [], [], [], 1);
  toMain(e);
  nextTurn(e);
  const r = place(e, 0, 'Spirit Reaper');
  const hand = e.player(1).hand.length;
  toBattle(e);
  attack(e, r, null);
  check(e.player(1).lp === 4000 - 300 && e.player(1).hand.length === hand - 1, 'Spirit Reaper: a direct attack discards 1 random card from their hand');
}

section('Spiritualism');
{
  const e = duel(['Spiritualism'], ['Sakuretsu Armor']);
  const s = putST(e, 1, 'Sakuretsu Armor');
  playSpell(e, 0, 'Spiritualism');
  check(zone(e, s) === 'hand' && e.find(s.uid)?.loc.player === 1, "Spiritualism: returns the opponent's Spell/Trap to the hand");
  // "Its activation and effect cannot be negated": the engine clears a negation set on its chain link.
  const e2 = duel(['Spiritualism'], ['Sakuretsu Armor']);
  const s2 = putST(e2, 1, 'Sakuretsu Armor');
  const sp = grab(e2, 0, 'Spiritualism');
  const link = { card: sp, loc: e2.find(sp.uid)!.loc, player: 0 as Pid, label: sp.name, negated: true, payload: { cannotNegate: true } };
  e2.state.chain.push(link);
  run(e2, (e2 as any).resolveChain());
  check(zone(e2, s2) === 'hand', 'Spiritualism: a negated activation still resolves');
}
{
  // Counter-cards are not offered against it (their cost would be wasted); against another Spell they are.
  const offered = (spell: string) => {
    const e = duel([spell], ['Magic Jammer', 'Sakuretsu Armor']);
    putST(e, 1, 'Sakuretsu Armor');
    putST(e, 1, 'Magic Jammer');
    const c = grab(e, 0, spell);
    e.apply({ type: 'ACTIVATE', player: 0, uid: c.uid, zone: e.player(0).sz.findIndex((z) => z === null) });
    let seen = false;
    for (let i = 0; i < 50 && e.state.prompt; i++) {
      const pr = e.state.prompt;
      if (pr.kind === 'response' && pr.player === 1 && pr.options.some((o) => o.label === 'Magic Jammer')) seen = true;
      settle(e, 'pass');
    }
    return seen;
  };
  check(!offered('Spiritualism') && offered('Pot of Greed'), 'Spiritualism: Magic Jammer is not offered against it (it cannot be negated)');
}

section('Destiny Board / Spirit Message "I" "N" "A" "L" / Sentence of Doom');
{
  // Without Fear of the Dark: Board + "I" + "N" fill the 3 Spell & Trap Zones, so "A" is not placed and nobody wins.
  const e = duel(['Destiny Board', ...MSG]);
  const msg = grab(e, 0, 'Spirit Message "I"');
  check(!e.canSet(0, msg) && !e.canActivateMain(0, msg.uid), 'Spirit Message: cannot be Set or activated from the hand');
  playTrap(e, 0, 'Destiny Board');
  for (let i = 0; i < 4; i++) (endTurn(e), endTurn(e));
  const names = e.spells(0).map((c) => c.name);
  check(names.includes('Spirit Message "I"') && names.includes('Spirit Message "N"') && !names.includes('Spirit Message "A"') && e.state.winner === null, 'Destiny Board: places "I" then "N" (from hand or Deck); with 3 zones full nothing more fits');
  const n = e.spells(0).find((c) => c.name === 'Spirit Message "N"')!;
  kill(e, [n], 1);
  check(inGy(e, 0, 'Destiny Board') && inGy(e, 0, 'Spirit Message "I"'), 'Spirit Message: one leaving sends the board and the other messages to the GY');
}
{
  // With a hook that puts the message in a Monster Zone (what Fear of the Dark does), all 5 reach the field: you win.
  setSpiritPlaceHook(function* (e, p, card) {
    const f = e.find(card.uid)!;
    const z = e.player(p).mz.findIndex((x) => x === null);
    if (z < 0) return false;
    const ps = e.player(p);
    (f.loc.zone === 'hand' ? ps.hand : f.loc.zone === 'deck' ? ps.deck : ps.gy).splice(f.loc.index, 1);
    ps.mz[z] = { ...card, pos: 'def', faceUp: true, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
    return true;
  });
  try {
    const e = duel(['Destiny Board', ...MSG]);
    playTrap(e, 0, 'Destiny Board');
    let turns = 0;
    while (e.state.winner === null && turns < 8) (endTurn(e), endTurn(e), turns++);
    check(e.state.winner === 0 && turns === 4, 'Destiny Board: with the 4 Spirit Messages on the field (3 as monsters), you win at the 4th placement');
  } finally {
    setSpiritPlaceHook(null);
  }
}
{
  // Sentence of Doom: add Fiends (up to the number of board cards), or send itself to place a message from the GY.
  const e = duel(['Destiny Board', 'Sentence of Doom', 'Snipe Hunter', 'Snipe Hunter', ...MSG]);
  playTrap(e, 0, 'Destiny Board');
  const doom = playTrap(e, 0, 'Sentence of Doom');
  for (const c of e.player(0).deck.filter((x) => x.name === 'Snipe Hunter').slice(0, 2)) run(e, e.sendToGrave(c.uid, 'cost'));
  effect(e, 0, doom, { pick: ['Add Fiend monsters from your GY / banishment to the hand'] }, { pick: ['Snipe Hunter', 'Snipe Hunter'] });
  check(e.player(0).hand.filter((c) => c.name === 'Snipe Hunter').length === 1 && inGy(e, 0, 'Snipe Hunter'), 'Sentence of Doom: adds Fiends up to the number of board cards (1)');
  check(!e.canUseMonsterEffect(0, doom!), 'Sentence of Doom: only 1 effect per turn');
  nextTurn(e);
  nextTurn(e);
  const a = grab(e, 0, 'Spirit Message "A"');
  run(e, e.sendToGrave(a.uid, 'cost'));
  effect(e, 0, doom, { pick: ['Send it to the GY: place a "Spirit Message" card'] }, { pick: ['Spirit Message "A"'] });
  const placed = e.spells(0).find((c) => c.name === 'Spirit Message "A"');
  check(zone(e, doom) === 'gy' && !!placed?.faceUp, 'Sentence of Doom: sends itself to the GY and places a Spirit Message from the GY');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
process.exit(fails ? 1 : 0);
