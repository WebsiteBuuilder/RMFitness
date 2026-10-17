// The online service: Firebase's Realtime Database, reached by every phone over the same
// secure web connection any website uses, so two phones find each other on any Wi-Fi or
// mobile data. Friends, Find a Match and duel rooms all go through it (src/online/cloudNet.ts,
// src/sync/firebase.ts), apart from whichever duelist is logged in.
//
// It runs on the database rules the shared accounts already have: every phone signs in to one
// shared online account and works under that account's entry, duelists/<its id>/n/ (the
// duelist list skips it: its name fields aren't text). Each phone tells itself apart by its own
// id. Values are stored as JSON text, so empty lists and missing fields come back as sent.
import type { Auth } from 'firebase/auth';
import type { Database } from 'firebase/database';
import { firebaseConfig } from './firebaseConfig';

/** The few database calls the online code needs: Firebase on phones, an in-memory copy in tests. */
export interface Db {
  /** this phone's id */
  readonly uid: string;
  set(path: string, value: unknown): Promise<void>;
  remove(path: string): Promise<void>;
  get(path: string): Promise<unknown>;
  /** a key that sorts after every key made before it */
  pushKey(path: string): string;
  onValue(path: string, cb: (v: unknown) => void, err?: (e: Error) => void): () => void;
  onChildAdded(path: string, cb: (key: string, v: unknown) => void, err?: (e: Error) => void): () => void;
  /** the server removes (or sets) this path if this phone drops off */
  onDisconnectRemove(path: string): Promise<void>;
  onDisconnectSet(path: string, value: unknown): Promise<void>;
  cancelOnDisconnect(path: string): Promise<void>;
  /** changes a value only if `fn` returns one (undefined leaves it); true when it changed */
  transaction(path: string, fn: (cur: unknown) => unknown): Promise<boolean>;
  /** follows this phone's connection to the server */
  connected(cb: (on: boolean) => void): () => void;
  /** stands for "the server's clock" in a value */
  readonly now: unknown;
  /** the server's clock as best this phone knows it */
  serverNow(): number;
}

/** The service said no (the database rules don't allow it yet). */
export const denied = (e: unknown) => /permission/i.test(String((e as { code?: string })?.code ?? '') + String((e as Error)?.message ?? e));

/** `?emu=host`: the Firebase emulators on that host instead of the real service (tests). */
function emulatorHost(): string | null {
  return typeof location !== 'undefined' ? new URLSearchParams(location.search).get('emu') : null;
}

let ready: Promise<Db> | null = null;

/** Signs this phone in and opens the database (once). */
export function cloudDb(): Promise<Db> {
  ready ??= open().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

/** The phone's own Firebase app: shared with profile backups (src/accounts/firebaseBackend.ts). */
export async function phoneApp() {
  if (!firebaseConfig) throw new Error('no online service configured');
  const { initializeApp, getApps } = await import('firebase/app');
  const { getAuth, connectAuthEmulator } = await import('firebase/auth');
  const { getDatabase, connectDatabaseEmulator } = await import('firebase/database');
  const old = getApps().find((a) => a.name === 'eds-backup');
  const app = old ?? initializeApp(firebaseConfig, 'eds-backup');
  const auth = getAuth(app);
  const db = getDatabase(app);
  const emu = emulatorHost();
  if (emu && !old) {
    connectAuthEmulator(auth, `http://${emu}:9099`, { disableWarnings: true });
    connectDatabaseEmulator(db, emu, 9000);
  }
  return { app, auth, db };
}

let signingIn: Promise<string> | null = null;

/** This phone's anonymous account, made the first time it's needed. */
export async function phoneUid(): Promise<string> {
  const { auth } = await phoneApp();
  signingIn ??= (async () => {
    const { signInAnonymously } = await import('firebase/auth');
    await auth.authStateReady();
    return auth.currentUser?.uid ?? (await signInAnonymously(auth)).user.uid;
  })().catch((e) => {
    signingIn = null;
    throw e;
  });
  return signingIn;
}

/**
 * The shared account every phone signs in to for online play. Jammy chose this (2026-10-17)
 * over changing the database rules in the Firebase console: it needs no setup, and it can only
 * reach its own entry in the duelist list (duelists/<its id>), where online play lives.
 */
export const RELAY_LOGIN = 'online-relay@duelist.eds-remake.app';
const RELAY_KEY = 'eds-relay:speed-duel-online-v1';

/** This phone's own id for online play (kept on the phone). */
function phoneId(): string {
  const make = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  try {
    let id = localStorage.getItem('eds.netid');
    if (!id) {
      id = make();
      localStorage.setItem('eds.netid', id);
    }
    return id;
  } catch {
    return make();
  }
}

/** Signs a Firebase app in to the shared online account, making it the first time. Returns its id. */
export async function relaySignIn(auth: Auth): Promise<string> {
  const { signInWithEmailAndPassword, createUserWithEmailAndPassword } = await import('firebase/auth');
  await auth.authStateReady();
  if (auth.currentUser?.email === RELAY_LOGIN) return auth.currentUser.uid;
  const code = (e: unknown) => String((e as { code?: string })?.code ?? '');
  try {
    return (await signInWithEmailAndPassword(auth, RELAY_LOGIN, RELAY_KEY)).user.uid;
  } catch (e) {
    if (!/user-not-found|invalid-credential|invalid-login/.test(code(e))) throw e;
  }
  try {
    return (await createUserWithEmailAndPassword(auth, RELAY_LOGIN, RELAY_KEY)).user.uid;
  } catch (e) {
    // another phone made it a moment ago
    if (code(e).includes('email-already-in-use')) return (await signInWithEmailAndPassword(auth, RELAY_LOGIN, RELAY_KEY)).user.uid;
    throw e;
  }
}

async function open(): Promise<Db> {
  if (!firebaseConfig) throw new Error('no online service configured');
  const { initializeApp, getApps } = await import('firebase/app');
  const { getAuth, connectAuthEmulator } = await import('firebase/auth');
  const { getDatabase, connectDatabaseEmulator } = await import('firebase/database');
  const old = getApps().find((a) => a.name === 'eds-online');
  const app = old ?? initializeApp(firebaseConfig, 'eds-online');
  const auth = getAuth(app);
  const db = getDatabase(app);
  const emu = emulatorHost();
  if (emu && !old) {
    connectAuthEmulator(auth, `http://${emu}:9099`, { disableWarnings: true });
    connectDatabaseEmulator(db, emu, 9000);
  }
  return makeDb(db, phoneId(), await relaySignIn(auth));
}

/**
 * The online calls over one Firebase database. Paths starting net/ land under the shared
 * account's entry, duelists/<relay>/n/ (made ready here); `uid` is this phone's id.
 */
export async function makeDb(db: Database, uid: string, relay: string): Promise<Db> {
  const fb = await import('firebase/database');
  const home = `duelists/${relay}`;
  // the duelists rules want these two fields on every entry; numbers keep it off the duelist list
  await fb.update(fb.ref(db, home), { alias: 0, login: 0 });
  let offset = 0;
  fb.onValue(fb.ref(db, '.info/serverTimeOffset'), (s) => (offset = Number(s.val()) || 0));
  const r = (p: string) => fb.ref(db, p.startsWith('net/') ? `${home}/n/${p.slice(4)}` : p);
  return {
    uid,
    now: fb.serverTimestamp(),
    serverNow: () => Date.now() + offset,
    set: (p, v) => fb.set(r(p), v),
    remove: (p) => fb.remove(r(p)),
    get: async (p) => (await fb.get(r(p))).val(),
    pushKey: (p) => fb.push(r(p)).key!,
    onValue: (p, cb, err) => fb.onValue(r(p), (s) => cb(s.val()), err),
    onChildAdded: (p, cb, err) => fb.onChildAdded(r(p), (s) => cb(s.key!, s.val()), err),
    onDisconnectRemove: (p) => fb.onDisconnect(r(p)).remove(),
    onDisconnectSet: (p, v) => fb.onDisconnect(r(p)).set(v),
    cancelOnDisconnect: (p) => fb.onDisconnect(r(p)).cancel(),
    transaction: async (p, fn) => (await fb.runTransaction(r(p), (cur) => fn(cur), { applyLocally: false })).committed,
    connected: (cb) => fb.onValue(r('.info/connected'), (s) => cb(s.val() === true)),
  };
}

export type CloudState = 'unknown' | 'checking' | 'on' | 'off';

let state: CloudState = firebaseConfig ? 'unknown' : 'off';
let check: Promise<CloudState> | null = null;
const stateListeners = new Set<(s: CloudState) => void>();
/** tests: pretend the service is (or isn't) there */
let forced: { db: () => Promise<Db> } | null = null;

export function cloudState(): CloudState {
  return state;
}

export function onCloudState(cb: (s: CloudState) => void): () => void {
  stateListeners.add(cb);
  return () => stateListeners.delete(cb);
}

function setState(s: CloudState) {
  if (s === state) return;
  state = s;
  for (const cb of stateListeners) cb(s);
}

/** The database for online play (tests can stand in their own). */
export function onlineDb(): Promise<Db> {
  return forced ? forced.db() : cloudDb();
}

export function useTestDb(db: (() => Promise<Db>) | null) {
  forced = db ? { db } : null;
  state = db ? 'on' : firebaseConfig ? 'unknown' : 'off';
  check = null;
}

/** How long the first sign-in and test write get before the phone falls back to the old phone-to-phone links. */
const CHECK_MS = 12_000;

/**
 * Finds out once whether online play can go through the service: signs this phone in and
 * makes one test write. 'off' when there's no config or the service can't be reached in
 * time (asked again later): the phone then uses the older phone-to-phone links.
 */
export function checkCloud(): Promise<CloudState> {
  if (state === 'on' || (state === 'off' && !firebaseConfig)) return Promise.resolve(state);
  check ??= (async (): Promise<CloudState> => {
    setState('checking');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'slow'>((res) => (timer = setTimeout(() => res('slow'), CHECK_MS)));
    const attempt = (async () => {
      const db = await onlineDb();
      const probe = `net/probe/${db.uid.slice(0, 20)}`;
      await db.set(probe, { uid: db.uid, at: db.now });
      await db.remove(probe);
      return 'ok' as const;
    })();
    try {
      const r = await Promise.race([attempt, timeout]);
      return r === 'ok' ? 'on' : 'off';
    } catch (e) {
      if (!denied(e)) console.warn('online service:', e);
      return 'off';
    } finally {
      clearTimeout(timer);
    }
  })().then((s) => {
    setState(s);
    // a failed check is tried again the next time someone asks
    if (s !== 'on') check = null;
    return s;
  });
  return check;
}
