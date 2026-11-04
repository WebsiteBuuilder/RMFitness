import type { CardInfo } from '../eds/types';

/** "Blue-Eyes White Dragon" -> "blue eyes white dragon": search ignores case, hyphens and punctuation */
export function normSearch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface Indexed {
  name: string;
  /** name squashed with no spaces, so "blueeyes" and "blue eyes" both find Blue-Eyes */
  tight: string;
  /** what kind of card it is: "monster effect dragon dark level 8" */
  tags: string;
  desc: string;
}
const index = new Map<string, Indexed>();
function indexed(c: CardInfo): Indexed {
  let e = index.get(c.name);
  if (!e) {
    const name = normSearch(c.name);
    const tags = normSearch([c.kind, c.sub, c.race ?? '', c.attribute ?? '', c.level ? `level ${c.level} lv${c.level}` : '', c.sub === 'Skill' ? `skill ${c.character ?? ''}` : ''].join(' '));
    e = { name, tight: name.replace(/ /g, ''), tags, desc: normSearch(c.desc) };
    index.set(c.name, e);
  }
  return e;
}

/** a stat word in the search box: "atk>2000", "def<=1500", "atk 2500" (exactly) */
const STAT = /^(atk|def)\s*(>=|<=|>|<|=)?\s*(\d+)$/;

export function parseQuery(q: string): { words: string[]; stats: { stat: 'atk' | 'def'; op: string; n: number }[] } {
  const stats: { stat: 'atk' | 'def'; op: string; n: number }[] = [];
  // pull stat words out before punctuation is stripped (it eats > and <)
  const rest = q.toLowerCase().replace(/\b(atk|def)\s*(>=|<=|>|<|=)?\s*(\d+)\b/g, (m) => {
    const s = STAT.exec(m.replace(/\s+/g, ''));
    if (s) stats.push({ stat: s[1] as 'atk' | 'def', op: s[2] ?? '=', n: Number(s[3]) });
    return ' ';
  });
  // "atk" or "def>" still being typed: wait for the number instead of finding nothing
  const half = rest.replace(/\b(atk|def)\s*(>=|<=|>|<|=)?\s*$/, ' ');
  return { words: normSearch(half).split(' ').filter(Boolean), stats };
}

/**
 * Does this card fit what was typed? Every word has to be somewhere: in the name, in what kind of card
 * it is ("dragon", "dark", "equip", "lv4"), or in its text when inText is on. Stat words check ATK/DEF.
 */
export function cardMatches(c: CardInfo, q: ReturnType<typeof parseQuery>, inText: boolean): boolean {
  for (const s of q.stats) {
    const v = c[s.stat];
    if (c.kind !== 'monster' || v === undefined) return false;
    if (s.op === '>' ? !(v > s.n) : s.op === '<' ? !(v < s.n) : s.op === '>=' ? !(v >= s.n) : s.op === '<=' ? !(v <= s.n) : v !== s.n) return false;
  }
  if (!q.words.length) return true;
  const e = indexed(c);
  const joined = q.words.join('');
  // the whole thing typed without spaces: "blueeyes", "darkmagician"
  if (q.words.length > 1 && e.tight.includes(joined)) return true;
  return q.words.every((w) => e.name.includes(w) || e.tight.includes(w) || (` ${e.tags} `).includes(` ${w}`) || (inText && e.desc.includes(w)));
}

/** names first: a card whose name starts with what was typed beats one that only mentions it */
export function matchRank(c: CardInfo, q: ReturnType<typeof parseQuery>): number {
  if (!q.words.length) return 0;
  const e = indexed(c);
  const phrase = q.words.join(' ');
  if (e.name === phrase) return 0;
  if (e.name.startsWith(phrase)) return 1;
  if (e.name.includes(phrase)) return 2;
  if (q.words.every((w) => e.name.includes(w))) return 3;
  return 4;
}
