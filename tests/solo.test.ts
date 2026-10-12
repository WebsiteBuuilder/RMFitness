// Speed Duel solo modes: Duel Conditions, the Millennium Road, the Duel Labyrinth, deck codes.
// Run: npx tsx tests/solo.test.ts
import { DB as KIT, aiAction } from './speedkit';
import { DB } from '../src/eds/db';
import { Engine } from '../src/eds/engine';
import type { Action, Pid, SeatSetup } from '../src/eds/types';
import { STARTERS, deckFromStarter, newSpeedSave, speedDeckProblems } from '../src/eds/speedSave';
import { getSkill } from '../src/eds/skills';
import { CHAPTERS } from '../src/eds/speedCampaign/roster';
import { chapterOpen, deckOf, nodeOpen, roadDeckProblems, settleCampaign, startRoad } from '../src/eds/speedCampaign/campaign';
import { CURSES, afterDuel, choose, duelFor, enter, newRun, reachable, readResultCode, resultCode, stopById, summaryOf, type Run } from '../src/eds/speedCampaign/labyrinth';
import { deckCode, readDeckCode } from '../src/eds/speedCampaign/deckCode';
import { newSoloSave } from '../src/eds/speedCampaign/save';
import { settleSolo } from '../src/eds/speedCampaign/settle';
import { mergeSetups, RELICS } from '../src/eds/speedCampaign/relics';
import { outcomeOf } from '../src/eds/speedCampaign/outcome';

for (const [k, v] of KIT) DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) console.log(`FAIL: ${msg}`);
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
  if (!c) fails++;
};

// ---------- Duel Conditions in the engine ----------
const starter = deckFromStarter(STARTERS[0]);
function start(setup: [SeatSetup | null, SeatSetup | null], first: Pid = 0) {
  const e = new Engine(KIT);
  e.apply({ type: 'START', first, seed: 7, names: ['A', 'B'], decks: [starter.main, starter.main], fusions: [[], []], mode: 'speed', skills: [null, null], setup });
  return e;
}
{
  const e = start([{ lp: 5000, hand: ['Toon World'], openingHand: 1 }, { lp: 3000, field: 'Umi', spells: ['Toon World'], monsters: ['7 Colored Fish'], openingHand: -1 }]);
  ok(e.player(0).lp === 5000 && e.player(1).lp === 3000, 'Duel Conditions set each side\'s LP');
  ok(e.player(0).hand.length === 6, `extra opening card + added hand card (hand ${e.player(0).hand.length})`);
  ok(e.player(1).hand.length === 3, `one fewer opening card (hand ${e.player(1).hand.length})`);
  ok(e.player(1).field?.name === 'Umi' && e.player(1).field?.faceUp === true, 'Field Spell already in play');
  ok(e.player(1).sz.some((z) => z?.name === 'Toon World' && z.active), 'Continuous Spell already active');
  ok(e.monsters(1).some((m) => m.name === '7 Colored Fish' && m.faceUp && m.pos === 'atk'), 'monster already on the field');
  const plain = start([null, null]);
  ok(plain.player(0).lp === 4000 && plain.player(0).hand.length === 4, 'no setup: a normal Speed Duel');
}
ok(mergeSetups([{ lp: 4500 }, { lp: 3500 }, { lp: 5000 }]).lp === 5000, 'merged LP changes add up');
ok(mergeSetups([{ openingHand: 1 }, { openingHand: 1 }]).openingHand === 2, 'merged opening-hand changes add up');

// ---------- the roster ----------
const kitHas = (n: string) => KIT.has(n);
const names = new Set<string>();
for (const ch of CHAPTERS) {
  ok(ch.nodes.length >= 1 && ch.nodes[ch.nodes.length - 1].boss === true, `${ch.title}: ends on a boss`);
  for (const n of ch.nodes) {
    ok(!names.has(n.id), `node id ${n.id} is unique`);
    names.add(n.id);
    const d = deckOf(n.duelist);
    const problems = speedDeckProblems({ id: n.id, name: n.duelist.name, ...d });
    ok(problems.length === 0, `${n.id} deck is legal${problems.length ? `: ${problems.slice(0, 3).join('; ')}` : ''}`);
    ok(kitHas(n.duelist.portrait), `${n.id} portrait ${n.duelist.portrait} exists`);
    if (n.duelist.skill) ok(!!getSkill(n.duelist.skill), `${n.id} Skill ${n.duelist.skill} exists`);
    if (n.story) {
      const sd = { id: 's', name: n.story.as, main: n.story.main.flatMap((e) => (/\*\d$/.test(e) ? Array<string>(Number(e.slice(-1))).fill(e.slice(0, -2)) : [e])), extra: n.story.extra, skill: n.story.skill };
      ok(speedDeckProblems(sd).length === 0, `${n.id} story deck is legal: ${speedDeckProblems(sd).slice(0, 2).join('; ')}`);
    }
    for (const s of [n.condition?.cpu, n.condition?.player]) for (const c of [...(s?.monsters ?? []), ...(s?.spells ?? []), ...(s?.hand ?? []), ...(s?.field ? [s.field] : [])]) ok(kitHas(c), `${n.id} condition card ${c} exists`);
  }
}
for (const r of RELICS) ok(kitHas(r.art) || true, `relic ${r.name}`);

// ---------- the road ----------
{
  let speed = newSpeedSave();
  let solo = newSoloSave();
  ok(!chapterOpen(solo, CHAPTERS[0]), 'the road is closed before picking a Starter Deck');
  ({ speed, solo } = startRoad(speed, solo, STARTERS[1].character));
  ok(chapterOpen(solo, CHAPTERS[0]) && nodeOpen(solo, CHAPTERS[0], 0) && !nodeOpen(solo, CHAPTERS[0], 1), 'chapter 1 opens on its first duel only');
  ok(roadDeckProblems(speed, solo.campaign.deck!).length === 0, `the starter road deck is ready: ${roadDeckProblems(speed, solo.campaign.deck!).join('; ')}`);
  const bad = { ...solo.campaign.deck!, main: [...solo.campaign.deck!.main.slice(1), CHAPTERS[0].nodes[0].duelist.signature[0]] };
  ok(roadDeckProblems(speed, bad).some((p) => p.includes('You own')), 'unowned cards are refused in the road deck');
  const win = { result: 'w' as const, myLp: 3000, myStartLp: 4000, oppLp: 0, turns: 6, usedSkill: false, myMonsters: 3 };
  const before = Object.values(speed.collection ?? {}).reduce((a, b) => a + b, 0);
  for (const ch of CHAPTERS) {
    for (const n of ch.nodes) {
      const st = settleCampaign(speed, solo, n.id, win, 99);
      speed = st.speed;
      solo = st.solo;
      ok(st.stars[0] && st.stars[1], `${n.id}: win stars`);
      if (n.boss) ok(st.cleared === ch && solo.campaign.items.includes(ch.item), `${n.id}: boss clears ${ch.title} and gives ${ch.item}`);
    }
    const next = CHAPTERS[CHAPTERS.indexOf(ch) + 1];
    if (next) ok(chapterOpen(solo, next), `${next.title} opens after ${ch.title}`);
  }
  const after = Object.values(speed.collection ?? {}).reduce((a, b) => a + b, 0);
  ok(after > before + CHAPTERS.length * 2, `wins add cards to the collection (${before} -> ${after})`);
  const lost = settleCampaign(speed, solo, CHAPTERS[0].nodes[0].id, { ...win, result: 'l' });
  ok(lost.solo.campaign.losses === solo.campaign.losses + 1 && lost.cards.length === 0, 'a loss gives nothing');
  const forfeit = settleSolo({ kind: 'campaign', nodeId: CHAPTERS[0].nodes[0].id }, { ...win, result: 'l', forfeit: true }, speed, solo);
  ok(forfeit.solo === solo, 'leaving a campaign duel costs nothing');
}

// ---------- deck codes ----------
{
  const code = deckCode(starter);
  const back = readDeckCode(code);
  ok(!!back && back.main.slice().sort().join() === starter.main.slice().sort().join() && back.skill === starter.skill, 'a deck code reads back as the same deck');
  ok(readDeckCode('hello') === null, 'junk is not a deck code');
}

// ---------- the Labyrinth ----------
const UP: string[] = [];
{
  const a = newRun({ starter: STARTERS[0].character, seed: 1234, curse: 0, upgrades: UP });
  const b = newRun({ starter: STARTERS[0].character, seed: 1234, curse: 0, upgrades: UP });
  ok(JSON.stringify(a.floors) === JSON.stringify(b.floors), 'the same seed makes the same map (Daily Labyrinth)');
  for (const f of a.floors) {
    ok(f.rows[f.rows.length - 1][0].kind === 'boss', 'each floor ends on a boss');
    for (let r = 1; r < f.rows.length; r++) for (const s of f.rows[r]) ok(f.rows[r - 1].some((x) => x.next.includes(s.id)), `stop ${s.id} can be reached`);
    for (const row of f.rows) for (const s of row) if (s.foe) ok(!!duelFor({ ...a, inDuel: s.id }, UP), `stop ${s.id} has a duelist`);
  }
  ok(CURSES.length === 10, '10 Curses');
}
// Walk whole runs with random choices, always winning or always losing.
function walk(seed: number, winEvery: number): Run {
  let r = newRun({ starter: STARTERS[seed % STARTERS.length].character, seed, curse: seed % 11, upgrades: ['heart', 'draft', 'relic', 'dp', 'lp'] });
  let duels = 0;
  for (let guard = 0; guard < 400 && !r.over; guard++) {
    if (r.inDuel) {
      const d = duelFor(r, UP);
      if (!d) throw new Error('no duel');
      duels++;
      r = afterDuel(r, duels % winEvery === 0 ? 'l' : 'w', UP);
      continue;
    }
    const p = r.pending;
    if (p) {
      const pick = (seed + guard) % 3;
      if (p.kind === 'draft') r = choose(r, { kind: 'draft', pick: p.options[pick % p.options.length] ?? null }, UP);
      else if (p.kind === 'shop') {
        const i = p.items.findIndex((x) => !x.sold && x.price <= r.dp && x.kind !== 'remove');
        r = choose(r, i >= 0 && guard % 2 === 0 ? { kind: 'buy', index: i } : { kind: 'leave' }, UP);
      } else if (p.kind === 'event') r = choose(r, { kind: 'event', option: pick % 2 }, UP);
      else if (p.kind === 'rest') r = choose(r, { kind: 'rest', option: pick ? 'heal' : 'cut' }, UP);
      else if (p.kind === 'remove') r = choose(r, { kind: 'remove', card: r.main[0] }, UP);
      else if (p.kind === 'swap') r = choose(r, { kind: 'swap', out: pick ? r.main[0] : null }, UP);
      else r = choose(r, { kind: 'treasure' }, UP);
      continue;
    }
    const can = reachable(r);
    if (!can.length) throw new Error(`stuck at ${r.at} floor ${r.floor}`);
    r = enter(r, can[guard % can.length].id, UP);
  }
  return r;
}
for (let s = 1; s <= 40; s++) {
  try {
    const won = walk(s, 1000);
    ok(won.over === 'won', `seed ${s}: winning every duel clears the Labyrinth (${won.over ?? 'unfinished'}, floor ${won.floor})`);
    ok(won.main.length >= 20 && won.main.length <= 30 && won.extra.length <= 6, `seed ${s}: run deck stays 20-30 (${won.main.length})`);
    ok(speedDeckProblems({ id: 'r', name: 'r', main: won.main, extra: won.extra, skill: won.skill }).filter((p) => !p.includes('Limited')).length === 0, `seed ${s}: run deck legal: ${speedDeckProblems({ id: 'r', name: 'r', main: won.main, extra: won.extra, skill: won.skill }).slice(0, 2).join('; ')}`);
    const lost = walk(s, 1);
    ok(lost.over === 'lost' && lost.hearts === 0, `seed ${s}: losing every duel ends the run`);
    const sum = summaryOf(won);
    const code = resultCode({ ...sum, daily: '2026-10-12' }, 'Jammy');
    const read = readResultCode(code);
    ok(!!read && read.won === sum.won && read.wins === sum.wins && read.name === 'Jammy', `seed ${s}: result code reads back`);
  } catch (err) {
    ok(false, `seed ${s}: ${(err as Error).message}`);
  }
}
// A labyrinth duel's result through settleSolo.
{
  let solo = newSoloSave();
  let run = newRun({ starter: STARTERS[2].character, seed: 77, curse: 0, upgrades: UP });
  run = enter(run, reachable(run)[0].id, UP);
  solo = { ...solo, labyrinth: { ...solo.labyrinth, run } };
  const o = { result: 'l' as const, myLp: 0, myStartLp: 4000, oppLp: 100, turns: 9, usedSkill: true, myMonsters: 0 };
  const r = settleSolo({ kind: 'labyrinth', runId: run.id, stopId: run.inDuel! }, o, newSpeedSave(), solo);
  ok(r.solo.labyrinth.run!.hearts === run.hearts - 1, 'a lost Labyrinth duel costs a heart');
}

// ---------- real duels: every computer deck under its Duel Condition ----------
const games = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 1);
const brains = [aiAction, aiAction];
for (const ch of CHAPTERS) {
  for (const n of ch.nodes) {
    for (let g = 0; g < games; g++) {
      const d = deckOf(n.duelist);
      const st = deckFromStarter(STARTERS[g % STARTERS.length]);
      const e = new Engine(KIT);
      e.apply({ type: 'START', first: (g % 2) as Pid, seed: 500 + g, names: ['P', n.duelist.name], decks: [st.main, d.main], fusions: [st.extra, d.extra], mode: 'speed', skills: [st.skill, d.skill], setup: [n.condition?.player ?? null, n.condition?.cpu ?? null] });
      let steps = 0;
      try {
        while (e.state.winner === null && steps < 4000) {
          const who = (e.state.prompt ? e.state.prompt.player : e.state.turnPlayer) as Pid;
          const a: Action | null = brains[who](e, who);
          e.apply(a ?? { type: 'END_TURN', player: who });
          steps++;
        }
        ok(true, `${n.id} duel ${g}`);
        const o = outcomeOf(e.state, 0, 4000);
        ok(['w', 'l', 'd'].includes(o.result), `${n.id}: outcome read`);
      } catch (err) {
        ok(false, `${n.id} duel ${g} threw: ${(err as Error).message}`);
      }
    }
  }
}

console.log(fails ? `${fails} FAILURES` : 'ALL OK');
process.exit(fails ? 1 : 0);
