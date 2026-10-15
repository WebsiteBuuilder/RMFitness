// Matchmaking: press Find a Match, and whoever else is searching becomes your opponent.
//
// There is no server to keep a queue, so the queue lives on the same free PeerJS broker the
// duel rooms use. A handful of well-known lobby slots ("eds-remake-q-speed-0", "-1", ...)
// stand in for the queue: a searching phone tries to hold slot 0; if someone already holds
// it, that someone is waiting, so it calls them instead. A waiter offers a room, the caller
// takes it, the waiter hosts and the caller joins: an ordinary link battle from there.
//
// Slots can be left behind by a phone that vanished (the broker remembers a dead phone for
// about a minute), so a caller that gets no answer moves on to the next slot, and a waiter
// holding a higher slot keeps checking the lower ones, so two waiters always find each other.
import type { GameMode } from '../eds/types';
import { cleanStats, type BoardStats } from '../collection/rankings';
import { newRoomCode } from '../sync/types';

/** Who a player is, as shown to the opponent the queue finds. */
export interface MatchCard {
  name: string;
  color: string;
  /** their friend code, so either player can add the other afterwards */
  code: string;
  board?: BoardStats;
}

export type MmWire =
  /** a caller says hello to a waiter */
  | { t: 'mm-hi'; v: 1; game: GameMode; me: MatchCard }
  /** the waiter offers a room */
  | { t: 'mm-offer'; room: string; me: MatchCard }
  /** the caller takes it: both are committed */
  | { t: 'mm-take' }
  /** not now (already matching someone, or that's yourself) */
  | { t: 'mm-busy' };

export interface MmLink {
  send(m: MmWire): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (m: MmWire) => void): void;
  onClose(cb: () => void): void;
}

export type HoldResult = 'held' | 'taken' | 'offline';

/** What carries the queue: PeerJS on phones, an in-memory broker in tests. */
export interface MmNet {
  /** Tries to take a lobby slot. `done` fires once; callers arrive through `onCall` while held. */
  hold(slot: string, done: (r: HoldResult) => void, onCall: (l: MmLink) => void): { release(): void };
  /** Calls whoever holds a slot (the link just closes if nobody does). */
  call(slot: string): MmLink;
  stop(): void;
}

export interface Match {
  /** the waiter hosts the room, the caller joins it */
  role: 'host' | 'guest';
  room: string;
  game: GameMode;
  opponent: MatchCard;
}

export type MmState = 'idle' | 'searching' | 'found' | 'offline';

/** How many lobby slots per game. */
export const SLOTS = 6;
/** A call with no offer by then: a slot left behind by a vanished phone. */
export const CALL_MS = 8_000;
/** An offer that wasn't taken by then is withdrawn. */
export const OFFER_MS = 6_000;
/** A waiter on a higher slot checks the lower ones this often. */
export const PROBE_MS = 10_000;
/** Every slot busy: look again after this. */
export const RESCAN_MS = 3_000;

export const slotId = (game: GameMode, i: number) => `q-${game}-${i}`;

export interface MatchmakerOptions {
  net: () => MmNet;
  me: () => MatchCard;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  room?: () => string;
}

/** One phone's place in the queue. */
export class Matchmaker {
  state: MmState = 'idle';
  game: GameMode = 'speed';
  /** when the search began (for the clock on screen) */
  since = 0;
  match: Match | null = null;
  /** called once when an opponent is found */
  onMatch: ((m: Match) => void) | null = null;
  private o: MatchmakerOptions;
  private net: MmNet | null = null;
  /** a run number: anything left over from an earlier search is ignored */
  private run = 0;
  private held: { slot: number; release: () => void } | null = null;
  /** this phone's one call out to a waiter */
  private calling: MmLink | null = null;
  /** a room this waiter offered and is waiting to hear taken: other callers hear "busy" */
  private offering: MmLink | null = null;
  private timers = new Set<unknown>();
  private listeners = new Set<() => void>();
  private now: () => number;

  constructor(o: MatchmakerOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed() {
    for (const cb of this.listeners) cb();
  }

  private later(ms: number, fn: () => void) {
    const run = this.run;
    const st = this.o.setTimeout ?? ((f: () => void, t: number) => setTimeout(f, t));
    const h = st(() => {
      this.timers.delete(h);
      if (run === this.run) fn();
    }, ms);
    this.timers.add(h);
  }

  private clearTimers() {
    const ct = this.o.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    for (const h of this.timers) ct(h);
    this.timers.clear();
  }

  get searching() {
    return this.state === 'searching' || this.state === 'offline';
  }

  /** Joins the queue. */
  start(game: GameMode) {
    if (this.searching && this.game === game) return;
    this.reset();
    this.game = game;
    this.state = 'searching';
    this.since = this.now();
    this.match = null;
    this.net = this.o.net();
    this.scan(0);
    this.changed();
  }

  /** Leaves the queue (Cancel, closing the game, starting another duel). */
  cancel() {
    if (this.state === 'idle') return;
    this.reset();
    this.state = 'idle';
    this.changed();
  }

  /** Forgets a match that was handed to the app. */
  clear() {
    if (this.state !== 'found') return;
    this.state = 'idle';
    this.match = null;
    this.changed();
  }

  private reset() {
    this.run++;
    this.clearTimers();
    this.calling?.close();
    this.calling = null;
    this.offering?.close();
    this.offering = null;
    this.held?.release();
    this.held = null;
    this.net?.stop();
    this.net = null;
  }

  /** Works up the slots: hold the first free one, or call whoever waits in it. */
  private scan(i: number) {
    if (!this.searching || !this.net) return;
    if (i >= SLOTS) return this.later(RESCAN_MS, () => this.scan(0));
    const run = this.run;
    let answered = false;
    const h = this.net.hold(
      slotId(this.game, i),
      (r) => {
        if (run !== this.run || answered) return;
        answered = true;
        if (r === 'held') {
          this.held = { slot: i, release: () => h.release() };
          if (this.state === 'offline') (this.state = 'searching'), this.changed();
          if (i > 0) this.later(PROBE_MS, () => this.probe());
        } else if (r === 'taken') {
          h.release();
          this.call(i, () => this.scan(i + 1));
        } else {
          h.release();
          if (this.state !== 'offline') (this.state = 'offline'), this.changed();
          this.later(RESCAN_MS, () => this.scan(0));
        }
      },
      (link) => (run === this.run ? this.answer(link) : link.close()),
    );
  }

  /** A waiter on a higher slot checks the lower ones, so two waiters can't miss each other. */
  private probe() {
    const held = this.held;
    if (!held || this.state !== 'searching') return;
    const again = () => this.later(PROBE_MS, () => this.probe());
    if (this.calling) return again();
    const next = (j: number) => {
      if (this.state !== 'searching' || !this.held) return;
      if (j >= held.slot) return again();
      this.call(j, () => next(j + 1));
    };
    next(0);
  }

  /** Calls the waiter in slot i. `miss` runs when nobody (or a busy phone) answers. */
  private call(i: number, miss: () => void) {
    if (!this.net) return;
    if (this.calling) return miss();
    const run = this.run;
    const link = this.net.call(slotId(this.game, i));
    this.calling = link;
    let over = false;
    const fail = () => {
      if (over) return;
      over = true;
      if (this.calling === link) this.calling = null;
      link.close();
      if (run === this.run && this.state === 'searching') miss();
    };
    this.later(CALL_MS, fail);
    link.onOpen(() => {
      if (!over) link.send({ t: 'mm-hi', v: 1, game: this.game, me: this.o.me() });
    });
    link.onClose(fail);
    link.onMessage((m) => {
      if (over || run !== this.run) return;
      if (m.t === 'mm-busy') return fail();
      if (m.t !== 'mm-offer' || this.state !== 'searching') return;
      const opp = card(m.me);
      if (!opp || !/^[A-Z]{4}$/.test(m.room) || opp.code === this.o.me().code) return fail();
      // this phone just offered its own room to someone else: that one goes first
      if (this.offering) {
        link.send({ t: 'mm-busy' });
        return fail();
      }
      over = true;
      if (this.calling === link) this.calling = null;
      link.send({ t: 'mm-take' });
      this.found({ role: 'guest', room: m.room, game: this.game, opponent: opp });
    });
  }

  /** Someone called this waiter. */
  private answer(link: MmLink) {
    const run = this.run;
    let over = false;
    let offered = false;
    const end = () => {
      if (over) return;
      over = true;
      if (this.offering === link) this.offering = null;
      link.close();
    };
    link.onClose(end);
    link.onMessage((m) => {
      if (over || run !== this.run) return;
      if (m.t === 'mm-hi') {
        const opp = card(m.me);
        if (this.state !== 'searching' || this.offering || !opp || m.game !== this.game || opp.code === this.o.me().code) {
          link.send({ t: 'mm-busy' });
          return end();
        }
        this.offering = link;
        offered = true;
        const room = (this.o.room ?? newRoomCode)();
        link.send({ t: 'mm-offer', room, me: this.o.me() });
        this.later(OFFER_MS, () => !over && end());
        link.onMessage((x) => {
          if (over || run !== this.run) return;
          if (x.t === 'mm-busy') return end();
          if (x.t !== 'mm-take') return;
          over = true;
          this.offering = null;
          this.found({ role: 'host', room, game: this.game, opponent: opp });
        });
      } else if (m.t === 'mm-take' && !offered) end();
    });
  }

  private found(m: Match) {
    // the last message (the take) still has to reach the other phone: the line goes a moment later
    const net = this.net;
    this.net = null;
    this.reset();
    const st = this.o.setTimeout ?? ((f: () => void, t: number) => setTimeout(f, t));
    st(() => net?.stop(), 2000);
    this.state = 'found';
    this.match = m;
    this.changed();
    this.onMatch?.(m);
  }
}

/** A player card from the wire, checked (it comes from a stranger's phone). */
function card(x: unknown): MatchCard | null {
  if (!x || typeof x !== 'object') return null;
  const c = x as Record<string, unknown>;
  if (typeof c.name !== 'string' || typeof c.code !== 'string' || !/^[A-Z0-9]{6}$/.test(c.code)) return null;
  const color = typeof c.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.color) ? c.color : '#888888';
  const board = cleanStats(c.board);
  return { name: c.name.slice(0, 24) || 'Duelist', color, code: c.code, ...(board ? { board } : {}) };
}
