// The playmats of the duel on screen: each side's, as a class on its half of the field.
import { useEffect, useState } from 'preact/hooks';
import type { Pid } from '../eds/types';
import { fxUrl, grainUrl, matUrl, PLAYMAT_GRAIN, trimUrl } from './art';
import { playmatDef, type PlaymatId } from './roster';

let duelMats: [PlaymatId | null, PlaymatId | null] = [null, null];
const listeners = new Set<() => void>();

/** The duel screen calls this with each side's mat (null to stop: the field is the plain arena). */
export function showDuelPlaymats(m: [PlaymatId | null | undefined, PlaymatId | null | undefined] | null) {
  const next: [PlaymatId | null, PlaymatId | null] = m ? [m[0] ?? null, m[1] ?? null] : [null, null];
  if (next[0] === duelMats[0] && next[1] === duelMats[1]) return;
  duelMats = next;
  // (the halves already on screen dress again: a seat's mat can reach this phone after the duel starts)
  for (const fn of listeners) fn();
}
/** The halves re-render when the duel's mats change (they almost never do mid-duel). */
export function useDuelPlaymats(): void {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    listeners.add(fn);
    return () => void listeners.delete(fn);
  }, []);
}
/** The mat under a side's half in the duel on screen (null: none). */
export function duelPlaymatOf(side: Pid | undefined): PlaymatId | null {
  return side === 0 || side === 1 ? duelMats[side] : null;
}

/** The mats' rules, written into the page once each the first time a mat shows (one class per mat). */
const written = new Set<string>();
let sheet: HTMLStyleElement | null = null;
function writeRule(id: PlaymatId) {
  if (typeof document === 'undefined' || (written.has(id) && sheet?.isConnected)) return;
  if (!sheet || !sheet.isConnected) {
    written.clear();
    sheet = document.createElement('style');
    sheet.dataset.playmats = '';
    document.head.appendChild(sheet);
    // (the one grain tile every mat shares)
    sheet.appendChild(document.createTextNode(`:root{--pm-grain-img:${grainUrl()}}\n`));
  }
  written.add(id);
  const d = playmatDef(id)!;
  sheet.appendChild(
    document.createTextNode(`.pm-id-${id}{--pm-img:${matUrl(id)};--pm-trim:${trimUrl(id)};--pm-fx:${fxUrl(d.fx, d.fxColor)};--pm-fx-c:${d.fxColor};--pm-line:${d.line};--pm-glow:${d.glow};--pm-grain:${PLAYMAT_GRAIN[id]}}\n`),
  );
}
/** The classes that dress a half (or a picker preview) in a mat. */
export function playmatClass(id: PlaymatId | null | undefined): string {
  const d = playmatDef(id);
  if (!d) return '';
  writeRule(d.id);
  return ` pm-id-${d.id} pm-fx-${d.fx}${d.bright ? ' pm-bright' : ''}`;
}

// (debug builds: window.__pm(opp, mine) lays any two mats on the duel on screen)
if (typeof location !== 'undefined' && location.search.includes('debug')) {
  (window as unknown as Record<string, unknown>).__pm = (a: PlaymatId, b: PlaymatId) => showDuelPlaymats([a, b]);
}
