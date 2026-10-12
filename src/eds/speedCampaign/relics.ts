// Duel Labyrinth relics: passive boons for one run. Each changes how duels start (through
// Duel Conditions, so the engine treats them like any other) or how the run pays out.
import type { SeatSetup } from '../types';

export interface Relic {
  name: string;
  text: string;
  /** a card whose art shows the relic */
  art: string;
  /** Millennium Items are only found by beating Labyrinth bosses (or won on the road) */
  millennium?: boolean;
  me?: SeatSetup;
  cpu?: SeatSetup;
  /** extra Duel Points after each win */
  dp?: number;
  /** more choices when picking a card after a win */
  draftPlus?: number;
  /** extra max hearts (and a heal) when found */
  hearts?: number;
  /** cheaper shops (percent off) */
  discount?: number;
  /** heal a heart after beating a boss */
  bossHeal?: boolean;
}

export const RELICS: Relic[] = [
  { name: 'Millennium Puzzle', text: 'Start every duel with 1000 more LP and an extra card in hand.', art: 'Dark Magician', millennium: true, me: { lp: 5000, openingHand: 1 } },
  { name: 'Millennium Eye', text: 'Your opponents start with one card fewer in hand.', art: 'Toon World', millennium: true, cpu: { openingHand: -1 } },
  { name: 'Millennium Rod', text: 'Your opponents start with 1000 less LP.', art: 'Jinzo', millennium: true, cpu: { lp: 3000 } },
  { name: 'Millennium Necklace', text: 'Draw one more card for your opening hand.', art: "Gravekeeper's Chief", millennium: true, me: { openingHand: 1 } },
  { name: 'Millennium Scale', text: 'See 4 cards instead of 3 when you pick a card, and earn 10 more Duel Points a win.', art: 'Cyber Dragon', millennium: true, draftPlus: 1, dp: 10 },
  { name: 'Millennium Key', text: 'One more heart, and a heart back after every boss.', art: 'Archfiend General', millennium: true, hearts: 1, bossHeal: true },
  { name: 'Millennium Ring', text: 'Start every duel with 500 more LP; your opponents start with 500 less.', art: 'Dark Necrofear', millennium: true, me: { lp: 4500 }, cpu: { lp: 3500 } },
  { name: 'Card of Sanctity', text: 'Draw one more card for your opening hand.', art: 'Card of Sanctity', me: { openingHand: 1 } },
  { name: "Dian Keto's Blessing", text: 'Start every duel with 500 more LP.', art: 'Dian Keto the Cure Master', me: { lp: 4500 } },
  { name: 'Spellbinding Circle', text: 'Your opponents start with 500 less LP.', art: 'Spellbinding Circle', cpu: { lp: 3500 } },
  { name: 'Lucky Iron Axe', text: 'Earn 15 more Duel Points after every win.', art: 'Lucky Iron Axe', dp: 15 },
  { name: 'Card Shop Membership', text: 'Shops cost 25% less.', art: 'Card Shop Membership', discount: 25 },
  { name: 'Sixth Sense', text: 'See 4 cards instead of 3 when you pick a card.', art: 'Sixth Sense', draftPlus: 1 },
  { name: 'Mystic Box', text: 'One more heart.', art: 'Mystic Box', hearts: 1 },
  { name: 'Sogen Scroll', text: 'Start every duel with Sogen already on your field.', art: 'Sogen', me: { field: 'Sogen' } },
  { name: 'Umi Scroll', text: 'Start every duel with Umi already on your field.', art: 'Umi', me: { field: 'Umi' } },
  { name: 'Yami Scroll', text: 'Start every duel with Yami already on your field.', art: 'Yami', me: { field: 'Yami' } },
  { name: 'Forest Scroll', text: 'Start every duel with Forest already on your field.', art: 'Forest', me: { field: 'Forest' } },
  { name: 'Wasteland Scroll', text: 'Start every duel with Wasteland already on your field.', art: 'Wasteland', me: { field: 'Wasteland' } },
  { name: 'Mountain Scroll', text: 'Start every duel with Mountain already on your field.', art: 'Mountain', me: { field: 'Mountain' } },
  { name: 'Phoenix Feather', text: 'A heart back after every boss.', art: 'Monster Reborn', bossHeal: true },
];

export const relic = (name: string) => RELICS.find((r) => r.name === name);
export const MILLENNIUM = RELICS.filter((r) => r.millennium).map((r) => r.name);
export const COMMON_RELICS = RELICS.filter((r) => !r.millennium).map((r) => r.name);

/**
 * Folds several setups into one: LP changes add up as differences from 4000,
 * opening-hand changes add up, cards in play and in hand stack (one Field Spell).
 */
export function mergeSetups(list: (SeatSetup | undefined)[], baseLp = 4000): SeatSetup {
  const out: SeatSetup = {};
  let lpDelta = 0;
  let lpSet = false;
  for (const s of list) {
    if (!s) continue;
    if (s.lp) {
      lpDelta += s.lp - baseLp;
      lpSet = true;
    }
    if (s.openingHand) out.openingHand = (out.openingHand ?? 0) + s.openingHand;
    if (s.field && !out.field) out.field = s.field;
    if (s.monsters) out.monsters = [...(out.monsters ?? []), ...s.monsters];
    if (s.spells) out.spells = [...(out.spells ?? []), ...s.spells];
    if (s.hand) out.hand = [...(out.hand ?? []), ...s.hand];
  }
  if (lpSet) out.lp = Math.max(500, baseLp + lpDelta);
  return out;
}
