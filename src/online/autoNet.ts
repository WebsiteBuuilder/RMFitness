// Picks how this phone goes online: through the online service when it can use it
// (src/sync/cloud.ts), otherwise the older phone-to-phone links over PeerJS.
import { checkCloud, cloudState } from '../sync/cloud';
import { CloudQueue, CloudTransport } from './cloudNet';
import { PeerQueue } from './peerQueue';
import { PeerTransport } from './peerTransport';
import type { MmNet } from './matchmaking';
import type { Link, Transport, TransportHandlers } from './protocol';

export type NetKind = 'cloud' | 'peer';

/** Friends: waits for the service check, then goes online the best way available. */
export class AutoTransport implements Transport {
  private inner: Transport | null = null;
  private stopped = false;
  kind: NetKind | null = null;

  start(code: string, h: TransportHandlers) {
    h.onState('connecting');
    void checkCloud().then((s) => {
      if (this.stopped) return;
      this.kind = s === 'on' ? 'cloud' : 'peer';
      this.inner = s === 'on' ? new CloudTransport() : new PeerTransport();
      this.inner.start(code, h);
    });
  }

  connect(code: string): Link {
    if (this.inner) return this.inner.connect(code);
    const dead = { peer: code, outgoing: true, send() {}, close() {}, onOpen() {}, onMessage() {}, onClose: (cb: () => void) => queueMicrotask(cb) };
    return dead as Link;
  }

  wake() {
    this.inner?.wake();
  }

  trouble() {
    this.inner?.trouble?.();
  }

  stop() {
    this.stopped = true;
    this.inner?.stop();
  }
}

/** Find a Match: the queue on the service, or the phone-to-phone one. */
export function queueNet(): MmNet {
  return cloudState() === 'on' ? new CloudQueue() : new PeerQueue();
}
