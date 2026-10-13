// Speed Duel card scripts of batch 20 (run: npx tsx tests/batch-20.test.ts)
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
import { levelOf } from '../src/eds/speed/helpers';
import type { CardInfo } from '../src/eds/types';

// Cards this game's pool lacks (no "Speedroid" Tuners, no "Firewall" Link Monsters, no Rank 6 Fairy WATER Xyz):
// test-only stand-ins added to the card database.
const fake = (info: Partial<CardInfo> & { name: string }) => {
  const full = { id: 990000 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
fake({ name: 'Speedroid Test Tuner', sub: 'Effect', tuner: true, level: 3, atk: 1200, def: 600, race: 'Machine', attribute: 'WIND' });
fake({ name: 'Firewall Test Dragon', sub: 'Link', linkRating: 4, atk: 2500, race: 'Cyberse', attribute: 'LIGHT', desc: '2+ monsters' });
fake({ name: 'Number Test: Rank Six Fairy', sub: 'Xyz', rank: 6, atk: 2800, def: 2000, race: 'Fairy', attribute: 'WATER', desc: '3 Level 6 monsters' });
const mzIndex = (e: Engine, c: Card | null | undefined) => (c ? e.find(c.uid)?.loc.index : undefined);
const atk = (e: Engine, c: FieldCard | null) => (c ? e.atkOf(c) : -1);

section('Ojama Knight');
{
  const e = duel(['Ojama Green', 'Ojama Yellow', 'Polymerization'], [], ['Ojama Knight']);
  grab(e, 0, 'Ojama Green');
  grab(e, 0, 'Ojama Yellow');
  playSpell(e, 0, 'Polymerization', { pick: ['Ojama Knight'] }, { pick: ['Ojama Green'] }, { pick: ['Monster Zone 1', 'Monster Zone 2'] });
  const knight = e.monsters(0).find((m) => m.name === 'Ojama Knight') ?? null;
  check(!!knight, 'Ojama Knight: Fusion Summoned with 2 "Ojama" monsters (generic Fusion Materials)');
  check(e.mzBlocked(1, 0) && e.mzBlocked(1, 1) && !e.mzBlocked(1, 2) && e.freeMonsterZone(1) === 2, "Ojama Knight: 2 of the opponent's Monster Zones are blocked");
  const a = place(e, 1, FILL);
  const b = place(e, 1, FILL);
  check(!!a && mzIndex(e, a) === 2 && !b && e.monsters(1).length === 1, 'Ojama Knight: the opponent can only use the third zone');
  kill(e, [knight]);
  check(!e.mzBlocked(1, 0) && !!place(e, 1, FILL), 'Ojama Knight: the zones open again once it leaves the field');
}

section('Dyna Tank');
{
  const e = duel(['Mechanicalchaser', 'Kabazauls', 'Polymerization'], [], ['Dyna Tank']);
  grab(e, 0, 'Mechanicalchaser');
  grab(e, 0, 'Kabazauls');
  playSpell(e, 0, 'Polymerization');
  const t = e.monsters(0).find((m) => m.name === 'Dyna Tank') ?? null;
  check(!!t && t.tags?.fusS === 1 && atk(e, t) === 1700, 'Dyna Tank: ATK equals the original ATK of the Dinosaur used (Kabazauls, 1700)');
}
{
  // The opponent's Shield Crush targets Dyna Tank; its Quick Effect moves the target to another monster.
  const e = duel([], ['Shield Crush'], ['Dyna Tank'], [], 1);
  const t = place(e, 0, 'Dyna Tank', 'def');
  const other = place(e, 0, FILL, 'def');
  playSpell(e, 1, 'Shield Crush', { pick: ['Dyna Tank'] }, { respond: 'Dyna Tank' }, { pick: [FILL] });
  check(!!e.fieldCard(t!.uid) && zone(e, other) === 'gy', 'Dyna Tank: the targeting Spell now targets the other monster');
}

section('Coordius the Triphasic Dealmon');
{
  const e = duel(['Polymerization'], [], ['Hi-Speedroid Puzzle', 'Number 103: Ragnazero', "Cosmic Slicer Zer'oll", 'Coordius the Triphasic Dealmon']);
  place(e, 0, 'Hi-Speedroid Puzzle');
  place(e, 0, 'Number 103: Ragnazero');
  place(e, 0, "Cosmic Slicer Zer'oll");
  playSpell(e, 0, 'Polymerization');
  const c = e.monsters(0).find((m) => m.name === 'Coordius the Triphasic Dealmon') ?? null;
  check(!!c && c.tags?.fusS === 1 && e.monsters(0).length === 1, 'Coordius: Fusion Summoned with a Synchro, an Xyz and a Link Monster');
  for (let i = 0; i < 3; i++) place(e, 1, FILL);
  effect(e, 0, c, { pick: ['Destroy 3 cards your opponent controls'] });
  check(e.player(0).lp === 2000 && e.monsters(1).length === 0, 'Coordius: pays 2000 LP to destroy 3 cards the opponent controls');
}

section('Rank-Up-Magic Astral Force');
{
  const e = duel(['Rank-Up-Magic Astral Force'], [], ['Number 103: Ragnazero', 'Number Test: Rank Six Fairy']);
  place(e, 0, FILL);
  place(e, 0, FILL);
  const x = e.player(0).fusion.find((c) => c.name === 'Number 103: Ragnazero')!;
  e.apply({ type: 'SPECIAL', player: 0, uid: x.uid });
  settle(e);
  check(e.matsOf(e.fieldCard(x.uid)!).length === 2, 'Astral Force: setup, a Rank 4 Xyz Monster with 2 materials');
  playSpell(e, 0, 'Rank-Up-Magic Astral Force');
  const up = e.monsters(0).find((m) => m.name === 'Number Test: Rank Six Fairy') ?? null;
  check(!!up && up.tags?.xyzS === 1 && e.matsOf(up).length === 3 && e.matsOf(up).some((c) => c.name === 'Number 103: Ragnazero'), 'Astral Force: ranks up into a Rank 6 of the same Type/Attribute, materials transferred');
  check(e.player(0).gy.some((c) => c.name === 'Rank-Up-Magic Astral Force'), 'Astral Force: setup, the Spell is in the GY');
  endTurn(e);
  endTurn(e, 'yes');
  const af = e.player(0).hand.some((c) => c.name === 'Rank-Up-Magic Astral Force');
  const fill = e.player(0).hand.find((c) => c.name === FILL)!;
  check(af && e.summonBlocked(0, fill, 'special', 'hand') && !e.summonBlocked(0, fill, 'normal', 'hand'), 'Astral Force: added from the GY instead of the normal draw; no other Special Summons this turn');
}

section('Arcana Call');
{
  const e = duel(['Arcana Force III - The Empress', 'Arcana Force IV - The Emperor', 'Arcana Call']);
  const emp = place(e, 0, 'Arcana Force III - The Empress');
  emp!.tags!.coin = 1;
  const emperor = grab(e, 0, 'Arcana Force IV - The Emperor');
  run(e, e.sendToGrave(emperor.uid, 'cost'));
  const before = atk(e, emp);
  playTrap(e, 0, 'Arcana Call');
  check(before === 1300 && zone(e, emperor) === 'removed' && atk(e, emp) === 1800, "Arcana Call: the Empress (Heads) takes the Emperor's Heads effect (+500 ATK to Arcana Force monsters)");
}

section('Cipher Bit');
{
  const e = duel(['Cipher Bit'], [], ['Galaxy-Eyes Cipher Dragon']);
  const g = place(e, 0, 'Galaxy-Eyes Cipher Dragon');
  playTrap(e, 0, 'Cipher Bit');
  check(e.matsOf(g!).some((c) => c.name === 'Cipher Bit'), 'Cipher Bit: attached as an Xyz Material');
  kill(e, [g], 1);
  check(!!e.fieldCard(g!.uid), 'Cipher Bit: the first destruction this turn does not destroy it');
  kill(e, [g], 1);
  check(!e.fieldCard(g!.uid), 'Cipher Bit: only the next time');
}

section('Double Cipher');
{
  const e = duel(['Double Cipher'], ['Blue-Eyes White Dragon'], ['Galaxy-Eyes Cipher Dragon', 'Galaxy-Eyes Cipher Dragon']);
  const g = place(e, 0, 'Galaxy-Eyes Cipher Dragon');
  e.attachMat(g!, e.player(0).deck.find((c) => c.name === FILL)!.uid);
  place(e, 1, 'Blue-Eyes White Dragon');
  playTrap(e, 0, 'Double Cipher');
  check(e.matsOf(g!).length === 0 && e.monsters(0).filter((m) => m.name === 'Galaxy-Eyes Cipher Dragon').length === 2, 'Double Cipher: detaches all materials and Special Summons a second copy from the Extra Deck');
}

section('Re-dyce-cle');
{
  const e = duel(['Speedroid Test Tuner', 'Evoltile Lagosucho', 'Re-dyce-cle'], [], ['Hi-Speedroid Puzzle']);
  const tuner = grab(e, 0, 'Speedroid Test Tuner');
  run(e, e.sendToGrave(tuner.uid, 'cost'));
  playTrap(e, 0, 'Re-dyce-cle');
  const m = e.fieldCard(tuner.uid);
  const lv = m ? levelOf(e, m) : 0;
  check(!!m && e.isNegated(m) && lv >= 1 && lv <= 6 && m.tags?.lvSet === lv, `Re-dyce-cle: the Speedroid Tuner is back, negated, Level ${lv} from the die`);
  m!.tags!.lvSet = 1;
  place(e, 0, 'Evoltile Lagosucho');
  const card = e.player(0).gy.find((c) => c.name === 'Re-dyce-cle')!;
  check(e.canUseGraveEffect(0, card.uid), 'Re-dyce-cle: its GY effect is usable with a Speedroid Tuner + Level 3');
  e.apply({ type: 'GRAVE_EFFECT', player: 0, uid: card.uid });
  settle(e);
  check(zone(e, card) === 'removed' && e.monsters(0).some((x) => x.name === 'Hi-Speedroid Puzzle' && x.tags?.synS === 1), 'Re-dyce-cle: banished to Synchro Summon a WIND Synchro Monster');
}

section('Cynet Circuit');
{
  const e = duel(['Gagagigo', 'Cynet Circuit'], [], ['Firewall Test Dragon']);
  const left = place(e, 0, FILL);
  const fw = place(e, 0, 'Firewall Test Dragon');
  kill(e, [left]);
  const gag = grab(e, 0, 'Gagagigo');
  run(e, e.sendToGrave(gag.uid, 'cost'));
  check(mzIndex(e, fw) === 1, 'Cynet Circuit: setup, the Firewall Link Monster is in the middle zone');
  playTrap(e, 0, 'Cynet Circuit', { pick: ['Firewall Test Dragon'] }, { pick: [FILL, 'Gagagigo'] });
  check(e.monsters(0).length === 3 && mzIndex(e, left) === 0 && mzIndex(e, gag) === 2, 'Cynet Circuit: 2 monsters from the GY go to the zones next to the Firewall monster');
  // GY effect: 2000 LP or less, the Firewall monster goes back to the Extra Deck and is Special Summoned.
  const e2 = duel(['Cynet Circuit'], [], ['Firewall Test Dragon']);
  const fw2 = place(e2, 0, 'Firewall Test Dragon');
  kill(e2, [fw2]);
  const cc = grab(e2, 0, 'Cynet Circuit');
  run(e2, e2.sendToGrave(cc.uid, 'cost'));
  e2.player(0).lp = 2000;
  check(e2.canUseGraveEffect(0, cc.uid), 'Cynet Circuit: its GY effect is usable at 2000 LP');
  e2.apply({ type: 'GRAVE_EFFECT', player: 0, uid: cc.uid });
  settle(e2, 'yes');
  check(zone(e2, cc) === 'removed' && !!e2.fieldCard(fw2!.uid), 'Cynet Circuit: the Firewall monster returns to the Extra Deck and is Special Summoned');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
process.exit(fails ? 1 : 0);
