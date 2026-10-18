// Speed Duel card scripts of batch 23 (run: npx tsx tests/batch-23.test.ts)
// One targeted check per scripted card (and per corrected EDS script): its main effect really happens in a duel.
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
const lp = (e: Engine, p: Pid) => e.player(p).lp;
const atk = (e: Engine, c: FieldCard | null) => (c ? e.atkOf(c) : -1);
const RA = 'The Winged Dragon of Ra';
const SPHERE = 'The Winged Dragon of Ra - Sphere Mode';
const PHOENIX = 'The Winged Dragon of Ra - Immortal Phoenix';
const inHand = (e: Engine, p: Pid, name: string) => e.player(p).hand.some((c) => c.name === name);
const inGy = (e: Engine, p: Pid, name: string) => e.player(p).gy.some((c) => c.name === name);
const onField = (e: Engine, p: Pid, name: string) => e.monsters(p).find((m) => m.name === name) ?? null;
/** Special Summons a card that cannot normally be Special Summoned (test setup only). */
function force(e: Engine, p: Pid, name: string, pos: Pos = 'atk'): FieldCard | null {
  const c = [...e.player(p).deck, ...e.player(p).hand, ...e.player(p).gy].find((x) => x.name === name)!;
  e.state.fx.ignoreCond = c.uid;
  const f = place(e, p, name, pos);
  e.state.fx.ignoreCond = undefined;
  return f;
}
const toGy = (e: Engine, p: Pid, name: string) => {
  const c = grab(e, p, name);
  run(e, e.sendToGrave(c.uid, 'cost'));
  return c;
};

section('Swarm of Centipedes');
{
  const e = duel(['Swarm of Centipedes'], [FILL]);
  const s = place(e, 0, 'Swarm of Centipedes', 'def', false)!;
  const foe = place(e, 1, FILL)!;
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: s.uid });
  settle(e, 'yes', { pick: [FILL] });
  check(!foe.faceUp && foe.pos === 'def', 'Swarm of Centipedes: flipped face-up, changes another monster to face-down Defense Position');
  e.apply({ type: 'CHANGE_POS', player: 0, uid: s.uid }); // no-op (it changed position this turn already)
  settle(e);
  effect(e, 0, s);
  check(!e.fieldCard(s.uid)!.faceUp && e.fieldCard(s.uid)!.pos === 'def', 'Swarm of Centipedes: changes itself to face-down Defense Position');
}

section('Sword of Kusanagi');
{
  const e = duel(['Asura Priest', 'Sword of Kusanagi'], [FILL], [], [], 1);
  place(e, 1, FILL, 'def');
  endTurn(e);
  const asura = summon(e, 0, 'Asura Priest')!;
  const sw = playSpell(e, 0, 'Sword of Kusanagi');
  check(sw?.equippedTo === asura.uid, 'Sword of Kusanagi: equipped to a Spirit monster');
  toBattle(e);
  attack(e, asura, e.monsters(1)[0]);
  check(lp(e, 1) === 4000 - (1700 - 1200), 'Sword of Kusanagi: attacking a weaker Defense Position monster inflicts the difference');
  endTurn(e);
  check(inHand(e, 0, 'Asura Priest') && inHand(e, 0, 'Sword of Kusanagi'), 'Sword of Kusanagi: returns to the hand with the Spirit monster it equipped');
}

section('The Winged Dragon of Ra - Sphere Mode');
{
  const e = duel([SPHERE, RA], [FILL, FILL, FILL]);
  for (let i = 0; i < 3; i++) place(e, 1, FILL);
  const sp = grab(e, 0, SPHERE);
  effect(e, 0, sp, { pick: [FILL, FILL, FILL] });
  const m = e.fieldCard(sp.uid);
  check(!!m && e.controller(sp.uid) === 1 && e.monsters(1).length === 1, "Sphere Mode: Normal Summoned to the opponent's field by Tributing 3 of their monsters");
  const prev = (e as any).actor;
  (e as any).actor = 0;
  check(!!m && e.untargetable(m), "Sphere Mode: its controller's opponent cannot target it");
  (e as any).actor = prev;
  endTurn(e);
  check(e.controller(sp.uid) === 1, 'Sphere Mode: still on the opponent\'s side during their turn');
  endTurn(e);
  check(e.controller(sp.uid) === 0, 'Sphere Mode: control shifted back to its owner in the End Phase of the next turn');
  effect(e, 0, e.fieldCard(sp.uid));
  const ra = onField(e, 0, RA);
  check(zone(e, sp) === 'gy' && !!ra && atk(e, ra) === 4000 && e.defOf(ra) === 4000, 'Sphere Mode: Tributed to Special Summon Ra from the Deck with 4000 ATK/DEF');
}
{
  const e = duel([SPHERE, FILL, FILL, FILL]);
  for (let i = 0; i < 3; i++) place(e, 0, FILL);
  const m = summon(e, 0, SPHERE, true, { pick: [FILL, FILL, FILL] });
  const foe = place(e, 1, 'Celtic Guardian');
  check(!!m && e.controller(m.uid) === 0 && !!foe && !e.canAttackWith(0, m), 'Sphere Mode: Normal Summoned to its own side with 3 Tributes; it cannot attack');
}

section('The Winged Dragon of Ra - Immortal Phoenix');
{
  const e = duel([PHOENIX, RA, SPHERE], [FILL, FILL]);
  toGy(e, 0, PHOENIX);
  const ra = force(e, 0, RA)!;
  check(!!ra, 'Immortal Phoenix: setup, Ra on the field and the Phoenix in the GY');
  kill(e, [ra], 1);
  const ph = onField(e, 0, PHOENIX);
  check(!!ph && atk(e, ph) === 4000, 'Immortal Phoenix: Special Summoned when Ra is sent from the field to the GY');
  kill(e, [ph], 1);
  check(!!e.fieldCard(ph!.uid), "Immortal Phoenix: unaffected by other cards' effects (not destroyed)");
  const foe = place(e, 1, FILL)!;
  effect(e, 0, ph, { pick: [FILL] });
  check(zone(e, foe) === 'gy' && lp(e, 0) === 3000, 'Immortal Phoenix: pays 1000 LP to send a monster on the field to the GY');
  endTurn(e);
  check(zone(e, ph) === 'gy' && !!onField(e, 0, SPHERE), 'Immortal Phoenix: in the End Phase it goes to the GY and Sphere Mode is Special Summoned from the Deck');
}

section('Thunder Ball');
{
  const e = duel(['Thunder Ball'], [FILL], [], [], 1);
  place(e, 1, FILL, 'def');
  endTurn(e);
  const a = place(e, 0, 'Celtic Guardian')!;
  const tb = grab(e, 0, 'Thunder Ball');
  toBattle(e);
  attack(e, a, e.monsters(1)[0], 'yes', 'yes');
  check(zone(e, tb) === 'mz', 'Thunder Ball: Special Summoned from the hand at the end of the Damage Step');
}
{
  const e = duel(['Thunder Ball', 'Trap Hole'], [FILL, FILL, FILL]);
  const tb = place(e, 0, 'Thunder Ball')!;
  const foes = [place(e, 1, FILL)!, place(e, 1, FILL)!, place(e, 1, FILL)!];
  const th = grab(e, 0, 'Trap Hole');
  effect(e, 0, tb, { pick: ['Trap Hole'] });
  check(zone(e, th) === 'gy' && zone(e, foes[2]) === 'gy' && zone(e, foes[0]) === 'mz' && zone(e, foes[1]) === 'mz', "Thunder Ball: sends a Trap to the GY to destroy the monster in its column");
  e.state.fx.fixedRoll = { p: 0, die: 6 };
  kill(e, [tb], 1, 'yes', { pick: ['Trap Hole'] });
  check(inHand(e, 0, 'Trap Hole'), 'Thunder Ball: destroyed, rolls a 6 and adds the targeted card from the GY');
}

section('Thunderspeed Summon');
{
  const e = duel([RA, 'Thunderspeed Summon', FILL, FILL, FILL]);
  for (let i = 0; i < 3; i++) place(e, 0, FILL);
  grab(e, 0, RA);
  playSpell(e, 0, 'Thunderspeed Summon', { pick: [RA] }, { pick: [FILL, FILL, FILL] });
  check(!!onField(e, 0, RA), 'Thunderspeed Summon: Normal Summons a Level 10 monster right away');
}
{
  const e = duel([RA, 'Thunderspeed Summon', "Queen's Knight", "King's Knight", "Jack's Knight"]);
  place(e, 0, "Queen's Knight");
  place(e, 0, "King's Knight");
  place(e, 0, "Jack's Knight");
  playSpell(e, 0, 'Thunderspeed Summon', 'yes', { pick: [RA] }, { pick: ["Queen's Knight", "King's Knight", "Jack's Knight"] });
  check(!!onField(e, 0, RA) && e.player(0).deck.every((c) => c.name !== RA), 'Thunderspeed Summon: with the 3 Knights, adds Ra from the Deck and Normal Summons it');
}

section('Tiki Curse');
{
  const e = duel(['Tiki Curse', 'Tiki Soul'], [FILL], [], [], 1);
  const foe = place(e, 1, FILL, 'def')!;
  endTurn(e);
  const curse = playTrap(e, 0, 'Tiki Curse', 'yes');
  const soul = playTrap(e, 0, 'Tiki Soul', 'yes');
  check(zone(e, curse) === 'mz' && atk(e, curse) === 1800 && zone(e, soul) === 'mz' && atk(e, soul) === 1000, 'Tiki Curse / Tiki Soul: Special Summoned as monsters (1800 / 1000 ATK)');
  toBattle(e);
  attack(e, e.fieldCard(soul!.uid), foe);
  check(zone(e, foe) === 'gy' && zone(e, soul) === 'mz', "Tiki Curse: another Trap monster battled; the opponent's monster is destroyed after damage calculation");
}

section('Tiki Soul');
{
  const e = duel(['Tiki Curse', 'Tiki Soul']);
  const curse = playTrap(e, 0, 'Tiki Curse', 'yes');
  playTrap(e, 0, 'Tiki Soul', 'yes');
  kill(e, [e.fieldCard(curse!.uid)], 1, 'yes');
  const c = e.fieldCard(curse!.uid);
  check(zone(e, curse) === 'sz' && !!c && !c.faceUp, "Tiki Soul: a Trap monster destroyed by the opponent's card is Set in the Spell & Trap Zone instead");
}

section('Trade-In');
{
  const e = duel(['Blue-Eyes White Dragon', 'Trade-In']);
  grab(e, 0, 'Blue-Eyes White Dragon');
  const n = e.player(0).hand.length;
  playSpell(e, 0, 'Trade-In', { pick: ['Blue-Eyes White Dragon'] });
  check(inGy(e, 0, 'Blue-Eyes White Dragon') && e.player(0).hand.length === n + 1, 'Trade-In: discards a Level 8 monster and draws 2');
}

section('Trap Hole of Spikes');
{
  const e = duel(['Trap Hole of Spikes'], ['Blue-Eyes White Dragon']);
  putST(e, 0, 'Trap Hole of Spikes');
  endTurn(e);
  const b = place(e, 1, 'Blue-Eyes White Dragon')!;
  toBattle(e);
  attack(e, b, null, { respond: 'Trap Hole of Spikes' });
  check(zone(e, b) === 'gy' && lp(e, 1) === 4000 - 1500 && lp(e, 0) === 4000, 'Trap Hole of Spikes: destroys the monster Summoned this turn that attacks and inflicts half its original ATK');
}

section('Tribe-Infecting Virus');
{
  const e = duel(['Tribe-Infecting Virus', 'Trap Hole'], [FILL, 'Blue-Eyes White Dragon']);
  const v = place(e, 0, 'Tribe-Infecting Virus')!;
  const w = place(e, 1, FILL)!;
  const d = place(e, 1, 'Blue-Eyes White Dragon')!;
  grab(e, 0, 'Trap Hole');
  effect(e, 0, v, { pick: ['Trap Hole'] }, { pick: ['Warrior'] });
  check(inGy(e, 0, 'Trap Hole') && zone(e, w) === 'gy' && zone(e, d) === 'mz' && zone(e, v) === 'mz', 'Tribe-Infecting Virus: discards 1 card and destroys every face-up monster of the declared Type');
}

section('Valkyrian Knight');
{
  const e = duel(['Valkyrian Knight', 'Gaia The Fierce Knight'], ['Blue-Eyes White Dragon']);
  const vk = place(e, 0, 'Valkyrian Knight')!;
  const cg = place(e, 0, FILL)!;
  toGy(e, 0, 'Gaia The Fierce Knight');
  toGy(e, 0, FILL);
  endTurn(e);
  const b = place(e, 1, 'Blue-Eyes White Dragon')!;
  toBattle(e);
  const legal = e.legalTargets(1, b).map((m) => m.uid);
  check(legal.length === 1 && legal[0] === vk.uid && !legal.includes(cg.uid), 'Valkyrian Knight: the opponent cannot attack other face-up Warriors');
  attack(e, b, vk, 'yes', { pick: [FILL] }, { pick: ['Gaia The Fierce Knight'] });
  check(zone(e, vk) === 'removed' && !!onField(e, 0, 'Gaia The Fierce Knight'), 'Valkyrian Knight: destroyed by battle, banishes itself and a Warrior to revive a Level 5+ Warrior');
}

section('Winged Minion');
{
  const e = duel(['Winged Minion', 'Dark Chimera']);
  const wm = place(e, 0, 'Winged Minion')!;
  const f = place(e, 0, 'Dark Chimera')!;
  effect(e, 0, wm, { pick: ['Dark Chimera'] });
  check(zone(e, wm) === 'gy' && atk(e, f) === 1610 + 700 && e.defOf(f) === 1460 + 700, 'Winged Minion: Tributed, a Fiend gains 700 ATK/DEF');
}

// ---------- older EDS scripts checked against their Speed Duel text ----------
section('Flying Kamakiri #1');
{
  const e = duel(['Flying Kamakiri #1', 'Baby Dragon'], ['Blue-Eyes White Dragon']);
  const k = place(e, 0, 'Flying Kamakiri #1')!;
  endTurn(e);
  const b = place(e, 1, 'Blue-Eyes White Dragon')!;
  toBattle(e);
  attack(e, b, k, { pick: ['Baby Dragon'] });
  const baby = onField(e, 0, 'Baby Dragon');
  check(zone(e, k) === 'gy' && !!baby && baby.pos === 'atk', 'Flying Kamakiri #1: destroyed by battle, Special Summons a WIND monster with 1500 or less ATK in Attack Position');
}

section('Shining Angel');
{
  const e = duel(['Shining Angel', 'Helios - The Primordial Sun'], ['Blue-Eyes White Dragon']);
  const s = place(e, 0, 'Shining Angel')!;
  endTurn(e);
  const b = place(e, 1, 'Blue-Eyes White Dragon')!;
  toBattle(e);
  attack(e, b, s);
  check(zone(e, s) === 'gy' && !onField(e, 0, 'Helios - The Primordial Sun'), 'Shining Angel: a "?" ATK LIGHT monster does not count as 1500 or less ATK');
}
{
  const e = duel(['Shining Angel', 'Happy Lover'], ['Blue-Eyes White Dragon']);
  const s = place(e, 0, 'Shining Angel')!;
  endTurn(e);
  const b = place(e, 1, 'Blue-Eyes White Dragon')!;
  toBattle(e);
  attack(e, b, s, { pick: ['Happy Lover'] });
  check(!!onField(e, 0, 'Happy Lover'), 'Shining Angel: destroyed by battle, Special Summons a LIGHT monster with 1500 or less ATK');
}

section('Remove Trap');
{
  const e = duel(['Remove Trap'], ['Royal Decree']);
  const rd = putST(e, 1, 'Royal Decree');
  rd.faceUp = true;
  rd.active = true;
  playSpell(e, 0, 'Remove Trap', { pick: ['Royal Decree'] });
  check(zone(e, rd) === 'gy', 'Remove Trap: destroys a face-up Trap Card');
}

section('Sangan');
{
  const e = duel(['Sangan', 'Sangan', RA, 'Happy Lover', 'Bio Plant']);
  const s = place(e, 0, 'Sangan')!;
  kill(e, [s], 1, { pick: ['Happy Lover'] });
  const hl = e.player(0).hand.find((c) => c.name === 'Happy Lover');
  check(!!hl && !inHand(e, 0, RA), 'Sangan: adds a monster with 1500 or less ATK ("?" ATK Ra is not one)');
  check(!!hl && e.activationBlocked(0, hl), 'Sangan: cards with that name cannot be activated this turn');
  const s2 = place(e, 0, 'Sangan')!;
  const n = e.player(0).hand.length;
  kill(e, [s2], 1);
  check(e.player(0).hand.length === n, 'Sangan: only once per turn');
}

section('Witch of the Black Forest');
{
  const e = duel(['Witch of the Black Forest', RA, 'Happy Lover']);
  const w = place(e, 0, 'Witch of the Black Forest')!;
  kill(e, [w], 1, { pick: ['Happy Lover'] });
  const hl = e.player(0).hand.find((c) => c.name === 'Happy Lover');
  check(!!hl && !inHand(e, 0, RA) && e.activationBlocked(0, hl), 'Witch of the Black Forest: adds a monster with 1500 or less DEF ("?" DEF is not one); that name is locked this turn');
}

section('Swords of Revealing Light');
{
  const e = duel(['Swords of Revealing Light'], [FILL]);
  const fd = place(e, 1, FILL, 'def', false)!;
  const sw = playSpell(e, 0, 'Swords of Revealing Light');
  check(fd.faceUp && active(e, sw), "Swords of Revealing Light: flips the opponent's face-down monsters face-up and stays on the field");
  endTurn(e);
  toBattle(e);
  check(!e.canAttackWith(1, e.fieldCard(fd.uid)!), "Swords of Revealing Light: the opponent's monsters cannot declare an attack");
  for (let i = 0; i < 4; i++) endTurn(e);
  check(zone(e, sw) === 'sz', 'Swords of Revealing Light: still there before the End Phase of the 3rd opposing turn');
  const at = e.state.log.length;
  endTurn(e);
  check(zone(e, sw) === 'gy' && logHas(e, 'Swords of Revealing Light is destroyed', at), "Swords of Revealing Light: destroyed in the End Phase of the opponent's 3rd turn");
}

section('Total Defense Shogun');
{
  const e = duel(['Total Defense Shogun'], [FILL], [], [], 1);
  const foe = place(e, 1, FILL)!;
  endTurn(e);
  place(e, 0, FILL);
  const s = summon(e, 0, 'Total Defense Shogun', true, { pick: [FILL] });
  check(!!s && s.pos === 'def', 'Total Defense Shogun: changed to Defense Position when Normal Summoned');
  toBattle(e);
  attack(e, s, foe);
  check(zone(e, foe) === 'gy' && lp(e, 1) === 4000 - (1550 - 1400), 'Total Defense Shogun: attacks from Defense Position using its ATK');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
process.exit(fails ? 1 : 0);
