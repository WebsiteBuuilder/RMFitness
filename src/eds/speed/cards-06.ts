// Speed Duel card scripts, batch 06 (Galaxy-Eyes Cloudragon ... Jinzo - Lord).
import type { EffectDef } from '../effects';
import { nameEngine } from '../names';
import type { SpeedHelpers } from './helpers';
import {
  allMonsters,
  allST,
  anyTime,
  boostPerm,
  boostTurn,
  chooseOption,
  ctrl,
  deckToGrave,
  discardCost,
  faceUpMonsters,
  freeMZ,
  fromGraveToHand,
  info,
  isMain,
  isMonster,
  isNormalMonster,
  isSpell,
  isTrap,
  levelOf,
  millTop,
  named,
  negateLink,
  negateMonster,
  noBattleDamage,
  opponentAttack,
  opponentSummon,
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
  tributeCost,
  attrOf,
} from './helpers';
import type { Card, ChainLink, Engine, FieldCard, Pid, Step } from './helpers';

// ---------- local helpers ----------
const GK = "Gravekeeper's";
const isGK = (c: Card | string) => named(nameEngine(), c, GK);
const EXTRA_SUBS = ['Fusion', 'Ritual', 'Xyz', 'Synchro', 'Link'];
/** Monsters that live in the Extra Deck. */
const EXTRA_DECK = ['Fusion', 'Xyz', 'Synchro', 'Link'];
/** A monster that can be Special Summoned from the Deck/hand/GY by a plain effect (no Extra Deck or Ritual monsters). */
const mainMonster = (e: Engine, c: Card) => isMonster(e, c) && !EXTRA_SUBS.includes(info(e, c).sub);
const atkInfo = (e: Engine, c: Card) => Math.max(0, info(e, c).atk ?? 0);
/** spells-d: an Effect Monster (not a Normal Monster, a Fusion/Ritual Monster with no effect, a Token, or a Trap Monster "treated as a Normal Monster"). */
const isEffectMonster = (e: Engine, c: Card) => {
  const i = info(e, c);
  if (i.kind === 'trap') return /as an Effect Monster/i.test(i.desc);
  return i.kind === 'monster' && i.sub !== 'Normal' && !i.vanilla && !c.token;
};
const defInfo = (e: Engine, c: Card) => Math.max(0, info(e, c).def ?? 0);
/** A card named "Harpie Lady" right now: always (Cyber Harpie Lady, Harpie Lady 1-3) or on the field/GY (Harpie Queen...). */
const isHarpieLady = (c: Card | string) => nameEngine().isNamed(c, 'Harpie Lady');
const fieldFaceUp = (e: Engine) => [0, 1].some((q) => !!e.player(q as Pid).field?.faceUp);
/** "Necrovalley" on the field: the real card, or Gravekeeper's Priestess while there is no face-up Field Spell. */
const necro = (e: Engine) => !!e.anyActive('Necrovalley') || (!fieldFaceUp(e) && faceUpMonsters(e).some((m) => e.isNamed(m, "Gravekeeper's Priestess") && !e.isNegated(m)));
const fx = <T>(e: Engine, key: string, init: T): T => (e.state.fx[key] ??= init) as T;
/** Moves cards out of a GY with an effect that is unaffected by Necrovalley (engine.graveLocked reads fx.graveFree). */
function necroFree(e: Engine, move: () => void) {
  e.state.fx.graveFree = true;
  try {
    move();
  } finally {
    e.state.fx.graveFree = undefined;
  }
}

/** Returns a monster on the field to the hand (Tokens vanish, Fusion Monsters go back to the Extra Deck). */
function* bounce(e: Engine, uid: number): Step {
  const m = e.fieldCard(uid);
  if (!m) return;
  if (m.token) {
    yield* e.sendToGrave(uid, 'used');
    return;
  }
  for (const eq of m.equips.slice()) yield* e.sendToGrave(eq, 'used');
  if (m.equippedTo !== undefined) {
    const host = e.fieldCard(m.equippedTo);
    if (host) host.equips = host.equips.filter((u) => u !== uid);
  }
  e.toHand(uid);
  const owner = m.owner;
  if (EXTRA_DECK.includes(info(e, m).sub)) {
    const ps = e.player(owner);
    const i = ps.hand.findIndex((c) => c.uid === uid);
    if (i >= 0) ps.fusion.push(ps.hand.splice(i, 1)[0]);
  }
  e.log(owner, `${m.name} returns to the hand`);
}
/** Returns a Spell/Trap on the field to the hand ("leaves the field" effects still apply). */
function* returnST(e: Engine, uid: number): Step {
  const fc = e.fieldCard(uid);
  if (!fc) return;
  const p = ctrl(e, fc);
  if (fc.equippedTo !== undefined) {
    const host = e.fieldCard(fc.equippedTo);
    if (host) host.equips = host.equips.filter((u) => u !== uid);
  }
  // e.toHand runs its "leaves the field" effect itself (engine.flushLeaves).
  e.toHand(uid);
  e.log(p, `${fc.name} returns to the hand`);
}
/** "Must be Special Summoned (from your hand) by ... and cannot be Special Summoned by other ways": until it was properly Summoned once (then it can be revived). */
const nomi = (): Partial<EffectDef> => ({
  cannotNormalSummon: true,
  // Approximation: only Summons by a resolving card effect are refused (engine-level placements are not checked).
  cannotSpecial: (e, c, _p, from) => from !== null && !!e.resolvingCard() && !fx<Record<number, number>>(e, 'properSummon', {})[c.uid],
});
/** Its own Summon procedure from the hand (remembers the monster was properly Summoned). */
function* procSummon(e: Engine, c: Card, p: Pid, pos: 'atk' | 'def' = 'atk'): Step {
  yield* e.specialSummon(c.uid, p, pos);
  if (e.fieldCard(c.uid)) fx<Record<number, number>>(e, 'properSummon', {})[c.uid] = 1;
}
/** "If this card destroys a monster by battle" (it does not have to be sent to the GY; this card must still be on the field). */
function battleKill(fn: (e: Engine, me: FieldCard, victim: Card, p: Pid) => Step): Partial<EffectDef> {
  return {
    *afterBattle(e, a, t, p, destroyed) {
      const f = t && destroyed ? e.find(t.uid) : null;
      if (f && f.loc.zone !== 'mz' && e.fieldCard(a.uid)) yield* fn(e, a, f.card, p);
    },
    *onAttacked(e, me, attacker, p) {
      const f = e.find(attacker.uid);
      if (f && f.loc.zone !== 'mz' && e.fieldCard(me.uid)) yield* fn(e, me, f.card, p);
    },
  };
}
/** Card names a player can declare (every card both players brought to the Duel). */
const declarable = (e: Engine) => [...new Set([0, 1].flatMap((q) => { const ps = e.player(q as Pid); return [...ps.deck, ...ps.hand, ...ps.gy, ...ps.removed, ...ps.fusion, ...e.monsters(q as Pid), ...stOf(e, q as Pid)]; }).filter((c) => !c.token).map((c) => c.name))].sort();
/** Places a card on the bottom of its owner's Deck (Extra Deck monsters go back there). */
function toDeckBottom(e: Engine, uid: number) {
  const f = e.find(uid);
  if (!f) return;
  const owner = f.card.owner;
  e.toDeckTop(uid);
  const ps = e.player(owner);
  const c = ps.deck.shift();
  if (!c) return;
  if (EXTRA_DECK.includes(info(e, c).sub)) ps.fusion.push(c);
  else ps.deck.push(c);
}
/** Turns a face-up monster face-down (its Equip Cards are destroyed). */
function* setFaceDown(e: Engine, m: FieldCard): Step {
  for (const eq of m.equips.slice()) yield* e.sendToGrave(eq, 'destroyed');
  m.faceUp = false;
  m.pos = 'def';
  e.event('position', { uid: m.uid });
  e.log(null, `${m.name} is turned face-down`);
}
/** Changes a face-up monster's battle position. */
function changePos(e: Engine, m: FieldCard) {
  if (!m.faceUp) return;
  m.pos = m.pos === 'atk' ? 'def' : 'atk';
  e.event('position', { uid: m.uid });
  e.log(null, `${m.name} changes to ${m.pos === 'atk' ? 'Attack' : 'Defense'} Position`);
}
/** Special Summons 1 Dragon Normal Monster from hand, Deck or GY with its ATK/DEF made 0 (Hieratic). */
function* hieraticCall(e: Engine, p: Pid, title: string): Step {
  const ps = e.player(p);
  const list = [...ps.hand, ...ps.deck, ...ps.gy].filter((c) => isNormalMonster(e, c) && info(e, c).race === 'Dragon');
  const m = yield* summonOneOf(e, p, title, list, 'atk');
  if (m) boostPerm(m, -e.baseStats(m).atk, -e.baseStats(m).def);
}
/** "When this card destroys a monster by battle and sends it to the GY" (attacking or attacked; this card must still be on the field). */
function battleWin(fn: (e: Engine, me: FieldCard, victim: Card, p: Pid) => Step): Partial<EffectDef> {
  return {
    *afterBattle(e, a, t, p, destroyed) {
      const f = t && destroyed ? e.find(t.uid) : null;
      if (f && f.loc.zone === 'gy' && e.fieldCard(a.uid)) yield* fn(e, a, f.card, p);
    },
    *onAttacked(e, me, attacker, p) {
      const f = e.find(attacker.uid);
      if (f && f.loc.zone === 'gy' && e.fieldCard(me.uid)) yield* fn(e, me, f.card, p);
    },
  };
}
/** "Once per turn: You can change this card to face-down Defense Position." */
const flipDown: EffectDef['ignition'] = {
  can: (e, m) => m.faceUp && m.placedTurn !== e.state.turn && !m.posChanged && !m.attacked,
  *run(e, m) {
    if (m.faceUp) yield* setFaceDown(e, m);
  },
};
/** Giant Orc, Goblin Attack Force: Defense Position at the end of the Battle Phase it attacked in, locked until the End Phase of the next own turn. */
const tiresAfterAttack: EffectDef = {
  *onBattlePhaseEnd(e, m, p) {
    if (e.state.turnPlayer !== p || !e.state.attackedThisTurn.includes(m.uid) || !m.faceUp) return;
    if (m.pos === 'atk') changePos(e, m);
    m.cannotChangePos = true;
    tag(m).posLockUntil = e.state.turn + 2;
  },
  *onEndPhase(e, m) {
    const t = tag(m);
    if (t.posLockUntil !== undefined && e.state.turn >= t.posLockUntil) {
      m.cannotChangePos = false;
      delete t.posLockUntil;
    }
  },
};
/** A Gemini monster: Normal Summon it again (uses the Normal Summon) to unlock `effect`. */
const geminiOn = (e: Engine, m: FieldCard) => m.tags?.gemini === 1;
function gemini(effect?: { can(e: Engine, m: FieldCard, p: Pid): boolean; run(e: Engine, m: FieldCard, p: Pid): Step }): Partial<EffectDef> {
  return {
    ignition: {
      chain: false,
      can: (e, m, p) => (!geminiOn(e, m) ? !e.player(p).normalSummoned : !!effect && effect.can(e, m, p)),
      *run(e, m, p) {
        if (!geminiOn(e, m)) {
          e.player(p).normalSummoned = true;
          tag(m).gemini = 1;
          m.effectUsed = false;
          e.log(p, `${e.player(p).name} Normal Summons ${m.name} again: it becomes an Effect Monster`);
          return;
        }
        if (effect) yield* effect.run(e, m, p);
      },
    },
  };
}
/** Records whether a card leaving the field was destroyed by the opponent's card effect. */
const markOppDestroy: EffectDef['onLeaveField'] = function* (e, fc, controller, reason) {
  fx<Record<number, number>>(e, 'oppDestroyed', {})[fc.uid] = reason === 'destroyed' && e.actor === other(controller) ? 1 : 0;
};
const destroyedByOpp = (e: Engine, uid: number) => fx<Record<number, number>>(e, 'oppDestroyed', {})[uid] === 1;

export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  // ===================== monsters =====================
  // Its Tribute is a cost, so the effect resolves at once (chain: false: the engine skips chained ignitions whose card left the field).
  const geXyz = (e: Engine, p: Pid) => targetable(e, faceUpMonsters(e, p)).filter((m) => named(e, m, 'Galaxy-Eyes') && info(e, m).sub === 'Xyz');
  E['Galaxy-Eyes Cloudragon'] = {
    ignition: {
      chain: false,
      can: (e, m, p) => e.oncePerTurn(m.name, p) && !e.untributable(m) && [...e.player(p).hand, ...e.player(p).gy].some((c) => named(e, c, 'Galaxy-Eyes') && !e.sameName(c, m) && mainMonster(e, c)),
      *cost(e, m, p) {
        e.useOnce(m.name, p);
        e.log(p, `${e.player(p).name} Tributes ${m.name}`);
        yield* e.sendToGrave(m.uid, 'tribute');
      },
      *run(e, _m, p) {
        const ps = e.player(p);
        yield* summonOneOf(e, p, 'Galaxy-Eyes Cloudragon: Special Summon which "Galaxy-Eyes" monster?', [...ps.hand, ...ps.gy].filter((c) => named(e, c, 'Galaxy-Eyes') && !e.isNamed(c, 'Galaxy-Eyes Cloudragon') && mainMonster(e, c)));
      },
    },
    graveIgnition: {
      can: (e, c, p) => e.oncePerDuel(c.name, p) && geXyz(e, p).length > 0,
      *run(e, card, p) {
        const x = yield* pickOne(e, p, 'Galaxy-Eyes Cloudragon: attach it to which "Galaxy-Eyes" Xyz Monster?', geXyz(e, p), true);
        if (!x) return;
        e.useOncePerDuel(card.name, p);
        if (e.find(card.uid)?.loc.zone === 'gy' && e.attachMat(x, card.uid)) e.log(p, `Galaxy-Eyes Cloudragon is attached to ${x.name} as an Xyz Material`);
      },
    },
  };

  const bounceFlip = (title: string): EffectDef => ({
    *flip(e, _m, p) {
      const t = yield* pickOne(e, p, title, targetable(e, e.monsters(other(p))));
      if (t && e.fieldCard(t.uid)) yield* bounce(e, t.uid);
    },
  });
  E['Gale Lizard'] = bounceFlip('Gale Lizard: return which monster to the hand?');
  E["Gravekeeper's Guard"] = bounceFlip("Gravekeeper's Guard: return which monster to the hand?");

  E['Garuda the Wind Spirit'] = {
    ...nomi(),
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && e.player(p).gy.some((c) => isMonster(e, c) && attrOf(e, c) === 'WIND'),
      *run(e, c, p) {
        const b = yield* pickOne(e, p, 'Garuda: banish which WIND monster from your GY?', e.player(p).gy.filter((g) => isMonster(e, g) && attrOf(e, g) === 'WIND'), true);
        if (!b) return;
        e.banish(b.uid);
        if (e.find(b.uid)?.loc.zone !== 'removed') return;
        yield* procSummon(e, c, p);
      },
    },
    *onEndPhase(e, _m, p) {
      if (e.state.turnPlayer !== other(p)) return;
      const list = faceUpMonsters(e, other(p));
      if (!list.length) return;
      const t = yield* pickOne(e, p, "Garuda: change the battle position of which opponent's monster? (cancel = none)", list, true);
      if (t && e.fieldCard(t.uid)) changePos(e, t);
    },
  };

  // "During your Main Phase 1": Speed Duel has only one Main Phase. The LP are paid as the effect is activated.
  E['Gear Golem the Moving Fortress'] = {
    ignition: {
      can: (e, m, p) => e.player(p).lp > 800 && m.tags?.directTurn !== e.state.turn,
      *cost(e, _m, p) {
        return payLp(e, p, 800);
      },
      *run(e, m) {
        if (e.fieldCard(m.uid)?.faceUp) tag(m).directTurn = e.state.turn;
      },
    },
    directAttack: (e, m) => m.tags?.directTurn === e.state.turn,
  };

  // "If either player equips an Equip Card(s) to this card" is seen right after the action that equipped it (stateCheck).
  const redEyesTargets = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => mainMonster(e, c) && named(e, c, 'Red-Eyes') && levelOf(e, c) <= 7);
  E['Gearfried the Red-Eyes Iron Knight'] = {
    *stateCheck(e, m, p) {
      const seen = fx<Record<number, number[]>>(e, 'gearfriedSeen', {});
      const before = seen[m.uid] ?? [];
      const fresh = m.equips.filter((u) => !before.includes(u) && e.fieldCard(u));
      seen[m.uid] = m.equips.slice();
      if (!fresh.length || !e.oncePerTurn(`Gearfried RE:${m.uid}`, p)) return;
      if (!(yield* e.yesno(p, 'Gearfried the Red-Eyes Iron Knight: destroy the Equip Card(s) equipped to it?'))) return;
      e.useOnce(`Gearfried RE:${m.uid}`, p);
      yield* e.destroy(fresh.filter((u) => e.fieldCard(u)));
      const st = stOf(e, other(p));
      if (!st.length || !(yield* e.yesno(p, 'Gearfried: then destroy 1 Spell/Trap your opponent controls?'))) return;
      const t = yield* pickOne(e, p, 'Gearfried: destroy which Spell/Trap?', st);
      if (t && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
    },
    ignition: {
      can: (e, m, p) => m.equips.some((u) => e.controller(u) === p) && redEyesTargets(e, p).length > 0,
      *cost(e, m, p) {
        const eqs = m.equips.map((u) => e.fieldCard(u)).filter((c): c is FieldCard => !!c && e.controller(c.uid) === p);
        const eq = yield* pickOne(e, p, 'Gearfried: send which Equip Card to the GY?', eqs, true);
        if (!eq) return false;
        yield* e.sendToGrave(eq.uid, 'cost');
        const t = yield* pickOne(e, p, 'Gearfried: target which "Red-Eyes" monster in your GY?', redEyesTargets(e, p));
        if (!t) return false;
        tag(m).gearfriedTarget = t.uid;
      },
      *run(e, m, p) {
        const u = m.tags?.gearfriedTarget;
        if (u !== undefined && e.find(u)?.loc.zone === 'gy' && freeMZ(e, p)) yield* e.specialSummon(u, p, 'atk');
      },
    },
  };

  // Banishing both monsters is the cost, so the effect resolves at once (chain: false).
  const gemFusions = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => named(e, c, 'Gem-Knight') && info(e, c).sub === 'Fusion');
  E['Gem-Knight Emerald'] = {
    ignition: {
      chain: false,
      repeat: true,
      can: (e, m, p) => faceUpMonsters(e, p).some((x) => x.uid !== m.uid && isNormalMonster(e, x)) && gemFusions(e, p).length > 0,
      *cost(e, m, p) {
        const n = yield* pickOne(e, p, 'Gem-Knight Emerald: banish which Normal Monster?', faceUpMonsters(e, p).filter((x) => x.uid !== m.uid && isNormalMonster(e, x)), true);
        if (!n) return false;
        const t = yield* pickOne(e, p, 'Gem-Knight Emerald: target which "Gem-Knight" Fusion Monster?', gemFusions(e, p), true);
        if (!t) return false;
        fx<Record<number, number>>(e, 'emeraldTarget', {})[p] = t.uid;
        e.banish(m.uid);
        e.banish(n.uid);
      },
      *run(e, _m, p) {
        const u = fx<Record<number, number>>(e, 'emeraldTarget', {})[p];
        if (u !== undefined && e.find(u)?.loc.zone === 'gy' && freeMZ(e, p)) yield* e.specialSummon(u, p, 'atk');
      },
    },
  };

  // The attack it responded to is moved onto it (the replay is approximated: the attack goes on against Gentlemander).
  E['Gentlemander'] = {
    attackGuard: (e, src, srcController, attacker, target) => e.controller(attacker.uid) === other(srcController) && target.uid !== src.uid && e.controller(target.uid) === srcController,
    quick: {
      from: 'hand',
      label: 'Special Summon it',
      can: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null && freeMZ(e, p),
      *run(e, card, p) {
        if (e.find(card.uid)?.loc.zone !== 'hand' || !freeMZ(e, p)) return;
        const atk = yield* e.yesno(p, 'Gentlemander: Special Summon it in Attack Position? (No = Defense)');
        yield* e.specialSummon(card.uid, p, atk ? 'atk' : 'def');
        const b = e.state.battle;
        if (b && e.fieldCard(card.uid) && e.controller(b.attacker) === other(p)) {
          b.target = card.uid;
          e.log(p, 'The attack is redirected to Gentlemander');
        }
      },
    },
  };

  E['Ghost Knight of Jackal'] = battleWin(function* (e, _me, victim, p) {
    if (!freeMZ(e, p) || !(yield* e.yesno(p, `Ghost Knight of Jackal: Special Summon ${victim.name} to your field in Defense Position?`))) return;
    if (e.find(victim.uid)?.loc.zone === 'gy') yield* e.specialSummon(victim.uid, p, 'def');
  });

  E['Giant Orc'] = tiresAfterAttack;
  E['Goblin Attack Force'] = tiresAfterAttack;

  E['Gilasaurus'] = {
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p),
      *run(e, c, p) {
        yield* e.specialSummon(c.uid, p, 'atk');
        const q = other(p);
        const list = e.player(q).gy.filter((g) => mainMonster(e, g));
        if (!list.length || !freeMZ(e, q) || !(yield* e.yesno(q, 'Gilasaurus: Special Summon a monster from your GY?'))) return;
        yield* summonOneOf(e, q, 'Gilasaurus: Special Summon which monster?', list);
      },
    },
  };

  // The 3-Tribute Summon is a summon procedure: a real Tribute Summon (engine.tributeSummonWith) that uses your Normal Summon.
  E['Gilford the Lightning'] = {
    summonProc: {
      can: (e, c, p) => e.canNormalSummon(p, c, true) && e.monsters(p).filter((m) => !e.untributable(m)).length >= 3,
      *run(e, c, p) {
        const chosen = yield* pick(e, p, 'Gilford the Lightning: Tribute which 3 monsters?', e.monsters(p).filter((m) => !e.untributable(m)), 3, 3, true, false);
        if (!chosen) return;
        yield* e.tributeSummonWith(p, c.uid, chosen.map((m) => m.uid));
      },
    },
    *onSummon(e, m, p, kind) {
      if (kind !== 'normal' || m.tags?.tribS !== 3) return;
      e.log(p, 'Gilford the Lightning destroys all monsters the opponent controls');
      yield* e.destroy(e.monsters(other(p)).map((x) => x.uid));
    },
  };

  E['Gimmick Puppet Des Troy'] = {
    ignition: {
      can: (e, m) => !m.tags?.desTroyUsed && targetable(e, faceUpMonsters(e)).some((x) => named(e, x, 'Gimmick Puppet')),
      *cost(e, m, p) {
        const t = yield* pickOne(e, p, 'Des Troy: target which "Gimmick Puppet" monster?', targetable(e, faceUpMonsters(e)).filter((x) => named(e, x, 'Gimmick Puppet')), true);
        if (!t) return false;
        tag(m).desTroyUsed = 1;
        tag(m).desTroyTarget = t.uid;
      },
      *run(e, m) {
        const u = m.tags?.desTroyTarget;
        if (u !== undefined && e.fieldCard(u)) yield* e.destroy([u]);
      },
    },
    *onSentToGrave(e, _card, p, from) {
      if (from !== 'mz') return;
      const list = () => e.player(p).hand.filter((c) => mainMonster(e, c) && named(e, c, 'Gimmick Puppet'));
      if (!list().length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Des Troy: Special Summon "Gimmick Puppet" monsters from your hand?'))) return;
      const free = e.player(p).mz.filter((z) => z === null).length;
      const chosen = yield* pick(e, p, 'Special Summon which "Gimmick Puppet" monsters (1 or 2)?', list(), 1, Math.min(2, free));
      for (const c of chosen ?? []) if (e.find(c.uid)?.loc.zone === 'hand') yield* e.specialSummon(c.uid, p, 'atk');
    },
  };

  // Banished instead when it is detached as an Xyz Material (Xyz Materials left behind by a monster leaving the field still go to the GY).
  E['Gimmick Puppet Shadow Feeler'] = {
    battleProof: () => true,
    *watchGrave(e, card, _owner, zone, events) {
      if (zone === 'gy' && events.some((ev) => ev.card.uid === card.uid && ev.reason === 'detached')) {
        e.banish(card.uid);
        e.log(card.owner, 'Gimmick Puppet Shadow Feeler is banished instead');
      }
    },
    quick: {
      from: 'gy',
      label: 'Special Summon it (take 1000 damage)',
      can: (e, _c, p, t, ctx) => t === 'damage' && !!ctx.direct && ctx.damaged === p && e.state.turnPlayer === other(p) && freeMZ(e, p),
      *run(e, card, p) {
        if (e.find(card.uid)?.loc.zone !== 'gy' || !freeMZ(e, p)) return;
        yield* e.specialSummon(card.uid, p, 'atk');
        if (e.fieldCard(card.uid)) e.damage(p, 1000);
      },
    },
  };

  E['Goblin King'] = {
    cannotBeAttacked: (e, m) => e.monsters(ctrl(e, m)).some((x) => x.uid !== m.uid && x.faceUp && raceOf(e, x) === 'Fiend'),
    baseStats: (e, m) => {
      const n = faceUpMonsters(e).filter((x) => x.uid !== m.uid && raceOf(e, x) === 'Fiend').length * 1000;
      return { atk: n, def: n };
    },
  };

  E['Goblin Zombie'] = {
    *onBattleDamage(e, _a, p) {
      yield* millTop(e, other(p), 1);
    },
    *onSentToGrave(e, _card, p, from) {
      if (from !== 'mz') return;
      yield* searchDeck(e, p, 'Goblin Zombie: add which Zombie monster?', (c) => isMonster(e, c) && info(e, c).race === 'Zombie' && defInfo(e, c) <= 1200 && (info(e, c).def ?? 0) >= 0);
    },
  };

  const searchOnBattleDeath = (title: string, test: (e: Engine, c: Card) => boolean): EffectDef => ({
    *onDestroyed(e, _c, p, byBattle) {
      if (!byBattle || !e.player(p).deck.some((c) => test(e, c)) || !(yield* e.yesno(p, `${title}?`))) return;
      yield* searchDeck(e, p, title, (c) => test(e, c));
    },
  });
  E['Gokipon'] = searchOnBattleDeath('Gokipon: add an Insect monster with 1500 or less ATK', (e, c) => isMonster(e, c) && info(e, c).race === 'Insect' && atkInfo(e, c) <= 1500);
  E['Jade Knight'] = {
    ...searchOnBattleDeath('Jade Knight: add a Level 4 LIGHT Machine monster', (e, c) => isMonster(e, c) && info(e, c).race === 'Machine' && attrOf(e, c) === 'LIGHT' && levelOf(e, c) === 4),
    shields: (e, src, target, how, srcController) =>
      how === 'effect' && src.pos === 'atk' && e.resolvingKind() === 'trap' && e.controller(target.uid) === srcController && target.faceUp && e.find(target.uid)?.loc.zone === 'mz' && raceOf(e, target) === 'Machine' && e.atkOf(target) <= 1200,
  };

  E['Golden Homunculus'] = {
    selfBonus: (e, m) => {
      const n = e.player(ctrl(e, m)).removed.length * 300;
      return { atk: n, def: n };
    },
  };

  // Revealed during your Main Phase instead of the Standby Phase (no hand effects in the Standby Phase).
  E['Golden Ladybug'] = {
    handIgnition: {
      can: (e, c, p) => e.oncePerTurn(`Golden Ladybug:${c.uid}`, p),
      *run(e, c, p) {
        e.useOnce(`Golden Ladybug:${c.uid}`, p);
        e.log(p, `${e.player(p).name} reveals Golden Ladybug`);
        e.gainLp(p, 500);
      },
    },
  };

  E['Granadora'] = {
    *onSummon(e, _m, p) {
      e.gainLp(p, 1000);
    },
    *onSpecialSummon(e, _m, p) {
      e.gainLp(p, 1000);
    },
    *onDestroyed(e, _c, p) {
      e.damage(p, 2000);
    },
  };

  E['Grandmaster of the Six Samurai'] = {
    // "You can only control 1": no other Summon while you control one (a Set one counts too).
    selfSummonBlock: (e, c, p) => e.monsters(p).some((m) => e.sameName(m, c) && m.uid !== c.uid),
    summonProc: {
      can: (e, c, p) => freeMZ(e, p) && faceUpMonsters(e, p).some((m) => named(e, m, 'Six Samurai')) && !e.monsters(p).some((m) => e.sameName(m, c)),
      *run(e, c, p) {
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
    onLeaveField: markOppDestroy,
    *onDestroyed(e, card, p, byBattle) {
      if (byBattle || card.owner !== p || !destroyedByOpp(e, card.uid)) return;
      yield* fromGraveToHand(e, p, 'Grandmaster: add which "Six Samurai" monster?', (c) => c.uid !== card.uid && isMonster(e, c) && named(e, c, 'Six Samurai'));
    },
  };

  E['Granmarg the Rock Monarch'] = {
    *onSummon(e, m, p, kind) {
      if (kind !== 'normal' || !m.tags?.tribS) return;
      const sets = [...allMonsters(e), ...allST(e)].filter((c) => !c.faceUp);
      const t = yield* pickOne(e, p, 'Granmarg: destroy which Set card?', sets);
      if (t && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
    },
  };

  // ---------- Gravekeeper's ----------
  E["Gravekeeper's Ambusher"] = {
    *flip(e, m, p) {
      fx<Record<number, number>>(e, 'ambusherFlipped', {})[m.uid] = 1;
      const gy = e.player(other(p)).gy;
      if (!gy.length) return;
      const t = yield* pickOne(e, p, "Gravekeeper's Ambusher: place which card from the opponent's GY on the bottom of their Deck? (cancel = none)", gy, true);
      if (t && e.find(t.uid)?.loc.zone === 'gy') necroFree(e, () => toDeckBottom(e, t.uid));
    },
    *onSummon(e, m, _p, kind) {
      if (kind === 'normal') delete fx<Record<number, number>>(e, 'ambusherFlipped', {})[m.uid];
    },
    *onSentToGrave(e, card, p, from) {
      const flipped = fx<Record<number, number>>(e, 'ambusherFlipped', {});
      const was = flipped[card.uid];
      delete flipped[card.uid];
      if (from !== 'mz' || !was || !e.player(p).gy.some((c) => named(e, c, 'Necrovalley'))) return;
      if (!(yield* e.yesno(p, 'Gravekeeper\'s Ambusher: add a "Necrovalley" card from your GY to your hand?'))) return;
      const c = yield* pickOne(e, p, 'Add which "Necrovalley" card?', e.player(p).gy.filter((x) => named(e, x, 'Necrovalley')));
      if (c) necroFree(e, () => e.toHandOf(c.uid, p));
    },
  };

  E["Gravekeeper's Assailant"] = {
    quick: {
      label: "change a monster's battle position",
      can: (e, card, p, t) => t === 'attack' && e.state.battle?.attacker === card.uid && necro(e) && targetable(e, faceUpMonsters(e, other(p))).length > 0,
      *cost(e, _c, p, link) {
        const t = yield* pickOne(e, p, "Gravekeeper's Assailant: change which monster's battle position?", targetable(e, faceUpMonsters(e, other(p))), true);
        if (!t) return false;
        link.targetUid = t.uid;
      },
      *run(e, _c, _p, link) {
        const t = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
        if (t?.faceUp) changePos(e, t);
      },
    },
  };

  // The Tribute is a cost paid as the effect is activated.
  E["Gravekeeper's Cannonholder"] = {
    ignition: {
      repeat: true,
      can: (e, m, p) => e.monsters(p).some((x) => x.uid !== m.uid && isGK(x) && !e.sameName(x, m) && !e.untributable(x)),
      *cost(e, m, p) {
        return yield* tributeCost(e, p, 1, (x) => isGK(x) && !e.sameName(x, m));
      },
      *run(e, _m, p) {
        e.damage(other(p), 700);
      },
    },
  };

  E["Gravekeeper's Chief"] = {
    // "You can only control 1 face-up": no face-up Summon while you control a face-up one.
    selfSummonBlock: (e, c, p, how) => how !== 'set' && faceUpMonsters(e, p).some((m) => e.sameName(m, c) && m.uid !== c.uid),
    // "Your GY is unaffected by Necrovalley."
    freesGrave: (e, _src, srcController, card) => card.owner === srcController && e.find(card.uid)?.loc.player === srcController,
    *onSummon(e, m, p, kind) {
      if (kind !== 'normal' || !m.tags?.tribS || !freeMZ(e, p)) return;
      const list = e.player(p).gy.filter((c) => mainMonster(e, c) && isGK(c));
      if (!list.length || !(yield* e.yesno(p, "Gravekeeper's Chief: Special Summon a \"Gravekeeper's\" monster from your GY?"))) return;
      yield* summonOneOf(e, p, "Special Summon which \"Gravekeeper's\" monster?", list);
    },
  };

  E["Gravekeeper's Commandant"] = {
    handIgnition: {
      can: (e, _c, p) => e.player(p).deck.some((c) => e.isNamed(c, 'Necrovalley')),
      *run(e, c, p) {
        yield* e.discard(p, c.uid);
        yield* searchDeck(e, p, 'Add "Necrovalley"', (d) => e.isNamed(d, 'Necrovalley'));
      },
    },
  };

  E["Gravekeeper's Curse"] = {
    *onSummon(e, _m, p) {
      e.damage(other(p), 500);
    },
    *onSpecialSummon(e, _m, p) {
      e.damage(other(p), 500);
    },
  };

  E["Gravekeeper's Descendant"] = {
    ignition: {
      repeat: true,
      can: (e, m, p) => e.monsters(p).some((x) => x.uid !== m.uid && x.faceUp && isGK(x) && !e.untributable(x)) && [...targetable(e, e.monsters(other(p))), ...stOf(e, other(p))].length > 0,
      // The Tribute and the target are chosen as the effect is activated.
      *cost(e, m, p) {
        if (!(yield* tributeCost(e, p, 1, (x) => x.faceUp && isGK(x), m.uid))) return false;
        const t = yield* pickOne(e, p, "Gravekeeper's Descendant: destroy which card?", [...targetable(e, e.monsters(other(p))), ...stOf(e, other(p))]);
        if (!t) return false;
        tag(m).descTarget = t.uid;
      },
      *run(e, m) {
        const u = m.tags?.descTarget;
        if (u !== undefined && e.fieldCard(u)) yield* e.destroy([u]);
      },
    },
  };

  // Every Tribute Summon of it (2 monsters, 3 monsters, or 1 "Gravekeeper's") runs as a summon procedure doing a real Tribute Summon
  // (engine.tributeSummonWith). Approximation: it cannot be Set with 2 Tributes.
  E["Gravekeeper's Oracle"] = {
    cannotNormalSummon: true,
    summonProc: {
      can: (e, c, p) => e.inMainPhase() && !e.player(p).normalSummoned && !e.summonBlocked(p, c, 'normal', 'hand') && (e.monsters(p).filter((m) => !e.untributable(m)).length >= 2 || e.monsters(p).some((m) => isGK(m) && !e.untributable(m))),
      *run(e, c, p) {
        const mine = e.monsters(p).filter((m) => !e.untributable(m));
        const opts: [string, number, boolean][] = [];
        if (mine.some((m) => isGK(m))) opts.push(['Tribute 1 "Gravekeeper\'s" monster', 1, true]);
        if (mine.length >= 2) opts.push(['Tribute 2 monsters', 2, false]);
        if (mine.length >= 3) opts.push(['Tribute 3 monsters', 3, false]);
        const i = yield* chooseOption(e, p, "Gravekeeper's Oracle: how do you Tribute Summon it?", opts.map((o) => o[0]), true);
        if (i === null) return;
        const [, n, gkOnly] = opts[i];
        const cands = mine.filter((m) => !gkOnly || isGK(m));
        const chosen = yield* pick(e, p, `Tribute ${n} monster${n > 1 ? 's' : ''}`, cands, n, n, true, false);
        if (!chosen) return;
        const levels = chosen.reduce((s, m) => s + levelOf(e, m), 0);
        const gks = chosen.filter((m) => isGK(m)).length;
        fx<Record<number, number[]>>(e, 'oracleTributes', {})[c.uid] = [levels, gks];
        yield* e.tributeSummonWith(p, c.uid, chosen.map((m) => m.uid));
      },
    },
    *onSummon(e, me, p, kind) {
      const rec = fx<Record<number, number[]>>(e, 'oracleTributes', {});
      const [levels, gks] = rec[me.uid] ?? [0, 0];
      delete rec[me.uid];
      if (kind !== 'normal' || !me.tags?.tribS) return;
      {
        let left = gks;
        if (left > 0 && (yield* e.yesno(p, `Oracle: gain ${levels * 100} ATK?`))) {
          boostPerm(me, levels * 100);
          left--;
        }
        if (left > 0 && e.monsters(other(p)).some((m) => !m.faceUp) && (yield* e.yesno(p, 'Oracle: destroy all Set monsters your opponent controls?'))) {
          yield* e.destroy(e.monsters(other(p)).filter((m) => !m.faceUp).map((m) => m.uid));
          left--;
        }
        if (left > 0 && faceUpMonsters(e, other(p)).length && (yield* e.yesno(p, "Oracle: your opponent's monsters lose 2000 ATK/DEF?"))) {
          for (const m of faceUpMonsters(e, other(p))) boostPerm(m, -2000, -2000);
        }
      }
    },
  };

  // Treating the field as "Necrovalley" applies Necrovalley's +500 (once, however many Priestesses).
  E["Gravekeeper's Priestess"] = {
    aura: (e, src, target) => {
      if (!target.faceUp || !isGK(target)) return undefined;
      const first = faceUpMonsters(e).filter((m) => e.sameName(m, src) && !e.isNegated(m)).sort((a, b) => a.uid - b.uid)[0];
      const valley = !fieldFaceUp(e) && first?.uid === src.uid ? 500 : 0;
      return { atk: 200 + valley, def: 200 + valley };
    },
    // ...and Necrovalley's Graveyard lock while there is no face-up Field Spell.
    // Approximation: the lock applies to card effects that are resolving (engine-level moves are not checked).
    locksGrave: (e) => !fieldFaceUp(e) && !!e.resolvingCard(),
  };

  E["Gravekeeper's Recruiter"] = {
    *onSentToGrave(e, _c, p, from) {
      if (from !== 'mz') return;
      yield* searchDeck(e, p, "Gravekeeper's Recruiter: add which \"Gravekeeper's\" monster?", (c) => isMonster(e, c) && isGK(c) && defInfo(e, c) <= 1500);
    },
  };

  // Approximation: of the monster effects that activate in the GY, the ones put on a chain are negated (GY ignition effects are not).
  E["Gravekeeper's Shaman"] = {
    selfBonus: (e, m) => ({ atk: 0, def: e.player(ctrl(e, m)).gy.filter((c) => isMonster(e, c) && isGK(c)).length * 200 }),
    negatesEffect: (e, _m, _p, link) => !!(link.payload as { effect?: string } | undefined)?.effect && link.loc.zone === 'gy' && isMonster(e, link.card) && !isGK(link.card),
    locksCardActivation: (e, _src, srcController, player, card) => player === other(srcController) && necro(e) && isSpell(e, card) && info(e, card).sub === 'Field',
    shields: (e, _src, target, how, srcController) => how === 'effect' && e.actor === other(srcController) && necro(e) && isSpell(e, target) && info(e, target).sub === 'Field',
  };

  E["Gravekeeper's Spear Soldier"] = { piercing: true };

  E["Gravekeeper's Spy"] = {
    *flip(e, _m, p) {
      yield* summonOneOf(e, p, "Gravekeeper's Spy: Special Summon which \"Gravekeeper's\" monster?", e.player(p).deck.filter((c) => mainMonster(e, c) && isGK(c) && atkInfo(e, c) <= 1500));
    },
  };

  // Battle damage it inflicts is dealt as effect damage (engine battleAsEffect): "no battle damage" effects do not stop it.
  E["Gravekeeper's Vassal"] = { battleAsEffect: true };

  E['Gravitic Orb'] = {
    *flip(e, _m, p) {
      for (const m of faceUpMonsters(e, other(p))) changePos(e, m);
    },
  };

  E['Great Phantom Thief'] = {
    *onBattleDamage(e, _a, p) {
      const opp = e.player(other(p));
      const names = declarable(e);
      const i = yield* chooseOption(e, p, 'Great Phantom Thief: declare a card name', names);
      if (i === null) return;
      const name = names[i];
      e.log(p, `${e.player(p).name} declares ${name}`);
      yield* e.reveal(p, "Your opponent's hand", opp.hand.slice());
      for (const c of opp.hand.filter((x) => x.name === name)) yield* e.discard(other(p), c.uid);
    },
  };

  // From the hand or GY, when a face-up Beast you control is destroyed (by a card effect: battle destruction happens in the Damage Step).
  E['Green Baboon, Defender of the Forest'] = {
    *watchGrave(e, card, owner, _zone, events) {
      const hit = events.some((ev) => ev.card.uid !== card.uid && ev.from === 'mz' && ev.controller === owner && ev.faceUp && ev.reason === 'destroyed' && !ev.byBattle && ev.toGy && ev.race === 'Beast');
      if (!hit || events.some((ev) => ev.card.uid === card.uid) || e.player(owner).lp <= 1000 || !freeMZ(e, owner)) return;
      if (!(yield* e.yesno(owner, 'Green Baboon, Defender of the Forest: pay 1000 LP to Special Summon it?'))) return;
      if (!payLp(e, owner, 1000)) return;
      const z = e.find(card.uid)?.loc.zone;
      if ((z === 'hand' || z === 'gy') && freeMZ(e, owner)) yield* e.specialSummon(card.uid, owner, 'atk');
    },
  };

  E['Gren Maju Da Eiza'] = {
    baseStats: (e, m) => {
      const n = e.player(ctrl(e, m)).removed.length * 400;
      return { atk: n, def: n };
    },
  };

  E['Guardian Angel Joan'] = battleWin(function* (e, _me, victim, p) {
    e.gainLp(p, atkInfo(e, victim));
  });

  E['Guardian Sphinx'] = {
    ignition: flipDown,
    *onSummon(e, _m, p, kind) {
      if (kind !== 'flip') return;
      for (const m of e.monsters(other(p)).slice()) yield* bounce(e, m.uid);
    },
  };

  E['Guiding Light'] = {
    *onSummon(e, _m, p, kind) {
      if (kind !== 'normal' || !freeMZ(e, p)) return;
      const list = e.player(p).gy.filter((c) => mainMonster(e, c) && levelOf(e, c) === 1 && attrOf(e, c) === 'LIGHT');
      if (!list.length || !(yield* e.yesno(p, 'Guiding Light: Special Summon a Level 1 LIGHT monster from your GY?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which monster?', list);
    },
  };

  E['Gyroid'] = {
    battleProof(e, m) {
      if (tag(m).gyroidTurn === e.state.turn) return false;
      tag(m).gyroidTurn = e.state.turn;
      return true;
    },
  };

  // Cerulean Skyfire: face-down Spells you control can be used for Hamon's summon too.
  const hamonCost = (e: Engine, p: Pid) => {
    const skyfire = e.liveST().some((x) => x.p === p && e.isNamed(x.c, 'Cerulean Skyfire'));
    return e.spells(p).filter((s) => isSpell(e, s) && ((s.faceUp && info(e, s).sub === 'Continuous') || (skyfire && !s.faceUp)));
  };
  E['Hamon, Lord of Striking Thunder'] = {
    ...nomi(),
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && hamonCost(e, p).length >= 3,
      *run(e, c, p) {
        const list = hamonCost(e, p);
        const chosen = yield* pick(e, p, 'Hamon: send which 3 Continuous Spells to the GY?', list, 3, 3, true);
        if (!chosen) return;
        for (const s of chosen) yield* e.sendToGrave(s.uid, 'cost');
        yield* procSummon(e, c, p);
      },
    },
    // In face-up Defense Position, the opponent's monsters can attack only it.
    guardsAttack: (_e, src, target) => src.faceUp && src.pos === 'def' && target.uid !== src.uid,
    ...battleWin(function* (e, _me, _v, p) {
      e.damage(other(p), 1000);
    }),
  };

  E['Hannibal Necromancer'] = {
    *onSummon(_e, m, _p, kind) {
      if (kind === 'normal') m.counters = 1;
    },
    ignition: {
      repeat: true,
      can: (e, m) => m.counters > 0 && allST(e).some((c) => c.faceUp && isTrap(e, c)),
      // Removing the Spell Counter is a cost, and the Trap is targeted, as the effect is activated.
      *cost(e, m, p) {
        const t = yield* pickOne(e, p, 'Hannibal Necromancer: destroy which face-up Trap?', allST(e).filter((c) => c.faceUp && isTrap(e, c)), true);
        if (!t || m.counters <= 0) return false;
        m.counters--;
        tag(m).hannibalTarget = t.uid;
      },
      *run(e, m) {
        const u = m.tags?.hannibalTarget;
        if (u !== undefined && e.fieldCard(u)?.faceUp) yield* e.destroy([u]);
      },
    },
  };

  // ---------- Harpies ----------
  // "This card's name becomes 'Harpie Lady'" (fieldName: Fusion Materials; isHarpieLady: the Harpie Lady cards here).
  const harpieName = { fieldName: () => 'Harpie Lady' };
  const channelerTargets = (e: Engine, p: Pid) => e.player(p).deck.filter((c) => mainMonster(e, c) && named(e, c, 'Harpie') && !e.isNamed(c, 'Harpie Channeler'));
  E['Harpie Channeler'] = {
    ...harpieName,
    ignition: {
      can: (e, _m, p) => e.oncePerTurn('Harpie Channeler', p) && freeMZ(e, p) && e.player(p).hand.some((c) => named(e, c, 'Harpie')) && channelerTargets(e, p).length > 0,
      // The discard is a cost paid as the effect is activated.
      *cost(e, _m, p) {
        if (!(yield* discardCost(e, p, 1, (c) => named(e, c, 'Harpie')))) return false;
        e.useOnce('Harpie Channeler', p);
      },
      *run(e, _m, p) {
        yield* summonOneOf(e, p, 'Harpie Channeler: Special Summon which "Harpie" monster?', channelerTargets(e, p), 'def');
      },
    },
    // "While you control a Dragon-Type monster, this card's Level becomes 7."
    *stateCheck(e, m, p) {
      const t = tag(m);
      if (faceUpMonsters(e, p).some((x) => raceOf(e, x) === 'Dragon')) {
        if (t.lvSet !== 7) (t.lvSet = 7), (t.channeler = 1);
      } else if (t.channeler) delete t.lvSet, delete t.channeler;
    },
  };

  // The WIND monster is targeted as the effect is activated; the Normal Summon is an additional one (engine.extraNormalSummon).
  const dancerTargets = (e: Engine, p: Pid) => targetable(e, faceUpMonsters(e, p)).filter((m) => attrOf(e, m) === 'WIND');
  E['Harpie Dancer'] = {
    ...harpieName,
    ignition: {
      can: (e, _m, p) => e.oncePerTurn('Harpie Dancer', p) && dancerTargets(e, p).length > 0,
      *cost(e, m, p) {
        const t = yield* pickOne(e, p, 'Harpie Dancer: return which WIND monster to the hand?', dancerTargets(e, p), true);
        if (!t) return false;
        e.useOnce('Harpie Dancer', p);
        tag(m).dancerTarget = t.uid;
      },
      *run(e, m, p) {
        const u = m.tags?.dancerTarget;
        const t = u !== undefined ? e.fieldCard(u) : null;
        if (!t || e.controller(t.uid) !== p) return;
        yield* bounce(e, t.uid);
        yield* e.flushLeaves();
        const list = e.player(p).hand.filter((c) => isMonster(e, c) && attrOf(e, c) === 'WIND' && e.canNormalSummon(p, c, true, true));
        if (!list.length || !(yield* e.yesno(p, 'Harpie Dancer: Normal Summon a WIND monster?'))) return;
        const c = yield* pickOne(e, p, 'Normal Summon which WIND monster?', list);
        if (c) yield* e.extraNormalSummon(p, c.uid, 'atk', true);
      },
    },
  };

  E['Harpie Lady 1'] = {
    ...harpieName,
    aura: (e, _src, target) => (target.faceUp && attrOf(e, target) === 'WIND' ? { atk: 300, def: 0 } : undefined),
  };

  // "Cannot declare an attack during your opponent's next 2 turns": tags.noAttackTurn and tags.noAttackTurn2 (engine).
  const harpie3 = (e: Engine, foe: FieldCard, p: Pid) => {
    if (!e.fieldCard(foe.uid) || e.controller(foe.uid) !== other(p)) return;
    const first = e.state.turnPlayer === p ? e.state.turn + 1 : e.state.turn + 2;
    tag(foe).noAttackTurn = first;
    tag(foe).noAttackTurn2 = first + 2;
    e.log(p, `${foe.name} cannot declare an attack during its controller's next 2 turns`);
  };
  E['Harpie Lady 3'] = {
    ...harpieName,
    *afterBattle(e, _a, t, p) {
      if (t) harpie3(e, t, p);
    },
    *onAttacked(e, _me, attacker, p) {
      harpie3(e, attacker, p);
    },
  };

  E['Harpie Queen'] = {
    ...harpieName,
    handIgnition: {
      can: (e, _c, p) => e.player(p).deck.some((c) => e.isNamed(c, "Harpies' Hunting Ground")),
      *run(e, c, p) {
        yield* e.discard(p, c.uid);
        yield* searchDeck(e, p, "Add Harpies' Hunting Ground", (d) => e.isNamed(d, "Harpies' Hunting Ground"));
      },
    },
  };

  E["Harpie's Pet Dragon - Fearsome Fire Blast"] = {
    // "Monsters cannot target Level 6 or lower 'Harpie' monsters for attacks."
    attackGuard: (e, _src, _p, _attacker, target) => target.faceUp && named(e, target, 'Harpie') && levelOf(e, target) <= 6,
    summonProc: {
      can: (e, _c, p) => e.oncePerTurn('FFB:summon', p) && freeMZ(e, p) && faceUpMonsters(e, p).some((m) => attrOf(e, m) === 'WIND' && levelOf(e, m) <= 6),
      *run(e, c, p) {
        e.useOnce('FFB:summon', p);
        yield* e.specialSummon(c.uid, p, 'def');
      },
    },
    *onSentToGrave(e, _c, p, from) {
      const test = (c: Card) => isMonster(e, c) && attrOf(e, c) === 'WIND' && info(e, c).race === 'Winged Beast';
      if (from !== 'mz' || !e.oncePerTurn('FFB:send', p) || !e.player(p).deck.some(test)) return;
      if (!(yield* e.yesno(p, 'Fearsome Fire Blast: send a WIND Winged Beast monster from your Deck to the GY?'))) return;
      e.useOnce('FFB:send', p);
      yield* deckToGrave(e, p, 'Send which monster to the GY?', test);
    },
  };

  E["Harpies' Hunting Ground"] = {
    ...h.fieldSpell((e, m) => (m.faceUp && raceOf(e, m) === 'Winged Beast' ? { atk: 200, def: 200 } : undefined)),
    *onAnySummon(e, _w, _wp, m, controller, kind) {
      if (kind === 'flip' || !(isHarpieLady(m) || e.isNamed(m, 'Harpie Lady Sisters'))) return;
      const list = allST(e);
      if (!list.length) return;
      yield* e.as(controller, (function* () {
        const t = yield* pickOne(e, controller, "Harpies' Hunting Ground: destroy which Spell/Trap?", list);
        if (t && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
      })());
    },
  };

  E['Hysteric Party'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.player(p).hand.length > 0 && freeMZ(e, p) && e.player(p).gy.some(isHarpieLady),
    *activate(e, _l, p) {
      if (!(yield* discardCost(e, p, 1))) return false;
    },
    *resolve(e, link, p) {
      const list = e.player(p).gy.filter(isHarpieLady);
      const out: number[] = [];
      for (const c of list) {
        if (!freeMZ(e, p)) break;
        yield* e.specialSummon(c.uid, p, 'atk');
        if (e.fieldCard(c.uid)) out.push(c.uid);
      }
      fx<Record<number, number[]>>(e, 'hystericParty', {})[link.card.uid] = out;
    },
    *onLeaveField(e, fc) {
      const store = fx<Record<number, number[]>>(e, 'hystericParty', {});
      const list = (store[fc.uid] ?? []).filter((u) => e.fieldCard(u));
      delete store[fc.uid];
      if (list.length) yield* e.destroy(list);
    },
  };

  E['Hysteric Sign'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p),
    *resolve(e, link, p) {
      e.useOnce(link.card.name, p);
      const ps = e.player(p);
      const c = yield* pickOne(e, p, 'Hysteric Sign: add "Elegant Egotist"', [...ps.deck, ...ps.gy].filter((x) => e.isNamed(x, 'Elegant Egotist')));
      if (!c) return;
      const fromDeck = e.find(c.uid)?.loc.zone === 'deck';
      e.toHandOf(c.uid, p);
      if (fromDeck) ps.deck = e.shuffle(ps.deck);
    },
    *onSentToGrave(e, card, _o, from) {
      const flags = fx<Record<number, number>>(e, 'hystericSign', {});
      if (from === 'hand' || from === 'sz') flags[card.uid] = e.state.turn;
      else delete flags[card.uid];
    },
    *onEndPhaseInGrave(e, card, p) {
      const flags = fx<Record<number, number>>(e, 'hystericSign', {});
      if (flags[card.uid] !== e.state.turn) return;
      delete flags[card.uid];
      if (!e.oncePerTurn(card.name, p)) return;
      const ps = e.player(p);
      const names = [...new Set(ps.deck.filter((c) => named(e, c, 'Harpie')).map((c) => c.name))];
      if (!names.length) return;
      e.useOnce(card.name, p);
      const picks = yield* e.select(p, 'Hysteric Sign: add up to 3 "Harpie" cards with different names', names.map((n) => ({ label: n })), 1, Math.min(3, names.length));
      for (const i of picks ?? []) {
        const c = ps.deck.find((x) => x.name === names[i]);
        if (c) e.toHandOf(c.uid, p);
      }
      e.log(p, `Hysteric Sign adds ${(picks ?? []).map((i) => names[i]).join(', ')} to the hand`);
      ps.deck = e.shuffle(ps.deck);
    },
  };

  // ---------- Helios ----------
  const banishedMonsters = (e: Engine) => [0, 1].reduce((n, q) => n + e.player(q as Pid).removed.filter((c) => isMonster(e, c)).length, 0);
  const helios = (per: number, from?: string, extra: Partial<EffectDef> = {}): EffectDef => ({
    baseStats: (e) => ({ atk: banishedMonsters(e) * per, def: banishedMonsters(e) * per }),
    ...(from
      ? {
          summonProc: {
            can: (e, _c, p) => e.monsters(p).some((m) => m.faceUp && m.name === from),
            *run(e, c, p) {
              if (!(yield* tributeCost(e, p, 1, (m) => m.faceUp && m.name === from))) return;
              yield* e.specialSummon(c.uid, p, 'atk');
            },
          },
        }
      : {}),
    ...extra,
  });
  /** "If this card is destroyed by battle and sent to the GY, Special Summon it during the End Phase, and it gains N ATK and DEF." */
  const heliosRise = (gain: number): Partial<EffectDef> => ({
    *onDestroyed(e, card, _p, byBattle) {
      if (byBattle) fx<Record<number, number>>(e, 'heliosRise', {})[card.uid] = e.state.turn;
    },
    *onEndPhaseInGrave(e, card, owner) {
      const marks = fx<Record<number, number>>(e, 'heliosRise', {});
      if (marks[card.uid] !== e.state.turn) return;
      delete marks[card.uid];
      if (!freeMZ(e, owner)) return;
      yield* e.specialSummon(card.uid, owner, 'atk');
      const m = e.fieldCard(card.uid);
      if (m) boostPerm(m, gain, gain);
    },
  });
  E['Helios - The Primordial Sun'] = helios(100);
  E['Helios Duo Megistus'] = helios(200, 'Helios - The Primordial Sun', heliosRise(300));
  E['Helios Trice Megistus'] = helios(300, 'Helios Duo Megistus', { ...heliosRise(500), attacks: (e, m) => (e.monsters(other(ctrl(e, m))).length > 0 ? 2 : 1) });

  E['Helping Robo for Combat'] = battleKill(function* (e, _me, _v, p) {
    if (!e.draw(p, 1)) return;
    const ps = e.player(p);
    const c = yield* pickOne(e, p, 'Helping Robo for Combat: return which card to the bottom of the Deck?', ps.hand.slice());
    if (!c) return;
    const i = ps.hand.findIndex((x) => x.uid === c.uid);
    if (i >= 0) ps.deck.push(ps.hand.splice(i, 1)[0]);
  });

  E['Heraldic Beast Aberconway'] = {
    graveIgnition: {
      can: (e, card, p) => e.oncePerTurn(card.name, p) && e.player(p).gy.some((c) => c.uid !== card.uid && e.sameName(c, card)) && e.player(p).gy.some((c) => isMonster(e, c) && named(e, c, 'Heraldic Beast')),
      *run(e, card, p) {
        const other_ = yield* pickOne(e, p, 'Banish which other "Heraldic Beast Aberconway"?', e.player(p).gy.filter((c) => c.uid !== card.uid && e.sameName(c, card)), true);
        if (!other_) return;
        e.useOnce(card.name, p);
        e.banish(other_.uid);
        yield* fromGraveToHand(e, p, 'Add which "Heraldic Beast" monster?', (c) => isMonster(e, c) && named(e, c, 'Heraldic Beast'));
      },
    },
  };

  E['Hieratic Dragon of Nuit'] = {
    quick: {
      label: 'Special Summon a Dragon Normal Monster',
      can: (e, card, p, t, ctx) =>
        (t === 'spell' || t === 'trap' || t === 'effect') &&
        ctx.link?.targetUid === card.uid &&
        freeMZ(e, p) &&
        [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy].some((c) => isNormalMonster(e, c) && info(e, c).race === 'Dragon'),
      *run(e, _c, p) {
        yield* hieraticCall(e, p, 'Hieratic Dragon of Nuit: Special Summon which Dragon Normal Monster?');
      },
    },
  };

  const hieraticFodder = (e: Engine, p: Pid, except: number) => [...e.player(p).hand.filter((c) => isMonster(e, c) && named(e, c, 'Hieratic')), ...e.monsters(p).filter((m) => m.faceUp && named(e, m, 'Hieratic'))].filter((c) => c.uid !== except);
  E['Hieratic Dragon of Su'] = {
    summonProc: {
      can: (e, _c, p) => e.monsters(p).some((m) => m.faceUp && named(e, m, 'Hieratic')),
      *run(e, c, p) {
        if (!(yield* tributeCost(e, p, 1, (m) => m.faceUp && named(e, m, 'Hieratic')))) return;
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
    ignition: {
      can: (e, m, p) => hieraticFodder(e, p, m.uid).length > 0 && stOf(e, other(p)).length > 0,
      // The Tribute and the target are chosen as the effect is activated.
      *cost(e, m, p) {
        const t = yield* pickOne(e, p, 'Hieratic Dragon of Su: Tribute which "Hieratic" monster?', hieraticFodder(e, p, m.uid), true);
        if (!t) return false;
        e.log(p, `${e.player(p).name} Tributes ${t.name}`);
        yield* e.sendToGrave(t.uid, 'tribute');
        const s = yield* pickOne(e, p, 'Hieratic Dragon of Su: destroy which Spell/Trap?', stOf(e, other(p)));
        if (!s) return false;
        tag(m).suTarget = s.uid;
      },
      *run(e, m) {
        const u = m.tags?.suTarget;
        if (u !== undefined && e.fieldCard(u)) yield* e.destroy([u]);
      },
    },
    *onSentToGrave(e, _c, p, _from, reason) {
      if (reason === 'tribute') yield* hieraticCall(e, p, 'Hieratic Dragon of Su: Special Summon which Dragon Normal Monster?');
    },
  };

  E['Hino-Kagu-Tsuchi'] = {
    cannotSpecialSummon: true,
    *onSummon(e, m) {
      tag(m).spiritTurn = e.state.turn;
    },
    *onEndPhase(e, m) {
      if (m.tags?.spiritTurn === e.state.turn) yield* bounce(e, m.uid);
    },
    // The opponent discards right away instead of during their next Draw Phase.
    *onBattleDamage(e, _a, p) {
      const q = other(p);
      for (const c of e.player(q).hand.slice()) yield* e.discard(q, c.uid);
    },
  };

  const holdArms = function* (e: Engine, me: FieldCard, p: Pid): Step {
    const t = yield* pickOne(e, p, 'Holding Arms: target which monster?', targetable(e, faceUpMonsters(e, other(p))));
    if (!t || !e.fieldCard(t.uid) || !e.fieldCard(me.uid)) return;
    tag(me).hold = t.uid;
    tag(t).heldBy = me.uid;
    negateMonster(e, t, false);
    t.cannotAttack = true;
  };
  const holdsSomething = (e: Engine, m: FieldCard) => m.tags?.hold !== undefined && !!e.fieldCard(m.tags.hold);
  E['Holding Arms'] = {
    *onSummon(e, m, p, kind) {
      if (kind === 'normal') yield* holdArms(e, m, p);
    },
    *onSpecialSummon(e, m, p) {
      yield* holdArms(e, m, p);
    },
    battleProof: holdsSomething,
    effectProof: holdsSomething,
    *onLeaveField(e, fc) {
      const t = fc.tags?.hold !== undefined ? e.fieldCard(fc.tags.hold) : null;
      if (t && t.tags?.heldBy === fc.uid) {
        delete t.tags.heldBy;
        delete t.tags.negated;
        t.cannotAttack = false;
      }
    },
  };

  E['Howling Insect'] = {
    *onDestroyed(e, _c, p, byBattle) {
      const list = () => e.player(p).deck.filter((c) => mainMonster(e, c) && info(e, c).race === 'Insect' && atkInfo(e, c) <= 1500);
      if (!byBattle || !freeMZ(e, p) || !list().length || !(yield* e.yesno(p, 'Howling Insect: Special Summon an Insect with 1500 or less ATK from your Deck?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which Insect?', list());
    },
  };

  E['Humpty Grumpty'] = {
    ignition: flipDown,
    *onSummon(_e, m, _p, kind) {
      if (kind === 'flip') boostTurn(m, 800);
    },
  };

  E['Hydrogeddon'] = battleWin(function* (e, _me, _v, p) {
    if (!freeMZ(e, p) || !e.player(p).deck.some((c) => e.isNamed(c, 'Hydrogeddon')) || !(yield* e.yesno(p, 'Hydrogeddon: Special Summon a "Hydrogeddon" from your Deck?'))) return;
    yield* summonOneOf(e, p, 'Special Summon which?', e.player(p).deck.filter((c) => e.isNamed(c, 'Hydrogeddon')));
  });

  E['Hyper Hammerhead'] = {
    *afterBattle(e, _a, t, p, destroyed) {
      if (t && !destroyed && e.fieldCard(t.uid) && e.controller(t.uid) === other(p)) yield* bounce(e, t.uid);
    },
    *onAttacked(e, me, attacker, p) {
      if (e.fieldCard(me.uid) && e.fieldCard(attacker.uid) && e.controller(attacker.uid) === other(p)) yield* bounce(e, attacker.uid);
    },
  };

  E['Il Blud'] = {
    ...gemini({
      can: (e, _m, p) => freeMZ(e, p) && [...e.player(p).hand, ...e.player(0).gy, ...e.player(1).gy].some((c) => mainMonster(e, c) && info(e, c).race === 'Zombie'),
      *run(e, m, p) {
        const list = [...e.player(p).hand, ...e.player(p).gy, ...e.player(other(p)).gy].filter((c) => mainMonster(e, c) && info(e, c).race === 'Zombie');
        const z = yield* summonOneOf(e, p, 'Il Blud: Special Summon which Zombie monster?', list);
        if (z) (fx<Record<number, number[]>>(e, 'ilBlud', {})[m.uid] ??= []).push(z.uid);
      },
    }),
    *onLeaveField(e, fc) {
      const store = fx<Record<number, number[]>>(e, 'ilBlud', {});
      const list = (store[fc.uid] ?? []).filter((u) => e.fieldCard(u));
      delete store[fc.uid];
      if (list.length) yield* e.destroy(list);
    },
  };

  const restrictLike = (e: Engine, c: Card) => e.isNamed(c, 'Relinquished') || (named(e, c, 'Eyes Restrict') && info(e, c).sub === 'Fusion');
  E['Illusionist Faceless Magician'] = {
    // From the hand, or from the GY if it was already there (not destroyed in the same event).
    *watchGrave(e, card, owner, _zone, events) {
      const hit = events.some((ev) => ev.from === 'mz' && ev.controller === owner && ev.faceUp && ev.reason === 'destroyed' && restrictLike(e, ev.card));
      if (!hit || events.some((ev) => ev.card.uid === card.uid) || !freeMZ(e, owner) || !e.oncePerTurn('IFM:ss', owner)) return;
      if (!(yield* e.yesno(owner, 'Illusionist Faceless Magician: Special Summon it?'))) return;
      e.useOnce('IFM:ss', owner);
      yield* e.specialSummon(card.uid, owner, 'atk');
    },
    *onSentToGrave(e, _c, p, from) {
      const list = e.player(p).gy.filter((c) => restrictLike(e, c));
      if (from !== 'mz' || !list.length || !freeMZ(e, p) || !e.oncePerTurn('IFM:revive', p) || !(yield* e.yesno(p, 'Illusionist Faceless Magician: Special Summon "Relinquished" or an "Eyes Restrict" monster from your GY?'))) return;
      e.useOnce('IFM:revive', p);
      yield* summonOneOf(e, p, 'Special Summon which?', list);
    },
  };

  E['Imairuka'] = {
    onLeaveField: markOppDestroy,
    *onDestroyed(e, card, p, byBattle) {
      if (card.owner !== p || !(byBattle || destroyedByOpp(e, card.uid))) return;
      const top = e.player(p).deck[0];
      if (!top) return;
      yield* e.sendToGrave(top.uid, 'mill');
      e.log(p, `Imairuka sends ${top.name} to the GY`);
      if (isMonster(e, top) && attrOf(e, top) === 'WATER') e.draw(p, 1);
    },
  };

  const KNIGHTS = ["Queen's Knight", "King's Knight", "Jack's Knight"];
  // Tributing itself is a cost, so the effect resolves at once (chain: false).
  E['Imperial Bower'] = {
    ignition: {
      chain: false,
      can: (e, m, p) => e.oncePerTurn(m.name, p) && e.monsters(p).length === 1 && !e.untributable(m) && new Set(e.player(p).deck.filter((c) => e.namesOf(c).some((nm) => KNIGHTS.includes(nm))).map((c) => c.name)).size >= 2,
      *cost(e, m, p) {
        e.useOnce(m.name, p);
        e.log(p, `${e.player(p).name} Tributes ${m.name}`);
        yield* e.sendToGrave(m.uid, 'tribute');
      },
      *run(e, _m, p) {
        const ps = e.player(p);
        const names = KNIGHTS.filter((n) => ps.deck.some((c) => c.name === n));
        if (names.length < 2) return;
        const picks = yield* e.select(p, 'Imperial Bower: take which 2 Knights?', names.map((n) => ({ label: n })), 2, 2);
        for (const i of picks ?? []) {
          const c = ps.deck.find((x) => x.name === names[i]);
          if (!c) continue;
          if (freeMZ(e, p) && (yield* e.yesno(p, `Special Summon ${c.name}? (No = add it to your hand)`))) yield* e.specialSummon(c.uid, p, 'atk');
          else e.toHandOf(c.uid, p);
        }
        ps.deck = e.shuffle(ps.deck);
      },
    },
  };

  const pandemonium = (e: Engine) => !!e.anyActive('Pandemonium');
  E['Imprisoned Queen Archfiend'] = {
    *onStandby(e, m, p) {
      if (e.state.turnPlayer !== p || pandemonium(e)) return;
      if (payLp(e, p, 1000)) return;
      e.log(p, 'Imprisoned Queen Archfiend cannot be kept and is destroyed');
      yield* e.destroy([m.uid]);
    },
    *onStandbyInGrave(e, _c, p) {
      const list = targetable(e, faceUpMonsters(e)).filter((m) => raceOf(e, m) === 'Fiend' && levelOf(e, m) <= 4);
      if (!pandemonium(e) || !list.length) return;
      const t = yield* pickOne(e, p, 'Imprisoned Queen Archfiend: which Fiend gains 1000 ATK?', list);
      if (t) boostTurn(t, 1000);
    },
  };

  // The die is rolled as an opponent's effect that targets it resolves (only effects that record their target can be seen).
  E['Infernalqueen Archfiend'] = {
    *onChainLink(e, m, p, link) {
      if (link.player !== other(p) || link.targetUid !== m.uid || link.negated) return;
      const r = yield* e.rollDie(p, (v) => v === 2 || v === 5);
      e.log(p, `Infernalqueen Archfiend rolls a ${r}`);
      if (r !== 2 && r !== 5) return;
      link.negated = true;
      if (e.fieldCard(link.card.uid)) yield* e.destroy([link.card.uid]);
    },
    *onStandby(e, _m, p) {
      if (e.state.turnPlayer === p && !pandemonium(e)) payLp(e, p, 500);
      const list = faceUpMonsters(e).filter((m) => named(e, m, 'Archfiend'));
      const t = yield* pickOne(e, p, 'Infernalqueen Archfiend: which Archfiend gains 1000 ATK?', list);
      if (t) boostTurn(t, 1000);
    },
  };

  // Approximation: used when the attack is declared (no damage calculation window); the 3000 ATK is removed after that battle.
  E['Injection Fairy Lily'] = {
    quick: {
      repeat: true,
      label: 'pay 2000 LP for +3000 ATK',
      can: (e, card, p, t) => {
        const b = e.state.battle;
        return t === 'attack' && !!b && (b.attacker === card.uid || b.target === card.uid) && e.player(p).lp > 2000 && (card as FieldCard).tags?.lilyBattle !== e.state.fx.battleNo;
      },
      *cost(e, card, p) {
        if (!payLp(e, p, 2000)) return false;
        tag(card as FieldCard).lilyBattle = e.state.fx.battleNo ?? 0;
      },
      *run(e, card) {
        const m = e.fieldCard(card.uid);
        if (!m) return;
        m.atkMod += 3000;
        tag(m).lilyBoost = e.state.fx.battleNo ?? 0;
      },
    },
    *afterBattle(e, a) {
      if (a.tags?.lilyBoost === e.state.fx.battleNo) (a.atkMod -= 3000), delete a.tags!.lilyBoost;
    },
    *onAttacked(e, me) {
      if (me.tags?.lilyBoost === e.state.fx.battleNo) (me.atkMod -= 3000), delete me.tags!.lilyBoost;
    },
  };

  // Checked after every action (stateCheck): the opponent's face-up Insects are put in Attack Position and cannot be changed.
  E['Insect Princess'] = {
    *stateCheck(e, _m, p) {
      for (const m of faceUpMonsters(e, other(p))) {
        if (raceOf(e, m) !== 'Insect') continue;
        if (m.pos === 'def') changePos(e, m);
        tag(m).lockPosTurn = e.state.turn;
      }
    },
    ...battleKill(function* (e, me, victim) {
      if (info(e, victim).race === 'Insect') boostPerm(me, 500);
    }),
  };

  E['Iron Blacksmith Kotetsu'] = {
    *flip(e, _m, p) {
      yield* searchDeck(e, p, 'Kotetsu: add which Equip Spell?', (c) => isSpell(e, c) && info(e, c).sub === 'Equip');
    },
  };

  E['Jinzo - Lord'] = {
    ...nomi(),
    sealsTraps: true,
    negatesTraps: true,
    summonProc: {
      can: (e, _c, p) => e.monsters(p).some((m) => m.faceUp && e.isNamed(m, 'Jinzo')),
      *run(e, c, p) {
        const j = yield* pickOne(e, p, 'Jinzo - Lord: send which "Jinzo" to the GY?', e.monsters(p).filter((m) => m.faceUp && e.isNamed(m, 'Jinzo')), true);
        if (!j) return;
        yield* e.sendToGrave(j.uid, 'cost');
        yield* procSummon(e, c, p);
      },
    },
    ignition: {
      can: (e) => allST(e).some((c) => c.faceUp && isTrap(e, c)),
      *run(e, _m, p) {
        const list = allST(e).filter((c) => c.faceUp && isTrap(e, c)).map((c) => c.uid);
        yield* e.destroy(list);
        const n = list.filter((u) => !e.fieldCard(u)).length;
        if (n) e.damage(other(p), n * 300);
      },
    },
  };

  // ===================== Spells =====================
  E['Generation Next'] = (() => {
    const test = (e: Engine, c: Card, diff: number) => mainMonster(e, c) && (named(e, c, 'Elemental HERO') || named(e, c, 'Kuriboh') || named(e, c, 'Neo-Spacian')) && atkInfo(e, c) <= diff;
    const diff = (e: Engine, p: Pid) => e.player(other(p)).lp - e.player(p).lp;
    return {
      canActivate: (e, c, p, t) => anyTime(t) && e.oncePerTurn(c.name, p) && diff(e, p) > 0 && [...e.player(p).deck, ...e.player(p).gy].some((x) => test(e, x, diff(e, p))),
      *activate(e, link, p) {
        e.useOnce(link.card.name, p);
      },
      *resolve(e, _l, p) {
        const d = diff(e, p);
        if (d <= 0) return;
        const ps = e.player(p);
        const c = yield* pickOne(e, p, 'Generation Next: take which monster?', [...ps.deck, ...ps.gy].filter((x) => test(e, x, d)));
        if (!c) return;
        const fromDeck = e.find(c.uid)?.loc.zone === 'deck';
        // "For the rest of this turn, you cannot activate cards, or the effects of cards, with the same name" (engine fx.turnNameLocks;
        // approximation: it covers card activations and Quick Effects, not a face-up monster's ignition effects).
        const locks = ((e.state.fx.turnNameLocks ?? []) as { p: Pid; name: string; turn: number }[]).filter((x) => x.turn === e.state.turn);
        e.state.fx.turnNameLocks = [...locks, { p, name: c.name, turn: e.state.turn }];
        if (freeMZ(e, p) && (yield* e.yesno(p, `Special Summon ${c.name}? (No = add it to your hand)`))) yield* e.specialSummon(c.uid, p, 'atk');
        else e.toHandOf(c.uid, p);
        if (fromDeck) ps.deck = e.shuffle(ps.deck);
      },
    };
  })();

  E['Gift of the Martyr'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.monsters(p).length >= 2 && faceUpMonsters(e, p).length >= 1,
    *activate(e, link, p) {
      const mine = e.monsters(p);
      const cands = mine.filter((m) => mine.some((x) => x.uid !== m.uid && x.faceUp));
      const s = yield* pick(e, p, 'Gift of the Martyr: send which monster to the GY?', cands, 1, 1, true, false);
      if (!s || !s[0]) return false;
      link.payload = e.atkOf(s[0]);
      yield* e.sendToGrave(s[0].uid, 'cost');
    },
    *resolve(e, link, p) {
      const t = yield* pickOne(e, p, 'Gift of the Martyr: which monster gains the ATK?', faceUpMonsters(e, p));
      if (t) boostTurn(t, (link.payload as number) ?? 0);
    },
  };

  E['Goblin Circus'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    *onEndPhase(e, _fc, p) {
      const ps = e.player(p);
      const c = ps.deck[ps.deck.length - 1];
      if (e.state.turnPlayer !== p || !c) return;
      e.log(p, `Goblin Circus reveals ${c.name} from the bottom of the Deck`);
      const i = yield* chooseOption(e, p, `Goblin Circus: ${c.name}`, ['Place it on top of the Deck', 'Banish it face-down']);
      if (ps.deck[ps.deck.length - 1]?.uid !== c.uid) return;
      if (i === 1) e.banish(c.uid);
      else ps.deck.unshift(ps.deck.pop()!);
    },
  };

  E['Golden Gearbox'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && faceUpMonsters(e).some((m) => named(e, m, 'Karakuri')),
    *resolve(e, _l, p) {
      const t = yield* pickOne(e, p, 'Golden Gearbox: which "Karakuri" monster?', faceUpMonsters(e).filter((m) => named(e, m, 'Karakuri')));
      if (t) boostTurn(t, 500, 1500);
    },
  };

  E['Grand Convergence'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && !!e.anyActive('Macro Cosmos', p),
    *resolve(e, _l, p) {
      if (!e.anyActive('Macro Cosmos', p)) return;
      e.damage(other(p), 300);
      if (e.state.winner === null) yield* e.destroy(allMonsters(e).map((m) => m.uid));
    },
  };

  E["Gravekeeper's Stele"] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).gy.filter((c) => isMonster(e, c) && isGK(c)).length >= 2,
    *activate(e, link, p) {
      const chosen = yield* pick(e, p, "Gravekeeper's Stele: add which 2 \"Gravekeeper's\" monsters?", e.player(p).gy.filter((c) => isMonster(e, c) && isGK(c)), 2, 2, true);
      if (!chosen) return false;
      link.payload = chosen.map((c) => c.uid);
    },
    *resolve(e, link, p) {
      // "This effect cannot be negated by the effect of Necrovalley."
      for (const u of link.payload as number[]) if (e.find(u)?.loc.zone === 'gy') necroFree(e, () => e.toHandOf(u, p));
    },
  };

  E['Gravity Axe - Grarl'] = {
    ...h.equip(() => ({ atk: 500, def: 0 })),
    // Checked after every action while it is equipped: the opponent's monsters cannot change their battle positions.
    *stateCheck(e: Engine, fc: FieldCard, p: Pid) {
      if (fc.equippedTo === undefined) return;
      for (const m of e.monsters(other(p))) tag(m).lockPosTurn = e.state.turn;
    },
  };

  // Damage you deal yourself (your own costs) still counts: only battle and your opponent's effects are stopped.
  E['Hallowed Life Barrier'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.player(p).hand.length > 0,
    *activate(e, _l, p) {
      if (!(yield* discardCost(e, p, 1))) return false;
    },
    *resolve(e, _l, p) {
      ((e.state.fx.noOppDamage ??= [-1, -1]) as number[])[p] = e.state.turn;
      e.log(p, `Damage ${e.player(p).name} takes from the opponent's cards becomes 0 this turn`);
    },
  };

  E['Hammer Shot'] = {
    canActivate: (e, _c, _p, t) => isMain(t) && faceUpMonsters(e).some((m) => m.pos === 'atk'),
    *resolve(e, _l, p) {
      const list = faceUpMonsters(e).filter((m) => m.pos === 'atk');
      if (!list.length) return;
      const best = Math.max(...list.map((m) => e.atkOf(m)));
      const t = yield* pickOne(e, p, 'Hammer Shot: destroy which monster?', list.filter((m) => e.atkOf(m) === best));
      if (t) yield* e.destroy([t.uid]);
    },
  };

  // Piercing until the end of the turn: tags.pierceTurn (engine).
  E['H - Heated Heart'] = {
    canActivate: (e, _c, p, t) => isMain(t) && targetable(e, faceUpMonsters(e, p)).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'H - Heated Heart: target which monster?', targetable(e, faceUpMonsters(e, p)), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m?.faceUp) return;
      boostTurn(m, 500);
      tag(m).pierceTurn = e.state.turn;
    },
  };

  E['Infinite Cards'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    // The hand limit is lifted for each End Phase while this card is face-up, and restored afterwards.
    *onEndPhase(e) {
      if (e.state.fx.handLimitBase === undefined) e.state.fx.handLimitBase = e.rules.handLimit;
      e.state.rules = { ...e.rules, handLimit: 999 };
    },
    *onStandby(e) {
      restoreHandLimit(e);
    },
    *onLeaveField(e) {
      restoreHandLimit(e);
    },
  };
  function restoreHandLimit(e: Engine) {
    if (e.state.fx.handLimitBase === undefined) return;
    e.state.rules = { ...e.rules, handLimit: e.state.fx.handLimitBase };
    delete e.state.fx.handLimitBase;
  }

  E['Insect Barrier'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    blocksAttack: (e, card, m, attacker) => attacker !== ctrl(e, card) && raceOf(e, m) === 'Insect',
  };

  E['Insect Neglect'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    quick: {
      repeat: true,
      label: 'banish an Insect to negate the attack',
      can: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null && e.player(p).gy.some((c) => isMonster(e, c) && info(e, c).race === 'Insect'),
      *cost(e, _c, p) {
        const b = yield* pickOne(e, p, 'Insect Neglect: banish which Insect?', e.player(p).gy.filter((c) => isMonster(e, c) && info(e, c).race === 'Insect'), true);
        if (!b) return false;
        e.banish(b.uid);
      },
      *run(e, _c, p) {
        if (!e.state.battle) return;
        e.log(p, 'Insect Neglect negates the attack');
        e.endBattle();
      },
    },
  };

  // "For the rest of this turn you can only Special Summon once": after your first Special Summon, a summon lock blocks the rest.
  E['Iron Draw'] = {
    lingering: {
      *onAnySummon(e, owner, _m, controller, kind) {
        if (kind !== 'special' || controller !== owner) return;
        const locks = ((e.state.fx.summonLocks ??= []) as { p: Pid; turn: number; normal: boolean; special: boolean; only?: string[] }[]).filter((l) => l.turn === e.state.turn);
        if (!locks.some((l) => l.p === owner && l.special && l.only?.length === 0)) locks.push({ p: owner, turn: e.state.turn, normal: false, special: true, only: [] });
        e.state.fx.summonLocks = locks;
      },
    },
    canActivate: (e, c, p, t) => {
      const mine = e.monsters(p);
      return isMain(t) && e.oncePerTurn(c.name, p) && e.player(p).deck.length >= 2 && mine.length === 2 && mine.every((m) => m.faceUp && raceOf(e, m) === 'Machine' && isEffectMonster(e, m));
    },
    *activate(e, link, p) {
      e.useOnce(link.card.name, p);
    },
    *resolve(e, _l, p) {
      e.draw(p, 2);
      e.linger('Iron Draw', p);
    },
  };

  E['Hidden Armory'] = {
    canActivate: (e, _c, p, t) => isMain(t) && !e.player(p).normalSummoned && e.player(p).deck.length > 0 && [...e.player(p).deck, ...e.player(p).gy].some((c) => isSpell(e, c) && info(e, c).sub === 'Equip'),
    *activate(e, _l, p) {
      yield* millTop(e, p, 1);
      // "You cannot Normal Summon/Set the turn you activate this card."
      e.player(p).normalSummoned = true;
    },
    *resolve(e, _l, p) {
      const ps = e.player(p);
      const c = yield* pickOne(e, p, 'Hidden Armory: add which Equip Spell?', [...ps.deck, ...ps.gy].filter((x) => isSpell(e, x) && info(e, x).sub === 'Equip'));
      if (!c) return;
      const fromDeck = e.find(c.uid)?.loc.zone === 'deck';
      e.toHandOf(c.uid, p);
      if (fromDeck) ps.deck = e.shuffle(ps.deck);
    },
  };

  E['Guts of Steel'] = {
    canActivate: (e, _c, p, t) => isMain(t) && (freeMZ(e, p) || freeMZ(e, other(p))) && e.player(p).gy.filter((c) => mainMonster(e, c) && named(e, c, 'Scrap')).length >= 3,
    *activate(e, link, p) {
      const chosen = yield* pick(e, p, 'Guts of Steel: select 3 "Scrap" monsters', e.player(p).gy.filter((c) => mainMonster(e, c) && named(e, c, 'Scrap')), 3, 3, true);
      if (!chosen) return false;
      link.payload = chosen.map((c) => c.uid);
    },
    *resolve(e, link, p) {
      const left = (link.payload as number[]).map((u) => e.find(u)).filter((f) => f?.loc.zone === 'gy').map((f) => f!.card);
      if (!left.length) return;
      const c = yield* pickOne(e, other(p), 'Guts of Steel: pick the monster your opponent Special Summons', left);
      if (!c) return;
      const sides = ([p, other(p)] as Pid[]).filter((q) => freeMZ(e, q));
      if (sides.length) {
        const i = sides.length > 1 ? yield* chooseOption(e, p, `Guts of Steel: Special Summon ${c.name} to whose field?`, ['Your field', "Your opponent's field"]) : 0;
        yield* e.specialSummon(c.uid, sides[i ?? 0], 'atk');
      }
      for (const x of left) if (x.uid !== c.uid && e.find(x.uid)?.loc.zone === 'gy') e.banish(x.uid);
    },
  };

  // ===================== Traps =====================
  E['Gem-Enhancement'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.monsters(p).some((m) => named(e, m, 'Gem-Knight') && !e.untributable(m)),
    *activate(e, link, p) {
      if (!(yield* tributeCost(e, p, 1, (m) => named(e, m, 'Gem-Knight')))) return false;
      const t = yield* pickOne(e, p, 'Gem-Enhancement: Special Summon which "Gem-Knight" monster?', e.player(p).gy.filter((c) => isMonster(e, c) && named(e, c, 'Gem-Knight')));
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid !== undefined && e.find(link.targetUid)?.loc.zone === 'gy' && freeMZ(e, p)) yield* e.specialSummon(link.targetUid, p, 'atk');
    },
  };

  // Approximations: the search is used in your own Main Phase; the Draw Phase effect happens in the opponent's Standby Phase, right
  // after the normal draw; of the GY lock, Special Summons from the GY and GY effects put on a chain are covered.
  const gkTrapTest = (e: Engine, c: Card) => isMonster(e, c) && (isGK(c) || (attrOf(e, c) === 'EARTH' && info(e, c).race === 'Fairy'));
  const exchangeInGy = (e: Engine, p: Pid) => e.player(p).gy.some((c) => e.isNamed(c, 'Exchange of the Spirit'));
  E["Gravekeeper's Trap"] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve(e, link) {
      tag(link.card as FieldCard).upTurn = e.state.turn;
    },
    forbidsSummon: (e, _card, controller, _monster, summoner, how, from) => how === 'special' && from === 'gy' && summoner === other(controller) && exchangeInGy(e, controller),
    negatesEffect: (e, _card, controller, link) => link.player === other(controller) && link.loc.zone === 'gy' && !!(link.payload as { effect?: string } | undefined)?.effect && exchangeInGy(e, controller),
    *onStandby(e, fc, p) {
      const q = other(p);
      const d = e.state.fx.normalDraw as { player: Pid; uid: number; turn: number } | undefined;
      if (e.state.turnPlayer !== q || !d || d.player !== q || d.turn !== e.state.turn || (fc.tags?.upTurn ?? -1) >= e.state.turn) return;
      if (!e.oncePerTurn("Gravekeeper's Trap:draw", p)) return;
      const names = declarable(e);
      const i = yield* chooseOption(e, p, "Gravekeeper's Trap: declare a card name (cancel = do not use it)", names, true);
      if (i === null) return;
      e.useOnce("Gravekeeper's Trap:draw", p);
      e.log(p, `${e.player(p).name} declares ${names[i]}`);
      const drawn = e.find(d.uid);
      if (!drawn || drawn.loc.zone !== 'hand') return;
      yield* e.reveal(p, 'The card drawn', [drawn.card]);
      if (drawn.card.name === names[i]) {
        yield* e.as(p, e.sendToGrave(drawn.card.uid, 'used'));
        e.log(p, `Gravekeeper's Trap sends ${drawn.card.name} to the GY`);
      }
    },
    ignition: {
      can: (e, m, p) => e.oncePerTurn(m.name, p) && e.player(p).hand.length > 0 && e.player(p).deck.some((c) => gkTrapTest(e, c)),
      *run(e, m, p) {
        if (!(yield* discardCost(e, p, 1))) return;
        e.useOnce(m.name, p);
        yield* searchDeck(e, p, "Gravekeeper's Trap: add which monster?", (c) => gkTrapTest(e, c));
      },
    },
    // spells-d: "During the Main Phase" is either player's: in the opponent's Main Phase it is used in a response window (discard as the cost).
    quick: {
      repeat: true,
      label: 'discard 1: add a "Gravekeeper\'s" or EARTH Fairy monster',
      can: (e, c, p) => e.state.turnPlayer === other(p) && e.inMainPhase() && e.oncePerTurn(c.name, p) && e.player(p).hand.length > 0 && e.player(p).deck.some((x) => gkTrapTest(e, x)),
      *cost(e, card, p) {
        if (!(yield* discardCost(e, p, 1))) return false;
        e.useOnce(card.name, p);
      },
      *run(e, _c, p) {
        yield* searchDeck(e, p, "Gravekeeper's Trap: add which monster?", (c) => gkTrapTest(e, c));
      },
    },
  };

  E['Gravelstorm'] = {
    canActivate: (e, c, p, t) => anyTime(t) && stOf(e, p).some((x) => x.uid !== c.uid) && stOf(e, other(p)).length > 0,
    *activate(e, link, p) {
      const a = yield* pickOne(e, p, 'Gravelstorm: return which of your Spells/Traps?', stOf(e, p).filter((x) => x.uid !== link.card.uid), true);
      if (!a) return false;
      const b = yield* pickOne(e, p, "Gravelstorm: return which of your opponent's Spells/Traps?", stOf(e, other(p)), true);
      if (!b) return false;
      link.payload = [a.uid, b.uid];
    },
    *resolve(e, link) {
      for (const u of link.payload as number[]) if (e.fieldCard(u) && u !== link.card.uid) yield* returnST(e, u);
    },
  };

  // "The activated effect becomes 'Destroy that monster'": the effect is negated and the "Graydle" monster is destroyed right away
  // (approximation: as Graydle Combat resolves, not when that chain link resolves).
  E['Graydle Combat'] = {
    canActivate: (e, _c, p, t, ctx) => {
      if (!(t === 'spell' || t === 'trap' || t === 'effect') || !ctx.link || ctx.link.targetUid === undefined) return false;
      // spells-d: "a Spell/Trap Card, or monster effect": not the later effect of a Spell/Trap already on the field.
      if ((ctx.link.payload as { effect?: string } | undefined)?.effect && !isMonster(e, ctx.link.card)) return false;
      const m = e.fieldCard(ctx.link.targetUid);
      return !!m && m.faceUp && named(e, m, 'Graydle') && e.controller(m.uid) === p && isMonster(e, m);
    },
    *activate(e, link, p, ctx) {
      const i = yield* chooseOption(e, p, 'Graydle Combat: activate which effect?', ['The activated effect becomes "Destroy that monster"', 'Negate the activation, and if you do, destroy that card']);
      link.payload = { target: ctx.link, mode: i ?? 1 };
    },
    *resolve(e, link, p) {
      const { target, mode } = (link.payload ?? {}) as { target?: ChainLink; mode?: number };
      if (!target) return;
      if (mode === 0) {
        const mon = target.targetUid !== undefined ? e.fieldCard(target.targetUid) : null;
        target.negated = true;
        e.log(p, `${target.card.name}'s effect becomes "Destroy that monster"`);
        if (mon) yield* e.as(target.player, e.destroy([mon.uid]));
        return;
      }
      negateLink(e, target, p);
      if (target.negated && e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
    },
  };

  E['Half Counter'] = {
    canActivate: (e, _c, p, t) => {
      const b = e.state.battle;
      if (t !== 'attack' || !b || b.target === null) return false;
      const m = e.fieldCard(b.target);
      return !!m && m.faceUp && e.controller(m.uid) === p && !!e.fieldCard(b.attacker) && !e.untargetable(m);
    },
    *activate(e, link) {
      const b = e.state.battle!;
      link.targetUid = b.target!;
      link.payload = Math.floor(atkInfo(e, e.fieldCard(b.attacker)!) / 2);
    },
    *resolve(e, link) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (m?.faceUp) boostTurn(m, link.payload as number);
    },
  };

  E['Haunted Shrine'] = (() => {
    const zombies = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => mainMonster(e, c) && info(e, c).race === 'Zombie');
    const ok = (e: Engine, p: Pid) => e.oncePerTurn('Haunted Shrine', p) && e.monsters(p).length === 0 && zombies(e, p).length > 0;
    return {
      canActivate: (e, _c, p, t) => anyTime(t) && ok(e, p),
      *activate(e, link, p) {
        const z = yield* pickOne(e, p, 'Haunted Shrine: Special Summon which Zombie?', zombies(e, p), true);
        if (!z) return false;
        e.useOnce('Haunted Shrine', p);
        link.targetUid = z.uid;
      },
      *resolve(e, link, p) {
        if (link.targetUid !== undefined && e.find(link.targetUid)?.loc.zone === 'gy' && freeMZ(e, p)) yield* e.specialSummon(link.targetUid, p, 'atk');
      },
      graveIgnition: {
        can: (e, _c, p) => ok(e, p),
        *run(e, card, p) {
          const z = yield* pickOne(e, p, 'Haunted Shrine: Special Summon which Zombie (effects negated)?', zombies(e, p), true);
          if (!z) return;
          e.useOnce('Haunted Shrine', p);
          e.banish(card.uid);
          yield* e.specialSummon(z.uid, p, 'atk');
          const m = e.fieldCard(z.uid);
          if (m) negateMonster(e, m, false);
        },
      },
    } as EffectDef;
  })();

  E['Hero Blast'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.player(p).gy.some((c) => isNormalMonster(e, c) && named(e, c, 'Elemental HERO')),
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Hero Blast: add which "Elemental HERO" Normal Monster?', e.player(p).gy.filter((x) => isNormalMonster(e, x) && named(e, x, 'Elemental HERO')), true);
      if (!c) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      const f = link.targetUid !== undefined ? e.find(link.targetUid) : null;
      if (!f || f.loc.zone !== 'gy') return;
      e.toHandOf(f.card.uid, p);
      const atk = atkInfo(e, f.card);
      const list = faceUpMonsters(e, other(p)).filter((m) => e.atkOf(m) <= atk);
      const t = yield* pickOne(e, p, 'Hero Blast: destroy which monster?', list);
      if (t) yield* e.destroy([t.uid]);
    },
  };

  const myBattleLoss = (e: Engine, p: Pid, t: string, uid: number | undefined, prev: Pid | undefined, test: (c: Card) => boolean) => {
    if (t !== 'destroyed' || prev !== p || uid === undefined) return false;
    const f = e.find(uid);
    return !!f && f.loc.zone === 'gy' && test(f.card);
  };
  E['Hero Counterattack'] = {
    canActivate: (e, _c, p, t, ctx) => myBattleLoss(e, p, t, ctx.uid, ctx.prevController, (c) => named(e, c, 'Elemental HERO')) && e.player(p).hand.length > 0,
    *resolve(e, _l, p) {
      const hand = e.player(p).hand;
      if (!hand.length) return;
      const c = hand[Math.floor(e.rand() * hand.length)];
      e.log(other(p), `Hero Counterattack reveals ${c.name}`);
      yield* e.reveal(other(p), 'Hero Counterattack: the chosen card', [c]);
      if (!mainMonster(e, c) || !named(e, c, 'Elemental HERO')) return;
      const t = yield* pickOne(e, p, 'Hero Counterattack: destroy which monster?', e.monsters(other(p)));
      if (t) yield* e.destroy([t.uid]);
      if (e.find(c.uid)?.loc.zone === 'hand' && freeMZ(e, p)) yield* e.specialSummon(c.uid, p, 'atk');
    },
  };

  E['Hero Signal'] = {
    canActivate: (e, _c, p, t, ctx) =>
      myBattleLoss(e, p, t, ctx.uid, ctx.prevController, () => true) &&
      freeMZ(e, p) &&
      [...e.player(p).hand, ...e.player(p).deck].some((c) => mainMonster(e, c) && named(e, c, 'Elemental HERO') && levelOf(e, c) <= 4),
    *resolve(e, _l, p) {
      const ps = e.player(p);
      yield* summonOneOf(e, p, 'Hero Signal: Special Summon which "Elemental HERO"?', [...ps.hand, ...ps.deck].filter((c) => mainMonster(e, c) && named(e, c, 'Elemental HERO') && levelOf(e, c) <= 4));
    },
  };

  E['Hidden Soldiers'] = {
    canActivate: (e, _c, p, t, ctx) => t === 'summon' && !!opponentSummon(e, p, t, ctx) && freeMZ(e, p) && e.player(p).hand.some((c) => mainMonster(e, c) && attrOf(e, c) === 'DARK' && levelOf(e, c) <= 4),
    *resolve(e, _l, p) {
      yield* summonOneOf(e, p, 'Hidden Soldiers: Special Summon which DARK monster?', e.player(p).hand.filter((c) => mainMonster(e, c) && attrOf(e, c) === 'DARK' && levelOf(e, c) <= 4));
    },
  };

  E['Hieratic Seal From the Ashes'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    quick: {
      label: 'send a "Hieratic" monster from the Deck to the GY',
      can: (e, _c, p, t) => anyTime(t) && e.state.turnPlayer === other(p) && e.player(p).deck.some((c) => isMonster(e, c) && named(e, c, 'Hieratic')),
      *run(e, _c, p) {
        yield* deckToGrave(e, p, 'Send which "Hieratic" monster to the GY?', (c) => isMonster(e, c) && named(e, c, 'Hieratic'));
      },
    },
    ignition: {
      can: (e, _m, p) => e.player(p).removed.some((c) => isMonster(e, c) && named(e, c, 'Hieratic')),
      *run(e, _m, p) {
        const c = yield* pickOne(e, p, 'Return which banished "Hieratic" monster to the GY?', e.player(p).removed.filter((x) => isMonster(e, x) && named(e, x, 'Hieratic')));
        if (c) yield* e.sendToGrave(c.uid, 'used');
      },
    },
    *onLeaveField(e, fc) {
      fx<Record<number, number>>(e, 'hieraticSeal', {})[fc.uid] = fc.faceUp && fc.active ? 1 : 0;
    },
    *onSentToGrave(e, card, p, from) {
      const flags = fx<Record<number, number>>(e, 'hieraticSeal', {});
      const was = flags[card.uid];
      delete flags[card.uid];
      if (from !== 'sz' || !was) return;
      yield* summonOneOf(e, p, 'Hieratic Seal From the Ashes: Special Summon which "Hieratic" monster?', e.player(p).gy.filter((c) => mainMonster(e, c) && named(e, c, 'Hieratic')));
    },
  };

  // A mandatory effect, applied after every battle in which your monster destroyed an opponent's monster and sent it to the GY.
  E['Howl of the Wild'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    *afterAnyBattle(e, _card, p, attacker, target) {
      const mine = e.controller(attacker.uid) === p ? attacker : e.controller(target.uid) === p ? target : null;
      const foe = mine === attacker ? target : attacker;
      if (!mine || !e.fieldCard(mine.uid) || foe.owner !== other(p) || e.find(foe.uid)?.loc.zone !== 'gy') return;
      const n = faceUpMonsters(e, p).filter((m) => raceOf(e, m) === 'Beast').length;
      if (n) e.damage(other(p), n * 300);
    },
  };

  E['Hunting Instinct'] = {
    canActivate: (e, _c, p, t, ctx) => t === 'special' && !!opponentSummon(e, p, t, ctx) && freeMZ(e, p) && e.player(p).hand.some((c) => mainMonster(e, c) && info(e, c).race === 'Dinosaur'),
    *resolve(e, _l, p) {
      yield* summonOneOf(e, p, 'Hunting Instinct: Special Summon which Dinosaur?', e.player(p).hand.filter((c) => mainMonster(e, c) && info(e, c).race === 'Dinosaur'));
    },
  };

  // "During this Battle Phase" lasts until the end of the turn (Speed Duel has no Main Phase 2: the End Phase follows).
  E['Impenetrable Attack'] = {
    canActivate: (e, _c, _p, t) => e.state.phase === 'BP' && anyTime(t),
    *activate(e, link, p) {
      const mons = targetable(e, allMonsters(e).filter((m) => m.faceUp));
      const opts = [...(mons.length ? ['A monster cannot be destroyed by battle or card effects'] : []), 'You take no battle damage'];
      const i = yield* chooseOption(e, p, 'Impenetrable Attack: activate which effect?', opts);
      if (i === null) return false;
      if (opts[i].startsWith('A monster')) {
        const m = yield* pickOne(e, p, 'Impenetrable Attack: target which monster?', mons, true);
        if (!m) return false;
        link.targetUid = m.uid;
      }
    },
    *resolve(e, link, p) {
      if (link.targetUid === undefined) {
        noBattleDamage(e, p, true);
        e.log(p, `${e.player(p).name} takes no battle damage during this Battle Phase`);
        return;
      }
      const m = e.fieldCard(link.targetUid);
      if (!m?.faceUp) return;
      tag(m).battleSafeTurn = e.state.turn;
      tag(m).effProofTurn = e.state.turn;
      e.log(p, `${m.name} cannot be destroyed by battle or card effects during this Battle Phase`);
    },
  };

  E['Infestation Wave'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.monsters(p).some((m) => m.faceUp && named(e, m, 'Steelswarm') && !!m.tags?.tribS) && [...targetable(e, e.monsters(other(p))), ...stOf(e, other(p))].length > 0,
    *activate(e, link, p) {
      const s = yield* pickOne(e, p, 'Infestation Wave: return which "Steelswarm" monster?', e.monsters(p).filter((m) => m.faceUp && named(e, m, 'Steelswarm') && !!m.tags?.tribS), true);
      if (!s) return false;
      yield* bounce(e, s.uid);
      const t = yield* pickOne(e, p, 'Infestation Wave: destroy which card?', [...targetable(e, e.monsters(other(p))), ...stOf(e, other(p))]);
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link) {
      if (link.targetUid !== undefined && e.fieldCard(link.targetUid)) yield* e.destroy([link.targetUid]);
    },
  };

  E['Inspiration'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && targetable(e, faceUpMonsters(e, p)).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Inspiration: target which monster?', targetable(e, faceUpMonsters(e, p)), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (m?.faceUp) boostTurn(m, 700);
    },
  };

  // Swaps the current values (later changes are not swapped back).
  E['Inverse Universe'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && faceUpMonsters(e).some((m) => isEffectMonster(e, m)),
    *resolve(e) {
      for (const m of faceUpMonsters(e).filter((x) => isEffectMonster(e, x))) {
        const a = e.atkOf(m);
        const d = e.defOf(m);
        boostPerm(m, d - a, a - d);
      }
      e.log(null, 'Inverse Universe switches the ATK and DEF of every Effect Monster');
    },
  };

  const jamDefend = function* (e: Engine, p: Pid): Step {
    const b = e.state.battle;
    if (!b || b.target === null || e.controller(b.attacker) !== other(p)) return;
    const jams = faceUpMonsters(e, p).filter((m) => e.isNamed(m, 'Revival Jam') && m.uid !== b.target);
    const j = yield* pickOne(e, p, 'Jam Defender: switch the attack to which "Revival Jam"?', jams);
    if (j && e.state.battle) {
      e.state.battle.target = j.uid;
      e.log(p, 'Jam Defender switches the attack target to Revival Jam');
    }
  };
  const jamCan = (e: Engine, p: Pid) => {
    const b = e.state.battle;
    return !!b && b.target !== null && e.controller(b.attacker) === other(p) && e.controller(b.target) === p && faceUpMonsters(e, p).some((m) => e.isNamed(m, 'Revival Jam') && m.uid !== b.target);
  };
  E['Jam Defender'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve(e, _l, p) {
      if (jamCan(e, p)) yield* jamDefend(e, p);
    },
    quick: {
      repeat: true,
      label: 'switch the attack to Revival Jam',
      can: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null && jamCan(e, p),
      *run(e, _c, p) {
        if (jamCan(e, p)) yield* jamDefend(e, p);
      },
    },
  };

  E['Jar of Greed'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.player(p).deck.length > 0,
    *resolve(e, _l, p) {
      e.draw(p, 1);
    },
  };
}
