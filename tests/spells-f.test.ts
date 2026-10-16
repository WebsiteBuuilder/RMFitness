// Group F audit: Speed Duel Spell/Trap scripts (cards-09.ts: Rare Metalmorph ... Tail Swipe; cards-20.ts: Arcana Call, Cipher Bit,
// Cynet Circuit, Double Cipher, Rank-Up-Magic Astral Force, Re-dyce-cle) checked against the real card text. Run: npx tsx tests/spells-f.test.ts
import { Engine } from '../src/eds/engine';
import type { Card, CardInfo, FieldCard, Pid, Pos } from '../src/eds/types';
import { getEffect } from '../src/eds/effects';
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

// ---------- audit-09 extras ----------
// Cards this game's pool lacks: test-only stand-ins added to the card database.
const fake = (info: Partial<CardInfo> & { name: string }) => {
  const full = { id: 993000 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
fake({ name: 'Red Dragon Archfiend', sub: 'Synchro', level: 8, atk: 3000, def: 2000, race: 'Dragon', attribute: 'DARK' });
fake({ name: 'Test Tuner One', sub: 'Effect', tuner: true, level: 1, atk: 300, def: 300, race: 'Dragon', attribute: 'DARK' });
fake({ name: 'SPYRAL Super Agent', sub: 'Effect', level: 4, atk: 1900, def: 1200, race: 'Warrior', attribute: 'EARTH' });
fake({ name: 'Venom Test Serpent', sub: 'Effect', level: 3, atk: 1000, def: 1000, race: 'Reptile', attribute: 'DARK' });
const atk = (e: Engine, c: FieldCard | null) => (c ? e.atkOf(c) : -1);
/** A duel on player 0's second turn (Main Phase 1), so attacks are possible. */
function turn2(d0: string[], d1: string[] = [], x0: string[] = [], x1: string[] = []): Engine {
  const e = duel(d0, d1, x0, x1, 1);
  endTurn(e);
  return e;
}
/** Sends a card of `p` (deck/hand/GY) to the GY as if by a cost. */
function toGy(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.hand].find((x) => x.name === name) ?? ps.gy.find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  if (zone(e, c) !== 'gy') run(e, e.sendToGrave(c.uid, 'cost'));
  return c;
}
/** A face-up, active Spell/Trap in a Spell & Trap Zone (or the Field Zone). */
function putActive(e: Engine, p: Pid, name: string): FieldCard {
  const fc = putST(e, p, name);
  fc.faceUp = true;
  fc.active = true;
  if (e.info(name).sub === 'Field') {
    const ps = e.player(p);
    ps.sz[ps.sz.findIndex((x) => x?.uid === fc.uid)] = null;
    ps.field = fc;
  }
  return fc;
}
/** Puts a monster straight onto the field (no Summon). */
function putMZ(e: Engine, p: Pid, name: string, pos: Pos = 'atk', faceUp = true): FieldCard {
  const c = grab(e, p, name);
  const ps = e.player(p);
  ps.hand.splice(ps.hand.findIndex((x) => x.uid === c.uid), 1);
  const fc: FieldCard = { ...c, pos, faceUp, placedTurn: -1, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
  ps.mz[ps.mz.findIndex((x) => x === null)] = fc;
  return fc;
}
const gyHas = (e: Engine, p: Pid, name: string) => e.player(p).gy.some((c) => c.name === name);
const handHas = (e: Engine, p: Pid, name: string) => e.player(p).hand.some((c) => c.name === name);
const onField = (e: Engine, p: Pid, name: string) => e.monsters(p).find((m) => m.name === name) ?? null;
const graveEffect = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'GRAVE_EFFECT', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const setRoll = (e: Engine, n: number) => ((e as unknown as { roll: () => number }).roll = () => n);

fake({ name: 'Speedroid Test Tuner', sub: 'Effect', tuner: true, level: 3, atk: 1200, def: 600, race: 'Machine', attribute: 'WIND' });
fake({ name: 'Firewall Test Dragon', sub: 'Link', linkRating: 4, atk: 2500, race: 'Cyberse', attribute: 'LIGHT', desc: '2+ monsters' });
fake({ name: 'Number Test: Rank Six Fairy', sub: 'Xyz', rank: 6, atk: 2800, def: 2000, race: 'Fairy', attribute: 'WATER', desc: '3 Level 6 monsters' });
fake({ name: 'Dark Test Link', sub: 'Link', linkRating: 2, atk: 1600, race: 'Fiend', attribute: 'DARK', desc: '2 monsters' });
const hasResponse = (e: Engine, p: Pid, name: string) => e.state.prompt?.kind === 'response' && e.state.prompt.player === p && e.state.prompt.options.some((o) => o.label.startsWith(name));
const lp = (e: Engine, p: Pid) => e.player(p).lp;
const CARDS = new Set<string>();
const FIXED = new Set<string>();
const card = (name: string, fixed = false) => {
  CARDS.add(name);
  if (fixed) FIXED.add(name);
  section(name);
};
/** Advances the attacking turn player to the Battle Phase and declares an attack, stopping at the first response prompt (no auto answers). */
const clearHand = (e: Engine, p: Pid) => {
  const ps = e.player(p);
  ps.gy.push(...ps.hand.splice(0));
};
/** Sends an Extra Deck monster of `p` to the GY. */
function extraToGy(e: Engine, p: Pid, name: string): Card {
  const c = e.player(p).fusion.find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} in the Extra Deck of ${p}`);
  run(e, e.sendToGrave(c.uid, 'cost'));
  return c;
}
const declare = (e: Engine, a: FieldCard | null, t: FieldCard | null) => e.apply({ type: 'ATTACK', player: e.state.turnPlayer, uid: a!.uid, target: t ? t.uid : null });

// ======================= cards-20.ts =======================
card('Rank-Up-Magic Astral Force');
{
  const e = duel(['Rank-Up-Magic Astral Force'], [], ['Number 103: Ragnazero', 'Number Test: Rank Six Fairy']);
  place(e, 0, FILL);
  place(e, 0, FILL);
  const x = e.player(0).fusion.find((c) => c.name === 'Number 103: Ragnazero')!;
  e.apply({ type: 'SPECIAL', player: 0, uid: x.uid });
  settle(e);
  playSpell(e, 0, 'Rank-Up-Magic Astral Force');
  const up = onField(e, 0, 'Number Test: Rank Six Fairy');
  check(!!up && up.tags?.xyzS === 1 && e.matsOf(up).length === 3, 'Astral Force: Rank 4 WATER Fairy ranks up into the Rank 6 WATER Fairy, materials transferred');
  endTurn(e);
  endTurn(e, 'yes');
  const fill = e.player(0).hand.find((c) => c.name === FILL)!;
  check(handHas(e, 0, 'Rank-Up-Magic Astral Force') && e.summonBlocked(0, fill, 'special', 'hand'), 'Astral Force: added from the GY instead of the normal draw, then no other Special Summons');
  const e2 = duel(['Rank-Up-Magic Astral Force'], [], ['Number Test: Rank Six Fairy']);
  const sp = grab(e2, 0, 'Rank-Up-Magic Astral Force');
  check(!e2.canActivateMain(0, sp.uid), 'Astral Force: needs an Xyz Monster to rank up');
}

card('Arcana Call');
{
  const e = duel(['Arcana Force III - The Empress', 'Arcana Force IV - The Emperor', 'Arcana Call']);
  const emp = place(e, 0, 'Arcana Force III - The Empress');
  emp!.tags!.coin = 1;
  const emperor = toGy(e, 0, 'Arcana Force IV - The Emperor');
  playTrap(e, 0, 'Arcana Call');
  check(zone(e, emperor) === 'removed' && atk(e, emp) === 1800, "Arcana Call: the Empress takes the banished Emperor's effect for its coin result");
  endTurn(e);
  check(atk(e, emp) === 1300, 'Arcana Call: only until the End Phase');
}

card('Cipher Bit');
{
  const e = duel(['Cipher Bit'], [], ['Galaxy-Eyes Cipher Dragon']);
  const g = place(e, 0, 'Galaxy-Eyes Cipher Dragon');
  playTrap(e, 0, 'Cipher Bit');
  check(e.matsOf(g!).some((c) => c.name === 'Cipher Bit'), 'Cipher Bit: attached as an Xyz Material');
  kill(e, [g], 1);
  check(!!e.fieldCard(g!.uid), 'Cipher Bit: the next destruction this turn does not destroy it');
  kill(e, [g], 1);
  check(!e.fieldCard(g!.uid), 'Cipher Bit: only once');
  const e2 = duel(['Cipher Bit'], [], ['Galaxy-Eyes Cipher Dragon']);
  const g2 = place(e2, 0, 'Galaxy-Eyes Cipher Dragon');
  playTrap(e2, 0, 'Cipher Bit');
  endTurn(e2);
  kill(e2, [g2], 1);
  check(!e2.fieldCard(g2!.uid), 'Cipher Bit: the protection ends with the turn');
}

card('Double Cipher');
{
  const e = duel(['Double Cipher'], ['Blue-Eyes White Dragon'], ['Galaxy-Eyes Cipher Dragon', 'Galaxy-Eyes Cipher Dragon']);
  const g = place(e, 0, 'Galaxy-Eyes Cipher Dragon');
  e.attachMat(g!, e.player(0).deck.find((c) => c.name === FILL)!.uid);
  const dc = putST(e, 0, 'Double Cipher');
  check(!e.canActivateMain(0, dc.uid), 'Double Cipher: not while your monster has the highest ATK');
  place(e, 1, 'Blue-Eyes White Dragon');
  act(e, 0, dc.uid);
  check(e.matsOf(g!).length === 0 && e.monsters(0).filter((m) => m.name === 'Galaxy-Eyes Cipher Dragon').length === 2, 'Double Cipher: detaches all materials, Special Summons a copy from the Extra Deck');
}

card('Re-dyce-cle');
{
  const e = duel(['Speedroid Test Tuner', 'Evoltile Lagosucho', 'Re-dyce-cle'], [], ['Hi-Speedroid Puzzle']);
  const tuner = toGy(e, 0, 'Speedroid Test Tuner');
  setRoll(e, 1);
  playTrap(e, 0, 'Re-dyce-cle');
  const m = e.fieldCard(tuner.uid);
  check(!!m && e.isNegated(m) && levelOf(e, m) === 1, 'Re-dyce-cle: the Speedroid Tuner is back, negated, its Level is the die result');
  place(e, 0, 'Evoltile Lagosucho');
  const c = e.player(0).gy.find((x) => x.name === 'Re-dyce-cle')!;
  graveEffect(e, 0, c);
  check(zone(e, c) === 'removed' && e.monsters(0).some((x) => x.name === 'Hi-Speedroid Puzzle'), 'Re-dyce-cle: banished from the GY to Synchro Summon a WIND Synchro Monster');
}

card('Cynet Circuit');
{
  const e = duel(['Gagagigo', 'Cynet Circuit', 'Cynet Circuit'], [], ['Firewall Test Dragon']);
  const left = place(e, 0, FILL);
  const fw = place(e, 0, 'Firewall Test Dragon');
  kill(e, [left]);
  toGy(e, 0, 'Gagagigo');
  const second = putST(e, 0, 'Cynet Circuit');
  playTrap(e, 0, 'Cynet Circuit', { pick: ['Firewall Test Dragon'] }, { pick: [FILL, 'Gagagigo'] });
  check(e.monsters(0).length === 3 && !!fw, 'Cynet Circuit: monsters from the GY go to the zones linked to the Firewall monster');
  kill(e, [left]);
  check(!e.canActivateMain(0, second.uid), 'Cynet Circuit: its first effect only once per turn');
  const e2 = duel(['Cynet Circuit'], [], ['Firewall Test Dragon']);
  const fw2 = place(e2, 0, 'Firewall Test Dragon');
  kill(e2, [fw2]);
  const cc = toGy(e2, 0, 'Cynet Circuit');
  check(!e2.canUseGraveEffect(0, cc.uid), 'Cynet Circuit: GY effect needs 2000 LP or less');
  e2.player(0).lp = 2000;
  graveEffect(e2, 0, cc, 'yes');
  check(zone(e2, cc) === 'removed' && !!e2.fieldCard(fw2!.uid), 'Cynet Circuit: the Firewall monster returns to the Extra Deck, then is Special Summoned');
}

// ======================= cards-09.ts =======================
card('Rare Metalmorph');
{
  const e = duel(['Cycroid', 'Rare Metalmorph'], ['Shield Crush', 'Shield Crush']);
  const m = place(e, 0, 'Cycroid', 'def');
  const mm = playTrap(e, 0, 'Rare Metalmorph');
  check(atk(e, m) === 1300 && active(e, mm), 'Rare Metalmorph: the Machine gains 500 ATK; the Trap stays on the field');
  endTurn(e);
  playSpell(e, 1, 'Shield Crush', { respond: 'Rare Metalmorph' });
  check(!!e.fieldCard(m!.uid) && gyHas(e, 1, 'Shield Crush'), 'Rare Metalmorph: negates a Spell that targets that monster');
  playSpell(e, 1, 'Shield Crush', { respond: 'Rare Metalmorph' });
  check(zone(e, m) === 'gy', 'Rare Metalmorph: only once');
  check(gyHas(e, 0, 'Rare Metalmorph'), 'Rare Metalmorph: destroyed when that monster leaves the field');
  const e2 = duel(['Rare Metalmorph']);
  place(e2, 0, FILL);
  check(!e2.canActivateMain(0, putST(e2, 0, 'Rare Metalmorph').uid), 'Rare Metalmorph: needs a Machine monster');
}

card('Rare Value');
{
  const e = duel(['Crystal Beast Topaz Tiger', 'Crystal Beast Amber Mammoth', 'Rare Value']);
  putActive(e, 0, 'Crystal Beast Topaz Tiger');
  putActive(e, 0, 'Crystal Beast Amber Mammoth');
  const rv = grab(e, 0, 'Rare Value');
  const h = e.player(0).hand.length;
  e.apply({ type: 'ACTIVATE', player: 0, uid: rv.uid, zone: e.player(0).sz.findIndex((z) => z === null) });
  let who: Pid | undefined;
  for (let i = 0; i < 10 && e.state.prompt; i++) {
    if (e.state.prompt.kind === 'select') who = e.state.prompt.player;
    settle(e, 'pass');
    if (who !== undefined) break;
  }
  settle(e);
  check(who === 1 && e.player(0).gy.filter((c) => c.name.startsWith('Crystal Beast')).length === 1 && e.player(0).hand.length === h - 1 + 2, 'Rare Value: the opponent chooses a "Crystal Beast" to send to the GY, then you draw 2');
  const e2 = duel(['Crystal Beast Topaz Tiger', 'Rare Value']);
  putActive(e2, 0, 'Crystal Beast Topaz Tiger');
  check(!e2.canActivateMain(0, grab(e2, 0, 'Rare Value').uid), 'Rare Value: needs 2 "Crystal Beast" cards');
}

card('Re-Fusion');
{
  const e = duel(['Re-Fusion'], [], ['Flame Swordsman']);
  const fs = place(e, 0, 'Flame Swordsman');
  kill(e, [fs]);
  const rf = playSpell(e, 0, 'Re-Fusion');
  check(lp(e, 0) === 3200 && !!e.fieldCard(fs!.uid) && e.fieldCard(fs!.uid)!.equips.includes(rf!.uid), 'Re-Fusion: pay 800 LP, revive the Fusion Monster, equipped');
  kill(e, [rf]);
  check(zone(e, fs) === 'removed', 'Re-Fusion: destroyed, the equipped monster is banished');
  const e2 = duel(['Re-Fusion'], [], ['Flame Swordsman']);
  const fs2 = place(e2, 0, 'Flame Swordsman');
  kill(e2, [fs2]);
  const rf2 = playSpell(e2, 0, 'Re-Fusion');
  kill(e2, [e2.fieldCard(fs2!.uid)]);
  check(zone(e2, fs2) === 'gy' && zone(e2, rf2) === 'gy', 'Re-Fusion: the monster destroyed first goes to the GY, not banished');
}

card('Ready for Intercepting');
{
  const e = duel(['Ready for Intercepting']);
  const c = place(e, 1, FILL);
  playTrap(e, 0, 'Ready for Intercepting');
  check(!c!.faceUp && c!.pos === 'def', 'Ready for Intercepting: the Warrior goes to face-down Defense Position');
  const e2 = duel(['Ready for Intercepting'], ['Cycroid']);
  place(e2, 1, 'Cycroid');
  check(!e2.canActivateMain(0, putST(e2, 0, 'Ready for Intercepting').uid), 'Ready for Intercepting: only Warrior or Spellcaster monsters');
}

card('Recurring Nightmare', true);
{
  const e = duel(['Stealthroid', 'Steelswarm Sting', 'Recurring Nightmare']);
  toGy(e, 0, 'Stealthroid');
  toGy(e, 0, 'Steelswarm Sting');
  playSpell(e, 0, 'Recurring Nightmare');
  check(handHas(e, 0, 'Stealthroid') && handHas(e, 0, 'Steelswarm Sting'), 'Recurring Nightmare: 2 DARK monsters with 0 DEF back to the hand');
  const e2 = duel(['Stealthroid', 'Recurring Nightmare'], [], ['Dark Test Link']);
  toGy(e2, 0, 'Stealthroid');
  extraToGy(e2, 0, 'Dark Test Link');
  check(!e2.canActivateMain(0, grab(e2, 0, 'Recurring Nightmare').uid), 'Recurring Nightmare: a Link Monster (no DEF) does not count as 0 DEF');
}

card('Red Screen');
{
  const e = duel(['Red Screen']);
  playTrap(e, 0, 'Red Screen');
  endTurn(e);
  check(lp(e, 0) === 3000, 'Red Screen: 1000 LP in your End Phase');
  const m = place(e, 1, FILL);
  toBattle(e);
  check(!e.canAttackWith(1, m!), "Red Screen: the opponent's monsters cannot attack");
  endTurn(e);
  check(lp(e, 0) === 3000, 'Red Screen: no payment in the opponent\'s End Phase');
  const e2 = duel(['Red Screen']);
  const rs = playTrap(e2, 0, 'Red Screen');
  e2.player(0).lp = 900;
  endTurn(e2);
  check(zone(e2, rs) === 'gy' && lp(e2, 0) === 900, 'Red Screen: destroyed when you cannot pay');
  const e3 = duel(['Red Screen', 'Red Dragon Archfiend', 'Test Tuner One']);
  const rs3 = playTrap(e3, 0, 'Red Screen');
  toGy(e3, 0, 'Test Tuner One');
  check(!e3.canUseMonsterEffect(0, rs3!), 'Red Screen: needs "Red Dragon Archfiend" on the field');
  place(e3, 0, 'Red Dragon Archfiend');
  effect(e3, 0, rs3);
  check(zone(e3, rs3) === 'gy' && !!onField(e3, 0, 'Test Tuner One'), 'Red Screen: destroys itself to Special Summon a Level 1 Tuner');
}

card('Red-Eyes Spirit');
{
  const e = duel(['Red-Eyes Black Dragon', 'Red-Eyes Spirit']);
  toGy(e, 0, 'Red-Eyes Black Dragon');
  playTrap(e, 0, 'Red-Eyes Spirit');
  check(!!onField(e, 0, 'Red-Eyes Black Dragon'), 'Red-Eyes Spirit: revives a "Red-Eyes" monster');
  const e2 = duel(['Red-Eyes Spirit', 'Gaia The Fierce Knight']);
  toGy(e2, 0, 'Gaia The Fierce Knight');
  check(!e2.canActivateMain(0, putST(e2, 0, 'Red-Eyes Spirit').uid), 'Red-Eyes Spirit: only "Red-Eyes" monsters');
}

card('Release Restraint');
{
  const e = duel(['Gearfried the Iron Knight', 'Gearfried the Swordmaster', 'Release Restraint']);
  place(e, 0, 'Gearfried the Iron Knight');
  playSpell(e, 0, 'Release Restraint');
  check(!!onField(e, 0, 'Gearfried the Swordmaster') && gyHas(e, 0, 'Gearfried the Iron Knight'), 'Release Restraint: Tribute the Iron Knight, Special Summon the Swordmaster from the Deck');
  const e2 = duel(['Gearfried the Swordmaster', 'Release Restraint']);
  place(e2, 0, FILL);
  check(!e2.canActivateMain(0, grab(e2, 0, 'Release Restraint').uid), 'Release Restraint: needs Gearfried the Iron Knight');
}

card('Riryoku Field');
{
  const e = duel(['Riryoku Field'], ['Shield Crush'], [], [], 1);
  const m = place(e, 0, FILL, 'def');
  putST(e, 0, 'Riryoku Field');
  playSpell(e, 1, 'Shield Crush', { respond: 'Riryoku Field' });
  check(!!e.fieldCard(m!.uid) && gyHas(e, 1, 'Shield Crush') && gyHas(e, 0, 'Riryoku Field'), 'Riryoku Field: negates a Spell targeting 1 monster and destroys it');
  const e2 = duel(['Riryoku Field'], ['Pot of Greed'], [], [], 1);
  putST(e2, 0, 'Riryoku Field');
  act(e2, 1, grab(e2, 1, 'Pot of Greed').uid);
  check(gyHas(e2, 1, 'Pot of Greed') && !gyHas(e2, 0, 'Riryoku Field'), 'Riryoku Field: not against a Spell without a monster target');
}

card('Rising Energy');
{
  const e = duel(['Rising Energy']);
  const m = place(e, 0, FILL);
  const h = e.player(0).hand.length;
  playTrap(e, 0, 'Rising Energy');
  check(atk(e, m) === 2900 && e.player(0).hand.length === h - 1, 'Rising Energy: discard 1, +1500 ATK');
  endTurn(e);
  check(atk(e, m) === 1400, 'Rising Energy: until the End Phase');
}

card('Rite of Spirit');
{
  const e = duel(["Gravekeeper's Assailant", 'Rite of Spirit'], ['Necrovalley']);
  putActive(e, 1, 'Necrovalley');
  toGy(e, 0, "Gravekeeper's Assailant");
  playTrap(e, 0, 'Rite of Spirit');
  check(!!onField(e, 0, "Gravekeeper's Assailant"), "Rite of Spirit: revives a \"Gravekeeper's\" monster through Necrovalley");
}

card('Ritual Weapon');
{
  const e = duel(['Performance of Sword', 'Ritual Weapon']);
  const m = place(e, 0, 'Performance of Sword');
  playSpell(e, 0, 'Ritual Weapon');
  const i = e.info('Performance of Sword');
  check(atk(e, m) === i.atk! + 1500 && e.defOf(m!) === i.def! + 1500, 'Ritual Weapon: a Level 6 Ritual Monster gains 1500 ATK/DEF');
  const e2 = duel(['Black Luster Soldier', 'Ritual Weapon']);
  place(e2, 0, 'Black Luster Soldier');
  check(!e2.canActivateMain(0, grab(e2, 0, 'Ritual Weapon').uid), 'Ritual Weapon: not on a Level 7+ Ritual Monster');
}

card("Robbin' Zombie", true);
{
  const e = turn2(["Robbin' Zombie"]);
  playTrap(e, 0, "Robbin' Zombie");
  const a = place(e, 0, FILL);
  const n = e.player(1).gy.length;
  toBattle(e);
  attack(e, a, null);
  check(e.player(1).gy.length === n + 1, "Robbin' Zombie: your attacker's battle damage mills the top card of the opponent's Deck");
  const e2 = duel(["Robbin' Zombie", 'Gaia The Fierce Knight']);
  playTrap(e2, 0, "Robbin' Zombie");
  place(e2, 0, 'Gaia The Fierce Knight');
  endTurn(e2);
  const w = place(e2, 1, FILL);
  const n2 = e2.player(1).gy.length;
  const deck2 = e2.player(1).deck.length;
  toBattle(e2);
  attack(e2, w, onField(e2, 0, 'Gaia The Fierce Knight'));
  check(lp(e2, 1) === 3100 && e2.player(1).deck.length === deck2 - 1 && e2.player(1).gy.length === n2 + 2, "Robbin' Zombie: also when your attacked monster inflicts battle damage");
  const e3 = duel(["Robbin' Zombie"]);
  playTrap(e3, 0, "Robbin' Zombie");
  endTurn(e3);
  const a3 = place(e3, 1, FILL);
  const d3 = e3.player(1).deck.length;
  toBattle(e3);
  attack(e3, a3, null);
  check(e3.player(1).deck.length === d3 && lp(e3, 0) === 2600, "Robbin' Zombie: not when you take the damage");
}

card('Rock Bombardment', true);
{
  const e = duel(['Giant Soldier of Stone', 'Rock Bombardment']);
  playTrap(e, 0, 'Rock Bombardment');
  check(gyHas(e, 0, 'Giant Soldier of Stone') && lp(e, 1) === 3500, 'Rock Bombardment: a Rock monster from the Deck to the GY, 500 damage');
  const e2 = duel(['Giant Soldier of Stone', 'Rock Bombardment'], ['Shield Spear']);
  place(e2, 1, FILL);
  putST(e2, 1, 'Shield Spear');
  const rb = putST(e2, 0, 'Rock Bombardment');
  e2.apply({ type: 'ACTIVATE', player: 0, uid: rb.uid, zone: 0 });
  const paid = hasResponse(e2, 1, 'Shield Spear') && gyHas(e2, 0, 'Giant Soldier of Stone');
  settle(e2);
  check(paid && lp(e2, 1) === 3500, 'Rock Bombardment: the Rock monster is sent as the cost, before the opponent can respond');
}

card('Rope of Life');
{
  const e = duel(['Rope of Life'], ['Gaia The Fierce Knight']);
  const m = place(e, 0, FILL);
  putST(e, 0, 'Rope of Life');
  endTurn(e);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  toBattle(e);
  attack(e, g, m, { respond: 'Rope of Life' });
  const back = e.fieldCard(m!.uid);
  check(!!back && atk(e, back) === 2200 && e.player(0).hand.length === 0, 'Rope of Life: discard the whole hand, revive the monster with +800 ATK');
  const e2 = duel(['Rope of Life'], ['Gaia The Fierce Knight']);
  const m2 = place(e2, 0, FILL);
  putST(e2, 0, 'Rope of Life');
  endTurn(e2);
  clearHand(e2, 0);
  const g2 = place(e2, 1, 'Gaia The Fierce Knight');
  toBattle(e2);
  declare(e2, g2, m2);
  let offered = false;
  for (let i = 0; i < 20 && e2.state.prompt; i++) {
    if (hasResponse(e2, 0, 'Rope of Life')) offered = true;
    settle(e2, 'pass');
    break;
  }
  settle(e2);
  check(!offered && zone(e2, m2) === 'gy', 'Rope of Life: not with an empty hand');
}

card('Roulette Spider');
{
  const spider = (roll: number, mine: string[] = [], theirs: string[] = []) => {
    const e = duel(['Roulette Spider', ...mine], ['Gaia The Fierce Knight', ...theirs]);
    putST(e, 0, 'Roulette Spider');
    const my = mine.map((n) => place(e, 0, n));
    endTurn(e);
    const g = place(e, 1, 'Gaia The Fierce Knight');
    const other = theirs.map((n) => place(e, 1, n));
    toBattle(e);
    setRoll(e, roll);
    return { e, g, my, other };
  };
  {
    const { e, g } = spider(1);
    attack(e, g, null, { respond: 'Roulette Spider' });
    check(lp(e, 0) === 2000 - 2300 || (lp(e, 0) <= 0 && e.state.winner === 1) || lp(e, 0) === 0, 'Roulette Spider 1: halves your LP (then the direct attack hits)');
  }
  {
    const { e, g, my } = spider(2, [FILL]);
    attack(e, g, my[0], { respond: 'Roulette Spider' });
    check(!!e.fieldCard(my[0]!.uid) && lp(e, 0) === 4000 - 2300, 'Roulette Spider 2: the attack becomes a direct attack');
  }
  {
    const { e, g, my } = spider(3, ['Blue-Eyes White Dragon', FILL]);
    attack(e, g, my[1], { respond: 'Roulette Spider' }, { pick: ['Blue-Eyes White Dragon'] });
    check(zone(e, g) === 'gy' && !!e.fieldCard(my[1]!.uid) && lp(e, 1) === 4000 - 700, 'Roulette Spider 3: the attack target becomes your chosen monster');
  }
  {
    const { e, g, other } = spider(4, [], [FILL]);
    attack(e, g, null, { respond: 'Roulette Spider' });
    check(zone(e, other[0]) === 'gy' && lp(e, 1) === 4000 - 900 && lp(e, 0) === 4000, "Roulette Spider 4: the attacker battles another of the opponent's monsters");
  }
  {
    const { e, g } = spider(5);
    attack(e, g, null, { respond: 'Roulette Spider' });
    check(lp(e, 0) === 4000 && lp(e, 1) === 4000 - 2300, "Roulette Spider 5: negates the attack, damage equal to the attacker's ATK");
  }
  {
    const { e, g } = spider(6);
    attack(e, g, null, { respond: 'Roulette Spider' });
    check(zone(e, g) === 'gy' && lp(e, 0) === 4000, 'Roulette Spider 6: destroys the attacker');
  }
}

card('SPYRAL GEAR - Big Red');
{
  const e = duel(['SPYRAL GEAR - Drone', 'SPYRAL GEAR - Drone', 'SPYRAL GEAR - Big Red', 'SPYRAL GEAR - Big Red']);
  const d = toGy(e, 0, 'SPYRAL GEAR - Drone');
  const br = playSpell(e, 0, 'SPYRAL GEAR - Big Red');
  const m = e.fieldCard(d.uid);
  check(!!m && !!br && m.equips.includes(br.uid) && e.shielded(m, 'battle'), 'Big Red: revives a "SPYRAL" monster, equipped; it cannot be destroyed by battle');
  toGy(e, 0, 'SPYRAL GEAR - Drone');
  check(!e.canActivateMain(0, grab(e, 0, 'SPYRAL GEAR - Big Red').uid), 'Big Red: only 1 activation per turn');
  kill(e, [m]);
  check(zone(e, br) === 'gy', 'Big Red: leaves with its monster');
}

card('SPYRAL MISSION - Assault');
{
  const e = turn2(['SPYRAL MISSION - Assault', 'SPYRAL GEAR - Drone']);
  const t = place(e, 1, FILL);
  const as = playSpell(e, 0, 'SPYRAL MISSION - Assault');
  const d = place(e, 0, 'SPYRAL GEAR - Drone');
  d!.atkMod = 3000;
  const h = e.player(0).hand.length;
  toBattle(e);
  attack(e, d, t, { respond: 'SPYRAL MISSION - Assault' });
  check(zone(e, t) === 'gy' && e.player(0).hand.length === h + 1, 'Assault: a "SPYRAL" monster destroys a monster by battle, draw 1');
  for (let i = 0; i < 4; i++) endTurn(e);
  check(active(e, as), 'Assault: still there after 2 of your End Phases');
  endTurn(e);
  check(zone(e, as) === 'gy', 'Assault: destroyed in your 3rd End Phase after activation');
  const e2 = duel(['SPYRAL MISSION - Assault', 'SPYRAL GEAR - Drone']);
  const a2 = toGy(e2, 0, 'SPYRAL MISSION - Assault');
  const d2 = grab(e2, 0, 'SPYRAL GEAR - Drone');
  graveEffect(e2, 0, a2);
  check(zone(e2, a2) === 'removed' && !!e2.fieldCard(d2.uid), 'Assault: banished from the GY, Special Summon a "SPYRAL" monster from the hand');
}

card('SPYRAL Resort');
{
  const e = duel(['SPYRAL Resort', 'SPYRAL GEAR - Drone']);
  const r = putActive(e, 0, 'SPYRAL Resort');
  effect(e, 0, r);
  check(handHas(e, 0, 'SPYRAL GEAR - Drone') && !e.canUseMonsterEffect(0, r), 'SPYRAL Resort: adds a "SPYRAL" monster, once per turn');
  const d = place(e, 0, 'SPYRAL GEAR - Drone');
  e.actor = 1;
  const shielded = e.untargetable(d!);
  e.actor = 0;
  check(shielded && !e.untargetable(d!), 'SPYRAL Resort: your opponent cannot target your other "SPYRAL" cards');
  endTurn(e);
  check(zone(e, r) === 'gy', 'SPYRAL Resort: destroyed in your End Phase without a monster to shuffle back');
  const e2 = duel(['SPYRAL Resort']);
  const r2 = putActive(e2, 0, 'SPYRAL Resort');
  const f = toGy(e2, 0, FILL);
  endTurn(e2);
  check(!!e2.fieldCard(r2.uid) && zone(e2, f) === 'deck', 'SPYRAL Resort: or a monster from the GY is shuffled into the Deck');
}

card("Sabatiel - The Philosopher's Stone");
{
  const S = "Sabatiel - The Philosopher's Stone";
  const e = duel(['Winged Kuriboh', 'Polymerization', S, S]);
  check(!e.canActivateMain(0, grab(e, 0, S).uid), 'Sabatiel: needs a "Winged Kuriboh" in the GY');
  toGy(e, 0, 'Winged Kuriboh');
  playSpell(e, 0, S);
  check(lp(e, 0) === 2000 && handHas(e, 0, 'Polymerization'), 'Sabatiel: pay half your LP, add a Polymerization');
  const e2 = duel([S, S, S], ['Gaia The Fierce Knight']);
  const c = toGy(e2, 0, S);
  toGy(e2, 0, S);
  toGy(e2, 0, S);
  const m = place(e2, 0, FILL);
  place(e2, 1, 'Gaia The Fierce Knight');
  graveEffect(e2, 0, c, { pick: [FILL] });
  check(atk(e2, m) === 1400 + 2300 && e2.player(0).removed.length === 3, 'Sabatiel: banish 3 copies, a monster gains the highest ATK on the field');
  endTurn(e2);
  check(atk(e2, m) === 1400, 'Sabatiel: until the end of the turn');
}

card("Sage's Stone");
{
  const e = duel(['Dark Magician Girl', 'Dark Magician', "Sage's Stone"]);
  const sg = grab(e, 0, "Sage's Stone");
  check(!e.canActivateMain(0, sg.uid), "Sage's Stone: needs a face-up Dark Magician Girl");
  place(e, 0, 'Dark Magician Girl');
  act(e, 0, sg.uid);
  check(!!onField(e, 0, 'Dark Magician'), "Sage's Stone: Special Summons Dark Magician from the Deck");
}

card('Salvage');
{
  const e = duel(['Slushy', 'Aqua Madoor', 'Salvage']);
  toGy(e, 0, 'Slushy');
  toGy(e, 0, 'Aqua Madoor');
  playSpell(e, 0, 'Salvage');
  check(handHas(e, 0, 'Slushy') && handHas(e, 0, 'Aqua Madoor'), 'Salvage: 2 WATER monsters with 1500 or less ATK back to the hand');
  const e2 = duel(['Slushy', 'Gagagigo', 'Salvage']);
  toGy(e2, 0, 'Slushy');
  toGy(e2, 0, 'Gagagigo');
  check(!e2.canActivateMain(0, grab(e2, 0, 'Salvage').uid), 'Salvage: a WATER monster with more than 1500 ATK does not count');
}

card('Scrum Force');
{
  const e = duel(['Scrum Force', 'Shield Spear']);
  const sf = playTrap(e, 0, 'Scrum Force');
  const a = place(e, 0, FILL, 'def');
  e.actor = 1;
  const one = e.untargetable(a!);
  e.actor = 0;
  check(!one, 'Scrum Force: not with only 1 face-up Defense Position monster');
  place(e, 0, FILL, 'def');
  e.actor = 1;
  const safe = e.untargetable(a!);
  e.actor = 0;
  kill(e, [a], 1);
  check(safe && !!e.fieldCard(a!.uid), "Scrum Force: with 2 face-up Defense Position monsters, the opponent cannot target or destroy them by effects");
  kill(e, [a], 0);
  check(!e.fieldCard(a!.uid), 'Scrum Force: your own effects still destroy them');
  const sub = putST(e, 0, 'Shield Spear');
  kill(e, [sf], 1);
  check(!!e.fieldCard(sf!.uid) && zone(e, sub) === 'gy', 'Scrum Force: another card in your Spell & Trap Zone is destroyed instead');
}

card('Sealing Ceremony of Mokuton');
{
  const e = duel(['Sealing Ceremony of Mokuton']);
  const s = playTrap(e, 0, 'Sealing Ceremony of Mokuton');
  const m = place(e, 0, FILL);
  toGy(e, 1, FILL);
  toGy(e, 1, FILL);
  effect(e, 0, s, { pick: [FILL] }, { pick: [FILL, FILL] });
  check(zone(e, m) === 'gy' && e.player(1).removed.length === 2, "Mokuton: Tribute a face-up EARTH monster, banish up to 2 cards from the opponent's GY");
  place(e, 0, FILL);
  check(!e.canUseMonsterEffect(0, s!), 'Mokuton: once per turn');
}

card('Sealing Ceremony of Suiton');
{
  const e = duel(['Sealing Ceremony of Suiton', 'Slushy', 'Slushy']);
  const s = playTrap(e, 0, 'Sealing Ceremony of Suiton');
  grab(e, 0, 'Slushy');
  grab(e, 0, 'Slushy');
  toGy(e, 1, FILL);
  toGy(e, 1, FILL);
  effect(e, 0, s);
  check(gyHas(e, 0, 'Slushy') && e.player(1).removed.length === 1, "Suiton: a WATER monster from the hand to the GY, banish 1 card from the opponent's GY");
  check(!e.canUseMonsterEffect(0, s!), 'Suiton: once per turn');
}

card('Security Orb');
{
  const e = duel(['Security Orb'], ['Gaia The Fierce Knight']);
  putST(e, 0, 'Security Orb');
  endTurn(e);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  toBattle(e);
  attack(e, g, null, { respond: 'Security Orb' });
  check(g!.pos === 'def' && lp(e, 0) === 4000, "Security Orb: the attacker's battle position changes");
  const e2 = duel(['Security Orb'], ['Mystical Space Typhoon', 'Gaia The Fierce Knight'], [], [], 1);
  putST(e2, 0, 'Security Orb');
  const g2 = place(e2, 1, 'Gaia The Fierce Knight');
  playSpell(e2, 1, 'Mystical Space Typhoon');
  check(gyHas(e2, 0, 'Security Orb') && zone(e2, g2) === 'gy', "Security Orb: Set and destroyed by the opponent's Spell, destroy 1 monster");
  const e3 = duel(['Security Orb'], ['Gaia The Fierce Knight'], [], [], 1);
  const so3 = putST(e3, 0, 'Security Orb');
  const g3 = place(e3, 1, 'Gaia The Fierce Knight');
  kill(e3, [so3], 0);
  check(zone(e3, g3) === 'mz', 'Security Orb: not when your own card destroys it');
}

card('Shard of Greed');
{
  const e = duel(['Shard of Greed']);
  const s = playSpell(e, 0, 'Shard of Greed');
  e.draw(0, 1);
  check(s!.counters === 0, 'Shard of Greed: no counter for a draw by a card effect');
  endTurn(e);
  endTurn(e);
  check(s!.counters === 1 && !e.canUseMonsterEffect(0, s!), 'Shard of Greed: a Greed Counter for the normal draw; needs 2 to use');
  endTurn(e);
  endTurn(e);
  const h = e.player(0).hand.length;
  effect(e, 0, s);
  check(zone(e, s) === 'gy' && e.player(0).hand.length === h + 2, 'Shard of Greed: sent to the GY with 2 counters, draw 2');
}

card('Shield Crush');
{
  const e = duel(['Shield Crush']);
  const t = place(e, 1, FILL, 'def');
  playSpell(e, 0, 'Shield Crush');
  check(zone(e, t) === 'gy', 'Shield Crush: destroys a Defense Position monster');
  const e2 = duel(['Shield Crush']);
  place(e2, 1, FILL);
  check(!e2.canActivateMain(0, grab(e2, 0, 'Shield Crush').uid), 'Shield Crush: not an Attack Position monster');
}

card('Shield Spear');
{
  const e = duel(['Shield Spear']);
  const m = place(e, 1, FILL);
  playTrap(e, 0, 'Shield Spear');
  check(atk(e, m) === 1800 && e.defOf(m!) === 1600, 'Shield Spear: a face-up monster on the field gains 400 ATK/DEF');
  endTurn(e);
  check(atk(e, m) === 1400, 'Shield Spear: until the end of the turn');
}

card('Shrink');
{
  const e = duel(['Shrink'], ['Gaia The Fierce Knight']);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  playSpell(e, 0, 'Shrink');
  check(atk(e, g) === 1150, 'Shrink: original ATK halved');
  endTurn(e);
  check(atk(e, g) === 2300, 'Shrink: until the end of the turn');
  const e2 = duel(['Shrink'], ['Gaia The Fierce Knight']);
  const g2 = place(e2, 1, 'Gaia The Fierce Knight');
  putST(e2, 0, 'Shrink');
  endTurn(e2);
  toBattle(e2);
  attack(e2, g2, null, { respond: 'Shrink' });
  check(lp(e2, 0) === 4000 - 1150, "Shrink: a Quick-Play Spell, usable during the opponent's turn");
}

card('Silent Doom');
{
  const e = turn2(['Gaia The Fierce Knight', 'Silent Doom']);
  toGy(e, 0, 'Gaia The Fierce Knight');
  playSpell(e, 0, 'Silent Doom');
  const g = onField(e, 0, 'Gaia The Fierce Knight');
  toBattle(e);
  check(!!g && g.pos === 'def' && g.faceUp && !e.canAttackWith(0, g), 'Silent Doom: a Normal Monster back in face-up Defense Position; it cannot attack');
  const e2 = duel(['Dark Magician Girl', 'Silent Doom']);
  toGy(e2, 0, 'Dark Magician Girl');
  check(!e2.canActivateMain(0, grab(e2, 0, 'Silent Doom').uid), 'Silent Doom: only Normal Monsters');
}

card('Skill Successor');
{
  const e = duel(['Skill Successor']);
  const m = place(e, 0, FILL);
  playTrap(e, 0, 'Skill Successor');
  check(atk(e, m) === 1800, 'Skill Successor: +400 ATK');
  const c = e.player(0).gy.find((x) => x.name === 'Skill Successor')!;
  check(!e.canUseGraveEffect(0, c.uid), 'Skill Successor: not the turn it was sent to the GY');
  endTurn(e);
  check(atk(e, m) === 1400 && !e.canUseGraveEffect(1, c.uid), 'Skill Successor: the boost ends with the turn');
  endTurn(e);
  graveEffect(e, 0, c);
  check(atk(e, m) === 2200 && zone(e, c) === 'removed', 'Skill Successor: banished from the GY during your turn, +800 ATK');
  const e2 = duel(['Skill Successor']);
  place(e2, 1, FILL);
  check(!e2.canActivateMain(0, putST(e2, 0, 'Skill Successor').uid), 'Skill Successor: only a monster you control');
}

card('Skyscraper');
{
  const e = turn2(['Skyscraper', 'Elemental HERO Sparkman'], ['Gaia The Fierce Knight']);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  playSpell(e, 0, 'Skyscraper');
  const s = place(e, 0, 'Elemental HERO Sparkman');
  check(atk(e, s) === 1600, 'Skyscraper: no bonus outside battle');
  toBattle(e);
  attack(e, s, g);
  check(zone(e, g) === 'gy' && !!e.fieldCard(s!.uid) && lp(e, 1) === 3700, 'Skyscraper: an "Elemental HERO" attacking a stronger monster gains 1000 ATK');
  const e2 = turn2(['Skyscraper', 'Elemental HERO Sparkman'], ['Mystical Elf']);
  const w = place(e2, 1, 'Mystical Elf', 'atk');
  playSpell(e2, 0, 'Skyscraper');
  const s2 = place(e2, 0, 'Elemental HERO Sparkman');
  toBattle(e2);
  attack(e2, s2, w);
  check(lp(e2, 1) === 4000 - (1600 - 800), 'Skyscraper: not against a weaker monster');
}

card('Skyscraper 2 - Hero City');
{
  const e = turn2(['Elemental HERO Sparkman', 'Skyscraper 2 - Hero City', 'Elemental HERO Avian'], ['Gaia The Fierce Knight']);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  const s = place(e, 0, 'Elemental HERO Sparkman');
  toGy(e, 0, 'Elemental HERO Avian');
  toBattle(e);
  attack(e, s, g);
  endTurn(e);
  endTurn(e);
  const hc = playSpell(e, 0, 'Skyscraper 2 - Hero City');
  effect(e, 0, hc, { pick: ['Elemental HERO Sparkman'] });
  check(!!e.fieldCard(s!.uid) && gyHas(e, 0, 'Elemental HERO Avian'), 'Hero City: revives an "Elemental HERO" destroyed by battle (not one sent otherwise)');
  check(!e.canUseMonsterEffect(0, hc!), 'Hero City: once per turn');
}

card("Snake Deity's Command");
{
  const e = duel(['Venom Test Serpent', "Snake Deity's Command"], ['Shield Crush'], [], [], 1);
  const m = place(e, 0, FILL, 'def');
  grab(e, 0, 'Venom Test Serpent');
  putST(e, 0, "Snake Deity's Command");
  playSpell(e, 1, 'Shield Crush', { respond: "Snake Deity's Command" });
  check(!!e.fieldCard(m!.uid) && gyHas(e, 1, 'Shield Crush') && gyHas(e, 0, "Snake Deity's Command"), "Snake Deity's Command: show a \"Venom\" monster, negate the opponent's Spell");
  const e2 = duel(["Snake Deity's Command"], ['Shield Crush'], [], [], 1);
  place(e2, 0, FILL, 'def');
  putST(e2, 0, "Snake Deity's Command");
  act(e2, 1, grab(e2, 1, 'Shield Crush').uid);
  check(!gyHas(e2, 0, "Snake Deity's Command"), "Snake Deity's Command: not without a \"Venom\" monster in hand");
}

card('Snake Rain');
{
  const e = duel(['Gagagigo', 'Gagagigo', 'Gagagigo', 'Gagagigo', 'Snake Rain']);
  const h = e.player(0).hand.length;
  playSpell(e, 0, 'Snake Rain');
  check(e.player(0).gy.filter((c) => c.name === 'Gagagigo').length === 4 && e.player(0).hand.length === h - 1, 'Snake Rain: discard 1, send 4 Reptiles from the Deck to the GY');
}

card('Solemn Wishes');
{
  const e = duel(['Solemn Wishes']);
  playTrap(e, 0, 'Solemn Wishes');
  e.draw(0, 2);
  check(lp(e, 0) === 4500, 'Solemn Wishes: 500 LP each time you draw (2 cards at once count once)');
  endTurn(e);
  check(lp(e, 0) === 4500, "Solemn Wishes: not for the opponent's draw");
  endTurn(e);
  check(lp(e, 0) === 5000, 'Solemn Wishes: 500 LP for the normal draw');
}

card('Solitary Sword of Poison');
{
  const e = turn2(['Solitary Sword of Poison'], ['Gaia The Fierce Knight']);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  const m = place(e, 0, FILL);
  const sw = playSpell(e, 0, 'Solitary Sword of Poison');
  check(!!sw && m!.equips.includes(sw.uid) && atk(e, m) === 1400, 'Solitary Sword of Poison: equipped; no change outside battle');
  toBattle(e);
  attack(e, m, g);
  check(zone(e, g) === 'gy' && lp(e, 1) === 4000 - 500, 'Solitary Sword of Poison: original ATK doubled in battle with an opponent monster');
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  settle(e);
  place(e, 0, FILL);
  check(zone(e, sw) === 'gy', 'Solitary Sword of Poison: sent to the GY once you control another monster');
}

card('Soul Demolition');
{
  const e = duel(['Soul Demolition', 'Archfiend Soldier', 'Gaia The Fierce Knight']);
  const s = playTrap(e, 0, 'Soul Demolition');
  toGy(e, 0, 'Gaia The Fierce Knight');
  toGy(e, 1, FILL);
  check(!e.canUseMonsterEffect(0, s!), 'Soul Demolition: needs a Fiend monster');
  place(e, 0, 'Archfiend Soldier');
  effect(e, 0, s);
  check(lp(e, 0) === 3500 && e.player(0).removed.length === 1 && e.player(1).removed.length === 1, "Soul Demolition: pay 500 LP; each player banishes 1 monster from their opponent's GY");
}

card('Spacetime Transcendence');
{
  const e = turn2(['Tomozaurus', 'Tomozaurus', 'Uraby', 'Spacetime Transcendence']);
  toGy(e, 0, 'Tomozaurus');
  toGy(e, 0, 'Tomozaurus');
  grab(e, 0, 'Uraby');
  playSpell(e, 0, 'Spacetime Transcendence');
  const u = onField(e, 0, 'Uraby');
  toBattle(e);
  check(!!u && e.player(0).removed.length === 2 && !e.canAttackWith(0, u), 'Spacetime Transcendence: banish Dinosaurs (2+2) to Summon a Level 4 Dinosaur; it cannot attack this turn');
}

card('Spark Blaster');
{
  const e = duel(['Elemental HERO Sparkman', 'Spark Blaster'], ['Gaia The Fierce Knight']);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  check(!e.canActivateMain(0, grab(e, 0, 'Spark Blaster').uid), 'Spark Blaster: only to Elemental HERO Sparkman');
  place(e, 0, 'Elemental HERO Sparkman');
  const sb = playSpell(e, 0, 'Spark Blaster');
  effect(e, 0, sb, { pick: ['Gaia The Fierce Knight'] });
  check(g!.pos === 'def', 'Spark Blaster: changes the battle position of a monster');
  effect(e, 0, sb, { pick: ['Gaia The Fierce Knight'] });
  effect(e, 0, sb, { pick: ['Gaia The Fierce Knight'] });
  check(zone(e, sb) === 'gy', 'Spark Blaster: destroyed after 3 uses');
}

card('Spell Power Grasp');
{
  const e = duel(['Skilled Dark Magician', 'Spell Power Grasp', 'Spell Power Grasp']);
  const m = place(e, 0, 'Skilled Dark Magician');
  playSpell(e, 0, 'Spell Power Grasp', 'yes');
  check(m!.counters === 2 && handHas(e, 0, 'Spell Power Grasp'), 'Spell Power Grasp: a Spell Counter on the target, then another copy from the Deck');
  check(!e.canActivateMain(0, e.player(0).hand.find((c) => c.name === 'Spell Power Grasp')!.uid), 'Spell Power Grasp: only 1 per turn');
}

card('Spell Purification');
{
  const e = duel(['Spell Purification'], ['Shard of Greed', 'Shard of Greed']);
  const s = putActive(e, 1, 'Shard of Greed');
  const down = putST(e, 1, 'Shard of Greed');
  const h = e.player(0).hand.length;
  playTrap(e, 0, 'Spell Purification');
  check(zone(e, s) === 'gy' && zone(e, down) === 'sz' && e.player(0).hand.length === h - 1, 'Spell Purification: discard 1, destroy all face-up Continuous Spells (not Set ones)');
}

card('Spell Shattering Arrow');
{
  const e = duel(['Spell Shattering Arrow'], ['Shard of Greed', 'Shard of Greed', 'Shield Spear']);
  putActive(e, 1, 'Shard of Greed');
  putActive(e, 1, 'Shard of Greed');
  const t = putActive(e, 1, 'Shield Spear');
  playSpell(e, 0, 'Spell Shattering Arrow');
  check(e.player(1).gy.filter((c) => c.name === 'Shard of Greed').length === 2 && zone(e, t) === 'sz' && lp(e, 1) === 3000, "Spell Shattering Arrow: destroys the opponent's face-up Spells only, 500 damage each");
}

card('Spider Egg');
{
  const e = duel(['Basic Insect', 'Basic Insect', 'Basic Insect', 'Spider Egg'], ['Gaia The Fierce Knight']);
  for (let i = 0; i < 3; i++) toGy(e, 0, 'Basic Insect');
  putST(e, 0, 'Spider Egg');
  endTurn(e);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  toBattle(e);
  attack(e, g, null, { respond: 'Spider Egg' });
  const toks = e.monsters(0).filter((m) => m.name === 'Spider Token');
  check(lp(e, 0) === 4000 && toks.length === 3 && toks.every((t) => t.pos === 'atk' && e.atkOf(t) === 100), 'Spider Egg: negates the direct attack, 3 Spider Tokens (100 ATK) in Attack Position');
  const e2 = duel(['Basic Insect', 'Basic Insect', 'Spider Egg'], ['Gaia The Fierce Knight']);
  for (let i = 0; i < 2; i++) toGy(e2, 0, 'Basic Insect');
  putST(e2, 0, 'Spider Egg');
  endTurn(e2);
  const g2 = place(e2, 1, 'Gaia The Fierce Knight');
  toBattle(e2);
  attack(e2, g2, null, { respond: 'Spider Egg' });
  check(lp(e2, 0) === 4000 - 2300, 'Spider Egg: needs 3 Insects in your GY');
}

card('Spiritual Forest');
{
  const e = duel(['Spiritual Forest', 'Dark Rabbit'], ['Gaia The Fierce Knight', 'Blue-Eyes White Dragon']);
  playSpell(e, 0, 'Spiritual Forest');
  const r = place(e, 0, 'Dark Rabbit');
  endTurn(e);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  const b = place(e, 1, 'Blue-Eyes White Dragon');
  toBattle(e);
  attack(e, g, r);
  check(!!e.fieldCard(r!.uid), 'Spiritual Forest: the first Beast that would be destroyed by battle each turn is not');
  attack(e, b, r);
  check(zone(e, r) === 'gy', 'Spiritual Forest: only the first one each turn');
  const e2 = duel(['Spiritual Forest'], ['Gaia The Fierce Knight']);
  playSpell(e2, 0, 'Spiritual Forest');
  const w = place(e2, 0, FILL);
  endTurn(e2);
  const g2 = place(e2, 1, 'Gaia The Fierce Knight');
  toBattle(e2);
  attack(e2, g2, w);
  check(zone(e2, w) === 'gy', 'Spiritual Forest: not a Warrior');
}

card('Stamping Destruction');
{
  const e = duel(['Baby Dragon', 'Stamping Destruction'], ['Shield Spear']);
  const t = putST(e, 1, 'Shield Spear');
  check(!e.canActivateMain(0, grab(e, 0, 'Stamping Destruction').uid), 'Stamping Destruction: needs a Dragon');
  place(e, 0, 'Baby Dragon');
  playSpell(e, 0, 'Stamping Destruction');
  check(zone(e, t) === 'gy' && lp(e, 1) === 3500, 'Stamping Destruction: destroys a Spell/Trap, 500 damage to its controller');
}

card('Statue of the Wicked');
{
  const e = duel(['Statue of the Wicked']);
  const s = putST(e, 0, 'Statue of the Wicked');
  kill(e, [s], 1);
  const t = onField(e, 0, 'Wicked Token');
  check(!!t && e.atkOf(t) === 1000, 'Statue of the Wicked: destroyed face-down, a Wicked Token (1000 ATK)');
}

card('Storm');
{
  const e = duel(['Shield Spear', 'Shield Spear', 'Storm'], ['Shield Spear', 'Shield Spear', 'Shield Spear']);
  putST(e, 0, 'Shield Spear');
  putST(e, 0, 'Shield Spear');
  for (let i = 0; i < 3; i++) putST(e, 1, 'Shield Spear');
  e.player(0).sz[2] = null;
  const st = grab(e, 0, 'Storm');
  e.apply({ type: 'ACTIVATE', player: 0, uid: st.uid, zone: 2 });
  settle(e);
  check(e.spells(0).length === 0 && e.spells(1).length === 1, "Storm: destroys your Spells/Traps (2), then as many of the opponent's");
  const e2 = duel(['Storm']);
  check(!e2.canActivateMain(0, grab(e2, 0, 'Storm').uid), 'Storm: needs another of your Spells/Traps');
}

card('Straight Flush');
{
  const e = duel(['Straight Flush'], ['Shield Spear', 'Shield Spear', 'Shield Spear']);
  const sf = putST(e, 0, 'Straight Flush');
  putST(e, 1, 'Shield Spear');
  putST(e, 1, 'Shield Spear');
  check(!e.canActivateMain(0, sf.uid), 'Straight Flush: needs all their Spell & Trap Zones occupied');
  putST(e, 1, 'Shield Spear');
  act(e, 0, sf.uid);
  check(e.spells(1).length === 0, "Straight Flush: destroys all cards in the opponent's Spell & Trap Zones");
}

card('Stray Lambs', true);
{
  const e = duel(['Stray Lambs']);
  const down = place(e, 0, FILL, 'def', false);
  playSpell(e, 0, 'Stray Lambs');
  const fill = e.player(0).hand.find((c) => c.name === FILL)!;
  check(e.monsters(0).filter((m) => m.name === 'Lamb Token' && m.pos === 'def').length === 2, 'Stray Lambs: 2 Lamb Tokens in Defense Position');
  check(e.summonBlocked(0, fill, 'normal', 'hand') && e.summonBlocked(0, fill, 'special', 'hand') && !e.summonBlocked(0, fill, 'set', 'hand'), 'Stray Lambs: no Normal or Special Summons this turn, Sets allowed');
  check(e.summonBlocked(0, down!, 'flip', 'mz'), 'Stray Lambs: no Flip Summons this turn either');
  endTurn(e);
  endTurn(e);
  check(!e.summonBlocked(0, fill, 'normal', 'hand'), 'Stray Lambs: only that turn');
}

card('Summon Cloud');
{
  const e = duel(['Summon Cloud', 'Cloudian - Smoke Ball', 'Cloudian - Smoke Ball']);
  const sc = playSpell(e, 0, 'Summon Cloud');
  grab(e, 0, 'Cloudian - Smoke Ball');
  effect(e, 0, sc);
  check(!!onField(e, 0, 'Cloudian - Smoke Ball') && active(e, sc), 'Summon Cloud: Special Summons a "Cloudian" from the hand; the card stays');
  check(!e.canUseMonsterEffect(0, sc!), 'Summon Cloud: not while you control a monster');
  const e2 = duel(['Summon Cloud'], ['Cloudian - Smoke Ball']);
  const sc2 = playSpell(e2, 0, 'Summon Cloud');
  toGy(e2, 1, 'Cloudian - Smoke Ball');
  effect(e2, 0, sc2);
  check(e2.monsters(0).some((m) => m.name === 'Cloudian - Smoke Ball') && zone(e2, sc2) === 'gy', "Summon Cloud: from the opponent's GY, then it is destroyed");
}

card("Summoner's Art");
{
  const e = duel(['Gaia The Fierce Knight', 'Cycroid', "Summoner's Art"]);
  playSpell(e, 0, "Summoner's Art");
  check(handHas(e, 0, 'Gaia The Fierce Knight'), "Summoner's Art: adds a Level 5+ Normal Monster");
  const e2 = duel(['Cycroid', "Summoner's Art"]);
  check(!e2.canActivateMain(0, grab(e2, 0, "Summoner's Art").uid), "Summoner's Art: not a Level 4 or lower one");
}

card('Super Polymerization', true);
{
  const e = duel(['Steamroid', 'Drillroid', 'Super Polymerization', 'Shield Spear'], ['Submarineroid', 'Shield Spear'], ['Super Vehicroid Jumbo Drill']);
  place(e, 0, 'Steamroid');
  place(e, 0, 'Drillroid');
  const sub = place(e, 1, 'Submarineroid');
  putST(e, 1, 'Shield Spear');
  const sp = grab(e, 0, 'Super Polymerization');
  const h = e.player(0).hand.length;
  e.apply({ type: 'ACTIVATE', player: 0, uid: sp.uid, zone: e.player(0).sz.findIndex((z) => z === null) });
  let responded = false;
  for (let i = 0; i < 40 && e.state.prompt; i++) {
    if (e.state.prompt.kind === 'response') responded = true;
    settle(e, 'pass');
  }
  const j = onField(e, 0, 'Super Vehicroid Jumbo Drill');
  check(!!j && j.tags?.fusS === 1 && zone(e, sub) === 'gy' && e.player(0).hand.length === h - 2, "Super Polymerization: discard 1, Fusion Summon with a monster from the opponent's field");
  check(!responded, 'Super Polymerization: no responses to its activation');
  const e2 = duel(['Steamroid', 'Super Polymerization', 'Shield Spear'], ['Drillroid', 'Submarineroid'], ['Super Vehicroid Jumbo Drill']);
  place(e2, 0, 'Steamroid');
  place(e2, 1, 'Drillroid', 'def', false);
  place(e2, 1, 'Submarineroid');
  playSpell(e2, 0, 'Super Polymerization');
  check(!!onField(e2, 0, 'Super Vehicroid Jumbo Drill'), "Super Polymerization: face-down monsters on the opponent's field can be used too");
  const e3 = duel(['Beastking of the Swamps', 'Super Polymerization', 'Shield Spear'], ['Flame Manipulator'], ['Flame Swordsman']);
  place(e3, 0, 'Beastking of the Swamps');
  place(e3, 1, 'Flame Manipulator');
  playSpell(e3, 0, 'Super Polymerization');
  check(!!onField(e3, 0, 'Flame Swordsman'), 'Super Polymerization: a Fusion substitute monster can stand in for a material');
}

card('Super Rush Recklessly');
{
  const e = duel(['Dark Rabbit', 'Super Rush Recklessly'], ['Gaia The Fierce Knight']);
  const r = place(e, 0, 'Dark Rabbit');
  const g = place(e, 1, 'Gaia The Fierce Knight');
  playTrap(e, 0, 'Super Rush Recklessly');
  check(zone(e, r) === 'gy' && zone(e, g) === 'deck', "Super Rush Recklessly: destroy your Beast, then shuffle the opponent's monster into the Deck");
}

card('Supercharge');
{
  const e = duel(['Cycroid', 'Supercharge'], ['Gaia The Fierce Knight']);
  const c = place(e, 0, 'Cycroid');
  putST(e, 0, 'Supercharge');
  endTurn(e);
  const g = place(e, 1, 'Gaia The Fierce Knight');
  const h = e.player(0).hand.length;
  toBattle(e);
  attack(e, g, c, { respond: 'Supercharge' });
  check(e.player(0).hand.length === h + 2, 'Supercharge: only "roid" Machines and the opponent attacks, draw 2');
  const e2 = duel(['Cycroid', 'Supercharge'], ['Gaia The Fierce Knight']);
  const c2 = place(e2, 0, 'Cycroid');
  place(e2, 0, FILL);
  putST(e2, 0, 'Supercharge');
  endTurn(e2);
  const g2 = place(e2, 1, 'Gaia The Fierce Knight');
  const h2 = e2.player(0).hand.length;
  toBattle(e2);
  attack(e2, g2, c2, { respond: 'Supercharge' });
  check(e2.player(0).hand.length === h2, 'Supercharge: not while you control a non-"roid" monster');
}

card('Surface');
{
  const e = duel(['Slushy', 'Surface']);
  toGy(e, 0, 'Slushy');
  playSpell(e, 0, 'Surface');
  const s = onField(e, 0, 'Slushy');
  check(!!s && s.pos === 'def' && s.faceUp, 'Surface: a Level 3 or lower Aqua back in face-up Defense Position');
  const e2 = duel(['Gagagigo', 'Surface']);
  toGy(e2, 0, 'Gagagigo');
  check(!e2.canActivateMain(0, grab(e2, 0, 'Surface').uid), 'Surface: not a Level 4 Reptile');
}

card('Swing of Memories');
{
  const e = duel(['Gaia The Fierce Knight', 'Swing of Memories']);
  toGy(e, 0, 'Gaia The Fierce Knight');
  playSpell(e, 0, 'Swing of Memories');
  const g = onField(e, 0, 'Gaia The Fierce Knight');
  check(!!g, 'Swing of Memories: revives a Normal Monster');
  endTurn(e);
  check(zone(e, g) === 'gy', 'Swing of Memories: destroyed in the End Phase');
}

card('Tail Swipe');
{
  const e = duel(['Megazowler', 'Tail Swipe'], ['Gaia The Fierce Knight']);
  place(e, 0, 'Megazowler');
  const a = place(e, 1, FILL);
  const b = place(e, 1, 'Gaia The Fierce Knight');
  const c = place(e, 1, FILL, 'def', false);
  playSpell(e, 0, 'Tail Swipe', { pick: ['Megazowler'] }, { pick: [FILL, 'Face-down card'] });
  check(zone(e, a) === 'hand' && zone(e, c) === 'hand' && zone(e, b) === 'mz', 'Tail Swipe: returns up to 2 lower-Level or face-down opponent monsters to the hand');
  const e2 = duel(['Tomozaurus', 'Tail Swipe'], ['Gaia The Fierce Knight']);
  place(e2, 0, 'Tomozaurus');
  place(e2, 1, FILL);
  check(!e2.canActivateMain(0, grab(e2, 0, 'Tail Swipe').uid), 'Tail Swipe: needs a Level 5 or higher Dinosaur');
}

const fixedNow = [...FIXED].length;
console.log(`\nF: ${CARDS.size} cards checked, ${fixedNow} fixed`);
console.log(fails ? `\n${fails} FAILED` : "\nALL OK");
process.exit(fails ? 1 : 0);
