// The rules behind the duel's weather and time of day (Weather.tsx, art/weather.ts).
// No DOM here (the tests run it in Node).
//   Time of day follows the duel's turns: it opens in the afternoon, the light turns gold,
//     then dusk, then night for a long duel.
//   The sky follows the soundtrack's levels (music.ts levelFor): clear while both duelists
//     are above 2000 LP, clouds and rain when either is at 2000 or less (when the drums come
//     in), a storm with lightning on the music's bar lines at 1000 or less.
//   A Field Spell can change what falls: ash and embers over a volcano, rain everywhere else.
//   When the duel is won, the storm breaks and the sky clears.
import type { DuelState } from '../eds/types';
import type { Terrain } from '../art/families';
import { fieldTerrain } from './atmosphereRules';

export type TimeOfDay = 'day' | 'golden' | 'dusk' | 'night';
export type Sky = 'clear' | 'rain' | 'storm';
export type Precip = 'rain' | 'ash' | 'sand';

/**
 * The shortest gap between two lightning strikes (ms). Each strike flickers twice, so this
 * keeps the screen under three flashes a second (photosensitivity); never lower than 1500.
 */
export const STRIKE_GAP = 1800;

export interface Weather {
  tod: TimeOfDay;
  sky: Sky;
  precip: Precip;
}

/** The light for a turn number (turn 1 is the first turn of the duel). */
export function timeOfDay(turn: number): TimeOfDay {
  return turn <= 2 ? 'day' : turn <= 4 ? 'golden' : turn <= 6 ? 'dusk' : 'night';
}

/** The sky for the duelists' Life Points; the same lines as the soundtrack's levels. */
export function skyFor(lps: number[]): Sky {
  const low = Math.min(...lps);
  return low <= 1000 ? 'storm' : low <= 2000 ? 'rain' : 'clear';
}

/** What falls, given the Field Spells up. ('sand' stays in the type for the canvas; no field calls it now.) */
export function precipFor(terrains: (Terrain | null)[]): Precip {
  if (terrains.includes('volcano')) return 'ash';
  return 'rain';
}

export function weatherFor(state: DuelState): Weather {
  const over = state.winner !== null && state.winner !== undefined;
  return {
    tod: timeOfDay(state.turn ?? 1),
    sky: over ? 'clear' : skyFor(state.players.map((p) => p.lp)),
    precip: precipFor([fieldTerrain(state, 0), fieldTerrain(state, 1)]),
  };
}
