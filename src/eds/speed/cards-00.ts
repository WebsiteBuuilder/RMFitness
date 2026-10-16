// Speed Duel card scripts, batch 00: worked examples of every kind of hook the
// Speed Duel scripts use. The other batches (cards-01.ts ...) follow these patterns.
import type { EffectDef } from '../effects';
import type { SpeedHelpers } from './helpers';
import {
  allST,
  anyTime,
  ctrl,
  deckToGrave,
  discardCost,
  faceUpMonsters,
  freeMZ,
  info,
  isMain,
  isMonster,
  negateLink,
  negateMonster,
  noBattleDamage,
  other,
  payLp,
  pick,
  pickOne,
  raceOf,
  searchDeck,
  summonOneOf,
  tag,
  targetable,
  toDeck,
} from './helpers';

export function install(E: Record<string, EffectDef>, _h: SpeedHelpers) {
  // Normal Spell with a target chosen at activation (activate) and applied at resolution (resolve).
  // spells-a: Tokens cannot be turned face-down; a monster turned face-down loses its Equip Cards and the changes made to it.
  const moonTargets = (e: Parameters<NonNullable<EffectDef['onSpecialSummon']>>[0]) => targetable(e, faceUpMonsters(e)).filter((m) => !m.token);
  E['Book of Moon'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && moonTargets(e).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Book of Moon: change which monster to face-down Defense Position?', moonTargets(e), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || !m.faceUp || m.token) return;
      for (const u of m.equips.slice()) if (e.fieldCard(u)) yield* e.sendToGrave(u, 'destroyed');
      m.faceUp = false;
      m.pos = 'def';
      m.atkMod = 0;
      m.defMod = 0;
      // How it was Summoned stays; effects applied to it while face-up (negation, lasting ATK changes...) end. A bind (Spellbinding Circle) stays.
      const keep = ['ss', 'ssAt', 'ssFrom', 'ssExtra', 'fusS', 'noFlip', 'boundBy'];
      m.tags = Object.fromEntries(Object.entries(m.tags ?? {}).filter(([k]) => keep.includes(k)));
      e.event('position', { uid: m.uid });
      e.log(link.player, `${m.name} is turned face-down`);
    },
  };

  E['Foolish Burial'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).deck.some((c) => isMonster(e, c)),
    *resolve(e, _l, p) {
      yield* deckToGrave(e, p, 'Foolish Burial: send which monster to the GY?', (c) => isMonster(e, c));
    },
  };

  E['Reinforcement of the Army'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).deck.some((c) => info(e, c).race === 'Warrior' && isMonster(e, c) && (info(e, c).level ?? 0) <= 4),
    *resolve(e, _l, p) {
      yield* searchDeck(e, p, 'Reinforcement of the Army: add which Warrior?', (c) => info(e, c).race === 'Warrior' && isMonster(e, c) && (info(e, c).level ?? 0) <= 4);
    },
  };

  // Continuous monster effects: an aura on other monsters, and a defender-side attack restriction.
  E['Command Knight'] = {
    aura: (e, src, target, srcController) => (target.faceUp && ctrl(e, target) === srcController && raceOf(e, target) === 'Warrior' ? { atk: 400, def: 0 } : undefined),
    cannotBeAttacked: (e, m) => e.monsters(ctrl(e, m)).some((x) => x.uid !== m.uid),
  };

  // Special Summon procedure from the hand ("you can Special Summon this card (from your hand)").
  E['Cyber Dragon'] = {
    summonProc: {
      can: (e, _c, p) => e.monsters(p).length === 0 && e.monsters(other(p)).length > 0 && freeMZ(e, p),
      *run(e, c, p) {
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
  };

  // "When this card is Summoned" covers Normal, Flip and Special Summons.
  const twinBarrel = function* (e: Parameters<NonNullable<EffectDef['onSpecialSummon']>>[0], p: 0 | 1) {
    const list = [...targetable(e, e.monsters(other(p))), ...allST(e).filter((c) => ctrl(e, c) === other(p))];
    const t = yield* pickOne(e, p, 'Twin-Barrel Dragon: target which card?', list);
    if (!t) return;
    const a = e.roll(2) === 1;
    const b = e.roll(2) === 1;
    e.log(p, `Coin tosses: ${a ? 'Heads' : 'Tails'}, ${b ? 'Heads' : 'Tails'}`);
    if (a && b && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
  };
  E['Twin-Barrel Dragon'] = {
    *onSummon(e, _m, p) {
      yield* twinBarrel(e, p);
    },
    *onSpecialSummon(e, _m, p) {
      yield* twinBarrel(e, p);
    },
  };

  // Trigger in the Graveyard after battle: onDestroyed (byBattle tells how it died).
  E['Mystic Tomato'] = {
    *onDestroyed(e, _card, p, byBattle) {
      if (!byBattle || !freeMZ(e, p)) return;
      const ok = (c: { name: string }) => isMonster(e, c as never) && info(e, c.name).attribute === 'DARK' && (info(e, c.name).atk ?? 0) <= 1500;
      if (!e.player(p).deck.some(ok) || !(yield* e.yesno(p, 'Mystic Tomato: Special Summon a DARK monster with 1500 or less ATK from the Deck?'))) return;
      yield* summonOneOf(e, p, 'Mystic Tomato: Special Summon which monster?', e.player(p).deck.filter(ok), 'atk');
    },
  };

  // A Trap that answers a monster effect activation (Speed Duel opens an 'effect' window for chained monster effects).
  E['Divine Wrath'] = {
    canActivate: (e, _c, p, t, ctx) => t === 'effect' && !!ctx.link && info(e, ctx.link.card).kind === 'monster' && e.player(p).hand.length > 0,
    *activate(e, link, p, ctx) {
      if (!(yield* discardCost(e, p, 1))) return false;
      link.payload = { target: ctx.link };
    },
    *resolve(e, link, p) {
      const target = (link.payload as { target?: typeof link }).target;
      if (!target) return;
      negateLink(e, target, p);
      if (e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
    },
  };

  // Negating a monster's effects, plus an ignition effect from the Graveyard.
  // spells-a: an Effect Monster: not a Normal Monster, a Token, or an Extra Deck/Ritual Monster with no effect (Flame Swordsman).
  const breakthroughTargets = (e: Parameters<NonNullable<EffectDef['onSpecialSummon']>>[0], p: 0 | 1) => targetable(e, faceUpMonsters(e, other(p))).filter((m) => !m.token && info(e, m).sub !== 'Normal' && !info(e, m).vanilla);
  E['Breakthrough Skill'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && breakthroughTargets(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Breakthrough Skill: negate which monster?', breakthroughTargets(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (m?.faceUp) negateMonster(e, m, true);
    },
    *onSentToGrave(e, card) {
      (card as { tags?: Record<string, number> }).tags = undefined;
      ((e.state.fx.btsSentTurn ??= {}) as Record<number, number>)[card.uid] = e.state.turn;
    },
    graveIgnition: {
      can: (e, card, p) => e.state.fx.btsSentTurn?.[card.uid] !== e.state.turn && breakthroughTargets(e, p).length > 0,
      *run(e, card, p) {
        const m = yield* pickOne(e, p, 'Breakthrough Skill: negate which monster?', breakthroughTargets(e, p), true);
        if (!m) return;
        e.banish(card.uid);
        negateMonster(e, m, true);
      },
    },
  };

  // A cost paid at activation (pay LP), then a target on the field.
  E['Cosmic Cyclone'] = {
    // audit-00: from the hand it is not on the field yet, so 1 other Spell/Trap is enough.
    canActivate: (e, c, p, t) => anyTime(t) && e.player(p).lp > 1000 && allST(e).some((x) => x.uid !== c.uid),
    *activate(e, link, p) {
      const list = allST(e).filter((c) => c.uid !== link.card.uid);
      const c = yield* pickOne(e, p, 'Cosmic Cyclone: banish which Spell/Trap?', list, true);
      if (!c || !payLp(e, p, 1000)) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link) {
      if (link.targetUid !== undefined && e.fieldCard(link.targetUid)) e.banish(link.targetUid);
    },
  };

  // "You can only activate 1 X per turn" uses e.oncePerTurn / e.useOnce with the card name.
  E['Jar of Avarice'] = {
    canActivate: (e, c, p, t) => anyTime(t) && e.oncePerTurn(c.name, p) && e.player(p).gy.filter((g) => !e.sameName(g, c)).length >= 5,
    *activate(e, link, p) {
      const chosen = yield* pick(e, p, 'Jar of Avarice: shuffle which 5 cards into the Deck?', e.player(p).gy.filter((g) => !e.sameName(g, link.card)), 5, 5, true);
      if (!chosen) return false;
      e.useOnce(link.card.name, p);
      link.payload = chosen.map((c) => c.uid);
    },
    *resolve(e, link, p) {
      const uids = link.payload as number[];
      if (uids.some((u) => e.find(u)?.loc.zone !== 'gy')) return;
      for (const u of uids) toDeck(e, u);
      e.draw(p, 1);
    },
  };

  // A Quick Effect from the hand with a discard cost, run at resolution.
  E['Arcana Force XIV - Temperance'] = {
    quick: {
      from: 'hand',
      label: 'discard it to take no battle damage',
      // audit-00: in either player's turn (any battle; offered when the attack is declared, before damage calculation).
      can: (e, _c, _p, t) => t === 'attack' && !!e.state.battle,
      *cost(e, card, p) {
        yield* e.discard(p, card.uid);
      },
      *run(e, _card, p) {
        noBattleDamage(e, p);
      },
    },
    // "When this card is Summoned: toss a coin": Heads, halve all battle damage you take; Tails, halve all battle damage your opponent takes.
    *onSummon(e, m) {
      m.tags = { ...(m.tags ?? {}), coin: e.roll(2) };
      e.log(null, `Temperance: ${m.tags.coin === 1 ? 'Heads' : 'Tails'}`);
    },
    *onSpecialSummon(e, m) {
      m.tags = { ...(m.tags ?? {}), coin: e.roll(2) };
      e.log(null, `Temperance: ${m.tags.coin === 1 ? 'Heads' : 'Tails'}`);
    },
    // audit-00: the coin halves battle damage (it used to stop all damage from its own battles).
    damageMod: (_e, src, ctl, damaged, amount, byEffect) => {
      if (byEffect || !src.tags?.coin) return undefined;
      return (src.tags.coin === 1 ? damaged === ctl : damaged === other(ctl)) ? Math.floor(amount / 2) : undefined;
    },
  };

  // An Equip Spell giving protection (shields) and a battle trigger (hostAfterBattle).
  E['Amazoness Heirloom'] = {
    ..._h.equipFor((e, m) => e.nameHas(m, 'Amazoness'), undefined),
    shields(e, src, target, how) {
      if (how !== 'battle' || src.equippedTo !== target.uid || tag(src).savedTurn === e.state.turn) return false;
      tag(src).savedTurn = e.state.turn;
      return true;
    },
    *hostAfterBattle(e, _equip, host, target) {
      if (target && e.fieldCard(target.uid) && e.controller(target.uid) !== e.controller(host.uid) && e.state.fx.battleNo) yield* e.destroy([target.uid]);
    },
  };
}
