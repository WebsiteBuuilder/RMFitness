// Online play over the real Firebase code and the real database rules (shared online account), against the Firebase
// emulators (not part of npm test: it needs them running).
// Run: npx firebase emulators:start --only auth,database --project demo-eds   (firebase.json pointing at database.rules.json)
//      npx tsx tests/cloud-emulator.test.ts
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectDatabaseEmulator, get, getDatabase, goOffline, goOnline, ref } from 'firebase/database';
import { makeDb, relaySignIn, type Db } from '../src/sync/cloud';
import { CloudQueue, CloudTransport, Endpoint } from '../src/online/cloudNet';
import { Matchmaker, type Match } from '../src/online/matchmaking';
import { FirebaseAdapter } from '../src/sync/firebase';
import type { Link, Wire } from '../src/online/protocol';
import type { LoggedEvent } from '../src/sync/events';

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) failures++;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(50);
  }
  return fn();
}

let n = 0;
let rawGet: (p: string) => Promise<unknown> = async () => null;
async function phone(): Promise<Db & { off(): void; on(): void }> {
  const app = initializeApp({ apiKey: 'demo-key', projectId: 'demo-eds', databaseURL: 'http://127.0.0.1:9000?ns=demo-eds-default-rtdb' }, `phone${++n}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const database = getDatabase(app);
  connectDatabaseEmulator(database, '127.0.0.1', 9000);
  const relay = await relaySignIn(auth);
  const db = await makeDb(database, `phone${n}-${Math.random().toString(36).slice(2, 8)}`, relay);
  rawGet = async (p) => (await get(ref(database, p))).val();
  return Object.assign(db, { off: () => goOffline(database), on: () => goOnline(database) });
}

const code = () => Math.random().toString(36).slice(2, 8).toUpperCase();

async function main() {
  const a = await phone();
  const b = await phone();

  // ---------- the shared account's entry ----------
  await a.set('net/x', 'hello');
  check((await b.get('net/x')) === 'hello', 'every phone works in the same shared space');
  await b.remove('net/x');
  const list = (await rawGet('duelists')) as Record<string, { alias?: unknown; login?: unknown }>;
  const shown = Object.values(list ?? {}).filter((d) => d && typeof d.login === 'string' && typeof d.alias === 'string');
  check(shown.length === Object.values(list ?? {}).length - 1, 'the shared entry stays off the "Which duelist are you?" list');

  // ---------- friends links ----------
  const ca = code();
  const cb = code();
  const ta = new CloudTransport(async () => a);
  const tb = new CloudTransport(async () => b);
  const states: Record<string, string> = {};
  const incomingA: Link[] = [];
  const unavailable: string[] = [];
  ta.start(ca, { onState: (s) => (states.a = s), onIncoming: (l) => incomingA.push(l), onUnavailable: (c) => unavailable.push(c) });
  tb.start(cb, { onState: (s) => (states.b = s), onIncoming: () => {}, onUnavailable: (c) => unavailable.push(c) });
  check(await until(() => states.a === 'ready' && states.b === 'ready'), 'both phones go online under their friend codes');
  const ghost = code();
  const lg = tb.connect(ghost);
  let ghostClosed = false;
  lg.onClose(() => (ghostClosed = true));
  check(await until(() => ghostClosed && unavailable.includes(ghost)), 'calling a code nobody holds says unavailable');
  const lb = tb.connect(ca);
  let bOpen = false;
  const gotB: Wire[] = [];
  lb.onOpen(() => (bOpen = true));
  lb.onMessage((m) => gotB.push(m));
  check(await until(() => bOpen && incomingA.length === 1), 'a link opens and the other phone hears it');
  const la = incomingA[0];
  check(la.peer === cb, 'the incoming link names the caller');
  const gotA: Wire[] = [];
  la.onMessage((m) => gotA.push(m));
  lb.send({ t: 'activity', activity: { kind: 'menu' } });
  lb.send({ t: 'invite', id: 'i1', room: 'ABCD', game: 'speed' });
  la.send({ t: 'invite-reply', id: 'i1', answer: 'yes' });
  check(await until(() => gotA.length === 2 && gotB.length === 1), 'messages go both ways');
  check(gotA[0].t === 'activity' && gotA[1].t === 'invite', 'in the order sent');
  lb.send({ t: 'ping' });
  let aClosed = false;
  la.onClose(() => (aClosed = true));
  tb.stop();
  check(await until(() => aClosed), "the other phone's link ends when a phone goes offline");
  // name already held: another phone with the same code waits ("elsewhere" later)
  const c2 = await phone();
  const t2 = new CloudTransport(async () => c2);
  t2.start(ca, { onState: (s) => (states.c = s), onIncoming: () => {}, onUnavailable: () => {} });
  await wait(1500);
  check(states.c === 'connecting', 'a second phone with the same duelist waits while the first is online');
  ta.stop();
  check(await until(() => states.c === 'ready', 8000), 'and takes over once the first goes offline');
  t2.stop();

  // ---------- dropping off and coming back ----------
  const cd = code();
  const d = await phone();
  const td = new CloudTransport(async () => d);
  td.start(cd, { onState: (s) => (states.d = s), onIncoming: () => {}, onUnavailable: () => {} });
  await until(() => states.d === 'ready');
  d.off();
  check(await until(() => states.d === 'offline'), 'losing the connection shows offline');
  d.on();
  check(await until(() => states.d === 'ready'), 'and comes back by itself');
  td.stop();

  // ---------- Find a Match ----------
  const matches: Match[] = [];
  const mk = (db: Db, name: string, c: string) => {
    const m = new Matchmaker({ net: () => new CloudQueue(async () => db), me: () => ({ name, color: '#123456', code: c }) });
    m.onMatch = (x) => matches.push(x);
    if (process.env.DBG) m.subscribe(() => console.log(name, m.state, Date.now() % 100000));
    return m;
  };
  const game = `t${Date.now() % 100000}` as never;
  const m1 = mk(a, 'Jammy', code());
  const m2 = mk(b, 'Brother', code());
  m1.start(game);
  await wait(800);
  m2.start(game);
  check(await until(() => matches.length === 2, 15000), 'two phones pressing Find a Match are matched');
  if (matches.length === 2) {
    check(matches[0].room === matches[1].room, 'into the same room');
    check(new Set(matches.map((x) => x.role)).size === 2, 'one hosts, one joins');
    check(matches.some((x) => x.opponent.name === 'Jammy') && matches.some((x) => x.opponent.name === 'Brother'), 'each sees the other');
  }
  // a slot left behind is skipped: hold slot 0 with a phone that never answers
  const ghostEp = new Endpoint(c2, `q-${game}x-0`, (l) => void l);
  await ghostEp.claim();
  matches.length = 0;
  const m3 = mk(a, 'A', code());
  const m4 = mk(b, 'B', code());
  m3.start(`${game}x` as never);
  m4.start(`${game}x` as never);
  check(await until(() => matches.length === 2, 45000), 'a lobby slot held by a silent phone is skipped');
  ghostEp.release();

  // ---------- duel rooms ----------
  const room = 'Q' + code().slice(0, 3);
  const host = new FirebaseAdapter(room, true, async () => a);
  const guest = new FirebaseAdapter(room, false, async () => b);
  let hostLog: LoggedEvent[] = [];
  let guestLog: LoggedEvent[] = [];
  host.subscribe((e) => (hostLog = e));
  guest.subscribe((e) => (guestLog = e));
  check(await until(() => host.status === 'connected' && guest.status === 'connected'), 'host and guest are linked through the room');
  host.send({ type: 'JOIN', seat: 0, name: 'Host', deck: [] } as never);
  guest.send({ type: 'JOIN', seat: 1, name: 'Guest', deck: ['Dark Magician'], extra: [] } as never);
  host.send({ type: 'START' } as never);
  check(await until(() => hostLog.length === 3 && guestLog.length === 3), 'moves from both phones reach both logs');
  check(JSON.stringify(hostLog.map((e) => e.seq)) === '[0,1,2]' && JSON.stringify(guestLog) === JSON.stringify(hostLog), 'both phones see the same numbered log');
  check(Array.isArray((guestLog[0] as unknown as { deck: unknown }).deck), 'empty lists survive the trip');
  host.restart!();
  check(await until(() => guestLog.length === 0 && hostLog.length === 0), 'a rematch empties both logs');
  guest.send({ type: 'X', n: 1 } as never);
  check(await until(() => hostLog.length === 1 && guestLog.length === 1 && guestLog[0].seq === 0), 'and the next duel starts from move one');
  // the guest drops off and comes back: nothing lost
  b.off();
  check(await until(() => host.status === 'waiting', 70000), 'the host sees the guest drop off');
  host.send({ type: 'Y' } as never);
  b.on();
  check(await until(() => host.status === 'connected' && guestLog.length === 2), 'the guest comes back and catches up');
  // a room code that doesn't exist
  const lost = new FirebaseAdapter('ZZZ' + code().slice(0, 1), false, async () => b);
  check(await until(() => lost.status === 'error', 16000) && /No room/.test(lost.detail), "joining a code nobody hosts says there's no such room");
  // someone else's room code
  const clash = new FirebaseAdapter(room, true, async () => c2);
  check(await until(() => clash.status === 'error') && /already in use/.test(clash.detail), "can't host under a code someone is using");
  // the guest reloads while the host is away: the room is still there, with the clock running
  guest.close();
  a.off();
  const back = new FirebaseAdapter(room, false, async () => b);
  let backLog: LoggedEvent[] = [];
  back.subscribe((e) => (backLog = e));
  check(await until(() => backLog.length === 2), 'a guest back after a reload gets the moves');
  await wait(14000);
  check(back.status !== 'error' && /Waiting for them to come back/.test(back.detail), "and waits on the host's clock instead of \"no room\"");
  // the host took the abandoned win meanwhile: the guest is told
  await c2.set(`net/rooms/${room}/left`, 'host-phone');
  check(await until(() => back.status === 'error') && /took the win/.test(back.detail), 'the phone that walked away hears the other took the win');
  back.close();
  a.on();
  host.close();
  lost.close();
  clash.close();

  console.log(failures ? `\n${failures} FAILED` : '\nall cloud checks pass');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
