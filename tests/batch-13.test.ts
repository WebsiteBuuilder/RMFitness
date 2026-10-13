// Speed Duel batch 13 (run: npx tsx tests/batch-13.test.ts): one targeted check per card that its main effect happens.
import { readFileSync } from 'node:fs';
import { getEffect } from '../src/eds/effects';
import { attrOf, levelOf } from '../src/eds/speed/helpers';
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

const eff = (name: string) => getEffect(name)!;
const toTurn3 = (e: Engine) => {
  endTurn(e);
  endTurn(e);
};
const fusion = (e: Engine, p: Pid, name: string, ...ans: Ans[]) => place(e, p, name, 'atk', true, ...ans);
const gy = (e: Engine, p: Pid, name: string) => {
  const c = grab(e, p, name);
  run(e, e.sendToGrave(c.uid, 'mill'));
  return c;
};

for (const c of JSON.parse(readFileSync('/tmp/claude-0/sd/agents/chunk13.json', 'utf8')) as { name: string }[]) {
  if (!getEffect(c.name)) check(false, `${c.name} has a script`);
}

// ======================= Effect Monsters =======================
section('Airorca');
{
  const e = duel(['Airorca', 'Great White'], ['Axe Raider']);
  const air = place(e, 0, 'Airorca');
  const axe = place(e, 1, 'Axe Raider');
  const gw = grab(e, 0, 'Great White');
  effect(e, 0, air, { pick: ['Great White'] }, { pick: ['Axe Raider'] });
  check(zone(e, gw) === 'removed' && zone(e, axe) === 'gy', 'banishes a Fish from the hand and destroys a face-up card');
  check(zone(e, air) === 'removed', 'then Airorca is banished');
  endTurn(e);
  check(zone(e, air) === 'removed', "it stays banished during the opponent's Standby Phase");
  endTurn(e);
  check(zone(e, air) === 'mz', 'it returns during its controller\'s next Standby Phase');
}

section('Ancient Gear Beast / Soldier / Ultimate Ancient Gear Golem');
{
  const e = duel(['Ancient Gear Soldier', 'Ancient Gear Beast'], ['Waboku', 'Mystical Space Typhoon'], ['Ultimate Ancient Gear Golem']);
  const beast = grab(e, 0, 'Ancient Gear Beast');
  check(e.summonBlocked(0, beast, 'special', 'hand') && !e.summonBlocked(0, beast, 'normal', 'hand'), 'Ancient Gear Beast cannot be Special Summoned');
  const ags = place(e, 0, 'Ancient Gear Soldier')!;
  const wab = putST(e, 1, 'Waboku');
  e.state.battle = { attacker: ags.uid, target: null };
  check(e.cardActivationLocked(1, wab) && !e.responsesFor(1, 'attack', { uid: ags.uid }).some((o) => o.uid === wab.uid), 'while it attacks, the opponent cannot activate Traps');
  check(!e.cardActivationLocked(0, wab), 'its controller still can');
  e.state.battle = null;
  check(!e.cardActivationLocked(1, wab), 'after the battle, the opponent can again');
  const golem = fusion(e, 0, 'Ultimate Ancient Gear Golem')!;
  e.state.battle = { attacker: golem.uid, target: null };
  const mst = putST(e, 1, 'Mystical Space Typhoon');
  check(e.cardActivationLocked(1, mst), 'Ultimate Ancient Gear Golem locks Spells while attacking');
  e.state.battle = null;
}
{
  const e = duel(['Ancient Gear Golem', 'Monster Reborn'], ['Basic Insect'], ['Ultimate Ancient Gear Golem']);
  gy(e, 0, 'Ancient Gear Golem');
  const golem = fusion(e, 0, 'Ultimate Ancient Gear Golem')!;
  kill(e, [golem], 0);
  check(zone(e, golem) === 'gy', 'Ultimate Ancient Gear Golem cannot be revived (Must be Fusion Summoned)');
  const ok = e.summonBlocked(0, golem, 'special', 'gy');
  check(ok, 'its Summoning condition blocks a Special Summon from the GY');
}
{
  const e = duel(['Ancient Gear Golem'], ['Basic Insect'], ['Ultimate Ancient Gear Golem']);
  gy(e, 0, 'Ancient Gear Golem');
  const golem = fusion(e, 0, 'Ultimate Ancient Gear Golem')!;
  check(e.effectOn(golem)?.piercing === true, 'Ultimate Ancient Gear Golem inflicts piercing damage');
  kill(e, [golem], 1, 'yes');
  check(e.monsters(0).some((m) => m.name === 'Ancient Gear Golem'), 'destroyed: it Special Summons "Ancient Gear Golem" from the GY');
}

section('Artifact Caduceus / Artifact Ignition');
{
  const e = duel(['Artifact Caduceus', 'Artifact Moralltach'], ['Mystical Space Typhoon']);
  const cad = grab(e, 0, 'Artifact Caduceus');
  check(e.canUseMonsterEffect(0, cad), 'it can be Set from the hand as a Spell');
  effect(e, 0, cad);
  check(zone(e, cad) === 'sz' && !e.fieldCard(cad.uid)!.faceUp, 'it is Set in the Spell & Trap Zone');
  endTurn(e);
  kill(e, [e.fieldCard(cad.uid)], 1, 'yes');
  check(zone(e, cad) === 'mz', "destroyed while Set during the opponent's turn: it is Special Summoned");
  gy(e, 0, 'Artifact Moralltach');
  const hand = e.player(0).hand.length;
  place(e, 0, 'Artifact Moralltach');
  check(e.player(0).hand.length === hand + 1, "an Artifact Special Summoned during the opponent's turn draws 1 card");
}
{
  const e = duel(['Artifact Ignition', 'Artifact Moralltach'], ['Waboku', 'Axe Raider']);
  const wab = putST(e, 1, 'Waboku');
  playSpell(e, 0, 'Artifact Ignition', { pick: ['Face-down card'] });
  const mor = e.player(0).sz.find((z) => z?.name === 'Artifact Moralltach');
  check(zone(e, wab) === 'gy' && !!mor && !mor.faceUp, 'destroys a Spell/Trap and Sets an "Artifact" monster from the Deck');
}
{
  const e = duel(['Artifact Ignition', 'Artifact Moralltach'], ['Axe Raider']);
  const ign = putST(e, 0, 'Artifact Ignition');
  kill(e, [ign], 1);
  endTurn(e);
  const axe = place(e, 1, 'Axe Raider')!;
  axe.placedTurn = -1;
  toBattle(e);
  check(e.state.phase === 'BP' && !e.canAttackWith(1, axe), 'destroyed by the opponent: they skip their next Battle Phase (no attacks)');
}

section('Blackwing - Calima the Haze');
{
  const synchro = [...new Set(DB.values())].find((c) => c.sub === 'Synchro')!.name;
  const e = duel(['Blackwing - Calima the Haze', synchro], ['Axe Raider']);
  const cal = gy(e, 0, 'Blackwing - Calima the Haze');
  const syn = gy(e, 0, synchro);
  endTurn(e);
  const axe = place(e, 1, 'Axe Raider')!;
  axe.placedTurn = -1;
  toBattle(e);
  attack(e, axe, null, { respond: 'Blackwing - Calima the Haze' }, { pick: [synchro] });
  check(zone(e, cal) === 'removed' && zone(e, syn) === 'mz', "during the opponent's Battle Phase: banish it to Special Summon a Synchro from the GY");
}

section('Chaos Nephthys');
{
  const e = duel(['Chaos Nephthys', 'Mystical Elf', 'Dark Magician'], ['Axe Raider', 'Celtic Guardian']);
  const neph = grab(e, 0, 'Chaos Nephthys');
  check(!e.canNormalSummon(0, neph) && e.summonBlocked(0, neph, 'special', 'hand'), 'it cannot be Normal Summoned or Special Summoned by another effect');
  gy(e, 0, 'Mystical Elf');
  gy(e, 0, 'Dark Magician');
  gy(e, 1, 'Celtic Guardian');
  gy(e, 1, 'Celtic Guardian');
  const axe = place(e, 1, 'Axe Raider');
  const axe2 = place(e, 1, 'Celtic Guardian');
  kill(e, [axe], 0, 'yes', 'yes', { pick: ['Celtic Guardian'] });
  check(zone(e, neph) === 'mz', 'a card destroyed by a card effect: it Special Summons itself from the hand');
  check(e.player(0).removed.length === 2, 'by banishing 1 LIGHT and 1 DARK monster from the GY');
  check(zone(e, axe2) === 'removed' && e.player(1).removed.length === 3, "its Summon banishes 1 card the opponent controls and 2 in their GY");
}

section('Cloudian - Nimbusman');
{
  const e = duel(['Cloudian - Nimbusman', 'Great White']);
  place(e, 0, 'Great White');
  const n = summon(e, 0, 'Cloudian - Nimbusman', true, { pick: ['Great White'] });
  check(!!n && n.tags?.fog === 1, 'Tribute Summoned with a WATER monster: 1 Fog Counter');
  check(!!n && e.atkOf(n) === 1500, '500 ATK for each Fog Counter on the field');
  check(!!n && e.shielded(n, 'battle'), 'cannot be destroyed by battle');
}

section('D.D. Scout Plane');
{
  const e = duel(['D.D. Scout Plane']);
  const p = place(e, 0, 'D.D. Scout Plane')!;
  e.banish(p.uid);
  endTurn(e);
  check(zone(e, p) === 'mz', 'banished this turn: it comes back during the End Phase');
}

section('Darkbishop Archfiend');
{
  const e = duel(['Darkbishop Archfiend'], ['Mystical Space Typhoon']);
  const db = place(e, 0, 'Darkbishop Archfiend')!;
  toTurn3(e);
  check(e.player(0).lp === 3500, 'pays 500 LP during each of its controller\'s Standby Phases');
  const mst = putST(e, 1, 'Mystical Space Typhoon');
  mst.faceUp = true;
  const link: any = { card: mst, loc: e.find(mst.uid)!.loc, player: 1, label: mst.name, negated: false, targetUid: db.uid };
  const q = eff('Darkbishop Archfiend').quick!;
  check(q.can(e, db, 0, 'spell', { link }), 'it can respond when an Archfiend is targeted by the opponent');
  e.roll = () => 3;
  run(e, q.run(e, db, 0, { card: db, loc: e.find(db.uid)!.loc, player: 0, label: '', negated: false, payload: { ctx: { link } } } as any));
  check(link.negated && zone(e, mst) === 'gy', 'a 3: the effect is negated and the card destroyed');
}

section('Djinn Disserere of Rituals');
{
  const e = duel(['Black Luster Ritual', 'Black Luster Soldier', 'Gaia The Fierce Knight', 'Djinn Disserere of Rituals']);
  const dj = gy(e, 0, 'Djinn Disserere of Rituals');
  grab(e, 0, 'Black Luster Soldier');
  grab(e, 0, 'Gaia The Fierce Knight');
  const bls = e.player(0).hand.find((c) => c.name === 'Black Luster Soldier')!;
  playSpell(e, 0, 'Black Luster Ritual', { pick: ['Gaia The Fierce Knight', 'Djinn Disserere of Rituals'] });
  check(zone(e, bls) === 'mz' && zone(e, dj) === 'removed', 'banished from the GY as a Ritual material');
  check(e.fieldCard(bls.uid)?.tags?.trapImmune === 1, 'the Ritual Monster is unaffected by Traps');
}

section('Enraged Battle Ox');
{
  const e = duel(['Enraged Battle Ox', 'Silver Fang'], ['Basic Insect']);
  place(e, 0, 'Enraged Battle Ox');
  const fang = place(e, 0, 'Silver Fang')!;
  place(e, 1, 'Basic Insect', 'def');
  toTurn3(e);
  toBattle(e);
  attack(e, fang, e.monsters(1)[0]);
  check(e.player(1).lp === 4000 - 500, 'a Beast attacking a Defense Position monster inflicts piercing damage');
}

section('Fairy Tail - Rella');
{
  const e = duel(['Fairy Tail - Rella', 'Pot of Greed', 'Axe of Despair'], ['Axe Raider', 'Mystical Space Typhoon']);
  const rella = place(e, 0, 'Fairy Tail - Rella')!;
  const axe = place(e, 1, 'Axe Raider')!;
  grab(e, 0, 'Pot of Greed');
  effect(e, 0, rella, { pick: ['Pot of Greed'] }, { pick: ['Axe of Despair'] });
  check(e.atkOf(rella) === 2850, 'discards a Spell to equip an Equip Spell from the Deck');
  const mst = grab(e, 1, 'Mystical Space Typhoon');
  e.event('activate', { uid: mst.uid, player: 1 });
  check(e.untargetable(axe) && !e.untargetable(rella), 'other monsters cannot be targeted by Spells');
  e.event('phase');
  check(!e.untargetable(axe), '...only Spells');
  endTurn(e);
  check(e.player(0).hand.some((c) => c.name === 'Axe of Despair'), 'the Equip Spell returns to the hand during the End Phase');
}

section('Fossil Dyna Pachycephalo');
{
  const e = duel(['Fossil Dyna Pachycephalo'], ['Axe Raider', 'Celtic Guardian']);
  summon(e, 0, 'Fossil Dyna Pachycephalo', false);
  const f = e.monsters(0)[0];
  f.placedTurn = -1;
  const axe = place(e, 1, 'Axe Raider');
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: f.uid });
  settle(e);
  check(zone(e, axe) === 'gy' && zone(e, f) === 'mz', 'flipped: destroys every Special Summoned monster');
  check(e.summonBlocked(1, 'Celtic Guardian', 'special') && e.summonBlocked(0, 'Celtic Guardian', 'special'), 'neither player can Special Summon');
}

section('Ghostrick Doll');
{
  const e = duel(['Ghostrick Doll', 'Ghostrick Doll', 'Ghostrick Doll'], ['Axe Raider']);
  const doll = grab(e, 0, 'Ghostrick Doll');
  check(!e.canNormalSummon(0, doll, true) && e.canNormalSummon(0, doll, false), 'cannot be Normal Summoned without a "Ghostrick" monster (it can be Set)');
  const d = place(e, 0, 'Ghostrick Doll', 'def', false)!;
  const axe = place(e, 1, 'Axe Raider')!;
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: d.uid });
  settle(e);
  endTurn(e, 'yes');
  check(!axe.faceUp && axe.pos === 'def' && !d.faceUp, 'flipped: during the End Phase every face-up monster turns face-down');
  check(e.monsters(0).length === 2 && e.monsters(0).every((m) => !m.faceUp), 'then a "Ghostrick" is Special Summoned from the Deck face-down');
}

section('Heavy Mech Support Platform / Roll Out!');
{
  const e = duel(['Heavy Mech Support Platform', 'Cyber Commander']);
  const hm = place(e, 0, 'Heavy Mech Support Platform')!;
  const host = place(e, 0, 'Cyber Commander')!;
  const atk = e.atkOf(host);
  effect(e, 0, hm, { pick: ['Cyber Commander'] });
  check(zone(e, hm) === 'sz' && e.atkOf(host) === atk + 500, 'equips itself to a Machine: +500 ATK');
  kill(e, [host], 1);
  check(zone(e, host) === 'mz' && zone(e, hm) === 'gy', 'it is destroyed instead of the equipped monster');
}
{
  const e = duel(['Heavy Mech Support Platform', 'Cyber Commander', 'Roll Out!']);
  const hm = gy(e, 0, 'Heavy Mech Support Platform');
  const host = place(e, 0, 'Cyber Commander')!;
  const atk = e.atkOf(host);
  playTrap(e, 0, 'Roll Out!');
  check(zone(e, hm) === 'sz' && e.fieldCard(hm.uid)?.equippedTo === host.uid && e.atkOf(host) === atk + 500, 'Roll Out! equips a Union monster from the GY');
}

section('Invader of Darkness / Mirage Dragon');
{
  const e = duel(['Invader of Darkness', 'Mirage Dragon'], ['Mystical Space Typhoon', 'Waboku', 'Pot of Greed']);
  place(e, 0, 'Invader of Darkness');
  const mst = putST(e, 1, 'Mystical Space Typhoon');
  const pot = grab(e, 1, 'Pot of Greed');
  check(e.cardActivationLocked(1, mst) && !e.cardActivationLocked(1, pot) && !e.cardActivationLocked(0, mst), 'Invader: the opponent cannot activate Quick-Play Spells');
  place(e, 0, 'Mirage Dragon');
  const wab = putST(e, 1, 'Waboku');
  check(!e.cardActivationLocked(1, wab), 'Mirage Dragon: Traps are fine outside the Battle Phase');
  e.state.phase = 'BP';
  check(e.cardActivationLocked(1, wab), 'Mirage Dragon: no Traps during the Battle Phase');
  e.state.phase = 'M1';
}

section('Magical Marionette');
{
  const e = duel(['Magical Marionette', 'Pot of Greed'], ['Axe Raider']);
  const mm = place(e, 0, 'Magical Marionette')!;
  playSpell(e, 0, 'Pot of Greed', { respond: 'Magical Marionette' });
  check(mm.counters === 1 && e.atkOf(mm) === 2200, 'a Spell activation places a Spell Counter (+200 ATK each)');
  mm.counters = 2;
  const axe = place(e, 1, 'Axe Raider');
  effect(e, 0, mm, { pick: ['Axe Raider'] });
  check(zone(e, axe) === 'gy' && mm.counters === 0, 'remove 2 counters: destroy a monster');
}

section('Manticore of Darkness');
{
  const e = duel(['Manticore of Darkness', 'Silver Fang']);
  const man = place(e, 0, 'Manticore of Darkness')!;
  const fang = place(e, 0, 'Silver Fang');
  kill(e, [man], 0);
  endTurn(e, 'yes', { pick: ['Silver Fang'] });
  check(zone(e, man) === 'mz' && zone(e, fang) === 'gy', 'End Phase of the turn it was sent to the GY: send a Beast to revive it');
}

section('Prickle Fairy');
{
  const e = duel(['Prickle Fairy', 'Basic Insect'], ['Axe Raider']);
  place(e, 0, 'Prickle Fairy', 'def');
  const bug = place(e, 0, 'Basic Insect')!;
  endTurn(e);
  const axe = place(e, 1, 'Axe Raider')!;
  axe.placedTurn = -1;
  check(!e.legalTargets(1, axe).some((t) => t.uid === bug.uid), 'the opponent cannot attack Insect monsters');
  toBattle(e);
  attack(e, axe, e.monsters(0).find((m) => m.name === 'Prickle Fairy')!);
  check(axe.pos === 'def', 'after battling it, that monster changes to Defense Position');
}

section('Risebell the Star Psycher');
{
  const e = duel(['Risebell the Star Psycher', 'Axe Raider']);
  place(e, 0, 'Risebell the Star Psycher');
  const axe = place(e, 0, 'Axe Raider')!;
  const rb = e.monsters(0)[0];
  e.apply({ type: 'QUICK_EFFECT', player: 0, uid: rb.uid });
  settle(e, { pick: ['Axe Raider'] });
  check(levelOf(e, axe) === 5, "increases a monster's Level by 1");
}

section('Super-Ancient Dinobeast');
{
  const e = duel(['Super-Ancient Dinobeast', 'Two-Headed King Rex', 'Mad Sword Beast']);
  place(e, 0, 'Two-Headed King Rex');
  const sad = summon(e, 0, 'Super-Ancient Dinobeast', true, { pick: ['Two-Headed King Rex'] });
  check(!!sad && sad.faceUp, 'Tribute Summoned with only 1 Dinosaur');
  gy(e, 0, 'Mad Sword Beast');
  const hand = e.player(0).hand.length;
  place(e, 0, 'Mad Sword Beast', 'atk', true, 'yes');
  check(e.player(0).hand.length === hand + 1, 'a Dinosaur Special Summoned from the GY: draw 1 card');
}

section('Twin-Headed Behemoth');
{
  const e = duel(['Twin-Headed Behemoth']);
  const b = place(e, 0, 'Twin-Headed Behemoth')!;
  kill(e, [b], 0);
  endTurn(e, 'yes');
  const m = e.fieldCard(b.uid);
  check(!!m && e.atkOf(m) === 1000 && e.defOf(m) === 1000, 'destroyed this turn: it comes back in the End Phase as a 1000/1000');
}

section('Voltic Kong');
{
  const e = duel(['Voltic Kong', 'Mystical Elf']);
  const vk = place(e, 0, 'Voltic Kong')!;
  place(e, 0, 'Mystical Elf');
  toTurn3(e);
  toBattle(e);
  const before = e.player(1).gy.length;
  attack(e, vk, null);
  check(e.player(1).gy.length === before + 2, 'battle damage: mills 1 card per face-up LIGHT monster (2)');
}

section('Performapal Dag Daggerman / Abyss Actors Back Stage');
check(!!getEffect('Performapal Dag Daggerman') && !!getEffect('Abyss Actors Back Stage'), 'scripted (their effects need Pendulum Zones)');

// ======================= Fusion Monsters =======================
section('Barbaroid, the Ultimate Battle Machine');
{
  const e = duel([], ['Axe Raider', 'Celtic Guardian'], ['Barbaroid, the Ultimate Battle Machine']);
  const b = fusion(e, 0, 'Barbaroid, the Ultimate Battle Machine')!;
  toTurn3(e);
  toBattle(e);
  check(!e.canAttackWith(0, b), 'cannot attack directly');
  const axe = place(e, 1, 'Axe Raider')!;
  place(e, 1, 'Celtic Guardian');
  attack(e, b, axe);
  check(e.player(1).lp === 4000 - 2300 - 1000, 'destroys a monster by battle: 1000 extra damage');
  check(e.canAttackWith(0, b), 'it can make a second attack');
}

section('Cyberse Desavewurm');
{
  const cy = [...new Set(DB.values())].find((c) => c.race === 'Cyberse' && c.kind === 'monster' && c.sub === 'Effect' && (c.level ?? 0) > 0)!;
  const e = duel([cy.name], [], ['Cyberse Desavewurm']);
  const w = fusion(e, 0, 'Cyberse Desavewurm')!;
  grab(e, 0, cy.name);
  effect(e, 0, w, { pick: [cy.name] }, 'yes');
  check(e.monsters(0).some((m) => m.name === cy.name), 'Special Summons a Cyberse monster from the hand');
  check(levelOf(e, w) === cy.level, "then its Level becomes that monster's");
}

section('Elemental HERO Brave Neos');
{
  const e = duel(['Neo-Spacian Air Hummingbird', 'Elemental HERO Avian', 'Contact Gate'], ['Axe Raider'], ['Elemental HERO Brave Neos']);
  gy(e, 0, 'Neo-Spacian Air Hummingbird');
  gy(e, 0, 'Elemental HERO Avian');
  const n = fusion(e, 0, 'Elemental HERO Brave Neos')!;
  check(e.atkOf(n) === 2700, '+100 ATK per Neo-Spacian / HERO in the GY');
  const axe = place(e, 1, 'Axe Raider')!;
  toTurn3(e);
  toBattle(e);
  attack(e, n, axe, 'yes');
  check(e.player(0).hand.some((c) => c.name === 'Contact Gate'), 'destroys a monster by battle: adds a card that lists "Elemental HERO Neos"');
}

section('Elemental HERO Storm Neos');
{
  const e = duel([], ['Axe Raider', 'Waboku'], ['Elemental HERO Storm Neos']);
  const n = fusion(e, 0, 'Elemental HERO Storm Neos')!;
  const wab = putST(e, 1, 'Waboku');
  const axe = place(e, 1, 'Axe Raider');
  effect(e, 0, n);
  check(zone(e, wab) === 'gy', 'destroys all Spells and Traps on the field');
  endTurn(e);
  check(zone(e, n) === 'fusion' && e.find(axe!.uid)?.loc.player === 1 && ['deck', 'hand'].includes(zone(e, axe)!), 'End Phase: back to the Extra Deck, and all cards on the field into the Deck');
}

section('Ojama King');
{
  const e = duel([], [], ['Ojama King']);
  fusion(e, 0, 'Ojama King');
  check(e.summonBlocked(1, 'Axe Raider', 'normal') && e.summonBlocked(1, 'Axe Raider', 'special') && !e.summonBlocked(0, 'Axe Raider', 'normal'), "the opponent's Monster Zones cannot be used");
}

// ======================= Spells =======================
section('Amplifier');
{
  const e = duel(['Jinzo', 'Amplifier']);
  const j = place(e, 0, 'Jinzo')!;
  const amp = playSpell(e, 0, 'Amplifier');
  check(!e.trapsSealed(0) && e.trapsSealed(1), "Jinzo no longer stops its controller's Traps");
  kill(e, [amp]);
  check(zone(e, j) === 'gy', 'Amplifier leaves the field: Jinzo is destroyed');
}

section('Advanced Dark');
{
  const e = duel(['Advanced Dark', 'Crystal Beast Ruby Carbuncle', 'Crystal Beast Amber Mammoth'], ['Axe Raider']);
  playSpell(e, 0, 'Advanced Dark');
  const rc = place(e, 0, 'Crystal Beast Ruby Carbuncle')!;
  check(attrOf(e, rc) === 'DARK', '"Crystal Beast" monsters become DARK');
  endTurn(e);
  const axe = place(e, 1, 'Axe Raider')!;
  axe.placedTurn = -1;
  toBattle(e);
  attack(e, axe, rc, { respond: 'Advanced Dark' }, { pick: ['Crystal Beast Amber Mammoth'] });
  check(e.player(0).lp === 4000, 'send a "Crystal Beast" from the Deck: no battle damage');
}

section('Necrovalley');
{
  const e = duel(['Necrovalley', "Gravekeeper's Spy", 'Monster Reborn', 'Axe Raider']);
  playSpell(e, 0, 'Necrovalley');
  const spy = place(e, 0, "Gravekeeper's Spy")!;
  check(e.atkOf(spy) === 1700, '"Gravekeeper\'s" monsters gain 500 ATK');
  const axe = gy(e, 0, 'Axe Raider');
  e.banish(axe.uid);
  run(e, e.specialSummon(axe.uid, 0, 'atk'));
  e.toHand(axe.uid);
  check(zone(e, axe) === 'gy', 'cards in the GY cannot be banished, Special Summoned or returned');
}

section('Big Evolution Pill');
{
  const e = duel(['Big Evolution Pill', 'Two-Headed King Rex', 'Black Tyranno']);
  place(e, 0, 'Two-Headed King Rex');
  const pill = playSpell(e, 0, 'Big Evolution Pill', { pick: ['Two-Headed King Rex'] });
  check(!!pill && zone(e, pill) === 'sz' && e.monsters(0).length === 0, 'Tributes a Dinosaur and stays on the field');
  const t = summon(e, 0, 'Black Tyranno');
  check(!!t && t.faceUp, 'a Level 5+ Dinosaur is Normal Summoned without Tributes');
  for (let i = 0; i < 5; i++) endTurn(e);
  check(zone(e, pill) === 'sz', 'still there after 2 opponent End Phases');
  endTurn(e);
  check(zone(e, pill) === 'gy', "destroyed during the opponent's 3rd End Phase");
}

section('Cost Down');
{
  const e = duel(['Cost Down', 'Gaia The Fierce Knight', 'Axe Raider', 'Pot of Greed']);
  const gaia = grab(e, 0, 'Gaia The Fierce Knight');
  grab(e, 0, 'Pot of Greed');
  place(e, 0, 'Axe Raider');
  playSpell(e, 0, 'Cost Down', { pick: ['Pot of Greed'] });
  check(e.tributePlan(0, gaia, true).need === 1 && levelOf(e, gaia) === 5, 'monsters in the hand are 2 Levels lower: Gaia needs 1 Tribute');
  summon(e, 0, 'Gaia The Fierce Knight', true, { pick: ['Axe Raider'] });
  check(zone(e, gaia) === 'mz' && levelOf(e, e.fieldCard(gaia.uid)!) === 5, 'Tribute Summoned with 1 Tribute, still Level 5 this turn');
}

section('Gotterdammerung / Solemn Authority');
{
  const e = duel(['Gotterdammerung', 'Axe Raider']);
  const g = grab(e, 0, 'Gotterdammerung');
  check(!e.canActivateMain(0, g.uid), 'needs an "Aesir" monster');
  const axe = place(e, 0, 'Axe Raider')!;
  run(e, eff('Gotterdammerung').resolve!(e, { card: g, targetUid: axe.uid, player: 0 } as any, 0));
  check(e.controller(axe.uid) === 1 && axe.doomAt === 2, "the monster goes to the opponent and is destroyed in their next End Phase");
  check(!!getEffect('Solemn Authority') && !eff('Solemn Authority').canActivate!(e, g, 0, 'main', {}), 'Solemn Authority needs an "Aesir" monster too');
}

section('Star Light, Star Bright');
{
  const e = duel(['Star Light, Star Bright', 'Summoned Skull', 'Dark Magician']);
  place(e, 0, 'Summoned Skull');
  const dm = place(e, 0, 'Dark Magician')!;
  playSpell(e, 0, 'Star Light, Star Bright', { pick: ['Summoned Skull'] });
  check(levelOf(e, dm) === 6, 'a monster with the same ATK becomes the same Level');
  endTurn(e);
  check(levelOf(e, dm) === 7, 'until the End Phase');
}

section('Rank-Up-Magic Quick Chaos / Planckton');
{
  const e = duel(['Rank-Up-Magic Quick Chaos', 'Number 49: Fortune Tune', 'Number 103: Ragnazero', 'Planckton']);
  const r = grab(e, 0, 'Rank-Up-Magic Quick Chaos');
  const n49 = place(e, 0, 'Number 49: Fortune Tune')!;
  const n103 = place(e, 0, 'Number 103: Ragnazero')!;
  check(!e.canActivateMain(0, r.uid), 'Quick Chaos needs a matching "Number C" monster in the Extra Deck');
  const a = e.atkOf(n49);
  playTrap(e, 0, 'Planckton');
  check(e.atkOf(n49) === a + 500 && n103.tags?.noAttackTurn === e.state.turn, 'Planckton: Rank 3 Xyz +500, Rank 4 Xyz cannot attack');
}

// ======================= Traps =======================
section('Breakthrough!');
{
  const e = duel(['Grandmaster of the Six Samurai', 'Breakthrough!'], ['Axe Raider', 'Celtic Guardian']);
  const gm = place(e, 0, 'Grandmaster of the Six Samurai')!;
  toTurn3(e);
  const axe = place(e, 1, 'Axe Raider')!;
  place(e, 1, 'Celtic Guardian');
  playTrap(e, 0, 'Breakthrough!');
  toBattle(e);
  attack(e, gm, axe);
  check(zone(e, axe) === 'gy' && e.canAttackDirectly(gm), 'the selected Six Samurai destroyed a monster: the Six Samurai can attack directly');
}

section('Darklight');
{
  const e = duel(['Darklight', 'Archfiend Soldier'], ['Axe Raider', 'Celtic Guardian']);
  const af = place(e, 0, 'Archfiend Soldier')!;
  af.tags = {};
  const axe = place(e, 1, 'Axe Raider');
  const cg = place(e, 1, 'Celtic Guardian')!;
  cg.tags = {};
  playTrap(e, 0, 'Darklight', { pick: ['Archfiend Soldier'] });
  check(zone(e, af) === 'gy' && zone(e, axe) === 'gy' && zone(e, cg) === 'mz', 'Tributes a DARK monster: destroys the monsters Special Summoned this turn');
}

section('Hero Ring');
{
  const e = duel(['Hero Ring', 'Celtic Guardian'], ['Summoned Skull', 'Axe Raider']);
  const cg = place(e, 0, 'Celtic Guardian')!;
  playTrap(e, 0, 'Hero Ring');
  const sk = place(e, 1, 'Summoned Skull')!;
  const axe = place(e, 1, 'Axe Raider')!;
  check(!e.legalTargets(1, sk).some((t) => t.uid === cg.uid) && e.legalTargets(1, axe).some((t) => t.uid === cg.uid), 'monsters with 1900+ ATK cannot attack the equipped Warrior');
}

section('Magnet Force');
{
  const e = duel(['Magnet Force', 'Beta The Magnet Warrior'], ['Axe Raider']);
  const beta = place(e, 0, 'Beta The Magnet Warrior')!;
  const axe = place(e, 1, 'Axe Raider')!;
  playTrap(e, 0, 'Magnet Force');
  check(beta.tags?.unaffTurn === e.state.turn, 'Machine/Rock monsters are marked for this turn');
  (e as any).levelSource = axe.uid;
  e.actor = 1;
  check(e.shielded(beta, 'effect') && e.untargetable(beta), "unaffected by the opponent's monster effects");
  (e as any).levelSource = null;
  check(!e.shielded(beta, 'effect'), 'but not by Spells/Traps or game actions');
  e.actor = null;
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
process.exit(fails ? 1 : 0);
