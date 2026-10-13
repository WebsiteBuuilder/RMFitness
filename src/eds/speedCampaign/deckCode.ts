// Deck codes: a Speed Duel deck as short text a brother can paste into his phone.
// SD1.<name>.<skill>.<main>.<extra>, each list as card ids in base 36 with an optional
// "_2"/"_3" for copies, joined by "-". Names travel URI-encoded.
import { card, speedCards } from '../db';
import type { SpeedDeck } from '../speedSave';

const PREFIX = 'SD1';

function packList(names: string[]): string {
  const counts = new Map<number, number>();
  for (const n of names) {
    const id = card(n)?.id;
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts].map(([id, q]) => id.toString(36) + (q > 1 ? `_${q}` : '')).join('-');
}

let byId: Map<number, string> | null = null;
function nameOf(id: number): string | undefined {
  if (!byId) {
    byId = new Map();
    for (const c of speedCards()) if (!byId.has(c.id)) byId.set(c.id, c.name);
  }
  return byId.get(id);
}

function unpackList(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split('-').filter(Boolean)) {
    const [idText, q] = part.split('_');
    const name = nameOf(parseInt(idText, 36));
    if (!name) continue;
    for (let i = 0; i < Math.min(3, Math.max(1, Number(q) || 1)); i++) out.push(name);
  }
  return out;
}

export function deckCode(d: SpeedDeck): string {
  return [PREFIX, encodeURIComponent(d.name), d.skill ? encodeURIComponent(d.skill) : '', packList(d.main), packList(d.extra)].join('.');
}

/** The deck in a code, or null when the text isn't a deck code. */
export function readDeckCode(text: string): SpeedDeck | null {
  // A fighter code carries a pep talk after a "~"; the deck is everything before it.
  const t = text.trim().replace(/\s+/g, '').split('~')[0];
  const parts = t.split('.');
  if (parts.length !== 5 || parts[0] !== PREFIX) return null;
  try {
    const main = unpackList(parts[3]);
    if (main.length === 0) return null;
    return { id: `code-${parts[3].length}-${main.length}`, name: decodeURIComponent(parts[1]) || 'Pasted deck', skill: parts[2] ? decodeURIComponent(parts[2]) : null, main, extra: unpackList(parts[4]) };
  } catch {
    return null;
  }
}

/** A deck code with a pep talk riding along, so a brother can send his fighter as he coached it. */
export const fighterCode = (d: SpeedDeck, talk: string) => (talk.trim() ? `${deckCode(d)}~${encodeURIComponent(talk.trim().slice(0, 400))}` : deckCode(d));

/** The pep talk inside a fighter code ('' for a plain deck code). */
export function talkOf(code: string): string {
  const i = code.indexOf('~');
  if (i < 0) return '';
  try {
    return decodeURIComponent(code.slice(i + 1).replace(/\s+/g, ''));
  } catch {
    return '';
  }
}
