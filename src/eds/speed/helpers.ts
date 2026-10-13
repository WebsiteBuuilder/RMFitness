// Shared building blocks for the Speed Duel card scripts (src/eds/speed/cards-*.ts).
// Everything here works through the same Engine API the EDS scripts use.
import type { ChainCtx, Choice, Engine, Step } from '../engine';
import { other } from '../engine';
import type { EffectDef, Trigger } from '../effects';
import type { Card, ChainLink, FieldCard, Pid, Pos, Prompt } from '../types';

/** Helpers effects.ts hands over (the same ones the EDS scripts use). */
export interface SpeedHelpers {
  /** An Equip Spell: picks a face-up monster when activated and attaches on resolve. */
  equip(bonus?: EffectDef['equipBonus'], extra?: Partial<EffectDef>): EffectDef;
  /** An Equip Spell limited to monsters passing `test`. */
  equipFor(test: (e: Engine, m: FieldCard) => boolean, bonus: EffectDef['equipBonus'], extra?: Partial<EffectDef>): EffectDef;
  attachTo(e: Engine, card: FieldCard, monsterUid: number): void;
  /** A Field Spell giving `bonus` to each face-up monster it applies to. */
  fieldSpell(bonus: (e: Engine, m: FieldCard) => { atk: number; def: number } | undefined): EffectDef;
  /** A Ritual Spell that names its Ritual Monster in its text ("Ritual Summon "X""). */
  ritualSpell(): EffectDef;
  /** Fusion Monsters in the Extra Deck that could be Fusion Summoned right now from hand + field. */
  fusionPlans(e: Engine, p: Pid): unknown[];
  /** The full Polymerization script (reuse it for "Fusion Summon using monsters from your hand or field" cards). */
  polymerization: EffectDef;
}

export type Gen<T> = Generator<Prompt, T, Choice>;
export type { ChainCtx, Choice, Engine, Step, EffectDef, Trigger, Card, ChainLink, FieldCard, Pid, Pos, Prompt };
export { other };

// ---------- moments ----------
export const isMain = (t: Trigger) => t === 'main';
/** A Normal/Continuous Trap that can be activated at any open moment (no specific trigger). */
export const anyTime = (t: Trigger) => t === 'main' || t === 'summon' || t === 'special' || t === 'attack' || t === 'spell' || t === 'trap' || t === 'effect' || t === 'damage';
/** A monster was Normal/Flip Summoned (t === 'summon') or Special Summoned (t === 'special'). */
export const summoned = (t: Trigger) => t === 'summon' || t === 'special';
/** The uid of the monster an opponent's attack is coming from, if this is an "opponent's monster declares an attack" moment. */
export const opponentAttack = (e: Engine, p: Pid, t: Trigger, ctx: ChainCtx): number | null =>
  t === 'attack' && ctx.uid !== undefined && e.controller(ctx.uid) === other(p) && !!e.state.battle ? ctx.uid : null;
/** The monster just Summoned by the opponent (Trap Hole style), if any. */
export const opponentSummon = (e: Engine, p: Pid, t: Trigger, ctx: ChainCtx): FieldCard | null => {
  if (!summoned(t) || ctx.uid === undefined) return null;
  const m = e.fieldCard(ctx.uid);
  return m && e.controller(m.uid) === other(p) ? m : null;
};

// ---------- reading the field ----------
export const ctrl = (e: Engine, c: Card): Pid => e.controller(c.uid) ?? c.owner;
export const allMonsters = (e: Engine) => [...e.monsters(0), ...e.monsters(1)];
export const faceUpMonsters = (e: Engine, p?: Pid) => (p === undefined ? allMonsters(e) : e.monsters(p)).filter((m) => m.faceUp);
/** Spells/Traps on a player's field, including the Field Zone. */
export const stOf = (e: Engine, p: Pid) => [...e.spells(p), ...(e.player(p).field ? [e.player(p).field!] : [])];
export const allST = (e: Engine) => [...stOf(e, 0), ...stOf(e, 1)];
// b18: zones locked by Number 57: Tri-Head Dust Dragon do not count.
export const freeMZ = (e: Engine, p: Pid) => e.freeZone(e.player(p), 'mz') >= 0;
export const freeST = (e: Engine, p: Pid) => e.freeZone(e.player(p), 'sz');
export const info = (e: Engine, c: Card | string) => e.info(typeof c === 'string' ? c : c.name);
export const isMonster = (e: Engine, c: Card) => info(e, c).kind === 'monster';
export const isSpell = (e: Engine, c: Card) => info(e, c).kind === 'spell';
export const isTrap = (e: Engine, c: Card) => info(e, c).kind === 'trap';
/** A Trap Card on the field as a monster (Quantum Cat, Zoma the Spirit): the Level/Attribute its script gave it. */
const trapMonster = (e: Engine, c: Card) => (e.find(c.uid)?.loc.zone === 'mz' ? ((e.state.fx.trapMonster ?? {}) as Record<number, { level?: number; attribute?: string }>)[c.uid] : undefined);
/** Level/Attribute, including what a Trap Monster took on while it is on the field (Copy Knight, Swamp Mirrorer). */
const declared = (e: Engine, c: Card, key: 'declLevel' | 'declAttr') => ('faceUp' in c && e.state.fx[key]?.[c.uid] && e.find(c.uid)?.loc.zone === 'mz' ? e.state.fx[key][c.uid] : undefined);
/**
 * Level as it is now. On the field, effects can set it for good (tags.lvSet: Gagaga Caesar) or until the End Phase of turn
 * tags.lvSetTurn (Star Light, Star Bright), change it until the end of the turn (tags.lvTurn/lvDelta: Flelf, Mischief of the
 * Yokai) or while face-up (tags.lvMod: Risebell the Star Psycher); fx.lvDown[uid] lowers it this turn (Cost Down).
 * A Level never drops below 1.
 */
function levelChanges(e: Engine, c: Card, lv: number): number {
  if (lv <= 0) return lv;
  const t = 'faceUp' in c && e.find(c.uid)?.loc.zone === 'mz' ? (c as FieldCard).tags : undefined;
  if (t?.lvSet && t.lvSetTurn === e.state.turn) return t.lvSet;
  const base = t?.lvSet && t.lvSetTurn === undefined ? t.lvSet : lv;
  const delta = t && t.lvTurn === e.state.turn ? t.lvDelta ?? 0 : 0;
  const down = (e.state.fx.lvDown as Record<number, { turn: number; n: number }> | undefined)?.[c.uid];
  const n = base + delta + (t?.lvMod ?? 0) - (down?.turn === e.state.turn ? down.n : 0);
  return n === base ? base : Math.max(1, n);
}
export const levelOf = (e: Engine, c: Card): number => levelChanges(e, c, declared(e, c, 'declLevel') ?? trapMonster(e, c)?.level ?? info(e, c).level ?? 0);
/** Advanced Dark: "Crystal Beast" monsters on the field and in the GY are DARK. */
const advancedDark = (e: Engine, c: Card) => named(c, 'Crystal Beast') && info(e, c).kind === 'monster' && ['mz', 'gy'].includes(e.find(c.uid)?.loc.zone ?? '') && e.liveST().some((x) => x.c.name === 'Advanced Dark');
export const attrOf = (e: Engine, c: Card): string => declared(e, c, 'declAttr') ?? trapMonster(e, c)?.attribute ?? (advancedDark(e, c) ? 'DARK' : info(e, c).attribute ?? '');
export const raceOf = (e: Engine, c: Card) => ('faceUp' in c ? e.raceOf(c) : info(e, c).race ?? '');
/** "Archetype" check by name: names("Harpie") matches "Harpie Lady", "Harpie's Pet Dragon"... */
export const named = (c: Card | string, part: string) => (typeof c === 'string' ? c : c.name).includes(part);
/** A Normal Monster card (no effect). */
export const isNormalMonster = (e: Engine, c: Card) => isMonster(e, c) && info(e, c).sub === 'Normal';
/** Fusion/Ritual/Extra Deck monsters cannot be Normal Summoned and need a proper summon to be revived. */
export const isExtraOrRitual = (e: Engine, c: Card) => info(e, c).sub === 'Fusion' || info(e, c).sub === 'Ritual';
/** Monsters an effect controlled by `by` may target (skips untargetable ones). */
export const targetable = (e: Engine, list: FieldCard[]) => list.filter((m) => !e.untargetable(m));
export const label = (m: FieldCard) => (m.faceUp ? m.name : 'a face-down card');

// ---------- prompts ----------
/** Choose cards from a list. Returns the chosen cards, or null when cancelled. */
export function* pick<T extends Card>(e: Engine, p: Pid, title: string, cards: T[], min = 1, max = 1, cancel = false, hideFaceDown = true): Gen<T[] | null> {
  if (cards.length === 0) return min === 0 ? [] : null;
  const picks = yield* e.select(p, title, e.optionsFor(cards, hideFaceDown), min, max, cancel);
  if (!picks) return null;
  return picks.map((i) => cards[i]).filter((c): c is T => !!c);
}
/** Choose one card (null if none or cancelled). */
export function* pickOne<T extends Card>(e: Engine, p: Pid, title: string, cards: T[], cancel = false): Gen<T | null> {
  const r = yield* pick(e, p, title, cards, 1, 1, cancel);
  return r && r.length ? r[0] : null;
}
/** A choice between labelled options; returns the index or null. */
export function* chooseOption(e: Engine, p: Pid, title: string, labels: string[], cancel = false): Gen<number | null> {
  if (labels.length === 0) return null;
  const choice = yield { kind: 'select', player: p, title, options: labels.map((l) => ({ label: l })), min: 1, max: 1, cancel };
  if (typeof choice === 'object' && 'picks' in choice && choice.picks.length) return choice.picks[0];
  return null;
}
export function* yesno(e: Engine, p: Pid, title: string): Gen<boolean> {
  return yield* e.yesno(p, title);
}

// ---------- moving cards ----------
/** Adds 1 card from the Deck matching `test` to the hand, then shuffles. Returns the card or null. */
export function* searchDeck(e: Engine, p: Pid, title: string, test: (c: Card) => boolean, optional = false): Gen<Card | null> {
  const ps = e.player(p);
  const cands = ps.deck.filter(test);
  if (!cands.length) return null;
  const c = yield* pickOne(e, p, title, cands, optional);
  if (!c) return null;
  e.toHandOf(c.uid, p);
  e.log(p, `${ps.name} adds ${c.name} from the Deck to the hand`);
  ps.deck = e.shuffle(ps.deck);
  return c;
}
/** Adds 1 card from the Graveyard matching `test` to the hand. */
export function* fromGraveToHand(e: Engine, p: Pid, title: string, test: (c: Card) => boolean, optional = false): Gen<Card | null> {
  const ps = e.player(p);
  const c = yield* pickOne(e, p, title, ps.gy.filter(test), optional);
  if (!c) return null;
  e.toHandOf(c.uid, p);
  e.log(p, `${ps.name} adds ${c.name} from the Graveyard to the hand`);
  return c;
}
/** Special Summons 1 card chosen from `cards` (any zone). Shuffles the Deck if it came from there. */
export function* summonOneOf(e: Engine, p: Pid, title: string, cards: Card[], pos: Pos = 'atk', optional = false): Gen<FieldCard | null> {
  if (!freeMZ(e, p) || !cards.length) return null;
  const c = yield* pickOne(e, p, title, cards, optional);
  if (!c) return null;
  const fromDeck = e.find(c.uid)?.loc.zone === 'deck';
  yield* e.specialSummon(c.uid, p, pos);
  if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
  return e.fieldCard(c.uid);
}
/** Mills the top `n` cards of a Deck. */
export function* millTop(e: Engine, p: Pid, n: number): Step {
  for (let i = 0; i < n; i++) {
    const c = e.player(p).deck[0];
    if (!c) return;
    yield* e.sendToGrave(c.uid, 'mill');
  }
}
/** Sends a chosen card from the Deck to the Graveyard (Foolish Burial style). */
export function* deckToGrave(e: Engine, p: Pid, title: string, test: (c: Card) => boolean): Gen<Card | null> {
  const c = yield* pickOne(e, p, title, e.player(p).deck.filter(test));
  if (!c) return null;
  yield* e.sendToGrave(c.uid, 'cost');
  e.log(p, `${e.player(p).name} sends ${c.name} from the Deck to the Graveyard`);
  e.player(p).deck = e.shuffle(e.player(p).deck);
  return c;
}

// ---------- costs ----------
/** Discard `n` cards (matching `test`) as a cost. False if impossible or cancelled. */
export function* discardCost(e: Engine, p: Pid, n = 1, test: (c: Card) => boolean = () => true, except?: number): Gen<boolean> {
  const cands = e.player(p).hand.filter((c) => c.uid !== except && test(c));
  if (cands.length < n) return false;
  const chosen = yield* pick(e, p, `Discard ${n} card${n > 1 ? 's' : ''}`, cands, n, n, true);
  if (!chosen) return false;
  for (const c of chosen) yield* e.discard(p, c.uid);
  return true;
}
/** Tribute `n` monsters you control (matching `test`) as a cost. */
export function* tributeCost(e: Engine, p: Pid, n = 1, test: (m: FieldCard) => boolean = () => true, except?: number): Gen<boolean> {
  const cands = e.monsters(p).filter((m) => m.uid !== except && test(m) && !e.untributable(m));
  if (cands.length < n) return false;
  const chosen = yield* pick(e, p, `Tribute ${n} monster${n > 1 ? 's' : ''}`, cands, n, n, true, false);
  if (!chosen) return false;
  for (const m of chosen) {
    e.log(p, `${e.player(p).name} Tributes ${m.name}`);
    yield* e.sendToGrave(m.uid, 'tribute');
  }
  return true;
}
/** Pay LP if possible. */
export function payLp(e: Engine, p: Pid, n: number): boolean {
  if (e.player(p).lp <= n) return false;
  e.payLp(p, n);
  return true;
}

// ---------- stat changes ----------
/** ATK/DEF change until the end of this turn. */
export function boostTurn(m: FieldCard, atk: number, def = 0) {
  m.atkMod += atk;
  m.defMod += def;
}
/** ATK/DEF change that lasts while the monster stays face-up on the field. */
export function boostPerm(m: FieldCard, atk: number, def = 0) {
  const t = (m.tags ??= {});
  t.permAtk = (t.permAtk ?? 0) + atk;
  t.permDef = (t.permDef ?? 0) + def;
}
export const tag = (m: FieldCard) => (m.tags ??= {});
/** Negates a face-up monster's effects: until the end of this turn, or for as long as it stays face-up on the field. */
export function negateMonster(e: Engine, m: FieldCard, untilEndOfTurn = true) {
  if (untilEndOfTurn) tag(m).negatedTurn = e.state.turn;
  else tag(m).negated = 1;
  e.log(null, `${m.name}'s effects are negated`);
}

/** The player takes no battle damage from the current battle (or from any battle this turn). */
export function noBattleDamage(e: Engine, p: Pid, wholeTurn = false) {
  const fx = e.state.fx;
  if (wholeTurn) (fx.noBattleDamage ??= [-1, -1])[p] = e.state.turn;
  else (fx.noBattleDamageIn ??= [0, 0])[p] = fx.battleNo ?? 0;
}
/** Shuffles a card into its owner's Deck. */
export function toDeck(e: Engine, uid: number) {
  const f = e.find(uid);
  if (!f) return;
  const owner = f.card.owner;
  e.toDeckTop(uid);
  e.player(owner).deck = e.shuffle(e.player(owner).deck);
}
/** The current attack: attacker and target (null target = direct attack). */
export function currentBattle(e: Engine): { attacker: FieldCard | null; target: FieldCard | null } | null {
  const b = e.state.battle;
  if (!b) return null;
  return { attacker: e.fieldCard(b.attacker), target: b.target !== null ? e.fieldCard(b.target) : null };
}

// ---------- chains ----------
/** Negates the activation of a chain link (Counter Traps, "negate the activation"). */
export function negateLink(e: Engine, link: ChainLink | undefined, by: Pid) {
  if (!link) return;
  // Constellar Belt: the activation of LIGHT monsters' effects cannot be negated.
  const fx = (link.payload as { effect?: string } | undefined)?.effect;
  const m = fx ? e.fieldCard(link.card.uid) : null;
  const light = fx && (m ? e.controller(m.uid) !== null && m.faceUp && attrOf(e, m) === 'LIGHT' : info(e, link.card).kind === 'monster' && attrOf(e, link.card) === 'LIGHT');
  if (light && e.liveST().some((x) => x.c.name === 'Constellar Belt')) {
    e.log(by, `Constellar Belt: ${link.card.name}'s activation cannot be negated`);
    return;
  }
  link.negated = true;
  e.log(by, `${link.card.name} is negated`);
}
/** The chain link this card is responding to, when it is a Spell/Trap card activation. */
export const respondingTo = (ctx: ChainCtx) => ctx.link;

// ---------- common card shapes ----------
/** A Normal Spell that does `run` when it resolves. */
export const spell = (run: (e: Engine, p: Pid, link: ChainLink) => Step, can: (e: Engine, p: Pid) => boolean = () => true): EffectDef => ({
  canActivate: (e, _c, p, t) => isMain(t) && can(e, p),
  resolve: (e, link, p) => run(e, p, link),
});
/** Gain LP. */
export const lpSpell = (n: number): EffectDef => spell(function* (e, p) {
  e.gainLp(p, n);
});
/** Inflict damage to the opponent. */
export const burnSpell = (n: number): EffectDef => spell(function* (e, p) {
  e.damage(other(p), n);
});
/** Draw cards. */
export const drawSpell = (n: number): EffectDef => spell(function* (e, p) {
  e.draw(p, n);
}, (e, p) => e.player(p).deck.length >= n);
/** Destroy 1 target (chosen at activation from `targets`). */
export const destroyTarget = (title: string, targets: (e: Engine, p: Pid) => FieldCard[], trigger: (t: Trigger, e: Engine, p: Pid, ctx: ChainCtx) => boolean = (t) => isMain(t)): EffectDef => ({
  canActivate: (e, _c, p, t, ctx) => trigger(t, e, p, ctx) && targets(e, p).length > 0,
  *activate(e, link, p) {
    const m = yield* pickOne(e, p, title, targets(e, p), true);
    if (!m) return false;
    link.targetUid = m.uid;
  },
  *resolve(e, link) {
    if (link.targetUid !== undefined && e.fieldCard(link.targetUid)) yield* e.destroy([link.targetUid]);
  },
});
/** A monster effect that searches the Deck when Normal Summoned (and optionally Special Summoned). */
export function searchOnSummon(title: string, test: (e: Engine, c: Card) => boolean, special = false): Partial<EffectDef> {
  const run = function* (e: Engine, _m: FieldCard, p: Pid): Step {
    if (!e.player(p).deck.some((c) => test(e, c))) return;
    if (!(yield* e.yesno(p, `${title}?`))) return;
    yield* searchDeck(e, p, title, (c) => test(e, c));
  };
  return {
    *onSummon(e, m, p, kind) {
      if (kind === 'normal') yield* run(e, m, p);
    },
    ...(special ? { onSpecialSummon: run } : {}),
  };
}
