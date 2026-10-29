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
  /** every card cut this chat: refills don't bring them back unless asked by name */
  cut?: string[];
  /** cards the player asked for by name: trims keep them */
  wanted?: string[];
  /** the card just talked about ("what's my best card?" then "take it out") */
  focus?: string | null;
  /** kinds the player ruled out this chat ("no traps"): refills leave them out */
  noKinds?: Kind[];
  /** what the helper just suggested, for "yes", "do it" or "add those" */
  offer?: { add?: string[]; skill?: string } | null;
}
const freshMemory = (): Memory => ({ added: [], removed: [] });

const ATTRS = ['DARK', 'LIGHT', 'EARTH', 'WATER', 'FIRE', 'WIND', 'DIVINE'];
const RACES = ['Beast-Warrior', 'Winged Beast', 'Sea Serpent', 'Warrior', 'Spellcaster', 'Dragon', 'Fiend', 'Machine', 'Zombie', 'Beast', 'Fairy', 'Insect', 'Dinosaur', 'Reptile', 'Fish', 'Aqua', 'Pyro', 'Thunder', 'Rock', 'Plant', 'Psychic', 'Cyberse', 'Wyrm', 'Divine-Beast'];
const NUM: Record<string, number> = { a: 1, an: 1, one: 1, single: 1, another: 1, two: 2, couple: 2, three: 3, all: 3, every: 3, max: 3, both: 2 };
const bare = (n: string) => n.replace(/ \(Skill Card\)$/, '');
/** lower case, no punctuation: "Blue-Eyes White Dragon" -> "blue eyes white dragon" */
const flat = (s: string) => norm(s).replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const plural = (r: string) => (/(Fish|Psychic|Cyberse|Aqua)$/.test(r) ? r : r.endsWith('y') ? r.slice(0, -1) + 'ies' : r + 's');
const kinds = (d: SpeedDeck, k: string) => d.main.filter((n) => cd(n)?.kind === k).length;
const kindWord = (w: string): Kind | null => (/^monsters?$/.test(w) ? 'monster' : /^spells?$/.test(w) ? 'spell' : /^traps?$/.test(w) ? 'trap' : null);
const pick = <T>(a: T[]) => a[Math.floor(rng() * a.length)];
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
  /** only part of the name was said */
  partial?: boolean;
  /** what was said, when it was only part of the name */
  said?: string;
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
  const hits: { at: number; name: string; len: number; partial?: boolean; said?: string }[] = [];
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
        if (n) (hits.push({ at: at + p.indexOf(words[i]), name: n, len: phrase.length, partial: true, said: words.join(' ') }), (got = true));
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
    // "black metal dragon x2", "kuriboh times 3"
    const after = t.slice(h.at + h.len, h.at + h.len + 10).match(/^ ?(?:x ?|times )([1-9])\b/);
    if (after) count = Number(after[1]);
    from = h.at + h.len;
    const same = out.find((o) => o.name === h.name);
    if (same) same.count = (same.count ?? 1) + (count ?? 1);
    else out.push({ name: h.name, count, ...(h.partial ? { partial: true, said: h.said } : {}) });
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
  // a fixed-up match still needs most of its words as said ("the best deck i can with my cards" isn't Reaper of the Cards)
  const asSaid = (x: { flat: string }) => {
    const ws = x.flat.split(' ').filter((y) => !STOP.has(y));
    return ws.filter((y) => said.includes(` ${y} `)).length * 2 >= ws.length && ws.length > 0;
  };
  return others?.find((x) => said.includes(` ${x.flat} `) || (t.includes(` ${x.flat} `) && asSaid(x)))?.name ?? null;
}
const outsideLine = (n: string) => `${n} isn't a Speed Duel card (Konami never printed it in a Speed Duel product), so it can't go in a Speed Duel deck.`;

// ---------- fixing misheard and misspelled words ----------
const STOP = new Set(
  'a an the me my i to for of with from and or please pls plz can could you u build make create give get want need new deck decks card cards some using use around based on out it its this that full whole good best strongest strong cool nice fun really very just only more type themed theme kind style monster monsters spell spells trap traps let lets do one up random is are was be have has had in at as by so if then than them those these thing things'.split(' '),
);
/** everyday words that are also whole card names */
const COMMON = new Set('magic fire flying giant horse dragon warrior spellcaster fiend machine zombie beast fairy insect dinosaur reptile fish aqua pyro thunder rock plant psychic wyrm serpent winged dark light earth water wind next storm rush change reload fusion reinforcements oscillo hero mirror wall shield sword swords trap hole hole snatch steal monster reborn tribute ultimate offering possessed negate wonder'.split(' '));

/** the words requests are made of: never "corrected" into card names */
const INTENT = new Set(
  'add put include throw stick chuck remove take get rid drop cut delete lose minus swap replace trade change switch fill finish complete top clear empty wipe start over reset rename call name skill skills rule rules rate rating review grade score check explain describe tell show what which whats how hows why when who where does did done stronger better improve upgrade aggressive aggro offensive defensive control faster slower attack attackers attacking beatdown traps spells monsters extra main another other different instead same like dont don want wanna gonna lot lots few less fewer most least weakest worst weak bad best strongest powerful meta win beat summon summoning tribute fusion ritual synchro xyz tuner level levels atk def life points hand draw turn first phase zones field copies limited forbidden banned list good great nice fine okay thanks thank cool help hi hello hey yo sup suggest recommend recommendation ideas idea themes theme build built undo back revert again also too one two three all every much many cards card deck decks dragons warriors spellcasters zombies fiends machines beasts fairies insects dinosaurs reptiles fish aqua pyro thunder rock plant plants psychic cyberse wyrm wyrms dark light earth water fire wind divine bigger smaller size number count know kinda sorta pretty maybe actually just still keep keeps keeping work works working power powerful stuff something anything everything cool start game games play playing played think thinking need needs brother sister friend friends computer opponent losing lost loses wins winning duel duels duelling dueling time times now today better worse right wrong way thing interesting next little sister mom dad family kid kids defense defence attack help magic flying giant horse dragon warrior spellcaster fiend machine zombie beast fairy insect dinosaur reptile plant serpent winged last latest wonder wondering hat colors color colours colour shuffle space ocean mysterious fit fits would maybe enough instead high low'.split(
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
/** a duelist's best-known deck ("pegasus toon deck" keeps the toon) */
const CHAR_DECK: Record<string, string> = { yugi: 'dark magician', kaiba: 'blue eyes', joey: 'red eyes', mai: 'harpie', pegasus: 'toon', weevil: 'insect', rex: 'dinosaur', bonz: 'zombie', keith: 'machine' };
export function clean(text: string): string {
  let t = flat(text.replace(/^\s*\+\s*(\d)/, 'add $1 ').replace(/^\s*-\s*(\d)/, 'remove $1 '))
    .replace(/\b(\w+) (s|t)\b/g, '$1$2') // what s -> whats, don t -> dont
    .replace(/\b(i|you|u|we|they|he|she|it|that|there|who|what) (ll|re|ve|d|m)\b/g, '$1$2') // i ll -> ill (not "lord of d")
    .replace(/\b(pls|plz|please|thx|thanks|thank you|lol)\b/g, ' ')
    // politeness inside a request ("and also could you take out one harpie queen if thats ok")
    .replace(/\b(?:if (?:thats|that is|its|it is) (?:ok|okay|alright|fine|cool)|if you can|if u can|for me)\b/g, ' ')
    .replace(/\b(and|also|then|,) (?:can|could|would|will) (?:you|u) (?:please )?/g, '$1 ')
    // shorthand: "+2 sangan", "kuriboh out", "sangan in", "mst"
    .replace(/^\+\s*(\d)\s+/, 'add $1 ')
    .replace(/^-\s*(\d)\s+/, 'remove $1 ')
    .replace(/\b(remov|remvoe|rmove|delet)\b/g, (m) => (m.startsWith('del') ? 'delete' : 'remove'))
    .replace(/\b(tak|tke|taek)\b/g, 'take')
    .replace(/\bgimme\b/g, 'give me')
    .replace(/\bgiv\b/g, 'give')
    .replace(/\bmor\b/g, 'more')
    .replace(/\b(dose|dos|duz)\b/g, 'does')
    .replace(/\b(summund|sumoned|summond|sumond|summonned)\b/g, 'summoned')
    .replace(/\b(skul|skulll)\b/g, 'skull')
    .replace(/\btrapz\b/g, 'traps')
    .replace(/\b(spels|spelz|spellz)\b/g, 'spells')
    .replace(/\b(spel)\b/g, 'spell')
    .replace(/\bgril\b/g, 'girl')
    .replace(/\blady sister\b/g, 'lady sisters')
    .replace(/\b(kurbo|kuribo|kuriboo|kurboh|kribo)\b/g, 'kuriboh')
    .replace(/\b(grede|gred|greeed)\b/g, 'greed')
    .replace(/\b(sawp|swpa|swop)\b/g, 'swap')
    .replace(/\b(less|fewer) tributes\b/g, '$1 tribute monsters')
    // "add 1 more dark magician girl" is one Dark Magician Girl, not "more DARK"
    .replace(/\b(add|put in|throw in)\s+([1-3]|one|two|three|a|an)\s+more\s+(?!(?:traps?|spells?|monsters?)\b)/g, '$1 $2 ')
    .replace(/\b(sumthin|sumthing|somethin|smth|sth)\b/g, 'something')
    .replace(/\b(beter|bettr|betta)\b/g, 'better')
    .replace(/\bdragn\b/g, 'dragon')
    .replace(/\beyz\b/g, 'eyes')
    .replace(/\b(stornger|stonger|strnger|stronge)\b/g, 'stronger')
    .replace(/\b(wekest|weakst)\b/g, 'weakest')
    .replace(/\b(beefier|more op|op)\b/g, 'stronger')
    .replace(/^(?:idk|i dunno|dunno)\s+/, '')
    .replace(/\bw\/? (?=\w)/g, 'with ')
    // "make me something strong": the best deck from their cards
    .replace(/^(?:yo |hey )?(?:make|build|gimme|give) me (?:something|a deck|anything) (?:strong|good|op|sick|cool|stronger|decent)$/, 'build me the best deck i can make')
    // "dragon deck with red eyes": a deck asked for with no verb
    .replace(/^([a-z]+(?: [a-z]+)?) deck( with .+)?$/, (m, a: string, b = '') => (/\b(my|this|the|that|your|our|it|its|whats|what|is|how|which|why|a|an|explain|list|delete|clear|show|rate|check|fix|good|bad|whole|entire|new|current|old|save|reset|wipe|empty|scrap|copy|name|rename|same|full|main|extra|side|of|in|to|for)\b/.test(a) ? m : `build a ${a} deck${b}`))
    // "make it all harpies": a deck of them
    .replace(/^make it all ([a-z ]+?)s?$/, 'make it a $1 deck')
    // "i need polymerization too": an add
    .replace(/^i (?:need|want) (?!help|advice|ideas|to\b|a deck|a new deck|more\b|less\b|fewer\b|it\b)(.+?)(?: too| as well| also)$/, 'add $1')
    .replace(/\b(agressive|aggresive|agresive)\b/g, 'aggressive')
    .replace(/\bbetter+r\b/g, 'better')
    .replace(/\b(repalce|replase|replce)\b/g, 'replace')
    .replace(/\b(meny|mny)\b/g, 'many')
    .replace(/\b(wats|wut|wat)\b/g, 'whats')
    .replace(/\bdark ?magishin\b/g, 'dark magician')
    .replace(/\bharpy\b/g, 'harpie')
    // "and also a sangan": another add
    .replace(/^(?:and also|and|also|plus|oh and)\s+(?=(?:a|an|one|another|[1-3]|two|three)\s)/, 'add ')
    // "dont change anything just tell me whats weak": the question is the ask
    .replace(/^(?:dont|do not) (?:change|touch|edit) (?:anything|it|the deck|my deck)\s+(?:just\s+|but\s+)?(?=(tell|show|what|whats|how|is|which|why)\b)/, '')
    .replace(/\bmst\b/g, 'mystical space typhoon')
    .replace(/\bbewd\b/g, 'blue eyes white dragon')
    .replace(/\brebd\b/g, 'red eyes black dragon')
    .replace(/\bdmg\b/g, 'dark magician girl')
    // "add 2 sangan no wait 1": the correction wins
    .replace(/\b(add|put in|remove|take out)\s+(?:[1-3]|one|two|three)\s+(.+?)\s+(?:no wait|no|wait|actually|i mean|make that|make it)\s+([1-3]|one|two|three)$/, '$1 $3 $2')
    .replace(/^(bro|dude|man)\b|\b(bro|dude|man)$/g, ' ')
    .replace(/\blotsa\b/g, 'lots of')
    .replace(/\bat (?=([1-3]|one|two|three|a|an|another|some)\b)/g, 'add ')
    .replace(/\b(ad|adde)\b/g, 'add')
    // "try adding kuriboh" is a request; "stop adding", "i was adding" and "i added" are not
    .replace(/(^|\b(?:try|start|go|be|you|u|by|keep|mind|about|like|try) )adding\b/g, '$1add')
    .replace(/\bevery (thing|card)\b/g, 'every$1')
    .replace(/\bany thing\b/g, 'anything')
    // "the last thing you added", "the last 2 cards you added", "that last change": what the last change did
    .replace(/\b(?:the |that )?(?:last|latest|newest)(?: ([1-9]|two|three))? (?:things?|cards?|ones?|changes?|edits?)(?: (?:you|u) (?:just )?(?:added|put in|made|did))?\b/g, (_m, n) => (n ? `${n} of those` : 'that'))
    .replace(/\b(?:what|the ones?|the cards?|the stuff) (?:you|u) (?:just )?(?:added|put in)\b/g, 'those')
    .replace(/\b(add|put in|put|throw in) (to|too|tu)\b(?! (the|my|it|this|deck))/g, '$1 2')
    .replace(/\btakeout\b/g, 'take out')
    // everyday misspellings and number words (card names are fixed later, against the card list)
    .replace(/\b(mak|mke|maek)\b/g, 'make')
    .replace(/\b(buld|biuld|bild|buid)\b/g, 'build')
    .replace(/\b(dek|dec|dekc|dekk|deks)\b/g, 'deck')
    .replace(/\b(skil|skll|skils|skilz)\b/g, 'skill')
    .replace(/\b(wat|wut|wht|whta)\b/g, 'what')
    .replace(/\bspel+ ?cast[eo]r(s?)\b/g, 'spellcaster$1')
    .replace(/\b(magishun|magishin|majician|magican|magicion|magishan|majishun)\b/g, 'magician')
    .replace(/\bladies\b/g, 'lady')
    .replace(/\b(monstrs|monstas|monstors|monsterz)\b/g, 'monsters')
    .replace(/\btwenty[ -]?(one|two|three|four|five|six|seven|eight|nine)\b/g, (_m, n: string) => String(20 + ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].indexOf(n) + 1))
    .replace(/\bthirty\b/g, '30')
    .replace(/\btwenty\b/g, '20')
    .replace(/\b([1-3]) ?x\b/g, '$1')
    .replace(/\b(?:yami yugi|yugi mut[oa]|yugi moto|seto kaiba|joey wheeler|jonouchi|mai valentine|maximillion pegasus|maximilian pegasus|weevil underwood|rex raptor|bandit keith|bonz)\b/g, (m) => ({ jonouchi: 'joey' })[m] ?? m.split(' ').find((x) => /^(yugi|kaiba|joey|mai|pegasus|weevil|rex|keith|bonz)$/.test(x)) ?? m)
    // "a deck like yugi", "kaiba's deck": the deck that duelist is known for
    .replace(/\b(?:(?:a |an )?deck )?(?:like|as|of|copy) (yugi|kaiba|joey|mai|pegasus|weevil|rex|bonz|keith)s?\b(?! skills?)/g, (_m, c: string) => `${CHAR_DECK[c]} deck`)
    .replace(/\b(yugi|kaiba|joey|mai|pegasus|weevil|rex|bonz|keith)s? (?!style|type|kind)([a-z]{3,}) deck\b/g, '$2 deck')
    .replace(/\b(yugi|kaiba|joey|mai|pegasus|weevil|rex|bonz|keith)s?(?: style| type| kind of)? deck\b/g, (_m, c: string) => `${CHAR_DECK[c]} deck`)
    .replace(/\s+/g, ' ')
    .trim();
  if (!/^(take|put|get|throw|bring|keep|leave|log|check|figure|find|sort|work|cash|fill|cut|swap|which|what|who|how|why|when|where|should|can|could|do|does|is|are|i)\b/.test(t) && !/\b(take|should|could|can|do|you|want|wanna|them|it)\b/.test(t)) t = t.replace(/^([a-z][a-z0-9 ]{2,40}?) out$/, 'take out $1').replace(/^([a-z][a-z0-9 ]{2,40}?) in$/, (m, x: string) => (/\b(is|are|it|this|my|the deck|deck)$/.test(x) ? m : `add ${x}`));
  for (let i = 0; i < 4; i++) t = t.replace(/^(hey|hi|hello|yo|sup|ok|okay|so|um|uh|hmm|well|alright|right|no wait|wait|hold on|actually|oops|sorry|now|and now|ok now|can you|could you|can u|could u|would you|will you|i want you to|id like you to|i need you to|i want to|i wanna|id like to|lets|let me)\b\s*/, '');
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
  if (all.some((n) => (cd(n)?.desc ?? '').includes(`"${c.name}"`) || (cd(n)?.desc ?? '').includes(`“${c.name}”`))) return true;
  // it names a card the deck runs: support for the deck's plan
  return quoted(c).some((q) => all.some((n) => n === q || n.startsWith(`${q} `)));
}
/** cards in the deck that need this one: the Ritual Monster for its Spell, Fusions for Polymerization, cards naming it */
function dependents(n: string, d: SpeedDeck): string[] {
  const c = cd(n);
  if (!c) return [];
  const all = [...new Set([...d.main, ...d.extra])].filter((x) => x !== n);
  return all.filter((x) => {
    const o = cd(x);
    if (!o) return false;
    if (c.sub === 'Ritual' && c.kind === 'spell' && RITUAL_OF(c) === x) return true;
    if (n === 'Polymerization' && o.sub === 'Fusion') return true;
    return o.desc.includes(`"${n}"`) || o.desc.includes(`“${n}”`);
  });
}
/** the names a card's text supports ("Elemental HERO"), other than its own */
const quoted = (c: CardInfo) => [...c.desc.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1]).filter((q) => q !== c.name && !/ Tokens?$/.test(q));

/** Speed Duel staples: removal, protection and answers any deck runs */
const STAPLES = new Map<string, number>([
  ...['Monster Reborn', 'Mystical Space Typhoon', 'Swords of Revealing Light', 'Sakuretsu Armor', 'Enemy Controller', 'Book of Moon', 'Quaking Mirror Force', 'Floodgate Trap Hole'].map((n) => [n, 1200] as const),
  ...['Cosmic Cyclone', 'Dust Tornado', 'Twister', 'Kunai with Chain', 'Waboku', 'Shrink', 'Fissure', 'Premature Burial', 'Divine Wrath', 'Breakthrough Skill', 'Widespread Ruin', 'Draining Shield', 'Negate Attack'].map((n) => [n, 500] as const),
]);

/**
 * A rough "how good is this card in a Speed Duel deck" for swaps: strong low-Level monsters,
 * removal and protection; support for a name the deck doesn't play is worth little, and a
 * Ritual Monster without its Spell (or a Spell without its monster) is dead.
 */
function worth(c: CardInfo, d?: SpeedDeck): number {
  let v: number;
  if (c.kind !== 'monster')
    v =
      1000 +
      (c.vanilla ? 0 : 300) +
      (/destroy|negate|banish/i.test(c.desc) ? 400 : 0) +
      // finds or draws cards
      (/from your deck to your hand|draw 2 cards/i.test(c.desc) ? 250 : 0) -
      (/pay half your life ?points|pay half your lp/i.test(c.desc) ? 300 : 0) -
      // tokens, counters and slow win conditions do little in a short Speed Duel
      (/\btoken\b|spell counter|place 1 counter|during your (next )?standby phase|win the duel|toss a coin|roll a (six-sided )?die/i.test(c.desc) ? 500 : 0) -
      (/\bdestroy (all|this card)\b.*\byour\b|send the top|discard your (entire )?hand/i.test(c.desc) ? 300 : 0) -
      // costs you a monster for little ("Target 1 monster you control; destroy it")
      (/^target 1 monster you control; destroy it/i.test(c.desc) ? 700 : 0) +
      // the cards every Speed Duel deck wants
      (STAPLES.get(c.name) ?? 0);
  else {
    const lv = c.level ?? 4;
    // big monsters cost Tributes, and ones that can't be Normal Summoned need a whole plan
    v = (c.atk ?? 0) + (c.vanilla ? 0 : 350) - (lv >= 7 ? 1300 : lv >= 5 ? 500 : 0) - (/cannot be normal summoned|must (first )?be special summoned|requires 3 tributes/i.test(c.desc) ? 1600 : 0);
    // drawbacks: hands the opponent cards, can't attack or change position, pays to stay
    if (/opponent draws|cannot attack|cannot change its battle position|is changed to defense position|destroy this card|pays? \d+ (life ?points|lp)|take \d+ damage|toss a coin|lose half your life points/i.test(c.desc)) v -= 600;
    // handing the opponent a card every battle, or turning your own burn into their life
    if (/your opponent draws 1 card/i.test(c.desc)) v -= 700;
    if (/would inflict damage to a player increases their life points/i.test(c.desc)) v -= 900;
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
      // the deck's few big hitters are its finishers, not its weakest cards (Blue-Eyes is worth its Tributes)
      const bigs = mons.filter((m) => (m.level ?? 4) >= 5 && m.sub !== 'Ritual').length;
      if (lv >= 5 && (c.atk ?? 0) >= 2400 && d.main.includes(c.name) && bigs <= 5 && !/cannot be normal summoned|must (first )?be special summoned/i.test(c.desc)) v += 1000;
    }
  }
  if (d) {
    if (c.kind === 'monster' && c.sub === 'Ritual' && !ritualSpellFor(c.name, d.main)) v -= 2500;
    if (c.kind === 'spell' && c.sub === 'Ritual') v += RITUAL_OF(c) && d.main.includes(RITUAL_OF(c)!) ? 1200 : -2500;
    if (orphan(c.name, d)) v -= 1800;
    if (c.kind !== 'monster' && typeClash(c.desc, d)) v -= 1400;
    // Polymerization (and cards that fetch it) with no Fusion the deck can make is dead weight
    if ((c.name === 'Polymerization' || (c.name !== 'Polymerization' && /"Polymerization"/.test(c.desc) && !/fusion monster/i.test(c.desc))) && !fusionReady(d)) v -= 1600;
    // a card other cards here need (Polymerization for the Fusions, a Ritual's Spell) stays
    else if (d.main.includes(c.name) && needed(c, d)) v += 1500;
    const q = quoted(c);
    if (q.length && c.sub !== 'Ritual' && !q.some((x) => [...d.main, ...d.extra].some((n) => n !== c.name && (n.includes(x) || (cd(n)?.desc ?? '').includes(`"${x}"`))))) v -= 900;
  }
  return v;
}

/** an Extra Deck Fusion whose named materials are all in the Main Deck */
function fusionReady(d: SpeedDeck): boolean {
  return d.extra.some((n) => canMake(n, d.main));
}
/** a Fusion whose material line the Main Deck can meet: names, archetypes with counts ("7 "Crystal Beast" monsters") and Types ("1 Machine monster + 1 Dinosaur monster") */
function canMake(n: string, main: string[]): boolean {
  const f = cd(n);
  if (f?.sub !== 'Fusion') return true;
  const line = (f.desc.split(/\n/)[0] ?? '').replace(/\(.*?\)/g, '');
  const mons = main.filter((x) => cd(x)?.kind === 'monster');
  const parts = line.split(/\s\+\s/);
  for (const part of parts) {
    const k = Number(part.match(/^\s*(\d+)\s/)?.[1] ?? 1);
    const name = part.match(/["“]([^"”]+)["”]/)?.[1];
    if (name) {
      // an exact card, or an archetype ("Crystal Beast") counted by monsters
      const hits = mons.filter((x) => x === name || x.startsWith(`${name} `) || (!cd(name) && x.includes(name))).length;
      if (hits < Math.min(k, 3)) return false;
      continue;
    }
    const kind = [...RACES, ...ATTRS].find((x) => new RegExp(`\\b${x}\\b`).test(part));
    if (kind && mons.filter((x) => cd(x)!.race === kind || cd(x)!.attribute === kind).length < Math.min(k, 3) + 1) return false;
  }
  return true;
}
/** worth by name; a name the card list doesn't know (an old save) sorts last */
const wn = (n: string, d?: SpeedDeck) => (cd(n) ? worth(cd(n)!, d) : -1e6);
const isNeeded = (n: string, d: SpeedDeck) => !!cd(n) && needed(cd(n)!, d);

/** Owned cards that could go in, strongest (for this deck) first. */
function candidates(w: ChatWorld, d: SpeedDeck, f: (c: CardInfo) => boolean, skip: string[] = []): CardInfo[] {
  return speedCards()
    .filter((c) => f(c) && !skip.includes(c.name) && !banned.has(c.kind as Kind) && !deadFor(c, d) && !whyCantAdd(d, c.name, w.collection))
    .map((c) => [c, worth(c, d)] as const)
    .sort((a, b) => b[1] - a[1])
    .map((x) => x[0]);
}

/** a spell or trap that would do nothing in this deck: support for cards it doesn't run, a cost it can't pay, nothing to Fusion or Ritual Summon */
function deadFor(c: CardInfo, d: SpeedDeck): boolean {
  const mons = d.main.map((n) => cd(n)).filter((m): m is CardInfo => m?.kind === 'monster');
  // a monster that feeds on Spells (Spell Counters) in a deck with almost none
  if (c.kind === 'monster') {
    if (mons.length >= 6 && /spell counter/i.test(c.desc) && d.main.filter((n) => cd(n)?.kind === 'spell').length < 4) return true;
    // a small monster built around one named monster ("Queen's Pawn" needs "Amazoness Queen") is dead without it
    const named = quoted({ ...c, desc: c.desc.replace(/treated as ["“][^"”]+["”]/g, '') }).filter((x) => cd(x)?.kind === 'monster' && x !== c.name && isSpeedName(x));
    const all = [...d.main, ...d.extra];
    if (mons.length >= 6 && named.length > 0 && (c.atk ?? 0) < 1800 && !named.some((x) => all.includes(x))) return true;
    // "Gains 300 ATK for each Continuous Spell": needs them
    if (mons.length >= 6 && needsOf(c).continuous && all.filter((x) => cd(x)?.kind === 'spell' && cd(x)?.sub === 'Continuous').length < 2) return true;
    // "Must first be Special Summoned by Tributing 1 "Sanga of the Thunder", "Kazejin", and "Suijin"": every one
    const summon = c.desc.match(/must (?:first )?be special summoned[^.]*?by tributing[^.]*/i)?.[0];
    const pieces = summon ? [...summon.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1]) : [];
    return pieces.length > 0 && !pieces.every((x) => all.includes(x));
  }
  // answers to rare opponent cards ("destroy 1 face-up card that has an effect that negates Trap Cards' effects") sit dead
  if (/\bthat has an effect that negates\b/i.test(c.desc)) return true;
  // Token support with nothing that makes Tokens
  if (/\btokens?\b/i.test(c.desc) && !/\bspecial summon\b[^.]*\btokens?\b/i.test(c.desc) && mons.length >= 6 && ![...d.main].some((n) => n !== c.name && /\bspecial summon\b[^.]*\btokens?\b/i.test(cd(n)?.desc ?? ''))) return true;
  if (mons.length >= 6) {
    // costs and targets the deck can't supply: Normal Monsters, Xyz or Fusion Monsters, "7 or more DARK monsters"
    if (/\b(banish|discard|send|reveal|tribute|target) (1|a|one|2|two) normal monsters?\b|\bnormal monsters? (from|in) your (hand|deck|graveyard|gy)\b/i.test(c.desc) && mons.filter((m) => m.vanilla).length < 3) return true;
    if (/\bxyz monster|\b"number|\brank-up/i.test(c.desc) && !d.extra.some((n) => cd(n)?.sub === 'Xyz')) return true;
    if (/\bfusion monster/i.test(c.desc) && !/polymerization/i.test(c.name) && !fusionReady(d)) return true;
    const many = c.desc.match(/\b(\d+) or more ([A-Z]+|[A-Z][a-z]+(?:-[A-Z][a-z]+)?) monsters\b/);
    if (many && [...RACES, ...ATTRS].includes(many[2]) && mons.filter((m) => m.race === many[2] || m.attribute === many[2]).length < Number(many[1]) + 2) return true;
  }
  if (c.name === 'Polymerization' || (/"Polymerization"/.test(c.desc) && !/fusion monster/i.test(c.desc))) return !fusionReady(d);
  if (c.sub === 'Ritual') return !RITUAL_OF(c) || !d.main.includes(RITUAL_OF(c)!);
  if (mons.length >= 6 && unmet(c, d)) return true;
  if (orphan(c.name, d) || typeClash(c.desc, d)) return true;
  const q = quoted({ ...c, desc: c.desc.replace(/treated as ["“][^"”]+["”]/g, '') });
  const all = [...d.main, ...d.extra].filter((n) => n !== c.name);
  // "Amazoness" support needs Amazoness monsters, not just more Amazoness spells
  return q.length > 0 && !q.some((x) => all.some((n) => n === x || (cd(n)?.kind === 'monster' && n.includes(x))));
}

/**
 * What a Spell or Trap asks of the deck that the deck doesn't have: the cards or family it
 * names, the Type or Attribute it works with, Equip Spells, Normal Monsters, Spell Counters.
 * Mentions about the opponent's monsters ("destroy 1 Dragon your opponent controls") ask nothing.
 */
let speedNames: Set<string> | null = null;
const isSpeedName = (n: string) => (speedNames ??= new Set(speedCards().map((x) => x.name))).has(n);
// "Dragon, Winged Beast, and Thunder monsters" names all three
const UNMET_RE = [...RACES, ...ATTRS].map((x) => [x, new RegExp(`(?<!non-)(?<!-)\\b${x.replace(/-/g, '[- ]')}(?:-Type)?(?:,? (?:and |or )?[A-Z][A-Za-z]*(?:[- ][A-Z][a-z]+)?(?:-Type)?)* (?:Normal |Effect |Tuner )?monsters?\\b`)] as const);
const needCache = new Map<string, { distinct: [string, number] | null; continuous: boolean; named: string[]; must: string[]; kinds: string[]; equip: boolean; normal: boolean; counters: boolean; ritual: boolean }>();
function needsOf(c: CardInfo) {
  let hit = needCache.get(c.name);
  if (!hit) {
    const text = c.desc.replace(/(?:always )?treated as (?:an? )?["“][^"”]+["”](?: card)?/g, '');
    // the card's own sentences, minus the ones about the opponent's side
    const ours = text.split(/(?<=[.:;])\s+/).filter((x) => !/\b(your opponent controls|your opponent's|opponent's monsters?|your opponent (?:normal|special|flip|tribute)? ?summons)\b/i.test(x)).join(' ');
    const named = [...ours.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1]).filter((q) => q !== c.name && !/ Tokens?$/.test(q));
    const dist = ours.match(/\b(\d+) ["“]([^"”]+)["”] (?:monsters|cards) with different names\b/i);
    hit = {
      distinct: dist ? [dist[2], Number(dist[1])] : null,
      continuous: /\bcontinuous spells?\b/i.test(ours) && c.sub !== 'Continuous',
      named,
      // a cost naming several cards with "and" ("Shuffle 1 "Duoterion", 1 "Hydrogeddon", and 1 "Oxygeddon"") needs every one
      must: ours.split(/(?<=[.;])\s+/).filter((x) => /\b(tribute|send|banish|discard|reveal|shuffle)\b/i.test(x) && /["“][^"”]+["”][^;.]*\band\b[^;.]*["“]/.test(x) && !/\bor\b/.test(x.split(';')[0].replace(/and\/or/g, ''))).flatMap((x) => [...x.split(';')[0].matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1])),
      kinds: UNMET_RE.filter(([, re]) => re.test(ours)).map(([x]) => x),
      equip: /\bequip (?:spells?|cards?)\b/i.test(ours) && c.sub !== 'Equip',
      normal: /\bnormal monsters?\b/i.test(ours),
      counters: /\bspell counters?\b/i.test(ours),
      ritual: /\britual monsters?\b/i.test(ours),
    };
    needCache.set(c.name, hit);
  }
  return hit;
}
function unmet(c: CardInfo, d: SpeedDeck): string | null {
  const n = needsOf(c);
  if (!n.named.length && !n.kinds.length && !n.equip && !n.normal && !n.counters && !n.ritual && !n.continuous) return null;
  const mine = [...d.main, ...d.extra].filter((x) => x !== c.name);
  const mons = d.main.map((x) => cd(x)).filter((m): m is CardInfo => m?.kind === 'monster');
  if (n.named.length) {
    // a family ("Gravekeeper's") needs 3 or more of its monsters, and more than one name of them
    const fam = (q: string) => mons.filter((m) => m.name.includes(q) || m.desc.includes(`treated as "${q}`));
    const has = (q: string) => mine.includes(q) || mine.some((x) => (cd(x)?.desc ?? '').includes(`treated as "${q}"`)) || (!cd(q) || !isSpeedName(q) ? fam(q).length >= 3 && new Set(fam(q).map((m) => m.name)).size >= 2 : false);
    if (n.distinct && new Set(fam(n.distinct[0]).map((m) => m.name)).size < n.distinct[1]) return `needs ${n.distinct[1]} different ${n.distinct[0]} cards`;
    const gap = n.must.find((q) => !has(q));
    if (gap) return `needs ${gap}`;
    if (!n.named.some(has)) return `needs ${n.named[0]}`;
  }
  if (n.kinds.length && !n.kinds.some((x) => mons.filter((m) => m.race === x || m.attribute === x).length >= 5)) return `needs ${n.kinds[0]} monsters`;
  if (n.equip && mine.filter((x) => cd(x)?.sub === 'Equip').length < 2) return 'needs Equip Spells';
  if (n.normal && mons.filter((m) => m.vanilla).length < 4) return 'needs Normal Monsters';
  if (n.counters && !mons.some((m) => /spell counter/i.test(m.desc))) return 'needs Spell Counter monsters';
  if (n.ritual && !mons.some((m) => m.sub === 'Ritual')) return 'needs a Ritual Monster';
  if (n.continuous && mine.filter((x) => cd(x)?.sub === 'Continuous' && cd(x)?.kind === 'spell').length < 2) return 'needs Continuous Spells';
  return null;
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
  if (c.name === 'Polymerization') {
    const fus = d.extra.filter((n) => cd(n)?.sub === 'Fusion');
    return fus.length ? `it Fusion Summons ${listOf([...new Set(fus)])} from your Extra Deck` : "it Fusion Summons, but this deck has no Fusion in the Extra Deck, so it does nothing here: say \"take out polymerization\" or \"add fusions\"";
  }
  if (orphan(c.name, d)) return `it needs cards that name "${c.name}", and this deck has none, so it's a dead card here`;
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
  return `It has ${main.length} cards: ${k('monster')} monster${k('monster') === 1 ? '' : 's'}, ${k('spell')} spell${k('spell') === 1 ? '' : 's'} and ${k('trap')} trap${k('trap') === 1 ? '' : 's'}${ace ? `, with ${ace.name} (${ace.atk} ATK) as the big hitter` : ''}${skill ? `, and ${bare(skill)} as the Skill` : ''}.`;
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
  // dead cards: support for cards it doesn't run, a Fusion card with nothing to make, a cost it can't pay
  const dead = [...new Set(d.main)].filter((n) => {
    const c = cd(n);
    return !!c && c.kind !== 'monster' && (orphan(n, d) || typeClash(c.desc, d) || (n === 'Polymerization' && !fusionReady(d)) || (c.sub === 'Ritual' && !d.main.includes(RITUAL_OF(c) ?? '')) || (quoted({ ...c, desc: c.desc.replace(/treated as ["“][^"”]+["”]/g, '') }).length > 0 && !needed(c, d) && worth(c, d) < 900));
  });
  const backrow = cs.filter((c) => c.kind !== 'monster');
  const bAvg = backrow.reduce((a, c) => a + worth(c, d), 0) / Math.max(1, backrow.length);
  const effects = cs.filter((c) => c.kind === 'monster' && !c.vanilla).length;
  // compared with what they own: when nothing better is in the collection, it's the best they can make
  const room = strongerPlan(w, 4, false).calls.some((c) => c.name === 'edit_deck');
  const raw = 6 + (avg - 1500) / 300 + (effects >= 6 ? 0.5 : 0) + (bAvg >= 1600 ? 0.5 : 0) - tips.length - dead.length - problems.length * 2 + (d.skill ? 0.5 : 0);
  const score = Math.max(1, Math.min(10, Math.round(!room && !dead.length && !problems.length && !tips.length ? Math.max(raw, 7) : raw)));
  const weakest = [...new Set(d.main)].filter((n) => !protect.has(n)).sort((a, b) => wn(a, d) - wn(b, d))[0];
  const weak = [...(dead.length ? [`${listOf(dead)} ${dead.length > 1 ? 'do' : 'does'} nothing here (${dead.length > 1 ? 'they support' : 'it supports'} cards this deck doesn't run).`] : []), ...tips, ...(avg < 1500 ? [`The monsters you can summon without a Tribute are small (${avg} ATK on average), so bigger attackers will run them over.`] : []), ...(weakest && !dead.includes(weakest) ? [`The weakest card is ${weakest}.`] : [])];
  return {
    calls: [{ name: 'view_deck', input: {} }],
    answer: () =>
      `I'd give it ${score}/10. ${describe(d.main, d.skill)} Your Level 4-or-lower monsters average ${avg} ATK.${problems.length ? ` It can't duel yet: ${problems[0]}.` : ''} ${weak.join(' ') || 'The balance looks right.'}${!room && !dead.length ? ' It already uses the best cards you own for its slots; new cards from packs will push it higher.' : score < 8 ? ' Say "make it stronger" and I\'ll swap in better cards.' : ''}`.trim(),
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
    traps.length ? `${traps.length} trap${traps.length === 1 ? '' : 's'} (${listOf(traps.slice(0, 2).map((c) => c.name))}${traps.length > 2 ? '…' : ''}) guard your field on their turn.` : '',
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

function readWish(said: string, w: ChatWorld): Wish & { arounds: string[]; missing: string | null; noRaces: string[]; noAttrs: string[] } {
  let t = fixWords(said);
  // "a dragon deck with no warriors": Types and Attributes they don't want are not the theme
  const NOT = '(?:no|without|not|but no|except|minus|excluding)\\s+(?:any\\s+)?';
  const noRaces = RACES.filter((r) => new RegExp(`\\b${NOT}${flat(r)}(s|es)?\\b`).test(t.replace(/ies\b/g, 'y')));
  const noAttrs = ATTRS.filter((a) => new RegExp(`\\b${NOT}${a.toLowerCase()}\\b`).test(t));
  for (const r of noRaces) t = t.replace(/ies\b/g, 'y').replace(new RegExp(`\\b${NOT}${flat(r)}(s|es)?\\b`), ' ');
  for (const a of noAttrs) t = t.replace(new RegExp(`\\b${NOT}${a.toLowerCase()}\\b`), ' ');
  // "keep it under 25" is 24 at most; the smallest (strongest) legal size fits it
  const under = t.match(/\b(?:under|less than|below|fewer than)\s+(\d{2})\b/);
  const size = under ? Math.max(MAIN_MIN, Math.min(Number(under[1]) - 1, 20)) : Number(t.match(/\b(2\d|30)\b/)?.[1] ?? 0) || 20;
  const style: RandomStyle = /\b(aggro|aggressive|attack|beat ?down|offen[cs]e|offensive|rush|damage|fast)\b/.test(t) ? 'beatdown' : /\b(control|defen[cs]e|defensive|trap heavy|lots of traps|stall|slow|traps? deck)\b/.test(t) ? 'control' : 'balanced';
  let theme: RandomTheme = /\b(surprise|random|anything|whatever)\b/.test(t) ? { kind: 'surprise' } : { kind: 'any' };
  const attr = ATTRS.find((a) => new RegExp(`\\b${a.toLowerCase()}\\b`).test(t) && !new RegExp(`\\b${a.toLowerCase()} (magician|hole|world|world|ruler|armed|blade|knight|warrior)`).test(t));
  // the Type said first wins ("lots of dragons and maybe some spellcasters")
  const tr = t.replace(/\bspell ?casters?\b/, 'spellcaster').replace(/\bwarrior beasts?\b/, 'beast warrior');
  const race = RACES.map((r) => [r, tr.search(new RegExp(`\\b${flat(r)}(s|es)?\\b`))] as const).filter((x) => x[1] >= 0).sort((a, b) => a[1] - b[1] || b[0].length - a[0].length)[0]?.[0];
  const without = (['monster', 'spell', 'trap'] as Kind[]).filter((k) => new RegExp(`\\b(no|without( any)?|zero|0)\\s+${k}s?\\b`).test(t));
  // cards or families to build around ("dark magician and blue eyes"): one per piece of the sentence
  const owned = (n: string) => !w.collection || (w.collection[n] ?? 0) > 0;
  const families: { around: string; card: string | null }[] = [];
  let missing: string | null = null;
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
    // a family that exists in Speed Duel but that they own none of
    else if (!found && w.collection) {
      // the whole family name when it has two words ("red eyes", not just "eyes")
      const tries = [...words.slice(0, -1).map((x, i) => `${x} ${words[i + 1]}`), ...words.filter((x) => x.length >= 4)];
      for (const x of tries)
        if (nameIndex().filter((c) => !c.skill && ` ${c.flat} `.includes(` ${x} `)).length >= 2) {
          missing = missing ?? x;
          break;
        }
    }
  }
  const around = families[0]?.around ?? null;
  const aroundCard = families[0]?.card ?? null;
  if (race) theme = { kind: 'race', value: race };
  else if (attr && !(around && around.includes(attr.toLowerCase()))) theme = { kind: 'attribute', value: attr };
  return { size: Math.min(MAIN_MAX, Math.max(MAIN_MIN, size)), style, theme, around, aroundCard, arounds: families.map((f) => f.around), missing: families.length ? null : missing, best: /\b(best|strongest|strong|good|top|meta|op|powerful|win|wins|winning|alot|easy|beginners?|simple|newbie)\b/.test(t), without, noRaces, noAttrs };
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
  let core = pool.filter((c) => ` ${flat(c.name)} `.includes(` ${q} `));
  // "red eyes black dragon" alone is one card: its family ("red eyes") comes with it
  const fam2 = q.split(' ').slice(0, 2).join(' ');
  if (core.length < 4 && q.split(' ').length >= 3) core = [...core, ...pool.filter((c) => !core.includes(c) && ` ${flat(c.name)} `.includes(` ${fam2} `))];
  const named = [...new Set(core.flatMap(quoted))].map((n) => byName.get(n)).filter((c): c is CardInfo => !!c && !core.includes(c));
  const support = pool.filter((c) => !core.includes(c) && !named.includes(c) && ` ${flat(c.desc)} `.includes(` ${q} `)).sort((a, b) => worth(b) - worth(a));
  // what makes the family work comes first (Toon World for Toons, Elegant Egotist for Harpie Lady Sisters), then its monsters, strongest first
  const enablers = [...core, ...named].filter((c) => c.kind !== 'monster' && (named.includes(c) || core.some((m) => m.kind === 'monster' && quoted(m).includes(c.name))));
  // the card asked for by name comes first ("Blue-Eyes White Dragon" before the rest of its family)
  const mons = [...core, ...named].filter((c) => c.kind === 'monster').sort((a, b) => Number(flat(b.name) === q) - Number(flat(a.name) === q) || worth(b) - worth(a));
  const rest = [...core, ...named].filter((c) => c.kind !== 'monster' && !enablers.includes(c)).sort((a, b) => worth(b) - worth(a));
  const list = [...enablers, ...mons.slice(0, 5), ...support.filter((c) => c.kind === 'monster').slice(0, 2), ...rest.slice(0, 2), ...support.filter((c) => c.kind !== 'monster').slice(0, 3), ...mons.slice(5)];
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
    const k = c.kind === 'monster' && (c.level ?? 4) >= 5 && !core.includes(c) ? Math.min(2, owned(c.name)) : enablers.includes(c) && c.sub !== 'Field' ? Math.min(2, owned(c.name)) : owned(c.name);
    // with 3 Monster Zones, a few big monsters is plenty: 3 that need 2 Tributes, 4 that need 1
    const lv = c.kind === 'monster' && c.sub !== 'Ritual' && !isExtraCard(c.name) ? (c.level ?? 4) : 0;
    const bigs = (lo: number, hi: number) => out.filter((n) => cd(n)?.kind === 'monster' && cd(n)?.sub !== 'Ritual' && !isExtraCard(n) && (cd(n)?.level ?? 0) >= lo && (cd(n)?.level ?? 0) <= hi).length;
    for (let i = 0; i < k && room(); i++) {
      if (lv >= 7 && bigs(7, 99) >= 3) break;
      if (lv >= 5 && lv <= 6 && bigs(5, 6) >= 3) break;
      if (lv >= 5 && bigs(5, 99) >= 5) break;
      out.push(c.name);
    }
  }
  // an enabler with none of the monsters that need it is a dead card (Toon World with no Toons in a Dark Magician deck)
  return out.filter((n) => cd(n)?.kind === 'monster' || ` ${flat(n)} `.includes(` ${q} `) || !enablers.some((e) => e.name === n) || out.some((m) => m !== n && quoted(cd(m)!).includes(n)));
}

/** how many Speed Duel cards name each card: "Toon World" and "Necrovalley" are what whole families need */
let namedBy: Map<string, number> | null = null;
function enablerOf(n: string): boolean {
  if (!namedBy) {
    namedBy = new Map();
    for (const c of speedCards()) for (const q of new Set(quoted(c))) namedBy.set(q, (namedBy.get(q) ?? 0) + 1);
  }
  return (namedBy.get(n) ?? 0) >= 3;
}
/** a spell or trap that a family needs, in a deck with none of that family: dead weight */
function orphan(n: string, d: { main: string[]; extra: string[] }): boolean {
  const c = cd(n);
  if (!c || c.kind === 'monster' || n === 'Polymerization' || !enablerOf(n)) return false;
  return ![...d.main, ...d.extra].some((m) => m !== n && (cd(m)?.desc ?? '').includes(`"${n}"`));
}

/**
 * A pass over a built deck: its weakest spells/traps and monsters (never the ones the theme
 * or the player asked for) go for clearly better ones it owns, monsters on the deck's Type.
 */
function polish(main: string[], extra: string[], w: ChatWorld, keep: Set<string>, race: string | null, drop: (n: string) => boolean = () => false, skill: string | null = null): string[] {
  // with the Skill on: it can share a Limited group with a card
  let work: SpeedDeck = { ...w.deck, main: [...main], extra: [...extra], skill };
  for (const kind of ['spell/trap', 'monster'] as const) {
    const isK = (c?: CardInfo) => !!c && (kind === 'monster' ? c.kind === 'monster' : c.kind !== 'monster') && !isExtraCard(c.name);
    const weak = [...new Set(work.main)].filter((n) => isK(cd(n)) && ((!keep.has(n) && !isNeeded(n, work)) || orphan(n, work))).sort((a, b) => wn(a, work) - wn(b, work));
    let swaps = 0;
    for (const n of weak) {
      if (swaps >= (kind === 'monster' ? 4 : 6)) break;
      for (let copy = work.main.filter((x) => x === n).length; copy > 0; copy--) {
        const without = { ...work, main: [...work.main] };
        without.main.splice(without.main.indexOf(n), 1);
        const c = cd(n)!;
        const better = candidates(w, without, (x) => isK(x) && x.sub !== 'Ritual' && !drop(x.name) && (kind !== 'monster' || !race || x.race === race || c.race !== race) && (kind !== 'monster' || (x.level ?? 4) <= Math.max(4, c.level ?? 4)) && worth(x, without) > worth(c, without) + 250)[0];
        if (!better) break;
        work = { ...without, main: [...without.main, better.name] };
        swaps++;
      }
    }
  }
  return work.main;
}

/** How good a built deck looks, for picking the best of a few tries: strong early monsters and real spells/traps. */
function deckScore(main: string[]): number {
  const cs = main.map((n) => cd(n)!).filter(Boolean);
  const mons = cs.filter((c) => c.kind === 'monster');
  const low = mons.filter((c) => (c.level ?? 0) <= 4);
  const avg = low.reduce((a, c) => a + (c.atk ?? 0), 0) / Math.max(1, low.length);
  const effects = cs.filter((c) => !c.vanilla).length;
  const backrow = cs.filter((c) => c.kind !== 'monster').reduce((a, c) => a + worth(c, { id: '', name: '', main, extra: [], skill: null }), 0) / 10;
  return avg + effects * 40 + Math.min(low.length, 12) * 60 - Math.max(0, mons.length - low.length - 4) * 300 + backrow;
}

/**
 * The deck checker: one number for how well a deck hangs together, and the reasons it loses
 * points. Dead cards and a Skill that can't work cost the most; then the monster/spell/trap
 * mix, too many Tribute monsters, few Level 4 attackers, and a scattered mix of Types.
 */
export function deckIssues(d: SpeedDeck, theme?: (c: CardInfo) => boolean): { score: number; issues: string[] } {
  const issues: string[] = [];
  const cs = d.main.map((n) => cd(n)).filter((c): c is CardInfo => !!c);
  const size = Math.max(MAIN_MIN, cs.length);
  const k = size / 20;
  let score = 0;
  // every card earns its place: its worth here, and nothing dead
  for (const c of cs) score += Math.max(-1500, Math.min(3500, worth(c, d))) / 20;
  const deadNames = [...new Set(cs.filter((c) => deadFor(c, d) || orphan(c.name, d)).map((c) => c.name))];
  const deadN = cs.filter((c) => deadNames.includes(c.name)).length;
  if (deadN) (score -= deadN * 450), issues.push(`dead: ${deadNames.join(', ')}`);
  const badExtra = [...new Set(d.extra.filter((n) => !canMake(n, d.main) || (cd(n)?.sub === 'Fusion' && !d.main.some((x) => /polymerization|fusion/i.test(x)) && !(d.skill && /fusion summon/i.test(cd(d.skill)?.desc ?? '')))))];
  if (badExtra.length) (score -= badExtra.length * 300), issues.push(`Extra Deck can't be made: ${badExtra.join(', ')}`);
  if (!d.skill) (score -= 150), issues.push('no Skill');
  else if (!skillFits(d.skill, d)) (score -= 600), issues.push(`Skill doesn't fit: ${d.skill}`);
  // the mix: about 11-14 monsters in 20, at least 5 spells and traps, 2 or more traps
  const mons = cs.filter((c) => c.kind === 'monster');
  const traps = cs.filter((c) => c.kind === 'trap').length;
  const backrow = cs.length - mons.length;
  const mLo = Math.round(10 * k), mHi = Math.round(15 * k);
  if (mons.length < mLo) (score -= (mLo - mons.length) * 160), issues.push(`only ${mons.length} monsters`);
  if (mons.length > mHi) (score -= (mons.length - mHi) * 140), issues.push(`${mons.length} monsters, few spells/traps`);
  if (backrow < Math.round(5 * k)) score -= (Math.round(5 * k) - backrow) * 120;
  if (traps < 2) (score -= (2 - traps) * 260), issues.push(`${traps} traps`);
  const spells = cs.filter((c) => c.kind === 'spell').length;
  if (spells < 2) (score -= (2 - spells) * 260), issues.push(`${spells} spells`);
  // more Polymerization than Fusions to make is a brick
  const polys = cs.filter((c) => c.name === 'Polymerization').length;
  const fusN = d.extra.filter((n) => cd(n)?.sub === 'Fusion').length;
  if (polys > Math.max(1, Math.min(2, fusN))) score -= (polys - Math.max(1, Math.min(2, fusN))) * 200;
  // cards that work together: support for cards the deck runs, and cards other cards name
  score += cs.filter((c) => !deadNames.includes(c.name) && needed(c, d)).length * 60;
  // the theme asked for ("a Dragon deck", "Harpie", "burn") stays the deck's heart
  if (theme) score += cs.filter(theme).length * 110;
  // Tributes: only 3 Monster Zones, so a few big monsters at most
  const plain = (c: CardInfo) => c.sub !== 'Ritual' && !isExtraCard(c.name);
  const tribs = mons.filter((c) => plain(c) && (c.level ?? 4) >= 5).length;
  const huge = mons.filter((c) => plain(c) && (c.level ?? 4) >= 7).length;
  const tMax = Math.round(3 * k) + 1;
  if (tribs > tMax) (score -= (tribs - tMax) * 180), issues.push(`${tribs} Tribute monsters`);
  if (huge > 3) score -= (huge - 3) * 200;
  // Level 4 attackers that can trade in battle
  const beaters = mons.filter((c) => plain(c) && (c.level ?? 4) <= 4 && (c.atk ?? 0) >= 1500).length;
  if (beaters < Math.round(5 * k)) (score -= (Math.round(5 * k) - beaters) * 170), issues.push(`only ${beaters} strong Level 4 attackers`);
  // one Type or one family hangs together (Type support, Skills)
  const races = new Map<string, number>();
  for (const c of mons) if (c.race) races.set(c.race, (races.get(c.race) ?? 0) + 1);
  const top = Math.max(0, ...races.values());
  score += top * 18;
  // a consistent deck runs its key cards more than once
  const singles = [...new Set(d.main)].filter((n) => d.main.filter((x) => x === n).length === 1).length;
  if (singles > Math.round(8 * k)) score -= (singles - Math.round(8 * k)) * 25;
  return { score: Math.round(score), issues };
}
export const deckQuality = (d: SpeedDeck, theme?: (c: CardInfo) => boolean) => deckIssues(d, theme).score;

/** owned Fusions the Main Deck has the materials for, strongest first */
function fusionsFor(main: string[], w: ChatWorld): string[] {
  return speedCards()
    .filter((c) => c.sub === 'Fusion' && !unplayableReason(c.name) && (!w.collection || (w.collection[c.name] ?? 0) > 0) && limitStatus(c.name) !== 'Forbidden' && canMake(c.name, main) && /["“]/.test(c.desc.split('\n')[0] ?? ''))
    .sort((a, b) => (b.atk ?? 0) - (a.atk ?? 0))
    .map((c) => c.name);
}
/** the Extra Deck topped up with up to 3 Fusions the deck can make */
function withFusions(d: SpeedDeck, w: ChatWorld): string[] {
  const extra = d.extra.filter((n) => canMake(n, d.main));
  for (const n of fusionsFor(d.main, w)) {
    if (extra.filter((x) => cd(x)?.sub === 'Fusion').length >= 3 || extra.length >= EXTRA_MAX) break;
    if (!extra.includes(n) && !whyCantAdd({ ...d, extra }, n, w.collection)) extra.push(n);
  }
  return extra;
}

/** the names in a that b doesn't have, copy by copy */
function diffNames(a: string[], b: string[]): string[] {
  const left = [...b];
  return a.filter((n) => {
    const i = left.indexOf(n);
    return i < 0 ? true : (left.splice(i, 1), false);
  });
}

/**
 * The deck optimizer: swaps one card at a time for the owned card that raises the checker's
 * score the most, until no swap helps. Cards the player named (`fixed`) never move.
 */
function optimize(d: SpeedDeck, w: ChatWorld, fixed: Set<string>, drop: (n: string) => boolean = () => false, theme?: (c: CardInfo) => boolean, rounds = 10): SpeedDeck {
  let cur: SpeedDeck = { ...d, main: [...d.main], extra: [...d.extra] };
  let score = deckQuality(cur, theme);
  const owned = (n: string) => !w.collection || (w.collection[n] ?? 0) > 0;
  // the pool: the strongest owned cards of each kind for this deck, a short list so it stays quick on a phone
  const pool = (deck: SpeedDeck) => {
    const ok = speedCards().filter((c) => c.sub !== 'Skill' && c.sub !== 'Ritual' && !isExtraCard(c.name) && owned(c.name) && !drop(c.name) && !banned.has(c.kind as Kind) && !unplayableReason(c.name) && limitStatus(c.name) !== 'Forbidden');
    const by = (k: string, n: number) => ok.filter((c) => c.kind === k && !deadFor(c, deck)).map((c) => [c, worth(c, deck)] as const).sort((a, b) => b[1] - a[1]).slice(0, n).map((x) => x[0].name);
    // the pieces the deck's own cards name (Sanga, Kazejin and Suijin for Gate Guardian, a Ritual's Spell), and Polymerization when a Fusion is in reach
    const reqs = [...new Set(deck.main)].flatMap((n) => {
      const c = cd(n);
      if (!c) return [];
      const ritual = c.kind === 'monster' && c.sub === 'Ritual' ? speedCards().filter((x) => x.sub === 'Ritual' && x.kind === 'spell' && RITUAL_OF(x) === c.name).map((x) => x.name) : [];
      return [...needsOf(c).named, ...ritual];
    }).filter((n) => isSpeedName(n) && owned(n) && !isExtraCard(n) && !drop(n) && cd(n)?.sub !== 'Skill');
    const poly = owned('Polymerization') && !deck.main.includes('Polymerization') && fusionsFor(deck.main, w).length ? ['Polymerization'] : [];
    // the theme's own cards always get a look, even when plain stats rank them low (burn cards)
    const themed = theme ? ok.filter((c) => theme(c) && !deadFor(c, deck)).map((c) => [c, worth(c, deck)] as const).sort((a, b) => b[1] - a[1]).slice(0, 10).map((x) => x[0].name) : [];
    return [...new Set([...by('monster', 12), ...by('spell', 8), ...by('trap', 8), ...themed, ...reqs, ...poly])];
  };
  for (let r = 0; r < rounds; r++) {
    let bestMove: { out: string; into: string; score: number } | null = null;
    const ins = pool(cur);
    const outs = [...new Set(cur.main)].filter((n) => !fixed.has(n));
    for (const out of outs) {
      const without = { ...cur, main: [...cur.main] };
      without.main.splice(without.main.indexOf(out), 1);
      for (const into of ins) {
        if (into === out || whyCantAdd(without, into, w.collection)) continue;
        const trial = { ...without, main: [...without.main, into] };
        // Polymerization comes with the Fusions it can make
        if (into === 'Polymerization' || /\bfusion summon\b/i.test(cd(into)?.desc ?? '')) trial.extra = withFusions(trial, w);
        const sc = deckQuality(trial, theme);
        if (sc > (bestMove?.score ?? score + 15)) bestMove = { out, into, score: sc };
      }
    }
    // a card missing its pieces (Gate Guardian without Sanga, Kazejin and Suijin): bring them all in at once for the weakest cards
    if (!bestMove) {
      let combo: { deck: SpeedDeck; score: number } | null = null;
      for (const n of [...new Set(cur.main)]) {
        const c = cd(n);
        if (!c) continue;
        const summon = c.desc.match(/must (?:first )?be special summoned[^.]*?by tributing[^.]*/i)?.[0];
        const want = [...(summon ? [...summon.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1]) : []), ...needsOf(c).must].filter((x) => isSpeedName(x) && owned(x) && !isExtraCard(x) && !cur.main.includes(x));
        if (!want.length || want.length > 4) continue;
        const spare = [...cur.main].filter((x) => !fixed.has(x) && x !== n && !want.includes(x)).sort((a, b) => wn(a, cur) - wn(b, cur));
        const trial = { ...cur, main: [...cur.main] };
        for (const x of spare.slice(0, want.length)) trial.main.splice(trial.main.indexOf(x), 1);
        if (want.some((x) => whyCantAdd(trial, x, w.collection))) continue;
        trial.main.push(...want);
        const sc = deckQuality(trial, theme);
        if (sc > (combo?.score ?? score + 15)) combo = { deck: trial, score: sc };
      }
      if (!combo) break;
      cur = combo.deck;
      score = combo.score;
      continue;
    }
    const next = { ...cur, main: [...cur.main] };
    next.main.splice(next.main.indexOf(bestMove.out), 1);
    next.main.push(bestMove.into);
    if (bestMove.into === 'Polymerization' || /\bfusion summon\b/i.test(cd(bestMove.into)?.desc ?? '')) next.extra = withFusions(next, w);
    cur = next;
    score = bestMove.score;
  }
  // an Extra Deck monster the deck can no longer make goes; a deck that can Fusion Summon gets the Fusions it can make
  cur.extra = cur.extra.filter((n) => canMake(n, cur.main) || fixed.has(n));
  if (cur.main.some((n) => n === 'Polymerization' || /\bfusion summon\b/i.test(cd(n)?.desc ?? '')) || (cur.skill && /\bfusion summon\b/i.test(cd(cur.skill)?.desc ?? ''))) cur.extra = withFusions(cur, w);
  return cur;
}

const deckTitle = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * The "keep dark magician" and "without dark magician" parts of a request: the cards (by
 * name) to keep from the deck, the ones to leave out, and the rest of what was said.
 */
function clauses(t: string, d: SpeedDeck): { text: string; keep: string[]; avoid: string[] } {
  let text = ` ${t} `;
  const keep: string[] = [];
  const avoid: string[] = [];
  const END = '(?=\\s+(?:and|but|with|without|called|named|call it|name it)\\b|$)';
  for (const m of t.matchAll(new RegExp(`\\b(?:but |and )?(?:keep|keeping|leave|leaving|save|saving)\\s+(?:in\\s+)?(?:the\\s+|my\\s+)?(.+?)${END}`, 'g'))) {
    const f = findCards(m[1], d);
    if (!f.length) continue;
    for (const x of f) {
      const k = d.main.filter((n) => n === x.name).length + d.extra.filter((n) => n === x.name).length;
      for (let i = 0; i < Math.min(COPIES, Math.max(1, x.count ?? k)); i++) keep.push(x.name);
    }
    text = text.replace(m[0], ' ');
  }
  for (const m of t.matchAll(new RegExp(`\\b(?:without|but no|but not|not|except|excluding|minus|no)\\s+(?:any\\s+)?(?:the\\s+|my\\s+)?(.+?)${END}`, 'g'))) {
    if (kindWord(m[1].split(' ')[0]) || /^(more|less|fewer)\b/.test(m[1])) continue;
    const f = findCards(m[1], d);
    if (!f.length) continue;
    avoid.push(...f.map((x) => x.name));
    text = text.replace(m[0], ' ');
  }
  return { text: text.replace(/\s+/g, ' ').trim(), keep, avoid };
}

/** kinds ruled out this chat */
let banned = new Set<Kind>();
/** a kind the player said to leave alone ("leave the spells alone and add traps"): edits make room elsewhere */
let hold: Kind | null = null;
/** cards a restyle keeps from the deck that's there ("make it all dragons" keeps the Dragons and their support) */
let restyleKeep: string[] = [];
function buildPlan(said: string, w: ChatWorld): Plan {
  const cl = clauses(said, w.deck);
  const t = cl.text;
  const avoid = new Set(cl.avoid);
  const called = t.match(/\b(?:and )?(?:call it|name it|called|named)\s+(.+)$/);
  const wish = readWish(called ? t.slice(0, called.index) : t, w);
  const aroundWord = t.match(/\b(?:around|based on|with|using|of)\s+(?:my\s+|the\s+)?([a-z0-9 ]+?)(?:\s+deck)?$/)?.[1];
  if (wish.missing) return { calls: [], answer: () => `You don't own any ${deckTitle(wish.missing!)} cards yet, so I left your deck as it is. They come from packs and the Card Shop. Say "what can I build?" to see what your cards can make now.` };
  const outsideAsk = !wish.around && (findOutside(t) || (aroundWord && aroundWord.length >= 4 && aroundWord.split(' ').some((x) => !STOP.has(x) && !INTENT.has(x)) ? (others ?? []).find((x) => ` ${x.flat} `.includes(` ${aroundWord} `))?.name : null));
  // a family that only exists outside Speed Duel ("an exodia deck")
  findOutside('');
  const gone = !wish.around && !outsideAsk ? t.split(' ').find((x) => x.length >= 4 && !STOP.has(x) && !INTENT.has(x) && !/^(deck|decks|build|make|give)$/.test(x) && ((others ?? []).filter((o) => ` ${o.flat} `.includes(` ${x} `)).length >= 2 || (x.length >= 5 && (others ?? []).some((o) => o.flat.startsWith(`${x} `)))) && !nameIndex().some((c) => ` ${c.flat} `.includes(` ${x} `) || ` ${flat(cd(c.name)?.desc ?? "")} `.includes(` ${x} `))) : null;
  if (gone) return { calls: [], answer: () => `${deckTitle(gone)} cards aren't in Speed Duel (Konami never printed them in a Speed Duel product), so I left your deck as it is. Say "what can I build?" for themes your cards can make.` };
  if (outsideAsk) return { calls: [], answer: () => `${outsideLine(outsideAsk)} Pick a Speed Duel card or theme to build around, like "build around Dark Magician" or "build me a Dragon deck".` };
  const carry = restyleKeep;
  restyleKeep = [];
  const keepCards = [
    ...cl.keep,
    ...carry,
    ...wish.arounds.flatMap((a, i, all) => aroundCards(a, w).slice(0, all.length > 1 ? 9 : 15)),
  ]
    .filter((n) => !wish.without.includes(cd(n)!.kind as Kind) && !avoid.has(n))
    .filter((n, i, all) => all.slice(0, i).filter((x) => x === n).length < COPIES)
    .slice(0, 18);
  // a kept card that is summoned with named pieces (Gate Guardian: Sanga, Kazejin and Suijin) brings them along
  for (const n of [...new Set(keepCards)]) {
    const summon = cd(n)?.desc.match(/must (?:first )?be special summoned[^.]*?by tributing[^.]*/i)?.[0];
    for (const m of summon ? summon.matchAll(/["“]([^"”]+)["”]/g) : []) if (isSpeedName(m[1]) && (!w.collection || (w.collection[m[1]] ?? 0) > 0) && !keepCards.includes(m[1])) keepCards.push(m[1]);
  }
  // Ritual cards only come in as part of the theme asked for (a stray Ritual Monster is a dead card)
  const ritualsOk = /\britual/.test(t);
  const drop = (n: string) => avoid.has(n) || (cd(n)?.kind === 'monster' && (wish.noRaces.includes(cd(n)!.race ?? '') || wish.noAttrs.includes(cd(n)!.attribute ?? ''))) || (wish.without.includes(cd(n)?.kind as Kind) && cd(n)?.sub !== 'Skill') || (!ritualsOk && cd(n)?.sub === 'Ritual' && !keepCards.includes(n));
  const collection = poolFor(w, drop) ?? w.collection;
  // a deck built around one card leans on that card's Type ("Dark Magician" -> Spellcasters)
  const keptMons = keepCards.map((n) => cd(n)).filter((c): c is CardInfo => c?.kind === 'monster');
  const mainRace = keptMons.length >= 4 ? [...new Set(keptMons.map((c) => c.race))].map((r) => [r, keptMons.filter((c) => c.race === r).length] as const).sort((a, b) => b[1] - a[1])[0] : null;
  // "the best deck I can make": the Types they own most of are tried too, and the strongest, most together deck wins
  const openBest = wish.best && wish.theme.kind === 'any' && !wish.around && !keepCards.length;
  const ownRaces = openBest
    ? RACES.map((r) => [r, speedCards().filter((c) => c.kind === 'monster' && c.race === r && (c.level ?? 0) <= 4 && !isExtraCard(c.name) && !drop(c.name) && (!collection || (collection[c.name] ?? 0) > 0)).length] as const)
        .filter((x) => x[1] >= 8)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
    : [];
  const themes: RandomTheme[] = openBest && ownRaces.length ? ownRaces.map(([r]) => ({ kind: 'race', value: r }) as RandomTheme) : wish.theme.kind === 'any' && mainRace && mainRace[0] && mainRace[1] * 10 >= keptMons.length * 6 ? [{ kind: 'race', value: mainRace[0] }, wish.theme] : [wish.theme];
  const tries = openBest && ownRaces.length ? 4 : wish.best ? 10 : 6;
  let best: { main: string[]; extra: string[]; skill: string | null; label: string; notes: string[] } | null = null;
  let bestTheme: RandomTheme = themes[0];
  let error = '';
  // a deck of one Type works with its Type's support and Skills
  const together = (main: string[]) => {
    const rs = main.map((n) => cd(n)).filter((c) => c?.kind === 'monster').map((c) => c!.race);
    return Math.max(0, ...rs.map((r) => rs.filter((x) => x === r).length)) * 25;
  };
  const score = (main: string[]) => deckScore(main) + (openBest ? together(main) : 0);
  for (let i = 0; i < tries * themes.length && !(best && i >= tries && !openBest); i++) {
    const th = themes[Math.floor(i / tries)];
    const r = randomSpeedDeck(collection, { rand: rng, size: wish.size, style: wish.style, theme: th, keep: keepCards.length ? { main: keepCards.filter((n) => !isExtraCard(n)), extra: keepCards.filter(isExtraCard), skill: null } : undefined });
    if ('error' in r) {
      error = r.error;
      continue;
    }
    if (!best || score(r.main) > score(best.main)) (best = r), (bestTheme = th);
  }
  // "the best deck": the strongest cards they own, picked one by one, also get a try (a starter's best beats a random pile)
  if (openBest) {
    const own = (n: string) => (collection ? Math.min(COPIES, collection[n] ?? 0) : COPIES);
    const pool = speedCards().filter((c) => own(c.name) > 0 && !isExtraCard(c.name) && c.sub !== 'Ritual' && !unplayableReason(c.name) && !drop(c.name) && limitStatus(c.name) === null && (c.kind === 'monster' || !quoted(c).length));
    const top = (f: (c: CardInfo) => boolean, n: number) => pool.filter(f).sort((a, b) => worth(b) - worth(a)).flatMap((c) => Array(own(c.name)).fill(c.name) as string[]).slice(0, n);
    const greedy = [...top((c) => c.kind === 'monster' && (c.level ?? 4) <= 4, 9), ...top((c) => c.kind === 'monster' && (c.level ?? 4) >= 5 && (c.level ?? 4) <= 6, 1), ...top((c) => c.kind === 'monster' && (c.level ?? 4) >= 7, 1), ...top((c) => c.kind === 'spell', 4), ...top((c) => c.kind === 'trap', 3)];
    for (let i = 0; i < 2; i++) {
      const r = randomSpeedDeck(collection, { rand: rng, size: wish.size, style: wish.style, theme: { kind: 'any' }, keep: { main: greedy, extra: [], skill: null } });
      if (!('error' in r) && (!best || score(r.main) > score(best.main))) (best = r), (bestTheme = { kind: 'any' });
    }
  }
  // a small collection may need its Ritual cards to reach 20 (the Pegasus starter): build with them rather than not at all
  if (!best && !ritualsOk) {
    const loose = poolFor(w, (n) => drop(n) && cd(n)?.sub !== 'Ritual') ?? w.collection;
    for (let i = 0; i < 4; i++) {
      const r = randomSpeedDeck(loose, { rand: rng, size: wish.size, style: wish.style, theme: themes[0], keep: keepCards.length ? { main: keepCards.filter((n) => !isExtraCard(n)), extra: keepCards.filter(isExtraCard), skill: null } : undefined });
      if (!('error' in r) && (!best || score(r.main) > score(best.main))) best = r;
    }
  }
  if (!best) return { calls: [], answer: () => `I couldn't build that one: ${(error || 'not enough cards').replace(/\s*Open packs.*$/, '').replace(/\.$/, '')}${wish.without.length ? ` (without ${wish.without.map((k) => `${k}s`).join(' or ')})` : ''}. Open packs in the Card Shop for more cards, or try a different theme.` };
  const b = best;
  // a Skill made for the theme beats a general one; a Skill for cards the deck doesn't run is no Skill at all
  const themeSkill = wish.around ? themedSkill([wish.around], w, null, b) : null;
  if (themeSkill) b.skill = themeSkill;
  else b.skill = skillPick({ ...w, deck: { ...w.deck, main: b.main, extra: b.extra, skill: null } }, null) ?? (b.skill && skillFits(b.skill, b) ? b.skill : null);
  // every card checked the way the editor adds them (a Skill can share a Limited group): what's refused is made up from the pool
  const ok: SpeedDeck = { ...w.deck, main: [], extra: [], skill: b.skill };
  for (const n of [...b.main, ...b.extra]) if (!whyCantAdd(ok, n, w.collection)) (isExtraCard(n) ? ok.extra : ok.main).push(n);
  if (ok.main.length < wish.size) {
    const f = fillPlan({ ...w, deck: ok }, wish.size, freshMemory(), '', null, drop);
    for (const x of ((f.calls[0]?.input as { add?: { name: string; count: number }[] } | undefined)?.add ?? [])) for (let i = 0; i < x.count; i++) ok.main.push(x.name);
  }
  // a Fusion goes in only with its materials in the Main Deck (Dark Paladin needs Buster Blader too)
  ok.extra = ok.extra.filter((n) => canMake(n, ok.main));
  // then the weakest picks go for better ones (steadier, stronger decks run to run)
  const themeRace = wish.theme.kind === 'race' ? wish.theme.value : openBest ? (bestTheme.kind === 'race' ? (bestTheme as { value: string }).value : null) : themes[0].kind === 'race' ? (themes[0] as { value: string }).value : null;
  b.main = polish(ok.main, ok.extra, w, new Set(keepCards), themeRace, drop, b.skill);
  // a Type deck gets its boss: a Dragon deck with no Blue-Eyes or Red-Eyes has no finisher
  if (themeRace && !b.main.some((n) => cd(n)?.kind === 'monster' && (cd(n)!.level ?? 0) >= 7)) {
    const own = (n: string) => (w.collection ? Math.min(COPIES, w.collection[n] ?? 0) : COPIES);
    const boss = speedCards()
      .filter((c) => c.kind === 'monster' && c.race === themeRace && (c.level ?? 0) >= 7 && (c.atk ?? 0) >= 2400 && !isExtraCard(c.name) && c.sub !== 'Ritual' && !unplayableReason(c.name) && !drop(c.name) && own(c.name) > 0 && !/cannot be normal summoned|must (first )?be special summoned/i.test(c.desc) && limitStatus(c.name) !== 'Forbidden')
      .sort((a, b) => (b.atk ?? 0) - (a.atk ?? 0))[0];
    if (boss) {
      const cut = [...b.main].filter((n) => cd(n)?.kind === 'monster' && !keepCards.includes(n) && !isNeeded(n, { ...ok, main: b.main })).sort((x, y) => wn(x, ok) - wn(y, ok)).slice(0, Math.min(2, own(boss.name)));
      const trial = { ...ok, main: [...b.main] };
      for (const n of cut) trial.main.splice(trial.main.indexOf(n), 1);
      for (let i = 0; i < cut.length; i++) if (!whyCantAdd(trial, boss.name, w.collection)) trial.main.push(boss.name);
      if (trial.main.length === b.main.length) b.main = trial.main;
    }
  }
  // last sweep: any spell or trap that would do nothing here goes for one that works
  for (let i = 0; i < 8; i++) {
    const cur: SpeedDeck = { ...ok, main: b.main, skill: b.skill };
    const dead = b.main.find((n) => cd(n) && deadFor(cd(n)!, cur) && !cl.keep.includes(n));
    if (!dead) break;
    const without = { ...cur, main: [...b.main] };
    without.main.splice(without.main.indexOf(dead), 1);
    // the same kind first, so the spell/trap balance holds
    const fits = (x: CardInfo) => !isExtraCard(x.name) && x.sub !== 'Ritual' && !drop(x.name) && (x.kind !== 'monster' || (x.level ?? 4) <= 4);
    const sub = candidates(w, without, (x) => fits(x) && x.kind === cd(dead)!.kind)[0] ?? candidates(w, without, fits)[0];
    if (!sub) break;
    b.main = [...without.main, sub.name];
  }
  // a deck needs some spells and traps: an all-monster pile has no removal or protection
  for (const kind of ['trap', 'spell'] as const) {
    if (wish.without.includes(kind) || banned.has(kind)) continue;
    const want = kind === 'trap' ? (wish.style === 'beatdown' ? 2 : 3) : 3;
    for (let i = 0; i < 4 && b.main.filter((n) => cd(n)?.kind === kind).length < want; i++) {
      const cur: SpeedDeck = { ...ok, main: b.main, skill: b.skill };
      const mons = b.main.filter((n) => cd(n)?.kind === 'monster' && !cl.keep.includes(n) && !keepCards.includes(n) && !isNeeded(n, cur));
      if (b.main.filter((n) => cd(n)?.kind === 'monster').length <= 10 || !mons.length) break;
      const weak = mons.sort((x, y) => wn(x, cur) - wn(y, cur))[0];
      const without = { ...cur, main: [...b.main] };
      without.main.splice(without.main.indexOf(weak), 1);
      const sub = candidates(w, without, (x) => x.kind === kind && !drop(x.name) && x.sub !== 'Ritual')[0];
      if (!sub) break;
      b.main = [...without.main, sub.name];
    }
  }
  // the optimizer: swaps until the checker's score stops climbing (cards asked for stay)
  {
    const fam = wish.around;
    const theme = /\bburn\b/.test(t) ? (c: CardInfo) => /inflicts? \d+ damage|inflict damage|damage equal to/i.test(c.desc) && !/inflicts? \d+ damage to you\b/i.test(c.desc)
      : wish.theme.kind === 'race' ? (c: CardInfo) => c.kind === 'monster' && c.race === (wish.theme as { value: string }).value
      : wish.theme.kind === 'attribute' ? (c: CardInfo) => c.kind === 'monster' && c.attribute === (wish.theme as { value: string }).value
      : fam ? (c: CardInfo) => ` ${flat(c.name)} `.includes(` ${fam} `) || ` ${flat(c.desc)} `.includes(` ${fam} `)
      : /\bburn\b/.test(t) ? (c: CardInfo) => /inflicts? \d+ damage|inflict damage/i.test(c.desc)
      : undefined;
    const done = optimize({ ...ok, main: b.main, extra: ok.extra, skill: b.skill }, w, new Set([...cl.keep, ...wish.arounds.length ? keepCards : []]), drop, theme);
    b.main = done.main;
    ok.extra = done.extra;
  }
  b.extra = ok.extra;
  // the cards changed since the Skill was picked: it must still fit the deck as built
  if (b.skill && !skillFits(b.skill, b)) b.skill = skillPick({ ...w, deck: { ...w.deck, main: b.main, extra: b.extra, skill: null } }, null);
  // how much of the theme made it in: a deck is only named after it when it really is one
  const fam = wish.around ? b.main.filter((n) => ` ${flat(n)} `.includes(` ${wish.around} `) || ` ${flat(cd(n)?.desc ?? '')} `.includes(` ${wish.around} `) || keepCards.includes(n)).length : 0;
  const themed = wish.theme.kind === 'race' ? b.main.filter((n) => cd(n)?.race === (wish.theme as { value: string }).value).length : wish.theme.kind === 'attribute' ? b.main.filter((n) => cd(n)?.attribute === (wish.theme as { value: string }).value).length : 0;
  const thin = (wish.around && (fam < 3 || fam < Math.min(6, keepCards.length))) || ((wish.theme.kind === 'race' || wish.theme.kind === 'attribute') && themed < 6);
  const themeName = wish.theme.kind === 'race' ? plural(wish.theme.value) : wish.theme.kind === 'attribute' ? wish.theme.value : '';
  const both = wish.arounds.length > 1 && !thin ? wish.arounds.map((a) => deckTitle(a)).join(' and ') : null;
  const name = called ? clip(deckTitle(called[1])) : both ? clip(wish.arounds.map((a) => deckTitle(a)).join(' & ')) : (thin ? 'Mixed deck' : wish.aroundCard ? bare(wish.aroundCard) : wish.around ? deckTitle(wish.around) : themeName ? (wish.theme.kind === 'attribute' ? `${themeName} deck` : themeName) : wish.style === 'beatdown' ? 'Rush deck' : wish.style === 'control' ? 'Control deck' : 'Chat deck').slice(0, 20);
  const label = both ? `${both} deck` : thin ? 'mixed deck' : wish.aroundCard ? `${bare(wish.aroundCard)} deck` : wish.around ? `${deckTitle(wish.around)} deck` : themeName ? `${themeName} deck` : b.label;
  const have = wish.around ? fam : themed;
  const anyOwned = wish.around ? keepCards.length : wish.theme.kind === 'race' || wish.theme.kind === 'attribute' ? speedCards().filter((c) => c.kind === 'monster' && (wish.theme.kind === 'race' ? c.race === (wish.theme as { value: string }).value : c.attribute === (wish.theme as { value: string }).value) && (!w.collection || (w.collection[c.name] ?? 0) > 0)).length : 1;
  if (!anyOwned) return { calls: [], answer: () => `You don't own any ${wish.around ? deckTitle(wish.around) : themeName} cards yet, so I left your deck as it is. They come from packs and the Card Shop. Say "what can I build?" to see what your cards can make now.` };
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
      const kept = cl.keep.length ? ` Kept ${listOf([...new Set(cl.keep)])}.` : '';
      const left = avoid.size ? ` Left out ${listOf([...avoid])}.` : '';
      return `Built a${/^[aeiou]/i.test(label) ? 'n' : ''} ${label} from ${w.collection ? 'your cards' : 'every Speed Duel card'}${wish.without.length ? ` with no ${wish.without.map((k) => `${k}s`).join(' or ')}` : ''}. ${describe(b.main, b.skill)}${famLine}${thinNote}${style}${notes.length ? ` ${notes.join(' ')}` : ''}${missing ? ` Not ready yet: ${missing}.` : ''} ${kept}${left} Say "make it stronger", "more traps" or "add 2 of something" to tweak it.`.replace(/\s{2,}/g, ' ');
    },
  };
}

// ---------- edits ----------
function strongerPlan(w: ChatWorld, most = 4, withSkill = true): Plan {
  const d = w.deck;
  if (!d.main.length && !d.extra.length) return buildPlan('build my strongest deck', w);
  if (d.main.length < MAIN_MIN) return fillPlan(w, MAIN_MIN, freshMemory(), `It needs ${MAIN_MIN} Main Deck cards first, so I added`);
  // the optimizer first: swaps that raise the deck checker's score, the deck's Type or family kept
  if (withSkill) {
    // only a real theme is kept: 6+ cards of a family or 8+ monsters of a Type
    const fam0 = deckFamily(d);
    const fam = fam0 && d.main.filter((n) => ` ${flat(n)} `.includes(` ${fam0} `) || ` ${flat(cd(n)?.desc ?? '')} `.includes(` ${fam0} `)).length >= 6 ? fam0 : null;
    const race0 = deckRace(d);
    const race = race0 && d.main.filter((n) => cd(n)?.kind === 'monster' && cd(n)!.race === race0).length >= 8 ? race0 : null;
    const attrs = new Map<string, number>();
    for (const n of d.main) if (cd(n)?.kind === 'monster' && cd(n)!.attribute) attrs.set(cd(n)!.attribute!, (attrs.get(cd(n)!.attribute!) ?? 0) + 1);
    const attr = [...attrs].sort((a, b) => b[1] - a[1]).find((x) => x[1] >= 8)?.[0];
    const theme = fam ? (c: CardInfo) => ` ${flat(c.name)} `.includes(` ${fam} `) || ` ${flat(c.desc)} `.includes(` ${fam} `) : race ? (c: CardInfo) => c.kind === 'monster' && c.race === race : attr ? (c: CardInfo) => c.kind === 'monster' && c.attribute === attr : undefined;
    const before = deckIssues(d, theme);
    const done = optimize(d, w, new Set(protect), () => false, theme, Math.max(most * 3, 12));
    const outs = diffNames(d.main, done.main);
    const ins = diffNames(done.main, d.main);
    const xOut = diffNames(d.extra, done.extra);
    const skill = !d.skill || !skillFits(d.skill, done) ? skillPick({ ...w, deck: { ...done, skill: null } }, null) : null;
    const after = deckIssues({ ...done, skill: skill ?? d.skill }, theme);
    if (outs.length || xOut.length || (skill && skill !== d.skill)) {
      const fixed = before.issues.filter((x) => !after.issues.includes(x));
      return {
        calls: [{ name: 'edit_deck', input: { remove: [...counts(outs), ...counts(xOut)], add: counts(ins), ...(skill && skill !== d.skill ? { skill } : {}) } }],
        answer: (rs) => {
          const refused = refusedOf(rs[0] ?? '');
          const pairs = outs.map((o, i) => `${o} → ${ins[i]}`);
          return `${pairs.length ? `Swapped ${pairs.join('; ')}.` : ''}${xOut.length ? ` Took ${listOf(xOut)} out of the Extra Deck (nothing here can summon ${xOut.length > 1 ? 'them' : 'it'}).` : ''}${skill && skill !== d.skill ? ` Skill: ${bare(skill)}, which fits it better.` : ''}${fixed.length ? ` That fixes: ${fixed.join('; ')}.` : ''}${after.issues.length ? ` Still: ${after.issues.join('; ')}.` : ''}${refused ? ` Couldn't do all of it: ${refused}.` : ''}`.trim();
        },
      };
    }
    if (!before.issues.length) return { calls: [{ name: 'view_deck', input: {} }], answer: () => `This deck already uses the best cards you own for it: no dead cards, the Skill fits and the mix is right. Win duels and open packs for stronger cards, then ask again.` };
    return { calls: [{ name: 'view_deck', input: {} }], answer: () => `I couldn't find a swap from your cards that makes it better. What holds it back: ${before.issues.join('; ')}. Packs or the Card Shop can fill that gap.` };
  }
  const inDeckCards = [...new Set(d.main)].map((n) => cd(n)).filter((c): c is CardInfo => !!c && !isExtraCard(c.name));
  const weak = inDeckCards.filter((c) => c.kind === 'monster').sort((a, b) => worth(a, d) - worth(b, d));
  const race = deckRace(d);
  const swaps: { out: string; in: string }[] = [];
  let work: SpeedDeck = { ...d, main: [...d.main] };
  for (const c of weak) {
    if (swaps.length >= most) break;
    const without = { ...work, main: [...work.main] };
    without.main.splice(without.main.indexOf(c.name), 1);
    if (needed(c, without) || protect.has(c.name)) continue;
    // never a bigger Tribute cost than the card it replaces
    const better = candidates(w, without, (x) => x.kind === 'monster' && x.sub !== 'Ritual' && (x.level ?? 4) <= Math.max(4, c.level ?? 4) && (!race || c.race !== race || x.race === race) && !isExtraCard(x.name) && worth(x, without) > worth(c, without) + 250 && !swaps.some((s) => s.in === x.name))[0];
    if (!better) continue;
    swaps.push({ out: c.name, in: better.name });
    work = { ...without, main: [...without.main, better.name] };
  }
  // too many monsters that need Tributes: the weakest of them go for the best ones that don't
  const bigs = () => work.main.filter((n) => cd(n)?.kind === 'monster' && cd(n)?.sub !== 'Ritual' && (cd(n)?.level ?? 0) >= 5);
  const lighter: string[] = [];
  for (const n of [...bigs()].sort((a, b) => wn(a, work) - wn(b, work))) {
    if (bigs().length <= 4 || swaps.length >= most + 3) break;
    if (protect.has(n)) continue;
    const without = { ...work, main: [...work.main] };
    without.main.splice(without.main.indexOf(n), 1);
    if (needed(cd(n)!, without)) continue;
    const lowOf = (onRace: boolean, floor: number) => candidates(w, without, (x) => x.kind === 'monster' && x.sub !== 'Ritual' && !isExtraCard(x.name) && (x.level ?? 4) <= 4 && (!onRace || !race || x.race === race) && (x.atk ?? 0) >= floor)[0];
    const low = lowOf(true, 1400) ?? lowOf(false, 1200);
    if (low) lighter.push(low.name);
    if (!low) continue;
    swaps.push({ out: n, in: low.name });
    work = { ...without, main: [...without.main, low.name] };
  }
  let skill: string | null | undefined;
  if (!d.skill && withSkill) skill = skillPick(w, null);
  if (!swaps.length && !skill) return { calls: [{ name: 'view_deck', input: {} }], answer: () => `This deck already uses the strongest cards you own for its slots. ${tipsFor(d).join(' ') || 'Win duels and open packs to get stronger cards, then ask again.'}` };
  return {
    calls: [{ name: 'edit_deck', input: { remove: swaps.map((s) => ({ name: s.out, count: 1 })), add: swaps.map((s) => ({ name: s.in, count: 1 })), ...(skill ? { skill } : {}) } }],
    answer: (rs) => {
      const line = (s: { out: string; in: string }) => `${s.out} → ${s.in} (${cd(s.in)?.atk ?? ''} ATK)`;
      const up = swaps.filter((s) => !lighter.includes(s.in));
      const down = swaps.filter((s) => lighter.includes(s.in));
      const refused = refusedOf(rs[0] ?? '');
      return `${up.length ? `Swapped in stronger monsters: ${up.map(line).join('; ')}.` : ''}${down.length ? ` It had too many monsters that need Tributes, so: ${down.map(line).join('; ')}, which need none.` : ''}${skill ? ` Added the Skill ${bare(skill)}.` : ''}${refused ? ` Couldn't do: ${refused}.` : ''}`.trim();
    },
  };
}

/** An owned, playable Skill made for one of these names ("toon" -> It's a Toon World!). */
function themedSkill(words: string[], w: ChatWorld, not: string | null = null, deck?: { main: string[]; extra: string[] }): string | null {
  // with a deck to fit: only Skills whose named cards it runs ("White Veil" isn't a Blue-Eyes card)
  const ok = skillCards().filter((x) => x.name !== not && getSkill(x.name) && (!w.collection || (w.collection[x.name] ?? 0) > 0) && limitStatus(x.name) !== 'Forbidden' && (!deck || !deck.main.length || skillFits(x.name, deck)));
  for (const q of words) {
    // named for it first, then one whose text names it; never one built for cards it doesn't mention ("Obelisk the Tormentor")
    const hit = ok.find((x) => ` ${flat(bare(x.name))} `.includes(` ${q} `)) ?? ok.find((x) => ` ${flat(x.desc)} `.includes(` ${q} `) && quoted(x).every((y) => flat(y).includes(q) || q.includes(flat(y))));
    if (hit) return hit.name;
  }
  return null;
}

/** The name word most of the deck shares ("harpie", "toon"), if any. */
function deckFamily(d: SpeedDeck): string | null {
  const m = new Map<string, number>();
  for (const n of new Set(d.main)) for (const x of new Set(flat(n).split(' '))) if (x.length >= 4 && !STOP.has(x) && !/^(dragon|warrior|magician|knight|lady|king|queen|monster|soldier|beast)$/.test(x)) m.set(x, (m.get(x) ?? 0) + 1);
  const top = [...m].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= 3 ? top[0] : null;
}

/** The Skill the deck maker would choose for this deck, other than `not`; one made for the deck's family first. */
function skillPick(w: ChatWorld, not: string | null): string | null {
  const d = w.deck;
  const fam = deckFamily(d);
  const themed = fam ? themedSkill([fam], w, not, d) : null;
  if (themed) return themed;
  const fits = (s: string) => skillFits(s, d);
  // a Skill made for cards this deck runs (or its Type) beats a general one
  const usable = skillCards().filter((s) => s.name !== not && getSkill(s.name) && (!w.collection || (w.collection[s.name] ?? 0) > 0) && limitStatus(s.name) !== 'Forbidden');
  const scored = usable.map((s) => [s.name, skillScore(s.name, d)] as const).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
  if (scored.length) return pick(scored.filter((x) => x[1] === scored[0][1]).map((x) => x[0]));
  const tried = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const collection = poolFor(w, (n) => n === not || tried.has(n)) ?? w.collection;
    const r = randomSpeedDeck(collection, { rand: rng, size: Math.max(MAIN_MIN, d.main.length), keep: { main: d.main, extra: d.extra, skill: null } });
    if ('error' in r || !r.skill || r.skill === not) continue;
    if (fits(r.skill)) return r.skill;
    tried.add(r.skill);
  }
  return usable.find((s) => !tried.has(s.name) && fits(s.name))?.name ?? null;
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

/** A Skill that names cards ("White Veil", "Obelisk the Tormentor") only fits a deck that runs them. */
function skillFits(s: string, d: { main: string[]; extra: string[] }): boolean {
  // "this card's name is always treated as Necrovalley" is about itself, not what the deck needs
  const c = cd(s) ?? ({ desc: '', name: s } as CardInfo);
  const q = quoted({ ...c, desc: c.desc.replace(/treated as ["“][^"”]+["”]/g, '') });
  // a card named exactly is enough; an archetype ("HERO", "Ancient Gear") needs 3 of its monsters
  const all = [...d.main, ...d.extra];
  const meets = (x: string) => all.includes(x) || all.filter((n) => cd(n)?.kind === 'monster' && n.includes(x)).length >= (cd(x) ? 1 : 3);
  // a Skill built on named monsters ("Vilepawn Archfiend", "Amazoness Queen") needs one of them, not just their family
  const exact = q.filter((x) => cd(x)?.kind === 'monster');
  if (exact.length && !exact.some((x) => all.includes(x)) && !q.filter((x) => !cd(x)).some((x) => all.filter((n) => cd(n)?.kind === 'monster' && n.includes(x)).length >= 6)) return false;
  // a lock ("you can only Summon "Crystal" monsters and Dragon monsters"): most of the deck's monsters must pass it
  if (!cd(s) || /\byou lose the duel\b/i.test(c.desc)) return false;
  // "Level 7 or higher Dinosaur monsters", "an Insect equipped with an Equip Card", "face-up Reptile monsters": the deck must have them
  const lvl = c.desc.match(/\blevel (\d+) or higher ([A-Za-z-]+) monsters?\b/i);
  if (lvl && [...RACES, ...ATTRS].includes(lvl[2]) && all.filter((n) => cd(n)?.kind === 'monster' && (cd(n)!.level ?? 0) >= Number(lvl[1]) && (cd(n)!.race === lvl[2] || cd(n)!.attribute === lvl[2])).length < 2) return false;
  if (/\bequipped with an equip card\b/i.test(c.desc) && d.main.filter((n) => cd(n)?.sub === 'Equip').length < 2) return false;
  const sk = needsOf(c);
  if (sk.kinds.length && !sk.kinds.some((x) => d.main.filter((n) => cd(n)?.kind === 'monster' && (cd(n)!.race === x || cd(n)!.attribute === x)).length >= 5)) return false;
  const lock = c.desc.match(/\bfor the rest of the duel, you cannot (?:normal |special )?summon any monsters?,? except (.+?) monsters?\b/i) ?? c.desc.match(/\byou can only (?:normal |special )?summon(?:\/set)? (.+?) monsters?\b/i) ?? c.desc.match(/\byou cannot (?:normal |special )?summon(?:\/set)? monsters?,? except (.+?) monsters?\b/i) ?? c.desc.match(/\byou cannot (?:normal |special )?summon(?:\/set)? non-([A-Za-z-]+) monsters?\b/i);
  if (lock) {
    const names = [...lock[1].matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1]);
    const types = [...RACES, ...ATTRS].filter((x) => new RegExp(`\\b${x}\\b`).test(lock[1]));
    const mons = d.main.filter((n) => cd(n)?.kind === 'monster');
    const ok = mons.filter((n) => names.some((x) => n.includes(x)) || types.some((x) => cd(n)!.race === x || cd(n)!.attribute === x));
    if (mons.length && ok.length < mons.length * 0.8) return false;
  }
  // "Activate this Skill while you control "Hyozanryu"": that card is a must
  const gate = c.desc.match(/\b(?:activate|use) this skill (?:while|if|when) you control ["“]([^"”]+)["”]|^(?:while|if) you control ["“]([^"”]+)["”]/i);
  const must = gate?.[1] ?? gate?.[2];
  if (must && !all.includes(must) && !all.some((n) => (cd(n)?.desc ?? '').includes(`treated as "${must}"`))) return false;
  // "Fusion Summon 1 "Ancient Gear" Fusion Monster from your Extra Deck": needs one there
  if (/\bfusion summon\b[^.]*\bfusion monster from your extra deck\b/i.test(c.desc) && !d.extra.some((n) => cd(n)?.sub === 'Fusion')) return false;
  return (!q.length || q.some(meets)) && !typeClash(c.desc, d);
}
/** card text that asks for a Type or Attribute ("banish 1 DARK monster", "non-Dragon monsters") the deck barely runs */
/** what a card's text asks of the deck's Types, read once per text: costs/locks ([kind, how many]) and Type-only buffs */
const clashCache = new Map<string, { costs: [string, number][]; buffs: string[] }>();
const CLASH_RE = [...RACES, ...ATTRS].map((x) => {
  const k = x.replace(/-/g, '[- ]');
  return [x, new RegExp(`\\bnon-${k}\\b|\\b(banish|tribute|discard|send|reveal|control|target|special summon|shuffle)\\s+(1|a|an|one|2|two|3|three|up to \\d|any number of)?\\s*(face-up\\s+)?(level \\d+ (or (lower|higher) )?)?${k}(-Type)? (normal )?monsters?\\b`, 'i')] as const;
});
function clashOf(desc: string) {
  let hit = clashCache.get(desc);
  if (!hit) {
    const costs: [string, number][] = [];
    for (const [x, re] of CLASH_RE) {
      const m = desc.match(re);
      // a cost of 2 or more ("banish 2 DARK monsters") needs a deck mostly of them
      if (m) costs.push([x, /^(2|two|3|three)$/i.test(m[2] ?? '') ? 6 : 5]);
    }
    const buff = desc.match(/\ball ([A-Za-z, -]+?) monsters(?: on the field| you control)? gain\b/i);
    const buffs = buff ? [...RACES, ...ATTRS].filter((x) => new RegExp(`\\b${x}\\b`).test(buff[1])) : [];
    hit = { costs, buffs };
    clashCache.set(desc, hit);
  }
  return hit;
}
function typeClash(desc: string, d: { main: string[]; extra: string[] }): boolean {
  const { costs, buffs } = clashOf(desc);
  if (!costs.length && !buffs.length) return false;
  const mons = d.main.map((n) => cd(n)).filter((c): c is CardInfo => c?.kind === 'monster');
  if (!mons.length) return false;
  const count = (x: string) => mons.filter((m) => m.race === x || m.attribute === x).length;
  // a cost or a lock: "banish 1 DARK monster", "you cannot Summon non-Dragon monsters"
  if (costs.some(([x, need]) => count(x) < need)) return true;
  // a boost for some Types only: worth nothing when the deck runs none of them
  return buffs.length > 0 && buffs.every((x) => count(x) < 5);
}

/** a heads-up when the Skill asked for is made for cards this deck doesn't run */
function skillWarn(s: string, w: ChatWorld): string {
  const d = w.deck;
  if (!d.main.length || skillFits(s, d)) return '';
  const better = skillPick(w, s);
  return ` Heads up: it's made for cards this deck barely runs, so it may do little here.${better ? ` ${bare(better)} fits this deck better.` : ''}`;
}

/** How well a Skill suits a deck: cards it names that the deck runs, and the deck's Type in its text. */
function skillScore(s: string, d: SpeedDeck): number {
  const c = cd(s);
  if (!c) return -1;
  const names = [...new Set([...d.main, ...d.extra])];
  const q = [...new Set(quoted({ ...c, desc: c.desc.replace(/treated as ["“][^"”]+["”]/g, '') }))];
  const hits = q.filter((x) => names.some((n) => n === x || (cd(n)?.kind === 'monster' && n.includes(x)))).length;
  if ((q.length && !hits) || typeClash(c.desc, d) || !skillFits(s, d)) return -1;
  const race = deckRace(d);
  const raceHit = race && new RegExp(`\\b${race}\\b`, 'i').test(c.desc) ? 1 : 0;
  return hits * 2 + raceHit;
}

/** The deck's main monster Type, when most of its monsters share one (fills and swaps stay on it). */
function deckRace(d: SpeedDeck): string | null {
  const main = d.main.map((n) => cd(n)).filter((c): c is CardInfo => c?.kind === 'monster');
  const mons = main.length >= 4 ? main : [...main, ...d.extra.map((n) => cd(n)).filter((c): c is CardInfo => c?.kind === 'monster')];
  if (!mons.length) return null;
  const by = new Map<string, number>();
  for (const c of mons) if (c.race) by.set(c.race, (by.get(c.race) ?? 0) + 1);
  const top = [...by].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] * 2 >= mons.length && (top[1] >= 4 || mons.length < 4) ? top[0] : null;
}

/** Tops the Main Deck up to `size` with cards that fit, never the ones just cut. */
function fillPlan(w: ChatWorld, size: number, mem: Memory, why = '', notKind: Kind | null = null, drop?: (n: string) => boolean): Plan {
  const d = w.deck;
  const gone = new Set([...mem.removed, ...(mem.cut ?? [])]);
  const race = deckRace(d);
  const pool = poolFor(w, (n) => (gone.has(n) && !d.main.includes(n)) || (!!notKind && cd(n)?.kind === notKind) || (banned.has(cd(n)?.kind as Kind) && !d.main.includes(n)) || (!!cd(n) && !d.main.includes(n) && deadFor(cd(n)!, d)) || (!!drop && drop(n) && !d.main.includes(n)) || (cd(n)?.sub === 'Ritual' && !d.main.includes(n)) || (/\btoken\b/i.test(cd(n)?.desc ?? '') && cd(n)?.kind !== 'monster'));
  // a few tries, keeping the one that fits the deck best
  let added: string[] = [];
  let bestScore = -Infinity;
  let error = '';
  for (let i = 0; i < 5 && !(i === 4 && added.length); i++) {
    // on the deck's Type first; one plain try if that can't fill it
    const r = randomSpeedDeck(pool, { rand: rng, size, ...(race && i < 4 ? { theme: { kind: 'race', value: race } as RandomTheme } : {}), keep: { main: d.main, extra: d.extra, skill: d.skill } });
    if ('error' in r) {
      error = r.error;
      continue;
    }
    const a = diffList(d.main, r.main).slice(0, Math.max(0, size - d.main.length));
    const sc = a.reduce((x, n) => x + wn(n, { ...d, main: [...d.main, ...a] }), 0);
    if (sc > bestScore) (bestScore = sc), (added = a);
  }
  if (!added.length && error) return { calls: [], answer: () => `I couldn't fill it: ${error}` };
  if (!added.length) return { calls: [], answer: () => `You have no more cards that fit${w.collection ? '; get more from packs or the Card Shop' : ''}.` };
  return { calls: [{ name: 'edit_deck', input: { add: counts(added) } }], answer: () => `${why || `Filled the deck to ${d.main.length + added.length} with`} ${listOf(added)}.` };
}

/** A cut that leaves the deck too small to duel, then a refill back to the minimum (never with what was cut, or the kind cut). */
function refill(cut: Plan, w: ChatWorld, notKind: Kind | null, drop?: (n: string) => boolean, size = MAIN_MIN): Plan {
  const edit = cut.calls[0].input as { remove: { name: string; count: number }[] };
  const r = runTool(w, 'edit_deck', edit);
  if (!r.deck) return cut;
  if (r.deck.main.length >= size) return cut;
  const fill = fillPlan({ ...w, deck: r.deck }, size, { added: [], removed: edit.remove.map((x) => x.name) }, `To keep it at ${size} cards I added`, notKind, drop);
  if (!fill.calls.length) return { calls: cut.calls, answer: (rs) => `${cut.answer(rs)} The deck needs ${MAIN_MIN} cards to duel and you have nothing else that fits; say "undo" to put them back.` };
  return { calls: [...cut.calls, ...fill.calls], answer: (rs) => `${cut.answer(rs.slice(0, 1))} ${fill.answer(rs.slice(1))}` };
}

/** Takes out what can't be in the deck (left the game, not Speed Duel, too many copies, Limited, not owned, over 30) and fills back to 20. Null when it's already legal. */
function repairPlan(w: ChatWorld): Plan | null {
  const d = w.deck;
  const good: SpeedDeck = { ...d, main: [], extra: [], skill: null };
  const out: string[] = [];
  // an Extra Deck monster sitting in the Main Deck moves over
  const moved: string[] = [];
  for (const [n, inMain] of [...d.main.map((n) => [n, true] as const), ...d.extra.map((n) => [n, false] as const)]) {
    // a full Main Deck isn't a reason to throw a card out: the weakest go below, past 30
    const why = cd(n) ? whyCantAdd(good, n, w.collection) : 'gone';
    if (!why || /is full/.test(why)) {
      (isExtraCard(n) ? good.extra : good.main).push(n);
      if (inMain && isExtraCard(n)) moved.push(n);
    } else out.push(n);
  }
  const trimmed = good.main.length > MAIN_MAX ? [...good.main].sort((a, b) => wn(a, good) - wn(b, good)).slice(0, good.main.length - MAIN_MAX) : [];
  for (const n of trimmed) good.main.splice(good.main.indexOf(n), 1);
  // Skills have their own registry (getSkill), not card effects
  const badSkill = !!d.skill && (!cd(d.skill) || !getSkill(d.skill) || limitStatus(d.skill) === 'Forbidden' || (!!w.collection && !(w.collection[d.skill] ?? 0)));
  if (!out.length && !trimmed.length && !badSkill && !moved.length) return null;
  const fill = good.main.length < MAIN_MIN ? fillPlan({ ...w, deck: good }, MAIN_MIN, { added: [], removed: out }) : null;
  const add = (fill?.calls[0]?.input as { add?: { name: string; count: number }[] } | undefined)?.add ?? [];
  const input: Record<string, unknown> = { remove: counts([...out, ...trimmed, ...moved]), ...(add.length || moved.length ? { add: [...add, ...counts(moved)] } : {}), ...(badSkill ? { skill: null } : {}) };
  return {
    calls: [{ name: 'edit_deck', input }],
    answer: (rs) => {
      const left = Number(rs[0]?.match(/\bMain (\d+)/)?.[1] ?? 0);
      return `First I made it legal: took out ${out.length ? `${listOf(out)} (not allowed here: gone from the game, not a Speed Duel card, past ${COPIES} copies, Limited or not owned)` : ''}${out.length && trimmed.length ? ', and ' : ''}${trimmed.length ? `${trimmed.length} of the weakest cards to get down to ${MAIN_MAX}` : ''}${badSkill ? `${out.length || trimmed.length ? ', and ' : ''}the Skill ${bare(d.skill!)}, which can't be used` : ''}${moved.length ? `${out.length || trimmed.length || badSkill ? ', and ' : ''}moved ${listOf(moved)} to the Extra Deck` : ''}.${add.length ? ` To keep it at ${MAIN_MIN} I added ${listOf(add.flatMap((x) => Array(x.count).fill(x.name)))}.` : ''} It has ${left || good.main.length + add.reduce((a, x) => a + x.count, 0)} cards now. Ask again for "make it stronger" to upgrade it.`;
    },
  };
}

/** Cuts the weakest cards down to `size`. */
function trimPlan(d: SpeedDeck, size: number, mem: Memory = freshMemory()): Plan {
  // cards asked for by name stay, and cards other cards need; what a fill just added is fair game
  const keep = (n: string) => (mem.wanted ?? []).includes(n) || protect.has(n) || isNeeded(n, d);
  const order = [...d.main].sort((a, b) => Number(keep(a)) - Number(keep(b)) || wn(a, d) - wn(b, d));
  // keep the mix: cut from whichever kind is furthest over its share (about 11 monsters, 5 spells, 4 traps in 20)
  const share: Record<Kind, number> = { monster: 0.55, spell: 0.25, trap: 0.2 };
  const left = [...order];
  const out: string[] = [];
  while (out.length < d.main.length - size && left.length) {
    const count = (k: Kind) => left.filter((n) => cd(n)?.kind === k).length;
    const kinds = (['monster', 'spell', 'trap'] as Kind[]).filter((k) => left.some((n) => cd(n)?.kind === k && !keep(n)));
    const k = kinds.sort((a, b) => count(b) - share[b] * size - (count(a) - share[a] * size))[0];
    const i = k ? left.findIndex((n) => cd(n)?.kind === k && !keep(n)) : 0;
    out.push(...left.splice(Math.max(0, i), 1));
  }
  return { calls: [{ name: 'edit_deck', input: { remove: counts(out) } }], answer: () => `Trimmed it to ${size} cards by cutting the weakest: ${listOf(out)}.` };
}

/** More (or fewer) of one kind: swaps the weakest cards of the other kinds for the best of this kind. */
function kindShift(w: ChatWorld, kind: Kind, by: number, why?: string, only: (c: CardInfo) => boolean = () => true, grow = false, exact = false): Plan {
  const d = w.deck;
  const isKind = (n: string) => cd(n)?.kind === kind && !isExtraCard(n);
  if (by < 0) {
    // spare cards first; then support cards, which the player asked to cut by kind (never ones they named)
    const spare = [...d.main].filter((n) => isKind(n) && !isNeeded(n, d) && !protect.has(n)).sort((a, b) => wn(a, d) - wn(b, d));
    const out = [...spare, ...[...d.main].filter((n) => isKind(n) && isNeeded(n, d) && !protect.has(n)).sort((a, b) => wn(a, d) - wn(b, d))].slice(0, -by);
    if (!out.length) return { calls: [], answer: () => (d.main.some(isKind) ? `The only ${kind}s here are ones you asked for by name. Say one's name to take it out.` : `There are no ${kind}s to cut.`) };
    const rest = { ...d, main: [...d.main] };
    for (const n of out) rest.main.splice(rest.main.indexOf(n), 1);
    const fill: string[] = [];
    // "remove 2 traps" takes them out (refilling only below the legal size); "fewer traps" swaps them
    const refills = exact ? Math.max(0, MAIN_MIN - rest.main.length) : out.length;
    for (let i = 0; i < refills; i++) {
      const c = candidates(w, { ...rest, main: [...rest.main, ...fill] }, (x) => x.kind !== kind && x.sub !== 'Ritual' && !isExtraCard(x.name) && fill.filter((n) => n === x.name).length < 2, w.deck.main.filter((n) => cd(n)?.kind === kind))[0];
      if (c) fill.push(c.name);
    }
    // a loose "fewer traps" never leaves the deck unable to duel: only as many go as can be replaced
    if (!exact && d.main.length >= MAIN_MIN && d.main.length - out.length + fill.length < MAIN_MIN) {
      out.splice(Math.max(0, fill.length + d.main.length - MAIN_MIN));
      fill.splice(out.length);
      if (!out.length) return { calls: [], answer: () => `You have nothing that fits to put in place of the ${kind}s, so I left them. Say "remove 2 ${kind}s" to cut some anyway.` };
    }
    const short = d.main.length - out.length + fill.length < MAIN_MIN;
    return {
      calls: [{ name: 'edit_deck', input: { remove: counts(out), add: counts(fill) } }],
      answer: () => `Cut ${out.length} ${kind}${out.length > 1 ? 's' : ''} (${listOf(out)})${fill.length ? ` and put in ${listOf(fill)}` : ''}.${short ? ` It has ${d.main.length - out.length + fill.length} cards now and needs ${MAIN_MIN} to duel; you have nothing else that fits, so say "undo" or add cards by name.` : ''}`,
    };
  }
  const work = { ...d, main: [...d.main] };
  const outs: string[] = [];
  if (work.main.length + by > MAIN_MAX || (work.main.length >= MAIN_MIN && !grow)) {
    // keep the size: make room from the weakest cards of the other kinds (never ones asked for by name)
    const want = grow ? work.main.length + by - MAIN_MAX : by;
    const held = (n: string) => !!hold && cd(n)?.kind === hold;
    // the room comes from the kind the deck has most to spare: monsters stay at 11 or more when they can
    const per = (k: string) => work.main.filter((n) => cd(n)?.kind === k).length;
    // the card whose loss hurts the deck checker's score least goes first
    const loss = new Map<string, number>();
    for (const n of new Set(work.main)) {
      const t2 = { ...work, main: [...work.main] };
      t2.main.splice(t2.main.indexOf(n), 1);
      loss.set(n, deckQuality(work) - deckQuality(t2));
    }
    const bias = (n: string) => (loss.get(n) ?? 0) * 4 + (cd(n)?.kind === 'monster' ? (per('monster') <= 11 ? 2500 : 0) : per(cd(n)?.kind ?? '') >= 7 ? -600 : 0);
    let others = [...work.main].filter((n) => !isKind(n) && !held(n) && !isNeeded(n, work) && !protect.has(n)).sort((a, b) => bias(a) - bias(b));
    // short of spare cards: combo pieces the player never named can go too, before the deck grows
    // a deck at 11 monsters or fewer gives up spare spells, then combo spells, before its monsters
    const lowMons = per('monster') <= 11 && kind !== 'monster';
    const monsLast = lowMons ? others.filter((n) => cd(n)?.kind === 'monster') : [];
    if (lowMons) others = others.filter((n) => cd(n)?.kind !== 'monster');
    if (others.length < want) others = [...others, ...[...work.main].filter((n) => !isKind(n) && !held(n) && isNeeded(n, work) && !protect.has(n) && (!lowMons || cd(n)?.kind !== 'monster')).sort((a, b) => wn(a, d) - wn(b, d))];
    others = [...others, ...monsLast];
    for (const n of others.slice(0, want)) (outs.push(n), work.main.splice(work.main.indexOf(n), 1));
  }
  const ins: string[] = [];
  for (let i = 0; i < by; i++) {
    const c = candidates(w, { ...work, main: [...work.main, ...ins] }, (x) => isKind(x.name) && only(x) && ins.filter((n) => n === x.name).length < 2)[0];
    if (!c) break;
    ins.push(c.name);
  }
  if (!ins.length) return { calls: [], answer: () => `You have no more ${kind}s that can go in${w.collection ? '; get more from packs or the Card Shop' : ''}.` };
  // keeping the size: only as many in as could come out
  if (d.main.length + ins.length - outs.length > MAIN_MAX) ins.splice(MAIN_MAX - d.main.length + outs.length);
  if (!ins.length) return { calls: [], answer: () => `The deck is full (${MAIN_MAX}). Name a card to take out first.` };
  const outsUsed = outs.slice(0, ins.length);
  const grew = d.main.length + ins.length - outsUsed.length;
  return {
    calls: [{ name: 'edit_deck', input: { remove: counts(outsUsed), add: counts(ins) } }],
    answer: () => `${why ? `For ${why}: added` : 'Added'} ${listOf(ins)}${outsUsed.length ? ` in place of ${listOf(outsUsed)}` : ''}.${grew > d.main.length && d.main.length >= MAIN_MIN && !grow ? ` The rest of the deck is cards you asked for or combos need, so it's ${grew} cards now.` : ''}`,
  };
}

/** "swap the traps for spells": every card of one kind (or `n` of them) out, the best of the other kind in. */
function swapKinds(w: ChatWorld, from: Kind, to: Kind, n: number | null, only: (c: CardInfo) => boolean = () => true, label = `${to}s`): Plan {
  const d = w.deck;
  const out = [...d.main].filter((x) => cd(x)?.kind === from && !isExtraCard(x)).sort((a, b) => wn(a, d) - wn(b, d)).slice(0, n ?? 99);
  if (!out.length) return { calls: [], answer: () => `There are no ${from}s in the deck to swap.` };
  const rest = { ...d, main: [...d.main] };
  for (const x of out) rest.main.splice(rest.main.indexOf(x), 1);
  const ins: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const c = candidates(w, { ...rest, main: [...rest.main, ...ins] }, (x) => x.kind === to && only(x) && !isExtraCard(x.name) && ins.filter((m) => m === x.name).length < 2)[0];
    if (!c) break;
    ins.push(c.name);
  }
  // only as many out as can come in: a swap never leaves the deck short
  if (!ins.length) return { calls: [], answer: () => `You have no more ${label} that fit${w.collection ? '; get more from packs or the Card Shop' : ''}, so I left the ${from}s in.` };
  const outs = [...out].sort((a, b) => wn(a, d) - wn(b, d)).slice(0, ins.length);
  return {
    calls: [{ name: 'edit_deck', input: { remove: counts(outs), add: counts(ins) } }],
    answer: () => `Swapped ${outs.length} ${from}${outs.length > 1 ? 's' : ''} (${listOf(outs)}) for ${listOf(ins)}.${outs.length < out.length ? ` You only had ${ins.length} ${to}${ins.length === 1 ? '' : 's'} that fit, so ${out.length - outs.length} ${from}${out.length - outs.length === 1 ? '' : 's'} stayed.` : ''}`,
  };
}

/** What to add from the collection, and what to chase in packs. Changes nothing. */
function suggestPlan(w: ChatWorld, mem?: Memory): Plan {
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
  if (mem) mem.offer = owned.length ? { add: owned.map((c) => c.name) } : null;
  return {
    calls: [{ name: 'view_deck', input: {} }],
    answer: () =>
      `${owned.length ? `${w.collection ? 'From your cards, the' : 'The'} best fits for this deck are ${listOf(owned.map((c) => c.name))}. Say "add those" to put them in for the weakest cards, or "add" and a name for one.` : 'Your best cards are already in this deck.'}${chase.length ? ` Worth chasing in packs or the Card Shop: ${listOf(chase.map((c) => c.name))}.` : ''}`,
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

function cardInfo(name: string, w: ChatWorld, judge = false): Plan {
  const c = cd(name)!;
  const v = worth(c, w.deck);
  const extra = isExtraCard(name);
  const mats = c.sub === 'Fusion' ? [...(c.desc.split(/\n|\. /)[0] ?? '').matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1]) : [];
  // a Fusion: what it takes to summon it, and whether this deck has it
  const howTo = c.sub === 'Fusion' ? `\n\nTo summon it: activate Polymerization and send ${mats.length ? listOf(mats) : 'its materials'} from your hand or field to the Graveyard. It goes in the Extra Deck.${mats.length ? ` This deck ${mats.every((m) => w.deck.main.some((x) => x === m || x.startsWith(`${m} `))) ? 'runs' : "doesn't run"} all of the materials${w.deck.main.includes('Polymerization') ? '' : ' and has no Polymerization'}.` : ''}` : '';
  const summonNote = extra ? '' : c.kind === 'monster' && /cannot be normal summoned|must (first )?be special summoned/i.test(c.desc) ? ", but it can't be Normal Summoned, so it needs the card that brings it out" : c.kind === 'monster' && (c.level ?? 4) >= 5 ? `, but it costs ${(c.level ?? 4) >= 7 ? '2 Tributes' : 'a Tribute'}` : '';
  const verdict = !judge || c.sub === 'Skill' ? '' : extra ? `\n\nIn Speed Duel it's ${v >= 2200 ? 'a strong' : v >= 1200 ? 'a solid' : 'a weak'} Extra Deck pick if you can summon it.` : `\n\nIn Speed Duel it's ${v >= 2200 ? 'a strong pick' : v >= 1500 ? 'a solid pick' : v >= 900 ? 'an okay pick' : 'a weak pick'}${summonNote}.`;
  const owned = w.collection ? (w.collection[name] ?? 0) : 3;
  const here = c.sub === 'Skill' ? (w.deck.skill === name ? 1 : 0) : w.deck.main.filter((n) => n === name).length + w.deck.extra.filter((n) => n === name).length;
  const lim = limitStatus(name);
  const why = c.sub === 'Skill' ? (getSkill(name) ? null : "isn't playable in the game yet") : unplayableReason(name);
  return {
    calls: [{ name: 'get_cards', input: { names: [name] } }],
    answer: () =>
      `${bare(c.name)}: ${stats(c)}. ${c.desc.replace(/\s*\n\s*/g, ' ')}\n\n${w.collection ? `You own ${owned}${owned ? '' : ' (get it from packs or the Card Shop)'}` : 'Any copies allowed in this deck'}, ${here} in this deck.${lim ? ` ${lim} on the ${LIMITED_LIST_NAME}.` : ''}${why ? ` It ${why.startsWith('its') ? `can't be used yet: ${why}` : why}.` : ''}${howTo}${verdict}`,
  };
}

function comparePlan(a: string, b: string): Plan {
  const x = cd(a)!;
  const y = cd(b)!;
  const line = (c: CardInfo) => `${bare(c.name)}: ${stats(c)}. ${short(c.desc, 180)}`;
  let verdict = '';
  if (x.kind === 'monster' && y.kind === 'monster') {
    const [hi, lo] = (x.atk ?? 0) >= (y.atk ?? 0) ? [x, y] : [y, x];
    const trib = (c: CardInfo) => ((c.level ?? 4) >= 7 ? 2 : (c.level ?? 4) >= 5 ? 1 : 0);
    verdict = (hi.atk ?? 0) === (lo.atk ?? 0) ? `They hit equally hard (${hi.atk} ATK)${trib(hi) !== trib(lo) ? `, but ${trib(hi) < trib(lo) ? hi.name : lo.name} is easier to summon (${Math.min(trib(hi), trib(lo)) || 'no'} Tribute${Math.min(trib(hi), trib(lo)) === 1 ? '' : 's'} instead of ${Math.max(trib(hi), trib(lo))})` : ''}.` : `${hi.name} hits harder (${hi.atk} vs ${lo.atk} ATK)${(hi.level ?? 0) > (lo.level ?? 0) && (hi.level ?? 0) >= 5 ? `, but needs ${(hi.level ?? 0) >= 7 ? '2 Tributes' : 'a Tribute'}` : ''}.`;
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

const OVERVIEW = `Speed Duel is a faster Yu-Gi-Oh!: each duelist has 4000 Life Points, a ${MAIN_MIN} to ${MAIN_MAX} card deck and starts with 4 cards. Each turn you draw, Normal Summon one monster (Level 5+ need Tributes), set or play Spells and Traps, then attack with your monsters. Beat the opponent's monster's ATK to destroy it; attack with nothing in the way to hit their Life Points. Get them to 0 to win. You also bring one Skill, a once-per-duel power. Say "build me a deck" and I'll make you one to start with.`;
const RULES: [RegExp, string][] = [
  [/\b(how (does|do) (speed duels?|this game|the game|yugioh|yu gi oh|dueling|duels?|it all) (work|go)|how (do i|to|do you) (play|duel)( speed duels?| yugioh| this game)?$|im new|i am new|new (to|at) (this|the game|yugioh|speed duel|dueling)|teach me|the basics|beginner)\b/, OVERVIEW],
  [/\btraps?\b.*\b(same turn|turn i set|turn (it is|its|you|i) set|right away|immediately|when i set|turn i play)\b|\b(activate|use|play) (a |my )?traps? (the )?(same|right|turn)\b/, "No: a Trap has to be Set face-down first, and you can activate it from your opponent's turn on (or your next turn). Quick-Play Spells work the same way when Set, but can be played straight from your hand on your own turn."],
  [/\b(difference|different)\b.*\bspells?\b.*\btraps?\b|\bspells?\b.*\b(vs|versus|or)\b.*\btraps?\b.*\b(difference|different)\b/, 'Spells are played from your hand on your turn and work right away. Traps have to be Set face-down first and can be activated from the next turn on, even on your opponent\'s turn, so they answer what the opponent does.'],
  [/\bquick ?play\b|\bnormal spells?\b.*\b(difference|vs|versus|or)\b|\b(continuous|field|equip) spells?\b.*\b(what|how|difference|mean)\b|\b(what|how)\b.*\b(continuous|field|equip) spells?\b/, 'Normal Spells work once and go to the Graveyard, on your turn only. Quick-Play Spells can also be used on your opponent\'s turn if you Set them first. Continuous and Field Spells stay on the field and keep working; an Equip Spell sits on one monster and changes it.'],
  [/\bsummon\b.*\b(first turn|turn 1|turn one)\b/, 'Yes: you can Normal Summon (and Special Summon) on your first turn. Going first, you just can\'t attack or draw that turn.'],
  [/\b(draw|draws)\b.*\b(per turn|each turn|every turn|a turn)\b|\bhow many cards (do i|you) draw\b/, 'You draw 1 card at the start of each turn (the player going first skips their first draw). You start the duel with 4 cards.'],
  [/\b(deck|cards) (runs?|run|ran) out\b|\bno cards left\b|\bcant draw\b|\bdeck out\b|\bdecked out\b/, 'If you have to draw and your deck is empty, you lose the duel. In a 20-card deck that rarely happens, but card-drawing effects make it faster.'],
  [/\bflip summons?\b|\bflip effects?\b|\bwhat (is|does) flip\b/, 'A Flip Summon turns your face-down Defense Position monster face-up into Attack Position on your turn (not the turn you Set it). FLIP effects trigger when a monster is flipped face-up, whether you flip it or it\'s attacked.'],
  [/\b(counter traps?|continuous traps?|normal traps?)\b/, 'Normal Traps work once. Continuous Traps stay on the field and keep working. Counter Traps answer another card as it is played, and only other Counter Traps can respond to them.'],
  [/\b(attack|battle)\b.*\b(first turn|turn 1|turn one)\b|\bfirst turn\b.*\b(attack|battle)\b/, 'The player going first can\'t attack on their first turn, and skips their first draw. From the second turn on, both players can attack.'],
  [/\b(attack|battle)\b.*\b(turn|same turn|right after)\b.*\b(summon|summoned|play|played)\b/, 'Yes: a monster can attack the turn it is summoned. The only turn nobody attacks is the very first turn of the duel.'],
  [/\b(cop(y|ies)|how many of|4 of|four of|same card|of the same)\b/, `You can run up to ${COPIES} copies of a card (fewer if the ${LIMITED_LIST_NAME} limits it), and only as many as you own unless it's an Anything goes deck.`],
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
  [/\b(normal )?summon (twice|two|2|more than once|again)\b|\bhow many (normal )?summons\b/, 'You get one Normal Summon (or Set) per turn. Special Summons from card effects don\'t count toward it, so you can make as many of those as your cards allow.'],
  [/\bwhats? legal\b|\bis (it|this|my deck) legal\b/, `A legal Speed Duel deck has ${MAIN_MIN} to ${MAIN_MAX} Main Deck cards, up to ${EXTRA_MAX} Extra Deck cards, 3 copies at most, nothing Forbidden, and the ${LIMITED_LIST_NAME} groups respected. The deck editor's top line says "Ready to duel" when yours is.`],
  [/\bspecial summon|\bnormal summon\b.*\b(and|vs|or|difference)\b/, 'A Normal Summon is your one free summon from the hand each turn (Level 5 and up need Tributes). A Special Summon comes from a card effect, a Fusion, a Ritual or the Extra Deck, and you can make as many as your cards allow.'],
  [/\b(tribute|level 5|level 7|summon)\b/, 'Level 5 and 6 monsters need 1 Tribute, Level 7 and up need 2. Only 3 Monster Zones means big monsters cost a lot, so 2 to 4 is plenty.'],
];

/** rules asked plainly, checked before anything else so a card or deck reading can't steal them */
const QUICK_RULES: [RegExp, string][] = [
  [/^(?:whats |what is |the )?(?:max|maximum|min|minimum|biggest|smallest) (?:deck )?size\b|^(?:whats |what is )?(?:the )?deck size (?:limit|rule)s?\b|\bhow (?:big|small) can (?:a|my) deck be\b/, `A Main Deck holds ${MAIN_MIN} to ${MAIN_MAX} cards, plus up to ${EXTRA_MAX} in the Extra Deck and 1 Skill.`],
  [/\bspell(?: and| &|\/)? ?trap zones?\b|\bhow many (?:spell|trap|backrow) zones?\b|\bhow many (?:spells|traps) can i (?:set|have out)\b/, 'You have 3 Spell & Trap Zones (plus a Field Zone), so you can have at most 3 Spells or Traps set or face-up at once.'],
  [/\bstarting hand\b|\bopening hand\b|\bhand size\b|\bhow many cards (?:do (?:i|you|we)|you) (?:start|begin) with\b/, 'You start with 4 cards in hand. You draw 1 each turn (the player going first skips their first draw), and discard down to 6 at the End Phase.'],
  [/\bdraw\b.*\b(?:turn 1|turn one|first turn)\b|\b(?:turn 1|first turn)\b.*\bdraw\b/, "The player going first doesn't draw on their first turn. The second player draws as normal, and from then on everyone draws 1 card each turn."],
  [/\b(?:deck|cards) (?:runs?|ran) out\b|\bdeck out\b|\bdecked out\b|\bno cards left (?:in my deck|to draw)\b/, 'If you have to draw and your deck is empty, you lose the duel.'],
  [/\bdamage step\b/, 'The Damage Step is the part of an attack where the monsters\' ATK/DEF are compared and damage is dealt. Only a few cards (like ATK boosters that say "during the Damage Step") can be used then.'],
  [/\bpiercing\b|\bwhat (?:is|does) pierce\b/, 'Piercing damage: when a monster with it attacks a Defense Position monster with lower DEF, your opponent takes the difference as damage anyway.'],
  [/\bquick effects?\b/, "A Quick Effect is a monster effect you can use on either player's turn, even in response to your opponent, like a Trap."],
  [/\bskills?\b.*\b(?:every turn|each turn|once per (?:turn|duel)|how often)\b/, "It depends on the Skill: its text says how often. Many work once per Duel, some once per turn, and some need a condition first (like your LP being low)."],
  [/\b(?:chain|respond|negate|stop)\b.*\bskills?\b|\bskills?\b.*\b(?:be (?:chained|negated|stopped)|chain to)\b/, "No: Skills can't be chained to, negated or stopped by cards. They just resolve."],
  [/^(?:can (?:i|you)|how do (?:i|you)) chain\b|\bwhat (?:is|are) (?:a )?chains?\b|\bhow do chains work\b/, 'A Chain is when cards respond to each other: you can answer a card with a Trap or Quick-Play Spell, and the newest card resolves first, back down the chain.'],
  [/\bextra deck\b.*\b(?:zones?|anywhere|where)\b|\bwhere do(?:es)? (?:fusions?|extra deck monsters) go\b/, 'Speed Duel has no Extra Monster Zone or Link rules: a Fusion (or other Extra Deck monster) goes in any of your 3 Monster Zones.'],
];

const CANT: [RegExp, (w: ChatWorld, t: string) => string][] = [
  [/\b(duel|play|fight|battle) (against |with |vs )?(me|you)\b|\blets (duel|play)\b/, () => "I can't duel, but your deck is ready for one: start a duel from the Speed Duel menu (Solo, Ranked or a friend). I'm here for building and questions."],
  [/\b(gems?(?! knight)|coins?|chips?|money|currency|free packs?|more packs|get packs|buy packs|unlock)\b|\b(get|earn|find|buy|unlock|collect) (more |new |better |stronger )?cards\b/, () => 'Duel Chips come from winning duels, Duelist Requests and Card Legends; spend them on packs and crafting in the Card Shop. New cards show up here as soon as you own them.'],
  [/\b(export|share|send|copy|download|save) (this |my |the )?deck\b|\bdeck code\b/, () => 'Your decks save on this phone by themselves and back up with your duelist profile, so you can use them on any phone you sign in on. There is no deck code to export.'],
  [/\b(draw|get|open with|start with)\b.*\b(first|every time|always|in my opening|in my hand)\b/, (w, t) => {
    const n = findCards(t, w.deck)[0]?.name;
    const k = n ? w.deck.main.filter((x) => x === n).length : 0;
    return `Decks are shuffled every duel, so I can't set the order. ${n ? `More copies is the best you can do: you run ${k} ${bare(n)}${k < COPIES ? `; say "add ${COPIES - k} ${bare(n)}" for ${COPIES}` : ', the most allowed'}, and a 20-card deck draws it most often.` : 'Running 3 copies in a 20-card deck makes a card show up most often.'}`;
  }],
];

/** The Fusions this deck has the materials for (each material named in the deck), and "add" puts some in with Polymerization. */
function fusionPlan(w: ChatWorld, add: boolean, n: number | null): Plan {
  const d = w.deck;
  const fus = speedCards()
    .filter((c) => c.sub === 'Fusion' && !unplayableReason(c.name))
    .filter((c) => canMake(c.name, d.main) && (!w.collection || (w.collection[c.name] ?? 0) > 0))
    .sort((a, b) => (b.atk ?? 0) - (a.atk ?? 0));
  const noPoly = !!w.collection && !d.main.includes('Polymerization') && !(w.collection['Polymerization'] ?? 0);
  if (fus.length && noPoly) return { calls: [], answer: () => `This deck has the materials for ${listOf(fus.slice(0, 4).map((c) => c.name))}, but you don't own Polymerization yet, so none of them can be summoned. Look for it in packs or the Card Shop.` };
  if (!fus.length) return { calls: [], answer: () => 'This deck has no Fusion it can make: a Fusion needs its listed materials in the deck. Build around a Fusion monster ("build around Flame Swordsman") to get one with its materials.' };
  if (!add) return { calls: [], answer: () => `With these cards you can Fusion Summon ${listOf(fus.slice(0, 6).map((c) => c.name))}${d.main.includes('Polymerization') ? '' : ', once you add Polymerization'}. Say "add the fusions" to put them in.` };
  const room = Math.min(n ?? EXTRA_MAX, EXTRA_MAX - d.extra.length);
  const ins = fus.filter((c) => !d.extra.includes(c.name)).slice(0, room).map((c) => c.name);
  if (!ins.length) return { calls: [], answer: () => (room <= 0 ? `The Extra Deck is full (${EXTRA_MAX}).` : 'The Fusions this deck can make are already in.') };
  const poly = d.main.includes('Polymerization') ? [] : [{ name: 'Polymerization', count: 1 }];
  return { calls: [{ name: 'edit_deck', input: { add: [...counts(ins), ...poly] } }], answer: (rs) => `Added ${listOf(ins)} to the Extra Deck${poly.length ? ' and Polymerization to summon them' : ''}.${refusedOf(rs[0] ?? '') ? ` ${refusedOf(rs[0])}.` : ''}` };
}

const KIND_ADVICE: Record<Kind, string> = {
  trap: "Traps are your defence on the opponent's turn; 3 to 6 is usual in a 20-card deck.",
  spell: 'Spells are your removal and plays; 4 to 7 is usual in a 20-card deck.',
  monster: '11 to 13 monsters is usual in a 20-card deck, so you always have something to summon.',
};

const HELP = 'I can build and change this deck from your cards. Try: "build me a Dragon deck", "make an aggressive DARK deck", "build around Harpie Lady", "make it stronger", "add 2 Kuriboh and a Sangan", "swap the traps for spells", "make it 25 cards", "pick a different Skill", "explain my deck", "is this deck good?", "what should I add?" or "what does Dark Magician do?"';

const EXPLICIT_BUILD = /\b(build|create|construct|new deck|another deck|different deck|fresh deck|start a deck)\b|\b(make|give|get)( me)?( a| an| another| some)? (\w+ ){0,4}deck\b/;
/** how a new ask in the same message starts */
const PART_START = /^(build|create|construct|give|start|add|put|remove|take|cut|drop|swap|replace|get rid|include|throw|lose|delete|call it|name it|rename|use|give it|make|pick|choose|change|switch|fill|explain|rate|show|is|are|what|whats|how|why|which|does|do|tell|undo)\b/;
const THIS_DECK = /\b(make|turn) (it|this|this deck|my deck|the deck)\b/;

/** cards the player asked for by name this chat: cuts, swaps and trims leave them alone */
let protect = new Set<string>();
/** the last message was split into parts */
let split = false;

/** Works out what one message asks for. A question or a remark ("I wish it was stronger") never edits. Exported for tests. */
/** builds are steady: the same ask on the same deck and cards gives the same deck */
let rng: () => number = Math.random;
function seeded(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let x = Math.imul(h ^ (h >>> 15), 1 | h);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function planFor(text: string, w: ChatWorld, mem: Memory = freshMemory(), part = false, whole = text): Plan {
  split = false;
  if (!part) rng = seeded(`${clean(text)}|${w.deck.main.join(',')}|${w.deck.extra.join(',')}|${Object.keys(w.collection ?? {}).length}|${Object.values(w.collection ?? {}).reduce((a, b) => a + b, 0)}`);
  // "leave the spells alone and add traps": that kind is held, and the rest of the message is the ask
  const leave = clean(text).match(new RegExp(`^(?:leave|keep|dont touch|dont change)\\s+(?:the |my |all the )?${KIND_RE}(?:\\s+(?:alone|as they are|the same|how they are))?\\s+(?:and|but|then|just)\\s+(.+)$`));
  if (leave) {
    hold = kindWord(leave[1]);
    try {
      return planFor(leave[2], w, mem, part, whole);
    } finally {
      hold = null;
    }
  }
  const plan = readAsk(text, w, mem, part, whole);
  // a message split in parts was judged part by part ("what does kuriboh do? add it")
  if (split && !part) return plan;
  const t = clean(text);
  const asking = /^(is|are|would|could|should|does|did|was|were|will|whats|what|how|why|who|where|when|do|can i|am i|have i)\b/.test(t) && !/^(do (it|that)|how about|what about|can i (add|put|get|have|swap|remove|take|throw|use|run) \w)/.test(t);
  const musing = /^(i wish|i think|i feel|i guess|i bet|i liked|i miss|i already|i have|ive|i got|i own|i had|my (friend|brother|sister|dad|mom|cousin|mate)|the deck (was|used to)|it (was|used to)|he|she|they|we)\b/.test(t) && !/^i (have|got) (to|an?|some) /.test(t);
  if ((asking || musing) && plan.calls.some((c) => c.name === 'edit_deck')) {
    const rule = asking ? RULES.find(([re]) => re.test(t)) : null;
    if (rule) return { calls: [], answer: () => rule[1] };
    const before = /\b(before|used to|was better|old deck|previous)\b/.test(t);
    const size = asking && /\b(2\d|30|\d+) cards?\b|\bbigger|smaller\b/.test(t);
    return {
      calls: [],
      answer: () =>
        before
          ? 'If you liked it better before, tap Undo on the change card (or say "undo"), and the deck goes back.'
          : size
            ? `${MAIN_MIN} cards is the strongest size: you draw your best cards most often. More cards only helps if you want room for a theme. Say "make it 25 cards" if you want that anyway.`
            : 'I haven\'t changed anything. If you want that, say it as a request, like "make it stronger" or "add 2 traps", and I\'ll do it with an Undo.',
    };
  }
  return plan;
}

function readAsk(text: string, w: ChatWorld, mem: Memory, part: boolean, whole: string): Plan {
  const raw = text.trim();
  const t = clean(raw);
  // an old save can hold cards or a Skill that left the game: plan as if they weren't there (a fix takes them out)
  const asSaved = w;
  if (w.deck.main.some((n) => !cd(n)) || w.deck.extra.some((n) => !cd(n)) || (w.deck.skill && !cd(w.deck.skill))) w = { ...w, deck: { ...w.deck, main: w.deck.main.filter((n) => cd(n)), extra: w.deck.extra.filter((n) => cd(n)), skill: w.deck.skill && cd(w.deck.skill) ? w.deck.skill : null } };
  // "is that skill good for this deck": a verdict, not the text
  if (/^(is|does|will|would|whats|how)\b/.test(t) && /\b(that|the|this|my) skill\b/.test(t) && /\b(good|fit|fits|work|right|ok|okay|any good)\b/.test(t) && w.deck.skill) {
    const d0 = w.deck;
    const fits = skillFits(d0.skill!, d0);
    const alt = skillPick(w, d0.skill);
    return { calls: [], answer: () => (fits ? `Yes: ${bare(d0.skill!)} fits this deck.${alt && skillScore(alt, d0) > skillScore(d0.skill!, d0) ? ` ${bare(alt)} could be a little better; say "use ${bare(alt)}" to try it.` : ''}` : `Not really: ${bare(d0.skill!)} is made for cards this deck barely runs.${alt ? ` ${bare(alt)} fits better; say "use ${bare(alt)}".` : ''}`) };
  }
  const quickRule = QUICK_RULES.find(([re]) => re.test(t));
  if (quickRule) return { calls: [], answer: () => quickRule[1] };
  // "don't add kuriboh", "I'll add it later, don't change anything yet": nothing changes
  if (/^(i )?(dont|do not|never|not|stop|quit|no need to|no dont)\s+(add|adding|put|putting|remove|removing|take|taking|change|changing|touch|cut|cutting|swap|build|do)\b|\b(not yet|dont change anything|dont touch (it|the deck|my deck)|didnt mean|did not mean)\b|^(leave it|leave it alone|leave it as it is|keep it|keep it as it is|wait|hold on|nevermind|never mind|nvm|forget it)$/.test(t)) return { calls: [], answer: () => "Okay, I'll leave the deck as it is. Tell me when you want a change." };
  // "not sure if i should cut the spells", "maybe remove those traps?", "i used to run 3 sangan": thinking aloud, not asking
  const hedge = t.match(/^(?:im |i am )?(?:not sure (?:if|whether)|maybe|perhaps|i used to|used to|i was thinking(?: of| about)?|thinking (?:of|about)|i wonder if|wondering if|i might|might|what if i|i could|should i maybe|i should probably|i should|i probably should|probably|i guess i should|i kinda want to|i kind of want to)\s+(.+)$/);
  const hedged = hedge?.[1].replace(/^(i should|we should|i|we|to|should)\s+/, '').replace(/^(should|could)\s+/, '');
  if (hedged && /^(add|put|remove|take|cut|swap|replace|run|use|play|make|change|drop|include|get rid|go)\b/.test(hedged)) {
    const ask = hedged.replace(/^(run|play) /, 'add ').replace(/^go /, 'make it ');
    return { calls: [], answer: () => `Say "${ask}" if you want that, and I'll do it with an Undo.${/\bused to\b/.test(t) ? '' : ' Or ask "is this deck good?" and I\'ll tell you what I\'d change.'}` };
  }
  const noMore = t.match(new RegExp(`^(?:no more|stop adding|dont add any more|no extra) ${KIND_RE}$`));
  if (noMore) return { calls: [], answer: () => `Okay, I won't add more ${noMore[1].replace(/s?$/, 's')}. Say "fewer ${noMore[1].replace(/s?$/, 's')}" if you want some cut.` };
  const d = w.deck;
  protect = new Set(mem.wanted ?? []);
  // the deck's namesake stays too: "remove the weakest monster" never cuts Red-Eyes from a Red-Eyes deck
  const named = flat(d.name);
  if (named.length >= 4 && !/^(chat deck|deck \d+|random \d+|test|mixed deck|rush deck|control deck)$/.test(named)) for (const n of d.main) if (flat(n).includes(named) || (named.length >= 6 && flat(n).startsWith(named.slice(0, -1)))) protect.add(n);
  // kinds the player ruled out ("i dont want any traps"): refills and swaps leave them out
  banned = new Set(mem.noKinds ?? []);
  const ban = t.match(new RegExp(`\\b(?:dont want|do not want|no|without|hate|zero|get rid of all|remove all|take out all|no more)\\s+(?:any\\s+)?(?:the\\s+|my\\s+)?${KIND_RE}(?:\\s+(?:and|or|either|nor)\\s+(?:no\\s+)?${KIND_RE})?`));
  if (ban && !/^(what|how|why|is|are|does|can|should)\b/.test(t)) for (const k of [ban[1], ban[2]].filter(Boolean)) banned.add(kindWord(k!)!);
  const unban = t.match(new RegExp(`\\b(?:add|more|put in|some)\\s+(?:\\d\\s+|a few\\s+|some\\s+)?${KIND_RE}`));
  if (unban) banned.delete(kindWord(unban[1])!);
  if (/\b(spells?|traps?|monsters?) either\b/.test(t)) banned.add(kindWord(t.match(/\b(spells?|traps?|monsters?) either\b/)![1])!);
  mem.noKinds = [...banned];
  // "fix my deck", "make it legal", "remove the fake cards", "make it stronger" on a deck that can't duel: make it legal first
  if (/^(fix|repair|make|clean|sort|remove|take|get rid|delete|improve|upgrade|tidy)\b/.test(t) && /\b(fix|repair|legal|illegal|fake|bad cards|broken|stronger|better|improve|clean (it )?up|sort (it )?out|upgrade|tidy)\b/.test(t)) {
    const rp = repairPlan(asSaved);
    if (rp) return rp;
  }
  // a card asked about becomes "it" for the next part or message ("what does kuriboh do and add 2 of it")
  const cardPlan = (n: string, ww: ChatWorld, judge = false) => ((mem.focus = n), cardInfo(n, ww, judge));
  // "yes", "do it", "add those": what was just suggested
  const offer = mem.offer;
  mem.offer = null;
  if (offer && /^(yes|yeah|yep|yup|ya|ye|sure|ok|okay|ok do it|do it|go ahead|go for it|please do|lets do it|lets go|do that|sounds good|add (those|them|that|it|these|all of them|em)|put (those|them|that|it) in|sure add (that|those|them)|use (that|it|that one|that skill)|equip (it|that|that skill|the skill)|put (that skill|it|that|the skill) on)$/.test(t)) {
    if (offer.skill) return offer.skill === d.skill ? { calls: [], answer: () => `${bare(offer.skill!)} is already this deck's Skill.` } : { calls: [{ name: 'edit_deck', input: { skill: offer.skill } }], answer: (rs) => (refusedOf(rs[0] ?? '') ? `Couldn't: ${refusedOf(rs[0])}.` : `Now using ${bare(offer.skill!)}.`) };
    if (offer.add?.length) {
      // in place of the weakest cards of the same kind, so the deck keeps its size
      const work = [...d.main];
      const out: string[] = [];
      for (const n of offer.add) {
        const k = cd(n)?.kind;
        const ace = [...d.main].filter((x) => cd(x)?.kind === 'monster').sort((a, b) => (cd(b)!.atk ?? 0) - (cd(a)!.atk ?? 0))[0];
        const pickWeak = (f: (x: string) => boolean) => work.filter((x) => f(x) && x !== ace && !protect.has(x) && !offer.add!.includes(x)).sort((a, b) => wn(a, d) - wn(b, d))[0];
        const weak = pickWeak((x) => cd(x)?.kind === k && !isNeeded(x, d)) ?? pickWeak((x) => !isNeeded(x, d)) ?? pickWeak((x) => cd(x)?.kind === k) ?? pickWeak(() => true);
        if (weak && d.main.length >= MAIN_MIN) (out.push(weak), work.splice(work.indexOf(weak), 1));
      }
      // a full deck only takes as many as could come out
      const adds = d.main.length >= MAIN_MIN ? offer.add.slice(0, out.length) : offer.add;
      mem.wanted = [...new Set([...(mem.wanted ?? []), ...adds])];
      if (!adds.length) return { calls: [], answer: () => 'Every card in this deck is one you asked for or a combo piece, so there was nothing to swap out. Say a card to take out first.' };
      return { calls: [{ name: 'edit_deck', input: { remove: counts(out), add: counts(adds) } }], answer: (rs) => `Added ${listOf(adds)}${out.length ? ` in place of ${listOf(out)}` : ''}.${refusedOf(rs[0] ?? '') ? ` Couldn't do all of it: ${refusedOf(rs[0])}.` : ''}` };
    }
  }
  if (/^\W*(thanks|thank you|thx|ty|cheers|nice|great|awesome|perfect|cool|ok|okay|good|love it|sweet)\b[\s\w]{0,12}\W*$/i.test(raw) && !/\b(add|remove|build|make|deck)\b/i.test(raw)) return { calls: [], answer: () => pick(["You're welcome! Ask me for any change.", 'Glad it helps. Want any more changes?', 'Any time. Say "is this deck good?" for a check-up.']) };
  if (/^(this|the|my|that|its|it is|thats|it|deck|this deck|looks|lookin|looking)\b[\w ]{0,20}\b(is|looks|lookin|looking|its|so)\s+(fire|lit|sick|goated|insane|amazing|awesome|great|nice|cool|perfect|beautiful|clean|good|so good|really good|crazy|crazy good|op|hard|nasty)$/.test(t) || /^(its|thats|this is) (fire|lit|sick|goated|insane|amazing|awesome)$/.test(t)) return { calls: [], answer: () => pick(['Glad you like it! Want me to rate it, or tweak anything?', 'Nice! Say "is this deck good?" for a full check-up, or ask for any change.', 'Thanks! It should hit hard. Ask me anything about it.']) };
  if (!t) return { calls: [], answer: () => (/\b(hi|hey|hello|yo|sup)\b/i.test(raw) ? `Hi! ${HELP}` : HELP) };
  if (/^(help|what can you do|what do you do|commands|how does this work|how do you work|there|everyone|again)$/.test(t)) return { calls: [], answer: () => (/^\W*(hi|hey|hello|yo|sup)\b/i.test(raw) ? `Hi! ${HELP}` : HELP) };
  // a Type on its own ("explain spellcaster", "spellcasters?")
  const typeOnly = t.match(/^(?:what is|whats|explain|tell me about|what are)?\s*(?:a |the )?([a-z -]+?)s?(?: type)?$/);
  const typeR = typeOnly && RACES.find((x) => flat(x) === typeOnly[1].replace(/ie$/, 'y'));
  if (typeR) {
    const here = d.main.filter((n) => cd(n)?.race === typeR).length;
    const own = speedCards().filter((c) => c.race === typeR && c.kind === 'monster' && (!w.collection || (w.collection[c.name] ?? 0) > 0)).length;
    return { calls: [], answer: () => `${typeR} is a monster Type. This deck runs ${here}, and you ${w.collection ? `own ${own} different` : 'can use all'} ${plural(typeR)}. Say "build me a ${typeR} deck" or "more ${plural(typeR)}".` };
  }

  // "what does it do", "tell me about that one": the card just talked about or put in
  if (/^(what does|whats|what is|tell me about|explain|how does) (it|that|that card|this card|that one|this one|she|he|her|him|they|them)( do| does| work)?$/.test(t)) {
    const it = mem.focus ?? (new Set(mem.added).size === 1 ? mem.added[0] : null);
    if (it && cd(it)) return cardPlan(it, w);
    if (mem.added.length) return { calls: [], answer: () => `I just put in ${listOf([...new Set(mem.added)])}. Ask about one by name, like "what does ${mem.added[0]} do?"` };
  }
  // "what does that trap do": the newest card of that kind talked about or put in
  const kindIt = t.match(new RegExp(`^(?:what does|whats|what is|tell me about|explain|how does) (?:that|this|the|the new) ${KIND_RE}(?: do| does| work)?$`));
  if (kindIt) {
    const k = kindWord(kindIt[1])!;
    const pickOf = [mem.focus, ...[...mem.added].reverse()].find((n): n is string => !!n && cd(n)?.kind === k);
    if (pickOf) return cardPlan(pickOf, w);
    return { calls: [], answer: () => `Which ${k}? Say its name, like "what does ${d.main.find((n) => cd(n)?.kind === k) ?? (k === 'trap' ? 'Mirror Force' : 'Pot of Greed')} do?"` };
  }
  // "which one did you remove", "what did you take out"
  if (/^(which|what)(?: ones?| cards?)? (?:did|have) (?:you|u) (?:just )?(remove|removed|take out|took out|cut|drop|dropped|swap out|replace)\b/.test(t)) return { calls: [], answer: () => (mem.removed.length ? `I took out ${listOf(mem.removed)}. Say "undo" to put ${mem.removed.length > 1 ? 'them' : 'it'} back.` : "I haven't taken anything out in this chat.") };
  if (/^(which|what)(?: ones?| cards?)? (?:did|have) (?:you|u) (?:just )?(add|added|put in)\b/.test(t)) return { calls: [], answer: () => (mem.added.length ? `I put in ${listOf(mem.added)}.` : "I haven't put anything in yet in this chat.") };
  // "list the deck", "show me my deck", "whats in my deck"
  if (/^(list|show|show me|read|see|view|whats in|what is in|what cards are in|what s in)( me)? (the|my|this) deck( list)?$|^(deck ?list|list it|show it|show me it|what do i have in (it|the deck|my deck))$/.test(t)) {
    if (!d.main.length) return { calls: [], answer: () => 'The deck is empty. Say "build me a deck" and I\'ll make one.' };
    const group = (k: Kind) => counts(d.main.filter((n) => cd(n)?.kind === k)).map((x) => (x.count > 1 ? `${x.count} ${x.name}` : x.name));
    return { calls: [{ name: 'view_deck', input: {} }], answer: () => `${d.main.length} cards. Monsters: ${group('monster').join(', ') || 'none'}. Spells: ${group('spell').join(', ') || 'none'}. Traps: ${group('trap').join(', ') || 'none'}.${d.extra.length ? ` Extra Deck: ${listOf(d.extra)}.` : ''}${d.skill ? ` Skill: ${bare(d.skill)}.` : ''}` };
  }
  // "add two more": more copies of the card just put in
  const moreCopies = t.match(/^(?:add|put in|throw in|give me)\s+(\d|one|two|three|an?other|another one|one more)\s*(?:more)?(?: of (?:those|them|it|that|that one|these))?(?: copies)?$/);
  const lastPut = mem.focus && cd(mem.focus)?.sub !== 'Skill' ? mem.focus : new Set(mem.added).size === 1 ? mem.added[0] : null;
  if (moreCopies && lastPut && /\bmore\b|\bof (those|them|it|that|these)\b|another/.test(t)) {
    const n = /^\d$/.test(moreCopies[1]) ? Number(moreCopies[1]) : /another|one/.test(moreCopies[1]) ? 1 : NUM[moreCopies[1]] ?? 1;
    return { calls: [{ name: 'edit_deck', input: { add: [{ name: lastPut, count: n }] } }], answer: (rs) => (refusedOf(rs[0] ?? '') ? `Couldn't: ${refusedOf(rs[0])}.` : `Added ${n} more ${lastPut}.`) };
  }
  // "add kuriboh" then "actually make that 3": copies of the card just put in
  const copiesOf = t.match(/^(?:actually |no )?make (?:that|it|them) (\d|one|two|three)(?: of (?:them|those|it|that))?(?: copies)?$/);
  const lastOne = mem.focus && cd(mem.focus)?.sub !== 'Skill' ? mem.focus : new Set(mem.added).size === 1 ? mem.added[0] : null;
  if (copiesOf && lastOne) {
    const want = /^\d$/.test(copiesOf[1]) ? Number(copiesOf[1]) : NUM[copiesOf[1]];
    const have = d.main.filter((n) => n === lastOne).length + d.extra.filter((n) => n === lastOne).length;
    if (want > COPIES) return { calls: [], answer: () => `${COPIES} copies is the most a deck can run.` };
    if (want === have) return { calls: [], answer: () => `It already has ${have} ${lastOne}.` };
    return { calls: [{ name: 'edit_deck', input: want > have ? { add: [{ name: lastOne, count: want - have }] } : { remove: [{ name: lastOne, count: have - want }] } }], answer: (rs) => `${refusedOf(rs[0] ?? '') ? `Couldn't: ${refusedOf(rs[0])}.` : `Now ${want} ${lastOne}.`}` };
  }
  if (/^how many (?:do i have|have i got|are there|are in(?: it| the deck| there)?|is there|in there)(?: now)?$/.test(t) && lastOne) {
    const have = d.main.filter((n) => n === lastOne).length + d.extra.filter((n) => n === lastOne).length;
    return { calls: [], answer: () => `There ${have === 1 ? 'is' : 'are'} ${have} ${lastOne} in this deck${w.collection ? `, and you own ${w.collection[lastOne] ?? 0}` : ''}.` };
  }
  // "remove all spells and traps": both kinds
  const twoKinds = t.match(new RegExp(`^(?:remove|take out|get rid of|cut|drop|delete)\\s+(?:all\\s+)?(?:of\\s+)?(?:the\\s+|my\\s+)?${KIND_RE}\\s+(?:and|&)\\s+(?:the\\s+|all\\s+)?${KIND_RE}$`));
  if (twoKinds && d.main.length) {
    const ks = [kindWord(twoKinds[1])!, kindWord(twoKinds[2])!];
    const these = d.main.filter((n) => ks.includes(cd(n)?.kind as Kind) && !isExtraCard(n));
    if (!these.length) return { calls: [], answer: () => `There are no ${ks.join('s or ')}s in this deck.` };
    return refill({ calls: [{ name: 'edit_deck', input: { remove: counts(these) } }], answer: () => `Took out all ${these.length}: ${listOf(these)}.` }, w, null);
  }
  // "replace all monsters under 1500 atk", "get rid of the low attack monsters": only the ones below the line, swapped for ones above it
  const under = t.match(/\b(?:monsters?|ones|cards?|guys)\s+(?:with\s+)?(?:under|below|less than|lower than|weaker than|smaller than)\s+(\d{3,4})\s*(?:atk|attack)?\b/) ?? (/\b(low|weak|small|tiny) (attack|atk) (monsters?|ones)\b|\blow atk\b|\bweak monsters\b/.test(t) ? ['', '1500'] : null);
  if (under && d.main.length && /\b(replace|swap|remove|take out|get rid of|cut|drop|lose|change|upgrade)\b/.test(t)) {
    const line = Number(under[1]);
    const outs = d.main.filter((n) => cd(n)?.kind === 'monster' && (cd(n)!.atk ?? 0) < line && !isExtraCard(n) && !protect.has(n) && !isNeeded(n, d) && cd(n)?.sub !== 'Ritual');
    if (!outs.length) return { calls: [], answer: () => `No monster here is under ${line} ATK${d.main.some((n) => cd(n)?.kind === 'monster' && (cd(n)!.atk ?? 0) < line) ? ' except ones you asked for or that combos need' : ''}.` };
    const rest = { ...d, main: [...d.main] };
    for (const n of outs) rest.main.splice(rest.main.indexOf(n), 1);
    const ins: string[] = [];
    for (let i = 0; i < outs.length; i++) {
      const c = candidates(w, { ...rest, main: [...rest.main, ...ins] }, (x) => x.kind === 'monster' && (x.atk ?? 0) >= line && (x.level ?? 4) <= 4 && !isExtraCard(x.name) && x.sub !== 'Ritual' && ins.filter((m) => m === x.name).length < 2)[0];
      if (!c) break;
      ins.push(c.name);
    }
    const removeOnly = /\b(remove|take out|get rid of|cut|drop|lose)\b/.test(t) && rest.main.length >= MAIN_MIN;
    const gone = removeOnly ? outs : [...outs].sort((a, b) => (cd(a)!.atk ?? 0) - (cd(b)!.atk ?? 0)).slice(0, ins.length);
    if (!gone.length) return { calls: [], answer: () => `You have no monsters with ${line}+ ATK that could go in, so I left the deck as it is.` };
    return { calls: [{ name: 'edit_deck', input: { remove: counts(gone), add: counts(removeOnly ? [] : ins) } }], answer: () => `Took out ${listOf(gone)} (under ${line} ATK)${!removeOnly && ins.length ? ` and put in ${listOf(ins)}` : ''}.${!removeOnly && gone.length < outs.length ? ` You only own ${ins.length} that fit, so the rest stayed.` : ''}` };
  }
  // "take out the amazoness cards": every card of that family
  const famOut = t.match(/^(?:take out|remove|cut|drop|get rid of|lose|delete)\s+(?:all\s+)?(?:of\s+)?(?:the\s+|my\s+)?([a-z][a-z -]{2,30}?)\s+(?:cards|monsters|stuff|ones)$/);
  if (famOut && !kindWord(famOut[1]) && d.main.length) {
    const q = flat(famOut[1]).replace(/s$/, '');
    const these = [...d.main, ...d.extra].filter((n) => ` ${flat(n)} `.includes(` ${q}`) || ` ${flat(n)} `.includes(` ${q}s `));
    if (these.length >= 2 || (these.length && !RACES.some((r) => flat(r) === q))) {
      const cut: Plan = { calls: [{ name: 'edit_deck', input: { remove: counts(these) } }], answer: () => `Took out ${listOf(these)}.` };
      return d.main.length - these.filter((n) => d.main.includes(n)).length < MAIN_MIN ? refill(cut, w, null, (n) => ` ${flat(n)} `.includes(` ${q}`)) : cut;
    }
  }
  // "only 1 dark magician": that many copies
  const onlyN = t.match(/^(?:only|just|keep only|keep just)\s+(\d|one|two|three)\s+(?:copy of |copies of |of )?(.+)$/);
  const onlyName = onlyN ? findCard(onlyN[2], 'cards', d) : null;
  if (onlyN && onlyName) {
    const want = /^\d$/.test(onlyN[1]) ? Number(onlyN[1]) : NUM[onlyN[1]];
    const have = d.main.filter((n) => n === onlyName).length + d.extra.filter((n) => n === onlyName).length;
    if (want === have) return { calls: [], answer: () => `It already has ${have} ${onlyName}.` };
    return { calls: [{ name: 'edit_deck', input: want > have ? { add: [{ name: onlyName, count: want - have }] } : { remove: [{ name: onlyName, count: have - want }] } }], answer: (rs) => (refusedOf(rs[0] ?? '') ? `Couldn't: ${refusedOf(rs[0])}.` : `Now ${want} ${onlyName}.`) };
  }
  // "i dont like the ritual stuff get rid of it": Ritual monsters and their Spells go
  if (/\b(dont want|do not want|dont like|no|without|get rid of|remove|take out|cut|hate|lose|ditch)\b.*\brituals?\s*(stuff|cards|things|monsters|spells|summons?)?\b/.test(t) && !/^(add|put|give|how|what|why|can|is)\b/.test(t) && d.main.length) {
    const rx = d.main.filter((n) => cd(n)?.sub === 'Ritual' && !protect.has(n));
    if (!rx.length) return { calls: [], answer: () => 'There are no Ritual cards in this deck.' };
    const cut: Plan = { calls: [{ name: 'edit_deck', input: { remove: counts(rx) } }], answer: () => `Took out the Ritual cards: ${listOf(rx)}.` };
    return d.main.length - rx.length < MAIN_MIN ? refill(cut, w, null, (n) => cd(n)?.sub === 'Ritual') : cut;
  }
  // "i dont want any fusion stuff": Fusions, Polymerization and what fetches it all go
  if (/\b(dont want|do not want|no|without|get rid of|remove|take out|cut|hate|lose|ditch)\b.*\bfusions?\s*(stuff|cards|things|monsters|spells|summons?)?$/.test(t) && !/^(add|put|give|how|what|why|can|is)\b/.test(t) && (d.extra.length || d.main.length)) {
    const fx = d.extra.filter((n) => cd(n)?.sub === 'Fusion');
    const fm = d.main.filter((n) => n === 'Polymerization' || (/"Polymerization"|fusion summon/i.test(cd(n)?.desc ?? '') && !protect.has(n)));
    if (!fx.length && !fm.length) return { calls: [], answer: () => 'There are no Fusion cards in this deck.' };
    const cut: Plan = { calls: [{ name: 'edit_deck', input: { remove: counts([...fx, ...fm]) } }], answer: () => `Took out the Fusion cards: ${listOf([...fx, ...fm])}.` };
    return fm.length && d.main.length - fm.length < MAIN_MIN ? refill(cut, w, null, (n) => n === 'Polymerization' || /"Polymerization"|fusion summon/i.test(cd(n)?.desc ?? '')) : cut;
  }
  // "less tribute monsters": big monsters out, the best ones that need no Tribute in
  if (/\b(less|fewer|lower|reduce|cut|no|not so many|too many|without)\b.*\b(tribute|big|high level|level 5|level 7|5 star|7 star|heavy)\s*(monsters?|ones|cards)?\b/.test(t) && !/^(how|what|why|is|are|does)\b/.test(t) && d.main.length) {
    const bigAll = [...d.main].filter((n) => cd(n)?.kind === 'monster' && (cd(n)!.level ?? 0) >= 5 && !isExtraCard(n) && cd(n)?.sub !== 'Ritual' && !(mem.wanted ?? []).includes(n));
    const bigs = [...bigAll.filter((n) => !protect.has(n) && !isNeeded(n, d)).sort((a, b) => wn(a, d) - wn(b, d)), ...bigAll.filter((n) => protect.has(n) || isNeeded(n, d)).sort((a, b) => wn(a, d) - wn(b, d))];
    const n = Math.min(bigs.length, /\bno\b|\bwithout\b/.test(t) ? bigs.length : Math.max(1, Math.min(3, bigs.length - 2)));
    if (!n) return { calls: [], answer: () => 'There are no Tribute monsters here I can swap (the ones left are ones you asked for or ones combos need).' };
    const out = bigs.slice(0, n);
    const rest = { ...d, main: [...d.main] };
    for (const x of out) rest.main.splice(rest.main.indexOf(x), 1);
    const ins: string[] = [];
    for (let i = 0; i < out.length; i++) {
      const c = candidates(w, { ...rest, main: [...rest.main, ...ins] }, (x) => x.kind === 'monster' && (x.level ?? 4) <= 4 && !isExtraCard(x.name) && x.sub !== 'Ritual' && ins.filter((m) => m === x.name).length < 2)[0];
      if (!c) break;
      ins.push(c.name);
    }
    if (!ins.length) return { calls: [], answer: () => "You have no more monsters that need no Tribute; they come from packs and the Card Shop." };
    const gone = out.slice(0, ins.length);
    return { calls: [{ name: 'edit_deck', input: { remove: counts(gone), add: counts(ins) } }], answer: () => `Swapped ${listOf(gone)} (${gone.length > 1 ? 'they need' : 'it needs'} Tributes) for ${listOf(ins)}, which you can summon straight from your hand.` };
  }
  // "take out the fusions"
  const exKind = t.match(/\b(?:remove|take out|cut|drop|get rid of|delete)\s+(?:all\s+)?(?:of\s+)?(?:the\s+|my\s+)?(fusions?|synchros?|xyz|xyzs|links?)\b/);
  if (exKind) {
    const sub = exKind[1].startsWith('fusion') ? 'Fusion' : exKind[1].startsWith('synchro') ? 'Synchro' : exKind[1].startsWith('xyz') ? 'Xyz' : 'Link';
    const these = d.extra.filter((n) => cd(n)?.sub === sub);
    if (!these.length) return { calls: [], answer: () => `There are no ${sub} monsters in the Extra Deck.` };
    return { calls: [{ name: 'edit_deck', input: { remove: counts(these) } }], answer: () => `Took out ${listOf(these)}.` };
  }

  // what the chat can't do, with where to do it
  const cant = CANT.find(([re]) => re.test(t));
  if (cant) return { calls: [], answer: () => cant[1](w, t) };

  // several edits in one message ("put in 3 dark magician girl and remove the elegant egotist"): each part in turn
  if (!part) {
    // sentences and commas first (cleaning drops the punctuation), joined back when the next bit isn't a new ask ("add kuriboh, 2 sangan")
    const chunks = raw.split(/[,.;!?]+(?=\s|$)/).map((c) => clean(c).replace(/^(and then|then|and|also|now|next|after that|plus)\s+(?=\w)/, '')).filter(Boolean);
    const merged: string[] = [];
    for (const c of chunks) if (merged.length && !PART_START.test(c)) merged[merged.length - 1] += ` ${c}`;
      else merged.push(c);
    const parts = merged.flatMap((c) => c.split(/\s*(?:\band then\b|\bthen\b|\band\b|\balso\b|\bplus\b)\s*(?=(?:add|put|remove|take|cut|drop|swap|replace|get rid|include|throw|lose|delete|call it|name it|rename|use|give it|make it|pick|choose|fill|change the skill|change skill|switch the skill|set the skill|switch to|is it good|is it any good|is that good)\b)/)).filter((x) => x.trim());
    // only when each part is its own ask ("is this deck good? add 2 sangan"), not "my deck has too many traps, is it good?"
    const own = merged.length === 1 || merged.every((c) => PART_START.test(c));
    // a build first, then the rest on top of it ("build a spellcaster deck and make it 30 cards and use magician's act"); its name stays with the build
    const ps = EXPLICIT_BUILD.test(parts[0]) ? [[parts[0], ...parts.slice(1).filter((x) => /^(call it|name it|rename)\b/.test(x))].join(' and '), ...parts.slice(1).filter((x) => !/^(call it|name it|rename)\b/.test(x))] : parts;
    if (ps.length > 1 && own) return multiPlan(ps, w, mem, raw);
  }

  // rename
  const rn = (part && /\b(call|name|rename|named|called)\b/.test(t) ? whole : raw).match(/\b(?:rename(?: it| the deck| my deck)?|call it|name it|name the deck|call the deck|change (?:the|its|my deck's|the deck's) name(?: to)?|set the name(?: to)?)\s+(?:to\s+)?["“']?(.+?)["”']?\s*[.!]?$/i);
  const wantsNew = (EXPLICIT_BUILD.test(t) || (/^(an? )?(\w+ ){1,4}deck$/.test(t) && !/\b(my|this|the|your|it|explain|describe|rate|check|fix|show|improve|review|clear|empty|wipe|reset|good|bad|rename|whats|what)\b/.test(t))) && !/^(my|this|the) /.test(t) && !THIS_DECK.test(t) && !/^(what|which|how|why|can|could|should|is|are|do|does)\b/.test(t);
  if (rn && !wantsNew) return { calls: [{ name: 'edit_deck', input: { name: clip(rn[1]) } }], answer: () => `Renamed the deck "${clip(rn[1])}".` };

  if (/^(undo|undo (it|that|this)|go back|take (it|that) back|revert( it| that)?)$/.test(t) || /\b(give|bring|put|get) (me )?(back )?(my )?(old|previous|original) deck( back)?\b/.test(t)) return { calls: [], answer: () => 'Tap Undo on the change card above to take it back.' };

  // "a deck that beats blue eyes": the strongest deck, with how to handle that one
  const beats = t.match(/\b(?:deck|something|one)\s+(?:that|which|to|thatll|that will|that can|which can)\s+(?:can\s+)?(?:beat|beats|counter|counters|stop|stops|destroy|destroys|wreck|wrecks|handle|handles)\s+(.+)$/);
  if (beats && !/^(what|which|how|why|is|are)\b/.test(t)) {
    const foe = beats[1].replace(/\b(decks?|cards?)\b/g, '').trim();
    const plan = buildPlan(`${t.slice(0, beats.index)} best deck`.replace(/\s+/g, ' '), w);
    return { calls: plan.calls, answer: (rs) => `${plan.answer(rs)} I can't plan for one opponent's deck exactly, so I built your strongest one. Ask "how do I beat ${foe}?" and I'll name the cards you own that answer it.` };
  }
  // a new deck comes first: "build a deck with no traps" or "with a good skill" are options of the build
  if (wantsNew && !/\b(what|which) (can|could|should) i (build|make)\b/.test(t)) {
    // a new deck starts fresh, except for what this message rules out
    if (!ban) (banned = new Set()), (mem.noKinds = []);
    return buildPlan(t, w);
  }
  // restyle the deck that's there ("make it a zombie deck", "make the deck dragons instead", "make it zombies but keep dark magician"): a rebuild, with Undo
  // "keep red eyes but swap everything else for machines" is the same rebuild
  // "keep blue eyes but change everything else": a rebuild around what's kept
  if (d.main.length && /\b(keep|leave)\b/.test(t) && /\b(change|swap|replace|redo|rebuild)\s+(everything|the rest|all)( else)?( of it)?$/.test(t) && clauses(t, d).keep.length) return buildPlan(t, w);
  // "only dragons", "take out the cards that arent spellcasters": off-Type monsters out, that Type in
  const onlyR = t.match(/^(?:only|just|all) ([a-z -]+?)s?(?: please| now| only)?$/) ?? t.match(/\b(?:take out|remove|get rid of|cut|drop|lose|swap|replace)\b.*\b(?:that|which|who)\s+(?:arent|are not|isnt|is not|aint)\s+(?:an?\s+)?([a-z -]+?)s?$/) ?? t.match(/\b(?:no|remove|take out|get rid of|cut)\s+(?:the\s+|all\s+)?non[ -]?([a-z]+?)s?\b/);
  const onlyRace = onlyR && RACES.find((x) => flat(x) === onlyR[1].replace(/ie$/, 'y').trim());
  const onlyAttr = onlyR && !onlyRace ? ATTRS.find((a) => a.toLowerCase() === onlyR[1].trim()) : undefined;
  if ((onlyRace || onlyAttr) && d.main.length) {
    const fits = (c: CardInfo) => (onlyRace ? c.race === onlyRace : c.attribute === onlyAttr);
    const label = onlyRace ? plural(onlyRace) : `${onlyAttr} monsters`;
    // an explicit Type change can cut the deck's namesake; only cards asked for by name stay
    const asked = new Set(mem.wanted ?? []);
    const outs = d.main.filter((n) => cd(n)?.kind === 'monster' && !fits(cd(n)!) && !asked.has(n));
    const kept = d.main.filter((n) => cd(n)?.kind === 'monster' && !fits(cd(n)!) && asked.has(n));
    if (!outs.length) return { calls: [], answer: () => (kept.length ? `The only monsters here that aren't ${label} are ones you asked for by name (${listOf([...new Set(kept)])}). Say "take out" and a name to cut one.` : `Every monster here is already ${onlyRace ? `a ${onlyRace}` : onlyAttr}.`) };
    const rest = { ...d, main: [...d.main] };
    for (const n of outs) rest.main.splice(rest.main.indexOf(n), 1);
    const ins: string[] = [];
    for (let i = 0; i < outs.length; i++) {
      const c = candidates(w, { ...rest, main: [...rest.main, ...ins] }, (x) => x.kind === 'monster' && fits(x) && !isExtraCard(x.name) && x.sub !== 'Ritual' && ((x.level ?? 4) <= 4 || ins.filter((n) => (cd(n)?.level ?? 0) >= 5).length + rest.main.filter((n) => cd(n)?.kind === 'monster' && (cd(n)?.level ?? 0) >= 5).length < 4))[0];
      if (!c) break;
      ins.push(c.name);
    }
    // never short: off-Type monsters only go when one of that Type comes in, unless the deck stays legal
    const spare = Math.max(0, rest.main.length + ins.length - MAIN_MIN);
    const gone = [...outs].sort((a, b) => wn(a, d) - wn(b, d)).slice(0, Math.max(ins.length, Math.min(outs.length, ins.length + spare)));
    if (!ins.length && !gone.length) return { calls: [], answer: () => `You have no more ${label} that fit${w.collection ? '; they come from packs and the Card Shop' : ''}.` };
    return { calls: [{ name: 'edit_deck', input: { remove: counts(gone), add: counts(ins) } }], answer: () => `Took out ${listOf(gone)}${ins.length ? ` and put in ${listOf(ins)}` : ''}.${gone.length < outs.length ? ` You don't own enough ${label} to replace ${listOf(outs.filter((n) => !gone.includes(n) || outs.filter((x) => x === n).length > gone.filter((x) => x === n).length).slice(0, 3))}, so ${outs.length - gone.length === 1 ? 'that one stays' : 'those stay'}.` : ''}` };
  }
  if (d.main.length && /\b(swap|change|replace|turn|switch)\s+(everything|the rest|all)( else)?( of it)?\s+(for|to|into|with)\b/.test(t)) {
    const wish = readWish(clauses(t, d).text, w);
    if (wish.theme.kind === 'race' || wish.theme.kind === 'attribute') return buildPlan(t, w);
  }
  if (d.main.length && /^(make|turn|change|convert|switch|rebuild|redo|transform)\b/.test(t) && /\b(it|this|deck|instead|into|to)\b/.test(t)) {
    const rest = clauses(t, d).text;
    if (!/\b(add|remove|take out|swap|replace|more|fewer|less|stronger|better|weaker|bigger|smaller|aggressive|defensive|skills?|name|cards?|monsters?|spells?|traps?)\b/.test(rest)) {
      const wish = readWish(rest, w);
      if (wish.theme.kind === 'race' || wish.theme.kind === 'attribute') {
        const th = wish.theme as { kind: string; value: string };
        const on = d.main.filter((n) => cd(n)?.kind === 'monster' && (th.kind === 'race' ? cd(n)!.race === th.value : cd(n)!.attribute === th.value));
        restyleKeep = [...on, ...d.main.filter((n) => cd(n)?.kind !== 'monster' && on.some((m) => (cd(n)?.desc ?? '').includes(`"${m}"`) || quoted(cd(n)!).some((q) => m.includes(q)))), ...d.extra.filter((n) => isNeeded(n, d) || quoted(cd(n)!).every((q) => on.some((m) => m.includes(q))))];
        return buildPlan(t, w);
      }
      if (wish.around && /\bdeck\b/.test(rest)) return buildPlan(t, w);
    }
  }

  // Skills ("use symbol of pride" switches even without the word Skill)
  const skillNamed = /\b(use|equip|switch to|change to|put on|run|add|put|give it|give me|i want)\b/.test(t) ? nameIndex().find((x) => x.skill && ` ${t} `.includes(` ${x.flat} `) && (/\b(use|equip|switch to|change to|put on|run)\b/.test(t) || !nameIndex().some((y) => !y.skill && ` ${t} `.includes(` ${y.flat} `)))) : undefined;
  if (skillNamed && skillNamed.name === d.skill) return { calls: [], answer: () => `This deck already uses ${bare(d.skill!)}.` };
  if (skillNamed) return { calls: [{ name: 'edit_deck', input: { skill: skillNamed.name } }], answer: (rs) => (refusedOf(rs[0] ?? '') ? `Couldn't: ${refusedOf(rs[0])}.` : `Now using ${bare(skillNamed.name)}. ${short(cd(skillNamed.name)!.desc)}${skillWarn(skillNamed.name, w)}`) };
  if (/^(what is|whats|what are|explain) (a |the )?skills?$|\bhow do skills? work\b/.test(t)) return { calls: [], answer: () => RULES.find(([re]) => re.test('how do skills work'))![1] + (d.skill ? ` This deck uses ${bare(d.skill)}.` : '') };
  if (/\bhow many skills\b|\bmore than one skill\b|\b(two|2) skills\b/.test(t)) return { calls: [], answer: () => `Each deck brings one Skill to a duel.${d.skill ? ` This one uses ${bare(d.skill)}.` : ''} Say "pick a different Skill" to change it.` };
  if (/\bskills?\b/.test(t)) {
    const sk = findCard(t, 'skills', d);
    if (/^(what|whats|which|is there|are there)\b/.test(t) && /\b(best|good|better|should|for)\b/.test(t) && !sk) {
      const words = t.replace(/.*\bfor\b/, '').split(' ').filter((x) => x.length >= 3 && !STOP.has(x) && !INTENT.has(x)).map((x) => x.replace(/s$/, ''));
      const pickd = (words.length ? themedSkill([words.join(' '), ...words], w, null, d) : null) ?? skillPick(w, null);
      // the Skill on already is the answer when nothing fits better
      if (d.skill && skillFits(d.skill, d) && (!pickd || skillScore(d.skill, d) >= skillScore(pickd, d))) {
        mem.focus = d.skill;
        return { calls: [], answer: () => `Keep ${bare(d.skill!)}: it fits this deck best of the Skills you own. ${short(cd(d.skill!)?.desc ?? '', 140)}` };
      }
      const rec = pickd;
      if (rec) (mem.focus = rec), (mem.offer = { skill: rec });
      return { calls: [], answer: () => (rec ? `I'd go with ${bare(rec)}: ${short(cd(rec)?.desc ?? '', 160)} Say "use ${bare(rec)}" to put it on this deck.` : "You don't own a Skill that fits yet. Skills come from packs and the Card Shop.") };
    }
    if (/\b(what|which|list|show|all)\b.*\bskills\b.*\b(have|own|got|are there|can i use)\b|\bmy skills\b|\bskills (do i|i) (have|own)\b/.test(t)) return skillsListPlan(w);
    if (/\b(what|explain|how|tell)\b/.test(t) && !sk && !/\b(pick|choose|give|use|set|add|different|another|other|new|change|switch|better)\b/.test(t)) {
      if (!d.skill) return { calls: [], answer: () => 'This deck has no Skill yet. Say "pick a Skill" and I\'ll choose one that fits.' };
      return cardPlan(d.skill, w);
    }
    if (sk && /\b(what|explain|tell|does|read|about)\b/.test(t) && !/\b(use|equip|switch|change|set|put|give|add)\b/.test(t)) return cardPlan(sk, w);
    // a question about Skills never changes the Skill: "what skill does yugi use"
    if (/^(what|whats|which|who|whos|is|are|does|do|did|how|why|where|can|could|will|would)\b/.test(t) && !/^(can|could|will|would) (you|u)\b/.test(t)) {
      if (/\bnegat|\bdestroy|\bstop\b|\bcounter/.test(t)) return { calls: [], answer: () => 'No: a Skill isn\'t a card on the field, so card effects can\'t negate or destroy it. Your opponent just has to play around it.' };
      const said = t.split(' ').filter((x) => x.length >= 3 && !STOP.has(x) && !INTENT.has(x));
      const theirs = skillCards().filter((s) => s.character && said.some((x) => flat(s.character!).split(' ').some((y) => y === x || y === x.replace(/s$/, ''))));
      if (theirs.length) {
        const who = theirs[0].character!;
        const mine = theirs.filter((s) => getSkill(s.name));
        return { calls: [], answer: () => `${who}'s Skills in Speed Duel: ${mine.slice(0, 8).map((s) => bare(s.name)).join(', ')}${mine.length > 8 ? ` and ${mine.length - 8} more` : ''}.${d.skill ? ` This deck uses ${bare(d.skill)}.` : ''} Say "use" and a Skill's name to switch.` };
      }
      if (sk) return cardPlan(sk, w);
      if (d.skill) return cardPlan(d.skill, w);
      return { calls: [], answer: () => 'This deck has no Skill yet. Say "pick a Skill" and I\'ll choose one that fits.' };
    }
    // "use the harpie skill" when a Harpie Skill is already on: nothing to change
    const asked = t.split(' ').filter((x) => x.length >= 3 && !STOP.has(x) && !INTENT.has(x) && !/^(skill|skills|equip|switch|change|set|put|give|add|use|one|instead)$/.test(x));
    if (d.skill && (sk === d.skill || (asked.length && asked.every((x) => flat(bare(d.skill!)).split(' ').some((y) => y.startsWith(x.replace(/s$/, '').slice(0, 5)))))) && !/\b(different|another|other|new|better)\b/.test(t)) return { calls: [], answer: () => `This deck already uses ${bare(d.skill!)}. Say "pick a different Skill" for another one.` };
    if (/\b(remove|no|take off|off|drop|without|get rid|delete|clear)\b/.test(t) && !sk) return d.skill ? { calls: [{ name: 'edit_deck', input: { skill: null } }], answer: () => `Took ${bare(d.skill!)} off.` } : { calls: [], answer: () => "This deck has no Skill to take off." };
    const notSkill = !sk && /\b(use|equip|switch to|change to|set)\b/.test(t) ? findCard(t.replace(/\bskills?\b/g, ''), 'cards', d) : null;
    if (notSkill) return { calls: [], answer: () => `${notSkill} is a card, not a Skill. Say "add ${notSkill}" to put it in the deck, or "what skills do I have" to see your Skills.` };
    if (sk) return { calls: [{ name: 'edit_deck', input: { skill: sk } }], answer: (rs) => (refusedOf(rs[0] ?? '') ? `Couldn't: ${refusedOf(rs[0])}.` : `Now using ${bare(sk)}. ${short(cd(sk)!.desc)}${skillWarn(sk, w)}`) };
    const other = /\b(different|another|other|new|change|switch|better)\b/.test(t) && d.skill ? d.skill : null;
    // "give me a yugi skill": the best of that duelist's Skills for this deck
    const heard = t.split(' ').filter((x) => x.length >= 3 && !STOP.has(x));
    const ofChar = skillCards().filter((s) => s.character && s.name !== other && getSkill(s.name) && (!w.collection || (w.collection[s.name] ?? 0) > 0) && heard.some((x) => flat(s.character!).split(' ').some((y) => y === x || y === x.replace(/s$/, ''))));
    if (ofChar.length) {
      const top = [...ofChar].sort((a, b) => skillScore(b.name, d) - skillScore(a.name, d))[0].name;
      return { calls: [{ name: 'edit_deck', input: { skill: top } }], answer: (rs) => (refusedOf(rs[0] ?? '') ? `Couldn't: ${refusedOf(rs[0])}.` : `Picked ${bare(top)}, one of ${ofChar[0].character}'s Skills: ${short(cd(top)!.desc)}`) };
    }
    const best = skillPick(w, other);
    if (!best) return { calls: [], answer: () => (other ? `${bare(other)} is the only Skill you have that fits this deck.` : w.collection ? "You don't own a Skill that fits yet. Skills come from packs and the Card Shop." : "I couldn't find a Skill that fits.") };
    return { calls: [{ name: 'edit_deck', input: { skill: best } }], answer: () => `${other ? `Switched from ${bare(other)} to` : 'Picked'} ${bare(best)} for this deck: ${short(cd(best)!.desc)}` };
  }

  const cardsSaid = findCards(t, d, 'cards');
  // "no kuriboh": that card out, or kept out
  const noCard = t.match(/^(?:no|none of|not|without)\s+(?!more\b|way\b|thanks\b|i\b|you\b|it\b|that\b|this\b)(.+)$/);
  const noOne = noCard && cardsSaid.length === 1 && !new RegExp(`\\b${KIND_RE}\\b`).test(noCard[1]) && noCard[1].split(' ').length <= flat(cardsSaid[0].name).split(' ').length + 1 ? cardsSaid[0].name : null;
  if (noOne) {
    const have = d.main.filter((n) => n === noOne).length + d.extra.filter((n) => n === noOne).length;
    mem.wanted = (mem.wanted ?? []).filter((n) => n !== noOne);
    if (!have) return { calls: [], answer: () => `There's no ${noOne} in this deck, and I won't add any.` };
    return { calls: [{ name: 'edit_deck', input: { remove: [{ name: noOne, count: have }] } }], answer: () => `Took out ${have > 1 ? `all ${have} ${noOne}` : noOne}.${d.main.length - have < MAIN_MIN && d.main.length >= MAIN_MIN ? ` It has ${d.main.length - have} cards now; say "fill it up" to get back to ${MAIN_MIN}.` : ''}` };
  }

  if (/\bhow many cards\b.*\b(in|is|have|got)\b.*\b(it|(my|the|this) deck|now|that|this)\b|\bhow many cards (is|are) (that|this|there)\b|\bhow (big|large) is (it|my deck|the deck)\b|\bhow many cards (now|left|do i have)\b/.test(t)) return { calls: [{ name: 'view_deck', input: {} }], answer: () => `This deck has ${d.main.length} Main Deck card${d.main.length === 1 ? '' : 's'}${d.extra.length ? ` and ${d.extra.length} in the Extra Deck` : ''}${d.skill ? `, plus the Skill ${bare(d.skill)}` : ''}. It needs ${MAIN_MIN} to ${MAIN_MAX} to duel.` };
  if (/\b(what|which) cards? (am i|i am|im) missing\b|\bwhat (do i|should i) need\b|\bmissing cards\b/.test(t)) return suggestPlan(w, mem);
  if (/\b(regular|normal|real|master duel|tcg|ocg|full|proper)\b.*\b(duels?|yugioh|yu gi oh|game)\b|\bspeed duels?\b.*\bdifferen|\bwhat is (a )?speed duel\b/.test(t)) return { calls: [], answer: () => `Speed Duel is a faster Yu-Gi-Oh!: 4000 Life Points, a ${MAIN_MIN} to ${MAIN_MAX} card Main Deck, 4 cards in your opening hand, 3 Monster Zones and 3 Spell & Trap Zones, no Main Phase 2, and one Skill per duel. Only cards printed in Konami's Speed Duel products are allowed.` };
  if (/\b(turn one|turn 1|first turn|game ?plan|strategy|how (do|should) i play (it|this|this deck|my deck))\b/.test(t) && /\b(deck|it|this|play)\b/.test(t) && d.main.length) return explainPlan(w);
  if (/\b(what|which)\b.*\b(fusions?|fusion summon|extra deck monsters?)\b.*\b(can|could|should)\b|\b(what|which)\b.*\b(can|could) i\b.*\bfusion|\b(add|make it|put in|fill)\b.*\b(\d )?(fusions?|extra deck( monsters?)?)\b/.test(t) && !/\b(remove|take out|clear|empty|cut)\b/.test(t)) return fusionPlan(w, /\b(add|make it|put in|fill)\b/.test(t), Number(t.match(/\b([1-6])\b/)?.[1] ?? 0) || null);
  // "is the deck legal?": the editor's own check
  const outsideSaid = findOutside(t);
  if (outsideSaid && /\b(legal|allowed|banned|use|play|run|in speed|speed duel|can i)\b/.test(t)) return { calls: [], answer: () => outsideLine(outsideSaid) };
  if (/\b(legal|valid|allowed|playable|ready to duel|can i duel|duel with (it|this))\b/.test(t) && /\b(deck|it|this|that)\b/.test(t) && !cardsSaid.length) {
    const probs = speedDeckProblems(d);
    return { calls: [{ name: 'view_deck', input: {} }], answer: () => (probs.length ? `Not yet: ${probs.slice(0, 2).join('; ')}.${d.main.length < MAIN_MIN ? ' Say "fill it up" and I\'ll add cards that fit.' : ''}` : `Yes, it's legal and ready to duel: ${d.main.length} Main Deck cards${d.extra.length ? `, ${d.extra.length} in the Extra Deck` : ''}${d.skill ? ` and the Skill ${bare(d.skill)}` : ''}.`) };
  }
  if (/\b(show|whats in|what is in|what are|list|see|whats|what)\b.*\bextra deck\b/.test(t) && /\b(my|the|this)\b/.test(t)) return { calls: [{ name: 'view_deck', input: {} }], answer: () => (d.extra.length ? `The Extra Deck has ${listOf(d.extra)}.` : `The Extra Deck is empty. It holds up to ${EXTRA_MAX} Fusion, Synchro or Xyz monsters; add one by name if your deck has its materials.`) };
  // "how many traps should i run", "are there too many traps"
  const kindQ = t.match(new RegExp(`\\b(?:how many|too many|too few|enough|right number of)\\s+${KIND_RE}\\b(?! zones?)`));
  if (/\b(ratio|balance|mix|split)\b.*\b(monsters?|spells?|traps?)\b/.test(t) && /^(what|whats|how|is|are)\b/.test(t)) return { calls: [], answer: () => `For a 20-card deck: ${KIND_ADVICE.monster} ${KIND_ADVICE.spell} ${KIND_ADVICE.trap} This one runs ${kinds(d, 'monster')} monsters, ${kinds(d, 'spell')} spells and ${kinds(d, 'trap')} traps.` };
  if (kindQ && /^(how|is|are|do|does|what|should|have i|am i)\b/.test(t) && !/\b(in (it|my|the|this)|do i have|have i got)\b/.test(t)) {
    const kind = kindWord(kindQ[1])!;
    const k = kinds(d, kind);
    return { calls: [], answer: () => `You run ${k} ${kind}${k === 1 ? '' : 's'} now. ${KIND_ADVICE[kind]} Say "more ${kind}s" or "fewer ${kind}s" and I'll change it.` };
  }

  // "how many tributes does blue eyes need": the number
  const tribQ = t.match(/^how many (?:tributes?|monsters? to tribute|sacrifices?) (?:does|do|for|is|to summon)\s+(?:a |an |the )?(.+?)(?:\s+(?:need|take|cost|require))?$/);
  const tribName = tribQ ? findCard(tribQ[1], 'cards', d) : null;
  if (tribName && cd(tribName)?.kind === 'monster') {
    const c = cd(tribName)!;
    const lv = c.level ?? 4;
    return { calls: [], answer: () => (isExtraCard(tribName) || c.sub === 'Ritual' || /cannot be normal summoned|must (first )?be special summoned/i.test(c.desc) ? `${tribName} isn't Tribute Summoned: say "how do I summon ${tribName}" for how it comes out.` : `${lv >= 7 ? 2 : lv >= 5 ? 1 : 0}. ${tribName} is Level ${lv}${lv >= 7 ? ', and Level 7 and up need 2 Tributes' : lv >= 5 ? ', and Level 5 and 6 need 1 Tribute' : ', so it needs no Tribute'}.`) };
  }
  // "how do i summon dark magician": how that card comes out, and whether this deck can
  const howSummon = t.match(/^(?:how (?:do|can|would|should) (?:i|you|we)|how to) (?:summon|play|get out|bring out|special summon|fusion summon|ritual summon|use)\s+(?:a |an |the |my )?(.+)$/);
  const sumName = howSummon ? findCard(howSummon[1], 'cards', d) : null;
  if (sumName && cd(sumName)?.kind === 'monster') {
    const c = cd(sumName)!;
    mem.focus = sumName;
    const lv = c.level ?? 4;
    const spell = c.sub === 'Ritual' ? speedCards().find((x) => x.kind === 'spell' && x.sub === 'Ritual' && RITUAL_OF(x) === c.name)?.name : null;
    const mats = c.sub === 'Fusion' ? [...(c.desc.split(/\n|\. /)[0] ?? '').matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1]) : [];
    const how =
      c.sub === 'Fusion' ? `It's a Fusion: put it in the Extra Deck, then play Polymerization and send ${mats.length ? listOf(mats) : 'its materials'} from your hand or field to the Graveyard.${mats.length ? ` This deck ${mats.every((m) => d.main.some((x) => x === m || x.startsWith(`${m} `))) ? 'has' : "doesn't have"} all the materials${d.main.includes('Polymerization') ? '' : ' and needs Polymerization'}.` : ''}`
      : c.sub === 'Ritual' ? `It's a Ritual monster: play ${spell ?? 'its Ritual Spell'} and Tribute monsters from your hand or field whose Levels add up to ${lv} or more.${spell ? ` This deck ${d.main.includes(spell) ? 'has' : "doesn't have"} ${spell}.` : ''}`
      : /cannot be normal summoned|must (first )?be special summoned/i.test(c.desc) ? `It can't be Normal Summoned: ${short(c.desc.split(/(?<=\.)\s/)[0] ?? c.desc, 200)}`
      : lv >= 7 ? `Normal Summon it by Tributing 2 of your monsters (Level 7 and up need 2). It can also come out through cards that Special Summon it.`
      : lv >= 5 ? 'Normal Summon it by Tributing 1 of your monsters (Level 5 and 6 need 1).'
      : "Just Normal Summon it from your hand: Level 4 and lower need no Tribute. That's your one Normal Summon for the turn.";
    const helpers = c.sub !== 'Fusion' && lv >= 5 ? [...new Set(d.main)].filter((n) => n !== sumName && (cd(n)?.desc ?? '').includes(`"${sumName}"`) && /special summon/i.test(cd(n)?.desc ?? '')) : [];
    return { calls: [], answer: () => `${sumName}: ${how}${helpers.length ? ` In this deck, ${listOf(helpers)} can bring it out too.` : ''}` };
  }
  // "how many tribute monsters do i have", "whats the average attack"
  if ((/\bhow many\b.*\b(tribute|big|high level|level 5|level 7|level five|level seven)\b/.test(t) && /\b(have|got|in|run|are there)\b/.test(t)) || /^(what|which) are (the |my )?(\d |two |2 )?(tribute|big|high level|level 5\+?|level 7) monsters\b/.test(t)) {
    if (!d.main.length) return { calls: [], answer: () => 'The deck is empty.' };
    const bigs = d.main.filter((n) => cd(n)?.kind === 'monster' && (cd(n)!.level ?? 0) >= 5 && !isExtraCard(n));
    // "replace them", "cut one of them" next
    mem.added = [...bigs];
    const two = bigs.filter((n) => (cd(n)!.level ?? 0) >= 7).length;
    return { calls: [], answer: () => `${bigs.length} monster${bigs.length === 1 ? '' : 's'} here need${bigs.length === 1 ? 's' : ''} a Tribute${bigs.length ? ` (${two} of them need 2): ${listOf(bigs)}` : ''}. With 3 Monster Zones, 2 to 4 is plenty.${bigs.length > 4 ? ' Say "fewer tribute monsters" and I\'ll swap some for ones that need none.' : ''}` };
  }
  if (/\b(average|avg|mean)\b.*\b(attack|atk)\b/.test(t) && d.main.length) {
    const ms = d.main.map((n) => cd(n)).filter((c): c is CardInfo => c?.kind === 'monster');
    const low = ms.filter((c) => (c.level ?? 0) <= 4);
    const avg = (xs: CardInfo[]) => Math.round(xs.reduce((a, c) => a + (c.atk ?? 0), 0) / Math.max(1, xs.length));
    return { calls: [], answer: () => `Your Main Deck monsters average ${avg(ms)} ATK; the ones you can summon without a Tribute average ${avg(low)}.${avg(low) < 1500 ? ' That\'s on the low side: say "make it more aggressive" for harder hitters.' : ''}` };
  }
  // questions about the deck as a whole
  if (/^(why is|whats wrong with|why does|why do) (my|this|the) deck\b|^why (do i|am i) (keep )?(losing|lose)\b|^(is|why is) (my|this|the) deck (bad|trash|weak|garbage)\b/.test(t) && d.main.length) return ratePlan(w);
  if (/^(what does|how does) (my|this|the|it) ?(deck )?(do|work|play)( now)?$|^(whats|what is) (my|this|the) decks? (plan|strategy|idea|combo|gameplan)$/.test(t) && d.main.length) return explainPlan(w);
  if (/^(whats|what is|which is) (the |my )?(best|strongest|good|top) deck (i can|that i can|to) (make|build|run)|^what (deck|decks) (can|should) i (make|build)\b/.test(t)) {
    const th = themesPlan(w);
    return { calls: th.calls, answer: (rs) => `${th.answer(rs)} Say "build my strongest deck" and I'll make the best one I can from your cards.` };
  }
  const kindsIn = t.match(new RegExp(`^(?:which|what) cards? (?:in|of) (?:my|this|the) deck (?:are|is) ${KIND_RE}$`));
  if (kindsIn) {
    const k = kindWord(kindsIn[1])!;
    const these = d.main.filter((n) => cd(n)?.kind === k && !isExtraCard(n));
    return { calls: [], answer: () => (these.length ? `Your ${k}s here: ${listOf(these)}.` : `There are no ${k}s in this deck.`) };
  }
  if (/^(whats|what is) (my|the|this) decks? (name|called)$|^what is it called$|^whats it called$/.test(t)) return { calls: [], answer: () => `It's called "${d.name}". Say "call it" and a name to rename it.` };
  if (/^(which|what) (card|one) is (useless|bad|the worst|pointless|dead)\b|^(whats|what is) (a )?(useless|dead|bad) card\b/.test(t) && d.main.length) {
    const deadOnes = [...new Set(d.main)].filter((n) => cd(n) && deadFor(cd(n)!, d));
    const worst = [...new Set(d.main)].filter((n) => !protect.has(n)).sort((a, b) => wn(a, d) - wn(b, d))[0];
    return { calls: [], answer: () => (deadOnes.length ? `${listOf(deadOnes)} ${deadOnes.length > 1 ? 'do' : 'does'} nothing here: ${reason(cd(deadOnes[0])!, d)}. Say "take out ${deadOnes[0]}" to cut it.` : worst ? `Nothing is useless, but the weakest is ${worst}: ${stats(cd(worst)!)}. Say "take out the weakest card" to swap it.` : 'The deck is empty.') };
  }
  if (/^(whats|what is) (a )?good card to add\b|^what (card )?should i add\b|^what should i change\b|^what (would|could) (you|u) change\b/.test(t) && d.main.length) {
    if (/\bchange\b/.test(t)) {
      const sp = strongerPlan(w, 4, false);
      const swaps = sp.calls.find((c) => c.name === 'edit_deck')?.input as { remove?: { name: string }[]; add?: { name: string }[] } | undefined;
      if (swaps?.add?.length) {
        mem.offer = null;
        return { calls: [], answer: () => `I'd swap ${swaps.remove!.map((x, i) => `${x.name} for ${swaps.add![i]?.name}`).join(', ')}. Say "make it stronger" and I'll do it.` };
      }
    }
    return suggestPlan(w, mem);
  }
  if (/^(does|do|is there|are there) (my |this |the |it )?(deck )?(have|run|got|has)? ?(any )?(fusions?|extra deck( monsters?)?)\b/.test(t)) return { calls: [], answer: () => (d.extra.length ? `Yes: the Extra Deck has ${listOf(d.extra)}.` : `No, the Extra Deck is empty. Say "what fusions can I make" to see which ones this deck has the materials for.`) };
  // rules
  if (/\b(rule|rules|how many|how much|how do|how does|how can|what happens|can i|do i|is there|are there|when|what is|whats|what are|explain|difference|different from|what does)\b/.test(t) || /\?$/.test(raw)) {
    const hit = RULES.find(([re]) => re.test(t));
    if (hit && !cardsSaid.length && !/\b(my|this|the) deck\b/.test(t)) return { calls: [], answer: () => hit[1] };
  }

  // two cards side by side ("is red eyes better than blue eyes"): each side read on its own
  const vs = t.match(/^(?:is |whats |what is )?(?:the )?(?:difference between )?(.+?)\s+(?:better than|worse than|stronger than|than|vs|versus|or|and)\s+(.+?)(?:\s+(?:better|stronger|which is better))?$/);
  if (vs && /\b(better|worse|stronger|vs|versus|difference|compare|or)\b/.test(t)) {
    const a = findCard(vs[1].replace(/^(is|which is|whats|what s)\s+/, ''), 'cards', d);
    const b = findCard(vs[2], 'cards', d);
    if (a && b && a !== b) return comparePlan(a, b);
  }
  if (cardsSaid.length >= 2 && /\b(difference|differences|compare|comparison|vs|versus|better|or)\b/.test(t) && !/\b(add|put|remove|take out|cut|swap)\b/.test(t)) return comparePlan(cardsSaid[0].name, cardsSaid[1].name);

  if (/\bhow many cards\b.*\b(in|is)\b.*\b(it|(my|the|this) deck)\b|\bhow (big|large) is (it|my deck|the deck)\b/.test(t)) return { calls: [{ name: 'view_deck', input: {} }], answer: () => `This deck has ${d.main.length} Main Deck card${d.main.length === 1 ? '' : 's'}${d.extra.length ? ` and ${d.extra.length} in the Extra Deck` : ''}${d.skill ? `, plus the Skill ${bare(d.skill)}` : ''}. It needs ${MAIN_MIN} to ${MAIN_MAX} to duel.` };
  if (/\b(what|which|show me|list)\b.*\bcards? (do i|i) (have|own|got)\b|\bmy (collection|cards)\b$/.test(t)) return { calls: [{ name: 'collection_overview', input: {} }], answer: (rs) => (w.collection ? `${(rs[0] ?? '').split('\n').slice(0, 3).join(' ').replace(/\s+/g, ' ')} The card list below the deck shows every card you own.` : 'This is an Anything goes deck, so every Speed Duel card is open to it.') };
  if (/\b(keeps? losing|keep losing|always lose|lost|losing|too slow|slow|not winning|cant win|keeps getting beat)\b/.test(t) && d.main.length) {
    const rate = ratePlan(w);
    return { calls: rate.calls, answer: (rs) => `${rate.answer(rs)} To speed it up, say "make it more aggressive"; to swap weak cards, "make it stronger".` };
  }

  // "how many blue eyes do i own": the collection, not the deck
  const ownQ = t.match(/^how many (?:copies of )?(?:the )?(.+?)\s*(?:cards?)?\s*(?:do i|have i|i) (?:own|have in my collection|got in my collection|have got)\b/);
  if (ownQ && w.collection) {
    const one = findCard(ownQ[1], 'cards', d);
    const fam = flat(ownQ[1]);
    const mine = one && flat(one) === fam ? [one] : Object.keys(w.collection).filter((n) => (w.collection![n] ?? 0) > 0 && cd(n) && cd(n)!.sub !== 'Skill' && (` ${flat(n)} `.includes(` ${fam} `) || n === one));
    const total = mine.reduce((a, n) => a + (w.collection![n] ?? 0), 0);
    return { calls: [], answer: () => (mine.length ? `You own ${total}: ${mine.slice(0, 8).map((n) => `${w.collection![n]} ${n}`).join(', ')}${mine.length > 8 ? ` and ${mine.length - 8} more cards` : ''}.` : `You don't own any ${ownQ[1]} cards yet. They come from packs and the Card Shop.`) };
  }
  // "how many harpie cards are in it", "how many traps do i have"
  const hm = t.match(new RegExp(`\\bhow many (?:of )?(?:the |my )?(.+?)\\s*(?:cards?)?\\s*(?:are|do i|is there|have i|in)\\b`));
  if (hm && !RULES.slice(0, 2).some(([re]) => re.test(t))) {
    const what = hm[1].trim();
    const kind = kindWord(what);
    const fam = flat(what).replace(/\b(cards?|monsters?)$/, '').trim();
    // "how many level 8s", "level 4 monsters"
    const lvQ = Number(fam.match(/^(?:level|lv|lvl) ?(\d+)s?$/)?.[1] ?? 0);
    const inDeckList = [...d.main, ...(kind ? [] : d.extra)].filter((n) => (lvQ ? cd(n)?.kind === 'monster' && cd(n)!.level === lvQ : kind ? cd(n)?.kind === kind : fam.length >= 3 && (` ${flat(n)} `.includes(` ${fam} `) || flat(cd(n)?.race ?? '').startsWith(fam.replace(/s$/, '')) || flat(cd(n)?.attribute ?? '') === fam)));
    if (kind || inDeckList.length || fam.length >= 3)
      return { calls: [{ name: 'view_deck', input: {} }], answer: () => `There ${inDeckList.length === 1 ? 'is' : 'are'} ${inDeckList.length} ${what.replace(/s$/, '')}${inDeckList.length === 1 ? '' : 's'} in ${kind ? 'the Main Deck' : 'this deck'}${inDeckList.length ? `: ${listOf(inDeckList)}` : ''}.${kind === 'monster' && d.extra.length ? ` Plus ${d.extra.length} in the Extra Deck.` : ''}` };
  }

  // "what are my traps", "show me the monsters"
  const listKind = t.match(new RegExp(`^(?:what|which|whats|show me|list|tell me)(?: are| is)?(?: all)?(?: of)? (?:my|the) ${KIND_RE}\\b`));
  if (listKind) {
    const kind = kindWord(listKind[1])!;
    const these = d.main.filter((n) => cd(n)?.kind === kind && !isExtraCard(n));
    return { calls: [{ name: 'view_deck', input: {} }], answer: () => (these.length ? `Your ${kind}s here: ${listOf(these)}.` : `There are no ${kind}s in this deck.`) };
  }

  // "how do i beat a harpie deck" / "how do i beat exodia": removal and protection they own
  if (/\b(beats?|counters?|stops?|deal with|win against|handle)\b/.test(t) && /\b(how|what|help|can)\b/.test(t)) {
    const hard = (c: CardInfo) => (/destroy all|negate the activation|banish all/i.test(c.desc) ? 2 : /destroy (1|that|the attacking|up to)|negate/i.test(c.desc) ? 1 : 0);
    const answers = candidates(w, { ...d, main: [] }, (c) => c.kind !== 'monster' && /destroy|negate|banish/i.test(c.desc) && !/\btoken\b/i.test(c.desc)).sort((a, b) => hard(b) - hard(a) || fame(b.name) - fame(a.name)).slice(0, 4);
    return {
      calls: [],
      answer: () =>
        `Speed Duels are short, so keep pressure on: attack every turn with strong Level 4 monsters and hold removal for their best card. ${answers.length ? `Good answers you own: ${listOf(answers.map((c) => c.name))}.` : ''} Set traps before you attack, since there is no Main Phase 2. Say "add" and a card's name to put one in.`.trim(),
    };
  }

  // how the deck plays
  if (/\b(what does|whats|show me what) (my|this|the) deck look like\b|\bshow (me )?(my|the) deck\b/.test(t)) return explainPlan(w);
  if (/\b(explain|describe|summari[sz]e|break down|walk me through)\b.*\b(deck|it|this)\b|\b(whats|what is) in (my|this|the) deck\b|\bhow (does|do) (my|this|the) deck (work|play)\b|\b(tell me about|what about) (my|this|the) deck\b/.test(t)) return explainPlan(w);

  // "what does kaiser glider do and is it good": the card, not the deck
  if (part && mem.focus && cd(mem.focus) && /^(is it|is that|is she|is he|its) (good|any good|worth it|strong|bad)\b/.test(t)) {
    const c = cd(mem.focus)!;
    const v = worth(c, d);
    return { calls: [], answer: () => `As for whether it's good: in Speed Duel ${c.name} is ${v >= 2200 ? 'a strong pick' : v >= 1500 ? 'a solid pick' : v >= 900 ? 'an okay pick' : 'a weak pick'}${c.kind === 'monster' && (c.level ?? 4) >= 5 ? `, but it costs ${(c.level ?? 4) >= 7 ? '2 Tributes' : 'a Tribute'}` : ''}.` };
  }
  // rate the deck
  if (/\b(good|rate|rating|review|grade|score|analy[sz]e|check|whats wrong|thoughts|opinion|how is|hows|any good|ready)\b/.test(t) && /\b(deck|it|its|this)\b/.test(t) && !/\b(make|swap|add|put|remove|take|cut|drop|get rid|weak|weakest|replace|change)\b/.test(t)) return ratePlan(w);

  // why that card
  if (/\bwhy\b/.test(t)) {
    const asked = cardsSaid.map((c) => c.name).filter((n) => inDeck(d, n));
    const tookOut = /\b(take|took|remove|removed|cut|drop|dropped)\b/.test(t);
    if (tookOut && !asked.length && mem.removed.length) return { calls: [], answer: () => [...new Set(mem.removed)].slice(0, 4).map((n) => (cd(n) ? `${n} was one of the weakest here (${cd(n)!.kind === 'monster' ? `${cd(n)!.atk ?? 0} ATK` : 'little effect for this deck'}).` : n)).join(' ') + ' Say "undo" to bring it back.' };
    const notIn = cardsSaid.map((c) => c.name).filter((n) => !inDeck(d, n));
    const whyIs = t.match(/^why (?:is|are|do i have|did you (?:add|put in|pick))\s+(?:the\s+|my\s+)?(.+?)\s+(?:in here|in (?:my|the|this) deck|in it|there|here)$/);
    if (whyIs && !cardsSaid.length && !/^(that|it|those|them|this|these|they)$/.test(whyIs[1])) return { calls: [], answer: () => `I can't find a card called "${whyIs[1]}" in this deck.${nearest(whyIs[1])}` };
    if (!asked.length && notIn.length && !tookOut) return { calls: [], answer: () => `${listOf(notIn)} ${notIn.length > 1 ? "aren't" : "isn't"} in this deck.` };
    const list = asked.length ? asked : [...new Set(mem.added)].filter((n) => inDeck(d, n));
    if (!list.length && d.main.length && /\b(add|put|pick|choose|build|did you)\b/.test(t)) {
      const ex = explainPlan(w);
      return { calls: ex.calls, answer: (rs) => `I built it from your strongest cards for that theme. ${ex.answer(rs)}` };
    }
    if (list.length) return { calls: [], answer: () => list.slice(0, 4).map((n) => `${n}: ${reason(cd(n)!, d)}.`).join(' ') };
    if (/\b(that|this|those|it|them|did you|add|put)\b/.test(t)) return { calls: [], answer: () => "I didn't put a card in just now. Ask about a card by name, like \"why Kuriboh?\", or say \"explain my deck\"." };
  }

  // "whats weak about it", "weaknesses of this deck": the check-up
  if (/^(what|whats|where|any|are there|is there|tell me|show me)\b.*\b(weak|weakness|weaknesses|weak spots?|flaws?|problems?|bad about)\b/.test(t) && !/\b(weakest|card|monster|spell|trap)\b/.test(t)) return ratePlan(w);
  // "which card should i take out": the weakest one
  const cutQ = t.match(/^(?:which|what)(?: (card|cards|one|monster|spell|trap)s?)? (?:should|could|do|would|can) i (?:take out|cut|remove|drop|lose|get rid of|swap out|replace)\b/);
  // which card is best / weakest in the deck
  const which = cutQ ? ['', 'weakest', kindWord(cutQ[1] ?? '') ?? 'card'] : t.match(/\b(best|strongest|weakest|worst)\b(?: \w+){0,2} (card|monster|spell|trap)s?\b/);
  if (which && /\b(what|which|whats|who|tell|show)\b/.test(t) && d.main.length) {
    const kind = kindWord(which[2]);
    const up = /best|strongest/.test(which[1]);
    // "best card" means the best monster; a Ritual Spell scores high only because its monster needs it
    const pool = [...new Set([...d.main, ...d.extra])].map((n) => cd(n)!).filter((c) => c && (kind ? c.kind === kind : !up || c.kind === 'monster'));
    // the weakest is never one the player asked for by name
    // "strongest monster" is the one that hits hardest
    const hits = /strongest/.test(which[1]) && kind !== 'spell' && kind !== 'trap';
    const top = pool.sort((a, b) => (up ? 0 : Number(protect.has(a.name)) - Number(protect.has(b.name))) || (hits ? (b.atk ?? 0) - (a.atk ?? 0) : 0) || worth(b, d) - worth(a, d))[up ? 0 : pool.filter((c) => !protect.has(c.name)).length - 1] ?? pool[pool.length - 1];
    if (top) mem.focus = top.name;
    if (top) return { calls: [{ name: 'view_deck', input: {} }], answer: () => `${up ? 'Your strongest' : 'Your weakest'} ${kind ?? 'card'} here is ${top.name}: ${stats(top)}. ${short(top.desc)}${up ? '' : ` Say "take out the weakest ${kind ?? 'card'}" to cut it.`}` };
  }

  // what to add or chase
  if (/\b(what|which)\b.*\b(should|could|can|to|do)\b.*\b(add|get|buy|put in|chase|open|use|need)\b|\b(suggest|recommend|suggestions?|recommendations?)\b/.test(t) && !cardsSaid.length) return suggestPlan(w, mem);

  // what can I build
  if (/\b(what|which)\b.*\b(can|could|should) i (build|make)\b|\b(what|which)\b.*\b(themes?|decks?)\b.*\b(can|could|should)\b|\b(deck )?ideas?\b|\bthemes?\b/.test(t) && !EXPLICIT_BUILD.test(t.replace(/\bwhat.*\b(build|make)\b/, ''))) return themesPlan(w);

  if (/^(would|could|should|is|will)\b/.test(t) && /\b(\d\d) cards?\b|\b(bigger|smaller)\b/.test(t)) return { calls: [], answer: () => `${MAIN_MIN} cards is the strongest size: you draw your best cards most often. More only helps if a theme needs the room. Say "make it 25 cards" if you want that anyway.` };
  // a question never changes the deck: it gets an answer, or the words to ask for the change
  if (/^(is|are|which|should|would|does|did|was|were|whats|what|how|why|who|where|when|do)\b/.test(t) && !/^(do it|do that)\b/.test(t)) {
    const askedSkill = /\bskills?\b/.test(t) && /\b(best|good|which|what)\b/.test(t);
    if (askedSkill) {
      const pickS = skillPick(w, null);
      if (pickS) mem.focus = pickS;
      return { calls: [], answer: () => (pickS ? `For this deck I'd pick ${bare(pickS)}: ${short(cd(pickS)?.desc ?? '', 160)} Say "use ${bare(pickS)}" to put it on.` : "You don't own a Skill that fits yet.") };
    }
    const asked = nameIndex().find((x) => x.skill && ` ${t} `.includes(` ${x.flat} `))?.name ?? (cardsSaid.find((f) => !f.partial) ?? cardsSaid[0])?.name;
    if (asked) return cardPlan(asked, w, true);
    const ask = t.replace(/^(should i|can i|could i|do i|would it be (good|ok|okay|bad) to|is it (good|ok|okay|bad|smart|better) to|how do i|how can i|what if i)\s+/, '');
    if (ask !== t && /\b(add|put|remove|take|cut|swap|replace|make|change|use|build|fill)\b/.test(ask)) return { calls: [], answer: () => `I can do that. Say "${ask}" and I'll change it, with an Undo if you don't like it.` };
    const none = ask.match(new RegExp(`^(?:have|run|play)(?: with)? (no|zero|more|fewer|less|lots of|a lot of) ${KIND_RE}`));
    if (none) {
      const kind = kindWord(none[2])!;
      const k = kinds(d, kind);
      const advice = KIND_ADVICE[kind];
      return { calls: [], answer: () => `You run ${k} ${kind}${k === 1 ? '' : 's'} now. ${advice} Say "${none[1] === 'no' ? `take out the ${kind}s` : `${none[1] === 'more' || none[1] === 'lots of' || none[1] === 'a lot of' ? 'more' : 'fewer'} ${kind}s`}" if you want me to change it.` };
    }
    // "what does dark hole do": a real card outside Speed Duel, or one nobody knows
    const named = t.match(/^(?:what|wat|whats) (?:does|do|is) (?:the card )?(.+?)(?: do| does| mean)?$/)?.[1];
    if (named && !/\b(it|that|this|my|deck|skill)\b/.test(named)) {
      const real = card(named);
      if (real && !speedCards().some((x) => x.name === real.name)) return { calls: [], answer: () => `${outsideLine(real.name)} What it does: ${short(real.desc, 220)}` };
      if (!real && named.split(' ').length >= 2) return { calls: [], answer: () => `I don't know a Speed Duel card called "${named}".${nearest(named)} Check the spelling, or it may not be in Speed Duel.` };
    }
    // "is that skill good for this deck": a verdict, not the text
    if (/\bskill\b/.test(t) && /\b(good|fit|fits|work|right|ok|okay)\b/.test(t) && d.skill) {
      const fits = skillFits(d.skill, d);
      const alt = skillPick(w, d.skill);
      return { calls: [], answer: () => (fits ? `Yes: ${bare(d.skill!)} fits this deck.${alt && skillScore(alt, d) > skillScore(d.skill!, d) ? ` ${bare(alt)} could be a little better; say "use ${bare(alt)}" to try it.` : ''}` : `Not really: ${bare(d.skill!)} is made for cards this deck barely runs.${alt ? ` ${bare(alt)} fits better; say "use ${bare(alt)}".` : ''}`) };
    }
    // "what ritual monsters are in it"
    const sortQ = t.match(/^(?:what|which) (ritual|fusion|normal|effect|tribute|level \d+|dark|light|earth|water|fire|wind)? ?(monsters|cards|spells|traps)(?: are| is)? (?:in|on) (?:it|my deck|this deck|the deck|there)\b/);
    if (sortQ) {
      const sub = sortQ[1] ?? '';
      const kind = sortQ[2] === 'spells' ? 'spell' : sortQ[2] === 'traps' ? 'trap' : sortQ[2] === 'monsters' ? 'monster' : null;
      const pass = (c: CardInfo) => (!kind || c.kind === kind) && (!sub || (sub === 'ritual' ? c.sub === 'Ritual' : sub === 'fusion' ? c.sub === 'Fusion' : sub === 'normal' ? !!c.vanilla : sub === 'effect' ? c.kind === 'monster' && !c.vanilla : sub === 'tribute' ? c.kind === 'monster' && (c.level ?? 0) >= 5 && !isExtraCard(c.name) : /^level/.test(sub) ? c.level === Number(sub.split(' ')[1]) : c.attribute === sub.toUpperCase()));
      const these = [...new Set([...d.main, ...d.extra])].filter((n) => cd(n) && pass(cd(n)!));
      return { calls: [], answer: () => (these.length ? `${listOf(these)}.` : `None: this deck has no ${sortQ[1] ? `${sortQ[1]} ` : ''}${sortQ[2]}.`) };
    }
    if (/\b(better|improve|win|good at|get good)\b/.test(t)) return { calls: [], answer: () => 'Speed Duels are short: summon a strong Level 4 every turn, attack whenever you can, and Set traps before your Battle Phase since there is no Main Phase 2. Save removal for their biggest threat. For this deck, say "is this deck good?" and I\'ll point out what to fix.' };
    return { calls: [], answer: () => `I'm not sure how to answer that one.${nearest(t)} ${HELP}` };
  }

  // anything deck-shaped while the deck is empty builds one (not a question about it)
  if (/\b(legal|ready|valid|allowed|playable)\b/.test(t) && /\b(deck|it)\b/.test(t)) return ratePlan(w);
  if (!/^(is|are|what|whats|how|why|can|does|do)\b/.test(t) && (!d.main.length && !d.extra.length && /\b(deck|random|surprise|aggressive|aggro|control|defensive)\b/.test(t) && !cardsSaid.some((c) => /\b(add|put)\b/.test(t) && c))) return buildPlan(t, w);
  // "i want something with dragons but no warriors" on an empty deck
  if (!d.main.length && !d.extra.length && !/^(is|are|what|whats|how|why|does|do)\b/.test(t) && /\b(something|want|wanna|need|give me|make me|i like|lets do)\b/.test(t)) {
    const wish = readWish(t, w);
    if (wish.theme.kind === 'race' || wish.theme.kind === 'attribute') return buildPlan(t, w);
  }

  // "make it a burn deck", "more burn": cards that deal damage straight to the opponent
  if (/\bburn\b/.test(t) && d.main.length && /^(make|turn|more|add|give|change|switch|i want|can it)\b/.test(t)) {
    const burn = (c: CardInfo) => /inflicts? (\d+ )?damage to your opponent|your opponent takes \d+ damage|inflict damage to your opponent/i.test(c.desc);
    const plan = kindShift(w, 'spell', 3, 'burn damage', burn);
    if (plan.calls.length) return plan;
    return kindShift(w, 'trap', 3, 'burn damage', burn);
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
  if (d.main.length && /\b(smaller|shorter|thinner|less cards|fewer cards)\b/.test(t)) return d.main.length <= MAIN_MIN ? { calls: [], answer: () => `It's already the smallest a deck can be (${MAIN_MIN}).` } : trimPlan(d, Math.max(MAIN_MIN, d.main.length - 5), mem);
  if (d.main.length && /\b(bigger|larger|more cards|longer)\b/.test(t) && !/\bdraw\b/.test(t)) return d.main.length >= MAIN_MAX ? { calls: [], answer: () => `It's already the biggest a deck can be (${MAIN_MAX}).` } : fillPlan(w, Math.min(MAIN_MAX, d.main.length + 5), mem, `Made it ${Math.min(MAIN_MAX, d.main.length + 5)} cards with`);

  // "take out 10 cards", "get rid of the worst 3 cards": the weakest go, and the deck stays legal
  const cutN = t.match(/^(?:take out|remove|cut|drop|get rid of|lose|delete|ditch)\s+(?:the\s+|my\s+)?(?:(?:worst|weakest|bad|bottom)\s+)?(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:worst|weakest|bad)\s+)?cards?$/);
  if (cutN && d.main.length) {
    const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const n = Math.min(d.main.length, /^\d+$/.test(cutN[1]) ? Number(cutN[1]) : words[cutN[1]]);
    const byWorth = (xs: string[]) => xs.sort((a, b) => wn(a, d) - wn(b, d));
    const out = [...byWorth(d.main.filter((x) => !isNeeded(x, d) && !protect.has(x))), ...byWorth(d.main.filter((x) => isNeeded(x, d) && !protect.has(x)))].slice(0, n);
    if (!out.length) return { calls: [], answer: () => 'Every card here is one you asked for by name. Name the ones to take out.' };
    const cut: Plan = { calls: [{ name: 'edit_deck', input: { remove: counts(out) } }], answer: () => `Took out the ${out.length} weakest: ${listOf(out)}.${out.length < n ? ` The rest are cards you asked for by name, so I left them.` : ''}` };
    return d.main.length - out.length < MAIN_MIN ? refill(cut, w, null) : cut;
  }
  // resize: "make it 30 cards"
  const size = t.match(/\b(\d{1,3})\b(?= cards?\b)|\b(2\d|30)\b|^(?:make it|go to|set it to|bring it to|change it to|resize it to|cut it to|cut it down to)\s+(\d{1,3})$/);
  if (size && d.main.length && (/\b(make|set|change|go|bring|turn|up|down|resize|cards?)\b/.test(t) || THIS_DECK.test(t)) && !cardsSaid.length) {
    const n = Number(size[1] ?? size[2] ?? size[3]);
    if (n < MAIN_MIN || n > MAIN_MAX) return { calls: [], answer: () => `A Main Deck holds ${MAIN_MIN} to ${MAIN_MAX} cards.` };
    // "make it 25 cards with no traps"
    const noKind = t.match(new RegExp(`\\b(?:with no|without|no)\\s+(?:any\\s+)?${KIND_RE}`));
    if (noKind) {
      const kind = kindWord(noKind[1])!;
      const these = d.main.filter((x) => cd(x)?.kind === kind && !isExtraCard(x));
      if (these.length && d.main.length - these.length <= n) return refill({ calls: [{ name: 'edit_deck', input: { remove: counts(these) } }], answer: () => `Took out the ${these.length} ${kind}${these.length === 1 ? '' : 's'}.` }, w, kind, undefined, n);
    }
    if (n === d.main.length) return { calls: [], answer: () => `It already has ${n} cards.` };
    return n > d.main.length ? fillPlan(w, n, mem, `Made it ${n} cards with`) : trimPlan(d, n, mem);
  }

  // "remove everything except the monsters": the other kinds go
  const except = t.match(new RegExp(`\\b(remove|delete|take out|get rid of|cut|clear)\\b.*\\b(except|but|other than|apart from|besides|aside from)\\b(?: the| my)? ${KIND_RE}`));
  if (except) {
    const keep = kindWord(except[3])!;
    const out = counts(d.main.filter((n) => cd(n)?.kind !== keep));
    if (!out.length) return { calls: [], answer: () => `There's nothing but ${keep}s in the deck already.` };
    return { calls: [{ name: 'edit_deck', input: { remove: out } }], answer: () => `Took out everything but the ${keep}s (${out.reduce((a, x) => a + x.count, 0)} cards). Say "fill it up" to bring it back to ${MAIN_MIN}.` };
  }

  // "take out everything except the red eyes cards": those (by name or name family) stay
  const exceptNames = t.match(/\b(?:remove|delete|take out|take|get rid of|cut|clear|empty)\b(.*?)\b(?:except|but|other than|apart from|besides|aside from|save)\b(?: for)?(.+)$/);
  if (exceptNames && /\b(everything|all|every|everycard|rest|whole|deck)\b/.test(exceptNames[1]) && !new RegExp(`\\b${KIND_RE}\\b`).test(exceptNames[1]) && d.main.length) {
    const named = new Set(findCards(exceptNames[2], d).map((f) => f.name));
    const fam = exceptNames[2].split(' ').filter((x) => x && !STOP.has(x) && !INTENT.has(x)).join(' ');
    const keepIt = (n: string) => named.has(n) || (fam.length >= 3 && ` ${flat(n)} `.includes(` ${fam} `));
    const stay = d.main.filter(keepIt);
    if (!stay.length) return { calls: [], answer: () => `Nothing in the deck matches "${exceptNames[2].trim()}", so I left it as it is.` };
    const out = counts(d.main.filter((n) => !keepIt(n)));
    if (!out.length) return { calls: [], answer: () => 'Every card in the deck is one you want to keep, so nothing changed.' };
    return { calls: [{ name: 'edit_deck', input: { remove: out } }], answer: () => `Took out everything but ${listOf([...new Set(stay)])} (${stay.length} cards left). Say "fill it up" to bring it back to ${MAIN_MIN}, or "build around" a card for a new deck.` };
  }

  // clear
  if (!/\b(except|but|other than|apart from)\b/.test(t) && /^(clear|empty|wipe|reset|start over)\b|\b(clear|empty|wipe|reset) (it|the deck|my deck|this deck|everything)\b|\b(remove|delete|take out) everything\b|\btake everything out\b|\bstart (it )?over\b|^(delete|scrap|trash|bin) (it|the deck|my deck|this deck)$/.test(t) && !/\b(is|its) empty\b/.test(t)) return { calls: [{ name: 'edit_deck', input: { clear: true, skill: null } }], answer: () => 'Emptied the deck and took the Skill off. Say "build me a deck" to fill it again.' };

  // "swap the worst monster for another summoned skull", "swap the weakest monster for something stronger"
  const worstFor = t.match(/^(?:swap|replace|trade|switch)\s+(?:out\s+)?(?:the |my )?(?:([1-9]) )?(?:weakest|worst)(?: (card|monster|spell|trap)s?)?\s+(?:for|with)\s+(.+)$/);
  if (worstFor && d.main.length) {
    const n = Number(worstFor[1] ?? 1);
    const kind = kindWord(worstFor[2] ?? '');
    const ins = findCards(worstFor[3], d).map((f) => ({ name: f.name, count: f.count ?? n }));
    if (!ins.length) {
      const sp = strongerPlan(w, n, false);
      return sp.calls.length ? sp : { calls: [], answer: () => 'Your weakest card is already the best you own for that slot.' };
    }
    const out = [...d.main].filter((x) => (!kind || cd(x)?.kind === kind) && !isNeeded(x, d) && !protect.has(x) && !ins.some((f) => f.name === x)).sort((a, b) => wn(a, d) - wn(b, d)).slice(0, ins.reduce((a, x) => a + x.count, 0));
    const sim = runTool(w, 'edit_deck', { remove: counts(out), add: ins });
    if (refusedOf(sim.text)) return { calls: [], answer: () => `I couldn't swap: ${refusedOf(sim.text)}. Nothing changed.` };
    return { calls: [{ name: 'edit_deck', input: { remove: counts(out), add: ins } }], answer: () => `Swapped ${listOf(out)} (the weakest) for ${listOf(ins.flatMap((x) => Array(x.count).fill(x.name)))}.` };
  }
  // "rebuild it but keep the kaiser gliders": a new deck on the same theme, keeping those
  if (d.main.length && /^(rebuild|redo|remake|start again with|reroll)\b/.test(t)) {
    const theme = deckFamily(d) ?? (deckRace(d) ? plural(deckRace(d)!).toLowerCase() : '');
    return buildPlan(`build a ${theme} deck ${t.replace(/^(rebuild|redo|remake|start again with|reroll)( it| the deck| my deck| this)?/, '')}`.replace(/\s+/g, ' ').trim(), w);
  }
  // "put kuriboh in instead of the weakest card": the weakest go to make room
  const insteadWeak = t.match(/^(.*?)\b(?:instead of|in place of|for|replacing|over)\s+(?:the |my |a |an )?(?:([1-9]) )?(?:weakest|worst)(?: (card|monster|spell|trap)s?)?\b/);
  if (insteadWeak && /\b(add|put|include|use|run|throw)\b/.test(insteadWeak[1]) && d.main.length) {
    const ins = findCards(insteadWeak[1], d).map((f) => ({ name: f.name, count: f.count ?? 1 }));
    if (ins.length) {
      const n = ins.reduce((a, x) => a + x.count, 0);
      const kind = kindWord(insteadWeak[3] ?? '');
      const out = [...d.main].filter((x) => (!kind || cd(x)?.kind === kind) && !isNeeded(x, d) && !protect.has(x) && !ins.some((f) => f.name === x)).sort((a, b) => wn(a, d) - wn(b, d)).slice(0, n);
      mem.wanted = [...new Set([...(mem.wanted ?? []), ...ins.map((f) => f.name)])];
      return {
        calls: [{ name: 'edit_deck', input: { remove: counts(out), add: ins } }],
        answer: (rs) => {
          const refused = refusedOf(rs[0] ?? '');
          const done = rs[0]?.match(/^Done: (.*)\.$/m)?.[1];
          return `${done && done !== 'Nothing changed' ? `Swapped: ${done}.` : 'Nothing changed.'}${refused ? ` ${refused}.` : ''}`;
        },
      };
    }
  }
  // swap one card for another: "replace toon world with 2 sakuretsu armor", "put sangan in instead of kuriboh"
  const insteadCard = t.match(/^(?:add|put in|put|include|use|run|throw in)\s+(.+?)\s+(?:in\s+)?(?:instead of|in place of|replacing)\s+(.+)$/);
  const swapCards = insteadCard ? ['', 'replace', insteadCard[2], insteadCard[1]] : t.match(/\b(swap|replace|trade|switch|change|exchange|sub)\b(?: out)?\s+(.+?)\s+\b(?:for|with|to|into|by)\b\s+(.+)$/);
  if (swapCards) {
    // "replace them with man-eater bug": the cards just added (or talked about)
    const from = /^(it|that|them|those|these|that one|this one|they)$/.test(swapCards[2].trim()) ? counts(mem.focus && inDeck(d, mem.focus) ? [mem.focus] : mem.added.filter((n) => inDeck(d, n))).map((x) => ({ name: x.name, count: x.count })) : findCards(swapCards[2], d);
    const to = findCards(swapCards[3], d);
    if (from.length && to.length) {
      const missing = from.filter((f) => !inDeck(d, f.name));
      if (missing.length) return { calls: [], answer: () => `${listOf(missing.map((f) => f.name))} ${missing.length > 1 ? "aren't" : "isn't"} in this deck, so there's nothing to swap out.` };
      const have = (n: string) => d.main.filter((x) => x === n).length + d.extra.filter((x) => x === n).length;
      // "swap red eyes wyvern for 1 axe of despair": one for one; with no counts at all, every copy
      const toCount = to.every((f) => f.count !== null) ? to.reduce((a, f) => a + (f.count ?? 0), 0) : null;
      const rm = from.map((f) => ({ name: f.name, count: Math.min(have(f.name), f.count ?? (from.length === 1 && toCount ? toCount : have(f.name))) }));
      const add = to.map((f, i) => ({ name: f.name, count: f.count ?? (to.length === 1 ? Math.min(COPIES, rm.reduce((a, x) => a + x.count, 0)) : rm[i]?.count ?? 1) }));
      // a swap goes through whole or not at all: never a card cut with nothing in its place
      const sim = runTool(w, 'edit_deck', { remove: rm, add });
      if (refusedOf(sim.text) && add.some((a) => !new RegExp(`\\+\\d+ ${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(,|\\.|$)`, 'm').test(sim.text))) return { calls: [], answer: () => `I couldn't swap: ${refusedOf(sim.text)}. Nothing changed.` };
      return {
        calls: [{ name: 'edit_deck', input: { remove: rm, add } }],
        answer: (rs) => {
          const refused = refusedOf(rs[0] ?? '');
          const done = rs[0]?.match(/^Done: (.*)\.$/m)?.[1];
          return `${done && done !== 'Nothing changed' ? `Swapped: ${done}.` : 'Nothing changed.'}${refused ? ` ${refused}.` : ''}`;
        },
      };
    }
    // "replace them with level 4s": the best monsters that need no Tribute
    if (from.length && !to.length && /^(level (4|four)s?|level (4|four) (monsters|ones)|lv ?4s?|small(er)? (monsters|ones)|ones? (that|which) (need|needs) no tributes?|no tribute (monsters|ones)|non tribute)/.test(swapCards[3].trim())) {
      const outs = from.flatMap((f) => Array(Math.min(f.count ?? 99, d.main.filter((x) => x === f.name).length)).fill(f.name) as string[]);
      const rest = { ...d, main: [...d.main] };
      for (const n of outs) rest.main.splice(rest.main.indexOf(n), 1);
      const ins: string[] = [];
      for (let i = 0; i < outs.length; i++) {
        const c = candidates(w, { ...rest, main: [...rest.main, ...ins] }, (x) => x.kind === 'monster' && (x.level ?? 4) <= 4 && !isExtraCard(x.name) && x.sub !== 'Ritual' && ins.filter((m) => m === x.name).length < 2)[0];
        if (!c) break;
        ins.push(c.name);
      }
      if (!ins.length) return { calls: [], answer: () => 'You have no more Level 4 or lower monsters that fit.' };
      const gone = outs.slice(0, ins.length);
      return { calls: [{ name: 'edit_deck', input: { remove: counts(gone), add: counts(ins) } }], answer: () => `Swapped ${listOf(gone)} for ${listOf(ins)}, which need no Tribute.` };
    }
    if (from.length && !to.length && /^(something|a better|better|stronger|a stronger|a good|good|anything)\b/.test(swapCards[3].trim())) {
      const race = deckRace(d);
      const rest = { ...d, main: [...d.main] };
      const outs: string[] = [];
      const ins: string[] = [];
      for (const f of from) {
        const c = cd(f.name);
        if (!c || !inDeck(d, f.name)) continue;
        rest.main.splice(rest.main.indexOf(f.name), 1);
        const b = candidates(w, { ...rest, main: [...rest.main, ...ins] }, (x) => x.kind === c.kind && !isExtraCard(x.name) && x.sub !== 'Ritual' && (c.kind !== 'monster' || !race || x.race === race || c.race !== race) && worth(x, rest) > worth(c, rest))[0];
        if (b) (outs.push(f.name), ins.push(b.name));
        else rest.main.push(f.name);
      }
      if (!ins.length) return { calls: [], answer: () => `${listOf(from.map((f) => f.name))} is already the best you own for that slot.` };
      return { calls: [{ name: 'edit_deck', input: { remove: counts(outs), add: counts(ins) } }], answer: () => `Swapped ${outs.map((o, i) => `${o} → ${ins[i]}`).join('; ')}.` };
    }
    if (from.length && !to.length && findOutside(swapCards[3])) return { calls: [], answer: () => outsideLine(findOutside(swapCards[3])!) };
  }

  const swapTo = t.match(/^(?:swap|replace|trade|switch|exchange)\b.+?\b(?:for|with)\s+(?:an?\s+|some\s+|the\s+|[1-3]\s+)?(.+)$/)?.[1];
  // "replace the spells with machines": that kind out, monsters of that Type in
  const fromKind = t.match(new RegExp(`^(?:swap|replace|trade|switch|exchange)\\s+(?:out\\s+)?(?:all\\s+)?(?:the\\s+|my\\s+)?(?:([1-9])\\s+)?${KIND_RE}\\s+(?:for|with)\\b`));
  const toWhat = swapTo?.replace(/\s*\bmonsters?\b\s*/, ' ').trim();
  const toRace = toWhat && fromKind && !new RegExp(`\\b${KIND_RE}\\b`).test(toWhat) ? readWish(toWhat, w).theme : null;
  if (fromKind && toRace && (toRace.kind === 'race' || toRace.kind === 'attribute') && d.main.length) {
    const v = toRace.value;
    const from = kindWord(fromKind[2])!;
    return swapKinds(w, from, 'monster', fromKind[1] ? Number(fromKind[1]) : null, (c) => (toRace.kind === 'race' ? c.race === v : c.attribute === v) && c.sub !== 'Ritual', toRace.kind === 'race' ? plural(v) : `${v} monsters`);
  }
  // "swap the traps for zzzz": a target nobody can find isn't a reason to swap something else in
  if (swapTo && !new RegExp(`\\b${KIND_RE}\\b`).test(swapTo) && !/\b(something|anything|better|stronger|good|best|others?|another|different|new|ones?|cards?|it|them|that|those|this)\b/.test(swapTo) && !findCards(swapTo, d, 'cards').length && !findOutside(swapTo) && !readWish(swapTo, w).around && readWish(swapTo, w).theme.kind === 'any') return { calls: [], answer: () => `I couldn't find a Speed Duel card called "${swapTo}", so I left the deck as it is. Check the spelling, or say "swap it for something stronger".` };
  // swap one kind for another
  const sw = t.match(new RegExp(`\\b${KIND_RE}\\b.*\\b(for|with|into|to|by)\\b(?: \\w+){0,2} ${KIND_RE}\\b`));
  if (sw && /\b(swap|replace|trade|change|switch|exchange|turn|instead)\b/.test(t) && kindWord(sw[1]) !== kindWord(sw[3])) {
    const n = t.match(/\b([1-9])\b/)?.[1];
    return swapKinds(w, kindWord(sw[1])!, kindWord(sw[3])!, n ? Number(n) : null);
  }

  // "no more than 2 big monsters", "only 3 traps": cut down to that many, refilling with other cards
  const most = t.match(new RegExp(`\\b(?:no more than|not more than|at most|max(?:imum)?(?: of)?|only|just|up to|cap (?:it |them )?at|limit (?:it |them )?to)\\s+(\\d{1,2}|one|two|three|four|five|six|seven|eight)\\s+(?:(big|high level|tribute|level 5|level 7|level five|level seven)\\s+)?${KIND_RE}\\b`));
  if (most && d.main.length && !/^(add|put|include)\b/.test(t)) {
    const n = /^\d+$/.test(most[1]) ? Number(most[1]) : ({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 } as Record<string, number>)[most[1]];
    const kind = kindWord(most[3])!;
    const lo = most[2] ? (/7|seven/.test(most[2]) ? 7 : 5) : 0;
    const these = (c?: CardInfo) => !!c && c.kind === kind && !isExtraCard(c.name) && (!lo || (c.level ?? 0) >= lo);
    const label = lo ? `monsters of Level ${lo} or higher` : `${kind}s`;
    const all = d.main.filter((x) => these(cd(x)));
    if (all.length <= n) return { calls: [], answer: () => `It has ${all.length} ${label} already${all.length ? ` (${listOf(all)})` : ''}, no more than ${n}.` };
    const out = [...all].sort((a, b) => Number(protect.has(a)) - Number(protect.has(b)) || Number(isNeeded(a, d)) - Number(isNeeded(b, d)) || wn(a, d) - wn(b, d)).slice(0, all.length - n);
    const cut: Plan = { calls: [{ name: 'edit_deck', input: { remove: counts(out) } }], answer: () => `Cut it to ${n} ${label}: took out ${listOf(out)}.` };
    return refill(cut, w, lo ? null : kind, (x) => these(cd(x)), d.main.length);
  }
  // "not enough traps", "i need more traps": more of that kind
  const notEnough = t.match(new RegExp(`\\b(?:not enough|too few|need more|needs more|dont have enough|doesnt have enough|lacks?|lacking|raise the number of|increase the number of|increase)\\s+(?:the\\s+)?${KIND_RE}\\b`));
  if (notEnough && d.main.length) return kindShift(w, kindWord(notEnough[1])!, 3);
  // "swap the spells" with nothing named: the weakest of that kind out, better ones of the same kind in
  const refresh = t.match(new RegExp(`\\b(?:swap|replace|change|refresh|upgrade|switch)\\b(?: out)?(?: the| my| all| some)? ${KIND_RE}\\b`));
  if (refresh && !/\b(for|with|into|to)\b/.test(t.slice((refresh.index ?? 0) + refresh[0].length)) && d.main.length) {
    const kind = kindWord(refresh[1])!;
    const mine = d.main.filter((n) => cd(n)?.kind === kind && !isExtraCard(n) && !isNeeded(n, d) && !protect.has(n)).sort((a, b) => wn(a, d) - wn(b, d));
    const rest = { ...d, main: [...d.main] };
    const outs: string[] = [];
    const ins: string[] = [];
    for (const n of mine.slice(0, 3)) {
      rest.main.splice(rest.main.indexOf(n), 1);
      const c = candidates(w, { ...rest, main: [...rest.main, ...ins] }, (x) => x.kind === kind && !isExtraCard(x.name) && x.sub !== 'Ritual' && !d.main.includes(x.name) && !ins.includes(x.name) && worth(x, rest) > wn(n, rest))[0];
      if (!c) (rest.main.push(n));
      else (outs.push(n), ins.push(c.name));
    }
    if (!ins.length) return { calls: [], answer: () => `Your ${kind}s are already the best ones you own for this deck.` };
    return { calls: [{ name: 'edit_deck', input: { remove: counts(outs), add: counts(ins) } }], answer: () => `Swapped ${kind}s: ${outs.map((o, i) => `${o} → ${ins[i]}`).join('; ')}.` };
  }
  // more / fewer of a kind
  const more = t.match(new RegExp(`\\b(more|extra|add some|add a few|add more|lots of|a lot of|plenty of|loads of)\\s+${KIND_RE}\\b`));
  const fewer = t.match(new RegExp(`\\b(less|fewer|cut some|remove some|cut a few|remove a few|not so many|too many|no more|stop adding|enough|lower the number of|reduce the number of|reduce|lower|decrease|decrease the number of)\\s+(?:the\\s+)?${KIND_RE}\\b`));
  if (fewer) return kindShift(w, kindWord(fewer[2])!, -3);
  if (more) return kindShift(w, kindWord(more[2])!, 3);

  // remove all of a kind
  const rk = t.match(new RegExp(`\\b(remove|take out|take|get rid of|no|drop|delete|cut|without|dont want|dont like|hate|not a fan of|sick of|tired of)\\s+(?:all\\s+)?(?:of\\s+)?(half\\s+(?:of\\s+)?)?(?:the\\s+|my\\s+|any\\s+)?${KIND_RE}\\b`));
  // "take out all the traps except mirror force": the cards named after except stay
  const [rkHead, ...rkTail] = t.split(/\b(?:except|but|apart from|other than|besides|aside from|save)\b/);
  const rkKeep = rkTail.length ? new Set(findCards(rkTail.join(' '), d).map((f) => f.name)) : new Set<string>();
  // "except the equips": a kind of spell or trap by its sub-type
  const subWord = rkTail.join(' ').match(/\b(equip|field|continuous|quick ?play|ritual|counter|normal)s?\b/)?.[1].replace(/quick ?play/, 'Quick-Play');
  if (subWord) for (const n of d.main) if (flat(cd(n)?.sub ?? '') === flat(subWord)) rkKeep.add(n);
  if (rk && (!cardsSaid.length || (rkKeep.size && !findCards(rkHead, d).length))) {
    const kind = kindWord(rk[3])!;
    const every = d.main.filter((n) => cd(n)?.kind === kind && !isExtraCard(n) && !rkKeep.has(n));
    // "take out half the monsters"
    const all = rk[2] ? [...every].sort((a, b) => wn(a, d) - wn(b, d)).slice(0, Math.floor(every.length / 2)) : every;
    const kept = all.filter((n) => isNeeded(n, d) && cd(n)?.sub === 'Ritual' || (n === 'Polymerization' && isNeeded(n, d)));
    const out = counts(all.filter((n) => !kept.includes(n)));
    if (!all.length) return { calls: [], answer: () => `There are no ${kind}s in the deck.` };
    if (!out.length) return { calls: [], answer: () => `The only ${kind}s left (${listOf(kept)}) are needed to summon your other cards, so I kept them.` };
    const k = out.reduce((a, x) => a + x.count, 0);
    const spared = [...rkKeep].filter((n) => d.main.includes(n));
    const cut: Plan = { calls: [{ name: 'edit_deck', input: { remove: out } }], answer: () => `Took out ${k} ${kind}${k === 1 ? '' : 's'}.${spared.length ? ` Kept ${listOf(spared)}.` : rkKeep.size ? ` (${listOf([...rkKeep])} wasn't in the deck.)` : ''}${kept.length ? ` I kept ${listOf(kept)}, which your other cards need to be summoned.` : ''}${kind === 'monster' && !rk[2] ? ' A deck with no monsters has nothing to attack with; say "undo" if that was a slip.' : ''}` };
    return d.main.length - k < MAIN_MIN ? refill(cut, w, kind) : cut;
  }

  // "remove all the extra deck"
  if (/\b(remove|take out|clear|empty|get rid of|delete|cut)\b.*\bextra deck\b/.test(t)) {
    if (!d.extra.length) return { calls: [], answer: () => 'The Extra Deck is already empty.' };
    return { calls: [{ name: 'edit_deck', input: { remove: counts(d.extra) } }], answer: () => `Emptied the Extra Deck (${listOf(d.extra)}).${d.main.includes('Polymerization') ? ' Polymerization has nothing to summon now; say "take out polymerization" too if you like.' : ''}` };
  }
  // "remove 3 cards to make room": the weakest
  const nCards = t.match(/\b(?:remove|take out|cut|drop|lose)\s+(\d|one|two|three|four|five)\s+(?:cards?|things)\b/);
  if (nCards && d.main.length && !cardsSaid.length) {
    const n = /^\d$/.test(nCards[1]) ? Number(nCards[1]) : ({ one: 1, two: 2, three: 3, four: 4, five: 5 } as Record<string, number>)[nCards[1]];
    const out = [...[...d.main].filter((x) => !isNeeded(x, d) && !protect.has(x)).sort((a, b) => wn(a, d) - wn(b, d)), ...[...d.main].filter((x) => isNeeded(x, d) && !protect.has(x)).sort((a, b) => wn(a, d) - wn(b, d))].slice(0, n);
    if (!out.length) return { calls: [], answer: () => 'Every card left is one you asked for by name, so I kept them. Name the ones to cut.' };
    return { calls: [{ name: 'edit_deck', input: { remove: counts(out) } }], answer: () => `Took out ${listOf(out)}, the weakest ${out.length > 1 ? 'cards' : 'card'} here.` };
  }
  // "put in something else", "add replacements": a fill back to the size it should be
  if (/\b(add|put in|put|fill|give)\b.*\b(something else|something better|replacements?|other cards|new cards|something)\b/.test(t) && !cardsSaid.length && d.main.length < MAIN_MIN) return fillPlan(w, MAIN_MIN, mem);
  // "i need more removal", "add something to stop attacks", "add a card that destroys monsters"
  const role = /\b(removal|destroys?|destruction|kill|get rid of their)\b/.test(t) ? 'destroy' : /\b(stop|stops|block|negate|negates) (their |an |the )?attacks?\b|\battack stopper\b/.test(t) ? 'attack' : /\b(cards? that|something that|one that) draws?\b/.test(t) ? 'draw' : null;
  if (role && d.main.length && !cardsSaid.length && /\b(add|need|want|put|more|give|include|get)\b/.test(t) && !/^(what|which|how|is|are)\b/.test(t)) {
    const fit = role === 'destroy' ? (c: CardInfo) => /destroy/i.test(c.desc) && !/destroy this card/i.test(c.desc) : role === 'attack' ? (c: CardInfo) => /negate the attack|end the battle phase|declares an attack|cannot attack|change (that|the attacking) monster to defense/i.test(c.desc) : (c: CardInfo) => /\bdraw\b/i.test(c.desc) && !/opponent draws/i.test(c.desc);
    const n = /\b(a|an|one|something|card)\b/.test(t) && !/\bmore\b/.test(t) ? 1 : 2;
    const ins = candidates(w, d, (c) => c.kind !== 'monster' && !d.main.includes(c.name) && fit(c)).slice(0, n).map((c) => c.name);
    if (!ins.length) return { calls: [], answer: () => `You have no more cards like that which fit${w.collection ? '; get more from packs or the Card Shop' : ''}.` };
    const label = role === 'destroy' ? 'removal' : role === 'attack' ? 'cards that stop attacks' : 'draw power';
    const plan = kindShift(w, cd(ins[0])!.kind as Kind, ins.length, label, (c) => ins.includes(c.name));
    return plan;
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
    const ofKind = [...d.main].filter((x) => !kind || cd(x)?.kind === kind);
    const order = (a: string, b: string) => Number(protect.has(a)) - Number(protect.has(b)) || wn(a, d) - wn(b, d);
    // spare cards first; when every one is a combo piece, the weakest of those
    const out = [...ofKind.filter((x) => !isNeeded(x, d)).sort(order), ...ofKind.filter((x) => isNeeded(x, d)).sort(order)].slice(0, n);
    if (!out.length) return { calls: [], answer: () => `There are no ${kind ?? 'card'}s in this deck to take out.` };
    const cut: Plan = { calls: [{ name: 'edit_deck', input: { remove: counts(out) } }], answer: () => `Took out ${listOf(out)}, the weakest ${kind ?? 'card'}${out.length > 1 ? 's' : ''} here.` };
    // a monster goes for a monster, so the mix stays
    return d.main.length - out.length < MAIN_MIN ? refill(cut, w, null, kind ? (n) => cd(n)?.kind !== kind : undefined) : cut;
  }

  // a style change for the deck that's there ("make it more aggressive")
  if (d.main.length) {
    if (/\b(aggro|aggressive|offensive|beat ?down|faster|attack more|hit harder|more attackers|more damage|high attack|high atk|big attack|strong attackers|more atk)\b/.test(t)) {
      const lows = d.main.map((n) => cd(n)).filter((c) => c?.kind === 'monster' && (c.level ?? 0) <= 4).map((c) => c!.atk ?? 0);
      const floor = Math.min(1600, (lows.length ? Math.max(...lows) : 0) - 100);
      const plan = kindShift(w, 'monster', 3, 'more attackers', (c) => (c.level ?? 0) <= 4 && (c.atk ?? 0) >= floor && c.sub !== 'Ritual');
      return plan.calls.length ? plan : { calls: [], answer: () => `This deck already runs your best attackers that need no Tribute.${w.collection ? ' Open packs or craft in the Card Shop for stronger ones, then ask again.' : ''} Say "make it stronger" to swap weak cards.` };
    }
    if (/\b(defensive|control|safer|slower|more defen[cs]e)\b/.test(t)) return kindShift(w, 'trap', 3, 'more traps to protect your field');
  }

  // add / remove cards (several at once; "that" / "it" means the cards just added)
  // "draw more cards": draw spells in for the weakest cards
  if (/\bdraw (more|extra)?\s*cards?\b|\bmore draw\b/.test(t) && d.main.length) return kindShift(w, 'spell', 2, 'more draws', (c) => /\bdraw\b/i.test(c.desc) && !/opponent draws/i.test(c.desc));
  // "add something that protects my monsters": traps
  if (/\b(protect|protects|protection|defend|guard)\b/.test(t) && d.main.length) return kindShift(w, 'trap', /\b(a|one|something)\b/.test(t) ? 1 : 2, 'protection');
  // "add a dragon", "remove 2 warriors": the best (or weakest) monsters of that Type
  const typeEdit = t.match(/\b(add|put in|put|include|remove|take out|cut|drop|lose|get rid of)\s+(?:(?:all|all of|every|any)\s+)?(?:the\s+|my\s+)?(?:(a|an|one|another|[1-3]|two|three)\s+)?(?:more\s+)?([a-z ]+?)s?$/);
  const typeRace = typeEdit && RACES.find((x) => flat(x) === typeEdit[3].replace(/ies$/, 'y').replace(/s$/, ''));
  if (typeEdit && typeRace && d.main.length) {
    // "take out the warriors" means all of them; "add a dragon" one
    const n = typeEdit[2] ? (/^\d$/.test(typeEdit[2]) ? Number(typeEdit[2]) : NUM[typeEdit[2]] ?? 1) : /^(remove|take out|cut|drop|lose|get rid of)$/.test(typeEdit[1]) && /s$/.test(t) ? 99 : 1;
    const removing = /^(remove|take out|cut|drop|lose)$/.test(typeEdit[1]);
    const fits = (c: CardInfo) => c.kind === 'monster' && c.race === typeRace && !isExtraCard(c.name);
    if (removing) {
      const out = d.main.filter((x) => cd(x) && fits(cd(x)!) && !isNeeded(x, d)).sort((a, b) => wn(a, d) - wn(b, d)).slice(0, n);
      if (!out.length) return { calls: [], answer: () => `There are no ${plural(typeRace)} here I can take out without breaking a combo.` };
      const cut: Plan = { calls: [{ name: 'edit_deck', input: { remove: counts(out) } }], answer: () => `Took out ${listOf(out)}, the ${n >= 99 ? '' : 'weakest '}${out.length > 1 ? plural(typeRace) : typeRace} here.` };
      return d.main.length - out.length < MAIN_MIN ? refill(cut, w, null, (x) => cd(x)?.race === typeRace) : cut;
    }
    const ins: string[] = [];
    for (let i = 0; i < n; i++) {
      const c = candidates(w, { ...d, main: [...d.main, ...ins] }, (x) => fits(x) && x.sub !== 'Ritual' && (x.level ?? 4) <= 6)[0];
      if (c) ins.push(c.name);
    }
    if (!ins.length) return { calls: [], answer: () => `You have no more ${plural(typeRace)} that can go in${w.collection ? '; get more from packs or the Card Shop' : ''}.` };
    return { calls: [{ name: 'edit_deck', input: { add: counts(ins) } }], answer: (rs) => `Added ${listOf(ins)}.${refusedOf(rs[0] ?? '') ? ` ${refusedOf(rs[0])}.` : ''}` };
  }

  // "give it back the traps": the cards of that kind just cut
  const backKind = t.match(new RegExp(`\\b(back|again|return)\\b.*\\b${KIND_RE}|\\b${KIND_RE}\\b.*\\bback\\b`));
  if (backKind && mem.removed.length) {
    const kind = kindWord(backKind[2] ?? backKind[3]);
    const these = mem.removed.filter((n) => !kind || cd(n)?.kind === kind);
    if (these.length) return { calls: [{ name: 'edit_deck', input: { add: counts(these) } }], answer: (rs) => `Put back ${listOf(these)}.${refusedOf(rs[0] ?? '') ? ` ${refusedOf(rs[0])}.` : ''}` };
  }
  const verb = t.match(/\b(dont want|do not want|dont need|dont like|hate|not a fan of|sick of|tired of|add|put in|put|include|throw in|stick in|chuck in|give it|i want|use|run|play with|remove|take out|take|get rid of|drop|cut|delete|lose|minus|no more|without)\b/);
  if (verb) {
    const removing = /^(dont want|do not want|dont need|dont like|hate|not a fan of|sick of|tired of|remove|take out|take|get rid of|drop|cut|delete|lose|minus|no more|without)$/.test(verb[1]);
    // "take kuriboh out but leave sangan": the cards after but/except stay
    const [head, ...tail] = t.split(/\b(?:but|except|apart from|other than|besides|aside from|and leave|and keep)\b/);
    const spared = tail.length && (removing || /\b(but not|but no|except|without)\b/.test(t)) ? new Set(findCards(tail.join(' '), d).map((f) => f.name)) : new Set<string>();
    let found = spared.size ? findCards(head, d).filter((f) => !spared.has(f.name)) : cardsSaid;
    const back = !removing && /\b(back|again)\b/.test(t);
    // "add 3 call of the haunted": in Speed Duel that name is a Skill, never a card
    const skillSaid = !removing && found.length === 1 && cd(found[0].name)?.sub === 'Skill' && /^(add|put in|put|include|throw in)$/.test(verb[1]) ? found[0].name : null;
    if (skillSaid) return { calls: [], answer: () => `${bare(skillSaid)} is a Skill in Speed Duel, not a card for the deck. Say "use ${bare(skillSaid)}" to make it this deck's Skill.` };
    // "put back the dust tornados" when none were taken out
    if (back && found.length && !found.some((f) => mem.removed.includes(f.name)) && !/\b(it|that|those|them|these|him|her)\b/.test(t)) return { calls: [], answer: () => `I didn't take out ${listOf(found.map((f) => f.name))} in this chat. Say "add ${found[0].name}" to put one in.` };
    // "put red eyes back in": the card that was cut, not another Red-Eyes
    if (back && mem.removed.length) found = found.map((f) => (mem.removed.includes(f.name) || !f.said ? f : ((r) => (r ? { ...f, name: r } : f))(mem.removed.find((r) => flat(r).includes(flat(f.said!))))));
    // "add maiden with eyes of blue": a loose match must not stand in for a card Speed Duel never printed
    const outsideAll = !removing && found.length && found.every((f) => f.partial) ? findOutside(t) : null;
    // "add maiden with eyes of blue" is not Maiden of Macabre: a loose match needs most of the words said
    const loose = (f: { name: string; partial?: boolean; said?: string }) => {
      if (removing || !f.partial || !f.said) return false;
      // one card asked for: judge against everything said after the verb, not just the words that matched
      const whole = found.length === 1 ? t.slice((verb.index ?? 0) + verb[0].length).replace(/^\s*(?:[1-3]|an?|one|two|three)\s+/, '').trim() : f.said;
      f.said = whole || f.said;
      const ws = f.said.split(' ').filter((x) => x.length >= 3 && !STOP.has(x) && !INTENT.has(x) && !(x in NUM));
      return ws.length >= 3 && ws.filter((x) => ` ${flat(f.name)} `.includes(` ${x}`)).length * 2 < ws.length;
    };
    const tooLoose = found.filter(loose);
    if (tooLoose.length && tooLoose.length === found.length) return { calls: [], answer: () => `I couldn't find a Speed Duel card called "${tooLoose[0].said}". It may not be in Speed Duel, or check the spelling.` };
    found = found.filter((f) => !loose(f));
    if (outsideAll && !found.some((f) => flat(f.name).includes(flat(outsideAll))) && !nameIndex().some((x) => x.flat.startsWith(`${flat(outsideAll)} `))) return { calls: [], answer: () => outsideLine(outsideAll) };
    const recent = back ? mem.removed : mem.focus && (!removing || inDeck(d, mem.focus)) ? [mem.focus] : mem.added;
    // "use that one" after a Skill was suggested
    const fs = mem.focus;
    if (!found.length && !removing && fs && cd(fs)?.sub === 'Skill' && /\b(that|it|that one|this one)\b/.test(t)) return fs === d.skill ? { calls: [], answer: () => `${bare(fs)} is already this deck's Skill.` } : { calls: [{ name: 'edit_deck', input: { skill: fs } }], answer: (rs) => (refusedOf(rs[0] ?? '') ? `Couldn't: ${refusedOf(rs[0])}.` : `Now using ${bare(fs)}.`) };
    if (!found.length && /\b(that|it|those|them|these|this one|that one|they|her|him|another( one)?|one more|same( one)?|the same)\b/.test(t) && recent.length) {
      // "take that out" -> the cards just added; "put them back" -> the cards just cut; "add another of those" -> one more
      const said = t.match(/\b([1-9]|one|two|three|a|an)\b(?= of)/)?.[1];
      const k = said ? (/^\d$/.test(said) ? Number(said) : NUM[said]) : null;
      // "take out the last 2 cards you added": the newest 2
      found = removing && k && recent.length > 1 ? counts(recent.slice(-k)).map((x) => ({ name: x.name, count: x.count })) : counts(recent).map((x) => ({ name: x.name, count: k ?? (removing || back ? x.count : 1) }));
    }
    if (found.length) {
      // "take out kuriboh" takes the card out (every copy); "take out 1 kuriboh" takes one
      const list = found.map((f) => ({ name: f.name, count: f.count ?? (removing ? Math.max(1, d.main.filter((n) => n === f.name).length + d.extra.filter((n) => n === f.name).length) : 1) })).filter((f) => f.count > 0);
      if (!removing) mem.wanted = [...new Set([...(mem.wanted ?? []), ...list.map((f) => f.name)])];
      if (!list.length) return { calls: [], answer: () => 'Zero copies changes nothing. Say how many, like "add 2 Kuriboh".' };
      const out = findOutside(t);
      const outside = out && !list.some((f) => flat(f.name).includes(flat(out))) ? out : null;
      return {
        calls: [{ name: 'edit_deck', input: removing ? { remove: list } : { add: list } }],
        answer: (rs) => {
          const refused = refusedOf(rs[0] ?? '');
          const done = rs[0]?.match(/^Done: (.*)\.$/m)?.[1];
          const ok = done && done !== 'Nothing changed' ? `${removing ? 'Took out' : 'Added'} ${done.replace(/^[-+]/, '').replace(/, [-+]/g, ', ')}.` : 'Nothing changed.';
          const left = Number(rs[0]?.match(/\bMain (\d+)/)?.[1] ?? MAIN_MIN);
          const low = removing && left < MAIN_MIN ? ` It has ${left} cards now and needs ${MAIN_MIN} to duel: say "fill it up" or add cards by name.` : '';
          // taking out a card others need leaves them stranded: say so
          const needs = removing ? list.map((f) => [f.name, dependents(f.name, d)] as const).filter(([n, by]) => by.length && d.main.filter((x) => x === n).length <= (list.find((f) => f.name === n)?.count ?? 0) && !list.some((x) => by.includes(x.name))) : [];
          const warn = needs.map(([n, by]) => ` ${listOf(by)} ${by.length > 1 ? 'need' : 'needs'} ${n} to be summoned or to work; say "take out ${by[0]}" too, or "undo".`).join('');
          const kept = spared.size ? (removing ? ` Kept ${listOf([...spared])}.` : ` Left out ${listOf([...spared])}.`) : '';
          // say how a loose name was read ("red eyes black chick" -> Red-Eyes Black Dragon), and what matched nothing
          const read = found.filter((f) => f.partial && f.said && f.said.split(' ').some((x) => x.length >= 3 && !` ${flat(f.name)} `.includes(` ${x}`) && !` ${flat(f.name)} `.includes(`${x} `))).map((f) => ` I took "${f.said}" to mean ${f.name}.`).join('');
          const lost = t
            .replace(/^.*?\b(add|put in|put|include|throw in|stick in|chuck in|give it|i want|use|run|play with|remove|take out|take|get rid of|drop|cut|delete|lose|minus|no more|without)\b/, '')
            .split(/,|\b(?:and|plus|also|with)\b/)
            .map((x) => x.trim())
            .filter((x) => x.split(' ').some((y) => y.length >= 3 && !STOP.has(y) && !INTENT.has(y) && !(y in NUM) && !/^\d+$/.test(y)) && !findCards(x, d).length && !findOutside(x) && !/^(?:(?:him|her|it|them|that|those|this|one) )?(?:back|again)(?: in| on)?$/.test(x));
          const missed = lost.length ? ` I couldn't find a Speed Duel card called ${lost.map((x) => `"${x.replace(/^(\d+|an?|one|two|three) /, '')}"`).join(' or ')}.` : '';
          return `${ok}${kept}${read}${missed}${refused ? ` ${refused}.` : ''}${outside ? ` ${outsideLine(outside)}` : ''}${warn}${low}`;
        },
      };
    }
    const other = findOutside(t);
    // "add harpie lady": the old card isn't in Speed Duel, but Harpie Lady 1 is
    const alt = other && !removing ? nameIndex().filter((x) => !x.skill && x.flat.startsWith(`${flat(other)} `) && !unplayableReason(x.name)).sort((a, b) => Number(/ \d+$/.test(b.flat)) - Number(/ \d+$/.test(a.flat)) || a.flat.length - b.flat.length)[0] : undefined;
    if (alt) {
      mem.wanted = [...new Set([...(mem.wanted ?? []), alt.name])];
      const n = Number(t.match(/\b([1-3])\b/)?.[1] ?? 1);
      return { calls: [{ name: 'edit_deck', input: { add: [{ name: alt.name, count: n }] } }], answer: (rs) => (refusedOf(rs[0] ?? '') ? `Couldn't: ${refusedOf(rs[0])}.` : `${other} isn't a Speed Duel card, but ${alt.name} is, so I added ${n > 1 ? `${n} ` : ''}${alt.name}.`) };
    }
    if (other) return { calls: [], answer: () => outsideLine(other) };
    // "add exodia": a family that only exists outside Speed Duel
    findOutside('');
    const goneFam = t.split(' ').find((x) => x.length >= 4 && !STOP.has(x) && !INTENT.has(x) && ((others ?? []).filter((o) => ` ${o.flat} `.includes(` ${x} `)).length >= 2 || (x.length >= 5 && (others ?? []).some((o) => o.flat.startsWith(`${x} `)))) && !nameIndex().some((c) => !c.skill && ` ${c.flat} `.includes(` ${x} `)));
    if (goneFam) return { calls: [], answer: () => `${deckTitle(goneFam)} cards aren't in Speed Duel (Konami never printed them in a Speed Duel product), so there's nothing to ${removing ? 'take out' : 'add'}.` };
    if (/\b(that|it|those|them|these|they)\b/.test(t) && !new RegExp(KIND_RE).test(t)) return { calls: [], answer: () => `Which card? Say its name, like "${removing ? 'take out' : 'add'} Kuriboh". To take back the whole last change, say "undo".` };
    const k = t.match(new RegExp(`\\b(a|an|one|another|[1-3]|two|three)?\\s*${KIND_RE}\\b`));
    if (k && kindWord(k[2])) {
      const n = k[1] ? (/^[1-3]$/.test(k[1]) ? Number(k[1]) : NUM[k[1]] ?? 1) : 1;
      return kindShift(w, kindWord(k[2])!, removing ? -n : n, undefined, undefined, !removing, removing);
    }
    if (!/\b(deck|monsters?|spells?|traps?|stronger|better)\b/.test(t)) return { calls: [], answer: () => `I couldn't tell which card you meant. Say its name, like "${removing ? 'take out' : 'add'} 2 Kuriboh".${nearest(t)}` };
  }

  // make it stronger ("less random" and "more consistent" too: fewer one-off weak cards)
  if (/\b(less random|more consistent|consistent)\b/.test(t) && d.main.length) return strongerPlan(w);
  if (cardsSaid.length && /\b(swap|replace|trade|switch)\b/.test(t)) {
    const fromText = swapCards?.[2] ?? '';
    const fromOut = fromText ? findOutside(fromText) : null;
    if (fromText && !findCards(fromText, d).length) return { calls: [], answer: () => (fromOut ? outsideLine(fromOut) : `I couldn't find "${fromText}" in this deck, so there's nothing to swap out.`) };
    const gone = (fromText ? findCards(fromText, d) : cardsSaid).map((c) => c.name).filter((n) => !inDeck(d, n));
    return { calls: [], answer: () => (gone.length ? `${listOf(gone)} ${gone.length > 1 ? "aren't" : "isn't"} in this deck, so there's nothing to swap out. Say "add ${gone[0]}" to put it in.` : 'Say it like "replace Kuriboh with Sangan" and I\'ll swap them.') };
  }
  if (/\b(stronger|better|improve|upgrade|optimi[sz]e|power ?up|beef|buff|boost|fix it|fix my deck|fix the deck|swap|replace|tune|polish)\b|\b(win|winning|wins) more\b|\bhelp me win\b|\bso i (can )?win\b/.test(t)) return strongerPlan(w);

  // questions about a card
  const exactSkill = nameIndex().find((x) => x.skill && ` ${t} `.includes(` ${x.flat} `));
  const name = exactSkill?.name ?? (cardsSaid.find((f) => !f.partial) ?? cardsSaid[0])?.name ?? findCard(t, 'skills', d);
  if (name) return cardPlan(name, w, /\b(good|worth|strong|bad|any good|should i (use|run|play))\b/.test(t));
  const other = findOutside(t);
  if (other) return { calls: [], answer: () => `${outsideLine(other)} ${short(cd(other)?.desc ?? '')}`.trim() };

  // any deck-shaped wish left builds one
  if (/\b(deck|random|surprise)\b/.test(t) && !d.main.length) return buildPlan(t, w);
  return { calls: [], answer: () => `I'm not sure what you mean.${nearest(t)} ${HELP}` };
}

/** Plans each part against the deck as the parts before it leave it, then answers them in order. */
function multiPlan(parts: string[], w: ChatWorld, mem: Memory, whole: string): Plan {
  const out = multiPlanOf(parts, w, mem, whole);
  split = true;
  return out;
}
function multiPlanOf(parts: string[], w: ChatWorld, mem: Memory, whole: string): Plan {
  let world = w;
  const plans: Plan[] = [];
  for (const p of parts) {
    const pl = planFor(p, world, mem, true, whole);
    plans.push(pl);
    for (const c of pl.calls) {
      const r = runTool(world, c.name, c.input);
      if (r.deck) world = { ...world, deck: r.deck };
    }
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
      // the screen paints the message first, and Stop can land before any work
      await new Promise((r) => setTimeout(r, 60));
      if (signal?.aborted) throw stopped();
      plan = planFor(text, getWorld(), mem);
      await new Promise((r) => setTimeout(r, 60));
      if (signal?.aborted) throw stopped();
      if (plan.calls.length) {
        // remember what this change touches (every edit in it), for "take that out" and "why that one?"
        const edits = plan.calls.filter((c) => c.name === 'edit_deck').map((c) => c.input as { clear?: boolean; add?: { name: string; count?: number }[]; remove?: { name: string; count?: number }[] });
        if (edits.length) mem.focus = null;
        if (edits.some((e) => e.clear)) {
          mem.added = [];
          mem.removed = [];
          pending = null;
        } else if (edits.length) {
          pending = { added: edits.flatMap((e) => (e.add ?? []).flatMap((x) => Array(x.count ?? 1).fill(x.name))), removed: edits.flatMap((e) => (e.remove ?? []).flatMap((x) => Array(x.count ?? 1).fill(x.name))) };
        } else {
          pending = null;
          const asked = plan.calls.find((c) => c.name === 'get_cards')?.input as { names?: string[] } | undefined;
          if (asked?.names?.length === 1) mem.focus = asked.names[0];
        }
        return { stop_reason: 'tool_use', content: plan.calls.map((c, i) => ({ type: 'tool_use', id: `local${Date.now()}${i}`, name: c.name, input: c.input })) as unknown as Block[] } as ModelReply;
      }
    }
    const results = isResults ? blocks.map((b) => String(b.content ?? '')) : [];
    // remember what this change touched, for "take that out" and "why that one?", if it went through
    if (pending && results.some((x) => /^Done: (?!Nothing changed)/m.test(x))) {
      const lines = results.map((x) => x.match(/^Done: (.*)$/m)?.[1] ?? '').filter(Boolean);
      const names = new Set(lines.flatMap((line) => line.replace(/\.$/, '').split(', ').map((x) => x.replace(/^[-+]\d* ?/, '').trim())));
      // "take that out" after a cut still means the cards last put in
      const put = pending.added.filter((n) => names.has(n));
      if (put.length) mem.added = put;
      mem.removed = pending.removed.filter((n) => names.has(n));
      mem.cut = [...new Set([...(mem.cut ?? []).filter((n) => !mem.added.includes(n)), ...mem.removed])];
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

/** for tests: how the helper rates a card in a deck */
export const worthIn = (n: string, d: SpeedDeck) => wn(n, d);
export const wishOf = (t: string, w: ChatWorld) => readWish(t, w);
