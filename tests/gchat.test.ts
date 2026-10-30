// Global chat: the room everyone sees, who is online, and private messages that reach a player
// wherever they are, over an in-memory stand-in for the online service.
// Run: npx tsx tests/gchat.test.ts
import type { Db } from '../src/sync/cloud';
import { RETRY_MS, ALL_KEEP, ALL_SHOW, CONVOS_KEEP, DM_KEEP, emptyGc, GC_MAX, GlobalChat, loadGc, STALE_MS, writeGc, type Clock, type GcData, type GcNote } from '../src/online/globalChat';

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) console.log(`FAIL: ${msg}`);
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
  if (!c) fails++;
};

const NOW = { '.sv': 'now' };
let t = 1_000_000;
let seq = 0;

/** One shared database, many phones. Writes land (and tell listeners) at once. */
class MemServer {
  data: Record<string, unknown> = {};
  valueSubs = new Set<{ path: string; cb: (v: unknown) => void }>();
  childSubs = new Set<{ path: string; cb: (k: string, v: unknown) => void; seen: Set<string> }>();
  dropped = new Map<string, string[]>();
  private parts = (p: string) => p.split('/').filter(Boolean);
  read(p: string): unknown {
    let cur: unknown = this.data;
    for (const k of this.parts(p)) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined;
    return cur === undefined ? null : JSON.parse(JSON.stringify(cur));
  }
  write(p: string, v: unknown) {
    const ks = this.parts(p);
    let cur = this.data as Record<string, unknown>;
    for (const k of ks.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>;
    const fill = (x: unknown): unknown => (x && typeof x === 'object' && (x as { '.sv'?: string })['.sv'] === 'now' ? t : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([a, b]) => [a, fill(b)])) : x);
    if (v === null) delete cur[ks[ks.length - 1]];
    else cur[ks[ks.length - 1]] = fill(v);
    this.tell();
  }
  tell() {
    for (const s of this.valueSubs) s.cb(this.read(s.path));
    for (const s of this.childSubs) {
      const v = this.read(s.path) as Record<string, unknown> | null;
      for (const k of Object.keys(v ?? {}).sort()) if (!s.seen.has(k)) (s.seen.add(k), s.cb(k, v![k]));
    }
  }
  /** a phone's connection drops: what it asked the server to clear goes */
  drop(uid: string) {
    for (const p of this.dropped.get(uid) ?? []) this.write(p, null);
  }
  db(uid: string): Db {
    const sv = this;
    return {
      uid,
      now: NOW,
      serverNow: () => t,
      set: async (p, v) => sv.write(p, v),
      remove: async (p) => sv.write(p, null),
      get: async (p) => sv.read(p),
      pushKey: () => `-k${String(++seq).padStart(6, '0')}`,
      onValue: (path, cb) => {
        const s = { path, cb };
        sv.valueSubs.add(s);
        cb(sv.read(path));
        return () => sv.valueSubs.delete(s);
      },
      onChildAdded: (path, cb, _err, last) => {
        const s = { path, cb, seen: new Set<string>() };
        const v = (sv.read(path) as Record<string, unknown> | null) ?? {};
        const keys = Object.keys(v).sort();
        // (only the newest `last` come in at first; every key after them does)
        for (const k of last ? keys.slice(0, -last) : []) s.seen.add(k);
        sv.childSubs.add(s);
        for (const k of keys) if (!s.seen.has(k)) (s.seen.add(k), cb(k, v[k]));
        return () => sv.childSubs.delete(s);
      },
      onDisconnectRemove: async (p) => void sv.dropped.set(uid, [...(sv.dropped.get(uid) ?? []), p]),
      onDisconnectSet: async () => {},
      cancelOnDisconnect: async (p) => void sv.dropped.set(uid, (sv.dropped.get(uid) ?? []).filter((x) => x !== p)),
      transaction: async () => true,
      connected: (cb) => (cb(true), () => {}),
    };
  }
}

class FakeClock implements Clock {
  timers: { ms: number; fn: () => void; next: number }[] = [];
  every(ms: number, fn: () => void) {
    const x = { ms, fn, next: t + ms };
    this.timers.push(x);
    return () => (this.timers = this.timers.filter((y) => y !== x));
  }
  now() {
    return t;
  }
  advance(ms: number) {
    const end = t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      t = due.next;
      due.next += due.ms;
      due.fn();
    }
    t = end;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function phone(sv: MemServer, code: string, name: string, clock: FakeClock, data: GcData = emptyGc()) {
  const saved: GcData[] = [];
  const notes: GcNote[] = [];
  const gc = new GlobalChat({ db: async () => sv.db(`uid-${code}`), me: { code, name, color: '#3366cc' }, data, save: (d) => saved.push(JSON.parse(JSON.stringify(d))), clock });
  gc.onNote = (n) => notes.push(n);
  gc.start();
  return { gc, saved, notes };
}

async function main() {
  // ---------- who is online ----------
  {
    const sv = new MemServer();
    const clock = new FakeClock();
    const a = phone(sv, 'AAAAAA', 'Jammy', clock);
    const b = phone(sv, 'BBBBBB', 'Bro', clock);
    await tick();
    ok(a.gc.state === 'on' && b.gc.state === 'on', 'both phones go online');
    ok(a.gc.people.length === 1 && a.gc.people[0].name === 'Bro' && a.gc.people[0].doing === 'menu', 'Jammy sees Bro online (and not himself)');
    b.gc.setDoing('duel');
    ok(a.gc.people[0].doing === 'duel', "Bro starting a duel shows as 'In a duel'");
    sv.drop('uid-BBBBBB');
    ok(a.gc.people.length === 0, 'Bro closing the game (connection drops) takes him off the list');
    const c = phone(sv, 'CCCCCC', 'Ghost', clock);
    await tick();
    c.gc.stop();
    ok(a.gc.people.length === 0, 'leaving properly takes a player off the list');
    // an entry that stopped refreshing (a phone that froze without the server noticing) drops off
    sv.write('net/gc/on/DDDDDD', { n: 'Frozen', c: '#123456', d: 'menu', at: t });
    ok(a.gc.people.some((p) => p.code === 'DDDDDD'), 'a fresh entry shows');
    clock.advance(STALE_MS + 31_000);
    ok(!a.gc.people.some((p) => p.code === 'DDDDDD'), 'an entry silent for too long drops off');
    ok(sv.read('net/gc/on/AAAAAA') !== null, 'a phone that stays open keeps refreshing its own entry');
    sv.write('net/gc/on/bad', { n: 'x' });
    sv.write('net/gc/on/EEEEEE', { n: '<b>‮hacker'.repeat(10), c: 'red;background:url(x)', d: 'nonsense', at: t });
    const e = a.gc.people.find((p) => p.code === 'EEEEEE');
    ok(!a.gc.people.some((p) => p.code === 'bad'), 'a junk code is ignored');
    ok(!!e && e.name.length <= 20 && !e.name.includes('‮') && e.color === '#888888' && e.doing === 'menu', 'names, colours and status from others are cleaned');
    a.gc.stop();
  }

  // ---------- the room everyone sees ----------
  {
    const sv = new MemServer();
    const clock = new FakeClock();
    const a = phone(sv, 'AAAAAA', 'Jammy', clock);
    const b = phone(sv, 'BBBBBB', 'Bro', clock);
    await tick();
    clock.advance(1000);
    ok(a.gc.sendAll('  hey   everyone ') === 'sent', 'Jammy says hi to everyone');
    ok(b.gc.all.length === 1 && b.gc.all[0].text === 'hey everyone' && b.gc.all[0].name === 'Jammy', 'Bro sees it, cleaned up');
    ok(b.gc.allUnread() === 1 && a.gc.allUnread() === 0, "it's new for Bro, not for Jammy who said it");
    ok(b.notes.length === 0, 'a room line brings no notice (only private messages do)');
    b.gc.readAll();
    ok(b.gc.allUnread() === 0, 'opening the room reads it');
    ok(a.gc.sendAll('   ') === 'empty', 'nothing to say sends nothing');
    ok(a.gc.sendAll('x'.repeat(500)) === 'sent' && Array.from(b.gc.all[1].text).length === GC_MAX, `a long line is cut to ${GC_MAX}`);
    ok(a.gc.sendAll('3') === 'sent' && a.gc.sendAll('4') === 'sent', 'a few lines in a row go');
    ok(a.gc.sendAll('5') === 'slow', 'a flood is slowed down');
    clock.advance(9000);
    ok(a.gc.sendAll('6') === 'sent', 'after a few seconds lines go again');
    // a third phone opening later gets the newest lines only, and they don't count as new on its first visit
    for (let i = 0; i < ALL_KEEP + 30; i++) {
      clock.advance(9000);
      b.gc.sendAll(`line ${i}`);
    }
    await tick();
    const kept = Object.keys((sv.read('net/gc/all') as object) ?? {}).length;
    ok(kept <= ALL_KEEP + 10, `old room lines are swept (kept ${kept})`);
    const c = phone(sv, 'CCCCCC', 'New', clock);
    await tick();
    ok(c.gc.all.length === ALL_SHOW && c.gc.all[c.gc.all.length - 1].text === `line ${ALL_KEEP + 29}`, `a phone opening the game sees the newest ${ALL_SHOW} lines`);
    ok(c.gc.allUnread() === 0, "on a duelist's first visit the room's history isn't counted as new");
    clock.advance(9000);
    b.gc.sendAll('welcome!');
    ok(c.gc.allUnread() === 1, 'a line after that is new');
    // blocking hides their room lines
    c.gc.block('BBBBBB', true);
    ok(!c.gc.all.some((l) => l.from === 'BBBBBB') && !c.gc.people.some((p) => p.code === 'BBBBBB'), 'blocking someone hides their lines and takes them off the online list');
    clock.advance(9000);
    b.gc.sendAll('still here');
    ok(!c.gc.all.some((l) => l.from === 'BBBBBB'), 'their later lines are dropped as they arrive');
    sv.write(`net/gc/all/zzjunk`, { f: 'nope', t: 'x' });
    ok(!c.gc.all.some((l) => l.id === 'zzjunk'), 'a line under a made-up key (one that would sort above every real line) is ignored');
    sv.write(`net/gc/all/-k999999`, { f: 'DDDDDD', n: 'Clock', t: 'from the future', at: t + 10 ** 9 });
    const fut = c.gc.all.find((l) => l.text === 'from the future');
    ok(!!fut && fut.at <= t, 'a time from the future is pulled back to now');
    c.gc.readAll();
    clock.advance(9000);
    a.gc.sendAll('after that');
    ok(c.gc.allUnread() === 1, 'so later lines still count as new');
    for (const p of [a, b, c]) p.gc.stop();
  }

  // ---------- private messages ----------
  {
    const sv = new MemServer();
    const clock = new FakeClock();
    const a = phone(sv, 'AAAAAA', 'Jammy', clock);
    const b = phone(sv, 'BBBBBB', 'Bro', clock);
    await tick();
    b.gc.setDoing('duel');
    ok(a.gc.sendDm({ code: 'BBBBBB', name: 'Bro', color: '#cc3333' }, 'wanna duel after this?') === 'sent', 'Jammy messages Bro');
    ok(b.notes.length === 1 && b.notes[0].text === 'wanna duel after this?' && b.notes[0].name === 'Jammy', 'Bro gets a notice, even mid-duel');
    ok(b.gc.dmUnread() === 1 && b.gc.data.convos[0].code === 'AAAAAA', 'it waits, unread, in his messages');
    ok(Object.keys((sv.read('net/gc/dm/BBBBBB') as object) ?? {}).length === 0, 'the message is taken out of his mailbox once on his phone');
    ok(a.gc.data.convos[0].lines[0].mine && a.gc.dmUnread() === 0, "Jammy's own copy is kept, not counted as new");
    ok(b.saved.length > 0 && b.saved[b.saved.length - 1].convos[0].lines.length === 1, 'the conversation is saved on the phone');
    b.gc.read('AAAAAA');
    ok(b.gc.dmUnread() === 0, 'opening the conversation reads it');
    b.gc.sendDm({ code: 'AAAAAA', name: 'Jammy', color: '#3366cc' }, 'yes!');
    ok(a.notes.length === 1 && a.gc.data.convos[0].lines.length === 2, 'the reply comes back into the same conversation');
    // a message to someone with the game closed waits for them
    ok(a.gc.sendDm({ code: 'CCCCCC', name: 'Later', color: '#33cc33' }, 'see you later') === 'sent', 'a message to someone offline still goes');
    const c = phone(sv, 'CCCCCC', 'Later', clock);
    await tick();
    ok(c.notes.length === 1 && c.gc.dmUnread() === 1, 'they get it when they next open the game');
    // blocking
    c.gc.block('AAAAAA', true);
    a.gc.sendDm({ code: 'CCCCCC', name: 'Later', color: '#33cc33' }, 'hello??');
    ok(c.notes.length === 1 && !c.gc.data.convos.some((x) => x.code === 'AAAAAA'), 'a blocked player’s messages never show');
    c.gc.block('AAAAAA', false);
    clock.advance(9000);
    a.gc.sendDm({ code: 'CCCCCC', name: 'Later', color: '#33cc33' }, 'ok now?');
    ok(c.notes.length === 2, 'unblocking lets them through again');
    // limits and junk
    ok(a.gc.sendDm({ code: 'AAAAAA', name: 'me', color: '#000000' }, 'me') === 'offline' && a.gc.sendDm({ code: 'bad', name: 'x', color: '#000000' }, 'x') === 'offline', 'no messages to yourself or to a junk code');
    sv.write('net/gc/dm/BBBBBB/zz1', { f: 'BBBBBB', t: 'from myself?' });
    sv.write('net/gc/dm/BBBBBB/zz2', { f: 'AAAAAA', t: '' });
    ok(b.notes.length === 1, 'junk mail (from yourself, or empty) brings no notice');
    for (let i = 0; i < DM_KEEP + 10; i++) {
      clock.advance(9000);
      a.gc.sendDm({ code: 'BBBBBB', name: 'Bro', color: '#cc3333' }, `m${i}`);
    }
    ok(b.gc.data.convos[0].lines.length === DM_KEEP && a.gc.data.convos.find((x) => x.code === 'BBBBBB')!.lines.length === DM_KEEP, `a conversation keeps its newest ${DM_KEEP} lines`);
    for (let i = 0; i < CONVOS_KEEP + 5; i++) {
      clock.advance(9000);
      a.gc.sendDm({ code: `Q${String(i).padStart(5, '0')}`, name: `p${i}`, color: '#000000' }, 'hi');
    }
    ok(a.gc.data.convos.length === CONVOS_KEEP, `at most ${CONVOS_KEEP} conversations are kept`);
    for (const p of [a, b, c]) p.gc.stop();
  }

  // ---------- kept on the phone ----------
  {
    const store = new Map<string, string>();
    const st = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    ok(loadGc('p1', st).convos.length === 0, 'a new duelist starts with no conversations');
    writeGc('p1', { convos: [{ code: 'AAAAAA', name: 'J', color: '#000000', lines: [{ id: 'x', mine: true, text: 'hi', at: 1 }], unread: 0, at: 1 }], blocked: ['ZZZZZZ'], allSeen: 5 }, st);
    const d = loadGc('p1', st);
    ok(d.convos.length === 1 && d.blocked[0] === 'ZZZZZZ' && d.allSeen === 5, 'conversations, blocks and what was read come back');
    ok(loadGc('p2', st).convos.length === 0, 'each duelist has their own');
    store.set('eds.gchat.p3', '{broken');
    ok(loadGc('p3', st).convos.length === 0, 'a broken entry starts over');
  }

  // ---------- the service comes back ----------
  {
    let tries = 0;
    const sv = new MemServer();
    const gc = new GlobalChat({ db: () => (++tries === 1 ? Promise.reject(new Error('slow')) : Promise.resolve(sv.db('x'))), me: { code: 'AAAAAA', name: 'J', color: '#000000' }, data: emptyGc(), save: () => {} });
    gc.start();
    await tick();
    ok(gc.state === 'off', 'a failed sign-in leaves chat offline for now');
    await new Promise((r) => setTimeout(r, RETRY_MS + 50));
    await tick();
    ok(gc.state === 'on' && tries === 2, 'and it tries again by itself');
    gc.stop();
  }

  // ---------- no service ----------
  {
    const gc = new GlobalChat({ db: () => Promise.reject(new Error('no')), me: { code: 'AAAAAA', name: 'J', color: '#000000' }, data: emptyGc(), save: () => {} });
    gc.start();
    await tick();
    ok(gc.state === 'off' && gc.sendAll('hi') === 'offline', 'with no online service nothing pretends to send');
    gc.stop();
  }

  if (fails) {
    console.log(`${fails} global chat check(s) failed`);
    process.exit(1);
  }
  console.log('global chat: all checks passed');
}

void main();
