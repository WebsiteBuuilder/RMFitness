// The random deck maker: builds a legal deck that can actually duel from whatever cards a
// pool offers (a duelist's collection, or every card for an "Anything goes" deck). It is
// not a coin flip per card: it picks a theme, keeps a sensible monster/spell/trap split,
// favors monsters you can summon early, only takes support cards whose named cards,
// Types or Attributes are really in the deck, adds Fusions with their materials and
// Polymerization, Xyz Monsters whose Rank the deck can reach, and a Skill that fits.
import { card } from './db';
import type { CardInfo } from './types';

export interface DeckRules {
  mainMin: number;
  mainMax: number;
  extraMax: number;
  copies: number;
  /** card subtypes that live in the Extra (or Fusion) Deck */
  extraKinds: string[];
  /** Limited List status ('Forbidden', 'Limited 2'...) or null; one shared total per 'Limited n' group */
  limit?: (name: string) => string | null;
}

export interface RandomPool {
  /** card name -> copies the maker may use (already capped by ownership and the copy limit) */
  cards: Record<string, number>;
  /** Skills it may pick from (Speed Duel only) */
  skills: string[];
}

export type RandomStyle = 'balanced' | 'beatdown' | 'control';
export type RandomTheme = { kind: 'any' } | { kind: 'surprise' } | { kind: 'attribute'; value: string } | { kind: 'race'; value: string };

export interface RandomOptions {
  /** Main Deck size wanted */
  size: number;
  style?: RandomStyle;
  theme?: RandomTheme;
  /** cards to keep and build around (the deck being edited) */
  keep?: { main: string[]; extra: string[]; skill: string | null };
  rand?: () => number;
}

export interface RandomDeck {
  main: string[];
  extra: string[];
  skill: string | null;
  /** what the deck is about, for the preview: "DARK Spellcasters" */
  label: string;
  notes: string[];
}

export type RandomResult = RandomDeck | { error: string };

export const ATTRIBUTES = ['DARK', 'LIGHT', 'EARTH', 'WATER', 'FIRE', 'WIND'];
const RACES = ['Warrior', 'Spellcaster', 'Dragon', 'Fiend', 'Machine', 'Zombie', 'Beast', 'Beast-Warrior', 'Winged Beast', 'Fairy', 'Insect', 'Dinosaur', 'Reptile', 'Fish', 'Sea Serpent', 'Aqua', 'Pyro', 'Thunder', 'Rock', 'Plant', 'Psychic', 'Cyberse', 'Wyrm'];

const plural = (r: string) => (/(Fish|Psychic|Cyberse)$/.test(r) ? r : r.endsWith('y') ? r.slice(0, -1) + 'ies' : r + 's');

/** The themes a pool can carry: Attributes and Types with enough monsters to fill a deck's monster slots. */
export function themesOf(pool: RandomPool, rules: DeckRules, size: number): { attributes: string[]; races: string[] } {
  const need = Math.max(8, Math.round(size * 0.4));
  const count = (f: (c: CardInfo) => boolean) => Object.entries(pool.cards).reduce((a, [n, k]) => a + (isMainMonster(n, rules) && f(card(n)!) ? k : 0), 0);
  return {
    attributes: ATTRIBUTES.filter((a) => count((c) => c.attribute === a) >= need),
    races: RACES.filter((r) => count((c) => c.race === r) >= need),
  };
}

const isExtra = (n: string, rules: DeckRules) => rules.extraKinds.includes(card(n)?.sub ?? '');
const isMainMonster = (n: string, rules: DeckRules) => card(n)?.kind === 'monster' && !isExtra(n, rules);

/** Names quoted in a card's text, other than its own ("Dark Magician", "Harpie"...). */
function quoted(c: CardInfo): string[] {
  const own = c.name.toLowerCase();
  return [...new Set([...c.desc.matchAll(/"([^"]+)"/g)].map((m) => m[1]))].filter((q) => q.toLowerCase() !== own);
}

/** Fusion materials named at the start of a Fusion Monster's text. */
function namedMaterials(c: CardInfo): string[] | null {
  const m = c.desc.match(/^"[^"]+"(?:\s*\+\s*"[^"]+")+/);
  return m ? [...m[0].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null;
}

const FUSION_SPELL = /Fusion Summon/;

interface Meta {
  quoted: string[];
  /** the card's worth on its own, before it is weighed against the deck */
  base: number;
  fusionSpell: boolean;
  /** the Type / Attribute the card's text supports ("Dragon monsters you control gain...") */
  race: string | null;
  attribute: string | null;
}
const META = new Map<string, Meta>();
const RACE_RE = RACES.map((r) => [r, new RegExp(`\\b${r}(-Type)? monsters?\\b|\\b${r}-Type\\b`)] as const);
const ATTR_RE = ATTRIBUTES.map((a) => [a, new RegExp(`\\b${a} monsters?\\b`)] as const);
function metaOf(c: CardInfo): Meta {
  let m = META.get(c.name);
  if (!m) {
    m = { quoted: quoted(c), base: baseWeight(c), fusionSpell: c.kind === 'spell' && FUSION_SPELL.test(c.desc), race: RACE_RE.find(([, re]) => re.test(c.desc))?.[0] ?? null, attribute: ATTR_RE.find(([, re]) => re.test(c.desc))?.[0] ?? null };
    META.set(c.name, m);
  }
  return m;
}

function baseWeight(c: CardInfo): number {
  const d = c.desc;
  if (c.kind === 'monster') {
    const l = c.level ?? 4;
    const atk = c.atk ?? 0;
    const def = c.def ?? 0;
    let w: number;
    if (l <= 4) w = 0.4 + Math.max(atk, def * 0.8) / 1200 + (c.vanilla ? 0 : 0.7);
    else if (l <= 6) w = Math.max(0.1, (atk - 1700) / 600) + (c.vanilla ? 0 : 0.4);
    else w = Math.max(0.05, (atk - 2300) / 700) + (c.vanilla ? 0 : 0.3);
    if (/cannot be Normal Summoned|must (first )?be Special Summoned/i.test(d)) w *= 0.25;
    if (atk === 0 && def === 0 && c.vanilla) w *= 0.2;
    return w;
  }
  if (c.sub === 'Ritual' || c.sub === 'Ticket' || c.sub === 'Skill') return 0;
  let w = 1;
  if (/destroy/i.test(d)) w *= 1.7;
  if (/negate/i.test(d)) w *= 1.4;
  if (/draw/i.test(d)) w *= 1.3;
  if (/Special Summon/i.test(d)) w *= 1.2;
  if (c.sub === 'Equip') w *= 0.8;
  if (/Ritual Monster|Ritual Summon/i.test(d)) w *= 0.1;
  if (/Pendulum/i.test(d)) w *= 0.1;
  return w;
}

const RITUAL_OF = (c: CardInfo) => c.desc.match(/Ritual Summon "([^"]+)"/)?.[1] ?? null;

export function buildRandomDeck(pool: RandomPool, rules: DeckRules, opts: RandomOptions): RandomResult {
  const rand = opts.rand ?? Math.random;
  const style = opts.style ?? 'balanced';
  const notes: string[] = [];
  const left: Record<string, number> = {};
  for (const [n, k] of Object.entries(pool.cards)) if (k > 0 && card(n) && rules.limit?.(n) !== 'Forbidden') left[n] = Math.min(k, rules.copies);

  const main: string[] = [];
  const extra: string[] = [];
  let skill: string | null = null;
  const has = (n: string) => main.includes(n) || extra.includes(n);
  // What the deck holds so far, worked out again only when it grows.
  let seenAt = -1;
  let names = '';
  const races: Record<string, number> = {};
  const attrs: Record<string, number> = {};
  const refresh = () => {
    if (seenAt === main.length + extra.length * 100) return;
    seenAt = main.length + extra.length * 100;
    names = '\n' + [...new Set([...main, ...extra])].map((n) => n.toLowerCase()).join('\n') + '\n';
    for (const k of Object.keys(races)) delete races[k];
    for (const k of Object.keys(attrs)) delete attrs[k];
    for (const n of main) {
      if (!isMainMonster(n, rules)) continue;
      const c = card(n)!;
      if (c.race) races[c.race] = (races[c.race] ?? 0) + 1;
      if (c.attribute) attrs[c.attribute] = (attrs[c.attribute] ?? 0) + 1;
    }
  };
  /** a card named q (or with q in its name, for archetypes like "Harpie") is in the deck */
  const nameHit = (q: string) => {
    refresh();
    return names.includes(q.toLowerCase());
  };
  const limitFits = (n: string) => {
    const st = rules.limit?.(n);
    if (!st) return true;
    if (st === 'Forbidden') return false;
    const cap = Number(st.slice(-1));
    const inGroup = [...main, ...extra, ...(skill ? [skill] : [])].filter((x) => rules.limit?.(x) === st).length;
    return inGroup < cap;
  };
  const take = (n: string, into: string[]) => {
    if ((left[n] ?? 0) <= 0 || !limitFits(n)) return false;
    left[n]--;
    into.push(n);
    return true;
  };

  // The pool by where a card goes, worked out once.
  const monNames = Object.keys(left).filter((n) => isMainMonster(n, rules));
  const extraNames = Object.keys(left).filter((n) => isExtra(n, rules));
  const kindNames = { spell: Object.keys(left).filter((n) => card(n)!.kind === 'spell'), trap: Object.keys(left).filter((n) => card(n)!.kind === 'trap') };

  // Keep what the deck already has (as far as the pool still allows).
  if (opts.keep) {
    for (const n of opts.keep.main) if (!isExtra(n, rules)) take(n, main);
    for (const n of opts.keep.extra) if (isExtra(n, rules) && extra.length < rules.extraMax) take(n, extra);
    if (opts.keep.skill && pool.skills.includes(opts.keep.skill) && limitFits(opts.keep.skill)) skill = opts.keep.skill;
  }

  const size = Math.max(rules.mainMin, Math.min(rules.mainMax, Math.max(opts.size, main.length)));
  const mainAvail = Object.entries(left).reduce((a, [n, k]) => a + (isExtra(n, rules) ? 0 : k), 0) + main.length;
  if (mainAvail < rules.mainMin) return { error: `A deck needs ${rules.mainMin} cards and you only have ${mainAvail} that can go in one. Open packs or win duels to get more.` };
  const target = Math.min(size, mainAvail);

  // ---------- theme ----------
  let theme = opts.theme ?? { kind: 'surprise' };
  const themes = themesOf({ cards: left, skills: [] }, rules, target);
  if (theme.kind === 'surprise') {
    const r = rand();
    const opts2: RandomTheme[] = [...themes.attributes.map((value) => ({ kind: 'attribute', value }) as RandomTheme), ...themes.races.map((value) => ({ kind: 'race', value }) as RandomTheme)];
    theme = r < 0.25 || opts2.length === 0 ? { kind: 'any' } : opts2[Math.floor(rand() * opts2.length)];
  } else if (theme.kind === 'attribute' && !themes.attributes.includes(theme.value)) {
    notes.push(`Not enough ${theme.value} monsters for a whole deck, so others joined in.`);
  } else if (theme.kind === 'race' && !themes.races.includes(theme.value)) {
    notes.push(`Not enough ${plural(theme.value)} for a whole deck, so others joined in.`);
  }
  const themeValue = theme.kind === 'attribute' || theme.kind === 'race' ? theme.value : null;
  const inTheme = (c: CardInfo) => (theme.kind === 'attribute' ? c.attribute === theme.value : theme.kind === 'race' ? c.race === theme.value : true);

  // ---------- how the deck splits ----------
  const tilt = style === 'beatdown' ? 0.1 : style === 'control' ? -0.08 : 0;
  let wantMon = Math.round(target * (0.55 + tilt));
  let wantSpell = Math.round(target * (style === 'control' ? 0.22 : 0.25));
  const kindCount = (k: CardInfo['kind']) => main.filter((n) => card(n)?.kind === k && (k !== 'monster' || !isExtra(n, rules))).length;
  const tributeCap = Math.max(2, Math.round(target / 8)); // Level 5-6
  const bossCap = Math.max(1, Math.round(target / 15)); // Level 7+
  const lv = (n: string) => card(n)?.level ?? 0;

  // Count deck monsters by Type/Attribute for "support" checks.
  /** Support for named cards: most of them in the deck is good, a few is weak, none is dead. */
  const quotedFit = (qs: string[], none: number) => {
    const hits = qs.filter(nameHit).length;
    return hits === 0 ? none : hits * 2 >= qs.length ? 3 : 0.6;
  };
  const raceCount = (r: string) => (refresh(), races[r] ?? 0);
  const attrCount = (a: string) => (refresh(), attrs[a] ?? 0);
  /** How well a card's text fits the deck so far: named cards present, Types/Attributes it supports present. */
  const fit = (c: CardInfo, building: boolean): number => {
    let w = 1;
    const m = metaOf(c);
    if (m.quoted.length) w *= quotedFit(m.quoted, building ? 0.12 : 0.05);
    if (m.race) w *= raceCount(m.race) >= 4 ? 2 : building && c.kind === 'monster' && c.race === m.race ? 0.8 : 0.15;
    if (m.attribute) w *= attrCount(m.attribute) >= 4 ? 2 : building && c.kind === 'monster' && c.attribute === m.attribute ? 0.8 : 0.15;
    return w;
  };

  const weighted = (cands: [string, number][]): string | null => {
    const total = cands.reduce((a, [, w]) => a + w, 0);
    if (total <= 0) return null;
    let r = rand() * total;
    for (const [n, w] of cands) if ((r -= w) <= 0) return n;
    return cands[cands.length - 1][0];
  };
  const copiesFor = (strong: boolean) => {
    const r = rand();
    return strong ? (r < 0.5 ? 3 : r < 0.85 ? 2 : 1) : r < 0.2 ? 3 : r < 0.6 ? 2 : 1;
  };
  const addCopies = (n: string, k: number, room: () => number) => {
    let got = 0;
    while (got < k && room() > 0 && take(n, main)) got++;
    return got;
  };

  // ---------- monsters ----------
  const monsterWeight = (c: CardInfo): number => {
    if (c.sub === 'Ritual') return 0; // rituals come as a package below
    const l = c.level ?? 4;
    if (l >= 5) {
      const tributes = main.filter((n) => isMainMonster(n, rules) && lv(n) >= 5);
      if (l >= 7 && tributes.filter((n) => lv(n) >= 7).length >= bossCap) return 0;
      if (tributes.length >= tributeCap + bossCap) return 0;
    }
    let w = metaOf(c).base;
    w *= fit(c, true);
    if (themeValue) w *= inTheme(c) ? 4 : 0.06;
    return w * w;
  };
  const monRoom = () => Math.min(wantMon - kindCount('monster'), target - main.length);

  // A Ritual package now and then: the Ritual Monster plus its Ritual Spell.
  const rituals = Object.keys(left).filter((n) => card(n)?.kind === 'spell' && card(n)?.sub === 'Ritual' && RITUAL_OF(card(n)!));
  for (const sp of rituals) {
    const mon = card(RITUAL_OF(card(sp)!)!)?.name;
    if (!mon || (left[mon] ?? 0) <= 0 || has(mon)) continue;
    if (themeValue && !inTheme(card(mon)!)) continue;
    if (rand() < 0.2 && monRoom() >= 2) {
      take(mon, main);
      take(sp, main);
      if (rand() < 0.5) take(sp, main);
      notes.push(`Ritual: ${mon} with ${sp}.`);
      break;
    }
  }

  while (monRoom() > 0) {
    const cands = monNames
      .filter((n) => left[n] > 0 && !has(n) && limitFits(n))
      .map((n) => [n, monsterWeight(card(n)!)] as [string, number])
      .filter(([, w]) => w > 0);
    const n = weighted(cands);
    if (!n) break;
    const c = card(n)!;
    addCopies(n, Math.min((c.level ?? 4) >= 7 ? 1 : 3, copiesFor((c.level ?? 4) <= 4 && monsterWeight(c) > 2)), monRoom);
  }

  // ---------- Extra Deck ----------
  const wantExtra = Math.min(rules.extraMax, Math.max(extra.length, 2 + Math.floor(rand() * 4)));
  const levels: Record<number, number> = {};
  for (const n of main) if (isMainMonster(n, rules)) levels[lv(n)] = (levels[lv(n)] ?? 0) + 1;
  const tuners = main.filter((n) => card(n)?.tuner).length;
  const extraWeight = (c: CardInfo): number => {
    if (c.sub === 'Fusion') {
      const mats = namedMaterials(c);
      if (mats) return mats.every((m) => nameHit(m)) ? 6 : 0;
      // "2 Dragon monsters" style: needs a body of that Type/Attribute
      const r = RACES.find((x) => new RegExp(`^\\d\\+? ${x}`).test(c.desc));
      return r && raceCount(r) >= 5 ? 1.5 : 0;
    }
    if (c.sub === 'Xyz') return (levels[c.rank ?? 0] ?? 0) >= 4 ? 2.5 : 0;
    if (c.sub === 'Synchro') return tuners >= 2 && !/^"/.test(c.desc) ? 2 : 0;
    if (c.sub === 'Link') return metaOf(c).quoted.length === 0 || metaOf(c).quoted.some(nameHit) ? 1 : 0;
    return 0;
  };
  while (extra.length < wantExtra) {
    const cands = extraNames
      .filter((n) => left[n] > 0 && limitFits(n) && extra.filter((x) => x === n).length < 2)
      .map((n) => [n, extraWeight(card(n)!) * fit(card(n)!, false)] as [string, number])
      .filter(([, w]) => w > 0.2);
    const n = weighted(cands);
    if (!n) break;
    take(n, extra);
  }
  // Fusions need a way to Fusion Summon.
  const fusions = extra.filter((n) => card(n)?.sub === 'Fusion');
  if (fusions.length && !main.some((n) => card(n)?.kind === 'spell' && FUSION_SPELL.test(card(n)!.desc))) {
    const spell = left['Polymerization'] ? 'Polymerization' : Object.keys(left).find((n) => left[n] > 0 && card(n)?.kind === 'spell' && /^Fusion Summon 1 Fusion Monster/.test(card(n)!.desc));
    if (spell && main.length < target && take(spell, main)) {
      if (rand() < 0.6 && main.length < target) take(spell, main);
    } else {
      for (const f of fusions) {
        extra.splice(extra.indexOf(f), 1);
        left[f]++;
      }
    }
  }

  // ---------- Spells and Traps ----------
  const hasFusion = extra.some((n) => card(n)?.sub === 'Fusion');
  const backrowWeight = (c: CardInfo): number => {
    const m = metaOf(c);
    if (!m.base) return 0;
    if (m.fusionSpell && !hasFusion) return 0;
    let w = m.base;
    if (c.sub === 'Field') w *= themeValue && c.desc.includes(themeValue) ? 3 : 0.4;
    w *= fit(c, false);
    return w * w;
  };
  const room = (k: 'spell' | 'trap') => () => Math.min(k === 'spell' ? wantSpell - kindCount('spell') : target - main.length, target - main.length);
  for (const k of ['spell', 'trap'] as const) {
    const r = room(k);
    while (r() > 0) {
      const cands = kindNames[k]
        .filter((n) => left[n] > 0 && !has(n) && limitFits(n))
        .map((n) => [n, backrowWeight(card(n)!)] as [string, number])
        .filter(([, w]) => w > 0);
      const n = weighted(cands);
      if (!n) break;
      addCopies(n, copiesFor(backrowWeight(card(n)!) > 4), r);
    }
  }
  // Short of the size wanted (a thin collection): fill with anything that fits.
  const fillRoom = () => target - main.length;
  for (let guard = 0; fillRoom() > 0 && guard < 400; guard++) {
    const cands = Object.keys(left)
      .filter((n) => left[n] > 0 && !isExtra(n, rules) && limitFits(n))
      .map((n) => {
        const c = card(n)!;
        return [n, c.kind === 'monster' ? Math.max(0.01, monsterWeight(c)) + 0.01 : Math.max(0.01, backrowWeight(c))] as [string, number];
      });
    const n = weighted(cands);
    if (!n) break;
    take(n, main);
  }
  if (main.length < rules.mainMin) return { error: `Only ${main.length} cards could go in the deck; it needs ${rules.mainMin}.` };

  // ---------- Skill ----------
  if (!skill && pool.skills.length) {
    const cands = pool.skills
      .filter((s) => limitFits(s) && card(s))
      .map((s) => {
        const c = card(s)!;
        const d = c.desc;
        let w = metaOf(c).quoted.length ? quotedFit(metaOf(c).quoted, 0.05) * 1.3 : 1;
        // Skills that boost Types or Attributes: great when the deck has them, dead weight when not.
        const races = RACES.filter((r) => d.includes(r));
        const attrs = ATTRIBUTES.filter((a) => d.includes(a));
        if (races.length || attrs.length) w *= (!races.length || races.some((r) => raceCount(r) >= 4)) && (!attrs.length || attrs.some((a) => attrCount(a) >= 4)) ? 5 : 0.08;
        if (/roll a (six-sided )?die|toss a coin|flip a coin/i.test(d)) w *= main.some((n) => /roll a (six-sided )?die|toss a coin|flip a coin/i.test(card(n)?.desc ?? '')) ? 4 : 0.05;
        if (/Pendulum|Ritual/i.test(d)) w *= 0.1;
        return [s, w * w] as [string, number];
      })
      .filter(([, w]) => w > 0.05);
    skill = weighted(cands);
  }

  const label = theme.kind === 'attribute' ? `${theme.value} deck` : theme.kind === 'race' ? `${plural(theme.value)} deck` : 'Mixed deck';
  return { main, extra, skill, label, notes };
}

/** The deck's split, for the preview line. */
export function deckSplit(main: string[]): { monsters: number; spells: number; traps: number } {
  const k = (x: string) => main.filter((n) => card(n)?.kind === x).length;
  return { monsters: k('monster'), spells: k('spell'), traps: k('trap') };
}
