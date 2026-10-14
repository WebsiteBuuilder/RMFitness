// Speed Duel card scripts, batch 08 (Mixeroid ... Rainbow Overdragon).
import type { EffectDef } from '../effects';
import { nameEngine } from '../names';
import type { SpeedHelpers } from './helpers';
import {
  allMonsters,
  allST,
  anyTime,
  type Card,
  type ChainCtx,
  chooseOption,
  ctrl,
  discardCost,
  type Engine,
  faceUpMonsters,
  type FieldCard,
  freeMZ,
  freeST,
  type Gen,
  info,
  isExtraOrRitual,
  isMain,
  isMonster,
  isSpell,
  isTrap,
  levelOf,
  named,
  negateMonster,
  noBattleDamage,
  opponentAttack,
  other,
  payLp,
  type Pid,
  pick,
  pickOne,
  raceOf,
  attrOf,
  searchDeck,
  stOf,
  type Step,
  summonOneOf,
  tag,
  targetable,
  toDeck,
  boostPerm,
  boostTurn,
  tributeCost,
} from './helpers';

// ---------- local helpers ----------
const fx = (e: Engine) => e.state.fx as Record<string, any>;
const freeZones = (e: Engine, p: Pid) => e.player(p).mz.filter((z) => z === null).length;
const isFusion = (e: Engine, c: Card) => info(e, c).sub === 'Fusion';
const isNormal = (e: Engine, c: Card) => isMonster(e, c) && info(e, c).sub === 'Normal';
const isFlipMonster = (e: Engine, c: Card) => isMonster(e, c) && /FLIP:/i.test(info(e, c).desc);
/** The monster this one is battling right now (null when none / direct attack). */
const foeOf = (e: Engine, uid: number): FieldCard | null => {
  const b = e.state.battle;
  if (!b || b.target === null) return null;
  if (b.attacker === uid) return e.fieldCard(b.target);
  if (b.target === uid) return e.fieldCard(b.attacker);
  return null;
};
/** A battle between a monster `p` controls and an opponent's monster (the attack window). */
const myBattle = (e: Engine, p: Pid): FieldCard | null => {
  const b = e.state.battle;
  if (!b || b.target === null) return null;
  const a = e.fieldCard(b.attacker);
  const t = e.fieldCard(b.target);
  if (!a || !t) return null;
  if (e.controller(a.uid) === p && e.controller(t.uid) === other(p)) return a;
  if (e.controller(t.uid) === p && e.controller(a.uid) === other(p)) return t;
  return null;
};

/** Moves a card off the field to the hand / top of the Deck / into the Deck. Fusion Monsters go back to the Extra Deck, Tokens vanish. */
function* leaveField(e: Engine, uid: number, where: 'hand' | 'top' | 'deck'): Step {
  const f = e.find(uid);
  if (!f) return;
  const fc = e.fieldCard(uid);
  if (fc) {
    for (const eq of fc.equips.slice()) if (e.fieldCard(eq)) yield* e.sendToGrave(eq, 'used');
    if (fc.equippedTo !== undefined) {
      const host = e.fieldCard(fc.equippedTo);
      if (host) host.equips = host.equips.filter((u) => u !== uid);
    }
  }
  if (f.card.token) {
    yield* e.sendToGrave(uid, 'used');
    return;
  }
  const owner = f.card.owner;
  if (isFusion(e, f.card)) {
    e.toHand(uid);
    const ps = e.player(owner);
    const i = ps.hand.findIndex((c) => c.uid === uid);
    if (i >= 0) ps.fusion.push(ps.hand.splice(i, 1)[0]);
    return;
  }
  if (where === 'hand') e.toHand(uid);
  else {
    e.toDeckTop(uid);
    if (where === 'deck') e.player(owner).deck = e.shuffle(e.player(owner).deck);
  }
}

/** Places a card from the GY/Deck/hand face-up in a Spell & Trap Zone (Gravekeeper's Trap, Pumprincess). */
function placeInST(e: Engine, uid: number, p: Pid): FieldCard | null {
  const z = freeST(e, p);
  const f = e.find(uid);
  if (z < 0 || !f || !['gy', 'deck', 'hand'].includes(f.loc.zone)) return null;
  const from = e.player(f.loc.player)[f.loc.zone as 'gy' | 'deck' | 'hand'];
  from.splice(f.loc.index, 1);
  const c = f.card;
  const fc: FieldCard = { uid: c.uid, name: c.name, owner: c.owner, pos: 'atk', faceUp: true, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true };
  e.player(p).sz[z] = fc;
  e.event('set', { uid, player: p });
  e.log(p, `${e.player(p).name} places ${c.name} face-up in the Spell & Trap Zone`);
  return fc;
}

/** Fusion Monsters (passing `ok`) whose listed materials can all be found in `pool`, and a way to pick them. */
function fusionCands(e: Engine, p: Pid, pool: Card[], ok: (f: Card) => boolean) {
  const out: { fusion: Card; ids: number[] }[] = [];
  for (const f of e.player(p).fusion) {
    if (!ok(f)) continue;
    const ids = e.fusionMaterials(f.name);
    if (ids && assign(e, pool, ids, [])) out.push({ fusion: f, ids });
  }
  return out;
}
function assign(e: Engine, pool: Card[], ids: number[], used: number[]): boolean {
  if (!ids.length) return true;
  return pool.some((c) => !used.includes(c.uid) && info(e, c).id === ids[0] && assign(e, pool, ids.slice(1), [...used, c.uid]));
}
function* chooseFusion(e: Engine, p: Pid, title: string, pool: Card[], ok: (f: Card) => boolean): Gen<{ fusion: number; mats: number[] } | null> {
  const plans = fusionCands(e, p, pool, ok);
  const plan = yield* pickOne(e, p, title, plans.map((x) => x.fusion), true);
  if (!plan) return null;
  const ids = plans.find((x) => x.fusion.uid === plan.uid)!.ids;
  const chosen: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const free = pool.filter((c) => !chosen.includes(c.uid) && info(e, c).id === ids[i] && assign(e, pool, ids.slice(i + 1), [...chosen, c.uid]));
    const c = yield* pickOne(e, p, `Use which ${free[0]?.name ?? 'material'}?`, free, true);
    if (!c) return null;
    chosen.push(c.uid);
  }
  return { fusion: plan.uid, mats: chosen };
}

/** A Trap that can also Special Summon itself from the GY as a Normal Monster (Paleozoic). */
function paleozoic(base: EffectDef): EffectDef {
  return {
    ...base,
    baseStats: (e, m) => (e.find(m.uid)?.loc.zone === 'mz' ? { atk: 1200, def: 0 } : undefined),
    // Once per Chain (repeat: a card can only be Summoned from the GY once anyway).
    quick: {
      from: 'gy',
      label: 'Special Summon it as a monster',
      repeat: true,
      can: (e, _c, p, t, ctx) => t === 'trap' && !!ctx.link && freeMZ(e, p),
      *run(e, c, p) {
        if (e.find(c.uid)?.loc.zone !== 'gy' || !freeMZ(e, p)) return;
        // A Normal Monster (Aqua/WATER/Level 2) while it is in a Monster Zone.
        ((fx(e).trapMonster ??= {}) as Record<number, unknown>)[c.uid] = { race: 'Aqua', attribute: 'WATER', level: 2 };
        yield* e.specialSummon(c.uid, p, 'atk');
        const m = e.fieldCard(c.uid);
        if (m) tag(m).paleo = 1;
      },
    },
    // Unaffected by monster effects. Approximation: only their destruction effects (targeting is not blocked).
    effectProof: (e, m) => !!m.tags?.paleo && e.resolvingKind() === 'monster',
    // Banished when it leaves the field (wherever it went).
    *onLeaveField(e, fc) {
      if (!fc.tags?.paleo || e.find(fc.uid)?.loc.zone === 'removed') return;
      e.banish(fc.uid);
    },
  };
}

const crystalNames = (e: Engine, p: Pid) => {
  const names = new Set<string>();
  for (const c of [...e.monsters(p), ...e.spells(p)]) if (c.faceUp && named(e, c, 'Crystal Beast')) names.add(c.name);
  for (const c of e.player(p).gy) if (named(e, c, 'Crystal Beast')) names.add(c.name);
  return names.size;
};
const ultimateCrystal = (e: Engine, c: Card) => isMonster(e, c) && (named(e, c, 'Ultimate Crystal') || info(e, c).desc.includes('treated as an "Ultimate Crystal"'));

/** Shuffles every card on the field into the Deck (Rainbow Dragon). */
function* shuffleField(e: Engine): Step {
  for (const p of [0, 1] as Pid[]) for (const c of stOf(e, p)) if (e.fieldCard(c.uid)) yield* leaveField(e, c.uid, 'top');
  for (const p of [0, 1] as Pid[]) for (const m of e.monsters(p)) if (e.fieldCard(m.uid)) yield* leaveField(e, m.uid, 'top');
  for (const p of [0, 1] as Pid[]) e.player(p).deck = e.shuffle(e.player(p).deck);
}

/**
 * "Cannot be Special Summoned except by its own procedure" (unless an effect ignores the Summoning conditions). Approximation: a
 * Special Summon from the hand outside any chain counts as the procedure (the engine checks the rule before running it).
 */
const procOnly: EffectDef['summonRule'] = (e, c, _p, how, from) => how !== 'special' || fx(e).procSummon === c.uid || (from === 'hand' && fx(e).procSummon === undefined && !e.state.chain.length && !e.resolvingCard());
function* procSummon(e: Engine, c: Card, p: Pid): Step {
  fx(e).procSummon = c.uid;
  try {
    yield* e.specialSummon(c.uid, p, 'atk');
  } finally {
    fx(e).procSummon = undefined;
  }
}

export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  // ---------- M ----------
  const roid = (c: Card) => named(nameEngine(), c, 'roid') && !named(nameEngine(), c, 'Necroid');
  E['Mixeroid'] = {
    ignition: {
      can: (e, m, p) => e.oncePerTurn('Mixeroid:1', p) && e.monsters(p).some((x) => raceOf(e, x) === 'Machine') && e.player(p).deck.some((c) => isMonster(e, c) && roid(c) && attrOf(e, c) !== 'WIND' && !isExtraOrRitual(e, c)),
      *run(e, m, p) {
        e.useOnce('Mixeroid:1', p);
        if (!(yield* tributeCost(e, p, 1, (x) => raceOf(e, x) === 'Machine'))) return;
        yield* summonOneOf(e, p, 'Mixeroid: Special Summon which "roid" monster?', e.player(p).deck.filter((c) => isMonster(e, c) && roid(c) && attrOf(e, c) !== 'WIND' && !isExtraOrRitual(e, c)));
      },
    },
    graveIgnition: {
      can: (e, card, p) => {
        if (!e.oncePerTurn('Mixeroid:2', p) || !freeMZ(e, p) || e.player(p).lp < 2) return false;
        const n = e.player(p).gy.filter((c) => isMonster(e, c) && info(e, c).race === 'Machine').length;
        return e.player(p).fusion.some((f) => roid(f) && levelOf(e, f) >= 1 && levelOf(e, f) <= n);
      },
      *run(e, card, p) {
        const machines = e.player(p).gy.filter((c) => c.uid !== card.uid && isMonster(e, c) && info(e, c).race === 'Machine');
        const fus = e.player(p).fusion.filter((f) => roid(f) && levelOf(e, f) >= 1 && levelOf(e, f) <= machines.length + 1);
        const f = yield* pickOne(e, p, 'Mixeroid: Special Summon which "roid" Fusion Monster?', fus, true);
        if (!f) return;
        const n = levelOf(e, f);
        const rest = yield* pick(e, p, `Mixeroid: banish ${n - 1} other Machine monster(s) from the GY`, machines, n - 1, n - 1, true);
        if (!rest) return;
        e.useOnce('Mixeroid:2', p);
        e.payLp(p, Math.floor(e.player(p).lp / 2));
        e.banish(card.uid);
        for (const c of rest) e.banish(c.uid);
        if (!freeMZ(e, p) || e.find(f.uid)?.loc.zone !== 'fusion') return;
        // Ignoring its Summoning conditions.
        fx(e).ignoreCond = f.uid;
        try {
          yield* e.specialSummon(f.uid, p, 'atk');
        } finally {
          fx(e).ignoreCond = undefined;
        }
        const m = e.fieldCard(f.uid);
        if (m) m.doomAt = e.state.turn;
      },
    },
  };

  E['Mobius the Frost Monarch'] = {
    *onSummon(e, _m, p, kind) {
      if (kind !== 'normal') return;
      const list = allST(e);
      if (!list.length || !(yield* e.yesno(p, 'Mobius: destroy up to 2 Spell/Trap Cards?'))) return;
      const chosen = yield* pick(e, p, 'Mobius: destroy which Spell/Trap Cards?', list, 1, 2, true);
      if (chosen) yield* e.destroy(chosen.map((c) => c.uid).filter((u) => e.fieldCard(u)));
    },
  };

  // Tribute Summoning with 3 Tributes is done through this procedure: the 3 Tributes are paid, then it is Normal (Tribute) Summoned
  // with no further Tributes (it uses up the Normal Summon). The usual 2-Tribute Summon stays available and does nothing more.
  E['Moisture Creature'] = {
    tributeOffer: (e, src, _p, card) => (src === null && fx(e).moisture3 === card.uid ? { need: 0 } : undefined),
    summonProc: {
      can: (e, c, p) => !e.player(p).normalSummoned && e.monsters(p).filter((m) => !e.untributable(m)).length >= 3 && !e.summonBlocked(p, c, 'normal', 'hand'),
      *run(e, c, p) {
        if (!(yield* tributeCost(e, p, 3))) return;
        fx(e).moisture3 = c.uid;
        try {
          yield* e.extraNormalSummon(p, c.uid, 'atk', true);
        } finally {
          fx(e).moisture3 = undefined;
        }
        e.player(p).normalSummoned = true;
        const m = e.fieldCard(c.uid);
        if (!m) return;
        e.log(p, 'Moisture Creature destroys all Spell and Trap Cards the opponent controls');
        yield* e.destroy(stOf(e, other(p)).map((x) => x.uid));
      },
    },
  };

  const mokey = (c: Card) => nameEngine().isNamed(c, 'Mokey Mokey') || nameEngine().isNamed(c, 'Mokey Mokey Adrift');
  // Approximation: on the field its name counts as "Mokey Mokey" (for Fusion Materials); in the GY the "Mokey Mokey" cards here accept it too.
  E['Mokey Mokey Adrift'] = {
    fieldName: () => 'Mokey Mokey',
    handIgnition: {
      can: (e, _c, p) => e.player(p).deck.some((c) => named(e, c, 'Mokey Mokey') && !e.isNamed(c, 'Mokey Mokey Adrift')),
      *run(e, c, p) {
        yield* e.discard(p, c.uid);
        yield* searchDeck(e, p, 'Add which "Mokey Mokey" card?', (x) => named(e, x, 'Mokey Mokey') && !e.isNamed(x, 'Mokey Mokey Adrift'));
      },
    },
  };

  E['Mokey Mokey King'] = {
    *onLeaveField(e, fc, p) {
      if (fc.token || e.find(fc.uid)?.loc.zone === 'mz') return;
      const list = e.player(p).gy.filter(mokey);
      if (!list.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Mokey Mokey King: Special Summon "Mokey Mokey" from the GY?'))) return;
      for (const c of list.slice(0, freeZones(e, p))) if (e.find(c.uid)?.loc.zone === 'gy') yield* e.specialSummon(c.uid, p, 'atk');
    },
  };

  E['Mokey Mokey Smackdown'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    *onAnyToGrave(e, _card, p, events) {
      if (!events.some((ev) => ev.from === 'mz' && ev.controller === p && ev.reason === 'destroyed' && ev.race === 'Fairy')) return;
      const list = e.monsters(p).filter((m) => m.faceUp && mokey(m));
      if (list.length) e.log(p, 'Mokey Mokey Smackdown: each "Mokey Mokey" becomes 3000 ATK');
      for (const m of list) boostTurn(m, 3000 - e.atkOf(m));
    },
  };

  const battleKillThisTurn = (e: Engine) => ((fx(e).destroyedLog ?? []) as { byBattle: boolean; turn: number }[]).some((x) => x.byBattle && x.turn === e.state.turn);
  E['Monster Rebirth'] = {
    canActivate: (e, _c, p, t) => (anyTime(t) || t === 'destroyed') && battleKillThisTurn(e) && freeMZ(e, p) && [...e.player(p).hand, ...e.player(p).deck].some((c) => e.isNamed(c, 'Monster Reborn')) && [...e.player(0).gy, ...e.player(1).gy].some((c) => isMonster(e, c) && !isExtraOrRitual(e, c)),
    *activate(e, link, p) {
      const mr = yield* pickOne(e, p, 'Send which "Monster Reborn" to the GY?', [...e.player(p).hand, ...e.player(p).deck].filter((c) => e.isNamed(c, 'Monster Reborn')), true);
      if (!mr) return false;
      const fromDeck = e.find(mr.uid)?.loc.zone === 'deck';
      yield* e.sendToGrave(mr.uid, 'cost');
      if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
      const t = yield* pickOne(e, p, 'Monster Rebirth: Special Summon which monster?', [...e.player(p).gy, ...e.player(other(p)).gy].filter((c) => isMonster(e, c) && !isExtraOrRitual(e, c)));
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid !== undefined && e.find(link.targetUid)?.loc.zone === 'gy') yield* e.specialSummon(link.targetUid, p, 'atk');
    },
  };

  const water = (e: Engine) => (c: Card) => isMonster(e, c) && attrOf(e, c) === 'WATER';
  E['Moray of Greed'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).hand.filter(water(e)).length >= 2 && e.player(p).deck.length >= 1,
    *resolve(e, _l, p) {
      const chosen = yield* pick(e, p, 'Moray of Greed: shuffle which 2 WATER monsters into the Deck?', e.player(p).hand.filter(water(e)), 2, 2);
      if (!chosen || chosen.length < 2) return;
      for (const c of chosen) toDeck(e, c.uid);
      e.draw(p, 3);
    },
  };

  E['Mudora'] = {
    selfBonus: (e, m) => ({ atk: 200 * e.player(ctrl(e, m)).gy.filter((c) => isMonster(e, c) && info(e, c).race === 'Fairy').length, def: 0 }),
  };

  const mudoraTargets = (e: Engine) => [...e.player(0).gy, ...e.player(1).gy];
  const mudoraMax = (e: Engine, p: Pid) => (stOf(e, p).some((c) => c.faceUp && e.isNamed(c, 'Exchange of the Spirit')) || e.player(p).gy.some((c) => e.isNamed(c, 'Exchange of the Spirit')) ? 5 : 3);
  E['Mudora the Sword Oracle'] = {
    handIgnition: {
      can: (e, c, p) => e.oncePerTurn('Mudora the Sword Oracle:1', p) && freeMZ(e, p) && e.player(p).hand.some((x) => x.uid !== c.uid && isMonster(e, x) && attrOf(e, x) === 'EARTH' && info(e, x).race === 'Fairy'),
      *run(e, c, p) {
        if (!(yield* discardCost(e, p, 1, (x) => isMonster(e, x) && attrOf(e, x) === 'EARTH' && info(e, x).race === 'Fairy', c.uid))) return;
        e.useOnce('Mudora the Sword Oracle:1', p);
        yield* e.specialSummon(c.uid, p, 'atk');
        const trap = e.player(p).deck.find((x) => e.isNamed(x, "Gravekeeper's Trap"));
        if (trap && freeST(e, p) >= 0 && (yield* e.yesno(p, `Place "Gravekeeper's Trap" from the Deck face-up?`))) {
          placeInST(e, trap.uid, p);
          e.player(p).deck = e.shuffle(e.player(p).deck);
        }
      },
    },
    quick: {
      label: 'banish it to shuffle cards from the GYs into the Deck',
      can: (e, _c, p) => e.oncePerTurn('Mudora the Sword Oracle:2', p) && mudoraTargets(e).length > 0,
      *cost(e, card, p, link) {
        const max = mudoraMax(e, p);
        e.useOnce('Mudora the Sword Oracle:2', p);
        e.banish(card.uid);
        const chosen = yield* pick(e, p, `Mudora: shuffle up to ${max} cards from the GYs into the Deck`, mudoraTargets(e), 1, max);
        link.payload = { ...(link.payload as object), uids: (chosen ?? []).map((c) => c.uid) };
      },
      *run(e, _c, _p, link) {
        for (const u of (link.payload as { uids: number[] }).uids) if (e.find(u)?.loc.zone === 'gy') toDeck(e, u);
      },
    },
    graveIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Mudora the Sword Oracle:2', p) && mudoraTargets(e).length > 1,
      *run(e, card, p) {
        const max = mudoraMax(e, p);
        e.useOnce('Mudora the Sword Oracle:2', p);
        e.banish(card.uid);
        const chosen = yield* pick(e, p, `Mudora: shuffle up to ${max} cards from the GYs into the Deck`, mudoraTargets(e), 1, max);
        for (const c of chosen ?? []) if (e.find(c.uid)?.loc.zone === 'gy') toDeck(e, c.uid);
      },
    },
  };

  E['Multiplication of Ants'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.monsters(p).some((m) => raceOf(e, m) === 'Insect' && m.faceUp) && freeZones(e, p) >= 1,
    *activate(e, _l, p) {
      if (!(yield* tributeCost(e, p, 1, (m) => raceOf(e, m) === 'Insect' && m.faceUp))) return false;
    },
    *resolve(e, _l, p) {
      if (freeZones(e, p) < 2) return;
      for (let i = 0; i < 2; i++) e.createToken('Army Ant Token', p, 'atk', true, { atk: 500, def: 1200, level: 4, attribute: 'EARTH', race: 'Insect' });
    },
  };
  // Approximation: "cannot be used as a Tribute for a Tribute Summon" is applied to every Tribute.
  E['Army Ant Token'] = { cannotBeTributed: () => true };

  E['Musto, Oracle of Gusto'] = {
    ignition: {
      can: (e, _m, p) => e.player(p).gy.some((c) => isMonster(e, c) && named(e, c, 'Gusto')) && targetable(e, faceUpMonsters(e)).length > 0,
      *run(e, _m, p) {
        const g = yield* pickOne(e, p, 'Musto: shuffle which "Gusto" monster into the Deck?', e.player(p).gy.filter((c) => isMonster(e, c) && named(e, c, 'Gusto')));
        const t = yield* pickOne(e, p, "Musto: negate which monster's effects?", targetable(e, faceUpMonsters(e)));
        if (!g || !t) return;
        toDeck(e, g.uid);
        if (e.fieldCard(t.uid)?.faceUp) negateMonster(e, t, true);
      },
    },
  };

  E['Mysterious Guard'] = {
    *flip(e, _m, p) {
      const first = yield* pickOne(e, p, 'Mysterious Guard: return which monster to the top of the Deck?', targetable(e, faceUpMonsters(e)));
      if (!first) return;
      const warrior = () => e.monsters(p).some((m) => m.faceUp && raceOf(e, m) === 'Warrior');
      let second: FieldCard | null = null;
      const rest = targetable(e, faceUpMonsters(e)).filter((m) => m.uid !== first.uid);
      if (warrior() && rest.length && (yield* e.yesno(p, 'Target 1 more monster to return to the hand?'))) second = yield* pickOne(e, p, 'Return which monster to the hand?', rest);
      if (e.fieldCard(first.uid)) yield* leaveField(e, first.uid, 'top');
      if (second && e.fieldCard(second.uid) && warrior()) yield* leaveField(e, second.uid, 'hand');
    },
  };

  const temple = (e: Engine, p: Pid) => !!e.anyActive('Temple of the Kings', p);
  const serketCheck = function* (e: Engine, m: FieldCard, p: Pid): Step {
    if (!temple(e, p) && e.fieldCard(m.uid)) {
      e.log(p, 'Mystical Beast of Serket is destroyed (no "Temple of the Kings")');
      yield* e.destroy([m.uid]);
    }
  };
  const serketWin = function* (e: Engine, m: FieldCard, victim: Card) {
    if (e.find(victim.uid)?.loc.zone === 'gy') e.banish(victim.uid);
    if (e.fieldCard(m.uid)) boostPerm(m, 500);
  };
  E['Mystical Beast of Serket'] = {
    stateCheck: serketCheck,
    *afterBattle(e, m, target, _p, destroyed) {
      if (destroyed) yield* serketWin(e, m, target);
    },
    *onAttacked(e, m, attacker) {
      if (e.fieldCard(m.uid) && !e.fieldCard(attacker.uid)) yield* serketWin(e, m, attacker);
    },
  };

  // ---------- N ----------
  const neos = (c: Card) => named(nameEngine(), c, 'Neo-Spacian') || nameEngine().isNamed(c, 'Elemental HERO Neos');
  const nextCands = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.player(p).gy].filter((c) => isMonster(e, c) && neos(c) && !isExtraOrRitual(e, c));
  const nextRun = function* (e: Engine, p: Pid): Step {
    const chosen: Card[] = [];
    while (freeZones(e, p) > chosen.length) {
      const opts = nextCands(e, p).filter((c) => !chosen.some((x) => e.sameName(x, c)));
      if (!opts.length) break;
      const c = yield* pickOne(e, p, 'NEXT: Special Summon which monster? (cancel to stop)', opts, chosen.length > 0);
      if (!c) break;
      chosen.push(c);
    }
    const uids: number[] = [];
    for (const c of chosen) {
      yield* e.specialSummon(c.uid, p, 'def');
      const m = e.fieldCard(c.uid);
      if (m) negateMonster(e, m, false);
      if (m) uids.push(m.uid);
    }
    // While you control any of them face-up, only Fusion Monsters can be Special Summoned from the Extra Deck (engine: fx.extraLockBy).
    if (uids.length) ((fx(e).extraLockBy ??= []) as { p: Pid; uids: number[] }[]).push({ p, uids });
  };
  const nextOk = (e: Engine, p: Pid) => e.oncePerTurn('NEXT', p) && freeMZ(e, p) && nextCands(e, p).length > 0;
  E['NEXT'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && nextOk(e, p),
    *activate(e, _link, p) {
      e.useOnce('NEXT', p);
    },
    *resolve(e, _l, p) {
      yield* nextRun(e, p);
    },
    // "If you control no cards, you can activate this card from your hand" (offered like a Quick Effect from the hand).
    quick: {
      from: 'hand',
      label: 'activate it from your hand',
      repeat: true,
      can: (e, _c, p, t) => anyTime(t) && nextOk(e, p) && freeST(e, p) >= 0 && !e.monsters(p).length && !stOf(e, p).length,
      *cost(e, c, p) {
        e.useOnce('NEXT', p);
        if (!placeInST(e, c.uid, p)) return false;
      },
      *run(e, c, p) {
        yield* nextRun(e, p);
        if (e.fieldCard(c.uid)) yield* e.sendToGrave(c.uid, 'used');
      },
    },
  };

  E['Needle Sunfish'] = {
    *onSentToGrave(e, _c, p) {
      const t = yield* pickOne(e, p, 'Needle Sunfish: which monster loses 500 ATK?', targetable(e, faceUpMonsters(e, other(p))));
      if (t && e.fieldCard(t.uid)) boostPerm(t, -500);
    },
  };

  const neosFusion = (e: Engine, m: FieldCard) => isFusion(e, m) && info(e, m).desc.includes('"Elemental HERO Neos"');
  E['Neo Space'] = {
    ...h.fieldSpell((e, m) => (e.isNamed(m, 'Elemental HERO Neos') || neosFusion(e, m) ? { atk: 500, def: 0 } : undefined)),
    // Approximation: those Fusion Monsters always choose not to apply their End Phase effects (they stay on the field).
    skipsEndPhase: (e, _src, _p, m) => neosFusion(e, m),
  };

  E['Neo-Spacian Air Hummingbird'] = {
    ignition: {
      can: (e, _m, p) => e.player(other(p)).hand.length > 0,
      *run(e, _m, p) {
        e.gainLp(p, 500 * e.player(other(p)).hand.length);
      },
    },
  };

  E['Neo-Spacian Aqua Dolphin'] = {
    ignition: {
      can: (e, _m, p) => e.player(p).hand.length > 0,
      *run(e, _m, p) {
        if (!(yield* discardCost(e, p, 1))) return;
        const opp = e.player(other(p)).hand;
        yield* e.reveal(p, "Your opponent's hand", opp);
        const c = yield* pickOne(e, p, 'Aqua Dolphin: choose a monster', opp.filter((x) => isMonster(e, x)));
        if (!c) return;
        if (e.monsters(p).some((m) => m.faceUp && e.atkOf(m) >= (info(e, c).atk ?? 0))) {
          yield* e.sendToGrave(c.uid, 'destroyed');
          e.log(p, `Aqua Dolphin destroys ${c.name}`);
          e.damage(other(p), 500);
        } else e.damage(p, 500);
      },
    },
  };

  E['Neo-Spacian Glow Moss'] = {
    *onAttackDeclared(e, card, p, attacker, target) {
      const m = e.fieldCard(card.uid);
      if (!m || (attacker.uid !== m.uid && target?.uid !== m.uid)) return;
      const opp = other(p);
      if (!e.draw(opp, 1)) return;
      const c = e.player(opp).hand[e.player(opp).hand.length - 1];
      e.log(opp, `${e.player(opp).name} draws and shows ${c.name}`);
      const b = e.state.battle;
      if (isMonster(e, c)) {
        e.log(p, 'Glow Moss: the Battle Phase ends');
        e.endBattle();
        for (const x of e.monsters(e.state.turnPlayer)) x.attacked = true;
      } else if (isSpell(e, c)) {
        if (b && b.attacker === m.uid && b.target !== null && (yield* e.yesno(p, 'Glow Moss: change to a direct attack?'))) b.target = null;
      } else if (m.pos === 'atk') {
        m.pos = 'def';
        e.event('position', { uid: m.uid });
        e.log(p, 'Glow Moss changes to Defense Position');
      }
    },
  };

  E['Neo-Spacian Grand Mole'] = {
    quick: {
      label: 'return both monsters to the hand',
      can: (e, card, p, t) => t === 'attack' && !!foeOf(e, card.uid) && e.controller(foeOf(e, card.uid)!.uid) === other(p),
      *run(e, card) {
        const foe = foeOf(e, card.uid);
        if (!foe || !e.fieldCard(card.uid)) return;
        yield* leaveField(e, foe.uid, 'hand');
        yield* leaveField(e, card.uid, 'hand');
        e.endBattle();
      },
    },
  };

  E['Neos Force'] = h.equipFor((e, m) => e.isNamed(m, 'Elemental HERO Neos'), () => ({ atk: 800, def: 0 }), {
    *afterAnyBattle(e, eq, _p, attacker, target) {
      const host = eq.equippedTo !== undefined ? e.fieldCard(eq.equippedTo) : null;
      if (!host || !target) return;
      const foe = host.uid === attacker.uid ? target : host.uid === target.uid ? attacker : null;
      if (foe && e.find(foe.uid)?.loc.zone === 'gy') {
        const n = info(e, foe).atk ?? 0;
        e.log(ctrl(e, eq), `Neos Force inflicts ${n} damage`);
        e.damage(other(ctrl(e, host)), n);
      }
    },
    *onEndPhase(e, card) {
      if (e.fieldCard(card.uid)) yield* leaveField(e, card.uid, 'deck');
    },
  });

  const destroyAny = (prompt: string) =>
    function* (e: Engine, p: Pid, list: FieldCard[]): Step {
      const t = yield* pickOne(e, p, prompt, targetable(e, list));
      if (t && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
    };
  E['Newdoria'] = {
    *onDestroyed(e, _c, p, byBattle) {
      if (byBattle) yield* destroyAny('Newdoria: destroy which monster?')(e, p, allMonsters(e));
    },
  };

  E['Night Assailant'] = {
    *flip(e, _m, p) {
      yield* destroyAny('Night Assailant: destroy which monster?')(e, p, e.monsters(other(p)));
    },
    *onSentToGrave(e, c, p, from) {
      if (from !== 'hand') return;
      const t = yield* pickOne(e, p, 'Night Assailant: add which Flip monster to the hand?', e.player(p).gy.filter((x) => x.uid !== c.uid && isFlipMonster(e, x)));
      if (t) e.toHandOf(t.uid, p);
    },
  };

  E['Night Beam'] = {
    canActivate: (e, _c, p, t) => isMain(t) && stOf(e, other(p)).some((c) => !c.faceUp),
    *activate(e, link, p) {
      const t = yield* pickOne(e, p, 'Night Beam: destroy which Set card?', stOf(e, other(p)).filter((c) => !c.faceUp), true);
      if (!t) return false;
      link.targetUid = t.uid;
      // Your opponent cannot activate the targeted card in response (a "cannot be activated this turn" mark, cleared on resolution).
      tag(t).noActTurn = e.state.turn;
    },
    *resolve(e, link) {
      const t = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (t?.tags) delete t.tags.noActTurn;
      if (t) yield* e.destroy([t.uid]);
    },
  };

  /** A "Penguin" card returns a card from the field to the hand: banished instead while "Nopenguin" is face-up (only this batch's Penguin cards use it). */
  const penguinBounce = function* (e: Engine, uid: number): Step {
    if (allMonsters(e).some((m) => m.faceUp && e.isNamed(m, 'Nopenguin') && !e.isNegated(m))) {
      e.log(null, 'Nopenguin: the card is banished instead');
      e.banish(uid);
      return;
    }
    yield* leaveField(e, uid, 'hand');
  };
  E['Nightmare Penguin'] = {
    aura: (e, src, t, sc) => (t.faceUp && ctrl(e, t) === sc && attrOf(e, t) === 'WATER' ? { atk: 200, def: 0 } : undefined),
    *flip(e, _m, p) {
      const list = [...targetable(e, e.monsters(other(p))), ...stOf(e, other(p))];
      const t = yield* pickOne(e, p, 'Nightmare Penguin: return which card to the hand?', list);
      if (t && e.fieldCard(t.uid)) yield* penguinBounce(e, t.uid);
    },
  };

  E['Nightmare Wheel'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && targetable(e, e.monsters(other(p))).length > 0,
    *activate(e, link, p) {
      const t = yield* pickOne(e, p, 'Nightmare Wheel: target which monster?', targetable(e, e.monsters(other(p))), true);
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      const card = e.fieldCard(link.card.uid);
      if (!m || !card || e.controller(m.uid) !== other(p)) return;
      h.attachTo(e, card, m.uid);
      tag(m).lockPosTurn = e.state.turn;
    },
    hostCannotAttack: () => true,
    *onStandby(e, card, p) {
      const host = card.equippedTo !== undefined ? e.fieldCard(card.equippedTo) : null;
      // "When it leaves the field, destroy this card" (also when it left without taking this card along, e.g. bounced).
      if (!host || e.controller(host.uid) !== other(p)) return yield* e.destroy([card.uid]);
      tag(host).lockPosTurn = e.state.turn;
      if (e.state.turnPlayer === p) e.damage(other(p), 500);
    },
  };

  E['Ninjitsu Art of Super-Transformation'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && targetable(e, e.monsters(p)).some((m) => named(e, m, 'Ninja')) && targetable(e, faceUpMonsters(e, other(p))).length > 0,
    *activate(e, link, p) {
      const a = yield* pickOne(e, p, 'Ninjitsu Art: target which "Ninja" monster?', targetable(e, e.monsters(p)).filter((m) => named(e, m, 'Ninja')), true);
      if (!a) return false;
      const b = yield* pickOne(e, p, "Ninjitsu Art: target which opponent's monster?", targetable(e, faceUpMonsters(e, other(p))), true);
      if (!b) return false;
      link.payload = [a.uid, b.uid];
    },
    *resolve(e, link, p) {
      let total = 0;
      for (const u of link.payload as number[]) {
        const m = e.fieldCard(u);
        if (!m) continue;
        yield* e.sendToGrave(u, 'used');
        if (e.find(u)?.loc.zone === 'gy') total += info(e, m).level ?? 0;
      }
      const ok = (c: Card) => isMonster(e, c) && ['Dragon', 'Dinosaur', 'Sea Serpent'].includes(info(e, c).race ?? '') && levelOf(e, c) <= total && !isExtraOrRitual(e, c);
      const m = yield* summonOneOf(e, p, 'Ninjitsu Art: Special Summon which monster?', e.player(p).deck.filter(ok));
      const card = e.fieldCard(link.card.uid);
      if (m && card) tag(card).summoned = m.uid;
    },
    *onLeaveField(e, fc) {
      const u = fc.tags?.summoned;
      if (u && e.fieldCard(u)) e.banish(u);
    },
  };

  const nobleArms = (c: Card) => named(nameEngine(), c, 'Noble Arms');
  const borzArmed = (e: Engine, m: FieldCard) => m.equips.some((u) => !!e.fieldCard(u) && nobleArms(e.fieldCard(u)!));
  // Approximation: it still counts as an Effect Monster card while unequipped (only its Attribute, Level and effect follow the equip).
  E['Noble Knight Borz'] = {
    // While equipped with a "Noble Arms" Equip Spell: it becomes DARK and its Level is increased by 1.
    *stateCheck(e, m) {
      const armed = borzArmed(e, m);
      const decl = (fx(e).declAttr ??= {}) as Record<number, string>;
      if (armed && decl[m.uid] !== 'DARK') decl[m.uid] = 'DARK';
      else if (!armed && decl[m.uid] === 'DARK') delete decl[m.uid];
      if (armed !== !!m.tags?.borzLv) {
        tag(m).lvMod = (m.tags?.lvMod ?? 0) + (armed ? 1 : -1);
        tag(m).borzLv = armed ? 1 : 0;
      }
    },
    *onLeaveField(e, fc) {
      const decl = fx(e).declAttr as Record<number, string> | undefined;
      if (decl?.[fc.uid] === 'DARK') delete decl[fc.uid];
    },
    ignition: {
      can: (e, m, p) => e.oncePerTurn('Noble Knight Borz', p) && borzArmed(e, m) && e.player(p).deck.filter(nobleArms).length >= 3,
      *run(e, _m, p) {
        e.useOnce('Noble Knight Borz', p);
        const three = yield* pick(e, p, 'Reveal 3 "Noble Arms" cards', e.player(p).deck.filter(nobleArms), 3, 3);
        if (!three || three.length < 3) return;
        const add = three[e.roll(3) - 1];
        e.log(other(p), `${e.player(other(p)).name} randomly picks ${add.name}`);
        e.toHandOf(add.uid, p);
        for (const c of three) if (c.uid !== add.uid) yield* e.sendToGrave(c.uid, 'mill');
        e.player(p).deck = e.shuffle(e.player(p).deck);
      },
    },
  };

  // Its second effect (banish instead of returning to the hand) is applied by this batch's "Penguin" cards (penguinBounce).
  E['Nopenguin'] = {
    quick: {
      from: 'gy',
      label: 'Special Summon it from the GY',
      can: (e, _c, p, t, ctx) => t === 'effect' && !!ctx.link && isMonster(e, ctx.link.card) && named(e, ctx.link.card, 'Penguin') && freeMZ(e, p),
      *run(e, c, p) {
        if (e.find(c.uid)?.loc.zone === 'gy') yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
  };

  E['Nordic Relic Draupnir'] = h.equipFor((e, m) => named(e, m, 'Aesir') || named(e, m, 'Nordic'), () => ({ atk: 800, def: 0 }), {
    *onLeaveField(e, fc) {
      fx(e).draupnirUp = fc.faceUp ? fc.uid : undefined;
    },
    *onDestroyed(e, c, p, byBattle) {
      // Only when this face-up card is destroyed by a card effect.
      if (byBattle || fx(e).draupnirUp !== c.uid || !e.player(p).deck.some((x) => named(e, x, 'Nordic Relic'))) return;
      if (yield* e.yesno(p, 'Draupnir: add a "Nordic Relic" card from the Deck?')) yield* searchDeck(e, p, 'Add which "Nordic Relic" card?', (c) => named(e, c, 'Nordic Relic'));
    },
  });

  // Activated right after a battle in which a monster was destroyed: targets the monster that destroyed it.
  const destroyer = (e: Engine, ctx: ChainCtx): FieldCard | null => {
    const b = e.state.battle;
    if (!b || ctx.uid === undefined) return null;
    const other_ = b.attacker === ctx.uid ? b.target : b.target === ctx.uid ? b.attacker : null;
    const m = other_ !== null ? e.fieldCard(other_) : null;
    return m && m.faceUp ? m : null;
  };
  // A face-up monster that destroyed a monster by battle this turn (tags.killTurn, set by the engine).
  const killers = (e: Engine) => targetable(e, faceUpMonsters(e)).filter((m) => m.tags?.killTurn === e.state.turn);
  // Approximation: "cards and effects cannot be activated in response" is not enforced.
  E['Nordic Relic Laevateinn'] = {
    canActivate: (e, _c, _p, t) => (anyTime(t) || t === 'destroyed') && killers(e).length > 0,
    *activate(e, link, p) {
      const t = yield* pickOne(e, p, 'Nordic Relic Laevateinn: destroy which monster?', killers(e), true);
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link) {
      if (link.targetUid !== undefined && e.fieldCard(link.targetUid)) yield* e.destroy([link.targetUid]);
    },
  };

  // ---------- O ----------
  const heroNormal = (e: Engine) => (c: Card) => isNormal(e, c) && named(e, c, 'Elemental HERO');
  E['O - Oversoul'] = {
    canActivate: (e, _c, p, t) => isMain(t) && freeMZ(e, p) && e.player(p).gy.some(heroNormal(e)),
    *activate(e, link, p) {
      const t = yield* pickOne(e, p, 'O - Oversoul: Special Summon which monster?', e.player(p).gy.filter(heroNormal(e)), true);
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid !== undefined && e.find(link.targetUid)?.loc.zone === 'gy') yield* e.specialSummon(link.targetUid, p, 'atk');
    },
  };

  E['Obnoxious Celtic Guard'] = {
    battleProof: (e, m) => {
      const foe = foeOf(e, m.uid);
      return !!foe && e.atkOf(foe) >= 1900;
    },
  };

  // Applied as the Spell/Trap resolves. Approximation: the negated card is sent to the GY rather than destroyed.
  E['Obsidian Dragon'] = {
    negatesEffect: (e, _src, p, link) => {
      if ((link.payload as { effect?: string } | undefined)?.effect || link.targetUid === undefined) return false;
      const kind = info(e, link.card).kind;
      if (kind !== 'spell' && kind !== 'trap') return false;
      const m = e.fieldCard(link.targetUid);
      if (!m || !m.faceUp || e.controller(m.uid) !== p || attrOf(e, m) !== 'DARK') return false;
      e.log(p, `Obsidian Dragon negates ${link.card.name}`);
      return true;
    },
  };

  E['Ocean Dragon Lord - Neo-Daedalus'] = {
    cannotNormalSummon: true,
    summonRule: procOnly,
    summonProc: {
      can: (e, _c, p) => e.monsters(p).some((m) => e.isNamed(m, 'Levia-Dragon - Daedalus') && !e.untributable(m)),
      *run(e, c, p) {
        if (!(yield* tributeCost(e, p, 1, (m) => e.isNamed(m, 'Levia-Dragon - Daedalus')))) return;
        yield* procSummon(e, c, p);
      },
    },
    ignition: {
      can: (e, _m, p) => stOf(e, p).some((c) => c.faceUp && e.isNamed(c, 'Umi')),
      *run(e, m, p) {
        const umi = stOf(e, p).find((c) => c.faceUp && e.isNamed(c, 'Umi'));
        if (!umi) return;
        yield* e.sendToGrave(umi.uid, 'cost');
        for (const q of [0, 1] as Pid[]) for (const c of stOf(e, q)) if (e.fieldCard(c.uid)) yield* e.sendToGrave(c.uid, 'used');
        for (const q of [0, 1] as Pid[]) for (const x of e.monsters(q)) if (x.uid !== m.uid && e.fieldCard(x.uid)) yield* e.sendToGrave(x.uid, 'used');
        for (const q of [0, 1] as Pid[]) for (const c of e.player(q).hand.slice()) if (e.find(c.uid)?.loc.zone === 'hand') yield* e.sendToGrave(c.uid, 'discard');
      },
    },
  };

  E['Offerings to the Doomed'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && targetable(e, faceUpMonsters(e)).length > 0,
    *activate(e, link, p) {
      const t = yield* pickOne(e, p, 'Offerings to the Doomed: destroy which monster?', targetable(e, faceUpMonsters(e)), true);
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid !== undefined && e.fieldCard(link.targetUid)) yield* e.destroy([link.targetUid]);
      e.state.fx.skipDraw = p;
    },
  };

  const ojama = (c: Card) => named(nameEngine(), c, 'Ojama');
  E['Ojama Blue'] = {
    *onDestroyed(e, _c, p, byBattle) {
      const list = e.player(p).deck.filter(ojama);
      if (!byBattle || list.length < 2 || !(yield* e.yesno(p, 'Ojama Blue: add 2 "Ojama" cards from the Deck?'))) return;
      const two = yield* pick(e, p, 'Add which 2 "Ojama" cards?', list, 2, 2);
      for (const c of two ?? []) e.toHandOf(c.uid, p);
      e.player(p).deck = e.shuffle(e.player(p).deck);
    },
  };

  E['Ojama Country'] = {
    ...h.fieldSpell(() => undefined),
    // Switching original ATK/DEF is applied as a bonus of (DEF - ATK) / (ATK - DEF).
    aura: (e, src, t, sc) => {
      if (!src.active || !e.monsters(sc).some((m) => m.faceUp && ojama(m))) return undefined;
      const b = e.baseStats(t);
      return { atk: b.def - b.atk, def: b.atk - b.def };
    },
    ignition: {
      // Spell/Trap ignition effects keep their own once-per-turn mark (effectUsed only resets on monsters).
      repeat: true,
      can: (e, _m, p) => e.oncePerTurn('Ojama Country', p) && freeMZ(e, p) && e.player(p).hand.some(ojama) && e.player(p).gy.some((c) => isMonster(e, c) && ojama(c)),
      *run(e, _m, p) {
        if (!(yield* discardCost(e, p, 1, ojama))) return;
        e.useOnce('Ojama Country', p);
        yield* summonOneOf(e, p, 'Ojama Country: Special Summon which "Ojama" monster?', e.player(p).gy.filter((c) => isMonster(e, c) && ojama(c)));
      },
    },
  };

  const trio = ['Ojama Green', 'Ojama Yellow', 'Ojama Black'];
  E['Ojama Delta Hurricane!!'] = {
    canActivate: (e, _c, p, t) => isMain(t) && trio.every((n) => e.monsters(p).some((m) => m.faceUp && m.name === n)),
    *resolve(e, _l, p) {
      if (!trio.every((n) => e.monsters(p).some((m) => m.faceUp && m.name === n))) return;
      yield* e.destroy([...e.monsters(other(p)), ...stOf(e, other(p))].map((c) => c.uid));
    },
  };

  E['Ojama Red'] = {
    *onSummon(e, _m, p, kind) {
      const list = () => e.player(p).hand.filter((c) => isMonster(e, c) && ojama(c) && !isExtraOrRitual(e, c));
      if (kind !== 'normal' || !list().length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Ojama Red: Special Summon "Ojama" monsters from the hand?'))) return;
      const chosen = yield* pick(e, p, 'Special Summon which "Ojama" monsters?', list(), 1, Math.min(4, freeZones(e, p)));
      for (const c of chosen ?? []) if (e.find(c.uid)?.loc.zone === 'hand') yield* e.specialSummon(c.uid, p, 'atk');
    },
  };

  // It can be activated (doing nothing): it is then sent from the field to the GY, which adds the three.
  E['Ojamagic'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    *onSentToGrave(e, _c, p, from) {
      if (from !== 'hand' && from !== 'sz') return;
      for (const n of trio) {
        const c = e.player(p).deck.find((x) => x.name === n);
        if (c) e.toHandOf(c.uid, p);
      }
      e.player(p).deck = e.shuffle(e.player(p).deck);
    },
  };

  const ojamatchCost = (e: Engine, p: Pid, self: number) => [...e.player(p).hand.filter((c) => c.uid !== self), ...[...e.monsters(p), ...stOf(e, p)].filter((c) => c.faceUp && c.uid !== self)].filter(ojama);
  const ojamatchAdds = (e: Engine, p: Pid, sent: string) => {
    const pool = [...e.player(p).deck, ...e.player(p).gy];
    return { oj: pool.filter((c) => isMonster(e, c) && ojama(c) && c.name !== sent), ad: pool.filter((c) => isMonster(e, c) && named(e, c, 'Armed Dragon')) };
  };
  E['Ojamatch'] = {
    canActivate: (e, c, p, t) => anyTime(t) && ojamatchCost(e, p, c.uid).some((x) => {
      const a = ojamatchAdds(e, p, x.name);
      return a.oj.length > 0 && a.ad.length > 0;
    }),
    *activate(e, link, p) {
      const opts = ojamatchCost(e, p, link.card.uid).filter((x) => {
        const a = ojamatchAdds(e, p, x.name);
        return a.oj.length > 0 && a.ad.length > 0;
      });
      const c = yield* pickOne(e, p, 'Ojamatch: send which "Ojama" card to the GY?', opts, true);
      if (!c) return false;
      link.payload = c.name;
      yield* e.sendToGrave(c.uid, 'cost');
    },
    *resolve(e, link, p) {
      const a = ojamatchAdds(e, p, link.payload as string);
      if (!a.oj.length || !a.ad.length) return;
      const x = yield* pickOne(e, p, 'Ojamatch: add which "Ojama" monster?', a.oj);
      const y = yield* pickOne(e, p, 'Ojamatch: add which "Armed Dragon" monster?', a.ad);
      for (const c of [x, y]) if (c) e.toHandOf(c.uid, p);
      e.player(p).deck = e.shuffle(e.player(p).deck);
      // "then, immediately after this effect resolves, you can Normal Summon 1 of those monsters" (in addition to the usual Normal Summon).
      const added = [x, y].filter((c): c is Card => !!c && e.find(c.uid)?.loc.zone === 'hand' && e.canNormalSummon(p, c, true, true));
      if (!added.length || !(yield* e.yesno(p, 'Ojamatch: Normal Summon 1 of those monsters?'))) return;
      const c = yield* pickOne(e, p, 'Ojamatch: Normal Summon which monster?', added, true);
      if (c) yield* e.extraNormalSummon(p, c.uid, 'atk', true);
    },
    graveIgnition: {
      can: (e, _c, p) => e.player(p).removed.filter((c) => isMonster(e, c) && ojama(c)).length >= 3,
      *run(e, card, p) {
        const three = yield* pick(e, p, 'Ojamatch: shuffle which 3 banished "Ojama" monsters into the Deck?', e.player(p).removed.filter((c) => isMonster(e, c) && ojama(c)), 3, 3, true);
        if (!three || three.length < 3) return;
        e.banish(card.uid);
        for (const c of three) toDeck(e, c.uid);
        e.draw(p, 1);
      },
    },
  };

  E['Old Vindictive Magician'] = {
    *flip(e, _m, p) {
      yield* destroyAny('Old Vindictive Magician: destroy which monster?')(e, p, e.monsters(other(p)));
    },
  };

  E['Ordeal of a Traveler'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    *onAttackDeclared(e, _card, p, attacker) {
      const uid = attacker.uid;
      const hand = e.player(p).hand;
      if (e.controller(uid) !== other(p) || !hand.length) return;
      const c = hand[e.roll(hand.length) - 1];
      const kinds = ['monster', 'spell', 'trap'];
      const call = yield* chooseOption(e, other(p), 'Ordeal of a Traveler: a random card from the hand was chosen. Call its type', ['Monster', 'Spell', 'Trap']);
      e.log(p, `The card was ${c.name}`);
      if (call !== null && kinds[call] === info(e, c).kind) return;
      const m = e.fieldCard(uid);
      if (m && e.controller(uid) === other(p)) {
        e.log(p, `Wrong call: ${m.name} returns to the hand`);
        yield* leaveField(e, uid, 'hand');
        e.endBattle();
      }
    },
  };

  const normalNonToken = (e: Engine, m: FieldCard) => !m.token && m.faceUp && isNormal(e, m);
  E['Order to Charge'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && targetable(e, e.monsters(p)).some((m) => normalNonToken(e, m)) && e.monsters(other(p)).length > 0,
    *activate(e, link, p) {
      const t = yield* pickOne(e, p, 'Order to Charge: Tribute which Normal Monster?', targetable(e, e.monsters(p)).filter((m) => normalNonToken(e, m)), true);
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid === undefined || e.controller(link.targetUid) !== p || !e.fieldCard(link.targetUid)) return;
      yield* e.sendToGrave(link.targetUid, 'tribute');
      const t = yield* pickOne(e, p, 'Order to Charge: destroy which monster?', e.monsters(other(p)));
      if (t) yield* e.destroy([t.uid]);
    },
  };

  E['Order to Smash'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && targetable(e, e.monsters(p)).some((m) => normalNonToken(e, m) && levelOf(e, m) <= 2) && stOf(e, other(p)).length > 0,
    *activate(e, link, p) {
      const t = yield* pickOne(e, p, 'Order to Smash: Tribute which Normal Monster?', targetable(e, e.monsters(p)).filter((m) => normalNonToken(e, m) && levelOf(e, m) <= 2), true);
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid === undefined || e.controller(link.targetUid) !== p || !e.fieldCard(link.targetUid)) return;
      yield* e.sendToGrave(link.targetUid, 'tribute');
      const list = stOf(e, other(p));
      const chosen = yield* pick(e, p, 'Order to Smash: destroy up to 2 Spells/Traps', list, 1, 2);
      if (chosen) yield* e.destroy(chosen.map((c) => c.uid));
    },
  };

  const orgothOn = (e: Engine, m: FieldCard) => (m.tags?.orgUntil ?? -1) >= e.state.turn;
  E['Orgoth the Relentless'] = {
    ignition: {
      can: () => true,
      *run(e, m, p) {
        if (!e.fieldCard(m.uid)) return;
        const r = [e.roll(6), e.roll(6), e.roll(6)];
        e.log(p, `Orgoth rolls ${r.join(', ')}`);
        const t = tag(m);
        t.orgAtk = (r[0] + r[1] + r[2]) * 100;
        t.orgUntil = e.state.turn + 1;
        const same = r.filter((x, i) => r.indexOf(x) !== i);
        if (!same.length) return;
        const all = r[0] === r[1] && r[1] === r[2];
        const hit = (a: number, b: number) => all || same.some((x) => x === a || x === b);
        if (hit(1, 2)) t.orgSafe = e.state.turn + 1;
        if (hit(3, 4)) e.draw(p, 2);
        if (hit(5, 6)) t.orgDirect = e.state.turn;
      },
    },
    selfBonus: (e, m) => (orgothOn(e, m) ? { atk: m.tags!.orgAtk ?? 0, def: m.tags!.orgAtk ?? 0 } : { atk: 0, def: 0 }),
    battleProof: (e, m) => (m.tags?.orgSafe ?? -1) >= e.state.turn,
    effectProof: (e, m) => (m.tags?.orgSafe ?? -1) >= e.state.turn,
    directAttack: (e, m) => m.tags?.orgDirect === e.state.turn,
  };

  E['Otherworld - The "A" Zone'] = {
    ...h.fieldSpell(() => undefined),
    aura: (e, src, t, sc) => {
      if (!src.active || ctrl(e, t) !== other(sc)) return undefined;
      const foe = foeOf(e, t.uid);
      return foe && foe.faceUp && ctrl(e, foe) === sc && named(e, foe, 'Alien') ? { atk: -300, def: -300 } : undefined;
    },
  };

  const otohime = function* (e: Engine, m: FieldCard, p: Pid): Step {
    tag(m).spiritTurn = e.state.turn;
    const list = targetable(e, faceUpMonsters(e, other(p)));
    if (!list.length || !(yield* e.yesno(p, "Otohime: change an opponent's monster's battle position?"))) return;
    const t = yield* pickOne(e, p, 'Change the position of which monster?', list);
    if (!t || !e.fieldCard(t.uid)) return;
    t.pos = t.pos === 'atk' ? 'def' : 'atk';
    e.event('position', { uid: t.uid });
    e.log(p, `${t.name} changes to ${t.pos === 'atk' ? 'Attack' : 'Defense'} Position`);
  };
  E['Otohime'] = {
    cannotSpecialSummon: true,
    *onSummon(e, m, p, kind) {
      if (kind === 'normal') yield* otohime(e, m, p);
    },
    flip: otohime,
    *onEndPhase(e, m) {
      if (m.tags?.spiritTurn === e.state.turn) yield* leaveField(e, m.uid, 'hand');
    },
  };

  const dhero = (c: Card) => named(nameEngine(), c, 'Destiny HERO');
  const overDestinyOk = (e: Engine, p: Pid, g: Card) => isMonster(e, g) && dhero(g) && e.player(p).deck.some((c) => isMonster(e, c) && dhero(c) && !isExtraOrRitual(e, c) && levelOf(e, c) <= Math.floor(levelOf(e, g) / 2));
  E['Over Destiny'] = {
    canActivate: (e, _c, p, t) => isMain(t) && freeMZ(e, p) && e.player(p).gy.some((g) => overDestinyOk(e, p, g)),
    *activate(e, link, p) {
      const t = yield* pickOne(e, p, 'Over Destiny: target which "Destiny HERO"?', e.player(p).gy.filter((g) => overDestinyOk(e, p, g)), true);
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link, p) {
      const g = link.targetUid !== undefined ? e.find(link.targetUid) : null;
      if (!g || g.loc.zone !== 'gy') return;
      const half = Math.floor(levelOf(e, g.card) / 2);
      const m = yield* summonOneOf(e, p, 'Over Destiny: Special Summon which "Destiny HERO"?', e.player(p).deck.filter((c) => isMonster(e, c) && dhero(c) && !isExtraOrRitual(e, c) && levelOf(e, c) <= half));
      if (m) m.doomAt = e.state.turn;
    },
  };

  const overloadPool = (e: Engine, p: Pid) => [...e.monsters(p), ...e.player(p).gy.filter((c) => isMonster(e, c))];
  const darkMachine = (e: Engine) => (f: Card) => attrOf(e, f) === 'DARK' && info(e, f).race === 'Machine';
  E['Overload Fusion'] = {
    canActivate: (e, _c, p, t) => isMain(t) && fusionCands(e, p, overloadPool(e, p), darkMachine(e)).length > 0,
    *activate(e, link, p) {
      const plan = yield* chooseFusion(e, p, 'Overload Fusion: Fusion Summon which monster?', overloadPool(e, p), darkMachine(e));
      if (!plan) return false;
      link.payload = plan;
    },
    *resolve(e, link, p) {
      const { fusion, mats } = link.payload as { fusion: number; mats: number[] };
      if (e.find(fusion)?.loc.zone !== 'fusion' || mats.some((u) => !e.find(u) || !['mz', 'gy'].includes(e.find(u)!.loc.zone))) return;
      for (const u of mats) e.banish(u);
      if (freeMZ(e, p)) yield* e.specialSummon(fusion, p, 'atk');
    },
  };

  E["Owner's Seal"] = {
    canActivate: (e, _c, _p, t) => isMain(t) && allMonsters(e).some((m) => e.controller(m.uid) !== m.owner),
    *resolve(e) {
      for (const m of allMonsters(e)) {
        if (e.controller(m.uid) === m.owner || !freeMZ(e, m.owner)) continue;
        m.returnAtEnd = undefined;
        if (e.takeControl(m.uid, m.owner)) e.log(m.owner, `${m.name} returns to ${e.player(m.owner).name}`);
      }
    },
  };

  E['Oxygeddon'] = {
    *onDestroyed(e, c, _p, byBattle) {
      if (!byBattle || !e.state.battle) return;
      const b = e.state.battle;
      const foe = b.attacker === c.uid ? b.target : b.attacker;
      const f = foe !== null ? e.find(foe) : null;
      if (!f || info(e, f.card).race !== 'Pyro') return;
      e.damage(0, 800);
      e.damage(1, 800);
    },
  };

  E['Oyster Meister'] = {
    *onDestroyed(e, c, _p, byBattle) {
      if (byBattle) fx(e).oysterBattle = c.uid;
    },
    *onSentToGrave(e, c, _o, from) {
      if (from !== 'mz' || fx(e).oysterBattle === c.uid) return;
      const p = ctrl(e, c);
      e.createToken('Oyster Token', p, 'atk', true, { atk: 0, def: 0, level: 1, attribute: 'WATER', race: 'Fish' });
    },
  };

  // ---------- P ----------
  const bewd = 'Blue-Eyes White Dragon';
  E['Paladin of White Dragon'] = {
    // Approximation: applied as the attack is declared (before the Damage Step starts).
    *onAttackDeclared(e, card, p, attacker, target) {
      if (attacker.uid !== card.uid || !target || target.faceUp || target.pos !== 'def' || e.controller(target.uid) !== other(p)) return;
      e.log(p, 'Paladin of White Dragon destroys the face-down monster');
      yield* e.destroy([target.uid]);
    },
    ignition: {
      can: (e, _m, p) => [...e.player(p).hand, ...e.player(p).deck].some((c) => c.name === bewd),
      *run(e, m, p) {
        if (!e.fieldCard(m.uid)) return;
        yield* e.sendToGrave(m.uid, 'tribute');
        yield* summonOneOf(e, p, `Special Summon which ${bewd}?`, [...e.player(p).hand, ...e.player(p).deck].filter((c) => c.name === bewd));
        for (const x of e.monsters(p)) if (x.name === bewd) tag(x).noAttackTurn = e.state.turn;
      },
    },
  };

  E['Paleozoic Canadia'] = paleozoic({
    canActivate: (e, _c, p, t) => anyTime(t) && targetable(e, faceUpMonsters(e, other(p))).length > 0,
    *activate(e, link, p) {
      const t = yield* pickOne(e, p, 'Paleozoic Canadia: change which monster to face-down Defense?', targetable(e, faceUpMonsters(e, other(p))), true);
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || !m.faceUp) return;
      m.faceUp = false;
      m.pos = 'def';
      e.event('position', { uid: m.uid });
      e.log(link.player, `${m.name} is turned face-down`);
    },
  });

  E['Paleozoic Eldonia'] = paleozoic({
    canActivate: (e, _c, _p, t) => anyTime(t) && targetable(e, faceUpMonsters(e)).length > 0,
    *activate(e, link, p) {
      const t = yield* pickOne(e, p, 'Paleozoic Eldonia: which monster gains 500 ATK/DEF?', targetable(e, faceUpMonsters(e)), true);
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (m?.faceUp) boostTurn(m, 500, 500);
    },
  });

  // Monster effect only; it applies as an extra draw in your Standby Phase.
  E["Pandora's Jewelry Box"] = {
    *onStandby(e, _m, p) {
      if (e.state.turnPlayer !== p || e.player(p).fusion.length > 0) return;
      e.log(p, "Pandora's Jewelry Box: 1 more card for the normal draw");
      e.draw(p, 1);
    },
  };

  // Monster effects of the Performapal Pendulum monsters (their Pendulum Effects need Pendulum Zones).
  const changeraffe = function* (e: Engine, m: FieldCard, p: Pid): Step {
    const list = targetable(e, faceUpMonsters(e, other(p)));
    if (!list.length || !(yield* e.yesno(p, "Changeraffe: target an opponent's monster?"))) return;
    const t = yield* pickOne(e, p, 'Changeraffe: which monster cannot attack and has its effects negated?', list);
    if (!t || !e.fieldCard(t.uid) || !e.fieldCard(m.uid)) return;
    // It cannot attack while Changeraffe is face-up (tags.illusionBy); its effects stay negated while it is on the field.
    tag(t).illusionBy = m.uid;
    negateMonster(e, t, false);
  };
  E['Performapal Changeraffe'] = {
    *onSummon(e, m, p, kind) {
      if (kind === 'normal') yield* changeraffe(e, m, p);
    },
    onSpecialSummon: changeraffe,
  };

  E['Performapal Gongato'] = {
    quick: {
      label: 'take no battle damage from that battle',
      can: (e, _c, p, t) => t === 'attack' && !!myBattle(e, p),
      *run(e, _c, p) {
        noBattleDamage(e, p);
      },
    },
  };

  E['Performapal Gumgumouton'] = {
    quick: {
      label: 'your monster cannot be destroyed by that battle',
      can: (e, _c, p, t) => t === 'attack' && !!myBattle(e, p),
      *run(e, _c, p) {
        const m = myBattle(e, p);
        if (m) tag(m).gumSafe = e.state.fx.battleNo ?? 0;
      },
    },
    shields: (e, _src, target, how, sc) => how === 'battle' && ctrl(e, target) === sc && !!e.state.fx.battleNo && target.tags?.gumSafe === e.state.fx.battleNo,
  };

  E['Performapal Inflater Tapir'] = {
    *onAttackDeclaredInGrave(e, card, p, attacker, target) {
      if (target || e.controller(attacker.uid) !== other(p) || !e.oncePerTurn('Performapal Inflater Tapir', p) || !freeMZ(e, p)) return;
      if (!e.player(p).hand.some((c) => isMonster(e, c) && named(e, c, 'Performapal'))) return;
      if (!(yield* e.yesno(p, 'Inflater Tapir: discard 1 "Performapal" monster to Special Summon it from the GY?'))) return;
      if (!(yield* discardCost(e, p, 1, (c) => isMonster(e, c) && named(e, c, 'Performapal')))) return;
      e.useOnce('Performapal Inflater Tapir', p);
      if (e.find(card.uid)?.loc.zone === 'gy') yield* e.specialSummon(card.uid, p, 'def');
    },
    // Approximation: used when the attack is declared (there is no damage calculation response window).
    quick: {
      from: 'hand',
      label: 'discard it: no battle damage from that battle',
      can: (e, _c, p, t) => t === 'attack' && !!myBattle(e, p),
      *cost(e, card, p) {
        yield* e.discard(p, card.uid);
      },
      *run(e, _c, p) {
        noBattleDamage(e, p);
        noBattleDamage(e, other(p));
      },
    },
  };

  const sealEel = function* (e: Engine, _m: FieldCard, p: Pid): Step {
    const list = stOf(e, other(p)).filter((c) => !c.faceUp);
    if (!list.length || !(yield* e.yesno(p, "Seal Eel: stop an opponent's Set card being activated this turn?"))) return;
    const t = yield* pickOne(e, p, 'Seal Eel: which Set card?', list);
    // That Set card cannot be activated this turn (engine: tags.noActTurn).
    if (t && e.fieldCard(t.uid)) tag(t).noActTurn = e.state.turn;
  };
  E['Performapal Seal Eel'] = {
    *onSummon(e, m, p, kind) {
      if (kind === 'normal') yield* sealEel(e, m, p);
    },
    onSpecialSummon: sealEel,
  };

  E['Phantom Beast Wild-Horn'] = { piercing: true };

  E['Photon Caesar'] = {
    *onSummon(e, _m, p) {
      const list = [...e.player(p).hand, ...e.player(p).deck].filter((c) => e.isNamed(c, 'Photon Caesar'));
      if (!list.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Photon Caesar: Special Summon another "Photon Caesar"?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which "Photon Caesar"?', list);
    },
  };

  const moraySac = (e: Engine, m: FieldCard) => ['Fish', 'Sea Serpent', 'Aqua'].includes(raceOf(e, m));
  E['Piercing Moray'] = {
    piercing: true,
    ignition: {
      can: (e, m, p) => e.monsters(p).some((x) => x.uid !== m.uid && moraySac(e, x)),
      *run(e, m, p) {
        if (!(yield* tributeCost(e, p, 1, (x) => moraySac(e, x), m.uid))) return;
        if (e.fieldCard(m.uid)) boostPerm(m, 600);
      },
    },
  };

  E['Pinch Hopper'] = {
    *onSentToGrave(e, _c, p, from) {
      const list = e.player(p).hand.filter((c) => isMonster(e, c) && info(e, c).race === 'Insect' && !isExtraOrRitual(e, c));
      if (from !== 'mz' || !list.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Pinch Hopper: Special Summon an Insect from the hand?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which Insect?', list);
    },
  };

  E['Pineapple Blast'] = {
    canActivate: (e, _c, p, t, ctx) => t === 'summon' && ctx.summonKind === 'normal' && ctx.uid !== undefined && e.controller(ctx.uid) === p && e.monsters(other(p)).length > e.monsters(p).length,
    *resolve(e, _l, p) {
      const n = e.monsters(other(p)).length - e.monsters(p).length;
      if (n <= 0) return;
      const chosen = yield* pick(e, other(p), `Pineapple Blast: destroy ${n} of your monsters`, e.monsters(other(p)), n, n, false, false);
      if (chosen) yield* e.destroy(chosen.map((c) => c.uid));
    },
  };

  const counterable = (e: Engine, self: number) => [...allMonsters(e), ...allST(e)].filter((c) => c.uid !== self && c.faceUp && /Spell Counter/.test(info(e, c).desc));
  E['Pitch-Black Power Stone'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve(e, link) {
      const c = e.fieldCard(link.card.uid);
      if (c) c.counters = 3;
    },
    ignition: {
      repeat: true,
      can: (e, m, p) => e.state.turnPlayer === p && e.oncePerTurn(`Power Stone:${m.uid}`, p) && m.counters > 0 && counterable(e, m.uid).length > 0,
      *run(e, card, p) {
        const t = yield* pickOne(e, p, 'Pitch-Black Power Stone: place a Spell Counter on which card?', counterable(e, card.uid), true);
        if (!t) return;
        e.useOnce(`Power Stone:${card.uid}`, p);
        card.counters--;
        t.counters++;
        e.log(p, `A Spell Counter moves to ${t.name}`);
        if (card.counters <= 0 && e.fieldCard(card.uid)) yield* e.destroy([card.uid]);
      },
    },
  };

  E['Plague Wolf'] = {
    ignition: {
      can: () => true,
      *run(e, m) {
        if (!e.fieldCard(m.uid) || !m.faceUp) return;
        boostTurn(m, 2 * e.baseStats(m).atk - e.atkOf(m));
        tag(m).plague = e.state.turn;
      },
    },
    *onEndPhase(e, m) {
      if (m.tags?.plague === e.state.turn) yield* e.destroy([m.uid]);
    },
  };

  E['Possessed Dark Soul'] = {
    ignition: {
      can: (e, _m, p) => e.monsters(other(p)).some((x) => x.faceUp && levelOf(e, x) <= 3),
      *run(e, m, p) {
        if (!e.fieldCard(m.uid) || !m.faceUp) return;
        yield* e.sendToGrave(m.uid, 'tribute');
        for (const x of e.monsters(other(p))) if (x.faceUp && levelOf(e, x) <= 3) e.takeControl(x.uid, p);
      },
    },
  };

  E['Pot of Avarice'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).gy.filter((c) => isMonster(e, c)).length >= 5,
    *activate(e, link, p) {
      const five = yield* pick(e, p, 'Pot of Avarice: shuffle which 5 monsters into the Deck?', e.player(p).gy.filter((c) => isMonster(e, c)), 5, 5, true);
      if (!five || five.length < 5) return false;
      link.payload = five.map((c) => c.uid);
    },
    *resolve(e, link, p) {
      const uids = link.payload as number[];
      if (uids.some((u) => e.find(u)?.loc.zone !== 'gy')) return;
      for (const u of uids) {
        const c = e.find(u)!.card;
        if (isFusion(e, c)) {
          const ps = e.player(c.owner);
          ps.gy.splice(ps.gy.findIndex((x) => x.uid === u), 1);
          ps.fusion.push(c);
        } else toDeck(e, u);
      }
      e.draw(p, 2);
    },
  };

  E['Power Breaker'] = {
    *onLeaveField(e, fc) {
      fx(e).pbBy = { uid: fc.uid, by: e.actor };
    },
    *onDestroyed(e, c, p, byBattle) {
      const b = e.state.battle;
      const byOpp = byBattle ? !!b && e.controller(b.attacker) === other(p) && b.attacker !== c.uid : fx(e).pbBy?.uid === c.uid && fx(e).pbBy.by === other(p);
      if (!byOpp || c.owner !== p) return;
      const t = yield* pickOne(e, p, 'Power Breaker: destroy which Spell/Trap?', stOf(e, other(p)).filter((x) => x.faceUp));
      if (t) yield* e.destroy([t.uid]);
    },
    *afterBattle(e, m) {
      if (e.fieldCard(m.uid) && m.pos === 'atk') {
        m.pos = 'def';
        e.event('position', { uid: m.uid });
      }
    },
  };

  const ritualPairs = (e: Engine, p: Pid) => {
    const ps = e.player(p);
    return ps.deck.filter((c) => isSpell(e, c) && info(e, c).sub === 'Ritual' && !!e.ritualOf(c.name) && [...ps.deck, ...ps.gy].some((m) => e.isNamed(m, e.ritualOf(c.name)!.monster)));
  };
  E['Pre-Preparation of Rites'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p) && ritualPairs(e, p).length > 0,
    *activate(e, link, p) {
      e.useOnce(link.card.name, p);
    },
    *resolve(e, _l, p) {
      const s = yield* pickOne(e, p, 'Add which Ritual Spell?', ritualPairs(e, p));
      if (!s) return;
      const name = e.ritualOf(s.name)!.monster;
      e.toHandOf(s.uid, p);
      const m = yield* pickOne(e, p, `Add which ${name}?`, [...e.player(p).deck, ...e.player(p).gy].filter((c) => c.name === name));
      if (m) e.toHandOf(m.uid, p);
      e.player(p).deck = e.shuffle(e.player(p).deck);
    },
  };

  const predLevel = (e: Engine, m: FieldCard) => levelOf(e, m);
  E['Predaplant Pterapenthes'] = {
    *onBattleDamage(e, _m, p) {
      const list = targetable(e, faceUpMonsters(e, other(p)));
      if (!list.length || !(yield* e.yesno(p, 'Pterapenthes: place a Predator Counter?'))) return;
      const t = yield* pickOne(e, p, 'Place a Predator Counter on which monster?', list);
      if (!t || !e.fieldCard(t.uid)) return;
      tag(t).predator = (t.tags?.predator ?? 0) + 1;
      // Level 2 or higher: it becomes Level 1 while it has a Predator Counter (counters stay until it leaves the field).
      if (levelOf(e, t) >= 2) {
        tag(t).lvSet = 1;
        delete tag(t).lvSetTurn;
      }
    },
    ignition: {
      can: (e, m, p) => freeMZ(e, p) && targetable(e, e.monsters(other(p))).some((x) => x.faceUp && predLevel(e, x) <= predLevel(e, m)),
      *run(e, m, p) {
        const t = yield* pickOne(e, p, 'Pterapenthes: take control of which monster?', targetable(e, e.monsters(other(p))).filter((x) => x.faceUp && predLevel(e, x) <= predLevel(e, m)));
        if (!t || e.controller(t.uid) !== other(p)) return;
        if (e.takeControl(t.uid, p)) t.returnAtEnd = other(p);
      },
    },
  };

  E['Premature Return'] = {
    canActivate: (e, c, p, t) => anyTime(t) && freeMZ(e, p) && e.player(p).hand.length > 0 && [...e.player(p).removed, ...e.player(p).hand].some((x) => isMonster(e, x) && !isExtraOrRitual(e, x)),
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Premature Return: banish which card from your hand?', e.player(p).hand, true);
      if (!c) return false;
      e.banish(c.uid);
      const t = yield* pickOne(e, p, 'Premature Return: Special Summon which banished monster?', e.player(p).removed.filter((x) => isMonster(e, x) && !isExtraOrRitual(e, x)));
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid !== undefined && e.find(link.targetUid)?.loc.zone === 'removed') yield* e.specialSummon(link.targetUid, p, 'def', false);
    },
  };

  // Applied when the attack is declared, until the end of the turn.
  const roarPair = (e: Engine, p: Pid) => {
    const mine = myBattle(e, p);
    const foe = mine ? foeOf(e, mine.uid) : null;
    return mine && foe && mine.faceUp && foe.faceUp && e.atkOf(foe) > e.atkOf(mine) ? { mine, diff: e.atkOf(foe) - e.atkOf(mine) } : null;
  };
  E['Prideful Roar'] = {
    canActivate: (e, _c, p, t) => t === 'attack' && !!roarPair(e, p) && e.player(p).lp > roarPair(e, p)!.diff,
    *activate(e, link, p) {
      const r = roarPair(e, p)!;
      if (!payLp(e, p, r.diff)) return false;
      link.payload = r;
    },
    *resolve(e, link) {
      const r = link.payload as { mine: FieldCard; diff: number };
      const m = e.fieldCard(r.mine.uid);
      if (m?.faceUp) boostTurn(m, r.diff + 300);
    },
  };

  E['Prometheus, King of the Shadows'] = {
    *onSummon(e, m, p, kind) {
      const list = e.player(p).gy.filter((c) => isMonster(e, c) && attrOf(e, c) === 'DARK');
      if (kind !== 'normal' || !list.length) return;
      const chosen = yield* pick(e, p, 'Prometheus: banish 1 or more DARK monsters from your GY', list, 1, list.length);
      if (!chosen) return;
      for (const c of chosen) e.banish(c.uid);
      if (e.fieldCard(m.uid)) boostTurn(m, 400 * chosen.length);
    },
  };

  E['Prominence Hand'] = {
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && e.monsters(p).some((m) => m.faceUp && e.namesOf(m).some((nm) => ['Magic Hand', 'Fire Hand', 'Ice Hand'].includes(nm))),
      *run(e, c, p) {
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
  };

  const shockwaveOk = (e: Engine, c: Card) => isMonster(e, c) && levelOf(e, c) === 6 && attrOf(e, c) === 'DARK' && info(e, c).race === 'Machine' && !isExtraOrRitual(e, c);
  E['Psychic Shockwave'] = {
    canActivate: (e, _c, p, t, ctx) => t === 'trap' && !!ctx.link && ctx.link.player === other(p) && e.player(p).hand.some((c) => !isMonster(e, c)) && freeMZ(e, p),
    *activate(e, _l, p) {
      if (!(yield* discardCost(e, p, 1, (c) => isSpell(e, c) || isTrap(e, c)))) return false;
    },
    *resolve(e, _l, p) {
      yield* summonOneOf(e, p, 'Psychic Shockwave: Special Summon which monster?', e.player(p).deck.filter((c) => shockwaveOk(e, c)));
    },
  };

  // Approximation: it goes to the GY first and is then placed in the Spell & Trap Zone.
  E['Pumprincess the Princess of Ghosts'] = {
    *onLeaveField(e, fc) {
      fx(e).pumpUp = fc.faceUp && fc.pos !== undefined ? fc.uid : undefined;
    },
    *onSentToGrave(e, c, p, from, reason) {
      if (from !== 'mz' || reason !== 'destroyed' || fx(e).pumpUp !== c.uid || freeST(e, p) < 0) return;
      if (!(yield* e.yesno(p, 'Pumprincess: place it in your Spell & Trap Zone as a Continuous Spell?'))) return;
      placeInST(e, c.uid, p);
    },
    *onStandby(e, card) {
      if (e.find(card.uid)?.loc.zone === 'sz') card.counters++;
    },
    aura: (e, src, t, sc) => (e.find(src.uid)?.loc.zone === 'sz' && src.counters > 0 && ctrl(e, t) === other(sc) ? { atk: -100 * src.counters, def: -100 * src.counters } : undefined),
  };

  E['Puppet Master'] = {
    *onSummon(e, _m, p, kind) {
      const fiends = () => e.player(p).gy.filter((c) => isMonster(e, c) && info(e, c).race === 'Fiend' && !isExtraOrRitual(e, c));
      if (kind !== 'normal' || fiends().length < 2 || freeZones(e, p) < 2 || e.player(p).lp <= 2000) return;
      if (!(yield* e.yesno(p, 'Puppet Master: pay 2000 LP to Special Summon 2 Fiends from your GY?'))) return;
      const two = yield* pick(e, p, 'Special Summon which 2 Fiends?', fiends(), 2, 2);
      if (!two || two.length < 2 || !payLp(e, p, 2000)) return;
      for (const c of two) {
        if (e.find(c.uid)?.loc.zone !== 'gy') continue;
        yield* e.specialSummon(c.uid, p, 'atk');
        const m = e.fieldCard(c.uid);
        if (m) tag(m).noAttackTurn = e.state.turn;
      }
    },
  };

  E['Pyramid of Wonders'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    aura: (e, _src, t, sc) => (t.faceUp && ctrl(e, t) === sc && raceOf(e, t) === 'Zombie' ? { atk: 200 * e.monsters(other(sc)).length, def: 0 } : undefined),
    // "If exactly 1 Zombie monster you control would be destroyed, you can send this card to the GY instead" (always used).
    shields(e, src, target, how, sc) {
      if (how === 'target' || !src.active || ctrl(e, target) !== sc || raceOf(e, target) !== 'Zombie' || !e.fieldCard(src.uid)) return false;
      e.log(sc, `${src.name} is sent to the GY instead of ${target.name}`);
      const g = e.sendToGrave(src.uid, 'cost');
      for (let r = g.next(undefined as never); !r.done; r = g.next(false)) {
        /* drained */
      }
      return true;
    },
  };

  const gemPool = (e: Engine, p: Pid) => [...e.player(p).hand.filter((c) => isMonster(e, c)), ...e.monsters(p)];
  const gem = (f: Card) => named(nameEngine(), f, 'Gem-Knight');
  E['Pyroxene Fusion'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && fusionCands(e, p, gemPool(e, p), gem).length > 0,
    *activate(e, link, p) {
      const plan = yield* chooseFusion(e, p, 'Pyroxene Fusion: Fusion Summon which "Gem-Knight"?', gemPool(e, p), gem);
      if (!plan) return false;
      link.payload = plan;
    },
    *resolve(e, link, p) {
      const { fusion, mats } = link.payload as { fusion: number; mats: number[] };
      if (e.find(fusion)?.loc.zone !== 'fusion' || mats.some((u) => !e.find(u) || !['mz', 'hand'].includes(e.find(u)!.loc.zone))) return;
      for (const u of mats) yield* e.sendToGrave(u, 'used');
      if (freeMZ(e, p)) yield* e.specialSummon(fusion, p, 'atk');
    },
  };

  // ---------- Q ----------
  E['Quaking Mirror Force'] = {
    canActivate: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null,
    *resolve(e, _l, p) {
      for (const m of e.monsters(other(p))) {
        if (m.pos !== 'atk') continue;
        m.faceUp = false;
        m.pos = 'def';
        m.cannotChangePos = true;
        e.event('position', { uid: m.uid });
      }
      e.log(p, "Quaking Mirror Force turns the opponent's Attack Position monsters face-down");
    },
  };

  const races = ['Warrior', 'Spellcaster', 'Fairy', 'Fiend', 'Zombie', 'Machine', 'Aqua', 'Pyro', 'Rock', 'Winged Beast', 'Plant', 'Insect', 'Thunder', 'Dragon', 'Beast', 'Beast-Warrior', 'Dinosaur', 'Fish', 'Sea Serpent', 'Reptile', 'Psychic', 'Wyrm', 'Cyberse'];
  const attrs = ['DARK', 'LIGHT', 'EARTH', 'WATER', 'FIRE', 'WIND'];
  E['Quantum Cat'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && freeMZ(e, p),
    *activate(e, link, p) {
      const r = yield* chooseOption(e, p, 'Quantum Cat: declare a Monster Type', races, true);
      if (r === null) return false;
      const a = yield* chooseOption(e, p, 'Quantum Cat: declare an Attribute', attrs, true);
      if (a === null) return false;
      e.log(p, `Quantum Cat: ${races[r]} / ${attrs[a]}`);
      link.payload = { race: races[r], attribute: attrs[a] };
    },
    *resolve(e, link, p) {
      if (!e.fieldCard(link.card.uid) || !freeMZ(e, p)) return;
      // A Level 4 Normal Monster with the declared Type and Attribute (read by e.raceOf / attrOf / levelOf).
      const d = (link.payload ?? {}) as { race?: string; attribute?: string };
      ((fx(e).trapMonster ??= {}) as Record<number, unknown>)[link.card.uid] = { race: d.race, attribute: d.attribute, level: 4 };
      yield* e.specialSummon(link.card.uid, p, 'def');
    },
    baseStats: (e, m) => (e.find(m.uid)?.loc.zone === 'mz' ? { atk: 0, def: 2200 } : undefined),
  };

  E['Quarantine'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    *onEndPhase(e, _card, p) {
      const list = stOf(e, other(p)).filter((c) => !c.faceUp);
      if (!list.length || !(yield* e.yesno(p, "Quarantine: look at one of your opponent's Set cards?"))) return;
      const t = yield* pickOne(e, p, 'Reveal which Set card?', list);
      if (t) yield* e.reveal(p, 'Quarantine reveals', [t]);
    },
  };

  E["Queen's Pawn"] = {
    canActivate: (e, _c, p, t, ctx) => {
      if (t !== 'destroyed' || ctx.prevController !== other(p) || !freeMZ(e, p)) return false;
      const d = destroyer(e, ctx);
      return !!d && e.controller(d.uid) === p && named(e, d, 'Amazoness') && e.player(p).deck.some((c) => isMonster(e, c) && named(e, c, 'Amazoness') && levelOf(e, c) <= 4 && !isExtraOrRitual(e, c));
    },
    *resolve(e, _l, p) {
      yield* summonOneOf(e, p, "Queen's Pawn: Special Summon which Amazoness?", e.player(p).deck.filter((c) => isMonster(e, c) && named(e, c, 'Amazoness') && levelOf(e, c) <= 4 && !isExtraOrRitual(e, c)));
    },
  };

  // ---------- R ----------
  const heroCount = (e: Engine, p: Pid) => e.monsters(p).filter((m) => m.faceUp && named(e, m, 'Elemental HERO')).length;
  E['R - Righteous Justice'] = {
    canActivate: (e, c, p, t) => isMain(t) && heroCount(e, p) > 0 && allST(e).some((x) => x.uid !== c.uid),
    *resolve(e, link, p) {
      const list = allST(e).filter((x) => x.uid !== link.card.uid);
      const n = Math.min(heroCount(e, p), list.length);
      if (!n) return;
      const chosen = yield* pick(e, p, `R - Righteous Justice: destroy ${n} Spell/Trap Card(s)`, list, n, n);
      if (chosen) yield* e.destroy(chosen.map((c) => c.uid));
    },
  };

  E['Raging Flame Sprite'] = {
    directAttack: true,
    *onBattleDamage(e, m) {
      if (e.state.battle && e.state.battle.target === null && e.fieldCard(m.uid)) boostPerm(m, 1000);
    },
  };

  const cloudian = (e: Engine, p: Pid) => e.monsters(p).filter((m) => m.faceUp && named(e, m, 'Cloudian'));
  E['Rain Storm'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && cloudian(e, p).length > 0 && [...e.monsters(other(p)), ...stOf(e, other(p))].length > 0,
    *resolve(e, _l, p) {
      const m = yield* pickOne(e, p, 'Rain Storm: select which "Cloudian" monster?', cloudian(e, p));
      if (!m) return;
      const opt = yield* chooseOption(e, p, 'Rain Storm: reduce its ATK by', ['1000: destroy 1 Spell/Trap', '2000: destroy 2 cards']);
      if (opt === 0) {
        boostPerm(m, -1000);
        const t = yield* pickOne(e, p, 'Destroy which Spell/Trap?', stOf(e, other(p)));
        if (t) yield* e.destroy([t.uid]);
      } else if (opt === 1) {
        boostPerm(m, -2000);
        const chosen = yield* pick(e, p, 'Destroy which 2 cards?', [...e.monsters(other(p)), ...stOf(e, other(p))], 2, 2);
        if (chosen) yield* e.destroy(chosen.map((c) => c.uid));
      }
    },
  };

  const darkGy = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && attrOf(e, c) === 'DARK');
  E['Rainbow Dark Dragon'] = {
    cannotNormalSummon: true,
    summonRule: procOnly,
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && new Set(darkGy(e, p).map((c) => c.name)).size >= 7,
      *run(e, c, p) {
        const chosen: Card[] = [];
        while (chosen.length < 7) {
          const opts = darkGy(e, p).filter((x) => !chosen.some((y) => e.sameName(y, x)));
          const x = yield* pickOne(e, p, `Banish DARK monsters with different names (${chosen.length}/7)`, opts, true);
          if (!x) return;
          chosen.push(x);
        }
        for (const x of chosen) e.banish(x.uid);
        yield* procSummon(e, c, p);
      },
    },
    ignition: {
      can: (e, m, p) => darkGy(e, p).length > 0 || e.monsters(p).some((x) => x.uid !== m.uid && x.faceUp && attrOf(e, x) === 'DARK'),
      *run(e, m, p) {
        const list = [...e.monsters(p).filter((x) => x.uid !== m.uid && x.faceUp && attrOf(e, x) === 'DARK'), ...darkGy(e, p)];
        for (const x of list) e.banish(x.uid);
        if (e.fieldCard(m.uid)) boostPerm(m, 500 * list.length);
      },
    },
  };

  const notSummonTurn = (e: Engine, m: FieldCard) => m.tags?.ssTurn !== e.state.turn;
  E['Rainbow Dragon'] = {
    cannotNormalSummon: true,
    summonRule: procOnly,
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && crystalNames(e, p) >= 7,
      *run(e, c, p) {
        yield* procSummon(e, c, p);
      },
    },
    *onSpecialSummon(e, m) {
      tag(m).ssTurn = e.state.turn;
    },
    quick: {
      label: 'send Crystal Beasts to the GY for ATK',
      can: (e, card, p, t) => anyTime(t) && notSummonTurn(e, card as FieldCard) && e.monsters(p).some((m) => m.faceUp && named(e, m, 'Crystal Beast')),
      *run(e, card, p) {
        const list = e.monsters(p).filter((m) => m.faceUp && named(e, m, 'Crystal Beast'));
        for (const m of list) yield* e.sendToGrave(m.uid, 'cost');
        const me = e.fieldCard(card.uid);
        if (me?.faceUp) boostPerm(me, 1000 * list.length);
      },
    },
    ignition: {
      can: (e, m, p) => notSummonTurn(e, m) && e.player(p).gy.some((c) => named(e, c, 'Crystal Beast')),
      *run(e, _m, p) {
        const list = e.player(p).gy.filter((c) => named(e, c, 'Crystal Beast'));
        if (!list.length) return;
        for (const c of list) e.banish(c.uid);
        yield* shuffleField(e);
      },
    },
  };

  E['Rainbow Gravity'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && freeMZ(e, p) && crystalNames(e, p) >= 7 && [...e.player(p).deck, ...e.player(p).gy].some((c) => ultimateCrystal(e, c)),
    *resolve(e, _l, p) {
      if (crystalNames(e, p) < 7 || !freeMZ(e, p)) return;
      const c = yield* pickOne(e, p, 'Rainbow Gravity: Special Summon which "Ultimate Crystal" monster?', [...e.player(p).deck, ...e.player(p).gy].filter((x) => ultimateCrystal(e, x)));
      if (!c) return;
      const fromDeck = e.find(c.uid)?.loc.zone === 'deck';
      // Ignoring the Summoning conditions.
      fx(e).ignoreCond = c.uid;
      try {
        yield* e.specialSummon(c.uid, p, 'atk');
      } finally {
        fx(e).ignoreCond = undefined;
      }
      if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
    },
  };
}

