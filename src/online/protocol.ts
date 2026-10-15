// Friends and presence: what two phones say to each other, and the transport they say it over.
import type { GameMode } from '../eds/types';
import type { BoardStats } from '../collection/rankings';

/** What a player is doing right now, shown on their friends' lists. */
export type Activity =
  | { kind: 'menu' }
  /** hosting a room; `open` while the second seat is still free */
  | { kind: 'room'; room: string; game: GameMode; open: boolean }
  | { kind: 'duel'; game?: GameMode };

export type InviteAnswer = 'yes' | 'no' | 'busy';

/** Messages on a friend link. `v` lets a newer build talk to an older one. */
export type Wire =
  /** sent first on every link; `friend` says whether the sender has the receiver on their list */
  | { t: 'hi'; v: 1; code: string; name: string; color: string; activity: Activity; friend: boolean; board?: BoardStats }
  | { t: 'activity'; activity: Activity }
  | { t: 'invite'; id: string; room: string; game: GameMode }
  | { t: 'invite-cancel'; id: string }
  | { t: 'invite-reply'; id: string; answer: InviteAnswer }
  /** the sender removed the receiver (or declined their request) */
  | { t: 'unfriend' }
  | { t: 'ping' };

/** One open (or opening) link to another player, named by their friend code. */
export interface Link {
  /** the other player's friend code */
  readonly peer: string;
  /** this phone dialed it */
  readonly outgoing: boolean;
  send(m: Wire): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (m: Wire) => void): void;
  onClose(cb: () => void): void;
}

export type TransportState = 'connecting' | 'ready' | 'offline' | 'elsewhere';

export interface TransportHandlers {
  onState(s: TransportState): void;
  onIncoming(link: Link): void;
  /** nobody is listening under that friend code right now */
  onUnavailable(code: string): void;
}

/**
 * Whatever carries friend links: PeerJS today (no account needed). A server
 * could stand in later, also refereeing duels, without touching the friends code.
 */
export interface Transport {
  start(myCode: string, h: TransportHandlers): void;
  connect(code: string): Link;
  /** try again now (the app came back to the screen) */
  wake(): void;
  /** a link to a phone that is online failed to open: switch to other connection routes */
  trouble?(): void;
  stop(): void;
}

const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 6;

export function newFriendCode(rand: () => number = Math.random): string {
  let c = '';
  for (let i = 0; i < CODE_LEN; i++) c += CODE_LETTERS[Math.floor(rand() * CODE_LETTERS.length)];
  return c;
}

/** Accepts "k7q-2mx", "K7Q 2MX" or a whole friend link; null when it isn't a code. */
export function parseFriendCode(text: string): string | null {
  const fromLink = /[?&]friend=([A-Za-z0-9-]+)/.exec(text);
  const raw = (fromLink ? fromLink[1] : text).toUpperCase().replace(/[\s-]/g, '');
  if (raw.length !== CODE_LEN) return null;
  for (const ch of raw) if (!CODE_LETTERS.includes(ch)) return null;
  return raw;
}

/** "K7Q2MX" → "K7Q-2MX", easier to read out loud. */
export function showCode(code: string): string {
  return code.length === CODE_LEN ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}
