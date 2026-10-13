// Speed Duel Continuous Spells/Traps of batch 11 (run: npx tsx tests/cont-d.test.ts)
// For each card: it can be activated when its text allows, it stays face-up, its ongoing effect
// happens (again and again), it stops once the card leaves the field, and its self-destruct rules work.
import { Engine } from '../src/eds/engine';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';

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

// ======================= Continuous Spells =======================
section('Ancient Gear Castle');
{
  const e = duel(['Ancient Gear Castle', 'Ancient Gear', 'Ancient Gear Golem', 'Axe Raider'], ['Axe Raider']);
  const castle = playSpell(e, 0, 'Ancient Gear Castle');
  check(active(e, castle), 'activates from the hand and stays face-up');
  const ag = summon(e, 0, 'Ancient Gear');
  check(ag && e.atkOf(ag) === 400, '"Ancient Gear" monsters gain 300 ATK');
  check(castle!.counters === 1, 'a Normal Summon places a counter');
  summon(e, 0, FILL, false);
  check(castle!.counters === 2, 'a Normal Set places a counter');
  endTurn(e);
  const axe = summon(e, 1, 'Axe Raider');
  check(castle!.counters === 3 && e.atkOf(axe!) === 1700, "the opponent's Normal Summon adds a counter too; non-Ancient Gear monsters get nothing");
  endTurn(e);
  const golem = grab(e, 0, 'Ancient Gear Golem');
  castle!.counters = 1;
  check(e.tributeStandIns(0, golem, 2).length === 0, 'with fewer counters than Tributes it cannot stand in');
  castle!.counters = 3;
  check(e.tributeStandIns(0, golem, 2).length === 1 && e.tributeStandIns(0, grab(e, 0, 'Axe Raider'), 1).length === 0, 'it can stand in for an "Ancient Gear" Tribute Summon only');
  e.apply({ type: 'SUMMON', player: 0, uid: golem.uid, zone: 2, pos: 'atk', faceUp: true });
  settle(e, 'yes');
  check(zone(e, golem) === 'mz' && zone(e, castle) === 'gy' && e.monsters(0).length === 3, 'Ancient Gear Golem is Tribute Summoned by Tributing the Castle instead of 2 monsters');
  check(e.atkOf(ag!) === 100 && e.atkOf(e.fieldCard(golem.uid)!) === 3000, 'the ATK bonus is gone once the Castle left the field');
}
{
  const e = duel(['Ancient Gear Castle', 'Ancient Gear']);
  const castle = playSpell(e, 0, 'Ancient Gear Castle');
  const ag = summon(e, 0, 'Ancient Gear');
  kill(e, [castle]);
  check(zone(e, castle) === 'gy' && e.atkOf(ag!) === 100, 'destroyed: the bonus stops');
}

section('Arcane Barrier');
{
  const e = duel(['Arcane Barrier', 'Sealmaster Meisei', 'Aqua Madoor', 'Rogue Doll'], ['Saggi the Dark Clown', 'Mystical Elf', 'Thousand-Eyes Idol', 'Rogue Doll']);
  const ab = playSpell(e, 0, 'Arcane Barrier');
  check(active(e, ab), 'activates from the hand and stays face-up');
  kill(e, [place(e, 0, 'Sealmaster Meisei')]);
  check(ab!.counters === 1, 'a destroyed face-up Spellcaster places a Spell Counter');
  kill(e, [place(e, 1, 'Saggi the Dark Clown'), place(e, 1, 'Mystical Elf')]);
  check(ab!.counters === 2, 'two Spellcasters destroyed at once: 1 counter (each time = each event)');
  kill(e, [place(e, 1, 'Thousand-Eyes Idol', 'def', false)]);
  kill(e, [place(e, 1, FILL)]);
  check(ab!.counters === 2, 'face-down or non-Spellcaster monsters add nothing');
  ab!.counters = 4;
  kill(e, [place(e, 1, 'Rogue Doll')]);
  check(ab!.counters === 4, 'max. 4 Spell Counters');
  ab!.counters = 2;
  const madoor = place(e, 0, 'Aqua Madoor');
  const hand = e.player(0).hand.length;
  effect(e, 0, ab, { pick: ['Aqua Madoor'] });
  check(zone(e, ab) === 'gy' && zone(e, madoor) === 'gy' && e.player(0).hand.length === hand + 2, 'send it + a Spellcaster to the GY: draw 1 per counter (2)');
  kill(e, [place(e, 0, 'Rogue Doll')]);
  check(!e.liveST().length, 'gone from the field: nothing counts any more');
}

section('Attack the Moon!');
{
  const e = duel(['Attack the Moon!', 'Giant Soldier of Stone', 'Giant Soldier of Stone', 'Beta The Magnet Warrior', 'Axe Raider'], ['Hinotama', 'Ookazi', 'Giant Soldier of Stone']);
  const moon = playSpell(e, 0, 'Attack the Moon!');
  check(active(e, moon), 'activates from the hand and stays face-up');
  const rock = place(e, 0, 'Giant Soldier of Stone')!;
  const rock2 = place(e, 0, 'Beta The Magnet Warrior')!;
  const axe = place(e, 0, 'Axe Raider')!;
  for (const m of [rock, rock2, axe]) m.placedTurn = -1;
  const t1 = putST(e, 1, 'Hinotama');
  const t2 = putST(e, 1, 'Ookazi');
  e.apply({ type: 'CHANGE_POS', player: 0, uid: axe.uid });
  check(settle(e, 'yes') === 1 && zone(e, t1) === 'sz', 'a non-Rock position change does nothing');
  e.apply({ type: 'CHANGE_POS', player: 0, uid: rock.uid });
  settle(e, 'yes', { pick: ['Face-down card'] });
  check(rock.pos === 'def' && [zone(e, t1), zone(e, t2)].filter((z) => z === 'gy').length === 1, "a Rock changes position: 1 of the opponent's Spells/Traps is destroyed");
  e.apply({ type: 'CHANGE_POS', player: 0, uid: rock2.uid });
  check(settle(e, 'yes') === 1 && [zone(e, t1), zone(e, t2)].filter((z) => z === 'sz').length === 1, 'once per turn');
  endTurn(e);
  const theirRock = place(e, 1, 'Giant Soldier of Stone')!;
  theirRock.placedTurn = -1;
  e.apply({ type: 'CHANGE_POS', player: 1, uid: theirRock.uid });
  check(settle(e, 'yes') === 1, "the opponent's Rock does not trigger it");
  endTurn(e);
  e.apply({ type: 'CHANGE_POS', player: 0, uid: rock.uid });
  settle(e, 'yes');
  check(zone(e, t1) === 'gy' && zone(e, t2) === 'gy', 'it works again the next turn');
  const t3 = putST(e, 1, FILL);
  kill(e, [axe]);
  endTurn(e);
  endTurn(e);
  const fd = place(e, 0, 'Giant Soldier of Stone', 'def', false);
  if (fd) e.apply({ type: 'FLIP_SUMMON', player: 0, uid: fd.uid });
  settle(e, 'yes');
  check(fd?.faceUp && zone(e, t3) === 'gy', 'a Flip Summon of a Rock is a position change too');
  const t4 = putST(e, 1, FILL);
  kill(e, [moon]);
  endTurn(e);
  endTurn(e);
  e.apply({ type: 'CHANGE_POS', player: 0, uid: rock.uid });
  check(settle(e, 'yes') === 1 && zone(e, t4) === 'sz', 'destroyed: no more triggers');
}

section('Branded Disciple');
{
  const e = duel(['Branded Disciple'], ['Cyber Valley', 'Axe Raider'], ['Evil HERO Wild Cyclone']);
  const bd = playSpell(e, 0, 'Branded Disciple');
  check(active(e, bd), 'activates from the hand and stays face-up');
  const cyclone = place(e, 0, 'Evil HERO Wild Cyclone');
  endTurn(e);
  const valley = place(e, 1, 'Cyber Valley');
  place(e, 1, 'Axe Raider');
  const hand = e.player(1).hand.length;
  effect(e, 1, valley, { respond: 'Branded Disciple' });
  check(logHas(e, 'Branded Disciple negates') && e.player(1).hand.length === hand && zone(e, valley) === 'mz', "an opponent's 0 ATK monster's effect is negated while you control a Level 8+ Fiend Fusion");
  check(!e.oncePerTurn('Branded Disciple:1', 0), 'once per turn');
  endTurn(e);
  kill(e, [cyclone]);
  endTurn(e);
  const n = e.player(1).hand.length;
  effect(e, 1, valley, { respond: 'Branded Disciple' });
  check(e.player(1).hand.length === n + 2, 'without a Level 8+ Fiend Fusion it cannot negate');
}
{
  const e = duel(['Branded Disciple', 'Thousand-Eyes Idol'], ['Cyber Valley', 'Thousand-Eyes Idol']);
  const bd = playSpell(e, 0, 'Branded Disciple');
  const idol = place(e, 0, 'Thousand-Eyes Idol');
  endTurn(e);
  const valley = place(e, 1, 'Cyber Valley');
  endTurn(e);
  toBattle(e);
  attack(e, idol, valley, 'yes');
  check(zone(e, valley) === 'gy' && zone(e, idol) === 'mz', "two 0 ATK monsters battled: the opponent's battling monster is destroyed at the end of the Damage Step");
  kill(e, [bd]);
  endTurn(e);
  const idol2 = place(e, 1, 'Thousand-Eyes Idol');
  endTurn(e);
  toBattle(e);
  check(attack(e, idol, idol2, 'yes') === 1 && zone(e, idol2) === 'mz', 'destroyed: no more effect');
}

section('Cerulean Skyfire');
{
  const e = duel(['Cerulean Skyfire', 'Hamon, Lord of Striking Thunder', 'Hinotama', 'Ookazi']);
  const ham = grab(e, 0, 'Hamon, Lord of Striking Thunder');
  putST(e, 0, 'Hinotama');
  putST(e, 0, 'Ookazi');
  check(!e.canSpecialProc(0, ham), 'Hamon cannot use face-down Spells without Cerulean Skyfire');
  const sky = playSpell(e, 0, 'Cerulean Skyfire');
  check(active(e, sky), 'activates from the hand and stays face-up');
  check(e.canSpecialProc(0, ham), 'with Cerulean Skyfire, face-down Spells count for Hamon');
  e.apply({ type: 'SPECIAL', player: 0, uid: ham.uid });
  settle(e);
  check(zone(e, ham) === 'mz' && e.player(0).gy.length === 3, 'Hamon is Special Summoned with Skyfire + 2 face-down Spells');
}
{
  const e = duel(['Cerulean Skyfire', 'Hamon, Lord of Striking Thunder'], ['Hinotama', 'Hinotama', 'Hinotama', 'Ookazi', 'Ookazi']);
  const sky = playSpell(e, 0, 'Cerulean Skyfire');
  const ham = place(e, 0, 'Hamon, Lord of Striking Thunder')!;
  endTurn(e);
  playSpell(e, 1, 'Hinotama', { respond: 'Cerulean Skyfire' });
  check(e.player(0).lp === 4000 && ham.pos === 'def', "an opponent's Spell is negated, then Hamon changes to Defense Position");
  playSpell(e, 1, 'Hinotama', { respond: 'Cerulean Skyfire' });
  check(e.player(0).lp === 3500, 'once per turn / needs an Attack Position Hamon');
  kill(e, [ham]);
  playSpell(e, 1, 'Hinotama');
  check(e.player(0).lp === 3500, 'a Sacred Beast left the field: no damage this turn');
  endTurn(e);
  e.damage(0, 100);
  check(e.player(0).lp === 3400, 'damage again the next turn');
  const ham2 = place(e, 0, 'Hamon, Lord of Striking Thunder')!;
  kill(e, [sky]);
  endTurn(e);
  playSpell(e, 1, 'Ookazi', { respond: 'Cerulean Skyfire' });
  check(e.player(0).lp === 2600 && ham2.pos === 'atk', 'destroyed: it no longer negates');
}

section('Constellar Belt');
{
  const e = duel(['Constellar Belt', 'Divine Wrath', 'Divine Wrath'], ['Cyber Valley', 'Axe Raider', 'Cyber Valley']);
  const belt = playSpell(e, 0, 'Constellar Belt');
  check(active(e, belt), 'activates from the hand and stays face-up');
  putST(e, 0, 'Divine Wrath');
  endTurn(e);
  const valley = place(e, 1, 'Cyber Valley');
  place(e, 1, 'Axe Raider');
  const mark = e.state.log.length;
  effect(e, 1, valley, { respond: 'Divine Wrath' });
  check(logHas(e, "Constellar Belt: Cyber Valley's activation cannot be negated", mark) && !logHas(e, 'Cyber Valley is negated', mark), "a LIGHT monster's effect activation cannot be negated");
  kill(e, [belt]);
  putST(e, 0, 'Divine Wrath');
  endTurn(e);
  endTurn(e);
  const valley2 = place(e, 1, 'Cyber Valley');
  const mark2 = e.state.log.length;
  effect(e, 1, valley2, { respond: 'Divine Wrath' });
  check(logHas(e, 'Cyber Valley is negated', mark2), 'destroyed: the activation can be negated again');
}

section('Hidden Temples of Necrovalley');
{
  const e = duel(['Hidden Temples of Necrovalley', "Gravekeeper's Spy", "Gravekeeper's Priestess"], ['Axe Raider', 'Axe Raider']);
  const ht = grab(e, 0, 'Hidden Temples of Necrovalley');
  const spy = place(e, 0, "Gravekeeper's Spy");
  check(!e.canActivateMain(0, ht.uid), 'needs "Necrovalley" on the field too');
  const priestess = place(e, 0, "Gravekeeper's Priestess");
  check(e.canActivateMain(0, ht.uid), 'a "Gravekeeper\'s" monster and "Necrovalley" (Priestess): it can be activated');
  act(e, 0, ht.uid);
  const fc = e.fieldCard(ht.uid);
  check(active(e, fc), 'stays face-up');
  check(place(e, 1, 'Axe Raider') === null && e.createToken('Sheep Token', 1, 'atk') === null, 'neither player can Special Summon non-"Gravekeeper\'s" monsters (Tokens included)');
  kill(e, [spy]);
  check(place(e, 0, "Gravekeeper's Spy") !== null, '"Gravekeeper\'s" monsters can still be Special Summoned');
  kill(e, [priestess]);
  check(zone(e, ht) === 'gy', 'no "Necrovalley" any more: it destroys itself');
  check(place(e, 1, 'Axe Raider') !== null, 'once gone, Special Summons are allowed again');
}

section('Jam Breeding Machine');
{
  const e = duel(['Jam Breeding Machine', 'Axe Raider', 'Axe Raider'], ['Axe Raider']);
  const jam = playSpell(e, 0, 'Jam Breeding Machine');
  check(active(e, jam), 'activates from the hand and stays face-up');
  const celtic = grab(e, 0, 'Axe Raider');
  check(!e.canNormalSummon(0, celtic, true) && e.canNormalSummon(0, celtic, false), 'you cannot Normal Summon, but you can Set');
  check(summon(e, 0, 'Axe Raider', true) === null, 'a face-up Normal Summon is refused');
  const set = summon(e, 0, 'Axe Raider', false)!;
  check(set && !set.faceUp, 'a Set works');
  check(place(e, 0, FILL) === null && place(e, 1, 'Axe Raider') !== null, 'you cannot Special Summon; the opponent can');
  const slimes = () => e.monsters(0).filter((m) => m.name === 'Slime Token');
  endTurn(e);
  check(slimes().length === 0, "no Token during the opponent's Standby Phase");
  endTurn(e);
  check(slimes().length === 1 && e.atkOf(slimes()[0]) === 500 && slimes()[0].pos === 'atk', 'your Standby Phase: a 500/500 Slime Token in Attack Position');
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: set.uid });
  settle(e);
  check(!set.faceUp, 'Flip Summons are refused too');
  endTurn(e);
  endTurn(e);
  check(slimes().length === 2, 'and another one each of your Standby Phases');
  kill(e, [jam, slimes()[0]]);
  check(e.canNormalSummon(0, grab(e, 0, FILL), true), 'destroyed: Summons are allowed again');
  endTurn(e);
  endTurn(e);
  check(slimes().length === 1, 'destroyed: no more Tokens');
}

section('Machine Assembly Line');
{
  const e = duel(['Machine Assembly Line', 'Mechanicalchaser', 'Golgoil'], ['Yaiba Robo', 'Cycroid', 'Golgoil', 'Bokoichi the Freightening Car']);
  const line = playSpell(e, 0, 'Machine Assembly Line');
  check(active(e, line), 'activates from the hand and stays face-up');
  const chaser = place(e, 0, 'Mechanicalchaser')!;
  const robo = place(e, 1, 'Yaiba Robo')!;
  const celtic = place(e, 1, FILL)!;
  check(e.atkOf(chaser) === 2050 && e.atkOf(robo) === 1200 && e.atkOf(celtic) === 1400, 'all Machines on the field gain 200 ATK');
  kill(e, [chaser]);
  check(line!.counters === 2, 'a face-up Machine destroyed: 2 Junk Counters');
  kill(e, [robo, celtic]);
  kill(e, [place(e, 1, 'Cycroid'), place(e, 1, 'Golgoil')]);
  check(line!.counters === 6, 'each time: +2 per event (2 Machines at once = +2)');
  kill(e, [place(e, 1, 'Bokoichi the Freightening Car', 'def', false)]);
  check(line!.counters === 6, 'face-down Machines do not count');
  line!.counters = 4;
  effect(e, 0, line, { pick: ['Mechanicalchaser'] });
  const back = e.monsters(0).find((m) => m.name === 'Mechanicalchaser');
  check(zone(e, line) === 'gy' && back && e.atkOf(back) === 1850, 'send it to the GY: Special Summon a Machine with Level <= counters (and the ATK bonus is gone)');
}

section('Millennium Revelation');
{
  const e = duel(['Millennium Revelation', 'Slifer the Sky Dragon', 'Obelisk the Tormentor', 'Monster Reborn', 'The Winged Dragon of Ra']);
  const mr = playSpell(e, 0, 'Millennium Revelation');
  check(active(e, mr), 'activates from the hand and stays face-up');
  grab(e, 0, 'Slifer the Sky Dragon');
  effect(e, 0, mr, { pick: ['Send a Divine-Beast: add "Monster Reborn"'] }, { pick: ['Slifer the Sky Dragon'] });
  check(e.player(0).gy.some((c) => c.name === 'Slifer the Sky Dragon') && e.player(0).hand.some((c) => c.name === 'Monster Reborn') && active(e, mr), 'send a Divine-Beast from the hand: add "Monster Reborn" from the Deck; the card stays');
  grab(e, 0, 'Obelisk the Tormentor');
  let offered: string[] = [];
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: mr!.uid });
  if (e.state.prompt?.kind === 'select') offered = e.state.prompt.options.map((o) => o.label);
  check(offered.length === 1 && offered[0].startsWith('Send this card'), 'the first effect is once per turn');
  settle(e);
  check(zone(e, mr) === 'gy' && e.state.fx.revelation?.[0] === e.state.turn, 'send it to the GY: Ra can be revived with Monster Reborn this turn');
  const ra = grab(e, 0, 'The Winged Dragon of Ra');
  run(e, e.sendToGrave(ra.uid, 'cost'));
  act(e, 0, grab(e, 0, 'Monster Reborn').uid, { pick: ['The Winged Dragon of Ra'] }, 'yes');
  check(zone(e, ra) === 'mz', 'Ra is Special Summoned with Monster Reborn');
  endTurn(e);
  check(zone(e, ra) === 'gy' && logHas(e, 'The Winged Dragon of Ra is sent to the Graveyard'), 'End Phase: that Ra is sent to the GY');
}

section('Spiral Spear Strike');
{
  const e = duel(['Spiral Spear Strike', 'Gaia The Fierce Knight', 'Axe Raider'], ['Rogue Doll', 'Feral Imp', 'Mystical Elf', 'Giant Soldier of Stone'], ['Gaia the Dragon Champion']);
  const sp = playSpell(e, 0, 'Spiral Spear Strike');
  check(active(e, sp), 'activates from the hand and stays face-up');
  const gaia = place(e, 0, 'Gaia The Fierce Knight')!;
  const axe = place(e, 0, 'Axe Raider')!;
  endTurn(e);
  const celtic = place(e, 1, FILL, 'def')!;
  const doll = place(e, 1, 'Rogue Doll', 'def')!;
  endTurn(e);
  toBattle(e);
  attack(e, gaia, celtic);
  check(e.player(1).lp === 4000 - 1100, '"Gaia The Fierce Knight" inflicts piercing damage');
  attack(e, axe, doll);
  check(e.player(1).lp === 2900 && zone(e, doll) === 'gy', 'other monsters do not');
  const imp = place(e, 1, 'Feral Imp', 'def')!;
  const dc = place(e, 0, 'Gaia the Dragon Champion')!;
  const hand = e.player(0).hand.length;
  attack(e, dc, imp);
  check(e.player(1).lp === 2900 - 1200 && e.player(0).hand.length === hand + 1, '"Gaia the Dragon Champion" pierces, then draw 2 and discard 1');
  kill(e, [sp]);
  endTurn(e);
  const elf = place(e, 1, 'Giant Soldier of Stone', 'def')!;
  endTurn(e);
  toBattle(e);
  const lp = e.player(1).lp;
  attack(e, dc, elf);
  check(e.player(1).lp === lp, 'destroyed: no more piercing');
}

section('Supply Squad');
{
  const e = duel(['Supply Squad', 'Thousand-Eyes Idol'], ['Axe Raider', 'Axe Raider']);
  const sq = playSpell(e, 0, 'Supply Squad');
  check(active(e, sq), 'activates from the hand and stays face-up');
  const h = () => e.player(0).hand.length;
  let n = h();
  kill(e, [place(e, 0, FILL)]);
  check(h() === n + 1, 'a monster you control is destroyed: draw 1');
  n = h();
  kill(e, [place(e, 0, FILL)]);
  check(h() === n, 'once per turn');
  endTurn(e);
  n = h();
  kill(e, [place(e, 1, 'Axe Raider')]);
  check(h() === n, "the opponent's monsters do not count");
  kill(e, [place(e, 0, FILL)]);
  check(h() === n + 1, "it works again on the opponent's turn");
  const weak = place(e, 0, 'Thousand-Eyes Idol');
  endTurn(e);
  const theirs = place(e, 1, 'Axe Raider');
  n = h();
  toBattle(e);
  attack(e, weak, theirs);
  check(zone(e, weak) === 'gy' && h() === n + 1, 'destroyed by battle counts too');
  kill(e, [sq]);
  endTurn(e);
  n = h();
  kill(e, [place(e, 0, FILL)]);
  check(h() === n, 'destroyed: no more draws');
}

section('Talisman of Trap Sealing');
{
  const e = duel(['Talisman of Trap Sealing', 'Sealmaster Meisei'], ['Coffin Seller', 'Coffin Seller'], [], [], 1);
  const coffin = playTrap(e, 1, 'Coffin Seller');
  endTurn(e);
  const tal = grab(e, 0, 'Talisman of Trap Sealing');
  check(!e.canActivateMain(0, tal.uid), 'cannot be activated without a face-up "Sealmaster Meisei"');
  const meisei = place(e, 0, 'Sealmaster Meisei');
  act(e, 0, tal.uid);
  const t = e.fieldCard(tal.uid);
  check(active(e, t), 'activates with Meisei and stays face-up');
  const lp = e.player(0).lp;
  kill(e, [place(e, 0, FILL)]);
  check(e.player(0).lp === lp && !e.liveST().some((x) => x.c.uid === coffin!.uid), 'face-up Traps are negated (Coffin Seller does nothing)');
  endTurn(e);
  const set = putST(e, 1, 'Coffin Seller');
  check(!e.canActivateMain(1, set.uid), 'Traps cannot be activated');
  kill(e, [meisei]);
  check(zone(e, tal) === 'gy', '"Sealmaster Meisei" left the field: the Talisman is destroyed');
  check(e.canActivateMain(1, set.uid), 'Traps can be activated again');
  const lp2 = e.player(0).lp;
  kill(e, [place(e, 0, FILL)]);
  check(e.player(0).lp === lp2 - 300, 'and face-up Traps work again');
}
{
  const e = duel(['Talisman of Trap Sealing', 'Sealmaster Meisei'], ['Coffin Seller']);
  place(e, 0, 'Sealmaster Meisei');
  const t = playSpell(e, 0, 'Talisman of Trap Sealing');
  endTurn(e);
  const set = putST(e, 1, 'Coffin Seller');
  check(!e.canActivateMain(1, set.uid), 'sealed while it is on the field');
  kill(e, [t]);
  check(e.canActivateMain(1, set.uid), 'destroyed by an effect: Traps work again');
}

section('Talisman of Spell Sealing');
{
  const e = duel(['Talisman of Spell Sealing', 'Sealmaster Meisei'], ['Supply Squad', 'Hinotama', 'Axe Raider'], [], [], 1);
  const squad = playSpell(e, 1, 'Supply Squad');
  endTurn(e);
  const tal = putST(e, 0, 'Talisman of Spell Sealing');
  check(!e.canActivateMain(0, tal.uid), 'cannot be activated without a face-up "Sealmaster Meisei"');
  const meisei = place(e, 0, 'Sealmaster Meisei');
  act(e, 0, tal.uid);
  check(active(e, e.fieldCard(tal.uid)), 'activates with Meisei and stays face-up');
  const h = e.player(1).hand.length;
  kill(e, [place(e, 1, 'Axe Raider')]);
  check(e.player(1).hand.length === h && !e.liveST().some((x) => x.c.uid === squad!.uid), 'face-up Spells are negated (Supply Squad does nothing)');
  endTurn(e);
  const hino = grab(e, 1, 'Hinotama');
  check(!e.canActivateMain(1, hino.uid), 'Spells cannot be activated');
  kill(e, [meisei]);
  check(zone(e, tal) === 'gy', '"Sealmaster Meisei" left the field: the Talisman is destroyed');
  check(e.canActivateMain(1, hino.uid), 'Spells can be activated again');
  const h2 = e.player(1).hand.length;
  kill(e, [place(e, 1, FILL)]);
  check(e.player(1).hand.length === h2 + 1, 'and face-up Spells work again');
}
{
  const e = duel(['Talisman of Spell Sealing', 'Sealmaster Meisei'], ['Hinotama']);
  place(e, 0, 'Sealmaster Meisei');
  const t = playTrap(e, 0, 'Talisman of Spell Sealing');
  endTurn(e);
  const hino = grab(e, 1, 'Hinotama');
  check(!e.canActivateMain(1, hino.uid), 'sealed while it is on the field');
  kill(e, [t]);
  check(e.canActivateMain(1, hino.uid), 'destroyed by an effect: Spells work again');
}

section('Veil of Darkness');
{
  const e = duel(['Veil of Darkness', 'Feral Imp', 'Feral Imp']);
  const veil = playSpell(e, 0, 'Veil of Darkness');
  check(active(e, veil), 'activates from the hand and stays face-up');
  const imp = grab(e, 0, 'Feral Imp');
  e.toDeckTop(imp.uid);
  endTurn(e);
  const hand = e.player(0).hand.length;
  endTurn(e, 'yes', 'yes');
  check(zone(e, imp) === 'gy' && e.player(0).hand.length === hand + 1, 'drew a DARK monster: reveal it, send it to the GY, then draw 1 more');
  endTurn(e);
  const h2 = e.player(0).hand.length;
  check(endTurn(e, 'yes') === 1 && e.player(0).hand.length === h2 + 1, 'a non-DARK draw: nothing');
  kill(e, [veil]);
  const imp2 = grab(e, 0, 'Feral Imp');
  e.toDeckTop(imp2.uid);
  endTurn(e);
  check(endTurn(e, 'yes') === 1 && zone(e, imp2) === 'hand', 'destroyed: no more effect');
}

section('Verdant Sanctuary');
{
  const e = duel(['Verdant Sanctuary', 'Big Insect', 'Gokibore', 'Basic Insect'], ['Girochin Kuwagata', 'Big Insect']);
  const vs = playSpell(e, 0, 'Verdant Sanctuary');
  check(active(e, vs), 'activates from the hand and stays face-up');
  kill(e, [place(e, 0, 'Big Insect')], undefined, 'yes');
  check(e.player(0).hand.some((c) => c.name === 'Gokibore'), 'your Insect destroyed: add an Insect with the same Level from the Deck');
  kill(e, [place(e, 1, 'Girochin Kuwagata')], undefined, 'yes');
  check(e.player(1).hand.some((c) => c.name === 'Big Insect'), "the opponent's Insect: its controller adds one");
  check(kill(e, [place(e, 0, 'Basic Insect', 'def', false)], undefined, 'yes') === 1, 'face-down Insects do not count');
  kill(e, [vs]);
  const big = place(e, 1, FILL);
  check(kill(e, [big], undefined, 'yes') === 1, 'destroyed: no more effect');
}

// ======================= Continuous Traps =======================
section('Awakening of the Sacred Beasts');
{
  const e = duel(['Awakening of the Sacred Beasts', 'Uria, Lord of Searing Flames', 'Hamon, Lord of Striking Thunder', 'Raviel, Lord of Phantasms', 'Coffin Seller'], ['Axe Raider', 'Cyber Valley', 'Axe Raider']);
  const aw = playTrap(e, 0, 'Awakening of the Sacred Beasts');
  check(active(e, aw), 'activates and stays face-up');
  // audit-10: Uria can only be Special Summoned by its own procedure; this setup shortcut ignores its Summoning condition.
  e.state.fx.ignoreCond = e.player(0).deck.find((c) => c.name === 'Uria, Lord of Searing Flames')!.uid;
  place(e, 0, 'Uria, Lord of Searing Flames');
  e.state.fx.ignoreCond = undefined;
  endTurn(e);
  summon(e, 1, FILL);
  check(e.player(0).lp === 4000 + 1400, '1 Sacred Beast: gain LP equal to the ATK of a monster the opponent Normal Summons');
  place(e, 1, 'Axe Raider');
  check(e.player(0).lp === 5400 + 1700, '...or Special Summons');
  place(e, 0, 'Hamon, Lord of Striking Thunder');
  const valley = place(e, 1, 'Cyber Valley');
  const lp = e.player(0).lp;
  check(lp === 7100 + 0, 'a 0 ATK monster: 0 LP');
  const hand = e.player(1).hand.length;
  const mark = e.state.log.length;
  effect(e, 1, valley);
  check(logHas(e, "Cyber Valley's effect was negated", mark) && e.player(1).hand.length === hand, "2 Sacred Beasts: the opponent's monster effects are negated");
  place(e, 0, 'Raviel, Lord of Phantasms');
  const axe = e.monsters(1).find((m) => m.name === 'Axe Raider')!;
  kill(e, [axe]);
  check(zone(e, axe) === 'removed', "3 Sacred Beasts: monsters sent to the opponent's GY are banished");
  endTurn(e);
  run(e, e.sendToGrave(grab(e, 0, 'Coffin Seller').uid, 'cost'));
  effect(e, 0, aw);
  check(e.player(0).hand.some((c) => c.name === 'Coffin Seller'), 'with a Level 10 monster: add a Continuous Trap from the GY to the hand');
  kill(e, [aw]);
  endTurn(e);
  const lp2 = e.player(0).lp;
  const axe2 = place(e, 1, 'Axe Raider');
  check(e.player(0).lp === lp2, 'destroyed: no more LP');
  kill(e, [axe2]);
  check(zone(e, axe2) === 'gy', 'destroyed: monsters go to the GY again');
}

section('Battle-Scarred');
{
  const e = duel(['Battle-Scarred', 'Shadowknight Archfiend']);
  const arch = place(e, 0, 'Shadowknight Archfiend')!;
  const bs = playTrap(e, 0, 'Battle-Scarred');
  check(active(e, bs) && bs!.tags?.bsTarget === arch.uid, 'activates selecting an Archfiend and stays face-up');
  endTurn(e);
  check(e.player(0).lp === 4000 && e.player(1).lp === 4000, "nothing during the opponent's Standby Phase");
  endTurn(e);
  check(e.player(0).lp === 3100 && e.player(1).lp === 3100, 'your Standby Phase: the opponent pays the same 900 LP');
  endTurn(e);
  endTurn(e);
  check(e.player(0).lp === 2200 && e.player(1).lp === 2200, 'again each of your Standby Phases');
  kill(e, [bs]);
  check(zone(e, arch) === 'gy', 'it left the field: the selected monster is destroyed');
}
{
  const e = duel(['Battle-Scarred', 'Shadowknight Archfiend']);
  const arch = place(e, 0, 'Shadowknight Archfiend')!;
  const bs = playTrap(e, 0, 'Battle-Scarred');
  kill(e, [arch]);
  check(zone(e, bs) === 'gy', 'the selected monster left the field: Battle-Scarred is destroyed');
  const e2 = duel(['Battle-Scarred']);
  check(!e2.canActivateMain(0, putST(e2, 0, 'Battle-Scarred').uid), 'needs an Archfiend');
}

section('Chain Ignition');
{
  const e = duel(['Chain Ignition', 'Luster Dragon'], ['Axe Raider', 'Rogue Doll', 'Feral Imp', 'Mystical Elf']);
  const ci = playTrap(e, 0, 'Chain Ignition');
  check(active(e, ci), 'activates and stays face-up');
  const axe = place(e, 1, 'Axe Raider');
  kill(e, [place(e, 1, FILL)], 1, 'yes', { pick: ['Axe Raider'] });
  check(zone(e, axe) === 'gy', "the opponent's effect destroyed their monster: destroy 1 card on the field");
  const doll = place(e, 1, 'Rogue Doll');
  check(kill(e, [place(e, 1, 'Feral Imp')], 1, 'yes') === 1 && zone(e, doll) === 'mz', 'once per turn');
  endTurn(e);
  check(kill(e, [place(e, 1, FILL)], 0, 'yes') === 1, 'destroyed by your own effect: nothing');
  kill(e, [place(e, 1, 'Mystical Elf')], 1, 'yes', { pick: ['Rogue Doll'] });
  check(zone(e, doll) === 'gy', 'it works again the next turn');
  kill(e, [ci]);
  endTurn(e);
  check(kill(e, [e.monsters(1)[0] ?? place(e, 1, FILL)], 1, 'yes') === 1, 'destroyed: no more effect');
}

section('Coffin Seller');
{
  const e = duel(['Coffin Seller'], ['Axe Raider', 'Rogue Doll', 'Feral Imp', 'Hinotama']);
  const cs = playTrap(e, 0, 'Coffin Seller');
  check(active(e, cs), 'activates and stays face-up');
  kill(e, [place(e, 1, 'Axe Raider')]);
  check(e.player(1).lp === 3700, "a monster sent to the opponent's GY: 300 damage");
  kill(e, [place(e, 1, 'Rogue Doll'), place(e, 1, FILL)]);
  check(e.player(1).lp === 3400, 'two at once: 300 once (each time = each event)');
  run(e, e.as(1, e.discard(1, grab(e, 1, 'Feral Imp').uid)));
  check(e.player(1).lp === 3100, 'a discarded monster counts too');
  run(e, e.as(1, e.discard(1, grab(e, 1, 'Hinotama').uid)));
  kill(e, [place(e, 0, FILL)]);
  check(e.player(1).lp === 3100 && e.player(0).lp === 4000, 'Spells, and monsters going to your own GY, do nothing');
  kill(e, [cs]);
  kill(e, [place(e, 1, FILL)]);
  check(e.player(1).lp === 3100, 'destroyed: no more damage');
}

section('Copy Knight');
{
  const e = duel(['Copy Knight', 'Luster Dragon', 'Masaki the Legendary Swordsman'], ['Axe Raider']);
  const ck = putST(e, 0, 'Copy Knight');
  check(summon(e, 0, 'Luster Dragon', true, { respond: 'Copy Knight' }) && !ck.faceUp, 'not for a non-Warrior');
  endTurn(e);
  check(summon(e, 1, 'Axe Raider', true, { respond: 'Copy Knight' }) && !ck.faceUp, "not for the opponent's Warrior");
  endTurn(e);
  summon(e, 0, 'Masaki the Legendary Swordsman', true, { respond: 'Copy Knight' }, 'yes');
  const m = e.fieldCard(ck.uid);
  check(zone(e, ck) === 'mz' && m!.faceUp && m!.pos === 'atk', 'your Level 4 Warrior is Normal Summoned: Copy Knight is Special Summoned as a monster and stays on the field');
  check(e.atkOf(m!) === 0 && e.defOf(m!) === 0 && e.raceOf(m!) === 'Warrior' && e.state.fx.declLevel?.[ck.uid] === 4 && e.state.fx.declAttr?.[ck.uid] === 'LIGHT', 'it is a Level 4 LIGHT Warrior with 0 ATK/DEF');
  kill(e, [m]);
  check(zone(e, ck) === 'gy', 'destroyed: it goes to the GY');
}

section("Dragon's Rage");
{
  const e = duel(["Dragon's Rage", 'Luster Dragon', 'Axe Raider', 'Feral Imp'], ['Rogue Doll', 'Luster Dragon', 'Giant Soldier of Stone']);
  const dr = playTrap(e, 0, "Dragon's Rage");
  check(active(e, dr), 'activates and stays face-up');
  const luster = place(e, 0, 'Luster Dragon')!;
  const axe = place(e, 0, 'Axe Raider')!;
  const imp = place(e, 0, 'Feral Imp', 'def')!;
  endTurn(e);
  const theirs = place(e, 1, 'Luster Dragon')!;
  toBattle(e);
  attack(e, theirs, imp);
  check(e.player(0).lp === 4000 && zone(e, imp) === 'gy', "the opponent's Dragons do not pierce");
  endTurn(e);
  const celtic = place(e, 1, FILL, 'def')!;
  const doll = place(e, 1, 'Rogue Doll', 'def')!;
  toBattle(e);
  attack(e, luster, celtic);
  check(e.player(1).lp === 4000 - 700, 'your Dragon attacking a Defense Position monster inflicts piercing damage');
  attack(e, axe, doll);
  check(e.player(1).lp === 3300, 'non-Dragons do not');
  kill(e, [dr]);
  endTurn(e);
  const soldier = place(e, 1, FILL, 'def')!;
  endTurn(e);
  toBattle(e);
  attack(e, luster, soldier);
  check(e.player(1).lp === 3300, 'destroyed: no more piercing');
}

section('Human-Wave Tactics');
{
  const e = duel(['Human-Wave Tactics', 'Basic Insect', 'Winged Cleaver', 'Petit Moth', 'Tomozaurus', 'Skull Servant', 'Fire Reaper'], ['Axe Raider', 'Luster Dragon']);
  const hw = playTrap(e, 0, 'Human-Wave Tactics');
  check(active(e, hw), 'activates and stays face-up');
  const bi = place(e, 0, 'Basic Insect')!;
  const wc = place(e, 0, 'Winged Cleaver')!;
  endTurn(e);
  const axe = place(e, 1, 'Axe Raider')!;
  const lus = place(e, 1, 'Luster Dragon')!;
  toBattle(e);
  attack(e, axe, bi);
  attack(e, lus, wc);
  check(zone(e, bi) === 'gy' && zone(e, wc) === 'gy', 'two Level 2 or lower Normal Monsters destroyed by battle');
  endTurn(e);
  const mine = e.monsters(0);
  check(mine.length === 2 && mine.every((m) => (DB.get(m.name)!.level ?? 9) <= 2 && DB.get(m.name)!.sub === 'Normal'), "End Phase (of the opponent's turn): 2 Level 2 or lower Normal Monsters are Special Summoned from the Deck");
  endTurn(e);
  check(e.monsters(0).length === 2, 'no battle losses this turn: nothing');
  kill(e, [hw]);
  toBattle(e);
  const before = e.monsters(0).length;
  attack(e, axe, e.monsters(0)[0]);
  endTurn(e);
  check(e.monsters(0).length === before - 1, 'destroyed: no more Summons');
}

section('Loop of Destruction');
{
  const e = duel(['Loop of Destruction', 'Luster Dragon'], ['Axe Raider', 'Rogue Doll', 'Feral Imp', 'Mystical Elf']);
  const loop = playTrap(e, 0, 'Loop of Destruction');
  check(active(e, loop), 'activates and stays face-up');
  const axe = place(e, 1, 'Axe Raider');
  kill(e, [place(e, 1, FILL)], 0, 'yes', { pick: ['Axe Raider'] });
  check(zone(e, axe) === 'gy' && e.player(0).lp === 3500 && e.player(1).lp === 3500, 'a monster destroyed by an effect: destroy 1 monster, each player takes 500');
  const doll = place(e, 1, 'Rogue Doll');
  check(kill(e, [place(e, 1, 'Feral Imp')], 1, 'yes') === 1 && zone(e, doll) === 'mz', 'once per turn');
  const luster = place(e, 0, 'Luster Dragon');
  endTurn(e);
  toBattle(e);
  check(attack(e, doll, luster, 'yes') === 1, 'battle destruction does not trigger it');
  kill(e, [place(e, 1, 'Mystical Elf')], 1, 'yes', { pick: ['Luster Dragon'] });
  check(zone(e, luster) === 'gy' && e.player(0).lp === 3000, 'it works again the next turn');
  kill(e, [loop]);
  check(kill(e, [place(e, 1, FILL)], 1, 'yes') === 1, 'destroyed: no more effect');
}

section('Machine King - 3000 B.C.');
{
  const e = duel(['Machine King - 3000 B.C.', 'Mechanicalchaser', 'Axe Raider'], ['Axe Raider']);
  const mk = playTrap(e, 0, 'Machine King - 3000 B.C.', 'yes');
  check(zone(e, mk) === 'mz' && mk!.faceUp && mk!.pos === 'atk', 'activated: Special Summoned as a monster, stays on the field');
  check(e.atkOf(mk!) === 1000 && e.raceOf(mk!) === 'Machine' && e.state.fx.declLevel?.[mk!.uid] === 4 && e.state.fx.declAttr?.[mk!.uid] === 'EARTH', 'a Level 4 EARTH Machine with 1000 ATK');
  const axe = grab(e, 0, 'Axe Raider');
  check(!e.canNormalSummon(0, axe, true) && place(e, 0, 'Mechanicalchaser') === null, 'you cannot Normal or Special Summon other monsters this turn');
  endTurn(e);
  check(summon(e, 1, 'Axe Raider') !== null, 'the opponent can');
  endTurn(e);
  check(e.canNormalSummon(0, axe, true), 'next turn you can Summon again');
  place(e, 0, 'Mechanicalchaser');
  effect(e, 0, mk);
  check(e.atkOf(mk!) === 2850 && !e.monsters(0).some((m) => m.name === 'Mechanicalchaser'), 'Tribute a Machine: gains its ATK');
  endTurn(e);
  check(e.atkOf(mk!) === 1000, '...until the end of the turn');
  kill(e, [mk]);
  check(zone(e, mk) === 'gy', 'destroyed: it goes to the GY');
}

section('Macro Cosmos');
{
  const e = duel(['Macro Cosmos', 'Helios - The Primordial Sun', 'Hinotama'], ['Axe Raider', 'Rogue Doll']);
  const mc = playTrap(e, 0, 'Macro Cosmos', 'yes');
  const helios = e.monsters(0).find((m) => m.name === 'Helios - The Primordial Sun');
  check(active(e, mc) && !!helios, 'activates, stays face-up, and Special Summons Helios from the Deck');
  const axe = place(e, 1, 'Axe Raider');
  kill(e, [axe]);
  check(zone(e, axe) === 'removed' && e.atkOf(helios!) === 100, 'a card that would go to the GY is banished instead');
  run(e, e.discard(0, grab(e, 0, 'Hinotama').uid));
  check(e.player(0).removed.some((c) => c.name === 'Hinotama'), 'any card (a discarded Spell too)');
  kill(e, [mc]);
  check(zone(e, mc) === 'gy', 'Macro Cosmos itself goes to the GY');
  const doll = place(e, 1, 'Rogue Doll');
  kill(e, [doll]);
  check(zone(e, doll) === 'gy', 'destroyed: cards go to the GY again');
}

section('Summon Gate');
{
  const fromExtra = (e: Engine) => {
    const c = e.player(0).fusion[0];
    run(e, e.specialSummon(c.uid, 0, 'atk'));
    return e.fieldCard(c.uid);
  };
  const e = duel(['Summon Gate'], [], Array(8).fill('Gaia the Dragon Champion'));
  const sg = playTrap(e, 0, 'Summon Gate');
  check(active(e, sg), 'activates and stays face-up');
  let ok = 0;
  for (let i = 0; i < 3; i++) {
    const m = fromExtra(e);
    if (m) ok++;
    kill(e, [m]);
  }
  check(ok === 3 && fromExtra(e) === null, 'at most 3 Special Summons from the Extra Deck per turn');
  endTurn(e);
  endTurn(e);
  kill(e, [fromExtra(e)]);
  check(e.player(0).gy.length === 4, 'a new turn: allowed again');
  kill(e, [sg]);
  kill(e, [fromExtra(e)]);
  kill(e, [fromExtra(e)]);
  check(fromExtra(e) !== null, 'destroyed: no limit');
}

section('Swamp Mirrorer');
{
  const e = duel(['Swamp Mirrorer', "Dragon's Rage"]);
  const sm = playTrap(e, 0, 'Swamp Mirrorer', { pick: ['Dragon'] }, { pick: ['DARK'] }, 'yes');
  check(zone(e, sm) === 'mz' && sm!.faceUp, 'activated: Special Summoned as a monster, stays on the field');
  check(e.atkOf(sm!) === 1800 && e.defOf(sm!) === 1000 && e.raceOf(sm!) === 'Dragon' && e.state.fx.declAttr?.[sm!.uid] === 'DARK' && e.state.fx.declLevel?.[sm!.uid] === 4, 'a Level 4 1800/1000 monster of the declared Type and Attribute');
  kill(e, [sm]);
  check(zone(e, sm) === 'gy', 'destroyed: it goes to the GY');
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
process.exit(fails ? 1 : 0);
