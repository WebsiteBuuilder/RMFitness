// Speed Duel card scripts, batch 07 (Jinzo - Returner ... Mist Archfiend).
// Spell Counters are kept in FieldCard.counters on the card that holds them.
import type { EffectDef } from '../effects';
import type { SpeedHelpers } from './helpers';
import {
  allMonsters,
  allST,
  anyTime,
  attrOf,
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
  isTrap,
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
  summonOneOf,
  tag,
  targetable,
  toDeck,
  tributeCost,
} from './helpers';
import type { Card, ChainCtx, ChainLink, Engine, FieldCard, Pid, Step } from './helpers';

type Link = ChainLink;
const ctxOf = (link: Link) => ((link.payload as { ctx?: ChainCtx } | undefined)?.ctx ?? {}) as ChainCtx;
const inGy = (e: Engine, uid: number) => e.find(uid)?.loc.zone === 'gy';
const inHand = (e: Engine, uid: number) => e.find(uid)?.loc.zone === 'hand';
const known = (e: Engine, n: string) => e.db.has(n) || e.db.has(n.toLowerCase());
/** A monster that can be Special Summoned from the GY/Deck without a proper summon first. */
const revivable = (e: Engine, c: Card) => isMonster(e, c) && !isExtraOrRitual(e, c);
const gyMonsters = (e: Engine, p: Pid, test: (c: Card) => boolean) => e.player(p).gy.filter((c) => revivable(e, c) && test(c));
/** A card as it sits on the field (for cards scripts place without a summon). */
const onField = (e: Engine, c: Card, faceUp: boolean): FieldCard => ({ ...c, pos: 'atk', faceUp, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 });
/** Removes a card from the hand/Deck/GY array it is in (only those zones). */
function lift(e: Engine, uid: number): Card | null {
  const f = e.find(uid);
  if (!f || !['hand', 'deck', 'gy'].includes(f.loc.zone)) return null;
  const ps = e.player(f.loc.player);
  const arr = f.loc.zone === 'hand' ? ps.hand : f.loc.zone === 'deck' ? ps.deck : ps.gy;
  arr.splice(f.loc.index, 1);
  return { uid: f.card.uid, name: f.card.name, owner: f.card.owner };
}
function togglePos(e: Engine, m: FieldCard) {
  m.pos = m.pos === 'atk' ? 'def' : 'atk';
  e.event('position', { uid: m.uid });
  e.log(null, `${m.name} changes to ${m.pos === 'atk' ? 'Attack' : 'Defense'} Position`);
}
/** Remembers who was resolving an effect when a card left the field (to tell "destroyed by your opponent's card"). */
const leaveActor: EffectDef['onLeaveField'] = function* (e, fc) {
  ((e.state.fx.leftBy ??= {}) as Record<number, number>)[fc.uid] = e.actor ?? -1;
};
const byOpponent = (e: Engine, card: Card, controller: Pid, byBattle: boolean) => {
  if (byBattle) return true;
  const a = (e.state.fx.leftBy ?? {})[card.uid];
  return a !== undefined && a !== -1 && a !== controller;
};
/** Spell Counters a player has on face-up cards. */
const counterHolders = (e: Engine, p: Pid) => [...e.monsters(p).filter((m) => m.faceUp), ...e.activeSpells(p)].filter((c) => c.counters > 0);
const counterTotal = (e: Engine, p: Pid) => counterHolders(e, p).reduce((a, c) => a + c.counters, 0);
function removeCounters(e: Engine, p: Pid, n: number) {
  for (const c of counterHolders(e, p)) {
    const k = Math.min(c.counters, n);
    c.counters -= k;
    n -= k;
    if (!n) break;
  }
}
/** Fusion materials as listed names ("A" + "B" + "C"), or null for generic materials. */
function listedMats(e: Engine, name: string): string[] | null {
  const line = info(e, name).desc.split('\n')[0];
  const parts = line.split('+').map((s) => s.trim());
  if (parts.length < 2 || !parts.every((s) => /^"[^"]+"$/.test(s))) return null;
  return parts.map((s) => s.slice(1, -1));
}
function assign(slots: Card[][], used: number[] = []): number[] | null {
  if (!slots.length) return used;
  for (const c of slots[0]) {
    if (used.includes(c.uid)) continue;
    const r = assign(slots.slice(1), [...used, c.uid]);
    if (r) return r;
  }
  return null;
}
/** Destroys a battle opponent that ended up in a GY by banishing it (Lesser Fiend). */
const banishFromGy = (e: Engine, uid: number | undefined) => {
  if (uid !== undefined && inGy(e, uid)) e.banish(uid);
};
const opponentsMonsterLinks = (t: string) => t === 'spell' || t === 'trap' || t === 'effect';
// audit-07: monsters Summoned only by their own procedure ("cannot be Special Summoned by other ways" / "must first be").
const properSS = (e: Engine) => (e.state.fx.properSS ??= {}) as Record<number, number>;
/** Special Summons a card with its own procedure (its summonRule lets it through), and remembers it was properly Summoned. */
function* procSummon(e: Engine, uid: number, p: Pid, pos: 'atk' | 'def' = 'atk'): Step {
  e.state.fx.ignoreCond = uid;
  try {
    yield* e.specialSummon(uid, p, pos);
  } finally {
    e.state.fx.ignoreCond = undefined;
  }
  if (e.fieldCard(uid)) properSS(e)[uid] = 1;
}
/** summonRule: Special Summons only by the card's own procedure (`first`: or again once it was properly Summoned). */
const procOnly = (first = false): EffectDef['summonRule'] => (e, c, _p, how) => how !== 'special' || e.state.fx.ignoreCond === c.uid || e.state.fx.procCheck === c.uid || (first && !!properSS(e)[c.uid]);

export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  E['Jinzo - Returner'] = {
    directAttack: true,
    *onSentToGrave(e, _card, p) {
      const jinzo = e.player(p).gy.filter((c) => c.name === 'Jinzo');
      if (!jinzo.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Jinzo - Returner: Special Summon "Jinzo" from your GY?'))) return;
      const m = yield* summonOneOf(e, p, 'Special Summon which Jinzo?', jinzo);
      if (m) m.doomAt = e.state.turnPlayer === p ? e.state.turn : e.state.turn + 1;
    },
  };

  E["Jowls of Dark Demise"] = {
    *flip(e, _m, p) {
      const list = targetable(e, e.monsters(other(p)));
      if (!list.length || !freeMZ(e, p)) return;
      const t = yield* pickOne(e, p, 'Jowls of Dark Demise: take control of which monster?', list);
      if (t && e.takeControl(t.uid, p)) {
        t.returnAtEnd = other(p);
        tag(t).directTurn = e.state.turn; // it can attack directly this turn
        e.log(p, `${e.player(p).name} takes control of ${t.faceUp ? t.name : 'a face-down monster'} until the End Phase`);
      }
    },
  };

  const destroysST = (desc: string) => desc.split(/\.(?:\s|$)/).some((s) => /destroy/i.test(s) && /Spell|Trap/.test(s) && !/this card is destroyed/i.test(s));
  E['Judgment of Anubis'] = {
    canActivate: (e, c, p, t, ctx) => t === 'spell' && !!ctx.link && ctx.link.player !== p && isSpell(e, ctx.link.card) && destroysST(info(e, ctx.link.card).desc) && e.player(p).hand.some((x) => x.uid !== c.uid),
    *activate(e, link, p, ctx) {
      if (!(yield* discardCost(e, p, 1))) return false;
      link.payload = { target: ctx.link };
    },
    *resolve(e, link, p) {
      const target = (link.payload as { target?: Link }).target;
      if (!target) return;
      negateLink(e, target, p);
      if (e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
      const opp = faceUpMonsters(e, other(p));
      if (!opp.length || !(yield* e.yesno(p, 'Judgment of Anubis: destroy a face-up monster and inflict damage equal to its ATK?'))) return;
      const m = yield* pickOne(e, p, 'Destroy which monster?', opp);
      if (!m) return;
      const atk = e.atkOf(m);
      yield* e.destroy([m.uid]);
      if (!e.fieldCard(m.uid)) e.damage(other(p), atk);
    },
  };

  E['Junk Puppet'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p) && freeMZ(e, p) && gyMonsters(e, p, (x) => named(x, 'Gimmick Puppet')).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Junk Puppet: Special Summon which "Gimmick Puppet"?', gyMonsters(e, p, (x) => named(x, 'Gimmick Puppet')), true);
      if (!c) return false;
      e.useOnce(link.card.name, p);
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid !== undefined && inGy(e, link.targetUid)) yield* e.specialSummon(link.targetUid, p, 'atk');
    },
  };

  E['Jurassic World'] = h.fieldSpell((e, m) => (raceOf(e, m) === 'Dinosaur' ? { atk: 300, def: 300 } : undefined));

  E['Jurrac Herra'] = {
    // From the hand or the GY: it sees the destruction from either zone.
    *watchGrave(e, card, p, zone, events) {
      const hit = events.some((v) => v.byBattle && v.toGy && v.from === 'mz' && v.controller === p && v.pos === 'def' && v.card.uid !== card.uid && named(v.card, 'Jurrac') && v.card.name !== 'Jurrac Herra');
      if (!hit || !freeMZ(e, p) || e.find(card.uid)?.loc.zone !== zone) return;
      if (!(yield* e.yesno(p, `Jurrac Herra: Special Summon it from your ${zone === 'gy' ? 'GY' : 'hand'}?`))) return;
      yield* e.specialSummon(card.uid, p, 'atk');
    },
  };

  E['Jurrac Iguanon'] = {
    *afterBattle(e, _a, target, p, destroyed) {
      if (!destroyed) return;
      const set = [...e.monsters(other(p)), ...stOf(e, other(p))].filter((c) => !c.faceUp);
      if (!set.length || !(yield* e.yesno(p, 'Jurrac Iguanon: return a Set card to the hand?'))) return;
      const c = yield* pickOne(e, p, 'Return which Set card?', set);
      if (c && e.fieldCard(c.uid)) e.toHand(c.uid);
    },
  };

  E['Jurrac Protops'] = {
    selfBonus: (e, m) => ({ atk: 100 * e.monsters(other(ctrl(e, m))).length, def: 0 }),
  };

  E['Jurrac Spinos'] = {
    *afterBattle(e, _a, target, p, destroyed) {
      if (destroyed && inGy(e, target.uid)) e.createToken('Spinos Token', other(p), 'atk', true, { atk: 300, def: 0, level: 1, attribute: 'FIRE', race: 'Dinosaur' });
    },
  };

  E['Jurrac Stauriko'] = {
    *onDestroyed(e, _c, p, byBattle) {
      if (!byBattle) return;
      for (let i = 0; i < 2; i++) {
        const tk = e.createToken('Jurrac Token', p, 'def', true, { atk: 0, def: 0, level: 1, attribute: 'FIRE', race: 'Dinosaur' });
        if (tk) ((e.state.fx.tribFor ??= {}) as Record<number, string>)[tk.uid] = 'Jurrac'; // only Tributed for the Tribute Summon of a "Jurrac" monster
      }
    },
  };

  E['Jurrac Tyrannus'] = {
    ignition: {
      repeat: true,
      can: (e, m, p) => e.monsters(p).some((x) => x.uid !== m.uid && raceOf(e, x) === 'Dinosaur'),
      *run(e, m, p) {
        if (!(yield* tributeCost(e, p, 1, (x) => raceOf(e, x) === 'Dinosaur', m.uid))) return;
        if (e.fieldCard(m.uid)?.faceUp) boostPerm(m, 500);
      },
    },
    *afterBattle(e, m, target, _p, destroyed) {
      if (destroyed && inGy(e, target.uid)) boostPerm(m, 300);
    },
  };

  E['Justi-Break'] = {
    canActivate: (e, _c, p, t, ctx) => {
      if (opponentAttack(e, p, t, ctx) === null) return false;
      const tg = e.state.battle?.target;
      const m = tg !== null && tg !== undefined ? e.fieldCard(tg) : null;
      return !!m && m.faceUp && e.controller(m.uid) === p && !m.token && isNormalMonster(e, m);
    },
    *resolve(e) {
      const doomed = allMonsters(e).filter((m) => !(m.faceUp && m.pos === 'atk' && !m.token && isNormalMonster(e, m)));
      if (doomed.length) yield* e.destroy(doomed.map((m) => m.uid));
    },
  };

  E['Kaibaman'] = {
    ignition: {
      can: (e, _m, p) => e.player(p).hand.some((c) => c.name === 'Blue-Eyes White Dragon'),
      *run(e, m, p) {
        if (!e.fieldCard(m.uid) || !e.player(p).hand.some((c) => c.name === 'Blue-Eyes White Dragon')) return;
        e.log(p, `${e.player(p).name} Tributes Kaibaman`);
        yield* e.sendToGrave(m.uid, 'tribute');
        yield* summonOneOf(e, p, 'Special Summon which Blue-Eyes White Dragon?', e.player(p).hand.filter((c) => c.name === 'Blue-Eyes White Dragon'));
      },
    },
  };

  E['Kaiser Glider'] = {
    battleProof: (e, m) => {
      const b = e.state.battle;
      if (!b) return false;
      const o = b.attacker === m.uid ? (b.target !== null ? e.fieldCard(b.target) : null) : e.fieldCard(b.attacker);
      if (o) return e.atkOf(o) === e.atkOf(m);
      // The monster it attacked was already destroyed by the same battle: compare with the ATK noted at damage calculation.
      return b.attacker === m.uid && m.tags?.kgBattle === e.state.fx.battleNo && m.tags?.kgVs === e.atkOf(m);
    },
    attackBonus: (e, m, target) => {
      if (target) Object.assign(tag(m), { kgBattle: e.state.fx.battleNo, kgVs: e.atkOf(target) });
      return 0;
    },
    *onDestroyed(e, _c, p) {
      const m = yield* pickOne(e, p, 'Kaiser Glider: return which monster to the hand?', targetable(e, allMonsters(e)));
      if (m && e.fieldCard(m.uid)) e.toHand(m.uid);
    },
  };

  E['Kelbek'] = {
    *onAttacked(e, _t, attacker) {
      if (e.fieldCard(attacker.uid)) {
        e.log(null, `Kelbek returns ${attacker.name} to the hand`);
        e.toHand(attacker.uid);
      }
    },
  };

  E['Keldo'] = {
    *onDestroyed(e, _c, p, byBattle) {
      const gy = e.player(other(p)).gy;
      if (!byBattle || !gy.length) return;
      const n = Math.min(2, gy.length);
      const chosen = yield* pick(e, p, `Keldo: shuffle ${n} cards from your opponent's GY into their Deck`, gy, n, n);
      for (const c of chosen ?? []) if (inGy(e, c.uid)) toDeck(e, c.uid);
    },
  };

  const skulls = (c: Card) => c.name === 'Skull Servant' || c.name === 'King of the Skull Servants';
  E['King of the Skull Servants'] = {
    baseStats: (e, m) => ({ atk: 1000 * e.player(ctrl(e, m)).gy.filter(skulls).length, def: 0 }),
    *onDestroyed(e, card, p, byBattle) {
      const ps = e.player(p);
      const fuel = ps.gy.filter((c) => skulls(c) && c.uid !== card.uid);
      if (!byBattle || !fuel.length || !freeMZ(e, p) || !inGy(e, card.uid)) return;
      if (!(yield* e.yesno(p, 'King of the Skull Servants: banish a Skull Servant from your GY to Special Summon it?'))) return;
      const c = yield* pickOne(e, p, 'Banish which card?', fuel);
      if (!c) return;
      e.banish(c.uid);
      if (inGy(e, card.uid)) yield* e.specialSummon(card.uid, p, 'atk');
    },
  };

  E['King of the Swamp'] = {
    fusionSub: true,
    handIgnition: {
      can: (e, _c, p) => e.player(p).deck.some((c) => c.name === 'Polymerization'),
      *run(e, card, p) {
        yield* e.discard(p, card.uid);
        yield* searchDeck(e, p, 'Add Polymerization', (c) => c.name === 'Polymerization');
      },
    },
  };

  E["King's Knight"] = {
    *onSummon(e, _m, p, kind) {
      if (kind !== 'normal' || !e.monsters(p).some((m) => m.faceUp && m.name === "Queen's Knight") || !freeMZ(e, p)) return;
      const jacks = e.player(p).deck.filter((c) => c.name === "Jack's Knight");
      if (!jacks.length || !(yield* e.yesno(p, "King's Knight: Special Summon Jack's Knight from your Deck?"))) return;
      yield* summonOneOf(e, p, "Special Summon Jack's Knight", jacks);
    },
  };

  E['Kycoo the Ghost Destroyer'] = {
    // Your opponent cannot banish cards from either GY.
    locksGrave: (e, _src, ctl, card) => e.state.fx.banishing === card.uid && e.actor === other(ctl),
    *onBattleDamage(e, _m, p) {
      const gy = e.player(other(p)).gy.filter((c) => isMonster(e, c));
      if (!gy.length || !(yield* e.yesno(p, 'Kycoo: banish up to 2 monsters from your opponent\'s GY?'))) return;
      const chosen = yield* pick(e, p, 'Banish up to 2 monsters', gy, 1, 2, true);
      for (const c of chosen ?? []) if (inGy(e, c.uid)) e.banish(c.uid);
    },
  };

  E['Labyrinth of Nightmare'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    *onEndPhase(e) {
      for (const m of e.monsters(e.state.turnPlayer).filter((x) => x.faceUp)) togglePos(e, m);
    },
  };

  E['Lady Assailant of Flames'] = {
    *flip(e, _m, p) {
      const deck = e.player(p).deck;
      if (deck.length < 3) return;
      for (const c of deck.slice(0, 3)) e.banish(c.uid);
      e.damage(other(p), 800);
    },
  };

  const nobleNormal = (e: Engine, c: Card) => named(c, 'Noble Knight') && isNormalMonster(e, c);
  E['Lady of the Lake'] = {
    *onSummon(e, _m, p, kind) {
      const list = gyMonsters(e, p, (c) => nobleNormal(e, c));
      if (kind !== 'normal' || !list.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Lady of the Lake: Special Summon a "Noble Knight" Normal Monster from your GY?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which monster?', list);
    },
    graveIgnition: {
      can: (e, _c, p) => freeMZ(e, p) && targetable(e, e.monsters(p).filter((m) => m.faceUp && named(m, 'Noble Knight') && levelOf(e, m) === 5)).length > 0,
      *run(e, card, p) {
        const list = e.monsters(p).filter((m) => m.faceUp && named(m, 'Noble Knight') && levelOf(e, m) === 5);
        const m = yield* pickOne(e, p, 'Lady of the Lake: reduce which monster\'s Level by 1?', targetable(e, list), true);
        if (!m) return;
        tag(m).lvMod = (m.tags?.lvMod ?? 0) - 1;
        if (inGy(e, card.uid) && levelOf(e, m) === 4) yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
    // Used for a Synchro Summon: banish it (the Warrior-only material restriction is not modelled).
    *onSentToGrave(e, card, _owner, from, reason) {
      if (reason === 'material' && from === 'mz' && inGy(e, card.uid)) e.banish(card.uid);
    },
  };

  E['Lava Golem'] = {
    cannotNormalSummon: true,
    summonRule: procOnly(true),
    summonProc: {
      can: (e, _c, p) => !e.player(p).normalSummoned && e.monsters(other(p)).length >= 2,
      *run(e, card, p) {
        const chosen = yield* pick(e, p, "Lava Golem: Tribute 2 of your opponent's monsters", e.monsters(other(p)), 2, 2, true);
        if (!chosen) return;
        for (const m of chosen) yield* e.sendToGrave(m.uid, 'tribute');
        e.player(p).normalSummoned = true;
        if (inHand(e, card.uid)) yield* procSummon(e, card.uid, other(p));
      },
    },
    *onStandby(e, _m, p) {
      if (e.state.turnPlayer === p) e.damage(p, 1000);
    },
  };

  E['Ledger of Legerdemain'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p) && e.player(p).deck.length >= 3,
    *activate(e, link, p) {
      e.useOnce(link.card.name, p);
    },
    *resolve(e, link, p) {
      const top = e.player(p).deck.slice(0, 3);
      const lf = (e.state.fx.lightforce ??= []) as { uid: number; back: number }[];
      for (const c of top) {
        e.banish(c.uid);
        lf.push({ uid: c.uid, back: e.state.turn + 6 });
      }
    },
  };

  E['Legendary Fiend'] = {
    *onStandby(e, m, p) {
      if (e.state.turnPlayer === p) boostPerm(m, 700);
    },
  };

  E['Legendary Jujitsu Master'] = {
    *onAttacked(e, t, attacker) {
      if (t.pos === 'def' && e.fieldCard(attacker.uid)) {
        e.log(null, `${attacker.name} is placed on top of the Deck`);
        e.toDeckTop(attacker.uid);
      }
    },
  };

  E['Lekunga'] = {
    ignition: {
      repeat: true,
      can: (e, _m, p) => freeMZ(e, p) && e.player(p).gy.filter((c) => isMonster(e, c) && attrOf(e, c) === 'WATER').length >= 2,
      *run(e, _m, p) {
        const chosen = yield* pick(e, p, 'Lekunga: banish 2 WATER monsters from your GY', e.player(p).gy.filter((c) => isMonster(e, c) && attrOf(e, c) === 'WATER'), 2, 2, true);
        if (!chosen || chosen.length < 2) return;
        for (const c of chosen) e.banish(c.uid);
        e.createToken('Lekunga Token', p, 'atk', true, { atk: 700, def: 700, level: 2, attribute: 'WATER', race: 'Plant' });
      },
    },
  };

  E['Lesser Fiend'] = {
    *afterBattle(e, _m, target, _p, destroyed) {
      if (destroyed) banishFromGy(e, target.uid);
    },
    *onAttacked(e, _t, attacker) {
      banishFromGy(e, attacker.uid);
    },
    *onDestroyedByBattle(e, m) {
      const b = e.state.battle;
      if (b && b.attacker === m.uid) banishFromGy(e, b.target ?? undefined);
    },
  };

  const lvTargets = (e: Engine, m: Card) => [...info(e, m).desc.matchAll(/"([^"]+)"/g)].map((x) => x[1]).filter((n) => n !== m.name && known(e, n) && info(e, n).kind === 'monster');
  const lvReady = (e: Engine, p: Pid) => e.monsters(p).filter((m) => m.faceUp && named(m, 'LV') && [...e.player(p).hand, ...e.player(p).deck].some((c) => lvTargets(e, m).includes(c.name)));
  E['Level Up!'] = {
    canActivate: (e, _c, p, t) => isMain(t) && lvReady(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Level Up!: send which "LV" monster to the GY?', lvReady(e, p), true);
      if (!m) return false;
      link.payload = lvTargets(e, m);
      yield* e.sendToGrave(m.uid, 'cost');
    },
    *resolve(e, link, p) {
      const names = link.payload as string[];
      const list = [...e.player(p).hand, ...e.player(p).deck].filter((c) => names.includes(c.name));
      const c = freeMZ(e, p) ? yield* pickOne(e, p, 'Level Up!: Special Summon which monster?', list) : null;
      if (!c) return;
      const fromDeck = e.find(c.uid)?.loc.zone === 'deck';
      e.state.fx.ignoreCond = c.uid; // ignoring its Summoning conditions
      try {
        yield* e.specialSummon(c.uid, p, 'atk');
      } finally {
        e.state.fx.ignoreCond = undefined;
      }
      if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
    },
  };

  const isUmi = (c: FieldCard | null | undefined) => !!c && c.faceUp && (c.name === 'Umi' || c.name === 'A Legendary Ocean');
  E['Levia-Dragon - Daedalus'] = {
    ignition: {
      repeat: true,
      can: (e, _m, p) => isUmi(e.player(p).field),
      *run(e, m, p) {
        const umi = e.player(p).field;
        if (!umi || !isUmi(umi)) return;
        yield* e.sendToGrave(umi.uid, 'cost');
        const all = [...allMonsters(e), ...allST(e)].filter((c) => c.uid !== m.uid).map((c) => c.uid);
        yield* e.destroy(all);
      },
    },
  };

  E['Lightning Blade'] = {
    ...h.equipFor((e, m) => raceOf(e, m) === 'Warrior', () => ({ atk: 800, def: 0 })),
    aura: (e, src, target) => (src.equippedTo !== undefined && target.faceUp && attrOf(e, target) === 'WATER' ? { atk: -500, def: 0 } : undefined),
  };

  const allWarriors = (e: Engine, p: Pid) => e.monsters(p).filter((m) => m.faceUp).every((m) => raceOf(e, m) === 'Warrior');
  E['Lightray Gearfried'] = {
    cannotNormalSummon: true,
    summonRule: procOnly(),
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && new Set(e.player(p).gy.filter((c) => isMonster(e, c) && attrOf(e, c) === 'LIGHT').map((c) => c.name)).size >= 5,
      *run(e, card, p) {
        yield* procSummon(e, card.uid, p);
      },
    },
    quick: {
      label: 'negate the activation',
      can: (e, _c, p, t, ctx) => (t === 'spell' || t === 'trap') && !!ctx.link && !ctx.link.negated && (isSpell(e, ctx.link.card) || isTrap(e, ctx.link.card)) && allWarriors(e, p) && e.player(p).gy.some((c) => isMonster(e, c) && info(e, c).race === 'Warrior'),
      *cost(e, _c, p) {
        const c = yield* pickOne(e, p, 'Banish which Warrior from your GY?', e.player(p).gy.filter((x) => isMonster(e, x) && info(e, x).race === 'Warrior'), true);
        if (!c) return false;
        e.banish(c.uid);
      },
      *run(e, _c, p, link) {
        const target = ctxOf(link).link;
        if (!target || !allWarriors(e, p)) return;
        negateLink(e, target, p);
        if (e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
      },
    },
  };

  const banishedLight = (e: Engine, p: Pid) => e.player(p).removed.filter((c) => isMonster(e, c) && attrOf(e, c) === 'LIGHT');
  E['Lightray Sorcerer'] = {
    cannotNormalSummon: true,
    summonRule: procOnly(),
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && banishedLight(e, p).length >= 3,
      *run(e, card, p) {
        yield* procSummon(e, card.uid, p);
      },
    },
    ignition: {
      can: (e, _m, p) => banishedLight(e, p).length > 0 && targetable(e, faceUpMonsters(e)).length > 0,
      *run(e, m, p) {
        const a = yield* pickOne(e, p, 'Lightray Sorcerer: shuffle which banished LIGHT monster into the Deck?', banishedLight(e, p));
        const b = yield* pickOne(e, p, 'Banish which face-up monster?', targetable(e, faceUpMonsters(e)));
        tag(m).noAttackTurn = e.state.turn;
        if (!a || !b || e.find(a.uid)?.loc.zone !== 'removed') return;
        toDeck(e, a.uid);
        if (e.fieldCard(b.uid)?.faceUp) e.banish(b.uid);
      },
    },
  };

  const soulToken = { atk: 0, def: 0, level: 1, attribute: 'DARK', race: 'Fiend' };
  E['Limit Impulse'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.player(p).hand.length >= 2 && e.player(p).mz.filter((z) => z === null).length >= 2,
    *activate(e, _l, p) {
      const chosen = yield* pick(e, p, 'Limit Impulse: send 2 cards from your hand to the GY', e.player(p).hand, 2, 2, true);
      if (!chosen) return false;
      for (const c of chosen) yield* e.sendToGrave(c.uid, 'cost');
    },
    *resolve(e, _l, p) {
      if (e.player(p).mz.filter((z) => z === null).length < 2) return;
      for (let i = 0; i < 2; i++) {
        const tk = e.createToken('Soul Token', p, 'def', true, soulToken);
        if (tk) tag(tk).summonTribOnly = 1; // cannot be Tributed except for a Tribute Summon
      }
    },
  };

  const reverseTargets = (e: Engine, p: Pid) => gyMonsters(e, p, (c) => (info(e, c).atk ?? 0) <= 1000);
  const hostOf = (e: Engine, c: FieldCard) => (c.equippedTo !== undefined ? e.fieldCard(c.equippedTo) : null);
  const reverseCheck = function* (e: Engine, c: FieldCard): Step {
    const m = hostOf(e, c);
    if (m && m.pos === 'def') {
      e.log(null, `${m.name} is in Defense Position: Limit Reverse destroys it`);
      yield* e.destroy([m.uid, c.uid]);
    }
  };
  E['Limit Reverse'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && freeMZ(e, p) && reverseTargets(e, p).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Limit Reverse: Special Summon which monster?', reverseTargets(e, p), true);
      if (!c) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      const card = e.fieldCard(link.card.uid);
      if (link.targetUid !== undefined && inGy(e, link.targetUid) && freeMZ(e, p)) yield* e.specialSummon(link.targetUid, p, 'atk');
      if (card && link.targetUid !== undefined && e.fieldCard(link.targetUid)) h.attachTo(e, card, link.targetUid);
      else if (card) yield* e.sendToGrave(card.uid, 'used');
    },
    *onLeaveField(e, fc) {
      const m = hostOf(e, fc);
      if (m) yield* e.destroy([m.uid]);
    },
    stateCheck: (e, c) => reverseCheck(e, c),
  };

  E['Little-Winguard'] = {
    *onEndPhase(e, m, p) {
      if (e.state.turnPlayer === p && (yield* e.yesno(p, 'Little-Winguard: change its battle position?')) && e.fieldCard(m.uid)) togglePos(e, m);
    },
  };

  const fossilTargets = (e: Engine, p: Pid) => gyMonsters(e, p, (c) => levelOf(e, c) <= 4);
  E['Living Fossil'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p) && freeMZ(e, p) && fossilTargets(e, p).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Living Fossil: Special Summon which monster?', fossilTargets(e, p), true);
      if (!c) return false;
      e.useOnce(link.card.name, p);
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid === undefined || !inGy(e, link.targetUid)) return;
      yield* e.specialSummon(link.targetUid, p, 'atk');
      const m = e.fieldCard(link.targetUid);
      const card = e.fieldCard(link.card.uid);
      if (!m || !card) return;
      h.attachTo(e, card, m.uid);
      negateMonster(e, m, false);
    },
    equipBonus: () => ({ atk: -1000, def: -1000 }),
    *onLeaveField(e, fc) {
      // The monster is banished when it leaves the field (or when this card does).
      const uid = fc.equippedTo;
      if (uid !== undefined && (e.fieldCard(uid) || inGy(e, uid))) e.banish(uid);
    },
  };

  E['Lord Poison'] = {
    *onDestroyed(e, card, p, byBattle) {
      const list = gyMonsters(e, p, (c) => info(e, c).race === 'Plant' && c.name !== 'Lord Poison');
      if (!byBattle || !list.length || !freeMZ(e, p) || !inGy(e, card.uid)) return;
      yield* summonOneOf(e, p, 'Lord Poison: Special Summon which Plant?', list);
    },
  };

  E['Lost Blue Breaker'] = {
    ignition: {
      repeat: true,
      can: (e, m) => allST(e).length > 0 && faceUpMonsters(e).some((x) => x.uid !== m.uid && ['Fish', 'Sea Serpent', 'Aqua'].includes(raceOf(e, x))),
      *run(e, m, p) {
        if (!e.fieldCard(m.uid) || !allST(e).length) return;
        e.log(p, `${e.player(p).name} Tributes Lost Blue Breaker`);
        yield* e.sendToGrave(m.uid, 'tribute');
        const c = yield* pickOne(e, p, 'Lost Blue Breaker: destroy which Spell/Trap?', allST(e));
        if (c) yield* e.destroy([c.uid]);
      },
    },
  };

  const gyAttr = (e: Engine, p: Pid, a: string) => e.player(p).gy.filter((c) => isMonster(e, c) && attrOf(e, c) === a);
  const cloudFire = (e: Engine, p: Pid) => e.oncePerTurn('Loud Cloud 1', p) && gyAttr(e, p, 'FIRE').length > 0 && targetable(e, e.monsters(other(p))).length > 0;
  const cloudWind = (e: Engine, p: Pid) => e.oncePerTurn('Loud Cloud 2', p) && gyAttr(e, p, 'WIND').length > 0 && e.spells(other(p)).length > 0;
  E['Loud Cloud the Storm Serpent'] = {
    cannotNormalSummon: true,
    summonRule: procOnly(true),
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && gyAttr(e, p, 'FIRE').length > 0 && gyAttr(e, p, 'WIND').length > 0,
      *run(e, card, p) {
        const f = yield* pickOne(e, p, 'Banish which FIRE monster?', gyAttr(e, p, 'FIRE'), true);
        if (!f) return;
        const w = yield* pickOne(e, p, 'Banish which WIND monster?', gyAttr(e, p, 'WIND'), true);
        if (!w) return;
        e.banish(f.uid);
        e.banish(w.uid);
        yield* procSummon(e, card.uid, p);
      },
    },
    ignition: {
      repeat: true,
      can: (e, _m, p) => cloudFire(e, p) || cloudWind(e, p),
      *run(e, m, p) {
        const opts: string[] = [];
        if (cloudFire(e, p)) opts.push('Banish a FIRE monster: destroy a monster');
        if (cloudWind(e, p)) opts.push('Banish a WIND monster: destroy a Spell/Trap');
        const i = yield* chooseOption(e, p, 'Loud Cloud: use which effect?', opts, true);
        if (i === null) return;
        if (opts[i].includes('FIRE')) {
          const c = yield* pickOne(e, p, 'Banish which FIRE monster?', gyAttr(e, p, 'FIRE'), true);
          if (!c) return;
          e.useOnce('Loud Cloud 1', p);
          e.banish(c.uid);
          const t = yield* pickOne(e, p, 'Destroy which monster?', targetable(e, e.monsters(other(p))));
          if (!t) return;
          const gain = info(e, t).atk ?? 0;
          yield* e.destroy([t.uid]);
          if (!e.fieldCard(t.uid) && e.fieldCard(m.uid)?.faceUp) boostPerm(m, gain);
        } else {
          const c = yield* pickOne(e, p, 'Banish which WIND monster?', gyAttr(e, p, 'WIND'), true);
          if (!c) return;
          e.useOnce('Loud Cloud 2', p);
          e.banish(c.uid);
          const t = yield* pickOne(e, p, 'Destroy which card?', e.spells(other(p)));
          if (t) yield* e.destroy([t.uid]);
        }
      },
    },
  };

  // "Sent to the GY by a card effect": destroyed by an effect, discarded, milled, sent as a cost or as material.
  const foxTrigger = function* (e: Engine, card: Card, p: Pid): Step {
    if (!inGy(e, card.uid)) return;
    const list = targetable(e, faceUpMonsters(e, other(p)));
    if (!list.length || !(yield* e.yesno(p, "Lunalight Crimson Fox: change an opponent's monster's ATK to 0?"))) return;
    const m = yield* pickOne(e, p, 'Which monster?', list);
    if (m && e.fieldCard(m.uid)?.faceUp) boostTurn(m, -e.atkOf(m));
  };
  E['Lunalight Crimson Fox'] = {
    *onDestroyed(e, card, p, byBattle) {
      if (!byBattle) yield* foxTrigger(e, card, card.owner);
    },
    *onDiscarded(e, card, owner) {
      if (e.actor !== null) yield* foxTrigger(e, card, owner); // not the hand-size discard
    },
    *onSentToGrave(e, card, owner, _from, reason) {
      if (reason === 'mill' || reason === 'cost' || reason === 'used' || reason === 'material') yield* foxTrigger(e, card, owner);
    },
    quick: {
      from: 'gy',
      repeat: true,
      label: 'banish it to negate the activation',
      can: (e, _c, p, t, ctx) => {
        if (!opponentsMonsterLinks(t) || !ctx.link || ctx.link.negated || ctx.link.targetUid === undefined) return false;
        const m = e.fieldCard(ctx.link.targetUid);
        return !!m && m.faceUp && e.controller(m.uid) === p && named(m, 'Lunalight');
      },
      *cost(e, card) {
        e.banish(card.uid);
      },
      *run(e, _c, p, link) {
        const target = ctxOf(link).link;
        if (!target) return;
        negateLink(e, target, p);
        e.gainLp(p, 1000);
        e.gainLp(other(p), 1000);
      },
    },
  };

  E['Lunalight Panther Dancer'] = {
    // Must first be Fusion Summoned.
    summonRule: (e, c, _p, how, from) => how !== 'special' || from === 'fusion' || !!properSS(e)[c.uid],
    *onSpecialSummon(e, m) {
      if (m.tags?.fusS) properSS(e)[m.uid] = 1;
    },
    effectProof: (e, m) => e.actor !== null && e.actor !== e.controller(m.uid),
    ignition: {
      can: (e, m) => m.tags?.pdTurn !== e.state.turn,
      *run(e, m) {
        if (!e.fieldCard(m.uid)) return;
        tag(m).pdTurn = e.state.turn;
        e.log(null, 'Lunalight Panther Dancer can attack every opponent monster twice this turn');
      },
    },
    shields(e, src, target, how, srcController) {
      if (how !== 'battle' || src.tags?.pdTurn !== e.state.turn || e.controller(target.uid) === srcController || tag(target).pdSaved === e.state.turn) return false;
      tag(target).pdSaved = e.state.turn;
      return true;
    },
    attacks: (e, m) => {
      if (m.tags?.pdTurn !== e.state.turn) return 1;
      const left = e.monsters(other(ctrl(e, m))).some((t) => (m.tags?.[`hit${t.uid}`] ?? 0) < 2);
      return (m.tags?.attacksMade ?? 0) + (left ? 1 : 0);
    },
    targetFilter: (e, m, t) => m.tags?.pdTurn !== e.state.turn || (m.tags?.[`hit${t.uid}`] ?? 0) < 2,
    *afterBattle(e, m, target, _p, destroyed) {
      if (m.tags?.pdTurn === e.state.turn) tag(m)[`hit${target.uid}`] = (m.tags?.[`hit${target.uid}`] ?? 0) + 1;
      if (destroyed && !e.fieldCard(target.uid)) boostTurn(m, 200); // until the end of the turn (no Main Phase 2: about the end of the Battle Phase)
    },
  };

  // ----- Union monsters (equip to a Machine / unequip and Special Summon) -----
  const unionHosts = (e: Engine, m: FieldCard, p: Pid) => targetable(e, e.monsters(p).filter((x) => x.uid !== m.uid && x.faceUp && raceOf(e, x) === 'Machine'));
  const union = (extra: Partial<EffectDef>): EffectDef => ({
    ignition: {
      repeat: true,
      can: (e, m, p) => {
        if (!e.oncePerTurn(`union:${m.uid}`, p)) return false;
        const zone = e.find(m.uid)?.loc.zone;
        if (zone === 'mz') return freeST(e, p) >= 0 && unionHosts(e, m, p).length > 0;
        return zone === 'sz' && m.equippedTo !== undefined && freeMZ(e, p);
      },
      *run(e, m, p) {
        const f = e.find(m.uid);
        if (!f || f.loc.player !== p) return;
        if (f.loc.zone === 'mz') {
          const host = yield* pickOne(e, p, `${m.name}: equip to which Machine monster?`, unionHosts(e, m, p), true);
          const z = freeST(e, p);
          if (!host || z < 0 || e.find(m.uid)?.loc.zone !== 'mz') return;
          e.useOnce(`union:${m.uid}`, p);
          for (const u of m.equips.slice()) yield* e.sendToGrave(u, 'used');
          const at = e.find(m.uid)!.loc;
          e.vacateMZ(e.player(p), at.index);
          Object.assign(m, { pos: 'atk', faceUp: true, active: true, equips: [], equippedTo: host.uid, atkMod: 0, defMod: 0, tags: {} });
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
    shields(e, src, target, how) {
      if (how === 'target' || src.equippedTo !== target.uid || e.find(src.uid)?.loc.zone !== 'sz') return false;
      // Destroy this card instead (it has no prompts when destroyed as a substitute).
      (e.state.fx.unionSub ??= {})[src.uid] = e.state.turn;
      e.log(null, `${src.name} is destroyed instead of ${target.name}`);
      const g = e.sendToGrave(src.uid, 'destroyed');
      for (let r = g.next(); !r.done; r = g.next(false)) {
        /* drained */
      }
      return true;
    },
    ...extra,
  });
  E['Machina Gearframe'] = union({
    *onSummon(e, _m, p, kind) {
      const ok = (c: Card) => isMonster(e, c) && named(c, 'Machina') && c.name !== 'Machina Gearframe';
      if (kind !== 'normal' || !e.player(p).deck.some(ok) || !(yield* e.yesno(p, 'Machina Gearframe: add a "Machina" monster from your Deck?'))) return;
      yield* searchDeck(e, p, 'Add which "Machina" monster?', ok);
    },
  });
  const isUnion = (e: Engine, c: Card) => isMonster(e, c) && /Unequip this card/i.test(info(e, c).desc);
  E['Machina Peacekeeper'] = union({
    *onDestroyed(e, card, p) {
      if ((e.state.fx.unionSub ?? {})[card.uid] === e.state.turn) return;
      if (!e.player(p).deck.some((c) => isUnion(e, c)) || !(yield* e.yesno(p, 'Machina Peacekeeper: add a Union monster from your Deck?'))) return;
      yield* searchDeck(e, p, 'Add which Union monster?', (c) => isUnion(e, c));
    },
  });

  // Ritual Spell for any Ritual Monster passing `test` (Tributes from hand or field, total Level >= its Level).
  const ritualFor = (test: (c: Card) => boolean): EffectDef => {
    const pool = (e: Engine, p: Pid, except: number[]) => [...e.player(p).hand.filter((c) => isMonster(e, c) && !except.includes(c.uid)), ...e.monsters(p)];
    const ready = (e: Engine, p: Pid, self: number) =>
      e.player(p).hand.filter((c) => c.uid !== self && test(c) && info(e, c).sub === 'Ritual').filter((r) => {
        const cands = pool(e, p, [r.uid, self]);
        return cands.reduce((a, x) => a + levelOf(e, x), 0) >= levelOf(e, r) && (freeMZ(e, p) || cands.some((x) => 'pos' in x));
      });
    return {
      canActivate: (e, c, p, t) => isMain(t) && ready(e, p, c.uid).length > 0,
      *activate(e, link, p) {
        const r = yield* pickOne(e, p, 'Ritual Summon which monster?', ready(e, p, link.card.uid), true);
        if (!r) return false;
        const cands = pool(e, p, [r.uid, link.card.uid]);
        for (let tries = 0; tries < 3; tries++) {
          const chosen = yield* pick(e, p, `Tribute monsters with total Level ${levelOf(e, r)} or more`, cands, 1, cands.length, true, false);
          if (!chosen) return false;
          if (chosen.reduce((a, x) => a + levelOf(e, x), 0) >= levelOf(e, r)) {
            link.payload = { monster: r.uid, tributes: chosen.map((x) => x.uid) };
            return;
          }
        }
        return false;
      },
      *resolve(e, link, p) {
        const { monster, tributes } = link.payload as { monster: number; tributes: number[] };
        if (!inHand(e, monster) || tributes.some((u) => !e.find(u))) return;
        for (const u of tributes) yield* e.sendToGrave(u, 'tribute');
        if (freeMZ(e, p)) yield* e.specialSummon(monster, p, 'atk');
      },
    };
  };
  E['Machine Angel Ritual'] = {
    ...ritualFor((c) => named(c, 'Cyber Angel')),
    // From the GY: banished instead of a LIGHT monster you control being destroyed (always used: the "you can" is not asked).
    graveReplace: (e, _card, _owner, m) => attrOf(e, m) === 'LIGHT',
  };

  E['Mad Reloader'] = {
    *onDestroyed(e, _c, p, byBattle) {
      const hand = e.player(p).hand;
      if (!byBattle || hand.length < 2) return;
      const chosen = yield* pick(e, p, 'Mad Reloader: send 2 cards from your hand to the GY', hand, 2, 2);
      if (!chosen || chosen.length < 2) return;
      for (const c of chosen) yield* e.sendToGrave(c.uid, 'cost');
      e.draw(p, 2);
    },
  };

  E['Mad Sword Beast'] = { piercing: true };

  E['Madolche Magileine'] = {
    *onSummon(e, _m, p) {
      const ok = (c: Card) => isMonster(e, c) && named(c, 'Madolche');
      if (!e.player(p).deck.some(ok) || !(yield* e.yesno(p, 'Madolche Magileine: add a "Madolche" monster from your Deck?'))) return;
      yield* searchDeck(e, p, 'Add which "Madolche" monster?', ok);
    },
    onLeaveField: leaveActor,
    *onDestroyed(e, card, p, byBattle) {
      if (card.owner === p && byOpponent(e, card, p, byBattle) && inGy(e, card.uid)) {
        e.log(p, 'Madolche Magileine returns to the Deck');
        toDeck(e, card.uid);
      }
    },
  };

  E['Mage Power'] = h.equip((e, eq) => {
    const n = stOf(e, ctrl(e, eq)).length;
    return { atk: 500 * n, def: 500 * n };
  });

  E['Magic Drain'] = {
    canActivate: (_e, _c, p, t, ctx) => t === 'spell' && !!ctx.link && ctx.link.player !== p,
    *activate(_e, link, _p, ctx) {
      link.payload = { target: ctx.link };
    },
    *resolve(e, link, p) {
      const target = (link.payload as { target?: Link }).target;
      if (!target) return;
      const opp = other(p);
      const spells = e.player(opp).hand.filter((c) => isSpell(e, c));
      if (spells.length && (yield* e.yesno(opp, 'Magic Drain: discard a Spell to negate its effect?'))) {
        const c = yield* pickOne(e, opp, 'Discard which Spell?', spells);
        if (c) {
          yield* e.discard(opp, c.uid);
          e.log(opp, "Magic Drain's effect is negated");
          return;
        }
      }
      negateLink(e, target, p);
      if (e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
    },
  };

  E['Magic Formula'] = {
    ...h.equipFor((_e, m) => m.name === 'Dark Magician' || m.name === 'Dark Magician Girl', () => ({ atk: 700, def: 0 })),
    *onSentToGrave(e, _c, owner, from) {
      if (from === 'sz') e.gainLp(owner, 1000);
    },
  };

  E['Magical Plant Mandragola'] = {
    *flip(e, m) {
      for (const c of [...faceUpMonsters(e), ...e.activeSpells(0), ...e.activeSpells(1)]) {
        if (c.uid !== m.uid && /Spell Counter/.test(info(e, c).desc)) {
          c.counters += 1;
          e.log(null, `A Spell Counter is placed on ${c.name}`);
        }
      }
    },
  };

  E['Magical Stone Excavation'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.player(p).hand.filter((x) => x.uid !== c.uid).length >= 2 && e.player(p).gy.some((x) => isSpell(e, x)),
    *activate(e, link, p) {
      if (!(yield* discardCost(e, p, 2))) return false;
      const c = yield* pickOne(e, p, 'Magical Stone Excavation: add which Spell?', e.player(p).gy.filter((x) => isSpell(e, x)));
      if (!c) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid !== undefined && inGy(e, link.targetUid)) e.toHandOf(link.targetUid, p);
    },
  };

  E['Magical Undertaker'] = {
    *flip(e, _m, p) {
      const list = gyMonsters(e, p, (c) => info(e, c).race === 'Spellcaster' && levelOf(e, c) <= 4);
      if (!list.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Magical Undertaker: Special Summon a Spellcaster from your GY?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which Spellcaster?', list);
    },
  };

  E["Magician's Circle"] = {
    canActivate: (e, _c, _p, t, ctx) => t === 'attack' && !!e.state.battle && ctx.uid !== undefined && !!e.fieldCard(ctx.uid) && raceOf(e, e.fieldCard(ctx.uid)!) === 'Spellcaster',
    *resolve(e, _l, p) {
      for (const q of [p, other(p)]) {
        const list = e.player(q).deck.filter((c) => revivable(e, c) && info(e, c).race === 'Spellcaster' && (info(e, c).atk ?? 0) <= 2000);
        yield* summonOneOf(e, q, "Magician's Circle: Special Summon which Spellcaster?", list);
      }
    },
  };

  const atkCasters = (e: Engine, p: Pid) => e.monsters(p).filter((m) => m.faceUp && m.pos === 'atk' && raceOf(e, m) === 'Spellcaster');
  E['Magicians Unite'] = {
    canActivate: (e, _c, p, t) => isMain(t) && atkCasters(e, p).length >= 2,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Magicians Unite: which Spellcaster becomes 3000 ATK?', targetable(e, atkCasters(e, p)), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (m?.faceUp) boostTurn(m, 3000 - e.atkOf(m));
      for (const x of e.monsters(p)) if (x.uid !== link.targetUid && raceOf(e, x) === 'Spellcaster') tag(x).noAttackTurn = e.state.turn;
    },
  };

  const dmOrGirl = (c: Card) => c.name === 'Dark Magician' || c.name === 'Dark Magician Girl';
  E['Magikuriboh'] = {
    quick: {
      from: 'hand',
      label: 'send it to the GY to Special Summon Dark Magician (Girl)',
      can: (e, _c, p) => ((e.state.fx.dmgByOpp ?? []) as number[])[p] === e.state.turn && (e.state.phase === 'M1' || e.state.phase === 'BP') && freeMZ(e, p) && [...e.player(p).deck, ...e.player(p).gy].some(dmOrGirl),
      *cost(e, card) {
        yield* e.sendToGrave(card.uid, 'cost');
      },
      *run(e, _c, p) {
        yield* summonOneOf(e, p, 'Magikuriboh: Special Summon which monster?', [...e.player(p).deck, ...e.player(p).gy].filter(dmOrGirl));
      },
    },
    // A face-up Spellcaster you control destroyed by battle or an opponent's card effect: add this card from the GY to the hand.
    *watchGrave(e, card, p, zone, events) {
      if (zone !== 'gy' || events.some((v) => v.card.uid === card.uid) || !e.oncePerTurn('Magikuriboh 2', p)) return;
      if (!events.some((v) => v.from === 'mz' && v.faceUp && v.controller === p && v.reason === 'destroyed' && v.race === 'Spellcaster' && (v.byBattle || v.by === other(p)))) return;
      if (!(yield* e.yesno(p, 'Magikuriboh: add it from your GY to your hand?'))) return;
      e.useOnce('Magikuriboh 2', p);
      if (inGy(e, card.uid)) e.toHandOf(card.uid, p);
    },
  };

  const magnetLow = (e: Engine, c: Card) => isMonster(e, c) && named(c, 'Magnet Warrior') && levelOf(e, c) <= 4;
  const conversionCan = (e: Engine, card: Card, p: Pid) => (e.state.fx.magConvTurn ?? {})[card.uid] !== e.state.turn && freeMZ(e, p) && e.player(p).removed.some((c) => magnetLow(e, c));
  const conversionRun = function* (e: Engine, card: Card, p: Pid, cost: boolean): Step {
    if (cost) e.banish(card.uid);
    yield* summonOneOf(e, p, 'Magnet Conversion: Special Summon which banished "Magnet Warrior"?', e.player(p).removed.filter((c) => magnetLow(e, c)));
  };
  E['Magnet Conversion'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.player(p).gy.some((c) => magnetLow(e, c)),
    *activate(e, link, p) {
      const chosen = yield* pick(e, p, 'Magnet Conversion: add up to 3 "Magnet Warrior" monsters', e.player(p).gy.filter((c) => magnetLow(e, c)), 1, 3, true);
      if (!chosen) return false;
      link.payload = chosen.map((c) => c.uid);
    },
    *resolve(e, link, p) {
      for (const u of link.payload as number[]) if (inGy(e, u)) e.toHandOf(u, p);
    },
    *onSentToGrave(e, card) {
      ((e.state.fx.magConvTurn ??= {}) as Record<number, number>)[card.uid] = e.state.turn;
    },
    graveIgnition: {
      can: (e, card, p) => conversionCan(e, card, p),
      *run(e, card, p) {
        yield* conversionRun(e, card, p, true);
      },
    },
    quick: {
      from: 'gy',
      repeat: true,
      label: 'banish it to Special Summon a "Magnet Warrior"',
      can: (e, card, p, t) => anyTime(t) && conversionCan(e, card, p),
      *cost(e, card) {
        e.banish(card.uid);
      },
      *run(e, card, p) {
        yield* conversionRun(e, card, p, false);
      },
    },
  };

  E['Magnetic Field'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    ignition: {
      can: (e, _m, p) =>
        e.oncePerTurn('Magnetic Field', p) && freeMZ(e, p) && e.monsters(p).some((m) => m.faceUp && attrOf(e, m) === 'EARTH' && raceOf(e, m) === 'Rock' && levelOf(e, m) <= 4) && gyMonsters(e, p, (c) => magnetLow(e, c)).length > 0,
      *run(e, _m, p) {
        e.useOnce('Magnetic Field', p);
        yield* summonOneOf(e, p, 'Magnetic Field: Special Summon which "Magnet Warrior"?', gyMonsters(e, p, (c) => magnetLow(e, c)));
      },
    },
    *afterAnyBattle(e, _card, p, attacker, target) {
      const rock = (m: FieldCard) => attrOf(e, m) === 'EARTH' && raceOf(e, m) === 'Rock';
      const [mine, theirs] = e.controller(attacker.uid) === p ? [attacker, target] : [target, attacker];
      if (!mine || !theirs || e.controller(mine.uid) !== p || !rock(mine) || e.controller(theirs.uid) !== other(p)) return;
      if (!e.oncePerTurn('Magnetic Field 2', p) || !(yield* e.yesno(p, `Magnetic Field: return ${theirs.faceUp ? theirs.name : 'a face-down monster'} to the hand?`))) return;
      e.useOnce('Magnetic Field 2', p);
      if (e.fieldCard(theirs.uid)) e.toHand(theirs.uid);
    },
  };

  E['Magnetic Mosquito'] = {
    *flip(e) {
      const list = faceUpMonsters(e).filter((m) => raceOf(e, m) === 'Machine');
      if (list.length) yield* e.destroy(list.map((m) => m.uid));
    },
  };

  E['Maiden of Macabre'] = {
    selfBonus: (_e, m) => ({ atk: 200 * m.counters, def: 0 }),
    *afterBattle(_e, m, _t, _p, destroyed) {
      if (destroyed) m.counters += 1;
    },
    *onAttacked(e, m, attacker) {
      if (e.fieldCard(m.uid) && e.find(attacker.uid)?.loc.zone === 'gy') m.counters += 1;
    },
  };

  E['Malevolent Catastrophe'] = {
    canActivate: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null,
    *resolve(e, link) {
      const list = allST(e).filter((c) => c.uid !== link.card.uid);
      yield* e.destroy(list.map((c) => c.uid));
    },
  };

  const contTraps = (e: Engine) => allST(e).filter((c) => c.faceUp && isTrap(e, c) && info(e, c).sub === 'Continuous');
  E['Malice Dispersion'] = {
    canActivate: (e, c, p, t) => anyTime(t) && contTraps(e).length > 0 && e.player(p).hand.some((x) => x.uid !== c.uid),
    *activate(e, _l, p) {
      if (!(yield* discardCost(e, p, 1))) return false;
    },
    *resolve(e) {
      yield* e.destroy(contTraps(e).map((c) => c.uid));
    },
  };

  E['Maryokutai'] = {
    quick: {
      label: 'Tribute it to negate the Spell',
      can: (e, _c, p, t, ctx) => t === 'spell' && e.state.turnPlayer === other(p) && !!ctx.link && ctx.link.player === other(p) && !ctx.link.negated && isSpell(e, ctx.link.card),
      *cost(e, card, p) {
        e.log(p, `${e.player(p).name} Tributes Maryokutai`);
        yield* e.sendToGrave(card.uid, 'tribute');
      },
      *run(e, _c, p, link) {
        const target = ctxOf(link).link;
        if (!target) return;
        negateLink(e, target, p);
        if (e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
      },
    },
  };

  const maskHeroes = (e: Engine, p: Pid, m: FieldCard) => e.player(p).fusion.filter((c) => named(c, 'Masked HERO') && attrOf(e, c) === attrOf(e, m) && levelOf(e, c) > levelOf(e, m));
  const maskBases = (e: Engine, p: Pid) => targetable(e, e.monsters(p).filter((m) => m.faceUp && levelOf(e, m) > 0 && maskHeroes(e, p, m).length > 0));
  E['Mask Change II'] = {
    canActivate: (e, c, p, t) => anyTime(t) && e.oncePerTurn(c.name, p) && maskBases(e, p).length > 0 && e.player(p).hand.some((x) => x.uid !== c.uid),
    *activate(e, link, p) {
      if (!(yield* discardCost(e, p, 1))) return false;
      const m = yield* pickOne(e, p, 'Mask Change II: send which monster to the GY?', maskBases(e, p));
      if (!m) return false;
      e.useOnce(link.card.name, p);
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m || e.controller(m.uid) !== p) return;
      const heroes = maskHeroes(e, p, m);
      yield* e.sendToGrave(m.uid, 'cost');
      if (e.fieldCard(m.uid)) return;
      const hero = freeMZ(e, p) ? yield* pickOne(e, p, 'Special Summon which "Masked HERO"?', heroes.filter((c) => e.find(c.uid)?.loc.zone === 'fusion')) : null;
      if (!hero) return;
      e.state.fx.ignoreCond = hero.uid; // treated as a Special Summon with "Mask Change"
      try {
        yield* e.specialSummon(hero.uid, p, 'atk');
      } finally {
        e.state.fx.ignoreCond = undefined;
      }
    },
  };

  E['Mask of Brutality'] = {
    ...h.equip(() => ({ atk: 1000, def: -1000 })),
    *onStandby(e, c, p) {
      if (e.state.turnPlayer !== p || !e.fieldCard(c.uid)) return;
      if (e.player(p).lp > 1000 && (yield* e.yesno(p, 'Mask of Brutality: pay 1000 LP to keep it?'))) e.payLp(p, 1000);
      else yield* e.destroy([c.uid]);
    },
  };

  E['Mask of Weakness'] = {
    canActivate: (e, _c, _p, t) => t === 'attack' && !!e.state.battle && !!e.fieldCard(e.state.battle.attacker) && !e.untargetable(e.fieldCard(e.state.battle.attacker)!),
    *activate(e, link) {
      link.targetUid = e.state.battle?.attacker;
    },
    *resolve(e, link) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (m?.faceUp) boostTurn(m, -700);
    },
  };

  E['Mask of the Accursed'] = {
    ...h.equip(undefined),
    hostCannotAttack: () => true,
    *onStandby(e, c, p) {
      const host = c.equippedTo !== undefined ? e.fieldCard(c.equippedTo) : null;
      const owner = host ? e.controller(host.uid) : null;
      if (e.state.turnPlayer === p && owner !== null) e.damage(owner, 500);
    },
  };

  const gardiusKey = (m: FieldCard) => m.name === 'Grand Tiki Elder' || m.name === 'Melchid the Four-Face Beast';
  E['Masked Beast Des Gardius'] = {
    cannotNormalSummon: true,
    summonRule: procOnly(),
    summonProc: {
      can: (e, _c, p) => e.monsters(p).length >= 2 && e.monsters(p).some((m) => m.faceUp && gardiusKey(m)),
      *run(e, card, p) {
        const first = yield* pickOne(e, p, 'Tribute which Grand Tiki Elder / Melchid?', e.monsters(p).filter((m) => m.faceUp && gardiusKey(m)), true);
        if (!first) return;
        const second = yield* pickOne(e, p, 'Tribute which other monster?', e.monsters(p).filter((m) => m.uid !== first.uid), true);
        if (!second) return;
        for (const m of [first, second]) yield* e.sendToGrave(m.uid, 'tribute');
        if (inHand(e, card.uid)) yield* procSummon(e, card.uid, p);
      },
    },
    *onSentToGrave(e, _card, p, from) {
      const mask = e.player(p).deck.find((c) => c.name === 'The Mask of Remnants');
      const list = allMonsters(e).filter((m) => m.faceUp);
      if (from !== 'mz' || !mask || !list.length || freeST(e, p) < 0) return;
      const host = yield* pickOne(e, p, 'Des Gardius: equip The Mask of Remnants to which monster?', list);
      const z = freeST(e, p);
      if (!host || z < 0 || !e.fieldCard(host.uid)) return;
      const c = lift(e, mask.uid);
      if (!c) return;
      const fc = onField(e, c, true);
      fc.active = true;
      e.player(p).sz[z] = fc;
      h.attachTo(e, fc, host.uid);
      e.player(p).deck = e.shuffle(e.player(p).deck);
      e.log(p, `The Mask of Remnants is equipped to ${host.name}`);
      if (e.controller(host.uid) !== p && e.takeControl(host.uid, p)) e.log(p, `${e.player(p).name} takes control of ${host.name}`);
    },
  };

  E['Masked HERO Acid'] = {
    // Must be Special Summoned with "Mask Change" (Mask Change II sets ignoreCond).
    summonRule: (e, c, _p, how) => how !== 'special' || e.state.fx.ignoreCond === c.uid,
    *onSpecialSummon(e, _m, p) {
      const st = stOf(e, other(p));
      if (!st.length) return;
      yield* e.destroy(st.map((c) => c.uid));
      if (!st.some((c) => !e.fieldCard(c.uid))) return; // "and if you do"
      for (const m of e.monsters(other(p))) if (m.faceUp) boostPerm(m, -300);
    },
  };

  E['Master Craftsman Gamil'] = {
    quick: {
      from: 'hand',
      repeat: true,
      label: 'send it to the GY: your battling monster gains 300 ATK',
      can: (e, _c, p, t) => {
        if (t !== 'attack' || !e.state.battle) return false;
        const b = e.state.battle;
        return [b.attacker, b.target].some((u) => u !== null && e.fieldCard(u)?.faceUp && e.controller(u) === p);
      },
      *cost(e, card) {
        yield* e.sendToGrave(card.uid, 'cost');
      },
      *run(e, _c, p) {
        const b = e.state.battle;
        if (!b) return;
        for (const u of [b.attacker, b.target]) {
          const m = u !== null ? e.fieldCard(u) : null;
          if (m?.faceUp && e.controller(m.uid) === p) return boostTurn(m, 300);
        }
      },
    },
  };

  const slayer = (c: Card) => named(c, 'Dracoslayer');
  const overlord = (c: Card) => named(c, 'Dracoverlord');
  E['Master Peace, the True Dracoslayer'] = {
    cannotNormalSummon: true,
    summonRule: procOnly(),
    summonProc: {
      can: (e, _c, p) => e.monsters(p).some(slayer) && e.monsters(p).some(overlord),
      *run(e, card, p) {
        const a = yield* pickOne(e, p, 'Tribute which "Dracoslayer"?', e.monsters(p).filter(slayer), true);
        if (!a) return;
        const b = yield* pickOne(e, p, 'Tribute which "Dracoverlord"?', e.monsters(p).filter((m) => overlord(m) && m.uid !== a.uid), true);
        if (!b) return;
        for (const m of [a, b]) yield* e.sendToGrave(m.uid, 'tribute');
        if (inHand(e, card.uid)) yield* procSummon(e, card.uid, p);
      },
    },
    quick: {
      label: 'negate the activation',
      can: (_e, c, _p, t, ctx) => opponentsMonsterLinks(t) && !!ctx.link && !ctx.link.negated && ctx.link.card.uid !== c.uid,
      *run(e, _c, p, link) {
        const target = ctxOf(link).link;
        if (!target) return;
        negateLink(e, target, p);
        if (e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
      },
    },
    onLeaveField: leaveActor,
    *onDestroyed(e, card, p, byBattle) {
      if (card.owner !== p || !byOpponent(e, card, p, byBattle) || e.player(p).mz.filter((z) => z === null).length < 2) return;
      const deck = e.player(p).deck;
      if (!deck.some((c) => isMonster(e, c) && slayer(c)) || !deck.some((c) => isMonster(e, c) && overlord(c))) return;
      if (!(yield* e.yesno(p, 'Master Peace: Special Summon a "Dracoslayer" and a "Dracoverlord" from your Deck?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which "Dracoslayer"?', e.player(p).deck.filter((c) => isMonster(e, c) && slayer(c)));
      yield* summonOneOf(e, p, 'Special Summon which "Dracoverlord"?', e.player(p).deck.filter((c) => isMonster(e, c) && overlord(c)));
    },
  };

  E['Medusa Worm'] = {
    ignition: {
      can: (_e, m) => m.faceUp,
      *run(e, m) {
        if (!e.fieldCard(m.uid)?.faceUp) return;
        m.faceUp = false;
        m.pos = 'def';
        e.event('position', { uid: m.uid });
        e.log(null, 'Medusa Worm is turned face-down');
      },
    },
    *onSummon(e, _m, p, kind) {
      if (kind !== 'flip') return;
      const m = yield* pickOne(e, p, 'Medusa Worm: destroy which monster?', e.monsters(other(p)));
      if (m) yield* e.destroy([m.uid]);
    },
  };

  E['Mefist the Infernal General'] = {
    piercing: true,
    *onBattleDamage(e, _m, p) {
      const hand = e.player(other(p)).hand;
      if (!hand.length) return;
      const c = hand[Math.floor(e.rand() * hand.length)];
      yield* e.discard(other(p), c.uid);
    },
  };

  E['Mega Ton Magical Cannon'] = {
    canActivate: (e, _c, p, t) => isMain(t) && counterTotal(e, p) >= 10,
    *activate(e, _l, p) {
      if (counterTotal(e, p) < 10) return false;
      removeCounters(e, p, 10);
    },
    *resolve(e, _l, p) {
      yield* e.destroy([...e.monsters(other(p)), ...stOf(e, other(p))].map((c) => c.uid));
    },
  };

  E['Megarock Dragon'] = {
    cannotNormalSummon: true,
    summonRule: procOnly(),
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && e.player(p).gy.some((c) => isMonster(e, c) && info(e, c).race === 'Rock'),
      *run(e, card, p) {
        const rocks = e.player(p).gy.filter((c) => isMonster(e, c) && info(e, c).race === 'Rock');
        const chosen = yield* pick(e, p, 'Megarock Dragon: banish how many Rock monsters?', rocks, 1, rocks.length, true);
        if (!chosen) return;
        for (const c of chosen) e.banish(c.uid);
        ((e.state.fx.megarock ??= {}) as Record<number, number>)[card.uid] = chosen.length;
        yield* procSummon(e, card.uid, p);
      },
    },
    baseStats: (e, m) => {
      const n = (e.state.fx.megarock ?? {})[m.uid] ?? 0;
      return { atk: 700 * n, def: 700 * n };
    },
  };

  const contST = (e: Engine) => allST(e).filter((c) => c.faceUp && info(e, c).sub === 'Continuous');
  E['Mei-Kou, Master of Barriers'] = {
    ignition: {
      repeat: true,
      can: (e) => contST(e).length > 0,
      *run(e, m, p) {
        if (!e.fieldCard(m.uid) || !contST(e).length) return;
        e.log(p, `${e.player(p).name} Tributes Mei-Kou`);
        yield* e.sendToGrave(m.uid, 'tribute');
        const c = yield* pickOne(e, p, 'Mei-Kou: destroy which Continuous Spell/Trap?', contST(e));
        if (c) yield* e.destroy([c.uid]);
      },
    },
  };

  const meklords = (e: Engine, m: FieldCard) => faceUpMonsters(e).filter((x) => x.uid !== m.uid && named(x, 'Meklord')).length;
  E['Meklord Army of Granel'] = {
    selfBonus: (e, m) => ({ atk: 100 * meklords(e, m), def: 0 }),
    *onSummon(e, _m, p, kind) {
      const list = targetable(e, faceUpMonsters(e, other(p)));
      if (kind !== 'normal' || !list.length || !(yield* e.yesno(p, "Meklord Army of Granel: halve an opponent's monster's ATK?"))) return;
      const t = yield* pickOne(e, p, 'Which monster?', list);
      if (t && e.fieldCard(t.uid)?.faceUp) boostTurn(t, -Math.floor(e.atkOf(t) / 2));
    },
  };
  E['Meklord Army of Skiel'] = {
    selfBonus: (e, m) => ({ atk: 200 * meklords(e, m), def: 0 }),
    *onDestroyed(e, _c, p, byBattle) {
      const list = e.player(p).deck.filter((c) => isMonster(e, c) && named(c, 'Meklord Army'));
      if (!byBattle || !list.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Meklord Army of Skiel: Special Summon a "Meklord Army" from your Deck?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which monster?', list);
    },
  };

  E['Memory Loss'] = {
    canActivate: (e, _c, p, t, ctx) => {
      if (t !== 'effect' || !ctx.link || ctx.link.negated || !isMonster(e, ctx.link.card)) return false;
      const m = e.fieldCard(ctx.link.card.uid);
      return !!m && m.faceUp && m.pos === 'atk' && e.controller(m.uid) === other(p);
    },
    *activate(_e, link, _p, ctx) {
      link.payload = { target: ctx.link };
    },
    *resolve(e, link, p) {
      const target = (link.payload as { target?: Link }).target;
      if (!target) return;
      negateLink(e, target, p);
      const m = e.fieldCard(target.card.uid);
      if (m?.faceUp && m.pos === 'atk') togglePos(e, m);
    },
  };

  E['Mermail Abyssgunde'] = {
    *onDiscarded(e, card, owner) {
      const list = gyMonsters(e, owner, (c) => named(c, 'Mermail') && c.name !== 'Mermail Abyssgunde');
      if (!list.length || !freeMZ(e, owner) || !e.oncePerTurn(card.name, owner) || !(yield* e.yesno(owner, 'Mermail Abyssgunde: Special Summon a "Mermail" from your GY?'))) return;
      e.useOnce(card.name, owner);
      yield* summonOneOf(e, owner, 'Special Summon which "Mermail"?', list);
    },
  };

  const waterInHand = (e: Engine, p: Pid, self: number) => e.player(p).hand.filter((c) => c.uid !== self && isMonster(e, c) && attrOf(e, c) === 'WATER');
  E['Mermail Abyssteus'] = {
    handIgnition: {
      can: (e, c, p) => e.oncePerTurn(c.name, p) && freeMZ(e, p) && waterInHand(e, p, c.uid).length > 0,
      *run(e, card, p) {
        const w = yield* pickOne(e, p, 'Mermail Abyssteus: discard which WATER monster?', waterInHand(e, p, card.uid), true);
        if (!w) return;
        e.useOnce(card.name, p);
        yield* e.discard(p, w.uid);
        if (!inHand(e, card.uid)) return;
        yield* e.specialSummon(card.uid, p, 'atk');
        const ok = (c: Card) => isMonster(e, c) && named(c, 'Mermail') && levelOf(e, c) <= 4;
        if (!e.fieldCard(card.uid) || !e.player(p).deck.some(ok) || !(yield* e.yesno(p, 'Mermail Abyssteus: add a Level 4 or lower "Mermail" from your Deck?'))) return;
        yield* searchDeck(e, p, 'Add which "Mermail"?', ok);
      },
    },
  };

  E['Metal Reflect Slime'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && freeMZ(e, p),
    *resolve(e, link, p) {
      if (!e.fieldCard(link.card.uid) || !freeMZ(e, p)) return;
      (e.state.fx.declLevel ??= {})[link.card.uid] = 10;
      (e.state.fx.declRace ??= {})[link.card.uid] = 'Aqua';
      (e.state.fx.declAttr ??= {})[link.card.uid] = 'WATER';
      yield* e.specialSummon(link.card.uid, p, 'def');
    },
    baseStats: () => ({ atk: 0, def: 3000 }),
    cannotAttack: () => true,
  };

  E['Metalfoes Counter'] = {
    // Battle destruction opens a window; after an effect destroyed your monster, it can be activated at the next chance this turn (approximation).
    canActivate: (e, _c, p, t, ctx) =>
      ((t === 'destroyed' && ctx.prevController === p) || (anyTime(t) && ((e.state.fx.destroyedLog ?? []) as { controller: Pid; turn: number }[]).some((x) => x.controller === p && x.turn === e.state.turn))) &&
      freeMZ(e, p) &&
      e.player(p).deck.some((c) => isMonster(e, c) && named(c, 'Metalfoes')),
    *resolve(e, _l, p) {
      yield* summonOneOf(e, p, 'Metalfoes Counter: Special Summon which "Metalfoes"?', e.player(p).deck.filter((c) => isMonster(e, c) && named(c, 'Metalfoes')));
    },
  };

  E['Metamorformation'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    aura: (e, _src, target, p) => (target.faceUp && e.controller(target.uid) === p && named(target, 'Metalfoes') ? { atk: 300, def: 300 } : undefined),
  };

  E['Metaverse'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.player(p).deck.some((c) => isSpell(e, c) && info(e, c).sub === 'Field'),
    *resolve(e, _l, p) {
      const list = e.player(p).deck.filter((c) => isSpell(e, c) && info(e, c).sub === 'Field');
      const c = yield* pickOne(e, p, 'Metaverse: take which Field Spell?', list);
      if (!c) return;
      const how = yield* chooseOption(e, p, `Metaverse: ${c.name}`, ['Activate it', 'Add it to your hand']);
      if (how !== 0) {
        e.toHandOf(c.uid, p);
        e.player(p).deck = e.shuffle(e.player(p).deck);
        return;
      }
      const old = e.player(p).field;
      if (old) yield* e.sendToGrave(old.uid, 'destroyed');
      const card = lift(e, c.uid);
      if (!card || e.player(p).field) return;
      const fc = onField(e, card, true);
      e.player(p).field = fc;
      e.player(p).deck = e.shuffle(e.player(p).deck);
      e.event('activate', { uid: fc.uid, player: p });
      e.log(p, `${e.player(p).name} activates ${fc.name}`);
      const eff = e.effectOn(fc);
      if (eff?.resolve) yield* eff.resolve(e, { card: fc, loc: e.find(fc.uid)!.loc, player: p, label: fc.name, negated: false }, p);
      if (e.player(p).field?.uid === fc.uid) fc.active = true;
    },
  };

  // Pendulum Zones do not exist, so its monster effect never applies.
  E['Metrognome'] = {};

  E['Michizure'] = {
    // After a battle it responds at once; after a monster left your field another way, at the next chance this turn (approximation).
    canActivate: (e, _c, p, t, ctx) =>
      ((t === 'destroyed' && ctx.uid !== undefined && inGy(e, ctx.uid) && e.find(ctx.uid)?.loc.player === p) || (anyTime(t) && ((e.state.fx.lostMonster ?? []) as number[])[p] === e.state.turn)) &&
      targetable(e, allMonsters(e)).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Michizure: destroy which monster?', targetable(e, allMonsters(e)), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      if (link.targetUid !== undefined && e.fieldCard(link.targetUid)) yield* e.destroy([link.targetUid]);
    },
  };

  const mikanko = (e: Engine, p: Pid) => gyMonsters(e, p, (c) => named(c, 'Mikanko'));
  E['Mikanko Dance - Mayowashidori'] = {
    ...h.equip(undefined),
    shields: (_e, src, target, how) => how === 'effect' && src.equippedTo === target.uid,
    *afterAnyBattle(e, _eq, p, attacker, target) {
      const host = [attacker, target].find((m) => m && named(m, 'Mikanko') && (e.controller(m.uid) ?? m.owner) === p); // any "Mikanko" monster of yours that battled
      const list = [...allMonsters(e), ...allST(e)];
      if (!host || !e.oncePerTurn('Mayowashidori 1', p) || !list.length || !(yield* e.yesno(p, 'Mikanko Dance: return a card on the field to the hand?'))) return;
      e.useOnce('Mayowashidori 1', p);
      const c = yield* pickOne(e, p, 'Return which card?', list);
      if (c && e.fieldCard(c.uid)) e.toHand(c.uid);
    },
    graveIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Mayowashidori 2', p) && freeMZ(e, p) && freeST(e, p) >= 0 && mikanko(e, p).length > 0,
      *run(e, card, p) {
        const m = yield* pickOne(e, p, 'Special Summon which "Mikanko"?', mikanko(e, p), true);
        if (!m) return;
        e.useOnce('Mayowashidori 2', p);
        yield* e.specialSummon(m.uid, p, 'atk');
        const host = e.fieldCard(m.uid);
        const z = freeST(e, p);
        if (!host || z < 0 || !inGy(e, card.uid)) return;
        const c = lift(e, card.uid)!;
        const fc = onField(e, c, true);
        fc.active = true;
        e.player(p).sz[z] = fc;
        h.attachTo(e, fc, host.uid);
        fc.tags = { revived: 1 };
      },
    },
    *onLeaveField(e, fc) {
      // A monster it revived is banished when it leaves the field.
      const uid = fc.equippedTo;
      if (fc.tags?.revived && uid !== undefined && inGy(e, uid)) e.banish(uid);
    },
  };

  const mimicatReady = (e: Engine, p: Pid) => !!e.anyActive('Toon World', p) && e.monsters(p).some((m) => m.faceUp && named(m, 'Toon'));
  const mimicatTargets = (e: Engine, p: Pid) =>
    e.player(other(p)).gy.filter((c) => (isMonster(e, c) ? revivable(e, c) && freeMZ(e, p) : info(e, c).sub === 'Field' ? !e.player(p).field : freeST(e, p) >= 0));
  E['Mimicat'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p) && mimicatReady(e, p) && mimicatTargets(e, p).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, "Mimicat: target which card in your opponent's GY?", mimicatTargets(e, p), true);
      if (!c) return false;
      e.useOnce(link.card.name, p);
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      const uid = link.targetUid;
      if (uid === undefined || !inGy(e, uid)) return;
      const c = e.find(uid)!.card;
      if (isMonster(e, c)) {
        if (freeMZ(e, p)) yield* e.specialSummon(uid, p, 'atk');
        return;
      }
      const field = info(e, c).sub === 'Field';
      const z = freeST(e, p);
      if (field ? !!e.player(p).field : z < 0) return;
      const card = lift(e, uid)!;
      const fc = onField(e, card, false);
      if (field) e.player(p).field = fc;
      else e.player(p).sz[z] = fc;
      e.event('set', { uid, player: p });
      e.log(p, `${e.player(p).name} Sets ${card.name}`);
    },
  };

  E['Mind Crush'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *activate(e, link, p) {
      const names = [...new Set(([0, 1] as Pid[]).flatMap((q) => [...e.player(q).deck, ...e.player(q).hand, ...e.player(q).gy]).map((c) => c.name))].sort();
      const i = yield* chooseOption(e, p, 'Mind Crush: declare a card name', names, true);
      if (i === null) return false;
      link.payload = names[i];
    },
    *resolve(e, link, p) {
      const name = link.payload as string;
      e.log(p, `Mind Crush declares ${name}`);
      const hits = e.player(other(p)).hand.filter((c) => c.name === name);
      if (hits.length) {
        for (const c of hits) yield* e.discard(other(p), c.uid);
        return;
      }
      const hand = e.player(p).hand;
      if (hand.length) yield* e.discard(p, hand[Math.floor(e.rand() * hand.length)].uid);
    },
  };

  const miniTargets = (e: Engine) => targetable(e, faceUpMonsters(e).filter((m) => (info(e, m).atk ?? 0) > 1000 && levelOf(e, m) > 0));
  E['Miniaturize'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && miniTargets(e).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Miniaturize: target which monster?', miniTargets(e), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const card = e.fieldCard(link.card.uid);
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (card && m?.faceUp) {
        h.attachTo(e, card, m.uid);
        tag(m).lvMod = (m.tags?.lvMod ?? 0) - 1;
      } else if (card) yield* e.sendToGrave(card.uid, 'used');
    },
    equipBonus: () => ({ atk: -1000, def: 0 }),
    *onLeaveField(e, fc) {
      const m = fc.equippedTo !== undefined ? e.fieldCard(fc.equippedTo) : null;
      if (m) tag(m).lvMod = (m.tags?.lvMod ?? 0) + 1;
    },
  };

  type Plan = { fusion: Card; slots: Card[][] };
  const miraclePlans = (e: Engine, p: Pid): Plan[] => {
    const pool: Card[] = [...e.monsters(p), ...e.player(p).gy.filter((c) => isMonster(e, c))];
    const out: Plan[] = [];
    for (const fusion of e.player(p).fusion) {
      if (!named(fusion, 'Elemental HERO') || e.summonBlocked(p, fusion, 'special', 'fusion')) continue;
      const mats = listedMats(e, fusion.name);
      // Materials described by kind ("1 "Elemental HERO" monster + 1 WIND monster"): the script's fusionTests.
      const tests = mats ? null : e.effectOn(fusion)?.fusionTests;
      const slots = mats ? mats.map((n) => pool.filter((c) => c.name === n)) : tests ? tests.map((t) => pool.filter((c) => t(e, c))) : null;
      if (slots && assign(slots)) out.push({ fusion, slots });
    }
    return out;
  };
  E['Miracle Fusion'] = {
    canActivate: (e, _c, p, t) => isMain(t) && freeMZ(e, p) && miraclePlans(e, p).length > 0,
    *activate(e, link, p) {
      const plans = miraclePlans(e, p);
      const f = yield* pickOne(e, p, 'Miracle Fusion: Fusion Summon which monster?', plans.map((x) => x.fusion), true);
      if (!f) return false;
      const plan = plans.find((x) => x.fusion.uid === f.uid)!;
      const chosen: number[] = [];
      for (let i = 0; i < plan.slots.length; i++) {
        const free = plan.slots[i].filter((c) => !chosen.includes(c.uid) && assign(plan.slots.slice(i + 1), [...chosen, c.uid]));
        const c = yield* pickOne(e, p, `Banish which material (${i + 1}/${plan.slots.length})?`, free, true);
        if (!c) return false;
        chosen.push(c.uid);
      }
      link.payload = { fusion: f.uid, mats: chosen };
    },
    *resolve(e, link, p) {
      const { fusion, mats } = link.payload as { fusion: number; mats: number[] };
      const ok = (u: number) => ['mz', 'gy'].includes(e.find(u)?.loc.zone ?? '') && e.find(u)?.loc.player === p;
      if (e.find(fusion)?.loc.zone !== 'fusion' || !mats.every(ok)) return;
      for (const u of mats) e.banish(u);
      if (!freeMZ(e, p)) return;
      (e.state.fx.fusionMatList ??= {})[fusion] = mats.slice();
      yield* e.specialSummon(fusion, p, 'atk', true, (fc) => void ((fc.tags ??= {}).fusS = 1)); // a Fusion Summon
    },
  };

  const restoreTargets = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => c.name === 'Dark Magician' || c.name === 'Buster Blader');
  E['Miracle Restoring'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && counterTotal(e, p) >= 2 && freeMZ(e, p) && restoreTargets(e, p).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Miracle Restoring: Special Summon which monster?', restoreTargets(e, p), true);
      if (!c || counterTotal(e, p) < 2) return false;
      removeCounters(e, p, 2);
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid !== undefined && inGy(e, link.targetUid) && freeMZ(e, p)) yield* e.specialSummon(link.targetUid, p, 'atk');
    },
  };

  E['Mirage of Nightmare'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    *onStandby(e, c, p) {
      const t = tag(c);
      if (e.state.turnPlayer === other(p)) {
        const n = 4 - e.player(p).hand.length;
        if (n <= 0) return;
        e.draw(p, n);
        t.owed = n;
      } else if (t.owed) {
        const n = t.owed;
        t.owed = 0;
        for (let i = 0; i < n; i++) {
          const hand = e.player(p).hand;
          if (!hand.length) break;
          yield* e.discard(p, hand[Math.floor(e.rand() * hand.length)].uid);
        }
      }
    },
  };

  E['Mist Archfiend'] = {
    // "Normal Summon without Tributing" (a real Normal Summon, using up the turn's Normal Summon).
    handIgnition: {
      can: (e, _c, p) => !e.player(p).normalSummoned && freeMZ(e, p),
      *run(e, card, p) {
        const ps = e.player(p);
        const z = ps.mz.findIndex((x) => x === null);
        if (ps.normalSummoned || z < 0 || !(yield* e.yesno(p, 'Normal Summon Mist Archfiend without Tributing?'))) return;
        const c = lift(e, card.uid);
        if (!c) return;
        const fc = onField(e, c, true);
        fc.tags = { mist: 1 };
        ps.mz[z] = fc;
        ps.normalSummoned = true;
        e.event('summon', { uid: fc.uid, player: p });
        e.log(p, `${ps.name} Normal Summons Mist Archfiend without Tributing`);
        yield* e.responseWindow('summon', { uid: fc.uid, summonKind: 'normal' });
        if (e.fieldCard(fc.uid)) yield* e.anySummon(fc, p, 'normal');
      },
    },
    *onEndPhase(e, m, p) {
      if (!m.tags?.mist) return;
      m.tags.mist = 0;
      yield* e.destroy([m.uid]);
      if (!e.fieldCard(m.uid)) e.damage(p, 1000);
    },
  };
}
