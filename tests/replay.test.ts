// Duel replays (src/eds/replays.ts): a finished duel's moves play back to exactly the same duel,
// chat and rematch votes stay out, only finished Speed Duels are kept, and the list keeps the last 10.
// Run: npx tsx tests/replay.test.ts
import { DB as KIT } from './speedkit';
import { DB } from '../src/eds/db';
import { DuelSession, type AnyAction } from '../src/eds/session';
import { MemoryAdapter } from '../src/sync/memory';
import type { DuelState, Pid } from '../src/eds/types';
import { CHAPTERS } from '../src/eds/speedCampaign/roster';
import { deckOf } from '../src/eds/speedCampaign/campaign';
import { aiAction } from '../src/eds/ai';
import { deleteReplay, loadReplays, ReplayAdapter, replayOf, REPLAYS_MAX, saveReplay, startIndex } from '../src/eds/replays';

for (const [k, v] of KIT) DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) console.log(`FAIL: ${msg}`);
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
  if (!c) fails++;
};

// a phone's storage
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const ROAD = CHAPTERS.flatMap((ch) => ch.nodes.map((n) => ({ name: n.duelist.name, ...deckOf(n.duelist) })));
const print = (s: DuelState) => JSON.stringify([s.winner, s.winReason, s.turn, s.phase, s.players.map((p) => [p.lp, p.hand.map((c) => c.name), p.gy.map((c) => c.name), p.mz.map((m) => m?.name ?? null)]), s.log.length]);

function play(seed: number): DuelSession {
  const s = new DuelSession(new MemoryAdapter());
  for (const p of [0, 1] as Pid[]) {
    const d = ROAD[(p * 7 + seed) % ROAD.length];
    s.send({ type: 'JOIN', player: p, name: d.name, deck: d.main, fusion: d.extra, mode: 'speed', skill: d.skill, rarity: { [d.main[0]]: 2 } } as AnyAction);
  }
  s.send({ type: 'CHAT', player: 0, text: 'good luck' });
  const [a, b] = s.seats;
  s.send({ type: 'START', first: (seed % 2) as Pid, seed, names: [a.name, b.name], decks: [a.deck, b.deck], fusions: [a.fusion, b.fusion], mode: 'speed', skills: [a.skill ?? null, b.skill ?? null] });
  let n = 0;
  while (s.state.winner === null && n++ < 4000) {
    const st = s.state;
    const who = (st.prompt ? st.prompt.player : st.turnPlayer) as Pid;
    s.send(aiAction(s.engine, who) ?? (st.prompt ? { type: 'PASS', player: who } : { type: 'END_TURN', player: who }));
    if (n === 30) s.send({ type: 'CHAT', player: 1, text: 'nice' });
  }
  return s;
}

// ---------- the same duel again ----------
for (const seed of [101, 202, 303, 404]) {
  const live = play(seed);
  ok(live.state.winner !== null, `seed ${seed}: the duel ended (${live.state.winReason})`);
  const r = replayOf(live.log, live.state, 0, 'cpu', 1000)!;
  ok(!!r && r.moves.length > 10, `seed ${seed}: a replay is made (${r?.moves.length} moves)`);
  ok(!r.moves.some((m) => (m as { type: string }).type === 'CHAT'), `seed ${seed}: chat lines stay out of the replay`);
  ok(!r.moves.some((m) => 'seq' in m || 'ts' in m), `seed ${seed}: no log numbering kept`);
  ok(!r.moves.some((m) => 'stakes' in m || 'rarity' in m), `seed ${seed}: no seat's bets or finishes kept`);
  const a = new ReplayAdapter();
  const back = new DuelSession(a);
  a.push(r.moves.slice(0, startIndex(r) + 1));
  ok(back.state.started && back.state.turn === 1, `seed ${seed}: the replay opens on turn 1`);
  for (const m of r.moves.slice(startIndex(r) + 1)) a.push([m]);
  ok(print(back.state) === print(live.state), `seed ${seed}: played back move by move, it's the same duel to the end`);
  ok(r.winner === live.state.winner && r.turns === live.state.turn && r.names[0] === live.state.players[0].name, `seed ${seed}: the list shows the right result`);
  back.send({ type: 'END_TURN', player: 0 });
  ok(back.log.length === r.moves.length, `seed ${seed}: the board can't add moves to a replay`);
}

// ---------- what isn't kept ----------
{
  const s = play(55);
  const unfinished = { ...s.state, winner: null } as DuelState;
  ok(replayOf(s.log, unfinished, 0, 'online') === null, 'an unfinished duel makes no replay');
  ok(replayOf(s.log, { ...s.state, tag: {} } as unknown as DuelState, 0, 'online') === null, 'a Tag Duel makes no replay');
  ok(replayOf([...s.log, { type: 'RAID_START' }], s.state, 0, 'online') === null, 'a Boss Raid makes no replay');
  ok(replayOf(s.log, { ...s.state, rules: { ...s.state.rules, mode: 'eds' } } as DuelState, 0, 'cpu') === null, 'only Speed Duels are kept');
}

// ---------- the list ----------
{
  const s = play(77);
  for (let i = 0; i < REPLAYS_MAX + 3; i++) saveReplay('p1', replayOf(s.log, s.state, 0, 'online', 1000 + i)!);
  const list = loadReplays('p1');
  ok(list.length === REPLAYS_MAX, `the last ${REPLAYS_MAX} duels are kept`);
  ok(list[0].at === 1000 + REPLAYS_MAX + 2 && list[REPLAYS_MAX - 1].at === 1003, 'newest first, the oldest dropped');
  ok(loadReplays('p2').length === 0, "each duelist has their own replays");
  deleteReplay('p1', list[0].id);
  ok(loadReplays('p1').length === REPLAYS_MAX - 1 && loadReplays('p1')[0].id === list[1].id, 'a replay can be deleted');
  mem.set('eds.replays.p3', '{not json');
  ok(loadReplays('p3').length === 0, 'broken storage reads as no replays');
  const huge = { ...list[0], id: 'big', moves: Array.from({ length: 20000 }, () => ({ type: 'PASS', player: 0 })) } as typeof list[0];
  ok(!saveReplay('p1', huge) && !loadReplays('p1').some((r) => r.id === 'big'), 'a replay too big for the phone is skipped');
}

console.log(fails ? `${fails} FAILED` : 'replay: all checks passed');
if (fails) process.exit(1);
