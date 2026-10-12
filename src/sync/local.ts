import type { GameEvent, LoggedEvent } from '../game/types';
import { AdapterBase, SyncAdapter } from './types';

/** One device, both seats (hotseat). The log also survives a reload. */
export class LocalAdapter extends AdapterBase implements SyncAdapter {
  readonly kind = 'local' as const;
  readonly isHost = true;
  readonly roomCode = null;
  private key = 'sdo.hotseat.log';

  constructor(resume = false) {
    super();
    if (resume) {
      try {
        const raw = localStorage.getItem(this.key);
        if (raw) this.events = JSON.parse(raw);
      } catch {
        this.events = [];
      }
    } else {
      localStorage.removeItem(this.key);
    }
    this.setStatus('connected', 'Hotseat');
  }

  static hasSave(): boolean {
    try {
      const raw = localStorage.getItem('sdo.hotseat.log');
      return !!raw && raw.length > 2;
    } catch {
      return false;
    }
  }

  send(ev: GameEvent) {
    const logged: LoggedEvent = { ...ev, seq: this.events.length, ts: Date.now() };
    this.events = [...this.events, logged];
    try {
      localStorage.setItem(this.key, JSON.stringify(this.events));
    } catch {
      /* storage full or blocked: play on without the save */
    }
    this.emit();
  }

  close() {
    this.listeners.clear();
  }
}
