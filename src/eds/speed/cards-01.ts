// Speed Duel card scripts, batch 01 (A Cat of Ill Omen ... Berserk Scales).
import type { EffectDef } from '../effects';
import { nameEngine } from '../names';
import type { Card, Engine, FieldCard, Gen, Pid, SpeedHelpers, Step } from './helpers';
import {
  allMonsters,
  allST,
  anyTime,
  attrOf,
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
  isTrap,
  levelOf,
  millTop,
  named,
  negateLink,
  negateMonster,
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
} from './helpers';

// ---------- local helpers ----------
const amz = (c: Card | string) => named(nameEngine(), c, 'Amazoness');
const amzMon = (e: Engine, c: Card) => isMonster(e, c) && amz(c);
/** A monster an effect may Special Summon (not Fusion/Ritual, not one with its own summoning condition). */
const canSS = (e: Engine, c: Card) => isMonster(e, c) && !isExtraOrRitual(e, c) && !e.effectOn(c)?.cannotNormalSummon;
const isFusion = (e: Engine, c: Card) => info(e, c).sub === 'Fusion';
const faceUpOf = (e: Engine, p: Pid) => e.monsters(p).filter((m) => m.faceUp);
const where = (e: Engine, uid: number) => e.find(uid)?.loc.zone;
/** For repeatable Quick Effects: not while this card's effect is already waiting on the chain. */
const notChained = (e: Engine, c: Card) => !e.state.chain.some((l) => l.card.uid === c.uid);

/** Clears equips before a field card goes somewhere other than the GY. False for a Token (it just vanishes). */
function* leaveField(e: Engine, uid: number): Gen<boolean> {
  const fc = e.fieldCard(uid);
  if (!fc) return true;
  if (fc.token) {
    yield* e.sendToGrave(uid, 'used');
    return false;
  }
  for (const eq of fc.equips.slice()) yield* e.sendToGrave(eq, 'used');
  if (fc.equippedTo !== undefined) {
    const host = e.fieldCard(fc.equippedTo);
    if (host) host.equips = host.equips.filter((u) => u !== uid);
  }
  return true;
}
/** Returns a card to its owner's hand (Fusion Monsters go back to the Extra Deck). */
function* returnToHand(e: Engine, uid: number): Step {
  if (!(yield* leaveField(e, uid))) return;
  const c = e.find(uid)?.card;
  if (!c) return;
  if (isFusion(e, c)) return yield* returnToDeck(e, uid, false);
  e.toHand(uid);
}
/** Returns a card to the top or bottom of its owner's Deck (Fusion Monsters go to the Extra Deck). */
function* returnToDeck(e: Engine, uid: number, bottom: boolean): Step {
  if (!(yield* leaveField(e, uid))) return;
  const c = e.find(uid)?.card;
  if (!c) return;
  const ps = e.player(c.owner);
  e.toDeckTop(uid);
  if (isFusion(e, c)) {
    const x = ps.deck.shift();
    if (x) ps.fusion.push(x);
  } else if (bottom) {
    const x = ps.deck.shift();
    if (x) ps.deck.push(x);
  }
}
function subsetSum(vals: number[], target: number): boolean {
  let reach = new Set([0]);
  for (const v of vals) {
    const next = new Set(reach);
    for (const r of reach) if (r + v <= target) next.add(r + v);
    reach = next;
  }
  return reach.has(target);
}
/** Choose cards whose Levels add up to exactly `total`. */
function* pickLevels<T extends Card>(e: Engine, p: Pid, title: string, cards: T[], total: number): Gen<T[] | null> {
  for (let tries = 0; tries < 3; tries++) {
    const chosen = yield* pick(e, p, title, cards, 1, cards.length, true);
    if (!chosen) return null;
    const sum = chosen.reduce((a, c) => a + levelOf(e, c), 0);
    if (sum === total) return chosen;
    e.log(p, `Those add up to Level ${sum}; exactly ${total} is needed`);
  }
  return null;
}
function coin(e: Engine, p: Pid | null, label: string): boolean {
  const heads = e.roll(2) === 1;
  e.log(p, `${label}: ${heads ? 'Heads' : 'Tails'}`);
  return heads;
}
/** Spell Counters live in FieldCard.counters, on face-up cards whose text puts them on itself ("Spell Counter on this card / on it"). */
const maxCounters = (e: Engine, c: Card) => Number(info(e, c).desc.match(/max\.?\s*(\d+)/)?.[1] ?? 99);
// audit-00: only cards that can hold Spell Counters (Alchemist of Black Spells and Apprentice Magician themselves cannot).
const holdsCounters = (e: Engine, c: Card) => /Spell Counters? on (?:this card|it)\b/.test(info(e, c).desc);
const counterHolders = (e: Engine, p?: Pid) =>
  [...allMonsters(e), ...allST(e)].filter((c) => c.faceUp && holdsCounters(e, c) && c.counters < maxCounters(e, c) && (p === undefined || ctrl(e, c) === p));
function* addCounter(e: Engine, p: Pid, title: string, list: FieldCard[]): Step {
  const c = yield* pickOne(e, p, title, list);
  if (!c || !e.fieldCard(c.uid)) return;
  c.counters = Math.min(maxCounters(e, c), c.counters + 1);
  e.log(p, `A Spell Counter is placed on ${c.name} (${c.counters})`);
}
/** The other monster in the current battle, if `m` is part of it. */
function opponentInBattle(e: Engine, uid: number): FieldCard | null {
  const b = e.state.battle;
  if (!b || b.target === null) return null;
  if (b.attacker === uid) return e.fieldCard(b.target);
  if (b.target === uid) return e.fieldCard(b.attacker);
  return null;
}
/** Arcana Force: "When this card is Summoned, toss a coin" (tags.coin: 1 Heads, 2 Tails). */
function arcanaCoin(after?: (e: Engine, m: FieldCard, p: Pid, heads: boolean) => Step): Partial<EffectDef> {
  const run = function* (e: Engine, m: FieldCard, p: Pid): Step {
    // Light Barrier (batch 12): choose the result instead of tossing, unless its Tails turned it off.
    const lb = e.player(p).field;
    const barrier = !!lb && lb.faceUp && !!lb.active && e.isNamed(lb, 'Light Barrier') && !lb.tags?.lbOff && !e.spellsNegated();
    const heads = barrier ? (yield* chooseOption(e, p, `Light Barrier: apply which effect of ${m.name}?`, ['Heads', 'Tails'])) !== 1 : coin(e, p, m.name);
    if (barrier) e.log(p, `${m.name}: ${heads ? 'Heads' : 'Tails'} (chosen with Light Barrier)`);
    tag(m).coin = heads ? 1 : 2;
    if (after) yield* after(e, m, p, heads);
  };
  return { onSummon: (e, m, p) => run(e, m, p), onSpecialSummon: run };
}
const heads = (m: FieldCard) => m.tags?.coin === 1;
const tails = (m: FieldCard) => m.tags?.coin === 2;

export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  // ---------- A ----------
  E['A Cat of Ill Omen'] = {
    *flip(e, _m, p) {
      const ps = e.player(p);
      const c = yield* pickOne(e, p, 'A Cat of Ill Omen: choose a Trap from your Deck', ps.deck.filter((x) => isTrap(e, x)));
      if (!c) return;
      const valley = allST(e).some((s) => s.faceUp && e.isNamed(s, 'Necrovalley'));
      if (valley && (yield* e.yesno(p, `Necrovalley: add ${c.name} to your hand instead?`))) {
        e.toHandOf(c.uid, p);
        ps.deck = e.shuffle(ps.deck);
        e.log(p, `${ps.name} adds ${c.name} to the hand`);
        return;
      }
      ps.deck = e.shuffle(ps.deck);
      e.toDeckTop(c.uid);
      e.log(p, `${ps.name} places a Trap on top of the Deck`);
    },
  };

  E['A Hero Emerges'] = {
    canActivate: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null && e.player(p).hand.length > 0,
    *resolve(e, _l, p) {
      const hand = e.player(p).hand;
      if (!hand.length) return;
      const c = hand[Math.floor(e.rand() * hand.length)];
      e.log(p, `A Hero Emerges: ${c.name} was chosen`);
      if (canSS(e, c) && freeMZ(e, p)) yield* e.specialSummon(c.uid, p, 'atk');
      // audit-00: a monster that could not be Special Summoned after all goes to the GY too.
      if (where(e, c.uid) === 'hand') yield* e.sendToGrave(c.uid, 'used');
    },
  };

  const heroLives = (e: Engine, c: Card) => isMonster(e, c) && named(e, c, 'Elemental HERO') && levelOf(e, c) <= 4;
  E['A Hero Lives'] = {
    canActivate: (e, _c, p, t) => isMain(t) && faceUpOf(e, p).length === 0 && freeMZ(e, p) && e.player(p).lp > 1 && e.player(p).deck.some((c) => heroLives(e, c)),
    *activate(e, _l, p) {
      e.payLp(p, Math.floor(e.player(p).lp / 2));
    },
    *resolve(e, _l, p) {
      yield* summonOneOf(e, p, 'A Hero Lives: Special Summon which Elemental HERO?', e.player(p).deck.filter((c) => heroLives(e, c)));
    },
  };

  // audit-00: its name counts as "Umi" (countsAs), and WATER monsters in the hands and on the field are 1 Level lower (levelMod).
  E['A Legendary Ocean'] = {
    ...h.fieldSpell((e, m) => (attrOf(e, m) === 'WATER' ? { atk: 200, def: 200 } : undefined)),
    countsAs: () => 'Umi',
    levelMod: (e, _src, _p, c) => {
      const z = where(e, c.uid);
      if (!isMonster(e, c) || attrOf(e, c) !== 'WATER' || (z !== 'hand' && z !== 'mz')) return 0;
      return z === 'mz' && !(c as FieldCard).faceUp ? 0 : -1;
    },
  };

  E['Absolute Crusader'] = {
    quick: {
      label: 'Tribute it to destroy the Summoned monster',
      can: (e, _c, _p, t, ctx) => {
        const m = t === 'special' && ctx.uid !== undefined ? e.fieldCard(ctx.uid) : null;
        return !!m && m.faceUp && levelOf(e, m) >= 5;
      },
      *cost(e, card, _p, link, ctx) {
        link.targetUid = ctx.uid;
        yield* e.sendToGrave(card.uid, 'tribute');
      },
      *run(e, _c, _p, link) {
        if (link.targetUid !== undefined && e.fieldCard(link.targetUid)) yield* e.destroy([link.targetUid]);
      },
    },
  };

  E['Absorbing Jar'] = {
    *flip(e, _m, me) {
      ((e.state.fx.noSetTurn ??= [-1, -1]) as number[])[me] = e.state.turn; // audit-00: you cannot Set any cards this turn
      const set = allST(e).filter((c) => !c.faceUp);
      const before = set.map((c) => ({ uid: c.uid, p: ctrl(e, c) }));
      yield* e.destroy(set.map((c) => c.uid));
      const n = [0, 0];
      for (const b of before) if (!e.fieldCard(b.uid)) n[b.p]++;
      for (const p of [0, 1] as Pid[]) if (n[p] && e.state.winner === null) e.draw(p, n[p]);
    },
  };

  // The Set-and-destroyed effect needs a face-up Pendulum in the Extra Deck, which cannot happen here.
  const abyssActor = (m: FieldCard) => m.faceUp && named(nameEngine(), m, 'Abyss Actor');
  E['Abyss Prop - Wild Wagon'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    shields(e, _src, target, how, srcCtl) {
      if (!abyssActor(target) || ctrl(e, target) !== srcCtl) return false;
      if (how !== 'battle' || tag(target).wagonSaved === e.state.turn) return false;
      tag(target).wagonSaved = e.state.turn;
      return true;
    },
    ignition: {
      repeat: true,
      can: (e, c, p) => e.oncePerTurn(`wagon${c.uid}`, p) && e.monsters(p).some(abyssActor),
      *run(e, c, p) {
        const m = yield* pickOne(e, p, 'Wild Wagon: protect which Abyss Actor?', targetable(e, e.monsters(p).filter(abyssActor)), true);
        if (!m) return;
        e.useOnce(`wagon${c.uid}`, p);
        // The engine keeps the opponent's effects off it until the end of their next turn, even if Wild Wagon leaves.
        tag(m).oppNoTargetUntil = Math.max(m.tags?.oppNoTargetUntil ?? -1, e.state.turn + 1);
      },
    },
  };

  const abyssKingCount = (e: Engine, p: Pid) => new Set(e.monsters(p).filter((m) => abyssActor(m) && m.pos === 'atk').map((m) => m.name)).size;
  const faceUpCards = (e: Engine, except: number) => [...targetable(e, faceUpMonsters(e)), ...allST(e).filter((c) => c.faceUp && c.uid !== except)];
  E['Abyss Script - Rise of the Abyss King'] = {
    canActivate: (e, c, p, t) => isMain(t) && abyssKingCount(e, p) > 0 && faceUpCards(e, c.uid).length > 0,
    *activate(e, link, p) {
      const chosen = yield* pick(e, p, 'Rise of the Abyss King: destroy which cards?', faceUpCards(e, link.card.uid), 1, abyssKingCount(e, p), true);
      if (!chosen) return false;
      link.payload = chosen.map((c) => c.uid);
      // audit-00: with a Level 7 or higher "Abyss Actor", the opponent cannot respond to its activation.
      if (e.monsters(p).some((m) => abyssActor(m) && levelOf(e, m) >= 7)) e.state.fx.unchainable = link.card.uid;
    },
    *resolve(e, link) {
      if (e.state.fx.unchainable === link.card.uid) e.state.fx.unchainable = undefined;
      yield* e.destroy((link.payload as number[]).filter((u) => e.fieldCard(u)?.faceUp));
    },
  };

  const gyMonsters = (e: Engine) => [...e.player(0).gy, ...e.player(1).gy].filter((c) => isMonster(e, c));
  E['Abyss Warrior'] = {
    ignition: {
      can: (e, _m, p) => e.player(p).hand.some((c) => isMonster(e, c) && attrOf(e, c) === 'WATER'),
      *run(e, _m, p) {
        if (!(yield* discardCost(e, p, 1, (c) => isMonster(e, c) && attrOf(e, c) === 'WATER'))) return;
        const t = yield* pickOne(e, p, 'Abyss Warrior: return which monster from a GY to the Deck?', gyMonsters(e));
        if (!t) return;
        const bottom = (yield* chooseOption(e, p, `Put ${t.name} on the top or the bottom of the Deck?`, ['Top', 'Bottom'])) === 1;
        yield* returnToDeck(e, t.uid, bottom);
        e.log(p, `${t.name} goes to the ${bottom ? 'bottom' : 'top'} of the Deck`);
      },
    },
  };

  const mermails = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && named(e, c, 'Mermail') && !isExtraOrRitual(e, c));
  E['Abyss-squall'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && mermails(e, p).length >= 3 && e.player(p).mz.filter((z) => z === null).length >= 3,
    *activate(e, link, p) {
      const chosen = yield* pick(e, p, 'Abyss-squall: Special Summon which 3 Mermail monsters?', mermails(e, p), 3, 3, true);
      if (!chosen) return false;
      link.payload = chosen.map((c) => c.uid);
    },
    *resolve(e, link, p) {
      for (const u of link.payload as number[]) {
        if (where(e, u) !== 'gy' || !freeMZ(e, p)) continue;
        yield* e.specialSummon(u, p, 'def');
        const m = e.fieldCard(u);
        if (!m) continue;
        negateMonster(e, m, false);
        m.cannotAttack = true;
        m.doomAt = e.state.turn;
      }
    },
  };

  E['Adhesion Trap Hole'] = {
    canActivate: (e, _c, p, t, ctx) => !!opponentSummon(e, p, t, ctx)?.faceUp,
    *activate(_e, link, _p, ctx) {
      link.targetUid = ctx.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || !m.faceUp || ctrl(e, m) !== other(p)) return;
      tag(m).permAtk = (m.tags?.permAtk ?? 0) - Math.floor(e.baseStats(m).atk / 2);
      e.log(p, `${m.name}'s original ATK is halved`);
    },
  };

  // Ritual Summon any Ritual Monster by sending Normal Monsters with exactly its Level from the Deck.
  const araRituals = (e: Engine, p: Pid) => {
    const lv = e.player(p).deck.filter((c) => isNormalMonster(e, c)).map((c) => levelOf(e, c));
    return e.player(p).hand.filter((c) => info(e, c).sub === 'Ritual' && subsetSum(lv, levelOf(e, c)));
  };
  E['Advanced Ritual Art'] = {
    canActivate: (e, _c, p, t) => isMain(t) && freeMZ(e, p) && araRituals(e, p).length > 0,
    *activate(e, link, p) {
      const mon = yield* pickOne(e, p, 'Advanced Ritual Art: Ritual Summon which monster?', araRituals(e, p), true);
      if (!mon) return false;
      const mats = yield* pickLevels(e, p, `Send Normal Monsters from the Deck with total Level ${levelOf(e, mon)}`, e.player(p).deck.filter((c) => isNormalMonster(e, c)), levelOf(e, mon));
      if (!mats) return false;
      link.payload = { monster: mon.uid, mats: mats.map((c) => c.uid) };
    },
    *resolve(e, link, p) {
      const { monster, mats } = link.payload as { monster: number; mats: number[] };
      if (where(e, monster) !== 'hand' || mats.some((u) => where(e, u) !== 'deck')) return;
      for (const u of mats) yield* e.sendToGrave(u, 'material');
      e.player(p).deck = e.shuffle(e.player(p).deck);
      if (!freeMZ(e, p)) return;
      ((e.state.fx.ritualMats ??= {}) as Record<number, { mats: number[]; turn: number }>)[monster] = { mats: mats.slice(), turn: e.state.turn }; // audit-00: like other Ritual Spells
      yield* e.specialSummon(monster, p, 'atk');
      e.log(p, `${e.player(p).name} Ritual Summons ${e.find(monster)?.card.name ?? 'a monster'}!`);
    },
  };

  E['Aegis of Gaia'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve(e, _l, p) {
      e.gainLp(p, 3000);
    },
    *onLeaveField(e, fc, p) {
      if (!fc.active) return;
      e.log(p, 'Aegis of Gaia left the field: 3000 damage');
      e.damage(p, 3000);
    },
  };

  E['Agido'] = {
    *onDestroyed(e, _c, p, byBattle) {
      if (!byBattle || !freeMZ(e, p)) return;
      const n = e.roll(6);
      e.log(p, `Agido rolls a ${n}`);
      const ok = (c: Card) => canSS(e, c) && info(e, c).race === 'Fairy' && (n === 6 ? levelOf(e, c) >= 6 : levelOf(e, c) === n);
      const list = e.player(p).gy.filter(ok);
      if (!list.length || !(yield* e.yesno(p, 'Agido: Special Summon a Fairy monster from your GY?'))) return;
      yield* summonOneOf(e, p, 'Agido: Special Summon which Fairy?', list);
    },
  };

  E['Airknight Parshath'] = {
    piercing: true,
    *onBattleDamage(e, _a, p) {
      e.draw(p, 1);
    },
  };

  E['Alchemist of Black Spells'] = {
    ignition: {
      can: (e, m, p) => m.pos === 'atk' && counterHolders(e, p).length > 0,
      *run(e, m, p) {
        if (!m.faceUp || m.pos !== 'atk') return;
        m.pos = 'def';
        e.event('position', { uid: m.uid });
        e.log(p, `${m.name} changes to Defense Position`);
        yield* addCounter(e, p, 'Alchemist of Black Spells: place a Spell Counter on which card?', counterHolders(e, p));
      },
    },
  };

  E['Allure of Darkness'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).deck.length >= 2,
    *resolve(e, _l, p) {
      if (!e.draw(p, 2)) return;
      const darks = e.player(p).hand.filter((c) => isMonster(e, c) && attrOf(e, c) === 'DARK');
      if (darks.length) {
        const c = yield* pickOne(e, p, 'Allure of Darkness: banish which DARK monster?', darks);
        if (c) e.banish(c.uid);
        return;
      }
      for (const c of e.player(p).hand.slice()) yield* e.sendToGrave(c.uid, 'used');
    },
  };

  // audit-00: mandatory, at the start of the Damage Step (a face-down monster is still face-down then).
  E['Ally of Justice Core Destroyer'] = {
    *damageStepStart(e, _m, foe) {
      if (foe && foe.faceUp && attrOf(e, foe) === 'LIGHT') yield* e.destroy([foe.uid]);
    },
  };

  // ---------- Amazoness ----------
  // audit-00 approximation: "they must attack this turn, if able" is not enforced (the engine cannot force a player to attack).
  // spells-b: the 500 ATK loss has no end ("they lose 500 ATK"): it lasts while they stay face-up (it used to wear off at the end of the turn).
  E['Amazoness Archers'] = {
    canActivate: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null && faceUpOf(e, p).some((m) => amz(m)),
    *resolve(e, _l, p) {
      for (const m of e.monsters(other(p))) {
        m.faceUp = true;
        m.pos = 'atk';
        tag(m).permAtk = (m.tags?.permAtk ?? 0) - 500;
        e.event('position', { uid: m.uid });
      }
      e.log(p, 'Amazoness Archers: the opponent\'s monsters switch to Attack Position and lose 500 ATK');
    },
  };

  const amzCallTest = (e: Engine, c: Card) => amz(c) && !e.isNamed(c, 'Amazoness Call');
  E['Amazoness Call'] = {
    canActivate: (e, c, p, t) => anyTime(t) && e.oncePerTurn(c.name, p) && e.player(p).deck.some((x) => amzCallTest(e, x)),
    *activate(e, link, p) {
      e.useOnce(link.card.name, p);
    },
    *resolve(e, _l, p) {
      const ps = e.player(p);
      const c = yield* pickOne(e, p, 'Amazoness Call: take which Amazoness card?', ps.deck.filter((x) => amzCallTest(e, x)));
      if (!c) return;
      if ((yield* chooseOption(e, p, `${c.name}: add it to your hand or send it to the GY?`, ['Add to hand', 'Send to GY'])) === 1) yield* e.sendToGrave(c.uid, 'used');
      else e.toHandOf(c.uid, p);
      ps.deck = e.shuffle(ps.deck);
    },
    // audit-00: the GY effect. The chosen monster gets an extra attack for each other opponent's monster it has not battled yet
    // (attackGuard keeps it off monsters it already battled); your other monsters, including ones Summoned later this turn, cannot attack.
    graveIgnition: {
      can: (e, _c, p) => e.state.turnPlayer === p && faceUpOf(e, p).some((m) => amz(m)),
      *run(e, card, p) {
        const m = yield* pickOne(e, p, 'Amazoness Call: which Amazoness monster can attack all monsters?', targetable(e, faceUpOf(e, p).filter((x) => amz(x))), true);
        if (!m) return;
        e.banish(card.uid);
        const fx = e.state.fx as { amzCall?: { uid: number; turn: number; hit: number[] } };
        fx.amzCall = { uid: m.uid, turn: e.state.turn, hit: [] };
        e.linger('Amazoness Call', p);
        callRefresh(e, m);
        for (const x of e.monsters(p)) if (x.uid !== m.uid) tag(x).noAttackTurn = e.state.turn;
        e.log(p, `${m.name} can attack each of the opponent's monsters this turn`);
      },
    },
    lingering: {
      onAnySummon: function* (e, owner, m, controller) {
        const call = (e.state.fx as { amzCall?: { uid: number } }).amzCall;
        if (controller === owner && call && m.uid !== call.uid) tag(m).noAttackTurn = e.state.turn;
      },
      attackGuard: (e, _owner, attacker, target) => {
        const call = (e.state.fx as { amzCall?: { uid: number; turn: number; hit: number[] } }).amzCall;
        return !!call && call.turn === e.state.turn && call.uid === attacker.uid && call.hit.includes(target.uid);
      },
      afterAnyBattle: function* (e, _owner, attacker, target) {
        const call = (e.state.fx as { amzCall?: { uid: number; turn: number; hit: number[] } }).amzCall;
        if (!call || call.turn !== e.state.turn || call.uid !== attacker.uid) return;
        call.hit.push(target.uid);
        const m = e.fieldCard(attacker.uid);
        if (m) callRefresh(e, m);
      },
    },
  };
  /** Amazoness Call: extra attacks = the opponent's monsters this one has not battled yet this turn, beyond its first attack. */
  function callRefresh(e: Engine, m: FieldCard) {
    const call = (e.state.fx as { amzCall?: { hit: number[] } }).amzCall!;
    const left = e.monsters(other(ctrl(e, m))).filter((t) => !call.hit.includes(t.uid)).length;
    const made = m.attacked ? m.tags?.attacksMade ?? 1 : 0;
    tag(m).extraAttacksTurn = e.state.turn;
    tag(m).extraAttacksN = Math.max(0, made + left - 1);
  }

  E['Amazoness Chain Master'] = {
    *onDestroyed(e, _c, p, byBattle) {
      const opp = e.player(other(p));
      if (!byBattle || e.player(p).lp <= 1500 || !opp.hand.length) return;
      if (!(yield* e.yesno(p, 'Amazoness Chain Master: pay 1500 LP to look at the opponent\'s hand?'))) return;
      e.payLp(p, 1500);
      const mons = opp.hand.filter((c) => isMonster(e, c));
      if (!mons.length) return yield* e.reveal(p, 'Opponent\'s hand (no monsters)', opp.hand.slice());
      const c = yield* pickOne(e, p, 'Amazoness Chain Master: take which monster?', mons);
      if (c) {
        e.toHandOf(c.uid, p);
        e.log(p, `${e.player(p).name} takes ${c.name} from the opponent's hand`);
      }
    },
  };

  E['Amazoness Fighter'] = { noBattleDamage: () => true };

  let fsBusy = false;
  E['Amazoness Fighting Spirit'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    aura(e, _src, target) {
      const b = e.state.battle;
      // spells-b: any "Amazoness" monster that attacks (the card does not say "you control").
      if (fsBusy || !b || b.attacker !== target.uid || b.target === null || !target.faceUp || !amz(target)) return undefined;
      const t = e.fieldCard(b.target);
      if (!t) return undefined;
      fsBusy = true;
      try {
        return e.atkOf(t) > e.atkOf(target) ? { atk: 1000, def: 0 } : undefined;
      } finally {
        fsBusy = false;
      }
    },
  };

  E['Amazoness Onslaught'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    quick: {
      label: 'Special Summon an Amazoness from your hand',
      can: (e, _c, p) => e.state.phase === 'BP' && freeMZ(e, p) && e.player(p).hand.some((c) => amzMon(e, c) && canSS(e, c)),
      *run(e, _c, p) {
        const m = yield* summonOneOf(e, p, 'Amazoness Onslaught: Special Summon which Amazoness?', e.player(p).hand.filter((c) => amzMon(e, c) && canSS(e, c)));
        if (m) m.atkMod += 500;
      },
    },
    // After damage calculation: banish the opponent's monster an Amazoness battled (wherever the battle left it).
    *afterAnyBattle(e, _c, p, a, t) {
      const pair = ctrl(e, a) === p && amz(a) ? t : ctrl(e, t) === p && amz(t) ? a : null;
      if (!pair || pair.token) return;
      const f = e.find(pair.uid);
      if (!f || f.card.owner !== other(p) || !(f.loc.zone === 'mz' || f.loc.zone === 'gy')) return;
      if (f.loc.zone === 'mz' && f.loc.player !== other(p)) return;
      if (!(yield* e.yesno(p, `Amazoness Onslaught: banish ${pair.name}?`))) return;
      e.banish(pair.uid);
    },
    *onDestroyed(e, _c, p) {
      const list = e.player(p).gy.filter((c) => amzMon(e, c) && canSS(e, c));
      if (!list.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Amazoness Onslaught: Special Summon an Amazoness from your GY?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which Amazoness?', list);
    },
  };

  E['Amazoness Paladin'] = {
    selfBonus: (e, m) => ({ atk: 100 * faceUpOf(e, ctrl(e, m)).filter((x) => amz(x)).length, def: 0 }),
  };

  const princessSearch = function* (e: Engine, _m: FieldCard, p: Pid): Step {
    const ok = (c: Card) => amz(c) && !isMonster(e, c);
    if (!e.oncePerTurn('Amazoness Princess', p) || !e.player(p).deck.some(ok)) return;
    if (!(yield* e.yesno(p, 'Amazoness Princess: add an Amazoness Spell/Trap from your Deck?'))) return;
    e.useOnce('Amazoness Princess', p);
    yield* searchDeck(e, p, 'Add which Amazoness Spell/Trap?', ok);
  };
  const princessDeck = (e: Engine, p: Pid) => e.player(p).deck.filter((c) => amzMon(e, c) && canSS(e, c) && !e.isNamed(c, 'Amazoness Princess'));
  // "Amazoness Queen" on the field and in the GY (its printed name rule, names.ts).
  E['Amazoness Princess'] = {
    fieldName: () => 'Amazoness Queen',
    *onSummon(e, m, p, kind) {
      if (kind === 'normal') yield* princessSearch(e, m, p);
    },
    onSpecialSummon: princessSearch,
    quick: {
      label: 'send a card to the GY to Special Summon an Amazoness',
      can: (e, c, p, t) =>
        t === 'attack' && e.state.battle?.attacker === c.uid && freeMZ(e, p) && princessDeck(e, p).length > 0 && (e.player(p).hand.length > 0 || stOf(e, p).length > 0 || e.monsters(p).length > 1),
      *cost(e, card, p) {
        const list = [...e.player(p).hand, ...e.monsters(p).filter((m) => m.uid !== card.uid), ...stOf(e, p)];
        const c = yield* pickOne(e, p, 'Amazoness Princess: send which card to the GY?', list, true);
        if (!c) return false;
        yield* e.sendToGrave(c.uid, 'cost');
      },
      *run(e, _c, p) {
        yield* summonOneOf(e, p, 'Special Summon which Amazoness in Defense Position?', princessDeck(e, p), 'def');
      },
    },
  };

  E['Amazoness Queen'] = {
    shields: (e, _src, target, how, srcCtl) => how === 'battle' && ctrl(e, target) === srcCtl && amz(target),
  };

  E['Amazoness Sage'] = {
    *afterBattle(e, _a, _t, p) {
      const c = yield* pickOne(e, p, 'Amazoness Sage: destroy which Spell/Trap?', stOf(e, other(p)));
      if (c) yield* e.destroy([c.uid]);
    },
  };

  E['Amazoness Shamanism'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && faceUpOf(e, p).some((m) => amz(m)),
    *resolve(e, _l, p) {
      const mine = faceUpOf(e, p).filter((m) => amz(m)).map((m) => m.uid);
      yield* e.destroy(mine);
      const n = mine.filter((u) => !e.fieldCard(u)).length;
      const list = () => e.player(p).gy.filter((c) => amzMon(e, c) && canSS(e, c) && levelOf(e, c) <= 4);
      const room = e.player(p).mz.filter((z) => z === null).length;
      if (!n || !room || !list().length || !(yield* e.yesno(p, 'Amazoness Shamanism: Special Summon Amazoness monsters from your GY?'))) return;
      const chosen = yield* pick(e, p, 'Special Summon which Amazoness monsters?', list(), 1, Math.min(n, room));
      for (const c of chosen ?? []) if (where(e, c.uid) === 'gy' && freeMZ(e, p)) yield* e.specialSummon(c.uid, p, 'def');
    },
  };

  const spellcasterTargets = (e: Engine, p: Pid) => [targetable(e, faceUpOf(e, p).filter((m) => amz(m))), targetable(e, faceUpOf(e, other(p)))];
  E['Amazoness Spellcaster'] = {
    canActivate: (e, _c, p, t) => isMain(t) && spellcasterTargets(e, p).every((l) => l.length > 0),
    *activate(e, link, p) {
      const [mine, theirs] = spellcasterTargets(e, p);
      const a = yield* pickOne(e, p, 'Amazoness Spellcaster: which Amazoness?', mine, true);
      if (!a) return false;
      const b = yield* pickOne(e, p, 'Swap original ATK with which opponent\'s monster?', theirs, true);
      if (!b) return false;
      link.payload = [a.uid, b.uid];
    },
    *resolve(e, link) {
      const [a, b] = (link.payload as number[]).map((u) => e.fieldCard(u));
      if (!a?.faceUp || !b?.faceUp) return;
      const oa = e.baseStats(a).atk;
      const ob = e.baseStats(b).atk;
      a.atkMod += ob - oa;
      b.atkMod += oa - ob;
      e.log(link.player, `${a.name} and ${b.name} switch original ATK this turn`);
    },
  };

  E['Amazoness Spy'] = {
    summonProc: {
      can: (e, c, p) => e.oncePerTurn(c.name, p) && freeMZ(e, p) && e.player(p).hand.some((x) => x.uid !== c.uid && amzMon(e, x)),
      *run(e, c, p) {
        const shown = yield* pickOne(e, p, 'Amazoness Spy: reveal which Amazoness monster?', e.player(p).hand.filter((x) => x.uid !== c.uid && amzMon(e, x)), true);
        if (!shown) return;
        e.useOnce(c.name, p);
        e.log(p, `${e.player(p).name} reveals ${shown.name}`);
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
    *onDestroyed(e, _c, p, byBattle) {
      const list = e.player(p).gy.filter((c) => amzMon(e, c) && !e.isNamed(c, 'Amazoness Spy'));
      if (!byBattle || !list.length || !(yield* e.yesno(p, 'Amazoness Spy: return an Amazoness from your GY?'))) return;
      const c = yield* pickOne(e, p, 'Amazoness Spy: which Amazoness?', list);
      if (!c) return;
      if ((yield* chooseOption(e, p, `${c.name}: return it to the hand or shuffle it into the Deck?`, ['Hand', 'Deck'])) === 1) {
        yield* returnToDeck(e, c.uid, false);
        e.player(c.owner).deck = e.shuffle(e.player(c.owner).deck);
      } else yield* returnToHand(e, c.uid);
    },
  };

  // audit-00: the engine's reflectBattleDamage sends the battle damage its controller would take to the opponent, as battle damage.
  E['Amazoness Swords Woman'] = {
    reflectBattleDamage: () => true,
  };

  // audit-00: monsters it destroys by battle go to the Deck instead of the GY (deckInstead: the engine shuffles them in),
  // then they are moved to the bottom; it gains 200 ATK when the destroyed monster was the opponent's.
  const trainee = function* (e: Engine, me: FieldCard, victim: FieldCard, p: Pid): Step {
    if (victim.token || victim.uid === me.uid) return;
    const f = e.find(victim.uid);
    if (f?.loc.zone === 'deck') {
      const deck = e.player(f.loc.player).deck;
      deck.push(...deck.splice(f.loc.index, 1));
      e.log(null, `${victim.name} goes to the bottom of the Deck`);
    }
    if (f && f.loc.zone !== 'mz' && e.fieldCard(me.uid)) tag(me).permAtk = (me.tags?.permAtk ?? 0) + 200;
  };
  E['Amazoness Trainee'] = {
    deckInstead: (e, m, moving) => {
      const b = e.state.battle;
      return !!b && moving.uid !== m.uid && ((b.attacker === m.uid && b.target === moving.uid) || (b.target === m.uid && b.attacker === moving.uid));
    },
    *afterBattle(e, a, t, p, destroyed) {
      if (destroyed && t) yield* trainee(e, a, t, p);
    },
    *onAttacked(e, self, attacker, p) {
      if (e.fieldCard(self.uid) && !e.fieldCard(attacker.uid)) yield* trainee(e, self, attacker, p);
    },
  };

  // audit-00: watches every destruction (battle or card effect) of an "Amazoness" monster that lands in the GY (onAnyToGrave), once per turn.
  E['Amazoness Village'] = {
    ...h.fieldSpell((_e, m) => (amz(m) ? { atk: 200, def: 0 } : undefined)),
    *onAnyToGrave(e, card, p, events) {
      if (!e.oncePerTurn(`village${card.uid}`, p) || !freeMZ(e, p)) return;
      const dead = events.filter((x) => x.reason === 'destroyed' && x.from === 'mz' && x.toGy && !x.token && amzMon(e, x.card) && where(e, x.card.uid) === 'gy');
      if (!dead.length) return;
      const lv = Math.max(...dead.map((x) => levelOf(e, x.card)));
      const list = e.player(p).deck.filter((c) => amzMon(e, c) && canSS(e, c) && levelOf(e, c) <= lv);
      if (!list.length || !(yield* e.yesno(p, 'Amazoness Village: Special Summon an Amazoness from your Deck?'))) return;
      e.useOnce(`village${card.uid}`, p);
      yield* summonOneOf(e, p, 'Amazoness Village: Special Summon which Amazoness?', list);
    },
  };

  // audit-00 approximation: "must attack if able" is not enforced; it is attached like an Equip so they leave the field together.
  const willpowerList = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => amzMon(e, c) && canSS(e, c));
  E['Amazoness Willpower'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && freeMZ(e, p) && willpowerList(e, p).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Amazoness Willpower: Special Summon which Amazoness?', willpowerList(e, p), true);
      if (!c) return false;
      link.targetUid = c.uid;
    },
    // spells-b: linked through tags.willHost instead of being attached like an Equip, so it is destroyed only when that monster
    // is destroyed (an attached card went to the GY, not destroyed, whenever the monster left the field in any way).
    *resolve(e, link, p) {
      const fc = e.fieldCard(link.card.uid);
      if (link.targetUid === undefined || where(e, link.targetUid) !== 'gy' || !fc || !freeMZ(e, p)) return;
      yield* e.specialSummon(link.targetUid, p, 'atk');
      const m = e.fieldCard(link.targetUid);
      if (!m) return;
      tag(fc).willHost = m.uid;
      m.cannotChangePos = true;
    },
    *onAnyToGrave(e, card, _p, events) {
      const host = card.tags?.willHost;
      if (host === undefined || !events.some((v) => v.card.uid === host && v.reason === 'destroyed' && v.from === 'mz')) return;
      delete tag(card).willHost;
      if (e.fieldCard(card.uid)) yield* e.destroy([card.uid]);
    },
    // The monster left the field some other way (returned to the hand, banished): the link ends.
    *stateCheck(e, card) {
      const host = card.tags?.willHost;
      if (host !== undefined && !e.fieldCard(host)) delete tag(card).willHost;
    },
    *onLeaveField(e, fc) {
      const host = fc.tags?.willHost;
      if (host !== undefined && e.fieldCard(host)) yield* e.destroy([host]);
    },
  };

  E['Ambulance Rescueroid'] = {
    summonRule: (_e, _c, _p, how, from) => how !== 'special' || from === 'fusion', // audit-00: only by Fusion Summon
    quick: {
      label: 'Special Summon the destroyed monster',
      can: (e, _c, p, t, ctx) => {
        if (t !== 'destroyed' || ctx.uid === undefined || ctx.prevController !== p || !freeMZ(e, p)) return false;
        const f = e.find(ctx.uid);
        return !!f && f.loc.zone === 'gy' && f.loc.player === p && canSS(e, f.card);
      },
      *run(e, _c, p, link) {
        const uid = (link.payload as { ctx: { uid: number } }).ctx.uid;
        if (where(e, uid) === 'gy' && e.find(uid)?.loc.player === p && freeMZ(e, p)) yield* e.specialSummon(uid, p, 'def');
      },
    },
  };

  // audit-00: "if it battles" covers being attacked too; the bonus applies while that battle is going on.
  E['Amulet of Ambition'] = h.equipFor((e, m) => isNormalMonster(e, m), undefined, {
    equipBonus: (e, eq, host) => {
      const t = eq.equippedTo === host.uid ? opponentInBattle(e, host.uid) : null;
      return { atk: t && levelOf(e, t) > levelOf(e, host) ? 500 * (levelOf(e, t) - levelOf(e, host)) : 0, def: 0 };
    },
    *onSentToGrave(e, card, owner) {
      if (!(yield* e.yesno(owner, 'Amulet of Ambition: place it on top of your Deck?'))) return;
      e.toDeckTop(card.uid);
    },
  });

  // Who sent it: onLeaveField runs before the engine switches the acting player to the card's owner.
  E['Anarchist Monk Ranshin'] = {
    *onLeaveField(e, fc) {
      ((e.state.fx.ranshinBy ??= {}) as Record<number, number | string>)[fc.uid] = e.actor ?? 'none';
    },
    *onDestroyed(e, card, _p, byBattle) {
      if (byBattle) ((e.state.fx.ranshinBy ??= {}) as Record<number, number | string>)[card.uid] = 'battle';
    },
    *onSentToGrave(e, card, owner, from) {
      const by = (e.state.fx.ranshinBy ?? {}) as Record<number, number | string>;
      const who = by[card.uid];
      delete by[card.uid];
      if (from !== 'mz' || (who !== 'battle' && who !== other(owner))) return;
      const c = yield* pickOne(e, owner, 'Anarchist Monk Ranshin: banish which monster from the opponent\'s GY?', e.player(other(owner)).gy.filter((x) => isMonster(e, x)));
      if (c) e.banish(c.uid);
    },
  };

  E['Ancient Dragon'] = {
    *onBattleDamage(e, a, p) {
      if (e.state.battle?.target !== null || !(yield* e.yesno(p, 'Ancient Dragon: increase its Level by 1 and ATK by 500?'))) return;
      tag(a).permAtk = (a.tags?.permAtk ?? 0) + 500;
      tag(a).lvMod = (a.tags?.lvMod ?? 0) + 1; // audit-00: the Level goes up too
    },
  };

  E['Ancient Gear'] = {
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && faceUpOf(e, p).some((m) => e.isNamed(m, 'Ancient Gear')),
      *run(e, c, p) {
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
  };

  E['Ancient Lamp'] = {
    ignition: {
      repeat: true,
      can: (e, _m, p) => freeMZ(e, p) && e.player(p).hand.some((c) => e.isNamed(c, 'La Jinn the Mystical Genie of the Lamp')),
      *run(e, m, p) {
        if (!m.faceUp) return;
        yield* summonOneOf(e, p, 'Ancient Lamp: Special Summon La Jinn?', e.player(p).hand.filter((c) => e.isNamed(c, 'La Jinn the Mystical Genie of the Lamp')));
      },
    },
    // audit-00: attacked while face-down: it can send the attack to another of the attacker's controller's monsters.
    // Approximation: that battle is worked out here (both monsters belong to the same player, so any damage goes to that player).
    *interceptAttack(e, lamp, attacker, p) {
      const others = targetable(e, e.monsters(other(p)).filter((m) => m.uid !== attacker.uid));
      lamp.faceUp = true;
      e.event('flip', { uid: lamp.uid, player: p });
      e.log(p, `${lamp.name} was flipped face-up`);
      if (!others.length || !(yield* e.yesno(p, 'Ancient Lamp: make the attacker attack another of its controller\'s monsters?'))) return false;
      const t = yield* pickOne(e, p, 'Ancient Lamp: the attacker attacks which monster instead?', others);
      if (!t || !e.fieldCard(t.uid) || !e.fieldCard(attacker.uid)) return false;
      const owner = other(p);
      if (!t.faceUp) {
        t.faceUp = true;
        e.event('flip', { uid: t.uid, player: owner });
      }
      e.log(p, `${attacker.name} attacks ${t.name} instead`);
      const atk = e.atkOf(attacker);
      const dead: number[] = [];
      if (t.pos === 'atk') {
        const ta = e.atkOf(t);
        if (atk !== ta || atk > 0) {
          if (atk >= ta) dead.push(t.uid);
          if (atk <= ta) dead.push(attacker.uid);
        }
        if (atk !== ta) e.damage(owner, Math.abs(atk - ta));
      } else {
        const td = e.defOf(t);
        if (atk > td) dead.push(t.uid);
        else if (atk < td) e.damage(owner, td - atk);
      }
      if (dead.length && e.state.winner === null) yield* e.destroy(dead, 'destroyed', true);
      return true;
    },
  };

  E['Angel O1'] = {
    summonProc: {
      can: (e, c, p) => e.oncePerTurn(c.name, p) && freeMZ(e, p) && e.player(p).hand.some((x) => x.uid !== c.uid && isMonster(e, x) && levelOf(e, x) >= 7),
      *run(e, c, p) {
        const shown = yield* pickOne(e, p, 'Angel O1: reveal which Level 7 or higher monster?', e.player(p).hand.filter((x) => x.uid !== c.uid && isMonster(e, x) && levelOf(e, x) >= 7), true);
        if (!shown) return;
        e.useOnce(c.name, p);
        e.log(p, `${e.player(p).name} reveals ${shown.name}`);
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
    // audit-00: while you control this Special Summoned card you may Tribute Summon once more this turn (the engine's extra Tribute Summon).
    // Approximation: any monster needing Tributes qualifies (not only Level 7 or higher), in either position, and it stays this turn if Angel O1 leaves.
    *stateCheck(e, m, p) {
      const got = (e.state.fx.angelO1 ??= [-1, -1]) as number[];
      if (!m.tags?.ss || got[p] === e.state.turn || e.state.turnPlayer !== p) return;
      got[p] = e.state.turn;
      ((e.state.fx.extraTribute ??= [-1, -1]) as number[])[p] = e.state.turn;
    },
  };

  const archosaurDinos = (e: Engine, p: Pid) =>
    [...e.player(p).hand.filter((c) => isMonster(e, c)), ...faceUpOf(e, p)].filter((c) => info(e, c).race === 'Dinosaur' && !e.isNamed(c, 'Animadorned Archosaur'));
  const archosaur = function* (e: Engine, _m: FieldCard, p: Pid): Step {
    if (!e.oncePerTurn('Animadorned Archosaur', p) || !archosaurDinos(e, p).length) return;
    if (!(yield* e.yesno(p, 'Animadorned Archosaur: destroy a Dinosaur to search?'))) return;
    const d = yield* pickOne(e, p, 'Destroy which Dinosaur?', archosaurDinos(e, p));
    if (!d) return;
    e.useOnce('Animadorned Archosaur', p);
    const lv = info(e, d).level ?? 0; // audit-00: the destroyed monster's original Level
    if (where(e, d.uid) === 'hand') yield* e.sendToGrave(d.uid, 'destroyed');
    else yield* e.destroy([d.uid]);
    if (where(e, d.uid) !== 'gy') return;
    const ok = (c: Card) => (isMonster(e, c) && ['Reptile', 'Sea Serpent', 'Winged Beast'].includes(info(e, c).race ?? '') && (info(e, c).level ?? 0) === lv) || (isSpell(e, c) && named(e, c, 'Evolution Pill'));
    yield* searchDeck(e, p, 'Add which card?', ok);
  };
  E['Animadorned Archosaur'] = {
    *onSummon(e, m, p, kind) {
      if (kind === 'normal') yield* archosaur(e, m, p);
    },
    onSpecialSummon: archosaur,
  };

  E['Annihilator Archfiend'] = {
    ignition: {
      can: (e, m, p) => e.oncePerTurn(m.name, p) && targetable(e, e.monsters(other(p))).length + stOf(e, other(p)).length > 0,
      *run(e, m, p) {
        e.useOnce(m.name, p);
        const mine = yield* pickOne(e, p, 'Annihilator Archfiend: destroy which of your cards?', [...e.monsters(p), ...stOf(e, p)]);
        const theirs = yield* pickOne(e, p, 'Destroy which of your opponent\'s cards?', [...targetable(e, e.monsters(other(p))), ...stOf(e, other(p))]);
        if (!mine || !theirs) return;
        const fiends = [mine, theirs].filter((c) => c.faceUp && isMonster(e, c) && raceOf(e, c) === 'Fiend').map((c) => ({ uid: c.uid, half: Math.floor(e.baseStats(c).atk / 2) }));
        yield* e.destroy([mine.uid, theirs.uid]);
        const gain = fiends.filter((f) => !e.fieldCard(f.uid)).reduce((a, f) => a + f.half, 0);
        if (gain && e.fieldCard(m.uid)) m.atkMod += gain;
      },
    },
  };

  const apprenticeCounter = function* (e: Engine, _m: FieldCard, p: Pid): Step {
    yield* addCounter(e, p, 'Apprentice Magician: place a Spell Counter on which card?', counterHolders(e));
  };
  E['Apprentice Magician'] = {
    onSummon: (e, m, p) => apprenticeCounter(e, m, p),
    onSpecialSummon: apprenticeCounter,
    *onDestroyed(e, _c, p, byBattle) {
      const list = e.player(p).deck.filter((c) => canSS(e, c) && info(e, c).race === 'Spellcaster' && levelOf(e, c) <= 2);
      if (!byBattle || !freeMZ(e, p) || !list.length || !(yield* e.yesno(p, 'Apprentice Magician: Special Summon a Spellcaster face-down?'))) return;
      const c = yield* pickOne(e, p, 'Special Summon which Spellcaster in face-down Defense Position?', list);
      if (!c) return;
      yield* e.specialSummon(c.uid, p, 'def', false);
      e.player(p).deck = e.shuffle(e.player(p).deck);
    },
  };

  E['Aqua Spirit'] = {
    cannotNormalSummon: true,
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && e.player(p).gy.some((c) => isMonster(e, c) && attrOf(e, c) === 'WATER'),
      *run(e, c, p) {
        const w = yield* pickOne(e, p, 'Aqua Spirit: banish which WATER monster from your GY?', e.player(p).gy.filter((x) => isMonster(e, x) && attrOf(e, x) === 'WATER'), true);
        if (!w) return;
        e.banish(w.uid);
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
    *onStandby(e, _m, p) {
      const list = faceUpOf(e, other(p));
      if (e.state.turnPlayer === p || !list.length || !(yield* e.yesno(p, 'Aqua Spirit: change the position of an opponent\'s monster?'))) return;
      const t = yield* pickOne(e, p, 'Change which monster\'s battle position?', list);
      if (!t) return;
      t.pos = t.pos === 'atk' ? 'def' : 'atk';
      tag(t).lockPosTurn = e.state.turn;
      e.event('position', { uid: t.uid });
      e.log(p, `${t.name} changes position and must stay that way this turn`);
    },
  };

  // ---------- Arcana Force ----------
  const lockAtk = function* (_e: Engine, m: FieldCard): Step {
    if (m.pos === 'atk') m.cannotChangePos = true;
  };
  // audit-00: the coin toss was missing. Heads: your card effects that target it are negated and destroyed; Tails: your opponent's
  // (applied as the effect resolves, through onChainLink).
  const foolCoin = arcanaCoin(function* (e, m) {
    yield* lockAtk(e, m);
  });
  E['Arcana Force 0 - The Fool'] = {
    battleProof: () => true,
    ...foolCoin,
    *onChainLink(e, m, p, link) {
      if (!m.tags?.coin || link.targetUid !== m.uid || link.player !== (heads(m) ? p : other(p))) return;
      link.negated = true;
      e.log(p, `The Fool negates ${link.card.name}`);
      if (e.fieldCard(link.card.uid)) yield* e.destroy([link.card.uid]);
    },
  };

  const exHeads = function* (e: Engine, me: FieldCard, p: Pid, victim: FieldCard): Step {
    if (!heads(me) || where(e, victim.uid) !== 'gy' || e.find(victim.uid)?.loc.player !== other(p) || !e.player(p).gy.length) return;
    if (!(yield* e.yesno(p, 'The Light Ruler: add a card from your GY to your hand?'))) return;
    const c = yield* pickOne(e, p, 'Add which card?', e.player(p).gy);
    if (c) e.toHandOf(c.uid, p);
  };
  E['Arcana Force EX - The Light Ruler'] = {
    cannotNormalSummon: true,
    // audit-00: only Special Summoned from the hand (its procedure); approximation: another effect Summoning it from the hand is not stopped.
    summonRule: (_e, _c, _p, how, from) => how !== 'special' || from === 'hand',
    // audit-00: Tails was missing: an effect targeting it costs it exactly 1000 ATK, and is negated and destroyed (applied as it resolves).
    *onChainLink(e, m, p, link) {
      if (!tails(m) || link.targetUid !== m.uid || e.atkOf(m) < 1000) return;
      tag(m).permAtk = (m.tags?.permAtk ?? 0) - 1000;
      negateLink(e, link, p);
      if (link.negated && e.fieldCard(link.card.uid)) yield* e.destroy([link.card.uid]);
    },
    summonProc: {
      can: (e, _c, p) => e.monsters(p).length >= 3,
      *run(e, c, p) {
        const chosen = yield* pick(e, p, 'The Light Ruler: send which 3 monsters to the GY?', e.monsters(p), 3, 3, true, false);
        if (!chosen) return;
        for (const m of chosen) yield* e.sendToGrave(m.uid, 'cost');
        if (freeMZ(e, p)) yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
    onSpecialSummon: arcanaCoin().onSpecialSummon,
    *afterBattle(e, a, t, p, destroyed) {
      if (destroyed && t) yield* exHeads(e, a, p, t);
    },
    *onAttacked(e, self, attacker, p) {
      if (e.fieldCard(self.uid)) yield* exHeads(e, self, p, attacker);
    },
  };

  // audit-00: Sets count too (the engine now lets face-up monsters watch Sets: onAnySet).
  const empress = function* (e: Engine, w: FieldCard, wp: Pid): Step {
    if (heads(w)) {
      const list = e.player(wp).hand.filter((c) => canSS(e, c) && named(e, c, 'Arcana Force'));
      if (!list.length || !freeMZ(e, wp) || !(yield* e.yesno(wp, 'The Empress: Special Summon an Arcana Force from your hand?'))) return;
      yield* summonOneOf(e, wp, 'Special Summon which Arcana Force?', list);
    } else if (tails(w)) {
      const c = yield* pickOne(e, wp, 'The Empress: send which card from your hand to the GY?', e.player(wp).hand);
      if (c) yield* e.sendToGrave(c.uid, 'used');
    }
  };
  E['Arcana Force III - The Empress'] = {
    ...arcanaCoin(),
    *onAnySummon(e, w, wp, _m, controller, kind) {
      if (controller === other(wp) && kind === 'normal') yield* empress(e, w, wp);
    },
    *onAnySet(e, w, wp, _m, controller) {
      if (controller === other(wp)) yield* empress(e, w, wp);
    },
  };

  E['Arcana Force IV - The Emperor'] = {
    ...arcanaCoin(),
    aura: (e, src, target, srcCtl) => (src.tags?.coin && target.faceUp && ctrl(e, target) === srcCtl && named(e, target, 'Arcana Force') ? { atk: heads(src) ? 500 : -500, def: 0 } : undefined),
  };

  const chariotTake = function* (e: Engine, me: FieldCard, p: Pid, victim: FieldCard): Step {
    if (!heads(me) || where(e, victim.uid) !== 'gy' || !canSS(e, victim) || !freeMZ(e, p)) return;
    if (!(yield* e.yesno(p, `The Chariot: Special Summon ${victim.name} to your field?`))) return;
    yield* e.specialSummon(victim.uid, p, 'atk');
  };
  E['Arcana Force VII - The Chariot'] = {
    ...arcanaCoin(function* (e, m, p, isHeads) {
      if (!isHeads && e.takeControl(m.uid, other(p))) e.log(p, 'The Chariot: the opponent gains control of it');
    }),
    *afterBattle(e, a, t, p, destroyed) {
      if (destroyed && t) yield* chariotTake(e, a, p, t);
    },
    *onAttacked(e, self, attacker, p) {
      if (e.fieldCard(self.uid)) yield* chariotTake(e, self, p, attacker);
    },
  };

  E['Arcana Force XVIII - The Moon'] = {
    ...arcanaCoin(),
    *onStandby(e, m, p) {
      if (!heads(m) || e.state.turnPlayer !== p || !freeMZ(e, p) || !(yield* e.yesno(p, 'The Moon: Special Summon a Moon Token?'))) return;
      e.createToken('Moon Token', p, 'def', true, { atk: 0, def: 0, level: 1, attribute: 'LIGHT', race: 'Fairy' });
    },
    *onEndPhase(e, m, p) {
      if (!tails(m) || e.state.turnPlayer !== p || !freeMZ(e, other(p))) return;
      const t = yield* pickOne(e, p, 'The Moon: give control of which monster to your opponent?', e.monsters(p), false);
      if (t && e.takeControl(t.uid, other(p))) e.log(p, `${t.faceUp ? t.name : 'A monster'} goes to the opponent`);
    },
  };

  // Negates Spell/Trap effects that target it (monster effects here rarely record a target).
  E['Arcana Knight Joker'] = {
    quick: {
      label: 'discard the same card type to negate',
      can: (e, c, p, t, ctx) => {
        const l = ctx.link;
        if (!(t === 'spell' || t === 'trap' || t === 'effect') || !l || l.targetUid !== c.uid) return false;
        const kind = info(e, l.card).kind;
        return e.player(p).hand.some((x) => info(e, x).kind === kind);
      },
      *cost(e, _card, p, _link, ctx) {
        const kind = info(e, ctx.link!.card).kind;
        return yield* discardCost(e, p, 1, (x) => info(e, x).kind === kind);
      },
      *run(e, _c, p, link) {
        negateLink(e, (link.payload as { ctx: { link?: typeof link } }).ctx.link, p);
      },
    },
  };

  const coinCard = (e: Engine, c: Card) => /toss(es)? a coin|coin toss/i.test(info(e, c).desc) && !e.isNamed(c, 'Arcana Reading');
  E['Arcana Reading'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p),
    *activate(e, link, p) {
      e.useOnce(link.card.name, p);
    },
    *resolve(e, _l, p) {
      const barrier = e.player(p).field?.faceUp && e.player(p).field?.name === 'Light Barrier';
      const isHeads = barrier ? (yield* chooseOption(e, p, 'Light Barrier: apply which effect?', ['Heads: search a coin card', 'Tails: opponent searches'])) === 0 : coin(e, p, 'Arcana Reading');
      if (isHeads) yield* searchDeck(e, p, 'Arcana Reading: add which coin-tossing card?', (c) => coinCard(e, c));
      else yield* searchDeck(e, other(p), 'Arcana Reading: add which card from your Deck?', () => true);
    },
    // audit-00: the GY effect was missing: banish it, then Normal Summon 1 "Arcana Force" monster (in addition to the usual Normal Summon).
    graveIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Arcana Reading GY', p) && readingSummons(e, p).length > 0,
      *run(e, card, p) {
        const m = yield* pickOne(e, p, 'Arcana Reading: Normal Summon which "Arcana Force" monster?', readingSummons(e, p), true);
        if (!m) return;
        e.useOnce('Arcana Reading GY', p);
        e.banish(card.uid);
        yield* e.extraNormalSummon(p, m.uid, 'atk', true);
      },
    },
  };
  const readingSummons = (e: Engine, p: Pid) => e.player(p).hand.filter((c) => isMonster(e, c) && named(e, c, 'Arcana Force') && e.canNormalSummon(p, c, true, true));

  const knights = ["Queen's Knight", "King's Knight", "Jack's Knight"];
  const knightPool = (e: Engine, p: Pid) => [...e.player(p).hand, ...faceUpOf(e, p)];
  const hasKnights = (e: Engine, p: Pid) => knights.every((n) => knightPool(e, p).some((c) => c.name === n));
  const triumphSummon = function* (e: Engine, card: Card, p: Pid): Step {
    const used: Card[] = [];
    for (const n of knights) {
      const c = yield* pickOne(e, p, `Arcana Triumph Joker: send which ${n}?`, knightPool(e, p).filter((x) => x.name === n), true);
      if (!c) return;
      used.push(c);
    }
    for (const c of used) yield* e.sendToGrave(c.uid, 'cost');
    if (freeMZ(e, p) && ['hand', 'gy'].includes(where(e, card.uid) ?? '')) yield* e.specialSummon(card.uid, p, 'atk');
  };
  const triumphCan = (e: Engine, p: Pid) => hasKnights(e, p) && (freeMZ(e, p) || faceUpOf(e, p).some((m) => e.namesOf(m).some((nm) => knights.includes(nm))));
  E['Arcana Triumph Joker'] = {
    baseStats: (e, m) => ({ atk: 0, def: info(e, m).def ?? 0 }),
    selfBonus: (e) => ({ atk: 500 * (e.player(0).hand.length + e.player(1).hand.length), def: 0 }),
    summonProc: { can: (e, _c, p) => triumphCan(e, p), run: triumphSummon },
    graveIgnition: { can: (e, _c, p) => triumphCan(e, p), run: triumphSummon },
    ignition: {
      repeat: true,
      can: (e, _m, p) => e.player(p).hand.length > 0 && [...faceUpOf(e, other(p)), ...stOf(e, other(p)).filter((c) => c.faceUp)].length > 0,
      *run(e, m, p) {
        if (!m.faceUp) return;
        const c = yield* pickOne(e, p, 'Arcana Triumph Joker: discard which card?', e.player(p).hand);
        if (!c) return;
        const kind = info(e, c).kind;
        yield* e.discard(p, c.uid);
        const doomed = [...faceUpOf(e, other(p)), ...stOf(e, other(p)).filter((x) => x.faceUp)].filter((x) => info(e, x).kind === kind);
        yield* e.destroy(doomed.map((x) => x.uid));
      },
    },
  };

  // ---------- Archfiend ----------
  const pandemonium = (e: Engine) => allST(e).some((c) => c.faceUp && e.isNamed(c, 'Pandemonium'));
  const generalCheck = function* (e: Engine, m: FieldCard): Step {
    if (!pandemonium(e) && e.fieldCard(m.uid)) {
      e.log(null, 'Archfiend General crumbles without Pandemonium');
      yield* e.destroy([m.uid]);
    }
  };
  E['Archfiend General'] = {
    handIgnition: {
      can: (e, _c, p) => e.player(p).deck.some((c) => e.isNamed(c, 'Pandemonium')),
      *run(e, c, p) {
        yield* e.discard(p, c.uid);
        yield* searchDeck(e, p, 'Add Pandemonium?', (x) => e.isNamed(x, 'Pandemonium'));
      },
    },
    // audit-00: checked after every action (it used to be checked only when Summoned and in the Standby/End Phase).
    stateCheck: (e, m) => generalCheck(e, m),
  };

  E['Archfiend of Gilfer'] = {
    *onSentToGrave(e, card, owner) {
      const zone = freeST(e, owner);
      const list = targetable(e, faceUpMonsters(e));
      if (zone < 0 || !list.length || !(yield* e.yesno(owner, 'Archfiend of Gilfer: equip it to a monster?'))) return;
      const host = yield* pickOne(e, owner, 'Equip Archfiend of Gilfer to which monster?', list);
      const ps = e.player(owner);
      if (!host || !e.fieldCard(host.uid) || where(e, card.uid) !== 'gy' || ps.sz[zone] !== null) return;
      ps.gy = ps.gy.filter((c) => c.uid !== card.uid);
      const fc: FieldCard = { ...card, pos: 'atk', faceUp: true, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true, equippedTo: host.uid };
      ps.sz[zone] = fc;
      host.equips.push(fc.uid);
      e.event('summon', { uid: fc.uid, player: owner });
      e.log(owner, `Archfiend of Gilfer is equipped to ${host.name}`);
    },
    equipBonus: (_e, eq, host) => (eq.equippedTo === host.uid ? { atk: -500, def: 0 } : { atk: 0, def: 0 }),
  };

  const ownNames = (e: Engine, p: Pid) => {
    const ps = e.player(p);
    const all = [...ps.deck, ...ps.hand, ...ps.gy, ...ps.removed, ...e.monsters(p), ...stOf(e, p)].filter((c) => !c.token);
    return [...new Set(all.map((c) => c.name))].sort();
  };
  E["Archfiend's Oath"] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    ignition: {
      repeat: true,
      can: (e, c, p) => e.oncePerTurn(`oath${c.uid}`, p) && e.player(p).lp > 500 && e.player(p).deck.length > 0,
      *run(e, c, p) {
        const names = ownNames(e, p);
        const i = yield* chooseOption(e, p, "Archfiend's Oath: declare a card name", names, true);
        if (i === null || !payLp(e, p, 500)) return;
        e.useOnce(`oath${c.uid}`, p);
        const top = e.player(p).deck[0];
        if (!top) return;
        e.log(p, `${e.player(p).name} declares ${names[i]} and excavates ${top.name}`);
        if (top.name === names[i]) e.toHandOf(top.uid, p);
        else yield* e.sendToGrave(top.uid, 'mill');
      },
    },
  };

  const roarList = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => canSS(e, c) && named(e, c, 'Archfiend'));
  E["Archfiend's Roar"] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.player(p).lp > 500 && freeMZ(e, p) && roarList(e, p).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, "Archfiend's Roar: Special Summon which Archfiend?", roarList(e, p), true);
      if (!c || !payLp(e, p, 500)) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid === undefined || where(e, link.targetUid) !== 'gy' || !freeMZ(e, p)) return;
      yield* e.specialSummon(link.targetUid, p, 'atk');
      const m = e.fieldCard(link.targetUid);
      if (m) m.doomAt = e.state.turn;
      if (m) tag(m).cannotTribute = 1; // audit-00: it cannot be Tributed
    },
  };

  // ---------- Armed Dragon ----------
  E['Armed Dragon LV10'] = {
    cannotNormalSummon: true,
    summonProc: {
      can: (e, _c, p) => faceUpOf(e, p).some((m) => e.isNamed(m, 'Armed Dragon LV7')),
      *run(e, c, p) {
        const lv7 = yield* pickOne(e, p, 'Tribute which Armed Dragon LV7?', faceUpOf(e, p).filter((m) => e.isNamed(m, 'Armed Dragon LV7')), true);
        if (!lv7) return;
        yield* e.sendToGrave(lv7.uid, 'tribute');
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
    ignition: {
      repeat: true,
      can: (e, _m, p) => e.player(p).hand.length > 0 && faceUpOf(e, other(p)).length > 0,
      *run(e, m, p) {
        if (!m.faceUp) return;
        const c = yield* pickOne(e, p, 'Armed Dragon LV10: send which card from your hand to the GY?', e.player(p).hand);
        if (!c) return;
        yield* e.sendToGrave(c.uid, 'cost');
        yield* e.destroy(faceUpOf(e, other(p)).map((x) => x.uid));
      },
    },
  };

  const whiteMats = (e: Engine, p: Pid) => [...faceUpOf(e, p), ...e.player(p).gy].filter((c) => isMonster(e, c) && named(e, c, 'Armed Dragon'));
  E['Armed Dragon LV10 White'] = {
    cannotNormalSummon: true,
    handIgnition: {
      can: (e, c, p) =>
        e.oncePerTurn(c.name, p) && subsetSum(whiteMats(e, p).map((x) => levelOf(e, x)), 10) && (freeMZ(e, p) || faceUpOf(e, p).some((m) => named(e, m, 'Armed Dragon'))),
      *run(e, c, p) {
        const mats = yield* pickLevels(e, p, 'Banish Armed Dragon monsters with total Level 10', whiteMats(e, p), 10);
        if (!mats) return;
        e.useOnce(c.name, p);
        for (const m of mats) e.banish(m.uid);
        if (!freeMZ(e, p) || where(e, c.uid) !== 'hand') return;
        e.state.fx.whiteOwn = c.uid;
        try {
          yield* e.specialSummon(c.uid, p, 'atk');
        } finally {
          e.state.fx.whiteOwn = undefined;
        }
        if (e.player(p).deck.some((x) => e.isNamed(x, 'White Veil')) && (yield* e.yesno(p, 'Add White Veil from your Deck?'))) yield* searchDeck(e, p, 'Add White Veil', (x) => e.isNamed(x, 'White Veil'));
      },
    },
    // audit-00: "Must be Special Summoned by its own effect" and "You take no effect damage" were missing.
    summonRule: (e, c, _p, how) => how !== 'special' || e.state.fx.whiteOwn === c.uid,
    damageMod: (_e, _src, ctl, damaged, _amount, byEffect) => (byEffect && damaged === ctl ? 0 : undefined),
    // audit-00: at the start of the Damage Step (it used to be offered when the attack was declared).
    *damageStepStart(e, m, _foe, p) {
      if (e.state.battle?.attacker !== m.uid) return;
      const list = [...allMonsters(e), ...allST(e)].filter((x) => x.uid !== m.uid);
      if (!list.length || !(yield* e.yesno(p, 'Armed Dragon LV10 White: destroy 1 card on the field?'))) return;
      const t = yield* pickOne(e, p, 'Armed Dragon LV10 White: destroy which card?', list);
      if (t) yield* e.destroy([t.uid]);
    },
  };

  const lvUp = (e: Engine, p: Pid, name: string) => [...e.player(p).hand, ...e.player(p).deck].filter((c) => c.name === name);
  const levelUp = function* (e: Engine, m: FieldCard, p: Pid, name: string): Step {
    if (!lvUp(e, p, name).length || !(yield* e.yesno(p, `${m.name}: send it to the GY to Special Summon ${name}?`))) return;
    yield* e.sendToGrave(m.uid, 'cost');
    yield* summonOneOf(e, p, `Special Summon ${name}`, lvUp(e, p, name));
  };
  E['Armed Dragon LV3'] = {
    *onStandby(e, m, p) {
      if (e.state.turnPlayer === p) yield* levelUp(e, m, p, 'Armed Dragon LV5');
    },
  };

  const lv5Targets = (e: Engine, p: Pid, atk: number) => targetable(e, faceUpOf(e, other(p))).filter((m) => e.atkOf(m) <= atk);
  const lv5Kill = (m: FieldCard, e: Engine) => (tag(m).lv5Kill = e.state.turn);
  E['Armed Dragon LV5'] = {
    ignition: {
      repeat: true,
      can: (e, _m, p) => e.player(p).hand.some((c) => isMonster(e, c) && lv5Targets(e, p, info(e, c).atk ?? 0).length > 0),
      *run(e, m, p) {
        if (!m.faceUp) return;
        const c = yield* pickOne(e, p, 'Armed Dragon LV5: send which monster from your hand to the GY?', e.player(p).hand.filter((x) => isMonster(e, x) && lv5Targets(e, p, info(e, x).atk ?? 0).length > 0));
        if (!c) return;
        const atk = info(e, c).atk ?? 0;
        yield* e.sendToGrave(c.uid, 'cost');
        const t = yield* pickOne(e, p, 'Destroy which monster?', lv5Targets(e, p, atk));
        if (t) yield* e.destroy([t.uid]);
      },
    },
    *afterBattle(e, a, _t, _p, destroyed) {
      if (destroyed) lv5Kill(a, e);
    },
    *onAttacked(e, self, attacker) {
      if (e.fieldCard(self.uid) && where(e, attacker.uid) === 'gy') lv5Kill(self, e);
    },
    *onEndPhase(e, m, p) {
      if (m.tags?.lv5Kill === e.state.turn) yield* levelUp(e, m, p, 'Armed Dragon LV7');
    },
  };

  E['Armed Dragon LV7'] = {
    cannotNormalSummon: true,
    ignition: {
      repeat: true,
      can: (e, _m, p) => e.player(p).hand.some((c) => isMonster(e, c)) && e.monsters(other(p)).length > 0,
      *run(e, m, p) {
        if (!m.faceUp) return;
        const c = yield* pickOne(e, p, 'Armed Dragon LV7: send which monster from your hand to the GY?', e.player(p).hand.filter((x) => isMonster(e, x)));
        if (!c) return;
        const atk = info(e, c).atk ?? 0;
        yield* e.sendToGrave(c.uid, 'cost');
        yield* e.destroy(e.monsters(other(p)).filter((x) => e.atkOf(x) <= atk).map((x) => x.uid));
      },
    },
  };

  // ---------- As - Be ----------
  E['Assault on GHQ'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.monsters(p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Assault on GHQ: destroy which of your monsters?', targetable(e, e.monsters(p)), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid === undefined || !e.fieldCard(link.targetUid)) return;
      yield* e.destroy([link.targetUid]);
      if (!e.fieldCard(link.targetUid)) yield* millTop(e, other(p), 2);
    },
  };

  E['Asura Priest'] = {
    cannotSpecialSummon: true, // audit-00: "Cannot be Special Summoned"
    // audit-00: flipped face-up by an attack also counts as "flipped face-up" for its return to the hand.
    *interceptAttack(e, m) {
      tag(m).spiritTurn = e.state.turn;
      return false;
    },
    attacks(e, m) {
      const done = m.attacked ? m.tags?.attacksMade ?? 1 : 0;
      return done + e.monsters(other(ctrl(e, m))).filter((t) => m.tags?.[`hit${t.uid}`] !== e.state.turn).length;
    },
    targetFilter: (e, m, t) => m.tags?.[`hit${t.uid}`] !== e.state.turn,
    *afterBattle(e, a, t) {
      if (t) tag(a)[`hit${t.uid}`] = e.state.turn;
    },
    *onSummon(e, m) {
      tag(m).spiritTurn = e.state.turn;
    },
    *onEndPhase(e, m, p) {
      if (m.tags?.spiritTurn !== e.state.turn) return;
      e.log(p, 'Asura Priest returns to the hand');
      yield* returnToHand(e, m.uid);
    },
  };

  E['Atlantean Marksman'] = {
    *onBattleDamage(e, _a, p) {
      const list = e.player(p).deck.filter((c) => canSS(e, c) && named(e, c, 'Atlantean') && !e.isNamed(c, 'Atlantean Marksman') && info(e, c).race === 'Sea Serpent' && levelOf(e, c) <= 4);
      if (!list.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Atlantean Marksman: Special Summon an Atlantean from your Deck?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which Atlantean?', list);
    },
    // audit-00: the second effect was missing. Approximation: "sent to the GY to activate a WATER monster's effect" is read as
    // discarded, sent or Tributed from the hand or field while a WATER monster's effect is being activated or resolved.
    *onSentToGrave(e, card, owner, from, reason) {
      if (!['discard', 'cost', 'tribute'].includes(reason) || from === 'deck' || from === 'gy') return;
      const src = e.resolvingCard() ?? e.state.chain[e.state.chain.length - 1]?.card;
      if (!src || src.uid === card.uid || !isMonster(e, src) || attrOf(e, src) !== 'WATER') return;
      const sets = [...e.monsters(other(owner)), ...stOf(e, other(owner))].filter((c) => !c.faceUp);
      const t = yield* pickOne(e, owner, 'Atlantean Marksman: destroy which Set card?', sets);
      if (t) yield* e.destroy([t.uid]);
    },
  };

  const babyDino = function* (e: Engine, p: Pid): Step {
    if (!freeMZ(e, p)) return;
    yield* summonOneOf(e, p, 'Babycerasaurus: Special Summon which Dinosaur?', e.player(p).deck.filter((c) => canSS(e, c) && info(e, c).race === 'Dinosaur' && levelOf(e, c) <= 4));
  };
  E['Babycerasaurus'] = {
    *onDestroyed(e, card, _p, byBattle) {
      if (!byBattle) yield* babyDino(e, card.owner);
    },
    *onSentToGrave(e, _card, owner, from, reason) {
      if (reason === 'destroyed' && (from === 'hand' || from === 'deck')) yield* babyDino(e, owner);
    },
  };

  // spells-b: only damage your opponent caused counts: the effect of a card they control, or an attack by their monster
  // (it used to count any damage outside your own Battle Phase, your own cards' damage included). damageMod watches each hit
  // as it happens (it never changes the amount) and keeps the opponent's share of the damage since the last damage window.
  const squad = (e: Engine) => (e.state.fx.backupSquad ??= {}) as Record<number, number>;
  E['Backup Squad'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    damageMod(e, src, srcCtl, damaged, amount, byEffect) {
      if (damaged !== srcCtl || amount <= 0) return undefined;
      const fresh = !((e.state.fx.hurt as number[] | undefined)?.[damaged] ?? 0);
      const b = e.state.battle;
      const atk = b ? e.fieldCard(b.attacker) : null;
      const byOpp = byEffect ? e.actor === other(damaged) : !!atk && e.controller(atk.uid) === other(damaged);
      squad(e)[src.uid] = (fresh ? 0 : squad(e)[src.uid] ?? 0) + (byOpp ? amount : 0);
      return undefined;
    },
    quick: {
      repeat: true,
      label: 'draw for the damage taken',
      can: (e, c, p, t, ctx) => t === 'damage' && notChained(e, c) && ctx.damaged === p && Math.min(ctx.amount ?? 0, squad(e)[c.uid] ?? 0) >= 1000,
      *cost(e, c, _p, link, ctx) {
        link.payload = { ...(link.payload as object), n: Math.floor(Math.min(ctx.amount ?? 0, squad(e)[c.uid] ?? 0) / 1000) };
        squad(e)[c.uid] = 0;
      },
      *run(e, _c, p, link) {
        const n = (link.payload as { n?: number }).n ?? 0;
        if (n) e.draw(p, n);
      },
    },
  };

  const darklord = (c: Card) => named(nameEngine(), c, 'Darklord') && !nameEngine().isNamed(c, 'Banishment of the Darklords');
  E['Banishment of the Darklords'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p) && e.player(p).deck.some(darklord),
    *activate(e, link, p) {
      e.useOnce(link.card.name, p);
    },
    *resolve(e, _l, p) {
      yield* searchDeck(e, p, 'Add which Darklord card?', darklord);
    },
  };

  // Activated when the attack is declared (the engine has no Damage Step window).
  const barkBattle = (e: Engine, p: Pid) => {
    const b = e.state.battle;
    if (!b || b.target === null) return null;
    for (const [mine, theirs] of [[b.attacker, b.target], [b.target, b.attacker]]) {
      const m = e.fieldCard(mine);
      const o = e.fieldCard(theirs);
      if (m && o && m.faceUp && ctrl(e, m) === p && raceOf(e, m) === 'Fiend' && ctrl(e, o) === other(p)) return o;
    }
    return null;
  };
  E['Bark of Dark Ruler'] = {
    canActivate: (e, _c, p, t) => t === 'attack' && e.player(p).lp > 100 && !!barkBattle(e, p),
    *activate(e, link, p) {
      const o = barkBattle(e, p);
      if (!o) return false;
      const most = Math.min(e.player(p).lp - 1, Math.max(e.atkOf(o), e.defOf(o), 100));
      const steps = Math.max(1, Math.min(40, Math.ceil(most / 100)));
      const opts = Array.from({ length: steps }, (_, i) => Math.min(most, (i + 1) * 100)).filter((v, i, a) => v % 100 === 0 && a.indexOf(v) === i);
      const i = yield* chooseOption(e, p, `Bark of Dark Ruler: pay how much LP? (${o.name})`, opts.map((v) => `${v} LP`), true);
      if (i === null || !payLp(e, p, opts[i])) return false;
      link.targetUid = o.uid;
      link.payload = opts[i];
    },
    *resolve(e, link) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m) return;
      const n = link.payload as number;
      m.atkMod -= n;
      m.defMod -= n;
      e.log(link.player, `${m.name} loses ${n} ATK and DEF`);
    },
  };

  // Monsters it destroys by battle (attacking or attacked) go back to the hand instead of staying in the GY.
  const rageTargets = (e: Engine, p: Pid) => targetable(e, faceUpOf(e, p).filter((m) => raceOf(e, m) === 'Warrior'));
  E['Battleguard Rage'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && rageTargets(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Battleguard Rage: which Warrior?', rageTargets(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    // spells-b: linked through tags.rageHost (not attached like an Equip), so that it is destroyed when that monster leaves the
    // field (an attached card was only sent to the GY with it).
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      const fc = e.fieldCard(link.card.uid);
      if (!fc) return;
      if (m?.faceUp && ctrl(e, m) === p && raceOf(e, m) === 'Warrior') tag(fc).rageHost = m.uid;
      else yield* e.sendToGrave(fc.uid, 'used');
    },
    aura: (e, src, target) => (src.tags?.rageHost === target.uid && target.faceUp ? { atk: 1000, def: 0 } : undefined),
    *stateCheck(e, card) {
      const host = card.tags?.rageHost;
      if (host === undefined || e.fieldCard(host)) return;
      delete tag(card).rageHost;
      e.log(ctrl(e, card), 'Battleguard Rage: its monster left the field, so it is destroyed');
      yield* e.destroy([card.uid]);
    },
    *afterAnyBattle(e, eq, _p, a, t) {
      const host = eq.tags?.rageHost;
      const foe = a.uid === host ? t : t.uid === host ? a : null;
      if (foe && !foe.token && where(e, foe.uid) === 'gy' && e.fieldCard(eq.uid)) yield* returnToHand(e, foe.uid);
    },
  };

  E['Bazoo the Soul-Eater'] = {
    selfBonus: (e, m) => ({ atk: (m.tags?.bazooUntil ?? -1) >= e.state.turn ? m.tags?.bazoo ?? 0 : 0, def: 0 }),
    ignition: {
      can: (e, _m, p) => e.player(p).gy.some((c) => isMonster(e, c)),
      *run(e, m, p) {
        const chosen = yield* pick(e, p, 'Bazoo the Soul-Eater: banish up to 3 monsters from your GY', e.player(p).gy.filter((c) => isMonster(e, c)), 1, 3);
        if (!chosen || !m.faceUp) return;
        for (const c of chosen) e.banish(c.uid);
        const t = tag(m);
        t.bazoo = ((t.bazooUntil ?? -1) >= e.state.turn ? t.bazoo ?? 0 : 0) + 300 * chosen.length;
        t.bazooUntil = e.state.turn + 1;
      },
    },
  };

  const beeInsects = (e: Engine, m: FieldCard, p: Pid) => faceUpOf(e, p).filter((x) => x.uid !== m.uid && raceOf(e, x) === 'Insect' && !e.isNamed(x, 'Bee List Soldier'));
  E['Bee List Soldier'] = {
    ignition: {
      repeat: true,
      can: (e, m, p) => beeInsects(e, m, p).length > 0,
      *run(e, m, p) {
        const ins = yield* pickOne(e, p, 'Bee List Soldier: Tribute which Insect?', beeInsects(e, m, p));
        if (!ins || !e.fieldCard(m.uid)) return;
        yield* e.sendToGrave(m.uid, 'tribute');
        yield* e.sendToGrave(ins.uid, 'tribute');
        e.draw(p, 2);
      },
    },
  };

  const beetronST = (e: Engine, p: Pid) => stOf(e, p).filter((c) => c.faceUp && !isMonster(e, c));
  const beetronGY = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => canSS(e, c) && info(e, c).race === 'Insect' && levelOf(e, c) <= 4);
  E['Beetron'] = {
    ignition: {
      can: (e, m, p) => e.oncePerTurn(m.name, p) && freeMZ(e, p) && beetronST(e, p).length > 0 && beetronGY(e, p).length > 0,
      *run(e, _m, p) {
        const st = yield* pickOne(e, p, 'Beetron: send which face-up Spell/Trap to the GY?', beetronST(e, p));
        if (!st) return;
        e.useOnce('Beetron', p);
        yield* e.sendToGrave(st.uid, 'cost');
        yield* summonOneOf(e, p, 'Beetron: Special Summon which Insect in Defense Position?', beetronGY(e, p), 'def');
      },
    },
  };

  // audit-00: the 1-Tribute Summon (original ATK 2000) was missing. Approximation: the engine cannot ask how many to Tribute, so it
  // takes 1 Tribute when you control fewer than 2 monsters you could Tribute, and 2 otherwise (and a Set always needs 2).
  E['Behemoth the King of All Animals'] = {
    tributeOffer: (e, src, p, _m, need) => (src === null && need === 2 && e.monsters(p).filter((m) => !e.untributable(m)).length < 2 ? { need: 1 } : undefined),
    baseStats: (e, m) => (m.tags?.behemoth1 ? { atk: 2000, def: info(e, m).def ?? 0 } : undefined),
    *onSummon(e, m, p, kind) {
      if (kind !== 'normal') return;
      const n = ((e.state.fx.tributedFor ?? {}) as Record<number, number>)[m.uid] ?? 2;
      if (n === 1) tag(m).behemoth1 = 1;
      const beasts = e.player(p).gy.filter((c) => isMonster(e, c) && info(e, c).race === 'Beast');
      if (!beasts.length || !(yield* e.yesno(p, 'Behemoth: return Beasts from your GY to your hand?'))) return;
      const chosen = yield* pick(e, p, `Return which ${n} Beast monster${n > 1 ? 's' : ''}?`, beasts, Math.min(n, beasts.length), n);
      for (const c of chosen ?? []) e.toHandOf(c.uid, p);
    },
  };

  E['Berfomet'] = {
    *onSummon(e, _m, p) {
      const ok = (c: Card) => e.isNamed(c, 'Gazelle the King of Mythical Beasts');
      if (!e.player(p).deck.some(ok) || !(yield* e.yesno(p, 'Berfomet: add Gazelle the King of Mythical Beasts?'))) return;
      yield* searchDeck(e, p, 'Add Gazelle', ok);
    },
  };
}
