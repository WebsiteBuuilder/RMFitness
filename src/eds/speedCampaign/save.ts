// Progress in the Speed Duel solo modes, one save per profile under `eds.speedsolo.<profile id>`.
// Cards earned anywhere go to the profile's Speed Duel collection (speedSave.ts), not here:
// this file only remembers where you are on the road, your stars and your runs.
import type { SpeedDeck } from '../speedSave';
import type { Run, RunSummary } from './labyrinth';

export interface CampaignProgress {
  /** the Starter Deck character the road started with (null until picked) */
  starter: string | null;
  /** the deck used on the road, built only from the collection */
  deck: SpeedDeck | null;
  /** node id -> the three stars */
  stars: Record<string, [boolean, boolean, boolean]>;
  /** node id -> wins */
  wins: Record<string, number>;
  losses: number;
  /** Millennium Items won */
  items: string[];
  titles: string[];
  /** losses in a row per duel (a helping hand after two) */
  tries?: Record<string, number>;
  /** star picks won but not yet chosen (kept so closing the app doesn't lose them) */
  pendingPicks?: string[][];
  /** a chapter-clear screen still to show */
  cleared?: string;
}

export interface LabyrinthProgress {
  run: Run | null;
  fragments: number;
  /** permanent upgrades bought with Soul Fragments */
  upgrades: string[];
  /** highest Curse unlocked (0 until the first clear) */
  curseUnlocked: number;
  history: RunSummary[];
  best: RunSummary | null;
  /** the last day a Labyrinth boss paid a Duel Chip (one a day) */
  chipDay?: string;
}

export interface PracticePrefs {
  oppId: string | null;
  first: 'me' | 'cpu' | 'coin';
  conditions: boolean;
  myLp: number;
  cpuLp: number;
  /** the computer's Skill: their own, none, or a named one */
  cpuSkill: string;
  /** decks pasted from codes, kept for the next practice */
  codes: { name: string; code: string }[];
  /** Computer vs computer: the two fighters and their pep talks */
  watch?: WatchPrefs;
}

export interface WatchPrefs {
  /** fighter ids: 'deck:<id>' for your decks, otherwise a Practice opponent id */
  a: string | null;
  b: string | null;
  talkA: string;
  talkB: string;
}

export interface SoloSave {
  version: 1;
  campaign: CampaignProgress;
  labyrinth: LabyrinthProgress;
  practice: PracticePrefs;
  /** the Tag Road (2v2 campaign): which tag pairs were beaten */
  tagRoad?: { wins: Record<string, number>; losses: number };
}

export function newSoloSave(): SoloSave {
  return {
    version: 1,
    campaign: { starter: null, deck: null, stars: {}, wins: {}, losses: 0, items: [], titles: [] },
    labyrinth: { run: null, fragments: 0, upgrades: [], curseUnlocked: 0, history: [], best: null },
    practice: { oppId: null, first: 'coin', conditions: true, myLp: 4000, cpuLp: 4000, cpuSkill: 'theirs', codes: [] },
  };
}

const key = (profileId: string) => `eds.speedsolo.${profileId}`;
const mem = new Map<string, SoloSave>();

export function loadSolo(profileId: string): SoloSave {
  try {
    const raw = localStorage.getItem(key(profileId));
    const s = raw ? (JSON.parse(raw) as SoloSave) : null;
    if (s && s.version === 1) {
      // Fill anything a newer version added.
      const base = newSoloSave();
      return { ...base, ...s, campaign: { ...base.campaign, ...s.campaign }, labyrinth: { ...base.labyrinth, ...s.labyrinth }, practice: { ...base.practice, ...s.practice } };
    }
  } catch {
    /* storage blocked: fall back to memory */
  }
  return mem.get(profileId) ?? newSoloSave();
}

export function writeSolo(profileId: string, s: SoloSave) {
  mem.set(profileId, s);
  try {
    localStorage.setItem(key(profileId), JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
