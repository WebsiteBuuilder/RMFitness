// Global chat over the online service: one room everyone who has the game open can talk in,
// a list of who is online right now, and private messages to any of them. A private message
// lands in the other player's mailbox even while they duel (or later, when they next open the
// game); the screen shows it as a notice wherever they are (OnlineLayer.tsx).
//
// Paths, under the shared online account (src/sync/cloud.ts):
//   net/gc/on/<code>         who is online: name, colour, what they're doing (gone when the phone drops off)
//   net/gc/all/<key>         the room everyone sees (newest ALL_KEEP kept)
//   net/gc/dm/<code>/<key>   private messages waiting for that player (taken out as they arrive)
// Conversations are kept on each phone, per duelist (localStorage), like the friends list.
import type { Db } from '../sync/cloud';
import { cleanChat } from '../eds/session';
import { canSend, SPAM_MS } from '../ui/chatRules';

/** Longest message (a little longer than a duel line: this is for talking, not a bubble over the board). */
export const GC_MAX = 160;
/** The room shows this many of its newest lines; older ones are swept now and then. */
export const ALL_SHOW = 50;
export const ALL_KEEP = 80;
/** A phone says it's still here this often; one silent for STALE_MS is left off the list. */
export const BEAT_MS = 60_000;
export const STALE_MS = 150_000;
/** Lines kept per conversation, and conversations kept. */
export const DM_KEEP = 60;
export const CONVOS_KEEP = 30;
/** After the online service couldn't be reached, chat tries again this long after. */
export const RETRY_MS = 15_000;
/** A room line's key: the service's own push keys (start with "-"), so no phone can pin a line above the others. */
const KEY_RE = /^-[-0-9A-Za-z_]{1,24}$/;

export type Doing = 'menu' | 'room' | 'duel';

export interface GcPerson {
  code: string;
  name: string;
  color: string;
  doing: Doing;
}

/** A line in the room everyone sees. */
export interface GcLine {
  id: string;
  from: string;
  name: string;
  color: string;
  text: string;
  at: number;
}

export interface DmLine {
  id: string;
  mine: boolean;
  text: string;
  at: number;
}

export interface Convo {
  code: string;
  name: string;
  color: string;
  lines: DmLine[];
  unread: number;
  /** newest line (sorts the list) */
  at: number;
}

/** What one duelist keeps on the phone. */
export interface GcData {
  convos: Convo[];
  /** players whose messages (and room lines) this duelist doesn't see */
  blocked: string[];
  /** the newest room line already looked at (server time) */
  allSeen: number;
}

/** A private message just in: shown as a notice on any screen. */
export interface GcNote {
  id: string;
  from: string;
  name: string;
  color: string;
  text: string;
}

export interface GcMe {
  code: string;
  name: string;
  color: string;
}

export type GcState = 'off' | 'connecting' | 'on';

export type SendResult = 'sent' | 'slow' | 'empty' | 'offline';

type Wire = { f?: unknown; n?: unknown; c?: unknown; t?: unknown; at?: unknown; d?: unknown };

const CODE_RE = /^[A-Z0-9]{6}$/;
const cleanName = (n: unknown) => cleanChat(n, 20) || 'Duelist';
const cleanColor = (c: unknown) => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#888888');

export function emptyGc(): GcData {
  return { convos: [], blocked: [], allSeen: 0 };
}

const gcKey = (profileId: string) => `eds.gchat.${profileId}`;

export function loadGc(profileId: string, storage: Pick<Storage, 'getItem'> = localStorage): GcData {
  try {
    const raw = storage.getItem(gcKey(profileId));
    if (raw) {
      const d = JSON.parse(raw) as Partial<GcData>;
      return {
        convos: Array.isArray(d.convos) ? d.convos.filter((c) => c && typeof c.code === 'string' && Array.isArray(c.lines)) : [],
        blocked: Array.isArray(d.blocked) ? d.blocked.filter((b) => typeof b === 'string') : [],
        allSeen: typeof d.allSeen === 'number' ? d.allSeen : 0,
      };
    }
  } catch {
    /* a broken entry starts over */
  }
  return emptyGc();
}

export function writeGc(profileId: string, d: GcData, storage: Pick<Storage, 'setItem'> = localStorage) {
  try {
    storage.setItem(gcKey(profileId), JSON.stringify(d));
  } catch {
    /* storage full or blocked: kept for this visit */
  }
}

export interface Clock {
  every(ms: number, fn: () => void): () => void;
  now(): number;
}
const realClock: Clock = {
  every: (ms, fn) => {
    const h = setInterval(fn, ms);
    return () => clearInterval(h);
  },
  now: () => Date.now(),
};

export interface GlobalChatOptions {
  db: () => Promise<Db>;
  me: GcMe;
  data: GcData;
  save: (d: GcData) => void;
  clock?: Clock;
}

export class GlobalChat {
  state: GcState = 'off';
  me: GcMe;
  data: GcData;
  /** who else is online, by name */
  people: GcPerson[] = [];
  /** the room, oldest first */
  all: GcLine[] = [];
  /** a private message came in (the screen decides whether to show it) */
  onNote: (n: GcNote) => void = () => {};
  private db: Db | null = null;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private unsubs: (() => void)[] = [];
  private listeners = new Set<() => void>();
  private doing: Doing = 'menu';
  private sentAt: number[] = [];
  private sends = 0;
  private rawPeople: Record<string, Wire> = {};
  private clock: Clock;
  /** a duelist's first visit: room lines from before it opened count as already seen */
  private firstVisitFrom = 0;

  constructor(private o: GlobalChatOptions) {
    this.me = o.me;
    this.data = o.data;
    this.clock = o.clock ?? realClock;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed() {
    for (const cb of this.listeners) cb();
  }

  private save() {
    this.o.save(this.data);
  }

  start() {
    if (this.state !== 'off' || this.stopped) return;
    this.state = 'connecting';
    this.changed();
    this.o.db().then(
      (db) => {
        if (this.stopped) return;
        this.db = db;
        this.listen(db);
      },
      () => {
        if (this.stopped) return;
        this.state = 'off';
        this.changed();
        // (a slow or failed sign-in: try again in a while, as the rest of online play does)
        this.retry = setTimeout(() => this.start(), RETRY_MS);
      },
    );
  }

  private onPath() {
    return `net/gc/on/${this.me.code}`;
  }

  private listen(db: Db) {
    const code = this.me.code;
    const beat = () => {
      if (this.stopped) return;
      void db.set(this.onPath(), { n: this.me.name, c: this.me.color, d: this.doing, at: db.now }).catch(() => {});
    };
    void db.onDisconnectRemove(this.onPath()).catch(() => {});
    beat();
    this.unsubs.push(this.clock.every(BEAT_MS, beat));
    // (back online after a drop: the server cleared this phone's entry, so it goes up again)
    let wasOn = true;
    this.unsubs.push(
      db.connected((on) => {
        if (on && !wasOn) {
          void db.onDisconnectRemove(this.onPath()).catch(() => {});
          beat();
        }
        wasOn = on;
      }),
    );
    this.unsubs.push(
      db.onValue(`net/gc/on`, (v) => {
        this.rawPeople = v && typeof v === 'object' ? (v as Record<string, Wire>) : {};
        this.readPeople();
      }),
    );
    // (an entry gone quiet drops off the list even when nothing else changes)
    this.unsubs.push(this.clock.every(30_000, () => this.readPeople()));
    if (!this.data.allSeen) this.firstVisitFrom = db.serverNow();
    this.unsubs.push(db.onChildAdded(`net/gc/all`, (key, v) => this.roomLine(key, v as Wire), undefined, ALL_SHOW));
    this.unsubs.push(db.onChildAdded(`net/gc/dm/${code}`, (key, v) => this.dmIn(db, key, v as Wire)));
    this.state = 'on';
    this.changed();
  }

  private readPeople() {
    const db = this.db;
    if (!db) return;
    const now = db.serverNow();
    const list: GcPerson[] = [];
    for (const [code, w] of Object.entries(this.rawPeople)) {
      if (code === this.me.code || !CODE_RE.test(code) || !w) continue;
      if (typeof w.at === 'number' && now - w.at > STALE_MS) continue;
      if (this.data.blocked.includes(code)) continue;
      const doing: Doing = w.d === 'duel' || w.d === 'room' ? w.d : 'menu';
      list.push({ code, name: cleanName(w.n), color: cleanColor(w.c), doing });
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    const same = list.length === this.people.length && list.every((p, i) => JSON.stringify(p) === JSON.stringify(this.people[i]));
    if (same) return;
    this.people = list;
    this.changed();
  }

  private roomLine(key: string, w: Wire) {
    if (!KEY_RE.test(key) || !w || typeof w.f !== 'string' || !CODE_RE.test(w.f) || this.data.blocked.includes(w.f)) return;
    const text = cleanChat(w.t, GC_MAX);
    if (!text || this.all.some((l) => l.id === key)) return;
    // (a time from the future, from a phone with a broken clock or worse, would hide every later line's badge)
    const now = this.db?.serverNow() ?? this.clock.now();
    const at = typeof w.at === 'number' && Number.isFinite(w.at) ? Math.min(w.at, now) : now;
    const line: GcLine = { id: key, from: w.f, name: cleanName(w.n), color: cleanColor(w.c), text, at };
    // (keys sort by time: a line can still arrive out of order after a reconnect)
    this.all = [...this.all, line].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(-ALL_SHOW);
    if ((line.from === this.me.code || line.at <= this.firstVisitFrom) && line.at > this.data.allSeen) this.data.allSeen = line.at;
    this.changed();
  }

  private dmIn(db: Db, key: string, w: Wire) {
    void db.remove(`net/gc/dm/${this.me.code}/${key}`).catch(() => {});
    if (!w || typeof w.f !== 'string' || !CODE_RE.test(w.f) || w.f === this.me.code) return;
    if (this.data.blocked.includes(w.f)) return;
    const text = cleanChat(w.t, GC_MAX);
    if (!text) return;
    const name = cleanName(w.n);
    const color = cleanColor(w.c);
    const now = db.serverNow();
    const at = typeof w.at === 'number' && Number.isFinite(w.at) ? Math.min(w.at, now) : now;
    const c = this.convo(w.f, name, color);
    if (c.lines.some((l) => l.id === key)) return;
    c.name = name;
    c.color = color;
    c.lines = [...c.lines, { id: key, mine: false, text, at }].slice(-DM_KEEP);
    c.unread++;
    c.at = Math.max(c.at, at);
    this.tidy();
    this.save();
    this.changed();
    this.onNote({ id: key, from: w.f, name, color, text });
  }

  private convo(code: string, name: string, color: string): Convo {
    let c = this.data.convos.find((x) => x.code === code);
    if (!c) {
      c = { code, name, color, lines: [], unread: 0, at: 0 };
      this.data.convos = [c, ...this.data.convos];
    }
    return c;
  }

  private tidy() {
    this.data.convos = [...this.data.convos].sort((a, b) => b.at - a.at).slice(0, CONVOS_KEEP);
  }

  private rate(): boolean {
    const now = this.clock.now();
    if (!canSend(this.sentAt, now)) return false;
    this.sentAt = [...this.sentAt.filter((t) => now - t < SPAM_MS), now];
    return true;
  }

  /** Says something in the room everyone sees. */
  sendAll(raw: string): SendResult {
    const text = cleanChat(raw, GC_MAX);
    if (!text) return 'empty';
    const db = this.db;
    if (!db || this.state !== 'on') return 'offline';
    if (!this.rate()) return 'slow';
    const key = db.pushKey('net/gc/all');
    void db.set(`net/gc/all/${key}`, { f: this.me.code, n: this.me.name, c: this.me.color, t: text, at: db.now }).catch(() => {});
    if (++this.sends % 10 === 1) void this.sweep(db);
    return 'sent';
  }

  /** Keeps the room to its newest ALL_KEEP lines. */
  private async sweep(db: Db) {
    try {
      const all = (await db.get('net/gc/all')) as Record<string, unknown> | null;
      if (!all) return;
      const keys = Object.keys(all).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - ALL_KEEP))) void db.remove(`net/gc/all/${k}`).catch(() => {});
    } catch {
      /* next time */
    }
  }

  /** A private message to one player (online now, or waiting for them until they next open the game). */
  sendDm(to: { code: string; name: string; color: string }, raw: string): SendResult {
    const text = cleanChat(raw, GC_MAX);
    if (!text) return 'empty';
    const db = this.db;
    if (!db || this.state !== 'on' || !CODE_RE.test(to.code) || to.code === this.me.code) return 'offline';
    if (!this.rate()) return 'slow';
    const key = db.pushKey(`net/gc/dm/${to.code}`);
    void db.set(`net/gc/dm/${to.code}/${key}`, { f: this.me.code, n: this.me.name, c: this.me.color, t: text, at: db.now }).catch(() => {});
    const c = this.convo(to.code, to.name, to.color);
    const at = this.clock.now();
    c.lines = [...c.lines, { id: key, mine: true, text, at }].slice(-DM_KEEP);
    c.at = Math.max(c.at, at);
    this.tidy();
    this.save();
    this.changed();
    return 'sent';
  }

  /** The conversation is on screen: nothing in it is new any more. */
  read(code: string) {
    const c = this.data.convos.find((x) => x.code === code);
    if (!c || !c.unread) return;
    c.unread = 0;
    this.save();
    this.changed();
  }

  /** The room is on screen. */
  readAll() {
    // (the newest time, not the last key: a line under an odd key can't hold the badge back)
    const newest = Math.max(0, ...this.all.map((l) => l.at));
    if (newest <= this.data.allSeen) return;
    this.data.allSeen = newest;
    this.save();
    this.changed();
  }

  /** Room lines from others not looked at yet. */
  allUnread(): number {
    return this.all.filter((l) => l.from !== this.me.code && l.at > this.data.allSeen).length;
  }

  dmUnread(): number {
    return this.data.convos.reduce((n, c) => n + c.unread, 0);
  }

  isOnline(code: string): boolean {
    return this.people.some((p) => p.code === code);
  }

  block(code: string, on: boolean) {
    const b = this.data.blocked.filter((x) => x !== code);
    this.data.blocked = on ? [...b, code] : b;
    if (on) {
      this.data.convos = this.data.convos.filter((c) => c.code !== code);
      this.all = this.all.filter((l) => l.from !== code);
    }
    this.save();
    this.readPeople();
    this.changed();
  }

  /** Blocked players, with the names they last had, to unblock from Messages. */
  blockedList(): string[] {
    return this.data.blocked;
  }

  forget(code: string) {
    this.data.convos = this.data.convos.filter((c) => c.code !== code);
    this.save();
    this.changed();
  }

  /** What friends and everyone else see this player doing. */
  setDoing(d: Doing) {
    if (d === this.doing) return;
    this.doing = d;
    const db = this.db;
    if (db && this.state === 'on') void db.set(this.onPath(), { n: this.me.name, c: this.me.color, d, at: db.now }).catch(() => {});
  }

  setMe(me: GcMe) {
    if (me.name === this.me.name && me.color === this.me.color) return;
    this.me = { ...me, code: this.me.code };
    const db = this.db;
    if (db && this.state === 'on') void db.set(this.onPath(), { n: me.name, c: me.color, d: this.doing, at: db.now }).catch(() => {});
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.retry);
    for (const u of this.unsubs) u();
    this.unsubs = [];
    const db = this.db;
    if (db) {
      void db.cancelOnDisconnect(this.onPath()).catch(() => {});
      void db.remove(this.onPath()).catch(() => {});
    }
    this.state = 'off';
    this.listeners.clear();
  }
}
