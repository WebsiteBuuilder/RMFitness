// Continuous Spells and Traps of The Eternal Duelist Soul, step by step. Each card must
// activate when its text allows, stay face-up on the field, keep doing what it says turn
// after turn, and stop once it leaves the field. Cards that are also Speed Duel cards are
// checked in both games. Run: npx tsx tests/cont-eds.test.ts
import { DB } from './speedkit';
import { Engine } from '../src/eds/engine';
import type { Action, Card, FieldCard, GameMode, Phase, Pid, Pos, Prompt } from '../src/eds/types';

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) failures++;
};

type Handler = (pr: Prompt) => Action | undefined;

/** Handlers that answer a specific prompt; anything else gets the default answer. */
const yesTo = (re: RegExp): Handler => (pr) => (pr.kind === 'yesno' && re.test(pr.title) ? { type: 'YES', player: pr.player } : undefined);
const cancelIn = (re: RegExp): Handler => (pr) => (pr.kind === 'select' && pr.cancel && re.test(pr.title) ? { type: 'CANCEL', player: pr.player } : undefined);
const pickIn = (re: RegExp, label: string): Handler => (pr) => {
  if (pr.kind !== 'select' || !re.test(pr.title)) return undefined;
  const i = pr.options.findIndex((o) => o.label === label);
  return i >= 0 ? { type: 'CHOOSE', player: pr.player, picks: [i] } : undefined;
};
const pickUid = (re: RegExp, uid: number): Handler => (pr) => {
  if (pr.kind !== 'select' || !re.test(pr.title)) return undefined;
  const i = pr.options.findIndex((o) => o.uid === uid);
  return i >= 0 ? { type: 'CHOOSE', player: pr.player, picks: [i] } : undefined;
};
const respondWith = (name: string, player?: Pid): Handler => (pr) => {
  if (pr.kind !== 'response' || (player !== undefined && pr.player !== player)) return undefined;
  const i = pr.options.findIndex((o) => o.label.startsWith(name));
  return i >= 0 ? { type: 'CHOOSE', player: pr.player, picks: [i] } : undefined;
};
const all = (...hs: Handler[]): Handler => (pr) => {
  for (const h of hs) {
    const a = h(pr);
    if (a) return a;
  }
  return undefined;
};

function duel(mode: GameMode, first: Pid = 0) {
  const e = new Engine(DB);
  e.shuffle = <T,>(x: T[]) => x.slice();
  const filler = Array(40).fill('Celtic Guardian');
  e.apply({ type: 'START', first, seed: 11, names: ['A', 'B'], decks: [filler, filler], fusions: [[], []], mode, skills: [null, null] });
  const A = e.player(0);
  const B = e.player(1);
  /** Every prompt answered since the last `mark()`. */
  let seen: Prompt[] = [];
  const mark = () => {
    const out = seen;
    seen = [];
    return out;
  };
  /** Answers every prompt: the handler first, else no to yes/no, pass on responses, the first options on selects. */
  const settle = (h?: Handler) => {
    for (let i = 0; i < 80 && e.state.prompt; i++) {
      const pr = e.state.prompt;
      seen.push(pr);
      const a: Action =
        h?.(pr) ??
        (pr.kind === 'yesno'
          ? { type: 'NO', player: pr.player }
          : pr.kind === 'response'
            ? { type: 'PASS', player: pr.player }
            : { type: 'CHOOSE', player: pr.player, picks: Array.from({ length: Math.max(pr.min, pr.max === 0 ? 0 : 1) }, (_, k) => k) });
      e.apply(a);
    }
  };
  const act = (a: Action, h?: Handler) => (e.apply(a), settle(h));
  const give = (p: Pid, name: string): Card => {
    const c: Card = { uid: e.state.uidCounter++, name, owner: p };
    e.player(p).hand.push(c);
    return c;
  };
  const toGy = (p: Pid, name: string): Card => {
    const c: Card = { uid: e.state.uidCounter++, name, owner: p };
    e.player(p).gy.push(c);
    return c;
  };
  const field = (name: string, p: Pid, pos: Pos, faceUp: boolean): FieldCard => ({ uid: e.state.uidCounter++, name, owner: p, pos, faceUp, placedTurn: e.state.turn - 1, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 });
  /** A monster already on the field since an earlier turn. */
  const put = (p: Pid, name: string, pos: Pos = 'atk', faceUp = true): FieldCard => {
    const fc = field(name, p, pos, faceUp);
    const z = e.player(p).mz.findIndex((x) => x === null);
    e.player(p).mz[z] = fc;
    return fc;
  };
  /** A Spell/Trap Set on an earlier turn (so it can be activated right away). */
  const setST = (p: Pid, name: string): FieldCard => {
    const fc = field(name, p, 'atk', false);
    const z = e.player(p).sz.findIndex((x) => x === null);
    e.player(p).sz[z] = fc;
    return fc;
  };
  const activate = (p: Pid, uid: number, h?: Handler) => act({ type: 'ACTIVATE', player: p, uid, zone: e.player(p).sz.findIndex((z) => z === null) }, h);
  const summon = (p: Pid, uid: number, faceUp = true, h?: Handler, pos: Pos = faceUp ? 'atk' : 'def') => act({ type: 'SUMMON', player: p, uid, zone: e.player(p).mz.findIndex((z) => z === null), pos, faceUp }, h);
  /** Normal Summons a fresh monster from the hand (giving it first). */
  const summonNew = (p: Pid, name: string, h?: Handler, faceUp = true) => {
    const c = give(p, name);
    summon(p, c.uid, faceUp, h);
    return c;
  };
  const toPhase = (ph: Phase, h?: Handler) => {
    const p = e.state.turnPlayer;
    for (let g = 0; g < 8 && e.state.phase !== ph && e.state.turnPlayer === p && e.state.winner === null; g++) act({ type: 'NEXT_PHASE', player: p }, h);
  };
  /** Plays out the current player's turn (the handler also answers the next turn's Standby Phase). */
  const endTurn = (h?: Handler) => {
    const p = e.state.turnPlayer;
    for (let g = 0; g < 12 && e.state.turnPlayer === p && e.state.winner === null; g++) act({ type: 'NEXT_PHASE', player: p }, h);
  };
  const attack = (p: Pid, m: FieldCard, target: FieldCard | null, h?: Handler) => {
    toPhase('BP');
    act({ type: 'ATTACK', player: p, uid: m.uid, target: target?.uid ?? null }, h);
  };
  /** Mystical Space Typhoon from the hand on the given card. */
  const mst = (p: Pid, target: FieldCard) => {
    const c = give(p, 'Mystical Space Typhoon');
    activate(p, c.uid, pickUid(/Destroy which/, target.uid));
  };
  const onField = (uid: number) => !!e.fieldCard(uid);
  const active = (uid: number) => {
    const c = e.fieldCard(uid);
    return !!c && c.faceUp && !!c.active;
  };
  const inGy = (p: Pid, uid: number) => e.player(p).gy.some((c) => c.uid === uid);
  return { e, A, B, mark, settle, act, give, toGy, put, setST, activate, summon, summonNew, toPhase, endTurn, attack, mst, onField, active, inGy };
}

const LP = (mode: GameMode) => (mode === 'speed' ? 4000 : 8000);
const isSpeed = (name: string) => !!DB.get(name)?.speed;
const modesOf = (name: string): GameMode[] => (isSpeed(name) ? ['eds', 'speed'] : ['eds']);

// The card list this file covers, and which game(s) each belongs to.
for (const n of ['Toon World', 'Aqua Chorus', 'DNA Surgery', 'Mirror Wall', 'The Eye of Truth']) check(isSpeed(n), `${n} is a Speed Duel card (tested in both games)`);

// ---------------------------------------------------------------- Chain Energy
for (const mode of modesOf('Chain Energy')) {
  const d = duel(mode);
  const { e, A, B } = d;
  const ce = d.give(0, 'Chain Energy');
  d.activate(0, ce.uid);
  check(d.active(ce.uid), `${mode} Chain Energy: stays face-up on the field after it resolves`);
  check(A.lp === 8000, `${mode} Chain Energy: activating Chain Energy itself costs nothing`);
  d.summonNew(0, 'Celtic Guardian', undefined, false);
  check(A.lp === 7500, `${mode} Chain Energy: Setting a monster costs 500 LP`);
  const pot = d.give(0, 'Pot of Greed');
  d.act({ type: 'SET_ST', player: 0, uid: pot.uid, zone: 1 });
  check(A.lp === 7000, `${mode} Chain Energy: Setting a Spell costs 500 LP`);
  d.activate(0, pot.uid);
  check(A.lp === 7000, `${mode} Chain Energy: activating a Set card (not from the hand) costs nothing`);
  const pot2 = d.give(0, 'Pot of Greed');
  d.activate(0, pot2.uid);
  check(A.lp === 6500, `${mode} Chain Energy: activating a Spell from the hand costs 500 LP`);
  d.endTurn();
  d.summonNew(1, 'Celtic Guardian');
  check(B.lp === 7500, `${mode} Chain Energy: the opponent pays 500 LP to Normal Summon too`);
  const tw = d.give(1, 'Toon World');
  d.activate(1, tw.uid);
  check(B.lp === 6000, `${mode} Chain Energy: activating Toon World from the hand costs its 1000 LP plus 500 LP`);
  const tm = d.give(1, 'Toon Mermaid');
  d.act({ type: 'SPECIAL', player: 1, uid: tm.uid });
  check(d.onField(tm.uid) && B.lp === 5500, `${mode} Chain Energy: Special Summoning from the hand costs 500 LP`);
  B.lp = 500;
  const pot3 = d.give(1, 'Pot of Greed');
  const tm2 = d.give(1, 'Toon Mermaid');
  check(!e.canActivateMain(1, pot3.uid) && !e.canSet(1, pot3) && !e.canSpecialProc(1, tm2), `${mode} Chain Energy: with 500 LP or less a player cannot play cards from the hand`);
  B.lp = 5500;
  d.mst(1, e.fieldCard(ce.uid)!);
  check(d.inGy(0, ce.uid) && B.lp === 5000, `${mode} Chain Energy: Mystical Space Typhoon (500 LP from the hand) destroys it`);
  const pot4 = d.give(1, 'Pot of Greed');
  d.act({ type: 'SET_ST', player: 1, uid: pot4.uid, zone: 2 });
  check(B.lp === 5000, `${mode} Chain Energy: once it is gone, cards from the hand are free again`);
}

// ---------------------------------------------------------------- Gravekeeper's Servant
for (const mode of modesOf("Gravekeeper's Servant")) {
  const d = duel(mode);
  const { e, A, B } = d;
  const gs = d.give(0, "Gravekeeper's Servant");
  d.activate(0, gs.uid);
  check(d.active(gs.uid), `${mode} Gravekeeper's Servant: stays face-up on the field`);
  d.endTurn();
  let gem = d.put(1, 'Gemini Elf');
  d.toPhase('BP');
  let deck = B.deck.length;
  let gy = B.gy.length;
  d.attack(1, gem, null);
  check(B.deck.length === deck - 1 && B.gy.length === gy + 1 && A.lp === 8000 - 1900, `${mode} Gravekeeper's Servant: the opponent sends the top card of their Deck to the GY to attack`);
  d.endTurn();
  const bewd = d.put(0, 'Blue-Eyes White Dragon');
  const myDeck = A.deck.length;
  d.attack(0, bewd, gem);
  check(A.deck.length === myDeck && !d.onField(gem.uid), `${mode} Gravekeeper's Servant: its controller attacks for free`);
  d.endTurn();
  const bewd2 = d.put(1, 'Blue-Eyes White Dragon');
  d.toPhase('BP');
  deck = B.deck.length;
  gy = B.gy.length;
  d.attack(1, bewd2, bewd);
  check(B.deck.length === deck - 1 && B.gy.length === gy + 2, `${mode} Gravekeeper's Servant: the opponent mills again on every attack`);
  const saved = B.deck.splice(0);
  gem = d.put(1, 'Gemini Elf');
  check(!e.canAttackWith(1, gem), `${mode} Gravekeeper's Servant: with an empty Deck the opponent cannot attack`);
  B.deck.push(...saved);
  d.endTurn();
  d.mst(0, e.fieldCard(gs.uid)!);
  check(d.inGy(0, gs.uid), `${mode} Gravekeeper's Servant: destroyed by Mystical Space Typhoon`);
  d.endTurn();
  d.toPhase('BP');
  deck = B.deck.length;
  d.attack(1, gem, null);
  check(B.deck.length === deck && A.lp === 8000 - 1900 - 1900, `${mode} Gravekeeper's Servant: once it is gone attacks cost nothing`);
}

// ---------------------------------------------------------------- Inspection
for (const mode of modesOf('Inspection')) {
  const d = duel(mode);
  const { e, A } = d;
  const ins = d.give(0, 'Inspection');
  d.activate(0, ins.uid);
  check(d.active(ins.uid), `${mode} Inspection: stays face-up on the field`);
  const yes = yesTo(/Inspection/);
  const asked = (ps: Prompt[]) => ps.some((p) => p.kind === 'yesno' && p.player === 0 && /Inspection/.test(p.title));
  const shown = (ps: Prompt[]) => ps.some((p) => p.kind === 'select' && p.player === 0 && /Inspection sees/.test(p.title) && p.options.length === 1);
  d.mark();
  d.endTurn(yes);
  let ps = d.mark();
  check(asked(ps) && shown(ps) && A.lp === 7500, `${mode} Inspection: in the opponent's Standby Phase, pay 500 LP to see a random card in their hand`);
  d.endTurn(yes);
  ps = d.mark();
  check(!asked(ps) && A.lp === 7500, `${mode} Inspection: nothing in your own Standby Phase`);
  d.endTurn();
  ps = d.mark();
  check(asked(ps) && !shown(ps) && A.lp === 7500, `${mode} Inspection: declining pays nothing and shows nothing`);
  d.endTurn();
  d.endTurn(yes);
  ps = d.mark();
  check(asked(ps) && shown(ps) && A.lp === 7000, `${mode} Inspection: offered again every opponent's Standby Phase`);
  d.endTurn();
  d.mst(0, e.fieldCard(ins.uid)!);
  check(d.inGy(0, ins.uid), `${mode} Inspection: destroyed by Mystical Space Typhoon`);
  d.mark();
  d.endTurn(yes);
  ps = d.mark();
  check(!asked(ps) && A.lp === 7000, `${mode} Inspection: once it is gone it is not offered any more`);
}

// ---------------------------------------------------------------- Messenger of Peace
for (const mode of modesOf('Messenger of Peace')) {
  const d = duel(mode);
  const { e, A } = d;
  const mp = d.give(0, 'Messenger of Peace');
  d.activate(0, mp.uid);
  check(d.active(mp.uid), `${mode} Messenger of Peace: stays face-up on the field`);
  const myGem = d.put(0, 'Gemini Elf');
  d.endTurn();
  check(A.lp === 8000, `${mode} Messenger of Peace: no payment in the opponent's Standby Phase`);
  const gem = d.put(1, 'Gemini Elf');
  const celt = d.put(1, 'Celtic Guardian');
  d.toPhase('BP');
  check(!e.canAttackWith(1, gem) && e.canAttackWith(1, celt), `${mode} Messenger of Peace: monsters with 1500+ ATK cannot attack, weaker ones can`);
  d.endTurn();
  check(A.lp === 7900 && d.active(mp.uid), `${mode} Messenger of Peace: its controller pays 100 LP in their Standby Phase`);
  d.toPhase('BP');
  check(!e.canAttackWith(0, myGem), `${mode} Messenger of Peace: the controller's own 1500+ ATK monsters cannot attack either`);
  d.endTurn();
  d.endTurn();
  check(A.lp === 7800, `${mode} Messenger of Peace: pays 100 LP again the next Standby Phase`);
  A.lp = 100;
  d.endTurn();
  d.endTurn();
  check(d.inGy(0, mp.uid) && A.lp === 100, `${mode} Messenger of Peace: destroyed when its controller cannot pay`);
  d.toPhase('BP');
  check(e.canAttackWith(0, myGem), `${mode} Messenger of Peace: once it is gone 1500+ ATK monsters attack again`);
}

// ---------------------------------------------------------------- Prohibition
for (const mode of modesOf('Prohibition')) {
  {
    const d = duel(mode);
    const { e, B } = d;
    const preset = d.setST(1, 'Mystical Space Typhoon');
    d.give(1, 'Mystical Space Typhoon');
    const pro = d.give(0, 'Prohibition');
    d.activate(0, pro.uid, pickIn(/Prohibition: declare/, 'Mystical Space Typhoon'));
    check(d.active(pro.uid), `${mode} Prohibition: stays face-up on the field`);
    d.endTurn();
    const inHand = B.hand.find((c) => c.name === 'Mystical Space Typhoon')!;
    check(!e.canActivateMain(1, inHand.uid) && !e.canSet(1, inHand), `${mode} Prohibition: the declared card cannot be activated or Set from the hand`);
    check(e.canActivateMain(1, preset.uid), `${mode} Prohibition: a copy already Set on the field is not affected`);
    d.activate(1, preset.uid, pickUid(/Destroy which/, pro.uid));
    check(d.inGy(0, pro.uid), `${mode} Prohibition: destroyed by that Set Mystical Space Typhoon`);
    check(!e.prohibited(inHand.name) && e.canSet(1, inHand), `${mode} Prohibition: once it is gone the declared card can be used again`);
  }
  {
    const d = duel(mode);
    const { e } = d;
    const old = d.put(1, 'Gemini Elf');
    d.give(1, 'Gemini Elf');
    const pro = d.give(0, 'Prohibition');
    d.activate(0, pro.uid, pickIn(/Prohibition: declare/, 'Gemini Elf'));
    d.endTurn();
    const g = e.player(1).hand.find((c) => c.name === 'Gemini Elf')!;
    check(!e.canNormalSummon(1, g), `${mode} Prohibition: a declared monster cannot be Normal Summoned`);
    d.toPhase('BP');
    check(e.canAttackWith(1, old), `${mode} Prohibition: the declared monster already on the field still attacks`);
  }
}

// ---------------------------------------------------------------- Toll
for (const mode of modesOf('Toll')) {
  const d = duel(mode);
  const { e, A, B } = d;
  const toll = d.give(0, 'Toll');
  d.activate(0, toll.uid);
  check(d.active(toll.uid), `${mode} Toll: stays face-up on the field`);
  d.endTurn();
  const gem = d.put(1, 'Gemini Elf');
  d.attack(1, gem, null);
  check(B.lp === 7500 && A.lp === 8000 - 1900, `${mode} Toll: the opponent pays 500 LP to attack`);
  d.endTurn();
  const bewd = d.put(0, 'Blue-Eyes White Dragon');
  const before = A.lp;
  d.attack(0, bewd, gem);
  check(A.lp === before - 500, `${mode} Toll: its controller pays 500 LP to attack too`);
  d.endTurn();
  const b2 = d.put(1, 'Blue-Eyes White Dragon');
  d.toPhase('BP');
  B.lp = 500;
  check(!e.canAttackWith(1, b2), `${mode} Toll: a player with 500 LP or less cannot attack`);
  B.lp = 7500;
  d.attack(1, b2, bewd);
  check(B.lp === 7000, `${mode} Toll: paid again on the next attack`);
  d.endTurn();
  d.mst(0, e.fieldCard(toll.uid)!);
  check(d.inGy(0, toll.uid), `${mode} Toll: destroyed by Mystical Space Typhoon`);
  const g2 = d.put(0, 'Gemini Elf');
  const lp = A.lp;
  d.attack(0, g2, null);
  check(A.lp === lp && B.lp === 7000 - 1900, `${mode} Toll: once it is gone attacks are free`);
}

// ---------------------------------------------------------------- Toon World
for (const mode of modesOf('Toon World')) {
  const d = duel(mode);
  const { e, A, B } = d;
  const tm = d.give(0, 'Toon Mermaid');
  check(!e.canSpecialProc(0, tm), `${mode} Toon World: without it a Toon cannot be Summoned`);
  const tw = d.give(0, 'Toon World');
  d.activate(0, tw.uid);
  check(d.active(tw.uid) && A.lp === LP(mode) - 1000, `${mode} Toon World: activated by paying 1000 LP, stays face-up`);
  check(e.canSpecialProc(0, tm), `${mode} Toon World: Toons can now be Summoned`);
  d.act({ type: 'SPECIAL', player: 0, uid: tm.uid });
  check(d.onField(tm.uid), `${mode} Toon World: Toon Mermaid Special Summoned`);
  d.endTurn();
  B.lp = 1000;
  const tw2 = d.give(1, 'Toon World');
  check(!e.canActivateMain(1, tw2.uid), `${mode} Toon World: cannot be activated without more than 1000 LP`);
  B.lp = LP(mode);
  d.mst(1, e.fieldCard(tw.uid)!);
  check(d.inGy(0, tw.uid) && d.inGy(0, tm.uid), `${mode} Toon World: when it is destroyed, the Toons go with it`);
  const tm2 = d.give(0, 'Toon Mermaid');
  check(!e.canSpecialProc(0, tm2), `${mode} Toon World: once it is gone no more Toons`);
}

// ---------------------------------------------------------------- Anti-Spell Fragrance
for (const mode of modesOf('Anti-Spell Fragrance')) {
  const d = duel(mode);
  const { e, A, B } = d;
  const asf = d.setST(0, 'Anti-Spell Fragrance');
  d.endTurn();
  d.summonNew(1, 'Celtic Guardian', respondWith('Anti-Spell Fragrance', 0));
  check(d.active(asf.uid), `${mode} Anti-Spell Fragrance: activated on the opponent's turn, stays face-up`);
  const pot = d.give(1, 'Pot of Greed');
  check(!e.canActivateMain(1, pot.uid), `${mode} Anti-Spell Fragrance: Spells cannot be activated from the hand`);
  d.act({ type: 'SET_ST', player: 1, uid: pot.uid, zone: 0 });
  check(!e.canActivateMain(1, pot.uid), `${mode} Anti-Spell Fragrance: a Spell Set this turn cannot be activated yet`);
  d.endTurn();
  const potA = d.give(0, 'Pot of Greed');
  check(!e.canActivateMain(0, potA.uid), `${mode} Anti-Spell Fragrance: it binds its controller too`);
  const mstA = d.give(0, 'Mystical Space Typhoon');
  d.act({ type: 'SET_ST', player: 0, uid: mstA.uid, zone: 2 });
  d.endTurn();
  const hb = B.hand.length;
  check(e.canActivateMain(1, pot.uid), `${mode} Anti-Spell Fragrance: the Set Spell can be activated on its owner's next turn`);
  d.activate(1, pot.uid);
  check(B.hand.length === hb + 2, `${mode} Anti-Spell Fragrance: and it resolves`);
  d.endTurn();
  d.activate(0, mstA.uid, pickUid(/Destroy which/, asf.uid));
  check(d.inGy(0, asf.uid), `${mode} Anti-Spell Fragrance: destroyed by a Set Mystical Space Typhoon`);
  check(e.canActivateMain(0, potA.uid), `${mode} Anti-Spell Fragrance: once it is gone Spells work from the hand again`);
  void A;
}

// ---------------------------------------------------------------- Appropriate
for (const mode of modesOf('Appropriate')) {
  const d = duel(mode);
  const { e, A, B } = d;
  const ap = d.setST(0, 'Appropriate');
  d.endTurn();
  const offered = (ps: Prompt[]) => ps.some((p) => p.kind === 'response' && p.player === 0 && p.options.some((o) => o.label === 'Appropriate'));
  d.mark();
  const celt = d.give(1, 'Celtic Guardian');
  d.summon(1, celt.uid);
  check(!offered(d.mark()), `${mode} Appropriate: cannot be activated before the opponent draws outside the Draw Phase`);
  const pot = d.give(1, 'Pot of Greed');
  d.activate(1, pot.uid);
  d.mark();
  const ha = A.hand.length;
  d.attack(1, e.fieldCard(celt.uid)!, null, respondWith('Appropriate', 0));
  check(d.active(ap.uid) && A.hand.length === ha, `${mode} Appropriate: activated after the opponent drew with Pot of Greed, stays face-up`);
  d.toPhase('M2');
  const pot2 = d.give(1, 'Pot of Greed');
  const hb = B.hand.length;
  d.activate(1, pot2.uid);
  check(A.hand.length === ha + 2 && B.hand.length === hb - 1 + 2, `${mode} Appropriate: when the opponent draws outside the Draw Phase, its controller draws 2`);
  d.endTurn();
  const ha2 = A.hand.length;
  const potA = d.give(0, 'Pot of Greed');
  d.activate(0, potA.uid);
  check(A.hand.length === ha2 + 2, `${mode} Appropriate: its controller's own draws do not trigger it`);
  d.endTurn();
  const ha3 = A.hand.length;
  d.activate(1, d.give(1, 'Pot of Greed').uid);
  check(A.hand.length === ha3 + 2, `${mode} Appropriate: triggers every time`);
  d.mst(1, e.fieldCard(ap.uid)!);
  check(d.inGy(0, ap.uid), `${mode} Appropriate: destroyed by Mystical Space Typhoon`);
  const ha4 = A.hand.length;
  d.activate(1, d.give(1, 'Pot of Greed').uid);
  check(A.hand.length === ha4, `${mode} Appropriate: once it is gone no more draws`);
}

// ---------------------------------------------------------------- Call of Darkness
for (const mode of modesOf('Call of Darkness')) {
  const d = duel(mode);
  const { e, B } = d;
  const cod = d.setST(0, 'Call of Darkness');
  const dead = d.toGy(1, 'Gemini Elf');
  d.endTurn();
  d.activate(1, d.give(1, 'Monster Reborn').uid, yesTo(/Attack Position/));
  check(d.onField(dead.uid), `${mode} Call of Darkness: (setup) Monster Reborn revives Gemini Elf`);
  const celt = d.summonNew(1, 'Celtic Guardian', respondWith('Call of Darkness', 0));
  check(d.active(cod.uid), `${mode} Call of Darkness: activated on the opponent's turn, stays face-up`);
  check(d.inGy(1, dead.uid) && d.onField(celt.uid), `${mode} Call of Darkness: the monster revived by Monster Reborn goes to the GY, others stay`);
  const mr = d.give(1, 'Monster Reborn');
  check(!e.canActivateMain(1, mr.uid), `${mode} Call of Darkness: Monster Reborn cannot be played while it is on the field`);
  d.endTurn();
  d.mst(0, e.fieldCard(cod.uid)!);
  check(d.inGy(0, cod.uid), `${mode} Call of Darkness: destroyed by Mystical Space Typhoon`);
  d.endTurn();
  check(e.canActivateMain(1, mr.uid), `${mode} Call of Darkness: once it is gone Monster Reborn works again`);
  d.activate(1, mr.uid, yesTo(/Attack Position/));
  check(d.onField(dead.uid) && B.gy.every((c) => c.uid !== dead.uid), `${mode} Call of Darkness: and the revived monster stays`);
}

// ---------------------------------------------------------------- Call of the Haunted
for (const mode of modesOf('Call of the Haunted')) {
  for (const how of ['battle', 'mst'] as const) {
    const d = duel(mode);
    const { e } = d;
    const coth = d.setST(0, 'Call of the Haunted');
    const gem = d.toGy(0, 'Gemini Elf');
    d.endTurn();
    d.summonNew(1, 'Celtic Guardian', respondWith('Call of the Haunted', 0));
    const m = e.fieldCard(gem.uid);
    check(!!m && m.pos === 'atk' && e.controller(gem.uid) === 0, `${mode} Call of the Haunted: activated on the opponent's turn, Special Summons the target in Attack Position`);
    check(d.active(coth.uid), `${mode} Call of the Haunted: stays face-up on the field`);
    if (how === 'battle') {
      const bewd = d.put(1, 'Blue-Eyes White Dragon');
      d.attack(1, bewd, m!);
      check(d.inGy(0, gem.uid) && d.inGy(0, coth.uid), `${mode} Call of the Haunted: when the monster is destroyed, this card is destroyed`);
    } else {
      d.mst(1, e.fieldCard(coth.uid)!);
      check(d.inGy(0, coth.uid) && d.inGy(0, gem.uid), `${mode} Call of the Haunted: when this card leaves the field, the monster is destroyed`);
    }
  }
}

// ---------------------------------------------------------------- Dragon Capture Jar
for (const mode of modesOf('Dragon Capture Jar')) {
  const d = duel(mode);
  const { e } = d;
  const jar = d.setST(0, 'Dragon Capture Jar');
  const myDragon = d.put(0, 'Koumori Dragon');
  d.endTurn();
  const kd = d.put(1, 'Koumori Dragon');
  const gem = d.put(1, 'Gemini Elf');
  d.summonNew(1, 'Celtic Guardian', respondWith('Dragon Capture Jar', 0));
  check(d.active(jar.uid), `${mode} Dragon Capture Jar: activated on the opponent's turn, stays face-up`);
  check(kd.pos === 'def' && myDragon.pos === 'def' && gem.pos === 'atk', `${mode} Dragon Capture Jar: every face-up Dragon goes to Defense Position, others stay`);
  check(!e.canChangePosition(1, kd) && e.canChangePosition(1, gem), `${mode} Dragon Capture Jar: Dragons cannot change their battle position`);
  const back = d.toGy(1, 'Koumori Dragon');
  d.activate(1, d.give(1, 'Monster Reborn').uid, all(pickUid(/Special Summon which/, back.uid), yesTo(/Attack Position/)));
  const nb = e.fieldCard(back.uid);
  check(!!nb && nb.pos === 'def', `${mode} Dragon Capture Jar: a Dragon Summoned later in Attack Position is changed to Defense Position`);
  d.toPhase('BP');
  check(!e.canAttackWith(1, kd) && !e.canAttackWith(1, nb!), `${mode} Dragon Capture Jar: Dragons do not attack`);
  d.endTurn();
  d.mst(0, e.fieldCard(jar.uid)!);
  check(d.inGy(0, jar.uid), `${mode} Dragon Capture Jar: destroyed by Mystical Space Typhoon`);
  d.endTurn();
  check(e.canChangePosition(1, kd), `${mode} Dragon Capture Jar: once it is gone Dragons can change position again`);
}

// ---------------------------------------------------------------- Forced Requisition
for (const mode of modesOf('Forced Requisition')) {
  const d = duel(mode);
  const { e, A, B } = d;
  const fr = d.setST(0, 'Forced Requisition');
  check(!e.canActivateMain(0, fr.uid), `${mode} Forced Requisition: cannot be activated before you discard`);
  d.activate(0, d.give(0, 'Graceful Charity').uid);
  check(e.canActivateMain(0, fr.uid), `${mode} Forced Requisition: can be activated after you discard`);
  d.activate(0, fr.uid);
  check(d.active(fr.uid), `${mode} Forced Requisition: stays face-up on the field`);
  let hb = B.hand.length;
  d.activate(0, d.give(0, 'Graceful Charity').uid);
  check(B.hand.length === hb - 2, `${mode} Forced Requisition: discarding 2 makes the opponent discard 2`);
  while (A.hand.length > 7) A.deck.unshift(A.hand.pop()!);
  while (A.hand.length < 7) d.give(0, "Celtic Guardian");
  hb = B.hand.length;
  d.endTurn();
  check(B.hand.length === hb - 1 + 1, `${mode} Forced Requisition: discarding for the hand limit counts too (opponent discards 1, then draws)`);
  const ha = A.hand.length;
  d.activate(1, d.give(1, 'Graceful Charity').uid);
  check(A.hand.length === ha, `${mode} Forced Requisition: the opponent's own discards do not affect its controller`);
  d.mst(1, e.fieldCard(fr.uid)!);
  check(d.inGy(0, fr.uid), `${mode} Forced Requisition: destroyed by Mystical Space Typhoon`);
  d.endTurn();
  hb = B.hand.length;
  d.activate(0, d.give(0, 'Graceful Charity').uid);
  check(B.hand.length === hb, `${mode} Forced Requisition: once it is gone the opponent keeps their hand`);
}

// ---------------------------------------------------------------- Goblin Fan
for (const mode of modesOf('Goblin Fan')) {
  const d = duel(mode);
  const { e } = d;
  const fan = d.setST(0, 'Goblin Fan');
  const mine = d.put(0, 'Celtic Guardian');
  const bug = d.put(1, 'Man-Eater Bug', 'def', false);
  const celt = d.put(1, 'Celtic Guardian', 'def', false);
  d.endTurn();
  d.summonNew(1, 'Celtic Guardian', respondWith('Goblin Fan', 0));
  check(d.active(fan.uid), `${mode} Goblin Fan: activated on the opponent's turn, stays face-up`);
  d.act({ type: 'FLIP_SUMMON', player: 1, uid: bug.uid });
  check(d.inGy(1, bug.uid) && d.onField(mine.uid), `${mode} Goblin Fan: a Flip Summoned Level 2 monster is destroyed and its FLIP effect does not activate`);
  d.act({ type: 'FLIP_SUMMON', player: 1, uid: celt.uid });
  check(d.onField(celt.uid) && e.fieldCard(celt.uid)!.faceUp, `${mode} Goblin Fan: Level 3+ monsters are Flip Summoned normally`);
  d.endTurn();
  d.mst(0, e.fieldCard(fan.uid)!);
  check(d.inGy(0, fan.uid), `${mode} Goblin Fan: destroyed by Mystical Space Typhoon`);
  d.endTurn();
  const bug2 = d.put(1, 'Man-Eater Bug', 'def', false);
  const before = e.monsters(0).length + e.monsters(1).length;
  d.act({ type: 'FLIP_SUMMON', player: 1, uid: bug2.uid });
  check(d.onField(bug2.uid) && e.monsters(0).length + e.monsters(1).length === before - 1, `${mode} Goblin Fan: once it is gone Man-Eater Bug flips and destroys a monster`);
}

// ---------------------------------------------------------------- Imperial Order
for (const mode of modesOf('Imperial Order')) {
  const d = duel(mode);
  const { e, A } = d;
  const mp = d.give(0, 'Messenger of Peace');
  d.activate(0, mp.uid);
  const toll = d.give(0, 'Toll');
  d.activate(0, toll.uid);
  const io = d.setST(0, 'Imperial Order');
  d.endTurn();
  const gem = d.put(1, 'Gemini Elf');
  d.summonNew(1, 'Celtic Guardian', respondWith('Imperial Order', 0));
  check(d.active(io.uid), `${mode} Imperial Order: activated on the opponent's turn, stays face-up`);
  d.toPhase('BP');
  check(e.canAttackWith(1, gem), `${mode} Imperial Order: Messenger of Peace's effect is negated`);
  d.attack(1, gem, null);
  check(e.player(1).lp === 8000 && A.lp === 8000 - 1900, `${mode} Imperial Order: Toll's effect is negated (the attack costs nothing)`);
  d.endTurn();
  check(A.lp === 8000 - 1900 - 700 && d.active(io.uid), `${mode} Imperial Order: 700 LP in its controller's Standby Phase (and no 100 LP for the negated Messenger)`);
  d.endTurn();
  check(A.lp === 8000 - 1900 - 1400, `${mode} Imperial Order: 700 LP again in the opponent's Standby Phase`);
  A.lp = 700;
  d.endTurn();
  check(d.inGy(0, io.uid) && A.lp === 700, `${mode} Imperial Order: destroyed when its controller cannot pay`);
  d.endTurn();
  d.toPhase('BP');
  check(!e.canAttackWith(1, gem), `${mode} Imperial Order: once it is gone Spells work again (Messenger of Peace stops Gemini Elf)`);
}

// ---------------------------------------------------------------- Light of Intervention
for (const mode of modesOf('Light of Intervention')) {
  const d = duel(mode);
  const { e } = d;
  const loi = d.setST(0, 'Light of Intervention');
  d.activate(0, loi.uid);
  check(d.active(loi.uid), `${mode} Light of Intervention: stays face-up on the field`);
  const a = d.summonNew(0, 'Celtic Guardian', undefined, false);
  let m = e.fieldCard(a.uid)!;
  check(m.faceUp && m.pos === 'def', `${mode} Light of Intervention: a Set monster is Summoned in face-up Defense Position instead`);
  d.endTurn();
  const b = d.summonNew(1, 'Celtic Guardian', undefined, false);
  m = e.fieldCard(b.uid)!;
  check(m.faceUp && m.pos === 'def', `${mode} Light of Intervention: the opponent cannot Set monsters either`);
  d.endTurn();
  d.mst(0, e.fieldCard(loi.uid)!);
  check(d.inGy(0, loi.uid), `${mode} Light of Intervention: destroyed by Mystical Space Typhoon`);
  const c = d.summonNew(0, 'Celtic Guardian', undefined, false);
  check(!e.fieldCard(c.uid)!.faceUp, `${mode} Light of Intervention: once it is gone monsters can be Set again`);
}

// ---------------------------------------------------------------- Magical Thorn
for (const mode of modesOf('Magical Thorn')) {
  const d = duel(mode);
  const { e, A, B } = d;
  const mt = d.setST(0, 'Magical Thorn');
  d.endTurn();
  d.summonNew(1, 'Celtic Guardian', respondWith('Magical Thorn', 0));
  check(d.active(mt.uid), `${mode} Magical Thorn: activated on the opponent's turn, stays face-up`);
  d.activate(1, d.give(1, 'Graceful Charity').uid);
  check(B.lp === 7000, `${mode} Magical Thorn: 500 damage for each card the opponent discards (Graceful Charity: 2)`);
  while (B.hand.length > 7) B.deck.unshift(B.hand.pop()!);
  while (B.hand.length < 7) d.give(1, "Celtic Guardian");
  d.endTurn();
  check(B.lp === 6500, `${mode} Magical Thorn: discarding for the hand limit counts too`);
  d.activate(0, d.give(0, 'Graceful Charity').uid);
  check(A.lp === 8000, `${mode} Magical Thorn: its controller's own discards do not hurt them`);
  d.mst(0, e.fieldCard(mt.uid)!);
  check(d.inGy(0, mt.uid), `${mode} Magical Thorn: destroyed by Mystical Space Typhoon`);
  d.endTurn();
  d.activate(1, d.give(1, 'Graceful Charity').uid);
  check(B.lp === 6500, `${mode} Magical Thorn: once it is gone discards are free`);
}

// ---------------------------------------------------------------- Respect Play
for (const mode of modesOf('Respect Play')) {
  const d = duel(mode);
  const { e } = d;
  const rp = d.setST(0, 'Respect Play');
  check(!e.handRevealed(0) && !e.handRevealed(1), `${mode} Respect Play: hands are hidden before it is active`);
  d.endTurn();
  d.summonNew(1, 'Celtic Guardian', respondWith('Respect Play', 0));
  check(d.active(rp.uid), `${mode} Respect Play: activated on the opponent's turn, stays face-up`);
  check(e.handRevealed(1) && !e.handRevealed(0), `${mode} Respect Play: the turn player shows their hand`);
  d.endTurn();
  check(e.handRevealed(0) && !e.handRevealed(1), `${mode} Respect Play: on the next turn the other player shows theirs`);
  d.mst(0, e.fieldCard(rp.uid)!);
  check(d.inGy(0, rp.uid) && !e.handRevealed(0), `${mode} Respect Play: once it is destroyed hands are hidden again`);
}

// ---------------------------------------------------------------- Robbin' Goblin
for (const mode of modesOf("Robbin' Goblin")) {
  const d = duel(mode);
  const { e, B } = d;
  const rg = d.setST(0, "Robbin' Goblin");
  d.activate(0, rg.uid);
  check(d.active(rg.uid), `${mode} Robbin' Goblin: stays face-up on the field`);
  d.endTurn();
  d.endTurn();
  const gem = d.put(0, 'Gemini Elf');
  const celt = d.put(0, 'Celtic Guardian');
  let hb = B.hand.length;
  let gy = B.gy.length;
  d.attack(0, gem, null);
  check(B.hand.length === hb - 1 && B.gy.length === gy + 1, `${mode} Robbin' Goblin: battle damage makes the opponent discard 1 card`);
  const wall = d.put(1, 'Giant Soldier of Stone', 'def');
  hb = B.hand.length;
  d.attack(0, celt, wall);
  check(B.hand.length === hb, `${mode} Robbin' Goblin: no battle damage, no discard`);
  d.endTurn();
  d.endTurn();
  e.player(1).mz = e.player(1).mz.map(() => null);
  hb = B.hand.length;
  d.attack(0, gem, null);
  check(B.hand.length === hb - 1, `${mode} Robbin' Goblin: triggers again on the next turn`);
  d.toPhase('M2');
  d.mst(0, e.fieldCard(rg.uid)!);
  check(d.inGy(0, rg.uid), `${mode} Robbin' Goblin: destroyed by Mystical Space Typhoon`);
  d.endTurn();
  d.endTurn();
  hb = B.hand.length;
  gy = B.gy.length;
  d.attack(0, gem, null);
  check(B.hand.length === hb, `${mode} Robbin' Goblin: once it is gone battle damage takes no cards`);
}

// ---------------------------------------------------------------- Royal Decree
for (const mode of modesOf('Royal Decree')) {
  const d = duel(mode);
  const { e } = d;
  const loi = d.setST(0, 'Light of Intervention');
  d.activate(0, loi.uid);
  const rd = d.setST(0, 'Royal Decree');
  d.activate(0, rd.uid);
  check(d.active(rd.uid), `${mode} Royal Decree: stays face-up on the field`);
  const a = d.summonNew(0, 'Celtic Guardian', undefined, false);
  check(!e.fieldCard(a.uid)!.faceUp, `${mode} Royal Decree: negates Light of Intervention (a monster can be Set)`);
  d.endTurn();
  const b = d.summonNew(1, 'Celtic Guardian', undefined, false);
  check(!e.fieldCard(b.uid)!.faceUp, `${mode} Royal Decree: negates other Traps for the opponent too`);
  d.mst(1, e.fieldCard(rd.uid)!);
  check(d.inGy(0, rd.uid), `${mode} Royal Decree: destroyed by Mystical Space Typhoon`);
  d.endTurn();
  const c = d.summonNew(0, 'Celtic Guardian', undefined, false);
  check(e.fieldCard(c.uid)!.faceUp, `${mode} Royal Decree: once it is gone Light of Intervention works again`);
}

// Royal Decree also negates Imperial Order (Spells work again) and Continuous Trap auras.
for (const mode of modesOf('Royal Decree')) {
  const d = duel(mode);
  const { e } = d;
  d.activate(0, d.give(0, 'Messenger of Peace').uid);
  const io = d.setST(0, 'Imperial Order');
  d.activate(0, io.uid);
  const ac = d.setST(0, 'Aqua Chorus');
  d.activate(0, ac.uid);
  const c1 = d.put(0, 'Celtic Guardian');
  d.put(0, 'Celtic Guardian');
  const rd = d.setST(0, 'Royal Decree');
  check(e.atkOf(c1) === 1900, `${mode} Royal Decree: (setup) Aqua Chorus works`);
  d.activate(0, rd.uid);
  check(e.atkOf(c1) === 1400, `${mode} Royal Decree: negates Aqua Chorus`);
  d.endTurn();
  const gem = d.put(1, 'Gemini Elf');
  d.toPhase('BP');
  check(!e.canAttackWith(1, gem) && d.active(io.uid), `${mode} Royal Decree: negates Imperial Order, so Messenger of Peace works`);
}

// ---------------------------------------------------------------- Spellbinding Circle
for (const mode of modesOf('Spellbinding Circle')) {
  for (const how of ['mst', 'battle'] as const) {
    const d = duel(mode);
    const { e, A } = d;
    const sc = d.setST(0, 'Spellbinding Circle');
    const gem = d.put(1, 'Gemini Elf');
    d.endTurn();
    d.attack(1, gem, null, respondWith('Spellbinding Circle', 0));
    check(d.active(sc.uid), `${mode} Spellbinding Circle: activated when the opponent attacks, stays face-up`);
    check(A.lp === 8000, `${mode} Spellbinding Circle: the bound monster's attack is stopped`);
    d.endTurn();
    if (how === 'battle') {
      const bewd = d.put(0, 'Blue-Eyes White Dragon');
      d.attack(0, bewd, gem);
      check(d.inGy(1, gem.uid) && d.inGy(0, sc.uid), `${mode} Spellbinding Circle: when the monster is destroyed, this card is destroyed`);
      continue;
    }
    d.endTurn();
    check(!e.canChangePosition(1, gem), `${mode} Spellbinding Circle: the monster cannot change its battle position`);
    d.toPhase('BP');
    check(!e.canAttackWith(1, gem), `${mode} Spellbinding Circle: the monster still cannot attack on later turns`);
    d.endTurn();
    d.mst(0, e.fieldCard(sc.uid)!);
    check(d.inGy(0, sc.uid), `${mode} Spellbinding Circle: destroyed by Mystical Space Typhoon`);
    d.endTurn();
    check(e.canChangePosition(1, gem), `${mode} Spellbinding Circle: once it is gone the monster can change position`);
    d.toPhase('BP');
    check(e.canAttackWith(1, gem), `${mode} Spellbinding Circle: once it is gone the monster can attack`);
  }
}

// ---------------------------------------------------------------- The Regulation of Tribe
for (const mode of modesOf('The Regulation of Tribe')) {
  const d = duel(mode);
  const { e, A } = d;
  const rt = d.setST(0, 'The Regulation of Tribe');
  d.put(0, 'Celtic Guardian');
  d.put(0, 'Celtic Guardian');
  const myElf = d.put(0, 'Mystical Elf');
  d.endTurn();
  const gem = d.put(1, 'Gemini Elf');
  const celt = d.put(1, 'Celtic Guardian');
  d.summonNew(1, 'Celtic Guardian', all(respondWith('The Regulation of Tribe', 0), pickIn(/declare a Type/, 'Spellcaster')));
  check(d.active(rt.uid), `${mode} The Regulation of Tribe: activated on the opponent's turn, stays face-up`);
  d.toPhase('BP');
  check(!e.canAttackWith(1, gem) && e.canAttackWith(1, celt), `${mode} The Regulation of Tribe: monsters of the declared Type cannot attack, others can`);
  const n = e.monsters(0).length;
  d.endTurn();
  check(e.monsters(0).length === n - 1 && d.active(rt.uid), `${mode} The Regulation of Tribe: its controller Tributes a monster in their Standby Phase to keep it`);
  d.toPhase('BP');
  check(!e.canAttackWith(0, myElf), `${mode} The Regulation of Tribe: its controller's monsters of that Type cannot attack either`);
  d.endTurn();
  check(e.monsters(0).length === n - 1, `${mode} The Regulation of Tribe: no Tribute in the opponent's Standby Phase`);
  d.endTurn(cancelIn(/Regulation of Tribe/));
  check(d.inGy(0, rt.uid) && e.monsters(0).length === n - 1, `${mode} The Regulation of Tribe: destroyed when its controller does not Tribute`);
  d.endTurn();
  d.toPhase('BP');
  check(e.canAttackWith(1, gem), `${mode} The Regulation of Tribe: once it is gone the declared Type attacks again`);
  void A;
}

// ---------------------------------------------------------------- Ultimate Offering
for (const mode of modesOf('Ultimate Offering')) {
  const d = duel(mode);
  const { e, A } = d;
  const uo = d.setST(0, 'Ultimate Offering');
  d.activate(0, uo.uid);
  check(d.active(uo.uid), `${mode} Ultimate Offering: stays face-up on the field`);
  d.summonNew(0, 'Celtic Guardian');
  const g = d.give(0, 'Gemini Elf');
  check(e.canUseMonsterEffect(0, e.fieldCard(uo.uid)!), `${mode} Ultimate Offering: usable in its controller's Main Phase after the Normal Summon`);
  d.act({ type: 'MONSTER_EFFECT', player: 0, uid: uo.uid }, all(pickUid(/Ultimate Offering: Normal Summon/, g.uid), pickIn(/how\?/, 'Attack Position')));
  check(A.lp === 7500 && e.fieldCard(g.uid)?.faceUp === true && e.fieldCard(g.uid)?.pos === 'atk', `${mode} Ultimate Offering: pay 500 LP, Normal Summon another monster right away`);
  const s = d.give(0, 'Mystical Elf');
  d.act({ type: 'MONSTER_EFFECT', player: 0, uid: uo.uid }, all(pickUid(/Ultimate Offering: Normal Summon/, s.uid), pickIn(/how\?/, 'Set')));
  check(A.lp === 7000 && e.fieldCard(s.uid)?.faceUp === false, `${mode} Ultimate Offering: again, this time Setting a monster`);
  d.endTurn();
  const k = d.give(0, 'Koumori Dragon');
  const bewd = d.put(1, 'Blue-Eyes White Dragon');
  d.attack(1, bewd, e.fieldCard(g.uid)!, all(respondWith('Ultimate Offering', 0), pickUid(/Ultimate Offering: Normal Summon/, k.uid), pickIn(/how\?/, 'Set')));
  check(A.lp === 7000 - 500 - 1100 && e.fieldCard(k.uid)?.faceUp === false, `${mode} Ultimate Offering: usable in the opponent's Battle Phase to Set a monster`);
  d.endTurn();
  d.mst(0, e.fieldCard(uo.uid)!);
  check(d.inGy(0, uo.uid), `${mode} Ultimate Offering: destroyed by Mystical Space Typhoon`);
  d.endTurn();
  d.give(0, 'Celtic Guardian');
  const b2 = d.put(1, 'Blue-Eyes White Dragon');
  d.mark();
  d.attack(1, b2, null);
  check(!d.mark().some((p) => p.kind === 'response' && p.options.some((o) => o.label.startsWith('Ultimate Offering'))), `${mode} Ultimate Offering: once it is gone it is not offered any more`);
}

// ---------------------------------------------------------------- Aqua Chorus
for (const mode of modesOf('Aqua Chorus')) {
  const d = duel(mode);
  const { e } = d;
  const ac = d.setST(0, 'Aqua Chorus');
  const c1 = d.put(0, 'Celtic Guardian');
  const gem = d.put(0, 'Gemini Elf');
  d.endTurn();
  const c2 = d.summonNew(1, 'Celtic Guardian', respondWith('Aqua Chorus', 0));
  const m2 = e.fieldCard(c2.uid)!;
  check(d.active(ac.uid), `${mode} Aqua Chorus: activated on the opponent's turn, stays face-up`);
  check(e.atkOf(c1) === 1900 && e.defOf(c1) === 1700 && e.atkOf(m2) === 1900 && e.defOf(m2) === 1700, `${mode} Aqua Chorus: monsters sharing a name on the field gain 500 ATK/DEF (both sides)`);
  check(e.atkOf(gem) === 1900 && e.defOf(gem) === 900, `${mode} Aqua Chorus: a monster with no namesake gets nothing`);
  const g2 = d.put(1, 'Gemini Elf');
  check(e.atkOf(gem) === 2400 && e.atkOf(g2) === 2400, `${mode} Aqua Chorus: a namesake arriving later turns the bonus on`);
  d.endTurn();
  d.mst(0, e.fieldCard(ac.uid)!);
  check(d.inGy(0, ac.uid) && e.atkOf(c1) === 1400 && e.atkOf(gem) === 1900, `${mode} Aqua Chorus: once it is destroyed the bonus is gone`);
}

// ---------------------------------------------------------------- DNA Surgery
for (const mode of modesOf('DNA Surgery')) {
  const d = duel(mode);
  const { e } = d;
  const dna = d.setST(0, 'DNA Surgery');
  const c1 = d.put(0, 'Celtic Guardian');
  d.endTurn();
  const g = d.summonNew(1, 'Gemini Elf', all(respondWith('DNA Surgery', 0), pickIn(/declare a Type/, 'Dragon')));
  check(d.active(dna.uid), `${mode} DNA Surgery: activated on the opponent's turn, stays face-up`);
  check(e.raceOf(c1) === 'Dragon' && e.raceOf(e.fieldCard(g.uid)!) === 'Dragon', `${mode} DNA Surgery: every face-up monster becomes the declared Type`);
  d.endTurn();
  const c3 = d.summonNew(0, 'Celtic Guardian');
  check(e.raceOf(e.fieldCard(c3.uid)!) === 'Dragon', `${mode} DNA Surgery: monsters Summoned later become that Type too`);
  d.mst(0, e.fieldCard(dna.uid)!);
  check(d.inGy(0, dna.uid) && e.raceOf(c1) === 'Warrior' && e.raceOf(e.fieldCard(g.uid)!) === 'Spellcaster', `${mode} DNA Surgery: once it is destroyed monsters have their own Type again`);
}

// ---------------------------------------------------------------- Mirror Wall
for (const mode of modesOf('Mirror Wall')) {
  const d = duel(mode);
  const { e, A, B } = d;
  const mw = d.setST(0, 'Mirror Wall');
  const wall = d.put(0, 'Giant Soldier of Stone', 'def');
  d.endTurn();
  const gem = d.put(1, 'Gemini Elf');
  const celt = d.put(1, 'Celtic Guardian');
  d.attack(1, gem, wall, respondWith('Mirror Wall', 0));
  check(d.active(mw.uid), `${mode} Mirror Wall: activated when the opponent attacks, stays face-up`);
  check(e.atkOf(gem) === 950 && B.lp === LP(mode) - 1050, `${mode} Mirror Wall: the attacking monster's ATK is halved for that battle`);
  check(e.atkOf(celt) === 1400, `${mode} Mirror Wall: monsters that have not attacked keep their ATK`);
  d.endTurn(yesTo(/Mirror Wall/));
  check(A.lp === LP(mode) - 2000 && d.active(mw.uid), `${mode} Mirror Wall: its controller pays 2000 LP in their Standby Phase to keep it`);
  d.endTurn();
  check(A.lp === LP(mode) - 2000 && e.atkOf(gem) === 950, `${mode} Mirror Wall: no payment in the opponent's Standby Phase, and the ATK stays halved`);
  d.attack(1, celt, wall);
  check(e.atkOf(celt) === 700, `${mode} Mirror Wall: every opponent's monster that attacks is halved`);
  d.endTurn();
  check(d.inGy(0, mw.uid), `${mode} Mirror Wall: destroyed when its controller does not pay`);
  check(e.atkOf(gem) === 1900 && e.atkOf(celt) === 1400, `${mode} Mirror Wall: once it is gone ATK is back to normal`);
}

// ---------------------------------------------------------------- The Eye of Truth
for (const mode of modesOf('The Eye of Truth')) {
  const d = duel(mode);
  const { e, B } = d;
  const eye = d.setST(0, 'The Eye of Truth');
  d.endTurn();
  d.summonNew(1, 'Celtic Guardian', respondWith('The Eye of Truth', 0));
  check(d.active(eye.uid), `${mode} The Eye of Truth: activated on the opponent's turn, stays face-up`);
  check(e.handRevealed(1) && !e.handRevealed(0), `${mode} The Eye of Truth: the opponent's hand is revealed, not its controller's`);
  d.endTurn();
  check(e.handRevealed(1), `${mode} The Eye of Truth: still revealed on its controller's turn`);
  let lp = B.lp;
  d.endTurn();
  check(B.lp === lp, `${mode} The Eye of Truth: no Spell in the opponent's hand, no LP`);
  d.give(1, 'Pot of Greed');
  d.endTurn();
  lp = B.lp;
  d.endTurn();
  check(B.lp === lp + 1000, `${mode} The Eye of Truth: with a Spell in hand the opponent gains 1000 LP in their Standby Phase`);
  lp = B.lp;
  d.endTurn();
  check(B.lp === lp, `${mode} The Eye of Truth: nothing in its controller's Standby Phase`);
  d.mst(0, e.fieldCard(eye.uid)!);
  check(d.inGy(0, eye.uid) && !e.handRevealed(1), `${mode} The Eye of Truth: once it is destroyed the hand is hidden again`);
  lp = B.lp;
  d.endTurn();
  check(B.lp === lp, `${mode} The Eye of Truth: and no more LP`);
}

console.log(failures ? `${failures} FAILURES` : 'ALL OK');
if (failures) process.exit(1);
