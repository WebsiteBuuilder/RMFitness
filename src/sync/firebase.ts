import type { GameEvent, LoggedEvent } from './events';
import { AdapterBase, SyncAdapter } from './types';
import { cloudState, denied, onlineDb, type Db } from './cloud';

export const NET_NO_ROOM = 'No room with that code. Check the 4 letters, or create a room.';
export const NET_UNREACHABLE = "Can't reach the online server. Check your Wi-Fi or mobile data.";
export const NET_TAKEN = 'That room code is already in use. Create a new room.';

/** How long a guest looks for a room (the host may still be opening it) before saying it doesn't exist. */
export const FIND_MS = 12_000;
const LOOK_MS = 1_500;
/** How long the first connection gets before the room counts as unreachable. */
const OPEN_MS = 15_000;

type Meta = { host?: string; at?: number } | null;

/**
 * A duel room on the online service, under net/rooms/<CODE>:
 *   meta      who hosts it        hostOn / guestOn  there right now (the server clears them)
 *   ep        rematch number      log/<ep>/<n>      the duel's moves, numbered by the host
 *   in/<key>  moves the guest proposes; the host numbers them into the log
 * Same shape as the phone-to-phone room: the host holds the log, the guest mirrors it. Both
 * phones only ever talk to the server, so it works from any network, and a phone that drops
 * off picks the duel up where it was.
 */
export class FirebaseAdapter extends AdapterBase implements SyncAdapter {
  readonly kind = 'firebase' as const;
  readonly isHost: boolean;
  readonly roomCode: string;
  private db: Db | null = null;
  private unsubs: (() => void)[] = [];
  private logUnsub: (() => void) | null = null;
  private pending: GameEvent[] = [];
  private closed = false;
  private ep = 0;
  private otherHere = false;
  private everLinked = false;
  private online = true;
  private run = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  /** the room is set up: moves go straight out */
  private ready = false;

  constructor(
    roomCode: string,
    isHost: boolean,
    private getDb: () => Promise<Db> = onlineDb,
  ) {
    super();
    this.roomCode = roomCode.toUpperCase();
    this.isHost = isHost;
    this.setStatus('connecting', 'Connecting…');
    void this.start();
  }

  /** Rooms go through the service once this phone has checked it can use it (src/sync/cloud.ts). */
  static available(): boolean {
    return cloudState() === 'on';
  }

  private get base() {
    return `net/rooms/${this.roomCode}`;
  }

  private later(ms: number, fn: () => void) {
    const run = this.run;
    this.timers.push(setTimeout(() => run === this.run && !this.closed && fn(), ms));
  }

  private stopAll() {
    this.run++;
    this.ready = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.logUnsub?.();
    this.logUnsub = null;
  }

  private fail(detail: string) {
    this.stopAll();
    this.setStatus('error', detail);
  }

  retry() {
    if (this.closed) return;
    this.stopAll();
    this.setStatus('connecting', 'Connecting…');
    void this.start();
  }

  private async start() {
    const run = this.run;
    this.later(OPEN_MS, () => !this.db && this.fail(NET_UNREACHABLE));
    let db: Db;
    try {
      db = await this.getDb();
    } catch {
      if (run === this.run) this.fail(NET_UNREACHABLE);
      return;
    }
    if (run !== this.run || this.closed) return;
    this.db = db;
    try {
      if (this.isHost) await this.openAsHost(db);
      else await this.joinAsGuest(db, Date.now());
    } catch (e) {
      if (run !== this.run || this.closed) return;
      this.fail(denied(e) ? (this.isHost ? NET_TAKEN : NET_NO_ROOM) : NET_UNREACHABLE);
    }
  }

  /** Re-announces this phone after the connection comes back. */
  private watchConnection(db: Db, here: string, value: unknown) {
    let first = true;
    this.unsubs.push(
      db.connected((on) => {
        if (this.closed) return;
        this.online = on;
        if (!on) {
          if (!first) this.setStatus('connecting', 'Connection lost. Reconnecting…');
          return;
        }
        first = false;
        void db
          .set(`${this.base}/${here}`, value)
          .then(() => db.onDisconnectRemove(`${this.base}/${here}`))
          .catch(() => {});
        this.showLink();
      }),
    );
  }

  private showLink() {
    if (!this.online) return;
    if (this.otherHere) {
      this.everLinked = true;
      this.setStatus('connected', this.isHost ? 'Opponent connected' : 'Connected to host');
    } else if (this.isHost) this.setStatus('waiting', this.everLinked ? 'Opponent disconnected. Waiting for them to rejoin…' : `Room ${this.roomCode}. Waiting for your opponent…`);
    else this.setStatus('connecting', this.everLinked ? 'Lost the host. Reconnecting…' : `Looking for room ${this.roomCode}…`);
  }

  private async openAsHost(db: Db) {
    const run = this.run;
    let mine = false;
    // a room code is free when nobody hosts it, it's ours, or it's an old one
    const got = await db.transaction(`${this.base}/meta`, (cur) => {
      const m = cur as Meta;
      mine = m?.host === db.uid;
      if (m?.host && !mine && typeof m.at === 'number' && db.serverNow() - m.at < 6 * 3600_000) return undefined;
      return { host: db.uid, at: db.now };
    });
    if (!got) throw Object.assign(new Error('taken'), { code: 'PERMISSION_DENIED' });
    if (!mine) void this.sweep(db);
    if (run !== this.run) return;
    if (mine && this.events.length === 0) {
      // this phone's own room (it dropped off or reloaded): pick the duel up where it was
      this.ep = Number(await db.get(`${this.base}/ep`)) || 0;
      const log = (await db.get(`${this.base}/log/${this.ep}`)) as Record<string, string> | string[] | null;
      const entries = log ? Object.entries(log).sort((a, b) => Number(a[0]) - Number(b[0])) : [];
      this.events = entries.map(([, v]) => JSON.parse(v) as LoggedEvent);
      this.emit();
    } else if (!mine) {
      await Promise.all([db.set(`${this.base}/ep`, this.ep), db.remove(`${this.base}/log`), db.remove(`${this.base}/in`), db.remove(`${this.base}/guestOn`).catch(() => {})]);
    }
    if (run !== this.run) return;
    // events sent before the room was open
    this.ready = true;
    for (const ev of this.pending) this.append(ev);
    this.pending = [];
    this.unsubs.push(
      db.onValue(`${this.base}/guestOn`, (v) => {
        this.otherHere = !!v;
        this.showLink();
      }),
      db.onChildAdded(`${this.base}/in`, (key, v) => {
        void db.remove(`${this.base}/in/${key}`).catch(() => {});
        if (typeof v !== 'string') return;
        try {
          this.append(JSON.parse(v) as GameEvent);
        } catch {
          /* not a move */
        }
      }),
    );
    this.watchConnection(db, 'hostOn', true);
  }

  /** Clears rooms left behind by phones that never came back (older than 6 hours). */
  private async sweep(db: Db) {
    try {
      const rooms = ((await db.get('net/rooms')) ?? {}) as Record<string, { meta?: Meta }>;
      for (const [code, r] of Object.entries(rooms)) {
        const at = r?.meta?.at;
        if (code !== this.roomCode && (typeof at !== 'number' || db.serverNow() - at > 6 * 3600_000)) void db.remove(`net/rooms/${code}`).catch(() => {});
      }
    } catch {
      /* next time */
    }
  }

  private async joinAsGuest(db: Db, since: number) {
    const run = this.run;
    const meta = (await db.get(`${this.base}/meta`)) as Meta;
    if (run !== this.run) return;
    if (!meta?.host) {
      if (Date.now() - since >= FIND_MS) return this.fail(NET_NO_ROOM);
      this.setStatus('connecting', `Looking for room ${this.roomCode}…`);
      this.later(LOOK_MS, () => void this.joinAsGuest(db, since).catch(() => this.fail(NET_UNREACHABLE)));
      return;
    }
    // a room whose host never shows up is an old one
    this.later(FIND_MS, () => !this.everLinked && this.fail(NET_NO_ROOM));
    this.unsubs.push(
      db.onValue(`${this.base}/hostOn`, (v) => {
        this.otherHere = !!v;
        this.showLink();
      }),
      db.onValue(`${this.base}/ep`, (v) => this.followLog(db, Number(v) || 0)),
    );
    this.watchConnection(db, 'guestOn', db.uid);
    this.ready = true;
    for (const ev of this.pending) this.propose(ev);
    this.pending = [];
  }

  /** The guest mirrors the host's log (a new rematch number starts it over). */
  private followLog(db: Db, ep: number) {
    if (ep === this.ep && this.logUnsub) return;
    this.ep = ep;
    this.logUnsub?.();
    this.events = [];
    this.emit();
    this.logUnsub = db.onChildAdded(`${this.base}/log/${ep}`, (_k, v) => {
      if (typeof v !== 'string' || ep !== this.ep) return;
      try {
        const ev = JSON.parse(v) as LoggedEvent;
        if (ev.seq !== this.events.length) return;
        this.events = [...this.events, ev];
        this.emit();
      } catch {
        /* not a move */
      }
    });
  }

  private append(ev: GameEvent) {
    const logged: LoggedEvent = { ...ev, seq: this.events.length, ts: Date.now() };
    this.events = [...this.events, logged];
    this.emit();
    void this.db?.set(`${this.base}/log/${this.ep}/${logged.seq}`, JSON.stringify(logged)).catch(() => {});
  }

  private propose(ev: GameEvent) {
    const db = this.db!;
    const path = `${this.base}/in`;
    void db.set(`${path}/${db.pushKey(path)}`, JSON.stringify(ev)).catch(() => {});
  }

  /** Rematch: the host starts a new log and the guest's phone follows. */
  restart() {
    if (!this.isHost || this.closed || !this.db) return;
    const old = this.ep;
    this.ep++;
    this.events = [];
    this.emit();
    void this.db.set(`${this.base}/ep`, this.ep).catch(() => {});
    void this.db.remove(`${this.base}/log/${old}`).catch(() => {});
  }

  send(ev: GameEvent) {
    if (!this.ready) this.pending.push(ev);
    else if (this.isHost) this.append(ev);
    else this.propose(ev);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopAll();
    const db = this.db;
    if (db) {
      const here = `${this.base}/${this.isHost ? 'hostOn' : 'guestOn'}`;
      void db.cancelOnDisconnect(here).catch(() => {});
      // the host leaving ends the room (the guest sees the host gone, as before)
      void db.remove(this.isHost ? this.base : here).catch(() => {});
    }
    this.listeners.clear();
    this.statusListeners.clear();
  }
}
