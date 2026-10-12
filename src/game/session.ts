import { useEffect, useState } from 'preact/hooks';
import type { GameEvent, GameState, LoggedEvent } from './types';
import { replay } from './reducer';
import type { SyncAdapter, SyncStatus } from '../sync/types';

export interface SessionView {
  state: GameState;
  events: LoggedEvent[];
  status: SyncStatus;
  detail: string;
}

/** Binds a transport to the game: every log change is replayed into a fresh state. */
export class Session {
  events: LoggedEvent[] = [];
  state: GameState = replay([]);
  status: SyncStatus = 'offline';
  detail = '';
  private listeners = new Set<() => void>();
  private unsubs: (() => void)[] = [];

  constructor(public readonly adapter: SyncAdapter) {
    this.unsubs.push(
      adapter.subscribe((events) => {
        this.events = events;
        this.state = replay(events);
        this.notify();
      }),
      adapter.onStatus((status, detail) => {
        this.status = status;
        this.detail = detail;
        this.notify();
      }),
    );
  }

  send(ev: GameEvent) {
    this.adapter.send(ev);
  }

  view(): SessionView {
    return { state: this.state, events: this.events, status: this.status, detail: this.detail };
  }

  listen(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify() {
    for (const cb of this.listeners) cb();
  }

  close() {
    for (const u of this.unsubs) u();
    this.adapter.close();
    this.listeners.clear();
  }
}

export function useSession(session: Session): SessionView {
  const [view, setView] = useState<SessionView>(() => session.view());
  useEffect(() => session.listen(() => setView(session.view())), [session]);
  return view;
}
