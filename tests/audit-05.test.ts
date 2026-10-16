// Speed Duel card scripts of batch 05, audited card by card (run: npx tsx tests/audit-05.test.ts)
// One or more targeted checks per scripted card: its main effect really happens in a duel.
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

/** Special Summons a card ignoring its own Summoning condition (to set up a test). */
function placeX(e: Engine, p: Pid, name: string, pos: Pos = 'atk', ...ans: Ans[]): FieldCard | null {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.gy, ...ps.fusion, ...ps.hand, ...ps.removed].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  e.state.fx.ignoreCond = c.uid;
  run(e, e.specialSummon(c.uid, p, pos), ...ans);
  e.state.fx.ignoreCond = undefined;
  return e.fieldCard(c.uid);
}
/** Sends a card of `p` (from anywhere) to the GY. */
function toGy(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.hand, ...ps.deck, ...ps.fusion].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.sendToGrave(c.uid, 'cost'));
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
const dump = (e: Engine, n = 30) => console.log(e.state.log.slice(-n).map((l) => '   | ' + l.text).join('\n'));
const inHand = (e: Engine, p: Pid, name: string) => e.player(p).hand.some((c) => c.name === name);
const inGy = (e: Engine, p: Pid, name: string) => e.player(p).gy.some((c) => c.name === name);
const onField = (e: Engine, p: Pid, name: string) => e.monsters(p).find((m) => m.name === name) ?? null;
const blockedFrom = (e: Engine, p: Pid, name: string, from: string) => {
  const ps = e.player(p);
  const c = [...ps.fusion, ...ps.hand, ...ps.deck, ...ps.gy].find((x) => x.name === name)!;
  return e.summonBlocked(p, c, 'special', from);
};
/** Opponent's turn: player 1 attacks with `a` (moves to their Battle Phase first). */
const oppAttack = (e: Engine, a: FieldCard | null, t: FieldCard | null, ...ans: Ans[]) => {
  endTurn(e);
  toBattle(e);
  return attack(e, a, t, ...ans);
};

// ======================= Elemental HEROes =======================
section('Elemental HERO Darkbright');
{
  const e = duel([], [FILL, 'Gemini Elf'], ['Elemental HERO Darkbright']);
  check(!blockedFrom(e, 0, 'Elemental HERO Darkbright', 'fusion') && blockedFrom(e, 0, 'Elemental HERO Darkbright', 'gy'), 'must be Fusion Summoned (not Special Summoned from the GY)');
  const db = placeX(e, 0, 'Elemental HERO Darkbright')!;
  const def = place(e, 1, FILL, 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, db, def);
  check(zone(e, def) === 'gy' && lp(e, 1) === 4000 - (2000 - 1200), 'inflicts piercing battle damage');
  check(db.pos === 'def', 'changes to Defense Position after it attacks');
  const foe = place(e, 1, 'Gemini Elf')!;
  kill(e, [db], 1);
  check(zone(e, foe) === 'gy', 'destroyed: destroys 1 monster the opponent controls');
}

section('Elemental HERO Flame Wingman');
{
  const e = duel([], [], ['Elemental HERO Flame Wingman']);
  check(blockedFrom(e, 0, 'Elemental HERO Flame Wingman', 'gy'), 'cannot be Special Summoned except by Fusion Summon');
  const fw = placeX(e, 0, 'Elemental HERO Flame Wingman')!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, fw, foe);
  check(lp(e, 1) === 4000 - 700 - 1400, "destroys a monster by battle: inflicts damage equal to the destroyed monster's ATK");
}

section('Elemental HERO Mariner');
{
  const e = duel(['Mirror Force'], [], ['Elemental HERO Mariner']);
  const m = placeX(e, 0, 'Elemental HERO Mariner')!;
  place(e, 1, FILL);
  check(!e.canAttackDirectly(m), 'no Set Spell/Trap: no direct attack');
  putST(e, 0, 'Mirror Force');
  check(e.canAttackDirectly(m), 'with a face-down card in the Spell & Trap Zone it can attack directly');
}

section('Elemental HERO Necroid Shaman');
{
  const e = duel([], ['Gemini Elf'], ['Elemental HERO Necroid Shaman']);
  toGy(e, 1, 'Gemini Elf');
  const foe = place(e, 1, FILL)!;
  check(blockedFrom(e, 0, 'Elemental HERO Necroid Shaman', 'gy'), 'must be Fusion Summoned');
  placeX(e, 0, 'Elemental HERO Necroid Shaman', 'atk', { pick: ['Gemini Elf'] });
  check(zone(e, foe) === 'gy' && !!onField(e, 1, 'Gemini Elf'), "Special Summoned: destroys a monster, then Special Summons a monster from the opponent's GY to their field");
}

section('Elemental HERO Necroshade');
{
  const e = duel(['Elemental HERO Necroshade', 'Elemental HERO Bladedge', 'Elemental HERO Bladedge']);
  const ns = toGy(e, 0, 'Elemental HERO Necroshade');
  const bl = grab(e, 0, 'Elemental HERO Bladedge');
  graveFx(e, 0, ns, { pick: ['Elemental HERO Bladedge'] });
  check(zone(e, bl) === 'mz' && e.monsters(0).length === 1 && e.player(0).normalSummoned, 'a Level 5+ "Elemental HERO" is Normal Summoned without Tributing');
  e.player(0).normalSummoned = false;
  grab(e, 0, 'Elemental HERO Bladedge');
  check(!e.canUseGraveEffect(0, ns.uid), 'only once while it is in the GY');
}

section('Elemental HERO Nova Master');
{
  const e = duel([], [], ['Elemental HERO Nova Master']);
  const nm = placeX(e, 0, 'Elemental HERO Nova Master')!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  const hand = e.player(0).hand.length;
  attack(e, nm, foe);
  check(zone(e, foe) === 'gy' && e.player(0).hand.length === hand + 1, "destroys an opponent's monster by battle: draws 1 card");
}

section('Elemental HERO Plasma Vice');
{
  const e = duel([], [FILL, 'Gemini Elf'], ['Elemental HERO Plasma Vice']);
  const pv = placeX(e, 0, 'Elemental HERO Plasma Vice')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  const def = place(e, 1, FILL, 'def')!;
  const hand = e.player(0).hand.length;
  effect(e, 0, pv, { pick: ['Gemini Elf'] });
  check(zone(e, elf) === 'gy' && e.player(0).hand.length === hand - 1, 'discard 1: destroys an Attack Position monster');
  check(!e.canUseMonsterEffect(0, pv), 'a Defense Position monster cannot be targeted');
  toTurn3(e);
  toBattle(e);
  attack(e, pv, def);
  check(lp(e, 1) === 4000 - (2600 - 1200), 'inflicts piercing battle damage');
}

section('Elemental HERO Prisma');
{
  const e = duel(['Elemental HERO Prisma', 'Elemental HERO Avian', 'Elemental HERO Burstinatrix', 'Polymerization'], [], ['Elemental HERO Flame Wingman']);
  const pr = place(e, 0, 'Elemental HERO Prisma')!;
  grab(e, 0, 'Elemental HERO Burstinatrix');
  const poly = grab(e, 0, 'Polymerization');
  check(!e.canActivateMain(0, poly.uid), 'no Avian yet: no Fusion Summon');
  effect(e, 0, pr);
  check(inGy(e, 0, 'Elemental HERO Avian'), 'reveals a Fusion Monster and sends a listed material from the Deck to the GY');
  check(e.canActivateMain(0, poly.uid), 'its name becomes the sent monster\'s: it can be used as "Elemental HERO Avian"');
  toTurn3(e);
  check(!e.canActivateMain(0, poly.uid), 'the name change ends with the turn');
}

section('Elemental HERO Rampart Blaster');
{
  const e = duel([], [FILL], ['Elemental HERO Rampart Blaster']);
  const rb = placeX(e, 0, 'Elemental HERO Rampart Blaster', 'def')!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  check(!e.canAttackWith(0, rb), 'in Defense Position it cannot attack while the opponent controls a monster');
  run(e, e.sendToGrave(foe.uid, 'cost'));
  check(e.canAttackWith(0, rb), 'in Defense Position it can attack when the opponent controls no monsters');
  attack(e, rb, null);
  check(lp(e, 1) === 4000 - 1000, 'its ATK is halved for that attack');
}

section('Elemental HERO Shining Flare Wingman');
{
  const e = duel(['Elemental HERO Avian', 'Elemental HERO Clayman'], [], ['Elemental HERO Shining Flare Wingman']);
  const sf = placeX(e, 0, 'Elemental HERO Shining Flare Wingman')!;
  toGy(e, 0, 'Elemental HERO Avian');
  toGy(e, 0, 'Elemental HERO Clayman');
  check(e.atkOf(sf) === 2500 + 600, 'gains 300 ATK for each "Elemental HERO" card in the GY');
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, sf, foe);
  check(lp(e, 1) === 4000 - (3100 - 1400) - 1400, 'destroys a monster by battle: damage equal to its ATK');
}

section('Elemental HERO Steam Healer');
{
  const e = duel([], [], ['Elemental HERO Steam Healer']);
  const sh = placeX(e, 0, 'Elemental HERO Steam Healer')!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, sh, foe);
  check(lp(e, 0) === 4000 + 1400, 'destroys a monster by battle: gains LP equal to its ATK');
}

section('Elemental HERO Tempest');
{
  const e = duel(['Gemini Elf'], ['Blue-Eyes White Dragon'], ['Elemental HERO Tempest']);
  const t = placeX(e, 0, 'Elemental HERO Tempest')!;
  const elf = place(e, 0, 'Gemini Elf')!;
  const cg = place(e, 0, FILL)!;
  effect(e, 0, t, { pick: ['Gemini Elf'] }, { pick: [FILL] });
  check(zone(e, elf) === 'gy' && e.shielded(cg, 'battle'), 'send 1 other card: the targeted monster cannot be destroyed by battle');
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  oppAttack(e, bewd, cg);
  check(zone(e, cg) === 'mz', 'it survives the battle');
}

section('Elemental HERO Thunder Giant');
{
  const e = duel([], ['Gemini Elf', 'Blue-Eyes White Dragon'], ['Elemental HERO Thunder Giant']);
  const tg = placeX(e, 0, 'Elemental HERO Thunder Giant')!;
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  check(!e.canUseMonsterEffect(0, tg), 'no monster with original ATK lower than its ATK: no effect');
  const elf = place(e, 1, 'Gemini Elf')!;
  effect(e, 0, tg);
  check(zone(e, elf) === 'gy' && zone(e, bewd) === 'mz', 'discard 1: destroys a face-up monster with lower original ATK');
  check(!e.canUseMonsterEffect(0, tg), 'once per turn');
}

section('Elemental HERO Voltic');
{
  const e = duel(['Elemental HERO Voltic', 'Elemental HERO Sparkman']);
  const v = place(e, 0, 'Elemental HERO Voltic')!;
  const sp = grab(e, 0, 'Elemental HERO Sparkman');
  e.banish(sp.uid);
  toTurn3(e);
  toBattle(e);
  attack(e, v, null, 'yes');
  check(zone(e, sp) === 'mz', 'inflicts battle damage: Special Summons a banished "Elemental HERO"');
}
{
  const e = duel(['Elemental HERO Voltic', 'Elemental HERO Sparkman'], ['Hinotama Soul']);
  const v = place(e, 0, 'Elemental HERO Voltic')!;
  const sp = grab(e, 0, 'Elemental HERO Sparkman');
  e.banish(sp.uid);
  const hs = place(e, 1, 'Hinotama Soul')!;
  oppAttack(e, hs, v, 'yes');
  check(zone(e, sp) === 'mz', 'also when the attacking monster loses to it and the opponent takes the damage');
}

section('Elemental HERO Wild Wingman');
{
  const e = duel([], ['Mirror Force'], ['Elemental HERO Wild Wingman']);
  const ww = placeX(e, 0, 'Elemental HERO Wild Wingman')!;
  const mf = putST(e, 1, 'Mirror Force');
  const hand = e.player(0).hand.length;
  effect(e, 0, ww);
  check(zone(e, mf) === 'gy' && e.player(0).hand.length === hand - 1, 'discard 1: destroys a Spell/Trap on the field');
}

section('Elemental HERO Wildedge');
{
  const e = duel([], [FILL, FILL], ['Elemental HERO Wildedge']);
  const we = placeX(e, 0, 'Elemental HERO Wildedge')!;
  const a = place(e, 1, FILL)!;
  const b = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, we, a);
  check(zone(e, a) === 'gy' && e.canAttackWith(0, we), 'after attacking one monster it can attack another');
  attack(e, we, b);
  check(zone(e, b) === 'gy' && !e.canAttackWith(0, we), 'every monster attacked once: no more attacks (no direct attack)');
}

// ======================= Evil HEROes =======================
section('Evil HERO Infernal Prodigy');
{
  const e = duel(['Evil HERO Infernal Prodigy', 'Elemental HERO Necroshade']);
  const ip = grab(e, 0, 'Evil HERO Infernal Prodigy');
  special(e, 0, ip);
  check(zone(e, ip) === 'mz', 'with no monsters it is Special Summoned from the hand');
  summon(e, 0, 'Elemental HERO Necroshade', true, { pick: ['Evil HERO Infernal Prodigy'] });
  check(zone(e, ip) === 'gy', 'Tributed for the Tribute Summon of a "HERO" monster');
  const hand = e.player(0).hand.length;
  e.apply({ type: 'END_TURN', player: 0 });
  settle(e);
  check(e.player(0).hand.length === hand + 1, 'during the End Phase: draws 1 card');
}
{
  const e = duel(['Evil HERO Infernal Prodigy', 'Ansatsu']);
  place(e, 0, 'Evil HERO Infernal Prodigy');
  summon(e, 0, 'Ansatsu');
  const hand = e.player(0).hand.length;
  e.apply({ type: 'END_TURN', player: 0 });
  settle(e);
  check(e.player(0).hand.length === hand, 'Tributed for a non-"HERO" monster: no draw');
}

section('Evil HERO Inferno Wing');
{
  const e = duel(['Elemental HERO Avian', 'Elemental HERO Burstinatrix', 'Polymerization', 'Dark Fusion'], [FILL], ['Evil HERO Inferno Wing']);
  grab(e, 0, 'Elemental HERO Avian');
  grab(e, 0, 'Elemental HERO Burstinatrix');
  check(!e.canActivateMain(0, grab(e, 0, 'Polymerization').uid), 'cannot be Summoned with "Polymerization"');
  playSpell(e, 0, 'Dark Fusion');
  const iw = onField(e, 0, 'Evil HERO Inferno Wing');
  check(!!iw, 'Special Summoned with "Dark Fusion"');
  const def = place(e, 1, FILL, 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, iw, def);
  check(lp(e, 1) === 4000 - (2100 - 1200) - 1400, 'piercing damage, then damage equal to the higher of the ATK/DEF of the destroyed monster');
}

section('Evil HERO Lightning Golem');
{
  const e = duel(['Elemental HERO Sparkman', 'Elemental HERO Clayman', 'Polymerization'], ['Gemini Elf'], ['Evil HERO Lightning Golem']);
  grab(e, 0, 'Elemental HERO Sparkman');
  grab(e, 0, 'Elemental HERO Clayman');
  check(!e.canActivateMain(0, grab(e, 0, 'Polymerization').uid) && blockedFrom(e, 0, 'Evil HERO Lightning Golem', 'gy'), 'must be Special Summoned with "Dark Fusion"');
  const lg = placeX(e, 0, 'Evil HERO Lightning Golem')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  effect(e, 0, lg, { pick: ['Gemini Elf'] });
  check(zone(e, elf) === 'gy', 'destroys 1 monster on the field');
  check(!e.canUseMonsterEffect(0, lg), 'once per turn');
}

section('Evil HERO Malicious Edge');
{
  const e = duel(['Evil HERO Malicious Edge'], [FILL]);
  const me = grab(e, 0, 'Evil HERO Malicious Edge');
  place(e, 0, FILL);
  check(!e.canNormalSummon(0, me, true), 'no opponent monster: needs 2 Tributes');
  const foe = place(e, 1, FILL, 'def')!;
  check(e.canNormalSummon(0, me, true), 'the opponent controls a monster: Tribute Summoned with 1 Tribute');
  const m = summon(e, 0, 'Evil HERO Malicious Edge');
  check(!!m && e.monsters(0).length === 1, 'it is on the field after 1 Tribute');
  toTurn3(e);
  toBattle(e);
  attack(e, m, foe);
  check(lp(e, 1) === 4000 - (2600 - 1200), 'inflicts piercing battle damage');
}

section('Evil Mind');
{
  const e = duel(['Evil Mind', 'Evil Mind', 'Archfiend Soldier', 'Elemental HERO Avian'], [FILL, FILL, FILL, FILL]);
  check(!e.canActivateMain(0, grab(e, 0, 'Evil Mind').uid), 'needs a Fiend monster');
  place(e, 0, 'Archfiend Soldier');
  for (let i = 0; i < 4; i++) toGy(e, 1, FILL);
  playSpell(e, 0, 'Evil Mind', { pick: ['Add 1 "HERO" monster or "Dark Fusion"'] });
  check(inHand(e, 0, 'Elemental HERO Avian'), '4+ monsters in the opponent\'s GY: adds a "HERO" monster');
  check(!e.canActivateMain(0, grab(e, 0, 'Evil Mind').uid), 'only 1 "Evil Mind" per turn');
}

section('Eliminating the League');
{
  const e = duel(['Eliminating the League', 'Pot of Greed'], [FILL]);
  const foe = place(e, 1, FILL)!;
  grab(e, 0, 'Pot of Greed');
  const before = e.player(1).hand.filter((c) => c.name === FILL).length;
  playTrap(e, 0, 'Eliminating the League');
  check(zone(e, foe) === 'gy' && inGy(e, 0, 'Pot of Greed'), 'discards a Spell: destroys the targeted monster');
  check(before > 0 && !inHand(e, 1, FILL), "sends the cards in the opponent's hand with the same name to the GY");
}

section('Emblem of Dragon Destroyer');
{
  const e = duel(['Emblem of Dragon Destroyer', 'Buster Blader']);
  toGy(e, 0, 'Buster Blader');
  playSpell(e, 0, 'Emblem of Dragon Destroyer');
  check(inHand(e, 0, 'Buster Blader'), 'adds "Buster Blader" from the GY to the hand');
}

section('Embodiment of Apophis');
{
  const e = duel(['Embodiment of Apophis']);
  const ap = playTrap(e, 0, 'Embodiment of Apophis', 'no');
  check(!!ap && zone(e, ap) === 'mz' && e.atkOf(ap) === 1600 && e.defOf(ap) === 1800, 'Special Summoned as a 1600/1800 monster');
  check(!!ap && levelOf(e, ap) === 4 && e.raceOf(ap) === 'Reptile', 'Reptile, Level 4');
}

section('Emergency Provisions');
{
  const e = duel(['Emergency Provisions', 'Mirror Force', 'Dust Tornado']);
  putST(e, 0, 'Mirror Force');
  putST(e, 0, 'Dust Tornado');
  playSpell(e, 0, 'Emergency Provisions', { pick: ['Mirror Force', 'Dust Tornado'] });
  check(lp(e, 0) === 4000 + 2000 && inGy(e, 0, 'Mirror Force') && inGy(e, 0, 'Dust Tornado'), 'sends 2 Spells/Traps: gains 2000 LP');
}

section('Emergeroid Call');
{
  const e = duel(['Emergeroid Call', 'Drillroid'], ['Pot of Greed', 'Pot of Greed'], ['Steam Gyroid']);
  const call = putST(e, 0, 'Emergeroid Call');
  placeX(e, 0, 'Steam Gyroid');
  endTurn(e);
  const hand = e.player(1).hand.length;
  playSpell(e, 1, 'Pot of Greed', { respond: 'Emergeroid Call' });
  check(e.player(1).hand.length === hand - 1 && zone(e, call) === 'gy', 'negates the activation while you control a "roid" Fusion Monster');
  check(e.player(1).deck.every((c) => c.name !== 'Pot of Greed') && e.player(1).gy.filter((c) => c.name === 'Pot of Greed').length === 2, "sends the cards with that name from the activating player's Deck to the GY");
  endTurn(e);
  toGy(e, 0, 'Drillroid');
  graveFx(e, 0, call);
  check(zone(e, call) === 'removed' && inHand(e, 0, 'Drillroid'), 'banished from the GY: adds a "roid" monster from the GY to the hand');
}

section('Enchanting Fitting Room');
{
  const e = duel(['Akakieisu', 'Anthrosaurus', 'Blue-Eyes White Dragon', FILL, 'Enchanting Fitting Room']);
  playSpell(e, 0, 'Enchanting Fitting Room');
  check(lp(e, 0) === 3200 && !!onField(e, 0, 'Akakieisu') && !!onField(e, 0, 'Anthrosaurus') && e.monsters(0).length === 2, 'pay 800: Special Summons the excavated Level 3 or lower Normal Monsters');
}

section('Enemy Controller');
{
  const e = duel(['Enemy Controller', 'Enemy Controller'], [FILL, 'Gemini Elf']);
  const foe = place(e, 1, FILL)!;
  playSpell(e, 0, 'Enemy Controller', { pick: ['Change its battle position'] });
  check(foe.pos === 'def', "changes the opponent's monster's battle position");
  place(e, 0, FILL);
  const elf = place(e, 1, 'Gemini Elf')!;
  playSpell(e, 0, 'Enemy Controller', { pick: ['Tribute 1 monster: take control of it'] }, { pick: [FILL] }, { pick: ['Gemini Elf'] });
  check(e.controller(elf.uid) === 0, 'Tribute 1 monster: takes control of the target');
  endTurn(e);
  check(e.controller(elf.uid) === 1, 'until the End Phase');
}

section('Energy Drain');
{
  const e = duel(['Energy Drain']);
  const m = place(e, 0, FILL)!;
  playTrap(e, 0, 'Energy Drain');
  check(e.atkOf(m) === 1400 + 800 && e.defOf(m) === 1200 + 800, "gains 200 ATK/DEF for each card in the opponent's hand");
  endTurn(e);
  check(e.atkOf(m) === 1400, 'until the end of this turn');
}

section('Enraged Muka Muka');
{
  const e = duel(['Enraged Muka Muka']);
  const m = place(e, 0, 'Enraged Muka Muka')!;
  const n = e.player(0).hand.length;
  check(e.atkOf(m) === 1200 + 400 * n && e.defOf(m) === 600 + 400 * n, 'gains 400 ATK/DEF for each card in your hand');
}

section('Etoile Cyber');
{
  const e = duel(['Etoile Cyber'], [FILL]);
  const m = place(e, 0, 'Etoile Cyber')!;
  toTurn3(e);
  toBattle(e);
  attack(e, m, null);
  check(lp(e, 1) === 4000 - 1700, 'a direct attack: +500 ATK during the Damage Step');
  check(e.atkOf(m) === 1200, 'only during the Damage Step');
}

section('Eva');
{
  const e = duel(['Eva', 'Mokey Mokey', 'Hoshiningen']);
  const eva = place(e, 0, 'Eva')!;
  toGy(e, 0, 'Mokey Mokey');
  kill(e, [eva], 0, 'yes', { pick: ['Mokey Mokey'] });
  check(zone(e, grab(e, 0, 'Hoshiningen')) === 'hand' && e.player(0).removed.some((c) => c.name === 'Mokey Mokey'), 'sent to the GY: banishes a LIGHT Fairy, adds a Level 2 or lower LIGHT Fairy from the Deck');
}

section('Evo-Instant');
{
  const e = duel(['Evo-Instant', 'Krokodilus', 'Evolsaur Darwino']);
  const k = place(e, 0, 'Krokodilus')!;
  playTrap(e, 0, 'Evo-Instant');
  check(zone(e, k) === 'gy' && !!onField(e, 0, 'Evolsaur Darwino'), 'Tributes a Reptile: Special Summons an "Evolsaur" from the Deck');
}

section('Evo-Price / Evoltile Lagosucho');
{
  const e = duel(['Evo-Price', 'Evoltile Lagosucho', 'Evoltile Lagosucho', 'Evolsaur Darwino'], ['Gemini Elf']);
  playSpell(e, 0, 'Evo-Price');
  const elf = place(e, 1, 'Gemini Elf')!;
  const lago = place(e, 0, 'Evoltile Lagosucho', 'def', false)!;
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: lago.uid });
  settle(e, 'yes', 'yes', { pick: ['Gemini Elf'] });
  check(e.monsters(0).filter((m) => m.name === 'Evoltile Lagosucho').length === 2, 'Lagosucho flipped face-up: Special Summons an "Evoltile" from the Deck');
  check(zone(e, elf) === 'gy', 'Evo-Price: a monster Special Summoned by an "Evoltile" effect lets it destroy 1 card');
}
{
  const e = duel(['Evoltile Lagosucho', 'Evolsaur Darwino']);
  summon(e, 0, 'Evoltile Lagosucho', true, 'yes');
  check(inGy(e, 0, 'Evolsaur Darwino'), 'Lagosucho Normal Summoned: sends an "Evolsaur" from the Deck to the GY');
}

section('Exchange of the Spirit');
{
  const e = duel(['Exchange of the Spirit']);
  const t = putST(e, 0, 'Exchange of the Spirit');
  check(!e.canActivateMain(0, t.uid), 'needs 15+ cards in both GYs');
  for (const q of [0, 1] as Pid[]) {
    const ps = e.player(q);
    ps.gy.push(...ps.deck.splice(0, 16));
  }
  const g0 = e.player(0).gy.length;
  const d0 = e.player(0).deck.length;
  act(e, 0, t.uid);
  check(lp(e, 0) === 3000 && e.player(0).deck.length === g0 && e.player(0).gy.length === d0 + 1, 'pay 1000: each player swaps their GY and Deck');
}

section('Exhausting Spell');
{
  const e = duel(['Exhausting Spell', 'Dark Red Enchanter']);
  const dre = place(e, 0, 'Dark Red Enchanter')!;
  dre.counters = 2;
  playTrap(e, 0, 'Exhausting Spell');
  check(dre.counters === 0, 'removes all Spell Counters on the field');
}

section('Exiled Force');
{
  const e = duel(['Exiled Force'], ['Gemini Elf']);
  const ef = place(e, 0, 'Exiled Force')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  effect(e, 0, ef, { pick: ['Gemini Elf'] });
  check(zone(e, ef) === 'gy' && zone(e, elf) === 'gy', 'Tributes itself: destroys the target');
}

section('Exploder Dragon');
{
  const e = duel(['Exploder Dragon'], [FILL]);
  const ex = place(e, 0, 'Exploder Dragon')!;
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, ex, foe);
  check(zone(e, ex) === 'gy' && zone(e, foe) === 'gy', 'destroyed by battle: destroys the monster that destroyed it');
  check(lp(e, 0) === 4000, 'no battle damage from its attack');
}
{
  const e = duel(['Exploder Dragon'], [FILL]);
  const ex = place(e, 0, 'Exploder Dragon')!;
  const foe = place(e, 1, FILL)!;
  oppAttack(e, foe, ex);
  check(zone(e, foe) === 'gy' && lp(e, 0) === 4000 - 400, 'when it is attacked: destroys the attacker, battle damage still applies');
}

section('Expressroid');
{
  const e = duel(['Expressroid', 'Drillroid', 'Gyroid']);
  toGy(e, 0, 'Drillroid');
  toGy(e, 0, 'Gyroid');
  summon(e, 0, 'Expressroid', true, 'yes');
  check(inHand(e, 0, 'Drillroid') && inHand(e, 0, 'Gyroid'), 'Summoned: adds 2 "roid" monsters from the GY to the hand');
}

// ======================= F =======================
section('Fairy Box');
{
  const e = duel(['Fairy Box'], [FILL]);
  const box = playTrap(e, 0, 'Fairy Box');
  check(active(e, box), 'stays face-up on the field');
  const mine = place(e, 0, FILL)!;
  const foe = place(e, 1, FILL)!;
  e.roll = () => 1;
  oppAttack(e, foe, mine, { respond: 'Fairy Box' }, { pick: ['Heads'] });
  check(zone(e, foe) === 'gy' && lp(e, 1) === 4000 - 1400, "called right: the attacking monster's ATK becomes 0");
  endTurn(e, 'yes');
  check(lp(e, 0) === 3500 && active(e, box), 'during your Standby Phase: pay 500 LP to keep it');
}

section('Fairy Meteor Crush');
{
  const e = duel(['Fairy Meteor Crush'], [FILL]);
  const m = place(e, 0, FILL)!;
  playSpell(e, 0, 'Fairy Meteor Crush', { pick: [FILL] });
  const def = place(e, 1, FILL, 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, m, def);
  check(zone(e, def) === 'gy' && lp(e, 1) === 4000 - 200, 'the equipped monster inflicts piercing battle damage');
}

section('Fairy Tail - Sleeper');
{
  const e = duel(['Fairy Tail - Sleeper', 'Gemini Elf']);
  const sl = place(e, 0, 'Fairy Tail - Sleeper', 'def', false)!;
  grab(e, 0, 'Gemini Elf');
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: sl.uid });
  settle(e, 'yes', { pick: ['Gemini Elf'] });
  check(!!onField(e, 0, 'Gemini Elf'), 'FLIP: Special Summons a monster from the hand');
}
{
  const e = duel(['Fairy Tail - Sleeper', 'Gemini Elf'], ['Pot of Greed']);
  place(e, 0, 'Fairy Tail - Sleeper');
  const other0 = place(e, 0, FILL)!;
  const elf = place(e, 0, 'Gemini Elf')!;
  endTurn(e);
  const hand = e.player(1).hand.length;
  playSpell(e, 1, 'Pot of Greed', { respond: 'Fairy Tail - Sleeper' }, { pick: [FILL] });
  check(zone(e, other0) === 'gy' && e.player(1).hand.length === hand - 1, 'Tributes 1 other monster: the Normal Spell does not draw');
  check(e.monsters(0).some((m) => !m.faceUp && m.pos === 'def') && elf.faceUp !== undefined, 'instead a face-up monster of Sleeper\'s controller is changed to face-down Defense Position');
}

section('Fairy Wind');
{
  const e = duel(['Fairy Wind', 'Fire Formation - Tenki'], ['Final Attack Orders']);
  const ff = playSpell(e, 0, 'Fire Formation - Tenki');
  endTurn(e);
  const fao = playTrap(e, 1, 'Final Attack Orders');
  endTurn(e);
  playTrap(e, 0, 'Fairy Wind');
  check(zone(e, ff) === 'gy' && zone(e, fao) === 'gy' && lp(e, 0) === 3400 && lp(e, 1) === 3400, 'destroys the face-up Spells/Traps: each player takes 300 per card');
}

section('Fallen Paradise');
{
  const e = duel(['Fallen Paradise', 'Hamon, Lord of Striking Thunder'], ['Gemini Elf']);
  const fp = playSpell(e, 0, 'Fallen Paradise')!;
  check(!e.canUseMonsterEffect(0, fp), 'no Lord: no draw');
  const hamon = placeX(e, 0, 'Hamon, Lord of Striking Thunder')!;
  const hand = e.player(0).hand.length;
  effect(e, 0, fp);
  check(e.player(0).hand.length === hand + 2, 'controls a Lord: draws 2 cards');
  check(!e.canUseMonsterEffect(0, fp), 'once per turn');
  kill(e, [hamon], 1);
  check(zone(e, hamon) === 'mz', "the Lord cannot be destroyed by the opponent's card effects");
  const prev = (e as any).actor;
  (e as any).actor = 1;
  check(e.untargetable(hamon), 'the opponent cannot target it');
  (e as any).actor = prev;
}

section("Fiend's Sanctuary / Metal Fiend Token");
{
  const e = duel(["Fiend's Sanctuary"], [FILL]);
  playSpell(e, 0, "Fiend's Sanctuary");
  const tok = onField(e, 0, 'Metal Fiend Token');
  check(!!tok && e.atkOf(tok) === 0, 'Special Summons a 0/0 Metal Fiend Token');
  const foe = place(e, 1, FILL)!;
  endTurn(e);
  endTurn(e, 'yes');
  check(zone(e, tok) === 'mz' && lp(e, 0) === 3000, 'your Standby Phase: pay 1000 LP to keep the Token');
  toBattle(e);
  check(!e.canAttackWith(0, tok!), 'the Token cannot attack');
  endTurn(e);
  toBattle(e);
  attack(e, foe, tok);
  check(lp(e, 0) === 3000 && lp(e, 1) === 4000 - 1400, 'the opponent takes the battle damage you would have taken');
  endTurn(e, 'no');
  check(zone(e, tok) === undefined, 'your Standby Phase: not paying 1000 LP destroys the Token');
}

section('Fiendish Rhino Warrior');
{
  const e = duel(['Fiendish Rhino Warrior', 'Archfiend Soldier', 'Bio Plant']);
  const rhino = place(e, 0, 'Fiendish Rhino Warrior')!;
  const af = place(e, 0, 'Archfiend Soldier')!;
  kill(e, [af], 1);
  check(zone(e, af) === 'mz', 'other Fiends you control cannot be destroyed by card effects');
  kill(e, [rhino], 1, 'yes', { pick: ['Bio Plant'] });
  check(inGy(e, 0, 'Bio Plant'), 'sent to the GY: sends a Fiend from the Deck to the GY');
}

section('Fifth Hope');
{
  const heroes = ['Elemental HERO Avian', 'Elemental HERO Clayman', 'Elemental HERO Sparkman', 'Elemental HERO Bubbleman', 'Elemental HERO Burstinatrix'];
  const e = duel(['Fifth Hope', ...heroes]);
  for (const n of heroes) toGy(e, 0, n);
  const hand = e.player(0).hand.length;
  playSpell(e, 0, 'Fifth Hope');
  check(e.player(0).gy.filter((c) => c.name.startsWith('Elemental HERO')).length === 0 && e.player(0).hand.length === hand + 1 + 2 - 1, 'shuffles 5 "Elemental HERO" cards into the Deck, then draws 2');
}

section('Fighting Spirit');
{
  const e = duel(['Fighting Spirit'], [FILL, 'Gemini Elf', 'Blue-Eyes White Dragon']);
  const m = place(e, 0, FILL)!;
  const fs = playSpell(e, 0, 'Fighting Spirit', { pick: [FILL] });
  place(e, 1, FILL);
  place(e, 1, 'Gemini Elf');
  check(e.atkOf(m) === 1400 + 600, 'gains 300 ATK for each monster the opponent controls');
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  oppAttack(e, bewd, m);
  check(zone(e, m) === 'mz' && zone(e, fs) === 'gy', 'destroyed by battle: Fighting Spirit is destroyed instead');
}

section('Final Attack Orders');
{
  const e = duel(['Final Attack Orders', 'Gemini Elf']);
  const m = place(e, 0, FILL, 'def')!;
  playTrap(e, 0, 'Final Attack Orders');
  check(m.pos === 'atk' && !e.canChangePosition(0, m), 'face-up monsters change to Attack Position and stay there');
  const elf = place(e, 0, 'Gemini Elf', 'def')!;
  check(elf.pos === 'atk', 'also monsters that arrive later');
}

section('Fire Formation - Tenki');
{
  const e = duel(['Fire Formation - Tenki', 'Fire Formation - Tenki', 'Battle Ox']);
  playSpell(e, 0, 'Fire Formation - Tenki', 'yes');
  check(inHand(e, 0, 'Battle Ox'), 'activated: adds a Level 4 or lower Beast-Warrior from the Deck');
  const ox = place(e, 0, 'Battle Ox')!;
  check(e.atkOf(ox) === 1800, 'Beast-Warriors you control gain 100 ATK');
  check(!e.canActivateMain(0, grab(e, 0, 'Fire Formation - Tenki').uid), 'only 1 activation per turn');
}

section('Fire Sorcerer');
{
  const e = duel(['Fire Sorcerer']);
  const fs = place(e, 0, 'Fire Sorcerer', 'def', false)!;
  const hand = e.player(0).hand.length;
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: fs.uid });
  settle(e);
  check(e.player(0).hand.length === hand - 2 && e.player(0).removed.length === 2 && lp(e, 1) === 3200, 'FLIP: banishes 2 random cards from the hand, inflicts 800 damage');
}

section('Firewall');
{
  const e = duel(['Firewall', 'Hinotama Soul'], [FILL]);
  const fw = playTrap(e, 0, 'Firewall');
  toGy(e, 0, 'Hinotama Soul');
  const foe = place(e, 1, FILL)!;
  oppAttack(e, foe, null, { respond: 'Firewall' });
  check(lp(e, 0) === 4000 && e.player(0).removed.some((c) => c.name === 'Hinotama Soul') && active(e, fw), 'banishes a Pyro from the GY: negates the direct attack');
}

section('Fish Depth Charge');
{
  const e = duel(['Fish Depth Charge', 'Great White'], ['Gemini Elf']);
  const gw = place(e, 0, 'Great White')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  const hand = e.player(0).hand.length;
  playTrap(e, 0, 'Fish Depth Charge', { pick: ['Great White'] }, { pick: ['Gemini Elf'] });
  check(zone(e, gw) === 'gy' && zone(e, elf) === 'gy' && e.player(0).hand.length === hand + 1, 'Tributes a Fish: destroys the target and draws 1 card');
}

section('Fishborg Doctor');
{
  const e = duel(['Fishborg Doctor', 'Fishborg Planter', 'Gemini Elf']);
  const doc = toGy(e, 0, 'Fishborg Doctor');
  check(!e.canUseGraveEffect(0, doc.uid), 'needs a "Fishborg" monster');
  place(e, 0, 'Fishborg Planter');
  graveFx(e, 0, doc);
  check(zone(e, doc) === 'mz', 'all monsters you control are "Fishborg": Special Summons itself');
  place(e, 0, 'Gemini Elf');
  check(zone(e, doc) === 'removed', 'you control a non-"Fishborg" monster: it is destroyed, and banished as it leaves the field');
}

section('Fishborg Planter');
{
  const e = duel(['7 Colored Fish', 'Fishborg Planter']);
  const pl = toGy(e, 0, 'Fishborg Planter');
  graveFx(e, 0, pl);
  check(inGy(e, 0, '7 Colored Fish') && zone(e, pl) === 'mz', 'mills the top card: a WATER monster, so it Special Summons itself');
  kill(e, [pl]);
  check(!e.canUseGraveEffect(0, pl.uid), 'once while it is in the GY (and once per turn)');
}

section('Flame Tiger');
{
  const e = duel(['Flame Tiger']);
  const ft = toGy(e, 0, 'Flame Tiger');
  endTurn(e);
  const hand = e.player(0).hand.length;
  endTurn(e, 'yes');
  check(zone(e, ft) === 'mz' && e.player(0).hand.length === hand, 'no monsters: Special Summoned instead of the normal draw');
  kill(e, [ft], 1);
  check(zone(e, ft) === 'removed', 'banished when it leaves the field');
}

section('Flash of the Forbidden Spell');
{
  const e = duel(['Flash of the Forbidden Spell'], [FILL, FILL, FILL]);
  const fl = grab(e, 0, 'Flash of the Forbidden Spell');
  place(e, 1, FILL);
  place(e, 1, FILL);
  check(!e.canActivateMain(0, fl.uid), 'needs all of the opponent\'s Monster Zones occupied');
  place(e, 1, FILL);
  playSpell(e, 0, 'Flash of the Forbidden Spell');
  check(e.monsters(1).length === 0, "destroys all the opponent's monsters");
}

section('Flint');
{
  const e = duel(['Flint'], [FILL]);
  const foe = place(e, 1, FILL)!;
  const fl = playSpell(e, 0, 'Flint', { pick: [FILL] });
  check(fl?.equippedTo === foe.uid && e.atkOf(foe) === 1100, 'the equipped monster loses 300 ATK');
  endTurn(e);
  toBattle(e);
  check(!e.canAttackWith(1, foe), 'it cannot attack');
}

section('Flint Cragger');
{
  const e = duel(['Flint Cragger'], [], ['Fossil Warrior Skull Bone']);
  const fc = placeX(e, 0, 'Flint Cragger', 'atk', 'yes');
  check(inGy(e, 0, 'Fossil Warrior Skull Bone'), 'Special Summoned: discard 1 to send a "Fossil" Fusion Monster to the GY');
  effect(e, 0, fc);
  check(zone(e, fc) === 'gy' && lp(e, 1) === 3500, 'sends itself to the GY: 500 damage');
}

section('Flint Lock');
{
  const e = duel(['Flint Lock', 'Flint'], [FILL, 'Blue-Eyes White Dragon']);
  const lock = place(e, 0, 'Flint Lock')!;
  const foe = place(e, 1, FILL)!;
  const fl = playSpell(e, 0, 'Flint', { pick: [FILL] })!;
  effect(e, 0, lock);
  check(fl.equippedTo === lock.uid && e.atkOf(lock) === 1500, 'takes the "Flint" and is unaffected by it');
  effect(e, 0, lock, { pick: [FILL] });
  check(fl.equippedTo === foe.uid, 'equips its "Flint" to another monster');
  effect(e, 0, lock);
  check(fl.equippedTo === foe.uid, 'takes "Flint" only once per turn');
}
{
  const e = duel(['Flint Lock', 'Flint'], ['Blue-Eyes White Dragon']);
  const lock = place(e, 0, 'Flint Lock')!;
  playSpell(e, 0, 'Flint', { pick: ['Flint Lock'] });
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  oppAttack(e, bewd, lock);
  check(zone(e, lock) === 'mz', 'equipped with "Flint": cannot be destroyed by battle');
}

section('Floodgate Trap Hole');
{
  const e = duel(['Floodgate Trap Hole'], ['Gemini Elf']);
  putST(e, 0, 'Floodgate Trap Hole');
  endTurn(e);
  const elf = summon(e, 1, 'Gemini Elf', true, { respond: 'Floodgate Trap Hole' })!;
  check(!elf.faceUp && elf.pos === 'def', 'the Summoned monster is changed to face-down Defense Position');
  endTurn(e);
  endTurn(e);
  e.apply({ type: 'FLIP_SUMMON', player: 1, uid: elf.uid });
  settle(e);
  check(!elf.faceUp, 'it cannot change its battle position (no Flip Summon)');
}

// ======================= Flower Cardian =======================
section('Flower Cardian Cherry Blossom with Curtain');
{
  const e = duel(['Flower Cardian Cherry Blossom with Curtain', 'Flower Cardian Pine']);
  const cb = grab(e, 0, 'Flower Cardian Cherry Blossom with Curtain');
  check(e.summonBlocked(0, cb, 'special', 'hand') && !e.canNormalSummon(0, cb), 'cannot be Normal Summoned, or Special Summoned by other ways');
  effect(e, 0, cb);
  check(zone(e, cb) === 'mz' && inHand(e, 0, 'Flower Cardian Pine'), 'draws a "Flower Cardian" monster: Special Summons itself');
}
{
  const e = duel([FILL, 'Flower Cardian Cherry Blossom with Curtain']);
  const cb = grab(e, 0, 'Flower Cardian Cherry Blossom with Curtain');
  const top = e.player(0).deck[0];
  effect(e, 0, cb);
  check(zone(e, cb) === 'gy' && zone(e, top) === 'gy', 'otherwise it and the drawn card go to the GY');
}
{
  const e = duel(['Flower Cardian Cherry Blossom with Curtain', 'Flower Cardian Pine with Crane'], ['Summoned Skull']);
  const crane = placeX(e, 0, 'Flower Cardian Pine with Crane')!;
  const cb = grab(e, 0, 'Flower Cardian Cherry Blossom with Curtain');
  const foe = place(e, 1, 'Summoned Skull')!;
  toTurn3(e);
  toBattle(e);
  attack(e, crane, foe, { respond: 'Flower Cardian Cherry Blossom with Curtain' });
  check(zone(e, cb) === 'gy' && zone(e, foe) === 'gy' && zone(e, crane) === 'mz', 'discard it: your battling "Flower Cardian" gains 1000 ATK');
}

section('Flower Cardian Maple with Deer');
{
  const e = duel(['Flower Cardian Maple with Deer', 'Flower Cardian Pine', 'Flower Cardian Willow'], ['Mirror Force']);
  const mf = putST(e, 1, 'Mirror Force');
  const md = grab(e, 0, 'Flower Cardian Maple with Deer');
  check(!e.canSpecialProc(0, md), 'needs a "Flower Cardian" to Tribute');
  const pine = place(e, 0, 'Flower Cardian Pine')!;
  special(e, 0, md, 'yes');
  check(zone(e, md) === 'mz' && zone(e, pine) === 'gy', 'Special Summoned by Tributing a "Flower Cardian"');
  check(inHand(e, 0, 'Flower Cardian Willow') && zone(e, mf) === 'gy', 'draws a "Flower Cardian": destroys a Spell/Trap the opponent controls');
}

section('Flower Cardian Pine');
{
  const e = duel(['Flower Cardian Pine', FILL]);
  summon(e, 0, 'Flower Cardian Pine');
  check(e.player(0).gy.length === 1, 'Normal Summoned: draws 1 card, not a "Flower Cardian": it goes to the GY');
}
{
  const e = duel(['Flower Cardian Pine'], [FILL]);
  const pine = place(e, 0, 'Flower Cardian Pine')!;
  const hand = e.player(0).hand.length;
  kill(e, [pine], 1, 'yes');
  check(e.player(0).hand.length === hand + 1, "destroyed by the opponent's card effect: draws 1 card");
  const e2 = duel(['Flower Cardian Pine']);
  const p2 = place(e2, 0, 'Flower Cardian Pine')!;
  const h2 = e2.player(0).hand.length;
  kill(e2, [p2], 0, 'yes');
  check(e2.player(0).hand.length === h2, 'destroyed by your own card effect: no draw');
}

section('Flower Cardian Pine with Crane');
{
  const e = duel(['Flower Cardian Pine with Crane', 'Flower Cardian Pine', 'Flower Cardian Willow'], [FILL]);
  const crane = grab(e, 0, 'Flower Cardian Pine with Crane');
  place(e, 0, 'Flower Cardian Pine');
  special(e, 0, crane, 'yes');
  check(zone(e, crane) === 'mz' && !!onField(e, 0, 'Flower Cardian Willow'), 'Tributes a Level 1 "Flower Cardian": draws, and Special Summons the drawn "Flower Cardian"');
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, e.fieldCard(crane.uid), foe);
  const hand = e.player(0).hand.length;
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  settle(e);
  check(e.player(0).hand.length === hand + 1, 'at the end of the Battle Phase, if it battled: draws 1 card');
}

section('Flower Cardian Willow');
{
  const e = duel(['Flower Cardian Willow', 'Flower Cardian Pine', 'Flower Cardian Pine']);
  const w = grab(e, 0, 'Flower Cardian Willow');
  check(!e.canSpecialProc(0, w), 'needs a Level 10 or lower "Flower Cardian"');
  place(e, 0, 'Flower Cardian Pine');
  special(e, 0, w);
  check(zone(e, w) === 'mz', 'Special Summoned from the hand');
  check(e.summonBlocked(0, grab(e, 0, FILL), 'normal', 'hand') && !e.summonBlocked(0, grab(e, 0, 'Flower Cardian Pine'), 'normal', 'hand'), 'then only "Flower Cardian" monsters can be Summoned this turn');
  toGy(e, 0, 'Flower Cardian Pine');
  const hand = e.player(0).hand.length;
  effect(e, 0, e.fieldCard(w.uid));
  check(e.player(0).hand.length === hand + 1 && !inGy(e, 0, 'Flower Cardian Pine'), 'shuffles a "Flower Cardian" from the GY into the Deck, then draws 1');
}

// ======================= Fog / Fossils / Frontline =======================
section('Fog Control');
{
  const e = duel(['Fog Control', 'Cloudian - Smoke Ball'], [FILL]);
  const cl = place(e, 0, 'Cloudian - Smoke Ball')!;
  const foe = place(e, 1, FILL)!;
  playSpell(e, 0, 'Fog Control', { pick: ['Cloudian - Smoke Ball'] }, { pick: [FILL] });
  check(zone(e, cl) === 'gy' && foe.tags?.fog === 3, 'Tributes a "Cloudian": places 3 Fog Counters on a face-up monster'); // spells-d: Fog Counters live in tags.fog
}

section('Fossil Dig');
{
  const e = duel(['Fossil Dig', 'Two-Headed King Rex']);
  playSpell(e, 0, 'Fossil Dig');
  check(inHand(e, 0, 'Two-Headed King Rex'), 'adds a Level 6 or lower Dinosaur from the Deck');
}

section('Fossil Machine Skull Buggy');
{
  const e = duel([FILL, FILL, FILL, 'Flint Cragger'], [FILL], ['Fossil Machine Skull Buggy']);
  check(blockedFrom(e, 0, 'Fossil Machine Skull Buggy', 'fusion'), 'must first be Special Summoned with "Fossil Fusion"');
  const sb = placeX(e, 0, 'Fossil Machine Skull Buggy')!;
  const foe = place(e, 1, FILL, 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, sb, foe, 'yes');
  check(zone(e, foe) === 'gy' && lp(e, 1) === 3400, "destroys an opponent's monster by battle: 600 damage");
  kill(e, [sb], 1);
  endTurn(e);
  endTurn(e);
  graveFx(e, 0, sb);
  check(zone(e, sb) === 'removed' && inHand(e, 0, 'Flint Cragger'), 'banished from the GY: adds a monster that mentions "Fossil Fusion"');
}

section('Fossil Warrior Skull Bone');
{
  const e = duel([], [FILL, FILL], ['Fossil Warrior Skull Bone']);
  const sb = placeX(e, 0, 'Fossil Warrior Skull Bone')!;
  const a = place(e, 1, FILL, 'def')!;
  const b = place(e, 1, FILL, 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, sb, a);
  check(e.canAttackWith(0, sb), 'can attack a second monster');
  attack(e, sb, b);
  check(zone(e, b) === 'gy' && !e.canAttackWith(0, sb), 'up to 2 attacks on monsters');
  kill(e, [sb], 1);
  endTurn(e);
  endTurn(e);
  check(!e.canUseGraveEffect(0, sb.uid), 'GY effect needs a "Time Stream" in the Deck');
}

section('Fossil Warrior Skull Knight');
{
  const e = duel([], [FILL, FILL], ['Fossil Warrior Skull Knight']);
  const sk = placeX(e, 0, 'Fossil Warrior Skull Knight')!;
  const a = place(e, 1, FILL, 'def')!;
  const b = place(e, 1, FILL)!;
  toTurn3(e);
  toBattle(e);
  attack(e, sk, a, 'yes');
  check(zone(e, a) === 'gy' && lp(e, 1) === 4000 - (2400 - 1200), 'inflicts piercing battle damage');
  check(e.canAttackWith(0, sk), 'destroyed a monster: can attack again in a row');
  kill(e, [sk], 1);
  endTurn(e);
  endTurn(e);
  graveFx(e, 0, sk, { pick: [FILL] });
  check(zone(e, sk) === 'removed' && zone(e, b) === 'gy', 'banished from the GY: destroys a monster on the field');
}

section('Fossil Tusker');
{
  const e = duel(['Fossil Tusker'], ['Hinotama Soul']);
  const t = place(e, 0, 'Fossil Tusker')!;
  const foe = place(e, 1, 'Hinotama Soul', 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, t, foe);
  check(zone(e, foe) === 'gy' && lp(e, 1) === 3600, "destroys an opponent's monster by battle: 400 damage");
}

section('Frontline Base');
{
  const e = duel(['Frontline Base', 'Y-Dragon Head', 'Z-Metal Tank']);
  const fb = playSpell(e, 0, 'Frontline Base')!;
  grab(e, 0, 'Y-Dragon Head');
  grab(e, 0, 'Z-Metal Tank');
  effect(e, 0, fb, { pick: ['Y-Dragon Head'] });
  check(!!onField(e, 0, 'Y-Dragon Head'), 'Special Summons a Level 4 or lower Union monster from the hand');
  check(!e.canUseMonsterEffect(0, fb), 'once per turn');
}

section('Frost and Flame Dragon');
{
  const e = duel(['Frost and Flame Dragon', 'Fire Kraken', '7 Colored Fish', 'Great White'], ['Gemini Elf']);
  const ff = grab(e, 0, 'Frost and Flame Dragon');
  for (const n of ['Fire Kraken', '7 Colored Fish', 'Great White']) toGy(e, 0, n);
  special(e, 0, ff);
  check(zone(e, ff) === 'mz' && e.player(0).removed.length === 3, 'Special Summoned by banishing 1 FIRE and 2 WATER monsters from the GY');
  const elf = place(e, 1, 'Gemini Elf')!;
  effect(e, 0, e.fieldCard(ff.uid), { pick: ['Gemini Elf'] });
  check(zone(e, elf) === 'gy', 'discard 1: destroys a monster');
  kill(e, [e.fieldCard(ff.uid)], 1);
  check(blockedFrom(e, 0, 'Frost and Flame Dragon', 'gy'), 'cannot be Special Summoned by other ways');
}

// ======================= Equips / Fusion =======================
section('Fulfillment of the Contract');
{
  const e = duel(['Fulfillment of the Contract', 'Black Luster Soldier']);
  const bls = toGy(e, 0, 'Black Luster Soldier');
  const fc = playSpell(e, 0, 'Fulfillment of the Contract');
  check(lp(e, 0) === 3200 && zone(e, bls) === 'mz' && fc?.equippedTo === bls.uid, 'pay 800: Special Summons a Ritual Monster from the GY and equips to it');
  kill(e, [fc], 1);
  check(zone(e, bls) === 'removed', 'destroyed: the equipped monster is banished');
}

section('Gagagarevenge');
{
  const e = duel(['Gagagarevenge', 'Gagaga Gardna']);
  const g = toGy(e, 0, 'Gagaga Gardna');
  const gr = playSpell(e, 0, 'Gagagarevenge');
  check(zone(e, g) === 'mz' && gr?.equippedTo === g.uid, 'Special Summons a "Gagaga" monster from the GY and equips to it');
  kill(e, [gr], 1);
  check(zone(e, g) === 'gy', 'leaves the field: the equipped monster is destroyed');
}
{
  const e = duel(['Gagagarevenge', 'Gagaga Gardna'], [], ['Number 103: Ragnazero']);
  const g = toGy(e, 0, 'Gagaga Gardna');
  const gr = playSpell(e, 0, 'Gagagarevenge');
  const cg = place(e, 0, FILL)!;
  const x = e.player(0).fusion.find((c) => c.name === 'Number 103: Ragnazero')!;
  run(e, e.extraSummon(0, x.uid, [g.uid, cg.uid], 'Xyz'));
  const xyz = e.fieldCard(x.uid);
  check(!!xyz && zone(e, gr) === 'gy' && e.atkOf(xyz) === 2400 + 300, 'sent to the GY because the monster became an Xyz Material: Xyz Monsters you control gain 300 ATK');
}

section('Fusion Devourer');
{
  const e = duel(['Fusion Devourer'], [], [], ['Elemental HERO Flame Wingman']);
  const fd = place(e, 0, 'Fusion Devourer')!;
  const fw = placeX(e, 1, 'Elemental HERO Flame Wingman')!;
  oppAttack(e, fw, fd);
  check(zone(e, fw) === 'gy' && zone(e, fd) === 'mz' && lp(e, 1) === 4000 - 1400, "battling a Fusion Monster: that monster's ATK is 0");
}

section('Fusion Gate');
{
  const e = duel(['Fusion Gate', 'Elemental HERO Avian', 'Elemental HERO Burstinatrix'], [], ['Elemental HERO Flame Wingman']);
  const fg = playSpell(e, 0, 'Fusion Gate')!;
  grab(e, 0, 'Elemental HERO Avian');
  grab(e, 0, 'Elemental HERO Burstinatrix');
  effect(e, 0, fg);
  check(!!onField(e, 0, 'Elemental HERO Flame Wingman') && e.player(0).removed.length === 2, 'Fusion Summons by banishing the Fusion Materials');
}

section('Fusion Sword Murasame Blade');
{
  const e = duel(['Fusion Sword Murasame Blade', 'Gemini Elf']);
  place(e, 0, 'Gemini Elf');
  const m = place(e, 0, FILL)!;
  const sw = playSpell(e, 0, 'Fusion Sword Murasame Blade', { pick: [FILL] });
  check(sw?.equippedTo === m.uid && e.atkOf(m) === 1400 + 800, 'equipped to a Warrior: +800 ATK');
  kill(e, [sw], 1);
  check(zone(e, sw) === 'sz', 'cannot be destroyed by card effects while equipped');
}

section('Fusion Weapon');
{
  const e = duel(['Fusion Weapon'], [], ['Elemental HERO Flame Wingman']);
  place(e, 0, FILL);
  check(!e.canActivateMain(0, grab(e, 0, 'Fusion Weapon').uid), 'only for a Level 6 or lower Fusion Monster');
  const fw = placeX(e, 0, 'Elemental HERO Flame Wingman')!;
  playSpell(e, 0, 'Fusion Weapon', { pick: ['Elemental HERO Flame Wingman'] });
  check(e.atkOf(fw) === 2100 + 1500 && e.defOf(fw) === 1200 + 1500, 'the equipped monster gains 1500 ATK and DEF');
}

section('Future Fusion');
{
  const e = duel(['Future Fusion', FILL, FILL, FILL, 'Elemental HERO Avian', 'Elemental HERO Burstinatrix'], [], ['Elemental HERO Flame Wingman']);
  const ff = playSpell(e, 0, 'Future Fusion')!;
  toTurn3(e);
  check(inGy(e, 0, 'Elemental HERO Avian') && inGy(e, 0, 'Elemental HERO Burstinatrix'), '1st Standby Phase: shows a Fusion Monster and sends its materials from the Deck to the GY');
  toTurn3(e);
  const fw = onField(e, 0, 'Elemental HERO Flame Wingman');
  check(!!fw && ff.equippedTo === fw.uid, '2nd Standby Phase: Fusion Summons it');
  kill(e, [ff], 1);
  check(zone(e, fw) === 'gy', 'leaves the field: the monster is destroyed');
}

section('Gaap the Divine Soldier');
{
  const e = duel(['Gaap the Divine Soldier', 'Fire Sorcerer', 'Archfiend Soldier', 'Bio Plant']);
  const fs = place(e, 0, 'Fire Sorcerer', 'def', false)!;
  const def = place(e, 0, FILL, 'def')!;
  const gaap = place(e, 0, 'Gaap the Divine Soldier')!;
  check(fs.faceUp && fs.pos === 'atk' && def.pos === 'atk' && !e.canChangePosition(0, def), 'all monsters change to Attack Position (face-down ones too) and stay there');
  check(lp(e, 1) === 4000, 'FLIP effects are not activated');
  grab(e, 0, 'Archfiend Soldier');
  grab(e, 0, 'Bio Plant');
  effect(e, 0, gaap, { pick: ['Archfiend Soldier', 'Bio Plant'] });
  check(e.atkOf(gaap) === 2200 + 600, 'reveals Fiends: +300 ATK each');
}

section('Gagaga Gardna');
{
  const e = duel(['Gagaga Gardna'], [FILL]);
  const g = grab(e, 0, 'Gagaga Gardna');
  const foe = place(e, 1, FILL)!;
  oppAttack(e, foe, null, { respond: 'Gagaga Gardna' });
  check(zone(e, g) === 'mz', 'an opponent declares a direct attack: Special Summoned from the hand');
}
{
  const e = duel(['Gagaga Gardna'], ['Blue-Eyes White Dragon']);
  const g = place(e, 0, 'Gagaga Gardna')!;
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  oppAttack(e, bewd, g, 'yes');
  check(zone(e, g) === 'mz', 'targeted for an attack: discard 1, it is not destroyed by that battle');
}

section('Gaia Plate the Earth Giant');
{
  const e = duel(['Gaia Plate the Earth Giant', 'Haniwa', 'Giant Soldier of Stone', 'Barrel Rock'], ['Blue-Eyes White Dragon']);
  const gp = grab(e, 0, 'Gaia Plate the Earth Giant');
  for (const n of ['Haniwa', 'Giant Soldier of Stone', 'Barrel Rock']) toGy(e, 0, n);
  special(e, 0, gp);
  check(zone(e, gp) === 'mz' && e.player(0).removed.length === 2, 'Special Summoned by banishing 2 Rock monsters from the GY');
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  endTurn(e);
  endTurn(e, 'yes');
  check(zone(e, gp) === 'mz' && e.player(0).removed.length === 3, 'your Standby Phase: banish a Rock monster to keep it');
  toBattle(e);
  attack(e, e.fieldCard(gp.uid), bewd);
  check(zone(e, bewd) === 'gy' && lp(e, 1) === 4000 - (2800 - 1500), 'halves the ATK of the monster it battles');
  endTurn(e);
  endTurn(e);
  check(zone(e, gp) === 'gy', 'no Rock to banish: it is sent to the GY');
}

section('Galaxy Cyclone');
{
  const e = duel(['Galaxy Cyclone', 'Fire Formation - Tenki'], ['Mirror Force', 'Messenger of Peace']);
  const mf = putST(e, 1, 'Mirror Force');
  const gc = grab(e, 0, 'Galaxy Cyclone');
  playSpell(e, 0, 'Galaxy Cyclone');
  check(zone(e, mf) === 'gy', 'destroys a Set Spell/Trap');
  endTurn(e);
  const mop = playSpell(e, 1, 'Messenger of Peace');
  endTurn(e, 'no');
  check(e.canUseGraveEffect(0, gc.uid), 'not the turn it was sent: the GY effect can be used');
  graveFx(e, 0, gc);
  check(zone(e, gc) === 'removed' && zone(e, mop) === 'gy', 'banished from the GY: destroys a face-up Spell/Trap');
}

section('Galaxy Tyranno');
{
  const e = duel(['Galaxy Tyranno', 'Galaxy Tyranno'], [FILL], ['Galaxy-Eyes Cipher Dragon']);
  const t1 = place(e, 0, 'Galaxy Tyranno')!;
  const t2 = grab(e, 0, 'Galaxy Tyranno');
  const foe = place(e, 1, FILL)!;
  oppAttack(e, foe, t1, { respond: 'Galaxy Tyranno' }, 'yes');
  const cipher = onField(e, 0, 'Galaxy-Eyes Cipher Dragon');
  check(!!cipher && zone(e, t2) !== 'hand', 'a "Galaxy" monster is targeted for an attack: Special Summoned in Defense Position, then Xyz Summons a "Galaxy" Xyz Monster');
  check(!!cipher && (cipher.mats ?? []).length === 2, 'using only "Galaxy" monsters you control');
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
if (fails) process.exit(1);
