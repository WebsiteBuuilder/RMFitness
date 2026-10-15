// The matchmaking queue over PeerJS: lobby slots are broker ids anyone can try to take.
import Peer, { type DataConnection } from 'peerjs';
import type { HoldResult, MmLink, MmNet, MmWire } from './matchmaking';
import { peerOptions } from './peerTransport';

const PREFIX = 'eds-remake-';
/** The broker gets this long to answer before the phone counts as offline. */
const OPEN_MS = 10_000;

class QueueLink implements MmLink {
  private closed = false;
  private closeCbs: (() => void)[] = [];
  constructor(private conn: DataConnection) {
    conn.on('close', () => this.fireClose());
    conn.on('error', () => this.fireClose());
    conn.on('iceStateChanged', (s) => {
      if (s === 'failed' || s === 'closed') this.fireClose();
    });
  }
  fireClose() {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb();
  }
  send(m: MmWire) {
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
  onMessage(cb: (m: MmWire) => void) {
    this.conn.on('data', (d) => {
      if (d && typeof d === 'object' && typeof (d as MmWire).t === 'string') cb(d as MmWire);
    });
  }
  onClose(cb: () => void) {
    this.closeCbs.push(cb);
  }
}

export class PeerQueue implements MmNet {
  /** this phone's own line for calling waiters (any id) */
  private caller: Peer | null = null;
  private callerOpen = false;
  private waitingCalls: (() => void)[] = [];
  private calls = new Map<string, QueueLink>();
  private holds = new Set<Peer>();
  private stopped = false;

  hold(slot: string, done: (r: HoldResult) => void, onCall: (l: MmLink) => void) {
    let answered = false;
    const answer = (r: HoldResult) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      done(r);
    };
    const peer = new Peer(PREFIX + slot, peerOptions(1));
    this.holds.add(peer);
    const timer = setTimeout(() => answer('offline'), OPEN_MS);
    peer.on('open', () => answer('held'));
    peer.on('connection', (conn) => {
      if (!answered || this.stopped) return conn.close();
      onCall(new QueueLink(conn));
    });
    peer.on('disconnected', () => {
      // off the broker: nobody new can find this slot, so get back on it
      if (!this.stopped && answered && !peer.destroyed) peer.reconnect();
    });
    peer.on('error', (err: Error & { type?: string }) => {
      if (err.type === 'unavailable-id') answer('taken');
      else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed') answer('offline');
    });
    return {
      release: () => {
        this.holds.delete(peer);
        peer.destroy();
      },
    };
  }

  private callerPeer(): Peer {
    if (this.caller && !this.caller.destroyed) return this.caller;
    const peer = new Peer(peerOptions(1));
    this.caller = peer;
    this.callerOpen = false;
    peer.on('open', () => {
      this.callerOpen = true;
      const w = this.waitingCalls;
      this.waitingCalls = [];
      for (const fn of w) fn();
    });
    peer.on('disconnected', () => {
      if (!this.stopped && !peer.destroyed) peer.reconnect();
    });
    peer.on('error', (err: Error & { type?: string }) => {
      if (err.type === 'peer-unavailable') {
        // nobody holds that slot after all: its call ends
        for (const [slot, link] of this.calls) if (err.message.includes(PREFIX + slot)) link.fireClose();
      }
    });
    return peer;
  }

  call(slot: string): MmLink {
    const peer = this.callerPeer();
    let link: QueueLink | null = null;
    const pendingCbs: { open: (() => void)[]; msg: ((m: MmWire) => void)[]; close: (() => void)[] } = { open: [], msg: [], close: [] };
    let closedEarly = false;
    // A stand-in until the caller's line is up; then the real link takes over.
    const proxy: MmLink = {
      send: (m) => link?.send(m),
      close: () => {
        if (link) return link.close();
        if (closedEarly) return;
        closedEarly = true;
        for (const cb of pendingCbs.close) cb();
      },
      onOpen: (cb) => (link ? link.onOpen(cb) : pendingCbs.open.push(cb)),
      onMessage: (cb) => (link ? link.onMessage(cb) : pendingCbs.msg.push(cb)),
      onClose: (cb) => (link ? link.onClose(cb) : pendingCbs.close.push(cb)),
    };
    const dial = () => {
      if (closedEarly || this.stopped) return;
      const l = new QueueLink(peer.connect(PREFIX + slot, { reliable: true, serialization: 'json' }));
      link = l;
      this.calls.set(slot, l);
      l.onClose(() => this.calls.get(slot) === l && this.calls.delete(slot));
      for (const cb of pendingCbs.open) l.onOpen(cb);
      for (const cb of pendingCbs.msg) l.onMessage(cb);
      for (const cb of pendingCbs.close) l.onClose(cb);
    };
    if (this.callerOpen) dial();
    else this.waitingCalls.push(dial);
    return proxy;
  }

  stop() {
    this.stopped = true;
    for (const l of this.calls.values()) l.close();
    this.calls.clear();
    for (const p of this.holds) p.destroy();
    this.holds.clear();
    this.caller?.destroy();
    this.caller = null;
  }
}
