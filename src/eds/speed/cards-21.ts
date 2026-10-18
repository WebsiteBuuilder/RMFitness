// Speed Duel card scripts, batch 21: cards from the 2024 products (Speed Duel GX: Midterm Destruction,
// Speed Duel Tournament Pack 7, Speed Duel: Battle City Finals) that were missing from the game.
// This part: the Speed Duel GX: Midterm Destruction Dinosaur / Rock / "Fossil" cards (and White Veil, Reversal of Fate).
import type { EffectDef } from '../effects';
import type { SpeedHelpers } from './helpers';
import { anyTime, attrOf, ctrl, faceUpMonsters, freeMZ, freeST, info, isMain, isMonster, isNormalMonster, isSpell, isTrap, levelOf, named, other, pick, pickOne, raceOf, stOf, summonOneOf, tag, targetable } from './helpers';
import type { Card, ChainLink, Engine, FieldCard, Pid, Step } from './helpers';

// ---------- local helpers ----------
const fx = (e: Engine) => e.state.fx as Record<string, any>;
const map = <T,>(e: Engine, key: string): Record<number, T> => (fx(e)[key] ??= {});
const sub = (e: Engine, c: Card) => info(e, c).sub;
const zoneOf = (e: Engine, uid: number) => e.find(uid)?.loc.zone;
const dino = (e: Engine, c: Card) => isMonster(e, c) && raceOf(e, c) === 'Dinosaur';
const rock = (e: Engine, c: Card) => isMonster(e, c) && raceOf(e, c) === 'Rock';
/** A monster an effect can Special Summon from the GY / banishment (Extra Deck and Ritual Monsters need a proper Summon first). */
const revivable = (e: Engine, p: Pid, c: Card, from: string) => isMonster(e, c) && !['Fusion', 'Xyz', 'Synchro', 'Link', 'Ritual'].includes(sub(e, c)) && !e.summonBlocked(p, c, 'special', from);
/** "Fossil" Fusion Monsters. */
const fossilFusion = (e: Engine, c: Card) => isMonster(e, c) && sub(e, c) === 'Fusion' && named(e, c, 'Fossil');
/** "Fossil Fusion" itself, or a card that specifically lists it in its text. */
const listsFossilFusion = (e: Engine, c: Card) => e.isNamed(c, 'Fossil Fusion') || (info(e, c).desc ?? '').includes('"Fossil Fusion"');
const gyHasFossilFusion = (e: Engine, p: Pid) => e.player(p).gy.some((c) => e.isNamed(c, 'Fossil Fusion'));

/** Turns a face-up monster face-down in Defense Position (its Equip Cards are destroyed, its changes reset). */
function* setFaceDown(e: Engine, m: FieldCard): Step {
  for (const u of m.equips.slice()) if (e.fieldCard(u)) yield* e.sendToGrave(u, 'destroyed');
  if (!e.fieldCard(m.uid)) return;
  m.faceUp = false;
  m.pos = 'def';
  m.atkMod = 0;
  m.defMod = 0;
  m.tags = m.tags?.ssAt !== undefined ? { ssAt: m.tags.ssAt, ...(m.tags.ss !== undefined ? { ss: m.tags.ss } : {}) } : {};
  e.event('position', { uid: m.uid, player: e.controller(m.uid) ?? m.owner });
  e.log(null, `${m.name} is changed to face-down Defense Position`);
}

/** Places a card from the hand face-up in a Spell & Trap Zone (a Trap activated from the hand). */
function placeInST(e: Engine, uid: number, p: Pid): FieldCard | null {
  const z = freeST(e, p);
  const f = e.find(uid);
  if (z < 0 || !f || f.loc.zone !== 'hand') return null;
  e.player(f.loc.player).hand.splice(f.loc.index, 1);
  const c = f.card;
  const fc: FieldCard = { uid: c.uid, name: c.name, owner: c.owner, pos: 'atk', faceUp: true, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true };
  e.player(p).sz[z] = fc;
  e.event('set', { uid, player: p });
  e.log(p, `${e.player(p).name} activates ${c.name} from the hand`);
  return fc;
}

/**
 * "If this card is destroyed by battle or sent to the GY by a card effect": destroyed (by battle or effect) on the field,
 * or sent to the GY by an effect (milled, discarded by an effect, sent as a cost or as material). Tributes are left out.
 */
function battleOrEffect(run: (e: Engine, card: Card, p: Pid) => Step): Partial<EffectDef> {
  return {
    *onDestroyed(e, card, controller) {
      yield* run(e, card, card.owner === controller ? controller : card.owner);
    },
    *onSentToGrave(e, card, owner, from, reason) {
      if (reason === 'destroyed' && (from === 'mz' || from === 'sz')) return; // onDestroyed handles it
      if (reason === 'mill' || reason === 'cost' || reason === 'used' || reason === 'material' || reason === 'destroyed' || (reason === 'discard' && e.actor !== null)) yield* run(e, card, owner);
    },
  };
}

/** "For the rest of this turn, you cannot activate cards, or the effects of cards, with that name" (engine fx.turnNameLocks). */
function lockName(e: Engine, p: Pid, name: string) {
  const list = ((fx(e).turnNameLocks ??= []) as { p: Pid; name: string; turn: number }[]).filter((x) => x.turn === e.state.turn);
  list.push({ p, name, turn: e.state.turn });
  fx(e).turnNameLocks = list;
}

/** Is `uid` the attacker or the attack target of the current battle? */
const inBattle = (e: Engine, uid: number) => !!e.state.battle && (e.state.battle.attacker === uid || e.state.battle.target === uid);

export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  // ======================= Monsters =======================
  // "When this card is sent from your Deck to the GY": a mandatory trigger (once per turn): Special Summon it or add it to the hand.
  E['Revival Golem'] = {
    *onSentToGrave(e, card, owner, from) {
      if (from !== 'deck' || zoneOf(e, card.uid) !== 'gy' || !e.oncePerTurn('Revival Golem', owner)) return;
      e.useOnce('Revival Golem', owner);
      const canSummon = freeMZ(e, owner) && !e.summonBlocked(owner, card, 'special', 'gy');
      const choice = canSummon ? yield* e.select(owner, 'Revival Golem: activate which effect?', [{ label: 'Special Summon it from the GY' }, { label: 'Add it to your hand' }], 1, 1) : [1];
      if (zoneOf(e, card.uid) !== 'gy') return;
      if ((choice?.[0] ?? 0) === 0 && canSummon) yield* e.specialSummon(card.uid, owner, 'def');
      else {
        e.toHandOf(card.uid, owner);
        e.log(owner, `${e.player(owner).name} adds Revival Golem from the GY to the hand`);
      }
    },
  };

  // Sabersaurus is a Normal Monster: no script.

  E['Sauropod Brachion'] = {
    // "Cannot be Special Summoned from the Deck."
    summonRule: (_e, _c, _p, how, from) => !(how === 'special' && from === 'deck'),
    // "You can Tribute Summon this card face-up by Tributing 1 Dinosaur monster."
    tributeOffer: (e, src, _p, _card, need) => (src === null && need > 1 ? { need: 1, only: (m: FieldCard) => m.faceUp && e.raceOf(m) === 'Dinosaur' } : undefined),
    ignition: {
      can: (e, m, p) => m.faceUp && e.oncePerTurn(`Sauropod Brachion:${m.uid}`, p),
      *run(e, m, p) {
        e.useOnce(`Sauropod Brachion:${m.uid}`, p);
        if (e.fieldCard(m.uid)?.faceUp) yield* setFaceDown(e, m);
      },
    },
    *onSummon(e, m, _p, kind) {
      if (kind !== 'flip') return;
      for (const x of [...e.monsters(0), ...e.monsters(1)]) if (x.uid !== m.uid && x.faceUp && e.fieldCard(x.uid)) yield* setFaceDown(e, x);
    },
    // "If this card is attacked, any battle damage your opponent takes from that battle is doubled."
    damageMod: (e, src, ctl, damaged, amount, byEffect) => (!byEffect && amount > 0 && damaged === other(ctl) && e.state.battle?.target === src.uid ? amount * 2 : undefined),
  };

  // "Change this card to Defense Position, and if you do, inflict 500 damage"; the search / Summon of a Level 8 Rock locks that name this turn.
  const shellKnightRun = function* (e: Engine, card: Card, p: Pid): Step {
    if (!e.oncePerTurn('Shell Knight', p)) return;
    const list = e.player(p).deck.filter((c) => rock(e, c) && levelOf(e, c) === 8);
    if (!list.length || !(yield* e.yesno(p, 'Shell Knight: add a Level 8 Rock monster from your Deck to your hand?'))) return;
    e.useOnce('Shell Knight', p);
    const c = yield* pickOne(e, p, 'Shell Knight: which Level 8 Rock monster?', list);
    if (!c) return;
    const canSummon = gyHasFossilFusion(e, p) && freeMZ(e, p) && !e.summonBlocked(p, c, 'special', 'deck');
    if (canSummon && (yield* e.yesno(p, `Shell Knight: "Fossil Fusion" is in your GY. Special Summon ${c.name} instead?`))) {
      yield* e.specialSummon(c.uid, p, 'atk');
      e.player(p).deck = e.shuffle(e.player(p).deck);
    } else {
      e.toHandOf(c.uid, p);
      e.log(p, `${e.player(p).name} adds ${c.name} from the Deck to the hand`);
      e.player(p).deck = e.shuffle(e.player(p).deck);
    }
    lockName(e, p, c.name);
    e.log(p, `${e.player(p).name} cannot activate cards or effects named ${c.name} for the rest of this turn`);
    void card;
  };
  E['Shell Knight'] = {
    *onSummon(e, m, p, kind) {
      if (kind !== 'normal' || !m.faceUp || m.pos !== 'atk') return;
      if (!(yield* e.yesno(p, 'Shell Knight: change it to Defense Position to inflict 500 damage?'))) return;
      if (!e.fieldCard(m.uid)?.faceUp || m.pos !== 'atk') return;
      m.pos = 'def';
      e.event('position', { uid: m.uid });
      e.log(p, `${m.name} changes to Defense Position`);
      e.damage(other(p), 500);
    },
    ...battleOrEffect(shellKnightRun),
  };

  // The "Original ATK" is the number of its controller's banished Dinosaur monsters x 1000.
  E['Tyranno Infinity'] = {
    baseStats: (e, m) => ({ atk: 1000 * e.player(ctrl(e, m)).removed.filter((c) => dino(e, c)).length, def: info(e, m).def ?? 0 }),
  };

  // "Can attack all monsters your opponent controls, once each" (the Asura Priest pattern: tags hit<uid>), and while it can
  // attack, its controller's other monsters (except "Ultimate Tyranno") cannot attack (blocksAttack on a face-up monster).
  E['Ultimate Tyranno'] = {
    attacks(e, m) {
      const done = m.attacked ? m.tags?.attacksMade ?? 1 : 0;
      return done + e.monsters(other(ctrl(e, m))).filter((t) => m.tags?.[`hit${t.uid}`] !== e.state.turn).length;
    },
    targetFilter: (e, m, t) => m.tags?.[`hit${t.uid}`] !== e.state.turn,
    *afterBattle(e, a, t) {
      if (t) tag(a)[`hit${t.uid}`] = e.state.turn;
    },
    blocksAttack: (e, src, m, attacker) => e.state.phase === 'BP' && e.state.turnPlayer === attacker && ctrl(e, src) === attacker && !e.isNamed(m, 'Ultimate Tyranno') && e.canAttackWith(attacker, src),
  };

  E['Weathering Soldier'] = {
    ...battleOrEffect(function* (e, _card, p) {
      const test = (c: Card) => listsFossilFusion(e, c) && !e.isNamed(c, 'Weathering Soldier');
      if (!e.oncePerTurn('Weathering Soldier', p) || !e.player(p).deck.some(test)) return;
      if (!(yield* e.yesno(p, 'Weathering Soldier: add "Fossil Fusion" or a card that lists it from your Deck to your hand?'))) return;
      e.useOnce('Weathering Soldier', p);
      const c = yield* pickOne(e, p, 'Weathering Soldier: add which card?', e.player(p).deck.filter(test));
      if (!c) return;
      e.toHandOf(c.uid, p);
      e.log(p, `${e.player(p).name} adds ${c.name} from the Deck to the hand`);
      e.player(p).deck = e.shuffle(e.player(p).deck);
    }),
    // "Once per turn, during your End Phase: This card loses 600 ATK" (a lasting loss).
    *onEndPhase(e, m, p) {
      if (e.state.turnPlayer !== p || !e.oncePerTurn(`Weathering Soldier:end:${m.uid}`, p)) return;
      e.useOnce(`Weathering Soldier:end:${m.uid}`, p);
      const t = tag(m);
      t.permAtk = (t.permAtk ?? 0) - 600;
      e.log(p, `${m.name} loses 600 ATK`);
    },
  };

  // ======================= Spells =======================
  // "Treated as a Fusion Summon with "Fossil Fusion"": the Fossil Fusion Monster's Summoning condition is met (fx.ignoreCond), tags.fusS.
  const timeTargets = (e: Engine, p: Pid) =>
    targetable(e, faceUpMonsters(e, p).filter((m) => fossilFusion(e, m) && e.player(p).fusion.some((c) => fossilFusion(e, c) && (info(e, c).level ?? 0) === (info(e, m).level ?? 0) + 2)));
  E['Time Stream'] = {
    canActivate: (e, _c, p, t) => isMain(t) && timeTargets(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Time Stream: target which "Fossil" Fusion Monster?', timeTargets(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || !m.faceUp || e.controller(m.uid) !== p || e.untributable(m)) return;
      const lv = info(e, m).level ?? 0;
      e.log(p, `${e.player(p).name} Tributes ${m.name}`);
      yield* e.sendToGrave(m.uid, 'tribute');
      if (e.fieldCard(m.uid) || !freeMZ(e, p)) return;
      const list = e.player(p).fusion.filter((c) => fossilFusion(e, c) && (info(e, c).level ?? 0) === lv + 2);
      const c = yield* pickOne(e, p, `Time Stream: Special Summon which Level ${lv + 2} "Fossil" Fusion Monster?`, list);
      if (!c) return;
      const prev = fx(e).ignoreCond;
      fx(e).ignoreCond = c.uid;
      try {
        yield* e.specialSummon(c.uid, p, 'atk', true, (fc) => void ((fc.tags ??= {}).fusS = 1));
      } finally {
        fx(e).ignoreCond = prev;
      }
    },
    *onSentToGrave(e, card) {
      map<number>(e, 'timeStreamGy')[card.uid] = e.state.turn;
    },
    graveIgnition: {
      can: (e, card, p) => map<number>(e, 'timeStreamGy')[card.uid] !== e.state.turn && freeMZ(e, p) && e.player(p).gy.filter((c) => fossilFusion(e, c)).length >= 2 && e.player(p).gy.some((c) => fossilFusion(e, c) && !e.summonBlocked(p, c, 'special', 'gy')),
      *run(e, card, p) {
        if (zoneOf(e, card.uid) !== 'gy') return;
        const fossils = () => e.player(p).gy.filter((c) => fossilFusion(e, c));
        const cost = yield* pickOne(e, p, 'Time Stream: banish which "Fossil" Fusion Monster from your GY?', fossils());
        if (!cost) return;
        e.banish(card.uid);
        e.banish(cost.uid);
        const t = yield* pickOne(e, p, 'Time Stream: Special Summon which "Fossil" Fusion Monster from your GY?', fossils());
        if (t && freeMZ(e, p)) yield* e.specialSummon(t.uid, p, 'atk');
      },
    },
  };

  // Equip Spell. The Spell/Trap lock is a locksCardActivation on the opponent while the equipped monster battles; the
  // negation at the attack declaration marks the opponent's face-up Spells/Traps negated until that battle's damage
  // calculation is over (a lingering afterAnyBattle lifts it; a battle that never reaches damage calculation leaves
  // them negated until the end of the turn).
  E['White Veil'] = h.equip(undefined, {
    locksCardActivation: (e, src, srcCtl, player, card) => player === other(srcCtl) && src.equippedTo !== undefined && inBattle(e, src.equippedTo) && (isSpell(e, card) || isTrap(e, card)),
    *onAttackDeclared(e, card, controller, attacker, target) {
      const host = card.equippedTo;
      if (host === undefined || (attacker.uid !== host && target?.uid !== host)) return;
      const list = stOf(e, other(controller)).filter((c) => c.faceUp && c.uid !== card.uid);
      if (!list.length) return;
      for (const c of list) {
        const t = tag(c);
        if (t.negatedTurn !== e.state.turn) t.wvNeg = e.state.turn;
        t.negatedTurn = e.state.turn;
      }
      e.linger('White Veil', controller);
      e.log(controller, `White Veil: the effects of ${e.player(other(controller)).name}'s face-up Spells/Traps are negated until the end of the Damage Step`);
    },
    lingering: {
      *afterAnyBattle(e) {
        for (const c of [...stOf(e, 0), ...stOf(e, 1)]) {
          if (c.tags?.wvNeg !== e.state.turn) continue;
          delete c.tags.wvNeg;
          delete c.tags.negatedTurn;
        }
      },
    },
    *afterAnyBattle(e, card, controller, attacker, target) {
      const host = card.equippedTo;
      if (host === undefined || !e.fieldCard(host)) return;
      const victim = attacker.uid === host ? target : target.uid === host ? attacker : null;
      // destroyed by battle with the equipped monster (the engine marks the winner's tags.killTurn)
      if (!victim || e.fieldCard(victim.uid) || e.fieldCard(host)?.tags?.killTurn !== e.state.turn) return;
      const st = stOf(e, other(controller));
      if (!st.length || !(yield* e.yesno(controller, "White Veil: destroy all Spells and Traps your opponent controls?"))) return;
      yield* e.destroy(stOf(e, other(controller)).map((c) => c.uid));
    },
    *onLeaveField(e, fc, controller) {
      if (!fc.faceUp || !fc.active) return;
      e.log(controller, `White Veil leaves the field: ${e.player(controller).name} takes 3000 damage`);
      e.damage(controller, 3000);
    },
  });

  // ======================= Traps =======================
  // Continuous Trap: it stays attached to the monster it Summoned (like Call of the Haunted): when it leaves the field, the
  // monster is destroyed; when the monster leaves the field, this card goes with it.
  const stoneList = (e: Engine, p: Pid) => e.player(p).removed.filter((c) => rock(e, c) && revivable(e, p, c, 'removed'));
  E['Release from Stone'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && freeMZ(e, p) && stoneList(e, p).length > 0,
    *resolve(e, link, p) {
      const fc = e.fieldCard(link.card.uid);
      if (!fc || !freeMZ(e, p)) return;
      const c = yield* pickOne(e, p, 'Release from Stone: Special Summon which banished Rock monster?', stoneList(e, p));
      if (!c) return;
      yield* e.specialSummon(c.uid, p, 'atk');
      if (e.fieldCard(c.uid) && e.fieldCard(fc.uid)) h.attachTo(e, fc, c.uid);
    },
    *onLeaveField(e, fc) {
      const host = fc.equippedTo !== undefined ? e.fieldCard(fc.equippedTo) : null;
      if (!host) return;
      e.log(null, `${host.name} is destroyed along with Release from Stone`);
      yield* e.destroy([host.uid]);
    },
  };

  // "That monster's effect is now treated as the opposite coin toss result": the Arcana Force scripts read tags.coin
  // (1 Heads, 2 Tails), so it is flipped. The Chariot's Tails ("your opponent gains control of this card") is applied
  // or undone as its result changes.
  const reversible = (e: Engine, p: Pid) => faceUpMonsters(e, p).filter((m) => named(e, m, 'Arcana Force') && (m.tags?.coin === 1 || m.tags?.coin === 2));
  E['Reversal of Fate'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && reversible(e, p).length > 0,
    *resolve(e, _link, p) {
      const m = yield* pickOne(e, p, 'Reversal of Fate: select which "Arcana Force" monster?', reversible(e, p));
      if (!m || !e.fieldCard(m.uid)?.faceUp) return;
      tag(m).coin = m.tags?.coin === 1 ? 2 : 1;
      e.log(p, `Reversal of Fate: ${m.name}'s effect is now treated as ${m.tags!.coin === 1 ? 'Heads' : 'Tails'}`);
      if (e.isNamed(m, 'Arcana Force VII - The Chariot')) {
        const now = e.controller(m.uid);
        if (m.tags!.coin === 2 && now !== null && e.takeControl(m.uid, other(now))) e.log(p, 'The Chariot: the opponent gains control of it');
        else if (m.tags!.coin === 1 && now !== null && now !== m.owner && e.takeControl(m.uid, m.owner)) e.log(p, 'The Chariot returns to its owner');
      }
    },
  };

  // "Tribute 1 EARTH monster" is the cost, paid when it is activated.
  const kuroCands = (e: Engine, p: Pid, except?: number) => e.player(p).gy.filter((c) => c.uid !== except && attrOf(e, c) === 'EARTH' && levelOf(e, c) <= 4 && revivable(e, p, c, 'gy'));
  const kuroTributes = (e: Engine, p: Pid) => e.monsters(p).filter((m) => m.faceUp && attrOf(e, m) === 'EARTH' && !e.untributable(m) && !m.tags?.summonTribOnly);
  E['Spiritual Earth Art - Kurogane'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && kuroTributes(e, p).length > 0 && kuroCands(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Kurogane: Tribute which EARTH monster?', kuroTributes(e, p), true);
      if (!m) return false;
      e.log(p, `${e.player(p).name} Tributes ${m.name}`);
      yield* e.sendToGrave(m.uid, 'tribute');
      link.payload = { tributed: m.uid };
    },
    *resolve(e, link, p) {
      const except = (link.payload as { tributed?: number } | undefined)?.tributed;
      yield* summonOneOf(e, p, 'Kurogane: Special Summon which Level 4 or lower EARTH monster from your GY?', kuroCands(e, p, except));
    },
  };

  // The Dinosaurs are banished as the cost when it is activated (at least 1).
  const instinctGy = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => dino(e, c));
  E['Survival Instinct'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && instinctGy(e, p).length > 0,
    *activate(e, link, p) {
      const list = yield* pick(e, p, 'Survival Instinct: banish which Dinosaur monsters from your GY?', instinctGy(e, p), 1, instinctGy(e, p).length, true);
      if (!list || !list.length) return false;
      let n = 0;
      for (const c of list) {
        e.banish(c.uid);
        if (zoneOf(e, c.uid) === 'removed') n++;
      }
      link.payload = { n };
    },
    *resolve(e, link, p) {
      const n = (link.payload as { n?: number } | undefined)?.n ?? 0;
      if (n > 0) e.gainLp(p, 400 * n);
    },
  };

  // Face-up Normal Monsters are destroyed (face-down cards are not known to be Normal Monsters). The Dinosaurs it Summons
  // are destroyed in this turn's End Phase (FieldCard.doomAt). GY effect: a Quick Effect (from: 'gy').
  const normals = (e: Engine) => [...e.monsters(0), ...e.monsters(1)].filter((m) => m.faceUp && isNormalMonster(e, m));
  const endDinoTargets = (e: Engine, p: Pid) => targetable(e, faceUpMonsters(e, p).filter((m) => dino(e, m)));
  const endOppTargets = (e: Engine, p: Pid) => [...targetable(e, e.monsters(other(p))), ...stOf(e, other(p))];
  E["Survival's End"] = {
    canActivate: (e, _c, p, t) => anyTime(t) && normals(e).length > 0,
    *resolve(e, _link, p) {
      const list = normals(e);
      if (!list.length) return;
      yield* e.destroy(list.map((m) => m.uid));
      const n = list.filter((m) => !e.fieldCard(m.uid)).length;
      if (!n) return;
      const cands = () => e.player(p).deck.filter((c) => dino(e, c) && levelOf(e, c) <= 4 && !e.summonBlocked(p, c, 'special', 'deck'));
      const room = e.player(p).mz.filter((_, i) => e.monsterZoneOpen(p, i)).length;
      const most = Math.min(n, room, cands().length);
      if (most < 1) return;
      const chosen = yield* pick(e, p, `Survival's End: Special Summon up to ${most} Level 4 or lower Dinosaurs from your Deck`, cands(), 1, most, true);
      for (const c of chosen ?? []) {
        if (zoneOf(e, c.uid) !== 'deck' || !freeMZ(e, p)) continue;
        yield* e.specialSummon(c.uid, p, 'atk', true, (fc) => void (fc.doomAt = e.state.turn));
      }
      e.player(p).deck = e.shuffle(e.player(p).deck);
    },
    quick: {
      from: 'gy',
      label: 'banish it to destroy a Dinosaur you control and 1 card your opponent controls',
      repeat: true,
      can: (e, _c, p, t) => anyTime(t) && endDinoTargets(e, p).length > 0 && endOppTargets(e, p).length > 0,
      *cost(e, card, p, link) {
        const d = yield* pickOne(e, p, "Survival's End: target which Dinosaur you control?", endDinoTargets(e, p), true);
        if (!d) return false;
        const o = yield* pick(e, p, "Survival's End: target which card your opponent controls?", endOppTargets(e, p), 1, 1, true);
        if (!o || !o.length) return false;
        e.banish(card.uid);
        Object.assign(link.payload as Record<string, unknown>, { dino: d.uid, opp: o[0].uid });
        link.targetUid = o[0].uid;
      },
      *run(e, _card, _p, link) {
        const pl = link.payload as { dino?: number; opp?: number };
        const uids = [pl.dino, pl.opp].filter((u): u is number => u !== undefined && !!e.fieldCard(u));
        if (uids.length) yield* e.destroy(uids);
      },
    },
  };

  // "If your opponent controls 2 or more Spells/Traps and you control no Spells/Traps, you can activate this card from your
  // hand" (offered like a Quick Effect from the hand: placed face-up, resolves, then goes to the GY).
  const faceUpST = (e: Engine, except?: number) => [...stOf(e, 0), ...stOf(e, 1)].filter((c) => c.faceUp && c.uid !== except);
  const typhoonHand = (e: Engine, p: Pid) => stOf(e, other(p)).length >= 2 && stOf(e, p).length === 0;
  function* typhoonDestroy(e: Engine, link: ChainLink): Step {
    const t = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
    if (t && t.faceUp) yield* e.destroy([t.uid]);
  }
  E['Typhoon'] = {
    canActivate: (e, c, _p, t) => anyTime(t) && faceUpST(e, c.uid).length > 0,
    *activate(e, link, p) {
      const t = yield* pickOne(e, p, 'Typhoon: destroy which face-up Spell/Trap?', faceUpST(e, link.card.uid), true);
      if (!t) return false;
      link.targetUid = t.uid;
    },
    resolve: (e, link) => typhoonDestroy(e, link),
    quick: {
      from: 'hand',
      label: 'activate it from your hand',
      repeat: true,
      can: (e, c, p, t) => anyTime(t) && typhoonHand(e, p) && freeST(e, p) >= 0 && faceUpST(e, c.uid).length > 0 && !e.trapsSealed(p) && !e.activationLocked(p, 'trap'),
      *cost(e, c, p, link) {
        const t = yield* pickOne(e, p, 'Typhoon: destroy which face-up Spell/Trap?', faceUpST(e, c.uid), true);
        if (!t) return false;
        if (!placeInST(e, c.uid, p)) return false;
        link.targetUid = t.uid;
      },
      *run(e, c, _p, link) {
        yield* typhoonDestroy(e, link);
        if (e.fieldCard(c.uid)) yield* e.sendToGrave(c.uid, 'used');
      },
    },
  };

  // "During your End Phase": offered to its controller in their End Phase (engine: EffectDef.endPhaseTrap).
  const controlsJurassic = (e: Engine, p: Pid) => stOf(e, p).some((c) => c.faceUp && e.isNamed(c, 'Jurassic World'));
  E['Volcanic Eruption'] = {
    endPhaseTrap: true,
    canActivate: (e, _c, p) => e.state.phase === 'EP' && e.state.turnPlayer === p && controlsJurassic(e, p),
    // The computer wipes the field only when the opponent loses more there than it does (its own Jurassic World included).
    aiActivate(e, c, p) {
      // Board value as the computer sees it (aiEval): an opponent's face-down monster is a guess.
      const worth = (x: FieldCard, q: Pid) => {
        if (x.uid === c.uid) return 0;
        if (!e.monsters(q).includes(x)) return 300;
        if (!x.faceUp && q !== p) return 900;
        return 200 + 0.7 * Math.max(x.faceUp ? e.atkOf(x) : (info(e, x).atk ?? 0), (x.faceUp ? e.defOf(x) : (info(e, x).def ?? 0)) * 0.8);
      };
      const side = (q: Pid) => [...e.monsters(q), ...stOf(e, q)].reduce((n, x) => n + worth(x, q), 0);
      return side(other(p)) > side(p);
    },
    *resolve(e, link, p) {
      if (!controlsJurassic(e, p)) return;
      const all = [...e.monsters(0), ...e.monsters(1), ...stOf(e, 0), ...stOf(e, 1)].filter((c) => c.uid !== link.card.uid);
      if (all.length) yield* e.destroy(all.map((c) => c.uid));
    },
  };
}
