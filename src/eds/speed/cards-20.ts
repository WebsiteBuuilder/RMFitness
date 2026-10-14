// Speed Duel card scripts, batch 20: the cards that needed new mechanics. They use the batch-20 additions:
// blocked Monster Zones (engine mzBlocked/freeMonsterZone, fx.blockedMZ: Ojama Knight), Fusion Monsters with
// materials described by kind (EffectDef.fusionTests, tags.fusS on a Fusion Summon: Dyna Tank, Coordius),
// copied monster effects (engine copiedEffect, fx.effectAs: Arcana Call), and the Xyz/Synchro Summon helpers
// (attachMat, detachMats, extraSummon, extraMaterialSets).
import type { EffectDef } from '../effects';
import type { SummonLock } from '../engine';
import type { SpeedHelpers } from './helpers';
import { extraMaterialSets } from './extra';
import { anyTime, attrOf, boostTurn, ctrl, faceUpMonsters, freeMZ, info, isMain, isMonster, isSpell, isTrap, label, named, other, pick, pickOne, raceOf, stOf, summonOneOf, tag, targetable } from './helpers';
import type { Card, ChainLink, Engine, FieldCard, Pid, Step } from './helpers';

// ---------- local helpers ----------
const fx = (e: Engine) => e.state.fx as Record<string, any>;
const map = <T,>(e: Engine, key: string): Record<number, T> => (fx(e)[key] ??= {});
const sub = (e: Engine, c: Card) => info(e, c).sub;
const zoneOf = (e: Engine, uid: number) => e.find(uid)?.loc.zone;
/** A monster in the GY that can be Special Summoned by a card effect (Extra Deck and Ritual Monsters are left out: they need a proper Summon first). */
const revivable = (e: Engine, p: Pid, c: Card) => isMonster(e, c) && !['Fusion', 'Xyz', 'Synchro', 'Link', 'Ritual'].includes(sub(e, c)) && !e.summonBlocked(p, c, 'special', 'gy');
/** "Galaxy-Eyes" or "Cipher" Xyz Monsters you control. */
const cipherXyz = (e: Engine, p: Pid) => targetable(e, faceUpMonsters(e, p).filter((m) => sub(e, m) === 'Xyz' && (named(e, m, 'Galaxy-Eyes') || named(e, m, 'Cipher'))));
/** Xyz Monsters' Rank. */
const rankOf = (e: Engine, c: Card) => info(e, c).rank ?? 0;
/** "Destroyed by your opponent's card": who was resolving an effect when it left the field (read by onDestroyed). */
const markLeave: EffectDef['onLeaveField'] = function* (e, fc, controller) {
  map<number>(e, 'leftByOpp20')[fc.uid] = e.actor === other(controller) ? e.state.turn : -1;
};
const leftByOpp = (e: Engine, uid: number, byBattle: boolean) => byBattle || map<number>(e, 'leftByOpp20')[uid] === e.state.turn;

/** Ojama Knight: its controller picks up to 2 empty Monster Zones of the opponent; they stay blocked while it is face-up (engine mzBlocked). */
function* blockZones(e: Engine, m: FieldCard, p: Pid): Step {
  const opp = other(p);
  const open = e.player(opp).mz.map((_, i) => i).filter((i) => e.monsterZoneOpen(opp, i));
  const list = ((fx(e).blockedMZ ??= []) as { src: number; zones: number[] }[]).filter((b) => b.src !== m.uid && e.fieldCard(b.src));
  fx(e).blockedMZ = list;
  if (!open.length) return;
  const picks = yield* e.select(p, `${m.name}: which of your opponent's Monster Zones cannot be used?`, open.map((i) => ({ label: `Monster Zone ${i + 1}` })), 1, Math.min(2, open.length), false);
  const zones = (picks ?? [0]).map((k) => open[k]).filter((i) => i !== undefined);
  list.push({ src: m.uid, zones });
  e.log(p, `${m.name}: ${e.player(opp).name}'s Monster Zone${zones.length > 1 ? 's' : ''} ${zones.map((i) => i + 1).join(' and ')} cannot be used`);
}

/** Moves a monster already on `p`'s field into Monster Zone `zone` (empty). */
function moveToZone(e: Engine, uid: number, p: Pid, zone: number) {
  const f = e.find(uid);
  const mz = e.player(p).mz;
  if (!f || f.loc.zone !== 'mz' || f.loc.player !== p || f.loc.index === zone || mz[zone] !== null) return;
  mz[zone] = mz[f.loc.index];
  mz[f.loc.index] = null;
}

/** Re-dyce-cle: WIND Synchro Monsters `p` could Synchro Summon right now with a "Speedroid" Tuner among the materials. */
function windSynchros(e: Engine, p: Pid): { card: Card; sets: FieldCard[][] }[] {
  const out: { card: Card; sets: FieldCard[][] }[] = [];
  for (const c of e.player(p).fusion) {
    if (sub(e, c) !== 'Synchro' || attrOf(e, c) !== 'WIND' || e.summonBlocked(p, c, 'special', 'fusion')) continue;
    const sets = extraMaterialSets(e, p, c.name).filter((s) => s.some((m) => info(e, m).tuner && named(e, m, 'Speedroid')));
    if (sets.length) out.push({ card: c, sets });
  }
  return out;
}

/** Rank-Up-Magic Astral Force: the Xyz Monsters in the Extra Deck this monster could rank up into. */
function rankUps(e: Engine, p: Pid, m: FieldCard): Card[] {
  return e.player(p).fusion.filter((c) => sub(e, c) === 'Xyz' && rankOf(e, c) === rankOf(e, m) + 2 && info(e, c).race === raceOf(e, m) && attrOf(e, c) === attrOf(e, m) && !e.summonBlocked(p, c, 'special', 'fusion'));
}
/** The Xyz Monsters `p` controls with the highest Rank (face-up), that have a monster to rank up into. */
function astralTargets(e: Engine, p: Pid): FieldCard[] {
  const xyz = faceUpMonsters(e, p).filter((m) => sub(e, m) === 'Xyz');
  const top = Math.max(0, ...xyz.map((m) => rankOf(e, m)));
  return targetable(e, xyz.filter((m) => rankOf(e, m) === top && rankUps(e, p, m).length > 0));
}

/** Cynet Circuit: "Firewall" Link Monsters `p` controls. */
const firewalls = (e: Engine, p: Pid) => targetable(e, faceUpMonsters(e, p).filter((m) => sub(e, m) === 'Link' && named(e, m, 'Firewall')));
/**
 * The zones "linked to" a Link Monster. This game has no Link Arrows (Link Monsters use the normal Monster Zones and
 * there is no Extra Monster Zone), so the zones linked to it are taken to be the open Monster Zones right next to it
 * on its controller's side (indexes i - 1 and i + 1).
 */
function linkedZones(e: Engine, m: FieldCard): number[] {
  const f = e.find(m.uid);
  if (!f || f.loc.zone !== 'mz') return [];
  const p = f.loc.player;
  return [f.loc.index - 1, f.loc.index + 1].filter((i) => e.monsterZoneOpen(p, i));
}

export function install(E: Record<string, EffectDef>, _h: SpeedHelpers) {
  // ======================= Fusion Monsters =======================
  const ojama = (e: Engine, c: Card) => isMonster(e, c) && named(e, c, 'Ojama');
  E['Ojama Knight'] = {
    fusionTests: [ojama, ojama],
    onSpecialSummon: blockZones,
    *onSummon(e, m, p) {
      yield* blockZones(e, m, p);
    },
  };

  // "?" ATK: it gains the original ATK of the Dinosaur monster used for its Fusion Summon (fx.fusionMatList, tags.fusS).
  // The Quick Effect moves the target of a card or effect that targets only this card (ChainLink.targetUid) to another
  // card that would be an appropriate target. Scripts do not describe what they may target, so the new target is
  // limited to the other face-up monsters on this card's side of the field (they meet the usual "monster your
  // opponent controls" / "face-up monster" conditions the original target did).
  const machine = (e: Engine, c: Card) => isMonster(e, c) && raceOf(e, c) === 'Machine';
  const dino = (e: Engine, c: Card) => isMonster(e, c) && raceOf(e, c) === 'Dinosaur';
  const retargets = (e: Engine, tank: FieldCard) => targetable(e, faceUpMonsters(e, ctrl(e, tank)).filter((m) => m.uid !== tank.uid));
  E['Dyna Tank'] = {
    fusionTests: [machine, dino],
    baseStats: (e, m) => ({ atk: 0, def: info(e, m).def ?? 0 }),
    selfBonus: (_e, m) => ({ atk: m.tags?.dynaAtk ?? 0, def: 0 }),
    *onSpecialSummon(e, m) {
      if (!m.tags?.fusS) return;
      const mats = map<number[]>(e, 'fusionMatList')[m.uid] ?? [];
      const d = mats.map((u) => e.find(u)?.card).find((c): c is Card => !!c && info(e, c).race === 'Dinosaur');
      if (!d) return;
      tag(m).dynaAtk = Math.max(0, info(e, d).atk ?? 0);
      e.log(null, `${m.name} gains ${tag(m).dynaAtk} ATK from ${d.name}`);
    },
    quick: {
      repeat: true,
      label: 'change the target',
      can: (e, c, p, t, ctx) => {
        const l = ctx.link;
        const m = e.fieldCard(c.uid);
        if (!m || !l || (t !== 'spell' && t !== 'trap' && t !== 'effect') || l.card.uid === c.uid) return false;
        return l.targetUid === c.uid && e.state.chain.includes(l) && e.oncePerTurn('Dyna Tank:1', p) && retargets(e, m).length > 0;
      },
      *cost(e, card, p, link) {
        const m = e.fieldCard(card.uid);
        if (!m) return false;
        const t = yield* pickOne(e, p, `${card.name}: the target becomes which card?`, retargets(e, m), true);
        if (!t) return false;
        e.useOnce('Dyna Tank:1', p);
        (link.payload as Record<string, unknown>).to = t.uid;
      },
      *run(e, card, p, link) {
        const pl = link.payload as { to?: number; ctx?: { link?: ChainLink } };
        const l = pl.ctx?.link;
        const to = pl.to !== undefined ? e.fieldCard(pl.to) : null;
        if (!l || !to || !e.state.chain.includes(l) || l.targetUid !== card.uid) return;
        l.targetUid = to.uid;
        if (l.target) l.target = e.find(to.uid)!.loc;
        e.log(p, `${card.name}: ${l.card.name} now targets ${label(to)}`);
      },
    },
    onLeaveField: markLeave,
    *onDestroyed(e, card, controller, byBattle) {
      if (card.owner !== controller || !leftByOpp(e, card.uid, byBattle) || !e.oncePerTurn('Dyna Tank:2', controller)) return;
      const list = e.player(controller).gy.filter((c) => dino(e, c) && revivable(e, controller, c));
      if (!list.length || !freeMZ(e, controller) || !(yield* e.yesno(controller, 'Dyna Tank: Special Summon a Dinosaur monster from your GY?'))) return;
      e.useOnce('Dyna Tank:2', controller);
      yield* summonOneOf(e, controller, 'Special Summon which Dinosaur?', list);
    },
  };

  // Paying the LP happens when the effect resolves (Speed Duel monster effects pay their costs at resolution here).
  E['Coordius the Triphasic Dealmon'] = {
    fusionTests: [(e, c) => sub(e, c) === 'Synchro', (e, c) => sub(e, c) === 'Xyz', (e, c) => sub(e, c) === 'Link'],
    ignition: {
      can: (e, m, p) => !!m.tags?.fusS && !m.tags?.coordUsed && e.oncePerTurn('Coordius:1', p) && e.player(p).lp > 2000,
      *run(e, m, p) {
        if (!e.fieldCard(m.uid) || !m.faceUp || m.tags?.coordUsed) return;
        e.useOnce('Coordius:1', p);
        const opp = other(p);
        const oppCards = () => [...e.monsters(opp), ...stOf(e, opp)];
        const opts = [
          { label: 'Add 1 Spell/Trap from your GY to your hand', ok: e.player(p).gy.some((c) => isSpell(e, c) || isTrap(e, c)) },
          { label: 'Destroy 3 cards your opponent controls', ok: oppCards().length >= 3 },
          { label: 'Gain ATK equal to half the LP difference; your other monsters cannot attack', ok: true },
        ].map((o, i) => ({ ...o, i })).filter((o) => o.ok);
        const most = Math.min(opts.length, Math.floor((e.player(p).lp - 1) / 2000));
        if (most < 1) return;
        const picks = yield* e.select(p, `${m.name}: pay 2000 LP for each effect. Apply which?`, opts.map((o) => ({ label: o.label })), 1, most, true);
        if (!picks || !picks.length) return;
        const chosen = picks.map((k) => opts[k].i).sort();
        e.payLp(p, 2000 * chosen.length);
        tag(m).coordUsed = 1;
        e.log(p, `${e.player(p).name} pays ${2000 * chosen.length} LP for ${m.name}`);
        if (chosen.includes(0)) {
          const c = yield* pickOne(e, p, 'Add which Spell/Trap to your hand?', e.player(p).gy.filter((x) => isSpell(e, x) || isTrap(e, x)));
          if (c) e.toHandOf(c.uid, p);
        }
        if (chosen.includes(1) && oppCards().length) {
          const n = Math.min(3, oppCards().length);
          const list = yield* pick(e, p, `Destroy ${n} cards your opponent controls`, oppCards(), n, n, false, false);
          if (list) yield* e.destroy(list.map((c) => c.uid));
        }
        if (chosen.includes(2) && e.fieldCard(m.uid)?.faceUp) {
          const gain = Math.floor(Math.abs(e.player(p).lp - e.player(opp).lp) / 2);
          boostTurn(m, gain);
          tag(m).coordAtkTurn = e.state.turn;
          for (const x of e.monsters(p)) if (x.uid !== m.uid) tag(x).noAttackTurn = e.state.turn;
          e.log(p, `${m.name} gains ${gain} ATK; ${e.player(p).name}'s other monsters cannot attack this turn`);
        }
      },
    },
    // "Your other monsters cannot attack" also covers monsters that arrive later this turn.
    *onAnySummon(e, w, wp, m, controller) {
      if (w.tags?.coordAtkTurn === e.state.turn && controller === wp && m.uid !== w.uid) tag(m).noAttackTurn = e.state.turn;
    },
  };

  // ======================= Spells =======================
  // The Draw Phase effect is offered at the start of the Standby Phase: the card drawn goes back on top of the Deck
  // (the same way as Flame Tiger). Its lock is a summon lock (fx.summonLocks) that Astral Force's own Summon is exempt from.
  E['Rank-Up-Magic Astral Force'] = {
    canActivate: (e, _c, p, t) => isMain(t) && astralTargets(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Astral Force: target which Xyz Monster?', astralTargets(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || !m.faceUp || zoneOf(e, m.uid) !== 'mz' || e.controller(m.uid) !== p) return;
      const ups = rankUps(e, p, m);
      const up = ups.length === 1 ? ups[0] : yield* pickOne(e, p, `Astral Force: Special Summon which Rank ${rankOf(e, m) + 2} Xyz Monster?`, ups);
      if (!up) return;
      for (const l of (fx(e).summonLocks ?? []) as (SummonLock & { astral?: number })[]) if (l.astral) l.except = up.uid;
      e.log(p, `Astral Force: ${m.name} ranks up into ${up.name}`);
      // Treated as an Xyz Summon: the monster and its materials go under the new one (tags.xyzS).
      yield* e.extraSummon(p, up.uid, [m.uid], 'Xyz');
    },
    *onStandbyInGrave(e, card, p) {
      const d = fx(e).normalDraw as { player: Pid; uid: number; turn: number } | undefined;
      if (!d || d.player !== p || d.turn !== e.state.turn || zoneOf(e, d.uid) !== 'hand' || e.find(d.uid)?.loc.player !== p) return;
      if (!(yield* e.yesno(p, 'Rank-Up-Magic Astral Force: add it to your hand instead of your normal draw?'))) return;
      e.toDeckTop(d.uid);
      e.toHandOf(card.uid, p);
      e.log(p, `${e.player(p).name} gives up the normal draw and adds Rank-Up-Magic Astral Force to the hand`);
      const locks = ((fx(e).summonLocks ??= []) as SummonLock[]).filter((l) => l.turn === e.state.turn);
      locks.push({ p, turn: e.state.turn, normal: false, special: true, only: [], astral: 1 } as SummonLock);
      fx(e).summonLocks = locks;
    },
  };

  // ======================= Traps =======================
  // "Until the End Phase" is kept until the end of the turn. The copy is looked up by name (engine copiedEffect) and
  // reads the selected monster's own coin result (tags.coin).
  const arcanaMine = (e: Engine, p: Pid) => faceUpMonsters(e, p).filter((m) => named(e, m, 'Arcana Force'));
  const arcanaGy = (e: Engine) => [...e.player(0).gy, ...e.player(1).gy].filter((c) => isMonster(e, c) && named(e, c, 'Arcana Force'));
  E['Arcana Call'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && arcanaMine(e, p).length > 0 && arcanaGy(e).length > 0,
    *resolve(e, _link, p) {
      const m = yield* pickOne(e, p, 'Arcana Call: select which of your Arcana Force monsters?', arcanaMine(e, p));
      if (!m) return;
      const g = yield* pickOne(e, p, 'Arcana Call: banish which Arcana Force from a GY?', arcanaGy(e));
      if (!g) return;
      e.banish(g.uid);
      if (zoneOf(e, g.uid) !== 'removed' || !e.fieldCard(m.uid)?.faceUp) return;
      map<{ name: string; turn: number }>(e, 'effectAs')[m.uid] = { name: g.name, turn: e.state.turn };
      e.log(p, `Arcana Call: ${m.name}'s effect becomes ${g.name}'s effect (${m.tags?.coin === 1 ? 'Heads' : m.tags?.coin === 2 ? 'Tails' : 'no coin toss'})`);
    },
  };

  E['Cipher Bit'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && cipherXyz(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Cipher Bit: target which Xyz Monster?', cipherXyz(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || !m.faceUp || zoneOf(e, m.uid) !== 'mz' || e.controller(m.uid) !== p) return;
      if (!e.attachMat(m, link.card.uid)) return;
      map<number>(e, 'cipherBit')[m.uid] = e.state.turn;
      e.linger('Cipher Bit', p);
      e.log(p, `Cipher Bit is attached to ${m.name}; the next time it would be destroyed this turn, it is not`);
    },
    lingering: {
      shields(e, _owner, target, how) {
        const saved = map<number>(e, 'cipherBit');
        if (how === 'target' || saved[target.uid] !== e.state.turn) return false;
        delete saved[target.uid];
        e.log(null, `Cipher Bit: ${target.name} is not destroyed`);
        return true;
      },
    },
  };

  const highestIsTheirs = (e: Engine, p: Pid) => {
    const all = faceUpMonsters(e);
    if (!all.length) return false;
    const top = Math.max(...all.map((m) => e.atkOf(m)));
    return faceUpMonsters(e, other(p)).some((m) => e.atkOf(m) === top);
  };
  const doubleTargets = (e: Engine, p: Pid) => cipherXyz(e, p).filter((m) => e.matsOf(m).length > 0);
  E['Double Cipher'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && highestIsTheirs(e, p) && doubleTargets(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Double Cipher: target which Xyz Monster?', doubleTargets(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || !m.faceUp || e.controller(m.uid) !== p || !e.matsOf(m).length) return;
      if (!(yield* e.detachMats(m, e.matsOf(m).length))) return;
      const copy = e.player(p).fusion.find((c) => e.sameName(c, m) && !e.summonBlocked(p, c, 'special', 'fusion'));
      if (!copy || !freeMZ(e, p)) return;
      yield* e.specialSummon(copy.uid, p, 'atk');
    },
  };

  const dieTuners = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && info(e, c).tuner && named(e, c, 'Speedroid') && revivable(e, p, c));
  E['Re-dyce-cle'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && freeMZ(e, p) && dieTuners(e, p).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Re-dyce-cle: target which Speedroid Tuner?', dieTuners(e, p), true);
      if (!c) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      const uid = link.targetUid;
      if (uid === undefined || zoneOf(e, uid) !== 'gy' || !freeMZ(e, p)) return;
      // Negated before it lands, so its own "when Summoned" effects do not apply either.
      yield* e.specialSummon(uid, p, 'atk', true, (fc) => void ((fc.tags ??= {}).negated = 1));
      const m = e.fieldCard(uid);
      if (!m) return;
      const n = e.roll(6);
      tag(m).lvSet = n;
      tag(m).lvSetTurn = e.state.turn;
      e.log(p, `Re-dyce-cle: the die shows ${n}; ${m.name} is Level ${n} this turn`);
    },
    graveIgnition: {
      can: (e, _c, p) => windSynchros(e, p).length > 0,
      *run(e, card, p) {
        if (zoneOf(e, card.uid) !== 'gy') return;
        e.banish(card.uid);
        const list = windSynchros(e, p);
        if (!list.length) return;
        const c = yield* pickOne(e, p, 'Re-dyce-cle: Synchro Summon which WIND Synchro Monster?', list.map((x) => x.card));
        if (!c) return;
        const sets = list.find((x) => x.card.uid === c.uid)!.sets;
        let mats = sets[0];
        if (sets.length > 1) {
          const k = yield* e.select(p, `Synchro Summon ${c.name} using:`, sets.map((s) => ({ label: s.map((m) => m.name).join(' + ') })), 1, 1);
          mats = sets[k?.[0] ?? 0] ?? sets[0];
        }
        yield* e.extraSummon(p, c.uid, mats.map((m) => m.uid), 'Synchro');
      },
    },
  };

  // "Either player's zones linked to that monster": see linkedZones (no Link Arrows; the open zones next to it).
  E['Cynet Circuit'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.oncePerTurn('Cynet Circuit:1', p) && firewalls(e, p).some((m) => linkedZones(e, m).length > 0) && e.player(p).gy.some((c) => revivable(e, p, c)),
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Cynet Circuit: target which Firewall Link Monster?', firewalls(e, p).filter((x) => linkedZones(e, x).length > 0), true);
      if (!m) return false;
      e.useOnce('Cynet Circuit:1', p);
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || !m.faceUp || e.controller(m.uid) !== p) return;
      const zones = linkedZones(e, m);
      const list = e.player(p).gy.filter((c) => revivable(e, p, c));
      if (!zones.length || !list.length) return;
      const chosen = yield* pick(e, p, `Cynet Circuit: Special Summon up to ${Math.min(zones.length, list.length)} monsters`, list, 1, Math.min(zones.length, list.length));
      if (!chosen) return;
      for (const [i, c] of chosen.entries()) {
        const z = zones[i];
        if (zoneOf(e, c.uid) !== 'gy' || !e.monsterZoneOpen(p, z)) continue;
        yield* e.specialSummon(c.uid, p, 'atk');
        moveToZone(e, c.uid, p, z);
      }
    },
    graveIgnition: {
      can: (e, _c, p) => e.player(p).lp <= 2000 && e.oncePerTurn('Cynet Circuit:2', p) && e.player(p).gy.some((c) => sub(e, c) === 'Link' && named(e, c, 'Firewall')),
      *run(e, card, p) {
        if (zoneOf(e, card.uid) !== 'gy') return;
        e.useOnce('Cynet Circuit:2', p);
        e.banish(card.uid);
        const c = yield* pickOne(e, p, 'Cynet Circuit: return which Firewall Link Monster to the Extra Deck?', e.player(p).gy.filter((x) => sub(e, x) === 'Link' && named(e, x, 'Firewall')));
        if (!c) return;
        e.toHandOf(c.uid, p); // an Extra Deck monster goes to the Extra Deck instead of the hand
        if (zoneOf(e, c.uid) !== 'fusion') return;
        e.log(p, `${c.name} returns to the Extra Deck`);
        if (!freeMZ(e, p) || e.summonBlocked(p, c, 'special', 'fusion') || !(yield* e.yesno(p, `Cynet Circuit: Special Summon ${c.name} from your Extra Deck?`))) return;
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
  };
}
