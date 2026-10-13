// Speed Duel card scripts, batch 05 (Elemental HERO Darkbright ... Galaxy Tyranno).
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
  levelOf,
  named,
  negateLink,
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
  toDeck,
  tributeCost,
  attrOf,
} from './helpers';
import type { Card, Engine, FieldCard, Gen, Pid, Step } from './helpers';
import { extraMaterialSets } from './extra';

// ---------- local helpers ----------
const isFusion = (e: Engine, c: Card | string) => info(e, c).sub === 'Fusion';
const isMon = (e: Engine, c: Card) => isMonster(e, c);
const eHero = (c: Card | string) => named(c, 'Elemental HERO');
const turn = (e: Engine) => e.state.turn;

/** Destroy 1 chosen card from `list` (re-checked on the field). */
function* destroyPick(e: Engine, p: Pid, title: string, list: FieldCard[], cancel = false): Gen<boolean> {
  const t = yield* pickOne(e, p, title, list, cancel);
  if (!t || !e.fieldCard(t.uid)) return false;
  yield* e.destroy([t.uid]);
  return !e.fieldCard(t.uid);
}

/** Moves a card into its owner's Extra Deck (Fusion Monsters returning "to the Extra Deck"). */
function toExtra(e: Engine, uid: number) {
  const f = e.find(uid);
  if (!f) return;
  const owner = f.card.owner;
  e.toHandOf(uid, owner);
  const hand = e.player(owner).hand;
  const i = hand.findIndex((c) => c.uid === uid);
  if (i < 0) return;
  const [c] = hand.splice(i, 1);
  e.player(owner).fusion.push(c);
}
/** Shuffles a card back: Fusion Monsters to the Extra Deck, others into the Deck. */
function shuffleBack(e: Engine, uid: number) {
  const f = e.find(uid);
  if (!f) return;
  if (isFusion(e, f.card)) toExtra(e, uid);
  else toDeck(e, uid);
}

/** Puts a card from the GY / banishment face-up into a free Spell & Trap Zone. */
function placeST(e: Engine, uid: number, p: Pid): FieldCard | null {
  const f = e.find(uid);
  const z = freeST(e, p);
  if (!f || z < 0 || (f.loc.zone !== 'gy' && f.loc.zone !== 'removed')) return null;
  const ps = e.player(f.loc.player);
  const arr = f.loc.zone === 'gy' ? ps.gy : ps.removed;
  const [card] = arr.splice(f.loc.index, 1);
  const fc: FieldCard = { uid: card.uid, name: card.name, owner: card.owner, pos: 'atk', faceUp: true, placedTurn: turn(e), attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true };
  e.player(p).sz[z] = fc;
  e.event('activate', { uid, player: p });
  return fc;
}

/** Normal Summons a monster from the hand outside the engine's own Tribute rules (Necroshade). */
function* normalSummon(e: Engine, uid: number, p: Pid): Step {
  const ps = e.player(p);
  const i = ps.hand.findIndex((c) => c.uid === uid);
  const z = ps.mz.findIndex((x) => x === null);
  if (i < 0 || z < 0) return;
  const [card] = ps.hand.splice(i, 1);
  const fc: FieldCard = { uid: card.uid, name: card.name, owner: card.owner, pos: 'atk', faceUp: true, placedTurn: turn(e), attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
  ps.mz[z] = fc;
  ps.normalSummoned = true;
  yield* e.chainEnergy(p);
  e.event('summon', { uid, player: p });
  e.log(p, `${ps.name} Normal Summoned ${card.name}`);
  yield* e.responseWindow('summon', { uid, summonKind: 'normal' });
  const eff = e.effectOn(fc);
  if (eff?.onSummon && e.fieldCard(uid)) yield* e.as(p, eff.onSummon(e, fc, p, 'normal'));
  if (e.fieldCard(uid)) yield* e.anySummon(fc, p, 'normal');
}

/** "Banish it when it leaves the field": remembered by uid, applied when it reaches the GY. */
const markBanish = (e: Engine, uid: number) => ((e.state.fx.banishOnLeave ??= []) as number[]).push(uid);
function banishIfMarked(e: Engine, card: Card, from: string): boolean {
  const list = (e.state.fx.banishOnLeave ?? []) as number[];
  if (!list.includes(card.uid)) return false;
  e.state.fx.banishOnLeave = list.filter((u) => u !== card.uid);
  if (from !== 'mz' || e.find(card.uid)?.loc.zone !== 'gy') return false;
  e.banish(card.uid);
  return true;
}

/** "When this card destroys a monster by battle and sends it to the GY" (as attacker or as the attacked monster). */
function onKill(fn: (e: Engine, me: FieldCard, p: Pid, victim: FieldCard) => Step): Partial<EffectDef> {
  return {
    *afterBattle(e, a, t, p, destroyed) {
      if (destroyed && t && e.find(t.uid)?.loc.zone === 'gy' && e.fieldCard(a.uid)) yield* fn(e, a, p, t);
    },
    *onAttacked(e, me, attacker, p) {
      if (e.fieldCard(me.uid) && e.find(attacker.uid)?.loc.zone === 'gy' && attacker.owner !== p) yield* fn(e, me, p, attacker);
    },
  };
}
const origAtk = (e: Engine, c: Card) => Math.max(0, info(e, c).atk ?? 0);
const origDef = (e: Engine, c: Card) => Math.max(0, info(e, c).def ?? 0);

/** Draws 1 card and returns it (null if the draw failed). */
function drawOne(e: Engine, p: Pid): Card | null {
  const ps = e.player(p);
  const top = ps.deck[0];
  if (!top || !e.draw(p, 1)) return null;
  return ps.hand.find((c) => c.uid === top.uid) ?? null;
}
const isFC = (e: Engine, c: Card) => isMon(e, c) && named(c, 'Flower Cardian');

/** Runs a destruction outside a generator (a "destroy this instead" substitute asked from `shields`). */
function destroyNow(e: Engine, uid: number) {
  const g = e.sendToGrave(uid, 'destroyed');
  let r = g.next(undefined as never);
  for (let i = 0; !r.done && i < 20; i++) r = g.next(false);
}

/** Every face-up monster to Attack Position, locked for this turn (Final Attack Orders, Gaap). */
function allToAttack(e: Engine, faceDownToo = false) {
  for (const m of allMonsters(e)) {
    if (!m.faceUp && !faceDownToo) continue;
    if (!m.faceUp) {
      m.faceUp = true;
      e.log(null, `${m.name} is changed to face-up Attack Position`);
    }
    if (m.pos !== 'atk') {
      m.pos = 'atk';
      e.event('position', { uid: m.uid });
    }
    tag(m).lockPosTurn = turn(e);
  }
}

function moveEquip(e: Engine, eq: FieldCard, newHost: FieldCard) {
  const old = eq.equippedTo !== undefined ? e.fieldCard(eq.equippedTo) : null;
  if (old) {
    old.equips = old.equips.filter((u) => u !== eq.uid);
    if (eq.name === 'Flint' && !old.equips.some((u) => e.fieldCard(u)?.name === 'Flint')) old.cannotChangePos = false;
  }
  eq.equippedTo = newHost.uid;
  newHost.equips.push(eq.uid);
  if (eq.name === 'Flint' && newHost.name !== 'Flint Lock') newHost.cannotChangePos = true;
  e.log(null, `${eq.name} is equipped to ${newHost.name}`);
}

type FusionPlan = { fusion: Card; mats: Card[][] };

// ---------- Summoning conditions (audit-05) ----------
/** "Must be Fusion Summoned and cannot be Special Summoned by other ways" (approximated: only Special Summoned from the Extra Deck). */
const fusionOnly: EffectDef['summonRule'] = (_e, _c, _p, how, from) => how !== 'special' || from === 'fusion';
const resolvingIs = (e: Engine, ...names: string[]) => names.includes(e.resolvingCard()?.name ?? '');
/** "Must be Special Summoned with "Dark Fusion" and cannot be Special Summoned by other ways" (Dark Calling counts as "Dark Fusion"). */
const darkFusionOnly: EffectDef['summonRule'] = (e, _c, _p, how, from) => how !== 'special' || (from === 'fusion' && resolvingIs(e, 'Dark Fusion', 'Dark Calling'));
/** "Must first be Special Summoned with "Fossil Fusion"" (later revivals from the GY/banishment are allowed). */
const fossilFirst: EffectDef['summonRule'] = (e, _c, _p, how, from) => how !== 'special' || from !== 'fusion' || resolvingIs(e, 'Fossil Fusion');
/** "Must first be Special Summoned by its own effect/procedure": from the hand or Deck only by itself (fx.selfSS); later revivals are allowed. */
const selfFirst: EffectDef['summonRule'] = (e, c, _p, how, from) => how !== 'special' || (from !== 'hand' && from !== 'deck') || e.state.fx.selfSS === c.uid || e.state.fx.procSummon === c.uid;
function* selfSummon(e: Engine, uid: number, p: Pid, pos: 'atk' | 'def' = 'atk'): Step {
  e.state.fx.selfSS = uid;
  try {
    yield* e.specialSummon(uid, p, pos);
  } finally {
    e.state.fx.selfSS = undefined;
  }
}

/** "(Discard 1 card to) target 1 ...; destroy that target": the cost and the target when activated, the destruction as it resolves. */
function destroyIgnition(title: string, targets: (e: Engine, m: FieldCard, p: Pid) => FieldCard[], discard: boolean, repeat = false): NonNullable<EffectDef['ignition']> {
  return {
    repeat,
    can: (e, m, p) => (!discard || e.player(p).hand.length > 0) && targets(e, m, p).length > 0,
    *cost(e, m, p) {
      const t = yield* pickOne(e, p, title, targets(e, m, p), true);
      if (!t) return false;
      if (discard && !(yield* discardCost(e, p, 1))) return false;
      tag(m).ignTarget = t.uid;
    },
    *run(e, m, p) {
      const u = tag(m).ignTarget;
      delete tag(m).ignTarget;
      const t = u !== undefined ? e.fieldCard(u) : null;
      if (t && targets(e, m, p).some((x) => x.uid === t.uid)) yield* e.destroy([t.uid]);
    },
  };
}

export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  // ================= Elemental HEROes =================
  E['Elemental HERO Darkbright'] = {
    summonRule: fusionOnly,
    piercing: true,
    // A direct attack changes it to Defense Position when it inflicts the battle damage (no Damage Step hook for direct attacks).
    *afterBattle(e, a) {
      if (e.fieldCard(a.uid) && a.pos === 'atk') {
        a.pos = 'def';
        e.event('position', { uid: a.uid });
        e.log(null, `${a.name} changes to Defense Position`);
      }
    },
    *onBattleDamage(e, a) {
      if (e.state.battle?.target === null && e.fieldCard(a.uid) && a.pos === 'atk') {
        a.pos = 'def';
        e.event('position', { uid: a.uid });
        e.log(null, `${a.name} changes to Defense Position`);
      }
    },
    *onDestroyed(e, _c, p) {
      yield* destroyPick(e, p, 'Darkbright: destroy which monster?', targetable(e, e.monsters(other(p))));
    },
  };

  E['Elemental HERO Flame Wingman'] = {
    summonRule: fusionOnly,
    ...onKill(function* (e, me, p, v) {
      e.log(p, `${me.name} burns for ${origAtk(e, v)}`);
      e.damage(other(p), origAtk(e, v));
    }),
  };

  E['Elemental HERO Mariner'] = {
    summonRule: fusionOnly,
    directAttack: (e, _m, p) => e.spells(p).some((c) => !c.faceUp),
  };

  E['Elemental HERO Necroid Shaman'] = {
    summonRule: fusionOnly,
    *onSpecialSummon(e, _m, p) {
      const o = other(p);
      const ok = yield* destroyPick(e, p, 'Necroid Shaman: destroy which monster?', targetable(e, e.monsters(o)));
      if (!ok || !freeMZ(e, o)) return;
      const list = e.player(o).gy.filter((c) => isMon(e, c) && !isExtraOrRitual(e, c));
      const c = yield* pickOne(e, p, "Necroid Shaman: Special Summon which monster to your opponent's field?", list);
      if (c) yield* e.specialSummon(c.uid, o, 'atk');
    },
  };

  // Used from the GY as an action that Normal Summons the HERO without Tributes (the engine has no Tribute discount from the GY).
  E['Elemental HERO Necroshade'] = {
    *onSentToGrave(e, card) {
      if (e.state.fx.necroshade) delete (e.state.fx.necroshade as Record<number, number>)[card.uid];
    },
    graveIgnition: {
      can: (e, card, p) => !(e.state.fx.necroshade ?? {})[card.uid] && !e.player(p).normalSummoned && freeMZ(e, p) && e.player(p).hand.some((c) => isMon(e, c) && eHero(c) && levelOf(e, c) >= 5 && !isExtraOrRitual(e, c) && !e.effectOn(c)?.cannotNormalSummon && !e.summonBlocked(p, c, 'normal', 'hand')),
      *run(e, card, p) {
        const list = e.player(p).hand.filter((c) => isMon(e, c) && eHero(c) && levelOf(e, c) >= 5 && !isExtraOrRitual(e, c) && !e.effectOn(c)?.cannotNormalSummon && !e.summonBlocked(p, c, 'normal', 'hand'));
        const c = yield* pickOne(e, p, 'Necroshade: Normal Summon which HERO without Tributing?', list, true);
        if (!c) return;
        ((e.state.fx.necroshade ??= {}) as Record<number, number>)[card.uid] = 1;
        yield* normalSummon(e, c.uid, p);
      },
    },
  };

  E['Elemental HERO Nova Master'] = {
    summonRule: fusionOnly,
    *afterBattle(e, _a, t, p, destroyed) {
      if (destroyed && t && t.owner !== p) e.draw(p, 1);
    },
    *onAttacked(e, me, attacker, p) {
      if (e.fieldCard(me.uid) && e.find(attacker.uid)?.loc.zone === 'gy') e.draw(p, 1);
    },
  };

  E['Elemental HERO Plasma Vice'] = {
    summonRule: fusionOnly,
    piercing: true,
    ignition: destroyIgnition('Plasma Vice: destroy which Attack Position monster?', (e, _m, p) => targetable(e, e.monsters(other(p))).filter((x) => x.faceUp && x.pos === 'atk'), true, true),
  };

  // The name change lasts until the end of the turn and counts where names are read through fieldName (Fusion Materials).
  const prismaPlans = (e: Engine, p: Pid) =>
    e.player(p).fusion.filter((f) => (e.fusionMaterials(f.name) ?? []).some((id) => e.player(p).deck.some((c) => info(e, c).id === id)));
  E['Elemental HERO Prisma'] = {
    fieldName: (e, m) => {
      const x = (e.state.fx.prismaName as Record<number, { name: string; turn: number }> | undefined)?.[m.uid];
      return x && x.turn === turn(e) ? x.name : undefined;
    },
    ignition: {
      can: (e, _m, p) => prismaPlans(e, p).length > 0,
      *run(e, m, p) {
        const f = yield* pickOne(e, p, 'Prisma: reveal which Fusion Monster?', prismaPlans(e, p));
        if (!f) return;
        e.log(p, `${e.player(p).name} reveals ${f.name}`);
        const ids = e.fusionMaterials(f.name) ?? [];
        const c = yield* pickOne(e, p, 'Prisma: send which material to the GY?', e.player(p).deck.filter((c) => ids.includes(info(e, c).id)));
        if (!c) return;
        yield* e.sendToGrave(c.uid, 'mill');
        e.player(p).deck = e.shuffle(e.player(p).deck);
        e.log(p, `${c.name} is sent from the Deck to the GY`);
        if (e.fieldCard(m.uid) && e.find(c.uid)?.loc.zone === 'gy') {
          ((e.state.fx.prismaName ??= {}) as Record<number, { name: string; turn: number }>)[m.uid] = { name: c.name, turn: turn(e) };
          e.log(p, `${m.name}'s name becomes ${c.name} until the End Phase`);
        }
      },
    },
  };

  E['Elemental HERO Rampart Blaster'] = {
    summonRule: fusionOnly,
    attackInDefense: true,
    cannotAttack: (e, m, p) => m.pos === 'def' && e.monsters(other(p)).length > 0,
    attackBonus: (e, m) => (m.pos === 'def' ? -Math.floor(e.atkOf(m) / 2) : 0),
  };

  E['Elemental HERO Shining Flare Wingman'] = {
    summonRule: fusionOnly,
    selfBonus: (e, m) => ({ atk: 300 * e.player(ctrl(e, m)).gy.filter((c) => eHero(c)).length, def: 0 }),
    ...onKill(function* (e, me, p, v) {
      e.log(p, `${me.name} burns for ${origAtk(e, v)}`);
      e.damage(other(p), origAtk(e, v));
    }),
  };

  E['Elemental HERO Steam Healer'] = {
    summonRule: fusionOnly,
    ...onKill(function* (e, _me, p, v) {
      e.gainLp(p, origAtk(e, v));
    }),
  };

  E['Elemental HERO Tempest'] = {
    summonRule: fusionOnly,
    ignition: {
      repeat: true,
      can: (e, m, p) => [...e.monsters(p), ...stOf(e, p)].some((c) => c.uid !== m.uid) && targetable(e, e.monsters(p)).length > 0,
      *cost(e, m, p) {
        const fodder = [...e.monsters(p), ...stOf(e, p)].filter((c) => c.uid !== m.uid);
        const cost = yield* pickOne(e, p, 'Tempest: send which card you control to the GY?', fodder, true);
        if (!cost) return false;
        yield* e.sendToGrave(cost.uid, 'cost');
        const t = yield* pickOne(e, p, 'Tempest: which monster cannot be destroyed by battle?', targetable(e, e.monsters(p)));
        if (!t) return false;
        tag(m).ignTarget = t.uid;
      },
      *run(e, m) {
        const u = tag(m).ignTarget;
        delete tag(m).ignTarget;
        if (u !== undefined && e.fieldCard(u) && e.fieldCard(m.uid)) tag(m)[`guard${u}`] = 1;
      },
    },
    shields: (_e, src, target, how) => how === 'battle' && src.name === 'Elemental HERO Tempest' && tag(src)[`guard${target.uid}`] === 1,
  };

  E['Elemental HERO Thunder Giant'] = {
    summonRule: fusionOnly,
    ignition: destroyIgnition('Thunder Giant: destroy which monster?', (e, m) => targetable(e, faceUpMonsters(e)).filter((x) => origAtk(e, x) < e.atkOf(m)), true),
  };

  const volticSummon = function* (e: Engine, p: Pid): Step {
    const list = e.player(p).removed.filter((c) => isMon(e, c) && eHero(c) && !isExtraOrRitual(e, c) && !e.summonBlocked(p, c, 'special', 'removed'));
    if (!list.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Voltic: Special Summon a banished Elemental HERO?'))) return;
    yield* summonOneOf(e, p, 'Voltic: Special Summon which monster?', list, 'atk');
  };
  E['Elemental HERO Voltic'] = {
    *onBattleDamage(e, _a, p) {
      yield* volticSummon(e, p);
    },
    // When it is attacked: the opponent's LP before and after the battle tell whether it inflicted battle damage.
    *onBeingAttacked(e, me, _a, p) {
      tag(me).lpWas = e.player(other(p)).lp;
    },
    *onAttacked(e, me, _a, p) {
      const was = tag(me).lpWas;
      delete tag(me).lpWas;
      if (was !== undefined && e.fieldCard(me.uid) && e.player(other(p)).lp < was) yield* volticSummon(e, p);
    },
  };

  E['Elemental HERO Wild Wingman'] = {
    summonRule: fusionOnly,
    ignition: destroyIgnition('Wild Wingman: destroy which Spell/Trap?', (e) => allST(e), true, true),
  };

  E['Elemental HERO Wildedge'] = {
    summonRule: fusionOnly,
    attacks(e, m) {
      const t = tag(m);
      const hits = t.hitTurn === turn(e) ? t.hits ?? 0 : 0;
      const left = e.monsters(other(ctrl(e, m))).filter((x) => t[`hit${x.uid}`] !== turn(e)).length;
      return Math.max(1, hits + left);
    },
    targetFilter: (e, m, target) => tag(m)[`hit${target.uid}`] !== turn(e),
    *afterBattle(e, a, t) {
      if (!t) return;
      const g = tag(a);
      if (g.hitTurn !== turn(e)) (g.hitTurn = turn(e)), (g.hits = 0);
      g.hits = (g.hits ?? 0) + 1;
      g[`hit${t.uid}`] = turn(e);
    },
  };

  // ================= Evil HEROes =================
  E['Evil HERO Infernal Prodigy'] = {
    summonProc: {
      can: (e, _c, p) => e.monsters(p).length === 0 && freeMZ(e, p),
      *run(e, c, p) {
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
    // fx.tributingFor: the monster the engine's Tribute Summon is Tributing for.
    *onSentToGrave(e, card, _o, from, reason) {
      const f = e.state.fx.tributingFor;
      if (from === 'mz' && reason === 'tribute' && typeof f === 'string' && named(f, 'HERO') && info(e, f).kind === 'monster') ((e.state.fx.prodigy ??= {}) as Record<number, number>)[card.uid] = turn(e);
    },
    *onEndPhaseInGrave(e, card, owner) {
      if ((e.state.fx.prodigy as Record<number, number> | undefined)?.[card.uid] !== turn(e) || !e.oncePerTurn(card.name, owner)) return;
      e.useOnce(card.name, owner);
      e.log(owner, 'Evil HERO Infernal Prodigy: draw 1 card');
      e.draw(owner, 1);
    },
  };

  E['Evil HERO Inferno Wing'] = {
    summonRule: darkFusionOnly,
    piercing: true,
    ...onKill(function* (e, me, p, v) {
      const n = Math.max(origAtk(e, v), origDef(e, v));
      e.log(p, `${me.name} burns for ${n}`);
      e.damage(other(p), n);
    }),
  };

  E['Evil HERO Lightning Golem'] = {
    summonRule: darkFusionOnly,
    ignition: destroyIgnition('Lightning Golem: destroy which monster?', (e) => targetable(e, allMonsters(e)), false),
  };

  E['Evil HERO Malicious Edge'] = {
    piercing: true,
    // A face-up Tribute Summon with 1 Tribute while the opponent controls a monster.
    tributeOffer: (e, src, p, _c, need) => (src === null && need > 1 && e.monsters(other(p)).length > 0 ? { need: 1 } : undefined),
  };

  E['Evil Mind'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p) && faceUpMonsters(e, p).some((m) => raceOf(e, m) === 'Fiend') && e.player(other(p)).gy.some((x) => isMon(e, x)),
    *activate(e, link, p) {
      const n = e.player(other(p)).gy.filter((x) => isMon(e, x)).length;
      const labels = ['Draw 1 card'];
      if (n >= 4) labels.push('Add 1 "HERO" monster or "Dark Fusion"');
      if (n >= 10) labels.push('Add 1 "Polymerization" or "Fusion" Spell');
      const i = yield* chooseOption(e, p, `Evil Mind (${n} monsters in the opponent's GY): which effect?`, labels, true);
      if (i === null) return false;
      e.useOnce(link.card.name, p);
      link.payload = i;
    },
    *resolve(e, link, p) {
      const i = link.payload as number;
      if (i === 0) e.draw(p, 1);
      else if (i === 1) yield* searchDeck(e, p, 'Evil Mind: add which card?', (c) => (isMon(e, c) && named(c, 'HERO')) || c.name === 'Dark Fusion');
      else yield* searchDeck(e, p, 'Evil Mind: add which Spell?', (c) => isSpell(e, c) && (named(c, 'Polymerization') || named(c, 'Fusion')));
    },
  };

  // ================= E... =================
  E['Eliminating the League'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.player(p).hand.some((c) => isSpell(e, c)) && targetable(e, faceUpMonsters(e, other(p))).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Eliminating the League: destroy which monster?', targetable(e, faceUpMonsters(e, other(p))), true);
      if (!m || !(yield* discardCost(e, p, 1, (c) => isSpell(e, c)))) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || !m.faceUp) return;
      const name = m.name;
      yield* e.destroy([m.uid]);
      if (e.fieldCard(m.uid)) return;
      const hand = e.player(other(p)).hand;
      e.log(p, `${e.player(p).name} looks at the opponent's hand: ${hand.map((c) => c.name).join(', ') || 'empty'}`);
      for (const c of hand.filter((x) => x.name === name)) yield* e.sendToGrave(c.uid, 'cost');
    },
  };

  E['Emblem of Dragon Destroyer'] = {
    canActivate: (e, _c, p, t) => isMain(t) && [...e.player(p).deck, ...e.player(p).gy].some((c) => c.name === 'Buster Blader'),
    *resolve(e, _l, p) {
      const ps = e.player(p);
      const c = yield* pickOne(e, p, 'Add which Buster Blader?', [...ps.deck, ...ps.gy].filter((x) => x.name === 'Buster Blader'));
      if (!c) return;
      const fromDeck = e.find(c.uid)?.loc.zone === 'deck';
      e.toHandOf(c.uid, p);
      if (fromDeck) ps.deck = e.shuffle(ps.deck);
    },
  };

  // A Trap Monster: it moves to the Monster Zone and keeps its stats through baseStats.
  E['Embodiment of Apophis'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.inMainPhase() && freeMZ(e, p),
    *resolve(e, link, p) {
      if (!e.fieldCard(link.card.uid) || !freeMZ(e, p)) return;
      const u = link.card.uid;
      (e.state.fx.declLevel ??= {})[u] = 4;
      (e.state.fx.declRace ??= {})[u] = 'Reptile';
      (e.state.fx.declAttr ??= {})[u] = 'EARTH';
      const def = yield* e.yesno(p, 'Special Summon Embodiment of Apophis in Defense Position? (No = Attack)');
      yield* e.specialSummon(u, p, def ? 'def' : 'atk');
    },
    baseStats: () => ({ atk: 1600, def: 1800 }),
  };

  E['Emergency Provisions'] = {
    canActivate: (e, c, p, t) => anyTime(t) && stOf(e, p).some((x) => x.uid !== c.uid),
    *activate(e, link, p) {
      const list = stOf(e, p).filter((x) => x.uid !== link.card.uid);
      const chosen = yield* pick(e, p, 'Emergency Provisions: send which cards to the GY?', list, 1, list.length, true, false);
      if (!chosen || !chosen.length) return false;
      for (const c of chosen) if (e.fieldCard(c.uid)) yield* e.sendToGrave(c.uid, 'cost');
      link.payload = chosen.length;
    },
    *resolve(e, link, p) {
      e.gainLp(p, 1000 * (link.payload as number));
    },
  };

  const roidFusion = (e: Engine, p: Pid) => faceUpMonsters(e, p).some((m) => named(m, 'roid') && isFusion(e, m));
  E['Emergeroid Call'] = {
    canActivate: (e, _c, p, t, ctx) => (t === 'spell' || t === 'trap' || t === 'effect') && !!ctx.link && !ctx.link.negated && roidFusion(e, p),
    *activate(_e, link, _p, ctx) {
      link.payload = ctx.link;
    },
    *resolve(e, link, p) {
      const target = link.payload as typeof link | undefined;
      if (!target) return;
      negateLink(e, target, p);
      const ps = e.player(target.player);
      for (const c of [...ps.deck, ...ps.fusion].filter((x) => x.name === target.card.name)) yield* e.sendToGrave(c.uid, 'mill');
    },
    graveIgnition: {
      can: (e, c, p) => e.oncePerTurn(c.name, p) && e.player(p).gy.some((x) => isMon(e, x) && named(x, 'roid')),
      *run(e, card, p) {
        const c = yield* pickOne(e, p, 'Emergeroid Call: add which "roid" monster?', e.player(p).gy.filter((x) => isMon(e, x) && named(x, 'roid')), true);
        if (!c) return;
        e.useOnce(card.name, p);
        e.banish(card.uid);
        if (isFusion(e, c)) toExtra(e, c.uid);
        else e.toHandOf(c.uid, p);
      },
    },
  };

  E['Enchanting Fitting Room'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).lp > 800 && e.player(p).deck.length >= 4,
    *activate(e, _l, p) {
      if (!payLp(e, p, 800)) return false;
    },
    *resolve(e, _l, p) {
      const ps = e.player(p);
      const top = ps.deck.slice(0, 4);
      e.log(p, `Excavated: ${top.map((c) => c.name).join(', ')}`);
      for (const c of top) {
        if (!freeMZ(e, p)) break;
        if (isNormalMonster(e, c) && levelOf(e, c) <= 3 && e.find(c.uid)?.loc.zone === 'deck') yield* e.specialSummon(c.uid, p, 'atk');
      }
      ps.deck = e.shuffle(ps.deck);
    },
  };

  E['Enemy Controller'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && targetable(e, faceUpMonsters(e, other(p))).length > 0,
    *activate(e, link, p) {
      const labels = ['Change its battle position'];
      if (e.monsters(p).length > 0) labels.push('Tribute 1 monster: take control of it');
      const mode = yield* chooseOption(e, p, 'Enemy Controller: which effect?', labels, true);
      if (mode === null) return false;
      if (mode === 1 && !(yield* tributeCost(e, p, 1))) return false;
      const m = yield* pickOne(e, p, 'Enemy Controller: target which monster?', targetable(e, faceUpMonsters(e, other(p))), mode === 0);
      if (!m) return false;
      link.targetUid = m.uid;
      link.payload = mode;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || !m.faceUp || ctrl(e, m) !== other(p)) return;
      if (link.payload === 0) {
        m.pos = m.pos === 'atk' ? 'def' : 'atk';
        e.event('position', { uid: m.uid });
        e.log(p, `${m.name} changes to ${m.pos === 'atk' ? 'Attack' : 'Defense'} Position`);
      } else if (e.takeControl(m.uid, p)) {
        m.returnAtEnd = other(p);
        e.log(p, `${e.player(p).name} takes control of ${m.name} until the End Phase`);
      }
    },
  };

  E['Energy Drain'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && targetable(e, faceUpMonsters(e, p)).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Energy Drain: which monster?', targetable(e, faceUpMonsters(e, p)), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || !m.faceUp || ctrl(e, m) !== p) return;
      const n = 200 * e.player(other(p)).hand.length;
      boostTurn(m, n, n);
      e.log(p, `${m.name} gains ${n} ATK/DEF`);
    },
  };

  E['Enraged Muka Muka'] = {
    selfBonus: (e, m) => {
      const n = 400 * e.player(ctrl(e, m)).hand.length;
      return { atk: n, def: n };
    },
  };

  E['Etoile Cyber'] = {
    attackBonus: (_e, _a, t) => (t === null ? 500 : 0),
  };

  const lightFairy = (e: Engine, c: Card) => isMon(e, c) && attrOf(e, c) === 'LIGHT' && raceOf(e, c) === 'Fairy';
  E['Eva'] = {
    *onSentToGrave(e, card, p) {
      if (!e.oncePerTurn(card.name, p)) return;
      const ps = e.player(p);
      const fodder = [...faceUpMonsters(e, p), ...ps.gy].filter((c) => c.uid !== card.uid && lightFairy(e, c));
      const adds = ps.deck.filter((c) => lightFairy(e, c) && levelOf(e, c) <= 2 && c.name !== 'Eva');
      const names = new Set(adds.map((c) => c.name)).size;
      const max = Math.min(2, fodder.length, names);
      if (max < 1 || !(yield* e.yesno(p, 'Eva: banish LIGHT Fairy monsters to add others from the Deck?'))) return;
      const chosen = yield* pick(e, p, `Eva: banish up to ${max} LIGHT Fairy monsters`, fodder, 1, max, true);
      if (!chosen || !chosen.length) return;
      e.useOnce(card.name, p);
      for (const c of chosen) e.banish(c.uid);
      const taken: string[] = [];
      for (let i = 0; i < chosen.length; i++) {
        const c = yield* searchDeck(e, p, 'Eva: add which LIGHT Fairy?', (x) => lightFairy(e, x) && levelOf(e, x) <= 2 && x.name !== 'Eva' && !taken.includes(x.name));
        if (!c) break;
        taken.push(c.name);
      }
    },
  };

  E['Evo-Instant'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.monsters(p).some((m) => raceOf(e, m) === 'Reptile') && e.player(p).deck.some((c) => isMon(e, c) && named(c, 'Evolsaur')),
    *activate(e, _l, p) {
      if (!(yield* tributeCost(e, p, 1, (m) => raceOf(e, m) === 'Reptile'))) return false;
    },
    *resolve(e, _l, p) {
      yield* summonOneOf(e, p, 'Evo-Instant: Special Summon which Evolsaur?', e.player(p).deck.filter((c) => isMon(e, c) && named(c, 'Evolsaur')), 'atk');
    },
  };

  // Evoltile effects mark the monster they Special Summon in fx.evoltileSS.
  E['Evo-Price'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    *onAnySummon(e, w, wp, m, _c, kind) {
      if (kind !== 'special' || e.state.fx.evoltileSS !== m.uid || e.state.battle || !e.oncePerTurn(`Evo-Price:${w.uid}`, wp)) return;
      const list = [...targetable(e, allMonsters(e)), ...allST(e)];
      if (!list.length || !(yield* e.yesno(wp, 'Evo-Price: destroy 1 card on the field?'))) return;
      e.useOnce(`Evo-Price:${w.uid}`, wp);
      yield* destroyPick(e, wp, 'Evo-Price: destroy which card?', list);
    },
  };

  E['Evoltile Lagosucho'] = {
    *onSummon(e, _m, p, kind) {
      if (kind !== 'normal') return;
      const ok = (c: Card) => isMon(e, c) && named(c, 'Evolsaur');
      if (!e.player(p).deck.some(ok) || !(yield* e.yesno(p, 'Lagosucho: send an Evolsaur from the Deck to the GY?'))) return;
      const c = yield* pickOne(e, p, 'Send which Evolsaur?', e.player(p).deck.filter(ok));
      if (!c) return;
      yield* e.sendToGrave(c.uid, 'mill');
      e.player(p).deck = e.shuffle(e.player(p).deck);
    },
    *flip(e, _m, p) {
      const ok = (c: Card) => isMon(e, c) && named(c, 'Evoltile');
      if (!freeMZ(e, p) || !e.player(p).deck.some(ok) || !(yield* e.yesno(p, 'Lagosucho: Special Summon an Evoltile from the Deck?'))) return;
      const c = yield* pickOne(e, p, 'Special Summon which Evoltile?', e.player(p).deck.filter(ok));
      if (!c) return;
      e.state.fx.evoltileSS = c.uid;
      yield* e.specialSummon(c.uid, p, 'atk');
      e.player(p).deck = e.shuffle(e.player(p).deck);
    },
  };

  E['Exchange of the Spirit'] = {
    canActivate: (e, c, p, t) => anyTime(t) && e.oncePerDuel(c.name, p) && e.player(0).gy.length >= 15 && e.player(1).gy.length >= 15 && e.player(p).lp > 1000,
    *activate(e, link, p) {
      if (!payLp(e, p, 1000)) return false;
      e.useOncePerDuel(link.card.name, p);
    },
    *resolve(e) {
      for (const q of [0, 1] as Pid[]) {
        const ps = e.player(q);
        const gy = ps.gy;
        ps.gy = ps.deck;
        ps.deck = e.shuffle(gy.filter((c) => !isFusion(e, c)));
        ps.fusion.push(...gy.filter((c) => isFusion(e, c)));
        e.log(q, `${ps.name}'s Graveyard and Deck are swapped`);
      }
    },
  };

  // Counters are one number per card here, so every kind of counter on the field is removed (Fog Counters too).
  const countered = (e: Engine) => [...allMonsters(e), ...allST(e)].filter((c) => c.counters > 0);
  E['Exhausting Spell'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && countered(e).length > 0,
    *resolve(e, link) {
      for (const c of countered(e)) c.counters = 0;
      e.log(link.player, 'All Spell Counters are removed');
    },
  };

  // The Tribute (a cost) is paid as the effect resolves, since the engine resolves a monster's effect only while it is on the field.
  E['Exiled Force'] = {
    ignition: {
      can: (e, m) => targetable(e, allMonsters(e)).some((x) => x.uid !== m.uid),
      *run(e, m, p) {
        if (!e.fieldCard(m.uid)) return;
        const t = yield* pickOne(e, p, 'Exiled Force: destroy which monster?', targetable(e, allMonsters(e)).filter((x) => x.uid !== m.uid), true);
        if (!t) return;
        yield* e.sendToGrave(m.uid, 'tribute');
        if (e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
      },
    },
  };

  E['Exploder Dragon'] = {
    // Neither player takes battle damage from its attacks (set as its damage calculation starts).
    attackBonus(e) {
      noBattleDamage(e, 0);
      noBattleDamage(e, 1);
      return 0;
    },
    *onDestroyedByBattle(e, m) {
      const b = e.state.battle;
      if (!b || e.find(m.uid)?.loc.zone !== 'gy') return;
      const foe = b.attacker === m.uid ? b.target : b.attacker;
      if (foe !== null && e.fieldCard(foe)) {
        e.log(null, `Exploder Dragon takes ${e.fieldCard(foe)!.name} with it`);
        yield* e.destroy([foe]);
      }
    },
  };

  const expressroid = function* (e: Engine, _m: FieldCard, p: Pid): Step {
    const list = e.player(p).gy.filter((c) => isMon(e, c) && named(c, 'roid') && c.name !== 'Expressroid');
    if (list.length < 2 || !(yield* e.yesno(p, 'Expressroid: add 2 "roid" monsters from your GY to your hand?'))) return;
    const chosen = yield* pick(e, p, 'Expressroid: add which 2 monsters?', list, 2, 2);
    for (const c of chosen ?? []) if (e.find(c.uid)?.loc.zone === 'gy') (isFusion(e, c) ? toExtra(e, c.uid) : e.toHandOf(c.uid, p));
  };
  E['Expressroid'] = { onSummon: expressroid, onSpecialSummon: expressroid };

  // ================= F... =================
  E['Fairy Box'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    quick: {
      repeat: true,
      label: 'toss a coin against the attacker',
      can: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null,
      *run(e, card, p, link) {
        const ctx = (link.payload as { ctx?: { uid?: number } }).ctx;
        const a = ctx?.uid !== undefined ? e.fieldCard(ctx.uid) : null;
        if (!a || !e.fieldCard(card.uid)) return;
        const call = yield* chooseOption(e, p, 'Fairy Box: call the coin toss', ['Heads', 'Tails']);
        const heads = e.roll(2) === 1;
        e.log(p, `Fairy Box: the coin shows ${heads ? 'Heads' : 'Tails'}`);
        // "ATK becomes 0 until the end of the Battle Phase" (Speed Duel has no Main Phase 2, so until the end of the turn).
        if ((call === 0) === heads && e.fieldCard(a.uid)) {
          boostTurn(a, -e.atkOf(a));
          e.log(p, `${a.name}'s ATK becomes 0 until the end of the Battle Phase`);
        }
      },
    },
    *onStandby(e, fc, p) {
      if (e.state.turnPlayer !== p) return;
      if (e.player(p).lp > 500 && (yield* e.yesno(p, 'Fairy Box: pay 500 LP to keep it?'))) e.payLp(p, 500);
      else yield* e.destroy([fc.uid]);
    },
  };

  E['Fairy Meteor Crush'] = h.equip(undefined, {
    grantsPiercing: (_e, eq, _p, attacker) => eq.equippedTo === attacker.uid,
  });

  E['Fairy Tail - Sleeper'] = {
    *flip(e, _m, p) {
      const list = e.player(p).hand.filter((c) => isMon(e, c) && !isExtraOrRitual(e, c));
      if (!freeMZ(e, p) || !list.length || !(yield* e.yesno(p, 'Sleeper: Special Summon a monster from your hand?'))) return;
      yield* summonOneOf(e, p, 'Sleeper: Special Summon which monster?', list, 'atk');
    },
    // The replacement effect is applied when Sleeper's effect resolves (the original activation is negated).
    quick: {
      label: 'rewrite the activated card',
      can: (e, c, p, t, ctx) =>
        (t === 'spell' || t === 'trap') && !!ctx.link && ctx.link.player !== p && info(e, ctx.link.card).sub === 'Normal' && e.oncePerTurn(c.name, p) && e.monsters(p).some((m) => m.uid !== c.uid),
      *cost(e, card, p, link, ctx) {
        if (!(yield* tributeCost(e, p, 1, () => true, card.uid))) return false;
        e.useOnce(card.name, p);
        link.payload = { ...(link.payload as object), target: ctx.link };
      },
      *run(e, _card, p, link) {
        const target = (link.payload as { target?: typeof link }).target;
        if (!target) return;
        target.negated = true;
        e.log(p, `${target.card.name}'s effect becomes "Change 1 face-up monster your opponent controls to face-down Defense Position"`);
        const m = yield* pickOne(e, target.player, 'Change which monster to face-down Defense Position?', faceUpMonsters(e, p));
        if (m && e.fieldCard(m.uid)) {
          m.faceUp = false;
          m.pos = 'def';
          e.event('position', { uid: m.uid });
        }
      },
    },
  };

  E['Fairy Wind'] = {
    canActivate: (e, c, _p, t) => anyTime(t) && allST(e).some((x) => x.faceUp && x.uid !== c.uid),
    *resolve(e, link) {
      const list = allST(e).filter((x) => x.faceUp && x.uid !== link.card.uid);
      yield* e.destroy(list.map((x) => x.uid));
      const n = list.filter((x) => !e.fieldCard(x.uid)).length;
      if (!n) return;
      e.damage(link.player, 300 * n);
      e.damage(other(link.player), 300 * n);
    },
  };

  const lords = ['Uria, Lord of Searing Flames', 'Hamon, Lord of Striking Thunder', 'Raviel, Lord of Phantasms', 'Armityle the Chaos Phantom'];
  E['Fallen Paradise'] = {
    ...h.fieldSpell(() => undefined),
    shields: (e, src, target, how, sc) => how !== 'battle' && src.active === true && lords.includes(target.name) && ctrl(e, target) === sc && e.actor === other(sc),
    ignition: {
      repeat: true,
      can: (e, c, p) => e.oncePerTurn(c.name, p) && e.player(p).deck.length >= 2 && faceUpMonsters(e, p).some((m) => lords.includes(m.name)),
      *run(e, c, p) {
        e.useOnce(c.name, p);
        e.draw(p, 2);
      },
    },
  };

  E["Fiend's Sanctuary"] = {
    canActivate: (e, _c, p, t) => isMain(t) && freeMZ(e, p),
    *resolve(e, _l, p) {
      e.createToken('Metal Fiend Token', p, 'atk', true, { atk: 0, def: 0, level: 1, attribute: 'DARK', race: 'Fiend' });
    },
  };
  E['Metal Fiend Token'] = {
    cannotAttack: () => true,
    reflectBattleDamage: () => true,
    *onStandby(e, m, p) {
      if (e.state.turnPlayer !== p) return;
      if (e.player(p).lp > 1000 && (yield* e.yesno(p, 'Metal Fiend Token: pay 1000 LP to keep it?'))) e.payLp(p, 1000);
      else yield* e.destroy([m.uid]);
    },
  };

  E['Fiendish Rhino Warrior'] = {
    shields: (e, src, target, how, sc) => how !== 'target' && target.uid !== src.uid && target.name !== src.name && ctrl(e, target) === sc && raceOf(e, target) === 'Fiend',
    *onSentToGrave(e, card, p) {
      const ok = (c: Card) => isMon(e, c) && raceOf(e, c) === 'Fiend' && c.name !== card.name;
      if (!e.oncePerTurn(card.name, p) || !e.player(p).deck.some(ok) || !(yield* e.yesno(p, 'Fiendish Rhino Warrior: send a Fiend from the Deck to the GY?'))) return;
      e.useOnce(card.name, p);
      const c = yield* pickOne(e, p, 'Send which Fiend?', e.player(p).deck.filter(ok));
      if (!c) return;
      yield* e.sendToGrave(c.uid, 'mill');
      e.player(p).deck = e.shuffle(e.player(p).deck);
    },
  };

  E['Fifth Hope'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).gy.filter((c) => eHero(c)).length >= 5,
    *activate(e, link, p) {
      const chosen = yield* pick(e, p, 'Fifth Hope: shuffle which 5 "Elemental HERO" cards?', e.player(p).gy.filter((c) => eHero(c)), 5, 5, true);
      if (!chosen) return false;
      const alone = e.player(p).hand.length === 0 && [...e.monsters(p), ...stOf(e, p)].every((c) => c.uid === link.card.uid);
      link.payload = { uids: chosen.map((c) => c.uid), n: alone ? 3 : 2 };
    },
    *resolve(e, link, p) {
      const { uids, n } = link.payload as { uids: number[]; n: number };
      const here = uids.filter((u) => e.find(u)?.loc.zone === 'gy');
      for (const u of here) shuffleBack(e, u);
      if (here.length === uids.length) e.draw(p, n);
    },
  };

  // "If it would be destroyed by battle, you can destroy this card instead" (always used).
  E['Fighting Spirit'] = h.equip((e, _eq, host) => ({ atk: 300 * e.monsters(other(ctrl(e, host))).length, def: 0 }), {
    shields(e, src, target, how) {
      if (how !== 'battle' || src.equippedTo !== target.uid || !e.fieldCard(src.uid)) return false;
      e.log(null, `${src.name} is destroyed instead`);
      destroyNow(e, src.uid);
      return true;
    },
  });

  E['Final Attack Orders'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve(e) {
      allToAttack(e);
    },
    *onStandby(e) {
      allToAttack(e);
    },
    *onAnySummon(e) {
      allToAttack(e);
    },
    *stateCheck(e) {
      allToAttack(e);
    },
    // The position lock ends with the card (unless Gaap or another copy still holds it).
    *onLeaveField(e, fc) {
      const still = faceUpMonsters(e).some((m) => m.name === 'Gaap the Divine Soldier' && !e.isNegated(m)) || [0, 1].some((q) => e.activeSpells(q as Pid).some((c) => c.uid !== fc.uid && c.name === 'Final Attack Orders'));
      if (!still) for (const m of allMonsters(e)) if (m.tags?.lockPosTurn !== undefined) delete m.tags.lockPosTurn;
    },
  };

  E['Fire Formation - Tenki'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p),
    *activate(e, link, p) {
      e.useOnce(link.card.name, p);
    },
    *resolve(e, _l, p) {
      const ok = (c: Card) => isMon(e, c) && raceOf(e, c) === 'Beast-Warrior' && levelOf(e, c) <= 4;
      if (e.player(p).deck.some(ok) && (yield* e.yesno(p, 'Fire Formation - Tenki: add a Level 4 or lower Beast-Warrior?'))) yield* searchDeck(e, p, 'Add which Beast-Warrior?', ok);
    },
    aura: (e, src, target, sc) => (src.active && target.faceUp && ctrl(e, target) === sc && raceOf(e, target) === 'Beast-Warrior' ? { atk: 100, def: 0 } : undefined),
  };

  E['Fire Sorcerer'] = {
    *flip(e, _m, p) {
      const hand = e.player(p).hand;
      if (hand.length < 2) return;
      const picks = e.shuffle(hand.slice()).slice(0, 2);
      for (const c of picks) e.banish(c.uid);
      e.log(p, `Fire Sorcerer banishes ${picks.map((c) => c.name).join(' and ')}`);
      e.damage(other(p), 800);
    },
  };

  const pyroInGy = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isMon(e, c) && raceOf(e, c) === 'Pyro');
  E['Firewall'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    quick: {
      repeat: true,
      label: 'banish a Pyro to negate the direct attack',
      can: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null && e.state.battle?.target === null && pyroInGy(e, p).length > 0,
      *cost(e, _card, p) {
        const c = yield* pickOne(e, p, 'Firewall: banish which Pyro monster?', pyroInGy(e, p), true);
        if (!c) return false;
        e.banish(c.uid);
      },
      *run(e, _card, p) {
        if (!e.state.battle) return;
        e.log(p, 'Firewall negates the attack');
        e.endBattle();
      },
    },
    *onStandby(e, fc, p) {
      if (e.state.turnPlayer !== p) return;
      if (e.player(p).lp > 500 && (yield* e.yesno(p, 'Firewall: pay 500 LP to keep it?'))) e.payLp(p, 500);
      else yield* e.destroy([fc.uid]);
    },
  };

  E['Fish Depth Charge'] = {
    canActivate: (e, c, p, t) => anyTime(t) && e.monsters(p).some((m) => raceOf(e, m) === 'Fish') && [...targetable(e, allMonsters(e)), ...allST(e)].some((x) => x.uid !== c.uid),
    *activate(e, link, p) {
      if (!(yield* tributeCost(e, p, 1, (m) => raceOf(e, m) === 'Fish'))) return false;
      const t = yield* pickOne(e, p, 'Fish Depth Charge: destroy which card?', [...targetable(e, allMonsters(e)), ...allST(e)].filter((x) => x.uid !== link.card.uid));
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid === undefined || !e.fieldCard(link.targetUid)) return;
      yield* e.destroy([link.targetUid]);
      if (!e.fieldCard(link.targetUid)) e.draw(p, 1);
    },
  };

  const fishborgCheck = function* (e: Engine, m: FieldCard, p: Pid): Step {
    if (e.fieldCard(m.uid) && e.monsters(p).some((x) => !named(x, 'Fishborg'))) {
      e.log(p, 'Fishborg Doctor is destroyed');
      yield* e.destroy([m.uid]);
    }
  };
  E['Fishborg Doctor'] = {
    *onSentToGrave(e, card, _p, from) {
      banishIfMarked(e, card, from);
    },
    graveIgnition: {
      can: (e, c, p) => e.oncePerTurn(c.name, p) && freeMZ(e, p) && e.monsters(p).length > 0 && e.monsters(p).every((m) => named(m, 'Fishborg')),
      *run(e, card, p) {
        e.useOnce(card.name, p);
        yield* e.specialSummon(card.uid, p, 'atk');
        if (e.fieldCard(card.uid)) markBanish(e, card.uid);
      },
    },
    onSummon: fishborgCheck,
    onSpecialSummon: fishborgCheck,
    *onAnySummon(e, w, wp, _m, c) {
      if (c === wp) yield* fishborgCheck(e, w, wp);
    },
    stateCheck: fishborgCheck,
  };

  E['Fishborg Planter'] = {
    *onSentToGrave(e, card) {
      if (e.state.fx.planter) delete (e.state.fx.planter as Record<number, number>)[card.uid];
    },
    graveIgnition: {
      can: (e, c, p) => e.oncePerTurn(c.name, p) && !(e.state.fx.planter ?? {})[c.uid] && e.player(p).deck.length > 0,
      *run(e, card, p) {
        e.useOnce(card.name, p);
        ((e.state.fx.planter ??= {}) as Record<number, number>)[card.uid] = 1;
        const top = e.player(p).deck[0];
        if (!top) return;
        yield* e.sendToGrave(top.uid, 'mill');
        e.log(p, `${top.name} is sent to the GY`);
        if (isMon(e, top) && attrOf(e, top) === 'WATER' && freeMZ(e, p) && e.find(card.uid)?.loc.zone === 'gy') yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
  };

  // "Instead of conducting your normal draw": used at the start of the Standby Phase, the drawn card goes back on top of the Deck.
  E['Flame Tiger'] = {
    *onSentToGrave(e, card, _p, from) {
      banishIfMarked(e, card, from);
    },
    *onStandbyInGrave(e, card, p) {
      const hand = e.player(p).hand;
      if (turn(e) <= 1 || e.monsters(p).length > 0 || !freeMZ(e, p) || !hand.length) return;
      const nd = e.state.fx.normalDraw as { player: Pid; uid: number; turn: number } | undefined;
      const drawn = nd && nd.player === p && nd.turn === turn(e) && e.find(nd.uid)?.loc.zone === 'hand' ? nd.uid : undefined;
      if (drawn === undefined || !(yield* e.yesno(p, 'Flame Tiger: Special Summon it instead of your normal draw?'))) return;
      e.toDeckTop(drawn);
      e.log(p, `${e.player(p).name} gives up the normal draw`);
      yield* e.specialSummon(card.uid, p, 'atk');
      if (e.fieldCard(card.uid)) markBanish(e, card.uid);
    },
  };

  E['Flash of the Forbidden Spell'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(other(p)).mz.every((z) => z !== null),
    *resolve(e, _l, p) {
      yield* e.destroy(e.monsters(other(p)).map((m) => m.uid));
    },
  };

  const flintTargets = (e: Engine) => faceUpMonsters(e).filter((m) => !e.untargetable(m) && !(m.name === 'Flint Lock' && m.equips.some((u) => e.fieldCard(u)?.name === 'Flint')));
  E['Flint'] = {
    ...h.equip((_e, _eq, host) => (host.name === 'Flint Lock' ? { atk: 0, def: 0 } : { atk: -300, def: 0 })),
    canActivate: (e, _c, _p, t) => isMain(t) && flintTargets(e).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Equip Flint to which monster?', flintTargets(e), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const host = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      const eq = e.fieldCard(link.card.uid);
      if (!host || !eq || !host.faceUp) return;
      eq.equippedTo = host.uid;
      host.equips.push(eq.uid);
      eq.active = true;
      if (host.name !== 'Flint Lock') host.cannotChangePos = true;
    },
    hostCannotAttack: (_e, _eq, host) => host.name !== 'Flint Lock',
    *onLeaveField(e, fc, p, reason) {
      const host = fc.equippedTo !== undefined ? e.find(fc.equippedTo) : null;
      if (host && (host.loc.zone === 'mz') && !(host.card as FieldCard).equips.some((u) => u !== fc.uid && e.fieldCard(u)?.name === 'Flint')) (host.card as FieldCard).cannotChangePos = false;
      // Destroyed because the equipped monster was destroyed: equip it to another monster.
      if (reason !== 'used' || !host || host.loc.zone !== 'gy' || e.find(fc.uid)?.loc.zone !== 'gy') return;
      const list = flintTargets(e);
      if (!list.length || freeST(e, p) < 0) return;
      const m = yield* pickOne(e, p, 'Flint: equip it to which monster?', list);
      if (!m) return;
      const placed = placeST(e, fc.uid, p);
      if (!placed) return;
      moveEquip(e, placed, m);
    },
  };

  // Its "send this card to the GY" cost is paid as the effect resolves (like Exiled Force).
  E['Flint Cragger'] = {
    *onSpecialSummon(e, _m, p) {
      const fossils = e.player(p).fusion.filter((c) => named(c, 'Fossil'));
      if (!e.oncePerTurn('Flint Cragger:1', p) || !fossils.length || !e.player(p).hand.length) return;
      if (!(yield* e.yesno(p, 'Flint Cragger: discard 1 card to send a "Fossil" Fusion Monster to the GY?'))) return;
      e.useOnce('Flint Cragger:1', p);
      if (!(yield* discardCost(e, p, 1))) return;
      const c = yield* pickOne(e, p, 'Send which Fusion Monster to the GY?', e.player(p).fusion.filter((x) => named(x, 'Fossil')));
      if (c) yield* e.sendToGrave(c.uid, 'mill');
    },
    ignition: {
      can: (e, _m, p) => e.oncePerTurn('Flint Cragger:2', p),
      *run(e, m, p) {
        if (!e.fieldCard(m.uid)) return;
        e.useOnce('Flint Cragger:2', p);
        yield* e.sendToGrave(m.uid, 'cost');
        e.damage(other(p), 500);
        const ps = e.player(p);
        if (!ps.gy.some((c) => c.name === 'Fossil Fusion')) return;
        const list = ps.removed.filter((c) => c.name === 'Fossil Fusion' || info(e, c).desc.includes('"Fossil Fusion"'));
        if (!list.length || !(yield* e.yesno(p, 'Flint Cragger: return a banished card to the GY?'))) return;
        const c = yield* pickOne(e, p, 'Return which card to the GY?', list);
        if (!c) return;
        ps.removed.splice(ps.removed.findIndex((x) => x.uid === c.uid), 1);
        ps.gy.push(c);
      },
    },
  };

  const flintOf = (e: Engine, m: FieldCard) => m.equips.map((u) => e.fieldCard(u)).find((x): x is FieldCard => !!x && x.name === 'Flint');
  E['Flint Lock'] = {
    battleProof: (e, m) => !!flintOf(e, m),
    ignition: {
      repeat: true,
      can: (e, m, p) => {
        const mine = flintOf(e, m);
        if (mine) return faceUpMonsters(e).some((x) => x.uid !== m.uid && !e.untargetable(x));
        return e.oncePerTurn(`Flint Lock:${m.uid}`, p) && allST(e).some((c) => c.name === 'Flint' && c.faceUp && c.equippedTo !== m.uid);
      },
      *run(e, m, p) {
        if (!e.fieldCard(m.uid)) return;
        const mine = flintOf(e, m);
        if (mine) {
          const t = yield* pickOne(e, p, 'Flint Lock: equip Flint to which monster?', faceUpMonsters(e).filter((x) => x.uid !== m.uid && !e.untargetable(x)), true);
          if (t && e.fieldCard(mine.uid)) moveEquip(e, mine, t);
          return;
        }
        const list = allST(e).filter((c) => c.name === 'Flint' && c.faceUp && c.equippedTo !== m.uid);
        const f = yield* pickOne(e, p, 'Flint Lock: take which Flint?', list, true);
        if (!f) return;
        e.useOnce(`Flint Lock:${m.uid}`, p);
        if (e.fieldCard(f.uid)) moveEquip(e, f, m);
      },
    },
  };

  E['Floodgate Trap Hole'] = {
    canActivate: (e, _c, p, t, ctx) => !!opponentSummon(e, p, t, ctx),
    *activate(_e, link, _p, ctx) {
      link.targetUid = ctx.uid;
    },
    *resolve(e, link) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || !m.faceUp) return;
      m.faceUp = false;
      m.pos = 'def';
      m.cannotChangePos = true;
      tag(m).noFlip = 1;
      e.event('position', { uid: m.uid });
      e.log(link.player, `${m.name} is changed to face-down Defense Position`);
    },
  };

  // ---------- Flower Cardian ----------
  E['Flower Cardian Cherry Blossom with Curtain'] = {
    cannotNormalSummon: true,
    summonRule: selfFirst,
    handIgnition: {
      can: (e, _c, p) => e.player(p).deck.length > 0,
      *run(e, card, p) {
        const c = drawOne(e, p);
        if (!c) return;
        e.log(p, `${e.player(p).name} shows ${c.name}`);
        if (isFC(e, c)) {
          if (freeMZ(e, p)) yield* selfSummon(e, card.uid, p);
          return;
        }
        if (e.find(c.uid)?.loc.zone === 'hand') yield* e.sendToGrave(c.uid, 'cost');
        if (e.find(card.uid)?.loc.zone === 'hand') yield* e.sendToGrave(card.uid, 'cost');
      },
    },
    // Used when the attack is declared (there is no Damage Step window).
    quick: {
      from: 'hand',
      label: 'discard it: your Flower Cardian gains 1000 ATK',
      can: (e, _c, p, t) => {
        const b = e.state.battle;
        if (t !== 'attack' || !b || b.target === null) return false;
        return [b.attacker, b.target].some((u) => {
          const m = e.fieldCard(u);
          return !!m && m.faceUp && ctrl(e, m) === p && named(m, 'Flower Cardian');
        });
      },
      *cost(e, card, p) {
        yield* e.discard(p, card.uid);
      },
      *run(e, _card, p) {
        const b = e.state.battle;
        if (!b) return;
        for (const u of [b.attacker, b.target]) {
          const m = u !== null ? e.fieldCard(u) : null;
          if (m && m.faceUp && ctrl(e, m) === p && named(m, 'Flower Cardian')) {
            boostTurn(m, 1000);
            e.log(p, `${m.name} gains 1000 ATK`);
            return;
          }
        }
      },
    },
  };

  const fcDraw = function* (e: Engine, p: Pid, onFC: (c: Card) => Step): Step {
    const c = drawOne(e, p);
    if (!c) return;
    e.log(p, `${e.player(p).name} shows ${c.name}`);
    if (isFC(e, c)) yield* onFC(c);
    else if (e.find(c.uid)?.loc.zone === 'hand') yield* e.sendToGrave(c.uid, 'cost');
  };

  E['Flower Cardian Maple with Deer'] = {
    cannotNormalSummon: true,
    summonRule: selfFirst,
    summonProc: {
      can: (e, _c, p) => e.monsters(p).some((m) => named(m, 'Flower Cardian') && m.name !== 'Flower Cardian Maple with Deer' && !e.untributable(m)),
      *run(e, c, p) {
        if (!(yield* tributeCost(e, p, 1, (m) => named(m, 'Flower Cardian') && m.name !== c.name))) return;
        yield* selfSummon(e, c.uid, p);
      },
    },
    *onSpecialSummon(e, _m, p) {
      yield* fcDraw(e, p, function* () {
        const list = stOf(e, other(p));
        if (list.length && (yield* e.yesno(p, 'Maple with Deer: destroy 1 Spell/Trap your opponent controls?'))) yield* destroyPick(e, p, 'Destroy which card?', list);
      });
    },
  };

  E['Flower Cardian Pine'] = {
    *onSummon(e, _m, p, kind) {
      if (kind !== 'normal' || !e.oncePerTurn('Flower Cardian Pine', p)) return;
      e.useOnce('Flower Cardian Pine', p);
      yield* fcDraw(e, p, function* () {});
    },
    // Destroyed by battle, or (while its owner controlled it) by the opponent's card effect, and sent to the GY.
    *watchGrave(e, card, owner, zone, events) {
      const ev = events.find((x) => x.card.uid === card.uid);
      if (zone !== 'gy' || !ev || !ev.toGy || ev.from !== 'mz' || ev.reason !== 'destroyed') return;
      if (!ev.byBattle && !(ev.controller === owner && ev.by === other(owner))) return;
      if (e.player(owner).deck.length && (yield* e.yesno(owner, 'Flower Cardian Pine: draw 1 card?'))) e.draw(owner, 1);
    },
  };

  E['Flower Cardian Pine with Crane'] = {
    cannotNormalSummon: true,
    summonRule: selfFirst,
    summonProc: {
      can: (e, _c, p) => e.monsters(p).some((m) => named(m, 'Flower Cardian') && levelOf(e, m) === 1 && m.name !== 'Flower Cardian Pine with Crane' && !e.untributable(m)),
      *run(e, c, p) {
        if (!(yield* tributeCost(e, p, 1, (m) => named(m, 'Flower Cardian') && levelOf(e, m) === 1 && m.name !== c.name))) return;
        yield* selfSummon(e, c.uid, p);
      },
    },
    *onSpecialSummon(e, _m, p) {
      yield* fcDraw(e, p, function* (c) {
        if (freeMZ(e, p) && (yield* e.yesno(p, `Pine with Crane: Special Summon ${c.name}?`)) && e.find(c.uid)?.loc.zone === 'hand') yield* e.specialSummon(c.uid, p, 'atk');
      });
    },
    // "At the end of the Battle Phase, if this card battled: draw 1."
    *afterBattle(e, a) {
      tag(a).battledTurn = turn(e);
    },
    *onAttacked(e, me) {
      if (e.fieldCard(me.uid)) tag(me).battledTurn = turn(e);
    },
    *onBattlePhaseEnd(e, m, p) {
      if (tag(m).battledTurn !== turn(e)) return;
      delete tag(m).battledTurn;
      e.log(p, 'Flower Cardian Pine with Crane: draw 1 card');
      e.draw(p, 1);
    },
  };

  E['Flower Cardian Willow'] = {
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && faceUpMonsters(e, p).some((m) => named(m, 'Flower Cardian') && levelOf(e, m) <= 10),
      *run(e, c, p) {
        yield* e.specialSummon(c.uid, p, 'atk');
        if (!e.fieldCard(c.uid)) return;
        const locks = ((e.state.fx.summonLocks ??= []) as { p: Pid; turn: number; normal: boolean; special: boolean; only?: string[] }[]).filter((l) => l.turn === turn(e));
        locks.push({ p, turn: turn(e), normal: true, special: true, only: ['Flower Cardian'] });
        e.state.fx.summonLocks = locks;
        e.log(p, `${e.player(p).name} cannot Normal or Special Summon this turn, except "Flower Cardian" monsters`);
      },
    },
    ignition: {
      can: (e, _m, p) => e.player(p).gy.some((c) => isFC(e, c)),
      *run(e, _m, p) {
        const c = yield* pickOne(e, p, 'Willow: shuffle which Flower Cardian into the Deck?', e.player(p).gy.filter((x) => isFC(e, x)));
        if (!c) return;
        toDeck(e, c.uid);
        e.draw(p, 1);
      },
    },
  };

  E['Fog Control'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && faceUpMonsters(e, p).some((m) => named(m, 'Cloudian')) && faceUpMonsters(e).length > 1,
    *activate(e, link, p) {
      if (!(yield* tributeCost(e, p, 1, (m) => m.faceUp && named(m, 'Cloudian')))) return false;
      const m = yield* pickOne(e, p, 'Fog Control: place 3 Fog Counters on which monster?', faceUpMonsters(e));
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || !m.faceUp) return;
      m.counters += 3;
      e.log(link.player, `3 Fog Counters are placed on ${m.name}`);
    },
  };

  E['Fossil Dig'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).deck.some((c) => isMon(e, c) && raceOf(e, c) === 'Dinosaur' && levelOf(e, c) <= 6),
    *resolve(e, _l, p) {
      yield* searchDeck(e, p, 'Fossil Dig: add which Dinosaur?', (c) => isMon(e, c) && raceOf(e, c) === 'Dinosaur' && levelOf(e, c) <= 6);
    },
  };

  const banishSelfFromGy = (name: string, can: (e: Engine, p: Pid) => boolean, run: (e: Engine, p: Pid) => Step): EffectDef['graveIgnition'] => ({
    can: (e, _c, p) => e.oncePerTurn(name, p) && can(e, p),
    *run(e, card, p) {
      e.useOnce(name, p);
      e.banish(card.uid);
      yield* run(e, p);
    },
  });
  E['Fossil Machine Skull Buggy'] = {
    summonRule: fossilFirst,
    *afterBattle(e, _a, t, p, destroyed) {
      if (destroyed && t && t.owner !== p && (yield* e.yesno(p, 'Skull Buggy: inflict 600 damage?'))) e.damage(other(p), 600);
    },
    graveIgnition: banishSelfFromGy(
      'Fossil Machine Skull Buggy',
      (e, p) => e.player(p).deck.some((c) => isMon(e, c) && info(e, c).desc.includes('"Fossil Fusion"')),
      function* (e, p) {
        yield* searchDeck(e, p, 'Skull Buggy: add which monster?', (c) => isMon(e, c) && info(e, c).desc.includes('"Fossil Fusion"'));
      },
    ),
  };
  E['Fossil Warrior Skull Bone'] = {
    summonRule: fossilFirst,
    attacks: (e, m) => (e.monsters(other(ctrl(e, m))).length > 0 ? 2 : 1),
    graveIgnition: banishSelfFromGy(
      'Fossil Warrior Skull Bone',
      (e, p) => e.player(p).deck.some((c) => c.name === 'Time Stream'),
      function* (e, p) {
        yield* searchDeck(e, p, 'Add "Time Stream"', (c) => c.name === 'Time Stream');
      },
    ),
  };
  E['Fossil Warrior Skull Knight'] = {
    summonRule: fossilFirst,
    piercing: true,
    attacks: (e, m) => (tag(m).again === turn(e) ? 2 : 1),
    *afterBattle(e, a, _t, p, destroyed) {
      if (destroyed && tag(a).again !== turn(e) && (yield* e.yesno(p, 'Skull Knight: make a second attack in a row?'))) tag(a).again = turn(e);
    },
    graveIgnition: banishSelfFromGy(
      'Fossil Warrior Skull Knight',
      (e) => targetable(e, allMonsters(e)).length > 0,
      function* (e, p) {
        yield* destroyPick(e, p, 'Skull Knight: destroy which monster?', targetable(e, allMonsters(e)));
      },
    ),
  };

  E['Fossil Tusker'] = onKill(function* (e, _me, p, v) {
    if (v.owner === p) return;
    e.damage(other(p), 400);
  });

  const isUnion = (e: Engine, c: Card) => isMon(e, c) && /Unequip/i.test(info(e, c).desc);
  E['Frontline Base'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    ignition: {
      repeat: true,
      can: (e, c, p) => e.oncePerTurn(`Frontline Base:${c.uid}`, p) && freeMZ(e, p) && e.player(p).hand.some((x) => isUnion(e, x) && levelOf(e, x) <= 4),
      *run(e, c, p) {
        const m = yield* pickOne(e, p, 'Frontline Base: Special Summon which Union monster?', e.player(p).hand.filter((x) => isUnion(e, x) && levelOf(e, x) <= 4), true);
        if (!m) return;
        e.useOnce(`Frontline Base:${c.uid}`, p);
        yield* e.specialSummon(m.uid, p, 'atk');
      },
    },
  };

  const ffAttr = (e: Engine, p: Pid, a: string) => e.player(p).gy.filter((c) => isMon(e, c) && attrOf(e, c) === a);
  E['Frost and Flame Dragon'] = {
    cannotNormalSummon: true,
    summonRule: (e, c, _p, how) => how !== 'special' || e.state.fx.selfSS === c.uid || e.state.fx.procSummon === c.uid,
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && ffAttr(e, p, 'FIRE').length >= 1 && ffAttr(e, p, 'WATER').length >= 2,
      *run(e, c, p) {
        const fire = yield* pickOne(e, p, 'Banish which FIRE monster?', ffAttr(e, p, 'FIRE'), true);
        if (!fire) return;
        const water = yield* pick(e, p, 'Banish which 2 WATER monsters?', ffAttr(e, p, 'WATER'), 2, 2, true);
        if (!water) return;
        for (const x of [fire, ...water]) e.banish(x.uid);
        yield* selfSummon(e, c.uid, p);
      },
    },
    ignition: destroyIgnition('Frost and Flame Dragon: destroy which monster?', (e) => targetable(e, allMonsters(e)), true),
  };

  /** Equip Spells that revive a monster from the GY and equip to it. */
  const reviveEquip = (test: (e: Engine, c: Card) => boolean, title: string, extra: Partial<EffectDef>, lp = 0): EffectDef => ({
    canActivate: (e, _c, p, t) => isMain(t) && freeMZ(e, p) && e.player(p).lp > lp && e.player(p).gy.some((c) => isMon(e, c) && test(e, c)),
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, title, e.player(p).gy.filter((x) => isMon(e, x) && test(e, x)), true);
      if (!c || (lp && !payLp(e, p, lp))) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      const eq = e.fieldCard(link.card.uid);
      if (!eq || link.targetUid === undefined || e.find(link.targetUid)?.loc.zone !== 'gy' || !freeMZ(e, p)) return;
      yield* e.specialSummon(link.targetUid, p, 'atk');
      if (e.fieldCard(link.targetUid) && e.fieldCard(eq.uid)) h.attachTo(e, eq, link.targetUid);
    },
    ...extra,
  });

  E['Fulfillment of the Contract'] = reviveEquip((e, c) => info(e, c).sub === 'Ritual', 'Fulfillment of the Contract: Special Summon which Ritual Monster?', {
    *onLeaveField(e, fc, _p, reason) {
      if (reason !== 'destroyed' || fc.equippedTo === undefined || !e.fieldCard(fc.equippedTo)) return;
      e.banish(fc.equippedTo);
    },
  }, 800);

  E['Gagagarevenge'] = reviveEquip((_e, c) => named(c, 'Gagaga'), 'Gagagarevenge: Special Summon which "Gagaga" monster?', {
    *onLeaveField(e, fc, p, reason) {
      if (fc.equippedTo !== undefined && e.fieldCard(fc.equippedTo)) yield* e.destroy([fc.equippedTo]);
      // Sent to the GY because the equipped monster became an Xyz Material: Xyz Monsters you control gain 300 ATK.
      const host = fc.equippedTo;
      if (reason !== 'used' || host === undefined || e.find(fc.uid)?.loc.zone !== 'gy') return;
      if (!e.monsters(p).some((m) => (m.mats ?? []).some((c) => c.uid === host))) return;
      for (const m of faceUpMonsters(e, p).filter((x) => info(e, x).sub === 'Xyz')) {
        boostPerm(m, 300);
        e.log(p, `${m.name} gains 300 ATK`);
      }
    },
  });

  E['Fusion Devourer'] = {
    // As the attacker: the Fusion Monster's ATK counts as 0 (same damage as adding its ATK to ours).
    attackBonus: (e, _a, t) => (t && t.pos === 'atk' && isFusion(e, t) ? e.atkOf(t) : 0),
    *onBeingAttacked(e, _me, attacker) {
      if (isFusion(e, attacker)) e.state.fx.zeroAttack = attacker.uid;
    },
  };

  // Only the Field Spell's controller can use it (the engine offers a card's effects to its controller only).
  E['Fusion Gate'] = {
    ...h.fieldSpell(() => undefined),
    ignition: {
      repeat: true,
      can: (e, _c, p) => e.state.turnPlayer === p && freeMZ(e, p) && (h.fusionPlans(e, p) as FusionPlan[]).length > 0,
      *run(e, _c, p) {
        const plans = h.fusionPlans(e, p) as FusionPlan[];
        const f = yield* pickOne(e, p, 'Fusion Gate: Fusion Summon which monster?', plans.map((x) => x.fusion), true);
        const plan = plans.find((x) => x.fusion.uid === f?.uid);
        if (!plan) return;
        const chosen: number[] = [];
        for (const slot of plan.mats) {
          const c = yield* pickOne(e, p, 'Fusion Gate: banish which material?', slot.filter((x) => !chosen.includes(x.uid)), true);
          if (!c) return;
          chosen.push(c.uid);
        }
        for (const u of chosen) e.banish(u);
        if (!freeMZ(e, p)) return;
        yield* e.specialSummon(plan.fusion.uid, p, 'atk');
        e.log(p, `${e.player(p).name} Fusion Summons ${plan.fusion.name}!`);
      },
    },
  };

  E['Fusion Sword Murasame Blade'] = {
    ...h.equipFor((e, m) => raceOf(e, m) === 'Warrior', () => ({ atk: 800, def: 0 })),
    effectProof: (_e, m) => m.equippedTo !== undefined,
  };

  E['Fusion Weapon'] = h.equipFor((e, m) => isFusion(e, m) && levelOf(e, m) <= 6, () => ({ atk: 1500, def: 1500 }));

  /** A Fusion Monster in the Extra Deck whose named materials are all in the Main Deck. */
  const futurePlan = (e: Engine, p: Pid, f: Card): Card[] | null => {
    const ids = e.fusionMaterials(f.name);
    if (!ids) return null;
    const used: number[] = [];
    for (const id of ids) {
      const c = e.player(p).deck.find((x) => info(e, x).id === id && !used.includes(x.uid));
      if (!c) return null;
      used.push(c.uid);
    }
    return used.map((u) => e.find(u)!.card);
  };
  E['Future Fusion'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve(e, link) {
      const fc = e.fieldCard(link.card.uid);
      if (fc) tag(fc).stage = 0;
    },
    *onStandby(e, fc, p) {
      if (e.state.turnPlayer !== p) return;
      const t = tag(fc);
      if ((t.stage ?? 0) === 0) {
        t.stage = 1;
        const list = e.player(p).fusion.filter((f) => futurePlan(e, p, f));
        const f = yield* pickOne(e, p, 'Future Fusion: show which Fusion Monster?', list);
        if (!f) return;
        e.log(p, `${e.player(p).name} shows ${f.name}`);
        for (const c of futurePlan(e, p, f) ?? []) yield* e.sendToGrave(c.uid, 'mill');
        e.player(p).deck = e.shuffle(e.player(p).deck);
        t.shown = f.uid;
      } else if (t.stage === 1) {
        t.stage = 2;
        if (t.shown === undefined || e.find(t.shown)?.loc.zone !== 'fusion' || !freeMZ(e, p)) return;
        yield* e.specialSummon(t.shown, p, 'atk');
        if (e.fieldCard(t.shown) && e.fieldCard(fc.uid)) h.attachTo(e, fc, t.shown);
      }
    },
    *onLeaveField(e, fc) {
      if (fc.equippedTo !== undefined && e.fieldCard(fc.equippedTo)) yield* e.destroy([fc.equippedTo]);
    },
  };

  const gaapLock = function* (e: Engine): Step {
    allToAttack(e, true);
  };
  E['Gaap the Divine Soldier'] = {
    *onSummon(e) {
      allToAttack(e, true);
    },
    onSpecialSummon: gaapLock,
    onStandby: gaapLock,
    onAnySummon: gaapLock,
    stateCheck: gaapLock,
    // The position lock ends with it (unless Final Attack Orders or another Gaap still holds it).
    *onLeaveField(e, fc) {
      const still = faceUpMonsters(e).some((m) => m.uid !== fc.uid && m.name === 'Gaap the Divine Soldier' && !e.isNegated(m)) || e.liveST().some((x) => x.c.name === 'Final Attack Orders');
      if (!still) for (const m of allMonsters(e)) if (m.tags?.lockPosTurn !== undefined) delete m.tags.lockPosTurn;
    },
    ignition: {
      can: (e, _m, p) => e.player(p).hand.some((c) => isMon(e, c) && raceOf(e, c) === 'Fiend'),
      *run(e, m, p) {
        const list = e.player(p).hand.filter((c) => isMon(e, c) && raceOf(e, c) === 'Fiend');
        const shown = yield* pick(e, p, 'Gaap: reveal which Fiend monsters?', list, 1, list.length);
        if (!shown || !shown.length || !e.fieldCard(m.uid)) return;
        e.log(p, `${e.player(p).name} reveals ${shown.map((c) => c.name).join(', ')}`);
        boostTurn(m, 300 * shown.length);
      },
    },
  };

  E['Gagaga Gardna'] = {
    quick: {
      from: 'hand',
      label: 'Special Summon it',
      can: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null && e.state.battle?.target === null && freeMZ(e, p),
      *run(e, card, p) {
        if (e.find(card.uid)?.loc.zone === 'hand' && freeMZ(e, p)) yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
    // "When this card is targeted for an attack: discard 1 card" is asked before damage calculation.
    *onBeingAttacked(e, me, _a, p) {
      if (!e.player(p).hand.length || !(yield* e.yesno(p, 'Gagaga Gardna: discard 1 card so it cannot be destroyed by this battle?'))) return;
      if (yield* discardCost(e, p, 1)) tag(me).safe = e.state.fx.battleNo ?? 0;
    },
    battleProof: (e, m) => !!e.state.fx.battleNo && tag(m).safe === e.state.fx.battleNo,
  };

  const rocks = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isMon(e, c) && raceOf(e, c) === 'Rock');
  E['Gaia Plate the Earth Giant'] = {
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && rocks(e, p).length >= 2,
      *run(e, c, p) {
        const two = yield* pick(e, p, 'Gaia Plate: banish which 2 Rock monsters?', rocks(e, p), 2, 2, true);
        if (!two) return;
        for (const x of two) e.banish(x.uid);
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
    *onStandby(e, m, p) {
      if (e.state.turnPlayer !== p) return;
      const list = rocks(e, p);
      if (list.length && (yield* e.yesno(p, 'Gaia Plate: banish 1 Rock monster from your GY to keep it?'))) {
        const c = yield* pickOne(e, p, 'Banish which Rock monster?', list);
        if (c) {
          e.banish(c.uid);
          return;
        }
      }
      if (e.fieldCard(m.uid)) yield* e.sendToGrave(m.uid, 'cost');
    },
    // Halving the opponent's ATK/DEF: as the attacker it is added to Gaia Plate (same result), as the target it is applied to the attacker for the battle.
    attackBonus: (e, _a, t) => (t ? Math.floor((t.pos === 'atk' ? e.atkOf(t) : e.defOf(t)) / 2) : 0),
    *onBeingAttacked(e, me, attacker) {
      const cut = Math.floor(e.atkOf(attacker) / 2);
      boostTurn(attacker, -cut);
      tag(me).cut = cut;
    },
    *onAttacked(e, me, attacker) {
      if (e.fieldCard(attacker.uid) && tag(me).cut) boostTurn(attacker, tag(me).cut);
      tag(me).cut = 0;
    },
  };

  E['Galaxy Cyclone'] = {
    canActivate: (e, c, _p, t) => anyTime(t) && allST(e).some((x) => !x.faceUp && x.uid !== c.uid),
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Galaxy Cyclone: destroy which Set card?', allST(e).filter((x) => !x.faceUp && x.uid !== link.card.uid), true);
      if (!c) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link) {
      if (link.targetUid !== undefined && e.fieldCard(link.targetUid)) yield* e.destroy([link.targetUid]);
    },
    *onSentToGrave(e, card) {
      ((e.state.fx.galaxyCycloneSent ??= {}) as Record<number, number>)[card.uid] = turn(e);
    },
    graveIgnition: {
      can: (e, c, p) => e.oncePerTurn(c.name, p) && e.state.fx.galaxyCycloneSent?.[c.uid] !== turn(e) && allST(e).some((x) => x.faceUp),
      *run(e, card, p) {
        const t = yield* pickOne(e, p, 'Galaxy Cyclone: destroy which face-up Spell/Trap?', allST(e).filter((x) => x.faceUp), true);
        if (!t) return;
        e.useOnce(card.name, p);
        e.banish(card.uid);
        if (e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
      },
    },
  };

  E['Galaxy Tyranno'] = {
    quick: {
      from: 'hand',
      label: 'Special Summon it in Defense Position',
      can: (e, _c, p, t, ctx) => {
        if (opponentAttack(e, p, t, ctx) === null || !freeMZ(e, p)) return false;
        const tg = e.state.battle?.target;
        const m = tg !== null && tg !== undefined ? e.fieldCard(tg) : null;
        return !!m && m.faceUp && ctrl(e, m) === p && named(m, 'Galaxy');
      },
      *run(e, card, p) {
        if (e.find(card.uid)?.loc.zone !== 'hand' || !freeMZ(e, p)) return;
        yield* e.specialSummon(card.uid, p, 'def');
        if (!e.fieldCard(card.uid)) return;
        // "When Summoned this way, you can: immediately Xyz Summon 1 "Galaxy" Xyz Monster, using only "Galaxy" monsters you control."
        const plans = e.player(p).fusion
          .filter((x) => named(x, 'Galaxy') && info(e, x).sub === 'Xyz' && !e.summonBlocked(p, x, 'special', 'fusion'))
          .map((x) => ({ x, sets: extraMaterialSets(e, p, x.name).filter((set) => set.every((m) => named(m, 'Galaxy'))) }))
          .filter((pl) => pl.sets.length > 0);
        if (!plans.length || !(yield* e.yesno(p, 'Galaxy Tyranno: Xyz Summon a "Galaxy" Xyz Monster?'))) return;
        const x = yield* pickOne(e, p, 'Galaxy Tyranno: Xyz Summon which monster?', plans.map((pl) => pl.x), true);
        const pl = plans.find((y) => y.x.uid === x?.uid);
        if (!pl) return;
        const k = pl.sets.length === 1 ? 0 : yield* chooseOption(e, p, `Xyz Summon ${pl.x.name} using:`, pl.sets.map((set) => set.map((m) => m.name).join(' + ')));
        const set = pl.sets[k ?? 0];
        if (set) yield* e.extraSummon(p, pl.x.uid, set.map((m) => m.uid), 'Xyz');
      },
    },
  };

}
