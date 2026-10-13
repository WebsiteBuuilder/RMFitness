// Friend links over PeerJS: each player listens under their friend code on the same
// free broker the duel rooms use, so friends need no account or server of their own.
import Peer, { type DataConnection, type PeerOptions } from 'peerjs';
import type { Link, Transport, TransportHandlers, Wire } from './protocol';

const PREFIX = 'eds-remake-u-';
const RETRY_MS = 5_000;
/** The same profile open on another phone or tab holds the code; check back now and then. */
const ELSEWHERE_MS = 30_000;

/**
 * Broker and relay settings. Same public STUN and the PeerJS TURN relay (also over
 * TCP, for mobile networks that block UDP) that duel rooms fall back to.
 */
export function peerOptions(): PeerOptions {
  const opts: PeerOptions = {
    config: {
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478?transport=tcp'], username: 'peerjs', credential: 'peerjsp' },
      ],
    },
  };
  return localBroker() ?? opts;
}

/** `?peerhost=host:port`: a local PeerServer instead of the public broker (tests). */
export function localBroker(): PeerOptions | null {
  const local = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('peerhost') : null;
  if (!local) return null;
  const [host, port] = local.split(':');
  return { host, port: Number(port) || 9000, path: '/', secure: false, config: { iceServers: [] } };
}

class PeerLink implements Link {
  readonly peer: string;
  readonly outgoing: boolean;
  private conn: DataConnection;
  private closed = false;
  private closeCbs: (() => void)[] = [];

  constructor(conn: DataConnection, outgoing: boolean) {
    this.conn = conn;
    this.outgoing = outgoing;
    this.peer = conn.peer.startsWith(PREFIX) ? conn.peer.slice(PREFIX.length) : conn.peer;
    conn.on('close', () => this.fireClose());
    conn.on('error', () => this.fireClose());
    // PeerJS can miss a close when the other phone vanishes; the ICE state tells.
    conn.on('iceStateChanged', (s) => {
      if (s === 'failed' || s === 'closed') this.fireClose();
    });
  }

  private fireClose() {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb();
  }

  send(m: Wire) {
    if (this.conn.open) this.conn.send(m);
  }
  close() {
    this.conn.close();
    this.fireClose();
  }
  onOpen(cb: () => void) {
    if (this.conn.open) queueMicrotask(cb);
    else this.conn.on('open', cb);
  }
  onMessage(cb: (m: Wire) => void) {
    this.conn.on('data', (d) => {
      if (d && typeof d === 'object' && typeof (d as Wire).t === 'string') cb(d as Wire);
    });
  }
  onClose(cb: () => void) {
    this.closeCbs.push(cb);
  }
}

export class PeerTransport implements Transport {
  private peer: Peer | null = null;
  private h: TransportHandlers | null = null;
  private code = '';
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  start(myCode: string, h: TransportHandlers) {
    this.code = myCode;
    this.h = h;
    this.open();
  }

  private later(ms: number) {
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.open();
    }, ms);
  }

  private open() {
    if (this.stopped || !this.h) return;
    const h = this.h;
    this.peer?.destroy();
    h.onState('connecting');
    const peer = new Peer(PREFIX + this.code, peerOptions());
    this.peer = peer;
    peer.on('open', () => {
      if (this.peer === peer) h.onState('ready');
    });
    peer.on('connection', (conn) => {
      if (this.peer !== peer) return conn.close();
      h.onIncoming(new PeerLink(conn, false));
    });
    peer.on('disconnected', () => {
      if (this.peer !== peer || this.stopped) return;
      // The broker dropped; links already open keep working. Get back on it.
      h.onState('connecting');
      try {
        peer.reconnect();
      } catch {
        this.later(RETRY_MS);
      }
    });
    peer.on('error', (err: Error & { type?: string }) => {
      if (this.peer !== peer || this.stopped) return;
      const type = err.type ?? '';
      if (type === 'peer-unavailable') {
        const m = /eds-remake-u-([A-Z0-9]+)/.exec(err.message);
        if (m) h.onUnavailable(m[1]);
      } else if (type === 'unavailable-id') {
        h.onState('elsewhere');
        this.peer?.destroy();
        this.peer = null;
        this.later(ELSEWHERE_MS);
      } else if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed' || type === 'disconnected') {
        h.onState('offline');
        this.later(RETRY_MS);
      }
      // other errors belong to a single link; its close handles them
    });
  }

  connect(code: string): Link {
    const conn = this.peer!.connect(PREFIX + code, { reliable: true, serialization: 'json' });
    return new PeerLink(conn, true);
  }

  wake() {
    if (this.stopped) return;
    if (!this.peer || this.peer.destroyed) return this.open();
    if (this.peer.disconnected) {
      try {
        this.peer.reconnect();
      } catch {
        this.open();
      }
    }
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.peer?.destroy();
    this.peer = null;
  }
}
