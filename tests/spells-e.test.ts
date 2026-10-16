// Group E Spell/Trap audit (run: npx tsx tests/spells-e.test.ts): every Spell/Trap of cards-07/cards-08 in group E does what its text says.
// One or more behavioural checks per card, played through the engine's real actions.
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


// ---------- group E helpers ----------
import { levelOf } from '../src/eds/speed/helpers';
const fake = (info: Partial<CardInfo> & { name: string }) => {
  const full = { id: 960000 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
fake({ name: 'Metalfoes Test Steel', level: 4, atk: 1700, def: 1000, race: 'Psychic', attribute: 'FIRE' });
fake({ name: 'Mikanko Test Dancer', level: 4, atk: 1500, def: 1000, race: 'Fairy', attribute: 'LIGHT' });
fake({ name: 'Nordic Test Beast', sub: 'Normal', level: 4, atk: 1500, def: 1000, race: 'Beast', attribute: 'EARTH' });
fake({ name: 'Nordic Relic Test Ring', kind: 'spell', sub: 'Normal', desc: 'Test stand-in.' });
fake({ name: 'Alien Test Grey', sub: 'Normal', level: 4, atk: 1600, def: 1000, race: 'Reptile', attribute: 'LIGHT' });
fake({ name: 'Test Overload Machine', sub: 'Fusion', level: 8, atk: 2800, def: 2000, race: 'Machine', attribute: 'DARK', desc: '"Stealthroid" + "Drillroid"' });
fake({ name: 'Gem-Knight Test Fusion', sub: 'Fusion', level: 6, atk: 2400, def: 1800, race: 'Rock', attribute: 'EARTH', desc: '"Gem-Knight Emerald" + "Celtic Guardian"' });
fake({ name: 'Test Ninja Dragon', sub: 'Normal', level: 5, atk: 2000, def: 1000, race: 'Dragon', attribute: 'DARK' });
fake({ name: 'Test Rank 3 Xyz', sub: 'Xyz', rank: 3, atk: 2000, def: 1000, race: 'Warrior', attribute: 'LIGHT', desc: '2 Level 3 monsters' });

const hand = (e: Engine, p: Pid) => e.player(p).hand.length;
const atk = (e: Engine, c: FieldCard | null | undefined) => (c ? e.atkOf(c) : -1);
const noop = function* (): Generator<any, any, any> {};
function toGy(e: Engine, p: Pid, ...names: string[]): Card {
  let last: Card | null = null;
  for (const name of names) {
    const c = [...e.player(p).deck, ...e.player(p).hand].find((x) => x.name === name);
    if (!c) throw new Error(`no ${name} for player ${p}`);
    run(e, e.sendToGrave(c.uid, 'mill'));
    last = c;
  }
  return last!;
}
function activeST(e: Engine, p: Pid, name: string): FieldCard {
  const fc = putST(e, p, name);
  fc.faceUp = true;
  fc.active = true;
  return fc;
}
function force(e: Engine, p: Pid, name: string, pos: Pos = 'atk'): FieldCard | null {
  const c = [...e.player(p).deck, ...e.player(p).gy, ...e.player(p).fusion, ...e.player(p).hand].find((x) => x.name === name)!;
  e.state.fx.ignoreCond = c.uid;
  e.state.fx.contactSummon = c.uid;
  const f = place(e, p, name, pos);
  e.state.fx.ignoreCond = undefined;
  e.state.fx.contactSummon = undefined;
  return f;
}
const battle = (e: Engine) => {
  toTurn3(e);
  toBattle(e);
};
const graveFx = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'GRAVE_EFFECT', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const inHand = (e: Engine, p: Pid, name: string) => e.player(p).hand.some((c) => c.name === name);
/** Answers prompts with the defaults until one whose title contains `title` is pending (returns it, or null). */
function until(e: Engine, title: string) {
  for (let i = 0; i < 100 && e.state.prompt; i++) {
    const pr = e.state.prompt;
    if (pr.title.includes(title)) return pr;
    if (pr.kind === 'yesno') e.apply({ type: 'NO', player: pr.player });
    else if (pr.kind === 'response') e.apply({ type: 'PASS', player: pr.player });
    else e.apply({ type: 'CHOOSE', player: pr.player, picks: pr.options.map((_, j) => j).slice(0, Math.max(1, pr.min)) });
  }
  return null;
}
const GROUP = new Set<string>();
const card = (name: string) => {
  GROUP.add(name);
  section(name);
};

// ======================= J / L =======================
card('Judgment of Anubis');
{
  const e = duel([FILL, 'Judgment of Anubis'], ['Mystical Space Typhoon', 'Pot of Greed'], [], [], 1);
  const foe = place(e, 1, FILL)!;
  const ja = putST(e, 0, 'Judgment of Anubis');
  grab(e, 0, FILL);
  const pot = grab(e, 1, 'Pot of Greed');
  const before = hand(e, 1);
  act(e, 1, pot.uid, { respond: 'Judgment of Anubis' });
  check(zone(e, ja) === 'sz' && !ja.faceUp && hand(e, 1) === before + 1, 'cannot answer a Spell that destroys no Spell/Trap (Pot of Greed resolves)');
  const mst = grab(e, 1, 'Mystical Space Typhoon');
  const discards = e.player(0).gy.length;
  act(e, 1, mst.uid, { respond: 'Judgment of Anubis' }, 'yes');
  check(zone(e, mst) === 'gy' && zone(e, ja) === 'gy' && e.player(0).gy.length === discards + 2, 'discards 1 card: negates and destroys the Spell that would destroy a Spell/Trap');
  check(zone(e, foe) === 'gy' && lp(e, 1) === 4000 - 1400, "then destroys an opponent's face-up monster and burns for its ATK");
}

card('Junk Puppet');
{
  const e = duel(['Junk Puppet', 'Junk Puppet', 'Gimmick Puppet Des Troy']);
  toGy(e, 0, FILL);
  check(!e.canActivateMain(0, grab(e, 0, 'Junk Puppet').uid), 'needs a "Gimmick Puppet" in the GY');
  const g = toGy(e, 0, 'Gimmick Puppet Des Troy');
  playSpell(e, 0, 'Junk Puppet');
  check(zone(e, g) === 'mz', 'Special Summons the "Gimmick Puppet" from the GY');
  check(!e.canActivateMain(0, grab(e, 0, 'Junk Puppet').uid), 'only 1 "Junk Puppet" per turn');
}

card('Jurassic World');
{
  const e = duel(['Jurassic World', 'Jurrac Iguanon'], ['Jurrac Iguanon']);
  const jw = playSpell(e, 0, 'Jurassic World')!;
  const mine = place(e, 0, 'Jurrac Iguanon')!;
  const theirs = place(e, 1, 'Jurrac Iguanon')!;
  const cg = place(e, 0, FILL)!;
  check(atk(e, mine) === 2000 && e.defOf(mine) === 1000 && atk(e, theirs) === 2000 && atk(e, cg) === 1400, 'every Dinosaur on the field (both sides) gains 300 ATK/DEF, nothing else');
  check(zone(e, jw) === 'field', 'stays in the Field Zone');
}

card('Justi-Break');
{
  const e = duel([FILL, 'Kaibaman', 'Justi-Break'], ['Jurrac Iguanon', FILL]);
  const cg = place(e, 0, FILL)!;
  const kb = place(e, 0, 'Kaibaman', 'def')!;
  putST(e, 0, 'Justi-Break');
  endTurn(e);
  const ig = place(e, 1, 'Jurrac Iguanon')!;
  const foeNormal = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, ig, cg, { respond: 'Justi-Break' });
  check(zone(e, ig) === 'gy' && zone(e, kb) === 'gy', 'destroys every monster that is not a face-up Attack Position Normal Monster');
  check(zone(e, cg) === 'mz' && zone(e, foeNormal) === 'mz', 'face-up Attack Position Normal Monsters (both sides) survive');
}
{
  const e = duel(['Kaibaman', 'Justi-Break'], ['Jurrac Iguanon']);
  const kb = place(e, 0, 'Kaibaman')!;
  const jb = putST(e, 0, 'Justi-Break');
  endTurn(e);
  const ig = place(e, 1, 'Jurrac Iguanon')!;
  toBattle(e);
  const left = attack(e, ig, kb, { respond: 'Justi-Break' });
  check(left === 1 && zone(e, jb) === 'sz', 'not when the attacked monster is an Effect Monster');
}

card('Labyrinth of Nightmare');
{
  const e = duel(['Labyrinth of Nightmare'], [FILL]);
  const cg = place(e, 0, FILL)!;
  const foe = place(e, 1, FILL)!;
  const lb = playTrap(e, 0, 'Labyrinth of Nightmare')!;
  check(active(e, lb), 'a Continuous Trap that stays on the field');
  endTurn(e);
  check(cg.pos === 'def' && foe.pos === 'atk', "your End Phase: your (the turn player's) face-up monsters change position, not the opponent's");
  endTurn(e);
  check(foe.pos === 'def' && cg.pos === 'def', "the opponent's End Phase: their monsters change position");
}

card('Ledger of Legerdemain');
{
  const e = duel(['Ledger of Legerdemain', 'Ledger of Legerdemain']);
  const led = grab(e, 0, 'Ledger of Legerdemain');
  const top = e.player(0).deck.slice(0, 3);
  act(e, 0, led.uid);
  check(top.every((c) => zone(e, c) === 'removed'), 'banishes the top 3 cards of the Deck');
  check(!e.canActivateMain(0, grab(e, 0, 'Ledger of Legerdemain').uid), 'only 1 per turn');
  for (let i = 0; i < 4; i++) endTurn(e);
  check(top.every((c) => zone(e, c) === 'removed'), 'not back at your 2nd Standby Phase');
  endTurn(e);
  endTurn(e);
  check(top.every((c) => zone(e, c) === 'hand'), 'all 3 are added to the hand at your 3rd Standby Phase');
}

card('Level Up!');
{
  const e = duel(['Level Up!', 'Armed Dragon LV3', 'Armed Dragon LV5']);
  const l3 = place(e, 0, 'Armed Dragon LV3')!;
  playSpell(e, 0, 'Level Up!');
  check(zone(e, l3) === 'gy' && e.monsters(0).some((m) => m.name === 'Armed Dragon LV5'), 'sends an "LV" monster to the GY and Special Summons the monster its text lists from the Deck');
}
{
  const e = duel(['Level Up!', 'Armed Dragon LV3']);
  place(e, 0, 'Armed Dragon LV3');
  check(!e.canActivateMain(0, grab(e, 0, 'Level Up!').uid), 'cannot be activated with no listed monster in the hand or Deck');
}

card('Lightning Blade');
{
  const e = duel(['Lightning Blade', 'Mermail Abyssgunde'], ['Mermail Abyssgunde']);
  const cg = place(e, 0, FILL)!;
  const mm = place(e, 0, 'Mermail Abyssgunde')!;
  const foe = place(e, 1, 'Mermail Abyssgunde')!;
  const lb = playSpell(e, 0, 'Lightning Blade', { pick: [FILL] })!;
  check(atk(e, cg) === 2200, 'the equipped Warrior gains 800 ATK');
  check(atk(e, mm) === 900 && atk(e, foe) === 900, 'all WATER monsters (both sides) lose 500 ATK');
  kill(e, [lb]);
  check(atk(e, mm) === 1400, 'the WATER penalty ends when it leaves the field');
}

card('Limit Impulse');
{
  const e = duel(['Limit Impulse', FILL, FILL, 'Jinzo']);
  grab(e, 0, FILL);
  grab(e, 0, FILL);
  playTrap(e, 0, 'Limit Impulse', { pick: [FILL, FILL] });
  const toks = e.monsters(0).filter((m) => m.name === 'Soul Token');
  check(toks.length === 2 && e.player(0).gy.filter((c) => c.name === FILL).length === 2, 'sends 2 cards from the hand to the GY: 2 Soul Tokens');
  check(toks.every((m) => levelOf(e, m) === 1 && attrOf(e, m) === 'DARK' && e.raceOf(m) === 'Fiend' && atk(e, m) === 0), 'Fiend/DARK/Level 1/0 ATK');
  check(e.canNormalSummon(0, grab(e, 0, 'Jinzo'), true), 'they can be Tributed for a Tribute Summon');
}

card('Limit Reverse');
{
  const e = duel(['Limit Reverse', 'Kaibaman', 'Kelbek']);
  const kb = toGy(e, 0, 'Kaibaman');
  toGy(e, 0, 'Kelbek');
  const lr = playTrap(e, 0, 'Limit Reverse', { pick: ['Kaibaman'] })!;
  const m = e.fieldCard(kb.uid);
  check(!!m && m.pos === 'atk' && active(e, lr), 'Special Summons a 1000-or-less ATK monster in Attack Position');
  m!.pos = 'def';
  run(e, noop());
  check(zone(e, kb) === 'gy' && zone(e, lr) === 'gy', 'changed to Defense Position: both are destroyed');
}
{
  const e = duel(['Limit Reverse', 'Kaibaman']);
  const kb = toGy(e, 0, 'Kaibaman');
  const lr = playTrap(e, 0, 'Limit Reverse')!;
  kill(e, [kb], 1);
  check(zone(e, lr) === 'gy', 'the monster is destroyed: this card is destroyed');
}
{
  const e = duel(['Limit Reverse', 'Kaibaman']);
  const kb = toGy(e, 0, 'Kaibaman');
  const lr = playTrap(e, 0, 'Limit Reverse')!;
  kill(e, [lr], 1);
  check(zone(e, kb) === 'gy', 'this card leaves the field: the monster is destroyed');
}
{
  const e = duel(['Limit Reverse', 'Kaibaman']);
  const kb = toGy(e, 0, 'Kaibaman');
  const lr = playTrap(e, 0, 'Limit Reverse')!;
  check(!e.fieldCard(kb.uid)!.equips.includes(lr.uid), 'it is not an Equip Card');
  e.toHand(kb.uid);
  run(e, noop());
  check(zone(e, lr) === 'sz', 'the monster returned to the hand (not destroyed): this card stays');
}

card('Living Fossil');
{
  const e = duel(['Living Fossil', FILL, 'Living Fossil']);
  const cg = toGy(e, 0, FILL);
  playSpell(e, 0, 'Living Fossil');
  const m = e.fieldCard(cg.uid)!;
  check(!!m && atk(e, m) === 400 && e.defOf(m) === 200 && e.isNegated(m), 'Special Summons a Level 4 or lower monster equipped: -1000 ATK/DEF, effects negated');
  check(!e.canActivateMain(0, grab(e, 0, 'Living Fossil').uid), 'only 1 per turn');
  kill(e, [m], 1);
  check(zone(e, cg) === 'removed', 'the monster leaving the field is banished');
}
{
  const e = duel(['Living Fossil', FILL]);
  const cg = toGy(e, 0, FILL);
  const lf = playSpell(e, 0, 'Living Fossil')!;
  kill(e, [lf], 1);
  check(zone(e, cg) === 'removed', 'this card leaves the field: the equipped monster is banished');
}

card('Machine Angel Ritual');
{
  const e = duel(['Machine Angel Ritual', 'Cyber Angel Benten', FILL, FILL]);
  grab(e, 0, 'Cyber Angel Benten');
  place(e, 0, FILL);
  place(e, 0, FILL);
  playSpell(e, 0, 'Machine Angel Ritual', { pick: ['Cyber Angel Benten'] }, { pick: [FILL, FILL] });
  const bt = e.monsters(0).find((m) => m.name === 'Cyber Angel Benten');
  check(!!bt && e.player(0).gy.filter((c) => c.name === FILL).length === 2, 'Ritual Summons a "Cyber Angel" by Tributing monsters with enough Levels');
  kill(e, [bt], 1);
  check(zone(e, bt) === 'mz' && e.player(0).removed.some((c) => c.name === 'Machine Angel Ritual'), 'in the GY: banished instead of a LIGHT monster you control being destroyed');
}

// ======================= M =======================
card('Mage Power');
{
  const e = duel(['Mage Power', 'Trap Hole', 'Umi']);
  const cg = place(e, 0, FILL)!;
  putST(e, 0, 'Trap Hole');
  playSpell(e, 0, 'Mage Power');
  check(atk(e, cg) === 2400 && e.defOf(cg) === 2200, '+500 ATK/DEF for each Spell/Trap you control (2)');
  playSpell(e, 0, 'Umi');
  check(atk(e, cg) === 2900, 'a Field Spell counts too');
}

card('Magic Drain');
{
  const e = duel(['Magic Drain', 'Trap Hole'], ['Mystical Space Typhoon'], [], [], 1);
  const th = putST(e, 0, 'Trap Hole');
  putST(e, 0, 'Magic Drain');
  const mst = grab(e, 1, 'Mystical Space Typhoon');
  act(e, 1, mst.uid, { pick: ['Face-down card'] }, { respond: 'Magic Drain' });
  check(zone(e, mst) === 'gy' && zone(e, th) === 'sz', 'opponent has no Spell to discard: their Spell is negated and destroyed');
}
{
  const e = duel(['Magic Drain', 'Trap Hole'], ['Mystical Space Typhoon', 'Pot of Greed'], [], [], 1);
  const th = putST(e, 0, 'Trap Hole');
  putST(e, 0, 'Magic Drain');
  grab(e, 1, 'Pot of Greed');
  const mst = grab(e, 1, 'Mystical Space Typhoon');
  act(e, 1, mst.uid, { pick: ['Face-down card'] }, { respond: 'Magic Drain' }, 'yes', { pick: ['Pot of Greed'] });
  check(zone(e, th) === 'gy' && e.player(1).gy.some((c) => c.name === 'Pot of Greed'), 'they discard a Spell: Magic Drain is negated and their Spell resolves');
}

card('Magic Formula');
{
  const e = duel(['Magic Formula', 'Dark Magician']);
  const dm = place(e, 0, 'Dark Magician')!;
  const mf = playSpell(e, 0, 'Magic Formula')!;
  check(atk(e, dm) === 3200, '"Dark Magician" gains 700 ATK');
  kill(e, [mf], 1);
  check(lp(e, 0) === 5000, 'sent from the field to the GY: gain 1000 LP');
}
{
  const e = duel(['Magic Formula']);
  place(e, 0, FILL);
  check(!e.canActivateMain(0, grab(e, 0, 'Magic Formula').uid), 'only for "Dark Magician" / "Dark Magician Girl"');
}

card('Magical Stone Excavation');
{
  const e = duel(['Magical Stone Excavation', 'Umi', FILL, FILL]);
  const umi = toGy(e, 0, 'Umi');
  grab(e, 0, FILL);
  grab(e, 0, FILL);
  playSpell(e, 0, 'Magical Stone Excavation', { pick: [FILL, FILL] });
  check(zone(e, umi) === 'hand' && e.player(0).gy.filter((c) => c.name === FILL).length === 2, 'discards 2 cards, adds a Spell from the GY to the hand');
}

card("Magician's Circle");
{
  const e = duel(["Magician's Circle", 'Madolche Magileine'], ['Madolche Magileine', 'Dark Magician Girl']);
  putST(e, 0, "Magician's Circle");
  endTurn(e);
  const mm = place(e, 1, 'Madolche Magileine')!;
  toBattle(e);
  attack(e, mm, null, { respond: "Magician's Circle" });
  // the attack is then replayed into the new monster, so read the Summons from the log
  const mine = e.state.log.some((l) => l.text === 'A Special Summoned Madolche Magileine in Attack Position');
  const theirs = e.monsters(1).find((m) => m.name === 'Dark Magician Girl');
  check(mine && !!theirs && theirs.pos === 'atk', 'a Spellcaster attacks: each player Special Summons a 2000-or-less ATK Spellcaster from the Deck in Attack Position');
}

card('Magicians Unite');
{
  const e = duel(['Magicians Unite', 'Madolche Magileine', 'Dark Magician Girl', 'Magical Undertaker']);
  toTurn3(e);
  const mm = place(e, 0, 'Madolche Magileine')!;
  const dmg = place(e, 0, 'Dark Magician Girl')!;
  playSpell(e, 0, 'Magicians Unite', { pick: ['Madolche Magileine'] });
  check(atk(e, mm) === 3000, "the target's ATK becomes 3000");
  const later = place(e, 0, 'Magical Undertaker')!;
  toBattle(e);
  check(e.canAttackWith(0, mm) && !e.canAttackWith(0, dmg), 'the other Spellcasters cannot attack');
  check(!e.canAttackWith(0, later), 'nor can a Spellcaster Summoned after it resolved');
  endTurn(e);
  check(atk(e, mm) === 1400, 'until the end of this turn');
}

card('Magnet Conversion');
{
  const e = duel(['Magnet Conversion', 'Alpha The Magnet Warrior', 'Beta The Magnet Warrior']);
  const a = toGy(e, 0, 'Alpha The Magnet Warrior');
  const b = toGy(e, 0, 'Beta The Magnet Warrior');
  playTrap(e, 0, 'Magnet Conversion', { pick: ['Alpha The Magnet Warrior', 'Beta The Magnet Warrior'] });
  check(zone(e, a) === 'hand' && zone(e, b) === 'hand', 'adds up to 3 Level 4 or lower "Magnet Warrior" monsters from the GY');
  const mc = e.player(0).gy.find((c) => c.name === 'Magnet Conversion')!;
  e.banish(a.uid);
  check(!e.canUseGraveEffect(0, mc.uid), 'its GY effect cannot be used the turn it was sent there');
  toTurn3(e);
  graveFx(e, 0, mc);
  check(zone(e, a) === 'mz' && zone(e, mc) === 'removed', 'later: banish it to Special Summon a banished "Magnet Warrior"');
}

card('Magnetic Field');
{
  const e = duel(['Magnetic Field', 'Alpha The Magnet Warrior', 'Beta The Magnet Warrior'], ['Mermail Abyssteus']);
  const beta = toGy(e, 0, 'Beta The Magnet Warrior');
  const mf = playSpell(e, 0, 'Magnetic Field')!;
  const alpha = place(e, 0, 'Alpha The Magnet Warrior')!;
  effect(e, 0, mf);
  check(zone(e, beta) === 'mz', 'controlling a Level 4 or lower EARTH Rock: Special Summons a "Magnet Warrior" from the GY');
  const foe = place(e, 1, 'Mermail Abyssteus', 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, alpha, foe, 'yes');
  check(zone(e, foe) === 'hand', "the opponent's monster that survived a battle with an EARTH Rock returns to the hand");
}

card('Malevolent Catastrophe');
{
  const e = duel(['Malevolent Catastrophe', 'Umi'], [FILL, 'Trap Hole']);
  putST(e, 0, 'Malevolent Catastrophe');
  const umi = playSpell(e, 0, 'Umi')!;
  const th = putST(e, 1, 'Trap Hole');
  endTurn(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, null, { respond: 'Malevolent Catastrophe' });
  check(zone(e, umi) === 'gy' && zone(e, th) === 'gy', "an opponent's monster attacks: destroys all Spells and Traps on the field");
}

card('Malice Dispersion');
{
  const e = duel(['Malice Dispersion', FILL], ['Labyrinth of Nightmare', 'Trap Hole']);
  const lb = activeST(e, 1, 'Labyrinth of Nightmare');
  const th = putST(e, 1, 'Trap Hole');
  grab(e, 0, FILL);
  playSpell(e, 0, 'Malice Dispersion');
  check(zone(e, lb) === 'gy' && zone(e, th) === 'sz' && e.player(0).gy.some((c) => c.name === FILL), 'discards 1 card: destroys all face-up Continuous Traps (a Set card is left alone)');
}

card('Mask Change II');
{
  const e = duel(['Mask Change II', 'Mermail Abyssgunde', FILL, 'Mask Change II'], [FILL], ['Masked HERO Acid']);
  const acid = e.player(0).fusion[0];
  const ab = place(e, 0, 'Mermail Abyssgunde')!;
  place(e, 1, FILL);
  grab(e, 0, FILL);
  playSpell(e, 0, 'Mask Change II', { pick: [FILL] });
  check(zone(e, ab) === 'gy' && zone(e, acid) === 'mz', 'discard 1: sends the monster to the GY and Special Summons a "Masked HERO" of its Attribute with a higher Level');
  check(!e.canActivateMain(0, grab(e, 0, 'Mask Change II').uid), 'only 1 per turn');
}

card('Mask of Brutality');
{
  const e = duel(['Mask of Brutality']);
  const cg = place(e, 0, FILL)!;
  const mb = playSpell(e, 0, 'Mask of Brutality')!;
  check(atk(e, cg) === 2400 && e.defOf(cg) === 200, '+1000 ATK, -1000 DEF');
  endTurn(e);
  check(zone(e, mb) === 'sz', "not during the opponent's Standby Phase");
  endTurn(e, 'yes');
  check(lp(e, 0) === 3000 && zone(e, mb) === 'sz', 'your Standby Phase: pay 1000 LP to keep it');
  endTurn(e);
  endTurn(e, 'no');
  check(zone(e, mb) === 'gy' && lp(e, 0) === 3000, '... or it is destroyed');
}

card('Mask of Weakness');
{
  const e = duel(['Mask of Weakness'], [FILL]);
  const cg = place(e, 0, FILL)!;
  putST(e, 0, 'Mask of Weakness');
  endTurn(e);
  const foe = place(e, 1, FILL)!;
  toBattle(e);
  attack(e, foe, cg, { respond: 'Mask of Weakness' });
  check(zone(e, foe) === 'gy' && zone(e, cg) === 'mz', 'the attacking monster loses 700 ATK');
}

card('Mask of the Accursed');
{
  const e = duel(['Mask of the Accursed'], [FILL]);
  const foe = place(e, 1, FILL)!;
  playSpell(e, 0, 'Mask of the Accursed', { pick: [FILL] });
  endTurn(e);
  check(lp(e, 1) === 4000, "no damage in the opponent's Standby Phase");
  toBattle(e);
  check(!e.canAttackWith(1, foe), 'the equipped monster cannot attack');
  endTurn(e);
  check(lp(e, 1) === 3500, 'your Standby Phase: 500 damage to its controller');
}

card('Mega Ton Magical Cannon');
{
  const e = duel(['Mega Ton Magical Cannon', 'Maiden of Macabre'], [FILL, 'Trap Hole']);
  const md = place(e, 0, 'Maiden of Macabre')!;
  md.counters = 9;
  check(!e.canActivateMain(0, grab(e, 0, 'Mega Ton Magical Cannon').uid), 'needs 10 Spell Counters');
  md.counters = 10;
  const foe = place(e, 1, FILL)!;
  const th = putST(e, 1, 'Trap Hole');
  playSpell(e, 0, 'Mega Ton Magical Cannon');
  check(md.counters === 0 && zone(e, foe) === 'gy' && zone(e, th) === 'gy' && zone(e, md) === 'mz', 'removes 10 Spell Counters: destroys all cards your opponent controls only');
}

card('Memory Loss');
{
  const e = duel(['Memory Loss'], ['Medusa Worm']);
  putST(e, 0, 'Memory Loss');
  endTurn(e);
  const mw = place(e, 1, 'Medusa Worm')!;
  effect(e, 1, mw, { respond: 'Memory Loss' });
  check(mw.faceUp && mw.pos === 'def' && logHas(e, 'negated'), "negates the opponent's Attack Position monster's effect and changes it to face-up Defense Position");
}

card('Metal Reflect Slime');
{
  const e = duel(['Metal Reflect Slime']);
  playTrap(e, 0, 'Metal Reflect Slime');
  const m = e.monsters(0).find((x) => x.name === 'Metal Reflect Slime')!;
  check(!!m && m.pos === 'def' && e.defOf(m) === 3000 && atk(e, m) === 0 && levelOf(e, m) === 10 && e.raceOf(m) === 'Aqua' && attrOf(e, m) === 'WATER', 'Special Summoned in Defense Position as an Aqua/WATER/Level 10 0/3000 monster');
  m.pos = 'atk';
  toTurn3(e);
  toBattle(e);
  check(!e.canAttackWith(0, m), 'it cannot attack');
}

card('Metalfoes Counter');
{
  const e = duel(['Metalfoes Counter', 'Metalfoes Test Steel'], ['Jurrac Tyrannus']);
  const cg = place(e, 0, FILL)!;
  putST(e, 0, 'Metalfoes Counter');
  endTurn(e);
  const jz = place(e, 1, 'Jurrac Tyrannus')!;
  toBattle(e);
  attack(e, jz, cg, { respond: 'Metalfoes Counter' });
  check(zone(e, cg) === 'gy' && e.monsters(0).some((m) => m.name === 'Metalfoes Test Steel'), 'your card destroyed by battle: Special Summons a "Metalfoes" from the Deck');
}
{
  const e = duel(['Metalfoes Counter', 'Metalfoes Test Steel']);
  const mc = putST(e, 0, 'Metalfoes Counter');
  check(!e.canActivateMain(0, mc.uid), 'not without one of your cards being destroyed');
}

card('Metamorformation');
{
  const e = duel(['Metamorformation', 'Metalfoes Test Steel'], ['Metalfoes Test Steel']);
  const ms = place(e, 0, 'Metalfoes Test Steel')!;
  const foe = place(e, 1, 'Metalfoes Test Steel')!;
  const cg = place(e, 0, FILL)!;
  playSpell(e, 0, 'Metamorformation');
  check(atk(e, ms) === 2000 && e.defOf(ms) === 1300 && atk(e, cg) === 1400 && atk(e, foe) === 1700, '"Metalfoes" monsters you control (only yours) gain 300 ATK/DEF');
}

card('Metaverse');
{
  const e = duel(['Metaverse', 'Umi']);
  playTrap(e, 0, 'Metaverse', { pick: ['Activate it'] });
  check(e.player(0).field?.name === 'Umi' && !!e.player(0).field?.active, 'takes a Field Spell from the Deck and activates it');
}
{
  const e = duel(['Metaverse', 'Umi']);
  playTrap(e, 0, 'Metaverse', { pick: ['Add it to your hand'] });
  check(inHand(e, 0, 'Umi') && !e.player(0).field, '... or adds it to the hand');
}

card('Michizure');
{
  const e = duel(['Michizure', FILL], ['Jurrac Tyrannus']);
  const cg = place(e, 0, FILL)!;
  putST(e, 0, 'Michizure');
  endTurn(e);
  const jz = place(e, 1, 'Jurrac Tyrannus')!;
  toBattle(e);
  attack(e, jz, cg, { respond: 'Michizure' });
  check(zone(e, cg) === 'gy' && zone(e, jz) === 'gy', 'a monster is sent from the field to your GY: destroys a monster on the field');
}

card('Mikanko Dance - Mayowashidori');
{
  const e = duel(['Mikanko Dance - Mayowashidori', 'Mikanko Test Dancer']);
  const mk = place(e, 0, 'Mikanko Test Dancer')!;
  playSpell(e, 0, 'Mikanko Dance - Mayowashidori');
  kill(e, [mk], 1);
  check(zone(e, mk) === 'mz', 'the equipped monster cannot be destroyed by card effects');
}
{
  const e = duel(['Mikanko Dance - Mayowashidori', 'Mikanko Test Dancer']);
  const md = toGy(e, 0, 'Mikanko Dance - Mayowashidori');
  const mk = toGy(e, 0, 'Mikanko Test Dancer');
  graveFx(e, 0, md);
  const m = e.fieldCard(mk.uid);
  check(!!m && m.equips.includes(md.uid), 'in the GY: Special Summons a "Mikanko" from the GY and equips itself to it');
  const eq = e.fieldCard(md.uid)!;
  kill(e, [eq], 1);
  check(zone(e, md) === 'removed' && zone(e, mk) === 'mz', 'equipped this way, this card (not the monster) is banished when it leaves the field');
}

card('Mimicat');
{
  const e = duel(['Mimicat', 'Toon World', 'Toon Alligator'], ['Jinzo', 'Trap Hole']);
  const jz = toGy(e, 1, 'Jinzo');
  check(!e.canActivateMain(0, grab(e, 0, 'Mimicat').uid), 'needs "Toon World" and a Toon monster');
  playSpell(e, 0, 'Toon World');
  force(e, 0, 'Toon Alligator');
  playSpell(e, 0, 'Mimicat', { pick: ['Jinzo'] });
  check(zone(e, jz) === 'mz' && e.controller(jz.uid) === 0, "Special Summons a monster from the opponent's GY to your field");
}

card('Mind Crush');
{
  const e = duel(['Mind Crush'], ['Jinzo', 'Jinzo']);
  for (const c of e.player(1).deck.filter((x) => x.name === 'Jinzo')) e.toHandOf(c.uid, 1);
  const mine = hand(e, 0);
  playTrap(e, 0, 'Mind Crush', { pick: ['Jinzo'] });
  check(e.player(1).gy.filter((c) => c.name === 'Jinzo').length === 2 && hand(e, 0) === mine, 'declared card in their hand: they discard all copies');
}
{
  const e = duel(['Mind Crush', FILL], ['Jinzo']);
  const mine = hand(e, 0);
  playTrap(e, 0, 'Mind Crush', { pick: ['Jinzo'] });
  check(hand(e, 0) === mine - 1, 'otherwise you discard 1 random card');
}

card('Miniaturize');
{
  const e = duel(['Miniaturize'], ['Jurrac Tyrannus']);
  const jz = place(e, 1, 'Jurrac Tyrannus')!;
  const mi = playTrap(e, 0, 'Miniaturize')!;
  check(levelOf(e, jz) === 6 && atk(e, jz) === 1500, 'Level -1 and -1000 ATK');
  kill(e, [mi]);
  check(levelOf(e, jz) === 7 && atk(e, jz) === 2500, 'back to normal when this card leaves the field');
}
{
  const e = duel(['Miniaturize'], ['Jurrac Tyrannus']);
  const jz = place(e, 1, 'Jurrac Tyrannus')!;
  const mi = playTrap(e, 0, 'Miniaturize')!;
  kill(e, [jz], 0);
  check(zone(e, mi) === 'gy', 'when that monster leaves the field, this card goes too');
}

card('Miracle Fusion');
{
  const e = duel(['Miracle Fusion', 'Elemental HERO Avian', 'Elemental HERO Burstinatrix'], [], ['Elemental HERO Flame Wingman']);
  const av = place(e, 0, 'Elemental HERO Avian')!;
  const bu = toGy(e, 0, 'Elemental HERO Burstinatrix');
  playSpell(e, 0, 'Miracle Fusion');
  check(zone(e, av) === 'removed' && zone(e, bu) === 'removed' && e.monsters(0).some((m) => m.name === 'Elemental HERO Flame Wingman'), 'banishes the materials from the field and GY: Fusion Summons the "Elemental HERO"');
}

card('Miracle Restoring');
{
  const e = duel(['Miracle Restoring', 'Maiden of Macabre', 'Dark Magician']);
  const dm = toGy(e, 0, 'Dark Magician');
  const md = place(e, 0, 'Maiden of Macabre')!;
  md.counters = 2;
  playTrap(e, 0, 'Miracle Restoring');
  check(md.counters === 0 && zone(e, dm) === 'mz', 'removes 2 Spell Counters: Special Summons "Dark Magician" from the GY');
}

card('Mirage of Nightmare');
{
  const e = duel(['Mirage of Nightmare']);
  playSpell(e, 0, 'Mirage of Nightmare');
  while (e.player(0).hand.length > 1) run(e, e.sendToGrave(e.player(0).hand[0].uid, 'mill'));
  endTurn(e);
  check(hand(e, 0) === 4, "opponent's Standby Phase: draw until you have 4 cards");
  endTurn(e);
  check(hand(e, 0) === 2, 'your next Standby Phase: discard as many as you drew (3) at random');
}

card('Mokey Mokey Smackdown');
{
  const e = duel(['Mokey Mokey Smackdown', 'Mokey Mokey', 'Mudora'], [FILL]);
  playSpell(e, 0, 'Mokey Mokey Smackdown');
  const mm = place(e, 0, 'Mokey Mokey')!;
  const f = place(e, 0, FILL)!;
  kill(e, [f], 1);
  check(atk(e, mm) === 300, 'a non-Fairy destroyed: nothing');
  const elf = place(e, 0, 'Mudora')!;
  kill(e, [elf], 1);
  check(atk(e, mm) === 3000, 'a Fairy of yours destroyed: each "Mokey Mokey" becomes 3000 ATK');
  endTurn(e);
  check(atk(e, mm) === 300, 'until the end of this turn');
}

card('Monster Rebirth');
{
  const e = duel(['Monster Rebirth', 'Monster Reborn'], ['Gemini Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  const me = place(e, 0, FILL)!;
  const me2 = place(e, 0, FILL)!;
  const rb = putST(e, 0, 'Monster Rebirth');
  check(!e.canActivateMain(0, rb.uid), 'not before a monster was destroyed by battle this turn');
  battle(e);
  me.atkMod = 2000;
  attack(e, me, elf);
  attack(e, me2, null, { respond: 'Monster Rebirth' }, { pick: ['Monster Reborn'] }, { pick: ['Gemini Elf'] });
  check(zone(e, elf) === 'mz' && e.controller(elf.uid) === 0 && e.player(0).gy.some((c) => c.name === 'Monster Reborn'), 'sends "Monster Reborn" to the GY and Special Summons a monster from either GY to your field');
}

card('Moray of Greed');
{
  const e = duel(['Moray of Greed', 'Needle Sunfish', 'Oyster Meister']);
  const a = grab(e, 0, 'Needle Sunfish');
  const b = grab(e, 0, 'Oyster Meister');
  const n = hand(e, 0);
  playSpell(e, 0, 'Moray of Greed', { pick: ['Needle Sunfish', 'Oyster Meister'] });
  check(hand(e, 0) === n - 2 + 3 && logHas(e, 'drew 3 cards') && (zone(e, a) === 'deck' || zone(e, b) === 'deck' || hand(e, 0) === n + 1), 'shuffles 2 WATER monsters from the hand into the Deck, then draws 3');
}
{
  const e = duel(['Moray of Greed', 'Needle Sunfish']);
  grab(e, 0, 'Needle Sunfish');
  check(!e.canActivateMain(0, grab(e, 0, 'Moray of Greed').uid), 'needs 2 WATER monsters in the hand');
}

card('Multiplication of Ants');
{
  const e = duel(['Multiplication of Ants', 'Multiplication of Ants', 'Pinch Hopper', 'Mobius the Frost Monarch']);
  const ph = place(e, 0, 'Pinch Hopper', 'def', false)!;
  playSpell(e, 0, 'Multiplication of Ants');
  const ants = e.monsters(0).filter((m) => m.name === 'Army Ant Token');
  check(zone(e, ph) === 'gy' && ants.length === 2 && atk(e, ants[0]) === 500 && e.defOf(ants[0]) === 1200 && levelOf(e, ants[0]) === 4, 'Tribute an Insect (even a face-down one): 2 Army Ant Tokens (Insect/EARTH/Level 4/500/1200)');
  check(!e.canNormalSummon(0, grab(e, 0, 'Mobius the Frost Monarch'), true), 'the tokens cannot be Tributed for a Tribute Summon');
  const again = grab(e, 0, 'Multiplication of Ants');
  check(e.canActivateMain(0, again.uid), 'but they can be Tributed for other things (another Multiplication of Ants)');
  act(e, 0, again.uid);
  check(e.monsters(0).filter((m) => m.name === 'Army Ant Token').length === 3, '... which Tributes a token and makes 2 more');
}

card('NEXT');
{
  const e = duel(['NEXT', 'Neo-Spacian Air Hummingbird', 'Neo-Spacian Glow Moss', 'NEXT']);
  grab(e, 0, 'Neo-Spacian Air Hummingbird');
  toGy(e, 0, 'Neo-Spacian Glow Moss');
  playTrap(e, 0, 'NEXT', { pick: ['Neo-Spacian Air Hummingbird'] }, { pick: ['Neo-Spacian Glow Moss'] }, 'pass');
  const ms = e.monsters(0);
  check(ms.length === 2 && ms.every((m) => m.pos === 'def' && e.isNegated(m)), 'Special Summons Neo-Spacians from the hand and GY in Defense Position, effects negated');
  check(e.summonBlocked(0, 'Test Rank 3 Xyz', 'special', 'fusion') && !e.summonBlocked(0, 'Elemental HERO Flame Wingman', 'special', 'fusion'), 'only Fusion Monsters can then be Special Summoned from the Extra Deck');
  check(!e.canActivateMain(0, putST(e, 0, 'NEXT').uid), 'only 1 "NEXT" per turn');
}
{
  const e = duel(['NEXT', 'Neo-Spacian Grand Mole']);
  grab(e, 0, 'Neo-Spacian Grand Mole');
  const n = grab(e, 0, 'NEXT');
  check(e.canUseQuickNow(0, n.uid), 'controlling no cards: can be activated from the hand');
  e.apply({ type: 'QUICK_EFFECT', player: 0, uid: n.uid });
  settle(e, { pick: ['Neo-Spacian Grand Mole'] });
  check(e.monsters(0).some((m) => m.name === 'Neo-Spacian Grand Mole') && zone(e, n) === 'gy', '... and it resolves normally');
}

card('Neo Space');
{
  const e = duel(['Neo Space', 'Elemental HERO Neos'], [], ['Elemental HERO Aqua Neos']);
  playSpell(e, 0, 'Neo Space');
  const neos = place(e, 0, 'Elemental HERO Neos')!;
  const aq = force(e, 0, 'Elemental HERO Aqua Neos')!;
  const cg = place(e, 0, FILL)!;
  check(atk(e, neos) === 3000 && atk(e, aq) === 3000 && atk(e, cg) === 1400, '"Elemental HERO Neos" and Fusions that list it gain 500 ATK');
  endTurn(e);
  check(zone(e, aq) === 'mz', 'those Fusions do not have to return to the Extra Deck in the End Phase');
}

card('Neos Force');
{
  const e = duel(['Neos Force', 'Elemental HERO Neos'], ['Gemini Elf']);
  toTurn3(e);
  const neos = place(e, 0, 'Elemental HERO Neos')!;
  const nf = playSpell(e, 0, 'Neos Force')!;
  check(atk(e, neos) === 3300, '"Elemental HERO Neos" gains 800 ATK');
  const elf = place(e, 1, 'Gemini Elf')!;
  toBattle(e);
  attack(e, neos, elf);
  check(lp(e, 1) === 4000 - 1400 - 1900, 'destroys a monster by battle: damage equal to its original ATK');
  endTurn(e);
  check(e.player(0).deck.some((c) => c.uid === nf.uid), 'End Phase: shuffled into the Deck');
}

card('Night Beam');
{
  const e = duel(['Night Beam'], ['Quantum Cat', 'Trap Hole']);
  const q = putST(e, 1, 'Quantum Cat');
  const th = activeST(e, 1, 'Trap Hole');
  playSpell(e, 0, 'Night Beam', { pick: ['Face-down card'] }, { respond: 'Quantum Cat' });
  check(zone(e, q) === 'gy' && !e.monsters(1).length && zone(e, th) === 'sz', 'destroys the targeted Set Spell/Trap, which cannot be activated in response');
}

card('Nightmare Wheel');
{
  const e = duel(['Nightmare Wheel'], ['Gemini Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  playTrap(e, 0, 'Nightmare Wheel');
  endTurn(e);
  toBattle(e);
  check(!e.canAttackWith(1, elf) && !e.canChangePosition(1, elf), 'the target cannot attack or change its battle position');
  check(lp(e, 1) === 4000, "no damage in the opponent's Standby Phase");
  endTurn(e);
  check(lp(e, 1) === 3500, 'your Standby Phase: 500 damage');
  kill(e, [elf], 0);
  check(!e.player(0).sz.some((c) => c?.name === 'Nightmare Wheel'), 'the monster leaves the field: this card is gone too');
}

card('Ninjitsu Art of Super-Transformation');
{
  const e = duel(['Ninjitsu Art of Super-Transformation', 'Strike Ninja', 'Test Ninja Dragon'], ['Gemini Elf']);
  const ninja = place(e, 0, 'Strike Ninja')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  const nc = playTrap(e, 0, 'Ninjitsu Art of Super-Transformation', { pick: ['Strike Ninja'] }, { pick: ['Gemini Elf'] }, { pick: ['Test Ninja Dragon'] });
  const dr = e.monsters(0).find((m) => m.name === 'Test Ninja Dragon');
  check(zone(e, ninja) === 'gy' && zone(e, elf) === 'gy' && !!dr, 'sends both to the GY: Special Summons a Dragon with Level up to their combined original Levels');
  kill(e, [nc], 1);
  check(!!dr && zone(e, dr) === 'removed', 'this card leaves the field: that monster is banished');
}

card('Nordic Relic Draupnir');
{
  const e = duel(['Nordic Relic Draupnir', 'Nordic Test Beast', 'Nordic Relic Test Ring']);
  const b = place(e, 0, 'Nordic Test Beast')!;
  const d = playSpell(e, 0, 'Nordic Relic Draupnir')!;
  check(atk(e, b) === 2300, 'a "Nordic" monster gains 800 ATK');
  kill(e, [d], 1, 'yes', { pick: ['Nordic Relic Test Ring'] });
  check(inHand(e, 0, 'Nordic Relic Test Ring'), 'destroyed by a card effect: adds a "Nordic Relic" card from the Deck');
}
{
  const e = duel(['Nordic Relic Draupnir']);
  place(e, 0, FILL);
  check(!e.canActivateMain(0, grab(e, 0, 'Nordic Relic Draupnir').uid), 'only for an "Aesir" or "Nordic" monster');
}

card('Nordic Relic Laevateinn');
{
  const e = duel([FILL, 'Psychic Shockwave', 'Pot of Greed', 'Jinzo'], ['Nordic Relic Laevateinn', 'Mudora']);
  const me = place(e, 0, FILL)!;
  const foe = place(e, 1, 'Mudora', 'def')!;
  const lv = putST(e, 1, 'Nordic Relic Laevateinn');
  putST(e, 0, 'Psychic Shockwave');
  grab(e, 0, 'Pot of Greed');
  battle(e);
  check(!e.responsesFor(1, 'attack', { uid: me.uid }).some((o) => o.uid === lv.uid), 'not before a monster destroyed one by battle this turn');
  me.atkMod = 1000;
  const unused = attack(e, me, foe, { respond: 'Nordic Relic Laevateinn' }, { respond: 'Psychic Shockwave' });
  check(zone(e, foe) === 'gy' && zone(e, me) === 'gy', 'destroys the monster that destroyed a monster by battle');
  check(unused === 1 && !e.monsters(0).some((m) => m.name === 'Jinzo'), 'cards cannot be activated in response to it');
}

// ======================= O =======================
card('O - Oversoul');
{
  const e = duel(['O - Oversoul', 'Elemental HERO Avian', 'Elemental HERO Neos']);
  const av = toGy(e, 0, 'Elemental HERO Avian');
  playSpell(e, 0, 'O - Oversoul', { pick: ['Elemental HERO Avian'] });
  check(zone(e, av) === 'mz', 'Special Summons an "Elemental HERO" Normal Monster from the GY');
}

card('Offerings to the Doomed');
{
  const e = duel(['Offerings to the Doomed'], ['Gemini Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  playSpell(e, 0, 'Offerings to the Doomed');
  check(zone(e, elf) === 'gy', 'destroys a face-up monster');
  const n = hand(e, 0);
  toTurn3(e);
  check(hand(e, 0) === n, 'and you skip your next Draw Phase');
}

card('Ojama Country');
{
  const e = duel(['Ojama Country', 'Ojama Green', 'Ojama Yellow', 'Ojama Black'], ['Gemini Elf']);
  playSpell(e, 0, 'Ojama Country');
  const elf = place(e, 1, 'Gemini Elf')!;
  check(atk(e, elf) === 1900, 'no face-up "Ojama": nothing changes');
  const g = place(e, 0, 'Ojama Green')!;
  check(atk(e, elf) === 900 && e.defOf(elf) === 1900 && atk(e, g) === 1000 && e.defOf(g) === 0, 'with a face-up "Ojama": original ATK/DEF of all monsters are switched');
  toGy(e, 0, 'Ojama Black');
  grab(e, 0, 'Ojama Yellow');
  effect(e, 0, e.player(0).field!, { pick: ['Ojama Yellow'] });
  check(e.monsters(0).some((m) => m.name === 'Ojama Black'), 'send an "Ojama" card from the hand: Special Summon an "Ojama" from the GY');
}

card('Ojama Delta Hurricane!!');
{
  const e = duel(['Ojama Delta Hurricane!!', 'Ojama Green', 'Ojama Yellow', 'Ojama Black'], ['Gemini Elf', 'Trap Hole']);
  place(e, 0, 'Ojama Green');
  place(e, 0, 'Ojama Yellow');
  check(!e.canActivateMain(0, grab(e, 0, 'Ojama Delta Hurricane!!').uid), 'needs all three Ojamas');
  place(e, 0, 'Ojama Black');
  place(e, 1, 'Gemini Elf');
  activeST(e, 1, 'Trap Hole');
  playSpell(e, 0, 'Ojama Delta Hurricane!!');
  check(!e.monsters(1).length && !e.spells(1).length && e.monsters(0).length === 3, "destroys all cards on your opponent's side only");
}

card('Ojamagic');
{
  const e = duel(['Ojamagic', 'Ojama Green', 'Ojama Yellow', 'Ojama Black']);
  const o = grab(e, 0, 'Ojamagic');
  run(e, e.discard(0, o.uid));
  check(['Ojama Green', 'Ojama Yellow', 'Ojama Black'].every((n) => inHand(e, 0, n)), 'sent from the hand to the GY: adds Ojama Green, Yellow and Black');
}

card('Ojamatch');
{
  const e = duel(['Ojamatch', 'Ojama Green', 'Ojama Yellow', 'Armed Dragon LV3', 'Ojama Black', 'Ojama Blue', 'Ojama Red'], [FILL]);
  grab(e, 0, 'Ojama Green');
  e.player(0).normalSummoned = true;
  playSpell(e, 0, 'Ojamatch', { pick: ['Ojama Green'] }, { pick: ['Ojama Yellow'] }, 'yes', { pick: ['Armed Dragon LV3'] });
  check(e.player(0).gy.some((c) => c.name === 'Ojama Green') && inHand(e, 0, 'Ojama Yellow'), 'sends an "Ojama": adds a differently named "Ojama" and an "Armed Dragon"');
  check(e.monsters(0).some((m) => m.name === 'Armed Dragon LV3'), 'then you can Normal Summon 1 of them');
}

card('Ordeal of a Traveler');
{
  const e = duel([FILL], ['Ordeal of a Traveler']);
  const a = place(e, 0, FILL)!;
  activeST(e, 1, 'Ordeal of a Traveler');
  battle(e);
  attack(e, a, null, { pick: ['Spell'] });
  check(zone(e, a) === 'hand' && lp(e, 1) === 4000, 'opponent calls the random card wrong: the attacker returns to the hand');
}
{
  const e = duel([FILL], ['Ordeal of a Traveler']);
  const a = place(e, 0, FILL)!;
  activeST(e, 1, 'Ordeal of a Traveler');
  battle(e);
  attack(e, a, null, { pick: ['Monster'] });
  check(zone(e, a) === 'mz' && lp(e, 1) === 4000 - 1400, 'a right call: the attack goes on');
}

card('Order to Charge');
{
  const e = duel(['Order to Charge'], ['Gemini Elf']);
  const f = place(e, 0, FILL)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  playSpell(e, 0, 'Order to Charge');
  check(zone(e, f) === 'gy' && zone(e, elf) === 'gy', 'Tributes your Normal Monster, destroys an opponent\'s monster');
}
{
  const e = duel(['Order to Charge', 'Kaibaman'], ['Gemini Elf']);
  place(e, 0, 'Kaibaman');
  place(e, 1, 'Gemini Elf');
  check(!e.canActivateMain(0, grab(e, 0, 'Order to Charge').uid), 'needs a Normal Monster');
}

card('Order to Smash');
{
  const e = duel(['Order to Smash', 'Ojama Green'], ['Trap Hole', 'Mirror Force']);
  const g = place(e, 0, 'Ojama Green')!;
  const a = activeST(e, 1, 'Trap Hole');
  const b = activeST(e, 1, 'Mirror Force');
  playTrap(e, 0, 'Order to Smash', { pick: ['Ojama Green'] }, { pick: ['Trap Hole', 'Mirror Force'] });
  check(zone(e, g) === 'gy' && zone(e, a) === 'gy' && zone(e, b) === 'gy', 'Tributes a Level 2 or lower Normal Monster: destroys up to 2 opponent\'s Spells/Traps');
}

card('Otherworld - The "A" Zone');
{
  const e = duel(['Otherworld - The "A" Zone', 'Alien Test Grey'], [FILL]);
  playSpell(e, 0, 'Otherworld - The "A" Zone');
  const a = place(e, 0, 'Alien Test Grey')!;
  const f = place(e, 1, FILL)!;
  check(atk(e, f) === 1400, 'outside battle: no change');
  battle(e);
  attack(e, a, f);
  check(lp(e, 1) === 4000 - (1600 - 1100), 'the opponent\'s monster battling an "Alien" loses 300 ATK/DEF');
}

card('Over Destiny');
{
  const e = duel(['Over Destiny', 'Destiny HERO - Dasher', 'Destiny HERO - Doom Lord']);
  toGy(e, 0, 'Destiny HERO - Dasher');
  playSpell(e, 0, 'Over Destiny');
  const d = e.monsters(0).find((m) => m.name === 'Destiny HERO - Doom Lord');
  check(!!d, 'Special Summons a "Destiny HERO" from the Deck of at most half the target\'s Level');
  endTurn(e);
  check(!!d && zone(e, d) === 'gy', 'destroyed in the End Phase');
}

card('Overload Fusion');
{
  const e = duel(['Overload Fusion', 'Stealthroid', 'Drillroid'], [], ['Test Overload Machine']);
  place(e, 0, 'Stealthroid');
  toGy(e, 0, 'Drillroid');
  playSpell(e, 0, 'Overload Fusion');
  check(e.monsters(0).some((m) => m.name === 'Test Overload Machine') && e.player(0).removed.length === 2, 'banishes materials from the field and GY: Fusion Summons a DARK Machine');
}

card("Owner's Seal");
{
  const e = duel(["Owner's Seal"], ['Gemini Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  e.takeControl(elf.uid, 0);
  playSpell(e, 0, "Owner's Seal");
  check(e.controller(elf.uid) === 1, 'control returns to the owner');
}

// ======================= P =======================
card('Paleozoic Canadia');
{
  const e = duel(['Paleozoic Canadia'], ['Gemini Elf']);
  const elf = place(e, 1, 'Gemini Elf')!;
  playTrap(e, 0, 'Paleozoic Canadia');
  check(!elf.faceUp && elf.pos === 'def' && e.player(0).gy.some((c) => c.name === 'Paleozoic Canadia'), "changes an opponent's face-up monster to face-down Defense Position");
}
{
  const e = duel(['Paleozoic Canadia', 'Quantum Cat'], [FILL]);
  const pc = toGy(e, 0, 'Paleozoic Canadia');
  playTrap(e, 0, 'Quantum Cat', { respond: 'Paleozoic Canadia' });
  const m = e.fieldCard(pc.uid);
  check(!!m && levelOf(e, m) === 2 && e.raceOf(m) === 'Aqua' && atk(e, m) === 1200, 'a Trap is activated: Special Summons itself as a Level 2 Aqua 1200/0 monster');
  kill(e, [m], 1);
  check(zone(e, pc) === 'removed', 'banished when it leaves the field');
}

card('Paleozoic Eldonia');
{
  const e = duel(['Paleozoic Eldonia'], ['Gemini Elf']);
  const f = place(e, 0, FILL)!;
  playTrap(e, 0, 'Paleozoic Eldonia');
  check(atk(e, f) === 1900 && e.defOf(f) === 1700, 'a face-up monster gains 500 ATK/DEF');
  endTurn(e);
  check(atk(e, f) === 1400, 'until the end of this turn');
}

card('Pineapple Blast');
{
  const e = duel(['Pineapple Blast'], [FILL, FILL, FILL]);
  for (let i = 0; i < 3; i++) place(e, 1, FILL);
  putST(e, 0, 'Pineapple Blast');
  summon(e, 0, FILL, true, { respond: 'Pineapple Blast' });
  check(e.monsters(1).length === 1 && e.monsters(0).length === 1, 'opponent destroys monsters until they control as many as you');
}

card('Pitch-Black Power Stone');
{
  const e = duel(['Pitch-Black Power Stone', 'Dark Red Enchanter']);
  const dre = place(e, 0, 'Dark Red Enchanter')!;
  const n = dre.counters;
  const ps = playTrap(e, 0, 'Pitch-Black Power Stone')!;
  check(ps.counters === 3, 'activated with 3 Spell Counters');
  effect(e, 0, ps);
  check(ps.counters === 2 && dre.counters === n + 1, 'moves 1 Spell Counter to another card');
}

card('Pot of Avarice');
{
  const e = duel(['Pot of Avarice', 'Mudora', 'Newdoria', 'Oxygeddon', 'Plague Wolf']);
  toGy(e, 0, 'Mudora', 'Newdoria', 'Oxygeddon', 'Plague Wolf', FILL);
  const n = hand(e, 0);
  playSpell(e, 0, 'Pot of Avarice', { pick: ['Mudora', 'Newdoria', 'Oxygeddon', 'Plague Wolf', FILL] });
  check(e.player(0).gy.filter((c) => c.name !== 'Pot of Avarice').length === 0 && hand(e, 0) === n + 2, 'shuffles 5 monsters from the GY into the Deck, then draws 2');
}
{
  const e = duel(['Pot of Avarice', 'Mudora', 'Newdoria', 'Oxygeddon', 'Plague Wolf'], ['Metaverse', 'Umi']);
  toGy(e, 0, 'Mudora', 'Newdoria', 'Oxygeddon', 'Plague Wolf', FILL);
  putST(e, 1, 'Metaverse');
  const pot = grab(e, 0, 'Pot of Avarice');
  const n = hand(e, 0);
  e.apply({ type: 'ACTIVATE', player: 0, uid: pot.uid });
  until(e, 'Respond');
  const gone = e.player(0).gy.find((c) => c.name === 'Mudora')!;
  e.banish(gone.uid);
  settle(e);
  check(e.player(0).gy.filter((c) => c.name !== 'Pot of Avarice').length === 0 && hand(e, 0) === n - 1, 'a target left the GY: the others are shuffled, but no draw');
}

card('Pre-Preparation of Rites');
{
  const e = duel(['Pre-Preparation of Rites', 'White Dragon Ritual', 'Paladin of White Dragon', 'Pre-Preparation of Rites']);
  playSpell(e, 0, 'Pre-Preparation of Rites');
  check(inHand(e, 0, 'White Dragon Ritual') && inHand(e, 0, 'Paladin of White Dragon'), 'adds a Ritual Spell and the Ritual Monster it names');
  check(!e.canActivateMain(0, grab(e, 0, 'Pre-Preparation of Rites').uid), 'only 1 per turn');
}

card('Premature Return');
{
  const e = duel(['Premature Return', 'Gemini Elf']);
  const elf = e.player(0).deck.find((c) => c.name === 'Gemini Elf')!;
  e.banish(elf.uid);
  playTrap(e, 0, 'Premature Return', { pick: [FILL] });
  const m = e.fieldCard(elf.uid);
  check(!!m && !m.faceUp && m.pos === 'def' && e.player(0).removed.some((c) => c.name === FILL), 'banish 1 card from the hand: Special Summons a banished monster in face-down Defense Position');
}

card('Prideful Roar');
{
  const e = duel(['Prideful Roar'], ['Gemini Elf', FILL]);
  const f = place(e, 0, FILL)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  putST(e, 0, 'Prideful Roar');
  battle(e);
  attack(e, f, elf, { respond: 'Prideful Roar' });
  check(lp(e, 0) === 3500 && zone(e, elf) === 'gy' && lp(e, 1) === 4000 - 300, 'pay the ATK difference: your monster gains difference + 300 and wins');
  check(atk(e, f) === 1400, 'the ATK gain lasts only for that battle');
}

card('Psychic Shockwave');
{
  const e = duel(['Psychic Shockwave', 'Pot of Greed', 'Jinzo'], ['Quantum Cat']);
  grab(e, 0, 'Pot of Greed');
  putST(e, 0, 'Psychic Shockwave');
  const q = putST(e, 1, 'Quantum Cat');
  endTurn(e);
  act(e, 1, q.uid, { respond: 'Psychic Shockwave' });
  check(e.monsters(0).some((m) => m.name === 'Jinzo') && e.player(0).gy.some((c) => c.name === 'Pot of Greed'), 'opponent activates a Trap: discard a Spell, Special Summon a Level 6 DARK Machine from the Deck');
}

card('Pyramid of Wonders');
{
  const e = duel(['Pyramid of Wonders', 'Plague Wolf'], [FILL, FILL]);
  playSpell(e, 0, 'Pyramid of Wonders');
  const w = place(e, 0, 'Plague Wolf')!;
  place(e, 1, FILL);
  place(e, 1, FILL);
  check(atk(e, w) === 1000 + 400, "Zombies you control gain 200 ATK per opponent's monster");
  kill(e, [w], 1);
  check(zone(e, w) === 'mz' && !e.player(0).sz.some((c) => c?.name === 'Pyramid of Wonders'), 'exactly 1 Zombie would be destroyed: this card is sent to the GY instead');
}
{
  const e = duel(['Pyramid of Wonders', 'Plague Wolf', 'Plague Wolf']);
  const pw = playSpell(e, 0, 'Pyramid of Wonders')!;
  const w1 = place(e, 0, 'Plague Wolf')!;
  const w2 = place(e, 0, 'Plague Wolf')!;
  kill(e, [w1, w2], 1);
  check(zone(e, w1) === 'gy' && zone(e, w2) === 'gy' && zone(e, pw) === 'sz', 'not when other cards are destroyed with it');
}

card('Pyroxene Fusion');
{
  const e = duel(['Pyroxene Fusion', 'Gem-Knight Emerald'], [], ['Gem-Knight Test Fusion']);
  grab(e, 0, 'Gem-Knight Emerald');
  place(e, 0, FILL);
  playTrap(e, 0, 'Pyroxene Fusion');
  check(e.monsters(0).some((m) => m.name === 'Gem-Knight Test Fusion') && e.player(0).gy.some((c) => c.name === 'Gem-Knight Emerald'), 'sends the listed materials from the hand/field: Fusion Summons the "Gem-Knight"');
}

// ======================= Q / R =======================
card('Quaking Mirror Force');
{
  const e = duel([FILL, FILL], ['Quaking Mirror Force']);
  const a = place(e, 0, FILL)!;
  const b = place(e, 0, FILL)!;
  putST(e, 1, 'Quaking Mirror Force');
  battle(e);
  attack(e, a, null, { respond: 'Quaking Mirror Force' });
  check(!a.faceUp && !b.faceUp && a.pos === 'def' && b.pos === 'def' && lp(e, 1) === 4000, "an opponent's attack: all their Attack Position monsters become face-down Defense Position");
  check(!e.canChangePosition(0, b), 'they cannot change their battle positions');
}

card('Quantum Cat');
{
  const e = duel(['Quantum Cat']);
  const q = playTrap(e, 0, 'Quantum Cat', { pick: ['Dragon'] }, { pick: ['FIRE'] });
  const m = q ? e.fieldCard(q.uid) : null;
  check(!!m && zone(e, m) === 'mz' && e.raceOf(m) === 'Dragon' && attrOf(e, m) === 'FIRE' && levelOf(e, m) === 4 && atk(e, m) === 0 && e.defOf(m) === 2200, 'Special Summoned as a Level 4 0/2200 monster of the declared Type and Attribute');
}

card('Quarantine');
{
  const e = duel(['Quarantine'], ['Trap Hole']);
  playSpell(e, 0, 'Quarantine');
  const th = putST(e, 1, 'Trap Hole');
  endTurn(e, 'yes');
  check(logHas(e, 'Quarantine') && zone(e, th) === 'sz' && !th.faceUp, "End Phase: reveals an opponent's Set card, which stays Set");
}

card("Queen's Pawn");
{
  const e = duel(["Queen's Pawn", 'Amazoness Fighter', FILL, 'Amazoness Paladin'], [FILL]);
  const a = place(e, 0, 'Amazoness Fighter')!;
  const f = place(e, 1, FILL)!;
  putST(e, 0, "Queen's Pawn");
  battle(e);
  attack(e, a, f, { respond: "Queen's Pawn" });
  check(zone(e, f) === 'gy' && e.monsters(0).some((m) => m.name === 'Amazoness Paladin'), 'an "Amazoness" destroys a monster by battle: Special Summons a Level 4 or lower "Amazoness" from the Deck');
}

card('R - Righteous Justice');
{
  const e = duel(['R - Righteous Justice', 'Elemental HERO Avian'], ['Trap Hole', 'Mirror Force']);
  place(e, 0, 'Elemental HERO Avian');
  const a = activeST(e, 1, 'Trap Hole');
  const b = activeST(e, 1, 'Mirror Force');
  playSpell(e, 0, 'R - Righteous Justice', { pick: ['Trap Hole'] });
  check(zone(e, a) === 'gy' && zone(e, b) === 'sz', 'destroys as many Spells/Traps as "Elemental HERO" cards you control (1)');
}

card('Rain Storm');
{
  const e = duel(['Rain Storm', 'Cloudian - Altus'], ['Trap Hole']);
  const c = place(e, 0, 'Cloudian - Altus')!;
  const t = activeST(e, 1, 'Trap Hole');
  const rs = putST(e, 0, 'Rain Storm');
  e.apply({ type: 'ACTIVATE', player: 0, uid: rs.uid });
  const pr = until(e, 'reduce its ATK');
  check(!!pr && pr.kind === 'select' && pr.options.length === 1, 'only 1 opponent card: the 2000 choice (destroy 2 cards) is not offered');
  settle(e);
  check(zone(e, t) === 'gy' && atk(e, c) === 300, 'a "Cloudian" loses 1000 ATK: destroys 1 Spell/Trap');
}
{
  const e = duel(['Rain Storm', 'Cloudian - Altus'], [FILL, 'Trap Hole']);
  const c = place(e, 0, 'Cloudian - Altus')!;
  const f = place(e, 1, FILL)!;
  const t = activeST(e, 1, 'Trap Hole');
  playTrap(e, 0, 'Rain Storm', { pick: ['2000: destroy 2 cards'] });
  check(zone(e, t) === 'gy' && zone(e, f) === 'gy' && atk(e, c) === 0, 'loses 2000 ATK: destroys 2 cards');
}

card('Rainbow Gravity');
{
  const cbs = ['Crystal Beast Amber Mammoth', 'Crystal Beast Amethyst Cat', 'Crystal Beast Cobalt Eagle', 'Crystal Beast Emerald Tortoise', 'Crystal Beast Ruby Carbuncle', 'Crystal Beast Sapphire Pegasus', 'Crystal Beast Topaz Tiger'];
  const e = duel(['Rainbow Gravity', 'Rainbow Dragon', ...cbs]);
  toGy(e, 0, ...cbs.slice(0, 6));
  check(!e.canActivateMain(0, putST(e, 0, 'Rainbow Gravity').uid), 'needs 7 differently named "Crystal Beasts"');
  toGy(e, 0, cbs[6]);
  act(e, 0, e.player(0).sz.find((c) => c?.name === 'Rainbow Gravity')!.uid);
  check(e.monsters(0).some((m) => m.name === 'Rainbow Dragon'), 'Special Summons an "Ultimate Crystal" monster from the Deck, ignoring its Summoning conditions');
}

// ---------- summary ----------
const FIXED = 9; // Limit Reverse, Magicians Unite, Mikanko Dance - Mayowashidori, Multiplication of Ants, Nordic Relic Laevateinn, Pot of Avarice, Prideful Roar, Pyramid of Wonders, Rain Storm
console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
console.log(`E: ${GROUP.size} cards checked, ${FIXED} fixed`);
process.exit(fails ? 1 : 0);
