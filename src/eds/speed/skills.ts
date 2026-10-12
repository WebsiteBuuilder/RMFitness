// Skill scripts for Speed Duel, keyed by Skill name.
// Skills are not card effects: they cannot be chained to or negated. "Once per Duel" is the
// engine's default for `use`; Skills that have several parts each "once per Duel" track them
// with e.oncePerDuel(key). Continuous Skills that have no activation start face-up (startOfDuel).
import type { SkillDef } from '../skills';
import type { Choice, Engine, Step } from '../engine';
import type { Card, FieldCard, Pid, Prompt } from '../types';

// This file has no runtime imports on purpose: src/eds/skills.ts loads it, the engine loads
// skills.ts, and a value import here (helpers -> engine -> effects -> card batches) would
// make the module graph circular. These are local copies of the helpers.ts basics.
type Gen<T> = Generator<Prompt, T, Choice>;
const other = (p: Pid): Pid => (p === 0 ? 1 : 0);
const info = (e: Engine, c: Card | string) => e.info(typeof c === 'string' ? c : c.name);
const isMonster = (e: Engine, c: Card) => info(e, c).kind === 'monster';
const isSpell = (e: Engine, c: Card) => info(e, c).kind === 'spell';
const isTrap = (e: Engine, c: Card) => info(e, c).kind === 'trap';
const levelOf = (e: Engine, c: Card) => info(e, c).level ?? 0;
const attrOf = (e: Engine, c: Card) => info(e, c).attribute ?? '';
const isNormalMonster = (e: Engine, c: Card) => isMonster(e, c) && info(e, c).sub === 'Normal';
const isExtraOrRitual = (e: Engine, c: Card) => info(e, c).sub === 'Fusion' || info(e, c).sub === 'Ritual';
const faceUpMonsters = (e: Engine) => [...e.monsters(0), ...e.monsters(1)].filter((m) => m.faceUp);
const stOf = (e: Engine, p: Pid) => [...e.spells(p), ...(e.player(p).field ? [e.player(p).field!] : [])];
const freeMZ = (e: Engine, p: Pid) => e.player(p).mz.some((z) => z === null);
const freeST = (e: Engine, p: Pid) => e.player(p).sz.findIndex((z) => z === null);
const tag = (m: FieldCard) => (m.tags ??= {});
function boostTurn(m: FieldCard, atk: number, def = 0) {
  m.atkMod += atk;
  m.defMod += def;
}
function boostPerm(m: FieldCard, atk: number, def = 0) {
  const t = tag(m);
  t.permAtk = (t.permAtk ?? 0) + atk;
  t.permDef = (t.permDef ?? 0) + def;
}
/** The player takes no battle damage for the rest of this turn. */
function noBattleDamage(e: Engine, p: Pid) {
  (e.state.fx.noBattleDamage ??= [-1, -1])[p] = e.state.turn;
}
function* pick<T extends Card>(e: Engine, p: Pid, title: string, cards: T[], min = 1, max = 1): Gen<T[] | null> {
  if (cards.length === 0) return min === 0 ? [] : null;
  const picks = yield* e.select(p, title, e.optionsFor(cards, true), min, max, false);
  if (!picks) return null;
  return picks.map((i) => cards[i]).filter((c): c is T => !!c);
}
function* pickOne<T extends Card>(e: Engine, p: Pid, title: string, cards: T[]): Gen<T | null> {
  const r = yield* pick(e, p, title, cards, 1, 1);
  return r && r.length ? r[0] : null;
}
function* chooseOption(e: Engine, p: Pid, title: string, labels: string[]): Gen<number | null> {
  if (labels.length === 0) return null;
  const choice = yield { kind: 'select', player: p, title, options: labels.map((l) => ({ label: l })), min: 1, max: 1, cancel: false };
  if (typeof choice === 'object' && 'picks' in choice && choice.picks.length) return choice.picks[0];
  return null;
}

// ---------- small helpers ----------
type Test = (e: Engine, c: Card) => boolean;
const race = (e: Engine, c: Card) => ('faceUp' in c ? e.raceOf(c) : info(e, c).race ?? '');
const mon = (e: Engine, c: Card) => isMonster(e, c);
/** Archetype membership: in the name, or "always treated as" it in the text. */
const arch = (e: Engine, c: Card | string, a: string) => {
  const n = typeof c === 'string' ? c : c.name;
  if (n.includes(a)) return true;
  const d = e.info(n).desc ?? '';
  return d.includes(`treated as a "${a}"`) || d.includes(`treated as an "${a}"`);
};
const faceUp = (e: Engine, p: Pid, test: (m: FieldCard) => boolean = () => true) => e.monsters(p).filter((m) => m.faceUp && test(m));
/** Monsters that may be Special Summoned from the Deck/GY by an effect (no Fusion/Ritual, no "cannot be Normal Summoned" monsters). */
const summonable = (e: Engine, c: Card) => mon(e, c) && !isExtraOrRitual(e, c) && !e.effectOn(c)?.cannotNormalSummon;
const origAtk = (e: Engine, c: Card) => Math.max(0, info(e, c).atk ?? 0);
const S = (e: Engine) => (e.state.fx.skillData ??= {}) as Record<string, number>;
const getN = (e: Engine, p: Pid, k: string) => S(e)[`${p}|${k}`] ?? 0;
const setN = (e: Engine, p: Pid, k: string, v: number) => (S(e)[`${p}|${k}`] = v);
const opd = (e: Engine, p: Pid, k: string) => e.oncePerDuel(`skill:${k}`, p);
const useOpd = (e: Engine, p: Pid, k: string) => e.useOncePerDuel(`skill:${k}`, p);
const lpLost = (e: Engine, p: Pid) => ((e.state.fx.lpLost ?? [0, 0]) as number[])[p] ?? 0;
const half = (e: Engine, p: Pid) => Math.floor(e.player(p).lp / 2);
const inGY = (e: Engine, p: Pid, test: (c: Card) => boolean) => e.player(p).gy.filter(test);
const inDeck = (e: Engine, p: Pid, test: (c: Card) => boolean) => e.player(p).deck.filter(test);
const inHand = (e: Engine, p: Pid, test: (c: Card) => boolean) => e.player(p).hand.filter(test);
const faceDownST = (e: Engine, p: Pid) => e.spells(p).filter((c) => !c.faceUp);

function* toHandFrom(e: Engine, p: Pid, title: string, cards: Card[], reveal = false): Gen<Card | null> {
  const c = yield* pickOne(e, p, title, cards);
  if (!c) return null;
  const from = e.find(c.uid)?.loc.zone;
  e.toHandOf(c.uid, p);
  e.log(p, `${e.player(p).name} adds ${c.name} to the hand`);
  if (from === 'deck') e.player(p).deck = e.shuffle(e.player(p).deck);
  if (reveal) yield* e.reveal(other(p), `Your opponent added ${c.name} to their hand`, [c]);
  return c;
}
/** Shuffles cards (hand, GY or a monster on the field) into the owner's Deck. */
function* shuffleIn(e: Engine, uids: number[]): Step {
  const owners = new Set<Pid>();
  for (const uid of uids) {
    const f = e.find(uid);
    if (!f) continue;
    const fc = e.fieldCard(uid);
    if (fc) for (const eq of fc.equips.slice()) yield* e.sendToGrave(eq, 'used');
    if (!e.find(uid)) continue;
    e.toDeckTop(uid);
    owners.add(f.card.owner);
  }
  for (const o of owners) e.player(o).deck = e.shuffle(e.player(o).deck);
}
/** Special Summons a card, then shuffles the Deck if it came from there. */
function* ss(e: Engine, p: Pid, c: Card, pos: 'atk' | 'def' = 'atk'): Gen<FieldCard | null> {
  if (!freeMZ(e, p)) return null;
  const fromDeck = e.find(c.uid)?.loc.zone === 'deck';
  yield* e.specialSummon(c.uid, p, pos);
  if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
  return e.fieldCard(c.uid);
}
function* ssOne(e: Engine, p: Pid, title: string, cards: Card[], pos: 'atk' | 'def' = 'atk'): Gen<FieldCard | null> {
  if (!freeMZ(e, p) || !cards.length) return null;
  const c = yield* pickOne(e, p, title, cards);
  return c ? yield* ss(e, p, c, pos) : null;
}
function* discardOne(e: Engine, p: Pid, title: string, cands: Card[]): Gen<Card | null> {
  const c = yield* pickOne(e, p, title, cands);
  if (!c) return null;
  yield* e.discard(p, c.uid);
  return c;
}
function* tribute(e: Engine, p: Pid, m: FieldCard): Step {
  e.log(p, `${e.player(p).name} Tributes ${m.name}`);
  yield* e.sendToGrave(m.uid, 'tribute');
}
function banishAll(e: Engine, p: Pid, cards: Card[]) {
  for (const c of cards) if (e.find(c.uid)) e.banish(c.uid);
  if (cards.length) e.log(p, `${e.player(p).name} banishes ${cards.map((c) => c.name).join(', ')}`);
}
/** Lets the player put the given Deck cards back on the top or bottom of the Deck in any order. */
function* reorder(e: Engine, chooser: Pid, owner: Pid, cards: Card[], where: 'top' | 'bottom'): Step {
  const ps = e.player(owner);
  const left = cards.filter((c) => ps.deck.some((d) => d.uid === c.uid));
  const ordered: Card[] = [];
  while (left.length > 1) {
    const c = yield* pickOne(e, chooser, where === 'top' ? `Order: which card goes ${ordered.length ? 'next' : 'on top'}?` : `Order: which card goes ${ordered.length ? 'next' : 'first'} to the bottom?`, left);
    if (!c) break;
    ordered.push(c);
    left.splice(left.indexOf(c), 1);
  }
  ordered.push(...left);
  const set = new Set(ordered.map((c) => c.uid));
  ps.deck = ps.deck.filter((c) => !set.has(c.uid));
  if (where === 'top') ps.deck.unshift(...ordered);
  else ps.deck.push(...ordered);
}
/** Puts a card face-up in its controller's Spell & Trap Zone (Skills that "place" a card). */
function placeFaceUp(e: Engine, c: Card, p: Pid): FieldCard | null {
  const ps = e.player(p);
  const z = freeST(e, p);
  if (z < 0) return null;
  const f = e.find(c.uid);
  if (!f) return null;
  const from = e.player(f.loc.player);
  if (f.loc.zone === 'deck') from.deck.splice(f.loc.index, 1);
  else if (f.loc.zone === 'gy') from.gy.splice(f.loc.index, 1);
  else if (f.loc.zone === 'removed') from.removed.splice(f.loc.index, 1);
  else if (f.loc.zone === 'hand') from.hand.splice(f.loc.index, 1);
  else return null;
  const fc: FieldCard = { uid: c.uid, name: c.name, owner: c.owner, pos: 'atk', faceUp: true, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true };
  ps.sz[z] = fc;
  e.event('activate', { uid: c.uid, player: p });
  e.log(p, `${ps.name} places ${c.name} face-up in the Spell & Trap Zone`);
  return fc;
}
/** Changes a monster's battle position (face-down Defense -> face-up Attack flips it). */
function* changePos(e: Engine, m: FieldCard): Step {
  const ctl = e.controller(m.uid);
  if (ctl === null) return;
  if (!m.faceUp) {
    m.faceUp = true;
    m.pos = 'atk';
    e.event('flip', { uid: m.uid, player: ctl });
    e.log(ctl, `${m.name} is flipped face-up`);
    yield* e.flipEffect(m.uid, ctl);
    return;
  }
  m.pos = m.pos === 'atk' ? 'def' : 'atk';
  e.event('position', { uid: m.uid, player: ctl });
  e.log(ctl, `${m.name} changed to ${m.pos === 'atk' ? 'Attack' : 'Defense'} Position`);
}
const TYPES = ['Monster', 'Spell', 'Trap'];
const typeOf = (e: Engine, c: Card) => (mon(e, c) ? 0 : isSpell(e, c) ? 1 : 2);

// ---------- Fusion Summons by Skill ----------
/** Every way to fill the named materials of `fusion` from `pool` (distinct cards). */
function combos(e: Engine, fusion: Card, pool: Card[]): Card[][] {
  const ids = e.fusionMaterials(fusion.name);
  if (!ids) return [];
  const slots = ids.map((id) => pool.filter((c) => e.info(c.name).id === id));
  const out: Card[][] = [];
  const walk = (i: number, acc: Card[]) => {
    if (out.length > 400) return;
    if (i === slots.length) return void out.push(acc);
    const seen = new Set<string>();
    for (const c of slots[i]) {
      if (acc.includes(c)) continue;
      const key = `${c.name}|${e.find(c.uid)?.loc.zone}|${'faceUp' in c ? c.uid : ''}`;
      if (seen.has(key)) continue; // identical choices (same name, same zone) only once
      seen.add(key);
      walk(i + 1, [...acc, c]);
    }
  };
  walk(0, []);
  return out;
}
type FusionPlan = { fusion: Card; combos: Card[][] };
function fusionPlans(e: Engine, p: Pid, test: (f: Card) => boolean, pool: (f: Card) => Card[], ok: (f: Card, mats: Card[]) => boolean = () => true): FusionPlan[] {
  const out: FusionPlan[] = [];
  for (const f of e.player(p).fusion) {
    if (!test(f)) continue;
    const list = combos(e, f, pool(f)).filter((m) => ok(f, m) && (freeMZ(e, p) || m.some((c) => !!e.fieldCard(c.uid) && e.controller(c.uid) === p)));
    if (list.length) out.push({ fusion: f, combos: list });
  }
  return out;
}
const handField = (e: Engine, p: Pid) => [...e.player(p).hand.filter((c) => mon(e, c)), ...e.monsters(p)];
/** Asks which Fusion Monster and which materials, sends the materials to the GY (or banishes them) and Summons it. */
function* fusionSummon(e: Engine, p: Pid, label: string, plans: FusionPlan[], banish = false): Gen<FieldCard | null> {
  if (!plans.length) return null;
  const f = yield* pickOne(e, p, `${label}: Summon which Fusion Monster?`, plans.map((x) => x.fusion));
  if (!f) return null;
  let list = plans.find((x) => x.fusion === f)!.combos;
  const chosen: Card[] = [];
  const n = list[0].length;
  for (let i = 0; i < n; i++) {
    const opts: Card[] = [];
    for (const m of list) if (!opts.includes(m[i])) opts.push(m[i]);
    const c = opts.length === 1 ? opts[0] : yield* pickOne(e, p, `${label}: use which ${opts[0].name} as material?`, opts);
    if (!c) return null;
    chosen.push(c);
    list = list.filter((m) => m[i] === c);
  }
  const deckUsed = chosen.some((c) => e.find(c.uid)?.loc.zone === 'deck');
  for (const c of chosen) {
    if (!e.find(c.uid)) continue;
    if (banish) {
      const fc = e.fieldCard(c.uid);
      if (fc) for (const eq of fc.equips.slice()) yield* e.sendToGrave(eq, 'used');
      e.banish(c.uid);
    } else yield* e.sendToGrave(c.uid, 'used');
  }
  if (deckUsed) e.player(p).deck = e.shuffle(e.player(p).deck);
  if (!freeMZ(e, p) || !e.find(f.uid)) return null;
  yield* e.specialSummon(f.uid, p, 'atk');
  e.log(p, `${e.player(p).name} Fusion Summons ${f.name}!`);
  return e.fieldCard(f.uid);
}
/** Hand cards that can be discarded while `still(exceptUid)` stays possible. */
const discardable = (e: Engine, p: Pid, still: (except: number) => boolean, test: (c: Card) => boolean = () => true) => e.player(p).hand.filter((c) => test(c) && still(c.uid));

// ---------- shared Skill shapes ----------
/** "All X monsters on the field gain/lose ..." Skills that sit in the Field Zone from the start. */
const fieldSkill = (bonus: (e: Engine, m: FieldCard) => number | undefined): SkillDef => ({
  *startOfDuel() {},
  aura(e, _p, m) {
    const b = bonus(e, m);
    return b ? { atk: b, def: b } : undefined;
  },
});
const raceAura = (plus: string[], minus: string[] = [], n = 200) =>
  fieldSkill((e, m) => (plus.includes(e.raceOf(m)) ? n : minus.includes(e.raceOf(m)) ? -n : undefined));
/** "[If you lose N or more LP, ...] During your Draw Phase, search your Deck for a X card instead of drawing." Usable again after losing N more. */
const lpDraw = (key: string, lost: number, test: Test, what: string): SkillDef => ({
  drawPhase: {
    can: (e, p) => lpLost(e, p) - getN(e, p, key) >= lost && e.player(p).deck.some((c) => test(e, c)),
    *run(e, p) {
      setN(e, p, key, lpLost(e, p));
      yield* toHandFrom(e, p, `Add ${what} from your Deck to your hand`, inDeck(e, p, (c) => test(e, c)), true);
    },
  },
});
/** "This turn, if you Normal Summoned X": X is face-up on your field, placed this turn, and you used your Normal Summon. */
const normalSummonedNow = (e: Engine, p: Pid, test: (m: FieldCard) => boolean) => e.player(p).normalSummoned && e.monsters(p).some((m) => m.faceUp && m.placedTurn === e.state.turn && !m.posChanged && test(m));

export const SKILL_LIST: Record<string, SkillDef> = {};
const K = SKILL_LIST;

// ---------- Field Zone Skills ----------
K['Peak Performance'] = raceAura(['Dragon', 'Winged Beast', 'Thunder']);
K['Power of Dark'] = raceAura(['Fiend', 'Spellcaster'], ['Fairy']);
K['Straight to the Grave'] = raceAura(['Dinosaur', 'Zombie', 'Rock']);
K['Dinosaur Kingdom'] = raceAura(['Dinosaur'], [], 300);
// The Field Zone card is treated as "Necrovalley" in name only; the Skill gives the stat bonus.
K['Tomb of the Pharaoh'] = fieldSkill((_e, m) => (m.name.startsWith("Gravekeeper's") ? 200 : undefined));
// Its effect is exactly "Umi", and its name becomes "Umi": a card treated as Umi goes to the Field Zone.
K['Mythic Depths'] = {
  *startOfDuel(e, p) {
    e.placeSkillCard('Umi', p, 'field');
  },
};
K["It's a Toon World!"] = {
  *startOfDuel(e, p) {
    e.placeSkillCard('Toon World', p, 'sz');
  },
};
K['Call of the Haunted (Skill Card)'] = {
  *startOfDuel(e, p) {
    // Draw 1 less card: the last card drawn goes back on top of the Deck.
    const hand = e.player(p).hand;
    if (hand.length) e.toDeckTop(hand[hand.length - 1].uid);
    const fc = e.placeSkillCard('Call of the Haunted', p, 'sz');
    if (fc) {
      fc.faceUp = false;
      fc.active = false;
      // "You cannot activate this Skill during your first turn of the Duel."
      fc.placedTurn = e.state.turnPlayer === p ? e.state.turn : e.state.turn + 1;
    }
  },
};

// ---------- Draw Phase searches ----------
K['Destiny Draw (Skill Card)'] = lpDraw('destiny', 2000, () => true, 'any card');
K['Flight of the Harpies'] = lpDraw('harpies', 1800, (e, c) => arch(e, c, 'Harpie'), 'a "Harpie" card');
K["Gravekeeper's Lot"] = lpDraw('gravekeeper', 1800, (_e, c) => c.name.startsWith("Gravekeeper's"), 'a "Gravekeeper\'s" card');

K['Final Draw'] = {
  // The computer never plays it: using it loses the Duel.
  ai: false,
  use: {
    phase: 'main',
    oncePerDuel: false,
    can: (e, p) => getN(e, p, 'finalDrawLose') === 0,
    *run(e, p) {
      setN(e, p, 'finalDraw', getN(e, p, 'finalDraw') + 1);
      e.log(p, `Final Draw: ${getN(e, p, 'finalDraw')} counter(s)`);
    },
  },
  drawPhase: {
    can: (e, p) => getN(e, p, 'finalDraw') >= 3 && getN(e, p, 'finalDrawLose') === 0 && e.player(p).deck.length > 0,
    *run(e, p) {
      setN(e, p, 'finalDrawLose', e.state.turn);
      yield* toHandFrom(e, p, 'Final Draw: add any card from your Deck to your hand', e.player(p).deck);
    },
  },
  *onEndPhase(e, p) {
    if (getN(e, p, 'finalDrawLose') === e.state.turn) e.endDuel(other(p), `${e.player(p).name} used Final Draw`);
  },
};

K['Double Evolution Pill (Skill Card)'] = (() => {
  const dino = (e: Engine, c: Card) => mon(e, c) && race(e, c) === 'Dinosaur';
  const targets = (e: Engine, p: Pid, except: number[] = []) =>
    [...e.player(p).hand, ...e.player(p).deck].filter((c) => !except.includes(c.uid) && dino(e, c) && levelOf(e, c) >= 7 && !isExtraOrRitual(e, c));
  const pool = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.player(p).gy].filter((c) => mon(e, c));
  const okDinos = (e: Engine, p: Pid) => pool(e, p).filter((c) => dino(e, c) && targets(e, p, [c.uid]).length > 0);
  return {
    drawPhase: {
      can: (e, p) => opd(e, p, 'pill') && e.player(p).lp > 1500 && freeMZ(e, p) && okDinos(e, p).length > 0 && pool(e, p).some((c) => !dino(e, c)),
      *run(e, p) {
        useOpd(e, p, 'pill');
        e.payLp(p, 1500);
        const d = yield* pickOne(e, p, 'Double Evolution Pill: banish 1 Dinosaur monster', okDinos(e, p));
        const n = yield* pickOne(e, p, 'Double Evolution Pill: banish 1 non-Dinosaur monster', pool(e, p).filter((c) => !dino(e, c)));
        banishAll(e, p, [d, n].filter((c): c is Card => !!c));
        yield* ssOne(e, p, 'Double Evolution Pill: Special Summon a Level 7 or higher Dinosaur', targets(e, p));
      },
    },
  } as SkillDef;
})();

K["I've Got Dino DNA!"] = {
  // "During each of your Draw Phases": offered as the Draw Phase Skill; it still makes the normal draw.
  drawPhase: {
    can: () => true,
    *run(e, p) {
      e.gainLp(p, 200);
      if (!e.draw(p, 1, true)) return;
      const ps = e.player(p);
      const c = ps.hand[ps.hand.length - 1];
      if (c && mon(e, c) && race(e, c) === 'Dinosaur' && (yield* e.yesno(p, `I've Got Dino DNA!: reveal ${c.name}, put it on the bottom of the Deck and draw 1 card?`))) {
        yield* e.reveal(other(p), 'Your opponent reveals', [c]);
        e.toDeckTop(c.uid);
        ps.deck.push(ps.deck.shift()!);
        e.draw(p, 1, true);
      }
    },
  },
  use: {
    phase: 'main',
    oncePerDuel: false,
    can: (e, p) => faceUp(e, p, (m) => e.raceOf(m) === 'Dinosaur').length > 0,
    *run(e, p) {
      const m = yield* pickOne(e, p, "I've Got Dino DNA!: which Dinosaur gains 200 ATK?", faceUp(e, p, (x) => e.raceOf(x) === 'Dinosaur'));
      if (m) boostTurn(m, 200);
    },
  },
};

// ---------- looking at cards ----------
K['Aroma Strategy'] = {
  *startOfDuel() {},
  use: {
    oncePerDuel: false,
    can: (e, p) => e.player(p).deck.length > 0,
    *run(e, p) {
      yield* e.reveal(p, 'The top card of your Deck', e.player(p).deck.slice(0, 1));
    },
  },
};
K['Prescience'] = {
  use: {
    oncePerDuel: false,
    can: (e, p) => (getN(e, p, 'prescience') > 0 || e.player(other(p)).lp > 2 * e.player(p).lp) && e.player(p).deck.length + e.player(other(p)).deck.length > 0,
    *run(e, p) {
      setN(e, p, 'prescience', 1);
      yield* e.reveal(p, 'The top cards of your Deck and your opponent\'s Deck', [...e.player(p).deck.slice(0, 1), ...e.player(other(p)).deck.slice(0, 1)]);
    },
  },
};
K['Mind Scan (Skill Card)'] = {
  use: {
    oncePerDuel: false,
    can: (e, p) => e.state.turn >= 3 && e.player(p).lp >= 3000 && faceDownST(e, other(p)).length > 0,
    *run(e, p) {
      yield* e.reveal(p, "Your opponent's Set Spell & Trap Cards", faceDownST(e, other(p)));
    },
  },
};
K['Millennium Eye (Skill Card)'] = {
  *startOfDuel(e, p) {
    const q = other(p);
    const hand = e.player(q).hand.slice();
    if (!hand.length) return;
    yield* e.reveal(p, "Your opponent's opening hand", hand);
    if (!(yield* e.yesno(p, 'Millennium Eye: make your opponent shuffle their hand into the Deck and draw a new hand?'))) return;
    for (const c of hand) e.toDeckTop(c.uid);
    e.player(q).deck = e.shuffle(e.player(q).deck);
    e.draw(q, hand.length, true);
  },
};
// Used during your own Main Phase (the engine offers Skills only in your turn), before the opponent's next draw.
K['Millennium Necklace (Skill Card)'] = {
  use: {
    phase: 'main',
    can: (e, p) => e.player(other(p)).deck.length > 1,
    *run(e, p) {
      const top = e.player(other(p)).deck.slice(0, 3);
      yield* e.reveal(p, "The top 3 cards of your opponent's Deck", top);
      yield* reorder(e, p, other(p), top, 'top');
    },
  },
};
K["It's Jinzo!"] = {
  use: {
    phase: 'main',
    oncePerDuel: false,
    can: (e, p) => faceUp(e, p, (m) => m.name === 'Jinzo').length > 0 && faceDownST(e, other(p)).length > 0,
    *run(e, p) {
      const c = yield* pickOne(e, p, "It's Jinzo!: look at which face-down card?", faceDownST(e, other(p)));
      if (!c) return;
      yield* e.reveal(p, 'The face-down card is', [c]);
      if (isTrap(e, c)) e.draw(p, 1);
    },
  },
};

// ---------- once per Duel / once per turn activations ----------
K['Power Up!'] = {
  use: {
    phase: 'main',
    can: (e) => faceUpMonsters(e).length > 0,
    *run(e, p) {
      const m = yield* pickOne(e, p, 'Power Up!: which monster gains 500 ATK?', faceUpMonsters(e));
      if (m) boostTurn(m, 500);
    },
  },
};
K['Low Blow'] = {
  use: {
    phase: 'main',
    can: (e) => faceUpMonsters(e).length > 0,
    *run(e, p) {
      const m = yield* pickOne(e, p, 'Low Blow: which monster loses 500 ATK/DEF?', faceUpMonsters(e));
      if (m) boostTurn(m, -500, -500);
    },
  },
};
K['Room for Growth'] = {
  use: {
    phase: 'main',
    can: (e, p) => faceUp(e, p, (m) => levelOf(e, m) >= 1 && levelOf(e, m) <= 3).length > 0,
    *run(e, p) {
      const m = yield* pickOne(e, p, 'Room for Growth: which Level 3 or lower monster?', faceUp(e, p, (x) => levelOf(e, x) >= 1 && levelOf(e, x) <= 3));
      if (m) boostTurn(m, 300 * levelOf(e, m));
    },
  },
};
K['Beatdown!'] = {
  use: {
    phase: 'main',
    can: (e, p) => faceUp(e, p, (m) => levelOf(e, m) >= 5).length > 0,
    *run(e, p) {
      const n = faceUp(e, p, (m) => levelOf(e, m) >= 5).length;
      for (const m of faceUp(e, p)) boostTurn(m, 300 * n);
      e.log(p, `Beatdown!: monsters gain ${300 * n} ATK`);
    },
  },
};
K['Ruthless Means'] = {
  use: {
    phase: 'main',
    can: (e, p) => faceUp(e, p, (m) => m.name.includes('Evil HERO')).length > 0 && e.player(p).hand.length > 0 && faceUp(e, other(p)).length > 0,
    *run(e, p) {
      if (!(yield* discardOne(e, p, 'Ruthless Means: discard 1 card', e.player(p).hand))) return;
      const m = yield* pickOne(e, p, 'Ruthless Means: choose a face-up monster your opponent controls', faceUp(e, other(p)));
      if (!m) return;
      const o = yield* chooseOption(e, p, `Ruthless Means: ${m.name}...`, [`loses ATK equal to its DEF (${e.defOf(m)})`, `loses DEF equal to its ATK (${e.atkOf(m)})`]);
      if (o === 0) boostPerm(m, -e.defOf(m), 0);
      else boostPerm(m, 0, -e.atkOf(m));
    },
  },
};
K['Digging for Gold'] = {
  use: {
    phase: 'main',
    can: (e, p) => e.player(p).gy.length >= 3 && e.player(p).deck.length > 0,
    *run(e, p) {
      const cs = yield* pick(e, p, 'Digging for Gold: banish 3 cards from your GY', e.player(p).gy, 3, 3);
      if (!cs || cs.length < 3) return;
      banishAll(e, p, cs);
      e.draw(p, 1);
    },
  },
};
K['Switcheroo'] = {
  use: {
    phase: 'main',
    oncePerDuel: true,
    timesPerDuel: 2,
    can: (e, p) => e.player(p).hand.length > 0,
    *run(e, p) {
      const c = yield* pickOne(e, p, 'Switcheroo: shuffle which card into your Deck?', e.player(p).hand);
      if (!c) return;
      yield* shuffleIn(e, [c.uid]);
      e.draw(p, 1);
    },
  },
};
K['Last Gamble'] = {
  use: {
    phase: 'main',
    can: (e, p) => e.state.turn >= 5 && e.player(p).lp > 100 && e.player(p).hand.length >= 2,
    *run(e, p) {
      e.payLp(p, e.player(p).lp - 100);
      const cs = yield* pick(e, p, 'Last Gamble: discard 2 cards', e.player(p).hand, 2, 2);
      for (const c of cs ?? []) yield* e.discard(p, c.uid);
      const n = e.roll(6);
      e.log(p, `Last Gamble: the die shows ${n}`);
      e.draw(p, n);
    },
  },
};
K['Shadow Reborn'] = {
  use: {
    phase: 'main',
    can: (e, p) => e.player(p).lp >= 2 && freeMZ(e, p) && [...e.player(0).gy, ...e.player(1).gy].some((c) => summonable(e, c)),
    *run(e, p) {
      e.payLp(p, half(e, p));
      yield* ssOne(e, p, 'Shadow Reborn: Special Summon a monster from either GY', [...e.player(0).gy, ...e.player(1).gy].filter((c) => summonable(e, c)));
      noBattleDamage(e, other(p));
    },
  },
};
K['Rise of the Fallen'] = {
  use: {
    phase: 'main',
    can: (e, p) => freeMZ(e, p) && inGY(e, p, (c) => summonable(e, c) && race(e, c) === 'Fairy' && levelOf(e, c) <= 4).length > 0,
    *run(e, p) {
      const m = yield* ssOne(e, p, 'Rise of the Fallen: Special Summon a Level 4 or lower Fairy', inGY(e, p, (c) => summonable(e, c) && race(e, c) === 'Fairy' && levelOf(e, c) <= 4), 'def');
      if (m) e.gainLp(p, origAtk(e, m));
    },
  },
};
K['Dark Creation'] = (() => {
  const dark = (e: Engine, p: Pid) => inGY(e, p, (c) => mon(e, c) && attrOf(e, c) === 'DARK');
  const banishable = (e: Engine, p: Pid) => dark(e, p).filter((b) => dark(e, p).some((c) => c !== b && summonable(e, c)));
  return {
    use: {
      phase: 'main',
      can: (e, p) => e.monsters(p).length === 0 && new Set(dark(e, p).map((c) => c.name)).size >= 5 && banishable(e, p).length > 0,
      *run(e, p) {
        const b = yield* pickOne(e, p, 'Dark Creation: banish 1 DARK monster from your GY', banishable(e, p));
        if (!b) return;
        banishAll(e, p, [b]);
        yield* ssOne(e, p, 'Dark Creation: Special Summon 1 DARK monster from your GY', dark(e, p).filter((c) => summonable(e, c)));
      },
    },
  } as SkillDef;
})();
K["It's No Monster, It's a God!"] = {
  use: {
    phase: 'main',
    can: (e, p) => e.player(p).hand.length > 0 && [...e.player(p).deck, ...e.player(p).gy].some((c) => c.name === 'Obelisk the Tormentor'),
    *run(e, p) {
      const cs = yield* pick(e, p, "It's No Monster, It's a God!: discard any number of cards", e.player(p).hand, 1, e.player(p).hand.length);
      for (const c of cs ?? []) yield* e.discard(p, c.uid);
      yield* toHandFrom(e, p, 'Add "Obelisk the Tormentor" to your hand', [...e.player(p).deck, ...e.player(p).gy].filter((c) => c.name === 'Obelisk the Tormentor'));
    },
  },
};
K['Endless Traps'] = {
  use: {
    phase: 'main',
    can: (e, p) => inGY(e, p, (c) => isTrap(e, c)).length === 3,
    *run(e, p) {
      const traps = () => inGY(e, p, (c) => isTrap(e, c));
      const rnd = () => {
        const t = traps();
        return t[Math.floor(e.rand() * t.length)];
      };
      const a = rnd();
      e.toHandOf(a.uid, p);
      e.log(p, `Endless Traps: ${a.name} is added to the hand`);
      const b = rnd();
      yield* shuffleIn(e, [b.uid]);
      e.log(p, `Endless Traps: ${b.name} is shuffled into the Deck`);
      banishAll(e, p, [rnd()]);
    },
  },
};
K['Bandit'] = {
  use: {
    phase: 'main',
    can: (e, p) => e.player(p).lp <= 1500 && faceDownST(e, other(p)).length > 0 && freeST(e, p) >= 0,
    *run(e, p) {
      const c = yield* pickOne(e, p, 'Bandit: take control of which Set card?', faceDownST(e, other(p)));
      const f = c ? e.find(c.uid) : null;
      const z = freeST(e, p);
      if (!c || !f || f.loc.zone !== 'sz' || z < 0) return;
      e.player(f.loc.player).sz[f.loc.index] = null;
      e.player(p).sz[z] = c;
      e.event('set', { uid: c.uid, player: p });
      e.log(p, `${e.player(p).name} takes control of a Set card`);
    },
  },
};
K['Servants of the Fallen King'] = {
  use: {
    oncePerDuel: false,
    can: (e, p) => inDeck(e, p, (c) => isNormalMonster(e, c) && race(e, c) === 'Zombie' && levelOf(e, c) <= 3).length > 0,
    *run(e, p) {
      const c = yield* pickOne(e, p, 'Servants of the Fallen King: send which Zombie to the GY?', inDeck(e, p, (x) => isNormalMonster(e, x) && race(e, x) === 'Zombie' && levelOf(e, x) <= 3));
      if (!c) return;
      yield* e.sendToGrave(c.uid, 'cost');
      e.player(p).deck = e.shuffle(e.player(p).deck);
    },
  },
};
K['Cold-Blooded Tactician'] = {
  use: {
    phase: 'main',
    oncePerDuel: false,
    can: (e, p) => faceUp(e, p, (m) => e.raceOf(m) === 'Reptile').length > 0 && e.monsters(other(p)).length > 0,
    *run(e, p) {
      const n = faceUp(e, p, (m) => e.raceOf(m) === 'Reptile').length;
      const ms = yield* pick(e, p, `Cold-Blooded Tactician: change the positions of up to ${n} monster(s)`, e.monsters(other(p)), 1, n);
      for (const m of ms ?? []) if (e.fieldCard(m.uid)) yield* changePos(e, m);
    },
  },
};
K['Viral Infection'] = {
  use: {
    phase: 'main',
    oncePerDuel: false,
    can: (e, p) => e.player(p).hand.length > 0,
    *run(e, p) {
      const cs = yield* pick(e, p, 'Viral Infection: discard any number of cards', e.player(p).hand, 1, e.player(p).hand.length);
      if (!cs) return;
      for (const c of cs) yield* e.discard(p, c.uid);
      const t = yield* chooseOption(e, p, 'Viral Infection: declare a card type', TYPES);
      if (t === null) return;
      const q = other(p);
      const pool = inDeck(e, q, (c) => typeOf(e, c) === t);
      const n = Math.min(cs.length, pool.length);
      e.log(p, `Viral Infection: ${TYPES[t]} declared`);
      if (!n) return;
      const sent = yield* pick(e, q, `Viral Infection: send ${n} ${TYPES[t]} card(s) from your Deck to the GY`, pool, n, n);
      for (const c of sent ?? []) yield* e.sendToGrave(c.uid, 'mill');
      e.player(q).deck = e.shuffle(e.player(q).deck);
    },
  },
};
K['The Psychic Duelist'] = (() => {
  const canSet = (e: Engine, p: Pid) => opd(e, p, 'psy1') && faceDownST(e, other(p)).length > 0;
  const canHand = (e: Engine, p: Pid) => opd(e, p, 'psy2') && e.player(other(p)).hand.length > 0;
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => e.player(p).lp >= 2 && (canSet(e, p) || canHand(e, p)),
      *run(e, p) {
        const opts = [canSet(e, p) ? 0 : -1, canHand(e, p) ? 1 : -1].filter((x) => x >= 0);
        const labels = ['Read a Set card in the Spell & Trap Zone', "Read a random card in your opponent's hand"];
        const o = opts.length === 1 ? 0 : yield* chooseOption(e, p, 'The Psychic Duelist: which Skill?', opts.map((i) => labels[i]));
        if (o === null) return;
        const which = opts[o];
        useOpd(e, p, which === 0 ? 'psy1' : 'psy2');
        e.payLp(p, half(e, p));
        if (which === 0) {
          const c = yield* pickOne(e, p, 'The Psychic Duelist: target which Set card?', faceDownST(e, other(p)));
          const t = yield* chooseOption(e, p, 'Declare a card type', TYPES);
          if (!c || t === null) return;
          yield* e.reveal(p, 'The Set card is', [c]);
          yield* e.reveal(other(p), `Your opponent declared ${TYPES[t]} and reveals your Set card`, [c]);
          const fc = e.fieldCard(c.uid);
          if (fc && typeOf(e, c) === t) {
            fc.placedTurn = e.state.turn; // cannot be activated this turn
            e.log(p, `The Psychic Duelist: right! ${c.name} cannot be activated this turn`);
          }
        } else {
          const t = yield* chooseOption(e, p, 'Declare a card type', TYPES);
          const hand = e.player(other(p)).hand;
          const c = hand[Math.floor(e.rand() * hand.length)];
          if (t === null || !c) return;
          yield* e.reveal(p, 'The random card is', [c]);
          yield* e.reveal(other(p), `Your opponent declared ${TYPES[t]} and reveals this card from your hand`, [c]);
          if (typeOf(e, c) === t) e.damage(other(p), 500);
        }
      },
    },
  } as SkillDef;
})();
K['Into the Darkness Below'] = (() => {
  const fiendN = (e: Engine, c: Card) => isNormalMonster(e, c) && race(e, c) === 'Fiend';
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => inHand(e, p, (c) => fiendN(e, c)).length > 0 && e.player(p).deck.length > 0,
      *run(e, p) {
        if (!(yield* discardOne(e, p, 'Into the Darkness Below: discard 1 Fiend Normal Monster', inHand(e, p, (c) => fiendN(e, c))))) return;
        const big = new Set(inGY(e, p, (c) => fiendN(e, c)).map((c) => c.name)).size >= 4 && inDeck(e, p, (c) => mon(e, c)).length > 0;
        const o = big ? yield* chooseOption(e, p, 'Into the Darkness Below: which Skill?', ['Draw 1 card', 'Add 1 monster from your Deck to your hand']) : 0;
        if (o === 1) yield* toHandFrom(e, p, 'Add 1 monster from your Deck to your hand', inDeck(e, p, (c) => mon(e, c)));
        else e.draw(p, 1);
      },
    },
  } as SkillDef;
})();
K["The World's Greatest Fisherman"] = (() => {
  const water = (e: Engine, c: Card) => mon(e, c) && attrOf(e, c) === 'WATER';
  const targets = (e: Engine, p: Pid, d: Card) => inGY(e, p, (c) => water(e, c) && c.name !== d.name && c.uid !== d.uid && levelOf(e, c) <= 2 * levelOf(e, d));
  const discards = (e: Engine, p: Pid) => inHand(e, p, (c) => water(e, c) && targets(e, p, c).length > 0);
  return {
    use: {
      oncePerDuel: false,
      can: (e, p) => e.player(p).lp > 500 && discards(e, p).length > 0,
      *run(e, p) {
        e.payLp(p, 500);
        const d = yield* discardOne(e, p, "The World's Greatest Fisherman: discard 1 WATER monster", discards(e, p));
        if (d) yield* toHandFrom(e, p, 'Add 1 WATER monster from your GY to your hand', targets(e, p, d));
      },
    },
  } as SkillDef;
})();
K['Setting Sun'] = (() => {
  const unknownAtk = (e: Engine, c: Card) => mon(e, c) && info(e, c).atk === -1;
  const targets = (e: Engine, p: Pid) => {
    const mine = new Set(stOf(e, p).concat(e.monsters(p)).filter((c) => c.faceUp).map((c) => c.name));
    return inDeck(e, p, (c) => unknownAtk(e, c) && !mine.has(c.name));
  };
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => faceUp(e, p, (m) => unknownAtk(e, m)).length > 0 && e.player(p).hand.length > 0 && targets(e, p).length > 0,
      *run(e, p) {
        const c = yield* pickOne(e, p, 'Setting Sun: banish 1 card from your hand', e.player(p).hand);
        if (!c) return;
        banishAll(e, p, [c]);
        yield* toHandFrom(e, p, 'Add 1 monster with ? ATK from your Deck to your hand', targets(e, p));
      },
    },
  } as SkillDef;
})();
K['Nightmare Sonic Blast!'] = {
  use: {
    phase: 'main',
    oncePerDuel: false,
    can: (e, p) => faceUp(e, p, (m) => m.name === 'Serpent Night Dragon').length > 0 && e.player(p).deck.length > 0,
    *run(e, p) {
      const top = e.player(p).deck.slice(0, 4);
      yield* e.reveal(p, 'Nightmare Sonic Blast!: revealed cards', top);
      yield* e.reveal(other(p), 'Your opponent reveals the top cards of their Deck', top);
      const n = top.filter((c) => mon(e, c)).length;
      if (n === 1 || n >= 3) {
        const c = yield* pickOne(e, p, 'Add which revealed card to your hand?', top);
        if (c) {
          e.toHandOf(c.uid, p);
          e.log(p, `${e.player(p).name} adds ${c.name} to the hand`);
        }
      }
      if (n >= 2) {
        const opp = [...e.monsters(other(p)), ...stOf(e, other(p))];
        const t = yield* pickOne(e, p, 'Destroy which card your opponent controls?', opp);
        if (t) yield* e.destroy([t.uid]);
      }
      yield* reorder(e, p, p, top.filter((c) => e.find(c.uid)?.loc.zone === 'deck'), 'top');
    },
  },
};
K['Under Pressure'] = {
  use: {
    phase: 'main',
    oncePerDuel: false,
    can: (e, p) => faceUp(e, p, (m) => m.name === 'Hyozanryu').length > 0 && e.player(p).deck.length > 0,
    *run(e, p) {
      const top = e.player(p).deck.slice(0, 4);
      yield* e.reveal(p, 'Under Pressure: revealed cards', top);
      yield* e.reveal(other(p), 'Your opponent reveals the top cards of their Deck', top);
      if (top.some((c) => c.name === 'Carboneddon')) {
        const h = yield* pickOne(e, p, 'Carboneddon: which "Hyozanryu" gains 1000 ATK?', faceUp(e, p, (m) => m.name === 'Hyozanryu'));
        if (h) boostTurn(h, 1000);
      }
      if (top.some((c) => c.name === 'Oxygeddon') && faceUp(e, other(p)).length) {
        const t = yield* pickOne(e, p, 'Oxygeddon: destroy which face-up monster?', faceUp(e, other(p)));
        if (t) {
          yield* e.destroy([t.uid]);
          e.damage(other(p), 800);
        }
      }
      yield* reorder(e, p, p, top, 'bottom');
    },
  },
};
K['Small Roid Big City'] = {
  use: {
    oncePerDuel: false,
    can: (e, p) => [...faceUp(e, p), ...stOf(e, p).filter((c) => c.faceUp)].length > 0 && inDeck(e, p, (c) => c.name.includes('roid')).length > 0,
    *run(e, p) {
      const t = yield* pickOne(e, p, 'Small Roid Big City: destroy which face-up card you control?', [...faceUp(e, p), ...stOf(e, p).filter((c) => c.faceUp)]);
      if (!t) return;
      yield* e.destroy([t.uid]);
      if (e.fieldCard(t.uid)) return;
      yield* toHandFrom(e, p, 'Add 1 "roid" card from your Deck to your hand', inDeck(e, p, (c) => c.name.includes('roid')));
    },
  },
};
K['Victory of the Shadow Riders'] = (() => {
  const LORDS = ['Uria, Lord of Searing Flames', 'Hamon, Lord of Striking Thunder', 'Raviel, Lord of Phantasms'];
  const lords = (e: Engine, p: Pid) => inDeck(e, p, (c) => LORDS.includes(c.name));
  const zero = (e: Engine, p: Pid) => inGY(e, p, (c) => fiend0(e, c));
  const fiend0 = (e: Engine, c: Card) => summonable(e, c) && race(e, c) === 'Fiend' && info(e, c).atk === 0 && info(e, c).def === 0;
  /** If no 0 ATK/DEF Fiend is in the GY yet, the discarded card must be one. */
  const discards = (e: Engine, p: Pid) => (zero(e, p).length ? e.player(p).hand : inHand(e, p, (c) => fiend0(e, c)));
  const canRevive = (e: Engine, p: Pid) => freeMZ(e, p) && discards(e, p).length > 0;
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => (getN(e, p, 'riders') === 0 && lords(e, p).length > 0) || canRevive(e, p),
      *run(e, p) {
        if (getN(e, p, 'riders') === 0) {
          setN(e, p, 'riders', 1);
          yield* toHandFrom(e, p, 'Victory of the Shadow Riders: add which Sacred Beast?', lords(e, p));
          if (!canRevive(e, p) || !(yield* e.yesno(p, 'Also discard 1 card to Special Summon a 0 ATK/DEF Fiend from your GY?'))) return;
        }
        if (!(yield* discardOne(e, p, 'Victory of the Shadow Riders: discard 1 card', discards(e, p)))) return;
        yield* ssOne(e, p, 'Special Summon a Fiend with 0 ATK/DEF from your GY', zero(e, p));
      },
    },
  } as SkillDef;
})();

// ---------- Skills with several parts ----------
K['Tribal Synergy'] = (() => {
  const amaz = (e: Engine, c: Card) => mon(e, c) && c.name.includes('Amazoness');
  const harp = (e: Engine, c: Card) => mon(e, c) && arch(e, c, 'Harpie');
  const inH = (e: Engine, p: Pid) => opd(e, p, 'tribal1') && inHand(e, p, (c) => amaz(e, c)).length > 0 && inHand(e, p, (c) => harp(e, c)).length > 0 && e.player(p).deck.length > 0;
  const onF = (e: Engine, p: Pid) => opd(e, p, 'tribal2') && faceUp(e, p, (m) => amaz(e, m)).length > 0 && faceUp(e, p, (m) => harp(e, m)).length > 0 && e.player(p).deck.length > 0;
  return {
    *startOfDuel() {},
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => inH(e, p) || onF(e, p),
      *run(e, p) {
        const opts = [inH(e, p) ? 0 : -1, onF(e, p) ? 1 : -1].filter((x) => x >= 0);
        const o = opts.length === 1 ? 0 : yield* chooseOption(e, p, 'Tribal Synergy: which Skill?', ['Reveal an Amazoness and a Harpie in your hand: draw 1', 'You control an Amazoness and a Harpie: draw 2']);
        if (o === null) return;
        if (opts[o] === 0) {
          useOpd(e, p, 'tribal1');
          const a = yield* pickOne(e, p, 'Reveal an "Amazoness" monster', inHand(e, p, (c) => amaz(e, c)));
          const h = yield* pickOne(e, p, 'Reveal a "Harpie" monster', inHand(e, p, (c) => harp(e, c)));
          yield* e.reveal(other(p), 'Your opponent reveals', [a, h].filter((c): c is Card => !!c));
          e.draw(p, 1);
        } else {
          useOpd(e, p, 'tribal2');
          e.draw(p, 2);
        }
      },
    },
  } as SkillDef;
})();
K["Magician's Act"] = {
  *startOfDuel(e, p) {
    const dmDeck = inDeck(e, p, (c) => c.name === 'Dark Magician');
    const dmHand = inHand(e, p, (c) => c.name === 'Dark Magician');
    const labels = ['Do not use it now'];
    if (dmDeck.length) labels.push('Add "Dark Magician" from your Deck, then shuffle 1 card from your hand into the Deck');
    if (dmHand.length) labels.push('Shuffle "Dark Magician" from your hand into the Deck, then draw 1 card');
    if (labels.length === 1) return;
    const o = yield* chooseOption(e, p, "Magician's Act: at the start of the Duel", labels);
    if (!o) return;
    useOpd(e, p, 'act1');
    if (labels[o].startsWith('Add')) {
      yield* toHandFrom(e, p, 'Add "Dark Magician" to your hand', dmDeck);
      const c = yield* pickOne(e, p, 'Shuffle which card from your hand into the Deck?', e.player(p).hand);
      if (c) yield* shuffleIn(e, [c.uid]);
    } else {
      yield* shuffleIn(e, [dmHand[0].uid]);
      e.draw(p, 1, true);
    }
  },
  use: {
    phase: 'main',
    can: (e, p) => faceUp(e, p, (m) => m.name === 'Dark Magician').length > 0 && e.player(p).deck.length >= 2,
    *run(e, p) {
      const m = yield* pickOne(e, p, 'Tribute which "Dark Magician"?', faceUp(e, p, (x) => x.name === 'Dark Magician'));
      if (!m) return;
      yield* tribute(e, p, m);
      e.draw(p, 2);
    },
  },
};
K['Dragon Caller'] = {
  use: {
    phase: 'main',
    can: (e, p) =>
      (normalSummonedNow(e, p, (m) => m.name === 'Lord of D.') && [...e.player(p).deck, ...e.player(p).gy].some((c) => c.name === 'The Flute of Summoning Dragon')) ||
      (inHand(e, p, (c) => c.name === 'The Flute of Summoning Dragon').length > 0 && [...e.player(p).deck, ...e.player(p).gy].some((c) => c.name === 'Lord of D.')),
    *run(e, p) {
      const pool = [...e.player(p).deck, ...e.player(p).gy];
      const a = normalSummonedNow(e, p, (m) => m.name === 'Lord of D.') && pool.some((c) => c.name === 'The Flute of Summoning Dragon');
      const b = inHand(e, p, (c) => c.name === 'The Flute of Summoning Dragon').length > 0 && pool.some((c) => c.name === 'Lord of D.');
      const o = a && b ? yield* chooseOption(e, p, 'Dragon Caller: which Skill?', ['Add "The Flute of Summoning Dragon"', 'Reveal the Flute, add "Lord of D."']) : a ? 0 : 1;
      if (o === 0) yield* toHandFrom(e, p, 'Add "The Flute of Summoning Dragon"', pool.filter((c) => c.name === 'The Flute of Summoning Dragon'));
      else {
        yield* e.reveal(other(p), 'Your opponent reveals', inHand(e, p, (c) => c.name === 'The Flute of Summoning Dragon').slice(0, 1));
        yield* toHandFrom(e, p, 'Add "Lord of D."', pool.filter((c) => c.name === 'Lord of D.'));
      }
    },
  },
};
K['Magnetic Attraction'] = (() => {
  const mw = (e: Engine, c: Card) => mon(e, c) && c.name.includes('Magnet Warrior') && levelOf(e, c) <= 4;
  const a = (e: Engine, p: Pid) => {
    if (!opd(e, p, 'magnet1')) return [];
    const now = e.monsters(p).filter((m) => m.faceUp && m.placedTurn === e.state.turn && !m.posChanged && mw(e, m));
    if (!e.player(p).normalSummoned || !now.length) return [];
    return inDeck(e, p, (c) => mw(e, c) && now.some((m) => m.name !== c.name));
  };
  const b = (e: Engine, p: Pid) => opd(e, p, 'magnet2') && new Set(inHand(e, p, (c) => mw(e, c)).map((c) => c.name)).size >= 2 && inDeck(e, p, (c) => c.name === 'Valkyrion the Magna Warrior').length > 0;
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => a(e, p).length > 0 || b(e, p),
      *run(e, p) {
        const okA = a(e, p).length > 0;
        const okB = b(e, p);
        const o = okA && okB ? yield* chooseOption(e, p, 'Magnetic Attraction: which Skill?', ['Add a Magnet Warrior with a different name', 'Reveal 2 Magnet Warriors: add Valkyrion']) : okA ? 0 : 1;
        if (o === 0) {
          useOpd(e, p, 'magnet1');
          yield* toHandFrom(e, p, 'Add a "Magnet Warrior" with a different name', a(e, p));
        } else {
          useOpd(e, p, 'magnet2');
          const first = yield* pickOne(e, p, 'Reveal a "Magnet Warrior"', inHand(e, p, (c) => mw(e, c)));
          const second = first ? yield* pickOne(e, p, 'Reveal another "Magnet Warrior" with a different name', inHand(e, p, (c) => mw(e, c) && c.name !== first.name)) : null;
          yield* e.reveal(other(p), 'Your opponent reveals', [first, second].filter((c): c is Card => !!c));
          yield* toHandFrom(e, p, 'Add "Valkyrion the Magna Warrior"', inDeck(e, p, (c) => c.name === 'Valkyrion the Magna Warrior'));
        }
      },
    },
  } as SkillDef;
})();
K['Machine Angel Ascension'] = (() => {
  const piece = (e: Engine, c: Card) => (mon(e, c) && info(e, c).sub === 'Ritual' && c.name.includes('Cyber Angel')) || (isSpell(e, c) && info(e, c).sub === 'Ritual' && c.name.includes('Machine Angel'));
  const a = (e: Engine, p: Pid) => opd(e, p, 'angel1') && inHand(e, p, (c) => isSpell(e, c)).length > 0 && inDeck(e, p, (c) => piece(e, c)).length > 0;
  const b = (e: Engine, p: Pid) => opd(e, p, 'angel2') && inGY(e, p, (c) => piece(e, c)).length > 0;
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => a(e, p) || b(e, p),
      *run(e, p) {
        const okA = a(e, p);
        const okB = b(e, p);
        const o = okA && okB ? yield* chooseOption(e, p, 'Machine Angel Ascension: which Skill?', ['Discard 1 Spell: add a Cyber Angel / Machine Angel card', 'Shuffle a Cyber Angel / Machine Angel card from your GY into the Deck']) : okA ? 0 : 1;
        if (o === 0) {
          useOpd(e, p, 'angel1');
          if (!(yield* discardOne(e, p, 'Discard 1 Spell', inHand(e, p, (c) => isSpell(e, c))))) return;
          yield* toHandFrom(e, p, 'Add a "Cyber Angel" Ritual Monster or "Machine Angel" Ritual Spell', inDeck(e, p, (c) => piece(e, c)));
        } else {
          useOpd(e, p, 'angel2');
          const c = yield* pickOne(e, p, 'Shuffle which card into your Deck?', inGY(e, p, (x) => piece(e, x)));
          if (c) yield* shuffleIn(e, [c.uid]);
        }
      },
    },
  } as SkillDef;
})();
K['Cocoon of Ultra Evolution (Skill Card)'] = (() => {
  const insect = (e: Engine, c: Card) => mon(e, c) && race(e, c) === 'Insect';
  const equipped = (e: Engine) => faceUpMonsters(e).filter((m) => e.raceOf(m) === 'Insect' && m.equips.length > 0);
  const a = (e: Engine, p: Pid) => opd(e, p, 'cocoon1') && equipped(e).length > 0 && inDeck(e, p, (c) => insect(e, c) && !info(e, c).sub.match(/Fusion/)).length > 0 && (freeMZ(e, p) || equipped(e).some((m) => e.controller(m.uid) === p));
  const b = (e: Engine, p: Pid) => opd(e, p, 'cocoon2') && inGY(e, p, (c) => insect(e, c)).length > 0;
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => a(e, p) || b(e, p),
      *run(e, p) {
        const okA = a(e, p);
        const okB = b(e, p);
        const o = okA && okB ? yield* chooseOption(e, p, 'Cocoon of Ultra Evolution: which Skill?', ['Tribute an equipped Insect: Special Summon an Insect from your Deck', 'Shuffle an Insect from your GY into the Deck, then draw 1']) : okA ? 0 : 1;
        if (o === 0) {
          useOpd(e, p, 'cocoon1');
          const cands = freeMZ(e, p) ? equipped(e) : equipped(e).filter((m) => e.controller(m.uid) === p);
          const m = yield* pickOne(e, p, 'Tribute which equipped Insect monster?', cands);
          if (!m) return;
          yield* tribute(e, p, m);
          // Ignoring its Summoning conditions: any Insect monster from the Deck.
          yield* ssOne(e, p, 'Special Summon an Insect monster from your Deck', inDeck(e, p, (c) => insect(e, c)));
        } else {
          useOpd(e, p, 'cocoon2');
          const c = yield* pickOne(e, p, 'Shuffle which Insect into your Deck?', inGY(e, p, (x) => insect(e, x)));
          if (!c) return;
          yield* shuffleIn(e, [c.uid]);
          e.draw(p, 1);
        }
      },
    },
  } as SkillDef;
})();
K['Fury of Thunder'] = (() => {
  const a = (e: Engine, p: Pid) => opd(e, p, 'fury1') && faceUp(e, p, (m) => m.name === 'Slifer the Sky Dragon').length > 0 && e.player(p).hand.length < 4;
  // "If Slifer is sent to the GY": offered while Slifer is in your GY.
  const b = (e: Engine, p: Pid) => opd(e, p, 'fury2') && inGY(e, p, (c) => c.name === 'Slifer the Sky Dragon').length > 0;
  return {
    use: {
      oncePerDuel: false,
      can: (e, p) => (a(e, p) && e.inMainPhase()) || b(e, p),
      *run(e, p) {
        const okA = a(e, p) && e.inMainPhase();
        const okB = b(e, p);
        const o = okA && okB ? yield* chooseOption(e, p, 'Fury of Thunder: which Skill?', ['Draw until you have 4 cards', 'Shuffle "Slifer the Sky Dragon" from your GY into the Deck']) : okA ? 0 : 1;
        if (o === 0) {
          useOpd(e, p, 'fury1');
          const n = 4 - e.player(p).hand.length;
          if (n > 0) e.draw(p, n);
        } else {
          useOpd(e, p, 'fury2');
          const c = inGY(e, p, (x) => x.name === 'Slifer the Sky Dragon')[0];
          if (c) yield* shuffleIn(e, [c.uid]);
        }
      },
    },
  } as SkillDef;
})();

// ---------- Special Summons ----------
K['Archfiend\'s Promotion'] = (() => {
  const RANKS = /queen|bishop|rook|knight/i;
  const free = (e: Engine, p: Pid, m: FieldCard) => {
    const i = e.player(p).mz.indexOf(m);
    const q = e.player(other(p));
    const j = q.mz.length - 1 - i;
    return !q.mz[j] && !q.sz[j];
  };
  const pawns = (e: Engine, p: Pid) => faceUp(e, p, (m) => m.name === 'Vilepawn Archfiend' && free(e, p, m));
  const targets = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.player(p).deck].filter((c) => summonable(e, c) && c.name.includes('Archfiend') && RANKS.test(c.name) && levelOf(e, c) <= 8);
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => pawns(e, p).length > 0 && targets(e, p).length > 0,
      *run(e, p) {
        const m = yield* pickOne(e, p, 'Tribute which "Vilepawn Archfiend"?', pawns(e, p));
        if (!m) return;
        yield* tribute(e, p, m);
        yield* ssOne(e, p, 'Special Summon a Queen/Bishop/Rook/Knight "Archfiend"', targets(e, p));
      },
    },
  } as SkillDef;
})();
K['Armed and Ready!'] = (() => {
  const mentioned = (e: Engine, m: Card) => [...(info(e, m).desc ?? '').matchAll(/"([^"]*LV[^"]*)"/g)].map((x) => x[1]).filter((n) => n !== m.name);
  const sources = (e: Engine, p: Pid) => faceUp(e, p, (m) => /LV\d/.test(m.name) && mentioned(e, m).length > 0);
  const pool = (e: Engine, p: Pid, names: string[], except: number) => [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy].filter((c) => c.uid !== except && names.includes(c.name));
  const ready = (e: Engine, p: Pid) => sources(e, p).filter((m) => pool(e, p, mentioned(e, m), m.uid).length > 0);
  return {
    use: {
      phase: 'main',
      can: (e, p) => ready(e, p).length > 0,
      *run(e, p) {
        const m = yield* pickOne(e, p, 'Armed and Ready!: send which "LV" monster to the GY?', ready(e, p));
        if (!m) return;
        const names = mentioned(e, m);
        yield* e.sendToGrave(m.uid, 'cost');
        yield* ssOne(e, p, 'Special Summon the "LV" monster it mentions', pool(e, p, names, -1));
      },
    },
  } as SkillDef;
})();
K['The Right Hero for the Job'] = (() => {
  const hero = (e: Engine, c: Card) => mon(e, c) && c.name.includes('Elemental HERO');
  const shuffleable = (e: Engine, p: Pid) => faceUp(e, p, (m) => hero(e, m) && info(e, m).sub !== 'Fusion' && inDeck(e, p, (c) => summonable(e, c) && hero(e, c) && levelOf(e, c) <= 4 && c.name !== m.name).length > 0);
  return {
    use: {
      phase: 'main',
      can: (e, p) => shuffleable(e, p).length > 0,
      *run(e, p) {
        const m = yield* pickOne(e, p, 'Shuffle which "Elemental HERO" into your Deck?', shuffleable(e, p));
        if (!m) return;
        const name = m.name;
        yield* shuffleIn(e, [m.uid]);
        yield* ssOne(e, p, 'Special Summon a Level 4 or lower "Elemental HERO"', inDeck(e, p, (c) => summonable(e, c) && hero(e, c) && levelOf(e, c) <= 4 && c.name !== name));
      },
    },
  } as SkillDef;
})();
K['Land of the Ojamas (Skill Card)'] = (() => {
  const ojamaMon = (e: Engine, c: Card) => mon(e, c) && c.name.startsWith('Ojama');
  return {
    *startOfDuel() {},
    // While you control an "Ojama" monster, the original ATK/DEF of all monsters are switched.
    aura(e, p, m) {
      if (!faceUp(e, p, (x) => ojamaMon(e, x)).length) return undefined;
      const a = Math.max(0, info(e, m).atk ?? 0);
      const d = Math.max(0, info(e, m).def ?? 0);
      return a === d ? undefined : { atk: d - a, def: a - d };
    },
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => freeMZ(e, p) && inHand(e, p, (c) => c.name.startsWith('Ojama')).length > 0 && (inGY(e, p, (c) => summonable(e, c) && ojamaMon(e, c)).length > 0 || inHand(e, p, (c) => summonable(e, c) && ojamaMon(e, c)).length > 0),
      *run(e, p) {
        const c = yield* pickOne(e, p, 'Land of the Ojamas: send which "Ojama" card to the GY?', inHand(e, p, (x) => x.name.startsWith('Ojama') && (summonable(e, x) && ojamaMon(e, x) ? true : inGY(e, p, (g) => summonable(e, g) && ojamaMon(e, g)).length > 0)));
        if (!c) return;
        yield* e.sendToGrave(c.uid, 'cost');
        yield* ssOne(e, p, 'Special Summon an "Ojama" monster from your GY', inGY(e, p, (x) => summonable(e, x) && ojamaMon(e, x)));
      },
    },
  } as SkillDef;
})();
K['Zombie Master (Skill Card)'] = (() => {
  const zombie4 = (e: Engine, c: Card) => mon(e, c) && race(e, c) === 'Zombie' && levelOf(e, c) <= 4;
  const master = (e: Engine, p: Pid) => faceUp(e, p, (m) => !!m.tags?.zombieMaster)[0];
  const targets = (e: Engine) => [...e.player(0).gy, ...e.player(1).gy].filter((c) => summonable(e, c) && zombie4(e, c));
  const sendable = (e: Engine, p: Pid) => inHand(e, p, (c) => mon(e, c) && (targets(e).length > 0 || (summonable(e, c) && zombie4(e, c))));
  const canRevive = (e: Engine, p: Pid) => !!master(e, p) && freeMZ(e, p) && sendable(e, p).length > 0;
  function* revive(e: Engine, p: Pid): Step {
    const c = yield* pickOne(e, p, 'Zombie Master: send which monster from your hand to the GY?', sendable(e, p));
    if (!c) return;
    yield* e.sendToGrave(c.uid, 'cost');
    const t = yield* pickOne(e, p, 'Zombie Master: Special Summon which Level 4 or lower Zombie?', targets(e));
    if (t && master(e, p)) yield* ss(e, p, t);
  }
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => (opd(e, p, 'zmaster') && faceUp(e, p, (m) => zombie4(e, m)).length > 0) || canRevive(e, p),
      *run(e, p) {
        if (opd(e, p, 'zmaster') && !master(e, p)) {
          const m = yield* pickOne(e, p, 'Zombie Master: which Zombie gains the effect?', faceUp(e, p, (x) => zombie4(e, x)));
          if (!m) return;
          useOpd(e, p, 'zmaster');
          tag(m).zombieMaster = 1;
          e.log(p, `${m.name} gains the Zombie Master effect`);
          if (!canRevive(e, p) || !(yield* e.yesno(p, 'Use its effect now?'))) return;
        }
        yield* revive(e, p);
      },
    },
  } as SkillDef;
})();
K['Behold, Gate Guardian!'] = (() => {
  const lv7 = (e: Engine, c: Card) => summonable(e, c) && levelOf(e, c) === 7;
  return {
    use: {
      phase: 'main',
      can: (e, p) => [...e.player(p).deck, ...e.player(p).hand].some((c) => mon(e, c) && levelOf(e, c) === 11),
      *run(e, p) {
        yield* shuffleIn(e, e.player(p).hand.map((c) => c.uid));
        const c = yield* toHandFrom(e, p, 'Behold, Gate Guardian!: add a Level 11 monster', inDeck(e, p, (x) => mon(e, x) && levelOf(e, x) === 11));
        if (!c) return;
        const pool = () => [...e.player(p).deck, ...e.player(p).gy].filter((x) => lv7(e, x));
        if (!freeMZ(e, p) || !pool().length || !(yield* e.yesno(p, 'Special Summon up to 2 Level 7 monsters with different Attributes (ATK/DEF 0, effects negated)?'))) return;
        const first = yield* ssOne(e, p, 'Special Summon a Level 7 monster', pool());
        const done: FieldCard[] = first ? [first] : [];
        if (first && freeMZ(e, p)) {
          const rest = pool().filter((x) => attrOf(e, x) !== attrOf(e, first));
          if (rest.length && (yield* e.yesno(p, 'Special Summon another Level 7 monster with a different Attribute?'))) {
            const second = yield* ssOne(e, p, 'Special Summon a Level 7 monster', rest);
            if (second) done.push(second);
          }
        }
        for (const m of done) {
          boostPerm(m, -Math.max(0, info(e, m).atk ?? 0), -Math.max(0, info(e, m).def ?? 0));
          tag(m).negated = 1;
        }
      },
    },
  } as SkillDef;
})();
K['Ancient Ruler Rises'] = (() => {
  const SARC = ['The First Sarcophagus', 'The Second Sarcophagus', 'The Third Sarcophagus'];
  const zombie2 = (e: Engine, c: Card) => mon(e, c) && race(e, c) === 'Zombie' && levelOf(e, c) === 2;
  const sarcs = (e: Engine, p: Pid) => [...e.player(p).deck, ...e.player(p).gy, ...e.player(p).removed].filter((c) => SARC.includes(c.name));
  return {
    *startOfDuel() {},
    aura(e, p, m) {
      if (m.name !== 'Spirit of the Pharaoh' || e.controller(m.uid) !== p) return undefined;
      const servant = (c: Card) => c.name === "Pharaoh's Servant" || c.name === 'Pharaonic Protector';
      const n = faceUp(e, p, servant).length + e.player(p).gy.filter(servant).length;
      return n ? { atk: 900 * n, def: 0 } : undefined;
    },
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => inDeck(e, p, (c) => zombie2(e, c)).length > 0 && freeST(e, p) >= 0 && sarcs(e, p).some((c) => !zombie2(e, c)),
      *run(e, p) {
        const z = yield* pickOne(e, p, 'Ancient Ruler Rises: send which Level 2 Zombie to the GY?', inDeck(e, p, (c) => zombie2(e, c)));
        if (!z) return;
        yield* e.sendToGrave(z.uid, 'cost');
        const s = yield* pickOne(e, p, 'Place which Sarcophagus face-up?', sarcs(e, p));
        if (s) {
          const fromDeck = e.find(s.uid)?.loc.zone === 'deck';
          placeFaceUp(e, s, p);
          if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
        }
        e.player(p).deck = e.shuffle(e.player(p).deck);
      },
    },
  } as SkillDef;
})();
K['Cyberdark Style (Skill Card)'] = {
  use: {
    phase: 'main',
    oncePerDuel: true,
    timesPerDuel: 3,
    can: (e, p) => {
      const lp = e.player(p).lp;
      const met = (lp <= 3000 ? 1 : 0) + (lp <= 2000 ? 1 : 0) + (lp <= 1000 ? 1 : 0);
      return (e.player(p).skillUses ?? 0) < met && inDeck(e, p, (c) => mon(e, c) && c.name.includes('Cyberdark')).length >= 3;
    },
    *run(e, p) {
      const three = yield* pick(e, p, 'Cyberdark Style: choose 3 "Cyberdark" monsters from your Deck', inDeck(e, p, (c) => mon(e, c) && c.name.includes('Cyberdark')), 3, 3);
      if (!three || three.length < 3) return;
      yield* e.reveal(other(p), 'Your opponent chose these cards; 1 is added to their hand at random', three);
      const c = three[Math.floor(e.rand() * 3)];
      e.toHandOf(c.uid, p);
      e.log(p, `Cyberdark Style: ${c.name} is added to the hand`);
      const back = yield* pickOne(e, p, 'Shuffle which card from your hand into the Deck?', e.player(p).hand);
      if (back) yield* shuffleIn(e, [back.uid]);
      else e.player(p).deck = e.shuffle(e.player(p).deck);
    },
  },
};
K['Ritual Ceremony'] = (() => {
  const canRitual = (e: Engine, spell: Card, monster: Card) => {
    if (!isSpell(e, spell) || info(e, spell).sub !== 'Ritual') return false;
    if (e.ritualOf(spell.name)?.monster === monster.name) return true;
    const d = info(e, spell).desc ?? '';
    if (d.includes(`"${monster.name}"`)) return true;
    return [...d.matchAll(/Ritual Summon (?:any|1) "([^"]+)"/g)].some((x) => monster.name.includes(x[1]));
  };
  const rituals = (e: Engine, p: Pid) => inHand(e, p, (c) => mon(e, c) && info(e, c).sub === 'Ritual' && inDeck(e, p, (s) => canRitual(e, s, c)).length > 0);
  return {
    use: {
      phase: 'main',
      can: (e, p) => rituals(e, p).length > 0,
      *run(e, p) {
        const m = yield* pickOne(e, p, 'Ritual Ceremony: reveal which Ritual Monster?', rituals(e, p));
        if (!m) return;
        yield* e.reveal(other(p), 'Your opponent reveals', [m]);
        yield* toHandFrom(e, p, 'Add a Ritual Spell for it', inDeck(e, p, (s) => canRitual(e, s, m)));
      },
    },
  } as SkillDef;
})();

// ---------- Fusion Skills ----------
K['Fusion Party!'] = {
  use: {
    phase: 'main',
    can: (e, p) => fusionPlans(e, p, () => true, () => handField(e, p)).length > 0,
    *run(e, p) {
      yield* fusionSummon(e, p, 'Fusion Party!', fusionPlans(e, p, () => true, () => handField(e, p)));
    },
  },
};
/** Discard 1 card, then Fusion Summon: only offers discards that leave a Fusion Summon possible. */
function discardFuse(label: string, plans: (e: Engine, p: Pid, except: number) => FusionPlan[]) {
  const cands = (e: Engine, p: Pid) => discardable(e, p, (u) => plans(e, p, u).length > 0);
  return {
    can: (e: Engine, p: Pid) => cands(e, p).length > 0,
    *run(e: Engine, p: Pid): Gen<FieldCard | null> {
      if (!(yield* discardOne(e, p, `${label}: discard 1 card`, cands(e, p)))) return null;
      return yield* fusionSummon(e, p, label, plans(e, p, -1));
    },
  };
}
const without = (cards: Card[], uid: number) => cards.filter((c) => c.uid !== uid);
K['HEROES UNITE - FUSION!!'] = (() => {
  const hero = (c: Card) => c.name.includes('Elemental HERO');
  const plans = (e: Engine, p: Pid, except: number) =>
    fusionPlans(e, p, hero, (f) => {
      const ids = e.fusionMaterials(f.name) ?? [];
      const base = without(handField(e, p), except);
      // 3+ materials and you control 2 "Elemental HERO" monsters it lists: the Deck can supply materials too.
      const listed = new Set(faceUp(e, p, (m) => hero(m) && ids.includes(e.info(m.name).id)).map((m) => m.name));
      return ids.length >= 3 && listed.size >= 2 ? [...base, ...inDeck(e, p, (c) => mon(e, c))] : base;
    });
  const d = discardFuse('HEROES UNITE - FUSION!!', plans);
  return { use: { phase: 'main', can: d.can, *run(e, p) { yield* d.run(e, p); } } } as SkillDef;
})();
K['Beasts of Phantom'] = (() => {
  const plans = (e: Engine, p: Pid, except: number) => fusionPlans(e, p, (f) => f.name === 'Chimera the Flying Mythical Beast', () => without(handField(e, p), except));
  const d = discardFuse('Beasts of Phantom', plans);
  const beasts = (e: Engine, p: Pid) => inGY(e, p, (c) => mon(e, c) && arch(e, c, 'Phantom Beast'));
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: d.can,
      *run(e, p) {
        const m = yield* d.run(e, p);
        if (m) setN(e, p, 'chimera', e.state.turn);
      },
    },
    *onEndPhase(e, p) {
      if (e.state.turnPlayer !== p || getN(e, p, 'chimera') !== e.state.turn || !beasts(e, p).length || !e.oncePerTurn('skill:phantom', p)) return;
      if (!(yield* e.yesno(p, 'Beasts of Phantom: add a "Phantom Beast" monster from your GY to your hand?'))) return;
      e.useOnce('skill:phantom', p);
      yield* toHandFrom(e, p, 'Add a "Phantom Beast" monster', beasts(e, p));
    },
  } as SkillDef;
})();
K['Cyber Blade Fusion'] = (() => {
  const plans = (e: Engine, p: Pid, except: number) =>
    fusionPlans(
      e,
      p,
      (f) => f.name === 'Cyber Blader',
      () => [...without(handField(e, p), except), ...inDeck(e, p, (c) => mon(e, c))],
      (_f, mats) => {
        // One of the materials comes from your field, the other from your hand, field or Deck.
        const onField = mats.filter((c) => !!e.fieldCard(c.uid));
        return onField.length >= 1;
      },
    );
  const d = discardFuse('Cyber Blade Fusion', plans);
  return {
    use: {
      phase: 'main',
      oncePerDuel: true,
      timesPerDuel: 2,
      can: d.can,
      *run(e, p) {
        const m = yield* d.run(e, p);
        if (m) boostPerm(m, 400);
      },
    },
  } as SkillDef;
})();
K['Union Combination'] = (() => {
  const contact = (e: Engine, f: Card) => {
    const i = info(e, f);
    return i.attribute === 'LIGHT' && i.race === 'Machine' && (i.desc ?? '').includes('do not use "Polymerization"');
  };
  const plans = (e: Engine, p: Pid) => fusionPlans(e, p, (f) => contact(e, f), () => [...e.monsters(p).filter((m) => m.faceUp), ...e.player(p).gy.filter((c) => mon(e, c))]);
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => e.player(p).hand.length > 0 && plans(e, p).length > 0,
      *run(e, p) {
        const c = yield* pickOne(e, p, 'Union Combination: place which card on the bottom of your Deck?', e.player(p).hand);
        if (!c) return;
        e.toDeckTop(c.uid);
        const ps = e.player(p);
        ps.deck.push(ps.deck.shift()!);
        // The materials are banished, as that monster's own Summon procedure does.
        yield* fusionSummon(e, p, 'Union Combination', plans(e, p), true);
        noBattleDamage(e, other(p));
      },
    },
  } as SkillDef;
})();
K['Thousand-Eyes Spell'] = (() => {
  const fplans = (e: Engine, p: Pid, except: number) => fusionPlans(e, p, (f) => f.name === 'Thousand-Eyes Restrict', () => without(handField(e, p), except));
  const relinq = (e: Engine, p: Pid, except: number) => inHand(e, p, (c) => c.uid !== except && c.name === 'Relinquished');
  const offerings = (e: Engine, p: Pid, r: Card | undefined, except: number) =>
    [...inHand(e, p, (c) => mon(e, c) && c.uid !== except && c !== r && levelOf(e, c) >= 1), ...e.monsters(p).filter((m) => levelOf(e, m) >= 1)];
  const canRitual = (e: Engine, p: Pid, except: number) => {
    const r = relinq(e, p, except)[0];
    if (!r) return false;
    const offs = offerings(e, p, r, except);
    return offs.length > 0 && (freeMZ(e, p) || offs.some((c) => !!e.fieldCard(c.uid)));
  };
  const either = (e: Engine, p: Pid, except: number) => canRitual(e, p, except) || fplans(e, p, except).length > 0;
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => discardable(e, p, (u) => either(e, p, u)).length > 0,
      *run(e, p) {
        if (!(yield* discardOne(e, p, 'Thousand-Eyes Spell: discard 1 card', discardable(e, p, (u) => either(e, p, u))))) return;
        const okR = canRitual(e, p, -1);
        const okF = fplans(e, p, -1).length > 0;
        if (!okR && !okF) return;
        const o = okR && okF ? yield* chooseOption(e, p, 'Thousand-Eyes Spell: which Skill?', ['Ritual Summon "Relinquished"', 'Fusion Summon "Thousand-Eyes Restrict"']) : okR ? 0 : 1;
        if (o === 0) {
          const r = relinq(e, p, -1)[0];
          const offs = offerings(e, p, r, -1).filter((c) => freeMZ(e, p) || !!e.fieldCard(c.uid));
          const t = yield* pickOne(e, p, 'Tribute which monster for "Relinquished"?', offs);
          if (!t) return;
          yield* e.sendToGrave(t.uid, 'tribute');
          if (freeMZ(e, p) && e.find(r.uid)?.loc.zone === 'hand') {
            yield* e.specialSummon(r.uid, p, 'atk');
            e.log(p, `${e.player(p).name} Ritual Summons Relinquished!`);
          }
        } else yield* fusionSummon(e, p, 'Thousand-Eyes Spell', fplans(e, p, -1));
        // "You cannot conduct your Battle Phase this turn."
        for (const m of e.monsters(p)) tag(m).noAttackTurn = e.state.turn;
      },
    },
  } as SkillDef;
})();
K['Believe in your Bro'] = (() => {
  const hero = (c: Card) => c.name.includes('Elemental HERO');
  const roid = (e: Engine, c: Card) => mon(e, c) && c.name.includes('roid') && race(e, c) === 'Machine';
  const hasHero = (e: Engine, p: Pid) => faceUp(e, p, hero).length > 0;
  const hasRoid = (e: Engine, p: Pid) => faceUp(e, p, (m) => roid(e, m)).length > 0;
  const gyRoids = (e: Engine, p: Pid) => inGY(e, p, (c) => roid(e, c) && levelOf(e, c) <= 6);
  const deckPicks = (e: Engine, p: Pid) => inDeck(e, p, (c) => summonable(e, c) && levelOf(e, c) <= 6 && (roid(e, c) || hero(c)));
  const fplans = (e: Engine, p: Pid) => fusionPlans(e, p, () => true, () => faceUp(e, p, (m) => hero(m) || roid(e, m)));
  const a = (e: Engine, p: Pid) => opd(e, p, 'bro1') && hasHero(e, p) && inHand(e, p, (c) => isTrap(e, c)).length > 0 && gyRoids(e, p).length > 0;
  const b = (e: Engine, p: Pid) => opd(e, p, 'bro2') && hasRoid(e, p) && freeMZ(e, p) && inHand(e, p, (c) => isSpell(e, c)).length > 0 && deckPicks(e, p).length > 0;
  const c3 = (e: Engine, p: Pid) => opd(e, p, 'bro3') && hasHero(e, p) && hasRoid(e, p) && e.player(p).hand.length > 0 && fplans(e, p).length > 0;
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => a(e, p) || b(e, p) || c3(e, p),
      *run(e, p) {
        const labels = ['"Elemental HERO": discard a Trap, add a "roid" from your GY', 'Machine "roid": discard a Spell, Special Summon from your Deck', 'Both: discard 1 card, Fusion Summon'];
        const opts = [a(e, p) ? 0 : -1, b(e, p) ? 1 : -1, c3(e, p) ? 2 : -1].filter((x) => x >= 0);
        const o = opts.length === 1 ? 0 : yield* chooseOption(e, p, 'Believe in your Bro: which Skill?', opts.map((i) => labels[i]));
        if (o === null) return;
        const which = opts[o];
        useOpd(e, p, `bro${which + 1}`);
        if (which === 0) {
          if (!(yield* discardOne(e, p, 'Discard 1 Trap', inHand(e, p, (c) => isTrap(e, c))))) return;
          const r = yield* toHandFrom(e, p, 'Add a Level 6 or lower Machine "roid" from your GY', gyRoids(e, p));
          if (!r) return;
          const t = faceUp(e, other(p), (m) => e.atkOf(m) <= origAtk(e, r));
          if (t.length && (yield* e.yesno(p, `Destroy a monster with ${origAtk(e, r)} or less ATK?`))) {
            const m = yield* pickOne(e, p, 'Destroy which monster?', t);
            if (m) yield* e.destroy([m.uid]);
          }
        } else if (which === 1) {
          if (!(yield* discardOne(e, p, 'Discard 1 Spell', inHand(e, p, (c) => isSpell(e, c))))) return;
          const m = yield* ssOne(e, p, 'Special Summon a "roid" or "Elemental HERO" in Defense Position', deckPicks(e, p), 'def');
          if (m) tag(m).negated = 1;
        } else {
          if (!(yield* discardOne(e, p, 'Discard 1 card', e.player(p).hand))) return;
          yield* fusionSummon(e, p, 'Believe in your Bro', fplans(e, p));
        }
      },
    },
  } as SkillDef;
})();
K['HERO World'] = (() => {
  const heroes = (e: Engine, p: Pid) => faceUp(e, p, (m) => m.name.includes('HERO') && (isNormalMonster(e, m) || info(e, m).sub === 'Fusion'));
  const options = (e: Engine, p: Pid) => {
    const attrs = new Set(heroes(e, p).map((m) => attrOf(e, m)));
    const out: string[] = [];
    if (attrs.has('EARTH') && faceUp(e, p, (m) => attrOf(e, m) === 'EARTH').length && faceUp(e, other(p)).length) out.push('EARTH');
    if (attrs.has('WIND') && [...stOf(e, 0), ...stOf(e, 1)].some((c) => c.faceUp)) out.push('WIND');
    if (attrs.has('WATER') && e.player(p).deck.length) out.push('WATER');
    if (attrs.has('LIGHT') && faceUpMonsters(e).length) out.push('LIGHT');
    return out;
  };
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => e.player(p).hand.length > 0 && options(e, p).length > 0,
      *run(e, p) {
        const opts = options(e, p);
        if (!(yield* discardOne(e, p, 'HERO World: discard 1 card', e.player(p).hand))) return;
        const o = opts.length === 1 ? 0 : yield* chooseOption(e, p, 'HERO World: which Attribute?', opts);
        if (o === null) return;
        const a = opts[o];
        if (a === 'EARTH') {
          const mine = yield* pickOne(e, p, 'Destroy which EARTH monster you control?', faceUp(e, p, (m) => attrOf(e, m) === 'EARTH'));
          const theirs = yield* pickOne(e, p, 'Destroy which face-up monster your opponent controls?', faceUp(e, other(p)));
          yield* e.destroy([mine, theirs].filter((m): m is FieldCard => !!m).map((m) => m.uid));
        } else if (a === 'WIND') {
          const c = yield* pickOne(e, p, 'Destroy which face-up Spell/Trap?', [...stOf(e, 0), ...stOf(e, 1)].filter((x) => x.faceUp));
          if (c) yield* e.destroy([c.uid]);
        } else if (a === 'WATER') e.draw(p, 1);
        else {
          const m = yield* pickOne(e, p, 'Change the battle position of which monster?', faceUpMonsters(e));
          if (m) yield* changePos(e, m);
        }
      },
    },
  } as SkillDef;
})();

