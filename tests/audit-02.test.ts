// Speed Duel card scripts of batches 02 and 11 (run: npx tsx tests/audit-02.test.ts)
// One targeted check per scripted card: its main effect really happens in a duel (and, where cheap, that it does not
// happen when it should not).
import { Engine } from '../src/eds/engine';
import type { Card, CardInfo, FieldCard, Pid, Pos } from '../src/eds/types';
import { attrOf, levelOf, negateLink, raceOf } from '../src/eds/speed/helpers';
import { DB } from './speedkit';

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};
const FILL = 'Celtic Guardian';

// ---------- duel kit (from tests/batch-20.test.ts) ----------
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
/** A duel whose current turn (player `first`) may already conduct a Battle Phase. */
function fight(d0: string[], d1: string[] = [], first: Pid = 0, x0: string[] = [], x1: string[] = []): Engine {
  const e = duel(d0, d1, x0, x1, first);
  e.state.firstTurn = false;
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
/** Sends a card of `p` (deck or hand) to the GY. */
function toGy(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.sendToGrave(c.uid, 'cost'));
  return c;
}
/** Banishes a card of `p` from the deck or hand. */
function toBanished(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  e.banish(c.uid);
  return c;
}
/** Special Summons a card of `p` from wherever it is (Extra Deck included). Null when it did not arrive. */
function place(e: Engine, p: Pid, name: string, pos: Pos = 'atk', faceUp = true, ...ans: Ans[]): FieldCard | null {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.gy, ...ps.fusion, ...ps.hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.specialSummon(c.uid, p, pos, faceUp), ...ans);
  const f = e.fieldCard(c.uid);
  if (f) f.placedTurn = -1;
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
const quickNow = (e: Engine, p: Pid, c: Card | null, ...ans: Ans[]) => {
  e.apply({ type: 'QUICK_EFFECT', player: p, uid: c!.uid });
  return settle(e, ...ans);
};
const special = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'SPECIAL', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const graveFx = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'GRAVE_EFFECT', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const active = (e: Engine, c: FieldCard | null) => !!c && zone(e, c) === 'sz' && c.faceUp && !!c.active;
const inHand = (e: Engine, p: Pid, name: string) => e.player(p).hand.some((c) => c.name === name);
const inGy = (e: Engine, p: Pid, name: string) => e.player(p).gy.some((c) => c.name === name);
const onField = (e: Engine, p: Pid, name: string) => e.monsters(p).find((m) => m.name === name) ?? null;
const lp = (e: Engine, p: Pid) => e.player(p).lp;
const atk = (e: Engine, c: FieldCard | null) => (c ? e.atkOf(c) : -1);
const def = (e: Engine, c: FieldCard | null) => (c ? e.defOf(c) : -1);
const section = (s: string) => console.log(`\n--- ${s}`);

// Cards this game's pool lacks: test-only stand-ins added to the card database.
const fake = (info: Partial<CardInfo> & { name: string }) => {
  const full = { id: 980000 + DB.size, kind: 'monster', sub: 'Normal', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
fake({ name: 'Test Snow Bird', level: 4, atk: 1500, def: 1000, race: 'Winged Beast', attribute: 'WATER' });
fake({ name: 'Bujin Test Yamato', level: 4, atk: 1800, def: 200, race: 'Beast-Warrior', attribute: 'LIGHT' });
fake({ name: 'Bujin Test Hirume', level: 4, atk: 2000, def: 1000, race: 'Beast-Warrior', attribute: 'LIGHT' });
fake({ name: 'Test Mystical Spirit of the Forest', level: 4, atk: 1500, def: 1000, race: 'Beast', attribute: 'EARTH' });
fake({ name: 'Eldlixir of Test', kind: 'trap', sub: 'Normal' });
fake({ name: 'Eldlich the Golden Lord', sub: 'Effect', level: 10, atk: 2500, def: 2800, race: 'Zombie', attribute: 'LIGHT' });
fake({ name: 'Test Divine Beast', level: 10, atk: 0, def: 0, race: 'Divine-Beast', attribute: 'DIVINE' });
fake({ name: 'Fallen of Albaz', level: 4, atk: 1800, def: 0, race: 'Dragon', attribute: 'DARK' });
fake({ name: 'Constellar Test Star', level: 4, atk: 1500, def: 1000, race: 'Beast', attribute: 'LIGHT' });
fake({ name: 'Test Zero Beast', level: 4, atk: 0, def: 0, race: 'Beast', attribute: 'EARTH' });

/** Moves `n` copies of a card of `p` into the hand. */
function grabN(e: Engine, p: Pid, name: string, n: number): Card[] {
  const ps = e.player(p);
  const out = ps.hand.filter((c) => c.name === name).slice(0, n);
  for (const c of [...ps.deck, ...ps.gy, ...ps.removed]) {
    if (out.length >= n) break;
    if (c.name === name) (e.toHandOf(c.uid, p), out.push(c));
  }
  return out;
}
/** Empties a hand down to `keep` cards (the rest go to the bottom of the Deck). */
function trimHand(e: Engine, p: Pid, keep: number) {
  const ps = e.player(p);
  while (ps.hand.length > keep) ps.deck.push(ps.hand.shift()!);
}
const logHas = (e: Engine, text: string) => e.state.log.some((l) => l.text.includes(text));

// ======================= batch 02 =======================
section('Big One Warrior');
{
  const e = duel(['Big One Warrior', 'Petit Moth']);
  const b = grab(e, 0, 'Big One Warrior');
  grab(e, 0, 'Petit Moth');
  special(e, 0, b, { pick: ['Petit Moth'] });
  check(zone(e, b) === 'mz' && inGy(e, 0, 'Petit Moth'), 'Big One Warrior: sends a Level 1 monster from the hand to Special Summon itself');
}

section('Big Wave Small Wave');
{
  const e = duel(['Amazon of the Seas', 'Amazon of the Seas', '7 Colored Fish', '7 Colored Fish', 'Big Wave Small Wave']);
  const a = place(e, 0, 'Amazon of the Seas');
  const b = place(e, 0, 'Amazon of the Seas');
  grabN(e, 0, '7 Colored Fish', 2);
  playSpell(e, 0, 'Big Wave Small Wave', 'yes', { pick: ['7 Colored Fish', '7 Colored Fish'] });
  check(zone(e, a) === 'gy' && zone(e, b) === 'gy' && e.monsters(0).filter((m) => m.name === '7 Colored Fish').length === 2, 'Big Wave Small Wave: destroys 2 WATER monsters, then Special Summons 2 WATER monsters from the hand');
}

section('Big-Tusked Mammoth');
{
  const e = duel(['Big-Tusked Mammoth'], ['Axe Raider', 'Vorse Raider']);
  const m = place(e, 0, 'Big-Tusked Mammoth');
  const old = place(e, 1, 'Vorse Raider');
  endTurn(e);
  const axe = summon(e, 1, 'Axe Raider');
  toBattle(e);
  check(!!axe && !e.canAttackWith(1, axe) && e.canAttackWith(1, old!), "Big-Tusked Mammoth: the opponent's monster Summoned this turn cannot attack, an older one can");
  kill(e, [m]);
  check(e.canAttackWith(1, axe!), 'Big-Tusked Mammoth: once it leaves the field the monster can attack');
}

section('Birdface');
{
  const e = fight(['Birdface', 'Harpie Lady 1'], ['Blue-Eyes White Dragon'], 1);
  const bf = place(e, 0, 'Birdface');
  const bewd = place(e, 1, 'Blue-Eyes White Dragon');
  toBattle(e);
  attack(e, bewd, bf, 'yes');
  check(zone(e, bf) === 'gy' && inHand(e, 0, 'Harpie Lady 1'), 'Birdface: destroyed by battle, adds a "Harpie Lady" from the Deck');
}

section('Birthright');
{
  const e = duel(['Birthright', 'Amazon of the Seas']);
  toGy(e, 0, 'Amazon of the Seas');
  const br = playTrap(e, 0, 'Birthright');
  const m = onField(e, 0, 'Amazon of the Seas');
  check(!!m && m.pos === 'atk' && active(e, br), 'Birthright: Special Summons a Normal Monster from the GY in Attack Position');
  kill(e, [br]);
  check(zone(e, m) === 'gy', 'Birthright: when it leaves the field, the monster is destroyed');
}

section('Bitelon');
{
  const e = fight(['Bitelon']);
  const b = place(e, 0, 'Bitelon');
  const d = place(e, 1, FILL, 'def');
  toBattle(e);
  attack(e, b, d);
  check(zone(e, d) === 'gy' && lp(e, 1) === 4000 - (2400 - 1200), 'Bitelon: piercing battle damage');
}

section('Black Brachios');
{
  const e = duel(['Black Brachios']);
  const fd = place(e, 1, FILL, 'def', false);
  summon(e, 0, 'Black Brachios', true, { pick: ['Face-down card'] });
  check(!!fd && fd.faceUp && fd.pos === 'def', 'Black Brachios: Normal Summoned, changes a monster to face-up Defense Position');
}

section('Black Dragon Ninja');
{
  const e = duel(['Black Dragon Ninja', 'Strike Ninja', 'Ninjitsu Art of Super-Transformation'], ['Vorse Raider']);
  check(!place(e, 0, 'Black Dragon Ninja'), 'Black Dragon Ninja: cannot be Special Summoned by a non-"Ninja" effect');
  const c = e.player(0).deck.find((x) => x.name === 'Black Dragon Ninja')!;
  e.state.fx.ignoreCond = c.uid;
  const n = place(e, 0, 'Black Dragon Ninja');
  e.state.fx.ignoreCond = undefined;
  grab(e, 0, 'Strike Ninja');
  grab(e, 0, 'Ninjitsu Art of Super-Transformation');
  const v = place(e, 1, 'Vorse Raider');
  quickNow(e, 0, n, { pick: ['Strike Ninja'] }, { pick: ['Ninjitsu Art of Super-Transformation'] }, { pick: ['Vorse Raider'] });
  check(zone(e, v) === 'removed' && inGy(e, 0, 'Strike Ninja') && inGy(e, 0, 'Ninjitsu Art of Super-Transformation'), 'Black Dragon Ninja: sends a "Ninja" and a "Ninjitsu Art" to the GY to banish a monster');
  kill(e, [n]);
  check(zone(e, v) === 'mz' && e.controller(v!.uid) === 1, 'Black Dragon Ninja: when it leaves the field, the banished monster returns to its owner');
}

section("Black Dragon's Chick");
{
  const e = duel(["Black Dragon's Chick", 'Red-Eyes Black Dragon']);
  const ch = place(e, 0, "Black Dragon's Chick");
  grab(e, 0, 'Red-Eyes Black Dragon');
  effect(e, 0, ch);
  check(zone(e, ch) === 'gy' && !!onField(e, 0, 'Red-Eyes Black Dragon'), 'Black Dragon\'s Chick: sends itself to the GY to Special Summon "Red-Eyes B. Dragon" from the hand');
}

section('Black Metal Dragon');
{
  const e = duel(['Black Metal Dragon', 'Red-Eyes Black Dragon', 'Red-Eyes Baby Dragon']);
  const r = place(e, 0, 'Red-Eyes Black Dragon');
  const b = grab(e, 0, 'Black Metal Dragon');
  effect(e, 0, b);
  check(zone(e, b) === 'sz' && atk(e, r) === 3000, 'Black Metal Dragon: equips itself from the hand to a "Red-Eyes" monster, +600 ATK');
  kill(e, [r], 1, 'yes');
  check(zone(e, b) === 'gy' && inHand(e, 0, 'Red-Eyes Baby Dragon'), 'Black Metal Dragon: sent from the field to the GY, adds a "Red-Eyes" card');
}

section('Black Ptera');
{
  const e = fight(['Black Ptera'], ['Vorse Raider'], 1);
  const pt = place(e, 0, 'Black Ptera');
  kill(e, [pt], 1);
  check(zone(e, pt) === 'hand', 'Black Ptera: destroyed by a card effect, returns to the hand');
  const pt2 = place(e, 0, 'Black Ptera');
  const v = place(e, 1, 'Vorse Raider');
  toBattle(e);
  attack(e, v, pt2);
  check(zone(e, pt) === 'gy', 'Black Ptera: not when destroyed by battle');
}

section('Black Sonic');
{
  const e = fight(['Black Sonic', 'Blackwing - Calima the Haze'], ['Vorse Raider', 'Axe Raider'], 1);
  const bw = place(e, 0, 'Blackwing - Calima the Haze');
  const v = place(e, 1, 'Vorse Raider');
  const a = place(e, 1, 'Axe Raider', 'def');
  putST(e, 0, 'Black Sonic');
  toBattle(e);
  attack(e, v, bw, { respond: 'Black Sonic' });
  check(zone(e, v) === 'removed' && zone(e, a) === 'mz', 'Black Sonic: an attack on a "Blackwing" banishes the face-up Attack Position monsters of the opponent');
}

section('Black Stego');
{
  const e = fight(['Black Stego'], ['Axe Raider'], 1);
  const s = place(e, 0, 'Black Stego');
  const a = place(e, 1, 'Axe Raider');
  toBattle(e);
  attack(e, a, s);
  check(!!s && s.pos === 'def' && zone(e, s) === 'mz' && lp(e, 1) === 4000 - 300, 'Black Stego: targeted for an attack, changes to Defense Position');
}

section('Black Tyranno');
{
  const e = duel(['Black Tyranno'], ['Vorse Raider', 'Axe Raider']);
  const t = place(e, 0, 'Black Tyranno')!;
  place(e, 1, 'Axe Raider', 'def');
  const yes = e.canAttackDirectly(t);
  place(e, 1, 'Vorse Raider');
  check(yes && !e.canAttackDirectly(t), 'Black Tyranno: attacks directly while the opponent only has Defense Position monsters');
}

section('Black Veloci');
{
  const e = fight(['Black Veloci'], ['Luster Dragon']);
  const v = place(e, 0, 'Black Veloci');
  const l = place(e, 1, 'Luster Dragon');
  toBattle(e);
  attack(e, v, l);
  check(zone(e, l) === 'gy' && lp(e, 1) === 4000 - 300, 'Black Veloci: +400 ATK when it attacks (2200 vs 1900)');
  const e2 = fight(['Black Veloci'], ['Axe Raider'], 1);
  const v2 = place(e2, 0, 'Black Veloci');
  const a2 = place(e2, 1, 'Axe Raider');
  toBattle(e2);
  attack(e2, a2, v2);
  check(zone(e2, v2) === 'gy' && lp(e2, 0) === 4000 - 300, 'Black Veloci: -400 ATK when attacked (1400 vs 1700)');
}

section('Blade Bounzer');
{
  const e = fight(['Blade Bounzer'], ['Axe Raider', 'Mammoth Graveyard']);
  const b = place(e, 0, 'Blade Bounzer');
  const a1 = place(e, 1, 'Mammoth Graveyard');
  const a2 = place(e, 1, 'Axe Raider');
  const hand = e.player(0).hand.length;
  toBattle(e);
  attack(e, b, a1, 'yes');
  check(zone(e, a1) === 'gy' && e.player(0).hand.length === hand - 1 && e.canAttackWith(0, b!), 'Blade Bounzer: discards 1 card to attack again');
  kill(e, [a2]);
  check(!e.canAttackWith(0, b!), 'Blade Bounzer: the second attack must be on a monster (no direct attack)');
}

section('Blade Knight');
{
  const e = fight(['Blade Knight'], ['Man-Eater Bug']);
  const k = place(e, 0, 'Blade Knight');
  const big = atk(e, k);
  trimHand(e, 0, 1);
  check(big === 1600 && atk(e, k) === 2000, 'Blade Knight: +400 ATK with 1 or fewer cards in the hand');
  const bug = place(e, 1, 'Man-Eater Bug', 'def', false);
  toBattle(e);
  attack(e, k, bug);
  check(zone(e, bug) === 'gy' && zone(e, k) === 'mz' && logHas(e, 'negates Man-Eater Bug'), 'Blade Knight: alone on the field, it negates the FLIP effect of the monster it destroys');
}

section('Blaze Accelerator');
{
  const e = duel(['Blaze Accelerator', 'Flame Viper'], ['Vorse Raider']);
  const v = place(e, 1, 'Vorse Raider');
  grab(e, 0, 'Flame Viper');
  const ba = playSpell(e, 0, 'Blaze Accelerator');
  effect(e, 0, ba);
  check(zone(e, v) === 'gy' && inGy(e, 0, 'Flame Viper'), 'Blaze Accelerator: sends a Pyro with 500 or less ATK to destroy a monster');
  const m = place(e, 0, FILL);
  e.state.firstTurn = false;
  toBattle(e);
  check(!e.canAttackWith(0, m!), 'Blaze Accelerator: no attacks the turn its effect is used');
}

section('Blizzard Thunderbird');
{
  const e = duel(['Blizzard Thunderbird', 'Test Snow Bird', 'Test Snow Bird']);
  const tb = place(e, 0, 'Blizzard Thunderbird');
  toGy(e, 0, 'Test Snow Bird');
  grab(e, 0, 'Test Snow Bird');
  effect(e, 0, tb, { pick: [FILL] });
  check(e.monsters(0).filter((m) => m.name === 'Test Snow Bird').length === 2 && zone(e, tb) === 'hand', 'Blizzard Thunderbird: Special Summons a WATER Winged Beast from the hand and one from the GY, then returns to the hand');
}

section('Block Dragon');
{
  const e = duel(['Block Dragon', 'Alpha The Magnet Warrior', 'Beta The Magnet Warrior'], ['Vorse Raider']);
  const bd = grab(e, 0, 'Block Dragon');
  special(e, 0, bd, { pick: [FILL, FILL, FILL] });
  check(zone(e, bd) === 'mz' && e.player(0).removed.length === 3, 'Block Dragon: Special Summoned by banishing 3 EARTH monsters from the hand');
  kill(e, [bd], 1);
  check(zone(e, bd) === 'mz', 'Block Dragon: Rock monsters cannot be destroyed by card effects');
  run(e, e.sendToGrave(bd.uid, 'cost'), 'yes', { pick: ['Alpha The Magnet Warrior', 'Beta The Magnet Warrior'] });
  check(inHand(e, 0, 'Alpha The Magnet Warrior') && inHand(e, 0, 'Beta The Magnet Warrior'), 'Block Dragon: sent from the field to the GY, adds Rock monsters whose Levels total 8');
}

section('Block Golem');
{
  const e = duel(['Block Golem', 'Alpha The Magnet Warrior', 'Beta The Magnet Warrior']);
  toGy(e, 0, 'Alpha The Magnet Warrior');
  toGy(e, 0, 'Beta The Magnet Warrior');
  const g = place(e, 0, 'Block Golem');
  effect(e, 0, g);
  const a = onField(e, 0, 'Alpha The Magnet Warrior');
  check(zone(e, g) === 'gy' && !!a && !!onField(e, 0, 'Beta The Magnet Warrior') && a.effectUsed, 'Block Golem: Tributes itself to Special Summon 2 Level 4 or lower Rock monsters from the GY');
}

section('Blood Sucker');
{
  const e = fight(['Blood Sucker']);
  const b = place(e, 0, 'Blood Sucker');
  toBattle(e);
  attack(e, b, null);
  check(e.player(1).gy.length === 1, "Blood Sucker: battle damage sends the top card of the opponent's Deck to the GY");
}

section('Blowback Dragon');
{
  const e = duel(['Blowback Dragon'], ['Vorse Raider']);
  const b = place(e, 0, 'Blowback Dragon');
  const v = place(e, 1, 'Vorse Raider');
  effect(e, 0, b);
  const line = e.state.log.find((l) => l.text.includes('coin tosses are Heads'));
  const heads = Number(line?.text.match(/(\d) of 3/)?.[1] ?? -1);
  check(heads >= 0 && (heads >= 2) === (zone(e, v) === 'gy'), `Blowback Dragon: 3 coin tosses (${heads} Heads), destroyed only with 2+ Heads`);
}

section('Blue Dragon Summoner');
{
  const e = duel(['Blue Dragon Summoner', 'Dark Magician']);
  const b = place(e, 0, 'Blue Dragon Summoner');
  kill(e, [b], 1, 'yes', { pick: ['Dark Magician'] });
  check(inHand(e, 0, 'Dark Magician'), 'Blue Dragon Summoner: sent to the GY, adds a Dragon/Warrior/Spellcaster Normal Monster');
}

section('Blue Flame Swordsman');
{
  const e = fight(['Blue Flame Swordsman'], ['Vorse Raider']);
  const bfs = place(e, 0, 'Blue Flame Swordsman');
  const f = place(e, 0, FILL);
  const v = place(e, 1, 'Vorse Raider');
  toBattle(e);
  attack(e, f, v, { respond: 'Blue Flame Swordsman' }, { pick: [FILL] });
  check(atk(e, bfs) === 1200 && zone(e, v) === 'gy', 'Blue Flame Swordsman: in the Battle Phase, moves 600 ATK to another Warrior');
  const e2 = duel(['Blue Flame Swordsman', 'Command Knight']);
  const b2 = place(e2, 0, 'Blue Flame Swordsman');
  toGy(e2, 0, 'Command Knight');
  kill(e2, [b2], 1, 'yes');
  check(zone(e2, b2) === 'removed' && !!onField(e2, 0, 'Command Knight'), "Blue Flame Swordsman: destroyed by the opponent's card, banishes itself to revive a FIRE Warrior");
}

section('Bonding - D2O');
{
  const e = duel(['Bonding - D2O', 'Duoterion', 'Duoterion', 'Oxygeddon', 'Water Dragon']);
  grabN(e, 0, 'Duoterion', 2);
  grab(e, 0, 'Oxygeddon');
  const b = playSpell(e, 0, 'Bonding - D2O');
  const wd = onField(e, 0, 'Water Dragon');
  check(!!wd && inGy(e, 0, 'Duoterion') && inGy(e, 0, 'Oxygeddon') && inGy(e, 0, 'Bonding - D2O'), 'Bonding - D2O: Tributes 2 Duoterion + 1 Oxygeddon from the hand to Special Summon "Water Dragon" from the Deck');
  kill(e, [wd], 1);
  check(zone(e, b) === 'hand' || inHand(e, 0, 'Bonding - D2O'), 'Bonding - D2O: returns to the hand when "Water Dragon" is sent from the field to the GY');
}

section('Bonding - H2O');
{
  const e = duel(['Bonding - H2O', 'Hydrogeddon', 'Hydrogeddon', 'Oxygeddon', 'Water Dragon']);
  place(e, 0, 'Hydrogeddon');
  place(e, 0, 'Hydrogeddon');
  place(e, 0, 'Oxygeddon');
  playSpell(e, 0, 'Bonding - H2O');
  check(!!onField(e, 0, 'Water Dragon') && e.monsters(0).length === 1, 'Bonding - H2O: Tributes 2 Hydrogeddon + 1 Oxygeddon to Special Summon "Water Dragon"');
}

section('Bonding - DHO');
{
  const e = duel(['Bonding - DHO', 'Duoterion', 'Hydrogeddon', 'Oxygeddon', 'Water Dragon Cluster', 'Water Dragon']);
  grab(e, 0, 'Duoterion');
  toGy(e, 0, 'Hydrogeddon');
  grab(e, 0, 'Oxygeddon');
  grab(e, 0, 'Water Dragon Cluster');
  playTrap(e, 0, 'Bonding - DHO');
  check(!!onField(e, 0, 'Water Dragon Cluster') && !inGy(e, 0, 'Hydrogeddon') && !inHand(e, 0, 'Duoterion'), 'Bonding - DHO: shuffles the 3 materials into the Deck to Special Summon "Water Dragon Cluster"');
  const card = e.player(0).gy.find((c) => c.name === 'Bonding - DHO')!;
  graveFx(e, 0, card, { pick: ['Water Dragon'] });
  check(zone(e, card) === 'removed' && inHand(e, 0, 'Water Dragon'), 'Bonding - DHO: banished from the GY to add "Water Dragon"');
}

section('Bonze Alone');
{
  const e = duel(['Bonze Alone']);
  const b = summon(e, 0, 'Bonze Alone');
  check(!!b, 'Bonze Alone: can be Normal Summoned while you control no monster');
  place(e, 0, FILL);
  check(zone(e, b) === 'gy', 'Bonze Alone: destroyed when another monster is Summoned to your field');
  const e2 = duel(['Bonze Alone']);
  place(e2, 0, FILL);
  const c = grab(e2, 0, 'Bonze Alone');
  check(!e2.canNormalSummon(0, c, true) && !e2.canSpecialProc(0, c), 'Bonze Alone: cannot be Summoned while you control a monster');
  trimHand(e2, 0, 0);
  const e3 = duel(['Bonze Alone']);
  special(e3, 0, grab(e3, 0, 'Bonze Alone'));
  check(!!onField(e3, 0, 'Bonze Alone'), 'Bonze Alone: Special Summons itself from the hand');
}

section('Book of Life');
{
  const e = duel(['Book of Life', 'Dragon Zombie'], ['Vorse Raider']);
  toGy(e, 0, 'Dragon Zombie');
  const v = toGy(e, 1, 'Vorse Raider');
  playSpell(e, 0, 'Book of Life');
  check(!!onField(e, 0, 'Dragon Zombie') && zone(e, v) === 'removed', "Book of Life: revives a Zombie and banishes a monster from the opponent's GY");
}

section('Book of Taiyou');
{
  const e = duel(['Book of Taiyou']);
  const fd = place(e, 1, FILL, 'def', false);
  playSpell(e, 0, 'Book of Taiyou');
  check(!!fd && fd.faceUp && fd.pos === 'atk', 'Book of Taiyou: flips a face-down monster into face-up Attack Position');
}

section('Boot-Up Soldier - Dread Dynamo');
{
  const e = duel(['Boot-Up Soldier - Dread Dynamo', 'Ancient Gear Gadget']);
  const d = place(e, 0, 'Boot-Up Soldier - Dread Dynamo');
  const before = atk(e, d);
  place(e, 0, 'Ancient Gear Gadget');
  check(before === 0 && atk(e, d) === 2000, 'Dread Dynamo: +2000 ATK while you control a "Gadget" monster');
}

section('Bowganian');
{
  const e = duel(['Bowganian']);
  place(e, 0, 'Bowganian');
  endTurn(e);
  const mid = lp(e, 1);
  endTurn(e);
  check(mid === 4000 && lp(e, 1) === 3400, 'Bowganian: 600 damage during your Standby Phase');
}

section('Brain Crusher');
{
  const e = fight(['Brain Crusher'], ['Vorse Raider']);
  const bc = place(e, 0, 'Brain Crusher');
  const v = place(e, 1, 'Vorse Raider');
  toBattle(e);
  attack(e, bc, v);
  endTurn(e);
  check(zone(e, v) === 'mz' && e.controller(v!.uid) === 0, 'Brain Crusher: in the End Phase, Special Summons the monster it destroyed by battle');
}

section('Branded Sword');
{
  const e = duel(['Branded Sword', 'Branded Fusion']);
  toGy(e, 0, 'Branded Fusion');
  playTrap(e, 0, 'Branded Sword');
  const t = onField(e, 0, 'Iceblade Token');
  check(!!t && atk(e, t) === 2500 && levelOf(e, t) === 8 && zone(e, e.player(0).removed[0]) === 'removed', 'Branded Sword: banishes a "Branded" Spell/Trap from the GY to Special Summon an Iceblade Token');
  const e2 = duel(['Branded Sword', 'Fallen of Albaz']);
  toBanished(e2, 0, 'Fallen of Albaz');
  const bs = toGy(e2, 0, 'Branded Sword');
  graveFx(e2, 0, bs);
  check(zone(e2, bs) === 'removed' && inHand(e2, 0, 'Fallen of Albaz'), 'Branded Sword: banished from the GY to add a banished "Fallen of Albaz"');
}

section('Break! Draw!');
{
  const e = fight(['Cyber Falcon', 'Break! Draw!'], ['Mammoth Graveyard']);
  const f = place(e, 0, 'Cyber Falcon');
  const bd = playSpell(e, 0, 'Break! Draw!');
  const m = place(e, 1, 'Mammoth Graveyard');
  const hand = e.player(0).hand.length;
  toBattle(e);
  attack(e, f, m);
  check(active(e, bd) && zone(e, m) === 'gy' && e.player(0).hand.length === hand + 1, 'Break! Draw!: the equipped Machine destroys a monster by battle: draw 1');
  const e2 = fight(['Cyber Falcon', 'Break! Draw!'], ['Petit Moth'], 1);
  place(e2, 0, 'Cyber Falcon');
  grab(e2, 0, 'Break! Draw!');
  e2.state.turnPlayer = 0;
  const bd2 = playSpell(e2, 0, 'Break! Draw!');
  e2.state.turnPlayer = 1;
  const moth = place(e2, 1, 'Petit Moth');
  const h2 = e2.player(0).hand.length;
  toBattle(e2);
  attack(e2, moth, e2.monsters(0)[0]);
  check(active(e2, bd2) && zone(e2, moth) === 'gy' && e2.player(0).hand.length === h2 + 1, 'Break! Draw!: also when the equipped monster is attacked and destroys the attacker');
  const e3 = duel(['Cyber Falcon', 'Break! Draw!']);
  place(e3, 0, 'Cyber Falcon');
  const bd3 = playSpell(e3, 0, 'Break! Draw!');
  for (let i = 0; i < 4; i++) endTurn(e3);
  const still = active(e3, bd3);
  endTurn(e3);
  check(still && zone(e3, bd3) === 'gy', 'Break! Draw!: destroyed during your 3rd End Phase after activation');
}

section('Breaker the Magical Warrior');
{
  const e = duel(['Breaker the Magical Warrior'], ['Trap Hole']);
  const b = summon(e, 0, 'Breaker the Magical Warrior');
  const th = putST(e, 1, 'Trap Hole');
  const up = atk(e, b);
  effect(e, 0, b);
  check(up === 1900 && zone(e, th) === 'gy' && atk(e, b) === 1600, 'Breaker: a Spell Counter (+300 ATK), removed to destroy a Spell/Trap');
}

section('Brron, Mad King of Dark World');
{
  const e = fight(['Brron, Mad King of Dark World']);
  const b = place(e, 0, 'Brron, Mad King of Dark World');
  const hand = e.player(0).hand.length;
  toBattle(e);
  attack(e, b, null, 'yes');
  check(lp(e, 1) === 2200 && e.player(0).hand.length === hand - 1, 'Brron: after battle damage, discards 1 card');
}

section('Bujingi Pavo');
{
  const e = fight(['Bujingi Pavo', 'Bujin Test Yamato', 'Bujin Test Hirume'], ['Blue-Eyes White Dragon'], 1);
  const y = place(e, 0, 'Bujin Test Yamato');
  grab(e, 0, 'Bujingi Pavo');
  const b = place(e, 1, 'Blue-Eyes White Dragon');
  toBattle(e);
  attack(e, b, y, { respond: 'Bujingi Pavo' });
  check(zone(e, y) === 'gy' && inGy(e, 0, 'Bujingi Pavo') && !!onField(e, 0, 'Bujin Test Hirume'), 'Bujingi Pavo: a Beast-Warrior "Bujin" destroyed by battle: sends itself to Special Summon a "Bujin" from the Deck');
}

section('Burst Stream of Destruction');
{
  const e = duel(['Blue-Eyes White Dragon', 'Burst Stream of Destruction'], ['Vorse Raider', 'Axe Raider']);
  const b = place(e, 0, 'Blue-Eyes White Dragon');
  place(e, 1, 'Vorse Raider');
  place(e, 1, 'Axe Raider');
  playSpell(e, 0, 'Burst Stream of Destruction');
  e.state.firstTurn = false;
  toBattle(e);
  check(e.monsters(1).length === 0 && !e.canAttackWith(0, b!), "Burst Stream: destroys all the opponent's monsters; Blue-Eyes cannot attack this turn");
}

section('Byser Shock');
{
  const e = duel(['Byser Shock'], ['Trap Hole']);
  const fd = place(e, 1, FILL, 'def', false);
  const th = putST(e, 1, 'Trap Hole');
  place(e, 0, 'Byser Shock');
  check(zone(e, fd) === 'hand' && zone(e, th) === 'hand', 'Byser Shock: Summoned, returns all Set cards to the hand');
}

section('Bystial Druiswurm');
{
  const e = duel(['Bystial Druiswurm'], ['Blue-Eyes White Dragon', 'Vorse Raider']);
  const bewd = toGy(e, 1, 'Blue-Eyes White Dragon');
  const d = grab(e, 0, 'Bystial Druiswurm');
  effect(e, 0, d);
  check(zone(e, d) === 'mz' && zone(e, bewd) === 'removed', 'Bystial Druiswurm: banishes a LIGHT/DARK monster from a GY to Special Summon itself');
  const v = place(e, 1, 'Vorse Raider');
  run(e, e.sendToGrave(d.uid, 'cost'));
  check(zone(e, v) === 'gy', "Bystial Druiswurm: sent from the field to the GY, sends the opponent's Special Summoned monster to the GY");
  const e2 = duel(['Bystial Druiswurm'], ['Vorse Raider']);
  const d2 = place(e2, 0, 'Bystial Druiswurm');
  const v2 = place(e2, 1, 'Vorse Raider');
  delete v2!.tags!.ss;
  run(e2, e2.sendToGrave(d2!.uid, 'cost'));
  check(zone(e2, v2) === 'mz', 'Bystial Druiswurm: a monster that was not Special Summoned is safe');
}

section('Caam, Serenity of Gusto');
{
  const e = duel(['Caam, Serenity of Gusto', 'Musto, Oracle of Gusto', 'Musto, Oracle of Gusto']);
  const c = place(e, 0, 'Caam, Serenity of Gusto');
  toGy(e, 0, 'Musto, Oracle of Gusto');
  toGy(e, 0, 'Musto, Oracle of Gusto');
  const hand = e.player(0).hand.length;
  effect(e, 0, c);
  check(!inGy(e, 0, 'Musto, Oracle of Gusto') && e.player(0).hand.length === hand + 1, 'Caam: shuffles 2 "Gusto" monsters from the GY into the Deck to draw 1');
}

section('Call of the Mummy');
{
  const e = duel(['Call of the Mummy', 'Dragon Zombie']);
  grab(e, 0, 'Dragon Zombie');
  const com = playSpell(e, 0, 'Call of the Mummy');
  effect(e, 0, com);
  check(!!onField(e, 0, 'Dragon Zombie'), 'Call of the Mummy: Special Summons a Zombie from the hand while you control no monsters');
  check(!e.canUseMonsterEffect(0, com!), 'Call of the Mummy: not again (once per turn, and you control a monster)');
}

section('Carboneddon');
{
  const e = fight(['Carboneddon', 'Koumori Dragon'], ['Fireyarou']);
  const c = place(e, 0, 'Carboneddon');
  const f = place(e, 1, 'Fireyarou');
  toBattle(e);
  attack(e, c, f);
  check(zone(e, f) === 'gy' && zone(e, c) === 'mz', 'Carboneddon: +1000 ATK when it battles a FIRE monster');
  const e2 = duel(['Carboneddon', 'Koumori Dragon']);
  const c2 = toGy(e2, 0, 'Carboneddon');
  graveFx(e2, 0, c2);
  const k = onField(e2, 0, 'Koumori Dragon');
  check(zone(e2, c2) === 'removed' && !!k && k.pos === 'def', 'Carboneddon: banished from the GY to Special Summon a Dragon Normal Monster from the Deck in Defense Position');
}

section('Card Blocker');
{
  const e = fight(['Card Blocker'], ['Vorse Raider'], 1);
  const cb = place(e, 0, 'Card Blocker');
  const f = place(e, 0, FILL);
  const v = place(e, 1, 'Vorse Raider');
  const wasDef = cb?.pos === 'def';
  toBattle(e);
  attack(e, v, f, { respond: 'Card Blocker' });
  check(wasDef && zone(e, f) === 'mz' && zone(e, cb) === 'gy', 'Card Blocker: Summoned in Defense Position; takes over an attack on another monster');
  const e2 = fight(['Card Blocker'], ['Vorse Raider'], 1);
  const cb2 = place(e2, 0, 'Card Blocker');
  const v2 = place(e2, 1, 'Vorse Raider');
  const gy = e2.player(0).gy.length;
  toBattle(e2);
  attack(e2, v2, cb2, { respond: 'Card Blocker' }, { pick: ['3'] });
  check(zone(e2, cb2) === 'mz' && e2.player(0).gy.length === gy + 3, 'Card Blocker: targeted, sends 3 cards from the Deck to gain 1500 DEF (1900 DEF holds)');
}

section('Card Trooper');
{
  const e = duel(['Card Trooper']);
  const c = place(e, 0, 'Card Trooper');
  effect(e, 0, c, { pick: ['3'] });
  check(atk(e, c) === 1900 && e.player(0).gy.length === 3, 'Card Trooper: sends 3 cards from the Deck to the GY, +1500 ATK');
  const hand = e.player(0).hand.length;
  kill(e, [c], 1);
  check(e.player(0).hand.length === hand + 1, 'Card Trooper: destroyed and sent to the GY: draw 1');
}

section('Cardcar D');
{
  const e = duel(['Cardcar D', 'Cardcar D']);
  check(!place(e, 0, 'Cardcar D'), 'Cardcar D: cannot be Special Summoned');
  const c = summon(e, 0, 'Cardcar D');
  const hand = e.player(0).hand.length;
  effect(e, 0, c);
  check(zone(e, c) === 'gy' && e.player(0).hand.length === hand + 2 && e.state.phase !== 'M1', 'Cardcar D: Tributes itself to draw 2, then the Main Phase ends');
  check(e.summonBlocked(0, grab(e, 0, FILL), 'special', 'hand'), 'Cardcar D: no Special Summons that turn');
}

section('Carpiponica, Mystical Beast of the Forest');
{
  const e = duel(['Carpiponica, Mystical Beast of the Forest', 'Arlownay', 'Armored Rat', 'Test Mystical Spirit of the Forest']);
  toGy(e, 0, 'Arlownay');
  toGy(e, 0, 'Armored Rat');
  const c = grab(e, 0, 'Carpiponica, Mystical Beast of the Forest');
  run(e, e.discard(0, c.uid), 'yes', { pick: ['Arlownay'] }, { pick: ['Armored Rat'] }, 'yes');
  check(zone(e, c) === 'mz' && !inGy(e, 0, 'Arlownay') && !inGy(e, 0, 'Armored Rat'), 'Carpiponica: sent from the hand to the GY, shuffles 2 monsters of different Types into the Deck to Special Summon itself');
  check(inHand(e, 0, 'Test Mystical Spirit of the Forest'), 'Carpiponica: Special Summoned, adds a "Mystical Spirit of the Forest" monster');
}

section('Cartorhyn the Hidden Gem of the Seafront');
{
  const e = duel(['Cartorhyn the Hidden Gem of the Seafront', 'Axe Raider', 'Amazon of the Seas']);
  summon(e, 0, FILL);
  const c = grab(e, 0, 'Cartorhyn the Hidden Gem of the Seafront');
  grab(e, 0, 'Axe Raider');
  effect(e, 0, c, { pick: ['Axe Raider'] }, { pick: ['Normal Summon'] });
  check(zone(e, c) === 'gy' && !!onField(e, 0, 'Axe Raider') && e.monsters(0).length === 2, 'Cartorhyn: discarded, an additional Normal Summon of an EARTH/WATER monster');
  kill(e, [onField(e, 0, FILL)]);
  place(e, 0, 'Amazon of the Seas');
  graveFx(e, 0, c);
  check(zone(e, c) === 'mz', 'Cartorhyn: Special Summons itself from the GY while you control EARTH and WATER monsters');
  kill(e, [e.fieldCard(c.uid)]);
  check(zone(e, c) === 'removed', 'Cartorhyn: banished when it leaves the field');
}

section('Cataclysmic Crusted Calcifida');
{
  const e = duel(['Cataclysmic Crusted Calcifida', 'Axe Raider'], ['Vorse Raider']);
  const f = place(e, 0, FILL);
  const c = grab(e, 0, 'Cataclysmic Crusted Calcifida');
  kill(e, [f], 0);
  check(zone(e, c) === 'hand', "Calcifida: not when your own card destroys the EARTH monster");
  const f2 = place(e, 0, FILL);
  kill(e, [f2], 1, 'yes', 'yes', { pick: ['Axe Raider'] });
  check(zone(e, c) === 'mz' && inGy(e, 0, 'Axe Raider'), "Calcifida: an EARTH monster destroyed by the opponent's card effect: Special Summons itself and sends a monster from the Deck to the GY");
  const e2 = fight(['Cataclysmic Crusted Calcifida'], ['Vorse Raider'], 1);
  const g = place(e2, 0, FILL);
  const c2 = grab(e2, 0, 'Cataclysmic Crusted Calcifida');
  const v = place(e2, 1, 'Vorse Raider');
  toBattle(e2);
  attack(e2, v, g, 'yes');
  check(zone(e2, c2) === 'mz', 'Calcifida: also when the EARTH monster is destroyed by battle');
}

section('Cestus of Dagla');
{
  const e = fight(['Dunames Dark Witch', 'Cestus of Dagla']);
  const d = place(e, 0, 'Dunames Dark Witch');
  playSpell(e, 0, 'Cestus of Dagla');
  toBattle(e);
  attack(e, d, null);
  check(lp(e, 1) === 4000 - 2300 && lp(e, 0) === 4000 + 2300, 'Cestus of Dagla: the Fairy gains 500 ATK and its controller gains LP equal to the battle damage');
}

section('Chainsaw Insect');
{
  const e = fight(['Chainsaw Insect']);
  const c = place(e, 0, 'Chainsaw Insect');
  const f = place(e, 1, FILL);
  const hand = e.player(1).hand.length;
  toBattle(e);
  attack(e, c, f);
  check(zone(e, f) === 'gy' && e.player(1).hand.length === hand + 1, 'Chainsaw Insect: after it battles, the opponent draws 1');
}

section("Champion's Vigilance");
{
  const e = duel(["Champion's Vigilance", 'Dark Magician'], ['Dian Keto the Cure Master'], [], [], 1);
  place(e, 0, 'Dark Magician');
  putST(e, 0, "Champion's Vigilance");
  const dk = playSpell(e, 1, 'Dian Keto the Cure Master', { respond: "Champion's Vigilance" });
  check(lp(e, 1) === 4000 && inGy(e, 1, 'Dian Keto the Cure Master') && inGy(e, 0, "Champion's Vigilance") && !dk, "Champion's Vigilance: with a Level 7+ Normal Monster, negates a Spell activation and destroys it");
}

section('Chaos Grepher');
{
  const e = duel(['Chaos Grepher', 'Blue-Eyes White Dragon', 'Dark Magician']);
  const g = place(e, 0, 'Chaos Grepher');
  grab(e, 0, 'Blue-Eyes White Dragon');
  effect(e, 0, g, { pick: ['Blue-Eyes White Dragon'] }, { pick: ['Dark Magician'] });
  const dm = e.player(0).gy.find((c) => c.name === 'Dark Magician');
  check(inGy(e, 0, 'Blue-Eyes White Dragon') && !!dm, 'Chaos Grepher: discards a LIGHT monster to send a DARK monster from the Deck to the GY');
  check(!!dm && e.summonBlocked(0, dm, 'special', 'gy') && !e.summonBlocked(0, grab(e, 0, FILL), 'special', 'hand'), 'Chaos Grepher: no Special Summons of a monster with that name this turn');
}

section('Chaos Summoning Beast');
{
  const e = duel(['Chaos Summoning Beast', 'Uria, Lord of Searing Flames', 'Fallen Paradise']);
  const c = place(e, 0, 'Chaos Summoning Beast');
  grab(e, 0, 'Uria, Lord of Searing Flames');
  effect(e, 0, c);
  check(zone(e, c) === 'gy' && !!onField(e, 0, 'Uria, Lord of Searing Flames'), 'Chaos Summoning Beast: Tributes itself to Special Summon Uria from the hand');
  graveFx(e, 0, c!);
  check(zone(e, c) === 'removed' && inHand(e, 0, 'Fallen Paradise'), 'Chaos Summoning Beast: banished from the GY to add "Fallen Paradise"');
}

section('Chaos Trap Hole');
{
  const e = duel(['Chaos Trap Hole'], ['Vorse Raider'], [], [], 1);
  putST(e, 0, 'Chaos Trap Hole');
  const v = summon(e, 1, 'Vorse Raider', true, { respond: 'Chaos Trap Hole' });
  check(!v && lp(e, 0) === 2000 && e.player(1).removed.some((c) => c.name === 'Vorse Raider'), 'Chaos Trap Hole: pays 2000 LP to negate the Summon of a DARK monster and banish it');
}

section('Chaosrider Gustaph');
{
  const e = duel(['Chaosrider Gustaph', 'Dian Keto the Cure Master', 'Book of Taiyou']);
  const g = place(e, 0, 'Chaosrider Gustaph');
  toGy(e, 0, 'Dian Keto the Cure Master');
  toGy(e, 0, 'Book of Taiyou');
  effect(e, 0, g, { pick: ['Dian Keto the Cure Master', 'Book of Taiyou'] });
  const now = atk(e, g);
  endTurn(e);
  const theirs = atk(e, g);
  endTurn(e);
  check(now === 2000 && theirs === 2000 && atk(e, g) === 1400 && e.player(0).removed.length === 2, "Chaosrider Gustaph: banishes 2 Spells for +600 ATK until the end of the opponent's next turn");
}

section('Chimera the Flying Mythical Beast');
{
  const e = duel(['Berfomet'], [], ['Chimera the Flying Mythical Beast']);
  const c = place(e, 0, 'Chimera the Flying Mythical Beast');
  toGy(e, 0, 'Berfomet');
  kill(e, [c], 1);
  check(zone(e, c) === 'gy' && !!onField(e, 0, 'Berfomet'), 'Chimera: destroyed, Special Summons "Berfomet" from the GY');
}

section('Chiron the Mage');
{
  const e = duel(['Chiron the Mage', 'Dian Keto the Cure Master'], ['Trap Hole']);
  const c = place(e, 0, 'Chiron the Mage');
  grab(e, 0, 'Dian Keto the Cure Master');
  const th = putST(e, 1, 'Trap Hole');
  effect(e, 0, c, { pick: ['Dian Keto the Cure Master'] });
  check(inGy(e, 0, 'Dian Keto the Cure Master') && zone(e, th) === 'gy', "Chiron the Mage: discards a Spell to destroy a Spell/Trap the opponent controls");
}

section('Chow Sai the Ghost Stopper');
{
  const e = duel(['Chow Sai the Ghost Stopper', 'Bonding - DHO', 'Water Dragon'], ['Trap Hole']);
  const cs = place(e, 0, 'Chow Sai the Ghost Stopper');
  const dho = toGy(e, 0, 'Bonding - DHO');
  const th = toGy(e, 1, 'Trap Hole');
  const locked = !e.canUseGraveEffect(0, dho.uid);
  kill(e, [cs], 1);
  check(locked && e.canUseGraveEffect(0, dho.uid), 'Chow Sai: Spell/Trap effects in the GY cannot be activated while it is face-up');
  check(zone(e, th) === 'removed', "Chow Sai: sent from the field to the GY, banishes a Spell/Trap from the opponent's GY");
}

section('Chronicle Magician');
{
  const e = duel(['Chronicle Magician', 'Dark Magician']);
  const c = grab(e, 0, 'Chronicle Magician');
  const dm = place(e, 0, 'Dark Magician', 'atk', true, { respond: 'Chronicle Magician' });
  const cm = e.fieldCard(c.uid);
  check(!!cm && cm.pos === 'def', 'Chronicle Magician: a 2500 ATK monster Summoned to your field: Special Summons itself from the hand in Defense Position');
  check(atk(e, dm) === 5000 && def(e, dm) === 4600, 'Chronicle Magician: Special Summoned, "Dark Magician" gains 2500 ATK/DEF');
}

section('Chronomaly Acambaro Figures');
{
  const e = duel(['Chronomaly Acambaro Figures', 'Chronomaly Moai']);
  const moai = place(e, 0, 'Chronomaly Moai');
  const a = grab(e, 0, 'Chronomaly Acambaro Figures');
  kill(e, [moai], 1, 'yes');
  check(zone(e, moai) === 'mz' && zone(e, a) === 'gy', "Acambaro Figures: discarded instead of a \"Chronomaly\" monster being destroyed by the opponent's effect");
  graveFx(e, 0, a);
  check(zone(e, a) === 'mz' && lp(e, 0) === 3000, 'Acambaro Figures: pays 1000 LP to Special Summon itself from the GY');
  check(e.summonBlocked(0, grab(e, 0, FILL), 'special', 'hand'), 'Acambaro Figures: only "Chronomaly" monsters can be Special Summoned that turn');
  endTurn(e);
  check(zone(e, a) === 'hand', 'Acambaro Figures: returns to the hand in the End Phase');
  const e2 = duel(['Chronomaly Acambaro Figures', 'Chronomaly Moai']);
  const m2 = place(e2, 0, 'Chronomaly Moai');
  const a2 = grab(e2, 0, 'Chronomaly Acambaro Figures');
  kill(e2, [m2], 0, 'yes');
  check(zone(e2, m2) === 'gy' && zone(e2, a2) === 'hand', 'Acambaro Figures: not against your own card effect');
}

section('Chronomaly Moai');
{
  const e = duel(['Chronomaly Moai', 'Chronomaly Mud Golem']);
  const moai = grab(e, 0, 'Chronomaly Moai');
  const cannot = !e.canSpecialProc(0, moai);
  place(e, 0, 'Chronomaly Mud Golem');
  special(e, 0, moai);
  check(cannot && zone(e, moai) === 'mz' && e.fieldCard(moai.uid)!.pos === 'def', 'Chronomaly Moai: Special Summons itself in Defense Position while you control a "Chronomaly" monster');
}

section('Chronomaly Mud Golem');
{
  const e = fight(['Chronomaly Mud Golem', 'Chronomaly Moai']);
  place(e, 0, 'Chronomaly Mud Golem');
  const moai = place(e, 0, 'Chronomaly Moai');
  const d = place(e, 1, FILL, 'def');
  toBattle(e);
  attack(e, moai, d);
  check(zone(e, d) === 'gy' && lp(e, 1) === 4000 - 600, 'Chronomaly Mud Golem: another "Chronomaly" monster inflicts piercing damage');
}

section('Cloudian - Acid Cloud');
{
  const e = fight(['Cloudian - Smoke Ball', 'Cloudian - Acid Cloud', 'Cloudian - Acid Cloud'], ['Trap Hole', 'Vorse Raider']);
  place(e, 0, 'Cloudian - Smoke Ball');
  const ac = summon(e, 0, 'Cloudian - Acid Cloud');
  const th = putST(e, 1, 'Trap Hole');
  const fog = ac?.tags?.fog;
  effect(e, 0, ac);
  check(fog === 2 && zone(e, th) === 'gy' && ac!.tags!.fog === 0, 'Acid Cloud: Normal Summoned with 2 Fog Counters (2 Cloudians); removes 2 to destroy a Spell/Trap');
  const v = place(e, 1, 'Vorse Raider');
  e.state.turnPlayer = 1;
  toBattle(e);
  attack(e, v, ac);
  check(zone(e, ac) === 'mz', 'Acid Cloud: cannot be destroyed by battle');
  const d = place(e, 0, 'Cloudian - Acid Cloud', 'def');
  check(!d && inGy(e, 0, 'Cloudian - Acid Cloud'), 'Acid Cloud: destroyed while in face-up Defense Position');
}

section('Cloudian - Altus');
{
  const e = duel(['Cloudian - Altus']);
  const a = place(e, 0, 'Cloudian - Altus');
  a!.tags!.fog = 3;
  const hand = e.player(1).hand.length;
  effect(e, 0, a);
  check(e.player(1).hand.length === hand - 1 && e.player(1).gy.length === 1 && a!.tags!.fog === 0, "Altus: removes 3 Fog Counters to discard a random card from the opponent's hand");
}

section('Cloudian - Cirrostratus');
{
  const e = duel(['Cloudian - Cirrostratus'], ['Vorse Raider']);
  const c = place(e, 0, 'Cloudian - Cirrostratus');
  const v = place(e, 1, 'Vorse Raider');
  c!.tags!.fog = 2;
  effect(e, 0, c, { pick: ['Vorse Raider'] });
  check(zone(e, v) === 'gy' && c!.tags!.fog === 0, 'Cirrostratus: removes 2 Fog Counters to destroy a monster');
}

section('Cloudian - Eye of the Typhoon');
{
  const e = fight(['Cloudian - Eye of the Typhoon'], ['Vorse Raider']);
  const eye = place(e, 0, 'Cloudian - Eye of the Typhoon');
  const f = place(e, 1, FILL);
  const v = place(e, 1, 'Vorse Raider');
  toBattle(e);
  attack(e, eye, v);
  check(f!.pos === 'def' && zone(e, v) === 'gy' && lp(e, 1) === 4000, 'Eye of the Typhoon: declaring an attack changes the positions of all face-up non-Cloudian monsters');
}

section('Cloudian - Ghost Fog');
{
  const e = fight(['Cloudian - Ghost Fog'], ['Vorse Raider'], 1);
  check(!place(e, 0, 'Cloudian - Ghost Fog'), 'Ghost Fog: cannot be Special Summoned');
  const c = e.player(0).deck.find((x) => x.name === 'Cloudian - Ghost Fog')!;
  e.state.fx.ignoreCond = c.uid;
  const g = place(e, 0, 'Cloudian - Ghost Fog');
  e.state.fx.ignoreCond = undefined;
  const v = place(e, 1, 'Vorse Raider');
  toBattle(e);
  attack(e, v, g);
  check(zone(e, g) === 'gy' && lp(e, 0) === 4000, 'Ghost Fog: no battle damage from its battles');
  check(v!.tags?.fog === 4, 'Ghost Fog: destroyed by battle, places Fog Counters equal to the Level of the monster that destroyed it');
}

section('Cloudian - Sheep Cloud');
{
  const e = fight(['Cloudian - Sheep Cloud'], ['Vorse Raider'], 1);
  const s = place(e, 0, 'Cloudian - Sheep Cloud');
  const v = place(e, 1, 'Vorse Raider');
  toBattle(e);
  attack(e, v, s);
  const toks = e.monsters(0).filter((m) => m.name === 'Cloudian Token');
  check(zone(e, s) === 'gy' && toks.length === 2 && toks.every((t) => t.pos === 'def'), 'Sheep Cloud: destroyed by battle, Special Summons 2 Cloudian Tokens in Defense Position');
}

section('Cloudian - Storm Dragon');
{
  const e = duel(['Cloudian - Storm Dragon', 'Cloudian - Smoke Ball']);
  const sb = toGy(e, 0, 'Cloudian - Smoke Ball');
  const sd = grab(e, 0, 'Cloudian - Storm Dragon');
  check(!e.canNormalSummon(0, sd, true), 'Storm Dragon: cannot be Normal Summoned');
  special(e, 0, sd);
  const m = e.fieldCard(sd.uid);
  check(!!m && zone(e, sb) === 'removed', 'Storm Dragon: Special Summoned by banishing a "Cloudian" monster from the GY');
  effect(e, 0, m);
  check(m!.tags?.fog === 1, 'Storm Dragon: places a Fog Counter on a monster');
}

section('Cloudian - Turbulence');
{
  const e = duel(['Cloudian - Turbulence', 'Cloudian - Smoke Ball']);
  const t = summon(e, 0, 'Cloudian - Turbulence');
  const fog = t?.tags?.fog;
  effect(e, 0, t);
  check(fog === 1 && !!onField(e, 0, 'Cloudian - Smoke Ball') && t!.tags!.fog === 0, 'Turbulence: removes a Fog Counter to Special Summon "Cloudian - Smoke Ball" from the Deck');
}

section('Cloudian Aerosol');
{
  const e = duel(['Cloudian Aerosol', 'Cloudian - Altus'], ['Vorse Raider']);
  grab(e, 0, 'Cloudian - Altus');
  const v = place(e, 1, 'Vorse Raider');
  playSpell(e, 0, 'Cloudian Aerosol', { pick: ['Cloudian - Altus'] }, { pick: ['Vorse Raider'] });
  check(inGy(e, 0, 'Cloudian - Altus') && v!.tags?.fog === 4, 'Cloudian Aerosol: discards a "Cloudian" to place Fog Counters equal to the target\'s Level');
  const e2 = duel(['Cloudian Aerosol', 'Cloudian - Altus', 'Cloudian - Cirrostratus']);
  const ca = toGy(e2, 0, 'Cloudian Aerosol');
  toGy(e2, 0, 'Cloudian - Altus');
  graveFx(e2, 0, ca);
  check(zone(e2, ca) === 'removed' && !!onField(e2, 0, 'Cloudian - Cirrostratus'), 'Cloudian Aerosol: banished with a "Cloudian" from the GY to Special Summon a "Cloudian" from the Deck');
}

section('Cloudian Squall');
{
  const e = duel(['Cloudian Squall'], ['Vorse Raider']);
  playSpell(e, 0, 'Cloudian Squall');
  const v = place(e, 1, 'Vorse Raider');
  endTurn(e);
  const theirs = v!.tags?.fog ?? 0;
  endTurn(e);
  check(theirs === 0 && v!.tags?.fog === 1, 'Cloudian Squall: during your Standby Phase, a Fog Counter on every face-up monster');
}

section('Common Charity');
{
  const e = duel(['Common Charity', 'Amazon of the Seas', 'Petit Moth']);
  putST(e, 0, 'Common Charity');
  const hand = e.player(0).hand.length;
  act(e, 0, e.player(0).sz.find((c) => c?.name === 'Common Charity')!.uid, { pick: ['Amazon of the Seas'] });
  check(e.player(0).hand.length === hand + 1 && e.player(0).removed.some((c) => c.name === 'Amazon of the Seas'), 'Common Charity: draws 2, then banishes a Normal Monster from the hand');
  const e2 = duel(['Common Charity', 'Black Ptera', 'Bitelon']);
  trimHand(e2, 0, 0);
  playTrap(e2, 0, 'Common Charity');
  check(e2.player(0).hand.length === 0 && inGy(e2, 0, 'Black Ptera') && inGy(e2, 0, 'Bitelon'), 'Common Charity: no Normal Monster, the whole hand goes to the GY');
}

section('Conquistador of the Golden Land');
{
  const e = duel(['Conquistador of the Golden Land', 'Eldlich the Golden Lord'], ['Trap Hole']);
  place(e, 0, 'Eldlich the Golden Lord');
  const th = putST(e, 1, 'Trap Hole');
  th.faceUp = true;
  const c = playTrap(e, 0, 'Conquistador of the Golden Land', { pick: ['Attack Position'] }, { pick: ['Trap Hole'] });
  check(!!c && zone(e, c) === 'mz' && levelOf(e, c) === 5 && raceOf(e, c) === 'Zombie' && attrOf(e, c) === 'LIGHT', 'Conquistador: Special Summoned as a Zombie/LIGHT/Level 5 monster');
  check(zone(e, th) === 'gy', 'Conquistador: with "Eldlich the Golden Lord", destroys a face-up card');
  const e2 = duel(['Conquistador of the Golden Land', 'Eldlixir of Test']);
  const c2 = toGy(e2, 0, 'Conquistador of the Golden Land');
  endTurn(e2, 'yes');
  const set = e2.player(0).sz.find((x) => x?.name === 'Eldlixir of Test');
  check(zone(e2, c2) === 'removed' && !!set && !set.faceUp, 'Conquistador: in the End Phase, banished from the GY to Set an "Eldlixir" from the Deck');
}

section('Conscription');
{
  const e = duel(['Conscription'], ['Vorse Raider']);
  playTrap(e, 0, 'Conscription');
  const v = onField(e, 0, 'Vorse Raider');
  check(!!v, "Conscription: the opponent's top card is a monster: Special Summoned to your field");
  const e2 = duel(['Conscription'], ['Dian Keto the Cure Master']);
  playTrap(e2, 0, 'Conscription');
  check(inHand(e2, 1, 'Dian Keto the Cure Master'), "Conscription: otherwise it goes to the opponent's hand");
}

section('Constellar Caduceus');
{
  const e = duel(['Constellar Caduceus', 'Constellar Test Star', 'Constellar Belt']);
  const c = grab(e, 0, 'Constellar Caduceus');
  const no = !e.canSpecialProc(0, c);
  place(e, 0, 'Constellar Test Star');
  special(e, 0, c);
  const m = e.fieldCard(c.uid);
  check(no && !!m, 'Constellar Caduceus: Special Summons itself while you control another "Constellar" monster');
  effect(e, 0, m);
  check(inHand(e, 0, 'Constellar Belt'), 'Constellar Caduceus: adds a "Constellar" Spell/Trap from the Deck');
}

section('Construction Train Signal Red');
{
  const e = fight(['Construction Train Signal Red'], ['Vorse Raider'], 1);
  const f = place(e, 0, FILL);
  const sr = grab(e, 0, 'Construction Train Signal Red');
  const v = place(e, 1, 'Vorse Raider');
  toBattle(e);
  attack(e, v, f, { respond: 'Construction Train Signal Red' });
  check(zone(e, sr) === 'mz' && zone(e, f) === 'mz' && lp(e, 0) === 4000, 'Signal Red: Special Summoned from the hand, becomes the attack target and survives that battle');
}

section('Contact Gate');
{
  const e = duel(['Contact Gate', 'Neo-Spacian Aqua Dolphin', 'Neo-Spacian Dark Panther', 'Neo-Spacian Air Hummingbird', 'Neo-Spacian Glow Moss'], [], ['Gaia the Dragon Champion', 'Hi-Speedroid Puzzle']);
  toGy(e, 0, 'Neo-Spacian Aqua Dolphin');
  toGy(e, 0, 'Neo-Spacian Dark Panther');
  playSpell(e, 0, 'Contact Gate');
  check(e.player(0).removed.length === 2 && e.monsters(0).filter((m) => m.name.startsWith('Neo-Spacian')).length === 2, 'Contact Gate: banishes 2 "Neo-Spacian" from the GY to Special Summon 2 with different names');
  const syn = e.player(0).fusion.find((c) => c.name === 'Hi-Speedroid Puzzle')!;
  const fus = e.player(0).fusion.find((c) => c.name === 'Gaia the Dragon Champion')!;
  check(e.summonBlocked(0, syn, 'special', 'fusion') && !e.summonBlocked(0, fus, 'special', 'fusion'), 'Contact Gate: no Special Summons from the Extra Deck this turn, except Fusion Monsters');
  const e2 = duel(['Contact Gate', 'Neo-Spacian Aqua Dolphin'], [], ['Elemental HERO Aqua Neos']);
  toGy(e2, 0, 'Contact Gate');
  toBanished(e2, 0, 'Neo-Spacian Aqua Dolphin');
  const x = e2.player(0).fusion[0];
  e2.state.fx.contactSummon = x.uid;
  place(e2, 0, 'Elemental HERO Aqua Neos');
  e2.state.fx.contactSummon = undefined;
  endTurn(e2, 'yes');
  check(zone(e2, x) === 'fusion' && !!onField(e2, 0, 'Neo-Spacian Aqua Dolphin') && e2.player(0).removed.some((c) => c.name === 'Contact Gate'), 'Contact Gate: a Neos Fusion returns to the Extra Deck: banished from the GY to Special Summon a banished "Neo-Spacian"');
}

// ======================= batch 11 =======================
section('Ancient Gear Castle');
{
  const e = duel(['Ancient Gear Castle', 'Ancient Gear Soldier', 'Ancient Gear Golem', 'Axe Raider']);
  const castle = playSpell(e, 0, 'Ancient Gear Castle');
  const s = place(e, 0, 'Ancient Gear Soldier');
  summon(e, 0, 'Axe Raider');
  summon(e, 0, FILL, false);
  check(atk(e, s) === 1600 && castle!.counters === 2, 'Ancient Gear Castle: "Ancient Gear" monsters +300 ATK; a counter for each Normal Summon/Set');
  kill(e, [onField(e, 0, FILL)!]);
  summon(e, 0, 'Ancient Gear Golem', true, 'yes');
  check(!!onField(e, 0, 'Ancient Gear Golem') && zone(e, castle) === 'gy' && e.monsters(0).length === 3, 'Ancient Gear Castle: Tributed instead of 2 monsters for "Ancient Gear Golem"');
}

section('Arcane Barrier');
{
  const e = duel(['Arcane Barrier', 'Dark Magician', 'Ancient Elf']);
  const ab = playSpell(e, 0, 'Arcane Barrier');
  const dm = place(e, 0, 'Dark Magician');
  kill(e, [dm], 1);
  const n = ab!.counters;
  place(e, 0, 'Ancient Elf');
  const hand = e.player(0).hand.length;
  effect(e, 0, ab);
  check(n === 1 && zone(e, ab) === 'gy' && inGy(e, 0, 'Ancient Elf') && e.player(0).hand.length === hand + 1, 'Arcane Barrier: a Spell Counter per destroyed Spellcaster; sends itself and a Spellcaster to draw that many');
}

section('Attack the Moon!');
{
  const e = duel(['Attack the Moon!', 'Alpha The Magnet Warrior'], ['Trap Hole']);
  playSpell(e, 0, 'Attack the Moon!');
  const a = place(e, 0, 'Alpha The Magnet Warrior');
  const th = putST(e, 1, 'Trap Hole');
  e.apply({ type: 'CHANGE_POS', player: 0, uid: a!.uid });
  settle(e, 'yes');
  check(a!.pos === 'def' && zone(e, th) === 'gy', "Attack the Moon!: a Rock monster's position changes: destroys a Spell/Trap the opponent controls");
}

section('Branded Disciple');
{
  const e = duel(['Branded Disciple', 'Evil HERO Malicious Fiend'], ['Cloudian - Cirrostratus'], [], [], 1);
  e.state.turnPlayer = 0;
  playSpell(e, 0, 'Branded Disciple');
  e.state.turnPlayer = 1;
  const f = place(e, 0, 'Evil HERO Malicious Fiend');
  const c = place(e, 1, 'Cloudian - Cirrostratus');
  c!.tags!.fog = 2;
  effect(e, 1, c, { respond: 'Branded Disciple' });
  check(zone(e, f) === 'mz' && logHas(e, "Branded Disciple negates Cloudian - Cirrostratus's effect"), "Branded Disciple: with a Level 8+ Fiend Fusion, negates the effect of the opponent's 0 DEF monster");
  const e2 = fight(['Branded Disciple', 'Test Zero Beast'], ['Test Zero Beast']);
  playSpell(e2, 0, 'Branded Disciple');
  const z0 = place(e2, 0, 'Test Zero Beast');
  const z1 = place(e2, 1, 'Test Zero Beast');
  toBattle(e2);
  attack(e2, z0, z1, 'yes');
  check(zone(e2, z1) === 'gy' && zone(e2, z0) === 'mz', "Branded Disciple: two 0 ATK monsters battled: destroys the opponent's");
}

section('Cerulean Skyfire');
{
  const e = duel(['Cerulean Skyfire', 'Hamon, Lord of Striking Thunder'], ['Dian Keto the Cure Master'], [], [], 1);
  e.state.turnPlayer = 0;
  playSpell(e, 0, 'Cerulean Skyfire');
  e.state.turnPlayer = 1;
  const h = place(e, 0, 'Hamon, Lord of Striking Thunder');
  playSpell(e, 1, 'Dian Keto the Cure Master', { respond: 'Cerulean Skyfire' });
  check(lp(e, 1) === 4000 && h!.pos === 'def', "Cerulean Skyfire: negates the opponent's Spell effect, then Hamon changes to Defense Position");
  kill(e, [h], 1);
  e.damage(0, 500);
  check(lp(e, 0) === 4000, 'Cerulean Skyfire: a Sacred Beast left the field: no damage this turn');
}

section('Constellar Belt');
{
  const e = duel(['Constellar Belt', 'Blue-Eyes White Dragon']);
  const b = place(e, 0, 'Blue-Eyes White Dragon')!;
  const mk = () => ({ card: b, loc: e.find(b.uid)!.loc, player: 0 as Pid, label: b.name, negated: false, payload: { effect: 'quick' } });
  const l1 = mk();
  negateLink(e, l1, 1);
  playSpell(e, 0, 'Constellar Belt');
  const l2 = mk();
  negateLink(e, l2, 1);
  check(l1.negated && !l2.negated, "Constellar Belt: the activation of a LIGHT monster's effect cannot be negated");
}

section('Hidden Temples of Necrovalley');
{
  const e = duel(['Hidden Temples of Necrovalley', 'Necrovalley', "Gravekeeper's Assailant", "Gravekeeper's Cannonholder"]);
  const g = place(e, 0, "Gravekeeper's Assailant");
  playSpell(e, 0, 'Necrovalley');
  const ht = playSpell(e, 0, 'Hidden Temples of Necrovalley');
  const blocked = !place(e, 0, FILL);
  const gk = place(e, 0, "Gravekeeper's Cannonholder");
  check(active(e, ht) && blocked && !!gk, 'Hidden Temples: only "Gravekeeper\'s" monsters can be Special Summoned');
  kill(e, [g, gk]);
  check(zone(e, ht) === 'gy', 'Hidden Temples: destroyed when no "Gravekeeper\'s" monster is on the field');
}

section('Jam Breeding Machine');
{
  const e = duel(['Jam Breeding Machine']);
  playSpell(e, 0, 'Jam Breeding Machine');
  const f = grab(e, 0, FILL);
  check(!e.canNormalSummon(0, f, true) && e.canNormalSummon(0, f, false), 'Jam Breeding Machine: you cannot Summon (but you can Set)');
  endTurn(e);
  endTurn(e);
  check(!!onField(e, 0, 'Slime Token'), 'Jam Breeding Machine: a Slime Token during your Standby Phase');
}

section('Machine Assembly Line');
{
  const e = duel(['Machine Assembly Line', 'Cyber Falcon', 'Cyber Falcon']);
  const mal = playSpell(e, 0, 'Machine Assembly Line');
  const f1 = place(e, 0, 'Cyber Falcon');
  const boosted = atk(e, f1);
  kill(e, [f1], 1);
  const f2 = place(e, 0, 'Cyber Falcon');
  kill(e, [f2], 1);
  const n = mal!.counters;
  effect(e, 0, mal);
  check(boosted === 1600 && n === 4 && zone(e, mal) === 'gy' && !!onField(e, 0, 'Cyber Falcon'), 'Machine Assembly Line: Machines +200 ATK; 2 Junk Counters per destruction; sent to the GY to revive a Level 4 Machine');
}

section('Millennium Revelation');
{
  const e = duel(['Millennium Revelation', 'Test Divine Beast', 'Monster Reborn', 'The Winged Dragon of Ra']);
  const mr = playSpell(e, 0, 'Millennium Revelation');
  grab(e, 0, 'Test Divine Beast');
  effect(e, 0, mr, { pick: ['Send a Divine-Beast: add "Monster Reborn"'] });
  check(inGy(e, 0, 'Test Divine Beast') && inHand(e, 0, 'Monster Reborn'), 'Millennium Revelation: sends a Divine-Beast from the hand to add "Monster Reborn"');
  toGy(e, 0, 'The Winged Dragon of Ra');
  effect(e, 0, mr, { pick: ['Send this card: revive Ra with "Monster Reborn" this turn'] });
  playSpell(e, 0, 'Monster Reborn', { pick: ['The Winged Dragon of Ra'] }, 'yes');
  const ra = onField(e, 0, 'The Winged Dragon of Ra');
  endTurn(e);
  check(zone(e, mr) === 'gy' && !!ra && zone(e, ra) === 'gy', 'Millennium Revelation: Ra revived with "Monster Reborn" this turn, sent to the GY in the End Phase');
}

section('Spiral Spear Strike');
{
  const e = fight(['Spiral Spear Strike', 'Gaia The Fierce Knight'], [FILL], 0, ['Gaia the Dragon Champion']);
  playSpell(e, 0, 'Spiral Spear Strike');
  const g = place(e, 0, 'Gaia The Fierce Knight');
  const d = place(e, 1, FILL, 'def');
  toBattle(e);
  attack(e, g, d);
  check(lp(e, 1) === 4000 - 1100, 'Spiral Spear Strike: "Gaia The Fierce Knight" inflicts piercing damage');
  const champ = place(e, 0, 'Gaia the Dragon Champion');
  const d2 = place(e, 1, FILL, 'def');
  const hand = e.player(0).hand.length;
  attack(e, champ, d2);
  check(lp(e, 1) === 2900 - 1400 && e.player(0).hand.length === hand + 1, 'Spiral Spear Strike: "Gaia the Dragon Champion" pierces: draw 2, then discard 1');
}

section('Supply Squad');
{
  const e = duel(['Supply Squad']);
  playSpell(e, 0, 'Supply Squad');
  const a = place(e, 0, FILL);
  const b = place(e, 0, FILL);
  const hand = e.player(0).hand.length;
  kill(e, [a], 1);
  const once = e.player(0).hand.length;
  kill(e, [b], 1);
  check(once === hand + 1 && e.player(0).hand.length === once, 'Supply Squad: your monster destroyed: draw 1 (once per turn)');
}

section('Talisman of Trap Sealing');
{
  const e = duel(['Talisman of Trap Sealing', 'Sealmaster Meisei'], ['Trap Hole']);
  const t = grab(e, 0, 'Talisman of Trap Sealing');
  const no = !e.canActivateMain(0, t.uid);
  const m = place(e, 0, 'Sealmaster Meisei');
  const ts = playSpell(e, 0, 'Talisman of Trap Sealing');
  check(no && active(e, ts) && e.trapsSealed(1) && e.trapsNegated(), 'Talisman of Trap Sealing: with "Sealmaster Meisei", Traps cannot be activated and are negated');
  kill(e, [m], 1);
  check(zone(e, ts) === 'gy' && !e.trapsSealed(1), 'Talisman of Trap Sealing: destroyed when "Sealmaster Meisei" leaves the field');
}

section('Talisman of Spell Sealing');
{
  const e = duel(['Talisman of Spell Sealing', 'Sealmaster Meisei', 'Dian Keto the Cure Master']);
  const m = place(e, 0, 'Sealmaster Meisei');
  const ts = playTrap(e, 0, 'Talisman of Spell Sealing');
  const dk = grab(e, 0, 'Dian Keto the Cure Master');
  check(active(e, ts) && e.spellsSealed() && !e.canActivateMain(0, dk.uid), 'Talisman of Spell Sealing: with "Sealmaster Meisei", Spells cannot be activated');
  kill(e, [m], 1);
  check(zone(e, ts) === 'gy' && e.canActivateMain(0, dk.uid), 'Talisman of Spell Sealing: destroyed when "Sealmaster Meisei" leaves the field');
}

section('Veil of Darkness');
{
  const e = duel(['Veil of Darkness', 'Dark Magician']);
  playSpell(e, 0, 'Veil of Darkness');
  endTurn(e);
  const hand = e.player(0).hand.length;
  endTurn(e, 'yes', 'yes');
  check(inGy(e, 0, 'Dark Magician') && e.player(0).hand.length === hand + 1, 'Veil of Darkness: a DARK monster drawn in the Draw Phase is sent to the GY to draw 1 more');
}

section('Verdant Sanctuary');
{
  const e = duel(['Verdant Sanctuary', 'Big Insect', 'Flying Kamakiri #1']);
  playSpell(e, 0, 'Verdant Sanctuary');
  const b = place(e, 0, 'Big Insect');
  kill(e, [b], 1, 'yes');
  check(inHand(e, 0, 'Flying Kamakiri #1'), 'Verdant Sanctuary: an Insect destroyed: its controller adds an Insect of the same Level from the Deck');
}

section('Awakening of the Sacred Beasts');
{
  const e = duel(['Awakening of the Sacred Beasts', 'Uria, Lord of Searing Flames', 'Hamon, Lord of Striking Thunder', 'Raviel, Lord of Phantasms', 'Coffin Seller'], ['Vorse Raider', 'Cloudian - Cirrostratus']);
  e.state.fx.ignoreCond = e.player(0).deck.find((x) => x.name === 'Uria, Lord of Searing Flames')!.uid; // test setup: a Sacred Beast placed ignoring its Summoning condition
  place(e, 0, 'Uria, Lord of Searing Flames');
  const aw = playTrap(e, 0, 'Awakening of the Sacred Beasts');
  const v = place(e, 1, 'Vorse Raider');
  check(lp(e, 0) === 4000 + 1900, 'Awakening: 1 Sacred Beast: gain LP equal to the ATK of a monster the opponent Summons');
  e.state.fx.ignoreCond = e.player(0).deck.find((x) => x.name === 'Hamon, Lord of Striking Thunder')!.uid; // test setup: a Sacred Beast placed ignoring its Summoning condition
  place(e, 0, 'Hamon, Lord of Striking Thunder');
  const c = place(e, 1, 'Cloudian - Cirrostratus');
  c!.tags!.fog = 2;
  e.state.turnPlayer = 1;
  effect(e, 1, c, { pick: ['Hamon, Lord of Striking Thunder'] });
  e.state.turnPlayer = 0;
  check(e.monsters(0).length === 2 && logHas(e, "Cloudian - Cirrostratus's effect was negated"), "Awakening: 2 Sacred Beasts: the opponent's monster effects are negated");
  e.state.fx.ignoreCond = e.player(0).deck.find((x) => x.name === 'Raviel, Lord of Phantasms')!.uid; // test setup: a Sacred Beast placed ignoring its Summoning condition
  place(e, 0, 'Raviel, Lord of Phantasms');
  kill(e, [v], 0);
  check(zone(e, v) === 'removed', "Awakening: 3 Sacred Beasts: monsters sent to the opponent's GY are banished instead");
  toGy(e, 0, 'Coffin Seller');
  effect(e, 0, aw);
  check(inHand(e, 0, 'Coffin Seller'), 'Awakening: with a Level 10 monster, adds a Continuous Trap from the GY');
}

section('Battle-Scarred');
{
  const e = duel(['Battle-Scarred', 'Desrook Archfiend']);
  const d = place(e, 0, 'Desrook Archfiend');
  const bs = playTrap(e, 0, 'Battle-Scarred');
  endTurn(e);
  endTurn(e);
  check(lp(e, 0) === 3500 && lp(e, 1) === 3500, 'Battle-Scarred: the opponent pays the same Standby Phase LP as the selected Archfiend');
  kill(e, [bs], 1);
  check(zone(e, d) === 'gy', 'Battle-Scarred: when it leaves the field, the selected Archfiend is destroyed');
}

section('Chain Ignition');
{
  const e = duel(['Chain Ignition'], ['Vorse Raider', 'Axe Raider']);
  const ci = playTrap(e, 0, 'Chain Ignition');
  const v = place(e, 1, 'Vorse Raider');
  const a = place(e, 1, 'Axe Raider');
  kill(e, [v], 1, 'yes', { pick: ['Axe Raider'] });
  check(active(e, ci) && zone(e, a) === 'gy', "Chain Ignition: the opponent's monster destroyed by their own card effect: destroys a card on the field");
}

section('Coffin Seller');
{
  const e = duel(['Coffin Seller'], ['Vorse Raider']);
  playTrap(e, 0, 'Coffin Seller');
  const v = place(e, 1, 'Vorse Raider');
  kill(e, [v], 0);
  check(lp(e, 1) === 3700, "Coffin Seller: a monster sent to the opponent's GY: 300 damage");
}

section('Copy Knight');
{
  const e = duel(['Copy Knight']);
  const ck = putST(e, 0, 'Copy Knight');
  summon(e, 0, FILL, true, { respond: 'Copy Knight' }, 'yes');
  const m = e.fieldCard(ck.uid);
  check(zone(e, ck) === 'mz' && !!m && levelOf(e, m) === 4 && raceOf(e, m) === 'Warrior' && atk(e, m) === 0 && ((e.state.fx.copyKnight ?? {}) as Record<number, string>)[ck.uid] === FILL, 'Copy Knight: a Level 4 Warrior is Normal Summoned: Special Summoned with its name and Level');
}

section("Dragon's Rage");
{
  const e = fight(["Dragon's Rage", 'Koumori Dragon']);
  playTrap(e, 0, "Dragon's Rage");
  const k = place(e, 0, 'Koumori Dragon');
  const d = place(e, 1, FILL, 'def');
  toBattle(e);
  attack(e, k, d);
  check(lp(e, 1) === 4000 - 300, "Dragon's Rage: your Dragons inflict piercing damage");
}

section('Human-Wave Tactics');
{
  const e = fight(['Human-Wave Tactics', 'Petit Moth', 'Petit Moth'], ['Vorse Raider'], 1);
  e.state.turnPlayer = 0;
  playTrap(e, 0, 'Human-Wave Tactics');
  e.state.turnPlayer = 1;
  const pm = place(e, 0, 'Petit Moth');
  const v = place(e, 1, 'Vorse Raider');
  toBattle(e);
  attack(e, v, pm);
  endTurn(e);
  check(zone(e, pm) === 'gy' && !!onField(e, 0, 'Petit Moth'), 'Human-Wave Tactics: a Level 2 or lower Normal Monster destroyed by battle: one from the Deck in the End Phase');
}

section('Loop of Destruction');
{
  const e = duel(['Loop of Destruction'], ['Vorse Raider', 'Axe Raider']);
  playTrap(e, 0, 'Loop of Destruction');
  const v = place(e, 1, 'Vorse Raider');
  const a = place(e, 1, 'Axe Raider');
  kill(e, [v], 0, 'yes', { pick: ['Axe Raider'] });
  check(zone(e, a) === 'gy' && lp(e, 0) === 3500 && lp(e, 1) === 3500, 'Loop of Destruction: a monster destroyed by a card effect: destroys a monster, each player takes 500');
}

section('Machine King - 3000 B.C.');
{
  const e = duel(['Machine King - 3000 B.C.', 'Cyber Falcon']);
  const f = place(e, 0, 'Cyber Falcon');
  const mk = playTrap(e, 0, 'Machine King - 3000 B.C.', 'yes');
  const m = mk ?? onField(e, 0, 'Machine King - 3000 B.C.');
  check(!!m && zone(e, m) === 'mz' && levelOf(e, m) === 4 && raceOf(e, m) === 'Machine' && atk(e, m) === 1000, 'Machine King - 3000 B.C.: Special Summoned as a Level 4 Machine with 1000 ATK');
  check(!e.canNormalSummon(0, grab(e, 0, FILL), true), 'Machine King - 3000 B.C.: no other Summons this turn');
  effect(e, 0, m);
  check(zone(e, f) === 'gy' && atk(e, m) === 2400, 'Machine King - 3000 B.C.: Tributes a Machine to gain its ATK');
}

section('Macro Cosmos');
{
  const e = duel(['Macro Cosmos', 'Helios - The Primordial Sun']);
  playTrap(e, 0, 'Macro Cosmos', 'yes');
  const h = onField(e, 0, 'Helios - The Primordial Sun');
  const f = place(e, 0, FILL);
  kill(e, [f], 1);
  check(!!h && zone(e, f) === 'removed', 'Macro Cosmos: Special Summons Helios; cards sent to the GY are banished instead');
}

section('Summon Gate');
{
  const e = duel(['Summon Gate'], [], ['Gaia the Dragon Champion', 'Gaia the Dragon Champion', 'Gaia the Dragon Champion', 'Gaia the Dragon Champion']);
  playTrap(e, 0, 'Summon Gate');
  for (let i = 0; i < 3; i++) place(e, 0, 'Gaia the Dragon Champion');
  const fourth = e.player(0).fusion[0];
  check(e.monsters(0).length === 3 && e.summonBlocked(0, fourth, 'special', 'fusion'), 'Summon Gate: at most 3 Special Summons from the Extra Deck per turn');
}

section('Swamp Mirrorer');
{
  const e = duel(['Swamp Mirrorer']);
  const s = playTrap(e, 0, 'Swamp Mirrorer', { pick: ['Dragon'] }, { pick: ['DARK'] }, 'yes');
  const m = s ?? e.monsters(0)[0];
  check(!!m && zone(e, m) === 'mz' && raceOf(e, m) === 'Dragon' && attrOf(e, m) === 'DARK' && levelOf(e, m) === 4 && atk(e, m) === 1800, 'Swamp Mirrorer: Special Summoned as a Level 4 monster with the declared Type and Attribute');
}

// @@END@@
console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
process.exit(fails ? 1 : 0);
