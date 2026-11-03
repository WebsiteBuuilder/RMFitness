// The chain spotlight's timing (chainSpot.ts draws it, runtime.ts plays it): kept apart so
// the tests and the director can read it without the DOM.
import { card } from '../eds/db';
import type { ChainCard } from './cues';

/** How long the chain's lift plays (cinematic seconds) for `n` links. */
export const stackDuration = (n: number) => Math.min(1.05, 0.4 + 0.17 * Math.max(1, n));
/** Link i (0-based) starts its lift this long after the one before (a long chain lifts faster). */
export const liftStep = (n: number) => Math.min(0.17, 0.5 / Math.max(1, n));
/** How long one link's spotlight plays: long enough to read its first lines (a tap pauses for all of it). */
export function resolveDuration(c: Pick<ChainCard, 'card' | 'negated'>): number {
  if (c.negated) return 1.35;
  const len = card(c.card.name)?.desc.length ?? 0;
  return Math.min(2.1, 1.3 + len / 450);
}
/** The chain folding away. */
export const END_DURATION = 0.35;
