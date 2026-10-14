// Skill scripts for Speed Duel, keyed by Skill name.
// Skills are not card effects: they cannot be chained to or negated. "Once per Duel" is the
// engine's default for `use`; Skills that have several parts each "once per Duel" track them
// with e.oncePerDuel(key). Continuous Skills that have no activation start face-up (startOfDuel).
import type { SkillDef } from '../skills';
import { nameEngine } from '../names';
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
const freeMZ = (e: Engine, p: Pid) => e.freeMonsterZone(p) >= 0; // b20: skips blocked zones
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
/** "It's Jinzo!": "Jinzo" monsters are unaffected by the opponent's Skills. Filters what a Skill of `p` may affect. */
const affectable = <T extends FieldCard>(e: Engine, p: Pid, list: T[]) => list.filter((m) => !(e.isNamed(m, 'Jinzo') && e.controller(m.uid) === other(p) && e.player(other(p)).skill === "It's Jinzo!"));

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
/** Special Summons a card, then shuffles the Deck if it came from there. `ignoreCond`: ignoring its Summoning conditions. */
function* ss(e: Engine, p: Pid, c: Card, pos: 'atk' | 'def' = 'atk', ignoreCond = false): Gen<FieldCard | null> {
  if (!freeMZ(e, p)) return null;
  const fromDeck = e.find(c.uid)?.loc.zone === 'deck';
  if (ignoreCond) e.state.fx.ignoreCond = c.uid;
  try {
    yield* e.specialSummon(c.uid, p, pos);
  } finally {
    if (ignoreCond) e.state.fx.ignoreCond = undefined;
  }
  if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
  return e.fieldCard(c.uid);
}
function* ssOne(e: Engine, p: Pid, title: string, cards: Card[], pos: 'atk' | 'def' = 'atk', ignoreCond = false): Gen<FieldCard | null> {
  if (!freeMZ(e, p) || !cards.length) return null;
  const c = yield* pickOne(e, p, title, cards);
  return c ? yield* ss(e, p, c, pos, ignoreCond) : null;
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
function* fusionSummon(e: Engine, p: Pid, label: string, plans: FusionPlan[], banish = false, ignoreCond = false): Gen<FieldCard | null> {
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
  if (ignoreCond) e.state.fx.ignoreCond = f.uid;
  try {
    // Marked like a Polymerization Fusion Summon (tags.fusS, fx.fusionMatList) for cards that read it.
    if (!ignoreCond) (e.state.fx.fusionMatList ??= {})[f.uid] = chosen.map((c) => c.uid);
    yield* e.specialSummon(f.uid, p, 'atk', true, (fc) => void (ignoreCond || ((fc.tags ??= {}).fusS = 1)));
  } finally {
    if (ignoreCond) e.state.fx.ignoreCond = undefined;
  }
  if (e.fieldCard(f.uid)) e.log(p, `${e.player(p).name} ${ignoreCond ? 'Special' : 'Fusion'} Summons ${f.name}!`);
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
K['Tomb of the Pharaoh'] = { ...fieldSkill((e, m) => (e.namesOf(m).some((nm) => nm.startsWith("Gravekeeper's")) ? 200 : undefined)), namesAs: () => 'Necrovalley' };
// Its effect is exactly "Umi", and its name becomes "Umi": a card treated as Umi goes to the Field Zone.
K['Mythic Depths'] = {
  *startOfDuel(e, p) {
    const fc = e.placeSkillCard('Umi', p, 'field');
    if (fc) tag(fc).skillCard = 1;
  },
  // A Skill Card cannot be destroyed or targeted by card effects.
  eff: { shields: (e, _src, target, how, ctl) => how !== 'battle' && !!target.tags?.skillCard && e.controller(target.uid) === ctl },
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
      // "You cannot activate this Skill during your first turn of the Duel" (it may be activated during the opponent's turn before it).
      fc.placedTurn = 0;
      tag(fc).noActTurn = e.state.turnPlayer === p ? e.state.turn : e.state.turn + 1;
    }
  },
};

// ---------- Draw Phase searches ----------
K['Destiny Draw (Skill Card)'] = lpDraw('destiny', 2000, () => true, 'any card');
K['Flight of the Harpies'] = lpDraw('harpies', 1800, (e, c) => arch(e, c, 'Harpie'), 'a "Harpie" card');
K["Gravekeeper's Lot"] = lpDraw('gravekeeper', 1800, (e, c) => e.namesOf(c).some((nm) => nm.startsWith("Gravekeeper's")), 'a "Gravekeeper\'s" card');

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
        yield* ssOne(e, p, 'Double Evolution Pill: Special Summon a Level 7 or higher Dinosaur', targets(e, p), 'atk', true);
      },
    },
  } as SkillDef;
})();

K["I've Got Dino DNA!"] = {
  // "During each of your Draw Phases": right after the normal draw (a Draw Phase whose draw is skipped or replaced gives nothing).
  eff: {
    *onDrawPhase(e, _c, p, drawn) {
      e.player(p).skillRevealed = true;
      e.gainLp(p, 200);
      const ps = e.player(p);
      const c = drawn[0];
      if (c && e.find(c.uid)?.loc.zone === 'hand' && mon(e, c) && race(e, c) === 'Dinosaur' && (yield* e.yesno(p, `I've Got Dino DNA!: reveal ${c.name}, put it on the bottom of the Deck and draw 1 card?`))) {
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
  // "At any time": whenever you like during your own turn (Skills are used in your turn only).
  use: {
    oncePerDuel: false,
    repeat: true,
    can: (e, p) => e.player(p).deck.length > 0,
    *run(e, p) {
      yield* e.reveal(p, 'The top card of your Deck', e.player(p).deck.slice(0, 1));
    },
  },
};
K['Prescience'] = {
  // "At any time" once activated: whenever you like during your own turn.
  use: {
    oncePerDuel: false,
    repeat: true,
    can: (e, p) => (getN(e, p, 'prescience') > 0 || e.player(other(p)).lp > 2 * e.player(p).lp) && e.player(p).deck.length + e.player(other(p)).deck.length > 0,
    *run(e, p) {
      setN(e, p, 'prescience', 1);
      yield* e.reveal(p, 'The top cards of your Deck and your opponent\'s Deck', [...e.player(p).deck.slice(0, 1), ...e.player(other(p)).deck.slice(0, 1)]);
    },
  },
};
K['Mind Scan (Skill Card)'] = {
  // It activates at the start of the 3rd turn if your LP are 3000 or more (checked at the first moment of turn 3), and flips back
  // over for good once your LP drop below 3000. While active you may look whenever you like during your own turn.
  eff: {
    *stateCheck(e, _c, p) {
      const k = getN(e, p, 'mindScan');
      if (k === 0 && e.state.turn >= 3) {
        setN(e, p, 'mindScan', e.player(p).lp >= 3000 ? 1 : 2);
        if (e.player(p).lp >= 3000) {
          e.player(p).skillRevealed = true;
          e.log(p, `${e.player(p).name}'s Skill Mind Scan activates`);
        }
      } else if (k === 1 && e.player(p).lp < 3000) {
        setN(e, p, 'mindScan', 2);
        e.player(p).skillRevealed = false;
        e.log(p, `${e.player(p).name}'s Skill Mind Scan flips back over`);
      }
    },
  },
  use: {
    oncePerDuel: false,
    repeat: true,
    can: (e, p) => getN(e, p, 'mindScan') === 1 && faceDownST(e, other(p)).length > 0,
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
    can: (e, p) => faceUp(e, p, (m) => e.isNamed(m, 'Jinzo')).length > 0 && faceDownST(e, other(p)).length > 0,
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
    can: (e, p) => affectable(e, p, faceUpMonsters(e)).length > 0,
    *run(e, p) {
      const m = yield* pickOne(e, p, 'Power Up!: which monster gains 500 ATK?', affectable(e, p, faceUpMonsters(e)));
      if (m) boostTurn(m, 500);
    },
  },
};
K['Low Blow'] = {
  use: {
    phase: 'main',
    can: (e, p) => affectable(e, p, faceUpMonsters(e)).length > 0,
    *run(e, p) {
      const m = yield* pickOne(e, p, 'Low Blow: which monster loses 500 ATK/DEF?', affectable(e, p, faceUpMonsters(e)));
      if (m) boostTurn(m, -500, -500);
    },
  },
};
// Skills whose text states no limit can be used again on a later turn (they "flip over at the end of the turn"): once per turn.
K['Room for Growth'] = {
  use: {
    phase: 'main',
    oncePerDuel: false,
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
    oncePerDuel: false,
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
    can: (e, p) => faceUp(e, p, (m) => e.nameHas(m, 'Evil HERO')).length > 0 && e.player(p).hand.length > 0 && affectable(e, p, faceUp(e, other(p))).length > 0,
    *run(e, p) {
      if (!(yield* discardOne(e, p, 'Ruthless Means: discard 1 card', e.player(p).hand))) return;
      const m = yield* pickOne(e, p, 'Ruthless Means: choose a face-up monster your opponent controls', affectable(e, p, faceUp(e, other(p))));
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
    can: (e, p) => e.player(p).hand.length > 0 && [...e.player(p).deck, ...e.player(p).gy].some((c) => e.isNamed(c, 'Obelisk the Tormentor')),
    *run(e, p) {
      const cs = yield* pick(e, p, "It's No Monster, It's a God!: discard any number of cards", e.player(p).hand, 1, e.player(p).hand.length);
      for (const c of cs ?? []) yield* e.discard(p, c.uid);
      yield* toHandFrom(e, p, 'Add "Obelisk the Tormentor" to your hand', [...e.player(p).deck, ...e.player(p).gy].filter((c) => e.isNamed(c, 'Obelisk the Tormentor')));
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
      const ms = yield* pick(e, p, `Cold-Blooded Tactician: change the positions of up to ${n} monster(s)`, affectable(e, p, e.monsters(other(p))), 1, n);
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
  const targets = (e: Engine, p: Pid, d: Card) => inGY(e, p, (c) => water(e, c) && !e.sameName(c, d) && c.uid !== d.uid && levelOf(e, c) <= 2 * levelOf(e, d));
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
// Its "Helios monsters you control cannot be banished" part is not modelled (the engine has no hook that stops a banishment).
K['Setting Sun'] = (() => {
  const unknownAtk = (e: Engine, c: Card) => mon(e, c) && info(e, c).atk === -1;
  const targets = (e: Engine, p: Pid) => {
    const mine = new Set(stOf(e, p).concat(e.monsters(p)).filter((c) => c.faceUp).map((c) => c.name));
    return inDeck(e, p, (c) => unknownAtk(e, c) && !e.namesOf(c).some((nm) => mine.has(nm)));
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
    can: (e, p) => faceUp(e, p, (m) => e.isNamed(m, 'Serpent Night Dragon')).length > 0 && e.player(p).deck.length > 0,
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
        const opp = [...affectable(e, p, e.monsters(other(p))), ...stOf(e, other(p))];
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
    can: (e, p) => faceUp(e, p, (m) => e.isNamed(m, 'Hyozanryu')).length > 0 && e.player(p).deck.length > 0,
    *run(e, p) {
      const top = e.player(p).deck.slice(0, 4);
      yield* e.reveal(p, 'Under Pressure: revealed cards', top);
      yield* e.reveal(other(p), 'Your opponent reveals the top cards of their Deck', top);
      if (top.some((c) => e.isNamed(c, 'Carboneddon'))) {
        const h = yield* pickOne(e, p, 'Carboneddon: which "Hyozanryu" gains 1000 ATK?', faceUp(e, p, (m) => e.isNamed(m, 'Hyozanryu')));
        if (h) boostTurn(h, 1000);
      }
      if (top.some((c) => e.isNamed(c, 'Hydrogeddon'))) {
        const h = yield* pickOne(e, p, 'Hydrogeddon: which "Hyozanryu" is unaffected by your opponent\'s monster effects this turn?', faceUp(e, p, (m) => e.isNamed(m, 'Hyozanryu')));
        if (h) Object.assign(tag(h), { unaffTurn: e.state.turn, unaffBy: other(p) });
      }
      if (top.some((c) => e.isNamed(c, 'Oxygeddon')) && affectable(e, p, faceUp(e, other(p))).length) {
        const t = yield* pickOne(e, p, 'Oxygeddon: destroy which face-up monster?', affectable(e, p, faceUp(e, other(p))));
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
  // Second Skill: once per turn, when an attack is declared involving an opponent's monster and your "roid" monster, send 1 "roid"
  // monster from your Deck to the GY to switch that monster's original ATK/DEF (applied for that battle).
  *onAttack(e, p, attacker, target) {
    if (!target) return;
    const mineM = [attacker, target].find((m) => e.controller(m.uid) === p && m.faceUp && mon(e, m) && e.nameHas(m, 'roid'));
    const theirs = [attacker, target].find((m) => e.controller(m.uid) === other(p));
    const fodder = inDeck(e, p, (c) => mon(e, c) && e.nameHas(c, 'roid'));
    if (!mineM || !theirs || !fodder.length || !e.oncePerTurn('skill:roidSwap', p)) return;
    if (!(yield* e.yesno(p, `Small Roid Big City: send a "roid" monster from your Deck to the GY to switch ${mineM.name}'s original ATK and DEF?`))) return;
    const c = yield* pickOne(e, p, 'Send which "roid" monster to the GY?', fodder);
    if (!c) return;
    e.useOnce('skill:roidSwap', p);
    e.player(p).skillRevealed = true;
    yield* e.sendToGrave(c.uid, 'cost');
    e.player(p).deck = e.shuffle(e.player(p).deck);
    tag(mineM).roidSwap = e.state.fx.battleNo ?? 0;
    e.log(p, `${mineM.name}'s original ATK and DEF are switched for this battle`);
  },
  aura(e, _p, m) {
    const b = e.state.battle;
    if (!b || m.tags?.roidSwap === undefined || m.tags.roidSwap !== e.state.fx.battleNo || (b.attacker !== m.uid && b.target !== m.uid)) return undefined;
    const base = e.baseStats(m);
    return { atk: base.def - base.atk, def: base.atk - base.def };
  },
  use: {
    oncePerDuel: false,
    can: (e, p) => [...faceUp(e, p), ...stOf(e, p).filter((c) => c.faceUp)].length > 0 && inDeck(e, p, (c) => e.nameHas(c, 'roid')).length > 0,
    *run(e, p) {
      const t = yield* pickOne(e, p, 'Small Roid Big City: destroy which face-up card you control?', [...faceUp(e, p), ...stOf(e, p).filter((c) => c.faceUp)]);
      if (!t) return;
      yield* e.destroy([t.uid]);
      if (e.fieldCard(t.uid)) return;
      yield* toHandFrom(e, p, 'Add 1 "roid" card from your Deck to your hand', inDeck(e, p, (c) => e.nameHas(c, 'roid')));
    },
  },
};
K['Victory of the Shadow Riders'] = (() => {
  const LORDS = ['Uria, Lord of Searing Flames', 'Hamon, Lord of Striking Thunder', 'Raviel, Lord of Phantasms'];
  const lords = (e: Engine, p: Pid) => inDeck(e, p, (c) => e.namesOf(c).some((nm) => LORDS.includes(nm)));
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
  const amaz = (e: Engine, c: Card) => mon(e, c) && e.nameHas(c, 'Amazoness');
  const harp = (e: Engine, c: Card) => mon(e, c) && arch(e, c, 'Harpie');
  const inH = (e: Engine, p: Pid) => opd(e, p, 'tribal1') && inHand(e, p, (c) => amaz(e, c)).length > 0 && inHand(e, p, (c) => harp(e, c)).length > 0 && e.player(p).deck.length > 0;
  const onF = (e: Engine, p: Pid) => opd(e, p, 'tribal2') && faceUp(e, p, (m) => amaz(e, m)).length > 0 && faceUp(e, p, (m) => harp(e, m)).length > 0 && e.player(p).deck.length > 0;
  return {
    *startOfDuel() {},
    use: {
      phase: 'main',
      oncePerDuel: false,
      repeat: true,
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
    const dmDeck = inDeck(e, p, (c) => e.isNamed(c, 'Dark Magician'));
    const dmHand = inHand(e, p, (c) => e.isNamed(c, 'Dark Magician'));
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
    can: (e, p) => faceUp(e, p, (m) => e.isNamed(m, 'Dark Magician')).length > 0 && e.player(p).deck.length >= 2,
    *run(e, p) {
      const m = yield* pickOne(e, p, 'Tribute which "Dark Magician"?', faceUp(e, p, (x) => e.isNamed(x, 'Dark Magician')));
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
      (normalSummonedNow(e, p, (m) => e.isNamed(m, 'Lord of D.')) && [...e.player(p).deck, ...e.player(p).gy].some((c) => e.isNamed(c, 'The Flute of Summoning Dragon'))) ||
      (inHand(e, p, (c) => e.isNamed(c, 'The Flute of Summoning Dragon')).length > 0 && [...e.player(p).deck, ...e.player(p).gy].some((c) => e.isNamed(c, 'Lord of D.'))),
    *run(e, p) {
      const pool = [...e.player(p).deck, ...e.player(p).gy];
      const a = normalSummonedNow(e, p, (m) => e.isNamed(m, 'Lord of D.')) && pool.some((c) => e.isNamed(c, 'The Flute of Summoning Dragon'));
      const b = inHand(e, p, (c) => e.isNamed(c, 'The Flute of Summoning Dragon')).length > 0 && pool.some((c) => e.isNamed(c, 'Lord of D.'));
      const o = a && b ? yield* chooseOption(e, p, 'Dragon Caller: which Skill?', ['Add "The Flute of Summoning Dragon"', 'Reveal the Flute, add "Lord of D."']) : a ? 0 : 1;
      if (o === 0) yield* toHandFrom(e, p, 'Add "The Flute of Summoning Dragon"', pool.filter((c) => e.isNamed(c, 'The Flute of Summoning Dragon')));
      else {
        yield* e.reveal(other(p), 'Your opponent reveals', inHand(e, p, (c) => e.isNamed(c, 'The Flute of Summoning Dragon')).slice(0, 1));
        yield* toHandFrom(e, p, 'Add "Lord of D."', pool.filter((c) => e.isNamed(c, 'Lord of D.')));
      }
    },
  },
};
K['Magnetic Attraction'] = (() => {
  const mw = (e: Engine, c: Card) => mon(e, c) && e.nameHas(c, 'Magnet Warrior') && levelOf(e, c) <= 4;
  const a = (e: Engine, p: Pid) => {
    if (!opd(e, p, 'magnet1')) return [];
    const now = e.monsters(p).filter((m) => m.faceUp && m.placedTurn === e.state.turn && !m.posChanged && mw(e, m));
    if (!e.player(p).normalSummoned || !now.length) return [];
    return inDeck(e, p, (c) => mw(e, c) && now.some((m) => !e.sameName(m, c)));
  };
  const b = (e: Engine, p: Pid) => opd(e, p, 'magnet2') && new Set(inHand(e, p, (c) => mw(e, c)).map((c) => c.name)).size >= 2 && inDeck(e, p, (c) => e.isNamed(c, 'Valkyrion the Magna Warrior')).length > 0;
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
          const second = first ? yield* pickOne(e, p, 'Reveal another "Magnet Warrior" with a different name', inHand(e, p, (c) => mw(e, c) && !e.sameName(c, first))) : null;
          yield* e.reveal(other(p), 'Your opponent reveals', [first, second].filter((c): c is Card => !!c));
          yield* toHandFrom(e, p, 'Add "Valkyrion the Magna Warrior"', inDeck(e, p, (c) => e.isNamed(c, 'Valkyrion the Magna Warrior')));
        }
      },
    },
  } as SkillDef;
})();
K['Machine Angel Ascension'] = (() => {
  const piece = (e: Engine, c: Card) => (mon(e, c) && info(e, c).sub === 'Ritual' && e.nameHas(c, 'Cyber Angel')) || (isSpell(e, c) && info(e, c).sub === 'Ritual' && e.nameHas(c, 'Machine Angel'));
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
          yield* ssOne(e, p, 'Special Summon an Insect monster from your Deck', inDeck(e, p, (c) => insect(e, c)), 'atk', true);
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
  const a = (e: Engine, p: Pid) => opd(e, p, 'fury1') && faceUp(e, p, (m) => e.isNamed(m, 'Slifer the Sky Dragon')).length > 0 && e.player(p).hand.length < 4;
  // "If Slifer is sent to the GY": offered while Slifer is in your GY.
  const b = (e: Engine, p: Pid) => opd(e, p, 'fury2') && inGY(e, p, (c) => e.isNamed(c, 'Slifer the Sky Dragon')).length > 0;
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
          const c = inGY(e, p, (x) => e.isNamed(x, 'Slifer the Sky Dragon'))[0];
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
  const pawns = (e: Engine, p: Pid) => faceUp(e, p, (m) => e.isNamed(m, 'Vilepawn Archfiend') && free(e, p, m));
  const targets = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.player(p).deck].filter((c) => summonable(e, c) && e.nameHas(c, 'Archfiend') && RANKS.test(c.name) && levelOf(e, c) <= 8);
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
  const pool = (e: Engine, p: Pid, names: string[], except: number) => [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy].filter((c) => c.uid !== except && e.namesOf(c).some((nm) => names.includes(nm)));
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
        // "As if it were Summoned by the sent monster's effect": its own "Special Summoned by the effect of ..." condition is met.
        yield* ssOne(e, p, 'Special Summon the "LV" monster it mentions', pool(e, p, names, -1), 'atk', true);
      },
    },
  } as SkillDef;
})();
K['The Right Hero for the Job'] = (() => {
  const hero = (e: Engine, c: Card) => mon(e, c) && e.nameHas(c, 'Elemental HERO');
  const shuffleable = (e: Engine, p: Pid) => faceUp(e, p, (m) => hero(e, m) && info(e, m).sub !== 'Fusion' && inDeck(e, p, (c) => summonable(e, c) && hero(e, c) && levelOf(e, c) <= 4 && !e.sameName(c, m)).length > 0);
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
  const ojamaMon = (e: Engine, c: Card) => mon(e, c) && e.namesOf(c).some((nm) => nm.startsWith('Ojama'));
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
      can: (e, p) => freeMZ(e, p) && inHand(e, p, (c) => e.namesOf(c).some((nm) => nm.startsWith('Ojama'))).length > 0 && (inGY(e, p, (c) => summonable(e, c) && ojamaMon(e, c)).length > 0 || inHand(e, p, (c) => summonable(e, c) && ojamaMon(e, c)).length > 0),
      *run(e, p) {
        const c = yield* pickOne(e, p, 'Land of the Ojamas: send which "Ojama" card to the GY?', inHand(e, p, (x) => e.namesOf(x).some((nm) => nm.startsWith('Ojama')) && (summonable(e, x) && ojamaMon(e, x) ? true : inGY(e, p, (g) => summonable(e, g) && ojamaMon(e, g)).length > 0)));
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
    // "Once while face-up, when this card is targeted for an attack": the attacker's ATK becomes 0 until the end of the Damage Step.
    *onAttack(e, p, attacker, target) {
      if (!target || !e.isNamed(target, 'Gate Guardian') || !target.faceUp || e.controller(target.uid) !== p || e.controller(attacker.uid) === p) return;
      if (target.tags?.gateUsed || !(yield* e.yesno(p, `Gate Guardian: change ${attacker.name}'s ATK to 0 until the end of the Damage Step?`))) return;
      tag(target).gateUsed = 1;
      e.state.fx.zeroAttack = attacker.uid;
      e.log(p, `Gate Guardian: ${attacker.name}'s ATK becomes 0 for this battle`);
    },
    use: {
      phase: 'main',
      oncePerDuel: false,
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
    // The computer only trades its hand away once the hand is nearly spent.
    ai: (e: Engine, p: Pid) => e.player(p).hand.length <= 2,
  } as SkillDef;
})();
K['Ancient Ruler Rises'] = (() => {
  const SARC = ['The First Sarcophagus', 'The Second Sarcophagus', 'The Third Sarcophagus'];
  const zombie2 = (e: Engine, c: Card) => mon(e, c) && race(e, c) === 'Zombie' && levelOf(e, c) === 2;
  const sarcs = (e: Engine, p: Pid) => [...e.player(p).deck, ...e.player(p).gy, ...e.player(p).removed].filter((c) => e.namesOf(c).some((nm) => SARC.includes(nm)));
  return {
    *startOfDuel() {},
    aura(e, p, m) {
      if (!e.isNamed(m, 'Spirit of the Pharaoh') || e.controller(m.uid) !== p) return undefined;
      const servant = (c: Card) => e.isNamed(c, "Pharaoh's Servant") || e.isNamed(c, 'Pharaonic Protector');
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
      return (e.player(p).skillUses ?? 0) < met && inDeck(e, p, (c) => mon(e, c) && e.nameHas(c, 'Cyberdark')).length >= 3;
    },
    *run(e, p) {
      const three = yield* pick(e, p, 'Cyberdark Style: choose 3 "Cyberdark" monsters from your Deck', inDeck(e, p, (c) => mon(e, c) && e.nameHas(c, 'Cyberdark')), 3, 3);
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
    if (e.isNamed(monster, e.ritualOf(spell.name)?.monster ?? '')) return true;
    const d = info(e, spell).desc ?? '';
    if (d.includes(`"${monster.name}"`)) return true;
    return [...d.matchAll(/Ritual Summon (?:any|1) "([^"]+)"/g)].some((x) => e.nameHas(monster, x[1]));
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
  const hero = (c: Card) => nameEngine().nameHas(c, 'Elemental HERO');
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
  const plans = (e: Engine, p: Pid, except: number) => fusionPlans(e, p, (f) => e.isNamed(f, 'Chimera the Flying Mythical Beast'), () => without(handField(e, p), except));
  const d = discardFuse('Beasts of Phantom', plans);
  const beasts = (e: Engine, p: Pid) => inGY(e, p, (c) => mon(e, c) && arch(e, c, 'Phantom Beast'));
  return {
    // "If Chimera was Fusion Summoned this turn" by any card (a Special Summon from the Extra Deck).
    eff: {
      *onAnySummon(e, _c, ctl, m, mctl, kind) {
        if (kind === 'special' && mctl === ctl && e.isNamed(m, 'Chimera the Flying Mythical Beast') && m.tags?.ssExtra) setN(e, ctl, 'chimera', e.state.turn);
      },
    },
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
      e.player(p).skillRevealed = true;
      yield* toHandFrom(e, p, 'Add a "Phantom Beast" monster', beasts(e, p));
    },
  } as SkillDef;
})();
K['Cyber Blade Fusion'] = (() => {
  const plans = (e: Engine, p: Pid, except: number) =>
    fusionPlans(
      e,
      p,
      (f) => e.isNamed(f, 'Cyber Blader'),
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
        // The materials are banished, as that monster's own Summon procedure does; its Summoning conditions are ignored.
        yield* fusionSummon(e, p, 'Union Combination', plans(e, p), true, true);
        // "For the rest of this turn, your opponent takes no damage."
        ((e.state.fx.noDamage ??= [-1, -1]) as number[])[other(p)] = e.state.turn;
      },
    },
  } as SkillDef;
})();
K['Thousand-Eyes Spell'] = (() => {
  const fplans = (e: Engine, p: Pid, except: number) => fusionPlans(e, p, (f) => e.isNamed(f, 'Thousand-Eyes Restrict'), () => without(handField(e, p), except));
  const relinq = (e: Engine, p: Pid, except: number) => inHand(e, p, (c) => c.uid !== except && e.isNamed(c, 'Relinquished'));
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
            ((e.state.fx.ritualMats ??= {}) as Record<number, { mats: number[]; turn: number }>)[r.uid] = { mats: [t.uid], turn: e.state.turn };
            yield* e.specialSummon(r.uid, p, 'atk');
            e.log(p, `${e.player(p).name} Ritual Summons Relinquished!`);
          }
        } else yield* fusionSummon(e, p, 'Thousand-Eyes Spell', fplans(e, p, -1));
        // "You cannot conduct your Battle Phase this turn" (monsters Summoned later this turn included).
        ((e.state.fx.noDeclare ??= [-1, -1]) as number[])[p] = e.state.turn;
      },
    },
  } as SkillDef;
})();
K['Believe in your Bro'] = (() => {
  const hero = (c: Card) => nameEngine().nameHas(c, 'Elemental HERO');
  const roid = (e: Engine, c: Card) => mon(e, c) && e.nameHas(c, 'roid') && race(e, c) === 'Machine';
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
          const t = affectable(e, p, faceUp(e, other(p), (m) => e.atkOf(m) <= origAtk(e, r)));
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
  const heroes = (e: Engine, p: Pid) => faceUp(e, p, (m) => e.nameHas(m, 'HERO') && (isNormalMonster(e, m) || info(e, m).sub === 'Fusion'));
  const fireTargets = (e: Engine, p: Pid) => affectable(e, p, faceUpMonsters(e).filter((m) => attrOf(e, m) !== 'FIRE' && !!m.tags?.ss));
  const options = (e: Engine, p: Pid) => {
    const attrs = new Set(heroes(e, p).map((m) => attrOf(e, m)));
    const out: string[] = [];
    if (attrs.has('EARTH') && faceUp(e, p, (m) => attrOf(e, m) === 'EARTH').length && affectable(e, p, faceUp(e, other(p))).length) out.push('EARTH');
    if (attrs.has('WIND') && [...stOf(e, 0), ...stOf(e, 1)].some((c) => c.faceUp)) out.push('WIND');
    if (attrs.has('FIRE') && fireTargets(e, p).length) out.push('FIRE');
    if (attrs.has('WATER') && e.player(p).deck.length) out.push('WATER');
    if (attrs.has('LIGHT') && affectable(e, p, faceUpMonsters(e)).length) out.push('LIGHT');
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
          const theirs = yield* pickOne(e, p, 'Destroy which face-up monster your opponent controls?', affectable(e, p, faceUp(e, other(p))));
          yield* e.destroy([mine, theirs].filter((m): m is FieldCard => !!m).map((m) => m.uid));
        } else if (a === 'WIND') {
          const c = yield* pickOne(e, p, 'Destroy which face-up Spell/Trap?', [...stOf(e, 0), ...stOf(e, 1)].filter((x) => x.faceUp));
          if (c) yield* e.destroy([c.uid]);
        } else if (a === 'FIRE') {
          const back = fireTargets(e, p);
          e.log(p, `HERO World: ${back.map((m) => m.name).join(', ')} return to the hand`);
          e.bounce(back.map((m) => m.uid));
        } else if (a === 'WATER') e.draw(p, 1); // its "activate 1 Normal Trap from your hand" part is not modelled (Traps are activated from the field only)
        else {
          const m = yield* pickOne(e, p, 'Change the battle position of which monster?', affectable(e, p, faceUpMonsters(e)));
          if (m) yield* changePos(e, m);
        }
      },
    },
  } as SkillDef;
})();


// ======================================================================================
// audit-skills: the rest of the Speed Duel Skills. Continuous parts use SkillDef.eff (run like an active Spell/Trap the
// Skill's owner controls) and the SkillDef battle hooks; each Skill checks its own conditions.
// ======================================================================================
const isTurn = (e: Engine, p: Pid, k: string) => getN(e, p, k) === e.state.turn && e.state.turn > 0;
const reveal = (e: Engine, p: Pid) => void (e.player(p).skillRevealed = true);
/** Attribute as it is now (effects that change it on the field: fx.declAttr). */
const attrNow = (e: Engine, c: Card): string => ('faceUp' in c && e.find(c.uid)?.loc.zone === 'mz' && (e.state.fx.declAttr as Record<number, string> | undefined)?.[c.uid]) || attrOf(e, c);
const ctlOf = (e: Engine, m: Card) => e.controller(m.uid);
const fusionOf = (e: Engine, c: Card) => info(e, c).sub === 'Fusion';
const tribsFor = (e: Engine, c: Card) => e.tributesNeeded(levelOf(e, c));

/** The monsters of a battle in progress (state.battle). */
function battling(e: Engine): { a: FieldCard | null; t: FieldCard | null } | null {
  const b = e.state.battle;
  return b ? { a: e.fieldCard(b.attacker), t: b.target !== null ? e.fieldCard(b.target) : null } : null;
}

// ----- battle damage bookkeeping: which 'damage' events were battle damage -----
type Hit = { p: Pid; seq: number; battle: number; turn: number };
/** Called from a Skill's damageMod: the next 'damage' event for `damaged` is battle damage of the current battle. */
function noteBattleHit(e: Engine, damaged: Pid, byEffect: boolean) {
  if (byEffect) return;
  const seq = e.state.lastEvent?.seq ?? 0;
  const list = ((e.state.fx.skillHits ??= []) as Hit[]).filter((h) => h.turn === e.state.turn);
  if (!list.some((h) => h.p === damaged && h.seq === seq)) list.push({ p: damaged, seq, battle: e.state.fx.battleNo ?? 0, turn: e.state.turn });
  e.state.fx.skillHits = list;
}
/** Battle damage `p` took in this battle (the Skill's damageMod must call noteBattleHit). */
function battleDamageIn(e: Engine, p: Pid, battle = e.state.fx.battleNo ?? 0): number {
  const evs = e.state.events ?? [];
  let n = 0;
  for (const h of (e.state.fx.skillHits ?? []) as Hit[]) {
    if (h.p !== p || h.battle !== battle || h.turn !== e.state.turn) continue;
    const ev = evs.find((x) => x.seq > h.seq && x.kind === 'damage' && x.player === p);
    if (ev) n += ev.amount ?? 0;
  }
  return n;
}

// ----- name changes made by Skills: undone when the card leaves the field (or at the End Phase) -----
type Rename = { uid: number; orig: string; until?: number };
function rename(e: Engine, m: FieldCard, name: string, until?: number) {
  // Only the name changes (the card keeps its own effects); the engine's name rule shows it and every name check reads it.
  e.log(ctlOf(e, m), `${e.nameOf(m)}'s name becomes "${name}"`);
  e.renameUntilEnd(m.uid, name, until !== undefined);
}
function restoreRenames(e: Engine, endPhase = false) {
  const list = (e.state.fx.skillRenames ?? []) as Rename[];
  if (!list.length) return;
  e.state.fx.skillRenames = list.filter((r) => {
    const f = e.find(r.uid);
    if (!f) return false;
    const onField = f.loc.zone === 'mz' || f.loc.zone === 'sz' || f.loc.zone === 'field';
    const over = r.until !== undefined && (e.state.turn > r.until || (endPhase && e.state.turn === r.until));
    if (onField && !over) return true;
    f.card.name = r.orig;
    return false;
  });
}
const renameFx: Partial<EffectDefLite> = {
  *stateCheck(e: Engine) {
    restoreRenames(e);
  },
};
// ----- Type/Attribute changes "until the end of this turn" -----
type Temp = { uid: number; key: 'declRace' | 'declAttr'; value: string; prev?: string; turn: number };
function setTemp(e: Engine, m: FieldCard, key: 'declRace' | 'declAttr', value: string) {
  const map = (e.state.fx[key] ??= {}) as Record<number, string>;
  ((e.state.fx.skillTemps ??= []) as Temp[]).push({ uid: m.uid, key, value, prev: map[m.uid], turn: e.state.turn });
  map[m.uid] = value;
}
function restoreTemps(e: Engine) {
  const list = (e.state.fx.skillTemps ?? []) as Temp[];
  e.state.fx.skillTemps = list.filter((t) => {
    if (t.turn >= e.state.turn) return true;
    const map = (e.state.fx[t.key] ?? {}) as Record<number, string>;
    if (map[t.uid] === t.value) {
      if (t.prev === undefined) delete map[t.uid];
      else map[t.uid] = t.prev;
    }
    return false;
  });
}
/** End Phase cleanup of this turn's temporary changes (it runs after the turn number moves on: see restoreTemps). */
function* endOfTurnCleanup(e: Engine): Step {
  const list = (e.state.fx.skillTemps ?? []) as Temp[];
  for (const t of list) if (t.turn === e.state.turn) t.turn = -1;
  restoreTemps(e);
  restoreRenames(e, true);
}
type EffectDefLite = NonNullable<SkillDef['eff']>;

/** Activates a Field Spell from the hand, Deck or GY (a face-up Field Spell already there is sent to the GY). */
function* activateField(e: Engine, p: Pid, c: Card): Step {
  const ps = e.player(p);
  if (ps.field) yield* e.sendToGrave(ps.field.uid, 'used');
  const f = e.find(c.uid);
  if (!f || ps.field || !['hand', 'deck', 'gy'].includes(f.loc.zone)) return;
  e.player(f.loc.player)[f.loc.zone as 'hand' | 'deck' | 'gy'].splice(f.loc.index, 1);
  if (f.loc.zone === 'deck') ps.deck = e.shuffle(ps.deck);
  ps.field = { uid: c.uid, name: c.name, owner: c.owner, pos: 'atk', faceUp: true, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true };
  e.event('activate', { uid: c.uid, player: p });
  e.log(p, `${ps.name} activates ${c.name}`);
}
/** Sets a Spell/Trap from the hand or a GY face-down in `p`'s Spell & Trap Zone (a Field Spell: the Field Zone). */
function setST(e: Engine, p: Pid, c: Card): boolean {
  const ps = e.player(p);
  const f = e.find(c.uid);
  if (!f || (f.loc.zone !== 'hand' && f.loc.zone !== 'gy')) return false;
  const field = info(e, c).sub === 'Field';
  const z = field ? (ps.field ? -1 : 0) : freeST(e, p);
  if (z < 0) return false;
  e.player(f.loc.player)[f.loc.zone].splice(f.loc.index, 1);
  const fc: FieldCard = { uid: c.uid, name: c.name, owner: c.owner, pos: 'atk', faceUp: false, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
  if (field) ps.field = fc;
  else ps.sz[z] = fc;
  e.event('set', { uid: c.uid, player: p });
  e.log(p, `${ps.name} Sets a card`);
  return true;
}

// ----- Ancient Fusion -----
K['Ancient Fusion'] = (() => {
  const ag = (c: Card) => nameEngine().nameHas(c, 'Ancient Gear');
  const golem = (c: Card) => nameEngine().nameHas(c, 'Ancient Gear Golem');
  // Materials from your field; if one of them is an "Ancient Gear Golem" monster, the other(s) may come from the hand or Deck.
  const plans = (e: Engine, p: Pid, except: number) =>
    fusionPlans(
      e,
      p,
      (f) => ag(f),
      () => [...e.monsters(p).filter((m) => m.faceUp), ...without(inHand(e, p, (c) => mon(e, c)), except), ...inDeck(e, p, (c) => mon(e, c))],
      (_f, mats) => mats.every((c) => !!e.fieldCard(c.uid)) || mats.some((c) => golem(c) && !!e.fieldCard(c.uid)),
    );
  const d = discardFuse('Ancient Fusion', plans);
  return {
    use: {
      phase: 'main',
      can: d.can,
      *run(e, p) {
        const m = yield* d.run(e, p);
        if (m) tag(m).ancientFusion = 1;
        ((e.state.fx.noDamage ??= [-1, -1]) as number[])[other(p)] = e.state.turn;
      },
    },
    // Any battle damage the opponent takes from that Fusion Monster is halved.
    eff: {
      damageMod(e, _c, ctl, damaged, amount, byEffect) {
        const b = battling(e);
        if (byEffect || damaged !== other(ctl) || !b) return undefined;
        const src = [b.a, b.t].find((m) => m && m.tags?.ancientFusion && ctlOf(e, m) === ctl);
        return src ? Math.floor(amount / 2) : undefined;
      },
    },
  } as SkillDef;
})();

// ----- Archfiend's Conscription -----
K["Archfiend's Conscription"] = {
  *startOfDuel() {},
  eff: { forbidsSummon: (e, _c, ctl, monster, summoner) => summoner === ctl && race(e, monster) !== 'Fiend' },
  use: {
    phase: 'main',
    oncePerDuel: false,
    can: (e, p) => e.player(p).lp > 0,
    *run(e, p) {
      const n = e.roll(6);
      e.log(p, `Archfiend's Conscription: the die shows ${n}`);
      e.payLp(p, n * 200);
      if (e.state.winner !== null || n < 2 || n > 4) return;
      const list = [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy].filter((c) => summonable(e, c) && e.nameHas(c, 'Archfiend') && levelOf(e, c) === n);
      if (!list.length || !freeMZ(e, p) || !(yield* e.yesno(p, `Special Summon a Level ${n} "Archfiend" monster from your hand, Deck or GY?`))) return;
      yield* ssOne(e, p, `Special Summon a Level ${n} "Archfiend" monster`, list);
    },
  },
  ai: (e, p) => e.player(p).lp > 1500,
};

// ----- Beware the Brothers Paradox! -----
K['Beware the Brothers Paradox!'] = {
  *startOfDuel() {},
  eff: {
    tributeDiscount: (e, _c, ctl, monster, summoner) => (summoner === ctl && levelOf(e, monster) === 7 ? 1 : 0),
    damageMod: (_e, _c, ctl, damaged, _amount, byEffect) => (byEffect && damaged === other(ctl) ? 0 : undefined),
  },
  extraTributeFor: (e, _p, card) => levelOf(e, card) === 7,
  // Only 1 monster attacks each turn; it can make a second attack, on a monster.
  mayAttack: (e, p, m) => !e.state.attackedThisTurn.some((u) => u !== m.uid) && !(m.attacked && e.monsters(other(p)).length === 0),
  extraAttacks: () => 1,
};

// ----- Blaze Accelerator Deployment -----
// The card becomes "Tri-Blaze Accelerator" while on the field (it takes on Tri-Blaze Accelerator's effects too).
K['Blaze Accelerator Deployment (Skill Card)'] = {
  eff: { ...renameFx },
  use: {
    oncePerDuel: true,
    timesPerDuel: 2,
    can: (e, p) => stOf(e, p).some((c) => c.faceUp && e.isNamed(c, 'Blaze Accelerator')),
    *run(e, p) {
      const c = yield* pickOne(e, p, 'Change the name of which "Blaze Accelerator"?', stOf(e, p).filter((x) => x.faceUp && e.isNamed(x, 'Blaze Accelerator')));
      if (c) rename(e, c, 'Tri-Blaze Accelerator');
    },
  },
};

// ----- Catch of the Day -----
K['Catch of the Day'] = (() => {
  const fisher = (e: Engine, p: Pid) => faceUp(e, p, (m) => e.isNamed(m, 'The Legendary Fisherman'));
  const umi = (e: Engine, p: Pid) => [...e.player(p).deck, ...e.player(p).gy].filter((c) => e.isNamed(c, 'Umi'));
  const water = (e: Engine, p: Pid) => [...e.player(p).deck, ...e.player(p).gy].filter((c) => summonable(e, c) && attrOf(e, c) === 'WATER' && levelOf(e, c) <= 4);
  function* trigger(e: Engine, p: Pid): Step {
    if (!e.oncePerTurn('skill:catch', p) || !freeMZ(e, p) || !water(e, p).length) return;
    if (!(yield* e.yesno(p, 'Catch of the Day: Special Summon a Level 4 or lower WATER monster from your Deck or GY in Defense Position?'))) return;
    e.useOnce('skill:catch', p);
    reveal(e, p);
    yield* ssOne(e, p, 'Special Summon which WATER monster?', water(e, p), 'def');
  }
  return {
    use: {
      can: (e, p) => fisher(e, p).length > 0 && umi(e, p).length > 0,
      *run(e, p) {
        const c = yield* pickOne(e, p, 'Activate which "Umi"?', umi(e, p));
        if (c) yield* activateField(e, p, c);
      },
    },
    eff: {
      damageMod(e, _c, _ctl, damaged, _amount, byEffect) {
        noteBattleHit(e, damaged, byEffect);
        return undefined;
      },
      *afterAnyBattle(e, _c, p, attacker, target) {
        const f = [attacker, target].find((m) => e.isNamed(m, 'The Legendary Fisherman') && ctlOf(e, m) === p);
        const foe = f === attacker ? target : attacker;
        if (!f || !e.fieldCard(f.uid)) return;
        if ((!e.fieldCard(foe.uid) && !!e.find(foe.uid)) || battleDamageIn(e, other(p)) > 0) yield* trigger(e, p);
      },
      *onBattleDamageDealt(e, _c, attacker, p) {
        if (e.state.battle?.target === null && e.isNamed(attacker, 'The Legendary Fisherman') && ctlOf(e, attacker) === p) yield* trigger(e, p);
      },
    },
  } as SkillDef;
})();

// ----- Chemistry in Motion -----
K['Chemistry in Motion'] = (() => {
  const dino = (e: Engine, c: Card) => mon(e, c) && race(e, c) === 'Dinosaur';
  const n = (e: Engine, p: Pid) => e.skillCard(p)?.counters ?? 0;
  const c1 = (e: Engine, p: Pid) => inHand(e, p, (c) => dino(e, c) && inDeck(e, p, (d) => dino(e, d) && attrOf(e, d) !== attrOf(e, c)).length > 0);
  const c2 = (e: Engine, p: Pid) => inHand(e, p, (c) => dino(e, c) && ['WIND', 'WATER'].includes(attrOf(e, c)) && e.canNormalSummon(p, c, true, true));
  const waterDinos = (e: Engine, p: Pid) => faceUp(e, p, (m) => e.raceOf(m) === 'Dinosaur' && attrNow(e, m) === 'WATER');
  const bonding = (e: Engine, p: Pid) => [...e.player(p).deck, ...e.player(p).gy].filter((c) => e.isNamed(c, 'Bonding - H2O'));
  const ready = (e: Engine, p: Pid) => {
    const k = n(e, p) + 1;
    if (k === 1) return c1(e, p).length > 0;
    if (k === 2) return c2(e, p).length > 0;
    if (k === 3) return waterDinos(e, p).length > 0 || bonding(e, p).length > 0;
    return true;
  };
  return {
    eff: { ...renameFx },
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => !!e.skillCard(p) && ready(e, p),
      *run(e, p) {
        const sc = e.skillCard(p)!;
        sc.counters++;
        e.log(p, `Chemistry in Motion: ${sc.counters} counter(s)`);
        if (sc.counters === 1) {
          const d = yield* discardOne(e, p, 'Discard 1 Dinosaur monster', c1(e, p));
          if (d) yield* toHandFrom(e, p, 'Add a Dinosaur monster with a different Attribute', inDeck(e, p, (c) => dino(e, c) && attrOf(e, c) !== attrOf(e, d)));
        } else if (sc.counters === 2) {
          const c = yield* pickOne(e, p, 'Normal Summon which WIND or WATER Dinosaur?', c2(e, p));
          if (c) yield* e.extraNormalSummon(p, c.uid, 'atk', true);
        } else if (sc.counters === 3) {
          for (const m of waterDinos(e, p)) rename(e, m, 'Hydrogeddon', e.state.turn);
          if (bonding(e, p).length) yield* toHandFrom(e, p, 'Add "Bonding - H2O" to your hand', bonding(e, p));
        } else {
          sc.counters = 0;
          for (const m of affectable(e, p, faceUp(e, other(p)))) {
            setTemp(e, m, 'declAttr', 'FIRE');
            setTemp(e, m, 'declRace', 'Pyro');
          }
          e.log(p, "Chemistry in Motion: your opponent's face-up monsters become FIRE Pyro monsters this turn");
        }
      },
    },
    onEndPhase: endOfTurnCleanup,
  } as SkillDef;
})();

// ----- Chillin' Outback -----
K["Chillin' Outback"] = (() => {
  const roo = (m: Card) => nameEngine().nameHas(m, 'Koala') || nameEngine().nameHas(m, 'Kangaroo');
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e) => faceUpMonsters(e).some(roo),
      *run(e, p) {
        const m = yield* pickOne(e, p, 'Change the battle position of which "Koala" or "Kangaroo" monster?', affectable(e, p, faceUpMonsters(e).filter(roo)));
        if (m) yield* changePos(e, m);
      },
    },
    attackInDefense: (_e, _p, m) => m.faceUp && m.pos === 'def' && roo(m),
    // Its DEF is applied for damage calculation when it attacks from Defense Position.
    attackBonus: (e, _p, m) => (m.pos === 'def' && roo(m) ? e.defOf(m) - e.atkOf(m) : 0),
  } as SkillDef;
})();

// ----- Cloudy Skies of Grey -----
// Fog Counters are read from what the monster had when the field was last checked (after the previous action).
K['Cloudy Skies of Grey'] = {
  *startOfDuel() {},
  eff: {
    *stateCheck(e) {
      const snap: Record<number, number> = {};
      for (const m of faceUpMonsters(e)) if (m.tags?.fog) snap[m.uid] = m.tags.fog;
      e.state.fx.fogSnap = snap;
    },
    *onAnyToGrave(e, _c, p, events) {
      const snap = (e.state.fx.fogSnap ?? {}) as Record<number, number>;
      for (const ev of events) {
        const n = snap[ev.card.uid] ?? 0;
        if (ev.from !== 'mz' || ev.reason !== 'destroyed' || !e.nameHas(ev.card, 'Cloudian') || n <= 0) continue;
        delete snap[ev.card.uid];
        const t = yield* pickOne(e, p, `Cloudy Skies of Grey: place ${n} Fog Counter(s) on which monster?`, faceUpMonsters(e));
        if (!t) continue;
        tag(t).fog = (t.tags?.fog ?? 0) + n;
        e.log(p, `${n} Fog Counter(s) move to ${t.name}`);
      }
    },
  },
};

// ----- Consumed By Darkness -----
K['Consumed By Darkness'] = (() => {
  const cb = (c: Card) => nameEngine().nameHas(c, 'Crystal Beast');
  return {
    *startOfDuel() {},
    eff: {
      // "Crystal Beast" monsters on the field are DARK (the GY part is not modelled: Attributes only change on the field).
      *stateCheck(e) {
        for (const m of faceUpMonsters(e)) if (cb(m) && mon(e, m)) ((e.state.fx.declAttr ??= {}) as Record<number, string>)[m.uid] = 'DARK';
      },
    },
    *onAttack(e, p, attacker, target) {
      // "If an Ultimate Crystal monster attacks, negate the effects of the attack target during that Battle Phase" (this turn).
      if (e.nameHas(attacker, 'Ultimate Crystal') && ctlOf(e, attacker) === p && target) tag(target).negatedTurn = e.state.turn;
      // Decided at the attack declaration: send 1 "Crystal Beast" from the Deck to take no battle damage from that battle.
      const mine = [attacker, target].find((m) => m && cb(m) && ctlOf(e, m) === p);
      const foe = mine === attacker ? target : attacker;
      const fodder = inDeck(e, p, (c) => mon(e, c) && cb(c));
      if (!mine || !foe || !fodder.length) return;
      const hurt = mine === attacker ? (foe.pos === 'atk' && e.atkOf(foe) > e.atkOf(mine)) || (foe.pos === 'def' && e.defOf(foe) > e.atkOf(mine)) : foe === attacker && mine.pos === 'atk' && e.atkOf(foe) > e.atkOf(mine);
      if (!hurt || !(yield* e.yesno(p, 'Consumed By Darkness: send a "Crystal Beast" from your Deck to the GY to take no battle damage from this battle?'))) return;
      const c = yield* pickOne(e, p, 'Send which "Crystal Beast" to the GY?', fodder);
      if (!c) return;
      reveal(e, p);
      yield* e.sendToGrave(c.uid, 'cost');
      e.player(p).deck = e.shuffle(e.player(p).deck);
      ((e.state.fx.noBattleDamageIn ??= [-1, -1]) as number[])[p] = e.state.fx.battleNo;
    },
  } as SkillDef;
})();

// ----- Crystal Transcendence -----
K['Crystal Transcendence'] = (() => {
  const cbMon = (e: Engine, c: Card) => mon(e, c) && e.nameHas(c, 'Crystal Beast');
  const names = (e: Engine, p: Pid) => [...new Set(inDeck(e, p, (c) => cbMon(e, c)).map((c) => c.name))];
  const max = (e: Engine, p: Pid) => Math.min(3, e.player(p).hand.length, names(e, p).length, e.player(p).sz.filter((z, i) => z === null && !e.zoneLocked(e.player(p), 'sz', i)).length);
  return {
    eff: { forbidsSummon: (e, _c, ctl, monster, summoner) => summoner === ctl && !!e.player(ctl).skillRevealed && !e.nameHas(monster, 'Crystal') && race(e, monster) !== 'Dragon' },
    use: {
      phase: 'main',
      oncePerDuel: true,
      timesPerDuel: 2,
      can: (e, p) => max(e, p) > 0,
      *run(e, p) {
        const sent = yield* pick(e, p, `Crystal Transcendence: send up to ${max(e, p)} card(s) from your hand to the GY`, e.player(p).hand, 1, max(e, p));
        if (!sent?.length) return;
        for (const c of sent) yield* e.sendToGrave(c.uid, 'cost');
        const taken: string[] = [];
        for (let i = 0; i < sent.length; i++) {
          const c = yield* pickOne(e, p, 'Place which "Crystal Beast" in your Spell & Trap Zone?', inDeck(e, p, (x) => cbMon(e, x) && !e.namesOf(x).some((nm) => taken.includes(nm))));
          if (!c || !placeFaceUp(e, c, p)) break;
          taken.push(c.name);
        }
        e.player(p).deck = e.shuffle(e.player(p).deck);
      },
    },
  } as SkillDef;
})();

// ----- Dark Unity -----
// Its first sentence needs nothing here: "Super Polymerization" already Fusion Summons any Fusion Monster it has the materials for.
K['Dark Unity'] = (() => {
  const ssOpp = (e: Engine, p: Pid) => affectable(e, p, faceUp(e, other(p), (m) => !!m.tags?.ss));
  const a = (e: Engine, p: Pid) => opd(e, p, 'unity1') && e.player(p).lp > 2000 && ssOpp(e, p).length > 0;
  const b = (e: Engine, p: Pid) => opd(e, p, 'unity2') && e.player(p).hand.length > 0 && inDeck(e, p, (c) => e.isNamed(c, 'Dark Fusion')).length > 0;
  return {
    use: {
      oncePerDuel: false,
      repeat: true,
      can: (e, p) => a(e, p) || b(e, p),
      *run(e, p) {
        const opts = [a(e, p) ? 0 : -1, b(e, p) ? 1 : -1].filter((x) => x >= 0);
        const labels = ['Lose 2000 LP: a Special Summoned monster becomes Rock', 'Discard 1 card: add "Dark Fusion"'];
        const o = opts.length === 1 ? 0 : yield* chooseOption(e, p, 'Dark Unity: which Skill?', opts.map((i) => labels[i]));
        if (o === null) return;
        if (opts[o] === 0) {
          useOpd(e, p, 'unity1');
          e.payLp(p, 2000);
          const m = yield* pickOne(e, p, 'Change the Type of which Special Summoned monster to Rock?', ssOpp(e, p));
          if (m) {
            ((e.state.fx.declRace ??= {}) as Record<number, string>)[m.uid] = 'Rock';
            e.log(p, `${m.name} becomes a Rock monster`);
          }
        } else {
          useOpd(e, p, 'unity2');
          if (yield* discardOne(e, p, 'Dark Unity: discard 1 card', e.player(p).hand)) yield* toHandFrom(e, p, 'Add "Dark Fusion"', inDeck(e, p, (c) => e.isNamed(c, 'Dark Fusion')));
        }
      },
    },
  } as SkillDef;
})();

// ----- Delicious Morsel! -----
K['Delicious Morsel!'] = (() => {
  const vamp = (e: Engine, m: FieldCard) => e.nameHas(m, 'Vampire') && e.raceOf(m) === 'Zombie';
  function note(e: Engine, p: Pid, mine: FieldCard[], dmg: number) {
    if (dmg <= 0 || !mine.length) return;
    if (getN(e, p, 'morselTurn') !== e.state.turn) (setN(e, p, 'morselTurn', e.state.turn), setN(e, p, 'morselTotal', 0), setN(e, p, 'morselVamp', 0));
    setN(e, p, 'morselTotal', getN(e, p, 'morselTotal') + dmg);
    if (mine.some((m) => vamp(e, m))) setN(e, p, 'morselVamp', 1);
  }
  return {
    *startOfDuel() {},
    eff: {
      damageMod(e, _c, _ctl, damaged, _amount, byEffect) {
        noteBattleHit(e, damaged, byEffect);
        return undefined;
      },
      *afterAnyBattle(e, _c, p, attacker, target) {
        note(e, p, [attacker, target].filter((m) => m.owner === p || ctlOf(e, m) === p), battleDamageIn(e, other(p)));
      },
      *onBattleDamageDealt(e, _c, attacker, p) {
        if (e.state.battle?.target === null && ctlOf(e, attacker) === p) note(e, p, [attacker], battleDamageIn(e, other(p)));
      },
    },
    *onEndPhase(e, p) {
      if (getN(e, p, 'morselTurn') !== e.state.turn || !getN(e, p, 'morselVamp') || getN(e, p, 'morselTotal') <= 0) return;
      const n = Math.floor(getN(e, p, 'morselTotal') / 2);
      setN(e, p, 'morselVamp', 0);
      if (n > 0) e.gainLp(p, n);
    },
  } as SkillDef;
})();

// ----- piercing granted by a Skill this turn (tags.skillPierce = turn) -----
const pierceFx: Partial<EffectDefLite> = { grantsPiercing: (e, _c, ctl, attacker) => attacker.tags?.skillPierce === e.state.turn && ctlOf(e, attacker) === ctl };

K['Dino Destruction'] = {
  eff: { ...pierceFx },
  use: {
    phase: 'main',
    oncePerDuel: false,
    can: (e, p) => faceUp(e, p, (m) => e.raceOf(m) === 'Dinosaur' && levelOf(e, m) >= 6).length > 0,
    *run(e, p) {
      const m = yield* pickOne(e, p, 'Dino Destruction: which Dinosaur inflicts piercing damage this turn?', faceUp(e, p, (x) => e.raceOf(x) === 'Dinosaur' && levelOf(e, x) >= 6));
      if (m) tag(m).skillPierce = e.state.turn;
    },
  },
};

K['Dragon Force'] = (() => {
  const dn = (e: Engine, c: Card) => isNormalMonster(e, c) && race(e, c) === 'Dragon';
  return {
    eff: { ...pierceFx },
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => inGY(e, p, (c) => dn(e, c)).length > 0 && faceUp(e, p, (m) => dn(e, m)).length > 0,
      *run(e, p) {
        const b = yield* pickOne(e, p, 'Dragon Force: banish which Dragon Normal Monster from your GY?', inGY(e, p, (c) => dn(e, c)));
        if (!b) return;
        const lv = levelOf(e, b);
        banishAll(e, p, [b]);
        const m = yield* pickOne(e, p, `Dragon Force: which Dragon Normal Monster gains ${200 * lv} ATK?`, faceUp(e, p, (x) => dn(e, x)));
        if (!m) return;
        boostTurn(m, 200 * lv);
        tag(m).skillPierce = e.state.turn;
      },
    },
  } as SkillDef;
})();

// ----- Ectoplasmic Fortification! -----
K['Ectoplasmic Fortification!'] = {
  use: {
    oncePerDuel: false,
    can: (e, p) => faceUp(e, p, (m) => e.raceOf(m) === 'Zombie').length > 0,
    *run(e, p) {
      const sc = e.skillCard(p);
      if (sc) sc.counters++;
      e.log(p, `Ectoplasmic Fortification!: ${sc?.counters ?? 0} counter(s)`);
    },
  },
  aura(e, p, m) {
    const n = e.skillCard(p)?.counters ?? 0;
    return n && ctlOf(e, m) === p && e.raceOf(m) === 'Zombie' ? { atk: 100 * n, def: -100 * n } : undefined;
  },
  eff: {
    damageMod(e, _c, ctl, damaged, amount, byEffect) {
      const b = battling(e);
      if (byEffect || damaged !== ctl || !b || !e.player(ctl).skillRevealed) return undefined;
      return [b.a, b.t].some((m) => m && ctlOf(e, m) === ctl && e.raceOf(m) === 'Zombie') ? amount * 2 : undefined;
    },
  },
};

// ----- Elements of Thunder, Water, and Wind -----
K['Elements of Thunder, Water, and Wind'] = (() => {
  const TRIO = ['Suijin', 'Kazejin', 'Sanga of the Thunder'];
  const allThree = (e: Engine, p: Pid) => TRIO.every((n) => faceUp(e, p, (m) => m.name === n).length > 0);
  const gate = (e: Engine, p: Pid) => inDeck(e, p, (c) => e.isNamed(c, 'Gate Guardian'));
  const canA = (e: Engine, p: Pid) => !isTurn(e, p, 'elements') && inHand(e, p, (c) => e.namesOf(c).some((nm) => TRIO.includes(nm))).length > 0;
  return {
    eff: { tributeDiscount: (e, _c, ctl, monster, summoner) => (summoner === ctl && isTurn(e, ctl, 'elements') && e.namesOf(monster).some((nm) => TRIO.includes(nm)) ? 2 : 0) },
    use: {
      oncePerDuel: false,
      can: (e, p) => e.player(p).lp <= 1000 && (canA(e, p) || (allThree(e, p) && gate(e, p).length > 0)),
      *run(e, p) {
        const b = allThree(e, p) && gate(e, p).length > 0;
        const o = b && canA(e, p) ? yield* chooseOption(e, p, 'Elements of Thunder, Water, and Wind: which Skill?', ['Normal Summon Suijin, Kazejin or Sanga without Tributing this turn', 'Send the field to the GY and Special Summon "Gate Guardian"']) : b ? 1 : 0;
        if (o === 0) {
          setN(e, p, 'elements', e.state.turn);
          e.log(p, 'This turn, "Suijin", "Kazejin" and "Sanga of the Thunder" can be Normal Summoned without Tributing');
          return;
        }
        if (o !== 1) return;
        const all = [...e.monsters(0), ...e.monsters(1), ...stOf(e, 0), ...stOf(e, 1)].map((c) => c.uid);
        yield* e.together(
          (function* (): Step {
            for (const u of all) if (e.fieldCard(u)) yield* e.sendToGrave(u, 'used');
          })(),
        );
        yield* ssOne(e, p, 'Special Summon "Gate Guardian"', gate(e, p), 'atk', true);
      },
    },
  } as SkillDef;
})();

// ----- Energizing Elements -----
K['Energizing Elements'] = (() => {
  const ATTRS = ['FIRE', 'WATER', 'EARTH', 'WIND'];
  const declared = (e: Engine, p: Pid) => (isTurn(e, p, 'energTurn') ? ATTRS[getN(e, p, 'energAttr') - 1] : undefined);
  // "If you control no monsters with the declared Attribute, flip this card over": the effect ends.
  const live = (e: Engine, p: Pid) => {
    const a = declared(e, p);
    return a && faceUp(e, p, (m) => attrNow(e, m) === a).length > 0 ? a : undefined;
  };
  return {
    use: {
      oncePerDuel: false,
      can: () => true,
      *run(e, p) {
        const o = yield* chooseOption(e, p, 'Energizing Elements: declare an Attribute', ATTRS);
        if (o === null) return;
        setN(e, p, 'energTurn', e.state.turn);
        setN(e, p, 'energAttr', o + 1);
        e.log(p, `Energizing Elements: ${ATTRS[o]} declared`);
      },
    },
    aura(e, p, m) {
      const a = live(e, p);
      return a && attrNow(e, m) === a ? { atk: 500, def: -400 } : undefined;
    },
    eff: {
      damageMod(e, _c, ctl, damaged, amount, byEffect) {
        const a = live(e, ctl);
        const b = battling(e);
        if (byEffect || !a || !b || !b.a) return undefined;
        const by = damaged === ctlOf(e, b.a) ? b.t : b.a;
        return by && attrNow(e, by) === a ? Math.floor(amount / 2) : undefined;
      },
    },
  } as SkillDef;
})();

// ----- Fog Warning -----
// "You place": Fog Counters placed during your own turn are taken as yours.
K['Fog Warning'] = {
  *startOfDuel() {},
  eff: {
    *stateCheck(e, _c, p) {
      const key = `fogSeen${p}`;
      for (const m of [...e.monsters(0), ...e.monsters(1)]) {
        const cur = m.tags?.fog ?? 0;
        const seen = m.tags?.[key] ?? 0;
        if (cur > seen && e.state.turnPlayer === p) {
          tag(m).fog = cur + 1;
          e.log(p, `Fog Warning: 1 more Fog Counter on ${m.name}`);
        }
        if (cur || seen) tag(m)[key] = m.tags?.fog ?? 0;
      }
    },
  },
};

// ----- Forbidden Cyber Style Technique -----
K['Forbidden Cyber Style Technique'] = (() => {
  const cyber = (e: Engine, c: Card) => summonable(e, c) && race(e, c) === 'Machine' && e.nameHas(c, 'Cyber');
  const pool = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy].filter((c) => cyber(e, c));
  return {
    eff: {
      ...renameFx,
      forbidsSummon: (e, _c, ctl, _m, summoner, how, from) => summoner === ctl && isTurn(e, ctl, 'fcst') && !(how === 'special' && from === 'fusion'),
    },
    mayAttack: (e, p, m) => !isTurn(e, p, 'fcst') || fusionOf(e, m),
    use: {
      can: (e, p) => e.player(p).lp <= 1500 && e.monsters(p).length === 0 && freeMZ(e, p) && pool(e, p).length > 0,
      *run(e, p) {
        if (e.player(p).lp > 50) e.payLp(p, e.player(p).lp - 50);
        const n = Math.min(3, e.openMonsterZones(p), pool(e, p).length);
        const chosen = yield* pick(e, p, `Special Summon up to ${n} Machine "Cyber" monster(s)`, pool(e, p), 1, n);
        for (const c of chosen ?? []) {
          const m = yield* ss(e, p, c);
          if (!m) continue;
          rename(e, m, 'Cyber Dragon');
          Object.assign(tag(m), { skillNoTribute: 1 });
          m.doomAt = e.state.turn;
        }
        setN(e, p, 'fcst', e.state.turn);
      },
    },
  } as SkillDef;
})();

// ----- Forged Steel -----
K['Forged Steel'] = (() => {
  const red = (e: Engine, m: FieldCard) => e.nameHas(m, 'Red-Eyes') || (isNormalMonster(e, m) && e.raceOf(m) === 'Dragon');
  const a = (e: Engine, p: Pid) => opd(e, p, 'forged') && faceUp(e, p, (m) => red(e, m) && !e.isNamed(m, 'Red-Eyes Black Dragon')).length > 0;
  const redd = (e: Engine, p: Pid) => faceUp(e, p, (m) => e.isNamed(m, 'Red-Eyes Darkness Dragon') && !e.isNegated(m) && e.oncePerTurn(`skill:redd:${m.uid}`, p));
  const dragons = (e: Engine, p: Pid) => inGY(e, p, (c) => summonable(e, c) && race(e, c) === 'Dragon');
  const b = (e: Engine, p: Pid) => e.inMainPhase() && redd(e, p).length > 0 && freeMZ(e, p) && dragons(e, p).length > 0;
  return {
    eff: { ...renameFx },
    use: {
      phase: 'main',
      oncePerDuel: false,
      repeat: true,
      can: (e, p) => a(e, p) || b(e, p),
      *run(e, p) {
        const okA = a(e, p);
        const okB = b(e, p);
        const o = okA && okB ? yield* chooseOption(e, p, 'Forged Steel: which Skill?', ['Change a name to "Red-Eyes Black Dragon"', '"Red-Eyes Darkness Dragon": Special Summon a Dragon from your GY']) : okA ? 0 : 1;
        if (o === 0) {
          useOpd(e, p, 'forged');
          const m = yield* pickOne(e, p, 'Which monster becomes "Red-Eyes Black Dragon"?', faceUp(e, p, (x) => red(e, x) && !e.isNamed(x, 'Red-Eyes Black Dragon')));
          if (m) rename(e, m, 'Red-Eyes Black Dragon');
        } else if (o === 1) {
          const r = redd(e, p)[0];
          e.useOnce(`skill:redd:${r.uid}`, p);
          yield* ssOne(e, p, 'Red-Eyes Darkness Dragon: Special Summon which Dragon from your GY?', dragons(e, p));
        }
      },
    },
  } as SkillDef;
})();

// ----- Grit -----
// "Your LP do not get lower than 1": damage is lowered (paying LP is not).
K['Grit'] = {
  use: {
    phase: 'start',
    can: (e) => e.state.phase === 'M1' || e.state.phase === 'SP',
    *run(e, p) {
      const picks = yield* e.select(p, 'Grit: call 2 numbers', [1, 2, 3, 4, 5, 6].map((n) => ({ label: String(n), value: n })), 2, 2);
      const called = (picks ?? [0, 1]).map((i) => i + 1);
      const n = e.roll(6);
      e.log(p, `Grit: ${called.join(' and ')} called, the die shows ${n}`);
      if (called.includes(n)) {
        setN(e, p, 'grit', e.state.turn + 1);
        e.log(p, `${e.player(p).name}'s LP cannot drop below 1 until the end of the opponent's next turn`);
      }
    },
  },
  eff: {
    damageMod(e, _c, ctl, damaged, amount) {
      if (damaged !== ctl || e.state.turn > getN(e, ctl, 'grit')) return undefined;
      const lp = e.player(ctl).lp;
      return lp - amount < 1 ? Math.max(0, lp - 1) : undefined;
    },
  },
};

// ----- Guardians of the Tomb -----
K['Guardians of the Tomb'] = {
  *startOfDuel() {},
  eff: {
    *onAnySummon(e, _c, ctl, m, mctl, kind) {
      const fromST = !!((e.state.fx.trapMonster ?? {}) as Record<number, unknown>)[m.uid] || info(e, m).kind !== 'monster';
      if (kind !== 'special' || mctl !== ctl || e.state.turnPlayer !== other(ctl) || !e.inMainPhase() || !fromST || e.player(ctl).hand.length > 0 || !e.oncePerTurn('skill:tomb', ctl)) return;
      if (!(yield* e.yesno(ctl, 'Guardians of the Tomb: draw 1 card?'))) return;
      e.useOnce('skill:tomb', ctl);
      if (!e.draw(ctl, 1)) return;
      const st = inHand(e, ctl, (c) => !mon(e, c));
      if (!st.length || freeST(e, ctl) < 0 || !(yield* e.yesno(ctl, 'Guardians of the Tomb: Set a Spell/Trap from your hand?'))) return;
      const c = yield* pickOne(e, ctl, 'Set which card?', st);
      if (c) setST(e, ctl, c);
    },
  },
};

// ----- Heavy Metal Raiders (Skill Card) -----
K['Heavy Metal Raiders (Skill Card)'] = (() => {
  const dm = (e: Engine, m: FieldCard) => attrNow(e, m) === 'DARK' && e.raceOf(m) === 'Machine';
  const origDM = (e: Engine, c: Card) => attrOf(e, c) === 'DARK' && info(e, c).race === 'Machine';
  const handDM = (e: Engine, p: Pid) => inHand(e, p, (c) => summonable(e, c) && origDM(e, c));
  function* trigger(e: Engine, p: Pid): Step {
    if (!e.oncePerTurn('skill:hmr', p) || !freeMZ(e, p) || !handDM(e, p).length) return;
    if (!(yield* e.yesno(p, 'Heavy Metal Raiders: Special Summon a DARK Machine monster from your hand?'))) return;
    e.useOnce('skill:hmr', p);
    reveal(e, p);
    yield* ssOne(e, p, 'Special Summon which DARK Machine monster?', handDM(e, p));
  }
  return {
    *startOfDuel() {},
    *destroyReplace(e, p, m, byBattle) {
      if (!byBattle || ctlOf(e, m) !== p || !dm(e, m) || m.tags?.hmrTurn === e.state.turn) return false;
      Object.assign(tag(m), { hmrTurn: e.state.turn, hmrBattle: e.state.fx.battleNo ?? 0 });
      e.log(p, `Heavy Metal Raiders: ${m.name} is not destroyed`);
      return true;
    },
    eff: {
      damageMod(e, _c, _ctl, damaged, _amount, byEffect) {
        noteBattleHit(e, damaged, byEffect);
        return undefined;
      },
      *afterAnyBattle(e, _c, p, attacker, target) {
        for (const m of [attacker, target]) {
          if (ctlOf(e, m) !== p || m.tags?.hmrBattle !== e.state.fx.battleNo || m.tags?.hmrTurn !== e.state.turn) continue;
          const dmg = battleDamageIn(e, p);
          if (dmg > 0) {
            boostPerm(m, dmg);
            e.log(p, `${m.name} gains ${dmg} ATK`);
          }
        }
        const mine = [attacker, target].find((m) => ctlOf(e, m) === p && origDM(e, m));
        const foe = mine === attacker ? target : attacker;
        if (mine && e.fieldCard(mine.uid) && !e.fieldCard(foe.uid) && e.find(foe.uid)?.loc.zone === 'gy') yield* trigger(e, p);
      },
      *onAnyToGrave(e, _c, p, events) {
        const src = e.resolvingCard();
        const fc = src ? e.fieldCard(src.uid) : null;
        if (!fc || ctlOf(e, fc) !== p || !origDM(e, fc) || !events.some((ev) => ev.reason === 'destroyed' && !ev.byBattle && ['mz', 'sz', 'field'].includes(ev.from))) return;
        yield* trigger(e, p);
      },
    },
  } as SkillDef;
})();

// ----- Here Goes Something! -----
K['Here Goes Something!'] = (() => {
  const hgs = (e: Engine, m: FieldCard) => m.tags?.hgs === e.state.turn && e.state.turn > 0;
  const hit = (e: Engine) => ((e.state.fx.hgsTargets ?? []) as number[]);
  return {
    use: {
      phase: 'battle',
      can: (e, p) => e.monsters(p).length === 1 && faceUp(e, p, (m) => e.nameHas(m, 'Elemental HERO')).length === 1,
      *run(e, p) {
        const m = e.monsters(p)[0];
        tag(m).hgs = e.state.turn;
        e.state.fx.hgsTargets = [];
        setN(e, p, 'hgs', e.state.turn);
        e.log(p, `${m.name} can attack every monster your opponent controls this turn`);
      },
    },
    eff: {
      forbidsSummon: (e, _c, ctl, _m, summoner, how) => summoner === ctl && how === 'special' && isTurn(e, ctl, 'hgs'),
      attackGuard: (e, _src, ctl, attacker, target) => hgs(e, attacker) && ctlOf(e, attacker) === ctl && hit(e).includes(target.uid),
    },
    *onAttack(e, p, attacker, target) {
      if (target && hgs(e, attacker) && ctlOf(e, attacker) === p) hit(e).push(target.uid);
    },
    extraAttacks(e, _p, m) {
      if (!hgs(e, m)) return 0;
      const left = e.monsters(other(e.controller(m.uid) ?? 0)).filter((t) => !hit(e).includes(t.uid)).length;
      const made = m.attacked ? m.tags?.attacksMade ?? 1 : 0;
      return Math.max(0, made + left - 1);
    },
    attackBonus: (e, _p, attacker, target) => (hgs(e, attacker) && target ? 800 : 0),
  } as SkillDef;
})();

// ----- Hidden Parasite -----
K['Hidden Parasite'] = {
  use: {
    oncePerDuel: true,
    timesPerDuel: 2,
    can: (e) => [...e.monsters(0), ...e.monsters(1)].length > 0,
    *run(e, p) {
      for (const m of affectable(e, p, [...e.monsters(0), ...e.monsters(1)])) setTemp(e, m, 'declRace', 'Insect');
      setN(e, p, 'parasite', e.state.turn);
      e.log(p, 'Hidden Parasite: every monster on the field becomes an Insect this turn');
    },
  },
  eff: {
    damageMod: (e, _c, ctl, damaged, amount, byEffect) => (!byEffect && damaged === other(ctl) && isTurn(e, ctl, 'parasite') ? Math.floor(amount / 2) : undefined),
  },
  onEndPhase: endOfTurnCleanup,
};

// ----- Hieratic Chant -----
K['Hieratic Chant'] = {
  use: {
    phase: 'main',
    oncePerDuel: false,
    can: (e, p) => e.player(p).hand.length > 0 && [...e.player(p).deck, ...e.player(p).gy].some((c) => e.isNamed(c, 'The Winged Dragon of Ra')),
    *run(e, p) {
      const hand = e.player(p).hand.slice();
      yield* e.together(
        (function* (): Step {
          for (const c of hand) yield* e.discard(p, c.uid);
        })(),
      );
      const ra = yield* toHandFrom(e, p, 'Add "The Winged Dragon of Ra"', [...e.player(p).deck, ...e.player(p).gy].filter((c) => e.isNamed(c, 'The Winged Dragon of Ra')));
      if (ra) {
        ((e.state.fx.extraTribute ??= [-1, -1]) as number[])[p] = e.state.turn;
        e.log(p, 'You can Tribute Summon once more this turn');
      }
    },
  },
  ai: (e, p) => e.player(p).hand.length <= 2,
};

// ----- Hyper Metamorphosis -----
K['Hyper Metamorphosis'] = (() => {
  const small = (e: Engine, p: Pid) => faceUp(e, p, (m) => isNormalMonster(e, m) && e.raceOf(m) === 'Insect' && levelOf(e, m) <= 3);
  const moths = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.player(p).deck].filter((c) => e.isNamed(c, 'Perfectly Ultimate Great Moth'));
  /** Hand cards that can be discarded while a Moth stays reachable. */
  const discards = (e: Engine, p: Pid) => (inDeck(e, p, (c) => e.isNamed(c, 'Perfectly Ultimate Great Moth')).length || moths(e, p).length > 1 ? e.player(p).hand : e.player(p).hand.filter((c) => !e.isNamed(c, 'Perfectly Ultimate Great Moth')));
  return {
    use: {
      oncePerDuel: false,
      can: (e, p) => small(e, p).length > 0 && discards(e, p).length >= 2 && moths(e, p).length > 0,
      *run(e, p) {
        const two = yield* pick(e, p, 'Hyper Metamorphosis: discard 2 cards', discards(e, p), 2, 2);
        if (!two || two.length < 2) return;
        for (const c of two) yield* e.discard(p, c.uid);
        const t = yield* pickOne(e, p, 'Tribute which Level 3 or lower Insect Normal Monster?', small(e, p));
        if (!t) return;
        yield* tribute(e, p, t);
        yield* ssOne(e, p, 'Special Summon "Perfectly Ultimate Great Moth"', moths(e, p), 'atk', true);
        ((e.state.fx.halfDamage ??= [-1, -1]) as number[])[other(p)] = e.state.turn;
      },
    },
  } as SkillDef;
})();

// ----- I'm Just Gonna Attack! -----
K["I'm Just Gonna Attack!"] = {
  use: {
    phase: 'main',
    can: (e, p) => faceUp(e, p).length > 0,
    *run(e, p) {
      const m = yield* pickOne(e, p, "I'm Just Gonna Attack!: which monster gains 100 ATK?", faceUp(e, p));
      if (m) boostTurn(m, 100);
      setN(e, p, 'jga', e.state.turn);
    },
  },
  eff: {
    // The opponent's first Trap Card or Trap effect that resolves during this turn's Battle Phase is negated, and Set again.
    *onChainLink(e, _c, p, link) {
      if (!isTurn(e, p, 'jga') || getN(e, p, 'jgaDone') === e.state.turn || e.state.phase !== 'BP' || link.player !== other(p) || info(e, link.card).kind !== 'trap') return;
      setN(e, p, 'jgaDone', e.state.turn);
      link.negated = true;
      e.log(p, `I'm Just Gonna Attack!: ${link.card.name} is negated`);
      if (!(link.payload as { effect?: string } | undefined)?.effect) e.state.fx.setInstead = link.card.uid;
    },
  },
};

// ----- Inner Conflict -----
K['Inner Conflict'] = {
  use: {
    phase: 'main',
    can: (e, p) => e.player(p).lp >= 2 && freeMZ(e, p) && affectable(e, p, e.monsters(other(p))).length > 0,
    *run(e, p) {
      e.payLp(p, half(e, p));
      const m = yield* pickOne(e, p, 'Inner Conflict: take control of which monster?', affectable(e, p, e.monsters(other(p))));
      if (!m || !e.takeControl(m.uid, p)) return;
      m.returnAtEnd = other(p);
      tag(m).noDirectTurn = e.state.turn;
      e.log(p, `${e.player(p).name} takes control of ${m.faceUp ? m.name : 'a monster'} until the End Phase`);
    },
  },
};

// ----- It's My Lucky Day! -----
// Used ahead of the roll: you pay 1000 LP and decide the next die (or coin) result of your own effects.
K["It's My Lucky Day!"] = {
  use: {
    can: (e, p) => e.player(p).lp > 1000,
    *run(e, p) {
      e.payLp(p, 1000);
      const d = yield* chooseOption(e, p, "It's My Lucky Day!: your next die roll shows", ['1', '2', '3', '4', '5', '6']);
      const c = yield* chooseOption(e, p, "It's My Lucky Day!: or, your next coin toss shows", ['Heads', 'Tails']);
      e.state.fx.fixedRoll = { p, die: (d ?? 5) + 1, coin: (c ?? 0) + 1 };
    },
  },
  ai: false,
};

// ----- Knight of Legend -----
K['Knight of Legend'] = (() => {
  const gaia = (c: Card) => nameEngine().nameHas(c, 'Gaia The Fierce Knight') || nameEngine().nameHas(c, 'Gaia the Fierce Knight');
  const champ = (c: Card) => gaia(c) || nameEngine().nameHas(c, 'Gaia the Dragon Champion');
  const on = (e: Engine, p: Pid) => !!e.player(p).skillRevealed && faceUp(e, p, (m) => champ(m)).length > 0;
  return {
    use: { phase: 'main', can: () => true, *run() {} },
    eff: {
      tributeDiscount: (e, _c, ctl, monster, summoner) => (summoner === ctl && !!e.player(ctl).skillRevealed && gaia(monster) && mon(e, monster) ? tribsFor(e, monster) : 0),
      grantsPiercing: (e, _c, ctl, attacker) => on(e, ctl) && champ(attacker) && ctlOf(e, attacker) === ctl,
      *onBattleDamageDealt(e, _c, attacker, p) {
        const t = e.state.battle?.target;
        const tc = t !== null && t !== undefined ? e.fieldCard(t) : null;
        if (!on(e, p) || !champ(attacker) || !tc || tc.pos !== 'def' || !e.oncePerTurn('skill:knight', p)) return;
        e.useOnce('skill:knight', p);
        e.draw(p, 2);
        yield* discardOne(e, p, 'Knight of Legend: discard 1 card', e.player(p).hand);
      },
      locksCardActivation(e, _c, ctl, player, card) {
        const f = e.find(card.uid);
        return player === ctl && on(e, ctl) && f?.loc.zone === 'sz' && !(card as FieldCard).faceUp;
      },
    },
  } as SkillDef;
})();

// ----- Looking into the Future -----
K['Looking into the Future'] = {
  use: {
    phase: 'main',
    oncePerDuel: false,
    can: (e, p) => e.player(p).deck.length > 0,
    *run(e, p) {
      const top = e.player(p).deck.slice(0, 3);
      yield* e.reveal(p, 'The top 3 cards of your Deck', top);
      yield* reorder(e, p, p, top, 'top');
      setN(e, p, 'future', e.state.turn);
    },
  },
  eff: { locksCardActivation: (e, _c, ctl, player, card) => player === ctl && isTurn(e, ctl, 'future') && info(e, card).kind === 'spell' },
  ai: (e, p) => !e.player(p).hand.some((c) => isSpell(e, c)),
};

// ----- Middle Age Mechs (Skill Card) -----
K['Middle Age Mechs (Skill Card)'] = {
  *startOfDuel() {},
  aura: (e, _p, m) => (e.nameHas(m, 'Ancient Gear') ? { atk: 300, def: 0 } : undefined),
  eff: {
    *onAnySummon(e, c, _ctl, _m, _mctl, kind) {
      if (kind !== 'normal') return;
      c.counters++;
      e.log(null, `Middle Age Mechs: ${c.counters} counter(s)`);
    },
    *onAnySet(e, c) {
      c.counters++;
      e.log(null, `Middle Age Mechs: ${c.counters} counter(s)`);
    },
    tributeFor: (e, c, _ctl, monster, need) => e.nameHas(monster, 'Ancient Gear') && mon(e, monster) && c.counters >= need,
  },
};

// ----- No More Mrs. Nice Mai! -----
K['No More Mrs. Nice Mai!'] = {
  *startOfDuel() {},
  eff: {
    *onBattleDamageDealt(e, _c, attacker, p) {
      if (ctlOf(e, attacker) === p) setN(e, p, 'maiHit', e.state.turn);
    },
  },
  *onBattlePhaseEnd(e, p) {
    const all = [...stOf(e, 0), ...stOf(e, 1)];
    if (e.state.turnPlayer !== p || !isTurn(e, p, 'maiHit') || !all.length || !e.oncePerTurn('skill:mai', p)) return;
    if (!(yield* e.yesno(p, 'No More Mrs. Nice Mai!: destroy 1 Spell/Trap on the field?'))) return;
    e.useOnce('skill:mai', p);
    const t = yield* pickOne(e, p, 'Destroy which Spell/Trap?', all);
    if (t) yield* e.destroy([t.uid]);
  },
};

// ----- No One Suspects the Dark Scorpion Gang! -----
K['No One Suspects the Dark Scorpion Gang!'] = (() => {
  const gang = (c: Card) => nameEngine().isNamed(c, 'Don Zaloog') || nameEngine().nameHas(c, 'Dark Scorpion');
  const ds = (e: Engine, c: Card) => summonable(e, c) && e.nameHas(c, 'Dark Scorpion');
  const pairs = (e: Engine, p: Pid, except = -1) => {
    const hand = inHand(e, p, (c) => c.uid !== except && ds(e, c));
    return hand.filter((h) => inDeck(e, p, (d) => ds(e, d) && !e.sameName(d, h)).length > 0);
  };
  return {
    *startOfDuel() {},
    eff: {
      forbidsSummon: (_e, _c, ctl, monster, summoner) => summoner === ctl && !gang(monster),
      // A direct attack while the opponent controls monsters is "using this Skill": its battle damage becomes 400.
      damageMod(e, _c, ctl, damaged, _amount, byEffect) {
        const b = e.state.battle;
        const a = b ? e.fieldCard(b.attacker) : null;
        if (byEffect || damaged !== other(ctl) || !b || b.target !== null || !a || !gang(a) || ctlOf(e, a) !== ctl || e.monsters(other(ctl)).length === 0) return undefined;
        return 400;
      },
    },
    canAttackDirectly: (e, p, m) => gang(m) && ctlOf(e, m) === p,
    use: {
      phase: 'main',
      can: (e, p) => faceUp(e, p, (m) => e.isNamed(m, 'Don Zaloog')).length > 0 && e.openMonsterZones(p) >= 2 && e.player(p).hand.some((c) => pairs(e, p, c.uid).length > 0),
      *run(e, p) {
        if (!(yield* discardOne(e, p, 'Discard 1 card', e.player(p).hand.filter((c) => pairs(e, p, c.uid).length > 0)))) return;
        const h = yield* pickOne(e, p, 'Special Summon which "Dark Scorpion" from your hand?', pairs(e, p));
        if (!h) return;
        const d = yield* pickOne(e, p, 'Special Summon which "Dark Scorpion" from your Deck?', inDeck(e, p, (c) => ds(e, c) && !e.sameName(c, h)));
        yield* ss(e, p, h);
        if (d) yield* ss(e, p, d);
      },
    },
  } as SkillDef;
})();

// ----- Order of the Queen -----
K['Order of the Queen'] = {
  *startOfDuel() {},
  eff: {
    negatesBattleVictims: (e, _c, killer, ctl) => e.state.battle?.attacker === killer.uid && e.nameHas(killer, 'Amazoness') && faceUp(e, ctl, (m) => e.isNamed(m, 'Amazoness Queen')).length > 0,
  },
};

// ----- Pal-O'Mine-zation! -----
// The revealed monster substitutes for 1 material of a Fusion Summon by "Polymerization" this turn.
K["Pal-O'Mine-zation!"] = {
  use: {
    can: (e, p) => inHand(e, p, (c) => isNormalMonster(e, c)).length > 0,
    *run(e, p) {
      const c = yield* pickOne(e, p, "Pal-O'Mine-zation!: reveal which Normal Monster?", inHand(e, p, (x) => isNormalMonster(e, x)));
      if (!c) return;
      yield* e.reveal(other(p), 'Your opponent reveals', [c]);
      ((e.state.fx.fusionSubs ??= {}) as Record<number, number>)[c.uid] = e.state.turn;
      e.log(p, `${c.name} can substitute for any 1 Fusion Material this turn`);
    },
  },
};

// ----- Power Bond (Skill Card) -----
K['Power Bond (Skill Card)'] = (() => {
  const plans = (e: Engine, p: Pid, except: number) => fusionPlans(e, p, (f) => race(e, f) === 'Machine', () => without(handField(e, p), except));
  const d = discardFuse('Power Bond', plans);
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: d.can,
      *run(e, p) {
        const m = yield* d.run(e, p);
        if (!m) return;
        const gain = origAtk(e, m);
        boostTurn(m, gain);
        tag(m).noDirectTurn = e.state.turn;
        if (!isTurn(e, p, 'pbTurn')) setN(e, p, 'pbDmg', 0);
        setN(e, p, 'pbTurn', e.state.turn);
        setN(e, p, 'pbDmg', getN(e, p, 'pbDmg') + gain);
      },
    },
    *onEndPhase(e, p) {
      if (!isTurn(e, p, 'pbTurn') || getN(e, p, 'pbDmg') <= 0) return;
      const n = getN(e, p, 'pbDmg');
      setN(e, p, 'pbDmg', 0);
      e.log(p, `Power Bond: ${e.player(p).name} takes ${n} damage`);
      e.damage(p, n);
    },
  } as SkillDef;
})();

// ----- Power of Friendship -----
K['Power of Friendship'] = {
  *startOfDuel() {},
  eff: { damageMod: (e, _c, ctl, damaged, _amount, byEffect) => (byEffect && damaged === ctl && e.state.turnPlayer === ctl && e.actor === other(ctl) ? 0 : undefined) },
};

// ----- Powerful Group of Guys -----
K['Powerful Group of Guys'] = (() => {
  const dh = (c: Card) => nameEngine().nameHas(c, 'Destiny HERO');
  const targets = (e: Engine, p: Pid) => {
    const mine = e.monsters(p);
    if (mine.length !== 1 || !mine[0].faceUp || !dh(mine[0])) return [];
    return [...e.player(p).hand, ...e.player(p).deck].filter((c) => summonable(e, c) && dh(c) && levelOf(e, c) < levelOf(e, mine[0]));
  };
  return {
    eff: { forbidsSummon: (e, _c, ctl, monster, summoner) => summoner === ctl && isTurn(e, ctl, 'pgog') && !dh(monster) },
    use: {
      oncePerDuel: false,
      can: (e, p) => e.monsters(other(p)).length > e.monsters(p).length && freeMZ(e, p) && targets(e, p).length > 0,
      *run(e, p) {
        setN(e, p, 'pgog', e.state.turn);
        yield* ssOne(e, p, 'Special Summon a "Destiny HERO" with a lower Level', targets(e, p));
      },
    },
  } as SkillDef;
})();

// ----- Professor of Alchemy -----
// The token "cannot be Tributed" at all here (the "except for Golden Homunculus" exception is not modelled).
K['Professor of Alchemy'] = (() => {
  const cands = (e: Engine, p: Pid) => [...inHand(e, p, (c) => mon(e, c) && levelOf(e, c) >= 1 && levelOf(e, c) <= 4), ...faceUp(e, p, (m) => !m.token && levelOf(e, m) >= 1 && levelOf(e, m) <= 4)];
  return {
    canAttackDirectly: (e, _p, m) => e.isNamed(m, 'Alchemy Beast Token'),
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => cands(e, p).some((c) => freeMZ(e, p) || !!e.fieldCard(c.uid)),
      *run(e, p) {
        const c = yield* pickOne(e, p, 'Professor of Alchemy: banish which Level 4 or lower monster?', cands(e, p).filter((x) => freeMZ(e, p) || !!e.fieldCard(x.uid)));
        if (!c) return;
        const attr = attrNow(e, c);
        const fc = e.fieldCard(c.uid);
        if (fc) for (const eq of fc.equips.slice()) yield* e.sendToGrave(eq, 'used');
        banishAll(e, p, [c]);
        const t = e.createToken('Alchemy Beast Token', p, 'atk', true, { atk: 500, def: 500, level: 3, race: 'Rock' });
        if (!t) return;
        ((e.state.fx.declAttr ??= {}) as Record<number, string>)[t.uid] = attr;
        tag(t).skillNoTribute = 1;
      },
    },
  } as SkillDef;
})();

// ----- Rainbow Crystal Collection -----
// A "Crystal Beast" kept this way becomes a Continuous Spell in the Spell & Trap Zone (tags.crystallization). Using such cards
// as Fusion Material for "Ultimate Crystal" monsters is not modelled.
K['Rainbow Crystal Collection'] = {
  *startOfDuel() {},
  *destroyReplace(e, p, m) {
    if (ctlOf(e, m) !== p || !e.nameHas(m, 'Crystal Beast') || freeST(e, p) < 0) return false;
    if (!(yield* e.yesno(p, `Rainbow Crystal Collection: place a Crystallization Counter on ${m.name} instead (it becomes a Continuous Spell)?`))) return false;
    const f = e.find(m.uid);
    const z = freeST(e, p);
    if (!f || f.loc.zone !== 'mz' || z < 0) return false;
    for (const eq of m.equips.slice()) yield* e.sendToGrave(eq, 'used');
    e.vacateMZ(e.player(p), f.loc.index);
    e.player(p).sz[z] = { uid: m.uid, name: m.name, owner: m.owner, pos: 'atk', faceUp: true, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true, tags: { crystallization: 1 } };
    e.event('summon', { uid: m.uid, player: p });
    e.log(p, `${m.name} gets a Crystallization Counter and becomes a Continuous Spell`);
    return true;
  },
};

// ----- Ritual of Black Mastery -----
K['Ritual of Black Mastery'] = (() => {
  const ritualNow = (e: Engine, m: FieldCard) => ((e.state.fx.ritualMats ?? {}) as Record<number, { turn: number }>)[m.uid]?.turn === e.state.turn;
  const BLS = 'Black Luster Soldier';
  const MOBC = 'Magician of Black Chaos';
  const on = (e: Engine, p: Pid) => !!e.player(p).skillRevealed;
  return {
    use: {
      phase: 'main',
      can: (e, p) => faceUp(e, p, (m) => (m.name === BLS || m.name === MOBC) && ritualNow(e, m)).length > 0,
      *run() {},
    },
    eff: {
      shields(e, _c, target, how, ctl) {
        if (!on(e, ctl) || how !== 'effect' || ctlOf(e, target) !== ctl || e.actor !== other(ctl)) return false;
        if (target.name === BLS && !e.resolvingCard()) return true; // the opponent's Skill (not a chain link)
        return target.name === MOBC && e.resolvingKind() === 'spell';
      },
      *onChainLink(e, _c, p, link) {
        if (on(e, p) && link.player === other(p) && info(e, link.card).kind === 'trap' && !(link.payload as { effect?: string } | undefined)?.effect && faceUp(e, p, (m) => m.name === BLS).length && e.oncePerTurn('skill:blsDraw', p)) {
          e.useOnce('skill:blsDraw', p);
          setN(e, p, 'blsDraw', 1);
        }
      },
      *stateCheck(e, _c, p) {
        if (!getN(e, p, 'blsDraw')) return;
        setN(e, p, 'blsDraw', 0);
        e.log(p, 'Ritual of Black Mastery: draw 1 card');
        e.draw(p, 1);
      },
      *afterAnyBattle(e, _c, p, attacker, target) {
        const mobc = [attacker, target].find((m) => m.name === MOBC && ctlOf(e, m) === p);
        const foe = mobc === attacker ? target : attacker;
        if (!on(e, p) || !mobc || e.fieldCard(foe.uid) || !e.find(foe.uid) || !inGY(e, p, (c) => isSpell(e, c)).length) return;
        yield* toHandFrom(e, p, 'Ritual of Black Mastery: add 1 Spell from your GY to your hand', inGY(e, p, (c) => isSpell(e, c)));
      },
    },
  } as SkillDef;
})();

// ----- Royal Flush -----
K['Royal Flush'] = (() => {
  const kj = (m: Card) => nameEngine().isNamed(m, "King's Knight") || nameEngine().isNamed(m, "Jack's Knight");
  const kings = (e: Engine, p: Pid) => inHand(e, p, (c) => e.isNamed(c, "King's Knight") && e.canNormalSummon(p, c, true, true));
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => faceUp(e, p, (m) => e.isNamed(m, "Queen's Knight")).length > 0 && e.player(p).lp > 1000 && kings(e, p).length > 0,
      *run(e, p) {
        e.payLp(p, 1000);
        setN(e, p, 'royal', e.state.turn);
        for (const m of e.monsters(p).filter(kj)) tag(m).noDirectTurn = e.state.turn;
        const k = kings(e, p)[0];
        if (k) yield* e.extraNormalSummon(p, k.uid, 'atk', true);
      },
    },
    eff: {
      *onAnySummon(e, _c, ctl, m, mctl) {
        if (mctl === ctl && kj(m) && isTurn(e, ctl, 'royal')) tag(m).noDirectTurn = e.state.turn;
      },
    },
  } as SkillDef;
})();

// ----- Spell Proof Armor -----
// "Unaffected by the opponent's Spell effects": they cannot destroy or target your Machines (other Spell effects still apply).
K['Spell Proof Armor'] = (() => {
  const on = (e: Engine, p: Pid) => !!e.player(p).skillRevealed && !getN(e, p, 'armorOff');
  return {
    use: { phase: 'main', can: (e, p) => !inGY(e, p, (c) => mon(e, c) && race(e, c) !== 'Machine').length, *run() {} },
    eff: {
      shields: (e, _c, target, how, ctl) => how !== 'battle' && on(e, ctl) && ctlOf(e, target) === ctl && e.raceOf(target) === 'Machine' && e.resolvingKind() === 'spell' && e.actor === other(ctl),
      tributeDiscount: (e, _c, ctl, monster, summoner) => (summoner === ctl && on(e, ctl) && isNormalMonster(e, monster) && race(e, monster) === 'Machine' ? 1 : 0),
      *stateCheck(e, _c, p) {
        if (on(e, p) && inGY(e, p, (c) => mon(e, c) && race(e, c) !== 'Machine').length) {
          setN(e, p, 'armorOff', 1);
          e.player(p).skillRevealed = false;
          e.log(p, `${e.player(p).name}'s Skill Spell Proof Armor flips back over`);
        }
      },
    },
  } as SkillDef;
})();

// ----- Spell of Mask -----
const spellOfMask = (): SkillDef => {
  const gardius = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy].filter((c) => e.isNamed(c, 'Masked Beast Des Gardius'));
  const both = (e: Engine, p: Pid) => {
    const pool = [...e.player(p).deck, ...e.player(p).gy];
    return pool.some((c) => e.isNamed(c, 'The Masked Beast')) && pool.some((c) => e.isNamed(c, 'Curse of the Masked Beast'));
  };
  return {
    eff: {
      *onAnyToGrave(e, _c, p, events) {
        const rm = (e.state.fx.ritualMats ?? {}) as Record<number, unknown>;
        const ev = events.find((x) => e.isNamed(x.card, 'The Masked Beast') && x.from === 'mz' && x.controller === p && x.reason === 'destroyed' && !x.byBattle && x.by === other(p) && !!rm[x.card.uid]);
        if (!ev || !opd(e, p, 'mask1') || !freeMZ(e, p) || !gardius(e, p).length) return;
        if (!(yield* e.yesno(p, 'Spell of Mask: Special Summon "Masked Beast Des Gardius"?'))) return;
        useOpd(e, p, 'mask1');
        reveal(e, p);
        yield* ssOne(e, p, 'Special Summon which "Masked Beast Des Gardius"?', gardius(e, p), 'atk', true);
      },
    },
    use: {
      oncePerDuel: false,
      can: (e, p) => opd(e, p, 'mask2') && e.monsters(p).some((m) => m.faceUp && e.isNamed(m, 'Masked Beast Des Gardius')) && both(e, p),
      *run(e, p) {
        const g = yield* pickOne(e, p, 'Tribute which "Masked Beast Des Gardius"?', e.monsters(p).filter((m) => m.faceUp && e.isNamed(m, 'Masked Beast Des Gardius')));
        if (!g) return;
        useOpd(e, p, 'mask2');
        yield* tribute(e, p, g);
        yield* toHandFrom(e, p, 'Add "The Masked Beast"', [...e.player(p).deck, ...e.player(p).gy].filter((c) => e.isNamed(c, 'The Masked Beast')));
        yield* toHandFrom(e, p, 'Add "Curse of the Masked Beast"', [...e.player(p).deck, ...e.player(p).gy].filter((c) => e.isNamed(c, 'Curse of the Masked Beast')));
      },
    },
  };
};
K['Spell of Mask'] = spellOfMask();
K['Spell of Mask (Skill Card)'] = spellOfMask();

// ----- Terror from the Deep! -----
// "If Kairyu-Shin you control leaves the field": noticed after the action that moved it; the Skill then flips back over.
K['Terror from the Deep!'] = (() => {
  const kai = (e: Engine, p: Pid) => faceUp(e, p, (m) => e.isNamed(m, 'Kairyu-Shin'));
  const umi = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy].filter((c) => e.isNamed(c, 'Umi'));
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => kai(e, p).length > 0 && !e.player(p).skillRevealed,
      *run(e, p) {
        if (umi(e, p).length && (yield* e.yesno(p, 'Terror from the Deep!: activate "Umi" from your hand, Deck or GY?'))) {
          const c = yield* pickOne(e, p, 'Activate which "Umi"?', umi(e, p));
          if (c) yield* activateField(e, p, c);
        }
      },
    },
    eff: {
      shields: (e, _c, target, how, ctl) => how !== 'battle' && !!e.player(ctl).skillRevealed && kai(e, ctl).length > 0 && ctlOf(e, target) === ctl && attrNow(e, target) === 'WATER' && e.resolvingKind() === 'trap',
      *stateCheck(e, _c, p) {
        const seen = ((e.state.fx.terrorKai ??= [[], []]) as number[][]);
        if (!e.player(p).skillRevealed) return void (seen[p] = []);
        const now = kai(e, p).map((m) => m.uid);
        const gone = seen[p].some((u) => !now.includes(u));
        seen[p] = now;
        if (!gone) return;
        seen[p] = [];
        e.log(p, 'Terror from the Deep!: "Kairyu-Shin" left the field');
        if (e.draw(p, 2)) e.player(p).skillRevealed = false;
      },
    },
  } as SkillDef;
})();

// ----- The Roids are Alright -----
// Its "Vehicroid Connection Zone" clause is not modelled (that card keeps to "Vehicroid" Fusion Monsters).
K['The Roids are Alright'] = (() => {
  const roid = (c: Card) => nameEngine().nameHas(c, 'roid');
  const on = (e: Engine, p: Pid) => !getN(e, p, 'roidsOff');
  return {
    *startOfDuel() {},
    eff: {
      tributeDiscount: (e, _c, ctl, monster, summoner) => (summoner === ctl && on(e, ctl) && roid(monster) && mon(e, monster) && levelOf(e, monster) <= 6 ? tribsFor(e, monster) : 0),
      *stateCheck(e, _c, p) {
        if (on(e, p) && faceUp(e, p, (m) => e.raceOf(m) !== 'Machine').length) {
          setN(e, p, 'roidsOff', 1);
          e.player(p).skillRevealed = false;
          e.log(p, `${e.player(p).name}'s Skill The Roids are Alright flips back over`);
        }
      },
    },
    attackBonus: (e, p, a, t) => (t && on(e, p) && roid(a) && !fusionOf(e, a) && e.raceOf(a) === 'Machine' && levelOf(e, a) <= 6 ? 100 * levelOf(e, a) : 0),
  } as SkillDef;
})();

// ----- Toon Mayhem! -----
K['Toon Mayhem!'] = {
  *startOfDuel() {},
  eff: {
    shields(e, _c, target, how, ctl) {
      if (how === 'target' || !e.isNamed(target, 'Toon World') || e.find(target.uid)?.loc.zone !== 'sz' || ctlOf(e, target) !== ctl || target.tags?.mayhemTurn === e.state.turn) return false;
      tag(target).mayhemTurn = e.state.turn;
      return true;
    },
  },
};

// ----- Twisted Personality -----
K['Twisted Personality'] = (() => {
  const n = (e: Engine, p: Pid) => e.skillCard(p)?.counters ?? 0;
  const faceUpOpp = (e: Engine, p: Pid) => [...affectable(e, p, faceUp(e, other(p))), ...stOf(e, other(p)).filter((c) => c.faceUp)];
  return {
    *startOfDuel(e, p) {
      setN(e, p, 'twistSeq', e.state.lastEvent?.seq ?? 0);
    },
    eff: {
      // Each time a player loses LP (damage or paid), 1 counter (max. 3).
      *stateCheck(e, c, p) {
        const last = getN(e, p, 'twistSeq');
        const hits = (e.state.events ?? []).filter((x) => x.seq > last && x.kind === 'damage' && (x.amount ?? 0) > 0);
        if (e.state.lastEvent) setN(e, p, 'twistSeq', Math.max(last, e.state.lastEvent.seq));
        if (hits.length && c.counters < 3) {
          c.counters = Math.min(3, c.counters + hits.length);
          e.log(p, `Twisted Personality: ${c.counters} counter(s)`);
        }
      },
    },
    use: {
      phase: 'main',
      oncePerDuel: false,
      can: (e, p) => (n(e, p) >= 2 && e.player(other(p)).hand.length > 0) || (n(e, p) >= 3 && faceUpOpp(e, p).length > 0),
      *run(e, p) {
        const okA = n(e, p) >= 2 && e.player(other(p)).hand.length > 0;
        const okB = n(e, p) >= 3 && faceUpOpp(e, p).length > 0;
        const o = okA && okB ? yield* chooseOption(e, p, 'Twisted Personality: which Skill?', ['Remove 2 counters: discard a random card from your opponent\'s hand', 'Remove 3 counters: destroy a face-up card your opponent controls']) : okA ? 0 : 1;
        const sc = e.skillCard(p)!;
        if (o === 0) {
          sc.counters -= 2;
          const hand = e.player(other(p)).hand;
          const c = hand[Math.floor(e.rand() * hand.length)];
          if (c) yield* e.discard(other(p), c.uid);
        } else if (o === 1) {
          sc.counters -= 3;
          const t = yield* pickOne(e, p, 'Destroy which face-up card?', faceUpOpp(e, p));
          if (t) yield* e.destroy([t.uid]);
        }
      },
    },
  } as SkillDef;
})();

// ----- Unlocking the Power -----
// The Skill offers the Sacred Beasts' own Summon with a free mix of face-up Fiend monsters, Continuous Spells and Continuous Traps.
K['Unlocking the Power'] = (() => {
  const LORDS = ['Uria, Lord of Searing Flames', 'Hamon, Lord of Striking Thunder', 'Raviel, Lord of Phantasms'];
  const costs = (e: Engine, p: Pid) => [...faceUp(e, p, (m) => e.raceOf(m) === 'Fiend'), ...e.spells(p).filter((c) => c.faceUp && !mon(e, c) && info(e, c).sub === 'Continuous')];
  const ok = (e: Engine, p: Pid) => costs(e, p).length >= 3 && (freeMZ(e, p) || costs(e, p).some((c) => e.find(c.uid)?.loc.zone === 'mz'));
  return {
    use: {
      phase: 'main',
      oncePerDuel: false,
      repeat: true,
      can: (e, p) => inHand(e, p, (c) => e.namesOf(c).some((nm) => LORDS.includes(nm))).length > 0 && ok(e, p),
      *run(e, p) {
        const lord = yield* pickOne(e, p, 'Unlocking the Power: Special Summon which Sacred Beast?', inHand(e, p, (c) => e.namesOf(c).some((nm) => LORDS.includes(nm))));
        if (!lord) return;
        const three = yield* pick(e, p, 'Send 3 face-up Fiend monsters, Continuous Spells and/or Continuous Traps you control to the GY', costs(e, p), 3, 3);
        if (!three || three.length < 3) return;
        for (const c of three) yield* e.sendToGrave(c.uid, e.find(c.uid)?.loc.zone === 'mz' ? 'tribute' : 'cost');
        yield* ss(e, p, lord, 'atk', true);
      },
    },
  } as SkillDef;
})();

// ----- Vampiric Aristocracy -----
K['Vampiric Aristocracy'] = (() => {
  const vamp = (e: Engine, m: FieldCard) => e.nameHas(m, 'Vampire') && e.raceOf(m) === 'Zombie' && !e.isNamed(m, 'Vampire Lord');
  return {
    use: {
      phase: 'main',
      can: (e, p) => faceUp(e, p, (m) => vamp(e, m)).length > 0,
      *run(e, p) {
        const m = yield* pickOne(e, p, 'Which Zombie "Vampire" monster becomes "Vampire Lord"?', faceUp(e, p, (x) => vamp(e, x)));
        if (m) rename(e, m, 'Vampire Lord');
      },
    },
    eff: {
      ...renameFx,
      // Each "Vampire Genesis" you control: if it inflicts battle damage, Set 1 card from the opponent's GY to your field.
      *onBattleDamageDealt(e, _c, attacker, p) {
        if (!e.isNamed(attacker, 'Vampire Genesis') || ctlOf(e, attacker) !== p || e.isNegated(attacker)) return;
        const gy = e.player(other(p)).gy.filter((c) => (mon(e, c) ? freeMZ(e, p) && !isExtraOrRitual(e, c) : info(e, c).sub === 'Field' ? !e.player(p).field : freeST(e, p) >= 0));
        if (!gy.length || !(yield* e.yesno(p, "Vampire Genesis: Set 1 card from your opponent's GY to your field?"))) return;
        const c = yield* pickOne(e, p, 'Set which card?', gy);
        if (!c) return;
        if (mon(e, c)) yield* e.specialSummon(c.uid, p, 'def', false);
        else setST(e, p, c);
      },
    },
  } as SkillDef;
})();

// ----- Volcanic Cannon -----
K['Volcanic Cannon'] = (() => {
  const doom = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy].filter((c) => e.isNamed(c, 'Volcanic Doomfire'));
  const tri = (e: Engine, p: Pid) => stOf(e, p).filter((c) => c.faceUp && e.isNamed(c, 'Tri-Blaze Accelerator'));
  return {
    use: {
      can: (e, p) => tri(e, p).length > 0 && freeMZ(e, p) && doom(e, p).length > 0,
      *run(e, p) {
        const t = yield* pickOne(e, p, 'Send which "Tri-Blaze Accelerator" to the GY?', tri(e, p));
        if (!t) return;
        ((e.state.fx.noEffectDamage ??= [-1, -1]) as number[])[other(p)] = e.state.turn;
        yield* e.sendToGrave(t.uid, 'cost');
        yield* ssOne(e, p, 'Special Summon "Volcanic Doomfire"', doom(e, p), 'atk', true);
      },
    },
  } as SkillDef;
})();

// ----- Welcome to the Jungle -----
K['Welcome to the Jungle'] = {
  *startOfDuel() {},
  eff: {
    damageMod(e, _c, _ctl, damaged, _amount, byEffect) {
      noteBattleHit(e, damaged, byEffect);
      // The Amazoness's ATK at damage calculation (it may be destroyed by the time the effect applies).
      const b = battling(e);
      if (!byEffect && b) e.state.fx.jungleAtk = Object.fromEntries([b.a, b.t].filter((m): m is FieldCard => !!m).map((m) => [m.uid, e.atkOf(m)]));
      return undefined;
    },
    *afterAnyBattle(e, _c, p, attacker, target) {
      const ama = [attacker, target].find((m) => m.owner === p && e.nameHas(m, 'Amazoness') && m.pos === 'atk' && m.faceUp);
      const foe = ama === attacker ? target : attacker;
      if (!ama || !foe || ctlOf(e, foe) !== other(p) || !e.fieldCard(foe.uid) || battleDamageIn(e, p) <= 0) return;
      const n = ((e.state.fx.jungleAtk ?? {}) as Record<number, number>)[ama.uid] ?? e.atkOf(ama);
      if (!n) return;
      reveal(e, p);
      boostTurn(foe, -n, -n);
      e.log(p, `Welcome to the Jungle: ${foe.name} loses ${n} ATK/DEF`);
    },
  },
};
