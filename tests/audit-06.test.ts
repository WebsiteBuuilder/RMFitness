// Audit of the Speed Duel card scripts of batch 06 (run: npx tsx tests/audit-06.test.ts)
// At least one check per card that its main effect really happens in a duel (and, where cheap, that it does not when it should not).
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
import { noBattleDamage } from '../src/eds/speed/helpers';
import type { CardInfo } from '../src/eds/types';

// Cards this game's pool lacks: test-only stand-ins added to the card database.
const fake = (info: Partial<CardInfo> & { name: string }) => {
  const full = { id: 990000 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
fake({ name: 'Galaxy-Eyes Test Dragon', level: 8, atk: 3000, def: 2500, race: 'Dragon', attribute: 'LIGHT' });
fake({ name: 'Gem-Knight Test Fusion', sub: 'Fusion', level: 6, atk: 2400, def: 1000, race: 'Rock', attribute: 'EARTH', desc: '"Gem-Knight Emerald" + "Celtic Guardian"' });
fake({ name: 'Legendary Six Samurai - Test', level: 4, atk: 1500, def: 1000, race: 'Warrior', attribute: 'EARTH' });
for (const x of ['A', 'B', 'C']) fake({ name: `Scrap Test ${x}`, level: 3, atk: 1000, def: 1000, race: 'Machine', attribute: 'EARTH' });
fake({ name: 'Graydle Test Slime', level: 3, atk: 1000, def: 1000, race: 'Aqua', attribute: 'WATER' });
fake({ name: 'Steelswarm Test Roach', level: 5, atk: 1900, def: 0, race: 'Insect', attribute: 'DARK' });

/** Sends a card of `p` (hand or Deck) to the GY. */
function toGy(e: Engine, p: Pid, name: string): Card {
  const c = grab(e, p, name);
  run(e, e.sendToGrave(c.uid, 'cost'));
  return c;
}
const special = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'SPECIAL', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const flip = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'FLIP_SUMMON', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const graveFx = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'GRAVE_EFFECT', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const onField = (e: Engine, p: Pid, name: string) => e.monsters(p).find((m) => m.name === name) ?? null;
/** Player 0 activates "Monster Reborn" on a card in a GY; true when it was Special Summoned. */
const reborn = (e: Engine, c: Card) => {
  playSpell(e, 0, 'Monster Reborn', { pick: [c.name] });
  return zone(e, c) === 'mz';
};
const inHand = (e: Engine, p: Pid, name: string) =>e.player(p).hand.some((c) => c.name === name);
const GK = "Gravekeeper's";

// ======================= Effect Monsters =======================
section('Galaxy-Eyes Cloudragon');
{
  const e = duel(['Galaxy-Eyes Cloudragon', 'Galaxy-Eyes Test Dragon', 'Galaxy-Eyes Cloudragon'], [], ['Number 62: Galaxy-Eyes Prime Photon Dragon']);
  const cd = place(e, 0, 'Galaxy-Eyes Cloudragon')!;
  grab(e, 0, 'Galaxy-Eyes Test Dragon');
  effect(e, 0, cd);
  check(zone(e, cd) === 'gy' && onField(e, 0, 'Galaxy-Eyes Test Dragon'), 'Tribute it: Special Summon a "Galaxy-Eyes" monster from the hand');
  const x = place(e, 0, 'Number 62: Galaxy-Eyes Prime Photon Dragon')!;
  const before = x.mats?.length ?? 0;
  graveFx(e, 0, cd);
  check(zone(e, cd) === undefined && (x.mats ?? []).some((c) => c.uid === cd.uid) && (x.mats?.length ?? 0) === before + 1, 'in the GY: attached to a "Galaxy-Eyes" Xyz Monster as an Xyz Material');
  const cd2 = toGy(e, 0, 'Galaxy-Eyes Cloudragon');
  check(!e.canUseGraveEffect(0, cd2.uid), 'the attach effect is once per Duel');
}

for (const name of ['Gale Lizard', "Gravekeeper's Guard"]) {
  section(name);
  const e = duel([name], [FILL]);
  const foe = place(e, 1, FILL)!;
  const me = place(e, 0, name, 'def', false)!;
  flip(e, 0, me);
  check(zone(e, foe) === 'hand', "FLIP: the opponent's monster returns to the hand");
}

section('Garuda the Wind Spirit');
{
  const e = duel(['Garuda the Wind Spirit', 'Harpie Lady', 'Garuda the Wind Spirit', 'Monster Reborn'], [FILL]);
  const hl = toGy(e, 0, 'Harpie Lady');
  const g = grab(e, 0, 'Garuda the Wind Spirit');
  check(!e.canNormalSummon(0, g), 'cannot be Normal Summoned');
  special(e, 0, g);
  check(zone(e, g) === 'mz' && zone(e, hl) === 'removed', 'Special Summoned by banishing a WIND monster from the GY');
  const g2 = toGy(e, 0, 'Garuda the Wind Spirit');
  check(!reborn(e, g2) && zone(e, g2) === 'gy', 'cannot be Special Summoned by other ways (Monster Reborn)');
  const foe = place(e, 1, FILL)!;
  endTurn(e);
  endTurn(e);
  check(foe.pos === 'def', "during the opponent's End Phase it changes an opponent's monster's battle position");
}

section('Gear Golem the Moving Fortress');
{
  const e = duel(['Gear Golem the Moving Fortress'], [FILL]);
  place(e, 1, FILL);
  toTurn3(e);
  const gg = place(e, 0, 'Gear Golem the Moving Fortress')!;
  effect(e, 0, gg);
  check(lp(e, 0) === 3200, 'pays 800 LP');
  toBattle(e);
  attack(e, gg, null);
  check(lp(e, 1) === 4000 - 800, 'then it attacks directly');
}

section('Gearfried the Red-Eyes Iron Knight');
{
  const e = duel(['Gearfried the Red-Eyes Iron Knight', 'Axe of Despair'], [FILL, 'Jar of Greed']);
  const gf = place(e, 0, 'Gearfried the Red-Eyes Iron Knight')!;
  const st = putST(e, 1, 'Jar of Greed');
  const axe = grab(e, 0, 'Axe of Despair');
  act(e, 0, axe.uid, 'yes', 'no', 'yes'); // 'no': decline Axe of Despair's own "Tribute 1 monster; put it on top of the Deck"
  check(zone(e, axe) === 'gy' && zone(e, st) === 'gy' && zone(e, gf) === 'mz', 'equipped: destroy the Equip Card, then a Spell/Trap the opponent controls');
}
{
  const e = duel(['Gearfried the Red-Eyes Iron Knight', 'Axe of Despair', 'Red-Eyes Black Dragon']);
  const red = toGy(e, 0, 'Red-Eyes Black Dragon');
  const gf = place(e, 0, 'Gearfried the Red-Eyes Iron Knight')!;
  const axe = grab(e, 0, 'Axe of Despair');
  act(e, 0, axe.uid, 'no');
  check(gf.equips.includes(axe.uid), 'declining keeps the Equip Card');
  effect(e, 0, gf);
  check(zone(e, axe) === 'gy' && zone(e, red) === 'mz', 'send its Equip Card to the GY: Special Summon a Level 7 or lower "Red-Eyes" monster from the GY');
}

section('Gem-Knight Emerald');
{
  const e = duel(['Gem-Knight Emerald'], [], ['Gem-Knight Test Fusion']);
  const em = place(e, 0, 'Gem-Knight Emerald')!;
  const n = place(e, 0, FILL)!;
  const fu = e.player(0).fusion[0];
  run(e, e.sendToGrave(fu.uid, 'cost'));
  effect(e, 0, em);
  check(zone(e, em) === 'removed' && zone(e, n) === 'removed' && zone(e, fu) === 'mz', 'banish it and a Normal Monster: Special Summon a "Gem-Knight" Fusion Monster from the GY');
}

section('Gentlemander');
{
  const e = duel([FILL, 'Gentlemander'], ['Basic Insect', FILL]);
  const mine = place(e, 0, FILL)!;
  grab(e, 0, 'Gentlemander');
  endTurn(e);
  const foe = place(e, 1, 'Basic Insect')!;
  const foe2 = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, mine, { respond: 'Gentlemander' }, 'yes');
  const gm = onField(e, 0, 'Gentlemander');
  check(!!gm && zone(e, mine) === 'mz' && zone(e, foe) === 'gy', "Special Summoned from the hand when an opponent's monster attacks; the attack goes to it");
  const t = e.legalTargets(1, foe2).map((m) => m.uid);
  check(!!gm && t.includes(gm.uid) && !t.includes(mine.uid), "the opponent's monsters can attack only it");
}

section('Ghost Knight of Jackal');
{
  const e = duel(['Ghost Knight of Jackal'], ['Basic Insect']);
  const foe = place(e, 1, 'Basic Insect')!;
  toTurn3(e);
  const gk = place(e, 0, 'Ghost Knight of Jackal')!;
  toBattle(e);
  attack(e, gk, foe, 'yes');
  check(zone(e, foe) === 'mz' && e.controller(foe.uid) === 0 && e.fieldCard(foe.uid)?.pos === 'def', 'the monster it destroys is Special Summoned to your field in Defense Position');
}

for (const name of ['Giant Orc', 'Goblin Attack Force']) {
  section(name);
  const e = duel([name]);
  toTurn3(e);
  const m = place(e, 0, name)!;
  toBattle(e);
  attack(e, m, null);
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  settle(e);
  check(m.pos === 'def' && !e.canChangePosition(0, m), 'it attacked: Defense Position at the end of the Battle Phase, locked');
  endTurn(e);
  check(e.state.turn === 5 && !e.canChangePosition(0, m), 'still locked during your next turn');
  endTurn(e);
  endTurn(e);
  check(e.state.turn === 7 && e.canChangePosition(0, m), 'free again the turn after');
}

section('Gilasaurus');
{
  const e = duel(['Gilasaurus'], [FILL]);
  toGy(e, 1, FILL);
  const g = grab(e, 0, 'Gilasaurus');
  special(e, 0, g, 'yes');
  check(zone(e, g) === 'mz' && e.monsters(1).length === 1, 'Special Summoned from the hand; the opponent Special Summons a monster from their GY');
}

section('Gilford the Lightning');
{
  const e = duel(['Gilford the Lightning'], [FILL, FILL]);
  for (let i = 0; i < 3; i++) place(e, 0, FILL);
  place(e, 1, FILL);
  place(e, 1, FILL);
  const g = grab(e, 0, 'Gilford the Lightning');
  special(e, 0, g);
  const gm = e.fieldCard(g.uid);
  check(!!gm && gm.tags?.tribS === 3 && e.player(0).normalSummoned && e.monsters(1).length === 0, 'Tribute Summoned with 3 Tributes: destroys all monsters the opponent controls');
}
{
  const e = duel(['Gilford the Lightning'], [FILL]);
  place(e, 0, FILL);
  place(e, 0, FILL);
  place(e, 1, FILL);
  const g = summon(e, 0, 'Gilford the Lightning');
  check(!!g && e.monsters(1).length === 1, 'a 2-Tribute Summon destroys nothing');
}

section('Gimmick Puppet Des Troy');
{
  const e = duel(['Gimmick Puppet Des Troy', 'Gimmick Puppet Gear Changer', 'Gimmick Puppet Gear Changer']);
  const dt = place(e, 0, 'Gimmick Puppet Des Troy')!;
  const gc = summon(e, 0, 'Gimmick Puppet Gear Changer')!;
  effect(e, 0, dt, { pick: ['Gimmick Puppet Gear Changer'] });
  check(zone(e, gc) === 'gy', 'destroys a targeted "Gimmick Puppet" monster');
  check(!e.canUseMonsterEffect(0, dt), 'only once while face-up');
  const gc2 = grab(e, 0, 'Gimmick Puppet Gear Changer');
  kill(e, [dt], 1, 'yes');
  check(zone(e, gc2) === 'mz', 'sent from the field to the GY: Special Summon "Gimmick Puppet" monsters from the hand');
}

section('Gimmick Puppet Shadow Feeler');
{
  const e = duel([FILL, 'Gimmick Puppet Shadow Feeler'], [FILL]);
  const sf = toGy(e, 0, 'Gimmick Puppet Shadow Feeler');
  endTurn(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, null, { respond: 'Gimmick Puppet Shadow Feeler' });
  check(zone(e, sf) === 'mz' && lp(e, 0) === 4000 - 1400 - 1000, 'a direct attack hurt you: Special Summon it from the GY, then take 1000 damage');
  check(e.shielded(e.fieldCard(sf.uid)!, 'battle'), 'cannot be destroyed by battle');
}

section('Goblin King');
{
  const e = duel(['Goblin King', 'Archfiend Soldier'], [FILL]);
  const gk = place(e, 0, 'Goblin King')!;
  const foe = place(e, 1, FILL)!;
  check(e.legalTargets(1, foe).some((t) => t.uid === gk.uid), 'can be attacked with no other Fiend');
  place(e, 0, 'Archfiend Soldier');
  check(e.atkOf(gk) === 1000 && e.defOf(gk) === 1000, 'ATK/DEF = 1000 x other Fiend monsters');
  check(!e.legalTargets(1, foe).some((t) => t.uid === gk.uid), 'cannot be attacked while you control another Fiend');
}

section('Goblin Zombie');
{
  const e = duel([FILL, 'Goblin Zombie', 'Goblin Zombie'], [FILL]);
  toTurn3(e);
  const gz = place(e, 0, 'Goblin Zombie')!;
  toBattle(e);
  const top = e.player(1).deck[0];
  attack(e, gz, null);
  check(zone(e, top) === 'gy', "battle damage: the top card of the opponent's Deck goes to the GY");
  const other = e.player(0).deck.find((c) => c.name === 'Goblin Zombie')!;
  kill(e, [gz], 1);
  check(zone(e, other) === 'hand', 'sent from the field to the GY: adds a Zombie with 1200 or less DEF');
}

section('Gokipon');
{
  const e = duel(['Gokipon', 'Basic Insect'], [FILL]);
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  const gk = place(e, 0, 'Gokipon')!;
  toBattle(e);
  attack(e, gk, foe, 'yes');
  check(zone(e, gk) === 'gy' && inHand(e, 0, 'Basic Insect'), 'destroyed by battle: adds an Insect with 1500 or less ATK');
}

section('Jade Knight');
{
  const e = duel(['Jade Knight', 'Karakuri Spider'], [FILL, 'Mirror Force']);
  putST(e, 1, 'Mirror Force');
  toTurn3(e);
  const jk = place(e, 0, 'Jade Knight')!;
  const ks = place(e, 0, 'Karakuri Spider')!;
  const w = place(e, 0, FILL)!;
  toBattle(e);
  attack(e, w, null, { respond: 'Mirror Force' });
  check(zone(e, jk) === 'mz' && zone(e, ks) === 'mz' && zone(e, w) === 'gy', 'Machines with 1200 or less ATK cannot be destroyed by Trap effects (others can)');
}
{
  const e = duel(['Jade Knight', 'Jade Knight'], [FILL]);
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  const jk = place(e, 0, 'Jade Knight')!;
  toBattle(e);
  attack(e, jk, foe, 'yes');
  check(zone(e, jk) === 'gy' && inHand(e, 0, 'Jade Knight'), 'destroyed by battle: adds a Level 4 LIGHT Machine');
}

section('Golden Homunculus');
{
  const e = duel(['Golden Homunculus']);
  const gh = place(e, 0, 'Golden Homunculus')!;
  for (const c of e.player(0).hand.slice(0, 2)) e.banish(c.uid);
  check(e.atkOf(gh) === 2100 && e.defOf(gh) === 2100, 'gains 300 ATK/DEF for each banished card');
}

section('Golden Ladybug');
{
  const e = duel(['Golden Ladybug']);
  const c = grab(e, 0, 'Golden Ladybug');
  effect(e, 0, c);
  check(lp(e, 0) === 4500 && !e.canUseMonsterEffect(0, c), 'revealed: gain 500 LP (once per turn)');
}

section('Granadora');
{
  const e = duel(['Granadora']);
  const g = place(e, 0, 'Granadora')!;
  check(lp(e, 0) === 5000, 'Summoned: gain 1000 LP');
  kill(e, [g], 1);
  check(lp(e, 0) === 3000, 'destroyed: you take 2000 damage');
}

section('Grandmaster of the Six Samurai');
{
  const e = duel(['Grandmaster of the Six Samurai', 'Legendary Six Samurai - Test', 'Legendary Six Samurai - Test', 'Grandmaster of the Six Samurai'], [FILL]);
  place(e, 0, 'Legendary Six Samurai - Test');
  const gm = grab(e, 0, 'Grandmaster of the Six Samurai');
  special(e, 0, gm);
  check(zone(e, gm) === 'mz', 'Special Summoned from the hand while you control a "Six Samurai" monster');
  check(e.summonBlocked(0, grab(e, 0, 'Grandmaster of the Six Samurai'), 'normal', 'hand'), 'you can only control 1');
  const s2 = toGy(e, 0, 'Legendary Six Samurai - Test');
  kill(e, [gm], 1);
  check(zone(e, s2) === 'hand', "destroyed by the opponent's card effect: adds a \"Six Samurai\" monster from the GY");
}

section('Granmarg the Rock Monarch');
{
  const e = duel(['Granmarg the Rock Monarch'], [FILL, 'Jar of Greed']);
  const st = putST(e, 1, 'Jar of Greed');
  place(e, 0, FILL);
  const g = summon(e, 0, 'Granmarg the Rock Monarch');
  check(g?.tags?.tribS === 1 && zone(e, st) === 'gy', 'Tribute Summoned: destroys a Set card');
}
{
  const e = duel(['Granmarg the Rock Monarch'], [FILL, 'Jar of Greed']);
  const st = putST(e, 1, 'Jar of Greed');
  place(e, 0, 'Granmarg the Rock Monarch');
  check(zone(e, st) === 'sz', 'Special Summoned: nothing happens');
}

// ---------- Gravekeeper's ----------
section("Gravekeeper's Ambusher");
{
  const e = duel([`${GK} Ambusher`, 'Necrovalley', 'Necrovalley'], [FILL]);
  const og = toGy(e, 1, FILL);
  playSpell(e, 0, 'Necrovalley');
  const amb = place(e, 0, `${GK} Ambusher`, 'def', false)!;
  flip(e, 0, amb);
  const d = e.player(1).deck;
  check(d[d.length - 1].uid === og.uid, "flipped: a card in the opponent's GY goes to the bottom of their Deck (unaffected by Necrovalley)");
  const nv = toGy(e, 0, 'Necrovalley');
  kill(e, [amb], 1, 'yes');
  check(zone(e, nv) === 'hand', 'sent from the field to the GY after being flipped: adds a "Necrovalley" from the GY');
}

section("Gravekeeper's Assailant");
{
  const e = duel([`${GK} Assailant`, 'Necrovalley'], [FILL]);
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  playSpell(e, 0, 'Necrovalley');
  const a = place(e, 0, `${GK} Assailant`)!;
  toBattle(e);
  attack(e, a, foe, { respond: `${GK} Assailant` });
  check(zone(e, foe) === 'gy' && lp(e, 1) === 4000, "it attacks with Necrovalley out: the target's battle position is changed (no damage)");
}

section("Gravekeeper's Cannonholder");
{
  const e = duel([`${GK} Cannonholder`, `${GK} Spy`]);
  const c = place(e, 0, `${GK} Cannonholder`)!;
  const spy = place(e, 0, `${GK} Spy`)!;
  effect(e, 0, c);
  check(zone(e, spy) === 'gy' && lp(e, 1) === 3300, 'Tribute a "Gravekeeper\'s" monster: 700 damage');
}

section("Gravekeeper's Chief");
{
  const e = duel([`${GK} Chief`, `${GK} Spy`, `${GK} Chief`, 'Necrovalley'], [FILL]);
  const spy = toGy(e, 0, `${GK} Spy`);
  place(e, 0, FILL);
  const chief = summon(e, 0, `${GK} Chief`, true, 'yes');
  check(!!chief && zone(e, spy) === 'mz', 'Tribute Summoned: Special Summons a "Gravekeeper\'s" monster from the GY');
  check(e.summonBlocked(0, grab(e, 0, `${GK} Chief`), 'normal', 'hand'), 'you can only control 1 face-up "Gravekeeper\'s Chief"');
  playSpell(e, 0, 'Necrovalley');
  const mine = toGy(e, 0, FILL);
  const theirs = toGy(e, 1, FILL);
  check(!e.graveLocked(mine.uid) && e.graveLocked(theirs.uid), 'your GY is unaffected by Necrovalley');
}

section("Gravekeeper's Commandant");
{
  const e = duel([`${GK} Commandant`, 'Necrovalley']);
  const c = grab(e, 0, `${GK} Commandant`);
  effect(e, 0, c);
  check(zone(e, c) === 'gy' && inHand(e, 0, 'Necrovalley'), 'discard it: add "Necrovalley"');
}

section("Gravekeeper's Curse");
{
  const e = duel([`${GK} Curse`]);
  place(e, 0, `${GK} Curse`);
  check(lp(e, 1) === 3500, 'Summoned: 500 damage');
}

section("Gravekeeper's Descendant");
{
  const e = duel([`${GK} Descendant`, `${GK} Spy`], [FILL]);
  const foe = place(e, 1, FILL)!;
  const d = place(e, 0, `${GK} Descendant`)!;
  const spy = place(e, 0, `${GK} Spy`)!;
  effect(e, 0, d);
  check(zone(e, spy) === 'gy' && zone(e, foe) === 'gy', 'Tribute another "Gravekeeper\'s": destroy a card the opponent controls');
}

section("Gravekeeper's Oracle");
{
  const e = duel([`${GK} Oracle`, `${GK} Spy`], [FILL]);
  const foe = place(e, 1, FILL)!;
  place(e, 0, `${GK} Spy`);
  const o = grab(e, 0, `${GK} Oracle`);
  check(!e.canNormalSummon(0, o), 'cannot be Normal Summoned the usual way');
  special(e, 0, o, { pick: ['Tribute 1 "Gravekeeper\'s" monster'] }, 'yes');
  const om = e.fieldCard(o.uid);
  check(!!om && om.tags?.tribS === 1 && e.atkOf(om) === 2400 && e.player(0).normalSummoned, 'Tribute Summoned with 1 "Gravekeeper\'s": gains 100 ATK x the Tributed Levels');
  check(e.atkOf(foe) === 1400, 'only 1 effect for 1 "Gravekeeper\'s" Tributed');
}

section("Gravekeeper's Priestess");
{
  const e = duel([`${GK} Priestess`, `${GK} Spy`, 'Monster Reborn', 'Monster Reborn'], [FILL]);
  const pr = place(e, 0, `${GK} Priestess`);
  const spy = place(e, 0, `${GK} Spy`)!;
  check(e.atkOf(spy) === 1200 + 200 + 500, '"Gravekeeper\'s" monsters gain 200 (and Necrovalley\'s 500: the field is "Necrovalley")');
  const g = toGy(e, 1, FILL);
  check(!reborn(e, g) && zone(e, g) === 'gy', "Necrovalley's Graveyard lock applies (Monster Reborn fails)");
  kill(e, [pr]);
  check(reborn(e, g), 'Priestess gone: Monster Reborn works again');
}

section("Gravekeeper's Recruiter");
{
  const e = duel([`${GK} Recruiter`, `${GK} Curse`]);
  const r = place(e, 0, `${GK} Recruiter`)!;
  kill(e, [r], 1);
  check(inHand(e, 0, `${GK} Curse`), 'sent to the GY: adds a "Gravekeeper\'s" monster with 1500 or less DEF');
}

section("Gravekeeper's Shaman");
{
  const e = duel([`${GK} Shaman`, `${GK} Spy`, `${GK} Curse`, 'Necrovalley'], [FILL, 'Pandemonium']);
  toGy(e, 0, `${GK} Spy`);
  toGy(e, 0, `${GK} Curse`);
  const sh = place(e, 0, `${GK} Shaman`)!;
  check(e.defOf(sh) === 1900, 'gains 200 DEF for each "Gravekeeper\'s" monster in your GY');
  playSpell(e, 0, 'Necrovalley');
  const field = e.player(0).field!;
  run(e, e.as(1, e.destroy([field.uid])));
  check(zone(e, field) === 'field', "with Necrovalley: Field Spells cannot be destroyed by the opponent's effects");
  check(e.cardActivationLocked(1, grab(e, 1, 'Pandemonium')), 'and the opponent cannot activate Field Spells');
}

section("Gravekeeper's Spear Soldier");
{
  const e = duel([`${GK} Spear Soldier`], [FILL]);
  place(e, 1, FILL, 'def');
  toTurn3(e);
  const s = place(e, 0, `${GK} Spear Soldier`)!;
  toBattle(e);
  attack(e, s, e.monsters(1)[0]);
  check(lp(e, 1) === 3700, 'piercing battle damage');
}

section("Gravekeeper's Spy");
{
  const e = duel([`${GK} Spy`, `${GK} Curse`]);
  const spy = place(e, 0, `${GK} Spy`, 'def', false)!;
  flip(e, 0, spy);
  check(!!onField(e, 0, `${GK} Curse`), 'FLIP: Special Summons a "Gravekeeper\'s" monster with 1500 or less ATK from the Deck');
}

section("Gravekeeper's Vassal");
{
  const e = duel([`${GK} Vassal`]);
  toTurn3(e);
  const v = place(e, 0, `${GK} Vassal`)!;
  noBattleDamage(e, 1, true);
  toBattle(e);
  attack(e, v, null);
  check(lp(e, 1) === 3300, 'its battle damage is effect damage ("no battle damage" does not stop it)');
}

section('Gravitic Orb');
{
  const e = duel(['Gravitic Orb'], [FILL]);
  const foe = place(e, 1, FILL)!;
  const o = place(e, 0, 'Gravitic Orb', 'def', false)!;
  flip(e, 0, o);
  check(foe.pos === 'def', "FLIP: the opponent's face-up monsters change battle position");
}

section('Great Phantom Thief');
{
  const e = duel(['Great Phantom Thief'], ['Pot of Greed']);
  const pot = grab(e, 1, 'Pot of Greed');
  toTurn3(e);
  const t = place(e, 0, 'Great Phantom Thief')!;
  toBattle(e);
  attack(e, t, null, { pick: ['Pot of Greed'] });
  check(zone(e, pot) === 'gy', "battle damage: declare a name; those cards in the opponent's hand are discarded");
}

section('Green Baboon, Defender of the Forest');
{
  const e = duel(['Green Baboon, Defender of the Forest', 'Archfiend Marmot of Nefariousness'], [FILL]);
  const gb = grab(e, 0, 'Green Baboon, Defender of the Forest');
  const b = place(e, 0, 'Archfiend Marmot of Nefariousness')!;
  kill(e, [b], 1, 'yes');
  check(zone(e, gb) === 'mz' && lp(e, 0) === 3000, 'a face-up Beast you control is destroyed: pay 1000 LP to Special Summon it from the hand');
}
{
  const e = duel(['Green Baboon, Defender of the Forest', 'Archfiend Marmot of Nefariousness'], [FILL]);
  const gb = toGy(e, 0, 'Green Baboon, Defender of the Forest');
  const b = place(e, 0, 'Archfiend Marmot of Nefariousness')!;
  kill(e, [b], 1, 'yes');
  check(zone(e, gb) === 'mz', '...or from the GY');
}
{
  const e = duel(['Green Baboon, Defender of the Forest', 'Archfiend Marmot of Nefariousness'], [FILL]);
  const gb = grab(e, 0, 'Green Baboon, Defender of the Forest');
  const b = place(e, 0, 'Archfiend Marmot of Nefariousness')!;
  endTurn(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, b, 'yes');
  check(zone(e, b) === 'gy' && zone(e, gb) === 'hand', 'not when the Beast is destroyed by battle (Damage Step)');
}

section('Gren Maju Da Eiza');
{
  const e = duel(['Gren Maju Da Eiza']);
  const g = place(e, 0, 'Gren Maju Da Eiza')!;
  for (const c of e.player(0).hand.slice(0, 3)) e.banish(c.uid);
  check(e.atkOf(g) === 1200 && e.defOf(g) === 1200, 'ATK/DEF = 400 x your banished cards');
}

section('Guardian Angel Joan');
{
  const e = duel(['Guardian Angel Joan'], [FILL]);
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  const j = place(e, 0, 'Guardian Angel Joan')!;
  toBattle(e);
  attack(e, j, foe);
  check(lp(e, 0) === 5400, 'gain LP equal to the original ATK of the monster it destroyed');
}

section('Guardian Sphinx');
{
  const e = duel(['Guardian Sphinx'], [FILL, FILL]);
  const foes = [place(e, 1, FILL)!, place(e, 1, FILL)!];
  const s = place(e, 0, 'Guardian Sphinx', 'def', false)!;
  flip(e, 0, s);
  check(foes.every((f) => zone(e, f) === 'hand'), "Flip Summoned: all the opponent's monsters return to the hand");
}
{
  const e = duel(['Guardian Sphinx']);
  const s = place(e, 0, 'Guardian Sphinx')!;
  s.placedTurn = -1;
  effect(e, 0, s);
  check(!s.faceUp && s.pos === 'def', 'once per turn: it changes to face-down Defense Position');
}

section('Guiding Light');
{
  const e = duel(['Guiding Light', 'Winged Kuriboh']);
  const wk = toGy(e, 0, 'Winged Kuriboh');
  summon(e, 0, 'Guiding Light', true, 'yes');
  check(zone(e, wk) === 'mz', 'Normal Summoned: Special Summons a Level 1 LIGHT monster from the GY');
}

section('Gyroid');
{
  const e = duel(['Gyroid']);
  const g = place(e, 0, 'Gyroid')!;
  check(e.shielded(g, 'battle') && !e.shielded(g, 'battle'), 'cannot be destroyed by battle once per turn');
}

section('Hamon, Lord of Striking Thunder');
{
  const e = duel(['Hamon, Lord of Striking Thunder', 'Insect Barrier', 'Insect Barrier', 'Insect Barrier', 'Hamon, Lord of Striking Thunder', 'Monster Reborn'], [FILL]);
  const sp = [playSpell(e, 0, 'Insect Barrier')!, playSpell(e, 0, 'Insect Barrier')!, playSpell(e, 0, 'Insect Barrier')!];
  const h = grab(e, 0, 'Hamon, Lord of Striking Thunder');
  check(!e.canNormalSummon(0, h), 'cannot be Normal Summoned');
  special(e, 0, h);
  check(zone(e, h) === 'mz' && sp.every((c) => zone(e, c) === 'gy'), 'Special Summoned by sending 3 face-up Continuous Spells to the GY');
  check(!reborn(e, toGy(e, 0, 'Hamon, Lord of Striking Thunder')), 'cannot be Special Summoned by other ways (Monster Reborn)');
  const mine = place(e, 0, FILL)!;
  const foe = place(e, 1, FILL)!;
  e.fieldCard(h.uid)!.pos = 'def';
  const t = e.legalTargets(1, foe).map((m) => m.uid);
  check(t.includes(h.uid) && !t.includes(mine.uid), 'in face-up Defense Position, the opponent can attack only it');
  e.fieldCard(h.uid)!.pos = 'atk';
  toTurn3(e);
  toBattle(e);
  attack(e, e.fieldCard(h.uid), foe);
  check(lp(e, 1) === 4000 - 2600 - 1000, 'destroys a monster by battle: 1000 damage');
}

section('Hannibal Necromancer');
{
  const e = duel(['Hannibal Necromancer', 'Howl of the Wild']);
  const hw = playTrap(e, 0, 'Howl of the Wild')!;
  const hn = summon(e, 0, 'Hannibal Necromancer')!;
  check(hn.counters === 1, 'Normal Summoned: 1 Spell Counter');
  effect(e, 0, hn);
  check(zone(e, hw) === 'gy' && hn.counters === 0, 'remove it: destroy a face-up Trap');
}

// ---------- Harpies ----------
section('Harpie Channeler');
{
  const e = duel(['Harpie Channeler', 'Harpie Queen', 'Harpie Lady', 'Red-Eyes Black Dragon']);
  const ch = place(e, 0, 'Harpie Channeler')!;
  const q = grab(e, 0, 'Harpie Queen');
  effect(e, 0, ch);
  const hl = onField(e, 0, 'Harpie Lady');
  check(zone(e, q) === 'gy' && !!hl && hl.pos === 'def', 'discard a "Harpie" card: Special Summon a "Harpie" monster from the Deck in Defense Position');
  check(levelOf(e, ch) === 4, 'Level 4 without a Dragon');
  place(e, 0, 'Red-Eyes Black Dragon');
  check(levelOf(e, ch) === 7, 'Level 7 while you control a Dragon');
}

section('Harpie Dancer');
{
  const e = duel(['Harpie Dancer', 'Harpie Lady']);
  const hd = place(e, 0, 'Harpie Dancer')!;
  const hl = place(e, 0, 'Harpie Lady')!;
  effect(e, 0, hd, { pick: ['Harpie Lady'] }, 'yes');
  const back = e.fieldCard(hl.uid);
  check(!!back && !back.tags?.ss && !e.player(0).normalSummoned, 'returns a WIND monster to the hand, then Normal Summons a WIND monster (an extra Normal Summon)');
}

section('Harpie Lady 1');
{
  const e = duel(['Harpie Lady 1', 'Harpie Lady']);
  const h1 = place(e, 0, 'Harpie Lady 1')!;
  const hl = place(e, 0, 'Harpie Lady')!;
  check(e.atkOf(hl) === 1600 && e.atkOf(h1) === 1600, 'all WIND monsters gain 300 ATK');
  check(e.effectOn(h1)?.fieldName?.(e, h1) === 'Harpie Lady', 'treated as "Harpie Lady"');
}

section('Harpie Lady 3');
{
  const e = duel(['Harpie Lady 3'], [`${GK} Spy`]);
  const foe = place(e, 1, `${GK} Spy`, 'def')!;
  toTurn3(e);
  const h3 = place(e, 0, 'Harpie Lady 3')!;
  toBattle(e);
  attack(e, h3, foe);
  check(foe.tags?.noAttackTurn === 4 && foe.tags?.noAttackTurn2 === 6, "the monster it battled cannot attack during the opponent's next 2 turns");
  endTurn(e);
  foe.pos = 'atk';
  toBattle(e);
  check(!e.canAttackWith(1, foe), '...it cannot declare an attack');
}

section('Harpie Queen');
{
  const e = duel(['Harpie Queen', "Harpies' Hunting Ground"]);
  const q = grab(e, 0, 'Harpie Queen');
  effect(e, 0, q);
  check(zone(e, q) === 'gy' && inHand(e, 0, "Harpies' Hunting Ground"), 'discard it: add "Harpies\' Hunting Ground"');
}

section("Harpie's Pet Dragon - Fearsome Fire Blast");
{
  const e = duel(["Harpie's Pet Dragon - Fearsome Fire Blast", 'Harpie Lady', 'Harpie Lady'], [FILL]);
  const hl = place(e, 0, 'Harpie Lady')!;
  const f = grab(e, 0, "Harpie's Pet Dragon - Fearsome Fire Blast");
  special(e, 0, f);
  check(zone(e, f) === 'mz' && e.fieldCard(f.uid)!.pos === 'def', 'Special Summoned from the hand in Defense Position (you control a Level 6 or lower WIND monster)');
  const foe = place(e, 1, FILL)!;
  const t = e.legalTargets(1, foe).map((m) => m.uid);
  check(!t.includes(hl.uid) && t.includes(f.uid), 'Level 6 or lower "Harpie" monsters cannot be attacked');
  kill(e, [e.fieldCard(f.uid)], 1, 'yes');
  check(e.player(0).gy.filter((c) => c.name === 'Harpie Lady').length === 1, 'sent from the field to the GY: sends a WIND Winged Beast from the Deck to the GY');
}

section("Harpies' Hunting Ground");
{
  const e = duel(["Harpies' Hunting Ground", 'Harpie Lady'], [FILL, 'Jar of Greed']);
  const st = putST(e, 1, 'Jar of Greed');
  playSpell(e, 0, "Harpies' Hunting Ground");
  const hl = summon(e, 0, 'Harpie Lady', true, { pick: ['Face-down card'] })!;
  check(e.atkOf(hl) === 1500 && e.defOf(hl) === 1600, 'Winged Beasts gain 200 ATK/DEF');
  check(zone(e, st) === 'gy', '"Harpie Lady" Summoned: its summoner destroys a Spell/Trap');
}

section('Hysteric Party');
{
  const e = duel(['Hysteric Party', 'Harpie Lady', 'Harpie Lady 1']);
  const a = toGy(e, 0, 'Harpie Lady');
  const b = toGy(e, 0, 'Harpie Lady 1');
  const hp = playTrap(e, 0, 'Hysteric Party')!;
  check(zone(e, a) === 'mz' && zone(e, b) === 'mz', 'discard 1: Special Summons every "Harpie Lady" from the GY');
  kill(e, [hp], 1);
  check(zone(e, a) === 'gy' && zone(e, b) === 'gy', 'when it leaves the field, those monsters are destroyed');
}

section('Hysteric Sign');
{
  const e = duel(['Hysteric Sign', 'Elegant Egotist', 'Harpie Lady', 'Harpie Queen', 'Harpie Channeler']);
  const hs = playSpell(e, 0, 'Hysteric Sign')!;
  check(inHand(e, 0, 'Elegant Egotist'), 'activated: adds "Elegant Egotist"');
  toTurn3(e);
  kill(e, [hs], 1);
  endTurn(e, { pick: ['Harpie Lady', 'Harpie Queen', 'Harpie Channeler'] });
  check(['Harpie Lady', 'Harpie Queen', 'Harpie Channeler'].every((n) => inHand(e, 0, n)), 'sent to the GY this turn: End Phase, adds up to 3 "Harpie" cards with different names');
}

// ---------- Helios ----------
section('Helios - The Primordial Sun');
{
  const e = duel(['Helios - The Primordial Sun', FILL]);
  const h = place(e, 0, 'Helios - The Primordial Sun')!;
  for (const c of e.player(0).hand.slice(0, 2)) e.banish(c.uid);
  check(e.atkOf(h) === 200 && e.defOf(h) === 200, 'ATK/DEF = 100 x banished monsters');
}

for (const [name, from, per, gain] of [['Helios Duo Megistus', 'Helios - The Primordial Sun', 200, 300], ['Helios Trice Megistus', 'Helios Duo Megistus', 300, 500]] as const) {
  section(name);
  const e = duel([name, from], [FILL]);
  for (const c of e.player(0).hand.slice(0, 2)) e.banish(c.uid);
  place(e, 0, from);
  const h = grab(e, 0, name);
  special(e, 0, h);
  const m = e.fieldCard(h.uid);
  check(!!m && e.atkOf(m) === 2 * per, `Special Summoned by Tributing "${from}"; ATK = ${per} x banished monsters`);
  if (name === 'Helios Trice Megistus') {
    place(e, 1, FILL);
    check(e.effectOn(m!)?.attacks?.(e, m!) === 2, 'can attack twice while the opponent controls a monster');
  }
  run(e, e.destroy([h.uid], 'destroyed', true));
  check(zone(e, h) === 'gy', 'destroyed by battle');
  endTurn(e);
  const back = e.fieldCard(h.uid);
  check(!!back && e.atkOf(back) === 2 * per + gain, `Special Summoned during the End Phase with ${gain} more ATK`);
}

section('Helping Robo for Combat');
{
  const e = duel(['Helping Robo for Combat'], ['Basic Insect']);
  const foe = place(e, 1, 'Basic Insect')!;
  toTurn3(e);
  const r = place(e, 0, 'Helping Robo for Combat')!;
  toBattle(e);
  const hand = e.player(0).hand.length;
  const deck = e.player(0).deck.length;
  const top = e.player(0).deck[0];
  attack(e, r, foe);
  check(zone(e, foe) === 'gy' && zone(e, top) === 'hand' && e.player(0).hand.length === hand && e.player(0).deck.length === deck && e.player(0).deck[0].uid !== top.uid, 'destroys a monster by battle: draw 1, then 1 card from the hand goes to the bottom of the Deck');
}

section('Heraldic Beast Aberconway');
{
  const e = duel(['Heraldic Beast Aberconway', 'Heraldic Beast Aberconway']);
  const a = toGy(e, 0, 'Heraldic Beast Aberconway');
  const b = toGy(e, 0, 'Heraldic Beast Aberconway');
  graveFx(e, 0, a);
  check(zone(e, b) === 'removed' && zone(e, a) === 'hand', 'banish another Aberconway from the GY: add a "Heraldic Beast" monster from the GY');
}

section('Hieratic Dragon of Nuit');
{
  const e = duel(['Hieratic Dragon of Nuit', 'Red-Eyes Black Dragon', 'Inspiration']);
  place(e, 0, 'Hieratic Dragon of Nuit');
  const insp = putST(e, 0, 'Inspiration');
  act(e, 0, insp.uid, { respond: 'Hieratic Dragon of Nuit' });
  const red = onField(e, 0, 'Red-Eyes Black Dragon');
  check(!!red && e.atkOf(red) === 0 && e.defOf(red) === 0, 'targeted: Special Summons a Dragon Normal Monster with 0 ATK/DEF');
}

section('Hieratic Dragon of Su');
{
  const e = duel(['Hieratic Dragon of Su', 'Hieratic Dragon of Nuit', 'Hieratic Dragon of Nuit', 'Red-Eyes Black Dragon'], [FILL, 'Jar of Greed']);
  place(e, 0, 'Hieratic Dragon of Nuit');
  const su = grab(e, 0, 'Hieratic Dragon of Su');
  special(e, 0, su);
  check(zone(e, su) === 'mz', 'Special Summoned by Tributing a "Hieratic" monster');
  const st = putST(e, 1, 'Jar of Greed');
  const n2 = grab(e, 0, 'Hieratic Dragon of Nuit');
  effect(e, 0, e.fieldCard(su.uid));
  check(zone(e, n2) === 'gy' && zone(e, st) === 'gy', 'Tribute a "Hieratic" monster from the hand: destroy a Spell/Trap the opponent controls');
  run(e, e.sendToGrave(su.uid, 'tribute'));
  const red = onField(e, 0, 'Red-Eyes Black Dragon');
  check(!!red && e.atkOf(red) === 0, 'Tributed: Special Summons a Dragon Normal Monster with 0 ATK/DEF');
}

section('Hino-Kagu-Tsuchi');
{
  const e = duel(['Hino-Kagu-Tsuchi'], [FILL]);
  const h = grab(e, 0, 'Hino-Kagu-Tsuchi');
  check(e.summonBlocked(0, h, 'special', 'hand'), 'cannot be Special Summoned');
  toTurn3(e);
  place(e, 0, FILL);
  place(e, 0, FILL);
  const m = summon(e, 0, 'Hino-Kagu-Tsuchi')!;
  toBattle(e);
  attack(e, m, null);
  check(e.player(1).hand.length === 0, 'battle damage: the opponent discards their hand');
  endTurn(e);
  check(zone(e, h) === 'hand', 'returns to the hand during the End Phase');
}

section('Holding Arms');
{
  const e = duel(['Holding Arms'], [FILL]);
  const foe = place(e, 1, FILL)!;
  const ha = place(e, 0, 'Holding Arms')!;
  check(e.isNegated(foe) && !!foe.cannotAttack, 'the target cannot attack and its effects are negated');
  check(e.shielded(ha, 'effect') && e.shielded(ha, 'battle'), 'cannot be destroyed while the target is on the field');
  kill(e, [foe], 1);
  check(!e.shielded(ha, 'effect'), 'protection ends with the target gone');
}

section('Howling Insect');
{
  const e = duel(['Howling Insect', 'Basic Insect'], [FILL]);
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  const h = place(e, 0, 'Howling Insect')!;
  toBattle(e);
  attack(e, h, foe, 'yes');
  check(zone(e, h) === 'gy' && !!onField(e, 0, 'Basic Insect'), 'destroyed by battle: Special Summons an Insect with 1500 or less ATK from the Deck');
}

section('Humpty Grumpty');
{
  const e = duel(['Humpty Grumpty']);
  const h = place(e, 0, 'Humpty Grumpty', 'def', false)!;
  flip(e, 0, h);
  check(e.atkOf(h) === 2200, 'Flip Summoned: gains 800 ATK');
}

section('Hydrogeddon');
{
  const e = duel([FILL, 'Hydrogeddon', 'Hydrogeddon'], ['Basic Insect']);
  const foe = place(e, 1, 'Basic Insect')!;
  toTurn3(e);
  const h = place(e, 0, 'Hydrogeddon')!;
  toBattle(e);
  attack(e, h, foe, 'yes');
  check(e.monsters(0).filter((m) => m.name === 'Hydrogeddon').length === 2, 'destroys a monster by battle: Special Summons a "Hydrogeddon" from the Deck');
}

section('Hyper Hammerhead');
{
  const e = duel(['Hyper Hammerhead'], [`${GK} Spy`]);
  const foe = place(e, 1, `${GK} Spy`, 'def')!;
  toTurn3(e);
  const h = place(e, 0, 'Hyper Hammerhead')!;
  toBattle(e);
  attack(e, h, foe);
  check(zone(e, foe) === 'hand', 'the monster it battled was not destroyed: it returns to the hand');
}

section('Il Blud');
{
  const e = duel(['Il Blud', 'Goblin Zombie']);
  const z = toGy(e, 0, 'Goblin Zombie');
  const ib = place(e, 0, 'Il Blud')!;
  check(!e.effectOn(ib)!.ignition!.can(e, ib, 0) || !ib.tags?.gemini, 'a Normal Monster until Normal Summoned again');
  effect(e, 0, ib);
  check(ib.tags?.gemini === 1 && e.player(0).normalSummoned, 'Normal Summoned again: it becomes an Effect Monster');
  effect(e, 0, ib);
  check(zone(e, z) === 'mz', 'Special Summons a Zombie from a GY');
  kill(e, [ib], 1);
  check(zone(e, z) === 'gy', 'it leaves the field: that Zombie is destroyed');
}

section('Illusionist Faceless Magician');
{
  const e = duel(['Illusionist Faceless Magician', 'Relinquished'], [FILL]);
  const r = place(e, 0, 'Relinquished')!;
  const ifm = grab(e, 0, 'Illusionist Faceless Magician');
  kill(e, [r], 1, 'yes');
  check(zone(e, ifm) === 'mz', '"Relinquished" you control is destroyed: Special Summon it from the hand');
  kill(e, [e.fieldCard(ifm.uid)], 1, 'yes');
  check(zone(e, r) === 'mz', 'sent from the field to the GY: Special Summons "Relinquished" from the GY');
}

section('Imairuka');
{
  const e = duel(['Imairuka', 'Revival Jam'], [FILL]);
  const im = place(e, 0, 'Imairuka')!;
  const d = e.player(0).deck;
  const rj = d.splice(d.findIndex((c) => c.name === 'Revival Jam'), 1)[0];
  d.unshift(rj);
  const hand = e.player(0).hand.length;
  kill(e, [im], 1);
  check(zone(e, rj) === 'gy' && e.player(0).hand.length === hand + 1, "destroyed by the opponent's card: mill 1; a WATER monster: draw 1");
}
{
  const e = duel(['Imairuka']);
  const im = place(e, 0, 'Imairuka')!;
  const top = e.player(0).deck[0];
  kill(e, [im], 0);
  check(zone(e, top) === 'deck', 'not when destroyed by your own card');
}

section('Imperial Bower');
{
  const e = duel(['Imperial Bower', "Queen's Knight", "King's Knight", "Jack's Knight"]);
  const ib = place(e, 0, 'Imperial Bower')!;
  effect(e, 0, ib, { pick: ["Queen's Knight", "King's Knight"] }, 'yes', 'no');
  check(zone(e, ib) === 'gy' && !!onField(e, 0, "Queen's Knight") && inHand(e, 0, "King's Knight"), 'Tribute it: take 2 different Knights, each added or Special Summoned');
}

section('Imprisoned Queen Archfiend');
{
  const e = duel(['Imprisoned Queen Archfiend']);
  place(e, 0, 'Imprisoned Queen Archfiend');
  toTurn3(e);
  check(lp(e, 0) === 3000, 'pays 1000 LP during your Standby Phase');
}
{
  const e = duel(['Imprisoned Queen Archfiend', 'Pandemonium', 'Archfiend Soldier']);
  toGy(e, 0, 'Imprisoned Queen Archfiend');
  playSpell(e, 0, 'Pandemonium');
  const s = place(e, 0, 'Archfiend Soldier')!;
  toTurn3(e);
  check(e.atkOf(s) === 2900, 'in the GY with Pandemonium: a Level 4 or lower Fiend gains 1000 ATK during your Standby Phase');
}

section('Infernalqueen Archfiend');
{
  const e = duel(['Infernalqueen Archfiend']);
  const iq = place(e, 0, 'Infernalqueen Archfiend')!;
  toTurn3(e);
  check(lp(e, 0) === 3500 && e.atkOf(iq) === 1900, 'pays 500 LP in your Standby Phase; an Archfiend gains 1000 ATK');
}
{
  const e = duel(['Infernalqueen Archfiend'], ['Change of Heart']);
  const iq = place(e, 0, 'Infernalqueen Archfiend')!;
  endTurn(e);
  e.roll = () => 2;
  const coh = playSpell(e, 1, 'Change of Heart');
  check(e.controller(iq.uid) === 0 && !coh && e.player(1).gy.some((c) => c.name === 'Change of Heart'), "targeted by the opponent's card: a roll of 2 or 5 negates it and destroys that card");
}

section('Injection Fairy Lily');
{
  const e = duel(['Injection Fairy Lily'], [FILL]);
  const foe = place(e, 1, FILL)!;
  toTurn3(e);
  const l = place(e, 0, 'Injection Fairy Lily')!;
  toBattle(e);
  attack(e, l, foe, { respond: 'Injection Fairy Lily' });
  check(lp(e, 0) === 2000 && zone(e, foe) === 'gy' && lp(e, 1) === 4000 - 2000 && e.atkOf(l) === 400, 'pay 2000 LP: +3000 ATK for that battle only');
}

section('Insect Princess');
{
  const e = duel(['Insect Princess'], ['Basic Insect']);
  const ins = place(e, 1, 'Basic Insect', 'def')!;
  const ip = place(e, 0, 'Insect Princess')!;
  check(ins.pos === 'atk', "the opponent's Insects are changed to Attack Position");
  toTurn3(e);
  toBattle(e);
  attack(e, ip, ins);
  check(e.atkOf(ip) === 2400, 'destroys an Insect by battle: gains 500 ATK');
}

section('Iron Blacksmith Kotetsu');
{
  const e = duel(['Iron Blacksmith Kotetsu', 'Axe of Despair']);
  const k = place(e, 0, 'Iron Blacksmith Kotetsu', 'def', false)!;
  flip(e, 0, k);
  check(inHand(e, 0, 'Axe of Despair'), 'FLIP: adds an Equip Spell');
}

section('Jinzo - Lord');
{
  const e = duel(['Jinzo - Lord', 'Jinzo', 'Howl of the Wild', 'Jinzo - Lord', 'Monster Reborn']);
  const hw = playTrap(e, 0, 'Howl of the Wild')!;
  const j = place(e, 0, 'Jinzo')!;
  const jl = grab(e, 0, 'Jinzo - Lord');
  special(e, 0, jl);
  check(zone(e, jl) === 'mz' && zone(e, j) === 'gy', 'Special Summoned by sending a face-up "Jinzo" to the GY');
  check(e.trapsNegated() && e.trapsSealed(0), 'Traps cannot be activated and their effects are negated');
  effect(e, 0, e.fieldCard(jl.uid));
  check(zone(e, hw) === 'gy' && lp(e, 1) === 3700, 'destroys all face-up Traps: 300 damage each');
  check(!reborn(e, toGy(e, 0, 'Jinzo - Lord')), 'cannot be Special Summoned by other ways (Monster Reborn)');
}

// ======================= Spells =======================
section('Generation Next');
{
  const e = duel(['Generation Next', 'Elemental HERO Avian', 'Elemental HERO Avian']);
  check(!e.canActivateMain(0, grab(e, 0, 'Generation Next').uid), 'needs lower LP than the opponent');
  e.player(0).lp = 2000;
  playSpell(e, 0, 'Generation Next', 'yes');
  check(!!onField(e, 0, 'Elemental HERO Avian'), 'Special Summons an "Elemental HERO" with ATK <= the LP difference');
  check(e.activationBlocked(0, e.player(0).deck.find((c) => c.name === 'Elemental HERO Avian')!), 'cards with that name cannot be activated this turn');
}

section('Gift of the Martyr');
{
  const e = duel(['Gift of the Martyr', `${GK} Spy`]);
  const a = place(e, 0, FILL)!;
  const b = place(e, 0, `${GK} Spy`)!;
  playSpell(e, 0, 'Gift of the Martyr', { pick: [`${GK} Spy`] }, { pick: [FILL] });
  check(zone(e, b) === 'gy' && e.atkOf(a) === 2600, 'send a monster to the GY: another gains its ATK');
}

section('Goblin Circus');
{
  const e = duel(['Goblin Circus']);
  playSpell(e, 0, 'Goblin Circus');
  const d = e.player(0).deck;
  const bottom = d[d.length - 1];
  endTurn(e, { pick: ['Banish it face-down'] });
  check(zone(e, bottom) === 'removed', 'your End Phase: the bottom card of the Deck is revealed and banished (or put on top)');
}

section('Golden Gearbox');
{
  const e = duel(['Golden Gearbox', 'Karakuri Spider']);
  const k = place(e, 0, 'Karakuri Spider')!;
  playSpell(e, 0, 'Golden Gearbox');
  check(e.atkOf(k) === 900 && e.defOf(k) === 2000, 'a "Karakuri" monster gains 500 ATK and 1500 DEF');
}

section('Grand Convergence');
{
  const e = duel(['Grand Convergence', 'Macro Cosmos'], [FILL]);
  check(!e.canActivateMain(0, grab(e, 0, 'Grand Convergence').uid), 'needs "Macro Cosmos"');
  playTrap(e, 0, 'Macro Cosmos');
  place(e, 0, FILL);
  place(e, 1, FILL);
  playSpell(e, 0, 'Grand Convergence');
  check(lp(e, 1) === 3700 && e.monsters(0).length + e.monsters(1).length === 0, '300 damage and all monsters are destroyed');
}

section("Gravekeeper's Stele");
{
  const e = duel([`${GK} Stele`, `${GK} Spy`, `${GK} Curse`, 'Necrovalley']);
  const a = toGy(e, 0, `${GK} Spy`);
  const b = toGy(e, 0, `${GK} Curse`);
  playSpell(e, 0, 'Necrovalley');
  playSpell(e, 0, `${GK} Stele`);
  check(zone(e, a) === 'hand' && zone(e, b) === 'hand', 'adds 2 "Gravekeeper\'s" monsters from the GY, even with Necrovalley');
}

section('Gravity Axe - Grarl');
{
  const e = duel(['Gravity Axe - Grarl'], [FILL]);
  const m = place(e, 0, FILL)!;
  playSpell(e, 0, 'Gravity Axe - Grarl');
  check(e.atkOf(m) === 1900, 'the equipped monster gains 500 ATK');
  const foe = place(e, 1, FILL)!;
  foe.placedTurn = -1;
  endTurn(e);
  check(!e.canChangePosition(1, foe), "the opponent's monsters cannot change their battle positions");
}

section('Hallowed Life Barrier');
{
  const e = duel(['Hallowed Life Barrier']);
  playTrap(e, 0, 'Hallowed Life Barrier');
  run(e, e.as(1, (function* () { e.damage(0, 800); })()));
  check(lp(e, 0) === 4000, 'this turn, damage you take becomes 0');
}

section('Hammer Shot');
{
  const e = duel(['Hammer Shot'], [`${GK} Spy`]);
  const a = place(e, 0, FILL)!;
  const b = place(e, 1, `${GK} Spy`)!;
  playSpell(e, 0, 'Hammer Shot');
  check(zone(e, a) === 'gy' && zone(e, b) === 'mz', 'destroys the face-up Attack Position monster with the highest ATK');
}

section('H - Heated Heart');
{
  const e = duel(['H - Heated Heart'], [FILL]);
  const foe = place(e, 1, FILL, 'def')!;
  toTurn3(e);
  const m = place(e, 0, FILL)!;
  playSpell(e, 0, 'H - Heated Heart');
  check(e.atkOf(m) === 1900, 'gains 500 ATK');
  toBattle(e);
  attack(e, m, foe);
  check(lp(e, 1) === 3300, 'and inflicts piercing battle damage');
}

section('Infinite Cards');
{
  const e = duel(['Infinite Cards']);
  playSpell(e, 0, 'Infinite Cards');
  for (let i = 0; i < 5; i++) e.toHandOf(e.player(0).deck[0].uid, 0);
  const n = e.player(0).hand.length;
  endTurn(e);
  check(n > 6 && e.player(0).hand.length === n, 'no hand size limit');
}

section('Insect Barrier');
{
  const e = duel(['Insect Barrier'], ['Basic Insect', FILL]);
  playSpell(e, 0, 'Insect Barrier');
  endTurn(e);
  const ins = place(e, 1, 'Basic Insect')!;
  const w = place(e, 1, FILL)!;
  toBattle(e);
  check(!e.canAttackWith(1, ins) && e.canAttackWith(1, w), "the opponent's Insects cannot attack");
}

section('Insect Neglect');
{
  const e = duel(['Insect Neglect', 'Basic Insect'], [FILL]);
  playSpell(e, 0, 'Insect Neglect');
  const ins = toGy(e, 0, 'Basic Insect');
  endTurn(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, null, { respond: 'Insect Neglect' });
  check(lp(e, 0) === 4000 && zone(e, ins) === 'removed', 'banish an Insect from the GY: the attack is negated');
}

section('Iron Draw');
{
  const e = duel(['Iron Draw', 'Karakuri Spider', 'Jade Knight']);
  place(e, 0, 'Karakuri Spider');
  place(e, 0, 'Jade Knight');
  const c = grab(e, 0, 'Iron Draw');
  const n = e.player(0).hand.length;
  act(e, 0, c.uid);
  check(e.player(0).hand.length === n - 1 + 2, 'exactly 2 Machine Effect Monsters: draw 2');
  const f = grab(e, 0, FILL);
  check(!e.summonBlocked(0, f, 'special', 'hand'), 'a first Special Summon is allowed');
  run(e, e.specialSummon(f.uid, 0, 'atk'));
  check(e.summonBlocked(0, grab(e, 0, FILL), 'special', 'hand'), 'then no more Special Summons this turn');
}

section('Hidden Armory');
{
  const e = duel(['Hidden Armory', FILL, 'Axe of Despair']);
  const c = grab(e, 0, 'Hidden Armory');
  const top = e.player(0).deck[0];
  act(e, 0, c.uid);
  check(zone(e, top) === 'gy' && inHand(e, 0, 'Axe of Despair') && e.player(0).normalSummoned, 'mill 1: add an Equip Spell; no Normal Summon this turn');
}

section('Guts of Steel');
{
  const e = duel(['Guts of Steel', 'Scrap Test A', 'Scrap Test B', 'Scrap Test C']);
  const s = ['Scrap Test A', 'Scrap Test B', 'Scrap Test C'].map((n) => toGy(e, 0, n));
  playSpell(e, 0, 'Guts of Steel');
  check(s.filter((c) => zone(e, c) === 'mz').length === 1 && s.filter((c) => zone(e, c) === 'removed').length === 2, 'the opponent picks 1 of 3 "Scrap" monsters to Special Summon; the rest are banished');
}

// ======================= Traps =======================
section('Gem-Enhancement');
{
  const e = duel(['Gem-Enhancement', 'Gem-Knight Emerald']);
  const em = place(e, 0, 'Gem-Knight Emerald')!;
  playTrap(e, 0, 'Gem-Enhancement');
  check(zone(e, em) === 'mz' && e.fieldCard(em.uid)?.tags?.ss === 3, 'Tribute a "Gem-Knight": Special Summon a "Gem-Knight" from the GY');
}

section("Gravekeeper's Trap");
{
  const e = duel([`${GK} Trap`, `${GK} Spy`, 'Exchange of the Spirit'], [FILL]);
  const gt = playTrap(e, 0, `${GK} Trap`)!;
  effect(e, 0, gt);
  check(inHand(e, 0, `${GK} Spy`), 'discard 1: add a "Gravekeeper\'s" monster');
  const g1 = toGy(e, 1, FILL);
  check(!e.summonBlocked(1, g1, 'special', 'gy'), 'no lock without "Exchange of the Spirit" in your GY');
  toGy(e, 0, 'Exchange of the Spirit');
  check(e.summonBlocked(1, g1, 'special', 'gy') && !e.summonBlocked(0, g1, 'special', 'gy'), 'with it: the opponent cannot Special Summon from the GY');
  const drawn = e.player(1).deck[0];
  endTurn(e, { pick: [drawn.name] });
  check(zone(e, drawn) === 'gy', "opponent's draw: declare a name; the drawn card is sent to the GY if it matches");
}

section('Gravelstorm');
{
  const e = duel(['Gravelstorm', 'Insect Barrier'], [FILL, 'Jar of Greed']);
  const ib = playSpell(e, 0, 'Insect Barrier')!;
  const st = putST(e, 1, 'Jar of Greed');
  playTrap(e, 0, 'Gravelstorm');
  check(zone(e, ib) === 'hand' && zone(e, st) === 'hand', 'a Spell/Trap on each side returns to the hand');
}

section('Graydle Combat');
for (const mode of ['Negate the activation, and if you do, destroy that card', 'The activated effect becomes "Destroy that monster"']) {
  const e = duel(['Graydle Test Slime', 'Graydle Combat'], ['Change of Heart']);
  const gs = place(e, 0, 'Graydle Test Slime')!;
  putST(e, 0, 'Graydle Combat');
  endTurn(e);
  playSpell(e, 1, 'Change of Heart', { respond: 'Graydle Combat' }, { pick: [mode] });
  if (mode.startsWith('Negate')) check(zone(e, gs) === 'mz' && e.controller(gs.uid) === 0 && e.player(1).gy.some((c) => c.name === 'Change of Heart'), 'negates a card that targets a "Graydle" monster and destroys it');
  else check(zone(e, gs) === 'gy' && e.monsters(1).length === 0, 'or the effect becomes "Destroy that monster"');
}

section('Half Counter');
{
  const e = duel([FILL, 'Half Counter'], ['Archfiend Soldier']);
  const mine = place(e, 0, FILL)!;
  putST(e, 0, 'Half Counter');
  endTurn(e);
  const foe = place(e, 1, 'Archfiend Soldier')!;
  toBattle(e);
  attack(e, foe, mine, { respond: 'Half Counter' });
  check(zone(e, foe) === 'gy' && e.atkOf(mine) === 1400 + 950, 'the attacked monster gains half the attacker\'s original ATK');
}

section('Haunted Shrine');
{
  const e = duel(['Haunted Shrine', 'Goblin Zombie']);
  const z = toGy(e, 0, 'Goblin Zombie');
  playTrap(e, 0, 'Haunted Shrine');
  check(zone(e, z) === 'mz', 'you control no monsters: Special Summon a Zombie from the GY');
}
{
  const e = duel(['Haunted Shrine', 'Goblin Zombie']);
  const z = toGy(e, 0, 'Goblin Zombie');
  const hs = toGy(e, 0, 'Haunted Shrine');
  graveFx(e, 0, hs);
  check(zone(e, hs) === 'removed' && zone(e, z) === 'mz' && e.isNegated(e.fieldCard(z.uid)!), 'banish it from the GY: Special Summon a Zombie with its effects negated');
}

section('Hero Blast');
{
  const e = duel(['Hero Blast', 'Elemental HERO Sparkman'], [FILL]);
  const sp = toGy(e, 0, 'Elemental HERO Sparkman');
  const foe = place(e, 1, FILL)!;
  playTrap(e, 0, 'Hero Blast');
  check(zone(e, sp) === 'hand' && zone(e, foe) === 'gy', 'adds an "Elemental HERO" Normal Monster, then destroys a monster with ATK <= its ATK');
}

section('Hero Counterattack');
{
  const e = duel([FILL, 'Hero Counterattack', 'Elemental HERO Avian', 'Elemental HERO Avian'], ['Archfiend Soldier']);
  const hero = place(e, 0, 'Elemental HERO Avian')!;
  putST(e, 0, 'Hero Counterattack');
  const ps = e.player(0);
  ps.deck.push(...ps.hand.splice(0));
  const h2 = grab(e, 0, 'Elemental HERO Avian');
  endTurn(e);
  const foe = place(e, 1, 'Archfiend Soldier')!;
  toBattle(e);
  attack(e, foe, hero, { respond: 'Hero Counterattack' });
  check(zone(e, hero) === 'gy' && zone(e, foe) === 'gy' && zone(e, h2) === 'mz', 'an "Elemental HERO" was destroyed by battle: a random "Elemental HERO" from the hand destroys a monster and is Special Summoned');
}

section('Hero Signal');
{
  const e = duel([FILL, 'Hero Signal', 'Elemental HERO Avian'], ['Archfiend Soldier']);
  const mine = place(e, 0, FILL)!;
  putST(e, 0, 'Hero Signal');
  endTurn(e);
  const foe = place(e, 1, 'Archfiend Soldier')!;
  toBattle(e);
  attack(e, foe, mine, { respond: 'Hero Signal' });
  check(!!onField(e, 0, 'Elemental HERO Avian'), 'a monster destroyed by battle: Special Summon a Level 4 or lower "Elemental HERO" from the hand or Deck');
}

section('Hidden Soldiers');
{
  const e = duel(['Hidden Soldiers', 'Archfiend Soldier'], [FILL]);
  putST(e, 0, 'Hidden Soldiers');
  grab(e, 0, 'Archfiend Soldier');
  endTurn(e);
  summon(e, 1, FILL, true, { respond: 'Hidden Soldiers' });
  check(!!onField(e, 0, 'Archfiend Soldier'), 'the opponent Normal Summons: Special Summon a Level 4 or lower DARK monster from the hand');
}

section('Hieratic Seal From the Ashes');
{
  const e = duel(['Hieratic Seal From the Ashes', 'Hieratic Dragon of Nuit', 'Hieratic Dragon of Su'], [FILL]);
  const hs = playTrap(e, 0, 'Hieratic Seal From the Ashes')!;
  const su = grab(e, 0, 'Hieratic Dragon of Su');
  e.banish(su.uid);
  effect(e, 0, hs);
  check(zone(e, su) === 'gy', 'your turn: a banished "Hieratic" monster returns to the GY');
  endTurn(e);
  const nuit = e.player(0).deck.find((c) => c.name === 'Hieratic Dragon of Nuit')!;
  summon(e, 1, FILL, true, { respond: 'Hieratic Seal From the Ashes' });
  check(zone(e, nuit) === 'gy', "opponent's turn: sends a \"Hieratic\" monster from the Deck to the GY");
  kill(e, [hs], 1, { pick: ['Hieratic Dragon of Su'] });
  check(zone(e, su) === 'mz', 'sent from the field to the GY: Special Summons a "Hieratic" monster from the GY');
}

section('Howl of the Wild');
{
  const e = duel(['Howl of the Wild', 'Green Baboon, Defender of the Forest'], ['Basic Insect']);
  playTrap(e, 0, 'Howl of the Wild');
  const foe = place(e, 1, 'Basic Insect')!;
  toTurn3(e);
  const gb = place(e, 0, 'Green Baboon, Defender of the Forest')!;
  toBattle(e);
  attack(e, gb, foe);
  check(lp(e, 1) === 4000 - 2100 - 300, 'your monster destroys one by battle: 300 damage per face-up Beast');
}

section('Hunting Instinct');
{
  const e = duel(['Hunting Instinct', 'Hydrogeddon'], [FILL]);
  putST(e, 0, 'Hunting Instinct');
  grab(e, 0, 'Hydrogeddon');
  endTurn(e);
  place(e, 1, FILL, 'atk', true, { respond: 'Hunting Instinct' });
  check(!!onField(e, 0, 'Hydrogeddon'), 'a monster is Special Summoned to the opponent\'s field: Special Summon a Dinosaur from the hand');
}

section('Impenetrable Attack');
for (const mode of ['A monster cannot be destroyed by battle or card effects', 'You take no battle damage']) {
  const e = duel([FILL, 'Impenetrable Attack'], ['Archfiend Soldier']);
  const mine = place(e, 0, FILL)!;
  putST(e, 0, 'Impenetrable Attack');
  endTurn(e);
  const foe = place(e, 1, 'Archfiend Soldier')!;
  toBattle(e);
  attack(e, foe, mine, { respond: 'Impenetrable Attack' }, { pick: [mode] }, { pick: [FILL] });
  if (mode.startsWith('A monster')) check(zone(e, mine) === 'mz' && lp(e, 0) === 3500, 'a monster cannot be destroyed this Battle Phase');
  else check(zone(e, mine) === 'gy' && lp(e, 0) === 4000, 'or you take no battle damage');
}

section('Infestation Wave');
{
  const e = duel(['Steelswarm Test Roach', 'Infestation Wave'], [FILL]);
  const iw = putST(e, 0, 'Infestation Wave');
  place(e, 0, FILL);
  const s = summon(e, 0, 'Steelswarm Test Roach')!;
  const foe = place(e, 1, FILL)!;
  act(e, 0, iw.uid);
  check(zone(e, s) === 'hand' && zone(e, foe) === 'gy', 'return a Tribute Summoned "Steelswarm": destroy a card the opponent controls');
}
{
  const e = duel(['Steelswarm Test Roach', 'Infestation Wave'], [FILL]);
  const iw = putST(e, 0, 'Infestation Wave');
  place(e, 0, 'Steelswarm Test Roach');
  place(e, 1, FILL);
  check(!e.canActivateMain(0, iw.uid), 'not with a Special Summoned "Steelswarm"');
}

section('Inspiration');
{
  const e = duel(['Inspiration']);
  const m = place(e, 0, FILL)!;
  playTrap(e, 0, 'Inspiration');
  check(e.atkOf(m) === 2100, 'gains 700 ATK');
}

section('Inverse Universe');
{
  const e = duel(['Inverse Universe', `${GK} Spy`]);
  const spy = place(e, 0, `${GK} Spy`)!;
  const n = place(e, 0, FILL)!;
  playTrap(e, 0, 'Inverse Universe');
  check(e.atkOf(spy) === 2000 && e.defOf(spy) === 1200 && e.atkOf(n) === 1400, 'switches the ATK/DEF of face-up Effect Monsters');
}

section('Jam Defender');
{
  const e = duel([FILL, 'Revival Jam', 'Jam Defender'], ['Archfiend Soldier']);
  const mine = place(e, 0, FILL)!;
  place(e, 0, 'Revival Jam');
  playTrap(e, 0, 'Jam Defender');
  endTurn(e);
  const foe = place(e, 1, 'Archfiend Soldier')!;
  toBattle(e);
  const since = e.state.log.length;
  attack(e, foe, mine, { respond: 'Jam Defender' });
  check(zone(e, mine) === 'mz' && logHas(e, 'switches the attack target', since), 'the attack is switched to "Revival Jam"');
}

section('Jar of Greed');
{
  const e = duel(['Jar of Greed']);
  const n = e.player(0).hand.length;
  playTrap(e, 0, 'Jar of Greed');
  check(e.player(0).hand.length === n + 1, 'draw 1 card');
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
if (fails) process.exit(1);
