import type { GameEvent, LoggedEvent } from './events';
import { AdapterBase, type SyncAdapter } from './types';

/** In-memory log for a duel against the computer. */
export class MemoryAdapter extends AdapterBase implements SyncAdapter {
  readonly kind = 'local' as const;
  readonly isHost = true;
  readonly roomCode = null;
  /** `events`: a kept log to pick a duel back up from (a cut-off Ranked Duel) */
  constructor(events: LoggedEvent[] = []) {
    super();
    this.events = events.map((e, i) => ({ ...e, seq: i }));
    this.setStatus('connected', 'Campaign');
  }
  send(ev: GameEvent) {
    const logged: LoggedEvent = { ...ev, seq: this.events.length, ts: Date.now() };
    this.events = [...this.events, logged];
    this.emit();
  }
  restart() {
    this.events = [];
    this.emit();
  }
  close() {}
}
