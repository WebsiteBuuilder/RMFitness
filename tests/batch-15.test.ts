// Speed Duel cards of batch 15 (run: npx tsx tests/batch-15.test.ts):
// one targeted check (or more) per scripted card that its main effect really happens.
import { Engine } from '../src/eds/engine';
import { getEffect } from '../src/eds/effects';
import { levelOf } from '../src/eds/speed/helpers';
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
const quick = (e: Engine, p: Pid, c: Card | null, ...ans: Ans[]) => {
  e.apply({ type: 'QUICK_EFFECT', player: p, uid: c!.uid });
  return settle(e, ...ans);
};
const gyOf = (e: Engine, p: Pid, name: string) => e.player(p).gy.find((c) => c.name === name) ?? null;
/** Plays turns until it is turn 3 (player 0 again, Battle Phase allowed). */
const toTurn3 = (e: Engine, ...ans: Ans[]) => {
  endTurn(e);
  endTurn(e, ...ans);
};
const def = (name: string) => getEffect(name)!;
const asActor = <T,>(e: Engine, p: Pid, fn: () => T): T => {
  const prev = e.actor;
  e.actor = p;
  try {
    return fn();
  } finally {
    e.actor = prev;
  }
};

// ======================= Effect Monsters =======================
section('Amazoness Scouts');
{
  const e = duel(['Amazoness Scouts', 'Amazoness Swords Woman']);
  const sc = place(e, 0, 'Amazoness Scouts');
  const sw = place(e, 0, 'Amazoness Swords Woman');
  quick(e, 0, sc);
  check(zone(e, sc) === 'gy' && sw!.tags?.effProofTurn === e.state.turn, 'Tributed: face-up "Amazoness" monsters are protected this turn');
  kill(e, [sw], 1);
  check(zone(e, sw) === 'mz', 'they cannot be destroyed by card effects');
  check(asActor(e, 1, () => e.untargetable(sw!)), "they cannot be targeted by the opponent's effects");
}

section('Ancient Gear Gadget');
{
  const e = duel(['Ancient Gear Gadget'], ['Mirror Force']);
  const mf = putST(e, 1, 'Mirror Force');
  const g = summon(e, 0, 'Ancient Gear Gadget', true, 'yes', { pick: ['Trap'] });
  check(e.state.fx.battleLock?.kind === 'trap', 'Summoned: a card type is declared');
  e.state.battle = { attacker: g!.uid, target: null };
  check(e.activationBlocked(1, mf), "while its controller's monster attacks, the opponent cannot activate Traps");
  e.state.battle = null;
  check(!e.activationBlocked(1, mf), 'outside of the battle they can');
}

section('Arcana Force I - The Magician');
{
  const e = duel(['Arcana Force I - The Magician', 'Ookazi', 'Hinotama']);
  const m = place(e, 0, 'Arcana Force I - The Magician');
  check(m!.tags?.coin === 1 || m!.tags?.coin === 2, 'Summoned: a coin is tossed');
  m!.tags!.coin = 1;
  playSpell(e, 0, 'Ookazi', { respond: 'Arcana Force I' });
  check(e.atkOf(m!) === 2200, 'Heads: a Spell Card is activated, its ATK becomes double its original ATK');
  m!.tags!.coin = 2;
  const lp = e.player(1).lp;
  playSpell(e, 0, 'Hinotama', { respond: 'Arcana Force I' });
  check(e.player(1).lp === lp - 500 + 500, 'Tails: the opponent gains 500 LP when a Spell is activated');
}

section('Banisher of the Radiance');
{
  const e = duel(['Banisher of the Radiance']);
  place(e, 0, 'Banisher of the Radiance');
  const axe = place(e, 0, FILL);
  kill(e, [axe]);
  check(zone(e, axe) === 'removed', 'a card sent to the GY is banished instead');
}

section('Blue Duston');
{
  const e = duel(['Blue Duston', 'Dark Magician']);
  const d = place(e, 0, 'Blue Duston');
  check(e.untributable(d!) && !e.canNormalSummon(0, grab(e, 0, 'Dark Magician')), 'it cannot be Tributed');
  const n = e.player(0).hand.length;
  kill(e, [d], 1);
  check(e.player(0).hand.length === n - 1 && e.player(0).removed.length === 1, "destroyed: 1 random card of its controller's hand is banished");
  endTurn(e);
  check(e.player(0).hand.length === n && e.player(0).removed.length === 0, 'it comes back in the next Standby Phase');
}

section('Chow Len the Prophet');
{
  const e = duel(['Chow Len the Prophet'], ['Mirror Force']);
  const cl = place(e, 0, 'Chow Len the Prophet');
  const mf = putST(e, 1, 'Mirror Force');
  effect(e, 0, cl, { pick: ['Trap'] }, { pick: ['Face-down card'] });
  check(mf.tags?.noActTurn === e.state.turn && e.activationBlocked(1, mf), 'declared Trap and it was a Trap: it cannot be activated this turn');
}

section('Cyclamen the Rikka Fairy');
{
  const e = duel(['Cyclamen the Rikka Fairy', 'Mystic Tomato']);
  const tom = place(e, 0, 'Mystic Tomato');
  const cy = grab(e, 0, 'Cyclamen the Rikka Fairy');
  effect(e, 0, cy, { pick: ['Mystic Tomato'] });
  check(zone(e, cy) === 'gy' && levelOf(e, tom!) === 2, 'Tributed from the hand: a Plant loses 2 Levels');
  endTurn(e, 'yes');
  check(zone(e, cy) === 'mz', 'End Phase: it Special Summons itself from the GY');
  check(levelOf(e, tom!) === 4, 'the Level change ended with the turn');
  kill(e, [e.fieldCard(cy.uid)]);
  check(zone(e, cy) === 'removed', 'then it is banished when it leaves the field');
}

section('Dark Necrofear');
{
  const e = duel(['Dark Necrofear', 'Summoned Skull', 'Archfiend Soldier', 'Terrorking Archfiend'], ['Axe Raider']);
  for (const n of ['Summoned Skull', 'Archfiend Soldier', 'Terrorking Archfiend']) kill(e, [place(e, 0, n)]);
  const nf = grab(e, 0, 'Dark Necrofear');
  e.apply({ type: 'SPECIAL', player: 0, uid: nf.uid });
  settle(e);
  check(zone(e, nf) === 'mz' && e.player(0).removed.length === 3, 'Special Summoned by banishing 3 Fiends from the GY');
  endTurn(e);
  const axe = place(e, 1, 'Axe Raider');
  kill(e, [e.fieldCard(nf.uid)], 1);
  endTurn(e);
  check(zone(e, nf) === 'sz' && e.controller(axe!.uid) === 0, 'destroyed by the opponent: End Phase, it is equipped to their monster and takes control of it');
  kill(e, [e.fieldCard(nf.uid)]);
  check(e.controller(axe!.uid) === 1, 'the equip is gone: control goes back');
}

section('Desrook Archfiend');
{
  const e = duel(['Terrorking Archfiend', 'Desrook Archfiend'], ['Blue-Eyes White Dragon']);
  const tk = place(e, 0, 'Terrorking Archfiend');
  grab(e, 0, 'Desrook Archfiend');
  endTurn(e);
  const bewd = place(e, 1, 'Blue-Eyes White Dragon');
  toBattle(e);
  attack(e, bewd, tk, { respond: 'Desrook Archfiend' });
  check(zone(e, tk) === 'mz' && !!gyOf(e, 0, 'Desrook Archfiend'), 'Terrorking destroyed: Desrook goes from the hand to the GY to revive it');
  const e2 = duel(['Desrook Archfiend']);
  place(e2, 0, 'Desrook Archfiend');
  toTurn3(e2);
  check(e2.player(0).lp === 3500, 'it costs 500 LP each Standby Phase');
}

section('Double Coston / Kaiser Sea Horse / Whirlwind Prodigy');
for (const [two, big] of [['Double Coston', 'Dark Magician'], ['Kaiser Sea Horse', 'Blue-Eyes White Dragon'], ['Whirlwind Prodigy', "Harpie's Pet Dragon"]]) {
  const e = duel([two, big, 'Gaia The Fierce Knight']);
  const t = place(e, 0, two);
  check(!e.canNormalSummon(0, grab(e, 0, 'Gaia The Fierce Knight')), `${two}: not 2 Tributes for another Attribute`);
  const b = summon(e, 0, big);
  check(zone(e, b) === 'mz' && zone(e, t) === 'gy', `${two} is 2 Tributes for ${big}`);
}

section('Evilswarm Zahak');
{
  const e = duel(['Evilswarm Zahak'], ['Summoned Skull']);
  const z = place(e, 0, 'Evilswarm Zahak');
  const sk = place(e, 1, 'Summoned Skull');
  kill(e, [z], 1);
  check(zone(e, sk) === 'gy', 'destroyed by the opponent: a Special Summoned Level 5+ monster is destroyed');
}

section('Flelf');
{
  const e = duel(['Flelf', 'Dark Magician']);
  const f = place(e, 0, 'Flelf');
  grab(e, 0, 'Dark Magician');
  effect(e, 0, f, { pick: ['Dark Magician'] });
  check(levelOf(e, f!) === 9, 'reveals a Level 7 monster: its Level rises by 7');
  endTurn(e);
  check(levelOf(e, f!) === 2, 'until the End Phase');
}

section('Gagaga Caesar');
{
  const e = duel(['Gagaga Caesar', 'Gagaga Gardna', 'Dark Magician']);
  const c = place(e, 0, 'Gagaga Caesar');
  const g = place(e, 0, 'Gagaga Gardna');
  const dm = place(e, 0, 'Dark Magician');
  kill(e, [dm]);
  effect(e, 0, c);
  check(levelOf(e, c!) === 7 && levelOf(e, g!) === 7 && zone(e, dm) === 'removed', 'banishes a Level 7 monster: the "Gagaga" monsters become Level 7');
  check(!def('Gagaga Caesar').cannotAttack!(e, c!, 0), 'it can attack with another "Gagaga" monster');
  kill(e, [g]);
  check(def('Gagaga Caesar').cannotAttack!(e, c!, 0), 'alone it cannot attack');
}

section('Grave Protector');
{
  const e = duel(['Grave Protector', 'Petit Moth'], ['Axe Raider']);
  place(e, 0, 'Grave Protector', 'def');
  const moth = place(e, 0, 'Petit Moth');
  endTurn(e);
  const axe = place(e, 1, 'Axe Raider');
  toBattle(e);
  attack(e, axe, moth);
  check(zone(e, moth) === 'deck', 'a monster destroyed by battle is shuffled into the Deck instead');
}

section('Heroic Challenger - Clasp Sword');
{
  const e = duel(['Heroic Challenger - Clasp Sword', 'Heroic Challenger - Clasp Sword', 'Heroic Challenger - Clasp Sword']);
  place(e, 0, 'Heroic Challenger - Clasp Sword');
  const n = e.player(0).hand.length;
  place(e, 0, 'Heroic Challenger - Clasp Sword', 'atk', true, 'yes');
  check(e.player(0).hand.some((c) => c.name === 'Heroic Challenger - Clasp Sword') && e.player(0).hand.length === n + 1, 'Special Summoned with a "Heroic Challenger" on the field: adds a "Heroic Challenger" from the Deck');
}

section("Magician's Valkyria");
{
  const e = duel(["Magician's Valkyria", 'Dark Magician Girl'], ['Axe Raider']);
  const v = place(e, 0, "Magician's Valkyria");
  const dmg = place(e, 0, 'Dark Magician Girl');
  const axe = place(e, 1, 'Axe Raider');
  const ts = e.legalTargets(1, axe!).map((m) => m.uid);
  check(ts.includes(v!.uid) && !ts.includes(dmg!.uid), 'the opponent can only attack Valkyria among Spellcasters');
}

section('Marina, Princess of Sunflowers');
{
  const e = duel(['Marina, Princess of Sunflowers', 'Mystic Tomato'], ['Axe Raider']);
  place(e, 0, 'Marina, Princess of Sunflowers');
  const tom = place(e, 0, 'Mystic Tomato');
  const axe = place(e, 1, 'Axe Raider');
  kill(e, [tom], 1, 'yes');
  check(zone(e, axe) === 'gy', 'another Plant destroyed: 1 card the opponent controls is destroyed');
}

section('Neo-Spacian Dark Panther');
{
  const e = duel(['Neo-Spacian Dark Panther'], ['Axe Raider']);
  const p = place(e, 0, 'Neo-Spacian Dark Panther');
  place(e, 1, 'Axe Raider');
  effect(e, 0, p);
  check(e.nameOf(p!) === 'Axe Raider', "its name becomes the opponent's monster's name");
  endTurn(e);
  check(e.nameOf(p!) === 'Neo-Spacian Dark Panther', 'until the End Phase');
}

section('Phantom Beast Cross-Wing');
{
  const e = duel(['Phantom Beast Cross-Wing', 'Phantom Beast Wild-Horn', 'Gazelle the King of Mythical Beasts']);
  const wh = place(e, 0, 'Phantom Beast Wild-Horn');
  const gz = place(e, 0, 'Gazelle the King of Mythical Beasts');
  const cw = place(e, 0, 'Phantom Beast Cross-Wing');
  check(e.atkOf(wh!) === 1700, 'on the field it gives nothing');
  kill(e, [cw]);
  check(e.atkOf(wh!) === 2000 && e.atkOf(gz!) === 1800, 'in the GY: "Phantom Beast" monsters and Gazelle gain 300 ATK');
}

section('Proto-Cyber Dragon');
{
  const e = duel(['Proto-Cyber Dragon', 'Cyber Dragon', 'Cyber Dragon', 'Polymerization'], [], ['Cyber End Dragon']);
  place(e, 0, 'Proto-Cyber Dragon');
  place(e, 0, 'Cyber Dragon');
  place(e, 0, 'Cyber Dragon');
  playSpell(e, 0, 'Polymerization');
  check(e.monsters(0).some((m) => m.name === 'Cyber End Dragon'), 'on the field it is "Cyber Dragon" (a Cyber End Dragon material)');
}

section('Scrap Mind Reader');
{
  const e = duel(['Scrap Mind Reader']);
  const s = place(e, 0, 'Scrap Mind Reader');
  kill(e, [s]);
  check(!e.canUseGraveEffect(0, s!.uid), 'Speed Duel has no Main Phase 2: its effect cannot be used');
}

section('The End of Anubis');
{
  const e = duel(['The End of Anubis', 'Axe Raider', 'Monster Reborn']);
  place(e, 0, 'The End of Anubis');
  const axe = place(e, 0, 'Axe Raider');
  kill(e, [axe]);
  playSpell(e, 0, 'Monster Reborn', { pick: ['Axe Raider'] }, 'yes');
  check(zone(e, axe) === 'gy' && logHas(e, 'The End of Anubis negates'), 'an effect targeting a card in the GY is negated');
}

section('Tyrant Dragon');
{
  const e = duel(['Tyrant Dragon'], ['Petit Moth', 'Petit Moth']);
  toTurn3(e);
  const t = place(e, 0, 'Tyrant Dragon');
  const m1 = place(e, 1, 'Petit Moth', 'def');
  const m2 = place(e, 1, 'Petit Moth', 'def');
  toBattle(e);
  attack(e, t, m1);
  check(zone(e, m1) === 'gy' && e.canAttackWith(0, t!), 'the opponent still controls a monster: it can attack again');
  attack(e, t, m2);
  check(zone(e, m2) === 'gy' && !e.canAttackWith(0, t!), 'no third attack');
  const fake = { card: { uid: 9999, name: 'Mirror Force', owner: 1 }, loc: { player: 1, zone: 'sz', index: 0 }, player: 1, label: 'x', negated: false, targetUid: t!.uid } as any;
  check(def('Tyrant Dragon').negatesEffect!(e, t!, 0, fake), 'a Trap effect that targets it is negated');
}

// ======================= Fusion Monsters =======================
section('Chimeratech Overdragon');
{
  const e = duel([FILL, 'Ookazi'], [], ['Chimeratech Overdragon']);
  const a = place(e, 0, FILL);
  const s = putST(e, 0, 'Ookazi');
  const c = place(e, 0, 'Chimeratech Overdragon');
  check(zone(e, a) === 'gy' && zone(e, s) === 'gy', 'Fusion Summoned: all other cards its controller controls are sent to the GY');
  check(e.atkOf(c!) === 1600 && def('Chimeratech Overdragon').attacks!(e, c!) === 2, 'ATK/DEF and attacks from the number of materials (2)');
}

section('Destiny HERO - Dystopia');
{
  const e = duel(['Destiny HERO - Diamond Dude'], ['Axe Raider'], ['Destiny HERO - Dystopia']);
  kill(e, [place(e, 0, 'Destiny HERO - Diamond Dude')]);
  const axe = place(e, 1, 'Axe Raider');
  const d = place(e, 0, 'Destiny HERO - Dystopia', 'atk', true, 'yes');
  check(e.player(1).lp === 4000 - 1400, 'Special Summoned: damage equal to a Level 4 or lower "Destiny HERO" in the GY');
  d!.atkMod += 500;
  quick(e, 0, d, { pick: ['Axe Raider'] });
  check(zone(e, axe) === 'gy' && e.atkOf(d!) === 2800, 'ATK changed: destroys 1 card and its ATK goes back to the original');
}

section('Elemental HERO Electrum');
{
  const e = duel([], ['Axe Raider'], ['Elemental HERO Electrum']);
  e.banish(e.player(0).deck[0].uid);
  const axe = place(e, 1, 'Axe Raider');
  const el = place(e, 0, 'Elemental HERO Electrum');
  check(e.player(0).removed.length === 0, 'Fusion Summoned: banished cards are shuffled into the Deck');
  check(e.atkOf(el!) === 3200 && !!axe, 'gains 300 ATK for each opponent monster sharing an Attribute');
}

section('Evil HERO Malicious Fiend');
{
  const e = duel([FILL], ['Axe Raider'], ['Evil HERO Malicious Fiend']);
  const mf = place(e, 0, 'Evil HERO Malicious Fiend');
  place(e, 0, FILL);
  const axe = place(e, 1, 'Axe Raider');
  const ts = e.legalTargets(1, axe!).map((m) => m.uid);
  check(ts.length === 1 && ts[0] === mf!.uid, "the opponent's monsters must attack this card");
}

section('Rainbow Overdragon');
{
  const e = duel(['Crystal Beast Sapphire Pegasus', FILL], ['Axe Raider'], ['Rainbow Overdragon']);
  kill(e, [place(e, 0, 'Crystal Beast Sapphire Pegasus')]);
  const ro = place(e, 0, 'Rainbow Overdragon');
  effect(e, 0, ro);
  check(e.atkOf(ro!) === 5800, 'banishes a "Crystal Beast": gains its ATK');
  const axe = place(e, 1, 'Axe Raider');
  quick(e, 0, ro);
  check(zone(e, ro) === 'gy' && zone(e, axe) === 'deck', 'Tributed: all cards on the field are shuffled into the Deck');
}

// ======================= Ritual Monster =======================
section('Conductor of Nephthys');
{
  const e = duel(['Conductor of Nephthys', 'Dark Magician', 'Chaos Nephthys']);
  const c = place(e, 0, 'Conductor of Nephthys');
  place(e, 0, FILL);
  summon(e, 0, 'Dark Magician', true, 'yes');
  check(zone(e, c) === 'gy', 'Tributed');
  const cn = grab(e, 0, 'Chaos Nephthys');
  toTurn3(e, { pick: ['Chaos Nephthys'] });
  check(zone(e, cn) === 'gy', 'next Standby Phase: a "Nephthys" card in the hand is destroyed');
}

// ======================= Spells =======================
section('Magicalized Duston Mop');
{
  const e = duel(['Magicalized Duston Mop', 'Axe Raider', 'Blue Duston']);
  const axe = place(e, 0, 'Axe Raider');
  const mop = playSpell(e, 0, 'Magicalized Duston Mop', { pick: ['Axe Raider'] });
  check(e.untributable(axe!), 'the equipped monster cannot be Tributed');
  kill(e, [mop], 1, 'yes');
  check(e.player(0).hand.some((c) => c.name === 'Blue Duston'), 'destroyed by the opponent: adds a "Duston" monster');
}

section('Fusion Recycling Plant');
{
  const e = duel(['Fusion Recycling Plant', 'Polymerization', 'Flame Manipulator', 'Masaki the Legendary Swordsman'], [], ['Flame Swordsman']);
  const frp = playSpell(e, 0, 'Fusion Recycling Plant');
  effect(e, 0, frp);
  const poly = e.player(0).hand.find((c) => c.name === 'Polymerization');
  check(!!poly, 'discard 1: adds "Polymerization"');
  place(e, 0, 'Flame Manipulator');
  const ms = place(e, 0, 'Masaki the Legendary Swordsman');
  act(e, 0, poly!.uid);
  check(e.monsters(0).some((m) => m.name === 'Flame Swordsman'), '(Fusion Summon)');
  endTurn(e, 'yes', { pick: ['Masaki the Legendary Swordsman'] });
  check(zone(e, ms) === 'hand', 'End Phase: a monster used as Fusion Material this turn goes back to the hand');
}

section('Pandemonium');
{
  const e = duel(['Pandemonium', 'Skull Archfiend of Lightning', 'Terrorking Archfiend']);
  playSpell(e, 0, 'Pandemonium');
  const sk = place(e, 0, 'Skull Archfiend of Lightning');
  kill(e, [sk], 1, 'yes');
  check(e.player(0).hand.some((c) => c.name === 'Terrorking Archfiend'), 'an Archfiend destroyed by an effect: a lower Level Archfiend is added');
}

section('Bujintervention');
{
  const e = duel(['Bujintervention', 'Bujingi Pavo'], ['Axe Raider', 'Axe Raider', 'Axe Raider']);
  toTurn3(e);
  const pavo = place(e, 0, 'Bujingi Pavo');
  const axe = place(e, 1, 'Axe Raider');
  playSpell(e, 0, 'Bujintervention');
  pavo!.atkMod += 500;
  toBattle(e);
  attack(e, pavo, axe, { respond: 'Bujintervention' });
  check(zone(e, axe) === 'removed' && e.player(1).removed.length === 3, 'it destroys a monster by battle: that monster and all its copies are banished');
}

section('Faustian Bargain');
{
  const e = duel(['Faustian Bargain', 'Petit Moth'], ['Axe Raider']);
  const axe = place(e, 1, 'Axe Raider');
  const moth = grab(e, 0, 'Petit Moth');
  playSpell(e, 0, 'Faustian Bargain', { pick: ['Axe Raider'] }, { pick: ['Petit Moth'] });
  check(zone(e, axe) === 'gy' && zone(e, moth) === 'mz', 'a Special Summoned monster goes to the GY; a Normal Monster is Special Summoned from the hand');
}

section('Overlay Regen');
{
  const e = duel(['Overlay Regen']);
  const c = grab(e, 0, 'Overlay Regen');
  check(!e.canActivateMain(0, c.uid), 'no Xyz Monster on the field: it cannot be activated');
}

section('Triangle Ecstasy Spark');
{
  const e = duel(['Triangle Ecstasy Spark', 'Harpie Lady Sisters'], ['Mirror Force']);
  e.state.fx.ignoreCond = e.player(0).deck.find((c) => c.name === 'Harpie Lady Sisters')!.uid; // audit-eds: it must first be Special Summoned by "Elegant Egotist"
  const hls = place(e, 0, 'Harpie Lady Sisters');
  const mf = putST(e, 1, 'Mirror Force');
  playSpell(e, 0, 'Triangle Ecstasy Spark');
  check(e.atkOf(hls!) === 2700, '"Harpie Lady Sisters" become 2700 ATK');
  check(e.activationBlocked(1, mf), 'the opponent cannot activate Traps this turn');
}

section('Diamond-Dust Cyclone');
{
  const e = duel(['Diamond-Dust Cyclone'], ['Axe Raider']);
  const axe = place(e, 1, 'Axe Raider');
  (axe!.tags ??= {}).fog = 8;
  const n = e.player(0).hand.length;
  playSpell(e, 0, 'Diamond-Dust Cyclone');
  check(zone(e, axe) === 'gy' && e.player(0).hand.length === n + 1 + 2 - 1, 'destroys a monster with 8 Fog Counters and draws 2');
}

// ======================= Traps =======================
section('Chosen of Zefra');
{
  const e = duel(['Chosen of Zefra', 'Axe Raider']);
  const axe = place(e, 0, 'Axe Raider');
  const z = playTrap(e, 0, 'Chosen of Zefra');
  check(active(e, z) && e.atkOf(axe!) === 1700, 'activates and stays; no face-up "Zefra" in the Extra Deck, so nothing applies');
}

section('Heraldry Record');
{
  const e = duel(['Heraldry Record']);
  const fc = putST(e, 0, 'Heraldry Record');
  check(e.responsesFor(0, 'effect', {}).every((o) => o.uid !== fc.uid), 'no Xyz Monster effect to negate: it cannot be activated');
}

section('Blast Held by a Tribute');
{
  const e = duel(['Blast Held by a Tribute'], ['Summoned Skull', 'Petit Moth', 'Axe Raider']);
  putST(e, 0, 'Blast Held by a Tribute');
  endTurn(e);
  place(e, 1, 'Petit Moth');
  const sk = summon(e, 1, 'Summoned Skull');
  const axe = place(e, 1, 'Axe Raider');
  toBattle(e);
  attack(e, sk, null, { respond: 'Blast Held by a Tribute' });
  check(zone(e, sk) === 'gy' && zone(e, axe) === 'gy' && e.player(1).lp === 3000, 'a Tribute Summoned monster attacks: their Attack Position monsters are destroyed and 1000 damage');
}

section('Corrosive Scales');
{
  const e = duel(['Corrosive Scales', 'Big Insect', 'Petit Moth'], ['Axe Raider']);
  const bi = place(e, 0, 'Big Insect');
  const moth = place(e, 0, 'Petit Moth');
  const cs = playTrap(e, 0, 'Corrosive Scales', { pick: ['Big Insect'] });
  check(cs?.equippedTo === bi!.uid, 'equipped to an Insect');
  endTurn(e);
  const axe = summon(e, 1, 'Axe Raider');
  check(e.atkOf(axe!) === 1600, 'the opponent Summons: a Scale Counter, -100 ATK');
  const ts = e.legalTargets(1, axe!).map((m) => m.uid);
  check(ts.includes(bi!.uid) && !ts.includes(moth!.uid), 'other Insects cannot be attacked');
}

section('Drop Off');
{
  const e = duel(['Drop Off'], ['Petit Moth', 'Axe Raider']);
  putST(e, 0, 'Drop Off');
  endTurn(e);
  const drawn = e.state.fx.normalDraw?.uid as number | undefined;
  summon(e, 1, 'Axe Raider', true, { respond: 'Drop Off' });
  check(drawn !== undefined && e.find(drawn)?.loc.zone === 'gy', 'the card the opponent drew for their normal draw is discarded');
}

section('Interdimensional Matter Transporter');
{
  const e = duel(['Interdimensional Matter Transporter', 'Axe Raider']);
  const axe = place(e, 0, 'Axe Raider');
  playTrap(e, 0, 'Interdimensional Matter Transporter', { pick: ['Axe Raider'] });
  check(zone(e, axe) === 'removed', 'a monster you control is banished');
  endTurn(e);
  check(zone(e, axe) === 'mz' && e.controller(axe!.uid) === 0, 'it returns in the End Phase');
}

section('Mischief of the Yokai');
{
  const e = duel(['Mischief of the Yokai', 'Axe Raider']);
  const axe = place(e, 0, 'Axe Raider');
  const y = playTrap(e, 0, 'Mischief of the Yokai');
  const yc = e.player(0).gy.find((c) => c.name === 'Mischief of the Yokai')!;
  check(levelOf(e, axe!) === 2 && !y, 'each face-up monster loses 2 Levels');
  check(!e.canUseGraveEffect(0, yc.uid), 'its GY effect cannot be used the turn it was sent there');
  toTurn3(e);
  e.apply({ type: 'GRAVE_EFFECT', player: 0, uid: yc.uid });
  settle(e);
  check(levelOf(e, axe!) === 3 && zone(e, yc) === 'removed', 'banished from the GY: 1 monster loses 1 Level');
}

section('Rainbow Life');
{
  const e = duel(['Rainbow Life']);
  playTrap(e, 0, 'Rainbow Life');
  e.damage(0, 500);
  check(e.player(0).lp === 4500, 'damage this turn is gained as LP instead');
}

section('Spikeshield with Chain');
{
  const e = duel(['Spikeshield with Chain', 'Petit Moth'], ['Axe Raider']);
  const moth = place(e, 0, 'Petit Moth', 'def');
  const axe = place(e, 1, 'Axe Raider');
  playTrap(e, 0, 'Spikeshield with Chain', { pick: ['Petit Moth'] });
  check(e.atkOf(moth!) === 800, 'the equipped monster gains 500 ATK');
  e.state.battle = { attacker: axe!.uid, target: moth!.uid };
  check(e.defOf(moth!) === 1000, 'attacked in Defense Position: it gains DEF equal to its ATK');
  e.state.battle = null;
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
process.exit(fails ? 1 : 0);
