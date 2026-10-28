// Binds a transport (hotseat, peer, firebase) to the engine. The log carries
// JOIN actions for the lobby and engine actions for the duel.
import { useEffect, useState } from 'preact/hooks';
import type { SyncAdapter, SyncStatus } from '../sync/types';
import { Engine } from './engine';
import { DB } from './db';
import type { Action, DuelState, GameMode, LoggedAction, Pid } from './types';
import { betsLocked, type Ante, type Stakes } from '../collection/stakes';
import { applyToss, isTossAction, type Toss, type TossAction } from './toss';

export interface Seat {
  name: string;
  deck: string[];
  fusion: string[];
  ready: boolean;
  /** which game the player readied for (missing = EDS) */
  mode?: GameMode;
  /** Speed Duel: the Skill they bring */
  skill?: string | null;
  /** Speed Duel: their cards' rarity tiers (card leveling), for the other player to see */
  rarity?: Record<string, number>;
  /** Speed Duel: bets, Shadow Realm rescues and whether the duel pays prizes */
  stakes?: Stakes;
  /** pressed Accept on both players' bets */
  accepted?: boolean;
}

export type LobbyAction =
  | { type: 'JOIN'; player: Pid; name: string; deck: string[]; fusion: string[]; mode?: GameMode; skill?: string | null; rarity?: Record<string, number>; stakes?: Stakes }
  /** changes a seat's bet; both players have to Accept again */
  | { type: 'STAKE'; player: Pid; ante: Ante | null }
  | { type: 'ACCEPT'; player: Pid }
  /** who goes first: rock-paper-scissors, a coin toss, or the last loser's call */
  | TossAction
  /** after a duel: this player wants a rematch in the same room (or walked away) */
  | { type: 'REMATCH'; player: Pid; want: boolean }
  /** a chat line between the two players of an online room (rides the room's log, never touches the duel) */
  | { type: 'CHAT'; player: Pid; text: string };
export type AnyAction = Action | LobbyAction;

export interface SessionView {
  state: DuelState;
  seats: [Seat, Seat];
  status: SyncStatus;
  detail: string;
  log: LoggedAction[];
  /** deciding who goes first (before the duel starts) */
  toss: Toss | null;
  /** after the duel: who asked for a rematch (false = not yet, or walked away) */
  rematch: [RematchVote, RematchVote];
  /** the duels played in this room so far */
  series: Series;
  /** 0 for the room's first duel, 1 for the first rematch... */
  round: number;
  /** the room's chat, oldest first (lines from earlier duels in the room included) */
  chat: ChatLine[];
  /** entries in the log that aren't chat: what screens key their room logic on (a chat line changes nothing) */
  moves: number;
}

export interface ChatLine {
  /** unique in the room: rematch round and place in the log */
  id: string;
  player: Pid;
  text: string;
  /** when the host logged it (ms, the host's clock) */
  at: number;
  /**
   * how late it reached this phone compared with the quickest entry so far (ms; both phones' clocks
   * cancel out): about 0 for a line said just now, large for one replayed from history after a rejoin
   */
  late: number;
  /** when it reached this phone (ms, this phone's clock) */
  got: number;
}

/** The longest chat line. */
export const CHAT_MAX = 80;

/** The host's lines per CHAT_WINDOW_MS it takes from the other phone (the rest are dropped). */
const CHAT_HOST_CAP = 8;
const CHAT_WINDOW_MS = 8000;

/**
 * The host screens a move the other phone proposes before it goes into the room's log: a chat line
 * must be in the guest's own seat (no lines in the host's name), is tidied and cut to size here (so
 * nothing big is stored), and a flood is dropped. Every other move passes as it is.
 */
export function screenProposal<T extends { type: string }>(ev: T, guestSeat: Pid, recent: number[], now = Date.now()): T | null {
  if (ev.type !== 'CHAT') return ev;
  const c = ev as unknown as { player: unknown; text: unknown };
  const text = cleanChat(c.text);
  if (c.player !== guestSeat || !text) return null;
  while (recent.length && now - recent[0] >= CHAT_WINDOW_MS) recent.shift();
  if (recent.length >= CHAT_HOST_CAP) return null;
  recent.push(now);
  // (only the three fields: nothing else a changed app attaches is stored)
  return { type: 'CHAT', player: guestSeat, text } as unknown as T;
}

/** A chat line as it is shown: one line, no control or text-direction characters, at most CHAT_MAX characters. */
export function cleanChat(text: unknown): string {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, CHAT_MAX).join('');
}

export type RematchVote = 'yes' | 'no' | null;

/** The run of duels between the same two players in one room: wins by seat and draws. */
export interface Series {
  wins: [number, number];
  draws: number;
  /** who won the last duel */
  last: Pid | 'draw' | null;
}

const noSeats = (): [Seat, Seat] => [
  { name: '', deck: [], fusion: [], ready: false },
  { name: '', deck: [], fusion: [], ready: false },
];

export class DuelSession {
  engine = new Engine(DB);
  seats: [Seat, Seat] = [
    { name: '', deck: [], fusion: [], ready: false },
    { name: '', deck: [], fusion: [], ready: false },
  ];
  log: LoggedAction[] = [];
  status: SyncStatus = 'offline';
  detail = '';
  toss: Toss | null = null;
  rematch: [RematchVote, RematchVote] = [null, null];
  series: Series = { wins: [0, 0], draws: 0, last: null };
  round = 0;
  /** the seats of the duel before this rematch (bets carry over when they still fit) */
  prevSeats: [Seat, Seat] | null = null;
  /**
   * Duels against the computer: builds the START once the toss says who goes first
   * (online and hotseat rooms build it from the seats).
   */
  autoStart: ((first: Pid) => Action) | null = null;
  /** this duel's chat, and the lines from the duels before it in the room (a rematch keeps them) */
  chat: ChatLine[] = [];
  private earlierChat: ChatLine[] = [];
  /** when this phone sent its last chat lines (the send cap holds across the room's screens) */
  chatSentAt: number[] = [];
  /** the chat's open state and unsent text, kept as the room moves between screens (duel → result) */
  chatOpen = false;
  chatDraft = '';
  /** the smallest (arrival − host time) seen: the two clocks' difference plus the quickest delivery */
  private offset = Infinity;
  /** when this phone opened the room (a log pouring in just after is history, not news) */
  readonly openedAt = Date.now();
  /** when the latest entries reached this phone (to tell a log pouring in from a line said just now) */
  private arrivals: number[] = [];

  /** Entries that reached this phone in the last `ms` (a burst means a log loading, not people talking). */
  arrivedWithin(ms: number, now = Date.now()): number {
    return this.arrivals.filter((t) => now - t <= ms).length;
  }
  private moves = 0;
  /** duels already counted in the series, by seed (a rebuilt log replays them) */
  private counted = new Set<number>();
  private applied = 0;
  private listeners = new Set<() => void>();
  private unsubs: (() => void)[] = [];

  constructor(public readonly adapter: SyncAdapter) {
    this.unsubs.push(
      adapter.subscribe((events) => this.ingest(events)),
      adapter.onStatus((status, detail) => {
        this.status = status;
        this.detail = detail;
        this.notify();
      }),
    );
  }

  private ingest(events: LoggedAction[]) {
    // Append-only log: apply only what is new; rebuild if the log was replaced.
    if (events.length < this.applied || (this.applied > 0 && events[this.applied - 1]?.seq !== this.log[this.applied - 1]?.seq)) {
      // The host wiped a finished duel's log: a rematch in the same room.
      if (events.length === 0 && this.engine.state.winner !== null) {
        this.round++;
        this.prevSeats = this.seats;
        this.earlierChat = [...this.earlierChat, ...this.chat].slice(-60);
      }
      this.chat = [];
      this.moves = 0;
      this.engine = new Engine(DB);
      this.seats = noSeats();
      this.toss = null;
      this.rematch = [null, null];
      this.applied = 0;
    }
    for (let i = this.applied; i < events.length; i++) {
      const ev = events[i];
      const now = Date.now();
      this.arrivals.push(now);
      if (this.arrivals.length > 16) this.arrivals.shift();
      if ((ev as { type: string }).type === 'CHAT') this.addChat(ev as unknown as LoggedAction & { player: Pid; text: unknown });
      else {
        this.moves++;
        this.applyOne(ev as unknown as AnyAction);
      }
      // (after the line: its own lateness is measured against the entries before it)
      if (typeof ev.ts === 'number') this.offset = Math.min(this.offset, now - ev.ts);
    }
    this.applied = events.length;
    this.log = events;
    this.notify();
  }

  private addChat(ev: { seq: number; ts: number; player: Pid; text: unknown }) {
    const text = cleanChat(ev.text);
    if (!text || (ev.player !== 0 && ev.player !== 1)) return;
    const got = Date.now();
    const late = Number.isFinite(this.offset) ? Math.max(0, got - ev.ts - this.offset) : 0;
    this.chat = [...this.chat, { id: `${this.round}:${ev.seq}`, player: ev.player, text, at: ev.ts, late, got }];
  }

  private applyOne(a: AnyAction) {
    if (a.type === 'JOIN') {
      this.seats[a.player] = { name: a.name, deck: a.deck, fusion: a.fusion, ready: true, mode: a.mode ?? 'eds', skill: a.skill ?? null, rarity: a.rarity, stakes: a.stakes };
      this.seats[a.player === 0 ? 1 : 0].accepted = false;
      return;
    }
    if (a.type === 'STAKE') {
      const st = this.seats[a.player].stakes;
      if (st && !this.engine.state.started) {
        this.seats[a.player] = { ...this.seats[a.player], stakes: { ...st, ante: a.ante } };
        this.seats[0].accepted = this.seats[1].accepted = false;
      }
      return;
    }
    if (a.type === 'ACCEPT') {
      if (!this.engine.state.started) this.seats[a.player] = { ...this.seats[a.player], accepted: true };
      return;
    }
    if (isTossAction(a)) {
      if (!this.engine.state.started) this.toss = applyToss(this.toss, a);
      return;
    }
    if (a.type === 'REMATCH') {
      if (this.engine.state.winner !== null && this.rematch[a.player] !== 'no') {
        this.rematch = [...this.rematch] as [RematchVote, RematchVote];
        this.rematch[a.player] = a.want ? 'yes' : 'no';
      }
      return;
    }
    if (a.type === 'START' && this.engine.state.started) return;
    // A Speed Duel with bets only starts once both players accepted the bets as they stand
    // in the log (a bet changed just before Start resets that, on every phone alike).
    if (a.type === 'START' && a.mode === 'speed' && !this.engine.state.started && !betsLocked(this.seats)) return;
    try {
      this.engine.apply(a as Action);
    } catch (err) {
      console.error('engine error', err, a);
    }
    const st = this.engine.state;
    if (st.started && st.winner !== null && !this.counted.has(st.seed)) {
      this.counted.add(st.seed);
      const w = st.winner;
      const wins: [number, number] = [...this.series.wins];
      if (w === 'draw') this.series = { wins, draws: this.series.draws + 1, last: 'draw' };
      else {
        wins[w]++;
        this.series = { wins, draws: this.series.draws, last: w };
      }
    }
  }

  /** Both players asked for a rematch and the room can start over. */
  get rematchAgreed(): boolean {
    return this.engine.state.winner !== null && this.rematch[0] === 'yes' && this.rematch[1] === 'yes';
  }

  /** The host wipes the finished duel's log: both phones go back to the room for the rematch. */
  startRematch(): boolean {
    if (!this.adapter.isHost || !this.adapter.restart || !this.rematchAgreed) return false;
    this.adapter.restart();
    return true;
  }

  send(a: AnyAction) {
    this.adapter.send(a as Action);
  }

  get state(): DuelState {
    return this.engine.state;
  }

  view(): SessionView {
    return { state: this.engine.state, seats: this.seats, status: this.status, detail: this.detail, log: this.log, toss: this.toss, rematch: this.rematch, series: this.series, round: this.round, chat: this.earlierChat.length ? [...this.earlierChat, ...this.chat] : this.chat, moves: this.moves };
  }

  listen(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify() {
    for (const cb of this.listeners) cb();
  }

  close() {
    for (const u of this.unsubs) u();
    this.adapter.close();
    this.listeners.clear();
  }
}

export function useDuelSession(session: DuelSession): SessionView {
  const [view, setView] = useState<SessionView>(() => session.view());
  useEffect(() => {
    const off = session.listen(() => setView(session.view()));
    // a child's effect may have sent something before this listener was on
    setView(session.view());
    return off;
  }, [session]);
  return view;
}
