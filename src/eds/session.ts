// Binds a transport (hotseat, peer, firebase) to the engine. The log carries
// JOIN actions for the lobby and engine actions for the duel.
import { useEffect, useState } from 'preact/hooks';
import type { SyncAdapter, SyncStatus } from '../sync/types';
import { Engine } from './engine';
import { DB } from './db';
import type { Action, DuelState, GameMode, LoggedAction, Pid } from './types';

export interface Seat {
  name: string;
  deck: string[];
  fusion: string[];
  ready: boolean;
  /** which game the player readied for (missing = EDS) */
  mode?: GameMode;
  /** Speed Duel: the Skill they bring */
  skill?: string | null;
  /** Speed Duel: their cards' rarity tiers (card leveling), for the other player to see */
  rarity?: Record<string, number>;
}

export type LobbyAction = { type: 'JOIN'; player: Pid; name: string; deck: string[]; fusion: string[]; mode?: GameMode; skill?: string | null; rarity?: Record<string, number> };
export type AnyAction = Action | LobbyAction;

export interface SessionView {
  state: DuelState;
  seats: [Seat, Seat];
  status: SyncStatus;
  detail: string;
  log: LoggedAction[];
}

export class DuelSession {
  engine = new Engine(DB);
  seats: [Seat, Seat] = [
    { name: '', deck: [], fusion: [], ready: false },
    { name: '', deck: [], fusion: [], ready: false },
  ];
  log: LoggedAction[] = [];
  status: SyncStatus = 'offline';
  detail = '';
  private applied = 0;
  private listeners = new Set<() => void>();
  private unsubs: (() => void)[] = [];

  constructor(public readonly adapter: SyncAdapter) {
    this.unsubs.push(
      adapter.subscribe((events) => this.ingest(events)),
      adapter.onStatus((status, detail) => {
        this.status = status;
        this.detail = detail;
        this.notify();
      }),
    );
  }

  private ingest(events: LoggedAction[]) {
    // Append-only log: apply only what is new; rebuild if the log was replaced.
    if (events.length < this.applied || (this.applied > 0 && events[this.applied - 1]?.seq !== this.log[this.applied - 1]?.seq)) {
      this.engine = new Engine(DB);
      this.seats = [
        { name: '', deck: [], fusion: [], ready: false },
        { name: '', deck: [], fusion: [], ready: false },
      ];
      this.applied = 0;
    }
    for (let i = this.applied; i < events.length; i++) this.applyOne(events[i] as unknown as AnyAction);
    this.applied = events.length;
    this.log = events;
    this.notify();
  }

  private applyOne(a: AnyAction) {
    if (a.type === 'JOIN') {
      this.seats[a.player] = { name: a.name, deck: a.deck, fusion: a.fusion, ready: true, mode: a.mode ?? 'eds', skill: a.skill ?? null, rarity: a.rarity };
      return;
    }
    try {
      this.engine.apply(a as Action);
    } catch (err) {
      console.error('engine error', err, a);
    }
  }

  send(a: AnyAction) {
    this.adapter.send(a as Action);
  }

  get state(): DuelState {
    return this.engine.state;
  }

  view(): SessionView {
    return { state: this.engine.state, seats: this.seats, status: this.status, detail: this.detail, log: this.log };
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

export function useDuelSession(session: DuelSession): SessionView {
  const [view, setView] = useState<SessionView>(() => session.view());
  useEffect(() => session.listen(() => setView(session.view())), [session]);
  return view;
}
