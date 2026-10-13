import Peer, { DataConnection } from 'peerjs';
import type { GameEvent, LoggedEvent } from './events';
import { AdapterBase, SyncAdapter } from './types';
import { localBroker } from '../online/peerTransport';

type Msg = { t: 'sync'; events: LoggedEvent[] } | { t: 'ev'; ev: GameEvent } | { t: 'hello' };

const PREFIX = 'eds-remake-';

/**
 * Phone-to-phone room over WebRTC (PeerJS public broker). The host holds the
 * log and numbers events; the guest proposes events and mirrors the log.
 * Needs no account; some mobile networks block direct connections, in which
 * case the Firebase transport is the fallback.
 */
export class PeerAdapter extends AdapterBase implements SyncAdapter {
  readonly kind = 'peer' as const;
  readonly isHost: boolean;
  readonly roomCode: string;
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private queue: GameEvent[] = [];
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(roomCode: string, isHost: boolean) {
    super();
    this.roomCode = roomCode.toUpperCase();
    this.isHost = isHost;
    this.setStatus('connecting', 'Connecting…');
    this.open();
  }

  private open() {
    if (this.closed) return;
    this.peer?.destroy();
    const opts = localBroker() ?? {};
    this.peer = this.isHost ? new Peer(PREFIX + this.roomCode, opts) : new Peer(opts);
    this.peer.on('open', () => {
      if (this.isHost) this.setStatus('waiting', `Room ${this.roomCode}. Waiting for your opponent…`);
      else this.connectToHost();
    });
    this.peer.on('connection', (conn) => {
      if (!this.isHost) return;
      this.attach(conn);
    });
    this.peer.on('disconnected', () => {
      if (this.closed) return;
      this.setStatus('connecting', 'Reconnecting…');
      this.peer?.reconnect();
    });
    this.peer.on('error', (err: Error & { type?: string }) => {
      if (this.closed) return;
      if (err.type === 'peer-unavailable') {
        this.setStatus('connecting', `Looking for room ${this.roomCode}…`);
        this.scheduleRetry(() => this.connectToHost());
      } else if (err.type === 'unavailable-id') {
        this.setStatus('error', 'That room code is already in use. Create a new room.');
      } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
        this.setStatus('connecting', 'Network trouble, retrying…');
        this.scheduleRetry(() => this.open());
      } else {
        this.setStatus('error', err.message || String(err));
      }
    });
  }

  private scheduleRetry(fn: () => void) {
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.closed) fn();
    }, 2500);
  }

  private connectToHost() {
    if (!this.peer || this.peer.destroyed || this.closed) return;
    if (this.peer.disconnected) {
      this.peer.reconnect();
      return;
    }
    const conn = this.peer.connect(PREFIX + this.roomCode, { reliable: true });
    this.attach(conn);
  }

  private attach(conn: DataConnection) {
    this.conn?.close();
    this.conn = conn;
    conn.on('open', () => {
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
      if (this.closed) return;
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

  send(ev: GameEvent) {
    if (this.isHost) this.append(ev);
    else if (this.conn?.open) this.conn.send({ t: 'ev', ev } satisfies Msg);
    else this.queue.push(ev);
  }

  close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.conn?.close();
    this.peer?.destroy();
    this.listeners.clear();
    this.statusListeners.clear();
  }
}
