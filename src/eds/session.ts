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
  | { type: 'CHAT'; player: Pid; text: string; cid?: string };
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
  /** it came with the room's log loading on this phone (a reload or a rejoin): history, not news */
  old: boolean;
  /** the sending phone's tag on it */
  cid?: string;
}

/** A pause this long after the room's log starts reaching a phone ends its first load. */
const LOAD_PAUSE_MS = 300;
/** A line in that first load said more than this long ago (by the host's clock) is history. */
const LOAD_OLD_MS = 5000;
/** ...and roughly now by this phone's clock (generous: phones' clocks differ a little). */
const LOAD_CLOCK_MS = 60_000;

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
  // (only these fields: nothing else a changed app attaches is stored)
  const cid = chatCid((ev as unknown as { cid?: unknown }).cid);
  return (cid ? { type: 'CHAT', player: guestSeat, text, cid } : { type: 'CHAT', player: guestSeat, text }) as unknown as T;
}

/** The sending phone's own tag on a line (to match it when it comes back, and to drop a resent copy): short letters and digits only. */
export function chatCid(cid: unknown): string | undefined {
  return typeof cid === 'string' && /^[a-z0-9]{1,12}$/.test(cid) ? cid : undefined;
}

/** A chat line as it is shown: one line, no control or text-direction characters, at most CHAT_MAX characters. */
export function cleanChat(text: unknown): string {
  if (typeof text !== 'string') return '';
  const flat = text
    .replace(/[\u0000-\u001f\u007f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]+/g, ' ')
    // (a pile of accents on one letter grows tall over the screen: two at most)
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
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
  /** the chat's lines already seen on this phone and their unread count (kept as the duel turns into the result screen) */
  chatSeen: Set<string> | null = null;
  chatUnread = 0;
  /** this phone's lines on their way to the room, and whether the other player is muted (this room only) */
  chatPending: { id: string; text: string; at: number }[] = [];
  chatMuted = false;
  /** the newest host time in that first load (a later line stamped before it is history too: the load arriving in parts) */
  private loadNewest = 0;
  /**
   * The room's log as this phone first gets it comes in one go (a reload or a rejoin hands it all
   * over at once): entries until the first pause are that load (history); after it, news.
   */
  private loadingUntil = 0;
  private loaded = false;
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
      if (!this.loaded) {
        const now = Date.now();
        if (this.loadingUntil && now > this.loadingUntil) this.loaded = true;
        else {
          this.loadingUntil = now + LOAD_PAUSE_MS;
          if (typeof ev.ts === 'number') this.loadNewest = Math.max(this.loadNewest, ev.ts);
        }
      }
      if ((ev as { type: string }).type === 'CHAT') this.addChat(ev as unknown as LoggedAction & { player: Pid; text: unknown });
      else {
        this.moves++;
        this.applyOne(ev as unknown as AnyAction);
      }
    }
    // (a load that arrives one entry at a time: its lines are judged again against the whole load so far)
    if (!this.loaded) this.chat = this.chat.map((l) => (l.old === this.isOld(l.at) ? l : { ...l, old: this.isOld(l.at) }));
    this.applied = events.length;
    this.log = events;
    this.notify();
  }

  /** A line in the first load said at host time `ts`: history unless among the load's newest entries and roughly now. */
  private isOld(ts: number): boolean {
    return !(this.loadNewest - ts < LOAD_OLD_MS && Math.abs(Date.now() - ts) < LOAD_CLOCK_MS);
  }

  private addChat(ev: { seq: number; ts: number; player: Pid; text: unknown; cid?: unknown }) {
    const text = cleanChat(ev.text);
    if (!text || (ev.player !== 0 && ev.player !== 1)) return;
    // (a line sent again after it looked lost, when the first one got there after all: shown once)
    const cid = chatCid(ev.cid);
    if (cid && [...this.earlierChat, ...this.chat].some((l) => l.cid === cid && l.player === ev.player)) return;
    // (history: part of that first load and said a while ago; the room's very first line, said just now, is news)
    // (and a line stamped before the newest entry of that load is history however late it arrives;
    // host times are only compared with host times, so a phone's clock being off doesn't matter)
    // (in the load: news only if it's among the load's newest entries by host time, and roughly now on this phone's clock)
    const old = this.loaded ? ev.ts < this.loadNewest : this.isOld(ev.ts);
    this.chat = [...this.chat, { id: `${this.round}:${ev.seq}`, player: ev.player, text, at: ev.ts, old, cid }];
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
