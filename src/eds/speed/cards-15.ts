// Speed Duel card scripts, batch 15 (Amazoness Scouts ... Spikeshield with Chain).
// Uses the Speed Duel hooks for face-up monsters (tributeFor, banishInstead, deckInstead, guardsFromAttack,
// graveAura, negatesEffect, onAnyToGrave, cannotBeTributed, fieldName) and the engine's activation locks.
import type { EffectDef, GraveEvent } from '../effects';
import type { SpeedHelpers } from './helpers';
import {
  allMonsters,
  allST,
  anyTime,
  attrOf,
  boostTurn,
  chooseOption,
  ctrl,
  discardCost,
  faceUpMonsters,
  freeMZ,
  freeST,
  info,
  isMain,
  isMonster,
  isNormalMonster,
  isSpell,
  isTrap,
  label,
  levelOf,
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
} from './helpers';
import type { Card, ChainLink, Engine, FieldCard, Pid, Step } from './helpers';

// ---------- local helpers ----------
const fx = (e: Engine) => e.state.fx;
const inZone = (e: Engine, uid: number, z: string) => e.find(uid)?.loc.zone === z;
const opt = (e: Engine, name: string, p: Pid, n = 1) => e.oncePerTurn(`${name}:${n}`, p);
const useOpt = (e: Engine, name: string, p: Pid, n = 1) => e.useOnce(`${name}:${n}`, p);
/** Remembers who was resolving an effect when a card left the field (to tell "destroyed by your opponent's card"). */
const leftBy = (e: Engine) => (fx(e).leftBy15 ??= {}) as Record<number, { by: number; up: number; mz: number }>;
const noteLeave = (e: Engine, fc: FieldCard) => {
  leftBy(e)[fc.uid] = { by: e.actor ?? -1, up: fc.faceUp ? 1 : 0, mz: fc.equippedTo === undefined && info(e, fc).kind === 'monster' ? 1 : 0 };
};
const byOpponent = (e: Engine, card: Card, controller: Pid, byBattle: boolean) => {
  if (byBattle) return true;
  const a = leftBy(e)[card.uid]?.by;
  return a !== undefined && a !== -1 && a !== controller;
};
/** Level change until the end of this turn (read by helpers.levelOf). */
function shiftLevel(e: Engine, m: FieldCard, delta: number) {
  const t = tag(m);
  if (t.lvTurn !== e.state.turn) (t.lvTurn = e.state.turn), (t.lvDelta = 0);
  t.lvDelta += delta;
  e.log(null, `${m.name} is now Level ${levelOf(e, m)}`);
}
/** The name an effect gave a monster until the end of this turn (Ancient Gear Gadget, Neo-Spacian Dark Panther). */
const nameAs = (e: Engine) => (fx(e).nameAs ??= {}) as Record<number, { name: string; turn: number }>;
const tempName = (e: Engine, m: FieldCard) => {
  const n = nameAs(e)[m.uid];
  return n && n.turn === e.state.turn ? n.name : undefined;
};
/** The card whose chain link is resolving right now, if any. */
const resolvingCard = (e: Engine): Card | null => {
  const uid = (e as unknown as { levelSource: number | null }).levelSource;
  return uid === null || uid === undefined ? null : e.find(uid)?.card ?? null;
};
/** Puts a card from the hand, Deck, GY or banishment face-up into a Spell & Trap Zone, equipped to a monster. */
function placeEquip(e: Engine, uid: number, p: Pid, hostUid: number): FieldCard | null {
  const zone = freeST(e, p);
  const f = e.find(uid);
  const host = e.fieldCard(hostUid);
  if (zone < 0 || !f || !host) return null;
  const z = f.loc.zone;
  if (z !== 'hand' && z !== 'deck' && z !== 'gy' && z !== 'removed') return null;
  e.player(f.loc.player)[z].splice(f.loc.index, 1);
  const fc: FieldCard = { uid, name: f.card.name, owner: f.card.owner, pos: 'atk', faceUp: true, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true, equippedTo: host.uid };
  host.equips.push(uid);
  e.player(p).sz[zone] = fc;
  e.event('activate', { uid, player: p });
  return fc;
}
/** Returns a banished monster to its controller's field face-up (not a Summon). */
function returnToField(e: Engine, uid: number, p: Pid, pos: 'atk' | 'def') {
  const f = e.find(uid);
  if (!f || f.loc.zone !== 'removed') return false;
  const ps = e.player(p);
  const z = ps.mz.findIndex((x) => x === null);
  if (z < 0) return false;
  e.player(f.loc.player).removed.splice(f.loc.index, 1);
  ps.mz[z] = { uid, name: f.card.name, owner: f.card.owner, pos, faceUp: true, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
  e.event('summon', { uid, player: p });
  e.log(p, `${f.card.name} returns to the field`);
  return true;
}
/** An Equip Trap: target a face-up monster passing `test` when activated, attach on resolve. */
function equipTrap(test: (e: Engine, m: FieldCard, p: Pid) => boolean, extra: Partial<EffectDef>): EffectDef {
  const list = (e: Engine, p: Pid) => targetable(e, allMonsters(e)).filter((m) => m.faceUp && test(e, m, p));
  return {
    canActivate: (e, _c, p, t) => anyTime(t) && list(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, `Equip ${link.card.name} to which monster?`, list(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const host = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      const eq = e.fieldCard(link.card.uid);
      if (!host || !eq || !host.faceUp || !test(e, host, p)) return;
      eq.equippedTo = host.uid;
      host.equips.push(eq.uid);
      eq.active = true;
      e.log(p, `${eq.name} is equipped to ${host.name}`);
    },
    ...extra,
  };
}
/** Banish-when-it-leaves-the-field bookkeeping (Cyclamen, Scrap Mind Reader). */
const banishMarks = (e: Engine) => (fx(e).banish15 ??= []) as number[];
const banishIfMarked: EffectDef['onLeaveField'] = function* (e, fc) {
  noteLeave(e, fc);
  const list = banishMarks(e);
  if (!list.includes(fc.uid)) return;
  fx(e).banish15 = list.filter((u) => u !== fc.uid);
  const z = e.find(fc.uid)?.loc.zone;
  if (z && z !== 'removed') {
    e.banish(fc.uid);
    e.log(fc.owner, `${fc.name} is banished`);
  }
};
const pandemonium = (e: Engine) => !!e.anyActive('Pandemonium') && !e.spellsNegated();
const wasFusionSummoned = (m: FieldCard) => m.tags?.ss === 5;
/** "Tribute Summoned": a face-up Level 5+ monster that was Normal Summoned (not Special Summoned). */
const tributeSummoned = (e: Engine, m: FieldCard) => m.faceUp && !m.tags?.ss && (info(e, m).level ?? 0) >= 5 && info(e, m).kind === 'monster';
const RACES_ATTR_ELECTRUM = ['WIND', 'WATER', 'FIRE', 'EARTH', 'LIGHT'];

export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  // ======================= Effect Monsters =======================
  // "Cannot be targeted by monster effects" is applied as "by your opponent's card effects" (the engine does not tell monster effects apart).
  E['Amazoness Scouts'] = {
    quick: {
      label: 'Tribute it to protect your "Amazoness" monsters',
      can: (e, c, p) => {
        const m = e.fieldCard(c.uid);
        return !!m && m.faceUp && e.controller(m.uid) === p && !e.untributable(m);
      },
      *cost(e, c, p) {
        e.log(p, `${e.player(p).name} Tributes Amazoness Scouts`);
        yield* e.sendToGrave(c.uid, 'tribute');
      },
      *run(e, _c, p) {
        const list = faceUpMonsters(e, p).filter((m) => named(m, 'Amazoness'));
        for (const m of list) {
          tag(m).effProofTurn = e.state.turn;
          tag(m).oppNoTargetUntil = e.state.turn;
        }
        if (list.length) e.log(p, `Amazoness Scouts: ${list.map((m) => m.name).join(', ')} cannot be targeted or destroyed by card effects this turn`);
      },
    },
  };

  let gadgets: string[] | null = null;
  const gadgetNames = (e: Engine) =>
    (gadgets ??= [...new Set([...e.db.values()].filter((c) => c.kind === 'monster' && named(c.name, 'Gadget') && c.name !== 'Ancient Gear Gadget').map((c) => c.name))].sort());
  function* gadgetDeclare(e: Engine, _m: FieldCard, p: Pid): Step {
    if (!(yield* e.yesno(p, 'Ancient Gear Gadget: declare a card type your opponent cannot activate while your monsters attack this turn?'))) return;
    const k = yield* chooseOption(e, p, 'Ancient Gear Gadget: declare a card type', ['Monster', 'Spell', 'Trap']);
    if (k === null) return;
    const kind = ['monster', 'spell', 'trap'][k];
    fx(e).battleLock = { player: other(p), turn: e.state.turn, kind };
    e.log(p, `Ancient Gear Gadget declares ${['Monster', 'Spell', 'Trap'][k]}: ${e.player(other(p)).name} cannot activate them while ${e.player(p).name}'s monsters attack this turn`);
  }
  E['Ancient Gear Gadget'] = {
    *onSummon(e, m, p, kind) {
      if (kind === 'normal') yield* gadgetDeclare(e, m, p);
    },
    onSpecialSummon: gadgetDeclare,
    ignition: {
      can: (e) => gadgetNames(e).length > 0,
      *run(e, m, p) {
        const names = gadgetNames(e);
        const k = yield* chooseOption(e, p, 'Ancient Gear Gadget: declare a "Gadget" monster name', names);
        if (k === null || !e.fieldCard(m.uid)) return;
        nameAs(e)[m.uid] = { name: names[k], turn: e.state.turn };
        e.log(p, `Ancient Gear Gadget's name becomes "${names[k]}" until the End Phase`);
      },
    },
    fieldName: (e, m) => tempName(e, m),
  };

  // "When this card is Summoned, toss a coin" (tags.coin: 1 Heads, 2 Tails).
  function* arcanaCoin(e: Engine, m: FieldCard, p: Pid): Step {
    const heads = e.roll(2) === 1;
    tag(m).coin = heads ? 1 : 2;
    e.log(p, `${m.name}: the coin shows ${heads ? 'Heads' : 'Tails'}`);
  }
  E['Arcana Force I - The Magician'] = {
    onSummon: (e, m, p) => arcanaCoin(e, m, p),
    onSpecialSummon: arcanaCoin,
    quick: {
      repeat: true,
      label: 'a Spell Card was activated',
      can: (e, c, _p, t, ctx) => {
        const m = e.fieldCard(c.uid);
        return t === 'spell' && !!ctx.link && isSpell(e, ctx.link.card) && !(ctx.link.payload as { effect?: string } | undefined)?.effect && !!m?.tags?.coin;
      },
      *run(e, c, p) {
        const m = e.fieldCard(c.uid);
        if (!m || !m.faceUp) return;
        if (m.tags?.coin === 1) {
          tag(m).magTurn = e.state.turn;
          e.log(p, `${m.name}'s ATK becomes double its original ATK until the End Phase`);
        } else if (m.tags?.coin === 2) e.gainLp(other(p), 500);
      },
    },
    selfBonus: (e, m) => (m.tags?.magTurn === e.state.turn ? { atk: e.baseStats(m).atk, def: 0 } : { atk: 0, def: 0 }),
  };

  E['Banisher of the Radiance'] = { banishInstead: () => true };

  // Its Fusion Material restriction and the "only 1 face-up Blue Duston" rule are not scripted; the banished card is face-up.
  E['Blue Duston'] = {
    cannotBeTributed: () => true,
    *onDestroyed(e, _card, controller) {
      const hand = e.player(controller).hand;
      if (!hand.length) return;
      const c = hand[Math.floor(e.rand() * hand.length)];
      e.banish(c.uid);
      ((fx(e).lightforce ??= []) as { uid: number; back: number }[]).push({ uid: c.uid, back: e.state.turn + 1 });
      e.log(controller, `Blue Duston banishes a random card from ${e.player(controller).name}'s hand until the next Standby Phase`);
    },
  };

  E['Chow Len the Prophet'] = {
    ignition: {
      can: (e, _m, p) => e.spells(other(p)).some((c) => !c.faceUp),
      *run(e, _m, p) {
        const k = yield* chooseOption(e, p, 'Chow Len the Prophet: declare a card type', ['Spell', 'Trap']);
        if (k === null) return;
        const t = yield* pickOne(e, p, 'Chow Len the Prophet: look at which Set card?', e.spells(other(p)).filter((c) => !c.faceUp));
        if (!t) return;
        e.log(p, `${e.player(p).name} declares ${k === 0 ? 'Spell' : 'Trap'} and looks at a Set card`);
        yield* e.reveal(p, `Chow Len the Prophet: the Set card is ${t.name}`, [t]);
        if ((k === 0 && isSpell(e, t)) || (k === 1 && isTrap(e, t))) {
          tag(t).noActTurn = e.state.turn;
          e.log(p, 'Chow Len the Prophet: that card cannot be activated this turn');
        }
      },
    },
  };

  const plants = (e: Engine, p: Pid, except?: number) => targetable(e, faceUpMonsters(e, p)).filter((m) => m.uid !== except && raceOf(e, m) === 'Plant');
  function* cyclamen(e: Engine, card: Card, p: Pid): Step {
    if (!opt(e, 'Cyclamen the Rikka Fairy', p)) return;
    useOpt(e, 'Cyclamen the Rikka Fairy', p);
    e.log(p, `${e.player(p).name} Tributes Cyclamen the Rikka Fairy`);
    yield* e.sendToGrave(card.uid, 'tribute');
    const list = plants(e, p);
    if (!list.length) return;
    const chosen = yield* pick(e, p, 'Cyclamen the Rikka Fairy: reduce the Level of up to 2 Plant monsters by 2', list, 1, 2);
    for (const m of chosen ?? []) if (e.fieldCard(m.uid)?.faceUp) shiftLevel(e, m, -2);
  }
  E['Cyclamen the Rikka Fairy'] = {
    handIgnition: { can: (e, _c, p) => opt(e, 'Cyclamen the Rikka Fairy', p) && plants(e, p).length > 0, run: cyclamen },
    ignition: { can: (e, m, p) => opt(e, 'Cyclamen the Rikka Fairy', p) && !e.untributable(m) && plants(e, p, m.uid).length > 0, run: (e, m, p) => cyclamen(e, m, p) },
    *onSentToGrave(e, card, _owner, _from, reason) {
      if (reason === 'tribute') ((fx(e).cyclamen ??= {}) as Record<number, number>)[card.uid] = e.state.turn;
    },
    *onEndPhaseInGrave(e, card, p) {
      if (((fx(e).cyclamen ?? {}) as Record<number, number>)[card.uid] !== e.state.turn || !freeMZ(e, p) || !opt(e, 'Cyclamen the Rikka Fairy', p, 2)) return;
      if (!(yield* e.yesno(p, 'Cyclamen the Rikka Fairy: Special Summon it from the GY (banished when it leaves the field)?'))) return;
      useOpt(e, 'Cyclamen the Rikka Fairy', p, 2);
      yield* e.specialSummon(card.uid, p, 'atk');
      if (e.fieldCard(card.uid)) banishMarks(e).push(card.uid);
    },
    onLeaveField: banishIfMarked,
  };

  const fiendsInGy = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && info(e, c).race === 'Fiend');
  const necroDead = (e: Engine) => (fx(e).necroDead ??= {}) as Record<number, number>;
  E['Dark Necrofear'] = {
    cannotNormalSummon: true,
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && fiendsInGy(e, p).length >= 3,
      *run(e, card, p) {
        const chosen = yield* pick(e, p, 'Dark Necrofear: banish 3 Fiend monsters from your GY', fiendsInGy(e, p), 3, 3, true);
        if (!chosen || chosen.length < 3) return;
        for (const c of chosen) e.banish(c.uid);
        yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
    *onLeaveField(e, fc, ctl) {
      noteLeave(e, fc);
      // Equipped by its own effect: control of the monster goes back.
      if (fc.equippedTo === undefined || !fc.tags?.necro) return;
      const host = e.fieldCard(fc.equippedTo);
      if (host && e.controller(host.uid) === ctl && e.takeControl(host.uid, other(ctl))) e.log(null, `${host.name} returns to ${e.player(other(ctl)).name}`);
    },
    *onDestroyed(e, card, controller, byBattle) {
      const l = leftBy(e)[card.uid];
      if (l?.mz && card.owner === controller && byOpponent(e, card, controller, byBattle)) necroDead(e)[card.uid] = e.state.turn;
    },
    *onEndPhaseInGrave(e, card, p) {
      if (necroDead(e)[card.uid] !== e.state.turn) return;
      delete necroDead(e)[card.uid];
      const list = targetable(e, faceUpMonsters(e, other(p)));
      if (!list.length || freeST(e, p) < 0) return;
      const t = yield* pickOne(e, p, 'Dark Necrofear: equip it to which of your opponent\'s monsters?', list);
      if (!t || !e.fieldCard(t.uid)) return;
      const eq = placeEquip(e, card.uid, p, t.uid);
      if (!eq) return;
      tag(eq).necro = 1;
      e.log(p, `Dark Necrofear is equipped to ${t.name}`);
      if (e.takeControl(t.uid, p)) e.log(p, `${e.player(p).name} takes control of ${t.name}`);
    },
  };

  // The die roll happens as the opponent's effect resolves; a negated Spell/Trap goes to the GY (a monster is not destroyed).
  E['Desrook Archfiend'] = {
    *onStandby(e, m, p) {
      if (e.state.turnPlayer !== p || pandemonium(e)) return;
      if (payLp(e, p, 500)) return;
      e.log(p, 'Desrook Archfiend cannot be kept and is destroyed');
      yield* e.destroy([m.uid]);
    },
    negatesEffect: (e, m, q, link) => {
      if (link.player !== other(q) || link.targetUid !== m.uid) return false;
      const r = e.roll(6);
      e.log(q, `Desrook Archfiend rolls a ${r}`);
      return r === 3;
    },
    quick: {
      from: 'hand',
      repeat: true,
      label: 'send it to the GY to revive Terrorking Archfiend',
      can: (e, _c, p, t, ctx) => t === 'destroyed' && ctx.uid !== undefined && ctx.prevController === p && e.find(ctx.uid)?.card.name === 'Terrorking Archfiend' && inZone(e, ctx.uid, 'gy') && e.find(ctx.uid)!.card.owner === p,
      *cost(e, c, _p, link, ctx) {
        yield* e.sendToGrave(c.uid, 'cost');
        link.targetUid = ctx.uid;
      },
      *run(e, _c, p, link) {
        if (link.targetUid !== undefined && inZone(e, link.targetUid, 'gy') && freeMZ(e, p)) yield* e.specialSummon(link.targetUid, p, 'atk');
      },
    },
  };

  const twoTributes = (attr: string): EffectDef => ({ tributeFor: (e, _m, _p, monster, need) => need === 2 && attrOf(e, monster) === attr });
  E['Double Coston'] = twoTributes('DARK');
  E['Kaiser Sea Horse'] = twoTributes('LIGHT');
  E['Whirlwind Prodigy'] = twoTributes('WIND');

  E['Evilswarm Zahak'] = {
    onLeaveField: function* (e, fc) {
      noteLeave(e, fc);
    },
    *onDestroyed(e, card, controller, byBattle) {
      const l = leftBy(e)[card.uid];
      if (!l?.up || card.owner !== controller || !byOpponent(e, card, controller, byBattle)) return;
      const list = targetable(e, faceUpMonsters(e)).filter((m) => !!m.tags?.ss && levelOf(e, m) >= 5);
      if (!list.length) return;
      const t = yield* pickOne(e, controller, 'Evilswarm Zahak: destroy which Special Summoned Level 5+ monster?', list);
      if (t && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
    },
  };

  const handLevels = (e: Engine, p: Pid) => e.player(p).hand.filter((c) => isMonster(e, c) && (info(e, c).level ?? 0) > 0);
  E['Flelf'] = {
    ignition: {
      can: (e, _m, p) => handLevels(e, p).length > 0,
      *run(e, m, p) {
        const c = yield* pickOne(e, p, 'Flelf: reveal which monster?', handLevels(e, p));
        if (!c) return;
        e.log(p, `${e.player(p).name} reveals ${c.name}`);
        const me = e.fieldCard(m.uid);
        if (me?.faceUp) shiftLevel(e, me, info(e, c).level ?? 0);
      },
    },
  };

  const gyLevels = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && (info(e, c).level ?? 0) > 0 && !['Xyz', 'Link'].includes(info(e, c).sub));
  E['Gagaga Caesar'] = {
    cannotAttack: (e, m, p) => !faceUpMonsters(e, p).some((x) => x.uid !== m.uid && named(x, 'Gagaga')),
    ignition: {
      can: (e, _m, p) => gyLevels(e, p).length > 0,
      *run(e, _m, p) {
        const c = yield* pickOne(e, p, 'Gagaga Caesar: banish which monster from your GY?', gyLevels(e, p));
        if (!c) return;
        const lv = info(e, c).level ?? 1;
        e.banish(c.uid);
        for (const m of faceUpMonsters(e, p).filter((x) => named(x, 'Gagaga'))) {
          tag(m).lvSet = lv;
          tag(m).lvTurn = -1;
        }
        e.log(p, `The Levels of ${e.player(p).name}'s "Gagaga" monsters become ${lv}`);
      },
    },
  };

  E['Grave Protector'] = { deckInstead: (e, _m, moving) => isMonster(e, moving) };

  // "Special Summoned by the effect of a Heroic Challenger monster": the resolving card, or another face-up one you control.
  E['Heroic Challenger - Clasp Sword'] = {
    *onSpecialSummon(e, m, p) {
      const src = resolvingCard(e);
      const byHc = (src && src.uid !== m.uid && named(src, 'Heroic Challenger') && isMonster(e, src)) || faceUpMonsters(e, p).some((x) => x.uid !== m.uid && named(x, 'Heroic Challenger'));
      const test = (c: Card) => isMonster(e, c) && named(c, 'Heroic Challenger');
      if (!byHc || !opt(e, m.name, p) || !e.player(p).deck.some(test) || !(yield* e.yesno(p, 'Heroic Challenger - Clasp Sword: add a "Heroic Challenger" monster from your Deck to your hand?'))) return;
      useOpt(e, m.name, p);
      yield* searchDeck(e, p, 'Add which "Heroic Challenger" monster?', test);
    },
  };

  E["Magician's Valkyria"] = {
    guardsFromAttack: (e, _src, target) => target.faceUp && raceOf(e, target) === 'Spellcaster',
  };

  E['Marina, Princess of Sunflowers'] = {
    *onAnyToGrave(e, m, p, events: GraveEvent[]) {
      if (events.length !== 1) return;
      const v = events[0];
      if (v.from !== 'mz' || v.reason !== 'destroyed' || !v.toGy || v.token || v.controller !== p || v.card.uid === m.uid || v.race !== 'Plant' || !isMonster(e, v.card)) return;
      const targets = [...targetable(e, e.monsters(other(p))), ...stOf(e, other(p))];
      if (!targets.length || !(yield* e.yesno(p, 'Marina, Princess of Sunflowers: destroy 1 card your opponent controls?'))) return;
      const t = yield* pickOne(e, p, 'Marina: destroy which card?', targets);
      if (!t || !e.fieldCard(m.uid)?.faceUp || !e.fieldCard(t.uid)) return;
      e.log(p, `Marina, Princess of Sunflowers destroys ${label(t)}`);
      yield* e.destroy([t.uid]);
    },
  };

  // It takes the name only: copying another monster's scripted effects is not supported.
  E['Neo-Spacian Dark Panther'] = {
    ignition: {
      can: (e, _m, p) => targetable(e, faceUpMonsters(e, other(p))).length > 0,
      *run(e, m, p) {
        const t = yield* pickOne(e, p, 'Neo-Spacian Dark Panther: copy which monster?', targetable(e, faceUpMonsters(e, other(p))));
        if (!t || !e.fieldCard(m.uid)) return;
        nameAs(e)[m.uid] = { name: t.name, turn: e.state.turn };
        e.log(p, `Neo-Spacian Dark Panther's name becomes "${t.name}" until the End Phase`);
      },
    },
    fieldName: (e, m) => tempName(e, m),
  };

  E['Phantom Beast Cross-Wing'] = {
    graveAura: (_e, _c, m) => (m.name === 'Gazelle the King of Mythical Beasts' || named(m, 'Phantom Beast') ? { atk: 300, def: 0 } : undefined),
  };

  E['Proto-Cyber Dragon'] = { fieldName: () => 'Cyber Dragon' };

  // Speed Duel has no Main Phase 2, so its effect never applies.
  const scraps = (e: Engine, p: Pid) => faceUpMonsters(e, p).filter((m) => named(m, 'Scrap') && m.name !== 'Scrap Mind Reader');
  E['Scrap Mind Reader'] = {
    graveIgnition: {
      can: (e, c, p) => e.state.phase === 'M2' && opt(e, c.name, p) && scraps(e, p).length > 0,
      *run(e, c, p) {
        const t = yield* pickOne(e, p, 'Scrap Mind Reader: destroy which "Scrap" monster?', scraps(e, p), true);
        if (!t) return;
        useOpt(e, c.name, p);
        yield* e.destroy([t.uid]);
        if (e.fieldCard(t.uid) || !inZone(e, c.uid, 'gy') || !freeMZ(e, p)) return;
        yield* e.specialSummon(c.uid, p, 'atk');
        if (e.fieldCard(c.uid)) banishMarks(e).push(c.uid);
      },
    },
    onLeaveField: banishIfMarked,
  };

  // Effects that target a card in the GY, or that are activated in the GY, are negated as they resolve.
  E['The End of Anubis'] = {
    negatesEffect: (e, m, _q, link) => {
      const hit = (link.targetUid !== undefined && inZone(e, link.targetUid, 'gy')) || link.loc.zone === 'gy';
      if (hit) e.log(null, `The End of Anubis negates ${link.card.name}`);
      return hit;
    },
  };

  // The Graveyard revival restriction is not scripted. A negated Trap goes to the GY.
  E['Tyrant Dragon'] = {
    attacks: (e, m) => {
      const c = e.controller(m.uid);
      return c !== null && e.monsters(other(c)).length > 0 ? 2 : 1;
    },
    negatesEffect: (e, m, _q, link) => {
      if (!isTrap(e, link.card) || link.targetUid !== m.uid) return false;
      e.log(null, `Tyrant Dragon negates ${link.card.name}`);
      return true;
    },
  };

  // ======================= Fusion Monsters =======================
  const chimeraN = (e: Engine, m: FieldCard) => m.tags?.chimeraN ?? 0;
  E['Chimeratech Overdragon'] = {
    *onSpecialSummon(e, m, p) {
      if (!wasFusionSummoned(m)) return;
      const n = Math.max(2, ((fx(e).fusionMatList ?? {}) as Record<number, number[]>)[m.uid]?.length ?? 2);
      tag(m).chimeraN = n;
      e.log(p, `Chimeratech Overdragon was Fusion Summoned with ${n} materials: ${n * 800} ATK/DEF, ${n} attacks`);
      const others = [...e.monsters(p).filter((x) => x.uid !== m.uid), ...stOf(e, p)];
      if (!others.length) return;
      e.log(p, 'Chimeratech Overdragon sends all other cards its controller controls to the GY');
      const self = e;
      yield* e.together((function* (): Step {
        for (const c of others) if (self.fieldCard(c.uid)) yield* self.sendToGrave(c.uid, 'used');
      })());
    },
    baseStats: (e, m) => ({ atk: chimeraN(e, m) * 800, def: chimeraN(e, m) * 800 }),
    attacks: (e, m) => Math.max(1, chimeraN(e, m)),
  };

  const dheroLow = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && named(c, 'Destiny HERO') && (info(e, c).level ?? 0) <= 4);
  E['Destiny HERO - Dystopia'] = {
    *onSpecialSummon(e, m, p) {
      if (!opt(e, m.name, p) || !dheroLow(e, p).length || !(yield* e.yesno(p, 'Destiny HERO - Dystopia: inflict damage equal to a Level 4 or lower "Destiny HERO" in your GY?'))) return;
      const c = yield* pickOne(e, p, 'Dystopia: which "Destiny HERO" monster?', dheroLow(e, p));
      if (!c) return;
      useOpt(e, m.name, p);
      e.damage(other(p), Math.max(0, info(e, c).atk ?? 0));
    },
    quick: {
      label: 'destroy 1 card on the field',
      can: (e, c, p) => {
        const m = e.fieldCard(c.uid);
        return !!m && m.faceUp && opt(e, c.name, p, 2) && e.atkOf(m) !== e.baseStats(m).atk && [...targetable(e, allMonsters(e)), ...allST(e)].length > 0;
      },
      *cost(e, c, p, link) {
        const t = yield* pickOne(e, p, 'Dystopia: destroy which card?', [...targetable(e, allMonsters(e)), ...allST(e)], true);
        if (!t) return false;
        useOpt(e, c.name, p, 2);
        link.targetUid = t.uid;
      },
      *run(e, c, p, link) {
        if (link.targetUid === undefined || !e.fieldCard(link.targetUid)) return;
        yield* e.destroy([link.targetUid]);
        const m = e.fieldCard(c.uid);
        if (e.fieldCard(link.targetUid) || !m || !m.faceUp) return;
        m.atkMod -= e.atkOf(m) - e.baseStats(m).atk;
        e.log(p, `Destiny HERO - Dystopia's ATK becomes ${e.atkOf(m)}`);
      },
    },
  };

  // Its extra Attributes are only counted for its own ATK gain.
  E['Elemental HERO Electrum'] = {
    *onSpecialSummon(e, m, p) {
      if (!wasFusionSummoned(m)) return;
      const n = e.player(0).removed.length + e.player(1).removed.length;
      for (const q of [0, 1] as Pid[]) {
        for (const c of e.player(q).removed.slice()) e.toDeckTop(c.uid);
        e.player(q).deck = e.shuffle(e.player(q).deck);
      }
      if (n) e.log(p, `Elemental HERO Electrum shuffles ${n} banished card${n > 1 ? 's' : ''} into the Deck`);
    },
    selfBonus: (e, m) => {
      const c = ctrl(e, m);
      const n = faceUpMonsters(e, other(c)).filter((x) => RACES_ATTR_ELECTRUM.includes(attrOf(e, x))).length;
      return { atk: 300 * n, def: 0 };
    },
  };

  // The opponent's monsters can only choose this card as their attack target; the forced position change and the forced attack are not scripted.
  E['Evil HERO Malicious Fiend'] = {
    guardsFromAttack: () => true,
  };

  const crystalBeasts = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && named(c, 'Crystal Beast'));
  E['Rainbow Overdragon'] = {
    ignition: {
      can: (e, _m, p) => crystalBeasts(e, p).length > 0,
      *run(e, m, p) {
        const c = yield* pickOne(e, p, 'Rainbow Overdragon: banish which "Crystal Beast" monster?', crystalBeasts(e, p));
        if (!c) return;
        const atk = Math.max(0, info(e, c).atk ?? 0);
        e.banish(c.uid);
        const me = e.fieldCard(m.uid);
        if (me?.faceUp) {
          boostTurn(me, atk);
          e.log(p, `Rainbow Overdragon gains ${atk} ATK until the end of this turn`);
        }
      },
    },
    quick: {
      label: 'Tribute it: shuffle all cards on the field into the Deck',
      can: (e, c, p) => {
        const m = e.fieldCard(c.uid);
        return !!m && m.faceUp && e.controller(m.uid) === p && wasFusionSummoned(m) && !e.untributable(m);
      },
      *cost(e, c, p) {
        e.log(p, `${e.player(p).name} Tributes Rainbow Overdragon`);
        yield* e.sendToGrave(c.uid, 'tribute');
      },
      *run(e, _c, p) {
        const all = [...allMonsters(e), ...allST(e)];
        e.log(p, 'Rainbow Overdragon: all cards on the field are shuffled into the Deck');
        for (const c of all) {
          if (!e.fieldCard(c.uid)) continue;
          if (c.token) yield* e.sendToGrave(c.uid, 'used');
          else e.toDeckTop(c.uid);
        }
        for (const q of [0, 1] as Pid[]) e.player(q).deck = e.shuffle(e.player(q).deck);
      },
    },
  };

  // ======================= Ritual Monster =======================
  // A Special Summon from the hand counts as its Ritual Summon. The delayed destruction happens in your next Standby Phase.
  const nephRituals = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.player(p).deck].filter((c) => isMonster(e, c) && named(c, 'Nephthys') && info(e, c).sub === 'Ritual' && c.name !== 'Conductor of Nephthys');
  const conductorDue = (e: Engine) => (fx(e).conductor ??= {}) as Record<number, number>;
  E['Conductor of Nephthys'] = {
    *onSpecialSummon(e, m, p) {
      if (m.tags?.ss !== 1 || !opt(e, m.name, p) || !freeMZ(e, p) || !nephRituals(e, p).length) return;
      if (!(yield* e.yesno(p, 'Conductor of Nephthys: Special Summon a "Nephthys" Ritual Monster from your hand or Deck?'))) return;
      useOpt(e, m.name, p);
      yield* summonOneOf(e, p, 'Special Summon which "Nephthys" Ritual Monster?', nephRituals(e, p));
    },
    *onSentToGrave(e, card, owner, from, reason) {
      const src = resolvingCard(e);
      const ok = reason === 'tribute' || (reason === 'destroyed' && from === 'mz' && !!src && named(src, 'Nephthys'));
      if (!ok || !opt(e, card.name, owner, 2) || !(yield* e.yesno(owner, 'Conductor of Nephthys: destroy up to 3 "Nephthys" cards during the next Standby Phase?'))) return;
      useOpt(e, card.name, owner, 2);
      conductorDue(e)[card.uid] = e.state.turn;
    },
    *onStandbyInGrave(e, card, p) {
      const at = conductorDue(e)[card.uid];
      if (at === undefined || at >= e.state.turn) return;
      delete conductorDue(e)[card.uid];
      const test = (c: Card) => named(c, 'Nephthys') && !(isMonster(e, c) && info(e, c).sub === 'Ritual');
      const ps = e.player(p);
      for (const [where, list] of [
        ['hand', () => ps.hand.filter(test)],
        ['Deck', () => ps.deck.filter(test)],
        ['field', () => [...e.monsters(p), ...stOf(e, p)].filter(test)],
      ] as [string, () => Card[]][]) {
        const cands = list();
        if (!cands.length) continue;
        const c = yield* pickOne(e, p, `Conductor of Nephthys: destroy which "Nephthys" card from your ${where}? (cancel to skip)`, cands, true);
        if (!c) continue;
        if (where === 'field') yield* e.destroy([c.uid]);
        else yield* e.sendToGrave(c.uid, 'destroyed');
        e.log(p, `Conductor of Nephthys destroys ${c.name}`);
      }
      ps.deck = e.shuffle(ps.deck);
    },
  };

  // ======================= Spells =======================
  // "Cannot be used as Fusion Material" is not scripted.
  const dustons = (e: Engine, c: Card) => isMonster(e, c) && named(c, 'Duston');
  E['Magicalized Duston Mop'] = h.equip(undefined, {
    canActivate: (e, _c, p, t) => isMain(t) && allMonsters(e).some((m) => m.faceUp) && !e.anyActive('Magicalized Duston Mop', p),
    cannotBeTributed: () => true,
    *onLeaveField(e, fc) {
      noteLeave(e, fc);
    },
    *onDestroyed(e, card, controller, byBattle) {
      if (byBattle || !byOpponent(e, card, controller, false) || card.owner !== controller) return;
      if (!e.player(controller).deck.some((c) => dustons(e, c)) || !(yield* e.yesno(controller, 'Magicalized Duston Mop: add a "Duston" monster from your Deck to your hand?'))) return;
      yield* searchDeck(e, controller, 'Add which "Duston" monster?', (c) => dustons(e, c));
    },
  });

  const polys = (e: Engine, p: Pid) => [...e.player(p).deck, ...e.player(p).gy].filter((c) => c.name === 'Polymerization');
  const frp = (e: Engine) => (fx(e).frp ??= { turn: -1, pending: [] as number[], mats: [] as number[] }) as { turn: number; pending: number[]; mats: number[] };
  const frpNow = (e: Engine) => {
    const s = frp(e);
    if (s.turn !== e.state.turn) (s.turn = e.state.turn), (s.pending = []), (s.mats = []);
    return s;
  };
  E['Fusion Recycling Plant'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    ignition: {
      can: (e, _fc, p) => e.player(p).hand.length > 0 && polys(e, p).length > 0,
      *run(e, _fc, p) {
        if (!(yield* discardCost(e, p, 1))) return;
        const c = yield* pickOne(e, p, 'Fusion Recycling Plant: add which "Polymerization"?', polys(e, p));
        if (!c) return;
        const fromDeck = inZone(e, c.uid, 'deck');
        e.toHandOf(c.uid, p);
        if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
        e.log(p, `${e.player(p).name} adds Polymerization to the hand`);
      },
    },
    *onAnyToGrave(e, _fc, _p, events) {
      const s = frpNow(e);
      for (const v of events) if (v.reason === 'used' && v.toGy && (v.from === 'hand' || v.from === 'mz') && isMonster(e, v.card)) s.pending.push(v.card.uid);
    },
    *onAnySummon(e, _fc, _p, m, _mp, kind) {
      if (kind !== 'special' || !wasFusionSummoned(m) || info(e, m).sub !== 'Fusion') return;
      const s = frpNow(e);
      const recorded = ((fx(e).fusionMatList ?? {}) as Record<number, number[]>)[m.uid] ?? [];
      s.mats.push(...s.pending, ...recorded);
      s.pending = [];
    },
    *onEndPhase(e, fc, p) {
      if (e.spellsNegated() || !e.fieldCard(fc.uid) || !opt(e, 'Fusion Recycling Plant', p, 2)) return;
      const s = frpNow(e);
      const list = e.player(p).gy.filter((c) => s.mats.includes(c.uid));
      if (!list.length || !(yield* e.yesno(p, 'Fusion Recycling Plant: add a monster used as Fusion Material this turn to your hand?'))) return;
      const c = yield* pickOne(e, p, 'Fusion Recycling Plant: add which monster?', list);
      if (!c) return;
      useOpt(e, 'Fusion Recycling Plant', p, 2);
      e.toHandOf(c.uid, p);
      e.log(p, `${e.player(p).name} adds ${c.name} from the GY to the hand`);
    },
  };

  // Its first effect is read by the Archfiend scripts (no Standby Phase payment while it is face-up).
  E['Pandemonium'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    *onAnyToGrave(e, _fc, _p, events) {
      for (const v of events) {
        if (v.from !== 'mz' || v.reason !== 'destroyed' || v.byBattle || !v.toGy || v.token || !named(v.card, 'Archfiend') || !isMonster(e, v.card)) continue;
        const q = v.controller;
        const lv = info(e, v.card).level ?? 0;
        const test = (c: Card) => isMonster(e, c) && named(c, 'Archfiend') && (info(e, c).level ?? 0) < lv;
        if (!e.player(q).deck.some(test) || !(yield* e.yesno(q, `Pandemonium: add an "Archfiend" monster lower than Level ${lv} from your Deck?`))) continue;
        const prev = e.actor;
        e.actor = q;
        yield* searchDeck(e, q, `Pandemonium: add which "Archfiend" monster (lower than Level ${lv})?`, test);
        e.actor = prev;
      }
    },
  };

  // The banishing happens from the GY, right after the battle (the destroyed monster's printed ATK is compared).
  const bujins = (e: Engine) => targetable(e, faceUpMonsters(e)).filter((m) => named(m, 'Bujin'));
  E['Bujintervention'] = {
    canActivate: (e, _c, _p, t) => isMain(t) && bujins(e).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Bujintervention: target which "Bujin" monster?', bujins(e), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || !m.faceUp) return;
      fx(e).bujin = { uid: m.uid, turn: e.state.turn, p, atk: e.baseStats(m).atk };
      e.log(p, `Bujintervention: ${m.name} banishes what it destroys by battle this turn`);
    },
    quick: {
      from: 'gy',
      repeat: true,
      label: 'banish the destroyed monster and its copies',
      can: (e, _c, p, t, ctx) => {
        const b = fx(e).bujin as { uid: number; turn: number; p: Pid; atk: number } | undefined;
        const battle = e.state.battle;
        if (t !== 'destroyed' || !b || b.turn !== e.state.turn || b.p !== p || ctx.uid === undefined || !battle || !inZone(e, ctx.uid, 'gy')) return false;
        if (battle.attacker !== b.uid && battle.target !== b.uid) return false;
        if (ctx.uid === b.uid || ctx.prevController === p) return false;
        return Math.max(0, info(e, e.find(ctx.uid)!.card).atk ?? 0) >= b.atk;
      },
      *cost(_e, _c, _p, link, ctx) {
        link.targetUid = ctx.uid;
      },
      *run(e, _c, p, link) {
        const f = link.targetUid !== undefined ? e.find(link.targetUid) : null;
        if (!f || f.loc.zone !== 'gy') return;
        const name = f.card.name;
        e.banish(f.card.uid);
        const ps = e.player(other(p));
        for (const c of [...ps.hand, ...ps.deck, ...ps.fusion, ...ps.gy].filter((x) => x.name === name)) e.banish(c.uid);
        ps.deck = e.shuffle(ps.deck);
        e.log(p, `Bujintervention banishes every "${name}" of ${ps.name}`);
      },
    },
  };

  const ssTargets = (e: Engine) => targetable(e, faceUpMonsters(e)).filter((m) => !!m.tags?.ss);
  const smallNormals = (e: Engine, p: Pid) => e.player(p).hand.filter((c) => isNormalMonster(e, c) && (info(e, c).level ?? 0) <= 4);
  E['Faustian Bargain'] = {
    canActivate: (e, _c, _p, t) => isMain(t) && ssTargets(e).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Faustian Bargain: send which Special Summoned monster to the GY?', ssTargets(e), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid === undefined || !e.fieldCard(link.targetUid)) return;
      yield* e.sendToGrave(link.targetUid, 'used');
      if (e.fieldCard(link.targetUid)) return;
      yield* summonOneOf(e, p, 'Faustian Bargain: Special Summon which Level 4 or lower Normal Monster?', smallNormals(e, p));
    },
  };

  // Xyz Monsters are not part of Speed Duel, so there is never a target.
  const xyzOnField = (e: Engine) => targetable(e, faceUpMonsters(e)).filter((m) => info(e, m).sub === 'Xyz');
  E['Overlay Regen'] = {
    canActivate: (e, _c, _p, t) => isMain(t) && xyzOnField(e).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Overlay Regen: target which Xyz Monster?', xyzOnField(e), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid !== undefined && e.fieldCard(link.targetUid)) e.log(p, `Overlay Regen is attached to ${e.fieldCard(link.targetUid)!.name} as an Xyz Material`);
    },
  };

  // Your opponent's face-up Trap effects already on the field are not negated (only new activations are stopped).
  E['Triangle Ecstasy Spark'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve(e, _link, p) {
      for (const m of faceUpMonsters(e).filter((x) => x.name === 'Harpie Lady Sisters')) {
        m.atkMod += 2700 - e.atkOf(m);
        e.log(p, `${m.name}'s ATK becomes 2700 until the end of this turn`);
      }
      ((fx(e).noTrapTurn ??= [-1, -1]) as number[])[other(p)] = e.state.turn;
      e.log(p, `${e.player(other(p)).name} cannot activate Trap Cards this turn`);
    },
  };

  const fogOf = (m: FieldCard) => m.tags?.fog ?? 0;
  E['Diamond-Dust Cyclone'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && allMonsters(e).some((m) => fogOf(m) >= 4),
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Diamond-Dust Cyclone: select which monster with 4+ Fog Counters?', allMonsters(e).filter((x) => fogOf(x) >= 4), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m) return;
      const n = Math.floor(fogOf(m) / 4);
      yield* e.destroy([m.uid]);
      if (e.fieldCard(m.uid) || n <= 0) return;
      e.log(p, `Diamond-Dust Cyclone: draw ${n}`);
      e.draw(p, n);
    },
  };

  // ======================= Traps =======================
  // Speed Duel has no Pendulum Monsters, so no "Zefra" monster is ever face-up in an Extra Deck: none of its effects apply.
  const zefraCount = (_e: Engine, _p: Pid) => 0;
  const faceUpExtra = (_e: Engine) => 0;
  E['Chosen of Zefra'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    aura: (e, _src, m, sc) => (zefraCount(e, sc) >= 3 && ctrl(e, m) === sc ? { atk: 100 * faceUpExtra(e), def: 0 } : undefined),
    shields: (e, _src, m, how, sc) => ctrl(e, m) === sc && ((how === 'effect' && zefraCount(e, sc) >= 5 && e.actor === other(sc)) || (how === 'target' && zefraCount(e, sc) >= 8 && e.actor === other(sc))),
    ignition: {
      can: (e, _fc, p) => zefraCount(e, p) >= 10,
      *run(e, fc, p) {
        yield* e.sendToGrave(fc.uid, 'cost');
        const q = other(p);
        for (const c of [...e.player(q).hand, ...e.monsters(q), ...stOf(e, q), ...e.player(q).gy]) e.toDeckTop(c.uid);
        e.player(q).deck = e.shuffle(e.player(q).deck);
      },
    },
  };

  // Xyz Monsters are not part of Speed Duel, so it never has anything to negate.
  E['Heraldry Record'] = {
    canActivate: (e, _c, p, t, ctx) => (t === 'effect' || t === 'spell' || t === 'trap') && !!ctx.link && ctx.link.player === other(p) && info(e, ctx.link.card).sub === 'Xyz' && !!(ctx.link.payload as { detach?: boolean } | undefined)?.detach,
    *activate(_e, link, _p, ctx) {
      link.payload = { target: ctx.link };
    },
    *resolve(e, link, p) {
      const t = (link.payload as { target?: ChainLink }).target;
      if (!t) return;
      negateLink(e, t, p);
      if (e.fieldCard(t.card.uid)) yield* e.destroy([t.card.uid]);
    },
  };

  E['Blast Held by a Tribute'] = {
    canActivate: (e, _c, p, t, ctx) => {
      const a = opponentAttack(e, p, t, ctx);
      const m = a !== null ? e.fieldCard(a) : null;
      return !!m && tributeSummoned(e, m);
    },
    *resolve(e, _link, p) {
      const list = faceUpMonsters(e, other(p)).filter((m) => m.pos === 'atk');
      if (!list.length) return;
      yield* e.destroy(list.map((m) => m.uid));
      if (list.some((m) => !e.fieldCard(m.uid))) {
        e.log(p, 'Blast Held by a Tribute inflicts 1000 damage');
        e.damage(other(p), 1000);
      }
    },
  };

  // "Each time your opponent activates a card or effect" is offered as a response to each activation.
  function addScale(e: Engine, q: Pid) {
    const list = faceUpMonsters(e, q);
    for (const m of list) tag(m).scale = (m.tags?.scale ?? 0) + 1;
    if (list.length) e.log(null, `A Scale Counter is placed on each face-up monster of ${e.player(q).name}`);
  }
  const scalesHost = (e: Engine, fc: FieldCard, p: Pid) => {
    const host = fc.equippedTo !== undefined ? e.fieldCard(fc.equippedTo) : null;
    return host && e.controller(host.uid) === p ? host : null;
  };
  E['Corrosive Scales'] = equipTrap((e, m, p) => e.controller(m.uid) === p && raceOf(e, m) === 'Insect', {
    guardsFromAttack: (e, src, target) => {
      const p = ctrl(e, src);
      const host = scalesHost(e, src, p);
      return !!host && target.uid !== host.uid && target.faceUp && raceOf(e, target) === 'Insect';
    },
    *onAnySummon(e, fc, p, _m, mp, kind) {
      if (mp !== other(p) || kind === 'flip' || fc.equippedTo === undefined) return;
      addScale(e, other(p));
    },
    quick: {
      repeat: true,
      label: 'place Scale Counters',
      can: (e, c, p, t, ctx) => {
        const fc = e.fieldCard(c.uid);
        return !!fc && fc.equippedTo !== undefined && (t === 'spell' || t === 'trap' || t === 'effect') && !!ctx.link && ctx.link.player === other(p) && !ctx.link.negated;
      },
      *run(e, _c, p) {
        addScale(e, other(p));
      },
    },
    aura: (e, _src, m, sc) => (ctrl(e, m) === other(sc) && (m.tags?.scale ?? 0) > 0 ? { atk: -100 * m.tags!.scale, def: -100 * m.tags!.scale } : undefined),
  });

  E['Drop Off'] = {
    canActivate: (e, _c, p, t) => {
      const d = fx(e).normalDraw as { player: Pid; uid: number; turn: number } | undefined;
      if (t === 'main' || !d || d.turn !== e.state.turn || d.player !== other(p) || e.state.turnPlayer !== other(p)) return false;
      const f = e.find(d.uid);
      return !!f && f.loc.zone === 'hand' && f.loc.player === other(p) && ['DP', 'SP', 'M1'].includes(e.state.phase);
    },
    *resolve(e, _link, p) {
      const d = fx(e).normalDraw as { player: Pid; uid: number } | undefined;
      const f = d ? e.find(d.uid) : null;
      if (!d || !f || f.loc.zone !== 'hand') return;
      e.log(p, `Drop Off: ${e.player(d.player).name} discards ${f.card.name}`);
      yield* e.discard(d.player, d.uid);
    },
  };

  const imtList = (e: Engine) => (fx(e).imt ??= []) as { uid: number; p: Pid; pos: 'atk' | 'def'; src: number; turn: number }[];
  E['Interdimensional Matter Transporter'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && targetable(e, faceUpMonsters(e, p)).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Interdimensional Matter Transporter: banish which of your monsters until the End Phase?', targetable(e, faceUpMonsters(e, p)), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || !m.faceUp || e.controller(m.uid) !== p) return;
      imtList(e).push({ uid: m.uid, p, pos: m.pos, src: link.card.uid, turn: e.state.turn });
      e.banish(m.uid);
    },
    *onEndPhaseInGrave(e, card) {
      const mine = imtList(e).filter((x) => x.src === card.uid);
      if (!mine.length) return;
      fx(e).imt = imtList(e).filter((x) => x.src !== card.uid);
      for (const x of mine) {
        if (!inZone(e, x.uid, 'removed')) continue;
        if (!returnToField(e, x.uid, x.p, x.pos)) yield* e.sendToGrave(x.uid, 'used');
      }
    },
  };

  const yokaiSent = (e: Engine) => (fx(e).yokaiSent ??= {}) as Record<number, number>;
  E['Mischief of the Yokai'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && faceUpMonsters(e).length > 0,
    *resolve(e) {
      for (const m of faceUpMonsters(e)) shiftLevel(e, m, -2);
    },
    *onSentToGrave(e, card) {
      yokaiSent(e)[card.uid] = e.state.turn;
    },
    graveIgnition: {
      can: (e, c) => yokaiSent(e)[c.uid] !== e.state.turn && faceUpMonsters(e).length > 0,
      *run(e, c, p) {
        e.banish(c.uid);
        const m = yield* pickOne(e, p, 'Mischief of the Yokai: reduce the Level of which monster by 1?', faceUpMonsters(e));
        if (m) shiftLevel(e, m, -1);
      },
    },
  };

  E['Rainbow Life'] = {
    canActivate: (e, c, p, t) => anyTime(t) && e.player(p).hand.some((x) => x.uid !== c.uid),
    *activate(e, _link, p) {
      if (!(yield* discardCost(e, p, 1))) return false;
    },
    *resolve(e, _link, p) {
      ((fx(e).healDamage ??= [-1, -1]) as number[])[p] = e.state.turn;
      e.log(p, `Rainbow Life: ${e.player(p).name} gains LP instead of taking damage this turn`);
    },
  };

  // The DEF gain applies from the attack declaration to the end of that battle.
  E['Spikeshield with Chain'] = equipTrap(() => true, {
    equipBonus: (e, eq, host) => {
      const b = e.state.battle;
      let def = 0;
      if (b && host.pos === 'def' && (b.attacker === host.uid || b.target === host.uid) && !eq.tags?.busy) {
        tag(eq).busy = 1;
        try {
          def = e.atkOf(host);
        } finally {
          tag(eq).busy = 0;
        }
      }
      return { atk: 500, def };
    },
  });
}
