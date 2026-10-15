// The random deck maker for Speed Duel decks: the Speed Duel deck rules, the Limited List,
// and a pool of the cards the duelist owns (or every card, for an "Anything goes" deck).
import { skillCards, speedCards } from './db';
import { buildRandomDeck, themesOf, type DeckRules, type RandomOptions, type RandomPool, type RandomResult } from './randomDeck';
import { getSkill } from './skills';
import { COPIES, EXTRA_MAX, MAIN_MAX, MAIN_MIN, limitStatus, unplayableReason } from './speedSave';

export const SPEED_RULES: DeckRules = { mainMin: MAIN_MIN, mainMax: MAIN_MAX, extraMax: EXTRA_MAX, copies: COPIES, extraKinds: ['Fusion', 'Xyz', 'Synchro', 'Link'], limit: limitStatus };

/** What the maker may use: owned copies (up to 3) of playable cards, or every playable card with no collection. */
export function speedPool(collection?: Record<string, number>): RandomPool {
  const cards: Record<string, number> = {};
  for (const c of speedCards()) {
    if (unplayableReason(c.name)) continue;
    const k = collection ? Math.min(COPIES, collection[c.name] ?? 0) : COPIES;
    if (k > 0) cards[c.name] = k;
  }
  const skills = skillCards()
    .filter((s) => getSkill(s.name) && (!collection || (collection[s.name] ?? 0) > 0) && limitStatus(s.name) !== 'Forbidden')
    .map((s) => s.name);
  return { cards, skills };
}

export function randomSpeedDeck(collection: Record<string, number> | undefined, opts: RandomOptions): RandomResult {
  return buildRandomDeck(speedPool(collection), SPEED_RULES, opts);
}

export function speedThemes(collection: Record<string, number> | undefined, size: number) {
  return themesOf(speedPool(collection), SPEED_RULES, size);
}
