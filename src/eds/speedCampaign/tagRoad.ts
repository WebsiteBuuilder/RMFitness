// The Tag Road: the Millennium Road's eight chapters fought as tag teams (2v2). Every pair is
// made of duelists from that chapter (Weevil & Rex, Para & Dox, Yami Marik & Odion...), ending
// on a boss pair. You play it with your brother as your partner (two phones) or with a
// computer partner picked from the duelists you've beaten on the Millennium Road. Each phone
// keeps its own progress and rewards; rewards come from first wins only.
import { COPIES, owned, type SpeedSave } from '../speedSave';
import { CHAPTERS, type Chapter } from './roster';
import { deckOf, expand, findNode } from './campaign';
import { grant } from './rewards';
import type { SoloSave } from './save';
import type { CpuDuelist, DuelOutcome, Reward } from './types';

export interface TagFoe {
  /** a Millennium Road node id: the duelist and their deck */
  node: string;
  /** a different name for this half of a pair that shares one duelist (Para, Dox) */
  as?: string;
}

export interface TagNode {
  id: string;
  /** the chapter this pair belongs to (Millennium Road chapter id) */
  chapter: string;
  pair: [TagFoe, TagFoe];
  boss?: boolean;
  /** what they say before the duel */
  intro: string;
}

export interface TagChapter {
  id: string;
  n: number;
  title: string;
  nodes: TagNode[];
}

const N = (id: string, chapter: string, a: string | TagFoe, b: string | TagFoe, intro: string, boss?: boolean): TagNode => ({
  id,
  chapter,
  pair: [typeof a === 'string' ? { node: a } : a, typeof b === 'string' ? { node: b } : b],
  intro,
  ...(boss ? { boss } : {}),
});

const PAIRS: TagNode[] = [
  N('t1-bugs', 'c1', 'c1-weevil', 'c1-rex', "Weevil and Rex: 'Two of us, two of you. This time the odds are even... for now.'"),
  N('t1-paradox', 'c1', { node: 'c1-paradox', as: 'Para' }, { node: 'c1-paradox', as: 'Dox' }, "Para and Dox: 'We never duel alone. Neither do you, it seems.'"),
  N('t1-boss', 'c1', 'c1-pegasus', 'c1-mako', "Pegasus: 'Mako-boy and I have prepared a little tag-team surprise for you, duelists.'", true),
  N('t2-psychic', 'c2', 'c2-espa', 'c2-bonz', "Espa Roba: 'I already know your next move. Bonz knows where to bury it.'"),
  N('t2-rare', 'c2', 'c2-arkana', 'c2-odion', "Arkana: 'Master Marik sent us both. Odion never misses a trap.'"),
  N('t2-boss', 'c2', 'c2-marik', 'c2-odion', "Yami Marik: 'Two souls for the Shadow Realm at once. How generous of you.'", true),
  N('t3-tomb', 'c3', 'c3-scout', 'c3-sorcerer', "Nefer and Seshat: 'The tomb has two doors. Both are guarded.'"),
  N('t3-boss', 'c3', 'c3-ishizu', 'c3-abidos', "Ishizu: 'I have seen this duel. Pharaoh Abidos insists on seeing it too.'", true),
  N('t4-dino', 'c4', 'c4-tyranno', 'c4-chazz', "Hassleberry: 'Sarge, me and the Chazz are a stampede you can't outrun!'"),
  N('t4-blue', 'c4', 'c4-alexis', 'c4-syrus', "Alexis: 'Syrus asked to team up with me. Don't make him regret it.'"),
  N('t4-boss', 'c4', 'c4-zane', 'c4-syrus', "Zane: 'Brothers against brothers. Show me your respect, Syrus.'", true),
  N('t5-riders', 'c5', 'c5-titan', 'c5-viper', "Titan and Viper: 'The Shadow Riders ride in pairs tonight.'"),
  N('t5-boss', 'c5', 'c5-kagemaru', 'c5-amnael', "Kagemaru: 'Amnael and I need only one more key. Yours.'", true),
  N('t6-ghouls', 'c6', 'c6-cutpurse', 'c6-gravedigger', "Sly Kesh: 'Old Mukhtar digs, I pick the pockets. Fair split.'"),
  N('t6-boss', 'c6', 'c6-bakura', 'c6-lantern', "Yami Bakura: 'Hollow Saib lights the way to your graves.'", true),
  N('t7-friends', 'c7', 'c7-mai', 'c7-joey', "Joey: 'Mai and me? We ain't goin' easy just 'cause we're friends!'"),
  N('t7-boss', 'c7', 'c7-dealer', 'c7-kaiba', "The Masked Dealer: 'Kaiba buys in. The house always wins... especially with two hands.'", true),
  N('t8-kings', 'c8', 'c8-yami', 'c7-kaiba', "Yami Yugi: 'Kaiba and I will duel side by side. Show us your bond is stronger.'", true),
];

export const TAG_CHAPTERS: TagChapter[] = CHAPTERS.map((ch: Chapter) => ({ id: `t${ch.n}`, n: ch.n, title: ch.title, nodes: PAIRS.filter((p) => p.chapter === ch.id) })).filter((c) => c.nodes.length > 0);

const TAG_NODES = new Map<string, { node: TagNode; chapter: TagChapter; index: number }>();
for (const ch of TAG_CHAPTERS) ch.nodes.forEach((node, index) => TAG_NODES.set(node.id, { node, chapter: ch, index }));
export const findTagNode = (id: string) => TAG_NODES.get(id);

/** One foe of a pair: the Millennium Road duelist, renamed for shared-deck pairs. */
export function foeOf(f: TagFoe): CpuDuelist {
  const d = findNode(f.node)!.node.duelist;
  return f.as ? { ...d, name: f.as } : d;
}
export const pairName = (n: TagNode) => `${foeOf(n.pair[0]).name} & ${foeOf(n.pair[1]).name}`;

export interface TagRoadProgress {
  wins: Record<string, number>;
  losses: number;
}
export const tagProgress = (solo: SoloSave): TagRoadProgress => solo.tagRoad ?? { wins: {}, losses: 0 };
const won = (solo: SoloSave, id: string) => (tagProgress(solo).wins[id] ?? 0) > 0;

/** The first chapter is open from the start; each next one opens when the last boss pair falls. */
export function tagChapterOpen(solo: SoloSave, ch: TagChapter): boolean {
  const i = TAG_CHAPTERS.indexOf(ch);
  if (i <= 0) return true;
  const prev = TAG_CHAPTERS[i - 1];
  return won(solo, prev.nodes[prev.nodes.length - 1].id);
}
export function tagNodeOpen(solo: SoloSave, ch: TagChapter, index: number): boolean {
  if (!tagChapterOpen(solo, ch)) return false;
  return index === 0 || won(solo, ch.nodes[index - 1].id);
}
export const tagNodeWon = won;

/** The next pair to beat (or the last one, once everything is cleared). */
export function nextTagNode(solo: SoloSave): TagNode {
  for (const ch of TAG_CHAPTERS) for (const n of ch.nodes) if (!won(solo, n.id)) return n;
  const last = TAG_CHAPTERS[TAG_CHAPTERS.length - 1];
  return last.nodes[last.nodes.length - 1];
}

/**
 * Computer partners: Joey Wheeler always, plus every Millennium Road duelist you have beaten.
 * The post-game's Yami Yugi joins once you beat him.
 */
export function partnersFor(solo: SoloSave): CpuDuelist[] {
  const out: CpuDuelist[] = [];
  const seen = new Set<string>();
  const add = (d: CpuDuelist) => {
    if (seen.has(d.id)) return;
    seen.add(d.id);
    out.push(d);
  };
  add(findNode('c7-joey')!.node.duelist);
  for (const ch of CHAPTERS) for (const n of ch.nodes) if ((solo.campaign.wins[n.id] ?? 0) > 0) add(n.duelist);
  return out;
}

/** A computer partner's deck. */
export const partnerDeck = (d: CpuDuelist) => deckOf(d);

/** How sharp the pair plays: easier early, harder later (matches the Millennium Road's climb). */
export const tagLevel = (n: TagNode): 'easy' | 'normal' | 'hard' => {
  const c = Number(n.chapter.slice(1));
  return c <= 2 ? 'easy' : c <= 5 ? 'normal' : 'hard';
};

export interface TagSettled {
  speed: SpeedSave;
  solo: SoloSave;
  lines: string[];
  cards: string[];
  firstWin: boolean;
  /** this win opened the next chapter */
  cleared: TagChapter | null;
}

/** Files a Tag Road duel on one phone: the record, and rewards for a first win. */
export function settleTagRoad(speed: SpeedSave, solo: SoloSave, nodeId: string, o: DuelOutcome, seed = Date.now()): TagSettled {
  const found = findTagNode(nodeId);
  const p = tagProgress(solo);
  const none: TagSettled = { speed, solo, lines: [], cards: [], firstWin: false, cleared: null };
  if (!found) return none;
  if (o.result !== 'w') return { ...none, solo: { ...solo, tagRoad: { ...p, losses: p.losses + 1 } } };
  const { node, chapter } = found;
  const firstWin = !won(solo, nodeId);
  const rewards: Reward[] = [];
  if (firstWin) {
    // One signature card from each of them (skipping ones you already hold three of), and a pack.
    for (const f of node.pair) {
      const sig = foeOf(f).signature.find((s) => owned(speed, s) < COPIES);
      if (sig && !rewards.some((r) => r.kind === 'card' && r.name === sig)) rewards.push({ kind: 'card', name: sig });
    }
    rewards.push({ kind: 'pack' });
    if (node.boss) rewards.push({ kind: 'pack' });
    if (nodeId === 't8-kings') rewards.push({ kind: 'title', name: 'Tag Team Kings' });
  }
  const pool = node.pair.flatMap((f) => expand(foeOf(f).main));
  const g = firstWin ? grant(speed, solo, rewards, pool, seed) : { speed, solo, lines: [], cards: [] };
  const tagRoad: TagRoadProgress = { ...p, wins: { ...p.wins, [nodeId]: (p.wins[nodeId] ?? 0) + 1 } };
  return { speed: g.speed, solo: { ...g.solo, tagRoad }, lines: g.lines, cards: g.cards, firstWin, cleared: firstWin && node.boss ? chapter : null };
}
