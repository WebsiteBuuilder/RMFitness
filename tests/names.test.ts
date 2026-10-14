// names: every Speed Duel card whose name changes because of an effect (run: npx tsx tests/names.test.ts)
// Printed name rules ("always treated as", "name becomes ... while on the field"), names given by effects and Skills,
// and the cards that read those names (Fusion Materials, "while you control", Prohibition).
import { Engine } from '../src/eds/engine';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';
import { SPEED } from './speedkit';
import { nameRule } from '../src/eds/names';

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
/** Moves a card of `p` from the Deck or hand straight to the GY (no effects). */
function toGy(e: Engine, p: Pid, c: Card): Card {
  const ps = e.player(p);
  for (const z of ['deck', 'hand'] as const) {
    const i = ps[z].findIndex((x) => x.uid === c.uid);
    if (i >= 0) ps[z].splice(i, 1);
  }
  if (!ps.gy.includes(c)) ps.gy.push(c);
  return c;
}
const faceUpST = (e: Engine, p: Pid, name: string) => {
  const fc = putST(e, p, name);
  fc.faceUp = true;
  return fc;
};
/** The one card of this name in the duel. */
const card = (e: Engine, p: Pid, name: string) => {
  const ps = e.player(p);
  return [...ps.hand, ...ps.deck, ...ps.gy, ...ps.fusion, ...ps.removed].find((x) => x.name === name)!;
};

// ---------- 1. every card with a printed name rule ----------
section('printed name rules');
let rules = 0;
let passed = 0;
for (const info of SPEED) {
  const r = nameRule(info);
  if (!r.also.length && !r.becomes) continue;
  rules++;
  const e = duel([info.name], [], info.sub === 'Fusion' || info.sub === 'Synchro' || info.sub === 'Xyz' || info.sub === 'Link' ? [] : [], []);
  const extra = ['Fusion', 'Synchro', 'Xyz', 'Link'].includes(info.sub);
  if (extra) e.player(0).fusion.push(e.player(0).deck.splice(e.player(0).deck.findIndex((c) => c.name === info.name), 1)[0]);
  const c = card(e, 0, info.name);
  let ok = true;
  const why: string[] = [];
  const want = (got: boolean, what: string) => {
    if (!got) (ok = false), why.push(what);
  };
  if (!extra) e.toHandOf(c.uid, 0);
  // In the hand (or Extra Deck): the printed name plus the "always" names; not the field-only name.
  want(e.namesOf(c)[0] === info.name && r.also.every((n) => e.isNamed(c, n)), 'hand: printed + always names');
  if (r.becomes) want(!e.isNamed(c, r.becomes.name), 'hand: no field name yet');
  // On the field, face-up.
  let fc: FieldCard | null = null;
  if (info.kind === 'monster') fc = place(e, 0, info.name);
  else if (info.sub === 'Field') fc = playSpell(e, 0, info.name);
  else fc = faceUpST(e, 0, info.name);
  if (fc && r.becomes?.gemini) fc.tags = { ...(fc.tags ?? {}), gemini: 1 };
  if (!fc) want(false, 'could not be put on the field');
  else {
    if (r.becomes) want(e.nameOf(fc) === r.becomes.name && !e.isNamed(fc, info.name), `field: named "${r.becomes.name}" instead`);
    else want(e.isNamed(fc, info.name), 'field: printed name');
    want(r.also.every((n) => e.isNamed(fc!, n)), 'field: always names');
    // In the GY.
    run(e, e.sendToGrave(fc.uid, 'used'));
    want(zone(e, fc) === 'gy', 'sent to the GY');
    if (r.becomes) want(e.isNamed(fc, r.becomes.name) === r.becomes.gy, r.becomes.gy ? `GY: still "${r.becomes.name}"` : 'GY: printed name again');
    want(r.also.every((n) => e.isNamed(fc!, n)), 'GY: always names');
  }
  if (ok) passed++;
  check(ok, `${info.name}: ${[...r.also.map((n) => `always "${n}"`), r.becomes ? `"${r.becomes.name}" on the field${r.becomes.gy ? ' and in the GY' : ''}` : ''].filter(Boolean).join(', ')}${why.length ? ` (${why.join('; ')})` : ''}`);
}
check(rules >= 29, `${rules} cards have a printed name rule (found by reading every card's text)`);

// Neos Alius: only while it is an Effect Monster (Gemini Summoned again).
{
  const e = duel(['Elemental HERO Neos Alius']);
  const m = place(e, 0, 'Elemental HERO Neos Alius')!;
  check(e.nameOf(m) === 'Elemental HERO Neos Alius', 'Neos Alius keeps its name while it is a Normal Monster');
  m.tags = { ...(m.tags ?? {}), gemini: 1 };
  check(e.nameOf(m) === 'Elemental HERO Neos', 'Neos Alius is "Elemental HERO Neos" once Gemini Summoned');
}
// Face-down: no field name.
{
  const e = duel(['Harpie Queen']);
  const m = place(e, 0, 'Harpie Queen', 'def', false)!;
  check(!e.isNamed(m, 'Harpie Lady'), 'a face-down Harpie Queen is not "Harpie Lady"');
}

// ---------- 2. names given by effects ----------
section('names given by effects');
{
  const e = duel(['Neo-Spacian Dark Panther'], ['Harpie Queen']);
  const d = place(e, 0, 'Neo-Spacian Dark Panther')!;
  place(e, 1, 'Harpie Queen');
  effect(e, 0, d, { pick: ['Harpie Queen'] });
  check(e.nameOf(d) === 'Harpie Lady', 'Neo-Spacian Dark Panther copies the name a monster has now (Harpie Queen is "Harpie Lady")');
  endTurn(e);
  check(e.nameOf(d) === 'Neo-Spacian Dark Panther', '...until the End Phase');
}
{
  const e = duel(['Elemental HERO Prisma', 'Elemental HERO Avian'], [], ['Elemental HERO Flame Wingman']);
  const pz = place(e, 0, 'Elemental HERO Prisma')!;
  effect(e, 0, pz);
  const gy = e.player(0).gy.find((c) => c.name !== 'Elemental HERO Prisma');
  check(!!gy && e.nameOf(pz) === gy.name, `Elemental HERO Prisma takes the name of the material it sent (${gy?.name})`);
  run(e, e.sendToGrave(pz.uid, 'used'));
  check(e.nameOf(pz) === 'Elemental HERO Prisma', '...and loses it once it leaves the field');
}
{
  const e = duel(["Joker's Knight", "Queen's Knight"]);
  const j = grab(e, 0, "Joker's Knight");
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: j.uid });
  settle(e, { pick: ["Queen's Knight"] });
  const f = e.fieldCard(j.uid);
  check(!!f && e.nameOf(f) === "Queen's Knight", "Joker's Knight's name becomes the Knight it sent");
  endTurn(e);
  check(!!f && e.nameOf(f) === "Joker's Knight", '...until the End Phase');
}
{
  const e = duel(['Mokey Mokey Adrift']);
  const m = place(e, 0, 'Mokey Mokey Adrift')!;
  check(e.isNamed(m, 'Mokey Mokey'), 'Mokey Mokey Adrift is "Mokey Mokey" on the field');
}
{
  const e = duel([], [], ['D Cubed']);
  const d = place(e, 0, 'D Cubed')!;
  d.tags = { ...(d.tags ?? {}), dHero: 1 };
  check(e.nameHas(d, 'Destiny HERO'), 'D Cubed counts as a "Destiny HERO" monster when it says so');
}
{
  const e = duel(['Frightfur Sanctuary'], [], ['Frightfur Wolf']);
  faceUpST(e, 0, 'Frightfur Sanctuary');
  const w = place(e, 0, 'Frightfur Wolf')!;
  check(e.nameHas(w, 'Frightfur'), 'Frightfur Sanctuary: your Fusion Monsters are also "Frightfur" monsters');
}
{
  const e = duel(['Harpie Queen']);
  const m = place(e, 0, 'Harpie Queen')!;
  e.renameUntilEnd(m.uid, 'Celtic Guardian');
  check(e.nameOf(m) === 'Celtic Guardian', 'a rename by an effect overrides the printed rule');
  run(e, e.sendToGrave(m.uid, 'used'));
  check(e.nameOf(m) === 'Harpie Lady', '...and is gone once the card leaves the field (Harpie Queen is "Harpie Lady" in the GY again)');
}

// ---------- 3. cards that read the new names ----------
section('cards that read changed names');
{
  // Fusion Materials: Proto-Cyber Dragon + 2 Cyber Dragon = 3 "Cyber Dragon" for Cyber End Dragon.
  const e = duel(['Proto-Cyber Dragon', 'Cyber Dragon', 'Cyber Dragon', 'Polymerization'], [], ['Cyber End Dragon']);
  place(e, 0, 'Proto-Cyber Dragon');
  place(e, 0, 'Cyber Dragon');
  place(e, 0, 'Cyber Dragon');
  const pol = grab(e, 0, 'Polymerization');
  check(e.canActivateMain(0, pol.uid), 'Polymerization sees Proto-Cyber Dragon as "Cyber Dragon" (Cyber End Dragon)');
  act(e, 0, pol.uid);
  check(e.monsters(0).some((m) => m.name === 'Cyber End Dragon'), 'Cyber End Dragon is Fusion Summoned with it');
}
{
  // "While you control" checks: The Flute of Summoning Dragon needs "Lord of D.".
  const e = duel(['The King of D.', 'The Flute of Summoning Dragon', 'Blue-Eyes White Dragon']);
  place(e, 0, 'The King of D.');
  const f = grab(e, 0, 'The Flute of Summoning Dragon');
  grab(e, 0, 'Blue-Eyes White Dragon');
  check(e.canActivateMain(0, f.uid), 'The King of D. counts as "Lord of D." for The Flute of Summoning Dragon');
}
{
  // Elegant Egotist needs a face-up "Harpie Lady".
  const e = duel(['Harpie Queen', 'Elegant Egotist', 'Harpie Lady Sisters']);
  place(e, 0, 'Harpie Queen');
  const eg = putST(e, 0, 'Elegant Egotist');
  check(e.canActivateMain(0, eg.uid), 'Harpie Queen counts as "Harpie Lady" for Elegant Egotist');
}
{
  // A Legendary Ocean is "Umi" for cards that look for Umi.
  const e = duel(['A Legendary Ocean']);
  const o = playSpell(e, 0, 'A Legendary Ocean')!;
  check(e.isNamed(o, 'Umi') && e.isNamed(o, 'A Legendary Ocean'), 'A Legendary Ocean is both "A Legendary Ocean" and "Umi"');
}
{
  // Prohibition-style locks read the current name.
  const e = duel(['Harpie Queen', 'Prohibition']);
  const m = place(e, 0, 'Harpie Queen')!;
  const pr = faceUpST(e, 0, 'Prohibition');
  pr.active = true;
  (e.state.fx.prohibit ??= []).push({ name: 'Harpie Lady', src: pr.uid });
  check(e.prohibited(m), 'a lock on "Harpie Lady" also covers Harpie Queen on the field');
  check(!e.prohibited(card(e, 0, 'Celtic Guardian')), '...and not other cards');
}

console.log(`\n${passed}/${rules} printed name rules work in the hand, on the field and in the GY`);
console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
if (fails) process.exit(1);
