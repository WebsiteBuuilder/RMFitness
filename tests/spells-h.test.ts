// Group H audit: Speed Duel Spell/Trap scripts in src/eds/speed/cards-12..16, checked card by card in real duels (run: npx tsx tests/spells-h.test.ts)
import { Engine } from '../src/eds/engine';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';
import { attrOf, levelOf } from '../src/eds/speed/helpers';
import type { CardInfo } from '../src/eds/types';

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
const toTurnOf = (e: Engine, p: Pid, ...ans: Ans[]) => {
  for (let i = 0; i < 3 && e.state.turnPlayer !== p; i++) endTurn(e, ...ans);
};
const lp = (e: Engine, p: Pid) => e.player(p).lp;
const fake = (info: Partial<CardInfo> & { name: string }) => {
  const full = { id: 970000 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
fake({ name: 'Thor, Test Aesir', level: 10, atk: 3500, def: 2800, race: 'Divine-Beast', attribute: 'DARK' });
fake({ name: 'Number 98: Test Wraith', sub: 'Xyz', rank: 4, level: undefined, atk: 2000, def: 2000, race: 'Fiend', attribute: 'DARK', desc: '2 Level 4 monsters' });
fake({ name: 'Number C98: Test Chaos Wraith', sub: 'Xyz', rank: 5, level: undefined, atk: 3000, def: 2500, race: 'Fiend', attribute: 'DARK', desc: '3 Level 5 monsters' });
fake({ name: 'Metalfoes Test Fusion', sub: 'Fusion', level: 6, atk: 2400, def: 1800, race: 'Psychic', attribute: 'FIRE', desc: '"Celtic Guardian" + "Axe Raider"' });
fake({ name: 'Frightfur Test Tiger', sub: 'Fusion', level: 6, atk: 1900, def: 1200, race: 'Fiend', attribute: 'DARK', desc: '"Celtic Guardian" + "Axe Raider"' });
fake({ name: 'Frightfur Test Wolf', sub: 'Fusion', level: 6, atk: 2000, def: 1500, race: 'Fiend', attribute: 'DARK', desc: '"Celtic Guardian" + "Axe Raider"' });
fake({ name: 'Vennominon the King of Poisonous Snakes', level: 6, atk: 0, def: 0, race: 'Reptile', attribute: 'EARTH' });
fake({ name: 'Vennominaga the Deity of Poisonous Snakes', level: 10, atk: 0, def: 0, race: 'Reptile', attribute: 'EARTH' });
/** Puts a card face-up and active in a Spell & Trap Zone (a Crystal Beast placed there, a Continuous card already on). */
function putUp(e: Engine, p: Pid, name: string): FieldCard {
  const fc = putST(e, p, name);
  fc.faceUp = true;
  fc.active = true;
  return fc;
}
/** Moves a card of `p` (Deck, hand or Extra Deck) to the GY without any effect happening. */
function toGy(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.hand, ...ps.deck, ...ps.fusion].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  for (const arr of [ps.hand, ps.deck, ps.fusion]) {
    const i = arr.findIndex((x) => x.uid === c.uid);
    if (i >= 0) arr.splice(i, 1);
  }
  ps.gy.push(c);
  return c;
}
/** An Xyz Summon of `name` (Extra Deck) with these monsters on `p`'s field. */
function xyz(e: Engine, p: Pid, name: string, mats: (FieldCard | null)[]): FieldCard | null {
  const c = e.player(p).fusion.find((x) => x.name === name)!;
  run(e, e.extraSummon(p, c.uid, mats.map((m) => m!.uid), 'Xyz'));
  return e.fieldCard(c.uid);
}
let checked = 0;
let fixed = 0;
const card = (name: string, wasFixed = false) => {
  section(name);
  checked++;
  if (wasFixed) fixed++;
};

// ======================= cards-16 =======================
card('A Feint Plan');
{
  const e = duel(['A Feint Plan'], [FILL]);
  const me = place(e, 0, FILL)!;
  const fd = place(e, 1, FILL, 'def', false)!;
  const up = place(e, 1, FILL)!;
  playTrap(e, 0, 'A Feint Plan');
  const ts = e.legalTargets(0, me).map((m) => m.uid);
  check(!ts.includes(fd.uid) && ts.includes(up.uid), 'face-down monsters cannot be attacked this turn (face-up ones still can)');
  endTurn(e);
  check(e.legalTargets(1, up).length >= 0 && !e.lingering().length, 'the effect ends with the turn');
}

card('A Major Upset', true);
{
  const e = duel(['A Major Upset'], ['Gaia The Fierce Knight', 'Axe Raider']);
  const tok = e.createToken('Worm Token', 0, 'atk', true, { atk: 0, def: 0, level: 1, attribute: 'EARTH', race: 'Insect' })!;
  const g = place(e, 1, 'Gaia The Fierce Knight');
  const axe = place(e, 1, 'Axe Raider');
  playTrap(e, 0, 'A Major Upset');
  check(!e.fieldCard(tok.uid) && zone(e, g) === 'hand' && zone(e, axe) === 'mz', 'a Level 1 Token can be the Tribute; Level 7+ Special Summoned monsters return to the hand');
}

card('Abyss Actors Back Stage');
{
  const e = duel(['Abyss Actors Back Stage']);
  const t = putST(e, 0, 'Abyss Actors Back Stage');
  check(!e.canActivateMain(0, t.uid), 'needs 2 "Abyss Actor" cards in the Pendulum Zones, which Speed Duel does not have');
}

card('Abyss Script - Fantasy Magic');
{
  const e = duel(['Abyss Actor - Extras', 'Abyss Script - Fantasy Magic'], ['Giant Soldier of Stone']);
  const ex = place(e, 0, 'Abyss Actor - Extras')!;
  const gs = place(e, 1, 'Giant Soldier of Stone', 'def')!;
  toTurn3(e);
  playSpell(e, 0, 'Abyss Script - Fantasy Magic');
  toBattle(e);
  attack(e, ex, gs);
  check(zone(e, gs) === 'hand', 'a monster that battles it and is not destroyed returns to the hand at the end of the Damage Step');
}

card('Advanced Dark', true);
{
  const e = duel(['Advanced Dark', 'Crystal Beast Ruby Carbuncle', 'Crystal Beast Amber Mammoth', 'Crystal Beast Topaz Tiger'], ['Axe Raider', 'Axe Raider']);
  playSpell(e, 0, 'Advanced Dark');
  const rc = place(e, 0, 'Crystal Beast Ruby Carbuncle')!;
  const tt = toGy(e, 0, 'Crystal Beast Topaz Tiger');
  check(attrOf(e, rc) === 'DARK' && attrOf(e, tt) === 'DARK', '"Crystal Beast" monsters on the field and in the GY become DARK');
  endTurn(e);
  const axe = place(e, 1, 'Axe Raider')!;
  axe.placedTurn = -1;
  toBattle(e);
  attack(e, axe, rc, { respond: 'Advanced Dark' }, { pick: ['Crystal Beast Amber Mammoth'] });
  check(lp(e, 0) === 4000, 'send a "Crystal Beast" from the Deck: no battle damage from that battle');
}
{
  const e = duel(['Advanced Dark', 'Rainbow Dragon'], ['Mystic Tomato']);
  playSpell(e, 0, 'Advanced Dark');
  const rd = e.player(0).deck.find((c) => c.name === 'Rainbow Dragon')!;
  e.state.fx.ignoreCond = rd.uid;
  const r = place(e, 0, 'Rainbow Dragon')!;
  e.state.fx.ignoreCond = undefined;
  const mt = place(e, 1, 'Mystic Tomato')!;
  toTurn3(e);
  toBattle(e);
  attack(e, r, mt);
  check(zone(e, mt) === 'gy' && !logHas(e, 'Mystic Tomato\'s effect activates') && !e.monsters(1).length, 'an "Ultimate Crystal" monster attacks: the attack target\'s effects are negated (Mystic Tomato cannot Summon)');
}

card('Advanced Heraldry Art', true);
{
  const e = duel(['Advanced Heraldry Art', 'Heraldic Beast Aberconway', 'Heraldic Beast Aberconway'], [], ['Number 8: Heraldic King Genom-Heritage']);
  const a = toGy(e, 0, 'Heraldic Beast Aberconway');
  const b = toGy(e, 0, 'Heraldic Beast Aberconway');
  playSpell(e, 0, 'Advanced Heraldry Art');
  const n8 = e.monsters(0).find((m) => m.name === 'Number 8: Heraldic King Genom-Heritage');
  check(!!n8 && (n8.mats ?? []).some((c) => c.uid === a.uid) && (n8.mats ?? []).some((c) => c.uid === b.uid), 'both are Special Summoned, then Xyz Summon Number 8 using those 2 only');
}

card('Amplifier');
{
  const e = duel(['Jinzo', 'Amplifier']);
  const j = place(e, 0, 'Jinzo')!;
  const amp = playSpell(e, 0, 'Amplifier');
  check(!e.trapsSealed(0) && e.trapsSealed(1), "Jinzo no longer stops its controller's Traps (the opponent's still are)");
  kill(e, [amp]);
  check(zone(e, j) === 'gy', 'Amplifier leaves the field: Jinzo is destroyed');
}

card('Ancient City - Rainbow Ruins');
{
  const e = duel(['Ancient City - Rainbow Ruins', 'Crystal Beast Ruby Carbuncle', 'Crystal Beast Topaz Tiger', 'Crystal Beast Amethyst Cat', 'Crystal Beast Sapphire Pegasus', 'Crystal Beast Emerald Tortoise'], ['Ookazi', 'Axe Raider']);
  const rr = playSpell(e, 0, 'Ancient City - Rainbow Ruins');
  putUp(e, 0, 'Crystal Beast Ruby Carbuncle');
  kill(e, [rr], 1);
  check(zone(e, rr) === 'field', '1+: it cannot be destroyed by card effects');
  putUp(e, 0, 'Crystal Beast Topaz Tiger');
  putUp(e, 0, 'Crystal Beast Amethyst Cat');
  const peg = place(e, 0, 'Crystal Beast Sapphire Pegasus');
  toTurnOf(e, 1);
  const oo = grab(e, 1, 'Ookazi');
  act(e, 1, oo.uid, { respond: 'Ancient City - Rainbow Ruins' });
  check(zone(e, oo) === 'gy' && zone(e, peg) === 'gy' && lp(e, 0) === 4000, '3+: send a "Crystal Beast" monster to negate a Spell activation and destroy it');
  const att = place(e, 1, 'Axe Raider');
  toBattle(e);
  attack(e, att, null, { respond: 'Ancient City - Rainbow Ruins' });
  check(lp(e, 0) === 4000 - 850, '2+: the battle damage is halved');
}

card('Anti-Magic Arrows', true);
{
  const e = duel(['Anti-Magic Arrows'], ['Axe Raider', 'Reinforcements']);
  const arrows = putST(e, 0, 'Anti-Magic Arrows');
  endTurn(e);
  const axe = place(e, 1, 'Axe Raider')!;
  axe.placedTurn = -1;
  const rf = putST(e, 1, 'Reinforcements');
  toBattle(e);
  e.apply({ type: 'ATTACK', player: 1, uid: axe.uid, target: null });
  const pr = e.state.prompt;
  const k = pr?.kind === 'response' ? pr.options.findIndex((o) => o.uid === arrows.uid) : -1;
  check(k >= 0, "it can be activated at the start of the opponent's Battle Phase (their first attack)");
  e.apply({ type: 'CHOOSE', player: 0, picks: [k] });
  const after = e.state.prompt;
  check(!(after?.kind === 'response' && after.player === 1 && after.options.some((o) => o.uid === rf.uid)), 'nothing can be activated in response to it');
  settle(e);
  check(e.activationLocked(0, 'spell') && e.activationLocked(1, 'trap') && e.activationBlocked(1, rf) && !e.responsesFor(1, 'attack', {}).some((o) => o.uid === rf.uid), 'Spell/Trap Cards and their effects cannot be activated for the rest of the turn');
  endTurn(e);
  check(!e.activationLocked(0, 'spell'), 'next turn: allowed again');
}

card('Artifact Ignition');
{
  const e = duel(['Artifact Ignition', 'Artifact Moralltach'], ['Mirror Force']);
  const mf = putST(e, 1, 'Mirror Force');
  playSpell(e, 0, 'Artifact Ignition');
  const set = e.player(0).sz.find((c) => c?.name === 'Artifact Moralltach');
  check(zone(e, mf) === 'gy' && !!set && !set.faceUp, 'destroys a Spell/Trap, then Sets an "Artifact" monster from the Deck as a Spell');
}
{
  const e = duel(['Artifact Ignition', 'Artifact Moralltach'], ['Axe Raider']);
  const ai = putST(e, 0, 'Artifact Ignition');
  endTurn(e);
  kill(e, [ai], 1);
  const axe = place(e, 1, 'Axe Raider')!;
  axe.placedTurn = -1;
  toBattle(e);
  check(zone(e, ai) === 'gy' && !e.canAttackWith(1, axe), 'destroyed by the opponent while Set: they skip their next Battle Phase');
}

card('Barrel Behind the Door', true);
{
  const e = duel(['Barrel Behind the Door'], ['Ookazi', 'Dian Keto the Cure Master']);
  const b = putST(e, 0, 'Barrel Behind the Door');
  toTurnOf(e, 1);
  grab(e, 1, 'Dian Keto the Cure Master');
  e.apply({ type: 'ACTIVATE', player: 1, uid: e.player(1).hand.find((c) => c.name === 'Dian Keto the Cure Master')!.uid, zone: 0 });
  const pr = e.state.prompt;
  check(!(pr?.kind === 'response' && pr.options.some((o) => o.uid === b.uid)), 'not offered against a card that inflicts no damage');
  settle(e);
  playSpell(e, 1, 'Ookazi', { respond: 'Barrel Behind the Door' });
  check(lp(e, 0) === 4000 && lp(e, 1) === 5000 - 800, 'the opponent takes the effect damage instead');
}
{
  const e = duel(['Barrel Behind the Door', 'Tremendous Fire']);
  putST(e, 0, 'Barrel Behind the Door');
  playSpell(e, 0, 'Tremendous Fire', { respond: 'Barrel Behind the Door' });
  check(lp(e, 0) === 4000 && lp(e, 1) === 4000 - 1500, "your own card's damage to you can be sent to the opponent too");
}

card('Bashing Shield', true);
{
  const e = duel(['Bashing Shield', 'Axe Raider'], ['Blue-Eyes White Dragon']);
  const ss = place(e, 0, 'Axe Raider')!;
  const bs = grab(e, 0, 'Bashing Shield');
  check(!e.canActivateMain(0, bs.uid), 'a Special Summoned monster cannot take it');
  const f = summon(e, 0, FILL)!;
  const bewd = place(e, 1, 'Blue-Eyes White Dragon');
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  playSpell(e, 0, 'Bashing Shield', { pick: [FILL] });
  check(e.atkOf(f) === 2400 && e.atkOf(ss) === 1700, 'the Normal Summoned monster gains 1000 ATK');
  toBattle(e);
  attack(e, f, bewd);
  check(lp(e, 0) === 4000 && zone(e, f) === 'gy', 'no battle damage from attacks involving it');
}

card('Berserk Scales');
{
  const e = duel(['Berserk Scales']);
  const f = place(e, 0, FILL);
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  playSpell(e, 0, 'Berserk Scales');
  check(e.atkOf(f!) === 2400, 'it gains 1000 ATK');
  toBattle(e);
  check(!e.canAttackWith(0, f!), 'it cannot attack directly');
  endTurn(e);
  check(e.atkOf(f!) === 400, 'End Phase: it loses 2000 ATK');
}

card('Big Evolution Pill');
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

card('Blast Held by a Tribute', true);
{
  const e = duel(['Blast Held by a Tribute'], ['Summoned Skull', 'Petit Moth', 'Axe Raider']);
  const t = putST(e, 0, 'Blast Held by a Tribute');
  endTurn(e);
  const ssk = place(e, 1, 'Summoned Skull')!;
  ssk.placedTurn = -1;
  toBattle(e);
  e.state.battle = { attacker: ssk.uid, target: null };
  check(!e.responsesFor(0, 'attack', { uid: ssk.uid }).some((o) => o.uid === t.uid), 'a Special Summoned Level 6 monster is not a Tribute Summoned one');
  e.state.battle = null;
}
{
  const e = duel(['Blast Held by a Tribute'], ['Summoned Skull', 'Petit Moth', 'Axe Raider']);
  putST(e, 0, 'Blast Held by a Tribute');
  endTurn(e);
  place(e, 1, 'Petit Moth');
  const sk = summon(e, 1, 'Summoned Skull');
  const axe = place(e, 1, 'Axe Raider');
  toBattle(e);
  attack(e, sk, null, { respond: 'Blast Held by a Tribute' });
  check(zone(e, sk) === 'gy' && zone(e, axe) === 'gy' && lp(e, 1) === 3000, 'a Tribute Summoned monster attacks: their Attack Position monsters are destroyed and 1000 damage');
}

card('Blast with Chain', true);
{
  const e = duel(['Blast with Chain'], ['Gemini Elf']);
  const c = place(e, 0, FILL)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  const bwc = playTrap(e, 0, 'Blast with Chain', { pick: [FILL] });
  check(zone(e, bwc) === 'sz' && e.atkOf(c) === 1900, 'equips itself: +500 ATK');
  (e as any).run(e.as(1, e.destroy([bwc!.uid])));
  const pr = e.state.prompt;
  check(!!pr && pr.kind !== 'yesno', 'its effect is not optional');
  settle(e, { pick: ['Gemini Elf'] });
  check(zone(e, elf) === 'gy', 'destroyed by a card effect while equipped: destroys 1 card on the field');
}

card('Blasting Fuse');
{
  const e = duel(['Blasting Fuse', 'Axe Raider'], ['Gyroid', 'Gyroid', 'Gyroid', 'Trap Hole', 'Trap Hole', 'Trap Hole']);
  const t = putST(e, 0, 'Blasting Fuse');
  check(!e.canActivateMain(0, t.uid), 'column not full: cannot be activated');
  const mine = place(e, 0, 'Axe Raider')!;
  const theirs = [place(e, 1, 'Gyroid'), place(e, 1, 'Gyroid'), place(e, 1, 'Gyroid')];
  const sets = [putST(e, 1, 'Trap Hole'), putST(e, 1, 'Trap Hole'), putST(e, 1, 'Trap Hole')];
  act(e, 0, t.uid);
  check(zone(e, mine) === 'gy' && zone(e, theirs[2]) === 'gy' && zone(e, sets[2]) === 'gy' && zone(e, theirs[0]) === 'mz' && zone(e, sets[0]) === 'sz', 'destroys every card in its column (and nothing else)');
}

card('Branded Fusion', true);
{
  const e = duel(['Beastking of the Swamps', 'Blue-Eyes White Dragon', 'Branded Fusion', 'Branded Fusion'], [], ['Brigrand the Glory Dragon', 'Number 98: Test Wraith']);
  grab(e, 0, 'Beastking of the Swamps');
  const b2 = grab(e, 0, 'Branded Fusion');
  playSpell(e, 0, 'Branded Fusion');
  const br = e.monsters(0).find((m) => m.name === 'Brigrand the Glory Dragon');
  check(!!br && !!br.tags?.fusS && e.player(0).gy.some((c) => c.name === 'Blue-Eyes White Dragon'), 'Fusion Summons a Fusion Monster that lists "Fallen of Albaz", with a material from the Deck');
  const n98 = e.player(0).fusion.find((c) => c.name === 'Number 98: Test Wraith')!;
  check(e.summonBlocked(0, n98, 'special', 'fusion') && !e.canActivateMain(0, b2.uid), 'no Special Summons from the Extra Deck except Fusion Monsters this turn; only 1 per turn');
}

card('Breakthrough!', true);
{
  const e = duel(['Grandmaster of the Six Samurai', 'Breakthrough!'], ['Axe Raider', 'Celtic Guardian']);
  const gm = place(e, 0, 'Grandmaster of the Six Samurai')!;
  toTurn3(e);
  const axe = place(e, 1, 'Axe Raider')!;
  place(e, 1, 'Celtic Guardian');
  const bt = playTrap(e, 0, 'Breakthrough!');
  check(!bt && e.player(0).gy.some((c) => c.name === 'Breakthrough!'), 'a Normal Trap: it goes to the GY (its effect lasts the turn)');
  toBattle(e);
  check(!e.canAttackDirectly(gm), 'no direct attack before it destroys a monster');
  attack(e, gm, axe);
  check(zone(e, axe) === 'gy' && e.canAttackDirectly(gm), 'the selected Six Samurai destroyed a monster: it can attack directly');
}

card('Bujintervention');
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

card('By Order of the Emperor');
{
  const e = duel(['By Order of the Emperor'], ['Marauding Captain']);
  playTrap(e, 0, 'By Order of the Emperor');
  toTurnOf(e, 1);
  const hand = e.player(1).hand.length;
  const c = grab(e, 1, 'Marauding Captain');
  e.apply({ type: 'SUMMON', player: 1, uid: c.uid, zone: 0, pos: 'atk', faceUp: true });
  const left = settle(e, { respond: 'By Order of the Emperor' }, 'yes');
  check(left === 1 && e.monsters(1).length === 1 && e.player(1).hand.length === hand, 'the Normal Summon effect is negated and its controller draws 1');
}

card('Card Advance');
{
  const e = duel(['Card Advance', 'Summoned Skull', 'Pot of Greed']);
  summon(e, 0, FILL);
  const skull = grab(e, 0, 'Summoned Skull');
  e.player(0).normalSummoned = true;
  check(!e.canNormalSummon(0, skull), 'no second Normal Summon before');
  grab(e, 0, 'Card Advance');
  const top = e.player(0).deck.slice(0, 5).map((c) => c.uid);
  playSpell(e, 0, 'Card Advance');
  check(e.player(0).deck.slice(0, 5).every((c) => top.includes(c.uid)), 'the top 5 cards go back on top');
  check(e.canNormalSummon(0, skull), 'you can Tribute Summon 1 more monster this turn');
}

card('Checkmate');
{
  const e = duel(['Checkmate', 'Terrorking Archfiend', 'Vilepawn Archfiend'], ['Axe Raider']);
  const tk = place(e, 0, 'Terrorking Archfiend')!;
  const v = place(e, 0, 'Vilepawn Archfiend');
  place(e, 1, 'Axe Raider');
  playSpell(e, 0, 'Checkmate', { pick: ['Vilepawn Archfiend'] });
  check(zone(e, v) === 'gy' && e.canAttackDirectly(tk), 'Tribute an Archfiend: Terrorking Archfiend can attack directly this turn');
}

card('Chosen of Zefra');
{
  const e = duel(['Chosen of Zefra', 'Axe Raider']);
  const axe = place(e, 0, 'Axe Raider');
  const z = playTrap(e, 0, 'Chosen of Zefra');
  check(active(e, z) && e.atkOf(axe!) === 1700, 'activates and stays; no face-up "Zefra" in an Extra Deck in Speed Duel, so nothing applies');
}

card('Corrosive Scales', true);
{
  const e = duel(['Corrosive Scales', 'Big Insect', 'Petit Moth'], ['Axe Raider', 'Dian Keto the Cure Master']);
  const bi = place(e, 0, 'Big Insect');
  const moth = place(e, 0, 'Petit Moth');
  const cs = playTrap(e, 0, 'Corrosive Scales', { pick: ['Big Insect'] });
  check(cs?.equippedTo === bi!.uid, 'equipped to an Insect');
  endTurn(e);
  const axe = summon(e, 1, 'Axe Raider');
  check(e.atkOf(axe!) === 1600, 'the opponent Summons: a Scale Counter, -100 ATK');
  playSpell(e, 1, 'Dian Keto the Cure Master');
  check(e.atkOf(axe!) === 1500 && e.defOf(axe!) === 950, 'the opponent activates a card: another Scale Counter is placed (mandatory, no response needed)');
  const ts = e.legalTargets(1, axe!).map((m) => m.uid);
  check(ts.includes(bi!.uid) && !ts.includes(moth!.uid), 'other Insects cannot be attacked');
}

card('Cost Down');
{
  const e = duel(['Cost Down', 'Gaia The Fierce Knight', 'Axe Raider', 'Pot of Greed']);
  const gaia = grab(e, 0, 'Gaia The Fierce Knight');
  grab(e, 0, 'Pot of Greed');
  place(e, 0, 'Axe Raider');
  playSpell(e, 0, 'Cost Down', { pick: ['Pot of Greed'] });
  check(e.tributePlan(0, gaia, true).need === 1 && levelOf(e, gaia) === 5, 'discard 1: monsters in the hand are 2 Levels lower');
  summon(e, 0, 'Gaia The Fierce Knight', true, { pick: ['Axe Raider'] });
  check(zone(e, gaia) === 'mz' && levelOf(e, e.fieldCard(gaia.uid)!) === 5, '... even after they are Summoned');
}

card('D.D.D. - Different Dimension Derby', true);
{
  const e = duel(['Polymerization', 'Flame Manipulator', 'Masaki the Legendary Swordsman', 'D.D.D. - Different Dimension Derby'], ['Axe Raider'], ['Flame Swordsman']);
  const axe = place(e, 1, 'Axe Raider');
  const t = putST(e, 0, 'D.D.D. - Different Dimension Derby');
  check(!e.canActivateMain(0, t.uid), 'no qualifying monster: cannot be activated');
  grab(e, 0, 'Flame Manipulator');
  grab(e, 0, 'Masaki the Legendary Swordsman');
  playSpell(e, 0, 'Polymerization');
  act(e, 0, t.uid, { pick: ['Axe Raider'] });
  check(zone(e, axe) === 'removed', 'a monster Fusion Summoned with Normal Monster materials: banish 1 card on the field');
}
{
  const e = duel(['Axe Raider', 'Gemini Elf', 'D.D.D. - Different Dimension Derby'], ['Axe Raider'], ['Number 98: Test Wraith']);
  const foe = place(e, 1, 'Axe Raider');
  const t = putST(e, 0, 'D.D.D. - Different Dimension Derby');
  xyz(e, 0, 'Number 98: Test Wraith', [place(e, 0, 'Axe Raider'), place(e, 0, 'Gemini Elf')]);
  act(e, 0, t.uid, { pick: ['Axe Raider'] });
  check(zone(e, foe) === 'removed', 'a monster Xyz Summoned with Normal Monsters counts too');
}

card('Darklight');
{
  const e = duel(['Darklight', 'Archfiend Soldier'], ['Axe Raider', 'Celtic Guardian']);
  const af = place(e, 0, 'Archfiend Soldier')!;
  af.tags = {};
  const axe = place(e, 1, 'Axe Raider');
  const cg = place(e, 1, 'Celtic Guardian')!;
  cg.tags = {};
  playTrap(e, 0, 'Darklight', { pick: ['Archfiend Soldier'] });
  check(zone(e, af) === 'gy' && zone(e, axe) === 'gy' && zone(e, cg) === 'mz', 'Tribute a DARK 1500+ monster: destroys the monsters Special Summoned this turn');
}

card('Diamond-Dust Cyclone');
{
  const e = duel(['Diamond-Dust Cyclone'], ['Axe Raider']);
  const axe = place(e, 1, 'Axe Raider');
  (axe!.tags ??= {}).fog = 8;
  const n = e.player(0).hand.length;
  playSpell(e, 0, 'Diamond-Dust Cyclone');
  check(zone(e, axe) === 'gy' && e.player(0).hand.length === n + 1 + 2 - 1, 'destroys a monster with 8 Fog Counters and draws 2');
}

card('Diffusion Wave-Motion', true);
{
  const e = duel(['Diffusion Wave-Motion', 'Dark Magician'], ['Big Shield Gardna', 'Kuriboh']);
  const dm = place(e, 0, 'Dark Magician')!;
  const f = place(e, 0, FILL);
  const bsg = place(e, 1, 'Big Shield Gardna', 'def')!;
  const k = place(e, 1, 'Kuriboh', 'def')!;
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  playSpell(e, 0, 'Diffusion Wave-Motion');
  check(lp(e, 0) === 3000, 'pay 1000 LP');
  toBattle(e);
  check(!e.canAttackWith(0, f!), 'other monsters cannot attack');
  attack(e, dm, bsg);
  const ts = e.legalTargets(0, dm).map((m) => m.uid);
  check(zone(e, bsg) === 'mz' && e.canAttackWith(0, dm) && !ts.includes(bsg.uid) && ts.includes(k.uid), 'it attacks each opponent monster once (not the same one twice)');
  attack(e, dm, k);
  check(zone(e, k) === 'gy' && !e.canAttackWith(0, dm), '... and no more attacks after that');
}

card('Drop Off');
{
  const e = duel(['Drop Off'], ['Petit Moth', 'Axe Raider']);
  putST(e, 0, 'Drop Off');
  endTurn(e);
  const drawn = e.state.fx.normalDraw?.uid as number | undefined;
  summon(e, 1, 'Axe Raider', true, { respond: 'Drop Off' });
  check(drawn !== undefined && e.find(drawn)?.loc.zone === 'gy', 'the card the opponent drew for their normal draw is discarded');
}

card('Faustian Bargain');
{
  const e = duel(['Faustian Bargain', 'Petit Moth'], ['Axe Raider']);
  const axe = place(e, 1, 'Axe Raider');
  const moth = grab(e, 0, 'Petit Moth');
  playSpell(e, 0, 'Faustian Bargain', { pick: ['Axe Raider'] }, { pick: ['Petit Moth'] });
  check(zone(e, axe) === 'gy' && zone(e, moth) === 'mz', 'a Special Summoned monster goes to the GY; a Level 4 or lower Normal Monster is Special Summoned from the hand');
}

card('Flower Gathering');
{
  const e = duel(['Flower Gathering', 'Flower Cardian Pine', 'Flower Cardian Willow', 'Flower Cardian Maple with Deer', 'Flower Cardian Cherry Blossom with Curtain']);
  const fg = grab(e, 0, 'Flower Gathering');
  check(!e.canActivateMain(0, fg.uid), 'it needs 4 free Monster Zones, so it cannot be activated in a Speed Duel');
}

card('Formation Union', true);
{
  const e = duel(['Formation Union', 'Formation Union', 'Y-Dragon Head', 'X-Head Cannon']);
  const c = place(e, 0, FILL)!;
  const y = place(e, 0, 'Y-Dragon Head')!;
  const t = putST(e, 0, 'Formation Union');
  check(!e.canActivateMain(0, t.uid), 'no appropriate monster for the Union monster: it cannot equip it');
  const x = place(e, 0, 'X-Head Cannon')!;
  act(e, 0, t.uid, { pick: ['Equip a Union monster'] });
  check(zone(e, y) === 'sz' && x.equips.includes(y.uid) && !c.equips.includes(y.uid), 'equips a Union monster to an appropriate monster (X-Head Cannon)');
  playTrap(e, 0, 'Formation Union', { pick: ['Unequip a Union monster and Special Summon it'] });
  check(zone(e, y) === 'mz' && !x.equips.includes(y.uid) && e.fieldCard(y.uid)!.pos === 'atk', 'unequips it and Special Summons it in Attack Position');
}

card('Frightfur Sanctuary');
{
  const e = duel(['Frightfur Sanctuary'], [], ['Frightfur Test Tiger', 'Frightfur Test Wolf']);
  const hand = e.player(0).hand.length;
  const fs = playSpell(e, 0, 'Frightfur Sanctuary');
  check(!!fs?.active && e.player(0).gy.filter((c) => c.name.startsWith('Frightfur')).length === 2 && e.player(0).hand.length === hand - 1, 'activated by discarding 1 and sending 2 "Frightfur" monsters from the Extra Deck');
  kill(e, [fs], undefined, 'yes');
  check(e.player(0).fusion.some((c) => c.name.startsWith('Frightfur')), 'sent to the GY: a "Frightfur" Fusion returns to the Extra Deck');
}

card('Fullmetalfoes Fusion', true);
{
  const e = duel(['Fullmetalfoes Fusion', 'Axe Raider'], [], ['Metalfoes Test Fusion', 'Flame Swordsman']);
  place(e, 0, FILL);
  grab(e, 0, 'Axe Raider');
  playSpell(e, 0, 'Fullmetalfoes Fusion');
  const m = e.monsters(0).find((x) => x.name === 'Metalfoes Test Fusion');
  check(!!m && !!m.tags?.fusS && !!e.state.fx.fusionMatList?.[m.uid], 'Fusion Summons a "Metalfoes" Fusion Monster from hand/field materials, as a proper Fusion Summon');
}

card('Fusion Fright Waltz');
{
  const e = duel(['Fusion Fright Waltz', 'Axe Raider'], ['Gyroid'], ['Frightfur Test Tiger'], ['Flame Swordsman']);
  const ft = place(e, 0, 'Frightfur Test Tiger')!;
  const fs = place(e, 1, 'Flame Swordsman')!;
  const g = place(e, 1, 'Gyroid');
  const axe = place(e, 0, 'Axe Raider');
  const lp0 = lp(e, 0);
  const lp1 = lp(e, 1);
  playTrap(e, 0, 'Fusion Fright Waltz');
  check(zone(e, g) === 'gy' && zone(e, axe) === 'gy' && zone(e, ft) === 'mz' && zone(e, fs) === 'mz', 'destroys the other Special Summoned monsters');
  check(lp(e, 0) === lp0 - 3700 && lp(e, 1) === lp1 - 3700, "each player who lost a monster takes the targets' combined ATK");
}

card('Fusion Recovery');
{
  const e = duel(['Polymerization', 'Flame Manipulator', 'Masaki the Legendary Swordsman', 'Fusion Recovery'], [], ['Flame Swordsman']);
  const fm = grab(e, 0, 'Flame Manipulator');
  grab(e, 0, 'Masaki the Legendary Swordsman');
  const poly = grab(e, 0, 'Polymerization');
  playSpell(e, 0, 'Polymerization');
  playSpell(e, 0, 'Fusion Recovery', { pick: ['Polymerization'] }, { pick: ['Flame Manipulator'] });
  check(zone(e, poly) === 'hand' && zone(e, fm) === 'hand', 'adds Polymerization and a Fusion Material monster from the GY');
}

card('Fusion Recycling Plant', true);
{
  const e = duel(['Fusion Recycling Plant', 'Polymerization', 'Flame Manipulator', 'Masaki the Legendary Swordsman', 'Pot of Greed'], [], ['Flame Swordsman']);
  const frp = playSpell(e, 0, 'Fusion Recycling Plant')!;
  const pot = grab(e, 0, 'Pot of Greed');
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: frp.uid });
  settle(e, { pick: ['Pot of Greed'] });
  const poly = e.player(0).hand.find((c) => c.name === 'Polymerization');
  check(!!poly && zone(e, pot) === 'gy', 'discard 1 (its cost): adds "Polymerization" from the Deck');
  place(e, 0, 'Flame Manipulator');
  const ms = place(e, 0, 'Masaki the Legendary Swordsman');
  act(e, 0, poly!.uid);
  endTurn(e, 'yes', { pick: ['Masaki the Legendary Swordsman'] });
  check(zone(e, ms) === 'hand', 'End Phase: a monster used as Fusion Material this turn goes back to the hand');
}

card('Geartown');
{
  const e = duel(['Geartown', 'Ancient Gear Golem', 'Ancient Gear'], ['Mystical Space Typhoon']);
  const gt = playSpell(e, 0, 'Geartown')!;
  const golem = grab(e, 0, 'Ancient Gear Golem');
  check(e.tributeNeed(0, golem) === 1 && e.tributeNeed(1, golem) === 1, '"Ancient Gear" monsters need 1 less Tribute (both players)');
  kill(e, [gt], 1, 'yes');
  check(zone(e, gt) === 'gy' && e.monsters(0).some((m) => m.name === 'Ancient Gear'), 'destroyed: Special Summon an "Ancient Gear" monster');
}

card('Gotterdammerung', true);
{
  const e = duel(['Gotterdammerung', 'Thor, Test Aesir'], ['Axe Raider', 'Mirror Force']);
  const thor = place(e, 0, 'Thor, Test Aesir')!;
  const axe = place(e, 1, 'Axe Raider')!;
  const mf = putST(e, 1, 'Mirror Force');
  playSpell(e, 0, 'Gotterdammerung');
  check(e.controller(thor.uid) === 1, 'the "Aesir" monster goes to the opponent');
  endTurn(e);
  check(zone(e, thor) === 'mz' && zone(e, axe) === 'mz', 'nothing happens in your own End Phase');
  endTurn(e);
  check(zone(e, thor) === 'gy' && zone(e, axe) === 'removed' && zone(e, mf) === 'removed', "the opponent's next End Phase: it is destroyed, then everything they control is banished");
}

card('Half Shut');
{
  const e = duel(['Half Shut', 'Axe Raider'], ['Gaia The Fierce Knight']);
  const axe = place(e, 0, 'Axe Raider')!;
  const gaia = place(e, 1, 'Gaia The Fierce Knight')!;
  playSpell(e, 0, 'Half Shut', { pick: ['Gaia The Fierce Knight'] });
  check(e.atkOf(gaia) === 1150, 'its ATK is halved');
  e.state.firstTurn = false;
  toBattle(e);
  attack(e, axe, gaia);
  check(zone(e, gaia) === 'mz', 'it cannot be destroyed by battle this turn');
}

card('Heat Wave', true);
{
  const e = duel(['Heat Wave', 'Kuriboh', 'Blue-Eyes White Dragon'], ['Kuriboh', 'Mystical Space Typhoon']);
  const hw = playSpell(e, 0, 'Heat Wave');
  check(!hw && e.player(0).gy.some((c) => c.name === 'Heat Wave'), 'a Normal Spell: it goes to the GY');
  check(e.summonBlocked(0, grab(e, 0, 'Kuriboh'), 'normal', 'hand') && !e.summonBlocked(0, grab(e, 0, FILL), 'normal', 'hand'), 'Effect Monsters cannot be Normal Summoned; Normal Monsters can');
  check(!place(e, 0, 'Kuriboh') && !!place(e, 0, 'Blue-Eyes White Dragon'), 'nor Special Summoned');
  toTurnOf(e, 1);
  check(e.summonBlocked(1, grab(e, 1, 'Kuriboh'), 'normal', 'hand'), "it lasts through the opponent's turn");
  toTurnOf(e, 0);
  check(!e.summonBlocked(0, grab(e, 0, 'Kuriboh'), 'normal', 'hand'), 'it ends at your next Draw Phase');
}

card('Heraldry Record');
{
  const e = duel(['Heraldry Record', 'Axe Raider'], ['Axe Raider', 'Gemini Elf'], [], ['Number 103: Ragnazero']);
  const mine = place(e, 0, 'Axe Raider')!;
  mine.atkMod += 100;
  const hr = putST(e, 0, 'Heraldry Record');
  endTurn(e);
  mine.atkMod += 100;
  const rz = xyz(e, 1, 'Number 103: Ragnazero', [place(e, 1, 'Axe Raider'), place(e, 1, 'Gemini Elf')])!;
  e.apply({ type: 'QUICK_EFFECT', player: 1, uid: rz.uid });
  settle(e, { pick: ['Axe Raider'] }, { respond: 'Heraldry Record' });
  check(zone(e, hr) === 'gy' && zone(e, rz) !== 'mz' && zone(e, mine) === 'mz', "an opponent's Xyz effect activated by detaching: negated, and that monster is destroyed");
}

card('Hero Ring');
{
  const e = duel(['Hero Ring', 'Celtic Guardian'], ['Summoned Skull', 'Axe Raider']);
  const cg = place(e, 0, 'Celtic Guardian')!;
  playTrap(e, 0, 'Hero Ring');
  const sk = place(e, 1, 'Summoned Skull')!;
  const axe = place(e, 1, 'Axe Raider')!;
  check(!e.legalTargets(1, sk).some((t) => t.uid === cg.uid) && e.legalTargets(1, axe).some((t) => t.uid === cg.uid), 'monsters with 1900+ ATK cannot attack the equipped Warrior');
}

card('Horn of the Phantom Beast');
{
  const e = duel(['Horn of the Phantom Beast', 'Gazelle the King of Mythical Beasts'], ['Kuriboh']);
  const gz = place(e, 0, 'Gazelle the King of Mythical Beasts');
  const kb = place(e, 1, 'Kuriboh');
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  const horn = playTrap(e, 0, 'Horn of the Phantom Beast');
  check(!!horn && horn.equippedTo === gz!.uid && e.atkOf(gz!) === 2300, 'it equips to a Beast: +800 ATK');
  const hand = e.player(0).hand.length;
  toBattle(e);
  attack(e, gz, kb);
  check(zone(e, kb) === 'gy' && e.player(0).hand.length === hand + 1, 'the equipped monster destroys a monster by battle: draw 1');
}

card('Interdimensional Matter Transporter');
{
  const e = duel(['Interdimensional Matter Transporter', 'Axe Raider']);
  const axe = place(e, 0, 'Axe Raider');
  playTrap(e, 0, 'Interdimensional Matter Transporter', { pick: ['Axe Raider'] });
  check(zone(e, axe) === 'removed', 'a monster you control is banished');
  endTurn(e);
  check(zone(e, axe) === 'mz' && e.controller(axe!.uid) === 0, 'it returns in the End Phase');
}

card("Joker's Wild");
{
  const e = duel(["Joker's Wild", "Queen's Knight"]);
  const jw = putST(e, 0, "Joker's Wild");
  check(!e.canActivateMain(0, jw.uid), 'no Spell lists all 3 Knights here, so its first effect cannot be activated');
  run(e, e.sendToGrave(jw.uid, 'cost'));
  run(e, e.sendToGrave(e.player(0).deck.find((c) => c.name === "Queen's Knight")!.uid, 'cost'));
  endTurn(e, 'yes');
  check(zone(e, jw) === 'hand' && e.player(0).deck.some((c) => c.name === "Queen's Knight"), 'End Phase in the GY: shuffle a LIGHT Warrior into the Deck and add this card to the hand');
}

card('Light Barrier');
{
  const e = duel(['Light Barrier', 'Arcana Force XXI - The World'], ['Axe Raider']);
  const lb = playSpell(e, 0, 'Light Barrier');
  check(!!lb?.active && e.player(0).field?.uid === lb.uid, 'activates in the Field Zone');
  const w = place(e, 0, 'Arcana Force XXI - The World', 'atk', true, { pick: ['Tails'] });
  check(w?.tags?.coin === 2 && logHas(e, 'chosen with Light Barrier'), 'an Arcana Force Summoned: you choose the coin result');
  const axe = place(e, 1, 'Axe Raider');
  e.state.firstTurn = false;
  toBattle(e);
  const l = lp(e, 0);
  attack(e, w, axe);
  check(zone(e, axe) === 'gy' && lp(e, 0) === l + 1700, 'an Arcana Force destroys a monster by battle: gain its original ATK');
}

card('Lost Wind');
{
  const e = duel(['Lost Wind'], ['Gaia The Fierce Knight']);
  const g = place(e, 1, 'Gaia The Fierce Knight')!;
  playTrap(e, 0, 'Lost Wind');
  check(e.isNegated(g) && e.atkOf(g) === 1150, "a Special Summoned monster's effects are negated and its original ATK halved");
}
{
  const e = duel(['Lost Wind'], [], [], ['Flame Swordsman']);
  const lw = toGy(e, 0, 'Lost Wind');
  place(e, 1, 'Flame Swordsman', 'atk', true, { respond: 'Lost Wind' });
  const fc = e.fieldCard(lw.uid);
  check(!!fc && !fc.faceUp, "a monster Special Summoned from the opponent's Extra Deck: it Sets itself from the GY");
  kill(e, [fc]);
  check(zone(e, lw) === 'removed', 'banished when it leaves the field');
}

card('Magicalized Duston Mop');
{
  const e = duel(['Magicalized Duston Mop', 'Axe Raider', 'Blue Duston', 'Magicalized Duston Mop']);
  const axe = place(e, 0, 'Axe Raider');
  const mop = playSpell(e, 0, 'Magicalized Duston Mop', { pick: ['Axe Raider'] });
  check(e.untributable(axe!), 'the equipped monster cannot be Tributed');
  check(!e.canActivateMain(0, grab(e, 0, 'Magicalized Duston Mop').uid), 'you can only control 1');
  kill(e, [mop], 1, 'yes');
  check(e.player(0).hand.some((c) => c.name === 'Blue Duston'), 'destroyed by the opponent: adds a "Duston" monster');
}

card('Magnet Force');
{
  const e = duel(['Magnet Force', 'Beta The Magnet Warrior'], ['Axe Raider']);
  const beta = place(e, 0, 'Beta The Magnet Warrior')!;
  const axe = place(e, 1, 'Axe Raider')!;
  playTrap(e, 0, 'Magnet Force');
  (e as any).levelSource = axe.uid;
  (e as any).resolving = 1;
  e.actor = 1;
  check(e.shielded(beta, 'effect'), "unaffected by the opponent's monster effects");
  (e as any).levelSource = null;
  (e as any).resolving = 0;
  e.actor = null;
}

card('Mass Hypnosis');
{
  const e = duel(['Mass Hypnosis'], [FILL]);
  e.createToken('Alien Warrior', 0, 'atk', true, { atk: 1800, def: 1000, level: 4, attribute: 'EARTH', race: 'Reptile' });
  const foe = place(e, 1, FILL)!;
  (foe.tags ??= {}).aCounter = 1;
  const mh = playTrap(e, 0, 'Mass Hypnosis');
  check(e.controller(foe.uid) === 0, 'takes control of a monster with an A-Counter');
  endTurn(e);
  check(zone(e, mh) === 'gy' && e.controller(foe.uid) === 1, 'destroyed during the End Phase; the monster goes back');
}

card('Massivemorph');
{
  const e = duel(['Massivemorph'], ['Axe Raider']);
  const axe = place(e, 1, 'Axe Raider');
  playTrap(e, 0, 'Massivemorph');
  check(e.atkOf(axe!) === 3400 && e.defOf(axe!) === 2300, 'its ATK and DEF are doubled');
  e.monsters(0).forEach((m) => run(e, e.sendToGrave(m.uid, 'used')));
  toTurnOf(e, 1);
  toBattle(e);
  check(!e.canAttackWith(1, axe!), 'it cannot attack directly');
}

card('Mischief of the Yokai');
{
  const e = duel(['Mischief of the Yokai', 'Axe Raider']);
  const axe = place(e, 0, 'Axe Raider');
  const y = playTrap(e, 0, 'Mischief of the Yokai');
  const yc = e.player(0).gy.find((c) => c.name === 'Mischief of the Yokai')!;
  check(levelOf(e, axe!) === 2 && !y, 'each face-up monster loses 2 Levels');
  check(!e.canUseGraveEffect(0, yc.uid), 'its GY effect cannot be used the turn it was sent there');
  toTurn3(e);
  check(levelOf(e, axe!) === 4, 'until the End Phase');
  e.apply({ type: 'GRAVE_EFFECT', player: 0, uid: yc.uid });
  settle(e);
  check(levelOf(e, axe!) === 3 && zone(e, yc) === 'removed', 'banished from the GY: 1 monster loses 1 Level');
}

card('Necrovalley');
{
  const e = duel(['Necrovalley', "Gravekeeper's Spy", 'Axe Raider']);
  playSpell(e, 0, 'Necrovalley');
  const spy = place(e, 0, "Gravekeeper's Spy")!;
  check(e.atkOf(spy) === 1700, '"Gravekeeper\'s" monsters gain 500 ATK');
  const axe = toGy(e, 0, 'Axe Raider');
  e.banish(axe.uid);
  run(e, e.specialSummon(axe.uid, 0, 'atk'));
  e.toHand(axe.uid);
  check(zone(e, axe) === 'gy', 'cards in the GY cannot be banished, Special Summoned or returned');
}

card('Number Wall');
{
  const e = duel(['Number Wall', 'Number 49: Fortune Tune']);
  const t = putST(e, 0, 'Number Wall');
  check(!e.canActivateMain(0, t.uid), 'no "Number" monster: cannot be activated');
  const n = place(e, 0, 'Number 49: Fortune Tune')!;
  act(e, 0, t.uid);
  check(!!e.fieldCard(t.uid)?.active, 'with a "Number" monster: activated');
  kill(e, [n]);
  check(zone(e, n) === 'mz', '"Number" monsters cannot be destroyed by card effects');
}

card('Oracle of Zefra');
{
  const e = duel(['Oracle of Zefra', 'Satellarknight Zefrathuban']);
  playSpell(e, 0, 'Oracle of Zefra');
  check(e.player(0).hand.some((c) => c.name === 'Satellarknight Zefrathuban'), 'activated: it adds a "Zefra" monster from the Deck');
}

card('Overlay Regen', true);
{
  const e = duel(['Overlay Regen', 'Axe Raider', 'Gemini Elf'], [], ['Number 98: Test Wraith']);
  const c = grab(e, 0, 'Overlay Regen');
  check(!e.canActivateMain(0, c.uid), 'no Xyz Monster on the field: it cannot be activated');
  const x = xyz(e, 0, 'Number 98: Test Wraith', [place(e, 0, 'Axe Raider'), place(e, 0, 'Gemini Elf')])!;
  playSpell(e, 0, 'Overlay Regen');
  check((x.mats ?? []).length === 3 && x.mats!.some((m) => m.uid === c.uid) && zone(e, c) !== 'gy', 'it is attached to the Xyz Monster as an Xyz Material');
}

card('Pandemonium');
{
  const e = duel(['Pandemonium', 'Skull Archfiend of Lightning', 'Terrorking Archfiend']);
  playSpell(e, 0, 'Pandemonium');
  const sk = place(e, 0, 'Skull Archfiend of Lightning');
  kill(e, [sk], 1, 'yes');
  check(e.player(0).hand.some((c) => c.name === 'Terrorking Archfiend'), 'an Archfiend destroyed by an effect: a lower Level Archfiend is added');
}

card("Pharaoh's Treasure");
{
  const e = duel(["Pharaoh's Treasure", 'Pot of Greed']);
  run(e, e.sendToGrave(e.player(0).deck.find((c) => c.name === 'Pot of Greed')!.uid, 'cost'));
  const pt = putST(e, 0, "Pharaoh's Treasure");
  act(e, 0, pt.uid);
  check(zone(e, pt) === 'deck', 'shuffled face-up into the Deck');
  const d = e.player(0).deck;
  const [c] = d.splice(d.findIndex((x) => x.uid === pt.uid), 1);
  d.unshift(c);
  endTurn(e);
  endTurn(e);
  check(zone(e, pt) === 'gy' && e.player(0).hand.some((x) => x.name === 'Pot of Greed'), 'drawn: sent to the GY, then a card from the GY is added to the hand');
}

card("Pikeru's Circle of Enchantment");
{
  const e = duel(["Pikeru's Circle of Enchantment"], ['Axe Raider']);
  playTrap(e, 0, "Pikeru's Circle of Enchantment");
  e.damage(0, 800);
  check(lp(e, 0) === 4000, 'damage from card effects becomes 0');
  const axe = place(e, 1, 'Axe Raider');
  e.state.firstTurn = false;
  e.state.turnPlayer = 1;
  toBattle(e);
  attack(e, axe, null);
  check(lp(e, 0) === 2300, 'battle damage still applies');
}

card('Planckton');
{
  const e = duel(['Number 49: Fortune Tune', 'Number 103: Ragnazero', 'Planckton']);
  const n49 = place(e, 0, 'Number 49: Fortune Tune')!;
  const n103 = place(e, 0, 'Number 103: Ragnazero')!;
  const a = e.atkOf(n49);
  playTrap(e, 0, 'Planckton');
  check(e.atkOf(n49) === a + 500 && n103.tags?.noAttackTurn === e.state.turn, 'Rank 3 Xyz +500 ATK/DEF, Rank 4 Xyz cannot attack');
  endTurn(e);
  check(e.atkOf(n49) === a, 'until the end of the turn');
}

card('Raging Cloudian');
{
  const e = duel(['Raging Cloudian', 'Cloudian - Altus']);
  place(e, 0, 'Cloudian - Altus', 'def');
  const alt = e.player(0).gy.find((c) => c.name === 'Cloudian - Altus');
  check(zone(e, alt) === 'gy', '(a Cloudian in face-up Defense Position destroys itself)');
  playTrap(e, 0, 'Raging Cloudian');
  const m = e.fieldCard(alt!.uid);
  check(!!m && m.pos === 'atk' && m.tags?.fog === 1, 'it is Special Summoned in Attack Position with a Fog Counter');
}

card('Rainbow Life');
{
  const e = duel(['Rainbow Life', 'Pot of Greed'], ['Axe Raider']);
  grab(e, 0, 'Pot of Greed');
  const n = e.player(0).hand.length;
  playTrap(e, 0, 'Rainbow Life', { pick: ['Pot of Greed'] });
  check(e.player(0).hand.length === n - 1, 'discard 1 card');
  e.damage(0, 500);
  check(lp(e, 0) === 4500, 'damage this turn is gained as LP instead');
}

card('Rank-Up-Magic Quick Chaos', true);
{
  const e = duel(['Rank-Up-Magic Quick Chaos', 'Axe Raider', 'Gemini Elf'], [], ['Number 98: Test Wraith', 'Number C98: Test Chaos Wraith']);
  const x = xyz(e, 0, 'Number 98: Test Wraith', [place(e, 0, 'Axe Raider'), place(e, 0, 'Gemini Elf')])!;
  playSpell(e, 0, 'Rank-Up-Magic Quick Chaos');
  const c = e.monsters(0).find((m) => m.name === 'Number C98: Test Chaos Wraith');
  const mats = (c?.mats ?? []).map((m) => m.name);
  check(!!c && !!c.tags?.xyzS && mats.includes('Number 98: Test Wraith') && mats.includes('Axe Raider') && mats.includes('Gemini Elf') && zone(e, x) !== 'gy', 'Xyz Summons the "Number C" monster using the target as material (its materials carry over)');
}

card('Reverse Breaker', true);
{
  const e = duel(['Reverse Breaker'], ['Mirror Force']);
  const u = e.createToken('Number 39: Utopia', 0, 'atk', true, { atk: 2500, def: 2000, level: 4, attribute: 'LIGHT', race: 'Warrior' })!;
  const rb = playSpell(e, 0, 'Reverse Breaker');
  check(zone(e, rb) === 'sz' && u.equips.includes(rb!.uid), 'equips to a "Utopia" monster');
  const mf = putST(e, 1, 'Mirror Force');
  toTurn3(e);
  toBattle(e);
  attack(e, e.fieldCard(u.uid), null);
  check(zone(e, mf) === 'gy' && lp(e, 1) === 4000 - 2500, 'the equipped monster declares an attack: a Spell/Trap the opponent controls is destroyed (no response with it)');
}

card('Rise of the Snake Deity');
{
  const e = duel(['Rise of the Snake Deity', 'Vennominon the King of Poisonous Snakes', 'Vennominaga the Deity of Poisonous Snakes']);
  const t = putST(e, 0, 'Rise of the Snake Deity');
  check(!e.canActivateMain(0, t.uid), 'nothing destroyed: cannot be activated');
  const v = place(e, 0, 'Vennominon the King of Poisonous Snakes');
  kill(e, [v]);
  act(e, 0, t.uid);
  check(e.monsters(0).some((m) => m.name === 'Vennominaga the Deity of Poisonous Snakes'), 'Vennominon destroyed by an effect: Vennominaga is Special Summoned from the Deck');
}

card('Roll Out!');
{
  const e = duel(['Roll Out!', 'Y-Dragon Head', 'X-Head Cannon']);
  const y = toGy(e, 0, 'Y-Dragon Head');
  const x = place(e, 0, 'X-Head Cannon')!;
  playTrap(e, 0, 'Roll Out!');
  check(zone(e, y) === 'sz' && x.equips.includes(y.uid), 'a Union monster in the GY is equipped to an appropriate monster');
}

card('Scroll of Bewitchment');
{
  const e = duel(['Scroll of Bewitchment', 'Axe Raider']);
  const axe = place(e, 0, 'Axe Raider')!;
  const s = playSpell(e, 0, 'Scroll of Bewitchment', { pick: ['Axe Raider'] }, { pick: ['WATER'] });
  check(attrOf(e, axe) === 'WATER' && s?.equippedTo === axe.uid, 'the equipped monster becomes the chosen Attribute');
  kill(e, [s]);
  check(attrOf(e, axe) === 'EARTH', 'it leaves the field: the Attribute is back');
}

card('Shadow of Eyes');
{
  const e = duel(['Shadow of Eyes'], ['Axe Raider', 'Ookazi']);
  putST(e, 0, 'Shadow of Eyes');
  toTurnOf(e, 1);
  const axe = summon(e, 1, 'Axe Raider', false);
  playSpell(e, 1, 'Ookazi', { respond: 'Shadow of Eyes' });
  check(axe!.faceUp && axe!.pos === 'atk', 'the Set monster is changed to face-up Attack Position');
}

card('Solemn Authority');
{
  const e = duel(['Solemn Authority', 'Thor, Test Aesir']);
  const thor = place(e, 0, 'Thor, Test Aesir')!;
  const sa = playTrap(e, 0, 'Solemn Authority');
  check(active(e, sa) && e.untargetable(thor), 'the "Aesir" monster cannot be targeted by other card effects');
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  check(zone(e, sa) === 'sz', 'still there after your 1st Standby Phase');
  toTurnOf(e, 1);
  toTurnOf(e, 0);
  check(zone(e, sa) === 'gy' && !e.untargetable(thor), 'sent to the GY during your 2nd Standby Phase');
}

card('Soul Exchange', true);
{
  const e = duel(['Soul Exchange', 'Summoned Skull'], ['Axe Raider']);
  const axe = place(e, 1, 'Axe Raider')!;
  playSpell(e, 0, 'Soul Exchange', { pick: ['Axe Raider'] });
  const sk = summon(e, 0, 'Summoned Skull', true, { pick: ['Axe Raider'] });
  check(!!sk && zone(e, axe) === 'gy' && e.find(axe.uid)!.loc.player === 1, "the opponent's monster is Tributed for a Tribute Summon");
  e.state.firstTurn = false;
  toBattle(e);
  check(!e.canAttackWith(0, sk!), 'no Battle Phase that turn');
}

card('Spikeshield with Chain');
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

card('Star Light, Star Bright');
{
  const e = duel(['Star Light, Star Bright', 'Summoned Skull', 'Dark Magician']);
  place(e, 0, 'Summoned Skull');
  const dm = place(e, 0, 'Dark Magician')!;
  playSpell(e, 0, 'Star Light, Star Bright', { pick: ['Summoned Skull'] });
  check(levelOf(e, dm) === 6, 'a monster with the same ATK becomes the same Level');
  endTurn(e);
  check(levelOf(e, dm) === 7, 'until the End Phase');
}

card('The Big Cattle Drive', true);
{
  const e = duel(['The Big Cattle Drive', 'Gazelle the King of Mythical Beasts', 'Harpie Lady', 'Dian Keto the Cure Master', 'Reinforcements']);
  place(e, 0, 'Gazelle the King of Mythical Beasts');
  place(e, 0, 'Harpie Lady');
  grab(e, 0, 'The Big Cattle Drive');
  const dk = grab(e, 0, 'Dian Keto the Cure Master');
  const rf = putST(e, 0, 'Reinforcements');
  const hand = e.player(0).hand.length;
  playSpell(e, 0, 'The Big Cattle Drive');
  check(e.player(0).hand.length === hand - 1 + 2, 'draw 1 card for each of Beast / Beast-Warrior / Winged Beast you control (2)');
  check(!e.canActivateMain(0, dk.uid) && !e.canActivateMain(0, rf.uid), 'no other Spell/Trap Cards can be activated that turn');
}
{
  const e = duel(['The Big Cattle Drive', 'Gazelle the King of Mythical Beasts', 'Dian Keto the Cure Master']);
  place(e, 0, 'Gazelle the King of Mythical Beasts');
  playSpell(e, 0, 'Dian Keto the Cure Master');
  check(!e.canActivateMain(0, grab(e, 0, 'The Big Cattle Drive').uid), 'not after you activated another Spell this turn');
}

card('Triangle Ecstasy Spark');
{
  const e = duel(['Triangle Ecstasy Spark', 'Harpie Lady Sisters'], ['Mirror Force']);
  e.state.fx.ignoreCond = e.player(0).deck.find((c) => c.name === 'Harpie Lady Sisters')!.uid;
  const hls = place(e, 0, 'Harpie Lady Sisters');
  const mf = putST(e, 1, 'Mirror Force');
  playSpell(e, 0, 'Triangle Ecstasy Spark');
  check(e.atkOf(hls!) === 2700, '"Harpie Lady Sisters" become 2700 ATK');
  check(e.activationBlocked(1, mf), 'the opponent cannot activate Traps this turn');
}

card('Worm Bait', true);
{
  const e = duel(['Worm Bait', 'Petit Moth']);
  const wb = grab(e, 0, 'Worm Bait');
  check(!e.canActivateMain(0, wb.uid), 'needs an Insect monster');
  place(e, 0, 'Petit Moth');
  playSpell(e, 0, 'Worm Bait');
  check(e.monsters(0).filter((m) => m.name === 'Worm Token').length === 2, 'Special Summons 2 Worm Tokens');
  check(e.summonBlocked(0, grab(e, 0, FILL), 'normal', 'hand'), 'Level 3 or 4 monsters cannot be Summoned this turn');
}
{
  const e = duel(['Worm Bait', 'Petit Moth']);
  place(e, 0, 'Petit Moth');
  summon(e, 0, FILL);
  check(!e.canActivateMain(0, grab(e, 0, 'Worm Bait').uid), 'not after you Summoned a Level 3 or 4 monster this turn');
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
console.log(`H: ${checked} cards checked, ${fixed} fixed`);
process.exit(fails ? 1 : 0);
