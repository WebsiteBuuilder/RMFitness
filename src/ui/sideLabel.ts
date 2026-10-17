import type { Pid, SelectOption } from '../eds/types';

/** A hidden card in a pick list says whose it is ("Face-down card" alone could be either side's). */
export function sideLabel(o: SelectOption, viewer: Pid): string {
  if (o.label !== 'Face-down card' || !o.loc) return o.label;
  return o.loc.player === viewer ? 'Your face-down card' : "Opponent's face-down card";
}
