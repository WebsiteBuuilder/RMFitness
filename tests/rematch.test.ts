// Who goes first (rock-paper-scissors, coin toss, the loser's call) and rematches in the same
// room, through DuelSession over a host/guest pair that behaves like the PeerJS room.
// Run: npx tsx tests/rematch.test.ts
import { DB as KIT } from './speedkit';
import { DB } from '../src/eds/db';
import { DuelSession, type AnyAction } from '../src/eds/session';
import { applyToss, newToss, rpsWinner, type Toss } from '../src/eds/toss';
import { AdapterBase, type SyncAdapter } from '../src/sync/types';
import { MemoryAdapter } from '../src/sync/memory';
import type { GameEvent, LoggedEvent } from '../src/sync/events';
import type { Pid } from '../src/eds/types';
import { CHAPTERS } from '../src/eds/speedCampaign/roster';
import { deckOf } from '../src/eds/speedCampaign/campaign';
import { boardRows, duelistTitle, rankOf, type BoardEntry } from '../src/collection/rankings';

for (const [k, v] of KIT) DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) console.log(`FAIL: ${msg}`);
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
  if (!c) fails++;
};

// ---------- the toss on its own ----------
{
  ok(rpsWinner('rock', 'scissors') === 0 && rpsWinner('rock', 'paper') === 1 && rpsWinner('paper', 'paper') === null, 'rock beats scissors, paper beats rock, same hands draw');
  let t: Toss | null = newToss('rps');
  t = applyToss(t, { type: 'RPS', player: 0, hand: 'rock', round: 0 });
  ok(t!.chooser === null && t!.hands[0] === 'rock', 'one hand in: nobody has won yet');
  t = applyToss(t, { type: 'RPS', player: 0, hand: 'paper', round: 0 });
  ok(t!.hands[0] === 'rock', 'a player cannot change a hand already thrown');
  t = applyToss(t, { type: 'RPS', player: 1, hand: 'rock', round: 0 });
  ok(t!.round === 1 && t!.hands[0] === null && t!.rounds.length === 1 && t!.rounds[0].winner === null, 'a draw throws again');
  t = applyToss(t, { type: 'RPS', player: 1, hand: 'scissors', round: 0 });
  ok(t!.hands[1] === null, 'a late hand from the drawn round is ignored');
  t = applyToss(t, { type: 'RPS', player: 1, hand: 'scissors', round: 1 });
  t = applyToss(t, { type: 'RPS', player: 0, hand: 'rock', round: 1 });
  ok(t!.chooser === 0, 'rock beats scissors: Player 1 chooses');
  t = applyToss(t, { type: 'FIRST', player: 1, first: 1 });
  ok(t!.first === null, 'only the winner chooses');
  t = applyToss(t, { type: 'FIRST', player: 0, first: 1 });
  ok(t!.first === 1, 'the winner can choose to go second');
  const c = applyToss(newToss('coin'), { type: 'COIN', player: 0, call: 'heads', result: 'tails' });
  ok(c!.chooser === 1, 'a wrong call hands the choice to the other player');
  const l = newToss('loser', 1);
  ok(l.chooser === 1 && applyToss(l, { type: 'RPS', player: 0, hand: 'rock', round: 0 })!.chooser === 1, "the loser's call needs no throw");
}

// ---------- a room: a host and a guest linked like PeerJS ----------
class Host extends AdapterBase implements SyncAdapter {
  readonly kind = 'peer' as const;
  readonly isHost = true;
  readonly roomCode = 'ABCD';
  guest: Guest | null = null;
  constructor() {
    super();
    this.setStatus('connected', '');
  }
  send(ev: GameEvent) {
    const logged = { ...ev, seq: this.events.length, ts: 0 } as LoggedEvent;
    this.events = [...this.events, logged];
    this.emit();
    this.guest?.got([...this.guest.mirror(), logged]);
  }
  restart() {
    this.events = [];
    this.emit();
    this.guest?.got([]);
  }
  close() {}
}
class Guest extends AdapterBase implements SyncAdapter {
  readonly kind = 'peer' as const;
  readonly isHost = false;
  readonly roomCode = 'ABCD';
  constructor(private host: Host) {
    super();
    host.guest = this;
    this.setStatus('connected', '');
  }
  mirror() {
    return this.events;
  }
  got(events: LoggedEvent[]) {
    this.events = events;
    this.emit();
  }
  send(ev: GameEvent) {
    this.host.send(ev);
  }
  close() {}
}

const ROAD = CHAPTERS.flatMap((ch) => ch.nodes.map((n) => ({ name: n.duelist.name, ...deckOf(n.duelist) })));
const join = (s: DuelSession, p: Pid) => {
  const d = ROAD[p];
  s.send({ type: 'JOIN', player: p, name: d.name, deck: d.main, fusion: d.extra, mode: 'speed', skill: d.skill } as AnyAction);
};
const startFrom = (s: DuelSession, first: Pid) => {
  const [a, b] = s.seats;
  s.send({ type: 'START', first, seed: 1000 + s.round, names: [a.name, b.name], decks: [a.deck, b.deck], fusions: [a.fusion, b.fusion], mode: 'speed', skills: [a.skill ?? null, b.skill ?? null] });
};

{
  const host = new Host();
  const guest = new Guest(host);
  const H = new DuelSession(host);
  const G = new DuelSession(guest);
  join(H, 0);
  join(G, 1);
  H.send({ type: 'TOSS', how: 'rps' });
  ok(G.toss?.how === 'rps', "the guest's phone sees the rock-paper-scissors start");
  G.send({ type: 'RPS', player: 1, hand: 'paper', round: 0 });
  H.send({ type: 'RPS', player: 0, hand: 'rock', round: 0 });
  ok(H.toss?.chooser === 1 && G.toss?.chooser === 1, 'both phones agree the guest won the throw');
  ok(H.toss?.rounds[0].hands.join() === 'rock,paper' && G.toss?.rounds[0].hands.join() === 'rock,paper', 'both phones show the same two hands');
  G.send({ type: 'FIRST', player: 1, first: 1 });
  ok(H.toss?.first === 1, 'the host sees the choice');
  startFrom(H, H.toss!.first!);
  ok(H.state.started && G.state.turnPlayer === 1, 'the duel starts with the chosen player');
  startFrom(H, 0);
  ok(G.state.turnPlayer === 1, 'a second START is ignored');

  // The guest wins; a rematch in the same room.
  H.send({ type: 'SURRENDER', player: 0 });
  ok(H.state.winner === 1 && G.series.wins[1] === 1 && H.series.last === 1, 'the series counts the win on both phones');
  ok(!H.startRematch(), 'no rematch until both want one');
  H.send({ type: 'REMATCH', player: 0, want: true });
  ok(G.rematch[0] === 'yes', "the guest sees the host's rematch call");
  G.send({ type: 'REMATCH', player: 1, want: true });
  ok(H.rematchAgreed && G.rematchAgreed, 'both phones see the rematch agreed');
  ok(H.startRematch(), 'the host restarts the room');
  ok(H.round === 1 && G.round === 1, 'both phones move to the rematch');
  ok(!H.state.started && !G.seats[0].ready && G.toss === null, 'the room is back to empty seats and no toss');
  ok(G.prevSeats?.[1].name === ROAD[1].name, "the last duel's seats are kept for carrying bets");
  ok(H.series.wins[1] === 1 && G.series.wins[1] === 1, 'the series score survives the rematch');
  join(H, 0);
  join(G, 1);
  H.send({ type: 'TOSS', how: 'loser', chooser: 0 });
  ok(G.toss?.chooser === 0, "the last loser (the host) makes the call");
  H.send({ type: 'FIRST', player: 0, first: 0 });
  startFrom(H, H.toss!.first!);
  ok(G.state.started && G.state.turnPlayer === 0 && G.state.seed === 1001, 'the rematch duel starts on both phones');
  G.send({ type: 'SURRENDER', player: 1 });
  ok(H.series.wins.join() === '1,1' && G.series.wins.join() === '1,1', 'series 1-1');
  G.send({ type: 'REMATCH', player: 1, want: false });
  H.send({ type: 'REMATCH', player: 0, want: true });
  ok(H.rematch[1] === 'no' && !H.rematchAgreed, 'walking away ends the series');
}

// ---------- against the computer ----------
{
  const s = new DuelSession(new MemoryAdapter());
  join(s, 0);
  join(s, 1);
  s.send({ type: 'TOSS', how: 'rps' });
  s.send({ type: 'RPS', player: 0, hand: 'scissors', round: 0 });
  s.send({ type: 'RPS', player: 1, hand: 'paper', round: 0 });
  ok(s.toss?.chooser === 0, 'beating the computer at rock-paper-scissors lets you choose');
  s.send({ type: 'START', first: 0, seed: 5, names: ['a', 'b'], decks: [ROAD[0].main, ROAD[1].main], fusions: [[], []], mode: 'speed' });
  ok(s.state.started, 'the duel starts after the toss');
  s.send({ type: 'RPS', player: 0, hand: 'rock', round: 0 });
  ok(s.toss?.rounds.length === 1, 'toss moves after the start are ignored');
}

// ---------- rankings ----------
{
  ok(duelistTitle({ w: 0, l: 0, d: 0 }).name === 'Rookie Duelist', 'no duels yet: Rookie');
  ok(duelistTitle({ w: 30, l: 10, d: 0 }).name !== 'Rookie Duelist', 'thirty wins climb the ladder');
  ok(rankOf({ w: 10, l: 0, d: 0 }) > rankOf({ w: 10, l: 10, d: 0 }), 'losses cost rank points');
  ok(rankOf({ w: 5, l: 30, d: 0 }) >= 0, 'rank points never go below zero');
  const rows: BoardEntry[] = [
    { name: 'A', w: 2, l: 5, d: 0, streak: 0, kind: 'me' },
    { name: 'B', w: 9, l: 1, d: 0, streak: 3, kind: 'friend' },
    { name: 'C', w: 9, l: 1, d: 0, streak: 0, kind: 'phone' },
  ];
  const out = boardRows(rows);
  ok(out[0].name === 'B' && out[1].name === 'C' && out[2].name === 'A' && out[0].place === 1, 'the board ranks by rank points, then streak');
  ok(out[0].place === 1 && out[1].place === 2, 'places count from 1');
}

console.log(fails ? `${fails} FAILED` : 'rematch: all checks passed');
if (fails) process.exit(1);
