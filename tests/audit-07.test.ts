// Speed Duel card scripts of batch 07 (run: npx tsx tests/audit-07.test.ts)
// audit-07: one or more targeted checks per scripted card: its main effect really happens in a duel.
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


// ---------- audit-07 extras ----------
import type { CardInfo } from '../src/eds/types';
/** Test-only stand-ins for cards the pool lacks. */
const fake = (info: Partial<CardInfo> & { name: string }) => {
  const full = { id: 970000 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
fake({ name: 'Noble Knight Test Squire', sub: 'Normal', level: 4, atk: 1500, def: 1000, race: 'Warrior', attribute: 'LIGHT', vanilla: true });
fake({ name: 'Noble Knight Test Lord', level: 5, atk: 2000, def: 1000, race: 'Warrior', attribute: 'LIGHT' });
fake({ name: 'Test Dracoslayer', level: 4, atk: 1800, def: 1000, race: 'Dragon', attribute: 'LIGHT' });
fake({ name: 'Test Dracoverlord', level: 4, atk: 1800, def: 1000, race: 'Dragon', attribute: 'DARK' });
fake({ name: 'Metalfoes Test Steel', level: 4, atk: 1700, def: 1000, race: 'Psychic', attribute: 'FIRE' });
fake({ name: 'Mikanko Test Dancer', level: 4, atk: 1500, def: 1000, race: 'Fairy', attribute: 'LIGHT' });

/** Special Summons a card that only its own procedure may Summon (the test sets it up directly). */
function force(e: Engine, p: Pid, name: string, pos: Pos = 'atk'): FieldCard | null {
  const c = [...e.player(p).deck, ...e.player(p).gy, ...e.player(p).fusion, ...e.player(p).hand].find((x) => x.name === name)!;
  e.state.fx.ignoreCond = c.uid;
  const f = place(e, p, name, pos);
  e.state.fx.ignoreCond = undefined;
  return f;
}
/** Sends a card of `p` (Deck or hand) to the GY. */
function toGy(e: Engine, p: Pid, name: string): Card {
  const c = [...e.player(p).deck, ...e.player(p).hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.sendToGrave(c.uid, 'mill'));
  return c;
}
/** Banishes a card of `p` from the Deck or hand. */
function toBanished(e: Engine, p: Pid, name: string): Card {
  const c = [...e.player(p).deck, ...e.player(p).hand].find((x) => x.name === name)!;
  e.banish(c.uid);
  return c;
}
const special = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'SPECIAL', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const graveFx = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'GRAVE_EFFECT', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const flipSummon = (e: Engine, p: Pid, m: FieldCard, ...ans: Ans[]) => {
  e.apply({ type: 'FLIP_SUMMON', player: p, uid: m.uid });
  return settle(e, ...ans);
};
/** Ends the turn so the other player gets a turn that is not the first. */
const toTurn2 = (e: Engine) => endTurn(e);
const inHandOf = (e: Engine, p: Pid, c: Card) => e.player(p).hand.some((x) => x.uid === c.uid);
const noop = function* (): Generator<any, any, any> {};

// ======================= J =======================
section('Jinzo - Returner');
{
  const e = duel(['Jinzo - Returner', 'Jinzo'], [FILL]);
  const j = place(e, 0, 'Jinzo')!;
  kill(e, [j]);
  const r = place(e, 0, 'Jinzo - Returner')!;
  check(e.canAttackDirectly(r), 'can attack directly');
  kill(e, [r], undefined, 'yes');
  check(zone(e, j) === 'mz', 'sent to the GY: Special Summons "Jinzo" from the GY');
  endTurn(e);
  check(zone(e, j) === 'gy', 'that Jinzo is destroyed during your End Phase');
}

section('Jowls of Dark Demise');
{
  const e = duel(['Jowls of Dark Demise'], [FILL]);
  const foe = place(e, 1, FILL)!;
  const j = place(e, 0, 'Jowls of Dark Demise', 'def', false)!;
  flipSummon(e, 0, j);
  check(e.controller(foe.uid) === 0, 'FLIP: takes control of an opponent\'s monster');
  check(e.canAttackDirectly(foe), 'the taken monster can attack directly');
  endTurn(e);
  check(e.controller(foe.uid) === 1, 'it goes back at the end of the turn');
}

section('Judgment of Anubis');
{
  const e = duel([FILL, 'Judgment of Anubis'], ['Mystical Space Typhoon'], [], [], 1);
  const foe = place(e, 1, FILL)!;
  const ja = putST(e, 0, 'Judgment of Anubis');
  grab(e, 0, FILL);
  const mst = grab(e, 1, 'Mystical Space Typhoon');
  act(e, 1, mst.uid, { respond: 'Judgment of Anubis' }, 'yes');
  check(zone(e, mst) === 'gy' && zone(e, ja) === 'gy', 'negates the Spell that destroys a Spell/Trap, and destroys it');
  check(zone(e, foe) === 'gy' && lp(e, 1) === 4000 - 1400, 'then destroys a face-up monster and inflicts damage equal to its ATK');
}

section('Junk Puppet');
{
  const e = duel(['Junk Puppet', 'Junk Puppet', 'Gimmick Puppet Des Troy']);
  const g = toGy(e, 0, 'Gimmick Puppet Des Troy');
  playSpell(e, 0, 'Junk Puppet');
  check(zone(e, g) === 'mz', 'Special Summons a "Gimmick Puppet" from the GY');
  toGy(e, 0, FILL);
  check(!e.canActivateMain(0, grab(e, 0, 'Junk Puppet').uid), 'only 1 "Junk Puppet" per turn');
}

section('Jurassic World');
{
  const e = duel(['Jurassic World', 'Jurrac Iguanon']);
  playSpell(e, 0, 'Jurassic World');
  const ig = place(e, 0, 'Jurrac Iguanon')!;
  const cg = place(e, 0, FILL)!;
  check(e.atkOf(ig) === 2000 && e.defOf(ig) === 1000 && e.atkOf(cg) === 1400, 'Dinosaur monsters gain 300 ATK/DEF');
}

section('Jurrac Herra');
{
  const e = duel(['Jurrac Herra', 'Jurrac Iguanon'], [FILL]);
  const h = grab(e, 0, 'Jurrac Herra');
  const ig = place(e, 0, 'Jurrac Iguanon', 'def')!;
  toTurn2(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, ig, 'yes');
  check(zone(e, ig) === 'gy' && zone(e, h) === 'mz', 'a Defense Position "Jurrac" destroyed by battle: Special Summons it from the hand');
}
{
  const e = duel(['Jurrac Herra', 'Jurrac Iguanon'], [FILL]);
  const h = toGy(e, 0, 'Jurrac Herra');
  const ig = place(e, 0, 'Jurrac Iguanon', 'def')!;
  toTurn2(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, ig, 'yes');
  check(zone(e, h) === 'mz', '... or from the GY');
}
{
  const e = duel(['Jurrac Herra', 'Jurrac Spinos'], ['Jinzo']);
  const h = grab(e, 0, 'Jurrac Herra');
  const sp = place(e, 0, 'Jurrac Spinos')!;
  toTurn2(e);
  e.player(1).hand.length;
  const foe = place(e, 1, 'Jinzo')!;
  sp.atkMod = -500;
  toBattle(e);
  attack(e, foe, sp, 'yes');
  check(zone(e, sp) === 'gy' && zone(e, h) === 'hand', 'not for an Attack Position monster');
}

section('Jurrac Iguanon');
{
  const e = duel(['Jurrac Iguanon'], [FILL, 'Trap Hole']);
  const ig = place(e, 0, 'Jurrac Iguanon')!;
  const foe = place(e, 1, FILL)!;
  const th = putST(e, 1, 'Trap Hole');
  toTurn3(e);
  toBattle(e);
  attack(e, ig, foe, 'yes');
  check(zone(e, foe) === 'gy' && zone(e, th) === 'hand', 'destroys a monster by battle: returns a Set card to the hand');
}

section('Jurrac Protops');
{
  const e = duel(['Jurrac Protops'], [FILL, FILL]);
  const pr = place(e, 0, 'Jurrac Protops')!;
  place(e, 1, FILL);
  place(e, 1, FILL);
  check(e.atkOf(pr) === 1900, 'gains 100 ATK for each monster the opponent controls');
}

section('Jurrac Spinos');
{
  const e = duel(['Jurrac Spinos'], [FILL]);
  const sp = place(e, 0, 'Jurrac Spinos')!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, sp, foe);
  const tk = e.monsters(1).find((m) => m.name === 'Spinos Token');
  check(zone(e, foe) === 'gy' && !!tk && tk.pos === 'atk' && e.atkOf(tk) === 300, 'destroys a monster by battle: a 300 ATK "Spinos Token" on the opponent\'s field');
}

section('Jurrac Stauriko');
{
  const e = duel(['Jurrac Stauriko', 'Jinzo', 'Jurrac Herra'], [FILL]);
  const st = place(e, 0, 'Jurrac Stauriko')!;
  toTurn2(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, st);
  const toks = e.monsters(0).filter((m) => m.name === 'Jurrac Token');
  check(zone(e, st) === 'gy' && toks.length === 2 && toks.every((m) => m.pos === 'def'), 'destroyed by battle: 2 "Jurrac Tokens" in Defense Position');
  endTurn(e);
  const jinzo = grab(e, 0, 'Jinzo');
  const herra = grab(e, 0, 'Jurrac Herra');
  check(!e.canNormalSummon(0, jinzo, true) && e.canNormalSummon(0, herra, true), 'the Tokens can only be Tributed for a "Jurrac" monster');
}

section('Jurrac Tyrannus');
{
  const e = duel(['Jurrac Tyrannus', 'Jurrac Iguanon'], [FILL]);
  const ty = place(e, 0, 'Jurrac Tyrannus')!;
  const ig = place(e, 0, 'Jurrac Iguanon', 'def', false)!;
  effect(e, 0, ty, { pick: ['Jurrac Iguanon'] });
  check(zone(e, ig) === 'gy' && e.atkOf(ty) === 3000, 'Tributes a Dinosaur (even a face-down one): gains 500 ATK');
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, ty, foe);
  check(zone(e, foe) === 'gy' && e.atkOf(ty) === 3300, 'destroys a monster by battle: gains 300 ATK');
}

section('Justi-Break');
{
  const e = duel([FILL, 'Kaibaman', 'Justi-Break'], ['Jurrac Iguanon']);
  const cg = place(e, 0, FILL)!;
  const kb = place(e, 0, 'Kaibaman', 'def')!;
  putST(e, 0, 'Justi-Break');
  toTurn2(e);
  const ig = place(e, 1, 'Jurrac Iguanon')!;
  toBattle(e);
  attack(e, ig, cg, { respond: 'Justi-Break' });
  check(zone(e, ig) === 'gy' && zone(e, kb) === 'gy' && zone(e, cg) === 'mz', 'destroys every monster except face-up Attack Position Normal Monsters');
}

// ======================= K =======================
section('Kaibaman');
{
  const e = duel(['Kaibaman', 'Blue-Eyes White Dragon']);
  const bewd = grab(e, 0, 'Blue-Eyes White Dragon');
  const kb = place(e, 0, 'Kaibaman')!;
  effect(e, 0, kb);
  check(zone(e, kb) === 'gy' && zone(e, bewd) === 'mz', 'Tributes itself: Special Summons Blue-Eyes White Dragon from the hand');
}

section('Kaiser Glider');
{
  const e = duel(['Kaiser Glider'], ['Jinzo', FILL]);
  const kg = place(e, 0, 'Kaiser Glider')!;
  const jz = place(e, 1, 'Jinzo')!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, kg, jz);
  check(zone(e, jz) === 'gy' && zone(e, kg) === 'mz', 'not destroyed by battle with a monster with the same ATK');
  kill(e, [kg], 1, { pick: [FILL] });
  check(zone(e, kg) === 'gy' && zone(e, foe) === 'hand', 'destroyed: returns a monster on the field to the hand');
}

section('Kelbek');
{
  const e = duel(['Kelbek'], [FILL]);
  const kb = place(e, 0, 'Kelbek', 'def')!;
  toTurn2(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, kb);
  check(zone(e, foe) === 'hand' && zone(e, kb) === 'mz', 'a monster that attacks it returns to the hand');
}

section('Keldo');
{
  const e = duel(['Keldo'], ['Jinzo', 'Trap Hole', 'Mystical Space Typhoon']);
  const kd = place(e, 0, 'Keldo')!;
  toGy(e, 1, 'Trap Hole');
  toGy(e, 1, 'Mystical Space Typhoon');
  toTurn2(e);
  const jz = place(e, 1, 'Jinzo')!;
  toBattle(e);
  attack(e, jz, kd);
  check(zone(e, kd) === 'gy' && e.player(1).gy.length === 0, 'destroyed by battle: 2 cards from the opponent\'s GY go into their Deck');
}

section('King of the Skull Servants');
{
  const e = duel(['King of the Skull Servants', 'Skull Servant', 'Skull Servant'], ['Jinzo']);
  toGy(e, 0, 'Skull Servant');
  toGy(e, 0, 'Skull Servant');
  const k = place(e, 0, 'King of the Skull Servants')!;
  check(e.atkOf(k) === 2000, 'original ATK = 1000 x "Skull Servant"s in the GY');
  toTurn2(e);
  const jz = place(e, 1, 'Jinzo')!;
  toBattle(e);
  attack(e, jz, k, 'yes');
  check(zone(e, k) === 'mz' && e.player(0).removed.length === 1, 'destroyed by battle: banishes a Skull Servant to Special Summon itself');
}

section('King of the Swamp');
{
  const e = duel(['King of the Swamp', 'Polymerization']);
  const k = grab(e, 0, 'King of the Swamp');
  effect(e, 0, k);
  check(zone(e, k) === 'gy' && e.player(0).hand.some((c) => c.name === 'Polymerization'), 'discarded: adds "Polymerization" from the Deck');
}

section("King's Knight");
{
  const e = duel(["King's Knight", "Queen's Knight", "Jack's Knight"]);
  place(e, 0, "Queen's Knight");
  summon(e, 0, "King's Knight", true, 'yes');
  check(e.monsters(0).some((m) => m.name === "Jack's Knight"), 'Normal Summoned while you control "Queen\'s Knight": Special Summons "Jack\'s Knight"');
}

section('Kycoo the Ghost Destroyer');
{
  const e = duel(['Kycoo the Ghost Destroyer'], ['Jinzo', 'Kaibaman', 'Trap Hole']);
  const a = toGy(e, 1, 'Jinzo');
  const b = toGy(e, 1, 'Kaibaman');
  const ky = place(e, 0, 'Kycoo the Ghost Destroyer')!;
  toTurn3(e);
  toBattle(e);
  attack(e, ky, null, 'yes', { pick: ['Jinzo', 'Kaibaman'] });
  check(zone(e, a) === 'removed' && zone(e, b) === 'removed', 'inflicts battle damage: banishes up to 2 monsters from the opponent\'s GY');
  const th = toGy(e, 1, 'Trap Hole');
  run(e, e.as(1, (function* () {
    e.banish(th.uid);
  })()));
  check(zone(e, th) === 'gy', 'the opponent cannot banish cards from the GY');
  run(e, e.as(0, (function* () {
    e.banish(th.uid);
  })()));
  check(zone(e, th) === 'removed', 'its controller still can');
}

// ======================= L =======================
section('Labyrinth of Nightmare');
{
  const e = duel(['Labyrinth of Nightmare'], [FILL]);
  const cg = place(e, 0, FILL)!;
  const foe = place(e, 1, FILL)!;
  playTrap(e, 0, 'Labyrinth of Nightmare');
  endTurn(e);
  check(cg.pos === 'def' && foe.pos === 'atk', "End Phase: the turn player's face-up monsters change battle position");
}

section('Lady Assailant of Flames');
{
  const e = duel(['Lady Assailant of Flames']);
  const la = place(e, 0, 'Lady Assailant of Flames', 'def', false)!;
  const deck = e.player(0).deck.length;
  flipSummon(e, 0, la);
  check(e.player(0).deck.length === deck - 3 && e.player(0).removed.length === 3 && lp(e, 1) === 3200, 'FLIP: banishes the top 3 cards of the Deck and inflicts 800 damage');
}

section('Lady of the Lake');
{
  const e = duel(['Lady of the Lake', 'Noble Knight Test Squire']);
  const sq = toGy(e, 0, 'Noble Knight Test Squire');
  summon(e, 0, 'Lady of the Lake', true, 'yes');
  check(zone(e, sq) === 'mz', 'Normal Summoned: Special Summons a "Noble Knight" Normal Monster from the GY');
}
{
  const e = duel(['Lady of the Lake', 'Noble Knight Test Lord']);
  const lady = toGy(e, 0, 'Lady of the Lake');
  const lord = place(e, 0, 'Noble Knight Test Lord')!;
  graveFx(e, 0, lady);
  check(levelOf(e, lord) === 4 && zone(e, lady) === 'mz', 'in the GY: a Level 5 "Noble Knight" becomes Level 4 and it Special Summons itself');
}

section('Lava Golem');
{
  const e = duel(['Lava Golem'], [FILL, FILL]);
  const lg = grab(e, 0, 'Lava Golem');
  check(e.summonBlocked(0, lg, 'special', 'gy'), 'must first be Special Summoned by its own procedure');
  const a = place(e, 1, FILL)!;
  const b = place(e, 1, FILL)!;
  special(e, 0, lg);
  check(zone(e, a) === 'gy' && zone(e, b) === 'gy' && e.controller(lg.uid) === 1, "Tributes 2 of the opponent's monsters to Special Summon it to their field");
  check(e.player(0).normalSummoned, 'you cannot Normal Summon that turn');
  endTurn(e);
  check(lp(e, 1) === 3000, 'its controller takes 1000 damage in their Standby Phase');
}

section('Ledger of Legerdemain');
{
  const e = duel(['Ledger of Legerdemain', 'Ledger of Legerdemain']);
  const ledger = grab(e, 0, 'Ledger of Legerdemain');
  const top = e.player(0).deck.slice(0, 3);
  act(e, 0, ledger.uid);
  const banished = e.player(0).removed.slice();
  check(banished.length === 3 && top.every((c) => zone(e, c) === 'removed'), 'banishes the top 3 cards of the Deck');
  check(!e.canActivateMain(0, grab(e, 0, 'Ledger of Legerdemain').uid), 'only 1 per turn');
  for (let i = 0; i < 4; i++) endTurn(e);
  check(banished.every((c) => zone(e, c) === 'removed'), 'still banished at the 2nd Standby Phase');
  endTurn(e);
  endTurn(e);
  check(banished.every((c) => zone(e, c) === 'hand'), 'the 3 cards come back to the hand at the 3rd Standby Phase');
}

section('Legendary Fiend');
{
  const e = duel(['Legendary Fiend']);
  const lf = place(e, 0, 'Legendary Fiend')!;
  toTurn3(e);
  check(e.atkOf(lf) === 2200, 'gains 700 ATK in your Standby Phase');
}

section('Legendary Jujitsu Master');
{
  const e = duel(['Legendary Jujitsu Master'], [FILL]);
  const lj = place(e, 0, 'Legendary Jujitsu Master', 'def')!;
  toTurn2(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, lj);
  check(e.player(1).deck[0]?.uid === foe.uid, 'the monster that battled it goes on top of the Deck');
}

section('Lekunga');
{
  const e = duel(['Lekunga', 'Mermail Abyssgunde', 'Mermail Abyssteus']);
  toGy(e, 0, 'Mermail Abyssgunde');
  toGy(e, 0, 'Mermail Abyssteus');
  const lk = place(e, 0, 'Lekunga')!;
  effect(e, 0, lk);
  const tk = e.monsters(0).find((m) => m.name === 'Lekunga Token');
  check(e.player(0).removed.length === 2 && !!tk && e.atkOf(tk) === 700, 'banishes 2 WATER monsters from the GY: a 700/700 "Lekunga Token"');
}

section('Lesser Fiend');
{
  const e = duel(['Lesser Fiend'], [FILL]);
  const lf = place(e, 0, 'Lesser Fiend')!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, lf, foe);
  check(zone(e, foe) === 'removed', 'banishes a monster it destroys by battle');
}

section('Level Up!');
{
  const e = duel(['Level Up!', 'Armed Dragon LV3', 'Armed Dragon LV5']);
  const l3 = place(e, 0, 'Armed Dragon LV3')!;
  playSpell(e, 0, 'Level Up!');
  check(zone(e, l3) === 'gy' && e.monsters(0).some((m) => m.name === 'Armed Dragon LV5'), 'sends an "LV" monster to the GY: Special Summons the monster its text lists');
}

section('Levia-Dragon - Daedalus');
{
  const e = duel(['Levia-Dragon - Daedalus', 'Umi', FILL], [FILL, 'Trap Hole']);
  const umi = playSpell(e, 0, 'Umi')!;
  const ld = place(e, 0, 'Levia-Dragon - Daedalus')!;
  const mine = place(e, 0, FILL)!;
  const foe = place(e, 1, FILL)!;
  const th = putST(e, 1, 'Trap Hole');
  effect(e, 0, ld);
  check(zone(e, umi) === 'gy' && [mine, foe, th].every((c) => zone(e, c) === 'gy') && zone(e, ld) === 'mz', 'sends "Umi" to the GY: destroys all other cards on the field');
}

section('Lightning Blade');
{
  const e = duel(['Lightning Blade', 'Mermail Abyssgunde'], [FILL]);
  const cg = place(e, 0, FILL)!;
  const mm = place(e, 0, 'Mermail Abyssgunde')!;
  playSpell(e, 0, 'Lightning Blade', { pick: [FILL] });
  check(e.atkOf(cg) === 2200 && e.atkOf(mm) === 900, 'the Warrior gains 800 ATK; WATER monsters lose 500 ATK');
}

section('Lightray Gearfried');
{
  const e = duel(['Lightray Gearfried', 'Kaibaman', "Queen's Knight", "Jack's Knight", "King's Knight", 'Kaiser Glider', 'Trap Hole'], ['Mystical Space Typhoon']);
  const lg = grab(e, 0, 'Lightray Gearfried');
  check(e.summonBlocked(0, lg, 'special', 'hand') && !e.canSpecialProc(0, lg), 'needs 5 LIGHT monsters with different names in the GY, and no other Special Summon');
  for (const n of ['Kaibaman', "Queen's Knight", "Jack's Knight", "King's Knight", 'Kaiser Glider']) toGy(e, 0, n);
  special(e, 0, lg);
  check(zone(e, lg) === 'mz', 'Special Summoned from the hand with 5 LIGHT monsters in the GY');
  toTurn2(e);
  const th = putST(e, 0, 'Trap Hole');
  void th;
  const mst = grab(e, 1, 'Mystical Space Typhoon');
  act(e, 1, mst.uid, { respond: 'Lightray Gearfried' });
  check(zone(e, mst) === 'gy' && e.player(0).removed.length === 1, 'banishes a Warrior from the GY: negates the Spell and destroys it');
}

section('Lightray Sorcerer');
{
  const e = duel(['Lightray Sorcerer', 'Kaibaman', "Queen's Knight", "Jack's Knight"], [FILL]);
  const ls = grab(e, 0, 'Lightray Sorcerer');
  for (const n of ['Kaibaman', "Queen's Knight", "Jack's Knight"]) toBanished(e, 0, n);
  special(e, 0, ls);
  check(zone(e, ls) === 'mz', 'Special Summoned while 3 LIGHT monsters are banished');
  const foe = place(e, 1, FILL)!;
  effect(e, 0, ls, { pick: ['Kaibaman'] }, { pick: [FILL] });
  check(zone(e, foe) === 'removed' && e.player(0).removed.length === 2, 'shuffles a banished LIGHT monster into the Deck and banishes a face-up monster');
  check(e.player(0).deck.some((c) => c.name === 'Kaibaman') && (e.fieldCard(ls.uid)!.tags?.noAttackTurn ?? -1) === e.state.turn, 'and it cannot attack this turn');
}

section('Limit Impulse');
{
  const e = duel(['Limit Impulse', FILL, FILL, 'Jinzo']);
  grab(e, 0, FILL);
  grab(e, 0, FILL);
  playTrap(e, 0, 'Limit Impulse', { pick: [FILL, FILL] });
  const toks = e.monsters(0).filter((m) => m.name === 'Soul Token');
  check(toks.length === 2 && e.player(0).gy.filter((c) => c.name === FILL).length === 2, 'sends 2 cards from the hand to the GY: 2 "Soul Tokens"');
  check(toks.every((m) => !!m.tags?.summonTribOnly) && e.canNormalSummon(0, grab(e, 0, 'Jinzo'), true), 'they can be Tributed for a Tribute Summon (but not for costs)');
}

section('Limit Reverse');
{
  const e = duel(['Limit Reverse', 'Kaibaman', 'Kelbek']);
  const kb = toGy(e, 0, 'Kaibaman');
  toGy(e, 0, 'Kelbek');
  const lr = playTrap(e, 0, 'Limit Reverse', { pick: ['Kaibaman'] })!;
  const m = e.fieldCard(kb.uid);
  check(!!m && m.pos === 'atk' && active(e, lr), 'Special Summons a monster with 1000 or less ATK from the GY in Attack Position');
  m!.pos = 'def';
  run(e, noop());
  check(zone(e, kb) === 'gy' && zone(e, lr) === 'gy', 'changed to Defense Position: both are destroyed');
}
{
  const e = duel(['Limit Reverse', 'Kaibaman']);
  const kb = toGy(e, 0, 'Kaibaman');
  const lr = playTrap(e, 0, 'Limit Reverse')!;
  kill(e, [lr]);
  check(zone(e, kb) === 'gy', 'it leaves the field: the monster is destroyed');
}

section('Little-Winguard');
{
  const e = duel(['Little-Winguard']);
  const lw = place(e, 0, 'Little-Winguard')!;
  endTurn(e, 'yes');
  check(lw.pos === 'def', 'your End Phase: changes its battle position');
}

section('Living Fossil');
{
  const e = duel(['Living Fossil', FILL, 'Living Fossil']);
  const cg = toGy(e, 0, FILL);
  const lf = playSpell(e, 0, 'Living Fossil')!;
  const m = e.fieldCard(cg.uid)!;
  check(!!m && e.atkOf(m) === 400 && e.defOf(m) === 200 && m.tags?.negated === 1, 'Special Summons a Level 4 or lower monster: -1000 ATK/DEF, effects negated');
  check(!e.canActivateMain(0, grab(e, 0, 'Living Fossil').uid), 'only 1 per turn');
  kill(e, [lf]);
  check(zone(e, cg) === 'removed', 'it leaves the field: the monster is banished');
}

section('Lord Poison');
{
  const e = duel(['Lord Poison', 'Lekunga'], ['Jinzo']);
  const lk = toGy(e, 0, 'Lekunga');
  const lp0 = place(e, 0, 'Lord Poison')!;
  toTurn2(e);
  const jz = place(e, 1, 'Jinzo')!;
  toBattle(e);
  attack(e, jz, lp0);
  check(zone(e, lp0) === 'gy' && zone(e, lk) === 'mz', 'destroyed by battle: Special Summons a Plant from the GY');
}

section('Lost Blue Breaker');
{
  const e = duel(['Lost Blue Breaker', 'Mermail Abyssgunde'], ['Trap Hole']);
  const lb = place(e, 0, 'Lost Blue Breaker')!;
  check(!e.canUseMonsterEffect(0, lb), 'needs another face-up Fish, Sea Serpent or Aqua monster');
  place(e, 0, 'Mermail Abyssgunde');
  const th = putST(e, 1, 'Trap Hole');
  effect(e, 0, lb);
  check(zone(e, lb) === 'gy' && zone(e, th) === 'gy', 'Tributes itself: destroys a Spell/Trap');
}

section('Loud Cloud the Storm Serpent');
{
  const e = duel(['Loud Cloud the Storm Serpent', 'Jurrac Iguanon', 'Jurrac Protops', 'Caam, Serenity of Gusto'], [FILL]);
  const lc = grab(e, 0, 'Loud Cloud the Storm Serpent');
  check(e.summonBlocked(0, lc, 'special', 'gy'), 'must first be Special Summoned by its own procedure');
  toGy(e, 0, 'Jurrac Iguanon');
  toGy(e, 0, 'Jurrac Protops');
  toGy(e, 0, 'Caam, Serenity of Gusto');
  special(e, 0, lc);
  check(zone(e, lc) === 'mz' && e.player(0).removed.length === 2, 'Special Summoned by banishing a FIRE and a WIND monster from the GY');
  const foe = place(e, 1, FILL)!;
  effect(e, 0, e.fieldCard(lc.uid), { pick: ['Banish a FIRE monster: destroy a monster'] });
  check(zone(e, foe) === 'gy' && e.atkOf(e.fieldCard(lc.uid)!) === 1400, 'banishes a FIRE monster: destroys a monster and gains its original ATK');
}

section('Lunalight Crimson Fox');
{
  const e = duel(['Lunalight Crimson Fox'], [FILL]);
  const fx = place(e, 0, 'Lunalight Crimson Fox')!;
  const foe = place(e, 1, FILL)!;
  kill(e, [fx], 1, 'yes');
  check(zone(e, fx) === 'gy' && e.atkOf(foe) === 0, "sent to the GY by a card effect: an opponent's monster's ATK becomes 0");
}

section('Lunalight Panther Dancer');
{
  const e = duel([], [FILL, FILL], ['Lunalight Panther Dancer']);
  const pd0 = e.player(0).fusion[0];
  check(e.summonBlocked(0, pd0, 'special', 'gy'), 'must first be Fusion Summoned (no revival before that)');
  const pd = place(e, 0, 'Lunalight Panther Dancer')!;
  kill(e, [pd], 1);
  check(zone(e, pd) === 'mz', "cannot be destroyed by the opponent's card effects");
  const a = place(e, 1, FILL)!;
  toTurn3(e);
  effect(e, 0, pd);
  toBattle(e);
  attack(e, pd, a);
  check(zone(e, a) === 'mz' && e.atkOf(pd) === 2800, 'the first time each opponent\'s monster would be destroyed by battle, it is not');
  attack(e, pd, a);
  check(zone(e, a) === 'gy' && e.atkOf(pd) === 3000, 'it attacks the same monster again: destroyed, and it gains 200 ATK');
}

// ======================= M =======================
section('Machina Gearframe');
{
  const e = duel(['Machina Gearframe', 'Machina Peacekeeper', 'Jinzo']);
  summon(e, 0, 'Machina Gearframe', true, 'yes');
  check(e.player(0).hand.some((c) => c.name === 'Machina Peacekeeper'), 'Normal Summoned: adds a "Machina" monster from the Deck');
  const gf = e.monsters(0).find((m) => m.name === 'Machina Gearframe')!;
  const jz = place(e, 0, 'Jinzo')!;
  effect(e, 0, gf);
  check(zone(e, gf) === 'sz' && jz.equips.includes(gf.uid), 'equips itself to a Machine monster');
  kill(e, [jz], 1);
  check(zone(e, jz) === 'mz' && zone(e, gf) === 'gy', 'the equipped monster would be destroyed: this card is destroyed instead');
}

section('Machina Peacekeeper');
{
  const e = duel(['Machina Peacekeeper', 'Machina Gearframe']);
  const pk = place(e, 0, 'Machina Peacekeeper')!;
  kill(e, [pk], 1, 'yes');
  check(e.player(0).hand.some((c) => c.name === 'Machina Gearframe'), 'destroyed on the field: adds a Union monster from the Deck');
}

section('Machine Angel Ritual');
{
  const e = duel(['Machine Angel Ritual', 'Cyber Angel Benten', FILL, FILL]);
  grab(e, 0, 'Cyber Angel Benten');
  place(e, 0, FILL);
  place(e, 0, FILL);
  const mar = playSpell(e, 0, 'Machine Angel Ritual', { pick: ['Cyber Angel Benten'] }, { pick: [FILL, FILL] });
  void mar;
  const bt = e.monsters(0).find((m) => m.name === 'Cyber Angel Benten');
  check(!!bt && e.player(0).gy.filter((c) => c.name === FILL).length === 2, 'Ritual Summons a "Cyber Angel" by Tributing monsters with enough Levels');
  kill(e, [bt], 1);
  check(zone(e, bt) === 'mz' && e.player(0).removed.some((c) => c.name === 'Machine Angel Ritual'), 'in the GY: banished instead of a LIGHT monster being destroyed');
}

section('Mad Reloader');
{
  const e = duel(['Mad Reloader', FILL, FILL], ['Jinzo']);
  const a = grab(e, 0, FILL);
  const b = grab(e, 0, FILL);
  const mr = place(e, 0, 'Mad Reloader')!;
  toTurn2(e);
  const hand = e.player(0).hand.length;
  const jz = place(e, 1, 'Jinzo')!;
  toBattle(e);
  attack(e, jz, mr, { pick: [FILL, FILL] });
  check(zone(e, a) === 'gy' && zone(e, b) === 'gy' && e.player(0).hand.length === hand, 'destroyed by battle: sends 2 cards from the hand to the GY and draws 2');
}

section('Mad Sword Beast');
{
  const e = duel(['Mad Sword Beast'], [FILL]);
  const msb = place(e, 0, 'Mad Sword Beast')!;
  const foe = place(e, 1, FILL, 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, msb, foe);
  check(lp(e, 1) === 3800, 'inflicts piercing battle damage');
}

section('Madolche Magileine');
{
  const e = duel(['Madolche Magileine', 'Madolche Magileine']);
  summon(e, 0, 'Madolche Magileine', true, 'yes');
  check(e.player(0).hand.some((c) => c.name === 'Madolche Magileine'), 'Normal Summoned: adds a "Madolche" monster from the Deck');
  const mm = e.monsters(0).find((m) => m.name === 'Madolche Magileine')!;
  kill(e, [mm], 1);
  check(zone(e, mm) === 'deck', "destroyed by the opponent's card: shuffled into the Deck");
}

section('Mage Power');
{
  const e = duel(['Mage Power', 'Trap Hole']);
  const cg = place(e, 0, FILL)!;
  putST(e, 0, 'Trap Hole');
  playSpell(e, 0, 'Mage Power');
  check(e.atkOf(cg) === 2400 && e.defOf(cg) === 2200, 'gains 500 ATK/DEF for each Spell/Trap you control');
}

section('Magic Drain');
{
  const e = duel(['Magic Drain', 'Trap Hole'], ['Mystical Space Typhoon'], [], [], 1);
  const th = putST(e, 0, 'Trap Hole');
  putST(e, 0, 'Magic Drain');
  const mst = grab(e, 1, 'Mystical Space Typhoon');
  act(e, 1, mst.uid, { pick: ['Face-down card'] }, { respond: 'Magic Drain' });
  check(zone(e, mst) === 'gy' && zone(e, th) === 'sz', 'negates the Spell when the opponent has no Spell to discard');
}

section('Magic Formula');
{
  const e = duel(['Magic Formula', 'Dark Magician']);
  const dm = place(e, 0, 'Dark Magician')!;
  const mf = playSpell(e, 0, 'Magic Formula')!;
  check(e.atkOf(dm) === 3200, '"Dark Magician" gains 700 ATK');
  kill(e, [mf]);
  check(lp(e, 0) === 5000, 'sent from the field to the GY: gain 1000 LP');
}

section('Magical Plant Mandragola');
{
  const e = duel(['Magical Plant Mandragola', 'Maiden of Macabre']);
  const md = place(e, 0, 'Maiden of Macabre')!;
  const mp = place(e, 0, 'Magical Plant Mandragola', 'def', false)!;
  flipSummon(e, 0, mp);
  check(md.counters === 1 && e.atkOf(md) === 1900, 'FLIP: a Spell Counter on each card that can hold one');
}

section('Magical Stone Excavation');
{
  const e = duel(['Magical Stone Excavation', 'Umi', FILL, FILL]);
  const umi = toGy(e, 0, 'Umi');
  grab(e, 0, FILL);
  grab(e, 0, FILL);
  playSpell(e, 0, 'Magical Stone Excavation', { pick: [FILL, FILL] });
  check(zone(e, umi) === 'hand' && e.player(0).gy.filter((c) => c.name === FILL).length === 2, 'discards 2 cards: adds a Spell from the GY to the hand');
}

section('Magical Undertaker');
{
  const e = duel(['Magical Undertaker', 'Madolche Magileine']);
  const mm = toGy(e, 0, 'Madolche Magileine');
  const mu = place(e, 0, 'Magical Undertaker', 'def', false)!;
  flipSummon(e, 0, mu, 'yes');
  check(zone(e, mm) === 'mz', 'FLIP: Special Summons a Level 4 or lower Spellcaster from the GY');
}

section("Magician's Circle");
{
  const e = duel(["Magician's Circle", 'Madolche Magileine'], ['Madolche Magileine', 'Dark Magician Girl']);
  putST(e, 0, "Magician's Circle");
  toTurn2(e);
  const mm = place(e, 1, 'Madolche Magileine')!;
  toBattle(e);
  e.apply({ type: 'ATTACK', player: 1, uid: mm.uid, target: null });
  settle(e, { respond: "Magician's Circle" });
  // (the attack is then replayed into the new monster, which can leave the field again)
  const left = (_p: Pid, n: string) => e.state.log.some((l) => l.text === `A Special Summoned ${n} in Attack Position`);
  check(left(0, 'Madolche Magileine') && e.monsters(1).some((m) => m.name === 'Dark Magician Girl'), 'a Spellcaster attacks: each player Special Summons a Spellcaster with 2000 or less ATK from the Deck');
}

section('Magicians Unite');
{
  const e = duel(['Magicians Unite', 'Madolche Magileine', 'Dark Magician Girl']);
  const mm = place(e, 0, 'Madolche Magileine')!;
  const dmg = place(e, 0, 'Dark Magician Girl')!;
  playSpell(e, 0, 'Magicians Unite', { pick: ['Madolche Magileine'] });
  check(e.atkOf(mm) === 3000 && dmg.tags?.noAttackTurn === e.state.turn, 'a Spellcaster\'s ATK becomes 3000; the other Spellcasters cannot attack');
}

section('Magikuriboh');
{
  const e = duel(['Magikuriboh', 'Dark Magician'], [FILL]);
  const mk = grab(e, 0, 'Magikuriboh');
  toTurn2(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, null, { respond: 'Magikuriboh' });
  check(zone(e, mk) === 'gy' && e.monsters(0).some((m) => m.name === 'Dark Magician'), 'after battle damage: sends itself to the GY to Special Summon "Dark Magician"');
}
{
  const e = duel(['Magikuriboh', 'Madolche Magileine'], ['Jinzo']);
  const mk = toGy(e, 0, 'Magikuriboh');
  const mm = place(e, 0, 'Madolche Magileine')!;
  toTurn2(e);
  const jz = place(e, 1, 'Jinzo')!;
  toBattle(e);
  attack(e, jz, mm, 'yes');
  check(zone(e, mk) === 'hand', 'a Spellcaster you control is destroyed by battle: it returns from the GY to the hand');
}
{
  const e = duel(['Magikuriboh', 'Dark Magician']);
  grab(e, 0, 'Magikuriboh');
  check(!e.canUseQuickNow(0, e.player(0).hand.find((c) => c.name === 'Magikuriboh')!.uid), 'not without having taken damage this turn');
}

section('Magnet Conversion');
{
  const e = duel(['Magnet Conversion', 'Alpha The Magnet Warrior', 'Beta The Magnet Warrior']);
  const a = toGy(e, 0, 'Alpha The Magnet Warrior');
  const b = toGy(e, 0, 'Beta The Magnet Warrior');
  const mc = playTrap(e, 0, 'Magnet Conversion', { pick: ['Alpha The Magnet Warrior', 'Beta The Magnet Warrior'] });
  void mc;
  check(zone(e, a) === 'hand' && zone(e, b) === 'hand', 'adds up to 3 "Magnet Warrior" monsters from the GY to the hand');
  const card = e.player(0).gy.find((c) => c.name === 'Magnet Conversion')!;
  e.banish(a.uid);
  check(!e.canUseGraveEffect(0, card.uid), 'not the turn it was sent to the GY');
  toTurn3(e);
  graveFx(e, 0, card);
  check(zone(e, a) === 'mz' && zone(e, card) === 'removed', 'later: banishes itself to Special Summon a banished "Magnet Warrior"');
}

section('Magnetic Field');
{
  const e = duel(['Magnetic Field', 'Alpha The Magnet Warrior', 'Beta The Magnet Warrior'], ['Mermail Abyssteus']);
  const beta = toGy(e, 0, 'Beta The Magnet Warrior');
  const mf = playSpell(e, 0, 'Magnetic Field')!;
  const alpha = place(e, 0, 'Alpha The Magnet Warrior')!;
  effect(e, 0, mf);
  check(zone(e, beta) === 'mz', 'with an EARTH Rock monster: Special Summons a "Magnet Warrior" from the GY');
  const foe = place(e, 1, 'Mermail Abyssteus', 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, alpha, foe, 'yes');
  check(zone(e, foe) === 'hand', 'end of the Damage Step: returns the opponent\'s monster that survived the battle to the hand');
}

section('Magnetic Mosquito');
{
  const e = duel(['Magnetic Mosquito'], ['Jinzo']);
  const jz = place(e, 1, 'Jinzo')!;
  const mm = place(e, 0, 'Magnetic Mosquito', 'def', false)!;
  flipSummon(e, 0, mm);
  check(zone(e, jz) === 'gy', 'FLIP: destroys all face-up Machine monsters');
}

section('Maiden of Macabre');
{
  const e = duel(['Maiden of Macabre'], [FILL, FILL]);
  const md = place(e, 0, 'Maiden of Macabre')!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, md, foe);
  check(md.counters === 1 && e.atkOf(md) === 1900, 'destroys a monster by battle: a Spell Counter, +200 ATK each');
  endTurn(e);
  const b = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, b, md);
  check(zone(e, b) === 'gy' && md.counters === 2, 'also when it destroys an attacking monster');
}

section('Malevolent Catastrophe');
{
  const e = duel(['Malevolent Catastrophe', 'Umi'], [FILL, 'Trap Hole']);
  putST(e, 0, 'Malevolent Catastrophe');
  const umi = playSpell(e, 0, 'Umi')!;
  const th = putST(e, 1, 'Trap Hole');
  toTurn2(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, null, { respond: 'Malevolent Catastrophe' });
  check(zone(e, umi) === 'gy' && zone(e, th) === 'gy', 'an opponent\'s monster attacks: destroys all Spells and Traps');
}

section('Malice Dispersion');
{
  const e = duel(['Malice Dispersion', FILL], ['Labyrinth of Nightmare']);
  const lb = putST(e, 1, 'Labyrinth of Nightmare');
  lb.faceUp = true;
  lb.active = true;
  grab(e, 0, FILL);
  playSpell(e, 0, 'Malice Dispersion');
  check(zone(e, lb) === 'gy' && e.player(0).gy.some((c) => c.name === FILL), 'discards 1 card: destroys all face-up Continuous Traps');
}

section('Maryokutai');
{
  const e = duel(['Maryokutai', 'Trap Hole'], ['Mystical Space Typhoon'], [], [], 1);
  const my = place(e, 0, 'Maryokutai')!;
  const th = putST(e, 0, 'Trap Hole');
  const mst = grab(e, 1, 'Mystical Space Typhoon');
  act(e, 1, mst.uid, { pick: ['Face-down card'] }, { respond: 'Maryokutai' });
  check(zone(e, my) === 'gy' && zone(e, mst) === 'gy' && zone(e, th) === 'sz', 'Tributes itself on the opponent\'s turn: negates the Spell and destroys it');
}

section('Mask Change II');
{
  const e = duel(['Mask Change II', 'Mermail Abyssgunde', FILL], [FILL, 'Trap Hole'], ['Masked HERO Acid']);
  const acid = e.player(0).fusion[0];
  check(e.summonBlocked(0, acid, 'special', 'fusion'), '"Masked HERO Acid" must be Special Summoned with "Mask Change"');
  const ab = place(e, 0, 'Mermail Abyssgunde')!;
  const foe = place(e, 1, FILL)!;
  const th = putST(e, 1, 'Trap Hole');
  grab(e, 0, FILL);
  playSpell(e, 0, 'Mask Change II', { pick: [FILL] });
  check(zone(e, ab) === 'gy' && zone(e, acid) === 'mz', 'sends a face-up monster to the GY: Special Summons a "Masked HERO" with its Attribute and a higher Level');
  section('Masked HERO Acid');
  check(zone(e, th) === 'gy' && e.atkOf(foe) === 1100, 'Masked HERO Acid: destroys the opponent\'s Spells/Traps, their monsters lose 300 ATK');
}

section('Mask of Brutality');
{
  const e = duel(['Mask of Brutality']);
  const cg = place(e, 0, FILL)!;
  const mb = playSpell(e, 0, 'Mask of Brutality')!;
  check(e.atkOf(cg) === 2400 && e.defOf(cg) === 200, '+1000 ATK, -1000 DEF');
  toTurn3(e);
  check(lp(e, 0) === 4000 && zone(e, mb) === 'gy', 'your Standby Phase: pay 1000 LP or destroy it (no: destroyed)');
}
{
  const e = duel(['Mask of Brutality']);
  place(e, 0, FILL);
  const mb = playSpell(e, 0, 'Mask of Brutality')!;
  endTurn(e);
  endTurn(e, 'yes');
  check(lp(e, 0) === 3000 && zone(e, mb) === 'sz', 'pays 1000 LP to keep it');
}

section('Mask of Weakness');
{
  const e = duel(['Mask of Weakness'], [FILL]);
  const cg = place(e, 0, FILL)!;
  putST(e, 0, 'Mask of Weakness');
  toTurn2(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, cg, { respond: 'Mask of Weakness' });
  check(zone(e, foe) === 'gy' && zone(e, cg) === 'mz', 'the attacking monster loses 700 ATK');
}

section('Mask of the Accursed');
{
  const e = duel(['Mask of the Accursed'], [FILL]);
  const foe = place(e, 1, FILL)!;
  playSpell(e, 0, 'Mask of the Accursed', { pick: [FILL] });
  toTurn2(e);
  toBattle(e);
  check(!e.canAttackWith(1, foe), 'the equipped monster cannot attack');
  endTurn(e);
  check(lp(e, 1) === 3500, 'your Standby Phase: 500 damage to its controller');
}

section('Masked Beast Des Gardius');
{
  const e = duel(['Masked Beast Des Gardius', 'Grand Tiki Elder', 'The Mask of Remnants', FILL], [FILL]);
  const dg = grab(e, 0, 'Masked Beast Des Gardius');
  check(e.summonBlocked(0, dg, 'special', 'gy'), 'cannot be Special Summoned except by its own procedure');
  place(e, 0, 'Grand Tiki Elder');
  place(e, 0, FILL);
  special(e, 0, dg);
  check(zone(e, dg) === 'mz', 'Special Summoned by Tributing 2 monsters including "Grand Tiki Elder"');
  const foe = place(e, 1, FILL)!;
  kill(e, [dg], 1);
  check(e.controller(foe.uid) === 0 && foe.equips.length === 1, 'sent from the field to the GY: "The Mask of Remnants" from the Deck equips to a monster and takes it');
}

section('Master Craftsman Gamil');
{
  const e = duel(['Master Craftsman Gamil'], [FILL]);
  const g = grab(e, 0, 'Master Craftsman Gamil');
  const cg = place(e, 0, FILL)!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, cg, foe, { respond: 'Master Craftsman Gamil' });
  check(zone(e, g) === 'gy' && zone(e, foe) === 'gy' && e.atkOf(cg) === 1700, 'sent from the hand to the GY: the battling monster gains 300 ATK');
}

section('Master Peace, the True Dracoslayer');
{
  const e = duel(['Master Peace, the True Dracoslayer', 'Test Dracoslayer', 'Test Dracoverlord', 'Trap Hole'], ['Mystical Space Typhoon']);
  const mp = grab(e, 0, 'Master Peace, the True Dracoslayer');
  check(e.summonBlocked(0, mp, 'special', 'gy'), 'cannot be Special Summoned by other ways');
  place(e, 0, 'Test Dracoslayer');
  place(e, 0, 'Test Dracoverlord');
  special(e, 0, mp);
  check(zone(e, mp) === 'mz' && e.player(0).gy.length === 2, 'Tributes a "Dracoslayer" and a "Dracoverlord"');
  putST(e, 0, 'Trap Hole');
  toTurn2(e);
  const mst = grab(e, 1, 'Mystical Space Typhoon');
  act(e, 1, mst.uid, { respond: 'Master Peace' });
  check(zone(e, mst) === 'gy' && e.player(0).sz.some((c) => c?.name === 'Trap Hole'), 'negates an activation and destroys that card');
}

section('Medusa Worm');
{
  const e = duel(['Medusa Worm'], [FILL]);
  const mw = place(e, 0, 'Medusa Worm')!;
  effect(e, 0, mw);
  check(!mw.faceUp && mw.pos === 'def', 'flips itself face-down');
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  flipSummon(e, 0, mw);
  check(zone(e, foe) === 'gy', 'Flip Summoned: destroys an opponent\'s monster');
}

section('Mefist the Infernal General');
{
  const e = duel(['Mefist the Infernal General'], [FILL, FILL]);
  const mf = place(e, 0, 'Mefist the Infernal General')!;
  const foe = place(e, 1, FILL, 'def')!;
  grab(e, 1, FILL);
  const hand = e.player(1).hand.length;
  toTurn3(e);
  const handNow = e.player(1).hand.length;
  toBattle(e);
  attack(e, mf, foe);
  check(lp(e, 1) === 4000 - 600 && e.player(1).hand.length === handNow - 1 && hand > 0, 'piercing damage, then the opponent discards a random card');
}

section('Mega Ton Magical Cannon');
{
  const e = duel(['Mega Ton Magical Cannon', 'Maiden of Macabre'], [FILL, 'Trap Hole']);
  const md = place(e, 0, 'Maiden of Macabre')!;
  md.counters = 10;
  const foe = place(e, 1, FILL)!;
  const th = putST(e, 1, 'Trap Hole');
  playSpell(e, 0, 'Mega Ton Magical Cannon');
  check(md.counters === 0 && zone(e, foe) === 'gy' && zone(e, th) === 'gy', 'removes 10 Spell Counters: destroys all cards the opponent controls');
}

section('Megarock Dragon');
{
  const e = duel(['Megarock Dragon', 'Alpha The Magnet Warrior', 'Beta The Magnet Warrior']);
  const md = grab(e, 0, 'Megarock Dragon');
  check(e.summonBlocked(0, md, 'special', 'gy'), 'cannot be Special Summoned except by its own procedure');
  toGy(e, 0, 'Alpha The Magnet Warrior');
  toGy(e, 0, 'Beta The Magnet Warrior');
  special(e, 0, md, { pick: ['Alpha The Magnet Warrior', 'Beta The Magnet Warrior'] });
  const m = e.fieldCard(md.uid)!;
  check(!!m && e.atkOf(m) === 1400 && e.defOf(m) === 1400, 'banishes 2 Rock monsters: ATK/DEF 1400');
}

section('Mei-Kou, Master of Barriers');
{
  const e = duel(['Mei-Kou, Master of Barriers'], ['Labyrinth of Nightmare']);
  const mk = place(e, 0, 'Mei-Kou, Master of Barriers')!;
  const lb = putST(e, 1, 'Labyrinth of Nightmare');
  lb.faceUp = true;
  lb.active = true;
  effect(e, 0, mk);
  check(zone(e, mk) === 'gy' && zone(e, lb) === 'gy', 'Tributes itself: destroys a face-up Continuous Spell/Trap');
}

section('Meklord Army of Granel');
{
  const e = duel(['Meklord Army of Granel', 'Meklord Army of Skiel'], [FILL]);
  const foe = place(e, 1, FILL)!;
  place(e, 0, 'Meklord Army of Skiel');
  summon(e, 0, 'Meklord Army of Granel', true, 'yes');
  const g = e.monsters(0).find((m) => m.name === 'Meklord Army of Granel')!;
  check(e.atkOf(foe) === 700, 'Normal Summoned: halves an opponent\'s monster\'s ATK');
  check(e.atkOf(g) === 1700, 'gains 100 ATK for each other "Meklord" monster');
}

section('Meklord Army of Skiel');
{
  const e = duel(['Meklord Army of Skiel', 'Meklord Army of Granel'], ['Jinzo']);
  const sk = place(e, 0, 'Meklord Army of Skiel')!;
  toTurn2(e);
  const jz = place(e, 1, 'Jinzo')!;
  toBattle(e);
  attack(e, jz, sk, 'yes');
  check(zone(e, sk) === 'gy' && e.monsters(0).some((m) => m.name === 'Meklord Army of Granel'), 'destroyed by battle: Special Summons a "Meklord Army" from the Deck');
}

section('Memory Loss');
{
  const e = duel(['Memory Loss'], ['Medusa Worm']);
  putST(e, 0, 'Memory Loss');
  toTurn2(e);
  const mw = place(e, 1, 'Medusa Worm')!;
  effect(e, 1, mw, { respond: 'Memory Loss' });
  check(mw.faceUp && mw.pos === 'def', "negates the opponent's monster effect and changes it to face-up Defense Position");
}

section('Mermail Abyssgunde');
{
  const e = duel(['Mermail Abyssgunde', 'Mermail Abyssteus']);
  const at = toGy(e, 0, 'Mermail Abyssteus');
  const ag = grab(e, 0, 'Mermail Abyssgunde');
  run(e, e.as(0, e.discard(0, ag.uid)), 'yes');
  check(zone(e, at) === 'mz', 'discarded: Special Summons a "Mermail" from the GY');
}

section('Mermail Abyssteus');
{
  const e = duel(['Mermail Abyssteus', 'Mermail Abyssteus', 'Lekunga', 'Mermail Abyssgunde', 'Lekunga']);
  const at = grab(e, 0, 'Mermail Abyssteus');
  grab(e, 0, 'Lekunga');
  effect(e, 0, at, 'yes');
  check(zone(e, at) === 'mz' && e.player(0).hand.some((c) => c.name === 'Mermail Abyssgunde'), 'discards a WATER monster: Special Summons itself, then adds a Level 4 or lower "Mermail"');
  const at2 = grab(e, 0, 'Mermail Abyssteus');
  grab(e, 0, 'Lekunga');
  check(!e.canUseMonsterEffect(0, at2), 'once per turn');
}

section('Metal Reflect Slime');
{
  const e = duel(['Metal Reflect Slime']);
  const ms = playTrap(e, 0, 'Metal Reflect Slime');
  const m = e.monsters(0).find((x) => x.name === 'Metal Reflect Slime')!;
  void ms;
  check(!!m && m.pos === 'def' && e.defOf(m) === 3000 && levelOf(e, m) === 10 && e.raceOf(m) === 'Aqua', 'Special Summoned as a Level 10 Aqua monster with 3000 DEF in Defense Position');
  m.pos = 'atk';
  toTurn3(e);
  toBattle(e);
  check(!e.canAttackWith(0, m), 'it cannot attack');
}

section('Metalfoes Counter');
{
  const e = duel(['Metalfoes Counter', 'Metalfoes Test Steel'], ['Jurrac Tyrannus']);
  const cg = place(e, 0, FILL)!;
  putST(e, 0, 'Metalfoes Counter');
  toTurn2(e);
  const jz = place(e, 1, 'Jurrac Tyrannus')!;
  toBattle(e);
  attack(e, jz, cg, { respond: 'Metalfoes Counter' });
  check(zone(e, cg) === 'gy' && e.monsters(0).some((m) => m.name === 'Metalfoes Test Steel'), 'a card you control is destroyed by battle: Special Summons a "Metalfoes" from the Deck');
}
{
  const e = duel(['Metalfoes Counter', 'Metalfoes Test Steel']);
  const cg = place(e, 0, FILL)!;
  const mc = putST(e, 0, 'Metalfoes Counter');
  check(!e.canActivateMain(0, mc.uid), 'not without a destroyed card');
  kill(e, [cg], 1);
  act(e, 0, mc.uid);
  check(e.monsters(0).some((m) => m.name === 'Metalfoes Test Steel'), 'also after a card effect destroyed one (at the next chance)');
}

section('Metamorformation');
{
  const e = duel(['Metamorformation', 'Metalfoes Test Steel']);
  const ms = place(e, 0, 'Metalfoes Test Steel')!;
  const cg = place(e, 0, FILL)!;
  playSpell(e, 0, 'Metamorformation');
  check(e.atkOf(ms) === 2000 && e.defOf(ms) === 1300 && e.atkOf(cg) === 1400, '"Metalfoes" monsters you control gain 300 ATK/DEF');
}

section('Metaverse');
{
  const e = duel(['Metaverse', 'Umi']);
  playTrap(e, 0, 'Metaverse', { pick: ['Activate it'] });
  check(e.player(0).field?.name === 'Umi' && !!e.player(0).field?.active, 'takes a Field Spell from the Deck and activates it');
}
{
  const e = duel(['Metaverse', 'Umi']);
  playTrap(e, 0, 'Metaverse', { pick: ['Umi'] }, { pick: ['Add it to your hand'] });
  check(e.player(0).hand.some((c) => c.name === 'Umi'), '... or adds it to the hand');
}

section('Metrognome');
{
  const e = duel(['Metrognome'], [FILL]);
  const m = place(e, 0, 'Metrognome')!;
  place(e, 1, FILL);
  check(!e.canAttackDirectly(m) && e.atkOf(m) === 1800, 'no Pendulum Zones in this game: its monster effect never applies');
}

section('Michizure');
{
  const e = duel(['Michizure', FILL], ['Jurrac Tyrannus']);
  const cg = place(e, 0, FILL)!;
  putST(e, 0, 'Michizure');
  toTurn2(e);
  const jz = place(e, 1, 'Jurrac Tyrannus')!;
  toBattle(e);
  attack(e, jz, cg, { respond: 'Michizure' });
  check(zone(e, cg) === 'gy' && zone(e, jz) === 'gy', 'a monster is sent from the field to your GY: destroys a monster');
}

section('Mikanko Dance - Mayowashidori');
{
  const e = duel(['Mikanko Dance - Mayowashidori', 'Mikanko Test Dancer'], [FILL, 'Trap Hole']);
  const mk = place(e, 0, 'Mikanko Test Dancer')!;
  const md = playSpell(e, 0, 'Mikanko Dance - Mayowashidori')!;
  kill(e, [mk], 1);
  check(zone(e, mk) === 'mz', 'the equipped monster cannot be destroyed by card effects');
  const foe = place(e, 1, FILL, 'def')!;
  const th = putST(e, 1, 'Trap Hole');
  toTurn3(e);
  toBattle(e);
  attack(e, mk, foe, 'yes', { pick: ['Face-down card'] });
  check(zone(e, th) === 'hand', 'end of the Damage Step after a "Mikanko" battled: returns a card on the field to the hand');
  void md;
}
{
  const e = duel(['Mikanko Dance - Mayowashidori', 'Mikanko Test Dancer']);
  const md = toGy(e, 0, 'Mikanko Dance - Mayowashidori');
  const mk = toGy(e, 0, 'Mikanko Test Dancer');
  graveFx(e, 0, md);
  const m = e.fieldCard(mk.uid);
  check(!!m && m.equips.includes(md.uid), 'in the GY: Special Summons a "Mikanko" and equips itself to it');
  kill(e, [m], 1);
  check(zone(e, mk) === 'mz', '... which is then protected from card effects');
}

section('Mimicat');
{
  const e = duel(['Mimicat', 'Toon World', 'Toon Alligator'], ['Jinzo']);
  const jz = toGy(e, 1, 'Jinzo');
  playSpell(e, 0, 'Toon World');
  force(e, 0, 'Toon Alligator');
  playSpell(e, 0, 'Mimicat');
  check(zone(e, jz) === 'mz' && e.controller(jz.uid) === 0, 'Special Summons a monster from the opponent\'s GY to your field');
}

section('Mind Crush');
{
  const e = duel(['Mind Crush'], ['Jinzo', 'Jinzo']);
  for (const c of e.player(1).deck.filter((x) => x.name === 'Jinzo')) e.toHandOf(c.uid, 1);
  playTrap(e, 0, 'Mind Crush', { pick: ['Jinzo'] });
  check(e.player(1).gy.filter((c) => c.name === 'Jinzo').length === 2, 'the declared card is in their hand: they discard all copies');
}
{
  const e = duel(['Mind Crush', FILL], ['Jinzo']);
  const hand = e.player(0).hand.length;
  playTrap(e, 0, 'Mind Crush', { pick: ['Jinzo'] });
  check(e.player(0).hand.length === hand - 1, 'otherwise you discard a random card');
}

section('Miniaturize');
{
  const e = duel(['Miniaturize'], ['Jurrac Tyrannus']);
  const jz = place(e, 1, 'Jurrac Tyrannus')!;
  const mi = playTrap(e, 0, 'Miniaturize')!;
  check(levelOf(e, jz) === 6 && e.atkOf(jz) === 1500, 'a monster with more than 1000 original ATK: Level -1 and -1000 ATK');
  kill(e, [mi]);
  check(levelOf(e, jz) === 7 && e.atkOf(jz) === 2500, 'the changes end when it leaves the field');
}

section('Miracle Fusion');
{
  const e = duel(['Miracle Fusion', 'Elemental HERO Avian', 'Elemental HERO Burstinatrix'], [], ['Elemental HERO Flame Wingman']);
  const av = place(e, 0, 'Elemental HERO Avian')!;
  const bu = toGy(e, 0, 'Elemental HERO Burstinatrix');
  playSpell(e, 0, 'Miracle Fusion');
  check(zone(e, av) === 'removed' && zone(e, bu) === 'removed' && e.monsters(0).some((m) => m.name === 'Elemental HERO Flame Wingman' && m.tags?.fusS), 'banishes materials from the field and GY: Fusion Summons an "Elemental HERO"');
}

section('Miracle Restoring');
{
  const e = duel(['Miracle Restoring', 'Maiden of Macabre', 'Dark Magician']);
  const dm = toGy(e, 0, 'Dark Magician');
  const md = place(e, 0, 'Maiden of Macabre')!;
  md.counters = 2;
  playTrap(e, 0, 'Miracle Restoring');
  check(md.counters === 0 && zone(e, dm) === 'mz', 'removes 2 Spell Counters: Special Summons "Dark Magician" from the GY');
}

section('Mirage of Nightmare');
{
  const e = duel(['Mirage of Nightmare']);
  playSpell(e, 0, 'Mirage of Nightmare');
  while (e.player(0).hand.length > 1) run(e, e.sendToGrave(e.player(0).hand[0].uid, 'mill'));
  endTurn(e);
  check(e.player(0).hand.length === 4, "the opponent's Standby Phase: draws until you have 4 cards");
  endTurn(e);
  check(e.player(0).hand.length === 2, 'your next Standby Phase: discards as many cards as it drew (3, after the normal draw)');
}

section('Mist Archfiend');
{
  const e = duel(['Mist Archfiend']);
  const ma = grab(e, 0, 'Mist Archfiend');
  effect(e, 0, ma, 'yes');
  check(zone(e, ma) === 'mz' && e.player(0).normalSummoned, 'Normal Summoned without Tributing');
  endTurn(e);
  check(zone(e, ma) === 'gy' && lp(e, 0) === 3000, 'End Phase: destroyed, and you take 1000 damage');
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
if (fails) process.exit(1);
