// Speed Duel card scripts, batch 23: cards from the 2024 products (Speed Duel GX: Midterm Destruction,
// Speed Duel Tournament Pack 7, Speed Duel: Battle City Finals) that were missing from the game.
//
// It also corrects 6 older Eternal Duelist Soul scripts (effects.ts) for Speed Duel. EDS scripts win on a name
// overlap (index.ts skips a batch entry whose name the EDS table already has), so these fixes cannot go in the batch
// table: patchEds() edits the EDS script objects themselves (found with getEffect, which already holds them when the
// batches are installed), and every patched hook keeps the old behaviour when the duel is not a Speed Duel.
import type { EffectDef } from '../effects';
import { getEffect } from '../effects';
import type { SpeedHelpers } from './helpers';
import { anyTime, attrOf, boostPerm, discardCost, faceUpMonsters, freeMZ, freeST, info, isExtraOrRitual, isMain, isMonster, isTrap, levelOf, opponentAttack, other, pick, pickOne, raceOf, searchDeck, summonOneOf, tag, targetable, yesno } from './helpers';
import type { Card, Engine, FieldCard, Pid, Step } from './helpers';

// ---------- local helpers ----------
const RA = 'The Winged Dragon of Ra';
const SPHERE = 'The Winged Dragon of Ra - Sphere Mode';
const RACES = ['Aqua', 'Beast', 'Beast-Warrior', 'Cyberse', 'Dinosaur', 'Divine-Beast', 'Dragon', 'Fairy', 'Fiend', 'Fish', 'Insect', 'Machine', 'Plant', 'Psychic', 'Pyro', 'Reptile', 'Rock', 'Sea Serpent', 'Spellcaster', 'Thunder', 'Warrior', 'Winged Beast', 'Wyrm', 'Zombie'];
const zoneOf = (e: Engine, uid: number) => e.find(uid)?.loc.zone;
/** "Once per turn" for an effect of a card name (n = which effect). */
const opt = (e: Engine, name: string, p: Pid, n = 1) => e.oncePerTurn(`${name}:b23:${n}`, p);
const useOpt = (e: Engine, name: string, p: Pid, n = 1) => e.useOnce(`${name}:b23:${n}`, p);
/** A printed ATK/DEF of N or less: "?" (stored as -1) does not count. */
const statAtMost = (e: Engine, c: Card, stat: 'atk' | 'def', n: number) => {
  const v = info(e, c)[stat];
  return typeof v === 'number' && v >= 0 && v <= n;
};
/** A Trap Card on the field as a monster (Tiki Curse, Tiki Soul, Metal Reflect Slime...). */
const isTrapMonster = (e: Engine, m: Card) => zoneOf(e, m.uid) === 'mz' && isTrap(e, m);
/** Spirit monsters by their text (the card database keeps no Spirit flag): "Normal Summoned or flipped face-up ... return it to the hand". */
const isSpirit = (e: Engine, c: Card) => /Normal Summoned or flipped face-up/.test(info(e, c).desc) && /hand/.test(info(e, c).desc);
/** Special Summons a card ignoring its Summoning conditions (engine fx.ignoreCond). */
function* ignoringConditions(e: Engine, uid: number, step: Step): Step {
  const prev = e.state.fx.ignoreCond;
  e.state.fx.ignoreCond = uid;
  try {
    yield* step;
  } finally {
    e.state.fx.ignoreCond = prev;
  }
}
/** Monsters in the same column as `m` on both sides, except m (the opponent's zones face yours mirrored). */
function columnOf(e: Engine, m: FieldCard): FieldCard[] {
  const f = e.find(m.uid);
  if (!f || f.loc.zone !== 'mz') return [];
  const opp = e.player(other(f.loc.player)).mz;
  return [e.player(f.loc.player).mz[f.loc.index], opp[opp.length - 1 - f.loc.index]].filter((x): x is FieldCard => !!x && x.uid !== m.uid);
}
/** Changes a face-up monster to face-down Defense Position (its equips go, its changes reset). */
function* setFaceDown(e: Engine, m: FieldCard): Step {
  for (const u of m.equips.slice()) if (e.fieldCard(u)) yield* e.sendToGrave(u, 'destroyed');
  m.faceUp = false;
  m.pos = 'def';
  m.atkMod = 0;
  m.defMod = 0;
  m.tags = m.tags?.ssAt !== undefined ? { ssAt: m.tags.ssAt } : {};
  e.event('position', { uid: m.uid, player: e.controller(m.uid) ?? m.owner });
  e.log(null, `${m.name} is changed to face-down Defense Position`);
}
/** Special Summons a Continuous Trap as a monster with this Level/Type/Attribute (ATK/DEF from its baseStats). */
function* trapMonster(e: Engine, card: Card, p: Pid, level: number, race: string, attribute: string): Step {
  if (!e.fieldCard(card.uid) || !freeMZ(e, p)) return;
  (e.state.fx.declLevel ??= {})[card.uid] = level;
  (e.state.fx.declRace ??= {})[card.uid] = race;
  (e.state.fx.declAttr ??= {})[card.uid] = attribute;
  const atk = yield* e.yesno(p, `Special Summon ${card.name} in Attack Position? (No = Defense)`);
  yield* e.specialSummon(card.uid, p, atk ? 'atk' : 'def');
}
const tikiTrap = (level: number, race: string, attribute: string, atk: number, def: number): Pick<EffectDef, 'canActivate' | 'resolve' | 'baseStats'> => ({
  canActivate: (e, _c, p, t) => anyTime(t) && freeMZ(e, p),
  *resolve(e, link, p) {
    yield* trapMonster(e, link.card, p, level, race, attribute);
  },
  baseStats: (e, m) => (zoneOf(e, m.uid) === 'mz' ? { atk, def } : undefined),
});

// ---------- corrections to the EDS scripts (see the header) ----------
/** Flying Kamakiri #1 / Shining Angel: "Special Summon 1 <Attribute> monster with 1500 or less ATK from your Deck" ("?" ATK does not qualify). */
function* recruit(e: Engine, m: FieldCard, p: Pid, attr: string): Step {
  if (!freeMZ(e, p) || zoneOf(e, m.uid) !== 'gy') return;
  const list = e.player(p).deck.filter((c) => isMonster(e, c) && attrOf(e, c) === attr && statAtMost(e, c, 'atk', 1500) && !isExtraOrRitual(e, c) && !e.summonBlocked(p, c, 'special', 'deck'));
  if (!list.length) return;
  yield* summonOneOf(e, p, `${m.name}: Special Summon which ${attr} monster from your Deck?`, list, 'atk', true);
}
/** Sangan / Witch of the Black Forest: once per turn; "?" stats do not qualify; no activating cards of the added name this turn. */
function* searchLock(e: Engine, card: Card, stat: 'atk' | 'def'): Step {
  const p = card.owner;
  const test = (c: Card) => isMonster(e, c) && statAtMost(e, c, stat, 1500);
  if (!opt(e, card.name, p) || !e.player(p).deck.some(test)) return;
  useOpt(e, card.name, p);
  const c = yield* searchDeck(e, p, `${card.name}: add a monster with 1500 or less ${stat.toUpperCase()} to your hand`, test);
  if (!c) return;
  ((e.state.fx.turnNameLocks ??= []) as { p: Pid; name: string; turn: number }[]).push({ p, name: c.name, turn: e.state.turn });
  e.log(p, `${e.player(p).name} cannot activate cards, or the effects of cards, named ${c.name} for the rest of this turn`);
}
function patchEds() {
  for (const [name, attr] of [['Flying Kamakiri #1', 'WIND'], ['Shining Angel', 'LIGHT']] as const) {
    const d = getEffect(name);
    const old = d?.onDestroyedByBattle;
    if (!d || !old) continue;
    d.onDestroyedByBattle = function* (e, m, p) {
      if (!e.speed) return yield* old(e, m, p);
      yield* recruit(e, m, p, attr);
    };
  }
  for (const [name, stat] of [['Sangan', 'atk'], ['Witch of the Black Forest', 'def']] as const) {
    const d = getEffect(name);
    const old = d?.onToGraveFromField;
    if (!d || !old) continue;
    d.onToGraveFromField = function* (e, card, p) {
      if (!e.speed) return yield* old(e, card, p);
      if (zoneOf(e, card.uid) === 'gy') yield* searchLock(e, card, stat);
    };
  }
  // Swords of Revealing Light: "you must destroy it during the End Phase of your opponent's 3rd turn" (EDS: sent to the GY).
  const sw = getEffect('Swords of Revealing Light');
  const oldEnd = sw?.onEndPhase;
  if (sw && oldEnd)
    sw.onEndPhase = function* (e, fc, controller) {
      if (!e.speed) return yield* oldEnd(e, fc, controller);
      if (e.state.turnPlayer === controller) return;
      fc.turns = (fc.turns ?? 3) - 1;
      if (fc.turns > 0) return;
      e.log(controller, 'Swords of Revealing Light is destroyed (the 3rd turn is over)');
      yield* e.destroy([fc.uid]);
    };
}

export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  patchEds();

  // ---------- Swarm of Centipedes ----------
  E['Swarm of Centipedes'] = {
    // "If this card is flipped face-up: You can target 1 other monster on the field; change it to face-up Attack Position or face-down Defense Position."
    *flip(e, m, p) {
      const list = targetable(e, [...e.monsters(0), ...e.monsters(1)].filter((x) => x.uid !== m.uid));
      if (!list.length || !opt(e, m.name, p) || !(yield* yesno(e, p, 'Swarm of Centipedes: change the position of another monster?'))) return;
      const t = yield* pickOne(e, p, 'Swarm of Centipedes: target which monster?', list, true);
      if (!t) return;
      useOpt(e, m.name, p);
      const canUp = !t.faceUp || t.pos !== 'atk';
      const canDown = t.faceUp && !t.token;
      if (!e.fieldCard(t.uid) || (!canUp && !canDown)) return;
      let up = canUp;
      if (canUp && canDown) up = (yield* e.select(p, `Swarm of Centipedes: ${t.name}`, [{ label: 'Face-up Attack Position' }, { label: 'Face-down Defense Position' }], 1, 1))?.[0] !== 1;
      if (!up) return yield* setFaceDown(e, t);
      const wasDown = !t.faceUp;
      t.faceUp = true;
      t.pos = 'atk';
      e.event('position', { uid: t.uid, player: e.controller(t.uid) ?? t.owner });
      e.log(p, `${t.name} is changed to face-up Attack Position`);
      if (wasDown) yield* e.flipEffect(t.uid, e.controller(t.uid) ?? t.owner);
    },
    // "Once per turn, during your Main Phase: You can change this card to face-down Defense Position."
    ignition: {
      can: (e, m) => m.faceUp && !m.token,
      *run(e, m) {
        const me = e.fieldCard(m.uid);
        if (me?.faceUp) yield* setFaceDown(e, me);
      },
    },
  };

  // ---------- Sword of Kusanagi ----------
  E['Sword of Kusanagi'] = h.equipFor((e, m) => isSpirit(e, m), () => ({ atk: 0, def: 0 }), {
    // "When it attacks a Defense Position monster whose DEF is lower than the ATK of the equipped monster, inflict the difference as Battle Damage."
    grantsPiercing: (_e, card, _p, attacker) => card.equippedTo === attacker.uid,
    // "When the equipped monster you control is returned to the hand and this card is sent to the GY, return this card to your hand."
    *onLeaveField(e, fc, controller) {
      const host = fc.equippedTo;
      if (host === undefined || zoneOf(e, host) !== 'hand' || e.find(host)?.loc.player !== controller) return;
      if (zoneOf(e, fc.uid) !== 'gy') return;
      e.toHandOf(fc.uid, controller);
      e.log(controller, 'Sword of Kusanagi returns to the hand');
    },
  });

  // ---------- The Winged Dragon of Ra - Sphere Mode ----------
  // "Requires 3 Tributes from either side of the field to Normal Summon to that side of the field": the usual Normal Summon
  // (3 Tributes, tributeCount) puts it on your side; its hand effect Tributes 3 of the opponent's monsters to Normal Summon it to
  // their side (engine tributeSummonWith with `side`), and control returns to its owner in the End Phase of the next turn.
  const oppFodder = (e: Engine, p: Pid) => e.monsters(other(p)).filter((m) => !e.untributable(m));
  E[SPHERE] = {
    cannotSpecialSummon: true,
    tributeCount: () => 3,
    cannotNormalSet: true,
    cannotAttack: () => true,
    cannotBeAttacked: () => true,
    cannotBeTargeted: (e, m, by) => by !== null && by !== e.controller(m.uid),
    handIgnition: {
      can: (e, c, p) => e.speed && e.inMainPhase() && e.state.turnPlayer === p && !e.player(p).normalSummoned && !e.summonBlocked(p, c, 'normal', 'hand') && oppFodder(e, p).length >= 3,
      *run(e, c, p) {
        const three = yield* pick(e, p, "Sphere Mode: Tribute which 3 of your opponent's monsters?", oppFodder(e, p), 3, 3, true, false);
        if (!three || three.length < 3) return;
        const ok = yield* e.tributeSummonWith(p, c.uid, three.map((m) => m.uid), 'atk', other(p));
        const m = e.fieldCard(c.uid);
        if (ok && m && e.controller(m.uid) !== m.owner) tag(m).sphereBack = e.state.turn + 1;
      },
    },
    *onEndPhase(e, m, p) {
      if (m.tags?.sphereBack !== e.state.turn || p === m.owner) return;
      m.tags.sphereBack = -1;
      if (e.takeControl(m.uid, m.owner)) e.log(m.owner, `${m.name}: control shifts back to ${e.player(m.owner).name}`);
    },
    // "You can Tribute this card; Special Summon 1 "The Winged Dragon of Ra" from your hand or Deck, ignoring its Summoning conditions, and if you do, its ATK/DEF become 4000."
    ignition: {
      chain: false, // its Tribute is the cost (a chained ignition whose card left the field would not resolve)
      repeat: true,
      can: (e, m, p) => !e.untributable(m) && [...e.player(p).hand, ...e.player(p).deck].some((c) => e.isNamed(c, RA)),
      *cost(e, m, p) {
        e.log(p, `${e.player(p).name} Tributes ${m.name}`);
        yield* e.sendToGrave(m.uid, 'tribute');
      },
      *run(e, _m, p) {
        const list = [...e.player(p).hand, ...e.player(p).deck].filter((c) => e.isNamed(c, RA));
        if (!freeMZ(e, p) || !list.length) return;
        const c = yield* pickOne(e, p, 'Special Summon which "The Winged Dragon of Ra"?', list);
        if (!c) return;
        const fromDeck = zoneOf(e, c.uid) === 'deck';
        yield* ignoringConditions(e, c.uid, e.specialSummon(c.uid, p, 'atk'));
        if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
        const ra = e.fieldCard(c.uid);
        if (!ra) return;
        // Its original ATK/DEF are 0 in Speed Duel ("?"), so "become 4000" = 4000 on top of them.
        Object.assign(tag(ra), { permAtk: 4000 - e.baseStats(ra).atk, permDef: 4000 - e.baseStats(ra).def });
        e.log(p, `${ra.name}'s ATK/DEF become 4000`);
      },
    },
  };

  // ---------- The Winged Dragon of Ra - Immortal Phoenix ----------
  // "Unaffected by other cards' effects" is modelled as: other cards' effects cannot target it or destroy it (stat changes from
  // other cards, and effects that move it without destroying it, still apply).
  const notOwnEffect = (e: Engine, m: FieldCard) => e.resolvingCard()?.uid !== m.uid;
  E['The Winged Dragon of Ra - Immortal Phoenix'] = {
    cannotNormalSummon: true,
    summonRule: (e, c, _p, how) => how !== 'special' || e.state.fx.procSS === c.uid,
    effectProof: notOwnEffect,
    cannotBeTargeted: (e, m) => notOwnEffect(e, m),
    // "If "The Winged Dragon of Ra" is sent from the field to your GY while this card is in your GY: Special Summon this card."
    *watchGrave(e, card, owner, zone, events) {
      if (zone !== 'gy' || !freeMZ(e, owner)) return;
      if (!events.some((ev) => ev.toGy && ev.from === 'mz' && ev.card.owner === owner && !ev.token && e.isNamed(ev.card, RA) && zoneOf(e, ev.card.uid) === 'gy')) return;
      const prev = e.state.fx.procSS;
      e.state.fx.procSS = card.uid;
      try {
        e.log(owner, 'The Winged Dragon of Ra - Immortal Phoenix rises from the Graveyard');
        yield* e.specialSummon(card.uid, owner, 'atk');
      } finally {
        e.state.fx.procSS = prev;
      }
    },
    // "You can pay 1000 LP; send 1 monster on the field to the GY."
    ignition: {
      repeat: true,
      can: (e, _m, p) => e.player(p).lp > 1000 && [...e.monsters(0), ...e.monsters(1)].length > 0,
      *cost(e, _m, p) {
        e.payLp(p, 1000);
      },
      *run(e, _m, p) {
        const t = yield* pickOne(e, p, 'Immortal Phoenix: send which monster to the GY?', [...e.monsters(0), ...e.monsters(1)]);
        if (t && e.fieldCard(t.uid)) yield* e.sendToGrave(t.uid, 'used');
      },
    },
    // "Once per turn, during the End Phase: Send this card to the GY, and if you do, Special Summon 1 Sphere Mode from your hand, Deck, or GY, ignoring its Summoning conditions."
    *onEndPhase(e, m, p) {
      if (!opt(e, `${m.name}:${m.uid}`, p)) return;
      useOpt(e, `${m.name}:${m.uid}`, p);
      e.log(p, `${m.name} is sent to the Graveyard`);
      yield* e.sendToGrave(m.uid, 'used');
      if (zoneOf(e, m.uid) !== 'gy') return;
      const ps = e.player(p);
      const list = [...ps.hand, ...ps.deck, ...ps.gy].filter((c) => e.isNamed(c, SPHERE));
      if (!list.length || !freeMZ(e, p)) return;
      const c = yield* pickOne(e, p, 'Special Summon which Sphere Mode?', list);
      if (!c) return;
      const fromDeck = zoneOf(e, c.uid) === 'deck';
      yield* ignoringConditions(e, c.uid, e.specialSummon(c.uid, p, 'atk'));
      if (fromDeck) ps.deck = e.shuffle(ps.deck);
    },
  };

  // ---------- Thunder Ball ----------
  const TB = 'Thunder Ball';
  const tbTraps = (e: Engine, p: Pid) => [...e.player(p).hand.filter((c) => isTrap(e, c)), ...e.spells(p).filter((c) => !c.faceUp && isTrap(e, c))];
  E[TB] = {
    // "At the end of the Damage Step, if a monster battled: You can Special Summon this card from your hand." (monster-vs-monster battles)
    *battleEndInHand(e, card, p) {
      if (!opt(e, TB, p, 1) || !freeMZ(e, p) || e.summonBlocked(p, card, 'special', 'hand')) return;
      if (!(yield* yesno(e, p, 'Thunder Ball: Special Summon it from your hand?'))) return;
      useOpt(e, TB, p, 1);
      const atk = yield* yesno(e, p, 'Thunder Ball: Special Summon it in Attack Position? (No = Defense)');
      yield* e.specialSummon(card.uid, p, atk ? 'atk' : 'def');
    },
    // "You can send 1 Trap from your hand or that's Set on your field to the GY; destroy all other monsters in this card's column."
    ignition: {
      repeat: true,
      can: (e, m, p) => opt(e, TB, p, 2) && tbTraps(e, p).length > 0 && columnOf(e, m).length > 0,
      *cost(e, _m, p) {
        const t = yield* pickOne(e, p, 'Thunder Ball: send which Trap to the GY?', tbTraps(e, p), true);
        if (!t) return false;
        useOpt(e, TB, p, 2);
        yield* e.sendToGrave(t.uid, 'cost');
      },
      *run(e, m) {
        const list = columnOf(e, m);
        if (list.length) yield* e.destroy(list.map((x) => x.uid));
      },
    },
    // "If this card in the Monster Zone is destroyed by battle or card effect and sent to the GY: You can target 1 card in your GY; roll a die, and if the result is 6, add that target to your hand."
    *onDestroyed(e, card, _c, _byBattle) {
      const p = card.owner;
      if (!opt(e, TB, p, 3) || !e.player(p).gy.length || !(yield* yesno(e, p, 'Thunder Ball: target a card in your GY and roll a die?'))) return;
      const t = yield* pickOne(e, p, 'Thunder Ball: target which card in your GY?', e.player(p).gy.slice(), true);
      if (!t) return;
      useOpt(e, TB, p, 3);
      const r = e.roll(6);
      e.log(p, `Thunder Ball: the die shows ${r}`);
      if (r === 6 && zoneOf(e, t.uid) === 'gy') {
        e.toHandOf(t.uid, p);
        e.log(p, `${e.player(p).name} adds ${t.name} to the hand`);
      }
    },
  };

  // ---------- Thunderspeed Summon ----------
  const KNIGHTS = ["Queen's Knight", "King's Knight", "Jack's Knight"];
  const knights = (e: Engine, p: Pid) => KNIGHTS.every((n) => e.monsters(p).some((m) => m.faceUp && e.isNamed(m, n)));
  const lv10 = (e: Engine, p: Pid) => e.player(p).hand.filter((c) => isMonster(e, c) && levelOf(e, c) === 10 && e.canNormalSummon(p, c, true, true));
  const tsSearch = (e: Engine, c: Card) => isMonster(e, c) && levelOf(e, c) === 10 && attrOf(e, c) !== 'DARK' && info(e, c).atk === -1;
  const tsPhase = (e: Engine) => e.inMainPhase() || e.state.phase === 'BP';
  /** "Immediately after this effect resolves, Normal Summon 1 Level 10 monster" (an extra Normal Summon, outside the usual timing). */
  function* summon10(e: Engine, p: Pid, optional: boolean): Step {
    const list = lv10(e, p);
    if (!list.length) return;
    if (optional && !(yield* yesno(e, p, 'Thunderspeed Summon: Normal Summon a Level 10 monster?'))) return;
    const c = yield* pickOne(e, p, 'Thunderspeed Summon: Normal Summon which Level 10 monster?', list, optional);
    if (c) yield* e.extraNormalSummon(p, c.uid, 'atk', true);
  }
  E['Thunderspeed Summon'] = {
    canActivate: (e, _c, p, t) => (isMain(t) || anyTime(t)) && tsPhase(e) && e.oncePerTurn('Thunderspeed Summon', p) && (lv10(e, p).length > 0 || (knights(e, p) && e.player(p).deck.some((c) => tsSearch(e, c)))),
    *activate(e, link, p) {
      e.useOnce('Thunderspeed Summon', p);
      link.payload = { search: false };
      if (knights(e, p) && e.player(p).deck.some((c) => tsSearch(e, c))) {
        const k = lv10(e, p).length ? yield* e.select(p, 'Thunderspeed Summon: which effect?', [{ label: 'Normal Summon 1 Level 10 monster' }, { label: 'Add 1 Level 10 non-DARK monster with ? ATK, then you can Normal Summon' }], 1, 1) : [1];
        link.payload = { search: k?.[0] === 1 };
      }
    },
    *resolve(e, link, p) {
      if ((link.payload as { search?: boolean } | undefined)?.search) {
        yield* searchDeck(e, p, 'Thunderspeed Summon: add which Level 10 non-DARK monster with ? ATK?', (c) => tsSearch(e, c));
        yield* summon10(e, p, true);
      } else yield* summon10(e, p, false);
    },
  };

  // ---------- Tiki Curse / Tiki Soul ----------
  E['Tiki Curse'] = {
    ...tikiTrap(4, 'Rock', 'DARK', 1800, 1000),
    // "While this card is an Effect Monster, if another Trap Card that is a monster battles an opponent's monster, after damage calculation: Destroy that opponent's monster."
    *anyAfterDamageCalc(e, src, p, attacker, target) {
      if (zoneOf(e, src.uid) !== 'mz') return;
      const mine = [attacker, target].find((x) => x.uid !== src.uid && e.controller(x.uid) === p && isTrapMonster(e, x));
      const foe = mine && (mine === attacker ? target : attacker);
      if (!foe || e.controller(foe.uid) !== other(p) || !e.fieldCard(foe.uid)) return;
      e.log(p, `Tiki Curse destroys ${foe.name}`);
      yield* e.destroy([foe.uid]);
    },
  };
  E['Tiki Soul'] = {
    ...tikiTrap(4, 'Rock', 'LIGHT', 1000, 1800),
    // "While this card is an Effect Monster, if another Trap Card you control that is a monster would be destroyed by your opponent's card
    // (by battle or by card effect) and sent to your GY, you can Set it in the Spell & Trap Zone instead."
    *allyDestroyReplace(e, src, p, m, _byBattle, by) {
      if (zoneOf(e, src.uid) !== 'mz' || by !== other(p) || m.owner !== p || !isTrapMonster(e, m) || freeST(e, p) < 0) return false;
      if (!(yield* yesno(e, p, `Tiki Soul: Set ${m.name} in your Spell & Trap Zone instead of it being destroyed?`))) return false;
      for (const u of m.equips.slice()) if (e.fieldCard(u)) yield* e.sendToGrave(u, 'used');
      const f = e.find(m.uid);
      if (!f || f.loc.zone !== 'mz') return false;
      e.vacateMZ(e.player(f.loc.player), f.loc.index);
      e.player(p).sz[freeST(e, p)] = { uid: m.uid, name: m.name, owner: m.owner, pos: 'atk', faceUp: false, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
      e.event('set', { uid: m.uid, player: p });
      e.log(p, `Tiki Soul: ${m.name} is Set in the Spell & Trap Zone instead`);
      return true;
    },
  };

  // ---------- Trade-In ----------
  const lv8 = (e: Engine, c: Card) => isMonster(e, c) && levelOf(e, c) === 8;
  E['Trade-In'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).deck.length >= 2,
    activateCost: {
      can: (e, c, p) => e.player(p).hand.some((x) => x.uid !== c.uid && lv8(e, x)),
      *pay(e, c, p) {
        return yield* discardCost(e, p, 1, (x) => lv8(e, x), c.uid);
      },
    },
    *resolve(e, _link, p) {
      e.draw(p, 2);
    },
  };

  // ---------- Trap Hole of Spikes ----------
  /** The attacking monster of the opponent, if it was Normal or Special Summoned this turn. */
  const freshAttacker = (e: Engine, p: Pid, t: Parameters<NonNullable<EffectDef['canActivate']>>[3], ctx: Parameters<NonNullable<EffectDef['canActivate']>>[4]) => {
    const uid = opponentAttack(e, p, t, ctx);
    const m = uid !== null ? e.fieldCard(uid) : null;
    return m && m.faceUp && m.placedTurn === e.state.turn ? m : null;
  };
  E['Trap Hole of Spikes'] = {
    canActivate: (e, _c, p, t, ctx) => !!freshAttacker(e, p, t, ctx),
    *activate(e, link, p, ctx) {
      const m = freshAttacker(e, p, 'attack', ctx);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m) return;
      const half = Math.floor(Math.max(0, info(e, m).atk ?? 0) / 2);
      yield* e.destroy([m.uid]);
      if (e.fieldCard(m.uid)) return;
      e.log(p, `Trap Hole of Spikes inflicts ${half} damage`);
      e.damage(other(p), half);
    },
  };

  // ---------- Tribe-Infecting Virus ----------
  E['Tribe-Infecting Virus'] = {
    ignition: {
      repeat: true,
      can: (e, _m, p) => e.player(p).hand.length > 0,
      // "Discard 1 card from your hand and declare 1 Type of monster." (both are paid/made when the effect is activated)
      *cost(e, m, p) {
        if (!(yield* discardCost(e, p, 1))) return false;
        const onField = [...new Set(faceUpMonsters(e).map((x) => raceOf(e, x)))].filter((r) => r);
        const types = [...onField, ...RACES.filter((r) => !onField.includes(r))];
        const k = yield* e.select(p, 'Tribe-Infecting Virus: declare a Type', types.map((r) => ({ label: r })), 1, 1);
        const race = types[k?.[0] ?? 0];
        ((e.state.fx.virusType ??= {}) as Record<number, string>)[m.uid] = race;
        e.log(p, `${e.player(p).name} declares ${race}`);
      },
      // "Destroy all face-up monsters of the declared Type on the field."
      *run(e, m) {
        const r = ((e.state.fx.virusType ?? {}) as Record<number, string>)[m.uid];
        const list = faceUpMonsters(e).filter((x) => raceOf(e, x) === r);
        if (list.length) yield* e.destroy(list.map((x) => x.uid));
      },
    },
  };

  // ---------- Valkyrian Knight ----------
  const warrior = (e: Engine, c: Card) => isMonster(e, c) && raceOf(e, c) === 'Warrior';
  E['Valkyrian Knight'] = {
    // "Monsters your opponent controls cannot target face-up Warrior-Type monsters for attacks, except "Valkyrian Knight"."
    guardsAttack: (e, _src, target) => target.faceUp && raceOf(e, target) === 'Warrior' && !e.isNamed(target, 'Valkyrian Knight'),
    // "When this card is destroyed by battle and sent to the GY: You can banish 1 Warrior-Type monster and this card from your GY,
    // then target 1 Level 5 or higher Warrior-Type monster in your GY; Special Summon that target."
    *onDestroyedByBattle(e, m, p) {
      const me = m.uid;
      if (zoneOf(e, me) !== 'gy' || !freeMZ(e, p)) return;
      const gy = () => e.player(p).gy.filter((c) => c.uid !== me);
      const targets = () => gy().filter((c) => warrior(e, c) && levelOf(e, c) >= 5 && !isExtraOrRitual(e, c) && !e.summonBlocked(p, c, 'special', 'gy'));
      const fodder = (except?: number) => gy().filter((c) => warrior(e, c) && c.uid !== except);
      if (!targets().some((t) => fodder(t.uid).length > 0) || !(yield* yesno(e, p, 'Valkyrian Knight: banish it and 1 Warrior to Special Summon a Level 5+ Warrior from your GY?'))) return;
      const cost = yield* pickOne(e, p, 'Valkyrian Knight: banish which Warrior from your GY?', fodder().filter((c) => targets().some((t) => t.uid !== c.uid)), true);
      if (!cost) return;
      e.banish(cost.uid);
      e.banish(me);
      const t = yield* pickOne(e, p, 'Valkyrian Knight: Special Summon which Level 5 or higher Warrior?', targets());
      if (t) yield* e.specialSummon(t.uid, p, 'atk');
    },
  };

  // ---------- Winged Minion ----------
  E['Winged Minion'] = {
    // "Tribute this face-up card. Select 1 face-up Fiend-Type monster on the field. Increase its ATK and DEF by 700 as long as it remains face-up on the field."
    ignition: {
      chain: false, // its Tribute is the cost
      can: (e, m) => m.faceUp && !e.untributable(m) && faceUpMonsters(e).some((x) => x.uid !== m.uid && raceOf(e, x) === 'Fiend'),
      *cost(e, m, p) {
        e.log(p, `${e.player(p).name} Tributes ${m.name}`);
        yield* e.sendToGrave(m.uid, 'tribute');
      },
      *run(e, _m, p) {
        const t = yield* pickOne(e, p, 'Winged Minion: which Fiend gains 700 ATK/DEF?', faceUpMonsters(e).filter((x) => raceOf(e, x) === 'Fiend'));
        if (!t) return;
        boostPerm(t, 700, 700);
        e.log(p, `${t.name} gains 700 ATK/DEF`);
      },
    },
  };
}
