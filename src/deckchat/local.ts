// Deck chat's built-in helper: no key, no internet, no cost. It reads what the duelist
// typed (or said: voice typing is loose, so it is forgiving), works out what they want,
// and answers through the same tools and Model shape Claude uses, so Undo, the step trail
// and the change card work the same. Builds use the game's random deck maker, steered by
// the theme, style and size it heard.
import type Anthropic from '@anthropic-ai/sdk';
import { allCards, card, norm, skillCards, speedCards } from '../eds/db';
import { getSkill } from '../eds/skills';
import { COPIES, EXTRA_MAX, LIMITED_LIST_NAME, MAIN_MAX, MAIN_MIN, isExtraCard, limitStatus, speedDeckProblems, unplayableReason, whyCantAdd, type SpeedDeck } from '../eds/speedSave';
import { randomSpeedDeck, speedThemes } from '../eds/speedRandom';
import type { RandomStyle, RandomTheme } from '../eds/randomDeck';
import type { CardInfo } from '../eds/types';
import type { Model, ModelReply } from './agent';
import type { ChatWorld } from './tools';

type Block = Anthropic.Beta.BetaContentBlock;
interface Call {
  name: string;
  input: Record<string, unknown>;
}
/** What the helper decided: tool calls to make, then the answer (given the tools' replies). */
interface Plan {
  calls: Call[];
  answer: (results: string[]) => string;
}

const ATTRS = ['DARK', 'LIGHT', 'EARTH', 'WATER', 'FIRE', 'WIND', 'DIVINE'];
const RACES = ['Beast-Warrior', 'Winged Beast', 'Sea Serpent', 'Warrior', 'Spellcaster', 'Dragon', 'Fiend', 'Machine', 'Zombie', 'Beast', 'Fairy', 'Insect', 'Dinosaur', 'Reptile', 'Fish', 'Aqua', 'Pyro', 'Thunder', 'Rock', 'Plant', 'Psychic', 'Cyberse', 'Wyrm', 'Divine-Beast'];
const NUM: Record<string, number> = { a: 1, an: 1, one: 1, single: 1, two: 2, couple: 2, three: 3, all: 3, every: 3, max: 3, both: 2 };
const bare = (n: string) => n.replace(/ \(Skill Card\)$/, '');
/** lower case, no punctuation: "Blue-Eyes White Dragon" -> "blue eyes white dragon" */
const flat = (s: string) => norm(s).replace(/[^a-z0-9]+/g, ' ').trim();
const plural = (r: string) => (/(Fish|Psychic|Cyberse)$/.test(r) ? r : r.endsWith('y') ? r.slice(0, -1) + 'ies' : r + 's');
const kindWord = (w: string) => (/^monsters?$/.test(w) ? 'monster' : /^spells?$/.test(w) ? 'spell' : /^traps?$/.test(w) ? 'trap' : null);
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

/** every Speed Duel card and Skill name, longest first, for spotting names inside a sentence */
let names: { flat: string; name: string; skill: boolean }[] | null = null;
function nameIndex() {
  if (!names)
    names = [...speedCards().map((c) => ({ flat: flat(c.name), name: c.name, skill: false })), ...skillCards().map((c) => ({ flat: flat(bare(c.name)), name: c.name, skill: true }))]
      .filter((x) => x.flat.length >= 3)
      .sort((a, b) => b.flat.length - a.flat.length);
  return names;
}

/** The card (or Skill) named somewhere in the text, the longest name winning; or a close single match of a phrase. */
export function findCard(text: string, skills: 'cards' | 'skills' | 'both' = 'both'): string | null {
  const t = ` ${flat(text)} `;
  for (const x of nameIndex()) {
    if ((skills === 'cards' && x.skill) || (skills === 'skills' && !x.skill)) continue;
    if (t.includes(` ${x.flat} `)) return x.name;
  }
  // a phrase that is part of exactly one name ("blue eyes white" -> Blue-Eyes White Dragon)
  const q = flat(text);
  if (q.length < 4) return null;
  const hits = nameIndex().filter((x) => (skills === 'both' || (skills === 'skills') === x.skill) && x.flat.includes(q));
  return hits.length === 1 || (hits.length > 1 && hits.every((h) => h.name === hits[0].name)) ? hits[0].name : (hits.find((h) => h.flat === q)?.name ?? null);
}

/** A real Yu-Gi-Oh! card named in the text that isn't a Speed Duel card ("Pot of Greed"), if the full card list is loaded. */
let others: { flat: string; name: string }[] | null = null;
export function findOutside(text: string): string | null {
  if (!others) {
    const speed = new Set(speedCards().map((c) => c.name));
    others = allCards()
      .filter((c) => !speed.has(c.name) && c.sub !== 'Skill')
      .map((c) => ({ flat: flat(c.name), name: c.name }))
      .filter((x) => x.flat.length >= 5)
      .sort((a, b) => b.flat.length - a.flat.length);
    if (!others.length) others = null;
  }
  const t = ` ${flat(text)} `;
  return others?.find((x) => t.includes(` ${x.flat} `))?.name ?? null;
}
const outsideLine = (n: string) => `${n} isn't a Speed Duel card (Konami never printed it in a Speed Duel product), so it can't go in a Speed Duel deck.`;

/** "3 Kuriboh, Sangan and 2 Pot of Greed" */
function listOf(names: string[]): string {
  const parts = counts(names).map((x) => (x.count > 1 ? `${x.count} ${x.name}` : x.name));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '');
}

function stats(c: CardInfo): string {
  if (c.sub === 'Skill') return `${c.character ?? 'a duelist'}'s Skill`;
  if (c.kind !== 'monster') return `${c.sub === 'Normal' ? '' : `${c.sub} `}${c.kind === 'spell' ? 'Spell' : 'Trap'}`;
  const star = c.rank !== undefined ? `Rank ${c.rank}` : c.linkRating !== undefined ? `Link ${c.linkRating}` : `Level ${c.level ?? '?'}`;
  return `${star} ${c.attribute ?? ''} ${c.race ?? ''} ${c.sub === 'Normal' ? 'Normal Monster' : c.sub === 'Effect' ? 'Effect Monster' : `${c.sub} Monster`}, ${c.atk ?? '?'} ATK${c.linkRating !== undefined ? '' : ` / ${c.def ?? '?'} DEF`}`.replace(/\s+/g, ' ');
}

// ---------- reading the request ----------
const STOP = new Set('a an the me my i to for of with from and or please can could you u build make create give get want need new deck decks card cards some using use around based on out it its this that full whole good best strongest strong cool nice fun really very just only more type themed theme kind style monster monsters spell spells trap traps let lets let\'s do one up random'.split(' '));

interface Wish {
  size: number;
  style: RandomStyle;
  theme: RandomTheme;
  /** an archetype or card name to build around ("Harpie", "Dark Magician") */
  around: string | null;
  best: boolean;
}

function readWish(text: string, collection: Record<string, number> | undefined): Wish {
  const t = flat(text);
  const size = Number(t.match(/\b(2\d|30)\b/)?.[1] ?? 0) || 20;
  const style: RandomStyle = /\b(aggro|aggressive|attack|beat ?down|offen[cs]e|offensive|rush|damage|fast)\b/.test(t) ? 'beatdown' : /\b(control|defen[cs]e|defensive|trap heavy|lots of traps|stall|slow)\b/.test(t) ? 'control' : 'balanced';
  let theme: RandomTheme = /\b(surprise|random|anything|whatever)\b/.test(t) ? { kind: 'surprise' } : { kind: 'any' };
  const attr = ATTRS.find((a) => new RegExp(`\\b${a.toLowerCase()}\\b`).test(t));
  const race = RACES.find((r) => new RegExp(`\\b${flat(r)}(s|es)?\\b`).test(t.replace(/\bspell ?casters?\b/, 'spellcaster')));
  if (race) theme = { kind: 'race', value: race };
  else if (attr) theme = { kind: 'attribute', value: attr };
  // a name to build around: the words left once the usual ones are gone
  let around: string | null = null;
  const owned = (n: string) => !collection || (collection[n] ?? 0) > 0;
  const named = findCard(text, 'cards');
  if (named && owned(named)) around = named;
  else {
    const words = t.split(' ').filter((w) => !STOP.has(w) && !/^\d+$/.test(w) && w !== race?.toLowerCase() && w !== attr?.toLowerCase() && !/^(dragons?|aggro|aggressive|control|defensive|beatdown|balanced|surprise|deck)$/.test(w));
    for (let k = Math.min(3, words.length); k >= 1 && !around; k--)
      for (let i = 0; i + k <= words.length && !around; i++) {
        const q = words.slice(i, i + k).join(' ');
        if (q.length < 4) continue;
        const hits = speedCards().filter((c) => owned(c.name) && !unplayableReason(c.name) && flat(c.name).includes(q));
        if (hits.length >= 2 || (hits.length === 1 && k >= 2)) around = q;
      }
  }
  return { size: Math.min(MAIN_MAX, Math.max(MAIN_MIN, size)), style, theme, around, best: /\b(best|strongest|strong|good|top|meta|op|powerful|win)\b/.test(t) };
}

/** Cards to build around a name: the cards carrying it and the ones whose text names it, up to 15. */
function aroundCards(q: string, w: ChatWorld): string[] {
  const owned = (n: string) => (w.collection ? Math.min(COPIES, w.collection[n] ?? 0) : COPIES);
  const fq = flat(q);
  const pool = speedCards().filter((c) => !unplayableReason(c.name) && owned(c.name) > 0 && limitStatus(c.name) !== 'Forbidden');
  const core = pool.filter((c) => flat(c.name).includes(fq));
  const support = pool.filter((c) => !core.includes(c) && flat(c.desc).includes(fq));
  const out: string[] = [];
  for (const c of [...core, ...support]) for (let k = 0; k < owned(c.name) && out.length < 15; k++) out.push(c.name);
  return out;
}

/** How good a built deck looks, for picking the best of a few tries: strong early monsters and real spells/traps. */
function deckScore(main: string[]): number {
  const cs = main.map((n) => card(n)!).filter(Boolean);
  const mons = cs.filter((c) => c.kind === 'monster');
  const low = mons.filter((c) => (c.level ?? 0) <= 4);
  const avg = low.reduce((a, c) => a + (c.atk ?? 0), 0) / Math.max(1, low.length);
  const effects = cs.filter((c) => !c.vanilla).length;
  return avg + effects * 40 + Math.min(low.length, 12) * 60 - Math.max(0, mons.length - low.length - 4) * 300;
}

function counts(list: string[]): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const n of list) m.set(n, (m.get(n) ?? 0) + 1);
  return [...m].map(([name, count]) => ({ name, count }));
}

const refusedOf = (r: string) => r.match(/^Refused: (.*)$/m)?.[1] ?? '';
const readyOf = (r: string) => (/Ready to duel\./.test(r) ? '' : (r.match(/^Not ready: (.*)$/m)?.[1] ?? ''));

function describe(main: string[], skill: string | null): string {
  const cs = main.map((n) => card(n)!).filter(Boolean);
  const mons = cs.filter((c) => c.kind === 'monster');
  const ace = [...mons].sort((a, b) => (b.atk ?? 0) - (a.atk ?? 0))[0];
  const k = (x: string) => cs.filter((c) => c.kind === x).length;
  return `It has ${main.length} cards: ${k('monster')} monsters, ${k('spell')} spells and ${k('trap')} traps${ace ? `, with ${ace.name} (${ace.atk} ATK) as the big hitter` : ''}${skill ? `, and ${bare(skill)} as the Skill` : ''}.`;
}

function buildPlan(text: string, w: ChatWorld): Plan {
  const wish = readWish(text, w.collection);
  const keepCards = wish.around ? aroundCards(wish.around, w) : [];
  const tries = wish.best ? 8 : 3;
  let best: { main: string[]; extra: string[]; skill: string | null; label: string; notes: string[] } | null = null;
  let error = '';
  for (let i = 0; i < tries; i++) {
    const r = randomSpeedDeck(w.collection, { size: wish.size, style: wish.style, theme: wish.theme, keep: keepCards.length ? { main: keepCards.filter((n) => !isExtraCard(n)), extra: keepCards.filter(isExtraCard), skill: null } : undefined });
    if ('error' in r) {
      error = r.error;
      continue;
    }
    if (!best || deckScore(r.main) > deckScore(best.main)) best = r;
  }
  if (!best) return { calls: [], answer: () => `I couldn't build that one: ${error || 'not enough cards'}. Open packs in the Card Shop for more cards, or try a different theme.` };
  const label = wish.around ? `${titleCase(wish.around)} deck` : best.label;
  const name = (wish.around ? titleCase(wish.around) : wish.theme.kind === 'race' ? plural(wish.theme.value) : wish.theme.kind === 'attribute' ? `${titleCase(wish.theme.value)} deck` : wish.style === 'beatdown' ? 'Rush deck' : wish.style === 'control' ? 'Control deck' : 'Chat deck').slice(0, 20);
  return {
    calls: [
      { name: 'collection_overview', input: {} },
      { name: 'edit_deck', input: { clear: true, skill: best.skill, add: counts([...best.main, ...best.extra]), name } },
    ],
    answer: (rs) => {
      const r = rs[1] ?? '';
      const style = wish.style === 'beatdown' ? ' It leans on attacking fast.' : wish.style === 'control' ? ' It plays slower, with more traps to protect your field.' : '';
      const notes = best!.notes.length ? ` ${best!.notes.join(' ')}` : '';
      const missing = readyOf(r);
      const fam = wish.around ? best!.main.filter((n) => flat(n).includes(flat(wish.around!)) || flat(card(n)?.desc ?? '').includes(flat(wish.around!))).length : 0;
      return `Built a ${label} from ${w.collection ? 'your cards' : 'every Speed Duel card'}. ${describe(best!.main, best!.skill)}${fam ? ` ${fam} of them are ${titleCase(wish.around!)} cards or support them.` : ''}${style}${notes}${missing ? ` Not ready yet: ${missing}.` : ''} Say "make it stronger", "more traps" or "add 2 of something" to tweak it.`;
    },
  };
}

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bDark\b|\bLight\b|\bFire\b|\bWater\b|\bEarth\b|\bWind\b/g, (x) => x.toUpperCase());

function countIn(text: string): number {
  const t = flat(text);
  const n = t.match(/\b([1-3])\b/)?.[1];
  if (n) return Number(n);
  for (const [w, k] of Object.entries(NUM)) if (new RegExp(`\\b${w}\\b`).test(t)) return k;
  return 1;
}

/** Owned cards of a kind that could go in, strongest (for this deck) first. */
function candidates(w: ChatWorld, d: SpeedDeck, f: (c: CardInfo) => boolean): CardInfo[] {
  return speedCards()
    .filter((c) => f(c) && !whyCantAdd(d, c.name, w.collection))
    .sort((a, b) => worth(b, d) - worth(a, d));
}

function needed(c: CardInfo, d: SpeedDeck): boolean {
  const all = [...d.main, ...d.extra].filter((n) => n !== c.name);
  if (c.name === 'Polymerization' && d.extra.some((n) => card(n)?.sub === 'Fusion')) return true;
  return all.some((n) => (card(n)?.desc ?? '').includes(`"${c.name}"`) || (card(n)?.desc ?? '').includes(`“${c.name}”`));
}

/** the names a card's text supports ("Elemental HERO"), other than its own */
const quoted = (c: CardInfo) => [...c.desc.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((q) => q !== c.name);

/**
 * A rough "how good is this card in a Speed Duel deck" for swaps: strong low-Level monsters,
 * removal and protection; support for a name the deck doesn't play is worth little.
 */
function worth(c: CardInfo, d?: SpeedDeck): number {
  let v: number;
  if (c.kind !== 'monster') v = 1000 + (c.vanilla ? 0 : 300) + (/destroy|negate|banish/i.test(c.desc) ? 400 : 0) - (/pay half your life ?points|pay half your lp/i.test(c.desc) ? 300 : 0);
  else {
    const lv = c.level ?? 4;
    // big monsters cost Tributes, and ones that can't be Normal Summoned need a whole plan
    v = (c.atk ?? 0) + (c.vanilla ? 0 : 350) - (lv >= 7 ? 1300 : lv >= 5 ? 500 : 0) - (/cannot be normal summoned|must (first )?be special summoned|requires 3 tributes/i.test(c.desc) ? 1600 : 0);
  }
  // a card other cards here need (Polymerization for the Fusions, a Ritual's Spell) stays
  if (d && d.main.includes(c.name) && needed(c, d)) v += 1500;
  const q = quoted(c);
  if (d && q.length && !q.some((x) => [...d.main, ...d.extra].some((n) => n !== c.name && (n.includes(x) || card(n)?.desc.includes(`"${x}"`))))) v -= 900;
  return v;
}

function strongerPlan(w: ChatWorld): Plan {
  const d = w.deck;
  if (!d.main.length) return buildPlan('build my strongest deck', w);
  const inDeck = [...new Set(d.main)].map((n) => card(n)!).filter((c) => c && !isExtraCard(c.name));
  const weak = inDeck.filter((c) => c.kind === 'monster').sort((a, b) => worth(a, d) - worth(b, d));
  const swaps: { out: string; in: string }[] = [];
  let work: SpeedDeck = { ...d, main: [...d.main] };
  for (const c of weak) {
    if (swaps.length >= 4) break;
    const without = { ...work, main: [...work.main] };
    without.main.splice(without.main.indexOf(c.name), 1);
    const better = candidates(w, without, (x) => x.kind === 'monster' && !isExtraCard(x.name) && worth(x, without) > worth(c, without) + 250 && !swaps.some((s) => s.in === x.name))[0];
    if (!better) continue;
    swaps.push({ out: c.name, in: better.name });
    work = { ...without, main: [...without.main, better.name] };
  }
  // the Skill the maker would pick for this deck
  let skill: string | null | undefined;
  if (!d.skill) {
    const r = randomSpeedDeck(w.collection, { size: Math.max(MAIN_MIN, d.main.length), keep: { main: d.main, extra: d.extra, skill: null } });
    if (!('error' in r) && r.skill) skill = r.skill;
  }
  if (!swaps.length && !skill) return { calls: [{ name: 'view_deck', input: {} }], answer: () => `This deck already uses the strongest cards you own for its slots. ${tipsFor(d).join(' ') || 'Win duels and open packs to get stronger cards, then ask again.'}` };
  return {
    calls: [{ name: 'edit_deck', input: { remove: swaps.map((s) => ({ name: s.out, count: 1 })), add: swaps.map((s) => ({ name: s.in, count: 1 })), ...(skill ? { skill } : {}) } }],
    answer: (rs) => {
      const lines = swaps.map((s) => `${s.out} → ${s.in} (${card(s.in)?.atk ?? ''}${card(s.in)?.kind === 'monster' ? ' ATK' : ''})`);
      const refused = refusedOf(rs[0] ?? '');
      return `Swapped in stronger monsters: ${lines.join('; ') || 'none'}.${skill ? ` Added the Skill ${bare(skill)}.` : ''}${refused ? ` Couldn't do: ${refused}.` : ''}`;
    },
  };
}

function tipsFor(d: SpeedDeck): string[] {
  const cs = d.main.map((n) => card(n)!).filter(Boolean);
  const mons = cs.filter((c) => c.kind === 'monster');
  const high = mons.filter((c) => (c.level ?? 0) >= 5);
  const out: string[] = [];
  if (mons.length < 10) out.push(`Only ${mons.length} monsters: 11 to 13 is safer in a 20-card deck, so you always have something to summon.`);
  if (mons.length > 15) out.push(`${mons.length} monsters leaves little room for spells and traps that protect them.`);
  if (high.length > 4) out.push(`${high.length} monsters need Tributes (Level 5+). With only 3 Monster Zones, 2 to 4 is plenty.`);
  if (!d.skill) out.push('No Skill yet: a Skill is free power, pick one.');
  if (d.main.length > 20) out.push(`At ${d.main.length} cards you draw your best cards less often; 20 is the strongest size.`);
  return out;
}

function ratePlan(w: ChatWorld): Plan {
  const d = w.deck;
  if (!d.main.length) return { calls: [], answer: () => 'The deck is empty. Say "build me a deck" and I\'ll make one from your cards.' };
  const cs = d.main.map((n) => card(n)!).filter(Boolean);
  const mons = cs.filter((c) => c.kind === 'monster');
  const low = mons.filter((c) => (c.level ?? 0) <= 4);
  const avg = Math.round(low.reduce((a, c) => a + (c.atk ?? 0), 0) / Math.max(1, low.length));
  const problems = speedDeckProblems(d);
  const tips = tipsFor(d);
  const score = Math.max(1, Math.min(10, Math.round(5 + (avg - 1500) / 250 - tips.length - problems.length * 2 + (d.skill ? 1 : 0))));
  return {
    calls: [{ name: 'view_deck', input: {} }],
    answer: () =>
      `I'd give it ${score}/10. ${describe(d.main, d.skill)} Your Level 4-or-lower monsters average ${avg} ATK.${problems.length ? ` It can't duel yet: ${problems[0]}.` : ''} ${tips.join(' ') || 'The balance looks right.'}${score < 8 ? ' Say "make it stronger" and I\'ll swap in better cards.' : ''}`.trim(),
  };
}

function themesPlan(w: ChatWorld): Plan {
  const t = speedThemes(w.collection, 20);
  const list = [...t.races.map(plural), ...t.attributes.map((a) => `${a}`)];
  return {
    calls: [{ name: 'collection_overview', input: {} }],
    answer: (rs) => {
      const nameThemes = rs[0]?.match(/^Name themes: (.*)$/m)?.[1] ?? '';
      return list.length
        ? `With your cards you can build full ${list.slice(0, 6).join(', ')} decks.${nameThemes && nameThemes !== 'none' ? ` Names you have several of: ${nameThemes.split(', ').slice(0, 5).join(', ')}.` : ''} Say something like "build me a ${pick(list)} deck".`
        : 'You don\'t have enough of one Type or Attribute for a themed deck yet, but I can still build a mixed deck: say "build my strongest deck".';
    },
  };
}

function cardPlan(name: string, w: ChatWorld): Plan {
  const c = card(name)!;
  const owned = w.collection ? (w.collection[name] ?? 0) : 3;
  const inDeck = c.sub === 'Skill' ? (w.deck.skill === name ? 1 : 0) : w.deck.main.filter((n) => n === name).length + w.deck.extra.filter((n) => n === name).length;
  const lim = limitStatus(name);
  const why = c.sub === 'Skill' ? (getSkill(name) ? null : "isn't playable in the game yet") : unplayableReason(name);
  return {
    calls: [{ name: 'get_cards', input: { names: [name] } }],
    answer: () =>
      `${bare(c.name)}: ${stats(c)}. ${c.desc.replace(/\s*\n\s*/g, ' ')}\n\n${w.collection ? `You own ${owned}${owned ? '' : ' (get it from packs or the Card Shop)'}` : 'Any copies allowed in this deck'}, ${inDeck} in this deck.${lim ? ` ${lim} on the ${LIMITED_LIST_NAME}.` : ''}${why ? ` It ${why.startsWith('its') ? `can't be used yet: ${why}` : why}.` : ''}`,
  };
}

const RULES: [RegExp, string][] = [
  [/\b(cop(y|ies)|how many of|4 of|four of)\b/, `You can run up to ${COPIES} copies of a card (fewer if the ${LIMITED_LIST_NAME} limits it), and only as many as you own unless it's an Anything goes deck.`],
  [/\bfusions?\b/, 'Fusion monsters live in the Extra Deck. Use Polymerization (or another Fusion card) and send the listed materials from your hand or field to the Graveyard to summon one. Only bring Fusions your deck has the materials for.'],
  [/\brituals?\b/, 'Ritual monsters go in the Main Deck. You need their Ritual Spell and monsters to Tribute whose Levels add up to at least the Ritual monster\'s Level.'],
  [/\bsynchros?\b|\btuners?\b/, 'A Synchro monster is summoned from the Extra Deck by sending a Tuner and other face-up monsters whose Levels add up exactly to its Level to the Graveyard.'],
  [/\bxyz\b|\boverlay\b/, 'An Xyz monster is summoned from the Extra Deck by stacking 2 or more face-up monsters of the same Level (the number it lists). They become its materials, which it uses up for its effects.'],
  [/\bextra deck\b/, `The Extra Deck holds up to ${EXTRA_MAX} Fusion, Synchro or Xyz monsters. They don't count toward the ${MAIN_MIN}-card Main Deck.`],
  [/\b(go first|going first|who starts|coin)\b/, 'A coin toss decides who goes first. The first player skips their first draw and can\'t attack that turn.'],
  [/\b(life ?points?|lp|how much life)\b/, 'Each duelist starts with 4000 Life Points in Speed Duel.'],
  [/\b(hand|draw|opening)\b/, 'You start with 4 cards in hand. The player going first skips their first draw, and you discard down to 6 cards at the End Phase.'],
  [/\b(zones?|field|board)\b/, 'Speed Duel has 3 Monster Zones, 3 Spell & Trap Zones and a Field Zone each, and no Extra Monster Zone.'],
  [/\b(main phase 2|phases?|turn order)\b/, 'A Speed Duel turn goes Draw, Standby, Main Phase 1, Battle, End. There is no Main Phase 2, so set traps before you attack.'],
  [/\b(how many cards|deck size|minimum|maximum|max cards|min cards|how big)\b/, `A Main Deck holds ${MAIN_MIN} to ${MAIN_MAX} cards, the Extra Deck up to ${EXTRA_MAX}, and you can run ${COPIES} copies of a card.`],
  [/\b(limited list|forbidden|banned|ban list|limited)\b/, `The ${LIMITED_LIST_NAME} groups some cards: "Limited 1" means only 1 card in total from that group (Skills count), Forbidden cards can't be used at all.`],
  [/\b(skills?)\b.*\b(work|rules|how)\b|\bhow\b.*\bskills?\b/, 'You bring one Skill to each duel. It starts face-down and you flip it when you use it; most Skills work once per duel or need a condition first.'],
  [/\b(tribute|level 5|level 7|summon)\b/, 'Level 5 and 6 monsters need 1 Tribute, Level 7 and up need 2. Only 3 Monster Zones means big monsters cost a lot, so 2 to 4 is plenty.'],
];

const HELP = 'I can build and change this deck from your cards. Try: "build me a Dragon deck", "make an aggressive DARK deck", "build around Harpie Lady", "make it stronger", "add 2 Kuriboh", "take out the traps", "more spells", "use the Skill Grit", "is this deck good?", "what can I build?" or "what does Dark Magician do?"';

/** Works out what one message asks for. Exported for tests. */
export function planFor(text: string, w: ChatWorld): Plan {
  const t = flat(text);
  const d = w.deck;
  if (!t || /^(help|what can you do|hi|hello|hey|yo|sup|commands|how does this work)\b/.test(t)) return { calls: [], answer: () => HELP };

  // rename
  const rn = text.match(/\b(?:rename(?: it| the deck)?|call it|name it|name the deck)\s+(?:to\s+)?["“']?(.+?)["”']?\s*$/i);
  if (rn) return { calls: [{ name: 'edit_deck', input: { name: rn[1].trim().slice(0, 20) } }], answer: () => `Renamed the deck "${rn[1].trim().slice(0, 20)}".` };

  // Skill questions and changes
  if (/\b(skill)\b/.test(t)) {
    const sk = findCard(text, 'skills');
    if (/\b(what|explain|how|tell)\b/.test(t) && !sk) {
      if (!d.skill) return { calls: [], answer: () => 'This deck has no Skill yet. Say "pick a Skill" and I\'ll choose one that fits.' };
      return cardPlan(d.skill, w);
    }
    if (sk && /\b(what|explain|tell|does|read)\b/.test(t) && !/\b(use|equip|switch|change|set|put)\b/.test(t)) return cardPlan(sk, w);
    if (/\b(remove|no|take off|drop|without)\b/.test(t) && !sk) return { calls: [{ name: 'edit_deck', input: { skill: null } }], answer: () => 'Took the Skill off.' };
    if (sk) return { calls: [{ name: 'edit_deck', input: { skill: sk } }], answer: (rs) => (refusedOf(rs[0] ?? '') ? `Couldn't: ${refusedOf(rs[0])}.` : `Now using ${bare(sk)}. ${short(card(sk)!.desc)}`) };
    const r = randomSpeedDeck(w.collection, { size: Math.max(MAIN_MIN, d.main.length), keep: { main: d.main, extra: d.extra, skill: null } });
    const best = 'error' in r ? null : r.skill;
    if (!best) return { calls: [], answer: () => (w.collection ? "You don't own a Skill that fits yet. Skills come from packs and the Card Shop." : "I couldn't find a Skill that fits.") };
    return { calls: [{ name: 'edit_deck', input: { skill: best } }], answer: () => `Picked ${bare(best)} for this deck: ${short(card(best)!.desc)}` };
  }

  // rules
  if (/\b(rule|rules|how many|how much|how do|how does|how can|what happens|can i|do i|is there|when|what is|whats)\b/.test(t) || /\?$/.test(text.trim())) {
    const hit = RULES.find(([re]) => re.test(t));
    if (hit && !findCard(text, 'cards')) return { calls: [], answer: () => hit[1] };
  }

  // rate the deck
  if (/\b(good|rate|rating|review|grade|score|analy[sz]e|check|what s wrong|whats wrong|weak|thoughts|opinion|how is|how s)\b/.test(t) && /\b(deck|it|this)\b/.test(t) && !/\b(build|make|create)\b/.test(t)) return ratePlan(w);

  // what can I build
  if (/\b(what|which)\b.*\b(build|make|themes?|decks?)\b.*\b(can|could|should)\b|\b(what|which)\b.*\b(can|could|should) i (build|make)\b|\bideas?\b|\bthemes?\b/.test(t)) return themesPlan(w);

  // which card is best / weakest in the deck
  const which = t.match(/\b(best|strongest|weakest|worst)\b.*\b(card|monster|spell|trap)s?\b/);
  if (which && /\b(what|which|whats|what s|who|tell)\b/.test(t) && d.main.length) {
    const kind = kindWord(which[2]);
    const pool = [...new Set([...d.main, ...d.extra])].map((n) => card(n)!).filter((c) => c && (!kind || c.kind === kind));
    const top = pool.sort((a, b) => worth(b, d) - worth(a, d))[/best|strongest/.test(which[1]) ? 0 : pool.length - 1];
    if (top) return { calls: [{ name: 'view_deck', input: {} }], answer: () => `${/best|strongest/.test(which[1]) ? 'Your strongest' : 'Your weakest'} ${kind ?? 'card'} here is ${top.name}: ${stats(top)}. ${short(top.desc)}` };
  }

  // what to add or chase
  if (/\b(what|which)\b.*\b(should|could|can|to)\b.*\b(add|get|buy|put in|chase|open|use)\b|\b(suggest|recommend|suggestions?|recommendations?)\b/.test(t)) return suggestPlan(w);

  // a style change for the deck that's there ("make it more aggressive")
  if (d.main.length && !/\b(build|create|new)\b|\b(make|give) me\b/.test(t)) {
    if (/\b(aggro|aggressive|offensive|beat ?down|faster|attack more|hit harder)\b/.test(t)) {
      const floor = Math.min(1600, Math.max(0, ...d.main.map((n) => card(n)).filter((c) => c?.kind === 'monster' && (c.level ?? 0) <= 4).map((c) => c!.atk ?? 0)) - 100);
      const plan = kindShift(w, 'monster', 3, 'more attackers', (c) => (c.level ?? 0) <= 4 && (c.atk ?? 0) >= floor);
      return plan.calls.length ? plan : { calls: [], answer: () => `This deck already runs your best attackers that need no Tribute.${w.collection ? ' Open packs or craft in the Card Shop for stronger ones, then ask again.' : ''} Say "make it stronger" to swap weak cards, or "fewer traps" for more room.` };
    }
    if (/\b(defensive|control|safer|slower|protect)\b/.test(t)) return kindShift(w, 'trap', 3, 'more traps to protect your field');
  }

  // take out the weakest cards
  const weakest = t.match(/\b(remove|take out|cut|drop|get rid of|lose)\b.*\b(weakest|worst|bad|weak)\b/);
  if (weakest && d.main.length) {
    const k = countIn(text.replace(/\bcards?\b/g, ''));
    const n = /\bcards\b|\bmonsters\b/.test(t) && !/\b[1-3]\b|\b(one|two|three|a)\b/.test(t) ? 3 : k;
    const out = [...d.main].sort((a, b) => worth(card(a)!, d) - worth(card(b)!, d)).slice(0, n);
    return { calls: [{ name: 'edit_deck', input: { remove: counts(out) } }], answer: () => `Took out ${listOf(out)}, the weakest ${out.length > 1 ? 'cards' : 'card'} here.${d.main.length - out.length < MAIN_MIN ? ` The deck needs ${MAIN_MIN} cards to duel: say "fill it up".` : ''}` };
  }

  // clear
  if (/\b(clear|empty|wipe|start over|reset|remove everything|delete everything)\b/.test(t)) return { calls: [{ name: 'edit_deck', input: { clear: true } }], answer: () => 'Emptied the deck. Say "build me a deck" to fill it again.' };

  // more / fewer of a kind
  const more = t.match(/\b(more|extra|add some|add a few)\s+(monsters?|spells?|traps?)\b/);
  const fewer = t.match(/\b(less|fewer|cut some|remove some|cut a few|remove a few)\s+(monsters?|spells?|traps?)\b/);
  if (more || fewer) return kindShift(w, kindWord((more ?? fewer)![2])!, more ? 3 : -3);

  // remove all of a kind
  const rk = t.match(/\b(remove|take out|get rid of|no|drop|delete|cut|without)\s+(?:all\s+)?(?:of\s+)?(?:the\s+|my\s+)?(monsters?|spells?|traps?)\b/);
  if (rk && !findCard(text, 'cards')) {
    const kind = kindWord(rk[2])!;
    const out = counts(d.main.filter((n) => card(n)?.kind === kind && !isExtraCard(n)));
    if (!out.length) return { calls: [], answer: () => `There are no ${kind}s in the deck.` };
    return { calls: [{ name: 'edit_deck', input: { remove: out } }], answer: () => `Took out all ${out.reduce((a, x) => a + x.count, 0)} ${kind}s. The Main Deck needs ${MAIN_MIN} cards to duel, so say "fill it up" or "more ${kind === 'monster' ? 'spells' : 'monsters'}".` };
  }

  // fill up to the minimum
  if (/\b(fill|finish|complete|top up|top it up)\b/.test(t)) {
    if (d.main.length >= MAIN_MIN) return { calls: [], answer: () => `The deck already has ${d.main.length} cards, enough to duel.` };
    const r = randomSpeedDeck(w.collection, { size: MAIN_MIN, keep: { main: d.main, extra: d.extra, skill: d.skill } });
    if ('error' in r) return { calls: [], answer: () => `I couldn't fill it: ${r.error}.` };
    const added = diffList(d.main, r.main);
    return { calls: [{ name: 'edit_deck', input: { add: counts(added) } }], answer: () => `Filled the deck to ${MAIN_MIN} with ${added.length} cards that fit what's already in it.` };
  }

  // add / remove a card
  const addRm = t.match(/\b(add|put in|put|include|throw in|stick in|chuck in|remove|take out|get rid of|drop|cut|delete|lose|minus)\b/);
  if (addRm) {
    const name = findCard(text, 'cards');
    const removing = /^(remove|take out|get rid of|drop|cut|delete|lose|minus)$/.test(addRm[1]);
    if (name) {
      const k = /\ball\b/.test(t) ? COPIES : countIn(text.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ''));
      return {
        calls: [{ name: 'edit_deck', input: removing ? { remove: [{ name, count: k }] } : { add: [{ name, count: k }] } }],
        answer: (rs) => {
          const refused = refusedOf(rs[0] ?? '');
          const done = rs[0]?.match(/^Done: (.*)\.$/m)?.[1];
          return `${done && done !== 'Nothing changed' ? `${removing ? 'Took out' : 'Added'} ${done.replace(/^[-+]/, '').replace(/, [-+]/g, ', ')}.` : 'Nothing changed.'}${refused ? ` ${refused}.` : ''}`;
        },
      };
    }
    const other = findOutside(text);
    if (other) return { calls: [], answer: () => outsideLine(other) };
    if (!/\b(deck|monsters?|spells?|traps?)\b/.test(t)) return { calls: [], answer: () => `I couldn't tell which card you meant. Say its name, like "${removing ? 'take out' : 'add'} 2 Kuriboh".` };
  }

  // make it stronger
  if (/\b(stronger|better|improve|upgrade|optimi[sz]e|power ?up|beef|buff|boost|fix it|fix my deck|swap|replace)\b/.test(t) && !/\b(build|make me|create|new)\b.*\bdeck\b/.test(t)) return strongerPlan(w);

  // questions about a card
  const name = findCard(text, 'both');
  if (name && (/\b(what|explain|tell|how|does|is|read|about|info|show)\b/.test(t) || flat(text) === flat(bare(name)))) return cardPlan(name, w);
  if (!name) {
    const other = findOutside(text);
    if (other) return { calls: [], answer: () => `${outsideLine(other)} ${short(card(other)?.desc ?? '')}`.trim() };
  }

  // build a deck
  if (/\b(build|make|create|construct|give me|new deck|random|surprise|deck)\b/.test(t)) return buildPlan(text, w);

  if (name) return cardPlan(name, w);
  return { calls: [], answer: () => `I'm not sure what you mean. ${HELP}` };
}

const short = (s: string) => (s.length > 220 ? `${s.slice(0, 219).trimEnd()}…` : s).replace(/\s*\n\s*/g, ' ');

/** Cards in `to` that `from` doesn't have (as many copies as the difference). */
function diffList(from: string[], to: string[]): string[] {
  const left = [...from];
  const out: string[] = [];
  for (const n of to) {
    const i = left.indexOf(n);
    if (i >= 0) left.splice(i, 1);
    else out.push(n);
  }
  return out;
}

/** What to add from the collection, and what to chase in packs. Changes nothing. */
function suggestPlan(w: ChatWorld): Plan {
  const d = w.deck;
  const fit = (x: CardInfo) => !isExtraCard(x.name) && !d.main.includes(x.name);
  const mine = candidates(w, d, (x) => fit(x) && x.kind === 'monster').slice(0, 3);
  const backrow = candidates(w, d, (x) => fit(x) && x.kind !== 'monster').slice(0, 2);
  const chase = w.collection
    ? speedCards()
        .filter((x) => fit(x) && !(w.collection![x.name] ?? 0) && !unplayableReason(x.name) && !limitStatus(x.name))
        .sort((a, b) => worth(b, d) - worth(a, d))
        .slice(0, 3)
    : [];
  const owned = [...mine, ...backrow];
  return {
    calls: [{ name: 'view_deck', input: {} }],
    answer: () =>
      `${owned.length ? `From your cards, the best fits for this deck are ${listOf(owned.map((c) => c.name))}. Say "add" and a name to put one in.` : 'Your best cards are already in this deck.'}${chase.length ? ` Worth chasing in packs or the Card Shop: ${listOf(chase.map((c) => c.name))}.` : ''}`,
  };
}

/** More (or fewer) of one kind: swaps the weakest cards of the other kinds for the best of this kind. */
function kindShift(w: ChatWorld, kind: 'monster' | 'spell' | 'trap', by: number, why?: string, only: (c: CardInfo) => boolean = () => true): Plan {
  const d = w.deck;
  const isKind = (n: string) => card(n)?.kind === kind && !isExtraCard(n);
  if (by < 0) {
    const out = [...d.main].filter(isKind).sort((a, b) => worth(card(a)!, d) - worth(card(b)!, d)).slice(0, -by);
    if (!out.length) return { calls: [], answer: () => `There are no ${kind}s to cut.` };
    const fill = candidates(w, { ...d, main: d.main.filter((n) => !out.includes(n)) }, (c) => c.kind !== kind && !isExtraCard(c.name) && c.kind !== 'monster' === (kind === 'monster')).slice(0, out.length);
    return {
      calls: [{ name: 'edit_deck', input: { remove: counts(out), add: counts(fill.map((c) => c.name)) } }],
      answer: () => `Cut ${out.length} ${kind}s (${listOf(out)})${fill.length ? ` and put in ${listOf(fill.map((c) => c.name))}` : ''}.`,
    };
  }
  const work = { ...d, main: [...d.main] };
  const outs: string[] = [];
  if (work.main.length + by > MAIN_MAX || work.main.length >= MAIN_MIN) {
    // keep the size: make room from the weakest cards of the other kinds
    const others = [...work.main].filter((n) => !isKind(n)).sort((a, b) => worth(card(a)!, d) - worth(card(b)!, d));
    for (const n of others.slice(0, by)) (outs.push(n), work.main.splice(work.main.indexOf(n), 1));
  }
  const ins: string[] = [];
  for (let i = 0; i < by; i++) {
    const c = candidates(w, { ...work, main: [...work.main, ...ins] }, (x) => isKind(x.name) && only(x) && ins.filter((n) => n === x.name).length < 2)[0];
    if (!c) break;
    ins.push(c.name);
  }
  if (!ins.length) return { calls: [], answer: () => `You have no more ${kind}s that can go in${w.collection ? '; get more from packs or the Card Shop' : ''}.` };
  const outsUsed = outs.slice(0, ins.length);
  return {
    calls: [{ name: 'edit_deck', input: { remove: counts(outsUsed), add: counts(ins) } }],
    answer: () => `${why ? `For ${why}: added` : 'Added'} ${listOf(ins)}${outsUsed.length ? ` in place of ${listOf(outsUsed)}` : ''}.`,
  };
}

/** The built-in helper as a Model: the first step makes the tool calls, the next one answers. */
export function localModel(getWorld: () => ChatWorld): Model {
  let plan: Plan | null = null;
  return async (req, onText) => {
    const last = req.messages[req.messages.length - 1];
    const blocks = Array.isArray(last.content) ? (last.content as { type: string; text?: string; content?: unknown }[]) : [];
    const isResults = blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
    if (!isResults || !plan) {
      const said = blocks.find((b) => b.type === 'text')?.text ?? '';
      const text = said.split('\n\n<current_deck>')[0];
      plan = planFor(text, getWorld());
      await new Promise((r) => setTimeout(r, 120));
      if (plan.calls.length) return { stop_reason: 'tool_use', content: plan.calls.map((c, i) => ({ type: 'tool_use', id: `local${Date.now()}${i}`, name: c.name, input: c.input })) as unknown as Block[] } as ModelReply;
    }
    const results = isResults ? blocks.map((b) => String(b.content ?? '')) : [];
    const answer = plan.answer(results);
    plan = null;
    // the words appear a few at a time, like a reply being typed
    if (onText) for (const part of answer.match(/\S+\s*/g) ?? []) (onText(part), await new Promise((r) => setTimeout(r, 12)));
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: answer, citations: null }] as unknown as Block[] };
  };
}
