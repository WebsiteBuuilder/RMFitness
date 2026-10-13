// Friend links over PeerJS: each player listens under their friend code on the same
// free broker the duel rooms use, so friends need no account or server of their own.
import Peer, { type DataConnection, type PeerOptions } from 'peerjs';
import type { Link, Transport, TransportHandlers, Wire } from './protocol';

const PREFIX = 'eds-remake-u-';
const RETRY_MS = 4_000;
/**
 * The broker keeps a phone's code for about a minute after its connection dies (the app
 * was put away, the network changed), so "code taken" at first usually means our own
 * old connection: keep retrying quietly, and only say it's open elsewhere after this.
 */
const STALE_ID_MS = 75_000;
/** A broker connection that hasn't come back by then is rebuilt from scratch. */
const REOPEN_MS = 8_000;

/**
 * Connection routes, tried in turn when two online phones can't link: PeerJS's own
 * defaults first (the same ones duel rooms start with), then a wider set of public STUN
 * servers plus the PeerJS TURN relay over UDP and TCP, for networks that block UDP.
 */
const ICE: (RTCIceServer[] | undefined)[] = [
  undefined,
  [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478', 'turn:eu-0.turn.peerjs.com:3478?transport=tcp', 'turn:us-0.turn.peerjs.com:3478?transport=tcp'], username: 'peerjs', credential: 'peerjsp' },
  ],
];

export function peerOptions(ice = 0): PeerOptions {
  const servers = ICE[ice % ICE.length];
  return localBroker() ?? (servers ? { config: { iceServers: servers } } : {});
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
  private ready = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private reopen: ReturnType<typeof setTimeout> | null = null;
  /** when "code taken" answers started, for telling our own stale code from another phone */
  private takenSince = 0;
  private ice = 0;
  private troubles = 0;
  private openedAt = 0;

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
    if (this.reopen) clearTimeout(this.reopen);
    this.reopen = null;
    this.peer?.destroy();
    this.ready = false;
    this.openedAt = Date.now();
    h.onState('connecting');
    const peer = new Peer(PREFIX + this.code, peerOptions(this.ice));
    this.peer = peer;
    peer.on('open', () => {
      if (this.peer !== peer) return;
      if (this.reopen) clearTimeout(this.reopen);
      this.reopen = null;
      this.ready = true;
      this.takenSince = 0;
      h.onState('ready');
    });
    peer.on('connection', (conn) => {
      if (this.peer !== peer) return conn.close();
      h.onIncoming(new PeerLink(conn, false));
    });
    peer.on('disconnected', () => {
      if (this.peer !== peer || this.stopped) return;
      // The broker dropped; links already open keep working. Get back on it.
      this.ready = false;
      h.onState('connecting');
      try {
        peer.reconnect();
      } catch {
        return this.later(RETRY_MS);
      }
      if (this.reopen) clearTimeout(this.reopen);
      this.reopen = setTimeout(() => {
        this.reopen = null;
        if (this.peer === peer && !this.ready) this.open();
      }, REOPEN_MS);
    });
    peer.on('error', (err: Error & { type?: string }) => {
      if (this.peer !== peer || this.stopped) return;
      const type = err.type ?? '';
      if (type === 'peer-unavailable') {
        const m = /eds-remake-u-([A-Z0-9]+)/.exec(err.message);
        if (m) h.onUnavailable(m[1]);
      } else if (type === 'unavailable-id') {
        const t = Date.now();
        if (!this.takenSince) this.takenSince = t;
        h.onState(t - this.takenSince > STALE_ID_MS ? 'elsewhere' : 'connecting');
        this.peer?.destroy();
        this.peer = null;
        this.ready = false;
        this.later(RETRY_MS);
      } else if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed' || type === 'disconnected') {
        this.ready = false;
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

  trouble() {
    // Two failed links in a row: come back on the other connection routes.
    if (++this.troubles < 2 || localBroker()) return;
    this.troubles = 0;
    this.ice++;
    this.open();
  }

  wake() {
    if (this.stopped) return;
    if (!this.peer || this.peer.destroyed) return this.open();
    if (!this.ready) {
      // still getting on the broker: give a fresh start only if it's taking long
      if (Date.now() - this.openedAt > REOPEN_MS) this.open();
      return;
    }
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
    if (this.reopen) clearTimeout(this.reopen);
    this.peer?.destroy();
    this.peer = null;
  }
}
