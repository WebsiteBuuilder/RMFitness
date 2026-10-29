// The online turn timer (src/eds/turnClock.ts): turn and answer allowances, the reserve bank,
// time held while the other player answers, and the moves played when the time runs out never stall a duel.
// Run: npx tsx tests/clock.test.ts
import { DB as KIT } from './speedkit';
import { DB } from '../src/eds/db';
import { DuelSession, type AnyAction } from '../src/eds/session';
import { MemoryAdapter } from '../src/sync/memory';
import type { DuelState, Pid } from '../src/eds/types';
import { CHAPTERS } from '../src/eds/speedCampaign/roster';
import { deckOf } from '../src/eds/speedCampaign/campaign';
import { aiAction } from '../src/eds/ai';
import { actor, BANK_MS, clockKey, clockText, expired, newClock, RESPOND_MS, show, tick, TURN_MS, type Clock } from '../src/eds/turnClock';

for (const [k, v] of KIT) DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) console.log(`FAIL: ${msg}`);
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
  if (!c) fails++;
};

const st = (turnPlayer: Pid, turn: number, prompt: Pid | null = null): DuelState =>
  ({ started: true, winner: null, turnPlayer, turn, prompt: prompt === null ? null : { kind: 'yesno', player: prompt, title: 'Respond?' } }) as unknown as DuelState;

// ---------- the clock ----------
{
  const turns = new Map<string, number>();
  let c: Clock = newClock();
  const t1 = st(0, 1);
  c = tick(c, t1, 5, 0, turns);
  ok(show(c, t1)?.who === 0 && show(c, t1)?.left === TURN_MS + BANK_MS, 'a turn starts with the turn time plus the whole bank');
  c = tick(c, t1, 5, 60_000, turns);
  ok(show(c, t1)?.left === TURN_MS - 60_000 + BANK_MS && !show(c, t1)?.bank, 'the turn time runs first');
  // the other player is asked something: their own answer time runs, the turn player's stops
  const r = st(0, 1, 1);
  c = tick(c, r, 6, 0, turns);
  ok(clockKey(r, 6).startsWith('r') && show(c, r)?.who === 1 && show(c, r)?.left === RESPOND_MS + BANK_MS, 'a question to the other player gets its own 30 s');
  c = tick(c, r, 6, 40_000, turns);
  ok(c.bank[1] === BANK_MS - 10_000 && show(c, r)?.bank === true, 'answering past 30 s takes from their bank');
  // back to the turn player: their turn time is where they left it
  c = tick(c, t1, 7, 0, turns);
  ok(show(c, t1)?.left === TURN_MS - 60_000 + BANK_MS, "the turn player's time picks up where it stopped");
  c = tick(c, t1, 7, TURN_MS - 60_000 + BANK_MS - 1, turns);
  ok(!expired(c, t1, 7) && show(c, t1)!.left === 1, 'one ms left: not out yet');
  c = tick(c, t1, 7, 5_000, turns);
  ok(expired(c, t1, 7) && c.bank[0] === 0, 'turn time and bank gone: out of time');
  c = { ...c, spent: 7 };
  ok(!expired(c, t1, 7), 'played for them once at this point of the duel');
  ok(expired(c, t1, 8), '...and again if they are still owing a move after it');
  // the next turn: the other player's fresh turn time, the bank stays spent
  const t2 = st(1, 2);
  c = tick(c, t2, 9, 0, turns);
  ok(show(c, t2)?.left === TURN_MS + c.bank[1] && c.bank[1] === BANK_MS - 10_000, 'each turn brings a fresh turn time; banks carry over the duel');
  const t3 = st(0, 3);
  c = tick(c, t3, 10, 0, turns);
  ok(show(c, t3)?.left === TURN_MS, 'an empty bank stays empty');
  ok(actor({ ...t3, winner: 0 } as DuelState) === null && show(c, { ...t3, winner: 0 } as DuelState) === null, 'a finished duel runs no clock');
  ok(clockText(65_000) === '1:05' && clockText(9_001) === '0:10' && clockText(-5) === '0:00', 'times show as m:ss, rounded up');
}

// ---------- a duel where every move is played by the timer never stalls ----------
{
  const ROAD = CHAPTERS.flatMap((ch) => ch.nodes.map((n) => ({ name: n.duelist.name, ...deckOf(n.duelist) })));
  for (const seed of [11, 12, 13]) {
    const s = new DuelSession(new MemoryAdapter());
    for (const p of [0, 1] as Pid[]) {
      const d = ROAD[p + seed];
      s.send({ type: 'JOIN', player: p, name: d.name, deck: d.main, fusion: d.extra, mode: 'speed', skill: d.skill } as AnyAction);
    }
    const [a, b] = s.seats;
    s.send({ type: 'START', first: 0, seed, names: [a.name, b.name], decks: [a.deck, b.deck], fusions: [a.fusion, b.fusion], mode: 'speed', skills: [a.skill ?? null, b.skill ?? null] });
    let stuck = 0;
    let steps = 0;
    while (s.state.winner === null && steps < 3000) {
      steps++;
      const who = actor(s.state)!;
      const before = s.log.length;
      // what TurnClock plays when the time runs out
      const st0 = s.engine.state;
      const print = (x: DuelState) => JSON.stringify([x.turn, x.phase, x.prompt, x.log.length, x.winner]);
      const was = print(st0);
      const act: AnyAction = st0.prompt?.player === who ? (aiAction(s.engine, who) ?? { type: 'PASS', player: who }) : { type: 'END_TURN', player: who };
      s.send(act);
      if (print(s.engine.state) === was && s.log.length > before) {
        stuck++;
        if (process.argv.includes('-v') && stuck < 4) console.log('  did nothing:', act.type, was.slice(0, 160));
      }
    }
    ok(s.state.winner !== null, `seed ${seed}: a duel played only by the timer ends (${s.state.winReason || 'no end'}, turn ${s.state.turn})`);
    ok(stuck < 5, `seed ${seed}: the moves played for a player always take (${stuck} did nothing)`);
  }
}

console.log(fails ? `${fails} FAILED` : 'clock: all checks passed');
if (fails) process.exit(1);
