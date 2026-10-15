import type { GameEvent, LoggedEvent } from './events';

export type SyncStatus = 'offline' | 'connecting' | 'waiting' | 'connected' | 'error';

/**
 * A transport for the shared event log. The host (or the database) assigns
 * sequence numbers; clients only propose events and render the log they get back.
 */
export interface SyncAdapter {
  readonly kind: 'local' | 'peer' | 'firebase';
  readonly isHost: boolean;
  readonly roomCode: string | null;
  send(ev: GameEvent): void;
  subscribe(cb: (events: LoggedEvent[]) => void): () => void;
  onStatus(cb: (status: SyncStatus, detail: string) => void): () => void;
  close(): void;
  /** starts over after an 'error' status (online rooms) */
  retry?(): void;
  /** the host empties the log for a rematch in the same room (every phone in it follows) */
  restart?(): void;
}

/** Shared bookkeeping for adapters: listeners and a status value. */
export class AdapterBase {
  protected listeners = new Set<(events: LoggedEvent[]) => void>();
  protected statusListeners = new Set<(s: SyncStatus, d: string) => void>();
  protected events: LoggedEvent[] = [];
  status: SyncStatus = 'offline';
  detail = '';

  subscribe(cb: (events: LoggedEvent[]) => void): () => void {
    this.listeners.add(cb);
    cb(this.events);
    return () => this.listeners.delete(cb);
  }

  onStatus(cb: (status: SyncStatus, detail: string) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.status, this.detail);
    return () => this.statusListeners.delete(cb);
  }

  protected emit() {
    const snapshot = this.events.slice();
    for (const cb of this.listeners) cb(snapshot);
  }

  protected setStatus(s: SyncStatus, d = '') {
    this.status = s;
    this.detail = d;
    for (const cb of this.statusListeners) cb(s, d);
  }
}

export function newRoomCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  return code;
}
