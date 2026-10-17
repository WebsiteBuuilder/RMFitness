// Friends and Find a Match over the online service (src/sync/cloud.ts) instead of
// phone-to-phone links, so two phones reach each other from any network.
//
// An "endpoint" is a name a phone answers to: its friend code, a Find a Match lobby slot, or a
// throwaway name for calling one. Holding it means owning net/who/<name> (the server clears it
// when the phone drops off); messages to it are dropped in net/mail/<name>, which only its
// holder can read. A link is a conversation between two endpoints, carried as mail.
import type { Db } from '../sync/cloud';
import { denied, onlineDb } from '../sync/cloud';
import type { Link, Transport, TransportHandlers, Wire } from './protocol';
import type { HoldResult, MmLink, MmNet, MmWire } from './matchmaking';

type Mail = { uid: string; from: string; k: 'open' | 'msg' | 'close'; link: string; m?: string; at?: unknown };

/** The holder refreshes its name this often, so a name left behind goes stale (the rules free it after 2 minutes). */
export const BEAT_MS = 50_000;
/** A friend link hears a "ping" this often while the other phone is online (nothing is sent: the server knows). */
export const LIVE_MS = 8_000;

export interface Clock {
  every(ms: number, fn: () => void): () => void;
}
const realClock: Clock = {
  every: (ms, fn) => {
    const h = setInterval(fn, ms);
    return () => clearInterval(h);
  },
};

const rand = () => Math.random().toString(36).slice(2, 10);

type Who = { uid?: string } | null;

/** One conversation with another endpoint. Works as a friends Link and a matchmaking MmLink. */
export class CloudLink<T extends { t: string }> {
  private openCbs: (() => void)[] = [];
  private msgCbs: ((m: T) => void)[] = [];
  private closeCbs: (() => void)[] = [];
  private opened = false;
  private closed = false;
  private unwatch: (() => void) | null = null;
  private stopLive: (() => void) | null = null;
  /** sends wait for the link to be set up */
  private chain: Promise<unknown>;

  constructor(
    private ep: Endpoint,
    readonly peer: string,
    readonly id: string,
    readonly outgoing: boolean,
    /** friend links: "ping" stands for "still online", known from the server instead of sent */
    private live: T | null,
    onUnavailable?: () => void,
  ) {
    this.chain = outgoing ? this.dial(onUnavailable) : Promise.resolve(this.watch(undefined));
    if (!outgoing) this.opened = true;
  }

  private async dial(onUnavailable?: () => void) {
    try {
      await this.ep.held;
      const who = (await this.ep.db.get(`net/who/${this.peer}`)) as Who;
      if (this.closed) return;
      if (!who?.uid) {
        onUnavailable?.();
        return this.end();
      }
      await this.ep.post(this.peer, { k: 'open', link: this.id });
      if (this.closed) return;
      this.watch(who.uid);
      this.opened = true;
      for (const cb of this.openCbs) cb();
    } catch {
      this.end();
    }
  }

  /** Follows the other phone: the link ends the moment its name is gone or taken by another phone. */
  private watch(uid: string | undefined) {
    let first = uid;
    this.unwatch = this.ep.db.onValue(
      `net/who/${this.peer}`,
      (v) => {
        const w = v as Who;
        if (!w?.uid) return this.end();
        first ??= w.uid;
        if (w.uid !== first) this.end();
      },
      () => this.end(),
    );
    if (this.live) {
      const ping = this.live;
      this.stopLive = this.ep.clock.every(LIVE_MS, () => {
        if (this.opened && !this.closed) for (const cb of this.msgCbs) cb(ping);
      });
    }
  }

  send(m: T) {
    if (this.closed || (this.live && m.t === this.live.t)) return;
    const text = JSON.stringify(m);
    this.chain = this.chain.then(() => (this.closed || !this.opened ? undefined : this.ep.post(this.peer, { k: 'msg', link: this.id, m: text }).catch(() => this.end())));
  }

  close() {
    if (this.closed) return;
    if (this.opened) void this.ep.post(this.peer, { k: 'close', link: this.id }).catch(() => {});
    this.end();
  }

  /** Mail for this link arrived. */
  deliver(raw: string) {
    if (this.closed) return;
    let m: T;
    try {
      m = JSON.parse(raw) as T;
    } catch {
      return;
    }
    if (m && typeof m === 'object' && typeof m.t === 'string') for (const cb of this.msgCbs) cb(m);
  }

  /** Ends without telling the other side (it's gone, or it ended the link). */
  end() {
    if (this.closed) return;
    this.closed = true;
    this.unwatch?.();
    this.stopLive?.();
    this.ep.forget(this as unknown as CloudLink<{ t: string }>);
    for (const cb of this.closeCbs) cb();
  }

  onOpen(cb: () => void) {
    if (this.opened) queueMicrotask(() => !this.closed && cb());
    else this.openCbs.push(cb);
  }
  onMessage(cb: (m: T) => void) {
    this.msgCbs.push(cb);
  }
  onClose(cb: () => void) {
    if (this.closed) queueMicrotask(cb);
    else this.closeCbs.push(cb);
  }
}

export type HoldState = 'held' | 'taken' | 'lost';

/** A name this phone answers to. */
export class Endpoint {
  /** settles once the name is first held (rejects if it was never held) */
  held: Promise<void>;
  private resolveHeld!: () => void;
  private rejectHeld!: (e: unknown) => void;
  isHeld = false;
  private links = new Map<string, CloudLink<{ t: string }>>();
  private unsubs: (() => void)[] = [];
  private stopBeat: (() => void) | null = null;
  private released = false;
  private wasConnected = true;

  constructor(
    readonly db: Db,
    readonly id: string,
    private onIncoming: (l: CloudLink<{ t: string }>) => void,
    /** holding changed: got it, someone else has it, or lost it (connection or takeover) */
    private onHold: (s: HoldState) => void = () => {},
    readonly clock: Clock = realClock,
    private live: { t: string } | null = null,
  ) {
    this.held = new Promise((res, rej) => ((this.resolveHeld = res), (this.rejectHeld = rej)));
    this.held.catch(() => {});
    this.unsubs.push(
      db.connected((on) => {
        if (this.released) return;
        if (!on) {
          this.wasConnected = false;
          if (this.isHeld) this.lose();
        } else if (!this.wasConnected) {
          this.wasConnected = true;
          void this.claim();
        }
      }),
    );
  }

  private lose() {
    this.isHeld = false;
    this.stopMail?.();
    this.stopMail = null;
    for (const l of [...this.links.values()]) l.end();
    this.onHold('lost');
  }

  private stopMail: (() => void) | null = null;

  /** Tries to take the name. */
  async claim(): Promise<HoldState> {
    if (this.released) return 'lost';
    if (this.isHeld) return 'held';
    const path = `net/who/${this.id}`;
    try {
      await this.db.set(path, { uid: this.db.uid, at: this.db.now });
    } catch (e) {
      if (denied(e)) {
        this.onHold('taken');
        return 'taken';
      }
      throw e;
    }
    if (this.released) {
      void this.db.remove(path).catch(() => {});
      return 'lost';
    }
    await this.db.onDisconnectRemove(path).catch(() => {});
    // whatever was left for an earlier holder is stale
    await this.db.remove(`net/mail/${this.id}`).catch(() => {});
    this.isHeld = true;
    this.stopMail?.();
    this.stopMail = this.db.onChildAdded(
      `net/mail/${this.id}`,
      (key, v) => this.mail(key, v as Mail),
      () => this.isHeld && this.lose(),
    );
    this.stopBeat?.();
    this.stopBeat = this.clock.every(BEAT_MS, () => {
      if (this.isHeld) this.db.set(path, { uid: this.db.uid, at: this.db.now }).catch((e) => denied(e) && this.isHeld && this.lose());
    });
    this.resolveHeld();
    this.onHold('held');
    return 'held';
  }

  private mail(key: string, m: Mail) {
    void this.db.remove(`net/mail/${this.id}/${key}`).catch(() => {});
    if (!m || typeof m.link !== 'string' || typeof m.from !== 'string') return;
    if (m.k === 'open') {
      if (this.links.has(m.link)) return;
      const l = new CloudLink(this, m.from, m.link, false, this.live);
      this.links.set(m.link, l);
      this.onIncoming(l);
    } else if (m.k === 'msg' && typeof m.m === 'string') this.links.get(m.link)?.deliver(m.m);
    else if (m.k === 'close') this.links.get(m.link)?.end();
  }

  /** Drops a message in another endpoint's mail. */
  post(to: string, m: Omit<Mail, 'uid' | 'from'>): Promise<void> {
    const path = `net/mail/${to}`;
    return this.db.set(`${path}/${this.db.pushKey(path)}`, { ...m, uid: this.db.uid, from: this.id, at: this.db.now });
  }

  connect<T extends { t: string }>(to: string, onUnavailable?: () => void): CloudLink<T> {
    const l = new CloudLink<T>(this, to, `${this.id}.${rand()}`, true, this.live as T | null, onUnavailable);
    this.links.set(l.id, l as unknown as CloudLink<{ t: string }>);
    return l;
  }

  forget(l: CloudLink<{ t: string }>) {
    if (this.links.get(l.id) === l) this.links.delete(l.id);
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.rejectHeld(new Error('released'));
    for (const l of [...this.links.values()]) l.close();
    for (const u of this.unsubs) u();
    this.stopMail?.();
    this.stopBeat?.();
    if (this.isHeld) {
      this.isHeld = false;
      const path = `net/who/${this.id}`;
      void this.db.cancelOnDisconnect(path).catch(() => {});
      void this.db.remove(path).catch(() => {});
    }
  }
}

/** How long "that code is in use" lasts before the phone says the duelist is open on another phone. */
export const ELSEWHERE_MS = 75_000;
const RETRY_MS = 4_000;

/** Friends over the online service: this phone answers to its friend code. */
export class CloudTransport implements Transport {
  private ep: Endpoint | null = null;
  private h: TransportHandlers | null = null;
  private stopped = false;
  private takenSince = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private trying = false;

  constructor(
    private db: () => Promise<Db> = onlineDb,
    private clock?: Clock,
  ) {}

  start(code: string, h: TransportHandlers) {
    this.h = h;
    h.onState('connecting');
    void this.db().then(
      (db) => {
        if (this.stopped) return;
        this.ep = new Endpoint(db, code, (l) => h.onIncoming(l as unknown as Link), (s) => this.hold(s), this.clock, { t: 'ping' });
        void this.tryClaim();
      },
      () => {
        h.onState('offline');
        this.later();
      },
    );
  }

  private later() {
    if (this.retry || this.stopped) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.ep) return this.h && this.start(this.codeOf(), this.h);
      void this.tryClaim();
    }, RETRY_MS);
  }

  private codeOf() {
    return this.ep?.id ?? '';
  }

  private async tryClaim() {
    if (!this.ep || this.stopped || this.trying || this.ep.isHeld) return;
    this.trying = true;
    try {
      await this.ep.claim();
    } catch {
      this.h?.onState('offline');
      this.later();
    } finally {
      this.trying = false;
    }
  }

  private hold(s: HoldState) {
    const h = this.h;
    if (!h || this.stopped) return;
    if (s === 'held') {
      this.takenSince = 0;
      h.onState('ready');
    } else if (s === 'taken') {
      const t = Date.now();
      if (!this.takenSince) this.takenSince = t;
      h.onState(t - this.takenSince > ELSEWHERE_MS ? 'elsewhere' : 'connecting');
      this.later();
    } else {
      h.onState('offline');
      this.later();
    }
  }

  connect(code: string): Link {
    if (!this.ep) {
      // not set up yet: a link that ends at once (the friends code dials again later)
      const dead = { peer: code, outgoing: true, send() {}, close() {}, onOpen() {}, onMessage() {}, onClose: (cb: () => void) => queueMicrotask(cb) };
      return dead as Link;
    }
    return this.ep.connect<Wire>(code, () => this.h?.onUnavailable(code)) as unknown as Link;
  }

  wake() {
    if (this.stopped) return;
    if (!this.ep) return;
    if (!this.ep.isHeld) void this.tryClaim();
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.ep?.release();
    this.ep = null;
  }
}

/** How long holding a lobby slot may take before the phone counts as offline. */
const HOLD_MS = 10_000;

/** Find a Match over the online service: lobby slots are names anyone can try to hold. */
export class CloudQueue implements MmNet {
  private eps = new Set<Endpoint>();
  private caller: Endpoint | null = null;
  private stopped = false;
  private dbp: Promise<Db>;

  constructor(db: () => Promise<Db> = onlineDb) {
    this.dbp = db();
    this.dbp.catch(() => {});
  }

  hold(slot: string, done: (r: HoldResult) => void, onCall: (l: MmLink) => void) {
    let answered = false;
    let ep: Endpoint | null = null;
    let released = false;
    const answer = (r: HoldResult) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      done(r);
    };
    const timer = setTimeout(() => answer('offline'), HOLD_MS);
    this.dbp.then(
      (db) => {
        if (released || this.stopped) return;
        ep = new Endpoint(db, slot, (l) => (answered && !this.stopped ? onCall(l as unknown as MmLink) : l.close()));
        this.eps.add(ep);
        ep.claim().then(
          (s) => answer(s === 'held' ? 'held' : 'taken'),
          () => answer('offline'),
        );
      },
      () => answer('offline'),
    );
    return {
      release: () => {
        released = true;
        if (ep) {
          this.eps.delete(ep);
          ep.release();
        }
      },
    };
  }

  call(slot: string): MmLink {
    if (!this.caller) {
      const c = this.dbp.then((db) => {
        const ep = new Endpoint(db, `c-${rand()}${rand()}`, (l) => l.close());
        if (this.stopped) ep.release();
        else void ep.claim().catch(() => ep.release());
        return ep;
      });
      // a stand-in until the caller's own name is held
      this.caller = new LazyEndpoint(c) as unknown as Endpoint;
    }
    return (this.caller as unknown as LazyEndpoint).connect(slot);
  }

  stop() {
    this.stopped = true;
    for (const ep of this.eps) ep.release();
    this.eps.clear();
    (this.caller as unknown as LazyEndpoint | null)?.release();
    this.caller = null;
  }
}

/** An endpoint still being set up: links made now start once it exists. */
class LazyEndpoint {
  private ep: Endpoint | null = null;
  private dead = false;
  constructor(p: Promise<Endpoint>) {
    p.then(
      (ep) => {
        this.ep = ep;
        if (this.dead) ep.release();
      },
      () => (this.dead = true),
    );
    this.p = p;
  }
  private p: Promise<Endpoint>;

  connect(to: string): MmLink {
    if (this.ep) return this.ep.connect<MmWire>(to);
    let link: CloudLink<MmWire> | null = null;
    let closedEarly = false;
    const cbs = { open: [] as (() => void)[], msg: [] as ((m: MmWire) => void)[], close: [] as (() => void)[] };
    const sent: MmWire[] = [];
    const proxy: MmLink = {
      send: (m) => (link ? link.send(m) : sent.push(m)),
      close: () => {
        if (link) return link.close();
        if (closedEarly) return;
        closedEarly = true;
        for (const cb of cbs.close) cb();
      },
      onOpen: (cb) => (link ? link.onOpen(cb) : cbs.open.push(cb)),
      onMessage: (cb) => (link ? link.onMessage(cb) : cbs.msg.push(cb)),
      onClose: (cb) => (link ? link.onClose(cb) : cbs.close.push(cb)),
    };
    this.p.then(
      (ep) => {
        if (closedEarly || this.dead) return;
        const l = ep.connect<MmWire>(to);
        link = l;
        for (const cb of cbs.open) l.onOpen(cb);
        for (const cb of cbs.msg) l.onMessage(cb);
        for (const cb of cbs.close) l.onClose(cb);
        for (const m of sent) l.send(m);
      },
      () => proxy.close(),
    );
    return proxy;
  }

  release() {
    this.dead = true;
    this.ep?.release();
  }
}
