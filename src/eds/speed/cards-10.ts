// Speed Duel card scripts, batch 10 (Talisman of Trap Sealing ... Zombyra the Dark).
import type { EffectDef } from '../effects';
import type { SpeedHelpers } from './helpers';
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
  label,
  levelOf,
  named,
  negateLink,
  negateMonster,
  noBattleDamage,
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
  tributeCost,
  boostPerm,
  boostTurn,
} from './helpers';
import type { Card, ChainLink, Choice, Engine, FieldCard, Pid, Pos, Prompt, Step } from './helpers';

// ---------- local helpers ----------
const freeMZCount = (e: Engine, p: Pid) => e.player(p).mz.filter((z) => z === null).length;
const umi = (e: Engine) => !!(e.anyActive('Umi') || e.anyActive('A Legendary Ocean'));
const TOON_MONSTERS = new Set(['Manga Ryu-Ran', 'Toon Mermaid', 'Toon Summoned Skull', 'Blue-Eyes Toon Dragon', 'Toon Ancient Gear Golem', 'Toon Barrel Dragon', 'Toon Buster Blader', 'Toon Dark Magician', 'Toon Gemini Elf', 'Toon Masked Sorcerer']);
const isToonMonster = (c: Card | string) => TOON_MONSTERS.has(typeof c === 'string' ? c : c.name);
/** A "Toon" card: a Toon monster or a card with "Toon" in its name. */
const isToonCard = (c: Card) => isToonMonster(c) || named(c, 'Toon');
const isVampire = (c: Card) => named(c, 'Vampire');
/** Monster Types, so a Type can be kept in a numeric tag. */
const RACES = ['Aqua', 'Beast', 'Beast-Warrior', 'Creator-God', 'Cyberse', 'Dinosaur', 'Divine-Beast', 'Dragon', 'Fairy', 'Fiend', 'Fish', 'Insect', 'Machine', 'Plant', 'Psychic', 'Pyro', 'Reptile', 'Rock', 'Sea Serpent', 'Spellcaster', 'Thunder', 'Warrior', 'Winged Beast', 'Wyrm', 'Zombie', 'Illusion'];
const randomOf = <T>(e: Engine, list: T[]): T | undefined => (list.length ? list[Math.floor(e.rand() * list.length)] : undefined);
const fieldTarget = (e: Engine, link: ChainLink) => (link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null);

/**
 * "Must be Special Summoned by ...": Special Summons only through its own procedure (fx.procSS), an effect that ignores
 * Summoning conditions (fx.ignoreCond is honoured by the engine), or `also` (Bonding cards). With `revive`, it can come back
 * from the GY or banishment (approximation: the engine does not remember whether it was properly Summoned before).
 */
const mustBeSummoned = (revive: boolean, also?: (e: Engine, c: Card) => boolean): EffectDef['summonRule'] => (e, c, _p, how, from) =>
  how !== 'special' || e.state.fx.procSS === c.uid || (revive && (from === 'gy' || from === 'removed')) || !!also?.(e, c);
/** Special Summons a card ignoring its Summoning conditions (Toon Dark Magician, Water Dragon Cluster). */
function* ignoringConditions(e: Engine, uid: number, step: Step): Step {
  const prev = e.state.fx.ignoreCond;
  e.state.fx.ignoreCond = uid;
  try {
    yield* step;
  } finally {
    e.state.fx.ignoreCond = prev;
  }
}
/** Level of a monster, or its Rank for an Xyz Monster (Toon Mask). */
const levelOrRank = (e: Engine, m: Card) => levelOf(e, m) || (info(e, m).rank ?? 0);
/** Who moved this card off the field: the player whose card effect did it (-1: a game action such as battle, or unknown). */
const leftBy = (fc: FieldCard): number => (fc.tags?.leftBy as number | undefined) ?? -1;

/** "You cannot declare an attack this turn": tags the player's monsters (and Volcanic Doomfire checks the flag). */
function noAttacksThisTurn(e: Engine, p: Pid) {
  ((e.state.fx.noDeclare ??= [-1, -1]) as number[])[p] = e.state.turn;
  for (const m of e.monsters(p)) tag(m).noAttackTurn = e.state.turn;
}
const noAttackPlayer = (e: Engine, p: Pid) => ((e.state.fx.noDeclare ?? [-1, -1]) as number[])[p] === e.state.turn;

/** Runs a step that never asks anything, synchronously (used inside non-generator hooks). */
function runSync(g: Step) {
  let r = g.next(undefined as never);
  for (let i = 0; !r.done && i < 20; i++) r = g.next(false);
}

/** Takes a card out of its hand/Deck/GY/banished pile without any side effects. */
function lift(e: Engine, uid: number): Card | null {
  const f = e.find(uid);
  if (!f || !['hand', 'deck', 'gy', 'removed'].includes(f.loc.zone)) return null;
  const ps = e.player(f.loc.player);
  const arr = (f.loc.zone === 'removed' ? ps.removed : ps[f.loc.zone as 'hand' | 'deck' | 'gy']) as Card[];
  arr.splice(f.loc.index, 1);
  return f.card;
}

/** Places a card from the hand/Deck/GY into a free Spell & Trap Zone of `p` (face-up and active, or Set). */
function placeST(e: Engine, uid: number, p: Pid, faceUp: boolean): FieldCard | null {
  const zone = freeST(e, p);
  if (zone < 0) return null;
  const c = lift(e, uid);
  if (!c) return null;
  const fc: FieldCard = { uid: c.uid, name: c.name, owner: c.owner, pos: 'atk', faceUp, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: faceUp };
  e.player(p).sz[zone] = fc;
  e.event(faceUp ? 'activate' : 'set', { uid: c.uid, player: p });
  return fc;
}

/** Equips a card from the hand/Deck/GY to a monster (Truckroid, Union Hangar). */
function equipFromPile(e: Engine, uid: number, host: FieldCard, p: Pid): FieldCard | null {
  const fc = placeST(e, uid, p, true);
  if (!fc) return null;
  fc.equippedTo = host.uid;
  host.equips.push(fc.uid);
  return fc;
}

/** "Destroyed by battle or by your opponent's card": remembers who sent this card away. */
const markLeave: EffectDef['onLeaveField'] = function* (e, fc, controller) {
  ((e.state.fx.leftByOpp ??= {}) as Record<number, number>)[fc.uid] = e.actor === other(controller) && fc.owner === controller ? e.state.turn : -1;
};
const leftByOpp = (e: Engine, uid: number) => ((e.state.fx.leftByOpp ?? {}) as Record<number, number>)[uid] === e.state.turn;

/** Destroyed an opponent's monster by battle (as attacker via afterBattle, as defender via onAttacked). */
function onBattleKill(run: (e: Engine, me: FieldCard, victim: FieldCard, p: Pid) => Step): Partial<EffectDef> {
  return {
    *afterBattle(e, attacker, target, p, destroyed) {
      if (destroyed && target && e.fieldCard(attacker.uid)) yield* run(e, attacker, target, p);
    },
    *onAttacked(e, target, attacker, p) {
      if (!e.fieldCard(attacker.uid) && e.fieldCard(target.uid)) yield* run(e, target, attacker, p);
    },
  };
}

/** A Continuous Spell: "Once per turn: you can Special Summon 1 monster from your hand. You must control no monsters" (Valhalla, Water Hazard). */
function emptyFieldSummoner(test: (e: Engine, c: Card) => boolean): EffectDef {
  const can = (e: Engine, m: FieldCard, p: Pid) => e.oncePerTurn(`esum:${m.uid}`, p) && e.monsters(p).length === 0 && e.player(p).hand.some((c) => isMonster(e, c) && test(e, c));
  return {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    ignition: {
      repeat: true,
      can,
      *run(e, m, p) {
        e.useOnce(`esum:${m.uid}`, p);
        if (e.monsters(p).length) return;
        yield* summonOneOf(e, p, `${m.name}: Special Summon which monster?`, e.player(p).hand.filter((c) => isMonster(e, c) && test(e, c)), 'atk', true);
      },
    },
  };
}

/** Declare a card type; the opponent sends 1 card of that type from their Deck to the GY (Vampire Lady, Vampire Lord). */
function* declareMill(e: Engine, p: Pid): Step {
  const kinds = ['monster', 'spell', 'trap'] as const;
  const i = yield* chooseOption(e, p, 'Declare a card type', ['Monster', 'Spell', 'Trap']);
  if (i === null) return;
  const opp = other(p);
  e.log(p, `${e.player(p).name} declares ${['Monster', 'Spell', 'Trap'][i]}`);
  const c = yield* pickOne(e, opp, 'Send which card from your Deck to the GY?', e.player(opp).deck.filter((x) => info(e, x).kind === kinds[i]));
  if (!c) return;
  yield* e.sendToGrave(c.uid, 'mill');
  e.player(opp).deck = e.shuffle(e.player(opp).deck);
}

/** "Discard 1 card, then target ...; destroy it" ignition effects of the Cannon fusions (no once-per-turn limit; the discard is the cost). */
function cannonEffect(title: string, targets: (e: Engine, p: Pid) => FieldCard[]) {
  return {
    can: (e: Engine, _m: FieldCard, p: Pid) => e.player(p).hand.length > 0 && targets(e, p).length > 0,
    *cost(e: Engine, _m: FieldCard, p: Pid): Generator<Prompt, boolean, Choice> {
      return yield* discardCost(e, p, 1);
    },
    *run(e: Engine, _m: FieldCard, p: Pid): Step {
      const t = yield* pickOne(e, p, title, targets(e, p));
      if (t) yield* e.destroy([t.uid]);
    },
  };
}

// ---------- Union monsters and the contact Fusions (V/W/X/Y/Z) ----------
const UNION_HOSTS: Record<string, string[]> = {
  'W-Wing Catapult': ['V-Tiger Jet'],
  'Y-Dragon Head': ['X-Head Cannon'],
  'Z-Metal Tank': ['X-Head Cannon', 'Y-Dragon Head'],
  'Zombie Tiger': ['Decayed Commander'],
};
const LIGHT_MACHINE_UNIONS = ['W-Wing Catapult', 'Y-Dragon Head', 'Z-Metal Tank'];
const CONTACT: Record<string, string[]> = {
  'VW-Tiger Catapult': ['V-Tiger Jet', 'W-Wing Catapult'],
  'XY-Dragon Cannon': ['X-Head Cannon', 'Y-Dragon Head'],
  'XZ-Tank Cannon': ['X-Head Cannon', 'Z-Metal Tank'],
  'YZ-Tank Dragon': ['Y-Dragon Head', 'Z-Metal Tank'],
  'XYZ-Dragon Cannon': ['X-Head Cannon', 'Y-Dragon Head', 'Z-Metal Tank'],
  'VWXYZ-Dragon Catapult Cannon': ['VW-Tiger Catapult', 'XYZ-Dragon Cannon'],
};
const hasUnion = (e: Engine, host: FieldCard) => host.equips.some((u) => e.fieldCard(u)?.tags?.union);
const unionHosts = (e: Engine, m: FieldCard, p: Pid) => targetable(e, e.monsters(p).filter((h) => h.faceUp && h.uid !== m.uid && UNION_HOSTS[m.name].includes(h.name) && !hasUnion(e, h)));
const inZone = (e: Engine, m: Card, zone: string) => e.find(m.uid)?.loc.zone === zone;

/** The materials a Contact Fusion can banish now: one monster you control per listed name (null if some are missing). */
function contactMats(e: Engine, p: Pid, f: Card): string[] | null {
  const mats = CONTACT[f.name];
  if (!mats) return null;
  const mine = e.monsters(p);
  return matchMats(mine, mats) ? mats : null;
}
/**
 * "Must first be Special Summoned (from your Extra Deck) by banishing the above cards you control": the Summon procedure
 * from the Extra Deck (no "Polymerization"). `fromGy`: whether it may be Special Summoned from the GY once on the field.
 */
function contactFusion(fromGy: boolean): Partial<EffectDef> {
  return {
    cannotNormalSummon: true,
    summonRule: (e, c, _p, how, from) => how !== 'special' || e.state.fx.procSS === c.uid || from === 'removed' || (fromGy && from === 'gy'),
    extraProc: {
      can: (e, c, p) => !!contactMats(e, p, c),
      *run(e, f, p) {
        const mats = contactMats(e, p, f);
        if (!mats) return;
        const chosen: FieldCard[] = [];
        for (const n of mats) {
          const c = yield* pickOne(e, p, `${f.name}: banish which ${n}?`, e.monsters(p).filter((x) => x.name === n && !chosen.includes(x)), true);
          if (!c) return;
          chosen.push(c);
        }
        for (const c of chosen) e.banish(c.uid);
        if (e.find(f.uid)?.loc.zone !== 'fusion' || !freeMZ(e, p)) return;
        yield* e.specialSummon(f.uid, p, 'atk');
        if (e.fieldCard(f.uid)) e.log(p, `${e.player(p).name} Special Summons ${f.name} by banishing its materials!`);
      },
    },
  };
}

/** A Union monster: once per turn equip to a named host or unequip and Special Summon; substitutes for the host's destruction. */
function union(atk: number, def: number, effectToo: boolean, pos: Pos = 'atk', extra: Partial<EffectDef> = {}): EffectDef {
  const unionReady = (e: Engine, m: FieldCard, p: Pid) => {
    if (!e.oncePerTurn(`union:${m.uid}`, p)) return false;
    if (inZone(e, m, 'mz')) return freeST(e, p) >= 0 && unionHosts(e, m, p).length > 0;
    return inZone(e, m, 'sz') && !!m.tags?.union && freeMZ(e, p) && m.tags?.noSS !== e.state.turn;
  };
  return {
    ignition: {
      repeat: true,
      can: (e, m, p) => unionReady(e, m, p),
      *run(e, m, p) {
        if (!unionReady(e, m, p)) return;
        e.useOnce(`union:${m.uid}`, p);
        if (inZone(e, m, 'mz')) {
          const host = yield* pickOne(e, p, `${m.name}: equip to which monster?`, unionHosts(e, m, p));
          const ps = e.player(p);
          const mi = ps.mz.indexOf(m);
          const zone = freeST(e, p);
          if (!host || mi < 0 || zone < 0) return;
          for (const u of m.equips.slice()) yield* e.sendToGrave(u, 'used');
          e.vacateMZ(ps, mi);
          Object.assign(m, { faceUp: true, pos: 'atk', active: true, equippedTo: host.uid, equips: [], placedTurn: e.state.turn, atkMod: 0, defMod: 0, tags: { union: 1 } });
          ps.sz[zone] = m;
          host.equips.push(m.uid);
          e.event('activate', { uid: m.uid, player: p });
          e.log(p, `${m.name} is equipped to ${host.name}`);
        } else {
          const host = m.equippedTo !== undefined ? e.fieldCard(m.equippedTo) : null;
          if (host) host.equips = host.equips.filter((u) => u !== m.uid);
          m.equippedTo = undefined;
          yield* e.specialSummon(m.uid, p, pos);
        }
      },
    },
    equipBonus: (_e, eq) => (eq.tags?.union ? { atk, def } : { atk: 0, def: 0 }),
    shields(e, src, target, how) {
      if (how === 'target' || (how === 'effect' && !effectToo) || !src.tags?.union || src.equippedTo !== target.uid || !e.fieldCard(src.uid)) return false;
      e.log(null, `${src.name} is destroyed instead of ${target.name}`);
      runSync(e.sendToGrave(src.uid, 'destroyed'));
      return true;
    },
    ...extra,
  };
}

/** Fusion Summon from the hand/field, limited to some Fusion Monsters (Vehicroid Connection Zone). Materials: every quoted name on the first line. */
function matsOf(e: Engine, name: string): string[] {
  const line = info(e, name).desc.split('\n')[0];
  return [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}
function matchMats(pool: Card[], names: string[], used: number[] = []): boolean {
  if (!names.length) return true;
  return pool.some((c) => c.name === names[0] && !used.includes(c.uid) && matchMats(pool, names.slice(1), [...used, c.uid]));
}
const fusionPool = (e: Engine, p: Pid) => [...e.player(p).hand.filter((c) => isMonster(e, c)), ...e.monsters(p)];
const fusable = (e: Engine, p: Pid, test: (n: string) => boolean) => e.player(p).fusion.filter((f) => test(f.name) && matchMats(fusionPool(e, p), matsOf(e, f.name)));

export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  E['The Beginning of the End'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).deck.length >= 3 && e.player(p).gy.filter((c) => isMonster(e, c) && attrOf(e, c) === 'DARK').length >= 7,
    *activate(e, link, p) {
      const list = e.player(p).gy.filter((c) => isMonster(e, c) && attrOf(e, c) === 'DARK');
      const chosen = yield* pick(e, p, 'Banish 5 DARK monsters from your GY', list, 5, 5, true);
      if (!chosen || chosen.length < 5) return false;
      for (const c of chosen) e.banish(c.uid);
    },
    *resolve(e, _l, p) {
      e.draw(p, 3);
    },
  };

  E['The Big March of Animals'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && faceUpMonsters(e, p).some((m) => raceOf(e, m) === 'Beast'),
    *resolve(e, _l, p) {
      const beasts = faceUpMonsters(e, p).filter((m) => raceOf(e, m) === 'Beast');
      for (const m of beasts) boostTurn(m, 200 * beasts.length);
      e.log(p, `Beasts gain ${200 * beasts.length} ATK`);
    },
  };

  E['The Fiend Megacyber'] = {
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && e.monsters(other(p)).length >= e.monsters(p).length + 2,
      *run(e, c, p) {
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
  };

  // ----- The Sarcophagus set -----
  const SARCO = ['The First Sarcophagus', 'The Second Sarcophagus', 'The Third Sarcophagus'];
  const sarcoLeaves: EffectDef['onLeaveField'] = function* (e, _fc, p) {
    for (const c of e.spells(p).filter((s) => SARCO.includes(s.name) && s.faceUp)) if (e.fieldCard(c.uid)) yield* e.sendToGrave(c.uid, 'used');
  };
  E['The First Sarcophagus'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    *onEndPhase(e, fc, p) {
      if (e.state.turnPlayer === p) return;
      const ps = e.player(p);
      const onField = (n: string) => e.spells(p).some((s) => s.name === n && s.faceUp);
      const next = !onField('The Second Sarcophagus') ? 'The Second Sarcophagus' : !onField('The Third Sarcophagus') ? 'The Third Sarcophagus' : null;
      if (next) {
        const c = [...ps.hand, ...ps.deck].find((x) => x.name === next);
        const fromDeck = c && e.find(c.uid)?.loc.zone === 'deck';
        if (c && placeST(e, c.uid, p, true)) {
          e.log(p, `${ps.name} places ${next} on the field`);
          if (fromDeck) ps.deck = e.shuffle(ps.deck);
        }
      }
      if (!SARCO.every(onField) || !e.fieldCard(fc.uid)) return;
      e.log(p, 'All three Sarcophagi are assembled!');
      for (const s of e.spells(p).filter((x) => SARCO.includes(x.name))) if (e.fieldCard(s.uid)) yield* e.sendToGrave(s.uid, 'used');
      const spirits = [...ps.hand, ...ps.deck].filter((x) => x.name === 'Spirit of the Pharaoh');
      const sp = yield* pickOne(e, p, 'Special Summon which Spirit of the Pharaoh?', spirits);
      if (!sp || !freeMZ(e, p)) return;
      const fromDeck = e.find(sp.uid)?.loc.zone === 'deck';
      yield* ignoringConditions(e, sp.uid, e.specialSummon(sp.uid, p, 'atk')); // its only legal way to be Special Summoned
      if (fromDeck) ps.deck = e.shuffle(ps.deck);
    },
    onLeaveField: sarcoLeaves,
  };
  E['The Second Sarcophagus'] = { canActivate: () => false, onLeaveField: sarcoLeaves };
  E['The Third Sarcophagus'] = { canActivate: () => false, onLeaveField: sarcoLeaves };

  E['The Forceful Checkpoint'] = {
    canActivate: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null,
    *resolve(e, _l, p) {
      const opp = other(p);
      const hand = e.player(opp).hand;
      yield* e.reveal(p, "Your opponent's hand", hand.slice());
      const mons = hand.filter((c) => isMonster(e, c));
      if (!mons.length) return;
      e.log(p, 'The Forceful Checkpoint negates the attack');
      e.endBattle();
      const c = yield* pickOne(e, p, 'Discard which monster from their hand?', mons);
      if (c) yield* e.discard(opp, c.uid);
    },
  };

  E['The Fountain in the Sky'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    quick: {
      repeat: true,
      label: 'banish the LIGHT monster to gain LP',
      can: (e, _c, p, t, ctx) => {
        if (t !== 'destroyed' || ctx.uid === undefined) return false;
        const f = e.find(ctx.uid);
        return !!f && f.loc.zone === 'gy' && f.loc.player === p && attrOf(e, f.card) === 'LIGHT';
      },
      *run(e, _c, p, link) {
        const uid = (link.payload as { ctx: { uid: number } }).ctx.uid;
        const f = e.find(uid);
        if (!f || f.loc.zone !== 'gy') return;
        e.banish(uid);
        e.gainLp(p, info(e, f.card).atk ?? 0);
      },
    },
  };

  E['The Golden Apples'] = {
    canActivate: (e, _c, p, t, ctx) => t === 'damage' && ctx.damaged === p && !!e.state.battle && (ctx.amount ?? 0) > 0 && e.monsters(p).length === 0,
    *activate(e, link, _p, ctx) {
      link.payload = ctx.amount ?? 0;
    },
    *resolve(e, link, p) {
      const n = link.payload as number;
      e.gainLp(p, n);
      const tok = e.createToken('Malus Token', p, 'atk', true, { atk: 0, def: 0, level: 1, attribute: 'DARK', race: 'Fiend' });
      if (tok) boostPerm(tok, n, n);
    },
  };

  E['The Grave of Enkindling'] = {
    canActivate: (e, _c, p, t, ctx) => t === 'destroyed' && ctx.prevController === p && ctx.uid !== undefined && e.find(ctx.uid)?.loc.zone === 'gy',
    *resolve(e, _l, p) {
      for (const q of [p, other(p)] as Pid[]) {
        const list = e.player(q).gy.filter((c) => isMonster(e, c) && !isExtraOrRitual(e, c));
        const m = yield* summonOneOf(e, q, 'The Grave of Enkindling: Special Summon which monster in Defense Position?', list, 'def');
        if (m) m.cannotChangePos = true;
      }
    },
  };

  E['The King of D.'] = {
    fieldName: () => 'Lord of D.',
    *onSummon(e, _m, p, kind) {
      if (kind !== 'normal') return;
      const want = (c: Card) => ['The Flute of Summoning Dragon', 'The Melody of Awakening Dragon', 'Dragon Revival Rhapsody'].includes(c.name);
      const st = (c: Card) => isSpell(e, c) || isTrap(e, c);
      if (!e.player(p).deck.some(want) || !e.player(p).hand.some(st)) return;
      if (!(yield* e.yesno(p, 'The King of D.: discard a Spell/Trap to add a Dragon-calling Spell?'))) return;
      if (!(yield* discardCost(e, p, 1, st))) return;
      yield* searchDeck(e, p, 'Add which card?', want);
    },
  };

  const fisherman2Search = function* (e: Engine, p: Pid): Step {
    const ok = (c: Card) => isMonster(e, c) && levelOf(e, c) === 7 && attrOf(e, c) === 'WATER';
    if (!e.player(p).deck.some(ok) || !(yield* e.yesno(p, 'The Legendary Fisherman II: add a Level 7 WATER monster from your Deck?'))) return;
    yield* searchDeck(e, p, 'Add which monster?', ok);
  };
  // Its name in the GY is not changed (only on the field). "Unaffected by other monsters' effects" is modelled as: they cannot
  // target or destroy it (their stat changes still apply).
  const monsterEffectNow = (e: Engine, m: FieldCard) => umi(e) && e.resolvingKind() === 'monster' && e.resolvingCard()?.uid !== m.uid;
  E['The Legendary Fisherman II'] = {
    fieldName: () => 'The Legendary Fisherman',
    effectProof: monsterEffectNow,
    cannotBeTargeted: (e, m) => monsterEffectNow(e, m),
    *onLeaveField(e, fc, controller) {
      if (leftBy(fc) === other(controller) && fc.owner === controller && fc.faceUp) yield* e.as(controller, fisherman2Search(e, controller));
    },
    *onDestroyed(e, card, p, byBattle) {
      if (byBattle && card.owner === p) yield* fisherman2Search(e, p);
    },
  };

  E['The Mask of Remnants'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve(e, link) {
      if (e.fieldCard(link.card.uid)) toDeck(e, link.card.uid);
    },
  };

  E['The Melody of Awakening Dragon'] = (() => {
    const ok = (e: Engine, c: Card) => isMonster(e, c) && info(e, c).race === 'Dragon' && (info(e, c).atk ?? 0) >= 3000 && (info(e, c).def ?? 0) <= 2500;
    return {
      canActivate: (e, c, p, t) => isMain(t) && e.player(p).hand.some((x) => x.uid !== c.uid) && e.player(p).deck.some((x) => ok(e, x)),
      *activate(e, link, p) {
        if (!(yield* discardCost(e, p, 1, () => true, link.card.uid))) return false;
      },
      *resolve(e, _l, p) {
        const chosen = yield* pick(e, p, 'Add up to 2 Dragons to your hand', e.player(p).deck.filter((x) => ok(e, x)), 1, 2);
        for (const c of chosen ?? []) e.toHandOf(c.uid, p);
        e.player(p).deck = e.shuffle(e.player(p).deck);
      },
    } as EffectDef;
  })();

  // Subsets of your monsters whose Levels add up exactly to n.
  const sumsTo = (e: Engine, list: FieldCard[], n: number): boolean => n === 0 || list.some((m, i) => levelOf(e, m) > 0 && levelOf(e, m) <= n && sumsTo(e, list.slice(i + 1), n - levelOf(e, m)));
  const puppetTargets = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && info(e, c).race === 'Fiend' && !isExtraOrRitual(e, c) && levelOf(e, c) > 0 && sumsTo(e, e.monsters(p), levelOf(e, c)));
  E['The Puppet Magic of Dark Ruler'] = {
    canActivate: (e, _c, p, t) => isMain(t) && puppetTargets(e, p).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Select which Fiend monster in your GY?', puppetTargets(e, p), true);
      if (!c) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      const c = link.targetUid !== undefined ? e.find(link.targetUid) : null;
      if (!c || c.loc.zone !== 'gy') return;
      const lv = levelOf(e, c.card);
      if (!sumsTo(e, e.monsters(p), lv)) return;
      for (let tries = 0; tries < 5; tries++) {
        const mons = e.monsters(p);
        const chosen = yield* pick(e, p, `Banish monsters whose Levels add up to exactly ${lv}`, mons, 1, mons.length, false, false);
        if (!chosen) return;
        if (chosen.reduce((a, m) => a + levelOf(e, m), 0) !== lv) continue;
        for (const m of chosen) e.banish(m.uid);
        if (freeMZ(e, p) && e.find(c.card.uid)?.loc.zone === 'gy') yield* e.specialSummon(c.card.uid, p, 'atk');
        return;
      }
    },
  };

  E['The Rock Spirit'] = {
    cannotNormalSummon: true,
    summonRule: mustBeSummoned(true),
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && e.player(p).gy.some((c) => isMonster(e, c) && attrOf(e, c) === 'EARTH'),
      *run(e, card, p) {
        const c = yield* pickOne(e, p, 'Banish which EARTH monster from your GY?', e.player(p).gy.filter((x) => isMonster(e, x) && attrOf(e, x) === 'EARTH'), true);
        if (!c) return;
        e.banish(c.uid);
        yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
    selfBonus: (e, m) => ({ atk: e.state.phase === 'BP' && e.state.turnPlayer !== ctrl(e, m) ? 300 : 0, def: 0 }),
  };

  E['The Warrior Returning Alive'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).gy.some((c) => isMonster(e, c) && info(e, c).race === 'Warrior'),
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Add which Warrior to your hand?', e.player(p).gy.filter((x) => isMonster(e, x) && info(e, x).race === 'Warrior'), true);
      if (!c) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid !== undefined && e.find(link.targetUid)?.loc.zone === 'gy') e.toHandOf(link.targetUid, p);
    },
  };

  E['Theban Nightmare'] = {
    selfBonus: (e, m) => {
      const p = ctrl(e, m);
      return { atk: e.player(p).hand.length === 0 && e.spells(p).length === 0 ? 1500 : 0, def: 0 };
    },
  };

  E['Thestalos the Firestorm Monarch'] = {
    *onSummon(e, _m, p, kind) {
      if (kind !== 'normal') return;
      const opp = other(p);
      const c = randomOf(e, e.player(opp).hand);
      if (!c) return;
      yield* e.discard(opp, c.uid);
      if (isMonster(e, c)) e.damage(opp, levelOf(e, c) * 100);
    },
  };

  E['Thousand Knives'] = {
    canActivate: (e, _c, p, t) => isMain(t) && faceUpMonsters(e, p).some((m) => m.name === 'Dark Magician') && targetable(e, e.monsters(other(p))).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Thousand Knives: destroy which monster?', targetable(e, e.monsters(other(p))), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      if (fieldTarget(e, link)) yield* e.destroy([link.targetUid!]);
    },
  };

  // Other monsters cannot attack (blocksAttack, while it is face-up) or change position (a per-turn tag refreshed each
  // Standby Phase and on every Summon: approximation, the position lock lasts for the turn even if it leaves the field).
  const restrictOthers = (e: Engine, me: FieldCard) => {
    for (const m of allMonsters(e)) if (m.uid !== me.uid) tag(m).lockPosTurn = e.state.turn;
  };
  E['Thousand-Eyes Restrict'] = {
    *onSpecialSummon(e, m) {
      restrictOthers(e, m);
    },
    *onStandby(e, m) {
      restrictOthers(e, m);
    },
    *onAnySummon(e, w, _wp, m) {
      if (m.uid !== w.uid) tag(m).lockPosTurn = e.state.turn;
    },
    blocksAttack: (_e, src, m) => m.uid !== src.uid,
    ignition: {
      can: (e, m, p) => !(m.tags?.absorbed && e.fieldCard(m.tags.absorbed)) && freeST(e, p) >= 0 && targetable(e, e.monsters(other(p))).length > 0,
      *run(e, m, p) {
        if (m.tags?.absorbed && e.fieldCard(m.tags.absorbed)) return;
        const t = yield* pickOne(e, p, 'Thousand-Eyes Restrict: equip which monster to it?', targetable(e, e.monsters(other(p))));
        const zone = freeST(e, p);
        if (!t || zone < 0) return;
        const op = e.player(other(p));
        const mi = op.mz.indexOf(t);
        if (mi < 0) return;
        for (const u of t.equips.slice()) yield* e.sendToGrave(u, 'used');
        e.vacateMZ(op, mi);
        Object.assign(t, { faceUp: true, active: true, equippedTo: m.uid, equips: [], tags: {} });
        e.player(p).sz[zone] = t;
        m.equips.push(t.uid);
        tag(m).absorbed = t.uid;
        e.event('activate', { uid: t.uid, player: p });
        e.log(p, `Thousand-Eyes Restrict absorbs ${t.name}!`);
      },
    },
    baseStats: (e, m) => {
      const a = m.tags?.absorbed ? e.fieldCard(m.tags.absorbed) : null;
      if (!a || a.equippedTo !== m.uid) return undefined;
      return { atk: info(e, a).atk ?? 0, def: info(e, a).def ?? 0 };
    },
    battleSubstitute: (e, m) => {
      const a = m.tags?.absorbed ? e.fieldCard(m.tags.absorbed) : null;
      if (!a || a.equippedTo !== m.uid) return undefined;
      m.tags!.absorbed = 0;
      return a.uid;
    },
  };

  E['Token Stampede'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    aura: (_e, src, m) => (src.active && m.token && m.faceUp && m.pos === 'atk' ? { atk: 1000, def: 0 } : undefined),
    shields: (_e, src, m, how) => how === 'battle' && !!src.active && !!m.token && m.pos === 'atk',
  };

  E['Token Sundae'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.monsters(p).some((m) => m.token),
    *resolve(e, _l, p) {
      const toks = e.monsters(p).filter((m) => m.token);
      yield* e.destroy(toks.map((m) => m.uid));
      const n = toks.filter((m) => !e.fieldCard(m.uid)).length;
      const cards = [...allMonsters(e), ...allST(e)];
      if (!n || !cards.length) return;
      const chosen = yield* pick(e, p, `Destroy up to ${n} cards on the field`, cards, 0, n, false, true);
      if (chosen?.length) yield* e.destroy(chosen.map((c) => c.uid));
    },
  };

  // ----- Toons (Speed Duel texts: Normal Summonable, no attack cost) -----
  const toon = (extra: Partial<EffectDef> = {}): EffectDef => ({
    *onSummon(e, m) {
      tag(m).toonTurn = e.state.turn;
    },
    *onSpecialSummon(e, m) {
      tag(m).toonTurn = e.state.turn;
    },
    cannotAttack: (e, m) => m.tags?.toonTurn === e.state.turn || m.placedTurn === e.state.turn,
    directAttack: (e, _m, p) => !!e.anyActive('Toon World', p) && !faceUpMonsters(e, other(p)).some((x) => isToonMonster(x)),
    ...extra,
  });
  E['Toon Ancient Gear Golem'] = toon({ piercing: true, attackSealsST: true });
  /** "If "Toon World" on the field is destroyed, destroy this card." */
  const diesWithToonWorld: EffectDef['onGraveEvents'] = function* (e, m, p, events) {
    if (!events.some((x) => x.card.name === 'Toon World' && x.reason === 'destroyed' && (x.from === 'sz' || x.from === 'field')) || !e.fieldCard(m.uid)) return;
    e.log(p, `${m.name} is destroyed along with Toon World`);
    yield* e.destroy([m.uid]);
  };
  E['Toon Barrel Dragon'] = toon({
    ignition: {
      can: (e) => allMonsters(e).length + allST(e).length > 1,
      *run(e, m, p) {
        const list = [...targetable(e, allMonsters(e)), ...allST(e)].filter((c) => c.uid !== m.uid);
        const t = yield* pickOne(e, p, 'Toon Barrel Dragon: target which card?', list);
        if (!t) return;
        const coins = [e.roll(2), e.roll(2), e.roll(2)];
        e.log(p, `Coin tosses: ${coins.map((c) => (c === 1 ? 'Heads' : 'Tails')).join(', ')}`);
        if (coins.filter((c) => c === 1).length >= 2 && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
      },
    },
  });
  E['Toon Buster Blader'] = toon({
    selfBonus: (e, m) => {
      const opp = other(ctrl(e, m));
      const n = faceUpMonsters(e, opp).filter((x) => raceOf(e, x) === 'Dragon').length + e.player(opp).gy.filter((c) => isMonster(e, c) && info(e, c).race === 'Dragon').length;
      return { atk: 500 * n, def: 0 };
    },
  });
  E['Toon Dark Magician'] = toon({
    ignition: {
      can: (e, _m, p) => e.player(p).hand.some(isToonCard) && e.player(p).deck.some((c) => (freeMZ(e, p) && isToonMonster(c) && c.name !== 'Toon Dark Magician') || (named(c, 'Toon') && !isMonster(e, c))),
      *run(e, _m, p) {
        if (!(yield* discardCost(e, p, 1, isToonCard))) return;
        const ps = e.player(p);
        const mon = (c: Card) => isToonMonster(c) && c.name !== 'Toon Dark Magician';
        const st = (c: Card) => named(c, 'Toon') && !isMonster(e, c);
        const opts: string[] = [];
        if (freeMZ(e, p) && ps.deck.some(mon)) opts.push('Special Summon a Toon monster from the Deck');
        if (ps.deck.some(st)) opts.push('Add a Toon Spell/Trap from the Deck');
        const i = yield* chooseOption(e, p, 'Toon Dark Magician: which effect?', opts);
        if (i === null) return;
        if (opts[i].startsWith('Special')) {
          const c = yield* pickOne(e, p, 'Special Summon which Toon monster?', ps.deck.filter(mon));
          if (!c) return;
          yield* ignoringConditions(e, c.uid, e.specialSummon(c.uid, p, 'atk'));
          ps.deck = e.shuffle(ps.deck);
          const m = e.fieldCard(c.uid);
          if (m) tag(m).toonTurn = e.state.turn;
        } else yield* searchDeck(e, p, 'Add which Toon Spell/Trap?', st);
      },
    },
  });
  const elfDiscard = function* (e: Engine, p: Pid): Step {
    const c = randomOf(e, e.player(other(p)).hand);
    if (c) yield* e.discard(other(p), c.uid);
  };
  E['Toon Gemini Elf'] = toon({
    onGraveEvents: diesWithToonWorld,
    *onBattleDamage(e, _a, p) {
      yield* elfDiscard(e, p);
    },
    *onTargetBattleDamage(e, _t, _a, p) {
      yield* elfDiscard(e, p);
    },
  });
  E['Toon Masked Sorcerer'] = toon({
    onGraveEvents: diesWithToonWorld,
    *onBattleDamage(e, _a, p) {
      e.draw(p, 1);
    },
    *onTargetBattleDamage(e, _t, _a, p) {
      e.draw(p, 1);
    },
  });

  E['Toon Defense'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    quick: {
      repeat: true,
      label: 'make the attack a direct attack',
      can: (e, _c, p, t, ctx) => {
        if (opponentAttack(e, p, t, ctx) === null) return false;
        const tg = e.state.battle?.target != null ? e.fieldCard(e.state.battle.target) : null;
        return !!tg && tg.faceUp && ctrl(e, tg) === p && isToonMonster(tg) && levelOf(e, tg) <= 4;
      },
      *run(e, _c, p) {
        if (e.state.battle && e.state.battle.target !== null) {
          e.state.battle.target = null;
          e.log(p, 'Toon Defense: the attack becomes a direct attack');
        }
      },
    },
  };

  const toonMaskCands = (e: Engine, p: Pid, lv: number) => [...e.player(p).hand, ...e.player(p).deck].filter((c) => isToonMonster(c) && levelOf(e, c) <= lv);
  E['Toon Mask'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && !!e.anyActive('Toon World', p) && freeMZ(e, p) && targetable(e, faceUpMonsters(e, other(p))).some((m) => toonMaskCands(e, p, levelOrRank(e, m)).length > 0),
    *activate(e, link, p) {
      const list = targetable(e, faceUpMonsters(e, other(p))).filter((m) => toonMaskCands(e, p, levelOrRank(e, m)).length > 0);
      const m = yield* pickOne(e, p, 'Toon Mask: target which monster?', list, true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const m = fieldTarget(e, link);
      if (!m || !m.faceUp || !e.anyActive('Toon World', p)) return;
      const c = yield* pickOne(e, p, 'Special Summon which Toon monster?', toonMaskCands(e, p, levelOrRank(e, m)));
      if (!c) return;
      const fromDeck = e.find(c.uid)?.loc.zone === 'deck';
      yield* ignoringConditions(e, c.uid, e.specialSummon(c.uid, p, 'atk'));
      if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
      const t = e.fieldCard(c.uid);
      if (t) tag(t).toonTurn = e.state.turn;
    },
  };

  const rollbackable = (e: Engine, p: Pid) => targetable(e, faceUpMonsters(e, p).filter((m) => isToonMonster(m)));
  E['Toon Rollback'] = {
    canActivate: (e, _c, p, t) => isMain(t) && rollbackable(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Toon Rollback: which Toon can attack twice?', rollbackable(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const m = fieldTarget(e, link);
      if (m?.faceUp && isToonMonster(m)) Object.assign(tag(m), { extraAttacksTurn: e.state.turn, extraAttacksN: 1 });
    },
  };

  E['Toon Table of Contents'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.player(p).deck.some((c) => named(c, 'Toon')),
    *resolve(e, _l, p) {
      yield* searchDeck(e, p, 'Add which "Toon" card?', (c) => named(c, 'Toon'));
    },
  };

  // "From attacking monsters": battle damage while the opponent's monster is the attacker.
  E['Tornado Wall'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && umi(e),
    *resolve() {},
    damageMod: (e, _src, p, damaged, _n, byEffect) => {
      if (byEffect || damaged !== p || !umi(e) || !e.state.battle) return undefined;
      return e.controller(e.state.battle.attacker) === other(p) ? 0 : undefined;
    },
    *stateCheck(e, fc) {
      if (!umi(e) && e.fieldCard(fc.uid)) {
        e.log(ctrl(e, fc), 'Tornado Wall is destroyed: "Umi" left the field');
        yield* e.destroy([fc.uid]);
      }
    },
  };

  E['Totem Dragon'] = {
    doubleTribute: (e, _m, monster) => info(e, monster).race === 'Dragon',
    *onStandbyInGrave(e, card, p) {
      if (e.monsters(p).length || !freeMZ(e, p) || e.player(p).gy.some((c) => isMonster(e, c) && info(e, c).race !== 'Dragon')) return;
      if (!(yield* e.yesno(p, 'Totem Dragon: Special Summon it from the GY?'))) return;
      yield* e.specialSummon(card.uid, p, 'atk');
      const m = e.fieldCard(card.uid);
      if (m) tag(m).banishOnLeave = 1;
    },
    *onLeaveField(e, fc) {
      if (fc.tags?.banishOnLeave && ['gy', 'hand', 'deck'].includes(e.find(fc.uid)?.loc.zone ?? '')) e.banish(fc.uid);
    },
  };

  E['Trap Jammer'] = {
    // A Trap Card's activation (not the effect of a face-up Trap already on the field).
    canActivate: (e, _c, p, t, ctx) => t === 'trap' && e.state.phase === 'BP' && !!ctx.link && ctx.link.player !== p && isTrap(e, ctx.link.card) && !(ctx.link.payload as { effect?: string } | undefined)?.effect,
    *activate(e, link, _p, ctx) {
      link.payload = ctx.link;
    },
    *resolve(e, link, p) {
      const target = link.payload as ChainLink;
      negateLink(e, target, p);
      if (e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
    },
  };

  const blazeOnField = (e: Engine, p: Pid) => e.activeSpells(p).filter((c) => c.name === 'Blaze Accelerator');
  E['Tri-Blaze Accelerator'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    activateCost: {
      can: (e, _c, p) => blazeOnField(e, p).length > 0,
      *pay(e, _c, p) {
        const c = yield* pickOne(e, p, 'Send which Blaze Accelerator to the GY?', blazeOnField(e, p), true);
        if (!c) return false;
        yield* e.sendToGrave(c.uid, 'cost');
      },
    },
    *resolve() {},
    ignition: {
      repeat: true,
      can: (e, _m, p) => e.player(p).hand.some((c) => isMonster(e, c) && info(e, c).race === 'Pyro') && targetable(e, e.monsters(other(p))).length > 0,
      *run(e, m, p) {
        const pyro = yield* pickOne(e, p, 'Send which Pyro monster from your hand to the GY?', e.player(p).hand.filter((c) => isMonster(e, c) && info(e, c).race === 'Pyro'), true);
        if (!pyro) return;
        yield* e.sendToGrave(pyro.uid, 'cost');
        tag(m).noAtk = e.state.turn;
        noAttacksThisTurn(e, p);
        const t = yield* pickOne(e, p, 'Destroy which monster?', targetable(e, e.monsters(other(p))));
        if (t) yield* e.destroy([t.uid]);
        e.damage(other(p), 500);
      },
    },
    blocksAttack: (e, card, _m, attacker) => card.tags?.noAtk === e.state.turn && ctrl(e, card) === attacker,
    *onAnySummon(e, w, wp, m, controller) {
      if (w.tags?.noAtk === e.state.turn && controller === wp) tag(m).noAttackTurn = e.state.turn;
    },
  };

  const triWights = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isNormalMonster(e, c) && levelOf(e, c) <= 2);
  E['Tri-Wight'] = {
    canActivate: (e, _c, p, t) => isMain(t) && freeMZCount(e, p) >= 3 && triWights(e, p).length >= 3,
    *activate(e, link, p) {
      const chosen = yield* pick(e, p, 'Tri-Wight: target 3 Normal Monsters', triWights(e, p), 3, 3, true);
      if (!chosen || chosen.length < 3) return false;
      link.payload = chosen.map((c) => c.uid);
    },
    *resolve(e, link, p) {
      const uids = link.payload as number[];
      if (uids.some((u) => e.find(u)?.loc.zone !== 'gy') || freeMZCount(e, p) < 3) return;
      for (const u of uids) yield* e.specialSummon(u, p, 'atk');
    },
  };

  E['Tribe-Shocking Virus'] = {
    ignition: {
      can: (e, _m, p) => e.player(p).hand.some((c) => isMonster(e, c)),
      // The banish is a cost, paid as the effect is activated; the Type is remembered for the resolution.
      *cost(e, m, p) {
        const c = yield* pickOne(e, p, 'Banish which monster from your hand?', e.player(p).hand.filter((x) => isMonster(e, x)), true);
        if (!c) return false;
        tag(m).virusRace = RACES.indexOf(info(e, c).race ?? '');
        e.banish(c.uid);
      },
      *run(e, m, p) {
        const race = RACES[m.tags?.virusRace ?? -1];
        if (!race) return;
        const hit = faceUpMonsters(e).filter((x) => raceOf(e, x) === race);
        e.log(p, `Tribe-Shocking Virus strikes every ${race}`);
        if (hit.length) yield* e.destroy(hit.map((x) => x.uid));
      },
    },
  };

  // "That can be Normal Summoned/Set": not a Ritual/Extra Deck monster and no "Cannot be Normal Summoned" condition in its text.
  const dollable = (e: Engine, c: Card) => isMonster(e, c) && levelOf(e, c) === 7 && !isExtraOrRitual(e, c) && !E[c.name]?.cannotNormalSummon && !/annot be Normal Summoned/.test(info(e, c).desc);
  E['Tribute Doll'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.monsters(p).length > 0 && e.player(p).hand.some((c) => dollable(e, c)),
    *activate(e, _link, p) {
      if (!(yield* tributeCost(e, p, 1))) return false;
    },
    *resolve(e, _l, p) {
      const m = yield* summonOneOf(e, p, 'Special Summon which Level 7 monster?', e.player(p).hand.filter((c) => dollable(e, c)), 'atk');
      if (m) tag(m).noAttackTurn = e.state.turn;
    },
  };

  E['Troop Dragon'] = {
    *onDestroyed(e, _c, p, byBattle) {
      if (byBattle) yield* summonOneOf(e, p, 'Special Summon which Troop Dragon?', e.player(p).deck.filter((c) => c.name === 'Troop Dragon'), 'atk');
    },
  };

  E['Truckroid'] = {
    ...onBattleKill(function* (e, me, victim, p) {
      const f = e.find(victim.uid);
      if (!f || f.loc.zone !== 'gy' || !isMonster(e, f.card) || freeST(e, p) < 0) return;
      const eq = equipFromPile(e, victim.uid, me, p);
      if (eq) {
        tag(eq).truck = me.uid;
        e.log(p, `${victim.name} is equipped to Truckroid`);
      }
    }),
    selfBonus: (e, m) => ({ atk: m.equips.map((u) => e.fieldCard(u)).filter((c) => c?.tags?.truck === m.uid).reduce((a, c) => a + (info(e, c!).atk ?? 0), 0), def: 0 }),
  };

  E['Tutan Mask'] = {
    canActivate: (e, _c, _p, t, ctx) => {
      if ((t !== 'spell' && t !== 'trap') || !ctx.link || ctx.link.targetUid === undefined) return false;
      const m = e.fieldCard(ctx.link.targetUid);
      return !!m && m.faceUp && e.find(m.uid)?.loc.zone === 'mz' && raceOf(e, m) === 'Zombie';
    },
    *activate(e, link, _p, ctx) {
      link.payload = ctx.link;
    },
    *resolve(e, link, p) {
      const target = link.payload as ChainLink;
      negateLink(e, target, p);
      if (e.fieldCard(target.card.uid)) yield* e.destroy([target.card.uid]);
    },
  };

  const twisterTargets = (e: Engine, self: number) => allST(e).filter((c) => c.faceUp && c.uid !== self);
  E['Twister'] = {
    canActivate: (e, c, p, t) => anyTime(t) && e.player(p).lp > 500 && twisterTargets(e, c.uid).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Twister: destroy which face-up Spell/Trap?', twisterTargets(e, link.card.uid), true);
      if (!c || !payLp(e, p, 500)) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link) {
      if (fieldTarget(e, link)) yield* e.destroy([link.targetUid!]);
    },
  };

  E['UFOroid'] = {
    *onDestroyed(e, _c, p, byBattle) {
      const ok = (c: Card) => isMonster(e, c) && info(e, c).race === 'Machine' && (info(e, c).atk ?? 0) <= 1500;
      if (!byBattle || !freeMZ(e, p) || !e.player(p).deck.some(ok)) return;
      if (!(yield* e.yesno(p, 'UFOroid: Special Summon a Machine with 1500 or less ATK from your Deck?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which Machine?', e.player(p).deck.filter(ok), 'atk');
    },
  };

  E['Ultra Evolution Pill'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.monsters(p).some((m) => raceOf(e, m) === 'Reptile' && !e.untributable(m)) && e.player(p).hand.some((c) => isMonster(e, c) && info(e, c).race === 'Dinosaur'),
    *activate(e, _l, p) {
      if (!(yield* tributeCost(e, p, 1, (m) => raceOf(e, m) === 'Reptile'))) return false;
    },
    *resolve(e, _l, p) {
      yield* summonOneOf(e, p, 'Special Summon which Dinosaur?', e.player(p).hand.filter((c) => isMonster(e, c) && info(e, c).race === 'Dinosaur'), 'atk');
    },
  };

  const lonely = (e: Engine, p: Pid) => {
    const up = faceUpMonsters(e, p);
    return up.length === 1 && !e.untargetable(up[0]) ? up[0] : null;
  };
  E['Unbreakable Spirit'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && !!lonely(e, p) && faceUpMonsters(e, other(p)).length > 0,
    *activate(e, link, p) {
      link.targetUid = lonely(e, p)!.uid;
    },
    *resolve(e, link, p) {
      const m = fieldTarget(e, link);
      const opp = faceUpMonsters(e, other(p));
      if (!m || !m.faceUp || !opp.length) return;
      const low = Math.min(...opp.map((x) => e.atkOf(x)));
      boostTurn(m, low);
      e.log(p, `${m.name} gains ${low} ATK`);
    },
  };

  const nightmareTargets = (e: Engine, self: number) => allST(e).filter((c) => c.faceUp && c.uid !== self);
  const nightmare = function* (e: Engine, card: Card, p: Pid): Step {
    const c = yield* pickOne(e, p, 'Unending Nightmare: destroy which face-up Spell/Trap?', nightmareTargets(e, card.uid), true);
    if (!c || !payLp(e, p, 1000)) return;
    yield* e.destroy([c.uid]);
  };
  E['Unending Nightmare'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    ignition: {
      repeat: true,
      can: (e, m, p) => e.player(p).lp > 1000 && nightmareTargets(e, m.uid).length > 0,
      *run(e, m, p) {
        yield* nightmare(e, m, p);
      },
    },
    quick: {
      repeat: true,
      label: 'pay 1000 LP to destroy a face-up Spell/Trap',
      can: (e, c, p) => e.player(p).lp > 1000 && nightmareTargets(e, c.uid).length > 0 && !e.state.chain.some((l) => l.card.uid === c.uid),
      *cost(e, c, p, link) {
        const t = yield* pickOne(e, p, 'Unending Nightmare: destroy which face-up Spell/Trap?', nightmareTargets(e, c.uid), true);
        if (!t || !payLp(e, p, 1000)) return false;
        link.targetUid = t.uid;
      },
      *run(e, _c, _p, link) {
        if (fieldTarget(e, link)) yield* e.destroy([link.targetUid!]);
      },
    },
  };

  const hangarUnion = (e: Engine, c: Card) => LIGHT_MACHINE_UNIONS.includes(c.name);
  E['Union Hangar'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.oncePerTurn('Union Hangar', p),
    *activate(e, _l, p) {
      e.useOnce('Union Hangar', p);
    },
    *resolve(e, _l, p) {
      if (!e.player(p).deck.some((c) => hangarUnion(e, c)) || !(yield* e.yesno(p, 'Union Hangar: add a LIGHT Machine Union monster from your Deck?'))) return;
      yield* searchDeck(e, p, 'Add which Union monster?', (c) => hangarUnion(e, c));
    },
    *onAnySummon(e, w, wp, m, controller, kind) {
      if (kind === 'flip' || controller !== wp || !m.faceUp || !hangarUnion(e, m) || !e.oncePerTurn(`hangar:${w.uid}`, wp) || freeST(e, wp) < 0 || hasUnion(e, m)) return;
      const cands = e.player(wp).deck.filter((c) => hangarUnion(e, c) && c.name !== m.name && UNION_HOSTS[c.name].includes(m.name));
      if (!cands.length || !(yield* e.yesno(wp, `Union Hangar: equip a Union monster from your Deck to ${m.name}?`))) return;
      e.useOnce(`hangar:${w.uid}`, wp);
      const c = yield* pickOne(e, wp, 'Equip which Union monster?', cands);
      if (!c || !e.fieldCard(m.uid)) return;
      const eq = equipFromPile(e, c.uid, m, wp);
      e.player(wp).deck = e.shuffle(e.player(wp).deck);
      if (eq) {
        eq.tags = { union: 1, noSS: e.state.turn };
        e.log(wp, `${c.name} is equipped to ${m.name}`);
      }
    },
  };

  const scrambleOk = (e: Engine, c: Card) => isMonster(e, c) && attrOf(e, c) === 'LIGHT' && info(e, c).race === 'Machine' && (isNormalMonster(e, c) || hangarUnion(e, c));
  const scrambleBack = function* (e: Engine, card: Card, p: Pid): Step {
    const c = yield* pickOne(e, p, 'Union Scramble: return which banished monster to your hand?', e.player(p).removed.filter((x) => scrambleOk(e, x)));
    if (!c || e.find(card.uid)?.loc.zone !== 'gy') return;
    e.banish(card.uid);
    e.toHandOf(c.uid, p);
  };
  const scrambleGyReady = (e: Engine, card: Card, p: Pid) => ((e.state.fx.scrambleSent ?? {}) as Record<number, number>)[card.uid] !== e.state.turn && e.player(p).removed.some((x) => scrambleOk(e, x));
  E['Union Scramble'] = {
    canActivate: (e, c, p, t) => anyTime(t) && e.oncePerTurn(c.name, p) && freeMZ(e, p) && e.player(p).removed.some((x) => scrambleOk(e, x)),
    *activate(e, link, p) {
      const n = Math.min(3, freeMZCount(e, p));
      const chosen = yield* pick(e, p, `Union Scramble: target up to ${n} banished monsters`, e.player(p).removed.filter((x) => scrambleOk(e, x)), 1, n, true);
      if (!chosen?.length) return false;
      e.useOnce(link.card.name, p);
      link.payload = chosen.map((c) => c.uid);
    },
    *resolve(e, link, p) {
      for (const u of link.payload as number[]) if (e.find(u)?.loc.zone === 'removed' && freeMZ(e, p)) yield* e.specialSummon(u, p, 'atk');
    },
    *onSentToGrave(e, card) {
      ((e.state.fx.scrambleSent ??= {}) as Record<number, number>)[card.uid] = e.state.turn;
    },
    graveIgnition: { can: scrambleGyReady, run: scrambleBack },
    quick: {
      from: 'gy',
      label: 'banish it to return a banished monster to the hand',
      can: (e, card, p, t) => anyTime(t) && scrambleGyReady(e, card, p),
      *cost(e, card) {
        e.banish(card.uid);
      },
      *run(e, _card, p) {
        const c = yield* pickOne(e, p, 'Union Scramble: return which banished monster to your hand?', e.player(p).removed.filter((x) => scrambleOk(e, x)));
        if (c) e.toHandOf(c.uid, p);
      },
    },
  };

  E['United We Stand'] = h.equip((e, eq) => {
    const n = faceUpMonsters(e, ctrl(e, eq)).length * 800;
    return { atk: n, def: n };
  });

  const faceUpTraps = (e: Engine, p: Pid) => [...e.spells(p), ...e.monsters(p)].filter((c) => c.faceUp && isTrap(e, c));
  E['Uria, Lord of Searing Flames'] = {
    cannotNormalSummon: true,
    summonRule: mustBeSummoned(true),
    summonProc: {
      can: (e, _c, p) => faceUpTraps(e, p).length >= 3 && (freeMZ(e, p) || faceUpTraps(e, p).some((c) => inZone(e, c, 'mz'))),
      *run(e, card, p) {
        const chosen = yield* pick(e, p, 'Send 3 face-up Traps you control to the GY', faceUpTraps(e, p), 3, 3, true);
        if (!chosen || chosen.length < 3) return;
        for (const c of chosen) yield* e.sendToGrave(c.uid, 'cost');
        if (freeMZ(e, p)) yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
    selfBonus: (e, m) => ({ atk: 1000 * e.player(ctrl(e, m)).gy.filter((c) => isTrap(e, c) && info(e, c).sub === 'Continuous').length, def: 0 }),
    ignition: {
      chain: false, // neither player can respond
      can: (e, _m, p) => stSet(e, other(p)).length > 0,
      *run(e, _m, p) {
        const c = yield* pickOne(e, p, 'Uria: destroy which Set Spell/Trap?', stSet(e, other(p)), true);
        if (c) yield* e.destroy([c.uid]);
      },
    },
  };
  function stSet(e: Engine, p: Pid) {
    return [...e.spells(p), ...(e.player(p).field ? [e.player(p).field!] : [])].filter((c) => !c.faceUp);
  }

  // ----- V/W/X/Y/Z: Unions host the Contact Fusion procedure -----
  E['W-Wing Catapult'] = union(400, 400, true);
  E['Y-Dragon Head'] = union(400, 400, true);
  E['Z-Metal Tank'] = union(600, 600, true);
  // Approximation: the discard happens when the equipped monster destroys a monster by battle as the attacker (the engine's hostAfterBattle).
  E['Zombie Tiger'] = union(500, 500, false, 'atk', {
    *hostAfterBattle(e, eq, host, target) {
      if (!eq.tags?.union || !target || e.fieldCard(target.uid)) return;
      const p = ctrl(e, host);
      const c = randomOf(e, e.player(other(p)).hand);
      if (c) yield* e.discard(other(p), c.uid);
    },
  });

  const flipPosition = (e: Engine, m: FieldCard) => {
    if (!m.faceUp) {
      m.faceUp = true;
      m.pos = 'atk';
    } else m.pos = m.pos === 'atk' ? 'def' : 'atk';
    e.event('position', { uid: m.uid });
    e.log(null, `${m.name} changes to ${m.pos === 'atk' ? 'Attack' : 'Defense'} Position`);
  };
  const vwTarget = (e: Engine, p: Pid) => targetable(e, e.monsters(other(p)));
  E['VW-Tiger Catapult'] = {
    ...contactFusion(true),
    ignition: {
      repeat: true,
      can: (e, _m, p) => e.player(p).hand.length > 0 && vwTarget(e, p).length > 0,
      *cost(e, _m, p) {
        return yield* discardCost(e, p, 1);
      },
      *run(e, _m, p) {
        const t = yield* pickOne(e, p, 'Change the position of which monster?', vwTarget(e, p));
        if (t && e.fieldCard(t.uid)) flipPosition(e, t);
      },
    },
  };
  const oppST = (e: Engine, p: Pid) => [...e.spells(other(p)), ...(e.player(other(p)).field ? [e.player(other(p)).field!] : [])];
  const xyz = (title: string, targets: (e: Engine, p: Pid) => FieldCard[]): EffectDef['ignition'] => ({ repeat: true, ...cannonEffect(title, targets) });
  // These four "Cannot be Special Summoned from the GY".
  E['XY-Dragon Cannon'] = { ...contactFusion(false), ignition: xyz('Destroy which face-up Spell/Trap?', (e, p) => oppST(e, p).filter((c) => c.faceUp)) };
  E['XZ-Tank Cannon'] = { ...contactFusion(false), ignition: xyz('Destroy which Set Spell/Trap?', (e, p) => oppST(e, p).filter((c) => !c.faceUp)) };
  E['YZ-Tank Dragon'] = { ...contactFusion(false), ignition: xyz('Destroy which face-down monster?', (e, p) => e.monsters(other(p)).filter((m) => !m.faceUp)) };
  E['XYZ-Dragon Cannon'] = { ...contactFusion(false), ignition: xyz('Destroy which card?', (e, p) => [...targetable(e, e.monsters(other(p))), ...oppST(e, p)]) };
  E['VWXYZ-Dragon Catapult Cannon'] = {
    ...contactFusion(true),
    ignition: {
      can: (e, _m, p) => targetable(e, e.monsters(other(p))).length + oppST(e, p).length > 0,
      *run(e, _m, p) {
        const t = yield* pickOne(e, p, 'VWXYZ: banish which card?', [...targetable(e, e.monsters(other(p))), ...oppST(e, p)]);
        if (t && e.fieldCard(t.uid)) e.banish(t.uid);
      },
    },
    quick: {
      label: "change the attack target's position",
      can: (e, c, _p, t, ctx) => t === 'attack' && ctx.uid === c.uid && e.state.battle?.target != null && !!e.fieldCard(e.state.battle.target),
      *run(e) {
        const t = e.state.battle?.target != null ? e.fieldCard(e.state.battle.target) : null;
        if (t) flipPosition(e, t);
      },
    },
  };

  E['Valhalla, Hall of the Fallen'] = emptyFieldSummoner((e, c) => info(e, c).race === 'Fairy');
  E['Water Hazard'] = emptyFieldSummoner((e, c) => levelOf(e, c) <= 4 && attrOf(e, c) === 'WATER');

  E['Vampire Awakening'] = {
    canActivate: (e, c, p, t) => anyTime(t) && e.oncePerTurn(c.name, p) && freeMZ(e, p) && e.player(p).deck.some((x) => isMonster(e, x) && isVampire(x)),
    *activate(e, link, p) {
      e.useOnce(link.card.name, p);
    },
    *resolve(e, _l, p) {
      const m = yield* summonOneOf(e, p, 'Special Summon which Vampire monster?', e.player(p).deck.filter((x) => isMonster(e, x) && isVampire(x)), 'atk');
      if (m) m.doomAt = e.state.turn;
    },
  };

  // Remembers the monsters it destroyed by battle this turn; at the end of the Battle Phase one of them still in the GY can be Special Summoned.
  const babyKills = (e: Engine) => (e.state.fx.vampireBaby ??= {}) as Record<number, { turn: number; uids: number[] }>;
  E['Vampire Baby'] = {
    ...onBattleKill(function* (e, me, victim) {
      const k = babyKills(e);
      const cur = k[me.uid]?.turn === e.state.turn ? k[me.uid] : { turn: e.state.turn, uids: [] };
      cur.uids.push(victim.uid);
      k[me.uid] = cur;
    }),
    *onBattlePhaseEnd(e, me, p) {
      const k = babyKills(e)[me.uid];
      if (!k || k.turn !== e.state.turn) return;
      delete babyKills(e)[me.uid];
      const list = k.uids.map((u) => e.find(u)).filter((f) => f && f.loc.zone === 'gy' && isMonster(e, f.card)).map((f) => f!.card);
      if (!list.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Vampire Baby: Special Summon the monster it destroyed by battle to your field?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which monster?', list, 'atk');
    },
  };

  /** Vampire Familiar / Retainer: Special Summon search, and the GY self-revival. */
  const vampireServant = (name: string, test: (e: Engine, c: Card) => boolean): EffectDef => {
    const fodder = (e: Engine, p: Pid) => [...e.player(p).hand, ...e.monsters(p).filter((m) => m.faceUp), ...e.activeSpells(p)].filter(isVampire);
    return {
      *onSpecialSummon(e, _m, p) {
        if (!e.oncePerTurn(`${name}:search`, p) || e.player(p).lp <= 500 || !e.player(p).deck.some((c) => test(e, c))) return;
        if (!(yield* e.yesno(p, `${name}: pay 500 LP to add a "Vampire" card from your Deck?`))) return;
        e.useOnce(`${name}:search`, p);
        payLp(e, p, 500);
        yield* searchDeck(e, p, 'Add which card?', (c) => test(e, c));
      },
      graveIgnition: {
        can: (e, _c, p) => e.oncePerTurn(`${name}:revive`, p) && fodder(e, p).length > 0 && (freeMZ(e, p) || e.monsters(p).some(isVampire)),
        *run(e, card, p) {
          const c = yield* pickOne(e, p, `${name}: send which "Vampire" card to the GY?`, fodder(e, p), true);
          if (!c) return;
          e.useOnce(`${name}:revive`, p);
          yield* e.sendToGrave(c.uid, 'cost');
          if (!freeMZ(e, p) || e.find(card.uid)?.loc.zone !== 'gy') return;
          yield* e.specialSummon(card.uid, p, 'atk');
          const m = e.fieldCard(card.uid);
          if (m) tag(m).banishOnLeave = 1;
        },
      },
      *onLeaveField(e, fc) {
        if (fc.tags?.banishOnLeave && e.find(fc.uid)?.loc.zone === 'gy') e.banish(fc.uid);
      },
    };
  };
  E['Vampire Familiar'] = vampireServant('Vampire Familiar', (e, c) => isMonster(e, c) && isVampire(c) && c.name !== 'Vampire Familiar');
  E['Vampire Retainer'] = vampireServant('Vampire Retainer', (e, c) => !isMonster(e, c) && isVampire(c));

  const zombie = (e: Engine, c: Card) => isMonster(e, c) && info(e, c).race === 'Zombie';
  E['Vampire Genesis'] = {
    cannotNormalSummon: true,
    summonRule: mustBeSummoned(false),
    summonProc: {
      can: (e, _c, p) => faceUpMonsters(e, p).some((m) => m.name === 'Vampire Lord'),
      *run(e, card, p) {
        const lord = yield* pickOne(e, p, 'Banish which Vampire Lord?', faceUpMonsters(e, p).filter((m) => m.name === 'Vampire Lord'), true);
        if (!lord) return;
        e.banish(lord.uid);
        yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
    ignition: {
      can: (e, _m, p) => freeMZ(e, p) && e.player(p).hand.some((c) => zombie(e, c) && e.player(p).gy.some((g) => zombie(e, g) && !isExtraOrRitual(e, g) && levelOf(e, g) < levelOf(e, c))),
      // The discard is the cost; the discarded monster's Level is remembered for the resolution.
      *cost(e, m, p) {
        const hand = e.player(p).hand.filter((c) => zombie(e, c) && e.player(p).gy.some((g) => zombie(e, g) && !isExtraOrRitual(e, g) && levelOf(e, g) < levelOf(e, c)));
        const d = yield* pickOne(e, p, 'Vampire Genesis: discard which Zombie?', hand, true);
        if (!d) return false;
        tag(m).genesisLv = levelOf(e, d);
        yield* e.discard(p, d.uid);
      },
      *run(e, m, p) {
        const lv = m.tags?.genesisLv ?? 0;
        yield* summonOneOf(e, p, 'Special Summon which Zombie from your GY?', e.player(p).gy.filter((g) => zombie(e, g) && !isExtraOrRitual(e, g) && levelOf(e, g) < lv), 'atk');
      },
    },
  };

  E['Vampire Hunter'] = {
    *onBeingAttacked(e, _t, attacker) {
      if (e.fieldCard(attacker.uid) && attrOf(e, attacker) === 'DARK') yield* e.destroy([attacker.uid]);
    },
    *attackerDamageStep(e, _a, target) {
      if (target.faceUp && attrOf(e, target) === 'DARK') yield* e.destroy([target.uid]);
    },
  };

  // "Inflicts battle damage": as the attacker, or as the attacked monster (onTargetBattleDamage).
  E['Vampire Lady'] = {
    *onBattleDamage(e, _a, p) {
      yield* declareMill(e, p);
    },
    *onTargetBattleDamage(e, _t, _a, p) {
      yield* declareMill(e, p);
    },
  };

  E['Vampire Lord'] = {
    *onBattleDamage(e, _a, p) {
      yield* declareMill(e, p);
    },
    *onTargetBattleDamage(e, _t, _a, p) {
      yield* declareMill(e, p);
    },
    *onLeaveField(e, fc, controller, reason) {
      if (reason === 'destroyed' && leftBy(fc) === other(controller) && fc.owner === controller) ((e.state.fx.vlord ??= {}) as Record<number, number>)[fc.uid] = e.state.turn;
    },
    *onStandbyInGrave(e, card, p) {
      const when = ((e.state.fx.vlord ?? {}) as Record<number, number>)[card.uid];
      if (when === undefined || when >= e.state.turn || !freeMZ(e, p)) return;
      delete (e.state.fx.vlord as Record<number, number>)[card.uid];
      yield* e.specialSummon(card.uid, p, 'atk');
    },
  };

  const darkVampire = (e: Engine, c: Card) => isMonster(e, c) && isVampire(c) && attrOf(e, c) === 'DARK';
  const sorcererSearch = function* (e: Engine, card: Card, p: Pid): Step {
    const fx = (e.state.fx.vsorc ??= {}) as Record<number, number>;
    if (fx[card.uid] === e.state.turn) return;
    fx[card.uid] = e.state.turn;
    const ok = (c: Card) => isVampire(c) && (isMonster(e, c) ? attrOf(e, c) === 'DARK' : true);
    if (!e.player(p).deck.some(ok) || !(yield* e.yesno(p, 'Vampire Sorcerer: add a "Vampire" card from your Deck?'))) return;
    yield* searchDeck(e, p, 'Add which card?', ok);
  };
  E['Vampire Sorcerer'] = {
    onLeaveField: markLeave,
    *onDestroyed(e, card, p, byBattle) {
      if (card.owner === p && (byBattle || leftByOpp(e, card.uid))) yield* sorcererSearch(e, card, p);
    },
    *onSentToGrave(e, card, owner, from, reason) {
      if ((from === 'mz' && reason !== 'destroyed' && leftByOpp(e, card.uid)) || ((from === 'hand' || from === 'deck') && e.actor === other(owner))) yield* sorcererSearch(e, card, owner);
    },
    // "You can banish this card from your GY; 1 DARK "Vampire" monster you Normal Summon this turn can be Summoned without Tributing."
    graveIgnition: {
      can: () => true,
      *run(e, card, p) {
        if (e.find(card.uid)?.loc.zone !== 'gy') return;
        e.banish(card.uid);
        e.linger('Vampire Sorcerer', p);
        e.log(p, `${e.player(p).name} can Normal Summon 1 DARK "Vampire" monster without Tributing this turn`);
      },
    },
    lingering: {
      tributeOffer: (e, owner, monster) => (darkVampire(e, monster) && ((e.state.fx.vsorcUsed ?? [-1, -1]) as number[])[owner] !== e.state.turn ? { need: 0 } : undefined),
      *onAnySummon(e, owner, m, controller, kind) {
        if (kind === 'normal' && controller === owner && darkVampire(e, m)) ((e.state.fx.vsorcUsed ??= [-1, -1]) as number[])[owner] = e.state.turn;
      },
    },
  };

  E["Vampire's Curse"] = {
    *onDestroyed(e, card, p, byBattle) {
      if (!byBattle || card.owner !== p || e.player(p).lp <= 500) return;
      if (!(yield* e.yesno(p, "Vampire's Curse: pay 500 LP to revive it next Standby Phase?"))) return;
      payLp(e, p, 500);
      ((e.state.fx.vcurse ??= {}) as Record<number, number>)[card.uid] = e.state.turn + 1;
    },
    *onStandbyInGraveAny(e, card, p) {
      const when = ((e.state.fx.vcurse ?? {}) as Record<number, number>)[card.uid];
      if (when !== e.state.turn || !freeMZ(e, p)) return;
      delete (e.state.fx.vcurse as Record<number, number>)[card.uid];
      yield* e.specialSummon(card.uid, p, 'atk');
      const m = e.fieldCard(card.uid);
      if (m) boostPerm(m, 500);
    },
  };

  const desireMill = (e: Engine, p: Pid, m: FieldCard) => e.player(p).deck.filter((c) => isMonster(e, c) && isVampire(c) && levelOf(e, c) !== levelOf(e, m));
  const desireRevive = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isMonster(e, c) && isVampire(c) && !isExtraOrRitual(e, c));
  E["Vampire's Desire"] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p) && (faceUpMonsters(e, p).some((m) => desireMill(e, p, m).length > 0) || (e.monsters(p).length > 0 && desireRevive(e, p).length > 0)),
    *activate(e, link, p) {
      const opts: string[] = [];
      if (targetable(e, faceUpMonsters(e, p)).some((m) => desireMill(e, p, m).length > 0)) opts.push('Send a Vampire from the Deck to the GY');
      if (e.monsters(p).length > 0 && desireRevive(e, p).length > 0) opts.push('Revive a Vampire from the GY');
      const i = yield* chooseOption(e, p, "Vampire's Desire: which effect?", opts, true);
      if (i === null) return false;
      const mode = opts[i].startsWith('Send') ? 1 : 2;
      const list = mode === 1 ? targetable(e, faceUpMonsters(e, p)).filter((m) => desireMill(e, p, m).length > 0) : desireRevive(e, p);
      const t = yield* pickOne(e, p, 'Target which monster?', list as Card[], true);
      if (!t) return false;
      e.useOnce(link.card.name, p);
      link.targetUid = t.uid;
      link.payload = mode;
    },
    *resolve(e, link, p) {
      const uid = link.targetUid!;
      if (link.payload === 1) {
        const m = e.fieldCard(uid);
        if (!m || !m.faceUp) return;
        const c = yield* pickOne(e, p, 'Send which Vampire monster from your Deck to the GY?', desireMill(e, p, m));
        if (!c) return;
        yield* e.sendToGrave(c.uid, 'used');
        e.player(p).deck = e.shuffle(e.player(p).deck);
        if (e.find(c.uid)?.loc.zone !== 'gy' || !e.fieldCard(m.uid)?.faceUp) return;
        // It becomes that monster's Level until the end of this turn.
        Object.assign(tag(m), { lvSet: levelOf(e, c), lvSetTurn: e.state.turn });
        e.log(p, `${m.name} becomes Level ${levelOf(e, c)}`);
      } else {
        if (e.find(uid)?.loc.zone !== 'gy') return;
        const s = yield* pickOne(e, p, 'Send which monster you control to the GY?', e.monsters(p));
        if (!s) return;
        yield* e.sendToGrave(s.uid, 'used');
        if (e.find(s.uid)?.loc.zone !== 'gy' && !s.token) return;
        if (freeMZ(e, p) && e.find(uid)?.loc.zone === 'gy') yield* e.specialSummon(uid, p, 'atk');
      }
    },
  };

  // The damage just inflicted is read from fx.hurt (the engine's tally since the last damage window).
  const koalaHeal = (e: Engine, p: Pid) => {
    const n = ((e.state.fx.hurt ?? [0, 0]) as number[])[other(p)];
    if (n > 0) e.gainLp(p, n);
  };
  E['Vampiric Koala'] = {
    *onBattleDamage(e, _a, p) {
      if (e.state.battle?.target != null) koalaHeal(e, p);
    },
    *onTargetBattleDamage(e, _t, _a, p) {
      koalaHeal(e, p);
    },
  };

  E['Vanguard of the Dragon'] = {
    ignition: {
      repeat: true,
      can: (e, _m, p) => e.player(p).hand.some((c) => isMonster(e, c) && info(e, c).race === 'Dragon'),
      *cost(e, _m, p) {
        const c = yield* pickOne(e, p, 'Send which Dragon from your hand to the GY?', e.player(p).hand.filter((x) => isMonster(e, x) && info(e, x).race === 'Dragon'), true);
        if (!c) return false;
        yield* e.sendToGrave(c.uid, 'cost');
      },
      *run(e, m) {
        if (e.fieldCard(m.uid)?.faceUp) boostPerm(m, 300);
      },
    },
    *onLeaveField(e, fc, controller) {
      if (leftBy(fc) !== other(controller) || fc.owner !== controller || e.find(fc.uid)?.loc.zone !== 'gy') return;
      const list = [...e.player(controller).gy, ...e.player(other(controller)).gy].filter((c) => isNormalMonster(e, c) && info(e, c).race === 'Dragon');
      if (!list.length || !freeMZ(e, controller) || !(yield* e.yesno(controller, 'Vanguard of the Dragon: Special Summon a Dragon Normal Monster from a GY?'))) return;
      yield* e.as(controller, (function* () {
        yield* summonOneOf(e, controller, 'Special Summon which Dragon?', list, 'atk');
      })());
    },
  };

  E['Vehicroid Connection Zone'] = {
    canActivate: (e, _c, p, t) => isMain(t) && fusable(e, p, (n) => named(n, 'Vehicroid')).length > 0,
    *activate(e, link, p) {
      const f = yield* pickOne(e, p, 'Fusion Summon which Vehicroid?', fusable(e, p, (n) => named(n, 'Vehicroid')), true);
      if (!f) return false;
      const chosen: number[] = [];
      const names = matsOf(e, f.name);
      for (let i = 0; i < names.length; i++) {
        const cands = fusionPool(e, p).filter((c) => c.name === names[i] && !chosen.includes(c.uid) && matchMats(fusionPool(e, p), names.slice(i + 1), [...chosen, c.uid]));
        const c = yield* pickOne(e, p, `Use which ${names[i]}?`, cands, true);
        if (!c) return false;
        chosen.push(c.uid);
      }
      link.payload = { fusion: f.uid, mats: chosen };
    },
    *resolve(e, link, p) {
      const { fusion, mats } = link.payload as { fusion: number; mats: number[] };
      if (e.find(fusion)?.loc.zone !== 'fusion' || mats.some((u) => !e.find(u))) return;
      for (const u of mats) yield* e.sendToGrave(u, 'used');
      if (!freeMZ(e, p)) return;
      (e.state.fx.fusionMatList ??= {})[fusion] = mats.slice();
      // effProof / unnegatable: engine tags (audit-10) for "it cannot be destroyed by card effects, and its effects cannot be negated".
      yield* e.specialSummon(fusion, p, 'atk', true, (fc) => Object.assign((fc.tags ??= {}), { fusS: 1, effProof: 1, unnegatable: 1 }));
      if (e.fieldCard(fusion)) e.log(p, `${e.player(p).name} Fusion Summons ${e.find(fusion)!.card.name}: it cannot be destroyed by card effects and its effects cannot be negated`);
    },
  };

  E['Victory Viper XX03'] = {
    ...onBattleKill(function* (e, me, _victim, p) {
      const opts = ['Gain 400 ATK'];
      const sts = allST(e).filter((c) => c.faceUp);
      if (sts.length) opts.push('Destroy a face-up Spell/Trap');
      if (freeMZ(e, p)) opts.push('Special Summon an Option Token');
      const i = yield* chooseOption(e, p, 'Victory Viper XX03: activate which effect?', opts);
      if (i === null) return;
      if (opts[i].startsWith('Gain')) boostPerm(me, 400);
      else if (opts[i].startsWith('Destroy')) {
        const c = yield* pickOne(e, p, 'Destroy which Spell/Trap?', sts);
        if (c && e.fieldCard(c.uid)) yield* e.destroy([c.uid]);
      } else {
        const tok = e.createToken('Option Token', p, 'atk', true, { atk: 0, def: 0, level: 4, attribute: 'LIGHT', race: 'Machine' });
        if (tok) tag(tok).viper = me.uid;
      }
    }),
    *onLeaveField(e, fc) {
      const toks = allMonsters(e).filter((m) => m.name === 'Option Token' && m.tags?.viper === fc.uid);
      for (const t of toks) yield* e.sendToGrave(t.uid, 'used');
    },
  };
  E['Option Token'] = {
    baseStats: (e, m) => {
      const v = m.tags?.viper ? e.fieldCard(m.tags.viper) : null;
      return v?.faceUp ? { atk: e.atkOf(v), def: e.defOf(v) } : undefined;
    },
  };

  // Approximation: the countdown is kept on Viser Des, so the delayed destruction is lost if Viser Des leaves the field first.
  E['Viser Des'] = {
    *onSummon(e, m, p, kind) {
      if (kind !== 'normal') return;
      const t = yield* pickOne(e, p, 'Viser Des: target which monster?', targetable(e, e.monsters(other(p))));
      if (!t) return;
      Object.assign(tag(m), { viserTarget: t.uid, viserCount: 0 });
      e.log(p, `Viser Des marks ${label(t)}`);
    },
    *onStandby(e, m, p) {
      const t = m.tags?.viserTarget;
      if (!t || e.state.turnPlayer !== p) return;
      if (!e.fieldCard(t)) {
        m.tags!.viserTarget = 0;
        return;
      }
      m.tags!.viserCount = (m.tags!.viserCount ?? 0) + 1;
      if (m.tags!.viserCount >= 3) {
        m.tags!.viserTarget = 0;
        yield* e.destroy([t]);
      }
    },
    battleProof: (e, m) => !!m.tags?.viserTarget && !!e.fieldCard(m.tags.viserTarget),
  };

  E['Volcanic Blaster'] = {
    *onDestroyed(e, _c, p, byBattle) {
      const ok = (c: Card) => isMonster(e, c) && named(c, 'Volcanic');
      if (!byBattle || !e.player(p).deck.some(ok) || !(yield* e.yesno(p, 'Volcanic Blaster: place a "Volcanic" monster on top of your Deck?'))) return;
      const c = yield* pickOne(e, p, 'Place which monster on top?', e.player(p).deck.filter(ok));
      if (!c) return;
      e.player(p).deck = e.shuffle(e.player(p).deck);
      e.toDeckTop(c.uid);
    },
  };

  E['Volcanic Doomfire'] = {
    cannotNormalSummon: true,
    summonRule: mustBeSummoned(true),
    cannotAttack: (e, _m, p) => noAttackPlayer(e, p),
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && e.activeSpells(p).some((c) => c.name === 'Tri-Blaze Accelerator'),
      *run(e, card, p) {
        const c = e.activeSpells(p).find((x) => x.name === 'Tri-Blaze Accelerator');
        if (!c) return;
        yield* e.sendToGrave(c.uid, 'cost');
        yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
    // "Your opponent must attack this monster": they cannot choose any other attack target (approximation: they are not forced to attack).
    attackGuard: (e, src, srcCtl, attacker, target) => e.controller(attacker.uid) === other(srcCtl) && target.uid !== src.uid && !!e.fieldCard(src.uid)?.faceUp,
    ...onBattleKill(function* (e, _me, victim, p) {
      if (e.find(victim.uid)?.loc.zone !== 'gy') return;
      const list = e.monsters(other(p));
      yield* e.destroy(list.map((m) => m.uid));
      const n = list.filter((m) => !e.fieldCard(m.uid)).length;
      if (n) e.damage(other(p), 500 * n);
    }),
  };

  E['Volcanic Hammerer'] = {
    ignition: {
      can: (e, _m, p) => e.player(p).gy.some((c) => isMonster(e, c) && named(c, 'Volcanic')),
      *run(e, m, p) {
        const n = e.player(p).gy.filter((c) => isMonster(e, c) && named(c, 'Volcanic')).length;
        if (e.fieldCard(m.uid)) tag(m).noAttackTurn = e.state.turn;
        e.damage(other(p), n * 200);
      },
    },
  };

  const rocket = function* (e: Engine, _m: FieldCard, p: Pid): Step {
    const ok = (c: Card) => named(c, 'Blaze Accelerator');
    const list = [...e.player(p).deck, ...e.player(p).gy].filter(ok);
    if (!list.length || !(yield* e.yesno(p, 'Volcanic Rocket: add a "Blaze Accelerator" card from your Deck or GY?'))) return;
    const c = yield* pickOne(e, p, 'Add which card?', list);
    if (!c) return;
    const fromDeck = e.find(c.uid)?.loc.zone === 'deck';
    e.toHandOf(c.uid, p);
    if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
  };
  E['Volcanic Rocket'] = { onSummon: rocket, onSpecialSummon: rocket };

  E['Volcanic Shell'] = {
    graveIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Volcanic Shell', p) && e.player(p).lp > 500 && e.player(p).deck.some((c) => c.name === 'Volcanic Shell'),
      *run(e, _card, p) {
        e.useOnce('Volcanic Shell', p);
        if (!payLp(e, p, 500)) return;
        yield* searchDeck(e, p, 'Add which Volcanic Shell?', (c) => c.name === 'Volcanic Shell');
      },
    },
  };

  E['Vortex Trooper'] = {
    *onSummon(e, _m, p, kind) {
      if (kind !== 'normal' || e.player(p).hand.length < 2 || !(yield* e.yesno(p, 'Vortex Trooper: shuffle 2 cards from your hand into the Deck, then draw 2?'))) return;
      const chosen = yield* pick(e, p, 'Shuffle which 2 cards into the Deck?', e.player(p).hand, 2, 2);
      if (!chosen || chosen.length < 2) return;
      for (const c of chosen) toDeck(e, c.uid);
      e.draw(p, 2);
    },
    *onDestroyed(e, _c, p) {
      e.draw(p, 1);
    },
  };

  E['Waking the Dragon'] = {
    *onLeaveField(e, fc, controller) {
      if (fc.faceUp || leftBy(fc) !== other(controller) || fc.owner !== controller || !freeMZ(e, controller)) return;
      const list = [...e.player(controller).deck.filter((c) => isMonster(e, c)), ...e.player(controller).fusion];
      if (!list.length || !(yield* e.yesno(controller, 'Waking the Dragon: Special Summon a monster from your Deck or Extra Deck?'))) return;
      yield* e.as(controller, (function* () {
        yield* summonOneOf(e, controller, 'Special Summon which monster?', list, 'atk');
      })());
    },
  };

  E['Wall of Disruption'] = {
    canActivate: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null,
    *resolve(e, _l, p) {
      const mons = e.monsters(other(p));
      for (const m of mons) if (m.faceUp && m.pos === 'atk') boostPerm(m, -800 * mons.length);
    },
  };

  E['Warrior Lady of the Wasteland'] = {
    *onDestroyed(e, _c, p, byBattle) {
      const ok = (c: Card) => isMonster(e, c) && attrOf(e, c) === 'EARTH' && info(e, c).race === 'Warrior' && (info(e, c).atk ?? 0) <= 1500;
      if (!byBattle || !freeMZ(e, p) || !e.player(p).deck.some(ok)) return;
      if (!(yield* e.yesno(p, 'Warrior Lady of the Wasteland: Special Summon an EARTH Warrior from your Deck?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which Warrior?', e.player(p).deck.filter(ok), 'atk');
    },
  };

  const byBonding = (e: Engine) => named(e.resolvingCard()?.name ?? '', 'Bonding');
  E['Water Dragon'] = {
    cannotNormalSummon: true,
    summonRule: mustBeSummoned(true, byBonding),
    aura: (e, _src, m) => (m.faceUp && (attrOf(e, m) === 'FIRE' || raceOf(e, m) === 'Pyro') ? { atk: -100000, def: 0 } : undefined),
    *onDestroyed(e, _c, p) {
      const gy = e.player(p).gy;
      const hyd = gy.filter((c) => c.name === 'Hydrogeddon');
      const oxy = gy.filter((c) => c.name === 'Oxygeddon');
      if (hyd.length < 2 || !oxy.length || freeMZCount(e, p) < 3) return;
      if (!(yield* e.yesno(p, 'Water Dragon: Special Summon 2 Hydrogeddon and 1 Oxygeddon from your GY?'))) return;
      for (const u of [hyd[0].uid, hyd[1].uid, oxy[0].uid]) yield* e.specialSummon(u, p, 'atk');
    },
  };

  E['Water Dragon Cluster'] = {
    cannotNormalSummon: true,
    summonRule: mustBeSummoned(true, byBonding),
    *onSpecialSummon(e, _m, p) {
      const opp = faceUpMonsters(e, other(p)).filter((m) => info(e, m).sub !== 'Normal');
      if (!opp.length || !(yield* e.yesno(p, "Water Dragon Cluster: negate your opponent's Effect Monsters and make their ATK 0 this turn?"))) return;
      for (const m of opp) {
        negateMonster(e, m, true);
        boostTurn(m, -e.atkOf(m));
      }
    },
    quick: {
      label: 'Tribute it to Special Summon 2 Water Dragon',
      can: (e, _c, p, t) => anyTime(t) && freeMZCount(e, p) >= 1 && [...e.player(p).hand, ...e.player(p).deck].filter((c) => c.name === 'Water Dragon').length >= 2,
      *cost(e, card, p) {
        e.log(p, `${e.player(p).name} Tributes Water Dragon Cluster`);
        yield* e.sendToGrave(card.uid, 'tribute');
      },
      *run(e, _c, p) {
        const ps = e.player(p);
        for (let i = 0; i < 2; i++) {
          const list = [...ps.hand, ...ps.deck].filter((c) => c.name === 'Water Dragon');
          if (!list.length || !freeMZ(e, p)) break;
          const c = yield* pickOne(e, p, 'Special Summon which Water Dragon?', list);
          if (!c) break;
          const fromDeck = e.find(c.uid)?.loc.zone === 'deck';
          yield* ignoringConditions(e, c.uid, e.specialSummon(c.uid, p, 'def'));
          if (fromDeck) ps.deck = e.shuffle(ps.deck);
        }
      },
    },
  };

  // Switches ATK/DEF with lasting modifiers, undone at the end of the opponent's next turn.
  E['Weapon Change'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    *onStandby(e, fc, p) {
      const list = targetable(e, faceUpMonsters(e, p).filter((m) => ['Warrior', 'Machine'].includes(raceOf(e, m))));
      if (e.state.turnPlayer !== p || !list.length || e.player(p).lp <= 700 || !(yield* e.yesno(p, 'Weapon Change: pay 700 LP to switch a monster\'s ATK and DEF?'))) return;
      const m = yield* pickOne(e, p, 'Switch the ATK and DEF of which monster?', list);
      if (!m || !payLp(e, p, 700)) return;
      const d = e.defOf(m) - e.atkOf(m);
      boostPerm(m, d, -d);
      ((e.state.fx.weaponChange ??= []) as { uid: number; d: number; until: number; src: number }[]).push({ uid: m.uid, d, until: e.state.turn + 1, src: fc.uid });
    },
    *onEndPhase(e, fc) {
      const list = (e.state.fx.weaponChange ?? []) as { uid: number; d: number; until: number; src: number }[];
      e.state.fx.weaponChange = list.filter((x) => {
        if (x.src !== fc.uid || x.until > e.state.turn) return true;
        const m = e.fieldCard(x.uid);
        if (m?.faceUp) boostPerm(m, -x.d, x.d);
        return false;
      });
    },
    *onLeaveField(e, fc) {
      const list = (e.state.fx.weaponChange ?? []) as { uid: number; d: number; until: number; src: number }[];
      e.state.fx.weaponChange = list.filter((x) => {
        if (x.src !== fc.uid) return true;
        const m = e.fieldCard(x.uid);
        if (m?.faceUp) boostPerm(m, -x.d, x.d);
        return false;
      });
    },
  };

  E['White Dragon Ritual'] = h.ritualSpell();

  const elephantOk = (e: Engine, m: FieldCard) => m.faceUp && (info(e, m).sub === 'Normal' || !!info(e, m).vanilla);
  E["White Elephant's Gift"] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.monsters(p).some((m) => elephantOk(e, m)) && e.player(p).deck.length >= 2,
    *activate(e, _l, p) {
      const m = yield* pickOne(e, p, 'Send which non-Effect monster to the GY?', e.monsters(p).filter((x) => elephantOk(e, x)), true);
      if (!m) return false;
      yield* e.sendToGrave(m.uid, 'cost');
    },
    *resolve(e, _l, p) {
      e.draw(p, 2);
    },
  };

  E['Wicked-Breaking Flamberge - Baou'] = h.equip(() => ({ atk: 500, def: 0 }), {
    // On an Equip Spell, the engine (audit-10) applies this to the monster it is equipped to.
    negatesBattleVictims: (e, eq, killer) => eq.equippedTo === killer.uid,
    activateCost: {
      can: (e, c, p) => e.player(p).hand.some((x) => x.uid !== c.uid),
      *pay(e, c, p) {
        const x = yield* pickOne(e, p, 'Send which card from your hand to the GY?', e.player(p).hand.filter((y) => y.uid !== c.uid), true);
        if (!x) return false;
        yield* e.sendToGrave(x.uid, 'cost');
      },
    },
  });

  const blazeCards = (e: Engine, p: Pid) => e.activeSpells(p).filter((c) => named(c, 'Blaze Accelerator'));
  E['Wild Fire'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.player(p).lp > 500 && blazeCards(e, p).length > 0,
    *activate(e, _l, p) {
      if (!payLp(e, p, 500)) return false;
    },
    *resolve(e, _l, p) {
      const b = yield* pickOne(e, p, 'Destroy which "Blaze Accelerator" card?', blazeCards(e, p));
      if (!b) return;
      yield* e.destroy([b.uid]);
      yield* e.destroy(allMonsters(e).map((m) => m.uid));
      e.createToken('Wild Fire Token', p, 'atk', true, { atk: 1000, def: 1000, level: 3, attribute: 'FIRE', race: 'Pyro' });
      noAttacksThisTurn(e, p);
    },
  };

  const wildBeasts = (e: Engine) => targetable(e, faceUpMonsters(e).filter((m) => ['Beast', 'Beast-Warrior'].includes(raceOf(e, m))));
  E["Wild Nature's Release"] = {
    canActivate: (e, _c, _p, t) => isMain(t) && wildBeasts(e).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, "Wild Nature's Release: target which monster?", wildBeasts(e), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link) {
      const m = fieldTarget(e, link);
      if (!m?.faceUp) return;
      boostTurn(m, e.defOf(m));
      m.doomAt = e.state.turn;
    },
  };

  const faceUpInST = (e: Engine, self: number) => [...e.spells(0), ...e.spells(1)].filter((c) => c.faceUp && c.uid !== self);
  E['Wild Tornado'] = {
    canActivate: (e, c, _p, t) => anyTime(t) && faceUpInST(e, c.uid).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Wild Tornado: destroy which face-up card?', faceUpInST(e, link.card.uid), true);
      if (!c) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link) {
      const c = fieldTarget(e, link);
      if (!c || !c.faceUp) return;
      const q = ctrl(e, c);
      yield* e.destroy([c.uid]);
      const sets = e.player(q).hand.filter((x) => (isSpell(e, x) && info(e, x).sub !== 'Field') || isTrap(e, x));
      if (!sets.length || freeST(e, q) < 0 || !(yield* e.yesno(q, 'Wild Tornado: Set a Spell/Trap from your hand?'))) return;
      const s = yield* pickOne(e, q, 'Set which card?', sets, true);
      if (s && placeST(e, s.uid, q, false)) e.log(q, `${e.player(q).name} Set a card`);
    },
    *onLeaveField(e, fc, controller, reason) {
      if (fc.faceUp || reason !== 'destroyed') return;
      const list = [...targetable(e, faceUpMonsters(e)), ...allST(e).filter((c) => c.faceUp)];
      if (!list.length) return;
      yield* e.as(controller, (function* () {
        const t = yield* pickOne(e, controller, 'Wild Tornado: destroy which face-up card?', list);
        if (t && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
      })());
    },
  };

  E['Winged Kuriboh'] = {
    *onDestroyed(e, _c, p) {
      noBattleDamage(e, p, true);
      e.log(p, `${e.player(p).name} takes no battle damage this turn`);
    },
  };

  E['Wonder Garage'] = {
    *onLeaveField(e, fc, controller, reason) {
      if (fc.faceUp || reason !== 'destroyed' || !freeMZ(e, controller)) return;
      const ok = (c: Card) => isMonster(e, c) && levelOf(e, c) <= 4 && info(e, c).race === 'Machine' && named(c, 'roid');
      if (!e.player(controller).hand.some(ok) || !(yield* e.yesno(controller, 'Wonder Garage: Special Summon a "roid" monster from your hand?'))) return;
      yield* summonOneOf(e, controller, 'Special Summon which monster?', e.player(controller).hand.filter(ok), 'atk');
    },
  };

  E['Wonder Wand'] = h.equipFor((e, m) => raceOf(e, m) === 'Spellcaster', () => ({ atk: 500, def: 0 }), {
    ignition: {
      repeat: true,
      can: (e, m, p) => m.equippedTo !== undefined && !!e.fieldCard(m.equippedTo) && e.controller(m.equippedTo) === p,
      *run(e, m, p) {
        const host = m.equippedTo !== undefined ? e.fieldCard(m.equippedTo) : null;
        if (!host || e.controller(host.uid) !== p) return;
        yield* e.sendToGrave(host.uid, 'cost');
        if (e.fieldCard(m.uid)) yield* e.sendToGrave(m.uid, 'cost');
        e.draw(p, 2);
      },
    },
  });

  E['Wroughtweiler'] = {
    *onDestroyed(e, _c, p, byBattle) {
      const gy = e.player(p).gy;
      const hero = gy.filter((c) => named(c, 'Elemental HERO'));
      const poly = gy.filter((c) => c.name === 'Polymerization');
      if (!byBattle || !hero.length || !poly.length) return;
      const a = yield* pickOne(e, p, 'Wroughtweiler: add which "Elemental HERO" card?', hero);
      const b = yield* pickOne(e, p, 'Add which Polymerization?', poly);
      if (a) e.toHandOf(a.uid, p);
      if (b) e.toHandOf(b.uid, p);
    },
  };

  E['Yomi Ship'] = {
    *onDestroyed(e, card, _p, byBattle) {
      const b = e.state.battle;
      if (!byBattle || !b) return;
      const foe = b.attacker === card.uid ? b.target : b.attacker;
      if (foe != null && e.fieldCard(foe)) yield* e.destroy([foe]);
    },
  };

  E['Zero Gravity'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && faceUpMonsters(e).length > 0,
    *resolve(e) {
      for (const m of faceUpMonsters(e)) {
        m.pos = m.pos === 'atk' ? 'def' : 'atk';
        e.event('position', { uid: m.uid });
      }
      e.log(null, 'Every face-up monster changes its battle position');
    },
  };

  E['Zolga'] = {
    *onLeaveField(e, fc, _controller, reason) {
      if (reason === 'tribute' && e.actor === null) e.gainLp(fc.owner, 2000);
    },
  };

  E['Zoma the Spirit'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && freeMZ(e, p),
    *resolve(e, link, p) {
      if (!freeMZ(e, p) || !e.fieldCard(link.card.uid)) return;
      ((e.state.fx.trapMonster ??= {}) as Record<number, unknown>)[link.card.uid] = { race: 'Zombie', attribute: 'DARK', level: 4 };
      yield* e.specialSummon(link.card.uid, p, 'def');
    },
    baseStats: (e, m) => (e.find(m.uid)?.loc.zone === 'mz' ? { atk: 1800, def: 500 } : undefined),
    *onDestroyed(e, card, p, byBattle) {
      const b = e.state.battle;
      if (!byBattle || !b) return;
      const foe = b.attacker === card.uid ? b.target : b.attacker;
      const m = foe != null ? e.fieldCard(foe) : null;
      if (m) e.damage(other(p), e.atkOf(m));
    },
  };

  E['Zombina'] = {
    onLeaveField: markLeave,
    *onDestroyed(e, card, p, byBattle) {
      if (card.owner !== p || !(byBattle || leftByOpp(e, card.uid))) return;
      const list = e.player(p).gy.filter((c) => isMonster(e, c) && c.name !== 'Zombina' && levelOf(e, c) <= 4 && !isExtraOrRitual(e, c));
      if (!list.length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Zombina: Special Summon a Level 4 or lower monster from your GY?'))) return;
      yield* summonOneOf(e, p, 'Special Summon which monster?', list, 'atk');
    },
  };

  E['Zombyra the Dark'] = {
    cannotAttack: (e, _m, p) => e.monsters(other(p)).length === 0,
    ...onBattleKill(function* (_e, me) {
      boostPerm(me, -200);
    }),
  };
}
