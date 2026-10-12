// Starter deck generation, exactly like EDS: 13 fixed cards from pools 1 and 5,
// plus random single picks from pools 2-4 and 6-11 in the colour's proportions.
import pools from './data/starterPools.json';
import { rng } from './rng';

export type StarterColor = 'Black' | 'Red' | 'Green';
export const STARTER_COLORS: StarterColor[] = ['Red', 'Green', 'Black'];
export const STARTER_BLURB: Record<StarterColor, string> = {
  Red: 'Leans on Pool 6: Dragons and Warriors like Axe Raider and Celtic Guardian.',
  Green: 'Leans on Pool 7: Beasts and brawlers like Battle Ox and Harpie Lady.',
  Black: 'Leans on Pool 8: Aqua and Insect monsters like Aqua Madoor and Rogue Doll.',
};

export function buildStarterDeck(color: StarterColor, seed: number): string[] {
  const next = rng(seed);
  const deck: string[] = [...pools.fixed['1'], ...pools.fixed['5']];
  const counts = (pools.counts as Record<StarterColor, Record<string, number>>)[color];
  for (const [pool, n] of Object.entries(counts)) {
    const list = ((pools.pools as Record<string, string[]>)[pool] ?? []).slice();
    for (let i = 0; i < n && list.length; i++) {
      const j = Math.floor(next() * list.length);
      deck.push(list.splice(j, 1)[0]);
    }
  }
  return deck;
}

export const STARTER_POOL_NAMES: string[] = [...new Set([...Object.values(pools.fixed).flat(), ...Object.values(pools.pools).flat()])];
