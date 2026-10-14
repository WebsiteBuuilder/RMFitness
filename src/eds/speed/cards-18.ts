// Speed Duel card scripts, batch 18: Xyz Monsters (Number 49: Fortune Tune ... Princess Cologne).
// The generic procedure in extra.ts Xyz Summons them from their material line; these scripts are their effects.
// Speed Duel has 3 Monster Zones, so Number C43 and Number C69 (4 materials) only arrive by card effects
// (Rank-Up-Magic). Uses the b18 engine hooks: destroyReplace, locksMonsterEffects, copied effects
// (tags.copyFx: Engine.scriptOf) and locked zones (fx.zoneLocks: Engine.zoneLocked).
import type { EffectDef, GraveEvent } from '../effects';
import type { SpeedHelpers } from './helpers';
import {
  boostPerm,
  boostTurn,
  chooseOption,
  ctrl,
  discardCost,
  faceUpMonsters,
  freeMZ,
  freeST,
  info,
  isMonster,
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
} from './helpers';
import type { Card, ChainLink, Engine, FieldCard, Pid, Step, Trigger } from './helpers';

// ---------- local helpers ----------
const fxMap = <T>(e: Engine, key: string): Record<number, T> => (e.state.fx[key] ??= {}) as Record<number, T>;
const zoneOf = (e: Engine, uid: number) => e.find(uid)?.loc.zone;
const isXyz = (e: Engine, c: Card) => info(e, c).sub === 'Xyz';
const mats = (e: Engine, c: Card) => e.matsOf(c);
const hasMat = (e: Engine, c: Card, name: string) => e.matsOf(c).some((x) => x.name === name);
/** Rank, with any increase an effect gave it (Outer Entity Nyarla). */
const rankOf = (e: Engine, c: Card) => (info(e, c).rank ?? 0) + ((c as FieldCard).tags?.rankUp ?? 0);
const self = (e: Engine, c: Card) => e.fieldCard(c.uid);
const target = (e: Engine, link: ChainLink) => (link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null);
/** "detach 1 material" was paid for this chain link (Heraldry Record looks for it). */
const markDetach = (link: ChainLink) => {
  link.payload = { ...((link.payload as object | undefined) ?? {}), detach: true };
};
const oppXyz = (e: Engine, p: Pid) => targetable(e, faceUpMonsters(e, other(p)).filter((m) => isXyz(e, m)));
const cardsOn = (e: Engine, p: Pid) => e.monsters(p).length + stOf(e, p).length;

/** This monster now has another monster's name and original effect (Number 8, Number C69, One-Eyed Skill Gainer). */
function copyFrom(e: Engine, m: FieldCard, from: FieldCard, p: Pid, opts: { turn?: boolean; gain?: boolean }) {
  const names = (e.state.fx.copyNames ??= []) as string[];
  const name = e.nameOf(from);
  let i = names.indexOf(name);
  if (i < 0) i = names.push(name) - 1;
  const t = tag(m);
  t.copyFx = i + 1;
  if (opts.turn) t.copyTurn = e.state.turn;
  else delete t.copyTurn;
  if (opts.gain) t.copyGain = 1;
  else delete t.copyGain;
  e.log(p, `${m.name}'s name becomes ${name} and it ${opts.gain ? 'gains' : 'takes on'} its effect${opts.turn ? ' until the End Phase' : ''}`);
}

/** ATK gained "during that damage calculation only": undone once the battle is over (stateCheck of the card that gave it). */
type CalcBoost = { uid: number; n: number; battleNo: number };
function calcBoost(e: Engine, m: FieldCard, n: number) {
  boostTurn(m, n);
  ((e.state.fx.calcBoosts ??= []) as CalcBoost[]).push({ uid: m.uid, n, battleNo: e.state.fx.battleNo ?? 0 });
  e.log(e.controller(m.uid), `${m.name} gains ${n} ATK during this damage calculation`);
}
function* undoCalcBoosts(e: Engine): Step {
  const list = (e.state.fx.calcBoosts ?? []) as CalcBoost[];
  if (!list.length) return;
  const now = e.state.fx.battleNo ?? 0;
  const keep: CalcBoost[] = [];
  for (const x of list) {
    if (e.state.battle && x.battleNo === now) {
      keep.push(x);
      continue;
    }
    const m = e.fieldCard(x.uid);
    if (m) boostTurn(m, -x.n);
  }
  e.state.fx.calcBoosts = keep;
}
/** The two monsters battling right now (attacker, target), if any. */
const battling = (e: Engine) => {
  const b = e.state.battle;
  if (!b) return null;
  return { a: e.fieldCard(b.attacker), t: b.target !== null ? e.fieldCard(b.target) : null };
};
/** A Quick Effect usable while a battle is going on (stands in for "during damage calculation"). */
const inBattle = (e: Engine, t: Trigger) => !!e.state.battle && e.state.phase === 'BP' && t !== 'main' && t !== 'damage' && t !== 'destroyed';

type Quick = NonNullable<EffectDef['quick']>;
/**
 * "Once per turn: You can detach 1 material from this card[, then target ...]; ..." used in your Main Phase.
 * The material is detached as the cost (and marked on the chain link); the target is chosen then too.
 */
function detachMain(o: {
  label: string;
  can?(e: Engine, m: FieldCard, p: Pid): boolean;
  targets?(e: Engine, m: FieldCard, p: Pid): FieldCard[];
  title?: string;
  repeat?: boolean;
  noDetach?: boolean;
  run(e: Engine, m: FieldCard, p: Pid, t: FieldCard | null, link: ChainLink): Step;
}): Quick {
  return {
    label: o.label,
    repeat: o.repeat,
    can(e, c, p, t) {
      const m = self(e, c);
      if (t !== 'main' || !m || !m.faceUp) return false;
      if (!o.noDetach && !mats(e, m).length) return false;
      if (o.targets && !o.targets(e, m, p).length) return false;
      return !o.can || o.can(e, m, p);
    },
    *cost(e, c, p, link) {
      const m = self(e, c);
      if (!m) return false;
      if (o.targets) {
        const t = yield* pickOne(e, p, o.title ?? `${c.name}: target which monster?`, o.targets(e, m, p), true);
        if (!t) return false;
        link.targetUid = t.uid;
      }
      if (!o.noDetach) {
        if (!(yield* e.detachMats(m, 1, p))) return false;
        markDetach(link);
      }
    },
    *run(e, c, p, link) {
      const m = self(e, c);
      if (!m || !m.faceUp) return;
      yield* o.run(e, m, p, o.targets ? target(e, link) : null, link);
    },
  };
}

export function install(E: Record<string, EffectDef>, _h: SpeedHelpers) {
  // ===================== Number 49: Fortune Tune =====================
  E['Number 49: Fortune Tune'] = {
    *onStandby(e, m, p) {
      if (e.state.turnPlayer !== p || !e.fieldCard(m.uid)) return;
      e.gainLp(p, 500);
      e.log(p, `Number 49: Fortune Tune: ${e.player(p).name} gains 500 LP`);
    },
    cannotBeTargeted: () => true,
    *destroyReplace(e, m) {
      const p = ctrl(e, m);
      if (!mats(e, m).length) return false;
      if (!(yield* e.yesno(p, 'Number 49: Fortune Tune would be destroyed. Detach 1 material instead?'))) return false;
      return yield* e.detachMats(m, 1, p);
    },
    *onSentToGrave(e, card, owner, from) {
      if (from !== 'mz' || !e.oncePerTurn('n49', owner)) return;
      const lv3 = () => e.player(owner).gy.filter((c) => c.uid !== card.uid && isMonster(e, c) && (info(e, c).level ?? 0) === 3);
      if (lv3().length < 2 || !(yield* e.yesno(owner, 'Number 49: Fortune Tune: shuffle 2 Level 3 monsters from your GY into the Deck and return it to the Extra Deck?'))) return;
      const two = yield* pick(e, owner, 'Shuffle which 2 Level 3 monsters into the Deck?', lv3(), 2, 2);
      if (!two || two.length < 2) return;
      e.useOnce('n49', owner);
      for (const c of two) toDeck(e, c.uid);
      e.log(owner, `${e.player(owner).name} shuffles ${two.map((c) => c.name).join(' and ')} into the Deck`);
      if (zoneOf(e, card.uid) === 'gy') {
        e.toDeckTop(card.uid);
        e.log(owner, 'Number 49: Fortune Tune returns to the Extra Deck');
      }
    },
  };

  // ===================== Number 57: Tri-Head Dust Dragon =====================
  type ZoneLock = { p: Pid; kind: 'mz' | 'sz'; i: number; src: number };
  E['Number 57: Tri-Head Dust Dragon'] = {
    *onSpecialSummon(e, m, p) {
      const ts = targetable(e, faceUpMonsters(e, other(p)));
      if (!ts.length || !(yield* e.yesno(p, 'Number 57: Tri-Head Dust Dragon: gain ATK equal to an opponent\'s monster\'s ATK?'))) return;
      const t = yield* pickOne(e, p, 'Target which monster?', ts);
      if (!t || !e.fieldCard(m.uid)) return;
      const n = e.atkOf(t);
      boostPerm(m, n);
      e.log(p, `Number 57: Tri-Head Dust Dragon gains ${n} ATK`);
    },
    quick: detachMain({
      label: 'lock an unused zone',
      repeat: true,
      can: (e, m, p) => cardsOn(e, other(p)) > cardsOn(e, p) && zonesFree(e).length > 0,
      *run(e, m, p) {
        const zs = zonesFree(e);
        if (!zs.length) return;
        // The opponent's zones are offered first.
        zs.sort((x, y) => (x.p === p ? 1 : 0) - (y.p === p ? 1 : 0));
        const k = yield* chooseOption(e, p, 'Which zone cannot be used?', zs.map((z) => `${e.player(z.p).name}'s ${z.kind === 'mz' ? 'Monster' : 'Spell & Trap'} Zone ${z.i + 1}`));
        const z = zs[k ?? 0];
        ((e.state.fx.zoneLocks ??= []) as ZoneLock[]).push({ ...z, src: m.uid });
        e.log(p, `${e.player(z.p).name}'s ${z.kind === 'mz' ? 'Monster' : 'Spell & Trap'} Zone ${z.i + 1} cannot be used while Number 57: Tri-Head Dust Dragon is face-up`);
      },
    }),
    *onLeaveField(e, fc) {
      const list = (e.state.fx.zoneLocks ?? []) as ZoneLock[];
      if (list.some((x) => x.src === fc.uid)) e.state.fx.zoneLocks = list.filter((x) => x.src !== fc.uid);
    },
  };
  function zonesFree(e: Engine): Omit<ZoneLock, 'src'>[] {
    const out: Omit<ZoneLock, 'src'>[] = [];
    for (const p of [0, 1] as Pid[]) {
      const ps = e.player(p);
      ps.mz.forEach((z, i) => z === null && !e.zoneLocked(ps, 'mz', i) && out.push({ p, kind: 'mz', i }));
      ps.sz.forEach((z, i) => z === null && !e.zoneLocked(ps, 'sz', i) && out.push({ p, kind: 'sz', i }));
    }
    return out;
  }

  // ===================== Number 58: Burner Visor =====================
  const visorTargets = (e: Engine, m: FieldCard, p: Pid) => targetable(e, faceUpMonsters(e, p).filter((x) => x.uid !== m.uid && isXyz(e, x)));
  E['Number 58: Burner Visor'] = {
    ignition: {
      can(e, m, p) {
        if (!e.oncePerTurn(`n58:${m.uid}`, p)) return false;
        const z = zoneOf(e, m.uid);
        if (z === 'mz') return freeST(e, p) >= 0 && visorTargets(e, m, p).length > 0;
        return z === 'sz' && m.equippedTo !== undefined && freeMZ(e, p);
      },
      *run(e, m, p) {
        const z = zoneOf(e, m.uid);
        e.useOnce(`n58:${m.uid}`, p);
        if (z === 'mz') {
          const host = yield* pickOne(e, p, 'Number 58: Burner Visor: equip to which Xyz Monster?', visorTargets(e, m, p));
          if (host) yield* equipVisor(e, m, host, p);
          return;
        }
        if (z !== 'sz') return;
        const host = m.equippedTo !== undefined ? e.fieldCard(m.equippedTo) : null;
        if (host) host.equips = host.equips.filter((u) => u !== m.uid);
        m.equippedTo = undefined;
        yield* e.specialSummon(m.uid, p, 'atk');
        // Could not be Summoned: it stays equipped.
        const still = e.fieldCard(m.uid);
        if (still && zoneOf(e, m.uid) === 'sz' && host && e.fieldCard(host.uid)) {
          still.equippedTo = host.uid;
          host.equips.push(still.uid);
        }
      },
    },
    // The equipped monster can attack directly.
    *stateCheck(e, c) {
      const host = zoneOf(e, c.uid) === 'sz' && c.equippedTo !== undefined ? e.fieldCard(c.equippedTo) : null;
      if (host && host.tags?.directTurn !== e.state.turn) tag(host).directTurn = e.state.turn;
    },
    *onBattleDamageDealt(e, c, attacker, p) {
      if (c.equippedTo !== attacker.uid || !e.player(p).hand.length || e.state.winner !== null) return;
      if (!(yield* e.yesno(p, 'Number 58: Burner Visor: discard 1 card to inflict 500 damage?'))) return;
      if (!(yield* discardCost(e, p, 1))) return;
      e.log(p, 'Number 58: Burner Visor inflicts 500 damage');
      e.damage(other(p), 500);
    },
  };
  /** Moves Burner Visor from a Monster Zone to a Spell & Trap Zone as an Equip Card (its materials go to the GY). */
  function* equipVisor(e: Engine, m: FieldCard, host: FieldCard, p: Pid): Step {
    const zone = freeST(e, p);
    const f = e.find(m.uid);
    if (zone < 0 || !f || f.loc.zone !== 'mz' || !e.fieldCard(host.uid) || !host.faceUp) return;
    for (const u of m.equips.slice()) yield* e.sendToGrave(u, 'used');
    const g = e.find(m.uid);
    if (!g || g.loc.zone !== 'mz' || !e.fieldCard(host.uid) || e.player(p).sz[zone] !== null) return;
    for (const c of m.mats?.splice(0) ?? []) e.player(c.owner).gy.push(c);
    e.player(g.loc.player).mz[g.loc.index] = null;
    const fc: FieldCard = { uid: m.uid, name: m.name, owner: m.owner, pos: 'atk', faceUp: true, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true, equippedTo: host.uid };
    e.player(p).sz[zone] = fc;
    host.equips.push(fc.uid);
    e.event('activate', { uid: fc.uid, player: p });
    e.log(p, `Number 58: Burner Visor is equipped to ${host.name}`);
  }

  // ===================== Number 5: Doom Chimera Dragon =====================
  type Hits = { turn: number; uids: number[] };
  const hitsOf = (e: Engine, m: FieldCard) => {
    const h = fxMap<Hits>(e, 'n5Hits')[m.uid];
    return h && h.turn === e.state.turn ? h.uids : [];
  };
  E['Number 5: Doom Chimera Dragon'] = {
    selfBonus: (e, m) => ({ atk: 1000 * mats(e, m).length, def: 0 }),
    // With material: one attack on each monster the opponent controls.
    attacks(e, m) {
      if (!mats(e, m).length) return 1;
      const hit = hitsOf(e, m);
      const ctl = ctrl(e, m);
      const left = e.monsters(other(ctl)).filter((t) => !hit.includes(t.uid)).length;
      return Math.max(1, hit.length + left);
    },
    targetFilter: (e, m, t) => !mats(e, m).length || !hitsOf(e, m).includes(t.uid),
    attackBonus(e, m, t) {
      tag(m).battledTurn = e.state.turn;
      if (t) {
        const map = fxMap<Hits>(e, 'n5Hits');
        const h = map[m.uid]?.turn === e.state.turn ? map[m.uid] : (map[m.uid] = { turn: e.state.turn, uids: [] });
        if (!h.uids.includes(t.uid)) h.uids.push(t.uid);
      }
      return 0;
    },
    *onAttacked(e, m) {
      if (e.fieldCard(m.uid)) tag(m).battledTurn = e.state.turn;
    },
    *onBattlePhaseEnd(e, m, p) {
      if (m.tags?.battledTurn !== e.state.turn || m.tags?.n5End === e.state.turn) return;
      tag(m).n5End = e.state.turn;
      const mine = e.player(p).gy.filter((c) => isMonster(e, c));
      const theirs = e.player(other(p)).gy;
      const labels: string[] = [];
      if (mine.length) labels.push('Attach 1 monster from your GY to it as material');
      if (theirs.length) labels.push("Place 1 card from your opponent's GY on top of their Deck");
      if (!labels.length) return;
      const k = yield* chooseOption(e, p, 'Number 5: Doom Chimera Dragon: activate an effect?', labels, true);
      if (k === null) return;
      if (labels[k].startsWith('Attach')) {
        const c = yield* pickOne(e, p, 'Attach which monster?', mine);
        if (c && e.fieldCard(m.uid) && e.attachMat(m, c.uid)) e.log(p, `${c.name} is attached to Number 5: Doom Chimera Dragon`);
      } else {
        const c = yield* pickOne(e, p, 'Place which card on top of their Deck?', theirs);
        if (c) {
          e.toDeckTop(c.uid);
          e.log(p, `${c.name} is placed on top of ${e.player(other(p)).name}'s Deck`);
        }
      }
    },
  };

  // ===================== Number 62: Galaxy-Eyes Prime Photon Dragon =====================
  const GEPD = 'Galaxy-Eyes Photon Dragon';
  type N62 = { by: Pid | null; gepd: boolean };
  E['Number 62: Galaxy-Eyes Prime Photon Dragon'] = {
    quick: {
      label: 'gain ATK this damage calculation',
      repeat: true,
      can(e, c, p, t) {
        const m = self(e, c);
        const b = battling(e);
        if (!m || !m.faceUp || !inBattle(e, t) || !b || !mats(e, m).length) return false;
        if (b.a?.uid !== m.uid && b.t?.uid !== m.uid) return false;
        return fxMap<number>(e, 'n62Battle')[m.uid] !== (e.state.fx.battleNo ?? 0);
      },
      *cost(e, c, p, link) {
        const m = self(e, c);
        if (!m || !(yield* e.detachMats(m, 1, p))) return false;
        markDetach(link);
        fxMap<number>(e, 'n62Battle')[m.uid] = e.state.fx.battleNo ?? 0;
      },
      *run(e, c) {
        const m = self(e, c);
        const b = battling(e);
        if (!m || !m.faceUp || !b || (b.a?.uid !== m.uid && b.t?.uid !== m.uid)) return;
        const ranks = faceUpMonsters(e).filter((x) => isXyz(e, x)).reduce((a, x) => a + rankOf(e, x), 0);
        if (ranks > 0) calcBoost(e, m, ranks * 200);
      },
    },
    *stateCheck(e, m) {
      yield* undoCalcBoosts(e);
      const has = hasMat(e, m, GEPD) ? 1 : 0;
      if ((m.tags?.gepd ?? 0) !== has) tag(m).gepd = has;
    },
    *onSpecialSummon(e, m) {
      tag(m).gepd = hasMat(e, m, GEPD) ? 1 : 0;
    },
    damageMod(e, src, srcCtl, damaged, amount, byEffect) {
      const b = e.state.battle;
      if (byEffect || damaged === srcCtl || !b || (b.attacker !== src.uid && b.target !== src.uid) || hasMat(e, src, GEPD)) return undefined;
      return Math.floor(amount / 2);
    },
    *onLeaveField(e, fc, controller) {
      fxMap<N62>(e, 'n62Left')[fc.uid] = { by: e.actor, gepd: !!fc.tags?.gepd && controller === fc.owner };
    },
    *onDestroyed(e, card, controller, byBattle) {
      const rec = fxMap<N62>(e, 'n62Left')[card.uid];
      delete fxMap<N62>(e, 'n62Left')[card.uid];
      if (byBattle || !rec || !rec.gepd || rec.by !== other(controller)) return;
      fxMap<number>(e, 'n62Return')[card.uid] = 0;
      e.log(card.owner, 'Number 62: Galaxy-Eyes Prime Photon Dragon will return during its owner\'s 2nd Standby Phase');
    },
    *onStandbyInGrave(e, card, owner) {
      const map = fxMap<number>(e, 'n62Return');
      if (map[card.uid] === undefined) return;
      map[card.uid]++;
      if (map[card.uid] < 2) return;
      delete map[card.uid];
      if (!freeMZ(e, owner) || !(yield* e.yesno(owner, 'Special Summon Number 62: Galaxy-Eyes Prime Photon Dragon and double its ATK?'))) return;
      yield* e.specialSummon(card.uid, owner, 'atk');
      const m = e.fieldCard(card.uid);
      if (!m) return;
      const n = e.atkOf(m);
      boostPerm(m, n);
      e.log(owner, `Number 62: Galaxy-Eyes Prime Photon Dragon's ATK doubles (${e.atkOf(m)})`);
    },
  };

  // ===================== Number 8: Heraldic King Genom-Heritage =====================
  E['Number 8: Heraldic King Genom-Heritage'] = {
    quick: detachMain({
      label: "copy an opponent's Xyz Monster",
      noDetach: true,
      targets: (e, _m, p) => oppXyz(e, p),
      title: "Number 8: target which of your opponent's Xyz Monsters?",
      *run(e, m, p, t) {
        if (!t || !t.faceUp || e.controller(t.uid) !== other(p)) return;
        const atk = e.atkOf(t);
        boostTurn(m, atk - (info(e, m).atk ?? 0));
        copyFrom(e, m, t, p, { turn: true });
        boostTurn(t, -e.atkOf(t));
        negateMonster(e, t, true);
        e.log(p, `Number 8: Heraldic King Genom-Heritage's ATK becomes ${e.atkOf(m)}; ${t.name}'s ATK becomes 0`);
      },
    }),
  };

  // ===================== Number C43: High Manipulator of Chaos =====================
  E['Number C43: High Manipulator of Chaos'] = {
    // All Tokens you control can make a second attack.
    *stateCheck(e, m, p) {
      for (const t of e.monsters(p)) {
        if (!t.token) continue;
        const g = tag(t);
        if (g.extraAttacksTurn === e.state.turn && (g.extraAttacksN ?? 0) >= 1) continue;
        g.extraAttacksTurn = e.state.turn;
        g.extraAttacksN = 1;
      }
    },
    quick: detachMain({
      label: 'Special Summon a Manipulator Token',
      can: (e, m, p) => hasMat(e, m, 'Number 43: Manipulator of Souls') && freeMZ(e, p),
      *run(e, _m, p) {
        const tok = e.createToken('Manipulator Token', p, 'atk', true, { atk: 0, def: 0, level: 1, attribute: 'DARK', race: 'Fiend' });
        if (!tok) return;
        const half = Math.floor(e.player(other(p)).lp / 2);
        boostPerm(tok, half, half);
        e.log(p, `The Manipulator Token's ATK and DEF become ${half}`);
      },
    }),
  };

  // ===================== Number C65: King Overfiend =====================
  E['Number C65: King Overfiend'] = {
    quick: detachMain({
      label: 'a monster loses 1000 ATK/DEF',
      can: (e, m) => hasMat(e, m, 'Number 65: Djinn Buster'),
      targets: (e, _m, p) => targetable(e, faceUpMonsters(e, other(p))),
      title: 'Number C65: target which monster?',
      *run(e, _m, p, t) {
        if (!t || !t.faceUp) return;
        boostPerm(t, -1000, -1000);
        e.log(p, `${t.name} loses 1000 ATK and DEF`);
      },
    }),
    // Effect Monsters your opponent controls cannot activate their effects.
    locksMonsterEffects: (e, _src, srcCtl, player, card) => player === other(srcCtl) && e.controller(card.uid) === player && info(e, card).kind === 'monster' && info(e, card).sub !== 'Normal',
  };

  // ===================== Number C69: Heraldry Crest of Horror =====================
  const C69 = 'Number C69: Heraldry Crest of Horror';
  E[C69] = {
    quick: {
      label: 'destroy all cards your opponent controls / copy an Xyz Monster',
      repeat: true,
      can(e, c, p, t, ctx) {
        const m = self(e, c);
        if (!m || !m.faceUp) return false;
        if (t === 'main') return hasMat(e, m, 'Number 69: Heraldry Crest') && mats(e, m).length > 0 && e.oncePerTurn(`c69:${m.uid}`, p) && oppXyz(e, p).length > 0;
        const b = e.state.battle;
        return t === 'attack' && !!b && ctx.uid === b.attacker && e.controller(b.attacker) === other(p) && cardsOn(e, other(p)) > 0;
      },
      *cost(e, c, p, link) {
        const m = self(e, c);
        if (!m || (link.payload as { trigger?: Trigger }).trigger !== 'main') return;
        const t = yield* pickOne(e, p, "Number C69: target which of your opponent's Xyz Monsters?", oppXyz(e, p), true);
        if (!t || !(yield* e.detachMats(m, 1, p))) return false;
        markDetach(link);
        link.targetUid = t.uid;
        e.useOnce(`c69:${m.uid}`, p);
      },
      *run(e, c, p, link) {
        const m = self(e, c);
        if (!m || !m.faceUp) return;
        if ((link.payload as { trigger?: Trigger }).trigger === 'main') {
          const t = target(e, link);
          if (!t || !t.faceUp) return;
          const gain = info(e, t).atk ?? 0;
          if (gain <= 0) return;
          boostTurn(m, gain);
          copyFrom(e, m, t, p, { turn: true, gain: true });
          return;
        }
        const q = other(p);
        const all = [...e.monsters(q), ...stOf(e, q)].map((x) => x.uid);
        e.log(p, `${C69} destroys all cards ${e.player(q).name} controls`);
        if (all.length) yield* e.destroy(all);
      },
    },
  };

  // ===================== Number C73: Abyss Supra Splash =====================
  E['Number C73: Abyss Supra Splash'] = {
    effectProof: (e, m) => hasMat(e, m, 'Number 73: Abyss Splash'),
    quick: {
      label: 'your battling monster gains ATK',
      repeat: true,
      can(e, c, p, t) {
        const m = self(e, c);
        const b = battling(e);
        if (!m || !m.faceUp || !inBattle(e, t) || !b || !b.a || !b.t || !mats(e, m).length) return false;
        if (e.controller(b.a.uid) === e.controller(b.t.uid)) return false;
        if (e.controller(b.a.uid) !== p && e.controller(b.t.uid) !== p) return false;
        return fxMap<number>(e, 'c73Battle')[m.uid] !== (e.state.fx.battleNo ?? 0);
      },
      *cost(e, c, p, link) {
        const m = self(e, c);
        if (!m || !(yield* e.detachMats(m, 1, p))) return false;
        markDetach(link);
        fxMap<number>(e, 'c73Battle')[m.uid] = e.state.fx.battleNo ?? 0;
      },
      *run(e, _c, p) {
        const b = battling(e);
        if (!b || !b.a || !b.t) return;
        const mine = e.controller(b.a.uid) === p ? b.a : e.controller(b.t.uid) === p ? b.t : null;
        const foe = mine === b.a ? b.t : b.a;
        if (!mine || !foe || e.controller(foe.uid) !== other(p)) return;
        const n = e.atkOf(foe);
        if (n > 0) calcBoost(e, mine, n);
      },
    },
    *stateCheck(e) {
      yield* undoCalcBoosts(e);
    },
  };

  // ===================== One-Eyed Skill Gainer =====================
  E['One-Eyed Skill Gainer'] = {
    quick: detachMain({
      label: "copy an opponent's Xyz Monster",
      repeat: true,
      can: (_e, m) => !m.tags?.skillGained,
      targets: (e, _m, p) => oppXyz(e, p),
      title: "One-Eyed Skill Gainer: target which of your opponent's Xyz Monsters?",
      *run(e, m, p, t) {
        tag(m).skillGained = 1;
        if (!t || !t.faceUp) return;
        copyFrom(e, m, t, p, {});
      },
    }),
  };

  // ===================== Orea, the Sylvan High Arbiter =====================
  const plant = (e: Engine, c: Card) => isMonster(e, c) && (('faceUp' in c && e.find(c.uid)?.loc.zone === 'mz' ? raceOf(e, c) : info(e, c).race) === 'Plant');
  const oreaCosts = (e: Engine, m: FieldCard, p: Pid) => [...e.player(p).hand.filter((c) => plant(e, c)), ...faceUpMonsters(e, p).filter((x) => plant(e, x))];
  E['Orea, the Sylvan High Arbiter'] = {
    // Send 1 Plant-Type monster from your hand or field to the GY; look at that many cards from the top of your Deck and rearrange them.
    ignition: {
      can: (e, m, p) => oreaCosts(e, m, p).length > 0 && e.player(p).deck.length > 0,
      *run(e, m, p) {
        const c = yield* pickOne(e, p, 'Orea: send which Plant-Type monster to the GY?', oreaCosts(e, m, p));
        if (!c) return;
        const lv = info(e, c).level ?? 0;
        yield* e.sendToGrave(c.uid, 'cost');
        e.log(p, `${e.player(p).name} sends ${c.name} to the GY`);
        const ps = e.player(p);
        const n = Math.min(lv, ps.deck.length);
        if (n <= 0) return;
        const top = ps.deck.slice(0, n);
        const order: Card[] = [];
        let rest = top.slice();
        while (rest.length > 1) {
          const next = yield* pickOne(e, p, `Orea: which card goes ${order.length ? 'next' : 'on top'}?`, rest);
          if (!next) break;
          order.push(next);
          rest = rest.filter((x) => x.uid !== next.uid);
        }
        order.push(...rest);
        ps.deck = [...order, ...ps.deck.filter((x) => !top.includes(x))];
        e.log(p, `${ps.name} looks at the top ${n} card${n > 1 ? 's' : ''} of the Deck and puts them back in any order`);
      },
    },
    quick: detachMain({
      label: 'excavate and return cards to the hand',
      can: (e, _m, p) => e.player(p).deck.length > 0,
      *run(e, m, p) {
        const ps = e.player(p);
        const max = Math.min(3, ps.deck.length);
        if (max <= 0) return;
        const k = yield* chooseOption(e, p, 'Orea: excavate how many cards?', ['1', '2', '3'].slice(0, max));
        const n = (k ?? 0) + 1;
        const dug = ps.deck.slice(0, n);
        e.log(p, `${ps.name} excavates ${dug.map((c) => c.name).join(', ')}`);
        let sent = 0;
        for (const c of dug.filter((x) => plant(e, x))) {
          yield* e.sendToGrave(c.uid, 'used');
          if (zoneOf(e, c.uid) !== 'deck') sent++;
        }
        // The other excavated cards go to the bottom of the Deck.
        const left = dug.filter((c) => zoneOf(e, c.uid) === 'deck');
        ps.deck = [...ps.deck.filter((x) => !left.includes(x)), ...left];
        if (!sent) return;
        const field = [...e.monsters(0), ...e.monsters(1), ...stOf(e, 0), ...stOf(e, 1)].filter((x) => x.uid !== m.uid);
        if (!field.length) return;
        const back = yield* pick(e, p, `Orea: return up to ${sent} card${sent > 1 ? 's' : ''} on the field to the hand`, field, 1, Math.min(sent, field.length));
        for (const c of back ?? []) {
          if (!e.fieldCard(c.uid)) continue;
          e.toHand(c.uid);
          e.log(p, `${c.faceUp ? c.name : 'A face-down card'} returns to the hand`);
        }
      },
    }),
  };

  // ===================== Outer Entity Nyarla =====================
  E['Outer Entity Nyarla'] = {
    *onSpecialSummon(e, m, p) {
      if (!m.tags?.xyzS || !e.player(p).hand.length) return;
      if (!(yield* e.yesno(p, 'Outer Entity Nyarla: discard cards to increase its Rank?'))) return;
      const cs = yield* pick(e, p, 'Discard which cards?', e.player(p).hand.slice(), 1, e.player(p).hand.length, true);
      if (!cs || !cs.length) return;
      for (const c of cs) yield* e.discard(p, c.uid);
      if (!e.fieldCard(m.uid)) return;
      tag(m).rankUp = (m.tags?.rankUp ?? 0) + cs.length;
      e.log(p, `Outer Entity Nyarla's Rank becomes ${rankOf(e, m)}`);
    },
    quick: {
      label: 'swap its materials for a monster in your GY',
      can(e, c, p, t) {
        const m = self(e, c);
        return t === 'main' && !!m && m.faceUp && mats(e, m).length > 0 && e.player(p).gy.some((x) => isMonster(e, x));
      },
      *cost(e, _c, p, link) {
        const t = yield* pickOne(e, p, 'Outer Entity Nyarla: target which monster in your GY?', e.player(p).gy.filter((x) => isMonster(e, x)), true);
        if (!t) return false;
        link.targetUid = t.uid;
      },
      *run(e, c, p, link) {
        const m = self(e, c);
        const uid = link.targetUid;
        if (!m || !m.faceUp || uid === undefined || zoneOf(e, uid) !== 'gy') return;
        const n = mats(e, m).length;
        if (!n || !(yield* e.detachMats(m, n))) return;
        const card = e.find(uid)?.card;
        if (!card || zoneOf(e, uid) !== 'gy' || !e.attachMat(m, uid)) return;
        const ci = info(e, card);
        fxMap<string>(e, 'declRace')[m.uid] = ci.race ?? '';
        fxMap<string>(e, 'declAttr')[m.uid] = ci.attribute ?? '';
        e.log(p, `${card.name} is attached to Outer Entity Nyarla; it becomes a ${ci.attribute} ${ci.race}`);
      },
    },
    *onLeaveField(e, fc) {
      if (e.state.fx.declRace) delete e.state.fx.declRace[fc.uid];
      if (e.state.fx.declAttr) delete e.state.fx.declAttr[fc.uid];
    },
  };

  // ===================== Princess Cologne =====================
  const another = (e: Engine, m: FieldCard) => e.monsters(ctrl(e, m)).some((x) => x.uid !== m.uid);
  const normal = (e: Engine, c: Card) => isMonster(e, c) && info(e, c).sub === 'Normal';
  E['Princess Cologne'] = {
    *onSpecialSummon(e, m, p) {
      if (!m.tags?.xyzS) return;
      const box = e.player(p).gy.filter((c) => e.isNamed(c, 'Box of Friends'));
      if (!box.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Princess Cologne: Special Summon "Box of Friends" from your GY?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which "Box of Friends"?', box);
    },
    cannotBeTargeted: (e, m, by) => by === other(ctrl(e, m)) && another(e, m),
    cannotBeAttacked: (e, m) => another(e, m),
    *onGraveEvents(e, m, p, events: GraveEvent[]) {
      const hit = events.some((v) => v.from === 'mz' && v.controller === p && v.faceUp && v.toGy && !v.token && v.reason === 'destroyed' && normal(e, v.card));
      if (!hit || !mats(e, m).length || !freeMZ(e, p)) return;
      const cands = () => [...e.player(p).deck, ...e.player(p).gy].filter((c) => normal(e, c));
      if (!cands().length || !(yield* e.yesno(p, 'Princess Cologne: detach 1 material to Special Summon a Normal Monster from your Deck or GY?'))) return;
      if (!(yield* e.detachMats(m, 1, p))) return;
      yield* summonOneOf(e, p, 'Special Summon which Normal Monster (Defense Position)?', cands(), 'def');
    },
  };
}
