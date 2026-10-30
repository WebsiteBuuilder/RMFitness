// Counters on a card in play (FieldCard.counters): Spell Counters, Fog Counters and the rest.
// The engine keeps one number per card; which counter it is comes from the card's own text.
import { card as cardInfo } from '../eds/db';
import type { FieldCard } from '../eds/types';

/** Words that start a sentence before "Counter" ("A Counter", "Place 1 Counter") and are not its name. */
const NOT_A_KIND = new Set(['A', 'An', 'The', 'Each', 'Place', 'Remove', 'That', 'This', 'Any', 'One', 'Its', 'Those']);
const kinds = new Map<string, string>();

/** The counter this card holds, by its text ("Spell", "Fog"...), or "" when the text names none. */
export function counterKind(name: string): string {
  let k = kinds.get(name);
  if (k === undefined) {
    k = '';
    const desc = cardInfo(name)?.desc ?? '';
    for (const m of desc.matchAll(/\b([A-Z][a-z]+) Counters?\b(?! Trap)/g))
      if (!NOT_A_KIND.has(m[1])) {
        k = m[1];
        break;
      }
    kinds.set(name, k);
  }
  return k;
}

/** "2 Spell Counters", "1 Fog Counter", "3 counters". */
export function counterText(c: FieldCard): string {
  const k = counterKind(c.name);
  const n = c.counters;
  return k ? `${n} ${k} Counter${n === 1 ? '' : 's'}` : `${n} counter${n === 1 ? '' : 's'}`;
}

/** Does this card in play show a counter badge? (face-up, at least one counter) */
export const showsCounters = (c: FieldCard | null | undefined): c is FieldCard => !!c && c.faceUp && c.counters > 0;

/**
 * The badge on a card holding counters: a glowing orb (violet for Spell Counters) with the
 * count. Keyed by the count, so each counter added or spent pops it again.
 */
export function CounterMark({ c }: { c: FieldCard }) {
  const k = counterKind(c.name);
  return (
    <div key={c.counters} class={`ctrmark k-${(k || 'other').toLowerCase()}`} title={counterText(c)} aria-label={counterText(c)}>
      <i />
      {c.counters}
    </div>
  );
}
