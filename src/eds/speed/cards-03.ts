// Speed Duel card scripts, batch 03 (Contact with Gusto ... Dandylion).
import type { EffectDef } from '../effects';
import type { Card, ChainLink, Engine, FieldCard, Pid, SpeedHelpers, Step, Trigger, ChainCtx } from './helpers';
import {
  allMonsters,
  allST,
  anyTime,
  attrOf,
  boostPerm,
  boostTurn,
  chooseOption,
  ctrl,
  deckToGrave,
  discardCost,
  faceUpMonsters,
  freeMZ,
  freeST,
  fromGraveToHand,
  info,
  isExtraOrRitual,
  isMain,
  isMonster,
  isSpell,
  isTrap,
  levelOf,
  named,
  negateLink,
  negateMonster,
  opponentAttack,
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



// ---------- shared local helpers ----------
const raceIs = (e: Engine, c: Card, r: string) => raceOf(e, c) === r;
/** Monsters in a list that may be Special Summoned from there (no Fusion/Ritual revival). */
const summonable = (e: Engine, list: Card[], test: (c: Card) => boolean = () => true) => list.filter((c) => isMonster(e, c) && !isExtraOrRitual(e, c) && test(c));
const freeMZCount = (e: Engine, p: Pid) => e.player(p).mz.filter((z) => z === null).length;
const freeSTCount = (e: Engine, p: Pid) => e.player(p).sz.filter((z) => z === null).length;
/** Cards the opponent controls (monsters, Spells/Traps, Field). */
const oppCards = (e: Engine, p: Pid) => [...targetable(e, e.monsters(other(p))), ...allST(e).filter((c) => ctrl(e, c) === other(p))];
const fieldCards = (e: Engine) => [...targetable(e, allMonsters(e)), ...allST(e)];
const inZone = (e: Engine, uid: number, zone: string) => e.find(uid)?.loc.zone === zone;
const target = (e: Engine, link: ChainLink) => (link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null);
/** A Normal Trap that stays on the field after resolving (Trap cards that equip themselves). */
const keepOnField = (link: ChainLink) => {
  link.card = { ...link.card, uid: -1 };
};

/** Takes a card off the field cleanly (equips go to the GY, its host forgets it). */
function* unhook(e: Engine, uid: number): Step {
  const fc = e.fieldCard(uid);
  if (!fc) return;
  for (const u of fc.equips.slice()) yield* e.sendToGrave(u, 'used');
  if (fc.equippedTo !== undefined) {
    const host = e.fieldCard(fc.equippedTo);
    if (host) host.equips = host.equips.filter((x) => x !== uid);
    fc.equippedTo = undefined;
  }
}
function* bounce(e: Engine, uid: number): Step {
  const fc = e.fieldCard(uid);
  if (!fc) return;
  yield* unhook(e, uid);
  if (fc.token) return yield* e.sendToGrave(uid, 'used');
  e.toHand(uid);
}
function* toTop(e: Engine, uid: number): Step {
  const fc = e.fieldCard(uid);
  if (fc) {
    yield* unhook(e, uid);
    if (fc.token) return yield* e.sendToGrave(uid, 'used');
  }
  e.toDeckTop(uid);
}
function toBottom(e: Engine, uid: number) {
  const f = e.find(uid);
  if (!f) return;
  e.toDeckTop(uid);
  const d = e.player(f.card.owner).deck;
  const i = d.findIndex((c) => c.uid === uid);
  if (i >= 0) d.push(...d.splice(i, 1));
}
/** Puts a card from the hand, Deck, GY or banishment face-up into a Spell & Trap Zone (as a Continuous Spell, or equipped). */
function placeST(e: Engine, uid: number, p: Pid, equippedTo?: number): FieldCard | null {
  const zone = freeST(e, p);
  const f = e.find(uid);
  if (zone < 0 || !f) return null;
  const z = f.loc.zone;
  if (z !== 'hand' && z !== 'deck' && z !== 'gy' && z !== 'removed') return null;
  const host = equippedTo !== undefined ? e.fieldCard(equippedTo) : null;
  if (equippedTo !== undefined && !host) return null;
  e.player(f.loc.player)[z].splice(f.loc.index, 1);
  const fc: FieldCard = { uid, name: f.card.name, owner: f.card.owner, pos: 'atk', faceUp: true, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true };
  if (host) {
    fc.equippedTo = host.uid;
    host.equips.push(uid);
  }
  e.player(p).sz[zone] = fc;
  e.event('summon', { uid, player: p });
  if (z === 'deck') e.player(f.loc.player).deck = e.shuffle(e.player(f.loc.player).deck);
  return fc;
}
/** Banish-when-it-leaves bookkeeping (survives the card leaving the field). */
const markBanish = (e: Engine, uid: number) => ((e.state.fx.banishOnLeave ??= []) as number[]).push(uid);
function banishIfMarked(e: Engine, card: Card, from: string, always = false) {
  const list = (e.state.fx.banishOnLeave ?? []) as number[];
  if (from !== 'mz' || (!always && !list.includes(card.uid))) return;
  e.state.fx.banishOnLeave = list.filter((u) => u !== card.uid);
  if (inZone(e, card.uid, 'gy')) {
    e.banish(card.uid);
    e.log(card.owner, `${card.name} is banished instead`);
  }
}
/** Continuous Spell/Trap effects: an ignition effect in your Main Phase and, for Traps, a Quick Effect in response windows. */
function stEffect(key: string, label: string, can: (e: Engine, card: FieldCard, p: Pid) => boolean, run: (e: Engine, card: FieldCard, p: Pid) => Step, quick = true): Partial<EffectDef> {
  const k = (c: Card) => `${key}:${c.uid}`;
  return {
    ignition: {
      repeat: true,
      can: (e, m, p) => e.oncePerTurn(k(m), p) && can(e, m, p),
      *run(e, m, p) {
        e.useOnce(k(m), p);
        yield* run(e, m, p);
      },
    },
    ...(quick
      ? {
          quick: {
            label,
            repeat: true,
            can: (e: Engine, c: Card, p: Pid, t: Trigger) => t !== 'main' && e.oncePerTurn(k(c), p) && !!e.fieldCard(c.uid)?.active && can(e, e.fieldCard(c.uid)!, p),
            *cost(e: Engine, c: Card, p: Pid) {
              e.useOnce(k(c), p);
            },
            *run(e: Engine, c: Card, p: Pid) {
              const fc = e.fieldCard(c.uid);
              if (fc?.active) yield* run(e, fc, p);
            },
          },
        }
      : {}),
  };
}
const ends = (e: Engine, p: Pid) => {
  e.endBattle();
  for (const m of e.monsters(other(p))) m.attacked = true;
};

export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  // ===================== Crystal Beasts =====================
  const isCB = (c: Card) => named(c, 'Crystal Beast');
  const cbMon = (e: Engine, c: Card) => isCB(c) && isMonster(e, c);
  /** "Crystal Beast" Monster Cards in a player's Spell & Trap Zone. */
  const cbInST = (e: Engine, p: Pid) => e.spells(p).filter((c) => c.faceUp && cbMon(e, c) && c.equippedTo === undefined);
  const cbControlled = (e: Engine, p: Pid) => [...e.monsters(p).filter((m) => m.faceUp && isCB(m)), ...e.spells(p).filter((c) => c.faceUp && isCB(c))];
  const trapOn = (e: Engine, c: FieldCard) => !(isTrap(e, c) && e.trapsNegated(c.name));

  /** Effects that answer "if a Crystal Beast card is placed in your Spell & Trap Zone". */
  const placedTriggers: Record<string, { can(e: Engine, card: Card, p: Pid): boolean; run(e: Engine, card: Card, p: Pid): Step }> = {
    'Crystal Aegis': {
      can: (e, _c, p) => e.oncePerTurn('Crystal Aegis', p) && cbInST(e, p).length > 0 && freeMZ(e, p),
      *run(e, card, p) {
        e.useOnce('Crystal Aegis', p);
        e.banish(card.uid);
        yield* summonOneOf(e, p, 'Crystal Aegis: Special Summon which Crystal Beast?', cbInST(e, p));
      },
    },
    'Crystal Boon': {
      can: (e, _c, p) => e.oncePerTurn('Crystal Boon', p) && e.player(p).deck.length > 0,
      *run(e, card, p) {
        e.useOnce('Crystal Boon', p);
        e.banish(card.uid);
        const top = e.player(p).deck[0];
        if (!top) return;
        e.log(p, `Crystal Boon excavates ${top.name}`);
        if (!cbMon(e, top)) return yield* e.sendToGrave(top.uid, 'mill');
        const choice = freeMZ(e, p) ? yield* chooseOption(e, p, `Crystal Boon: ${top.name}`, ['Add it to your hand', 'Special Summon it']) : 0;
        if (choice === 1) yield* e.specialSummon(top.uid, p, 'atk');
        else e.toHandOf(top.uid, p);
      },
    },
    'Crystal Miracle': {
      can: (e, _c, p) => e.oncePerTurn('Crystal Miracle', p) && freeST(e, p) >= 0 && [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy].some((c) => cbMon(e, c)),
      *run(e, card, p) {
        e.useOnce('Crystal Miracle', p);
        e.banish(card.uid);
        yield* placeCB(e, p, 'Crystal Miracle: place which Crystal Beast?', [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy].filter((c) => cbMon(e, c)), 1);
      },
    },
  };
  function* crystalPlaced(e: Engine, p: Pid): Step {
    for (const q of [0, 1] as Pid[]) for (const t of e.activeSpells(q)) if (t.name === 'Crystal Tree' && !e.spellsNegated()) t.counters++;
    for (const b of e.activeSpells(p).filter((c) => c.name === 'Crystal Brilliance')) {
      const list = () => summonable(e, [...e.player(p).hand, ...e.player(p).gy], (c) => isCB(c));
      if (!e.fieldCard(b.uid) || !trapOn(e, b) || !freeMZ(e, p) || !list().length) continue;
      if (!(yield* e.yesno(p, 'Crystal Brilliance: send it to the GY to Special Summon a Crystal Beast from your hand or GY?'))) continue;
      yield* e.sendToGrave(b.uid, 'cost');
      yield* summonOneOf(e, p, 'Crystal Brilliance: Special Summon which Crystal Beast?', list());
      ((e.state.fx.halfDamage ??= [-1, -1]) as number[])[p] = e.state.turn;
      e.log(p, 'Crystal Brilliance: damage you take this turn is halved');
    }
    for (const c of e.player(p).gy.slice()) {
      const t = placedTriggers[c.name];
      if (!t || !inZone(e, c.uid, 'gy') || !t.can(e, c, p)) continue;
      if (yield* e.yesno(p, `Banish ${c.name} from your GY to use its effect?`)) yield* t.run(e, c, p);
    }
  }
  /** Places up to `max` chosen Crystal Beasts face-up in the Spell & Trap Zone, then fires the "placed" triggers. */
  function* placeCB(e: Engine, p: Pid, title: string, list: Card[], max: number, optional = false, exact = false): Step {
    const n = Math.min(max, freeSTCount(e, p), list.length);
    if (n <= 0) return;
    const chosen = yield* pick(e, p, title, list, exact ? n : optional ? 0 : 1, n, optional);
    if (!chosen?.length) return;
    let placed = 0;
    for (const c of chosen) if (placeST(e, c.uid, p)) (placed++, e.log(p, `${c.name} is placed in the Spell & Trap Zone as a Continuous Spell`));
    if (placed) yield* crystalPlaced(e, p);
  }
  function* conclave(e: Engine, p: Pid): Step {
    for (const c of e.activeSpells(p).filter((x) => x.name === 'Crystal Conclave')) {
      const key = `Crystal Conclave:1:${c.uid}`;
      const list = () => e.player(p).deck.filter((x) => cbMon(e, x));
      if (!e.fieldCard(c.uid) || !trapOn(e, c) || !e.oncePerTurn(key, p) || !freeMZ(e, p) || !list().length) continue;
      if (!(yield* e.yesno(p, 'Crystal Conclave: Special Summon a Crystal Beast from your Deck?'))) continue;
      e.useOnce(key, p);
      yield* summonOneOf(e, p, 'Crystal Conclave: Special Summon which Crystal Beast?', list());
    }
  }
  /** Every Crystal Beast: when destroyed in the Monster Zone it can be placed in the Spell & Trap Zone instead. */
  const crystalBeast = (extra: Partial<EffectDef> = {}): EffectDef => ({
    ...extra,
    *onSentToGrave(e, card, owner, from, reason) {
      if (from !== 'mz' || reason !== 'destroyed') return;
      if (freeST(e, owner) >= 0 && inZone(e, card.uid, 'gy') && (yield* e.yesno(owner, `${card.name}: place it in your Spell & Trap Zone as a Continuous Spell instead of the GY?`))) {
        if (placeST(e, card.uid, owner)) {
          e.log(owner, `${card.name} is placed in the Spell & Trap Zone`);
          yield* crystalPlaced(e, owner);
        }
      }
      yield* conclave(e, owner);
    },
  });
  const inMZ = (e: Engine, c: Card) => inZone(e, c.uid, 'mz');

  E['Crystal Beast Amber Mammoth'] = crystalBeast({
    quick: {
      label: 'become the attack target',
      repeat: true,
      can: (e, c, p, t, ctx) => {
        if (!inMZ(e, c) || opponentAttack(e, p, t, ctx) === null || ctx.targetUid === undefined || ctx.targetUid === c.uid) return false;
        const tg = e.fieldCard(ctx.targetUid);
        return !!tg && tg.faceUp && isCB(tg) && ctrl(e, tg) === p && e.state.battle?.target === tg.uid;
      },
      *run(e, c, p) {
        const b = e.state.battle;
        if (b && e.fieldCard(c.uid) && ctrl(e, c) === p && inMZ(e, c) && e.controller(b.attacker) === other(p)) {
          b.target = c.uid;
          e.log(p, 'Amber Mammoth takes the attack instead');
        }
      },
    },
  });
  E['Crystal Beast Amethyst Cat'] = crystalBeast({
    directAttack: true,
    attackBonus: (e, a, t) => (t === null && e.monsters(other(ctrl(e, a))).length > 0 ? -Math.floor(e.atkOf(a) / 2) : 0),
  });
  E['Crystal Beast Cobalt Eagle'] = crystalBeast({
    ignition: {
      can: (e, m, p) => inMZ(e, m) && cbControlled(e, p).length > 0,
      *run(e, m, p) {
        const t = yield* pickOne(e, p, 'Cobalt Eagle: return which Crystal Beast card to the top of the Deck?', cbControlled(e, p).filter((c) => !('pos' in c && e.untargetable(c))), true);
        if (t && e.fieldCard(t.uid)) yield* toTop(e, t.uid);
      },
    },
  });
  E['Crystal Beast Emerald Tortoise'] = crystalBeast({
    ignition: {
      can: (e, m, p) => inMZ(e, m) && e.monsters(p).some((x) => x.faceUp && x.attacked && x.pos === 'atk'),
      *run(e, _m, p) {
        const t = yield* pickOne(e, p, 'Emerald Tortoise: change which monster to Defense Position?', targetable(e, e.monsters(p).filter((x) => x.faceUp && x.attacked && x.pos === 'atk')), true);
        const m = t ? e.fieldCard(t.uid) : null;
        if (m && m.pos === 'atk') {
          m.pos = 'def';
          e.event('position', { uid: m.uid });
        }
      },
    },
  });
  E['Crystal Beast Ruby Carbuncle'] = crystalBeast({
    *onSpecialSummon(e, _m, p) {
      if (!cbInST(e, p).length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Ruby Carbuncle: Special Summon Crystal Beasts from your Spell & Trap Zone?'))) return;
      const n = Math.min(freeMZCount(e, p), cbInST(e, p).length);
      const chosen = yield* pick(e, p, `Ruby Carbuncle: Special Summon which ${n} Crystal Beast(s)?`, cbInST(e, p), n, n);
      for (const c of chosen ?? []) if (e.fieldCard(c.uid)) yield* e.specialSummon(c.uid, p, 'atk');
    },
  });
  const pegasus = function* (e: Engine, _m: FieldCard, p: Pid): Step {
    const list = [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy].filter((c) => cbMon(e, c));
    if (!list.length || freeST(e, p) < 0 || !(yield* e.yesno(p, 'Sapphire Pegasus: place a Crystal Beast in your Spell & Trap Zone?'))) return;
    yield* placeCB(e, p, 'Sapphire Pegasus: place which Crystal Beast?', list, 1);
  };
  E['Crystal Beast Sapphire Pegasus'] = crystalBeast({ onSummon: pegasus, onSpecialSummon: pegasus });
  E['Crystal Beast Topaz Tiger'] = crystalBeast({ attackBonus: (_e, _a, t) => (t ? 400 : 0) });

  E['Crystal Beast Token'] = { baseStats: (_e, m) => (m.tags?.tk ? { atk: m.tags.tAtk ?? 0, def: m.tags.tDef ?? 0 } : undefined) };
  E['Crystal Aegis'] = {
    canActivate: (e, _c, p, t) => isMain(t) && targetable(e, e.monsters(p).filter((m) => m.faceUp && isCB(m))).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Crystal Aegis: target which Crystal Beast?', targetable(e, e.monsters(p).filter((m) => m.faceUp && isCB(m))), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = target(e, link);
      if (!m || !m.faceUp || ctrl(e, m) !== p) return;
      const i = info(e, m);
      yield* e.destroy([m.uid]);
      if (e.fieldCard(m.uid)) return;
      const tok = e.createToken('Crystal Beast Token', p, 'atk', true, { atk: i.atk ?? 0, def: i.def ?? 0, level: i.level ?? 1, attribute: i.attribute, race: i.race });
      if (tok) Object.assign(tag(tok), { tk: 1, tAtk: i.atk ?? 0, tDef: i.def ?? 0 });
    },
  };
  E['Crystal Beacon'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.spells(p).filter((c) => c.faceUp && isCB(c)).length >= 2 && freeMZ(e, p) && e.player(p).deck.some((c) => cbMon(e, c)),
    *resolve(e, _l, p) {
      if (e.spells(p).filter((c) => c.faceUp && isCB(c)).length < 2) return;
      yield* summonOneOf(e, p, 'Crystal Beacon: Special Summon which Crystal Beast?', e.player(p).deck.filter((c) => cbMon(e, c)));
    },
  };
  E['Crystal Blessing'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.player(p).gy.some((x) => cbMon(e, x)) && freeSTCount(e, p) - (inZone(e, c.uid, 'hand') ? 1 : 0) >= 1,
    *activate(e, link, p) {
      const n = Math.min(2, freeSTCount(e, p));
      const chosen = yield* pick(e, p, 'Crystal Blessing: target up to 2 Crystal Beasts in your GY', e.player(p).gy.filter((x) => cbMon(e, x)), 1, n, true);
      if (!chosen) return false;
      link.payload = chosen.map((c) => c.uid);
    },
    *resolve(e, link, p) {
      let placed = 0;
      for (const u of link.payload as number[]) if (inZone(e, u, 'gy') && placeST(e, u, p)) placed++;
      if (placed) yield* crystalPlaced(e, p);
    },
  };
  E['Crystal Boon'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && cbInST(e, p).length > 0 && freeMZ(e, p),
    *resolve(e, _l, p) {
      const n = Math.min(2, freeMZCount(e, p), cbInST(e, p).length);
      if (n <= 0) return;
      const chosen = yield* pick(e, p, 'Crystal Boon: Special Summon up to 2 Crystal Beasts', cbInST(e, p), 1, n);
      let gain = 0;
      for (const c of chosen ?? []) {
        yield* e.specialSummon(c.uid, p, 'atk');
        if (inZone(e, c.uid, 'mz')) gain += info(e, c).atk ?? 0;
      }
      if (gain) e.gainLp(p, gain);
    },
  };
  E['Crystal Brilliance'] = {
    canActivate: (e, c, p, t) => anyTime(t) && !e.activeSpells(p).some((x) => x.name === c.name && x.uid !== c.uid),
    *resolve() {},
    aura: (e, src, m, sc) => (src.active && m.faceUp && isCB(m) && ctrl(e, m) === sc && inZone(e, m.uid, 'mz') ? { atk: info(e, m).def ?? 0, def: 0 } : undefined),
  };
  E['Crystal Conclave'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    ...stEffect(
      'Crystal Conclave:2',
      'return cards to the hand',
      (e, c, p) => cbControlled(e, p).length > 0 && fieldCards(e).filter((x) => x.uid !== c.uid).length >= 2,
      function* (e, card, p) {
        const mine = cbControlled(e, p).filter((x) => !('pos' in x && e.untargetable(x)));
        const a = yield* pickOne(e, p, 'Crystal Conclave: return which Crystal Beast card you control?', mine);
        if (!a) return;
        const b = yield* pickOne(e, p, 'Crystal Conclave: return which other card on the field?', fieldCards(e).filter((x) => x.uid !== a.uid && x.uid !== card.uid));
        yield* e.sendToGrave(card.uid, 'cost');
        if (!b) return;
        for (const u of [a.uid, b.uid]) if (e.fieldCard(u)) yield* bounce(e, u);
      },
    ),
  };
  E['Crystal Miracle'] = {
    canActivate: (e, _c, p, t, ctx) => (t === 'spell' || t === 'trap' || t === 'effect') && !!ctx.link && !ctx.link.negated && cbControlled(e, p).length > 0,
    *activate(e, link, _p, ctx) {
      link.payload = { target: ctx.link };
    },
    *resolve(e, link, p) {
      const t = (link.payload as { target?: ChainLink }).target;
      const c = yield* pickOne(e, p, 'Crystal Miracle: destroy which Crystal Beast card you control?', cbControlled(e, p));
      if (!c || !t) return;
      yield* e.destroy([c.uid]);
      // Not destroyed (still the same card object on the field). A Crystal Beast placed back in the S/T Zone was destroyed.
      if (e.fieldCard(c.uid) === c) return;
      negateLink(e, t, p);
      if (e.fieldCard(t.card.uid)) yield* e.destroy([t.card.uid]);
    },
  };
  E['Crystal Promise'] = {
    canActivate: (e, _c, p, t) => isMain(t) && cbInST(e, p).length > 0 && freeMZ(e, p),
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Crystal Promise: Special Summon which Crystal Beast?', cbInST(e, p), true);
      if (!c) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      const c = target(e, link);
      if (c && cbInST(e, p).includes(c)) yield* e.specialSummon(c.uid, p, 'atk');
    },
  };
  E['Crystal Raigeki'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.spells(p).some((c) => c.faceUp && isCB(c)) && oppCards(e, p).length > 0,
    *activate(e, link, p) {
      const cost = yield* pickOne(e, p, 'Crystal Raigeki: send which Crystal Beast card to the GY?', e.spells(p).filter((c) => c.faceUp && isCB(c)), true);
      if (!cost) return false;
      const t = yield* pickOne(e, p, 'Crystal Raigeki: destroy which card?', oppCards(e, p), true);
      if (!t) return false;
      yield* e.sendToGrave(cost.uid, 'cost');
      link.targetUid = t.uid;
    },
    *resolve(e, link) {
      if (target(e, link)) yield* e.destroy([link.targetUid!]);
    },
  };
  E['Crystal Release'] = h.equipFor((_e, m) => isCB(m), () => ({ atk: 800, def: 0 }), {
    *onSentToGrave(e, _card, owner, from) {
      if (from !== 'sz' || freeST(e, owner) < 0 || !e.player(owner).deck.some((c) => cbMon(e, c))) return;
      if (!(yield* e.yesno(owner, 'Crystal Release: place a Crystal Beast from your Deck in your Spell & Trap Zone?'))) return;
      yield* placeCB(e, owner, 'Crystal Release: place which Crystal Beast?', e.player(owner).deck.filter((c) => cbMon(e, c)), 1);
    },
  });
  E['Crystal Seer'] = {
    *flip(e, _m, p) {
      const top = e.player(p).deck.slice(0, 2);
      if (!top.length) return;
      const c = yield* pickOne(e, p, 'Crystal Seer: add which card to your hand?', top);
      if (!c) return;
      e.toHandOf(c.uid, p);
      for (const o of top) if (o.uid !== c.uid) toBottom(e, o.uid);
    },
  };
  E['Crystal Tree'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    ...stEffect(
      'Crystal Tree',
      '',
      (e, c, p) => c.counters > 0 && e.player(p).deck.some((x) => cbMon(e, x)),
      function* (e, card, p) {
        const n = card.counters;
        yield* e.sendToGrave(card.uid, 'cost');
        yield* placeCB(e, p, `Crystal Tree: place ${n} Crystal Beast${n > 1 ? 's' : ''}`, e.player(p).deck.filter((x) => cbMon(e, x)), n, false, true);
      },
      false,
    ),
  };

  // ===================== Cyberdark =====================
  const cdBonus = (e: Engine, m: FieldCard) => {
    const u = m.tags?.cdEquip;
    const eq = u !== undefined && m.equips.includes(u) ? e.fieldCard(u) : null;
    return eq ? info(e, eq).atk ?? 0 : 0;
  };
  const cdSub = (e: Engine, m: FieldCard) => {
    const u = m.tags?.cdEquip;
    return u !== undefined && m.equips.includes(u) && e.fieldCard(u) ? u : undefined;
  };
  function* cdEquip(e: Engine, m: FieldCard, p: Pid, test: (c: Card) => boolean, title: string, optional: boolean): Step {
    const list = e.player(p).gy.filter((c) => isMonster(e, c) && info(e, c).race === 'Dragon' && test(c));
    if (!list.length || freeST(e, p) < 0) return;
    const c = yield* pickOne(e, p, title, list, optional);
    if (c && e.fieldCard(m.uid) && placeST(e, c.uid, p, m.uid)) {
      tag(m).cdEquip = c.uid;
      e.log(p, `${c.name} is equipped to ${m.name}`);
    }
  }
  const cyberdark = (extra: Partial<EffectDef>): EffectDef => ({
    *onSummon(e, m, p, kind) {
      if (kind === 'normal') yield* cdEquip(e, m, p, (c) => levelOf(e, c) <= 3, `${m.name}: equip which Level 3 or lower Dragon from your GY?`, false);
    },
    selfBonus: (e, m) => ({ atk: cdBonus(e, m), def: 0 }),
    battleSubstitute: cdSub,
    ...extra,
  });
  E['Cyberdark Edge'] = cyberdark({
    directAttack: true,
    attackBonus: (e, a, t) => (t === null && e.monsters(other(ctrl(e, a))).length > 0 ? -Math.floor(e.atkOf(a) / 2) : 0),
  });
  E['Cyberdark Horn'] = cyberdark({ piercing: true });
  E['Cyberdark Keel'] = cyberdark({
    *afterBattle(e, a, t, p, destroyed) {
      if (destroyed && t && t.owner !== p) e.damage(other(p), 300);
    },
    *onAttacked(e, _self, attacker, p) {
      if (inZone(e, attacker.uid, 'gy') && attacker.owner !== p) e.damage(other(p), 300);
    },
  });
  E['Cyberdark Dragon'] = {
    *onSpecialSummon(e, m, p) {
      yield* cdEquip(e, m, p, () => true, 'Cyberdark Dragon: equip which Dragon from your GY?', false);
    },
    selfBonus: (e, m) => ({ atk: cdBonus(e, m) + 100 * e.player(ctrl(e, m)).gy.filter((c) => isMonster(e, c)).length, def: 0 }),
    battleSubstitute: cdSub,
  };
  const cdMats = ['Cyberdark Horn', 'Cyberdark Edge', 'Cyberdark Keel'];
  const cdPool = (e: Engine, p: Pid, name: string) => [...e.player(p).hand, ...e.player(p).gy, ...e.monsters(p).filter((m) => m.faceUp)].filter((c) => c.name === name);
  E['Cyberdark Impact!'] = {
    canActivate: (e, _c, p, t) =>
      isMain(t) && e.player(p).fusion.some((c) => c.name === 'Cyberdark Dragon') && cdMats.every((n) => cdPool(e, p, n).length > 0) && (freeMZ(e, p) || cdMats.some((n) => cdPool(e, p, n).some((c) => 'pos' in c))),
    *activate(e, link, p) {
      const mats: number[] = [];
      for (const n of cdMats) {
        const c = yield* pickOne(e, p, `Cyberdark Impact!: return which ${n}?`, cdPool(e, p, n), true);
        if (!c) return false;
        mats.push(c.uid);
      }
      link.payload = mats;
    },
    *resolve(e, link, p) {
      const mats = link.payload as number[];
      const fusion = e.player(p).fusion.find((c) => c.name === 'Cyberdark Dragon');
      if (!fusion || mats.some((u) => !e.find(u) || inZone(e, u, 'deck') || inZone(e, u, 'removed'))) return;
      for (const u of mats) {
        yield* unhook(e, u);
        toDeck(e, u);
      }
      if (!freeMZ(e, p)) return;
      yield* e.specialSummon(fusion.uid, p, 'atk');
      e.log(p, `${e.player(p).name} Fusion Summons Cyberdark Dragon!`);
    },
  };
  // Cyberdark Cannon / Claw: equipped-monster cards with a hand effect and a battle effect.
  const cdDragon = (search: (e: Engine, c: Card) => boolean, searchTitle: string, battle: (e: Engine, p: Pid) => Card[], battleTitle: string, onGrave: (e: Engine, card: Card, p: Pid) => Step): EffectDef => ({
    handIgnition: {
      can: (e, c, p) => e.oncePerTurn(`${c.name}:1`, p) && e.player(p).deck.some((x) => search(e, x)),
      *run(e, c, p) {
        e.useOnce(`${c.name}:1`, p);
        yield* e.discard(p, c.uid);
        yield* searchDeck(e, p, searchTitle, (x) => search(e, x));
      },
    },
    quick: {
      label: battleTitle,
      repeat: true,
      can: (e, c, p, t) => {
        const fc = e.fieldCard(c.uid);
        const b = e.state.battle;
        return t === 'attack' && !!fc && inZone(e, c.uid, 'sz') && fc.equippedTo !== undefined && !!b && (b.attacker === fc.equippedTo || b.target === fc.equippedTo) && e.oncePerTurn(`${c.name}:2`, p) && battle(e, p).length > 0;
      },
      *cost(e, c, p) {
        e.useOnce(`${c.name}:2`, p);
      },
      *run(e, _c, p) {
        const c = yield* pickOne(e, p, battleTitle, battle(e, p));
        if (c) yield* e.sendToGrave(c.uid, 'cost');
      },
    },
    *onSentToGrave(e, card, owner, from) {
      if (from === 'sz') yield* onGrave(e, card, owner);
    },
  });
  E['Cyberdark Cannon'] = cdDragon(
    (e, c) => named(c, 'Cyberdark') && isMonster(e, c) && info(e, c).race === 'Machine',
    'Cyberdark Cannon: add which Machine Cyberdark monster?',
    (e, p) => e.player(p).deck.filter((c) => isMonster(e, c)),
    'Cyberdark Cannon: send which monster from your Deck to the GY?',
    function* (e, _card, p) {
      if (e.player(p).deck.length && (yield* e.yesno(p, 'Cyberdark Cannon: draw 1 card?'))) e.draw(p, 1);
    },
  );
  E['Cyberdark Claw'] = cdDragon(
    (e, c) => named(c, 'Cyberdark') && !isMonster(e, c),
    'Cyberdark Claw: add which Cyberdark Spell/Trap?',
    (e, p) => e.player(p).fusion.slice(),
    'Cyberdark Claw: send which monster from your Extra Deck to the GY?',
    function* (e, card, p) {
      const list = e.player(p).gy.filter((c) => c.uid !== card.uid && named(c, 'Cyberdark') && isMonster(e, c));
      if (list.length && (yield* e.yesno(p, 'Cyberdark Claw: add a Cyberdark monster from your GY to your hand?'))) yield* fromGraveToHand(e, p, 'Cyberdark Claw: add which monster?', (c) => list.includes(c));
    },
  );
  E['Cyberdark Chimera'] = {
    ignition: {
      can: (e, _m, p) => e.oncePerTurn('Cyberdark Chimera:1', p) && e.player(p).hand.some((c) => !isMonster(e, c)) && e.player(p).deck.some((c) => c.name === 'Power Bond'),
      *run(e, _m, p) {
        if (!(yield* discardCost(e, p, 1, (c) => !isMonster(e, c)))) return;
        e.useOnce('Cyberdark Chimera:1', p);
        yield* searchDeck(e, p, 'Cyberdark Chimera: add Power Bond', (c) => c.name === 'Power Bond');
      },
    },
    *onSentToGrave(e, _card, p) {
      const names = new Set(e.player(p).gy.map((c) => c.name));
      const list = e.player(p).deck.filter((c) => named(c, 'Cyberdark') && isMonster(e, c) && !names.has(c.name));
      if (!list.length || !e.oncePerTurn('Cyberdark Chimera:2', p) || !(yield* e.yesno(p, 'Cyberdark Chimera: send a Cyberdark monster from your Deck to the GY?'))) return;
      e.useOnce('Cyberdark Chimera:2', p);
      yield* deckToGrave(e, p, 'Cyberdark Chimera: send which monster?', (c) => list.includes(c));
    },
  };
  const isCyber = (c: Card) => named(c, 'Cyber') && !named(c, 'Cyberse');
  const cyberDM = (e: Engine, c: Card) => isCyber(c) && isMonster(e, c) && ['Dragon', 'Machine'].includes(info(e, c).race ?? '');
  E['Cybernetic Horizon'] = {
    canActivate: (e, c, p, t) => {
      if (!isMain(t) || !e.oncePerTurn(c.name, p)) return false;
      const hand = e.player(p).hand.filter((x) => x.uid !== c.uid && cyberDM(e, x));
      const deck = e.player(p).deck.filter((x) => cyberDM(e, x));
      return hand.some((a) => deck.some((b) => attrOf(e, a) !== attrOf(e, b) && deck.some((d) => d.uid !== b.uid)));
    },
    *activate(e, link, p) {
      const hand = e.player(p).hand.filter((x) => cyberDM(e, x));
      const deckOk = (a: Card) => e.player(p).deck.filter((b) => cyberDM(e, b) && attrOf(e, a) !== attrOf(e, b));
      const a = yield* pickOne(e, p, 'Cybernetic Horizon: send which monster from your hand?', hand.filter((x) => deckOk(x).length > 0), true);
      if (!a) return false;
      const b = yield* pickOne(e, p, 'Cybernetic Horizon: send which monster from your Deck?', deckOk(a));
      if (!b) return false;
      e.useOnce(link.card.name, p);
      yield* e.sendToGrave(a.uid, 'cost');
      yield* e.sendToGrave(b.uid, 'cost');
      e.player(p).deck = e.shuffle(e.player(p).deck);
    },
    *resolve(e, _l, p) {
      const got = yield* searchDeck(e, p, 'Cybernetic Horizon: add which Dragon or Machine "Cyber" monster?', (c) => cyberDM(e, c));
      if (!got) return;
      const ex = e.player(p).fusion.filter((c) => isCyber(c) && info(e, c).race === 'Machine');
      const c = yield* pickOne(e, p, 'Cybernetic Horizon: send which Machine "Cyber" Fusion Monster to the GY?', ex);
      if (c) yield* e.sendToGrave(c.uid, 'cost');
    },
  };

  // ===================== Cyber Dragon & Cyber =====================
  const isCyberDragonName = (c: Card) => c.name === 'Cyber Dragon' || c.name === 'Cyber Dragon Core';
  E['Cyber Dragon Core'] = {
    *onSummon(e, _m, p, kind) {
      if (kind !== 'normal' || !e.oncePerTurn('Cyber Dragon Core', p)) return;
      const test = (c: Card) => isCyber(c) && !isMonster(e, c);
      if (!e.player(p).deck.some(test)) return;
      e.useOnce('Cyber Dragon Core', p);
      yield* searchDeck(e, p, 'Cyber Dragon Core: add which "Cyber" Spell/Trap?', test);
    },
    graveIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Cyber Dragon Core', p) && e.monsters(p).length === 0 && e.monsters(other(p)).length > 0 && e.player(p).deck.some((c) => named(c, 'Cyber Dragon') && isMonster(e, c) && !isExtraOrRitual(e, c)),
      *run(e, card, p) {
        e.useOnce('Cyber Dragon Core', p);
        e.banish(card.uid);
        yield* summonOneOf(e, p, 'Cyber Dragon Core: Special Summon which "Cyber Dragon" monster?', summonable(e, e.player(p).deck, (c) => named(c, 'Cyber Dragon')));
      },
    },
  };
  E['Cyber End Dragon'] = { piercing: true };
  E['Cyber Harpie Lady'] = {}; // name rule only
  E['Cyber Energy Shock'] = {
    canActivate: (e, c, p, t) => anyTime(t) && e.oncePerTurn(c.name, p) && e.monsters(p).some((m) => m.faceUp && m.name === 'Jinzo') && fieldCards(e).some((x) => x.uid !== c.uid),
    *activate(e, link, p) {
      const t = yield* pickOne(e, p, 'Cyber Energy Shock: destroy which card?', fieldCards(e).filter((x) => x.uid !== link.card.uid), true);
      if (!t) return false;
      e.useOnce(link.card.name, p);
      link.targetUid = t.uid;
    },
    *resolve(e, link, p) {
      const t = target(e, link);
      if (!t || !e.monsters(p).some((m) => m.faceUp && m.name === 'Jinzo')) return;
      const wasTrap = isTrap(e, t);
      yield* e.destroy([t.uid]);
      if (!wasTrap || e.fieldCard(t.uid)) return;
      const negs = targetable(e, faceUpMonsters(e)).filter((m) => !e.isNegated(m));
      const opts = ['Do nothing', ...(negs.length ? ['Negate the effects of a face-up monster'] : []), 'All "Jinzo" you control gain 800 ATK'];
      const ch = yield* chooseOption(e, p, 'Cyber Energy Shock: apply an effect?', opts);
      const pickd = ch === null ? 'Do nothing' : opts[ch];
      if (pickd.startsWith('Negate')) {
        const m = yield* pickOne(e, p, 'Negate which monster?', negs);
        if (m) negateMonster(e, m, true);
      } else if (pickd.startsWith('All')) for (const m of e.monsters(p).filter((x) => x.faceUp && x.name === 'Jinzo')) boostPerm(m, 800);
    },
  };
  E['Cyber Gymnast'] = {
    ignition: {
      can: (e, _m, p) => e.player(p).hand.length > 0 && targetable(e, e.monsters(other(p)).filter((m) => m.faceUp && m.pos === 'atk')).length > 0,
      *run(e, _m, p) {
        const list = () => targetable(e, e.monsters(other(p)).filter((m) => m.faceUp && m.pos === 'atk'));
        if (!list().length || !(yield* discardCost(e, p, 1))) return;
        const t = yield* pickOne(e, p, 'Cyber Gymnast: destroy which monster?', list());
        if (t) yield* e.destroy([t.uid]);
      },
    },
  };
  E['Cyber Network'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve(e, link) {
      const fc = e.fieldCard(link.card.uid);
      if (fc) tag(fc).sb = 0;
    },
    *onStandby(e, fc, p) {
      if (e.state.turnPlayer !== p) return;
      tag(fc).sb = (fc.tags?.sb ?? 0) + 1;
      if (fc.tags!.sb >= 3) {
        e.log(p, 'Cyber Network is destroyed');
        yield* e.destroy([fc.uid]);
      }
    },
    ...stEffect(
      'Cyber Network',
      'banish a LIGHT Machine from the Deck',
      (e, _c, p) => allMonsters(e).some((m) => m.faceUp && isCyberDragonName(m)) && e.player(p).deck.some((c) => isMonster(e, c) && attrOf(e, c) === 'LIGHT' && info(e, c).race === 'Machine'),
      function* (e, _c, p) {
        const c = yield* pickOne(e, p, 'Cyber Network: banish which LIGHT Machine?', e.player(p).deck.filter((c) => isMonster(e, c) && attrOf(e, c) === 'LIGHT' && info(e, c).race === 'Machine'));
        if (!c) return;
        e.banish(c.uid);
        e.player(p).deck = e.shuffle(e.player(p).deck);
      },
    ),
    *onLeaveField(e, fc, p) {
      if (!fc.faceUp || !fc.active || !inZone(e, fc.uid, 'gy')) return;
      const list = summonable(e, e.player(p).removed, (c) => attrOf(e, c) === 'LIGHT' && info(e, c).race === 'Machine');
      const n = Math.min(list.length, freeMZCount(e, p));
      if (n <= 0) return;
      const chosen = (yield* pick(e, p, `Cyber Network: Special Summon ${n} banished LIGHT Machine(s)`, list, n, n)) ?? [];
      let any = false;
      for (const c of chosen) {
        yield* e.specialSummon(c.uid, p, 'atk');
        const m = e.fieldCard(c.uid);
        if (m) (negateMonster(e, m, false), (any = true));
      }
      if (!any) return;
      const st = [...e.spells(p), ...(e.player(p).field ? [e.player(p).field!] : [])].map((c) => c.uid);
      if (st.length) yield* e.destroy(st);
      if (e.state.turnPlayer === p) for (const m of e.monsters(p)) tag(m).noAttackTurn = e.state.turn;
    },
  };
  E['Cyber Phoenix'] = {
    *onDestroyed(e, _card, p, byBattle) {
      if (byBattle && e.player(p).deck.length && (yield* e.yesno(p, 'Cyber Phoenix: draw 1 card?'))) e.draw(p, 1);
    },
  };
  E['Cyber Prima'] = {
    *onSummon(e, _m, _p, kind) {
      if (kind !== 'normal') return;
      const spells = allST(e).filter((c) => c.faceUp && !isTrap(e, c));
      if (spells.length) yield* e.destroy(spells.map((c) => c.uid));
    },
  };
  const raider = function* (e: Engine, m: FieldCard, p: Pid): Step {
    const list = () => allST(e).filter((c) => c.faceUp && c.equippedTo !== undefined && c.equippedTo !== m.uid);
    if (!list().length) return;
    const canTake = (c: FieldCard) => ctrl(e, c) === p || freeST(e, p) >= 0;
    const ch = (yield* chooseOption(e, p, 'Cyber Raider: which effect?', ['Destroy an Equip Card', 'Equip an Equip Card to Cyber Raider'])) ?? 0;
    const t = yield* pickOne(e, p, 'Cyber Raider: target which Equip Card?', ch === 1 ? list().filter(canTake) : list());
    if (!t || !e.fieldCard(t.uid)) return;
    if (ch === 0) return yield* e.destroy([t.uid]);
    if (!e.fieldCard(m.uid) || !canTake(t)) return;
    const old = t.equippedTo !== undefined ? e.fieldCard(t.equippedTo) : null;
    if (old) old.equips = old.equips.filter((u) => u !== t.uid);
    const f = e.find(t.uid)!;
    if (f.loc.player !== p) {
      e.player(f.loc.player).sz[f.loc.index] = null;
      e.player(p).sz[freeST(e, p)] = t;
    }
    t.equippedTo = m.uid;
    m.equips.push(t.uid);
    e.log(p, `${t.name} is now equipped to Cyber Raider`);
  };
  E['Cyber Raider'] = { onSummon: raider, onSpecialSummon: raider };
  const lightMachine = (e: Engine, c: Card) => isMonster(e, c) && attrOf(e, c) === 'LIGHT' && info(e, c).race === 'Machine';
  E['Cyber Repair Plant'] = {
    canActivate: (e, c, p, t) =>
      isMain(t) && e.oncePerTurn(c.name, p) && e.player(p).gy.some(isCyberDragonName) && (e.player(p).deck.some((x) => lightMachine(e, x)) || e.player(p).gy.some((x) => lightMachine(e, x))),
    *activate(e, link, p) {
      const both = e.player(p).gy.filter(isCyberDragonName).length >= 3;
      const canA = e.player(p).deck.some((x) => lightMachine(e, x));
      const canB = e.player(p).gy.some((x) => lightMachine(e, x));
      const opts: string[] = [];
      if (canA) opts.push('Add a LIGHT Machine from your Deck');
      if (canB) opts.push('Shuffle a LIGHT Machine from your GY into the Deck');
      if (both && canA && canB) opts.push('Both');
      const ch = yield* chooseOption(e, p, 'Cyber Repair Plant: which effect?', opts, true);
      if (ch === null) return false;
      const label = opts[ch];
      const pay = { search: label.startsWith('Add') || label === 'Both', back: undefined as number | undefined };
      if (label.startsWith('Shuffle') || label === 'Both') {
        const t = yield* pickOne(e, p, 'Cyber Repair Plant: target which LIGHT Machine in your GY?', e.player(p).gy.filter((x) => lightMachine(e, x)), true);
        if (!t) return false;
        pay.back = t.uid;
      }
      e.useOnce(link.card.name, p);
      link.payload = pay;
    },
    *resolve(e, link, p) {
      const pay = link.payload as { search: boolean; back?: number };
      if (pay.search) yield* searchDeck(e, p, 'Cyber Repair Plant: add which LIGHT Machine?', (c) => lightMachine(e, c));
      if (pay.back !== undefined && inZone(e, pay.back, 'gy')) toDeck(e, pay.back);
    },
  };
  E['Cyber Shadow Gardna'] = {
    canActivate: (e, _c, p, t) => t !== 'main' && anyTime(t) && e.state.turnPlayer !== p && e.inMainPhase() && freeMZ(e, p),
    *resolve(e, link, p) {
      if (!inZone(e, link.card.uid, 'sz')) return;
      yield* e.specialSummon(link.card.uid, p, 'def');
    },
    baseStats: (e, m) => (inZone(e, m.uid, 'mz') ? { atk: m.tags?.gA ?? 0, def: m.tags?.gD ?? 0 } : undefined),
    *onBeingAttacked(e, self, attacker) {
      Object.assign(tag(self), { gA: e.atkOf(attacker), gD: e.defOf(attacker) });
    },
    *onEndPhase(e, m, p) {
      const f = e.find(m.uid);
      if (e.state.turnPlayer === p || m.owner !== p || !f || f.loc.zone !== 'mz' || freeST(e, p) < 0 || !e.oncePerTurn(`gardna:${m.uid}`, p)) return;
      e.useOnce(`gardna:${m.uid}`, p);
      yield* unhook(e, m.uid);
      const g = e.find(m.uid);
      if (!g || g.loc.zone !== 'mz') return;
      e.player(p).mz[g.loc.index] = null;
      e.player(p).sz[freeST(e, p)] = { uid: m.uid, name: m.name, owner: m.owner, pos: 'atk', faceUp: false, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
      e.event('set', { uid: m.uid, player: p });
      e.log(p, 'Cyber Shadow Gardna is Set again');
    },
  };
  E['Cyber Tutu'] = {
    directAttack: (e, m, p) => e.monsters(other(p)).every((x) => e.atkOf(x) > e.atkOf(m)),
  };
  E['Cyber Valley'] = {
    quick: {
      label: 'banish it to draw 1 and end the Battle Phase',
      repeat: true,
      can: (e, c, p, t, ctx) => inZone(e, c.uid, 'mz') && opponentAttack(e, p, t, ctx) !== null && ctx.targetUid === c.uid,
      *cost(e, c) {
        e.banish(c.uid);
      },
      *run(e, _c, p) {
        e.draw(p, 1);
        ends(e, p);
      },
    },
    ignition: {
      can: (e, m, p) => targetable(e, e.monsters(p).filter((x) => x.faceUp && x.uid !== m.uid)).length > 0 || (e.player(p).gy.length > 0 && e.player(p).hand.length > 0),
      *run(e, m, p) {
        const mons = targetable(e, e.monsters(p).filter((x) => x.faceUp && x.uid !== m.uid));
        const opts = [...(mons.length ? ['Banish it and a monster you control, then draw 2'] : []), ...(e.player(p).gy.length && e.player(p).hand.length ? ['Banish it and a card from your hand; put a GY card on top of the Deck'] : [])];
        const ch = yield* chooseOption(e, p, 'Cyber Valley: which effect?', opts, true);
        if (ch === null) return;
        if (opts[ch].includes('draw 2')) {
          const t = yield* pickOne(e, p, 'Cyber Valley: banish which monster?', mons);
          if (!t || !e.fieldCard(t.uid) || !e.fieldCard(m.uid)) return;
          e.banish(t.uid);
          e.banish(m.uid);
          e.draw(p, 2);
        } else {
          const t = yield* pickOne(e, p, 'Cyber Valley: target which card in your GY?', e.player(p).gy);
          const hc = yield* pickOne(e, p, 'Cyber Valley: banish which card from your hand?', e.player(p).hand);
          if (!t || !hc || !e.fieldCard(m.uid)) return;
          e.banish(m.uid);
          e.banish(hc.uid);
          if (inZone(e, t.uid, 'gy')) e.toDeckTop(t.uid);
        }
      },
    },
  };
  E['Cyber Blader'] = {
    battleProof: (e, m) => e.monsters(other(ctrl(e, m))).length === 1,
    selfBonus: (e, m) => (e.monsters(other(ctrl(e, m))).length === 2 ? { atk: e.baseStats(m).atk + m.atkMod + (m.tags?.permAtk ?? 0), def: 0 } : { atk: 0, def: 0 }),
  };

  // ===================== Cyber Angels (Ritual) =====================
  const fairyLight = (e: Engine, c: Card) => isMonster(e, c) && info(e, c).race === 'Fairy' && attrOf(e, c) === 'LIGHT';
  E['Cyber Angel Benten'] = {
    *afterBattle(e, _a, t, p, destroyed) {
      if (destroyed && t && inZone(e, t.uid, 'gy') && t.owner !== p) e.damage(other(p), info(e, t).def ?? 0);
    },
    *onAttacked(e, _self, attacker, p) {
      if (inZone(e, attacker.uid, 'gy') && attacker.owner !== p) e.damage(other(p), info(e, attacker).def ?? 0);
    },
    *onSentToGrave(e, _c, p, _from, reason) {
      if (reason === 'tribute' && e.player(p).deck.some((c) => fairyLight(e, c)) && (yield* e.yesno(p, 'Cyber Angel Benten: add a LIGHT Fairy from your Deck?'))) yield* searchDeck(e, p, 'Cyber Angel Benten: add which LIGHT Fairy?', (c) => fairyLight(e, c));
    },
  };
  const ritualSpellCard = (e: Engine, c: Card) => isSpell(e, c) && info(e, c).sub === 'Ritual';
  E['Cyber Angel Idaten'] = {
    *onSpecialSummon(e, _m, p) {
      const list = [...e.player(p).deck, ...e.player(p).gy].filter((c) => ritualSpellCard(e, c));
      if (!list.length || !(yield* e.yesno(p, 'Cyber Angel Idaten: add a Ritual Spell from your Deck or GY?'))) return;
      const c = yield* pickOne(e, p, 'Cyber Angel Idaten: add which Ritual Spell?', list);
      if (!c) return;
      const fromDeck = inZone(e, c.uid, 'deck');
      e.toHandOf(c.uid, p);
      if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
    },
    *onSentToGrave(e, _c, p, _from, reason) {
      const rituals = e.monsters(p).filter((m) => m.faceUp && info(e, m).sub === 'Ritual');
      if (reason !== 'tribute' || !rituals.length || !(yield* e.yesno(p, 'Cyber Angel Idaten: your Ritual Monsters gain 1000 ATK/DEF?'))) return;
      for (const m of e.monsters(p).filter((m) => m.faceUp && info(e, m).sub === 'Ritual')) boostPerm(m, 1000, 1000);
    },
  };
  E['Cyber Angel Izana'] = {
    *onSpecialSummon(e, _m, p) {
      const o = other(p);
      if (!stCards(e, o).length || !(yield* e.yesno(p, 'Cyber Angel Izana: make your opponent send 1 Spell/Trap they control to the GY?'))) return;
      const c = yield* pickOne(e, o, 'Cyber Angel Izana: send which of your Spells/Traps to the GY?', stCards(e, o));
      if (c) yield* e.sendToGrave(c.uid, 'used');
    },
    *afterBattle(e, a, t, p, destroyed) {
      if (!destroyed || !t || !inZone(e, t.uid, 'gy') || a.tags?.izana === e.state.turn) return;
      if (yield* e.yesno(p, 'Cyber Angel Izana: make a second attack on a monster?')) tag(a).izana = e.state.turn;
    },
    attacks: (e, m) => (m.tags?.izana === e.state.turn ? 2 : 1),
    cannotAttack: (e, m, p) => m.attacked && m.tags?.izana === e.state.turn && e.monsters(other(p)).length === 0,
    quick: {
      label: 'destroy a card your opponent controls',
      can: (e, c, p, t, ctx) => {
        if (!inZone(e, c.uid, 'mz') || !(t === 'spell' || t === 'trap' || t === 'effect') || !ctx.link || ctx.link.player === p || ctx.link.targetUid === undefined) return false;
        const tg = e.fieldCard(ctx.link.targetUid);
        return !!tg && ctrl(e, tg) === p && tg.faceUp && named(tg, 'Cyber Angel') && info(e, tg).sub === 'Ritual' && e.player(p).gy.some((x) => isMonster(e, x) && info(e, x).sub === 'Ritual') && oppCards(e, p).length > 0;
      },
      *run(e, _c, p) {
        const r = yield* pickOne(e, p, 'Cyber Angel Izana: shuffle which Ritual Monster into the Deck?', e.player(p).gy.filter((x) => isMonster(e, x) && info(e, x).sub === 'Ritual'));
        if (!r) return;
        toDeck(e, r.uid);
        const t = yield* pickOne(e, p, 'Cyber Angel Izana: destroy which card?', oppCards(e, p));
        if (t) yield* e.destroy([t.uid]);
      },
    },
  };
  function stCards(e: Engine, p: Pid) {
    return [...e.spells(p), ...(e.player(p).field ? [e.player(p).field!] : [])];
  }

  // ===================== Cyberse =====================
  /** Fusion Summon by banishing named materials from the field or GY, one of them a Cyberse monster (Cyberse Sage). */
  const sagePool = (e: Engine, p: Pid) => [...e.monsters(p).filter((m) => m.faceUp), ...e.player(p).gy.filter((c) => isMonster(e, c))];
  const sageFits = (e: Engine, pool: Card[], ids: number[], used: Card[]): boolean => {
    if (!ids.length) return used.some((c) => info(e, c).race === 'Cyberse');
    return pool.some((c) => !used.includes(c) && info(e, c).id === ids[0] && sageFits(e, pool, ids.slice(1), [...used, c]));
  };
  const sagePlans = (e: Engine, p: Pid) =>
    e.player(p).fusion.filter((f) => {
      const ids = e.fusionMaterials(f.name);
      return !!ids && sageFits(e, sagePool(e, p), ids, []) && (freeMZ(e, p) || sagePool(e, p).some((c) => 'pos' in c));
    });
  E['Cyberse Sage'] = {
    ignition: {
      can: (e, _m, p) => e.oncePerTurn('Cyberse Sage', p) && sagePlans(e, p).length > 0,
      *run(e, _m, p) {
        const f = yield* pickOne(e, p, 'Cyberse Sage: Fusion Summon which monster?', sagePlans(e, p), true);
        if (!f) return;
        const ids = e.fusionMaterials(f.name)!;
        const pool = sagePool(e, p);
        const used: Card[] = [];
        for (let i = 0; i < ids.length; i++) {
          const ok = pool.filter((c) => !used.includes(c) && info(e, c).id === ids[i] && sageFits(e, pool, ids.slice(i + 1), [...used, c]));
          const c = yield* pickOne(e, p, `Cyberse Sage: banish which ${ok[0]?.name ?? 'material'}?`, ok);
          if (!c) return;
          used.push(c);
        }
        e.useOnce('Cyberse Sage', p);
        for (const c of used) {
          yield* unhook(e, c.uid);
          e.banish(c.uid);
        }
        if (freeMZ(e, p) && inZone(e, f.uid, 'fusion')) yield* e.specialSummon(f.uid, p, 'atk');
      },
    },
  };
  const cyberse = (e: Engine, c: Card) => isMonster(e, c) && info(e, c).race === 'Cyberse';
  E['Cynet Rollback'] = {
    canActivate: (e, c, p, t) => anyTime(t) && e.oncePerTurn(c.name, p) && freeMZ(e, p) && summonable(e, e.player(p).removed, (x) => cyberse(e, x)).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Cynet Rollback: Special Summon which banished Cyberse?', summonable(e, e.player(p).removed, (x) => cyberse(e, x)), true);
      if (!c) return false;
      e.useOnce(link.card.name, p);
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid !== undefined && inZone(e, link.targetUid, 'removed')) yield* e.specialSummon(link.targetUid, p, 'atk');
    },
    graveIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Cynet Rollback:2', p) && e.player(p).lp <= 2000 && e.player(p).removed.filter((c) => cyberse(e, c)).length >= 2,
      *run(e, card, p) {
        const chosen = yield* pick(e, p, 'Cynet Rollback: add which 2 banished Cyberse monsters?', e.player(p).removed.filter((c) => cyberse(e, c)), 2, 2, true);
        if (!chosen) return;
        e.useOnce('Cynet Rollback:2', p);
        e.banish(card.uid);
        for (const c of chosen) e.toHandOf(c.uid, p);
      },
    },
  };

  // ===================== Destiny HERO / D.D. =====================
  const dHero = (c: Card) => named(c, 'Destiny HERO');
  E['D - Chain'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && targetable(e, e.monsters(p).filter((m) => m.faceUp && dHero(m))).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'D - Chain: equip to which Destiny HERO?', targetable(e, e.monsters(p).filter((m) => m.faceUp && dHero(m))), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = target(e, link);
      const fc = e.fieldCard(link.card.uid);
      if (!m || !fc || !m.faceUp || ctrl(e, m) !== p) return;
      h.attachTo(e, fc, m.uid);
      keepOnField(link);
    },
    equipBonus: () => ({ atk: 500, def: 0 }),
    *hostAfterBattle(e, _eq, host, t) {
      const p = ctrl(e, host);
      if (t && inZone(e, t.uid, 'gy') && t.owner !== p) e.damage(other(p), 500);
    },
  };
  E['D - Counter'] = {
    canActivate: (e, _c, p, t, ctx) => {
      if (opponentAttack(e, p, t, ctx) === null || ctx.targetUid === undefined) return false;
      const tg = e.fieldCard(ctx.targetUid);
      return !!tg && tg.faceUp && dHero(tg) && ctrl(e, tg) === p;
    },
    *resolve(e) {
      const b = e.state.battle;
      if (b && e.fieldCard(b.attacker)) yield* e.destroy([b.attacker]);
    },
  };
  E['D - Spirit'] = {
    canActivate: (e, _c, p, t) => isMain(t) && freeMZ(e, p) && !e.monsters(p).some((m) => m.faceUp && dHero(m)) && e.player(p).hand.some((c) => dHero(c) && isMonster(e, c) && levelOf(e, c) <= 4),
    *resolve(e, _l, p) {
      if (e.monsters(p).some((m) => m.faceUp && dHero(m))) return;
      yield* summonOneOf(e, p, 'D - Spirit: Special Summon which Destiny HERO?', e.player(p).hand.filter((c) => dHero(c) && isMonster(e, c) && levelOf(e, c) <= 4));
    },
  };
  E['D-Boyz'] = {
    *flip(e, _m, p) {
      const list = e.player(p).deck.filter((c) => c.name === 'D-Boyz');
      const n = Math.min(list.length, freeMZCount(e, p));
      if (n <= 0) return;
      const chosen = yield* pick(e, p, 'D-Boyz: Special Summon how many D-Boyz from your Deck?', list, 0, n, true);
      let count = 0;
      for (const c of chosen ?? []) {
        yield* e.specialSummon(c.uid, p, 'atk');
        if (inZone(e, c.uid, 'mz')) count++;
      }
      e.player(p).deck = e.shuffle(e.player(p).deck);
      if (count) e.damage(p, 1000 * count);
    },
  };
  E['D.D. Crow'] = {
    quick: {
      from: 'hand',
      label: 'discard it to banish a card from the opponent\'s GY',
      can: (e, _c, p) => e.player(other(p)).gy.length > 0,
      *cost(e, c, p, link) {
        const t = yield* pickOne(e, p, 'D.D. Crow: banish which card?', e.player(other(p)).gy, true);
        if (!t) return false;
        yield* e.discard(p, c.uid);
        link.targetUid = t.uid;
      },
      *run(e, _c, p, link) {
        if (link.targetUid !== undefined && inZone(e, link.targetUid, 'gy') && e.controller(link.targetUid) === other(p)) e.banish(link.targetUid);
      },
    },
  };
  const ddLady = function* (e: Engine, self: FieldCard, foe: FieldCard, p: Pid): Step {
    if (!e.fieldCard(self.uid) || !e.fieldCard(foe.uid) || ctrl(e, foe) === p) return;
    if (!(yield* e.yesno(p, `D.D. Warrior Lady: banish ${foe.name} and D.D. Warrior Lady?`))) return;
    yield* unhook(e, foe.uid);
    e.banish(foe.uid);
    if (e.fieldCard(self.uid)) e.banish(self.uid);
  };
  E['D.D. Warrior Lady'] = {
    *afterBattle(e, a, t, p) {
      if (t) yield* ddLady(e, a, t, p);
    },
    *onAttacked(e, self, attacker, p) {
      yield* ddLady(e, self, attacker, p);
    },
  };
  E['D.D.M. - Different Dimension Master'] = {
    ignition: {
      can: (e, _m, p) => freeMZ(e, p) && e.player(p).hand.some((c) => isSpell(e, c)) && summonable(e, e.player(p).removed).length > 0,
      *run(e, _m, p) {
        if (!summonable(e, e.player(p).removed).length || !(yield* discardCost(e, p, 1, (c) => isSpell(e, c)))) return;
        yield* summonOneOf(e, p, 'D.D.M.: Special Summon which banished monster?', summonable(e, e.player(p).removed));
      },
    },
  };
  E['D/D Gryphon'] = {
    summonProc: {
      can: (e, _c, p) => e.oncePerTurn('D/D Gryphon:1', p) && freeMZ(e, p) && e.monsters(p).some((m) => m.faceUp && named(m, 'D/D')),
      *run(e, c, p) {
        e.useOnce('D/D Gryphon:1', p);
        yield* e.specialSummon(c.uid, p, 'def');
      },
    },
  };
  // Their monster effects only work with Pendulum Zones, which this game does not have.
  E['D/D Savant Nikola'] = {};
  E['D/D Savant Thomas'] = {};
  E['DUCKER Mobile Cannon'] = {
    *flip(e, _m, p) {
      yield* fromGraveToHand(e, p, 'DUCKER Mobile Cannon: add which Level 4 monster?', (c) => isMonster(e, c) && levelOf(e, c) === 4);
    },
  };
  E['Damage Condenser'] = {
    canActivate: (e, c, p, t, ctx) =>
      t === 'damage' && ctx.damaged === p && !!e.state.battle && freeMZ(e, p) && e.player(p).hand.some((x) => x.uid !== c.uid) && summonable(e, e.player(p).deck, (x) => (info(e, x).atk ?? 0) <= (ctx.amount ?? 0)).length > 0,
    *activate(e, link, p, ctx) {
      if (!(yield* discardCost(e, p, 1))) return false;
      link.payload = ctx.amount ?? 0;
    },
    *resolve(e, link, p) {
      const n = link.payload as number;
      yield* summonOneOf(e, p, 'Damage Condenser: Special Summon which monster?', summonable(e, e.player(p).deck, (x) => (info(e, x).atk ?? 0) <= n), 'atk');
    },
  };
  E['Damage Mage'] = {
    quick: {
      from: 'hand',
      label: 'Special Summon it and gain the LP',
      can: (e, _c, p, t, ctx) => t === 'damage' && ctx.damaged === p && !e.state.battle && (ctx.amount ?? 0) > 0 && freeMZ(e, p),
      *run(e, c, p, link) {
        if (!inZone(e, c.uid, 'hand') || !freeMZ(e, p)) return;
        yield* e.specialSummon(c.uid, p, 'atk');
        const amt = ((link.payload as { ctx?: ChainCtx }).ctx?.amount ?? 0) as number;
        if (inZone(e, c.uid, 'mz') && amt > 0) e.gainLp(p, amt);
      },
    },
  };
  E['Dandylion'] = {
    *onSentToGrave(e, _c, p) {
      if (freeMZCount(e, p) < 2) return;
      for (let i = 0; i < 2; i++) e.createToken('Fluff Token', p, 'def', true, { atk: 0, def: 0, level: 1, attribute: 'WIND', race: 'Plant' });
    },
  };

  // ===================== C... =====================
  const gusto = (e: Engine, c: Card) => named(c, 'Gusto') && isMonster(e, c);
  E['Contact with Gusto'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).gy.filter((c) => gusto(e, c)).length >= 2 && oppCards(e, p).length > 0,
    *activate(e, link, p) {
      const two = yield* pick(e, p, 'Contact with Gusto: target 2 Gusto monsters in your GY', e.player(p).gy.filter((c) => gusto(e, c)), 2, 2, true);
      if (!two) return false;
      const t = yield* pickOne(e, p, 'Contact with Gusto: target which card your opponent controls?', oppCards(e, p), true);
      if (!t) return false;
      link.targetUid = t.uid;
      link.payload = two.map((c) => c.uid);
    },
    *resolve(e, link) {
      const two = link.payload as number[];
      if (two.some((u) => !inZone(e, u, 'gy'))) return;
      for (const u of two) toDeck(e, u);
      if (target(e, link)) yield* e.destroy([link.targetUid!]);
    },
  };
  E['Contract with the Void'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.player(p).hand.filter((x) => x.uid !== c.uid).length >= 3,
    *resolve(e, _l, p) {
      for (const c of e.player(p).hand.slice()) if (inZone(e, c.uid, 'hand')) yield* e.discard(p, c.uid);
      const list = summonable(e, e.player(p).gy, (c) => named(c, 'Infernity'));
      if (!list.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Contract with the Void: Special Summon an Infernity monster from your GY?'))) return;
      yield* summonOneOf(e, p, 'Contract with the Void: Special Summon which monster?', list);
    },
  };
  const neoSpacian = (e: Engine, c: Card) => named(c, 'Neo-Spacian') && isMonster(e, c);
  E['Convert Contact'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.monsters(p).length === 0 && e.player(p).hand.some((c) => neoSpacian(e, c)) && e.player(p).deck.some((c) => neoSpacian(e, c)) && e.player(p).deck.length >= 3,
    *resolve(e, _l, p) {
      if (e.monsters(p).length) return;
      const a = yield* pickOne(e, p, 'Convert Contact: send which Neo-Spacian from your hand?', e.player(p).hand.filter((c) => neoSpacian(e, c)));
      if (!a) return;
      const b = e.player(p).deck.some((c) => neoSpacian(e, c)) ? yield* deckToGrave(e, p, 'Convert Contact: send which Neo-Spacian from your Deck?', (c) => neoSpacian(e, c)) : null;
      if (!b) return;
      yield* e.sendToGrave(a.uid, 'cost');
      e.draw(p, 2);
    },
  };
  const copycat = function* (e: Engine, m: FieldCard, p: Pid): Step {
    const t = yield* pickOne(e, p, 'Copycat: target which monster?', targetable(e, faceUpMonsters(e, other(p))));
    if (!t || !e.fieldCard(m.uid)) return;
    const i = info(e, t);
    Object.assign(tag(m), { copied: 1, cAtk: i.atk ?? 0, cDef: i.def ?? 0 });
  };
  E['Copycat'] = {
    onSummon: copycat,
    onSpecialSummon: copycat,
    baseStats: (_e, m) => (m.tags?.copied ? { atk: m.tags.cAtk ?? 0, def: m.tags.cDef ?? 0 } : undefined),
  };
  const darkMon = (e: Engine, c: Card) => isMonster(e, c) && attrOf(e, c) === 'DARK';
  E['Core of Chaos'] = {
    cannotNormalSummon: true,
    handIgnition: {
      can: (e, c, p) => e.oncePerTurn('Core of Chaos:1', p) && freeMZ(e, p) && [...e.player(p).hand, ...e.player(p).gy].some((x) => x.uid !== c.uid && darkMon(e, x)),
      *run(e, c, p) {
        const cost = yield* pickOne(e, p, 'Core of Chaos: banish which DARK monster?', [...e.player(p).hand, ...e.player(p).gy].filter((x) => x.uid !== c.uid && darkMon(e, x)), true);
        if (!cost) return;
        e.useOnce('Core of Chaos:1', p);
        e.banish(cost.uid);
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
    *onSpecialSummon(e, _m, p) {
      const list = e.player(p).removed.filter((c) => c.name === 'Shell of Chaos');
      if (!list.length || !freeMZ(e, p) || !e.oncePerTurn('Core of Chaos:2', p) || !(yield* e.yesno(p, 'Core of Chaos: Special Summon a banished Shell of Chaos?'))) return;
      e.useOnce('Core of Chaos:2', p);
      yield* summonOneOf(e, p, 'Core of Chaos: Special Summon which?', list);
    },
    *onSentToGrave(e, card, _o, from) {
      banishIfMarked(e, card, from, true);
    },
  };
  const machine = (e: Engine, c: Card) => isMonster(e, c) && info(e, c).race === 'Machine';
  E['Cosmos Channelling'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    ...stEffect(
      'Cosmos Channelling',
      '',
      (e, _c, p) => e.monsters(p).some((m) => m.owner !== p) && summonable(e, [...e.player(p).hand, ...e.player(p).gy], (c) => machine(e, c)).length > 0,
      function* (e, _c, p) {
        const m = yield* pickOne(e, p, 'Cosmos Channelling: send which monster to the GY?', e.monsters(p).filter((m) => m.owner !== p), true);
        if (!m) return;
        yield* e.sendToGrave(m.uid, 'cost');
        yield* summonOneOf(e, p, 'Cosmos Channelling: Special Summon which Machine?', summonable(e, [...e.player(p).hand, ...e.player(p).gy], (c) => machine(e, c)));
      },
      false,
    ),
  };
  E['Counter Cleaner'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).lp > 500 && [...allMonsters(e), ...allST(e)].some((c) => c.counters > 0),
    *activate(_e, _l, p) {
      if (!payLp(_e, p, 500)) return false;
    },
    *resolve(e) {
      for (const c of [...allMonsters(e), ...allST(e)]) c.counters = 0;
      e.log(null, 'All counters are removed from the field');
    },
  };
  E['Couple of Aces'] = {
    handIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Couple of Aces', p) && freeMZ(e, p) && freeMZ(e, other(p)),
      *run(e, c, p) {
        e.useOnce('Couple of Aces', p);
        const heads = e.roll(2) === 1;
        e.log(p, `Couple of Aces: ${heads ? 'Heads' : 'Tails'}`);
        const side = heads ? p : other(p);
        if (!freeMZ(e, side)) return;
        yield* e.specialSummon(c.uid, side, 'atk');
        const q = e.controller(c.uid);
        if (q !== null && inZone(e, c.uid, 'mz')) e.draw(q, 2);
      },
    },
  };
  const knights = ["Queen's Knight", "King's Knight", "Jack's Knight"];
  E['Court of Cards'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    ...(() => {
      const ok = (e: Engine, p: Pid) => e.monsters(p).every((m) => m.faceUp && knights.includes(m.name));
      const ssList = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.player(p).gy].filter((c) => knights.includes(c.name));
      const fx = stEffect(
        'Court of Cards',
        'Special Summon or banish Knights',
        (e, _c, p) => e.oncePerTurn('Court of Cards', p) && ((ok(e, p) && freeMZ(e, p) && ssList(e, p).length > 0) || (ssList(e, p).length > 0 && e.player(p).deck.length > 0)),
        function* (e, _c, p) {
          const opts = [...(ok(e, p) && freeMZ(e, p) && ssList(e, p).length ? ['Special Summon a Knight from your hand or GY'] : []), ...(ssList(e, p).length && e.player(p).deck.length ? ['Banish Knights to draw'] : [])];
          const ch = yield* chooseOption(e, p, 'Court of Cards: which effect?', opts, true);
          if (ch === null) return;
          e.useOnce('Court of Cards', p);
          if (opts[ch].startsWith('Special')) {
            yield* summonOneOf(e, p, 'Court of Cards: Special Summon which Knight?', ssList(e, p));
            return;
          }
          const chosen = yield* pick(e, p, 'Court of Cards: banish up to 1 each Queen\'s, King\'s, Jack\'s Knight', ssList(e, p), 1, 3);
          const uniq: Card[] = [];
          for (const c of chosen ?? []) if (!uniq.some((u) => u.name === c.name)) uniq.push(c);
          for (const c of uniq) e.banish(c.uid);
          if (uniq.length) e.draw(p, uniq.length);
        },
      );
      return fx;
    })(),
  };
  E['Covering Fire'] = {
    canActivate: (e, _c, p, t, ctx) => {
      if (opponentAttack(e, p, t, ctx) === null || ctx.targetUid === undefined) return false;
      const tg = e.fieldCard(ctx.targetUid);
      return !!tg && tg.faceUp && ctrl(e, tg) === p && targetable(e, e.monsters(p).filter((m) => m.faceUp && m.uid !== tg.uid)).length > 0;
    },
    *activate(e, link, p, ctx) {
      const m = yield* pickOne(e, p, 'Covering Fire: target which other monster?', targetable(e, e.monsters(p).filter((m) => m.faceUp && m.uid !== ctx.targetUid)), true);
      if (!m) return false;
      link.targetUid = m.uid;
      link.payload = ctx.targetUid;
    },
    *resolve(e, link) {
      const helper = target(e, link);
      const def = e.fieldCard(link.payload as number);
      if (helper?.faceUp && def?.faceUp && e.state.battle?.target === def.uid) boostTurn(def, e.atkOf(helper));
    },
  };
  /** Swaps control of two monsters on opposite sides. */
  const swap = (e: Engine, a: FieldCard, b: FieldCard) => {
    const fa = e.find(a.uid);
    const fb = e.find(b.uid);
    if (!fa || !fb || fa.loc.zone !== 'mz' || fb.loc.zone !== 'mz' || fa.loc.player === fb.loc.player) return false;
    e.player(fa.loc.player).mz[fa.loc.index] = b;
    e.player(fb.loc.player).mz[fb.loc.index] = a;
    a.posChanged = b.posChanged = true;
    e.event('summon', { uid: a.uid, player: fb.loc.player });
    e.log(null, `${a.faceUp ? a.name : 'A face-down monster'} and ${b.faceUp ? b.name : 'a face-down monster'} switch sides`);
    return true;
  };
  const normalUp = (e: Engine, p: Pid) => e.monsters(p).filter((m) => m.faceUp && info(e, m).sub === 'Normal' && isMonster(e, m));
  E['Creature Seizure'] = {
    canActivate: (e, _c, p, t) => isMain(t) && normalUp(e, p).length > 0 && normalUp(e, other(p)).length > 0,
    *resolve(e, _l, p) {
      const a = yield* pickOne(e, p, 'Creature Seizure: give which Normal Monster to your opponent?', normalUp(e, p));
      const b = yield* pickOne(e, other(p), 'Creature Seizure: give which Normal Monster to your opponent?', normalUp(e, other(p)));
      if (a && b) swap(e, a, b);
    },
  };
  E['Creature Swap'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.monsters(p).length > 0 && e.monsters(other(p)).length > 0,
    *resolve(e, _l, p) {
      const a = yield* pickOne(e, p, 'Creature Swap: give which monster to your opponent?', e.monsters(p), false);
      const b = yield* pickOne(e, other(p), 'Creature Swap: give which monster to your opponent?', e.monsters(other(p)), false);
      if (a && b && swap(e, a, b)) for (const m of [a, b]) tag(m).lockPosTurn = e.state.turn;
    },
  };
  E['Creeping Darkness'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).gy.filter((c) => darkMon(e, c)).length >= 2 && e.player(p).deck.some((c) => darkMon(e, c) && levelOf(e, c) === 4),
    *activate(e, _l, p) {
      const two = yield* pick(e, p, 'Creeping Darkness: banish 2 DARK monsters from your GY', e.player(p).gy.filter((c) => darkMon(e, c)), 2, 2, true);
      if (!two) return false;
      for (const c of two) e.banish(c.uid);
    },
    *resolve(e, _l, p) {
      yield* searchDeck(e, p, 'Creeping Darkness: add which Level 4 DARK monster?', (c) => darkMon(e, c) && levelOf(e, c) === 4);
    },
  };
  // Cross Keeper: send itself (hand or field) to Special Summon an Elemental HERO / Neo-Spacian; GY trigger on an E-HERO Fusion Summon.
  const heroOrNeo = (c: Card) => named(c, 'Elemental HERO') || named(c, 'Neo-Spacian');
  const keeperList = (e: Engine, p: Pid, self: number) => summonable(e, [...e.player(p).hand, ...e.player(p).gy], (c) => c.uid !== self && heroOrNeo(c));
  function* keeperRun(e: Engine, c: Card, p: Pid): Step {
    if (!keeperList(e, p, c.uid).length) return;
    e.useOnce('Cross Keeper:1', p);
    yield* e.sendToGrave(c.uid, 'cost');
    const t = yield* pickOne(e, p, 'Cross Keeper: Special Summon which monster?', keeperList(e, p, c.uid));
    if (!t || !freeMZ(e, p)) return;
    const fromGy = inZone(e, t.uid, 'gy');
    yield* e.specialSummon(t.uid, p, 'atk');
    const m = e.fieldCard(t.uid);
    if (m && fromGy) negateMonster(e, m, false);
  }
  E['Cross Keeper'] = {
    handIgnition: {
      can: (e, c, p) => e.oncePerTurn('Cross Keeper:1', p) && freeMZ(e, p) && keeperList(e, p, c.uid).length > 0,
      run: keeperRun,
    },
    ignition: {
      can: (e, m, p) => e.oncePerTurn('Cross Keeper:1', p) && keeperList(e, p, m.uid).length > 0,
      run: keeperRun,
    },
    quick: {
      from: 'gy',
      label: 'banish it to draw 2',
      can: (e, _c, p, t, ctx) => {
        if (t !== 'special' || ctx.uid === undefined || !e.oncePerTurn('Cross Keeper:2', p) || e.player(p).deck.length < 2) return false;
        const m = e.fieldCard(ctx.uid);
        return !!m && ctrl(e, m) === p && named(m, 'Elemental HERO') && info(e, m).sub === 'Fusion';
      },
      *cost(e, c, p) {
        e.useOnce('Cross Keeper:2', p);
        e.banish(c.uid);
      },
      *run(e, _c, p) {
        if (!e.draw(p, 2)) return;
        const c = yield* pickOne(e, p, 'Cross Keeper: place which card on the bottom of your Deck?', e.player(p).hand);
        if (c) toBottom(e, c.uid);
      },
    },
  };
  E['Cross Porter'] = {
    ignition: {
      can: (e, _m, p) => e.player(p).hand.some((c) => neoSpacian(e, c)),
      *run(e, _m, p) {
        const m = yield* pickOne(e, p, 'Cross Porter: send which monster you control to the GY?', e.monsters(p), true);
        if (!m) return;
        yield* e.sendToGrave(m.uid, 'cost');
        yield* summonOneOf(e, p, 'Cross Porter: Special Summon which Neo-Spacian?', e.player(p).hand.filter((c) => neoSpacian(e, c)));
      },
    },
    *onSentToGrave(e, _c, p) {
      if (e.player(p).deck.some((c) => neoSpacian(e, c)) && (yield* e.yesno(p, 'Cross Porter: add a Neo-Spacian from your Deck?'))) yield* searchDeck(e, p, 'Cross Porter: add which Neo-Spacian?', (c) => neoSpacian(e, c));
    },
  };
  E['Cross-Sword Beetle'] = {
    piercing: (e, m) => e.monsters(ctrl(e, m)).some((x) => x.uid !== m.uid && x.faceUp && e.raceOf(x) === 'Insect'),
  };
  const spellcaster = (e: Engine, c: Card) => isMonster(e, c) && raceIs(e, c, 'Spellcaster');
  E['Crowley, the Magistus of Grimoires'] = {
    handIgnition: {
      can: (e, c, p) => e.oncePerTurn('Crowley:1', p) && [...e.player(p).hand.filter((x) => x.uid !== c.uid), ...e.monsters(p).filter((m) => m.faceUp)].some((x) => spellcaster(e, x)) && (freeMZ(e, p) || e.monsters(p).some((m) => m.faceUp && spellcaster(e, m))),
      *run(e, c, p) {
        const list = [...e.player(p).hand.filter((x) => x.uid !== c.uid), ...e.monsters(p).filter((m) => m.faceUp)].filter((x) => spellcaster(e, x) && ('pos' in x || freeMZ(e, p)));
        const cost = yield* pickOne(e, p, 'Crowley: send which Spellcaster to the GY?', list, true);
        if (!cost) return;
        e.useOnce('Crowley:1', p);
        yield* e.sendToGrave(cost.uid, 'cost');
        if (inZone(e, c.uid, 'hand')) yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
    graveIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Crowley:3', p) && freeST(e, p) >= 0 && targetable(e, e.monsters(p).filter((m) => m.faceUp && named(m, 'Magistus'))).length > 0 && e.player(p).gy.some((c) => named(c, 'Magistus') && isMonster(e, c) && levelOf(e, c) !== 4),
      *run(e, card, p) {
        const host = yield* pickOne(e, p, 'Crowley: target which Magistus monster?', targetable(e, e.monsters(p).filter((m) => m.faceUp && named(m, 'Magistus'))), true);
        if (!host) return;
        e.useOnce('Crowley:3', p);
        e.banish(card.uid);
        const eq = yield* pickOne(e, p, 'Crowley: equip which Magistus monster from your GY?', e.player(p).gy.filter((c) => named(c, 'Magistus') && isMonster(e, c) && levelOf(e, c) !== 4));
        if (eq && e.fieldCard(host.uid) && placeST(e, eq.uid, p, host.uid)) e.log(p, `${eq.name} is equipped to ${host.name}`);
      },
    },
  };
  E['Crystal Shark'] = (() => {
    const targets = (e: Engine) => targetable(e, faceUpMonsters(e)).filter((m) => attrOf(e, m) === 'WATER');
    const can = (e: Engine, p: Pid) => e.oncePerTurn('Crystal Shark', p) && freeMZ(e, p) && targets(e).length > 0;
    const run = function* (e: Engine, c: Card, p: Pid): Step {
      const t = yield* pickOne(e, p, 'Crystal Shark: target which WATER monster?', targets(e), true);
      if (!t) return;
      e.useOnce('Crystal Shark', p);
      yield* e.specialSummon(c.uid, p, 'atk');
      if (!inZone(e, c.uid, 'mz')) return;
      markBanish(e, c.uid);
      const tt = e.fieldCard(t.uid);
      if (tt?.faceUp) boostPerm(tt, -Math.floor(e.atkOf(tt) / 2));
    };
    return {
      handIgnition: { can: (e, _c, p) => can(e, p), run },
      graveIgnition: { can: (e, _c, p) => can(e, p), run },
      *onSentToGrave(e, card, _o, from) {
        banishIfMarked(e, card, from);
      },
    } as EffectDef;
  })();
  E['Crystron Smiger'] = {
    ignition: {
      can: (e, _m, p) => e.oncePerTurn('Crystron Smiger', p) && e.player(p).deck.some((c) => named(c, 'Crystron') && isMonster(e, c)),
      *run(e, m, p) {
        const list = [...e.monsters(p).filter((x) => x.faceUp && !e.untargetable(x)), ...stCards(e, p).filter((c) => c.faceUp)];
        const t = yield* pickOne(e, p, 'Crystron Smiger: destroy which face-up card you control?', list, true);
        if (!t) return;
        e.useOnce('Crystron Smiger', p);
        yield* e.destroy([t.uid]);
        if (e.fieldCard(t.uid) || !freeMZ(e, p)) return;
        yield* summonOneOf(e, p, 'Crystron Smiger: Special Summon which Crystron monster?', summonable(e, e.player(p).deck, (c) => named(c, 'Crystron')));
      },
    },
    graveIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Crystron Smiger', p) && e.player(p).deck.some((c) => named(c, 'Crystron') && !isMonster(e, c)),
      *run(e, card, p) {
        e.useOnce('Crystron Smiger', p);
        e.banish(card.uid);
        yield* searchDeck(e, p, 'Crystron Smiger: add which Crystron Spell/Trap?', (c) => named(c, 'Crystron') && !isMonster(e, c));
      },
    },
  };
  E['Cup of Ace'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).deck.length >= 2,
    *resolve(e, _l, p) {
      const heads = e.roll(2) === 1;
      e.log(p, `Cup of Ace: ${heads ? 'Heads' : 'Tails'}`);
      e.draw(heads ? p : other(p), 2);
    },
  };
  E['Cupid Fore'] = {
    summonProc: {
      can: (e, _c, p) => e.oncePerTurn('Cupid Fore', p) && freeMZ(e, p) && e.monsters(p).length > 0 && e.monsters(p).every((m) => m.faceUp && e.defOf(m) === 600),
      *run(e, c, p) {
        e.useOnce('Cupid Fore', p);
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
  };
  E['Curse of Aging'] = {
    canActivate: (e, c, p, t) => anyTime(t) && e.monsters(other(p)).some((m) => m.faceUp) && e.player(p).hand.some((x) => x.uid !== c.uid),
    *activate(e, _l, p) {
      if (!(yield* discardCost(e, p, 1))) return false;
    },
    *resolve(e, _l, p) {
      for (const m of e.monsters(other(p))) boostTurn(m, -500, -500);
    },
  };
  const effectMon = (e: Engine, m: FieldCard) => {
    const i = info(e, m);
    return i.kind === 'monster' && (i.sub === 'Effect' || ((i.sub === 'Fusion' || i.sub === 'Ritual') && !i.vanilla));
  };
  E['Curse of Anubis'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && faceUpMonsters(e).some((m) => effectMon(e, m)),
    *resolve(e) {
      for (const m of faceUpMonsters(e).filter((m) => effectMon(e, m))) {
        if (m.pos !== 'def') {
          m.pos = 'def';
          e.event('position', { uid: m.uid });
        }
        m.defMod -= e.baseStats(m).def;
        tag(m).lockPosTurn = e.state.turn;
      }
    },
  };
  const eldOrGolden = (e: Engine, c: Card) => (named(c, 'Eldlich') && isMonster(e, c)) || (named(c, 'Golden Land') && !isMonster(e, c));
  E['Cursed Eldland'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    blocksAttack: (e, card, m, attacker) => attacker === ctrl(e, card) && e.raceOf(m) !== 'Zombie',
    ...stEffect(
      'Cursed Eldland:1',
      '',
      (e, _c, p) => e.player(p).lp > 800 && e.player(p).deck.some((c) => eldOrGolden(e, c)),
      function* (e, _c, p) {
        if (!payLp(e, p, 800)) return;
        yield* searchDeck(e, p, 'Cursed Eldland: add which card?', (c) => eldOrGolden(e, c));
      },
      false,
    ),
    *onSentToGrave(e, _c, p, from) {
      if (from !== 'sz' || !e.oncePerTurn('Cursed Eldland:2', p) || !e.player(p).deck.some((c) => eldOrGolden(e, c))) return;
      if (!(yield* e.yesno(p, 'Cursed Eldland: send an Eldlich monster or Golden Land Spell/Trap from your Deck to the GY?'))) return;
      e.useOnce('Cursed Eldland:2', p);
      yield* deckToGrave(e, p, 'Cursed Eldland: send which card?', (c) => eldOrGolden(e, c));
    },
  };
  E['Cursed Seal of the Forbidden Spell'] = {
    canActivate: (e, c, p, t, ctx) => t === 'spell' && !!ctx.link && !ctx.link.negated && isSpell(e, ctx.link.card) && e.player(p).hand.some((x) => x.uid !== c.uid && isSpell(e, x)),
    *activate(e, link, p, ctx) {
      if (!(yield* discardCost(e, p, 1, (c) => isSpell(e, c)))) return false;
      link.payload = { target: ctx.link };
    },
    *resolve(e, link, p) {
      const t = (link.payload as { target?: ChainLink }).target;
      if (!t) return;
      negateLink(e, t, p);
      if (e.fieldCard(t.card.uid)) yield* e.destroy([t.card.uid]);
    },
  };
}
