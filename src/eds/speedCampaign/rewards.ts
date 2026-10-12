// The reward sink: where a campaign or Labyrinth reward goes. Cards and Skills land in the
// profile's one Speed Duel collection; Items and titles on the trophy shelf; Soul Fragments
// in the Labyrinth. A pack is opened by whatever pack opener is registered, so a later
// card-earning feature (real Speed Duel sets) can take packs over without touching this.
import { CHIP_CAP, withCards, type SpeedSave } from '../speedSave';
import { rng } from '../rng';
import type { SoloSave } from './save';
import type { Reward } from './types';

/** Opens a pack: returns the cards in it. `pool` is the campaign's own fallback pool. */
export type PackOpener = (set: string | undefined, pool: string[], seed: number) => string[];

const fallbackOpener: PackOpener = (_set, pool, seed) => {
  const next = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < 5 && pool.length; i++) out.push(pool[Math.floor(next() * pool.length)]);
  return out;
};

let opener: PackOpener = fallbackOpener;
/** Lets a collection feature open packs its own way (real sets, rarities). */
export function registerPackOpener(o: PackOpener) {
  opener = o;
}

export interface Granted {
  speed: SpeedSave;
  solo: SoloSave;
  /** what to show the player, one line per reward */
  lines: string[];
  /** every card added, for the reveal */
  cards: string[];
}

export function grant(speed: SpeedSave, solo: SoloSave, rewards: Reward[], pool: string[] = [], seed = Date.now()): Granted {
  const lines: string[] = [];
  const cards: string[] = [];
  let campaign = solo.campaign;
  let chips = speed.chips ?? 0;
  let labyrinth = solo.labyrinth;
  for (const r of rewards) {
    switch (r.kind) {
      case 'card':
        cards.push(r.name);
        lines.push(r.name);
        break;
      case 'skill':
        cards.push(r.name);
        lines.push(`Skill: ${r.name}`);
        break;
      case 'pack': {
        const got = opener(r.set, pool, seed++);
        cards.push(...got);
        lines.push(`${r.set ?? 'A booster pack'}: ${got.join(', ')}`);
        break;
      }
      case 'item':
        if (!campaign.items.includes(r.name)) campaign = { ...campaign, items: [...campaign.items, r.name] };
        lines.push(r.name);
        break;
      case 'title':
        if (!campaign.titles.includes(r.name)) campaign = { ...campaign, titles: [...campaign.titles, r.name] };
        lines.push(`Title: ${r.name}`);
        break;
      case 'chips':
        chips = Math.min(CHIP_CAP, chips + r.n);
        lines.push(`${r.n} Duel Chip${r.n === 1 ? '' : 's'}`);
        break;
      case 'shards':
        labyrinth = { ...labyrinth, fragments: labyrinth.fragments + r.n };
        lines.push(`${r.n} Soul Fragments`);
        break;
    }
  }
  let out = cards.length ? withCards(speed, cards) : speed;
  if (chips !== (speed.chips ?? 0)) out = { ...out, chips };
  return { speed: out, solo: { ...solo, campaign, labyrinth }, lines, cards };
}
