// Card scripts for the Speed Duel card pool: every Speed Duel card that is not
// already scripted for The Eternal Duelist Soul. Each batch file adds its cards to
// the shared table; the EDS scripts (effects.ts, effects2.ts) win on any overlap.
import type { EffectDef } from '../effects';
import type { SpeedHelpers } from './helpers';
import { builtinExtraProc } from './extra';
import { setExtraProcs } from '../effects';
import { install as b00 } from './cards-00';
import { install as b01 } from './cards-01';
import { install as b02 } from './cards-02';
import { install as b03 } from './cards-03';
import { install as b04 } from './cards-04';
import { install as b05 } from './cards-05';
import { install as b06 } from './cards-06';
import { install as b07 } from './cards-07';
import { install as b08 } from './cards-08';
import { install as b09 } from './cards-09';
import { install as b10 } from './cards-10';
import { install as b11 } from './cards-11';
import { install as b12 } from './cards-12';
import { install as b15 } from './cards-15';
import { install as b16 } from './cards-16';
import { install as b14 } from './cards-14';
import { install as b13 } from './cards-13';
import { install as b18 } from './cards-18';

type Installer = (table: Record<string, EffectDef>, h: SpeedHelpers) => void;
const BATCHES: [string, Installer][] = [
  ['00', b00],
  ['01', b01],
  ['02', b02],
  ['03', b03],
  ['04', b04],
  ['05', b05],
  ['06', b06],
  ['07', b07],
  ['08', b08],
  ['09', b09],
  ['10', b10],
  ['11', b11],
  ['12', b12],
  ['15', b15],
  ['16', b16],
  ['14', b14],
  ['13', b13],
  ['18', b18],
];

/** Which batch file scripted each Speed Duel card (tests focus on one batch with it). */
export const SPEED_BATCH: Record<string, string> = {};

export function installSpeed(E: Record<string, EffectDef>, h: SpeedHelpers) {
  setExtraProcs(builtinExtraProc);
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
