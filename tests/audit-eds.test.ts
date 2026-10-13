// Audit of the Speed Duel cards whose scripts come from the EDS effect tables (src/eds/effects.ts, effects2.ts)
// rather than a Speed Duel batch file. Run: npx tsx tests/audit-eds.test.ts
// One or more targeted checks per card: its main effect really happens in a Speed Duel (and, where cheap, does not when it should not).
import { Engine } from '../src/eds/engine';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};
const FILL = 'Celtic Guardian';

// ---------- duel kit (from tests/batch-16.test.ts) ----------
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
const special = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'SPECIAL', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const flipSummon = (e: Engine, p: Pid, m: FieldCard | null, ...ans: Ans[]) => {
  e.apply({ type: 'FLIP_SUMMON', player: p, uid: m!.uid });
  return settle(e, ...ans);
};
const changePos = (e: Engine, p: Pid, m: FieldCard | null, ...ans: Ans[]) => {
  e.apply({ type: 'CHANGE_POS', player: p, uid: m!.uid });
  return settle(e, ...ans);
};
const active = (e: Engine, c: FieldCard | null) => !!c && (zone(e, c) === 'sz' || zone(e, c) === 'field') && c.faceUp && !!c.active;
const logHas = (e: Engine, text: string, since = 0) => e.state.log.slice(since).some((l) => l.text.includes(text));
const section = (s: string) => console.log(`\n--- ${s}`);
const toTurn3 = (e: Engine) => {
  endTurn(e);
  endTurn(e);
};
const hasPrompt = (e: Engine, p: Pid, name: string) => e.state.prompt?.kind === 'response' && e.state.prompt.player === p && e.state.prompt.options.some((o) => o.label.startsWith(name));
const lp = (e: Engine, p: Pid) => e.player(p).lp;
const inHand = (e: Engine, p: Pid, name: string) => e.player(p).hand.some((c) => c.name === name);
const onField = (e: Engine, p: Pid, name: string) => e.monsters(p).find((m) => m.name === name) ?? null;
/** Puts the whole hand back on the bottom of the Deck. */
const emptyHand = (e: Engine, p: Pid) => {
  const ps = e.player(p);
  ps.deck.push(...ps.hand.splice(0));
};
const canAct = (e: Engine, p: Pid, name: string) => {
  const c = grab(e, p, name);
  return e.canActivateMain(p, c.uid);
};

// ======================= Equip Spells =======================
section('7 Completed');
{
  const e = duel(['7 Completed', 'Barrel Dragon']);
  check(!canAct(e, 0, '7 Completed'), 'cannot be activated without a Machine monster');
  const m = place(e, 0, 'Barrel Dragon')!;
  playSpell(e, 0, '7 Completed', 'no');
  check(e.atkOf(m) === 2600 && e.defOf(m) === 2200 + 700, 'choosing DEF: the Machine gains 700 DEF');
}
{
  const e = duel(['7 Completed', 'Barrel Dragon']);
  const m = place(e, 0, 'Barrel Dragon')!;
  playSpell(e, 0, '7 Completed', 'yes');
  check(e.atkOf(m) === 2600 + 700 && e.defOf(m) === 2200, 'choosing ATK: the Machine gains 700 ATK');
}

section('Axe of Despair');
{
  const e = duel(['Axe of Despair', 'Petit Moth']);
  const m = place(e, 0, FILL)!;
  const axe = playSpell(e, 0, 'Axe of Despair')!;
  check(e.atkOf(m) === 1400 + 1000, 'the equipped monster gains 1000 ATK');
  const fodder = place(e, 0, 'Petit Moth')!;
  kill(e, [axe], 1, 'yes', { pick: ['Petit Moth'] });
  check(e.player(0).deck[0]?.uid === axe.uid && zone(e, fodder) === 'gy', 'sent from the field to the GY: Tribute 1 monster to put it on top of the Deck');
}

section('Cyber Shield');
{
  const e = duel(['Cyber Shield', 'Harpie Lady 1']);
  place(e, 0, FILL);
  check(!canAct(e, 0, 'Cyber Shield'), 'cannot equip a monster that is not "Harpie Lady"');
  const h = place(e, 0, 'Harpie Lady 1')!;
  const before = e.atkOf(h);
  playSpell(e, 0, 'Cyber Shield', { pick: ['Harpie Lady 1'] });
  check(e.atkOf(h) === before + 500, 'a monster treated as "Harpie Lady" gains 500 ATK');
}

const equipCase = (name: string, host: string, other: string | null, atk: number, def: number) => {
  section(name);
  const e = duel([name, host, ...(other ? [other] : [])]);
  if (other) {
    place(e, 0, other);
    check(!canAct(e, 0, name), `cannot equip ${other}`);
  }
  const m = place(e, 0, host)!;
  const a = e.atkOf(m);
  const d = e.defOf(m);
  playSpell(e, 0, name, { pick: [host] });
  check(e.atkOf(m) === a + atk && e.defOf(m) === Math.max(0, d + def), `${host} gains ${atk} ATK / ${def} DEF`);
};
equipCase('Insect Armor with Laser Cannon', 'Petit Moth', FILL, 700, 0);
equipCase('Laser Cannon Armor', 'Petit Moth', FILL, 300, 300);
equipCase('Legendary Sword', FILL, 'Petit Moth', 300, 300);
equipCase('Machine Conversion Factory', 'Barrel Dragon', FILL, 300, 300);
equipCase('Power of Kaishin', 'Penguin Soldier', FILL, 300, 300);
equipCase('Raise Body Heat', 'Two-Headed King Rex', FILL, 300, 300);
equipCase('Salamandra', 'UFO Turtle', FILL, 700, 0);
equipCase('Sword of Dark Destruction', 'Mystic Tomato', FILL, 400, -200);
equipCase('Violet Crystal', 'Armored Zombie', FILL, 300, 300);

section('Sword of Deep-Seated');
{
  const e = duel(['Sword of Deep-Seated']);
  const m = place(e, 0, FILL)!;
  const sw = playSpell(e, 0, 'Sword of Deep-Seated')!;
  check(e.atkOf(m) === 1900 && e.defOf(m) === 1700, 'the equipped monster gains 500 ATK/DEF');
  kill(e, [sw], 1);
  check(e.player(0).deck[0]?.uid === sw.uid, 'sent to the GY from the field: placed on top of the Deck');
  const c = grab(e, 0, 'Sword of Deep-Seated');
  run(e, e.discard(0, c.uid));
  check(e.player(0).deck[0]?.uid === c.uid, 'discarded from the hand: placed on top of the Deck too');
}

section("Sword of Dragon's Soul");
{
  const e = duel(["Sword of Dragon's Soul"], ['Blue-Eyes White Dragon']);
  const w = place(e, 0, FILL)!;
  playSpell(e, 0, "Sword of Dragon's Soul");
  check(e.atkOf(w) === 2100, 'the Warrior gains 700 ATK');
  const bewd = place(e, 1, 'Blue-Eyes White Dragon', 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, w, bewd);
  check(zone(e, bewd) === 'mz', 'the Dragon survives the battle itself');
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  settle(e);
  check(zone(e, bewd) === 'gy', 'it battled a Dragon: that Dragon is destroyed at the end of the Battle Phase');
}
{
  const e = duel(["Sword of Dragon's Soul"], ['Blue-Eyes White Dragon']);
  const w = place(e, 0, FILL, 'def')!;
  playSpell(e, 0, "Sword of Dragon's Soul");
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  endTurn(e);
  w.defMod = 2000;
  toBattle(e);
  attack(e, bewd, w);
  e.apply({ type: 'NEXT_PHASE', player: 1 });
  settle(e);
  check(zone(e, bewd) === 'gy', 'also when the Dragon attacked the equipped monster');
}

// ======================= Field Spells =======================
const fieldCase = (name: string, up: string[], down: string[] = []) => {
  section(name);
  const e = duel([name, ...up, ...down], ['Forest', 'Mystic Tomato']);
  const ups = up.map((n) => place(e, 0, n)!);
  const downs = down.map((n) => place(e, 0, n)!);
  const before = [...ups, ...downs].map((m) => [e.atkOf(m), e.defOf(m)]);
  const fs = playSpell(e, 0, name)!;
  check(active(e, fs) && ups.every((m, i) => e.atkOf(m) === before[i][0] + 200 && e.defOf(m) === before[i][1] + 200), `${up.join(', ')} gain 200 ATK/DEF`);
  if (downs.length) check(downs.every((m, i) => e.atkOf(m) === Math.max(0, before[ups.length + i][0] - 200) && e.defOf(m) === Math.max(0, before[ups.length + i][1] - 200)), `${down.join(', ')} lose 200 ATK/DEF`);
};
fieldCase('Forest', ['Petit Moth', 'Giant Rat', 'Mystic Tomato']);
fieldCase('Mountain', ['Baby Dragon', 'Sonic Bird', 'Sanga of the Thunder']);
fieldCase('Sogen', [FILL, 'Mother Grizzly']);
fieldCase('Umi', ['Penguin Soldier', 'Sanga of the Thunder'], ['Barrel Dragon']);
fieldCase('Wasteland', ['Two-Headed King Rex', 'Armored Zombie', 'Giant Soldier of Stone']);
fieldCase('Yami', ['Crass Clown', 'Dark Magician'], ['Senju of the Thousand Hands']);
{
  const e = duel(['Yami'], ['Forest']);
  const mine = playSpell(e, 0, 'Yami')!;
  endTurn(e);
  const theirs = playSpell(e, 1, 'Forest')!;
  check(active(e, mine) && active(e, theirs), "Speed Duel: each player keeps their own Field Spell (the opponent's does not replace it)");
}

// ======================= Ritual Spells =======================
const ritualCase = (spell: string, monster: string, tributes: string[]) => {
  section(spell);
  const e = duel([spell, monster, ...tributes]);
  emptyHand(e, 0);
  grab(e, 0, monster);
  const ts = tributes.map((n) => place(e, 0, n)!);
  playSpell(e, 0, spell, { pick: tributes });
  const m = onField(e, 0, monster);
  check(!!m && m.faceUp && ts.every((t) => zone(e, t) === 'gy'), `Ritual Summons "${monster}" by Tributing ${tributes.join(' + ')}`);
};
ritualCase('Black Illusion Ritual', 'Relinquished', ['Petit Moth']);
ritualCase('Black Luster Ritual', 'Black Luster Soldier', [FILL, FILL]);
ritualCase('Black Magic Ritual', 'Magician of Black Chaos', [FILL, FILL]);
ritualCase('Commencement Dance', 'Performance of Sword', [FILL, 'Baby Dragon']);
ritualCase('Curse of the Masked Beast', 'The Masked Beast', [FILL, FILL]);
ritualCase("Fortress Whale's Oath", 'Fortress Whale', [FILL, 'Baby Dragon']);
ritualCase('Revival of Dokurorider', 'Dokurorider', [FILL, 'Baby Dragon']);
ritualCase('War-Lion Ritual', 'Super War-Lion', [FILL, 'Baby Dragon']);
ritualCase('Zera Ritual', 'Zera the Mant', [FILL, FILL]);
{
  const e = duel(['Black Luster Ritual', 'Black Luster Soldier']);
  emptyHand(e, 0);
  grab(e, 0, 'Black Luster Soldier');
  place(e, 0, FILL);
  check(!canAct(e, 0, 'Black Luster Ritual'), 'not enough Levels (4 of 8): the Ritual Spell cannot be activated');
}

// ======================= Effect Monsters =======================
section('Banisher of the Light');
{
  const e = duel(['Banisher of the Light']);
  place(e, 0, 'Banisher of the Light');
  const m = place(e, 1, FILL)!;
  kill(e, [m]);
  check(zone(e, m) === 'removed', 'a card sent to the GY is banished instead');
}

section('Barrel Dragon');
{
  const e = duel(['Barrel Dragon'], [FILL]);
  const bd = place(e, 0, 'Barrel Dragon')!;
  const t = place(e, 1, FILL)!;
  e.roll = () => 1;
  effect(e, 0, bd);
  check(zone(e, t) === 'gy', '2+ heads of 3 coins: the target is destroyed');
  check(!e.canUseMonsterEffect(0, bd), 'once per turn');
}
{
  const e = duel(['Barrel Dragon'], [FILL]);
  const bd = place(e, 0, 'Barrel Dragon')!;
  const t = place(e, 1, FILL)!;
  e.roll = () => 2;
  effect(e, 0, bd);
  check(zone(e, t) === 'mz', 'fewer than 2 heads: nothing is destroyed');
}
{
  const e = duel(['Barrel Dragon'], ['Lord of D.', 'Baby Dragon']);
  const bd = place(e, 0, 'Barrel Dragon')!;
  place(e, 1, 'Lord of D.');
  place(e, 1, 'Baby Dragon');
  e.roll = () => 1;
  effect(e, 0, bd, { pick: ['Baby Dragon'] });
  check(zone(e, onField(e, 1, 'Baby Dragon')) === 'mz', 'it targets: a Dragon protected by Lord of D. cannot be chosen');
}

section('Big Shield Gardna');
{
  const e = duel(['Stop Defense'], ['Big Shield Gardna']);
  const g = place(e, 1, 'Big Shield Gardna', 'def', false)!;
  const sd = grab(e, 0, 'Stop Defense');
  act(e, 0, sd.uid, { respond: 'Big Shield Gardna' });
  check(g.faceUp && g.pos === 'def' && zone(e, sd) === 'gy', 'a Spell targeting it while face-down: it turns face-up Defense Position and the Spell is negated');
}
{
  const e = duel([FILL], ['Big Shield Gardna']);
  const g = place(e, 1, 'Big Shield Gardna', 'def', false)!;
  const a = place(e, 0, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, a, g);
  check(g.faceUp && g.pos === 'atk', 'attacked: changed to Attack Position at the end of the Damage Step');
}

section('Blast Sphere');
{
  const e = duel([FILL], ['Blast Sphere']);
  const bs = place(e, 1, 'Blast Sphere', 'def', false)!;
  const a = place(e, 0, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, a, bs);
  check(zone(e, bs) === 'sz' && a.equips.includes(bs.uid) && zone(e, a) === 'mz', 'attacked face-down: it equips itself to the attacker instead of battling');
  endTurn(e);
  check(zone(e, a) === 'mz', "nothing happens in its controller's own Standby Phase");
  endTurn(e);
  check(zone(e, a) === 'gy' && lp(e, 0) === 4000 - 1400, "opponent's next Standby Phase: the monster is destroyed and its ATK is dealt to the opponent");
}

section('Buster Blader');
{
  const e = duel(['Buster Blader'], ['Baby Dragon', 'Baby Dragon', 'Koumori Dragon']);
  const bb = place(e, 0, 'Buster Blader')!;
  place(e, 1, 'Baby Dragon');
  place(e, 1, 'Baby Dragon', 'def', false);
  const k = place(e, 1, 'Koumori Dragon')!;
  kill(e, [k]);
  check(e.atkOf(bb) === 2600 + 1000, 'gains 500 ATK for each face-up Dragon the opponent controls and each Dragon in their GY (not face-down ones)');
}

section('Cocoon of Evolution');
{
  const e = duel(['Cocoon of Evolution', 'Petit Moth']);
  const pm = place(e, 0, 'Petit Moth')!;
  const c = grab(e, 0, 'Cocoon of Evolution');
  effect(e, 0, c);
  check(pm.equips.includes(c.uid) && e.atkOf(pm) === 0 && e.defOf(pm) === 2000, 'equips from the hand to Petit Moth, whose ATK/DEF become 0/2000');
}

section('Crass Clown');
{
  const e = duel(['Crass Clown'], [FILL]);
  const cc = place(e, 0, 'Crass Clown', 'def')!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  changePos(e, 0, cc);
  check(zone(e, foe) === 'hand', 'changed from Defense to Attack Position: an opponent monster returns to the hand');
}
{
  const e = duel(['Crass Clown'], [FILL]);
  const cc = place(e, 0, 'Crass Clown', 'def', false)!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  flipSummon(e, 0, cc);
  check(zone(e, foe) === 'hand', 'a Flip Summon (Defense to Attack Position) triggers it too');
}
{
  const e = duel(['Crass Clown'], [FILL]);
  const cc = place(e, 0, 'Crass Clown')!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  changePos(e, 0, cc);
  check(zone(e, foe) === 'mz', 'changed from Attack to Defense Position: nothing happens');
}

section('D.D. Warrior');
{
  const e = duel(['D.D. Warrior'], ['Dark Magician']);
  const dd = place(e, 0, 'D.D. Warrior')!;
  const dm = place(e, 1, 'Dark Magician')!;
  toTurn3(e);
  toBattle(e);
  attack(e, dd, dm);
  check(zone(e, dd) === 'removed' && zone(e, dm) === 'removed', 'after damage calculation both monsters are banished (even though it lost the battle)');
}
{
  const e = duel([FILL], ['D.D. Warrior']);
  const dd = place(e, 1, 'D.D. Warrior')!;
  const a = place(e, 0, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, a, dd);
  check(zone(e, dd) === 'removed' && zone(e, a) === 'removed', 'attacked: the attacker and this card are banished');
}

section('Dark Magician Girl');
{
  const e = duel(['Dark Magician Girl', 'Dark Magician'], ['Dark Magician']);
  const g = place(e, 0, 'Dark Magician Girl')!;
  kill(e, [place(e, 0, 'Dark Magician'), place(e, 1, 'Dark Magician')]);
  check(e.atkOf(g) === 2000 + 600, 'gains 300 ATK for each "Dark Magician" in either GY');
}

section('Dream Clown');
{
  const e = duel(['Block Attack'], ['Dream Clown']);
  const mine = place(e, 0, FILL)!;
  const dc = place(e, 1, 'Dream Clown')!;
  playSpell(e, 0, 'Block Attack');
  check(dc.pos === 'def' && zone(e, mine) === 'gy', 'changed to Defense Position (here by a card effect): destroys an opponent monster');
}
{
  const e = duel(['Dream Clown'], [FILL]);
  const dc = place(e, 0, 'Dream Clown')!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  changePos(e, 0, dc);
  check(zone(e, foe) === 'gy', 'changed to Defense Position by its controller: destroys an opponent monster');
}

section('Gale Dogra');
{
  const e = duel(['Gale Dogra'], [], ['Flame Swordsman']);
  const g = place(e, 0, 'Gale Dogra')!;
  effect(e, 0, g);
  check(lp(e, 0) === 1000 && e.player(0).gy.some((c) => c.name === 'Flame Swordsman'), 'pays 3000 LP to send a monster from the Extra Deck to the GY');
}

section('Gate Guardian');
{
  const e = duel(['Gate Guardian', 'Sanga of the Thunder', 'Kazejin', 'Suijin', 'Gate Guardian']);
  const deckCopy = e.player(0).deck.find((c) => c.name === 'Gate Guardian')!;
  check(e.summonBlocked(0, deckCopy, 'special', 'deck'), 'cannot be Special Summoned from the Deck by another effect');
  for (const n of ['Sanga of the Thunder', 'Kazejin', 'Suijin']) place(e, 0, n);
  const gg = grab(e, 0, 'Gate Guardian');
  check(!e.canNormalSummon(0, gg), 'cannot be Normal Summoned');
  special(e, 0, gg);
  check(zone(e, gg) === 'mz' && e.monsters(0).length === 1, 'Special Summoned from the hand by Tributing Sanga, Kazejin and Suijin');
}

const recruiterCase = (name: string, target: string) => {
  section(name);
  const e = duel([name, target, 'Mystic Tomato'], ['Dark Magician']);
  const r = place(e, 0, name)!;
  endTurn(e);
  const dm = place(e, 1, 'Dark Magician')!;
  toBattle(e);
  attack(e, dm, r, { pick: [target] });
  const t = onField(e, 0, target);
  check(zone(e, r) === 'gy' && !!t && t.pos === 'atk' && t.faceUp, `destroyed by battle: Special Summons ${target} from the Deck in Attack Position`);
};
recruiterCase('Giant Rat', 'Petit Moth');
recruiterCase('Mother Grizzly', 'Penguin Soldier');
recruiterCase('Mystic Tomato', 'Armored Zombie');
recruiterCase('UFO Turtle', 'Flame Manipulator');
{
  const e = duel(['Giant Rat', 'Petit Moth', 'Banisher of the Light'], ['Dark Magician']);
  const r = place(e, 0, 'Giant Rat')!;
  place(e, 0, 'Banisher of the Light');
  endTurn(e);
  const dm = place(e, 1, 'Dark Magician')!;
  toBattle(e);
  attack(e, dm, r);
  check(zone(e, r) === 'removed' && !onField(e, 0, 'Petit Moth'), 'banished instead of sent to the GY: no Special Summon');
}

const subCase = (name: string) => {
  section(name);
  const e = duel([name, 'Masaki the Legendary Swordsman', 'Polymerization'], [], ['Flame Swordsman']);
  emptyHand(e, 0);
  grab(e, 0, name);
  grab(e, 0, 'Masaki the Legendary Swordsman');
  playSpell(e, 0, 'Polymerization');
  check(!!onField(e, 0, 'Flame Swordsman'), 'substitutes for a Fusion Material (Flame Manipulator) to Fusion Summon Flame Swordsman');
};
subCase('Goddess with the Third Eye');
subCase('Versago the Destroyer');

section('Harpie Lady Sisters / Elegant Egotist');
{
  const e = duel(['Elegant Egotist', 'Harpie Lady Sisters', 'Harpie Lady 1']);
  const sis = e.player(0).deck.find((c) => c.name === 'Harpie Lady Sisters')!;
  check(e.summonBlocked(0, sis, 'special', 'deck'), 'Harpie Lady Sisters: cannot be Special Summoned except with "Elegant Egotist"');
  check(!canAct(e, 0, 'Elegant Egotist'), 'Elegant Egotist: needs a "Harpie Lady" on the field');
  place(e, 0, 'Harpie Lady 1');
  playSpell(e, 0, 'Elegant Egotist', { pick: ['Harpie Lady Sisters'] });
  check(zone(e, sis) === 'mz', 'Elegant Egotist (a card treated as "Harpie Lady" on the field) Special Summons Harpie Lady Sisters from the Deck');
  kill(e, [e.fieldCard(sis.uid)]);
  check(!e.summonBlocked(0, sis, 'special', 'gy'), 'Harpie Lady Sisters: once properly Summoned it can be revived');
  check(!e.canNormalSummon(0, grab(e, 0, 'Harpie Lady Sisters')), 'Harpie Lady Sisters cannot be Normal Summoned');
}

section("Harpie's Pet Dragon");
{
  const e = duel(["Harpie's Pet Dragon", 'Harpie Lady 1']);
  const d = place(e, 0, "Harpie's Pet Dragon")!;
  place(e, 0, 'Harpie Lady 1');
  check(e.defOf(d) === 2500 + 300, 'gains 300 DEF (and ATK) for each "Harpie Lady" on the field (Harpie Lady 1 counts)');
}

section('Insect Queen');
{
  const e = duel(['Insect Queen', 'Petit Moth'], [FILL]);
  const q = place(e, 0, 'Insect Queen')!;
  check(e.atkOf(q) === 2200 + 200, 'gains 200 ATK for each Insect on the field (itself too)');
  toTurn3(e);
  toBattle(e);
  check(!e.canAttackWith(0, q), 'cannot attack without a monster to Tribute');
  const pm = place(e, 0, 'Petit Moth')!;
  const foe = place(e, 1, FILL)!;
  attack(e, q, foe);
  check(zone(e, pm) === 'gy' && zone(e, foe) === 'gy', 'attacking Tributes 1 monster');
  endTurn(e);
  const tok = onField(e, 0, 'Insect Monster Token');
  check(!!tok && e.atkOf(tok) === 100 && e.defOf(tok) === 100 && e.raceOf(tok) === 'Insect', 'destroyed a monster this turn: an Insect Monster Token (100/100) in the End Phase');
}

section('Invader of the Throne');
{
  const e = duel(['Invader of the Throne'], [FILL]);
  const inv = place(e, 0, 'Invader of the Throne', 'def', false)!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  flipSummon(e, 0, inv);
  check(e.controller(foe.uid) === 0 && e.controller(inv.uid) === 1, 'FLIP: switches control with an opponent monster');
}

section('Jinzo');
{
  const e = duel(['Jinzo', 'Aqua Chorus'], ['Waboku']);
  const a = place(e, 0, FILL)!;
  place(e, 0, FILL);
  playTrap(e, 0, 'Aqua Chorus');
  check(e.atkOf(a) === 1900, '(Aqua Chorus applies before Jinzo)');
  const wab = putST(e, 1, 'Waboku');
  const j = place(e, 0, 'Jinzo')!;
  check(e.atkOf(a) === 1400, 'negates Trap effects on the field');
  endTurn(e);
  check(!e.canActivateMain(1, wab.uid), 'Trap Cards cannot be activated');
  kill(e, [j]);
  check(e.atkOf(a) === 1900, 'Jinzo gone: the Trap applies again');
}

section('Jirai Gumo');
{
  const e = duel(['Jirai Gumo']);
  const j = place(e, 0, 'Jirai Gumo')!;
  toTurn3(e);
  toBattle(e);
  e.roll = () => 2;
  attack(e, j, null, 'yes');
  check(lp(e, 0) === 2000 && lp(e, 1) === 4000 - 2200, 'declares an attack: called wrong, half the LP is lost (the attack goes on)');
}
{
  const e = duel(['Jirai Gumo']);
  const j = place(e, 0, 'Jirai Gumo')!;
  toTurn3(e);
  toBattle(e);
  e.roll = () => 1;
  attack(e, j, null, 'yes');
  check(lp(e, 0) === 4000, 'called right: no LP lost');
}

const guardianCase = (name: string, atk: number) => {
  section(name);
  const e = duel(['Dark Magician'], [name]);
  const g = place(e, 1, name)!;
  const dm = place(e, 0, 'Dark Magician')!;
  toTurn3(e);
  toBattle(e);
  attack(e, dm, g, 'yes');
  check(zone(e, dm) === 'gy' && zone(e, g) === 'mz' && lp(e, 0) === 4000 - atk, "attacked in the opponent's turn: the attacker's ATK becomes 0 for that damage calculation");
  check(g.tags?.used === 1, 'only once while face-up');
};
guardianCase('Kazejin', 2400);
guardianCase('Sanga of the Thunder', 2600);
guardianCase('Suijin', 2500);

section('Kuriboh');
{
  const e = duel([FILL], ['Kuriboh']);
  const k = grab(e, 1, 'Kuriboh');
  const a = place(e, 0, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, a, null, 'yes');
  check(lp(e, 1) === 4000 && zone(e, k) === 'gy', 'discarded during damage calculation: no battle damage');
}

section('Lord of D.');
{
  const e = duel(['Lord of D.', 'Baby Dragon']);
  const d = place(e, 0, 'Baby Dragon')!;
  check(!e.untargetable(d), '(a Dragon can be targeted)');
  const l = place(e, 0, 'Lord of D.')!;
  check(e.untargetable(d) && !e.untargetable(l), 'Dragons on the field cannot be targeted by card effects');
}

const flipToHand = (name: string, card: string) => {
  section(name);
  const e = duel([name, card]);
  const m = place(e, 0, name, 'def', false)!;
  const c = grab(e, 0, card);
  run(e, e.discard(0, c.uid));
  toTurn3(e);
  flipSummon(e, 0, m);
  check(zone(e, c) === 'hand', `FLIP: ${card} returns from the GY to the hand`);
};
flipToHand('Magician of Faith', 'Pot of Greed');
flipToHand('Mask of Darkness', 'Waboku');

section('Maha Vailo');
{
  const e = duel(['Maha Vailo', 'Axe of Despair']);
  const m = place(e, 0, 'Maha Vailo')!;
  playSpell(e, 0, 'Axe of Despair');
  check(e.atkOf(m) === 1550 + 1000 + 500, 'gains 500 ATK for each Equip Card equipped to it');
}

section('Man-Eater Bug');
{
  const e = duel(['Man-Eater Bug'], [FILL]);
  const mb = place(e, 0, 'Man-Eater Bug', 'def', false)!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  flipSummon(e, 0, mb, { pick: [FILL] });
  check(zone(e, foe) === 'gy', 'FLIP: destroys the targeted monster');
}

const toonCase = (name: string, tributes: number, atk: number) => {
  section(name);
  const e = duel([name, 'Toon World', name]);
  const c = grab(e, 0, name);
  check(!e.canSpecialProc(0, c) && !e.canNormalSummon(0, c), 'needs "Toon World"; cannot be Normal Summoned');
  const tw = playSpell(e, 0, 'Toon World')!;
  check(lp(e, 0) === 3000, 'Toon World costs 1000 LP');
  for (let i = 0; i < tributes; i++) place(e, 0, FILL);
  special(e, 0, c);
  const m = e.fieldCard(c.uid);
  check(!!m && e.monsters(0).length === 1, `Special Summoned from the hand by Tributing ${tributes}`);
  check(!!e.effectOn(m!)?.cannotAttack?.(e, m!, 0), 'cannot attack the turn it is Special Summoned');
  const deckCopy = e.player(0).deck.find((x) => x.name === name)!;
  check(e.summonBlocked(0, deckCopy, 'special', 'deck'), 'cannot be Special Summoned from the Deck');
  toTurn3(e);
  toBattle(e);
  const before = lp(e, 1);
  attack(e, m, null);
  check(lp(e, 0) === 2500 && lp(e, 1) === before - atk, 'pays 500 LP to attack, and attacks directly');
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  settle(e);
  kill(e, [tw], 1);
  check(zone(e, m) === 'gy', 'Toon World destroyed: it is destroyed too');
};
toonCase('Manga Ryu-Ran', 2, 2200);
toonCase('Toon Mermaid', 0, 1400);
toonCase('Toon Summoned Skull', 1, 2500);
{
  const e = duel(['Toon World', 'Toon Mermaid'], ['Toon Mermaid', 'Toon World', FILL]);
  playSpell(e, 1, 'Toon World');
  const theirs = grab(e, 1, 'Toon Mermaid');
  run(e, e.specialSummon(theirs.uid, 1, 'atk'));
  const foe = place(e, 1, FILL)!;
  playSpell(e, 0, 'Toon World');
  const tm = grab(e, 0, 'Toon Mermaid');
  special(e, 0, tm);
  const m = e.fieldCard(tm.uid)!;
  check(!e.canAttackDirectly(m) && e.legalTargets(0, m).every((t) => t.uid !== foe.uid), 'the opponent controls a Toon: it must attack that Toon');
}

section('Muka Muka');
{
  const e = duel(['Muka Muka']);
  const m = place(e, 0, 'Muka Muka')!;
  const n = e.player(0).hand.length;
  check(e.atkOf(m) === 600 + 300 * n && e.defOf(m) === 300 + 300 * n, 'gains 300 ATK/DEF for each card in your hand');
}

section('Obelisk the Tormentor');
{
  const e = duel(['Obelisk the Tormentor'], [FILL, FILL]);
  place(e, 0, FILL);
  place(e, 0, FILL);
  const card = grab(e, 0, 'Obelisk the Tormentor');
  check(!e.canNormalSummon(0, card), 'needs 3 Tributes (2 are not enough)');
  place(e, 0, FILL);
  check(!e.canNormalSummon(0, card, false), 'cannot be Normal Set');
  const ob = summon(e, 0, 'Obelisk the Tormentor');
  check(!!ob && ob.faceUp && e.monsters(0).length === 1, 'Normal Summoned with 3 Tributes');
  check(e.untargetable(ob!), 'cannot be targeted by card effects');
  place(e, 0, FILL);
  place(e, 0, FILL);
  place(e, 1, FILL);
  place(e, 1, FILL);
  effect(e, 0, ob);
  check(e.monsters(1).length === 0 && e.monsters(0).length === 1, "Tributes 2 monsters: destroys all of the opponent's monsters");
  check(ob!.tags?.noAttackTurn === e.state.turn, 'it cannot attack the turn this effect is used');
}
{
  const e = duel(['Obelisk the Tormentor']);
  const ob = place(e, 0, 'Obelisk the Tormentor')!;
  endTurn(e);
  check(zone(e, ob) === 'gy', 'Special Summoned: sent to the GY during the End Phase');
}

section('Parasite Paracide');
{
  const e = duel(['Parasite Paracide'], [FILL]);
  const pp = place(e, 0, 'Parasite Paracide', 'def', false)!;
  toTurn3(e);
  flipSummon(e, 0, pp);
  const f = e.find(pp.uid);
  check(f?.loc.zone === 'deck' && f.loc.player === 1, "FLIP: shuffled into the opponent's Deck");
  const d = e.player(1).deck;
  d.unshift(...d.splice(d.findIndex((c) => c.uid === pp.uid), 1));
  e.draw(1, 1);
  const m = e.fieldCard(pp.uid);
  check(!!m && e.controller(pp.uid) === 1 && m.faceUp && m.pos === 'def' && lp(e, 1) === 3000, 'drawn: Special Summoned to their field in face-up Defense Position, 1000 damage');
  const foe = place(e, 1, FILL)!;
  check(e.raceOf(foe) === 'Insect', 'their monsters become Insect');
}

section('Penguin Soldier');
{
  const e = duel(['Penguin Soldier'], [FILL, FILL]);
  const ps = place(e, 0, 'Penguin Soldier', 'def', false)!;
  const a = place(e, 1, FILL)!;
  const b = place(e, 1, FILL)!;
  toTurn3(e);
  flipSummon(e, 0, ps, { pick: [FILL, FILL] });
  check(zone(e, a) === 'hand' && zone(e, b) === 'hand', 'FLIP: returns up to 2 monsters to the hand');
}

section('Perfectly Ultimate Great Moth');
{
  const e = duel(['Perfectly Ultimate Great Moth', 'Petit Moth', 'Cocoon of Evolution', 'Perfectly Ultimate Great Moth']);
  const deckCopy = e.player(0).deck.find((c) => c.name === 'Perfectly Ultimate Great Moth')!;
  check(e.summonBlocked(0, deckCopy, 'special', 'deck'), 'cannot be Special Summoned from the Deck');
  const pm = place(e, 0, 'Petit Moth')!;
  const c = grab(e, 0, 'Cocoon of Evolution');
  effect(e, 0, c);
  const moth = grab(e, 0, 'Perfectly Ultimate Great Moth');
  check(!e.canSpecialProc(0, moth), 'not before the 6th turn');
  toTurn3(e);
  check(e.fieldCard(c.uid)?.tags?.age === 1, 'the Cocoon counts your turns');
  e.fieldCard(c.uid)!.tags!.age = 6;
  special(e, 0, moth);
  check(zone(e, moth) === 'mz' && zone(e, pm) === 'gy', 'Special Summoned by Tributing Petit Moth on the 6th turn with the Cocoon');
}

section('Relinquished');
{
  const e = duel(['Black Illusion Ritual', 'Relinquished', 'Petit Moth'], ['Dark Magician', 'Dark Magician']);
  emptyHand(e, 0);
  grab(e, 0, 'Relinquished');
  place(e, 0, 'Petit Moth');
  playSpell(e, 0, 'Black Illusion Ritual', { pick: ['Petit Moth'] });
  const r = onField(e, 0, 'Relinquished')!;
  const dm = place(e, 1, 'Dark Magician')!;
  effect(e, 0, r);
  check(zone(e, dm) === 'sz' && r.equips.includes(dm.uid) && e.atkOf(r) === 2500 && e.defOf(r) === 2100, 'equips an opponent monster to itself; its ATK/DEF become that monster\'s');
  endTurn(e);
  const a = place(e, 1, 'Dark Magician')!;
  a.atkMod = 500;
  toBattle(e);
  attack(e, a, r);
  check(zone(e, r) === 'mz' && zone(e, dm) === 'gy' && lp(e, 0) === 3500 && lp(e, 1) === 3500, 'would be destroyed by battle: the equipped monster is destroyed instead, and the battle damage is dealt to the opponent too');
}

const searchCase = (name: string, target: string) => {
  section(name);
  const e = duel([name, target]);
  summon(e, 0, name);
  check(inHand(e, 0, target), `Normal Summoned: adds ${target} from the Deck to the hand`);
  const e2 = duel([name, target]);
  place(e2, 0, name);
  check(!inHand(e2, 0, target), 'Special Summoned: no search');
};
searchCase('Senju of the Thousand Hands', 'Relinquished');
searchCase('Sonic Bird', 'Black Illusion Ritual');

section('Shadow Ghoul');
{
  const e = duel(['Shadow Ghoul']);
  const g = place(e, 0, 'Shadow Ghoul')!;
  kill(e, [place(e, 0, FILL), place(e, 0, FILL)]);
  check(e.atkOf(g) === 1600 + 200, 'gains 100 ATK for each monster in your GY');
}

section('Sinister Serpent');
{
  const e = duel(['Sinister Serpent']);
  const s = place(e, 0, 'Sinister Serpent')!;
  kill(e, [s]);
  endTurn(e);
  endTurn(e, 'yes');
  check(zone(e, s) === 'hand', 'your Standby Phase, in the GY: added to the hand');
  run(e, e.discard(0, s.uid));
  endTurn(e);
  check(zone(e, s) === 'gy', '(still in the GY after your own End Phase)');
  endTurn(e);
  check(zone(e, s) === 'removed', "a Sinister Serpent in the GY is banished during the opponent's next End Phase");
}

section('Skelengel');
{
  const e = duel(['Skelengel']);
  const s = place(e, 0, 'Skelengel', 'def', false)!;
  toTurn3(e);
  const n = e.player(0).hand.length;
  flipSummon(e, 0, s);
  check(e.player(0).hand.length === n + 1, 'FLIP: draw 1 card');
}

section('Slifer the Sky Dragon');
{
  const e = duel(['Slifer the Sky Dragon'], [FILL]);
  for (let i = 0; i < 3; i++) place(e, 0, FILL);
  const sl = summon(e, 0, 'Slifer the Sky Dragon')!;
  check(!!sl && e.atkOf(sl) === 1000 * e.player(0).hand.length && e.defOf(sl) === e.atkOf(sl), 'Normal Summoned with 3 Tributes; gains 1000 ATK/DEF for each card in your hand');
  endTurn(e);
  const foe = summon(e, 1, FILL);
  check(!foe && e.player(1).gy.some((c) => c.name === FILL), 'a monster Summoned in Attack Position to the opponent field loses 2000 ATK; at 0 it is destroyed');
}
{
  const e = duel(['Slifer the Sky Dragon'], ['Dark Magician']);
  place(e, 0, 'Slifer the Sky Dragon');
  const dm = place(e, 1, 'Dark Magician')!;
  check(e.atkOf(dm) === 500, 'a Special Summoned monster loses 2000 ATK too');
  endTurn(e);
  check(!onField(e, 0, 'Slifer the Sky Dragon'), 'Special Summoned: sent to the GY in the End Phase');
}

section('The Winged Dragon of Ra');
{
  const e = duel(['The Winged Dragon of Ra']);
  for (let i = 0; i < 3; i++) place(e, 0, FILL);
  const ra = summon(e, 0, 'The Winged Dragon of Ra', true, 'yes')!;
  check(!!ra && lp(e, 0) === 100 && e.atkOf(ra) === 3900 && e.defOf(ra) === 3900, 'Normal Summoned: pays LP down to 100 and gains that much ATK/DEF');
  kill(e, [ra]);
  check(e.summonBlocked(0, ra, 'special', 'gy'), 'cannot be Special Summoned');
}
{
  const e = duel(['The Winged Dragon of Ra'], ['Petit Moth']);
  for (let i = 0; i < 3; i++) place(e, 0, FILL);
  const ra = summon(e, 0, 'The Winged Dragon of Ra', true, 'no')!;
  const foe = place(e, 1, 'Petit Moth')!;
  effect(e, 0, ra, { pick: ['Petit Moth'] });
  check(lp(e, 0) === 3000 && zone(e, foe) === 'gy', 'pays 1000 LP to destroy a target');
}

section('Tainted Wisdom');
{
  const e = duel(['Block Attack'], ['Tainted Wisdom']);
  place(e, 1, 'Tainted Wisdom');
  const n = e.state.log.length;
  playSpell(e, 0, 'Block Attack');
  check(logHas(e, 'Tainted Wisdom shuffles', n), 'changed from Attack to face-up Defense Position: shuffles its Deck');
}

section('The Stern Mystic');
{
  const e = duel(['The Stern Mystic'], [FILL]);
  const sm = place(e, 0, 'The Stern Mystic', 'def', false)!;
  const foe = place(e, 1, FILL, 'def', false)!;
  toTurn3(e);
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: sm.uid });
  const pr = e.state.prompt;
  check(pr?.kind === 'select' && pr.title.includes('reveals') && pr.options.some((o) => o.uid === foe.uid), 'FLIP: reveals all face-down cards');
  settle(e);
  check(!foe.faceUp, 'then they return to their original positions');
}

section('Time Wizard');
{
  const e = duel(['Time Wizard'], [FILL, FILL]);
  const tw = place(e, 0, 'Time Wizard')!;
  place(e, 1, FILL);
  place(e, 1, FILL);
  e.roll = () => 1;
  effect(e, 0, tw, 'yes');
  check(e.monsters(1).length === 0 && zone(e, tw) === 'mz', "called right: destroys all of the opponent's monsters");
}
{
  const e = duel(['Time Wizard'], [FILL]);
  const tw = place(e, 0, 'Time Wizard')!;
  place(e, 0, FILL);
  e.roll = () => 2;
  effect(e, 0, tw, 'yes');
  check(e.monsters(0).length === 0 && lp(e, 0) === 4000 - (500 + 1400) / 2, 'called wrong: your monsters are destroyed and you take half their ATK');
}

section('Valkyrion the Magna Warrior');
{
  const e = duel(['Valkyrion the Magna Warrior', 'Alpha The Magnet Warrior', 'Beta The Magnet Warrior', 'Gamma the Magnet Warrior']);
  place(e, 0, 'Alpha The Magnet Warrior');
  place(e, 0, 'Beta The Magnet Warrior');
  grab(e, 0, 'Gamma the Magnet Warrior');
  const v = grab(e, 0, 'Valkyrion the Magna Warrior');
  special(e, 0, v);
  check(zone(e, v) === 'mz' && e.monsters(0).length === 1, 'Special Summoned by Tributing Alpha, Beta and Gamma from the hand and field');
  effect(e, 0, e.fieldCard(v.uid));
  check(zone(e, v) === 'gy' && e.monsters(0).length === 3, 'Tributes itself to Special Summon Alpha, Beta and Gamma from the GY');
}

section('Wall of Illusion');
{
  const e = duel([FILL], ['Wall of Illusion']);
  const w = place(e, 1, 'Wall of Illusion', 'def')!;
  const a = place(e, 0, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, a, w);
  check(zone(e, a) === 'hand' && zone(e, w) === 'mz', 'attacked: after damage calculation the attacker returns to the hand');
}

// ======================= Normal / Quick-Play Spells =======================
const wipeCase = (spell: string, victim: string) => {
  section(spell);
  const e = duel([spell, victim], [victim, 'Petit Moth', 'Baby Dragon']);
  const up = place(e, 0, victim)!;
  const down = place(e, 1, victim, 'def', false)!;
  const other = place(e, 1, victim === 'Petit Moth' ? 'Baby Dragon' : 'Petit Moth')!;
  playSpell(e, 0, spell);
  check(zone(e, up) === 'gy', `destroys a face-up ${victim}`);
  check(zone(e, down) === 'mz' && zone(e, other) === 'mz', 'face-down monsters and other Types stay');
};
wipeCase('Acid Rain', 'Barrel Dragon');
wipeCase('Eradicating Aerosol', 'Petit Moth');
wipeCase('Last Day of Witch', 'Dark Magician');
wipeCase('Warrior Elimination', FILL);

section('Eternal Rest');
{
  const e = duel(['Eternal Rest', 'Legendary Sword'], ['Petit Moth']);
  const m = place(e, 0, FILL)!;
  playSpell(e, 0, 'Legendary Sword');
  const moth = place(e, 1, 'Petit Moth')!;
  check(m.equips.length === 1, '(the Warrior is equipped)');
  playSpell(e, 0, 'Eternal Rest');
  check(zone(e, m) === 'gy' && zone(e, moth) === 'mz', 'destroys monsters equipped with Equip Cards only');
}

section('Block Attack');
{
  const e = duel(['Block Attack']);
  const m = place(e, 1, FILL)!;
  playSpell(e, 0, 'Block Attack');
  check(m.pos === 'def' && m.faceUp, "the opponent's Attack Position monster becomes face-up Defense Position");
}

section('De-Spell');
{
  const e = duel(['De-Spell'], ['Waboku']);
  const t = putST(e, 1, 'Waboku');
  playSpell(e, 0, 'De-Spell');
  check(zone(e, t) === 'sz', 'a Set Trap is only revealed (not destroyed)');
}
{
  const e = duel(['De-Spell'], ['Pot of Greed']);
  const t = putST(e, 1, 'Pot of Greed');
  playSpell(e, 0, 'De-Spell');
  check(zone(e, t) === 'gy', 'a Set Spell is destroyed');
}

section('Exchange');
{
  const e = duel(['Exchange', 'Pot of Greed'], ['Waboku']);
  emptyHand(e, 0);
  emptyHand(e, 1);
  grab(e, 0, 'Pot of Greed');
  grab(e, 1, 'Waboku');
  playSpell(e, 0, 'Exchange');
  check(inHand(e, 0, 'Waboku') && inHand(e, 1, 'Pot of Greed'), 'each player adds 1 card from the other hand');
}

section('Fissure');
{
  const e = duel(['Fissure'], ['Petit Moth']);
  const a = place(e, 1, FILL)!;
  const b = place(e, 1, 'Petit Moth')!;
  playSpell(e, 0, 'Fissure');
  check(zone(e, b) === 'gy' && zone(e, a) === 'mz', "destroys the opponent's face-up monster with the lowest ATK");
}
{
  const e = duel(['Fissure']);
  place(e, 1, FILL);
  place(e, 1, FILL);
  e.apply({ type: 'ACTIVATE', player: 0, uid: grab(e, 0, 'Fissure').uid, zone: 0 });
  let tie = false;
  for (let i = 0; i < 10 && e.state.prompt; i++) {
    if (e.state.prompt.kind === 'select' && e.state.prompt.title.includes('tied')) tie = true;
    settle(e);
  }
  check(tie && e.monsters(1).length === 1, 'tied: you choose which one is destroyed');
}

section('Fusion Sage');
{
  const e = duel(['Fusion Sage', 'Polymerization']);
  playSpell(e, 0, 'Fusion Sage');
  check(inHand(e, 0, 'Polymerization'), 'adds Polymerization from the Deck to the hand');
}

section('Graceful Dice');
{
  const e = duel(['Graceful Dice']);
  const m = place(e, 0, FILL)!;
  const foe = place(e, 1, FILL)!;
  playSpell(e, 0, 'Graceful Dice');
  const d = e.atkOf(m) - 1400;
  check(d >= 100 && d <= 600 && d % 100 === 0 && e.defOf(m) === 1200 + d && e.atkOf(foe) === 1400, 'your monsters gain ATK/DEF equal to the die x 100');
}

section('Monster Reborn');
{
  const e = duel(['Monster Reborn']);
  const m = place(e, 1, FILL)!;
  kill(e, [m]);
  playSpell(e, 0, 'Monster Reborn', 'yes');
  check(zone(e, m) === 'mz' && e.controller(m.uid) === 0, "Special Summons a monster from the opponent's GY to your field");
}
{
  const e = duel(['Monster Reborn'], [], [], ['Flame Swordsman']);
  const f = place(e, 1, 'Flame Swordsman')!;
  kill(e, [f]);
  check(!canAct(e, 0, 'Monster Reborn'), 'a Fusion Monster that was not properly Summoned cannot be revived');
}

section('Mystical Space Typhoon');
{
  const e = duel(['Mystical Space Typhoon'], ['Waboku']);
  const t = putST(e, 1, 'Waboku');
  playSpell(e, 0, 'Mystical Space Typhoon');
  check(zone(e, t) === 'gy', 'destroys a Spell/Trap on the field');
}

section('Nobleman of Crossout');
{
  const e = duel(['Nobleman of Crossout'], ['Man-Eater Bug', 'Man-Eater Bug']);
  const m = place(e, 1, 'Man-Eater Bug', 'def', false)!;
  playSpell(e, 0, 'Nobleman of Crossout');
  check(zone(e, m) === 'removed', 'destroys and banishes the face-down target');
  check(!e.player(1).deck.some((c) => c.name === 'Man-Eater Bug'), "a Flip monster: the copies in the Deck are banished too");
}
{
  const e = duel(['Nobleman of Crossout']);
  place(e, 1, FILL);
  check(!canAct(e, 0, 'Nobleman of Crossout'), 'needs a face-down monster');
}

section('Nobleman of Extermination');
{
  const e = duel(['Nobleman of Extermination'], ['Waboku', 'Waboku']);
  const t = putST(e, 1, 'Waboku');
  playSpell(e, 0, 'Nobleman of Extermination');
  check(zone(e, t) === 'removed' && !e.player(1).deck.some((c) => c.name === 'Waboku'), 'destroys and banishes a Set Trap, and the copies in the Deck');
}

section('Polymerization');
{
  const e = duel(['Polymerization', 'Flame Manipulator', 'Masaki the Legendary Swordsman'], [], ['Flame Swordsman']);
  emptyHand(e, 0);
  const a = grab(e, 0, 'Flame Manipulator');
  const b = grab(e, 0, 'Masaki the Legendary Swordsman');
  playSpell(e, 0, 'Polymerization');
  check(!!onField(e, 0, 'Flame Swordsman') && zone(e, a) === 'gy' && zone(e, b) === 'gy', 'Fusion Summons by sending the materials from the hand to the GY');
}

section('Premature Burial');
{
  const e = duel(['Premature Burial', 'Petit Moth']);
  const m = place(e, 0, 'Petit Moth')!;
  kill(e, [m]);
  const pb = playSpell(e, 0, 'Premature Burial')!;
  check(lp(e, 0) === 3200 && zone(e, m) === 'mz' && e.fieldCard(m.uid)?.pos === 'atk' && e.fieldCard(m.uid)!.equips.includes(pb.uid), 'pays 800 LP and Special Summons the target in Attack Position, equipped with this card');
  kill(e, [pb], 1);
  check(zone(e, m) === 'gy', 'this card destroyed: the monster is destroyed');
}

section('Riryoku');
{
  const e = duel(['Riryoku'], ['Barrel Dragon']);
  const m = place(e, 0, FILL)!;
  const b = place(e, 1, 'Barrel Dragon')!;
  playSpell(e, 0, 'Riryoku', { pick: ['Barrel Dragon', FILL] });
  check(e.atkOf(b) === 1300 && e.atkOf(m) === 1400 + 1300, 'halves one monster and adds the lost ATK to the other');
}

section("Sebek's Blessing");
{
  const e = duel(["Sebek's Blessing"]);
  toTurn3(e);
  const m = place(e, 0, FILL)!;
  putST(e, 0, "Sebek's Blessing");
  toBattle(e);
  attack(e, m, null, { respond: "Sebek's Blessing" });
  check(lp(e, 1) === 2600 && lp(e, 0) === 5400, 'direct attack damage: gain that much LP');
}

section('Share the Pain');
{
  const e = duel(['Share the Pain'], ['Petit Moth']);
  const m = place(e, 0, FILL)!;
  const t = place(e, 1, 'Petit Moth')!;
  playSpell(e, 0, 'Share the Pain');
  check(zone(e, m) === 'gy' && zone(e, t) === 'gy', 'you Tribute 1 monster, then the opponent Tributes 1');
}

section('Shield & Sword');
{
  const e = duel(['Shield & Sword', 'Barrel Dragon']);
  const m = place(e, 0, FILL)!;
  playSpell(e, 0, 'Shield & Sword');
  const later = place(e, 0, 'Barrel Dragon')!;
  check(e.atkOf(m) === 1200 && e.defOf(m) === 1400, 'switches the original ATK and DEF of face-up monsters');
  check(e.atkOf(later) === 2600, 'a monster Summoned afterwards keeps its stats');
  endTurn(e);
  check(e.atkOf(m) === 1400, 'until the end of the turn');
}

section('Soul Release');
{
  const e = duel(['Soul Release']);
  const m = place(e, 1, FILL)!;
  kill(e, [m]);
  playSpell(e, 0, 'Soul Release');
  check(zone(e, m) === 'removed', 'banishes cards in a GY');
}

section('The Flute of Summoning Dragon');
{
  const e = duel(['The Flute of Summoning Dragon', 'Lord of D.', 'Baby Dragon']);
  check(!canAct(e, 0, 'The Flute of Summoning Dragon'), 'needs "Lord of D." on the field');
  place(e, 0, 'Lord of D.');
  grab(e, 0, 'Baby Dragon');
  playSpell(e, 0, 'The Flute of Summoning Dragon');
  check(!!onField(e, 0, 'Baby Dragon'), 'Special Summons a Dragon from the hand');
}

section('The Shallow Grave');
{
  const e = duel(['The Shallow Grave', 'Petit Moth']);
  const a = place(e, 0, 'Petit Moth')!;
  const b = place(e, 1, FILL)!;
  kill(e, [a, b]);
  playSpell(e, 0, 'The Shallow Grave');
  const fa = e.fieldCard(a.uid);
  const fb = e.fieldCard(b.uid);
  check(!!fa && !!fb && !fa.faceUp && fa.pos === 'def' && !fb.faceUp && e.controller(b.uid) === 1, 'each player Sets a monster from their own GY');
}

section('Tribute to the Doomed');
{
  const e = duel(['Tribute to the Doomed'], ['Petit Moth']);
  const t = place(e, 1, 'Petit Moth')!;
  const n = e.player(0).gy.length;
  playSpell(e, 0, 'Tribute to the Doomed');
  check(zone(e, t) === 'gy' && e.player(0).gy.length === n + 2, 'discard 1 card: destroy the target');
}

// ======================= Traps =======================
section('Acid Trap Hole');
{
  const e = duel(['Acid Trap Hole'], ['Petit Moth']);
  const m = place(e, 1, FILL, 'def', false)!;
  playTrap(e, 0, 'Acid Trap Hole');
  check(zone(e, m) === 'gy', 'flips the face-down monster; DEF 2000 or less: destroyed');
}
{
  const e = duel(['Acid Trap Hole'], ['Barrel Dragon']);
  const m = place(e, 1, 'Barrel Dragon', 'def', false)!;
  playTrap(e, 0, 'Acid Trap Hole');
  check(zone(e, m) === 'mz' && !m.faceUp, 'DEF more than 2000: returned face-down');
}
{
  const e = duel(['Acid Trap Hole'], ['Man-Eater Bug']);
  const own = place(e, 0, FILL)!;
  const m = place(e, 1, 'Man-Eater Bug', 'def', false)!;
  playTrap(e, 0, 'Acid Trap Hole');
  check(zone(e, m) === 'gy' && zone(e, own) === 'gy', 'flipping it face-up activates its FLIP effect');
}

section('Aqua Chorus');
{
  const e = duel(['Aqua Chorus', 'Petit Moth']);
  const a = place(e, 0, FILL)!;
  const b = place(e, 0, FILL)!;
  const c = place(e, 0, 'Petit Moth')!;
  playTrap(e, 0, 'Aqua Chorus');
  check(e.atkOf(a) === 1900 && e.defOf(b) === 1700 && e.atkOf(c) === 300, 'monsters sharing a name gain 500 ATK/DEF (others do not)');
}

section('DNA Surgery');
{
  const e = duel(['DNA Surgery']);
  const m = place(e, 0, FILL)!;
  playTrap(e, 0, 'DNA Surgery', { pick: ['Dragon'] });
  check(e.raceOf(m) === 'Dragon', 'face-up monsters become the declared Type');
}

section('Dust Tornado');
{
  const e = duel(['Dust Tornado', 'Pot of Greed'], ['Waboku']);
  const t = putST(e, 1, 'Waboku');
  grab(e, 0, 'Pot of Greed');
  playTrap(e, 0, 'Dust Tornado', 'yes', { pick: ['Pot of Greed'] });
  const pog = e.player(0).sz.find((c) => c?.name === 'Pot of Greed');
  check(zone(e, t) === 'gy', "destroys the opponent's Spell/Trap");
  check(!!pog && !pog.faceUp, 'then you can Set 1 Spell/Trap from your hand');
}

section('Kunai with Chain');
{
  const e = duel(['Kunai with Chain']);
  const m = place(e, 0, FILL)!;
  const k = playTrap(e, 0, 'Kunai with Chain')!;
  check(zone(e, k) === 'sz' && m.equips.includes(k.uid) && e.atkOf(m) === 1900, 'equips itself to your monster: +500 ATK');
}
{
  const e = duel(['Kunai with Chain']);
  const m = place(e, 0, FILL)!;
  putST(e, 0, 'Kunai with Chain');
  endTurn(e);
  const a = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, a, m, { respond: 'Kunai with Chain' }, { pick: ['Both'] });
  check(a.pos === 'def' && e.atkOf(m) === 1900, 'both effects: the attacker goes to Defense Position and your monster gains 500 ATK');
}

section('Lightforce Sword');
{
  const e = duel(['Lightforce Sword']);
  const n = e.player(1).hand.length;
  playTrap(e, 0, 'Lightforce Sword');
  const c = e.player(1).removed[0];
  check(!!c && e.player(1).hand.length === n - 1, "banishes 1 random card from the opponent's hand");
  for (let i = 0; i < 5; i++) endTurn(e);
  check(zone(e, c) === 'removed', '(still banished at the 3rd Standby Phase)');
  endTurn(e);
  endTurn(e);
  check(zone(e, c) === 'hand', "returned during the opponent's 4th Standby Phase");
}

section('Magic Jammer');
{
  const e = duel(['Forest'], ['Magic Jammer']);
  putST(e, 1, 'Magic Jammer');
  const n = e.player(1).hand.length;
  const f = grab(e, 0, 'Forest');
  act(e, 0, f.uid, { respond: 'Magic Jammer' });
  check(zone(e, f) === 'gy' && e.player(1).hand.length === n - 1, 'discard 1: negates a Spell activation and destroys it');
}

section('Seven Tools of the Bandit');
{
  const e = duel(['Aqua Chorus'], ['Seven Tools of the Bandit']);
  putST(e, 1, 'Seven Tools of the Bandit');
  const t = putST(e, 0, 'Aqua Chorus');
  act(e, 0, t.uid, { respond: 'Seven Tools of the Bandit' });
  check(zone(e, t) === 'gy' && lp(e, 1) === 3000, 'pays 1000 LP: negates a Trap activation and destroys it');
}

section('Magical Arm Shield');
{
  const e = duel(['Magical Arm Shield'], ['Barrel Dragon']);
  place(e, 0, FILL);
  putST(e, 0, 'Magical Arm Shield');
  endTurn(e);
  const a = place(e, 1, FILL)!;
  const b = place(e, 1, 'Barrel Dragon')!;
  toBattle(e);
  attack(e, a, e.monsters(0)[0], { respond: 'Magical Arm Shield' });
  check(zone(e, a) === 'gy' && lp(e, 1) === 4000 - 1200, "takes control of another opponent's monster and it is attacked instead");
  check(e.controller(b.uid) === 0, '(controlled until the end of the Battle Phase)');
  e.apply({ type: 'NEXT_PHASE', player: 1 });
  settle(e);
  check(e.controller(b.uid) === 1, 'control returns at the end of the Battle Phase');
}

section('Magical Hats');
{
  const e = duel(['Magical Hats', 'Barrel Dragon', 'Pot of Greed', 'Waboku']);
  const m = place(e, 0, 'Barrel Dragon')!;
  putST(e, 0, 'Magical Hats');
  endTurn(e);
  const a = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, a, m, { respond: 'Magical Hats' });
  check(logHas(e, 'Magical Hats shuffles') && !m.faceUp && m.pos === 'def' && zone(e, m) === 'mz', 'your monster is hidden face-down among the hats');
}

section('Metalmorph');
{
  const e = duel(['Metalmorph'], ['Barrel Dragon']);
  const m = place(e, 0, FILL)!;
  playTrap(e, 0, 'Metalmorph');
  check(e.atkOf(m) === 1700 && e.defOf(m) === 1500, 'the equipped monster gains 300 ATK/DEF');
  toTurn3(e);
  const b = place(e, 1, 'Barrel Dragon')!;
  toBattle(e);
  attack(e, m, b);
  check(zone(e, b) === 'gy' && zone(e, m) === 'mz', 'attacking: gains half the ATK of the attack target');
}

section('Mirror Wall');
{
  const e = duel(['Mirror Wall']);
  putST(e, 0, 'Mirror Wall');
  endTurn(e);
  const a = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, a, null, { respond: 'Mirror Wall' });
  check(e.atkOf(a) === 700 && lp(e, 0) === 3300, "the attacking monster's ATK is halved");
  const mw = e.player(0).sz.find((c) => c?.name === 'Mirror Wall')!;
  endTurn(e, 'no');
  check(zone(e, mw) === 'gy', 'your Standby Phase: not paying 2000 LP destroys it');
}

section('Negate Attack');
{
  const e = duel(['Negate Attack']);
  putST(e, 0, 'Negate Attack');
  endTurn(e);
  const a = place(e, 1, FILL)!;
  const b = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, a, null, { respond: 'Negate Attack' });
  attack(e, b, null);
  check(lp(e, 0) === 4000, 'negates the attack and ends the Battle Phase');
}

section('Reinforcements');
{
  const e = duel(['Reinforcements']);
  const m = place(e, 0, FILL)!;
  playTrap(e, 0, 'Reinforcements');
  check(e.atkOf(m) === 1900, 'a face-up monster gains 500 ATK');
  endTurn(e);
  check(e.atkOf(m) === 1400, 'until the end of the turn');
}

section('Skull Dice');
{
  const e = duel(['Skull Dice']);
  const m = place(e, 0, FILL)!;
  const foe = place(e, 1, FILL)!;
  playTrap(e, 0, 'Skull Dice');
  const d = 1400 - e.atkOf(foe);
  check(d >= 100 && d <= 600 && d % 100 === 0 && e.defOf(foe) === 1200 - d && e.atkOf(m) === 1400, "the opponent's monsters lose ATK/DEF equal to the die x 100");
}

section('Spellbinding Circle');
{
  const e = duel(['Spellbinding Circle']);
  const m = place(e, 1, FILL, 'def', false)!;
  const sc = playTrap(e, 0, 'Spellbinding Circle')!;
  check(!!m.cannotAttack && !!m.cannotChangePos && active(e, sc), 'the target (face-down too) cannot attack or change its position');
  kill(e, [m]);
  check(zone(e, sc) === 'gy', 'the monster destroyed: this card is destroyed');
}

section('The Eye of Truth');
{
  const e = duel(['The Eye of Truth'], ['Pot of Greed']);
  emptyHand(e, 1);
  grab(e, 1, 'Pot of Greed');
  playTrap(e, 0, 'The Eye of Truth');
  endTurn(e);
  check(lp(e, 1) === 5000, "the opponent's Standby Phase with a Spell in hand: they gain 1000 LP");
}

section('Time Machine');
{
  const e = duel(['Time Machine', 'Petit Moth']);
  const m = place(e, 0, 'Petit Moth')!;
  putST(e, 0, 'Time Machine');
  endTurn(e);
  const a = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, a, m, { respond: 'Time Machine' });
  check(zone(e, m) === 'mz' && e.controller(m.uid) === 0 && e.fieldCard(m.uid)?.pos === 'atk', 'a monster destroyed by battle returns in the same position');
}

section('Waboku');
{
  const e = duel(['Waboku', 'Petit Moth']);
  const m = place(e, 0, 'Petit Moth')!;
  putST(e, 0, 'Waboku');
  endTurn(e);
  const a = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, a, m, { respond: 'Waboku' });
  check(zone(e, m) === 'mz' && lp(e, 0) === 4000, 'no battle damage and your monsters are not destroyed by battle');
}

section('Widespread Ruin');
{
  const e = duel(['Widespread Ruin'], ['Barrel Dragon']);
  putST(e, 0, 'Widespread Ruin');
  endTurn(e);
  const a = place(e, 1, FILL)!;
  const b = place(e, 1, 'Barrel Dragon')!;
  toBattle(e);
  attack(e, a, null, { respond: 'Widespread Ruin' });
  check(zone(e, b) === 'gy' && zone(e, a) === 'mz', "destroys the opponent's Attack Position monster with the highest ATK");
}

section('Windstorm of Etaqua');
{
  const e = duel(['Windstorm of Etaqua']);
  const a = place(e, 1, FILL)!;
  const b = place(e, 1, FILL, 'def')!;
  playTrap(e, 0, 'Windstorm of Etaqua');
  check(a.pos === 'def' && b.pos === 'atk', "changes the battle positions of the opponent's face-up monsters");
}

console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
if (fails) process.exit(1);
