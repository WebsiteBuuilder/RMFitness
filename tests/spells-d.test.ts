// Speed Duel card scripts of group D Spells/Traps, checked against the real card text (run: npx tsx tests/spells-d.test.ts)
// One or more targeted checks per scripted card: its main effect really happens in a duel.
import { Engine } from '../src/eds/engine';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';
import { attrOf } from '../src/eds/speed/helpers';
import type { CardInfo } from '../src/eds/types';
import { getEffect } from '../src/eds/effects';
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
const lp = (e: Engine, p: Pid) => e.player(p).lp;

// ---------- spells-d helpers ----------
const fake = (info: Partial<CardInfo> & { name: string }) => {
  const full = { id: 970000 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
for (const x of ['A', 'B', 'C']) fake({ name: `Scrap D Test ${x}`, level: 3, atk: 1000, def: 1000, race: 'Machine', attribute: 'EARTH' });
fake({ name: 'Graydle D Slime', level: 3, atk: 1000, def: 1000, race: 'Aqua', attribute: 'WATER' });
fake({ name: 'Steelswarm D Roach', level: 5, atk: 1900, def: 0, race: 'Insect', attribute: 'DARK' });
fake({ name: 'Normal D Machine', sub: 'Normal', level: 4, atk: 1500, def: 1000, race: 'Machine', attribute: 'EARTH', vanilla: true });

function placeX(e: Engine, p: Pid, name: string, pos: Pos = 'atk', ...ans: Ans[]): FieldCard | null {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.gy, ...ps.fusion, ...ps.hand, ...ps.removed].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  e.state.fx.ignoreCond = c.uid;
  run(e, e.specialSummon(c.uid, p, pos), ...ans);
  e.state.fx.ignoreCond = undefined;
  return e.fieldCard(c.uid);
}
function toGy(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.hand, ...ps.deck, ...ps.fusion].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.sendToGrave(c.uid, 'cost'));
  return c;
}
const graveFx = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  e.apply({ type: 'GRAVE_EFFECT', player: p, uid: c.uid });
  return settle(e, ...ans);
};
const inHand = (e: Engine, p: Pid, name: string) => e.player(p).hand.some((c) => c.name === name);
const inGy = (e: Engine, p: Pid, name: string) => e.player(p).gy.some((c) => c.name === name);
const onField = (e: Engine, p: Pid, name: string) => e.monsters(p).find((m) => m.name === name) ?? null;
const oppAttack = (e: Engine, a: FieldCard | null, t: FieldCard | null, ...ans: Ans[]) => {
  endTurn(e);
  toBattle(e);
  return attack(e, a, t, ...ans);
};
const GK = "Gravekeeper's";
let checked = 0;
let fixed = 0;
const card = (s: string, wasFixed = false) => {
  section(s);
  checked++;
  if (wasFixed) fixed++;
};

// ======================= cards-05 =======================
card('Eliminating the League');
{
  const e = duel(['Eliminating the League', 'Pot of Greed'], [FILL]);
  const foe = place(e, 1, FILL)!;
  grab(e, 0, 'Pot of Greed');
  const before = e.player(1).hand.filter((c) => c.name === FILL).length;
  playTrap(e, 0, 'Eliminating the League');
  check(zone(e, foe) === 'gy' && inGy(e, 0, 'Pot of Greed'), 'discard 1 Spell: destroys the targeted face-up monster');
  check(before > 0 && !inHand(e, 1, FILL), "sends the cards in the opponent's hand with the same name to the GY");
}
{
  const e = duel(['Eliminating the League'], [FILL]);
  place(e, 1, FILL);
  const t = putST(e, 0, 'Eliminating the League');
  check(!e.canActivateMain(0, t.uid), 'needs a Spell to discard');
}

card('Emblem of Dragon Destroyer');
{
  const e = duel(['Emblem of Dragon Destroyer', 'Buster Blader']);
  playSpell(e, 0, 'Emblem of Dragon Destroyer');
  check(inHand(e, 0, 'Buster Blader'), 'adds "Buster Blader" from the Deck');
}

card('Embodiment of Apophis');
{
  const e = duel(['Embodiment of Apophis']);
  const ap = playTrap(e, 0, 'Embodiment of Apophis', 'no');
  check(!!ap && zone(e, ap) === 'mz' && e.atkOf(ap) === 1600 && e.defOf(ap) === 1800 && levelOf(e, ap) === 4 && e.raceOf(ap) === 'Reptile' && attrOf(e, ap) === 'EARTH', 'Special Summoned as a Reptile/EARTH/Level 4 1600/1800 monster');
}
{
  const e = duel([], ['Embodiment of Apophis']);
  putST(e, 1, 'Embodiment of Apophis');
  summon(e, 0, FILL, true, { respond: 'Embodiment of Apophis' }, 'no');
  check(!!onField(e, 1, 'Embodiment of Apophis'), "usable in the opponent's Main Phase");
}

card('Emergency Provisions');
{
  const e = duel(['Emergency Provisions', 'Mirror Force', 'Dust Tornado']);
  putST(e, 0, 'Mirror Force');
  putST(e, 0, 'Dust Tornado');
  playSpell(e, 0, 'Emergency Provisions', { pick: ['Mirror Force', 'Dust Tornado'] });
  check(lp(e, 0) === 6000 && inGy(e, 0, 'Mirror Force') && inGy(e, 0, 'Dust Tornado'), 'send 2 other Spells/Traps: gain 2000 LP');
}

card('Emergeroid Call', true);
{
  const e = duel(['Emergeroid Call', 'Drillroid'], ['Pot of Greed', 'Pot of Greed'], ['Steam Gyroid']);
  const call = putST(e, 0, 'Emergeroid Call');
  placeX(e, 0, 'Steam Gyroid');
  endTurn(e);
  const hand = e.player(1).hand.length;
  playSpell(e, 1, 'Pot of Greed', { respond: 'Emergeroid Call' });
  check(e.player(1).hand.length === hand - 1 && zone(e, call) === 'gy', 'negates a Spell activation while you control a "roid" Fusion Monster');
  check(e.player(1).deck.every((c) => c.name !== 'Pot of Greed'), "sends the cards with that name from the activating player's Deck to the GY");
  endTurn(e);
  toGy(e, 0, 'Drillroid');
  graveFx(e, 0, call);
  check(zone(e, call) === 'removed' && inHand(e, 0, 'Drillroid'), 'banish it from the GY: add a "roid" monster');
}
{
  // Not against the later effect of a face-up Spell/Trap (Fairy Box's coin toss is not a card activation nor a monster effect).
  const e = duel(['Emergeroid Call'], ['Fairy Box', 'Gemini Elf'], ['Steam Gyroid']);
  const call = putST(e, 0, 'Emergeroid Call');
  placeX(e, 0, 'Steam Gyroid');
  const box = putST(e, 1, 'Fairy Box');
  const boxLink = { card: box, loc: e.find(box.uid)!.loc, player: 1 as Pid, label: 'Fairy Box', negated: false, payload: { effect: 'quick' } };
  const can = getEffect('Emergeroid Call')!.canActivate!(e, call, 0, 'effect', { link: boxLink });
  const mon = place(e, 1, 'Gemini Elf')!;
  const mlink = { card: mon, loc: e.find(mon.uid)!.loc, player: 1 as Pid, label: mon.name, negated: false, payload: { effect: 'quick' } };
  const can2 = getEffect('Emergeroid Call')!.canActivate!(e, call, 0, 'effect', { link: mlink });
  check(!can && can2, 'chains to a monster effect, not to the later effect of a Spell/Trap on the field');
}

card('Enchanting Fitting Room');
{
  const e = duel(['Akakieisu', 'Anthrosaurus', 'Blue-Eyes White Dragon', FILL, 'Enchanting Fitting Room']);
  playSpell(e, 0, 'Enchanting Fitting Room');
  check(lp(e, 0) === 3200 && !!onField(e, 0, 'Akakieisu') && !!onField(e, 0, 'Anthrosaurus') && e.monsters(0).length === 2, 'pay 800: Special Summons the excavated Level 3 or lower Normal Monsters');
  check(e.player(0).deck.some((c) => c.name === 'Blue-Eyes White Dragon'), 'the rest go back into the Deck');
}

card('Enemy Controller');
{
  const e = duel(['Enemy Controller', 'Enemy Controller'], [FILL, 'Gemini Elf']);
  const foe = place(e, 1, FILL)!;
  playSpell(e, 0, 'Enemy Controller', { pick: ['Change its battle position'] });
  check(foe.pos === 'def' && foe.faceUp, "changes the opponent's face-up monster's battle position");
  place(e, 0, FILL);
  const elf = place(e, 1, 'Gemini Elf')!;
  playSpell(e, 0, 'Enemy Controller', { pick: ['Tribute 1 monster: take control of it'] }, { pick: [FILL] }, { pick: ['Gemini Elf'] });
  check(e.controller(elf.uid) === 0, 'Tribute 1 monster: takes control of the target');
  endTurn(e);
  check(e.controller(elf.uid) === 1, 'until the End Phase');
}

card('Energy Drain');
{
  const e = duel(['Energy Drain']);
  const m = place(e, 0, FILL)!;
  const n = e.player(1).hand.length;
  playTrap(e, 0, 'Energy Drain');
  check(e.atkOf(m) === 1400 + 200 * n && e.defOf(m) === 1200 + 200 * n, "gains 200 ATK/DEF per card in the opponent's hand");
  endTurn(e);
  check(e.atkOf(m) === 1400, 'until the end of this turn');
}

card('Evil Mind');
{
  const e = duel(['Evil Mind', 'Evil Mind', 'Archfiend Soldier', 'Elemental HERO Avian'], [FILL, FILL, FILL, FILL]);
  check(!e.canActivateMain(0, grab(e, 0, 'Evil Mind').uid), 'needs a Fiend monster');
  place(e, 0, 'Archfiend Soldier');
  for (let i = 0; i < 4; i++) toGy(e, 1, FILL);
  playSpell(e, 0, 'Evil Mind', { pick: ['Add 1 "HERO" monster or "Dark Fusion"'] });
  check(inHand(e, 0, 'Elemental HERO Avian'), '4+ monsters in the opponent\'s GY: adds a "HERO" monster');
  check(!e.canActivateMain(0, grab(e, 0, 'Evil Mind').uid), 'only 1 "Evil Mind" per turn');
}

card('Evo-Instant');
{
  const e = duel(['Evo-Instant', 'Krokodilus', 'Evolsaur Darwino']);
  const k = place(e, 0, 'Krokodilus')!;
  playTrap(e, 0, 'Evo-Instant');
  check(zone(e, k) === 'gy' && !!onField(e, 0, 'Evolsaur Darwino'), 'Tribute a Reptile: Special Summon an "Evolsaur" from the Deck');
}

card('Evo-Price');
{
  const e = duel(['Evo-Price', 'Evoltile Lagosucho', 'Evoltile Lagosucho'], ['Gemini Elf']);
  const ep = playSpell(e, 0, 'Evo-Price');
  const elf = place(e, 1, 'Gemini Elf')!;
  const lago = place(e, 0, 'Evoltile Lagosucho', 'def', false)!;
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: lago.uid });
  settle(e, 'yes', 'yes', { pick: ['Gemini Elf'] });
  check(zone(e, elf) === 'gy' && active(e, ep), 'a monster Special Summoned by an "Evoltile" effect: destroy 1 card');
}

card('Exchange of the Spirit');
{
  const e = duel(['Exchange of the Spirit']);
  const t = putST(e, 0, 'Exchange of the Spirit');
  check(!e.canActivateMain(0, t.uid), 'needs 15+ cards in both GYs');
  for (const q of [0, 1] as Pid[]) {
    const ps = e.player(q);
    ps.gy.push(...ps.deck.splice(0, 16));
  }
  const g1 = e.player(1).gy.length;
  const d1 = e.player(1).deck.length;
  act(e, 0, t.uid);
  check(lp(e, 0) === 3000 && e.player(1).deck.length === g1 && e.player(1).gy.length === d1, 'pay 1000: each player swaps their GY and Deck');
}

card('Exhausting Spell', true);
{
  const e = duel(['Exhausting Spell', 'Breaker the Magical Warrior', 'Dark Catapulter']);
  const br = place(e, 0, 'Breaker the Magical Warrior')!;
  const dc = place(e, 0, 'Dark Catapulter')!;
  br.counters = 1;
  dc.counters = 2;
  playTrap(e, 0, 'Exhausting Spell');
  check(br.counters === 0, 'removes the Spell Counters on the field');
  check(dc.counters === 2, 'other kinds of counters stay (Dark Catapulter)');
}

card('Fairy Box');
{
  const e = duel(['Fairy Box'], [FILL]);
  const box = playTrap(e, 0, 'Fairy Box');
  const mine = place(e, 0, FILL)!;
  const foe = place(e, 1, FILL)!;
  e.roll = () => 1;
  oppAttack(e, foe, mine, { respond: 'Fairy Box' }, { pick: ['Heads'] });
  check(zone(e, foe) === 'gy' && lp(e, 1) === 4000 - 1400, "called right: the attacking monster's ATK becomes 0");
  endTurn(e, 'yes');
  check(lp(e, 0) === 3500 && active(e, box), 'your Standby Phase: pay 500 LP to keep it');
  endTurn(e);
  endTurn(e, 'no');
  check(zone(e, box) === 'gy', 'or it is destroyed');
}

card('Fairy Meteor Crush');
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

card('Fairy Wind');
{
  const e = duel(['Fairy Wind', 'Fire Formation - Tenki'], ['Final Attack Orders']);
  const ff = playSpell(e, 0, 'Fire Formation - Tenki');
  endTurn(e);
  const fao = playTrap(e, 1, 'Final Attack Orders');
  endTurn(e);
  const fw = putST(e, 0, 'Fairy Wind');
  act(e, 0, fw.uid);
  check(zone(e, ff) === 'gy' && zone(e, fao) === 'gy' && lp(e, 0) === 3400 && lp(e, 1) === 3400, 'destroys the other face-up Spells/Traps: each player takes 300 per card');
}

card('Fallen Paradise');
{
  const e = duel(['Fallen Paradise', 'Hamon, Lord of Striking Thunder'], ['Gemini Elf']);
  const fp = playSpell(e, 0, 'Fallen Paradise')!;
  check(!e.canUseMonsterEffect(0, fp), 'no Lord: no draw');
  const hamon = placeX(e, 0, 'Hamon, Lord of Striking Thunder')!;
  const hand = e.player(0).hand.length;
  effect(e, 0, fp);
  check(e.player(0).hand.length === hand + 2 && !e.canUseMonsterEffect(0, fp), 'controls a Lord: draws 2 cards, once per turn');
  kill(e, [hamon], 1);
  check(zone(e, hamon) === 'mz', "the Lord cannot be destroyed by the opponent's card effects");
  kill(e, [hamon], 0);
  check(zone(e, hamon) === 'gy', 'your own card effects still destroy it');
}

card("Fiend's Sanctuary");
{
  const e = duel(["Fiend's Sanctuary"], ['Gemini Elf']);
  playSpell(e, 0, "Fiend's Sanctuary");
  const tok = onField(e, 0, 'Metal Fiend Token')!;
  check(!!tok && e.atkOf(tok) === 0 && levelOf(e, tok) === 1, 'Special Summons a 0/0 Level 1 "Metal Fiend Token"');
  const elf = place(e, 1, 'Gemini Elf')!;
  oppAttack(e, elf, tok);
  check(lp(e, 0) === 4000 && lp(e, 1) === 4000 - 1900, 'the opponent takes the battle damage you would have taken');
}

card('Fifth Hope');
{
  const heroes = ['Elemental HERO Avian', 'Elemental HERO Clayman', 'Elemental HERO Sparkman', 'Elemental HERO Bubbleman', 'Elemental HERO Burstinatrix'];
  const e = duel(['Fifth Hope', ...heroes]);
  for (const n of heroes) toGy(e, 0, n);
  const hand = e.player(0).hand.length;
  playSpell(e, 0, 'Fifth Hope');
  check(e.player(0).gy.filter((c) => c.name.startsWith('Elemental HERO')).length === 0 && e.player(0).hand.length === hand + 1 + 2 - 1, 'shuffles 5 "Elemental HERO" cards into the Deck, then draws 2');
}
{
  const heroes = ['Elemental HERO Avian', 'Elemental HERO Clayman', 'Elemental HERO Sparkman', 'Elemental HERO Bubbleman', 'Elemental HERO Burstinatrix'];
  const e = duel(['Fifth Hope', ...heroes]);
  for (const n of heroes) toGy(e, 0, n);
  const fh = grab(e, 0, 'Fifth Hope');
  const ps = e.player(0);
  ps.gy.push(...ps.hand.filter((c) => c.uid !== fh.uid));
  ps.hand = [fh];
  act(e, 0, fh.uid);
  check(ps.hand.length === 3, 'no other cards on the field or in the hand: draws 3');
}

card('Fighting Spirit');
{
  const e = duel(['Fighting Spirit'], [FILL, 'Gemini Elf', 'Blue-Eyes White Dragon']);
  const m = place(e, 0, FILL)!;
  const fs = playSpell(e, 0, 'Fighting Spirit', { pick: [FILL] });
  place(e, 1, FILL);
  place(e, 1, 'Gemini Elf');
  check(e.atkOf(m) === 1400 + 600, 'gains 300 ATK per monster the opponent controls');
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  oppAttack(e, bewd, m);
  check(zone(e, m) === 'mz' && zone(e, fs) === 'gy', 'destroyed by battle: Fighting Spirit is destroyed instead');
}

card('Final Attack Orders');
{
  const e = duel(['Final Attack Orders', 'Gemini Elf']);
  const m = place(e, 0, FILL, 'def')!;
  const fao = playTrap(e, 0, 'Final Attack Orders');
  check(m.pos === 'atk' && !e.canChangePosition(0, m), 'face-up monsters change to Attack Position and stay there');
  const elf = place(e, 0, 'Gemini Elf', 'def')!;
  check(elf.pos === 'atk', 'monsters that arrive later too');
  check(active(e, fao), 'stays on the field');
}

card('Fire Formation - Tenki');
{
  const e = duel(['Fire Formation - Tenki', 'Fire Formation - Tenki', 'Battle Ox']);
  playSpell(e, 0, 'Fire Formation - Tenki', 'yes');
  check(inHand(e, 0, 'Battle Ox'), 'activated: adds a Level 4 or lower Beast-Warrior from the Deck');
  const ox = place(e, 0, 'Battle Ox')!;
  check(e.atkOf(ox) === 1800, 'your Beast-Warriors gain 100 ATK');
  check(!e.canActivateMain(0, grab(e, 0, 'Fire Formation - Tenki').uid), 'only 1 activation per turn');
}

card('Firewall');
{
  const e = duel(['Firewall', 'Hinotama Soul'], [FILL]);
  const fw = playTrap(e, 0, 'Firewall');
  toGy(e, 0, 'Hinotama Soul');
  const foe = place(e, 1, FILL)!;
  oppAttack(e, foe, null, { respond: 'Firewall' });
  check(lp(e, 0) === 4000 && e.player(0).removed.some((c) => c.name === 'Hinotama Soul') && active(e, fw), 'banish a Pyro from the GY: negates the direct attack');
  endTurn(e, 'yes');
  check(lp(e, 0) === 3500 && active(e, fw), 'your Standby Phase: pay 500 LP');
}

card('Fish Depth Charge');
{
  const e = duel(['Fish Depth Charge', 'Great White'], ['Gemini Elf']);
  const gw = place(e, 0, 'Great White')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  const hand = e.player(0).hand.length;
  playTrap(e, 0, 'Fish Depth Charge', { pick: ['Great White'] }, { pick: ['Gemini Elf'] });
  check(zone(e, gw) === 'gy' && zone(e, elf) === 'gy' && e.player(0).hand.length === hand + 1, 'Tribute a Fish: destroys the target and draws 1 card');
}

card('Flash of the Forbidden Spell');
{
  const e = duel(['Flash of the Forbidden Spell'], [FILL, FILL, FILL]);
  const fl = grab(e, 0, 'Flash of the Forbidden Spell');
  place(e, 1, FILL);
  place(e, 1, FILL);
  check(!e.canActivateMain(0, fl.uid), "needs all of the opponent's Monster Zones occupied");
  place(e, 1, FILL);
  const mine = place(e, 0, FILL)!;
  playSpell(e, 0, 'Flash of the Forbidden Spell');
  check(e.monsters(1).length === 0 && zone(e, mine) === 'mz', "destroys only the opponent's monsters");
}

card('Flint');
{
  const e = duel(['Flint'], [FILL, 'Gemini Elf']);
  const foe = place(e, 1, FILL)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  const fl = playSpell(e, 0, 'Flint', { pick: [FILL] })!;
  check(fl.equippedTo === foe.uid && e.atkOf(foe) === 1100, 'the equipped monster loses 300 ATK');
  check(!e.canChangePosition(1, foe), 'it cannot change its battle position');
  kill(e, [foe], 0, { pick: ['Gemini Elf'] });
  check(zone(e, fl) === 'sz' && e.fieldCard(fl.uid)?.equippedTo === elf.uid && e.atkOf(elf) === 1900 - 300, 'the equipped monster is destroyed: Flint is equipped to another monster');
  endTurn(e);
  toBattle(e);
  check(!e.canAttackWith(1, elf), 'the equipped monster cannot attack');
}

card('Floodgate Trap Hole');
{
  const e = duel(['Floodgate Trap Hole'], ['Gemini Elf']);
  putST(e, 0, 'Floodgate Trap Hole');
  endTurn(e);
  const elf = summon(e, 1, 'Gemini Elf', true, { respond: 'Floodgate Trap Hole' })!;
  check(!elf.faceUp && elf.pos === 'def', 'the Summoned monster is changed to face-down Defense Position');
  toTurn3(e);
  e.apply({ type: 'FLIP_SUMMON', player: 1, uid: elf.uid });
  settle(e);
  check(!elf.faceUp, 'it cannot change its battle position');
}

card('Fog Control', true);
{
  const e = duel(['Fog Control', 'Cloudian - Smoke Ball'], [FILL]);
  const cl = place(e, 0, 'Cloudian - Smoke Ball')!;
  const foe = place(e, 1, FILL)!;
  playSpell(e, 0, 'Fog Control', { pick: ['Cloudian - Smoke Ball'] }, { pick: [FILL] });
  check(zone(e, cl) === 'gy' && foe.tags?.fog === 3, 'Tribute a face-up "Cloudian": 3 Fog Counters on a face-up monster (the counters the Cloudians use)');
}

card('Fossil Dig');
{
  const e = duel(['Fossil Dig', 'Two-Headed King Rex']);
  playSpell(e, 0, 'Fossil Dig');
  check(inHand(e, 0, 'Two-Headed King Rex'), 'adds a Level 6 or lower Dinosaur from the Deck');
}

card('Frontline Base');
{
  const e = duel(['Frontline Base', 'Y-Dragon Head', 'Z-Metal Tank']);
  const fb = playSpell(e, 0, 'Frontline Base')!;
  grab(e, 0, 'Y-Dragon Head');
  grab(e, 0, 'Z-Metal Tank');
  effect(e, 0, fb, { pick: ['Y-Dragon Head'] });
  check(!!onField(e, 0, 'Y-Dragon Head') && !e.canUseMonsterEffect(0, fb), 'once per turn: Special Summon a Level 4 or lower Union monster from the hand');
}

card('Fulfillment of the Contract');
{
  const e = duel(['Fulfillment of the Contract', 'Black Luster Soldier']);
  const bls = toGy(e, 0, 'Black Luster Soldier');
  const fc = playSpell(e, 0, 'Fulfillment of the Contract');
  check(lp(e, 0) === 3200 && zone(e, bls) === 'mz' && fc?.equippedTo === bls.uid, 'pay 800: Special Summons a Ritual Monster from the GY, equipped');
  kill(e, [fc], 1);
  check(zone(e, bls) === 'removed', 'destroyed: the equipped monster is banished');
}

card('Fusion Gate');
{
  const e = duel(['Fusion Gate', 'Elemental HERO Avian', 'Elemental HERO Burstinatrix'], [], ['Elemental HERO Flame Wingman']);
  const fg = playSpell(e, 0, 'Fusion Gate')!;
  grab(e, 0, 'Elemental HERO Avian');
  grab(e, 0, 'Elemental HERO Burstinatrix');
  effect(e, 0, fg);
  check(!!onField(e, 0, 'Elemental HERO Flame Wingman') && e.player(0).removed.length === 2 && zone(e, fg) === 'field', 'Fusion Summons by banishing the Fusion Materials');
}

card('Fusion Sword Murasame Blade');
{
  const e = duel(['Fusion Sword Murasame Blade', 'Gemini Elf']);
  place(e, 0, 'Gemini Elf');
  const m = place(e, 0, FILL)!;
  const sw = playSpell(e, 0, 'Fusion Sword Murasame Blade', { pick: [FILL] });
  check(sw?.equippedTo === m.uid && e.atkOf(m) === 1400 + 800, 'equipped to a Warrior: +800 ATK');
  kill(e, [sw], 1);
  check(zone(e, sw) === 'sz', 'cannot be destroyed by card effects while equipped');
}

card('Fusion Weapon');
{
  const e = duel(['Fusion Weapon'], [], ['Elemental HERO Flame Wingman']);
  place(e, 0, FILL);
  check(!e.canActivateMain(0, grab(e, 0, 'Fusion Weapon').uid), 'only for a Level 6 or lower Fusion Monster');
  const fw = placeX(e, 0, 'Elemental HERO Flame Wingman')!;
  playSpell(e, 0, 'Fusion Weapon', { pick: ['Elemental HERO Flame Wingman'] });
  check(e.atkOf(fw) === 2100 + 1500 && e.defOf(fw) === 1200 + 1500, 'gains 1500 ATK and DEF');
}

card('Future Fusion');
{
  const e = duel(['Future Fusion', FILL, FILL, FILL, 'Elemental HERO Avian', 'Elemental HERO Burstinatrix'], [], ['Elemental HERO Flame Wingman']);
  const ff = playSpell(e, 0, 'Future Fusion')!;
  check(!inGy(e, 0, 'Elemental HERO Avian'), 'nothing happens on activation');
  toTurn3(e);
  check(inGy(e, 0, 'Elemental HERO Avian') && inGy(e, 0, 'Elemental HERO Burstinatrix'), '1st Standby Phase: sends the shown monster\'s materials from the Deck to the GY');
  toTurn3(e);
  const fw = onField(e, 0, 'Elemental HERO Flame Wingman');
  check(!!fw && ff.equippedTo === fw.uid, '2nd Standby Phase: Fusion Summons it');
  kill(e, [ff], 1);
  check(zone(e, fw) === 'gy', 'leaves the field: that monster is destroyed');
}

card('Gagagarevenge');
{
  const e = duel(['Gagagarevenge', 'Gagaga Gardna']);
  const g = toGy(e, 0, 'Gagaga Gardna');
  const gr = playSpell(e, 0, 'Gagagarevenge');
  check(zone(e, g) === 'mz' && gr?.equippedTo === g.uid, 'Special Summons a "Gagaga" monster from the GY, equipped');
  kill(e, [gr], 1);
  check(zone(e, g) === 'gy', 'leaves the field: the equipped monster is destroyed');
}

card('Galaxy Cyclone');
{
  const e = duel(['Galaxy Cyclone'], ['Mirror Force', 'Messenger of Peace']);
  const mf = putST(e, 1, 'Mirror Force');
  const gc = grab(e, 0, 'Galaxy Cyclone');
  playSpell(e, 0, 'Galaxy Cyclone');
  check(zone(e, mf) === 'gy', 'destroys a Set Spell/Trap');
  check(!e.canUseGraveEffect(0, gc.uid), 'not the turn it was sent to the GY');
  endTurn(e);
  const mop = playSpell(e, 1, 'Messenger of Peace');
  endTurn(e, 'no');
  graveFx(e, 0, gc);
  check(zone(e, gc) === 'removed' && zone(e, mop) === 'gy', 'banish it from the GY: destroys a face-up Spell/Trap');
}

// ======================= cards-06 =======================
card('Gem-Enhancement');
{
  const e = duel(['Gem-Enhancement', 'Gem-Knight Emerald', 'Gem-Knight Garnet']);
  place(e, 0, 'Gem-Knight Emerald');
  const ga = toGy(e, 0, 'Gem-Knight Garnet');
  playTrap(e, 0, 'Gem-Enhancement', { pick: ['Gem-Knight Emerald'] }, { pick: ['Gem-Knight Garnet'] });
  check(zone(e, ga) === 'mz' && inGy(e, 0, 'Gem-Knight Emerald'), 'Tribute a "Gem-Knight": Special Summon a "Gem-Knight" from the GY');
}

card('Generation Next');
{
  const e = duel(['Generation Next', 'Elemental HERO Avian', 'Elemental HERO Avian', 'Elemental HERO Bladedge']);
  check(!e.canActivateMain(0, grab(e, 0, 'Generation Next').uid), 'needs lower LP than the opponent');
  e.player(0).lp = 2000;
  playSpell(e, 0, 'Generation Next', { pick: ['Elemental HERO Avian'] }, 'no');
  check(inHand(e, 0, 'Elemental HERO Avian') && e.player(0).deck.some((c) => c.name === 'Elemental HERO Bladedge'), 'adds an "Elemental HERO" with ATK <= the LP difference (not Bladedge, 2600)');
  check(e.activationBlocked(0, e.player(0).hand.find((c) => c.name === 'Elemental HERO Avian')!), 'cards with that name cannot be activated this turn');
}

card('Gift of the Martyr');
{
  const e = duel(['Gift of the Martyr', `${GK} Spy`]);
  const a = place(e, 0, FILL)!;
  const b = place(e, 0, `${GK} Spy`)!;
  playSpell(e, 0, 'Gift of the Martyr', { pick: [`${GK} Spy`] }, { pick: [FILL] });
  check(zone(e, b) === 'gy' && e.atkOf(a) === 2600, 'send a monster to the GY: another gains its ATK');
  endTurn(e);
  check(e.atkOf(a) === 1400, 'until the end of this turn');
}

card('Goblin Circus');
{
  const e = duel(['Goblin Circus']);
  playSpell(e, 0, 'Goblin Circus');
  const d = e.player(0).deck;
  const bottom = d[d.length - 1];
  endTurn(e, { pick: ['Place it on top of the Deck'] });
  check(e.player(0).deck[0]?.uid === bottom.uid, 'your End Phase: the bottom card goes on top (or is banished)');
}

card('Golden Gearbox');
{
  const e = duel(['Golden Gearbox', 'Karakuri Spider']);
  const k = place(e, 0, 'Karakuri Spider')!;
  playSpell(e, 0, 'Golden Gearbox');
  check(e.atkOf(k) === 900 && e.defOf(k) === 2000, 'a "Karakuri" monster gains 500 ATK and 1500 DEF');
  endTurn(e);
  check(e.atkOf(k) === 400, 'until the End Phase');
}

card('Grand Convergence');
{
  const e = duel(['Grand Convergence', 'Macro Cosmos'], [FILL]);
  check(!e.canActivateMain(0, grab(e, 0, 'Grand Convergence').uid), 'needs "Macro Cosmos"');
  playTrap(e, 0, 'Macro Cosmos');
  place(e, 0, FILL);
  place(e, 1, FILL);
  playSpell(e, 0, 'Grand Convergence');
  check(lp(e, 1) === 3700 && e.monsters(0).length + e.monsters(1).length === 0, '300 damage and all monsters are destroyed');
}

card("Gravekeeper's Stele");
{
  const e = duel([`${GK} Stele`, `${GK} Spy`, `${GK} Curse`, 'Necrovalley']);
  const a = toGy(e, 0, `${GK} Spy`);
  const b = toGy(e, 0, `${GK} Curse`);
  playSpell(e, 0, 'Necrovalley');
  playSpell(e, 0, `${GK} Stele`);
  check(zone(e, a) === 'hand' && zone(e, b) === 'hand', 'adds 2 "Gravekeeper\'s" monsters from the GY, even with Necrovalley');
}

card("Gravekeeper's Trap", true);
{
  const e = duel([`${GK} Trap`, `${GK} Spy`, `${GK} Curse`, 'Exchange of the Spirit'], [FILL]);
  const gt = playTrap(e, 0, `${GK} Trap`)!;
  effect(e, 0, gt, { pick: [FILL] }, { pick: [`${GK} Spy`] });
  check(inHand(e, 0, `${GK} Spy`), 'your Main Phase: discard 1, add a "Gravekeeper\'s" monster');
  const g1 = toGy(e, 1, FILL);
  toGy(e, 0, 'Exchange of the Spirit');
  check(e.summonBlocked(1, g1, 'special', 'gy') && !e.summonBlocked(0, g1, 'special', 'gy'), 'with "Exchange of the Spirit" in your GY: the opponent cannot Special Summon from the GY');
  const drawn = e.player(1).deck[0];
  endTurn(e, { pick: [drawn.name] });
  check(zone(e, drawn) === 'gy', "opponent's draw: the declared card is sent to the GY");
  // The opponent's Main Phase: the search is usable too (once per turn).
  summon(e, 1, FILL, true, { respond: `${GK} Trap` }, { pick: [FILL] }, { pick: [`${GK} Curse`] });
  check(inHand(e, 0, `${GK} Curse`), "the opponent's Main Phase: the search can be used too");
}

card('Gravelstorm');
{
  const e = duel(['Gravelstorm', 'Insect Barrier'], [FILL, 'Jar of Greed']);
  const ib = playSpell(e, 0, 'Insect Barrier')!;
  const st = putST(e, 1, 'Jar of Greed');
  playTrap(e, 0, 'Gravelstorm');
  check(zone(e, ib) === 'hand' && zone(e, st) === 'hand', 'a Spell/Trap on each side returns to the hand');
}

card('Gravity Axe - Grarl');
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

card('Graydle Combat', true);
for (const mode of ['Negate the activation, and if you do, destroy that card', 'The activated effect becomes "Destroy that monster"']) {
  const e = duel(['Graydle D Slime', 'Graydle Combat'], ['Change of Heart']);
  const gs = place(e, 0, 'Graydle D Slime')!;
  putST(e, 0, 'Graydle Combat');
  endTurn(e);
  playSpell(e, 1, 'Change of Heart', { respond: 'Graydle Combat' }, { pick: [mode] });
  if (mode.startsWith('Negate')) check(zone(e, gs) === 'mz' && e.controller(gs.uid) === 0 && inGy(e, 1, 'Change of Heart'), 'negates a card targeting a "Graydle" monster and destroys it');
  else check(zone(e, gs) === 'gy' && e.monsters(1).length === 0, 'or the effect becomes "Destroy that monster"');
}
{
  const e = duel(['Graydle D Slime', 'Graydle Combat'], ['Fairy Box']);
  const gs = place(e, 0, 'Graydle D Slime')!;
  const gc = putST(e, 0, 'Graydle Combat');
  const box = putST(e, 1, 'Fairy Box');
  const link = { card: box, loc: e.find(box.uid)!.loc, player: 1 as Pid, label: 'Fairy Box', negated: false, targetUid: gs.uid, payload: { effect: 'quick' } };
  check(!getEffect('Graydle Combat')!.canActivate!(e, gc, 0, 'effect', { link }), 'not against the later effect of a Spell/Trap on the field');
}

card('Guts of Steel');
{
  const e = duel(['Guts of Steel', 'Scrap D Test A', 'Scrap D Test B', 'Scrap D Test C']);
  const s = ['Scrap D Test A', 'Scrap D Test B', 'Scrap D Test C'].map((n) => toGy(e, 0, n));
  playSpell(e, 0, 'Guts of Steel');
  check(s.filter((c) => zone(e, c) === 'mz').length === 1 && s.filter((c) => zone(e, c) === 'removed').length === 2, 'the opponent picks 1 of 3 "Scrap" monsters to Special Summon; the rest are banished');
}

card('H - Heated Heart');
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

card('Half Counter');
{
  const e = duel([FILL, 'Half Counter'], ['Archfiend Soldier']);
  const mine = place(e, 0, FILL)!;
  putST(e, 0, 'Half Counter');
  endTurn(e);
  const foe = place(e, 1, 'Archfiend Soldier')!;
  toBattle(e);
  attack(e, foe, mine, { respond: 'Half Counter' });
  check(zone(e, foe) === 'gy' && e.atkOf(mine) === 1400 + 950, "the attacked monster gains half the attacker's original ATK");
}

card('Hallowed Life Barrier');
{
  const e = duel(['Hallowed Life Barrier'], ['Blue-Eyes White Dragon']);
  const mine = place(e, 0, FILL)!;
  putST(e, 0, 'Hallowed Life Barrier');
  const bewd = place(e, 1, 'Blue-Eyes White Dragon')!;
  endTurn(e);
  toBattle(e);
  const hand = e.player(0).hand.length;
  attack(e, bewd, mine, { respond: 'Hallowed Life Barrier' });
  check(lp(e, 0) === 4000 && e.player(0).hand.length === hand - 1, 'discard 1: battle damage you take this turn becomes 0');
  run(e, e.as(1, (function* () { e.damage(0, 800); })()));
  check(lp(e, 0) === 4000, "and so does effect damage from the opponent's cards");
  run(e, e.as(0, (function* () { e.damage(0, 500); })()));
  check(lp(e, 0) === 3500, 'damage you deal yourself still counts');
}

card('Hammer Shot');
{
  const e = duel(['Hammer Shot'], [`${GK} Spy`, 'Blue-Eyes White Dragon']);
  const a = place(e, 0, FILL)!;
  const b = place(e, 1, `${GK} Spy`)!;
  const bw = place(e, 1, 'Blue-Eyes White Dragon', 'def')!;
  playSpell(e, 0, 'Hammer Shot');
  check(zone(e, a) === 'gy' && zone(e, b) === 'mz' && zone(e, bw) === 'mz', 'destroys the face-up Attack Position monster with the highest ATK');
}

card("Harpies' Hunting Ground");
{
  const e = duel(["Harpies' Hunting Ground", 'Harpie Lady'], [FILL, 'Jar of Greed']);
  const st = putST(e, 1, 'Jar of Greed');
  playSpell(e, 0, "Harpies' Hunting Ground");
  const hl = summon(e, 0, 'Harpie Lady', true, { pick: ['Face-down card'] })!;
  check(e.atkOf(hl) === 1500 && e.defOf(hl) === 1600, 'Winged Beasts gain 200 ATK/DEF');
  check(zone(e, st) === 'gy', '"Harpie Lady" Summoned: its summoner destroys a Spell/Trap');
}

card('Haunted Shrine');
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

card('Hero Blast');
{
  const e = duel(['Hero Blast', 'Elemental HERO Sparkman'], [FILL, 'Blue-Eyes White Dragon']);
  const sp = toGy(e, 0, 'Elemental HERO Sparkman');
  const foe = place(e, 1, FILL)!;
  const bw = place(e, 1, 'Blue-Eyes White Dragon')!;
  playTrap(e, 0, 'Hero Blast');
  check(zone(e, sp) === 'hand' && zone(e, foe) === 'gy' && zone(e, bw) === 'mz', 'adds an "Elemental HERO" Normal Monster, then destroys a monster with ATK <= its ATK');
}

card('Hero Counterattack');
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
  check(zone(e, foe) === 'gy' && zone(e, h2) === 'mz', 'random card is an "Elemental HERO": destroys a monster and Special Summons it');
}

card('Hero Signal');
{
  const e = duel([FILL, 'Hero Signal', 'Elemental HERO Avian'], ['Archfiend Soldier']);
  const mine = place(e, 0, FILL)!;
  putST(e, 0, 'Hero Signal');
  endTurn(e);
  const foe = place(e, 1, 'Archfiend Soldier')!;
  toBattle(e);
  attack(e, foe, mine, { respond: 'Hero Signal' });
  check(!!onField(e, 0, 'Elemental HERO Avian'), 'a monster destroyed by battle: Special Summon a Level 4 or lower "Elemental HERO" from the Deck');
}

card('Hidden Armory');
{
  const e = duel(['Hidden Armory', FILL, 'Axe of Despair']);
  const c = grab(e, 0, 'Hidden Armory');
  const top = e.player(0).deck[0];
  act(e, 0, c.uid);
  check(zone(e, top) === 'gy' && inHand(e, 0, 'Axe of Despair'), 'send the top card to the GY: add an Equip Spell');
  check(!e.canNormalSummon(0, grab(e, 0, FILL)), 'you cannot Normal Summon this turn');
}

card('Hidden Soldiers');
{
  const e = duel(['Hidden Soldiers', 'Archfiend Soldier'], [FILL]);
  putST(e, 0, 'Hidden Soldiers');
  grab(e, 0, 'Archfiend Soldier');
  endTurn(e);
  summon(e, 1, FILL, true, { respond: 'Hidden Soldiers' });
  check(!!onField(e, 0, 'Archfiend Soldier'), 'the opponent Normal Summons: Special Summon a Level 4 or lower DARK monster from the hand');
}

card('Hieratic Seal From the Ashes');
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

card('Howl of the Wild');
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

card('Hunting Instinct');
{
  const e = duel(['Hunting Instinct', 'Hydrogeddon'], [FILL]);
  putST(e, 0, 'Hunting Instinct');
  grab(e, 0, 'Hydrogeddon');
  endTurn(e);
  place(e, 1, FILL, 'atk', true, { respond: 'Hunting Instinct' });
  check(!!onField(e, 0, 'Hydrogeddon'), "a monster Special Summoned to the opponent's field: Special Summon a Dinosaur from the hand");
}

card('Hysteric Party');
{
  const e = duel(['Hysteric Party', 'Harpie Lady', 'Harpie Lady 1']);
  const a = toGy(e, 0, 'Harpie Lady');
  const b = toGy(e, 0, 'Harpie Lady 1');
  const hp = playTrap(e, 0, 'Hysteric Party')!;
  check(zone(e, a) === 'mz' && zone(e, b) === 'mz', 'discard 1: Special Summons every "Harpie Lady" from the GY');
  kill(e, [hp], 1);
  check(zone(e, a) === 'gy' && zone(e, b) === 'gy', 'when it leaves the field, those monsters are destroyed');
}

card('Hysteric Sign');
{
  const e = duel(['Hysteric Sign', 'Elegant Egotist', 'Harpie Lady', 'Harpie Queen', 'Harpie Channeler']);
  const hs = playSpell(e, 0, 'Hysteric Sign')!;
  check(inHand(e, 0, 'Elegant Egotist'), 'activated: adds "Elegant Egotist"');
  toTurn3(e);
  kill(e, [hs], 1);
  endTurn(e, { pick: ['Harpie Lady', 'Harpie Queen', 'Harpie Channeler'] });
  check(['Harpie Lady', 'Harpie Queen', 'Harpie Channeler'].every((n) => inHand(e, 0, n)), 'sent to the GY this turn: End Phase, adds up to 3 "Harpie" cards');
}

card('Impenetrable Attack');
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

card('Infestation Wave');
{
  const e = duel(['Steelswarm D Roach', 'Infestation Wave'], [FILL]);
  const iw = putST(e, 0, 'Infestation Wave');
  place(e, 0, FILL);
  const s = summon(e, 0, 'Steelswarm D Roach')!;
  const foe = place(e, 1, FILL)!;
  act(e, 0, iw.uid);
  check(zone(e, s) === 'hand' && zone(e, foe) === 'gy', 'return a Tribute Summoned "Steelswarm" to the hand: destroy a card the opponent controls');
}

card('Infinite Cards');
{
  const e = duel(['Infinite Cards']);
  playSpell(e, 0, 'Infinite Cards');
  for (let i = 0; i < 5; i++) e.toHandOf(e.player(0).deck[0].uid, 0);
  const n = e.player(0).hand.length;
  endTurn(e);
  check(n > 6 && e.player(0).hand.length === n, 'no hand size limit');
}

card('Insect Barrier');
{
  const e = duel(['Insect Barrier'], ['Basic Insect', FILL]);
  playSpell(e, 0, 'Insect Barrier');
  endTurn(e);
  const ins = place(e, 1, 'Basic Insect')!;
  const w = place(e, 1, FILL)!;
  toBattle(e);
  check(!e.canAttackWith(1, ins) && e.canAttackWith(1, w), "the opponent's Insects cannot attack");
}

card('Insect Neglect');
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

card('Inspiration');
{
  const e = duel(['Inspiration']);
  const m = place(e, 0, FILL)!;
  playTrap(e, 0, 'Inspiration');
  check(e.atkOf(m) === 2100, 'gains 700 ATK');
  endTurn(e);
  check(e.atkOf(m) === 1400, 'until the end of this turn');
}

card('Inverse Universe', true);
{
  const e = duel(['Inverse Universe', `${GK} Spy`], [], ['Flame Swordsman']);
  const spy = place(e, 0, `${GK} Spy`)!;
  const n = place(e, 0, FILL)!;
  const fs = placeX(e, 0, 'Flame Swordsman')!;
  playTrap(e, 0, 'Inverse Universe');
  check(e.atkOf(spy) === 2000 && e.defOf(spy) === 1200, 'switches the ATK/DEF of face-up Effect Monsters');
  check(e.atkOf(n) === 1400 && e.atkOf(fs) === 1800, 'not Normal Monsters, nor Fusion Monsters without effects');
}
{
  const e = duel(['Inverse Universe', 'Embodiment of Apophis']);
  const ap = playTrap(e, 0, 'Embodiment of Apophis', 'no')!;
  playTrap(e, 0, 'Inverse Universe');
  check(e.atkOf(ap) === 1600, 'not a Trap Monster Summoned as a Normal Monster');
}

card('Iron Draw', true);
{
  const e = duel(['Iron Draw', 'Karakuri Spider', 'Jade Knight']);
  place(e, 0, 'Karakuri Spider');
  place(e, 0, 'Jade Knight');
  const c = grab(e, 0, 'Iron Draw');
  const n = e.player(0).hand.length;
  act(e, 0, c.uid);
  check(e.player(0).hand.length === n - 1 + 2, 'exactly 2 Machine Effect Monsters: draw 2');
  const f = grab(e, 0, FILL);
  run(e, e.specialSummon(f.uid, 0, 'atk'));
  check(e.summonBlocked(0, grab(e, 0, FILL), 'special', 'hand'), 'then only 1 Special Summon this turn');
}
{
  const e = duel(['Iron Draw', 'Karakuri Spider', 'Normal D Machine']);
  place(e, 0, 'Karakuri Spider');
  place(e, 0, 'Normal D Machine');
  check(!e.canActivateMain(0, grab(e, 0, 'Iron Draw').uid), 'not with a Normal Machine monster');
}

card('Jam Defender');
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

card('Jar of Greed');
{
  const e = duel(['Jar of Greed']);
  const n = e.player(0).hand.length;
  const j = playTrap(e, 0, 'Jar of Greed');
  check(e.player(0).hand.length === n + 1 && !j, 'draw 1 card, then it goes to the GY');
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
console.log(`D: ${checked} cards checked, ${fixed} fixed`);
process.exit(fails ? 1 : 0);
