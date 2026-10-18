// Speed Duel card scripts, batch 09 (Rare Metalmorph ... Tail Swipe).
import type { EffectDef } from '../effects';
import type { SummonLock } from '../engine';
import { getEffect } from '../effects';
import type { Card, ChainCtx, ChainLink, Engine, FieldCard, Gen, Pid, Pos, SpeedHelpers, Step } from './helpers';
import {
  allMonsters,
  allST,
  anyTime,
  boostPerm,
  boostTurn,
  chooseOption,
  ctrl,
  deckToGrave,
  destroyTarget,
  discardCost,
  faceUpMonsters,
  freeMZ,
  freeST,
  info,
  isExtraOrRitual,
  isMain,
  isMonster,
  isNormalMonster,
  isSpell,
  isTrap,
  label,
  levelOf,
  millTop,
  named,
  negateLink,
  opponentAttack,
  other,
  payLp,
  pick,
  pickOne,
  raceOf,
  searchDeck,
  stOf,
  summonOneOf,
  tag,
  targetable,
  toDeck,
  tributeCost,
} from './helpers';

// ---------- local helpers ----------
type E9 = Engine;
const attrOfC = (e: E9, c: Card) => info(e, c).attribute ?? '';
const monstersIn = (e: E9, cards: Card[], test: (c: Card) => boolean = () => true) => cards.filter((c) => isMonster(e, c) && test(c));
/** Pick from your own cards, showing face-down ones by name. */
function* pickMine<T extends Card>(e: E9, p: Pid, title: string, cards: T[], cancel = false): Gen<T | null> {
  const r = yield* pick(e, p, title, cards, 1, 1, cancel, false);
  return r && r.length ? r[0] : null;
}
const fieldOrNull = (e: E9, uid: number | undefined) => (uid !== undefined ? e.fieldCard(uid) : null);
/** Equip cards on a monster leave with it before it moves somewhere other than the GY. */
function* dropEquips(e: E9, uid: number): Step {
  const m = e.fieldCard(uid);
  if (m) for (const eq of m.equips.slice()) yield* e.sendToGrave(eq, 'used');
}
/** Shuffle a card into the Deck (Fusion Monsters go back to the Extra Deck, Tokens vanish). */
function* shuffleIn(e: E9, uid: number): Step {
  const f = e.find(uid);
  if (!f) return;
  if (f.card.token) return yield* e.sendToGrave(uid, 'used');
  yield* dropEquips(e, uid);
  if (info(e, f.card).sub === 'Fusion') return toExtra(e, uid);
  toDeck(e, uid);
}
/** Return a card to the hand (Fusion Monsters to the Extra Deck, Tokens vanish). */
function* toHandSafe(e: E9, uid: number): Step {
  const f = e.find(uid);
  if (!f) return;
  if (f.card.token) return yield* e.sendToGrave(uid, 'used');
  yield* dropEquips(e, uid);
  if (info(e, f.card).sub === 'Fusion') return toExtra(e, uid);
  e.toHand(uid);
}
function toExtra(e: E9, uid: number) {
  const owner = e.find(uid)?.card.owner;
  if (owner === undefined) return;
  e.toDeckTop(uid);
  const ps = e.player(owner);
  const i = ps.deck.findIndex((c) => c.uid === uid);
  if (i >= 0) ps.fusion.push(ps.deck.splice(i, 1)[0]);
}
const blankField = (c: Card, turn: number): FieldCard => ({ uid: c.uid, name: c.name, owner: c.owner, pos: 'atk', faceUp: false, placedTurn: turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 });
/** Takes a card out of a hand/Deck/GY array. */
function lift(e: E9, c: Card): boolean {
  const f = e.find(c.uid);
  if (!f) return false;
  const ps = e.player(f.loc.player);
  const arr = f.loc.zone === 'hand' ? ps.hand : f.loc.zone === 'deck' ? ps.deck : f.loc.zone === 'gy' ? ps.gy : null;
  if (!arr) return false;
  arr.splice(f.loc.index, 1);
  return true;
}
/** Sets a Spell/Trap from the hand, Deck or GY (readyNow: it can be activated this turn). */
function setCard(e: E9, c: Card, p: Pid, readyNow: boolean): boolean {
  const zone = freeST(e, p);
  const fromDeck = e.find(c.uid)?.loc.zone === 'deck';
  if (zone < 0 || !lift(e, c)) return false;
  e.player(p).sz[zone] = blankField(c, readyNow ? e.state.turn - 1 : e.state.turn);
  if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
  e.event('set', { uid: c.uid, player: p });
  e.log(p, `${e.player(p).name} Sets ${c.name}`);
  return true;
}
/** Equips a monster card from the GY to a monster (Red-Eyes Baby Dragon). */
function equipFromGrave(e: E9, c: Card, host: FieldCard, p: Pid): boolean {
  const zone = freeST(e, p);
  if (zone < 0 || e.find(c.uid)?.loc.zone !== 'gy' || !lift(e, c)) return false;
  const fc = { ...blankField(c, e.state.turn), faceUp: true, active: true, equippedTo: host.uid };
  e.player(p).sz[zone] = fc;
  host.equips.push(fc.uid);
  e.event('activate', { uid: c.uid, player: p });
  e.log(p, `${c.name} is equipped to ${host.name}`);
  return true;
}
function setFaceDown(e: E9, m: FieldCard) {
  if (m.token) return;
  m.faceUp = false;
  m.pos = 'def';
  e.event('position', { uid: m.uid });
  e.log(null, `${m.name} is changed to face-down Defense Position`);
}
function togglePos(e: E9, m: FieldCard) {
  m.pos = m.pos === 'atk' ? 'def' : 'atk';
  e.event('position', { uid: m.uid });
  e.log(null, `${m.name} is changed to ${m.pos === 'atk' ? 'Attack' : 'Defense'} Position`);
}
/** "Target 1 monster in your GY; Special Summon it." */
function reviveCard(title: string, test: (e: E9, c: Card) => boolean, o: { trap?: boolean; pos?: Pos; after?: (e: E9, m: FieldCard) => void } = {}): EffectDef {
  const list = (e: E9, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && !isExtraOrRitual(e, c) && test(e, c));
  return {
    canActivate: (e, _c, p, t) => (o.trap ? anyTime(t) : isMain(t)) && freeMZ(e, p) && list(e, p).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, title, list(e, p), true);
      if (!c) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      const uid = link.targetUid;
      const f = uid !== undefined ? e.find(uid) : null;
      if (!f || f.loc.zone !== 'gy' || f.loc.player !== p || !freeMZ(e, p)) return;
      yield* e.specialSummon(f.card.uid, p, o.pos ?? 'atk');
      const m = e.fieldCard(f.card.uid);
      if (m && o.after) o.after(e, m);
    },
  };
}
/** "Target 2 ... in your GY; add those targets to your hand." */
function twoToHand(title: string, test: (e: E9, c: Card) => boolean): EffectDef {
  const list = (e: E9, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && test(e, c));
  return {
    canActivate: (e, _c, p, t) => isMain(t) && list(e, p).length >= 2,
    *activate(e, link, p) {
      const r = yield* pick(e, p, title, list(e, p), 2, 2, true);
      if (!r || r.length < 2) return false;
      link.payload = r.map((c) => c.uid);
    },
    *resolve(e, link, p) {
      for (const uid of link.payload as number[]) {
        const f = e.find(uid);
        if (f && f.loc.zone === 'gy' && f.loc.player === p) {
          e.toHandOf(uid, p);
          e.log(p, `${f.card.name} is added to the hand`);
        }
      }
    },
  };
}
/** A Continuous Trap that only needs to be face-up. */
const contTrap = (extra: Partial<EffectDef>): EffectDef => ({ canActivate: (_e, _c, _p, t) => anyTime(t), *resolve() {}, ...extra });
const contSpell = (extra: Partial<EffectDef>): EffectDef => ({ canActivate: (_e, _c, _p, t) => isMain(t), *resolve() {}, ...extra });
/** "Target 1 face-up monster; it gains X ATK/DEF until the end of this turn." */
function boostTrap(title: string, atk: number, def: number, mineOnly = false, cost?: (e: E9, p: Pid) => Gen<boolean>, canCost: (e: E9, p: Pid) => boolean = () => true): EffectDef {
  const list = (e: E9, p: Pid) => targetable(e, faceUpMonsters(e, mineOnly ? p : undefined));
  return {
    canActivate: (e, _c, p, t) => anyTime(t) && list(e, p).length > 0 && canCost(e, p),
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, title, list(e, p), true);
      if (!m) return false;
      if (cost && !(yield* cost(e, p))) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const m = fieldOrNull(e, link.targetUid);
      if (m?.faceUp) boostTurn(m, atk, def);
    },
  };
}
const SKILLED = ['Skilled Blue Magician', 'Skilled Dark Magician', 'Skilled Red Magician', 'Skilled White Magician'];
/** Face-up cards that can hold a Spell Counter (the Skilled Magicians hold at most 3). */
const counterHolders = (e: E9, p?: Pid) =>
  [...(p === undefined ? [0, 1] : [p]).flatMap((q) => [...e.monsters(q as Pid), ...e.activeSpells(q as Pid)])].filter(
    (c) => c.faceUp && /Spell Counter/.test(info(e, c).desc) && !e.isNamed(c, 'Spell Power Grasp') && !(e.namesOf(c).some((nm) => SKILLED.includes(nm)) && c.counters >= 3),
  );
function addCounter(e: E9, c: FieldCard) {
  if (e.namesOf(c).some((nm) => SKILLED.includes(nm)) && c.counters >= 3) return;
  c.counters++;
  e.log(null, `A Spell Counter is placed on ${c.name} (${c.counters})`);
}
/** Skilled X Magician: counters from Spell activations, Tribute with 3 for a monster, and (some) a GY effect. */
function skilled(title: string, test: (e: E9, c: Card) => boolean, gyEffect: boolean): EffectDef {
  const sources = (e: E9, p: Pid) => [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy].filter((c) => isMonster(e, c) && !isExtraOrRitual(e, c) && test(e, c));
  const def: EffectDef = {
    // audit-09: mandatory: a Spell Counter each time a Spell Card resolves (its activation, not a Spell's later effect), max. 3.
    *onChainLink(e, m, _p, link) {
      if ((link.payload as { effect?: string } | undefined)?.effect || !isSpell(e, link.card) || m.counters >= 3) return;
      addCounter(e, m);
    },
    ignition: {
      can: (e, m, p) => m.counters >= 3 && sources(e, p).length > 0 && !e.untributable(m),
      // audit-09: Tributing it is the cost, paid as the effect is activated.
      *cost(e, m, p) {
        if (m.counters < 3) return false;
        e.log(p, `${e.player(p).name} Tributes ${m.name}`);
        yield* e.sendToGrave(m.uid, 'tribute');
      },
      // Approximation: resolves at once (the engine only resolves chained ignition effects of monsters still on the field).
      chain: false,
      *run(e, _m, p) {
        yield* summonOneOf(e, p, title, sources(e, p));
      },
    },
  };
  if (gyEffect)
    def.graveIgnition = {
      can: (e, _c, p) => counterHolders(e, p).length > 0,
      *run(e, card, p) {
        const t = yield* pickOne(e, p, `${card.name}: place a Spell Counter on which card?`, counterHolders(e, p), true);
        if (!t) return;
        e.banish(card.uid);
        if (e.fieldCard(t.uid)?.faceUp) addCounter(e, t);
      },
    };
  return def;
}
/** Swarm of Locusts / Scarabs: flip itself face-down, and a Flip Summon trigger. */
const canFlipDown = (e: E9, m: FieldCard) => m.faceUp && m.placedTurn !== e.state.turn && !m.posChanged;
function swarm(what: 'st' | 'monster'): EffectDef {
  return {
    ignition: {
      can: (e, m) => canFlipDown(e, m),
      *run(e, m) {
        const x = e.fieldCard(m.uid);
        if (x?.faceUp) setFaceDown(e, x);
      },
    },
    *onSummon(e, m, p, kind) {
      if (kind !== 'flip') return;
      const opp = other(p);
      const list = what === 'st' ? stOf(e, opp) : targetable(e, e.monsters(opp));
      const t = yield* pickOne(e, p, `${m.name}: destroy which card?`, list);
      if (t && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
    },
  };
}
/** Monsters in the same column as `m` (both sides), excluding m. */
function columnOf(e: E9, m: FieldCard): FieldCard[] {
  const f = e.find(m.uid);
  if (!f || f.loc.zone !== 'mz') return [];
  const i = f.loc.index;
  const p = f.loc.player;
  // audit-09: the opponent's zones face yours mirrored (zone i faces their zone n-1-i).
  const facing = e.player(other(p)).mz[e.player(other(p)).mz.length - 1 - i];
  return [e.player(p).mz[i], facing].filter((x): x is FieldCard => !!x && x.uid !== m.uid);
}
/** Battle damage equal to the original ATK when attacking directly "using this effect" (Sonic Shooter, Submarineroid). */
const originalDirect = (e: E9, a: FieldCard, t: FieldCard | null) => {
  if (t) return 0;
  const p = ctrl(e, a);
  return e.monsters(other(p)).length > 0 ? e.baseStats(a).atk - e.atkOf(a) : 0;
};
/** audit-09: `m` is battling right now (attacker or attack target). */
const inBattle = (e: E9, m: FieldCard) => !!e.state.battle && (e.state.battle.attacker === m.uid || e.state.battle.target === m.uid);
/** audit-09: an opponent's effect targeting this monster: a die roll as it resolves; on a listed result it is negated and its card destroyed. */
function dieGuard(name: string, hits: number[]): NonNullable<EffectDef['onChainLink']> {
  return function* (e, m, p, link) {
    if (link.player === p || link.targetUid !== m.uid || link.negated) return;
    const r = yield* e.rollDie(p, (v) => hits.includes(v));
    e.log(p, `${name} rolls a ${r}`);
    if (!hits.includes(r)) return;
    negateLink(e, link, p);
    if (link.negated && e.fieldCard(link.card.uid)) yield* e.destroy([link.card.uid]);
  };
}
let skyscraperGuard = false;
const DIVINE = ['Obelisk the Tormentor', 'Slifer the Sky Dragon', 'The Winged Dragon of Ra'];
/** audit-09: "Must be Special Summoned (from your hand) by ..., and cannot be Special Summoned by other ways": fx.procSummon marks the proc's own Summon. */
// (With nothing resolving, a Summon is let through: that is the engine offering the procedure itself, or a test placing the card.)
const procOnly: EffectDef['cannotSpecial'] = (e, c, _p, from) => from !== null && e.state.fx.procSummon !== c.uid && e.resolvingCard() !== null;
function* procSummon(e: E9, c: Card, p: Pid, pos: Pos = 'atk'): Step {
  e.state.fx.procSummon = c.uid;
  try {
    yield* e.specialSummon(c.uid, p, pos);
  } finally {
    e.state.fx.procSummon = undefined;
  }
}

export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  // ---------- R ----------
  const machines = (e: E9) => targetable(e, faceUpMonsters(e)).filter((m) => raceOf(e, m) === 'Machine');
  E['Rare Metalmorph'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && machines(e).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Rare Metalmorph: target which Machine monster?', machines(e), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const m = fieldOrNull(e, link.targetUid);
      const fc = e.fieldCard(link.card.uid);
      if (!fc) return;
      if (!m?.faceUp || raceOf(e, m) !== 'Machine') return yield* e.sendToGrave(fc.uid, 'used');
      h.attachTo(e, fc, m.uid);
    },
    equipBonus: () => ({ atk: 500, def: 0 }),
    // "Once, negate a Spell effect that targets that monster."
    quick: {
      label: 'negate the Spell targeting its monster',
      repeat: true,
      can: (e, card, _p, t, ctx) => {
        const fc = card as FieldCard;
        return t === 'spell' && !!ctx.link && isSpell(e, ctx.link.card) && fc.equippedTo !== undefined && ctx.link.targetUid === fc.equippedTo && !fc.tags?.used;
      },
      *run(e, card, p, link) {
        const fc = e.fieldCard(card.uid);
        if (!fc || fc.tags?.used) return;
        tag(fc).used = 1;
        negateLink(e, (link.payload as { ctx?: ChainCtx }).ctx?.link, p);
      },
    },
  };

  const cbInST = (e: E9, p: Pid) => e.spells(p).filter((c) => named(e, c, 'Crystal Beast'));
  E['Rare Value'] = {
    canActivate: (e, _c, p, t) => isMain(t) && cbInST(e, p).length >= 2 && e.player(p).deck.length >= 2,
    *resolve(e, _l, p) {
      const c = yield* pickOne(e, other(p), 'Rare Value: choose a "Crystal Beast" card for your opponent to send to the GY', cbInST(e, p));
      if (!c) return;
      yield* e.sendToGrave(c.uid, 'used');
      if (e.find(c.uid)?.loc.zone === 'gy') e.draw(p, 2);
    },
  };

  E['Raviel, Lord of Phantasms'] = {
    cannotNormalSummon: true,
    summonProc: {
      can: (e, _c, p) => e.monsters(p).filter((m) => raceOf(e, m) === 'Fiend').length >= 3,
      *run(e, c, p) {
        if (!(yield* tributeCost(e, p, 3, (m) => raceOf(e, m) === 'Fiend'))) return;
        yield* procSummon(e, c, p);
      },
    },
    cannotSpecial: procOnly, // audit-09
    *onAnySummon(e, _w, wp, _m, mp, kind) {
      if (kind !== 'normal' || mp === wp) return;
      const t = e.createToken('Phantasm Token', wp, 'atk', true, { atk: 1000, def: 1000, level: 1, attribute: 'DARK', race: 'Fiend' });
      if (t) t.cannotAttack = true;
    },
    ignition: {
      can: (e, m, p) => e.monsters(p).some((x) => x.uid !== m.uid && !e.untributable(x)),
      // audit-09: the Tribute is the cost, paid as the effect is activated.
      *cost(e, m, p) {
        const t = yield* pickMine(e, p, 'Raviel: Tribute which monster?', e.monsters(p).filter((x) => x.uid !== m.uid && !e.untributable(x)), true);
        if (!t) return false;
        tag(m).ravielAtk = e.baseStats(t).atk;
        e.log(p, `${e.player(p).name} Tributes ${t.name}`);
        yield* e.sendToGrave(t.uid, 'tribute');
      },
      *run(e, m) {
        const r = e.fieldCard(m.uid);
        if (r?.faceUp) boostTurn(r, m.tags?.ravielAtk ?? 0);
      },
    },
  };

  const fusionsInGy = (e: E9, p: Pid) => e.player(p).gy.filter((c) => info(e, c).sub === 'Fusion');
  E['Re-Fusion'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).lp > 800 && freeMZ(e, p) && fusionsInGy(e, p).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Re-Fusion: Special Summon which Fusion Monster?', fusionsInGy(e, p), true);
      if (!c || !payLp(e, p, 800)) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      const fc = e.fieldCard(link.card.uid);
      const uid = link.targetUid;
      if (!fc || uid === undefined || e.find(uid)?.loc.zone !== 'gy' || !freeMZ(e, p)) return;
      yield* e.specialSummon(uid, p, 'atk');
      if (e.fieldCard(uid) && e.fieldCard(fc.uid)) h.attachTo(e, fc, uid);
    },
    *onLeaveField(e, fc, _c, reason) {
      if (reason !== 'destroyed' || fc.equippedTo === undefined) return;
      const host = e.fieldCard(fc.equippedTo);
      if (host) e.banish(host.uid);
    },
  };

  const slimeSources = (e: E9, p: Pid) => [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy].filter((c) => e.isNamed(c, 'Metal Reflect Slime'));
  E['Reactor Slime'] = {
    ignition: {
      can: (e, _m, p) => e.oncePerTurn('Reactor Slime:tokens', p) && e.player(p).mz.filter((z) => z === null).length >= 2,
      *run(e, _m, p) {
        if (!e.oncePerTurn('Reactor Slime:tokens', p) || e.player(p).mz.filter((z) => z === null).length < 2) return;
        e.useOnce('Reactor Slime:tokens', p);
        for (let i = 0; i < 2; i++) e.createToken('Slime Token', p, 'atk', true, { atk: 500, def: 500, level: 1, attribute: 'WATER', race: 'Aqua' });
        // audit-09: "you cannot Normal or Special Summon monsters for the rest of this turn, except Divine-Beast monsters" (the Egyptian Gods by name).
        ((e.state.fx.summonLocks ??= []) as SummonLock[]).push({ p, turn: e.state.turn, normal: true, special: true, only: DIVINE });
      },
    },
    quick: {
      label: 'Tribute it to Set Metal Reflect Slime',
      can: (e, _card, p) => e.state.phase === 'BP' && e.oncePerTurn('Reactor Slime:set', p) && slimeSources(e, p).length > 0 && freeST(e, p) >= 0,
      *cost(e, card, p) {
        e.useOnce('Reactor Slime:set', p);
        e.log(p, `${e.player(p).name} Tributes ${card.name}`);
        yield* e.sendToGrave(card.uid, 'tribute');
      },
      *run(e, _card, p) {
        const c = yield* pickOne(e, p, 'Reactor Slime: Set which Metal Reflect Slime?', slimeSources(e, p));
        if (c) setCard(e, c, p, true);
      },
    },
  };

  const wsTargets = (e: E9) => targetable(e, faceUpMonsters(e)).filter((m) => ['Warrior', 'Spellcaster'].includes(raceOf(e, m)));
  E['Ready for Intercepting'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && wsTargets(e).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Ready for Intercepting: target which monster?', wsTargets(e), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const m = fieldOrNull(e, link.targetUid);
      if (m?.faceUp) setFaceDown(e, m);
    },
  };

  // group-F: Link Monsters have no DEF, so they do not count as 0 DEF.
  E['Recurring Nightmare'] = twoToHand('Recurring Nightmare: add which 2 DARK monsters?', (e, c) => attrOfC(e, c) === 'DARK' && info(e, c).def === 0 && info(e, c).sub !== 'Link');

  const redArchfiend = (e: E9) => allMonsters(e).some((m) => m.faceUp && e.isNamed(info(e, m), 'Red Dragon Archfiend'));
  const lv1Tuners = (e: E9, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && !!info(e, c).tuner && levelOf(e, c) === 1);
  E['Red Screen'] = contTrap({
    blocksAttack: (e, card, _m, attacker) => attacker !== ctrl(e, card),
    *onEndPhase(e, fc, p) {
      if (e.state.turnPlayer !== p) return;
      if (e.player(p).lp > 1000) e.payLp(p, 1000);
      else yield* e.destroy([fc.uid]);
    },
    // audit-09: target a Level 1 Tuner in your GY; destroy this card, then Special Summon it (needs "Red Dragon Archfiend" on the field).
    // Offered as a Main Phase effect of the face-up card.
    ignition: {
      repeat: true,
      can: (e, _c, p) => redArchfiend(e) && freeMZ(e, p) && lv1Tuners(e, p).length > 0,
      *run(e, c, p) {
        const t = yield* pickOne(e, p, 'Red Screen: Special Summon which Level 1 Tuner?', lv1Tuners(e, p), true);
        if (!t || !redArchfiend(e) || !e.fieldCard(c.uid)) return;
        yield* e.destroy([c.uid]);
        if (!e.fieldCard(c.uid) && e.find(t.uid)?.loc.zone === 'gy' && freeMZ(e, p)) yield* e.specialSummon(t.uid, p, 'atk');
      },
    },
  });

  const lv1Dragon = (e: E9, c: Card) => isMonster(e, c) && raceOf(e, c) === 'Dragon' && levelOf(e, c) === 1;
  E['Red-Eyes Baby Dragon'] = {
    *onDestroyed(e, card, p, byBattle) {
      if (!byBattle || !freeMZ(e, p) || e.find(card.uid)?.loc.zone !== 'gy') return;
      const list = e.player(p).deck.filter((c) => isMonster(e, c) && named(e, c, 'Red-Eyes') && levelOf(e, c) <= 7 && !isExtraOrRitual(e, c));
      if (!list.length || !(yield* e.yesno(p, 'Red-Eyes Baby Dragon: Special Summon a Level 7 or lower "Red-Eyes" monster from the Deck?'))) return;
      const m = yield* summonOneOf(e, p, 'Red-Eyes Baby Dragon: Special Summon which monster?', list);
      if (m) equipFromGrave(e, card, m, p);
    },
    equipBonus: () => ({ atk: 300, def: 0 }),
    *onSentToGrave(e, _card, owner, from) {
      if (from !== 'sz') return;
      const ps = e.player(owner);
      const list = [...ps.deck.filter((c) => lv1Dragon(e, c)), ...ps.gy.filter((c) => lv1Dragon(e, c))];
      if (!list.length || !(yield* e.yesno(owner, 'Red-Eyes Baby Dragon: add a Level 1 Dragon from your Deck or GY to your hand?'))) return;
      const c = yield* pickOne(e, owner, 'Add which Level 1 Dragon?', list);
      if (!c) return;
      const fromDeck = e.find(c.uid)?.loc.zone === 'deck';
      e.toHandOf(c.uid, owner);
      e.log(owner, `${c.name} is added to the hand`);
      if (fromDeck) ps.deck = e.shuffle(ps.deck);
    },
  };

  const isREBD = (e: E9, m: FieldCard) => e.isNamed(info(e, m), 'Red-Eyes Black Dragon');
  E['Red-Eyes Darkness Dragon'] = {
    cannotNormalSummon: true,
    summonProc: {
      can: (e, _c, p) => e.monsters(p).some((m) => isREBD(e, m)),
      *run(e, c, p) {
        if (!(yield* tributeCost(e, p, 1, (m) => isREBD(e, m)))) return;
        yield* procSummon(e, c, p);
      },
    },
    cannotSpecial: procOnly, // audit-09
    selfBonus: (e, m) => ({ atk: 300 * e.player(ctrl(e, m)).gy.filter((c) => isMonster(e, c) && raceOf(e, c) === 'Dragon').length, def: 0 }),
  };

  E['Red-Eyes Spirit'] = reviveCard('Red-Eyes Spirit: Special Summon which "Red-Eyes" monster?', (e, c) => named(e, c, 'Red-Eyes'), { trap: true });

  E['Reflect Bounder'] = {
    *onBeingAttacked(e, target, attacker, p) {
      if (!target.faceUp || target.pos !== 'atk' || ctrl(e, attacker) === p) return;
      e.log(p, 'Reflect Bounder reflects the attack');
      e.damage(other(p), e.atkOf(attacker));
      tag(target).reflected = e.state.fx.battleNo ?? 0;
    },
    *onAttacked(e, target) {
      if (target.tags?.reflected === (e.state.fx.battleNo ?? 0) && e.fieldCard(target.uid)) yield* e.destroy([target.uid]);
    },
  };

  // Approximation: "sent from your hand to the GY by an opponent's card effect" is caught when that effect discards it.
  E['Regenerating Mummy'] = {
    *onDiscarded(e, card, _owner, byOpponent) {
      if (!byOpponent || e.find(card.uid)?.loc.zone !== 'gy') return;
      e.toHand(card.uid);
      e.log(card.owner, 'Regenerating Mummy returns to the hand');
    },
  };

  E['Reign-Beaux, Overlord of Dark World'] = {
    *onDiscarded(e, card, owner, byOpponent) {
      if (!byOpponent || e.find(card.uid)?.loc.zone !== 'gy' || !freeMZ(e, owner)) return;
      const run = function* (): Step {
        yield* e.specialSummon(card.uid, owner, 'atk');
        if (!e.fieldCard(card.uid)) return;
        const opp = other(owner);
        const opts: string[] = [];
        if (e.monsters(opp).length) opts.push('Destroy all monsters your opponent controls');
        if (stOf(e, opp).length) opts.push('Destroy all Spells/Traps your opponent controls');
        const i = yield* chooseOption(e, owner, 'Reign-Beaux: destroy which?', opts);
        if (i === null) return;
        const uids = opts[i].includes('monsters') ? e.monsters(opp).map((m) => m.uid) : stOf(e, opp).map((c) => c.uid);
        yield* e.destroy(uids);
      };
      yield* e.as(owner, run());
    },
  };

  const isGIK = (e: E9, m: FieldCard) => e.isNamed(info(e, m), 'Gearfried the Iron Knight');
  const swordmasters = (e: E9, p: Pid) => [...e.player(p).hand, ...e.player(p).deck].filter((c) => e.isNamed(info(e, c), 'Gearfried the Swordmaster'));
  E['Release Restraint'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.monsters(p).some((m) => isGIK(e, m)) && swordmasters(e, p).length > 0,
    *activate(e, _link, p) {
      if (!(yield* tributeCost(e, p, 1, (m) => isGIK(e, m)))) return false;
    },
    *resolve(e, _l, p) {
      yield* summonOneOf(e, p, 'Release Restraint: Special Summon which Gearfried the Swordmaster?', swordmasters(e, p));
    },
  };

  E['Rescueroid'] = {
    quick: {
      label: 'return the destroyed "roid" to the hand',
      repeat: true,
      can: (e, _card, p, t, ctx) => {
        if (t !== 'destroyed' || ctx.uid === undefined || ctx.prevController !== p) return false;
        const f = e.find(ctx.uid);
        return !!f && f.loc.zone === 'gy' && named(e, f.card, 'roid');
      },
      *cost(_e, _card, _p, link, ctx) {
        link.targetUid = ctx.uid;
      },
      *run(e, _card, _p, link) {
        const uid = link.targetUid;
        if (uid !== undefined && e.find(uid)?.loc.zone === 'gy') yield* toHandSafe(e, uid);
      },
    },
  };

  E['Resonance Insect'] = {
    *onSentToGrave(e, _card, owner, from) {
      if (from !== 'mz') return;
      const test = (c: Card) => isMonster(e, c) && raceOf(e, c) === 'Insect' && levelOf(e, c) >= 5;
      if (!e.player(owner).deck.some(test) || !(yield* e.yesno(owner, 'Resonance Insect: add a Level 5 or higher Insect from the Deck?'))) return;
      yield* searchDeck(e, owner, 'Resonance Insect: add which Insect?', test);
    },
    // audit-09: "If this card is banished: You can send 1 Insect monster from your Deck to the GY, except Resonance Insect."
    *onBanished(e, card, owner) {
      const test = (c: Card) => isMonster(e, c) && raceOf(e, c) === 'Insect' && !e.sameName(c, card);
      if (!e.player(owner).deck.some(test) || !(yield* e.yesno(owner, 'Resonance Insect: send 1 Insect monster from your Deck to the GY?'))) return;
      yield* deckToGrave(e, owner, 'Resonance Insect: send which Insect?', test);
    },
  };

  const beetleDown = function* (e: E9, m: FieldCard, p: Pid): Step {
    if (!e.oncePerTurn('Reversible Beetle:down', p) || !e.fieldCard(m.uid)) return;
    e.useOnce('Reversible Beetle:down', p);
    for (const x of [m, ...columnOf(e, m)]) if (x.faceUp) setFaceDown(e, x);
  };
  E['Reversible Beetle'] = {
    *flip(e, m, p) {
      if (!e.oncePerTurn('Reversible Beetle:flip', p) || !e.fieldCard(m.uid)) return;
      e.useOnce('Reversible Beetle:flip', p);
      const others = columnOf(e, m).filter((x) => x.faceUp);
      yield* shuffleIn(e, m.uid);
      for (const x of others) if (e.fieldCard(x.uid)) yield* shuffleIn(e, x.uid);
    },
    *onSummon(e, m, p, kind) {
      if (kind === 'normal') yield* beetleDown(e, m, p);
    },
    onSpecialSummon: beetleDown,
  };

  E['Revival Jam'] = {
    *onDestroyed(e, card, p, byBattle) {
      if (!byBattle || e.player(p).lp <= 1000) return;
      if (!(yield* e.yesno(p, 'Revival Jam: pay 1000 LP to Special Summon it during your next Standby Phase?'))) return;
      e.payLp(p, 1000);
      (e.state.fx.revivalJam ??= {})[card.uid] = e.state.turn;
    },
    *onStandbyInGrave(e, card, owner) {
      const map = e.state.fx.revivalJam as Record<number, number> | undefined;
      if (!map || map[card.uid] === undefined || map[card.uid] >= e.state.turn) return;
      delete map[card.uid];
      if (freeMZ(e, owner)) yield* e.specialSummon(card.uid, owner, 'def');
    },
  };

  E['Riryoku Field'] = {
    canActivate: (e, _c, _p, t, ctx) => t === 'spell' && !!ctx.link && isSpell(e, ctx.link.card) && ctx.link.targetUid !== undefined && e.find(ctx.link.targetUid)?.loc.zone === 'mz',
    *activate(_e, link, _p, ctx) {
      link.payload = ctx.link;
    },
    *resolve(e, link, p) {
      const target = link.payload as ChainLink | undefined;
      if (!target) return;
      negateLink(e, target, p);
      if (e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
    },
  };

  E['Rising Energy'] = boostTrap('Rising Energy: which monster gains 1500 ATK?', 1500, 0, false, (e, p) => discardCost(e, p, 1), (e, p) => e.player(p).hand.length > 0);

  // audit-09: its activation and effect are unaffected by Necrovalley (fx.ignoreGraveLock lets the target leave the GY).
  {
    const base = reviveCard('Rite of Spirit: Special Summon which "Gravekeeper\'s" monster?', (e, c) => named(e, c, "Gravekeeper's"), { trap: true });
    E['Rite of Spirit'] = {
      ...base,
      *resolve(e, link, p) {
        e.state.fx.ignoreGraveLock = link.targetUid;
        try {
          yield* base.resolve!(e, link, p);
        } finally {
          e.state.fx.ignoreGraveLock = undefined;
        }
      },
    };
  }

  // Its Normal Summon effect adds a face-up "Zefra" from the Extra Deck, which never happens without Pendulum Summons.
  // audit-09: "You can only Special Summon Ritual Beast Tamer Zefrawendi(s) once per turn."
  E['Ritual Beast Tamer Zefrawendi'] = {
    selfSummonBlock: (e, c, p, how) => how === 'special' && !e.oncePerTurn(`${c.name}:ss`, p),
    *onSpecialSummon(e, m, p) {
      e.useOnce(`${m.name}:ss`, p);
    },
  };

  E['Ritual Weapon'] = h.equipFor((e, m) => info(e, m).sub === 'Ritual' && levelOf(e, m) <= 6, () => ({ atk: 1500, def: 1500 }));

  // group-F: "If your monster inflicts battle damage to your opponent": your attacker (onBattleDamageDealt), or your monster
  // the opponent attacked (its battle damage is seen in damageMod and the mill happens after the battle).
  E["Robbin' Zombie"] = contTrap({
    *onBattleDamageDealt(e, _c, _a, p) {
      yield* e.as(p, millTop(e, other(p), 1));
    },
    damageMod(e, src, p, damaged, _amount, byEffect) {
      const b = e.state.battle;
      if (byEffect || damaged !== other(p) || !b || e.controller(b.attacker) !== damaged || b.target === null || e.controller(b.target) !== p) return undefined;
      tag(src).robbinBattle = e.state.fx.battleNo ?? 0;
      tag(src).robbinLp = e.player(damaged).lp;
      return undefined;
    },
    *afterAnyBattle(e, c, p) {
      if (c.tags?.robbinBattle !== (e.state.fx.battleNo ?? 0) || e.player(other(p)).lp >= (c.tags?.robbinLp ?? 0)) return;
      tag(c).robbinBattle = -1;
      yield* e.as(p, millTop(e, other(p), 1));
    },
  });

  const isRock = (e: E9, c: Card) => isMonster(e, c) && raceOf(e, c) === 'Rock';
  E['Rock Bombardment'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.player(p).deck.some((c) => isRock(e, c)),
    // group-F: sending the Rock monster is the cost, paid when the card is activated.
    *activate(e, _link, p) {
      if (!(yield* deckToGrave(e, p, 'Rock Bombardment: send which Rock monster to the GY?', (c) => isRock(e, c)))) return false;
    },
    *resolve(e, _l, p) {
      e.damage(other(p), 500);
    },
  };

  const ownBP = (e: E9, m: FieldCard) => e.state.phase === 'BP' && e.state.turnPlayer === ctrl(e, m);
  E['Rocket Warrior'] = {
    battleProof: ownBP,
    noBattleDamage: ownBP,
    *afterBattle(e, _a, target) {
      const t = target ? e.fieldCard(target.uid) : null;
      if (t?.faceUp) boostTurn(t, -500);
    },
  };

  E['Rope of Life'] = {
    canActivate: (e, _c, p, t, ctx) => {
      if (t !== 'destroyed' || ctx.uid === undefined || !freeMZ(e, p) || e.player(p).hand.length === 0) return false;
      const f = e.find(ctx.uid);
      return !!f && f.loc.zone === 'gy' && f.loc.player === p;
    },
    *activate(e, link, p, ctx) {
      for (const c of e.player(p).hand.slice()) yield* e.discard(p, c.uid);
      link.targetUid = ctx.uid;
    },
    *resolve(e, link, p) {
      const uid = link.targetUid;
      if (uid === undefined || e.find(uid)?.loc.zone !== 'gy' || !freeMZ(e, p)) return;
      yield* e.specialSummon(uid, p, 'atk');
      const m = e.fieldCard(uid);
      if (m) boostPerm(m, 800);
    },
  };

  E['Roulette Spider'] = {
    canActivate: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null,
    *resolve(e, _l, p) {
      const b = e.state.battle;
      const a = b ? e.fieldCard(b.attacker) : null;
      if (!b || !a) return;
      const r = yield* e.rollDie(p, (v) => v >= 2 && v <= 5);
      e.log(p, `Roulette Spider rolls a ${r}`);
      const opp = other(p);
      if (r === 1) return e.payLp(p, Math.floor(e.player(p).lp / 2));
      if (r === 2) {
        b.target = null;
        return e.log(p, `${a.name} now attacks directly`);
      }
      if (r === 3) {
        const m = yield* pickMine(e, p, 'Roulette Spider: which of your monsters becomes the attack target?', e.monsters(p));
        if (m) b.target = m.uid;
        return;
      }
      if (r === 4) {
        const d = yield* pickOne(e, p, 'Roulette Spider: which other opponent monster becomes the attack target?', e.monsters(opp).filter((x) => x.uid !== a.uid));
        if (!d) return;
        // Damage calculation between the two opponent monsters; the opponent takes any battle damage.
        if (!d.faceUp) d.faceUp = true;
        const atk = e.atkOf(a);
        const dead: number[] = [];
        if (d.pos === 'atk') {
          const v = e.atkOf(d);
          if (atk > v) dead.push(d.uid);
          else if (atk < v) dead.push(a.uid);
          else if (atk > 0) dead.push(d.uid, a.uid);
          e.damage(opp, Math.abs(atk - v));
        } else {
          const v = e.defOf(d);
          if (atk > v) dead.push(d.uid);
          else if (atk < v) e.damage(opp, v - atk);
        }
        e.endBattle();
        if (e.state.winner === null && dead.length) yield* e.destroy(dead, 'destroyed', true);
        return;
      }
      if (r === 5) {
        e.endBattle();
        e.damage(opp, e.atkOf(a));
        return;
      }
      yield* e.destroy([a.uid]);
    },
  };

  E['Royal Firestorm Guards'] = {
    *onSummon(e, _m, p, kind) {
      if (kind !== 'normal') return;
      const pyros = e.player(p).gy.filter((c) => isMonster(e, c) && raceOf(e, c) === 'Pyro');
      if (pyros.length < 4) return;
      const chosen = yield* pick(e, p, 'Royal Firestorm Guards: shuffle which 4 Pyro monsters into the Deck?', pyros, 4, 4);
      if (!chosen || chosen.length < 4) return;
      for (const c of chosen) yield* shuffleIn(e, c.uid);
      e.draw(p, 2);
    },
  };

  const wsRace = (e: E9, m: FieldCard) => ['Warrior', 'Spellcaster'].includes(raceOf(e, m));
  E['Ryu Kokki'] = {
    *afterBattle(e, _a, target) {
      const t = target ? e.fieldCard(target.uid) : null;
      if (t && wsRace(e, t)) yield* e.destroy([t.uid]);
    },
    *onAttacked(e, _t, attacker) {
      const a = e.fieldCard(attacker.uid);
      if (a && wsRace(e, a)) yield* e.destroy([a.uid]);
    },
  };

  E['Ryu Senshi'] = {
    quick: {
      label: 'negate it',
      repeat: true,
      can: (e, _card, p, t, ctx) => {
        const l = ctx.link;
        return !!l && t === 'trap' && isTrap(e, l.card) && info(e, l.card).sub === 'Normal' && e.player(p).lp > 1000;
      },
      *cost(e, _card, p) {
        if (!payLp(e, p, 1000)) return false;
      },
      *run(e, card, p, link) {
        if (!e.fieldCard(card.uid)?.faceUp) return;
        const target = (link.payload as { ctx?: ChainCtx }).ctx?.link;
        if (target) negateLink(e, target, p);
      },
    },
    // audit-09: "Negate the effects of any Spell Card that targets this card and destroy it" is mandatory, applied as the Spell resolves.
    *onChainLink(e, m, p, link) {
      if ((link.payload as { effect?: string } | undefined)?.effect || !isSpell(e, link.card) || link.targetUid !== m.uid) return;
      e.log(p, `${m.name} negates ${link.card.name}`);
      link.negated = true;
      if (e.fieldCard(link.card.uid)) yield* e.destroy([link.card.uid]);
    },
  };

  const clown = function* (e: E9, m: FieldCard, p: Pid): Step {
    const t = yield* pickOne(e, p, `${m.name}: change the battle position of which monster?`, faceUpMonsters(e));
    if (t && e.fieldCard(t.uid)?.faceUp) togglePos(e, t);
  };
  E['Ryu-Kishin Clown'] = { onSummon: clown, onSpecialSummon: clown };

  // ---------- S ----------
  const spyralGy = (e: E9, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && named(e, c, 'SPYRAL') && !isExtraOrRitual(e, c));
  E['SPYRAL GEAR - Big Red'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p) && freeMZ(e, p) && spyralGy(e, p).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'SPYRAL GEAR - Big Red: Special Summon which "SPYRAL" monster?', spyralGy(e, p), true);
      if (!c) return false;
      e.useOnce(link.card.name, p);
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      const fc = e.fieldCard(link.card.uid);
      const uid = link.targetUid;
      if (!fc || uid === undefined || e.find(uid)?.loc.zone !== 'gy' || !freeMZ(e, p)) return;
      yield* e.specialSummon(uid, p, 'atk');
      if (e.fieldCard(uid) && e.fieldCard(fc.uid)) h.attachTo(e, fc, uid);
    },
    shields: (_e, src, target, how) => how === 'battle' && src.equippedTo === target.uid,
  };

  const droneLook = function* (e: E9, _m: FieldCard, p: Pid): Step {
    const deck = e.player(other(p)).deck;
    if (!deck.length || !(yield* e.yesno(p, "SPYRAL GEAR - Drone: look at the top 3 cards of your opponent's Deck?"))) return;
    let rest = deck.slice(0, 3);
    const ordered: Card[] = [];
    while (rest.length > 1) {
      const c = yield* pickOne(e, p, `Drone: which card goes ${ordered.length ? 'next' : 'on top'}?`, rest);
      if (!c) break;
      ordered.push(c);
      rest = rest.filter((x) => x.uid !== c.uid);
    }
    const top = [...ordered, ...rest];
    const ps = e.player(other(p));
    ps.deck = [...top, ...ps.deck.filter((c) => !top.some((x) => x.uid === c.uid))];
    e.log(p, `${e.player(p).name} rearranges the top of the opponent's Deck`);
  };
  const spyralOwn = (e: E9, p: Pid, except: number) => targetable(e, faceUpMonsters(e, p)).filter((m) => m.uid !== except && named(e, m, 'SPYRAL'));
  E['SPYRAL GEAR - Drone'] = {
    *onSummon(e, m, p, kind) {
      if (kind === 'normal') yield* droneLook(e, m, p);
    },
    onSpecialSummon: droneLook,
    quick: {
      label: 'Tribute it to power up a "SPYRAL" monster',
      can: (e, card, p) => spyralOwn(e, p, card.uid).length > 0,
      *cost(e, card, p, link) {
        const t = yield* pickOne(e, p, 'SPYRAL GEAR - Drone: target which "SPYRAL" monster?', spyralOwn(e, p, card.uid), true);
        if (!t) return false;
        link.targetUid = t.uid;
        yield* e.sendToGrave(card.uid, 'tribute');
      },
      *run(e, _card, p, link) {
        const m = fieldOrNull(e, link.targetUid);
        if (!m?.faceUp) return;
        const opp = other(p);
        const n = e.monsters(opp).length + stOf(e, opp).length;
        boostPerm(m, 500 * n);
      },
    },
    graveIgnition: {
      can: (e, card, p) => e.player(p).gy.some((c) => c.uid !== card.uid && named(e, c, 'SPYRAL')) && e.player(p).gy.some((c) => e.isNamed(c, 'SPYRAL Super Agent')),
      *run(e, card, p) {
        const agent = yield* pickOne(e, p, 'Add which SPYRAL Super Agent?', e.player(p).gy.filter((c) => e.isNamed(c, 'SPYRAL Super Agent')), true);
        if (!agent) return;
        const extra = yield* pickOne(e, p, 'Banish which other "SPYRAL" card?', e.player(p).gy.filter((c) => c.uid !== card.uid && c.uid !== agent.uid && named(e, c, 'SPYRAL')), true);
        if (!extra) return;
        e.banish(card.uid);
        e.banish(extra.uid);
        if (e.find(agent.uid)?.loc.zone === 'gy') e.toHandOf(agent.uid, p);
      },
    },
  };

  E['SPYRAL MISSION - Assault'] = contSpell({
    *onEndPhase(e, fc, p) {
      if (e.state.turnPlayer !== p) return;
      tag(fc).eps = (fc.tags?.eps ?? 0) + 1;
      if (fc.tags!.eps >= 3) yield* e.destroy([fc.uid]);
    },
    // Battle half: offered in the "destroyed by battle" window. Once per turn (shared with the effect half below).
    quick: {
      label: 'draw 1 card',
      can: (e, card, p, t, ctx) => {
        const b = e.state.battle;
        const a = b ? e.fieldCard(b.attacker) : null;
        return t === 'destroyed' && e.oncePerTurn(`SPYRAL Assault:${card.uid}`, p) && ctx.prevController === other(p) && !!a && ctrl(e, a) === p && named(e, a, 'SPYRAL') && e.player(p).deck.length > 0;
      },
      *cost(e, card, p) {
        e.useOnce(`SPYRAL Assault:${card.uid}`, p);
      },
      *run(e, _card, p) {
        e.draw(p, 1);
      },
    },
    // audit-09: effect half: the resolving effect of a "SPYRAL" monster you control destroys a card on the field: you can draw 1.
    *onAnyToGrave(e, fc, p, events) {
      if (!e.oncePerTurn(`SPYRAL Assault:${fc.uid}`, p) || !e.player(p).deck.length) return;
      const src = e.resolvingCard();
      const srcOk = !!src && isMonster(e, src) && named(e, src, 'SPYRAL') && e.controller(src.uid) === p;
      const byEffect = srcOk && events.some((x) => !x.byBattle && x.reason === 'destroyed' && ['mz', 'sz', 'field'].includes(x.from) && x.by === p);
      if (!byEffect) return;
      if (!(yield* e.yesno(p, 'SPYRAL MISSION - Assault: draw 1 card?'))) return;
      e.useOnce(`SPYRAL Assault:${fc.uid}`, p);
      e.draw(p, 1);
    },
    graveIgnition: {
      can: (e, _c, p) => freeMZ(e, p) && e.player(p).hand.some((c) => isMonster(e, c) && named(e, c, 'SPYRAL')),
      *run(e, card, p) {
        const list = e.player(p).hand.filter((c) => isMonster(e, c) && named(e, c, 'SPYRAL'));
        const c = yield* pickOne(e, p, 'SPYRAL MISSION - Assault: Special Summon which "SPYRAL" monster?', list, true);
        if (!c) return;
        e.banish(card.uid);
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
  });

  E['SPYRAL Resort'] = contSpell({
    shields: (e, src, target, how, srcCtl) => how === 'target' && target.uid !== src.uid && named(e, target, 'SPYRAL') && ctrl(e, target) === srcCtl && e.actor === other(srcCtl),
    ignition: {
      repeat: true,
      can: (e, m, p) => e.oncePerTurn(`SPYRAL Resort:${m.uid}`, p) && e.player(p).deck.some((c) => isMonster(e, c) && named(e, c, 'SPYRAL')),
      *run(e, m, p) {
        e.useOnce(`SPYRAL Resort:${m.uid}`, p);
        yield* searchDeck(e, p, 'SPYRAL Resort: add which "SPYRAL" monster?', (c) => isMonster(e, c) && named(e, c, 'SPYRAL'));
      },
    },
    // audit-09: the upkeep is paid in your End Phase (Speed Duel runs Field Spells' End Phase effects).
    *onEndPhase(e, fc, p) {
      if (e.state.turnPlayer !== p) return;
      const mons = e.player(p).gy.filter((c) => isMonster(e, c));
      const c = mons.length ? yield* pickOne(e, p, 'SPYRAL Resort: shuffle which monster from your GY into the Deck? (Cancel destroys SPYRAL Resort)', mons, true) : null;
      if (c) yield* shuffleIn(e, c.uid);
      else yield* e.destroy([fc.uid]);
    },
  });

  const fusionSpell = (e: E9, c: Card) => isSpell(e, c) && (named(e, c, 'Polymerization') || named(e, c, 'Fusion'));
  E['Sabatiel - The Philosopher\'s Stone'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).lp >= 2 && e.player(p).gy.some((c) => isMonster(e, c) && named(e, c, 'Winged Kuriboh')) && e.player(p).deck.some((c) => fusionSpell(e, c)),
    *activate(e, _link, p) {
      e.payLp(p, Math.floor(e.player(p).lp / 2));
    },
    *resolve(e, _l, p) {
      yield* searchDeck(e, p, 'Sabatiel: add which Polymerization/Fusion Spell?', (c) => fusionSpell(e, c));
    },
    graveIgnition: {
      can: (e, card, p) => e.player(p).gy.filter((c) => e.sameName(c, card)).length >= 3 && targetable(e, faceUpMonsters(e)).length > 0,
      *run(e, card, p) {
        const t = yield* pickOne(e, p, 'Sabatiel: which monster gains ATK?', targetable(e, faceUpMonsters(e)), true);
        if (!t) return;
        const copies = [card, ...e.player(p).gy.filter((c) => e.sameName(c, card) && c.uid !== card.uid).slice(0, 2)];
        if (copies.length < 3) return;
        for (const c of copies) e.banish(c.uid);
        const best = Math.max(0, ...faceUpMonsters(e).map((m) => e.atkOf(m)));
        if (e.fieldCard(t.uid)?.faceUp) boostTurn(t, best);
      },
    },
  };

  const dmSources = (e: E9, p: Pid) => [...e.player(p).hand, ...e.player(p).deck].filter((c) => e.isNamed(info(e, c), 'Dark Magician'));
  E["Sage's Stone"] = {
    canActivate: (e, _c, p, t) => isMain(t) && freeMZ(e, p) && faceUpMonsters(e, p).some((m) => e.isNamed(info(e, m), 'Dark Magician Girl')) && dmSources(e, p).length > 0,
    *resolve(e, _l, p) {
      if (!faceUpMonsters(e, p).some((m) => e.isNamed(info(e, m), 'Dark Magician Girl'))) return;
      yield* summonOneOf(e, p, "Sage's Stone: Special Summon which Dark Magician?", dmSources(e, p));
    },
  };

  E['Salvage'] = twoToHand('Salvage: add which 2 WATER monsters?', (e, c) => attrOfC(e, c) === 'WATER' && (info(e, c).atk ?? 0) <= 1500);

  E['Sand Moth'] = {
    *onLeaveField(e, fc, _c, reason) {
      if (reason === 'destroyed' && !fc.faceUp && fc.pos === 'def') (e.state.fx.sandMoth ??= {})[fc.uid] = e.state.turn;
    },
    *onDestroyed(e, card, _p, byBattle) {
      const map = e.state.fx.sandMoth as Record<number, number> | undefined;
      const mark = map?.[card.uid];
      if (map) delete map[card.uid];
      if (byBattle || mark !== e.state.turn || !freeMZ(e, card.owner) || e.find(card.uid)?.loc.zone !== 'gy') return;
      yield* e.specialSummon(card.uid, card.owner, 'atk');
      const m = e.fieldCard(card.uid);
      if (m) tag(m).swapped = 1;
    },
    baseStats: (e, m) => {
      if (!m.tags?.swapped) return undefined;
      const i = info(e, m);
      return { atk: i.def ?? 0, def: i.atk ?? 0 };
    },
  };

  E['Santa Claws'] = {
    summonProc: {
      can: (e, _c, p) => e.monsters(other(p)).length > 0,
      *run(e, c, p) {
        const t = yield* pickOne(e, p, "Santa Claws: Tribute which of your opponent's monsters?", e.monsters(other(p)), true);
        if (!t) return;
        e.log(p, `${e.player(p).name} Tributes ${label(t)}`);
        yield* e.sendToGrave(t.uid, 'tribute');
        if (!freeMZ(e, other(p))) return;
        yield* e.specialSummon(c.uid, other(p), 'def');
        const m = e.fieldCard(c.uid);
        if (m) {
          tag(m).santaBy = p + 1;
          tag(m).santaTurn = e.state.turn;
        }
      },
    },
    *onEndPhase(e, m) {
      const by = (m.tags?.santaBy ?? 0) - 1;
      if (by < 0 || m.tags?.santaTurn !== e.state.turn) return;
      tag(m).santaBy = 0;
      if (e.player(by as Pid).deck.length && (yield* e.yesno(by as Pid, 'Santa Claws: draw 1 card?'))) e.draw(by as Pid, 1);
    },
  };

  // audit-09: mandatory, at the start of the Damage Step (before the face-down monster is flipped, so its FLIP effect never activates).
  E['Sasuke Samurai'] = {
    *startDamageStep(e, _a, target, p) {
      if (target.faceUp || target.pos !== 'def' || !e.fieldCard(target.uid)) return;
      e.log(p, 'Sasuke Samurai destroys the face-down monster');
      yield* e.destroy([target.uid]);
    },
  };

  E['Satellarknight Zefrathuban'] = {
    *onSummon(e, m, p) {
      if (!e.oncePerTurn(m.name, p)) return;
      const mine = e.monsters(p).filter((x) => x.uid !== m.uid && (named(e, x, 'tellarknight') || named(e, x, 'Zefra')));
      const theirs = targetable(e, [...faceUpMonsters(e, other(p)), ...stOf(e, other(p)).filter((c) => c.faceUp)]);
      if (!mine.length || !theirs.length || !(yield* e.yesno(p, 'Satellarknight Zefrathuban: destroy 1 of your "tellarknight"/"Zefra" cards and 1 face-up opponent card?'))) return;
      const a = yield* pickMine(e, p, 'Destroy which of your cards?', mine, true);
      if (!a) return;
      const b = yield* pickOne(e, p, "Destroy which of your opponent's cards?", theirs, true);
      if (!b) return;
      e.useOnce(m.name, p);
      yield* e.destroy([a.uid, b.uid].filter((u) => e.fieldCard(u)));
    },
  };

  const scrumOn = (e: E9, p: Pid) => e.monsters(p).filter((m) => m.faceUp && m.pos === 'def').length >= 2;
  E['Scrum Force'] = contTrap({
    shields: (e, src, target, how, srcCtl) => how !== 'battle' && target.uid !== src.uid && e.find(target.uid)?.loc.zone === 'mz' && target.pos === 'def' && ctrl(e, target) === srcCtl && e.actor === other(srcCtl) && scrumOn(e, srcCtl),
    // "If this card would be destroyed by card effect, you can destroy 1 card in your Spell & Trap Zone instead" (always used).
    effectProof(e, m) {
      if (!m.active || e.find(m.uid)?.loc.zone !== 'sz') return false;
      const p = ctrl(e, m);
      const sub = e.spells(p).find((c) => c.uid !== m.uid);
      if (!sub) return false;
      e.log(p, `${sub.faceUp ? sub.name : 'A Set card'} is destroyed instead of Scrum Force`);
      const g = e.sendToGrave(sub.uid, 'destroyed');
      for (let r = g.next(undefined as never); !r.done; r = g.next(false)) {
        /* drained */
      }
      return true;
    },
  });

  E['Sea Koala'] = {
    ignition: {
      can: (e, m, p) => faceUpMonsters(e, p).some((x) => x.uid !== m.uid && raceOf(e, x) === 'Beast') && targetable(e, e.monsters(other(p))).length > 0,
      *run(e, m, p) {
        if (!faceUpMonsters(e, p).some((x) => x.uid !== m.uid && raceOf(e, x) === 'Beast')) return;
        const t = yield* pickOne(e, p, "Sea Koala: which opponent's monster's ATK becomes 0?", targetable(e, e.monsters(other(p))));
        if (!t || !faceUpMonsters(e, p).some((x) => x.uid !== m.uid && raceOf(e, x) === 'Beast')) return;
        boostTurn(t, -e.atkOf(t));
      },
    },
  };

  E['Sealing Ceremony of Mokuton'] = contTrap({
    ignition: {
      repeat: true,
      can: (e, c, p) => e.oncePerTurn(`Mokuton:${c.uid}`, p) && faceUpMonsters(e, p).some((m) => attrOfC(e, m) === 'EARTH') && e.player(other(p)).gy.length > 0,
      *run(e, c, p) {
        if (!(yield* tributeCost(e, p, 1, (m) => m.faceUp && attrOfC(e, m) === 'EARTH'))) return;
        e.useOnce(`Mokuton:${c.uid}`, p);
        const r = yield* pick(e, p, 'Sealing Ceremony of Mokuton: banish up to 2 cards from the opponent\'s GY', e.player(other(p)).gy, 1, 2);
        for (const x of r ?? []) e.banish(x.uid);
      },
    },
  });

  E['Sealing Ceremony of Suiton'] = contTrap({
    ignition: {
      repeat: true,
      can: (e, c, p) => e.oncePerTurn(`Suiton:${c.uid}`, p) && e.player(p).hand.some((x) => isMonster(e, x) && attrOfC(e, x) === 'WATER') && e.player(other(p)).gy.length > 0,
      *run(e, c, p) {
        const w = yield* pickOne(e, p, 'Sealing Ceremony of Suiton: send which WATER monster from your hand?', e.player(p).hand.filter((x) => isMonster(e, x) && attrOfC(e, x) === 'WATER'), true);
        if (!w) return;
        const t = yield* pickOne(e, p, "Banish which card from your opponent's GY?", e.player(other(p)).gy, true);
        if (!t) return;
        e.useOnce(`Suiton:${c.uid}`, p);
        yield* e.sendToGrave(w.uid, 'cost');
        if (e.find(t.uid)?.loc.zone === 'gy') e.banish(t.uid);
      },
    },
  });

  E['Security Orb'] = {
    canActivate: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null,
    *activate(e, link) {
      link.targetUid = e.state.battle?.attacker;
    },
    *resolve(e, link) {
      const m = fieldOrNull(e, link.targetUid);
      if (m?.faceUp) togglePos(e, m);
    },
    // Set card destroyed by the opponent's effect: destroy 1 monster.
    *onLeaveField(e, fc, controller, reason) {
      // audit-09: only the opponent's Spell/Trap effects.
      const kind = e.resolvingKind();
      if (fc.faceUp || reason !== 'destroyed' || e.actor !== other(controller) || (kind !== 'spell' && kind !== 'trap')) return;
      const t = yield* pickOne(e, controller, 'Security Orb: destroy which monster?', allMonsters(e));
      if (t && e.fieldCard(t.uid)) yield* e.as(controller, e.destroy([t.uid]));
    },
  };

  E['Shadowknight Archfiend'] = {
    *onStandby(e, m, p) {
      if (e.state.turnPlayer !== p) return;
      if (e.player(p).lp > 900) e.payLp(p, 900);
      else yield* e.destroy([m.uid]);
    },
    // audit-09: the battle damage this card inflicts to the opponent is halved (whether it attacks or is attacked).
    damageMod: (e, m, p, damaged, amount, byEffect) => (!byEffect && damaged === other(p) && inBattle(e, m) ? Math.floor(amount / 2) : undefined),
    // audit-09: an opponent's effect that targets it: roll a die as it resolves; on a 3, negate it and destroy that card.
    onChainLink: dieGuard('Shadowknight Archfiend', [3]),
  };

  E['Shard of Greed'] = contSpell({
    // audit-09: a Greed Counter for each of your normal draws in the Draw Phase.
    *onDrawPhase(e, fc) {
      fc.counters++;
      e.log(null, `A Greed Counter is placed on ${fc.name} (${fc.counters})`);
    },
    ignition: {
      repeat: true,
      can: (e, c, p) => c.counters >= 2 && e.player(p).deck.length >= 2,
      *run(e, c, p) {
        yield* e.sendToGrave(c.uid, 'cost');
        e.draw(p, 2);
      },
    },
  });

  E['Shield Crush'] = destroyTarget('Shield Crush: destroy which Defense Position monster?', (e) => targetable(e, allMonsters(e).filter((m) => m.pos === 'def')));

  E['Shield Spear'] = boostTrap('Shield Spear: which monster gains 400 ATK/DEF?', 400, 400);

  // audit-09: Spirit monsters by their text ("... Normal Summoned or flipped face-up ...: Return it to the hand").
  const isSpirit = (e: E9, c: Card) => /Normal Summoned or flipped face-up/.test(info(e, c).desc) && /hand/.test(info(e, c).desc);
  E['Shinobird Pigeon'] = {
    cannotSpecialSummon: true, // audit-09
    *onSummon(e, m) {
      tag(m).spiritTurn = e.state.turn;
    },
    *onEndPhase(e, m) {
      if (m.tags?.spiritTurn === e.state.turn && e.fieldCard(m.uid)) yield* toHandSafe(e, m.uid);
    },
    ignition: {
      can: (e, m) => targetable(e, faceUpMonsters(e)).some((x) => x.uid !== m.uid && isSpirit(e, x)),
      *run(e, m, p) {
        const t = yield* pickOne(e, p, 'Shinobird Pigeon: return which Spirit monster to the hand?', targetable(e, faceUpMonsters(e)).filter((x) => x.uid !== m.uid && isSpirit(e, x)));
        if (t) yield* toHandSafe(e, t.uid);
      },
    },
  };

  // Approximation: reacts to its controller changing its battle position (card effects that change it do not report it).
  E['Shore Knight'] = {
    *onPositionChange(e, m, p) {
      if (!m.faceUp || !e.oncePerTurn(`Shore Knight:${m.uid}`, p)) return;
      const test = (c: Card) => isMonster(e, c) && attrOfC(e, c) === 'WATER';
      if (!e.player(p).deck.some(test)) return;
      e.useOnce(`Shore Knight:${m.uid}`, p);
      yield* deckToGrave(e, p, 'Shore Knight: send which WATER monster to the GY?', test);
    },
  };

  E['Shrink'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && targetable(e, faceUpMonsters(e)).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Shrink: halve which monster\'s original ATK?', targetable(e, faceUpMonsters(e)), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const m = fieldOrNull(e, link.targetUid);
      if (m?.faceUp) boostTurn(m, -Math.floor(e.baseStats(m).atk / 2));
    },
  };

  E['Silent Doom'] = reviveCard('Silent Doom: Special Summon which Normal Monster?', (e, c) => isNormalMonster(e, c), {
    pos: 'def',
    after: (_e, m) => {
      m.cannotAttack = true;
    },
  });

  const successorTargets = (e: E9, p: Pid) => targetable(e, faceUpMonsters(e, p));
  const successorReady = (e: E9, card: Card, p: Pid) => e.state.fx.successorSent?.[card.uid] !== e.state.turn && e.state.turnPlayer === p && successorTargets(e, p).length > 0;
  E['Skill Successor'] = {
    ...boostTrap('Skill Successor: which of your monsters gains 400 ATK?', 400, 0, true),
    *onSentToGrave(e, card) {
      (e.state.fx.successorSent ??= {})[card.uid] = e.state.turn;
    },
    graveIgnition: {
      can: successorReady,
      *run(e, card, p) {
        const t = yield* pickOne(e, p, 'Skill Successor: which monster gains 800 ATK?', successorTargets(e, p), true);
        if (!t) return;
        e.banish(card.uid);
        boostTurn(t, 800);
      },
    },
    quick: {
      from: 'gy',
      label: 'banish it: a monster gains 800 ATK',
      can: (e, card, p) => successorReady(e, card, p),
      *cost(e, card, p, link) {
        const t = yield* pickOne(e, p, 'Skill Successor: which monster gains 800 ATK?', successorTargets(e, p), true);
        if (!t) return false;
        e.banish(card.uid);
        link.targetUid = t.uid;
      },
      *run(e, _card, _p, link) {
        const m = fieldOrNull(e, link.targetUid);
        if (m?.faceUp) boostTurn(m, 800);
      },
    },
  };

  const lname = (e: E9, c: Card) => info(e, c).name.toLowerCase();
  E['Skilled Blue Magician'] = skilled('Skilled Blue Magician: Special Summon which "Gaia The Fierce Knight" monster?', (e, c) => lname(e, c).includes('gaia the fierce knight'), true);
  E['Skilled Dark Magician'] = skilled('Skilled Dark Magician: Special Summon which Dark Magician?', (e, c) => e.isNamed(info(e, c), 'Dark Magician'), false);
  E['Skilled Red Magician'] = skilled('Skilled Red Magician: Special Summon which "Archfiend" monster?', (e, c) => named(e, c, 'Archfiend'), true);
  E['Skilled White Magician'] = skilled('Skilled White Magician: Special Summon which Buster Blader?', (e, c) => e.isNamed(info(e, c), 'Buster Blader'), false);

  const water = (e: E9, c: Card) => isMonster(e, c) && attrOfC(e, c) === 'WATER';
  E['Skreech'] = {
    *onDestroyed(e, _card, p, byBattle) {
      if (!byBattle) return;
      for (let i = 0; i < 2; i++) if (!(yield* deckToGrave(e, p, 'Skreech: send which WATER monster to the GY?', (c) => water(e, c)))) return;
    },
  };

  E['Skull Archfiend of Lightning'] = {
    *onStandby(e, m, p) {
      if (e.state.turnPlayer !== p) return;
      if (e.player(p).lp > 500) e.payLp(p, 500);
      else yield* e.destroy([m.uid]);
    },
    // audit-09: before an opponent's effect that targets it resolves: roll a die; on 1, 3 or 6 negate it and destroy that card.
    onChainLink: dieGuard('Skull Archfiend of Lightning', [1, 3, 6]),
  };

  E['Skyscraper'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    aura: (e, _src, target) => {
      const b = e.state.battle;
      if (!b || b.attacker !== target.uid || b.target === null || skyscraperGuard || !named(e, target, 'Elemental HERO')) return undefined;
      const d = e.fieldCard(b.target);
      if (!d) return undefined;
      skyscraperGuard = true;
      try {
        return e.atkOf(d) > e.atkOf(target) ? { atk: 1000, def: 0 } : undefined;
      } finally {
        skyscraperGuard = false;
      }
    },
  };

  // audit-09: the engine records every card in a GY that got there by being destroyed by battle (fx.battleDead).
  const heroDeadInBattle = (e: E9, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && named(e, c, 'Elemental HERO') && !isExtraOrRitual(e, c) && !!e.state.fx.battleDead?.[c.uid]);
  E['Skyscraper 2 - Hero City'] = contSpell({
    ignition: {
      repeat: true,
      can: (e, c, p) => e.oncePerTurn(`Hero City:${c.uid}`, p) && freeMZ(e, p) && heroDeadInBattle(e, p).length > 0,
      *run(e, c, p) {
        const t = yield* pickOne(e, p, 'Skyscraper 2: Special Summon which "Elemental HERO"?', heroDeadInBattle(e, p), true);
        if (!t) return;
        e.useOnce(`Hero City:${c.uid}`, p);
        yield* e.specialSummon(t.uid, p, 'atk');
      },
    },
  });

  const slushyCount = (e: E9, p: Pid) => [...e.player(p).gy, ...e.player(p).removed].filter((c) => e.isNamed(c, 'Slushy')).length;
  const bigSerpents = (e: E9, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && raceOf(e, c) === 'Sea Serpent' && levelOf(e, c) >= 5 && !isExtraOrRitual(e, c));
  E['Slushy'] = {
    *onSummon(e, _m, p, kind) {
      if (kind !== 'normal' || !e.player(p).deck.some((c) => e.isNamed(c, 'Slushy')) || !(yield* e.yesno(p, 'Slushy: send 1 "Slushy" from the Deck to the GY?'))) return;
      yield* deckToGrave(e, p, 'Send which Slushy?', (c) => e.isNamed(c, 'Slushy'));
    },
    graveIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Slushy', p) && slushyCount(e, p) >= 3 && freeMZ(e, p) && bigSerpents(e, p).length > 0,
      *run(e, card, p) {
        const t = yield* pickOne(e, p, 'Slushy: Special Summon which Sea Serpent?', bigSerpents(e, p), true);
        if (!t) return;
        e.useOnce('Slushy', p);
        e.banish(card.uid);
        yield* e.specialSummon(t.uid, p, 'atk');
      },
    },
  };

  const venoms = (e: E9, p: Pid) => e.player(p).hand.filter((c) => isMonster(e, c) && named(e, c, 'Venom'));
  E["Snake Deity's Command"] = {
    canActivate: (e, _c, p, t, ctx) => t === 'spell' && !!ctx.link && ctx.link.player !== p && isSpell(e, ctx.link.card) && venoms(e, p).length > 0,
    *activate(e, link, p, ctx) {
      const v = yield* pickOne(e, p, 'Show which "Venom" monster?', venoms(e, p), true);
      if (!v) return false;
      yield* e.reveal(other(p), "Snake Deity's Command: your opponent shows", [v]);
      link.payload = ctx.link;
    },
    *resolve(e, link, p) {
      const target = link.payload as ChainLink | undefined;
      if (!target) return;
      negateLink(e, target, p);
      if (e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
    },
  };

  const reptiles = (e: E9, p: Pid) => e.player(p).deck.filter((c) => isMonster(e, c) && raceOf(e, c) === 'Reptile');
  E['Snake Rain'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.player(p).hand.some((x) => x.uid !== c.uid) && reptiles(e, p).length >= 4,
    *activate(e, _link, p) {
      if (!(yield* discardCost(e, p, 1))) return false;
    },
    *resolve(e, _l, p) {
      const list = reptiles(e, p);
      const n = Math.min(4, list.length);
      const r = yield* pick(e, p, `Snake Rain: send ${n} Reptile monsters to the GY`, list, n, n);
      for (const c of r ?? []) yield* e.sendToGrave(c.uid, 'mill');
      e.player(p).deck = e.shuffle(e.player(p).deck);
    },
  };

  E['Solemn Wishes'] = contTrap({
    // audit-09: the normal draw (onDrawPhase) and every other draw (onDraw).
    *onDrawPhase(e, _fc, p) {
      e.gainLp(p, 500);
    },
    onDraw(e, _c, p, drawer) {
      if (drawer === p) e.gainLp(p, 500);
    },
  });

  E['Solitary Sword of Poison'] = {
    canActivate: (e, c, p, t) => isMain(t) && !e.activeSpells(p).some((x) => e.sameName(x, c) && x.uid !== c.uid) && targetable(e, faceUpMonsters(e, p)).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Solitary Sword of Poison: equip to which of your monsters?', targetable(e, faceUpMonsters(e, p)), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = fieldOrNull(e, link.targetUid);
      const fc = e.fieldCard(link.card.uid);
      if (!m?.faceUp || !fc || ctrl(e, m) !== p) return;
      h.attachTo(e, fc, m.uid);
      if (e.monsters(p).some((x) => x.uid !== m.uid)) yield* e.sendToGrave(fc.uid, 'used');
    },
    equipBonus: (e, _eq, host) => {
      const b = e.state.battle;
      const foeUid = !b || b.target === null ? null : b.attacker === host.uid ? b.target : b.target === host.uid ? b.attacker : null;
      const foe = foeUid !== null ? e.fieldCard(foeUid) : null;
      if (!foe || e.controller(foe.uid) === e.controller(host.uid)) return { atk: 0, def: 0 };
      return e.baseStats(host);
    },
    // audit-09: checked after every action, so it also catches a monster gained by a change of control.
    *stateCheck(e, w, wp) {
      if (w.equippedTo === undefined || !e.monsters(wp).some((x) => x.uid !== w.equippedTo)) return;
      e.log(wp, `${w.name} is sent to the GY`);
      yield* e.sendToGrave(w.uid, 'used');
    },
  };

  E['Sonic Shooter'] = {
    directAttack: (e, _m, p) => e.spells(other(p)).length === 0,
    attackBonus: originalDirect,
  };

  E['Soul Demolition'] = contTrap({
    ignition: {
      repeat: true,
      can: (e, _c, p) => faceUpMonsters(e, p).some((m) => raceOf(e, m) === 'Fiend') && e.player(p).lp > 500 && [...e.player(0).gy, ...e.player(1).gy].some((c) => isMonster(e, c)),
      *run(e, _c, p) {
        if (!payLp(e, p, 500)) return;
        for (const q of [p, other(p)]) {
          const list = monstersIn(e, e.player(other(q)).gy);
          const c = yield* pickOne(e, q, "Soul Demolition: banish which monster from your opponent's GY?", list);
          if (c) e.banish(c.uid);
        }
      },
    },
  });

  // ---- Spacetime Transcendence: banished Levels must add up to the summoned Dinosaur's Level ----
  const dinoGy = (e: E9, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && raceOf(e, c) === 'Dinosaur');
  const sumsTo = (levels: number[], target: number) => {
    // reachable[s] = max count (capped at 2) of a subset with sum s
    const reach = new Map<number, number>([[0, 0]]);
    for (const l of levels) for (const [s, n] of [...reach]) reach.set(s + l, Math.max(reach.get(s + l) ?? 0, Math.min(2, n + 1)));
    return (reach.get(target) ?? 0) >= 2;
  };
  const stTargets = (e: E9, p: Pid) =>
    [...e.player(p).hand, ...e.player(p).gy].filter((c) => isMonster(e, c) && raceOf(e, c) === 'Dinosaur' && !isExtraOrRitual(e, c) && sumsTo(dinoGy(e, p).filter((g) => g.uid !== c.uid).map((g) => levelOf(e, g)), levelOf(e, c)));
  E['Spacetime Transcendence'] = {
    canActivate: (e, _c, p, t) => isMain(t) && freeMZ(e, p) && stTargets(e, p).length > 0,
    *activate(e, link, p) {
      const t = yield* pickOne(e, p, 'Spacetime Transcendence: Special Summon which Dinosaur?', stTargets(e, p), true);
      if (!t) return false;
      const want = levelOf(e, t);
      const pool = dinoGy(e, p).filter((g) => g.uid !== t.uid);
      for (let tries = 0; tries < 3; tries++) {
        const r = yield* pick(e, p, `Banish Dinosaurs whose Levels total ${want}`, pool, 2, pool.length, true);
        if (!r) return false;
        if (r.reduce((a, c) => a + levelOf(e, c), 0) === want) {
          for (const c of r) e.banish(c.uid);
          link.targetUid = t.uid;
          return;
        }
        e.log(p, `Those Levels do not add up to ${want}`);
      }
      return false;
    },
    *resolve(e, link, p) {
      const f = link.targetUid !== undefined ? e.find(link.targetUid) : null;
      if (!f || f.loc.player !== p || (f.loc.zone !== 'hand' && f.loc.zone !== 'gy') || !freeMZ(e, p)) return;
      yield* e.specialSummon(f.card.uid, p, 'atk');
      const m = e.fieldCard(f.card.uid);
      if (m) tag(m).noAttackTurn = e.state.turn;
    },
  };

  E['Spark Blaster'] = h.equipFor((e, m) => e.isNamed(info(e, m), 'Elemental HERO Sparkman'), undefined, {
    ignition: {
      repeat: true,
      can: (e, c) => c.equippedTo !== undefined && targetable(e, faceUpMonsters(e)).length > 0,
      *run(e, c, p) {
        const t = yield* pickOne(e, p, 'Spark Blaster: change the battle position of which monster?', targetable(e, faceUpMonsters(e)), true);
        if (!t) return;
        togglePos(e, t);
        c.counters++;
        if (c.counters >= 3 && e.fieldCard(c.uid)) yield* e.destroy([c.uid]);
      },
    },
  });

  const toDefense = (e: E9, m: FieldCard) => {
    const x = e.fieldCard(m.uid);
    if (x?.faceUp && x.pos === 'atk') togglePos(e, x);
  };
  E['Spear Dragon'] = {
    piercing: true,
    *afterBattle(e, a) {
      toDefense(e, a);
    },
    *onBattleDamage(e, a) {
      if (e.state.battle?.target === null) toDefense(e, a);
    },
  };

  E['Spell Power Grasp'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p) && counterHolders(e).length > 0,
    *activate(e, link, p) {
      const t = yield* pickOne(e, p, 'Spell Power Grasp: place a Spell Counter on which card?', counterHolders(e), true);
      if (!t) return false;
      e.useOnce(link.card.name, p);
      link.targetUid = t.uid;
    },
    *resolve(e, link, p) {
      const t = fieldOrNull(e, link.targetUid);
      if (!t?.faceUp) return;
      addCounter(e, t);
      if (e.player(p).deck.some((c) => e.sameName(c, link.card)) && (yield* e.yesno(p, 'Add another "Spell Power Grasp" from your Deck to your hand?'))) {
        yield* searchDeck(e, p, 'Add which Spell Power Grasp?', (c) => e.sameName(c, link.card));
      }
    },
  };

  const contSpells = (e: E9) => allST(e).filter((c) => c.faceUp && isSpell(e, c) && info(e, c).sub === 'Continuous');
  E['Spell Purification'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.player(p).hand.length > 0 && contSpells(e).length > 0,
    *activate(e, _link, p) {
      if (!(yield* discardCost(e, p, 1))) return false;
    },
    *resolve(e) {
      yield* e.destroy(contSpells(e).map((c) => c.uid));
    },
  };

  const oppSpells = (e: E9, p: Pid) => stOf(e, other(p)).filter((c) => c.faceUp && isSpell(e, c));
  E['Spell Shattering Arrow'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && oppSpells(e, p).length > 0,
    *resolve(e, _l, p) {
      const list = oppSpells(e, p);
      yield* e.destroy(list.map((c) => c.uid));
      const gone = list.filter((c) => !e.fieldCard(c.uid)).length;
      if (gone) e.damage(other(p), 500 * gone);
    },
  };

  E['Spell Striker'] = {
    summonProc: {
      can: (e, _c, p) => e.player(p).gy.some((c) => isSpell(e, c)),
      *run(e, card, p) {
        const s = yield* pickOne(e, p, 'Spell Striker: banish which Spell from your GY?', e.player(p).gy.filter((c) => isSpell(e, c)), true);
        if (!s) return;
        e.banish(s.uid);
        yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
    directAttack: true,
    noBattleDamage: () => true,
  };

  E['Sphere Kuriboh'] = {
    // audit-09: can be banished from the GY as 1 of the monsters for a Ritual Summon (the Ritual Spells offer it).
    ritualFromGrave: true,
    quick: {
      from: 'hand',
      label: 'send it to the GY: the attacker goes to Defense Position',
      can: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null,
      *cost(e, card, _p, link) {
        link.targetUid = e.state.battle?.attacker;
        yield* e.sendToGrave(card.uid, 'cost');
      },
      *run(e, _card, _p, link) {
        const m = fieldOrNull(e, link.targetUid);
        if (m?.faceUp && m.pos === 'atk') togglePos(e, m);
      },
    },
  };

  E['Spider Egg'] = {
    // audit-09: it needs room for all 3 Tokens.
    canActivate: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null && e.state.battle?.target === null && e.openMonsterZones(p) >= 3 && e.player(p).gy.filter((c) => isMonster(e, c) && raceOf(e, c) === 'Insect').length >= 3,
    *resolve(e, _l, p) {
      if (!e.state.battle) return;
      e.endBattle();
      e.log(p, 'Spider Egg negates the attack');
      for (let i = 0; i < 3; i++) e.createToken('Spider Token', p, 'atk', true, { atk: 100, def: 100, level: 1, attribute: 'EARTH', race: 'Insect' });
    },
  };

  const dragonInHand = (e: E9, p: Pid) => e.player(p).hand.some((c) => isMonster(e, c) && raceOf(e, c) === 'Dragon');
  E['Spirit Ryu'] = {
    quick: {
      label: 'discard a Dragon: +1000 ATK/DEF',
      repeat: true,
      can: (e, card, p) => {
        const b = e.state.battle;
        return e.state.phase === 'BP' && e.state.turnPlayer === p && !!b && (b.attacker === card.uid || b.target === card.uid) && dragonInHand(e, p);
      },
      *cost(e, _card, p) {
        if (!(yield* discardCost(e, p, 1, (c) => isMonster(e, c) && raceOf(e, c) === 'Dragon'))) return false;
      },
      *run(e, card) {
        const m = e.fieldCard(card.uid);
        if (m?.faceUp) boostTurn(m, 1000, 1000);
      },
    },
  };

  E['Spirit of Flames'] = {
    cannotNormalSummon: true,
    summonProc: {
      can: (e, _c, p) => e.player(p).gy.some((c) => isMonster(e, c) && attrOfC(e, c) === 'FIRE'),
      *run(e, card, p) {
        const f = yield* pickOne(e, p, 'Spirit of Flames: banish which FIRE monster?', monstersIn(e, e.player(p).gy, (c) => attrOfC(e, c) === 'FIRE'), true);
        if (!f) return;
        e.banish(f.uid);
        yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
    selfBonus: (e, m) => ({ atk: e.state.phase === 'BP' && e.state.turnPlayer === ctrl(e, m) ? 300 : 0, def: 0 }),
  };

  E['Spirit of the Pharaoh'] = {
    cannotNormalSummon: true,
    // audit-09: "cannot be Special Summoned except by the effect of The First Sarcophagus": that card Summons it in the End Phase
    // right after sending the three Sarcophagi to the GY, which the recent events show (approximation of "by its effect").
    cannotSpecial: (e, _c, p, from) => from !== null && !(e.state.phase === 'EP' && (e.state.events ?? []).slice(-12).some((ev) => ev.kind === 'to-gy' && ev.uid !== undefined && !!e.find(ev.uid) && e.isNamed(e.find(ev.uid)!.card, 'The First Sarcophagus') && e.find(ev.uid)?.loc.player === p)),
    *onSpecialSummon(e, _m, p) {
      const list = e.player(p).gy.filter((c) => isNormalMonster(e, c) && raceOf(e, c) === 'Zombie' && levelOf(e, c) <= 2);
      const room = e.player(p).mz.filter((z) => z === null).length;
      if (!list.length || !room) return;
      const r = yield* pick(e, p, 'Spirit of the Pharaoh: Special Summon up to 4 Zombie Normal Monsters', list, 0, Math.min(4, room));
      for (const c of r ?? []) if (freeMZ(e, p)) yield* e.specialSummon(c.uid, p, 'atk');
    },
  };

  E['Spiritual Forest'] = contSpell({
    shields(e, src, target, how, srcCtl) {
      if (how !== 'battle' || ctrl(e, target) !== srcCtl || !['Beast', 'Beast-Warrior', 'Plant'].includes(raceOf(e, target)) || tag(src).savedTurn === e.state.turn) return false;
      tag(src).savedTurn = e.state.turn;
      return true;
    },
  });

  const stampTargets = (e: E9, self: number) => allST(e).filter((c) => c.uid !== self);
  E['Stamping Destruction'] = {
    canActivate: (e, c, p, t) => isMain(t) && faceUpMonsters(e, p).some((m) => raceOf(e, m) === 'Dragon') && stampTargets(e, c.uid).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Stamping Destruction: destroy which Spell/Trap?', stampTargets(e, link.card.uid), true);
      if (!c) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link) {
      const c = fieldOrNull(e, link.targetUid);
      if (!c) return;
      const owner = ctrl(e, c);
      yield* e.destroy([c.uid]);
      if (!e.fieldCard(c.uid)) e.damage(owner, 500);
    },
  };

  E['Statue of the Wicked'] = {
    *onLeaveField(e, fc, controller, reason) {
      if (reason === 'destroyed' && !fc.faceUp) e.createToken('Wicked Token', controller, 'atk', true, { atk: 1000, def: 1000, level: 4, attribute: 'DARK', race: 'Fiend' });
    },
  };

  // audit-09: at the end of the Battle Phase (direct attacks included), checking for another "roid" monster then.
  E['Stealthroid'] = {
    *onBattlePhaseEnd(e, m, p) {
      if (!m.attacked || e.state.turnPlayer !== p || !e.monsters(p).some((x) => x.uid !== m.uid && x.faceUp && named(e, x, 'roid')) || !allST(e).length) return;
      const c = yield* pickOne(e, p, 'Stealthroid: destroy which Spell/Trap?', allST(e));
      if (c && e.fieldCard(c.uid)) yield* e.destroy([c.uid]);
    },
  };

  E['Steamroid'] = {
    attackBonus: (_e, _a, t) => (t ? 500 : 0),
    selfBonus: (e, m) => {
      const b = e.state.battle;
      const a = b && b.target === m.uid ? e.fieldCard(b.attacker) : null;
      return { atk: a && ctrl(e, a) !== ctrl(e, m) ? -500 : 0, def: 0 };
    },
  };

  E['Steelswarm Sting'] = {
    *onSentToGrave(e, _card, owner, from) {
      if (from !== 'mz') return;
      const list = targetable(e, faceUpMonsters(e)).filter((m) => ['Fusion', 'Ritual', 'Synchro'].includes(info(e, m).sub)); // audit-09: Synchro too
      const t = yield* pickOne(e, owner, 'Steelswarm Sting: destroy which Ritual/Fusion Monster?', list);
      if (t && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
    },
  };

  // audit-09: the doubling is applied to the battle damage itself.
  E['Stone Statue of the Aztecs'] = {
    damageMod: (e, m, p, damaged, amount, byEffect) => {
      const b = e.state.battle;
      return !byEffect && damaged === other(p) && b?.target === m.uid && e.controller(b.attacker) === damaged ? amount * 2 : undefined;
    },
  };

  E['Storm'] = {
    canActivate: (e, c, p, t) => isMain(t) && stOf(e, p).some((x) => x.uid !== c.uid),
    *resolve(e, link, p) {
      const mine = stOf(e, p).filter((x) => x.uid !== link.card.uid);
      yield* e.destroy(mine.map((x) => x.uid));
      const n = mine.filter((x) => !e.fieldCard(x.uid)).length;
      const theirs = stOf(e, other(p));
      if (!n || !theirs.length) return;
      const k = Math.min(n, theirs.length);
      const r = yield* pick(e, p, `Storm: destroy ${k} of your opponent's Spells/Traps`, theirs, k, k);
      if (r) yield* e.destroy(r.map((x) => x.uid));
    },
  };

  E['Straight Flush'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.player(other(p)).sz.every((z) => z !== null),
    *resolve(e, _l, p) {
      yield* e.destroy(e.spells(other(p)).map((c) => c.uid));
    },
  };

  E['Stray Lambs'] = {
    // not after you already Summoned this turn (a face-up monster placed this turn; Sets are fine)
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).mz.filter((z) => z === null).length >= 2 && !e.monsters(p).some((m) => m.faceUp && m.placedTurn === e.state.turn),
    // audit-09: "You cannot Summon other monsters the turn you activate this card (but you can Set)": from the activation on.
    *activate(e, _l, p) {
      ((e.state.fx.summonLocks ??= []) as SummonLock[]).push({ p, turn: e.state.turn, normal: true, special: true, only: [] });
      // group-F: Flip Summons are Summons too (fx.summonLock stops Normal, Flip and Special Summons, not Sets).
      ((e.state.fx.summonLock ??= [-1, -1]) as number[])[p] = e.state.turn;
    },
    *resolve(e, _l, p) {
      // its own lock does not stop its own Tokens: lifted while they arrive, then back on
      const locks = (e.state.fx.summonLocks ?? []) as SummonLock[];
      const mine = locks.filter((l) => l.p === p && l.turn === e.state.turn);
      e.state.fx.summonLocks = locks.filter((l) => !mine.includes(l));
      const one = ((e.state.fx.summonLock ??= [-1, -1]) as number[])[p];
      (e.state.fx.summonLock as number[])[p] = -1;
      for (let i = 0; i < 2; i++) e.createToken('Lamb Token', p, 'def', true, { atk: 0, def: 0, level: 1, attribute: 'EARTH', race: 'Beast' });
      ((e.state.fx.summonLocks ??= []) as SummonLock[]).push(...mine);
      (e.state.fx.summonLock as number[])[p] = Math.max(one, e.state.turn);
    },
  };

  const subToDef = function* (e: E9, m: FieldCard, p: Pid): Step {
    const x = e.fieldCard(m.uid);
    if (x?.faceUp && x.pos === 'atk' && (yield* e.yesno(p, 'Submarineroid: change it to Defense Position?'))) togglePos(e, x);
  };
  E['Submarineroid'] = {
    directAttack: true,
    attackBonus: originalDirect,
    *afterBattle(e, a, _t, p) {
      yield* subToDef(e, a, p);
    },
    *onAttacked(e, target, _a, p) {
      yield* subToDef(e, target, p);
    },
    *onBattleDamage(e, a, p) {
      if (e.state.battle?.target === null) yield* subToDef(e, a, p);
    },
  };

  E['Subterror Behemoth Stalagmo'] = {
    *flip(e, _m, p) {
      const subs = e.player(p).hand.filter((c) => isMonster(e, c) && named(e, c, 'Subterror'));
      if (!e.oncePerTurn('Stalagmo', p) || !subs.length || e.player(p).deck.length < 2) return;
      if (!(yield* e.yesno(p, 'Subterror Behemoth Stalagmo: discard a "Subterror" monster to draw 2 cards?'))) return;
      e.useOnce('Stalagmo', p);
      if (yield* discardCost(e, p, 1, (c) => isMonster(e, c) && named(e, c, 'Subterror'))) e.draw(p, 2);
    },
    ignition: {
      can: (e, m) => canFlipDown(e, m),
      *run(e, m) {
        const x = e.fieldCard(m.uid);
        if (x?.faceUp) setFaceDown(e, x);
      },
    },
    // audit-09: "When a face-up monster you control is flipped face-down, if you control no face-up monsters: You can Special Summon
    // this card from your hand in Defense Position." Seen right after the action that flipped it (the engine's fx.flippedDown).
    *inHand(e, card, owner) {
      const fd = e.state.fx.flippedDown as { uid: number; p: Pid; turn: number; seq: number } | undefined;
      const seen = (e.state.fx.stalagmoSeen ??= {}) as Record<number, number>;
      if (!fd || fd.turn !== e.state.turn || fd.p !== owner || seen[card.uid] === fd.seq) return;
      seen[card.uid] = fd.seq;
      if (faceUpMonsters(e, owner).length || !freeMZ(e, owner) || e.summonBlocked(owner, card, 'special', 'hand')) return;
      if (!(yield* e.yesno(owner, 'Subterror Behemoth Stalagmo: Special Summon it from your hand in Defense Position?'))) return;
      yield* e.specialSummon(card.uid, owner, 'def');
    },
  };

  const cloudians = (e: E9, p: Pid) => [...e.player(p).hand, ...e.player(0).gy, ...e.player(1).gy].filter((c) => isMonster(e, c) && named(e, c, 'Cloudian') && levelOf(e, c) <= 4);
  E['Summon Cloud'] = contSpell({
    ignition: {
      repeat: true,
      can: (e, c, p) => e.oncePerTurn(`Summon Cloud:${c.uid}`, p) && e.monsters(p).length === 0 && cloudians(e, p).length > 0,
      *run(e, c, p) {
        const t = yield* pickOne(e, p, 'Summon Cloud: Special Summon which "Cloudian" monster?', cloudians(e, p), true);
        if (!t) return;
        e.useOnce(`Summon Cloud:${c.uid}`, p);
        const fromGy = e.find(t.uid)?.loc.zone === 'gy';
        yield* e.specialSummon(t.uid, p, 'atk');
        if (fromGy && e.fieldCard(c.uid)) yield* e.destroy([c.uid]);
      },
    },
  });

  E["Summoner's Art"] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).deck.some((c) => isNormalMonster(e, c) && levelOf(e, c) >= 5),
    *resolve(e, _l, p) {
      yield* searchDeck(e, p, "Summoner's Art: add which Normal Monster?", (c) => isNormalMonster(e, c) && levelOf(e, c) >= 5);
    },
  };

  // ---- Super Polymerization: materials from either field ----
  // group-F: monsters from either field, face-down ones included (Tokens cannot be Fusion Materials).
  const superPool = (e: E9, p: Pid): FieldCard[] => [...e.monsters(p), ...e.monsters(other(p))].filter((m) => !m.token);
  /** group-F: a card counts as the material with this id by any of its current names (like Polymerization). */
  const matIs = (e: E9, c: Card, id: number) => e.namesOf(c).some((n) => e.info(n).id === id);
  /** group-F: a Fusion substitute monster (Beastking of the Swamps) can stand in for one material, as with Polymerization. */
  const isSub = (e: E9, fusion: Card, c: Card) => !getEffect(fusion.name)?.noFusionSub && (!!getEffect(c.name)?.fusionSub || (e.state.fx.fusionSubs as Record<number, number> | undefined)?.[c.uid] === e.state.turn);
  /** Each material slot gets its own card; `ids` given: at most one card stands in as a substitute. */
  const assignable = (e: E9, mats: Card[][], ids?: number[], used: number[] = [], subbed = false): boolean =>
    !mats.length ||
    mats[0].some((c) => {
      if (used.includes(c.uid)) return false;
      const asSub = !!ids && !matIs(e, c, ids[0]);
      if (asSub && subbed) return false;
      return assignable(e, mats.slice(1), ids?.slice(1), [...used, c.uid], subbed || asSub);
    });
  const superPlans = (e: E9, p: Pid) => {
    const pool = superPool(e, p);
    const out: { fusion: Card; mats: FieldCard[][]; ids?: number[] }[] = [];
    for (const fusion of e.player(p).fusion) {
      if (info(e, fusion).sub !== 'Fusion' || e.summonBlocked(p, fusion, 'special', 'fusion')) continue; // audit-09
      const ids = e.fusionMaterials(fusion.name) ?? undefined;
      // audit-09: Fusion Monsters whose materials are kinds of monsters (fusionTests) work too.
      const tests = ids ? undefined : getEffect(fusion.name)?.fusionTests;
      const subs = ids ? pool.filter((m) => isSub(e, fusion, m)) : [];
      const mats = ids ? ids.map((id) => [...pool.filter((m) => matIs(e, m, id)), ...subs.filter((m) => !matIs(e, m, id))]) : tests?.map((t) => pool.filter((m) => t(e, m)));
      if (mats && assignable(e, mats, ids)) out.push({ fusion, mats, ids });
    }
    return out;
  };
  E['Super Polymerization'] = {
    canActivate: (e, c, p, t) => anyTime(t) && e.player(p).hand.some((x) => x.uid !== c.uid) && superPlans(e, p).length > 0,
    *activate(e, link, p) {
      const plans = superPlans(e, p);
      const f = yield* pickOne(e, p, 'Super Polymerization: Fusion Summon which monster?', plans.map((x) => x.fusion), true);
      const plan = plans.find((x) => x.fusion.uid === f?.uid);
      if (!plan) return false;
      const chosen: number[] = [];
      for (let i = 0; i < plan.mats.length; i++) {
        const ids = plan.ids;
        const subTaken = !!ids && chosen.some((u, j) => !matIs(e, e.find(u)!.card, ids[j]));
        const free = plan.mats[i].filter((c) => {
          if (chosen.includes(c.uid)) return false;
          const asSub = !!ids && !matIs(e, c, ids[i]);
          return !(asSub && subTaken) && assignable(e, plan.mats.slice(i + 1), ids?.slice(i + 1), [...chosen, c.uid], subTaken || asSub);
        });
        const c = free.length === 1 ? free[0] : yield* pickOne(e, p, `Super Polymerization: use which ${free[0] && free[0].faceUp ? free[0].name : 'material'}?`, free, true);
        if (!c) return false;
        chosen.push(c.uid);
      }
      if (!(yield* discardCost(e, p, 1))) return false;
      // audit-09: noResponse: neither player can activate cards or effects in response to its activation.
      link.payload = { fusion: plan.fusion.uid, mats: chosen, noResponse: true };
    },
    *resolve(e, link, p) {
      const { fusion, mats } = link.payload as { fusion: number; mats: number[] };
      if (e.find(fusion)?.loc.zone !== 'fusion' || mats.some((u) => !e.fieldCard(u))) return;
      yield* e.together(
        (function* (): Step {
          for (const u of mats) yield* e.sendToGrave(u, 'used');
        })(),
      );
      if (!freeMZ(e, p)) return;
      (e.state.fx.fusionMatList ??= {})[fusion] = mats.slice();
      // audit-09: a real Fusion Summon (tags.fusS), like Polymerization.
      yield* e.specialSummon(fusion, p, 'atk', true, (fc) => void ((fc.tags ??= {}).fusS = 1));
      e.log(p, `${e.player(p).name} Fusion Summons ${e.find(fusion)?.card.name ?? 'a monster'}!`);
    },
  };

  const myBeasts = (e: E9, p: Pid) => targetable(e, faceUpMonsters(e, p)).filter((m) => raceOf(e, m) === 'Beast');
  E['Super Rush Recklessly'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && myBeasts(e, p).length > 0 && targetable(e, e.monsters(other(p))).length > 0,
    *activate(e, link, p) {
      const a = yield* pickOne(e, p, 'Super Rush Recklessly: target which of your Beasts?', myBeasts(e, p), true);
      if (!a) return false;
      const b = yield* pickOne(e, p, "Super Rush Recklessly: target which of your opponent's monsters?", targetable(e, e.monsters(other(p))), true);
      if (!b) return false;
      link.payload = [a.uid, b.uid];
    },
    *resolve(e, link, p) {
      const [a, b] = link.payload as number[];
      if (!e.fieldCard(a) || ctrl(e, e.fieldCard(a)!) !== p) return;
      yield* e.destroy([a]);
      if (!e.fieldCard(a) && e.fieldCard(b)) yield* shuffleIn(e, b);
    },
  };

  E['Super Vehicroid Jumbo Drill'] = { piercing: true };

  E['Supercharge'] = {
    canActivate: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null && e.player(p).deck.length >= 2 && e.monsters(p).length > 0 && e.monsters(p).every((m) => m.faceUp && raceOf(e, m) === 'Machine' && named(e, m, 'roid')),
    *resolve(e, _l, p) {
      e.draw(p, 2);
    },
  };

  E['Surface'] = reviveCard('Surface: Special Summon which monster?', (e, c) => levelOf(e, c) <= 3 && ['Fish', 'Sea Serpent', 'Aqua'].includes(raceOf(e, c)), { pos: 'def' });

  E['Swarm of Locusts'] = swarm('st');
  E['Swarm of Scarabs'] = swarm('monster');

  // audit-09: a real Normal Summon without Tributing (face-up only) while it is the only card in your hand.
  E['Swift Gaia the Fierce Knight'] = {
    tributeOffer: (e, src, p, card) => (src === null && e.player(p).hand.length === 1 && e.player(p).hand[0].uid === card.uid ? { need: 0 } : undefined),
  };

  E['Swing of Memories'] = reviveCard('Swing of Memories: Special Summon which Normal Monster?', (e, c) => isNormalMonster(e, c), {
    after: (e, m) => {
      m.doomAt = e.state.turn;
    },
  });

  const bigDinos = (e: E9, p: Pid) => targetable(e, faceUpMonsters(e, p)).filter((m) => raceOf(e, m) === 'Dinosaur' && levelOf(e, m) >= 5);
  E['Tail Swipe'] = {
    canActivate: (e, _c, p, t) => isMain(t) && bigDinos(e, p).length > 0 && e.monsters(other(p)).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Tail Swipe: target which Dinosaur?', bigDinos(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = fieldOrNull(e, link.targetUid);
      if (!m?.faceUp || ctrl(e, m) !== p) return;
      const lv = levelOf(e, m);
      // audit-09: Xyz and Link Monsters have no Level, so only face-down ones of them qualify.
      const list = e.monsters(other(p)).filter((x) => !x.faceUp || (levelOf(e, x) > 0 && levelOf(e, x) < lv));
      const r = yield* pick(e, p, 'Tail Swipe: return up to 2 monsters to the hand', list, 1, 2);
      for (const x of r ?? []) if (e.fieldCard(x.uid)) yield* toHandSafe(e, x.uid);
    },
  };
}
