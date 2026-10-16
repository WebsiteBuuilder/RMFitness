// Speed Duel Continuous Spells/Traps, batch B (run: npx tsx tests/cont-b.test.ts)
import { Engine } from '../src/eds/engine';
import type { Card, CardInfo, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};

const FILL = 'Mammoth Graveyard'; // a plain Dinosaur Normal Monster

/** A Speed Duel with no shuffling: the given cards sit at the bottom of a filler Deck. */
function duel(deck0: string[], deck1: string[] = [], fusions: [string[], string[]] = [[], []], db: Map<string, CardInfo> = DB) {
  const e = new Engine(db);
  e.shuffle = <T,>(x: T[]) => x.slice();
  const fill = (d: string[]) => [...Array(28 - d.length).fill(FILL), ...d, 'Mystical Space Typhoon', 'Mystical Space Typhoon'];
  e.apply({ type: 'START', first: 0, seed: 3, names: ['A', 'B'], decks: [fill(deck0), fill(deck1)], fusions, mode: 'speed', skills: [null, null] });
  settle(e);
  return e;
}

type Step = 'Y' | 'N' | 'P' | string | number[];
let seen: string[] = [];
/** Answers every pending prompt: scripted answers first (in order), then pass / no / the first options. */
function settle(e: Engine, ...script: Step[]) {
  const q = [...script];
  seen = [];
  for (let i = 0; i < 300 && e.state.prompt && e.state.winner === null; i++) {
    const p = e.state.prompt;
    seen.push(`${p.kind}:${p.title ?? ''}${p.kind !== 'yesno' ? ' [' + p.options.map((o) => o.label).join(' | ') + ']' : ''}`);
    const s = q[0];
    if (p.kind === 'yesno') {
      if (s === 'Y' || s === 'N') q.shift();
      e.apply({ type: s === 'Y' ? 'YES' : 'NO', player: p.player });
      continue;
    }
    if (p.kind === 'response') {
      if (typeof s === 'string' && s !== 'Y' && s !== 'N') {
        q.shift();
        const idx = s === 'P' ? -1 : p.options.findIndex((o) => o.label === s || o.label.startsWith(s));
        if (idx >= 0) e.apply({ type: 'CHOOSE', player: p.player, picks: [idx] });
        else e.apply({ type: 'PASS', player: p.player });
      } else e.apply({ type: 'PASS', player: p.player });
      continue;
    }
    // select
    if (Array.isArray(s)) {
      q.shift();
      e.apply({ type: 'CHOOSE', player: p.player, picks: s });
      continue;
    }
    if (typeof s === 'string' && s !== 'Y' && s !== 'N' && s !== 'P') {
      const idx = p.options.findIndex((o) => o.label === s);
      const idx2 = idx >= 0 ? idx : p.options.findIndex((o) => o.label.toLowerCase().includes(s.toLowerCase()));
      if (idx2 >= 0) {
        q.shift();
        e.apply({ type: 'CHOOSE', player: p.player, picks: [idx2] });
        continue;
      }
    }
    const n = Math.max(p.min, Math.min(1, p.max));
    e.apply({ type: 'CHOOSE', player: p.player, picks: p.options.map((_, j) => j).slice(0, n) });
  }
  if (q.length) console.log('   (unused script answers:', JSON.stringify(q), 'prompts seen:', JSON.stringify(seen), ')');
}
const sawPrompt = (part: string) => seen.some((t) => t.includes(part));

const take = (e: Engine, p: Pid, name: string): Card => {
  const ps = e.player(p);
  const c = [...ps.hand, ...ps.deck, ...ps.gy, ...ps.removed, ...ps.fusion].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  return c;
};
/** Moves a card (from the Deck) to the hand. */
const give = (e: Engine, p: Pid, name: string) => {
  const c = take(e, p, name);
  if (e.find(c.uid)!.loc.zone !== 'hand') e.toHandOf(c.uid, p);
  return c;
};
const toGy = (e: Engine, p: Pid, name: string) => {
  const c = take(e, p, name);
  const f = e.find(c.uid)!;
  const ps = e.player(p);
  const arr = f.loc.zone === 'deck' ? ps.deck : f.loc.zone === 'hand' ? ps.hand : null;
  if (!arr) return c;
  arr.splice(f.loc.index, 1);
  ps.gy.push(c);
  return c;
};
const detach = (e: Engine, uid: number): Card => (e as any).detach(uid);
/** Puts a monster on the field directly (test setup). */
function place(e: Engine, p: Pid, name: string, pos: Pos = 'atk', faceUp = true): FieldCard {
  const card = detach(e, take(e, p, name).uid);
  const fc: FieldCard = (e as any).toField(card, pos, faceUp);
  fc.placedTurn = 0;
  const z = e.player(p).mz.findIndex((x) => x === null);
  e.player(p).mz[z] = fc;
  return fc;
}
/** Sets a Spell/Trap directly (as if Set on an earlier turn). */
function setCard(e: Engine, p: Pid, name: string): FieldCard {
  const card = detach(e, take(e, p, name).uid);
  const fc: FieldCard = (e as any).toField(card, 'atk', false);
  fc.placedTurn = 0;
  const z = e.player(p).sz.findIndex((x) => x === null);
  e.player(p).sz[z] = fc;
  return fc;
}
const fc = (e: Engine, uid: number) => e.fieldCard(uid);
const zone = (e: Engine, uid: number) => e.find(uid)?.loc.zone;
const stays = (e: Engine, uid: number) => {
  const c = e.fieldCard(uid);
  return !!c && c.faceUp && !!c.active && zone(e, uid) === 'sz';
};
const mon = (e: Engine, p: Pid, name: string) => e.monsters(p).find((m) => m.name === name);
/** Activates a card from the hand or a Set card during its controller's Main Phase. */
function activate(e: Engine, p: Pid, uid: number, ...script: Step[]) {
  e.apply({ type: 'ACTIVATE', player: p, uid });
  settle(e, ...script);
}
function endTurn(e: Engine, ...script: Step[]) {
  e.apply({ type: 'END_TURN', player: e.state.turnPlayer });
  settle(e, ...script);
}
function toBattle(e: Engine) {
  if (e.state.phase !== 'BP') e.apply({ type: 'NEXT_PHASE', player: e.state.turnPlayer });
  settle(e);
}
function attack(e: Engine, uid: number, target: number | null, ...script: Step[]) {
  toBattle(e);
  e.apply({ type: 'ATTACK', player: e.state.turnPlayer, uid, target });
  settle(e, ...script);
}
/** Destroys a card with a card effect (as Mystical Space Typhoon would). */
function zap(e: Engine, uid: number, ...script: Step[]) {
  (e as any).run(e.destroy([uid]));
  settle(e, ...script);
}
/** Mystical Space Typhoon from the hand of the turn player. */
function mst(e: Engine, targetName: string, ...script: Step[]) {
  const p = e.state.turnPlayer;
  const c = give(e, p, 'Mystical Space Typhoon');
  activate(e, p, c.uid, targetName, ...script);
}
/** The opponent Normal Summons a monster: their opponent gets a response window. */
function oppSummon(e: Engine, name: string, ...script: Step[]) {
  const p = e.state.turnPlayer;
  const c = give(e, p, name);
  e.player(p).normalSummoned = false;
  e.apply({ type: 'SUMMON', player: p, uid: c.uid, zone: e.player(p).mz.findIndex((x) => x === null), pos: 'atk', faceUp: true });
  settle(e, ...script);
  return e.fieldCard(c.uid);
}
const lp = (e: Engine, p: Pid) => e.player(p).lp;

// ============ Different Dimension Gate ============
{
  const e = duel(['Different Dimension Gate', 'Axe Raider', 'Mystical Space Typhoon', 'Different Dimension Gate'], ['Vorse Raider', 'Battle Ox']);
  const mine = place(e, 0, 'Axe Raider');
  const theirs = place(e, 1, 'Vorse Raider', 'def', false);
  const g = give(e, 0, 'Different Dimension Gate');
  check(e.canActivateMain(0, g.uid), 'DD Gate: can be activated with a monster on each side');
  activate(e, 0, g.uid, 'Axe Raider', 'Face-down card');
  check(zone(e, mine.uid) === 'removed' && zone(e, theirs.uid) === 'removed', 'DD Gate: both targets are banished');
  check(stays(e, g.uid), 'DD Gate: stays face-up on the field');
  endTurn(e);
  check(stays(e, g.uid), 'DD Gate: still on the field next turn');
  // The opponent destroys it with MST: the monsters come back in the positions they had.
  give(e, 1, 'Battle Ox');
  mst(e, 'Different Dimension Gate');
  check(zone(e, g.uid) === 'gy', 'DD Gate: destroyed by MST, in the GY');
  const back0 = fc(e, mine.uid);
  const back1 = fc(e, theirs.uid);
  check(back0 && e.controller(mine.uid) === 0 && back0.pos === 'atk' && back0.faceUp, 'DD Gate: Axe Raider returns to its owner in face-up Attack Position');
  check(back1 && e.controller(theirs.uid) === 1 && back1.pos === 'def' && !back1.faceUp, 'DD Gate: Vorse Raider returns face-down in Defense Position');
}
{
  // Sent to the GY without being destroyed: the monsters stay banished.
  const e = duel(['Different Dimension Gate', 'Axe Raider'], ['Vorse Raider']);
  const mine = place(e, 0, 'Axe Raider');
  const theirs = place(e, 1, 'Vorse Raider');
  const g = give(e, 0, 'Different Dimension Gate');
  activate(e, 0, g.uid, 'Axe Raider', 'Vorse Raider');
  (e as any).run(e.sendToGrave(g.uid, 'cost'));
  settle(e);
  check(zone(e, mine.uid) === 'removed' && zone(e, theirs.uid) === 'removed', 'DD Gate: sent to the GY (not destroyed) -> the monsters stay banished');
  const e2 = duel(['Different Dimension Gate'], ['Vorse Raider']);
  place(e2, 1, 'Vorse Raider');
  check(!e2.canActivateMain(0, give(e2, 0, 'Different Dimension Gate').uid), 'DD Gate: cannot be activated without a monster of your own');
}

// ============ Dark Smog ============
{
  const e = duel(['Dark Smog', 'Feral Imp', 'Ryu-Kishin Powered', 'Axe Raider'], ['Vorse Raider', 'Battle Ox', 'Battle Ox']);
  toGy(e, 1, 'Vorse Raider');
  toGy(e, 1, 'Battle Ox');
  const s = setCard(e, 0, 'Dark Smog');
  activate(e, 0, s.uid);
  check(stays(e, s.uid), 'Dark Smog: activated and stays face-up');
  check(!e.canUseMonsterEffect(0, s), 'Dark Smog: no Fiend in hand -> its effect cannot be used');
  give(e, 0, 'Feral Imp');
  give(e, 0, 'Axe Raider');
  check(e.canUseMonsterEffect(0, s), 'Dark Smog: usable with a Fiend in hand and a monster in the opponent GY');
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: s.uid });
  settle(e, 'Vorse Raider', 'Feral Imp');
  check(zone(e, take(e, 1, 'Vorse Raider').uid) === 'removed', 'Dark Smog: the target is banished');
  check(e.player(0).gy.some((c) => c.name === 'Feral Imp') && e.player(0).hand.some((c) => c.name === 'Axe Raider'), 'Dark Smog: the Fiend was discarded (not the Warrior)');
  give(e, 0, 'Ryu-Kishin Powered');
  check(!e.canUseMonsterEffect(0, s), 'Dark Smog: once per turn');
  check(stays(e, s.uid), 'Dark Smog: still on the field after its effect');
  endTurn(e);
  endTurn(e);
  check(e.canUseMonsterEffect(0, s), 'Dark Smog: usable again on the next turn');
  zap(e, s.uid);
  check(zone(e, s.uid) === 'gy' && !e.canUseMonsterEffect(0, take(e, 0, 'Dark Smog')), 'Dark Smog: gone after being destroyed');
}
{
  // Activation on the opponent's turn.
  const e = duel(['Dark Smog'], ['Vorse Raider']);
  const s = setCard(e, 0, 'Dark Smog');
  endTurn(e);
  oppSummon(e, 'Vorse Raider', 'Dark Smog');
  check(stays(e, s.uid), 'Dark Smog: can be activated on the opponent\'s turn');
}

// ============ Destiny Board ============
{
  // "Spirit Message" cards are not in the card list: add them for this check.
  const db = new Map(DB);
  const msgs = ['Spirit Message "I"', 'Spirit Message "N"', 'Spirit Message "A"', 'Spirit Message "L"'];
  msgs.forEach((n, i) => {
    const info: CardInfo = { id: 900000 + i, name: n, kind: 'trap', sub: 'Continuous', desc: 'Spirit Message', speed: true } as CardInfo;
    db.set(n, info);
    db.set(n.toLowerCase(), info);
  });
  const e = duel(['Destiny Board', ...msgs], [], [[], []], db);
  const b = setCard(e, 0, 'Destiny Board');
  activate(e, 0, b.uid);
  check(stays(e, b.uid), 'Destiny Board: activated and stays face-up');
  check(e.spells(0).length === 1, 'Destiny Board: nothing is placed on its own activation');
  endTurn(e); // P0 End Phase: nothing
  check(e.spells(0).length === 1, 'Destiny Board: nothing placed in your own End Phase');
  endTurn(e); // P1 End Phase: "I"
  check(e.spells(0).some((c) => c.name === msgs[0] && c.faceUp), 'Destiny Board: "I" placed in the opponent\'s End Phase');
  endTurn(e);
  endTurn(e); // "N"
  check(e.spells(0).some((c) => c.name === msgs[1]), 'Destiny Board: "N" placed in the next opponent End Phase');
  endTurn(e);
  endTurn(e); // no zone left for "A" (Speed Duel has 3 Spell/Trap Zones)
  check(e.spells(0).length === 3 && e.state.winner === null, 'Destiny Board: with no free zone nothing more is placed');
  // With two extra zones (script check only), the board finishes the word and wins.
  e.player(0).sz.push(null, null);
  endTurn(e);
  endTurn(e);
  endTurn(e);
  endTurn(e);
  check(e.state.winner === 0, 'Destiny Board: F-I-N-A-L wins the Duel');

  // Destroying the board sends every Spirit Message to the GY.
  const f = duel(['Destiny Board', ...msgs], [], [[], []], db);
  const b2 = setCard(f, 0, 'Destiny Board');
  activate(f, 0, b2.uid);
  endTurn(f);
  endTurn(f);
  endTurn(f);
  endTurn(f);
  check(f.spells(0).length === 3, 'Destiny Board: two Spirit Messages placed');
  zap(f, b2.uid);
  check(f.spells(0).length === 0 && f.player(0).gy.filter((c) => c.name.startsWith('Spirit Message')).length === 2, 'Destiny Board: destroyed -> the Spirit Messages go to the GY too');
  // Destroying a Spirit Message sends the board and the rest.
  const g = duel(['Destiny Board', ...msgs], [], [[], []], db);
  const b3 = setCard(g, 0, 'Destiny Board');
  activate(g, 0, b3.uid);
  endTurn(g);
  endTurn(g);
  endTurn(g);
  endTurn(g);
  zap(g, g.spells(0).find((c) => c.name === msgs[0])!.uid);
  check(g.spells(0).length === 0 && zone(g, b3.uid) === 'gy', 'Destiny Board: a Spirit Message leaving takes the board and the other message with it');
  endTurn(g);
  endTurn(g);
  check(g.spells(0).length === 0, 'Destiny Board: nothing placed once it is gone');
}

// ============ Evo-Price ============
{
  const e = duel(['Evo-Price', 'Evoltile Lagosucho', 'Evoltile Lagosucho', 'Evoltile Lagosucho', 'Axe Raider'], ['Vorse Raider', 'Battle Ox']);
  const lag = place(e, 0, 'Evoltile Lagosucho', 'def', false);
  const v = place(e, 1, 'Vorse Raider');
  const ox = place(e, 1, 'Battle Ox');
  const ep = give(e, 0, 'Evo-Price');
  activate(e, 0, ep.uid);
  check(stays(e, ep.uid), 'Evo-Price: activated and stays face-up');
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: lag.uid });
  settle(e, 'Y', 'Evoltile Lagosucho', 'Y', 'Vorse Raider');
  check(e.monsters(0).length === 2, 'Evo-Price: Lagosucho Special Summoned an Evoltile');
  check(zone(e, v.uid) === 'gy', 'Evo-Price: destroyed a card on the field');
  check(stays(e, ep.uid), 'Evo-Price: still on the field');
  // Once per turn.
  const lag2 = e.monsters(0).find((m) => m.uid !== lag.uid)!;
  lag2.pos = 'def';
  lag2.faceUp = false;
  lag2.placedTurn = 0;
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: lag2.uid });
  settle(e, 'Y', 'Evoltile Lagosucho', 'Y', 'Battle Ox');
  check(fc(e, ox.uid) && !sawPrompt('Evo-Price'), 'Evo-Price: only once per turn');
  // A Special Summon that is not by an Evoltile does nothing.
  const e2 = duel(['Evo-Price', 'Axe Raider', 'Monster Reborn'], ['Vorse Raider']);
  place(e2, 1, 'Vorse Raider');
  toGy(e2, 0, 'Axe Raider');
  activate(e2, 0, give(e2, 0, 'Evo-Price').uid);
  activate(e2, 0, give(e2, 0, 'Monster Reborn').uid, 'Axe Raider', 'Y');
  check(mon(e2, 0, 'Axe Raider') && !sawPrompt('Evo-Price') && mon(e2, 1, 'Vorse Raider'), 'Evo-Price: a Special Summon not by an Evoltile does not trigger it');
  // Gone from the field: no effect.
  const e3 = duel(['Evo-Price', 'Evoltile Lagosucho', 'Evoltile Lagosucho'], ['Vorse Raider']);
  const l3 = place(e3, 0, 'Evoltile Lagosucho', 'def', false);
  const v3 = place(e3, 1, 'Vorse Raider');
  const ep3 = give(e3, 0, 'Evo-Price');
  activate(e3, 0, ep3.uid);
  zap(e3, ep3.uid);
  e3.apply({ type: 'FLIP_SUMMON', player: 0, uid: l3.uid });
  settle(e3, 'Y', 'Evoltile Lagosucho', 'Y', 'Vorse Raider');
  check(fc(e3, v3.uid) && !sawPrompt('Evo-Price'), 'Evo-Price: no effect after it is destroyed');
}

// ============ Fire Formation - Tenki ============
{
  const e = duel(['Fire Formation - Tenki', 'Fire Formation - Tenki', 'Beaver Warrior', 'Battle Ox', 'Axe Raider'], ['Vorse Raider']);
  const ox = place(e, 0, 'Battle Ox');
  const axe = place(e, 0, 'Axe Raider');
  const vorse = place(e, 1, 'Vorse Raider');
  const t = give(e, 0, 'Fire Formation - Tenki');
  activate(e, 0, t.uid, 'Y', 'Beaver Warrior');
  check(e.player(0).hand.some((c) => c.name === 'Beaver Warrior'), 'Tenki: adds a Level 4 or lower Beast-Warrior on activation');
  check(stays(e, t.uid), 'Tenki: stays face-up');
  check(e.atkOf(ox) === 1800 && e.atkOf(axe) === 1700 && e.atkOf(vorse) === 1900, "Tenki: only your Beast-Warriors gain 100 ATK (not Warriors, not the opponent's)");
  const t2 = give(e, 0, 'Fire Formation - Tenki');
  check(!e.canActivateMain(0, t2.uid), 'Tenki: only 1 activation per turn');
  endTurn(e);
  endTurn(e);
  check(e.atkOf(ox) === 1800, 'Tenki: the boost lasts into later turns');
  zap(e, t.uid);
  check(e.atkOf(ox) === 1700, 'Tenki: the boost ends when it leaves the field');
}

// ============ Frontline Base ============
{
  const e = duel(['Frontline Base', 'Y-Dragon Head', 'Z-Metal Tank', 'Axe Raider']);
  const fb = give(e, 0, 'Frontline Base');
  activate(e, 0, fb.uid);
  check(stays(e, fb.uid), 'Frontline Base: activated and stays face-up');
  const fbc = fc(e, fb.uid)!;
  check(!e.canUseMonsterEffect(0, fbc), 'Frontline Base: no Union in hand -> not usable');
  give(e, 0, 'Y-Dragon Head');
  give(e, 0, 'Z-Metal Tank');
  check(e.canUseMonsterEffect(0, fbc), 'Frontline Base: usable with a Union monster in hand');
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: fb.uid });
  settle(e, 'Y-Dragon Head');
  check(mon(e, 0, 'Y-Dragon Head'), 'Frontline Base: Special Summons the Union monster');
  check(!e.canUseMonsterEffect(0, fbc), 'Frontline Base: once per turn');
  endTurn(e);
  endTurn(e);
  check(e.canUseMonsterEffect(0, fbc), 'Frontline Base: usable again next turn');
  zap(e, fb.uid);
  check(zone(e, fb.uid) === 'gy' && !e.canUseMonsterEffect(0, take(e, 0, 'Frontline Base')), 'Frontline Base: gone once destroyed');
}

// ============ Future Fusion ============
{
  const e = duel(['Future Fusion', 'Battle Ox', 'Mystic Horseman'], [], [['Rabid Horseman'], []]);
  const ff = give(e, 0, 'Future Fusion');
  activate(e, 0, ff.uid);
  check(stays(e, ff.uid), 'Future Fusion: activated and stays face-up');
  endTurn(e);
  check(e.player(0).deck.some((c) => c.name === 'Battle Ox'), 'Future Fusion: nothing during the opponent\'s Standby Phase');
  endTurn(e, 'Rabid Horseman');
  check(e.player(0).gy.some((c) => c.name === 'Battle Ox') && e.player(0).gy.some((c) => c.name === 'Mystic Horseman'), 'Future Fusion: 1st Standby -> the materials go from the Deck to the GY');
  check(!mon(e, 0, 'Rabid Horseman'), 'Future Fusion: no Fusion Summon yet');
  endTurn(e);
  endTurn(e);
  const rh = mon(e, 0, 'Rabid Horseman');
  check(rh && fc(e, ff.uid)?.equippedTo === rh.uid, 'Future Fusion: 2nd Standby -> Rabid Horseman is Fusion Summoned and targeted');
  check(stays(e, ff.uid), 'Future Fusion: still on the field after the summon');
  mst(e, 'Future Fusion');
  check(zone(e, ff.uid) === 'gy' && rh && zone(e, rh.uid) === 'gy', 'Future Fusion: leaving the field destroys the Fusion Monster');

  const f = duel(['Future Fusion', 'Battle Ox', 'Mystic Horseman'], [], [['Rabid Horseman'], []]);
  const ff2 = give(f, 0, 'Future Fusion');
  activate(f, 0, ff2.uid);
  endTurn(f);
  endTurn(f, 'Rabid Horseman');
  endTurn(f);
  endTurn(f);
  const rh2 = mon(f, 0, 'Rabid Horseman')!;
  zap(f, rh2.uid);
  check(zone(f, ff2.uid) === 'gy', 'Future Fusion: the Fusion Monster destroyed -> Future Fusion goes too');
}

// ============ Embodiment of Apophis ============
{
  const e = duel(['Embodiment of Apophis', 'Embodiment of Apophis'], ['Vorse Raider', 'Battle Ox']);
  const a = setCard(e, 0, 'Embodiment of Apophis');
  check(e.canActivateMain(0, a.uid), 'Apophis: can be activated in your Main Phase');
  activate(e, 0, a.uid);
  const m = fc(e, a.uid);
  check(m && zone(e, a.uid) === 'mz' && m.faceUp && m.pos === 'atk', 'Apophis: Special Summoned as a monster');
  check(m && e.atkOf(m) === 1600 && e.defOf(m) === 1800, 'Apophis: 1600 ATK / 1800 DEF');
  endTurn(e);
  check(zone(e, a.uid) === 'mz', 'Apophis: stays on the field as a monster');
  // Opponent's Main Phase: allowed. Opponent's Battle Phase: not.
  const e2 = duel(['Embodiment of Apophis'], ['Vorse Raider', 'Battle Ox']);
  const a2 = setCard(e2, 0, 'Embodiment of Apophis');
  endTurn(e2);
  const ox = place(e2, 1, 'Battle Ox');
  attack(e2, ox.uid, null);
  check(!sawPrompt('Embodiment of Apophis') && zone(e2, a2.uid) === 'sz', 'Apophis: not offered during the Battle Phase');
  endTurn(e2);
  endTurn(e2);
  oppSummon(e2, 'Vorse Raider', 'Embodiment of Apophis');
  check(zone(e2, a2.uid) === 'mz', "Apophis: can be activated in the opponent's Main Phase");
  zap(e2, a2.uid);
  check(zone(e2, a2.uid) === 'gy', 'Apophis: destroyed like a monster, to the GY');
}

// ============ Fairy Box ============
{
  const e = duel(['Fairy Box', 'Axe Raider'], ['Vorse Raider', 'Battle Ox']);
  e.roll = () => 1; // the coin shows Heads
  const axe = place(e, 0, 'Axe Raider');
  const fb = setCard(e, 0, 'Fairy Box');
  activate(e, 0, fb.uid);
  check(stays(e, fb.uid), 'Fairy Box: activated and stays face-up');
  endTurn(e);
  const vorse = place(e, 1, 'Vorse Raider');
  attack(e, vorse.uid, axe.uid, 'Fairy Box', 'Heads');
  check(zone(e, vorse.uid) === 'gy' && fc(e, axe.uid) && lp(e, 1) === 4000 - 1700, 'Fairy Box: right call -> attacker ATK 0, destroyed by Axe Raider');
  const ox = place(e, 1, 'Battle Ox');
  zap(e, axe.uid);
  attack(e, ox.uid, null, 'Fairy Box', 'Tails');
  check(lp(e, 0) === 4000 - 1700, 'Fairy Box: wrong call -> the attack goes through');
  check(stays(e, fb.uid), 'Fairy Box: stays after use');
  ox.attacked = false;
  attack(e, ox.uid, null, 'Fairy Box', 'Heads');
  check(lp(e, 0) === 4000 - 1700 && e.atkOf(ox) === 0, 'Fairy Box: works on a direct attack too (ATK 0 until the end of the Battle Phase)');
  endTurn(e, 'Y'); // P0 Standby: pay 500
  check(lp(e, 0) === 4000 - 1700 - 500 && stays(e, fb.uid), 'Fairy Box: paid 500 LP in your Standby Phase, stays');
  check(e.atkOf(ox) === 1700, 'Fairy Box: the ATK change is over after that turn');
  endTurn(e);
  check(lp(e, 0) === 4000 - 2200 && stays(e, fb.uid), 'Fairy Box: no cost in the opponent\'s Standby Phase');
  endTurn(e, 'N');
  check(zone(e, fb.uid) === 'gy', 'Fairy Box: not paying destroys it');
  endTurn(e);
  attack(e, ox.uid, null, 'Fairy Box', 'Heads');
  check(!sawPrompt('Fairy Box') && lp(e, 0) === 4000 - 2200 - 1700, 'Fairy Box: no effect once gone');
}

// ============ Final Attack Orders ============
{
  const e = duel(['Final Attack Orders', 'Axe Raider', 'Celtic Guardian'], ['Vorse Raider', 'Battle Ox']);
  const axe = place(e, 0, 'Axe Raider', 'def');
  const vorse = place(e, 1, 'Vorse Raider', 'def');
  const ox = place(e, 1, 'Battle Ox', 'def', false);
  const fao = setCard(e, 0, 'Final Attack Orders');
  activate(e, 0, fao.uid);
  check(stays(e, fao.uid), 'Final Attack Orders: activated and stays face-up');
  check(axe.pos === 'atk' && vorse.pos === 'atk', 'Final Attack Orders: face-up monsters change to Attack Position');
  check(ox.pos === 'def' && !ox.faceUp, 'Final Attack Orders: face-down monsters are not changed');
  check(!e.canChangePosition(0, axe), 'Final Attack Orders: positions cannot be changed');
  const cg = give(e, 0, 'Celtic Guardian');
  e.apply({ type: 'SUMMON', player: 0, uid: cg.uid, zone: 2, pos: 'def', faceUp: true });
  settle(e);
  check(fc(e, cg.uid)?.pos === 'atk', 'Final Attack Orders: a monster Summoned face-up in Defense goes to Attack Position');
  endTurn(e);
  check(!e.canChangePosition(1, vorse), "Final Attack Orders: still locked on the opponent's turn");
  endTurn(e);
  check(!e.canChangePosition(0, axe), 'Final Attack Orders: still locked turns later');
  mst(e, 'Final Attack Orders');
  check(zone(e, fao.uid) === 'gy' && e.canChangePosition(0, axe), 'Final Attack Orders: positions can change again once it is gone');
}

// ============ Firewall ============
{
  const e = duel(['Firewall', 'Charcoal Inpachi', 'Axe Raider'], ['Vorse Raider', 'Battle Ox']);
  const fw = setCard(e, 0, 'Firewall');
  activate(e, 0, fw.uid);
  check(stays(e, fw.uid), 'Firewall: activated and stays face-up');
  endTurn(e);
  const vorse = place(e, 1, 'Vorse Raider');
  attack(e, vorse.uid, null, 'Firewall');
  check(!sawPrompt('Firewall') && lp(e, 0) === 2100, 'Firewall: not offered with no Pyro in the GY');
  toGy(e, 0, 'Charcoal Inpachi');
  vorse.attacked = false;
  attack(e, vorse.uid, null, 'Firewall', 'Charcoal Inpachi');
  check(lp(e, 0) === 2100 && zone(e, take(e, 0, 'Charcoal Inpachi').uid) === 'removed', 'Firewall: banishes a Pyro and negates the direct attack');
  endTurn(e, 'Y');
  check(lp(e, 0) === 1600 && stays(e, fw.uid), 'Firewall: paid 500 LP in your Standby Phase');
  const axe = place(e, 0, 'Axe Raider');
  endTurn(e);
  check(lp(e, 0) === 1600, "Firewall: no cost in the opponent's Standby Phase");
  toGy(e, 0, 'Charcoal Inpachi');
  const ox = place(e, 1, 'Battle Ox');
  attack(e, vorse.uid, axe.uid);
  check(!sawPrompt('Firewall'), 'Firewall: not offered against an attack on a monster');
  endTurn(e, 'N');
  check(zone(e, fw.uid) === 'gy', 'Firewall: not paying destroys it');
  void ox;
}

// ============ Goblin Circus ============
{
  const e = duel(['Goblin Circus', 'Axe Raider', 'Celtic Guardian']);
  const gc = give(e, 0, 'Goblin Circus');
  activate(e, 0, gc.uid);
  check(stays(e, gc.uid), 'Goblin Circus: activated and stays face-up');
  const bottom = e.player(0).deck[e.player(0).deck.length - 1];
  endTurn(e, 'Place it on top of the Deck');
  check(sawPrompt('Goblin Circus') && zone(e, bottom.uid) === 'deck' && e.player(0).deck[0].uid === bottom.uid, 'Goblin Circus: End Phase -> the bottom card goes on top');
  // Opponent's End Phase: nothing. (P1 draws normally.)
  endTurn(e);
  check(!sawPrompt('Goblin Circus'), "Goblin Circus: nothing in the opponent's End Phase");
  check(e.player(0).hand.some((c) => c.uid === bottom.uid), 'Goblin Circus: the card put on top was drawn');
  const bottom2 = e.player(0).deck[e.player(0).deck.length - 1];
  endTurn(e, 'Banish it face-down');
  check(zone(e, bottom2.uid) === 'removed', 'Goblin Circus: or banishes it face-down');
  endTurn(e);
  zap(e, gc.uid);
  endTurn(e);
  check(!sawPrompt('Goblin Circus'), 'Goblin Circus: nothing once destroyed');
}

// ============ Hysteric Sign ============
{
  const e = duel(['Hysteric Sign', 'Elegant Egotist', 'Harpie Lady 1', 'Harpie Lady 2', 'Cyber Harpie Lady', 'Harpie Lady 1']);
  const hs = give(e, 0, 'Hysteric Sign');
  activate(e, 0, hs.uid);
  check(e.player(0).hand.some((c) => c.name === 'Elegant Egotist'), 'Hysteric Sign: adds Elegant Egotist on activation');
  check(stays(e, hs.uid), 'Hysteric Sign: stays face-up');
  endTurn(e);
  check(stays(e, hs.uid), 'Hysteric Sign: still on the field next turn');
  // Destroyed on the opponent's turn: in that End Phase, up to 3 Harpie cards.
  mst(e, 'Hysteric Sign');
  const before = e.player(0).hand.length;
  endTurn(e, [0, 1, 2]);
  const names = e.player(0).hand.filter((c) => c.name.includes('Harpie')).map((c) => c.name);
  check(names.length === 3 && new Set(names).size === 3 && e.player(0).hand.length === before + 3 + 1, 'Hysteric Sign: End Phase of the turn it was destroyed -> 3 Harpie cards with different names');
  endTurn(e);
  check(!sawPrompt('Hysteric Sign'), 'Hysteric Sign: only in the End Phase of the turn it was sent');
  // Activated and destroyed in the same turn: only 1 Hysteric Sign effect per turn.
  const f = duel(['Hysteric Sign', 'Elegant Egotist', 'Harpie Lady 1']);
  const hs2 = give(f, 0, 'Hysteric Sign');
  activate(f, 0, hs2.uid);
  zap(f, hs2.uid);
  endTurn(f);
  check(!sawPrompt('Hysteric Sign') && f.player(0).deck.some((c) => c.name === 'Harpie Lady 1'), 'Hysteric Sign: no End Phase search on the turn it was activated');
  // Discarded from the hand.
  const g = duel(['Hysteric Sign', 'Harpie Lady 1']);
  const hs3 = give(g, 0, 'Hysteric Sign');
  (g as any).run(g.discard(0, hs3.uid));
  settle(g);
  endTurn(g, 'Harpie Lady 1');
  check(g.player(0).hand.some((c) => c.name === 'Harpie Lady 1'), 'Hysteric Sign: discarded from the hand -> search in the End Phase');
}

// ============ Infinite Cards ============
{
  const e = duel(['Infinite Cards']);
  const ic = give(e, 0, 'Infinite Cards');
  activate(e, 0, ic.uid);
  check(stays(e, ic.uid), 'Infinite Cards: activated and stays face-up');
  for (let i = 0; i < 5; i++) e.toHandOf(e.player(0).deck[0].uid, 0);
  const n = e.player(0).hand.length;
  endTurn(e);
  check(n > 6 && e.player(0).hand.length === n && !sawPrompt('Hand limit'), 'Infinite Cards: no hand limit in your End Phase');
  for (let i = 0; i < 6; i++) e.toHandOf(e.player(1).deck[0].uid, 1);
  const m = e.player(1).hand.length;
  endTurn(e);
  check(m > 6 && e.player(1).hand.length === m, "Infinite Cards: no hand limit for the opponent either");
  zap(e, ic.uid);
  endTurn(e);
  check(e.player(0).hand.length === 6 && sawPrompt('Hand limit'), 'Infinite Cards: the hand limit is back once it is destroyed');
}

// ============ Insect Barrier ============
{
  const e = duel(['Insect Barrier', 'Big Insect'], ['Gokibore', 'Battle Ox']);
  const ib = give(e, 0, 'Insect Barrier');
  activate(e, 0, ib.uid);
  check(stays(e, ib.uid), 'Insect Barrier: activated and stays face-up');
  const mine = place(e, 0, 'Big Insect');
  endTurn(e);
  const g = place(e, 1, 'Gokibore');
  const ox = place(e, 1, 'Battle Ox');
  toBattle(e);
  check(!e.canAttackWith(1, g) && e.canAttackWith(1, ox), "Insect Barrier: the opponent's Insects cannot attack, others can");
  endTurn(e);
  toBattle(e);
  check(e.canAttackWith(0, mine), 'Insect Barrier: your own Insects can still attack');
  endTurn(e);
  toBattle(e);
  check(!e.canAttackWith(1, g), 'Insect Barrier: still in effect turns later');
  endTurn(e);
  mst(e, 'Insect Barrier');
  endTurn(e);
  toBattle(e);
  check(e.canAttackWith(1, g), 'Insect Barrier: Insects can attack once it is destroyed');
}

// ============ Insect Neglect ============
{
  const e = duel(['Insect Neglect', 'Basic Insect', 'Kumootoko'], ['Vorse Raider']);
  const ins = give(e, 0, 'Insect Neglect');
  activate(e, 0, ins.uid);
  check(stays(e, ins.uid), 'Insect Neglect: activated and stays face-up');
  endTurn(e);
  const v = place(e, 1, 'Vorse Raider');
  attack(e, v.uid, null, 'Insect Neglect');
  check(!sawPrompt('Insect Neglect') && lp(e, 0) === 2100, 'Insect Neglect: not offered without an Insect in the GY');
  toGy(e, 0, 'Basic Insect');
  toGy(e, 0, 'Kumootoko');
  endTurn(e);
  endTurn(e);
  attack(e, v.uid, null, 'Insect Neglect', 'Basic Insect');
  check(lp(e, 0) === 2100 && zone(e, take(e, 0, 'Basic Insect').uid) === 'removed', 'Insect Neglect: banishes an Insect and negates the attack');
  endTurn(e);
  mst(e, 'Insect Neglect');
  endTurn(e);
  attack(e, v.uid, null, 'Insect Neglect');
  check(!sawPrompt('Insect Neglect') && lp(e, 0) === 200, 'Insect Neglect: nothing once destroyed');
}

// ============ Gravekeeper's Trap ============
{
  const e = duel(["Gravekeeper's Trap", "Gravekeeper's Spy", "Gravekeeper's Guard"], ['Vorse Raider']);
  const gt = setCard(e, 0, "Gravekeeper's Trap");
  endTurn(e);
  oppSummon(e, 'Vorse Raider', "Gravekeeper's Trap");
  check(stays(e, gt.uid), "Gravekeeper's Trap: activated on the opponent's turn, stays face-up");
  endTurn(e);
  const g = fc(e, gt.uid)!;
  check(e.canUseMonsterEffect(0, g), "Gravekeeper's Trap: search usable in your Main Phase");
  const cost = e.player(0).hand[0];
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: gt.uid });
  settle(e, cost.name, "Gravekeeper's Spy");
  check(e.player(0).hand.some((c) => c.name === "Gravekeeper's Spy") && zone(e, cost.uid) === 'gy', "Gravekeeper's Trap: discard 1 -> add a Gravekeeper's monster");
  check(!e.canUseMonsterEffect(0, g), "Gravekeeper's Trap: once per turn");
  endTurn(e);
  endTurn(e);
  check(e.canUseMonsterEffect(0, g), "Gravekeeper's Trap: usable again next turn");
  zap(e, gt.uid);
  check(zone(e, gt.uid) === 'gy' && !e.canUseMonsterEffect(0, take(e, 0, "Gravekeeper's Trap")), "Gravekeeper's Trap: gone once destroyed");
}

// ============ Hieratic Seal From the Ashes ============
{
  const e = duel(['Hieratic Seal From the Ashes', 'Hieratic Dragon of Nuit', 'Hieratic Dragon of Su', 'Hieratic Dragon of Nuit'], ['Vorse Raider', 'Battle Ox']);
  const hs = setCard(e, 0, 'Hieratic Seal From the Ashes');
  activate(e, 0, hs.uid);
  check(stays(e, hs.uid), 'Hieratic Seal: activated and stays face-up');
  endTurn(e);
  oppSummon(e, 'Vorse Raider', 'Hieratic Seal From the Ashes', 'Hieratic Dragon of Su');
  check(e.player(0).gy.some((c) => c.name === 'Hieratic Dragon of Su'), "Hieratic Seal: on the opponent's turn, a Hieratic monster goes from the Deck to the GY");
  oppSummon(e, 'Battle Ox');
  check(!sawPrompt('Hieratic Seal'), 'Hieratic Seal: once per turn');
  endTurn(e);
  const nuit = take(e, 0, 'Hieratic Dragon of Nuit');
  detach(e, nuit.uid);
  e.player(0).removed.push(nuit);
  const h = fc(e, hs.uid)!;
  check(e.canUseMonsterEffect(0, h), 'Hieratic Seal: on your turn, can return a banished Hieratic');
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: hs.uid });
  settle(e);
  check(zone(e, nuit.uid) === 'gy', 'Hieratic Seal: the banished Hieratic returns to the GY');
  check(!e.canUseMonsterEffect(0, h), 'Hieratic Seal: that effect is once per turn');
  zap(e, hs.uid, 'Hieratic Dragon of Su');
  check(mon(e, 0, 'Hieratic Dragon of Su'), 'Hieratic Seal: sent from the field to the GY -> Special Summons a Hieratic from the GY');
}

// ============ Howl of the Wild ============
{
  const e = duel(['Howl of the Wild', "Alligator's Sword", 'Mystic Horseman'], ['Basic Insect', 'Kumootoko', 'Vorse Raider']);
  const how = setCard(e, 0, 'Howl of the Wild');
  endTurn(e);
  oppSummon(e, 'Vorse Raider', 'Howl of the Wild');
  check(stays(e, how.uid), "Howl of the Wild: activated on the opponent's turn, stays face-up");
  endTurn(e);
  const al = place(e, 0, "Alligator's Sword");
  const mh = place(e, 0, 'Mystic Horseman');
  zap(e, mon(e, 1, 'Vorse Raider')!.uid);
  const bi = place(e, 1, 'Basic Insect');
  const ku = place(e, 1, 'Kumootoko');
  attack(e, al.uid, bi.uid, 'Howl of the Wild');
  check(zone(e, bi.uid) === 'gy' && lp(e, 1) === 4000 - 1000 - 600, 'Howl of the Wild: destroying a monster by battle -> 300 per Beast (600)');
  attack(e, mh.uid, ku.uid, 'Howl of the Wild');
  check(zone(e, ku.uid) === 'gy' && lp(e, 1) === 4000 - 1600 - 600 - 600, 'Howl of the Wild: again on the next battle');
  endTurn(e);
  mst(e, 'Howl of the Wild');
  endTurn(e);
  const k2 = place(e, 1, 'Vorse Raider', 'atk');
  zap(e, k2.uid);
  void k2;
}
{
  const e = duel(['Howl of the Wild', "Alligator's Sword"], ['Basic Insect']);
  const how = setCard(e, 0, 'Howl of the Wild');
  activate(e, 0, how.uid);
  zap(e, how.uid);
  endTurn(e);
  endTurn(e);
  const al = place(e, 0, "Alligator's Sword");
  const bi = place(e, 1, 'Basic Insect');
  attack(e, al.uid, bi.uid, 'Howl of the Wild');
  check(!sawPrompt('Howl of the Wild') && lp(e, 1) === 3000, 'Howl of the Wild: nothing once destroyed');
}

// ============ Hysteric Party ============
{
  const e = duel(['Hysteric Party', 'Harpie Lady', 'Harpie Lady 1', 'Axe Raider'], ['Vorse Raider']);
  toGy(e, 0, 'Harpie Lady');
  toGy(e, 0, 'Harpie Lady 1');
  const hp = setCard(e, 0, 'Hysteric Party');
  const ax = give(e, 0, 'Axe Raider');
  activate(e, 0, hp.uid, 'Axe Raider');
  check(zone(e, ax.uid) === 'gy', 'Hysteric Party: discards 1 card to activate');
  check(mon(e, 0, 'Harpie Lady') && mon(e, 0, 'Harpie Lady 1'), 'Hysteric Party: Special Summons every "Harpie Lady" from the GY');
  check(stays(e, hp.uid), 'Hysteric Party: stays face-up');
  endTurn(e);
  mst(e, 'Hysteric Party');
  check(e.monsters(0).length === 0, 'Hysteric Party: leaving the field destroys those monsters');
}

// ============ Jam Defender ============
{
  const e = duel(['Jam Defender', 'Revival Jam', 'Axe Raider'], ['Vorse Raider']);
  const jam = place(e, 0, 'Revival Jam', 'def');
  const axe = place(e, 0, 'Axe Raider');
  const jd = setCard(e, 0, 'Jam Defender');
  activate(e, 0, jd.uid);
  check(stays(e, jd.uid), 'Jam Defender: activated and stays face-up');
  endTurn(e);
  const v = place(e, 1, 'Vorse Raider');
  attack(e, v.uid, axe.uid, 'Jam Defender');
  check(fc(e, axe.uid) && lp(e, 0) === 4000, 'Jam Defender: the attack is moved to Revival Jam (Axe Raider survives, no damage)');
  check(e.state.log.some((l) => l.text.includes('Jam Defender switches')), 'Jam Defender: logged the switch');
  void jam;
  endTurn(e);
  mst(e, 'Jam Defender');
  endTurn(e);
  attack(e, v.uid, axe.uid, 'Jam Defender');
  check(!sawPrompt('Jam Defender') && zone(e, axe.uid) === 'gy', 'Jam Defender: nothing once destroyed');
}

// ============ Mirage of Nightmare ============
{
  const e = duel(['Mirage of Nightmare']);
  const mn = give(e, 0, 'Mirage of Nightmare');
  activate(e, 0, mn.uid);
  check(stays(e, mn.uid), 'Mirage of Nightmare: activated and stays face-up');
  while (e.player(0).hand.length > 1) e.toDeckTop(e.player(0).hand[0].uid);
  endTurn(e);
  check(e.player(0).hand.length === 4, "Mirage of Nightmare: opponent's Standby -> draw until 4 cards");
  endTurn(e);
  check(e.player(0).hand.length === 2, 'Mirage of Nightmare: your next Standby -> discard as many as you drew (5 - 3)');
  check(e.player(0).gy.length === 3, 'Mirage of Nightmare: 3 cards discarded');
  endTurn(e);
  endTurn(e);
  check(e.player(0).hand.length === 3 && e.player(0).gy.length === 5, 'Mirage of Nightmare: repeats every turn cycle (draw 2, then discard 2)');
  // Destroyed after drawing: no discard.
  const f = duel(['Mirage of Nightmare']);
  const mn2 = give(f, 0, 'Mirage of Nightmare');
  activate(f, 0, mn2.uid);
  while (f.player(0).hand.length > 0) f.toDeckTop(f.player(0).hand[0].uid);
  endTurn(f);
  check(f.player(0).hand.length === 4, 'Mirage of Nightmare: drew 4');
  zap(f, mn2.uid);
  endTurn(f);
  check(f.player(0).hand.length === 5, 'Mirage of Nightmare: destroyed before your Standby -> nothing is discarded');
}

// ============ Labyrinth of Nightmare ============
{
  const e = duel(['Labyrinth of Nightmare', 'Axe Raider'], ['Vorse Raider', 'Battle Ox']);
  const axe = place(e, 0, 'Axe Raider');
  const v = place(e, 1, 'Vorse Raider');
  const fd = place(e, 1, 'Battle Ox', 'def', false);
  const lb = setCard(e, 0, 'Labyrinth of Nightmare');
  activate(e, 0, lb.uid);
  check(stays(e, lb.uid), 'Labyrinth of Nightmare: activated and stays face-up');
  endTurn(e);
  check(axe.pos === 'def' && v.pos === 'atk', "Labyrinth of Nightmare: your End Phase -> your face-up monsters change position, not the opponent's");
  endTurn(e);
  check(v.pos === 'def' && fd.pos === 'def' && !fd.faceUp && axe.pos === 'def', "Labyrinth of Nightmare: opponent's End Phase -> their face-up monsters change (face-down untouched)");
  endTurn(e);
  check(axe.pos === 'atk', 'Labyrinth of Nightmare: changes back next End Phase');
  mst(e, 'Labyrinth of Nightmare');
  endTurn(e);
  check(v.pos === 'def', 'Labyrinth of Nightmare: nothing once destroyed');
}

// ============ Limit Reverse ============
{
  const e = duel(['Limit Reverse', 'Basic Insect', 'Axe Raider'], ['Vorse Raider']);
  toGy(e, 0, 'Axe Raider');
  const lr = setCard(e, 0, 'Limit Reverse');
  check(!e.canActivateMain(0, lr.uid), 'Limit Reverse: needs a monster with 1000 or less ATK in the GY');
  toGy(e, 0, 'Basic Insect');
  endTurn(e);
  oppSummon(e, 'Vorse Raider', 'Limit Reverse', 'Basic Insect');
  const bi = mon(e, 0, 'Basic Insect');
  check(bi && bi.pos === 'atk' && fc(e, lr.uid)?.tags?.lrTarget === bi.uid, "Limit Reverse: on the opponent's turn, Special Summons it in Attack Position");
  check(stays(e, lr.uid), 'Limit Reverse: stays face-up');
  endTurn(e);
  check(stays(e, lr.uid) && mon(e, 0, 'Basic Insect'), 'Limit Reverse: both stay over turns');
  mst(e, 'Limit Reverse');
  check(!mon(e, 0, 'Basic Insect'), 'Limit Reverse: leaving the field destroys the monster');
}
{
  const e = duel(['Limit Reverse', 'Basic Insect']);
  toGy(e, 0, 'Basic Insect');
  const lr = setCard(e, 0, 'Limit Reverse');
  activate(e, 0, lr.uid, 'Basic Insect');
  zap(e, mon(e, 0, 'Basic Insect')!.uid);
  check(zone(e, lr.uid) === 'gy', 'Limit Reverse: the monster destroyed -> Limit Reverse is destroyed');
  const f = duel(['Limit Reverse', 'Basic Insect']);
  toGy(f, 0, 'Basic Insect');
  const lr2 = setCard(f, 0, 'Limit Reverse');
  activate(f, 0, lr2.uid, 'Basic Insect');
  endTurn(f);
  endTurn(f);
  const bi = mon(f, 0, 'Basic Insect')!;
  f.apply({ type: 'CHANGE_POS', player: 0, uid: bi.uid });
  settle(f);
  check(bi.pos === 'def', 'Limit Reverse: the monster was changed to Defense Position');
  endTurn(f);
  check(zone(f, bi.uid) === 'gy' && zone(f, lr2.uid) === 'gy', 'Limit Reverse: in Defense Position -> it and Limit Reverse are destroyed');
}

// ============ Metal Reflect Slime ============
{
  const e = duel(['Metal Reflect Slime', 'Metal Reflect Slime'], ['Vorse Raider']);
  const s = setCard(e, 0, 'Metal Reflect Slime');
  activate(e, 0, s.uid);
  const m = fc(e, s.uid);
  check(m && zone(e, s.uid) === 'mz' && m.pos === 'def' && m.faceUp, 'Metal Reflect Slime: Special Summoned in Defense Position');
  check(m && e.atkOf(m) === 0 && e.defOf(m) === 3000, 'Metal Reflect Slime: 0 ATK / 3000 DEF');
  endTurn(e);
  endTurn(e);
  m!.pos = 'atk';
  toBattle(e);
  check(!e.canAttackWith(0, m!), 'Metal Reflect Slime: cannot attack');
  // In response to an attack.
  const f = duel(['Metal Reflect Slime'], ['Vorse Raider']);
  const s2 = setCard(f, 0, 'Metal Reflect Slime');
  endTurn(f);
  const v = place(f, 1, 'Vorse Raider');
  attack(f, v.uid, null, 'Metal Reflect Slime');
  check(zone(f, s2.uid) === 'mz', "Metal Reflect Slime: activated on the opponent's attack");
  zap(f, s2.uid);
  check(zone(f, s2.uid) === 'gy', 'Metal Reflect Slime: destroyed like a monster');
}

// ============ Miniaturize ============
{
  const e = duel(['Miniaturize', 'Miniaturize'], ['Vorse Raider', 'Basic Insect']);
  const bi = place(e, 1, 'Basic Insect');
  const mini = setCard(e, 0, 'Miniaturize');
  check(!e.canActivateMain(0, mini.uid), 'Miniaturize: needs a face-up monster with more than 1000 original ATK');
  const v = place(e, 1, 'Vorse Raider');
  activate(e, 0, mini.uid, 'Vorse Raider');
  check(e.atkOf(v) === 900, 'Miniaturize: the target loses 1000 ATK');
  check(stays(e, mini.uid), 'Miniaturize: stays face-up');
  endTurn(e);
  check(e.atkOf(v) === 900, 'Miniaturize: the loss lasts');
  zap(e, mini.uid);
  check(e.atkOf(v) === 1900, 'Miniaturize: ATK back once it is destroyed');
  const mini2 = setCard(e, 0, 'Miniaturize');
  endTurn(e);
  activate(e, 0, mini2.uid, 'Vorse Raider');
  zap(e, v.uid);
  check(zone(e, mini2.uid) === 'gy', 'Miniaturize: the monster leaving the field destroys it');
  void bi;
}

console.log(fails ? `${fails} FAILURES` : 'ALL OK');
process.exit(fails ? 1 : 0);
