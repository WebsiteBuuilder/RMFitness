// Friends and presence: requests, online status, invites, rooms, dropped links.
// Runs the real Presence code over an in-memory transport with a hand-driven clock.
// Run: npx tsx tests/friends.test.ts
import { Presence, PING_MS, SILENT_MS, INVITE_MS, POLL_MS, type OnlineData } from '../src/online/presence';
import { parseFriendCode, showCode, newFriendCode, type Link, type Transport, type TransportHandlers, type Wire } from '../src/online/protocol';

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) failures++;
};

// ---------- an in-memory "broker" ----------

let clock = 1_000_000;
const queue: (() => void)[] = [];
/** delivers everything in flight (messages answer messages, so loop) */
function flush() {
  for (let i = 0; i < 10_000 && queue.length; i++) queue.shift()!();
}

class MemLink implements Link {
  other!: MemLink;
  opened = false;
  closed = false;
  /** the network silently ate this link (a phone dropped off): nothing gets through, no close */
  dead = false;
  private openCbs: (() => void)[] = [];
  private msgCbs: ((m: Wire) => void)[] = [];
  private closeCbs: (() => void)[] = [];
  constructor(
    readonly peer: string,
    readonly outgoing: boolean,
  ) {}
  send(m: Wire) {
    if (this.closed || this.dead) return;
    const to = this.other;
    const copy = JSON.parse(JSON.stringify(m)) as Wire;
    queue.push(() => {
      if (!to.closed && !to.dead) for (const cb of to.msgCbs) cb(copy);
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb();
    if (!this.dead) queue.push(() => this.other?.close());
  }
  fireOpen() {
    this.opened = true;
    for (const cb of this.openCbs) cb();
  }
  onOpen(cb: () => void) {
    if (this.opened) queue.push(cb);
    else this.openCbs.push(cb);
  }
  onMessage(cb: (m: Wire) => void) {
    this.msgCbs.push(cb);
  }
  onClose(cb: () => void) {
    this.closeCbs.push(cb);
  }
}

const broker = new Map<string, MemTransport>();

class MemTransport implements Transport {
  code = '';
  h!: TransportHandlers;
  links: MemLink[] = [];
  start(code: string, h: TransportHandlers) {
    this.code = code;
    this.h = h;
    if (broker.has(code)) return h.onState('elsewhere');
    broker.set(code, this);
    queue.push(() => h.onState('ready'));
  }
  connect(code: string): Link {
    const mine = new MemLink(code, true);
    this.links.push(mine);
    queue.push(() => {
      const there = broker.get(code);
      if (!there) return this.h.onUnavailable(code);
      const theirs = new MemLink(this.code, false);
      there.links.push(theirs);
      mine.other = theirs;
      theirs.other = mine;
      there.h.onIncoming(theirs);
      queue.push(() => {
        if (mine.closed || theirs.closed) return;
        mine.fireOpen();
        theirs.fireOpen();
      });
    });
    return mine;
  }
  wake() {}
  stop() {
    if (broker.get(this.code) === this) broker.delete(this.code);
    for (const l of this.links) l.close();
  }
  /** the phone loses its connection without saying goodbye */
  vanish() {
    if (broker.get(this.code) === this) broker.delete(this.code);
    for (const l of this.links) l.dead = true;
  }
}

const saved = new Map<string, OnlineData>();

function player(code: string, name: string, data?: OnlineData) {
  const t = new MemTransport();
  const d: OnlineData = data ?? saved.get(code) ?? { code, friends: [], ignored: [] };
  const p = new Presence({
    transport: t,
    data: d,
    me: { name, color: '#123456' },
    save: (x) => saved.set(code, JSON.parse(JSON.stringify(x))),
    now: () => clock,
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
  p.start();
  return { p, t };
}

/** time passes: ticks every second, delivering messages in between */
function wait(ms: number, ...ps: Presence[]) {
  for (let t = 0; t < ms; t += 1000) {
    clock += 1000;
    for (const p of ps) p.tick();
    flush();
  }
}

const statusOf = (p: Presence, code: string) => p.data.friends.find((f) => f.code === code)?.status;

// ---------- codes ----------
{
  const c = newFriendCode();
  check(c.length === 6 && parseFriendCode(c) === c, 'new friend codes parse back');
  check(parseFriendCode('k7q-2mx') === 'K7Q2MX' && showCode('K7Q2MX') === 'K7Q-2MX', 'codes read with or without the dash, any case');
  check(parseFriendCode('https://x.github.io/RMFitness/?friend=K7Q2MX') === 'K7Q2MX', 'a pasted friend link gives the code');
  check(parseFriendCode('K7Q2M0') === null && parseFriendCode('ABC') === null, 'look-alike letters (0, O, 1, I) and short codes are refused');
}

// ---------- requests and online status ----------
const A = player('AAAAAA', 'Jammy');
const B = player('BBBBBB', 'Bro');
flush();
check(A.p.state === 'ready' && B.p.state === 'ready', 'both phones go online');

check(A.p.add('BBBBBB') === 'added', 'Jammy adds Bro by code');
flush();
check(statusOf(A.p, 'BBBBBB') === 'sent', "Jammy's side: request sent");
check(statusOf(B.p, 'AAAAAA') === 'request', "Bro's side: a friend request from Jammy");
check(B.p.data.friends[0]?.name === 'Jammy', 'the request carries the name');
check(A.p.add('AAAAAA') === 'self', "can't add yourself");

B.p.accept('AAAAAA');
flush();
check(statusOf(A.p, 'BBBBBB') === 'friend' && statusOf(B.p, 'AAAAAA') === 'friend', 'Bro accepts: friends on both phones');
check(A.p.isOnline('BBBBBB') && B.p.isOnline('AAAAAA'), 'each sees the other online');
check(A.p.friends()[0].name === 'Bro', "Jammy's list learns Bro's name");
check(A.p.onlineCount() === 1, 'online count');

// ---------- activity ----------
B.p.setActivity({ kind: 'room', room: 'QWER', game: 'speed', open: true });
flush();
const bv = A.p.friends()[0];
check(bv.activity?.kind === 'room' && bv.activity.room === 'QWER', "Jammy sees Bro's open room");
B.p.setActivity({ kind: 'menu' });
flush();

// ---------- invites ----------
A.p.setActivity({ kind: 'room', room: 'ZXCV', game: 'speed', open: true });
const inv = A.p.invite('BBBBBB', 'ZXCV', 'speed');
flush();
check(!!inv && B.p.incoming.length === 1 && B.p.incoming[0].room === 'ZXCV' && B.p.incoming[0].game === 'speed', 'Bro gets the invite with room and game');
let accepted = '';
A.p.onAccepted = (o) => (accepted = o.room);
const taken = B.p.answer(B.p.incoming[0].id, true);
flush();
check(taken?.room === 'ZXCV' && A.p.outgoing?.state === 'accepted' && accepted === 'ZXCV', 'Bro says yes; Jammy hears it');
check(B.p.incoming.length === 0, 'the invite is gone once answered');

// declined
A.p.setActivity({ kind: 'room', room: 'ASDF', game: 'eds', open: true });
A.p.invite('BBBBBB', 'ASDF', 'eds');
flush();
B.p.answer(B.p.incoming[0].id, false);
flush();
check(A.p.outgoing?.state === 'declined', 'a "not now" reaches the inviter');

// cancelled by leaving the room
A.p.setActivity({ kind: 'room', room: 'HJKL', game: 'speed', open: true });
A.p.invite('BBBBBB', 'HJKL', 'speed');
flush();
check(B.p.incoming.length === 1, 'invite waiting');
A.p.setActivity({ kind: 'menu' });
flush();
check(B.p.incoming.length === 0 && A.p.outgoing === null, 'leaving the room takes the invite back');

// the room filling up keeps the invite
A.p.setActivity({ kind: 'room', room: 'POIU', game: 'speed', open: true });
A.p.invite('BBBBBB', 'POIU', 'speed');
flush();
A.p.setActivity({ kind: 'room', room: 'POIU', game: 'speed', open: false });
flush();
check(B.p.incoming.length === 1, 'the room filling up does not cancel the invite by itself');
B.p.answer(B.p.incoming[0].id, false);
flush();

// expired
A.p.setActivity({ kind: 'room', room: 'MNBV', game: 'speed', open: true });
A.p.invite('BBBBBB', 'MNBV', 'speed');
flush();
wait(INVITE_MS + 1000, A.p, B.p);
check(A.p.outgoing?.state === 'expired' && B.p.incoming.length === 0, 'an unanswered invite expires on both phones');

// busy
B.p.setActivity({ kind: 'duel', game: 'speed' });
flush();
check(A.p.friends()[0].activity?.kind === 'duel', 'Jammy sees Bro is in a duel');
A.p.setActivity({ kind: 'room', room: 'LKJH', game: 'speed', open: true });
A.p.invite('BBBBBB', 'LKJH', 'speed');
flush();
check(A.p.outgoing?.state === 'busy' && B.p.incoming.length === 0, 'a player in a duel answers "busy" on their own');
B.p.setActivity({ kind: 'menu' });
A.p.setActivity({ kind: 'menu' });
flush();

// strangers can't invite
const C = player('CCCCCC', 'Stranger');
flush();
C.p.add('BBBBBB');
flush();
check(statusOf(B.p, 'CCCCCC') === 'request', 'a stranger shows up as a request');
check(C.p.invite('BBBBBB', 'ROOM', 'speed') === null, "a stranger who isn't a friend yet can't send invites");
B.p.remove('CCCCCC');
flush();
check(statusOf(B.p, 'CCCCCC') === undefined && statusOf(C.p, 'BBBBBB') === undefined, 'declining clears the request on both phones');
wait(POLL_MS * 2, A.p, B.p, C.p);
check(statusOf(B.p, 'CCCCCC') === undefined, 'a declined player does not keep coming back');
C.p.stop();
flush();

// ---------- going offline and back ----------
B.p.stop();
flush();
check(!A.p.isOnline('BBBBBB'), 'Bro closes the game: offline at once');
check((A.p.data.friends[0].lastSeen ?? 0) > 0, 'last seen is kept');

const B2 = player('BBBBBB', 'Bro');
flush();
check(A.p.isOnline('BBBBBB') && B2.p.isOnline('AAAAAA'), 'Bro opens the game again: online within moments (he dials his friends)');

// phone drops off with no goodbye
B2.t.vanish();
wait(SILENT_MS + PING_MS, A.p);
check(!A.p.isOnline('BBBBBB'), 'a phone that drops off the network shows offline after the silence timeout');
B2.p.stop();
flush();

// Jammy offline, Bro starts first, Jammy comes later
A.p.stop();
flush();
const B3 = player('BBBBBB', 'Bro');
flush();
wait(POLL_MS, B3.p);
check(!B3.p.isOnline('AAAAAA'), 'Jammy away: shows offline');
const A2 = player('AAAAAA', 'Jammy');
flush();
check(A2.p.isOnline('BBBBBB') && B3.p.isOnline('AAAAAA'), 'Jammy comes back: both online');

// both dial at the same moment
A2.p.stop();
B3.p.stop();
flush();
const A3 = player('AAAAAA', 'Jammy');
const B4 = player('BBBBBB', 'Bro');
flush();
wait(3000, A3.p, B4.p);
check(A3.p.isOnline('BBBBBB') && B4.p.isOnline('AAAAAA'), 'both phones dialing at once still end up linked');
const openLinks = (t: MemTransport) => t.links.filter((l) => l.opened && !l.closed).length;
check(openLinks(A3.t) === 1 && openLinks(B4.t) === 1, 'and only one link is kept');
wait(POLL_MS * 3, A3.p, B4.p);
check(A3.p.isOnline('BBBBBB') && openLinks(A3.t) === 1, 'still one steady link after a while');

// same profile on two phones
const A4 = player('AAAAAA', 'Jammy');
flush();
check(A4.p.state === 'elsewhere', 'the same profile opened twice: the second says it is online elsewhere');

// remove
A3.p.remove('BBBBBB');
flush();
check(statusOf(A3.p, 'BBBBBB') === undefined && statusOf(B4.p, 'AAAAAA') === undefined, 'removing a friend removes on both phones');
check(A3.p.add('BBBBBB') === 'added', 'they can be added again');
flush();
check(statusOf(B4.p, 'AAAAAA') === 'request', 'and the request comes through again');
check(B4.p.add('AAAAAA') === 'accepted', 'adding someone who already asked accepts them');
flush();
check(statusOf(A3.p, 'BBBBBB') === 'friend', 'friends again');

// a phone that lost its data
B4.p.stop();
flush();
const fresh: OnlineData = { code: 'BBBBBB', friends: [], ignored: [] };
const B5 = player('BBBBBB', 'Bro', fresh);
flush();
wait(POLL_MS, A3.p, B5.p);
check(statusOf(B5.p, 'AAAAAA') === 'request' && statusOf(A3.p, 'BBBBBB') === 'sent', 'a friend whose phone lost its data gets a fresh request');

console.log(failures ? `\n${failures} FAILED` : '\nall friends tests passed');
if (failures) process.exit(1);
