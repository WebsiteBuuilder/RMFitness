// Binds a transport (in-memory for a computer teammate, the linked room for two phones) to a
// Boss Raid. The log is the room's log: lobby actions are skipped, RAID_* messages replay.
import { useEffect, useState } from 'preact/hooks';
import type { SyncAdapter, SyncStatus } from '../sync/types';
import type { Action, LoggedAction } from './types';
import { Raid, isRaidMsg, type RaidMsg } from './raid';

export class RaidSession {
  raid = new Raid();
  status: SyncStatus = 'offline';
  detail = '';
  private applied = 0;
  private log: LoggedAction[] = [];
  private listeners = new Set<() => void>();
  private unsubs: (() => void)[] = [];

  /** `owns`: closing the raid closes the transport too (not when a room's duel session shares it) */
  constructor(
    public readonly adapter: SyncAdapter,
    private readonly owns = true,
  ) {
    this.unsubs.push(
      adapter.subscribe((events) => this.ingest(events)),
      adapter.onStatus((s, d) => {
        this.status = s;
        this.detail = d;
        this.notify();
      }),
    );
  }

  private ingest(events: LoggedAction[]) {
    if (events.length < this.applied || (this.applied > 0 && events[this.applied - 1]?.seq !== this.log[this.applied - 1]?.seq)) {
      this.raid = new Raid();
      this.applied = 0;
    }
    for (let i = this.applied; i < events.length; i++) {
      const a = events[i] as unknown as { type: string };
      if (isRaidMsg(a)) this.raid.apply(a);
    }
    this.applied = events.length;
    this.log = events;
    this.notify();
  }

  send(m: RaidMsg) {
    this.adapter.send(m as unknown as Action);
  }

  get started(): boolean {
    return !!this.raid.plan;
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
    this.listeners.clear();
    if (this.owns) this.adapter.close();
  }
}

/** Redraws on every change to the raid; returns its version. */
export function useRaid(s: RaidSession): number {
  const [, setV] = useState(0);
  useEffect(() => {
    const off = s.listen(() => setV((v) => v + 1));
    setV((v) => v + 1);
    return off;
  }, [s]);
  return s.raid.version + s.status.length;
}
