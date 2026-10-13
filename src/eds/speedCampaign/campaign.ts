// The Millennium Road: which duels are open, how a duel's result turns into stars and
// rewards, and the deck rule (your road deck is built only from cards you own).
import { rng } from '../rng';
import { COPIES, STARTERS, deckFromStarter, owned, speedDeckProblems, withCards, type SpeedDeck, type SpeedSave } from '../speedSave';
import { CHAPTERS, type CampaignNode, type Chapter } from './roster';
import { grant } from './rewards';
import type { SoloSave } from './save';
import { starsFor } from './outcome';
import type { CpuDuelist, DeckList, DuelOutcome, Reward } from './types';

/** "Card*3" -> three names. */
export function expand(list: DeckList): string[] {
  return list.flatMap((e) => {
    const m = e.match(/^(.*)\*(\d)$/);
    return m ? Array<string>(Number(m[2])).fill(m[1]) : [e];
  });
}

export const deckOf = (d: CpuDuelist) => ({ main: expand(d.main), extra: expand(d.extra), skill: d.skill });

const NODES = new Map<string, { node: CampaignNode; chapter: Chapter; index: number }>();
for (const ch of CHAPTERS) ch.nodes.forEach((node, index) => NODES.set(node.id, { node, chapter: ch, index }));

export const findNode = (id: string) => NODES.get(id);
export const allCampaignDuelists = (): CpuDuelist[] => CHAPTERS.flatMap((c) => c.nodes.map((n) => n.duelist));

const won = (solo: SoloSave, id: string) => (solo.campaign.wins[id] ?? 0) > 0;

export function chapterOpen(solo: SoloSave, ch: Chapter): boolean {
  if (!solo.campaign.starter) return false;
  const i = CHAPTERS.indexOf(ch);
  if (i <= 0) return true;
  const prev = CHAPTERS[i - 1];
  return won(solo, prev.nodes[prev.nodes.length - 1].id);
}

export function nodeOpen(solo: SoloSave, ch: Chapter, index: number): boolean {
  if (!chapterOpen(solo, ch)) return false;
  return index === 0 || won(solo, ch.nodes[index - 1].id);
}

export const chapterCleared = (solo: SoloSave, ch: Chapter) => won(solo, ch.nodes[ch.nodes.length - 1].id);
export const starCount = (solo: SoloSave, ids: string[]) => ids.reduce((a, id) => a + (solo.campaign.stars[id]?.filter(Boolean).length ?? 0), 0);

/** The chapter to show first: the furthest one open. */
export function currentChapter(solo: SoloSave): Chapter {
  let at = CHAPTERS[0];
  for (const ch of CHAPTERS) if (chapterOpen(solo, ch)) at = ch;
  return at;
}

/** Starts the road with a Starter Deck: its cards join the collection and become the road deck. */
export function startRoad(speed: SpeedSave, solo: SoloSave, character: string): { speed: SpeedSave; solo: SoloSave } {
  const st = STARTERS.find((s) => s.character === character) ?? STARTERS[0];
  const deck = { ...deckFromStarter(st), name: `${st.character} (Road)` };
  // Only add what the collection doesn't already hold.
  const need: string[] = [];
  const counts: Record<string, number> = {};
  for (const n of [...deck.main, ...deck.extra, ...(deck.skill ? [deck.skill] : [])]) {
    counts[n] = (counts[n] ?? 0) + 1;
    if (counts[n] > owned(speed, n)) need.push(n);
  }
  return { speed: withCards(speed, need), solo: { ...solo, campaign: { ...solo.campaign, starter: st.character, deck } } };
}

/** Everything wrong with the road deck, including cards you don't own enough of. */
export function roadDeckProblems(speed: SpeedSave, d: SpeedDeck): string[] {
  const out = speedDeckProblems(d);
  const counts: Record<string, number> = {};
  for (const n of [...d.main, ...d.extra]) counts[n] = (counts[n] ?? 0) + 1;
  for (const [n, c] of Object.entries(counts)) if (c > owned(speed, n)) out.push(`You own ${owned(speed, n)} of ${n} (deck has ${c})`);
  if (d.skill && owned(speed, d.skill) === 0) out.push(`You haven't earned the Skill ${d.skill} yet`);
  return out;
}

/** Cards you could still add copies of from this list (fewer than 3 owned). */
function wanted(speed: SpeedSave, list: string[]): string[] {
  return [...new Set(list)].filter((n) => owned(speed, n) < COPIES);
}

export interface Settled {
  speed: SpeedSave;
  solo: SoloSave;
  stars: [boolean, boolean, boolean];
  newStars: boolean[];
  /** reward lines to show */
  lines: string[];
  /** cards granted (for the reveal) */
  cards: string[];
  /** one choice of three per new star */
  picks: string[][];
  firstWin: boolean;
  /** a chapter just cleared */
  cleared: Chapter | null;
}

/** Writes a campaign duel's result: record, stars, rewards. */
export function settleCampaign(speed: SpeedSave, solo: SoloSave, nodeId: string, o: DuelOutcome, seed = Date.now()): Settled {
  const found = findNode(nodeId);
  const none: Settled = { speed, solo, stars: [false, false, false], newStars: [false, false, false], lines: [], cards: [], picks: [], firstWin: false, cleared: null };
  if (!found) return none;
  const { node, chapter } = found;
  const c = solo.campaign;
  if (o.result !== 'w') return { ...none, solo: { ...solo, campaign: { ...c, losses: c.losses + 1 } } };

  const old = c.stars[nodeId] ?? [false, false, false];
  const got = starsFor(node.goal, o);
  const stars = old.map((s, i) => s || got[i]) as [boolean, boolean, boolean];
  const newStars = stars.map((s, i) => s && !old[i]);
  const firstWin = !old[0];
  const d = deckOf(node.duelist);
  const theirCards = [...d.main, ...d.extra];
  const next = rng(seed + 1);
  const pickFrom = (list: string[]) => list[Math.floor(next() * list.length)];

  const rewards: Reward[] = [];
  // Rewards come from firsts only (first win, new stars), never from replays.
  if (firstWin) {
    // Signature cards you already hold three of are skipped: a deck can't use a 4th.
    for (const s of node.duelist.signature) if (owned(speed, s) < COPIES) rewards.push({ kind: 'card', name: s });
    rewards.push({ kind: 'pack' });
    if (node.boss) {
      if (node.duelist.skill) rewards.push({ kind: 'skill', name: node.duelist.skill });
      rewards.push({ kind: 'item', name: chapter.item });
      if (chapter.postgame) rewards.push({ kind: 'title', name: 'King of Games' });
      else rewards.push({ kind: 'title', name: `Keeper of the ${chapter.item}` });
    }
  }
  // The first time all three stars are lit: one Duel Chip.
  if (stars.every(Boolean) && !old.every(Boolean)) rewards.push({ kind: 'chips', n: 1 });
  const chapterPool = chapter.nodes.flatMap((n) => expand(n.duelist.main));
  const g = grant(speed, solo, rewards, chapterPool, seed);
  // Each new 2nd or 3rd star: choose one of three of their cards. Drawn after this duel's
  // other rewards land, so a pick never offers a card you just got your third copy of,
  // and the two picks never offer the same card.
  const picks: string[][] = [];
  const offered = new Set<string>();
  for (let i = 1; i < 3; i++) {
    if (!newStars[i]) continue;
    const pool = wanted(g.speed, theirCards).filter((n) => !offered.has(n));
    const three: string[] = [];
    while (three.length < 3 && three.length < pool.length) {
      const n = pickFrom(pool);
      if (!three.includes(n)) three.push(n);
    }
    three.forEach((n) => offered.add(n));
    if (three.length) picks.push(three);
  }
  const campaign = { ...g.solo.campaign, pendingPicks: [...(g.solo.campaign.pendingPicks ?? []), ...picks], stars: { ...g.solo.campaign.stars, [nodeId]: stars }, wins: { ...g.solo.campaign.wins, [nodeId]: (g.solo.campaign.wins[nodeId] ?? 0) + 1 } };
  const cleared = firstWin && node.boss ? chapter : null;
  if (cleared) campaign.cleared = chapter.id;
  return { speed: g.speed, solo: { ...g.solo, campaign }, stars, newStars, lines: g.lines, cards: g.cards, picks, firstWin, cleared };
}

/** The player picked one card of the first waiting star pick. */
export function takePick(speed: SpeedSave, solo: SoloSave, name: string | null): { speed: SpeedSave; solo: SoloSave } {
  const rest = (solo.campaign.pendingPicks ?? []).slice(1);
  return { speed: name ? withCards(speed, [name]) : speed, solo: { ...solo, campaign: { ...solo.campaign, pendingPicks: rest } } };
}
