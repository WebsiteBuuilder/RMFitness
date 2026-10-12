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
}

const E: Record<string, EffectDef> = {};
export function getEffect(name: string): EffectDef | undefined {
  return E[name];
}
export function hasEffect(name: string): boolean {
  return !!E[name];
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

export const SCRIPTED = Object.keys(E);
