// Speed Duel card scripts, batch 12 (Speed Duel GX and later sets: Abyss Actor - Extras ... Rise of the Snake Deity).
// Uses the batch-12 engine hooks: locksActivation, cannotSpecial, negatesBattleVictims, guardsFromAttack,
// Quick Effects from the Extra Deck, engine.returnLater / resolvingCard / activationLocked, and the
// fx records destroyedLog, gyToHand, fusionMatList and the `ss` / `ssExtra` Special Summon tags.
import type { EffectDef } from '../effects';
import type { SpeedHelpers } from './helpers';
import {
  anyTime,
  attrOf,
  boostPerm,
  boostTurn,
  chooseOption,
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
  named,
  negateMonster,
  other,
  pick,
  pickOne,
  raceOf,
  stOf,
  summonOneOf,
  tag,
  targetable,
  toDeck,
  tributeCost,
} from './helpers';
import type { Card, ChainCtx, ChainLink, Engine, FieldCard, Pid, Step } from './helpers';
import { extraReq, fits } from './extra';

// ---------- local helpers ----------
const zoneOf = (e: Engine, uid: number) => e.find(uid)?.loc.zone;
const isFusion = (e: Engine, c: Card) => info(e, c).sub === 'Fusion';
/** Monsters an effect may Special Summon from the hand/Deck/GY (no Extra Deck/Ritual monsters, no "cannot be Normal Summoned" ones). */
const canSS = (e: Engine, c: Card) => isMonster(e, c) && !isExtraOrRitual(e, c) && !e.effectOn(c)?.cannotNormalSummon;
const isEffectLink = (link: ChainLink | undefined) => !!(link?.payload as { effect?: string } | undefined)?.effect;
/** The chain link a Quick Effect responded to. */
const respondedTo = (link: ChainLink) => (link.payload as { ctx?: ChainCtx } | undefined)?.ctx?.link;
/** Is the card resolving right now this one (Release Restraint, Fossil Fusion)? */
const resolvingIs = (e: Engine, name: string) => {
  return e.resolvingCard()?.name === name;
};
const ssTagged = (m: FieldCard) => !!m.tags?.ss;
/** The face-up card's battle partner in the current battle. */
function battlePartner(e: Engine, uid: number): FieldCard | null {
  const b = e.state.battle;
  if (!b || b.target === null) return null;
  if (b.attacker === uid) return e.fieldCard(b.target);
  if (b.target === uid) return e.fieldCard(b.attacker);
  return null;
}
/** Takes a card out of the hand/Deck/GY/banished pile without side effects. */
function lift(e: Engine, uid: number): Card | null {
  const f = e.find(uid);
  if (!f || !['hand', 'deck', 'gy', 'removed'].includes(f.loc.zone)) return null;
  const ps = e.player(f.loc.player);
  const arr = f.loc.zone === 'hand' ? ps.hand : f.loc.zone === 'deck' ? ps.deck : f.loc.zone === 'gy' ? ps.gy : ps.removed;
  arr.splice(f.loc.index, 1);
  return { uid: f.card.uid, name: f.card.name, owner: f.card.owner };
}
const onField = (e: Engine, c: Card, pos: 'atk' | 'def', faceUp: boolean): FieldCard => ({ ...c, pos, faceUp, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 });
/** Returns a Fusion Monster to the Extra Deck (from the field, hand, GY or banishment). */
function toExtra(e: Engine, uid: number) {
  const f = e.find(uid);
  if (!f || f.card.token) return;
  const owner = f.card.owner;
  if (f.loc.zone === 'mz') e.toHand(uid);
  else e.toHandOf(uid, owner);
  const hand = e.player(owner).hand;
  const i = hand.findIndex((c) => c.uid === uid);
  if (i < 0) return;
  const [c] = hand.splice(i, 1);
  e.player(owner).fusion.push(c);
  e.log(owner, `${c.name} returns to the Extra Deck`);
}
/** Returns a monster to the hand (Fusion Monsters go to the Extra Deck instead). */
function bounceMonster(e: Engine, m: FieldCard) {
  if (isFusion(e, m)) toExtra(e, m.uid);
  else e.toHand(m.uid);
}
function coin(e: Engine, p: Pid, what: string): boolean {
  const heads = e.roll(2) === 1;
  e.log(p, `${what}: ${heads ? 'Heads' : 'Tails'}`);
  return heads;
}
/** Light Barrier on `p`'s field, with its effects on (not turned off by its own Tails, not negated). */
const lightBarrier = (e: Engine, p: Pid) => {
  const lb = e.player(p).field;
  return !!lb && lb.faceUp && !!lb.active && e.isNamed(lb, 'Light Barrier') && !lb.tags?.lbOff && !e.spellsNegated();
};
/** Arcana Force "When this card is Summoned, toss a coin" (tags.coin 1 = Heads, 2 = Tails); Light Barrier lets you choose. */
function arcanaCoin(): Partial<EffectDef> {
  const run = function* (e: Engine, m: FieldCard, p: Pid): Step {
    let heads: boolean;
    if (lightBarrier(e, p)) {
      heads = (yield* chooseOption(e, p, `Light Barrier: apply which effect of ${m.name}?`, ['Heads', 'Tails'])) !== 1;
      e.log(p, `${m.name}: ${heads ? 'Heads' : 'Tails'} (chosen with Light Barrier)`);
    } else heads = coin(e, p, m.name);
    tag(m).coin = heads ? 1 : 2;
  };
  return { onSummon: (e, m, p) => run(e, m, p), onSpecialSummon: run };
}
/** A Gemini monster: Normal Summon it again while it is face-up (uses the Normal Summon) to unlock its effect. */
const geminiOn = (m: FieldCard) => m.tags?.gemini === 1;
const gemini = (): Partial<EffectDef> => ({
  ignition: {
    chain: false,
    can: (e, m, p) => !geminiOn(m) && !e.player(p).normalSummoned,
    *run(e, m, p) {
      if (geminiOn(m) || e.player(p).normalSummoned) return;
      e.player(p).normalSummoned = true;
      tag(m).gemini = 1;
      e.log(p, `${e.player(p).name} Normal Summons ${m.name} again: it becomes an Effect Monster`);
    },
  },
});
/** Places a card from the hand/GY face-down in a Spell & Trap Zone (it can be activated this turn). */
function setFromPile(e: Engine, uid: number, p: Pid, readyNow: boolean, tags?: Record<string, number>): FieldCard | null {
  const z = freeST(e, p);
  if (z < 0) return null;
  const c = lift(e, uid);
  if (!c) return null;
  const fc = onField(e, c, 'atk', false);
  if (readyNow) fc.placedTurn = -1;
  if (tags) fc.tags = { ...tags };
  e.player(p).sz[z] = fc;
  e.event('set', { uid, player: p });
  e.log(p, `${e.player(p).name} Sets a card`);
  return fc;
}
const fusionMats = (e: Engine) => (e.state.fx.fusionMatList ?? {}) as Record<number, number[]>;
/** Every card used as material for a Fusion Summon this Duel (as far as the Fusion effects recorded it). */
const usedAsMaterial = (e: Engine) => new Set(Object.values(fusionMats(e)).flat());
const destroyedLog = (e: Engine) => ((e.state.fx.destroyedLog ?? []) as { name: string; controller: Pid; faceUp: boolean; byBattle: boolean; turn: number }[]).filter((x) => x.turn === e.state.turn);
const ATTRS = ['DARK', 'EARTH', 'FIRE', 'LIGHT', 'WATER', 'WIND'];

export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  // ===================== Effect Monsters =====================
  // Both its effects work with the Pendulum Zones, which Speed Duel does not have.
  E['Abyss Actor - Extras'] = {};

  // "When a "roid" monster is added from your GY to your hand": usable while that monster is still in the hand this turn.
  const roidsBack = (e: Engine, p: Pid) => {
    const back = (e.state.fx.gyToHand ?? {}) as Record<number, number>;
    const used = (e.state.fx.ambulanced ?? {}) as Record<number, number>;
    return e.player(p).hand.filter((c) => canSS(e, c) && named(e, c, 'roid') && back[c.uid] === e.state.turn && used[c.uid] !== e.state.turn);
  };
  E['Ambulanceroid'] = {
    quick: {
      label: 'Special Summon the "roid" monster added from the GY',
      repeat: true,
      can: (e, _c, p) => freeMZ(e, p) && roidsBack(e, p).length > 0,
      *cost(e, _c, p, link) {
        const r = yield* pickOne(e, p, 'Ambulanceroid: Special Summon which "roid" monster?', roidsBack(e, p), true);
        if (!r) return false;
        (e.state.fx.ambulanced ??= {})[r.uid] = e.state.turn;
        link.targetUid = r.uid;
      },
      *run(e, _c, p, link) {
        if (link.targetUid === undefined || zoneOf(e, link.targetUid) !== 'hand' || !freeMZ(e, p)) return;
        yield* e.specialSummon(link.targetUid, p, 'atk');
      },
    },
  };

  E['Ancient Gear Knight'] = {
    ...gemini(),
    locksActivation: (e, m, ctl, p) => geminiOn(m) && p !== ctl && e.state.battle?.attacker === m.uid,
  };

  E['Arcana Force XXI - The World'] = {
    ...arcanaCoin(),
    *onEndPhase(e, m, p) {
      if (m.tags?.coin !== 1 || e.state.turnPlayer !== p || e.monsters(p).length < 2) return;
      if (!(yield* e.yesno(p, "The World: send 2 monsters you control to the GY to skip your opponent's next turn?"))) return;
      const two = yield* pick(e, p, 'The World: send which 2 monsters to the GY?', e.monsters(p), 2, 2, true, false);
      if (!two) return;
      for (const x of two) yield* e.sendToGrave(x.uid, 'cost');
      e.state.fx.skipTurn = other(p);
      e.log(p, `${e.player(other(p)).name}'s next turn will be skipped`);
    },
    // Tails, "during your opponent's Draw Phase": done at the start of their Standby Phase.
    *onStandby(e, m, p) {
      if (m.tags?.coin !== 2 || e.state.turnPlayer !== other(p)) return;
      const gy = e.player(other(p)).gy;
      const top = gy[gy.length - 1];
      if (!top) return;
      e.toHandOf(top.uid, other(p));
      e.log(p, `The World: ${top.name} returns from the GY to ${e.player(other(p)).name}'s hand`);
    },
  };

  // The Synchro Material effect never applies (no Synchro Monsters).
  E['Blackwing - Brisote the Tailwind'] = {
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && destroyedLog(e).filter((x) => x.controller === p && x.faceUp && named(e, x.name, 'Blackwing')).length >= 2,
      *run(e, c, p) {
        if (freeMZ(e, p)) yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
  };

  // Negates monster effects that recorded this card as their target (as it is targeted).
  E['Chaos Command Magician'] = {
    quick: {
      label: 'negate the monster effect targeting it',
      repeat: true,
      can: (e, c, _p, t, ctx) => (t === 'effect' || t === 'spell' || t === 'trap') && isEffectLink(ctx.link) && !ctx.link!.negated && ctx.link!.targetUid === c.uid && (isMonster(e, ctx.link!.card) || zoneOf(e, ctx.link!.card.uid) === 'mz'),
      *run(e, _c, p, link) {
        const target = respondedTo(link);
        if (!target) return;
        target.negated = true;
        e.log(p, `Chaos Command Magician negates ${target.card.name}'s effect`);
      },
    },
  };

  // Its Pendulum Effects and the Pendulum Zone part of its monster effect need Pendulum Zones.
  E['Clock Arc'] = {
    battleProof: () => true,
    *onSpecialSummon(e, m, p) {
      const mz = e.player(p).mz;
      if (mz.indexOf(m) === Math.floor(mz.length / 2)) return;
      e.log(p, 'Clock Arc was not Special Summoned to the center Main Monster Zone and is destroyed');
      yield* e.destroy([m.uid]);
    },
  };

  E['D.D. Destroyer'] = {
    *onLeaveField(e, _fc, p, reason) {
      if (reason !== 'banished') return;
      const list = [...faceUpMonsters(e, other(p)), ...stOf(e, other(p)).filter((c) => c.faceUp)];
      if (!list.length || !(yield* e.yesno(p, 'D.D. Destroyer: destroy 1 face-up card your opponent controls?'))) return;
      const t = yield* pickOne(e, p, 'D.D. Destroyer: destroy which card?', list);
      if (t) yield* e.destroy([t.uid]);
    },
  };

  E['Dark Ruler Ha Des'] = {
    cannotSpecial: (_e, _c, _p, from) => from === 'gy',
    negatesBattleVictims: (e, _src, killer) => raceOf(e, killer) === 'Fiend',
  };

  E['Destiny HERO - Doom Lord'] = {
    ignition: {
      can: (e, m, p) => m.pos === 'atk' && targetable(e, e.monsters(other(p))).length > 0,
      *run(e, m, p) {
        if (!e.fieldCard(m.uid) || !m.faceUp || m.pos !== 'atk') return;
        for (const x of e.monsters(p)) tag(x).noAttackTurn = e.state.turn;
        ((e.state.fx.noDeclare ??= [-1, -1]) as number[])[p] = e.state.turn;
        const t = yield* pickOne(e, p, 'Doom Lord: banish which monster?', targetable(e, e.monsters(other(p))));
        if (!t || !e.fieldCard(m.uid) || m.pos !== 'atk') return;
        const owner = e.controller(t.uid) ?? other(p);
        e.log(p, `Doom Lord banishes ${label(t)} until ${e.player(p).name}'s 2nd Standby Phase from now`);
        if (t.token) {
          yield* e.sendToGrave(t.uid, 'used');
          return;
        }
        const pos = t.pos;
        e.banish(t.uid);
        e.returnLater(t.uid, owner, pos, e.state.turn + 4, 'SP');
      },
    },
  };

  // Unaffected by Trap effects: a resolving Trap cannot destroy or target it.
  const trapResolving = (e: Engine) => {
    const c = e.resolvingCard();
    return !!c && isTrap(e, c);
  };
  E['Elemental HERO Wildheart'] = {
    effectProof: (e) => trapResolving(e),
    cannotBeTargeted: (e) => trapResolving(e),
  };

  // Its effect is only given to Xyz Monsters (none in Speed Duel).
  E['Express Train Trolley Olley'] = {};

  // "Tribute 1 or no monsters" is a real Normal Summon from the hand (not a Set); its ATK = the Tributes' original ATK.
  const fogAtk = (e: Engine, names: string[]) => names.reduce((a, n) => a + Math.max(0, info(e, n).atk ?? 0), 0);
  E['Fog King'] = {
    handIgnition: {
      can: (e, c, p) => !e.player(p).normalSummoned && (freeMZ(e, p) || e.monsters(p).length > 0) && !e.summonBlocked(p, c, 'normal', 'hand'),
      *run(e, card, p) {
        const ps = e.player(p);
        if (ps.normalSummoned) return;
        const opts = [...(e.monsters(p).length ? ['Tribute 1 monster'] : []), ...(freeMZ(e, p) ? ['Tribute no monsters'] : [])];
        const k = yield* chooseOption(e, p, 'Fog King: Normal Summon it how?', opts, true);
        if (k === null) return;
        const names: string[] = [];
        if (opts[k] === 'Tribute 1 monster') {
          const t = yield* pickOne(e, p, 'Fog King: Tribute which monster?', e.monsters(p), true);
          if (!t) return;
          names.push(t.name);
          yield* e.sendToGrave(t.uid, 'tribute');
          e.log(p, `${ps.name} Tributed ${t.name}`);
        }
        const z = ps.mz.findIndex((x) => x === null);
        if (z < 0 || zoneOf(e, card.uid) !== 'hand') return;
        const c = lift(e, card.uid);
        if (!c) return;
        const fc = onField(e, c, 'atk', true);
        fc.tags = { fog: 1, fogAtk: fogAtk(e, names) };
        ps.mz[z] = fc;
        ps.normalSummoned = true;
        e.event('summon', { uid: fc.uid, player: p });
        e.log(p, `${ps.name} Normal Summons Fog King`);
        yield* e.responseWindow('summon', { uid: fc.uid, summonKind: 'normal' });
        if (e.fieldCard(fc.uid)) yield* e.anySummon(fc, p, 'normal');
      },
    },
    // A Tribute Summon the usual way (2 Tributes): read the Tributes from the duel log.
    *onSummon(e, m, _p, kind) {
      if (kind !== 'normal' || m.tags?.fog) return;
      const log = e.state.log;
      let i = log.length - 1;
      while (i >= 0 && log[i].turn === e.state.turn && !log[i].text.includes('Summoned Fog King')) i--;
      const names: string[] = [];
      for (let j = i - 1; j >= 0 && j >= i - 8 && log[j].turn === e.state.turn && !log[j].text.includes('Summoned'); j--) {
        const hit = log[j].text.match(/ Tributed (.+)$/);
        if (hit) names.push(hit[1]);
      }
      tag(m).fog = 1;
      tag(m).fogAtk = fogAtk(e, names);
    },
    baseStats: (e, m) => (m.tags?.fog ? { atk: m.tags.fogAtk ?? 0, def: info(e, m).def ?? 0 } : undefined),
  };

  // The Equip Card(s) trigger is used as an effect right after each new Equip Card arrives.
  const newEquips = (m: FieldCard) => m.equips.filter((u) => !m.tags?.[`eq${u}`]);
  E['Gearfried the Swordmaster'] = {
    cannotNormalSummon: true,
    cannotSpecial: (e, _c, _p, from) => from !== null && from !== 'mz' && !resolvingIs(e, 'Release Restraint'),
    quick: {
      label: 'an Equip Card was equipped: destroy 1 monster',
      repeat: true,
      can: (e, c, p) => {
        const m = e.fieldCard(c.uid);
        return !!m && newEquips(m).length > 0 && targetable(e, e.monsters(other(p))).length > 0;
      },
      *cost(e, c, p, link) {
        const m = e.fieldCard(c.uid);
        if (!m) return false;
        for (const u of newEquips(m)) tag(m)[`eq${u}`] = 1;
        const t = yield* pickOne(e, p, 'Gearfried the Swordmaster: destroy which monster?', targetable(e, e.monsters(other(p))));
        if (!t) return false;
        link.targetUid = t.uid;
      },
      *run(e, _c, p, link) {
        if (link.targetUid !== undefined && e.fieldCard(link.targetUid) && e.controller(link.targetUid) === other(p)) yield* e.destroy([link.targetUid]);
      },
    },
  };

  // "At the start of the Damage Step": used when it declares its attack on a Special Summoned monster.
  E['Heavy Knight of the Flame'] = {
    ...gemini(),
    quick: {
      label: 'banish the Special Summoned monster it attacks',
      repeat: true,
      can: (e, c, p, t) => {
        const m = e.fieldCard(c.uid);
        const b = e.state.battle;
        if (t !== 'attack' || !m || !geminiOn(m) || !b || b.attacker !== c.uid || b.target === null) return false;
        const target = e.fieldCard(b.target);
        return !!target && ssTagged(target) && e.controller(target.uid) === other(p);
      },
      *run(e, c, p) {
        const target = battlePartner(e, c.uid);
        if (!target || !ssTagged(target) || e.controller(target.uid) !== other(p)) return;
        e.log(p, `Heavy Knight of the Flame banishes ${target.name}`);
        if (target.token) yield* e.sendToGrave(target.uid, 'used');
        else e.banish(target.uid);
      },
    },
  };

  E['Infernity Dwarf'] = {
    grantsPiercing: (e, _m, ctl, attacker) => e.player(ctl).hand.length === 0 && e.controller(attacker.uid) === ctl,
  };

  const legionTributes = (e: Engine, p: Pid) => e.player(p).hand.filter((c) => isMonster(e, c) && raceOf(e, c) === 'Spellcaster' && levelOf(e, c) >= 5 && e.canNormalSummon(p, c, true, true));
  const legionAdds = (e: Engine, p: Pid) => [...e.player(p).deck, ...e.player(p).gy].filter((c) => isNormalMonster(e, c) && raceOf(e, c) === 'Spellcaster');
  E['Legion the Fiend Jester'] = {
    ignition: {
      chain: false,
      can: (e, _m, p) => e.oncePerTurn('Legion the Fiend Jester:summon', p) && legionTributes(e, p).length > 0,
      *run(e, _m, p) {
        const c = yield* pickOne(e, p, 'Legion: Tribute Summon which Spellcaster (in addition to your Normal Summon)?', legionTributes(e, p), true);
        if (!c) return;
        e.useOnce('Legion the Fiend Jester:summon', p);
        yield* e.extraNormalSummon(p, c.uid, 'atk', true);
      },
    },
    *onSentToGrave(e, _card, p, from) {
      if (from !== 'mz' || !e.oncePerTurn('Legion the Fiend Jester', p) || !legionAdds(e, p).length) return;
      if (!(yield* e.yesno(p, 'Legion the Fiend Jester: add 1 Spellcaster Normal Monster from your Deck or GY to your hand?'))) return;
      const c = yield* pickOne(e, p, 'Legion: add which Spellcaster Normal Monster?', legionAdds(e, p));
      if (!c) return;
      e.useOnce('Legion the Fiend Jester', p);
      const fromDeck = zoneOf(e, c.uid) === 'deck';
      e.toHandOf(c.uid, p);
      if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
      e.log(p, `${e.player(p).name} adds ${c.name} to the hand`);
    },
  };

  // "Activate 1 Trap Card from your hand this turn": that Trap is Set and may be activated right away.
  E['Makyura the Destructor'] = {
    *onSentToGrave(e, _card, p, from) {
      if (from === 'mz') ((e.state.fx.makyura ??= [-1, -1]) as number[])[p] = e.state.turn;
    },
    quick: {
      from: 'gy',
      label: 'activate a Trap Card from your hand',
      can: (e, _c, p) => ((e.state.fx.makyura ?? [-1, -1]) as number[])[p] === e.state.turn && freeST(e, p) >= 0 && e.player(p).hand.some((c) => isTrap(e, c)),
      *cost(e, _c, p) {
        const t = yield* pickOne(e, p, 'Makyura: which Trap will you activate from your hand?', e.player(p).hand.filter((c) => isTrap(e, c)), true);
        if (!t || !setFromPile(e, t.uid, p, true)) return false;
        e.log(p, `${t.name} can be activated from the hand this turn`);
      },
      *run() {},
    },
  };

  E['Mechanical Hound'] = {
    locksActivation: (e, _m, ctl, p, kind) => kind === 'spell' && p !== ctl && e.player(ctl).hand.length === 0,
  };

  // Used when the opponent declares an attack on one of your monsters: you pick the target.
  E['Patrician of Darkness'] = {
    quick: {
      label: 'choose the attack target',
      repeat: true,
      can: (e, _c, p, t) => {
        const b = e.state.battle;
        if (t !== 'attack' || !b || b.target === null) return false;
        const a = e.fieldCard(b.attacker);
        return !!a && e.controller(a.uid) === other(p) && e.legalTargets(other(p), a).length > 1;
      },
      *run(e, _c, p) {
        const b = e.state.battle;
        const a = b ? e.fieldCard(b.attacker) : null;
        if (!b || !a || b.target === null) return;
        const t = yield* pickOne(e, p, `Patrician of Darkness: ${a.name} attacks which of your monsters?`, e.legalTargets(other(p), a));
        if (!t || !e.state.battle) return;
        e.state.battle.target = t.uid;
        e.log(p, `Patrician of Darkness: ${a.name} attacks ${label(t)}`);
      },
    },
  };

  E['Pitch-Black Warwolf'] = {
    locksActivation: (e, _m, ctl, p, kind) => kind === 'trap' && p !== ctl && e.state.phase === 'BP',
  };

  const wyvernTargets = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => canSS(e, c) && named(e, c, 'Red-Eyes') && !e.isNamed(c, 'Red-Eyes B. Chick') && !e.isNamed(c, 'Red-Eyes Wyvern'));
  E['Red-Eyes Wyvern'] = {
    *onEndPhaseInGrave(e, card, p) {
      if (e.state.turnPlayer !== p || e.player(p).normalSummoned || !freeMZ(e, p) || !wyvernTargets(e, p).length) return;
      if (!(yield* e.yesno(p, 'Red-Eyes Wyvern: banish it from your GY to Special Summon 1 "Red-Eyes" monster from your GY?'))) return;
      e.banish(card.uid);
      yield* summonOneOf(e, p, 'Red-Eyes Wyvern: Special Summon which "Red-Eyes" monster?', wyvernTargets(e, p));
    },
  };

  const darkInGy = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && attrOf(e, c) === 'DARK');
  E['Strike Ninja'] = {
    quick: {
      label: 'banish 2 DARK monsters from your GY: banish it until the End Phase',
      can: (e, c, p) => e.oncePerTurn('Strike Ninja', p) && !!e.fieldCard(c.uid)?.faceUp && darkInGy(e, p).filter((x) => x.uid !== c.uid).length >= 2,
      *cost(e, c, p) {
        const two = yield* pick(e, p, 'Strike Ninja: banish which 2 DARK monsters from your GY?', darkInGy(e, p).filter((x) => x.uid !== c.uid), 2, 2, true);
        if (!two) return false;
        e.useOnce('Strike Ninja', p);
        for (const x of two) e.banish(x.uid);
      },
      *run(e, c, p) {
        const m = e.fieldCard(c.uid);
        if (!m || !m.faceUp) return;
        const pos = m.pos;
        e.banish(m.uid);
        e.returnLater(m.uid, p, pos, e.state.turn, 'EP');
      },
    },
  };

  E['The Trojan Horse'] = {
    tributeFor: (e, _m, _p, monster, need) => need === 2 && attrOf(e, monster) === 'EARTH',
  };

  // The die roll is used when the opponent's effect targeting it is activated.
  E['Vilepawn Archfiend'] = {
    *onStandby(e, m, p) {
      if (e.state.turnPlayer !== p) return;
      if (e.player(p).lp > 500) e.payLp(p, 500);
      else yield* e.destroy([m.uid]);
    },
    quick: {
      label: 'roll a die against the effect targeting it',
      repeat: true,
      can: (_e, c, p, t, ctx) => (t === 'spell' || t === 'trap' || t === 'effect') && !!ctx.link && ctx.link.player === other(p) && !ctx.link.negated && ctx.link.targetUid === c.uid,
      *run(e, _c, p, link) {
        const target = respondedTo(link);
        if (!target) return;
        const n = yield* e.rollDie(p, (v) => v === 3);
        e.log(p, `Vilepawn Archfiend rolls a ${n}`);
        if (n !== 3) return;
        target.negated = true;
        e.log(p, `${target.card.name}'s effect is negated`);
        if (e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
      },
    },
    guardsFromAttack: (e, src, target) => target.uid !== src.uid && target.faceUp && named(e, target, 'Archfiend') && !e.isNamed(target, 'Vilepawn Archfiend'),
  };

  // ===================== Fusion Monsters =====================
  E["Alligator's Sword Dragon"] = {
    directAttack: (e, _m, p) => {
      const up = faceUpMonsters(e, other(p));
      return up.length > 0 && up.every((x) => ['EARTH', 'WATER', 'FIRE'].includes(attrOf(e, x)));
    },
  };

  // Banishing monsters from the GY as Fusion Material is not supported by the Fusion Spells here.
  const gaiaCards = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => (isSpell(e, c) || isTrap(e, c)) && info(e, c).desc.includes('"Gaia the Dragon Champion"'));
  E['Curse of Dragon, the Magical Knight Dragon'] = {
    *onSpecialSummon(e, m, p) {
      if (!m.tags?.ssExtra || !e.oncePerTurn(m.name, p) || !gaiaCards(e, p).length) return;
      if (!(yield* e.yesno(p, 'Curse of Dragon: add 1 Spell/Trap that mentions "Gaia the Dragon Champion" from your GY to your hand?'))) return;
      const c = yield* pickOne(e, p, 'Add which card?', gaiaCards(e, p));
      if (!c) return;
      e.useOnce(m.name, p);
      e.toHandOf(c.uid, p);
      e.log(p, `${e.player(p).name} adds ${c.name} to the hand`);
    },
  };

  /** Neos Contact Fusions: Special Summoned from the Extra Deck by shuffling the materials you control into the Deck; back to the Extra Deck in the End Phase. */
  function neosContact(partner: string, extra: Partial<EffectDef>): EffectDef {
    const mats = ['Elemental HERO Neos', partner];
    const have = (e: Engine, p: Pid) => mats.every((n) => e.monsters(p).some((m) => m.name === n));
    return {
      cannotSpecial: (e, c, _p, from) => from !== null && e.state.fx.contactSummon !== c.uid,
      quick: {
        from: 'extra',
        label: 'Contact Fusion (shuffle the materials into the Deck)',
        repeat: true,
        can: (e, _c, p, t) => t === 'main' && have(e, p),
        *run(e, c, p) {
          if (zoneOf(e, c.uid) !== 'fusion' || !have(e, p)) return;
          for (const n of mats) {
            const m = yield* pickOne(e, p, `${c.name}: shuffle which ${n} into the Deck?`, e.monsters(p).filter((x) => x.name === n));
            if (!m) return;
            toDeck(e, m.uid);
          }
          e.state.fx.contactSummon = c.uid;
          try {
            yield* e.specialSummon(c.uid, p, 'atk');
          } finally {
            e.state.fx.contactSummon = undefined;
          }
          if (e.fieldCard(c.uid)) e.log(p, `${e.player(p).name} Contact Fuses into ${c.name}!`);
        },
      },
      *onEndPhase(e, m) {
        if (!e.fieldCard(m.uid)) return;
        e.log(e.controller(m.uid), `${m.name} is shuffled into the Extra Deck`);
        toExtra(e, m.uid);
      },
      ...extra,
    };
  }
  E['Elemental HERO Aqua Neos'] = neosContact('Neo-Spacian Aqua Dolphin', {
    ignition: {
      can: (e, _m, p) => e.player(p).hand.length > 0 && e.player(other(p)).hand.length > 0,
      *run(e, _m, p) {
        if (!(yield* discardCost(e, p, 1))) return;
        const hand = e.player(other(p)).hand;
        if (!hand.length) return;
        const c = hand[Math.floor(e.rand() * hand.length)];
        e.log(p, `Aqua Neos destroys ${c.name} from ${e.player(other(p)).name}'s hand`);
        yield* e.sendToGrave(c.uid, 'destroyed');
      },
    },
  });
  E['Elemental HERO Grand Neos'] = neosContact('Neo-Spacian Grand Mole', {
    ignition: {
      can: (e, _m, p) => targetable(e, e.monsters(other(p))).length > 0,
      *run(e, _m, p) {
        const t = yield* pickOne(e, p, 'Grand Neos: return which monster to the hand?', targetable(e, e.monsters(other(p))));
        if (!t) return;
        e.log(p, `Grand Neos returns ${label(t)} to the hand`);
        bounceMonster(e, t);
      },
    },
  });

  // The ATK/DEF swap is offered when the battle starts; it is undone after the battle.
  const unswap = (e: Engine, t: FieldCard | null) => {
    if (!t || !e.fieldCard(t.uid) || !t.tags?.sgSwap) return;
    t.atkMod -= t.tags.sgAtk ?? 0;
    t.defMod -= t.tags.sgDef ?? 0;
    t.tags.sgSwap = 0;
  };
  E['Fossil Dragon Skullgios'] = {
    cannotSpecial: (e, _c, _p, from) => from === 'fusion' && !resolvingIs(e, 'Fossil Fusion'),
    piercing: true,
    quick: {
      label: "switch the opponent's monster's ATK and DEF",
      repeat: true,
      can: (e, c, p, t) => {
        const foe = battlePartner(e, c.uid);
        return t === 'attack' && !!foe && foe.faceUp && e.controller(foe.uid) === other(p) && !foe.tags?.sgSwap;
      },
      *run(e, c, p) {
        const foe = battlePartner(e, c.uid);
        if (!foe || !foe.faceUp || e.controller(foe.uid) !== other(p) || foe.tags?.sgSwap) return;
        const a = e.atkOf(foe);
        const d = e.defOf(foe);
        foe.atkMod += d - a;
        foe.defMod += a - d;
        Object.assign(tag(foe), { sgSwap: 1, sgAtk: d - a, sgDef: a - d });
        e.log(p, `Skullgios switches ${foe.name}'s ATK and DEF (${e.atkOf(foe)}/${e.defOf(foe)})`);
      },
    },
    *onBattleDamage(e, a, p) {
      const dealt = ((e.state.fx.hurt ?? [0, 0]) as number[])[other(p)];
      const foe = e.state.battle?.target != null ? e.fieldCard(e.state.battle.target) : null;
      if (a.tags?.ssExtra && foe && dealt > 0 && e.state.winner === null) {
        e.log(p, 'Skullgios doubles the battle damage');
        e.damage(other(p), dealt);
      }
    },
    *afterBattle(e, _a, t) {
      unswap(e, t);
    },
    *onBeingAttacked(e, m, _a, p) {
      tag(m).sgLp = e.player(other(p)).lp;
    },
    *onAttacked(e, m, attacker, p) {
      unswap(e, attacker);
      const lost = (m.tags?.sgLp ?? 0) - e.player(other(p)).lp;
      if (m.tags?.ssExtra && lost > 0 && e.state.winner === null) {
        e.log(p, 'Skullgios doubles the battle damage');
        e.damage(other(p), lost);
      }
    },
  };

  E['UFOroid Fighter'] = {
    baseStats: (e, m) => {
      const mats = fusionMats(e)[m.uid];
      if (!mats) return { atk: 0, def: 0 };
      const sum = mats.reduce((s, u) => s + Math.max(0, info(e, e.find(u)?.card.name ?? '').atk ?? 0), 0);
      return { atk: sum, def: sum };
    },
  };

  // ===================== Spells =====================
  // "All Fusion Monsters you control are also treated as Frightfur monsters" cannot change card names here.
  const frightfurExtra = (e: Engine, p: Pid) => e.player(p).fusion.filter((c) => named(e, c, 'Frightfur'));
  E['Frightfur Sanctuary'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    // "All Fusion Monsters you control are also treated as "Frightfur" monsters."
    addsNames: (e, _src, srcController, target) => (e.controller(target.uid) === srcController && isFusion(e, target) ? ['Frightfur'] : undefined),
    *resolve() {},
    activateCost: {
      can: (e, c, p) => e.player(p).hand.some((x) => x.uid !== c.uid) && frightfurExtra(e, p).length >= 2,
      *pay(e, c, p) {
        const two = yield* pick(e, p, 'Frightfur Sanctuary: send which 2 "Frightfur" monsters from your Extra Deck to the GY?', frightfurExtra(e, p), 2, 2, true);
        if (!two) return false;
        if (!(yield* discardCost(e, p, 1, () => true, c.uid))) return false;
        for (const x of two) yield* e.sendToGrave(x.uid, 'cost');
      },
    },
    *onSentToGrave(e, _card, p) {
      const list = e.player(p).gy.filter((c) => isFusion(e, c) && named(e, c, 'Frightfur'));
      if (!list.length || !(yield* e.yesno(p, 'Frightfur Sanctuary: return 1 "Frightfur" Fusion Monster from your GY to the Extra Deck?'))) return;
      const c = yield* pickOne(e, p, 'Return which Frightfur Fusion Monster?', list);
      if (c) toExtra(e, c.uid);
    },
  };

  E['Scroll of Bewitchment'] = {
    canActivate: (e, _c, _p, t) => isMain(t) && faceUpMonsters(e).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Equip Scroll of Bewitchment to which monster?', targetable(e, faceUpMonsters(e)), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const host = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      const eq = e.fieldCard(link.card.uid);
      if (!host || !eq || !host.faceUp) return;
      h.attachTo(e, eq, host.uid);
      const k = yield* chooseOption(e, p, 'Scroll of Bewitchment: select 1 Attribute', ATTRS);
      const attr = ATTRS[k ?? 0];
      (e.state.fx.declAttr ??= {})[host.uid] = attr;
      e.log(p, `${host.name} becomes ${attr}`);
    },
    *onLeaveField(e, fc) {
      if (fc.equippedTo !== undefined && e.state.fx.declAttr) delete e.state.fx.declAttr[fc.equippedTo];
    },
  };

  E['Light Barrier'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    *onStandby(e, fc, p) {
      if (e.state.turnPlayer !== p) return;
      const heads = coin(e, p, 'Light Barrier');
      tag(fc).lbOff = heads ? 0 : 1;
      if (!heads) e.log(p, "Light Barrier's effects are negated until your next Standby Phase");
    },
    *afterAnyBattle(e, fc, p, attacker, target) {
      if (fc.tags?.lbOff) return;
      const mineAttacks = e.state.turnPlayer === p;
      const arcana = mineAttacks ? attacker : target;
      const victim = mineAttacks ? target : attacker;
      if (!named(e, arcana, 'Arcana Force') || e.fieldCard(victim.uid) || e.find(victim.uid)?.loc.player !== other(p)) return;
      const gain = info(e, victim).atk ?? 0;
      if (gain > 0) e.gainLp(p, gain);
    },
  };

  // Both Heraldic Beasts are Special Summoned, then an Xyz Monster is Xyz Summoned with exactly those 2 (when one fits them).
  const heraldic = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => canSS(e, c) && named(e, c, 'Heraldic Beast'));
  /** Xyz Monsters in the Extra Deck that 2 given face-up monsters can be the only materials of. */
  const xyzFor = (e: Engine, p: Pid, mats: FieldCard[]) =>
    e.player(p).fusion.filter((x) => {
      const req = extraReq(e, x.name);
      if (!req || req.kind !== 'Xyz' || req.min > mats.length || req.max < mats.length || e.summonBlocked(p, x, 'special', 'fusion')) return false;
      return mats.every((m) => m.faceUp && !m.token && levelOf(e, m) === req.level && fits(e, m, req.qual));
    });
  E['Advanced Heraldry Art'] = {
    canActivate: (e, _c, p, t) => isMain(t) && heraldic(e, p).length >= 2 && e.player(p).mz.filter((z) => z === null).length >= 2,
    *activate(e, link, p) {
      const two = yield* pick(e, p, 'Advanced Heraldry Art: target 2 "Heraldic Beast" monsters in your GY', heraldic(e, p), 2, 2, true);
      if (!two) return false;
      link.payload = two.map((c) => c.uid);
    },
    *resolve(e, link, p) {
      const uids = (link.payload as number[]).filter((u) => zoneOf(e, u) === 'gy');
      if (uids.length < 2 || e.player(p).mz.filter((z) => z === null).length < 2) return;
      for (const u of uids) yield* e.specialSummon(u, p, 'atk');
      // "Immediately after this card resolves, Xyz Summon 1 Xyz Monster using those 2 monsters only."
      const mats = uids.map((u) => e.fieldCard(u)).filter((m): m is FieldCard => !!m && e.controller(m.uid) === p);
      if (mats.length < 2) return;
      const xyz = yield* pickOne(e, p, 'Advanced Heraldry Art: Xyz Summon which monster using those 2?', xyzFor(e, p, mats));
      if (xyz) yield* e.extraSummon(p, xyz.uid, mats.map((m) => m.uid), 'Xyz');
    },
  };

  const terrorkings = (e: Engine, p: Pid, except = -1) => faceUpMonsters(e, p).filter((m) => e.isNamed(m, 'Terrorking Archfiend') && m.uid !== except);
  E['Checkmate'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.monsters(p).some((m) => m.faceUp && named(e, m, 'Archfiend') && terrorkings(e, p, m.uid).length > 0),
    *activate(e, _l, p) {
      return yield* tributeCost(e, p, 1, (m) => m.faceUp && named(e, m, 'Archfiend') && terrorkings(e, p, m.uid).length > 0);
    },
    *resolve(e, _l, p) {
      const t = yield* pickOne(e, p, 'Checkmate: which Terrorking Archfiend can attack directly?', terrorkings(e, p));
      if (!t) return;
      tag(t).directTurn = e.state.turn;
      e.log(p, `${t.name} can attack directly this turn`);
    },
  };

  const recoverPairs = (e: Engine, p: Pid) => {
    const used = usedAsMaterial(e);
    return { polys: e.player(p).gy.filter((c) => e.isNamed(c, 'Polymerization')), mats: e.player(p).gy.filter((c) => isMonster(e, c) && used.has(c.uid)) };
  };
  E['Fusion Recovery'] = {
    canActivate: (e, _c, p, t) => isMain(t) && recoverPairs(e, p).polys.length > 0 && recoverPairs(e, p).mats.length > 0,
    *activate(e, link, p) {
      const poly = yield* pickOne(e, p, 'Fusion Recovery: target which "Polymerization"?', recoverPairs(e, p).polys, true);
      if (!poly) return false;
      const mat = yield* pickOne(e, p, 'Fusion Recovery: target which Fusion Material monster?', recoverPairs(e, p).mats, true);
      if (!mat) return false;
      link.payload = [poly.uid, mat.uid];
    },
    *resolve(e, link, p) {
      for (const u of link.payload as number[]) {
        if (zoneOf(e, u) !== 'gy') continue;
        e.toHandOf(u, p);
        e.log(p, `${e.player(p).name} adds ${e.find(u)?.card.name} to the hand`);
      }
    },
  };

  // Tributing the opponent's monster "as if you controlled it": you control it until the End Phase (and cannot battle anyway).
  E['Soul Exchange'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.state.phase === 'M1' && freeMZ(e, p) && targetable(e, e.monsters(other(p))).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Soul Exchange: target which monster?', targetable(e, e.monsters(other(p))), true);
      if (!m) return false;
      link.targetUid = m.uid;
      // "You cannot conduct your Battle Phase the turn you activate this card" (even if it is negated).
      ((e.state.fx.noDeclare ??= [-1, -1]) as number[])[p] = e.state.turn;
    },
    *resolve(e, link, p) {
      ((e.state.fx.noDeclare ??= [-1, -1]) as number[])[p] = e.state.turn;
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (m && e.controller(m.uid) === other(p) && e.takeControl(m.uid, p)) {
        m.returnAtEnd = other(p);
        e.log(p, `Soul Exchange: ${e.player(p).name} may Tribute ${label(m)} this turn`);
      }
      for (const x of e.monsters(p)) tag(x).noAttackTurn = e.state.turn;
    },
  };

  // "At the start of the Battle Phase": usable at the end of your Main Phase 1, or (either player's turn) when the first attack
  // of the Battle Phase is declared. Nothing can be activated in response to it; once it resolves, no Spell/Trap Card can be
  // activated this turn, and neither can the Quick Effects of Spells/Traps (fx.noTrapTurn, plus a name lock on every Spell).
  E['Anti-Magic Arrows'] = {
    canActivate: (e, _c, p, t) => (isMain(t) && e.state.turnPlayer === p && e.state.phase === 'M1' && !e.state.firstTurn) || (t === 'attack' && e.state.phase === 'BP' && e.state.attackedThisTurn.length === 1),
    *activate(e, link, p) {
      link.payload = { noResponse: true };
      // engine.responseWindow only checks noResponse when a window opens: when this card is itself activated as a response (at the
      // first attack), the window it was activated in stays open. Nothing can stop it from resolving, so the Spell/Trap lock it
      // applies is put in place now, which keeps Spells/Traps from being activated in response to it.
      arrowsLock(e, p, false);
    },
    *resolve(e, _l, p) {
      arrowsLock(e, p, true);
    },
  };
  function arrowsLock(e: Engine, p: Pid, say: boolean) {
      const turn = e.state.turn;
      e.state.fx.stLockTurn = turn;
      e.state.fx.noTrapTurn = [turn, turn];
      const locks = ((e.state.fx.turnNameLocks ??= []) as { p: Pid; name: string; turn: number }[]).filter((x) => x.turn === turn);
      const spells = new Set<string>();
      for (const q of [0, 1] as Pid[]) {
        const ps = e.player(q);
        for (const c of [...ps.deck, ...ps.hand, ...ps.gy, ...ps.removed, ...stOf(e, q)]) if (isSpell(e, c)) spells.add(c.name);
      }
      for (const q of [0, 1] as Pid[]) for (const name of spells) locks.push({ p: q, name, turn });
      e.state.fx.turnNameLocks = locks;
      if (say) e.log(p, 'Anti-Magic Arrows: Spell/Trap Cards and their effects cannot be activated for the rest of this turn');
  }

  E['Half Shut'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && targetable(e, faceUpMonsters(e)).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Half Shut: target which monster?', targetable(e, faceUpMonsters(e)), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || !m.faceUp) return;
      tag(m).battleSafeTurn = e.state.turn;
      const atk = e.atkOf(m);
      boostTurn(m, Math.floor(atk / 2) - atk);
      e.log(p, `${m.name} cannot be destroyed by battle this turn; its ATK is halved (${e.atkOf(m)})`);
    },
  };

  // ===================== Traps =====================
  const numbers = (e: Engine, p: Pid) => faceUpMonsters(e, p).filter((m) => named(e, m, 'Number'));
  E['Number Wall'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && numbers(e, p).length > 0,
    *resolve() {},
    shields: (e, _src, target, how) => {
      if (!target.faceUp || !named(e, target, 'Number')) return false;
      if (how === 'effect') return true;
      if (how !== 'battle') return false;
      const foe = battlePartner(e, target.uid);
      return !foe || !named(e, foe, 'Number');
    },
    *onAnyToGrave(e, fc, p, events) {
      if (!events.some((v) => v.from === 'mz' && v.controller === p && v.reason === 'destroyed' && named(e, v.card, 'Number')) || !e.fieldCard(fc.uid)) return;
      e.log(p, 'Number Wall is destroyed (a "Number" monster was destroyed)');
      yield* e.destroy([fc.uid]);
    },
  };

  const upsetTargets = (e: Engine) => [...e.monsters(0), ...e.monsters(1)].filter((m) => ssTagged(m) && levelOf(e, m) >= 7);
  const upsetCost = (m: FieldCard, e: Engine) => m.faceUp && m.pos === 'atk' && levelOf(e, m) > 0 && levelOf(e, m) <= 2;
  E['A Major Upset'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.monsters(p).some((m) => upsetCost(m, e)) && upsetTargets(e).length > 0,
    *activate(e, _l, p) {
      return yield* tributeCost(e, p, 1, (m) => upsetCost(m, e));
    },
    *resolve(e, _l, p) {
      const list = upsetTargets(e);
      if (!list.length) return;
      e.log(p, `A Major Upset returns ${list.map((m) => label(m)).join(', ')} to the hand`);
      for (const m of list) bounceMonster(e, m);
    },
  };

  /** The other zones in this Spell/Trap Zone's column: your Monster Zone, and the opponent's facing Monster and Spell/Trap Zones. */
  const column = (e: Engine, fc: Card) => {
    const f = e.find(fc.uid);
    if (!f || f.loc.zone !== 'sz') return null;
    const p = f.loc.player;
    const n = e.player(p).sz.length;
    const j = e.player(other(p)).mz.length - 1 - f.loc.index;
    return [e.player(p).mz[f.loc.index] ?? null, e.player(other(p)).mz[j] ?? null, e.player(other(p)).sz[n - 1 - f.loc.index] ?? null];
  };
  E['Blasting Fuse'] = {
    canActivate: (e, c, _p, t) => anyTime(t) && !!column(e, c)?.every((x) => !!x),
    *resolve(e, link, p) {
      const cards = (column(e, link.card) ?? []).filter((x): x is FieldCard => !!x);
      if (!cards.length) return;
      e.log(p, `Blasting Fuse destroys ${cards.map((x) => label(x)).join(', ')}`);
      yield* e.destroy(cards.map((x) => x.uid));
    },
  };

  // The materials the engine records: Fusion (fx.fusionMatList), Ritual (fx.ritualMats), Synchro/Link (fx.extraMats, by name),
  // Xyz (the Xyz Materials still attached to it).
  const derbyNormal = (e: Engine, c: Card | string) => isMonster(e, typeof c === 'string' ? { uid: -1, name: c, owner: 0 } : c) && info(e, c).sub === 'Normal';
  const derbyReady = (e: Engine, p: Pid) =>
    faceUpMonsters(e, p).some((m) => {
      const fx = e.state.fx;
      const ids = [...(m.tags?.ssExtra ? fusionMats(e)[m.uid] ?? [] : []), ...((fx.ritualMats as Record<number, { mats: number[] }> | undefined)?.[m.uid]?.mats ?? [])];
      if (ids.some((u) => {
        const f = e.find(u);
        return !!f && derbyNormal(e, f.card);
      })) return true;
      if ((m.tags?.synS || m.tags?.linkS) && ((fx.extraMats as Record<number, string[]> | undefined)?.[m.uid] ?? []).some((n) => derbyNormal(e, n))) return true;
      return !!m.tags?.xyzS && e.matsOf(m).some((c) => derbyNormal(e, c));
    });
  const derbyTargets = (e: Engine) => [...targetable(e, [...e.monsters(0), ...e.monsters(1)]), ...stOf(e, 0), ...stOf(e, 1)];
  E['D.D.D. - Different Dimension Derby'] = {
    canActivate: (e, c, p, t) => anyTime(t) && derbyReady(e, p) && derbyTargets(e).some((x) => x.uid !== c.uid),
    *activate(e, link, p) {
      const t = yield* pickOne(e, p, 'D.D.D. - Different Dimension Derby: banish which card?', derbyTargets(e).filter((x) => x.uid !== link.card.uid), true);
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link, p) {
      const t = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!t) return;
      e.log(p, `D.D.D. - Different Dimension Derby banishes ${label(t)}`);
      if (t.token) yield* e.sendToGrave(t.uid, 'used');
      else e.banish(t.uid);
    },
  };

  const frightfurMine = (e: Engine, p: Pid) => faceUpMonsters(e, p).filter((m) => isFusion(e, m) && named(e, m, 'Frightfur'));
  const fusionTheirs = (e: Engine, p: Pid) => targetable(e, faceUpMonsters(e, other(p)).filter((m) => isFusion(e, m)));
  E['Fusion Fright Waltz'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && targetable(e, frightfurMine(e, p)).length > 0 && fusionTheirs(e, p).length > 0,
    *activate(e, link, p) {
      const a = yield* pickOne(e, p, 'Fusion Fright Waltz: target your "Frightfur" Fusion Monster', targetable(e, frightfurMine(e, p)), true);
      if (!a) return false;
      const b = yield* pickOne(e, p, "Fusion Fright Waltz: target your opponent's Fusion Monster", fusionTheirs(e, p), true);
      if (!b) return false;
      link.payload = [a.uid, b.uid];
    },
    *resolve(e, link, p) {
      const targets = link.payload as number[];
      const doomed = [...e.monsters(0), ...e.monsters(1)].filter((m) => ssTagged(m) && !targets.includes(m.uid));
      const owners = new Map(doomed.map((m) => [m.uid, e.controller(m.uid)!]));
      yield* e.destroy(doomed.map((m) => m.uid));
      const hit = new Set<Pid>();
      for (const [uid, q] of owners) if (!e.fieldCard(uid)) hit.add(q);
      const dmg = targets.reduce((s, u) => {
        const m = e.fieldCard(u);
        return s + (m && m.faceUp ? e.atkOf(m) : 0);
      }, 0);
      for (const q of [p, other(p)] as Pid[]) if (hit.has(q) && dmg > 0 && e.state.winner === null) e.damage(q, dmg);
    },
  };

  const lostWindTargets = (e: Engine) => targetable(e, faceUpMonsters(e).filter(ssTagged));
  E['Lost Wind'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && lostWindTargets(e).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Lost Wind: target which Special Summoned monster?', lostWindTargets(e), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || !m.faceUp) return;
      negateMonster(e, m, false);
      const orig = e.baseStats(m).atk;
      boostPerm(m, Math.floor(orig / 2) - orig);
    },
    quick: {
      from: 'gy',
      label: 'Set this card (a monster was Special Summoned from the Extra Deck)',
      can: (e, _c, p, t, ctx) => {
        if (t !== 'special' || ctx.uid === undefined || freeST(e, p) < 0) return false;
        const m = e.fieldCard(ctx.uid);
        return !!m && m.owner === other(p) && !!m.tags?.ssExtra;
      },
      *run(e, c, p) {
        if (zoneOf(e, c.uid) === 'gy') setFromPile(e, c.uid, p, false, { lwBanish: 1 });
      },
    },
    *onLeaveField(e, fc) {
      if (!fc.tags?.lwBanish) return;
      const z = zoneOf(e, fc.uid);
      if (z && z !== 'removed' && z !== 'sz' && z !== 'mz' && z !== 'field') e.banish(fc.uid);
    },
  };

  E["Pikeru's Circle of Enchantment"] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve(e, _l, p) {
      ((e.state.fx.noEffectDamage ??= [-1, -1]) as number[])[p] = e.state.turn;
      e.log(p, `${e.player(p).name} takes no damage from card effects this turn`);
    },
  };

  // "When ... is destroyed": can be activated for the rest of that turn.
  const deityPool = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.player(p).deck].filter((c) => e.isNamed(c, 'Vennominaga the Deity of Poisonous Snakes'));
  E['Rise of the Snake Deity'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && freeMZ(e, p) && deityPool(e, p).length > 0 && destroyedLog(e).some((x) => x.controller === p && x.faceUp && !x.byBattle && e.isNamed(x, 'Vennominon the King of Poisonous Snakes')),
    *resolve(e, _l, p) {
      yield* summonOneOf(e, p, 'Rise of the Snake Deity: Special Summon which monster?', deityPool(e, p));
    },
  };
}
