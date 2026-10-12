// Campaign: the 24 duelists of the original in five stages, their real decks,
// and the unlock rules for stages and booster packs.
import duelistData from './data/duelists.json';
import type { SaveFile } from './save';

export interface Duelist {
  name: string;
  tier: number;
  deck: string[];
  fusion: string[];
  unlock?: string;
}

interface RawDuelist {
  name: string;
  tier: number;
  unlock?: string;
  deck: { name: string; qty: number; fusion?: boolean }[] | null;
}

export const DUELISTS: Duelist[] = (duelistData as RawDuelist[]).map((d) => {
  const deck: string[] = [];
  const fusion: string[] = [];
  for (const c of d.deck ?? []) for (let i = 0; i < c.qty; i++) (c.fusion ? fusion : deck).push(c.name);
  return { name: d.name, tier: d.tier, deck, fusion, unlock: d.unlock };
});

export const STAGE_WINS_NEEDED: Record<number, number> = { 2: 2, 3: 3, 4: 4, 5: 5 };

export const DISPLAY_NAME: Record<string, string> = { 'Tea Gardner': 'Téa Gardner' };
export const displayName = (n: string) => DISPLAY_NAME[n] ?? n;

const wins = (s: SaveFile, name: string) => s.record[name]?.w ?? 0;
const stage = (t: number) => DUELISTS.filter((d) => d.tier === t);
const allBeaten = (s: SaveFile, t: number, n: number) => stage(t).every((d) => wins(s, d.name) >= n);
const winsInStage = (s: SaveFile, t: number) => stage(t).reduce((a, d) => a + wins(s, d.name), 0);

/** Highest stage the player has reached. */
export function stageReached(s: SaveFile): number {
  let reached = 1;
  for (let t = 2; t <= 5; t++) {
    if (allBeaten(s, t - 1, STAGE_WINS_NEEDED[t])) reached = t;
    else break;
  }
  return reached;
}

export function isUnlocked(s: SaveFile, d: Duelist): boolean {
  if (d.tier > stageReached(s)) return false;
  if (d.tier < 5) return true;
  switch (d.name) {
    case 'Duel Computer':
      return true;
    case 'Simon':
      return s.day % 365 >= 304 && s.day % 365 < 334; // November on the in-game calendar
    case 'Maximillion Pegasus':
      return (s.trunk['Toon World'] ?? 0) > 0 || s.main.includes('Toon World') || s.side.includes('Toon World');
    case 'Trusdale':
      return new Set([...Object.keys(s.trunk).filter((n) => s.trunk[n] > 0), ...s.main, ...s.side, ...s.fusion]).size >= 819;
    default:
      return false;
  }
}

/** Why a duelist is locked, in the player's words. */
export function lockReason(s: SaveFile, d: Duelist): string {
  if (d.tier > stageReached(s)) return `Beat every Stage ${d.tier - 1} duelist ${STAGE_WINS_NEEDED[d.tier]} times`;
  if (d.name === 'Simon') return 'Appears in November';
  if (d.name === 'Maximillion Pegasus') return 'Own a copy of Toon World';
  if (d.name === 'Trusdale') return 'Collect all 819 cards';
  return 'Locked';
}

const PACK_RULES: [string, (s: SaveFile) => boolean][] = [
  ['Judge Man', (s) => s.wins >= 10],
  ['Tiger Axe', (s) => stageReached(s) >= 2],
  ['Garoozis', (s) => stageReached(s) >= 3],
  ['Blue-Eyes Ultimate Dragon', (s) => stageReached(s) >= 4],
  ['Cyber Harpie', (s) => allBeaten(s, 1, 10)],
  ['Gate Guardian', (s) => winsInStage(s, 2) >= 10],
  ['Great Moth', (s) => allBeaten(s, 2, 10)],
  ['Relinquished', (s) => winsInStage(s, 3) >= 10],
  ['Black Luster Soldier', (s) => allBeaten(s, 3, 10)],
  ['Blue Millennium Puzzle', (s) => winsInStage(s, 4) >= 10],
  ['Eye of Wdjat', (s) => allBeaten(s, 4, 10)],
  ['Blue-Eyes White Dragon', (s) => wins(s, 'Yugi Muto') >= 20],
  ['Exodia the Forbidden One', (s) => wins(s, 'Joey Wheeler') >= 20],
  ['Gemini Elf', (s) => wins(s, 'Mako Tsunami') >= 20],
  ['Launcher Spider', (s) => wins(s, 'Mai Valentine') >= 20],
  ['Battle Ox', (s) => wins(s, 'Umbra & Lumis') >= 20],
  ['Blue-Eyes Toon Dragon', (s) => wins(s, 'Marik Ishtar') >= 20],
  ['Green Millennium Puzzle', (s) => wins(s, 'Seto Kaiba') >= 20],
  ['Buster Blader', (s) => wins(s, 'Yami Yugi') >= 20],
  ['Yellow Millennium Puzzle', (s) => wins(s, 'Simon') >= 1],
];

/** Adds any newly earned packs to the save; returns their names. */
export function applyPackUnlocks(s: SaveFile): string[] {
  const added: string[] = [];
  for (const [name, test] of PACK_RULES) {
    if (!s.unlockedPacks.includes(name) && test(s)) {
      s.unlockedPacks = [...s.unlockedPacks, name];
      added.push(name);
    }
  }
  return added;
}
