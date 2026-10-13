// Speed Duel Continuous Spells/Traps (batch C), card by card: each one is activated when its
// text allows, stays face-up on the field, does what it says (every time it says), stops once
// it leaves the field, and destroys itself when its text says so.
// Run: npx tsx tests/cont-c.test.ts
import { DB } from './speedkit';
import { Engine } from '../src/eds/engine';
import type { Action, Card, FieldCard, Phase, Pid, Pos, Prompt } from '../src/eds/types';
import { attrOf, levelOf } from '../src/eds/speed/helpers';

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) failures++;
};

const FILL = 'Gemini Elf';
type Handler = (pr: Prompt) => Action | undefined;

/** A Speed Duel with filler decks; cards are put where a test needs them. Player 0 is at Main Phase 1 of turn 1 (Battle Phase allowed). */
function duel() {
  const e = new Engine(DB);
  const handlers: Handler[] = [];
  /** Every response option offered, as "player|label". */
  const offered: string[] = [];
  /** Every select prompt shown, as "player|title|labels". */
  const shown: string[] = [];
  const prefer = new Set<number>();
  const settle = () => {
    for (let i = 0; i < 80 && e.state.prompt; i++) {
      const pr = e.state.prompt;
      if (pr.kind === 'response') for (const o of pr.options) offered.push(`${pr.player}|${o.label}`);
      if (pr.kind === 'select') shown.push(`${pr.player}|${pr.title}|${pr.options.map((o) => o.label).join(',')}`);
      let a: Action | undefined;
      for (const h of handlers) if ((a = h(pr))) break;
      if (!a && pr.kind === 'select') {
        const k = pr.options.findIndex((o) => o.uid !== undefined && prefer.has(o.uid));
        if (k >= 0) a = { type: 'CHOOSE', player: pr.player, picks: [k] };
      }
      a ??= pr.kind === 'yesno' ? { type: 'NO', player: pr.player } : pr.kind === 'response' ? { type: 'PASS', player: pr.player } : { type: 'CHOOSE', player: pr.player, picks: Array.from({ length: Math.max(1, pr.min) }, (_, k) => k) };
      e.apply(a);
    }
  };
  e.apply({ type: 'START', first: 0, seed: 11, names: ['A', 'B'], decks: [Array(40).fill(FILL), Array(40).fill(FILL)], fusions: [[], []], mode: 'speed', skills: [null, null] });
  settle();
  e.state.firstTurn = false;
  const A = e.player(0);
  const B = e.player(1);
  // Empty hands: tests hand out exactly what they need.
  for (const p of [A, B]) p.hand.length = 0;
  const newCard = (name: string, p: Pid): Card => ({ uid: e.state.uidCounter++, name, owner: p });
  const fieldOf = (c: Card, pos: Pos, faceUp: boolean): FieldCard => ({ ...c, pos, faceUp, placedTurn: e.state.turn - 1, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 });
  const t = {
    e,
    A,
    B,
    offered,
    shown,
    prefer,
    handlers,
    settle,
    step(a: Action) {
      e.apply(a);
      settle();
    },
    hand(p: Pid, name: string) {
      const c = newCard(name, p);
      e.player(p).hand.push(c);
      return c;
    },
    deck(p: Pid, name: string) {
      const c = newCard(name, p);
      e.player(p).deck.unshift(c);
      return c;
    },
    gy(p: Pid, name: string) {
      const c = newCard(name, p);
      e.player(p).gy.push(c);
      return c;
    },
    /** A monster already on the field since last turn. */
    mon(p: Pid, name: string, pos: Pos = 'atk', faceUp = true) {
      const ps = e.player(p);
      const z = ps.mz.findIndex((x) => x === null);
      if (z < 0) throw new Error('no monster zone');
      return (ps.mz[z] = fieldOf(newCard(name, p), pos, faceUp));
    },
    /** A Spell/Trap Set since last turn. */
    set(p: Pid, name: string) {
      const ps = e.player(p);
      const z = ps.sz.findIndex((x) => x === null);
      if (z < 0) throw new Error('no S/T zone');
      return (ps.sz[z] = fieldOf(newCard(name, p), 'atk', false));
    },
    /** A face-up Spell/Trap already in effect. */
    active(p: Pid, name: string) {
      const fc = t.set(p, name);
      fc.faceUp = true;
      fc.active = true;
      return fc;
    },
    /** Activates a Spell from the hand (or a Set card) in the Main Phase. */
    activate(p: Pid, uid: number) {
      t.step({ type: 'ACTIVATE', player: p, uid });
    },
    effect(p: Pid, uid: number) {
      t.step({ type: 'MONSTER_EFFECT', player: p, uid });
    },
    attack(p: Pid, uid: number, target: number | null) {
      t.step({ type: 'ATTACK', player: p, uid, target });
    },
    toPhase(ph: Phase) {
      const p = e.state.turnPlayer;
      for (let g = 0; g < 8 && e.state.phase !== ph && e.state.turnPlayer === p && e.state.winner === null; g++) t.step({ type: 'NEXT_PHASE', player: p });
    },
    /** Plays out the current turn; the next player is left at Main Phase 1. */
    endTurn() {
      const p = e.state.turnPlayer;
      for (let g = 0; g < 12 && e.state.turnPlayer === p && e.state.winner === null; g++) t.step({ type: 'NEXT_PHASE', player: p });
    },
    /** Destroys a card with a card effect controlled by `by` (the engine's destroy helper). */
    destroy(uid: number, by: Pid) {
      const g = e.as(by, e.destroy([uid]));
      for (let r = g.next(undefined as never); !r.done; r = g.next(false)) {
        /* no prompts expected */
      }
    },
    /** Player `by` destroys a Spell/Trap with Mystical Space Typhoon from the hand (on their turn). */
    mst(by: Pid, uid: number) {
      const c = t.hand(by, 'Mystical Space Typhoon');
      prefer.add(uid);
      t.activate(by, c.uid);
      prefer.delete(uid);
    },
    onField: (uid: number) => !!e.fieldCard(uid),
    faceUpActive: (uid: number) => !!e.fieldCard(uid)?.faceUp && !!e.fieldCard(uid)?.active,
    inGy: (p: Pid, uid: number) => e.player(p).gy.some((c) => c.uid === uid),
    /** Answer YES to yes/no prompts whose title contains `s`. */
    yes(s: string, player?: Pid) {
      handlers.push((pr) => (pr.kind === 'yesno' && pr.title.includes(s) && (player === undefined || pr.player === player) ? { type: 'YES', player: pr.player } : undefined));
    },
    /** Use a response option whose label contains `s` (for player `p`). */
    respond(p: Pid, s: string) {
      handlers.push((pr) => {
        if (pr.kind !== 'response' || pr.player !== p) return undefined;
        const k = pr.options.findIndex((o) => o.label.includes(s));
        return k >= 0 ? { type: 'CHOOSE', player: p, picks: [k] } : undefined;
      });
    },
    /** In a select whose title contains `title`, pick the options whose labels contain `labels` (in order). */
    choose(title: string, ...labels: string[]) {
      handlers.push((pr) => {
        if (pr.kind !== 'select' || !pr.title.includes(title)) return undefined;
        const picks = labels.map((l) => pr.options.findIndex((o) => o.label.includes(l))).filter((k) => k >= 0);
        return picks.length ? { type: 'CHOOSE', player: pr.player, picks } : undefined;
      });
    },
    clear() {
      handlers.length = 0;
      offered.length = 0;
      shown.length = 0;
    },
    wasOffered: (p: Pid, s: string) => offered.some((o) => o.startsWith(`${p}|`) && o.includes(s)),
  };
  return t;
}

// ---------- Mokey Mokey Smackdown ----------
{
  const t = duel();
  const { e, A } = t;
  const sd = t.hand(0, 'Mokey Mokey Smackdown');
  const mk1 = t.mon(0, 'Mokey Mokey');
  const mk2 = t.mon(0, 'Mokey Mokey');
  const elf = t.mon(1, 'Gemini Elf');
  t.activate(0, sd.uid);
  check(t.faceUpActive(sd.uid), 'Mokey Mokey Smackdown: activates from the hand and stays face-up');
  t.respond(0, 'Mokey Mokey Smackdown');
  t.toPhase('BP');
  t.attack(0, mk1.uid, elf.uid);
  check(t.inGy(0, mk1.uid) && e.atkOf(mk2) === 3000, 'Mokey Mokey Smackdown: a Fairy destroyed by battle makes Mokey Mokey 3000 ATK');
  t.attack(0, mk2.uid, elf.uid);
  check(t.inGy(1, elf.uid), 'Mokey Mokey Smackdown: the 3000 ATK Mokey Mokey wins its battle');
  t.endTurn();
  check(e.atkOf(mk2) === 300, 'Mokey Mokey Smackdown: the ATK change ends with the turn');
  t.endTurn();
  // Each time: a second Fairy goes down on a later turn.
  const fairy = t.mon(0, 'Shining Abyss');
  const elf2 = t.mon(1, 'Gemini Elf');
  t.toPhase('BP');
  t.attack(0, fairy.uid, elf2.uid);
  check(t.inGy(0, fairy.uid) && e.atkOf(mk2) === 3000, 'Mokey Mokey Smackdown: triggers again on a later turn');
  // A non-Fairy destroyed: nothing.
  t.endTurn();
  t.endTurn();
  t.clear();
  const axe = t.mon(0, 'Axe Raider');
  t.toPhase('BP');
  t.attack(0, axe.uid, elf2.uid);
  check(t.inGy(0, axe.uid) && !t.wasOffered(0, 'Mokey Mokey Smackdown') && e.atkOf(mk2) === 300, 'Mokey Mokey Smackdown: a non-Fairy being destroyed does nothing');
  t.endTurn();
  t.endTurn();
  t.mst(0, sd.uid);
  check(t.inGy(0, sd.uid), 'Mokey Mokey Smackdown: destroyed by Mystical Space Typhoon');
  t.clear();
  const fairy2 = t.mon(0, 'Shining Abyss');
  t.toPhase('BP');
  t.attack(0, fairy2.uid, elf2.uid);
  check(t.inGy(0, fairy2.uid) && !t.wasOffered(0, 'Mokey Mokey Smackdown') && e.atkOf(mk2) === 300, 'Mokey Mokey Smackdown: no effect once it left the field');
  void A;
}

// ---------- Pyramid of Wonders ----------
{
  const t = duel();
  const { e } = t;
  const py = t.hand(0, 'Pyramid of Wonders');
  const z = t.mon(0, 'Armored Zombie');
  const axe = t.mon(0, 'Axe Raider');
  t.mon(1, 'Gemini Elf');
  t.mon(1, 'Gemini Elf');
  t.activate(0, py.uid);
  check(t.faceUpActive(py.uid), 'Pyramid of Wonders: activates and stays face-up');
  check(e.atkOf(z) === 1900 && e.atkOf(axe) === 1700, 'Pyramid of Wonders: Zombies gain 200 ATK per opponent monster (2), others do not');
  const third = t.mon(1, 'Gemini Elf');
  check(e.atkOf(z) === 2100, 'Pyramid of Wonders: the bonus follows the opponent monster count');
  t.destroy(third.uid, 0);
  t.destroy(z.uid, 1);
  check(t.onField(z.uid) && t.inGy(0, py.uid), 'Pyramid of Wonders: sent to the GY instead of the Zombie that would be destroyed');
  check(e.atkOf(z) === 1500, 'Pyramid of Wonders: the bonus is gone once it left the field');
  t.destroy(z.uid, 1);
  check(t.inGy(0, z.uid), 'Pyramid of Wonders: no more protection once it left the field');
}

// ---------- Quarantine ----------
{
  const t = duel();
  const q = t.hand(0, 'Quarantine');
  const setB = t.set(1, 'Mystical Space Typhoon');
  t.activate(0, q.uid);
  check(t.faceUpActive(q.uid), 'Quarantine: activates and stays face-up');
  t.yes('Quarantine', 0);
  t.endTurn();
  const reveals = t.shown.filter((s) => s.startsWith('0|Quarantine reveals') && s.includes('Mystical Space Typhoon'));
  check(reveals.length === 1, 'Quarantine: reveals a Set card of the opponent during the End Phase');
  check(!t.e.fieldCard(setB.uid)!.faceUp, 'Quarantine: the revealed card goes back face-down');
  t.shown.length = 0;
  t.endTurn();
  check(t.shown.filter((s) => s.startsWith('0|Quarantine reveals')).length === 1, "Quarantine: works again in the next End Phase (the opponent's)");
  t.mst(0, q.uid);
  t.shown.length = 0;
  t.endTurn();
  check(t.inGy(0, q.uid) && !t.shown.some((s) => s.includes('Quarantine')), 'Quarantine: nothing once it left the field');
}

// ---------- Nightmare Wheel ----------
{
  const t = duel();
  const { e, B } = t;
  const nw = t.set(0, 'Nightmare Wheel');
  t.endTurn();
  // On the opponent's turn: respond to their Summon.
  const m = t.hand(1, 'Gemini Elf');
  t.respond(0, 'Nightmare Wheel');
  t.prefer.add(m.uid);
  t.step({ type: 'SUMMON', player: 1, uid: m.uid, zone: 0, pos: 'atk', faceUp: true });
  t.clear();
  check(t.faceUpActive(nw.uid) && e.fieldCard(m.uid)!.equips.includes(nw.uid), "Nightmare Wheel: activated on the opponent's turn, targeting their monster, and stays face-up");
  t.toPhase('BP');
  check(!e.canAttackWith(1, e.fieldCard(m.uid)!), 'Nightmare Wheel: the target cannot attack');
  t.endTurn();
  const lp1 = B.lp;
  check(lp1 === 3500, 'Nightmare Wheel: 500 damage in my Standby Phase');
  t.endTurn();
  check(B.lp === 3500, "Nightmare Wheel: no damage in the opponent's Standby Phase");
  check(!e.canChangePosition(1, e.fieldCard(m.uid)!), 'Nightmare Wheel: the target cannot change its battle position');
  t.toPhase('BP');
  check(!e.canAttackWith(1, e.fieldCard(m.uid)!), 'Nightmare Wheel: still cannot attack on a later turn');
  t.endTurn();
  check(B.lp === 3000, 'Nightmare Wheel: 500 damage again in my next Standby Phase');
  t.destroy(m.uid, 0);
  check(t.inGy(0, nw.uid), 'Nightmare Wheel: destroyed when the monster leaves the field');
  t.endTurn();
  t.endTurn();
  check(B.lp === 3000, 'Nightmare Wheel: no more damage once it left');
  // Bounced target: the Wheel still goes.
  const t2 = duel();
  const nw2 = t2.set(0, 'Nightmare Wheel');
  const m2 = t2.mon(1, 'Gemini Elf');
  t2.prefer.add(m2.uid);
  t2.activate(0, nw2.uid);
  check(t2.faceUpActive(nw2.uid), 'Nightmare Wheel: can be activated in my Main Phase too');
  t2.e.toHand(m2.uid);
  t2.endTurn();
  t2.endTurn();
  check(t2.inGy(0, nw2.uid) && t2.B.lp === 4000, 'Nightmare Wheel: destroyed (no damage) when its monster left the field by being returned to the hand');
}

// ---------- Ninjitsu Art of Super-Transformation ----------
{
  const t = duel();
  const { e } = t;
  const na = t.set(0, 'Ninjitsu Art of Super-Transformation');
  check(!e.canActivateMain(0, na.uid), 'Ninjitsu Art: cannot be activated without a "Ninja" monster');
  const ninja = t.mon(0, 'Strike Ninja');
  const foe = t.mon(1, 'Gemini Elf');
  const bewd = t.deck(0, 'Blue-Eyes White Dragon');
  t.deck(0, 'Tri-Horned Dragon');
  t.prefer.add(bewd.uid);
  t.activate(0, na.uid);
  check(t.inGy(0, ninja.uid) && t.inGy(1, foe.uid), 'Ninjitsu Art: both targets are sent to the GY');
  check(t.onField(bewd.uid), 'Ninjitsu Art: Special Summons a Dragon up to the combined Levels (4+4 = 8) from the Deck');
  check(t.faceUpActive(na.uid), 'Ninjitsu Art: stays face-up');
  t.endTurn();
  t.endTurn();
  check(t.onField(bewd.uid), 'Ninjitsu Art: the monster stays while the card does');
  t.mst(0, na.uid);
  check(t.inGy(0, na.uid) && e.player(0).removed.some((c) => c.uid === bewd.uid), 'Ninjitsu Art: the monster is banished when the card leaves the field');
  // A Level 9+ monster would be too high.
  const t2 = duel();
  const na2 = t2.set(0, 'Ninjitsu Art of Super-Transformation');
  t2.mon(0, 'Strike Ninja');
  t2.mon(1, 'Mokey Mokey');
  const big = t2.deck(0, 'Blue-Eyes White Dragon');
  t2.activate(0, na2.uid);
  check(!t2.onField(big.uid), 'Ninjitsu Art: a Level 8 is too high for 4+1');
}

// ---------- Ordeal of a Traveler ----------
{
  const t = duel();
  const { e } = t;
  const ot = t.set(0, 'Ordeal of a Traveler');
  t.activate(0, ot.uid);
  check(t.faceUpActive(ot.uid), 'Ordeal of a Traveler: activates and stays face-up');
  t.hand(0, 'Gemini Elf');
  t.hand(0, 'Axe Raider');
  t.endTurn();
  const a1 = t.mon(1, 'Gemini Elf');
  const a2 = t.mon(1, 'Archfiend Soldier');
  t.respond(0, 'Ordeal of a Traveler');
  t.choose('Ordeal of a Traveler', 'Spell');
  t.toPhase('BP');
  const lp = e.player(0).lp;
  t.attack(1, a1.uid, null);
  check(e.player(1).hand.some((c) => c.uid === a1.uid) && e.player(0).lp === lp, 'Ordeal of a Traveler: a wrong call returns the attacker to the hand');
  t.clear();
  t.respond(0, 'Ordeal of a Traveler');
  t.choose('Ordeal of a Traveler', 'Monster');
  t.attack(1, a2.uid, null);
  check(t.onField(a2.uid) && e.player(0).lp === lp - 1900, 'Ordeal of a Traveler: a right call lets the attack through');
  t.endTurn();
  t.endTurn();
  t.clear();
  t.respond(0, 'Ordeal of a Traveler');
  t.choose('Ordeal of a Traveler', 'Trap');
  t.toPhase('BP');
  t.attack(1, a2.uid, null);
  check(e.player(1).hand.some((c) => c.uid === a2.uid), 'Ordeal of a Traveler: works on each attack, turn after turn');
  t.endTurn();
  t.mst(0, ot.uid);
  t.endTurn();
  t.clear();
  const a3 = t.mon(1, 'Gemini Elf');
  t.toPhase('BP');
  t.attack(1, a3.uid, null);
  check(t.inGy(0, ot.uid) && !t.wasOffered(0, 'Ordeal') && t.onField(a3.uid), 'Ordeal of a Traveler: nothing once it left the field');
}

// ---------- Pitch-Black Power Stone ----------
{
  const t = duel();
  const { e } = t;
  const ps = t.set(0, 'Pitch-Black Power Stone');
  const br = t.mon(0, 'Breaker the Magical Warrior');
  t.activate(0, ps.uid);
  check(t.faceUpActive(ps.uid) && e.fieldCard(ps.uid)!.counters === 3, 'Pitch-Black Power Stone: activates with 3 Spell Counters and stays');
  t.effect(0, ps.uid);
  check(e.fieldCard(ps.uid)!.counters === 2 && br.counters === 1, 'Pitch-Black Power Stone: moves a Spell Counter to a card that can hold one');
  check(!e.canUseMonsterEffect(0, e.fieldCard(ps.uid)!), 'Pitch-Black Power Stone: once per turn');
  t.endTurn();
  check(!e.canUseMonsterEffect(1, e.fieldCard(ps.uid)!), "Pitch-Black Power Stone: not on the opponent's turn");
  t.endTurn();
  t.effect(0, ps.uid);
  t.endTurn();
  t.endTurn();
  t.effect(0, ps.uid);
  check(br.counters === 3 && t.inGy(0, ps.uid), 'Pitch-Black Power Stone: destroyed when its last Spell Counter is removed');
}

// ---------- Quantum Cat ----------
{
  const t = duel();
  const { e } = t;
  const qc = t.set(0, 'Quantum Cat');
  t.endTurn();
  const m = t.hand(1, 'Gemini Elf');
  t.respond(0, 'Quantum Cat');
  t.choose('declare a Monster Type', 'Dragon');
  t.choose('declare an Attribute', 'LIGHT');
  t.step({ type: 'SUMMON', player: 1, uid: m.uid, zone: 0, pos: 'atk', faceUp: true });
  const cat = e.fieldCard(qc.uid);
  check(!!cat && e.find(qc.uid)!.loc.zone === 'mz' && cat.pos === 'def', "Quantum Cat: activated on the opponent's turn, Special Summoned in Defense Position");
  check(!!cat && e.atkOf(cat) === 0 && e.defOf(cat) === 2200 && levelOf(e, cat) === 4, 'Quantum Cat: Level 4, 0 ATK / 2200 DEF');
  check(!!cat && e.raceOf(cat) === 'Dragon' && attrOf(e, cat) === 'LIGHT', 'Quantum Cat: has the declared Type and Attribute');
  t.clear();
  t.toPhase('BP');
  t.attack(1, m.uid, qc.uid);
  check(t.onField(qc.uid) && e.player(1).lp === 3700, 'Quantum Cat: stays on the field and walls a 1900 ATK attacker');
  t.destroy(qc.uid, 1);
  check(t.inGy(0, qc.uid) && e.raceOf({ uid: qc.uid, name: 'Quantum Cat', owner: 0 } as Card) === '', 'Quantum Cat: goes to the GY as a Trap when destroyed');
}

// ---------- SPYRAL MISSION - Assault ----------
{
  const t = duel();
  const { e, A } = t;
  const sm = t.hand(0, 'SPYRAL MISSION - Assault');
  const drone = t.mon(0, 'SPYRAL GEAR - Drone');
  drone.tags = { permAtk: 2000 };
  const elf = t.mon(1, 'Gemini Elf');
  t.activate(0, sm.uid);
  check(t.faceUpActive(sm.uid), 'SPYRAL MISSION - Assault: activates and stays face-up');
  t.respond(0, 'SPYRAL MISSION');
  t.toPhase('BP');
  const hand = A.hand.length;
  t.attack(0, drone.uid, elf.uid);
  check(t.inGy(1, elf.uid) && A.hand.length === hand + 1, 'SPYRAL MISSION - Assault: draw 1 when a SPYRAL monster destroys a monster by battle');
  t.endTurn(); // my 1st End Phase
  t.endTurn();
  const elf2 = t.mon(1, 'Gemini Elf');
  t.toPhase('BP');
  const hand2 = A.hand.length;
  t.attack(0, drone.uid, elf2.uid);
  check(A.hand.length === hand2 + 1, 'SPYRAL MISSION - Assault: draws again on a later turn');
  t.endTurn(); // 2nd
  check(t.faceUpActive(sm.uid), 'SPYRAL MISSION - Assault: still there after my 2nd End Phase');
  t.endTurn();
  t.endTurn(); // 3rd
  check(t.inGy(0, sm.uid), 'SPYRAL MISSION - Assault: destroyed during my 3rd End Phase after activation');
  t.endTurn();
  t.destroy(drone.uid, 1);
  const d2 = t.hand(0, 'SPYRAL GEAR - Drone');
  check(e.canUseGraveEffect(0, sm.uid), 'SPYRAL MISSION - Assault: its GY effect is available');
  t.step({ type: 'GRAVE_EFFECT', player: 0, uid: sm.uid });
  check(t.onField(d2.uid) && A.removed.some((c) => c.uid === sm.uid), 'SPYRAL MISSION - Assault: banished from the GY to Special Summon a SPYRAL from the hand');
}

// ---------- Shard of Greed ----------
{
  const t = duel();
  const { e, A } = t;
  const sg = t.hand(0, 'Shard of Greed');
  t.activate(0, sg.uid);
  check(t.faceUpActive(sg.uid) && e.fieldCard(sg.uid)!.counters === 0, 'Shard of Greed: activates and stays face-up with no counters');
  t.endTurn();
  check(e.fieldCard(sg.uid)!.counters === 0, "Shard of Greed: the opponent's draw adds nothing");
  t.endTurn();
  check(e.fieldCard(sg.uid)!.counters === 1 && !e.canUseMonsterEffect(0, e.fieldCard(sg.uid)!), 'Shard of Greed: 1 counter after my normal draw, not usable yet');
  t.endTurn();
  t.endTurn();
  check(e.fieldCard(sg.uid)!.counters === 2, 'Shard of Greed: a counter for each normal draw');
  const hand = A.hand.length;
  t.effect(0, sg.uid);
  check(t.inGy(0, sg.uid) && A.hand.length === hand + 2, 'Shard of Greed: sent to the GY with 2 counters to draw 2');
}

// ---------- Spiritual Forest ----------
{
  const t = duel();
  const { e } = t;
  const sf = t.hand(0, 'Spiritual Forest');
  const fang = t.mon(0, 'Silver Fang');
  const axe = t.mon(0, 'Axe Raider');
  t.activate(0, sf.uid);
  check(t.faceUpActive(sf.uid), 'Spiritual Forest: activates and stays face-up');
  t.endTurn();
  const a1 = t.mon(1, 'Gemini Elf');
  const a2 = t.mon(1, 'Gemini Elf');
  const a3 = t.mon(1, 'Gemini Elf');
  t.toPhase('BP');
  t.attack(1, a1.uid, fang.uid);
  check(t.onField(fang.uid) && e.player(0).lp === 3300, 'Spiritual Forest: the first Beast that would be destroyed by battle is not (damage still dealt)');
  t.attack(1, a2.uid, axe.uid);
  check(t.inGy(0, axe.uid), 'Spiritual Forest: a non-Beast is destroyed normally');
  t.attack(1, a3.uid, fang.uid);
  check(t.inGy(0, fang.uid), 'Spiritual Forest: only the first one each turn');
  t.endTurn();
  const fang2 = t.mon(0, 'Silver Fang');
  t.endTurn();
  t.toPhase('BP');
  t.attack(1, a1.uid, fang2.uid);
  check(t.onField(fang2.uid), 'Spiritual Forest: works again on the next turn');
  t.endTurn();
  t.mst(0, sf.uid);
  t.endTurn();
  t.toPhase('BP');
  t.attack(1, a1.uid, fang2.uid);
  check(t.inGy(0, sf.uid) && t.inGy(0, fang2.uid), 'Spiritual Forest: no protection once it left the field');
}

// ---------- Summon Cloud ----------
{
  const t = duel();
  const { e } = t;
  const sc = t.hand(0, 'Summon Cloud');
  const ball = t.hand(0, 'Cloudian - Smoke Ball');
  t.activate(0, sc.uid);
  check(t.faceUpActive(sc.uid), 'Summon Cloud: activates and stays face-up');
  t.effect(0, sc.uid);
  check(t.onField(ball.uid) && t.faceUpActive(sc.uid), 'Summon Cloud: Special Summons a Cloudian from the hand and stays');
  t.destroy(ball.uid, 1);
  t.hand(0, 'Cloudian - Smoke Ball');
  check(!e.canUseMonsterEffect(0, e.fieldCard(sc.uid)!), 'Summon Cloud: once per turn');
  t.endTurn();
  t.endTurn();
  const g = t.gy(1, 'Cloudian - Smoke Ball');
  t.prefer.add(g.uid);
  const blocker = t.mon(0, 'Axe Raider');
  check(!e.canUseMonsterEffect(0, e.fieldCard(sc.uid)!), 'Summon Cloud: not while I control a monster');
  t.destroy(blocker.uid, 1);
  t.effect(0, sc.uid);
  check(t.onField(g.uid) && e.controller(g.uid) === 0 && t.inGy(0, sc.uid), "Summon Cloud: summoning from the (opponent's) GY destroys it");
}

// ---------- Rare Metalmorph ----------
{
  const t = duel();
  const { e } = t;
  const rm = t.set(0, 'Rare Metalmorph');
  const xh = t.mon(0, 'X-Head Cannon');
  t.endTurn();
  const m = t.hand(1, 'Gemini Elf');
  t.respond(0, 'Rare Metalmorph');
  t.prefer.add(xh.uid);
  t.step({ type: 'SUMMON', player: 1, uid: m.uid, zone: 0, pos: 'atk', faceUp: true });
  t.clear();
  check(t.faceUpActive(rm.uid) && e.atkOf(xh) === 2300, "Rare Metalmorph: activated on the opponent's turn, the Machine gains 500 ATK, card stays");
  // The opponent equips Axe of Despair to it: negated once.
  t.respond(0, 'Rare Metalmorph');
  const ax = t.hand(1, 'Axe of Despair');
  t.activate(1, ax.uid);
  check(t.inGy(1, ax.uid) && e.atkOf(xh) === 2300, 'Rare Metalmorph: negates a Spell that targets the monster');
  const ax2 = t.hand(1, 'Axe of Despair');
  t.offered.length = 0;
  t.activate(1, ax2.uid);
  check(!t.wasOffered(0, 'Rare Metalmorph') && e.atkOf(xh) === 3300, 'Rare Metalmorph: only once');
  t.destroy(xh.uid, 1);
  check(t.inGy(0, rm.uid), 'Rare Metalmorph: destroyed when the monster leaves the field');
  const t2 = duel();
  const rm2 = t2.set(0, 'Rare Metalmorph');
  t2.mon(0, 'Axe Raider');
  check(!t2.e.canActivateMain(0, rm2.uid), 'Rare Metalmorph: needs a Machine to target');
}

// ---------- Red Screen ----------
{
  const t = duel();
  const { e, A } = t;
  const rs = t.set(0, 'Red Screen');
  t.activate(0, rs.uid);
  check(t.faceUpActive(rs.uid), 'Red Screen: activates and stays face-up');
  t.endTurn();
  check(A.lp === 3000, 'Red Screen: I pay 1000 LP in my End Phase');
  const a = t.mon(1, 'Gemini Elf');
  t.toPhase('BP');
  check(!e.canAttackWith(1, a), 'Red Screen: the opponent cannot declare attacks');
  t.endTurn();
  check(A.lp === 3000, "Red Screen: no payment in the opponent's End Phase");
  t.endTurn();
  check(A.lp === 2000 && t.faceUpActive(rs.uid), 'Red Screen: pays again in my next End Phase');
  A.lp = 1000;
  t.endTurn();
  t.endTurn();
  check(t.inGy(0, rs.uid) && A.lp === 1000, 'Red Screen: destroyed when I cannot pay');
  t.toPhase('BP');
  check(e.canAttackWith(1, a), 'Red Screen: the opponent can attack again once it is gone');
}

// ---------- Robbin' Zombie ----------
{
  const t = duel();
  const { e, B } = t;
  const rz = t.set(0, "Robbin' Zombie");
  const axe = t.mon(0, 'Axe Raider');
  t.activate(0, rz.uid);
  check(t.faceUpActive(rz.uid), "Robbin' Zombie: activates and stays face-up");
  t.toPhase('BP');
  const top = B.deck[0].uid;
  t.attack(0, axe.uid, null);
  check(B.gy.some((c) => c.uid === top), "Robbin' Zombie: battle damage mills the top card of the opponent's Deck");
  t.endTurn();
  const atk = t.mon(1, 'Gemini Elf');
  t.toPhase('BP');
  const myGy = e.player(0).gy.length;
  t.attack(1, atk.uid, null);
  check(e.player(0).gy.length === myGy, "Robbin' Zombie: the opponent's battle damage mills nothing");
  t.endTurn();
  t.toPhase('BP');
  const gy2 = B.gy.length;
  const weak = t.mon(1, 'Mokey Mokey');
  t.attack(0, axe.uid, weak.uid);
  check(B.gy.length === gy2 + 2, "Robbin' Zombie: mills again on a later turn (monster + 1 card)");
  t.endTurn();
  t.endTurn();
  t.mst(0, rz.uid);
  t.toPhase('BP');
  const gy3 = B.gy.length;
  t.attack(0, axe.uid, atk.uid === undefined ? null : null);
  check(t.inGy(0, rz.uid) && B.gy.length === gy3, "Robbin' Zombie: nothing once it left the field");
}

// ---------- Scrum Force ----------
{
  const t = duel();
  const { e } = t;
  const sf = t.set(0, 'Scrum Force');
  const d1 = t.mon(0, 'Mystical Elf', 'def');
  const d2 = t.mon(0, 'Axe Raider', 'def');
  t.endTurn();
  const m = t.hand(1, 'Gemini Elf');
  t.respond(0, 'Scrum Force');
  t.step({ type: 'SUMMON', player: 1, uid: m.uid, zone: 0, pos: 'atk', faceUp: true });
  t.clear();
  check(t.faceUpActive(sf.uid), "Scrum Force: activated on the opponent's turn and stays face-up");
  const sc = t.hand(1, 'Shield Crush');
  check(!e.canActivateMain(1, sc.uid), 'Scrum Force: the opponent cannot target my Defense Position monsters');
  t.destroy(d1.uid, 1);
  check(t.onField(d1.uid), "Scrum Force: my Defense Position monsters cannot be destroyed by the opponent's effects");
  t.endTurn();
  // My own effects still work, and the shield needs 2 Defense Position monsters.
  const extra = t.mon(0, 'Silver Fang', 'def');
  t.destroy(extra.uid, 0);
  check(t.inGy(0, extra.uid), 'Scrum Force: my own effects can still destroy them');
  // Destroyed by a card effect: another card in my Spell & Trap Zone goes instead.
  const other1 = t.set(0, 'Mystical Space Typhoon');
  t.destroy(sf.uid, 1);
  check(t.onField(sf.uid) && t.inGy(0, other1.uid), 'Scrum Force: destroys another card in my Spell & Trap Zone instead of itself');
  t.destroy(d2.uid, 0);
  t.endTurn();
  check(e.canActivateMain(1, sc.uid), 'Scrum Force: with only 1 Defense Position monster the opponent can target again');
  t.destroy(sf.uid, 1);
  check(t.inGy(0, sf.uid), 'Scrum Force: destroyed when nothing else can go instead');
  t.mon(0, 'Silver Fang', 'def');
  t.destroy(d1.uid, 1);
  check(t.inGy(0, d1.uid), 'Scrum Force: no protection once it left the field');
}

// ---------- Sealing Ceremony of Mokuton ----------
{
  const t = duel();
  const { e, B } = t;
  const mk = t.set(0, 'Sealing Ceremony of Mokuton');
  t.activate(0, mk.uid);
  check(t.faceUpActive(mk.uid), 'Sealing Ceremony of Mokuton: activates and stays face-up');
  const earth = t.mon(0, 'Axe Raider');
  const g1 = t.gy(1, 'Gemini Elf');
  const g2 = t.gy(1, 'Axe of Despair');
  t.gy(1, 'Mokey Mokey');
  t.handlers.push((pr) => (pr.kind === 'select' && pr.title.includes('banish up to 2') ? { type: 'CHOOSE', player: pr.player, picks: [0, 1] } : undefined));
  t.effect(0, mk.uid);
  check(t.inGy(0, earth.uid) && B.removed.some((c) => c.uid === g1.uid) && B.removed.some((c) => c.uid === g2.uid), "Sealing Ceremony of Mokuton: Tributes an EARTH monster to banish 2 cards from the opponent's GY");
  t.mon(0, 'Axe Raider');
  check(!e.canUseMonsterEffect(0, e.fieldCard(mk.uid)!), 'Sealing Ceremony of Mokuton: once per turn');
  t.endTurn();
  t.endTurn();
  t.effect(0, mk.uid);
  check(B.removed.length === 3 && t.faceUpActive(mk.uid), 'Sealing Ceremony of Mokuton: works again next turn and stays');
  t.mon(0, 'Axe Raider');
  t.gy(1, 'Gemini Elf');
  t.endTurn();
  t.endTurn();
  t.mst(0, mk.uid);
  check(t.inGy(0, mk.uid) && !e.fieldCard(mk.uid), 'Sealing Ceremony of Mokuton: unusable once it left the field');
  const t2 = duel();
  const mk2 = t2.set(0, 'Sealing Ceremony of Mokuton');
  t2.activate(0, mk2.uid);
  t2.mon(0, 'Mystical Elf');
  t2.gy(1, 'Gemini Elf');
  check(!t2.e.canUseMonsterEffect(0, t2.e.fieldCard(mk2.uid)!), 'Sealing Ceremony of Mokuton: needs a face-up EARTH monster');
}

// ---------- Sealing Ceremony of Suiton ----------
{
  const t = duel();
  const { e, B } = t;
  const su = t.set(0, 'Sealing Ceremony of Suiton');
  t.activate(0, su.uid);
  check(t.faceUpActive(su.uid), 'Sealing Ceremony of Suiton: activates and stays face-up');
  const fish = t.hand(0, '7 Colored Fish');
  t.hand(0, '7 Colored Fish');
  const g = t.gy(1, 'Gemini Elf');
  t.gy(1, 'Gemini Elf');
  t.prefer.add(g.uid);
  t.prefer.add(fish.uid);
  t.effect(0, su.uid);
  check(t.inGy(0, fish.uid) && B.removed.some((c) => c.uid === g.uid), "Sealing Ceremony of Suiton: sends a WATER monster from the hand to banish a card from the opponent's GY");
  check(!e.canUseMonsterEffect(0, e.fieldCard(su.uid)!), 'Sealing Ceremony of Suiton: once per turn');
  t.endTurn();
  t.endTurn();
  t.effect(0, su.uid);
  check(B.removed.length === 2, 'Sealing Ceremony of Suiton: works again next turn');
  const t2 = duel();
  const su2 = t2.set(0, 'Sealing Ceremony of Suiton');
  t2.activate(0, su2.uid);
  t2.hand(0, 'Axe Raider');
  t2.gy(1, 'Gemini Elf');
  check(!t2.e.canUseMonsterEffect(0, t2.e.fieldCard(su2.uid)!), 'Sealing Ceremony of Suiton: needs a WATER monster in the hand');
  t2.hand(0, '7 Colored Fish');
  t2.destroy(su2.uid, 1);
  check(t2.inGy(0, su2.uid) && !t2.e.fieldCard(su2.uid), 'Sealing Ceremony of Suiton: gone once destroyed');
}

// ---------- Solemn Wishes ----------
{
  const t = duel();
  const { e, A } = t;
  const sw = t.set(0, 'Solemn Wishes');
  t.endTurn();
  const m = t.hand(1, 'Gemini Elf');
  t.respond(0, 'Solemn Wishes');
  t.step({ type: 'SUMMON', player: 1, uid: m.uid, zone: 0, pos: 'atk', faceUp: true });
  t.clear();
  check(t.faceUpActive(sw.uid), "Solemn Wishes: activated on the opponent's turn and stays face-up");
  t.endTurn();
  check(A.lp === 4500, 'Solemn Wishes: +500 for my normal draw');
  e.draw(0, 2);
  check(A.lp === 5000, 'Solemn Wishes: +500 for drawing 2 cards by an effect');
  t.endTurn();
  check(A.lp === 5000, "Solemn Wishes: nothing for the opponent's draw");
  t.endTurn();
  check(A.lp === 5500, 'Solemn Wishes: +500 again on my next draw');
  t.mst(0, sw.uid);
  t.endTurn();
  t.endTurn();
  check(A.lp === 5500, 'Solemn Wishes: nothing once it left the field');
}

// ---------- Soul Demolition ----------
{
  const t = duel();
  const { e, A, B } = t;
  const sd = t.set(0, 'Soul Demolition');
  t.activate(0, sd.uid);
  check(t.faceUpActive(sd.uid), 'Soul Demolition: activates and stays face-up');
  t.gy(0, 'Axe Raider');
  t.gy(0, 'Axe Raider');
  t.gy(1, 'Gemini Elf');
  t.gy(1, 'Gemini Elf');
  check(!e.canUseMonsterEffect(0, e.fieldCard(sd.uid)!), 'Soul Demolition: needs a Fiend on my side');
  t.mon(0, 'Archfiend Soldier');
  t.effect(0, sd.uid);
  check(A.lp === 3500 && A.removed.length === 1 && B.removed.length === 1, "Soul Demolition: pay 500, each player banishes 1 monster from the other's GY");
  t.effect(0, sd.uid);
  check(A.lp === 3000 && A.removed.length === 2 && B.removed.length === 2, 'Soul Demolition: can be used again');
  t.gy(1, 'Gemini Elf');
  t.destroy(sd.uid, 1);
  check(t.inGy(0, sd.uid), 'Soul Demolition: gone once destroyed');
}

// ---------- The Fountain in the Sky ----------
{
  const t = duel();
  const { e, A } = t;
  const fs = t.hand(0, 'The Fountain in the Sky');
  const elf = t.mon(0, 'Mystical Elf');
  const elf2 = t.mon(0, 'Mystical Elf');
  const axe = t.mon(0, 'Axe Raider');
  t.activate(0, fs.uid);
  check(t.faceUpActive(fs.uid), 'The Fountain in the Sky: activates and stays face-up');
  t.endTurn();
  const a = t.mon(1, 'Gemini Elf');
  const a2 = t.mon(1, 'Gemini Elf');
  const a3 = t.mon(1, 'Gemini Elf');
  t.respond(0, 'The Fountain in the Sky');
  t.toPhase('BP');
  t.attack(1, a.uid, elf.uid);
  check(A.removed.some((c) => c.uid === elf.uid) && A.lp === 4000 - 1100 + 800, 'The Fountain in the Sky: banishes the LIGHT monster destroyed by battle to gain its ATK');
  t.attack(1, a2.uid, elf2.uid);
  check(A.removed.some((c) => c.uid === elf2.uid) && A.lp === 4000 - 2200 + 1600, 'The Fountain in the Sky: each time');
  t.clear();
  t.attack(1, a3.uid, axe.uid);
  check(!t.wasOffered(0, 'Fountain') && t.inGy(0, axe.uid), 'The Fountain in the Sky: not for a non-LIGHT monster');
  t.endTurn();
  t.mst(0, fs.uid);
  const elf3 = t.mon(0, 'Mystical Elf');
  t.endTurn();
  t.clear();
  t.toPhase('BP');
  t.attack(1, a.uid, elf3.uid);
  check(t.inGy(0, fs.uid) && t.inGy(0, elf3.uid) && !t.wasOffered(0, 'Fountain'), 'The Fountain in the Sky: nothing once it left the field');
  void e;
}

// ---------- The First / Second / Third Sarcophagus ----------
{
  const t = duel();
  const { e, A } = t;
  const s2h = t.hand(0, 'The Second Sarcophagus');
  check(!e.canActivateMain(0, s2h.uid), 'The Second Sarcophagus: cannot be activated by itself');
  const s1 = t.set(0, 'The First Sarcophagus');
  A.hand.length = 0;
  A.deck.push(s2h);
  const s3 = t.deck(0, 'The Third Sarcophagus');
  const pharaoh = t.deck(0, 'Spirit of the Pharaoh');
  t.activate(0, s1.uid);
  check(t.faceUpActive(s1.uid), 'The First Sarcophagus: activates and stays face-up');
  t.endTurn();
  check(!e.spells(0).some((c) => c.name === 'The Second Sarcophagus'), 'The First Sarcophagus: nothing in my own End Phase');
  t.endTurn();
  check(e.spells(0).some((c) => c.uid === s2h.uid && c.faceUp), "The First Sarcophagus: places The Second Sarcophagus in the opponent's End Phase");
  t.endTurn();
  t.endTurn();
  check(t.onField(pharaoh.uid) && t.inGy(0, s1.uid) && t.inGy(0, s2h.uid) && t.inGy(0, s3.uid), 'The First Sarcophagus: places The Third, then all 3 go to the GY to Special Summon Spirit of the Pharaoh');
  // One leaving takes the others with it.
  const t2 = duel();
  const f1 = t2.set(0, 'The First Sarcophagus');
  const f2 = t2.deck(0, 'The Second Sarcophagus');
  t2.activate(0, f1.uid);
  t2.endTurn();
  t2.endTurn();
  check(t2.faceUpActive(f2.uid), 'The Second Sarcophagus: placed face-up and in effect');
  t2.mst(0, f2.uid);
  check(t2.inGy(0, f2.uid) && t2.inGy(0, f1.uid), 'The Second Sarcophagus: when it is removed, every Sarcophagus is sent to the GY');
  const t3 = duel();
  const g1 = t3.set(0, 'The First Sarcophagus');
  t3.deck(0, 'The Second Sarcophagus');
  const g3 = t3.deck(0, 'The Third Sarcophagus');
  t3.activate(0, g1.uid);
  t3.endTurn();
  t3.endTurn();
  t3.endTurn();
  t3.endTurn();
  check(t3.inGy(0, g3.uid) && t3.inGy(0, g1.uid), 'The Third Sarcophagus: assembled without Spirit of the Pharaoh, they still go to the GY');
  const t4 = duel();
  const h1 = t4.set(0, 'The First Sarcophagus');
  t4.deck(0, 'The Second Sarcophagus');
  t4.activate(0, h1.uid);
  t4.endTurn();
  t4.endTurn();
  t4.mst(0, h1.uid);
  check(!t4.e.spells(0).some((c) => c.name.includes('Sarcophagus')), 'The First Sarcophagus: when it is removed, The Second goes too');
}

// ---------- Tri-Blaze Accelerator ----------
{
  const t = duel();
  const { e, B } = t;
  const tb = t.hand(0, 'Tri-Blaze Accelerator');
  check(!e.canActivateMain(0, tb.uid), 'Tri-Blaze Accelerator: needs a face-up Blaze Accelerator');
  const ba = t.active(0, 'Blaze Accelerator');
  t.activate(0, tb.uid);
  check(t.faceUpActive(tb.uid) && t.inGy(0, ba.uid), 'Tri-Blaze Accelerator: activates by sending Blaze Accelerator to the GY, stays face-up');
  const pyro = t.hand(0, 'Blazing Inpachi');
  const foe = t.mon(1, 'Gemini Elf');
  const mine = t.mon(0, 'Axe Raider');
  t.effect(0, tb.uid);
  check(t.inGy(0, pyro.uid) && t.inGy(1, foe.uid) && B.lp === 3500, 'Tri-Blaze Accelerator: a Pyro from the hand destroys a monster and burns 500');
  t.toPhase('BP');
  check(!e.canAttackWith(0, mine), 'Tri-Blaze Accelerator: no attacks that turn');
  t.endTurn();
  t.endTurn();
  t.hand(0, 'Blazing Inpachi');
  const foe2 = t.mon(1, 'Gemini Elf');
  t.effect(0, tb.uid);
  check(t.inGy(1, foe2.uid) && B.lp === 3000, 'Tri-Blaze Accelerator: works again on a later turn');
  t.hand(0, 'Blazing Inpachi');
  t.mon(1, 'Gemini Elf');
  t.destroy(tb.uid, 1);
  check(t.inGy(0, tb.uid) && !e.fieldCard(tb.uid), 'Tri-Blaze Accelerator: gone once destroyed');
}

// ---------- Valhalla, Hall of the Fallen / Water Hazard ----------
for (const [name, ok, bad] of [
  ['Valhalla, Hall of the Fallen', 'Shining Abyss', 'Axe Raider'],
  ['Water Hazard', '7 Colored Fish', 'Cloudian - Nimbusman'],
] as const) {
  const t = duel();
  const { e } = t;
  const v = t.hand(0, name);
  t.activate(0, v.uid);
  check(t.faceUpActive(v.uid), `${name}: activates and stays face-up`);
  t.hand(0, bad);
  check(!e.canUseMonsterEffect(0, e.fieldCard(v.uid)!), `${name}: ${bad} cannot be Special Summoned with it`);
  const m = t.hand(0, ok);
  t.effect(0, v.uid);
  check(t.onField(m.uid) && t.faceUpActive(v.uid), `${name}: Special Summons ${ok} from the hand while I control no monsters`);
  t.hand(0, ok);
  check(!e.canUseMonsterEffect(0, e.fieldCard(v.uid)!), `${name}: not while I control a monster`);
  t.destroy(m.uid, 1);
  check(!e.canUseMonsterEffect(0, e.fieldCard(v.uid)!), `${name}: once per turn`);
  t.endTurn();
  t.endTurn();
  t.effect(0, v.uid);
  check(e.monsters(0).length === 1, `${name}: works again next turn`);
  t.destroy(e.monsters(0)[0].uid, 1);
  t.hand(0, ok);
  t.destroy(v.uid, 1);
  check(t.inGy(0, v.uid), `${name}: gone once destroyed`);
}

// ---------- Weapon Change ----------
{
  const t = duel();
  const { e, A } = t;
  const wc = t.hand(0, 'Weapon Change');
  const axe = t.mon(0, 'Axe Raider');
  t.activate(0, wc.uid);
  check(t.faceUpActive(wc.uid), 'Weapon Change: activates and stays face-up');
  t.yes('Weapon Change', 0);
  t.endTurn();
  t.endTurn();
  check(A.lp === 3300 && e.atkOf(axe) === 1150 && e.defOf(axe) === 1700, 'Weapon Change: in my Standby Phase, pay 700 to switch ATK and DEF');
  t.endTurn();
  check(e.atkOf(axe) === 1150, "Weapon Change: still switched during the opponent's next turn");
  t.handlers.length = 0;
  t.endTurn();
  check(e.atkOf(axe) === 1700 && e.defOf(axe) === 1150 && A.lp === 3300, "Weapon Change: back after the end of the opponent's next turn (no switch when I decline)");
  t.yes('Weapon Change', 0);
  t.endTurn();
  t.endTurn();
  check(A.lp === 2600 && e.atkOf(axe) === 1150, 'Weapon Change: usable each of my Standby Phases');
  t.mst(0, wc.uid);
  check(t.inGy(0, wc.uid) && e.atkOf(axe) === 1700, 'Weapon Change: the switch ends when it leaves the field');
  t.endTurn();
  t.endTurn();
  check(A.lp === 2600, 'Weapon Change: no more payments once it left the field');
}

// ---------- Token Stampede ----------
{
  const t = duel();
  const { e, A } = t;
  const ts = t.set(0, 'Token Stampede');
  const tok = e.createToken('Sheep Token', 0, 'atk', true, { atk: 0, def: 0, level: 1 })!;
  const tokD = e.createToken('Sheep Token', 0, 'def', true, { atk: 0, def: 0, level: 1 })!;
  const axe = t.mon(0, 'Axe Raider');
  t.endTurn();
  const m = t.hand(1, 'Gemini Elf');
  t.respond(0, 'Token Stampede');
  t.step({ type: 'SUMMON', player: 1, uid: m.uid, zone: 0, pos: 'atk', faceUp: true });
  t.clear();
  check(t.faceUpActive(ts.uid), "Token Stampede: activated on the opponent's turn and stays face-up");
  check(e.atkOf(tok) === 1000 && e.atkOf(tokD) === 0 && e.atkOf(axe) === 1700, 'Token Stampede: Attack Position Tokens gain 1000 ATK (others do not)');
  t.toPhase('BP');
  t.attack(1, m.uid, tok.uid);
  check(t.onField(tok.uid) && A.lp === 3100, 'Token Stampede: an Attack Position Token is not destroyed by battle');
  t.endTurn();
  t.endTurn();
  t.toPhase('BP');
  t.attack(1, m.uid, tok.uid);
  check(t.onField(tok.uid), 'Token Stampede: on every battle');
  t.endTurn();
  t.mst(0, ts.uid);
  check(e.atkOf(tok) === 0, 'Token Stampede: the bonus ends once it left the field');
  t.endTurn();
  t.toPhase('BP');
  t.attack(1, m.uid, tok.uid);
  check(!t.onField(tok.uid), 'Token Stampede: no battle protection once it left the field');
}

// ---------- Toon Defense ----------
{
  const t = duel();
  const { e, A } = t;
  const td = t.set(0, 'Toon Defense');
  t.active(0, 'Toon World');
  const toon = t.mon(0, 'Toon Mermaid');
  const skull = t.mon(0, 'Toon Summoned Skull');
  t.activate(0, td.uid);
  check(t.faceUpActive(td.uid), 'Toon Defense: activates and stays face-up');
  t.endTurn();
  const a = t.mon(1, 'Gemini Elf');
  const a2 = t.mon(1, 'Archfiend Soldier');
  t.respond(0, 'Toon Defense');
  t.toPhase('BP');
  t.attack(1, a.uid, toon.uid);
  check(t.onField(toon.uid) && A.lp === 2100, 'Toon Defense: the attack on a Level 4 Toon becomes a direct attack');
  t.clear();
  t.respond(0, 'Toon Defense');
  check(e.legalTargets(1, a2).some((x) => x.uid === skull.uid), 'Toon Defense: (Level 6 Toon is attackable)');
  t.attack(1, a2.uid, skull.uid);
  check(!t.wasOffered(0, 'Toon Defense'), 'Toon Defense: not for a Level 5+ Toon');
  t.endTurn();
  t.mst(0, td.uid);
  t.endTurn();
  t.clear();
  t.toPhase('BP');
  t.attack(1, a2.uid, toon.uid);
  check(t.inGy(0, td.uid) && !t.wasOffered(0, 'Toon Defense'), 'Toon Defense: nothing once it left the field');
}

// ---------- Tornado Wall ----------
{
  const t = duel();
  const { e, A, B } = t;
  const tw = t.set(0, 'Tornado Wall');
  check(!e.canActivateMain(0, tw.uid), 'Tornado Wall: cannot be activated without Umi');
  const umi = t.mon(0, 'Axe Raider'); // placeholder so the zone index stays stable
  t.destroy(umi.uid, 1);
  const field = { uid: e.state.uidCounter++, name: 'Umi', owner: 0 as Pid, pos: 'atk' as Pos, faceUp: true, active: true, placedTurn: 0, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
  A.field = field;
  t.activate(0, tw.uid);
  check(t.faceUpActive(tw.uid), 'Tornado Wall: activates while Umi is on the field and stays face-up');
  const mine = t.mon(0, 'Axe Raider');
  t.toPhase('BP');
  t.attack(0, mine.uid, null);
  check(B.lp === 2300, 'Tornado Wall: my own attacks still deal damage');
  t.endTurn();
  const a = t.mon(1, 'Gemini Elf');
  const a2 = t.mon(1, 'Archfiend Soldier');
  t.toPhase('BP');
  t.attack(1, a.uid, null);
  t.attack(1, a2.uid, null);
  check(A.lp === 4000, 'Tornado Wall: no battle damage from attacking monsters (each attack)');
  t.endTurn();
  t.endTurn();
  t.toPhase('BP');
  t.attack(1, a.uid, mine.uid);
  check(A.lp === 4000 && t.inGy(0, mine.uid), 'Tornado Wall: works on later turns too');
  t.destroy(field.uid, 1);
  t.attack(1, a2.uid, null);
  check(t.inGy(0, tw.uid) && A.lp === 2100, 'Tornado Wall: destroyed once Umi is gone, and damage goes through');
}

// ---------- Unending Nightmare ----------
{
  const t = duel();
  const { e, A } = t;
  const un = t.set(0, 'Unending Nightmare');
  const c1 = t.active(1, 'Pyramid of Wonders');
  const c2 = t.active(1, 'Spiritual Forest');
  const c3 = t.active(1, 'Summon Cloud');
  t.activate(0, un.uid);
  check(t.faceUpActive(un.uid), 'Unending Nightmare: activates and stays face-up');
  t.prefer.add(c1.uid);
  t.effect(0, un.uid);
  check(t.inGy(1, c1.uid) && A.lp === 3000, 'Unending Nightmare: pay 1000 LP to destroy a face-up Spell/Trap');
  t.prefer.add(c2.uid);
  t.effect(0, un.uid);
  check(t.inGy(1, c2.uid) && A.lp === 2000, 'Unending Nightmare: not limited to once per turn');
  t.endTurn();
  const m = t.hand(1, 'Gemini Elf');
  t.respond(0, 'Unending Nightmare');
  t.prefer.add(c3.uid);
  t.step({ type: 'SUMMON', player: 1, uid: m.uid, zone: 0, pos: 'atk', faceUp: true });
  check(t.inGy(1, c3.uid) && A.lp === 1000, "Unending Nightmare: usable on the opponent's turn too");
  check(t.offered.filter((o) => o.startsWith('0|Unending Nightmare')).length === 1, 'Unending Nightmare: once per Chain');
  t.clear();
  const c4 = t.active(1, 'Pyramid of Wonders');
  check(!e.canUseMonsterEffect(0, e.fieldCard(un.uid)!), 'Unending Nightmare: not with 1000 LP or less');
  A.lp = 3000;
  t.endTurn();
  t.destroy(un.uid, 1);
  check(t.inGy(0, un.uid) && t.onField(c4.uid), 'Unending Nightmare: gone once destroyed');
}

// ---------- Zoma the Spirit ----------
{
  const t = duel();
  const { e, B } = t;
  const zs = t.set(0, 'Zoma the Spirit');
  t.endTurn();
  const m = t.hand(1, 'Gemini Elf');
  t.respond(0, 'Zoma the Spirit');
  t.step({ type: 'SUMMON', player: 1, uid: m.uid, zone: 0, pos: 'atk', faceUp: true });
  t.clear();
  const z = e.fieldCard(zs.uid);
  check(!!z && e.find(zs.uid)!.loc.zone === 'mz' && z.pos === 'def', "Zoma the Spirit: activated on the opponent's turn, Special Summoned in Defense Position");
  check(!!z && e.atkOf(z) === 1800 && e.defOf(z) === 500 && e.raceOf(z) === 'Zombie' && attrOf(e, z) === 'DARK' && levelOf(e, z) === 4, 'Zoma the Spirit: Zombie / DARK / Level 4 / 1800 / 500');
  t.toPhase('BP');
  t.attack(1, m.uid, zs.uid);
  check(t.inGy(0, zs.uid) && B.lp === 2100, 'Zoma the Spirit: destroyed by battle, it inflicts the ATK of the monster that destroyed it');
}

console.log(failures ? `${failures} FAILURES` : 'ALL OK');
if (failures) process.exit(1);
