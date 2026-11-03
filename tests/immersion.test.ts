// Heart of the Cards draw (src/ui/heartRules.ts) and the face-off / draw holds (src/ui/immersionState.ts):
// which draw waits for your swipe, when it's a destiny draw, and that the shared holds clear.
// Run: npx tsx tests/immersion.test.ts
import { DB as KIT } from './speedkit';
import { DB } from '../src/eds/db';
import { DuelSession, type AnyAction } from '../src/eds/session';
import { MemoryAdapter } from '../src/sync/memory';
import type { DuelState, Pid } from '../src/eds/types';
import { CHAPTERS } from '../src/eds/speedCampaign/roster';
import { deckOf } from '../src/eds/speedCampaign/campaign';
import { aiAction } from '../src/eds/ai';
import { DESTINY_GAP, freshDraw, isDestiny, topSeq } from '../src/ui/heartRules';
import { drawHeld, introLeft, setDrawHeld, setIntroFor } from '../src/ui/immersionState';

for (const [k, v] of KIT) DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) console.log(`FAIL: ${msg}`);
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
  if (!c) fails++;
};

// ---------- destiny draws ----------
{
  const lp = (a: number, b: number) => ({ players: [{ lp: a }, { lp: b }] }) as unknown as DuelState;
  ok(!isDestiny(lp(4000, 4000), 0), 'level on Life Points: a normal draw');
  ok(!isDestiny(lp(2500, 4000), 0), '1500 behind: a normal draw');
  ok(isDestiny(lp(4000 - DESTINY_GAP, 4000), 0), `${DESTINY_GAP} behind: a destiny draw`);
  ok(isDestiny(lp(900, 1500), 0), '1000 or less and behind: a destiny draw');
  ok(!isDestiny(lp(900, 900), 0) && !isDestiny(lp(800, 300), 0), 'low but not behind: a normal draw');
  ok(isDestiny(lp(4000, 1000), 1) && !isDestiny(lp(4000, 1000), 0), 'seen from each seat');
}

// ---------- which draw waits: real Speed Duels ----------
{
  const ROAD = CHAPTERS.flatMap((ch) => ch.nodes.map((n) => ({ name: n.duelist.name, ...deckOf(n.duelist) })));
  let checked = 0;
  for (const seed of [3, 4, 5]) {
    const s = new DuelSession(new MemoryAdapter());
    for (const p of [0, 1] as Pid[]) {
      const d = ROAD[p + seed];
      s.send({ type: 'JOIN', player: p, name: d.name, deck: d.main, fusion: d.extra, mode: 'speed', skill: d.skill } as AnyAction);
    }
    const [a, b] = s.seats;
    s.send({ type: 'START', first: 0, seed, names: [a.name, b.name], decks: [a.deck, b.deck], fusions: [a.fusion, b.fusion], mode: 'speed', skills: [a.skill ?? null, b.skill ?? null] });
    const st = () => s.engine.state;
    ok(freshDraw(st(), 0, 0) === null && freshDraw(st(), 1, 0) === null, `seed ${seed}: the opening hands and the first turn draw nothing to swipe`);
    let seen = topSeq(st());
    let turn = st().turn;
    for (let i = 0; i < 600 && st().winner === null && st().turn < 7; i++) {
      const p = (st().prompt?.player ?? st().turnPlayer) as Pid;
      const act = aiAction(s.engine, p);
      if (!act) break;
      s.send(act);
      if (st().turn !== turn) {
        turn = st().turn;
        const tp = st().turnPlayer as Pid;
        const d = freshDraw(st(), tp, seen);
        // the turn player's Draw Phase card: in their hand, from a normal draw event
        if (st().winner === null && st().players[tp].deck.length > 0) {
          ok(!!d && st().players[tp].hand.some((c) => c.uid === d.uid), `seed ${seed} turn ${turn}: the Draw Phase card is found in the hand`);
          ok(freshDraw(st(), (tp === 0 ? 1 : 0) as Pid, seen) === null, `seed ${seed} turn ${turn}: nothing waits for the other duelist`);
          if (d) ok(freshDraw(st(), tp, d.seq) === null, `seed ${seed} turn ${turn}: the same draw never waits twice`);
          checked++;
        }
      }
      seen = Math.max(seen, topSeq(st()));
    }
  }
  ok(checked >= 6, `Draw Phase draws checked (${checked})`);
}

// ---------- the holds clear ----------
{
  setIntroFor(2700);
  ok(introLeft() > 2000 && introLeft() <= 2700, 'the face-off holds the deal and the computer');
  setIntroFor(0);
  ok(introLeft() === 0, 'and lets go when it ends');
  setDrawHeld(42);
  ok(drawHeld(42) && !drawHeld(7), 'only the held card stays out of the flights');
  setDrawHeld(null);
  ok(!drawHeld(42), 'drawn: nothing held');
}

if (fails) {
  console.log(`${fails} immersion check(s) failed`);
  process.exit(1);
}
console.log('immersion: all checks passed');
