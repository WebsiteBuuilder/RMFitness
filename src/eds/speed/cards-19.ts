// Speed Duel card scripts, batch 19: Synchro and Link Monsters (Assault Blackwing - Onimaru ... Dark Infant @Ignister).
// The built-in procedure in extra.ts Synchro/Link Summons them from their material line; these scripts add the effects.
// The monsters used as material are in state.fx.extraMats[uid] (recorded by Engine.extraSummon, b19); tags.synS /
// tags.linkS say how the monster on the field was Summoned.
// Speed Duel has no Extra Monster Zone and no Link Arrows: a Link Monster sits in a normal Monster Zone, and the
// zones it "points to" are read as the Monster Zones next to it (adjacent indexes).
import type { EffectDef } from '../effects';
import { nameEngine } from '../names';
import type { SpeedHelpers } from './helpers';
import { extraReq, isTuner } from './extra';
import {
  attrOf,
  boostPerm,
  boostTurn,
  chooseOption,
  ctrl,
  faceUpMonsters,
  freeMZ,
  info,
  isMonster,
  levelOf,
  named,
  negateLink,
  negateMonster,
  opponentAttack,
  other,
  pick,
  pickOne,
  raceOf,
  searchDeck,
  stOf,
  tag,
  targetable,
} from './helpers';
import type { Card, ChainCtx, ChainLink, Engine, FieldCard, Pid, Step } from './helpers';

// ---------- local helpers ----------
const fxMap = <T>(e: Engine, key: string): Record<number, T> => (e.state.fx[key] ??= {}) as Record<number, T>;
const zoneOf = (e: Engine, uid: number) => e.find(uid)?.loc.zone;
/** The names of the monsters used to Synchro/Link Summon this monster (only while it is still that Summoned monster). */
const matsOf = (e: Engine, m: FieldCard): string[] => (m.tags?.synS || m.tags?.linkS ? fxMap<string[]>(e, 'extraMats')[m.uid] ?? [] : []);
const ctxOf = (link: ChainLink) => (link.payload as { ctx?: ChainCtx } | undefined)?.ctx;
const kindOf = (e: Engine, c: Card) => info(e, c).kind;
const lightOrDark = (e: Engine, c: Card) => ['LIGHT', 'DARK'].includes(attrOf(e, c));
const monsterIn = (e: Engine, list: Card[], attr: string, except: number) => list.filter((c) => c.uid !== except && isMonster(e, c) && attrOf(e, c) === attr);
/** Every face-up card on the field. */
const faceUpCards = (e: Engine) => [...faceUpMonsters(e), ...stOf(e, 0), ...stOf(e, 1)].filter((c) => c.faceUp);
/** Cards on the field an effect of `p` may target. */
const fieldTargets = (e: Engine) => [...targetable(e, [...e.monsters(0), ...e.monsters(1)]), ...stOf(e, 0), ...stOf(e, 1)];

/** "Banish 1 LIGHT and 1 DARK monster from your hand and/or GY, except this card; Special Summon this card from your GY." */
const chaosRevivable = (e: Engine, card: Card, p: Pid) => {
  const pool = [...e.player(p).hand, ...e.player(p).gy];
  const light = monsterIn(e, pool, 'LIGHT', card.uid);
  const dark = monsterIn(e, pool, 'DARK', card.uid);
  return freeMZ(e, p) && light.length > 0 && dark.length > 0 && (light.length > 1 || dark.length > 1 || light[0].uid !== dark[0].uid);
};
function* chaosRevive(e: Engine, card: Card, p: Pid, title: string): Step {
  const pool = () => [...e.player(p).hand, ...e.player(p).gy];
  const l = yield* pickOne(e, p, `${title}: banish which LIGHT monster?`, monsterIn(e, pool(), 'LIGHT', card.uid), true);
  if (!l) return;
  const d = yield* pickOne(e, p, `${title}: banish which DARK monster?`, monsterIn(e, pool(), 'DARK', card.uid).filter((c) => c.uid !== l.uid), true);
  if (!d) return;
  e.banish(l.uid);
  e.banish(d.uid);
  if (zoneOf(e, card.uid) === 'gy') yield* e.specialSummon(card.uid, p, 'atk');
}

/** Chaos Angel: a Tuner, or 1 LIGHT/DARK monster treated as a Tuner, + 1+ non-Tuner LIGHT/DARK monsters, Levels adding up to 10. */
function angelSets(e: Engine, p: Pid): FieldCard[][] {
  const pool = e.monsters(p).filter((m) => m.faceUp && !['Xyz', 'Link'].includes(info(e, m).sub) && levelOf(e, m) > 0);
  const level = info(e, 'Chaos Angel').level ?? 10;
  const out: FieldCard[][] = [];
  for (let mask = 1; mask < 1 << pool.length; mask++) {
    const s = pool.filter((_, i) => mask & (1 << i));
    if (s.length < 2 || s.reduce((a, m) => a + levelOf(e, m), 0) !== level) continue;
    const ok = s.some((t) => (isTuner(e, t) || lightOrDark(e, t)) && s.every((x) => x === t || (!isTuner(e, x) && lightOrDark(e, x))));
    if (ok) out.push(s);
  }
  return out;
}

export function install(E: Record<string, EffectDef>, _h: SpeedHelpers) {
  // ======================= Synchro Monsters =======================
  const blackwing = (c: Card | string) => named(nameEngine(), c, 'Blackwing');
  E['Assault Blackwing - Onimaru the Divine Thunder'] = {
    *onSpecialSummon(e, m) {
      // "Treated as a Tuner while face-up" (tags.tuner, read by the Synchro procedure in extra.ts).
      if (m.tags?.synS && matsOf(e, m).some(blackwing)) {
        tag(m).tuner = 1;
        e.log(null, `${m.name} is treated as a Tuner`);
      }
    },
    effectProof: () => true,
    ignition: {
      can: (e, _m, p) => e.oncePerDuel('Assault Blackwing - Onimaru the Divine Thunder', p) && e.player(p).gy.some((c) => isMonster(e, c) && blackwing(c)),
      *run(e, m, p) {
        const c = yield* pickOne(e, p, "Onimaru: this card's Level becomes the same as which Blackwing monster's?", e.player(p).gy.filter((x) => isMonster(e, x) && blackwing(x)));
        if (!c) return;
        e.useOncePerDuel('Assault Blackwing - Onimaru the Divine Thunder', p);
        const me = e.fieldCard(m.uid);
        if (!me?.faceUp) return;
        tag(me).lvSet = info(e, c).level ?? levelOf(e, me);
        e.log(p, `${me.name} becomes Level ${levelOf(e, me)}`);
      },
    },
    // "Synchro Summoned using only Synchro Monsters": +3000 ATK during the Damage Step of its attacks.
    attackBonus: (e, m) => {
      const mats = matsOf(e, m);
      return m.tags?.synS && mats.length > 0 && mats.every((n) => info(e, n).sub === 'Synchro') ? 3000 : 0;
    },
  };

  E['Beelzeus of the Diabolic Dragons'] = {
    battleProof: () => true,
    effectProof: () => true,
    // "Other monsters you control cannot attack" (Engine.canAttackWith asks face-up monsters' blocksAttack, b19).
    blocksAttack: (e, src, m, attacker) => attacker === ctrl(e, src) && m.uid !== src.uid,
    ignition: {
      can: (e, _m, p) => targetable(e, faceUpMonsters(e, other(p))).length > 0,
      *run(e, m, p) {
        const t = yield* pickOne(e, p, "Beelzeus: change which opponent's monster's ATK to 0?", targetable(e, faceUpMonsters(e, other(p))));
        if (!t) return;
        const me = e.fieldCard(m.uid);
        if (me) tag(me).halfTurn = e.state.turn;
        const tf = e.fieldCard(t.uid);
        if (!tf?.faceUp) return;
        boostPerm(tf, -e.atkOf(tf));
        e.log(p, `${tf.name}'s ATK becomes 0`);
        const orig = e.baseStats(tf).atk;
        if (orig > 0) e.gainLp(p, orig);
      },
    },
    // Battle damage the opponent takes from attacks involving this card this turn is halved.
    damageMod: (e, src, sp, damaged, amount, byEffect) => {
      const b = e.state.battle;
      if (byEffect || damaged !== other(sp) || src.tags?.halfTurn !== e.state.turn || !b || (b.attacker !== src.uid && b.target !== src.uid)) return undefined;
      return Math.floor(amount / 2);
    },
  };

  E['Chaos Angel'] = {
    // "For this card's Synchro Summon, you can treat 1 LIGHT or DARK monster you control as a Tuner."
    extraProc: {
      can: (e, _c, p) => angelSets(e, p).length > 0,
      *run(e, card, p) {
        const sets = angelSets(e, p);
        if (!sets.length) return;
        let mats = sets[0];
        if (sets.length > 1) {
          const i = yield* chooseOption(e, p, 'Synchro Summon Chaos Angel using:', sets.map((s) => s.map((m) => m.name).join(' + ')), true);
          if (i === null) return;
          mats = sets[i];
        }
        yield* e.extraSummon(p, card.uid, mats.map((m) => m.uid), 'Synchro');
      },
    },
    *onSpecialSummon(e, m, p) {
      if (!fieldTargets(e).some((c) => c.uid !== m.uid) || !(yield* e.yesno(p, 'Chaos Angel: banish 1 card on the field?'))) return;
      const c = yield* pickOne(e, p, 'Banish which card?', fieldTargets(e));
      if (c && e.fieldCard(c.uid)) e.banish(c.uid);
    },
    // LIGHT material: your Synchro Monsters are unaffected by monster effects your opponent activates (as protection from
    // their destruction and targeting). DARK material: monsters you control cannot be destroyed by battle.
    shields: (e, src, target, how, sp) => {
      if (!src.tags?.synS || e.controller(target.uid) !== sp) return false;
      const attrs = matsOf(e, src).map((n) => info(e, n).attribute);
      if (how === 'battle') return attrs.includes('DARK');
      return attrs.includes('LIGHT') && info(e, target).sub === 'Synchro' && e.resolvingKind() === 'monster' && e.actor === other(sp);
    },
  };

  const banishedThisTurn = (e: Engine) => Object.values((e.state.fx.banishedAt ?? {}) as Record<number, number>).includes(e.state.turn);
  E['Chaos Beast'] = {
    selfBonus: (e) => ({ atk: banishedThisTurn(e) ? 1000 : 0, def: 0 }),
    ignition: {
      can: (e, _m, p) => e.oncePerTurn('Chaos Beast:1', p) && e.player(p).removed.some((c) => isMonster(e, c) && lightOrDark(e, c)),
      *run(e, _m, p) {
        const c = yield* pickOne(e, p, 'Chaos Beast: add which banished LIGHT or DARK monster to your hand?', e.player(p).removed.filter((x) => isMonster(e, x) && lightOrDark(e, x)));
        if (!c) return;
        e.useOnce('Chaos Beast:1', p);
        e.toHandOf(c.uid, p);
        e.log(p, `${e.player(p).name} adds ${c.name} to the hand`);
      },
    },
    *onSentToGrave(e, card) {
      fxMap<number>(e, 'chaosBeastGy')[card.uid] = e.state.turn;
    },
    graveIgnition: {
      can: (e, card, p) => e.oncePerTurn('Chaos Beast:2', p) && fxMap<number>(e, 'chaosBeastGy')[card.uid] !== e.state.turn && chaosRevivable(e, card, p),
      *run(e, card, p) {
        e.useOnce('Chaos Beast:2', p);
        yield* chaosRevive(e, card, p, 'Chaos Beast');
      },
    },
  };

  E['Chaos Ruler, the Chaotic Magical Dragon'] = {
    *onSpecialSummon(e, m, p) {
      if (!m.tags?.synS || !e.oncePerTurn('Chaos Ruler:1', p) || !e.player(p).deck.length) return;
      if (!(yield* e.yesno(p, 'Chaos Ruler: excavate the top 5 cards of your Deck?'))) return;
      e.useOnce('Chaos Ruler:1', p);
      const top = e.player(p).deck.slice(0, 5);
      e.log(p, `Chaos Ruler excavates ${top.map((c) => c.name).join(', ')}`);
      const ok = top.filter((c) => isMonster(e, c) && lightOrDark(e, c));
      const c = ok.length ? yield* pickOne(e, p, 'Add which excavated LIGHT or DARK monster to your hand?', ok, true) : null;
      if (c) {
        e.toHandOf(c.uid, p);
        e.log(p, `${e.player(p).name} adds ${c.name} to the hand`);
      }
      for (const x of top) if (x !== c && zoneOf(e, x.uid) === 'deck') yield* e.sendToGrave(x.uid, 'mill');
    },
    graveIgnition: {
      can: (e, card, p) => e.oncePerTurn('Chaos Ruler:2', p) && chaosRevivable(e, card, p),
      *run(e, card, p) {
        e.useOnce('Chaos Ruler:2', p);
        yield* chaosRevive(e, card, p, 'Chaos Ruler');
        const m = e.fieldCard(card.uid);
        if (m) tag(m).banishOnLeave = 1;
      },
    },
    *onLeaveField(e, fc) {
      // "Banish it when it leaves the field" (it may have gone to the GY or back to the Extra Deck).
      if (fc.tags?.banishOnLeave && ['gy', 'fusion'].includes(zoneOf(e, fc.uid) ?? '')) e.banish(fc.uid);
    },
  };

  E['Cloudcastle'] = {
    *onSpecialSummon(e, m, p) {
      const lv9 = () => e.player(p).gy.filter((c) => isMonster(e, c) && info(e, c).level === 9 && !e.isExtraCard(c.name));
      if (!m.tags?.synS || !freeMZ(e, p) || !lv9().length || !(yield* e.yesno(p, 'Cloudcastle: Special Summon a Level 9 monster from your GY?'))) return;
      const c = yield* pickOne(e, p, 'Special Summon which monster?', lv9());
      if (c) yield* e.specialSummon(c.uid, p, 'atk');
    },
    // "Level 8 or lower monsters cannot attack the turn they are Normal or Special Summoned."
    blocksAttack: (e, _src, m) => {
      const lv = levelOf(e, m);
      return lv > 0 && lv <= 8 && (m.tags?.ssAt === e.state.turn || m.placedTurn === e.state.turn);
    },
  };

  // Dragon Synchro Monsters that need 2+ non-Tuner Synchro Monsters as material.
  const quasarCalls = (e: Engine, p: Pid) =>
    e.player(p).fusion.filter((c) => {
      const r = info(e, c).sub === 'Synchro' && info(e, c).race === 'Dragon' ? extraReq(e, c.name) : null;
      return !!r && r.min >= 2 && /Synchro/.test(r.qual) && !e.summonBlocked(p, c, 'special', 'fusion');
    });
  E['Cosmic Quasar Dragon'] = {
    // "Must first be Synchro Summoned."
    summonRule: (_e, _c, _p, how, from) => how !== 'special' || from === 'fusion',
    ignition: {
      can: (e) => faceUpCards(e).length > 0,
      *run(e, m, p) {
        const me = e.fieldCard(m.uid);
        const n = (me ? matsOf(e, me).length : 0) + 1;
        const list = faceUpCards(e).filter((c) => !(isMonster(e, c) && e.untargetable(c)));
        const chosen = yield* pick(e, p, `Cosmic Quasar Dragon: negate the effects of up to ${n} face-up cards`, list, 1, Math.min(n, list.length));
        // Monsters lose their effects while face-up; Spells/Traps get the same mark (tags.negated), which Engine.effectOn honours.
        for (const c of chosen ?? []) if (e.fieldCard(c.uid)?.faceUp) negateMonster(e, c, false);
      },
    },
    quick: {
      label: 'banish it: Special Summon a Dragon Synchro Monster',
      can: (e, c, p) => !!e.fieldCard(c.uid)?.tags?.synS && quasarCalls(e, p).length > 0,
      *cost(e, c) {
        e.banish(c.uid);
      },
      *run(e, _c, p) {
        const list = quasarCalls(e, p);
        const c = yield* pickOne(e, p, 'Special Summon which Dragon Synchro Monster?', list);
        if (c && freeMZ(e, p)) yield* e.specialSummon(c.uid, p, 'atk', true, (fc) => ((fc.tags ??= {}).synS = 1));
      },
    },
  };

  // Approximation: its Spell/Trap negation answers only the opponent's activations.
  const oppMonsterEffect = (e: Engine, p: Pid, t: string, ctx: ChainCtx) => t === 'effect' && !!ctx.link && ctx.link.player === other(p) && !ctx.link.negated && kindOf(e, ctx.link.card) === 'monster';
  const oppSpellTrap = (e: Engine, p: Pid, t: string, ctx: ChainCtx) => ['spell', 'trap', 'effect'].includes(t) && !!ctx.link && ctx.link.player === other(p) && !ctx.link.negated && kindOf(e, ctx.link.card) !== 'monster';
  E['Crystal Clear Wing Synchro Dragon'] = {
    quick: {
      repeat: true,
      can: (e, c, p, t, ctx) =>
        !!e.fieldCard(c.uid)?.faceUp && ((oppMonsterEffect(e, p, t, ctx) && e.oncePerTurn(`CCW:1:${c.uid}`, p)) || (oppSpellTrap(e, p, t, ctx) && e.oncePerTurn(`CCW:2:${c.uid}`, p))),
      *cost(e, c, p, _link, ctx) {
        e.useOnce(kindOf(e, ctx.link!.card) === 'monster' ? `CCW:1:${c.uid}` : `CCW:2:${c.uid}`, p);
      },
      *run(e, c, p, link) {
        const target = ctxOf(link)?.link;
        const me = e.fieldCard(c.uid);
        if (!target || !me) return;
        if (kindOf(e, target.card) === 'monster') {
          if (!me.faceUp) return;
          Object.assign(tag(me), { unaffTurn: e.state.turn, unaffBy: other(p) });
          const gain = info(e, target.card).atk ?? 0;
          boostTurn(me, gain);
          e.log(p, `${me.name} is unaffected by ${e.player(other(p)).name}'s monster effects this turn and gains ${gain} ATK`);
          return;
        }
        if (target.negated) return;
        negateLink(e, target, p);
        if (target.negated && e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
      },
    },
    // "If this Synchro Summoned card you control is sent to your GY by an opponent's card": fx.ccwLeft[uid].
    *onLeaveField(e, fc, controller) {
      fxMap<{ syn: boolean; opp: boolean; ctl: Pid }>(e, 'ccwLeft')[fc.uid] = { syn: !!fc.tags?.synS, opp: e.actor !== null && e.actor !== controller, ctl: controller };
    },
    *onDestroyed(e, card, _p, byBattle) {
      const r = fxMap<{ syn: boolean; opp: boolean; ctl: Pid }>(e, 'ccwLeft')[card.uid];
      if (r && byBattle) r.opp = true;
    },
    *onSentToGrave(e, card, owner, from) {
      const r = fxMap<{ syn: boolean; opp: boolean; ctl: Pid }>(e, 'ccwLeft')[card.uid];
      delete fxMap(e, 'ccwLeft')[card.uid];
      const wind = (c: Card) => isMonster(e, c) && info(e, c).attribute === 'WIND';
      if (from !== 'mz' || !r?.syn || !r.opp || r.ctl !== owner || !e.player(owner).deck.some(wind)) return;
      if (!(yield* e.yesno(owner, 'Crystal Clear Wing Synchro Dragon: add 1 WIND monster from your Deck to your hand?'))) return;
      yield* searchDeck(e, owner, 'Add which WIND monster?', wind);
    },
  };

  E['Dragocytos Corrupted Nethersoul Dragon'] = {
    battleProof: () => true,
    *afterBattle(e, a, t, p, destroyed) {
      // "Can make a second attack in a row on an opponent's monster" (once: no third attack).
      if (!destroyed || zoneOf(e, t.uid) !== 'gy' || a.tags?.dragoTurn === e.state.turn || !e.fieldCard(a.uid)) return;
      if (!(yield* e.yesno(p, 'Dragocytos: make a second attack on a monster?'))) return;
      Object.assign(tag(a), { dragoTurn: e.state.turn, extraAttacksTurn: e.state.turn, extraAttacksN: 1, noDirectTurn: e.state.turn });
      e.log(p, `${a.name} can attack a monster again`);
    },
    *onStandby(e, m, p) {
      const list = () => targetable(e, faceUpMonsters(e, other(p)));
      if (e.state.turnPlayer !== p || !list().length || !(yield* e.yesno(p, "Dragocytos: halve an opponent's monster's ATK and inflict the lost ATK as damage?"))) return;
      const t = yield* pickOne(e, p, 'Halve which monster’s ATK?', list());
      if (!t || !e.fieldCard(t.uid)?.faceUp || !e.fieldCard(m.uid)) return;
      const atk = e.atkOf(t);
      const lost = atk - Math.floor(atk / 2);
      if (lost <= 0) return;
      boostPerm(t, -lost);
      e.log(p, `${t.name}'s ATK becomes ${e.atkOf(t)}`);
      e.damage(other(p), lost);
    },
  };

  E['Hi-Speedroid Puzzle'] = {
    // Battling a Special Summoned monster: its ATK doubles until the end of the Damage Step.
    attackBonus: (e, m, target) => (target?.tags?.ss ? e.atkOf(m) : 0),
    *onBeingAttacked(e, me, attacker) {
      if (!attacker.tags?.ss || !me.faceUp) return;
      const gain = e.atkOf(me);
      boostTurn(me, gain);
      tag(me).puzzleBoost = gain;
      e.log(null, `${me.name}'s ATK doubles`);
    },
    *onAttacked(_e, me) {
      const g = me.tags?.puzzleBoost ?? 0;
      if (g) (boostTurn(me, -g), (tag(me).puzzleBoost = 0));
    },
    *onLeaveField(e, fc) {
      if (fc.tags?.synS) fxMap<number>(e, 'puzzleLeft')[fc.uid] = e.state.turn;
    },
    *onSentToGrave(e, card, _o, from) {
      if (from === 'mz' && fxMap<number>(e, 'puzzleLeft')[card.uid] === e.state.turn) fxMap<number>(e, 'puzzleGy')[card.uid] = e.state.turn;
    },
    *onEndPhaseInGrave(e, card, owner) {
      const speedroid = (c: Card) => isMonster(e, c) && named(e, c, 'Speedroid') && !e.isNamed(c, 'Hi-Speedroid Puzzle');
      if (fxMap<number>(e, 'puzzleGy')[card.uid] !== e.state.turn || !e.oncePerTurn('Hi-Speedroid Puzzle', owner) || !e.player(owner).gy.some(speedroid)) return;
      if (!(yield* e.yesno(owner, 'Hi-Speedroid Puzzle: add a "Speedroid" monster from your GY to your hand?'))) return;
      const c = yield* pickOne(e, owner, 'Add which Speedroid monster?', e.player(owner).gy.filter(speedroid));
      if (!c) return;
      e.useOnce('Hi-Speedroid Puzzle', owner);
      e.toHandOf(c.uid, owner);
      e.log(owner, `${e.player(owner).name} adds ${c.name} to the hand`);
    },
  };

  E['Psychic Nightmare'] = {
    // +1000 ATK until the opponent's End Phase (the end of the next turn): tags.nightmareUntil.
    selfBonus: (e, m) => ({ atk: (m.tags?.nightmareUntil ?? -1) >= e.state.turn ? 1000 : 0, def: 0 }),
    ignition: {
      can: (e, _m, p) => e.player(other(p)).hand.length > 0,
      *run(e, m, p) {
        const hand = e.player(other(p)).hand;
        if (!hand.length) return;
        const c = hand[Math.floor(e.rand() * hand.length)];
        const types = ['Monster', 'Spell', 'Trap'];
        const i = yield* chooseOption(e, p, 'Psychic Nightmare: what type of card is it?', types);
        const kind = ['monster', 'spell', 'trap'][i ?? 0];
        e.log(p, `${e.player(p).name} calls ${types[i ?? 0]}: the card is ${c.name}`);
        const me = e.fieldCard(m.uid);
        if (kindOf(e, c) === kind && me?.faceUp) {
          tag(me).nightmareUntil = e.state.turn + (e.state.turnPlayer === p ? 1 : 0);
          e.log(p, `${me.name} gains 1000 ATK`);
        }
      },
    },
  };

  E['Red Nova Dragon'] = {
    selfBonus: (e, m) => ({ atk: 500 * e.player(ctrl(e, m)).gy.filter((c) => isMonster(e, c) && info(e, c).tuner).length, def: 0 }),
    // Cannot be destroyed by the opponent's card effects.
    effectProof: (e, m) => e.actor !== null && e.actor !== e.controller(m.uid),
    quick: {
      label: 'banish it and negate the attack',
      repeat: true,
      can: (e, c, p, t, ctx) => !!e.fieldCard(c.uid)?.faceUp && opponentAttack(e, p, t, ctx) !== null,
      *cost(e, _c, p, link, ctx) {
        link.targetUid = opponentAttack(e, p, 'attack', ctx) ?? undefined;
      },
      *run(e, c, p) {
        const me = e.fieldCard(c.uid);
        if (!me) return;
        e.banish(me.uid);
        if (zoneOf(e, me.uid) !== 'removed') return;
        if (e.state.battle) {
          e.log(p, 'The attack is negated');
          e.endBattle();
        }
        e.returnLater(me.uid, p, 'atk', e.state.turn, 'EP');
      },
    },
  };

  const zombieSynchro = (e: Engine, c: Card) => isMonster(e, c) && info(e, c).sub === 'Synchro' && info(e, c).race === 'Zombie';
  const shiranuiInGy = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && named(e, c, 'Shiranui'));
  E['Shiranui Sunsaga'] = {
    // "You can only Special Summon Shiranui Sunsaga(s) once per turn."
    selfSummonBlock: (e, _c, p, how) => how === 'special' && (e.state.fx.sunsaga as number[] | undefined)?.[p] === e.state.turn,
    *onSpecialSummon(e, _m, p) {
      (e.state.fx.sunsaga ??= [-1, -1])[p] = e.state.turn;
      const list = () => [...e.player(p).gy, ...e.player(p).removed].filter((c) => zombieSynchro(e, c));
      if (!list().length || !(yield* e.yesno(p, 'Shiranui Sunsaga: return Zombie Synchro Monsters to the Extra Deck?'))) return;
      const chosen = yield* pick(e, p, 'Return which Zombie Synchro Monsters to the Extra Deck?', list(), 1, list().length, true);
      let n = 0;
      for (const c of chosen ?? []) {
        if (!['gy', 'removed'].includes(zoneOf(e, c.uid) ?? '')) continue;
        e.toDeckTop(c.uid);
        if (zoneOf(e, c.uid) === 'fusion') (n++, e.log(p, `${c.name} returns to the Extra Deck`));
      }
      const opp = () => [...e.monsters(other(p)), ...stOf(e, other(p))];
      if (!n || !opp().length || !(yield* e.yesno(p, `Shiranui Sunsaga: destroy ${n} card${n > 1 ? 's' : ''} your opponent controls?`))) return;
      const k = Math.min(n, opp().length);
      const hit = yield* pick(e, p, `Destroy ${k} card${k > 1 ? 's' : ''}`, opp(), k, k);
      if (hit?.length) yield* e.destroy(hit.map((c) => c.uid));
    },
    // "If a Zombie monster you control would be destroyed, you can banish 1 Shiranui monster from your GY instead"
    // (applied automatically; Engine.destroy asks shields right before the destruction).
    shields: (e, _src, target, how, sp) => {
      if (how === 'target' || e.controller(target.uid) !== sp || !target.faceUp || raceOf(e, target) !== 'Zombie') return false;
      const s = shiranuiInGy(e, sp)[0];
      if (!s) return false;
      e.banish(s.uid);
      e.log(sp, `${s.name} is banished instead of destroying ${target.name}`);
      return true;
    },
  };

  // ======================= Link Monsters =======================
  // A-Counters are kept in tags.aCounter (as for Mass Hypnosis).
  const aCounters = (e: Engine) => [...e.monsters(0), ...e.monsters(1)].reduce((a, m) => a + (m.tags?.aCounter ?? 0), 0);
  const placesACounter = (e: Engine, c: Card) => /place[sd]? (?:an? |\d+ |)A-Counters?|A-Counters? on/i.test(info(e, c).desc) && !e.isNamed(c, "Cosmic Slicer Zer'oll");
  const reptileInHand = (e: Engine, p: Pid) => e.player(p).hand.filter((c) => isMonster(e, c) && info(e, c).race === 'Reptile' && e.canNormalSummon(p, c, true, true));
  E["Cosmic Slicer Zer'oll"] = {
    // Opponent's monsters with A-Counters: changed to Defense Position, and their effects cannot be activated
    // (approximation: their effects are negated this turn while it stays face-up).
    *stateCheck(e, _src, p) {
      for (const m of e.monsters(other(p))) {
        if (!m.faceUp || !(m.tags?.aCounter ?? 0)) continue;
        if (m.pos === 'atk') {
          m.pos = 'def';
          e.log(null, `${m.name} is changed to Defense Position`);
        }
        if (m.tags?.negatedTurn !== e.state.turn) tag(m).negatedTurn = e.state.turn;
      }
    },
    *onSpecialSummon(e, m, p) {
      if (!m.tags?.linkS || !e.oncePerTurn("Zer'oll:1", p) || !e.player(p).deck.some((c) => placesACounter(e, c))) return;
      if (!(yield* e.yesno(p, "Cosmic Slicer Zer'oll: add a card that places A-Counters from your Deck to your hand?"))) return;
      e.useOnce("Zer'oll:1", p);
      yield* searchDeck(e, p, 'Add which card?', (c) => placesACounter(e, c));
    },
    ignition: {
      can: (e, _m, p) => e.oncePerTurn("Zer'oll:2", p) && aCounters(e) >= 2 && reptileInHand(e, p).length > 0,
      *run(e, _m, p) {
        if (aCounters(e) < 2) return;
        e.useOnce("Zer'oll:2", p);
        for (let i = 0; i < 2; i++) {
          const m = yield* pickOne(e, p, 'Remove an A-Counter from which monster?', [...e.monsters(0), ...e.monsters(1)].filter((x) => (x.tags?.aCounter ?? 0) > 0), false);
          if (m) tag(m).aCounter = (m.tags!.aCounter ?? 1) - 1;
        }
        e.log(p, `${e.player(p).name} removes 2 A-Counters`);
        const r = yield* pickOne(e, p, 'Normal Summon which Reptile monster?', reptileInHand(e, p), true);
        if (r) yield* e.extraNormalSummon(p, r.uid, 'atk', true);
      },
    },
  };

  const adjacentFree = (e: Engine, m: FieldCard, p: Pid) => {
    const mz = e.player(p).mz;
    const i = mz.indexOf(m);
    return [i - 1, i + 1].filter((j) => i >= 0 && j >= 0 && j < mz.length && mz[j] === null);
  };
  E['Dark Infant @Ignister'] = {
    *onSpecialSummon(e, m, p) {
      const land = (c: Card) => e.isNamed(c, 'Ignister A.I.Land');
      if (!m.tags?.linkS || !e.oncePerTurn('Dark Infant @Ignister:1', p) || !e.player(p).deck.some(land)) return;
      if (!(yield* e.yesno(p, 'Dark Infant @Ignister: add "Ignister A.I.Land" from your Deck to your hand?'))) return;
      e.useOnce('Dark Infant @Ignister:1', p);
      yield* searchDeck(e, p, 'Add which card?', land);
    },
    // "Move this card to your Main Monster Zone this card points to": here, an empty Monster Zone next to it.
    quick: {
      label: 'move to the next Monster Zone',
      repeat: true,
      can: (e, c, p, t, ctx) => {
        const m = e.fieldCard(c.uid);
        const l = ctx.link;
        if (!m?.faceUp || t !== 'effect' || !l || l.negated || !e.oncePerTurn('Dark Infant @Ignister:2', p)) return false;
        return kindOf(e, l.card) === 'monster' && info(e, l.card).race === 'Cyberse' && info(e, l.card).atk === 2300 && adjacentFree(e, m, p).length > 0;
      },
      *cost(e, _c, p) {
        e.useOnce('Dark Infant @Ignister:2', p);
      },
      *run(e, c, p) {
        const m = e.fieldCard(c.uid);
        if (!m || e.controller(m.uid) !== p) return;
        const to = adjacentFree(e, m, p);
        if (!to.length) return;
        const mz = e.player(p).mz;
        const j = to.length > 1 ? to[(yield* chooseOption(e, p, 'Move Dark Infant @Ignister to which zone?', to.map((z) => `Monster Zone ${z + 1}`))) ?? 0] : to[0];
        mz[mz.indexOf(m)] = null;
        mz[j] = m;
        e.log(p, `${m.name} moves to Monster Zone ${j + 1}`);
        const attrs = ['DARK', 'LIGHT', 'EARTH', 'WATER', 'FIRE', 'WIND'];
        const i = yield* chooseOption(e, p, 'Change its Attribute until the end of this turn?', ['Keep it', ...attrs]);
        if (!i) return;
        (e.state.fx.declAttr ??= {})[m.uid] = attrs[i - 1];
        tag(m).attrTurn = e.state.turn;
        e.log(p, `${m.name} becomes ${attrs[i - 1]}`);
      },
    },
    *onEndPhase(e, m) {
      if (m.tags?.attrTurn === e.state.turn && e.state.fx.declAttr) delete e.state.fx.declAttr[m.uid];
    },
  };
}
