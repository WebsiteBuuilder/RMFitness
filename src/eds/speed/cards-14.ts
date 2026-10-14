// Speed Duel card scripts, batch 14: the Speed Duel GX / remaining Speed Duel cards (Amaterasu ... Shadow of Eyes).
// Several of them use the batch-14 hooks in effects.ts: selfSummonBlock, onChainLink, damageMod,
// reflectBattleDamage, hostNoBattleDamage, guardsAttack, negatesBattleFlip, the banished-card hooks,
// ritualLevel / ritualFromGrave, and the engine's extraAttacks / noDirectAttack monster tags.
import type { EffectDef } from '../effects';
import type { SpeedHelpers } from './helpers';
import {
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
  isExtraOrRitual,
  isMain,
  isMonster,
  isSpell,
  label,
  levelOf,
  named,
  negateLink,
  other,
  pickOne,
  raceOf,
  searchDeck,
  stOf,
  summonOneOf,
  tag,
  targetable,
  toDeck,
  boostPerm,
  boostTurn,
} from './helpers';
import type { Card, ChainCtx, ChainLink, Engine, FieldCard, Pid, Step } from './helpers';

// ---------- local helpers ----------
const fxm = <T>(e: Engine, key: string, init: T): T => (e.state.fx[key] ??= init) as T;
const isEffectLink = (link: ChainLink | undefined) => !!(link?.payload as { effect?: string } | undefined)?.effect;
const inZone = (e: Engine, uid: number, zone: string) => e.find(uid)?.loc.zone === zone;
/** A monster with an effect (Effect Monsters, and Fusion/Ritual Monsters that have one). */
const isEffectMonster = (e: Engine, c: Card | string) => {
  const i = info(e, c);
  return i.kind === 'monster' && (i.sub === 'Effect' || ((i.sub === 'Fusion' || i.sub === 'Ritual') && !i.vanilla));
};
const mainMonster = (e: Engine, c: Card) => isMonster(e, c) && !isExtraOrRitual(e, c);
const continuousTrap = (): Pick<EffectDef, 'canActivate' | 'resolve'> => ({ canActivate: (_e, _c, _p, t) => anyTime(t), *resolve() {} });
const fieldTarget = (e: Engine, link: ChainLink) => (link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null);

/** Events since the start of the current turn (the 'turn' event), or null when that is no longer in the event log. */
function eventsThisTurn(e: Engine) {
  const ev = e.state.events ?? [];
  for (let i = ev.length - 1; i >= 0; i--) if (ev[i].kind === 'turn') return ev.slice(i);
  return null;
}
/** The card `p` drew for their normal draw this turn, while it is still in their hand. */
function normalDraw(e: Engine, p: Pid): Card | null {
  const ev = eventsThisTurn(e);
  if (!ev || ev[0].player !== p || e.state.turnPlayer !== p) return null;
  const d = ev[1];
  if (!d || d.kind !== 'draw' || d.player !== p || d.uid === undefined) return null;
  const f = e.find(d.uid);
  return f && f.loc.zone === 'hand' && f.loc.player === p ? f.card : null;
}
/** Was this card drawn by `p` this turn? */
const drawnThisTurn = (e: Engine, p: Pid, uid: number) => !!eventsThisTurn(e)?.some((x) => x.kind === 'draw' && x.player === p && x.uid === uid);

/** Moves a card into its owner's Extra Deck (it leaves the field like a card returned to the hand). */
function toExtra(e: Engine, uid: number) {
  const f = e.find(uid);
  if (!f) return;
  const owner = f.card.owner;
  e.toHand(uid);
  const hand = e.player(owner).hand;
  const i = hand.findIndex((c) => c.uid === uid);
  if (i < 0) return;
  const [c] = hand.splice(i, 1);
  e.player(owner).fusion.push(c);
}
const shuffleBack = (e: Engine, uid: number) => {
  const f = e.find(uid);
  if (!f) return;
  if (info(e, f.card).sub === 'Fusion') toExtra(e, uid);
  else toDeck(e, uid);
};

/** Sets a monster card from the hand face-down in the Spell & Trap Zone, as a Spell (Artifacts). */
function setAsSpell(e: Engine, c: Card, p: Pid): FieldCard | null {
  const z = freeST(e, p);
  const f = e.find(c.uid);
  if (z < 0 || !f || f.loc.zone !== 'hand' || f.loc.player !== p) return null;
  const ps = e.player(p);
  const [card] = ps.hand.splice(f.loc.index, 1);
  const fc: FieldCard = { uid: card.uid, name: card.name, owner: card.owner, pos: 'atk', faceUp: false, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
  ps.sz[z] = fc;
  e.event('set', { uid: card.uid, player: p });
  e.log(p, `${ps.name} Set a card`);
  return fc;
}

/** Normal Summons a monster from the hand outside the engine's own Tribute rules, with tags on it (Charging Gaia). */
function* normalSummonNow(e: Engine, uid: number, p: Pid, tags: Record<string, number>): Step {
  const ps = e.player(p);
  const i = ps.hand.findIndex((c) => c.uid === uid);
  const z = ps.mz.findIndex((x) => x === null);
  if (i < 0 || z < 0) return;
  const [card] = ps.hand.splice(i, 1);
  const fc: FieldCard = { uid: card.uid, name: card.name, owner: card.owner, pos: 'atk', faceUp: true, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, tags: { ...tags } };
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

/** A Gemini monster with no ignition effect: Normal Summon it again (uses the Normal Summon) to make it an Effect Monster. */
const geminiOn = (m: FieldCard) => m.tags?.gemini === 1;
const gemini = (): Partial<EffectDef> => ({
  ignition: {
    chain: false,
    can: (e, m, p) => !geminiOn(m) && !e.player(p).normalSummoned,
    *run(e, m, p) {
      if (geminiOn(m)) return;
      e.player(p).normalSummoned = true;
      tag(m).gemini = 1;
      e.log(p, `${e.player(p).name} Normal Summons ${m.name} again: it becomes an Effect Monster`);
    },
  },
});

/** Fusion Summons using 2 monsters from hand, Deck or field: the first must be `first` (or a substitute), the second must pass `second`. */
type TwoPlan = { fusion: Card; a: Card[]; b: (c: Card) => boolean };
const secondSpec = (e: Engine, fusion: Card): ((c: Card) => boolean) | null => {
  const line = info(e, fusion).desc.split('\n')[0];
  const rest = line.split('+').slice(1).join('+').trim();
  const lv = rest.match(/^1 Level (\d+) or higher monster$/);
  if (lv) return (c) => isMonster(e, c) && (info(e, c).level ?? 0) >= Number(lv[1]);
  const q = rest.match(/^"([^"]+)"$/);
  if (q) return (c) => c.name === q[1];
  return null;
};

// ---------- the cards ----------
export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  // ===================== Effect Monsters =====================
  // The "when your opponent targets this face-down card" Quick Effect is not offered (face-down monsters have no Quick Effects in the engine).
  E['Amaterasu'] = {
    selfSummonBlock: (_e, _c, _p, how) => how === 'normal' || how === 'special',
    *flip(e, m, p) {
      tag(m).flipTurn = e.state.turn;
      const others = [...allMonsters(e), ...allST(e)].filter((c) => c.uid !== m.uid);
      if (!others.length) return;
      e.log(p, 'Amaterasu banishes all other cards on the field');
      for (const c of others) {
        if (!e.fieldCard(c.uid)) continue;
        if (c.token) yield* e.sendToGrave(c.uid, 'used');
        else e.banish(c.uid);
      }
    },
    *onEndPhase(e, m, p) {
      if (m.tags?.flipTurn !== e.state.turn || !e.oncePerTurn(`Amaterasu:${m.uid}`, p)) return;
      e.useOnce(`Amaterasu:${m.uid}`, p);
      e.log(p, 'Amaterasu returns to the hand');
      e.toHand(m.uid);
    },
  };

  // "Your opponent cannot activate Spell/Trap Cards" while it attacks: their activations are negated as they resolve.
  E['Ancient Gear Engineer'] = {
    *onChainLink(e, m, p, link) {
      const kind = info(e, link.card).kind;
      if (kind === 'trap' && link.targetUid === m.uid) {
        negateLink(e, link, p);
        if (link.negated && e.fieldCard(link.card.uid)) {
          e.log(p, `Ancient Gear Engineer destroys ${link.card.name}`);
          yield* e.destroy([link.card.uid]);
        }
        return;
      }
      if (e.state.battle?.attacker === m.uid && link.player === other(p) && (kind === 'spell' || kind === 'trap') && !isEffectLink(link)) {
        e.log(p, `${link.card.name} cannot be activated while Ancient Gear Engineer attacks`);
        negateLink(e, link, p);
      }
    },
    *afterBattle(e, _a, _t, p) {
      const list = stOf(e, other(p));
      if (!list.length) return;
      const t = yield* pickOne(e, p, 'Ancient Gear Engineer: destroy which Spell/Trap?', list);
      if (t && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
    },
  };

  // "Cannot be activated" is applied as "negated as it resolves" (activated effects of Effect Monsters only).
  E['Angel O7'] = {
    *onSummon(e, m, p, kind) {
      if (kind !== 'normal' || levelOf(e, m) < 5) return;
      tag(m).o7 = 1;
      e.log(p, 'Angel O7 was Tribute Summoned: the effects of Effect Monsters cannot be activated');
    },
    *onChainLink(e, m, p, link) {
      if (!m.tags?.o7 || !isEffectLink(link) || !isEffectMonster(e, link.card)) return;
      negateLink(e, link, p);
    },
  };

  E['Artifact Moralltach'] = {
    handIgnition: {
      can: (e, _c, p) => freeST(e, p) >= 0,
      *run(e, c, p) {
        setAsSpell(e, c, p);
      },
    },
    *onSentToGrave(e, card, owner, from, reason) {
      if (from !== 'sz' || reason !== 'destroyed' || e.state.turnPlayer === owner || !freeMZ(e, owner)) return;
      e.log(owner, 'Artifact Moralltach was destroyed in the Spell & Trap Zone: it is Special Summoned');
      const atk = yield* e.yesno(owner, 'Special Summon Artifact Moralltach in Attack Position? (No = Defense)');
      yield* e.specialSummon(card.uid, owner, atk ? 'atk' : 'def');
    },
    *onSpecialSummon(e, _m, p) {
      if (e.state.turnPlayer === p) return;
      const list = [...faceUpMonsters(e, other(p)), ...stOf(e, other(p)).filter((c) => c.faceUp)];
      if (!list.length || !(yield* e.yesno(p, "Artifact Moralltach: destroy 1 face-up card your opponent controls?"))) return;
      const t = yield* pickOne(e, p, 'Artifact Moralltach: destroy which card?', list);
      if (t && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
    },
  };

  const blastTargets = (e: Engine, n: number) => targetable(e, faceUpMonsters(e)).filter((m) => e.atkOf(m) <= n * 700);
  E['Blast Magician'] = {
    quick: {
      label: 'place a Spell Counter',
      repeat: true,
      can: (e, _card, _p, t, ctx) => t === 'spell' && !!ctx.link && isSpell(e, ctx.link.card),
      *run(e, card) {
        const m = e.fieldCard(card.uid);
        if (!m?.faceUp) return;
        m.counters++;
        e.log(null, `A Spell Counter is placed on Blast Magician (${m.counters})`);
      },
    },
    ignition: {
      repeat: true,
      can: (e, m) => m.counters > 0 && blastTargets(e, m.counters).length > 0,
      *run(e, m, p) {
        const t = yield* pickOne(e, p, 'Blast Magician: destroy which monster?', blastTargets(e, m.counters), true);
        if (!t || !e.fieldCard(m.uid)) return;
        const n = Math.max(1, Math.ceil(e.atkOf(t) / 700));
        m.counters -= n;
        e.log(p, `Blast Magician removes ${n} Spell Counter${n > 1 ? 's' : ''}`);
        if (e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
      },
    },
  };

  const blsMonster = (e: Engine, c: Card) => isMonster(e, c) && named(e, c, 'Black Luster Soldier');
  E['Charging Gaia the Fierce Knight'] = {
    handIgnition: {
      can: (e, c, p) => !e.player(p).normalSummoned && freeMZ(e, p) && !e.summonBlocked(p, c, 'normal', 'hand') && !e.chainEnergyBlocks(p),
      *run(e, c, p) {
        e.log(p, 'Charging Gaia the Fierce Knight is Normal Summoned without Tributing');
        yield* normalSummonNow(e, c.uid, p, { noTribute: 1 });
      },
    },
    baseStats: (e, m) => (m.tags?.noTribute ? { atk: 1900, def: info(e, m).def ?? 0 } : undefined),
    *onSentToGrave(e, _card, owner, _from, reason) {
      if (reason !== 'tribute' || !e.oncePerTurn('Charging Gaia the Fierce Knight', owner) || !e.player(owner).deck.some((c) => blsMonster(e, c))) return;
      if (!(yield* e.yesno(owner, 'Charging Gaia the Fierce Knight: add a "Black Luster Soldier" monster from your Deck?'))) return;
      e.useOnce('Charging Gaia the Fierce Knight', owner);
      yield* searchDeck(e, owner, 'Add which "Black Luster Soldier" monster?', (c) => blsMonster(e, c));
    },
  };

  // Used during the Main Phase of the turn you drew it (the engine has no "when you draw this card" moment). Its name change only matters for Synchro Summons.
  const CWD = 'Converging Wills Dragon:ss';
  E['Converging Wills Dragon'] = {
    selfSummonBlock: (e, _c, p, how) => how === 'special' && !e.oncePerTurn(CWD, p),
    handIgnition: {
      can: (e, c, p) => freeMZ(e, p) && drawnThisTurn(e, p, c.uid) && !e.summonBlocked(p, c, 'special', 'hand'),
      *run(e, c, p) {
        e.log(p, `${e.player(p).name} reveals Converging Wills Dragon`);
        yield* e.specialSummon(c.uid, p, 'atk');
        if (!inZone(e, c.uid, 'mz')) return;
        const synchro = faceUpMonsters(e, p).some((m) => info(e, m).sub === 'Synchro' && raceOf(e, m) === 'Dragon' && levelOf(e, m) >= 8);
        const ones = e.player(p).deck.filter((x) => mainMonster(e, x) && info(e, x).race === 'Dragon' && (info(e, x).level ?? 0) === 1);
        if (synchro && ones.length && freeMZ(e, p) && (yield* e.yesno(p, 'Converging Wills Dragon: Special Summon a Level 1 Dragon from your Deck?'))) yield* summonOneOf(e, p, 'Special Summon which Level 1 Dragon?', ones);
      },
    },
    *onSpecialSummon(e, _m, p) {
      e.useOnce(CWD, p);
    },
  };

  E['D.D. Survivor'] = {
    *onLeaveField(e, fc, controller, reason) {
      if (reason === 'banished' && fc.faceUp && fc.owner === controller) fxm<Record<number, number>>(e, 'ddSurvivor', {})[fc.uid] = e.state.turn;
    },
    *onEndPhaseBanished(e, card, owner) {
      const marks = fxm<Record<number, number>>(e, 'ddSurvivor', {});
      if (marks[card.uid] !== e.state.turn || !e.oncePerTurn(`D.D. Survivor:${card.uid}`, owner) || !freeMZ(e, owner)) return;
      e.useOnce(`D.D. Survivor:${card.uid}`, owner);
      delete marks[card.uid];
      e.log(owner, 'D.D. Survivor returns from banishment');
      yield* e.specialSummon(card.uid, owner, 'atk');
    },
  };

  E['Des Wombat'] = {
    damageMod: (_e, _src, srcCtl, damaged, _amount, byEffect) => (byEffect && damaged === srcCtl ? 0 : undefined),
  };

  // Works with the shared Ritual Spells (Black Magic Ritual, Zera Ritual, Curse of the Masked Beast...), which record their materials.
  E['Djinn Prognosticator of Rituals'] = {
    ritualFromGrave: true,
    *onAllyBattleDamageOffField(e, card, owner, attacker) {
      const rec = ((e.state.fx.ritualMats ?? {}) as Record<number, { mats: number[]; turn: number }>)[attacker.uid];
      if (!rec || rec.turn !== attacker.placedTurn || !rec.mats.includes(card.uid)) return;
      const opp = other(owner);
      if (!e.player(opp).hand.length) return;
      e.log(owner, `Djinn Prognosticator of Rituals: ${e.player(opp).name} discards 1 card`);
      const c = yield* pickOne(e, opp, 'Djinn Prognosticator of Rituals: discard 1 card', e.player(opp).hand);
      if (c) yield* e.discard(opp, c.uid);
    },
  };

  const gainerTargets = (e: Engine, m: FieldCard, p: Pid) => targetable(e, faceUpMonsters(e, p).filter((x) => x.uid !== m.uid && raceOf(e, x) === 'Fiend'));
  E['Evil HERO Infernal Gainer'] = {
    ignition: {
      can: (e, m, p) => e.state.phase === 'M1' && gainerTargets(e, m, p).length > 0,
      *run(e, m, p) {
        if (!e.fieldCard(m.uid)) return;
        e.banish(m.uid);
        fxm<Record<number, number>>(e, 'gainer', {})[m.uid] = 0;
        const t = yield* pickOne(e, p, 'Evil HERO Infernal Gainer: which Fiend can attack twice?', gainerTargets(e, m, p).filter((x) => e.fieldCard(x.uid)));
        if (!t) return;
        tag(t).extraAttacks = (t.tags?.extraAttacks ?? 0) + 1;
        e.log(p, `${t.name} can make a second attack during each Battle Phase`);
      },
    },
    *onStandbyBanished(e, card, owner) {
      const recs = fxm<Record<number, number>>(e, 'gainer', {});
      if (recs[card.uid] === undefined) return;
      recs[card.uid]++;
      if (recs[card.uid] < 2) return;
      delete recs[card.uid];
      if (!freeMZ(e, owner)) return;
      e.log(owner, 'Evil HERO Infernal Gainer returns');
      yield* e.specialSummon(card.uid, owner, 'atk');
    },
  };

  const lightMachine = (e: Engine, c: Card) => mainMonster(e, c) && attrOf(e, c) === 'LIGHT' && info(e, c).race === 'Machine' && (info(e, c).atk ?? 0) <= 1200;
  function* falchion(e: Engine, p: Pid): Step {
    const canMill = e.player(p).deck.some((c) => lightMachine(e, c));
    const canRevive = freeMZ(e, p) && e.player(p).gy.some((c) => lightMachine(e, c));
    const labels = [...(canMill ? ['Send a LIGHT Machine from your Deck to the GY'] : []), ...(canRevive ? ['Special Summon a LIGHT Machine from your GY'] : [])];
    if (!labels.length) return;
    const k = labels.length > 1 ? yield* chooseOption(e, p, 'Falchion Beta: activate which effect?', labels) : 0;
    if (k === null) return;
    if (labels[k].startsWith('Send')) yield* deckToGrave(e, p, 'Falchion Beta: send which monster?', (c) => lightMachine(e, c));
    else yield* summonOneOf(e, p, 'Falchion Beta: Special Summon which monster?', e.player(p).gy.filter((c) => lightMachine(e, c)));
  }
  E['Falchion Beta'] = {
    *afterBattle(e, _a, t, p, destroyed) {
      if (destroyed && t) yield* falchion(e, p);
    },
    *onAttacked(e, me, attacker, p) {
      if (e.fieldCard(me.uid) && !e.fieldCard(attacker.uid) && inZone(e, attacker.uid, 'gy')) yield* falchion(e, p);
    },
  };

  // The Draw Phase search is offered in the Standby Phase: the card just drawn goes back on top of the Deck, which is then shuffled by the search.
  const freedWarrior = (e: Engine, c: Card) => mainMonster(e, c) && info(e, c).race === 'Warrior' && (info(e, c).level ?? 0) <= 4;
  E['Freed the Matchless General'] = {
    *onChainLink(e, m, p, link) {
      if (info(e, link.card).kind !== 'spell' || link.targetUid !== m.uid) return;
      negateLink(e, link, p);
      if (link.negated && e.fieldCard(link.card.uid)) {
        e.log(p, `Freed the Matchless General destroys ${link.card.name}`);
        yield* e.destroy([link.card.uid]);
      }
    },
    *onStandby(e, _m, p) {
      if (e.state.turnPlayer !== p) return;
      const drawn = normalDraw(e, p);
      if (!drawn || !e.player(p).deck.some((c) => freedWarrior(e, c))) return;
      if (!(yield* e.yesno(p, `Freed the Matchless General: add a Level 4 or lower Warrior instead of your normal draw (${drawn.name} goes back)?`))) return;
      e.toDeckTop(drawn.uid);
      e.log(p, `${e.player(p).name} gives up the normal draw`);
      yield* searchDeck(e, p, 'Freed: add which Level 4 or lower Warrior?', (c) => freedWarrior(e, c));
    },
  };

  const puppets = (e: Engine, m: FieldCard, p: Pid) => targetable(e, faceUpMonsters(e, p).filter((x) => x.uid !== m.uid && named(e, x, 'Gimmick Puppet')));
  E['Gimmick Puppet Gear Changer'] = {
    selfSummonBlock: (_e, _c, _p, how, from) => how === 'special' && from === 'deck',
    ignition: {
      can: (e, m, p) => puppets(e, m, p).length > 0,
      *run(e, m, p) {
        const t = yield* pickOne(e, p, 'Gimmick Puppet Gear Changer: copy the Level of which monster?', puppets(e, m, p));
        if (!t || !e.fieldCard(m.uid)?.faceUp) return;
        const lv = levelOf(e, t);
        ((e.state.fx.declLevel ??= {}) as Record<number, number>)[m.uid] = lv;
        e.log(p, `Gimmick Puppet Gear Changer becomes Level ${lv}`);
      },
    },
    *onLeaveField(e, fc) {
      if (e.state.fx.declLevel) delete (e.state.fx.declLevel as Record<number, number>)[fc.uid];
    },
  };

  // "At the end of your opponent's Battle Phase" is applied in their End Phase.
  E['Helpoemer'] = {
    selfSummonBlock: (_e, _c, _p, how, from) => how === 'special' && from === 'gy',
    *onDestroyed(e, card, _p, byBattle) {
      const marks = fxm<Record<number, number>>(e, 'helpoemer', {});
      if (byBattle) marks[card.uid] = 1;
      else delete marks[card.uid];
    },
    *onSentToGrave(e, card, _owner, _from, reason) {
      if (reason !== 'destroyed') delete fxm<Record<number, number>>(e, 'helpoemer', {})[card.uid];
    },
    *onEndPhaseInGrave(e, card, owner) {
      if (!fxm<Record<number, number>>(e, 'helpoemer', {})[card.uid] || e.state.turnPlayer === owner || e.state.firstTurn) return;
      const opp = other(owner);
      const hand = e.player(opp).hand;
      if (!hand.length) return;
      const c = hand[Math.floor(e.rand() * hand.length)];
      e.log(owner, `Helpoemer: ${e.player(opp).name} discards a random card`);
      yield* e.discard(opp, c.uid);
    },
  };

  // Its name becomes the sent Knight's name until the End Phase (renameUntilEnd).
  const KNIGHTS = ["Queen's Knight", "King's Knight", "Jack's Knight"];
  const lightWarriorsIn = (e: Engine, p: Pid, except: number) => e.player(p).gy.filter((c) => c.uid !== except && isMonster(e, c) && attrOf(e, c) === 'LIGHT' && info(e, c).race === 'Warrior');
  E["Joker's Knight"] = {
    handIgnition: {
      can: (e, c, p) => e.oncePerTurn("Joker's Knight:1", p) && freeMZ(e, p) && e.player(p).deck.some((x) => e.namesOf(x).some((nm) => KNIGHTS.includes(nm))) && !e.summonBlocked(p, c, 'special', 'hand'),
      *run(e, c, p) {
        const sent = yield* deckToGrave(e, p, "Joker's Knight: send which Knight to the GY?", (x) => e.namesOf(x).some((nm) => KNIGHTS.includes(nm)));
        if (!sent) return;
        e.useOnce("Joker's Knight:1", p);
        if (inZone(e, c.uid, 'hand') && freeMZ(e, p)) {
          yield* e.specialSummon(c.uid, p, 'atk');
          const me = e.fieldCard(c.uid);
          if (me) {
            e.renameUntilEnd(me.uid, sent.name);
            e.log(p, `Joker's Knight's name becomes "${sent.name}" until the End Phase`);
          }
        }
      },
    },
    *onEndPhaseInGrave(e, card, owner) {
      const list = lightWarriorsIn(e, owner, card.uid);
      if (!list.length || !e.oncePerTurn("Joker's Knight:2", owner)) return;
      if (!(yield* e.yesno(owner, "Joker's Knight: shuffle a LIGHT Warrior from your GY into the Deck to add this card to your hand?"))) return;
      const t = yield* pickOne(e, owner, 'Shuffle which LIGHT Warrior into the Deck?', list);
      if (!t) return;
      e.useOnce("Joker's Knight:2", owner);
      shuffleBack(e, t.uid);
      if (!inZone(e, t.uid, 'gy') && inZone(e, card.uid, 'gy')) {
        e.toHandOf(card.uid, owner);
        e.log(owner, `${e.player(owner).name} adds Joker's Knight to the hand`);
      }
    },
  };

  E['Magical Reflect Slime'] = {
    ...gemini(),
    reflectBattleDamage: (_e, m) => geminiOn(m),
  };

  E['Marauding Captain'] = {
    guardsAttack: (e, src, target) => target.uid !== src.uid && target.faceUp && raceOf(e, target) === 'Warrior',
    *onSummon(e, _m, p, kind) {
      if (kind !== 'normal') return;
      const list = e.player(p).hand.filter((c) => mainMonster(e, c) && (info(e, c).level ?? 0) <= 4);
      if (!list.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Marauding Captain: Special Summon a Level 4 or lower monster from your hand?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which monster?', list);
    },
  };

  E['Morpho Butterspy'] = {
    *onAnyPositionChange(e, me, p, m, mp) {
      if (mp !== other(p) || e.state.battle || !m.faceUp || !e.fieldCard(m.uid) || e.untargetable(m) || !e.oncePerTurn(`Morpho Butterspy:${me.uid}`, p)) return;
      if (!(yield* e.yesno(p, `Morpho Butterspy: ${m.name} loses 1000 ATK and DEF?`))) return;
      e.useOnce(`Morpho Butterspy:${me.uid}`, p);
      boostPerm(m, -1000, -1000);
      e.log(p, `${m.name} loses 1000 ATK and DEF`);
    },
  };

  // Both effects need Pendulum Zones, which Speed Duel does not have: it plays as a monster with no usable effect.
  E['Performapal Extra Slinger'] = {};

  /** Does this activation look like it destroys a monster on the field? */
  const destroysMonster = (e: Engine, link: ChainLink) => {
    if (!allMonsters(e).length) return false;
    const desc = info(e, link.card).desc;
    if (!/destroy/i.test(desc)) return false;
    const t = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
    return t ? inZone(e, t.uid, 'mz') : /monster/i.test(desc);
  };
  E['Prime Material Dragon'] = {
    damageMod: (_e, _src, _ctl, _damaged, amount, byEffect) => (byEffect ? -amount : undefined),
    quick: {
      label: 'send a card from your hand to the GY: negate it and destroy it',
      repeat: true,
      can: (e, card, p, t, ctx) => (t === 'spell' || t === 'trap' || t === 'effect') && !!ctx.link && !ctx.link.negated && ctx.link.card.uid !== card.uid && e.player(p).hand.length > 0 && destroysMonster(e, ctx.link),
      *cost(e, _card, p) {
        const c = yield* pickOne(e, p, 'Prime Material Dragon: send which card from your hand to the GY?', e.player(p).hand, true);
        if (!c) return false;
        yield* e.sendToGrave(c.uid, 'cost');
      },
      *run(e, _card, p, link) {
        const target = (link.payload as { ctx?: ChainCtx }).ctx?.link;
        if (!target) return;
        negateLink(e, target, p);
        if (target.negated && e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
      },
    },
  };

  E['Ritual Raven'] = {
    ritualLevel: (e, _card, ritual) => (attrOf(e, ritual) === 'DARK' ? info(e, ritual).level ?? 1 : undefined),
  };

  // The negation of the effects of monsters it destroys by battle is not applied.
  const archfiendBy = (e: Engine, c: Card, p: Pid) => faceUpMonsters(e, p).some((m) => m.uid !== c.uid && named(e, m, 'Archfiend'));
  E['Terrorking Archfiend'] = {
    selfSummonBlock: (e, c, p, how) => (how === 'normal' || how === 'flip') && !archfiendBy(e, c, p),
    *onStandby(e, _m, p) {
      if (e.state.turnPlayer !== p) return;
      e.log(p, 'Terrorking Archfiend: 800 LP');
      e.payLp(p, 800);
    },
    *onChainLink(e, m, p, link) {
      if (link.player !== other(p) || link.targetUid !== m.uid) return;
      const r = e.roll(6);
      e.log(p, `Terrorking Archfiend rolls a ${r}`);
      if (r !== 2 && r !== 5) return;
      negateLink(e, link, p);
      if (link.negated && link.card.uid !== m.uid && e.fieldCard(link.card.uid)) yield* e.destroy([link.card.uid]);
    },
  };

  E['Twin-Headed Wolf'] = {
    negatesBattleFlip: (e, a) => {
      const p = e.controller(a.uid);
      return p !== null && faceUpMonsters(e, p).some((m) => m.uid !== a.uid && raceOf(e, m) === 'Fiend');
    },
  };

  E['Warrior of Atlantis'] = {
    handIgnition: {
      can: (e, _c, p) => e.player(p).deck.some((c) => e.isNamed(c, 'A Legendary Ocean')),
      *run(e, c, p) {
        yield* e.discard(p, c.uid);
        yield* searchDeck(e, p, 'Add "A Legendary Ocean"', (x) => e.isNamed(x, 'A Legendary Ocean'));
      },
    },
  };

  // ===================== Fusion Monsters =====================
  // "Fusion Summoned" is taken to be any copy on the field; it protects against all of the opponent's targeting.
  const brigrandPick = (e: Engine, c: Card) => isMonster(e, c) && (named(e, c, 'Tri-Brigade') || e.isNamed(c, 'Fallen of Albaz'));
  E['Brigrand the Glory Dragon'] = {
    battleProof: () => true,
    shields: (e, src, target, how, srcCtl) => how === 'target' && target.uid !== src.uid && e.controller(target.uid) === srcCtl && e.actor === other(srcCtl),
    *onSentToGrave(e, card) {
      fxm<Record<number, number>>(e, 'brigrand', {})[card.uid] = e.state.turn;
    },
    *onEndPhaseInGrave(e, card, owner) {
      if (fxm<Record<number, number>>(e, 'brigrand', {})[card.uid] !== e.state.turn || !e.oncePerTurn('Brigrand the Glory Dragon', owner)) return;
      const list = e.player(owner).deck.filter((c) => brigrandPick(e, c));
      if (!list.length || !(yield* e.yesno(owner, 'Brigrand the Glory Dragon: add or Special Summon a "Tri-Brigade" monster or "Fallen of Albaz" from your Deck?'))) return;
      e.useOnce('Brigrand the Glory Dragon', owner);
      const c = yield* pickOne(e, owner, 'Brigrand the Glory Dragon: which monster?', list);
      if (!c) return;
      const canSummon = freeMZ(e, owner) && !e.summonBlocked(owner, c, 'special', 'deck');
      const k = canSummon ? yield* chooseOption(e, owner, `${c.name}:`, ['Add it to your hand', 'Special Summon it']) : 0;
      if (k === 1) yield* e.specialSummon(c.uid, owner, 'atk');
      else {
        e.toHandOf(c.uid, owner);
        e.log(owner, `${e.player(owner).name} adds ${c.name} to the hand`);
      }
      e.player(owner).deck = e.shuffle(e.player(owner).deck);
    },
  };

  const dhero = (e: Engine, c: Card) => isMonster(e, c) && named(e, c, 'Destiny HERO');
  E['Destiny HERO - Dangerous'] = {
    quick: {
      label: 'discard 1 card: send a "Destiny HERO" to the GY; your "Destiny HERO" monsters gain ATK',
      can: (e, _card, p) => e.oncePerTurn('Destiny HERO - Dangerous', p) && e.player(p).hand.length > 0 && [...e.player(p).hand, ...e.player(p).deck].some((c) => dhero(e, c)),
      *cost(e, _card, p) {
        if (!(yield* discardCost(e, p, 1))) return false;
        e.useOnce('Destiny HERO - Dangerous', p);
      },
      *run(e, _card, p) {
        const list = [...e.player(p).hand, ...e.player(p).deck].filter((c) => dhero(e, c));
        const c = yield* pickOne(e, p, 'Destiny HERO - Dangerous: send which "Destiny HERO" to the GY?', list);
        if (!c) return;
        const fromDeck = inZone(e, c.uid, 'deck');
        yield* e.sendToGrave(c.uid, 'used');
        if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
        if (!inZone(e, c.uid, 'gy')) return;
        const n = e.player(p).gy.filter((x) => dhero(e, x)).length;
        for (const m of faceUpMonsters(e, p).filter((x) => named(e, x, 'Destiny HERO'))) boostTurn(m, 200 * n);
        e.log(p, `"Destiny HERO" monsters gain ${200 * n} ATK`);
      },
    },
  };

  // Its Contact Fusion summoning condition is left to the engine (it is Summoned like any Fusion Monster).
  const neosTargets = (e: Engine, m: FieldCard) => targetable(e, faceUpMonsters(e).filter((x) => x.uid !== m.uid && isEffectMonster(e, x) && !e.isNegated(x)));
  const neosTarget = (e: Engine, m: FieldCard) => {
    const t = m.tags?.darkNeos;
    const x = t !== undefined ? e.fieldCard(t) : null;
    return x && x.faceUp && x.tags?.dnBy === m.uid ? x : null;
  };
  E['Elemental HERO Dark Neos'] = {
    ignition: {
      repeat: true,
      can: (e, m) => !neosTarget(e, m) && neosTargets(e, m).length > 0,
      *run(e, m, p) {
        const t = yield* pickOne(e, p, 'Elemental HERO Dark Neos: negate the effects of which monster?', neosTargets(e, m), true);
        if (!t || !e.fieldCard(m.uid)?.faceUp) return;
        tag(m).darkNeos = t.uid;
        tag(t).negated = 1;
        tag(t).dnBy = m.uid;
        e.log(p, `${t.name}'s effects are negated while Elemental HERO Dark Neos is face-up`);
      },
    },
    *onLeaveField(e, fc) {
      const t = fc.tags?.darkNeos;
      const x = t !== undefined ? e.fieldCard(t) : null;
      if (x?.tags?.dnBy === fc.uid) {
        x.tags.negated = 0;
        delete x.tags.dnBy;
        e.log(null, `${x.name}'s effects are no longer negated`);
      }
    },
    *onEndPhase(e, m) {
      if (!e.fieldCard(m.uid)) return;
      e.log(e.controller(m.uid), 'Elemental HERO Dark Neos is shuffled into the Extra Deck');
      toExtra(e, m.uid);
      yield* e.flushLeaves();
    },
  };

  E['Evil HERO Dark Gaia'] = {
    selfSummonBlock: (_e, _c, _p, how, from) => how === 'special' && from !== 'fusion',
    baseStats: (e, m) => {
      const mats = ((e.state.fx.fusionMatList ?? {}) as Record<number, number[]>)[m.uid];
      const atk = mats ? mats.reduce((a, u) => a + Math.max(0, info(e, e.find(u)?.card.name ?? '').atk ?? 0), 0) : 0;
      return { atk, def: info(e, m).def ?? 0 };
    },
    attackCost: {
      can: () => true,
      *pay(e, _m, p) {
        const list = e.monsters(other(p)).filter((x) => x.pos === 'def');
        if (!list.length || !(yield* e.yesno(p, 'Evil HERO Dark Gaia: change all Defense Position monsters your opponent controls to face-up Attack Position?'))) return;
        for (const x of list) {
          x.pos = 'atk';
          if (!x.faceUp) {
            x.faceUp = true;
            e.event('flip', { uid: x.uid, player: other(p) });
          }
        }
        e.log(p, "The opponent's Defense Position monsters change to face-up Attack Position");
      },
    },
  };

  // ===================== Ritual Monsters =====================
  // The Draw Phase search is used in the Main Phase: the card drawn for the turn goes back on top of the Deck (the search shuffles it).
  // "Cannot activate during your Battle Phase" is applied as "negated as they resolve".
  const ritualSpell = (e: Engine, c: Card) => isSpell(e, c) && info(e, c).sub === 'Ritual';
  const ritualWithNormal = (e: Engine, m: FieldCard) => {
    const rec = ((e.state.fx.ritualMats ?? {}) as Record<number, { mats: number[]; turn: number }>)[m.uid];
    if (!rec || rec.turn !== m.placedTurn) return true; // Summoned by a Ritual Spell that does not record materials (Advanced Ritual Art uses Normal Monsters)
    return rec.mats.some((u) => {
      const c = e.find(u)?.card;
      return !!c && info(e, c).sub === 'Normal';
    });
  };
  E['Black Luster Soldier - Legendary Swordsman'] = {
    handIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Legendary Swordsman:draw', p) && !!normalDraw(e, p) && e.player(p).deck.some((c) => ritualSpell(e, c)),
      *run(e, c, p) {
        const drawn = normalDraw(e, p);
        if (!drawn) return;
        e.useOnce('Legendary Swordsman:draw', p);
        e.log(p, `${e.player(p).name} reveals ${c.name} and gives up the normal draw`);
        e.toDeckTop(drawn.uid);
        yield* searchDeck(e, p, 'Add which Ritual Spell?', (x) => ritualSpell(e, x));
      },
    },
    *onChainLink(e, _m, p, link) {
      if (e.state.phase !== 'BP' || e.state.turnPlayer !== p || link.player !== other(p)) return;
      e.log(p, `${link.card.name} cannot be activated during the Battle Phase of Black Luster Soldier - Legendary Swordsman's controller`);
      negateLink(e, link, p);
    },
    *afterBattle(e, a, t, p, destroyed) {
      if (!destroyed || !t || !ritualWithNormal(e, a)) return;
      const cards = [...e.monsters(other(p)), ...stOf(e, other(p))];
      if (!cards.length || !(yield* e.yesno(p, "Legendary Swordsman: shuffle all cards your opponent controls into the Deck?"))) return;
      for (const c of cards) if (e.fieldCard(c.uid)) shuffleBack(e, c.uid);
      e.log(p, "All cards the opponent controls are shuffled into the Deck");
    },
  };

  // ===================== Spells =====================
  // "Normal Summoned/Set" cannot be told apart from Special Summons: any monster that is not a Fusion or Ritual Monster can take it.
  E['Bashing Shield'] = h.equipFor((e, m) => !isExtraOrRitual(e, m), () => ({ atk: 1000, def: 0 }), { hostNoBattleDamage: () => true });

  // 2+: the halving is offered when an attack is declared and applies to that battle.
  const cbInST = (e: Engine, p: Pid) => e.spells(p).filter((c) => c.faceUp && named(e, c, 'Crystal Beast') && info(e, c).kind === 'monster');
  const cbCount = (e: Engine, p: Pid) => cbInST(e, p).length;
  const cbMonsters = (e: Engine, p: Pid) => faceUpMonsters(e, p).filter((m) => named(e, m, 'Crystal Beast'));
  const RR = 'Ancient City - Rainbow Ruins';
  E[RR] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    effectProof: (e, fc) => cbCount(e, ctrl(e, fc)) >= 1,
    damageMod: (e, _src, ctl, damaged, amount, byEffect) => (!byEffect && damaged === ctl && (e.state.fx.rainbowHalf as number[] | undefined)?.[ctl] === e.state.fx.battleNo ? Math.floor(amount / 2) : undefined),
    quick: {
      label: 'use its effect',
      repeat: true,
      can: (e, card, p, t, ctx) => {
        const n = cbCount(e, p);
        if (t === 'attack' && n >= 2 && !!e.state.battle && e.oncePerTurn(`${RR}:2:${card.uid}`, p)) return true;
        return (t === 'spell' || t === 'trap') && n >= 3 && !!ctx.link && !ctx.link.negated && !isEffectLink(ctx.link) && cbMonsters(e, p).length > 0;
      },
      *cost(e, card, p, link) {
        const t = (link.payload as { trigger?: string }).trigger;
        if (t === 'attack') {
          e.useOnce(`${RR}:2:${card.uid}`, p);
          return;
        }
        const m = yield* pickOne(e, p, 'Rainbow Ruins: send which "Crystal Beast" monster to the GY?', cbMonsters(e, p), true);
        if (!m) return false;
        yield* e.sendToGrave(m.uid, 'cost');
      },
      *run(e, _card, p, link) {
        const { trigger, ctx } = link.payload as { trigger?: string; ctx?: ChainCtx };
        if (trigger === 'attack') {
          ((e.state.fx.rainbowHalf ??= [-1, -1]) as number[])[p] = e.state.fx.battleNo ?? 0;
          e.log(p, `${e.player(p).name} will take half the battle damage from this battle`);
          return;
        }
        const target = ctx?.link;
        if (!target) return;
        negateLink(e, target, p);
        if (target.negated && e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
      },
    },
    ignition: {
      repeat: true,
      can: (e, fc, p) => (cbCount(e, p) >= 4 && e.oncePerTurn(`${RR}:4:${fc.uid}`, p) && e.player(p).deck.length > 0) || (cbCount(e, p) >= 5 && e.oncePerTurn(`${RR}:5:${fc.uid}`, p) && freeMZ(e, p)),
      *run(e, fc, p) {
        const can4 = cbCount(e, p) >= 4 && e.oncePerTurn(`${RR}:4:${fc.uid}`, p) && e.player(p).deck.length > 0;
        const can5 = cbCount(e, p) >= 5 && e.oncePerTurn(`${RR}:5:${fc.uid}`, p) && freeMZ(e, p);
        const labels = [...(can4 ? ['Draw 1 card'] : []), ...(can5 ? ['Special Summon a "Crystal Beast" from your Spell & Trap Zone'] : [])];
        const k = labels.length > 1 ? yield* chooseOption(e, p, 'Rainbow Ruins: use which effect?', labels, true) : 0;
        if (k === null || !labels[k]) return;
        if (labels[k] === 'Draw 1 card') {
          e.useOnce(`${RR}:4:${fc.uid}`, p);
          e.draw(p, 1);
          return;
        }
        const c = yield* pickOne(e, p, 'Rainbow Ruins: Special Summon which "Crystal Beast"?', cbInST(e, p), true);
        if (!c) return;
        e.useOnce(`${RR}:5:${fc.uid}`, p);
        const host = c.equippedTo !== undefined ? e.fieldCard(c.equippedTo) : null;
        if (host) host.equips = host.equips.filter((u) => u !== c.uid);
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
  };

  // Its Ritual and Fusion effects are offered right after the Summon (Synchro and Xyz Summons do not exist here).
  const zefra = (e: Engine, c: Card) => isMonster(e, c) && named(e, c, 'Zefra');
  const hasZefra = (e: Engine, uids: number[] | undefined) => !!uids?.some((u) => {
    const c = e.find(u)?.card;
    return !!c && zefra(e, c);
  });
  E['Oracle of Zefra'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.oncePerTurn('Oracle of Zefra', p),
    *activate(e, _link, p) {
      e.useOnce('Oracle of Zefra', p);
    },
    *resolve(e, _link, p) {
      if (e.player(p).deck.some((c) => zefra(e, c))) yield* searchDeck(e, p, 'Oracle of Zefra: add which "Zefra" monster?', (c) => zefra(e, c));
    },
    *stateCheck(e, fc, p) {
      for (const m of faceUpMonsters(e, p)) {
        if (m.placedTurn !== e.state.turn || m.tags?.oracle) continue;
        const sub = info(e, m).sub;
        const rit = ((e.state.fx.ritualMats ?? {}) as Record<number, { mats: number[]; turn: number }>)[m.uid];
        const fus = ((e.state.fx.fusionMatList ?? {}) as Record<number, number[]>)[m.uid];
        if (sub === 'Ritual' && rit?.turn === e.state.turn && hasZefra(e, rit.mats)) {
          tag(m).oracle = 1;
          const list = targetable(e, allMonsters(e));
          if (!e.oncePerTurn('Oracle of Zefra:R', p) || !list.length || !(yield* e.yesno(p, 'Oracle of Zefra: shuffle 1 monster on the field into the Deck?'))) continue;
          e.useOnce('Oracle of Zefra:R', p);
          const t = yield* pickOne(e, p, 'Oracle of Zefra: shuffle which monster into the Deck?', list);
          if (t && e.fieldCard(t.uid) && e.fieldCard(fc.uid)) {
            e.log(p, `Oracle of Zefra shuffles ${label(t)} into the Deck`);
            shuffleBack(e, t.uid);
          }
        } else if (sub === 'Fusion' && hasZefra(e, fus)) {
          tag(m).oracle = 1;
          const list = e.player(p).hand.filter((c) => mainMonster(e, c) && !e.summonBlocked(p, c, 'special', 'hand'));
          if (!e.oncePerTurn('Oracle of Zefra:F', p) || !list.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Oracle of Zefra: Special Summon 1 monster from your hand?'))) continue;
          e.useOnce('Oracle of Zefra:F', p);
          yield* summonOneOf(e, p, 'Oracle of Zefra: Special Summon which monster?', list);
        }
      }
    },
  };

  // Materials: "Fallen of Albaz" (or a Fusion substitute) and one monster matching the Fusion Monster's other material, from hand, Deck or field.
  const brandedPool = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.player(p).deck, ...e.monsters(p)].filter((c) => mainMonster(e, c));
  const brandedPlans = (e: Engine, p: Pid): TwoPlan[] => {
    const pool = brandedPool(e, p);
    const out: TwoPlan[] = [];
    for (const fusion of e.player(p).fusion) {
      if (!/"Fallen of Albaz"/.test(info(e, fusion).desc.split('\n')[0]) || e.summonBlocked(p, fusion, 'special', 'fusion')) continue;
      const b = secondSpec(e, fusion);
      if (!b) continue;
      const a = pool.filter((c) => e.isNamed(c, 'Fallen of Albaz') || !!e.effectOn(c)?.fusionSub);
      if (a.some((x) => pool.some((y) => y.uid !== x.uid && b(y)))) out.push({ fusion, a, b });
    }
    return out;
  };
  E['Branded Fusion'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.oncePerTurn('Branded Fusion', p) && brandedPlans(e, p).length > 0,
    *activate(e, link, p) {
      const plans = brandedPlans(e, p);
      const f = yield* pickOne(e, p, 'Branded Fusion: Fusion Summon which monster?', plans.map((x) => x.fusion), true);
      if (!f) return false;
      const plan = plans.find((x) => x.fusion.uid === f.uid)!;
      const pool = brandedPool(e, p);
      const a = yield* pickOne(e, p, 'Branded Fusion: use which "Fallen of Albaz"?', plan.a.filter((x) => pool.some((y) => y.uid !== x.uid && plan.b(y))), true);
      if (!a) return false;
      const b = yield* pickOne(e, p, 'Branded Fusion: use which other material?', pool.filter((y) => y.uid !== a.uid && plan.b(y)), true);
      if (!b) return false;
      e.useOnce('Branded Fusion', p);
      link.payload = { fusion: f.uid, mats: [a.uid, b.uid] };
    },
    *resolve(e, link, p) {
      const { fusion, mats } = link.payload as { fusion: number; mats: number[] };
      if (!inZone(e, fusion, 'fusion') || mats.some((u) => !e.find(u))) return;
      const fromDeck = mats.some((u) => inZone(e, u, 'deck'));
      for (const u of mats) yield* e.sendToGrave(u, 'used');
      if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
      if (!freeMZ(e, p)) return;
      ((e.state.fx.fusionMatList ??= {}) as Record<number, number[]>)[fusion] = mats.slice();
      yield* e.specialSummon(fusion, p, 'atk');
      e.log(p, `${e.player(p).name} Fusion Summons ${e.find(fusion)?.card.name ?? 'a monster'}!`);
    },
  };

  // It attacks once for each monster the opponent controls (the same one may be attacked again), and cannot attack directly.
  // The negation of the destroyed monsters' effects is not applied.
  const waveCasters = (e: Engine, p: Pid) => targetable(e, faceUpMonsters(e, p).filter((m) => raceOf(e, m) === 'Spellcaster' && levelOf(e, m) >= 7));
  E['Diffusion Wave-Motion'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.monsters(other(p)).length > 0 && e.player(p).lp > 1000 && waveCasters(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Diffusion Wave-Motion: which Spellcaster?', waveCasters(e, p), true);
      if (!m) return false;
      e.payLp(p, 1000);
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = fieldTarget(e, link);
      if (!m || !m.faceUp || e.controller(m.uid) !== p) return;
      const n = e.monsters(other(p)).length;
      const t = tag(m);
      t.extraAttacksTurn = e.state.turn;
      t.extraAttacksN = Math.max(0, n - 1);
      t.noDirectTurn = e.state.turn;
      for (const o of e.monsters(p)) if (o.uid !== m.uid) tag(o).noAttackTurn = e.state.turn;
      e.log(p, `${m.name} must attack each of the opponent's monsters; other monsters cannot attack`);
    },
  };

  // It stays on the field until its controller's next Standby Phase as a reminder (destroying it ends the effect early).
  E['Heat Wave'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.state.phase === 'M1' && e.state.turnPlayer === p,
    *resolve(e, link, p) {
      const fc = e.fieldCard(link.card.uid);
      if (!fc) return;
      fc.turns = 1;
      fc.active = true;
      e.log(p, 'Heat Wave: neither player can Normal or Special Summon Effect Monsters until the next Draw Phase');
    },
    forbidsSummon: (e, _fc, _p, monster, _who, how) => (how === 'normal' || how === 'special') && isEffectMonster(e, monster),
    *onStandby(e, fc, p) {
      if (e.state.turnPlayer !== p || fc.placedTurn === e.state.turn) return;
      e.log(p, 'Heat Wave wears off');
      yield* e.sendToGrave(fc.uid, 'used');
    },
  };

  // The "no other Spells/Traps or effects this turn" restriction is not applied.
  const CATTLE = ['Beast', 'Beast-Warrior', 'Winged Beast'];
  const cattleTypes = (e: Engine, p: Pid) => new Set(faceUpMonsters(e, p).map((m) => raceOf(e, m)).filter((r) => CATTLE.includes(r))).size;
  E['The Big Cattle Drive'] = {
    canActivate: (e, _c, p, t) => isMain(t) && cattleTypes(e, p) > 0 && e.player(p).deck.length >= cattleTypes(e, p),
    *resolve(e, _l, p) {
      const n = cattleTypes(e, p);
      if (n > 0) e.draw(p, n);
    },
  };

  // Net effect: +1000 this turn, then the 2000 it loses in the End Phase leaves it 1000 down for as long as it stays face-up.
  const scalesTargets = (e: Engine, p: Pid) => targetable(e, faceUpMonsters(e, p).filter((m) => !(e.state.battle?.attacker === m.uid && e.state.battle.target === null)));
  E['Berserk Scales'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && scalesTargets(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Berserk Scales: which monster?', scalesTargets(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = fieldTarget(e, link);
      if (!m || !m.faceUp || e.controller(m.uid) !== p) return;
      boostPerm(m, -1000);
      boostTurn(m, 2000);
      tag(m).noDirectTurn = e.state.turn;
      e.log(p, `${m.name} gains 1000 ATK and cannot attack directly this turn (it loses 2000 ATK in the End Phase)`);
    },
  };

  // ===================== Traps =====================
  // Negating the Normal Summon effect negates that monster's effects for the rest of the turn.
  E['By Order of the Emperor'] = {
    ...continuousTrap(),
    quick: {
      label: 'negate the Normal Summon effect',
      repeat: true,
      can: (e, _card, _p, t, ctx) => {
        if (t !== 'summon' || ctx.summonKind !== 'normal' || ctx.uid === undefined) return false;
        const m = e.fieldCard(ctx.uid);
        return !!m && m.faceUp && !e.isNegated(m) && !!e.effectOn(m)?.onSummon && /Normal Summoned/i.test(info(e, m).desc);
      },
      *run(e, _card, p, link) {
        const ctx = (link.payload as { ctx?: ChainCtx }).ctx;
        const m = ctx?.uid !== undefined ? e.fieldCard(ctx.uid) : null;
        if (!m) return;
        tag(m).negatedTurn = e.state.turn;
        const who = e.controller(m.uid) ?? p;
        e.log(p, `By Order of the Emperor negates ${m.name}'s effect; ${e.player(who).name} draws 1 card`);
        e.draw(who, 1);
      },
    },
  };

  // Answers an opponent's card or effect whose text deals damage; the damage that card deals to you as it resolves goes to them instead.
  E['Barrel Behind the Door'] = {
    canActivate: (e, _c, p, t, ctx) => (t === 'spell' || t === 'trap' || t === 'effect') && !!ctx.link && ctx.link.player === other(p) && !ctx.link.negated && /damage/i.test(info(e, ctx.link.card).desc),
    *activate(_e, link, _p, ctx) {
      link.payload = ctx.link;
    },
    *resolve(e, link, p) {
      const target = link.payload as ChainLink | undefined;
      if (!target) return;
      e.state.fx.reflectEffectDamage = { p, src: target.card.uid, turn: e.state.turn };
      e.log(p, `Barrel Behind the Door: damage from ${target.card.name} goes to ${e.player(other(p)).name}`);
    },
  };

  // Needs an "Arcana Force" monster to take on another one's effect: card scripts are looked up by name, so this cannot be done.
  // Cipher Bit and Double Cipher need Xyz Monsters, which the engine does not support.

  const hornHosts = (e: Engine, p: Pid) => targetable(e, faceUpMonsters(e, p).filter((m) => raceOf(e, m) === 'Beast' || raceOf(e, m) === 'Beast-Warrior'));
  E['Horn of the Phantom Beast'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && hornHosts(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Horn of the Phantom Beast: equip to which monster?', hornHosts(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const host = fieldTarget(e, link);
      const fc = e.fieldCard(link.card.uid);
      if (!host || !fc || !host.faceUp || e.controller(host.uid) !== p) return;
      h.attachTo(e, fc, host.uid);
      e.log(p, `Horn of the Phantom Beast is equipped to ${host.name}`);
    },
    equipBonus: () => ({ atk: 800, def: 0 }),
    *hostAfterBattle(e, _eq, host, target) {
      const p = e.controller(host.uid);
      if (p === null || !target || target.owner === p || !inZone(e, target.uid, 'gy')) return;
      e.log(p, 'Horn of the Phantom Beast: draw 1 card');
      e.draw(p, 1);
    },
  };

  E['Massivemorph'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && targetable(e, faceUpMonsters(e, other(p))).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Massivemorph: which monster?', targetable(e, faceUpMonsters(e, other(p))), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = fieldTarget(e, link);
      if (!m || !m.faceUp || e.controller(m.uid) !== other(p)) return;
      boostPerm(m, e.atkOf(m), e.defOf(m));
      tag(m).noDirect = 1;
      e.log(p, `${m.name}'s ATK and DEF are doubled; it cannot attack directly`);
    },
  };

  // "Destroyed by its own effect" is the Cloudians' face-up Defense Position self-destruction, this turn.
  const selfDestroyedCloudians = (e: Engine, p: Pid) => {
    const names = new Set(
      e.state.log
        .filter((l) => l.turn === e.state.turn)
        .map((l) => l.text.match(/^(.+) is in face-up Defense Position and is destroyed$/)?.[1])
        .filter((n): n is string => !!n),
    );
    return e.player(p).gy.filter((c) => isMonster(e, c) && named(e, c, 'Cloudian') && e.namesOf(c).some((nm) => names.has(nm)));
  };
  E['Raging Cloudian'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && freeMZ(e, p) && selfDestroyedCloudians(e, p).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Raging Cloudian: Special Summon which "Cloudian"?', selfDestroyedCloudians(e, p), true);
      if (!c) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid === undefined || !inZone(e, link.targetUid, 'gy') || !freeMZ(e, p)) return;
      yield* e.specialSummon(link.targetUid, p, 'atk');
      const m = e.fieldCard(link.targetUid);
      if (!m) return;
      tag(m).fog = (m.tags?.fog ?? 0) + 1;
      e.log(p, `A Fog Counter is placed on ${m.name}`);
    },
  };

  // Offered at the next open moment of the turn the monster was Set.
  const freshSets = (e: Engine, p: Pid) => targetable(e, e.monsters(other(p)).filter((m) => !m.faceUp && m.placedTurn === e.state.turn));
  E['Shadow of Eyes'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && freshSets(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Shadow of Eyes: which Set monster?', freshSets(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = fieldTarget(e, link);
      if (!m || m.faceUp) return;
      m.faceUp = true;
      m.pos = 'atk';
      e.event('flip', { uid: m.uid, player: other(p) });
      e.log(p, `Shadow of Eyes changes ${m.name} to face-up Attack Position`);
    },
  };
}

