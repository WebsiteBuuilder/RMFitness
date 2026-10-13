// Speed Duel card scripts, batch 16 (Amazoness Tiger ... Pharaoh's Treasure): monsters, Fusions, Spells and Traps
// from the GX-era Speed Duel boxes. Several use the batch-16 hooks in effects.ts (attackSealsST, attackGuard,
// doubleTribute, tributeDiscount, onBattlePhaseEnd, onGraveEvents, countsAs, sealsSpells, inHand, lingering)
// and the engine's summon locks (state.fx.summonLocks).
import type { EffectDef, GraveEvent } from '../effects';
import { nameEngine } from '../names';
import type { SummonLock } from '../engine';
import type { SpeedHelpers } from './helpers';
import {
  allMonsters,
  allST,
  anyTime,
  attrOf,
  chooseOption,
  ctrl,
  deckToGrave,
  faceUpMonsters,
  freeMZ,
  freeST,
  info,
  isExtraOrRitual,
  isMain,
  isMonster,
  isSpell,
  label,
  levelOf,
  named,
  noBattleDamage,
  opponentAttack,
  other,
  pick,
  pickOne,
  raceOf,
  stOf,
  summonOneOf,
  tag,
  targetable,
  toDeck,
} from './helpers';
import type { Card, ChainCtx, ChainLink, Engine, FieldCard, Gen, Pid, Step } from './helpers';

// ---------- local helpers ----------
const fxMap = <T>(e: Engine, key: string): Record<number, T> => (e.state.fx[key] ??= {}) as Record<number, T>;
const zoneOf = (e: Engine, uid: number) => e.find(uid)?.loc.zone;
function coin(e: Engine, p: Pid, label: string): boolean {
  const heads = e.roll(2) === 1;
  e.log(p, `${label}: ${heads ? 'Heads' : 'Tails'}`);
  return heads;
}
/** "You cannot Normal/Special Summon ... this turn, except ..." (enforced by Engine.summonBlocked). */
function lockSummons(e: Engine, p: Pid, lock: Omit<SummonLock, 'p' | 'turn'>, text: string) {
  const list = ((e.state.fx.summonLocks ??= []) as SummonLock[]).filter((l) => l.turn === e.state.turn);
  list.push({ p, turn: e.state.turn, ...lock });
  e.state.fx.summonLocks = list;
  e.log(p, text);
}
/**
 * Puts a monster card (from a hand, a GY or a Monster Zone) into `p`'s Spell & Trap Zone as an Equip Card
 * attached to `host`. Returns the Equip Card.
 */
function* equipMonster(e: Engine, card: Card, host: FieldCard, p: Pid): Gen<FieldCard | null> {
  const zone = freeST(e, p);
  const f = e.find(card.uid);
  if (zone < 0 || !f || !e.fieldCard(host.uid) || !host.faceUp || card.uid === host.uid) return null;
  const owner = e.player(f.loc.player);
  if (f.loc.zone === 'mz') {
    const fc = f.card as FieldCard;
    for (const u of fc.equips.slice()) yield* e.sendToGrave(u, 'used');
    const g = e.find(card.uid);
    if (!g || g.loc.zone !== 'mz' || !e.fieldCard(host.uid)) return null;
    e.vacateMZ(e.player(g.loc.player), g.loc.index);
  } else if (f.loc.zone === 'hand') owner.hand.splice(f.loc.index, 1);
  else if (f.loc.zone === 'gy') owner.gy.splice(f.loc.index, 1);
  else return null;
  if (e.player(p).sz[zone] !== null) return null;
  const fc: FieldCard = { uid: card.uid, name: card.name, owner: card.owner, pos: 'atk', faceUp: true, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true, equippedTo: host.uid };
  e.player(p).sz[zone] = fc;
  host.equips.push(fc.uid);
  e.event('activate', { uid: fc.uid, player: p });
  e.log(p, `${card.name} is equipped to ${host.name}`);
  return fc;
}
/** Shuffles a card on the field into its owner's Extra Deck. */
function toExtraDeck(e: Engine, uid: number) {
  const f = e.find(uid);
  if (!f) return;
  e.toDeckTop(uid);
  const ps = e.player(f.card.owner);
  const i = ps.deck.findIndex((c) => c.uid === uid);
  if (i < 0) return;
  const [c] = ps.deck.splice(i, 1);
  ps.fusion.push(c);
  e.log(f.card.owner, `${c.name} is shuffled into the Extra Deck`);
}
/** Union monsters (their text lets them unequip themselves). */
const isUnion = (e: Engine, c: Card) => isMonster(e, c) && /Unequip/i.test(info(e, c).desc);
const dHero = (e: Engine, c: Card) => isMonster(e, c) && named(e, c, 'Destiny HERO');
const spellResolving = (e: Engine) => {
  const c = e.resolvingCard();
  return !!c && info(e, c).kind === 'spell';
};
const umi = (e: Engine) => !!(e.anyActive('Umi') || e.anyActive('A Legendary Ocean'));
const fieldTarget = (e: Engine, link: ChainLink) => (link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null);
/** Every face-up card a player controls (monsters, Spells/Traps, Field Spell). */
const faceUpCards = (e: Engine, p: Pid) => [...faceUpMonsters(e, p), ...stOf(e, p).filter((c) => c.faceUp)];

/** A Gemini monster with no extra effect beyond becoming an Effect Monster (Neos Alius). */
const geminiOnly = (): Partial<EffectDef> => ({
  ignition: {
    chain: false,
    can: (e, m, p) => m.tags?.gemini !== 1 && !e.player(p).normalSummoned,
    *run(e, m, p) {
      e.player(p).normalSummoned = true;
      tag(m).gemini = 1;
      e.log(p, `${e.player(p).name} Normal Summons ${m.name} again: it becomes an Effect Monster`);
    },
  },
});

/** Fusion plans restricted to some Fusion Monsters, from hand + field (Fullmetalfoes Fusion). */
type Plan = { fusion: Card; mats: Card[][] };
function canAssign(e: Engine, mats: Card[][], used: number[] = []): boolean {
  if (!mats.length) return true;
  return mats[0].some((c) => !used.includes(c.uid) && canAssign(e, mats.slice(1), [...used, c.uid]));
}
function plansFor(e: Engine, p: Pid, test: (f: Card) => boolean): Plan[] {
  const pool = [...e.player(p).hand.filter((c) => isMonster(e, c)), ...e.monsters(p)];
  const out: Plan[] = [];
  for (const fusion of e.player(p).fusion) {
    if (!test(fusion) || e.summonBlocked(p, fusion, 'special', 'fusion')) continue;
    const ids = e.fusionMaterials(fusion.name);
    if (!ids) continue;
    const mats = ids.map((id) => pool.filter((c) => info(e, c).id === id));
    if (canAssign(e, mats)) out.push({ fusion, mats });
  }
  return out;
}
function fusionSpell(test: (f: Card) => boolean, title: string): EffectDef {
  return {
    canActivate: (e, _c, p, t) => anyTime(t) && plansFor(e, p, test).length > 0,
    *activate(e, link, p) {
      const plans = plansFor(e, p, test);
      const f = yield* pickOne(e, p, `${title}: Fusion Summon which monster?`, plans.map((x) => x.fusion), true);
      if (!f) return false;
      const plan = plans.find((x) => x.fusion.uid === f.uid)!;
      const chosen: number[] = [];
      for (let i = 0; i < plan.mats.length; i++) {
        const free = plan.mats[i].filter((c) => !chosen.includes(c.uid) && canAssign(e, plan.mats.slice(i + 1), [...chosen, c.uid]));
        const c = free.length === 1 ? free[0] : yield* pickOne(e, p, `${title}: use which material?`, free, true);
        if (!c) return false;
        chosen.push(c.uid);
      }
      link.payload = { fusion: f.uid, mats: chosen };
    },
    *resolve(e, link, p) {
      const { fusion, mats } = link.payload as { fusion: number; mats: number[] };
      if (zoneOf(e, fusion) !== 'fusion' || mats.some((u) => !['hand', 'mz'].includes(zoneOf(e, u) ?? ''))) return;
      for (const u of mats) yield* e.sendToGrave(u, 'used');
      if (!freeMZ(e, p)) return;
      yield* e.specialSummon(fusion, p, 'atk');
      e.log(p, `${e.player(p).name} Fusion Summons ${e.find(fusion)?.card.name ?? 'a monster'}!`);
    },
  };
}

export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  // ======================= Effect Monsters =======================
  const amazoness = (m: FieldCard) => m.faceUp && named(nameEngine(), m, 'Amazoness');
  E['Amazoness Tiger'] = {
    selfBonus: (e, m) => ({ atk: 400 * e.monsters(ctrl(e, m)).filter(amazoness).length, def: 0 }),
    attackGuard: (e, src, sp, attacker, target) => e.controller(attacker.uid) !== sp && target.uid !== src.uid && e.controller(target.uid) === sp && amazoness(target),
    // "You can only control 1": no second copy can be Summoned while one is face-up.
    forbidsSummon: (e, _m, q, monster, who, how) => who === q && how !== 'set' && e.isNamed(monster, 'Amazoness Tiger'),
  };

  E['Ancient Gear Golem'] = { cannotSpecialSummon: true, piercing: true, attackSealsST: true };

  const lovers = function* (e: Engine, m: FieldCard, p: Pid): Step {
    tag(m).coin = coin(e, p, 'Arcana Force VI - The Lovers') ? 1 : 2;
    e.log(p, m.tags!.coin === 1 ? 'The Lovers can be treated as 2 Tributes for an "Arcana Force" monster' : `${e.player(p).name} cannot Tribute Summon "Arcana Force" monsters`);
  };
  E['Arcana Force VI - The Lovers'] = {
    onSummon: (e, m, p) => lovers(e, m, p),
    onSpecialSummon: lovers,
    doubleTribute: (e, m, monster) => m.tags?.coin === 1 && named(e, monster, 'Arcana Force'),
    forbidsSummon: (e, m, q, monster, who, how) => m.tags?.coin === 2 && who === q && how === 'normal' && named(e, monster, 'Arcana Force') && e.tributeNeed(who, monster) > 0,
  };

  // Cards sent to its controller's GY during the Battle Phase while it was face-up (fx.battleSurvivor[uid]).
  E['Battle Survivor'] = {
    *onGraveEvents(e, m, p, events) {
      if (e.state.phase !== 'BP') return;
      const rec = fxMap<{ turn: number; uids: number[] }>(e, 'battleSurvivor');
      if (rec[m.uid]?.turn !== e.state.turn) rec[m.uid] = { turn: e.state.turn, uids: [] };
      for (const v of events) if (v.toGy && !v.token && v.card.owner === p && !e.isNamed(v.card, 'Battle Survivor')) rec[m.uid].uids.push(v.card.uid);
    },
    *onBattlePhaseEnd(e, m, p) {
      const rec = fxMap<{ turn: number; uids: number[] }>(e, 'battleSurvivor')[m.uid];
      if (!rec || rec.turn !== e.state.turn || !e.oncePerTurn('Battle Survivor', p)) return;
      const cands = e.player(p).gy.filter((c) => rec.uids.includes(c.uid));
      if (!cands.length || !(yield* e.yesno(p, 'Battle Survivor: add a card sent to your GY this Battle Phase to your hand?'))) return;
      const c = yield* pickOne(e, p, 'Battle Survivor: add which card?', cands);
      if (!c) return;
      e.useOnce('Battle Survivor', p);
      e.toHandOf(c.uid, p);
      e.log(p, `${e.player(p).name} adds ${c.name} from the GY to the hand`);
    },
  };

  // The name change to "Buster Blader" is not applied.
  const bbEquips = (e: Engine, m: FieldCard) => m.equips.map((u) => e.fieldCard(u)).filter((c): c is FieldCard => !!c && isMonster(e, c));
  E['Buster Blader, the Destruction Swordmaster'] = {
    *onGraveEvents(e, m, p, events) {
      const cands = events.filter((v: GraveEvent) => v.from === 'mz' && v.reason === 'destroyed' && v.controller === other(p) && v.toGy && !v.token && zoneOf(e, v.card.uid) === 'gy').map((v) => e.find(v.card.uid)!.card);
      if (!cands.length || freeST(e, p) < 0 || !(yield* e.yesno(p, 'Buster Blader, the Destruction Swordmaster: equip a destroyed monster to it?'))) return;
      const c = yield* pickOne(e, p, 'Equip which destroyed monster?', cands);
      const me = e.fieldCard(m.uid);
      if (c && me?.faceUp) yield* equipMonster(e, c, me, p);
    },
    ignition: {
      can: (e, m) => bbEquips(e, m).length > 0,
      *run(e, m, p) {
        const eq = yield* pickOne(e, p, 'Send which equipped Monster Card to the GY?', bbEquips(e, m), true);
        if (!eq) return;
        const race = info(e, eq).race ?? '';
        yield* e.sendToGrave(eq.uid, 'cost');
        const victims = e.monsters(other(p)).filter((x) => x.faceUp && raceOf(e, x) === race);
        e.log(p, `Buster Blader destroys every ${race} monster ${e.player(other(p)).name} controls`);
        if (victims.length) yield* e.destroy(victims.map((x) => x.uid));
      },
    },
  };

  const chronomaly = (m: FieldCard) => m.faceUp && named(nameEngine(), m, 'Chronomaly');
  E['Chronomaly Sol Monolith'] = {
    ignition: {
      can: (e, _m, p) => e.monsters(p).some(chronomaly),
      *run(e, _m, p) {
        lockSummons(e, p, { normal: false, special: true, only: ['Chronomaly'] }, `${e.player(p).name} cannot Special Summon this turn, except "Chronomaly" monsters`);
        const t = yield* pickOne(e, p, 'Chronomaly Sol Monolith: which "Chronomaly" monster becomes Level 6?', targetable(e, e.monsters(p).filter(chronomaly)));
        if (!t || !e.fieldCard(t.uid)?.faceUp) return;
        fxMap<number>(e, 'declLevel')[t.uid] = 6;
        e.log(p, `${t.name} becomes Level 6`);
      },
    },
  };

  // Being treated as a "Destiny HERO" after a Normal Summon is only logged (archetype checks go by name).
  const dCubes = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy].filter((c) => e.isNamed(c, 'D Cubed'));
  E['D Cubed'] = {
    // "If this card is Normal Summoned: It is also treated as a "Destiny HERO" monster while face-up on the field."
    extraNames: (_e, m) => (m.tags?.dHero === 1 ? ['Destiny HERO'] : undefined),
    *onSummon(e, m, p, kind) {
      if (kind !== 'normal') return;
      tag(m).dHero = 1;
      e.log(p, 'D Cubed is also treated as a "Destiny HERO" monster');
    },
    ignition: {
      can: (e, m, p) => e.oncePerTurn('D Cubed:1', p) && e.player(p).hand.length > 0 && freeMZ(e, p) && dCubes(e, p).some((c) => c.uid !== m.uid),
      *run(e, _m, p) {
        e.useOnce('D Cubed:1', p);
        const zones = e.player(p).mz.filter((z) => z === null).length;
        const max = Math.min(2, e.player(p).hand.length, zones);
        if (max < 1) return;
        const n = max === 1 ? 1 : ((yield* chooseOption(e, p, 'D Cubed: discard how many cards?', ['1 card', '2 cards'])) ?? 0) + 1;
        const disc = yield* pick(e, p, `D Cubed: discard ${n} card${n > 1 ? 's' : ''}`, e.player(p).hand, n, n);
        if (!disc || disc.length !== n) return;
        for (const c of disc) yield* e.discard(p, c.uid);
        for (let i = 0; i < n; i++) {
          const s = yield* summonOneOf(e, p, 'D Cubed: Special Summon which "D Cubed"?', dCubes(e, p));
          if (!s) break;
        }
        lockSummons(e, p, { normal: true, special: true, only: ['Destiny HERO'] }, `${e.player(p).name} cannot Normal or Special Summon this turn, except "Destiny HERO" monsters`);
      },
    },
    *onDestroyed(e, _c, p) {
      if (!e.oncePerTurn('D Cubed:2', p) || !e.player(p).deck.some((c) => dHero(e, c)) || !(yield* e.yesno(p, 'D Cubed: send a "Destiny HERO" monster from your Deck to the GY?'))) return;
      e.useOnce('D Cubed:2', p);
      yield* deckToGrave(e, p, 'D Cubed: send which "Destiny HERO"?', (c) => dHero(e, c));
    },
  };

  // Spell Counters are placed when the Spell is activated (as a chain link), not when it resolves.
  E['Dark Red Enchanter'] = {
    *onSummon(e, m, p, kind) {
      if (kind !== 'normal') return;
      m.counters += 2;
      e.log(p, `2 Spell Counters are placed on Dark Red Enchanter (${m.counters})`);
    },
    quick: {
      label: 'place a Spell Counter',
      repeat: true,
      can: (e, _c, _p, t, ctx) => t === 'spell' && !!ctx.link && isSpell(e, ctx.link.card),
      *run(e, card) {
        const m = e.fieldCard(card.uid);
        if (!m?.faceUp) return;
        m.counters++;
        e.log(null, `A Spell Counter is placed on Dark Red Enchanter (${m.counters})`);
      },
    },
    selfBonus: (_e, m) => ({ atk: 300 * m.counters, def: 0 }),
    ignition: {
      can: (e, m, p) => m.counters >= 2 && e.player(other(p)).hand.length > 0,
      *run(e, m, p) {
        if (m.counters < 2) return;
        m.counters -= 2;
        const hand = e.player(other(p)).hand;
        if (!hand.length) return;
        const c = hand[Math.floor(e.rand() * hand.length)];
        e.log(p, 'Dark Red Enchanter discards a random card from the opponent\'s hand');
        yield* e.discard(other(p), c.uid);
      },
    },
  };

  // Only the hand and Standby Phase effects: the "negate your own Spells" effect is not applied.
  const darkAngelTargets = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => dHero(e, c) && !isExtraOrRitual(e, c));
  E['Destiny HERO - Dark Angel'] = {
    handIgnition: {
      can: (e, c, p) => e.player(p).gy.filter((x) => dHero(e, x)).length >= 3 && freeMZ(e, other(p)) && darkAngelTargets(e, p).length > 0 && zoneOf(e, c.uid) === 'hand',
      *run(e, card, p) {
        const t = yield* pickOne(e, p, 'Dark Angel: Special Summon which "Destiny HERO" to your opponent\'s field?', darkAngelTargets(e, p), true);
        if (!t) return;
        yield* e.discard(p, card.uid);
        if (zoneOf(e, t.uid) === 'gy') yield* e.specialSummon(t.uid, other(p), 'def');
      },
    },
    *onStandbyInGrave(e, card, p) {
      const others = e.player(p).gy.filter((c) => c.uid !== card.uid && dHero(e, c));
      if (!others.length || !(yield* e.yesno(p, 'Dark Angel: banish it and a "Destiny HERO" from your GY so each player puts a Normal Spell on top of their Deck?'))) return;
      const o = yield* pickOne(e, p, 'Banish which "Destiny HERO"?', others);
      if (!o) return;
      e.banish(card.uid);
      e.banish(o.uid);
      for (const q of [p, other(p)]) {
        const spells = e.player(q).deck.filter((c) => isSpell(e, c) && info(e, c).sub === 'Normal');
        const s = yield* pickOne(e, q, 'Dark Angel: place which Normal Spell on top of your Deck?', spells);
        if (!s) continue;
        const ps = e.player(q);
        ps.deck = [s, ...ps.deck.filter((c) => c.uid !== s.uid)];
        e.log(q, `${ps.name} places a Normal Spell on top of the Deck`);
      }
    },
  };

  // Gemini: its only effect (its name becomes "Elemental HERO Neos") is not applied.
  E['Elemental HERO Neos Alius'] = { ...geminiOnly() };

  E['Evolsaur Darwino'] = {
    *onSpecialSummon(e, m, p) {
      if (e.state.fx.evoltileSS !== m.uid) return;
      const list = targetable(e, faceUpMonsters(e));
      if (!list.length || !(yield* e.yesno(p, 'Evolsaur Darwino: increase a monster\'s Level by up to 2?'))) return;
      const t = yield* pickOne(e, p, 'Evolsaur Darwino: which monster?', list);
      if (!t) return;
      const n = ((yield* chooseOption(e, p, 'Increase its Level by how much?', ['1', '2'])) ?? 1) + 1;
      if (!e.fieldCard(t.uid)?.faceUp) return;
      fxMap<number>(e, 'declLevel')[t.uid] = levelOf(e, t) + n;
      e.log(p, `${t.name}'s Level becomes ${levelOf(e, t)}`);
    },
  };

  // Only damage it inflicts while attacking counts.
  E['Flyfang'] = {
    piercing: true,
    *onBattleDamage(e, m) {
      tag(m).flyDmg = e.state.turn;
    },
    *onBattlePhaseEnd(e, m, p) {
      if (m.tags?.flyDmg !== e.state.turn) return;
      e.log(p, 'Flyfang is banished until its controller\'s next Standby Phase');
      e.banish(m.uid);
      ((e.state.fx.returnAtStandby ??= []) as { uid: number; p: Pid; pos: string; after: number }[]).push({ uid: m.uid, p, pos: 'atk', after: e.state.turn });
    },
  };

  E['Gearfried the Iron Knight'] = {
    *stateCheck(e, m) {
      const eqs = m.equips.filter((u) => e.fieldCard(u));
      if (!eqs.length) return;
      e.log(null, 'Gearfried the Iron Knight destroys the Equip Card');
      yield* e.destroy(eqs);
    },
  };

  E['Harpie Lady 2'] = { negatesVictimFlip: true };

  E['Infernity Beast'] = { attackSealsST: (e, m) => e.player(ctrl(e, m)).hand.length === 0 };

  E['Lancer Archfiend'] = {
    quick: {
      label: 'inflict piercing damage this battle',
      can: (e, _c, p, t, ctx) => {
        const b = e.state.battle;
        if (t !== 'attack' || !b || ctx.uid !== b.attacker || e.controller(b.attacker) !== p || b.target === null) return false;
        const target = e.fieldCard(b.target);
        return !!target && target.pos === 'def' && e.controller(target.uid) === other(p);
      },
      *run(e, _c, p) {
        const b = e.state.battle;
        const a = b ? e.fieldCard(b.attacker) : null;
        if (!a || e.controller(a.uid) !== p) return;
        tag(a).pierceBattle = e.state.fx.battleNo ?? 0;
        e.log(p, `${a.name} will inflict piercing battle damage`);
      },
    },
  };

  E['Maiden of the Aqua'] = {
    countsAs: (e) => ([0, 1] as Pid[]).some((q) => e.player(q).field?.faceUp) ? undefined : 'Umi',
  };

  E['Maxx "C"'] = {
    quick: {
      from: 'hand',
      label: 'draw each time your opponent Special Summons',
      can: (e, _c, p) => e.oncePerTurn('Maxx "C"', p),
      *cost(e, card, p) {
        e.useOnce('Maxx "C"', p);
        yield* e.sendToGrave(card.uid, 'cost');
      },
      *run(e, _c, p) {
        e.linger('Maxx "C"', p);
        e.log(p, `${e.player(p).name} draws a card each time the opponent Special Summons this turn`);
      },
    },
    lingering: {
      *onAnySummon(e, owner, _m, controller, kind) {
        if (kind !== 'special' || controller !== other(owner) || !e.player(owner).deck.length) return;
        e.log(owner, 'Maxx "C": draw 1 card');
        e.draw(owner, 1);
      },
    },
  };

  // The "effects that target Insects are negated" part is not applied.
  E['Parasite Paranoid'] = {
    quick: {
      from: 'hand',
      label: 'equip it to a monster',
      can: (e, _c, p) => e.oncePerTurn('Parasite Paranoid', p) && freeST(e, p) >= 0 && targetable(e, faceUpMonsters(e)).length > 0,
      *cost(e, _card, p, link) {
        const t = yield* pickOne(e, p, 'Parasite Paranoid: equip to which monster?', targetable(e, faceUpMonsters(e)), true);
        if (!t) return false;
        e.useOnce('Parasite Paranoid', p);
        link.targetUid = t.uid;
      },
      *run(e, card, p, link) {
        const host = fieldTarget(e, link);
        if (!host?.faceUp || zoneOf(e, card.uid) !== 'hand') return;
        const eq = yield* equipMonster(e, card, host, p);
        if (!eq) return;
        fxMap<string>(e, 'declRace')[host.uid] = 'Insect';
        tag(eq).paranoidHost = host.uid;
        e.log(p, `${host.name} becomes an Insect monster`);
      },
    },
    attackGuard: (e, src, _sp, attacker, target) => src.equippedTo === attacker.uid && zoneOf(e, src.uid) === 'sz' && target.faceUp && raceOf(e, target) === 'Insect',
    *onLeaveField(e, fc) {
      const host = fc.tags?.paranoidHost;
      if (host !== undefined && fxMap<string>(e, 'declRace')[host] === 'Insect') delete fxMap<string>(e, 'declRace')[host];
    },
    *onSentToGrave(e, _card, p, from) {
      const ok = (c: Card) => isMonster(e, c) && !isExtraOrRitual(e, c) && info(e, c).race === 'Insect' && (info(e, c).level ?? 0) >= 7;
      if (from !== 'sz' || !freeMZ(e, p) || !e.player(p).hand.some(ok) || !(yield* e.yesno(p, 'Parasite Paranoid: Special Summon a Level 7 or higher Insect from your hand?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which Insect?', e.player(p).hand.filter(ok));
    },
  };

  const phantom = (m: FieldCard) => m.faceUp && (nameEngine().isNamed(m, 'Gazelle the King of Mythical Beasts') || named(nameEngine(), m, 'Phantom Beast'));
  E['Phantom Beast Thunder-Pegasus'] = {
    quick: {
      from: 'gy',
      label: 'protect a Phantom Beast from this battle',
      can: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null && e.monsters(p).some(phantom),
      *cost(e, card) {
        e.banish(card.uid);
      },
      *run(e, _c, p) {
        const m = yield* pickOne(e, p, 'Thunder-Pegasus: protect which monster?', e.monsters(p).filter(phantom));
        const b = e.state.battle;
        if (!m || !b) return;
        tag(m).pegasusBattle = e.state.fx.battleNo ?? 0;
        e.linger('Phantom Beast Thunder-Pegasus', p);
        if (b.target === m.uid) noBattleDamage(e, p);
        e.log(p, `${m.name} takes no battle damage and is not destroyed by this battle`);
      },
    },
    lingering: {
      shields: (e, owner, target, how) => how === 'battle' && e.controller(target.uid) === owner && !!target.tags?.pegasusBattle && target.tags.pegasusBattle === e.state.fx.battleNo,
    },
  };

  E['Red Gardna'] = {
    quick: {
      from: 'hand',
      label: 'protect your monsters from card effects',
      can: (e, _c, p, t, ctx) => (t === 'spell' || t === 'trap' || t === 'effect') && !!ctx.link && ctx.link.player === other(p) && e.monsters(p).some((m) => m.faceUp && named(e, m, 'Red Dragon Archfiend')),
      *cost(e, card) {
        yield* e.sendToGrave(card.uid, 'cost');
      },
      *run(e, _c, p) {
        e.linger('Red Gardna', p);
        e.log(p, `${e.player(p).name}'s monsters cannot be destroyed by the opponent's card effects this turn`);
      },
    },
    lingering: {
      shields: (e, owner, target, how) => how === 'effect' && e.controller(target.uid) === owner && e.actor === other(owner),
    },
  };

  E['Spell Canceller'] = { sealsSpells: true };

  // "Unaffected by Spell effects": it cannot be targeted or destroyed by a resolving Spell (its other effects still apply).
  // It cannot be attacked at all while "Umi" is out (the direct attack it allows is not offered).
  E['The Legendary Fisherman'] = {
    cannotBeAttacked: (e) => umi(e),
    effectProof: (e) => umi(e) && spellResolving(e),
    cannotBeTargeted: (e) => umi(e) && spellResolving(e),
  };

  E['Unshaven Angler'] = { doubleTribute: (e, _m, monster) => attrOf(e, monster) === 'WATER' };

  E['White Magician Pikeru'] = {
    *onStandby(e, _m, p) {
      if (e.state.turnPlayer !== p) return;
      const n = e.monsters(p).length;
      e.log(p, `White Magician Pikeru: ${e.player(p).name} gains ${400 * n} LP`);
      if (n) e.gainLp(p, 400 * n);
    },
  };

  // ======================= Fusion Monsters =======================
  // Glow Neos: the contact Fusion (shuffling the materials into the Deck) is not offered; Polymerization can Summon it.
  E['Elemental HERO Glow Neos'] = {
    *onEndPhase(e, m) {
      if (!e.fieldCard(m.uid)) return;
      toExtraDeck(e, m.uid);
    },
    directAttack: (e, m) => m.tags?.glowDirect === e.state.turn,
    ignition: {
      can: (e, _m, p) => e.state.phase === 'M1' && faceUpCards(e, other(p)).some((c) => zoneOf(e, c.uid) !== 'mz' || !e.untargetable(c)),
      *run(e, m, p) {
        const list = faceUpCards(e, other(p)).filter((c) => zoneOf(e, c.uid) !== 'mz' || !e.untargetable(c));
        const t = yield* pickOne(e, p, 'Glow Neos: destroy which face-up card?', list);
        if (!t) return;
        const kind = info(e, t).kind;
        yield* e.destroy([t.uid]);
        if (e.fieldCard(t.uid)) return;
        const me = e.fieldCard(m.uid);
        if (!me) return;
        if (kind === 'monster') {
          tag(me).noAttackTurn = e.state.turn;
          e.log(p, 'Glow Neos cannot attack this turn');
        } else if (kind === 'spell') {
          tag(me).glowDirect = e.state.turn;
          e.log(p, 'Glow Neos can attack directly this turn');
        } else {
          me.pos = 'def';
          e.log(p, 'Glow Neos changes to Defense Position');
        }
      },
    },
  };

  // Its "Dark Fusion only" Summon condition is not enforced.
  E['Evil HERO Wild Cyclone'] = {
    attackSealsST: true,
    *onBattleDamage(e, _m, p) {
      const sets = stOf(e, other(p)).filter((c) => !c.faceUp);
      if (!sets.length) return;
      e.log(p, 'Evil HERO Wild Cyclone destroys every face-down Spell/Trap the opponent controls');
      yield* e.destroy(sets.map((c) => c.uid));
    },
  };

  const stealthEquipped = (e: Engine, m: FieldCard) => {
    const u = m.tags?.stealthEq;
    return u !== undefined && m.equips.includes(u) && !!e.fieldCard(u);
  };
  E['Super Vehicroid - Stealth Union'] = {
    ignition: {
      can: (e, m, p) => freeST(e, p) >= 0 && targetable(e, faceUpMonsters(e)).some((x) => x.uid !== m.uid && raceOf(e, x) !== 'Machine'),
      *run(e, m, p) {
        const t = yield* pickOne(e, p, 'Stealth Union: equip which non-Machine monster?', targetable(e, faceUpMonsters(e)).filter((x) => x.uid !== m.uid && raceOf(e, x) !== 'Machine'));
        const me = e.fieldCard(m.uid);
        if (!t || !me?.faceUp) return;
        const eq = yield* equipMonster(e, t, me, p);
        if (eq) tag(me).stealthEq = eq.uid;
      },
    },
    // One attack on each opponent's monster: one more attack while a monster it has not attacked this turn remains.
    attacks: (e, m) => {
      if (!stealthEquipped(e, m)) return 1;
      const made = m.attacked ? m.tags?.attacksMade ?? 1 : 0;
      return Math.max(1, made + (e.monsters(other(ctrl(e, m))).some((t) => m.tags?.[`hit${t.uid}`] !== e.state.turn) ? 1 : 0));
    },
    targetFilter: (e, m, t) => !stealthEquipped(e, m) || m.tags?.[`hit${t.uid}`] !== e.state.turn,
    *afterBattle(e, m, target) {
      tag(m)[`hit${target.uid}`] = e.state.turn;
    },
    attackBonus: (e, m) => -Math.floor(e.baseStats(m).atk / 2),
    piercing: true,
  };

  // ======================= Ritual Monster =======================
  const nouvelles = (e: Engine, c: Card) => isMonster(e, c) && info(e, c).sub === 'Ritual' && named(e, c, 'Nouvelles') && [3, 4].includes(info(e, c).level ?? 0);
  const confirasTargeted = (e: Engine, card: Card, t: string, ctx: ChainCtx) => (t === 'attack' && e.state.battle?.target === card.uid) || ((t === 'spell' || t === 'trap' || t === 'effect') && ctx.link?.targetUid === card.uid);
  E['Confiras de Nouvelles'] = {
    *onSpecialSummon(e, _m, p) {
      if (!e.oncePerTurn('Confiras de Nouvelles:1', p) || !allST(e).length || !(yield* e.yesno(p, 'Confiras de Nouvelles: destroy 1 Spell/Trap on the field?'))) return;
      const t = yield* pickOne(e, p, 'Destroy which Spell/Trap?', allST(e));
      if (!t) return;
      e.useOnce('Confiras de Nouvelles:1', p);
      yield* e.destroy([t.uid]);
    },
    quick: {
      label: 'Tribute it to Special Summon a "Nouvelles" Ritual Monster',
      can: (e, card, p, t, ctx) =>
        e.oncePerTurn('Confiras de Nouvelles:2', p) && confirasTargeted(e, card, t, ctx) && allMonsters(e).some((m) => m.uid !== card.uid && m.pos === 'atk') && [...e.player(p).hand, ...e.player(p).deck].some((c) => nouvelles(e, c)),
      *cost(e, _c, p) {
        e.useOnce('Confiras de Nouvelles:2', p);
      },
      *run(e, card, p) {
        const other1 = yield* pickOne(e, p, 'Tribute which Attack Position monster too?', allMonsters(e).filter((m) => m.uid !== card.uid && m.pos === 'atk'));
        if (!other1 || !e.fieldCard(card.uid)) return;
        e.log(p, `${e.player(p).name} Tributes Confiras de Nouvelles and ${label(other1)}`);
        yield* e.sendToGrave(card.uid, 'tribute');
        yield* e.sendToGrave(other1.uid, 'tribute');
        yield* summonOneOf(e, p, 'Special Summon which "Nouvelles" Ritual Monster?', [...e.player(p).hand, ...e.player(p).deck].filter((c) => nouvelles(e, c)));
      },
    },
  };

  // ======================= Spells =======================
  E['Reverse Breaker'] = {
    ...h.equipFor((e, m) => named(e, m, 'Utopia'), () => ({ atk: 0, def: 0 })),
    quick: {
      label: 'destroy a Spell/Trap your opponent controls',
      can: (e, card, p, t, ctx) => {
        const eq = e.fieldCard(card.uid);
        return t === 'attack' && !!eq && eq.equippedTo !== undefined && ctx.uid === eq.equippedTo && e.controller(eq.equippedTo) === p && stOf(e, other(p)).length > 0;
      },
      *cost(e, _c, p, link) {
        const t = yield* pickOne(e, p, 'Reverse Breaker: destroy which Spell/Trap?', stOf(e, other(p)), true);
        if (!t) return false;
        link.targetUid = t.uid;
      },
      *run(e, _c, p, link) {
        const t = fieldTarget(e, link);
        if (!t) return;
        e.log(p, `Reverse Breaker destroys ${label(t)}`);
        yield* e.destroy([t.uid]);
      },
    },
  };

  const ancientGear = (e: Engine, c: Card) => isMonster(e, c) && named(e, c, 'Ancient Gear') && !isExtraOrRitual(e, c);
  E['Geartown'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    tributeDiscount: (e, _src, _sp, monster) => (named(e, monster, 'Ancient Gear') ? 1 : 0),
    *onDestroyed(e, _card, p) {
      const pool = () => [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy].filter((c) => ancientGear(e, c) && !e.summonBlocked(p, c, 'special', zoneOf(e, c.uid) ?? null));
      if (!freeMZ(e, p) || !pool().length || !(yield* e.yesno(p, 'Geartown: Special Summon an "Ancient Gear" monster from your hand, Deck or GY?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which "Ancient Gear" monster?', pool());
    },
  };

  // Only the first effect: the Set-card effect needs a face-up Pendulum Monster in the Extra Deck.
  const abyssActors = (e: Engine, p: Pid) => targetable(e, e.monsters(p).filter((m) => m.faceUp && named(e, m, 'Abyss Actor')));
  E['Abyss Script - Fantasy Magic'] = {
    canActivate: (e, _c, p, t) => isMain(t) && abyssActors(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Fantasy Magic: target which "Abyss Actor"?', abyssActors(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = fieldTarget(e, link);
      if (!m?.faceUp) return;
      tag(m).fantasy = e.state.turn;
      e.linger('Abyss Script - Fantasy Magic', p);
      e.log(p, `Monsters that battle ${m.name} and survive return to the hand this turn`);
    },
    lingering: {
      *afterAnyBattle(e, owner, attacker, target) {
        for (const [me, foe] of [
          [attacker, target],
          [target, attacker],
        ]) {
          if (me.tags?.fantasy !== e.state.turn || e.controller(me.uid) !== owner || !e.fieldCard(me.uid) || !e.fieldCard(foe.uid)) continue;
          e.log(owner, `Fantasy Magic returns ${foe.name} to the hand`);
          e.toHand(foe.uid);
        }
      },
    },
  };

  E['Card Advance'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).deck.length > 0,
    *resolve(e, _l, p) {
      const ps = e.player(p);
      const top = ps.deck.slice(0, Math.min(5, ps.deck.length));
      if (top.length) {
        const order = yield* pick(e, p, 'Card Advance: choose the new order, top card first', top, top.length, top.length);
        const chosen = order && order.length === top.length ? order : top;
        ps.deck = [...chosen, ...ps.deck.filter((c) => !chosen.some((x) => x.uid === c.uid))];
        e.log(p, `${ps.name} looks at the top ${top.length} cards and puts them back in any order`);
      }
      ((e.state.fx.extraTribute ??= [-1, -1]) as number[])[p] = e.state.turn;
      e.log(p, `${ps.name} can Tribute Summon 1 more monster this turn`);
    },
  };

  // Needs 4 free Monster Zones, so it can never be activated with the 3 zones of a Speed Duel.
  const cardians = (e: Engine, p: Pid) => e.player(p).deck.filter((c) => isMonster(e, c) && named(e, c, 'Flower Cardian') && info(e, c).atk === 100);
  const cardianNames = (e: Engine, p: Pid) => new Set(cardians(e, p).map((c) => c.name));
  E['Flower Gathering'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.oncePerTurn('Flower Gathering', p) && e.player(p).mz.filter((z) => z === null).length >= 4 && cardianNames(e, p).size >= 4,
    *activate(e, _link, p) {
      e.useOnce('Flower Gathering', p);
    },
    *resolve(e, _l, p) {
      lockSummons(e, p, { normal: true, special: true, only: ['Flower Cardian'] }, `${e.player(p).name} cannot Normal or Special Summon this turn, except "Flower Cardian" monsters`);
      if (e.player(p).mz.filter((z) => z === null).length < 4 || cardianNames(e, p).size < 4) return;
      const used: string[] = [];
      for (let i = 0; i < 4; i++) {
        const s = yield* summonOneOf(e, p, 'Flower Gathering: Special Summon which "Flower Cardian"?', cardians(e, p).filter((c) => !e.namesOf(c).some((nm) => used.includes(nm))));
        if (!s) break;
        used.push(s.name);
        tag(s).negated = 1;
        tag(s).noTribute = 1;
      }
    },
  };

  E['Worm Bait'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.monsters(p).some((m) => m.faceUp && raceOf(e, m) === 'Insect') && e.player(p).mz.filter((z) => z === null).length >= 2,
    *resolve(e, _l, p) {
      lockSummons(e, p, { normal: true, special: true, levels: [3, 4] }, `${e.player(p).name} cannot Normal or Special Summon Level 3 or 4 monsters this turn`);
      if (e.player(p).mz.filter((z) => z === null).length < 2) return;
      for (let i = 0; i < 2; i++) e.createToken('Worm Token', p, 'def', true, { atk: 0, def: 0, level: 1, attribute: 'EARTH', race: 'Insect' });
      e.log(p, `${e.player(p).name} Special Summons 2 Worm Tokens`);
    },
  };

  E['Fullmetalfoes Fusion'] = fusionSpell((f) => named(nameEngine(), f, 'Metalfoes'), 'Fullmetalfoes Fusion');

  // ======================= Traps =======================
  // A-Counters are kept in tags.aCounter.
  const alienOut = (e: Engine, p: Pid) => e.monsters(p).some((m) => m.faceUp && named(e, m, 'Alien'));
  const hypnoTargets = (e: Engine, p: Pid) => targetable(e, e.monsters(other(p)).filter((m) => (m.tags?.aCounter ?? 0) > 0));
  E['Mass Hypnosis'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && alienOut(e, p) && hypnoTargets(e, p).length > 0 && freeMZ(e, p),
    *resolve(e, link, p) {
      const fc = e.fieldCard(link.card.uid);
      if (!fc || !alienOut(e, p)) return;
      tag(fc).mhTurn = e.state.turn;
      const max = Math.min(3, e.player(p).mz.filter((z) => z === null).length);
      const chosen = yield* pick(e, p, `Mass Hypnosis: take control of up to ${max} monsters with A-Counters`, hypnoTargets(e, p), 1, max);
      const taken: number[] = [];
      for (const m of chosen ?? []) if (e.takeControl(m.uid, p)) taken.push(m.uid);
      fxMap<number[]>(e, 'massHypnosis')[fc.uid] = taken;
      if (taken.length) e.log(p, `${e.player(p).name} takes control of ${taken.length} monster${taken.length > 1 ? 's' : ''}`);
    },
    *onEndPhase(e, fc) {
      if (fc.tags?.mhTurn !== e.state.turn || !e.fieldCard(fc.uid)) return;
      e.log(null, 'Mass Hypnosis is destroyed');
      yield* e.destroy([fc.uid]);
    },
    *onLeaveField(e, fc) {
      for (const u of fxMap<number[]>(e, 'massHypnosis')[fc.uid] ?? []) {
        const m = e.fieldCard(u);
        if (m && e.controller(u) !== m.owner && e.takeControl(u, m.owner)) e.log(null, `${m.name} returns to its owner`);
      }
      delete fxMap<number[]>(e, 'massHypnosis')[fc.uid];
    },
  };

  E['A Feint Plan'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve(e, _l, p) {
      e.linger('A Feint Plan', p);
      e.log(p, 'Face-down monsters cannot be attacked this turn');
    },
    lingering: { attackGuard: (_e, _o, _a, target) => !target.faceUp },
  };

  E['Blast with Chain'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && targetable(e, faceUpMonsters(e, p)).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Blast with Chain: equip to which monster?', targetable(e, faceUpMonsters(e, p)), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = fieldTarget(e, link);
      const fc = e.fieldCard(link.card.uid);
      if (!m?.faceUp || !fc || e.controller(m.uid) !== p) return;
      h.attachTo(e, fc, m.uid);
      e.log(p, `Blast with Chain is equipped to ${m.name}`);
    },
    equipBonus: () => ({ atk: 500, def: 0 }),
    *onLeaveField(e, fc, p, reason) {
      if (reason !== 'destroyed' || fc.equippedTo === undefined) return;
      const list = [...targetable(e, allMonsters(e)), ...allST(e)];
      if (!list.length || !(yield* e.yesno(p, 'Blast with Chain: destroy 1 card on the field?'))) return;
      const t = yield* pickOne(e, p, 'Blast with Chain: destroy which card?', list);
      if (t) yield* e.as(p, e.destroy([t.uid]));
    },
  };

  const unionsOnField = (e: Engine, p: Pid) => e.monsters(p).filter((m) => m.faceUp && isUnion(e, m));
  const unionHosts = (e: Engine, p: Pid, u: FieldCard) => targetable(e, e.monsters(p).filter((m) => m.faceUp && m.uid !== u.uid));
  const equippedUnions = (e: Engine, p: Pid) => e.spells(p).filter((c) => c.equippedTo !== undefined && isUnion(e, c));
  const canEquipUnion = (e: Engine, p: Pid) => e.player(p).sz.filter((z) => z === null).length >= 1 && unionsOnField(e, p).some((u) => unionHosts(e, p, u).length > 0);
  E['Formation Union'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && (canEquipUnion(e, p) || (equippedUnions(e, p).length > 0 && freeMZ(e, p))),
    *activate(e, link, p) {
      const opts = [...(canEquipUnion(e, p) ? ['Equip a Union monster'] : []), ...(equippedUnions(e, p).length && freeMZ(e, p) ? ['Unequip a Union monster and Special Summon it'] : [])];
      const k = yield* chooseOption(e, p, 'Formation Union: which effect?', opts, true);
      if (k === null) return false;
      link.payload = { equip: opts[k].startsWith('Equip') };
    },
    *resolve(e, link, p) {
      if ((link.payload as { equip: boolean }).equip) {
        const u = yield* pickOne(e, p, 'Formation Union: equip which Union monster?', unionsOnField(e, p).filter((x) => unionHosts(e, p, x).length > 0));
        if (!u) return;
        const host = yield* pickOne(e, p, `Equip ${u.name} to which monster?`, unionHosts(e, p, u));
        if (host) yield* equipMonster(e, u, host, p);
        return;
      }
      const u = yield* pickOne(e, p, 'Formation Union: unequip which Union monster?', equippedUnions(e, p));
      if (!u || !freeMZ(e, p)) return;
      const host = u.equippedTo !== undefined ? e.fieldCard(u.equippedTo) : null;
      if (host) host.equips = host.equips.filter((x) => x !== u.uid);
      u.equippedTo = undefined;
      yield* e.specialSummon(u.uid, p, 'atk');
    },
  };

  const KNIGHTS = ["Queen's Knight", "King's Knight", "Jack's Knight"];
  const listsKnights = (e: Engine, c: Card) => isSpell(e, c) && KNIGHTS.every((n) => info(e, c).desc.includes(`"${n}"`));
  const jokerSpells = (e: Engine, p: Pid, ctx: ChainCtx) => e.player(p).deck.filter((c) => listsKnights(e, c) && !!e.effectOn(c)?.resolve && (e.effectOn(c)!.canActivate?.(e, c, p, 'main', ctx) ?? true));
  E["Joker's Wild"] = {
    canActivate: (e, _c, p, t, ctx) => anyTime(t) && (e.state.phase === 'M1' || e.state.phase === 'BP') && e.oncePerTurn("Joker's Wild:1", p) && jokerSpells(e, p, ctx).length > 0,
    *activate(e, link, p, ctx) {
      const s = yield* pickOne(e, p, "Joker's Wild: send which Spell from your Deck to the GY?", jokerSpells(e, p, ctx), true);
      if (!s) return false;
      e.useOnce("Joker's Wild:1", p);
      yield* e.sendToGrave(s.uid, 'cost');
      e.player(p).deck = e.shuffle(e.player(p).deck);
      fxMap<string>(e, 'jokersWild')[link.card.uid] = s.name;
      e.log(p, `Joker's Wild takes on the effect of ${s.name}`);
      const inner = e.effectOn(s)?.activate;
      if (inner) return yield* inner(e, link, p, ctx);
    },
    *resolve(e, link, p) {
      const name = fxMap<string>(e, 'jokersWild')[link.card.uid];
      const eff = name ? e.effectOn({ uid: -1, name, owner: p }) : undefined;
      if (eff?.resolve) yield* eff.resolve(e, link, p);
    },
    *onEndPhaseInGrave(e, card, p) {
      const ok = (c: Card) => isMonster(e, c) && attrOf(e, c) === 'LIGHT' && info(e, c).race === 'Warrior';
      if (!e.oncePerTurn("Joker's Wild:2", p) || !e.player(p).gy.some(ok) || !(yield* e.yesno(p, "Joker's Wild: shuffle a LIGHT Warrior from your GY into the Deck and add this card to your hand?"))) return;
      const t = yield* pickOne(e, p, 'Shuffle which LIGHT Warrior into the Deck?', e.player(p).gy.filter(ok));
      if (!t) return;
      e.useOnce("Joker's Wild:2", p);
      toDeck(e, t.uid);
      if (zoneOf(e, t.uid) !== 'deck' || zoneOf(e, card.uid) !== 'gy') return;
      e.toHandOf(card.uid, p);
      e.log(p, `${e.player(p).name} adds Joker's Wild to the hand`);
    },
  };

  // fx.pharaoh[uid] = the event number when it was shuffled face-up into the Deck.
  E["Pharaoh's Treasure"] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve(e, link, p) {
      if (!e.fieldCard(link.card.uid)) return;
      toDeck(e, link.card.uid);
      const seq = (e.state.events ?? []).reduce((a, ev) => Math.max(a, ev.seq ?? 0), 0);
      fxMap<number>(e, 'pharaoh')[link.card.uid] = seq;
      e.log(p, "Pharaoh's Treasure is shuffled face-up into the Deck");
    },
    *inHand(e, card, p) {
      const marks = fxMap<number>(e, 'pharaoh');
      const since = marks[card.uid];
      if (since === undefined) return;
      delete marks[card.uid];
      const drawn = (e.state.events ?? []).some((ev) => ev.kind === 'draw' && ev.uid === card.uid && (ev.seq ?? 0) > since);
      if (!drawn) return;
      e.log(p, `${e.player(p).name} drew the face-up Pharaoh's Treasure`);
      yield* e.sendToGrave(card.uid, 'used');
      const t = yield* pickOne(e, p, "Pharaoh's Treasure: add which card from your GY to your hand?", e.player(p).gy.filter((c) => c.uid !== card.uid));
      if (!t) return;
      e.toHandOf(t.uid, p);
      e.log(p, `${e.player(p).name} adds ${t.name} from the GY to the hand`);
    },
  };
}
