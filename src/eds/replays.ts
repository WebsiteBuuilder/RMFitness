// Duel replays: a finished Speed Duel's room log, kept on this phone (the last few per duelist).
// The engine is deterministic from START's seed, so playing the same moves back gives the same duel.
import type { Action, DuelState, Pid } from './types';
import { AdapterBase, type SyncAdapter } from '../sync/types';
import type { GameEvent, LoggedEvent } from '../sync/events';

export const REPLAYS_MAX = 10;
/** A replay bigger than this (stored text) isn't kept: phone storage is small. */
export const REPLAY_BYTES_MAX = 120_000;
/** All of a duelist's replays together stay under this (the duelists' saves need the room more). */
export const REPLAYS_BYTES_TOTAL = 600_000;

export type ReplayKind = 'cpu' | 'online' | 'hotseat';

export interface Replay {
  id: string;
  /** when the duel ended (ms) */
  at: number;
  /** the seat this phone played (the board is shown from it) */
  seat: Pid;
  names: [string, string];
  winner: Pid | 'draw';
  reason: string;
  turns: number;
  kind: ReplayKind;
  /** the room's moves, chat and rematch votes left out */
  moves: Action[];
}

/** Room entries a replay doesn't need: chat lines and rematch votes. */
const SKIP = new Set(['CHAT', 'REMATCH']);

/** A replay of a finished duel from its room log, or null (not finished, not a Speed Duel, a Tag Duel or Boss Raid). */
export function replayOf(log: readonly { type: string }[], st: DuelState, seat: Pid, kind: ReplayKind, at = Date.now()): Replay | null {
  if (!st.started || st.winner === null || st.rules?.mode !== 'speed' || st.tag) return null;
  if (log.some((a) => a.type === 'RAID_START')) return null;
  const moves = log
    .filter((a) => !SKIP.has(a.type))
    .map((a) => {
      const { seq: _s, ts: _t, ...rest } = a as { seq?: number; ts?: number; type: string };
      // (a seat's bets and card finishes aren't kept: nothing a replay shows, and not this phone's to keep)
      if (rest.type === 'JOIN') {
        const { stakes: _k, rarity: _r, ...seat } = rest as typeof rest & { stakes?: unknown; rarity?: unknown };
        return seat as unknown as Action;
      }
      return rest as unknown as Action;
    });
  if (!moves.some((a) => a.type === 'START')) return null;
  return {
    id: `${st.seed}-${at}`,
    at,
    seat,
    names: [st.players[0].name, st.players[1].name],
    winner: st.winner,
    reason: st.winReason,
    turns: st.turn,
    kind,
    moves,
  };
}

const key = (profile: string) => `eds.replays.${profile}`;

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadReplays(profile: string): Replay[] {
  try {
    const raw = store()?.getItem(key(profile));
    const list = raw ? (JSON.parse(raw) as Replay[]) : [];
    return Array.isArray(list) ? list.filter((r) => r && Array.isArray(r.moves) && Array.isArray(r.names)) : [];
  } catch {
    return [];
  }
}

/** Keeps a replay (newest first, REPLAYS_MAX at most); a full phone drops the oldest until it fits. */
export function saveReplay(profile: string, r: Replay): boolean {
  const s = store();
  if (!s) return false;
  if (JSON.stringify(r).length > REPLAY_BYTES_MAX) return false;
  let list = [r, ...loadReplays(profile).filter((x) => x.id !== r.id)].slice(0, REPLAYS_MAX);
  while (list.length > 1 && JSON.stringify(list).length > REPLAYS_BYTES_TOTAL) list = list.slice(0, -1);
  while (list.length) {
    try {
      s.setItem(key(profile), JSON.stringify(list));
      return true;
    } catch {
      list = list.slice(0, -1);
    }
  }
  return false;
}

export function deleteReplay(profile: string, id: string) {
  const list = loadReplays(profile).filter((r) => r.id !== id);
  try {
    store()?.setItem(key(profile), JSON.stringify(list));
  } catch {
    /* nothing to do */
  }
}

/** Where each turn starts in the moves (index of the first move made in it), for skipping ahead. */
export function startIndex(r: Replay): number {
  return r.moves.findIndex((a) => a.type === 'START');
}

/** The log a replay plays from: moves handed over one at a time (nothing it is sent goes anywhere). */
export class ReplayAdapter extends AdapterBase implements SyncAdapter {
  readonly kind = 'local' as const;
  readonly isHost = true;
  readonly roomCode = null;
  constructor() {
    super();
    this.setStatus('connected', 'Replay');
  }
  /** a duel watched can't be played: the board's own sends go nowhere */
  send(_ev: GameEvent) {}
  push(moves: Action[]) {
    if (!moves.length) return;
    const n = this.events.length;
    this.events = [...this.events, ...moves.map((m, i) => ({ ...m, seq: n + i, ts: 0 }) as unknown as LoggedEvent)];
    this.emit();
  }
  close() {}
}
