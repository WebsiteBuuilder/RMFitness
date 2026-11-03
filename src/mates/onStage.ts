// Which Mate stands by each seat right now (the duel's Mate layer keeps it up to date), so a
// cinematic can show it yelling along with an attack callout. null: no Mate shown there.
import type { Pid } from '../eds/types';
import type { MateId } from './roster';

let shown: [MateId | null, MateId | null] = [null, null];
let voices: [number, number] = [0, 0];

export function setStageMates(ids: [MateId | null, MateId | null], v: [number, number] = [0, 0]) {
  shown = ids;
  voices = v;
}
export const stageMate = (p: Pid): MateId | null => shown[p] ?? null;
export const stageMateVoice = (p: Pid): number => voices[p] ?? 0;
