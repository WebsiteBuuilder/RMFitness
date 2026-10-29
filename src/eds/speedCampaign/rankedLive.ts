// A Ranked Duel in progress, kept move by move on this phone (`eds.rankedlive.<profile id>`),
// so a duel cut off by the app closing, the phone killing it or an update reload picks up
// where it stopped instead of counting as a loss. The engine is deterministic from START's
// seed, so playing the kept moves back rebuilds the same board.
import type { LoggedEvent } from '../../sync/events';
import type { CpuDuelSpec } from './types';

export interface RankedLive {
  /** the season the duel was started in (a turned month drops it) */
  season: string;
  spec: CpuDuelSpec;
  startLp: number;
  /** the duel's room log so far */
  log: LoggedEvent[];
  /** when it was last written (ms) */
  at: number;
}

const key = (profileId: string) => `eds.rankedlive.${profileId}`;

export function loadRankedLive(profileId: string): RankedLive | null {
  try {
    const raw = localStorage.getItem(key(profileId));
    if (!raw) return null;
    const v = JSON.parse(raw) as RankedLive;
    return v && typeof v.season === 'string' && v.spec?.context?.kind === 'ranked' && Array.isArray(v.log) && v.log.some((e) => e.type === 'START') ? v : null;
  } catch {
    return null;
  }
}

export function saveRankedLive(profileId: string, live: RankedLive): void {
  try {
    localStorage.setItem(key(profileId), JSON.stringify(live));
  } catch {
    // (a full phone: the duel just can't be resumed, and a cut-off duel then has no result)
  }
}

export function clearRankedLive(profileId: string): void {
  try {
    localStorage.removeItem(key(profileId));
  } catch {
    /* ignore */
  }
}
