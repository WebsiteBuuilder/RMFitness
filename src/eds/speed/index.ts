// Card scripts for the Speed Duel card pool: every Speed Duel card that is not
// already scripted for The Eternal Duelist Soul. Each batch file adds its cards to
// the shared table; the EDS scripts (effects.ts, effects2.ts) win on any overlap.
import type { EffectDef } from '../effects';
import type { SpeedHelpers } from './helpers';
import { install as b00 } from './cards-00';

type Installer = (table: Record<string, EffectDef>, h: SpeedHelpers) => void;
const BATCHES: [string, Installer][] = [['00', b00]];

/** Which batch file scripted each Speed Duel card (tests focus on one batch with it). */
export const SPEED_BATCH: Record<string, string> = {};

export function installSpeed(E: Record<string, EffectDef>, h: SpeedHelpers) {
  for (const [id, install] of BATCHES) {
    const table: Record<string, EffectDef> = {};
    install(table, h);
    for (const [name, def] of Object.entries(table)) {
      if (E[name]) continue;
      E[name] = def;
      SPEED_BATCH[name] = id;
    }
  }
}
