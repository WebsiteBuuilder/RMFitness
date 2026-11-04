// The sleeves of the duel on screen: each side's, as a class on its face-down cards.
import { useEffect, useState } from 'preact/hooks';
import type { Pid } from '../eds/types';
import { sleeveUrl } from './art';
import { DEFAULT_SLEEVE, sleeveDef, type SleeveId } from './roster';

// ---------- the duel on screen ----------
let duelSleeves: [SleeveId | null, SleeveId | null] = [null, null];

/** The duel screen calls this with each side's sleeve (null to stop: every back is the classic one). */
export function showDuelSleeves(s: [SleeveId | null | undefined, SleeveId | null | undefined] | null) {
  const next: [SleeveId | null, SleeveId | null] = s ? [s[0] ?? null, s[1] ?? null] : [null, null];
  if (next[0] === duelSleeves[0] && next[1] === duelSleeves[1]) return;
  duelSleeves = next;
  // (card backs already on screen dress again: a seat's sleeve can reach this phone after its cards do)
  for (const fn of listeners) fn();
}
const listeners = new Set<() => void>();
/** A card back re-renders when the duel's sleeves change (they almost never do mid-duel). */
export function useDuelSleeves(): void {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    listeners.add(fn);
    return () => void listeners.delete(fn);
  }, []);
}
/** The sleeve a side's cards wear in the duel on screen (null: the classic back). */
export function duelSleeveOf(owner: Pid | undefined): SleeveId | null {
  return owner === 0 || owner === 1 ? duelSleeves[owner] : null;
}

/** The sleeves' rules, written into the page once each the first time a sleeve shows (one class per
 *  sleeve, so a card back carries a short class name instead of its whole picture). */
const written = new Set<string>();
let sheet: HTMLStyleElement | null = null;
function writeRule(id: SleeveId) {
  if (typeof document === 'undefined' || (written.has(id) && sheet?.isConnected)) return;
  written.add(id);
  if (!sheet || !sheet.isConnected) {
    // (a new sheet: every sleeve is written again as it shows)
    written.clear();
    written.add(id);
    sheet = document.createElement('style');
    sheet.dataset.sleeves = '';
    document.head.appendChild(sheet);
  }
  sheet.appendChild(document.createTextNode(`.slv-id-${id}{--card-back-img:${sleeveUrl(id)};--sleeve-glow:${sleeveDef(id)?.glow ?? '#ffb04a'}}\n`));
}
/** The class that dresses a card back (or anything holding one) in a sleeve ('' : the classic back from graphics.css). */
export function sleeveClass(id: SleeveId | null | undefined): string {
  if (!id || id === DEFAULT_SLEEVE || !sleeveDef(id)) return '';
  writeRule(id);
  return ` slv-id-${id}`;
}
/** The class a sleeve's light adds where it is allowed to move (the deck pile, the picker). */
export const sleeveShineClass = (id: SleeveId | null | undefined): string => {
  const sh = sleeveDef(id)?.shine;
  return sh ? ` slv-shine slv-${sh}` : '';
};
