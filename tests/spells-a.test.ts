// Group A Spell/Trap audit: each card plays in a real Speed Duel and does what its text says (run: npx tsx tests/spells-a.test.ts)
import { Engine } from '../src/eds/engine';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';
import { attrOf } from '../src/eds/speed/helpers';
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
const hasPrompt = (e: Engine, p: Pid, name: string) => e.state.prompt?.kind === 'response' && e.state.prompt.player === p && e.state.prompt.options.some((o) => o.label.startsWith(name));
const lp = (e: Engine, p: Pid) => e.player(p).lp;

// ---------- audit-04 helpers ----------
// Cards this game's pool lacks ("D/D/D" monsters, "Spirit Message" cards, "Dododo" monsters): test-only stand-ins.
const fake = (info: Partial<CardInfo> & { name: string }) => {
  const full = { id: 980000 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};

/** Sends a card of `p` from the Deck (or hand) to the GY. */
function toGY(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.hand, ...ps.fusion].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.sendToGrave(c.uid, 'mill'));
  return c;
}
/** Puts a card of `p` on top of the Deck. */
function toTop(e: Engine, p: Pid, name: string): Card {
  const d = e.player(p).deck;
  const i = d.findIndex((x) => x.name === name);
  if (i < 0) throw new Error(`no ${name} in the Deck of ${p}`);
  const [c] = d.splice(i, 1);
  d.unshift(c);
  return c;
}
const inHand = (e: Engine, p: Pid, name: string) => e.player(p).hand.some((c) => c.name === name);
const hand = (e: Engine, p: Pid) => e.player(p).hand.length;
const graveEffect = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'GRAVE_EFFECT', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const special = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'SPECIAL', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const clearHand = (e: Engine, p: Pid) => {
  const ps = e.player(p);
  ps.gy.push(...ps.hand.splice(0));
};
void attrOf, fake, toGY, toTop, inHand, hand, graveEffect, special, clearHand, effect, active, logHas, hasPrompt, lp, toTurn3, run;

// ---------- group A helpers ----------
const canAct = (e: Engine, p: Pid, name: string) => e.canActivateMain(p, grab(e, p, name).uid);
const gyHas = (e: Engine, p: Pid, name: string) => e.player(p).gy.some((c) => c.name === name);
const checked = new Set<string>();
const card = (s: string) => {
  checked.add(s.replace(/ \(.*\)$/, ''));
  section(s);
};
/** Ends player 0's first turn: player 1's turn 2. */
const theirTurn = (e: Engine) => endTurn(e);

// ======================= destroy-by-Type Normal Spells =======================
for (const [spell, hit, miss] of [
  ['Acid Rain', 'Cyber Falcon', FILL],
  ['Eradicating Aerosol', 'Acid Crawler', FILL],
  ['Warrior Elimination', FILL, 'Cyber Falcon'],
] as const) {
  card(spell);
  const e = duel([spell, hit, miss, hit], [hit, miss, hit]);
  const a = place(e, 0, hit)!;
  const b = place(e, 1, hit)!;
  const keep = place(e, 1, miss)!;
  const down = place(e, 1, hit, 'def', false)!;
  playSpell(e, 0, spell);
  check(zone(e, a) === 'gy' && zone(e, b) === 'gy', `${spell}: destroys every face-up ${hit} (both sides)`);
  check(zone(e, keep) === 'mz', `${spell}: other Types stay`);
  check(zone(e, down) === 'mz', `${spell}: face-down monsters stay`);
  check(gyHas(e, 0, spell), `${spell}: goes to the GY after resolving`);
}

// ======================= Field Spells =======================
const FIELDS: [string, string[], string[]][] = [
  ['Forest', ['Acid Crawler', 'Archfiend Marmot of Nefariousness', 'Barrel Lily', 'Battle Ox'], []],
  ['Mountain', ['Baby Dragon', 'Blue-Winged Crown', 'Thunder Kid'], []],
  ['Sogen', [FILL, 'Battle Ox'], []],
  ['Umi', ['7 Colored Fish', 'Takriminos', 'Thunder Kid', 'Armored Starfish'], ['Cyber Falcon', 'Darkfire Soldier #1']],
  ['Wasteland', ['Anthrosaurus', 'Armored Zombie', 'Alpha The Magnet Warrior'], []],
  ['Yami', ['Ancient Brain', 'Akakieisu'], ['Binding Chain']],
];
for (const [field, up, down] of FIELDS) {
  card(field);
  const neutral = field === 'Sogen' ? 'Baby Dragon' : field === 'Mountain' || field === 'Forest' ? FILL : 'Battle Ox';
  for (const [nm, d] of [...up.map((x) => [x, 200] as const), ...down.map((x) => [x, -200] as const)]) {
    const e = duel([field, nm, neutral], [nm]);
    const m = place(e, 0, nm)!;
    const theirs = place(e, 1, nm)!;
    const n = place(e, 0, neutral)!;
    const fc = playSpell(e, 0, field);
    if (nm === up[0]) check(!!fc && e.player(0).field?.uid === fc.uid && !!fc.active, `${field}: stays face-up in the Field Zone`);
    const b = e.baseStats(m);
    check(e.atkOf(m) === b.atk + d && e.defOf(m) === Math.max(0, b.def + d) && e.atkOf(theirs) === b.atk + d, `${field}: ${nm} (${e.raceOf(m)}) on both sides ${d > 0 ? 'gains' : 'loses'} 200 ATK/DEF`);
    if (nm === up[0]) check(e.atkOf(n) === e.baseStats(n).atk && e.defOf(n) === e.baseStats(n).def, `${field}: ${neutral} (${e.raceOf(n)}) is unchanged`);
  }
}

// ======================= Equip Spells with a stat bonus =======================
const EQUIPS: [string, string, string, number, number][] = [
  ['Cyber Shield', 'Harpie Lady', FILL, 500, 0],
  ['Legendary Sword', FILL, 'Cyber Falcon', 300, 300],
  ['Machine Conversion Factory', 'Cyber Falcon', FILL, 300, 300],
  ['Raise Body Heat', 'Anthrosaurus', FILL, 300, 300],
  ['Salamandra', 'Darkfire Soldier #1', FILL, 700, 0],
  ['Sword of Dark Destruction', 'Ancient Brain', FILL, 400, -200],
  ['Violet Crystal', 'Armored Zombie', FILL, 300, 300],
  ['Axe of Despair', FILL, '', 1000, 0],
];
for (const [eq, ok, bad, atk, def] of EQUIPS) {
  card(eq);
  if (bad) {
    const e0 = duel([eq, bad]);
    place(e0, 0, bad);
    check(!canAct(e0, 0, eq), `${eq}: cannot be equipped to ${bad}`);
  }
  const e = duel([eq, ok], [ok]);
  const m = place(e, 1, ok)!;
  const b = e.baseStats(m);
  const fc = playSpell(e, 0, eq, { pick: [ok] });
  check(!!fc && fc.equippedTo === m.uid && e.atkOf(m) === b.atk + atk && e.defOf(m) === Math.max(0, b.def + def), `${eq}: equips to ${ok} (the opponent's too): ${atk} ATK / ${def} DEF`);
  kill(e, [m]);
  check(zone(e, fc) === 'gy', `${eq}: goes to the GY when the monster leaves the field`);
}
card('Axe of Despair (return to the Deck)');
{
  const e = duel(['Axe of Despair', FILL, 'Cyber Falcon']);
  const m = place(e, 0, FILL)!;
  const t = place(e, 0, 'Cyber Falcon')!;
  const axe = playSpell(e, 0, 'Axe of Despair', { pick: [FILL] })!;
  kill(e, [axe], 1, 'yes', { pick: ['Cyber Falcon'] });
  check(e.player(0).deck[0]?.uid === axe.uid && zone(e, t) === 'gy' && zone(e, m) === 'mz', 'sent from the field to the GY: Tribute 1 monster to put it on top of the Deck');
}

// ======================= Ritual Spells =======================
const RITUALS: [string, string, string[]][] = [
  ['Black Illusion Ritual', 'Relinquished', ['Petit Moth']],
  ['Black Luster Ritual', 'Black Luster Soldier', [FILL, FILL]],
  ['Black Magic Ritual', 'Magician of Black Chaos', [FILL, FILL]],
  ['Commencement Dance', 'Performance of Sword', [FILL, 'Thunder Kid']],
  ['Curse of the Masked Beast', 'The Masked Beast', [FILL, FILL]],
  ["Fortress Whale's Oath", 'Fortress Whale', [FILL, 'Ancient Brain']],
  ['Revival of Dokurorider', 'Dokurorider', [FILL, 'Thunder Kid']],
  ['War-Lion Ritual', 'Super War-Lion', [FILL, 'Ancient Brain']],
  ['Zera Ritual', 'Zera the Mant', [FILL, FILL]],
];
for (const [spell, mon, mats] of RITUALS) {
  card(spell);
  const need = mats.reduce((a, n) => a + (DB.get(n)!.level ?? 0), 0);
  // one Level short: cannot be activated
  {
    const e = duel([spell, mon, ...mats]);
    e.player(0).gy.push(...e.player(0).hand.splice(0));
    grab(e, 0, mon);
    if (mats.length > 1) place(e, 0, mats[1]);
    check(!canAct(e, 0, spell), `${spell}: not enough Levels (${mats.length > 1 ? DB.get(mats[1])!.level : 0} < ${need}): cannot be activated`);
  }
  const e = duel([spell, mon, ...mats]);
  e.player(0).gy.push(...e.player(0).hand.splice(0));
  grab(e, 0, mon);
  const onField = place(e, 0, mats[0])!;
  for (const n of mats.slice(1)) grab(e, 0, n);
  playSpell(e, 0, spell, { pick: mats });
  const r = e.monsters(0).find((m) => m.name === mon);
  check(!!r && r.faceUp && zone(e, onField) === 'gy' && mats.slice(1).every((n) => gyHas(e, 0, n)), `${spell}: Ritual Summons ${mon} by Tributing monsters from the hand and field (Levels ${need})`);
  check(gyHas(e, 0, spell), `${spell}: goes to the GY`);
  if (spell === 'Zera Ritual') {
    const e2 = duel([spell, mon, ...mats]);
    e2.player(0).gy.push(...e2.player(0).hand.splice(0));
    grab(e2, 0, mon);
    place(e2, 0, mats[0]);
    for (const n of mats.slice(1)) grab(e2, 0, n);
    playSpell(e2, 0, spell, { pick: mats }, { pick: ['Defense Position'] });
    const r2 = e2.monsters(0).find((m) => m.name === mon);
    check(!!r2 && r2.faceUp && r2.pos === 'def', 'a Ritual Summon can be in face-up Defense Position');
  }
}

// ======================= Block Attack / Book of Moon =======================
card('Block Attack');
{
  const e = duel(['Block Attack'], [FILL]);
  const m = place(e, 1, FILL)!;
  playSpell(e, 0, 'Block Attack');
  check(m.pos === 'def' && m.faceUp, "the opponent's Attack Position monster goes to face-up Defense Position");
  const e2 = duel(['Block Attack', FILL]);
  place(e2, 0, FILL);
  check(!canAct(e2, 0, 'Block Attack'), 'only targets a monster your opponent controls');
}
card('Book of Moon');
{
  const e = duel(['Book of Moon', 'Legendary Sword'], [FILL]);
  const m = place(e, 0, FILL)!;
  const sw = playSpell(e, 0, 'Legendary Sword', { pick: [FILL] })!;
  playSpell(e, 0, 'Book of Moon', { pick: [FILL] });
  check(!m.faceUp && m.pos === 'def', 'the target is changed to face-down Defense Position');
  check(zone(e, sw) === 'gy' && m.equips.length === 0, 'its Equip Card is destroyed (it cannot stay on a face-down monster)');
}
{
  const e = duel([FILL], ['Book of Moon']);
  const bm = putST(e, 1, 'Book of Moon');
  theirTurn(e); // turn 2: player 1
  endTurn(e); // turn 3: player 0
  const a = place(e, 0, FILL)!;
  toBattle(e);
  const b = place(e, 1, FILL, 'atk')!;
  attack(e, a, b, { respond: 'Book of Moon' }, { pick: [FILL] });
  check(zone(e, bm) === 'gy' && (!a.faceUp || !b.faceUp), "Quick-Play: Set, it can be activated during the opponent's turn");
}

// ======================= negation =======================
card('Breakthrough Skill');
{
  const e = duel(['Breakthrough Skill'], ['Command Knight', 'Flame Swordsman']);
  const ck = place(e, 1, 'Command Knight')!;
  check(e.atkOf(ck) === 1600, '(Command Knight powers itself up)');
  const bs = putST(e, 0, 'Breakthrough Skill');
  act(e, 0, bs.uid, { pick: ['Command Knight'] });
  check(e.atkOf(ck) === 1200 && zone(e, bs) === 'gy', "the opponent's Effect Monster has its effects negated");
  check(!e.canUseGraveEffect(0, bs.uid), 'not the turn it was sent to the GY');
  endTurn(e);
  check(e.atkOf(ck) === 1600, '...until the end of this turn');
  check(!e.canUseGraveEffect(1, bs.uid) && !e.canUseGraveEffect(0, bs.uid), "not during the opponent's turn");
  endTurn(e);
  graveEffect(e, 0, bs, { pick: ['Command Knight'] });
  check(zone(e, bs) === 'removed' && e.atkOf(ck) === 1200, 'your next turn: banish it from the GY to negate again');
}
{
  const e = duel(['Breakthrough Skill'], ['Flame Swordsman']);
  place(e, 1, 'Flame Swordsman');
  const bs = putST(e, 0, 'Breakthrough Skill');
  check(!e.canActivateMain(0, bs.uid), 'a monster with no effects (a Fusion Monster that only lists materials) cannot be targeted');
}
card('Divine Wrath');
{
  const e = duel(['Cannon Soldier', FILL], ['Divine Wrath', FILL]);
  const cs = place(e, 0, 'Cannon Soldier')!;
  place(e, 0, FILL);
  const dw = putST(e, 1, 'Divine Wrath');
  const h = e.player(1).hand.length;
  effect(e, 0, cs, { respond: 'Divine Wrath' });
  check(zone(e, dw) === 'gy' && e.player(1).hand.length === h - 1, 'discard 1 card as the cost');
  check(lp(e, 1) === 4000 && zone(e, cs) === 'gy', "negates the monster effect's activation and destroys that monster");
}
{
  const e = duel(['Pot of Greed'], ['Divine Wrath']);
  putST(e, 1, 'Divine Wrath');
  grab(e, 0, 'Pot of Greed');
  e.apply({ type: 'ACTIVATE', player: 0, uid: e.player(0).hand.find((c) => c.name === 'Pot of Greed')!.uid });
  check(!hasPrompt(e, 1, 'Divine Wrath'), 'not against a Spell Card');
  settle(e);
}
card('Magic Jammer');
{
  const e = duel(['Pot of Greed'], ['Magic Jammer']);
  const mj = putST(e, 1, 'Magic Jammer');
  const h1 = e.player(1).hand.length;
  const h0 = e.player(0).hand.length;
  playSpell(e, 0, 'Pot of Greed', { respond: 'Magic Jammer' });
  check(zone(e, mj) === 'gy' && e.player(1).hand.length === h1 - 1, 'discard 1 card');
  check(e.player(0).hand.length === h0 && gyHas(e, 0, 'Pot of Greed'), 'the Spell is negated (no draw) and destroyed');
}
{
  const e = duel(['Waboku'], ['Magic Jammer']);
  putST(e, 1, 'Magic Jammer');
  putST(e, 0, 'Waboku');
  const w = e.player(0).sz.find((c) => c?.name === 'Waboku')!;
  e.apply({ type: 'ACTIVATE', player: 0, uid: w.uid });
  check(!hasPrompt(e, 1, 'Magic Jammer'), 'not against a Trap Card');
  settle(e);
}
card('Seven Tools of the Bandit');
{
  const e = duel(['Reinforcements', FILL], ['Seven Tools of the Bandit']);
  const m = place(e, 0, FILL)!;
  const st = putST(e, 1, 'Seven Tools of the Bandit');
  const r = playTrap(e, 0, 'Reinforcements', { pick: [FILL] }, { respond: 'Seven Tools of the Bandit' });
  check(zone(e, st) === 'gy' && lp(e, 1) === 3000, 'pay 1000 LP');
  check(e.atkOf(m) === 1400 && gyHas(e, 0, 'Reinforcements') && !r, 'the Trap is negated and destroyed');
}
{
  const e = duel(['Pot of Greed'], ['Seven Tools of the Bandit']);
  putST(e, 1, 'Seven Tools of the Bandit');
  e.apply({ type: 'ACTIVATE', player: 0, uid: grab(e, 0, 'Pot of Greed').uid });
  check(!hasPrompt(e, 1, 'Seven Tools'), 'not against a Spell Card');
  settle(e);
}
card('Negate Attack');
{
  const e = duel(['Negate Attack'], [FILL, FILL]);
  const na = putST(e, 0, 'Negate Attack');
  theirTurn(e);
  const a = place(e, 1, FILL)!;
  const b = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, a, null, { respond: 'Negate Attack' });
  check(lp(e, 0) === 4000 && zone(e, na) === 'gy', 'the attack is negated');
  check(!e.canAttackWith(1, b), 'the Battle Phase ends (no more attacks)');
}

// ======================= Spell/Trap removal =======================
card('Mystical Space Typhoon');
{
  const e = duel(['Mystical Space Typhoon'], ['Waboku']);
  const w = putST(e, 1, 'Waboku');
  playSpell(e, 0, 'Mystical Space Typhoon', { pick: ['Face-down card'] });
  check(zone(e, w) === 'gy' && gyHas(e, 0, 'Mystical Space Typhoon'), 'destroys the targeted Set Spell/Trap');
}
{
  const e = duel(['Mystical Space Typhoon'], ['Pot of Greed', 'Waboku']);
  const mst = putST(e, 0, 'Mystical Space Typhoon');
  const w = putST(e, 1, 'Waboku');
  theirTurn(e);
  playSpell(e, 1, 'Pot of Greed', { respond: 'Mystical Space Typhoon' }, { pick: ['Face-down card'] });
  check(zone(e, mst) === 'gy' && zone(e, w) === 'gy', "Quick-Play: Set, it can be chained during the opponent's turn");
}
card('Cosmic Cyclone');
{
  const e = duel(['Cosmic Cyclone'], ['Waboku']);
  const w = putST(e, 1, 'Waboku');
  playSpell(e, 0, 'Cosmic Cyclone', { pick: ['Face-down card'] });
  check(zone(e, w) === 'removed' && lp(e, 0) === 3000, 'pay 1000 LP, banish the target');
}
{
  const e = duel(['Cosmic Cyclone'], ['Pot of Greed', 'Waboku']);
  const cc = putST(e, 0, 'Cosmic Cyclone');
  const w = putST(e, 1, 'Waboku');
  theirTurn(e);
  playSpell(e, 1, 'Pot of Greed', { respond: 'Cosmic Cyclone' }, { pick: ['Face-down card'] });
  check(zone(e, cc) === 'gy' && zone(e, w) === 'removed', "Quick-Play: Set, it can be chained during the opponent's turn");
}
card('De-Spell');
{
  const e = duel(['De-Spell'], ['Waboku', 'Swords of Revealing Light']);
  const w = putST(e, 1, 'Waboku');
  playSpell(e, 0, 'De-Spell', { pick: ['Face-down card'] });
  check(zone(e, w) === 'sz', 'a Set Trap is revealed and stays');
  const e2 = duel(['De-Spell'], ['Swords of Revealing Light']);
  const s = putST(e2, 1, 'Swords of Revealing Light');
  playSpell(e2, 0, 'De-Spell', { pick: ['Face-down card'] });
  check(zone(e2, s) === 'gy', 'a Set Spell is destroyed');
}
card('Dust Tornado');
{
  const e = duel(['Dust Tornado', 'Waboku'], ['Swords of Revealing Light']);
  const s = putST(e, 1, 'Swords of Revealing Light');
  grab(e, 0, 'Waboku');
  playTrap(e, 0, 'Dust Tornado', { pick: ['Face-down card'] }, 'yes', { pick: ['Waboku'] });
  const w = e.player(0).sz.find((c) => c?.name === 'Waboku');
  check(zone(e, s) === 'gy' && !!w && !w.faceUp, "destroys the opponent's Spell/Trap, then you can Set 1 Spell/Trap");
}
{
  const e = duel(['Dust Tornado'], ['Pot of Greed', 'Waboku']);
  const dt = putST(e, 0, 'Dust Tornado');
  const w = putST(e, 1, 'Waboku');
  theirTurn(e);
  playSpell(e, 1, 'Pot of Greed', { respond: 'Dust Tornado' }, { pick: ['Face-down card'] });
  check(zone(e, dt) === 'gy' && zone(e, w) === 'gy', "a Normal Trap: it can be chained to the opponent's Spell activation");
}
card('Jar of Avarice');
{
  const e = duel(['Jar of Avarice', 'Jar of Avarice', 'Pot of Greed']);
  for (let i = 0; i < 5; i++) toGY(e, 0, FILL);
  const j1 = putST(e, 0, 'Jar of Avarice');
  const j2 = putST(e, 0, 'Jar of Avarice');
  const d = e.player(0).deck.length;
  const h = e.player(0).hand.length;
  act(e, 0, j1.uid);
  check(e.player(0).gy.filter((c) => c.name === FILL).length === 0 && e.player(0).deck.length === d + 5 - 1 && e.player(0).hand.length === h + 1, 'shuffles 5 cards from the GY into the Deck, then draws 1');
  for (let i = 0; i < 5; i++) toGY(e, 0, FILL);
  check(!e.canActivateMain(0, j2.uid), 'only 1 Jar of Avarice per turn');
}

// ======================= Traps that answer attacks / boost =======================
card('Kunai with Chain');
{
  const e = duel(['Kunai with Chain']);
  const m = place(e, 0, FILL)!;
  const k = putST(e, 0, 'Kunai with Chain');
  act(e, 0, k.uid);
  check(zone(e, k) === 'sz' && m.equips.includes(k.uid) && e.atkOf(m) === 1900, 'equips itself to your monster: +500 ATK');
  kill(e, [m]);
  check(zone(e, k) === 'gy', 'leaves with the monster');
}
{
  const e = duel(['Kunai with Chain'], [FILL]);
  place(e, 0, 'Kunai with Chain' === 'x' ? FILL : FILL);
  const k = putST(e, 0, 'Kunai with Chain');
  theirTurn(e);
  const a = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, a, e.monsters(0)[0], { respond: 'Kunai with Chain' }, { pick: ['Change the attacking monster to Defense Position'] });
  check(a.pos === 'def' && zone(e, k) === 'gy', 'the attacker is changed to Defense Position (then the card goes to the GY)');
}
card('Metalmorph');
{
  const e = duel(['Metalmorph'], ['Battle Ox']);
  const m = place(e, 0, FILL)!;
  const mm = putST(e, 0, 'Metalmorph');
  act(e, 0, mm.uid, { pick: [FILL] });
  check(e.atkOf(m) === 1700 && e.defOf(m) === 1500 && m.equips.includes(mm.uid), 'equips itself: +300 ATK/DEF');
  const ox = place(e, 1, 'Battle Ox')!;
  toTurn3(e);
  toBattle(e);
  attack(e, m, ox);
  check(zone(e, ox) === 'gy' && lp(e, 1) === 4000 - (1700 + 850 - 1700), 'attacking: it gains half the attack target ATK during damage calculation');
  check(e.atkOf(m) === 1700, '...only during damage calculation');
}
{
  const e = duel(['Pot of Greed'], ['Metalmorph', FILL]);
  place(e, 1, FILL);
  const mm = putST(e, 1, 'Metalmorph');
  playSpell(e, 0, 'Pot of Greed', { respond: 'Metalmorph' }, { pick: [FILL] });
  check(zone(e, mm) === 'sz' && e.fieldCard(mm.uid)?.equippedTo !== undefined, "a Normal Trap: it can be chained to the opponent's Spell activation");
}
card('Reinforcements');
{
  const e = duel(['Reinforcements'], [FILL]);
  const m = place(e, 1, FILL)!;
  const r = putST(e, 0, 'Reinforcements');
  act(e, 0, r.uid, { pick: [FILL] });
  check(e.atkOf(m) === 1900 && zone(e, r) === 'gy', 'a face-up monster on the field (either side) gains 500 ATK');
  endTurn(e);
  check(e.atkOf(m) === 1400, '...until the end of this turn');
}
card('Graceful Dice');
{
  const e = duel(['Graceful Dice', FILL], [FILL]);
  const a = place(e, 0, FILL)!;
  const b = place(e, 0, FILL, 'def', false)!;
  const o = place(e, 1, FILL)!;
  playSpell(e, 0, 'Graceful Dice');
  const d = e.atkOf(a) - 1400;
  check(d >= 100 && d <= 600 && d % 100 === 0 && e.defOf(a) === 1200 + d && e.atkOf(b) === 1400 + d, 'all monsters you control gain ATK/DEF equal to the die x 100');
  check(e.atkOf(o) === 1400, "the opponent's monsters do not");
  endTurn(e);
  check(e.atkOf(a) === 1400, '...until the end of this turn');
}
{
  const e = duel(['Pot of Greed'], ['Graceful Dice', FILL]);
  const m = place(e, 1, FILL)!;
  const gd = putST(e, 1, 'Graceful Dice');
  playSpell(e, 0, 'Pot of Greed', { respond: 'Graceful Dice' });
  check(zone(e, gd) === 'gy' && e.atkOf(m) > 1400, "Quick-Play: Set, it can be chained during the opponent's turn");
}
card('Skull Dice');
{
  const e = duel(['Skull Dice', FILL], [FILL]);
  const a = place(e, 0, FILL)!;
  const o = place(e, 1, FILL)!;
  const sd = putST(e, 0, 'Skull Dice');
  act(e, 0, sd.uid);
  const d = 1400 - e.atkOf(o);
  check(d >= 100 && d <= 600 && d % 100 === 0 && e.defOf(o) === 1200 - d && e.atkOf(a) === 1400, "all monsters your opponent controls lose ATK/DEF equal to the die x 100");
  endTurn(e);
  check(e.atkOf(o) === 1400, '...until the end of this turn');
}
{
  const e = duel(['Pot of Greed'], ['Skull Dice', FILL]);
  const m = place(e, 0, FILL)!;
  const sd = putST(e, 1, 'Skull Dice');
  playSpell(e, 0, 'Pot of Greed', { respond: 'Skull Dice' });
  check(zone(e, sd) === 'gy' && e.atkOf(m) < 1400, "a Normal Trap: it can be chained to the opponent's Spell activation");
}
card('Riryoku');
{
  const e = duel(['Riryoku', 'Battle Ox'], [FILL]);
  const ox = place(e, 0, 'Battle Ox')!;
  const o = place(e, 1, FILL)!;
  playSpell(e, 0, 'Riryoku', { pick: [FILL, 'Battle Ox'] });
  check(e.atkOf(o) === 700 && e.atkOf(ox) === 2400, 'halves the ATK of 1 monster and adds the lost ATK to the other');
  endTurn(e);
  check(e.atkOf(o) === 1400 && e.atkOf(ox) === 1700, '...until the end of this turn');
}
card('Waboku');
{
  const e = duel(['Waboku', FILL], ['Battle Ox']);
  const m = place(e, 0, FILL)!;
  const w = putST(e, 0, 'Waboku');
  theirTurn(e);
  const ox = place(e, 1, 'Battle Ox')!;
  toBattle(e);
  attack(e, ox, m, { respond: 'Waboku' });
  check(zone(e, m) === 'mz' && zone(e, w) === 'gy', 'your monsters cannot be destroyed by battle this turn');
  e.apply({ type: 'NEXT_PHASE', player: 1 });
  settle(e);
  check(lp(e, 0) === 4000, 'no battle damage');
}
{
  const e = duel(['Waboku'], ['Battle Ox']);
  const w = putST(e, 0, 'Waboku');
  theirTurn(e);
  const ox = place(e, 1, 'Battle Ox')!;
  toBattle(e);
  attack(e, ox, null, { respond: 'Waboku' });
  check(lp(e, 0) === 4000 && zone(e, w) === 'gy', 'you take no battle damage from a direct attack this turn');
}
card('Widespread Ruin');
{
  const e = duel(['Widespread Ruin'], [FILL, 'Battle Ox']);
  const wr = putST(e, 0, 'Widespread Ruin');
  theirTurn(e);
  const a = place(e, 1, FILL)!;
  const ox = place(e, 1, 'Battle Ox')!;
  toBattle(e);
  attack(e, a, null, { respond: 'Widespread Ruin' });
  check(zone(e, ox) === 'gy' && zone(e, a) === 'mz' && zone(e, wr) === 'gy', "destroys the opponent's Attack Position monster with the highest ATK");
}
card('Spellbinding Circle');
{
  const e = duel(['Spellbinding Circle'], [FILL]);
  const m = place(e, 1, FILL)!;
  const sc = putST(e, 0, 'Spellbinding Circle');
  act(e, 0, sc.uid, { pick: [FILL] });
  theirTurn(e);
  check(!e.canChangePosition(1, m), 'the target cannot change its battle position');
  toBattle(e);
  check(!e.canAttackWith(1, m), 'the target cannot attack');
  kill(e, [m]);
  check(zone(e, sc) === 'gy', 'the monster destroyed: this card is destroyed');
}
{
  const e = duel(['Spellbinding Circle'], [FILL]);
  const m = place(e, 1, FILL, 'def', false)!;
  const sc = putST(e, 0, 'Spellbinding Circle');
  act(e, 0, sc.uid, { pick: ['Face-down card'] });
  theirTurn(e);
  e.apply({ type: 'FLIP_SUMMON', player: 1, uid: m.uid });
  settle(e);
  check(!m.faceUp, 'a bound face-down monster cannot be Flip Summoned (that changes its battle position)');
}

// ======================= removal / revival Normal Spells =======================
card('Eternal Rest');
{
  const e = duel(['Eternal Rest', 'Legendary Sword', 'Call of the Haunted', 'Battle Ox'], [FILL]);
  const m = place(e, 0, FILL)!;
  playSpell(e, 0, 'Legendary Sword', { pick: [FILL] });
  const plain = place(e, 1, FILL)!;
  toGY(e, 0, 'Battle Ox');
  const coth = putST(e, 0, 'Call of the Haunted');
  act(e, 0, coth.uid, { pick: ['Battle Ox'] });
  const ox = e.monsters(0).find((x) => x.name === 'Battle Ox')!;
  check(!!ox && ox.equips.includes(coth.uid), '(Battle Ox revived by Call of the Haunted)');
  playSpell(e, 0, 'Eternal Rest');
  check(zone(e, m) === 'gy', 'destroys monsters equipped with an Equip Card');
  check(zone(e, plain) === 'mz', 'monsters with no Equip Card stay');
  check(zone(e, ox) === 'mz', 'a monster with a Continuous Trap attached (Call of the Haunted) is not equipped with an Equip Card');
}
card('Fissure');
{
  const e = duel(['Fissure'], [FILL, 'Armored Zombie', 'Thunder Kid']);
  const a = place(e, 1, FILL)!;
  const z = place(e, 1, 'Thunder Kid', 'def', false)!;
  const k = place(e, 1, 'Armored Zombie')!;
  playSpell(e, 0, 'Fissure');
  check(zone(e, a) === 'gy' && zone(e, k) === 'mz' && zone(e, z) === 'mz', "destroys the opponent's face-up monster with the lowest ATK (face-down ones do not count)");
}
card('Tribute to the Doomed');
{
  const e = duel(['Tribute to the Doomed', 'Pot of Greed'], ['Battle Ox']);
  const ox = place(e, 1, 'Battle Ox')!;
  grab(e, 0, 'Pot of Greed');
  playSpell(e, 0, 'Tribute to the Doomed', { pick: ['Pot of Greed'] }, { pick: ['Battle Ox'] });
  check(gyHas(e, 0, 'Pot of Greed') && zone(e, ox) === 'gy', 'discard 1 card, then destroy the targeted monster');
  const e2 = duel(['Tribute to the Doomed'], ['Battle Ox']);
  clearHand(e2, 0);
  place(e2, 1, 'Battle Ox');
  check(!canAct(e2, 0, 'Tribute to the Doomed'), 'needs a card to discard');
}
card('Share the Pain');
{
  const e = duel(['Share the Pain', FILL], ['Battle Ox']);
  const m = place(e, 0, FILL)!;
  const ox = place(e, 1, 'Battle Ox')!;
  playSpell(e, 0, 'Share the Pain');
  check(zone(e, m) === 'gy' && zone(e, ox) === 'gy', 'Tribute 1 monster; the opponent Tributes 1 monster');
}
card('The Shallow Grave');
{
  const e = duel(['The Shallow Grave', 'Battle Ox'], ['Armored Zombie']);
  toGY(e, 0, 'Battle Ox');
  toGY(e, 1, 'Armored Zombie');
  playSpell(e, 0, 'The Shallow Grave');
  const a = e.monsters(0).find((m) => m.name === 'Battle Ox');
  const b = e.monsters(1).find((m) => m.name === 'Armored Zombie');
  check(!!a && !!b && !a.faceUp && !b.faceUp && a.pos === 'def' && b.pos === 'def', 'each player Special Summons a monster from their own GY in face-down Defense Position');
}
{
  const e = duel(['The Shallow Grave', 'Polymerization', 'Flame Manipulator', 'Masaki the Legendary Swordsman'], ['Armored Zombie'], ['Flame Swordsman']);
  grab(e, 0, 'Flame Manipulator');
  grab(e, 0, 'Masaki the Legendary Swordsman');
  playSpell(e, 0, 'Polymerization', { pick: ['Flame Swordsman'] });
  const fs = e.monsters(0).find((m) => m.name === 'Flame Swordsman')!;
  kill(e, [fs]);
  toGY(e, 1, 'Armored Zombie');
  playSpell(e, 0, 'The Shallow Grave', { pick: ['Flame Swordsman'] });
  check(zone(e, fs) === 'mz', 'a properly Fusion Summoned monster can come back');
}
card('Monster Reborn');
{
  const e = duel(['Monster Reborn'], ['Battle Ox']);
  toGY(e, 1, 'Battle Ox');
  playSpell(e, 0, 'Monster Reborn', { pick: ['Battle Ox'] }, 'yes');
  const ox = e.monsters(0).find((m) => m.name === 'Battle Ox');
  check(!!ox && ox.faceUp && ox.pos === 'atk', "Special Summons a monster from either GY (the opponent's too)");
}
card('Premature Burial');
{
  const e = duel(['Premature Burial', 'Battle Ox']);
  toGY(e, 0, 'Battle Ox');
  const pb = playSpell(e, 0, 'Premature Burial', { pick: ['Battle Ox'] })!;
  const ox = e.monsters(0).find((m) => m.name === 'Battle Ox')!;
  check(lp(e, 0) === 3200 && !!ox && ox.pos === 'atk' && pb.equippedTo === ox.uid, 'pay 800 LP: Special Summon in Attack Position and equip it');
  kill(e, [pb]);
  check(zone(e, ox) === 'gy', 'this card destroyed: the monster is destroyed');
}
card('Polymerization');
{
  const e = duel(['Polymerization', 'Flame Manipulator', 'Masaki the Legendary Swordsman'], [], ['Flame Swordsman']);
  grab(e, 0, 'Flame Manipulator');
  place(e, 0, 'Masaki the Legendary Swordsman');
  playSpell(e, 0, 'Polymerization', { pick: ['Flame Swordsman'] });
  const fs = e.monsters(0).find((m) => m.name === 'Flame Swordsman');
  check(!!fs && gyHas(e, 0, 'Flame Manipulator') && gyHas(e, 0, 'Masaki the Legendary Swordsman'), 'Fusion Summons with materials from the hand and field');
}
card('Fusion Sage');
{
  const e = duel(['Fusion Sage', 'Polymerization']);
  playSpell(e, 0, 'Fusion Sage');
  check(inHand(e, 0, 'Polymerization'), 'adds Polymerization from the Deck to the hand');
}
card('Elegant Egotist');
{
  const e = duel(['Elegant Egotist', 'Harpie Lady', 'Harpie Lady Sisters']);
  place(e, 0, 'Harpie Lady');
  playSpell(e, 0, 'Elegant Egotist', { pick: ['Harpie Lady Sisters'] });
  check(e.monsters(0).some((m) => m.name === 'Harpie Lady Sisters'), 'with "Harpie Lady" on the field: Special Summons Harpie Lady Sisters from the Deck');
  const e2 = duel(['Elegant Egotist', 'Harpie Lady Sisters']);
  check(!canAct(e2, 0, 'Elegant Egotist'), 'needs "Harpie Lady" on the field');
}
card('Foolish Burial');
{
  const e = duel(['Foolish Burial', 'Battle Ox']);
  playSpell(e, 0, 'Foolish Burial', { pick: ['Battle Ox'] });
  check(gyHas(e, 0, 'Battle Ox'), 'sends 1 monster from the Deck to the GY');
}
card('Reinforcement of the Army');
{
  const e = duel(['Reinforcement of the Army', 'Battle Ox', 'Black Luster Soldier', 'Masaki the Legendary Swordsman']);
  grab(e, 0, 'Reinforcement of the Army');
  e.apply({ type: 'ACTIVATE', player: 0, uid: e.player(0).hand.find((c) => c.name === 'Reinforcement of the Army')!.uid, zone: 0 });
  settle(e, 'pass');
  const pr = e.state.prompt;
  const opts = pr && pr.kind === 'select' ? pr.options.map((o) => o.label) : [];
  check(!opts.includes('Battle Ox') && !opts.includes('Black Luster Soldier'), 'only Level 4 or lower Warrior monsters are offered');
  settle(e, { pick: ['Masaki the Legendary Swordsman'] });
  check(inHand(e, 0, 'Masaki the Legendary Swordsman'), 'adds it to the hand');
}
card('Amazoness Heirloom');
{
  const e = duel(['Amazoness Swords Woman', 'Amazoness Heirloom'], ['Alpha The Magnet Warrior', 'Battle Ox']);
  const a = place(e, 0, 'Amazoness Swords Woman')!;
  const h = playSpell(e, 0, 'Amazoness Heirloom', { pick: ['Amazoness Swords Woman'] })!;
  check(h.equippedTo === a.uid, 'equips to an "Amazoness" monster');
  const wall = place(e, 1, 'Alpha The Magnet Warrior', 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, a, wall);
  check(zone(e, wall) === 'gy', 'after damage calculation: destroys the monster it attacked');
  const e2 = duel(['Amazoness Swords Woman', 'Amazoness Heirloom'], ['Battle Ox', 'Battle Ox']);
  const a2 = place(e2, 0, 'Amazoness Swords Woman')!;
  playSpell(e2, 0, 'Amazoness Heirloom', { pick: ['Amazoness Swords Woman'] });
  theirTurn(e2);
  const o1 = place(e2, 1, 'Battle Ox')!;
  const o2 = place(e2, 1, 'Battle Ox')!;
  toBattle(e2);
  attack(e2, o1, a2);
  check(zone(e2, a2) === 'mz', 'once per turn it is not destroyed by battle');
  attack(e2, o2, a2);
  check(zone(e2, a2) === 'gy', '...only once per turn');
  const e3 = duel(['Amazoness Heirloom', FILL]);
  place(e3, 0, FILL);
  check(!canAct(e3, 0, 'Amazoness Heirloom'), 'not to a non-"Amazoness" monster');
}

section('A new Field Spell replaces the old one');
{
  const e = duel(['Umi', 'Forest']);
  const umi = playSpell(e, 0, 'Umi')!;
  const forest = grab(e, 0, 'Forest');
  check(e.canActivateMain(0, forest.uid), 'a second Field Spell can be activated over the first');
  act(e, 0, forest.uid);
  check(zone(e, umi) === 'gy' && e.player(0).field?.name === 'Forest', 'the old Field Spell goes to the GY and the new one takes the Field Zone');
}

section('Quick-Play Spells from the hand on your own turn');
{
  const e = duel(['Mystical Space Typhoon'], ['Waboku', 'Dust Tornado']);
  const a = place(e, 0, FILL)!;
  putST(e, 1, 'Waboku');
  putST(e, 1, 'Dust Tornado');
  grab(e, 0, 'Mystical Space Typhoon');
  endTurn(e);
  endTurn(e);
  toBattle(e);
  const before = e.player(0).hand.length;
  attack(e, e.fieldCard(a.uid), null, { respond: 'Waboku' }, { respond: 'Mystical Space Typhoon' });
  check(e.player(0).hand.length === before - 1 && logHas(e, 'Mystical Space Typhoon destroys') && e.player(1).gy.length >= 1, "in response to the opponent's Trap, Mystical Space Typhoon is activated straight from the hand");
}

/** Cards whose script this audit corrected (each has a check above that failed before the fix). */
const FIXED = ['Book of Moon', 'Breakthrough Skill', 'Dust Tornado', 'Metalmorph', 'Graceful Dice', 'Skull Dice', 'Spellbinding Circle', 'Eternal Rest', 'The Shallow Grave', ...RITUALS.map((r) => r[0])];
console.log(`\nA: ${checked.size} cards checked, ${FIXED.length} fixed`);
process.exit(fails ? 1 : 0);
