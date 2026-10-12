// Card effect scripts. Keyed by card name; the engine asks here whenever a
// card is activated, flipped, equipped or sent to the Graveyard.

import type { ChainCtx, Choice, Engine, Step } from './engine';
import { other } from './engine';
import type { Card, ChainLink, FieldCard, Pid, Prompt } from './types';

export type Trigger = 'main' | 'summon' | 'attack' | 'spell' | 'trap';

export interface EffectDef {
  /** May this card be activated now? (trigger 'main' = from hand/set during own Main Phase) */
  canActivate?(e: Engine, card: Card, player: Pid, trigger: Trigger, ctx: ChainCtx): boolean;
  /** Choose targets / pay costs. Return false to fizzle. */
  activate?(e: Engine, link: ChainLink, player: Pid, ctx: ChainCtx): Generator<Prompt, boolean | void, Choice>;
  resolve?(e: Engine, link: ChainLink, player: Pid): Step;
  /** FLIP effect of a monster. `destroyed` = it already left the field by battle. */
  flip?(e: Engine, m: FieldCard, controller: Pid, destroyed?: boolean): Step;
  onToGraveFromField?(e: Engine, card: Card, controller: Pid): Step;
  onLeaveField?(e: Engine, fc: FieldCard, controller: Pid, reason: string): Step;
  equipBonus?(e: Engine, equip: FieldCard, host: FieldCard): { atk: number; def: number };
  onStandby?(e: Engine, fc: FieldCard, controller: Pid): Step;
  onEndPhase?(e: Engine, fc: FieldCard, controller: Pid): Step;
  blocksAttacks?: boolean;
  /** Continuous bonus to this monster's own ATK/DEF while face-up. */
  selfBonus?(e: Engine, m: FieldCard): { atk: number; def: number };
  /** Bonus this face-up card (monster or Field Spell) gives to a monster, or undefined. */
  aura?(e: Engine, src: FieldCard, target: FieldCard, srcController: Pid): { atk: number; def: number } | undefined;
  /** After this monster is Normal/Flip Summoned face-up. */
  onSummon?(e: Engine, m: FieldCard, controller: Pid): Step;
  /** Ignition effect usable once per turn during the controller's Main Phase. */
  ignition?: { can(e: Engine, m: FieldCard, p: Pid): boolean; run(e: Engine, m: FieldCard, p: Pid): Step };
  onPositionChange?(e: Engine, m: FieldCard, p: Pid): Step;
  /** A price to attack (Spirit of the Books etc.). */
  attackCost?: { can(e: Engine, m: FieldCard, p: Pid): boolean; pay(e: Engine, m: FieldCard, p: Pid): Step };
  directAttack?: boolean;
  /** After this attacker inflicted battle damage. */
  onBattleDamage?(e: Engine, attacker: FieldCard, p: Pid): Step;
  /** After battle, when this monster was attacked (face-down ones are flipped before damage). */
  onAttacked?(e: Engine, target: FieldCard, attacker: FieldCard, controller: Pid, destroyed: boolean): Step;
  onDestroyedByBattle?(e: Engine, m: FieldCard, controller: Pid): Step;
  /** After this attacker battled and survived. */
  afterBattle?(e: Engine, attacker: FieldCard, target: FieldCard, p: Pid, targetDestroyed: boolean): Step;
  /** Harpie Lady Sisters, Wall Shadow: only Special Summoned. */
  cannotNormalSummon?: boolean;
  /** Jinzo. */
  sealsTraps?: boolean;
  /** Continuous card that stops a given monster from attacking (Messenger of Peace). */
  blocksAttack?(e: Engine, card: FieldCard, m: FieldCard, attacker: Pid): boolean;
  /** Equip that stops its host attacking (Paralyzing Potion). */
  hostCannotAttack?(e: Engine, equip: FieldCard, host: FieldCard): boolean;
  /** A face-up card of the attacker's controller, after battle damage was dealt (Robbin' Goblin). */
  onBattleDamageDealt?(e: Engine, card: FieldCard, attacker: FieldCard, p: Pid): Step;
}

const E: Record<string, EffectDef> = {};
const LOWER: Record<string, EffectDef> = {};
let indexed = 0;
function reindex() {
  for (const k of Object.keys(E)) LOWER[k.toLowerCase()] = E[k];
  indexed = Object.keys(E).length;
}
export function getEffect(name: string): EffectDef | undefined {
  const hit = E[name];
  if (hit) return hit;
  if (indexed !== Object.keys(E).length) reindex();
  return LOWER[name.toLowerCase()];
}
export function hasEffect(name: string): boolean {
  return !!getEffect(name);
}

// ---------- helpers ----------
const allMonsters = (e: Engine) => [...e.monsters(0), ...e.monsters(1)];
const allSpells = (e: Engine) => [...e.spells(0), ...e.spells(1), ...([e.player(0).field, e.player(1).field].filter((c): c is FieldCard => !!c))];
const hasFreeZone = (e: Engine, p: Pid) => e.player(p).mz.some((z) => z === null);
const isMonster = (e: Engine, c: Card) => e.info(c.name).kind === 'monster';
const isSpell = (e: Engine, c: Card) => e.info(c.name).kind === 'spell';
const isMain = (t: Trigger) => t === 'main';
const notThisCard = (card: Card) => (c: Card) => c.uid !== card.uid;

/** Equip helper: pick a face-up monster at activation, attach on resolve. */
function equip(bonus?: EffectDef['equipBonus'], extra: Partial<EffectDef> = {}): EffectDef {
  return {
    canActivate: (e, _c, _p, t) => isMain(t) && allMonsters(e).some((m) => m.faceUp),
    *activate(e, link, player) {
      const targets = allMonsters(e).filter((m) => m.faceUp);
      const picks = yield* e.select(player, `Equip ${link.card.name} to which monster?`, e.optionsFor(targets), 1, 1, true);
      if (!picks) return false;
      link.targetUid = targets[picks[0]].uid;
    },
    *resolve(e, link) {
      const host = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      const eq = e.fieldCard(link.card.uid);
      if (!host || !eq || !host.faceUp) return;
      eq.equippedTo = host.uid;
      host.equips.push(eq.uid);
      eq.active = true;
      e.log(link.player, `${eq.name} equipped to ${host.name}`);
    },
    equipBonus: bonus,
    ...extra,
  };
}

/** Attaches a continuous card to a monster it summoned (Call of the Haunted, Premature Burial). */
function attachTo(e: Engine, card: FieldCard, monsterUid: number) {
  const m = e.fieldCard(monsterUid);
  if (!m) return;
  card.equippedTo = m.uid;
  m.equips.push(card.uid);
  card.active = true;
}

const destroyHostOnLeave: EffectDef['onLeaveField'] = function* (e, fc) {
  if (fc.equippedTo !== undefined) {
    const host = e.fieldCard(fc.equippedTo);
    if (host) {
      e.log(null, `${host.name} is destroyed along with ${fc.name}`);
      yield* e.destroy([host.uid]);
    }
  }
};

// ---------- Pool 1 ----------
E['Black Pendant'] = equip(() => ({ atk: 500, def: 0 }), {
  *onLeaveField(e, _fc, controller) {
    e.log(controller, 'Black Pendant inflicts 500 damage');
    e.damage(other(controller), 500);
  },
});

E['Change of Heart'] = {
  canActivate: (e, _c, p, t) => isMain(t) && e.monsters(other(p)).length > 0 && hasFreeZone(e, p),
  *activate(e, link, player) {
    const targets = e.monsters(other(player));
    const picks = yield* e.select(player, 'Take control of which monster?', e.optionsFor(targets, true), 1, 1, true);
    if (!picks) return false;
    link.targetUid = targets[picks[0]].uid;
  },
  *resolve(e, link, player) {
    const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
    if (!m || e.controller(m.uid) !== other(player)) return;
    if (e.takeControl(m.uid, player)) {
      m.returnAtEnd = other(player);
      e.log(player, `${e.player(player).name} takes control of ${m.faceUp ? m.name : 'a face-down monster'} until the End Phase`);
    }
  },
};

E['Magic Jammer'] = {
  canActivate: (e, _c, p, t, ctx) => t === 'spell' && !!ctx.link && ctx.link.player !== p && e.player(p).hand.length > 0,
  *activate(e, link, player, ctx) {
    const hand = e.player(player).hand;
    const picks = yield* e.select(player, 'Discard 1 card for Magic Jammer', e.optionsFor(hand), 1, 1, true);
    if (!picks) return false;
    const uid = hand[picks[0]].uid;
    yield* e.discard(player, uid);
    link.payload = ctx.link;
  },
  *resolve(e, link) {
    const target = link.payload as ChainLink | undefined;
    if (target) {
      target.negated = true;
      e.log(link.player, `Magic Jammer negates ${target.card.name}`);
    }
  },
};

E['Monster Reborn'] = {
  canActivate: (e, _c, p, t) => isMain(t) && hasFreeZone(e, p) && [...e.player(0).gy, ...e.player(1).gy].some((c) => isMonster(e, c) && e.info(c.name).sub !== 'Fusion'),
  *activate(e, link, player) {
    const targets = [...e.player(player).gy, ...e.player(other(player)).gy].filter((c) => isMonster(e, c) && e.info(c.name).sub !== 'Fusion');
    const picks = yield* e.select(player, 'Special Summon which monster?', e.optionsFor(targets), 1, 1, true);
    if (!picks) return false;
    link.targetUid = targets[picks[0]].uid;
  },
  *resolve(e, link, player) {
    const f = link.targetUid !== undefined ? e.find(link.targetUid) : null;
    if (!f || f.loc.zone !== 'gy' || !hasFreeZone(e, player)) return;
    const atk = yield* e.yesno(player, `Summon ${f.card.name} in Attack Position? (No = Defense)`);
    yield* e.specialSummon(f.card.uid, player, atk ? 'atk' : 'def');
  },
};

E['Mystical Space Typhoon'] = {
  canActivate: (e, card) => allSpells(e).some(notThisCard(card)),
  *activate(e, link, player) {
    const targets = allSpells(e).filter(notThisCard(link.card));
    const picks = yield* e.select(player, 'Destroy which Spell/Trap?', e.optionsFor(targets, true), 1, 1, true);
    if (!picks) return false;
    link.targetUid = targets[picks[0]].uid;
  },
  *resolve(e, link) {
    if (link.targetUid !== undefined && e.fieldCard(link.targetUid)) {
      e.log(link.player, `Mystical Space Typhoon destroys ${e.fieldCard(link.targetUid)!.name}`);
      yield* e.destroy([link.targetUid]);
    }
  },
};

E['Pot of Greed'] = {
  canActivate: (e, _c, p, t) => isMain(t) && e.player(p).deck.length >= 2,
  *resolve(e, _l, player) {
    e.draw(player, 2);
  },
};

E['Seven Tools of the Bandit'] = {
  canActivate: (e, _c, p, t, ctx) => t === 'trap' && !!ctx.link && ctx.link.player !== p && e.player(p).lp > 1000,
  *activate(e, link, player, ctx) {
    e.payLp(player, 1000);
    link.payload = ctx.link;
  },
  *resolve(e, link) {
    const target = link.payload as ChainLink | undefined;
    if (target) {
      target.negated = true;
      e.log(link.player, `Seven Tools of the Bandit negates ${target.card.name}`);
    }
  },
};

E['Swords of Revealing Light'] = {
  canActivate: (_e, _c, _p, t) => isMain(t),
  blocksAttacks: true,
  *resolve(e, link, player) {
    const fc = e.fieldCard(link.card.uid);
    if (!fc) return;
    fc.turns = 3;
    fc.active = true;
    for (const m of e.monsters(other(player))) {
      if (!m.faceUp) {
        m.faceUp = true;
        e.log(other(player), `${m.name} was flipped face-up`);
        yield* e.flipEffect(m.uid, other(player));
      }
    }
    e.log(player, `${e.player(other(player)).name} cannot attack for 3 turns`);
  },
  *onEndPhase(e, fc, controller) {
    if (e.state.turnPlayer === controller) return;
    fc.turns = (fc.turns ?? 3) - 1;
    if (fc.turns <= 0) {
      e.log(controller, 'Swords of Revealing Light wears off');
      yield* e.sendToGrave(fc.uid, 'used');
    }
  },
};

E['Trap Hole'] = {
  canActivate: (e, _c, p, t, ctx) => {
    if (t !== 'summon' || ctx.uid === undefined) return false;
    const m = e.fieldCard(ctx.uid);
    return !!m && e.controller(ctx.uid) === other(p) && e.atkOf(m) >= 1000;
  },
  *activate(_e, link, _p, ctx) {
    link.targetUid = ctx.uid;
  },
  *resolve(e, link) {
    const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
    if (m) {
      e.log(link.player, `Trap Hole swallows ${m.name}`);
      yield* e.destroy([m.uid]);
    }
  },
};

// ---------- Pools 2-4 ----------
E['Dark Hole'] = {
  canActivate: (e, _c, _p, t) => isMain(t) && allMonsters(e).length > 0,
  *resolve(e, link) {
    e.log(link.player, 'Dark Hole destroys every monster on the field');
    yield* e.destroy(allMonsters(e).map((m) => m.uid));
  },
};

E['Raigeki'] = {
  canActivate: (e, _c, p, t) => isMain(t) && e.monsters(other(p)).length > 0,
  *resolve(e, link, player) {
    e.log(player, "Raigeki destroys all of the opponent's monsters");
    yield* e.destroy(e.monsters(other(player)).map((m) => m.uid));
  },
};

E['Megamorph'] = equip((e, eq, host) => {
  const controller = e.controller(eq.uid);
  if (controller === null) return { atk: 0, def: 0 };
  const my = e.player(controller).lp;
  const theirs = e.player(other(controller)).lp;
  const orig = e.info(host.name).atk ?? 0;
  if (my < theirs) return { atk: orig, def: 0 };
  if (my > theirs) return { atk: -Math.floor(orig / 2), def: 0 };
  return { atk: 0, def: 0 };
});

E['Premature Burial'] = {
  canActivate: (e, _c, p, t) => isMain(t) && e.player(p).lp > 800 && hasFreeZone(e, p) && e.player(p).gy.some((c) => isMonster(e, c) && e.info(c.name).sub !== 'Fusion'),
  *activate(e, link, player) {
    const targets = e.player(player).gy.filter((c) => isMonster(e, c) && e.info(c.name).sub !== 'Fusion');
    const picks = yield* e.select(player, 'Pay 800 LP: Special Summon which monster?', e.optionsFor(targets), 1, 1, true);
    if (!picks) return false;
    e.payLp(player, 800);
    link.targetUid = targets[picks[0]].uid;
  },
  *resolve(e, link, player) {
    const f = link.targetUid !== undefined ? e.find(link.targetUid) : null;
    const fc = e.fieldCard(link.card.uid);
    if (!f || f.loc.zone !== 'gy' || !fc || !hasFreeZone(e, player)) return;
    yield* e.specialSummon(f.card.uid, player, 'atk');
    attachTo(e, fc, f.card.uid);
  },
  onLeaveField: destroyHostOnLeave,
};

E['Snatch Steal'] = {
  canActivate: (e, _c, p, t) => isMain(t) && e.monsters(other(p)).some((m) => m.faceUp) && hasFreeZone(e, p),
  *activate(e, link, player) {
    const targets = e.monsters(other(player)).filter((m) => m.faceUp);
    const picks = yield* e.select(player, 'Take control of which monster?', e.optionsFor(targets), 1, 1, true);
    if (!picks) return false;
    link.targetUid = targets[picks[0]].uid;
  },
  *resolve(e, link, player) {
    const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
    const fc = e.fieldCard(link.card.uid);
    if (!m || !fc || e.controller(m.uid) !== other(player)) return;
    if (e.takeControl(m.uid, player)) {
      attachTo(e, fc, m.uid);
      e.log(player, `${e.player(player).name} snatches ${m.name}`);
    }
  },
  *onStandby(e, _fc, controller) {
    if (e.state.turnPlayer !== controller) {
      e.log(controller, 'Snatch Steal: opponent gains 1000 LP');
      e.gainLp(other(controller), 1000);
    }
  },
  *onLeaveField(e, fc) {
    if (fc.equippedTo !== undefined) {
      const m = e.fieldCard(fc.equippedTo);
      if (m && e.controller(m.uid) !== m.owner) {
        if (e.takeControl(m.uid, m.owner)) e.log(null, `${m.name} returns to its owner`);
      }
    }
  },
};

E['Bell of Destruction'] = {
  canActivate: (e) => allMonsters(e).some((m) => m.faceUp),
  *activate(e, link, player) {
    const targets = allMonsters(e).filter((m) => m.faceUp);
    const picks = yield* e.select(player, 'Destroy which face-up monster?', e.optionsFor(targets), 1, 1, true);
    if (!picks) return false;
    link.targetUid = targets[picks[0]].uid;
  },
  *resolve(e, link) {
    const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
    if (!m || !m.faceUp) return;
    const dmg = e.atkOf(m);
    e.log(link.player, `Bell of Destruction destroys ${m.name}; both players take ${dmg}`);
    yield* e.destroy([m.uid]);
    e.damage(0, dmg);
    e.damage(1, dmg);
  },
};

E['Call Of The Haunted'] = {
  canActivate: (e, _c, p) => hasFreeZone(e, p) && e.player(p).gy.some((c) => isMonster(e, c) && e.info(c.name).sub !== 'Fusion'),
  *activate(e, link, player) {
    const targets = e.player(player).gy.filter((c) => isMonster(e, c) && e.info(c.name).sub !== 'Fusion');
    const picks = yield* e.select(player, 'Special Summon which monster?', e.optionsFor(targets), 1, 1, true);
    if (!picks) return false;
    link.targetUid = targets[picks[0]].uid;
  },
  *resolve(e, link, player) {
    const f = link.targetUid !== undefined ? e.find(link.targetUid) : null;
    const fc = e.fieldCard(link.card.uid);
    if (!f || f.loc.zone !== 'gy' || !fc || !hasFreeZone(e, player)) return;
    yield* e.specialSummon(f.card.uid, player, 'atk');
    attachTo(e, fc, f.card.uid);
  },
  onLeaveField: destroyHostOnLeave,
};
E['Call of the Haunted'] = E['Call Of The Haunted'];

E['Mirror Force'] = {
  canActivate: (e, _c, p, t, ctx) => t === 'attack' && ctx.uid !== undefined && e.controller(ctx.uid) === other(p) && e.monsters(other(p)).some((m) => m.faceUp && m.pos === 'atk'),
  *resolve(e, link, player) {
    const targets = e.monsters(other(player)).filter((m) => m.faceUp && m.pos === 'atk');
    e.log(link.player, `Mirror Force destroys ${targets.length} attacking monster${targets.length === 1 ? '' : 's'}`);
    yield* e.destroy(targets.map((m) => m.uid));
  },
};

// ---------- Pool 11: FLIP and search monsters ----------
E['Magician of Faith'] = {
  *flip(e, _m, controller) {
    const targets = e.player(controller).gy.filter((c) => isSpell(e, c));
    const picks = yield* e.select(controller, 'Return which Spell to your hand?', e.optionsFor(targets), 1, 1);
    if (picks && targets[picks[0]]) {
      e.toHand(targets[picks[0]].uid);
      e.log(controller, `${targets[picks[0]].name} returns to the hand`);
    }
  },
};

E['Man-Eater Bug'] = {
  *flip(e, m, controller) {
    const targets = allMonsters(e).filter(notThisCard(m));
    const picks = yield* e.select(controller, 'Man-Eater Bug: destroy which monster?', e.optionsFor(targets, true), 1, 1);
    if (picks && targets[picks[0]]) {
      e.log(controller, `Man-Eater Bug destroys ${targets[picks[0]].faceUp ? targets[picks[0]].name : 'a face-down monster'}`);
      yield* e.destroy([targets[picks[0]].uid]);
    }
  },
};

E['Morphing Jar'] = {
  *flip(e) {
    e.log(null, 'Morphing Jar: both players discard their hands and draw 5');
    for (const p of [0, 1] as Pid[]) {
      for (const c of e.player(p).hand.slice()) yield* e.sendToGrave(c.uid, 'discard');
    }
    for (const p of [0, 1] as Pid[]) if (e.state.winner === null) e.draw(p, 5);
  },
};

E['Needle Worm'] = {
  *flip(e, _m, controller) {
    const opp = e.player(other(controller));
    const n = Math.min(5, opp.deck.length);
    for (let i = 0; i < n; i++) yield* e.sendToGrave(opp.deck[0].uid, 'mill');
    e.log(controller, `Needle Worm sends ${n} cards from ${opp.name}'s Deck to the Graveyard`);
  },
};

E['Penguin Soldier'] = {
  *flip(e, m, controller) {
    const targets = allMonsters(e).filter(notThisCard(m));
    const picks = yield* e.select(controller, 'Penguin Soldier: return up to 2 monsters to the hand', e.optionsFor(targets, true), 0, 2);
    if (!picks) return;
    for (const i of picks) {
      const t = targets[i];
      if (t && e.fieldCard(t.uid)) {
        e.toHand(t.uid);
        e.log(controller, `${t.name} returns to the hand`);
      }
    }
  },
};

const searcher = (title: string, test: (e: Engine, c: Card) => boolean): EffectDef => ({
  *onToGraveFromField(e, _card, controller) {
    const ps = e.player(controller);
    const targets = ps.deck.filter((c) => isMonster(e, c) && test(e, c));
    if (targets.length === 0) return;
    const picks = yield* e.select(controller, title, e.optionsFor(targets), 1, 1);
    if (picks && targets[picks[0]]) {
      e.toHand(targets[picks[0]].uid);
      e.log(controller, `${ps.name} adds ${targets[picks[0]].name} to the hand`);
      ps.deck = e.shuffle(ps.deck);
    }
  },
});
E['Sangan'] = searcher('Sangan: add a monster with 1500 or less ATK to your hand', (e, c) => (e.info(c.name).atk ?? 0) <= 1500);
E['Witch of the Black Forest'] = searcher('Witch of the Black Forest: add a monster with 1500 or less DEF to your hand', (e, c) => (e.info(c.name).def ?? 0) <= 1500);

// ---------- Common pack cards ----------
E['Axe of Despair'] = equip(() => ({ atk: 1000, def: 0 }));
E['Malevolent Nuzzler'] = equip(() => ({ atk: 700, def: 0 }));
E['Horn of the Unicorn'] = equip(() => ({ atk: 700, def: 700 }));
E['Book of Secret Arts'] = equip(() => ({ atk: 300, def: 300 }));
E['Sword of Dark Destruction'] = equip(() => ({ atk: 400, def: -200 }));
E['Dark Energy'] = equip(() => ({ atk: 300, def: 300 }));
E['Invigoration'] = equip(() => ({ atk: 400, def: -200 }));
E['Legendary Sword'] = equip(() => ({ atk: 300, def: 300 }));
E['Beast Fangs'] = equip(() => ({ atk: 300, def: 300 }));
E['Violet Crystal'] = equip(() => ({ atk: 300, def: 300 }));
E['Mystical Moon'] = equip(() => ({ atk: 300, def: 300 }));
E['Silver Bow and Arrow'] = equip(() => ({ atk: 300, def: 300 }));
E['Dragon Treasure'] = equip(() => ({ atk: 300, def: 300 }));
E['Electro-Whip'] = equip(() => ({ atk: 300, def: 300 }));
E['Machine Conversion Factory'] = equip(() => ({ atk: 300, def: 300 }));
E['Follow Wind'] = equip(() => ({ atk: 300, def: 300 }));
E['Steel Shell'] = equip(() => ({ atk: 400, def: -200 }));
E['Elf\'s Light'] = equip(() => ({ atk: 400, def: -200 }));
E['Vile Germs'] = equip(() => ({ atk: 300, def: 300 }));
E['Raise Body Heat'] = equip(() => ({ atk: 300, def: 300 }));
E['Winged Trumpeter'] = equip(() => ({ atk: 300, def: 300 }));
E['Bright Castle'] = equip(() => ({ atk: 700, def: 0 }));
E['Cyber Shield'] = equip(() => ({ atk: 500, def: 0 }));
E['Paralyzing Potion'] = equip();
E['Black Pendant'] = E['Black Pendant'];

E['Dian Keto the Cure Master'] = {
  canActivate: (_e, _c, _p, t) => isMain(t),
  *resolve(e, _l, player) {
    e.gainLp(player, 1000);
  },
};
E['Red Medicine'] = {
  canActivate: (_e, _c, _p, t) => isMain(t),
  *resolve(e, _l, player) {
    e.gainLp(player, 500);
  },
};
E['Goblin\'s Secret Remedy'] = {
  canActivate: (_e, _c, _p, t) => isMain(t),
  *resolve(e, _l, player) {
    e.gainLp(player, 600);
  },
};
E['Sparks'] = {
  canActivate: (_e, _c, _p, t) => isMain(t),
  *resolve(e, _l, player) {
    e.damage(other(player), 200);
  },
};
E['Hinotama'] = {
  canActivate: (_e, _c, _p, t) => isMain(t),
  *resolve(e, _l, player) {
    e.damage(other(player), 500);
  },
};
E['Final Flame'] = {
  canActivate: (_e, _c, _p, t) => isMain(t),
  *resolve(e, _l, player) {
    e.damage(other(player), 600);
  },
};
E['Ookazi'] = {
  canActivate: (_e, _c, _p, t) => isMain(t),
  *resolve(e, _l, player) {
    e.damage(other(player), 800);
  },
};
E['Tremendous Fire'] = {
  canActivate: (_e, _c, _p, t) => isMain(t),
  *resolve(e, _l, player) {
    e.damage(other(player), 1000);
    e.damage(player, 500);
  },
};
E['Graceful Charity'] = {
  canActivate: (e, _c, p, t) => isMain(t) && e.player(p).deck.length >= 3,
  *resolve(e, _l, player) {
    e.draw(player, 3);
    const hand = e.player(player).hand;
    const picks = yield* e.select(player, 'Graceful Charity: discard 2 cards', e.optionsFor(hand), 2, 2);
    if (!picks) return;
    for (const uid of picks.map((i) => hand[i].uid)) yield* e.discard(player, uid);
  },
};
E['Fissure'] = {
  canActivate: (e, _c, p, t) => isMain(t) && e.monsters(other(p)).some((m) => m.faceUp),
  *resolve(e, _l, player) {
    const ms = e.monsters(other(player)).filter((m) => m.faceUp);
    if (!ms.length) return;
    const weakest = ms.reduce((a, b) => (e.atkOf(b) < e.atkOf(a) ? b : a));
    e.log(player, `Fissure destroys ${weakest.name}`);
    yield* e.destroy([weakest.uid]);
  },
};
E['Heavy Storm'] = {
  canActivate: (e, card, _p, t) => isMain(t) && allSpells(e).some(notThisCard(card)),
  *resolve(e, link) {
    e.log(link.player, 'Heavy Storm destroys every Spell and Trap');
    yield* e.destroy(allSpells(e).filter(notThisCard(link.card)).map((c) => c.uid));
  },
};
E['Harpie\'s Feather Duster'] = {
  canActivate: (e, _c, p, t) => isMain(t) && (e.spells(other(p)).length > 0 || !!e.player(other(p)).field),
  *resolve(e, _l, player) {
    const t = [...e.spells(other(player)), ...(e.player(other(player)).field ? [e.player(other(player)).field!] : [])];
    yield* e.destroy(t.map((c) => c.uid));
  },
};
E['De-Spell'] = {
  canActivate: (e, card, _p, t) => isMain(t) && allSpells(e).some((c) => c.uid !== card.uid && e.info(c.name).kind === 'spell'),
  *activate(e, link, player) {
    const targets = allSpells(e).filter((c) => c.uid !== link.card.uid && e.info(c.name).kind === 'spell');
    const picks = yield* e.select(player, 'Destroy which Spell?', e.optionsFor(targets, true), 1, 1, true);
    if (!picks) return false;
    link.targetUid = targets[picks[0]].uid;
  },
  *resolve(e, link) {
    if (link.targetUid !== undefined && e.fieldCard(link.targetUid)) yield* e.destroy([link.targetUid]);
  },
};
E['Stop Defense'] = {
  canActivate: (e, _c, p, t) => isMain(t) && e.monsters(other(p)).some((m) => m.pos === 'def'),
  *activate(e, link, player) {
    const targets = e.monsters(other(player)).filter((m) => m.pos === 'def');
    const picks = yield* e.select(player, 'Switch which monster to Attack Position?', e.optionsFor(targets, true), 1, 1, true);
    if (!picks) return false;
    link.targetUid = targets[picks[0]].uid;
  },
  *resolve(e, link) {
    const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
    if (m) {
      m.pos = 'atk';
      m.faceUp = true;
    }
  },
};
E['Block Attack'] = {
  canActivate: (e, _c, p, t) => isMain(t) && e.monsters(other(p)).some((m) => m.pos === 'atk' && m.faceUp),
  *activate(e, link, player) {
    const targets = e.monsters(other(player)).filter((m) => m.pos === 'atk' && m.faceUp);
    const picks = yield* e.select(player, 'Switch which monster to Defense Position?', e.optionsFor(targets), 1, 1, true);
    if (!picks) return false;
    link.targetUid = targets[picks[0]].uid;
  },
  *resolve(e, link) {
    const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
    if (m) m.pos = 'def';
  },
};
E['Card Destruction'] = {
  canActivate: (_e, _c, _p, t) => isMain(t),
  *resolve(e) {
    const counts: [number, number] = [e.player(0).hand.length, e.player(1).hand.length];
    for (const p of [0, 1] as Pid[]) for (const c of e.player(p).hand.slice()) yield* e.sendToGrave(c.uid, 'discard');
    for (const p of [0, 1] as Pid[]) if (e.state.winner === null && counts[p] > 0) e.draw(p, counts[p]);
  },
};
E['Waboku'] = {
  canActivate: (_e, _c, p, t, ctx) => t === 'attack' && ctx.uid !== undefined && !!ctx,
  *resolve(e, link, player) {
    e.log(player, 'Waboku: battle damage this turn is 0 and monsters are not destroyed');
    // Implemented as: end the current battle before damage.
    e.state.battle = null;
    for (const m of e.monsters(other(player))) m.attacked = true;
    void link;
  },
};
E['Reinforcements'] = {
  canActivate: (e, _c, p, t) => t === 'attack' && e.monsters(p).some((m) => m.faceUp),
  *activate(e, link, player) {
    const targets = e.monsters(player).filter((m) => m.faceUp);
    const picks = yield* e.select(player, 'Reinforcements: +500 ATK to which monster?', e.optionsFor(targets), 1, 1, true);
    if (!picks) return false;
    link.targetUid = targets[picks[0]].uid;
  },
  *resolve(e, link) {
    const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
    if (m) {
      m.atkMod += 500;
      m.turns = e.state.turn;
    }
  },
};
E['Castle Walls'] = {
  canActivate: (e, _c, p, t) => t === 'attack' && e.monsters(p).some((m) => m.faceUp),
  *activate(e, link, player) {
    const targets = e.monsters(player).filter((m) => m.faceUp);
    const picks = yield* e.select(player, 'Castle Walls: +500 DEF to which monster?', e.optionsFor(targets), 1, 1, true);
    if (!picks) return false;
    link.targetUid = targets[picks[0]].uid;
  },
  *resolve(e, link) {
    const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
    if (m) m.defMod += 500;
  },
};
E['Just Desserts'] = {
  canActivate: (e, _c, p) => e.monsters(other(p)).length > 0,
  *resolve(e, _l, player) {
    const n = e.monsters(other(player)).length;
    e.damage(other(player), n * 500);
  },
};
E['Ultimate Offering'] = {
  canActivate: (_e, _c, _p, t) => isMain(t),
  *resolve() {
    /* continuous: the extra-summon option is handled when scripted summons arrive */
  },
};
delete E['Ultimate Offering'];

// =====================================================================
// Expansion: Fusion, Ritual, Field Spells, and the rest of the early packs
// =====================================================================

const ctrl = (e: Engine, m: FieldCard): Pid => e.controller(m.uid) ?? m.owner;
const race = (r: string) => (e: Engine, m: FieldCard) => e.info(m.name).race === r;
const attr = (a: string) => (e: Engine, m: FieldCard) => e.info(m.name).attribute === a;
const countField = (e: Engine, test: (m: FieldCard) => boolean) => allMonsters(e).filter((m) => m.faceUp && test(m)).length;
const spellsOnField = (e: Engine, p: Pid) => [...e.spells(p), ...(e.player(p).field ? [e.player(p).field!] : [])];
const randomPick = <T>(e: Engine, list: T[]): T | undefined => (list.length ? list[Math.floor(e.rand() * list.length)] : undefined);

/** Returns a Spell/Trap from the field to the hand, detaching it from any host. */
function returnSpell(e: Engine, fc: FieldCard) {
  if (fc.equippedTo !== undefined) {
    const host = e.fieldCard(fc.equippedTo);
    if (host) host.equips = host.equips.filter((u) => u !== fc.uid);
  }
  e.toHand(fc.uid);
}

/** Equip with a host restriction (Dragon Treasure, Legendary Sword...). */
function equipFor(test: (e: Engine, m: FieldCard) => boolean, bonus: EffectDef['equipBonus'], extra: Partial<EffectDef> = {}): EffectDef {
  return {
    ...equip(bonus, extra),
    canActivate: (e, _c, _p, t) => isMain(t) && allMonsters(e).some((m) => m.faceUp && test(e, m)),
    *activate(e, link, player) {
      const targets = allMonsters(e).filter((m) => m.faceUp && test(e, m));
      const picks = yield* e.select(player, `Equip ${link.card.name} to which monster?`, e.optionsFor(targets), 1, 1, true);
      if (!picks) return false;
      link.targetUid = targets[picks[0]].uid;
    },
  };
}

// ---------- type-restricted equips ----------
E['Electro-Whip'] = equipFor(race('Thunder'), () => ({ atk: 300, def: 300 }));
E['Cyber Shield'] = equipFor((_e, m) => m.name === 'Harpie Lady' || m.name === 'Harpie Lady Sisters', () => ({ atk: 500, def: 0 }));
E['Steel Shell'] = equipFor(attr('WATER'), () => ({ atk: 400, def: -200 }));
E['Machine Conversion Factory'] = equipFor(race('Machine'), () => ({ atk: 300, def: 300 }));
E['Follow Wind'] = equipFor(race('Winged Beast'), () => ({ atk: 300, def: 300 }));
E["Elf's Light"] = equipFor(attr('LIGHT'), () => ({ atk: 400, def: -200 }));
E['Dragon Treasure'] = equipFor(race('Dragon'), () => ({ atk: 300, def: 300 }));
E['Vile Germs'] = equipFor(race('Plant'), () => ({ atk: 300, def: 300 }));
E['Salamandra'] = equipFor(attr('FIRE'), () => ({ atk: 700, def: 0 }));
E['Sword of Dark Destruction'] = equipFor(attr('DARK'), () => ({ atk: 400, def: -200 }));
E['Dark Energy'] = equipFor(race('Fiend'), () => ({ atk: 300, def: 300 }));
E['Beast Fangs'] = equipFor(race('Beast'), () => ({ atk: 300, def: 300 }));
E['Legendary Sword'] = equipFor(race('Warrior'), () => ({ atk: 300, def: 300 }));
E['Silver Bow and Arrow'] = equipFor(race('Fairy'), () => ({ atk: 300, def: 300 }));
E['Violet Crystal'] = equipFor(race('Zombie'), () => ({ atk: 300, def: 300 }));
E['Burning Spear'] = equipFor(attr('FIRE'), () => ({ atk: 400, def: -200 }));
E['Gust Fan'] = equipFor(attr('WIND'), () => ({ atk: 400, def: -200 }));
E['Mystical Moon'] = equipFor(race('Beast-Warrior'), () => ({ atk: 300, def: 300 }));
E['Raise Body Heat'] = equipFor(race('Dinosaur'), () => ({ atk: 300, def: 300 }));
E['Winged Trumpeter'] = equipFor(race('Fairy'), () => ({ atk: 300, def: 300 }));
E['Horn of Light'] = equip(() => ({ atk: 0, def: 800 }));
E['Paralyzing Potion'] = equipFor((e, m) => e.info(m.name).race !== 'Machine', () => ({ atk: 0, def: 0 }), { hostCannotAttack: () => true });

// ---------- Field Spells ----------
function fieldSpell(bonus: (e: Engine, m: FieldCard) => { atk: number; def: number } | undefined): EffectDef {
  return {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *resolve(e, link, player) {
      // Only one Field Spell stays out: the newer one replaces the opponent's.
      const theirs = e.player(other(player)).field;
      if (theirs && theirs.uid !== link.card.uid) {
        e.log(player, `${theirs.name} is replaced by ${link.card.name}`);
        yield* e.destroy([theirs.uid]);
      }
    },
    aura: (e, src, target) => (src.active ? bonus(e, target) : undefined),
  };
}
const raceField = (races: string[], minus: string[] = []) =>
  fieldSpell((e, m) => {
    const r = e.info(m.name).race ?? '';
    if (races.includes(r)) return { atk: 200, def: 200 };
    if (minus.includes(r)) return { atk: -200, def: -200 };
    return undefined;
  });
const attrField = (a: string) => fieldSpell((e, m) => (e.info(m.name).attribute === a ? { atk: 500, def: -400 } : undefined));
E['Wasteland'] = raceField(['Dinosaur', 'Zombie', 'Rock']);
E['Forest'] = raceField(['Insect', 'Beast', 'Plant', 'Beast-Warrior']);
E['Umi'] = raceField(['Fish', 'Sea Serpent', 'Thunder', 'Aqua'], ['Machine', 'Pyro']);
E['Sogen'] = raceField(['Warrior', 'Beast-Warrior']);
E['Yami'] = raceField(['Fiend', 'Spellcaster'], ['Fairy']);
E['Mountain'] = raceField(['Dragon', 'Winged Beast', 'Thunder']);
E['Rising Air Current'] = attrField('WIND');
E['Gaia Power'] = attrField('EARTH');
E['Luminous Spark'] = attrField('LIGHT');
E['Mystic Plasma Zone'] = attrField('DARK');
E['Molten Destruction'] = attrField('FIRE');
E['Chorus of Sanctuary'] = fieldSpell((_e, m) => (m.pos === 'def' ? { atk: 0, def: 500 } : undefined));

// ---------- monsters whose ATK depends on the board ----------
E['Machine King'] = { selfBonus: (e) => ({ atk: 100 * countField(e, (m) => e.info(m.name).race === 'Machine'), def: 0 }) };
E['Shadow Ghoul'] = { selfBonus: (e, m) => ({ atk: 100 * e.player(ctrl(e, m)).gy.filter((c) => isMonster(e, c)).length, def: 0 }) };
E['Buster Blader'] = {
  selfBonus: (e, m) => {
    const opp = e.player(other(ctrl(e, m)));
    const n = e.monsters(other(ctrl(e, m))).filter((x) => e.info(x.name).race === 'Dragon').length + opp.gy.filter((c) => e.info(c.name).race === 'Dragon').length;
    return { atk: 500 * n, def: 0 };
  },
};
E["Harpie's Pet Dragon"] = {
  selfBonus: (e) => {
    const n = countField(e, (m) => m.name === 'Harpie Lady' || m.name === 'Harpie Lady Sisters');
    return { atk: 300 * n, def: 300 * n };
  },
};
E['Swamp Battleguard'] = { selfBonus: (e, m) => ({ atk: 500 * e.monsters(ctrl(e, m)).filter((x) => x.faceUp && x.name === 'Lava Battleguard').length, def: 0 }) };
E['Lava Battleguard'] = { selfBonus: (e, m) => ({ atk: 500 * e.monsters(ctrl(e, m)).filter((x) => x.faceUp && x.name === 'Swamp Battleguard').length, def: 0 }) };
E['Dark Magician Girl'] = {
  selfBonus: (e) => ({ atk: 300 * [...e.player(0).gy, ...e.player(1).gy].filter((c) => c.name === 'Dark Magician' || c.name === 'Magician of Black Chaos').length, def: 0 }),
};
E['Flash Assailant'] = { selfBonus: (e, m) => ({ atk: -400 * e.player(ctrl(e, m)).hand.length, def: -400 * e.player(ctrl(e, m)).hand.length }) };
E['Insect Queen'] = {
  selfBonus: (e) => ({ atk: 200 * countField(e, (m) => e.info(m.name).race === 'Insect'), def: 0 }),
  attackCost: {
    can: (e, m, p) => e.monsters(p).some(notThisCard(m)),
    *pay(e, m, p) {
      const targets = e.monsters(p).filter(notThisCard(m));
      const picks = yield* e.select(p, 'Insect Queen: Tribute which monster to attack?', e.optionsFor(targets), 1, 1);
      if (picks && targets[picks[0]]) yield* e.sendToGrave(targets[picks[0]].uid, 'tribute');
    },
  },
};
E['Star Boy'] = {
  aura: (e, _src, m) => (e.info(m.name).attribute === 'WATER' ? { atk: 500, def: 0 } : e.info(m.name).attribute === 'FIRE' ? { atk: -400, def: 0 } : undefined),
};
E['Hoshiningen'] = {
  aura: (e, _src, m) => (e.info(m.name).attribute === 'LIGHT' ? { atk: 500, def: 0 } : e.info(m.name).attribute === 'DARK' ? { atk: -400, def: 0 } : undefined),
};
E['Jinzo'] = { sealsTraps: true };
E['Harpie Lady Sisters'] = { cannotNormalSummon: true };

// ---------- direct attackers and attack costs ----------
for (const n of ['Jinzo #7', "Queen's Double", 'Mystic Lamp', 'Ooguchi', 'Leghul']) E[n] = { directAttack: true };
E['Dark Elf'] = {
  attackCost: {
    can: (e, _m, p) => e.player(p).lp > 1000,
    *pay(e, _m, p) {
      e.log(p, 'Dark Elf: 1000 LP paid to attack');
      e.payLp(p, 1000);
    },
  },
};
E['Jirai Gumo'] = {
  attackCost: {
    can: () => true,
    *pay(e, _m, p) {
      const heads = yield* e.yesno(p, 'Jirai Gumo: call Heads? (No = Tails)');
      const toss = e.roll(2) === 1;
      if (heads === toss) e.log(p, `Jirai Gumo: the coin shows ${toss ? 'Heads' : 'Tails'}. Called right!`);
      else {
        e.log(p, `Jirai Gumo: the coin shows ${toss ? 'Heads' : 'Tails'}. Called wrong, half LP lost`);
        e.payLp(p, Math.floor(e.player(p).lp / 2));
      }
    },
  },
};

// ---------- FLIP monsters ----------
E['Skelengel'] = {
  *flip(e, _m, controller) {
    e.draw(controller, 1);
  },
};
E['Hane-Hane'] = {
  *flip(e, _m, controller) {
    const targets = allMonsters(e);
    const picks = yield* e.select(controller, 'Hane-Hane: return which monster to the hand?', e.optionsFor(targets, true), 1, 1);
    if (picks && targets[picks[0]]) {
      e.log(controller, `${targets[picks[0]].faceUp ? targets[picks[0]].name : 'A face-down monster'} returns to the hand`);
      e.toHand(targets[picks[0]].uid);
    }
  },
};
E['Big Eye'] = {
  *flip(e, _m, controller) {
    const ps = e.player(controller);
    const top = ps.deck.slice(0, 5);
    if (top.length < 2) return;
    const picks = yield* e.select(controller, 'Big Eye: which of your top cards do you want to draw next?', e.optionsFor(top), 1, 1);
    if (picks && top[picks[0]]) e.toDeckTop(top[picks[0]].uid);
  },
};
E['Cyber Jar'] = {
  *flip(e) {
    e.log(null, 'Cyber Jar destroys every monster and both players reveal 5 cards');
    yield* e.destroy(allMonsters(e).map((m) => m.uid));
    for (const p of [0, 1] as Pid[]) {
      const ps = e.player(p);
      const top = ps.deck.slice(0, 5);
      for (const c of top) {
        const info = e.info(c.name);
        if (info.kind === 'monster' && (info.level ?? 1) <= 4 && info.sub !== 'Fusion' && info.sub !== 'Ritual' && hasFreeZone(e, p)) {
          const atkPos = (info.atk ?? 0) >= (info.def ?? 0);
          yield* e.specialSummon(c.uid, p, atkPos ? 'atk' : 'def', atkPos);
        } else {
          e.toHand(c.uid);
        }
      }
      e.log(p, `${ps.name} revealed ${top.map((c) => c.name).join(', ')}`);
    }
  },
};
function trapBreaker(name: string): EffectDef {
  return {
    *flip(e, _m, controller) {
      const targets = [...spellsOnField(e, 0), ...spellsOnField(e, 1)].filter((c) => e.info(c.name).kind === 'trap' || !c.faceUp);
      const picks = yield* e.select(controller, `${name}: destroy which Trap?`, e.optionsFor(targets, true), 1, 1);
      if (!picks || !targets[picks[0]]) return;
      const t = targets[picks[0]];
      if (e.info(t.name).kind === 'trap') {
        e.log(controller, `${name} destroys ${t.name}`);
        yield* e.destroy([t.uid]);
      } else e.log(controller, `${name}: ${t.name} was a Spell Card and stays`);
    },
  };
}
E['Reaper of the Cards'] = trapBreaker('Reaper of the Cards');
E['Trap Master'] = trapBreaker('Trap Master');
E['Armed Ninja'] = {
  *flip(e, _m, controller) {
    const targets = [...spellsOnField(e, 0), ...spellsOnField(e, 1)].filter((c) => e.info(c.name).kind === 'spell' || !c.faceUp);
    const picks = yield* e.select(controller, 'Armed Ninja: destroy which Spell?', e.optionsFor(targets, true), 1, 1);
    if (!picks || !targets[picks[0]]) return;
    const t = targets[picks[0]];
    if (e.info(t.name).kind === 'spell') {
      e.log(controller, `Armed Ninja destroys ${t.name}`);
      yield* e.destroy([t.uid]);
    } else e.log(controller, `Armed Ninja: ${t.name} was a Trap Card and stays`);
  },
};
E['Greenkappa'] = {
  *flip(e, _m, controller) {
    const targets = [...e.spells(0), ...e.spells(1)].filter((c) => !c.faceUp);
    const picks = yield* e.select(controller, 'Greenkappa: destroy which 2 Set cards?', e.optionsFor(targets, true), Math.min(2, targets.length), 2);
    if (picks) yield* e.destroy(picks.map((i) => targets[i].uid));
  },
};
E["Hiro's Shadow Scout"] = {
  *flip(e, _m, controller) {
    const opp = other(controller);
    const before = e.player(opp).hand.length;
    if (!e.draw(opp, 3)) return;
    const drawn = e.player(opp).hand.slice(before);
    const spells = drawn.filter((c) => isSpell(e, c));
    e.log(controller, `Hiro's Shadow Scout: ${e.player(opp).name} drew ${drawn.map((c) => c.name).join(', ')}`);
    for (const c of spells) yield* e.discard(opp, c.uid);
  },
};
E['Invader of the Throne'] = {
  *flip(e, m, controller, destroyed) {
    if (destroyed || e.state.phase === 'BP' || !e.fieldCard(m.uid)) return;
    const opp = other(controller);
    const targets = e.monsters(opp);
    const picks = yield* e.select(controller, 'Invader of the Throne: switch control with which monster?', e.optionsFor(targets, true), 1, 1, true);
    if (!picks || !targets[picks[0]]) return;
    const t = targets[picks[0]];
    const a = e.find(m.uid)!;
    const b = e.find(t.uid)!;
    e.player(controller).mz[a.loc.index] = t;
    e.player(opp).mz[b.loc.index] = m;
    m.posChanged = t.posChanged = true;
    e.log(controller, `Invader of the Throne trades places with ${t.faceUp ? t.name : 'a face-down monster'}`);
  },
};
E['Mask of Darkness'] = {
  *flip(e, _m, controller) {
    const targets = e.player(controller).gy.filter((c) => e.info(c.name).kind === 'trap');
    const picks = yield* e.select(controller, 'Mask of Darkness: return which Trap to your hand?', e.optionsFor(targets), 1, 1);
    if (picks && targets[picks[0]]) e.toHand(targets[picks[0]].uid);
  },
};
E['Princess of Tsurugi'] = {
  *flip(e, _m, controller) {
    const n = spellsOnField(e, other(controller)).length;
    if (n) e.damage(other(controller), 500 * n);
  },
};
E['Spear Cretin'] = {
  *onLeaveField(e, fc) {
    if (!fc.faceUp) return;
    for (const p of [0, 1] as Pid[]) {
      if (!hasFreeZone(e, p)) continue;
      const targets = e.player(p).gy.filter((c) => isMonster(e, c) && c.uid !== fc.uid && e.info(c.name).sub !== 'Fusion' && e.info(c.name).sub !== 'Ritual');
      const picks = yield* e.select(p, 'Spear Cretin: Special Summon which monster from your Graveyard?', e.optionsFor(targets), 1, 1, true);
      if (!picks || !targets[picks[0]]) continue;
      const info = e.info(targets[picks[0]].name);
      const atkPos = (info.atk ?? 0) >= (info.def ?? 0);
      yield* e.specialSummon(targets[picks[0]].uid, p, atkPos ? 'atk' : 'def', atkPos);
    }
  },
};
E['Cockroach Knight'] = {
  *onToGraveFromField(e, card) {
    e.log(card.owner, 'Cockroach Knight returns to the top of the Deck');
    e.toDeckTop(card.uid);
  },
};

// ---------- battle-triggered monsters ----------
E['The Bistro Butcher'] = {
  *onBattleDamage(e, _m, p) {
    e.draw(other(p), 2);
  },
};
E['White Magical Hat'] = {
  *onBattleDamage(e, _m, p) {
    const c = randomPick(e, e.player(other(p)).hand);
    if (c) yield* e.discard(other(p), c.uid);
  },
};
E['Wall of Illusion'] = {
  *onAttacked(e, _t, attacker) {
    if (e.fieldCard(attacker.uid)) {
      e.log(null, `Wall of Illusion sends ${attacker.name} back to the hand`);
      e.toHand(attacker.uid);
    }
  },
};
E['Big Shield Gardna'] = {
  *onAttacked(e, t, _a, _c, destroyed) {
    if (!destroyed && e.fieldCard(t.uid)) t.pos = 'atk';
  },
};
E['D.D. Warrior'] = {
  *afterBattle(e, m, target) {
    if (e.fieldCard(target.uid)) e.banish(target.uid);
    if (e.fieldCard(m.uid)) e.banish(m.uid);
  },
  *onAttacked(e, t, attacker) {
    if (e.fieldCard(attacker.uid)) e.banish(attacker.uid);
    if (e.fieldCard(t.uid)) e.banish(t.uid);
  },
};
const recruiter = (a: string): EffectDef => ({
  *onDestroyedByBattle(e, m, controller) {
    if (!hasFreeZone(e, controller)) return;
    const ps = e.player(controller);
    const targets = ps.deck.filter((c) => isMonster(e, c) && (e.info(c.name).atk ?? 0) <= 1500 && e.info(c.name).attribute === a && e.info(c.name).sub !== 'Fusion' && e.info(c.name).sub !== 'Ritual');
    if (!targets.length) return;
    const picks = yield* e.select(controller, `${m.name}: Special Summon which ${a} monster from your Deck?`, e.optionsFor(targets), 1, 1, true);
    if (!picks || !targets[picks[0]]) return;
    yield* e.specialSummon(targets[picks[0]].uid, controller, 'atk');
    ps.deck = e.shuffle(ps.deck);
  },
});
E['Giant Rat'] = recruiter('EARTH');
E['Mystic Tomato'] = recruiter('DARK');
E['Shining Angel'] = recruiter('LIGHT');
E['Mother Grizzly'] = recruiter('WATER');
E['UFO Turtle'] = recruiter('FIRE');
E['Flying Kamakiri #1'] = recruiter('WIND');
E['Giant Germ'] = {
  *onDestroyedByBattle(e, _m, controller) {
    e.damage(other(controller), 500);
    const ps = e.player(controller);
    const more = ps.deck.filter((c) => c.name === 'Giant Germ');
    if (!more.length || !hasFreeZone(e, controller) || e.state.winner !== null) return;
    if (!(yield* e.yesno(controller, 'Giant Germ: Special Summon the other Giant Germs from your Deck?'))) return;
    for (const c of more) if (hasFreeZone(e, controller)) yield* e.specialSummon(c.uid, controller, 'atk');
    ps.deck = e.shuffle(ps.deck);
  },
};
E['Nimble Momonga'] = {
  *onDestroyedByBattle(e, _m, controller) {
    e.gainLp(controller, 1000);
    const ps = e.player(controller);
    const more = ps.deck.filter((c) => c.name === 'Nimble Momonga');
    if (!more.length || !hasFreeZone(e, controller)) return;
    if (!(yield* e.yesno(controller, 'Nimble Momonga: Set the other Nimble Momongas from your Deck?'))) return;
    for (const c of more) if (hasFreeZone(e, controller)) yield* e.specialSummon(c.uid, controller, 'def', false);
    ps.deck = e.shuffle(ps.deck);
  },
};

// ---------- position-change and summon triggers ----------
E['Dream Clown'] = {
  *onPositionChange(e, m, p) {
    if (m.pos !== 'def') return;
    const targets = e.monsters(other(p));
    const picks = yield* e.select(p, 'Dream Clown: destroy which monster?', e.optionsFor(targets, true), 1, 1);
    if (picks && targets[picks[0]]) yield* e.destroy([targets[picks[0]].uid]);
  },
};
E['Crass Clown'] = {
  *onPositionChange(e, m, p) {
    if (m.pos !== 'atk') return;
    const targets = e.monsters(other(p));
    const picks = yield* e.select(p, 'Crass Clown: return which monster to the hand?', e.optionsFor(targets, true), 1, 1);
    if (picks && targets[picks[0]]) e.toHand(targets[picks[0]].uid);
  },
};
E['Dragon Seeker'] = {
  *onSummon(e, m, p) {
    const targets = allMonsters(e).filter((x) => x.faceUp && x.uid !== m.uid && e.info(x.name).race === 'Dragon');
    const picks = yield* e.select(p, 'Dragon Seeker: destroy which Dragon?', e.optionsFor(targets), 1, 1);
    if (picks && targets[picks[0]]) yield* e.destroy([targets[picks[0]].uid]);
  },
};
const deckSearch = (title: string, test: (e: Engine, c: Card) => boolean): EffectDef['onSummon'] =>
  function* (e, _m, p) {
    const ps = e.player(p);
    const targets = ps.deck.filter((c) => test(e, c));
    if (!targets.length) return;
    const picks = yield* e.select(p, title, e.optionsFor(targets), 1, 1, true);
    if (!picks || !targets[picks[0]]) return;
    e.toHand(targets[picks[0]].uid);
    e.log(p, `${ps.name} adds ${targets[picks[0]].name} to the hand`);
    ps.deck = e.shuffle(ps.deck);
  };
E['Senju of the Thousand Hands'] = { onSummon: deckSearch('Senju: add which Ritual Monster to your hand?', (e, c) => e.info(c.name).sub === 'Ritual' && isMonster(e, c)) };
E['Sonic Bird'] = { onSummon: deckSearch('Sonic Bird: add which Ritual Spell to your hand?', (e, c) => isSpell(e, c) && e.info(c.name).sub === 'Ritual') };

// ---------- ignition effects ----------
E['Cannon Soldier'] = {
  ignition: {
    can: (e, _m, p) => e.monsters(p).length > 0,
    *run(e, _m, p) {
      const targets = e.monsters(p);
      const picks = yield* e.select(p, 'Cannon Soldier: Tribute which monster?', e.optionsFor(targets), 1, 1, true);
      if (!picks || !targets[picks[0]]) return;
      yield* e.sendToGrave(targets[picks[0]].uid, 'tribute');
      e.log(p, 'Cannon Soldier fires for 500 damage');
      e.damage(other(p), 500);
    },
  },
};
E['Time Wizard'] = {
  ignition: {
    can: () => true,
    *run(e, _m, p) {
      const heads = yield* e.yesno(p, 'Time Wizard: call Heads? (No = Tails)');
      const toss = e.roll(2) === 1;
      if (heads === toss) {
        e.log(p, `Time Wizard: ${toss ? 'Heads' : 'Tails'}! Time Magic destroys the opponent's monsters`);
        yield* e.destroy(e.monsters(other(p)).map((m) => m.uid));
      } else {
        const mine = e.monsters(p);
        const dmg = Math.floor(mine.filter((m) => m.faceUp).reduce((a, m) => a + e.atkOf(m), 0) / 2);
        e.log(p, `Time Wizard: ${toss ? 'Heads' : 'Tails'}. Wrong call! Your monsters are destroyed`);
        yield* e.destroy(mine.map((m) => m.uid));
        if (dmg) e.damage(p, dmg);
      }
    },
  },
};
E['Barrel Dragon'] = {
  ignition: {
    can: (e, _m, p) => e.monsters(other(p)).length > 0,
    *run(e, _m, p) {
      const targets = e.monsters(other(p));
      const picks = yield* e.select(p, 'Barrel Dragon: fire at which monster?', e.optionsFor(targets, true), 1, 1, true);
      if (!picks || !targets[picks[0]]) return;
      const heads = [e.roll(2), e.roll(2), e.roll(2)].filter((r) => r === 1).length;
      e.log(p, `Barrel Dragon: ${heads} of 3 coins show Heads`);
      if (heads >= 2) yield* e.destroy([targets[picks[0]].uid]);
    },
  },
};
E['Karate Man'] = {
  ignition: {
    can: (_e, m) => m.counters === 0,
    *run(e, m) {
      m.atkMod += e.info(m.name).atk ?? 0;
      m.counters = 1;
      e.log(ctrl(e, m), 'Karate Man doubles its ATK until the End Phase');
    },
  },
  *onEndPhase(e, m) {
    if (m.counters > 0) {
      e.log(ctrl(e, m), 'Karate Man collapses');
      yield* e.destroy([m.uid]);
    }
  },
};

// ---------- Normal Spells ----------
const lpSpell = (n: number): EffectDef => ({ canActivate: (_e, _c, _p, t) => isMain(t), *resolve(e, _l, p) { e.gainLp(p, n); } });
E['Mooyan Curry'] = lpSpell(200);
E['Blue Medicine'] = lpSpell(400);
E['Soul of the Pure'] = lpSpell(800);
E['Raimei'] = { canActivate: (_e, _c, _p, t) => isMain(t), *resolve(e, _l, p) { e.damage(other(p), 300); } };
E['Upstart Goblin'] = {
  canActivate: (_e, _c, _p, t) => isMain(t),
  *resolve(e, _l, p) {
    if (e.draw(p, 1)) e.gainLp(other(p), 1000);
  },
};
E['Giant Trunade'] = {
  canActivate: (e, _c, _p, t) => isMain(t) && allSpells(e).length > 1,
  *resolve(e, link) {
    e.log(link.player, 'Giant Trunade blows every Spell and Trap back to the hand');
    for (const c of allSpells(e)) if (c.uid !== link.card.uid) returnSpell(e, c);
  },
};
E['Dark-Piercing Light'] = {
  canActivate: (e, _c, p, t) => isMain(t) && e.monsters(other(p)).some((m) => !m.faceUp),
  *resolve(e, _l, p) {
    for (const m of e.monsters(other(p)).filter((x) => !x.faceUp)) {
      m.faceUp = true;
      e.event('flip', { uid: m.uid, player: other(p) });
      e.log(p, `${m.name} is flipped face-up`);
      yield* e.flipEffect(m.uid, other(p));
    }
  },
};
E['Delinquent Duo'] = {
  canActivate: (e, _c, p, t) => isMain(t) && e.player(p).lp > 1000 && e.player(other(p)).hand.length > 0,
  *resolve(e, _l, p) {
    e.payLp(p, 1000);
    const opp = other(p);
    const first = randomPick(e, e.player(opp).hand);
    if (first) yield* e.discard(opp, first.uid);
    const hand = e.player(opp).hand;
    if (!hand.length) return;
    const picks = yield* e.select(opp, 'Delinquent Duo: discard 1 more card', e.optionsFor(hand), 1, 1);
    if (picks && hand[picks[0]]) yield* e.discard(opp, hand[picks[0]].uid);
  },
};
E['Confiscation'] = {
  canActivate: (e, _c, p, t) => isMain(t) && e.player(p).lp > 1000 && e.player(other(p)).hand.length > 0,
  *resolve(e, _l, p) {
    e.payLp(p, 1000);
    const hand = e.player(other(p)).hand;
    const picks = yield* e.select(p, "Confiscation: discard which card from the opponent's hand?", e.optionsFor(hand), 1, 1);
    if (picks && hand[picks[0]]) yield* e.discard(other(p), hand[picks[0]].uid);
  },
};
E['Gravedigger Ghoul'] = {
  canActivate: (e, _c, p, t) => isMain(t) && e.player(other(p)).gy.some((c) => isMonster(e, c)),
  *resolve(e, _l, p) {
    const targets = e.player(other(p)).gy.filter((c) => isMonster(e, c));
    const picks = yield* e.select(p, 'Gravedigger Ghoul: remove up to 2 monsters from play', e.optionsFor(targets), 1, 2);
    if (picks) for (const i of picks) e.banish(targets[i].uid);
  },
};
const wipe = (test: (e: Engine, m: FieldCard) => boolean, label: string): EffectDef => ({
  canActivate: (e, _c, _p, t) => isMain(t) && allMonsters(e).some((m) => test(e, m)),
  *resolve(e, link) {
    const targets = allMonsters(e).filter((m) => test(e, m));
    e.log(link.player, `${link.card.name} destroys ${targets.length} ${label}`);
    yield* e.destroy(targets.map((m) => m.uid));
  },
});
E['Warrior Elimination'] = wipe((e, m) => e.info(m.name).race === 'Warrior', 'Warriors');
E['Eradicating Aerosol'] = wipe((e, m) => e.info(m.name).race === 'Insect', 'Insects');
E['Acid Rain'] = wipe((e, m) => m.faceUp && e.info(m.name).race === 'Machine', 'Machines');
E['Breath of Light'] = wipe((e, m) => m.faceUp && e.info(m.name).race === 'Rock', 'Rock monsters');
E['Eternal Rest'] = wipe((_e, m) => m.equips.length > 0, 'equipped monsters');
E['Tribute to the Doomed'] = {
  canActivate: (e, c, p, t) => isMain(t) && e.player(p).hand.some(notThisCard(c)) && allMonsters(e).length > 0,
  *activate(e, link, p) {
    const hand = e.player(p).hand.filter(notThisCard(link.card));
    const d = yield* e.select(p, 'Tribute to the Doomed: discard which card?', e.optionsFor(hand), 1, 1, true);
    if (!d) return false;
    const targets = allMonsters(e);
    const picks = yield* e.select(p, 'Tribute to the Doomed: destroy which monster?', e.optionsFor(targets, true), 1, 1, true);
    if (!picks) return false;
    yield* e.discard(p, hand[d[0]].uid);
    link.targetUid = targets[picks[0]].uid;
  },
  *resolve(e, link) {
    if (link.targetUid !== undefined && e.fieldCard(link.targetUid)) yield* e.destroy([link.targetUid]);
  },
};
E['Riryoku'] = {
  canActivate: (e, _c, _p, t) => isMain(t) && allMonsters(e).filter((m) => m.faceUp).length >= 2,
  *activate(e, link, p) {
    const targets = allMonsters(e).filter((m) => m.faceUp);
    const picks = yield* e.select(p, 'Riryoku: pick the monster to halve, then the monster to power up', e.optionsFor(targets), 2, 2, true);
    if (!picks || picks.length < 2) return false;
    link.payload = picks.map((i) => targets[i].uid);
  },
  *resolve(e, link) {
    const [a, b] = (link.payload as number[]).map((u) => e.fieldCard(u));
    if (!a || !b) return;
    const half = Math.floor(e.atkOf(a) / 2);
    a.atkMod -= half;
    b.atkMod += half;
    e.log(link.player, `Riryoku moves ${half} ATK from ${a.name} to ${b.name}`);
  },
};
const boost = (title: string, stat: 'atk' | 'def', amount: number): EffectDef => ({
  canActivate: (e, _c, _p, t) => (isMain(t) || t === 'attack') && allMonsters(e).some((m) => m.faceUp),
  *activate(e, link, p) {
    const targets = allMonsters(e).filter((m) => m.faceUp);
    const picks = yield* e.select(p, title, e.optionsFor(targets), 1, 1, true);
    if (!picks) return false;
    link.targetUid = targets[picks[0]].uid;
  },
  *resolve(e, link) {
    const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
    if (!m) return;
    if (stat === 'atk') m.atkMod += amount;
    else m.defMod += amount;
  },
});
E['Rush Recklessly'] = boost('Rush Recklessly: +700 ATK to which monster?', 'atk', 700);
E['The Reliable Guardian'] = boost('The Reliable Guardian: +700 DEF to which monster?', 'def', 700);
E['Snake Fang'] = boost('Snake Fang: -500 DEF to which monster?', 'def', -500);
E['Graceful Dice'] = {
  canActivate: (e, _c, p, t) => (isMain(t) || t === 'attack') && e.monsters(p).some((m) => m.faceUp),
  *resolve(e, _l, p) {
    const r = e.roll(6);
    e.log(p, `Graceful Dice rolls a ${r}`);
    for (const m of e.monsters(p)) (m.atkMod += r * 100), (m.defMod += r * 100);
  },
};
E['Skull Dice'] = {
  canActivate: (e, _c, p, t) => (isMain(t) || t === 'attack') && e.monsters(other(p)).some((m) => m.faceUp),
  *resolve(e, _l, p) {
    const r = e.roll(6);
    e.log(p, `Skull Dice rolls a ${r}`);
    for (const m of e.monsters(other(p))) (m.atkMod -= r * 100), (m.defMod -= r * 100);
  },
};
E['Painful Choice'] = {
  canActivate: (e, _c, p, t) => isMain(t) && e.player(p).deck.length >= 5,
  *resolve(e, _l, p) {
    const deck = e.player(p).deck;
    const picks = yield* e.select(p, 'Painful Choice: show 5 cards from your Deck', e.optionsFor(deck), 5, 5);
    if (!picks) return;
    const shown = picks.map((i) => deck[i]);
    const keep = yield* e.select(other(p), `Painful Choice: which card does ${e.player(p).name} keep?`, e.optionsFor(shown), 1, 1);
    const kept = keep ? shown[keep[0]] : shown[0];
    e.toHand(kept.uid);
    for (const c of shown) if (c.uid !== kept.uid) yield* e.sendToGrave(c.uid, 'discard');
    e.player(p).deck = e.shuffle(e.player(p).deck);
  },
};
E['Share the Pain'] = {
  canActivate: (e, _c, p, t) => isMain(t) && e.monsters(p).length > 0 && e.monsters(other(p)).length > 0,
  *activate(e, link, p) {
    const mine = e.monsters(p);
    const picks = yield* e.select(p, 'Share the Pain: Tribute which monster?', e.optionsFor(mine), 1, 1, true);
    if (!picks) return false;
    yield* e.sendToGrave(mine[picks[0]].uid, 'tribute');
    void link;
  },
  *resolve(e, _l, p) {
    const theirs = e.monsters(other(p));
    const picks = yield* e.select(other(p), 'Share the Pain: Tribute which monster?', e.optionsFor(theirs), 1, 1);
    if (picks && theirs[picks[0]]) yield* e.sendToGrave(theirs[picks[0]].uid, 'tribute');
  },
};
E['The Shallow Grave'] = {
  canActivate: (e, _c, _p, t) => isMain(t) && ([0, 1] as Pid[]).every((p) => hasFreeZone(e, p) && e.player(p).gy.some((c) => isMonster(e, c))),
  *resolve(e) {
    for (const p of [0, 1] as Pid[]) {
      const targets = e.player(p).gy.filter((c) => isMonster(e, c) && e.info(c.name).sub !== 'Fusion' && e.info(c.name).sub !== 'Ritual');
      const picks = yield* e.select(p, 'The Shallow Grave: Set which monster from your Graveyard?', e.optionsFor(targets), 1, 1);
      if (picks && targets[picks[0]] && hasFreeZone(e, p)) yield* e.specialSummon(targets[picks[0]].uid, p, 'def', false);
    }
  },
};
E['Fusion Sage'] = {
  canActivate: (e, _c, p, t) => isMain(t) && e.player(p).deck.some((c) => c.name === 'Polymerization'),
  *resolve(e, _l, p) {
    const ps = e.player(p);
    const c = ps.deck.find((x) => x.name === 'Polymerization');
    if (c) {
      e.toHand(c.uid);
      e.log(p, `${ps.name} adds Polymerization to the hand`);
      ps.deck = e.shuffle(ps.deck);
    }
  },
};
E['Elegant Egotist'] = {
  canActivate: (e, _c, p, t) => {
    const ps = e.player(p);
    return isMain(t) && hasFreeZone(e, p) && allMonsters(e).some((m) => m.faceUp && m.name === 'Harpie Lady') && [...ps.hand, ...ps.deck].some((c) => c.name === 'Harpie Lady' || c.name === 'Harpie Lady Sisters');
  },
  *resolve(e, _l, p) {
    const ps = e.player(p);
    const targets = [...ps.hand, ...ps.deck].filter((c) => c.name === 'Harpie Lady' || c.name === 'Harpie Lady Sisters');
    const picks = yield* e.select(p, 'Elegant Egotist: Special Summon which Harpie?', e.optionsFor(targets), 1, 1);
    if (picks && targets[picks[0]] && hasFreeZone(e, p)) {
      yield* e.specialSummon(targets[picks[0]].uid, p, 'atk');
      ps.deck = e.shuffle(ps.deck);
    }
  },
};
E['Messenger of Peace'] = {
  canActivate: (_e, _c, _p, t) => isMain(t),
  *resolve() {},
  blocksAttack: (e, _card, m) => e.atkOf(m) >= 1500,
  *onStandby(e, card, controller) {
    if (e.state.turnPlayer !== controller) return;
    if (e.player(controller).lp > 100) {
      e.log(controller, 'Messenger of Peace: 100 LP paid');
      e.payLp(controller, 100);
    } else yield* e.destroy([card.uid]);
  },
};

// ---------- Polymerization ----------
type FusionPlan = { fusion: Card; mats: Card[][] };
/** Every Fusion Monster in the Fusion Deck the player could fuse right now, with the candidate cards for each material. */
function fusionPlans(e: Engine, p: Pid): FusionPlan[] {
  const ps = e.player(p);
  const pool: Card[] = [...ps.hand.filter((c) => isMonster(e, c)), ...e.monsters(p)];
  const out: FusionPlan[] = [];
  for (const fusion of ps.fusion) {
    const ids = e.fusionMaterials(fusion.name);
    if (!ids) continue;
    const mats = ids.map((id) => pool.filter((c) => e.info(c.name).id === id));
    if (!assignable(mats)) continue;
    out.push({ fusion, mats });
  }
  return out;
}
function assignable(mats: Card[][], used: number[] = []): boolean {
  if (mats.length === 0) return true;
  return mats[0].some((c) => !used.includes(c.uid) && assignable(mats.slice(1), [...used, c.uid]));
}
E['Polymerization'] = {
  canActivate: (e, _c, p, t) => isMain(t) && fusionPlans(e, p).length > 0,
  *activate(e, link, p) {
    const plans = fusionPlans(e, p);
    const picks = yield* e.select(p, 'Polymerization: Fusion Summon which monster?', e.optionsFor(plans.map((x) => x.fusion)), 1, 1, true);
    if (!picks) return false;
    const plan = plans[picks[0]];
    const chosen: number[] = [];
    for (const cands of plan.mats) {
      const free = cands.filter((c) => !chosen.includes(c.uid));
      if (free.length === 0) return false;
      if (free.length === 1) {
        chosen.push(free[0].uid);
        continue;
      }
      const pk = yield* e.select(p, `Polymerization: use which ${free[0].name}?`, e.optionsFor(free), 1, 1, true);
      if (!pk) return false;
      chosen.push(free[pk[0]].uid);
    }
    link.payload = { fusion: plan.fusion.uid, mats: chosen };
  },
  *resolve(e, link, p) {
    const { fusion, mats } = link.payload as { fusion: number; mats: number[] };
    if (!e.find(fusion) || mats.some((u) => !e.find(u))) return;
    for (const u of mats) yield* e.sendToGrave(u, 'used');
    if (!hasFreeZone(e, p)) return;
    yield* e.specialSummon(fusion, p, 'atk');
    e.log(p, `${e.player(p).name} Fusion Summons ${e.find(fusion)?.card.name ?? 'a monster'}!`);
  },
};

// ---------- Ritual Spells ----------
function ritualSpell(): EffectDef {
  const levelOf = (e: Engine, c: Card) => e.info(c.name).level ?? 1;
  const pool = (e: Engine, p: Pid, ritualUid: number) => [...e.player(p).hand.filter((c) => isMonster(e, c) && c.uid !== ritualUid), ...e.monsters(p)];
  return {
    canActivate: (e, c, p, t) => {
      if (!isMain(t)) return false;
      const r = e.ritualOf(c.name);
      if (!r) return false;
      const mon = e.player(p).hand.find((h) => h.name === r.monster);
      if (!mon) return false;
      const cands = pool(e, p, mon.uid);
      const total = cands.reduce((a, x) => a + levelOf(e, x), 0);
      return total >= r.level && (hasFreeZone(e, p) || cands.some((x) => 'pos' in x));
    },
    *activate(e, link, p) {
      const r = e.ritualOf(link.card.name)!;
      const mon = e.player(p).hand.find((h) => h.name === r.monster);
      if (!mon) return false;
      const cands = pool(e, p, mon.uid);
      for (let tries = 0; tries < 3; tries++) {
        const picks = yield* e.select(p, `Ritual: Tribute monsters with total Level ${r.level} or more`, e.optionsFor(cands), 1, cands.length, true);
        if (!picks) return false;
        const total = picks.reduce((a, i) => a + levelOf(e, cands[i]), 0);
        if (total >= r.level) {
          link.payload = { monster: mon.uid, tributes: picks.map((i) => cands[i].uid) };
          return;
        }
        e.log(p, `Those monsters only add up to Level ${total}; ${r.level} is needed`);
      }
      return false;
    },
    *resolve(e, link, p) {
      const { monster, tributes } = link.payload as { monster: number; tributes: number[] };
      if (!e.find(monster)) return;
      for (const u of tributes) if (e.find(u)) yield* e.sendToGrave(u, 'tribute');
      if (!hasFreeZone(e, p)) return;
      yield* e.specialSummon(monster, p, 'atk');
      e.log(p, `${e.player(p).name} Ritual Summons ${e.find(monster)?.card.name ?? 'a monster'}!`);
    },
  };
}
for (const n of ['Black Luster Ritual', 'Black Magic Ritual', 'Dark Magic Ritual', 'Zera Ritual', 'Javelin Beetle Pact', 'Garma Sword Oath', "Novox's Prayer", 'Black Illusion Ritual', 'Hamburger Recipe', "Fortress Whale's Oath", 'Resurrection of Chakra', 'Turtle Oath', 'Commencement Dance', 'War-Lion Ritual', 'Curse of the Masked Beast', 'Contract with the Abyss']) E[n] = ritualSpell();

// ---------- Traps ----------
const attackingOpp = (e: Engine, p: Pid, t: Trigger, ctx: ChainCtx) => t === 'attack' && ctx.uid !== undefined && e.controller(ctx.uid) === other(p) && !!e.state.battle;
E['Negate Attack'] = {
  canActivate: (e, _c, p, t, ctx) => attackingOpp(e, p, t, ctx),
  *resolve(e, _l, p) {
    e.log(p, 'Negate Attack stops the attack and ends the Battle Phase');
    e.endBattle();
    for (const m of e.monsters(other(p))) m.attacked = true;
  },
};
E['Widespread Ruin'] = {
  canActivate: (e, _c, p, t, ctx) => attackingOpp(e, p, t, ctx) && e.monsters(other(p)).some((m) => m.faceUp && m.pos === 'atk'),
  *resolve(e, _l, p) {
    const targets = e.monsters(other(p)).filter((m) => m.faceUp && m.pos === 'atk');
    if (!targets.length) return;
    const best = Math.max(...targets.map((m) => e.atkOf(m)));
    const top = targets.filter((m) => e.atkOf(m) === best);
    const picks = yield* e.select(p, 'Widespread Ruin: destroy which monster?', e.optionsFor(top), 1, 1);
    if (picks && top[picks[0]]) yield* e.destroy([top[picks[0]].uid]);
  },
};
E['Horn of Heaven'] = {
  canActivate: (e, _c, p, t, ctx) => t === 'summon' && ctx.uid !== undefined && e.controller(ctx.uid) === other(p) && e.monsters(p).length > 0,
  *activate(e, link, p, ctx) {
    const mine = e.monsters(p);
    const picks = yield* e.select(p, 'Horn of Heaven: Tribute which monster?', e.optionsFor(mine), 1, 1, true);
    if (!picks) return false;
    yield* e.sendToGrave(mine[picks[0]].uid, 'tribute');
    link.targetUid = ctx.uid;
  },
  *resolve(e, link) {
    if (link.targetUid !== undefined && e.fieldCard(link.targetUid)) {
      e.log(link.player, 'Horn of Heaven negates the Summon');
      yield* e.destroy([link.targetUid]);
    }
  },
};
E['Spellbinding Circle'] = {
  canActivate: (e, _c, p, t) => (isMain(t) || t === 'summon' || t === 'attack') && e.monsters(other(p)).some((m) => m.faceUp),
  *activate(e, link, p) {
    const targets = e.monsters(other(p)).filter((m) => m.faceUp);
    const picks = yield* e.select(p, 'Spellbinding Circle: bind which monster?', e.optionsFor(targets), 1, 1, true);
    if (!picks) return false;
    link.targetUid = targets[picks[0]].uid;
  },
  *resolve(e, link, p) {
    const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
    const fc = e.fieldCard(link.card.uid);
    if (!m || !fc) return;
    attachTo(e, fc, m.uid);
    m.cannotAttack = true;
    m.cannotChangePos = true;
    if (e.state.battle?.attacker === m.uid) e.endBattle();
    e.log(p, `${m.name} is bound by Spellbinding Circle`);
  },
  *onLeaveField(e, fc) {
    if (fc.equippedTo !== undefined) {
      const host = e.fieldCard(fc.equippedTo);
      if (host) {
        host.cannotAttack = false;
        host.cannotChangePos = false;
      }
    }
  },
};
E['Kunai with Chain'] = {
  canActivate: (e, _c, p, t, ctx) => attackingOpp(e, p, t, ctx),
  *activate(_e, link, _p, ctx) {
    link.targetUid = ctx.uid;
  },
  *resolve(e, link) {
    const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
    if (!m) return;
    m.pos = 'def';
    m.posChanged = true;
    e.endBattle();
    e.log(link.player, `Kunai with Chain drags ${m.name} into Defense Position`);
  },
};
E['Metalmorph'] = {
  ...equip(() => ({ atk: 300, def: 300 })),
  canActivate: (e, _c, _p, t) => (isMain(t) || t === 'attack' || t === 'summon') && allMonsters(e).some((m) => m.faceUp),
};
E['Enchanted Javelin'] = {
  canActivate: (e, _c, p, t, ctx) => attackingOpp(e, p, t, ctx),
  *resolve(e, _l, p) {
    const a = e.state.battle ? e.fieldCard(e.state.battle.attacker) : null;
    if (a) e.gainLp(p, e.atkOf(a));
  },
};
E['Gift of The Mystical Elf'] = {
  canActivate: (e, _c, _p, t) => (isMain(t) || t === 'attack' || t === 'summon') && allMonsters(e).length > 0,
  *resolve(e, _l, p) {
    e.gainLp(p, 300 * allMonsters(e).length);
  },
};
E['Dust Tornado'] = {
  canActivate: (e, _c, p, t) => (isMain(t) || t === 'attack' || t === 'summon') && spellsOnField(e, other(p)).length > 0,
  *activate(e, link, p) {
    const targets = spellsOnField(e, other(p));
    const picks = yield* e.select(p, 'Dust Tornado: destroy which Spell or Trap?', e.optionsFor(targets, true), 1, 1, true);
    if (!picks) return false;
    link.targetUid = targets[picks[0]].uid;
  },
  *resolve(e, link) {
    if (link.targetUid !== undefined && e.fieldCard(link.targetUid)) yield* e.destroy([link.targetUid]);
  },
};
E["Robbin' Goblin"] = {
  canActivate: (_e, _c, _p, t) => isMain(t) || t === 'attack' || t === 'summon',
  *resolve() {},
  *onBattleDamageDealt(e, _card, _attacker, p) {
    const c = randomPick(e, e.player(other(p)).hand);
    if (c) {
      e.log(p, "Robbin' Goblin makes the opponent discard");
      yield* e.discard(other(p), c.uid);
    }
  },
};
E['Backup Soldier'] = {
  canActivate: (e, _c, p, t) => (isMain(t) || t === 'attack') && e.player(p).gy.length >= 5 && e.player(p).gy.some((c) => isMonster(e, c) && e.info(c.name).sub === 'Normal' && (e.info(c.name).atk ?? 0) <= 1500),
  *resolve(e, _l, p) {
    const targets = e.player(p).gy.filter((c) => isMonster(e, c) && e.info(c.name).sub === 'Normal' && (e.info(c.name).atk ?? 0) <= 1500);
    const picks = yield* e.select(p, 'Backup Soldier: return up to 3 monsters to your hand', e.optionsFor(targets), 1, 3);
    if (picks) for (const i of picks) e.toHand(targets[i].uid);
  },
};

export const SCRIPTED = Object.keys(E);
