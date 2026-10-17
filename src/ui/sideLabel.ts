import type { Engine } from '../eds/engine';
import type { Pid, SelectOption } from '../eds/types';

/** A hidden card in a pick list says whose it is ("Face-down card" alone could be either side's). */
export function sideLabel(o: SelectOption, viewer: Pid): string {
  if (o.label !== 'Face-down card' || !o.loc) return o.label;
  return o.loc.player === viewer ? 'Your face-down card' : "Opponent's face-down card";
}

/** Whose card a pick is and, for a monster on the field, its ATK/DEF ("Yours · 2000 ATK"): a list that mixes both sides (Riryoku) can't be misread. */
export function optionNote(e: Engine, o: SelectOption, viewer: Pid): string | undefined {
  if (o.uid === undefined) return undefined;
  const f = e.fieldCard(o.uid);
  if (!f) return undefined;
  const who = e.controller(o.uid) === viewer ? 'Yours' : "Opponent's";
  if (e.find(o.uid)?.loc.zone !== 'mz' || !f.faceUp) return who;
  return f.pos === 'atk' ? `${who} · ${e.atkOf(f)} ATK` : `${who} · ${e.defOf(f)} DEF`;
}

/** True when a pick list holds cards from both sides of the field. */
export function mixedSides(e: Engine, opts: SelectOption[]): boolean {
  const sides = new Set(opts.map((o) => (o.uid !== undefined && e.fieldCard(o.uid) ? e.controller(o.uid) : null)).filter((x) => x !== null));
  return sides.size > 1;
}
