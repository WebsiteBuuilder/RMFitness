// Deck chat's built-in helper: no key, no internet, no cost. It reads what the duelist
// typed (or said: voice typing is loose, so it fixes misheard words and skips "hey" and
// "please"), works out what they want, and answers through the same tools and Model shape
// Claude uses, so Undo, the step trail and the change card work the same. It remembers the
// cards it just touched, so "take that out" and "why that one?" work. Builds use the game's
// random deck maker, steered by the theme, style, size and cards it heard.
import type Anthropic from '@anthropic-ai/sdk';
import { allCards, card, norm, skillCards, speedCards } from '../eds/db';

/** card(), remembered (misses too: a miss scans the whole card list, and old saves can hold names that left the game) */
const seen = new Map<string, CardInfo | undefined>();
function cd(n: string): CardInfo | undefined {
  if (!seen.has(n)) seen.set(n, card(n));
  return seen.get(n);
}
import { getSkill } from '../eds/skills';
import { COPIES, EXTRA_MAX, LIMITED_LIST_NAME, MAIN_MAX, MAIN_MIN, isExtraCard, limitStatus, speedDeckProblems, unplayableReason, whyCantAdd, type SpeedDeck } from '../eds/speedSave';
import { randomSpeedDeck, speedThemes } from '../eds/speedRandom';
import type { RandomStyle, RandomTheme } from '../eds/randomDeck';
import type { CardInfo } from '../eds/types';
import type { Model, ModelReply } from './agent';
import { runTool, type ChatWorld } from './tools';

type Block = Anthropic.Beta.BetaContentBlock;
type Kind = 'monster' | 'spell' | 'trap';
interface Call {
  name: string;
  input: Record<string, unknown>;
}
/** What the helper decided: tool calls to make, then the answer (given the tools' replies). */
interface Plan {
  calls: Call[];
  answer: (results: string[]) => string;
}
/** What the helper remembers between messages of one chat. */
export interface Memory {
  /** cards the last change put in, and took out */
  added: string[];
  removed: string[];
}
const freshMemory = (): Memory => ({ added: [], removed: [] });

const ATTRS = ['DARK', 'LIGHT', 'EARTH', 'WATER', 'FIRE', 'WIND', 'DIVINE'];
const RACES = ['Beast-Warrior', 'Winged Beast', 'Sea Serpent', 'Warrior', 'Spellcaster', 'Dragon', 'Fiend', 'Machine', 'Zombie', 'Beast', 'Fairy', 'Insect', 'Dinosaur', 'Reptile', 'Fish', 'Aqua', 'Pyro', 'Thunder', 'Rock', 'Plant', 'Psychic', 'Cyberse', 'Wyrm', 'Divine-Beast'];
const NUM: Record<string, number> = { a: 1, an: 1, one: 1, single: 1, another: 1, two: 2, couple: 2, three: 3, all: 3, every: 3, max: 3, both: 2 };
const bare = (n: string) => n.replace(/ \(Skill Card\)$/, '');
/** lower case, no punctuation: "Blue-Eyes White Dragon" -> "blue eyes white dragon" */
const flat = (s: string) => norm(s).replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const plural = (r: string) => (/(Fish|Psychic|Cyberse)$/.test(r) ? r : r.endsWith('y') ? r.slice(0, -1) + 'ies' : r + 's');
const kindWord = (w: string): Kind | null => (/^monsters?$/.test(w) ? 'monster' : /^spells?$/.test(w) ? 'spell' : /^traps?$/.test(w) ? 'trap' : null);
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
/** up to 20 characters, never splitting an emoji */
const clip = (s: string) => [...s.trim()].slice(0, 20).join('');
const short = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s).replace(/\s*\n\s*/g, ' ');
const inDeck = (d: SpeedDeck, n: string) => d.main.includes(n) || d.extra.includes(n) || d.skill === n;
const KIND_RE = '(monsters?|spells?|traps?)';

// ---------- names ----------
/** every Speed Duel card and Skill name, longest first, for spotting names inside a sentence */
let names: { flat: string; name: string; skill: boolean }[] | null = null;
function nameIndex() {
  if (!names || !names.length)
    names = [...speedCards().map((c) => ({ flat: flat(c.name), name: c.name, skill: false })), ...skillCards().map((c) => ({ flat: flat(bare(c.name)), name: c.name, skill: true }))]
      .filter((x) => x.flat.length >= 3)
      .sort((a, b) => b.flat.length - a.flat.length);
  return names;
}
const allowed = (x: { skill: boolean }, which: 'cards' | 'skills' | 'both') => which === 'both' || (which === 'skills') === x.skill;

/** how many cards' text names each card: "Red-Eyes Black Dragon" is named far more than "Red-Eyes Spirit" */
let fameMap: Map<string, number> | null = null;
function fame(n: string): number {
  if (!fameMap || !fameMap.size) {
    fameMap = new Map();
    for (const c of speedCards()) for (const q of c.desc.matchAll(/["“]([^"”]+)["”]/g)) fameMap.set(q[1], (fameMap.get(q[1]) ?? 0) + 1);
  }
  return fameMap.get(n) ?? 0;
}

/** A phrase that is part of one or more names: the one in the deck, else the shortest (the base card: "gearfried" -> Gearfried the Iron Knight). */
function partialName(phrase: string, which: 'cards' | 'skills' | 'both', d?: SpeedDeck): string | null {
  const q = flat(phrase);
  if (q.length < 4) return null;
  const hits = nameIndex().filter((x) => allowed(x, which) && ` ${x.flat} `.includes(` ${q} `));
  if (!hits.length) return null;
  const mine = d ? hits.filter((h) => inDeck(d, h.name)) : [];
  const from = mine.length ? mine : hits;
  const starts = from.filter((h) => h.flat.startsWith(q));
  return [...(starts.length ? starts : from)].sort((a, b) => fame(b.name) - fame(a.name) || a.flat.length - b.flat.length)[0].name;
}

/** The card (or Skill) named somewhere in the text, the longest name winning; or a close match of a phrase. */
export function findCard(text: string, which: 'cards' | 'skills' | 'both' = 'both', d?: SpeedDeck): string | null {
  const t = ` ${fixWords(flat(text))} `;
  for (const x of nameIndex()) if (allowed(x, which) && t.includes(` ${x.flat} `)) return x.name;
  // a phrase that is part of a name ("blue eyes white" -> Blue-Eyes White Dragon)
  return partialName(t, which, d);
}

interface Found {
  name: string;
  count: number | null;
}
/**
 * Every card named in the text, with the count said just before it ("add 2 kuriboh and a
 * sangan"). Whole names first (so a name with "and" in it stays whole), then the leftover
 * pieces between commas and "and" as parts of names.
 */
export function findCards(text: string, d?: SpeedDeck, which: 'cards' | 'skills' | 'both' = 'cards'): Found[] {
  let t = ` ${fixWords(flat(text))} `;
  // a card from outside Speed Duel ("pot of greed") is not part of a Speed Duel name ("Jar of Greed")
  const outside = findOutside(t);
  if (outside && !nameIndex().some((x) => t.includes(` ${x.flat} `) && x.flat.includes(flat(outside)))) t = t.replace(` ${flat(outside)} `, ` ${'#'.repeat(flat(outside).length)} `);
  const typed = new Set(flat(text).split(' '));
  const hits: { at: number; name: string; len: number }[] = [];
  for (const x of nameIndex()) {
    if (!allowed(x, which)) continue;
    // a one-word name that's an everyday word ("NEXT", "Storm") only counts when it's all that was said after the verb
    if (!x.flat.includes(' ') && (STOP.has(x.flat) || INTENT.has(x.flat) || COMMON.has(x.flat)) && !new RegExp(`^(add|put|remove|take out|cut|what is|whats|what does)? ?(an? |[1-3] )?${x.flat}( do| out| in)?$`).test(t.trim())) continue;
    let i = t.indexOf(` ${x.flat} `);
    while (i >= 0) {
      hits.push({ at: i, name: x.name, len: x.flat.length + 1 });
      t = t.slice(0, i + 1) + '#'.repeat(x.flat.length) + t.slice(i + 1 + x.flat.length);
      i = t.indexOf(` ${x.flat} `);
    }
  }
  // what's left between the separators may still be part of a name
  const pieces = t.split(/,|\b(?:and|plus|also|then|with)\b|#+/);
  let pos = 0;
  for (const p of pieces) {
    const at = t.indexOf(p, pos);
    pos = at + p.length;
    const words = p.trim().split(/\s+/).filter((w) => w && !STOP.has(w) && !INTENT.has(w) && !/^\d+$/.test(w) && !(w in NUM));
    for (let k = Math.min(4, words.length); k >= 1; k--) {
      let got = false;
      for (let i = 0; i + k <= words.length && !got; i++) {
        const phrase = words.slice(i, i + k).join(' ');
        if (phrase.length < 5) continue;
        // most of what was said must be the name: "harpies feather duster" is not Harpies' Hunting Ground
        // and at least one word typed as it is: a word bent by spelling fixes alone is not a card ("interesting" -> Intercepting)
        const real = words.slice(i, i + k).some((x) => typed.has(x));
        const n = real && (k * 2 > words.length || k === words.length) ? partialName(phrase, which, d) : null;
        if (n) (hits.push({ at: at + p.indexOf(words[i]), name: n, len: phrase.length }), (got = true));
      }
      if (got) break;
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const out: Found[] = [];
  let from = 0;
  for (const h of hits) {
    // the count is the last number between the previous name and this one
    const before = t.slice(from, h.at).trim().split(/\s+/).slice(-3);
    let count: number | null = null;
    for (const w of before) {
      if (/^\d{1,2}$/.test(w)) count = Number(w);
      else if (w in NUM) count = NUM[w];
    }
    if (/\ball\b/.test(t.slice(from, h.at)) || /^ all\b/.test(t.slice(h.at + h.len, h.at + h.len + 5))) count = COPIES;
    from = h.at + h.len;
    const same = out.find((o) => o.name === h.name);
    if (same) same.count = (same.count ?? 1) + (count ?? 1);
    else out.push({ name: h.name, count });
  }
  return out;
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
  // as said, and with misspellings fixed (fixing can bend a non-Speed name toward a Speed one)
  const said = ` ${flat(text)} `;
  const t = ` ${fixWords(flat(text))} `;
  return others?.find((x) => said.includes(` ${x.flat} `) || t.includes(` ${x.flat} `))?.name ?? null;
}
const outsideLine = (n: string) => `${n} isn't a Speed Duel card (Konami never printed it in a Speed Duel product), so it can't go in a Speed Duel deck.`;

// ---------- fixing misheard and misspelled words ----------
const STOP = new Set(
  'a an the me my i to for of with from and or please pls plz can could you u build make create give get want need new deck decks card cards some using use around based on out it its this that full whole good best strongest strong cool nice fun really very just only more type themed theme kind style monster monsters spell spells trap traps let lets do one up random is are was be have has had in at as by so if then than them those these thing things'.split(' '),
);
/** everyday words that are also whole card names */
const COMMON = new Set('next storm rush change reload fusion reinforcements oscillo hero mirror wall shield sword swords trap hole hole snatch steal monster reborn tribute ultimate offering possessed negate'.split(' '));

/** the words requests are made of: never "corrected" into card names */
const INTENT = new Set(
  'add put include throw stick chuck remove take get rid drop cut delete lose minus swap replace trade change switch fill finish complete top clear empty wipe start over reset rename call name skill skills rule rules rate rating review grade score check explain describe tell show what which whats how hows why when who where does did done stronger better improve upgrade aggressive aggro offensive defensive control faster slower attack attackers attacking beatdown traps spells monsters extra main another other different instead same like dont don want wanna gonna lot lots few less fewer most least weakest worst weak bad best strongest powerful meta win beat summon summoning tribute fusion ritual synchro xyz tuner level levels atk def life points hand draw turn first phase zones field copies limited forbidden banned list good great nice fine okay thanks thank cool help hi hello hey yo sup suggest recommend recommendation ideas idea themes theme build built undo back revert again also too one two three all every much many cards card deck decks dragons warriors spellcasters zombies fiends machines beasts fairies insects dinosaurs reptiles fish aqua pyro thunder rock plant plants psychic cyberse wyrm wyrms dark light earth water fire wind divine bigger smaller size number count know kinda sorta pretty maybe actually just still keep keeps keeping work works working power powerful stuff something anything everything cool start game games play playing played think thinking need needs brother sister friend friends computer opponent losing lost loses wins winning duel duels duelling dueling time times now today better worse right wrong way thing interesting next little sister mom dad family kid kids defense defence attack help'.split(
    ' ',
  ),
);
let vocab: Map<string, number> | null = null;
function vocabulary() {
  if (!vocab || !vocab.size) {
    vocab = new Map();
    for (const x of nameIndex()) for (const w of x.flat.split(' ')) if (w.length >= 3) vocab.set(w, (vocab.get(w) ?? 0) + 1);
  }
  return vocab;
}
/** edit distance, giving up past `max` */
function dist(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      low = Math.min(low, cur[j]);
    }
    if (low > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
const fixed = new Map<string, string>();
/** "blue eys white dragn" -> "blue eyes white dragon", "harpy" -> "harpie": each unknown word to the closest word in a card name */
function fixWords(t: string): string {
  const v = vocabulary();
  const ws = t.split(' ');
  for (let i = 0; i + 1 < ws.length; i++) {
    const [a, b] = [ws[i], ws[i + 1]];
    if (a.length < 3 || b.length < 2 || (v.has(a) && v.has(b)) || INTENT.has(a) || INTENT.has(b) || STOP.has(a) || STOP.has(b)) continue;
    const j = a + b;
    if (v.has(j) || [...v.keys()].some((x) => x[0] === j[0] && Math.abs(x.length - j.length) <= 1 && dist(j, x, 1) <= 1)) ws.splice(i, 2, j);
  }
  return ws
    .map((w) => {
      if (w.length < 3 || v.has(w) || INTENT.has(w) || STOP.has(w) || /\d/.test(w)) return w;
      const hit = fixed.get(w);
      if (hit !== undefined) return hit;
      const max = w.length >= 5 ? 2 : 1;
      let best = w;
      let bestD = max + 1;
      let bestN = 0;
      for (const [x, n] of v) {
        if (x[0] !== w[0] && w.length < 6) continue;
        const dd = dist(w, x, max);
        if (dd > max || (dd === 2 && w.length < 7 && x.slice(0, 4) !== w.slice(0, 4))) continue;
        if (dd < bestD || (dd === bestD && n > bestN)) (best = x), (bestD = dd), (bestN = n);
      }
      fixed.set(w, best);
      return best;
    })
    .join(' ');
}

/** Voice and texting clean-up: "hey can u at 3 kuriboh pls" -> "add 3 kuriboh". */
export function clean(text: string): string {
  let t = flat(text)
    .replace(/\b(\w+) (s|t|ll|re|ve|d|m)\b/g, '$1$2') // what s -> whats, don t -> dont
    .replace(/\b(pls|plz|please|thx|thanks|thank you|lol|bro|dude|man)\b/g, ' ')
    .replace(/\bat (?=([1-3]|one|two|three|a|an|another|some)\b)/g, 'add ')
    .replace(/\b(ad|adde?|adding|added)\b/g, 'add')
    .replace(/\b(add|put in|put|throw in) (to|too|tu)\b(?! (the|my|it|this|deck))/g, '$1 2')
    .replace(/\btakeout\b/g, 'take out')
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 4; i++) t = t.replace(/^(hey|hi|hello|yo|sup|ok|okay|so|um|uh|well|alright|right|can you|could you|can u|could u|would you|will you|i want you to|id like you to|i need you to|i want to|i wanna|id like to|lets|let me)\b\s*/, '');
  return t;
}

function stats(c: CardInfo): string {
  if (c.sub === 'Skill') return `${c.character ?? 'a duelist'}'s Skill`;
  if (c.kind !== 'monster') return `${c.sub === 'Normal' ? '' : `${c.sub} `}${c.kind === 'spell' ? 'Spell' : 'Trap'}`;
  const star = c.rank !== undefined ? `Rank ${c.rank}` : c.linkRating !== undefined ? `Link ${c.linkRating}` : `Level ${c.level ?? '?'}`;
  return `${star} ${c.attribute ?? ''} ${c.race ?? ''} ${c.sub === 'Normal' ? 'Normal Monster' : c.sub === 'Effect' ? 'Effect Monster' : `${c.sub} Monster`}, ${c.atk ?? '?'} ATK${c.linkRating !== undefined ? '' : ` / ${c.def ?? '?'} DEF`}`.replace(/\s+/g, ' ');
}

function counts(list: string[]): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const n of list) m.set(n, (m.get(n) ?? 0) + 1);
  return [...m].map(([name, count]) => ({ name, count }));
}
/** "3 Kuriboh, Sangan and 2 Pot of Greed" */
function listOf(list: string[]): string {
  const parts = counts(list).map((x) => (x.count > 1 ? `${x.count} ${bare(x.name)}` : bare(x.name)));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '');
}
const refusedOf = (r: string) => r.match(/^Refused: (.*)$/m)?.[1] ?? '';
const readyOf = (r: string) => (/Ready to duel\./.test(r) ? '' : (r.match(/^Not ready: (.*)$/m)?.[1] ?? ''));

// ---------- judging cards ----------
const RITUAL_OF = (c: CardInfo) => c.desc.match(/Ritual Summon ["“]([^"”]+)["”]/)?.[1] ?? null;
/** the Ritual Spell for a Ritual Monster, from a pool of names */
const ritualSpellFor = (mon: string, pool: Iterable<string>) => [...pool].find((n) => cd(n)?.kind === 'spell' && cd(n)?.sub === 'Ritual' && RITUAL_OF(cd(n)!) === mon) ?? null;

function needed(c: CardInfo, d: SpeedDeck): boolean {
  const all = [...d.main, ...d.extra].filter((n) => n !== c.name);
  if (c.name === 'Polymerization' && d.extra.some((n) => cd(n)?.sub === 'Fusion')) return true;
  return all.some((n) => (cd(n)?.desc ?? '').includes(`"${c.name}"`) || (cd(n)?.desc ?? '').includes(`“${c.name}”`));
}
/** the names a card's text supports ("Elemental HERO"), other than its own */
const quoted = (c: CardInfo) => [...c.desc.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1]).filter((q) => q !== c.name);

/**
 * A rough "how good is this card in a Speed Duel deck" for swaps: strong low-Level monsters,
 * removal and protection; support for a name the deck doesn't play is worth little, and a
 * Ritual Monster without its Spell (or a Spell without its monster) is dead.
 */
function worth(c: CardInfo, d?: SpeedDeck): number {
  let v: number;
  if (c.kind !== 'monster') v = 1000 + (c.vanilla ? 0 : 300) + (/destroy|negate|banish/i.test(c.desc) ? 400 : 0) - (/pay half your life ?points|pay half your lp/i.test(c.desc) ? 300 : 0);
  else {
    const lv = c.level ?? 4;
    // big monsters cost Tributes, and ones that can't be Normal Summoned need a whole plan
    v = (c.atk ?? 0) + (c.vanilla ? 0 : 350) - (lv >= 7 ? 1300 : lv >= 5 ? 500 : 0) - (/cannot be normal summoned|must (first )?be special summoned|requires 3 tributes/i.test(c.desc) ? 1600 : 0);
    // drawbacks: hands the opponent cards, can't attack or change position, pays to stay
    if (/opponent draws|cannot attack|cannot change its battle position|is changed to defense position|destroy this card|pay \d+ (life ?points|lp)|take \d+ damage/i.test(c.desc)) v -= 600;
    // the deck's Type or Attribute
    if (d) {
      const mons = d.main.map((n) => cd(n)).filter((m): m is CardInfo => m?.kind === 'monster');
      const most = (f: (m: CardInfo) => string | undefined) => {
        const m = new Map<string, number>();
        for (const x of mons) if (f(x)) m.set(f(x)!, (m.get(f(x)!) ?? 0) + 1);
        return [...m].sort((a, b) => b[1] - a[1])[0];
      };
      const race = most((m) => m.race);
      const attr = most((m) => m.attribute);
      if (race && race[1] >= 6 && c.race === race[0]) v += 450;
      if (attr && attr[1] >= 6 && c.attribute === attr[0]) v += 250;
    }
  }
  if (d) {
    if (c.kind === 'monster' && c.sub === 'Ritual' && !ritualSpellFor(c.name, d.main)) v -= 2500;
    if (c.kind === 'spell' && c.sub === 'Ritual') v += RITUAL_OF(c) && d.main.includes(RITUAL_OF(c)!) ? 1200 : -2500;
    // a card other cards here need (Polymerization for the Fusions, a Ritual's Spell) stays
    if (d.main.includes(c.name) && needed(c, d)) v += 1500;
    const q = quoted(c);
    if (q.length && c.sub !== 'Ritual' && !q.some((x) => [...d.main, ...d.extra].some((n) => n !== c.name && (n.includes(x) || (cd(n)?.desc ?? '').includes(`"${x}"`))))) v -= 900;
  }
  return v;
}

/** worth by name; a name the card list doesn't know (an old save) sorts last */
const wn = (n: string, d?: SpeedDeck) => (cd(n) ? worth(cd(n)!, d) : -1e6);
const isNeeded = (n: string, d: SpeedDeck) => !!cd(n) && needed(cd(n)!, d);

/** Owned cards that could go in, strongest (for this deck) first. */
function candidates(w: ChatWorld, d: SpeedDeck, f: (c: CardInfo) => boolean, skip: string[] = []): CardInfo[] {
  return speedCards()
    .filter((c) => f(c) && !skip.includes(c.name) && !whyCantAdd(d, c.name, w.collection))
    .map((c) => [c, worth(c, d)] as const)
    .sort((a, b) => b[1] - a[1])
    .map((x) => x[0]);
}

/** Why a card earns its place, in a few words. */
function reason(c: CardInfo, d: SpeedDeck): string {
  if (c.kind === 'monster') {
    if (c.sub === 'Ritual') return `your Ritual finisher (with ${ritualSpellFor(c.name, d.main) ?? 'its Ritual Spell'})`;
    if (isExtraCard(c.name)) return `an Extra Deck summon your deck can make`;
    if ((c.level ?? 4) <= 4 && (c.atk ?? 0) < 1200 && !c.vanilla) return `its effect: ${short(c.desc, 140)}`;
    if ((c.level ?? 4) <= 4) return `${c.atk ?? 0} ATK with no Tribute${c.vanilla ? '' : ', plus an effect'}`;
    return `a ${c.atk ?? 0} ATK hitter worth a Tribute`;
  }
  if (/destroy/i.test(c.desc)) return 'it destroys your opponent\'s cards';
  if (/negate/i.test(c.desc)) return 'it stops your opponent\'s plays';
  if (/draw/i.test(c.desc)) return 'it draws you cards';
  if (/special summon/i.test(c.desc)) return 'it brings out monsters for free';
  const q = quoted(c).find((x) => d.main.some((n) => n.includes(x)));
  if (q) return `it supports your ${q} cards`;
  return c.kind === 'trap' ? 'it protects your field' : 'it backs up your monsters';
}

/** The pool the deck maker may use: owned (or every) card, minus some (just cut, or a kind they don't want). */
function poolFor(w: ChatWorld, drop: (n: string) => boolean): Record<string, number> | undefined {
  const base: Record<string, number> = w.collection ? { ...w.collection } : Object.fromEntries([...speedCards().map((c) => [c.name, COPIES] as const), ...skillCards().map((c) => [c.name, 1] as const)]);
  if (!w.collection && !Object.keys(base).length) return undefined;
  for (const n of Object.keys(base)) if (drop(n)) delete base[n];
  return base;
}

// ---------- the deck ----------
function describe(main: string[], skill: string | null): string {
  const cs = main.map((n) => cd(n)!).filter(Boolean);
  const mons = cs.filter((c) => c.kind === 'monster');
  const ace = [...mons].sort((a, b) => (b.atk ?? 0) - (a.atk ?? 0))[0];
  const k = (x: string) => cs.filter((c) => c.kind === x).length;
  return `It has ${main.length} cards: ${k('monster')} monsters, ${k('spell')} spells and ${k('trap')} traps${ace ? `, with ${ace.name} (${ace.atk} ATK) as the big hitter` : ''}${skill ? `, and ${bare(skill)} as the Skill` : ''}.`;
}

function tipsFor(d: SpeedDeck): string[] {
  const cs = d.main.map((n) => cd(n)!).filter(Boolean);
  const mons = cs.filter((c) => c.kind === 'monster');
  const high = mons.filter((c) => (c.level ?? 0) >= 5);
  const out: string[] = [];
  if (mons.length < 10) out.push(`Only ${mons.length} monsters: 11 to 13 is safer in a 20-card deck, so you always have something to summon.`);
  if (mons.length > 15) out.push(`${mons.length} monsters leaves little room for spells and traps that protect them.`);
  if (high.length > 4) out.push(`${high.length} monsters need Tributes (Level 5+). With only 3 Monster Zones, 2 to 4 is plenty.`);
  const deadRitual = mons.filter((c) => c.sub === 'Ritual' && !ritualSpellFor(c.name, d.main));
  if (deadRitual.length) out.push(`${deadRitual[0].name} has no Ritual Spell here, so it can't be summoned.`);
  if (d.extra.some((n) => cd(n)?.sub === 'Fusion') && !d.main.some((n) => /polymerization|fusion/i.test(n))) out.push('The Fusion monsters need Polymerization (or another Fusion card) in the Main Deck.');
  if (!d.skill) out.push('No Skill yet: a Skill is free power, pick one.');
  if (d.main.length > 20) out.push(`At ${d.main.length} cards you draw your best cards less often; 20 is the strongest size.`);
  return out;
}

function ratePlan(w: ChatWorld): Plan {
  const d = w.deck;
  if (!d.main.length && !d.extra.length) return { calls: [], answer: () => 'The deck is empty. Say "build me a deck" and I\'ll make one from your cards.' };
  if (!d.main.length) return { calls: [], answer: () => `Only the Extra Deck is filled so far (${listOf(d.extra)}). Say "fill it up" and I'll add a Main Deck that fits.` };
  const cs = d.main.map((n) => cd(n)!).filter(Boolean);
  const low = cs.filter((c) => c.kind === 'monster' && (c.level ?? 0) <= 4);
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

/** How the deck plays, in a few sentences. */
function explainPlan(w: ChatWorld): Plan {
  const d = w.deck;
  if (!d.main.length) return { calls: [], answer: () => (d.extra.length ? `Only the Extra Deck is filled so far: ${listOf(d.extra)}. Say "fill it up" for a Main Deck that fits.` : 'The deck is empty. Say "build me a deck" and I\'ll make one.') };
  const cs = [...new Set(d.main)].map((n) => cd(n)!).filter(Boolean);
  const low = cs.filter((c) => c.kind === 'monster' && (c.level ?? 0) <= 4).sort((a, b) => (b.atk ?? 0) - (a.atk ?? 0));
  const big = cs.filter((c) => c.kind === 'monster' && (c.level ?? 0) >= 5).sort((a, b) => (b.atk ?? 0) - (a.atk ?? 0));
  const removal = cs.filter((c) => c.kind !== 'monster' && /destroy|banish|return .* to the hand/i.test(c.desc));
  const traps = cs.filter((c) => c.kind === 'trap');
  const parts = [
    describe(d.main, null),
    low.length ? `It opens with ${listOf(low.slice(0, 3).map((c) => c.name))} attacking with no Tribute.` : '',
    big.length ? `Then it Tributes for ${listOf(big.slice(0, 2).map((c) => c.name))}.` : '',
    removal.length ? `${listOf(removal.slice(0, 3).map((c) => c.name))} clear the way.` : '',
    traps.length ? `${traps.length} traps (${listOf(traps.slice(0, 2).map((c) => c.name))}${traps.length > 2 ? '…' : ''}) guard your field on their turn.` : '',
    d.extra.length ? `The Extra Deck has ${listOf([...new Set(d.extra)])}.` : '',
    d.skill ? `Skill: ${bare(d.skill)}. ${short(cd(d.skill)?.desc ?? '', 160)}` : 'There is no Skill yet; say "pick a Skill".',
  ];
  return { calls: [{ name: 'view_deck', input: {} }], answer: () => parts.filter(Boolean).join(' ') };
}

// ---------- building ----------
interface Wish {
  size: number;
  style: RandomStyle;
  theme: RandomTheme;
  /** a card name or a name family to build around ("Harpie", "Dark Magician") */
  around: string | null;
  /** an exact card it was named after */
  aroundCard: string | null;
  best: boolean;
  /** kinds they don't want ("no traps") */
  without: Kind[];
}

function readWish(said: string, w: ChatWorld): Wish & { arounds: string[] } {
  const t = fixWords(said);
  const size = Number(t.match(/\b(2\d|30)\b/)?.[1] ?? 0) || 20;
  const style: RandomStyle = /\b(aggro|aggressive|attack|beat ?down|offen[cs]e|offensive|rush|damage|fast)\b/.test(t) ? 'beatdown' : /\b(control|defen[cs]e|defensive|trap heavy|lots of traps|stall|slow)\b/.test(t) ? 'control' : 'balanced';
  let theme: RandomTheme = /\b(surprise|random|anything|whatever)\b/.test(t) ? { kind: 'surprise' } : { kind: 'any' };
  const attr = ATTRS.find((a) => new RegExp(`\\b${a.toLowerCase()}\\b`).test(t) && !new RegExp(`\\b${a.toLowerCase()} (magician|hole|world|world|ruler|armed|blade|knight|warrior)`).test(t));
  const race = RACES.find((r) => new RegExp(`\\b${flat(r)}(s|es)?\\b`).test(t.replace(/\bspell ?casters?\b/, 'spellcaster').replace(/\bwarrior beasts?\b/, 'beast warrior')));
  const without = (['monster', 'spell', 'trap'] as Kind[]).filter((k) => new RegExp(`\\b(no|without( any)?|zero|0)\\s+${k}s?\\b`).test(t));
  // cards or families to build around ("dark magician and blue eyes"): one per piece of the sentence
  const owned = (n: string) => !w.collection || (w.collection[n] ?? 0) > 0;
  const families: { around: string; card: string | null }[] = [];
  for (const piece of t.split(/,|\b(?:and|plus|with|also)\b/)) {
    const tt = ` ${piece.trim()} `;
    const named = nameIndex().find((x) => !x.skill && tt.includes(` ${x.flat} `));
    if (named && owned(named.name)) {
      families.push({ around: named.flat, card: named.name });
      continue;
    }
    const words = piece.trim().split(' ').slice(0, 30).filter((x) => x && !STOP.has(x) && !INTENT.has(x) && !/^\d+$/.test(x) && !/^(deck|decks|that|thats|which|is|aggressive|control|defensive|beatdown|balanced|surprise)$/.test(x));
    let found: string | null = null;
    for (let k = Math.min(3, words.length); k >= 1 && !found; k--)
      for (let i = 0; i + k <= words.length && !found; i++) {
        const q = words.slice(i, i + k).join(' ');
        if (q.length < 4) continue;
        const hits = nameIndex().filter((c) => !c.skill && owned(c.name) && ` ${c.flat} `.includes(` ${q} `) && !unplayableReason(c.name));
        if (hits.length >= 2 || (hits.length === 1 && k >= 2)) found = q;
      }
    if (found && !(race && flat(race).startsWith(found))) families.push({ around: found, card: null });
  }
  const around = families[0]?.around ?? null;
  const aroundCard = families[0]?.card ?? null;
  if (race) theme = { kind: 'race', value: race };
  else if (attr && !(around && around.includes(attr.toLowerCase()))) theme = { kind: 'attribute', value: attr };
  return { size: Math.min(MAIN_MAX, Math.max(MAIN_MIN, size)), style, theme, around, aroundCard, arounds: families.map((f) => f.around), best: /\b(best|strongest|strong|good|top|meta|op|powerful|win)\b/.test(t), without };
}

/**
 * Cards to build around a name: the cards carrying it, the cards their text names ("Dark
 * Magician Girl" brings Dark Magician), the ones whose text names it, and the Ritual Spell
 * for any Ritual Monster among them. Up to 15.
 */
function aroundCards(q: string, w: ChatWorld): string[] {
  const owned = (n: string) => (w.collection ? Math.min(COPIES, w.collection[n] ?? 0) : COPIES);
  const pool = speedCards().filter((c) => !unplayableReason(c.name) && owned(c.name) > 0 && limitStatus(c.name) !== 'Forbidden');
  const byName = new Map(pool.map((c) => [c.name, c]));
  const core = pool.filter((c) => ` ${flat(c.name)} `.includes(` ${q} `));
  const named = [...new Set(core.flatMap(quoted))].map((n) => byName.get(n)).filter((c): c is CardInfo => !!c && !core.includes(c));
  const support = pool.filter((c) => !core.includes(c) && !named.includes(c) && ` ${flat(c.desc)} `.includes(` ${q} `)).sort((a, b) => worth(b) - worth(a));
  const list = [...core, ...named, ...support.filter((c) => c.kind === 'monster').slice(0, 3), ...support.filter((c) => c.kind !== 'monster').slice(0, 4)];
  const out: string[] = [];
  const room = () => out.length < 15;
  for (const c of list) {
    if (c.kind === 'monster' && c.sub === 'Ritual') {
      const sp = ritualSpellFor(c.name, byName.keys());
      if (!sp) continue;
      for (let k = 0; k < Math.min(2, owned(sp)) && room(); k++) out.push(sp);
    }
    if (c.kind === 'spell' && c.sub === 'Ritual' && !list.some((m) => m.name === RITUAL_OF(c))) continue;
    // big monsters and support: fewer copies, the deck still needs early plays
    // the family's own cards come in full; big support monsters at 2 (the deck still needs early plays)
    const k = c.kind === 'monster' && (c.level ?? 4) >= 5 && !core.includes(c) ? Math.min(2, owned(c.name)) : owned(c.name);
    for (let i = 0; i < k && room(); i++) out.push(c.name);
  }
  return out;
}

/** How good a built deck looks, for picking the best of a few tries: strong early monsters and real spells/traps. */
function deckScore(main: string[]): number {
  const cs = main.map((n) => cd(n)!).filter(Boolean);
  const mons = cs.filter((c) => c.kind === 'monster');
  const low = mons.filter((c) => (c.level ?? 0) <= 4);
  const avg = low.reduce((a, c) => a + (c.atk ?? 0), 0) / Math.max(1, low.length);
  const effects = cs.filter((c) => !c.vanilla).length;
  return avg + effects * 40 + Math.min(low.length, 12) * 60 - Math.max(0, mons.length - low.length - 4) * 300;
}

const deckTitle = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

function buildPlan(t: string, w: ChatWorld): Plan {
  const called = t.match(/\b(?:and )?(?:call it|name it|called|named)\s+(.+)$/);
  const wish = readWish(called ? t.slice(0, called.index) : t, w);
  const keepCards = wish.arounds
    .flatMap((a, i, all) => aroundCards(a, w).slice(0, all.length > 1 ? 9 : 15))
    .filter((n) => !wish.without.includes(cd(n)!.kind as Kind))
    .slice(0, 18);
  const collection = wish.without.length ? poolFor(w, (n) => wish.without.includes(cd(n)?.kind as Kind) && cd(n)?.sub !== 'Skill') : w.collection;
  const tries = wish.best ? 8 : 4;
  let best: { main: string[]; extra: string[]; skill: string | null; label: string; notes: string[] } | null = null;
  let error = '';
  for (let i = 0; i < tries; i++) {
    const r = randomSpeedDeck(collection, { size: wish.size, style: wish.style, theme: wish.theme, keep: keepCards.length ? { main: keepCards.filter((n) => !isExtraCard(n)), extra: keepCards.filter(isExtraCard), skill: null } : undefined });
    if ('error' in r) {
      error = r.error;
      continue;
    }
    if (!best || deckScore(r.main) > deckScore(best.main)) best = r;
  }
  if (!best) return { calls: [], answer: () => `I couldn't build that one: ${(error || 'not enough cards').replace(/\s*Open packs.*$/, '').replace(/\.$/, '')}${wish.without.length ? ` (without ${wish.without.map((k) => `${k}s`).join(' or ')})` : ''}. Open packs in the Card Shop for more cards, or try a different theme.` };
  const b = best;
  // a Skill made for the theme beats a general one
  const themeSkill = wish.around ? skillCards().find((x) => getSkill(x.name) && (!w.collection || (w.collection[x.name] ?? 0) > 0) && limitStatus(x.name) !== 'Forbidden' && ` ${flat(x.desc)} `.includes(` ${wish.around} `)) : undefined;
  if (themeSkill && !whyCantAdd({ id: '', name: '', main: b.main, extra: b.extra, skill: null }, themeSkill.name, w.collection)) b.skill = themeSkill.name;
  // how much of the theme made it in: a deck is only named after it when it really is one
  const fam = wish.around ? b.main.filter((n) => ` ${flat(n)} `.includes(` ${wish.around} `) || ` ${flat(cd(n)?.desc ?? '')} `.includes(` ${wish.around} `) || keepCards.includes(n)).length : 0;
  const themed = wish.theme.kind === 'race' ? b.main.filter((n) => cd(n)?.race === (wish.theme as { value: string }).value).length : wish.theme.kind === 'attribute' ? b.main.filter((n) => cd(n)?.attribute === (wish.theme as { value: string }).value).length : 0;
  const thin = (wish.around && (fam < 3 || fam < Math.min(6, keepCards.length))) || ((wish.theme.kind === 'race' || wish.theme.kind === 'attribute') && themed < 6);
  const themeName = wish.theme.kind === 'race' ? plural(wish.theme.value) : wish.theme.kind === 'attribute' ? wish.theme.value : '';
  const both = wish.arounds.length > 1 && !thin ? wish.arounds.map((a) => deckTitle(a)).join(' and ') : null;
  const name = called ? clip(deckTitle(called[1])) : both ? clip(wish.arounds.map((a) => deckTitle(a)).join(' & ')) : (thin ? 'Mixed deck' : wish.aroundCard ? bare(wish.aroundCard) : wish.around ? deckTitle(wish.around) : themeName ? (wish.theme.kind === 'attribute' ? `${themeName} deck` : themeName) : wish.style === 'beatdown' ? 'Rush deck' : wish.style === 'control' ? 'Control deck' : 'Chat deck').slice(0, 20);
  const label = both ? `${both} deck` : thin ? 'mixed deck' : wish.aroundCard ? `${bare(wish.aroundCard)} deck` : wish.around ? `${deckTitle(wish.around)} deck` : themeName ? `${themeName} deck` : b.label;
  const have = wish.around ? fam : themed;
  const what = wish.aroundCard ? bare(wish.aroundCard) : wish.around ? deckTitle(wish.around) : wish.theme.kind === 'race' ? wish.theme.value : themeName;
  const thinNote = thin ? ` You only have ${have || 'no'} ${what} card${have === 1 ? '' : 's'} that fit${have === 1 ? 's' : ''}, so it's a mixed deck for now. I filled the rest with your best cards. More come from packs and the Card Shop.` : '';
  return {
    calls: [
      { name: 'collection_overview', input: {} },
      { name: 'edit_deck', input: { clear: true, skill: b.skill, add: counts([...b.main, ...b.extra]), name } },
    ],
    answer: (rs) => {
      const r = rs[1] ?? '';
      const style = wish.style === 'beatdown' ? ' It leans on attacking fast.' : wish.style === 'control' ? ' It plays slower, with more traps to protect your field.' : '';
      const notes = b.notes.filter((n) => !/Not enough/.test(n) || !thin);
      const missing = readyOf(r);
      const famLine = !thin && wish.around ? ` ${fam} of them are ${wish.aroundCard ? bare(wish.aroundCard) : deckTitle(wish.around)} cards or their support.` : '';
      return `Built a ${label} from ${w.collection ? 'your cards' : 'every Speed Duel card'}${wish.without.length ? ` with no ${wish.without.map((k) => `${k}s`).join(' or ')}` : ''}. ${describe(b.main, b.skill)}${famLine}${thinNote}${style}${notes.length ? ` ${notes.join(' ')}` : ''}${missing ? ` Not ready yet: ${missing}.` : ''} Say "make it stronger", "more traps" or "add 2 of something" to tweak it.`;
    },
  };
}

// ---------- edits ----------
function strongerPlan(w: ChatWorld): Plan {
  const d = w.deck;
  if (!d.main.length && !d.extra.length) return buildPlan('build my strongest deck', w);
  if (d.main.length < MAIN_MIN) return fillPlan(w, MAIN_MIN, freshMemory(), `It needs ${MAIN_MIN} Main Deck cards first, so I filled it`);
  const inDeckCards = [...new Set(d.main)].map((n) => cd(n)).filter((c): c is CardInfo => !!c && !isExtraCard(c.name));
  const weak = inDeckCards.filter((c) => c.kind === 'monster').sort((a, b) => worth(a, d) - worth(b, d));
  const swaps: { out: string; in: string }[] = [];
  let work: SpeedDeck = { ...d, main: [...d.main] };
  for (const c of weak) {
    if (swaps.length >= 4) break;
    const without = { ...work, main: [...work.main] };
    without.main.splice(without.main.indexOf(c.name), 1);
    if (needed(c, without)) continue;
    const better = candidates(w, without, (x) => x.kind === 'monster' && !isExtraCard(x.name) && worth(x, without) > worth(c, without) + 250 && !swaps.some((s) => s.in === x.name))[0];
    if (!better) continue;
    swaps.push({ out: c.name, in: better.name });
    work = { ...without, main: [...without.main, better.name] };
  }
  let skill: string | null | undefined;
  if (!d.skill) skill = skillPick(w, null);
  if (!swaps.length && !skill) return { calls: [{ name: 'view_deck', input: {} }], answer: () => `This deck already uses the strongest cards you own for its slots. ${tipsFor(d).join(' ') || 'Win duels and open packs to get stronger cards, then ask again.'}` };
  return {
    calls: [{ name: 'edit_deck', input: { remove: swaps.map((s) => ({ name: s.out, count: 1 })), add: swaps.map((s) => ({ name: s.in, count: 1 })), ...(skill ? { skill } : {}) } }],
    answer: (rs) => {
      const lines = swaps.map((s) => `${s.out} → ${s.in} (${cd(s.in)?.atk ?? ''} ATK)`);
      const refused = refusedOf(rs[0] ?? '');
      return `${lines.length ? `Swapped in stronger monsters: ${lines.join('; ')}.` : ''}${skill ? ` Added the Skill ${bare(skill)}.` : ''}${refused ? ` Couldn't do: ${refused}.` : ''}`.trim();
    },
  };
}

/** The Skill the deck maker would choose for this deck, other than `not`. */
function skillPick(w: ChatWorld, not: string | null): string | null {
  const d = w.deck;
  const collection = not ? poolFor(w, (n) => n === not) : w.collection;
  for (let i = 0; i < 3; i++) {
    const r = randomSpeedDeck(collection, { size: Math.max(MAIN_MIN, d.main.length), keep: { main: d.main, extra: d.extra, skill: null } });
    if (!('error' in r) && r.skill && r.skill !== not) return r.skill;
  }
  return null;
}

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

/** Tops the Main Deck up to `size` with cards that fit, never the ones just cut. */
function fillPlan(w: ChatWorld, size: number, mem: Memory, why = '', notKind: Kind | null = null): Plan {
  const d = w.deck;
  const r = randomSpeedDeck(poolFor(w, (n) => (mem.removed.includes(n) && !d.main.includes(n)) || (!!notKind && cd(n)?.kind === notKind)), { size, keep: { main: d.main, extra: d.extra, skill: d.skill } });
  if ('error' in r) return { calls: [], answer: () => `I couldn't fill it: ${r.error}` };
  const added = diffList(d.main, r.main).slice(0, Math.max(0, size - d.main.length));
  if (!added.length) return { calls: [], answer: () => `You have no more cards that fit${w.collection ? '; get more from packs or the Card Shop' : ''}.` };
  return { calls: [{ name: 'edit_deck', input: { add: counts(added) } }], answer: () => `${why || `Filled the deck to ${d.main.length + added.length}`} with ${listOf(added)}.` };
}

/** A cut that leaves the deck too small to duel, then a refill back to the minimum (never with what was cut, or the kind cut). */
function refill(cut: Plan, w: ChatWorld, notKind: Kind | null): Plan {
  const edit = cut.calls[0].input as { remove: { name: string; count: number }[] };
  const r = runTool(w, 'edit_deck', edit);
  if (!r.deck) return cut;
  const fill = fillPlan({ ...w, deck: r.deck }, MAIN_MIN, { added: [], removed: edit.remove.map((x) => x.name) }, 'To keep it at 20 cards I put in', notKind);
  if (!fill.calls.length) return { calls: cut.calls, answer: (rs) => `${cut.answer(rs)} The deck needs ${MAIN_MIN} cards to duel and you have nothing else that fits; say "undo" to put them back.` };
  return { calls: [...cut.calls, ...fill.calls], answer: (rs) => `${cut.answer(rs.slice(0, 1))} ${fill.answer(rs.slice(1))}` };
}

/** Cuts the weakest cards down to `size`. */
function trimPlan(d: SpeedDeck, size: number): Plan {
  const out = [...d.main].sort((a, b) => wn(a, d) - wn(b, d)).slice(0, d.main.length - size);
  return { calls: [{ name: 'edit_deck', input: { remove: counts(out) } }], answer: () => `Trimmed it to ${size} cards by cutting the weakest: ${listOf(out)}.` };
}

/** More (or fewer) of one kind: swaps the weakest cards of the other kinds for the best of this kind. */
function kindShift(w: ChatWorld, kind: Kind, by: number, why?: string, only: (c: CardInfo) => boolean = () => true): Plan {
  const d = w.deck;
  const isKind = (n: string) => cd(n)?.kind === kind && !isExtraCard(n);
  if (by < 0) {
    const out = [...d.main].filter((n) => isKind(n) && !isNeeded(n, d)).sort((a, b) => wn(a, d) - wn(b, d)).slice(0, -by);
    if (!out.length) return { calls: [], answer: () => `There are no ${kind}s to cut.` };
    const rest = { ...d, main: [...d.main] };
    for (const n of out) rest.main.splice(rest.main.indexOf(n), 1);
    const fill: string[] = [];
    for (let i = 0; i < out.length; i++) {
      const c = candidates(w, { ...rest, main: [...rest.main, ...fill] }, (x) => x.kind !== kind && !isExtraCard(x.name) && fill.filter((n) => n === x.name).length < 2)[0];
      if (c) fill.push(c.name);
    }
    return {
      calls: [{ name: 'edit_deck', input: { remove: counts(out), add: counts(fill) } }],
      answer: () => `Cut ${out.length} ${kind}${out.length > 1 ? 's' : ''} (${listOf(out)})${fill.length ? ` and put in ${listOf(fill)}` : ''}.`,
    };
  }
  const work = { ...d, main: [...d.main] };
  const outs: string[] = [];
  if (work.main.length + by > MAIN_MAX || work.main.length >= MAIN_MIN) {
    // keep the size: make room from the weakest cards of the other kinds
    const others = [...work.main].filter((n) => !isKind(n) && !isNeeded(n, work)).sort((a, b) => wn(a, d) - wn(b, d));
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

/** "swap the traps for spells": every card of one kind (or `n` of them) out, the best of the other kind in. */
function swapKinds(w: ChatWorld, from: Kind, to: Kind, n: number | null): Plan {
  const d = w.deck;
  const out = [...d.main].filter((x) => cd(x)?.kind === from && !isExtraCard(x)).sort((a, b) => wn(a, d) - wn(b, d)).slice(0, n ?? 99);
  if (!out.length) return { calls: [], answer: () => `There are no ${from}s in the deck to swap.` };
  const rest = { ...d, main: [...d.main] };
  for (const x of out) rest.main.splice(rest.main.indexOf(x), 1);
  const ins: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const c = candidates(w, { ...rest, main: [...rest.main, ...ins] }, (x) => x.kind === to && !isExtraCard(x.name) && ins.filter((m) => m === x.name).length < 2)[0];
    if (!c) break;
    ins.push(c.name);
  }
  return {
    calls: [{ name: 'edit_deck', input: { remove: counts(out), add: counts(ins) } }],
    answer: () => `Swapped ${out.length} ${from}${out.length > 1 ? 's' : ''} (${listOf(out)}) for ${ins.length ? listOf(ins) : `nothing: you have no more ${to}s that fit`}.${ins.length < out.length && ins.length ? ` You only had ${ins.length} ${to}s that fit, so the deck is smaller now; say "fill it up".` : ''}`,
  };
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
      `${owned.length ? `${w.collection ? 'From your cards, the' : 'The'} best fits for this deck are ${listOf(owned.map((c) => c.name))}. Say "add" and a name to put one in.` : 'Your best cards are already in this deck.'}${chase.length ? ` Worth chasing in packs or the Card Shop: ${listOf(chase.map((c) => c.name))}.` : ''}`,
  };
}

function themesPlan(w: ChatWorld): Plan {
  const t = speedThemes(w.collection, 20);
  const list = [...t.races.map(plural), ...t.attributes];
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

function cardPlan(name: string, w: ChatWorld, judge = false): Plan {
  const c = cd(name)!;
  const v = worth(c, w.deck);
  const verdict = !judge || c.sub === 'Skill' ? '' : `\n\nIn Speed Duel it's ${v >= 2200 ? 'a strong pick' : v >= 1500 ? 'a solid pick' : v >= 900 ? 'an okay pick' : 'a weak pick'}${c.kind === 'monster' && (c.level ?? 4) >= 5 ? `, but it costs ${(c.level ?? 4) >= 7 ? '2 Tributes' : 'a Tribute'}` : ''}.`;
  const owned = w.collection ? (w.collection[name] ?? 0) : 3;
  const here = c.sub === 'Skill' ? (w.deck.skill === name ? 1 : 0) : w.deck.main.filter((n) => n === name).length + w.deck.extra.filter((n) => n === name).length;
  const lim = limitStatus(name);
  const why = c.sub === 'Skill' ? (getSkill(name) ? null : "isn't playable in the game yet") : unplayableReason(name);
  return {
    calls: [{ name: 'get_cards', input: { names: [name] } }],
    answer: () =>
      `${bare(c.name)}: ${stats(c)}. ${c.desc.replace(/\s*\n\s*/g, ' ')}\n\n${w.collection ? `You own ${owned}${owned ? '' : ' (get it from packs or the Card Shop)'}` : 'Any copies allowed in this deck'}, ${here} in this deck.${lim ? ` ${lim} on the ${LIMITED_LIST_NAME}.` : ''}${why ? ` It ${why.startsWith('its') ? `can't be used yet: ${why}` : why}.` : ''}${verdict}`,
  };
}

function comparePlan(a: string, b: string): Plan {
  const x = cd(a)!;
  const y = cd(b)!;
  const line = (c: CardInfo) => `${bare(c.name)}: ${stats(c)}. ${short(c.desc, 180)}`;
  let verdict = '';
  if (x.kind === 'monster' && y.kind === 'monster') {
    const [hi, lo] = (x.atk ?? 0) >= (y.atk ?? 0) ? [x, y] : [y, x];
    verdict = (hi.atk ?? 0) === (lo.atk ?? 0) ? 'They hit equally hard.' : `${hi.name} hits harder (${hi.atk} vs ${lo.atk} ATK)${(hi.level ?? 0) > (lo.level ?? 0) && (hi.level ?? 0) >= 5 ? `, but needs ${(hi.level ?? 0) >= 7 ? '2 Tributes' : 'a Tribute'}` : ''}.`;
  }
  return { calls: [{ name: 'get_cards', input: { names: [a, b] } }], answer: () => `${line(x)}\n\n${line(y)}${verdict ? `\n\n${verdict}` : ''}` };
}

function skillsListPlan(w: ChatWorld): Plan {
  const mine = skillCards().filter((s) => getSkill(s.name) && (!w.collection || (w.collection[s.name] ?? 0) > 0));
  return {
    calls: [{ name: 'list_skills', input: {} }],
    answer: () =>
      mine.length
        ? `You have ${mine.length} Skill${mine.length > 1 ? 's' : ''}: ${mine
            .slice(0, 12)
            .map((s) => bare(s.name))
            .join(', ')}${mine.length > 12 ? ` and ${mine.length - 12} more` : ''}.${w.deck.skill ? ` This deck uses ${bare(w.deck.skill)}.` : ''} Say "use" and a Skill's name to switch.`
        : "You don't own a Skill yet. Skills come from packs and the Card Shop.",
  };
}

const RULES: [RegExp, string][] = [
  [/\b(attack|battle)\b.*\b(first turn|turn 1|turn one)\b|\bfirst turn\b.*\b(attack|battle)\b/, 'The player going first can\'t attack on their first turn, and skips their first draw. From the second turn on, both players can attack.'],
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
  [/\bskills?\b.*\b(work|rules)\b|\bhow (do|does) skills?\b/, 'You bring one Skill to each duel. It starts face-down and you flip it when you use it; most Skills work once per duel or need a condition first.'],
  [/\b(tribute|level 5|level 7|summon)\b/, 'Level 5 and 6 monsters need 1 Tribute, Level 7 and up need 2. Only 3 Monster Zones means big monsters cost a lot, so 2 to 4 is plenty.'],
];

const HELP = 'I can build and change this deck from your cards. Try: "build me a Dragon deck", "make an aggressive DARK deck", "build around Harpie Lady", "make it stronger", "add 2 Kuriboh and a Sangan", "swap the traps for spells", "make it 25 cards", "pick a different Skill", "explain my deck", "is this deck good?", "what should I add?" or "what does Dark Magician do?"';

const EXPLICIT_BUILD = /\b(build|create|construct|new deck|another deck|different deck|fresh deck|start a deck)\b|\b(make|give|get)( me)?( a| an| another| some)? (\w+ ){0,4}deck\b/;
const THIS_DECK = /\b(make|turn) (it|this|this deck|my deck|the deck)\b/;

/** Works out what one message asks for. Exported for tests. */
export function planFor(text: string, w: ChatWorld, mem: Memory = freshMemory(), part = false): Plan {
  const raw = text.trim();
  const t = clean(raw);
  if (w.deck.main.some((n) => !cd(n)) || w.deck.extra.some((n) => !cd(n))) w = { ...w, deck: { ...w.deck, main: w.deck.main.filter((n) => cd(n)), extra: w.deck.extra.filter((n) => cd(n)) } };
  const d = w.deck;
  if (/^\W*(thanks|thank you|thx|ty|cheers|nice|great|awesome|perfect|cool|ok|okay|good|love it|sweet)\b[\s\w]{0,12}\W*$/i.test(raw) && !/\b(add|remove|build|make|deck)\b/i.test(raw)) return { calls: [], answer: () => pick(["You're welcome! Ask me for any change.", 'Glad it helps. Want any more changes?', 'Any time. Say "is this deck good?" for a check-up.']) };
  if (!t) return { calls: [], answer: () => (/\b(hi|hey|hello|yo|sup)\b/i.test(raw) ? `Hi! ${HELP}` : HELP) };
  if (/^(help|what can you do|what do you do|commands|how does this work|how do you work|there|everyone|again)$/.test(t)) return { calls: [], answer: () => (/^\W*(hi|hey|hello|yo|sup)\b/i.test(raw) ? `Hi! ${HELP}` : HELP) };
  // several edits in one message ("put in 3 dark magician girl and remove the elegant egotist"): each part in turn
  if (!part) {
    const parts = t.split(/\s*(?:,|\band then\b|\bthen\b|\band\b|\balso\b|\bplus\b)\s*(?=(?:add|put|remove|take|cut|drop|swap|replace|get rid|include|throw|lose|delete|call it|name it|rename|use|give it)\b)/).filter((x) => x.trim());
    if (parts.length > 1 && !EXPLICIT_BUILD.test(parts[0])) return multiPlan(parts, w, mem);
  }

  // rename
  const rn = raw.match(/\b(?:rename(?: it| the deck| my deck)?|call it|name it|name the deck|call the deck|change (?:the|its|my deck's|the deck's) name(?: to)?|set the name(?: to)?)\s+(?:to\s+)?["“']?(.+?)["”']?\s*[.!]?$/i);
  const wantsNew = (EXPLICIT_BUILD.test(t) || (/^(an? )?(\w+ ){1,4}deck$/.test(t) && !/\b(my|this|the|your|it|explain|describe|rate|check|fix|show|improve|review|clear|empty|wipe|reset|good|bad|rename|whats|what)\b/.test(t))) && !/^(my|this|the) /.test(t) && !THIS_DECK.test(t) && !/^(what|which|how|why|can|could|should|is|are|do|does)\b/.test(t);
  if (rn && !wantsNew) return { calls: [{ name: 'edit_deck', input: { name: clip(rn[1]) } }], answer: () => `Renamed the deck "${clip(rn[1])}".` };

  if (/^(undo|undo (it|that|this)|go back|take (it|that) back|revert( it| that)?)$/.test(t)) return { calls: [], answer: () => 'Tap Undo on the change card above to take it back.' };

  // a new deck comes first: "build a deck with no traps" or "with a good skill" are options of the build
  if (wantsNew && !/\b(what|which) (can|could|should) i (build|make)\b/.test(t)) return buildPlan(t, w);

  // Skills ("use symbol of pride" switches even without the word Skill)
  const skillNamed = /\b(use|equip|switch to|change to|put on|run)\b/.test(t) ? nameIndex().find((x) => x.skill && ` ${t} `.includes(` ${x.flat} `)) : undefined;
  if (skillNamed) return { calls: [{ name: 'edit_deck', input: { skill: skillNamed.name } }], answer: (rs) => (refusedOf(rs[0] ?? '') ? `Couldn't: ${refusedOf(rs[0])}.` : `Now using ${bare(skillNamed.name)}. ${short(cd(skillNamed.name)!.desc)}`) };
  if (/\bskills?\b/.test(t)) {
    const sk = findCard(t, 'skills', d);
    if (/\b(what|which|list|show|all)\b.*\bskills\b.*\b(have|own|got|are there|can i use)\b|\bmy skills\b|\bskills (do i|i) (have|own)\b/.test(t)) return skillsListPlan(w);
    if (/\b(what|explain|how|tell)\b/.test(t) && !sk && !/\b(pick|choose|give|use|set|add|different|another|other|new|change|switch|better)\b/.test(t)) {
      if (!d.skill) return { calls: [], answer: () => 'This deck has no Skill yet. Say "pick a Skill" and I\'ll choose one that fits.' };
      return cardPlan(d.skill, w);
    }
    if (sk && /\b(what|explain|tell|does|read|about)\b/.test(t) && !/\b(use|equip|switch|change|set|put|give|add)\b/.test(t)) return cardPlan(sk, w);
    if (/\b(remove|no|take off|off|drop|without|get rid|delete|clear)\b/.test(t) && !sk) return { calls: [{ name: 'edit_deck', input: { skill: null } }], answer: () => 'Took the Skill off.' };
    if (sk) return { calls: [{ name: 'edit_deck', input: { skill: sk } }], answer: (rs) => (refusedOf(rs[0] ?? '') ? `Couldn't: ${refusedOf(rs[0])}.` : `Now using ${bare(sk)}. ${short(cd(sk)!.desc)}`) };
    const other = /\b(different|another|other|new|change|switch|better)\b/.test(t) && d.skill ? d.skill : null;
    const best = skillPick(w, other);
    if (!best) return { calls: [], answer: () => (other ? `${bare(other)} is the only Skill you have that fits this deck.` : w.collection ? "You don't own a Skill that fits yet. Skills come from packs and the Card Shop." : "I couldn't find a Skill that fits.") };
    return { calls: [{ name: 'edit_deck', input: { skill: best } }], answer: () => `${other ? `Switched from ${bare(other)} to` : 'Picked'} ${bare(best)} for this deck: ${short(cd(best)!.desc)}` };
  }

  const cardsSaid = findCards(t, d, 'cards');

  // rules
  if (/\b(rule|rules|how many|how much|how do|how does|how can|what happens|can i|do i|is there|are there|when|what is|whats|explain)\b/.test(t) || /\?$/.test(raw)) {
    const hit = RULES.find(([re]) => re.test(t));
    if (hit && !cardsSaid.length && !/\b(my|this|the) deck\b/.test(t)) return { calls: [], answer: () => hit[1] };
  }

  // two cards side by side
  if (cardsSaid.length >= 2 && /\b(difference|differences|compare|comparison|vs|versus|better|or)\b/.test(t) && !/\b(add|put|remove|take out|cut|swap)\b/.test(t)) return comparePlan(cardsSaid[0].name, cardsSaid[1].name);

  // "how many harpie cards are in it", "how many traps do i have"
  const hm = t.match(new RegExp(`\\bhow many (?:of )?(?:the |my )?(.+?)\\s*(?:cards?)?\\s*(?:are|do i|is there|have i|in)\\b`));
  if (hm && !RULES.slice(0, 2).some(([re]) => re.test(t))) {
    const what = hm[1].trim();
    const kind = kindWord(what);
    const fam = flat(what).replace(/\b(cards?|monsters?)$/, '').trim();
    const inDeckList = [...d.main, ...d.extra].filter((n) => (kind ? cd(n)?.kind === kind : fam.length >= 3 && (` ${flat(n)} `.includes(` ${fam} `) || flat(cd(n)?.race ?? '').startsWith(fam.replace(/s$/, '')) || flat(cd(n)?.attribute ?? '') === fam)));
    if (kind || inDeckList.length || fam.length >= 3)
      return { calls: [{ name: 'view_deck', input: {} }], answer: () => `There ${inDeckList.length === 1 ? 'is' : 'are'} ${inDeckList.length} ${what.replace(/s$/, '')}${inDeckList.length === 1 ? '' : 's'} in this deck${inDeckList.length ? `: ${listOf(inDeckList)}` : ''}.` };
  }

  // "what are my traps", "show me the monsters"
  const listKind = t.match(new RegExp(`^(?:what|which|whats|show me|list|tell me)(?: are| is)?(?: all)?(?: of)? (?:my|the) ${KIND_RE}\\b`));
  if (listKind) {
    const kind = kindWord(listKind[1])!;
    const these = d.main.filter((n) => cd(n)?.kind === kind && !isExtraCard(n));
    return { calls: [{ name: 'view_deck', input: {} }], answer: () => (these.length ? `Your ${kind}s here: ${listOf(these)}.` : `There are no ${kind}s in this deck.`) };
  }

  // "how do i beat a harpie deck" / "how do i beat exodia": removal and protection they own
  if (/\b(beat|counter|stop|deal with|win against|handle)\b/.test(t) && /\b(how|what|help|can)\b/.test(t)) {
    const answers = candidates(w, { ...d, main: [] }, (c) => c.kind !== 'monster' && /destroy|negate|banish/i.test(c.desc)).slice(0, 4);
    return {
      calls: [],
      answer: () =>
        `Speed Duels are short, so keep pressure on: attack every turn with strong Level 4 monsters and hold removal for their best card. ${answers.length ? `Good answers you own: ${listOf(answers.map((c) => c.name))}.` : ''} Set traps before you attack, since there is no Main Phase 2. Say "add" and a card's name to put one in.`.trim(),
    };
  }

  // how the deck plays
  if (/\b(what does|whats|show me what) (my|this|the) deck look like\b|\bshow (me )?(my|the) deck\b/.test(t)) return explainPlan(w);
  if (/\b(explain|describe|summari[sz]e|break down|walk me through)\b.*\b(deck|it|this)\b|\b(whats|what is) in (my|this|the) deck\b|\bhow (does|do) (my|this|the) deck (work|play)\b|\b(tell me about|what about) (my|this|the) deck\b/.test(t)) return explainPlan(w);

  // rate the deck
  if (/\b(good|rate|rating|review|grade|score|analy[sz]e|check|whats wrong|thoughts|opinion|how is|hows|any good|ready)\b/.test(t) && /\b(deck|it|this)\b/.test(t) && !/\b(make|swap|add|put|remove|take|cut|drop|get rid|weak|weakest|replace|change)\b/.test(t)) return ratePlan(w);

  // why that card
  if (/\bwhy\b/.test(t)) {
    const asked = cardsSaid.map((c) => c.name).filter((n) => inDeck(d, n));
    const tookOut = /\b(take|took|remove|removed|cut|drop|dropped)\b/.test(t);
    if (tookOut && !asked.length && mem.removed.length) return { calls: [], answer: () => [...new Set(mem.removed)].slice(0, 4).map((n) => (cd(n) ? `${n} was one of the weakest here (${cd(n)!.kind === 'monster' ? `${cd(n)!.atk ?? 0} ATK` : 'little effect for this deck'}).` : n)).join(' ') + ' Say "undo" to bring it back.' };
    const list = asked.length ? asked : [...new Set(mem.added)].filter((n) => inDeck(d, n));
    if (list.length) return { calls: [], answer: () => list.slice(0, 4).map((n) => `${n}: ${reason(cd(n)!, d)}.`).join(' ') };
    if (/\b(that|this|those|it|them|did you|add|put)\b/.test(t)) return { calls: [], answer: () => "I didn't put a card in just now. Ask about a card by name, like \"why Kuriboh?\", or say \"explain my deck\"." };
  }

  // which card is best / weakest in the deck
  const which = t.match(/\b(best|strongest|weakest|worst)\b(?: \w+){0,2} (card|monster|spell|trap)s?\b/);
  if (which && /\b(what|which|whats|who|tell|show)\b/.test(t) && d.main.length) {
    const kind = kindWord(which[2]);
    const pool = [...new Set([...d.main, ...d.extra])].map((n) => cd(n)!).filter((c) => c && (!kind || c.kind === kind));
    const up = /best|strongest/.test(which[1]);
    const top = pool.sort((a, b) => worth(b, d) - worth(a, d))[up ? 0 : pool.length - 1];
    if (top) return { calls: [{ name: 'view_deck', input: {} }], answer: () => `${up ? 'Your strongest' : 'Your weakest'} ${kind ?? 'card'} here is ${top.name}: ${stats(top)}. ${short(top.desc)}${up ? '' : ' Say "take out the weakest card" to cut it.'}` };
  }

  // what to add or chase
  if (/\b(what|which)\b.*\b(should|could|can|to|do)\b.*\b(add|get|buy|put in|chase|open|use|need)\b|\b(suggest|recommend|suggestions?|recommendations?)\b/.test(t) && !cardsSaid.length) return suggestPlan(w);

  // what can I build
  if (/\b(what|which)\b.*\b(can|could|should) i (build|make)\b|\b(what|which)\b.*\b(themes?|decks?)\b.*\b(can|could|should)\b|\b(deck )?ideas?\b|\bthemes?\b/.test(t) && !EXPLICIT_BUILD.test(t.replace(/\bwhat.*\b(build|make)\b/, ''))) return themesPlan(w);

  // anything deck-shaped while the deck is empty builds one (not a question about it)
  if (/\b(legal|ready|valid|allowed|playable)\b/.test(t) && /\b(deck|it)\b/.test(t)) return ratePlan(w);
  if (!/^(is|are|what|whats|how|why|can|does|do)\b/.test(t) && (!d.main.length && !d.extra.length && /\b(deck|random|surprise|aggressive|aggro|control|defensive)\b/.test(t) && !cardsSaid.some((c) => /\b(add|put)\b/.test(t) && c))) return buildPlan(t, w);

  // restyle the deck that's there into a theme ("make it a zombie deck", "turn this into dragons"): a rebuild, with Undo
  if (d.main.length && /\b(make|turn|change|convert)\b.*\b(it|this|my deck|the deck)\b.*\b(into|a|an|to)\b/.test(t)) {
    const wish = readWish(t, w);
    if (wish.theme.kind === 'race' || wish.theme.kind === 'attribute' || wish.around) return buildPlan(t, w);
  }
  // "more dragons": swap weak off-theme monsters for the best of that Type or Attribute
  const moreOf = t.match(/\b(more|extra|add some|add more)\s+(\w+)/);
  if (moreOf && d.main.length) {
    const race = RACES.find((x) => new RegExp(`^${flat(x)}(s|es)?$`).test(moreOf[2].replace(/ies$/, 'y')));
    const attr = ATTRS.find((a) => a.toLowerCase() === moreOf[2]);
    if (race || attr) {
      const fits = (c: CardInfo) => c.kind === 'monster' && (race ? c.race === race : c.attribute === attr);
      const outs = [...d.main].filter((n) => cd(n)?.kind === 'monster' && !fits(cd(n)!) && !isNeeded(n, d)).sort((a, b) => wn(a, d) - wn(b, d)).slice(0, 3);
      const rest = { ...d, main: [...d.main] };
      for (const n of outs) rest.main.splice(rest.main.indexOf(n), 1);
      const ins: string[] = [];
      for (let i = 0; i < 3; i++) {
        const c = candidates(w, { ...rest, main: [...rest.main, ...ins] }, (x) => fits(x) && !isExtraCard(x.name) && (x.level ?? 4) <= 6 && ins.filter((n) => n === x.name).length < 2)[0];
        if (c) ins.push(c.name);
      }
      const label = race ? plural(race) : attr!;
      if (!ins.length) return { calls: [], answer: () => `You have no more ${label} that can go in${w.collection ? '; get more from packs or the Card Shop' : ''}.` };
      const o = outs.slice(0, ins.length);
      return { calls: [{ name: 'edit_deck', input: { remove: counts(o), add: counts(ins) } }], answer: () => `Added ${listOf(ins)}${o.length ? ` in place of ${listOf(o)}` : ''}, for more ${label}.` };
    }
  }

  // "make it smaller / bigger"
  if (d.main.length && /\b(smaller|shorter|thinner|less cards|fewer cards)\b/.test(t)) return d.main.length <= MAIN_MIN ? { calls: [], answer: () => `It's already the smallest a deck can be (${MAIN_MIN}).` } : trimPlan(d, Math.max(MAIN_MIN, d.main.length - 5));
  if (d.main.length && /\b(bigger|larger|more cards|longer)\b/.test(t)) return d.main.length >= MAIN_MAX ? { calls: [], answer: () => `It's already the biggest a deck can be (${MAIN_MAX}).` } : fillPlan(w, Math.min(MAIN_MAX, d.main.length + 5), mem, `Made it ${Math.min(MAIN_MAX, d.main.length + 5)} cards`);

  // resize: "make it 30 cards"
  const size = t.match(/\b(\d{1,3})\b(?= cards?\b)|\b(2\d|30)\b/);
  if (size && d.main.length && (/\b(make|set|change|go|bring|turn|up|down|resize|cards?)\b/.test(t) || THIS_DECK.test(t)) && !cardsSaid.length) {
    const n = Number(size[1] ?? size[2]);
    if (n < MAIN_MIN || n > MAIN_MAX) return { calls: [], answer: () => `A Main Deck holds ${MAIN_MIN} to ${MAIN_MAX} cards.` };
    if (n === d.main.length) return { calls: [], answer: () => `It already has ${n} cards.` };
    return n > d.main.length ? fillPlan(w, n, mem, `Made it ${n} cards`) : trimPlan(d, n);
  }

  // "remove everything except the monsters": the other kinds go
  const except = t.match(new RegExp(`\\b(remove|delete|take out|get rid of|cut|clear)\\b.*\\b(except|but|other than|apart from|besides|aside from)\\b(?: the| my)? ${KIND_RE}`));
  if (except) {
    const keep = kindWord(except[3])!;
    const out = counts(d.main.filter((n) => cd(n)?.kind !== keep));
    if (!out.length) return { calls: [], answer: () => `There's nothing but ${keep}s in the deck already.` };
    return { calls: [{ name: 'edit_deck', input: { remove: out } }], answer: () => `Took out everything but the ${keep}s (${out.reduce((a, x) => a + x.count, 0)} cards). Say "fill it up" to bring it back to ${MAIN_MIN}.` };
  }

  // clear
  if (!/\b(except|but|other than|apart from)\b/.test(t) && /^(clear|empty|wipe|reset|start over)\b|\b(clear|empty|wipe|reset) (it|the deck|my deck|this deck|everything)\b|\b(remove|delete|take out) everything\b|\btake everything out\b|\bstart (it )?over\b/.test(t) && !/\b(is|its) empty\b/.test(t)) return { calls: [{ name: 'edit_deck', input: { clear: true } }], answer: () => 'Emptied the deck. Say "build me a deck" to fill it again.' };

  // swap one card for another: "replace toon world with 2 sakuretsu armor"
  const swapCards = t.match(/\b(swap|replace|trade|switch|change|exchange|sub)\b(?: out)?\s+(.+?)\s+\b(?:for|with|to|into|by)\b\s+(.+)$/);
  if (swapCards) {
    const from = findCards(swapCards[2], d);
    const to = findCards(swapCards[3], d);
    if (from.length && to.length) {
      const missing = from.filter((f) => !inDeck(d, f.name));
      if (missing.length) return { calls: [], answer: () => `${listOf(missing.map((f) => f.name))} ${missing.length > 1 ? "aren't" : "isn't"} in this deck, so there's nothing to swap out.` };
      const rm = from.map((f) => ({ name: f.name, count: f.count ?? (d.main.filter((n) => n === f.name).length + d.extra.filter((n) => n === f.name).length) }));
      const add = to.map((f, i) => ({ name: f.name, count: f.count ?? (to.length === 1 ? Math.min(COPIES, rm.reduce((a, x) => a + x.count, 0)) : rm[i]?.count ?? 1) }));
      return {
        calls: [{ name: 'edit_deck', input: { remove: rm, add } }],
        answer: (rs) => {
          const refused = refusedOf(rs[0] ?? '');
          const done = rs[0]?.match(/^Done: (.*)\.$/m)?.[1];
          return `${done && done !== 'Nothing changed' ? `Swapped: ${done}.` : 'Nothing changed.'}${refused ? ` ${refused}.` : ''}`;
        },
      };
    }
    if (from.length && !to.length && findOutside(swapCards[3])) return { calls: [], answer: () => outsideLine(findOutside(swapCards[3])!) };
  }

  // swap one kind for another
  const sw = t.match(new RegExp(`\\b${KIND_RE}\\b.*\\b(for|with|into|to|by)\\b(?: \\w+){0,2} ${KIND_RE}\\b`));
  if (sw && /\b(swap|replace|trade|change|switch|exchange|turn|instead)\b/.test(t) && kindWord(sw[1]) !== kindWord(sw[3])) {
    const n = t.match(/\b([1-9])\b/)?.[1];
    return swapKinds(w, kindWord(sw[1])!, kindWord(sw[3])!, n ? Number(n) : null);
  }

  // more / fewer of a kind
  const more = t.match(new RegExp(`\\b(more|extra|add some|add a few|add more)\\s+${KIND_RE}\\b`));
  const fewer = t.match(new RegExp(`\\b(less|fewer|cut some|remove some|cut a few|remove a few|not so many|too many|no more|stop adding|enough)\\s+${KIND_RE}\\b`));
  if (fewer) return kindShift(w, kindWord(fewer[2])!, -3);
  if (more) return kindShift(w, kindWord(more[2])!, 3);

  // remove all of a kind
  const rk = t.match(new RegExp(`\\b(remove|take out|take|get rid of|no|drop|delete|cut|without|dont want|dont like|hate)\\s+(?:all\\s+)?(?:of\\s+)?(?:the\\s+|my\\s+|any\\s+)?${KIND_RE}\\b`));
  if (rk && !cardsSaid.length) {
    const kind = kindWord(rk[2])!;
    const out = counts(d.main.filter((n) => cd(n)?.kind === kind && !isExtraCard(n)));
    if (!out.length) return { calls: [], answer: () => `There are no ${kind}s in the deck.` };
    const k = out.reduce((a, x) => a + x.count, 0);
    const cut: Plan = { calls: [{ name: 'edit_deck', input: { remove: out } }], answer: () => `Took out all ${k} ${kind}s.` };
    return d.main.length - k < MAIN_MIN ? refill(cut, w, kind) : cut;
  }

  // fill up to the minimum
  if (/\b(fill|finish|complete|top up|top it up|make it legal|make it playable)\b/.test(t)) {
    if (d.main.length >= MAIN_MIN) return { calls: [], answer: () => `The deck already has ${d.main.length} cards, enough to duel.` };
    return fillPlan(w, MAIN_MIN, mem);
  }

  // take out the weakest cards
  const weakest = t.match(/\b(remove|take out|cut|drop|get rid of|lose|delete)\b.*\b(weakest|worst|bad|weak|useless|bricks?)\b/);
  if (weakest && d.main.length) {
    const said = t.match(/\b([1-9])\b/)?.[1];
    const n = said ? Number(said) : /\b(cards|monsters|ones)\b/.test(t) ? 3 : 1;
    const kind = kindWord(t.match(new RegExp(`\\b${KIND_RE}\\b`))?.[1] ?? '');
    const out = [...d.main].filter((x) => !kind || cd(x)?.kind === kind).filter((x) => !isNeeded(x, d)).sort((a, b) => wn(a, d) - wn(b, d)).slice(0, n);
    const cut: Plan = { calls: [{ name: 'edit_deck', input: { remove: counts(out) } }], answer: () => `Took out ${listOf(out)}, the weakest ${out.length > 1 ? 'cards' : 'card'} here.` };
    return d.main.length - out.length < MAIN_MIN ? refill(cut, w, null) : cut;
  }

  // a style change for the deck that's there ("make it more aggressive")
  if (d.main.length) {
    if (/\b(aggro|aggressive|offensive|beat ?down|faster|attack more|hit harder|more attackers|more damage)\b/.test(t)) {
      const lows = d.main.map((n) => cd(n)).filter((c) => c?.kind === 'monster' && (c.level ?? 0) <= 4).map((c) => c!.atk ?? 0);
      const floor = Math.min(1600, (lows.length ? Math.max(...lows) : 0) - 100);
      const plan = kindShift(w, 'monster', 3, 'more attackers', (c) => (c.level ?? 0) <= 4 && (c.atk ?? 0) >= floor && c.sub !== 'Ritual');
      return plan.calls.length ? plan : { calls: [], answer: () => `This deck already runs your best attackers that need no Tribute.${w.collection ? ' Open packs or craft in the Card Shop for stronger ones, then ask again.' : ''} Say "make it stronger" to swap weak cards.` };
    }
    if (/\b(defensive|control|safer|slower|protect|more defen[cs]e)\b/.test(t)) return kindShift(w, 'trap', 3, 'more traps to protect your field');
  }

  // add / remove cards (several at once; "that" / "it" means the cards just added)
  const verb = t.match(/\b(add|put in|put|include|throw in|stick in|chuck in|give it|i want|remove|take out|take|get rid of|drop|cut|delete|lose|minus|no more|without)\b/);
  if (verb) {
    const removing = /^(remove|take out|take|get rid of|drop|cut|delete|lose|minus|no more|without)$/.test(verb[1]);
    let found = cardsSaid;
    const back = !removing && /\b(back|again)\b/.test(t);
    const recent = removing ? mem.added : back ? mem.removed : mem.added;
    if (!found.length && /\b(that|it|those|them|these|this one|that one|the last one|what you added|they)\b/.test(t) && recent.length) {
      // "take that out" -> the cards just added; "put them back" -> the cards just cut; "add another of those" -> one more
      const said = t.match(/\b([1-3]|one|two|three|a|an)\b(?= of)/)?.[1];
      const k = said ? (/^\d$/.test(said) ? Number(said) : NUM[said]) : null;
      found = counts(recent).map((x) => ({ name: x.name, count: k ?? (removing || back ? x.count : 1) }));
    }
    if (found.length) {
      const list = found.map((f) => ({ name: f.name, count: f.count ?? (removing && /\ball\b/.test(t) ? COPIES : 1) })).filter((f) => f.count > 0);
      if (!list.length) return { calls: [], answer: () => 'Zero copies changes nothing. Say how many, like "add 2 Kuriboh".' };
      const out = findOutside(t);
      const outside = out && !list.some((f) => flat(f.name).includes(flat(out))) ? out : null;
      return {
        calls: [{ name: 'edit_deck', input: removing ? { remove: list } : { add: list } }],
        answer: (rs) => {
          const refused = refusedOf(rs[0] ?? '');
          const done = rs[0]?.match(/^Done: (.*)\.$/m)?.[1];
          const ok = done && done !== 'Nothing changed' ? `${removing ? 'Took out' : 'Added'} ${done.replace(/^[-+]/, '').replace(/, [-+]/g, ', ')}.` : 'Nothing changed.';
          return `${ok}${refused ? ` ${refused}.` : ''}${outside ? ` ${outsideLine(outside)}` : ''}`;
        },
      };
    }
    const other = findOutside(t);
    if (other) return { calls: [], answer: () => outsideLine(other) };
    if (/\b(that|it|those|them|these|they)\b/.test(t) && !new RegExp(KIND_RE).test(t)) return { calls: [], answer: () => `Which card? Say its name, like "${removing ? 'take out' : 'add'} Kuriboh". To take back the whole last change, say "undo".` };
    const k = t.match(new RegExp(`\\b(a|an|one|another|[1-3]|two|three)?\\s*${KIND_RE}\\b`));
    if (k && kindWord(k[2])) {
      const n = k[1] ? (/^[1-3]$/.test(k[1]) ? Number(k[1]) : NUM[k[1]] ?? 1) : 1;
      return kindShift(w, kindWord(k[2])!, removing ? -n : n);
    }
    if (!/\b(deck|monsters?|spells?|traps?|stronger|better)\b/.test(t)) return { calls: [], answer: () => `I couldn't tell which card you meant. Say its name, like "${removing ? 'take out' : 'add'} 2 Kuriboh".${nearest(t)}` };
  }

  // make it stronger
  if (/\b(stronger|better|improve|upgrade|optimi[sz]e|power ?up|beef|buff|boost|fix it|fix my deck|fix the deck|swap|replace|tune|polish)\b/.test(t)) return strongerPlan(w);

  // questions about a card
  const name = cardsSaid[0]?.name ?? findCard(t, 'skills', d);
  if (name) return cardPlan(name, w, /\b(good|worth|strong|bad|any good|should i (use|run|play))\b/.test(t));
  const other = findOutside(t);
  if (other) return { calls: [], answer: () => `${outsideLine(other)} ${short(cd(other)?.desc ?? '')}`.trim() };

  // any deck-shaped wish left builds one
  if (/\b(deck|random|surprise)\b/.test(t) && !d.main.length) return buildPlan(t, w);
  return { calls: [], answer: () => `I'm not sure what you mean.${nearest(t)} ${HELP}` };
}

/** Plans each part against the deck as the parts before it leave it, then answers them in order. */
function multiPlan(parts: string[], w: ChatWorld, mem: Memory): Plan {
  let world = w;
  const plans: Plan[] = [];
  for (const p of parts) {
    const pl = planFor(p, world, mem, true);
    plans.push(pl);
    for (const c of pl.calls) {
      const r = runTool(world, c.name, c.input);
      if (r.deck) world = { ...world, deck: r.deck };
    }
    const edit = pl.calls.find((c) => c.name === 'edit_deck')?.input as { add?: { name: string }[] } | undefined;
    if (edit?.add?.length) mem.added = edit.add.map((x) => x.name);
  }
  return {
    calls: plans.flatMap((p) => p.calls),
    answer: (rs) => {
      let i = 0;
      return plans
        .map((p) => {
          const mine = rs.slice(i, i + p.calls.length);
          i += p.calls.length;
          return p.answer(mine);
        })
        .join(' ');
    },
  };
}

/** " Did you mean Gearfried the Iron Knight?" when some word is close to a card name. */
function nearest(t: string): string {
  const words = t.split(' ').filter((x) => x.length >= 4 && !STOP.has(x) && !INTENT.has(x));
  for (const x of words) {
    const n = partialName(x, 'cards');
    if (n) return ` Did you mean ${n}?`;
  }
  return '';
}

const stopped = () => Object.assign(new Error('Stopped.'), { name: 'AbortError' });

/** The built-in helper as a Model: the first step makes the tool calls, the next one answers. */
export function localModel(getWorld: () => ChatWorld, mem: Memory = freshMemory()): Model {
  let plan: Plan | null = null;
  let pending: Memory | null = null;
  return async (req, onText, signal) => {
    const last = req.messages[req.messages.length - 1];
    const blocks = Array.isArray(last.content) ? (last.content as { type: string; text?: string; content?: unknown }[]) : [];
    const isResults = blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
    if (!isResults || !plan) {
      const said = blocks.find((b) => b.type === 'text')?.text ?? '';
      const text = said.split('\n\n<current_deck>')[0];
      plan = planFor(text, getWorld(), mem);
      await new Promise((r) => setTimeout(r, 120));
      if (signal?.aborted) throw stopped();
      if (plan.calls.length) {
        // remember what this change touches, for "take that out" and "why that one?"
        const edit = plan.calls.find((c) => c.name === 'edit_deck')?.input as { add?: { name: string; count?: number }[]; remove?: { name: string; count?: number }[] } | undefined;
        pending = (edit?.add?.length || edit?.remove?.length) && !(edit as { clear?: boolean }).clear ? { added: (edit.add ?? []).flatMap((x) => Array(x.count ?? 1).fill(x.name)), removed: (edit.remove ?? []).flatMap((x) => Array(x.count ?? 1).fill(x.name)) } : null;
        return { stop_reason: 'tool_use', content: plan.calls.map((c, i) => ({ type: 'tool_use', id: `local${Date.now()}${i}`, name: c.name, input: c.input })) as unknown as Block[] } as ModelReply;
      }
    }
    const results = isResults ? blocks.map((b) => String(b.content ?? '')) : [];
    // remember what this change touched, for "take that out" and "why that one?", if it went through
    if (pending && results.some((x) => /^Done: (?!Nothing changed)/m.test(x))) {
      const line = results.find((x) => /^Done: /m.test(x))?.match(/^Done: (.*)$/m)?.[1] ?? '';
      const names = new Set(line.replace(/\.$/, '').split(', ').map((x) => x.replace(/^[-+]\d* ?/, '').trim()));
      mem.added = pending.added.filter((n) => names.has(n));
      mem.removed = pending.removed.filter((n) => names.has(n));
    }
    pending = null;
    const answer = plan.answer(results);
    plan = null;
    // the words appear a few at a time, like a reply being typed
    if (onText)
      for (const part of answer.match(/\S+\s*/g) ?? []) {
        if (signal?.aborted) throw stopped();
        onText(part);
        await new Promise((r) => setTimeout(r, 10));
      }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: answer, citations: null }] as unknown as Block[] };
  };
}
