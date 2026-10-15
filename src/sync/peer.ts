import Peer, { DataConnection, type PeerOptions } from 'peerjs';
import type { GameEvent, LoggedEvent } from './events';
import { AdapterBase, SyncAdapter } from './types';
import { localBroker } from '../online/peerTransport';

type Msg = { t: 'sync'; events: LoggedEvent[] } | { t: 'ev'; ev: GameEvent } | { t: 'hello' };

const PREFIX = 'eds-remake-';

export const NET_UNREACHABLE = "Can't reach the online server. Check your Wi-Fi or mobile data.";
export const NET_NO_ROOM = 'No room with that code. Check the 4 letters, or create a room.';
export const NET_NO_LINK = "Couldn't link the two phones. Try again, or put both phones on the same Wi-Fi.";

/** How long the broker gets to hand out an id before the room counts as unreachable. */
const OPEN_TIMEOUT = 12_000;
/** How long a guest waits for the link to the host to open before trying the other ICE servers. */
const LINK_TIMEOUT = 15_000;

/**
 * ICE server lists, tried in turn when the phones can't link: PeerJS's own defaults
 * first, then a wider set of public STUN servers plus the PeerJS TURN relay over TCP
 * (for mobile networks that block UDP). No accounts or secrets.
 */
const ICE: (RTCIceServer[] | undefined)[] = [
  undefined,
  [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478', 'turn:eu-0.turn.peerjs.com:3478?transport=tcp', 'turn:us-0.turn.peerjs.com:3478?transport=tcp'], username: 'peerjs', credential: 'peerjsp' },
  ],
];

/**
 * Phone-to-phone room over WebRTC (PeerJS public broker). The host holds the
 * log and numbers events; the guest proposes events and mirrors the log.
 * Needs no account; some mobile networks block direct connections, in which
 * case the Firebase transport is the fallback.
 *
 * When the broker can't be reached, or a guest's room code doesn't exist, the
 * status turns to 'error' with a plain message, and `retry()` starts over.
 */
export class PeerAdapter extends AdapterBase implements SyncAdapter {
  readonly kind = 'peer' as const;
  readonly isHost: boolean;
  readonly roomCode: string;
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private queue: GameEvent[] = [];
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private linkTimer: ReturnType<typeof setTimeout> | null = null;
  /** this Peer object got its id from the broker */
  private opened = false;
  /** the two phones were linked at least once (then a missing host is only away, not a wrong code) */
  private everLinked = false;
  /** broker failures in a row, and "no such room" answers in a row */
  private failures = 0;
  private lookups = 0;
  /** which ICE list is in use */
  private ice = 0;

  constructor(roomCode: string, isHost: boolean) {
    super();
    this.roomCode = roomCode.toUpperCase();
    this.isHost = isHost;
    this.setStatus('connecting', 'Connecting…');
    this.open();
  }

  /** Starts over after an error (the lobby's Retry button). */
  retry() {
    if (this.closed) return;
    this.failures = 0;
    this.lookups = 0;
    this.setStatus('connecting', 'Connecting…');
    this.open();
  }

  private clearTimers() {
    for (const t of [this.retryTimer, this.openTimer, this.linkTimer]) if (t) clearTimeout(t);
    this.retryTimer = this.openTimer = this.linkTimer = null;
  }

  /** Gives up for now: the lobby shows the message with Retry and Back. */
  private fail(detail: string) {
    this.clearTimers();
    this.peer?.destroy();
    this.peer = null;
    this.opened = false;
    this.setStatus('error', detail);
  }

  private open() {
    if (this.closed) return;
    this.clearTimers();
    this.peer?.destroy();
    this.opened = false;
    const ice = ICE[this.ice];
    const opts: PeerOptions = localBroker() ?? (ice ? { config: { iceServers: ice } } : {});
    const peer = this.isHost ? new Peer(PREFIX + this.roomCode, opts) : new Peer(opts);
    this.peer = peer;
    this.openTimer = setTimeout(() => {
      this.openTimer = null;
      if (this.peer === peer && !this.opened && !this.closed) this.fail(NET_UNREACHABLE);
    }, OPEN_TIMEOUT);
    peer.on('open', () => {
      if (this.peer !== peer) return;
      this.opened = true;
      this.failures = 0;
      if (this.openTimer) clearTimeout(this.openTimer);
      this.openTimer = null;
      if (this.isHost) {
        if (!this.conn?.open) this.setStatus('waiting', `Room ${this.roomCode}. Waiting for your opponent…`);
      } else if (!this.conn?.open) this.connectToHost();
    });
    peer.on('connection', (conn) => {
      if (!this.isHost) return;
      this.attach(conn);
    });
    peer.on('disconnected', () => {
      if (this.closed || this.peer !== peer || !this.opened) return;
      // Lost the broker. A duel already linked keeps going phone to phone.
      if (!this.conn?.open) this.setStatus('connecting', 'Reconnecting…');
      peer.reconnect();
    });
    peer.on('error', (err: Error & { type?: string }) => {
      if (this.closed || this.peer !== peer) return;
      const type = err.type ?? '';
      if (type === 'peer-unavailable') {
        // A code nobody is hosting. Once the phones have been linked, the host is only away.
        if (!this.everLinked && ++this.lookups >= 2) return this.fail(NET_NO_ROOM);
        this.setStatus('connecting', `Looking for room ${this.roomCode}…`);
        this.scheduleRetry(() => this.connectToHost());
      } else if (type === 'unavailable-id') {
        this.fail('That room code is already in use. Create a new room.');
      } else if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
        if (this.conn?.open) return; // the duel's own link is fine
        if (++this.failures >= 2) return this.fail(NET_UNREACHABLE);
        this.setStatus('connecting', 'Network trouble, retrying…');
        this.scheduleRetry(() => this.open());
      } else if (type === 'webrtc' || type === 'negotiation-failed') {
        this.linkFailed();
      } else if (type === 'browser-incompatible') {
        this.fail("This browser can't play online. Try Chrome or Safari.");
      } else {
        this.fail(err.message || String(err));
      }
    });
  }

  private scheduleRetry(fn: () => void) {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closed) fn();
    }, 2500);
  }

  /** The guest's link to the host never opened: try the other ICE servers once, then say so. */
  private linkFailed() {
    if (this.closed || this.conn?.open) return;
    if (this.ice < ICE.length - 1) {
      this.ice++;
      this.setStatus('connecting', 'Trying another way to link the phones…');
      this.open();
    } else {
      this.ice = 0;
      this.fail(NET_NO_LINK);
    }
  }

  private connectToHost() {
    const peer = this.peer;
    if (!peer || peer.destroyed || this.closed) return;
    if (peer.disconnected) {
      peer.reconnect();
      return;
    }
    const conn = peer.connect(PREFIX + this.roomCode, { reliable: true });
    this.attach(conn);
    if (this.linkTimer) clearTimeout(this.linkTimer);
    this.linkTimer = setTimeout(() => {
      this.linkTimer = null;
      // still not linked, and the broker never said the room is missing
      if (this.conn === conn && !conn.open && this.status !== 'error') this.linkFailed();
    }, LINK_TIMEOUT);
  }

  private attach(conn: DataConnection) {
    this.conn?.close();
    this.conn = conn;
    conn.on('open', () => {
      this.everLinked = true;
      this.lookups = 0;
      if (this.linkTimer) clearTimeout(this.linkTimer);
      this.linkTimer = null;
      this.setStatus('connected', this.isHost ? 'Opponent connected' : 'Connected to host');
      if (this.isHost) conn.send({ t: 'sync', events: this.events } satisfies Msg);
      else {
        conn.send({ t: 'hello' } satisfies Msg);
        for (const ev of this.queue) conn.send({ t: 'ev', ev } satisfies Msg);
        this.queue = [];
      }
    });
    conn.on('data', (raw) => this.receive(raw as Msg));
    conn.on('close', () => {
      if (this.closed || this.conn !== conn) return;
      this.conn = null;
      if (this.isHost) this.setStatus('waiting', 'Opponent disconnected. Waiting for them to rejoin…');
      else {
        this.setStatus('connecting', 'Lost the host. Reconnecting…');
        this.scheduleRetry(() => this.connectToHost());
      }
    });
    conn.on('error', () => {
      /* handled by close */
    });
  }

  private receive(msg: Msg) {
    if (msg.t === 'ev') {
      if (this.isHost) this.append(msg.ev);
      else this.events = [...this.events, msg.ev as LoggedEvent], this.emit();
    } else if (msg.t === 'sync') {
      if (!this.isHost) {
        this.events = msg.events;
        this.emit();
      }
    }
  }

  private append(ev: GameEvent) {
    const logged: LoggedEvent = { ...ev, seq: this.events.length, ts: Date.now() };
    this.events = [...this.events, logged];
    this.emit();
    if (this.conn?.open) this.conn.send({ t: 'ev', ev: logged } satisfies Msg);
  }

  /** Rematch: the host wipes the log and the guest's phone mirrors the empty log. */
  restart() {
    if (!this.isHost || this.closed) return;
    this.events = [];
    this.emit();
    if (this.conn?.open) this.conn.send({ t: 'sync', events: [] } satisfies Msg);
  }

  send(ev: GameEvent) {
    if (this.isHost) this.append(ev);
    else if (this.conn?.open) this.conn.send({ t: 'ev', ev } satisfies Msg);
    else this.queue.push(ev);
  }

  close() {
    this.closed = true;
    this.clearTimers();
    this.conn?.close();
    this.peer?.destroy();
    this.listeners.clear();
    this.statusListeners.clear();
  }
}
