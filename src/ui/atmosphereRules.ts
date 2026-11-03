// The rules behind the duel's atmosphere (Atmosphere.tsx): when a duelist is in danger
// and which landscape their Field Spell paints. No DOM here (the tests run it in Node).
import type { DuelState, Pid } from '../eds/types';
import { card } from '../eds/db';
import { fxFamilyOf, type Terrain } from '../art/families';

/** 0 safe, 1 low (a quarter of the starting LP or less), 2 very low (an eighth or less). */
export function dangerLevel(lp: number, speed: boolean): 0 | 1 | 2 {
  const start = speed ? 4000 : 8000;
  if (lp <= 0) return 0;
  if (lp <= start / 8) return 2;
  if (lp <= start / 4) return 1;
  return 0;
}

/** The landscape a duelist's face-up Field Spell paints (null: none up). */
export function fieldTerrain(state: DuelState, p: Pid): Terrain | null {
  const f = state.players[p].field;
  if (!f || !f.faceUp) return null;
  const info = card(f.name);
  if (!info || info.sub !== 'Field') return null;
  return fxFamilyOf(f.name)?.terrain ?? null;
}
