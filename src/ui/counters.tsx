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
/** Counters just gained ("uid:kind" → when, how many, the count then): their "+N" is in flight. */
const gains = new Map<string, { at: number; d: number; n: number }>();
/** How long a "+N" floats (arena's ctr-plus animation). */
const GAIN_MS = 1600;

/** The counters a card in play shows: face-up cards only (a face-down card shows nothing of itself). */
export const shownCounters = (c: FieldCard | null | undefined): Counters[] => (c && c.faceUp ? countersOf(c) : []);

/** A short key of what the badges show (for a memoized zone's redraw signature). */
export const countersKey = (list: Counters[]): string => list.map((x) => `${x.kind}${x.n}/${x.max ?? ''}`).join(',');

/**
 * The badges on a card holding counters: a glowing orb (violet for Spell Counters, grey for Fog,
 * gold for the rest) with the count, one per kind. Each is keyed by its count, so every counter
 * added or spent pops it again.
 */
/**
 * Notes the counters these cards hold now without floating "+N" for them: a duel screen does
 * this for the field as it opens, so counters already there are not shown as just gained.
 */
export function primeCounters(cards: (FieldCard | null | undefined)[]): void {
  for (const c of cards) if (c) lastShown.set(c.uid, new Map(shownCounters(c).map((x) => [x.kind, x.n])));
}

/** Notes the cards holding no counters right now, so the first one they gain floats "+1". */
export function noteCounterless(cards: (FieldCard | null | undefined)[]): void {
  for (const c of cards) if (c && shownCounters(c).length === 0 && lastShown.get(c.uid)?.size !== 0) lastShown.set(c.uid, new Map());
}

export function CounterMarks({ list, uid }: { list: Counters[]; uid?: number }) {
  // what changed since this card's badges were last drawn (a gain floats "+1"); a card never
  // seen before floats nothing for counters it already had (an opponent's card turning up)
  const before = uid === undefined ? undefined : lastShown.get(uid);
  if (uid !== undefined) {
    lastShown.set(uid, new Map(list.map((x) => [x.kind, x.n])));
    if (lastShown.size > 64) lastShown.delete(lastShown.keys().next().value!);
    if (gains.size > 32) gains.delete(gains.keys().next().value!);
  }
  if (list.length === 0) return null;
  return (
    <div class="ctrmarks">
      {list.map((x) => {
        const was = before ? before.get(x.kind) ?? 0 : x.n;
        const full = x.max !== undefined && x.n >= x.max;
        // a gain is remembered for the floater's whole flight (the screen redraws meanwhile)
        const gk = `${uid}:${x.kind}`;
        if (uid !== undefined && x.n > was) gains.set(gk, { at: performance.now(), d: x.n - was, n: x.n });
        const gain = gains.get(gk);
        const flying = gain && gain.n === x.n && performance.now() - gain.at < GAIN_MS ? gain : null;
        return (
          <div key={`${x.kind}${x.n}`} class={`ctrmark k-${(x.kind || 'other').toLowerCase()}${full ? ' full' : ''}`} title={counterText(x)} aria-label={counterText(x)}>
            <i />
            {full ? `${x.n}/${x.max}` : x.n}
            {flying && <b key={flying.at} class="ctrplus">+{flying.d}</b>}
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
          <span>{x.max !== undefined ? `${x.n}/${x.max} ${x.kind ? `${x.kind} Counters` : 'counters'}` : counterText(x)}</span>
        </span>
      ))}
    </>
  );
}
