// Matchmaking: two phones press Find a Match and end up in the same room, over an
// in-memory broker with a hand-driven clock (slots, ghosts, races, cancel).
// Run: npx tsx tests/matchmaking.test.ts
import { Matchmaker, SLOTS, CALL_MS, PROBE_MS, slotId, type HoldResult, type Match, type MmLink, type MmNet, type MmWire } from '../src/online/matchmaking';

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) failures++;
};

// ---------- clock and broker ----------
let clock = 0;
let timers: { at: number; fn: () => void; id: number }[] = [];
let tid = 0;
const queue: (() => void)[] = [];
function flush() {
  for (let i = 0; i < 10_000 && queue.length; i++) queue.shift()!();
}
function wait(ms: number) {
  const end = clock + ms;
  flush();
  for (;;) {
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const t = timers[0];
    if (!t || t.at > end) break;
    timers.shift();
    clock = t.at;
    t.fn();
    flush();
  }
  clock = end;
}
const setT = (fn: () => void, ms: number) => {
  const id = ++tid;
  timers.push({ at: clock + ms, fn, id });
  return id;
};
const clearT = (h: unknown) => (timers = timers.filter((t) => t.id !== h));

class Line implements MmLink {
  other!: Line;
  opened = false;
  closed = false;
  private openCbs: (() => void)[] = [];
  private msgCbs: ((m: MmWire) => void)[] = [];
  private closeCbs: (() => void)[] = [];
  send(m: MmWire) {
    if (this.closed) return;
    const to = this.other;
    const copy = JSON.parse(JSON.stringify(m)) as MmWire;
    queue.push(() => {
      if (!to.closed) for (const cb of to.msgCbs.slice()) cb(copy);
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb();
    queue.push(() => this.other?.close());
  }
  fireOpen() {
    this.opened = true;
    for (const cb of this.openCbs) cb();
  }
  onOpen(cb: () => void) {
    if (this.opened) queue.push(cb);
    else this.openCbs.push(cb);
  }
  onMessage(cb: (m: MmWire) => void) {
    this.msgCbs.push(cb);
  }
  onClose(cb: () => void) {
    this.closeCbs.push(cb);
  }
}

/** slot → who holds it; 'ghost' is a vanished phone the broker still remembers */
const slots = new Map<string, { onCall: (l: MmLink) => void } | 'ghost'>();
let offline = false;

class MemNet implements MmNet {
  mine = new Set<string>();
  hold(slot: string, done: (r: HoldResult) => void, onCall: (l: MmLink) => void) {
    let released = false;
    queue.push(() => {
      if (released) return;
      if (offline) return done('offline');
      if (slots.has(slot)) return done('taken');
      slots.set(slot, { onCall });
      this.mine.add(slot);
      done('held');
    });
    return {
      release: () => {
        released = true;
        const h = slots.get(slot);
        if (h && h !== 'ghost' && h.onCall === onCall) slots.delete(slot);
        this.mine.delete(slot);
      },
    };
  }
  call(slot: string): MmLink {
    const mine = new Line();
    queue.push(() => {
      const h = slots.get(slot);
      if (!h) return mine.close();
      if (h === 'ghost') return; // never answers
      const theirs = new Line();
      mine.other = theirs;
      theirs.other = mine;
      h.onCall(theirs);
      queue.push(() => {
        if (mine.closed || theirs.closed) return;
        mine.fireOpen();
        theirs.fireOpen();
      });
    });
    return mine;
  }
  stop() {
    for (const s of this.mine) slots.delete(s);
    this.mine.clear();
  }
}

let codeN = 0;
let roomN = 0;
/** a fresh 4-letter room code each time */
const roomCode = () => { let n = roomN++, c = ''; for (let i = 0; i < 4; i++) (c += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[n % 24]), (n = Math.floor(n / 24)); return c; };
function phone(name: string) {
  const code = `PL${String(++codeN).padStart(4, "0")}`;
  const got: Match[] = [];
  const m = new Matchmaker({
    net: () => new MemNet(),
    me: () => ({ name, color: '#123456', code }),
    now: () => clock,
    setTimeout: setT,
    clearTimeout: clearT,
    room: () => roomCode(),
  });
  m.onMatch = (x) => got.push(x);
  return { m, got, code };
}

// ---------- two phones, one after the other ----------
{
  const a = phone('Jammy');
  const b = phone('Bro');
  a.m.start('speed');
  wait(5000);
  check(a.m.state === 'searching' && slots.has(slotId('speed', 0)), 'first in the queue waits in slot 0');
  b.m.start('speed');
  wait(1000);
  check(a.got.length === 1 && b.got.length === 1, 'the second press finds the first');
  check(a.got[0].role === 'host' && b.got[0].role === 'guest', 'the one waiting hosts, the one who came second joins');
  check(a.got[0].room === b.got[0].room && /^[A-Z]{4}$/.test(a.got[0].room), 'both get the same room code');
  check(a.got[0].opponent.name === 'Bro' && b.got[0].opponent.name === 'Jammy', 'each sees who they are facing');
  check(b.got[0].opponent.code === a.code, "the opponent's friend code comes along (for adding them afterwards)");
  wait(3000);
  check(slots.size === 0, 'the slot is free again once matched');
  check(a.m.state === 'found' && b.m.state === 'found', 'both show found');
  a.m.clear();
  b.m.clear();
}

// ---------- cancel ----------
{
  const a = phone('Solo');
  a.m.start('speed');
  wait(2000);
  a.m.cancel();
  wait(10);
  check(a.m.state === 'idle' && slots.size === 0, 'cancel leaves the queue and frees the slot');
  const b = phone('Late');
  b.m.start('speed');
  wait(2000);
  check(b.got.length === 0 && b.m.state === 'searching', 'someone pressing after a cancel just waits');
  b.m.cancel();
  wait(10);
}

// ---------- a ghost in slot 0 ----------
{
  slots.set(slotId('speed', 0), 'ghost');
  const a = phone('Ann');
  const b = phone('Ben');
  a.m.start('speed');
  wait(CALL_MS + 2000);
  check(slots.get(slotId('speed', 1)) !== undefined && a.m.state === 'searching', 'a dead phone in slot 0: the next one waits in slot 1');
  b.m.start('speed');
  wait(CALL_MS * 2 + 2000);
  check(a.got.length === 1 && b.got.length === 1 && a.got[0].room === b.got[0].room, 'the next player gets past the dead slot and finds them');
  slots.clear();
}

// ---------- two waiters on different slots find each other ----------
{
  slots.set(slotId('speed', 0), 'ghost');
  const a = phone('Cat');
  a.m.start('speed');
  wait(CALL_MS + 1000);
  check(slots.has(slotId('speed', 1)), 'waits in slot 1 behind a dead phone');
  // the dead phone is forgotten, and someone else takes slot 0
  slots.delete(slotId('speed', 0));
  const b = phone('Dan');
  b.m.start('speed');
  wait(1000);
  check(b.m.state === 'searching' && a.got.length === 0, 'the newcomer sits in slot 0 for a moment');
  wait(PROBE_MS + 2000);
  check(a.got.length === 1 && b.got.length === 1 && a.got[0].room === b.got[0].room, 'the higher waiter checks the lower slot and they meet');
  check(a.got[0].role === 'guest' && b.got[0].role === 'host', 'whoever is lower hosts');
  wait(3000);
  check(slots.size === 0, 'both slots freed');
}

// ---------- three at once: two match, the third keeps waiting ----------
{
  const p = [phone('E1'), phone('E2'), phone('E3')];
  for (const x of p) x.m.start('speed');
  wait(CALL_MS * 3);
  const matched = p.filter((x) => x.got.length === 1);
  const left = p.filter((x) => x.got.length === 0);
  check(matched.length === 2 && matched[0].got[0].room === matched[1].got[0].room, 'three press together: two of them duel');
  check(left.length === 1 && left[0].m.state === 'searching', 'the third keeps waiting');
  const q = phone('E4');
  q.m.start('speed');
  wait(CALL_MS * 2 + PROBE_MS);
  check(q.got.length === 1 && left[0].got.length === 1 && q.got[0].room === left[0].got[0].room, 'and gets the next one who presses');
  wait(3000);
  slots.clear();
}

// ---------- a whole crowd pairs up with nobody matched twice ----------
{
  const p = Array.from({ length: 8 }, (_, i) => phone(`F${i}`));
  for (const x of p) {
    x.m.start('speed');
    wait(300);
  }
  wait(CALL_MS * SLOTS + PROBE_MS * 3);
  const rooms = new Map<string, number>();
  for (const x of p) for (const g of x.got) rooms.set(g.room, (rooms.get(g.room) ?? 0) + 1);
  check(p.every((x) => x.got.length === 1), 'eight phones: everyone is matched exactly once');
  check([...rooms.values()].every((n) => n === 2), 'every room has exactly two duelists');
  wait(3000);
  slots.clear();
}

// ---------- the same profile can't match itself ----------
{
  const a = phone('Twin');
  const b = new Matchmaker({ net: () => new MemNet(), me: () => ({ name: 'Twin', color: '#111', code: a.code }), now: () => clock, setTimeout: setT, clearTimeout: clearT });
  let got = 0;
  b.onMatch = () => got++;
  a.m.start('speed');
  wait(1000);
  b.start('speed');
  wait(CALL_MS * 2);
  check(got === 0 && a.got.length === 0, 'two windows of one duelist never duel each other');
  a.m.cancel();
  b.cancel();
  wait(10);
  slots.clear();
}

// ---------- offline, then back ----------
{
  offline = true;
  const a = phone('Net');
  a.m.start('speed');
  wait(100);
  check(a.m.state === 'offline' && a.m.searching, "no connection: it says so and keeps trying");
  offline = false;
  wait(5000);
  check(a.m.state === 'searching' && slots.has(slotId('speed', 0)), 'connection back: waiting in the queue');
  a.m.cancel();
  wait(10);
}

// ---------- a bad offer from a strange phone is refused ----------
{
  const a = phone('Safe');
  let fake: Line | null = null;
  slots.set(slotId('speed', 0), {
    onCall: (l) => {
      fake = l as Line;
      l.onMessage((m) => m.t === 'mm-hi' && l.send({ t: 'mm-offer', room: '<script>', me: { name: 'X', color: 'red', code: 'ZZZZZZ' } }));
    },
  });
  a.m.start('speed');
  wait(CALL_MS + 1000);
  check(!!fake && a.got.length === 0 && a.m.state === 'searching', 'an offer with a broken room code is ignored');
  a.m.cancel();
  slots.clear();
}

console.log(failures ? `\n${failures} FAILED` : '\nall matchmaking checks passed');
if (failures) process.exit(1);
