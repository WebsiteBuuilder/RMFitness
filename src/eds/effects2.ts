// Card effect scripts, part two: every remaining card in the EDS list.
// Installed into the same table as effects.ts (see installMore at its end).

import type { ChainCtx, Choice, Engine, Step } from './engine';
import { other } from './engine';
import type { EffectDef, Trigger } from './effects';
import type { Card, ChainLink, FieldCard, Pid, Pos, Prompt } from './types';

type Bonus = (e: Engine, m: FieldCard) => { atk: number; def: number } | undefined;
interface Helpers {
  equip(bonus?: EffectDef['equipBonus'], extra?: Partial<EffectDef>): EffectDef;
  equipFor(test: (e: Engine, m: FieldCard) => boolean, bonus: EffectDef['equipBonus'], extra?: Partial<EffectDef>): EffectDef;
  attachTo(e: Engine, card: FieldCard, monsterUid: number): void;
  fieldSpell(bonus: Bonus): EffectDef;
  attrField(a: string): EffectDef;
  ritualSpell(): EffectDef;
  wipe(test: (e: Engine, m: FieldCard) => boolean, label: string): EffectDef;
  fusionPlans(e: Engine, p: Pid): unknown[];
}

// ---------- small helpers ----------
const allMonsters = (e: Engine) => [...e.monsters(0), ...e.monsters(1)];
const fieldST = (e: Engine, p: Pid) => [...e.spells(p), ...(e.player(p).field ? [e.player(p).field!] : [])];
const allST = (e: Engine) => [...fieldST(e, 0), ...fieldST(e, 1)];
const hasFreeZone = (e: Engine, p: Pid) => e.player(p).mz.some((z) => z === null);
const freeST = (e: Engine, p: Pid) => e.player(p).sz.findIndex((z) => z === null);
const isMonster = (e: Engine, c: Card) => e.info(c.name).kind === 'monster';
const isMain = (t: Trigger) => t === 'main';
/** Normal Traps: usable from the Main Phase or in response to a Summon or an attack. */
const anyTime = (t: Trigger) => t === 'main' || t === 'summon' || t === 'attack';
const ctrl = (e: Engine, m: FieldCard): Pid => e.controller(m.uid) ?? m.owner;
const faceUp = (e: Engine) => allMonsters(e).filter((m) => m.faceUp);
const targetable = (e: Engine, list: FieldCard[]) => list.filter((m) => !e.untargetable(m));
const tag = (m: FieldCard) => (m.tags ??= {});
const isNormalMonsterCard = (e: Engine, c: Card) => isMonster(e, c) && e.info(c.name).sub === 'Normal';
const randomPick = <T>(e: Engine, list: T[]): T | undefined => (list.length ? list[Math.floor(e.rand() * list.length)] : undefined);
const name = (e: Engine, m: FieldCard) => (m.faceUp ? m.name : 'a face-down card');
const RACES = ['Dragon', 'Spellcaster', 'Zombie', 'Warrior', 'Beast-Warrior', 'Beast', 'Winged Beast', 'Fiend', 'Fairy', 'Insect', 'Dinosaur', 'Reptile', 'Fish', 'Sea Serpent', 'Machine', 'Thunder', 'Aqua', 'Pyro', 'Rock', 'Plant'];
const ATTRIBUTES = ['DARK', 'LIGHT', 'EARTH', 'WATER', 'FIRE', 'WIND'];
/** Cards whose effect destroys Spells/Traps (for Fake Trap, Gust, Driving Snow). */
const ST_DESTROYERS = new Set(['Mystical Space Typhoon', 'Heavy Storm', "Harpie's Feather Duster", 'Dust Tornado', 'Remove Trap', 'Nobleman of Extermination', 'Giant Trunade', 'De-Spell', 'Final Destiny', 'Breath of Light']);
const TOONS = new Set(['Blue-Eyes Toon Dragon', 'Manga Ryu-Ran', 'Toon Mermaid', 'Toon Summoned Skull']);

/** A choice from a list of words (Types, Attributes). Returns the chosen words. */
function* choose(e: Engine, p: Pid, title: string, words: string[], n = 1): Generator<Prompt, string[] | null, Choice> {
  const picks = yield* e.select(p, title, words.map((w) => ({ label: w })), n, n);
  return picks ? picks.map((i) => words[i]) : null;
}

/** Destroys/handles a chain link (Anti Raigeki, Solemn Judgment...). */
function negate(e: Engine, target: ChainLink | undefined, by: Pid) {
  if (!target) return;
  target.negated = true;
  e.log(by, `${target.card.name} is negated`);
}

/** Tribute Special Summon from the hand: pick `n` monsters (that pass `test`) to tribute, then summon. */
function* tributeSummon(e: Engine, card: Card, p: Pid, n: number, test: (m: FieldCard) => boolean = () => true, pos: Pos = 'atk'): Step {
  const pool = e.monsters(p).filter(test);
  if (n > 0) {
    const picks = yield* e.select(p, `${card.name}: Tribute ${n} monster${n > 1 ? 's' : ''}`, e.optionsFor(pool), n, n, true);
    if (!picks) return;
    for (const i of picks) yield* e.sendToGrave(pool[i].uid, 'tribute');
  }
  if (!hasFreeZone(e, p)) return;
  yield* e.specialSummon(card.uid, p, pos);
}

/** Monsters (by name) that must all be tributed (Gate Guardian, Valkyrion). */
function namedTributes(e: Engine, p: Pid, names: string[], fromHand: boolean): (Card | FieldCard)[] | null {
  const pool: Card[] = [...e.monsters(p), ...(fromHand ? e.player(p).hand : [])];
  const out: Card[] = [];
  for (const n of names) {
    const c = pool.find((x) => x.name.toLowerCase() === n.toLowerCase() && !out.includes(x));
    if (!c) return null;
    out.push(c);
  }
  return out;
}

/** The Petit Moth line: tribute Petit Moth that has worn Cocoon of Evolution for `turns` of its controller's turns. */
function mothProc(turns: number): EffectDef {
  const ready = (e: Engine, p: Pid) =>
    e.monsters(p).find((m) => m.name === 'Petit Moth' && m.equips.some((u) => {
      const c = e.fieldCard(u);
      return c?.name === 'Cocoon of Evolution' && (c.tags?.age ?? 0) >= turns;
    }));
  return {
    cannotNormalSummon: true,
    summonProc: {
      can: (e, _c, p) => !!ready(e, p),
      *run(e, card, p) {
        const moth = ready(e, p);
        if (!moth) return;
        yield* e.sendToGrave(moth.uid, 'tribute');
        yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
  };
}

/** A Toon: Special Summoned from the hand while its controller has Toon World. */
function toon(tributes: number): EffectDef {
  return {
    cannotNormalSummon: true,
    summonProc: {
      can: (e, _c, p) => !!e.anyActive('Toon World', p) && (tributes === 0 ? hasFreeZone(e, p) : e.monsters(p).length >= tributes),
      *run(e, card, p) {
        yield* tributeSummon(e, card, p, tributes);
        const m = e.fieldCard(card.uid);
        if (m) tag(m).toonTurn = e.state.turn;
      },
    },
    cannotAttack: (e, m) => m.tags?.toonTurn === e.state.turn,
    attackCost: {
      can: (e, _m, p) => e.player(p).lp > 500,
      *pay(e, _m, p) {
        e.log(p, 'Toon: 500 LP to attack');
        e.payLp(p, 500);
      },
    },
    directAttack: (e, _m, p) => !e.monsters(other(p)).some((x) => x.faceUp && TOONS.has(x.name)),
    targetFilter: (e, m, t) => {
      const p = ctrl(e, m);
      const toons = e.monsters(other(p)).filter((x) => x.faceUp && TOONS.has(x.name));
      return toons.length === 0 || toons.includes(t);
    },
  };
}

/** Kazejin, Sanga and Suijin: once, make the attacker's ATK 0 during damage calculation. */
const guardian: EffectDef = {
  *onBeingAttacked(e, t, attacker, p) {
    if (t.tags?.used || e.state.turnPlayer === p) return;
    if (!(yield* e.yesno(p, `${t.name}: make ${attacker.name}'s ATK 0 for this battle?`))) return;
    tag(t).used = 1;
    e.state.fx.zeroAttack = attacker.uid;
    e.log(p, `${t.name} drains ${attacker.name}'s attack to 0`);
  },
};

/** Kiseitai and Blast Sphere: become an Equip on the attacker instead of battling. */
function* latchOn(e: Engine, t: FieldCard, attacker: FieldCard, p: Pid): Generator<Prompt, boolean, Choice> {
  const zone = freeST(e, p);
  if (zone < 0 || !e.fieldCard(attacker.uid)) return false;
  const ps = e.player(p);
  const mi = ps.mz.indexOf(t);
  if (mi < 0) return false;
  ps.mz[mi] = null;
  t.faceUp = true;
  t.pos = 'atk';
  t.active = true;
  t.equippedTo = attacker.uid;
  t.placedTurn = e.state.turn;
  ps.sz[zone] = t;
  attacker.equips.push(t.uid);
  e.event('flip', { uid: t.uid, player: p });
  e.log(p, `${t.name} latches onto ${attacker.name}!`);
  yield* [];
  return true;
}

export function installMore(E: Record<string, EffectDef>, h: Helpers) {
  const { equip, equipFor, attachTo, attrField, ritualSpell, wipe } = h;
  const def = (names: string | string[], d: EffectDef) => {
    for (const n of Array.isArray(names) ? names : [names]) E[n] = d;
  };

  // ===== Cards with nothing extra to script (handled by the rules themselves) =====
  def(['Exodia the Forbidden One', 'Kuriboh', 'Banisher of the Light', 'Lord of D.', 'Ceremonial Bell', 'Insect Monster Token'], {});
  def(['Obelisk the Tormentor', 'Slifer the Sky Dragon', 'The Winged Dragon of Ra'], { cannotNormalSummon: true, cannotAttack: () => true });
  def(['Beastking of the Swamps', 'Goddess with the Third Eye', 'Mystical Sheep #1', 'Versago the Destroyer'], { fusionSub: true });
  def(['Wall Shadow', 'Metalzoa', 'Red-Eyes Black Metal Dragon', 'Dark Sage'], { cannotNormalSummon: true });
  def('Rainbow Flower', { directAttack: true });

  // ===== Ritual Spells not covered yet =====
  def(['Beastly Mirror Ritual', 'Revival of Dokurorider'], ritualSpell());

  // ===== Equips =====
  E['7 Completed'] = {
    ...equipFor((e, m) => e.raceOf(m) === 'Machine', (_e, eq) => (eq.tags?.def ? { atk: 0, def: 700 } : { atk: 700, def: 0 })),
  };
  {
    const base = E['7 Completed'];
    const act = base.activate!;
    E['7 Completed'] = {
      ...base,
      *activate(e, link, p, ctx) {
        const ok = yield* act(e, link, p, ctx);
        if (ok === false) return false;
        const atk = yield* e.yesno(p, '7 Completed: raise ATK by 700? (No = DEF)');
        tag(link.card as FieldCard).def = atk ? 0 : 1;
      },
    };
  }
  E['Insect Armor with Laser Cannon'] = equipFor((e, m) => e.raceOf(m) === 'Insect', () => ({ atk: 700, def: 0 }));
  E['Laser Cannon Armor'] = equipFor((e, m) => e.raceOf(m) === 'Insect', () => ({ atk: 300, def: 300 }));
  E['Power of Kaishin'] = equipFor((e, m) => e.raceOf(m) === 'Aqua', () => ({ atk: 300, def: 300 }));
  E['Sword of Deep-Seated'] = equip(() => ({ atk: 500, def: 500 }), {
    *onLeaveField(e, fc) {
      const f = e.find(fc.uid);
      if (f && f.loc.zone === 'gy') {
        e.toDeckTop(fc.uid);
        e.log(fc.owner, 'Sword of Deep-Seated returns to the top of the Deck');
      }
    },
  });
  E["Sword of Dragon's Soul"] = equipFor((e, m) => e.raceOf(m) === 'Warrior', () => ({ atk: 700, def: 0 }), {
    *hostAfterBattle(e, _eq, _host, target) {
      if (target && e.fieldCard(target.uid) && e.raceOf(target) === 'Dragon') (e.state.fx.endOfBattle ??= []).push(target.uid);
    },
  });
  E['Stim-Pack'] = equip((_e, eq) => ({ atk: 700 - 200 * (eq.tags?.decay ?? 0), def: 0 }), {
    *onStandby(e, eq, p) {
      if (e.state.turnPlayer === p && eq.equippedTo !== undefined) tag(eq).decay = (eq.tags?.decay ?? 0) + 1;
    },
  });
  E['Germ Infection'] = equipFor((e, m) => e.raceOf(m) !== 'Machine', (_e, eq) => ({ atk: -300 * (eq.tags?.decay ?? 0), def: 0 }), {
    *onStandby(e, eq) {
      const host = eq.equippedTo !== undefined ? e.fieldCard(eq.equippedTo) : null;
      if (host && e.state.turnPlayer === ctrl(e, host)) tag(eq).decay = (eq.tags?.decay ?? 0) + 1;
    },
  });
  E['Ring of Magnetism'] = {
    ...equip(() => ({ atk: -500, def: -500 })),
    canActivate: (e, _c, p, t) => isMain(t) && e.monsters(p).some((m) => m.faceUp),
    *activate(e, link, p) {
      const targets = targetable(e, e.monsters(p).filter((m) => m.faceUp));
      const picks = yield* e.select(p, 'Ring of Magnetism: equip which of your monsters?', e.optionsFor(targets), 1, 1, true);
      if (!picks) return false;
      link.targetUid = targets[picks[0]].uid;
    },
  };
  E['Magical Labyrinth'] = equipFor((_e, m) => m.name === 'Labyrinth Wall', () => ({ atk: 0, def: 0 }), {
    ignition: {
      can: (e, eq, p) => eq.equippedTo !== undefined && !!e.fieldCard(eq.equippedTo) && e.player(p).deck.some((c) => c.name === 'Wall Shadow'),
      *run(e, eq, p) {
        const host = eq.equippedTo !== undefined ? e.fieldCard(eq.equippedTo) : null;
        const ws = e.player(p).deck.find((c) => c.name === 'Wall Shadow');
        if (!host || !ws) return;
        yield* e.sendToGrave(host.uid, 'tribute');
        yield* e.specialSummon(ws.uid, p, 'atk');
        e.player(p).deck = e.shuffle(e.player(p).deck);
      },
    },
  });
  // Metalmorph: +300, half the target's ATK while attacking, and the Metalzoa / Black Metal Dragon line.
  {
    const base = E['Metalmorph'];
    const upgrades: Record<string, string> = { Zoa: 'Metalzoa', 'Red-Eyes Black Dragon': 'Red-Eyes Black Metal Dragon', 'Red-Eyes B. Dragon': 'Red-Eyes Black Metal Dragon' };
    const upgradeFor = (e: Engine, eq: FieldCard) => {
      const host = eq.equippedTo !== undefined ? e.fieldCard(eq.equippedTo) : null;
      const to = host ? upgrades[host.name] ?? upgrades[e.info(host.name).name] : undefined;
      return host && to ? { host, to } : null;
    };
    E['Metalmorph'] = {
      ...base,
      hostAttackBonus: (e, _eq, _host, target) => (target ? Math.floor(e.atkOf(target) / 2) : 0),
      ignition: {
        can: (e, eq, p) => {
          const u = upgradeFor(e, eq);
          return !!u && e.player(p).deck.some((c) => e.info(c.name).name === u.to || c.name === u.to);
        },
        *run(e, eq, p) {
          const u = upgradeFor(e, eq);
          if (!u) return;
          const ps = e.player(p);
          const card = ps.deck.find((c) => e.info(c.name).name === u.to || c.name === u.to);
          if (!card) return;
          yield* e.sendToGrave(u.host.uid, 'tribute');
          yield* e.specialSummon(card.uid, p, 'atk');
          ps.deck = e.shuffle(ps.deck);
        },
      },
    };
  }

  // ===== Field Spell =====
  E['Umiiruka'] = attrField('WATER');

  // ===== Auras and stat changers =====
  const swing = (up: string, down: string): EffectDef => ({
    aura: (e, _src, m) => {
      const a = e.info(m.name).attribute;
      return a === up ? { atk: 500, def: 0 } : a === down ? { atk: -400, def: 0 } : undefined;
    },
  });
  E['Bladefly'] = swing('WIND', 'EARTH');
  E['Milus Radiant'] = swing('EARTH', 'WIND');
  E["Witch's Apprentice"] = swing('DARK', 'LIGHT');
  E['Little Chimera'] = swing('FIRE', 'WATER');
  E['Maha Vailo'] = { selfBonus: (_e, m) => ({ atk: 500 * m.equips.length, def: 0 }) };
  E['Muka Muka'] = { selfBonus: (e, m) => ({ atk: 300 * e.player(ctrl(e, m)).hand.length, def: 300 * e.player(ctrl(e, m)).hand.length }) };
  E['Wodan the Resident of the Forest'] = { selfBonus: (e) => ({ atk: 100 * faceUp(e).filter((m) => e.raceOf(m) === 'Plant').length, def: 0 }) };
  E['Boar Soldier'] = {
    selfBonus: (e, m) => ({ atk: e.monsters(other(ctrl(e, m))).length > 0 ? -1000 : 0, def: 0 }),
    *onSummon(e, m, _p, kind) {
      if (kind === 'normal') {
        e.log(ctrl(e, m), 'Boar Soldier cannot be Normal Summoned and is destroyed');
        yield* e.destroy([m.uid]);
      }
    },
  };
  E['Hourglass of Courage'] = {
    *onSummon(e, m) {
      tag(m).hourglass = e.state.turn + 2;
    },
    baseStats: (e, m) => {
      const until = m.tags?.hourglass;
      if (until === undefined) return undefined;
      const i = e.info(m.name);
      const f = e.state.turn <= until ? 0.5 : 2;
      return { atk: Math.floor((i.atk ?? 0) * f), def: Math.floor((i.def ?? 0) * f) };
    },
  };
  E['Goddess of Whim'] = {
    ignition: {
      can: () => true,
      *run(e, m, p) {
        const heads = yield* e.yesno(p, 'Goddess of Whim: call Heads? (No = Tails)');
        const toss = e.roll(2) === 1;
        const right = heads === toss;
        tag(m).whimTurn = e.state.turn;
        tag(m).whimUp = right ? 1 : 0;
        e.log(p, `Goddess of Whim: ${toss ? 'Heads' : 'Tails'}. ${right ? 'ATK doubles!' : 'ATK is halved.'}`);
      },
    },
    baseStats: (e, m) => {
      if (m.tags?.whimTurn !== e.state.turn) return undefined;
      const i = e.info(m.name);
      return { atk: m.tags.whimUp ? (i.atk ?? 0) * 2 : Math.floor((i.atk ?? 0) / 2), def: i.def ?? 0 };
    },
  };
  E['Aqua Chorus'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    aura: (e, src, m) => (src.active && faceUp(e).filter((x) => x.name === m.name).length >= 2 ? { atk: 500, def: 500 } : undefined),
  };
  E['Castle of Dark Illusions'] = {
    *flip(_e, m) {
      tag(m).castle = 1;
      tag(m).castleTurns = 0;
    },
    *onStandby(e, m, p) {
      if (m.tags?.castle && e.state.turnPlayer === p && (m.tags.castleTurns ?? 0) < 4) m.tags.castleTurns = (m.tags.castleTurns ?? 0) + 1;
    },
    aura: (e, src, m) => {
      if (!src.tags?.castle || e.raceOf(m) !== 'Zombie') return undefined;
      const n = 200 + 200 * (src.tags.castleTurns ?? 0);
      return { atk: n, def: n };
    },
  };
  E['Pumpking the King of Ghosts'] = {
    selfBonus: (e, m) => {
      if (!faceUp(e).some((x) => x.name === 'Castle of Dark Illusions')) return { atk: 0, def: 0 };
      const n = 100 + 100 * (m.tags?.pump ?? 0);
      return { atk: n, def: n };
    },
    *onStandby(e, m, p) {
      if (e.state.turnPlayer === p && (m.tags?.pump ?? 0) < 3 && faceUp(e).some((x) => x.name === 'Castle of Dark Illusions')) tag(m).pump = (m.tags?.pump ?? 0) + 1;
    },
  };

  // ===== Special Summon procedures =====
  E['Gate Guardian'] = {
    cannotNormalSummon: true,
    summonProc: {
      can: (e, _c, p) => !!namedTributes(e, p, ['Sanga of the Thunder', 'Kazejin', 'Suijin'], false),
      *run(e, card, p) {
        const t = namedTributes(e, p, ['Sanga of the Thunder', 'Kazejin', 'Suijin'], false);
        if (!t) return;
        for (const c of t) yield* e.sendToGrave(c.uid, 'tribute');
        yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
  };
  const MAGNETS = ['Alpha The Magnet Warrior', 'Beta The Magnet Warrior', 'Gamma The Magnet Warrior'];
  E['Valkyrion the Magna Warrior'] = {
    cannotNormalSummon: true,
    summonProc: {
      can: (e, _c, p) => !!namedTributes(e, p, MAGNETS, true),
      *run(e, card, p) {
        const t = namedTributes(e, p, MAGNETS, true);
        if (!t) return;
        for (const c of t) yield* e.sendToGrave(c.uid, 'tribute');
        yield* e.specialSummon(card.uid, p, 'atk');
      },
    },
    ignition: {
      can: (e, _m, p) => MAGNETS.every((n) => e.player(p).gy.some((c) => c.name.toLowerCase() === n.toLowerCase())),
      *run(e, m, p) {
        yield* e.sendToGrave(m.uid, 'tribute');
        for (const n of MAGNETS) {
          const c = e.player(p).gy.find((x) => x.name.toLowerCase() === n.toLowerCase());
          if (c && hasFreeZone(e, p)) yield* e.specialSummon(c.uid, p, 'atk');
        }
      },
    },
  };
  E['Larvae Moth'] = mothProc(2);
  E['Great Moth'] = mothProc(4);
  E['Perfectly Ultimate Great Moth'] = mothProc(6);
  E['Cocoon of Evolution'] = {
    handIgnition: {
      can: (e, _c, p) => freeST(e, p) >= 0 && e.monsters(p).some((m) => m.faceUp && m.name === 'Petit Moth'),
      *run(e, card, p) {
        const moths = e.monsters(p).filter((m) => m.faceUp && m.name === 'Petit Moth');
        const picks = yield* e.select(p, 'Cocoon of Evolution: equip to which Petit Moth?', e.optionsFor(moths), 1, 1, true);
        const zone = freeST(e, p);
        if (!picks || zone < 0) return;
        const moth = moths[picks[0]];
        const ps = e.player(p);
        ps.hand = ps.hand.filter((c) => c.uid !== card.uid);
        const fc: FieldCard = { ...card, pos: 'atk', faceUp: true, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true, equippedTo: moth.uid, tags: { age: 0 } };
        ps.sz[zone] = fc;
        moth.equips.push(fc.uid);
        e.event('summon', { uid: fc.uid, player: p });
        e.log(p, 'Petit Moth wraps itself in the Cocoon of Evolution');
      },
    },
    *onStandby(e, c, p) {
      if (c.equippedTo !== undefined && e.state.turnPlayer === p) tag(c).age = (c.tags?.age ?? 0) + 1;
    },
  };
  E['Petit Moth'] = {
    baseStats: (e, m) => {
      const cocoon = m.equips.map((u) => e.fieldCard(u)).find((c) => c?.name === 'Cocoon of Evolution');
      if (!cocoon) return undefined;
      const i = e.info('Cocoon of Evolution');
      return { atk: i.atk ?? 0, def: i.def ?? 0 };
    },
  };
  for (const [n, t] of [['Blue-Eyes Toon Dragon', 2], ['Manga Ryu-Ran', 2], ['Toon Summoned Skull', 1], ['Toon Mermaid', 0]] as const) E[n] = toon(t);
  E['Toon World'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    activateCost: {
      can: (e, _c, p) => e.player(p).lp > 1000,
      *pay(e, _c, p) {
        e.payLp(p, 1000);
        yield* [];
      },
    },
    *resolve() {},
    *onLeaveField(e, _fc, p) {
      const toons = e.monsters(p).filter((m) => TOONS.has(m.name));
      if (toons.length) {
        e.log(p, 'Toon World is gone, and the Toons with it');
        yield* e.destroy(toons.map((m) => m.uid));
      }
    },
  };
  E['Cyber-Stein'] = {
    ignition: {
      can: (e, _m, p) => e.player(p).lp > 5000 && hasFreeZone(e, p) && e.player(p).fusion.length > 0,
      *run(e, _m, p) {
        const list = e.player(p).fusion;
        const picks = yield* e.select(p, 'Cyber-Stein: Special Summon which Fusion Monster?', e.optionsFor(list), 1, 1, true);
        if (!picks) return;
        e.payLp(p, 5000);
        yield* e.specialSummon(list[picks[0]].uid, p, 'atk');
      },
    },
  };
  E['Thunder Dragon'] = {
    handIgnition: {
      can: (e, c, p) => e.player(p).deck.some((x) => x.name === c.name),
      *run(e, card, p) {
        yield* e.discard(p, card.uid);
        const ps = e.player(p);
        const list = ps.deck.filter((x) => x.name === card.name);
        const picks = yield* e.select(p, 'Thunder Dragon: add up to 2 Thunder Dragons to your hand', e.optionsFor(list), 1, 2);
        for (const i of picks ?? []) e.toHand(list[i].uid);
        ps.deck = e.shuffle(ps.deck);
      },
    },
  };
  E['The Flute of Summoning Dragon'] = {
    canActivate: (e, _c, p, t) => isMain(t) && faceUp(e).some((m) => m.name === 'Lord of D.') && hasFreeZone(e, p) && e.player(p).hand.some((c) => isMonster(e, c) && e.info(c.name).race === 'Dragon'),
    *resolve(e, _l, p) {
      if (!faceUp(e).some((m) => m.name === 'Lord of D.')) return;
      const list = e.player(p).hand.filter((c) => isMonster(e, c) && e.info(c.name).race === 'Dragon' && e.info(c.name).sub !== 'Ritual');
      const picks = yield* e.select(p, 'Special Summon up to 2 Dragons from your hand', e.optionsFor(list), 1, 2);
      for (const i of picks ?? []) if (hasFreeZone(e, p)) yield* e.specialSummon(list[i].uid, p, 'atk');
    },
  };

  // ===== Ignition effects =====
  E['Catapult Turtle'] = {
    ignition: {
      can: (e, m, p) => e.monsters(p).some((x) => x.uid !== m.uid),
      *run(e, m, p) {
        const list = e.monsters(p).filter((x) => x.uid !== m.uid);
        const picks = yield* e.select(p, 'Catapult Turtle: launch which monster?', e.optionsFor(list), 1, 1, true);
        if (!picks) return;
        const dmg = Math.floor(e.atkOf(list[picks[0]]) / 2);
        yield* e.sendToGrave(list[picks[0]].uid, 'tribute');
        e.log(p, `Catapult Turtle hurls it for ${dmg} damage`);
        e.damage(other(p), dmg);
      },
    },
  };
  E['The Little Swordsman of Aile'] = {
    ignition: {
      can: (e, m, p) => e.monsters(p).some((x) => x.uid !== m.uid),
      *run(e, m, p) {
        const list = e.monsters(p).filter((x) => x.uid !== m.uid);
        const picks = yield* e.select(p, 'Little Swordsman of Aile: Tribute which monster?', e.optionsFor(list), 1, 1, true);
        if (!picks) return;
        yield* e.sendToGrave(list[picks[0]].uid, 'tribute');
        m.atkMod += 700;
      },
      repeat: true,
    },
  };
  E['Monster Eye'] = {
    ignition: {
      can: (e, _m, p) => e.player(p).lp > 1000 && e.player(p).gy.some((c) => c.name === 'Polymerization'),
      *run(e, _m, p) {
        const c = e.player(p).gy.find((x) => x.name === 'Polymerization');
        if (!c) return;
        e.payLp(p, 1000);
        e.toHand(c.uid);
      },
      repeat: true,
    },
  };
  E['Gale Dogra'] = {
    ignition: {
      can: (e, _m, p) => e.player(p).lp > 3000 && e.player(p).fusion.length > 0,
      *run(e, _m, p) {
        const list = e.player(p).fusion;
        const picks = yield* e.select(p, 'Gale Dogra: send which Fusion Monster to the Graveyard?', e.optionsFor(list), 1, 1, true);
        if (!picks) return;
        e.payLp(p, 3000);
        yield* e.sendToGrave(list[picks[0]].uid, 'cost');
      },
      repeat: true,
    },
  };
  E['Relinquished'] = {
    ignition: {
      can: (e, m, p) => !m.tags?.absorbed && freeST(e, p) >= 0 && targetable(e, e.monsters(other(p))).length > 0,
      *run(e, m, p) {
        const list = targetable(e, e.monsters(other(p)));
        const picks = yield* e.select(p, 'Relinquished: absorb which monster?', e.optionsFor(list, true), 1, 1, true);
        const zone = freeST(e, p);
        if (!picks || zone < 0) return;
        const t = list[picks[0]];
        const op = e.player(other(p));
        const mi = op.mz.indexOf(t);
        if (mi < 0) return;
        for (const u of t.equips.slice()) yield* e.sendToGrave(u, 'used');
        // An equip leaving can take the monster with it (Limit Reverse, Premature Burial).
        if (op.mz[mi] !== t || e.player(p).sz[zone] !== null) return;
        op.mz[mi] = null;
        t.faceUp = true;
        t.active = true;
        t.equippedTo = m.uid;
        t.equips = [];
        e.player(p).sz[zone] = t;
        m.equips.push(t.uid);
        tag(m).absorbed = t.uid;
        e.event('summon', { uid: t.uid, player: p });
        e.log(p, `Relinquished absorbs ${t.name}!`);
      },
    },
    baseStats: (e, m) => {
      const a = m.tags?.absorbed ? e.fieldCard(m.tags.absorbed) : null;
      if (!a || a.equippedTo !== m.uid) return undefined;
      const i = e.info(a.name);
      return { atk: i.atk ?? 0, def: i.def ?? 0 };
    },
    battleSubstitute: (e, m) => {
      const a = m.tags?.absorbed ? e.fieldCard(m.tags.absorbed) : null;
      if (!a || a.equippedTo !== m.uid) return undefined;
      m.tags!.absorbed = 0;
      return a.uid;
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
          // Dark Magician ages into Dark Sage.
          const dm = e.monsters(p).find((m) => m.faceUp && m.name === 'Dark Magician');
          const ps = e.player(p);
          const sage = [...ps.hand, ...ps.deck].find((c) => c.name === 'Dark Sage');
          if (dm && sage && (yield* e.yesno(p, 'Time passes for Dark Magician... Tribute it to Special Summon Dark Sage?'))) {
            yield* e.sendToGrave(dm.uid, 'tribute');
            yield* e.specialSummon(sage.uid, p, 'atk');
            const spells = ps.deck.filter((c) => e.info(c.name).kind === 'spell');
            const pk = yield* e.select(p, 'Dark Sage: add which Spell Card to your hand?', e.optionsFor(spells), 1, 1);
            if (pk && spells[pk[0]]) e.toHand(spells[pk[0]].uid);
            ps.deck = e.shuffle(ps.deck);
          }
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

  // ===== Standby / End Phase monsters =====
  E['Blast Juggler'] = {
    *onStandby(e, m, p) {
      if (e.state.turnPlayer !== p) return;
      const list = faceUp(e).filter((x) => x.uid !== m.uid && e.atkOf(x) <= 1000);
      if (list.length < 2 || !(yield* e.yesno(p, 'Blast Juggler: Tribute it to destroy 2 face-up monsters with 1000 or less ATK?'))) return;
      const picks = yield* e.select(p, 'Blast Juggler: destroy which 2 monsters?', e.optionsFor(list), 2, 2);
      if (!picks) return;
      yield* e.sendToGrave(m.uid, 'tribute');
      yield* e.destroy(picks.map((i) => list[i].uid));
    },
  };
  E['Jigen Bakudan'] = {
    *flip(_e, m) {
      tag(m).armed = 1;
    },
    *onStandby(e, m, p) {
      if (e.state.turnPlayer !== p || !m.tags?.armed) return;
      if (!(yield* e.yesno(p, 'Jigen Bakudan: detonate? (destroys all your monsters)'))) return;
      const mine = e.monsters(p).filter((x) => x.uid !== m.uid);
      const dmg = Math.floor(mine.filter((x) => x.faceUp).reduce((a, x) => a + e.atkOf(x), 0) / 2);
      yield* e.sendToGrave(m.uid, 'tribute');
      yield* e.destroy(mine.map((x) => x.uid));
      if (dmg) e.damage(other(p), dmg);
    },
  };
  E['Dark Zebra'] = {
    *onStandby(e, m, p) {
      if (e.state.turnPlayer === p && e.monsters(p).length === 1 && m.pos === 'atk') {
        m.pos = 'def';
        tag(m).lockPosTurn = e.state.turn;
        e.log(p, 'Dark Zebra is alone and cowers in Defense Position');
      }
    },
  };
  E['Mushroom Man #2'] = {
    *onStandby(e, _m, p) {
      if (e.state.turnPlayer !== p) return;
      e.log(p, 'Mushroom Man #2 drains 300 LP');
      e.payLp(p, 300);
    },
    *onEndPhase(e, m, p) {
      if (e.state.turnPlayer !== p || e.player(p).lp <= 500 || !hasFreeZone(e, other(p))) return;
      if (!(yield* e.yesno(p, 'Mushroom Man #2: pay 500 LP to hand it to your opponent?'))) return;
      e.payLp(p, 500);
      e.takeControl(m.uid, other(p));
    },
  };
  E['The Wicked Worm Beast'] = {
    *onEndPhase(e, m, p) {
      if (e.state.turnPlayer === p) {
        e.log(p, 'The Wicked Worm Beast slinks back to the hand');
        e.toHand(m.uid);
      }
    },
  };
  E['Sinister Serpent'] = {
    *onStandbyInGrave(e, card, p) {
      if (yield* e.yesno(p, 'Sinister Serpent: return it from the Graveyard to your hand?')) e.toHand(card.uid);
    },
  };
  {
    const queen = E['Insect Queen'];
    E['Insect Queen'] = {
      ...queen,
      *afterBattle(e, m, _t, _p, destroyed) {
        if (destroyed) tag(m).won = e.state.turn;
      },
      *onEndPhase(e, m, p) {
        if (m.tags?.won === e.state.turn) e.createToken('Insect Monster Token', p, 'atk');
      },
    };
  }

  // ===== Summon watchers and control changes =====
  E['Mysterious Puppeteer'] = {
    *onAnySummon(e, _w, wp, _m, _c, kind) {
      if (kind !== 'special') e.gainLp(wp, 500);
    },
  };
  E['Kotodama'] = {
    *onAnySummon(e, w, _wp, m) {
      if (m.uid !== w.uid && faceUp(e).some((x) => x.uid !== m.uid && x.name === m.name)) {
        e.log(null, `Kotodama: two ${m.name} cannot share the field`);
        yield* e.destroy([m.uid]);
      }
    },
  };
  E['Total Defense Shogun'] = {
    *onSummon(_e, m) {
      m.pos = 'def';
    },
    attackInDefense: true,
  };
  E['Ameba'] = {
    onControlChange(e, m, _from, to) {
      if (m.tags?.used) return;
      tag(m).used = 1;
      e.log(null, 'Ameba bursts for 2000 damage');
      e.damage(to, 2000);
    },
  };
  E['Griggle'] = {
    onControlChange(e, m, from) {
      if (m.tags?.used) return;
      tag(m).used = 1;
      e.gainLp(from, 3000);
    },
  };

  // ===== Battle monsters =====
  E['Kazejin'] = guardian;
  E['Sanga of the Thunder'] = guardian;
  E['Suijin'] = guardian;
  E['Dark Artist'] = { defenseMult: (e, _t, a) => (e.info(a.name).attribute === 'LIGHT' ? 0.5 : 1) };
  E['Insect Soldiers of the Sky'] = { attackBonus: (e, _a, t) => (t && e.info(t.name).attribute === 'WIND' ? 1000 : 0) };
  E['Panther Warrior'] = {
    attackCost: {
      can: (e, m, p) => e.monsters(p).some((x) => x.uid !== m.uid),
      *pay(e, m, p) {
        const list = e.monsters(p).filter((x) => x.uid !== m.uid);
        const picks = yield* e.select(p, 'Panther Warrior: Tribute which monster to attack?', e.optionsFor(list), 1, 1);
        if (picks && list[picks[0]]) yield* e.sendToGrave(list[picks[0]].uid, 'tribute');
      },
    },
  };
  E['Electric Lizard'] = {
    *onAttacked(e, _t, a) {
      if (e.fieldCard(a.uid) && e.raceOf(a) !== 'Zombie') tag(a).noAttackTurn = e.state.turn + 2;
    },
  };
  E['Steel Scorpion'] = {
    *onAttacked(e, _t, a) {
      if (e.fieldCard(a.uid) && e.raceOf(a) !== 'Machine') a.doomAt = e.state.turn + 4;
    },
  };
  E['Zone Eater'] = {
    *afterBattle(e, _m, t) {
      if (e.fieldCard(t.uid)) t.doomAt = e.state.turn + 5;
    },
  };
  E['Swordsman from a Distant Land'] = {
    *afterBattle(e, _m, t) {
      if (e.fieldCard(t.uid)) t.doomAt = e.state.turn + 4;
    },
  };
  E['Karakuri Spider'] = {
    *afterBattle(e, _m, t) {
      if (e.fieldCard(t.uid) && e.info(t.name).attribute === 'DARK') yield* e.destroy([t.uid]);
    },
  };
  E['Masked Sorcerer'] = {
    *onBattleDamage(e, _m, p) {
      e.draw(p, 1);
    },
  };
  E['The Unhappy Maiden'] = {
    *onDestroyedByBattle(e) {
      e.log(null, 'The Unhappy Maiden ends the Battle Phase');
      for (const m of e.monsters(e.state.turnPlayer)) m.attacked = true;
    },
  };
  E['Kiseitai'] = {
    interceptAttack: latchOn,
    *onStandby(e, k, p) {
      const host = k.equippedTo !== undefined ? e.fieldCard(k.equippedTo) : null;
      if (host && e.state.turnPlayer === other(p)) e.gainLp(p, Math.floor(e.atkOf(host) / 2));
    },
  };
  E['Blast Sphere'] = {
    interceptAttack: latchOn,
    *onStandby(e, b, p) {
      const host = b.equippedTo !== undefined ? e.fieldCard(b.equippedTo) : null;
      if (!host || e.state.turnPlayer !== other(p)) return;
      const dmg = e.atkOf(host);
      const hp = ctrl(e, host);
      e.log(p, `Blast Sphere explodes with ${host.name}!`);
      yield* e.destroy([host.uid]);
      e.damage(hp, dmg);
    },
  };

  // ===== Flip monsters =====
  E['Dark-Eyes Illusionist'] = {
    *flip(e, m, p) {
      const list = targetable(e, allMonsters(e).filter((x) => x.uid !== m.uid));
      const picks = yield* e.select(p, 'Dark-Eyes Illusionist: which monster cannot attack?', e.optionsFor(list, true), 1, 1);
      if (picks && list[picks[0]]) tag(list[picks[0]]).illusionBy = m.uid;
    },
  };
  E['Dragon Piper'] = {
    *flip(e) {
      const jars = allST(e).filter((c) => c.faceUp && c.name === 'Dragon Capture Jar');
      if (!jars.length) return;
      yield* e.destroy(jars.map((c) => c.uid));
      for (const m of faceUp(e)) if (e.raceOf(m) === 'Dragon') m.pos = 'atk';
    },
  };
  E['Needle Ball'] = {
    *flip(e, _m, p) {
      if (e.player(p).lp <= 2000 || !(yield* e.yesno(p, 'Needle Ball: pay 2000 LP to inflict 1000 damage?'))) return;
      e.payLp(p, 2000);
      e.damage(other(p), 1000);
    },
  };
  E['The Immortal of Thunder'] = {
    *flip(e, _m, p) {
      e.gainLp(p, 3000);
    },
    *onToGraveFromField(e, _c, p) {
      e.log(p, 'The Immortal of Thunder falls: 5000 LP lost');
      e.payLp(p, 5000);
    },
  };
  E['The Stern Mystic'] = {
    *flip(e, _m, p) {
      const hidden = [...allMonsters(e), ...allST(e)].filter((c) => !c.faceUp);
      yield* e.reveal(p, 'The Stern Mystic reveals the face-down cards', hidden);
    },
  };
  E['Weather Report'] = {
    *flip(e, _m, p) {
      const swords = fieldST(e, other(p)).filter((c) => c.faceUp && c.name === 'Swords of Revealing Light');
      if (swords.length) yield* e.destroy(swords.map((c) => c.uid));
    },
  };
  E['Morphing Jar #2'] = {
    *flip(e, m) {
      const counts: [number, number] = [0, 0];
      for (const x of allMonsters(e)) {
        if (x.uid === m.uid) continue;
        const o = x.owner;
        counts[o]++;
        for (const u of x.equips.slice()) yield* e.sendToGrave(u, 'used');
        e.toDeckTop(x.uid);
      }
      counts[m.owner]++;
      e.toDeckTop(m.uid);
      for (const p of [0, 1] as Pid[]) {
        const ps = e.player(p);
        ps.deck = e.shuffle(ps.deck);
        let found = 0;
        while (found < counts[p] && ps.deck.length) {
          const c = ps.deck[0];
          const i = e.info(c.name);
          if (i.kind === 'monster') {
            found++;
            if ((i.level ?? 1) <= 4 && i.sub !== 'Fusion' && i.sub !== 'Ritual' && hasFreeZone(e, p)) {
              yield* e.specialSummon(c.uid, p, 'def', false);
              continue;
            }
          }
          yield* e.sendToGrave(c.uid, 'mill');
        }
      }
    },
  };
  E['Parasite Paracide'] = {
    *flip(e, m, p) {
      const opp = other(p);
      const ps = e.player(ctrl(e, m));
      const i = ps.mz.indexOf(m);
      if (i < 0) return;
      ps.mz[i] = null;
      const card: Card = { uid: m.uid, name: m.name, owner: m.owner };
      e.player(opp).deck.push(card);
      e.player(opp).deck = e.shuffle(e.player(opp).deck);
      (e.state.fx.paracide ??= []).push(m.uid);
      e.log(p, `Parasite Paracide burrows into ${e.player(opp).name}'s Deck`);
    },
  };
  E['Patrol Robo'] = {
    *onStandby(e, _m, p) {
      if (e.state.turnPlayer !== p) return;
      const list = fieldST(e, other(p)).filter((c) => !c.faceUp);
      if (!list.length) return;
      const picks = yield* e.select(p, 'Patrol Robo: look at which Set card?', e.optionsFor(list, true), 1, 1);
      if (picks && list[picks[0]]) yield* e.reveal(p, 'Patrol Robo sees', [list[picks[0]]]);
    },
  };

  // ===== Hand / Graveyard / Deck reactions =====
  E['Electric Snake'] = {
    *onDiscarded(e, _c, p, byOpp) {
      if (byOpp) e.draw(p, 2);
    },
  };
  E['Minar'] = {
    *onDiscarded(e, _c, p, byOpp) {
      if (byOpp) e.damage(other(p), 1000);
    },
  };
  E['Penguin Knight'] = {
    *onMilledByOpponent(e, _c, p) {
      const ps = e.player(p);
      e.log(p, 'Penguin Knight shuffles the Graveyard back into the Deck');
      ps.deck = e.shuffle([...ps.deck, ...ps.gy]);
      ps.gy = [];
    },
  };
  E['Tainted Wisdom'] = {
    *onPositionChange(e, m, p) {
      if (m.pos === 'def') e.player(p).deck = e.shuffle(e.player(p).deck);
    },
  };
  E['Yado Karu'] = {
    *onPositionChange(e, m, p) {
      if (m.pos !== 'def') return;
      const ps = e.player(p);
      const picks = yield* e.select(p, 'Yado Karu: put any cards from your hand on the bottom of your Deck', e.optionsFor(ps.hand), 0, ps.hand.length);
      const chosen = (picks ?? []).map((i) => ps.hand[i]);
      ps.hand = ps.hand.filter((c) => !chosen.includes(c));
      ps.deck.push(...chosen);
    },
  };

  // ===== Normal Spells =====
  const spell = (canActivate: EffectDef['canActivate'], resolve: EffectDef['resolve']): EffectDef => ({ canActivate, resolve });
  E['Ancient Telescope'] = spell(
    (e, _c, p, t) => isMain(t) && e.player(other(p)).deck.length > 0,
    function* (e, _l, p) {
      yield* e.reveal(p, 'Ancient Telescope: the top of their Deck', e.player(other(p)).deck.slice(0, 5));
    },
  );
  E['Darkness Approaches'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.player(p).hand.filter((x) => x.uid !== c.uid).length >= 2 && faceUp(e).length > 0,
    *activate(e, link, p) {
      const hand = e.player(p).hand.filter((x) => x.uid !== link.card.uid);
      const d = yield* e.select(p, 'Darkness Approaches: discard 2 cards', e.optionsFor(hand), 2, 2, true);
      if (!d) return false;
      for (const i of d) yield* e.discard(p, hand[i].uid);
      const list = targetable(e, faceUp(e));
      const t = yield* e.select(p, 'Darkness Approaches: turn which monster face-down?', e.optionsFor(list), 1, 1);
      if (!t) return false;
      link.targetUid = list[t[0]].uid;
    },
    *resolve(e, link) {
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!m) return;
      m.faceUp = false;
      m.pos = 'def';
      e.log(link.player, `${m.name} is turned face-down`);
    },
  };
  E['Final Destiny'] = {
    canActivate: (e, c, p, t) => isMain(t) && e.player(p).hand.filter((x) => x.uid !== c.uid).length >= 5,
    *activate(e, link, p) {
      const hand = e.player(p).hand.filter((x) => x.uid !== link.card.uid);
      const d = yield* e.select(p, 'Final Destiny: discard 5 cards', e.optionsFor(hand), 5, 5, true);
      if (!d) return false;
      for (const i of d) yield* e.discard(p, hand[i].uid);
    },
    *resolve(e, link) {
      yield* e.destroy([...allMonsters(e), ...allST(e)].filter((c) => c.uid !== link.card.uid).map((c) => c.uid));
    },
  };
  E['Remove Trap'] = spell(
    (e, _c, _p, t) => isMain(t) && allST(e).some((c) => c.faceUp && e.info(c.name).kind === 'trap'),
    function* (e, _l, p) {
      const list = allST(e).filter((c) => c.faceUp && e.info(c.name).kind === 'trap');
      const picks = yield* e.select(p, 'Remove Trap: destroy which Trap?', e.optionsFor(list), 1, 1);
      if (picks && list[picks[0]]) yield* e.destroy([list[picks[0]].uid]);
    },
  );
  E['Restructer Revolution'] = spell(
    (e, _c, p, t) => isMain(t) && e.player(other(p)).hand.length > 0,
    function* (e, _l, p) {
      e.damage(other(p), 200 * e.player(other(p)).hand.length);
    },
  );
  E['Shield & Sword'] = spell(
    (e, _c, _p, t) => isMain(t) && faceUp(e).length > 0,
    function* (e, l) {
      e.state.fx.swapTurn = e.state.turn;
      e.log(l.player, 'Shield & Sword swaps every monster\'s ATK and DEF');
    },
  );
  E['Soul Release'] = spell(
    (e, _c, _p, t) => isMain(t) && e.player(0).gy.length + e.player(1).gy.length > 0,
    function* (e, _l, p) {
      const list = [...e.player(0).gy, ...e.player(1).gy];
      const picks = yield* e.select(p, 'Soul Release: remove up to 5 cards in Graveyards from play', e.optionsFor(list), 1, 5);
      for (const i of picks ?? []) e.banish(list[i].uid);
    },
  );
  E['The Cheerful Coffin'] = spell(
    (e, c, p, t) => isMain(t) && e.player(p).hand.some((x) => x.uid !== c.uid && isMonster(e, x)),
    function* (e, l, p) {
      const list = e.player(p).hand.filter((x) => x.uid !== l.card.uid && isMonster(e, x));
      const picks = yield* e.select(p, 'The Cheerful Coffin: discard up to 3 monsters', e.optionsFor(list), 1, 3);
      for (const i of picks ?? []) yield* e.discard(p, list[i].uid);
    },
  );
  E['The Forceful Sentry'] = spell(
    (e, _c, p, t) => isMain(t) && e.player(other(p)).hand.length > 0,
    function* (e, _l, p) {
      const opp = e.player(other(p));
      const picks = yield* e.select(p, "The Forceful Sentry: return which card to your opponent's Deck?", e.optionsFor(opp.hand), 1, 1);
      if (!picks || !opp.hand[picks[0]]) return;
      const c = opp.hand[picks[0]];
      opp.hand = opp.hand.filter((x) => x !== c);
      opp.deck = e.shuffle([...opp.deck, c]);
      e.log(p, `${c.name} goes back into ${opp.name}'s Deck`);
    },
  );
  E['The Inexperienced Spy'] = spell(
    (e, _c, p, t) => isMain(t) && e.player(other(p)).hand.length > 0,
    function* (e, _l, p) {
      const hand = e.player(other(p)).hand;
      const picks = yield* e.select(p, 'The Inexperienced Spy: peek at which card?', hand.map((_c, i) => ({ label: `Card ${i + 1}` })), 1, 1);
      if (picks && hand[picks[0]]) yield* e.reveal(p, 'The Inexperienced Spy sees', [hand[picks[0]]]);
    },
  );
  E['Exchange'] = spell(
    (e, c, p, t) => isMain(t) && e.player(other(p)).hand.length > 0 && e.player(p).hand.some((x) => x.uid !== c.uid),
    function* (e, _l, p) {
      const opp = other(p);
      const theirs = e.player(opp).hand.slice();
      const mine = e.player(p).hand.slice();
      const a = yield* e.select(p, "Exchange: take which card from your opponent's hand?", e.optionsFor(theirs), 1, 1);
      const b = yield* e.select(opp, `Exchange: take which card from ${e.player(p).name}'s hand?`, e.optionsFor(mine), 1, 1);
      if (a && theirs[a[0]]) e.toHandOf(theirs[a[0]].uid, p);
      if (b && mine[b[0]]) e.toHandOf(mine[b[0]].uid, opp);
    },
  );
  E['Seal of the Ancients'] = spell(
    (e, _c, p, t) => isMain(t) && e.player(p).lp > 1000,
    function* (e, _l, p) {
      e.payLp(p, 1000);
      const hidden = [...e.monsters(other(p)), ...fieldST(e, other(p))].filter((c) => !c.faceUp);
      yield* e.reveal(p, "Seal of the Ancients: your opponent's face-down cards", hidden);
    },
  );
  E['Mesmeric Control'] = spell(
    (_e, _c, _p, t) => isMain(t),
    function* (e, _l, p) {
      e.state.fx.mesmeric = other(p) + 10 * (e.state.turn + 1);
    },
  );
  E['Curse of Fiend'] = spell(
    (e, _c, _p, t) => isMain(t) && faceUp(e).length > 0,
    function* (e) {
      for (const m of faceUp(e)) {
        m.pos = m.pos === 'atk' ? 'def' : 'atk';
        tag(m).lockPosTurn = e.state.turn;
      }
    },
  );
  E['Last Will'] = spell(
    (e, _c, p, t) => isMain(t) && (e.state.fx.lostMonster?.[p] ?? -1) === e.state.turn && hasFreeZone(e, p) && !e.state.fx.lastWillUsed?.[`${p}:${e.state.turn}`],
    function* (e, _l, p) {
      const ps = e.player(p);
      const list = ps.deck.filter((c) => isMonster(e, c) && (e.info(c.name).atk ?? 0) <= 1500 && e.info(c.name).sub !== 'Fusion' && e.info(c.name).sub !== 'Ritual');
      const picks = yield* e.select(p, 'Last Will: Special Summon which monster from your Deck?', e.optionsFor(list), 1, 1);
      if (picks && list[picks[0]]) yield* e.specialSummon(list[picks[0]].uid, p, 'atk');
      ps.deck = e.shuffle(ps.deck);
      (e.state.fx.lastWillUsed ??= {})[`${p}:${e.state.turn}`] = true;
    },
  );
  E['Nobleman of Crossout'] = spell(
    (e, _c, _p, t) => isMain(t) && allMonsters(e).some((m) => !m.faceUp),
    function* (e, _l, p) {
      const list = allMonsters(e).filter((m) => !m.faceUp);
      const picks = yield* e.select(p, 'Nobleman of Crossout: destroy which face-down monster?', e.optionsFor(list, true), 1, 1);
      if (!picks || !list[picks[0]]) return;
      const t = list[picks[0]];
      const isFlip = /FLIP/i.test(e.info(t.name).desc);
      e.log(p, `Nobleman of Crossout removes ${t.name} from play`);
      e.banish(t.uid);
      if (isFlip) for (const q of [0, 1] as Pid[]) for (const c of e.player(q).deck.filter((x) => x.name === t.name)) e.banish(c.uid);
    },
  );
  E['Nobleman of Extermination'] = spell(
    (e, c, _p, t) => isMain(t) && allST(e).some((x) => !x.faceUp && x.uid !== c.uid),
    function* (e, l, p) {
      const list = allST(e).filter((x) => !x.faceUp && x.uid !== l.card.uid);
      const picks = yield* e.select(p, 'Nobleman of Extermination: remove which Set card?', e.optionsFor(list, true), 1, 1);
      if (!picks || !list[picks[0]]) return;
      const t = list[picks[0]];
      const trap = e.info(t.name).kind === 'trap';
      e.log(p, `Nobleman of Extermination removes ${t.name} from play`);
      e.banish(t.uid);
      if (trap) for (const q of [0, 1] as Pid[]) for (const c of e.player(q).deck.filter((x) => x.name === t.name)) e.banish(c.uid);
    },
  );
  E['Eternal Drought'] = wipe((e, m) => m.faceUp && e.raceOf(m) === 'Fish', 'Fish');
  E['Exile of the Wicked'] = wipe((e, m) => e.raceOf(m) === 'Fiend', 'Fiends');
  E['Last Day of Witch'] = wipe((e, m) => m.faceUp && e.raceOf(m) === 'Spellcaster', 'Spellcasters');

  // ===== Quick-Play Spells =====
  E['Tailor of the Fickle'] = {
    canActivate: (e, _c, _p, t) => (isMain(t) || t === 'attack') && allST(e).some((c) => c.faceUp && c.equippedTo !== undefined && e.info(c.name).sub === 'Equip') && faceUp(e).length > 1,
    *resolve(e, _l, p) {
      const eqs = allST(e).filter((c) => c.faceUp && c.equippedTo !== undefined && e.info(c.name).sub === 'Equip');
      const a = yield* e.select(p, 'Tailor of the Fickle: move which Equip Card?', e.optionsFor(eqs), 1, 1);
      if (!a || !eqs[a[0]]) return;
      const eq = eqs[a[0]];
      const hosts = targetable(e, faceUp(e).filter((m) => m.uid !== eq.equippedTo));
      const b = yield* e.select(p, `Tailor of the Fickle: move ${eq.name} to which monster?`, e.optionsFor(hosts), 1, 1);
      if (!b || !hosts[b[0]]) return;
      const old = e.fieldCard(eq.equippedTo!);
      if (old) old.equips = old.equips.filter((u) => u !== eq.uid);
      eq.equippedTo = hosts[b[0]].uid;
      hosts[b[0]].equips.push(eq.uid);
    },
  };
  E["Sebek's Blessing"] = {
    canActivate: (_e, _c, p, t, ctx) => t === 'damage' && !!ctx.direct && ctx.damaged === other(p),
    *activate(_e, link, _p, ctx) {
      link.payload = ctx.amount ?? 0;
    },
    *resolve(e, link, p) {
      e.gainLp(p, (link.payload as number) ?? 0);
    },
  };

  // ===== Continuous Spells =====
  const cont = (extra: Partial<EffectDef>): EffectDef => ({ canActivate: (_e, _c, _p, t) => isMain(t), *resolve() {}, ...extra });
  E['Chain Energy'] = cont({});
  E['Toll'] = cont({
    attackTax: {
      can: (e, _c, _m, p) => e.player(p).lp > 500,
      *pay(e, _c, _m, p) {
        e.log(p, 'Toll: 500 LP to attack');
        e.payLp(p, 500);
      },
    },
  });
  E["Gravekeeper's Servant"] = cont({
    attackTax: {
      can: (e, c, _m, p) => p !== ctrl(e, c) ? e.player(p).deck.length > 0 : true,
      *pay(e, c, _m, p) {
        if (p === ctrl(e, c)) return;
        const top = e.player(p).deck[0];
        if (top) yield* e.sendToGrave(top.uid, 'mill');
      },
    },
  });
  E['Inspection'] = cont({
    *onStandby(e, _c, p) {
      const opp = e.player(other(p));
      if (e.state.turnPlayer !== other(p) || !opp.hand.length || e.player(p).lp <= 500) return;
      if (!(yield* e.yesno(p, 'Inspection: pay 500 LP to look at a random card in their hand?'))) return;
      e.payLp(p, 500);
      const c = randomPick(e, opp.hand);
      if (c) yield* e.reveal(p, 'Inspection sees', [c]);
    },
  });
  E['Prohibition'] = {
    canActivate: (_e, _c, _p, t) => isMain(t),
    *activate(e, link, p) {
      const names = [...new Set([0, 1].flatMap((q) => [...e.player(q as Pid).deck, ...e.player(q as Pid).hand, ...e.player(q as Pid).gy]).map((c) => c.name))].sort();
      const pick = yield* choose(e, p, 'Prohibition: declare a card name', names);
      if (!pick) return false;
      link.payload = pick[0];
    },
    *resolve(e, link) {
      (e.state.fx.prohibit ??= []).push({ name: link.payload as string, src: link.card.uid });
      e.log(link.player, `Prohibition: ${link.payload} can no longer be used`);
    },
  };

  // ===== Counter / negation Traps =====
  const answers = (target: string, extra?: (e: Engine, p: Pid) => Step): EffectDef => ({
    canActivate: (e, _c, p, t, ctx) => t === 'spell' && !!ctx.link && ctx.link.player !== p && (ctx.link.card.name === target || e.info(ctx.link.card.name).name === target),
    *activate(_e, link, _p, ctx) {
      link.payload = ctx.link;
    },
    *resolve(e, link, p) {
      negate(e, link.payload as ChainLink, p);
      if (extra) yield* extra(e, p);
    },
  });
  E['Anti Raigeki'] = answers('Raigeki', function* (e, p) {
    yield* e.destroy(e.monsters(other(p)).map((m) => m.uid));
  });
  E['Call of the Grave'] = answers('Monster Reborn');
  E['Gryphon Wing'] = answers("Harpie's Feather Duster", function* (e, p) {
    yield* e.destroy(fieldST(e, other(p)).map((c) => c.uid));
  });
  E['White Hole'] = {
    ...answers('Dark Hole'),
    *resolve(e, _l, p) {
      e.state.fx.whiteHole = { player: p, turn: e.state.turn };
      e.log(p, "White Hole shields this player's monsters from Dark Hole");
    },
  };
  {
    const dh = E['Dark Hole'];
    E['Dark Hole'] = {
      ...dh,
      *resolve(e, link) {
        const wh = e.state.fx.whiteHole as { player: Pid; turn: number } | undefined;
        const safe = wh && wh.turn === e.state.turn ? wh.player : null;
        e.log(link.player, 'Dark Hole destroys every monster on the field');
        yield* e.destroy(allMonsters(e).filter((m) => safe === null || ctrl(e, m) !== safe).map((m) => m.uid));
        e.state.fx.whiteHole = undefined;
      },
    };
  }
  const subNegate = (kind: 'spell' | 'trap', sub: string): EffectDef => ({
    canActivate: (e, _c, p, t, ctx) => t === kind && !!ctx.link && ctx.link.player !== p && e.info(ctx.link.card.name).sub === sub,
    *activate(_e, link, _p, ctx) {
      link.payload = ctx.link;
    },
    *resolve(e, link, p) {
      negate(e, link.payload as ChainLink, p);
    },
  });
  E['Mystic Probe'] = subNegate('spell', 'Continuous');
  E['World Suppression'] = subNegate('spell', 'Field');
  E['Metal Detector'] = subNegate('trap', 'Continuous');
  E['Armored Glass'] = {
    canActivate: (e, _c, p, t, ctx) => (t === 'spell' && !!ctx.link && ctx.link.player !== p && e.info(ctx.link.card.name).sub === 'Equip') || (anyTime(t) && allMonsters(e).some((m) => m.equips.length > 0)),
    *resolve(e, link) {
      e.state.fx.equipsOff = e.state.turn;
      e.log(link.player, 'Armored Glass: Equip Cards have no effect this turn');
    },
  };
  E['Solemn Judgment'] = {
    canActivate: (e, _c, p, t, ctx) => {
      if (t === 'summon') return ctx.uid !== undefined && e.controller(ctx.uid) === other(p);
      return (t === 'spell' || t === 'trap') && !!ctx.link && ctx.link.player !== p;
    },
    *activate(e, link, p, ctx) {
      e.payLp(p, Math.floor(e.player(p).lp / 2));
      link.payload = ctx.link;
      link.targetUid = ctx.link ? undefined : ctx.uid;
    },
    *resolve(e, link, p) {
      if (link.payload) {
        const l = link.payload as ChainLink;
        negate(e, l, p);
        if (e.fieldCard(l.card.uid)) yield* e.destroy([l.card.uid]);
      } else if (link.targetUid !== undefined && e.fieldCard(link.targetUid)) {
        e.log(p, 'Solemn Judgment negates the Summon');
        yield* e.destroy([link.targetUid]);
      }
    },
  };
  E['Fake Trap'] = {
    canActivate: (e, c, p, t, ctx) => (t === 'spell' || t === 'trap') && !!ctx.link && ctx.link.player !== p && ST_DESTROYERS.has(e.info(ctx.link.card.name).name) && e.spells(p).some((x) => x.uid !== c.uid && e.info(x.name).kind === 'trap'),
    *activate(_e, link, _p, ctx) {
      link.payload = ctx.link;
    },
    *resolve(e, link, p) {
      e.log(p, 'Fake Trap takes the hit instead');
      negate(e, link.payload as ChainLink, p);
    },
  };
  const blowback = (needKind: 'spell' | 'trap'): EffectDef => ({
    canActivate: (e, c, p, t, ctx) => (t === 'spell' || t === 'trap') && !!ctx.link && ctx.link.player !== p && ST_DESTROYERS.has(e.info(ctx.link.card.name).name) && fieldST(e, p).some((x) => x.uid !== c.uid && e.info(x.name).kind === needKind),
    *resolve(e, link, p) {
      const list = allST(e).filter((x) => x.uid !== link.card.uid);
      const picks = yield* e.select(p, `${link.card.name}: destroy which Spell or Trap?`, e.optionsFor(list, true), 1, 1);
      if (picks && list[picks[0]]) yield* e.destroy([list[picks[0]].uid]);
    },
  });
  E['Gust'] = blowback('spell');
  E['Driving Snow'] = blowback('trap');
  E["Fairy's Hand Mirror"] = {
    canActivate: (e, _c, p, t, ctx) => t === 'spell' && !!ctx.link && ctx.link.player !== p && ctx.link.targetUid !== undefined && !!e.fieldCard(ctx.link.targetUid) && allMonsters(e).length > 1,
    *activate(_e, link, _p, ctx) {
      link.payload = ctx.link;
    },
    *resolve(e, link, p) {
      const l = link.payload as ChainLink;
      const list = targetable(e, allMonsters(e).filter((m) => m.uid !== l.targetUid));
      const picks = yield* e.select(p, `Fairy's Hand Mirror: ${l.card.name} now targets which monster?`, e.optionsFor(list, true), 1, 1);
      if (picks && list[picks[0]]) l.targetUid = list[picks[0]].uid;
    },
  };

  // ===== Normal Traps =====
  const trap = (canActivate: EffectDef['canActivate'], resolve: EffectDef['resolve'], activate?: EffectDef['activate']): EffectDef => ({ canActivate, resolve, activate });
  E['Acid Trap Hole'] = trap(
    (e, _c, _p, t) => anyTime(t) && allMonsters(e).some((m) => !m.faceUp && m.pos === 'def'),
    function* (e, _l, p) {
      const list = allMonsters(e).filter((m) => !m.faceUp && m.pos === 'def');
      const picks = yield* e.select(p, 'Acid Trap Hole: which face-down monster?', e.optionsFor(list, true), 1, 1);
      if (!picks || !list[picks[0]]) return;
      const m = list[picks[0]];
      m.faceUp = true;
      e.log(p, `Acid Trap Hole reveals ${m.name}`);
      if (e.defOf(m) <= 2000) yield* e.destroy([m.uid]);
      else m.faceUp = false;
    },
  );
  E['Ceasefire'] = trap(
    (e, _c, _p, t) => anyTime(t) && allMonsters(e).some((m) => (!m.faceUp && m.pos === 'def') || (m.faceUp && e.info(m.name).sub === 'Effect')),
    function* (e, _l, p) {
      for (const m of allMonsters(e)) if (!m.faceUp && m.pos === 'def') m.faceUp = true;
      const n = allMonsters(e).filter((m) => e.info(m.name).sub === 'Effect').length;
      e.log(p, `Ceasefire: ${n} Effect Monster${n === 1 ? '' : 's'} on the field`);
      e.damage(other(p), 500 * n);
    },
  );
  E['Chain Destruction'] = trap(
    (e, _c, _p, t, ctx) => t === 'summon' && ctx.uid !== undefined && !!e.fieldCard(ctx.uid) && e.atkOf(e.fieldCard(ctx.uid)!) <= 2000,
    function* (e, link) {
      const m = link.targetUid !== undefined ? e.find(link.targetUid) : null;
      if (!m) return;
      const owner = m.loc.player;
      const ps = e.player(owner);
      const copies = [...ps.hand, ...ps.deck].filter((c) => c.name === m.card.name);
      e.log(link.player, `Chain Destruction destroys ${copies.length} more ${m.card.name}`);
      for (const c of copies) yield* e.sendToGrave(c.uid, 'destroyed');
    },
    function* (_e, link, _p, ctx) {
      link.targetUid = ctx.uid;
    },
  );
  E['Crush Card Virus'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && e.monsters(p).some((m) => m.faceUp && e.info(m.name).attribute === 'DARK' && e.atkOf(m) <= 1000),
    *activate(e, link, p) {
      const list = e.monsters(p).filter((m) => m.faceUp && e.info(m.name).attribute === 'DARK' && e.atkOf(m) <= 1000);
      const picks = yield* e.select(p, 'Crush Card Virus: Tribute which DARK monster?', e.optionsFor(list), 1, 1, true);
      if (!picks) return false;
      yield* e.sendToGrave(list[picks[0]].uid, 'tribute');
      void link;
    },
    *resolve(e, _l, p) {
      const opp = e.player(other(p));
      yield* e.reveal(p, "Crush Card Virus: your opponent's hand", opp.hand);
      const field = e.monsters(other(p)).filter((m) => e.atkOf(m) >= 1500);
      const hand = opp.hand.filter((c) => isMonster(e, c) && (e.info(c.name).atk ?? 0) >= 1500);
      e.log(p, `Crush Card Virus destroys ${field.length + hand.length} monsters`);
      yield* e.destroy(field.map((m) => m.uid));
      for (const c of hand) yield* e.sendToGrave(c.uid, 'destroyed');
    },
  };
  E['Earthshaker'] = trap(
    (e, _c, _p, t) => anyTime(t) && faceUp(e).length > 0,
    function* (e, _l, p) {
      const two = yield* choose(e, p, 'Earthshaker: pick 2 Attributes', ATTRIBUTES, 2);
      if (!two) return;
      const one = yield* choose(e, other(p), 'Earthshaker: which Attribute is destroyed?', two);
      if (!one) return;
      e.log(p, `Earthshaker destroys every face-up ${one[0]} monster`);
      yield* e.destroy(faceUp(e).filter((m) => e.info(m.name).attribute === one[0]).map((m) => m.uid));
    },
  );
  const smallSummon = (stat: 'atk' | 'def'): EffectDef =>
    trap(
      (e, _c, p, t, ctx) => {
        if (t !== 'summon' || ctx.uid === undefined || ctx.summonKind === 'special' || e.controller(ctx.uid) !== other(p)) return false;
        const m = e.fieldCard(ctx.uid);
        return !!m && (stat === 'atk' ? e.atkOf(m) : e.defOf(m)) <= 500;
      },
      function* (e, link) {
        if (link.targetUid !== undefined && e.fieldCard(link.targetUid)) yield* e.destroy([link.targetUid]);
      },
      function* (_e, link, _p, ctx) {
        link.targetUid = ctx.uid;
      },
    );
  E['Eatgaboon'] = smallSummon('atk');
  E['House of Adhesive Tape'] = smallSummon('def');
  E['Graverobber'] = trap(
    (e, _c, p, t) => isMain(t) && e.player(other(p)).gy.some((c) => e.info(c.name).kind === 'spell'),
    function* (e, _l, p) {
      const list = e.player(other(p)).gy.filter((c) => e.info(c.name).kind === 'spell');
      const picks = yield* e.select(p, "Graverobber: take which Spell from your opponent's Graveyard?", e.optionsFor(list), 1, 1);
      if (!picks || !list[picks[0]]) return;
      e.toHandOf(list[picks[0]].uid, p);
      (e.state.fx.borrowed ??= []).push(list[picks[0]].uid);
      e.log(p, `Graverobber steals ${list[picks[0]].name} until the end of the turn`);
    },
  );
  E['Lightforce Sword'] = trap(
    (e, _c, p, t) => anyTime(t) && e.player(other(p)).hand.length > 0,
    function* (e, _l, p) {
      const opp = other(p);
      const c = randomPick(e, e.player(opp).hand);
      if (!c) return;
      e.banish(c.uid);
      const first = e.state.turnPlayer === opp ? e.state.turn + 2 : e.state.turn + 1;
      (e.state.fx.lightforce ??= []).push({ uid: c.uid, back: first + 6 });
    },
  );
  E['Magical Arm Shield'] = trap(
    (e, _c, p, t, ctx) => t === 'attack' && ctx.uid !== undefined && e.controller(ctx.uid) === other(p) && e.monsters(p).length > 0 && hasFreeZone(e, p) && e.monsters(other(p)).some((m) => m.faceUp && m.uid !== ctx.uid),
    function* (e, link, p) {
      const atkUid = e.state.battle?.attacker;
      const list = targetable(e, e.monsters(other(p)).filter((m) => m.faceUp && m.uid !== atkUid));
      const picks = yield* e.select(p, 'Magical Arm Shield: steal which monster to take the hit?', e.optionsFor(list), 1, 1);
      if (!picks || !list[picks[0]]) return;
      const m = list[picks[0]];
      if (e.takeControl(m.uid, p)) {
        m.returnAtEnd = other(p);
        if (e.state.battle) e.state.battle.target = m.uid;
        e.log(link.player, `${m.name} is pulled in front of the attack`);
      }
    },
  );
  E['Magical Hats'] = trap(
    (e, _c, p, t, ctx) => t === 'attack' && ctx.uid !== undefined && e.controller(ctx.uid) === other(p) && e.monsters(p).length > 0,
    function* (e, _l, p) {
      const ps = e.player(p);
      const mine = e.monsters(p);
      const pk = yield* e.select(p, 'Magical Hats: hide which monster?', e.optionsFor(mine), 1, 1);
      if (!pk || !mine[pk[0]]) return;
      const hidden = mine[pk[0]];
      hidden.faceUp = false;
      hidden.pos = 'def';
      const decoys = ps.deck.filter((c) => e.info(c.name).kind !== 'monster');
      const dp = decoys.length ? yield* e.select(p, 'Magical Hats: pick 2 Spells/Traps from your Deck as decoys', e.optionsFor(decoys), Math.min(2, decoys.length), 2) : [];
      for (const i of dp ?? []) {
        if (!hasFreeZone(e, p)) break;
        const c = decoys[i];
        yield* e.specialSummon(c.uid, p, 'def', false);
        (e.state.fx.endOfBattle ??= []).push(c.uid);
      }
      // Shuffle the hats around the monster zones.
      const zones = ps.mz.map((z, i) => (z && (z.uid === hidden.uid || ((e.state.fx.endOfBattle as number[] | undefined) ?? []).includes(z.uid)) ? i : -1)).filter((i) => i >= 0);
      const cards = e.shuffle(zones.map((i) => ps.mz[i]!));
      zones.forEach((zi, k) => (ps.mz[zi] = cards[k]));
      if (e.state.battle && e.state.battle.target === hidden.uid) e.state.battle.target = randomPick(e, cards)?.uid ?? hidden.uid;
      e.log(p, 'Magical Hats shuffles the monster among the hats');
    },
  );
  E['Major Riot'] = trap(
    (e, _c, p, t) => anyTime(t) && (e.state.fx.bounced?.[p] ?? -1) === e.state.turn && allMonsters(e).length > 0,
    function* (e) {
      const counts: [number, number] = [0, 0];
      for (const m of allMonsters(e)) {
        counts[m.owner]++;
        for (const u of m.equips.slice()) yield* e.sendToGrave(u, 'used');
        e.toHand(m.uid);
      }
      for (const q of [0, 1] as Pid[]) {
        const list = e.player(q).hand.filter((c) => isMonster(e, c) && e.info(c.name).sub !== 'Fusion' && e.info(c.name).sub !== 'Ritual');
        const n = Math.min(counts[q], list.length);
        if (!n) continue;
        const picks = yield* e.select(q, `Major Riot: Set ${n} monster${n > 1 ? 's' : ''} from your hand`, e.optionsFor(list), n, n);
        for (const i of picks ?? []) if (hasFreeZone(e, q)) yield* e.specialSummon(list[i].uid, q, 'def', false);
      }
    },
  );
  E['Numinous Healer'] = trap(
    (_e, _c, p, t, ctx) => t === 'damage' && ctx.damaged === p,
    function* (e, _l, p) {
      const n = e.player(p).gy.filter((c) => c.name === 'Numinous Healer').length;
      e.gainLp(p, 1000 + 500 * n);
    },
  );
  E['Reverse Trap'] = trap(
    (_e, _c, _p, t) => anyTime(t),
    function* (e, l) {
      e.state.fx.reverseTurn = e.state.turn;
      e.log(l.player, 'Reverse Trap: every ATK/DEF boost now works backwards this turn');
    },
  );
  E["Solomon's Lawbook"] = trap(
    (_e, _c, _p, t) => anyTime(t),
    function* (e, _l, p) {
      e.state.fx.skipStandby = p;
    },
  );
  E['Time Seal'] = trap(
    (_e, _c, _p, t) => anyTime(t),
    function* (e, _l, p) {
      e.state.fx.skipDraw = other(p);
      e.log(p, `Time Seal: ${e.player(other(p)).name} skips their next draw`);
    },
  );
  E['Time Machine'] = trap(
    (e, _c, _p, t, ctx) => t === 'destroyed' && ctx.uid !== undefined && ctx.prevController !== undefined && e.find(ctx.uid)?.loc.zone === 'gy' && hasFreeZone(e, ctx.prevController),
    function* (e, link) {
      const x = link.payload as { uid: number; ctl: Pid; pos: Pos };
      if (e.find(x.uid)?.loc.zone === 'gy' && hasFreeZone(e, x.ctl)) yield* e.specialSummon(x.uid, x.ctl, x.pos);
    },
    function* (_e, link, _p, ctx: ChainCtx) {
      link.payload = { uid: ctx.uid, ctl: ctx.prevController, pos: ctx.prevPos ?? 'atk' };
    },
  );
  E['Two-Pronged Attack'] = trap(
    (e, _c, p, t) => anyTime(t) && e.monsters(p).length >= 2 && e.monsters(other(p)).length >= 1,
    function* (e, _l, p) {
      const mine = e.monsters(p);
      const a = yield* e.select(p, 'Two-Pronged Attack: destroy which 2 of your monsters?', e.optionsFor(mine), 2, 2);
      const theirs = targetable(e, e.monsters(other(p)));
      const b = yield* e.select(p, "Two-Pronged Attack: destroy which of your opponent's monsters?", e.optionsFor(theirs, true), 1, 1);
      if (!a || !b) return;
      yield* e.destroy([...a.map((i) => mine[i].uid), theirs[b[0]].uid]);
    },
  );
  E['Windstorm of Etaqua'] = trap(
    (e, _c, p, t) => anyTime(t) && e.monsters(other(p)).some((m) => m.faceUp),
    function* (e, _l, p) {
      for (const m of e.monsters(other(p)).filter((x) => x.faceUp)) m.pos = m.pos === 'atk' ? 'def' : 'atk';
    },
  );

  // ===== Continuous Traps =====
  const ctrap = (extra: Partial<EffectDef>, when: (e: Engine, p: Pid, t: Trigger, ctx: ChainCtx) => boolean = (_e, _p, t) => anyTime(t) || t === 'spell' || t === 'trap'): EffectDef => ({
    canActivate: (e, _c, p, t, ctx) => when(e, p, t, ctx),
    *resolve() {},
    ...extra,
  });
  E['Anti-Spell Fragrance'] = ctrap({});
  E['Light of Intervention'] = ctrap({});
  E['Royal Decree'] = ctrap({});
  E['Goblin Fan'] = ctrap({});
  E['Respect Play'] = ctrap({});
  E['The Eye of Truth'] = ctrap({
    *onStandby(e, _c, p) {
      const opp = other(p);
      if (e.state.turnPlayer === opp && e.player(opp).hand.some((c) => e.info(c.name).kind === 'spell')) e.gainLp(opp, 1000);
    },
  });
  E['Appropriate'] = ctrap({
    onDraw(e, _c, p, drawer) {
      if (drawer === other(p)) {
        e.log(p, 'Appropriate: 2 cards for you too');
        e.draw(p, 2);
      }
    },
  });
  E['Magical Thorn'] = ctrap({
    *onAnyDiscard(e, _c, p, discarder) {
      if (discarder === other(p)) e.damage(discarder, 500);
    },
  });
  E['Forced Requisition'] = ctrap({
    *onAnyDiscard(e, _c, p, discarder) {
      if (discarder !== p || e.state.fx.requisition) return;
      const opp = other(p);
      const hand = e.player(opp).hand;
      if (!hand.length) return;
      e.state.fx.requisition = true;
      try {
        const picks = yield* e.select(opp, 'Forced Requisition: discard 1 card', e.optionsFor(hand), 1, 1);
        if (picks && hand[picks[0]]) yield* e.discard(opp, hand[picks[0]].uid);
      } finally {
        e.state.fx.requisition = false;
      }
    },
  });
  E['Imperial Order'] = ctrap({
    *onStandby(e, c, p) {
      if (e.state.fx.imperialPaid === `${c.uid}:${e.state.turn}`) return;
      e.state.fx.imperialPaid = `${c.uid}:${e.state.turn}`;
      if (e.player(p).lp > 700) {
        e.log(p, 'Imperial Order: 700 LP upkeep');
        e.payLp(p, 700);
      } else yield* e.destroy([c.uid]);
    },
  });
  E['Mirror Wall'] = ctrap(
    {
      *activate(e, link, _p, ctx) {
        if (ctx.uid !== undefined && e.fieldCard(ctx.uid)) tag(e.fieldCard(ctx.uid)!).mirrorWall = link.card.uid;
      },
      attackTax: {
        can: () => true,
        *pay(e, c, m, p) {
          if (p !== ctrl(e, c)) tag(m).mirrorWall = c.uid;
        },
      },
      *onStandby(e, c, p) {
        if (e.state.turnPlayer !== p) return;
        if (e.player(p).lp > 2000 && (yield* e.yesno(p, 'Mirror Wall: pay 2000 LP to keep it?'))) e.payLp(p, 2000);
        else yield* e.destroy([c.uid]);
      },
    },
    (e, p, t, ctx) => t === 'attack' && ctx.uid !== undefined && e.controller(ctx.uid) === other(p),
  );
  E['DNA Surgery'] = {
    canActivate: (e, _c, _p, t) => anyTime(t) && faceUp(e).length > 0,
    *activate(e, link, p) {
      const r = yield* choose(e, p, 'DNA Surgery: declare a Type', RACES);
      if (!r) return false;
      link.payload = r[0];
    },
    *resolve(e, link) {
      e.state.fx.dnaRace = link.payload;
      e.state.fx.dnaSource = link.card.uid;
      e.log(link.player, `DNA Surgery: every face-up monster becomes ${link.payload}`);
    },
  };
  E['The Regulation of Tribe'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *activate(e, link, p) {
      const r = yield* choose(e, p, 'The Regulation of Tribe: declare a Type that cannot attack', RACES);
      if (!r) return false;
      link.payload = r[0];
    },
    *resolve(e, link) {
      (e.state.fx.regulation ??= {})[link.card.uid] = link.payload;
    },
    blocksAttack: (e, c, m) => e.raceOf(m) === e.state.fx.regulation?.[c.uid],
    *onStandby(e, c, p) {
      if (e.state.turnPlayer !== p) return;
      const mine = e.monsters(p);
      const picks = mine.length ? yield* e.select(p, 'The Regulation of Tribe: Tribute a monster to keep it (or Cancel to let it go)', e.optionsFor(mine), 1, 1, true) : null;
      if (picks && mine[picks[0]]) yield* e.sendToGrave(mine[picks[0]].uid, 'tribute');
      else yield* e.destroy([c.uid]);
    },
  };
  E['Dragon Capture Jar'] = ctrap({
    *resolve(e) {
      for (const m of faceUp(e)) if (e.raceOf(m) === 'Dragon') m.pos = 'def';
    },
    blocksAttack: (e, _c, m) => e.raceOf(m) === 'Dragon',
  });
  E['Call of Darkness'] = ctrap({
    *resolve(e) {
      const revived = allMonsters(e).filter((m) => m.tags?.reborn);
      if (revived.length) yield* e.destroy(revived.map((m) => m.uid));
    },
  });
  {
    const mr = E['Monster Reborn'];
    E['Monster Reborn'] = {
      ...mr,
      canActivate: (e, c, p, t, ctx) => !e.anyActive('Call of Darkness') && !!mr.canActivate?.(e, c, p, t, ctx),
      *resolve(e, link, p) {
        yield* mr.resolve!(e, link, p);
        const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
        if (m) tag(m).reborn = 1;
      },
    };
  }
  E['Ultimate Offering'] = ctrap({
    ignition: {
      can: (e, _c, p) => e.player(p).normalSummoned && e.player(p).lp > 500 && e.player(p).hand.some((c) => isMonster(e, c)),
      *run(e, _c, p) {
        e.payLp(p, 500);
        e.player(p).normalSummoned = false;
        e.log(p, 'Ultimate Offering: one more Normal Summon');
      },
      repeat: true,
    },
  });
  void attachTo;
  void isNormalMonsterCard;
  void name;
}
