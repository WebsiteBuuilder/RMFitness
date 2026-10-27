// Deck chat's tools: what Claude may look at (the Speed Duel card pool, the duelist's
// collection, the deck) and the one way it may change a deck (edit_deck), which follows
// the same rules as the deck editor's Add button. Pure functions over a working deck, so
// tests can drive them without a model.
import { card, norm, skillCards, speedCards } from '../eds/db';
import { getSkill } from '../eds/skills';
import {
  COPIES,
  EXTRA_MAX,
  LIMITED_LIST_NAME,
  MAIN_MAX,
  MAIN_MIN,
  isExtraCard,
  limitStatus,
  limitedGroupFull,
  speedDeckProblems,
  unplayableReason,
  whyCantAdd,
  type SpeedDeck,
} from '../eds/speedSave';
import type { CardInfo } from '../eds/types';

export interface ChatWorld {
  /** the deck being edited; edit_deck replaces it */
  deck: SpeedDeck;
  /** cards owned (name -> copies); undefined for an Anything goes deck (every card, 3 copies) */
  collection?: Record<string, number>;
}

/** One tool, in the shape the Messages API takes. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const str = { type: 'string' } as const;
const int = { type: 'integer' } as const;

export const TOOLS: ToolDef[] = [
  {
    name: 'view_deck',
    description: 'The deck being edited: every card with its copies, the Skill, counts, and anything that stops it from dueling. Call it before changing a deck you have not seen yet.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'collection_overview',
    description: 'What the duelist can build from: how many playable cards they own, broken down by card kind, Attribute and Type, the biggest archetype words in card names, and their Skills. Use it to plan a deck around what they really have.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'search_cards',
    description:
      'Search the cards this deck may use (owned cards, or every Speed Duel card for an Anything goes deck). All filters are optional and combine. Each result: name | kind | stats | copies usable | copies in deck | Limited List status, then the start of its rules text (Normal Monsters have none). Set full_text for the whole text. Cards the game cannot play yet are left out.',
    input_schema: {
      type: 'object',
      properties: {
        name: { ...str, description: 'part of the card name, e.g. "Blue-Eyes" or "Harpie"' },
        text: { ...str, description: 'part of the card text, e.g. "destroy all" or "Spellcaster"' },
        kind: { type: 'string', enum: ['monster', 'spell', 'trap', 'extra'], description: 'extra = Fusion/Synchro/Xyz/Link monsters' },
        attribute: { type: 'string', enum: ['DARK', 'LIGHT', 'EARTH', 'WATER', 'FIRE', 'WIND', 'DIVINE'] },
        race: { ...str, description: 'monster Type, e.g. Dragon, Spellcaster, Warrior' },
        min_level: int,
        max_level: int,
        min_atk: int,
        sort: { type: 'string', enum: ['atk', 'name', 'level'], description: 'default atk (strongest first)' },
        full_text: { type: 'boolean' },
        include_unowned: { type: 'boolean', description: 'also list Speed Duel cards they do not own ("use 0"), to suggest what to get from packs or the Card Shop; those cannot go in the deck' },
        limit: { ...int, description: 'how many cards, default 30, at most 80' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'get_cards',
    description: 'Full details and rules text of up to 20 cards or Skills by name (any Speed Duel card, owned or not; a close spelling is fine).',
    input_schema: {
      type: 'object',
      properties: { names: { type: 'array', items: str, maxItems: 20 } },
      required: ['names'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_skills',
    description: 'Skills this deck may use (owned ones, or every Skill for an Anything goes deck), with whose Skill it is and its text. Filter by part of the name, character or text.',
    input_schema: {
      type: 'object',
      properties: { query: str },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_deck',
    description:
      `Change the deck. Steps run in this order: clear (empty Main and Extra Deck), remove, add, then skill and name. Fusion/Synchro/Xyz/Link monsters go to the Extra Deck by themselves. Each card is checked like the Add button: copies owned, ${COPIES} per name, the ${LIMITED_LIST_NAME}, Main Deck at most ${MAIN_MAX}, Extra Deck at most ${EXTRA_MAX}. Anything refused is listed with the reason; the rest still applies. Returns the deck after the change. The duelist sees every change and can undo it.`,
    input_schema: {
      type: 'object',
      properties: {
        clear: { type: 'boolean', description: 'start from an empty deck (keeps the Skill unless skill is given)' },
        remove: { type: 'array', items: { type: 'object', properties: { name: str, count: int }, required: ['name', 'count'], additionalProperties: false } },
        add: { type: 'array', items: { type: 'object', properties: { name: str, count: int }, required: ['name', 'count'], additionalProperties: false } },
        skill: { type: ['string', 'null'], description: 'Skill name to use, or null for no Skill' },
        name: { ...str, description: 'new deck name, at most 20 characters' },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

// ---------- helpers ----------
const bare = (n: string) => n.replace(/ \(Skill Card\)$/, '');
const usable = (w: ChatWorld, n: string) => (w.collection ? Math.min(COPIES, w.collection[n] ?? 0) : COPIES);
const inDeck = (d: SpeedDeck, n: string) => d.main.filter((x) => x === n).length + d.extra.filter((x) => x === n).length;

function stats(c: CardInfo): string {
  if (c.sub === 'Skill') return `Skill (${c.character ?? '?'})`;
  if (c.kind !== 'monster') return `${c.sub} ${c.kind === 'spell' ? 'Spell' : 'Trap'}`;
  const star = c.rank !== undefined ? `Rank ${c.rank}` : c.linkRating !== undefined ? `Link ${c.linkRating}` : `Lv${c.level ?? '?'}`;
  const sub = c.sub === 'Normal' ? 'Normal' : c.sub === 'Effect' ? 'Effect' : c.sub;
  return `${c.attribute ?? ''} ${c.race ?? ''} ${sub} ${star} ${c.atk ?? '?'}/${c.linkRating !== undefined ? '-' : (c.def ?? '?')}`.trim();
}

const short = (t: string, n = 220) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t).replace(/\s*\n\s*/g, ' ');

function line(w: ChatWorld, c: CardInfo, fullText = false): string {
  const lim = limitStatus(c.name);
  const parts = [c.name, stats(c), `use ${usable(w, c.name)}`, `deck ${inDeck(w.deck, c.name)}`];
  if (lim) parts.push(lim);
  // Normal Monsters' flavor text says nothing useful for deck building
  const text = c.vanilla && c.kind === 'monster' && c.sub !== 'Fusion' ? '' : fullText ? c.desc.replace(/\s*\n\s*/g, ' ') : short(c.desc, 160);
  return parts.join(' | ') + (text ? `\n   ${text}` : '');
}

/** Every playable Speed Duel card (no Skills) this deck may use. */
function poolOf(w: ChatWorld): CardInfo[] {
  return speedCards().filter((c) => !unplayableReason(c.name) && usable(w, c.name) > 0);
}

function skillsOf(w: ChatWorld): CardInfo[] {
  return skillCards().filter((s) => getSkill(s.name) && (!w.collection || (w.collection[s.name] ?? 0) > 0));
}

/**
 * The Speed Duel card (or Skill) a name means: exact, then any spelling/case/quote
 * difference, then a single card whose name contains it. null with suggestions otherwise.
 */
export function resolveName(name: string, skills = false): { name: string } | { error: string } {
  const pool = skills ? skillCards() : speedCards();
  const n = norm(name.replace(/^"|"$/g, ''));
  const loose = (s: string) => norm(s).replace(/[^a-z0-9]/g, '');
  const exact = pool.find((c) => norm(c.name) === n || (skills && norm(bare(c.name)) === n)) ?? pool.find((c) => loose(c.name) === loose(name) || (skills && loose(bare(c.name)) === loose(name)));
  if (exact) return { name: exact.name };
  const near = pool.filter((c) => loose(c.name).includes(loose(name)));
  if (near.length === 1) return { name: near[0].name };
  const words = n.split(/[^a-z0-9]+/).filter((x) => x.length >= 3);
  const score = (c: CardInfo) => words.filter((x) => norm(c.name).includes(x)).length;
  const hint = (near.length ? near : pool.filter((c) => score(c) > 0).sort((a, b) => score(b) - score(a))).slice(0, 6).map((c) => bare(c.name));
  return { error: `No ${skills ? 'Skill' : 'Speed Duel card'} called "${name}"${hint.length ? `. Did you mean: ${hint.join('; ')}?` : '. Use search_cards to find the exact name.'}` };
}

function countsLine(d: SpeedDeck): string {
  const k = (kind: string) => d.main.filter((n) => card(n)?.kind === kind).length;
  return `Main ${d.main.length} (${k('monster')} monsters, ${k('spell')} spells, ${k('trap')} traps), Extra ${d.extra.length}/${EXTRA_MAX}`;
}

function grouped(list: string[]): string {
  const c = new Map<string, number>();
  for (const n of list) c.set(n, (c.get(n) ?? 0) + 1);
  return [...c].map(([n, k]) => `${k}x ${n}`).join('; ') || '(empty)';
}

/** Extra Deck monsters this deck probably can't summon: Fusions missing materials or a way to Fusion Summon. */
function summonHints(d: SpeedDeck): string[] {
  const out: string[] = [];
  const main = new Set(d.main);
  const fuses = d.main.some((n) => /Fusion Summon/i.test(card(n)?.desc ?? '') && card(n)?.kind !== 'monster');
  for (const n of new Set(d.extra)) {
    const c = card(n);
    if (!c || c.sub !== 'Fusion') continue;
    const mats = c.desc.match(/^"[^"]+"(?:\s*\+\s*"[^"]+")+/);
    const missing = mats ? [...mats[0].matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((m) => !main.has(m)) : [];
    if (missing.length) out.push(`Hint: ${n} needs ${missing.join(' + ')} in the Main Deck`);
    else if (!fuses && !/Contact Fusion|Special Summoned .* by (sending|banishing|Tributing)/i.test(c.desc)) out.push(`Hint: ${n} needs Polymerization or another Fusion Summon card in the Main Deck`);
  }
  return out;
}

export function deckReport(w: ChatWorld): string {
  const d = w.deck;
  const problems = speedDeckProblems(d);
  if (w.collection) {
    for (const n of new Set([...d.main, ...d.extra])) if (inDeck(d, n) > (w.collection[n] ?? 0)) problems.push(`Uses ${inDeck(d, n)} ${n} but owns ${w.collection[n] ?? 0}`);
    if (d.skill && !(w.collection[d.skill] ?? 0)) problems.push(`Doesn't own the Skill ${d.skill}`);
  }
  return [
    `Deck "${d.name}"${d.open ? ' (Anything goes: every card, earns nothing)' : ''}`,
    countsLine(d),
    `Skill: ${d.skill ? bare(d.skill) : 'none'}`,
    `Main: ${grouped(d.main)}`,
    `Extra: ${grouped(d.extra)}`,
    problems.length ? `Not ready: ${problems.join('; ')}` : 'Ready to duel.',
    ...summonHints(d),
  ].join('\n');
}

/** What one edit_deck call changed, for the change card under Claude's reply. */
export interface DeckDiff {
  added: Record<string, number>;
  removed: Record<string, number>;
  skill?: { from: string | null; to: string | null };
  renamed?: string;
}

export function diffDecks(a: SpeedDeck, b: SpeedDeck): DeckDiff {
  const count = (d: SpeedDeck) => {
    const m: Record<string, number> = {};
    for (const n of [...d.main, ...d.extra]) m[n] = (m[n] ?? 0) + 1;
    return m;
  };
  const ca = count(a);
  const cb = count(b);
  const added: Record<string, number> = {};
  const removed: Record<string, number> = {};
  for (const n of new Set([...Object.keys(ca), ...Object.keys(cb)])) {
    const delta = (cb[n] ?? 0) - (ca[n] ?? 0);
    if (delta > 0) added[n] = delta;
    if (delta < 0) removed[n] = -delta;
  }
  const out: DeckDiff = { added, removed };
  if (a.skill !== b.skill) out.skill = { from: a.skill, to: b.skill };
  if (a.name !== b.name) out.renamed = b.name;
  return out;
}

export const diffEmpty = (d: DeckDiff) => !Object.keys(d.added).length && !Object.keys(d.removed).length && !d.skill && !d.renamed;

// ---------- the tools ----------
type Input = Record<string, unknown>;
const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : dflt);

function searchCards(w: ChatWorld, i: Input): string {
  let list = i.include_unowned === true ? speedCards().filter((c) => !unplayableReason(c.name)) : poolOf(w);
  const has = (s: unknown) => typeof s === 'string' && s.trim() !== '';
  if (has(i.name)) {
    const q = norm(String(i.name));
    list = list.filter((c) => norm(c.name).includes(q));
  }
  if (has(i.text)) {
    const q = norm(String(i.text));
    list = list.filter((c) => norm(c.desc).includes(q));
  }
  if (i.kind === 'extra') list = list.filter((c) => isExtraCard(c.name));
  else if (i.kind === 'monster') list = list.filter((c) => c.kind === 'monster' && !isExtraCard(c.name));
  else if (i.kind === 'spell' || i.kind === 'trap') list = list.filter((c) => c.kind === i.kind);
  if (has(i.attribute)) list = list.filter((c) => c.attribute === String(i.attribute).toUpperCase());
  if (has(i.race)) {
    const r = norm(String(i.race)).replace(/s$/, '');
    list = list.filter((c) => c.race && norm(c.race).replace(/s$/, '') === r);
  }
  const lvl = (c: CardInfo) => c.level ?? c.rank ?? c.linkRating ?? 0;
  if (i.min_level !== undefined) list = list.filter((c) => c.kind === 'monster' && lvl(c) >= num(i.min_level, 0));
  if (i.max_level !== undefined) list = list.filter((c) => c.kind === 'monster' && lvl(c) <= num(i.max_level, 99));
  if (i.min_atk !== undefined) list = list.filter((c) => (c.atk ?? -1) >= num(i.min_atk, 0));
  const sort = i.sort ?? 'atk';
  list.sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'level' ? lvl(b) - lvl(a) : (b.atk ?? -1) - (a.atk ?? -1)) || a.name.localeCompare(b.name));
  const limit = Math.max(1, Math.min(80, num(i.limit, 30)));
  if (!list.length) return 'No cards match. Try fewer filters.';
  const shown = list.slice(0, limit).map((c) => line(w, c, i.full_text === true));
  return `${list.length} match${list.length > limit ? `, first ${limit}` : ''}:\n${shown.join('\n')}`;
}

function getCards(w: ChatWorld, i: Input): string {
  const names = Array.isArray(i.names) ? i.names.slice(0, 20).map(String) : [];
  if (!names.length) return 'Give names.';
  return names
    .map((raw) => {
      const r = resolveName(raw);
      const rs = 'error' in r ? resolveName(raw, true) : r;
      if ('error' in rs) return 'error' in r ? r.error : rs.error;
      const c = card(rs.name)!;
      const why = c.sub === 'Skill' ? (getSkill(c.name) ? null : "isn't in the game yet") : unplayableReason(c.name);
      return `${c.name} | ${stats(c)} | usable copies ${c.sub === 'Skill' ? (!w.collection || (w.collection[c.name] ?? 0) > 0 ? 1 : 0) : usable(w, c.name)} | in deck ${c.sub === 'Skill' ? (w.deck.skill === c.name ? 1 : 0) : inDeck(w.deck, c.name)}${limitStatus(c.name) ? ` | ${limitStatus(c.name)}` : ''}${why ? ` | can't be used: ${why}` : ''}\n${c.desc}`;
    })
    .join('\n\n');
}

function listSkills(w: ChatWorld, i: Input): string {
  let list = skillsOf(w);
  if (typeof i.query === 'string' && i.query.trim()) {
    const q = norm(i.query);
    list = list.filter((s) => norm(s.name).includes(q) || norm(s.character ?? '').includes(q) || norm(s.desc).includes(q));
  }
  if (!list.length) return w.collection ? 'No owned Skills match.' : 'No Skills match.';
  return list
    .slice(0, 60)
    .map((s) => `${bare(s.name)} | ${s.character ?? '?'}${limitStatus(s.name) ? ` | ${limitStatus(s.name)}` : ''}${w.deck.skill === s.name ? ' | IN USE' : ''}\n   ${short(s.desc, 260)}`)
    .join('\n');
}

function collectionOverview(w: ChatWorld): string {
  const pool = poolOf(w);
  const copies = (cs: CardInfo[]) => cs.reduce((a, c) => a + usable(w, c.name), 0);
  const tally = (f: (c: CardInfo) => string | undefined, cs: CardInfo[]) => {
    const m = new Map<string, number>();
    for (const c of cs) {
      const k = f(c);
      if (k) m.set(k, (m.get(k) ?? 0) + usable(w, c.name));
    }
    return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  };
  const mons = pool.filter((c) => c.kind === 'monster' && !isExtraCard(c.name));
  // archetype words: name words shared by 3+ different cards ("Harpie", "Blue-Eyes", "Gearfried")
  const words = new Map<string, Set<string>>();
  for (const c of pool) for (const word of new Set(c.name.split(/[\s,]+/).filter((x) => x.length > 3 && !/^(the|of|and|with|from|dragon|monster|card|lady|magician|warrior)$/i.test(x)))) (words.get(word) ?? words.set(word, new Set()).get(word)!).add(c.name);
  const themes = [...words].filter(([, s]) => s.size >= 3).sort((a, b) => b[1].size - a[1].size).slice(0, 15).map(([k, s]) => `${k} (${s.size})`);
  return [
    w.collection ? `Owns ${pool.length} different playable cards (${copies(pool)} usable copies, at most ${COPIES} each).` : `Anything goes deck: all ${pool.length} playable Speed Duel cards, ${COPIES} copies each.`,
    `Main Deck monsters ${copies(mons)}, spells ${copies(pool.filter((c) => c.kind === 'spell'))}, traps ${copies(pool.filter((c) => c.kind === 'trap'))}, Extra Deck monsters ${copies(pool.filter((c) => isExtraCard(c.name)))}.`,
    `Monsters by Attribute: ${tally((c) => c.attribute, mons)}`,
    `Monsters by Type: ${tally((c) => c.race, mons)}`,
    `Monsters by Level: ${tally((c) => (c.level ? (c.level <= 4 ? 'Lv1-4' : c.level <= 6 ? 'Lv5-6' : 'Lv7+') : undefined), mons)}`,
    `Name themes: ${themes.join(', ') || 'none'}`,
    `Skills: ${skillsOf(w).map((s) => bare(s.name)).join('; ') || 'none'}`,
  ].join('\n');
}

function editDeck(w: ChatWorld, i: Input): { text: string; deck: SpeedDeck } {
  let d: SpeedDeck = { ...w.deck, main: [...w.deck.main], extra: [...w.deck.extra] };
  const refused: string[] = [];
  const done: string[] = [];
  if (i.clear === true) (d.main = []), (d.extra = []), done.push('cleared the deck');
  const items = (v: unknown) => (Array.isArray(v) ? v : []).filter((x): x is { name: string; count?: number } => !!x && typeof (x as { name?: unknown }).name === 'string');
  for (const it of items(i.remove)) {
    const r = resolveName(it.name);
    if ('error' in r) {
      refused.push(r.error);
      continue;
    }
    let k = Math.max(1, Math.min(COPIES, num(it.count, 1)));
    let took = 0;
    for (; k > 0; k--) {
      const from = d.extra.includes(r.name) ? d.extra : d.main.includes(r.name) ? d.main : null;
      if (!from) break;
      from.splice(from.indexOf(r.name), 1);
      took++;
    }
    if (took) done.push(`-${took} ${r.name}`);
    else refused.push(`${r.name}: not in the deck`);
  }
  for (const it of items(i.add)) {
    const r = resolveName(it.name);
    if ('error' in r) {
      refused.push(r.error);
      continue;
    }
    const want = Math.max(1, Math.min(COPIES, num(it.count, 1)));
    let put = 0;
    let why: string | null = null;
    for (let k = 0; k < want; k++) {
      why = whyCantAdd(d, r.name, w.collection);
      if (why) break;
      (isExtraCard(r.name) ? d.extra : d.main).push(r.name);
      put++;
    }
    if (put) done.push(`+${put} ${r.name}`);
    if (why) refused.push(`${r.name}: ${put ? `only ${put} of ${want} went in, ` : ''}${why}`);
  }
  if (i.skill === null) (d.skill = null), done.push('no Skill');
  else if (typeof i.skill === 'string' && i.skill.trim()) {
    const r = resolveName(i.skill, true);
    if ('error' in r) refused.push(r.error);
    else if (!getSkill(r.name)) refused.push(`${bare(r.name)}: this Skill isn't in the game yet`);
    else if (w.collection && !(w.collection[r.name] ?? 0)) refused.push(`${bare(r.name)}: you don't own this Skill`);
    else if (limitStatus(r.name) === 'Forbidden') refused.push(`${bare(r.name)}: Forbidden`);
    else if (limitedGroupFull([...d.main, ...d.extra], r.name)) refused.push(`${bare(r.name)}: ${limitedGroupFull([...d.main, ...d.extra], r.name)} (the deck already has a card from its Limited group)`);
    else (d.skill = r.name), done.push(`Skill ${bare(r.name)}`);
  }
  if (typeof i.name === 'string' && i.name.trim()) (d = { ...d, name: i.name.trim().slice(0, 20) }), done.push(`renamed "${d.name}"`);
  const text = [done.length ? `Done: ${done.join(', ')}.` : 'Nothing changed.', refused.length ? `Refused: ${refused.join(' | ')}` : '', '', deckReport({ ...w, deck: d })].filter((x, k) => x || k === 2).join('\n');
  return { text, deck: d };
}

/** Runs one tool call. A changed deck comes back in `deck`. */
export function runTool(w: ChatWorld, name: string, input: unknown): { text: string; deck?: SpeedDeck; error?: boolean } {
  const i = (input && typeof input === 'object' ? input : {}) as Input;
  try {
    switch (name) {
      case 'view_deck':
        return { text: deckReport(w) };
      case 'collection_overview':
        return { text: collectionOverview(w) };
      case 'search_cards':
        return { text: searchCards(w, i) };
      case 'get_cards':
        return { text: getCards(w, i) };
      case 'list_skills':
        return { text: listSkills(w, i) };
      case 'edit_deck': {
        const r = editDeck(w, i);
        return { text: r.text, deck: r.deck };
      }
    }
    return { text: `No tool called ${name}`, error: true };
  } catch (e) {
    return { text: `The tool failed: ${(e as Error).message}`, error: true };
  }
}

export const DECK_RULES = `Speed Duel deck rules: Main Deck ${MAIN_MIN} to ${MAIN_MAX} cards, Extra Deck 0 to ${EXTRA_MAX} (Fusion/Synchro/Xyz/Link), at most ${COPIES} copies of a card, and the ${LIMITED_LIST_NAME} (Forbidden cards can't be used; "Limited N" means at most N cards in total from that group, Skills included). One Skill per deck, optional.`;

/**
 * Takes one change back out of the deck as it is now (not a snapshot), so cards the duelist
 * moved by hand afterwards stay where they put them.
 */
export function undoDiff(now: SpeedDeck, diff: DeckDiff, before: SpeedDeck): SpeedDeck {
  const d: SpeedDeck = { ...now, main: [...now.main], extra: [...now.extra] };
  for (const [n, k] of Object.entries(diff.added))
    for (let j = 0; j < k; j++) {
      const from = d.extra.includes(n) ? d.extra : d.main.includes(n) ? d.main : null;
      if (from) from.splice(from.lastIndexOf(n), 1);
    }
  for (const [n, k] of Object.entries(diff.removed)) for (let j = 0; j < k; j++) (isExtraCard(n) ? d.extra : d.main).push(n);
  if (diff.skill) d.skill = diff.skill.from;
  if (diff.renamed) d.name = before.name;
  return d;
}
