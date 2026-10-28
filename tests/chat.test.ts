// Chat between the two players of an online room: lines ride the room's log as CHAT actions,
// reach both phones in the same order, never touch the duel, and stay through a rematch.
// Run: npx tsx tests/chat.test.ts
import { DB as KIT } from './speedkit';
import { DB } from '../src/eds/db';
import { CHAT_MAX, cleanChat, DuelSession, screenProposal, type AnyAction } from '../src/eds/session';
import { AdapterBase, type SyncAdapter } from '../src/sync/types';
import { MemoryAdapter } from '../src/sync/memory';
import type { GameEvent, LoggedEvent } from '../src/sync/events';
import type { Pid } from '../src/eds/types';
import { CHAPTERS } from '../src/eds/speedCampaign/roster';
import { deckOf } from '../src/eds/speedCampaign/campaign';
import { bubbleMs, canSend, EMOTES, isEmote, phrasesFor, QUICK_PHRASES } from '../src/ui/chatRules';

for (const [k, v] of KIT) DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) console.log(`FAIL: ${msg}`);
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
  if (!c) fails++;
};

// ---------- lines as shown ----------
{
  ok(cleanChat('  hi   there \n bro ') === 'hi there bro', 'spaces and new lines fold into one line');
  ok(cleanChat('a\u0000b\u202Ec') === 'a b c', 'control and text-direction characters become spaces');
  ok(cleanChat('x'.repeat(200)).length === CHAT_MAX, `a long line is cut to ${CHAT_MAX} characters`);
  ok(Array.from(cleanChat('😂'.repeat(100))).length === CHAT_MAX, 'emoji count as one character each (never cut in half)');
  ok(cleanChat('   ') === '' && cleanChat(42) === '' && cleanChat(null) === '', 'nothing to say, or not text: empty');
  ok(EMOTES.every(isEmote), 'every emote button counts as an emote (shown big)');
  ok(isEmote('👍👍') && !isEmote('gg 👍') && !isEmote('Nice move!'), 'only emoji-only lines are emotes');
  ok(QUICK_PHRASES.every((p) => cleanChat(p) === p), 'every quick phrase goes out as it reads');
  ok(cleanChat('a\u200Bb\u2067c\uFEFF') === 'a b c', 'zero-width and text-direction marks become spaces');
  ok(cleanChat('👨\u200D👩\u200D👧') === '👨\u200D👩\u200D👧', 'joined emoji (a family) stay whole');
  ok(cleanChat('Z\u0301\u0302\u0303\u0304\u0305') === 'Z\u0301\u0302', 'a pile of accents is cut to two (no text growing over the screen)');
  for (const w of ['room', 'mine', 'theirs', 'after'] as const) ok(phrasesFor(w).length === QUICK_PHRASES.length && new Set(phrasesFor(w)).size === QUICK_PHRASES.length, `every phrase is offered (${w})`);
  ok(phrasesFor('after')[0] === 'Good game!' && phrasesFor('room')[0] === 'Hi! Good luck!' && phrasesFor('theirs')[0] === 'Nice move!' && phrasesFor('mine')[0] === 'Thinking…', 'the phrase for the moment comes first');
  ok(bubbleMs('👍') === 4500 && bubbleMs('x'.repeat(40)) > 4500 && bubbleMs('x'.repeat(80)) === 7000, 'a longer line stays up longer (up to 7 seconds)');
  const now = 100_000;
  ok(canSend([], now) && canSend([now - 1000, now - 900, now - 800], now), 'up to four lines in a few seconds');
  ok(!canSend([now - 1000, now - 900, now - 800, now - 700], now), 'a fifth line right away waits (no flooding the other phone)');
  ok(canSend([now - 9000, now - 8500, now - 8200, now - 8100], now), 'after a pause the lines flow again');
}

// ---------- the host screens what the other phone proposes ----------
{
  const recent: number[] = [];
  const t = 50_000;
  const move = { type: 'NEXT_PHASE', player: 1 };
  ok(screenProposal(move, 1, recent, t) === move, 'a duel move passes as it is');
  ok(screenProposal({ type: 'CHAT', player: 0, text: 'I give up' }, 1, recent, t) === null, "a line in the host's name from the other phone is dropped");
  ok(screenProposal({ type: 'CHAT', player: 1, text: '   ' }, 1, recent, t) === null, 'an empty line is dropped');
  const big = screenProposal({ type: 'CHAT', player: 1, text: 'y'.repeat(100_000) }, 1, recent, t);
  ok(!!big && (big as { text: string }).text.length === CHAT_MAX, 'a huge line is cut before it is stored in the room');
  let passed = 1;
  for (let i = 0; i < 20; i++) if (screenProposal({ type: 'CHAT', player: 1, text: 'spam' }, 1, recent, t + i)) passed++;
  ok(passed === 8, `a flood from a changed app is capped at 8 lines in a few seconds (got ${passed})`);
  ok(!!screenProposal({ type: 'CHAT', player: 1, text: 'later' }, 1, recent, t + 9000), 'after a pause lines get through again');
  const extra = screenProposal({ type: 'CHAT', player: 1, text: 'hi', junk: 'z'.repeat(10_000) } as { type: string }, 1, [], t);
  ok(JSON.stringify(extra) === '{"type":"CHAT","player":1,"text":"hi"}', 'anything else a changed app attaches to a line is dropped')
}

// ---------- a room: a host and a guest linked like PeerJS ----------
class Host extends AdapterBase implements SyncAdapter {
  readonly kind = 'peer' as const;
  readonly isHost = true;
  readonly roomCode = 'ABCD';
  guest: Guest | null = null;
  /** stamp entries with the real time (default: long ago) */
  live = false;
  constructor() {
    super();
    this.setStatus('connected', '');
  }
  send(ev: GameEvent) {
    const logged = { ...ev, seq: this.events.length, ts: this.live ? Date.now() : 1000 + this.events.length } as LoggedEvent;
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
  s.send({ type: 'START', first, seed: 2000 + s.round, names: [a.name, b.name], decks: [a.deck, b.deck], fusions: [a.fusion, b.fusion], mode: 'speed', skills: [a.skill ?? null, b.skill ?? null] });
};
const say = (s: DuelSession, p: Pid, text: string) => s.send({ type: 'CHAT', player: p, text });
const lines = (s: DuelSession) => s.view().chat.map((l) => `${l.player}:${l.text}`).join('|');

{
  const host = new Host();
  const guest = new Guest(host);
  const H = new DuelSession(host);
  const G = new DuelSession(guest);
  say(G, 1, 'hi');
  join(H, 0);
  join(G, 1);
  ok(lines(H) === '1:hi' && lines(G) === '1:hi', 'a line in the room before the duel reaches both phones');
  ok(H.seats[0].ready && H.seats[1].ready && !H.seats[0].accepted, 'a chat line changes nothing in the room (seats as they were)');
  const moves = G.view().moves;
  say(G, 1, 'ready?');
  ok(G.view().moves === moves && G.view().log.length === moves + 2, "chat doesn't count as a move (screens keyed on moves don't re-run)");
  H.send({ type: 'TOSS', how: 'rps' });
  say(H, 0, 'good luck!');
  G.send({ type: 'RPS', player: 1, hand: 'paper', round: 0 });
  H.send({ type: 'RPS', player: 0, hand: 'rock', round: 0 });
  ok(H.toss?.chooser === 1 && G.toss?.chooser === 1, 'chat during rock-paper-scissors leaves the throw alone');
  G.send({ type: 'FIRST', player: 1, first: 1 });
  startFrom(H, 1);
  ok(H.state.started && G.state.turnPlayer === 1, 'the duel starts as usual');
  const before = JSON.stringify(G.state.players.map((p) => [p.lp, p.hand.length, p.deck.length]));
  const turn = G.state.turn;
  say(G, 1, 'watch this');
  say(H, 0, '😂');
  say(G, 1, '  multi\nline   text ');
  ok(JSON.stringify(G.state.players.map((p) => [p.lp, p.hand.length, p.deck.length])) === before && G.state.turn === turn && G.state.winner === null, 'chat mid-duel never touches the duel');
  ok(lines(H) === lines(G) && lines(G) === '1:hi|1:ready?|0:good luck!|1:watch this|0:😂|1:multi line text', 'both phones show the same lines in the same order, tidied');
  ok(H.view().chat.every((l, i, a) => i === 0 || l.at >= a[i - 1].at) && new Set(H.view().chat.map((l) => l.id)).size === 6, 'each line has its own id and the host’s time');
  // a forged or broken line from a phone is dropped, not shown
  host.send({ type: 'CHAT', player: 5, text: 'who?' } as unknown as GameEvent);
  host.send({ type: 'CHAT', player: 0, text: '' } as unknown as GameEvent);
  host.send({ type: 'CHAT', player: 1, text: { evil: true } } as unknown as GameEvent);
  ok(G.view().chat.length === 6, 'a line with no text or no real seat is left out');

  // a rejoin (the log handed over again from the start) shows the same chat, once
  const again = new DuelSession(new MemoryAdapter());
  for (const ev of host['events'] as LoggedEvent[]) again.adapter.send(ev);
  ok(again.view().chat.map((l) => `${l.player}:${l.text}`).join('|') === lines(H), 'a phone that rejoins sees what was said');
  const rebuilt = new Guest(new Host());
  rebuilt.got(host['events'] as LoggedEvent[]);
  const R = new DuelSession(rebuilt);
  rebuilt.got(host['events'] as LoggedEvent[]);
  ok(lines(R) === lines(H), 'the same log handed over twice shows each line once');
  ok(R.view().chat.every((l) => l.old), 'lines that come with the log loading on a rejoin are history (no ping, no bubble)');
  // a line said after the load has settled is news
  {
    const realNow = Date.now;
    let t = realNow();
    Date.now = () => t;
    try {
      const host2 = new Host();
      const guest2 = new Guest(host2);
      host2.send({ type: 'CHAT', player: 0, text: 'old one' } as unknown as GameEvent);
      const G2 = new DuelSession(guest2);
      host2.live = true;
      t += 100;
      host2.send({ type: 'CHAT', player: 0, text: 'same load' } as unknown as GameEvent);
      t += 5000;
      host2.send({ type: 'CHAT', player: 0, text: 'hey' } as unknown as GameEvent);
      t += 50;
      host2.send({ type: 'CHAT', player: 0, text: 'you there?' } as unknown as GameEvent);
      ok(G2.view().chat.map((l) => l.old).join() === 'true,false,false,false', 'after the first load, every new line is news, however quickly it follows another (and a line just said is news even in the load)');
      // a later piece of an old log (a reload's load arriving in parts) is still history
      t += 5000;
      host2.live = false;
      host2.send({ type: 'CHAT', player: 0, text: 'from long ago' } as unknown as GameEvent);
      ok(G2.view().chat[4].old, 'a line said long before this phone opened the room stays history, however late it arrives');
    } finally {
      Date.now = realNow;
    }
  }

  // the room's very first entry is a line said just now (nobody has pressed Ready yet): news
  {
    const host3 = new Host();
    host3.live = true;
    const guest3 = new Guest(host3);
    const G3 = new DuelSession(guest3);
    host3.send({ type: 'CHAT', player: 0, text: 'Hi! Good luck!' } as unknown as GameEvent);
    ok(G3.view().chat.length === 1 && !G3.view().chat[0].old, "a line in a room that is still empty pops up on the other phone");
  }

  // the duel ends; chat goes on over the result; a rematch keeps the room's chat
  H.send({ type: 'SURRENDER', player: 0 });
  say(G, 1, 'gg');
  ok(G.state.winner === 1 && lines(H).endsWith('1:gg'), 'a line after the duel still gets through');
  H.send({ type: 'REMATCH', player: 0, want: true });
  G.send({ type: 'REMATCH', player: 1, want: true });
  ok(H.startRematch() && G.round === 1, 'rematch');
  ok(lines(G) === lines(H) && lines(G).endsWith('1:gg') && G.view().chat.length === 7, 'the rematch keeps what was said before it');
  say(H, 0, 'again!');
  ok(lines(G).endsWith('1:gg|0:again!'), 'new lines follow the old ones');
  ok(new Set(G.view().chat.map((l) => l.id)).size === 8, 'ids stay unique across the rematch');
  join(H, 0);
  join(G, 1);
  ok(H.seats[0].ready && G.seats[1].ready, 'the rematch room fills as usual');
}

console.log(fails ? `${fails} FAILED` : 'chat: all checks passed');
if (fails) process.exit(1);
