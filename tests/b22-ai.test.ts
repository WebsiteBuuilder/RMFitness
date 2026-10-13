// The computer's judgement, the duel log, bets on the Road deck, quick surrenders, pacing.
// Run: npx tsx tests/b22-ai.test.ts
import { Engine } from '../src/eds/engine';
import { aiAction } from '../src/eds/ai';
import { DEFAULT_TACTICS, type Tactics } from '../src/eds/tactics';
import type { Action, Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB as KIT } from './speedkit';
import { DB } from '../src/eds/db';
import { evaluate, lookahead } from '../src/eds/aiEval';
import { campaignDifficulty, labyrinthDifficulty } from '../src/eds/difficulty';
import { copiesInDecks, rivalResult, spareCopies, tooQuick } from '../src/collection/economy';
import { newSpeedSave, type SpeedDeck, type SpeedSave } from '../src/eds/speedSave';
import { repairRoadDeck } from '../src/eds/speedCampaign/campaign';
import { BANNER_MS, cpuDelay, spotUid } from '../src/ui/cpuPace';
import { runBench } from './aibench';

for (const [k, v] of KIT) DB.set(k, v);

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};
const FILL = 'Celtic Guardian';

// ---------- duel kit (as in the batch tests) ----------
function settle(e: Engine) {
  for (let i = 0; i < 400 && e.state.prompt && e.state.winner === null; i++) {
    const pr = e.state.prompt;
    if (pr.kind === 'yesno') e.apply({ type: 'NO', player: pr.player });
    else if (pr.kind === 'response') e.apply({ type: 'PASS', player: pr.player });
    else e.apply({ type: 'CHOOSE', player: pr.player, picks: pr.options.map((_, j) => j).slice(0, Math.max(1, pr.min)) });
  }
}
function duel(d0: string[], d1: string[] = [], skills: [string | null, string | null] = [null, null]): Engine {
  const e = new Engine(DB);
  e.shuffle = <T,>(a: T[]) => a.slice();
  const pad = (d: string[]) => [...Array(4).fill(FILL), ...d, ...Array(Math.max(0, 30 - d.length)).fill(FILL)];
  e.apply({ type: 'START', first: 0, seed: 1, names: ['A', 'B'], decks: [pad(d0), pad(d1)], fusions: [[], []], mode: 'speed', skills });
  settle(e);
  return e;
}
/** Hands the turn to player 1 (the computer in these tests), in Main Phase 1 of turn 2. */
function toCpu(e: Engine) {
  e.apply({ type: 'END_TURN', player: 0 });
  settle(e);
}
const run = (e: Engine, step: Generator<any, any, any>) => {
  (e as any).run(step);
  settle(e);
};
function place(e: Engine, p: Pid, name: string, pos: Pos = 'atk', faceUp = true): FieldCard | null {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.gy, ...ps.fusion, ...ps.hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.specialSummon(c.uid, p, pos, faceUp));
  const f = e.fieldCard(c.uid);
  if (f && !faceUp) f.placedTurn = -1;
  if (f) f.placedTurn = -1;
  return f;
}
function grab(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.hand, ...ps.deck, ...ps.gy].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  if (e.find(c.uid)?.loc.zone !== 'hand') e.toHandOf(c.uid, p);
  return c;
}
/** Lets the computer (player `me`) play until it hands the turn over; returns its moves. */
function cpuTurn(e: Engine, me: Pid, t: Tactics = DEFAULT_TACTICS): Action[] {
  const turn = e.state.turn;
  const acts: Action[] = [];
  for (let i = 0; i < 200 && e.state.winner === null && e.state.turn === turn; i++) {
    const p = (e.state.prompt ? e.state.prompt.player : e.state.turnPlayer) as Pid;
    const a = p === me ? aiAction(e, me, t) : e.state.prompt?.kind === 'yesno' ? { type: 'NO' as const, player: p } : e.state.prompt ? aiAction(e, p) : null;
    if (!a) break;
    if (p === me) acts.push(a);
    e.apply(a);
  }
  return acts;
}
const logHas = (e: Engine, re: RegExp) => e.state.log.some((l) => re.test(l.text));

// ---------- 1. Skills: never a costly Skill for nothing ----------
{
  const e = duel([], [], [null, 'Last Gamble']);
  toCpu(e);
  e.state.turn = 5;
  check(e.canUseSkill(1), 'Last Gamble can be used on turn 5');
  const a = aiAction(e, 1);
  check(a?.type !== 'SKILL', 'the computer does not pay its LP down to 100 for Last Gamble at 4000 LP');
  e.player(1).lp = 700;
  e.state.turn = 7;
  check(aiAction(e, 1)?.type === 'SKILL', 'at 700 LP it takes the Last Gamble');
}
{
  const e = duel([], ['Celtic Guardian'], [null, 'Power Up!']);
  toCpu(e);
  e.state.turn = 6;
  place(e, 1, 'Celtic Guardian');
  e.player(1).normalSummoned = true;
  check(aiAction(e, 1)?.type !== 'SKILL', 'Power Up! is not wasted when there is nothing it would win');
  place(e, 0, 'Celtic Guardian');
  e.state.turn = 8;
  const a = aiAction(e, 1);
  check(a?.type === 'SKILL', 'Power Up! is used when +500 ATK wins a fight (1400 vs 1400)');
  if (a) e.apply(a);
  const pr = e.state.prompt;
  if (pr?.kind === 'select') {
    const pick = aiAction(e, 1);
    const chosen = pick?.type === 'CHOOSE' ? pr.options[pick.picks[0]] : null;
    check(chosen && e.controller(chosen.uid!) === 1, 'Power Up! goes on its own monster, not the opponent\'s');
  } else check(false, 'Power Up! asks for a monster');
}
{
  const e = duel([], [], [null, 'The Psychic Duelist']);
  toCpu(e);
  e.player(0).hand.length > 0;
  check(aiAction(e, 1)?.type !== 'SKILL', 'The Psychic Duelist (half your LP for a peek) is never used');
}

// ---------- 2. Equip Cards: boosts on its own monsters ----------
{
  const e = duel(['Blue-Eyes White Dragon'], ['Sword of Deep-Seated', 'Toon Alligator']);
  toCpu(e);
  place(e, 0, 'Blue-Eyes White Dragon');
  const sword = grab(e, 1, 'Sword of Deep-Seated');
  e.player(1).normalSummoned = true;
  e.player(1).hand = e.player(1).hand.filter((c) => c.uid === sword.uid || e.info(c.name).kind !== 'monster');
  const acts = cpuTurn(e, 1);
  check(!acts.some((a) => a.type === 'ACTIVATE' && a.uid === sword.uid), 'with no monster of its own, it does not activate Sword of Deep-Seated (it would go on Blue-Eyes)');
  const bewd = e.monsters(0)[0];
  check(bewd && e.atkOf(bewd) === 3000, "the player's Blue-Eyes is not boosted");
}
{
  const e = duel(['Blue-Eyes White Dragon'], ['Sword of Deep-Seated', 'Toon Alligator']);
  toCpu(e);
  place(e, 0, 'Blue-Eyes White Dragon');
  const mine = place(e, 1, 'Toon Alligator');
  const sword = grab(e, 1, 'Sword of Deep-Seated');
  e.player(1).normalSummoned = true;
  e.apply({ type: 'ACTIVATE', player: 1, uid: sword.uid, zone: 0 });
  const pr = e.state.prompt;
  const a = aiAction(e, 1);
  const chosen = pr?.kind === 'select' && a?.type === 'CHOOSE' ? pr.options[a.picks[0]] : null;
  check(chosen?.uid === mine?.uid, 'Sword of Deep-Seated is equipped to its own monster, not Blue-Eyes');
}

{
  // A Warrior-only boost with only the opponent's Warrior to take it: back out of the activation.
  const e = duel(['Amazoness Chain Master'], ['Legendary Sword', 'Spirit of the Pharaoh']);
  toCpu(e);
  place(e, 0, 'Amazoness Chain Master');
  place(e, 1, 'Spirit of the Pharaoh');
  grab(e, 1, 'Legendary Sword');
  e.player(1).normalSummoned = true;
  cpuTurn(e, 1);
  check(!logHas(e, /Legendary Sword equipped to Amazoness Chain Master/), "Legendary Sword is not put on the opponent's Warrior");
}

// ---------- 3. Costs: no Tributing its best monster for a little burn ----------
{
  const e = duel([], ["Gravekeeper's Cannonholder", "Gravekeeper's Oracle"]);
  toCpu(e);
  place(e, 1, "Gravekeeper's Cannonholder");
  place(e, 1, "Gravekeeper's Oracle");
  e.player(1).normalSummoned = true;
  const can = e.monsters(1).find((m) => m.name === "Gravekeeper's Cannonholder")!;
  check(e.canUseMonsterEffect(1, can), "Gravekeeper's Cannonholder's effect can be used (it would Tribute the Oracle)");
  const acts = cpuTurn(e, 1);
  check(!acts.some((a) => a.type === 'MONSTER_EFFECT' && a.uid === can.uid), "it does not Tribute its 2000 ATK Oracle for 700 damage");
  check(e.monsters(1).some((m) => m.name === "Gravekeeper's Oracle") || e.player(0).lp <= 0, 'the Oracle is still on the field');
}
{
  const e = duel([], ["Gravekeeper's Cannonholder", "Gravekeeper's Oracle"]);
  toCpu(e);
  place(e, 1, "Gravekeeper's Cannonholder");
  place(e, 1, "Gravekeeper's Oracle");
  for (const m of e.monsters(1)) m.pos = 'def';
  e.player(1).normalSummoned = true;
  e.player(0).lp = 700;
  const can = e.monsters(1).find((m) => m.name === "Gravekeeper's Cannonholder")!;
  const d = lookahead(e, 1, { type: 'MONSTER_EFFECT', player: 1, uid: can.uid }, (x, p) => aiAction(x, p));
  check(d !== null && d > 1000, 'with the opponent at 700 LP the lookahead sees the win');
  cpuTurn(e, 1);
  check(e.state.winner === 1, 'and the computer takes it (lethal burn is worth the Tribute)');
}

// ---------- 4. Lethal and board sense ----------
{
  const e = duel(['Dark Magician'], ['Blue-Eyes White Dragon', 'Celtic Guardian', 'Summoned Skull']);
  toCpu(e);
  place(e, 0, 'Dark Magician');
  place(e, 1, 'Blue-Eyes White Dragon');
  place(e, 1, 'Celtic Guardian');
  e.player(1).normalSummoned = true;
  e.player(0).lp = 2400;
  // Blue-Eyes clears Dark Magician (500) and Celtic Guardian attacks directly (1400): 1900 < 2400; no lethal...
  const before = evaluate(e, 1);
  check(Number.isFinite(before), 'positions get a score');
  e.player(0).lp = 1800;
  cpuTurn(e, 1);
  check(e.state.winner === 1, 'clear the blocker with Blue-Eyes, then Celtic Guardian attacks directly: lethal taken');
}
{
  const e = duel(['Blue-Eyes White Dragon'], ['Celtic Guardian']);
  toCpu(e);
  place(e, 0, 'Blue-Eyes White Dragon');
  place(e, 1, 'Celtic Guardian');
  e.player(1).normalSummoned = true;
  const acts = cpuTurn(e, 1);
  check(!acts.some((a) => a.type === 'ATTACK'), 'no suicidal attack into a bigger monster');
}

// ---------- 5. The duel log names what moved each card ----------
{
  const e = duel(['Celtic Guardian'], ['Blue-Eyes White Dragon', 'Burst Stream of Destruction']);
  toCpu(e);
  place(e, 0, 'Celtic Guardian');
  place(e, 1, 'Blue-Eyes White Dragon');
  const bs = grab(e, 1, 'Burst Stream of Destruction');
  e.apply({ type: 'ACTIVATE', player: 1, uid: bs.uid, zone: 0 });
  settle(e);
  check(logHas(e, /^Celtic Guardian was destroyed by Burst Stream of Destruction$/), 'Burst Stream: "Celtic Guardian was destroyed by Burst Stream of Destruction"');
}
{
  const e = duel(['Celtic Guardian'], ['Dark Magician', 'Thousand Knives']);
  toCpu(e);
  place(e, 0, 'Celtic Guardian');
  place(e, 1, 'Dark Magician');
  const tk = grab(e, 1, 'Thousand Knives');
  e.apply({ type: 'ACTIVATE', player: 1, uid: tk.uid, zone: 0 });
  settle(e);
  check(logHas(e, /^Celtic Guardian was destroyed by Thousand Knives$/), 'Thousand Knives logs the destruction');
}
{
  const e = duel(['Swords of Revealing Light'], ['Blue-Eyes White Dragon', 'Stamping Destruction']);
  const sw = grab(e, 0, 'Swords of Revealing Light');
  e.apply({ type: 'SET_ST', player: 0, uid: sw.uid, zone: 0 });
  toCpu(e);
  place(e, 1, 'Blue-Eyes White Dragon');
  const sd = grab(e, 1, 'Stamping Destruction');
  e.apply({ type: 'ACTIVATE', player: 1, uid: sd.uid, zone: 0 });
  settle(e);
  check(logHas(e, /^Swords of Revealing Light was destroyed by Stamping Destruction$/), 'Stamping Destruction logs the Set card it destroyed');
}
{
  const e = duel(['Reversible Beetle'], ['Celtic Guardian']);
  const rb = place(e, 0, 'Reversible Beetle', 'def', false)!;
  const zi = e.find(rb.uid)!.loc.index;
  toCpu(e);
  // The opponent's monster in the same column.
  const cg = e.player(1).deck.find((c) => c.name === 'Celtic Guardian')!;
  const card = (e as any).detach(cg.uid);
  e.player(1).mz[zi] = { ...card, pos: 'atk', faceUp: true, placedTurn: -1, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
  e.apply({ type: 'END_TURN', player: 1 });
  settle(e);
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: rb.uid });
  settle(e);
  check(e.find(cg.uid)?.loc.zone === 'deck', 'Reversible Beetle shuffles the monster in its column into the Deck');
  check(logHas(e, /^Celtic Guardian was returned to the Deck by Reversible Beetle$/), 'and the log says so');
}
{
  const e = duel(['Blue-Eyes White Dragon'], ['Celtic Guardian']);
  toCpu(e);
  place(e, 0, 'Blue-Eyes White Dragon');
  const n = e.state.log.length;
  const cg = place(e, 1, 'Celtic Guardian')!;
  e.apply({ type: 'END_TURN', player: 1 });
  settle(e);
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  settle(e);
  e.apply({ type: 'ATTACK', player: 0, uid: e.monsters(0)[0].uid, target: cg.uid });
  settle(e);
  const lines = e.state.log.slice(n).map((l) => l.text);
  check(lines.includes('Blue-Eyes White Dragon destroys Celtic Guardian') && !lines.some((l) => /Celtic Guardian was destroyed/.test(l)), 'battle keeps its own single line');
}

// ---------- 6. The Road deck counts for bets and shards ----------
{
  const six = ['Celtic Guardian', 'Kuriboh', 'Mystical Elf', 'Feral Imp', 'Giant Soldier of Stone', 'Beta The Magnet Warrior'];
  const road: SpeedDeck = { id: 'r', name: 'Road', main: ['Dark Magician', 'Dark Magician', ...six.flatMap((n) => [n, n, n])], extra: [], skill: null };
  const owned3 = Object.fromEntries(six.map((n) => [n, 3]));
  const s: SpeedSave = { ...newSpeedSave(), collection: { 'Dark Magician': 2, ...owned3 }, road };
  check(copiesInDecks(s, 'Dark Magician') === 2 && spareCopies(s, 'Dark Magician') === 0, 'Dark Magician in the Road deck is not spare (no bet, no shards)');
  check(spareCopies({ ...s, road: null }, 'Dark Magician') === 2, 'without the Road deck both copies would have counted as spare');
  // A save broken before the fix: the Road deck uses a copy that was lost in a bet.
  const broken: SpeedSave = { ...s, collection: { 'Dark Magician': 1, ...owned3, 'Alpha The Magnet Warrior': 1 } };
  const fixed = repairRoadDeck(broken, road);
  check(fixed && fixed.removed.join() === 'Dark Magician', 'repairRoadDeck takes out the copy no longer owned');
  check(fixed && fixed.deck.main.length >= 20 && fixed.deck.main.filter((n) => n === 'Dark Magician').length === 1, 'and refills the Main Deck to 20 from owned cards');
  check(repairRoadDeck(s, road) === null, 'a healthy Road deck is left alone');
}

// ---------- 7. A turn-1 surrender moves no crown ----------
{
  const s = newSpeedSave();
  const quick = rivalResult(s, { result: 'w', opp: 'Bro', turns: 1, counts: true, surrender: true, damage: 0 });
  check(!quick.save.rivals?.Bro && tooQuick({ surrender: true, turns: 1, damage: 0 }), 'a surrender on turn 1 does not count for the King of Games record');
  const real = rivalResult(s, { result: 'w', opp: 'Bro', turns: 1, counts: true, surrender: true, damage: 1500 });
  check(real.save.rivals?.Bro?.w === 1, 'after damage was dealt it counts');
  const later = rivalResult(s, { result: 'w', opp: 'Bro', turns: 4, counts: true, surrender: true, damage: 0 });
  check(later.save.rivals?.Bro?.w === 1, 'after a full turn each it counts');
}

// ---------- 8. Pacing ----------
{
  const summon: Action = { type: 'SUMMON', player: 1, uid: 5, zone: 0, pos: 'atk', faceUp: true };
  check(cpuDelay(summon, { sinceTurn: 0, firstTurn: false, ownTurn: true, animSpeed: 1 }) >= BANNER_MS, 'the first move waits for the turn banner to finish');
  const mid = cpuDelay(summon, { sinceTurn: 5000, firstTurn: false, ownTurn: true, animSpeed: 1 });
  check(mid >= 700 && mid <= 1100, `each visible move gets a 0.7-1.1s beat (${mid}ms)`);
  check(cpuDelay(summon, { sinceTurn: 5000, firstTurn: false, ownTurn: true, animSpeed: 2 }) < mid, 'a faster Animation speed shortens it');
  check(cpuDelay({ type: 'NEXT_PHASE', player: 1 }, { sinceTurn: 5000, firstTurn: false, ownTurn: true, animSpeed: 1 }) < mid, 'phase steps are quicker');
  check(spotUid(summon) === 5 && spotUid({ type: 'NEXT_PHASE', player: 1 }) === null, 'Summons get a spotlight, phase steps do not');
}

// ---------- 9. Difficulty ----------
check(campaignDifficulty(1) === 'easy' && campaignDifficulty(2, true) === 'normal' && campaignDifficulty(4) === 'normal' && campaignDifficulty(7) === 'hard', 'the Road climbs Easy -> Normal -> Hard');
check(labyrinthDifficulty(0) === 'easy' && labyrinthDifficulty(1) === 'normal' && labyrinthDifficulty(2) === 'hard', 'the Labyrinth floors climb too');

// ---------- 10. Computer vs computer: no self-harm, every duel ends ----------
{
  const st = runBench(1, 'normal', 2, false);
  check(st.unfinished === 0, `${st.duels} duels all finished`);
  check(st.skillSelfHarm + st.equipOnFoe + st.costForBurn === 0, `no self-harming plays (skill ${st.skillSelfHarm}, equip ${st.equipOnFoe}, cost-for-burn ${st.costForBurn})`);
  check(st.suicideAttacks === 0, 'no attacks into bigger face-up monsters');
}

console.log(fails ? `${fails} FAILURES` : 'ALL OK');
process.exit(fails ? 1 : 0);
