// Counters on a card in play. The engine keeps them in three places: FieldCard.counters (Spell
// Counters and most others: which counter it is comes from the card's own text), tags.fog
// (Fog Counters, on any monster a Cloudian card fogs) and tags.crystallization (Rainbow
// Crystal Collection). A Skill's counters sit on its skill card (Engine.skillCard).
import { card as cardInfo } from '../eds/db';
import type { FieldCard } from '../eds/types';

/** Words that start a sentence before "Counter" ("A Counter", "Place 1 Counter") and are not its name. */
const NOT_A_KIND = new Set(['A', 'An', 'The', 'Each', 'Place', 'Remove', 'That', 'This', 'Any', 'One', 'Its', 'Those']);
const kinds = new Map<string, string>();

/** The counter this card's text names ("Spell", "Dig"...), or "" when it names none. */
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

export interface Counters {
  /** "Spell", "Fog", "Crystallization"..., or "" for a counter the text gives no name */
  kind: string;
  n: number;
  /** the most this card can hold, when its text says ("(max. 3)") */
  max?: number;
}

const maxes = new Map<string, number | undefined>();
/** The cap the card's text puts on its counters ("(max. 3)"), if any. */
function counterMax(name: string): number | undefined {
  if (!maxes.has(name)) {
    const m = (cardInfo(name)?.desc ?? '').match(/\(max\.?\s*(\d+)\)/);
    maxes.set(name, m ? Number(m[1]) : undefined);
  }
  return maxes.get(name);
}

/** Every kind of counter on this card, in a fixed order (none: an empty list). */
export function countersOf(c: FieldCard | null | undefined): Counters[] {
  if (!c) return [];
  const out: Counters[] = [];
  if (c.counters > 0) out.push({ kind: counterKind(c.name), n: c.counters, max: counterMax(c.name) });
  const fog = c.tags?.fog ?? 0;
  if (fog > 0) out.push({ kind: 'Fog', n: fog });
  const crystal = c.tags?.crystallization ?? 0;
  if (crystal > 0) out.push({ kind: 'Crystallization', n: crystal });
  return out;
}

/** "2 Spell Counters", "1 Fog Counter", "3 counters". */
export const counterText = ({ kind, n, max }: Counters): string =>
  (kind ? `${n} ${kind} Counter${n === 1 ? '' : 's'}` : `${n} counter${n === 1 ? '' : 's'}`) + (max !== undefined && n >= max ? ' (full)' : '');

/** The count each card's badges last showed (uid → kind → n), so a counter gained floats a "+1". */
const lastShown = new Map<number, Map<string, number>>();

/** The counters a card in play shows: face-up cards only (a face-down card shows nothing of itself). */
export const shownCounters = (c: FieldCard | null | undefined): Counters[] => (c && c.faceUp ? countersOf(c) : []);

/** A short key of what the badges show (for a memoized zone's redraw signature). */
export const countersKey = (list: Counters[]): string => list.map((x) => `${x.kind}${x.n}/${x.max ?? ''}`).join(',');

/**
 * The badges on a card holding counters: a glowing orb (violet for Spell Counters, grey for Fog,
 * gold for the rest) with the count, one per kind. Each is keyed by its count, so every counter
 * added or spent pops it again.
 */
export function CounterMarks({ list, uid }: { list: Counters[]; uid?: number }) {
  // what changed since this card's badges were last drawn (a gain floats "+1")
  const seen = uid === undefined ? null : lastShown.get(uid) ?? new Map<string, number>();
  if (seen && uid !== undefined) {
    if (list.length) lastShown.set(uid, seen);
    else lastShown.delete(uid);
    if (lastShown.size > 64) lastShown.delete(lastShown.keys().next().value!);
  }
  if (list.length === 0) return null;
  return (
    <div class="ctrmarks">
      {list.map((x) => {
        const was = seen?.get(x.kind) ?? 0;
        seen?.set(x.kind, x.n);
        const full = x.max !== undefined && x.n >= x.max;
        return (
          <div key={`${x.kind}${x.n}`} class={`ctrmark k-${(x.kind || 'other').toLowerCase()}${full ? ' full' : ''}`} title={counterText(x)} aria-label={counterText(x)}>
            <i />
            {full ? `${x.n}/${x.max}` : x.n}
            {seen && x.n > was && <b class="ctrplus">+{x.n - was}</b>}
          </div>
        );
      })}
    </div>
  );
}

/** The counters as words, for a card preview: an orb and "2 Spell Counters" per kind. */
export function CounterLines({ list }: { list: Counters[] }) {
  return (
    <>
      {list.map((x) => (
        <span key={x.kind} class="tdetail-ctr">
          <span class={`ctrmark k-${(x.kind || 'other').toLowerCase()}`}>
            <i />
          </span>
          <span>{counterText(x)}</span>
        </span>
      ))}
    </>
  );
}
