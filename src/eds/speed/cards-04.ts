// Speed Duel card scripts, batch 04 (Danipon ... Elemental HERO Dark Neos).
import type { EffectDef } from '../effects';
import type { SpeedHelpers } from './helpers';
import {
  type Card,
  type ChainLink,
  type Engine,
  type FieldCard,
  type Gen,
  type Pid,
  type Step,
  allMonsters,
  allST,
  anyTime,
  attrOf,
  chooseOption,
  ctrl,
  deckToGrave,
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
  levelOf,
  millTop,
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
  tributeCost,
} from './helpers';

// ---------- local helpers ----------
const isFusion = (e: Engine, c: Card) => info(e, c).sub === 'Fusion';
const isExtraOrRitual = (e: Engine, c: Card) => info(e, c).sub === 'Fusion' || info(e, c).sub === 'Ritual';
const monsterIn = (e: Engine, list: Card[], test: (c: Card) => boolean = () => true) => list.filter((c) => isMonster(e, c) && test(c));
const dhero = (c: Card | string) => named(c, 'Destiny HERO');
const fx = (e: Engine) => e.state.fx as Record<string, any>;
const fxMap = (e: Engine, key: string): Record<number, number> => (fx(e)[key] ??= {});
/** The other monsters/cards a player controls besides `uid`. */
const othersOnField = (e: Engine, p: Pid, uid: number) => [...e.monsters(p), ...stOf(e, p)].filter((c) => c.uid !== uid);

/** Equip cards attached to a monster go to the GY before it leaves the field some other way. */
function* dropEquips(e: Engine, uid: number): Step {
  const m = e.fieldCard(uid);
  if (m) for (const q of m.equips.slice()) if (e.fieldCard(q)) yield* e.sendToGrave(q, 'used');
}
/** Moves a card into its owner's Extra Deck (Fusion Monsters returning to the hand or Deck). */
function toExtra(e: Engine, uid: number) {
  const f = e.find(uid);
  if (!f) return;
  e.toDeckTop(uid);
  const ps = e.player(f.card.owner);
  const i = ps.deck.findIndex((c) => c.uid === uid);
  if (i < 0) return;
  const [c] = ps.deck.splice(i, 1);
  ps.fusion.push(c);
  e.log(f.card.owner, `${c.name} returns to the Extra Deck`);
}
/** Returns a card to the hand (a Fusion Monster goes to the Extra Deck). */
function* bounce(e: Engine, uid: number): Step {
  const f = e.find(uid);
  if (!f) return;
  yield* dropEquips(e, uid);
  if (isFusion(e, f.card)) toExtra(e, uid);
  else {
    e.toHand(uid);
    e.log(f.card.owner, `${f.card.name} returns to the hand`);
  }
}
/** Puts a card into its owner's Deck: on top, at the bottom, or shuffled in (Fusion Monsters go to the Extra Deck). */
function* intoDeck(e: Engine, uid: number, where: 'top' | 'bottom' | 'shuffle'): Step {
  const f = e.find(uid);
  if (!f) return;
  yield* dropEquips(e, uid);
  if (isFusion(e, f.card)) return toExtra(e, uid);
  const owner = f.card.owner;
  e.toDeckTop(uid);
  const ps = e.player(owner);
  if (where === 'shuffle') ps.deck = e.shuffle(ps.deck);
  else if (where === 'bottom') {
    const i = ps.deck.findIndex((c) => c.uid === uid);
    if (i >= 0) ps.deck.push(...ps.deck.splice(i, 1));
  }
  e.log(owner, `${f.card.name} is put into the Deck${where === 'top' ? ' (on top)' : where === 'bottom' ? ' (at the bottom)' : ''}`);
}
/** Discards 1 random card from a player's hand. */
function* randomDiscard(e: Engine, victim: Pid): Step {
  const hand = e.player(victim).hand;
  if (!hand.length) return;
  const c = hand[e.roll(hand.length) - 1];
  yield* e.discard(victim, c.uid);
}
/** Applies a Spell/Trap card's effect from wherever it is (Diamond Dude, Double Spell, Darklord Nasten). */
function* applyEffect(e: Engine, p: Pid, card: Card, copied = true): Step {
  const eff = getDef(e, card);
  const f = e.find(card.uid);
  if (!eff?.resolve || !f) return;
  const link: ChainLink = { card, loc: f.loc, player: p, label: card.name, negated: false, payload: copied ? { copied: true } : undefined };
  e.log(p, `${e.player(p).name} applies the effect of ${card.name}`);
  if (eff.activate) {
    const prev = e.actor;
    e.actor = p;
    let ok: boolean | void;
    try {
      ok = yield* eff.activate(e, link, p, {});
    } finally {
      e.actor = prev;
    }
    if (ok === false) return;
  }
  yield* e.as(p, eff.resolve(e, link, p));
}
const getDef = (e: Engine, c: Card) => e.effectOn({ uid: c.uid, name: c.name, owner: c.owner });
const canApply = (e: Engine, p: Pid, c: Card) => {
  const d = getDef(e, c);
  return !!d?.resolve && (!d.canActivate || d.canActivate(e, c, p, 'main', {}));
};
/** Places a Spell/Trap from the hand or Deck face-up in a Spell & Trap Zone. */
function placeFaceUp(e: Engine, p: Pid, uid: number): FieldCard | null {
  const f = e.find(uid);
  const z = freeST(e, p);
  if (!f || z < 0 || (f.loc.zone !== 'hand' && f.loc.zone !== 'deck')) return null;
  const ps = e.player(f.loc.player);
  const list = f.loc.zone === 'hand' ? ps.hand : ps.deck;
  const [c] = list.splice(f.loc.index, 1);
  const fc: FieldCard = { uid: c.uid, name: c.name, owner: c.owner, pos: 'atk', faceUp: true, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true };
  e.player(p).sz[z] = fc;
  e.event('set', { uid, player: p });
  e.log(p, `${e.player(p).name} places ${c.name} face-up`);
  return fc;
}

// ---------- Fusion Summons with named materials (Dark Fusion, Dark Calling, Dyna Base...) ----------
type FPlan = { fusion: Card; ids: number[]; slots: Card[][] };
function assign(e: Engine, slots: Card[][], ids: number[], used: number[], subbed: boolean, must?: number): boolean {
  if (!slots.length) return must === undefined || used.includes(must);
  return slots[0].some((c) => {
    if (used.includes(c.uid)) return false;
    const asSub = info(e, c).id !== ids[0];
    if (asSub && subbed) return false;
    return assign(e, slots.slice(1), ids.slice(1), [...used, c.uid], subbed || asSub, must);
  });
}
function fusionPlansFrom(e: Engine, p: Pid, pool: Card[], test: (f: Card) => boolean, must?: number): FPlan[] {
  const mons = pool.filter((c) => isMonster(e, c) && c.name !== 'Eater of Millions');
  const out: FPlan[] = [];
  for (const fusion of e.player(p).fusion) {
    if (!test(fusion)) continue;
    const ids = e.fusionMaterials(fusion.name);
    if (!ids) continue;
    const subs = mons.filter((c) => getDef(e, c)?.fusionSub);
    const slots = ids.map((id) => [...mons.filter((c) => info(e, c).id === id), ...subs.filter((c) => info(e, c).id !== id)]);
    if (assign(e, slots, ids, [], false, must)) out.push({ fusion, ids, slots });
  }
  return out;
}
function* chooseFusion(e: Engine, p: Pid, title: string, plans: FPlan[], must?: number): Gen<{ fusion: number; mats: number[] } | null> {
  const fusion = yield* pickOne(e, p, `${title}: Fusion Summon which monster?`, plans.map((x) => x.fusion), true);
  if (!fusion) return null;
  const plan = plans.find((x) => x.fusion.uid === fusion.uid)!;
  const chosen: number[] = [];
  let subbed = false;
  for (let i = 0; i < plan.slots.length; i++) {
    const free = plan.slots[i].filter((c) => {
      if (chosen.includes(c.uid)) return false;
      const asSub = info(e, c).id !== plan.ids[i];
      if (asSub && subbed) return false;
      return assign(e, plan.slots.slice(i + 1), plan.ids.slice(i + 1), [...chosen, c.uid], subbed || asSub, must);
    });
    const c = free.length === 1 ? free[0] : yield* pickOne(e, p, `${title}: use which material?`, free, true);
    if (!c) return null;
    if (info(e, c).id !== plan.ids[i]) subbed = true;
    chosen.push(c.uid);
  }
  return { fusion: fusion.uid, mats: chosen };
}
function* doFusion(e: Engine, p: Pid, pick: { fusion: number; mats: number[] }, how: 'grave' | 'banish'): Gen<FieldCard | null> {
  if (e.find(pick.fusion)?.loc.zone !== 'fusion' || pick.mats.some((u) => !e.find(u))) return null;
  for (const u of pick.mats) {
    if (how === 'banish') e.banish(u);
    else yield* e.sendToGrave(u, 'used');
  }
  if (!freeMZ(e, p)) return null;
  yield* e.specialSummon(pick.fusion, p, 'atk');
  const m = e.fieldCard(pick.fusion);
  if (m) {
    (fx(e).fusionMatList ??= {})[m.uid] = pick.mats.slice();
    e.log(p, `${e.player(p).name} Fusion Summons ${m.name}!`);
  }
  return m;
}
const handAndField = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.monsters(p)];

// ---------- Dark Scorpions and other "inflicts battle damage: choose 1" monsters ----------
function battleChoice(options: { label: string; can: (e: Engine, p: Pid, m: FieldCard) => boolean; run: (e: Engine, p: Pid, m: FieldCard) => Step }[]): EffectDef['onBattleDamage'] {
  return function* (e, m, p) {
    const avail = options.filter((o) => o.can(e, p, m));
    if (!avail.length) return;
    const i = yield* chooseOption(e, p, `${m.name}: activate an effect? (cancel = no)`, avail.map((o) => o.label), true);
    if (i === null) return;
    yield* avail[i].run(e, p, m);
  };
}
const oppDeckHas = (n: number) => (e: Engine, p: Pid) => e.player(other(p)).deck.length >= n;

// ---------- LV monsters ----------
/** "Special Summoned by the effect of X" marks (keyed by the summoned card's uid). */
const markBy = (e: Engine, key: string, uid: number, v: number) => (fxMap(e, key)[uid] = v);
const clearMark = (e: Engine, key: string, uid: number) => delete fxMap(e, key)[uid];
function* levelUp(e: Engine, m: FieldCard, p: Pid, next: string, mark: string): Step {
  const ps = e.player(p);
  const cands = [...ps.hand, ...ps.deck].filter((c) => c.name === next);
  if (!cands.length || !(yield* e.yesno(p, `${m.name}: send it to the GY to Special Summon ${next}?`))) return;
  yield* e.sendToGrave(m.uid, 'cost');
  const s = yield* summonOneOf(e, p, `Special Summon which ${next}?`, cands.filter((c) => e.find(c.uid)), 'atk');
  if (s) markBy(e, mark, s.uid, e.state.turn);
}

export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  E['Danipon'] = {
    *onDestroyed(e, _c, p, byBattle) {
      const ok = (c: Card) => isMonster(e, c) && raceOf(e, c) === 'Insect' && (info(e, c).def ?? 0) <= 1000;
      if (!byBattle || !e.player(p).deck.some(ok) || !(yield* e.yesno(p, 'Danipon: add an Insect monster with 1000 or less DEF from the Deck?'))) return;
      yield* searchDeck(e, p, 'Danipon: add which Insect?', ok);
    },
  };

  // Only the hand effect: Link Monsters do not exist here.
  E['Danmari @Ignister'] = {
    quick: {
      from: 'hand',
      label: 'Special Summon it and negate the attack',
      can: (e, _c, p, t) => {
        const b = e.state.battle;
        if (t !== 'attack' || !b || !freeMZ(e, p)) return false;
        return [b.attacker, b.target].some((u) => u !== null && e.controller(u) === p && named(e.fieldCard(u)?.name ?? '', '@Ignister') && !!e.fieldCard(u)?.faceUp);
      },
      *run(e, card, p) {
        if (e.find(card.uid)?.loc.zone !== 'hand' || !freeMZ(e, p)) return;
        yield* e.specialSummon(card.uid, p, 'atk');
        if (e.fieldCard(card.uid) && e.state.battle) {
          e.log(p, 'Danmari @Ignister negates the attack');
          e.endBattle();
        }
      },
    },
  };

  const darkCallingPlans = (e: Engine, p: Pid) => fusionPlansFrom(e, p, [...e.player(p).hand, ...e.player(p).gy], (f) => info(e, f).desc.includes('"Dark Fusion"'));
  E['Dark Calling'] = {
    canActivate: (e, _c, p, t) => isMain(t) && freeMZ(e, p) && darkCallingPlans(e, p).length > 0,
    *activate(e, link, p) {
      const c = yield* chooseFusion(e, p, 'Dark Calling', darkCallingPlans(e, p));
      if (!c) return false;
      link.payload = c;
    },
    *resolve(e, link, p) {
      yield* doFusion(e, p, link.payload as { fusion: number; mats: number[] }, 'banish');
    },
  };

  E['Dark Catapulter'] = {
    *onStandby(e, m, p) {
      if (e.state.turnPlayer !== p || m.pos !== 'def' || !m.faceUp) return;
      m.counters += 1;
      e.log(p, `Dark Catapulter gets a counter (${m.counters})`);
    },
    ignition: {
      can: (e, m, p) => m.counters > 0 && e.player(p).gy.length >= m.counters && allST(e).length >= m.counters,
      *run(e, m, p) {
        const n = m.counters;
        if (!n || e.player(p).gy.length < n || allST(e).length < n) return;
        const cost = yield* pick(e, p, `Dark Catapulter: banish ${n} card(s) from your GY`, e.player(p).gy.slice(), n, n);
        if (!cost) return;
        for (const c of cost) e.banish(c.uid);
        const ts = yield* pick(e, p, `Dark Catapulter: destroy ${n} Spell/Trap card(s)`, allST(e), n, n);
        if (ts) yield* e.destroy(ts.map((c) => c.uid));
        const me = e.fieldCard(m.uid);
        if (me) me.counters = 0;
      },
    },
  };

  // ATK is compared without Dark City's own bonus; applied for the whole battle, not only damage calculation.
  let cityBusy = false;
  E['Dark City'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    aura(e, _src, target) {
      const b = e.state.battle;
      if (cityBusy || !b || b.attacker !== target.uid || b.target === null || !dhero(target)) return undefined;
      const def = e.fieldCard(b.target);
      if (!def) return undefined;
      cityBusy = true;
      try {
        return e.atkOf(target) < e.atkOf(def) ? { atk: 1000, def: 0 } : undefined;
      } finally {
        cityBusy = false;
      }
    },
  };

  // The Special Summon lock it puts on the opponent is not enforced.
  E['Dark Contract with Patent License'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    *onAnySummon(e, w, wc, m, controller, kind) {
      if (kind !== 'special' || controller === wc || !m.faceUp) return;
      const sub = info(e, m).sub;
      if (!['Fusion', 'Synchro', 'Xyz', 'Link'].includes(sub)) return;
      if (!faceUpMonsters(e, wc).some((x) => named(x, 'D/D/D') && info(e, x).sub === sub)) return;
      if (!e.fieldCard(w.uid) || !(yield* e.yesno(wc, 'Dark Contract with Patent License: inflict 1000 damage?'))) return;
      e.damage(other(wc), 1000);
    },
    *onSentToGrave(e, card, p) {
      const ok = (c: Card) => isMonster(e, c) && named(c, 'D/D') && c.uid !== card.uid;
      if (!e.oncePerTurn(card.name, p) || !e.player(p).gy.some(ok) || !(yield* e.yesno(p, 'Dark Contract with Patent License: add a "D/D" monster from your GY to your hand?'))) return;
      e.useOnce(card.name, p);
      const c = yield* pickOne(e, p, 'Add which "D/D" monster?', e.player(p).gy.filter(ok));
      if (c) e.toHandOf(c.uid, p);
    },
  };

  // The Normal Spell is negated and Dark Deal's controller discards 1 random card right away.
  E['Dark Deal'] = {
    canActivate: (e, _c, p, t, ctx) => t === 'spell' && !!ctx.link && ctx.link.player !== p && isSpell(e, ctx.link.card) && info(e, ctx.link.card).sub === 'Normal' && e.player(p).lp > 1000,
    *activate(e, link, p, ctx) {
      if (!payLp(e, p, 1000)) return false;
      link.payload = ctx.link;
    },
    *resolve(e, link, p) {
      const target = link.payload as ChainLink | undefined;
      if (!target) return;
      target.negated = true;
      e.log(p, `${target.card.name}'s effect becomes "Your opponent discards 1 random card"`);
      yield* e.as(target.player, randomDiscard(e, p));
    },
  };

  E['Dark Driceratops'] = { piercing: true };
  E['Elemental HERO Bladedge'] = { piercing: true };

  const graveTarget = (title: string, test: (e: Engine, c: Card) => boolean, n = 1): EffectDef => ({
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).gy.filter((c) => test(e, c)).length >= n,
    *activate(e, link, p) {
      const cs = yield* pick(e, p, title, e.player(p).gy.filter((c) => test(e, c)), n, n, true);
      if (!cs) return false;
      link.payload = cs.map((c) => c.uid);
    },
    *resolve(e, link, p) {
      for (const u of link.payload as number[]) if (e.find(u)?.loc.zone === 'gy') e.toHandOf(u, p);
    },
  });
  E['Dark Eruption'] = graveTarget('Dark Eruption: add which DARK monster?', (e, c) => isMonster(e, c) && attrOf(e, c) === 'DARK' && (info(e, c).atk ?? 0) <= 1500);
  E['Dark Factory of Mass Production'] = graveTarget('Dark Factory of Mass Production: add which 2 Normal Monsters?', isNormalMonster, 2);

  // The "cannot be targeted this turn" protection is not applied.
  const darkFusionPlans = (e: Engine, p: Pid) => fusionPlansFrom(e, p, handAndField(e, p), (f) => raceOf(e, f) === 'Fiend');
  E['Dark Fusion'] = {
    canActivate: (e, _c, p, t) => isMain(t) && darkFusionPlans(e, p).length > 0,
    *activate(e, link, p) {
      const c = yield* chooseFusion(e, p, 'Dark Fusion', darkFusionPlans(e, p));
      if (!c) return false;
      link.payload = c;
    },
    *resolve(e, link, p) {
      yield* doFusion(e, p, link.payload as { fusion: number; mats: number[] }, 'grave');
    },
  };

  const jeroid = function* (e: Engine, p: Pid): Step {
    const m = yield* pickOne(e, p, 'Dark Jeroid: which monster loses 800 ATK?', targetable(e, faceUpMonsters(e)));
    if (m && e.fieldCard(m.uid)) {
      tag(m).permAtk = (tag(m).permAtk ?? 0) - 800;
      e.log(p, `${m.name} loses 800 ATK`);
    }
  };
  E['Dark Jeroid'] = {
    *onSummon(e, _m, p) {
      yield* jeroid(e, p);
    },
    *onSpecialSummon(e, _m, p) {
      yield* jeroid(e, p);
    },
  };

  // Dark Lucius: negating the effects of the monsters it destroys is not supported.
  const luciusBattle = (onKill: (e: Engine, me: FieldCard, victim: Card, p: Pid) => Step): Partial<EffectDef> => ({
    *afterBattle(e, me, target, p, destroyed) {
      if (destroyed) yield* onKill(e, me, target, p);
    },
    *onAttacked(e, me, attacker, p) {
      if (e.find(attacker.uid)?.loc.zone === 'gy' && e.fieldCard(me.uid)) yield* onKill(e, me, attacker, p);
    },
  });
  E['Dark Lucius LV4'] = {
    ...luciusBattle(function* (e, me) {
      tag(me).luciusKill = e.state.turn;
    }),
    *onStandby(e, m, p) {
      const k = m.tags?.luciusKill;
      if (e.state.turnPlayer !== p || k === undefined || k < e.state.turn - 2 || k >= e.state.turn) return;
      delete tag(m).luciusKill;
      yield* levelUp(e, m, p, 'Dark Lucius LV6', 'lucius6');
    },
    *onSummon(e, m) {
      clearMark(e, 'lucius6', m.uid);
    },
  };
  E['Dark Lucius LV6'] = {
    ...luciusBattle(function* (e, me, victim) {
      if (fxMap(e, 'lucius6')[me.uid] !== undefined && info(e, victim).sub !== 'Normal') tag(me).luciusKill = e.state.turn;
    }),
    *onStandby(e, m, p) {
      const k = m.tags?.luciusKill;
      if (e.state.turnPlayer !== p || k === undefined || k < e.state.turn - 2 || k >= e.state.turn) return;
      delete tag(m).luciusKill;
      yield* levelUp(e, m, p, 'Dark Lucius LV8', 'lucius8');
    },
    *onSummon(e, m) {
      clearMark(e, 'lucius6', m.uid);
    },
    *onSpecialSummon(e, m) {
      clearMark(e, 'lucius6', m.uid);
    },
  };
  E['Dark Lucius LV8'] = {
    ...luciusBattle(function* (e, me, victim, p) {
      if (fxMap(e, 'lucius8')[me.uid] === undefined || e.find(victim.uid)?.loc.zone !== 'gy' || victim.owner === p) return;
      e.banish(victim.uid);
    }),
    *onSummon(e, m) {
      clearMark(e, 'lucius8', m.uid);
    },
    *onSpecialSummon(e, m) {
      clearMark(e, 'lucius8', m.uid);
    },
  };

  E['Dark Magic Attack'] = {
    canActivate: (e, _c, p, t) => isMain(t) && faceUpMonsters(e, p).some((m) => m.name === 'Dark Magician') && stOf(e, other(p)).length > 0,
    *resolve(e, _l, p) {
      if (!faceUpMonsters(e, p).some((m) => m.name === 'Dark Magician')) return;
      yield* e.destroy(stOf(e, other(p)).map((c) => c.uid));
    },
  };

  // "You cannot Summon other monsters": activation needs no Normal Summon yet this turn, and uses up the Normal Summon (Set included).
  E['Dark Magic Curtain'] = {
    canActivate: (e, _c, p, t) => isMain(t) && !e.player(p).normalSummoned && e.player(p).lp > 1 && freeMZ(e, p) && e.player(p).deck.some((c) => c.name === 'Dark Magician'),
    *activate(e, _l, p) {
      if (!payLp(e, p, Math.floor(e.player(p).lp / 2))) return false;
      e.player(p).normalSummoned = true;
    },
    *resolve(e, _l, p) {
      yield* summonOneOf(e, p, 'Dark Magic Curtain: Special Summon Dark Magician', e.player(p).deck.filter((c) => c.name === 'Dark Magician'), 'atk');
    },
  };

  E['Dark Mimic LV1'] = {
    *flip(e, _m, p) {
      e.draw(p, 1);
    },
    *onStandby(e, m, p) {
      if (e.state.turnPlayer !== p || !e.oncePerTurn(`mimic1:${m.uid}`, p)) return;
      e.useOnce(`mimic1:${m.uid}`, p);
      yield* levelUp(e, m, p, 'Dark Mimic LV3', 'mimic3');
    },
  };
  E['Dark Mimic LV3'] = {
    *onDestroyed(e, card, p, byBattle) {
      if (!byBattle) return;
      e.draw(p, fxMap(e, 'mimic3')[card.uid] !== undefined ? 2 : 1);
      clearMark(e, 'mimic3', card.uid);
    },
    *onSummon(e, m) {
      clearMark(e, 'mimic3', m.uid);
    },
    *onSpecialSummon(e, m) {
      clearMark(e, 'mimic3', m.uid);
    },
  };

  E['Dark Paladin'] = {
    selfBonus(e) {
      const dragons = allMonsters(e).filter((m) => m.faceUp && raceOf(e, m) === 'Dragon').length + [...e.player(0).gy, ...e.player(1).gy].filter((c) => isMonster(e, c) && raceOf(e, c) === 'Dragon').length;
      return { atk: 500 * dragons, def: 0 };
    },
    quick: {
      label: 'discard 1 card to negate the Spell',
      can: (e, _c, p, t, ctx) => t === 'spell' && !!ctx.link && isSpell(e, ctx.link.card) && e.player(p).hand.length > 0,
      *cost(e, _c, p, link, ctx) {
        if (!(yield* discardCost(e, p, 1))) return false;
        link.payload = { ...(link.payload as object), target: ctx.link };
      },
      *run(e, card, p, link) {
        const target = (link.payload as { target?: ChainLink }).target;
        if (!target || !e.fieldCard(card.uid)?.faceUp) return;
        negateLink(e, target, p);
        if (e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
      },
    },
  };

  E['Dark Renewal'] = {
    canActivate: (e, _c, p, t, ctx) => {
      const m = opponentSummon(e, p, t, ctx);
      return !!m && ctx.summonKind !== 'flip' && !e.untargetable(m) && targetable(e, faceUpMonsters(e, p)).some((x) => raceOf(e, x) === 'Spellcaster');
    },
    *activate(e, link, p, ctx) {
      const mine = yield* pickOne(e, p, 'Dark Renewal: target which Spellcaster you control?', targetable(e, faceUpMonsters(e, p)).filter((x) => raceOf(e, x) === 'Spellcaster'), true);
      if (!mine) return false;
      link.targetUid = ctx.uid;
      link.payload = mine.uid;
    },
    *resolve(e, link, p) {
      const a = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      const b = e.fieldCard(link.payload as number);
      if (!a || !b) return;
      yield* e.sendToGrave(a.uid, 'used');
      yield* e.sendToGrave(b.uid, 'used');
      const ok = (c: Card) => isMonster(e, c) && !isExtraOrRitual(e, c) && attrOf(e, c) === 'DARK' && raceOf(e, c) === 'Spellcaster';
      const cands = [...e.player(p).deck, ...e.player(p).gy].filter(ok);
      if (!cands.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Dark Renewal: Special Summon a DARK Spellcaster from your Deck or GY?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which DARK Spellcaster?', cands, 'atk');
    },
  };

  E['Dark Scorpion - Chick the Yellow'] = {
    onBattleDamage: battleChoice([
      {
        label: 'Return 1 card on the field to the hand',
        can: (e) => targetable(e, allMonsters(e)).length + allST(e).length > 0,
        *run(e, p) {
          const c = yield* pickOne(e, p, 'Chick the Yellow: return which card to the hand?', [...targetable(e, allMonsters(e)), ...allST(e)]);
          if (c && e.fieldCard(c.uid)) yield* bounce(e, c.uid);
        },
      },
      {
        label: "Look at the top card of your opponent's Deck",
        can: oppDeckHas(1),
        *run(e, p) {
          const top = e.player(other(p)).deck[0];
          if (!top) return;
          const i = yield* chooseOption(e, p, `The top card is ${top.name}`, ['Leave it on top', 'Put it at the bottom']);
          if (i === 1) {
            const d = e.player(other(p)).deck;
            d.push(d.shift()!);
            e.log(p, 'Chick the Yellow puts the top card at the bottom of the Deck');
          }
        },
      },
    ]),
  };
  E['Dark Scorpion - Cliff the Trap Remover'] = {
    onBattleDamage: battleChoice([
      {
        label: 'Destroy 1 Spell/Trap on the field',
        can: (e) => allST(e).length > 0,
        *run(e, p) {
          const c = yield* pickOne(e, p, 'Cliff the Trap Remover: destroy which Spell/Trap?', allST(e));
          if (c) yield* e.destroy([c.uid]);
        },
      },
      {
        label: "Send the top 2 cards of your opponent's Deck to the GY",
        can: oppDeckHas(1),
        *run(e, p) {
          yield* millTop(e, other(p), 2);
        },
      },
    ]),
  };
  E['Dark Scorpion - Gorg the Strong'] = {
    onBattleDamage: battleChoice([
      {
        label: "Return 1 of your opponent's monsters to the top of the Deck",
        can: (e, p) => targetable(e, e.monsters(other(p))).length > 0,
        *run(e, p) {
          const c = yield* pickOne(e, p, 'Gorg the Strong: return which monster?', targetable(e, e.monsters(other(p))));
          if (c && e.fieldCard(c.uid)) yield* intoDeck(e, c.uid, 'top');
        },
      },
      {
        label: "Send the top card of your opponent's Deck to the GY",
        can: oppDeckHas(1),
        *run(e, p) {
          yield* millTop(e, other(p), 1);
        },
      },
    ]),
  };
  E['Dark Scorpion - Meanae the Thorn'] = {
    onBattleDamage: battleChoice([
      {
        label: 'Add 1 "Dark Scorpion" card from your Deck to your hand',
        can: (e, p) => e.player(p).deck.some((c) => named(c, 'Dark Scorpion')),
        *run(e, p) {
          yield* searchDeck(e, p, 'Meanae the Thorn: add which "Dark Scorpion" card?', (c) => named(c, 'Dark Scorpion'));
        },
      },
      {
        label: 'Add 1 "Dark Scorpion" card from your GY to your hand',
        can: (e, p) => e.player(p).gy.some((c) => named(c, 'Dark Scorpion')),
        *run(e, p) {
          const c = yield* pickOne(e, p, 'Meanae the Thorn: add which "Dark Scorpion" card?', e.player(p).gy.filter((c) => named(c, 'Dark Scorpion')));
          if (c) e.toHandOf(c.uid, p);
        },
      },
    ]),
  };
  E['Don Zaloog'] = {
    onBattleDamage: battleChoice([
      {
        label: "Discard 1 random card from your opponent's hand",
        can: (e, p) => e.player(other(p)).hand.length > 0,
        *run(e, p) {
          yield* randomDiscard(e, other(p));
        },
      },
      {
        label: "Send the top 2 cards of your opponent's Deck to the GY",
        can: oppDeckHas(1),
        *run(e, p) {
          yield* millTop(e, other(p), 2);
        },
      },
    ]),
  };

  // Its once-per-turn effect is used in your Main Phase (like an ignition effect).
  E['Dark Smog'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    ignition: {
      can: (e, _m, p) => e.player(other(p)).gy.some((c) => isMonster(e, c)) && e.player(p).hand.some((c) => isMonster(e, c) && raceOf(e, c) === 'Fiend'),
      *run(e, _m, p) {
        const t = yield* pickOne(e, p, 'Dark Smog: banish which monster from the opponent\'s GY?', e.player(other(p)).gy.filter((c) => isMonster(e, c)), true);
        if (!t) return;
        if (!(yield* discardCost(e, p, 1, (c) => isMonster(e, c) && raceOf(e, c) === 'Fiend'))) return;
        if (e.find(t.uid)?.loc.zone === 'gy') e.banish(t.uid);
      },
    },
  };

  const BOARD = ['Spirit Message "I"', 'Spirit Message "N"', 'Spirit Message "A"', 'Spirit Message "L"'];
  const boardCard = (c: Card) => c.name === 'Destiny Board' || BOARD.includes(c.name);
  const masteryAdd = (e: Engine, c: Card) => c.name === 'Destiny Board' || (isMonster(e, c) && levelOf(e, c) === 8 && raceOf(e, c) === 'Fiend');
  E["Dark Spirit's Mastery"] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p) && e.player(p).hand.some((x) => x.uid !== c.uid) && [...e.player(p).deck, ...e.player(p).gy].some((x) => masteryAdd(e, x)),
    *activate(e, link, p) {
      if (!(yield* discardCost(e, p, 1, () => true, link.card.uid))) return false;
      e.useOnce(link.card.name, p);
    },
    *resolve(e, _l, p) {
      const c = yield* pickOne(e, p, "Dark Spirit's Mastery: add which card?", [...e.player(p).deck, ...e.player(p).gy].filter((x) => masteryAdd(e, x)));
      if (!c) return;
      const fromDeck = e.find(c.uid)?.loc.zone === 'deck';
      e.toHandOf(c.uid, p);
      e.log(p, `${e.player(p).name} adds ${c.name} to the hand`);
      if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
    },
    *onSentToGrave(e, card) {
      fxMap(e, 'masterySent')[card.uid] = e.state.turn;
    },
    graveIgnition: {
      can: (e, card, p) => fxMap(e, 'masterySent')[card.uid] !== e.state.turn && e.oncePerTurn(`${card.name}:gy`, p) && [...e.player(p).hand, ...e.player(p).gy].some((c) => c.uid !== card.uid && boardCard(c)),
      *run(e, card, p) {
        const list = [...e.player(p).hand, ...e.player(p).gy].filter((c) => c.uid !== card.uid && boardCard(c));
        const chosen = yield* pick(e, p, "Dark Spirit's Mastery: place which cards (different names) at the bottom of the Deck?", list, 1, list.length, true);
        if (!chosen || new Set(chosen.map((c) => c.name)).size !== chosen.length) return;
        e.useOnce(`${card.name}:gy`, p);
        e.banish(card.uid);
        for (const c of chosen) yield* intoDeck(e, c.uid, 'bottom');
        e.draw(p, chosen.length);
      },
    },
  };

  const LORDS = ['Uria, Lord of Searing Flames', 'Hamon, Lord of Striking Thunder', 'Raviel, Lord of Phantasms'];
  E['Dark Summoning Beast'] = {
    ignition: {
      can: (e, m, p) => e.oncePerTurn(m.name, p) && [...e.player(p).hand, ...e.player(p).deck].some((c) => LORDS.includes(c.name)),
      *run(e, m, p) {
        e.useOnce(m.name, p);
        if (!e.fieldCard(m.uid)) return;
        e.log(p, `${e.player(p).name} Tributes Dark Summoning Beast`);
        yield* e.sendToGrave(m.uid, 'tribute');
        yield* summonOneOf(e, p, 'Dark Summoning Beast: Special Summon which Sacred Beast?', [...e.player(p).hand, ...e.player(p).deck].filter((c) => LORDS.includes(c.name)), 'atk');
        for (const x of e.monsters(p)) tag(x).noAttackTurn = e.state.turn;
      },
    },
    graveIgnition: {
      can: (e, _c, p) => e.player(p).deck.some((c) => LORDS.includes(c.name)),
      *run(e, card, p) {
        e.banish(card.uid);
        yield* searchDeck(e, p, 'Dark Summoning Beast: add which Sacred Beast?', (c) => LORDS.includes(c.name));
      },
    },
  };

  const setCards = (e: Engine, self?: number) => [...allMonsters(e), ...allST(e)].filter((c) => !c.faceUp && c.uid !== self && !e.untargetable(c));
  E['Dark World Lightning'] = {
    canActivate: (e, c, _p, t) => isMain(t) && setCards(e, c.uid).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Dark World Lightning: destroy which Set card?', setCards(e, link.card.uid), true);
      if (!c) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      const c = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!c || c.faceUp) return;
      yield* e.destroy([c.uid]);
      const d = yield* pickOne(e, p, 'Dark World Lightning: discard 1 card', e.player(p).hand.slice());
      if (d) yield* e.discard(p, d.uid);
    },
  };

  const darklords = (e: Engine, list: Card[]) => monsterIn(e, list, (c) => named(c, 'Darklord'));
  const contactList = (e: Engine, p: Pid) => darklords(e, e.player(p).gy).filter((c) => !isExtraOrRitual(e, c));
  E['Darklord Contact'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p) && freeMZ(e, p) && contactList(e, p).length > 0,
    *activate(e, link, p) {
      if (!(link.payload as { copied?: boolean } | undefined)?.copied) e.useOnce(link.card.name, p);
    },
    *resolve(e, _l, p) {
      yield* summonOneOf(e, p, 'Darklord Contact: Special Summon which Darklord?', contactList(e, p), 'def');
    },
  };
  const enchantCost = (e: Engine, p: Pid) => [...darklords(e, e.player(p).hand), ...darklords(e, faceUpMonsters(e, p))];
  E['Darklord Enchantment'] = {
    canActivate: (e, c, p, t) => anyTime(t) && e.oncePerTurn(c.name, p) && enchantCost(e, p).length > 0 && faceUpMonsters(e, other(p)).length > 0,
    *activate(e, link, p) {
      if ((link.payload as { copied?: boolean } | undefined)?.copied) return;
      const c = yield* pickOne(e, p, 'Darklord Enchantment: send which Darklord to the GY?', enchantCost(e, p), true);
      if (!c) return false;
      e.useOnce(link.card.name, p);
      yield* e.sendToGrave(c.uid, 'cost');
    },
    *resolve(e, _l, p) {
      if (!freeMZ(e, p)) return;
      const m = yield* pickOne(e, p, 'Darklord Enchantment: take control of which monster?', faceUpMonsters(e, other(p)));
      if (m && e.takeControl(m.uid, p)) {
        m.returnAtEnd = other(p);
        e.log(p, `${e.player(p).name} takes control of ${m.name} until the End Phase`);
      }
    },
  };
  const nastenTargets = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => named(c, 'Darklord') && !isMonster(e, c) && canApply(e, p, c));
  E['Darklord Nasten'] = {
    handIgnition: {
      can: (e, c, p) => freeMZ(e, p) && e.oncePerTurn('Darklord Nasten:ss', p) && e.player(p).hand.filter((x) => x.uid !== c.uid && named(x, 'Darklord')).length >= 2,
      *run(e, card, p) {
        if (!(yield* discardCost(e, p, 2, (x) => named(x, 'Darklord'), card.uid))) return;
        e.useOnce('Darklord Nasten:ss', p);
        yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
    quick: {
      label: 'pay 1000 LP and apply a Darklord Spell/Trap',
      can: (e, c, p) => e.oncePerTurn(c.name, p) && e.player(p).lp > 1000 && nastenTargets(e, p).length > 0,
      *cost(e, card, p, link) {
        const t = yield* pickOne(e, p, 'Darklord Nasten: apply which Darklord Spell/Trap?', nastenTargets(e, p), true);
        if (!t || !payLp(e, p, 1000)) return false;
        e.useOnce(card.name, p);
        link.targetUid = t.uid;
      },
      *run(e, _card, p, link) {
        const t = link.targetUid !== undefined ? e.find(link.targetUid) : null;
        if (!t || t.loc.zone !== 'gy') return;
        yield* applyEffect(e, p, t.card);
        if (e.find(t.card.uid)?.loc.zone === 'gy') yield* intoDeck(e, t.card.uid, 'shuffle');
      },
    },
  };

  // The Fusion Materials are the ones recorded for its Fusion Summon, or else the ones named on it.
  E['De-Fusion'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && targetable(e, faceUpMonsters(e)).some((m) => isFusion(e, m)),
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'De-Fusion: return which Fusion Monster?', targetable(e, faceUpMonsters(e)).filter((m) => isFusion(e, m)), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m) return;
      const recorded = (fx(e).fusionMatList?.[m.uid] ?? null) as number[] | null;
      const ids = e.fusionMaterials(m.name);
      yield* dropEquips(e, m.uid);
      toExtra(e, m.uid);
      const gy = e.player(p).gy;
      let mats: Card[] = [];
      if (recorded) mats = recorded.map((u) => gy.find((c) => c.uid === u)).filter((c): c is Card => !!c);
      else if (ids) {
        for (const id of ids) {
          const c = gy.find((x) => info(e, x).id === id && !mats.includes(x));
          if (c) mats.push(c);
        }
      }
      const need = recorded ? recorded.length : ids?.length ?? 0;
      if (!need || mats.length !== need || e.player(p).mz.filter((z) => z === null).length < need) return;
      if (!(yield* e.yesno(p, `De-Fusion: Special Summon ${mats.map((c) => c.name).join(' and ')} from your GY?`))) return;
      for (const c of mats) if (e.find(c.uid)?.loc.zone === 'gy') yield* e.specialSummon(c.uid, p, 'atk');
    },
  };

  E['Decayed Commander'] = {
    *onSummon(e, _m, p, kind) {
      const tigers = e.player(p).hand.filter((c) => c.name === 'Zombie Tiger');
      if (kind !== 'normal' || !tigers.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Decayed Commander: Special Summon Zombie Tiger from your hand?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which Zombie Tiger?', tigers, 'atk');
    },
    *onBattleDamage(e, _m, p) {
      if (e.state.battle?.target === null) yield* randomDiscard(e, other(p));
    },
  };

  E['Dekoichi the Battlechanted Locomotive'] = {
    *flip(e, _m, p) {
      e.draw(p, 1 + faceUpMonsters(e, p).filter((m) => m.name === 'Bokoichi the Freightening Car').length);
    },
  };

  const magnet = (e: Engine, c: Card) => isMonster(e, c) && named(c, 'Magnet Warrior') && levelOf(e, c) <= 4;
  const deltaSummon = function* (e: Engine, p: Pid): Step {
    if (!e.oncePerTurn('Delta The Magnet Warrior:1', p) || !e.player(p).deck.some((c) => magnet(e, c))) return;
    if (!(yield* e.yesno(p, 'Delta The Magnet Warrior: send a "Magnet Warrior" from your Deck to the GY?'))) return;
    e.useOnce('Delta The Magnet Warrior:1', p);
    yield* deckToGrave(e, p, 'Send which "Magnet Warrior"?', (c) => magnet(e, c));
  };
  E['Delta The Magnet Warrior'] = {
    *onSummon(e, _m, p, kind) {
      if (kind === 'normal') yield* deltaSummon(e, p);
    },
    *onSpecialSummon(e, _m, p) {
      yield* deltaSummon(e, p);
    },
    *onSentToGrave(e, card, p) {
      const ps = e.player(p);
      const fodder = ps.gy.filter((c) => magnet(e, c) && c.name !== card.name);
      const valk = [...ps.hand, ...ps.deck].filter((c) => c.name === 'Valkyrion the Magna Warrior');
      if (!e.oncePerTurn('Delta The Magnet Warrior:2', p) || fodder.length < 3 || !valk.length || !freeMZ(e, p)) return;
      if (!(yield* e.yesno(p, 'Delta The Magnet Warrior: banish 3 "Magnet Warrior" monsters to Special Summon Valkyrion?'))) return;
      const cost = yield* pick(e, p, 'Banish which 3 "Magnet Warrior" monsters?', fodder, 3, 3, true);
      if (!cost) return;
      e.useOnce('Delta The Magnet Warrior:2', p);
      for (const c of cost) e.banish(c.uid);
      yield* summonOneOf(e, p, 'Special Summon which Valkyrion?', valk.filter((c) => e.find(c.uid)), 'atk');
    },
  };

  // Only the second effect: Union monsters cannot be equipped in this game.
  E['Delta Tri'] = {
    *afterBattle(e, _me, target, p, destroyed) {
      if (!destroyed || target.owner === p) return;
      const list = faceUpMonsters(e, p).filter((m) => attrOf(e, m) === 'LIGHT' && raceOf(e, m) === 'Machine');
      const m = yield* pickOne(e, p, 'Delta Tri: return which LIGHT Machine monster to the Deck?', list);
      if (!m) return;
      yield* intoDeck(e, m.uid, 'shuffle');
      e.draw(p, 1);
    },
  };

  E['Des Feral Imp'] = {
    *flip(e, _m, p) {
      const c = yield* pickOne(e, p, 'Des Feral Imp: shuffle which card from your GY into the Deck?', e.player(p).gy.slice());
      if (c) yield* intoDeck(e, c.uid, 'shuffle');
    },
  };

  E['Des Kangaroo'] = {
    *onAttacked(e, me, attacker, p) {
      if (me.pos !== 'def' || !e.fieldCard(attacker.uid) || e.controller(attacker.uid) === p) return;
      if (e.atkOf(attacker) < e.defOf(me)) {
        e.log(p, `Des Kangaroo destroys ${attacker.name}`);
        yield* e.destroy([attacker.uid]);
      }
    },
  };

  E['Des Koala'] = {
    *flip(e, _m, p) {
      e.damage(other(p), 400 * e.player(other(p)).hand.length);
    },
  };

  E['Des Lacooda'] = {
    ignition: {
      can: (_e, m) => m.faceUp,
      *run(e, m) {
        if (!m.faceUp || !e.fieldCard(m.uid)) return;
        m.faceUp = false;
        m.pos = 'def';
        e.event('position', { uid: m.uid });
        e.log(null, 'Des Lacooda is turned face-down');
      },
    },
    *onSummon(e, _m, p, kind) {
      if (kind === 'flip') e.draw(p, 1);
    },
  };

  const windEarth = (e: Engine, p: Pid, a: string) => e.player(p).gy.filter((c) => isMonster(e, c) && attrOf(e, c) === a);
  E['Desert Twister'] = {
    cannotNormalSummon: true,
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && windEarth(e, p, 'WIND').length >= 2 && windEarth(e, p, 'EARTH').length >= 1,
      *run(e, card, p) {
        const w = yield* pick(e, p, 'Desert Twister: banish 2 WIND monsters', windEarth(e, p, 'WIND'), 2, 2, true);
        if (!w) return;
        const ea = yield* pickOne(e, p, 'Desert Twister: banish 1 EARTH monster', windEarth(e, p, 'EARTH'), true);
        if (!ea) return;
        for (const c of [...w, ea]) e.banish(c.uid);
        yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
    ignition: {
      can: (e, _m, p) => e.player(p).hand.length > 0 && allST(e).length > 0,
      *run(e, _m, p) {
        if (!allST(e).length || !(yield* discardCost(e, p, 1))) return;
        const c = yield* pickOne(e, p, 'Desert Twister: destroy which Spell/Trap?', allST(e));
        if (c) yield* e.destroy([c.uid]);
      },
    },
  };

  const despair = function* (e: Engine, card: Card, owner: Pid): Step {
    if (e.find(card.uid)?.loc.zone !== 'gy' || !freeMZ(e, owner)) return;
    e.log(owner, 'Despair from the Dark rises');
    yield* e.specialSummon(card.uid, owner, 'atk');
  };
  E['Despair from the Dark'] = {
    *onDiscarded(e, card, owner, byOpp) {
      if (byOpp) yield* despair(e, card, owner);
    },
    *onMilledByOpponent(e, card, owner) {
      yield* despair(e, card, owner);
    },
  };

  // Spirit Message cards are not in the Speed Duel pool; the placing and the win still work if they ever are.
  E['Destiny Board'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    *onEndPhase(e, board, p) {
      if (e.state.turnPlayer === p || !e.fieldCard(board.uid)) return;
      const have = new Set(stOf(e, p).map((c) => c.name));
      const next = BOARD.find((n) => !have.has(n));
      if (next) {
        const c = [...e.player(p).hand, ...e.player(p).deck].find((x) => x.name === next);
        if (c && placeFaceUp(e, p, c.uid) && e.find(c.uid)?.loc.zone !== 'hand') e.player(p).deck = e.shuffle(e.player(p).deck);
      }
      const now = new Set(stOf(e, p).filter((c) => c.faceUp).map((c) => c.name));
      if (now.has('Destiny Board') && BOARD.every((n) => now.has(n))) e.endDuel(p, 'Destiny Board spells F-I-N-A-L!');
    },
    *onLeaveField(e, _fc, p) {
      for (const c of stOf(e, p).filter((x) => BOARD.includes(x.name))) yield* e.sendToGrave(c.uid, 'used');
    },
  };

  E['Destiny End Dragoon'] = {
    ignition: {
      can: (e, _m, p) => targetable(e, e.monsters(other(p))).length > 0,
      *run(e, m, p) {
        const t = yield* pickOne(e, p, 'Destiny End Dragoon: destroy which monster?', targetable(e, e.monsters(other(p))));
        for (const x of e.monsters(p)) tag(x).noAttackTurn = e.state.turn;
        if (!t || !e.fieldCard(t.uid)) return;
        const atk = t.faceUp ? e.atkOf(t) : 0;
        yield* e.destroy([t.uid]);
        if (atk && !e.fieldCard(t.uid)) e.damage(other(p), atk);
      },
    },
    *onStandbyInGrave(e, card, p) {
      const fodder = e.player(p).gy.filter((c) => dhero(c) && c.uid !== card.uid);
      if (!fodder.length || !freeMZ(e, p) || !e.oncePerTurn(card.name, p) || !(yield* e.yesno(p, 'Destiny End Dragoon: banish a "Destiny HERO" card from your GY to Special Summon it?'))) return;
      const c = yield* pickOne(e, p, 'Banish which "Destiny HERO" card?', fodder, true);
      if (!c) return;
      e.useOnce(card.name, p);
      e.banish(c.uid);
      yield* e.specialSummon(card.uid, p, 'atk');
    },
  };

  E['Destiny HERO - Blade Master'] = {
    quick: {
      from: 'hand',
      label: 'discard it: your "Destiny HERO" monsters gain 800 ATK',
      can: (e, _c, p) => e.state.phase === 'BP' && e.state.turnPlayer === other(p) && faceUpMonsters(e, p).some(dhero),
      *cost(e, card, p) {
        yield* e.discard(p, card.uid);
      },
      *run(e, _c, p) {
        for (const m of faceUpMonsters(e, p).filter(dhero)) m.atkMod += 800;
        e.log(p, '"Destiny HERO" monsters gain 800 ATK');
      },
    },
  };

  // Moves to Defense Position right after its attack; the Draw Phase revival is checked in the Standby Phase.
  const dasherDown = (e: Engine, m: FieldCard) => {
    if (e.fieldCard(m.uid) && m.pos === 'atk') {
      m.pos = 'def';
      e.event('position', { uid: m.uid });
      e.log(null, 'Destiny HERO - Dasher changes to Defense Position');
    }
  };
  E['Destiny HERO - Dasher'] = {
    ignition: {
      can: (e, m, p) => e.monsters(p).some((x) => x.uid !== m.uid),
      *run(e, m, p) {
        if (!(yield* tributeCost(e, p, 1, () => true, m.uid))) return;
        if (e.fieldCard(m.uid)) m.atkMod += 1000;
      },
    },
    *afterBattle(e, m) {
      dasherDown(e, m);
    },
    *onBattleDamage(e, m) {
      if (e.state.battle?.target === null) dasherDown(e, m);
    },
    *onStandbyInGrave(e, card, p) {
      const ps = e.player(p);
      const drawn = ps.hand[ps.hand.length - 1];
      const skipped = e.state.log.some((l) => l.turn === e.state.turn && l.text.includes('Draw Phase is skipped'));
      if (skipped || !drawn || !isMonster(e, drawn) || isExtraOrRitual(e, drawn) || !freeMZ(e, p) || !e.oncePerDuel(`dasher:${card.uid}`, p)) return;
      if (!(yield* e.yesno(p, `Destiny HERO - Dasher: reveal ${drawn.name} you drew and Special Summon it?`))) return;
      e.useOncePerDuel(`dasher:${card.uid}`, p);
      yield* e.specialSummon(drawn.uid, p, 'atk');
    },
  };

  // The Spell sent to the GY is applied with Diamond Dude's own effect (on the field or from the GY) next turn.
  type DudeRec = { uid: number; turn: number };
  const dudeRecs = (e: Engine, p: Pid): DudeRec[] => ((fx(e).diamondDude ??= [[], []]) as DudeRec[][])[p];
  const dudeReady = (e: Engine, p: Pid) => dudeRecs(e, p).filter((r) => r.turn + 2 === e.state.turn && e.find(r.uid)?.loc.zone === 'gy' && canApply(e, p, e.find(r.uid)!.card));
  const dudeApply = function* (e: Engine, p: Pid): Step {
    const ready = dudeReady(e, p);
    const c = yield* pickOne(e, p, 'Diamond Dude: apply which Spell?', ready.map((r) => e.find(r.uid)!.card), true);
    if (!c) return;
    fx(e).diamondDude[p] = dudeRecs(e, p).filter((r) => r.uid !== c.uid);
    yield* applyEffect(e, p, c, false);
  };
  E['Destiny HERO - Diamond Dude'] = {
    ignition: {
      repeat: true,
      can: (e, m, p) => (m.tags?.dudeTurn !== e.state.turn && e.player(p).deck.length > 0) || dudeReady(e, p).length > 0,
      *run(e, m, p) {
        const canDig = m.tags?.dudeTurn !== e.state.turn && e.player(p).deck.length > 0;
        const ready = dudeReady(e, p).length > 0;
        const i = canDig && ready ? yield* chooseOption(e, p, 'Diamond Dude', ['Excavate the top card', 'Apply the Spell excavated last turn']) : canDig ? 0 : 1;
        if (i === 1) return yield* dudeApply(e, p);
        if (i !== 0) return;
        tag(m).dudeTurn = e.state.turn;
        const top = e.player(p).deck[0];
        if (!top) return;
        e.log(p, `Diamond Dude excavates ${top.name}`);
        if (isSpell(e, top) && info(e, top).sub === 'Normal') {
          yield* e.sendToGrave(top.uid, 'mill');
          dudeRecs(e, p).push({ uid: top.uid, turn: e.state.turn });
        } else {
          const d = e.player(p).deck;
          d.push(d.shift()!);
        }
      },
    },
    graveIgnition: {
      can: (e, _c, p) => dudeReady(e, p).length > 0,
      *run(e, _c, p) {
        yield* dudeApply(e, p);
      },
    },
  };

  E['Destiny HERO - Dogma'] = {
    cannotNormalSummon: true,
    summonProc: {
      can: (e, _c, p) => e.monsters(p).length >= 3 && e.monsters(p).some((m) => m.faceUp && dhero(m)),
      *run(e, card, p) {
        const ms = yield* pick(e, p, 'Destiny HERO - Dogma: Tribute 3 monsters, including a "Destiny HERO"', e.monsters(p), 3, 3, true);
        if (!ms || !ms.some((m) => m.faceUp && dhero(m))) return;
        for (const m of ms) yield* e.sendToGrave(m.uid, 'tribute');
        yield* e.specialSummon(card.uid, p, 'atk');
        const me = e.fieldCard(card.uid);
        if (me) tag(me).dogmaTurn = e.state.turn;
      },
    },
    *onStandby(e, m, p) {
      if (e.state.turnPlayer !== other(p) || m.tags?.dogmaTurn !== e.state.turn - 1) return;
      const ps = e.player(other(p));
      const half = Math.ceil(ps.lp / 2);
      e.log(p, `Destiny HERO - Dogma halves ${ps.name}'s LP`);
      ps.lp = half;
      e.event('damage', { player: other(p), amount: half });
    },
  };

  E['Destiny HERO - Fear Monger'] = {
    *onDestroyed(e, card, _p, byBattle) {
      if (byBattle) fxMap(e, 'fearMonger')[card.uid] = e.state.turn;
    },
    *onStandbyInGrave(e, card, p) {
      const k = fxMap(e, 'fearMonger')[card.uid];
      if (k === undefined || k >= e.state.turn) return;
      delete fxMap(e, 'fearMonger')[card.uid];
      const list = e.player(p).gy.filter((c) => isMonster(e, c) && dhero(c) && c.name !== card.name && !isExtraOrRitual(e, c));
      yield* summonOneOf(e, p, 'Destiny HERO - Fear Monger: Special Summon which "Destiny HERO"?', list, 'atk');
    },
  };

  E['Destiny HERO - Malicious'] = {
    graveIgnition: {
      can: (e, c, p) => freeMZ(e, p) && e.player(p).deck.some((x) => x.name === c.name),
      *run(e, card, p) {
        e.banish(card.uid);
        yield* summonOneOf(e, p, 'Special Summon which Destiny HERO - Malicious?', e.player(p).deck.filter((x) => x.name === card.name), 'atk');
      },
    },
  };

  // Negation is applied when Plasma arrives, to each monster the opponent Summons afterwards, and at each Standby Phase.
  const plasmaNegate = (e: Engine, plasma: FieldCard, p: Pid) => {
    for (const m of allMonsters(e)) {
      if (m.tags?.plasmaBy === plasma.uid && ctrl(e, m) === p) {
        delete m.tags.plasmaBy;
        delete m.tags.negated;
      }
    }
    for (const m of faceUpMonsters(e, other(p))) {
      if (m.tags?.negated) continue;
      tag(m).negated = 1;
      tag(m).plasmaBy = plasma.uid;
    }
  };
  const plasmaEquip = (e: Engine, m: FieldCard) => m.equips.map((u) => e.fieldCard(u)).find((x) => !!x && x.tags?.plasmaEq === 1) ?? null;
  E['Destiny HERO - Plasma'] = {
    cannotNormalSummon: true,
    summonProc: {
      can: (e, _c, p) => e.monsters(p).length >= 3,
      *run(e, card, p) {
        if (!(yield* tributeCost(e, p, 3))) return;
        yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
    *onSpecialSummon(e, m, p) {
      plasmaNegate(e, m, p);
    },
    *onAnySummon(e, w, wc, m, controller) {
      if (controller !== wc && m.faceUp && !m.tags?.negated) {
        tag(m).negated = 1;
        tag(m).plasmaBy = w.uid;
      }
    },
    *onStandby(e, m, p) {
      plasmaNegate(e, m, p);
    },
    *onLeaveField(e, fc) {
      for (const m of allMonsters(e)) {
        if (m.tags?.plasmaBy === fc.uid) {
          delete m.tags.plasmaBy;
          delete m.tags.negated;
        }
      }
    },
    selfBonus(e, m) {
      const eq = plasmaEquip(e, m);
      return { atk: eq ? Math.floor(Math.max(0, info(e, eq).atk ?? 0) / 2) : 0, def: 0 };
    },
    ignition: {
      can: (e, m, p) => !plasmaEquip(e, m) && freeST(e, p) >= 0 && targetable(e, e.monsters(other(p))).length > 0,
      *run(e, m, p) {
        if (plasmaEquip(e, m)) return;
        const t = yield* pickOne(e, p, 'Destiny HERO - Plasma: equip which monster to it?', targetable(e, e.monsters(other(p))));
        if (!t) return;
        const f = e.find(t.uid);
        const z = freeST(e, p);
        if (!f || f.loc.zone !== 'mz' || f.loc.player === p || z < 0 || !e.fieldCard(m.uid)) return;
        yield* dropEquips(e, t.uid);
        e.player(f.loc.player).mz[f.loc.index] = null;
        Object.assign(t, { faceUp: true, pos: 'atk', equippedTo: m.uid, active: false, atkMod: 0, defMod: 0, equips: [], counters: 0, tags: { plasmaEq: 1 }, returnAtEnd: undefined });
        e.player(p).sz[z] = t;
        m.equips.push(t.uid);
        e.event('to-gy', { uid: t.uid, player: p });
        e.log(p, `${t.name} is equipped to Destiny HERO - Plasma`);
      },
    },
  };

  E['Destiny Signal'] = {
    canActivate: (e, _c, p, t, ctx) => t === 'destroyed' && ctx.prevController === p && ctx.uid !== undefined && e.find(ctx.uid)?.loc.zone === 'gy' && freeMZ(e, p) && [...e.player(p).hand, ...e.player(p).deck].some((c) => isMonster(e, c) && dhero(c) && levelOf(e, c) <= 4),
    *resolve(e, _l, p) {
      yield* summonOneOf(e, p, 'Destiny Signal: Special Summon which "Destiny HERO"?', [...e.player(p).hand, ...e.player(p).deck].filter((c) => isMonster(e, c) && dhero(c) && levelOf(e, c) <= 4), 'atk');
    },
  };

  E['Destroyersaurus'] = {
    handIgnition: {
      can: (e, _c, p) => e.player(p).deck.some((c) => c.name === 'Jurassic World'),
      *run(e, card, p) {
        yield* e.discard(p, card.uid);
        yield* searchDeck(e, p, 'Destroyersaurus: add Jurassic World', (c) => c.name === 'Jurassic World');
      },
    },
  };

  const bbPool = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.monsters(p), ...e.monsters(other(p))];
  const bbPlans = (e: Engine, p: Pid) => fusionPlansFrom(e, p, bbPool(e, p), (f) => (e.fusionMaterials(f.name) ?? []).includes(info(e, 'Buster Blader').id));
  E['Destruction Swordsman Fusion'] = {
    canActivate: (e, c, p, t) => anyTime(t) && e.oncePerTurn(c.name, p) && bbPlans(e, p).length > 0,
    *activate(e, link, p) {
      const c = yield* chooseFusion(e, p, 'Destruction Swordsman Fusion', bbPlans(e, p));
      if (!c) return false;
      e.useOnce(link.card.name, p);
      link.payload = c;
    },
    *resolve(e, link, p) {
      yield* doFusion(e, p, link.payload as { fusion: number; mats: number[] }, 'grave');
    },
    graveIgnition: {
      can: (e, c, p) => e.oncePerTurn(`${c.name}:gy`, p) && e.player(p).hand.length > 0,
      *run(e, card, p) {
        const c = yield* pickOne(e, p, 'Destruction Swordsman Fusion: send which card from your hand to the GY?', e.player(p).hand.slice(), true);
        if (!c) return;
        e.useOnce(`${card.name}:gy`, p);
        yield* e.sendToGrave(c.uid, 'cost');
        if (e.find(card.uid)?.loc.zone === 'gy') e.toHandOf(card.uid, p);
      },
    },
  };

  const oppSetST = (e: Engine, p: Pid) => stOf(e, other(p)).filter((c) => !c.faceUp);
  E['Destructotron'] = {
    *onEndPhase(e, m, p) {
      if (faceUpMonsters(e, p).filter((x) => raceOf(e, x) === 'Psychic').length === 1 && raceOf(e, m) === 'Psychic') {
        e.log(p, 'Destructotron destroys itself');
        yield* e.destroy([m.uid]);
      }
    },
    ignition: {
      repeat: true,
      can: (e, _m, p) => e.player(p).lp > 1000 && oppSetST(e, p).length > 0,
      *run(e, _m, p) {
        if (!oppSetST(e, p).length || !payLp(e, p, 1000)) return;
        const c = yield* pickOne(e, p, 'Destructotron: destroy which Set Spell/Trap?', oppSetST(e, p));
        if (c) yield* e.destroy([c.uid]);
      },
    },
  };

  E['Dicephoon'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve(e, link, p) {
      const r = e.roll(6);
      e.log(p, `Dicephoon rolls a ${r}`);
      if (r === 1 || r === 6) return e.damage(p, 1000);
      const n = r === 5 ? 2 : 1;
      const list = allST(e).filter((c) => c.uid !== link.card.uid);
      const cs = yield* pick(e, p, `Dicephoon: destroy ${n} Spell/Trap card(s)`, list, Math.min(n, list.length), n);
      if (cs?.length) yield* e.destroy(cs.map((c) => c.uid));
    },
  };

  // The banished card comes back when the Capsule is in the GY at your 2nd Standby Phase after activation.
  E['Different Dimension Capsule'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).deck.length > 0,
    *resolve(e, link, p) {
      const c = yield* pickOne(e, p, 'Different Dimension Capsule: banish which card from your Deck?', e.player(p).deck.slice());
      if (!c) return;
      e.banish(c.uid);
      e.player(p).deck = e.shuffle(e.player(p).deck);
      (fx(e).ddCapsule ??= {})[link.card.uid] = { uid: c.uid, turn: e.state.turn };
    },
    *onStandbyInGrave(e, card, p) {
      const rec = fx(e).ddCapsule?.[card.uid] as { uid: number; turn: number } | undefined;
      if (!rec || e.state.turn < rec.turn + 4) return;
      delete fx(e).ddCapsule[card.uid];
      if (e.find(rec.uid)?.loc.zone === 'removed') {
        e.toHandOf(rec.uid, p);
        e.log(p, `${e.player(p).name} adds the card banished by Different Dimension Capsule to the hand`);
      }
    },
  };

  const banishedMons = (e: Engine, p: Pid) => e.player(p).removed.filter((c) => isMonster(e, c) && !isExtraOrRitual(e, c));
  E['Different Dimension Encounter'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && ([0, 1] as Pid[]).every((q) => banishedMons(e, q).length > 0 && freeMZ(e, q)),
    *resolve(e, _l, p) {
      for (const q of [p, other(p)]) {
        const c = yield* pickOne(e, q, 'Different Dimension Encounter: Special Summon which banished monster?', banishedMons(e, q));
        if (c && freeMZ(e, q)) yield* e.specialSummon(c.uid, q, 'def', false);
      }
    },
  };

  type GateRec = { uid: number; ctl: Pid; pos: 'atk' | 'def'; faceUp: boolean }[];
  E['Different Dimension Gate'] = {
    canActivate: (e, _c, p, t) => isMain(t) && targetable(e, e.monsters(p)).length > 0 && targetable(e, e.monsters(other(p))).length > 0,
    *activate(e, link, p) {
      const a = yield* pickOne(e, p, 'Different Dimension Gate: target your monster', targetable(e, e.monsters(p)), true);
      if (!a) return false;
      const b = yield* pickOne(e, p, "Different Dimension Gate: target your opponent's monster", targetable(e, e.monsters(other(p))), true);
      if (!b) return false;
      link.payload = [a.uid, b.uid];
    },
    *resolve(e, link) {
      const rec: GateRec = [];
      for (const u of link.payload as number[]) {
        const m = e.fieldCard(u);
        const c = e.controller(u);
        if (!m || c === null) continue;
        rec.push({ uid: u, ctl: c, pos: m.pos, faceUp: m.faceUp });
        yield* dropEquips(e, u);
        e.banish(u);
      }
      (fx(e).ddGate ??= {})[link.card.uid] = rec;
    },
    *onSentToGrave(e, card, _p, from, reason) {
      const rec = fx(e).ddGate?.[card.uid] as GateRec | undefined;
      if (!rec) return;
      delete fx(e).ddGate[card.uid];
      if (reason !== 'destroyed' || from !== 'sz') return;
      for (const r of rec) if (e.find(r.uid)?.loc.zone === 'removed' && freeMZ(e, r.ctl)) yield* e.specialSummon(r.uid, r.ctl, r.pos, r.faceUp);
    },
  };

  E['Dimensional Alchemist'] = {
    ignition: {
      can: (e, _m, p) => e.player(p).deck.length > 0,
      *run(e, m, p) {
        const top = e.player(p).deck[0];
        if (!top) return;
        e.banish(top.uid);
        if (e.fieldCard(m.uid)) m.atkMod += 500;
      },
    },
    *onDestroyed(e, _c, p) {
      const list = e.player(p).removed.filter((c) => isMonster(e, c) && !isFusion(e, c));
      if (!list.length || !(yield* e.yesno(p, 'Dimensional Alchemist: add 1 of your banished monsters to your hand?'))) return;
      const c = yield* pickOne(e, p, 'Add which banished monster?', list);
      if (c) e.toHandOf(c.uid, p);
    },
  };

  const normalTraps = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isTrap(e, c) && info(e, c).sub === 'Normal');
  E['Diskblade Rider'] = {
    ignition: {
      can: (e, _m, p) => normalTraps(e, p).length > 0,
      *run(e, m, p) {
        const c = yield* pickOne(e, p, 'Diskblade Rider: banish which Normal Trap?', normalTraps(e, p));
        if (!c) return;
        e.banish(c.uid);
        if (e.fieldCard(m.uid)) tag(m).diskTurn = e.state.turn;
      },
    },
    selfBonus: (e, m) => ({ atk: m.tags?.diskTurn !== undefined && e.state.turn <= m.tags.diskTurn + 1 ? 500 : 0, def: 0 }),
  };

  // Its End Phase re-Set happens as soon as it is sent from the field to the GY (it cannot be activated again that turn).
  E['Disposable Learner Device'] = {
    ...h.equip((e, eq) => ({ atk: 200 * e.player(ctrl(e, eq)).gy.filter((c) => isMonster(e, c)).length, def: 0 })),
    canActivate: (e, c, _p, t) => isMain(t) && allMonsters(e).some((m) => m.faceUp) && !(fxMap(e, 'learnerSet')[c.uid] === e.state.turn && e.find(c.uid)?.loc.zone === 'sz'),
    *onSentToGrave(e, card, p, from) {
      const banishMe = fxMap(e, 'learnerBanish');
      if (banishMe[card.uid]) {
        delete banishMe[card.uid];
        if (from === 'sz') return e.banish(card.uid);
      }
      if (from !== 'sz' || !e.oncePerTurn(card.name, p) || freeST(e, p) < 0 || !(yield* e.yesno(p, 'Disposable Learner Device: Set it again (it is banished when it leaves the field)?'))) return;
      e.useOnce(card.name, p);
      const f = e.find(card.uid);
      if (!f || f.loc.zone !== 'gy') return;
      e.player(p).gy.splice(f.loc.index, 1);
      const z = freeST(e, p);
      e.player(p).sz[z] = { uid: card.uid, name: card.name, owner: card.owner, pos: 'atk', faceUp: false, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
      e.event('set', { uid: card.uid, player: p });
      e.log(p, `${e.player(p).name} Sets Disposable Learner Device`);
      banishMe[card.uid] = 1;
      fxMap(e, 'learnerSet')[card.uid] = e.state.turn;
    },
  };

  // "Special Summoned from the GY" is remembered from when it was last sent to the GY.
  const felgrandTargets = (e: Engine, p: Pid) => [...targetable(e, e.monsters(other(p))), ...e.player(other(p)).gy.filter((c) => isMonster(e, c))];
  E['Divine Dragon Lord Felgrand'] = {
    *onSentToGrave(e, card) {
      fxMap(e, 'felgrandGy')[card.uid] = 1;
    },
    *onSummon(e, m) {
      delete fxMap(e, 'felgrandGy')[m.uid];
    },
    *onSpecialSummon(e, m, p) {
      const fromGy = fxMap(e, 'felgrandGy')[m.uid];
      delete fxMap(e, 'felgrandGy')[m.uid];
      if (!fromGy || !felgrandTargets(e, p).length || !(yield* e.yesno(p, "Divine Dragon Lord Felgrand: banish a monster your opponent controls or in their GY?"))) return;
      const t = yield* pickOne(e, p, 'Banish which monster?', felgrandTargets(e, p));
      if (!t) return;
      const lv = levelOf(e, t);
      yield* dropEquips(e, t.uid);
      e.banish(t.uid);
      if (e.fieldCard(m.uid)) boostPermLocal(m, lv * 100);
    },
    *afterBattle(e, _me, target, p, destroyed) {
      const list = [...e.player(0).gy, ...e.player(1).gy].filter((c) => isMonster(e, c) && raceOf(e, c) === 'Dragon' && [7, 8].includes(levelOf(e, c)) && c.name !== 'Divine Dragon Lord Felgrand' && !isExtraOrRitual(e, c));
      if (!destroyed || target.owner === p || !list.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Divine Dragon Lord Felgrand: Special Summon a Level 7 or 8 Dragon from a GY?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which Dragon?', list, 'atk');
    },
  };
  const boostPermLocal = (m: FieldCard, n: number) => {
    tag(m).permAtk = (tag(m).permAtk ?? 0) + n;
    tag(m).permDef = (tag(m).permDef ?? 0) + n;
  };

  // The attacked monster's "attack directly next turn" is not supported.
  E['Doble Passe'] = {
    canActivate: (e, _c, p, t, ctx) => {
      if (opponentAttack(e, p, t, ctx) === null) return false;
      const tg = e.state.battle?.target;
      const m = tg !== null && tg !== undefined ? e.fieldCard(tg) : null;
      return !!m && e.controller(m.uid) === p && m.faceUp && m.pos === 'atk';
    },
    *activate(e, link) {
      link.targetUid = e.state.battle?.target ?? undefined;
    },
    *resolve(e, link, p) {
      const b = e.state.battle;
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!b || !m || b.target !== m.uid) return;
      b.target = null;
      e.log(p, 'Doble Passe: the attack becomes a direct attack');
      if (m.faceUp) e.damage(other(p), e.atkOf(m));
    },
  };

  E['Dodododraw'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p) && e.player(p).deck.length >= 2 && [...e.player(p).hand, ...faceUpMonsters(e, p)].some((x) => isMonster(e, x) && named(x, 'Dododo')),
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Dodododraw: send which "Dododo" monster to the GY?', [...e.player(p).hand, ...faceUpMonsters(e, p)].filter((x) => isMonster(e, x) && named(x, 'Dododo')), true);
      if (!c) return false;
      e.useOnce(link.card.name, p);
      yield* e.sendToGrave(c.uid, 'cost');
    },
    *resolve(e, _l, p) {
      e.draw(p, 2);
    },
  };

  // Kaiju Counters: no card in the Speed Duel pool places them (read from tags.kaiju).
  const kaiju = (c: Card) => named(c, 'Kaiju');
  E['Dogoran, the Mad Flame Kaiju'] = {
    summonProc: {
      can: (e, _c, p) => {
        const mine = e.monsters(p).some((m) => m.faceUp && kaiju(m));
        const theirs = e.monsters(other(p)).filter((m) => m.faceUp && kaiju(m));
        return (theirs.length === 0 && e.monsters(other(p)).length > 0) || (theirs.length > 0 && !mine && freeMZ(e, p));
      },
      *run(e, card, p) {
        const theirs = e.monsters(other(p)).filter((m) => m.faceUp && kaiju(m));
        if (theirs.length) {
          if (e.monsters(p).some((m) => m.faceUp && kaiju(m)) || !freeMZ(e, p)) return;
          return yield* e.specialSummon(card.uid, p, 'atk');
        }
        const t = yield* pickOne(e, p, "Dogoran: Tribute which of your opponent's monsters?", e.monsters(other(p)), true);
        if (!t) return;
        yield* e.sendToGrave(t.uid, 'tribute');
        yield* e.specialSummon(card.uid, other(p), 'atk');
      },
    },
    ignition: {
      can: (e) => [...allMonsters(e), ...allST(e)].reduce((a, c) => a + (c.tags?.kaiju ?? 0), 0) >= 3,
      *run(e, m, p) {
        let need = 3;
        for (const c of [...allMonsters(e), ...allST(e)]) {
          const k = Math.min(need, c.tags?.kaiju ?? 0);
          if (k) (tag(c).kaiju -= k), (need -= k);
        }
        if (need > 0) return;
        if (e.fieldCard(m.uid)) tag(m).noAttackTurn = e.state.turn;
        yield* e.destroy(e.monsters(other(p)).map((x) => x.uid));
      },
    },
  };

  // "Cannot be Special Summoned" is not enforced.
  E['Doomcaliber Knight'] = {
    quick: {
      label: 'Tribute it to negate the monster effect',
      can: (e, c, _p, t, ctx) => t === 'effect' && !!ctx.link && isMonster(e, ctx.link.card) && ctx.link.card.uid !== c.uid && !!(ctx.link.payload as { effect?: string } | undefined)?.effect,
      *cost(e, card, _p, link, ctx) {
        link.payload = { ...(link.payload as object), target: ctx.link };
        yield* e.sendToGrave(card.uid, 'tribute');
      },
      *run(e, _c, p, link) {
        const target = (link.payload as { target?: ChainLink }).target;
        if (!target) return;
        negateLink(e, target, p);
        if (e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
      },
    },
  };

  E['Doomdog Octhros'] = {
    *onSentToGrave(e, card, p, from) {
      if (from !== 'mz' || !e.oncePerTurn(card.name, p)) return;
      const ok = (c: Card) => isMonster(e, c) && levelOf(e, c) === 8 && raceOf(e, c) === 'Fiend';
      if (!e.player(p).deck.some(ok)) return;
      e.useOnce(card.name, p);
      yield* searchDeck(e, p, 'Doomdog Octhros: add which Level 8 Fiend?', ok);
    },
  };

  const stTargets = (e: Engine, p: Pid, self: number) => stOf(e, p).filter((c) => c.uid !== self);
  E['Double Cyclone'] = {
    canActivate: (e, c, p, t) => anyTime(t) && stTargets(e, p, c.uid).length > 0 && stOf(e, other(p)).length > 0,
    *activate(e, link, p) {
      const a = yield* pickOne(e, p, 'Double Cyclone: target your Spell/Trap', stTargets(e, p, link.card.uid), true);
      if (!a) return false;
      const b = yield* pickOne(e, p, "Double Cyclone: target your opponent's Spell/Trap", stOf(e, other(p)), true);
      if (!b) return false;
      link.payload = [a.uid, b.uid];
    },
    *resolve(e, link) {
      yield* e.destroy((link.payload as number[]).filter((u) => e.fieldCard(u)));
    },
  };

  const negatesTraps = (e: Engine, c: FieldCard) => c.faceUp && (!!e.effectOn(c)?.sealsTraps || c.name === 'Royal Decree' || /negate[^.]*\bTrap/i.test(info(e, c).desc));
  const snareList = (e: Engine) => [...allMonsters(e), ...allST(e)].filter((c) => negatesTraps(e, c));
  E['Double Snare'] = {
    canActivate: (e, _c, _p, t) => isMain(t) && snareList(e).length > 0,
    *resolve(e, _l, p) {
      const c = yield* pickOne(e, p, 'Double Snare: destroy which card?', snareList(e));
      if (c) yield* e.destroy([c.uid]);
    },
  };

  // Normal and Quick-Play Spells only; the copied card stays in the opponent's GY.
  const doubleSpellTargets = (e: Engine, p: Pid, self: number) => e.player(other(p)).gy.filter((c) => c.uid !== self && isSpell(e, c) && ['Normal', 'Quick-Play'].includes(info(e, c).sub) && c.name !== 'Double Spell' && canApply(e, p, c));
  E['Double Spell'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.player(p).hand.some((x) => x.uid !== c.uid && isSpell(e, x)) && doubleSpellTargets(e, p, c.uid).length > 0,
    *activate(e, link, p) {
      if (!(yield* discardCost(e, p, 1, (x) => isSpell(e, x), link.card.uid))) return false;
      const t = yield* pickOne(e, p, "Double Spell: use which Spell from your opponent's GY?", doubleSpellTargets(e, p, link.card.uid));
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link, p) {
      const t = link.targetUid !== undefined ? e.find(link.targetUid) : null;
      if (t?.loc.zone === 'gy' && canApply(e, p, t.card)) yield* applyEffect(e, p, t.card, false);
    },
  };

  // It must be activated after your first Normal Summon/Set of the turn.
  E['Double Summon'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.player(p).normalSummoned && e.oncePerTurn(c.name, p),
    *activate(e, link, p) {
      e.useOnce(link.card.name, p);
    },
    *resolve(e, _l, p) {
      e.player(p).normalSummoned = false;
      e.log(p, `${e.player(p).name} may Normal Summon/Set once more this turn`);
    },
  };

  const frankenderp = function* (e: Engine, p: Pid): Step {
    if (!e.oncePerTurn('Dr. Frankenderp', p) || !e.player(p).deck.length || e.player(p).lp <= 500) return;
    if (!(yield* e.yesno(p, 'Dr. Frankenderp: pay 500 LP to look at the top card of your Deck?'))) return;
    e.useOnce('Dr. Frankenderp', p);
    payLp(e, p, 500);
    const top = e.player(p).deck[0];
    if (!top) return;
    const i = yield* chooseOption(e, p, `The top card is ${top.name}`, ['Place it at the bottom of the Deck', 'Add it to your hand (skip your next Draw Phase)']);
    if (i === 1) {
      e.toHandOf(top.uid, p);
      e.log(p, `${e.player(p).name} reveals and adds ${top.name} to the hand`);
      e.state.fx.skipDraw = p;
    } else {
      const d = e.player(p).deck;
      d.push(d.shift()!);
    }
  };
  E['Dr. Frankenderp'] = {
    *onSummon(e, _m, p, kind) {
      if (kind === 'normal') yield* frankenderp(e, p);
    },
    *onSpecialSummon(e, _m, p) {
      yield* frankenderp(e, p);
    },
  };

  const isDragon = (e: Engine, c: Card) => isMonster(e, c) && raceOf(e, c) === 'Dragon';
  const draconnectable = (e: Engine, p: Pid) => e.player(p).hand.filter((c) => isDragon(e, c) && e.player(p).deck.some((d) => isDragon(e, d) && levelOf(e, d) === levelOf(e, c)));
  E['Draconnection'] = {
    canActivate: (e, _c, p, t) => isMain(t) && draconnectable(e, p).length > 0,
    *resolve(e, _l, p) {
      const r = yield* pickOne(e, p, 'Draconnection: reveal which Dragon?', draconnectable(e, p));
      if (!r) return;
      const lv = levelOf(e, r);
      yield* searchDeck(e, p, `Draconnection: add which Level ${lv} Dragon?`, (d) => isDragon(e, d) && levelOf(e, d) === lv);
      if (e.find(r.uid)?.loc.zone === 'hand') yield* intoDeck(e, r.uid, 'shuffle');
    },
  };

  E['Dragged Down into the Grave'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.player(other(p)).hand.length + e.player(p).hand.filter((x) => x.uid !== c.uid).length > 0,
    *resolve(e, _l, p) {
      const chosen: [Pid, number][] = [];
      for (const q of [p, other(p)]) {
        const c = yield* pickOne(e, q, "Dragged Down into the Grave: discard which card from your opponent's hand?", e.player(other(q)).hand.slice());
        if (c) chosen.push([other(q), c.uid]);
      }
      for (const [owner, uid] of chosen) if (e.find(uid)?.loc.zone === 'hand') yield* e.as(p, e.discard(owner, uid));
      e.draw(p, 1);
      e.draw(other(p), 1);
    },
  };

  // "Your opponent takes no damage this turn" covers battle damage only.
  const rhapsodyList = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isDragon(e, c) && !isExtraOrRitual(e, c));
  E['Dragon Revival Rhapsody'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p) && freeMZ(e, p) && faceUpMonsters(e, p).some((m) => raceOf(e, m) === 'Spellcaster') && rhapsodyList(e, p).some((x) => isNormalMonster(e, x)),
    *activate(e, link, p) {
      const zones = e.player(p).mz.filter((z) => z === null).length;
      for (let i = 0; i < 3; i++) {
        const cs = yield* pick(e, p, 'Dragon Revival Rhapsody: target up to 2 Dragons (at least 1 Normal Monster)', rhapsodyList(e, p), 1, Math.min(2, zones), true);
        if (!cs) return false;
        if (cs.some((c) => isNormalMonster(e, c))) {
          e.useOnce(link.card.name, p);
          link.payload = cs.map((c) => c.uid);
          return;
        }
      }
      return false;
    },
    *resolve(e, link, p) {
      for (const u of link.payload as number[]) if (e.find(u)?.loc.zone === 'gy' && freeMZ(e, p)) yield* e.specialSummon(u, p, 'atk');
      noBattleDamage(e, other(p), true);
    },
  };

  E['Dragon Shrine'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p) && e.player(p).deck.some((x) => isDragon(e, x)),
    *activate(e, link, p) {
      e.useOnce(link.card.name, p);
    },
    *resolve(e, _l, p) {
      const c = yield* deckToGrave(e, p, 'Dragon Shrine: send which Dragon to the GY?', (x) => isDragon(e, x));
      if (!c || !isNormalMonster(e, c) || e.find(c.uid)?.loc.zone !== 'gy' || !e.player(p).deck.some((x) => isDragon(e, x))) return;
      if (yield* e.yesno(p, 'Dragon Shrine: send 1 more Dragon to the GY?')) yield* deckToGrave(e, p, 'Send which Dragon?', (x) => isDragon(e, x));
    },
  };

  const gunfireTargets = (e: Engine) => targetable(e, faceUpMonsters(e)).filter((m) => e.defOf(m) <= 800);
  E["Dragon's Gunfire"] = {
    canActivate: (e, _c, p, t) => isMain(t) && faceUpMonsters(e, p).some((m) => raceOf(e, m) === 'Dragon'),
    *activate(e, link, p) {
      const opts = ['Inflict 800 damage', ...(gunfireTargets(e).length ? ['Destroy a monster with 800 or less DEF'] : [])];
      const i = yield* chooseOption(e, p, "Dragon's Gunfire", opts, true);
      if (i === null) return false;
      if (i === 1) {
        const m = yield* pickOne(e, p, 'Destroy which monster?', gunfireTargets(e), true);
        if (!m) return false;
        link.targetUid = m.uid;
      }
    },
    *resolve(e, link, p) {
      if (link.targetUid === undefined) return e.damage(other(p), 800);
      const m = e.fieldCard(link.targetUid);
      if (m && e.defOf(m) <= 800) yield* e.destroy([m.uid]);
    },
  };

  const rebirthList = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.player(p).gy].filter((c) => isDragon(e, c) && !isExtraOrRitual(e, c));
  E["Dragon's Rebirth"] = {
    canActivate: (e, _c, p, t) => anyTime(t) && targetable(e, faceUpMonsters(e, p)).some((m) => raceOf(e, m) === 'Dragon') && rebirthList(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, "Dragon's Rebirth: banish which Dragon you control?", targetable(e, faceUpMonsters(e, p)).filter((m) => raceOf(e, m) === 'Dragon'), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || e.controller(m.uid) !== p) return;
      yield* dropEquips(e, m.uid);
      e.banish(m.uid);
      yield* summonOneOf(e, p, "Dragon's Rebirth: Special Summon which Dragon?", rebirthList(e, p), 'atk');
    },
  };

  E['Draining Shield'] = {
    canActivate: (e, _c, p, t, ctx) => {
      const a = opponentAttack(e, p, t, ctx);
      return a !== null && !e.untargetable(e.fieldCard(a)!);
    },
    *activate(e, link, p, ctx) {
      link.targetUid = opponentAttack(e, p, 'attack', ctx) ?? undefined;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || e.state.battle?.attacker !== m.uid) return;
      e.endBattle();
      e.log(p, 'Draining Shield negates the attack');
      e.gainLp(p, e.atkOf(m));
    },
  };

  // Any activated card that chose an "Amazoness" monster you control as its target.
  const rescued = (e: Engine, p: Pid, link?: ChainLink) => {
    const m = link?.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
    return m && m.faceUp && named(m, 'Amazoness') && e.controller(m.uid) === p ? m : null;
  };
  E['Dramatic Rescue'] = {
    canActivate: (e, _c, p, t, ctx) => (t === 'spell' || t === 'trap' || t === 'effect') && !!rescued(e, p, ctx.link),
    *activate(e, link, p, ctx) {
      link.targetUid = rescued(e, p, ctx.link)!.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m) return;
      yield* bounce(e, m.uid);
      const list = e.player(p).hand.filter((c) => c.uid !== m.uid && isMonster(e, c) && !isExtraOrRitual(e, c));
      yield* summonOneOf(e, p, 'Dramatic Rescue: Special Summon which monster from your hand?', list, 'atk');
    },
  };

  E['Drillago'] = {
    directAttack: (e, _m, p) => {
      const opp = other(p);
      const ms = e.monsters(opp);
      return ms.length > 0 && stOf(e, opp).length === 0 && ms.every((m) => m.faceUp && e.atkOf(m) >= 1600);
    },
  };

  // Offered when it declares the attack (before damage calculation).
  E['Drillroid'] = {
    quick: {
      repeat: true,
      label: 'destroy the Defense Position monster',
      can: (e, c, _p, t) => {
        const b = e.state.battle;
        const tg = b && b.target !== null ? e.fieldCard(b.target) : null;
        return t === 'attack' && !!b && b.attacker === c.uid && !!tg && tg.pos === 'def';
      },
      *run(e, card) {
        const b = e.state.battle;
        const tg = b && b.attacker === card.uid && b.target !== null ? e.fieldCard(b.target) : null;
        if (tg && tg.pos === 'def' && e.fieldCard(card.uid)) yield* e.destroy([tg.uid]);
      },
    },
  };

  const bonders = ['Hydrogeddon', 'Oxygeddon', 'Duoterion'];
  const duoterion = function* (e: Engine, p: Pid): Step {
    const list = e.player(p).gy.filter((c) => bonders.includes(c.name));
    if (!e.oncePerTurn('Duoterion:2', p) || !list.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Duoterion: Special Summon Hydrogeddon, Oxygeddon or Duoterion from your GY?'))) return;
    e.useOnce('Duoterion:2', p);
    yield* summonOneOf(e, p, 'Special Summon which monster?', list, 'atk');
  };
  E['Duoterion'] = {
    handIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Duoterion:1', p) && e.player(p).deck.some((c) => !isMonster(e, c) && named(c, 'Bonding')),
      *run(e, card, p) {
        e.useOnce('Duoterion:1', p);
        yield* e.discard(p, card.uid);
        yield* searchDeck(e, p, 'Duoterion: add which "Bonding" card?', (c) => !isMonster(e, c) && named(c, 'Bonding'));
      },
    },
    *onSummon(e, _m, p, kind) {
      if (kind === 'normal') yield* duoterion(e, p);
    },
    *onSpecialSummon(e, _m, p) {
      yield* duoterion(e, p);
    },
  };

  E['Dust Knight'] = {
    *flip(e, _m, p) {
      yield* deckToGrave(e, p, 'Dust Knight: send which EARTH monster to the GY?', (c) => isMonster(e, c) && attrOf(e, c) === 'EARTH');
    },
  };

  E['Dweller in the Depths'] = {
    selfBonus: (e, m) => ({ atk: 300 * e.activeSpells(ctrl(e, m)).filter((c) => e.player(ctrl(e, m)).sz.includes(c) && isSpell(e, c) && info(e, c).sub === 'Continuous').length, def: 0 }),
  };

  const dynaPlans = (e: Engine, p: Pid, base: number) => fusionPlansFrom(e, p, handAndField(e, p), () => true, base);
  E['Dyna Base'] = {
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && e.player(p).lp < e.player(other(p)).lp && e.oncePerTurn('Dyna Base:1', p),
      *run(e, card, p) {
        e.useOnce('Dyna Base:1', p);
        yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
    ignition: {
      can: (e, m, p) => e.oncePerTurn('Dyna Base:2', p) && dynaPlans(e, p, m.uid).length > 0,
      *run(e, m, p) {
        e.useOnce('Dyna Base:2', p);
        const plans = dynaPlans(e, p, m.uid);
        if (!plans.length) return;
        const c = yield* chooseFusion(e, p, 'Dyna Base', plans, m.uid);
        if (c) yield* doFusion(e, p, c, 'grave');
      },
    },
  };

  const ehero = (e: Engine, c: Card) => isMonster(e, c) && named(c, 'Elemental HERO');
  E['E - Emergency Call'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).deck.some((c) => ehero(e, c)),
    *resolve(e, _l, p) {
      yield* searchDeck(e, p, 'E - Emergency Call: add which "Elemental HERO"?', (c) => ehero(e, c));
    },
  };

  const enMon = (e: Engine, c: Card) => isMonster(e, c) && (named(c, 'Elemental HERO') || named(c, 'Neo-Spacian'));
  const enMine = (e: Engine, p: Pid) => faceUpMonsters(e, p).filter((m) => enMon(e, m) && e.player(p).deck.some((d) => enMon(e, d) && !isExtraOrRitual(e, d) && d.name !== m.name));
  E['EN Shuffle'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p) && enMine(e, p).length > 0,
    *activate(e, link, p) {
      e.useOnce(link.card.name, p);
    },
    *resolve(e, _l, p) {
      const m = yield* pickOne(e, p, 'EN Shuffle: shuffle which monster into the Deck?', enMine(e, p));
      if (!m) return;
      const name = m.name;
      yield* intoDeck(e, m.uid, 'shuffle');
      if (e.fieldCard(m.uid)) return;
      yield* summonOneOf(e, p, 'EN Shuffle: Special Summon which monster?', e.player(p).deck.filter((d) => enMon(e, d) && !isExtraOrRitual(e, d) && d.name !== name), 'atk');
    },
    graveIgnition: {
      can: (e, c, p) => {
        const gy = e.player(p).gy;
        return e.oncePerTurn(`${c.name}:gy`, p) && e.player(p).deck.length + 1 > 0 && (gy.some((x) => x.name === 'Elemental HERO Neos') || (gy.some((x) => ehero(e, x)) && gy.some((x) => isMonster(e, x) && named(x, 'Neo-Spacian'))));
      },
      *run(e, card, p) {
        const gy = e.player(p).gy;
        const opts: string[] = [];
        const pair = gy.some((x) => ehero(e, x)) && gy.some((x) => isMonster(e, x) && named(x, 'Neo-Spacian'));
        if (pair) opts.push('1 "Elemental HERO" + 1 "Neo-Spacian"');
        if (gy.some((x) => x.name === 'Elemental HERO Neos')) opts.push('1 "Elemental HERO Neos"');
        const i = yield* chooseOption(e, p, 'EN Shuffle: shuffle which cards into the Deck?', opts, true);
        if (i === null) return;
        let chosen: Card[] = [];
        if (opts[i].startsWith('1 "Elemental HERO" +')) {
          const a = yield* pickOne(e, p, 'Shuffle which "Elemental HERO"?', gy.filter((x) => ehero(e, x)), true);
          const b = a && (yield* pickOne(e, p, 'Shuffle which "Neo-Spacian"?', gy.filter((x) => isMonster(e, x) && named(x, 'Neo-Spacian')), true));
          if (!a || !b) return;
          chosen = [a, b];
        } else chosen = [gy.find((x) => x.name === 'Elemental HERO Neos')!];
        e.useOnce(`${card.name}:gy`, p);
        e.banish(card.uid);
        for (const c of chosen) yield* intoDeck(e, c.uid, 'shuffle');
        e.draw(p, 1);
      },
    },
  };

  E['Earthquake'] = {
    canActivate: (e, _c, _p, t) => isMain(t) && faceUpMonsters(e).some((m) => m.pos === 'atk'),
    *resolve(e, link) {
      for (const m of faceUpMonsters(e)) {
        if (m.pos !== 'atk') continue;
        m.pos = 'def';
        e.event('position', { uid: m.uid });
      }
      e.log(link.player, 'Earthquake: all face-up monsters change to Defense Position');
    },
  };

  // Face-down banishing is tracked for the cards Eater of Millions itself banishes. "Cannot be Tributed" is not enforced.
  const fdList = (e: Engine): number[] => (fx(e).faceDownBanished ??= []);
  const fdBanish = (e: Engine, uid: number) => {
    e.banish(uid);
    fdList(e).push(uid);
  };
  const eaterPool = (e: Engine, p: Pid, self: number) => [...e.player(p).hand.filter((c) => c.uid !== self), ...e.monsters(p), ...stOf(e, p), ...e.player(p).fusion];
  const eaterOk = (m: FieldCard, e: Engine) => m.tags?.eaterTurn !== e.state.turn;
  E['Eater of Millions'] = {
    cannotNormalSummon: true,
    summonProc: {
      can: (e, c, p) => eaterPool(e, p, c.uid).length >= 5 && (freeMZ(e, p) || e.monsters(p).length > 0),
      *run(e, card, p) {
        const list = eaterPool(e, p, card.uid);
        const cs = yield* pick(e, p, 'Eater of Millions: banish 5 or more cards face-down', list, 5, list.length, true);
        if (!cs || cs.length < 5) return;
        for (const c of cs) {
          if (e.fieldCard(c.uid)) yield* dropEquips(e, c.uid);
          if (e.find(c.uid)) fdBanish(e, c.uid);
        }
        if (freeMZ(e, p)) yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
    baseStats(e) {
      const n = fdList(e).filter((u) => e.find(u)?.loc.zone === 'removed').length;
      return { atk: n * 100, def: n * 100 };
    },
    *onBeingAttacked(e, me, attacker, p) {
      if (!eaterOk(me, e) || e.controller(attacker.uid) === p || !(yield* e.yesno(p, `Eater of Millions: banish ${attacker.name} face-down?`))) return;
      tag(me).eaterTurn = e.state.turn;
      yield* dropEquips(e, attacker.uid);
      fdBanish(e, attacker.uid);
    },
    quick: {
      repeat: true,
      label: 'banish the monster it battles face-down',
      can: (e, c, _p, t) => {
        const b = e.state.battle;
        return t === 'attack' && !!b && b.attacker === c.uid && b.target !== null && !!e.fieldCard(b.target) && eaterOk(c as FieldCard, e);
      },
      *run(e, card) {
        const me = e.fieldCard(card.uid);
        const b = e.state.battle;
        if (!me || !b || b.attacker !== me.uid || b.target === null || !e.fieldCard(b.target) || !eaterOk(me, e)) return;
        tag(me).eaterTurn = e.state.turn;
        yield* dropEquips(e, b.target);
        fdBanish(e, b.target);
      },
    },
  };

  const frightfur = (c: Card) => named(c, 'Frightfur');
  E['Edge Imp Chain'] = {
    quick: {
      repeat: true,
      label: 'add another Edge Imp Chain from the Deck',
      can: (e, c, p, t) => t === 'attack' && e.state.battle?.attacker === c.uid && e.oncePerTurn(c.name, p) && e.player(p).deck.some((x) => x.name === c.name),
      *cost(e, card, p) {
        e.useOnce(card.name, p);
      },
      *run(e, card, p) {
        yield* searchDeck(e, p, 'Edge Imp Chain: add Edge Imp Chain', (x) => x.name === card.name);
      },
    },
    *onSentToGrave(e, card, p, from) {
      if ((from !== 'hand' && from !== 'mz') || !e.oncePerTurn(card.name, p) || !e.player(p).deck.some(frightfur)) return;
      if (!(yield* e.yesno(p, 'Edge Imp Chain: add a "Frightfur" card from your Deck?'))) return;
      e.useOnce(card.name, p);
      yield* searchDeck(e, p, 'Add which "Frightfur" card?', frightfur);
    },
  };

  // Only the FIRE bonus: negating monsters destroyed by battle (EARTH) is not supported.
  E['Element Saurus'] = {
    selfBonus: (e) => ({ atk: faceUpMonsters(e).some((m) => attrOf(e, m) === 'FIRE') ? 500 : 0, def: 0 }),
  };

  // Its Attribute does not change, and the Fusion-only Special Summon lock is not enforced.
  const blazeSearch = function* (e: Engine, p: Pid): Step {
    if (!e.oncePerTurn('Elemental HERO Blazeman', p) || !e.player(p).deck.some((c) => c.name === 'Polymerization')) return;
    if (!(yield* e.yesno(p, 'Elemental HERO Blazeman: add Polymerization from your Deck?'))) return;
    e.useOnce('Elemental HERO Blazeman', p);
    yield* searchDeck(e, p, 'Add Polymerization', (c) => c.name === 'Polymerization');
  };
  const blazeTargets = (e: Engine, p: Pid) => e.player(p).deck.filter((c) => ehero(e, c) && c.name !== 'Elemental HERO Blazeman');
  E['Elemental HERO Blazeman'] = {
    *onSummon(e, _m, p, kind) {
      if (kind === 'normal') yield* blazeSearch(e, p);
    },
    *onSpecialSummon(e, _m, p) {
      yield* blazeSearch(e, p);
    },
    ignition: {
      can: (e, _m, p) => e.oncePerTurn('Elemental HERO Blazeman', p) && blazeTargets(e, p).length > 0,
      *run(e, m, p) {
        if (!e.oncePerTurn('Elemental HERO Blazeman', p)) return;
        e.useOnce('Elemental HERO Blazeman', p);
        const c = yield* deckToGrave(e, p, 'Elemental HERO Blazeman: send which "Elemental HERO" to the GY?', (x) => ehero(e, x) && x.name !== 'Elemental HERO Blazeman');
        if (!c || !e.fieldCard(m.uid)) return;
        tag(m).blazeTurn = e.state.turn;
        tag(m).blazeAtk = Math.max(0, info(e, c).atk ?? 0);
        tag(m).blazeDef = Math.max(0, info(e, c).def ?? 0);
      },
    },
    baseStats: (e, m) => (m.tags?.blazeTurn === e.state.turn ? { atk: m.tags.blazeAtk ?? 0, def: m.tags.blazeDef ?? 0 } : undefined),
  };

  const bubbleAlone = (e: Engine, p: Pid, uid: number) => e.player(p).hand.length === 0 && othersOnField(e, p, uid).length === 0;
  const bubble = function* (e: Engine, m: FieldCard, p: Pid): Step {
    if (!bubbleAlone(e, p, m.uid) || e.player(p).deck.length < 2 || !(yield* e.yesno(p, 'Elemental HERO Bubbleman: draw 2 cards?'))) return;
    if (bubbleAlone(e, p, m.uid)) e.draw(p, 2);
  };
  E['Elemental HERO Bubbleman'] = {
    summonProc: {
      can: (e, c, p) => freeMZ(e, p) && e.player(p).hand.length === 1 && e.player(p).hand[0].uid === c.uid,
      *run(e, card, p) {
        yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
    *onSummon(e, m, p) {
      yield* bubble(e, m, p);
    },
    *onSpecialSummon(e, m, p) {
      yield* bubble(e, m, p);
    },
  };
}
