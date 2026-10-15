// The friends list kept live: who is online, what they're doing, friend requests and duel invites.
import type { GameMode } from '../eds/types';
import type { Activity, Link, Transport, TransportState, Wire } from './protocol';
import { cleanStats, type BoardStats } from '../collection/rankings';

/**
 * friend: both sides agreed. sent: this player added their code and waits for
 * them to accept. request: they added this player, who hasn't answered yet.
 */
export type FriendStatus = 'friend' | 'sent' | 'request';

export interface FriendRec {
  code: string;
  name: string;
  color: string;
  status: FriendStatus;
  since: number;
  /** last time they were online (0 = never seen) */
  lastSeen: number;
  /** their link-battle record, as their phone last shared it (Duelist Rankings) */
  board?: BoardStats;
}

/** What one profile keeps on the phone. */
export interface OnlineData {
  code: string;
  friends: FriendRec[];
  /** codes removed or declined; they stay quiet until this player adds them again */
  ignored: string[];
}

export interface Me {
  name: string;
  color: string;
  /** this player's link-battle record, shared with friends for the rankings */
  board?: BoardStats;
}

export interface FriendView extends FriendRec {
  online: boolean;
  activity: Activity | null;
}

export interface IncomingInvite {
  id: string;
  from: string;
  name: string;
  room: string;
  game: GameMode;
  at: number;
}

export type OutgoingState = 'waiting' | 'accepted' | 'declined' | 'busy' | 'expired' | 'offline';

export interface OutgoingInvite {
  id: string;
  to: string;
  room: string;
  game: GameMode;
  at: number;
  state: OutgoingState;
}

export interface PresenceOptions {
  transport: Transport;
  data: OnlineData;
  me: Me;
  save: (d: OnlineData) => void;
  now?: () => number;
  /** timers, so tests can drive the clock */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

/** How often missing friends are dialed again. */
export const POLL_MS = 15_000;
/** A link that hasn't opened by then is dropped. */
export const DIAL_TIMEOUT = 12_000;
/** Pings keep a link honest; a silent one counts as gone. */
export const PING_MS = 8_000;
export const SILENT_MS = 25_000;
/** An invite nobody answered expires. */
export const INVITE_MS = 60_000;
const TICK_MS = 1_000;

interface LinkState {
  link: Link;
  open: boolean;
  /** their hello arrived: they count as online */
  hello: boolean;
  dialedAt: number;
  heardAt: number;
  sentAt: number;
}

export class Presence {
  data: OnlineData;
  me: Me;
  activity: Activity = { kind: 'menu' };
  state: TransportState = 'connecting';
  incoming: IncomingInvite[] = [];
  outgoing: OutgoingInvite | null = null;
  private links = new Map<string, LinkState>();
  /** what each online player last said they were doing */
  private activities = new Map<string, Activity>();
  private lastPoll = -Infinity;
  private timer: unknown = null;
  private listeners = new Set<() => void>();
  private stopped = false;
  private o: PresenceOptions;
  private now: () => number;
  /** called when an invite this player sent gets a yes */
  onAccepted: ((inv: OutgoingInvite) => void) | null = null;
  /** short news for the player ("Bro added you as a friend") */
  onNotice: ((text: string) => void) | null = null;
  /** why a friend who isn't online couldn't be reached: not open, or the phones couldn't link */
  reach = new Map<string, 'away' | 'blocked'>();

  constructor(o: PresenceOptions) {
    this.o = o;
    this.data = o.data;
    this.me = o.me;
    this.now = o.now ?? Date.now;
  }

  start() {
    this.o.transport.start(this.data.code, {
      onState: (s) => {
        this.state = s;
        if (s === 'ready') this.poll(true);
        this.changed();
      },
      onIncoming: (link) => this.adopt(link),
      onUnavailable: (code) => {
        const ls = this.links.get(code);
        if (ls && !ls.open) this.drop(code, ls.link);
        if (this.reach.get(code) !== 'away') {
          this.reach.set(code, 'away');
          this.changed();
        }
      },
    });
    const si = this.o.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    this.timer = si(() => this.tick(), TICK_MS);
  }

  stop() {
    this.stopped = true;
    const ci = this.o.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
    if (this.timer !== null) ci(this.timer);
    this.timer = null;
    const all = [...this.links.values()];
    this.links.clear();
    for (const ls of all) ls.link.close();
    this.o.transport.stop();
    this.listeners.clear();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed() {
    for (const cb of this.listeners) cb();
  }

  private persist() {
    this.o.save(this.data);
  }

  // ---------- the list ----------

  friends(): FriendView[] {
    const order: Record<FriendStatus, number> = { request: 0, friend: 1, sent: 2 };
    return this.data.friends
      .map((f) => ({ ...f, online: this.isOnline(f.code), activity: this.activities.get(f.code) ?? null }))
      .sort((a, b) => order[a.status] - order[b.status] || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }

  isOnline(code: string): boolean {
    return !!this.links.get(code)?.hello;
  }

  onlineCount(): number {
    return this.data.friends.filter((f) => f.status === 'friend' && this.isOnline(f.code)).length;
  }

  private rec(code: string): FriendRec | undefined {
    return this.data.friends.find((f) => f.code === code);
  }

  /** Adds a friend by code. They become a friend once their phone says yes (or at once, if they asked first). */
  add(code: string, name = 'Friend'): 'added' | 'accepted' | 'already' | 'self' {
    if (code === this.data.code) return 'self';
    this.data.ignored = this.data.ignored.filter((c) => c !== code);
    const r = this.rec(code);
    if (r?.status === 'friend' || r?.status === 'sent') return 'already';
    if (r?.status === 'request') {
      this.accept(code);
      return 'accepted';
    }
    this.data.friends.push({ code, name, color: '#888888', status: 'sent', since: this.now(), lastSeen: 0 });
    this.persist();
    this.dial(code);
    this.changed();
    return 'added';
  }

  accept(code: string) {
    const r = this.rec(code);
    if (!r || r.status !== 'request') return;
    r.status = 'friend';
    this.persist();
    this.sayHi(code);
    this.changed();
  }

  /** Declines a request or removes a friend; their phone forgets this player too. */
  remove(code: string) {
    const r = this.rec(code);
    if (!r) return;
    if (!this.data.ignored.includes(code)) this.data.ignored.push(code);
    this.data.friends = this.data.friends.filter((f) => f.code !== code);
    this.persist();
    const ls = this.links.get(code);
    if (ls?.open) ls.link.send({ t: 'unfriend' });
    if (ls) this.drop(code, ls.link);
    this.incoming = this.incoming.filter((i) => i.from !== code);
    this.changed();
  }

  setMe(me: Me) {
    this.me = me;
    for (const code of this.links.keys()) this.sayHi(code);
  }

  setActivity(a: Activity) {
    if (JSON.stringify(a) === JSON.stringify(this.activity)) return;
    this.activity = a;
    this.broadcast({ t: 'activity', activity: a });
    // A busy player turns down what's waiting; a room that filled ends the invite.
    if (a.kind === 'duel') {
      for (const inv of this.incoming) this.sendTo(inv.from, { t: 'invite-reply', id: inv.id, answer: 'busy' });
      this.incoming = [];
    }
    const out = this.outgoing;
    if (out && out.state === 'waiting' && (a.kind !== 'room' || a.room !== out.room)) this.cancelInvite();
    this.changed();
  }

  // ---------- invites ----------

  /** Asks an online friend to join this player's room. */
  invite(code: string, room: string, game: GameMode): OutgoingInvite | null {
    const r = this.rec(code);
    if (!r || r.status !== 'friend' || !this.isOnline(code)) return null;
    if (this.outgoing?.state === 'waiting') this.cancelInvite();
    const inv: OutgoingInvite = { id: `${this.data.code}-${this.now().toString(36)}`, to: code, room, game, at: this.now(), state: 'waiting' };
    this.outgoing = inv;
    this.sendTo(code, { t: 'invite', id: inv.id, room, game });
    this.changed();
    return inv;
  }

  cancelInvite() {
    const out = this.outgoing;
    if (!out) return;
    if (out.state === 'waiting') this.sendTo(out.to, { t: 'invite-cancel', id: out.id });
    this.outgoing = null;
    this.changed();
  }

  /** Answers an invite. Returns it on a yes, so the app can join the room. */
  answer(id: string, yes: boolean): IncomingInvite | null {
    const inv = this.incoming.find((i) => i.id === id);
    if (!inv) return null;
    this.incoming = this.incoming.filter((i) => i.id !== id);
    this.sendTo(inv.from, { t: 'invite-reply', id, answer: yes ? 'yes' : 'no' });
    if (yes) {
      // one duel at a time: the rest are turned down
      for (const other of this.incoming) this.sendTo(other.from, { t: 'invite-reply', id: other.id, answer: 'busy' });
      this.incoming = [];
    }
    this.changed();
    return yes ? inv : null;
  }

  // ---------- links ----------

  /** Nudges every link (the app came back to the screen). */
  wake() {
    this.o.transport.wake();
    this.poll(true);
  }

  private targets(): string[] {
    return this.data.friends.filter((f) => f.status !== 'request').map((f) => f.code);
  }

  private poll(force = false) {
    if (this.stopped || this.state !== 'ready') return;
    const t = this.now();
    if (!force && t - this.lastPoll < POLL_MS) return;
    this.lastPoll = t;
    for (const code of this.targets()) if (!this.links.has(code)) this.dial(code);
  }

  private dial(code: string) {
    if (this.stopped || this.state !== 'ready' || this.links.has(code)) return;
    this.adopt(this.o.transport.connect(code));
  }

  private adopt(link: Link) {
    const code = link.peer;
    if (this.stopped || code === this.data.code) return link.close();
    if (!link.outgoing && this.data.ignored.includes(code)) return link.close();
    const t = this.now();
    const ls: LinkState = { link, open: false, hello: false, dialedAt: t, heardAt: t, sentAt: t };
    const prev = this.links.get(code);
    if (prev) {
      // Both phones dialed at once: keep the link dialed by the lower code, on both sides.
      // A redial by the same phone replaces the old link.
      if (this.dialer(link) > this.dialer(prev.link)) return link.close();
      this.links.delete(code);
      prev.link.close();
    }
    this.links.set(code, ls);
    link.onOpen(() => {
      if (this.links.get(code)?.link !== link) return;
      ls.open = true;
      ls.heardAt = this.now();
      this.sayHi(code);
    });
    link.onMessage((m) => {
      if (this.links.get(code)?.link !== link) return;
      ls.heardAt = this.now();
      this.receive(code, ls, m);
    });
    link.onClose(() => {
      if (this.links.get(code)?.link !== link) return;
      this.drop(code, link);
    });
  }

  private dialer(link: Link): string {
    return link.outgoing ? this.data.code : link.peer;
  }

  private drop(code: string, link: Link) {
    if (this.stopped) return;
    const ls = this.links.get(code);
    if (!ls || ls.link !== link) return;
    this.links.delete(code);
    link.close();
    if (ls.hello) {
      const r = this.rec(code);
      if (r) {
        r.lastSeen = this.now();
        this.persist();
      }
    }
    this.activities.delete(code);
    this.incoming = this.incoming.filter((i) => i.from !== code);
    if (this.outgoing?.to === code && this.outgoing.state === 'waiting') this.outgoing = { ...this.outgoing, state: 'offline' };
    this.changed();
  }

  private sayHi(code: string) {
    const ls = this.links.get(code);
    if (!ls?.open) return;
    const r = this.rec(code);
    this.send(ls, { t: 'hi', v: 1, code: this.data.code, name: this.me.name, color: this.me.color, activity: this.activity, friend: r?.status === 'friend' || r?.status === 'sent', ...(this.me.board ? { board: this.me.board } : {}) });
  }

  private send(ls: LinkState, m: Wire) {
    if (!ls.open) return;
    ls.sentAt = this.now();
    try {
      ls.link.send(m);
    } catch {
      /* a dying link; its close follows */
    }
  }

  private sendTo(code: string, m: Wire) {
    const ls = this.links.get(code);
    if (ls) this.send(ls, m);
  }

  private broadcast(m: Wire) {
    for (const ls of this.links.values()) if (ls.hello) this.send(ls, m);
  }

  private receive(code: string, ls: LinkState, m: Wire) {
    switch (m.t) {
      case 'hi': {
        if (m.code !== code) return this.drop(code, ls.link);
        ls.hello = true;
        this.activities.set(code, m.activity);
        let r = this.rec(code);
        let answer = false;
        if (m.friend) {
          // Having someone's code means they gave it out: adding by code needs no accept step.
          if (!r) {
            if (this.data.ignored.includes(code)) return this.drop(code, ls.link);
            r = { code, name: m.name, color: m.color, status: 'friend', since: this.now(), lastSeen: 0 };
            this.data.friends.push(r);
            answer = true;
            this.onNotice?.(`${m.name.slice(0, 24) || 'Someone'} added you as a friend`);
          } else if (r.status !== 'friend') {
            answer = r.status === 'request';
            r.status = 'friend';
          }
        } else if (r?.status === 'friend') {
          // their phone lost this player (a new phone, cleared data): ask again
          r.status = 'sent';
          answer = true;
        } else if (r?.status === 'request') {
          this.data.friends = this.data.friends.filter((f) => f !== r);
          r = undefined;
        }
        if (r) {
          r.name = m.name.slice(0, 24) || r.name;
          r.color = m.color;
          r.lastSeen = this.now();
          const b = cleanStats(m.board);
          if (b) r.board = b;
        }
        this.reach.delete(code);
        this.persist();
        if (!r && !m.friend) return this.drop(code, ls.link);
        // tell them where they stand now, so both lists agree
        if (answer) this.sayHi(code);
        this.changed();
        return;
      }
      case 'activity':
        this.activities.set(code, m.activity);
        this.changed();
        return;
      case 'invite': {
        if (this.rec(code)?.status !== 'friend') return;
        if (this.activity.kind === 'duel' || this.incoming.length >= 3) return this.send(ls, { t: 'invite-reply', id: m.id, answer: 'busy' });
        this.incoming = [...this.incoming.filter((i) => i.from !== code), { id: m.id, from: code, name: this.rec(code)!.name, room: m.room, game: m.game, at: this.now() }];
        this.changed();
        return;
      }
      case 'invite-cancel':
        this.incoming = this.incoming.filter((i) => i.id !== m.id);
        this.changed();
        return;
      case 'invite-reply': {
        const out = this.outgoing;
        if (!out || out.id !== m.id || out.state !== 'waiting') return;
        const state: OutgoingState = m.answer === 'yes' ? 'accepted' : m.answer === 'busy' ? 'busy' : 'declined';
        this.outgoing = { ...out, state };
        if (state === 'accepted') this.onAccepted?.(this.outgoing);
        this.changed();
        return;
      }
      case 'unfriend':
        this.data.friends = this.data.friends.filter((f) => f.code !== code);
        this.persist();
        this.drop(code, ls.link);
        return;
      case 'ping':
        return;
    }
  }

  /** Once a second: ping, drop silent links, give up on slow dials, expire invites, poll. */
  tick() {
    if (this.stopped) return;
    const t = this.now();
    let dirty = false;
    for (const [code, ls] of [...this.links]) {
      if (!ls.open) {
        if (t - ls.dialedAt > DIAL_TIMEOUT) {
          // Their phone is there but the two couldn't link: try other relay routes next time.
          if (ls.link.outgoing) {
            this.reach.set(code, 'blocked');
            this.o.transport.trouble?.();
          }
          this.drop(code, ls.link);
        }
        continue;
      }
      if (t - ls.heardAt > SILENT_MS) {
        this.drop(code, ls.link);
        continue;
      }
      if (t - ls.sentAt >= PING_MS) this.send(ls, { t: 'ping' });
    }
    const before = this.incoming.length;
    this.incoming = this.incoming.filter((i) => t - i.at < INVITE_MS);
    if (this.incoming.length !== before) dirty = true;
    if (this.outgoing?.state === 'waiting' && t - this.outgoing.at >= INVITE_MS) {
      this.sendTo(this.outgoing.to, { t: 'invite-cancel', id: this.outgoing.id });
      this.outgoing = { ...this.outgoing, state: 'expired' };
      dirty = true;
    }
    this.poll();
    if (dirty) this.changed();
  }
}
