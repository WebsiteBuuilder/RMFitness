// Speed Duel card scripts, batch 13 (Airorca ... Roll Out!): the cards left over by the first batches, most of
// them needing a Speed Duel hook of their own (activation locks, Summoning conditions, banished cards' phases...).
import type { EffectDef } from '../effects';
import type { SpeedHelpers } from './helpers';
import {
  allMonsters,
  allST,
  anyTime,
  attrOf,
  boostTurn,
  deckToGrave,
  discardCost,
  faceUpMonsters,
  freeMZ,
  freeST,
  info,
  isMain,
  isMonster,
  isSpell,
  label,
  levelOf,
  millTop,
  named,
  negateLink,
  negateMonster,
  noBattleDamage,
  other,
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
import type { Card, ChainCtx, Engine, FieldCard, Pid, Step } from './helpers';

// ---------- local helpers ----------
const fx = (e: Engine) => e.state.fx as Record<string, any>;
const map = (e: Engine, key: string): Record<number, number> => (fx(e)[key] ??= {});
const kindOf = (e: Engine, c: Card) => info(e, c).kind;
const isCyberse = (e: Engine, c: Card) => isMonster(e, c) && (('faceUp' in c && e.find(c.uid)?.loc.zone === 'mz') ? raceOf(e, c) : info(e, c).race) === 'Cyberse';
const beastish = (race: string) => race === 'Beast' || race === 'Beast-Warrior' || race === 'Winged Beast';
/** Face-up cards the opponent controls that this player can target. */
const faceUpOpp = (e: Engine, p: Pid) => [...targetable(e, faceUpMonsters(e, other(p))), ...stOf(e, other(p)).filter((c) => c.faceUp)];
const cardsOf = (e: Engine, p: Pid) => [...targetable(e, e.monsters(p)), ...stOf(e, p)];

/** Runs a step that never asks anything, synchronously (inside non-generator hooks). */
function runSync(g: Step) {
  let r = g.next(undefined as never);
  for (let i = 0; !r.done && i < 20; i++) r = g.next(false);
}

/** Takes a card out of the hand/Deck/GY/banished pile without side effects. */
function lift(e: Engine, uid: number): Card | null {
  const f = e.find(uid);
  if (!f || !['hand', 'deck', 'gy', 'removed'].includes(f.loc.zone)) return null;
  const ps = e.player(f.loc.player);
  const arr = (f.loc.zone === 'removed' ? ps.removed : ps[f.loc.zone as 'hand' | 'deck' | 'gy']) as Card[];
  arr.splice(f.loc.index, 1);
  return f.card;
}
/** Places a card from the hand/Deck/GY into a free Spell & Trap Zone of `p` (face-up and active, or Set). */
function placeST(e: Engine, uid: number, p: Pid, faceUp: boolean): FieldCard | null {
  const zone = freeST(e, p);
  if (zone < 0) return null;
  const c = lift(e, uid);
  if (!c) return null;
  const fc: FieldCard = { uid: c.uid, name: c.name, owner: c.owner, pos: 'atk', faceUp, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: faceUp };
  e.player(p).sz[zone] = fc;
  e.event(faceUp ? 'activate' : 'set', { uid: c.uid, player: p });
  return fc;
}
/** Equips a card from the hand/Deck/GY to a monster. */
function equipFromPile(e: Engine, uid: number, host: FieldCard, p: Pid): FieldCard | null {
  const fc = placeST(e, uid, p, true);
  if (!fc) return null;
  fc.equippedTo = host.uid;
  host.equips.push(fc.uid);
  return fc;
}
/** "Set this card from your hand/Deck to your Spell & Trap Zone as a Spell Card" (the Artifact monsters). */
function setAsSpell(e: Engine, uid: number, p: Pid): FieldCard | null {
  const fc = placeST(e, uid, p, false);
  if (fc) {
    tag(fc).setMonster = 1;
    e.log(p, `${e.player(p).name} Sets a card in the Spell & Trap Zone`);
  }
  return fc;
}
/** "If this card attacks, your opponent cannot activate Spell/Trap Cards until the end of the Damage Step." */
const attackLock: EffectDef['locksCardActivation'] = (e, src, sp, player, card) => player === other(sp) && e.state.battle?.attacker === src.uid && kindOf(e, card) !== 'monster';
/** "Destroyed by your opponent's card": remembers who sent this card away (read by onDestroyed). */
const markLeave: EffectDef['onLeaveField'] = function* (e, fc, controller) {
  map(e, 'leftByOpp13')[fc.uid] = e.actor === other(controller) && fc.owner === controller ? e.state.turn : -1;
};
const leftByOpp = (e: Engine, uid: number) => map(e, 'leftByOpp13')[uid] === e.state.turn;
/** "During the End Phase / Standby Phase": a once-per-turn key for this copy. */
const opt = (e: Engine, c: Card, p: Pid, n = 1) => e.oncePerTurn(`${c.name}:${c.uid}:${n}`, p);
const useOpt = (e: Engine, c: Card, p: Pid, n = 1) => e.useOnce(`${c.name}:${c.uid}:${n}`, p);
/** Sends a face-up monster face-down in Defense Position (its equips are destroyed, its changes reset). */
function setFaceDown(e: Engine, m: FieldCard): Step {
  return (function* (): Step {
    for (const u of m.equips.slice()) if (e.fieldCard(u)) yield* e.sendToGrave(u, 'destroyed');
    m.faceUp = false;
    m.pos = 'def';
    m.atkMod = 0;
    m.defMod = 0;
    m.tags = m.tags?.ssAt !== undefined ? { ssAt: m.tags.ssAt } : {};
    e.event('position', { uid: m.uid, player: e.controller(m.uid) ?? m.owner });
  })();
}
/** Shuffles a card on the field back: Fusion Monsters to the Extra Deck, Tokens vanish, the rest into the Main Deck. */
function* shuffleBack(e: Engine, uid: number): Step {
  const f = e.find(uid);
  if (!f) return;
  if (f.card.token) return yield* e.sendToGrave(uid, 'used');
  const fc = e.fieldCard(uid);
  if (fc && info(e, fc).sub === 'Fusion' && kindOf(e, fc) === 'monster') {
    for (const u of fc.equips.slice()) if (e.fieldCard(u)) yield* e.sendToGrave(u, 'used');
    if (fc.equippedTo !== undefined) {
      const host = e.fieldCard(fc.equippedTo);
      if (host) host.equips = host.equips.filter((x) => x !== uid);
    }
    const owner = fc.owner;
    e.toHandOf(uid, owner);
    const hand = e.player(owner).hand;
    const i = hand.findIndex((c) => c.uid === uid);
    if (i >= 0) e.player(owner).fusion.push(...hand.splice(i, 1).map((c) => ({ uid: c.uid, name: c.name, owner: c.owner })));
    return;
  }
  toDeck(e, uid);
}

// ---------- Cloudian: Fog Counters live in tags.fog (as in batch 02) ----------
const fog = (m: FieldCard) => m.tags?.fog ?? 0;
const totalFog = (e: Engine) => allMonsters(e).reduce((a, m) => a + fog(m), 0);
function* cloudCheck(e: Engine, m: FieldCard): Step {
  const fc = e.fieldCard(m.uid);
  if (fc && fc.faceUp && fc.pos === 'def' && !e.isNegated(fc)) {
    e.log(null, `${fc.name} is in face-up Defense Position and is destroyed`);
    yield* e.destroy([fc.uid]);
  }
}
/** WATER monsters sent to the GY as Tributes right before this monster's Summon (read from the event list). */
function tributedWater(e: Engine, m: FieldCard): number {
  const ev = e.state.events ?? [];
  let i = ev.length - 1;
  while (i >= 0 && !(ev[i].kind === 'summon' && ev[i].uid === m.uid)) i--;
  let n = 0;
  for (let j = i - 1; j >= 0 && (ev[j].kind === 'to-gy' || ev[j].kind === 'damage'); j--) {
    if (ev[j].kind !== 'to-gy' || ev[j].uid === undefined) continue;
    const f = e.find(ev[j].uid!);
    if (f && f.loc.zone === 'gy' && isMonster(e, f.card) && attrOf(e, f.card) === 'WATER') n++;
  }
  return n;
}

// ---------- Union (equip to a Machine / unequip and Special Summon) ----------
function machineUnion(atk: number, def: number): EffectDef {
  const hosts = (e: Engine, m: FieldCard, p: Pid) => targetable(e, e.monsters(p).filter((x) => x.uid !== m.uid && x.faceUp && raceOf(e, x) === 'Machine'));
  return {
    ignition: {
      repeat: true,
      can: (e, m, p) => {
        if (!e.oncePerTurn(`union:${m.uid}`, p)) return false;
        const zone = e.find(m.uid)?.loc.zone;
        if (zone === 'mz') return freeST(e, p) >= 0 && hosts(e, m, p).length > 0;
        return zone === 'sz' && m.equippedTo !== undefined && freeMZ(e, p);
      },
      *run(e, m, p) {
        const f = e.find(m.uid);
        if (!f || f.loc.player !== p) return;
        if (f.loc.zone === 'mz') {
          const host = yield* pickOne(e, p, `${m.name}: equip to which Machine monster?`, hosts(e, m, p), true);
          const z = freeST(e, p);
          if (!host || z < 0 || e.find(m.uid)?.loc.zone !== 'mz') return;
          e.useOnce(`union:${m.uid}`, p);
          for (const u of m.equips.slice()) yield* e.sendToGrave(u, 'used');
          const at = e.find(m.uid)!.loc;
          e.vacateMZ(e.player(p), at.index);
          Object.assign(m, { pos: 'atk', faceUp: true, active: true, equips: [], equippedTo: host.uid, atkMod: 0, defMod: 0, tags: { union: 1 } });
          e.player(p).sz[z] = m;
          host.equips.push(m.uid);
          e.event('activate', { uid: m.uid, player: p });
          e.log(p, `${m.name} is equipped to ${host.name}`);
        } else if (f.loc.zone === 'sz' && freeMZ(e, p)) {
          e.useOnce(`union:${m.uid}`, p);
          const host = m.equippedTo !== undefined ? e.fieldCard(m.equippedTo) : null;
          if (host) host.equips = host.equips.filter((u) => u !== m.uid);
          m.equippedTo = undefined;
          yield* e.specialSummon(m.uid, p, 'atk');
        }
      },
    },
    equipBonus: (e, eq) => (e.find(eq.uid)?.loc.zone === 'sz' ? { atk, def } : { atk: 0, def: 0 }),
    shields(e, src, target, how) {
      if (how === 'target' || src.equippedTo !== target.uid || e.find(src.uid)?.loc.zone !== 'sz') return false;
      e.log(null, `${src.name} is destroyed instead of ${target.name}`);
      runSync(e.sendToGrave(src.uid, 'destroyed'));
      return true;
    },
  };
}
const isUnionMonster = (e: Engine, c: Card) => isMonster(e, c) && /Unequip/i.test(info(e, c).desc);
/** A monster this Union monster could be equipped to by its own effect. */
function unionFits(e: Engine, u: Card, m: FieldCard): boolean {
  if (!m.faceUp) return false;
  const d = info(e, u).desc;
  if (/Machine monster/i.test(d) && raceOf(e, m) === 'Machine') return true;
  const names = [...d.matchAll(/"([^"]+)"/g)].map((x) => x[1]).filter((n) => n !== u.name);
  return e.namesOf(m).some((nm) => names.includes(nm));
}

// ---------- Fusion helpers ----------
/** "Must be Fusion Summoned" (approximated as: only Special Summoned from the Extra Deck). */
const fusionOnly: EffectDef['summonRule'] = (_e, _c, _p, how, from) => how !== 'special' || from === 'fusion';

export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  // ---------- Effect Monsters ----------
  const aquaLike = (e: Engine, c: Card) => isMonster(e, c) && ['Fish', 'Sea Serpent', 'Aqua'].includes(info(e, c).race ?? '');
  E['Airorca'] = {
    ignition: {
      can: (e, _m, p) => e.player(p).hand.some((c) => aquaLike(e, c)) && faceUpOpp(e, p).length > 0,
      *run(e, m, p) {
        const c = yield* pickOne(e, p, 'Airorca: banish which Fish, Sea Serpent or Aqua monster from your hand?', e.player(p).hand.filter((x) => aquaLike(e, x)), true);
        if (!c) return;
        e.banish(c.uid);
        const t = yield* pickOne(e, p, 'Airorca: destroy which face-up card your opponent controls?', faceUpOpp(e, p));
        if (!t) return;
        e.log(p, `Airorca destroys ${t.name}`);
        yield* e.destroy([t.uid]);
        if (!e.fieldCard(m.uid)) return;
        map(e, 'airorca')[m.uid] = e.state.turn;
        e.log(p, 'Airorca is banished until its controller\'s next Standby Phase');
        e.banish(m.uid);
      },
    },
    *onStandbyBanishedAny(e, card, owner) {
      const at = map(e, 'airorca')[card.uid];
      if (at === undefined || e.state.turnPlayer !== owner || at >= e.state.turn) return;
      delete map(e, 'airorca')[card.uid];
      e.log(owner, 'Airorca returns to the field');
      if (freeMZ(e, owner)) yield* e.specialSummon(card.uid, owner, 'atk');
      else yield* e.sendToGrave(card.uid, 'used');
    },
  };

  // Approximation: the effects of the monster it destroys by battle are not negated in the GY.
  E['Ancient Gear Beast'] = {
    summonRule: (_e, _c, _p, how) => how !== 'special',
    locksCardActivation: attackLock,
  };

  E['Ancient Gear Soldier'] = { locksCardActivation: attackLock };

  // "You can only control 1" is not enforced.
  E['Artifact Caduceus'] = {
    handIgnition: {
      can: (e, _c, p) => freeST(e, p) >= 0,
      *run(e, c, p) {
        setAsSpell(e, c.uid, p);
      },
    },
    *onLeaveField(e, fc, controller, reason) {
      if (fc.tags?.setMonster && !fc.faceUp && reason === 'destroyed' && e.state.turnPlayer !== controller) map(e, 'artifactSS')[fc.uid] = e.state.turn;
    },
    *onDestroyed(e, card, p) {
      if (map(e, 'artifactSS')[card.uid] !== e.state.turn || !freeMZ(e, p) || e.find(card.uid)?.loc.zone !== 'gy') return;
      delete map(e, 'artifactSS')[card.uid];
      e.log(p, 'Artifact Caduceus was destroyed while Set: it is Special Summoned');
      const atk = yield* e.yesno(p, 'Special Summon Artifact Caduceus in Attack Position? (No = Defense)');
      yield* e.specialSummon(card.uid, p, atk ? 'atk' : 'def');
    },
    *onAnySummon(e, w, wp, m, _mp, kind) {
      if (kind !== 'special' || !named(e, m, 'Artifact') || e.state.turnPlayer === wp || !e.fieldCard(w.uid)?.faceUp) return;
      e.log(wp, 'Artifact Caduceus: draw 1 card');
      e.draw(wp, 1);
    },
  };

  // Approximation: the Synchro Monster is destroyed (not banished) at the end of the Battle Phase.
  E['Blackwing - Calima the Haze'] = {
    quick: {
      from: 'gy',
      label: 'Special Summon a Synchro Monster from your GY',
      can: (e, c, p) => e.state.phase === 'BP' && e.state.turnPlayer === other(p) && e.monsters(p).length === 0 && e.player(p).gy.some((x) => x.uid !== c.uid && info(e, x).sub === 'Synchro'),
      *cost(e, c, p, link) {
        const t = yield* pickOne(e, p, 'Calima the Haze: Special Summon which Synchro Monster?', e.player(p).gy.filter((x) => x.uid !== c.uid && info(e, x).sub === 'Synchro'), true);
        if (!t) return false;
        e.banish(c.uid);
        link.targetUid = t.uid;
      },
      *run(e, _c, p, link) {
        if (link.targetUid === undefined || e.find(link.targetUid)?.loc.zone !== 'gy' || !freeMZ(e, p)) return;
        yield* e.specialSummon(link.targetUid, p, 'atk');
        if (e.fieldCard(link.targetUid)) ((e.state.fx.endOfBattle ??= []) as number[]).push(link.targetUid);
      },
    },
  };

  E['Chaos Nephthys'] = {
    cannotNormalSummon: true,
    summonRule: (e, c, _p, how) => how !== 'special' || e.state.fx.nephthysOwn === c.uid,
    *watchGrave(e, card, p, zone, events) {
      if (!events.some((v) => ['mz', 'sz', 'field'].includes(v.from) && v.reason === 'destroyed' && !v.byBattle)) return;
      if (zone === 'gy' && events.some((v) => v.card.uid === card.uid)) return; // it was not in the GY yet
      if (!e.oncePerTurn('Chaos Nephthys', p) || !freeMZ(e, p)) return;
      const gy = e.player(p).gy.filter((c) => isMonster(e, c) && !e.isNamed(c, 'Chaos Nephthys'));
      const lights = gy.filter((c) => attrOf(e, c) === 'LIGHT');
      const darks = gy.filter((c) => attrOf(e, c) === 'DARK');
      if (!lights.length || !darks.length) return;
      if (!(yield* e.yesno(p, `Chaos Nephthys: banish 1 LIGHT and 1 DARK monster from your GY to Special Summon it from your ${zone === 'gy' ? 'GY' : 'hand'}?`))) return;
      const a = yield* pickOne(e, p, 'Chaos Nephthys: banish which LIGHT monster?', lights);
      const b = a ? yield* pickOne(e, p, 'Chaos Nephthys: banish which DARK monster?', darks.filter((x) => x.uid !== a.uid)) : null;
      if (!a || !b) return;
      e.useOnce('Chaos Nephthys', p);
      e.banish(a.uid);
      e.banish(b.uid);
      if (e.find(a.uid)?.loc.zone !== 'removed' || e.find(b.uid)?.loc.zone !== 'removed') return;
      e.state.fx.nephthysOwn = card.uid;
      try {
        yield* e.specialSummon(card.uid, p, 'atk');
      } finally {
        e.state.fx.nephthysOwn = undefined;
      }
    },
    *onSpecialSummon(e, _m, p) {
      const opp = other(p);
      if (!cardsOf(e, opp).length || e.player(opp).gy.length < 2) return;
      if (!(yield* e.yesno(p, "Chaos Nephthys: banish 1 card your opponent controls and 2 cards in their GY?"))) return;
      const t = yield* pickOne(e, p, 'Chaos Nephthys: banish which card your opponent controls?', cardsOf(e, opp));
      const g1 = yield* pickOne(e, p, "Chaos Nephthys: banish which card from your opponent's GY? (1/2)", e.player(opp).gy);
      const g2 = g1 ? yield* pickOne(e, p, "Chaos Nephthys: banish which card from your opponent's GY? (2/2)", e.player(opp).gy.filter((c) => c.uid !== g1.uid)) : null;
      for (const c of [t, g1, g2]) if (c && e.find(c.uid)) e.banish(c.uid);
    },
  };

  // Approximation: it is Tribute Summoned with the usual 1 Tribute (not "any number of WATER monsters").
  E['Cloudian - Nimbusman'] = {
    battleProof: () => true,
    selfBonus: (e) => ({ atk: 500 * totalFog(e), def: 0 }),
    *onSummon(e, m, _p, kind) {
      const n = kind === 'normal' ? tributedWater(e, m) : 0;
      if (n > 0 && e.fieldCard(m.uid)) {
        tag(m).fog = fog(m) + n;
        e.log(null, `${n} Fog Counter${n > 1 ? 's' : ''} placed on ${m.name}`);
      }
      yield* cloudCheck(e, m);
    },
    *onSpecialSummon(e, m) {
      yield* cloudCheck(e, m);
    },
    *onPositionChange(e, m) {
      yield* cloudCheck(e, m);
    },
    *onAttacked(e, target, _a, _c, destroyed) {
      if (!destroyed) yield* cloudCheck(e, target);
    },
    *onStandby(e, m) {
      yield* cloudCheck(e, m);
    },
    *onEndPhase(e, m) {
      yield* cloudCheck(e, m);
    },
  };

  E['D.D. Scout Plane'] = {
    *onEndPhaseBanished(e, card, owner) {
      if (map(e, 'banishedAt')[card.uid] !== e.state.turn || !opt(e, card, owner) || !freeMZ(e, owner)) return;
      useOpt(e, card, owner);
      e.log(owner, 'D.D. Scout Plane returns from its banishment');
      yield* e.specialSummon(card.uid, owner, 'atk');
    },
  };

  // The die roll is offered as a response when the opponent's card effect targets your Archfiend.
  const rolled = (e: Engine) => (fx(e).dbRolled ??= []) as string[];
  E['Darkbishop Archfiend'] = {
    *onStandby(e, m, p) {
      if (e.state.turnPlayer !== p) return;
      if (e.player(p).lp > 500) {
        e.log(p, 'Darkbishop Archfiend: 500 LP');
        e.payLp(p, 500);
      } else {
        e.log(p, 'Darkbishop Archfiend cannot be maintained and is destroyed');
        yield* e.destroy([m.uid]);
      }
    },
    quick: {
      repeat: true,
      label: 'roll a die against that effect',
      can: (e, c, p, _t, ctx) => {
        const l = ctx.link;
        if (!l || l.player !== other(p) || l.negated || l.targetUid === undefined) return false;
        const m = e.fieldCard(l.targetUid);
        return !!m && m.faceUp && e.controller(m.uid) === p && named(e, m, 'Archfiend') && !rolled(e).includes(`${e.state.turn}:${l.card.uid}:${c.uid}`);
      },
      *cost(e, c, _p, _link, ctx) {
        rolled(e).push(`${e.state.turn}:${ctx.link!.card.uid}:${c.uid}`);
        if (rolled(e).length > 20) rolled(e).splice(0, rolled(e).length - 20);
      },
      *run(e, _c, p, link) {
        const target = (link.payload as { ctx?: ChainCtx }).ctx?.link;
        if (!target || target.negated) return;
        const r = e.roll(6);
        e.log(p, `Darkbishop Archfiend rolls a ${r}`);
        if (r !== 1 && r !== 3 && r !== 6) return;
        negateLink(e, target, p);
        if (target.negated && e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
      },
    },
  };

  // The Ritual Spells offer it from the GY (effects.ts ritualSpell); the monster gets tags.trapImmune.
  E['Djinn Disserere of Rituals'] = { ritualFromGy: true };

  E['Enraged Battle Ox'] = {
    grantsPiercing: (e, _src, sp, attacker) => e.controller(attacker.uid) === sp && beastish(raceOf(e, attacker)),
  };

  /** Is a Spell Card being activated (its targets chosen) or resolving right now? */
  const spellTargeting = (e: Engine) => {
    if (e.resolvingKind() === 'spell') return true;
    const ev = e.state.lastEvent;
    if (ev?.kind !== 'activate' || ev.uid === undefined) return false;
    const f = e.find(ev.uid);
    return !!f && kindOf(e, f.card) === 'spell';
  };
  const rellaEquips = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy].filter((c) => isSpell(e, c) && info(e, c).sub === 'Equip' && !/only to "/i.test(info(e, c).desc));
  E['Fairy Tail - Rella'] = {
    shields: (e, src, target, how) => how === 'target' && target.uid !== src.uid && e.find(target.uid)?.loc.zone === 'mz' && spellTargeting(e),
    ignition: {
      can: (e, m, p) => e.player(p).hand.some((c) => isSpell(e, c)) && rellaEquips(e, p).length > 0 && freeST(e, p) >= 0,
      *run(e, m, p) {
        if (!(yield* discardCost(e, p, 1, (c) => isSpell(e, c)))) return;
        const eq = yield* pickOne(e, p, 'Fairy Tail - Rella: equip which Equip Spell to it?', rellaEquips(e, p));
        if (!eq || !e.fieldCard(m.uid)?.faceUp || e.graveLocked(eq.uid)) return;
        const fromDeck = e.find(eq.uid)?.loc.zone === 'deck';
        const fc = equipFromPile(e, eq.uid, m, p);
        if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
        if (!fc) return;
        tag(fc).rellaTurn = e.state.turn;
        e.log(p, `${fc.name} is equipped to Fairy Tail - Rella`);
      },
    },
    *onEndPhase(e, m) {
      for (const u of m.equips.slice()) {
        const eq = e.fieldCard(u);
        if (eq?.tags?.rellaTurn === e.state.turn) {
          e.log(null, `${eq.name} returns to the hand`);
          e.toHand(u);
        }
      }
    },
  };

  E['Fossil Dyna Pachycephalo'] = {
    *flip(e) {
      const doomed = allMonsters(e).filter((m) => m.tags?.ssAt !== undefined);
      if (!doomed.length) return;
      e.log(null, 'Fossil Dyna Pachycephalo destroys every Special Summoned monster');
      yield* e.destroy(doomed.map((m) => m.uid));
    },
    forbidsSummon: (_e, _src, _sp, _monster, _who, how) => how === 'special',
  };

  E['Ghostrick Doll'] = {
    summonRule: (e, _c, p, how) => how !== 'normal' || faceUpMonsters(e, p).some((m) => named(e, m, 'Ghostrick')),
    ignition: {
      can: (e, m) => m.faceUp && e.find(m.uid)?.loc.zone === 'mz',
      *run(e, m, p) {
        if (!e.fieldCard(m.uid)?.faceUp) return;
        yield* setFaceDown(e, m);
        e.log(p, 'Ghostrick Doll is changed to face-down Defense Position');
      },
    },
    *flip(e, m) {
      if (e.fieldCard(m.uid)) tag(m).dollFlip = e.state.turn;
    },
    *onEndPhase(e, m, p) {
      if (m.tags?.dollFlip !== e.state.turn) return;
      tag(m).dollFlip = -1;
      const list = allMonsters(e).filter((x) => x.faceUp && !x.token);
      for (const x of list) yield* setFaceDown(e, x);
      const n = list.length;
      e.log(p, `Ghostrick Doll changes ${n} monster${n === 1 ? '' : 's'} to face-down Defense Position`);
      const ghosts = e.player(p).deck.filter((c) => isMonster(e, c) && named(e, c, 'Ghostrick') && levelOf(e, c) <= n);
      if (!ghosts.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Ghostrick Doll: Special Summon a "Ghostrick" monster from your Deck in face-down Defense Position?'))) return;
      const c = yield* pickOne(e, p, 'Special Summon which "Ghostrick" monster?', ghosts);
      if (!c) return;
      yield* e.specialSummon(c.uid, p, 'def', false);
      e.player(p).deck = e.shuffle(e.player(p).deck);
    },
  };

  E['Heavy Mech Support Platform'] = machineUnion(500, 500);

  E['Invader of Darkness'] = {
    locksCardActivation: (e, _src, sp, player, card) => player === other(sp) && kindOf(e, card) === 'spell' && info(e, card).sub === 'Quick-Play',
  };

  E['Magical Marionette'] = {
    quick: {
      label: 'place a Spell Counter',
      repeat: true,
      can: (e, _c, _p, t, ctx) => t === 'spell' && !!ctx.link && isSpell(e, ctx.link.card) && !ctx.link.negated,
      *run(e, card) {
        const m = e.fieldCard(card.uid);
        if (!m?.faceUp) return;
        m.counters++;
        e.log(null, `A Spell Counter is placed on Magical Marionette (${m.counters})`);
      },
    },
    selfBonus: (_e, m) => ({ atk: 200 * m.counters, def: 0 }),
    ignition: {
      repeat: true,
      can: (e, m) => m.counters >= 2 && targetable(e, allMonsters(e)).length > 0,
      *run(e, m, p) {
        const t = yield* pickOne(e, p, 'Magical Marionette: destroy which monster?', targetable(e, allMonsters(e)), true);
        if (!t || !e.fieldCard(m.uid) || m.counters < 2) return;
        m.counters -= 2;
        e.log(p, `Magical Marionette removes 2 Spell Counters and destroys ${label(t)}`);
        yield* e.destroy([t.uid]);
      },
    },
  };

  E['Manticore of Darkness'] = {
    *onSentToGrave(e, card) {
      map(e, 'manticore')[card.uid] = e.state.turn;
    },
    *onEndPhaseInGrave(e, card, p) {
      if (map(e, 'manticore')[card.uid] !== e.state.turn) return;
      const cands = [...e.player(p).hand, ...e.monsters(p)].filter((c) => c.uid !== card.uid && isMonster(e, c) && beastish('faceUp' in c && e.find(c.uid)?.loc.zone === 'mz' ? raceOf(e, c) : info(e, c).race ?? ''));
      if (!cands.length || !(freeMZ(e, p) || cands.some((c) => e.find(c.uid)?.loc.zone === 'mz'))) return;
      if (!(yield* e.yesno(p, 'Manticore of Darkness: send a Beast, Beast-Warrior or Winged Beast to the GY to Special Summon it?'))) return;
      const c = yield* pickOne(e, p, 'Manticore of Darkness: send which monster to the GY?', cands);
      if (!c) return;
      delete map(e, 'manticore')[card.uid];
      yield* e.sendToGrave(c.uid, 'cost');
      if (freeMZ(e, p) && e.find(card.uid)?.loc.zone === 'gy') yield* e.specialSummon(card.uid, p, 'atk');
    },
  };

  E['Mirage Dragon'] = {
    locksCardActivation: (e, _src, sp, player, card) => player === other(sp) && e.state.phase === 'BP' && kindOf(e, card) === 'trap',
  };

  // Its Pendulum Effect needs Pendulum Zones and its monster effect a Pendulum Summon, neither of which exists here.
  E['Performapal Dag Daggerman'] = {};

  E['Prickle Fairy'] = {
    guardsTarget: (e, _src, sp, target, attacker) => e.controller(target.uid) === sp && e.controller(attacker.uid) === other(sp) && target.faceUp && raceOf(e, target) === 'Insect',
    *afterBattle(e, _a, target) {
      const t = e.fieldCard(target.uid);
      if (t && t.pos === 'atk') {
        t.pos = 'def';
        e.log(null, `Prickle Fairy changes ${label(t)} to Defense Position`);
      }
    },
    *onAttacked(e, _t, attacker) {
      const a = e.fieldCard(attacker.uid);
      if (a && a.pos === 'atk') {
        a.pos = 'def';
        e.log(null, `Prickle Fairy changes ${a.name} to Defense Position`);
      }
    },
  };

  const leveled = (e: Engine) => targetable(e, faceUpMonsters(e)).filter((m) => levelOf(e, m) > 0);
  E['Risebell the Star Psycher'] = {
    quick: {
      label: "increase a monster's Level by 1",
      can: (e) => leveled(e).length > 0,
      *cost(e, _c, p, link) {
        const t = yield* pickOne(e, p, 'Risebell: increase the Level of which monster?', leveled(e), true);
        if (!t) return false;
        link.targetUid = t.uid;
      },
      *run(e, _c, p, link) {
        const t = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
        if (!t?.faceUp) return;
        tag(t).lvMod = (t.tags?.lvMod ?? 0) + 1;
        e.log(p, `${t.name} becomes Level ${levelOf(e, t)}`);
      },
    },
  };

  E['Super-Ancient Dinobeast'] = {
    tributeOffer: (e, src, _p, _monster, need) => (src === null && need === 2 ? { need: 1, only: (m: FieldCard) => raceOf(e, m) === 'Dinosaur' } : undefined),
    *onAnySummon(e, w, wp, m, mp, kind) {
      if (kind !== 'special' || w.uid === m.uid || mp !== wp || m.owner !== wp || m.tags?.ssFrom !== 3 || raceOf(e, m) !== 'Dinosaur') return;
      if (e.player(wp).deck.length && (yield* e.yesno(wp, 'Super-Ancient Dinobeast: draw 1 card?'))) e.draw(wp, 1);
    },
  };

  E['Twin-Headed Behemoth'] = {
    *onDestroyed(e, card) {
      map(e, 'behemoth')[card.uid] = e.state.turn;
    },
    *onEndPhaseInGrave(e, card, p) {
      if (map(e, 'behemoth')[card.uid] !== e.state.turn || !e.oncePerDuel('Twin-Headed Behemoth', p) || !freeMZ(e, p)) return;
      if (!(yield* e.yesno(p, 'Twin-Headed Behemoth: Special Summon it (its ATK/DEF become 1000)?'))) return;
      e.useOncePerDuel('Twin-Headed Behemoth', p);
      delete map(e, 'behemoth')[card.uid];
      yield* e.specialSummon(card.uid, p, 'atk');
      const m = e.fieldCard(card.uid);
      if (m) tag(m).behemoth = 1;
    },
    baseStats: (_e, m) => (m.tags?.behemoth ? { atk: 1000, def: 1000 } : undefined),
  };

  E['Voltic Kong'] = {
    *onBattleDamage(e, _a, p) {
      const n = faceUpMonsters(e, p).filter((m) => attrOf(e, m) === 'LIGHT').length;
      if (!n) return;
      e.log(p, `Voltic Kong sends the top ${n} card${n > 1 ? 's' : ''} of the opponent's Deck to the GY`);
      yield* millTop(e, other(p), n);
    },
  };

  // ---------- Fusion Monsters ----------
  // Approximation: its effects are not negated in the GY.
  E['Barbaroid, the Ultimate Battle Machine'] = {
    attacks: () => 2,
    cannotAttack: (e, _m, p) => e.monsters(other(p)).length === 0,
    *afterBattle(e, _a, target, p, destroyed) {
      const t = e.fieldCard(target.uid);
      if (t?.faceUp && !destroyed) negateMonster(e, t, false);
      if (destroyed) {
        e.log(p, 'Barbaroid inflicts 1000 damage');
        e.damage(other(p), 1000);
      }
    },
  };

  // Approximations: no Link Rating check (any Cyberse Link Monster); only the copy on the field can negate.
  E['Cyberse Desavewurm'] = {
    ignition: {
      can: (e, _m, p) => e.oncePerTurn('Cyberse Desavewurm:1', p) && freeMZ(e, p) && e.player(p).hand.some((c) => isCyberse(e, c) && info(e, c).sub !== 'Ritual'),
      *run(e, m, p) {
        e.useOnce('Cyberse Desavewurm:1', p);
        const s = yield* summonOneOf(e, p, 'Cyberse Desavewurm: Special Summon which Cyberse monster?', e.player(p).hand.filter((c) => isCyberse(e, c) && info(e, c).sub !== 'Ritual'));
        const me = e.fieldCard(m.uid);
        if (!s || !me?.faceUp || levelOf(e, s) <= 0 || !(yield* e.yesno(p, `Make Cyberse Desavewurm Level ${levelOf(e, s)}?`))) return;
        tag(me).lvMod = (me.tags?.lvMod ?? 0) + levelOf(e, s) - levelOf(e, me);
        e.log(p, `Cyberse Desavewurm becomes Level ${levelOf(e, me)}`);
      },
    },
    quick: {
      label: 'negate that activation',
      can: (e, _c, p, t, ctx) =>
        (t === 'spell' || t === 'trap' || t === 'effect') && !!ctx.link && ctx.link.player === other(p) && !ctx.link.negated && kindOf(e, ctx.link.card) !== 'monster' && e.oncePerTurn('Cyberse Desavewurm:2', p) && faceUpMonsters(e, p).some((m) => info(e, m).sub === 'Link' && raceOf(e, m) === 'Cyberse'),
      *cost(e, c, p) {
        e.useOnce('Cyberse Desavewurm:2', p);
        e.banish(c.uid);
      },
      *run(e, _c, p, link) {
        negateLink(e, (link.payload as { ctx?: ChainCtx }).ctx?.link, p);
      },
    },
  };

  const neosCard = (e: Engine, c: Card) => !isMonster(e, c) && info(e, c).desc.includes('"Elemental HERO Neos"');
  E['Elemental HERO Brave Neos'] = {
    summonRule: fusionOnly,
    selfBonus: (e, m) => {
      const p = e.controller(m.uid) ?? m.owner;
      return { atk: 100 * e.player(p).gy.filter((c) => isMonster(e, c) && (named(e, c, 'Neo-Spacian') || named(e, c, 'HERO'))).length, def: 0 };
    },
    *afterBattle(e, _a, _t, p, destroyed) {
      if (!destroyed || !e.player(p).deck.some((c) => neosCard(e, c)) || !(yield* e.yesno(p, 'Brave Neos: add a Spell/Trap that lists "Elemental HERO Neos" from your Deck?'))) return;
      yield* searchDeck(e, p, 'Add which card?', (c) => neosCard(e, c));
    },
  };

  // Approximation: it is Fusion Summoned with its three materials (there is no Contact Fusion from the Extra Deck here).
  E['Elemental HERO Storm Neos'] = {
    summonRule: fusionOnly,
    ignition: {
      can: (e) => allST(e).length > 0,
      *run(e, _m, p) {
        const list = allST(e);
        if (!list.length) return;
        e.log(p, 'Storm Neos destroys every Spell and Trap on the field');
        yield* e.destroy(list.map((c) => c.uid));
      },
    },
    *onEndPhase(e, m, p) {
      if (!e.fieldCard(m.uid)) return;
      e.log(p, 'Storm Neos is shuffled into the Extra Deck, and every card on the field into the Deck');
      yield* shuffleBack(e, m.uid);
      if (e.find(m.uid)?.loc.zone !== 'fusion') return;
      for (const q of [0, 1] as Pid[]) {
        const ps = e.player(q);
        for (const c of [...e.monsters(q), ...e.spells(q), ...(ps.field ? [ps.field] : [])]) if (e.fieldCard(c.uid)) yield* shuffleBack(e, c.uid);
      }
      for (const q of [0, 1] as Pid[]) e.player(q).deck = e.shuffle(e.player(q).deck);
    },
  };

  // Approximation: it always selects all 3 zones, so the opponent cannot Summon monsters (Setting is still allowed).
  E['Ojama King'] = {
    forbidsSummon: (_e, _src, sp, _monster, who, how) => who === other(sp) && (how === 'normal' || how === 'special'),
  };

  E['Ultimate Ancient Gear Golem'] = {
    summonRule: fusionOnly,
    piercing: true,
    locksCardActivation: attackLock,
    *onDestroyed(e, _card, p) {
      const golems = e.player(p).gy.filter((c) => e.isNamed(c, 'Ancient Gear Golem'));
      if (!golems.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Ultimate Ancient Gear Golem: Special Summon "Ancient Gear Golem" from your GY?'))) return;
      const g = yield* pickOne(e, p, 'Special Summon which Ancient Gear Golem?', golems);
      if (!g) return;
      e.state.fx.ignoreCond = g.uid;
      try {
        yield* e.specialSummon(g.uid, p, 'atk');
      } finally {
        e.state.fx.ignoreCond = undefined;
      }
    },
  };

  // ---------- Spells ----------
  E['Amplifier'] = h.equipFor((e, m) => e.isNamed(m, 'Jinzo'), () => ({ atk: 0, def: 0 }), {
    freesOwnTraps: true,
    *onLeaveField(e, fc) {
      const host = fc.equippedTo !== undefined ? e.fieldCard(fc.equippedTo) : null;
      if (!host) return;
      e.log(null, `Amplifier left the field: ${host.name} is destroyed`);
      yield* e.destroy([host.uid]);
    },
  });

  // Crystal Beasts become DARK in helpers.attrOf. Approximation: the damage effect is used when the attack is declared; no "Ultimate Crystal" monster exists here.
  const crystalBattle = (e: Engine, p: Pid) => {
    const b = e.state.battle;
    if (!b) return false;
    return [b.attacker, b.target].some((u) => {
      const m = u !== null ? e.fieldCard(u) : null;
      return !!m && m.faceUp && e.controller(m.uid) === p && named(e, m, 'Crystal Beast');
    });
  };
  E['Advanced Dark'] = {
    ...h.fieldSpell(() => undefined),
    quick: {
      label: 'take no battle damage from this battle',
      can: (e, _c, p, t) => t === 'attack' && crystalBattle(e, p) && e.player(p).deck.some((c) => isMonster(e, c) && named(e, c, 'Crystal Beast')),
      *cost(e, _c, p) {
        const c = yield* deckToGrave(e, p, 'Advanced Dark: send which "Crystal Beast" monster from your Deck to the GY?', (x) => isMonster(e, x) && named(e, x, 'Crystal Beast'));
        if (!c) return false;
      },
      *run(e, _c, p) {
        noBattleDamage(e, p);
        e.log(p, `${e.player(p).name} takes no battle damage from this battle`);
      },
    },
  };

  // Cards in the GY cannot leave it (engine.graveLocked). Approximation: Type/Attribute changes in the GY are not negated.
  E['Necrovalley'] = {
    ...h.fieldSpell((e, m) => (named(e, m, "Gravekeeper's") ? { atk: 500, def: 500 } : undefined)),
    locksGrave: () => true,
  };

  const dino = (e: Engine, m: FieldCard) => raceOf(e, m) === 'Dinosaur';
  E['Big Evolution Pill'] = {
    activateCost: {
      can: (e, _c, p) => e.monsters(p).some((m) => dino(e, m)),
      *pay(e, _c, p) {
        return yield* tributeCost(e, p, 1, (m) => dino(e, m));
      },
    },
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve(e, link) {
      const fc = e.fieldCard(link.card.uid);
      if (!fc) return;
      fc.active = true;
      fc.turns = 3;
    },
    *onEndPhase(e, fc, p) {
      if (e.state.turnPlayer === p) return;
      fc.turns = (fc.turns ?? 3) - 1;
      if (fc.turns <= 0) {
        e.log(p, 'Big Evolution Pill wears off');
        yield* e.destroy([fc.uid]);
      }
    },
    tributeOffer: (e, src, _p, monster) => (src && info(e, monster).race === 'Dinosaur' && (info(e, monster).level ?? 0) >= 5 ? { need: 0 } : undefined),
  };

  E['Cost Down'] = {
    activateCost: {
      can: (e, c, p) => e.player(p).hand.some((x) => x.uid !== c.uid),
      *pay(e, c, p) {
        return yield* discardCost(e, p, 1, () => true, c.uid);
      },
    },
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve(e, _l, p) {
      const down = map(e, 'lvDown') as unknown as Record<number, { turn: number; n: number }>;
      for (const c of e.player(p).hand.filter((x) => isMonster(e, x))) {
        const was = down[c.uid];
        down[c.uid] = { turn: e.state.turn, n: (was?.turn === e.state.turn ? was.n : 0) + 2 };
      }
      e.log(p, 'Cost Down: the monsters in the hand are 2 Levels lower this turn');
    },
  };

  // Approximation: the banishing of the opponent's cards is not applied (no "Aesir" monster exists here anyway).
  const aesir = (e: Engine, p: Pid) => targetable(e, faceUpMonsters(e, p).filter((m) => named(e, m, 'Aesir')));
  E['Gotterdammerung'] = {
    canActivate: (e, _c, p, t) => isMain(t) && aesir(e, p).length > 0 && freeMZ(e, other(p)),
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Gotterdammerung: give which "Aesir" monster to your opponent?', aesir(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || e.controller(m.uid) !== p || !e.takeControl(m.uid, other(p))) return;
      m.doomAt = e.state.turnPlayer === p ? e.state.turn + 1 : e.state.turn;
      e.log(p, `${m.name} goes to ${e.player(other(p)).name}`);
    },
  };

  const mineLeveled = (e: Engine, p: Pid) => targetable(e, faceUpMonsters(e, p)).filter((m) => levelOf(e, m) > 0);
  E['Star Light, Star Bright'] = {
    canActivate: (e, _c, p, t) => isMain(t) && mineLeveled(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Star Light, Star Bright: target which monster?', mineLeveled(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const t = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!t?.faceUp || e.controller(t.uid) !== p) return;
      const lv = levelOf(e, t);
      for (const m of faceUpMonsters(e, p)) {
        if (m.uid === t.uid || levelOf(e, m) <= 0 || (e.atkOf(m) !== e.atkOf(t) && e.defOf(m) !== e.defOf(t))) continue;
        Object.assign(tag(m), { lvSet: lv, lvSetTurn: e.state.turn });
        e.log(p, `${m.name} becomes Level ${lv}`);
      }
    },
  };

  const artifactInDeck = (e: Engine, p: Pid) => e.player(p).deck.some((c) => isMonster(e, c) && named(e, c, 'Artifact'));
  E['Artifact Ignition'] = {
    canActivate: (e, c, p, t) => (isMain(t) || anyTime(t)) && artifactInDeck(e, p) && allST(e).some((x) => x.uid !== c.uid),
    *activate(e, link, p) {
      const t = yield* pickOne(e, p, 'Artifact Ignition: destroy which Spell/Trap?', allST(e).filter((x) => x.uid !== link.card.uid), true);
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid === undefined || !e.fieldCard(link.targetUid)) return;
      yield* e.destroy([link.targetUid]);
      if (e.fieldCard(link.targetUid)) return;
      const arts = e.player(p).deck.filter((c) => isMonster(e, c) && named(e, c, 'Artifact'));
      const a = yield* pickOne(e, p, 'Artifact Ignition: Set which "Artifact" monster from your Deck?', arts);
      if (!a) return;
      setAsSpell(e, a.uid, p);
      e.player(p).deck = e.shuffle(e.player(p).deck);
    },
    onLeaveField: markLeave,
    *onDestroyed(e, card, p) {
      if (!leftByOpp(e, card.uid) || card.owner !== p) return;
      const opp = other(p);
      const s = e.state;
      const turn = s.turnPlayer === opp ? (['DP', 'SP', 'M1'].includes(s.phase) ? s.turn : s.turn + 2) : s.turn + 1;
      ((s.fx.noDeclare ??= [-1, -1]) as number[])[opp] = turn;
      e.log(p, `Artifact Ignition: ${e.player(opp).name} skips their next Battle Phase`);
    },
  };

  const numberRe = /^Number (C)?(\d+):/;
  const quickChaos = (e: Engine, p: Pid) =>
    targetable(e, faceUpMonsters(e, p)).filter((m) => {
      const n = m.name.match(numberRe);
      return info(e, m).sub === 'Xyz' && n && !n[1] && e.player(p).fusion.some((c) => c.name.match(numberRe)?.[1] === 'C' && c.name.match(numberRe)?.[2] === n[2] && (info(e, c).rank ?? 0) === (info(e, m).rank ?? 0) + 1);
    });
  E['Rank-Up-Magic Quick Chaos'] = {
    canActivate: (e, _c, p, t) => (isMain(t) || anyTime(t)) && quickChaos(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Rank-Up-Magic Quick Chaos: target which "Number" monster?', quickChaos(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      const n = m?.name.match(numberRe);
      if (!m || !n || e.controller(m.uid) !== p) return;
      const cs = e.player(p).fusion.filter((c) => c.name.match(numberRe)?.[1] === 'C' && c.name.match(numberRe)?.[2] === n[2] && (info(e, c).rank ?? 0) === (info(e, m).rank ?? 0) + 1);
      const c = yield* pickOne(e, p, 'Special Summon which "Number C" monster?', cs);
      if (!c) return;
      yield* e.sendToGrave(m.uid, 'used');
      yield* e.specialSummon(c.uid, p, 'atk');
    },
  };

  // ---------- Traps ----------
  E['Solemn Authority'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && aesir(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Solemn Authority: target which "Aesir" monster?', aesir(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const fc = e.fieldCard(link.card.uid);
      if (fc && link.targetUid !== undefined) Object.assign(tag(fc), { saTarget: link.targetUid, saStandby: 0 });
    },
    shields: (_e, src, target, how) => how === 'target' && src.tags?.saTarget === target.uid,
    *onStandby(e, fc, p) {
      if (e.state.turnPlayer !== p) return;
      tag(fc).saStandby = (fc.tags?.saStandby ?? 0) + 1;
      if (fc.tags!.saStandby >= 2) {
        e.log(p, 'Solemn Authority is sent to the GY');
        yield* e.sendToGrave(fc.uid, 'used');
      }
    },
  };

  // Its activation needs 2 "Abyss Actor" cards in the Pendulum Zones, which this game does not have.
  E['Abyss Actors Back Stage'] = {};

  // Approximation: the Trap stays face-up until the End Phase so it can see the battle.
  const samurai = (e: Engine, p: Pid) => targetable(e, faceUpMonsters(e, p).filter((m) => named(e, m, 'Six Samurai')));
  E['Breakthrough!'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && samurai(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Breakthrough!: select which "Six Samurai" monster?', samurai(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const fc = e.fieldCard(link.card.uid);
      if (!fc || link.targetUid === undefined) return;
      fc.active = true;
      fc.turns = 1;
      Object.assign(tag(fc), { btTarget: link.targetUid, btTurn: e.state.turn });
    },
    *afterAnyBattle(e, fc, p, attacker, target) {
      if (fc.tags?.btTurn !== e.state.turn || attacker.uid !== fc.tags.btTarget || e.fieldCard(target.uid)) return;
      for (const m of faceUpMonsters(e, p)) if (named(e, m, 'Six Samurai') || e.isNamed(m, 'Great Shogun Shien')) tag(m).directTurn = e.state.turn;
      e.log(p, 'Breakthrough!: the Six Samurai can attack directly this turn');
    },
    *onEndPhase(e, fc) {
      if (fc.tags?.btTurn !== undefined && e.fieldCard(fc.uid)) yield* e.sendToGrave(fc.uid, 'used');
    },
  };

  const darkTribute = (e: Engine, p: Pid) => e.monsters(p).filter((m) => m.faceUp && attrOf(e, m) === 'DARK' && e.atkOf(m) >= 1500);
  E['Darklight'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && darkTribute(e, p).length > 0,
    *activate(e, _link, p) {
      const ok = yield* tributeCost(e, p, 1, (m) => m.faceUp && attrOf(e, m) === 'DARK' && e.atkOf(m) >= 1500);
      if (!ok) return false;
    },
    *resolve(e, _l, p) {
      const doomed = allMonsters(e).filter((m) => m.tags?.ssAt === e.state.turn);
      if (!doomed.length) return;
      e.log(p, 'Darklight destroys the monsters Special Summoned this turn');
      yield* e.destroy(doomed.map((m) => m.uid));
    },
  };

  const ringable = (e: Engine) => targetable(e, faceUpMonsters(e)).filter((m) => raceOf(e, m) === 'Warrior' && e.atkOf(m) <= 1500);
  E['Hero Ring'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && ringable(e).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Hero Ring: equip to which Warrior?', ringable(e), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const fc = e.fieldCard(link.card.uid);
      const host = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!fc || !host?.faceUp) return;
      h.attachTo(e, fc, host.uid);
      e.log(link.player, `Hero Ring is equipped to ${host.name}`);
    },
    guardsTarget: (e, src, sp, target, attacker) => src.equippedTo === target.uid && e.controller(attacker.uid) === other(sp) && e.atkOf(attacker) >= 1900,
  };

  // Approximation: only the monsters on the field when it resolves, and only for effects resolving on a chain.
  E['Magnet Force'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve(e, _l, p) {
      for (const m of faceUpMonsters(e)) {
        const r = info(e, m).race;
        if (r === 'Machine' || r === 'Rock') Object.assign(tag(m), { unaffTurn: e.state.turn, unaffBy: other(p) });
      }
      e.log(p, "Magnet Force: Machine and Rock monsters are unaffected by the opponent's monster effects this turn");
    },
  };

  E['Planckton'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve(e, _l, p) {
      for (const m of faceUpMonsters(e)) {
        if (info(e, m).sub !== 'Xyz') continue;
        if ((info(e, m).rank ?? 0) <= 3) boostTurn(m, 500, 500);
        else tag(m).noAttackTurn = e.state.turn;
      }
      e.log(p, 'Planckton: Rank 3 or lower Xyz Monsters gain 500 ATK/DEF, Rank 4 or higher cannot attack');
    },
  };

  const rollOut = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isUnionMonster(e, c) && targetable(e, e.monsters(p)).some((m) => unionFits(e, c, m)));
  E['Roll Out!'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && rollOut(e, p).length > 0 && freeST(e, p) >= 0,
    *activate(e, link, p) {
      const u = yield* pickOne(e, p, 'Roll Out!: target which Union monster in your GY?', rollOut(e, p), true);
      if (!u) return false;
      link.targetUid = u.uid;
    },
    *resolve(e, link, p) {
      const u = link.targetUid !== undefined ? e.find(link.targetUid) : null;
      if (!u || u.loc.zone !== 'gy' || e.graveLocked(u.card.uid)) return;
      const host = yield* pickOne(e, p, `Roll Out!: equip ${u.card.name} to which monster?`, targetable(e, e.monsters(p)).filter((m) => unionFits(e, u.card, m)));
      if (!host) return;
      const fc = equipFromPile(e, u.card.uid, host, p);
      if (!fc) return;
      tag(fc).union = 1;
      e.log(p, `${fc.name} is equipped to ${host.name}`);
    },
  };
}
