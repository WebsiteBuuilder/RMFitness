// The random deck maker for the Eternal Duelist Soul deck: exactly 40 cards from the cards
// in the Trunk and the decks, Fusions in the Fusion Deck, the Side Deck left as it is.
import { card } from './db';
import { hasEffect } from './effects';
import { buildRandomDeck, themesOf, type DeckRules, type RandomOptions, type RandomPool, type RandomResult } from './randomDeck';
import { COPIES_MAX, DECK_SIZE, FUSION_MAX, type SaveFile } from './save';

export const EDS_RULES: DeckRules = { mainMin: DECK_SIZE, mainMax: DECK_SIZE, extraMax: FUSION_MAX, copies: COPIES_MAX, extraKinds: ['Fusion'] };

/** The Egyptian Gods come in packs but cannot be used, as in EDS. */
const GODS = new Set(['Obelisk the Tormentor', 'Slifer the Sky Dragon', 'The Winged Dragon of Ra']);

/** Copies the maker may use: everything owned outside the Side Deck, less what the Side Deck already holds. */
export function edsPool(s: SaveFile): RandomPool {
  const cards: Record<string, number> = {};
  for (const n of [...Object.entries(s.trunk).flatMap(([n, k]) => Array<string>(Math.max(0, k)).fill(n)), ...s.main, ...s.fusion]) cards[n] = (cards[n] ?? 0) + 1;
  for (const n of Object.keys(cards)) {
    const c = card(n);
    const side = s.side.filter((x) => x === n).length;
    const usable = !!c && c.sub !== 'Ticket' && !GODS.has(n) && (c.vanilla || hasEffect(n));
    cards[n] = usable ? Math.max(0, Math.min(COPIES_MAX - side, cards[n])) : 0;
  }
  return { cards, skills: [] };
}

export function randomEdsDeck(s: SaveFile, opts: RandomOptions): RandomResult {
  return buildRandomDeck(edsPool(s), EDS_RULES, opts);
}

export function edsThemes(s: SaveFile) {
  return themesOf(edsPool(s), EDS_RULES, DECK_SIZE);
}

/** The save with this Main and Fusion Deck: the old cards go back to the Trunk, the new ones come out of it. */
export function withEdsDeck(s: SaveFile, main: string[], fusion: string[]): SaveFile {
  const trunk = { ...s.trunk };
  for (const n of [...s.main, ...s.fusion]) trunk[n] = (trunk[n] ?? 0) + 1;
  for (const n of [...main, ...fusion]) trunk[n] = (trunk[n] ?? 0) - 1;
  for (const n of Object.keys(trunk)) if (trunk[n] <= 0) delete trunk[n];
  return { ...s, trunk, main, fusion };
}
