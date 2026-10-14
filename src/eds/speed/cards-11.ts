// Speed Duel card scripts, batch 11: Continuous Spells and Traps (Ancient Gear Castle ... Talisman of Spell Sealing).
// Most of them watch the duel through the Speed Duel hooks for active Spells/Traps in effects.ts
// (onAnyToGrave, forbidsSummon, banishInstead, grantsPiercing, stateCheck...).
import type { EffectDef, GraveEvent } from '../effects';
import type { SpeedHelpers } from './helpers';
import {
  allMonsters,
  allST,
  anyTime,
  attrOf,
  chooseOption,
  faceUpMonsters,
  freeMZ,
  info,
  isExtraOrRitual,
  isMain,
  isMonster,
  isNormalMonster,
  label,
  levelOf,
  named,
  negateLink,
  other,
  pick,
  pickOne,
  raceOf,
  searchDeck,
  stOf,
  summonOneOf,
  tag,
  targetable,
} from './helpers';
import type { Card, ChainCtx, ChainLink, Engine, FieldCard, Pid, Step } from './helpers';

// ---------- local helpers ----------
const LORDS = ['Uria, Lord of Searing Flames', 'Hamon, Lord of Striking Thunder', 'Raviel, Lord of Phantasms'];
const isEffectLink = (link: ChainLink | undefined) => !!(link?.payload as { effect?: string } | undefined)?.effect;
/** A face-up monster of the field that was destroyed (by battle or by a card effect). */
const destroyedMonster = (v: GraveEvent) => v.from === 'mz' && v.reason === 'destroyed';
const continuousSpell = (): Pick<EffectDef, 'canActivate' | 'resolve'> => ({ canActivate: (_e, _c, _p, t) => isMain(t), *resolve() {} });
const continuousTrap = (): Pick<EffectDef, 'canActivate' | 'resolve'> => ({ canActivate: (_e, _c, _p, t) => anyTime(t), *resolve() {} });
const meisei = (e: Engine, p: Pid) => e.monsters(p).some((m) => m.faceUp && e.isNamed(m, 'Sealmaster Meisei'));
function* destroySelf(e: Engine, fc: FieldCard, why: string): Step {
  if (!e.fieldCard(fc.uid)) return;
  e.log(e.controller(fc.uid), `${fc.name} is destroyed (${why})`);
  yield* e.destroy([fc.uid]);
}
/** A once-per-turn effect of this copy of a card. */
const opt = (e: Engine, fc: Card, p: Pid, n = 1) => e.oncePerTurn(`${fc.name}:${fc.uid}:${n}`, p);
const useOpt = (e: Engine, fc: Card, p: Pid, n = 1) => e.useOnce(`${fc.name}:${fc.uid}:${n}`, p);

/**
 * Special Summons a Continuous Trap as a monster with the given Level/Type/Attribute (its ATK/DEF come from
 * the card's own baseStats). The Level, Type and Attribute apply while it is in a Monster Zone.
 */
function* trapMonster(e: Engine, card: Card, p: Pid, level: number, race: string, attribute: string): Step {
  if (!e.fieldCard(card.uid) || !freeMZ(e, p)) return;
  (e.state.fx.declLevel ??= {})[card.uid] = level;
  (e.state.fx.declRace ??= {})[card.uid] = race;
  (e.state.fx.declAttr ??= {})[card.uid] = attribute;
  const atk = yield* e.yesno(p, `Special Summon ${card.name} in Attack Position? (No = Defense)`);
  yield* e.specialSummon(card.uid, p, atk ? 'atk' : 'def');
}

const RACES = ['Aqua', 'Beast', 'Beast-Warrior', 'Dinosaur', 'Dragon', 'Fairy', 'Fiend', 'Fish', 'Insect', 'Machine', 'Plant', 'Psychic', 'Pyro', 'Reptile', 'Rock', 'Sea Serpent', 'Spellcaster', 'Thunder', 'Warrior', 'Winged Beast', 'Wyrm', 'Zombie'];
const ATTRIBUTES = ['DARK', 'EARTH', 'FIRE', 'LIGHT', 'WATER', 'WIND'];

/** The LP an Archfiend pays during its controller's Standby Phase, read from its text. */
const standbyCost = (e: Engine, m: Card) => Number(info(e, m).desc.match(/(?:pays?|must pay) (\d+) Life Points/)?.[1] ?? 0);

export function install(E: Record<string, EffectDef>, _h: SpeedHelpers) {
  // ---------- Continuous Spells ----------
  E['Ancient Gear Castle'] = {
    ...continuousSpell(),
    aura: (e, _src, m) => (m.faceUp && named(e, m, 'Ancient Gear') ? { atk: 300, def: 0 } : undefined),
    *onAnySummon(e, fc, p, _m, _mp, kind) {
      if (kind !== 'normal') return;
      fc.counters++;
      e.log(p, `A counter is placed on Ancient Gear Castle (${fc.counters})`);
    },
    *onAnySet(e, fc, p) {
      fc.counters++;
      e.log(p, `A counter is placed on Ancient Gear Castle (${fc.counters})`);
    },
    tributeFor: (e, fc, _p, monster, need) => named(e, monster, 'Ancient Gear') && fc.counters >= need,
  };

  E['Arcane Barrier'] = {
    ...continuousSpell(),
    *onAnyToGrave(e, fc, p, events) {
      if (!events.some((v) => destroyedMonster(v) && v.faceUp && v.race === 'Spellcaster') || fc.counters >= 4) return;
      fc.counters++;
      e.log(p, `A Spell Counter is placed on Arcane Barrier (${fc.counters})`);
    },
    ignition: {
      can: (e, _fc, p) => faceUpMonsters(e, p).some((m) => raceOf(e, m) === 'Spellcaster'),
      *run(e, fc, p) {
        const m = yield* pickOne(e, p, 'Arcane Barrier: send which Spellcaster to the GY?', faceUpMonsters(e, p).filter((x) => raceOf(e, x) === 'Spellcaster'), true);
        if (!m || !e.fieldCard(fc.uid)) return;
        const n = fc.counters;
        yield* e.sendToGrave(fc.uid, 'cost');
        yield* e.sendToGrave(m.uid, 'cost');
        e.log(p, `Arcane Barrier: ${e.player(p).name} draws ${n} card${n === 1 ? '' : 's'}`);
        if (n > 0) e.draw(p, n);
      },
    },
  };

  E['Attack the Moon!'] = {
    ...continuousSpell(),
    *onAnyPositionChange(e, fc, p, m, mp) {
      if (mp !== p || !m.faceUp || raceOf(e, m) !== 'Rock' || !opt(e, fc, p)) return;
      const targets = stOf(e, other(p));
      if (!targets.length || !(yield* e.yesno(p, `Attack the Moon!: destroy 1 Spell/Trap your opponent controls?`))) return;
      const t = yield* pickOne(e, p, 'Attack the Moon!: destroy which card?', targets);
      if (!t) return;
      useOpt(e, fc, p);
      e.log(p, `Attack the Moon! destroys ${label(t)}`);
      yield* e.destroy([t.uid]);
    },
  };

  const fiendFusion = (e: Engine, p: Pid) => faceUpMonsters(e, p).some((m) => info(e, m).sub === 'Fusion' && raceOf(e, m) === 'Fiend' && levelOf(e, m) >= 8);
  const zeroStat = (e: Engine, c: Card) => {
    const m = e.fieldCard(c.uid);
    if (m && e.find(c.uid)?.loc.zone === 'mz') return e.atkOf(m) === 0 || e.defOf(m) === 0;
    return (info(e, c).atk ?? -1) === 0 || (info(e, c).def ?? -1) === 0;
  };
  E['Branded Disciple'] = {
    ...continuousSpell(),
    quick: {
      label: 'negate that effect',
      can: (e, _c, p, _t, ctx) =>
        e.oncePerTurn('Branded Disciple:1', p) && isEffectLink(ctx.link) && ctx.link!.player === other(p) && !ctx.link!.negated && (isMonster(e, ctx.link!.card) || e.find(ctx.link!.card.uid)?.loc.zone === 'mz') && zeroStat(e, ctx.link!.card) && fiendFusion(e, p),
      *cost(e, _c, p) {
        e.useOnce('Branded Disciple:1', p);
      },
      *run(e, _c, p, link) {
        // "Negate that effect" (not its activation), so Constellar Belt does not stop it.
        const target = (link.payload as { ctx?: ChainCtx }).ctx?.link;
        if (!target || !fiendFusion(e, p)) return;
        target.negated = true;
        e.log(p, `Branded Disciple negates ${target.card.name}'s effect`);
      },
    },
    *onBattleEnd(e, fc, p, attacker, target, aAtk, tAtk) {
      if (aAtk !== 0 || tAtk !== 0 || !e.oncePerTurn('Branded Disciple:2', p)) return;
      const theirs = [attacker, target].find((m) => e.fieldCard(m.uid) && e.controller(m.uid) === other(p));
      if (!theirs || !(yield* e.yesno(p, `Branded Disciple: destroy ${theirs.name}?`))) return;
      e.useOnce('Branded Disciple:2', p);
      if (e.fieldCard(fc.uid) && e.fieldCard(theirs.uid)) yield* e.destroy([theirs.uid]);
    },
  };

  E['Cerulean Skyfire'] = {
    ...continuousSpell(),
    quick: {
      label: 'negate that Spell/Trap effect',
      can: (e, _c, p, t, ctx) =>
        (t === 'spell' || t === 'trap' || t === 'effect') && !!ctx.link && ctx.link.player === other(p) && !ctx.link.negated && info(e, ctx.link.card).kind !== 'monster' && e.find(ctx.link.card.uid)?.loc.zone !== 'mz' && faceUpMonsters(e, p).some((m) => e.isNamed(m, 'Hamon, Lord of Striking Thunder') && m.pos === 'atk'),
      *run(e, _c, p, link) {
        const target = (link.payload as { ctx?: ChainCtx }).ctx?.link;
        negateLink(e, target, p);
        const hamon = yield* pickOne(e, p, 'Cerulean Skyfire: change which Hamon to Defense Position?', faceUpMonsters(e, p).filter((m) => e.isNamed(m, 'Hamon, Lord of Striking Thunder') && m.pos === 'atk'));
        if (hamon) {
          hamon.pos = 'def';
          e.log(p, `${hamon.name} changes to Defense Position`);
        }
      },
    },
    // Approximated: a Sacred Beast leaving the field is seen when it goes to the GY (not when it is banished or returned).
    *onAnyToGrave(e, _fc, p, events) {
      if (!events.some((v) => v.from === 'mz' && v.faceUp && v.controller === p && e.namesOf(v.card).some((nm) => LORDS.includes(nm)))) return;
      ((e.state.fx.noDamage ??= [-1, -1]) as number[])[p] = e.state.turn;
      e.log(p, `Cerulean Skyfire: ${e.player(p).name} takes no damage this turn`);
    },
  };

  // The no-negation itself lives in negateLink (helpers.ts).
  E['Constellar Belt'] = { ...continuousSpell() };

  const gravekeeperOut = (e: Engine) => faceUpMonsters(e).some((m) => named(e, m, "Gravekeeper's"));
  const necrovalley = (e: Engine) => !!e.anyActive('Necrovalley') || (![0, 1].some((q) => e.player(q as Pid).field?.faceUp) && faceUpMonsters(e).some((m) => e.isNamed(m, "Gravekeeper's Priestess") && !e.isNegated(m)));
  E['Hidden Temples of Necrovalley'] = {
    canActivate: (e, _c, _p, t) => isMain(t) && gravekeeperOut(e) && necrovalley(e),
    *resolve() {},
    forbidsSummon: (e, _fc, _p, monster, _who, how) => how === 'special' && !named(e, monster, "Gravekeeper's"),
    *stateCheck(e, fc) {
      if (!gravekeeperOut(e) || !necrovalley(e)) yield* destroySelf(e, fc, 'no "Gravekeeper\'s" monster or "Necrovalley" on the field');
    },
  };

  E['Jam Breeding Machine'] = {
    ...continuousSpell(),
    *onStandby(e, _fc, p) {
      if (e.state.turnPlayer !== p) return;
      if (e.createToken('Slime Token', p, 'atk', true, { atk: 500, def: 500, level: 1, attribute: 'WATER', race: 'Aqua' })) e.log(p, 'Jam Breeding Machine makes a Slime Token');
    },
    forbidsSummon: (e, _fc, p, monster, who, how) => who === p && how !== 'set' && !e.isNamed(monster, 'Slime Token'),
  };

  const assemblyTargets = (e: Engine, p: Pid, n: number) => e.player(p).gy.filter((c) => isMonster(e, c) && info(e, c).race === 'Machine' && !isExtraOrRitual(e, c) && (info(e, c).level ?? 0) <= n);
  E['Machine Assembly Line'] = {
    ...continuousSpell(),
    aura: (e, _src, m) => (m.faceUp && raceOf(e, m) === 'Machine' ? { atk: 200, def: 0 } : undefined),
    *onAnyToGrave(e, fc, p, events) {
      if (!events.some((v) => destroyedMonster(v) && v.faceUp && v.race === 'Machine')) return;
      fc.counters += 2;
      e.log(p, `2 Junk Counters are placed on Machine Assembly Line (${fc.counters})`);
    },
    ignition: {
      can: (e, fc, p) => freeMZ(e, p) && assemblyTargets(e, p, fc.counters).length > 0,
      *run(e, fc, p) {
        const n = fc.counters;
        if (!e.fieldCard(fc.uid)) return;
        yield* e.sendToGrave(fc.uid, 'cost');
        yield* summonOneOf(e, p, `Machine Assembly Line: Special Summon which Machine (Level ${n} or lower)?`, assemblyTargets(e, p, n));
      },
    },
  };

  const divineInHand = (e: Engine, p: Pid) => e.player(p).hand.filter((c) => isMonster(e, c) && info(e, c).race === 'Divine-Beast');
  const rebornFor = (e: Engine, p: Pid) => [...e.player(p).deck, ...e.player(p).gy].filter((c) => e.isNamed(c, 'Monster Reborn'));
  E['Millennium Revelation'] = {
    ...continuousSpell(),
    ignition: {
      repeat: true,
      can: (e, _fc, p) => (e.oncePerTurn('Millennium Revelation:1', p) && divineInHand(e, p).length > 0 && rebornFor(e, p).length > 0) || e.oncePerTurn('Millennium Revelation:2', p),
      *run(e, fc, p) {
        const can1 = e.oncePerTurn('Millennium Revelation:1', p) && divineInHand(e, p).length > 0 && rebornFor(e, p).length > 0;
        const can2 = e.oncePerTurn('Millennium Revelation:2', p);
        const labels = [...(can1 ? ['Send a Divine-Beast: add "Monster Reborn"'] : []), ...(can2 ? ['Send this card: revive Ra with "Monster Reborn" this turn'] : [])];
        const k = yield* chooseOption(e, p, 'Millennium Revelation: use which effect?', labels, true);
        if (k === null) return;
        if (labels[k].startsWith('Send a Divine')) {
          const d = yield* pickOne(e, p, 'Send which Divine-Beast monster to the GY?', divineInHand(e, p), true);
          if (!d) return;
          e.useOnce('Millennium Revelation:1', p);
          yield* e.sendToGrave(d.uid, 'cost');
          const r = yield* pickOne(e, p, 'Add which "Monster Reborn"?', rebornFor(e, p));
          if (!r) return;
          const fromDeck = e.find(r.uid)?.loc.zone === 'deck';
          e.toHandOf(r.uid, p);
          if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
          e.log(p, `${e.player(p).name} adds Monster Reborn to the hand`);
        } else {
          e.useOnce('Millennium Revelation:2', p);
          yield* e.sendToGrave(fc.uid, 'cost');
          ((e.state.fx.revelation ??= [-1, -1]) as number[])[p] = e.state.turn;
          e.log(p, 'Millennium Revelation: "The Winged Dragon of Ra" can be revived with "Monster Reborn" this turn');
        }
      },
    },
  };

  const GAIAS = ['Gaia The Fierce Knight', 'Swift Gaia the Fierce Knight', 'Gaia the Dragon Champion'];
  E['Spiral Spear Strike'] = {
    ...continuousSpell(),
    grantsPiercing: (e, _fc, p, attacker) => e.controller(attacker.uid) === p && e.namesOf(attacker).some((nm) => GAIAS.includes(nm)),
    *onBattleDamageDealt(e, fc, attacker, p) {
      if (!fc.active || e.spellsNegated() || !e.isNamed(attacker, 'Gaia the Dragon Champion')) return;
      const b = e.state.battle;
      const target = b && b.target !== null ? e.fieldCard(b.target) : null;
      if (!target || target.pos !== 'def') return;
      e.log(p, 'Spiral Spear Strike: draw 2 cards, then discard 1');
      if (!e.draw(p, 2)) return;
      const d = yield* pickOne(e, p, 'Spiral Spear Strike: discard 1 card', e.player(p).hand);
      if (d) yield* e.discard(p, d.uid);
    },
  };

  E['Supply Squad'] = {
    ...continuousSpell(),
    *onAnyToGrave(e, fc, p, events) {
      if (!events.some((v) => destroyedMonster(v) && v.controller === p) || !opt(e, fc, p)) return;
      useOpt(e, fc, p);
      e.log(p, 'Supply Squad: draw 1 card');
      e.draw(p, 1);
    },
  };

  // The sealing itself is in the engine (spellsSealed / trapsNegated / trapsSealed), while Meisei is face-up.
  E['Talisman of Trap Sealing'] = {
    canActivate: (e, _c, p, t) => isMain(t) && meisei(e, p),
    *resolve() {},
    *stateCheck(e, fc, p) {
      if (!meisei(e, p)) yield* destroySelf(e, fc, '"Sealmaster Meisei" left the field');
    },
  };
  E['Talisman of Spell Sealing'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && meisei(e, p),
    *resolve() {},
    *stateCheck(e, fc, p) {
      if (!meisei(e, p)) yield* destroySelf(e, fc, '"Sealmaster Meisei" left the field');
    },
  };

  E['Veil of Darkness'] = {
    ...continuousSpell(),
    *onDrawPhase(e, _fc, p, drawn) {
      const dark = drawn.filter((c) => e.find(c.uid)?.loc.zone === 'hand' && isMonster(e, c) && attrOf(e, c) === 'DARK');
      if (!dark.length || !(yield* e.yesno(p, `Veil of Darkness: reveal ${dark.map((c) => c.name).join(', ')} and send ${dark.length > 1 ? 'them' : 'it'} to the GY?`))) return;
      e.log(p, `${e.player(p).name} reveals ${dark.map((c) => c.name).join(', ')}`);
      for (const c of dark) yield* e.sendToGrave(c.uid, 'used');
      if (e.player(p).deck.length && (yield* e.yesno(p, 'Veil of Darkness: draw 1 more card?'))) e.draw(p, 1);
    },
  };

  E['Verdant Sanctuary'] = {
    ...continuousSpell(),
    *onAnyToGrave(e, _fc, _p, events) {
      for (const v of events) {
        if (!destroyedMonster(v) || !v.faceUp || !v.toGy || v.token || v.race !== 'Insect') continue;
        const q = v.controller;
        const lv = info(e, v.card).level ?? 0;
        const test = (c: Card) => isMonster(e, c) && info(e, c).race === 'Insect' && (info(e, c).level ?? 0) === lv;
        if (!e.player(q).deck.some(test)) continue;
        if (!(yield* e.yesno(q, `Verdant Sanctuary: add a Level ${lv} Insect monster from your Deck to your hand?`))) continue;
        const prev = e.actor;
        e.actor = q;
        yield* searchDeck(e, q, `Verdant Sanctuary: add which Level ${lv} Insect?`, test);
        e.actor = prev;
      }
    },
  };

  // ---------- Continuous Traps ----------
  const lordCount = (e: Engine, p: Pid) => new Set(faceUpMonsters(e, p).filter((m) => e.namesOf(m).some((nm) => LORDS.includes(nm))).map((m) => m.name)).size;
  const contTrapsInGy = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => info(e, c).kind === 'trap' && info(e, c).sub === 'Continuous');
  E['Awakening of the Sacred Beasts'] = {
    ...continuousTrap(),
    *onAnySummon(e, _fc, p, m, mp, kind) {
      if (kind === 'flip' || mp !== other(p) || lordCount(e, p) < 1 || !e.fieldCard(m.uid)) return;
      const atk = e.atkOf(m);
      e.log(p, `Awakening of the Sacred Beasts: ${e.player(p).name} gains ${atk} LP`);
      if (atk > 0) e.gainLp(p, atk);
    },
    negatesEffect: (e, _fc, p, link) => lordCount(e, p) >= 2 && isEffectLink(link) && link.player === other(p) && e.find(link.card.uid)?.loc.zone === 'mz' && e.controller(link.card.uid) === other(p),
    banishInstead: (e, _fc, p, moving) => lordCount(e, p) >= 3 && moving.owner === other(p) && isMonster(e, moving),
    ignition: {
      can: (e, _fc, p) => faceUpMonsters(e, p).some((m) => levelOf(e, m) === 10) && contTrapsInGy(e, p).length > 0,
      *run(e, _fc, p) {
        const c = yield* pickOne(e, p, 'Awakening of the Sacred Beasts: add which Continuous Trap?', contTrapsInGy(e, p));
        if (!c) return;
        e.toHandOf(c.uid, p);
        e.log(p, `${e.player(p).name} adds ${c.name} from the GY to the hand`);
      },
    },
  };

  const archfiends = (e: Engine, p: Pid) => faceUpMonsters(e, p).filter((m) => named(e, m, 'Archfiend'));
  E['Battle-Scarred'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && archfiends(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Battle-Scarred: select which Archfiend?', archfiends(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      const me = e.fieldCard(link.card.uid);
      if (!me || !m || !m.faceUp || e.controller(m.uid) !== p) return;
      tag(me).bsTarget = m.uid;
      e.log(p, `Battle-Scarred selects ${m.name}`);
    },
    *onStandby(e, fc, p) {
      if (e.state.turnPlayer !== p) return;
      tag(fc).bsTurn = e.state.turn;
      tag(fc).bsLp = ((e.state.fx.lpLost ?? [0, 0]) as number[])[p];
    },
    *stateCheck(e, fc, p) {
      const t = fc.tags?.bsTarget;
      const m = t !== undefined ? e.fieldCard(t) : null;
      if (!m) return yield* destroySelf(e, fc, 'its Archfiend left the field');
      const tg = tag(fc);
      if (tg.bsTurn !== e.state.turn || tg.bsDone === e.state.turn || e.state.turnPlayer !== p || e.state.phase === 'SP') return;
      tg.bsDone = e.state.turn;
      const paid = ((e.state.fx.lpLost ?? [0, 0]) as number[])[p] - (tg.bsLp ?? 0);
      const n = standbyCost(e, m);
      if (n > 0 && paid >= n && e.controller(m.uid) === p) {
        e.log(p, `Battle-Scarred: ${e.player(other(p)).name} pays ${n} LP too`);
        e.payLp(other(p), n);
      }
    },
    *onLeaveField(e, fc) {
      const t = fc.tags?.bsTarget;
      if (t === undefined || !e.fieldCard(t)) return;
      e.log(null, 'Battle-Scarred left the field: its Archfiend is destroyed');
      yield* e.destroy([t]);
    },
  };

  E['Chain Ignition'] = {
    ...continuousTrap(),
    *onAnyToGrave(e, fc, p, events) {
      if (!events.some((v) => destroyedMonster(v) && !v.byBattle && v.controller === other(p) && v.by === other(p)) || !opt(e, fc, p)) return;
      const targets = [...targetable(e, allMonsters(e)), ...allST(e)];
      if (!targets.length || !(yield* e.yesno(p, 'Chain Ignition: destroy 1 card on the field?'))) return;
      const t = yield* pickOne(e, p, 'Chain Ignition: destroy which card?', targets);
      if (!t) return;
      useOpt(e, fc, p);
      yield* e.destroy([t.uid]);
    },
  };

  E['Coffin Seller'] = {
    ...continuousTrap(),
    *onAnyToGrave(e, _fc, p, events) {
      if (!events.some((v) => v.toGy && !v.token && v.card.owner === other(p) && isMonster(e, v.card))) return;
      e.log(p, 'Coffin Seller inflicts 300 damage');
      e.damage(other(p), 300);
    },
  };

  E['Copy Knight'] = {
    canActivate: (e, _c, p, t, ctx) => {
      if (t !== 'summon' || ctx.summonKind !== 'normal' || ctx.uid === undefined || !freeMZ(e, p)) return false;
      const m = e.fieldCard(ctx.uid);
      return !!m && m.faceUp && e.controller(m.uid) === p && raceOf(e, m) === 'Warrior' && levelOf(e, m) <= 4;
    },
    *activate(e, link, _p, ctx) {
      const m = ctx.uid !== undefined ? e.fieldCard(ctx.uid) : null;
      link.targetUid = ctx.uid;
      link.payload = { level: m ? levelOf(e, m) : 4, copied: m?.name ?? '' };
    },
    *resolve(e, link, p) {
      const { level, copied } = link.payload as { level: number; copied: string };
      e.log(p, `Copy Knight becomes a copy of ${copied} (Level ${level})`);
      yield* trapMonster(e, link.card, p, level, 'Warrior', 'LIGHT');
      const me = e.fieldCard(link.card.uid);
      if (me && copied) ((e.state.fx.copyKnight ??= {}) as Record<number, string>)[me.uid] = copied; // audit-02: "with the same name"
    },
    baseStats: () => ({ atk: 0, def: 0 }),
    // audit-02: approximated, the copied name counts where card names on the field are read by name (Fusion Materials).
    fieldName: (e, m) => (e.find(m.uid)?.loc.zone === 'mz' ? ((e.state.fx.copyKnight ?? {}) as Record<number, string>)[m.uid] : undefined),
  };

  E["Dragon's Rage"] = {
    ...continuousTrap(),
    grantsPiercing: (e, _fc, p, attacker) => e.controller(attacker.uid) === p && raceOf(e, attacker) === 'Dragon',
  };

  const smallNormal = (e: Engine, c: Card) => isNormalMonster(e, c) && (info(e, c).level ?? 0) <= 2;
  E['Human-Wave Tactics'] = {
    ...continuousTrap(),
    *onAnyToGrave(e, fc, p, events) {
      const n = events.filter((v) => v.byBattle && v.controller === p && v.card.owner === p && !v.token && smallNormal(e, v.card)).length;
      if (!n) return;
      const tg = tag(fc);
      if (tg.hwTurn !== e.state.turn) (tg.hwTurn = e.state.turn), (tg.hwCount = 0);
      tg.hwCount += n;
    },
    *onEndPhase(e, fc, p) {
      if (e.trapsNegated(fc.name)) return;
      const n = fc.tags?.hwTurn === e.state.turn ? fc.tags.hwCount ?? 0 : 0;
      if (!n) return;
      const ps = e.player(p);
      const k = Math.min(n, ps.mz.filter((z) => z === null).length, ps.deck.filter((c) => smallNormal(e, c)).length);
      if (k > 0) {
        const chosen = yield* pick(e, p, `Human-Wave Tactics: Special Summon ${k} Level 2 or lower Normal Monster${k > 1 ? 's' : ''}`, ps.deck.filter((c) => smallNormal(e, c)), k, k);
        for (const c of chosen ?? []) yield* e.specialSummon(c.uid, p, 'atk');
      }
      ps.deck = e.shuffle(ps.deck);
      tag(fc).hwCount = 0;
    },
  };

  // Approximated: "This card's name becomes "Ring of Destruction" while on the field" is not modelled (no card in the pool reads it).
  E['Loop of Destruction'] = {
    ...continuousTrap(),
    *onAnyToGrave(e, fc, p, events) {
      if (!events.some((v) => destroyedMonster(v) && !v.byBattle) || !opt(e, fc, p)) return;
      const targets = targetable(e, allMonsters(e));
      if (!targets.length || !(yield* e.yesno(p, 'Loop of Destruction: destroy 1 monster on the field (each player takes 500 damage)?'))) return;
      const t = yield* pickOne(e, p, 'Loop of Destruction: destroy which monster?', targets);
      if (!t) return;
      useOpt(e, fc, p);
      yield* e.destroy([t.uid]);
      if (e.fieldCard(t.uid)) return;
      e.log(p, 'Loop of Destruction: each player takes 500 damage');
      e.damage(p, 500);
      e.damage(other(p), 500);
    },
  };

  E['Machine King - 3000 B.C.'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && freeMZ(e, p),
    *resolve(e, link, p) {
      yield* trapMonster(e, link.card, p, 4, 'Machine', 'EARTH');
      if (e.find(link.card.uid)?.loc.zone !== 'mz') return;
      ((e.state.fx.summonLock ??= [-1, -1]) as number[])[p] = e.state.turn;
      e.state.fx.summonLockExcept = link.card.uid;
      e.log(p, `${e.player(p).name} cannot Normal or Special Summon other monsters this turn`);
    },
    baseStats: () => ({ atk: 1000, def: 1000 }),
    ignition: {
      can: (e, m, p) => e.monsters(p).some((x) => x.uid !== m.uid && raceOf(e, x) === 'Machine'),
      *run(e, m, p) {
        const t = yield* pickOne(e, p, 'Machine King - 3000 B.C.: Tribute which Machine?', e.monsters(p).filter((x) => x.uid !== m.uid && raceOf(e, x) === 'Machine'));
        if (!t) return;
        const atk = t.faceUp ? e.atkOf(t) : 0;
        e.log(p, `${e.player(p).name} Tributes ${t.name}`);
        yield* e.sendToGrave(t.uid, 'tribute');
        const me = e.fieldCard(m.uid);
        if (!me || !me.faceUp) return;
        me.atkMod += atk;
        e.log(p, `${me.name} gains ${atk} ATK until the end of this turn`);
      },
    },
  };

  const helios = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.player(p).deck].filter((c) => e.isNamed(c, 'Helios - The Primordial Sun'));
  E['Macro Cosmos'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve(e, _link, p) {
      if (!freeMZ(e, p) || !helios(e, p).length) return;
      if (!(yield* e.yesno(p, 'Macro Cosmos: Special Summon "Helios - The Primordial Sun" from your hand or Deck?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which Helios?', helios(e, p));
    },
    banishInstead: () => true,
  };

  // The 3-per-turn limit is counted by the engine (Special Summons from the Extra Deck).
  E['Summon Gate'] = { ...continuousTrap() };

  E['Swamp Mirrorer'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && freeMZ(e, p),
    *activate(e, link, p) {
      const r = yield* chooseOption(e, p, 'Swamp Mirrorer: declare a Monster Type', RACES);
      const a = yield* chooseOption(e, p, 'Swamp Mirrorer: declare an Attribute', ATTRIBUTES);
      link.payload = { race: RACES[r ?? 0], attr: ATTRIBUTES[a ?? 0] };
      e.log(p, `${e.player(p).name} declares ${RACES[r ?? 0]} / ${ATTRIBUTES[a ?? 0]}`);
    },
    *resolve(e, link, p) {
      const { race, attr } = link.payload as { race: string; attr: string };
      yield* trapMonster(e, link.card, p, 4, race, attr);
    },
    baseStats: () => ({ atk: 1800, def: 1000 }),
  };
}
