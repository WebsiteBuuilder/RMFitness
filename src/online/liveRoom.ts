// The online room a duelist is playing in, kept on the phone so a refresh, a crash or a closed
// app opens straight back into the same duel (the room itself lives on the online service).
import type { GameMode } from '../eds/types';

export type LiveRoom = { room: string; host: boolean; mode: GameMode; at: number };

/** A room this old (since its last move) isn't reopened: the other side has long had the win. */
const KEEP_MS = 15 * 60_000;
const key = (id: string) => `eds.liveRoom.${id}`;

export function liveRoomOf(id: string): LiveRoom | null {
  try {
    const r = JSON.parse(localStorage.getItem(key(id)) ?? 'null') as LiveRoom | null;
    if (!r || typeof r.room !== 'string' || Date.now() - r.at > KEEP_MS) return null;
    return r;
  } catch {
    return null;
  }
}

export function setLiveRoom(id: string, r: Omit<LiveRoom, 'at'> | null) {
  try {
    if (r) localStorage.setItem(key(id), JSON.stringify({ ...r, at: Date.now() }));
    else localStorage.removeItem(key(id));
  } catch {
    /* storage full */
  }
}

/** Still in the room: keeps it fresh. */
export function touchLiveRoom(id: string, room: string) {
  const r = liveRoomOf(id);
  if (r?.room === room) setLiveRoom(id, r);
}
