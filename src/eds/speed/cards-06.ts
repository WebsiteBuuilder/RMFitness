// Speed Duel card scripts, batch 06 (Galaxy-Eyes Cloudragon ... Jinzo - Lord).
import type { EffectDef } from '../effects';
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
const isGK = (c: Card | string) => named(c, GK);
const EXTRA_SUBS = ['Fusion', 'Ritual', 'Xyz', 'Synchro', 'Link'];
/** Monsters that live in the Extra Deck. */
const EXTRA_DECK = ['Fusion', 'Xyz', 'Synchro', 'Link'];
/** A monster that can be Special Summoned from the Deck/hand/GY by a plain effect (no Extra Deck or Ritual monsters). */
const mainMonster = (e: Engine, c: Card) => isMonster(e, c) && !EXTRA_SUBS.includes(info(e, c).sub);
const atkInfo = (e: Engine, c: Card) => Math.max(0, info(e, c).atk ?? 0);
const defInfo = (e: Engine, c: Card) => Math.max(0, info(e, c).def ?? 0);
/** Cards whose name is treated as "Harpie Lady" (the engine itself only knows the printed name). */
const HARPIE_LADIES = ['Harpie Lady', 'Cyber Harpie Lady', 'Harpie Lady 1', 'Harpie Lady 2', 'Harpie Lady 3', 'Harpie Channeler', 'Harpie Dancer', 'Harpie Queen'];
const isHarpieLady = (c: Card | string) => HARPIE_LADIES.includes(typeof c === 'string' ? c : c.name);
const fieldFaceUp = (e: Engine) => [0, 1].some((q) => !!e.player(q as Pid).field?.faceUp);
/** "Necrovalley" on the field: the real card, or Gravekeeper's Priestess while there is no face-up Field Spell. */
const necro = (e: Engine) => !!e.anyActive('Necrovalley') || (!fieldFaceUp(e) && faceUpMonsters(e).some((m) => m.name === "Gravekeeper's Priestess" && !e.isNegated(m)));
const fx = <T>(e: Engine, key: string, init: T): T => (e.state.fx[key] ??= init) as T;

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
  e.toHand(uid);
  e.log(p, `${fc.name} returns to the hand`);
  const h = e.effectOn({ uid, name: fc.name, owner: fc.owner })?.onLeaveField;
  if (h) yield* h(e, fc, p, 'bounce');
}
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
/** Giant Orc, Goblin Attack Force: Defense Position after attacking (Speed Duel has no Main Phase 2, so the End Phase follows the Battle Phase), locked until the end of the next own turn. */
const tiresAfterAttack: EffectDef = {
  *onEndPhase(e, m, p) {
    const t = tag(m);
    if (t.posLockUntil !== undefined && e.state.turn >= t.posLockUntil) {
      m.cannotChangePos = false;
      delete t.posLockUntil;
    }
    if (e.state.turnPlayer === p && e.state.attackedThisTurn.includes(m.uid) && m.faceUp) {
      if (m.pos === 'atk') changePos(e, m);
      m.cannotChangePos = true;
      t.posLockUntil = e.state.turn + 2;
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
  // The Xyz-attach effect does nothing in Speed Duel (no Xyz Monsters).
  E['Galaxy-Eyes Cloudragon'] = {
    ignition: {
      can: (e, m, p) => e.oncePerTurn(m.name, p) && [...e.player(p).hand, ...e.player(p).gy].some((c) => named(c, 'Galaxy-Eyes') && c.name !== m.name && mainMonster(e, c)),
      *run(e, m, p) {
        if (!e.fieldCard(m.uid)) return;
        e.useOnce(m.name, p);
        yield* e.sendToGrave(m.uid, 'tribute');
        const ps = e.player(p);
        yield* summonOneOf(e, p, 'Galaxy-Eyes Cloudragon: Special Summon which "Galaxy-Eyes" monster?', [...ps.hand, ...ps.gy].filter((c) => named(c, 'Galaxy-Eyes') && c.name !== 'Galaxy-Eyes Cloudragon' && mainMonster(e, c)));
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
    cannotNormalSummon: true,
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && e.player(p).gy.some((c) => isMonster(e, c) && attrOf(e, c) === 'WIND'),
      *run(e, c, p) {
        const b = yield* pickOne(e, p, 'Garuda: banish which WIND monster from your GY?', e.player(p).gy.filter((g) => isMonster(e, g) && attrOf(e, g) === 'WIND'), true);
        if (!b) return;
        e.banish(b.uid);
        yield* e.specialSummon(c.uid, p, 'atk');
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

  E['Gear Golem the Moving Fortress'] = {
    ignition: {
      can: (e, m, p) => e.player(p).lp > 800 && m.tags?.directTurn !== e.state.turn,
      *run(e, m, p) {
        if (payLp(e, p, 800)) tag(m).directTurn = e.state.turn;
      },
    },
    directAttack: (e, m) => m.tags?.directTurn === e.state.turn,
  };

  // Only the second effect: the engine has no hook for "a card is equipped to this card".
  const redEyesTargets = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => mainMonster(e, c) && named(c, 'Red-Eyes') && levelOf(e, c) <= 7);
  E['Gearfried the Red-Eyes Iron Knight'] = {
    ignition: {
      can: (e, m, p) => m.equips.some((u) => e.controller(u) === p) && redEyesTargets(e, p).length > 0,
      *run(e, m, p) {
        const eqs = m.equips.map((u) => e.fieldCard(u)).filter((c): c is FieldCard => !!c && e.controller(c.uid) === p);
        const eq = yield* pickOne(e, p, 'Gearfried: send which Equip Card to the GY?', eqs);
        if (!eq) return;
        yield* e.sendToGrave(eq.uid, 'cost');
        yield* summonOneOf(e, p, 'Gearfried: Special Summon which "Red-Eyes" monster?', redEyesTargets(e, p));
      },
    },
  };

  E['Gem-Knight Emerald'] = {
    ignition: {
      can: (e, m, p) => faceUpMonsters(e, p).some((x) => x.uid !== m.uid && isNormalMonster(e, x)) && e.player(p).gy.some((c) => named(c, 'Gem-Knight') && info(e, c).sub === 'Fusion'),
      *run(e, m, p) {
        const normals = faceUpMonsters(e, p).filter((x) => x.uid !== m.uid && isNormalMonster(e, x));
        const n = yield* pickOne(e, p, 'Gem-Knight Emerald: banish which Normal Monster?', normals);
        if (!n || !e.fieldCard(m.uid)) return;
        e.banish(m.uid);
        e.banish(n.uid);
        yield* summonOneOf(e, p, 'Gem-Knight Emerald: Special Summon which "Gem-Knight" Fusion Monster?', e.player(p).gy.filter((c) => named(c, 'Gem-Knight') && info(e, c).sub === 'Fusion'));
      },
    },
  };

  // The current attack is moved onto it; the lasting "attack only this card" lock has no engine hook.
  E['Gentlemander'] = {
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

  // The 3-Tribute Summon is a summon procedure that uses your Normal Summon for the turn.
  E['Gilford the Lightning'] = {
    summonProc: {
      can: (e, c, p) => e.canNormalSummon(p, c) && e.monsters(p).length >= 3,
      *run(e, c, p) {
        if (!(yield* tributeCost(e, p, 3))) return;
        e.player(p).normalSummoned = true;
        yield* e.specialSummon(c.uid, p, 'atk');
        if (!e.fieldCard(c.uid)) return;
        e.log(p, 'Gilford the Lightning destroys all monsters the opponent controls');
        yield* e.destroy(e.monsters(other(p)).map((m) => m.uid));
      },
    },
  };

  E['Gimmick Puppet Des Troy'] = {
    ignition: {
      can: (e, m) => !m.tags?.desTroyUsed && targetable(e, faceUpMonsters(e)).some((x) => named(x, 'Gimmick Puppet')),
      *run(e, m, p) {
        tag(m).desTroyUsed = 1;
        const t = yield* pickOne(e, p, 'Des Troy: destroy which "Gimmick Puppet" monster?', targetable(e, faceUpMonsters(e)).filter((x) => named(x, 'Gimmick Puppet')));
        if (t && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
      },
    },
    *onSentToGrave(e, _card, p, from) {
      if (from !== 'mz') return;
      const list = () => e.player(p).hand.filter((c) => mainMonster(e, c) && named(c, 'Gimmick Puppet'));
      if (!list().length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Des Troy: Special Summon "Gimmick Puppet" monsters from your hand?'))) return;
      const free = e.player(p).mz.filter((z) => z === null).length;
      const chosen = yield* pick(e, p, 'Special Summon which "Gimmick Puppet" monsters (1 or 2)?', list(), 1, Math.min(2, free));
      for (const c of chosen ?? []) if (e.find(c.uid)?.loc.zone === 'hand') yield* e.specialSummon(c.uid, p, 'atk');
    },
  };

  E['Gimmick Puppet Shadow Feeler'] = {
    battleProof: () => true,
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
  E['Jade Knight'] = searchOnBattleDeath('Jade Knight: add a Level 4 LIGHT Machine monster', (e, c) => isMonster(e, c) && info(e, c).race === 'Machine' && attrOf(e, c) === 'LIGHT' && levelOf(e, c) === 4);

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

  // "You can only control 1" is checked for its own Special Summon only.
  E['Grandmaster of the Six Samurai'] = {
    summonProc: {
      can: (e, c, p) => freeMZ(e, p) && faceUpMonsters(e, p).some((m) => named(m, 'Six Samurai')) && !e.monsters(p).some((m) => m.name === c.name),
      *run(e, c, p) {
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
    onLeaveField: markOppDestroy,
    *onDestroyed(e, card, p, byBattle) {
      if (byBattle || card.owner !== p || !destroyedByOpp(e, card.uid)) return;
      yield* fromGraveToHand(e, p, 'Grandmaster: add which "Six Samurai" monster?', (c) => c.uid !== card.uid && isMonster(e, c) && named(c, 'Six Samurai'));
    },
  };

  E['Granmarg the Rock Monarch'] = {
    *onSummon(e, _m, p, kind) {
      if (kind !== 'normal') return;
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
      if (t && e.find(t.uid)?.loc.zone === 'gy') toDeckBottom(e, t.uid);
    },
    *onSummon(e, m, _p, kind) {
      if (kind === 'normal') delete fx<Record<number, number>>(e, 'ambusherFlipped', {})[m.uid];
    },
    *onSentToGrave(e, card, p, from) {
      const flipped = fx<Record<number, number>>(e, 'ambusherFlipped', {});
      const was = flipped[card.uid];
      delete flipped[card.uid];
      if (from !== 'mz' || !was || !e.player(p).gy.some((c) => named(c, 'Necrovalley'))) return;
      if (yield* e.yesno(p, 'Gravekeeper\'s Ambusher: add a "Necrovalley" card from your GY to your hand?')) yield* fromGraveToHand(e, p, 'Add which "Necrovalley" card?', (c) => named(c, 'Necrovalley'));
    },
  };

  E["Gravekeeper's Assailant"] = {
    quick: {
      label: "change a monster's battle position",
      can: (e, card, p, t) => t === 'attack' && e.state.battle?.attacker === card.uid && necro(e) && targetable(e, faceUpMonsters(e, other(p))).length > 0,
      *run(e, _c, p) {
        const t = yield* pickOne(e, p, "Gravekeeper's Assailant: change which monster's battle position?", targetable(e, faceUpMonsters(e, other(p))));
        if (t && e.fieldCard(t.uid)) changePos(e, t);
      },
    },
  };

  E["Gravekeeper's Cannonholder"] = {
    ignition: {
      repeat: true,
      can: (e, m, p) => e.monsters(p).some((x) => x.uid !== m.uid && x.faceUp && isGK(x) && x.name !== m.name),
      *run(e, m, p) {
        if (yield* tributeCost(e, p, 1, (x) => x.faceUp && isGK(x) && x.name !== m.name)) e.damage(other(p), 700);
      },
    },
  };

  // "You can only control 1 face-up" is not enforced; its GY protection only matters against Necrovalley.
  E["Gravekeeper's Chief"] = {
    *onSummon(e, _m, p, kind) {
      if (kind !== 'normal' || !freeMZ(e, p)) return;
      const list = e.player(p).gy.filter((c) => mainMonster(e, c) && isGK(c));
      if (!list.length || !(yield* e.yesno(p, "Gravekeeper's Chief: Special Summon a \"Gravekeeper's\" monster from your GY?"))) return;
      yield* summonOneOf(e, p, "Special Summon which \"Gravekeeper's\" monster?", list);
    },
  };

  E["Gravekeeper's Commandant"] = {
    handIgnition: {
      can: (e, _c, p) => e.player(p).deck.some((c) => c.name === 'Necrovalley'),
      *run(e, c, p) {
        yield* e.discard(p, c.uid);
        yield* searchDeck(e, p, 'Add "Necrovalley"', (d) => d.name === 'Necrovalley');
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
      can: (e, m, p) => e.monsters(p).some((x) => x.uid !== m.uid && x.faceUp && isGK(x)) && [...targetable(e, e.monsters(other(p))), ...stOf(e, other(p))].length > 0,
      *run(e, m, p) {
        if (!(yield* tributeCost(e, p, 1, (x) => x.faceUp && isGK(x), m.uid))) return;
        const t = yield* pickOne(e, p, "Gravekeeper's Descendant: destroy which card?", [...targetable(e, e.monsters(other(p))), ...stOf(e, other(p))]);
        if (t && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
      },
    },
  };

  // Its Tribute Summons (2 or 3 monsters, or 1 "Gravekeeper's") run as a summon procedure that uses your Normal Summon.
  E["Gravekeeper's Oracle"] = {
    cannotNormalSummon: true,
    summonProc: {
      can: (e, _c, p) => e.inMainPhase() && !e.player(p).normalSummoned && (e.monsters(p).length >= 2 || e.monsters(p).some((m) => m.faceUp && isGK(m))),
      *run(e, c, p) {
        const mine = e.monsters(p);
        const opts: [string, number, boolean][] = [];
        if (mine.some((m) => m.faceUp && isGK(m))) opts.push(['Tribute 1 "Gravekeeper\'s" monster', 1, true]);
        if (mine.length >= 2) opts.push(['Tribute 2 monsters', 2, false]);
        if (mine.length >= 3) opts.push(['Tribute 3 monsters', 3, false]);
        const i = yield* chooseOption(e, p, "Gravekeeper's Oracle: how do you Tribute Summon it?", opts.map((o) => o[0]), true);
        if (i === null) return;
        const [, n, gkOnly] = opts[i];
        const cands = mine.filter((m) => !gkOnly || (m.faceUp && isGK(m)));
        const chosen = yield* pick(e, p, `Tribute ${n} monster${n > 1 ? 's' : ''}`, cands, n, n, true, false);
        if (!chosen) return;
        let levels = 0;
        let gks = 0;
        for (const m of chosen) {
          levels += levelOf(e, m);
          if (m.faceUp && isGK(m)) gks++;
          yield* e.sendToGrave(m.uid, 'tribute');
        }
        e.player(p).normalSummoned = true;
        yield* e.specialSummon(c.uid, p, 'atk');
        const me = e.fieldCard(c.uid);
        if (!me) return;
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
      },
    },
  };

  // Treating the field as "Necrovalley" applies Necrovalley's +500 (once, however many Priestesses).
  E["Gravekeeper's Priestess"] = {
    aura: (e, src, target) => {
      if (!target.faceUp || !isGK(target)) return undefined;
      const first = faceUpMonsters(e).filter((m) => m.name === src.name && !e.isNegated(m)).sort((a, b) => a.uid - b.uid)[0];
      const valley = !fieldFaceUp(e) && first?.uid === src.uid ? 500 : 0;
      return { atk: 200 + valley, def: 200 + valley };
    },
  };

  E["Gravekeeper's Recruiter"] = {
    *onSentToGrave(e, _c, p, from) {
      if (from !== 'mz') return;
      yield* searchDeck(e, p, "Gravekeeper's Recruiter: add which \"Gravekeeper's\" monster?", (c) => isMonster(e, c) && isGK(c) && defInfo(e, c) <= 1500);
    },
  };

  // Only the DEF gain: no engine hook negates Graveyard effects or protects Field Spells.
  E["Gravekeeper's Shaman"] = {
    selfBonus: (e, m) => ({ atk: 0, def: e.player(ctrl(e, m)).gy.filter((c) => isMonster(e, c) && isGK(c)).length * 200 }),
  };

  E["Gravekeeper's Spear Soldier"] = { piercing: true };

  E["Gravekeeper's Spy"] = {
    *flip(e, _m, p) {
      yield* summonOneOf(e, p, "Gravekeeper's Spy: Special Summon which \"Gravekeeper's\" monster?", e.player(p).deck.filter((c) => mainMonster(e, c) && isGK(c) && atkInfo(e, c) <= 1500));
    },
  };

  // Battle damage it inflicts counts as effect damage: no card here tells the two apart, so nothing to do.
  E["Gravekeeper's Vassal"] = {};

  E['Gravitic Orb'] = {
    *flip(e, _m, p) {
      for (const m of faceUpMonsters(e, other(p))) changePos(e, m);
    },
  };

  E['Great Phantom Thief'] = {
    *onBattleDamage(e, _a, p) {
      const opp = e.player(other(p));
      const names = [...new Set([0, 1].flatMap((q) => [...e.player(q as Pid).deck, ...e.player(q as Pid).hand, ...e.player(q as Pid).gy]).map((c) => c.name))].sort();
      const i = yield* chooseOption(e, p, 'Great Phantom Thief: declare a card name', names);
      if (i === null) return;
      const name = names[i];
      e.log(p, `${e.player(p).name} declares ${name}`);
      yield* e.reveal(p, "Your opponent's hand", opp.hand.slice());
      for (const c of opp.hand.filter((x) => x.name === name)) yield* e.discard(other(p), c.uid);
    },
  };

  // Only from the hand (one Quick Effect location per card), and only for battle destruction.
  E['Green Baboon, Defender of the Forest'] = {
    quick: {
      from: 'hand',
      label: 'pay 1000 LP to Special Summon it',
      can: (e, _c, p, t, ctx) => {
        if (t !== 'destroyed' || ctx.prevController !== p || ctx.uid === undefined || e.player(p).lp <= 1000 || !freeMZ(e, p)) return false;
        const f = e.find(ctx.uid);
        return !!f && f.loc.zone === 'gy' && info(e, f.card).race === 'Beast';
      },
      *cost(e, _c, p) {
        return payLp(e, p, 1000);
      },
      *run(e, card, p) {
        if (e.find(card.uid)?.loc.zone === 'hand' && freeMZ(e, p)) yield* e.specialSummon(card.uid, p, 'atk');
      },
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
    const skyfire = e.liveST().some((x) => x.p === p && x.c.name === 'Cerulean Skyfire');
    return e.spells(p).filter((s) => isSpell(e, s) && ((s.faceUp && info(e, s).sub === 'Continuous') || (skyfire && !s.faceUp)));
  };
  E['Hamon, Lord of Striking Thunder'] = {
    cannotNormalSummon: true,
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && hamonCost(e, p).length >= 3,
      *run(e, c, p) {
        const list = hamonCost(e, p);
        const chosen = yield* pick(e, p, 'Hamon: send which 3 Continuous Spells to the GY?', list, 3, 3, true);
        if (!chosen) return;
        for (const s of chosen) yield* e.sendToGrave(s.uid, 'cost');
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
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
      *run(e, m, p) {
        if (m.counters <= 0) return;
        m.counters--;
        const t = yield* pickOne(e, p, 'Hannibal Necromancer: destroy which face-up Trap?', allST(e).filter((c) => c.faceUp && isTrap(e, c)));
        if (t && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
      },
    },
  };

  // ---------- Harpies ----------
  E['Harpie Channeler'] = {
    ignition: {
      can: (e, _m, p) => e.oncePerTurn('Harpie Channeler', p) && freeMZ(e, p) && e.player(p).hand.some((c) => named(c, 'Harpie')) && e.player(p).deck.some((c) => mainMonster(e, c) && named(c, 'Harpie') && c.name !== 'Harpie Channeler'),
      *run(e, _m, p) {
        if (!(yield* discardCost(e, p, 1, (c) => named(c, 'Harpie')))) return;
        e.useOnce('Harpie Channeler', p);
        yield* summonOneOf(e, p, 'Harpie Channeler: Special Summon which "Harpie" monster?', e.player(p).deck.filter((c) => mainMonster(e, c) && named(c, 'Harpie') && c.name !== 'Harpie Channeler'), 'def');
      },
    },
  };

  // "Then you can Normal Summon 1 WIND monster" is done as a Special Summon of a Level 4 or lower WIND monster from the hand.
  E['Harpie Dancer'] = {
    ignition: {
      can: (e, _m, p) => e.oncePerTurn('Harpie Dancer', p) && targetable(e, faceUpMonsters(e, p)).some((m) => attrOf(e, m) === 'WIND'),
      *run(e, _m, p) {
        const t = yield* pickOne(e, p, 'Harpie Dancer: return which WIND monster to the hand?', targetable(e, faceUpMonsters(e, p)).filter((m) => attrOf(e, m) === 'WIND'));
        if (!t) return;
        e.useOnce('Harpie Dancer', p);
        yield* bounce(e, t.uid);
        const list = e.player(p).hand.filter((c) => mainMonster(e, c) && attrOf(e, c) === 'WIND' && levelOf(e, c) <= 4 && !e.effectOn(c)?.cannotNormalSummon);
        if (!list.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Harpie Dancer: Summon a WIND monster from your hand?'))) return;
        yield* summonOneOf(e, p, 'Summon which WIND monster?', list);
      },
    },
  };

  E['Harpie Lady 1'] = {
    aura: (e, _src, target) => (target.faceUp && attrOf(e, target) === 'WIND' ? { atk: 300, def: 0 } : undefined),
  };

  // Only the first of the opponent's next 2 turns is blocked (the engine keeps one "cannot attack" turn per monster).
  const harpie3 = (e: Engine, foe: FieldCard, p: Pid) => {
    if (!e.fieldCard(foe.uid) || e.controller(foe.uid) !== other(p)) return;
    tag(foe).noAttackTurn = e.state.turnPlayer === p ? e.state.turn + 1 : e.state.turn + 2;
    e.log(p, `${foe.name} cannot attack during its controller's next turn`);
  };
  E['Harpie Lady 3'] = {
    *afterBattle(e, _a, t, p) {
      if (t) harpie3(e, t, p);
    },
    *onAttacked(e, _me, attacker, p) {
      harpie3(e, attacker, p);
    },
  };

  E['Harpie Queen'] = {
    handIgnition: {
      can: (e, _c, p) => e.player(p).deck.some((c) => c.name === "Harpies' Hunting Ground"),
      *run(e, c, p) {
        yield* e.discard(p, c.uid);
        yield* searchDeck(e, p, "Add Harpies' Hunting Ground", (d) => d.name === "Harpies' Hunting Ground");
      },
    },
  };

  // The "cannot be targeted for attacks" lock has no engine hook.
  E["Harpie's Pet Dragon - Fearsome Fire Blast"] = {
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
      if (kind === 'flip' || !(isHarpieLady(m) || m.name === 'Harpie Lady Sisters')) return;
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

  // Its End Phase effect happens at its owner's next Standby Phase (no Graveyard hook in the End Phase).
  E['Hysteric Sign'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p),
    *resolve(e, link, p) {
      e.useOnce(link.card.name, p);
      const ps = e.player(p);
      const c = yield* pickOne(e, p, 'Hysteric Sign: add "Elegant Egotist"', [...ps.deck, ...ps.gy].filter((x) => x.name === 'Elegant Egotist'));
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
    *onStandbyInGrave(e, card, p) {
      const flags = fx<Record<number, number>>(e, 'hystericSign', {});
      if (flags[card.uid] === undefined) return;
      delete flags[card.uid];
      if (!e.oncePerTurn(card.name, p)) return;
      const ps = e.player(p);
      const names = [...new Set(ps.deck.filter((c) => named(c, 'Harpie')).map((c) => c.name))];
      if (!names.length) return;
      e.useOnce(card.name, p);
      const picks = yield* e.select(p, 'Hysteric Sign: add up to 3 "Harpie" cards with different names', names.map((n) => ({ label: n })), 1, 3);
      for (const i of picks ?? []) {
        const c = ps.deck.find((x) => x.name === names[i]);
        if (c) e.toHandOf(c.uid, p);
      }
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
  E['Helios - The Primordial Sun'] = helios(100);
  // The End Phase revival is missing (no Graveyard hook in the End Phase).
  E['Helios Duo Megistus'] = helios(200, 'Helios - The Primordial Sun');
  E['Helios Trice Megistus'] = helios(300, 'Helios Duo Megistus', { attacks: (e, m) => (e.monsters(other(ctrl(e, m))).length > 0 ? 2 : 1) });

  E['Helping Robo for Combat'] = battleWin(function* (e, _me, _v, p) {
    if (!e.draw(p, 1)) return;
    const ps = e.player(p);
    const c = yield* pickOne(e, p, 'Helping Robo for Combat: return which card to the bottom of the Deck?', ps.hand.slice());
    if (!c) return;
    const i = ps.hand.findIndex((x) => x.uid === c.uid);
    if (i >= 0) ps.deck.push(ps.hand.splice(i, 1)[0]);
  });

  E['Heraldic Beast Aberconway'] = {
    graveIgnition: {
      can: (e, card, p) => e.oncePerTurn(card.name, p) && e.player(p).gy.some((c) => c.uid !== card.uid && c.name === card.name) && e.player(p).gy.some((c) => isMonster(e, c) && named(c, 'Heraldic Beast')),
      *run(e, card, p) {
        const other_ = yield* pickOne(e, p, 'Banish which other "Heraldic Beast Aberconway"?', e.player(p).gy.filter((c) => c.uid !== card.uid && c.name === card.name), true);
        if (!other_) return;
        e.useOnce(card.name, p);
        e.banish(other_.uid);
        yield* fromGraveToHand(e, p, 'Add which "Heraldic Beast" monster?', (c) => isMonster(e, c) && named(c, 'Heraldic Beast'));
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

  const hieraticFodder = (e: Engine, p: Pid, except: number) => [...e.player(p).hand.filter((c) => isMonster(e, c) && named(c, 'Hieratic')), ...e.monsters(p).filter((m) => m.faceUp && named(m, 'Hieratic'))].filter((c) => c.uid !== except);
  E['Hieratic Dragon of Su'] = {
    summonProc: {
      can: (e, _c, p) => e.monsters(p).some((m) => m.faceUp && named(m, 'Hieratic')),
      *run(e, c, p) {
        if (!(yield* tributeCost(e, p, 1, (m) => m.faceUp && named(m, 'Hieratic')))) return;
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
    ignition: {
      can: (e, m, p) => hieraticFodder(e, p, m.uid).length > 0 && stOf(e, other(p)).length > 0,
      *run(e, m, p) {
        const t = yield* pickOne(e, p, 'Hieratic Dragon of Su: Tribute which "Hieratic" monster?', hieraticFodder(e, p, m.uid), true);
        if (!t) return;
        e.log(p, `${e.player(p).name} Tributes ${t.name}`);
        yield* e.sendToGrave(t.uid, 'tribute');
        const s = yield* pickOne(e, p, 'Hieratic Dragon of Su: destroy which Spell/Trap?', stOf(e, other(p)));
        if (s && e.fieldCard(s.uid)) yield* e.destroy([s.uid]);
      },
    },
    *onSentToGrave(e, _c, p, _from, reason) {
      if (reason === 'tribute') yield* hieraticCall(e, p, 'Hieratic Dragon of Su: Special Summon which Dragon Normal Monster?');
    },
  };

  E['Hino-Kagu-Tsuchi'] = {
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
    if (!freeMZ(e, p) || !e.player(p).deck.some((c) => c.name === 'Hydrogeddon') || !(yield* e.yesno(p, 'Hydrogeddon: Special Summon a "Hydrogeddon" from your Deck?'))) return;
    yield* summonOneOf(e, p, 'Special Summon which?', e.player(p).deck.filter((c) => c.name === 'Hydrogeddon'));
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

  // Its first effect only works from the hand and for battle destruction ('destroyed' window).
  const restrictLike = (e: Engine, c: Card) => c.name === 'Relinquished' || (named(c, 'Eyes Restrict') && info(e, c).sub === 'Fusion');
  E['Illusionist Faceless Magician'] = {
    quick: {
      from: 'hand',
      label: 'Special Summon it',
      can: (e, _c, p, t, ctx) => {
        if (t !== 'destroyed' || ctx.prevController !== p || ctx.uid === undefined || !freeMZ(e, p)) return false;
        const f = e.find(ctx.uid);
        return !!f && restrictLike(e, f.card);
      },
      *run(e, card, p) {
        if (e.find(card.uid)?.loc.zone === 'hand' && freeMZ(e, p)) yield* e.specialSummon(card.uid, p, 'atk');
      },
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
  E['Imperial Bower'] = {
    ignition: {
      can: (e, m, p) => e.oncePerTurn(m.name, p) && e.monsters(p).length === 1 && new Set(e.player(p).deck.filter((c) => KNIGHTS.includes(c.name)).map((c) => c.name)).size >= 2,
      *run(e, m, p) {
        if (!e.fieldCard(m.uid) || e.monsters(p).length !== 1) return;
        e.useOnce(m.name, p);
        yield* e.sendToGrave(m.uid, 'tribute');
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

  // The dice roll against the opponent's targeting effects is not scripted.
  E['Infernalqueen Archfiend'] = {
    *onStandby(e, _m, p) {
      if (e.state.turnPlayer === p && !pandemonium(e)) payLp(e, p, 500);
      const list = faceUpMonsters(e).filter((m) => named(m, 'Archfiend'));
      const t = yield* pickOne(e, p, 'Infernalqueen Archfiend: which Archfiend gains 1000 ATK?', list);
      if (t) boostTurn(t, 1000);
    },
  };

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

  E['Insect Princess'] = {
    *onSummon(e, _m, p) {
      insectsToAttack(e, other(p));
    },
    *onSpecialSummon(e, _m, p) {
      insectsToAttack(e, other(p));
    },
    *onStandby(e, _m, p) {
      insectsToAttack(e, other(p));
    },
    *onAnySummon(e, _w, wp, _m, controller) {
      if (controller === other(wp)) insectsToAttack(e, controller);
    },
    ...battleWin(function* (e, me, victim) {
      if (info(e, victim).race === 'Insect') boostPerm(me, 500);
    }),
  };
  /** Insect Princess: the opponent's face-up Insects go to Attack Position and stay there this turn. */
  function insectsToAttack(e: Engine, q: Pid) {
    for (const m of faceUpMonsters(e, q)) {
      if (raceOf(e, m) !== 'Insect') continue;
      if (m.pos === 'def') changePos(e, m);
      tag(m).lockPosTurn = e.state.turn;
    }
  }

  E['Iron Blacksmith Kotetsu'] = {
    *flip(e, _m, p) {
      yield* searchDeck(e, p, 'Kotetsu: add which Equip Spell?', (c) => isSpell(e, c) && info(e, c).sub === 'Equip');
    },
  };

  E['Jinzo - Lord'] = {
    cannotNormalSummon: true,
    sealsTraps: true,
    summonProc: {
      can: (e, _c, p) => e.monsters(p).some((m) => m.faceUp && m.name === 'Jinzo'),
      *run(e, c, p) {
        const j = yield* pickOne(e, p, 'Jinzo - Lord: send which "Jinzo" to the GY?', e.monsters(p).filter((m) => m.faceUp && m.name === 'Jinzo'), true);
        if (!j) return;
        yield* e.sendToGrave(j.uid, 'cost');
        yield* e.specialSummon(c.uid, p, 'atk');
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
    const test = (e: Engine, c: Card, diff: number) => mainMonster(e, c) && (named(c, 'Elemental HERO') || named(c, 'Kuriboh') || named(c, 'Neo-Spacian')) && atkInfo(e, c) <= diff;
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
    canActivate: (e, _c, _p, t) => anyTime(t) && faceUpMonsters(e).some((m) => named(m, 'Karakuri')),
    *resolve(e, _l, p) {
      const t = yield* pickOne(e, p, 'Golden Gearbox: which "Karakuri" monster?', faceUpMonsters(e).filter((m) => named(m, 'Karakuri')));
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
      for (const u of link.payload as number[]) if (e.find(u)?.loc.zone === 'gy') e.toHandOf(u, p);
    },
  };

  E['Gravity Axe - Grarl'] = (() => {
    const base = h.equip(() => ({ atk: 500, def: 0 }));
    const lock = (e: Engine, p: Pid) => {
      for (const m of e.monsters(other(p))) tag(m).lockPosTurn = e.state.turn;
    };
    return {
      ...base,
      *resolve(e: Engine, link: ChainLink, p: Pid) {
        yield* base.resolve!(e, link, p);
        if (e.fieldCard(link.card.uid)?.equippedTo !== undefined) lock(e, p);
      },
      *onStandby(e: Engine, _fc: FieldCard, p: Pid) {
        lock(e, p);
      },
    } as EffectDef;
  })();

  // Only the battle damage is prevented (the engine cannot cancel effect damage).
  E['Hallowed Life Barrier'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.player(p).hand.length > 0,
    *activate(e, _l, p) {
      if (!(yield* discardCost(e, p, 1))) return false;
    },
    *resolve(e, _l, p) {
      noBattleDamage(e, p, true);
      e.log(p, `${e.player(p).name} takes no battle damage this turn`);
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

  // The piercing part has no engine hook (piercing belongs to the attacker's own script).
  E['H - Heated Heart'] = {
    canActivate: (e, _c, p, t) => isMain(t) && targetable(e, faceUpMonsters(e, p)).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'H - Heated Heart: target which monster?', targetable(e, faceUpMonsters(e, p)), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (m?.faceUp) boostTurn(m, 500);
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

  // The "you can only Special Summon once" restriction is not enforced.
  E['Iron Draw'] = {
    canActivate: (e, c, p, t) => {
      const mine = e.monsters(p);
      return isMain(t) && e.oncePerTurn(c.name, p) && e.player(p).deck.length >= 2 && mine.length === 2 && mine.every((m) => m.faceUp && raceOf(e, m) === 'Machine' && info(e, m).sub !== 'Normal');
    },
    *activate(e, link, p) {
      e.useOnce(link.card.name, p);
    },
    *resolve(e, _l, p) {
      e.draw(p, 2);
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
    canActivate: (e, _c, p, t) => isMain(t) && (freeMZ(e, p) || freeMZ(e, other(p))) && e.player(p).gy.filter((c) => mainMonster(e, c) && named(c, 'Scrap')).length >= 3,
    *activate(e, link, p) {
      const chosen = yield* pick(e, p, 'Guts of Steel: select 3 "Scrap" monsters', e.player(p).gy.filter((c) => mainMonster(e, c) && named(c, 'Scrap')), 3, 3, true);
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
    canActivate: (e, _c, p, t) => anyTime(t) && e.monsters(p).some((m) => m.faceUp && named(m, 'Gem-Knight')) && e.player(p).gy.some((c) => isMonster(e, c) && named(c, 'Gem-Knight')),
    *activate(e, link, p) {
      if (!(yield* tributeCost(e, p, 1, (m) => m.faceUp && named(m, 'Gem-Knight')))) return false;
      const t = yield* pickOne(e, p, 'Gem-Enhancement: Special Summon which "Gem-Knight" monster?', e.player(p).gy.filter((c) => isMonster(e, c) && named(c, 'Gem-Knight')));
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid !== undefined && e.find(link.targetUid)?.loc.zone === 'gy' && freeMZ(e, p)) yield* e.specialSummon(link.targetUid, p, 'atk');
    },
  };

  // Gravekeeper's Trap: only the Main Phase search (no hook for the opponent's Draw Phase or for the GY lock).
  const gkTrapTest = (e: Engine, c: Card) => isMonster(e, c) && (isGK(c) || (attrOf(e, c) === 'EARTH' && info(e, c).race === 'Fairy'));
  E["Gravekeeper's Trap"] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    ignition: {
      can: (e, m, p) => e.oncePerTurn(m.name, p) && e.player(p).hand.length > 0 && e.player(p).deck.some((c) => gkTrapTest(e, c)),
      *run(e, m, p) {
        if (!(yield* discardCost(e, p, 1))) return;
        e.useOnce(m.name, p);
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

  // Only "Negate the activation, and if you do, destroy that card".
  E['Graydle Combat'] = {
    canActivate: (e, _c, p, t, ctx) => {
      if (!(t === 'spell' || t === 'trap' || t === 'effect') || !ctx.link || ctx.link.targetUid === undefined) return false;
      const m = e.fieldCard(ctx.link.targetUid);
      return !!m && m.faceUp && named(m, 'Graydle') && e.controller(m.uid) === p && isMonster(e, m);
    },
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
    canActivate: (e, _c, p, t) => anyTime(t) && e.player(p).gy.some((c) => isNormalMonster(e, c) && named(c, 'Elemental HERO')),
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Hero Blast: add which "Elemental HERO" Normal Monster?', e.player(p).gy.filter((x) => isNormalMonster(e, x) && named(x, 'Elemental HERO')), true);
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
    canActivate: (e, _c, p, t, ctx) => myBattleLoss(e, p, t, ctx.uid, ctx.prevController, (c) => named(c, 'Elemental HERO')) && e.player(p).hand.length > 0,
    *resolve(e, _l, p) {
      const hand = e.player(p).hand;
      if (!hand.length) return;
      const c = hand[Math.floor(e.rand() * hand.length)];
      e.log(other(p), `Hero Counterattack reveals ${c.name}`);
      yield* e.reveal(other(p), 'Hero Counterattack: the chosen card', [c]);
      if (!mainMonster(e, c) || !named(c, 'Elemental HERO')) return;
      const t = yield* pickOne(e, p, 'Hero Counterattack: destroy which monster?', e.monsters(other(p)));
      if (t) yield* e.destroy([t.uid]);
      if (e.find(c.uid)?.loc.zone === 'hand' && freeMZ(e, p)) yield* e.specialSummon(c.uid, p, 'atk');
    },
  };

  E['Hero Signal'] = {
    canActivate: (e, _c, p, t, ctx) =>
      myBattleLoss(e, p, t, ctx.uid, ctx.prevController, () => true) &&
      freeMZ(e, p) &&
      [...e.player(p).hand, ...e.player(p).deck].some((c) => mainMonster(e, c) && named(c, 'Elemental HERO') && levelOf(e, c) <= 4),
    *resolve(e, _l, p) {
      const ps = e.player(p);
      yield* summonOneOf(e, p, 'Hero Signal: Special Summon which "Elemental HERO"?', [...ps.hand, ...ps.deck].filter((c) => mainMonster(e, c) && named(c, 'Elemental HERO') && levelOf(e, c) <= 4));
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
      can: (e, _c, p, t) => anyTime(t) && e.state.turnPlayer === other(p) && e.player(p).deck.some((c) => isMonster(e, c) && named(c, 'Hieratic')),
      *run(e, _c, p) {
        yield* deckToGrave(e, p, 'Send which "Hieratic" monster to the GY?', (c) => isMonster(e, c) && named(c, 'Hieratic'));
      },
    },
    ignition: {
      can: (e, _m, p) => e.player(p).removed.some((c) => isMonster(e, c) && named(c, 'Hieratic')),
      *run(e, _m, p) {
        const c = yield* pickOne(e, p, 'Return which banished "Hieratic" monster to the GY?', e.player(p).removed.filter((x) => isMonster(e, x) && named(x, 'Hieratic')));
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
      yield* summonOneOf(e, p, 'Hieratic Seal From the Ashes: Special Summon which "Hieratic" monster?', e.player(p).gy.filter((c) => mainMonster(e, c) && named(c, 'Hieratic')));
    },
  };

  E['Howl of the Wild'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    quick: {
      repeat: true,
      label: 'inflict 300 damage for each Beast',
      can: (e, _c, p, t, ctx) => {
        const b = e.state.battle;
        if (t !== 'destroyed' || ctx.prevController !== other(p) || ctx.uid === undefined || !b) return false;
        const mine = b.attacker === ctx.uid ? b.target : b.attacker;
        if (mine === null) return false;
        const f = e.find(mine);
        const isMine = f ? (f.loc.zone === 'mz' ? f.loc.player === p : f.card.owner === p) : false;
        return isMine && faceUpMonsters(e, p).some((m) => raceOf(e, m) === 'Beast');
      },
      *run(e, _c, p) {
        const n = faceUpMonsters(e, p).filter((m) => raceOf(e, m) === 'Beast').length;
        if (n) e.damage(other(p), n * 300);
      },
    },
  };

  E['Hunting Instinct'] = {
    canActivate: (e, _c, p, t, ctx) => t === 'special' && !!opponentSummon(e, p, t, ctx) && freeMZ(e, p) && e.player(p).hand.some((c) => mainMonster(e, c) && info(e, c).race === 'Dinosaur'),
    *resolve(e, _l, p) {
      yield* summonOneOf(e, p, 'Hunting Instinct: Special Summon which Dinosaur?', e.player(p).hand.filter((c) => mainMonster(e, c) && info(e, c).race === 'Dinosaur'));
    },
  };

  // "Option 1" (a monster cannot be destroyed during this Battle Phase) has no engine hook.
  E['Impenetrable Attack'] = {
    canActivate: (e, _c, _p, t) => e.state.phase === 'BP' && anyTime(t),
    *resolve(e, _l, p) {
      noBattleDamage(e, p, true);
      e.log(p, `${e.player(p).name} takes no battle damage during this Battle Phase`);
    },
  };

  // "Tribute Summoned" is read as Level 5 or higher (the engine does not record how a monster was Summoned).
  E['Infestation Wave'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.monsters(p).some((m) => m.faceUp && named(m, 'Steelswarm') && levelOf(e, m) >= 5) && [...targetable(e, e.monsters(other(p))), ...stOf(e, other(p))].length > 0,
    *activate(e, link, p) {
      const s = yield* pickOne(e, p, 'Infestation Wave: return which "Steelswarm" monster?', e.monsters(p).filter((m) => m.faceUp && named(m, 'Steelswarm') && levelOf(e, m) >= 5), true);
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
    canActivate: (e, _c, _p, t) => anyTime(t) && faceUpMonsters(e).some((m) => info(e, m).sub !== 'Normal'),
    *resolve(e) {
      for (const m of faceUpMonsters(e).filter((x) => info(e, x).sub !== 'Normal')) {
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
    const jams = faceUpMonsters(e, p).filter((m) => m.name === 'Revival Jam' && m.uid !== b.target);
    const j = yield* pickOne(e, p, 'Jam Defender: switch the attack to which "Revival Jam"?', jams);
    if (j && e.state.battle) {
      e.state.battle.target = j.uid;
      e.log(p, 'Jam Defender switches the attack target to Revival Jam');
    }
  };
  const jamCan = (e: Engine, p: Pid) => {
    const b = e.state.battle;
    return !!b && b.target !== null && e.controller(b.attacker) === other(p) && e.controller(b.target) === p && faceUpMonsters(e, p).some((m) => m.name === 'Revival Jam' && m.uid !== b.target);
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
