import type { Engine } from '../eds/engine';

export interface Forecast {
  /** "1500 vs 1700" */
  vs: string;
  /** what happens */
  text: string;
  tone: 'good' | 'mid' | 'bad';
}

/** What an attack would do, shown while it is dragged onto a target (face-down targets are a guess). */
export function attackForecast(e: Engine, uid: number, target: number | null): Forecast | null {
  const a = e.fieldCard(uid);
  if (!a) return null;
  const atk = e.atkOf(a);
  if (target === null) return { vs: `${atk} direct`, text: `${atk} damage`, tone: 'good' };
  const t = e.fieldCard(target);
  if (!t) return null;
  if (!t.faceUp) return { vs: `${atk} vs ?`, text: 'face-down: flips when hit', tone: 'mid' };
  if (t.pos === 'atk') {
    const v = e.atkOf(t);
    if (atk > v) return { vs: `${atk} vs ${v}`, text: `destroys it · ${atk - v} damage`, tone: 'good' };
    if (atk === v) return { vs: `${atk} vs ${v}`, text: 'both destroyed', tone: 'mid' };
    return { vs: `${atk} vs ${v}`, text: `yours is destroyed · you take ${v - atk}`, tone: 'bad' };
  }
  const d = e.defOf(t);
  if (atk > d) return { vs: `${atk} vs DEF ${d}`, text: 'destroys it · no damage', tone: 'good' };
  if (atk === d) return { vs: `${atk} vs DEF ${d}`, text: 'nothing happens', tone: 'mid' };
  return { vs: `${atk} vs DEF ${d}`, text: `you take ${d - atk}`, tone: 'bad' };
}
