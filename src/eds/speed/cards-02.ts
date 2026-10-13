// Speed Duel card scripts, batch 02 (Big One Warrior ... Contact Gate).
import type { EffectDef } from '../effects';
import type { SpeedHelpers } from './helpers';
import {
  type Card,
  type Engine,
  type FieldCard,
  type Gen,
  type Pid,
  type Pos,
  type Step,
  allMonsters,
  allST,
  anyTime,
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
  isNormalMonster,
  isSpell,
  isTrap,
  levelOf,
  attrOf,
  millTop,
  named,
  negateLink,
  opponentAttack,
  opponentSummon,
  other,
  payLp,
  pick,
  pickOne,
  raceOf,
  searchDeck,
  stOf,
  boostTurn,
  summonOneOf,
  tag,
  targetable,
  toDeck,
} from './helpers';

// ---------- local helpers ----------
/** Is this card `n`, or always treated as `n` ("Red-Eyes B. Dragon" vs "Red-Eyes Black Dragon", "Harpie Lady 1"...)? */
const sameAs = (e: Engine, c: Card | string, n: string) => {
  const a = info(e, c);
  const b = e.info(n);
  return a.name === b.name || (a.id !== 0 && a.id === b.id) || (a.desc ?? '').includes(`always treated as "${n}"`);
};
const freeZones = (e: Engine, p: Pid) => e.player(p).mz.filter((z) => z === null).length;
const inZone = (e: Engine, uid: number, zone: string) => e.find(uid)?.loc.zone === zone;
const monstersIn = (e: Engine, cards: Card[], test: (c: Card) => boolean = () => true) => cards.filter((c) => isMonster(e, c) && test(c));
/** Ask Attack or Defense Position for a Special Summon whose position is the player's choice. */
function* choosePos(e: Engine, p: Pid, name: string): Gen<Pos> {
  const i = yield* chooseOption(e, p, `Special Summon ${name} in which position?`, ['Attack Position', 'Defense Position']);
  return i === 1 ? 'def' : 'atk';
}
/** Turns a monster face-up (Defense or Attack Position); a face-down monster's FLIP effect activates. */
function* flipUp(e: Engine, m: FieldCard, pos: Pos): Step {
  const wasDown = !m.faceUp;
  m.faceUp = true;
  m.pos = pos;
  e.event('position', { uid: m.uid });
  e.log(null, `${m.name} is changed to face-up ${pos === 'atk' ? 'Attack' : 'Defense'} Position`);
  const c = e.controller(m.uid);
  if (wasDown && c !== null) yield* e.flipEffect(m.uid, c);
  if (c !== null && e.fieldCard(m.uid)) yield* e.positionWatch(m, c); // audit-02: Attack the Moon! and other position watchers
}
/** Puts a monster card from the hand or the Monster Zone into the Spell & Trap Zone as an Equip Card. */
function* equipMonster(e: Engine, card: Card, host: FieldCard, p: Pid): Step {
  const zone = freeST(e, p);
  const f = e.find(card.uid);
  if (zone < 0 || !f || f.loc.player !== p || !e.fieldCard(host.uid) || !host.faceUp) return;
  const ps = e.player(p);
  if (f.loc.zone === 'hand') ps.hand = ps.hand.filter((c) => c.uid !== card.uid);
  else if (f.loc.zone === 'mz') {
    for (const u of (f.card as FieldCard).equips.slice()) yield* e.sendToGrave(u, 'used');
    if (!inZone(e, card.uid, 'mz') || !e.fieldCard(host.uid)) return;
    e.vacateMZ(ps, e.find(card.uid)!.loc.index);
  } else return;
  const fc: FieldCard = { uid: card.uid, name: card.name, owner: card.owner, pos: 'atk', faceUp: true, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true, equippedTo: host.uid };
  ps.sz[zone] = fc;
  host.equips.push(fc.uid);
  e.event('summon', { uid: fc.uid, player: p });
  e.log(p, `${card.name} is equipped to ${host.name}`);
}
/** Lets a player pick monsters one at a time until the chosen cards' Levels add up exactly to `total`. */
function* pickLevelSum(e: Engine, p: Pid, title: string, cands: Card[], total: number, maxN: number): Gen<Card[] | null> {
  for (let tries = 0; tries < 3; tries++) {
    const chosen = yield* pick(e, p, title, cands, 1, maxN, true);
    if (!chosen) return null;
    if (chosen.reduce((a, c) => a + levelOf(e, c), 0) === total) return chosen;
    e.log(p, `Those Levels do not add up to ${total}`);
  }
  return null;
}
const levelSumPossible = (e: Engine, cands: Card[], total: number, maxN: number) => {
  const lv = cands.map((c) => levelOf(e, c));
  for (let i = 0; i < lv.length; i++) {
    if (lv[i] === total) return true;
    if (maxN < 2) continue;
    for (let j = i + 1; j < lv.length; j++) {
      if (lv[i] + lv[j] === total) return true;
      if (maxN < 3) continue;
      for (let k = j + 1; k < lv.length; k++) if (lv[i] + lv[j] + lv[k] === total) return true;
    }
  }
  return false;
};

// ---------- Cloudian: Fog Counters live in tags.fog ----------
const fog = (m: FieldCard) => m.tags?.fog ?? 0;
const addFog = (e: Engine, m: FieldCard, n: number) => {
  if (n <= 0) return;
  tag(m).fog = fog(m) + n;
  e.log(null, `${n} Fog Counter${n > 1 ? 's' : ''} placed on ${m.name}`);
};
const totalFog = (e: Engine) => allMonsters(e).reduce((a, m) => a + fog(m), 0);
const isCloudian = (c: Card) => named(c, 'Cloudian');
/** "If this card is in face-up Defense Position, destroy it." (checked after summons, position changes, battles and each phase) */
function* cloudCheck(e: Engine, m: FieldCard): Step {
  const fc = e.fieldCard(m.uid);
  if (fc && fc.faceUp && fc.pos === 'def' && !e.isNegated(fc)) {
    e.log(null, `${fc.name} is in face-up Defense Position and is destroyed`);
    yield* e.destroy([fc.uid]);
  }
}
/** Shared Cloudian body: cannot be destroyed by battle, self-destructs in face-up Defense Position, optional Normal Summon counters. */
function cloudian(extra: Partial<EffectDef>, opts: { battleProof?: boolean; summonFog?: boolean } = {}): EffectDef {
  const { battleProof = true, summonFog = true } = opts;
  return {
    ...extra,
    ...(battleProof ? { battleProof: () => true } : {}),
    *onSummon(e, m, p, kind) {
      if (kind === 'normal' && summonFog) addFog(e, m, faceUpMonsters(e).filter(isCloudian).length);
      if (extra.onSummon) yield* extra.onSummon(e, m, p, kind);
      yield* cloudCheck(e, m);
    },
    *onSpecialSummon(e, m, p) {
      if (extra.onSpecialSummon) yield* extra.onSpecialSummon(e, m, p);
      yield* cloudCheck(e, m);
    },
    *onPositionChange(e, m) {
      yield* cloudCheck(e, m);
    },
    *onAttacked(e, target, _a, _c, destroyed) {
      if (!destroyed) yield* cloudCheck(e, target);
    },
    *onStandby(e, m) {
      yield* cloudCheck(e, m);
    },
    *onEndPhase(e, m) {
      yield* cloudCheck(e, m);
    },
    // audit-02: also checked after every action (positions changed by other cards' effects).
    *stateCheck(e, m) {
      yield* cloudCheck(e, m);
    },
  };
}
/** Removes `n` Fog Counters from anywhere on the field, the player choosing where. */
function* removeFogAnywhere(e: Engine, p: Pid, n: number): Gen<boolean> {
  for (let i = 0; i < n; i++) {
    const m = yield* pickOne(e, p, `Remove a Fog Counter from which monster? (${n - i} left)`, allMonsters(e).filter((x) => fog(x) > 0));
    if (!m) return false;
    tag(m).fog = fog(m) - 1;
  }
  return true;
}

// ---------- Bonding ----------
/** Picks one card named `n` from `pool` that is not already in `taken`. */
function* pickNamed(e: Engine, p: Pid, n: string, pool: Card[], taken: number[]): Gen<Card | null> {
  return yield* pickOne(e, p, `Choose ${n}`, pool.filter((c) => sameAs(e, c, n) && !taken.includes(c.uid)));
}
const countNamed = (e: Engine, pool: Card[], n: string) => pool.filter((c) => sameAs(e, c, n)).length;

export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  E['Big One Warrior'] = {
    summonProc: {
      can: (e, c, p) => freeMZ(e, p) && e.player(p).hand.some((x) => x.uid !== c.uid && isMonster(e, x) && levelOf(e, x) === 1),
      *run(e, c, p) {
        const x = yield* pickOne(e, p, 'Big One Warrior: send which Level 1 monster to the GY?', e.player(p).hand.filter((x) => x.uid !== c.uid && isMonster(e, x) && levelOf(e, x) === 1), true);
        if (!x) return;
        yield* e.sendToGrave(x.uid, 'cost');
        if (inZone(e, c.uid, 'hand') && freeMZ(e, p)) yield* e.specialSummon(c.uid, p, yield* choosePos(e, p, c.name));
      },
    },
  };

  E['Big Wave Small Wave'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.monsters(p).some((m) => m.faceUp && attrOf(e, m) === 'WATER'),
    *resolve(e, _l, p) {
      const list = e.monsters(p).filter((m) => m.faceUp && attrOf(e, m) === 'WATER');
      yield* e.destroy(list.map((m) => m.uid));
      const n = list.filter((m) => !e.fieldCard(m.uid)).length;
      const waters = () => monstersIn(e, e.player(p).hand, (c) => attrOf(e, c) === 'WATER' && !isExtraOrRitual(e, c));
      if (!n || !waters().length || !freeMZ(e, p) || !(yield* e.yesno(p, 'Big Wave Small Wave: Special Summon WATER monsters from your hand?'))) return;
      const chosen = yield* pick(e, p, `Special Summon up to ${n} WATER monsters`, waters(), 1, Math.min(n, freeZones(e, p)), true);
      for (const c of chosen ?? []) if (inZone(e, c.uid, 'hand') && freeMZ(e, p)) yield* e.specialSummon(c.uid, p, yield* choosePos(e, p, c.name));
    },
  };

  // audit-02: a continuous effect while Mammoth is face-up (it used to mark the monsters for good). A monster placed on the
  // field this turn counts as Summoned this turn; a Flip Summon is remembered in tags.flipAt.
  E['Big-Tusked Mammoth'] = {
    *onAnySummon(e, _w, _wc, m, _c, kind) {
      if (kind === 'flip') tag(m).flipAt = e.state.turn;
    },
    blocksAttack: (e, card, m, attacker) => attacker !== ctrl(e, card) && (m.placedTurn === e.state.turn || m.tags?.flipAt === e.state.turn),
  };

  E['Birdface'] = {
    *onDestroyed(e, card, _p, byBattle) {
      const p = card.owner;
      const ok = (c: Card) => sameAs(e, c, 'Harpie Lady') && isMonster(e, c);
      if (!byBattle || !e.player(p).deck.some(ok) || !(yield* e.yesno(p, 'Birdface: add a "Harpie Lady" from your Deck to your hand?'))) return;
      yield* searchDeck(e, p, 'Birdface: add which "Harpie Lady"?', ok);
    },
  };

  const gyNormals = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => isNormalMonster(e, c));
  // Approximated: when its monster leaves the field, Birthright is sent to the GY with it (as attached cards are), not destroyed.

  E['Birthright'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && freeMZ(e, p) && gyNormals(e, p).length > 0,
    *activate(e, link, p) {
      const c = yield* pickOne(e, p, 'Birthright: Special Summon which Normal Monster?', gyNormals(e, p), true);
      if (!c) return false;
      link.targetUid = c.uid;
    },
    *resolve(e, link, p) {
      const fc = e.fieldCard(link.card.uid);
      if (!fc) return;
      if (link.targetUid !== undefined && inZone(e, link.targetUid, 'gy') && freeMZ(e, p)) {
        yield* e.specialSummon(link.targetUid, p, 'atk');
        if (e.fieldCard(link.targetUid) && e.fieldCard(fc.uid)) return h.attachTo(e, fc, link.targetUid);
      }
      if (e.fieldCard(fc.uid)) yield* e.sendToGrave(fc.uid, 'used');
    },
    *onLeaveField(e, fc) {
      const host = fc.equippedTo !== undefined ? e.fieldCard(fc.equippedTo) : null;
      if (host) yield* e.destroy([host.uid]);
    },
  };

  E['Bitelon'] = { piercing: true };

  E['Black Brachios'] = {
    *onSummon(e, _m, p, kind) {
      if (kind !== 'normal') return;
      const m = yield* pickOne(e, p, 'Black Brachios: change which monster to face-up Defense Position? (cancel to skip)', targetable(e, allMonsters(e)).filter((x) => !(x.faceUp && x.pos === 'def')), true);
      if (m && e.fieldCard(m.uid)) yield* flipUp(e, m, 'def');
    },
  };

  const isNinja = (e: Engine, c: Card) => isMonster(e, c) && named(c, 'Ninja');
  const isNinjitsu = (c: Card) => named(c, 'Ninjitsu Art');
  const ninjaPool = (e: Engine, p: Pid, self: number) => [...e.player(p).hand, ...faceUpMonsters(e, p), ...e.activeSpells(p)].filter((c) => c.uid !== self);
  E['Black Dragon Ninja'] = {
    // audit-02: "Cannot be Special Summoned, except with the effect of a "Ninja" monster or "Ninjitsu Art" card".
    summonRule: (e, _c, _p, how) => {
      if (how !== 'special') return true;
      const src = e.resolvingCard();
      return !!src && (isNinja(e, src) || isNinjitsu(src));
    },
    quick: {
      label: 'banish a monster',
      can: (e, card, p, t) => anyTime(t) && ninjaPool(e, p, card.uid).some((c) => isNinja(e, c)) && ninjaPool(e, p, card.uid).some(isNinjitsu) && targetable(e, allMonsters(e)).some((m) => m.uid !== card.uid),
      *cost(e, card, p, link) {
        const a = yield* pickOne(e, p, 'Send which "Ninja" monster to the GY?', ninjaPool(e, p, card.uid).filter((c) => isNinja(e, c)), true);
        if (!a) return false;
        const b = yield* pickOne(e, p, 'Send which "Ninjitsu Art" card to the GY?', ninjaPool(e, p, card.uid).filter((c) => isNinjitsu(c) && c.uid !== a.uid), true);
        if (!b) return false;
        yield* e.sendToGrave(a.uid, 'cost');
        yield* e.sendToGrave(b.uid, 'cost');
        const t = yield* pickOne(e, p, 'Black Dragon Ninja: banish which monster?', targetable(e, allMonsters(e)).filter((m) => m.uid !== card.uid));
        if (!t) return false;
        link.targetUid = t.uid;
      },
      *run(e, card, _p, link) {
        if (link.targetUid === undefined || !e.fieldCard(link.targetUid)) return;
        e.banish(link.targetUid);
        ((e.state.fx.bdn ??= {}) as Record<number, number[]>)[card.uid] = [...(e.state.fx.bdn[card.uid] ?? []), link.targetUid];
      },
    },
    *onLeaveField(e, fc) {
      const list = ((e.state.fx.bdn ?? {}) as Record<number, number[]>)[fc.uid] ?? [];
      delete e.state.fx.bdn?.[fc.uid];
      for (const u of list) {
        const f = e.find(u);
        if (f && f.loc.zone === 'removed' && isMonster(e, f.card) && freeMZ(e, f.card.owner)) yield* e.specialSummon(u, f.card.owner, 'atk');
      }
    },
  };

  const rebd = (e: Engine, c: Card) => sameAs(e, c, 'Red-Eyes B. Dragon');
  E["Black Dragon's Chick"] = {
    ignition: {
      can: (e, _m, p) => e.player(p).hand.some((c) => rebd(e, c)),
      *run(e, m, p) {
        if (!e.fieldCard(m.uid) || !m.faceUp) return;
        yield* e.sendToGrave(m.uid, 'cost');
        yield* summonOneOf(e, p, 'Special Summon which "Red-Eyes B. Dragon"?', e.player(p).hand.filter((c) => rebd(e, c)), 'atk');
      },
    },
  };

  const redEyesHosts = (e: Engine, p: Pid, self: number) => targetable(e, faceUpMonsters(e, p)).filter((m) => m.uid !== self && named(m, 'Red-Eyes'));
  function* bmdEquip(e: Engine, card: Card, p: Pid): Step {
    const host = yield* pickOne(e, p, 'Black Metal Dragon: equip to which "Red-Eyes" monster?', redEyesHosts(e, p, card.uid), true);
    if (host) yield* equipMonster(e, card, host, p);
  }
  E['Black Metal Dragon'] = {
    ignition: {
      can: (e, m, p) => inZone(e, m.uid, 'mz') && freeST(e, p) >= 0 && redEyesHosts(e, p, m.uid).length > 0,
      *run(e, m, p) {
        if (inZone(e, m.uid, 'mz')) yield* bmdEquip(e, m, p);
      },
    },
    handIgnition: {
      can: (e, _c, p) => freeST(e, p) >= 0 && redEyesHosts(e, p, -1).length > 0,
      run: bmdEquip,
    },
    equipBonus: () => ({ atk: 600, def: 0 }),
    *onSentToGrave(e, _card, owner, from) {
      const ok = (c: Card) => named(c, 'Red-Eyes');
      if ((from !== 'mz' && from !== 'sz') || !e.player(owner).deck.some(ok) || !(yield* e.yesno(owner, 'Black Metal Dragon: add a "Red-Eyes" card from your Deck to your hand?'))) return;
      yield* searchDeck(e, owner, 'Add which "Red-Eyes" card?', ok);
    },
  };

  E['Black Ptera'] = {
    *onDestroyed(e, card, _p, byBattle) {
      if (byBattle) e.state.fx.pteraBattle = card.uid;
    },
    *onSentToGrave(e, card, _owner, from) {
      if (from !== 'mz') return;
      if (e.state.fx.pteraBattle === card.uid) {
        e.state.fx.pteraBattle = undefined;
        return;
      }
      if (inZone(e, card.uid, 'gy')) {
        e.toHand(card.uid);
        e.log(card.owner, 'Black Ptera returns to the hand');
      }
    },
  };

  // Simplification: it cannot be activated from the hand.
  E['Black Sonic'] = {
    canActivate: (e, _c, p, t, ctx) => {
      if (opponentAttack(e, p, t, ctx) === null || e.state.battle?.target == null) return false;
      const target = e.fieldCard(e.state.battle.target);
      return !!target && target.faceUp && ctrl(e, target) === p && named(target, 'Blackwing');
    },
    *resolve(e, _l, p) {
      for (const m of e.monsters(other(p)).filter((m) => m.faceUp && m.pos === 'atk')) e.banish(m.uid);
    },
  };

  E['Black Stego'] = {
    *onBeingAttacked(e, target) {
      if (target.pos !== 'atk') return;
      target.pos = 'def';
      e.event('position', { uid: target.uid });
      e.log(null, 'Black Stego changes to Defense Position');
    },
  };

  E['Black Tyranno'] = {
    directAttack: (e, _m, p) => stOf(e, other(p)).length === 0 && e.monsters(other(p)).length > 0 && e.monsters(other(p)).every((m) => m.pos === 'def'),
  };

  // The Damage Step bonus applies from the attack declaration on.
  E['Black Veloci'] = {
    selfBonus: (e, m) => {
      const b = e.state.battle;
      if (b?.attacker === m.uid && b.target !== null) return { atk: 400, def: 0 };
      if (b?.target === m.uid) return { atk: -400, def: 0 };
      return { atk: 0, def: 0 };
    },
  };

  E['Blade Bounzer'] = {
    *afterBattle(e, a, _t, p) {
      const key = `Blade Bounzer:${a.uid}`;
      if (!e.monsters(other(p)).length || !e.oncePerTurn(key, p) || !e.player(p).hand.length) return;
      if (!(yield* e.yesno(p, 'Blade Bounzer: discard 1 card to attack again?'))) return;
      if (!(yield* discardCost(e, p, 1))) return;
      e.useOnce(key, p);
      if (e.fieldCard(a.uid)) (a.attacked = false), (tag(a).noDirectTurn = e.state.turn); // audit-02: the second attack must be on a monster
    },
  };

  E['Blade Knight'] = {
    selfBonus: (e, m) => ({ atk: e.player(ctrl(e, m)).hand.length <= 1 ? 400 : 0, def: 0 }),
    // audit-02: "If you control no other monsters, the effects of Flip monsters destroyed by battle with this card are negated."
    negatesBattleFlip: (e, a) => e.monsters(ctrl(e, a)).every((m) => m.uid === a.uid),
  };

  const lowPyro = (e: Engine, p: Pid) => monstersIn(e, e.player(p).hand, (c) => info(e, c).race === 'Pyro' && (info(e, c).atk ?? 0) <= 500);
  E['Blaze Accelerator'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    // "You cannot declare an attack during the turn you activate this effect": monsters Summoned later this turn too.
    blocksAttack: (e, card, _m, attacker) => attacker === ctrl(e, card) && card.tags?.blazeTurn === e.state.turn,
    ignition: {
      repeat: true,
      can: (e, _m, p) => lowPyro(e, p).length > 0 && targetable(e, e.monsters(other(p))).length > 0,
      *run(e, _m, p) {
        const t = yield* pickOne(e, p, 'Blaze Accelerator: destroy which monster?', targetable(e, e.monsters(other(p))), true);
        if (!t) return;
        const c = yield* pickOne(e, p, 'Send which Pyro monster to the GY?', lowPyro(e, p), true);
        if (!c) return;
        for (const m of e.monsters(p)) tag(m).noAttackTurn = e.state.turn;
        tag(_m).blazeTurn = e.state.turn;
        yield* e.sendToGrave(c.uid, 'cost');
        if (inZone(e, c.uid, 'gy') && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
      },
    },
  };

  const thunderbirdOk = (e: Engine, c: Card) => isMonster(e, c) && attrOf(e, c) === 'WATER' && info(e, c).race === 'Winged Beast' && c.name !== 'Blizzard Thunderbird';
  E['Blizzard Thunderbird'] = {
    ignition: {
      can: (e, _m, p) => e.oncePerTurn('Blizzard Thunderbird', p) && freeZones(e, p) >= 2 && e.player(p).gy.some((c) => thunderbirdOk(e, c)) && e.player(p).hand.length >= 2 && e.player(p).hand.some((c) => thunderbirdOk(e, c)),
      *run(e, m, p) {
        e.useOnce('Blizzard Thunderbird', p);
        const hand = e.player(p).hand;
        const targets = hand.filter((c) => thunderbirdOk(e, c));
        if (!targets.length || hand.length < 2) return;
        const keep = targets.length === 1 ? targets[0].uid : undefined;
        if (!(yield* discardCost(e, p, 1, () => true, keep))) return;
        if (freeZones(e, p) < 2) return;
        const a = yield* pickOne(e, p, 'Special Summon which monster from your hand?', e.player(p).hand.filter((c) => thunderbirdOk(e, c)));
        const b = yield* pickOne(e, p, 'Special Summon which monster from your GY?', e.player(p).gy.filter((c) => thunderbirdOk(e, c)));
        if (!a || !b) return;
        yield* e.specialSummon(a.uid, p, yield* choosePos(e, p, a.name));
        if (freeMZ(e, p) && inZone(e, b.uid, 'gy')) yield* e.specialSummon(b.uid, p, yield* choosePos(e, p, b.name));
        if (e.fieldCard(m.uid)) e.toHand(m.uid);
      },
    },
  };

  const earthFor = (e: Engine, p: Pid, self: number) => monstersIn(e, [...e.player(p).hand, ...e.player(p).gy], (c) => c.uid !== self && attrOf(e, c) === 'EARTH');
  function* blockDragonProc(e: Engine, c: Card, p: Pid): Step {
    const mats = yield* pick(e, p, 'Block Dragon: banish 3 EARTH monsters from your hand and/or GY', earthFor(e, p, c.uid), 3, 3, true);
    if (!mats) return;
    for (const m of mats) e.banish(m.uid);
    if (freeMZ(e, p)) yield* e.specialSummon(c.uid, p, yield* choosePos(e, p, c.name));
  }
  const rocksIn = (e: Engine, p: Pid) => monstersIn(e, e.player(p).deck, (c) => info(e, c).race === 'Rock');
  E['Block Dragon'] = {
    cannotNormalSummon: true,
    summonProc: { can: (e, c, p) => freeMZ(e, p) && earthFor(e, p, c.uid).length >= 3, run: blockDragonProc },
    graveIgnition: { can: (e, c, p) => freeMZ(e, p) && earthFor(e, p, c.uid).length >= 3, run: blockDragonProc },
    shields: (e, _src, target, how, sc) => how === 'effect' && target.faceUp && ctrl(e, target) === sc && raceOf(e, target) === 'Rock',
    *onSentToGrave(e, _card, p, from) {
      if (from !== 'mz' || !e.oncePerTurn('Block Dragon', p) || !levelSumPossible(e, rocksIn(e, p), 8, 3)) return;
      if (!(yield* e.yesno(p, 'Block Dragon: add Rock monsters with total Level 8 from your Deck?'))) return;
      e.useOnce('Block Dragon', p);
      const chosen = yield* pickLevelSum(e, p, 'Add up to 3 Rock monsters whose Levels total 8', rocksIn(e, p), 8, 3);
      for (const c of chosen ?? []) e.toHandOf(c.uid, p);
      if (chosen) e.player(p).deck = e.shuffle(e.player(p).deck);
    },
  };

  const golemTargets = (e: Engine, p: Pid) => monstersIn(e, e.player(p).gy, (c) => info(e, c).race === 'Rock' && levelOf(e, c) <= 4 && c.name !== 'Block Golem' && !isExtraOrRitual(e, c));
  E['Block Golem'] = {
    ignition: {
      can: (e, _m, p) => monstersIn(e, e.player(p).gy).every((c) => attrOf(e, c) === 'EARTH') && golemTargets(e, p).length >= 2 && freeZones(e, p) + 1 >= 2,
      *run(e, m, p) {
        if (!e.fieldCard(m.uid)) return;
        yield* e.sendToGrave(m.uid, 'tribute');
        const list = yield* pick(e, p, 'Block Golem: Special Summon which 2 Rock monsters?', golemTargets(e, p), 2, 2);
        for (const c of list ?? []) {
          if (!inZone(e, c.uid, 'gy') || !freeMZ(e, p)) continue;
          yield* e.specialSummon(c.uid, p, 'atk');
          const fc = e.fieldCard(c.uid);
          if (fc) fc.effectUsed = true;
        }
      },
    },
  };

  E['Blood Sucker'] = {
    *onBattleDamage(e, _a, p) {
      yield* millTop(e, other(p), 1);
    },
  };

  const oppCards = (e: Engine, p: Pid) => [...targetable(e, e.monsters(other(p))), ...stOf(e, other(p))];
  E['Blowback Dragon'] = {
    ignition: {
      can: (e, _m, p) => oppCards(e, p).length > 0,
      *run(e, _m, p) {
        const t = yield* pickOne(e, p, 'Blowback Dragon: target which card?', oppCards(e, p));
        if (!t) return;
        let heads = 0;
        for (let i = 0; i < 3; i++) heads += e.roll(2) === 1 ? 1 : 0;
        e.log(p, `Blowback Dragon: ${heads} of 3 coin tosses are Heads`);
        if (heads >= 2 && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
      },
    },
  };

  E['Blue Dragon Summoner'] = {
    *onSentToGrave(e, _card, p, from) {
      const ok = (c: Card) => isNormalMonster(e, c) && ['Dragon', 'Warrior', 'Spellcaster'].includes(info(e, c).race ?? '');
      if (from !== 'mz' || !e.player(p).deck.some(ok) || !(yield* e.yesno(p, 'Blue Dragon Summoner: add a Dragon, Warrior or Spellcaster Normal Monster from your Deck?'))) return;
      yield* searchDeck(e, p, 'Add which Normal Monster?', ok);
    },
  };

  // "Destroyed by your opponent's card": battle, or the effect that destroyed it belonged to the opponent (recorded as it left the field).
  const leftBy = (e: Engine) => (e.state.fx.leftBy ??= {}) as Record<number, number | null>;
  const fireWarriors = (e: Engine, p: Pid, self: number) => monstersIn(e, e.player(p).gy, (c) => c.uid !== self && attrOf(e, c) === 'FIRE' && info(e, c).race === 'Warrior' && !isExtraOrRitual(e, c));
  const otherWarriors = (e: Engine, p: Pid, self: number) => targetable(e, faceUpMonsters(e, p)).filter((m) => m.uid !== self && raceOf(e, m) === 'Warrior');
  E['Blue Flame Swordsman'] = {
    quick: {
      label: 'move 600 ATK to another Warrior',
      can: (e, card, p) => e.state.phase === 'BP' && e.atkOf(card as FieldCard) >= 600 && otherWarriors(e, p, card.uid).length > 0,
      *cost(e, card, p, link) {
        const t = yield* pickOne(e, p, 'Blue Flame Swordsman: which Warrior gains 600 ATK?', otherWarriors(e, p, card.uid), true);
        if (!t) return false;
        link.targetUid = t.uid;
      },
      *run(e, card, p, link) {
        const me = e.fieldCard(card.uid);
        const t = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
        if (!me || !me.faceUp || e.atkOf(me) < 600 || !t || !t.faceUp || ctrl(e, t) !== p) return;
        boostTurn(me, -600);
        boostTurn(t, 600);
      },
    },
    *onLeaveField(e, fc) {
      leftBy(e)[fc.uid] = e.actor;
    },
    *onDestroyed(e, card, p, byBattle) {
      const by = leftBy(e)[card.uid];
      delete leftBy(e)[card.uid];
      if (card.owner !== p || !(byBattle || by === other(p)) || !freeMZ(e, p) || !fireWarriors(e, p, card.uid).length) return;
      if (!(yield* e.yesno(p, 'Blue Flame Swordsman: banish it to Special Summon a FIRE Warrior from your GY?'))) return;
      const t = yield* pickOne(e, p, 'Special Summon which FIRE Warrior?', fireWarriors(e, p, card.uid));
      if (!t || !inZone(e, card.uid, 'gy')) return;
      e.banish(card.uid);
      if (inZone(e, t.uid, 'gy')) yield* e.specialSummon(t.uid, p, yield* choosePos(e, p, t.name));
    },
  };

  // ----- Bonding -----
  const bondingSpell = (mats: [string, number][], fromHand: boolean, results: string[]): EffectDef => {
    const pool = (e: Engine, p: Pid) => [...e.monsters(p), ...(fromHand ? monstersIn(e, e.player(p).hand) : [])];
    const resultsFor = (e: Engine, p: Pid) => monstersIn(e, [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy], (c) => results.some((r) => sameAs(e, c, r)));
    return {
      canActivate: (e, _c, p, t) => isMain(t) && mats.every(([n, k]) => countNamed(e, pool(e, p), n) >= k) && resultsFor(e, p).length > 0 && (freeMZ(e, p) || e.monsters(p).some((m) => mats.some(([n]) => sameAs(e, m, n)))),
      *activate(e, link, p) {
        const taken: number[] = [];
        for (const [n, k] of mats) {
          for (let i = 0; i < k; i++) {
            const c = yield* pickNamed(e, p, n, pool(e, p), taken);
            if (!c) return false;
            taken.push(c.uid);
          }
        }
        for (const u of taken) {
          e.log(p, `${e.player(p).name} Tributes ${e.find(u)?.card.name}`);
          yield* e.sendToGrave(u, 'tribute');
        }
      },
      *resolve(e, _l, p) {
        yield* summonOneOf(e, p, `${results.join(' or ')}: Special Summon which?`, resultsFor(e, p), 'atk');
      },
    };
  };
  E['Bonding - D2O'] = {
    ...bondingSpell([['Duoterion', 2], ['Oxygeddon', 1]], true, ['Water Dragon', 'Water Dragon Cluster']),
    // audit-02: "If "Water Dragon" or "Water Dragon Cluster" is sent from the field to your GY while this card is in your GY: Add this card to your hand." (once per turn)
    *watchGrave(e, card, owner, zone, events) {
      if (zone !== 'gy' || !e.oncePerTurn('Bonding - D2O', owner)) return;
      if (!events.some((v) => v.from === 'mz' && v.toGy && v.card.owner === owner && (sameAs(e, v.card, 'Water Dragon') || sameAs(e, v.card, 'Water Dragon Cluster')))) return;
      e.useOnce('Bonding - D2O', owner);
      e.toHandOf(card.uid, owner);
      e.log(owner, 'Bonding - D2O returns to the hand');
    },
  };
  E['Bonding - H2O'] = bondingSpell([['Hydrogeddon', 2], ['Oxygeddon', 1]], false, ['Water Dragon']);
  const dhoPool = (e: Engine, p: Pid) => monstersIn(e, [...e.player(p).hand, ...e.player(p).gy]);
  const dhoMats = ['Duoterion', 'Hydrogeddon', 'Oxygeddon'];
  const clusters = (e: Engine, p: Pid) => dhoPool(e, p).filter((c) => sameAs(e, c, 'Water Dragon Cluster'));
  const waterDragons = (e: Engine, p: Pid) => monstersIn(e, [...e.player(p).deck, ...e.player(p).gy], (c) => sameAs(e, c, 'Water Dragon') || sameAs(e, c, 'Water Dragon Cluster'));
  E['Bonding - DHO'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && freeMZ(e, p) && dhoMats.every((n) => countNamed(e, dhoPool(e, p), n) >= 1) && clusters(e, p).length > 0,
    *activate(e, _link, p) {
      const taken: number[] = [];
      for (const n of dhoMats) {
        const c = yield* pickNamed(e, p, n, dhoPool(e, p), taken);
        if (!c) return false;
        taken.push(c.uid);
      }
      for (const u of taken) toDeck(e, u);
      e.log(p, 'Bonding - DHO shuffles its materials into the Deck');
    },
    *resolve(e, _l, p) {
      yield* summonOneOf(e, p, 'Special Summon which "Water Dragon Cluster"?', clusters(e, p), 'atk');
    },
    graveIgnition: {
      can: (e, _c, p) => waterDragons(e, p).length > 0,
      *run(e, card, p) {
        const c = yield* pickOne(e, p, 'Bonding - DHO: add which "Water Dragon" card to your hand?', waterDragons(e, p), true);
        if (!c) return;
        e.banish(card.uid);
        const fromDeck = inZone(e, c.uid, 'deck');
        e.toHandOf(c.uid, p);
        if (fromDeck) e.player(p).deck = e.shuffle(e.player(p).deck);
      },
    },
  };

  E['Bonze Alone'] = {
    // audit-02: "Cannot be Normal or Special Summoned if you control a monster" (it used to be never Normal Summonable).
    summonRule: (e, _c, summoner, how) => how === 'set' || how === 'flip' || e.monsters(summoner).length === 0,
    summonProc: {
      can: (e, _c, p) => e.monsters(p).length === 0 && freeMZ(e, p),
      *run(e, c, p) {
        yield* e.specialSummon(c.uid, p, 'atk');
      },
    },
    *onAnySummon(e, w, wc, m, c) {
      if (c === wc && m.uid !== w.uid && e.fieldCard(w.uid)) yield* e.destroy([w.uid]);
    },
  };

  const lifeZombies = (e: Engine, p: Pid) => monstersIn(e, e.player(p).gy, (c) => info(e, c).race === 'Zombie' && !isExtraOrRitual(e, c));
  E['Book of Life'] = {
    canActivate: (e, _c, p, t) => isMain(t) && freeMZ(e, p) && lifeZombies(e, p).length > 0 && monstersIn(e, e.player(other(p)).gy).length > 0,
    *activate(e, link, p) {
      const z = yield* pickOne(e, p, 'Book of Life: Special Summon which Zombie?', lifeZombies(e, p), true);
      if (!z) return false;
      const o = yield* pickOne(e, p, "Book of Life: banish which monster from your opponent's GY?", monstersIn(e, e.player(other(p)).gy), true);
      if (!o) return false;
      link.payload = { z: z.uid, o: o.uid };
    },
    *resolve(e, link, p) {
      const { z, o } = link.payload as { z: number; o: number };
      if (inZone(e, z, 'gy') && freeMZ(e, p)) yield* e.specialSummon(z, p, yield* choosePos(e, p, e.find(z)!.card.name));
      if (inZone(e, o, 'gy')) e.banish(o);
    },
  };

  E['Book of Taiyou'] = {
    canActivate: (e, _c, _p, t) => isMain(t) && allMonsters(e).some((m) => !m.faceUp),
    *resolve(e, _l, p) {
      const m = yield* pickOne(e, p, 'Book of Taiyou: flip which face-down monster?', allMonsters(e).filter((m) => !m.faceUp));
      if (m) yield* flipUp(e, m, 'atk');
    },
  };

  E['Boot-Up Soldier - Dread Dynamo'] = {
    selfBonus: (e, m) => ({ atk: e.monsters(ctrl(e, m)).some((x) => x.faceUp && named(x, 'Gadget')) ? 2000 : 0, def: 0 }),
  };

  E['Bowganian'] = {
    *onStandby(e, _m, p) {
      if (e.state.turnPlayer === p) e.damage(other(p), 600);
    },
  };

  // Brain Crusher remembers the monsters it destroyed by battle this turn.
  const crushed = (e: Engine) => (e.state.fx.brainCrusher ??= {}) as Record<number, { u: number; t: number }[]>;
  const crush = (e: Engine, me: FieldCard, victim: FieldCard, p: Pid) => {
    if (victim.owner === p || !inZone(e, victim.uid, 'gy')) return;
    (crushed(e)[me.uid] ??= []).push({ u: victim.uid, t: e.state.turn });
  };
  E['Brain Crusher'] = {
    *afterBattle(e, a, t, p, destroyed) {
      if (destroyed) crush(e, a, t, p);
    },
    *onAttacked(e, target, attacker, p) {
      crush(e, target, attacker, p);
    },
    *onEndPhase(e, m, p) {
      const list = (crushed(e)[m.uid] ?? []).filter((x) => x.t === e.state.turn && inZone(e, x.u, 'gy')).map((x) => e.find(x.u)!.card);
      delete crushed(e)[m.uid];
      if (!list.length || !freeMZ(e, p) || !e.oncePerTurn(`Brain Crusher:${m.uid}`, p)) return;
      const c = yield* pickOne(e, p, 'Brain Crusher: Special Summon which destroyed monster? (cancel to skip)', list, true);
      if (!c) return;
      e.useOnce(`Brain Crusher:${m.uid}`, p);
      yield* e.specialSummon(c.uid, p, yield* choosePos(e, p, c.name));
    },
  };

  const brandedST = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => named(c, 'Branded') && !isMonster(e, c));
  // audit-02: Extra Deck monsters cannot be added to the hand, so they are not targets.
  const albazLinked = (e: Engine, c: Card) => isMonster(e, c) && !e.isExtraCard(c.name) && (c.name === 'Fallen of Albaz' || (info(e, c).desc ?? '').includes('"Fallen of Albaz"'));
  E['Branded Sword'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.oncePerTurn('Branded Sword', p) && freeMZ(e, p) && brandedST(e, p).length > 0,
    *activate(e, link, p) {
      const list = yield* pick(e, p, 'Branded Sword: banish how many "Branded" Spells/Traps?', brandedST(e, p), 1, freeZones(e, p), true);
      if (!list) return false;
      e.useOnce('Branded Sword', p);
      for (const c of list) e.banish(c.uid);
      link.payload = list.length;
    },
    *resolve(e, link, p) {
      for (let i = 0; i < (link.payload as number); i++) e.createToken('Iceblade Token', p, 'atk', true, { atk: 2500, def: 2000, level: 8, attribute: 'DARK', race: 'Dragon' });
    },
    graveIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Branded Sword', p) && e.player(p).removed.some((c) => albazLinked(e, c)),
      *run(e, card, p) {
        const c = yield* pickOne(e, p, 'Branded Sword: add which banished monster to your hand?', e.player(p).removed.filter((c) => albazLinked(e, c)), true);
        if (!c) return;
        e.useOnce('Branded Sword', p);
        e.banish(card.uid);
        e.toHandOf(c.uid, p);
      },
    },
  };

  E['Break! Draw!'] = h.equipFor((e, m) => raceOf(e, m) === 'Machine', undefined, {
    // audit-02: the equipped monster may be the attacker or the attacked monster (it used to draw only when attacking).
    *afterAnyBattle(e, eq, p, attacker, target) {
      const host = eq.equippedTo !== undefined ? e.fieldCard(eq.equippedTo) : null;
      if (!host || e.controller(host.uid) !== p || (host.uid !== attacker.uid && host.uid !== target.uid)) return;
      const victim = host.uid === attacker.uid ? target : attacker;
      if (victim.owner === p || !inZone(e, victim.uid, 'gy')) return;
      e.log(p, 'Break! Draw!');
      e.draw(p, 1);
    },
    *onEndPhase(e, fc, p) {
      if (e.state.turnPlayer !== p) return;
      tag(fc).ends = (fc.tags?.ends ?? 0) + 1;
      if (fc.tags!.ends >= 3) yield* e.destroy([fc.uid]);
    },
  });

  E['Breaker the Magical Warrior'] = {
    *onSummon(e, m, _p, kind) {
      if (kind === 'normal') m.counters = 1;
    },
    selfBonus: (_e, m) => ({ atk: 300 * m.counters, def: 0 }),
    ignition: {
      can: (e, m) => m.counters > 0 && allST(e).length > 0,
      *run(e, m, p) {
        if (m.counters < 1) return;
        m.counters--;
        const t = yield* pickOne(e, p, 'Breaker: destroy which Spell/Trap?', allST(e));
        if (t) yield* e.destroy([t.uid]);
      },
    },
  };

  E['Brron, Mad King of Dark World'] = {
    *onBattleDamage(e, _a, p) {
      if (e.player(p).hand.length && (yield* e.yesno(p, 'Brron: discard 1 card?'))) yield* discardCost(e, p, 1);
    },
  };

  const bujinMonsters = (e: Engine, p: Pid) => monstersIn(e, e.player(p).deck, (c) => named(c, 'Bujin') && !isExtraOrRitual(e, c));
  E['Bujingi Pavo'] = {
    quick: {
      from: 'hand',
      label: 'Special Summon a "Bujin" monster from the Deck',
      can: (e, _c, p, t, ctx) => {
        if (t !== 'destroyed' || ctx.uid === undefined || ctx.prevController !== p || !inZone(e, ctx.uid, 'gy')) return false;
        const c = e.find(ctx.uid)!.card;
        return named(c, 'Bujin') && info(e, c).race === 'Beast-Warrior' && freeMZ(e, p) && bujinMonsters(e, p).length > 0;
      },
      *cost(e, card) {
        yield* e.sendToGrave(card.uid, 'cost');
      },
      *run(e, _c, p) {
        yield* summonOneOf(e, p, 'Bujingi Pavo: Special Summon which "Bujin" monster?', bujinMonsters(e, p), 'atk');
      },
    },
  };

  const bewdOn = (e: Engine, p: Pid) => faceUpMonsters(e, p).filter((m) => sameAs(e, m, 'Blue-Eyes White Dragon'));
  E['Burst Stream of Destruction'] = {
    canActivate: (e, _c, p, t) => isMain(t) && bewdOn(e, p).length > 0 && e.monsters(other(p)).length > 0,
    *resolve(e, _l, p) {
      for (const m of bewdOn(e, p)) tag(m).noAttackTurn = e.state.turn;
      if (!bewdOn(e, p).length) return;
      yield* e.destroy(e.monsters(other(p)).map((m) => m.uid));
    },
  };

  function* byser(e: Engine): Step {
    const sets = [...allMonsters(e), ...allST(e)].filter((c) => !c.faceUp);
    for (const c of sets) if (e.fieldCard(c.uid)) e.toHand(c.uid);
    if (sets.length) e.log(null, `Byser Shock returns ${sets.length} Set card${sets.length > 1 ? 's' : ''} to the hand`);
  }
  E['Byser Shock'] = {
    *onSummon(e) {
      yield* byser(e);
    },
    *onSpecialSummon(e) {
      yield* byser(e);
    },
  };

  const lightDark = (e: Engine) => monstersIn(e, [...e.player(0).gy, ...e.player(1).gy], (c) => ['LIGHT', 'DARK'].includes(attrOf(e, c)));
  const druisCan = (e: Engine, p: Pid) => e.oncePerTurn('Bystial Druiswurm:1', p) && freeMZ(e, p) && lightDark(e).length > 0;
  E['Bystial Druiswurm'] = {
    handIgnition: {
      can: (e, _c, p) => druisCan(e, p),
      *run(e, card, p) {
        const t = yield* pickOne(e, p, 'Bystial Druiswurm: banish which LIGHT or DARK monster?', lightDark(e), true);
        if (!t) return;
        e.useOnce('Bystial Druiswurm:1', p);
        e.banish(t.uid);
        if (inZone(e, card.uid, 'hand') && freeMZ(e, p)) yield* e.specialSummon(card.uid, p, yield* choosePos(e, p, card.name));
      },
    },
    quick: {
      from: 'hand',
      label: 'banish a LIGHT/DARK monster from a GY and Special Summon it',
      can: (e, _c, p, t) => anyTime(t) && e.monsters(other(p)).length > 0 && druisCan(e, p),
      *cost(e, _c, p, link) {
        const t = yield* pickOne(e, p, 'Bystial Druiswurm: banish which LIGHT or DARK monster?', lightDark(e), true);
        if (!t) return false;
        e.useOnce('Bystial Druiswurm:1', p);
        link.targetUid = t.uid;
      },
      *run(e, card, p, link) {
        if (link.targetUid === undefined || !inZone(e, link.targetUid, 'gy')) return;
        e.banish(link.targetUid);
        if (inZone(e, card.uid, 'hand') && freeMZ(e, p)) yield* e.specialSummon(card.uid, p, yield* choosePos(e, p, card.name));
      },
    },
    *onSentToGrave(e, _card, p, from) {
      const list = targetable(e, e.monsters(other(p))).filter((m) => m.faceUp && (m.tags?.ss !== undefined || m.token)); // audit-02: tags.ss marks Special Summoned monsters
      if (from !== 'mz' || !list.length || !e.oncePerTurn('Bystial Druiswurm:2', p)) return;
      const t = yield* pickOne(e, p, "Bystial Druiswurm: send which of your opponent's Special Summoned monsters to the GY? (cancel to skip)", list, true);
      if (!t) return;
      e.useOnce('Bystial Druiswurm:2', p);
      yield* e.sendToGrave(t.uid, 'used');
    },
  };

  const gustos = (e: Engine, p: Pid) => monstersIn(e, e.player(p).gy, (c) => named(c, 'Gusto') && !e.isExtraCard(c.name)); // audit-02: into the Main Deck
  E['Caam, Serenity of Gusto'] = {
    ignition: {
      can: (e, _m, p) => gustos(e, p).length >= 2,
      *run(e, _m, p) {
        const list = yield* pick(e, p, 'Caam: shuffle which 2 "Gusto" monsters into the Deck?', gustos(e, p), 2, 2);
        if (!list || list.length < 2) return;
        for (const c of list) toDeck(e, c.uid);
        e.draw(p, 1);
      },
    },
  };

  const handZombies = (e: Engine, p: Pid) => monstersIn(e, e.player(p).hand, (c) => info(e, c).race === 'Zombie' && !isExtraOrRitual(e, c));
  E['Call of the Mummy'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    ignition: {
      repeat: true,
      can: (e, m, p) => e.oncePerTurn(`Call of the Mummy:${m.uid}`, p) && e.monsters(p).length === 0 && handZombies(e, p).length > 0,
      *run(e, m, p) {
        e.useOnce(`Call of the Mummy:${m.uid}`, p);
        if (e.monsters(p).length) return;
        const c = yield* pickOne(e, p, 'Call of the Mummy: Special Summon which Zombie?', handZombies(e, p));
        if (c) yield* e.specialSummon(c.uid, p, yield* choosePos(e, p, c.name));
      },
    },
  };

  const carbonTargets = (e: Engine, p: Pid) => monstersIn(e, [...e.player(p).hand, ...e.player(p).deck], (c) => isNormalMonster(e, c) && info(e, c).race === 'Dragon' && levelOf(e, c) <= 7);
  E['Carboneddon'] = {
    selfBonus: (e, m) => {
      const b = e.state.battle;
      if (!b || b.target === null || (b.attacker !== m.uid && b.target !== m.uid)) return { atk: 0, def: 0 };
      const foe = e.fieldCard(b.attacker === m.uid ? b.target : b.attacker);
      return { atk: foe && foe.faceUp && attrOf(e, foe) === 'FIRE' ? 1000 : 0, def: 0 };
    },
    graveIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Carboneddon', p) && freeMZ(e, p) && carbonTargets(e, p).length > 0,
      *run(e, card, p) {
        e.useOnce('Carboneddon', p);
        e.banish(card.uid);
        yield* summonOneOf(e, p, 'Carboneddon: Special Summon which Dragon Normal Monster?', carbonTargets(e, p), 'def');
      },
    },
  };

  E['Card Blocker'] = {
    *onSummon(e, m) {
      if (m.pos === 'atk') {
        m.pos = 'def';
        e.log(null, 'Card Blocker changes to Defense Position');
      }
    },
    *onSpecialSummon(e, m) {
      if (m.pos === 'atk') m.pos = 'def';
    },
    quick: {
      repeat: true,
      label: 'take the attack / reinforce its DEF',
      can: (e, card, p, t, ctx) => {
        if (opponentAttack(e, p, t, ctx) === null || e.state.battle?.target == null) return false;
        if (e.state.battle.target === card.uid) return e.player(p).deck.length > 0;
        const tg = e.fieldCard(e.state.battle.target);
        return !!tg && tg.faceUp && ctrl(e, tg) === p;
      },
      *run(e, card, p) {
        const b = e.state.battle;
        const me = e.fieldCard(card.uid);
        if (!b || !me || ctrl(e, me) !== p) return;
        if (b.target === card.uid) {
          const max = Math.min(3, e.player(p).deck.length);
          const i = yield* chooseOption(e, p, 'Card Blocker: send how many cards from the top of your Deck to the GY?', ['1', '2', '3'].slice(0, max));
          if (i === null) return;
          const before = e.player(p).gy.length;
          yield* millTop(e, p, i + 1);
          const n = Math.max(0, e.player(p).gy.length - before);
          if (e.fieldCard(me.uid)) boostTurn(me, 0, 500 * n);
          return;
        }
        const tg = b.target !== null ? e.fieldCard(b.target) : null;
        if (tg && ctrl(e, tg) === p && e.fieldCard(b.attacker)) {
          b.target = me.uid;
          e.log(p, 'Card Blocker becomes the attack target');
        }
      },
    },
  };

  E['Card Trooper'] = {
    ignition: {
      can: (e, _m, p) => e.player(p).deck.length > 0,
      *run(e, m, p) {
        const max = Math.min(3, e.player(p).deck.length);
        const i = yield* chooseOption(e, p, 'Card Trooper: send how many cards from the top of your Deck to the GY?', ['1', '2', '3'].slice(0, max));
        if (i === null) return;
        const before = e.player(p).gy.length;
        yield* millTop(e, p, i + 1);
        const n = Math.max(0, e.player(p).gy.length - before);
        if (e.fieldCard(m.uid) && m.faceUp) boostTurn(m, 500 * n);
      },
    },
    *onDestroyed(e, card, p) {
      if (card.owner === p) e.draw(p, 1);
    },
  };

  // "It becomes the End Phase": the turn skips to a Battle Phase in which nothing can attack, so the next step is the End Phase.
  E['Cardcar D'] = {
    cannotSpecialSummon: true, // audit-02
    *onSummon(e, m, _p, kind) {
      if (kind === 'normal') tag(m).nsTurn = e.state.turn;
    },
    ignition: {
      chain: false,
      can: (e, m, p) => e.state.phase === 'M1' && m.tags?.nsTurn === e.state.turn && e.player(p).deck.length >= 2,
      *run(e, m, p) {
        if (!e.fieldCard(m.uid)) return;
        yield* e.sendToGrave(m.uid, 'tribute');
        // audit-02: "You cannot Special Summon during the turn you activate this effect."
        ((e.state.fx.summonLocks ??= []) as unknown[]).push({ p, turn: e.state.turn, normal: false, special: true, only: [] });
        e.draw(p, 2);
        if (e.state.winner !== null) return;
        ((e.state.fx.noDeclare ??= [-1, -1]) as number[])[p] = e.state.turn;
        e.state.phase = 'BP';
        e.event('phase');
        e.log(p, 'Cardcar D: the turn moves on to the End Phase');
      },
    },
  };

  const forestRaces = ['Beast', 'Beast-Warrior', 'Winged Beast', 'Insect', 'Plant'];
  const carpiSearch = (e: Engine, c: Card) => isMonster(e, c) && (named(c, 'Mystical Beast of the Forest') || named(c, 'Mystical Spirit of the Forest')) && c.name !== 'Carpiponica, Mystical Beast of the Forest';
  function* carpiponicaSearch(e: Engine, p: Pid): Step {
    if (!e.oncePerTurn('Carpiponica:2', p) || !e.player(p).deck.some((c) => carpiSearch(e, c))) return;
    if (!(yield* e.yesno(p, 'Carpiponica: add a "Mystical Beast/Spirit of the Forest" monster from your Deck?'))) return;
    e.useOnce('Carpiponica:2', p);
    yield* searchDeck(e, p, 'Add which monster?', (c) => carpiSearch(e, c));
  }
  E['Carpiponica, Mystical Beast of the Forest'] = {
    *onSentToGrave(e, card, p, from) {
      const list = () => monstersIn(e, e.player(p).gy, (c) => c.uid !== card.uid && forestRaces.includes(info(e, c).race ?? ''));
      const races = new Set(list().map((c) => info(e, c).race));
      if (from !== 'hand' || races.size < 2 || !freeMZ(e, p) || !e.oncePerTurn('Carpiponica:1', p)) return;
      if (!(yield* e.yesno(p, 'Carpiponica: shuffle 2 monsters with different Types from your GY into the Deck to Special Summon it?'))) return;
      const a = yield* pickOne(e, p, 'Shuffle which monster into the Deck?', list());
      if (!a) return;
      const b = yield* pickOne(e, p, 'Shuffle which other monster (a different Type)?', list().filter((c) => c.uid !== a.uid && info(e, c).race !== info(e, a).race));
      if (!b) return;
      e.useOnce('Carpiponica:1', p);
      toDeck(e, a.uid);
      toDeck(e, b.uid);
      if (inZone(e, card.uid, 'gy') && freeMZ(e, p)) yield* e.specialSummon(card.uid, p, yield* choosePos(e, p, card.name));
    },
    *onSummon(e, _m, p, kind) {
      if (kind === 'normal') yield* carpiponicaSearch(e, p);
    },
    *onSpecialSummon(e, _m, p) {
      yield* carpiponicaSearch(e, p);
    },
  };

  // Banished when it leaves the field (only when it is sent to the GY).
  const banishOnLeave = (e: Engine) => (e.state.fx.banishOnLeaveMap ??= {}) as Record<number, number>;
  const cartoSummons = (e: Engine, p: Pid, self: number) => e.player(p).hand.filter((c) => c.uid !== self && isMonster(e, c) && ['EARTH', 'WATER'].includes(attrOf(e, c)) && e.canNormalSummon(p, c, undefined, true));
  E['Cartorhyn the Hidden Gem of the Seafront'] = {
    // audit-02: approximated, the additional Normal Summon of an EARTH or WATER monster happens right away (not later this turn).
    handIgnition: {
      can: (e, c, p) => e.oncePerTurn('Cartorhyn:1', p) && cartoSummons(e, p, c.uid).length > 0,
      *run(e, card, p) {
        e.useOnce('Cartorhyn:1', p);
        yield* e.discard(p, card.uid);
        const c = yield* pickOne(e, p, 'Cartorhyn: Normal Summon which EARTH or WATER monster? (cancel to skip)', cartoSummons(e, p, card.uid), true);
        if (!c) return;
        const set = (yield* chooseOption(e, p, `Normal Summon or Set ${c.name}?`, ['Normal Summon', 'Set'])) === 1;
        yield* e.extraNormalSummon(p, c.uid, set ? 'def' : 'atk', !set);
      },
    },
    graveIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Cartorhyn:2', p) && freeMZ(e, p) && faceUpMonsters(e, p).some((m) => attrOf(e, m) === 'EARTH') && faceUpMonsters(e, p).some((m) => attrOf(e, m) === 'WATER'),
      *run(e, card, p) {
        e.useOnce('Cartorhyn:2', p);
        yield* e.specialSummon(card.uid, p, yield* choosePos(e, p, card.name));
        if (e.fieldCard(card.uid)) banishOnLeave(e)[card.uid] = 1;
      },
    },
    *onSentToGrave(e, card, _p, from) {
      if (from === 'mz' && banishOnLeave(e)[card.uid]) {
        delete banishOnLeave(e)[card.uid];
        if (inZone(e, card.uid, 'gy')) e.banish(card.uid);
      }
    },
  };

  E['Cataclysmic Crusted Calcifida'] = {
    // audit-02: watches every destruction from the hand (it used to answer battle destruction only).
    *watchGrave(e, card, p, zone, events) {
      if (zone !== 'hand' || !e.oncePerTurn('Cataclysmic Crusted Calcifida', p) || !freeMZ(e, p)) return;
      const hit = events.some((v) => v.from === 'mz' && v.reason === 'destroyed' && v.faceUp && v.controller === p && !v.token && attrOf(e, v.card) === 'EARTH' && (v.byBattle || v.by === other(p)));
      if (!hit || !(yield* e.yesno(p, 'Cataclysmic Crusted Calcifida: Special Summon it from your hand?'))) return;
      e.useOnce('Cataclysmic Crusted Calcifida', p);
      if (!inZone(e, card.uid, 'hand') || !freeMZ(e, p)) return;
      yield* e.specialSummon(card.uid, p, yield* choosePos(e, p, card.name));
      if (e.player(p).deck.some((c) => isMonster(e, c)) && (yield* e.yesno(p, 'Calcifida: send 1 monster from your Deck to the GY?'))) yield* deckToGrave(e, p, 'Send which monster to the GY?', (c) => isMonster(e, c));
    },
  };

  E['Cestus of Dagla'] = h.equipFor((e, m) => raceOf(e, m) === 'Fairy', () => ({ atk: 500, def: 0 }), {
    *onBattleDamageDealt(e, card, attacker, p) {
      const n = (e.state.fx.hurt ?? [0, 0])[other(p)] as number;
      if (card.equippedTo === attacker.uid && n > 0) e.gainLp(p, n);
    },
  });

  E['Chainsaw Insect'] = {
    *afterBattle(e, _a, _t, p) {
      e.draw(other(p), 1);
    },
    *onAttacked(e, _t, _a, p, destroyed) {
      if (!destroyed) e.draw(other(p), 1);
    },
  };

  const championReady = (e: Engine, p: Pid) => faceUpMonsters(e, p).some((m) => isNormalMonster(e, m) && levelOf(e, m) >= 7);
  E["Champion's Vigilance"] = {
    canActivate: (e, c, p, t, ctx) => championReady(e, p) && (!!opponentSummon(e, p, t, ctx) || ((t === 'spell' || t === 'trap') && !!ctx.link && ctx.link.card.uid !== c.uid && ctx.link.player !== p)),
    *activate(_e, link, _p, ctx) {
      link.payload = ctx.link ? { link: ctx.link } : { uid: ctx.uid };
    },
    *resolve(e, link, p) {
      const pl = link.payload as { uid?: number; link?: typeof link };
      if (pl.uid !== undefined) {
        if (!e.fieldCard(pl.uid)) return;
        e.log(p, "Champion's Vigilance negates the Summon");
        return yield* e.destroy([pl.uid]);
      }
      negateLink(e, pl.link, p);
      if (pl.link && e.fieldCard(pl.link.card.uid)) yield* e.destroy([pl.link.card.uid]);
    },
  };

  // Approximated: "while face-up on the field, this card is also DARK" is not modelled (an Attribute is a single value here).
  const ld = (e: Engine, c: Card) => isMonster(e, c) && ['LIGHT', 'DARK'].includes(attrOf(e, c));
  const grepherDiscards = (e: Engine, p: Pid) => e.player(p).hand.filter((c) => ld(e, c) && e.player(p).deck.some((d) => ld(e, d) && attrOf(e, d) !== attrOf(e, c)));
  E['Chaos Grepher'] = {
    ignition: {
      can: (e, _m, p) => e.oncePerTurn('Chaos Grepher', p) && grepherDiscards(e, p).length > 0,
      *run(e, _m, p) {
        e.useOnce('Chaos Grepher', p);
        const c = yield* pickOne(e, p, 'Chaos Grepher: discard which LIGHT or DARK monster?', grepherDiscards(e, p));
        if (!c) return;
        const a = attrOf(e, c);
        yield* e.discard(p, c.uid);
        const sent = yield* deckToGrave(e, p, 'Send which monster from your Deck to the GY?', (d) => ld(e, d) && attrOf(e, d) !== a);
        // audit-02: "for the rest of this turn, you cannot Special Summon monsters with the same name the sent monster had in the GY"
        if (sent) ((e.state.fx.summonLocks ??= []) as unknown[]).push({ p, turn: e.state.turn, normal: false, special: true, names: [sent.name] });
      },
    },
  };

  const lords = ['Uria, Lord of Searing Flames', 'Hamon, Lord of Striking Thunder', 'Raviel, Lord of Phantasms'];
  const lordsIn = (e: Engine, p: Pid) => e.player(p).hand.filter((c) => lords.some((n) => sameAs(e, c, n)));
  E['Chaos Summoning Beast'] = {
    ignition: {
      can: (e, _m, p) => e.oncePerTurn('Chaos Summoning Beast:1', p) && lordsIn(e, p).length > 0,
      *run(e, m, p) {
        e.useOnce('Chaos Summoning Beast:1', p);
        if (!e.fieldCard(m.uid)) return;
        yield* e.sendToGrave(m.uid, 'tribute');
        const c = yield* pickOne(e, p, 'Special Summon which Sacred Beast?', lordsIn(e, p));
        if (!c || !freeMZ(e, p)) return;
        e.state.fx.ignoreCond = c.uid; // audit-02: "ignoring its Summoning conditions"
        try {
          yield* e.specialSummon(c.uid, p, 'atk');
        } finally {
          e.state.fx.ignoreCond = undefined;
        }
      },
    },
    graveIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Chaos Summoning Beast:2', p) && e.player(p).deck.some((c) => c.name === 'Fallen Paradise'),
      *run(e, card, p) {
        e.useOnce('Chaos Summoning Beast:2', p);
        e.banish(card.uid);
        yield* searchDeck(e, p, 'Add "Fallen Paradise"', (c) => c.name === 'Fallen Paradise');
      },
    },
  };

  E['Chaos Trap Hole'] = {
    canActivate: (e, _c, p, t, ctx) => {
      const m = opponentSummon(e, p, t, ctx);
      return !!m && ['LIGHT', 'DARK'].includes(attrOf(e, m)) && e.player(p).lp > 2000;
    },
    *activate(e, link, p, ctx) {
      if (!payLp(e, p, 2000)) return false;
      link.targetUid = ctx.uid;
    },
    *resolve(e, link, p) {
      if (link.targetUid === undefined || !e.fieldCard(link.targetUid)) return;
      e.log(p, 'Chaos Trap Hole negates the Summon');
      e.banish(link.targetUid);
    },
  };

  E['Chaosrider Gustaph'] = {
    ignition: {
      can: (e, _m, p) => e.player(p).gy.some((c) => isSpell(e, c)),
      *run(e, m, p) {
        const list = yield* pick(e, p, 'Chaosrider Gustaph: banish up to 2 Spells from your GY', e.player(p).gy.filter((c) => isSpell(e, c)), 1, 2, true);
        if (!list) return;
        for (const c of list) e.banish(c.uid);
        if (!e.fieldCard(m.uid)) return;
        const t = tag(m);
        t.gAtk = (t.gUntil !== undefined && t.gUntil >= e.state.turn ? t.gAtk ?? 0 : 0) + 300 * list.length;
        t.gUntil = e.state.turn + 1;
      },
    },
    selfBonus: (e, m) => ({ atk: (m.tags?.gUntil ?? -1) >= e.state.turn ? m.tags?.gAtk ?? 0 : 0, def: 0 }),
  };

  E['Chimera the Flying Mythical Beast'] = {
    *onDestroyed(e, card) {
      const p = card.owner;
      const list = e.player(p).gy.filter((c) => c.uid !== card.uid && (sameAs(e, c, 'Berfomet') || sameAs(e, c, 'Gazelle the King of Mythical Beasts')));
      if (!list.length || !freeMZ(e, p)) return;
      const c = yield* pickOne(e, p, 'Chimera: Special Summon which monster? (cancel to skip)', list, true);
      if (c) yield* e.specialSummon(c.uid, p, yield* choosePos(e, p, c.name));
    },
  };

  E['Chiron the Mage'] = {
    ignition: {
      can: (e, _m, p) => e.player(p).hand.some((c) => isSpell(e, c)) && stOf(e, other(p)).length > 0,
      *run(e, _m, p) {
        if (!(yield* discardCost(e, p, 1, (c) => isSpell(e, c)))) return;
        const t = yield* pickOne(e, p, 'Chiron the Mage: destroy which Spell/Trap?', stOf(e, other(p)));
        if (t) yield* e.destroy([t.uid]);
      },
    },
  };

  E['Chow Sai the Ghost Stopper'] = {
    locksGraveST: () => true, // audit-02: "Neither player can activate the effects of Spell/Trap Cards in the GY."
    *onSentToGrave(e, _card, p, from) {
      const list = e.player(other(p)).gy.filter((c) => !isMonster(e, c));
      if (from !== 'mz' || !list.length) return;
      const c = yield* pickOne(e, p, "Chow Sai: banish which Spell/Trap from your opponent's GY? (cancel to skip)", list, true);
      if (c) e.banish(c.uid);
    },
  };

  const dmOrBewd = (e: Engine, p: Pid) => targetable(e, faceUpMonsters(e, p)).filter((m) => sameAs(e, m, 'Dark Magician') || sameAs(e, m, 'Blue-Eyes White Dragon'));
  E['Chronicle Magician'] = {
    quick: {
      from: 'hand',
      label: 'Special Summon it in Defense Position',
      can: (e, _c, p, t, ctx) => {
        if (!((t === 'summon' && ctx.summonKind === 'normal') || t === 'special') || ctx.uid === undefined || !freeMZ(e, p)) return false;
        const m = e.fieldCard(ctx.uid);
        return !!m && m.faceUp && ctrl(e, m) === p && (info(e, m).atk === 2500 || info(e, m).def === 2500);
      },
      *run(e, card, p) {
        if (inZone(e, card.uid, 'hand') && freeMZ(e, p)) yield* e.specialSummon(card.uid, p, 'def');
      },
    },
    *onSpecialSummon(e, _m, p) {
      if (!dmOrBewd(e, p).length || !e.oncePerTurn('Chronicle Magician:2', p)) return;
      const t = yield* pickOne(e, p, 'Chronicle Magician: which monster gains 2500 ATK/DEF? (cancel to skip)', dmOrBewd(e, p), true);
      if (!t) return;
      e.useOnce('Chronicle Magician:2', p);
      boostTurn(t, 2500, 2500);
    },
  };

  // Approximated: the Special Summon lock starts when the effect is used (Special Summons made earlier this turn do not stop it).
  E['Chronomaly Acambaro Figures'] = {
    // audit-02: "If a "Chronomaly" monster(s) you control would be destroyed by battle or your opponent's card effect, you can discard this card instead."
    *handReplace(e, card, m, byBattle, by) {
      const p = card.owner;
      if (e.controller(m.uid) !== p || !named(m, 'Chronomaly') || !(byBattle || by === other(p))) return false;
      if (!(yield* e.yesno(p, `Chronomaly Acambaro Figures: discard it instead of ${m.name} being destroyed?`))) return false;
      yield* e.discard(p, card.uid);
      e.log(p, `${m.name} is not destroyed`);
      return true;
    },
    graveIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Chronomaly Acambaro Figures', p) && freeMZ(e, p) && e.player(p).lp > 1000,
      *run(e, card, p) {
        if (!payLp(e, p, 1000)) return;
        e.useOnce('Chronomaly Acambaro Figures', p);
        ((e.state.fx.summonLocks ??= []) as unknown[]).push({ p, turn: e.state.turn, normal: false, special: true, only: ['Chronomaly'] }); // audit-02
        yield* e.specialSummon(card.uid, p, yield* choosePos(e, p, card.name));
        const fc = e.fieldCard(card.uid);
        if (fc) tag(fc).backTurn = e.state.turn;
      },
    },
    *onEndPhase(e, m) {
      if (m.tags?.backTurn === e.state.turn && e.fieldCard(m.uid)) {
        e.toHand(m.uid);
        e.log(null, 'Chronomaly Acambaro Figures returns to the hand');
      }
    },
  };

  E['Chronomaly Moai'] = {
    summonProc: {
      can: (e, _c, p) => freeMZ(e, p) && faceUpMonsters(e, p).some((m) => named(m, 'Chronomaly')),
      *run(e, c, p) {
        yield* e.specialSummon(c.uid, p, 'def');
      },
    },
  };

  // audit-02: every "Chronomaly" monster you control pierces (it used to be Mud Golem only).
  E['Chronomaly Mud Golem'] = { grantsPiercing: (e, _m, p, attacker) => e.controller(attacker.uid) === p && named(attacker, 'Chronomaly') };

  // ----- Cloudian -----
  E['Cloudian - Acid Cloud'] = cloudian({
    ignition: {
      repeat: true,
      can: (e, m) => fog(m) >= 2 && allST(e).length > 0,
      *run(e, m, p) {
        if (fog(m) < 2) return;
        tag(m).fog = fog(m) - 2;
        const t = yield* pickOne(e, p, 'Acid Cloud: destroy which Spell/Trap?', allST(e));
        if (t) yield* e.destroy([t.uid]);
      },
    },
  });
  E['Cloudian - Altus'] = cloudian({
    ignition: {
      repeat: true,
      can: (e, _m, p) => totalFog(e) >= 3 && e.player(other(p)).hand.length > 0,
      *run(e, _m, p) {
        if (totalFog(e) < 3 || !(yield* removeFogAnywhere(e, p, 3))) return;
        const hand = e.player(other(p)).hand;
        if (!hand.length) return;
        yield* e.discard(other(p), hand[Math.floor(e.rand() * hand.length)].uid);
      },
    },
  });
  E['Cloudian - Cirrostratus'] = cloudian({
    ignition: {
      repeat: true,
      can: (e, m) => fog(m) >= 2 && allMonsters(e).length > 0,
      *run(e, m, p) {
        if (fog(m) < 2) return;
        tag(m).fog = fog(m) - 2;
        const t = yield* pickOne(e, p, 'Cirrostratus: destroy which monster?', allMonsters(e));
        if (t) yield* e.destroy([t.uid]);
      },
    },
  });
  E['Cloudian - Eye of the Typhoon'] = cloudian(
    {
      attackCost: {
        can: () => true,
        *pay(e) {
          for (const m of faceUpMonsters(e).filter((x) => !isCloudian(x))) {
            m.pos = m.pos === 'atk' ? 'def' : 'atk';
            e.event('position', { uid: m.uid });
          }
          e.log(null, 'Eye of the Typhoon changes the battle positions of all face-up monsters');
        },
      },
    },
    { summonFog: false },
  );
  E['Cloudian - Ghost Fog'] = {
    cannotSpecialSummon: true, // audit-02
    attackCost: {
      can: () => true,
      *pay(e) {
        e.state.fx.noBattleDamageIn = [(e.state.fx.battleNo ?? 0) + 1, (e.state.fx.battleNo ?? 0) + 1];
      },
    },
    *onBeingAttacked(e) {
      e.state.fx.noBattleDamageIn = [e.state.fx.battleNo ?? 0, e.state.fx.battleNo ?? 0];
    },
    *onDestroyed(e, card, p, byBattle) {
      const b = e.state.battle;
      if (!byBattle || !b) return;
      const foeUid = b.attacker === card.uid ? b.target : b.attacker;
      const foe = foeUid !== null ? e.find(foeUid)?.card : null;
      const n = foe ? levelOf(e, foe) : 0;
      for (let i = 0; i < n; i++) {
        const m = yield* pickOne(e, p, `Ghost Fog: place a Fog Counter on which monster? (${n - i} left)`, faceUpMonsters(e));
        if (!m) return;
        tag(m).fog = fog(m) + 1;
      }
    },
  };
  // Simplification: the tokens may be Tributed for any Tribute Summon.
  E['Cloudian - Sheep Cloud'] = {
    *onDestroyed(e, card, p, byBattle) {
      if (!byBattle || card.owner !== p) return;
      for (let i = 0; i < 2; i++) e.createToken('Cloudian Token', p, 'def', true, { atk: 0, def: 0, level: 1, attribute: 'WATER', race: 'Fairy' });
    },
  };
  const gyCloudians = (e: Engine, p: Pid, except = -1) => monstersIn(e, e.player(p).gy, (c) => isCloudian(c) && c.uid !== except);
  E['Cloudian - Storm Dragon'] = cloudian(
    {
      cannotNormalSummon: true,
      summonProc: {
        can: (e, _c, p) => freeMZ(e, p) && gyCloudians(e, p).length > 0,
        *run(e, c, p) {
          const x = yield* pickOne(e, p, 'Storm Dragon: banish which "Cloudian" monster from your GY?', gyCloudians(e, p), true);
          if (!x) return;
          e.banish(x.uid);
          yield* e.specialSummon(c.uid, p, 'atk');
        },
      },
      ignition: {
        can: (e) => allMonsters(e).length > 0,
        *run(e, _m, p) {
          const t = yield* pickOne(e, p, 'Storm Dragon: place a Fog Counter on which monster?', allMonsters(e));
          if (t) addFog(e, t, 1);
        },
      },
    },
    { summonFog: false },
  );
  const smokeBalls = (e: Engine, p: Pid) => [...e.player(p).deck, ...e.player(p).gy, ...e.player(other(p)).gy].filter((c) => c.name === 'Cloudian - Smoke Ball');
  E['Cloudian - Turbulence'] = cloudian({
    ignition: {
      repeat: true,
      can: (e, m, p) => fog(m) >= 1 && freeMZ(e, p) && smokeBalls(e, p).length > 0,
      *run(e, m, p) {
        if (fog(m) < 1) return;
        tag(m).fog = fog(m) - 1;
        yield* summonOneOf(e, p, 'Turbulence: Special Summon which "Cloudian - Smoke Ball"?', smokeBalls(e, p), 'atk');
      },
    },
  });

  E['Cloudian Aerosol'] = {
    canActivate: (e, _c, p, t) => isMain(t) && e.oncePerTurn('Cloudian Aerosol', p) && e.player(p).hand.some((c) => isMonster(e, c) && isCloudian(c)) && targetable(e, faceUpMonsters(e)).length > 0,
    *activate(e, link, p) {
      if (!(yield* discardCost(e, p, 1, (c) => isMonster(e, c) && isCloudian(c)))) return false;
      e.useOnce('Cloudian Aerosol', p);
      const t = yield* pickOne(e, p, 'Cloudian Aerosol: place Fog Counters on which monster?', targetable(e, faceUpMonsters(e)));
      if (!t) return false;
      link.targetUid = t.uid;
    },
    *resolve(e, link) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (m && m.faceUp) addFog(e, m, levelOf(e, m));
    },
    graveIgnition: {
      can: (e, _c, p) => e.oncePerTurn('Cloudian Aerosol', p) && freeMZ(e, p) && gyCloudians(e, p).length > 0 && e.player(p).deck.some((c) => isMonster(e, c) && isCloudian(c)),
      *run(e, card, p) {
        const x = yield* pickOne(e, p, 'Cloudian Aerosol: banish which "Cloudian" monster from your GY?', gyCloudians(e, p), true);
        if (!x) return;
        e.useOnce('Cloudian Aerosol', p);
        e.banish(card.uid);
        e.banish(x.uid);
        yield* summonOneOf(e, p, 'Special Summon which "Cloudian" monster?', monstersIn(e, e.player(p).deck, isCloudian), 'atk');
      },
    },
  };

  E['Cloudian Squall'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve() {},
    *onStandby(e, _c, p) {
      if (e.state.turnPlayer !== p) return;
      for (const m of faceUpMonsters(e)) tag(m).fog = fog(m) + 1;
      if (faceUpMonsters(e).length) e.log(p, 'Cloudian Squall places a Fog Counter on every face-up monster');
    },
  };

  E['Common Charity'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.player(p).deck.length >= 2,
    *resolve(e, _l, p) {
      if (!e.draw(p, 2)) return;
      const normals = e.player(p).hand.filter((c) => isNormalMonster(e, c));
      if (normals.length) {
        const c = yield* pickOne(e, p, 'Common Charity: banish which Normal Monster from your hand?', normals);
        if (c) e.banish(c.uid);
        return;
      }
      e.log(p, 'Common Charity: no Normal Monster, the whole hand goes to the GY');
      for (const c of e.player(p).hand.slice()) yield* e.sendToGrave(c.uid, 'used');
    },
  };

  // A Trap Monster (Zombie/LIGHT/Level 5, 500/1800).
  const eldlixirs = (e: Engine, p: Pid) => e.player(p).deck.filter((c) => named(c, 'Eldlixir') && !isMonster(e, c));
  E['Conquistador of the Golden Land'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.oncePerTurn('Conquistador of the Golden Land', p) && freeMZ(e, p),
    *activate(e, _link, p) {
      e.useOnce('Conquistador of the Golden Land', p);
    },
    *resolve(e, link, p) {
      if (!e.fieldCard(link.card.uid) || !freeMZ(e, p)) return;
      // audit-02: it is a Zombie/LIGHT/Level 5 monster while in the Monster Zone (it used to keep no Level, Type or Attribute).
      ((e.state.fx.trapMonster ??= {}) as Record<number, { level: number; race: string; attribute: string }>)[link.card.uid] = { level: 5, race: 'Zombie', attribute: 'LIGHT' };
      yield* e.specialSummon(link.card.uid, p, yield* choosePos(e, p, link.card.name));
      if (!faceUpMonsters(e, p).some((m) => m.name === 'Eldlich the Golden Lord')) return;
      const list = [...faceUpMonsters(e), ...allST(e).filter((c) => c.faceUp)];
      const t = yield* pickOne(e, p, 'Conquistador: destroy which face-up card? (cancel to skip)', list, true);
      if (t) yield* e.destroy([t.uid]);
    },
    baseStats: () => ({ atk: 500, def: 1800 }),
    // audit-02: "During the End Phase: You can banish this card from your GY; Set 1 "Eldlixir" Spell/Trap directly from your Deck."
    *onEndPhaseInGrave(e, card, p) {
      if (!e.oncePerTurn('Conquistador of the Golden Land', p) || freeST(e, p) < 0 || !eldlixirs(e, p).length) return;
      if (!(yield* e.yesno(p, 'Conquistador of the Golden Land: banish it to Set 1 "Eldlixir" Spell/Trap from your Deck?'))) return;
      const c = yield* pickOne(e, p, 'Set which "Eldlixir" card?', eldlixirs(e, p));
      if (!c) return;
      e.useOnce('Conquistador of the Golden Land', p);
      e.banish(card.uid);
      const ps = e.player(p);
      const zone = freeST(e, p);
      const i = ps.deck.findIndex((x) => x.uid === c.uid);
      if (zone < 0 || i < 0) return;
      ps.deck.splice(i, 1);
      ps.sz[zone] = { uid: c.uid, name: c.name, owner: c.owner, pos: 'atk', faceUp: false, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
      ps.deck = e.shuffle(ps.deck);
      e.event('set', { uid: c.uid, player: p });
      e.log(p, `${ps.name} Sets ${c.name} from the Deck`);
    },
  };

  E['Conscription'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.player(other(p)).deck.length > 0,
    *resolve(e, _l, p) {
      const top = e.player(other(p)).deck[0];
      if (!top) return;
      e.log(p, `Conscription excavates ${top.name}`);
      const ok = isMonster(e, top) && !isExtraOrRitual(e, top) && !e.effectOn(top)?.cannotNormalSummon;
      if (ok && freeMZ(e, p)) yield* e.specialSummon(top.uid, p, yield* choosePos(e, p, top.name));
      else e.toHandOf(top.uid, other(p));
    },
  };

  const constellarOther = (e: Engine, p: Pid) => faceUpMonsters(e, p).some((m) => named(m, 'Constellar') && m.name !== 'Constellar Caduceus');
  const constellarST = (e: Engine, c: Card) => named(c, 'Constellar') && (isSpell(e, c) || isTrap(e, c));
  // Approximated: the effect it gives a "Constellar" Xyz Monster is not modelled (there is no "Constellar" Xyz Monster in the pool).
  E['Constellar Caduceus'] = {
    summonProc: {
      can: (e, _c, p) => e.oncePerTurn('Constellar Caduceus:1', p) && freeMZ(e, p) && constellarOther(e, p),
      *run(e, c, p) {
        e.useOnce('Constellar Caduceus:1', p);
        yield* e.specialSummon(c.uid, p, yield* choosePos(e, p, c.name));
      },
    },
    ignition: {
      can: (e, _m, p) => e.oncePerTurn('Constellar Caduceus:2', p) && e.player(p).deck.some((c) => constellarST(e, c)),
      *run(e, _m, p) {
        e.useOnce('Constellar Caduceus:2', p);
        yield* searchDeck(e, p, 'Add which "Constellar" Spell/Trap?', (c) => constellarST(e, c));
      },
    },
  };

  E['Construction Train Signal Red'] = {
    quick: {
      from: 'hand',
      label: 'Special Summon it and take the attack',
      can: (e, _c, p, t, ctx) => opponentAttack(e, p, t, ctx) !== null && freeMZ(e, p),
      *run(e, card, p) {
        if (!inZone(e, card.uid, 'hand') || !freeMZ(e, p)) return;
        yield* e.specialSummon(card.uid, p, 'def');
        const fc = e.fieldCard(card.uid);
        const b = e.state.battle;
        if (!fc || !b || !e.fieldCard(b.attacker)) return;
        b.target = fc.uid;
        tag(fc).srBattle = e.state.fx.battleNo ?? 0;
        e.log(p, 'Construction Train Signal Red becomes the attack target');
      },
    },
    battleProof: (e, m) => m.tags?.srBattle !== undefined && m.tags.srBattle === e.state.fx.battleNo && !!e.state.battle,
  };

  const neoSpacians = (e: Engine, cards: Card[]) => monstersIn(e, cards, (c) => named(c, 'Neo-Spacian'));
  const distinct = (cards: Card[]) => new Set(cards.map((c) => c.name)).size;
  const gatePool = (e: Engine, p: Pid, without: number[] = []) => neoSpacians(e, [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy]).filter((c) => !without.includes(c.uid));
  const gateCan = (e: Engine, p: Pid) => {
    const gy = neoSpacians(e, e.player(p).gy);
    for (let i = 0; i < gy.length; i++) for (let j = i + 1; j < gy.length; j++) if (gy[i].name !== gy[j].name && distinct(gatePool(e, p, [gy[i].uid, gy[j].uid])) >= 2) return true;
    return false;
  };
  E['Contact Gate'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.oncePerTurn(c.name, p) && freeZones(e, p) >= 2 && gateCan(e, p),
    *activate(e, link, p) {
      const a = yield* pickOne(e, p, 'Contact Gate: banish which "Neo-Spacian" from your GY?', neoSpacians(e, e.player(p).gy), true);
      if (!a) return false;
      const b = yield* pickOne(e, p, 'Banish which other "Neo-Spacian" (a different name)?', neoSpacians(e, e.player(p).gy).filter((c) => c.name !== a.name && distinct(gatePool(e, p, [a.uid, c.uid])) >= 2), true);
      if (!b) return false;
      e.useOnce(link.card.name, p);
      e.banish(a.uid);
      e.banish(b.uid);
    },
    *resolve(e, _l, p) {
      // audit-02: "for the rest of this turn you cannot Special Summon monsters from the Extra Deck, except Fusion Monsters"
      ((e.state.fx.summonLocks ??= []) as unknown[]).push({ p, turn: e.state.turn, normal: false, special: true, extraOnly: ['Fusion'] });
      const first = yield* summonOneOf(e, p, 'Contact Gate: Special Summon which "Neo-Spacian"?', gatePool(e, p), 'atk');
      if (!first) return;
      yield* summonOneOf(e, p, 'Special Summon which other "Neo-Spacian" (a different name)?', gatePool(e, p).filter((c) => c.name !== first.name), 'atk');
    },
    // audit-02: "If a face-up Fusion Monster that lists "Elemental HERO Neos" as material returns from your field to the Extra Deck:
    // You can banish this card from your GY; Special Summon 1 of your banished "Neo-Spacian" monsters."
    *watchLeave(e, card, p, fc, controller) {
      const banished = () => neoSpacians(e, e.player(p).removed);
      if (controller !== p || !fc.faceUp || info(e, fc).sub !== 'Fusion' || !(info(e, fc).desc ?? '').includes('"Elemental HERO Neos"')) return;
      if (e.find(fc.uid)?.loc.zone !== 'fusion' || !freeMZ(e, p) || !banished().length) return;
      if (!(yield* e.yesno(p, 'Contact Gate: banish it from your GY to Special Summon 1 of your banished "Neo-Spacian" monsters?'))) return;
      e.banish(card.uid);
      yield* summonOneOf(e, p, 'Special Summon which banished "Neo-Spacian"?', banished(), 'atk');
    },
  };
}
