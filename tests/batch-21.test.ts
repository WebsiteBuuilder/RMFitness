// Speed Duel card scripts of batch 21 (run: npx tsx tests/batch-21.test.ts)
// One targeted check per scripted card: its main effect really happens in a duel.
import { Engine } from '../src/eds/engine';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';
import { aiAction } from '../src/eds/ai';

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
import type { CardInfo } from '../src/eds/types';

// "Fossil Fusion" is not in this game's card pool: a test-only stand-in (Shell Knight's Summon option reads it in the GY).
const fake = (info: Partial<CardInfo> & { name: string }) => {
  const full = { id: 991000 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
if (!DB.get('Fossil Fusion')) fake({ name: 'Fossil Fusion', kind: 'spell', sub: 'Normal', desc: 'Fusion Summon 1 "Fossil" Fusion Monster from your Extra Deck, by banishing Fusion Materials listed on it from either GY.' });
const atk = (e: Engine, c: FieldCard | null) => (c ? e.atkOf(c) : -1);
const toGy = (e: Engine, p: Pid, name: string, reason: 'cost' | 'mill' = 'cost') => {
  const c = [...e.player(p).deck, ...e.player(p).hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name}`);
  run(e, e.sendToGrave(c.uid, reason));
  return c;
};
/** Special Summons a "Fossil" Fusion Monster from the Extra Deck as if by "Fossil Fusion" (its Summoning condition ignored). */
function placeFossil(e: Engine, p: Pid, name: string): FieldCard | null {
  const c = e.player(p).fusion.find((x) => x.name === name)!;
  e.state.fx.ignoreCond = c.uid;
  run(e, e.specialSummon(c.uid, p, 'atk', true, (fc) => void ((fc.tags ??= {}).fusS = 1)));
  e.state.fx.ignoreCond = undefined;
  return e.fieldCard(c.uid);
}

/** Puts a Field Spell face-up and active in a player's Field Zone. */
function putField(e: Engine, p: Pid, name: string): FieldCard {
  const fc = putST(e, p, name);
  const ps = e.player(p);
  ps.sz[ps.sz.findIndex((x) => x?.uid === fc.uid)] = null;
  fc.faceUp = true;
  fc.active = true;
  ps.field = fc;
  return fc;
}

section('Release from Stone');
{
  const e = duel(['Giant Soldier of Stone', 'Release from Stone']);
  const g = toGy(e, 0, 'Giant Soldier of Stone');
  e.banish(g.uid);
  const rfs = playTrap(e, 0, 'Release from Stone');
  const m = e.fieldCard(g.uid);
  check(!!m && active(e, rfs) && rfs!.equippedTo === g.uid, 'Release from Stone: the banished Rock monster is Special Summoned and stays linked to it');
  kill(e, [rfs]);
  check(zone(e, g) === 'gy', 'Release from Stone: when it leaves the field, that monster is destroyed');
  const e2 = duel(['Giant Soldier of Stone', 'Release from Stone']);
  const g2 = toGy(e2, 0, 'Giant Soldier of Stone');
  e2.banish(g2.uid);
  const r2 = playTrap(e2, 0, 'Release from Stone');
  kill(e2, [e2.fieldCard(g2.uid)]);
  check(zone(e2, r2) === 'gy', 'Release from Stone: when that monster is destroyed, this card goes too');
}

section('Reversal of Fate');
{
  const e = duel(['Arcana Force IV - The Emperor', 'Reversal of Fate']);
  const emp = place(e, 0, 'Arcana Force IV - The Emperor');
  emp!.tags!.coin = 1;
  const before = atk(e, emp);
  playTrap(e, 0, 'Reversal of Fate');
  check(before === 1900 && emp!.tags!.coin === 2 && atk(e, emp) === 900, `Reversal of Fate: The Emperor's Heads (+500) becomes Tails (-500): ${before} -> ${atk(e, emp)}`);
}

section('Revival Golem');
{
  const e = duel(['Revival Golem', 'Revival Golem']);
  const g = e.player(0).deck.find((c) => c.name === 'Revival Golem')!;
  run(e, e.sendToGrave(g.uid, 'mill'), { pick: ['Special Summon it from the GY'] });
  check(!!e.fieldCard(g.uid), 'Revival Golem: sent from the Deck to the GY, it Special Summons itself');
  const g2 = e.player(0).deck.find((c) => c.name === 'Revival Golem')!;
  run(e, e.sendToGrave(g2.uid, 'mill'));
  check(zone(e, g2) === 'gy', 'Revival Golem: only once per turn');
  endTurn(e);
  endTurn(e);
  const g3 = e.player(0).gy.find((c) => c.name === 'Revival Golem')!;
  run(e, e.sendToGrave(g3.uid, 'mill')); // already in the GY: nothing happens
  const e2 = duel(['Revival Golem']);
  const h = e2.player(0).deck.find((c) => c.name === 'Revival Golem')!;
  run(e2, e2.sendToGrave(h.uid, 'mill'), { pick: ['Add it to your hand'] });
  check(zone(e2, h) === 'hand', 'Revival Golem: or adds itself to the hand');
}

section('Sabersaurus');
{
  const e = duel(['Sabersaurus']);
  const s = summon(e, 0, 'Sabersaurus');
  check(!!s && atk(e, s) === 1900 && e.info('Sabersaurus').sub === 'Normal' && e.raceOf(s!) === 'Dinosaur', 'Sabersaurus: a 1900 ATK Dinosaur Normal Monster');
}

section('Sauropod Brachion');
{
  const e = duel(['Sabersaurus', 'Sauropod Brachion'], [FILL]);
  const sp = e.player(0).deck.find((c) => c.name === 'Sauropod Brachion')!;
  check(e.summonBlocked(0, sp, 'special', 'deck'), 'Sauropod Brachion: cannot be Special Summoned from the Deck');
  const saber = place(e, 0, 'Sabersaurus');
  const b = summon(e, 0, 'Sauropod Brachion', true, { pick: ['Sabersaurus'] });
  check(!!b && b.faceUp && zone(e, saber) === 'gy', 'Sauropod Brachion: Tribute Summoned with only 1 Dinosaur');
  effect(e, 0, b);
  check(!b!.faceUp && b!.pos === 'def', 'Sauropod Brachion: changes itself to face-down Defense Position');
  // Flip Summon: all other monsters go face-down.
  const opp = place(e, 1, FILL);
  endTurn(e);
  endTurn(e);
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: b!.uid });
  settle(e);
  check(b!.faceUp && !opp!.faceUp && opp!.pos === 'def', 'Sauropod Brachion: its Flip Summon changes the other monsters to face-down Defense Position');
  // Attacked: the opponent's battle damage is doubled (1400 ATK into 3000 DEF: 1600 x 2).
  const e2 = duel(['Sauropod Brachion'], [FILL], [], [], 1);
  const b2 = place(e2, 0, 'Sauropod Brachion', 'def');
  check(!b2, 'Sauropod Brachion: setup, place() from the Deck is refused');
  grab(e2, 0, 'Sauropod Brachion');
  const b3 = place(e2, 0, 'Sauropod Brachion', 'def');
  const a = place(e2, 1, FILL);
  endTurn(e2);
  endTurn(e2);
  toBattle(e2);
  attack(e2, a, b3);
  check(e2.player(1).lp === 4000 - 3200, `Sauropod Brachion: the opponent takes double battle damage (LP ${e2.player(1).lp})`);
}

section('Shell Knight');
{
  const e = duel(['Shell Knight', 'Gaia Plate the Earth Giant']);
  const s = summon(e, 0, 'Shell Knight', true, 'yes');
  check(!!s && s.pos === 'def' && e.player(1).lp === 3500, 'Shell Knight: Normal Summoned, changes to Defense Position and inflicts 500 damage');
  kill(e, [s], 1, 'yes');
  const gaia = [...e.player(0).hand].find((c) => c.name === 'Gaia Plate the Earth Giant');
  check(!!gaia && e.activationBlocked(0, gaia), 'Shell Knight: destroyed by an effect, adds a Level 8 Rock monster; that name is locked this turn');
  const e2 = duel(['Shell Knight', 'Gaia Plate the Earth Giant', 'Fossil Fusion']);
  toGy(e2, 0, 'Fossil Fusion');
  const s2 = place(e2, 0, 'Shell Knight');
  kill(e2, [s2], 1, 'yes', 'yes');
  check(e2.monsters(0).some((m) => m.name === 'Gaia Plate the Earth Giant'), 'Shell Knight: with "Fossil Fusion" in the GY, it Special Summons the Level 8 Rock instead');
}

section('Spiritual Earth Art - Kurogane');
{
  const e = duel(['Giant Soldier of Stone', 'Uraby', 'Spiritual Earth Art - Kurogane']);
  const g = place(e, 0, 'Giant Soldier of Stone');
  const u = toGy(e, 0, 'Uraby');
  playTrap(e, 0, 'Spiritual Earth Art - Kurogane', { pick: ['Giant Soldier of Stone'] }, { pick: ['Uraby'] });
  check(zone(e, g) === 'gy' && !!e.fieldCard(u.uid), 'Kurogane: Tributes an EARTH monster to Special Summon another Level 4 or lower EARTH monster from the GY');
}

section('Survival Instinct');
{
  const e = duel(['Uraby', 'Sabersaurus', 'Survival Instinct']);
  const a = toGy(e, 0, 'Uraby');
  const b = toGy(e, 0, 'Sabersaurus');
  playTrap(e, 0, 'Survival Instinct', { pick: ['Uraby', 'Sabersaurus'] });
  check(zone(e, a) === 'removed' && zone(e, b) === 'removed' && e.player(0).lp === 4800, 'Survival Instinct: banishes 2 Dinosaurs to gain 800 LP');
}

section("Survival's End");
{
  const e = duel(['Sabersaurus', 'Uraby', 'Tomozaurus', "Survival's End"]);
  const s = place(e, 0, 'Sabersaurus');
  const o = place(e, 1, FILL);
  playTrap(e, 0, "Survival's End", { pick: ['Uraby', 'Tomozaurus'] });
  const dinos = e.monsters(0).filter((m) => m.name === 'Uraby' || m.name === 'Tomozaurus');
  check(zone(e, s) === 'gy' && zone(e, o) === 'gy' && dinos.length === 2, "Survival's End: destroys 2 Normal Monsters, Special Summons 2 Dinosaurs from the Deck");
  endTurn(e);
  check(dinos.every((m) => zone(e, m) === 'gy'), "Survival's End: those Dinosaurs are destroyed in the End Phase");
  // GY effect: banish it to destroy a Dinosaur you control and 1 card the opponent controls.
  const e2 = duel(['Uraby', "Survival's End"], [FILL]);
  const u = place(e2, 0, 'Uraby');
  const foe = place(e2, 1, FILL);
  const se = toGy(e2, 0, "Survival's End");
  e2.apply({ type: 'QUICK_EFFECT', player: 0, uid: se.uid });
  settle(e2);
  check(zone(e2, se) === 'removed' && zone(e2, u) === 'gy' && zone(e2, foe) === 'gy', "Survival's End: GY effect destroys a Dinosaur you control and an opponent's card");
}

section('Time Stream');
{
  const e = duel(['Time Stream'], [], ['Fossil Warrior Skull Bone', 'Fossil Warrior Skull Knight', 'Fossil Dragon Skullgios']);
  const bone = placeFossil(e, 0, 'Fossil Warrior Skull Bone');
  playSpell(e, 0, 'Time Stream');
  const knight = e.monsters(0).find((m) => m.name === 'Fossil Warrior Skull Knight') ?? null;
  check(zone(e, bone) === 'gy' && !!knight && knight.tags?.fusS === 1, 'Time Stream: Tributes a Level 4 "Fossil" Fusion Monster for a Level 6 one from the Extra Deck');
  const ts = e.player(0).gy.find((c) => c.name === 'Time Stream')!;
  check(!e.canUseGraveEffect(0, ts.uid), 'Time Stream: its GY effect cannot be used the turn it was sent there');
  kill(e, [knight]);
  endTurn(e);
  endTurn(e);
  check(e.canUseGraveEffect(0, ts.uid), 'Time Stream: GY effect usable on a later turn');
  e.apply({ type: 'GRAVE_EFFECT', player: 0, uid: ts.uid });
  settle(e, { pick: ['Fossil Warrior Skull Bone'] }, { pick: ['Fossil Warrior Skull Knight'] });
  check(zone(e, ts) === 'removed' && zone(e, bone) === 'removed' && e.monsters(0).some((m) => m.name === 'Fossil Warrior Skull Knight'), 'Time Stream: banishes itself and a "Fossil" Fusion Monster to revive another');
}

section('Typhoon');
{
  const e = duel(['Typhoon'], ['Jurassic World']);
  const jw = putField(e, 1, 'Jurassic World');
  playTrap(e, 0, 'Typhoon');
  check(zone(e, jw) === 'gy', 'Typhoon: destroys a face-up Spell/Trap');
  // From the hand: the opponent controls 2 Spells/Traps and you control none.
  const e2 = duel(['Typhoon'], ['Jurassic World', 'Mirror Force']);
  const jw2 = putField(e2, 1, 'Jurassic World');
  putST(e2, 1, 'Mirror Force');
  const ty = grab(e2, 0, 'Typhoon');
  e2.apply({ type: 'QUICK_EFFECT', player: 0, uid: ty.uid });
  settle(e2);
  check(zone(e2, jw2) === 'gy' && zone(e2, ty) === 'gy', 'Typhoon: activated from the hand when the opponent controls 2 Spells/Traps and you control none');
}

section('Tyranno Infinity');
{
  const e = duel(['Uraby', 'Sabersaurus', 'Tyranno Infinity']);
  for (const n of ['Uraby', 'Sabersaurus']) e.banish(toGy(e, 0, n).uid);
  const t = place(e, 0, 'Tyranno Infinity');
  check(atk(e, t) === 2000, `Tyranno Infinity: ATK = banished Dinosaurs x 1000 (${atk(e, t)})`);
}

section('Ultimate Tyranno');
{
  const e = duel(['Ultimate Tyranno', 'Sabersaurus'], [FILL, FILL]);
  const t = place(e, 0, 'Ultimate Tyranno');
  const s = place(e, 0, 'Sabersaurus');
  const a = place(e, 1, FILL);
  const b = place(e, 1, FILL);
  endTurn(e);
  endTurn(e);
  toBattle(e);
  check(!e.canAttackWith(0, s!) && e.canAttackWith(0, t!), 'Ultimate Tyranno: while it can attack, other monsters cannot');
  attack(e, t, a);
  check(e.canAttackWith(0, t!) && !e.legalTargets(0, t!).some((m) => m.uid === a!.uid), 'Ultimate Tyranno: attacks again, but not the same monster');
  attack(e, t, b);
  check(zone(e, a) === 'gy' && zone(e, b) === 'gy' && !e.canAttackWith(0, t!) && e.canAttackWith(0, s!), 'Ultimate Tyranno: attacked every opponent monster once; then the others may attack');
}

section('Volcanic Eruption');
{
  const e = duel(['Jurassic World', 'Volcanic Eruption', 'Sabersaurus'], [FILL]);
  const jw = playSpell(e, 0, 'Jurassic World');
  const ve = putST(e, 0, 'Volcanic Eruption');
  const s = place(e, 0, 'Sabersaurus');
  const o = place(e, 1, FILL);
  check(!e.canActivateMain(0, ve.uid), 'Volcanic Eruption: cannot be activated in the Main Phase');
  endTurn(e, 'yes');
  check([jw, s, o].every((c) => zone(e, c) === 'gy') && zone(e, ve) === 'gy', 'Volcanic Eruption: activated in the End Phase with Jurassic World, destroys all cards on the field');
}
{
  // The computer only wipes the field when the opponent loses more there than it does.
  const ask = (mine: string[], theirs: string[]) => {
    const e = duel(['Jurassic World', 'Volcanic Eruption', ...mine], theirs);
    playSpell(e, 0, 'Jurassic World');
    putST(e, 0, 'Volcanic Eruption');
    for (const m of mine) place(e, 0, m);
    for (const m of theirs) place(e, 1, m);
    e.apply({ type: 'END_TURN', player: 0 });
    const pr = e.state.prompt;
    const a = pr?.kind === 'yesno' && pr.title === 'Activate Volcanic Eruption?' ? aiAction(e, 0)?.type : undefined;
    settle(e);
    return a;
  };
  check(ask(['Sabersaurus', 'Sabersaurus'], [FILL]) === 'NO', 'Volcanic Eruption (computer): not with a winning board');
  check(ask([], ['Sabersaurus', FILL, 'Sabersaurus']) === 'YES', 'Volcanic Eruption (computer): yes when the opponent has more on the field');
}

section('Weathering Soldier');
{
  const e = duel(['Weathering Soldier', 'Shell Knight']);
  const w = place(e, 0, 'Weathering Soldier');
  endTurn(e);
  check(atk(e, w) === 1400, 'Weathering Soldier: loses 600 ATK during your End Phase');
  endTurn(e);
  check(atk(e, w) === 1400, "Weathering Soldier: not during the opponent's End Phase");
  kill(e, [w], 1, 'yes');
  check(e.player(0).hand.some((c) => c.name === 'Shell Knight'), 'Weathering Soldier: destroyed by an effect, adds a card that lists "Fossil Fusion" (Shell Knight)');
}

section('White Veil');
{
  const e = duel(['Sabersaurus', 'White Veil'], [FILL, 'Mirror Force', 'Jurassic World']);
  const s = place(e, 0, 'Sabersaurus');
  const o = place(e, 1, FILL);
  const mf = putST(e, 1, 'Mirror Force');
  const jw = putField(e, 1, 'Jurassic World');
  endTurn(e);
  endTurn(e);
  const wv = playSpell(e, 0, 'White Veil', { pick: ['Sabersaurus'] });
  check(wv?.equippedTo === s!.uid, 'White Veil: equipped');
  toBattle(e);
  check(!e.cardActivationLocked(1, mf), 'White Veil: no lock outside its battles');
  e.state.battle = { attacker: s!.uid, target: o!.uid };
  check(e.cardActivationLocked(1, mf) && !e.responsesFor(1, 'attack', { uid: s!.uid, targetUid: o!.uid }).some((x) => x.uid === mf.uid), 'White Veil: the opponent cannot activate Spells/Traps while the equipped monster battles');
  e.state.battle = null;
  const since = e.state.log.length;
  attack(e, s, o, 'no');
  check(zone(e, o) === 'gy' && logHas(e, 'White Veil: the effects of', since) && !!e.fieldCard(jw.uid) && !e.isNegated(jw), "White Veil: the opponent's face-up Spells/Traps are negated for that battle only");
  kill(e, [wv]);
  check(e.player(0).lp === 1000, 'White Veil: when it leaves the field, its controller takes 3000 damage');
}

{
  const e = duel(['Sabersaurus', 'White Veil'], [FILL, 'Mirror Force', 'Jurassic World']);
  const s = place(e, 0, 'Sabersaurus');
  const o = place(e, 1, FILL);
  const mf = putST(e, 1, 'Mirror Force');
  const jw = putField(e, 1, 'Jurassic World');
  endTurn(e);
  endTurn(e);
  playSpell(e, 0, 'White Veil', { pick: ['Sabersaurus'] });
  toBattle(e);
  attack(e, s, o, 'yes');
  check(zone(e, o) === 'gy' && zone(e, mf) === 'gy' && zone(e, jw) === 'gy', "White Veil: destroying a monster by battle destroys the opponent's Spells/Traps");
}

console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
process.exit(fails ? 1 : 0);
