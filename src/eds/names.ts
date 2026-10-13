// Card names after effects: "This card's name becomes "Harpie Lady" while on the field or in the GY",
// "(This card's name is always treated as "Umi".)", "(This card is always treated as an "Archfiend" card.)".
// Read once from each card's own text; the engine's namesOf() adds the names effects give during a duel.
import type { Engine } from './engine';
import type { CardInfo } from './types';

export interface NameRule {
  /** Names (or archetypes) the card also has everywhere: hand, Deck, field, GY, banished. */
  also: string[];
  /** The name it has instead while it is on the field (and in the GY, if `gy`). */
  becomes?: { name: string; gy: boolean; faceUpOnly: boolean; gemini: boolean };
}

const RULES = new Map<string, NameRule>();
const Q = `["“]([^"”]+)["”]`;
const ALSO = new RegExp(`(?:name is|card is|is also) always treated as (?:an? )?${Q}`, 'g');
const BECOMES = new RegExp(`(●[^●]*?)?name becomes ${Q} while (?:it is )?(face-up )?on the field( or in the (?:GY|Graveyard))?`);

/** The name rule printed on a card. */
export function nameRule(info: CardInfo): NameRule {
  let r = RULES.get(info.name);
  if (r) return r;
  const desc = (info.desc ?? '').replace(/\s+/g, ' ');
  r = { also: [...desc.matchAll(ALSO)].map((m) => m[1]).filter((n) => n !== info.name) };
  const b = desc.match(BECOMES);
  // The name sentence of a Gemini monster (Neos Alius) only applies while it is an Effect Monster.
  if (b) r.becomes = { name: b[2], gy: !!b[4], faceUpOnly: true, gemini: !!b[1] };
  RULES.set(info.name, r);
  return r;
}

/** The engine of the duel being played, for name checks in helpers that are not handed one (Engine sets it). */
let current: Engine | null = null;
export function setNameEngine(e: Engine) {
  current = e;
}
/** The current duel's engine; helpers that only get a card use it to read the card's current names. */
export function nameEngine() {
  if (!current) throw new Error('no duel engine for card names');
  return current;
}
