// audit-skills: every Speed Duel Skill, one by one (run: npx tsx tests/audit-skills.test.ts)
// Each of the 156 Skills is equippable (deck editor + duel start) and has a targeted check of what its text does:
// its activation condition, its effect and (where it has one) its once-per-turn / once-per-Duel limit.
import { readFileSync } from 'node:fs';
import { Engine } from '../src/eds/engine';
import type { Card, CardInfo, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';
import { SKILLS, getSkill, PLAYABLE_SKILLS } from '../src/eds/skills';

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
  if (!ok && process.env.DBG && cur) console.log(cur.state.log.slice(-25).map((l) => '    ' + l.text).join('\n'));
};
let cur: Engine | null = null;
const FILL = 'Celtic Guardian';

// Test-only stand-ins for cards this game's pool lacks.
const fake = (info: Partial<CardInfo> & { name: string }) => {
  const full = { id: 990500 + DB.size, kind: 'monster', sub: 'Effect', desc: '', ...info } as CardInfo;
  DB.set(full.name, full);
  DB.set(full.name.toLowerCase(), full);
};
fake({ name: 'Ancient Gear Test Fusion', sub: 'Fusion', level: 9, atk: 3500, def: 3000, race: 'Machine', attribute: 'EARTH', desc: '"Ancient Gear Golem" + "Ancient Gear Soldier"' });
fake({ name: 'Test Machine Fusion', sub: 'Fusion', level: 6, atk: 2000, def: 1000, race: 'Machine', attribute: 'EARTH', desc: '"Gyroid" + "Steamroid"' });

// ---------- duel kit (from tests/batch-16.test.ts; duels start with Skills) ----------
type Ans = 'yes' | 'no' | 'pass' | { pick: string[] } | { respond: string };
function settle(e: Engine, ...ans: Ans[]): number {
  const q = [...ans];
  for (let i = 0; i < 400 && e.state.prompt && e.state.winner === null; i++) {
    const pr = e.state.prompt;
    const h = q[0];
    if (pr.kind === 'select' && pr.max === 0) {
      e.apply({ type: 'CHOOSE', player: pr.player, picks: [] }); // a reveal
      continue;
    }
    if (pr.kind === 'yesno') {
      if (h === 'yes' || h === 'no') {
        q.shift();
        e.apply({ type: h === 'yes' ? 'YES' : 'NO', player: pr.player });
      } else e.apply({ type: 'NO', player: pr.player });
    } else if (pr.kind === 'response') {
      if (h && typeof h === 'object' && 'respond' in h) {
        const k = pr.options.findIndex((o) => o.label.startsWith(h.respond));
        if (k >= 0) {
          q.shift();
          e.apply({ type: 'CHOOSE', player: pr.player, picks: [k] });
          continue;
        }
      }
      if (h === 'pass') q.shift();
      e.apply({ type: 'PASS', player: pr.player });
    } else if (h && typeof h === 'object' && 'pick' in h) {
      q.shift();
      const picks: number[] = [];
      for (const l of h.pick) {
        const k = pr.options.findIndex((o, j) => (o.label === l || o.label.startsWith(l)) && !picks.includes(j));
        if (k >= 0) picks.push(k);
      }
      e.apply({ type: 'CHOOSE', player: pr.player, picks });
    } else e.apply({ type: 'CHOOSE', player: pr.player, picks: pr.options.map((_, j) => j).slice(0, Math.max(1, pr.min)) });
  }
  return q.length;
}
/** A Speed Duel where player 0 has Skill `s0` (and player 1 `s1`); each Deck holds 4 fillers (the opening hand), then the listed cards. */
function sd(s0: string | null, d0: string[] = [], d1: string[] = [], x0: string[] = [], x1: string[] = [], s1: string | null = null, ...ans: Ans[]): Engine {
  const e = new Engine(DB);
  cur = e;
  e.shuffle = <T,>(a: T[]) => a.slice();
  const pad = (d: string[]) => [...Array(4).fill(FILL), ...d, ...Array(Math.max(0, 30 - d.length)).fill(FILL)];
  e.apply({ type: 'START', first: 0, seed: 1, names: ['A', 'B'], decks: [pad(d0), pad(d1)], fusions: [x0, x1], mode: 'speed', skills: [s0, s1] });
  settle(e, ...ans);
  return e;
}
const run = (e: Engine, step: Generator<any, any, any>, ...ans: Ans[]) => {
  (e as any).run(step);
  return settle(e, ...ans);
};
const zone = (e: Engine, c: Card | null | undefined) => (c ? e.find(c.uid)?.loc.zone : undefined);
function grab(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.hand, ...ps.deck, ...ps.gy, ...ps.removed].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  if (zone(e, c) !== 'hand') e.toHandOf(c.uid, p);
  return c;
}
function place(e: Engine, p: Pid, name: string, pos: Pos = 'atk', faceUp = true, ...ans: Ans[]): FieldCard {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.gy, ...ps.fusion, ...ps.hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  e.state.fx.ignoreCond = c.uid; // test setup: place it ignoring Summoning conditions
  run(e, e.specialSummon(c.uid, p, pos, faceUp), ...ans);
  const f = e.fieldCard(c.uid);
  if (!f) throw new Error(`${name} did not arrive`);
  if (!faceUp) f.placedTurn = -1;
  return f;
}
function putST(e: Engine, p: Pid, name: string, faceUp = false): FieldCard {
  const c = grab(e, p, name);
  const ps = e.player(p);
  ps.hand.splice(ps.hand.findIndex((x) => x.uid === c.uid), 1);
  const z = ps.sz.findIndex((x) => x === null);
  const fc: FieldCard = { ...c, pos: 'atk', faceUp, placedTurn: -1, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: faceUp };
  ps.sz[z] = fc;
  return fc;
}
const toGY = (e: Engine, p: Pid, ...names: string[]) => {
  for (const n of names) run(e, e.sendToGrave(grab(e, p, n).uid, 'cost'));
};
const act = (e: Engine, p: Pid, uid: number, ...ans: Ans[]) => {
  e.apply({ type: 'ACTIVATE', player: p, uid, zone: e.player(p).sz.findIndex((z) => z === null) });
  return settle(e, ...ans);
};
const kill = (e: Engine, cards: (Card | null | undefined)[], by?: Pid, ...ans: Ans[]) => {
  const uids = cards.filter((c): c is Card => !!c).map((c) => c.uid);
  return run(e, by === undefined ? e.destroy(uids) : e.as(by, e.destroy(uids)), ...ans);
};
const endTurn = (e: Engine, ...ans: Ans[]) => {
  e.apply({ type: 'END_TURN', player: e.state.turnPlayer });
  return settle(e, ...ans);
};
/** Ends turns until it is `p`'s next turn (Main Phase 1). */
const turnOf = (e: Engine, p: Pid, ...ans: Ans[]) => {
  endTurn(e, ...ans);
  if (e.state.turnPlayer !== p) endTurn(e, ...ans);
};
const toBattle = (e: Engine) => {
  for (let i = 0; i < 3 && e.state.phase !== 'BP'; i++) {
    e.apply({ type: 'NEXT_PHASE', player: e.state.turnPlayer });
    settle(e);
  }
};
const attack = (e: Engine, a: FieldCard | null, t: FieldCard | null, ...ans: Ans[]) => {
  e.apply({ type: 'ATTACK', player: e.state.turnPlayer, uid: a!.uid, target: t ? t.uid : null });
  return settle(e, ...ans);
};
const use = (e: Engine, p: Pid, ...ans: Ans[]) => {
  const before = e.player(p).skillUses ?? 0;
  e.apply({ type: 'SKILL', player: p });
  settle(e, ...ans);
  return (e.player(p).skillUses ?? 0) > before;
};
const can = (e: Engine, p: Pid = 0) => e.canUseSkill(p);
const lp = (e: Engine, p: Pid) => e.player(p).lp;
const handHas = (e: Engine, p: Pid, n: string) => e.player(p).hand.some((c) => c.name === n);
const gyHas = (e: Engine, p: Pid, n: string) => e.player(p).gy.some((c) => c.name === n);
const fieldHas = (e: Engine, p: Pid, n: string) => e.monsters(p).some((m) => m.name === n);
const mon = (e: Engine, p: Pid, n: string) => e.monsters(p).find((m) => m.name === n)!;
const logHas = (e: Engine, text: string, since = 0) => e.state.log.slice(since).some((l) => l.text.includes(text));
const tested = new Set<string>();
function T(skill: string, fn: () => void) {
  console.log(`\n--- ${skill}`);
  if (!SKILLS[skill]) check(false, `${skill}: no script`);
  tested.add(skill);
  try {
    fn();
  } catch (err) {
    check(false, `${skill}: threw ${(err as Error).stack?.split('\n').slice(0, 3).join(' | ')}`);
  }
}

// ======================================================================
// Equippable: every Skill Card of the Speed Duel list has a script, is offered by the deck editor and is accepted at duel start.
// ======================================================================
import { speedDeckProblems } from '../src/eds/speedSave';
const RAW = JSON.parse(readFileSync('public/cards/speed.json', 'utf8'));
const ALL_SKILLS: string[] = (Array.isArray(RAW) ? RAW : RAW.cards ?? Object.values(RAW)).filter((c: any) => c.type === 'Skill Card').map((c: any) => c.name);
{
  console.log('\n--- equippable');
  check(ALL_SKILLS.length === 156, `speed.json lists 156 Skill Cards (${ALL_SKILLS.length})`);
  const playable = new Set(PLAYABLE_SKILLS());
  let ok = 0;
  for (const s of ALL_SKILLS) {
    const problems = speedDeckProblems({ id: 't', name: 't', main: Array(40).fill('Celtic Guardian'), extra: [], skill: s } as any).filter((x) => x.includes(s) && !/Limited|Forbidden/.test(x));
    const e = new Engine(DB);
    e.apply({ type: 'START', first: 0, seed: 1, names: ['A', 'B'], decks: [Array(40).fill(FILL), Array(40).fill(FILL)], fusions: [[], []], mode: 'speed', skills: [s, null] });
    settle(e);
    const good = !!getSkill(s) && playable.has(s) && problems.length === 0 && e.player(0).skill === s;
    if (!good) check(false, `${s} is equippable (${problems.join('; ')})`);
    else ok++;
  }
  check(ok === ALL_SKILLS.length, `${ok} of ${ALL_SKILLS.length} Skills equippable`);
}

// ======================================================================
// Field Zone / start-of-Duel Skills
// ======================================================================
T('Peak Performance', () => {
  const e = sd('Peak Performance', ['Koumori Dragon', 'Harpie Lady'], ['Blackland Fire Dragon']);
  const k = place(e, 0, 'Koumori Dragon');
  const h = place(e, 0, 'Harpie Lady');
  const c = place(e, 0, FILL);
  const o = place(e, 1, 'Blackland Fire Dragon');
  check(e.atkOf(k) === 1700 && e.defOf(k) === 1400 && e.atkOf(h) === 1500 && e.atkOf(c) === 1400 && e.atkOf(o) === 1700, 'Dragon/Winged Beast (both sides) +200 ATK/DEF, others unchanged');
});
T('Power of Dark', () => {
  const e = sd('Power of Dark', ['Archfiend Soldier', 'Dark Elf', 'Shining Angel']);
  check(e.atkOf(place(e, 0, 'Archfiend Soldier')) === 2100 && e.atkOf(place(e, 0, 'Dark Elf')) === 2200 && e.atkOf(place(e, 0, 'Shining Angel')) === 1200, 'Fiend/Spellcaster +200, Fairy -200');
});
T('Straight to the Grave', () => {
  const e = sd('Straight to the Grave', ['Two-Headed King Rex', 'Vampire Lady', 'Alpha The Magnet Warrior']);
  check(e.atkOf(place(e, 0, 'Two-Headed King Rex')) === 1800 && e.atkOf(place(e, 0, 'Vampire Lady')) === 1750 && e.atkOf(place(e, 0, 'Alpha The Magnet Warrior')) === 1600, 'Dinosaur/Zombie/Rock +200');
});
T('Dinosaur Kingdom', () => {
  const e = sd('Dinosaur Kingdom', ['Two-Headed King Rex'], ['Gilasaurus']);
  const r = place(e, 0, 'Two-Headed King Rex');
  check(e.atkOf(r) === 1900 && e.defOf(r) === 1500 && e.atkOf(place(e, 1, 'Gilasaurus')) === 1700 && e.atkOf(place(e, 0, FILL)) === 1400, 'all Dinosaurs +300 ATK/DEF, others unchanged');
});
T('Tomb of the Pharaoh', () => {
  const e = sd('Tomb of the Pharaoh', ["Gravekeeper's Spy"]);
  check(e.atkOf(place(e, 0, "Gravekeeper's Spy")) === 1400, '"Gravekeeper\'s" monsters +200');
  check(!!e.anyActive('Necrovalley'), 'the field counts as having "Necrovalley"');
});
T('Mythic Depths', () => {
  const e = sd('Mythic Depths', ['Unshaven Angler', 'Cyber Phoenix']);
  check(e.player(0).field?.name === 'Umi', 'starts in the Field Zone as "Umi"');
  check(e.atkOf(place(e, 0, 'Unshaven Angler')) === 1700 && e.atkOf(place(e, 0, 'Cyber Phoenix')) === 1000, 'Fish +200, Machine -200');
  const f = e.player(0).field!;
  kill(e, [f], 1);
  check(e.player(0).field?.uid === f.uid, 'cannot be destroyed by card effects');
});
T("It's a Toon World!", () => {
  const e = sd("It's a Toon World!");
  check(e.spells(0).some((c) => c.name === 'Toon World' && c.faceUp), 'starts in the Spell & Trap Zone as "Toon World"');
});
T('Call of the Haunted (Skill Card)', () => {
  const e = sd('Call of the Haunted (Skill Card)', ['Dark Elf']);
  const c = e.spells(0).find((x) => x.name === 'Call of the Haunted');
  check(!!c && !c.faceUp, 'starts Set in the Spell & Trap Zone');
  check(e.player(0).hand.length === 3, 'draw 1 less card at the start (3)');
});
T('Aroma Strategy', () => {
  const e = sd('Aroma Strategy');
  check(e.player(0).skillRevealed, 'flipped over at the start');
  check(use(e, 0) && can(e) && use(e, 0), 'look at the top card any number of times');
});
T('Millennium Eye (Skill Card)', () => {
  const e = sd('Millennium Eye (Skill Card)', [], [], [], [], null, 'yes');
  check(e.player(0).skillRevealed && logHas(e, 'Millennium Eye'), "looks at the opponent's opening hand at the start");
  check(e.player(1).hand.length === 4, 'the opponent draws a new hand of the same size');
});
T('Mind Scan (Skill Card)', () => {
  const e = sd('Mind Scan (Skill Card)', [], ['Trap Hole']);
  check(!e.player(0).skillRevealed, 'not active during turns 1-2');
  putST(e, 1, 'Trap Hole');
  turnOf(e, 0);
  check(e.player(0).skillRevealed && can(e) && use(e, 0) && can(e), 'turn 3 with 3000+ LP: activates; look at Set cards at any time');
  e.damage(0, 1500);
  run(e, (function* () {})());
  check(!e.player(0).skillRevealed && !can(e), 'flips over once LP drop below 3000');
  const e2 = sd('Mind Scan (Skill Card)', [], ['Trap Hole']);
  putST(e2, 1, 'Trap Hole');
  e2.player(0).lp = 2500;
  turnOf(e2, 0);
  check(!can(e2), 'not activated when LP are below 3000 at turn 3');
});
T('Tribal Synergy', () => {
  const e = sd('Tribal Synergy', ['Amazoness Fighter', 'Harpie Lady', 'Amazoness Tiger', 'Harpie Lady Sisters']);
  check(e.player(0).skillRevealed, 'flipped over at the start');
  grab(e, 0, 'Amazoness Fighter');
  grab(e, 0, 'Harpie Lady');
  const n = e.player(0).hand.length;
  check(use(e, 0) && e.player(0).hand.length === n + 1, 'reveal an Amazoness and a Harpie in hand: draw 1');
  place(e, 0, 'Amazoness Tiger');
  place(e, 0, 'Harpie Lady Sisters');
  const n2 = e.player(0).hand.length;
  check(can(e) && use(e, 0) && e.player(0).hand.length === n2 + 2, 'control both: draw 2 (each part once per Duel)');
  check(!can(e), 'both parts used');
});
T("Magician's Act", () => {
  const e = sd("Magician's Act", ['Dark Magician'], [], [], [], null, { pick: ['Add "Dark Magician"'] });
  check(handHas(e, 0, 'Dark Magician') && e.player(0).hand.length === 4, 'start of the Duel: add Dark Magician, shuffle 1 card back');
  place(e, 0, 'Dark Magician');
  const n = e.player(0).hand.length;
  check(use(e, 0) && gyHas(e, 0, 'Dark Magician') && e.player(0).hand.length === n + 2, 'Tribute Dark Magician: draw 2');
  check(!can(e), 'once per Duel');
});
T('Twisted Personality', () => {
  const e = sd('Twisted Personality');
  check(e.player(0).skillRevealed, 'flipped over at the start');
  run(e, e.as(0, (function* () { e.damage(1, 100); })()));
  run(e, e.as(0, (function* () { e.damage(0, 100); })()));
  check(e.skillCard(0)?.counters === 2, 'a counter each time a player loses LP');
  const n = e.player(1).hand.length;
  check(use(e, 0) && e.player(1).hand.length === n - 1 && e.skillCard(0)?.counters === 0, 'remove 2: discard a random card from the opponent\'s hand');
  check(!can(e), 'once per turn');
});

// ======================================================================
// Draw Phase Skills
// ======================================================================
T('Destiny Draw (Skill Card)', () => {
  const e = sd('Destiny Draw (Skill Card)', ['Dark Elf']);
  e.damage(0, 1900);
  turnOf(e, 0, 'yes');
  check(e.player(0).skillUses === 0, 'not after losing less than 2000 LP');
  const e2 = sd('Destiny Draw (Skill Card)', ['Dark Elf']);
  e2.damage(0, 2000);
  turnOf(e2, 0, 'yes', { pick: ['Dark Elf'] });
  check(e2.player(0).skillUses === 1 && handHas(e2, 0, 'Dark Elf'), 'after losing 2000 LP: search any card instead of drawing');
});
T('Flight of the Harpies', () => {
  const e = sd('Flight of the Harpies', ['Harpie Lady']);
  e.damage(0, 1800);
  turnOf(e, 0, 'yes');
  check(e.player(0).skillUses === 1 && handHas(e, 0, 'Harpie Lady'), 'after losing 1800 LP: search a "Harpie" card');
});
T("Gravekeeper's Lot", () => {
  const e = sd("Gravekeeper's Lot", ["Gravekeeper's Spy"]);
  e.damage(0, 1800);
  turnOf(e, 0, 'yes');
  check(e.player(0).skillUses === 1 && handHas(e, 0, "Gravekeeper's Spy"), 'after losing 1800 LP: search a "Gravekeeper\'s" card');
});
T('Final Draw', () => {
  const e = sd('Final Draw', ['Dark Elf']);
  check(use(e, 0) && !can(e), 'once per turn: place a counter');
  turnOf(e, 0);
  use(e, 0);
  turnOf(e, 0);
  use(e, 0);
  turnOf(e, 0, 'yes', { pick: ['Dark Elf'] });
  check(handHas(e, 0, 'Dark Elf'), '3 counters: search any card instead of drawing');
  endTurn(e);
  check(e.state.winner === 1, 'lose the Duel at the end of that turn');
});
T('Double Evolution Pill (Skill Card)', () => {
  const e = sd('Double Evolution Pill (Skill Card)', ['Gilasaurus', 'Black Tyranno']);
  grab(e, 0, 'Gilasaurus');
  turnOf(e, 0, 'yes');
  check(fieldHas(e, 0, 'Black Tyranno') && lp(e, 0) === 2500 && e.player(0).removed.length === 2, 'pay 1500, banish a Dinosaur and a non-Dinosaur: Special Summon a Level 7+ Dinosaur instead of drawing');
});
T("I've Got Dino DNA!", () => {
  const e = sd("I've Got Dino DNA!", ['Two-Headed King Rex']);
  turnOf(e, 0);
  check(lp(e, 0) === 4200, 'gain 200 LP in your Draw Phase');
  const r = place(e, 0, 'Two-Headed King Rex');
  check(use(e, 0) && e.atkOf(r) === 1800 && !can(e), 'a Dinosaur gains 200 ATK (once per turn)');
});

// ======================================================================
// Main Phase activations
// ======================================================================
T('Power Up!', () => {
  const e = sd('Power Up!');
  const m = place(e, 0, FILL);
  check(use(e, 0) && e.atkOf(m) === 1900 && !can(e), '+500 ATK, once per Duel');
});
T('Low Blow', () => {
  const e = sd('Low Blow', [], ['Dark Elf']);
  const m = place(e, 1, 'Dark Elf');
  check(use(e, 0) && e.atkOf(m) === 1500 && e.defOf(m) === 300 && !can(e), '-500 ATK/DEF, once per Duel');
});
T('Room for Growth', () => {
  const e = sd('Room for Growth', ['Gilasaurus']);
  const m = place(e, 0, 'Gilasaurus');
  check(use(e, 0) && e.atkOf(m) === 2300 && !can(e), 'Level 3 monster gains 900 ATK; once per turn');
  turnOf(e, 0);
  check(can(e), 'usable again on a later turn');
});
T('Beatdown!', () => {
  const e = sd('Beatdown!', ['Black Tyranno']);
  const c = place(e, 0, FILL);
  check(!can(e), 'needs a Level 5+ monster');
  place(e, 0, 'Black Tyranno');
  check(use(e, 0) && e.atkOf(c) === 1700 && !can(e), 'all your monsters +300 per Level 5+ monster');
});
T('Ruthless Means', () => {
  const e = sd('Ruthless Means', ['Evil HERO Infernal Gainer'], ['Dark Elf']);
  const o = place(e, 1, 'Dark Elf');
  check(!can(e), 'needs an "Evil HERO"');
  place(e, 0, 'Evil HERO Infernal Gainer');
  check(use(e, 0) && e.atkOf(o) === 1200 && !can(e), 'discard 1: the monster loses ATK equal to its DEF');
});
T('Digging for Gold', () => {
  const e = sd('Digging for Gold');
  check(!can(e), 'needs 3 cards in the GY');
  toGY(e, 0, FILL, FILL, FILL);
  const n = e.player(0).hand.length;
  check(use(e, 0) && e.player(0).removed.length === 3 && e.player(0).hand.length === n + 1 && !can(e), 'banish 3 from the GY, draw 1 (once per Duel)');
});
T('Switcheroo', () => {
  const e = sd('Switcheroo');
  check(use(e, 0) && e.player(0).hand.length === 4 && !can(e), 'shuffle 1 in, draw 1; once per turn');
  turnOf(e, 0);
  check(use(e, 0) && (turnOf(e, 0), !can(e)), 'usable twice per Duel');
});
T('Last Gamble', () => {
  const e = sd('Last Gamble');
  check(!can(e), 'not before turn 5');
  turnOf(e, 0);
  turnOf(e, 0);
  e.state.fx.fixedRoll = { p: 0, die: 3 };
  const n = e.player(0).hand.length;
  check(use(e, 0) && lp(e, 0) === 100 && e.player(0).hand.length === n - 2 + 3 && !can(e), 'turn 5: LP to 100, discard 2, draw the die result');
});
T('Shadow Reborn', () => {
  const e = sd('Shadow Reborn', [], ['Dark Elf']);
  toGY(e, 1, 'Dark Elf');
  check(use(e, 0) && fieldHas(e, 0, 'Dark Elf') && lp(e, 0) === 2000 && !can(e), "pay half: Special Summon from either GY");
  check((e.state.fx.noBattleDamage as number[])[1] === e.state.turn, 'the opponent takes no battle damage this turn');
});
T('Rise of the Fallen', () => {
  const e = sd('Rise of the Fallen', ['Shining Angel']);
  toGY(e, 0, 'Shining Angel');
  check(use(e, 0) && mon(e, 0, 'Shining Angel')?.pos === 'def' && lp(e, 0) === 5400 && !can(e), 'Special Summon a Fairy in Defense Position, gain its ATK');
});
T('Dark Creation', () => {
  const e = sd('Dark Creation', ['Dark Elf', 'Archfiend Soldier', 'Koumori Dragon', 'Mechanicalchaser', 'Vampire Lady']);
  toGY(e, 0, 'Dark Elf', 'Archfiend Soldier', 'Koumori Dragon', 'Mechanicalchaser');
  check(!can(e), 'needs 5 DARK monsters with different names');
  toGY(e, 0, 'Vampire Lady');
  check(use(e, 0) && e.monsters(0).length === 1 && e.player(0).removed.length === 1 && !can(e), 'banish 1, Special Summon 1 DARK monster from the GY');
});
T("It's No Monster, It's a God!", () => {
  const e = sd("It's No Monster, It's a God!", ['Obelisk the Tormentor']);
  check(use(e, 0) && handHas(e, 0, 'Obelisk the Tormentor') && !can(e), 'discard, add Obelisk (once per Duel)');
});
T('Endless Traps', () => {
  const e = sd('Endless Traps', ['Trap Hole', 'Mirror Force', 'Metal Reflect Slime']);
  toGY(e, 0, 'Trap Hole', 'Mirror Force');
  check(!can(e), 'needs exactly 3 Traps in the GY');
  toGY(e, 0, 'Metal Reflect Slime');
  check(use(e, 0) && e.player(0).gy.length === 0 && e.player(0).removed.length === 1 && e.player(0).hand.length === 5 && !can(e), '1 to hand, 1 to the Deck, 1 banished');
});
T('Bandit', () => {
  const e = sd('Bandit', [], ['Trap Hole']);
  const t = putST(e, 1, 'Trap Hole');
  check(!can(e), 'needs 1500 or less LP');
  e.player(0).lp = 1500;
  check(use(e, 0) && e.spells(0).some((c) => c.uid === t.uid) && !can(e), "take control of a Set card");
});
T('Servants of the Fallen King', () => {
  const e = sd('Servants of the Fallen King', ["Pharaoh's Servant"]);
  check(use(e, 0) && gyHas(e, 0, "Pharaoh's Servant") && !can(e), 'send a Level 3 or lower Zombie Normal Monster from the Deck to the GY, once per turn');
});
T('Cold-Blooded Tactician', () => {
  const e = sd('Cold-Blooded Tactician', ['Armored Lizard'], ['Dark Elf']);
  const o = place(e, 1, 'Dark Elf');
  place(e, 0, 'Armored Lizard');
  check(use(e, 0) && o.pos === 'def' && !can(e), 'change the positions of up to (Reptiles) monsters');
});
T('Viral Infection', () => {
  const e = sd('Viral Infection', [], ['Dark Elf']);
  check(use(e, 0, { pick: [FILL] }, { pick: ['Monster'] }) && e.player(1).gy.length === 1 && !can(e), 'discard 1, the opponent sends 1 card of that type from the Deck');
});
T('The Psychic Duelist', () => {
  const e = sd('The Psychic Duelist');
  check(use(e, 0, { pick: ['Monster'] }) && lp(e, 0) === 2000 && lp(e, 1) === 3500, 'pay half; right guess of a random hand card: 500 damage');
  check(!can(e), 'the other part needs a Set card');
});
T('Into the Darkness Below', () => {
  const e = sd('Into the Darkness Below', ['Archfiend Soldier']);
  grab(e, 0, 'Archfiend Soldier');
  const n = e.player(0).hand.length;
  check(use(e, 0) && gyHas(e, 0, 'Archfiend Soldier') && e.player(0).hand.length === n && !can(e), 'discard a Fiend Normal Monster: draw 1');
});
T("The World's Greatest Fisherman", () => {
  const e = sd("The World's Greatest Fisherman", ['Mother Grizzly', 'Unshaven Angler']);
  grab(e, 0, 'Mother Grizzly');
  toGY(e, 0, 'Unshaven Angler');
  check(use(e, 0) && handHas(e, 0, 'Unshaven Angler') && lp(e, 0) === 3500 && !can(e), 'pay 500, discard a WATER: add a WATER from the GY');
});
T('Setting Sun', () => {
  const e = sd('Setting Sun', ['Helios - The Primordial Sun', 'Helios Duo Megistus']);
  place(e, 0, 'Helios - The Primordial Sun');
  check(use(e, 0) && handHas(e, 0, 'Helios Duo Megistus') && e.player(0).removed.length === 1 && !can(e), 'banish 1 from hand: add a ? ATK monster with a different name');
});
T('Nightmare Sonic Blast!', () => {
  const e = sd('Nightmare Sonic Blast!', ['Serpent Night Dragon', 'Pot of Greed', 'Dark Elf', 'Trap Hole', 'Mirror Force']);
  place(e, 0, 'Serpent Night Dragon');
  check(use(e, 0, { pick: ['Dark Elf'] }) && handHas(e, 0, 'Dark Elf') && !can(e), '1 monster revealed: add 1 revealed card');
});
T('Under Pressure', () => {
  const e = sd('Under Pressure', ['Hyozanryu', 'Carboneddon']);
  const h = place(e, 0, 'Hyozanryu');
  check(use(e, 0) && e.atkOf(h) === 3100 && !can(e), 'Carboneddon revealed: Hyozanryu gains 1000 ATK');
  check(e.player(0).deck[e.player(0).deck.length - 1].name !== FILL || e.player(0).deck.slice(-4).some((c) => c.name === 'Carboneddon'), 'revealed cards go to the bottom');
});
T('Small Roid Big City', () => {
  const e = sd('Small Roid Big City', ['Steamroid', 'Drillroid']);
  const s = place(e, 0, 'Steamroid');
  check(use(e, 0) && zone(e, s) === 'gy' && handHas(e, 0, 'Drillroid') && !can(e), 'destroy a face-up card you control: add a "roid" card');
});
T('Victory of the Shadow Riders', () => {
  const e = sd('Victory of the Shadow Riders', ['Uria, Lord of Searing Flames']);
  check(use(e, 0) && handHas(e, 0, 'Uria, Lord of Searing Flames'), 'activation: add a Sacred Beast');
});
T('Magnetic Attraction', () => {
  const e = sd('Magnetic Attraction', ['Alpha The Magnet Warrior', 'Beta The Magnet Warrior', 'Valkyrion the Magna Warrior']);
  grab(e, 0, 'Alpha The Magnet Warrior');
  grab(e, 0, 'Beta The Magnet Warrior');
  check(use(e, 0) && handHas(e, 0, 'Valkyrion the Magna Warrior'), 'reveal 2 Magnet Warriors: add Valkyrion');
  check(!can(e), 'once per Duel');
});
T('Machine Angel Ascension', () => {
  const e = sd('Machine Angel Ascension', ['Pot of Greed', 'Cyber Angel Benten']);
  grab(e, 0, 'Pot of Greed');
  check(use(e, 0) && handHas(e, 0, 'Cyber Angel Benten') && gyHas(e, 0, 'Pot of Greed'), 'discard a Spell: add a "Cyber Angel"');
});
T('Cocoon of Ultra Evolution (Skill Card)', () => {
  const e = sd('Cocoon of Ultra Evolution (Skill Card)', ['Basic Insect']);
  toGY(e, 0, 'Basic Insect');
  const n = e.player(0).hand.length;
  check(use(e, 0) && !gyHas(e, 0, 'Basic Insect') && e.player(0).hand.length === n + 1, 'shuffle an Insect from the GY in, draw 1');
});
T('Fury of Thunder', () => {
  const e = sd('Fury of Thunder', ['Slifer the Sky Dragon']);
  toGY(e, 0, 'Slifer the Sky Dragon');
  check(use(e, 0) && !gyHas(e, 0, 'Slifer the Sky Dragon') && !can(e), 'Slifer in the GY: shuffle it into the Deck');
});
T("Archfiend's Promotion", () => {
  const e = sd("Archfiend's Promotion", ['Vilepawn Archfiend', 'Shadowknight Archfiend']);
  place(e, 0, 'Vilepawn Archfiend');
  check(use(e, 0) && fieldHas(e, 0, 'Shadowknight Archfiend') && gyHas(e, 0, 'Vilepawn Archfiend'), 'Tribute Vilepawn: Special Summon a Knight "Archfiend"');
});
T('Armed and Ready!', () => {
  const e = sd('Armed and Ready!', ['Armed Dragon LV3', 'Armed Dragon LV5']);
  place(e, 0, 'Armed Dragon LV3');
  check(use(e, 0) && fieldHas(e, 0, 'Armed Dragon LV5') && gyHas(e, 0, 'Armed Dragon LV3') && !can(e), 'send an LV monster: Special Summon the one it names');
});
T('The Right Hero for the Job', () => {
  const e = sd('The Right Hero for the Job', ['Elemental HERO Avian', 'Elemental HERO Sparkman']);
  place(e, 0, 'Elemental HERO Avian');
  check(use(e, 0) && fieldHas(e, 0, 'Elemental HERO Sparkman') && !fieldHas(e, 0, 'Elemental HERO Avian') && !can(e), 'shuffle a HERO in: Special Summon a different Level 4 or lower HERO');
});
T('Land of the Ojamas (Skill Card)', () => {
  const e = sd('Land of the Ojamas (Skill Card)', ['Ojama Yellow', 'Ojama Green']);
  grab(e, 0, 'Ojama Yellow');
  toGY(e, 0, 'Ojama Green');
  const c = place(e, 0, FILL);
  check(use(e, 0) && e.monsters(0).some((m) => m.name.startsWith('Ojama')), 'send an Ojama from hand: Special Summon an Ojama from the GY');
  check(e.atkOf(c) === 1200 && e.defOf(c) === 1400, 'while you control an Ojama: original ATK/DEF switched');
});
T('Zombie Master (Skill Card)', () => {
  const e = sd('Zombie Master (Skill Card)', ['Vampire Lady', 'Vampire Baby', 'Dark Elf']);
  place(e, 0, 'Vampire Lady');
  toGY(e, 0, 'Vampire Baby');
  grab(e, 0, 'Dark Elf');
  check(use(e, 0, 'yes', { pick: ['Dark Elf'] }) && fieldHas(e, 0, 'Vampire Baby'), 'the Zombie gains the effect; send a monster: Special Summon a Zombie from a GY');
});
T('Behold, Gate Guardian!', () => {
  const e = sd('Behold, Gate Guardian!', ['Gate Guardian', 'Sanga of the Thunder', 'Kazejin']);
  check(use(e, 0, 'yes', 'yes') && handHas(e, 0, 'Gate Guardian'), 'shuffle the hand in, add a Level 11 monster');
  const s = mon(e, 0, 'Sanga of the Thunder');
  const k = mon(e, 0, 'Kazejin');
  check(!!s && !!k && e.atkOf(s) === 0 && e.atkOf(k) === 0, 'Special Summon 2 Level 7 monsters (different Attributes) with 0 ATK');
});
T('Ancient Ruler Rises', () => {
  const e = sd('Ancient Ruler Rises', ["Pharaoh's Servant", 'The First Sarcophagus', 'Spirit of the Pharaoh']);
  check(use(e, 0) && gyHas(e, 0, "Pharaoh's Servant") && e.spells(0).some((c) => c.name === 'The First Sarcophagus' && c.faceUp), 'send a Level 2 Zombie, place a Sarcophagus face-up');
  const s = place(e, 0, 'Spirit of the Pharaoh');
  check(e.atkOf(s) === 3400, 'Spirit of the Pharaoh +900 per Servant/Protector');
});
T('Cyberdark Style (Skill Card)', () => {
  const e = sd('Cyberdark Style (Skill Card)', ['Cyberdark Horn', 'Cyberdark Edge', 'Cyberdark Keel']);
  check(!can(e), 'not above 3000 LP');
  e.player(0).lp = 3000;
  check(use(e, 0) && e.player(0).hand.some((c) => c.name.startsWith('Cyberdark')) && !can(e), 'at 3000 LP: 1 of 3 Cyberdarks added');
});
T('Ritual Ceremony', () => {
  const e = sd('Ritual Ceremony', ['Fortress Whale', "Fortress Whale's Oath"]);
  grab(e, 0, 'Fortress Whale');
  check(use(e, 0) && handHas(e, 0, "Fortress Whale's Oath") && !can(e), 'reveal a Ritual Monster: add its Ritual Spell');
});
T('Dragon Caller', () => {
  const e = sd('Dragon Caller', ['The Flute of Summoning Dragon', 'Lord of D.']);
  grab(e, 0, 'The Flute of Summoning Dragon');
  check(use(e, 0) && handHas(e, 0, 'Lord of D.') && !can(e), 'reveal the Flute: add Lord of D.');
});
T("It's Jinzo!", () => {
  const e = sd("It's Jinzo!", ['Jinzo'], ['Trap Hole']);
  putST(e, 1, 'Trap Hole');
  place(e, 0, 'Jinzo');
  const n = e.player(0).hand.length;
  check(use(e, 0) && e.player(0).hand.length === n + 1 && !can(e), 'look at a Set card: a Trap, draw 1');
  const e2 = sd('Power Up!', [], ['Jinzo'], [], [], "It's Jinzo!");
  place(e2, 1, 'Jinzo');
  check(!can(e2), "the opponent's Skill cannot affect Jinzo");
});
T('Millennium Necklace (Skill Card)', () => {
  const e = sd('Millennium Necklace (Skill Card)', [], ['Dark Elf', 'Pot of Greed', 'Trap Hole']);
  check(use(e, 0, { pick: ['Trap Hole'] }) && e.player(1).deck[0].name === 'Trap Hole' && !can(e), "rearrange the top 3 cards of the opponent's Deck (once per Duel)");
});
T('Prescience', () => {
  const e = sd('Prescience');
  check(!can(e), "needs the opponent's LP above twice yours");
  e.player(0).lp = 1900;
  check(use(e, 0) && can(e) && use(e, 0), 'look at the top cards any number of times');
});
T('Cyber Blade Fusion', () => {
  const e = sd('Cyber Blade Fusion', ['Etoile Cyber', 'Blade Skater'], [], ['Cyber Blader']);
  place(e, 0, 'Etoile Cyber');
  check(use(e, 0) && e.atkOf(mon(e, 0, 'Cyber Blader')) === 2500 && !can(e), 'discard 1: Fusion Summon Cyber Blader (field + Deck), +400 ATK');
});
T('Fusion Party!', () => {
  const e = sd('Fusion Party!', ['Elemental HERO Avian', 'Elemental HERO Burstinatrix'], [], ['Elemental HERO Flame Wingman']);
  grab(e, 0, 'Elemental HERO Avian');
  grab(e, 0, 'Elemental HERO Burstinatrix');
  check(use(e, 0) && fieldHas(e, 0, 'Elemental HERO Flame Wingman') && !can(e), 'Fusion Summon from hand/field, once per Duel');
});
T('HEROES UNITE - FUSION!!', () => {
  const e = sd('HEROES UNITE - FUSION!!', ['Elemental HERO Avian', 'Elemental HERO Burstinatrix'], [], ['Elemental HERO Flame Wingman']);
  grab(e, 0, 'Elemental HERO Avian');
  grab(e, 0, 'Elemental HERO Burstinatrix');
  check(use(e, 0) && fieldHas(e, 0, 'Elemental HERO Flame Wingman') && e.player(0).gy.length === 3 && !can(e), 'discard 1, Fusion Summon an Elemental HERO');
});
T('Beasts of Phantom', () => {
  const e = sd('Beasts of Phantom', ['Gazelle the King of Mythical Beasts', 'Berfomet', 'Phantom Beast Cross-Wing'], [], ['Chimera the Flying Mythical Beast']);
  grab(e, 0, 'Gazelle the King of Mythical Beasts');
  grab(e, 0, 'Berfomet');
  toGY(e, 0, 'Phantom Beast Cross-Wing');
  check(use(e, 0) && fieldHas(e, 0, 'Chimera the Flying Mythical Beast') && !can(e), 'discard 1, Fusion Summon Chimera (once per turn)');
  endTurn(e, 'yes');
  check(handHas(e, 0, 'Phantom Beast Cross-Wing'), 'End Phase: add a Phantom Beast from the GY');
});
T('Union Combination', () => {
  const e = sd('Union Combination', ['X-Head Cannon', 'Y-Dragon Head', 'Z-Metal Tank'], [], ['XYZ-Dragon Cannon']);
  place(e, 0, 'X-Head Cannon');
  toGY(e, 0, 'Y-Dragon Head', 'Z-Metal Tank');
  check(use(e, 0) && fieldHas(e, 0, 'XYZ-Dragon Cannon') && e.player(0).removed.length === 3 && !can(e), 'Special Summon a LIGHT Machine Fusion using field/GY materials');
  check((e.state.fx.noDamage as number[])[1] === e.state.turn, 'the opponent takes no damage this turn');
});
T('Thousand-Eyes Spell', () => {
  const e = sd('Thousand-Eyes Spell', ['Relinquished', 'Dark Elf']);
  grab(e, 0, 'Relinquished');
  grab(e, 0, 'Dark Elf');
  check(use(e, 0, { pick: [FILL] }) && fieldHas(e, 0, 'Relinquished'), 'discard 1: Ritual Summon Relinquished');
  toBattle(e);
  check(e.state.phase !== 'BP' || !e.canAttackWith(0, mon(e, 0, 'Relinquished')), 'no Battle Phase this turn');
});
T('Believe in your Bro', () => {
  const e = sd('Believe in your Bro', ['Steamroid', 'Pot of Greed', 'Gyroid']);
  place(e, 0, 'Steamroid');
  grab(e, 0, 'Pot of Greed');
  check(use(e, 0) && mon(e, 0, 'Gyroid')?.pos === 'def', 'Machine "roid": discard a Spell, Special Summon a "roid" in Defense Position');
  check(!can(e), 'once per turn');
});
T('HERO World', () => {
  const e = sd('HERO World', ['Elemental HERO Avian', 'Swords of Revealing Light']);
  place(e, 0, 'Elemental HERO Avian');
  const s = putST(e, 0, 'Swords of Revealing Light', true);
  check(use(e, 0) && zone(e, s) === 'gy' && !can(e), 'WIND HERO: discard 1, destroy a face-up Spell/Trap');
});
T('Hieratic Chant', () => {
  const e = sd('Hieratic Chant', ['The Winged Dragon of Ra']);
  check(use(e, 0) && e.player(0).hand.length === 1 && handHas(e, 0, 'The Winged Dragon of Ra') && (e.state.fx.extraTribute as number[])[0] === e.state.turn, 'discard the hand, add Ra, an extra Tribute Summon');
});
T('Hyper Metamorphosis', () => {
  const e = sd('Hyper Metamorphosis', ['Petit Moth', 'Perfectly Ultimate Great Moth']);
  place(e, 0, 'Petit Moth');
  check(use(e, 0) && fieldHas(e, 0, 'Perfectly Ultimate Great Moth') && gyHas(e, 0, 'Petit Moth') && (e.state.fx.halfDamage as number[])[1] === e.state.turn, 'discard 2, Tribute the Insect: Special Summon PUGM; opponent damage halved');
});
T('Dark Unity', () => {
  const e = sd('Dark Unity', ['Dark Fusion'], ['Dark Elf']);
  check(use(e, 0) && handHas(e, 0, 'Dark Fusion'), 'discard 1: add Dark Fusion');
  const o = place(e, 1, 'Dark Elf');
  check(can(e) && use(e, 0) && e.raceOf(o) === 'Rock' && lp(e, 0) === 2000, 'lose 2000: a Special Summoned monster becomes Rock');
  check(!can(e), 'each part once per Duel');
});
T('Spell of Mask', () => {
  const e = sd('Spell of Mask', ['Masked Beast Des Gardius', 'The Masked Beast', 'Curse of the Masked Beast']);
  place(e, 0, 'Masked Beast Des Gardius');
  check(use(e, 0) && handHas(e, 0, 'The Masked Beast') && handHas(e, 0, 'Curse of the Masked Beast') && !can(e), 'Tribute Des Gardius: add The Masked Beast and Curse');
});
T('Spell of Mask (Skill Card)', () => {
  const e = sd('Spell of Mask (Skill Card)', ['Masked Beast Des Gardius', 'The Masked Beast']);
  const mb = place(e, 0, 'The Masked Beast');
  (e.state.fx.ritualMats ??= {})[mb.uid] = { mats: [], turn: e.state.turn };
  kill(e, [mb], 1, 'yes');
  check(fieldHas(e, 0, 'Masked Beast Des Gardius'), 'Ritual Summoned Masked Beast destroyed by the opponent: Special Summon Des Gardius');
});
T('Power Bond (Skill Card)', () => {
  const e = sd('Power Bond (Skill Card)', ['Gyroid', 'Steamroid'], [], ['Test Machine Fusion']);
  grab(e, 0, 'Gyroid');
  grab(e, 0, 'Steamroid');
  check(use(e, 0) && e.atkOf(mon(e, 0, 'Test Machine Fusion')) === 4000, 'discard 1, Fusion Summon a Machine: ATK doubled');
  endTurn(e);
  check(lp(e, 0) === 2000, 'End Phase: take damage equal to the ATK gained');
});
T('Ancient Fusion', () => {
  const e = sd('Ancient Fusion', ['Ancient Gear Golem', 'Ancient Gear Soldier'], [], ['Ancient Gear Test Fusion']);
  e.state.fx.ignoreCond = grab(e, 0, 'Ancient Gear Golem').uid;
  place(e, 0, 'Ancient Gear Golem');
  check(use(e, 0) && fieldHas(e, 0, 'Ancient Gear Test Fusion') && gyHas(e, 0, 'Ancient Gear Soldier') && !can(e), 'Golem on the field: the other material from the Deck');
  check((e.state.fx.noDamage as number[])[1] === e.state.turn, 'the opponent takes no damage this turn');
});
T("Archfiend's Conscription", () => {
  const e = sd("Archfiend's Conscription", ['Darkbishop Archfiend', 'Archfiend Soldier']);
  check(e.player(0).skillRevealed && !e.canNormalSummon(0, e.player(0).hand[0]) && e.canNormalSummon(0, grab(e, 0, 'Archfiend Soldier')), 'cannot Summon/Set non-Fiends');
  e.state.fx.fixedRoll = { p: 0, die: 3 };
  check(use(e, 0, 'yes') && lp(e, 0) === 3400 && fieldHas(e, 0, 'Darkbishop Archfiend') && !can(e), 'roll 3: lose 600 LP, Special Summon a Level 3 Archfiend');
});
T('Beware the Brothers Paradox!', () => {
  const e = sd('Beware the Brothers Paradox!', ['Kazejin']);
  check(e.tributeNeed(0, grab(e, 0, 'Kazejin')) === 1, 'Level 7 monsters need 1 less Tribute');
  run(e, e.as(0, (function* () { e.damage(1, 500); })()));
  check(lp(e, 1) === 4000, 'the opponent takes no effect damage');
  place(e, 0, FILL);
  e.player(0).normalSummoned = true;
  check(e.canNormalSummon(0, grab(e, 0, 'Kazejin'), true), 'a Level 7 Tribute Summon in addition to the Normal Summon');
});
T('Blaze Accelerator Deployment (Skill Card)', () => {
  const e = sd('Blaze Accelerator Deployment (Skill Card)', ['Blaze Accelerator']);
  const b = putST(e, 0, 'Blaze Accelerator', true);
  check(use(e, 0) && e.isNamed(b, 'Tri-Blaze Accelerator') && b.name === 'Blaze Accelerator' && !can(e), 'Blaze Accelerator becomes "Tri-Blaze Accelerator" (once per turn)');
});
T('Catch of the Day', () => {
  const e = sd('Catch of the Day', ['The Legendary Fisherman', 'Umi', 'Mother Grizzly'], [FILL]);
  const f = place(e, 0, 'The Legendary Fisherman');
  toGY(e, 0, 'Mother Grizzly');
  check(use(e, 0) && e.player(0).field?.name === 'Umi' && !can(e), 'activate Umi from the Deck (once per Duel)');
  const o = place(e, 1, FILL, 'def');
  turnOf(e, 0);
  toBattle(e);
  attack(e, f, o, 'yes');
  check(fieldHas(e, 0, 'Mother Grizzly'), 'Fisherman destroys a monster: Special Summon a WATER monster in Defense Position');
});
T('Chemistry in Motion', () => {
  const e = sd('Chemistry in Motion', ['Kabazauls', 'Two-Headed King Rex']);
  grab(e, 0, 'Kabazauls');
  check(use(e, 0) && handHas(e, 0, 'Two-Headed King Rex') && gyHas(e, 0, 'Kabazauls') && e.skillCard(0)?.counters === 1, '1 counter: discard a Dinosaur, add one with a different Attribute');
  check(!can(e), 'once per turn');
});
T("Chillin' Outback", () => {
  const e = sd("Chillin' Outback", ['Des Koala']);
  const k = place(e, 0, 'Des Koala');
  check(use(e, 0) && k.pos === 'def' && !can(e), 'change a Koala\'s position (once per turn)');
  turnOf(e, 0);
  toBattle(e);
  check(e.canAttackWith(0, k), 'it can attack in face-up Defense Position');
  attack(e, k, null);
  check(lp(e, 1) === 4000 - 1800, 'its DEF is used for damage');
});
T('Cloudy Skies of Grey', () => {
  const e = sd('Cloudy Skies of Grey', ['Cloudian - Smoke Ball']);
  const c = place(e, 0, 'Cloudian - Smoke Ball');
  const g = place(e, 0, FILL);
  (c.tags ??= {}).fog = 2;
  run(e, (function* () {})());
  kill(e, [c], 1);
  check((g.tags?.fog ?? 0) === 2, 'its Fog Counters move to another face-up monster');
});
T('Consumed By Darkness', () => {
  const e = sd('Consumed By Darkness', ['Crystal Beast Ruby Carbuncle']);
  const r = place(e, 0, 'Crystal Beast Ruby Carbuncle');
  run(e, (function* () {})());
  check((e.state.fx.declAttr as Record<number, string>)?.[r.uid] === 'DARK', '"Crystal Beast" monsters are DARK');
});
T('Crystal Transcendence', () => {
  const e = sd('Crystal Transcendence', ['Crystal Beast Ruby Carbuncle', 'Crystal Beast Amethyst Cat']);
  check(use(e, 0, { pick: [FILL, FILL] }) && e.spells(0).filter((c) => c.name.includes('Crystal Beast')).length === 2, 'send 2 from hand: place 2 Crystal Beasts as Continuous Spells');
  check(!e.canNormalSummon(0, e.player(0).hand[0]), 'only "Crystal" and Dragon monsters can be Summoned');
  check(!can(e), 'once per turn');
});
T('Delicious Morsel!', () => {
  const e = sd('Delicious Morsel!', ['Vampire Lady']);
  const v = place(e, 0, 'Vampire Lady');
  turnOf(e, 0);
  toBattle(e);
  attack(e, v, null);
  endTurn(e);
  check(lp(e, 0) === 4000 + 775, 'End Phase: gain half the battle damage');
});
T('Dino Destruction', () => {
  const e = sd('Dino Destruction', ['Black Tyranno'], [FILL]);
  const t = place(e, 0, 'Black Tyranno');
  const o = place(e, 1, FILL, 'def');
  turnOf(e, 0);
  check(use(e, 0) && !can(e), 'choose a Level 6+ Dinosaur (once per turn)');
  toBattle(e);
  attack(e, t, o);
  check(lp(e, 1) === 4000 - (2600 - 1200), 'it inflicts piercing damage');
});
T('Dragon Force', () => {
  const e = sd('Dragon Force', ['Blue-Eyes White Dragon', 'Koumori Dragon'], [FILL]);
  toGY(e, 0, 'Blue-Eyes White Dragon');
  const k = place(e, 0, 'Koumori Dragon');
  const o = place(e, 1, FILL, 'def');
  turnOf(e, 0);
  check(use(e, 0) && e.atkOf(k) === 1500 + 1600 && !can(e), 'banish a Level 8 Dragon Normal: +1600 ATK');
  toBattle(e);
  attack(e, k, o);
  check(lp(e, 1) === 4000 - (3100 - 1200), 'piercing damage this turn');
});
T('Ectoplasmic Fortification!', () => {
  const e = sd('Ectoplasmic Fortification!', ['Vampire Lady']);
  const v = place(e, 0, 'Vampire Lady');
  check(use(e, 0) && e.atkOf(v) === 1650 && e.defOf(v) === 1450 && !can(e), 'a counter: Zombies +100 ATK / -100 DEF');
});
T('Elements of Thunder, Water, and Wind', () => {
  const e = sd('Elements of Thunder, Water, and Wind', ['Suijin']);
  const s = grab(e, 0, 'Suijin');
  check(!can(e), 'needs 1000 or less LP');
  e.player(0).lp = 1000;
  check(use(e, 0) && e.tributeNeed(0, s) === 0, 'Suijin/Kazejin/Sanga can be Normal Summoned without Tributing this turn');
});
T('Energizing Elements', () => {
  const e = sd('Energizing Elements', ['Elemental HERO Burstinatrix']);
  const b = place(e, 0, 'Elemental HERO Burstinatrix');
  check(use(e, 0, { pick: ['FIRE'] }) && e.atkOf(b) === 1700 && e.defOf(b) === 400 && !can(e), 'declared FIRE: +500 ATK / -400 DEF');
});
T('Fog Warning', () => {
  const e = sd('Fog Warning');
  const m = place(e, 0, FILL);
  (m.tags ??= {}).fog = 1;
  run(e, (function* () {})());
  check(m.tags?.fog === 2, 'an additional Fog Counter');
});
T('Forbidden Cyber Style Technique', () => {
  const e = sd('Forbidden Cyber Style Technique', ['Cyber Phoenix', 'Proto-Cyber Dragon']);
  check(!can(e), 'needs 1500 or less LP');
  e.player(0).lp = 1500;
  check(use(e, 0, { pick: ['Cyber Phoenix', 'Proto-Cyber Dragon'] }) && lp(e, 0) === 50 && e.monsters(0).length === 2 && e.monsters(0).every((m) => e.isNamed(m, 'Cyber Dragon')), 'LP to 50; Special Summon Cyber monsters as "Cyber Dragon"');
  check(!e.canNormalSummon(0, e.player(0).hand[0]), 'cannot Summon except by Fusion this turn');
  endTurn(e);
  check(e.monsters(0).length === 0, 'destroyed in the End Phase');
});
T('Forged Steel', () => {
  const e = sd('Forged Steel', ['Koumori Dragon']);
  const k = place(e, 0, 'Koumori Dragon');
  check(use(e, 0) && e.isNamed(k, 'Red-Eyes Black Dragon'), 'a Dragon Normal Monster becomes "Red-Eyes Black Dragon"');
  check(!can(e), 'once per Duel');
});
T('Grit', () => {
  const e = sd('Grit');
  e.state.fx.fixedRoll = { p: 0, die: 1 };
  check(use(e, 0, { pick: ['1', '2'] }) && !can(e), 'call 2 numbers, roll (once per Duel)');
  e.damage(0, 5000);
  check(lp(e, 0) === 1, 'LP do not drop below 1');
});
T('Guardians of the Tomb', () => {
  const e = sd('Guardians of the Tomb', ['Dark Elf', 'Trap Hole']);
  endTurn(e);
  const ps = e.player(0);
  for (const c of ps.hand.slice()) e.toDeckTop(c.uid);
  const d = ps.deck.find((c) => c.name === 'Dark Elf')!;
  (e.state.fx.trapMonster ??= {})[d.uid] = 1;
  ps.deck.splice(ps.deck.indexOf(d), 1);
  ps.deck.unshift(ps.deck.splice(ps.deck.findIndex((c) => c.name === 'Trap Hole'), 1)[0]);
  ps.hand.push(d);
  ps.hand.pop();
  ps.deck.splice(1, 0, d);
  run(e, e.specialSummon(d.uid, 0, 'def'), 'yes', 'yes');
  check(ps.hand.length === 0 && e.spells(0).some((c) => c.name === 'Trap Hole' && !c.faceUp), "opponent's turn, no hand: draw 1 and Set it");
});
T('Heavy Metal Raiders (Skill Card)', () => {
  const e = sd('Heavy Metal Raiders (Skill Card)', ['Cyberdark Horn'], ['Dark Elf']);
  const h = place(e, 0, 'Cyberdark Horn');
  const o = place(e, 1, 'Dark Elf');
  endTurn(e);
  toBattle(e);
  attack(e, o, h);
  check(zone(e, h) === 'mz' && e.atkOf(h) === 800 + 1200, 'not destroyed by battle the first time; gains the battle damage as ATK');
});
T('Here Goes Something!', () => {
  const e = sd('Here Goes Something!', ['Elemental HERO Neos'], [FILL, 'Dark Elf']);
  const n = place(e, 0, 'Elemental HERO Neos');
  const a = place(e, 1, FILL);
  const b = place(e, 1, 'Dark Elf');
  turnOf(e, 0);
  check(!can(e), 'only at the start of the Battle Phase');
  toBattle(e);
  check(use(e, 0) && !can(e), 'activated (once per Duel)');
  attack(e, n, a);
  check(lp(e, 1) === 4000 - (3300 - 1400) && zone(e, a) === 'gy', '+800 ATK while battling');
  check(e.canAttackWith(0, n), 'can attack every opponent monster once each');
  attack(e, n, b);
  check(zone(e, b) === 'gy' && !e.canAttackWith(0, n), 'second monster attacked, then no more attacks');
});
T('Hidden Parasite', () => {
  const e = sd('Hidden Parasite', [], ['Dark Elf']);
  const m = place(e, 0, FILL);
  const o = place(e, 1, 'Dark Elf');
  check(use(e, 0) && e.raceOf(m) === 'Insect' && e.raceOf(o) === 'Insect' && !can(e), 'all monsters become Insect (once per turn)');
  endTurn(e);
  check(e.raceOf(m) === 'Warrior', 'until the end of the turn');
});
T("I'm Just Gonna Attack!", () => {
  const e = sd("I'm Just Gonna Attack!");
  const m = place(e, 0, FILL);
  check(use(e, 0) && e.atkOf(m) === 1500 && !can(e), '+100 ATK, once per Duel');
});
T('Inner Conflict', () => {
  const e = sd('Inner Conflict', [], ['Dark Elf']);
  const o = place(e, 1, 'Dark Elf');
  check(use(e, 0) && e.controller(o.uid) === 0 && lp(e, 0) === 2000 && !can(e), 'pay half: take control');
  endTurn(e);
  check(e.controller(o.uid) === 1, 'returned in the End Phase');
});
T("It's My Lucky Day!", () => {
  const e = sd("It's My Lucky Day!");
  check(use(e, 0, { pick: ['6'] }) && lp(e, 0) === 3000 && !can(e), 'pay 1000 (once per Duel)');
  let n = 0;
  run(e, e.as(0, (function* () { n = e.roll(6); })()));
  check(n === 6, 'decides the die result');
});
T('Knight of Legend', () => {
  const e = sd('Knight of Legend', ['Gaia The Fierce Knight', 'Trap Hole']);
  const g = grab(e, 0, 'Gaia The Fierce Knight');
  check(use(e, 0) && e.tributeNeed(0, g) === 0, 'Gaia can be Normal Summoned without Tributing');
  const t = putST(e, 0, 'Trap Hole');
  place(e, 0, 'Gaia The Fierce Knight');
  const before = e.state.log.length;
  act(e, 0, t.uid);
  check(!e.fieldCard(t.uid)?.faceUp && !logHas(e, 'activates Trap Hole', before), 'cannot activate Set cards while you control Gaia');
});
T('Looking into the Future', () => {
  const e = sd('Looking into the Future', ['Dark Elf', 'Pot of Greed', 'Trap Hole']);
  check(use(e, 0, { pick: ['Trap Hole'] }) && e.player(0).deck[0].name === 'Trap Hole', 'reorder the top 3 cards');
  const p = grab(e, 0, 'Pot of Greed');
  act(e, 0, p.uid);
  check(zone(e, p) === 'hand', 'no Spell activations this turn');
});
T('Middle Age Mechs (Skill Card)', () => {
  const e = sd('Middle Age Mechs (Skill Card)', ['Ancient Gear Soldier', 'Ancient Gear Golem']);
  const s = grab(e, 0, 'Ancient Gear Soldier');
  e.apply({ type: 'SUMMON', player: 0, uid: s.uid, zone: 0, pos: 'atk', faceUp: true });
  settle(e);
  check(e.atkOf(e.fieldCard(s.uid)!) === 1600, '"Ancient Gear" monsters +300 ATK');
  check(e.skillCard(0)?.counters === 1, 'a counter for each Normal Summon');
});
T('No More Mrs. Nice Mai!', () => {
  const e = sd('No More Mrs. Nice Mai!', ['Harpie Lady'], ['Blaze Accelerator']);
  const h = place(e, 0, 'Harpie Lady');
  turnOf(e, 0);
  const s = putST(e, 1, 'Blaze Accelerator', true);
  toBattle(e);
  attack(e, h, null);
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  settle(e, 'yes');
  check(zone(e, s) === 'gy', 'end of the Battle Phase after battle damage: destroy a Spell/Trap');
});
T('No One Suspects the Dark Scorpion Gang!', () => {
  const e = sd('No One Suspects the Dark Scorpion Gang!', ['Don Zaloog', 'Dark Scorpion - Chick the Yellow', 'Dark Scorpion - Meanae the Thorn'], [FILL]);
  check(!e.canNormalSummon(0, e.player(0).hand[0]), 'cannot Summon non-gang monsters');
  const d = place(e, 0, 'Don Zaloog');
  grab(e, 0, 'Dark Scorpion - Chick the Yellow');
  check(use(e, 0) && e.monsters(0).length === 3, 'discard 1: Special Summon 2 Dark Scorpions (hand + Deck)');
  place(e, 1, FILL);
  turnOf(e, 0);
  toBattle(e);
  attack(e, d, null);
  check(lp(e, 1) === 3600, 'direct attack through monsters: 400 damage');
});
T('Order of the Queen', () => {
  const e = sd('Order of the Queen', ['Amazoness Queen', 'Amazoness Fighter'], ['Sangan']);
  place(e, 0, 'Amazoness Queen');
  const a = place(e, 0, 'Amazoness Fighter');
  const s = place(e, 1, 'Sangan');
  turnOf(e, 0);
  toBattle(e);
  const n = e.player(1).hand.length;
  const unused = attack(e, a, s, 'yes');
  check(zone(e, s) === 'gy' && unused === 1 && e.player(1).hand.length === n, "the destroyed monster's effect is negated (Sangan does not trigger)");
});
T("Pal-O'Mine-zation!", () => {
  const e = sd("Pal-O'Mine-zation!", ['Elemental HERO Avian', 'Polymerization'], [], ['Elemental HERO Flame Wingman']);
  grab(e, 0, 'Elemental HERO Avian');
  check(use(e, 0) && !can(e), 'reveal a Normal Monster (once per Duel)');
  const p = grab(e, 0, 'Polymerization');
  act(e, 0, p.uid);
  check(fieldHas(e, 0, 'Elemental HERO Flame Wingman'), 'it substitutes for a Fusion Material');
});
T('Power of Friendship', () => {
  const e = sd('Power of Friendship');
  run(e, e.as(1, (function* () { e.damage(0, 500); })()));
  check(lp(e, 0) === 4000, "no effect damage from the opponent's cards during your turn");
  endTurn(e);
  run(e, e.as(1, (function* () { e.damage(0, 500); })()));
  check(lp(e, 0) === 3500, "the opponent's turn: damage applies");
});
T('Powerful Group of Guys', () => {
  const e = sd('Powerful Group of Guys', ['Destiny HERO - Dasher', 'Destiny HERO - Diamond Dude'], [FILL, FILL]);
  place(e, 0, 'Destiny HERO - Dasher');
  check(!can(e), 'needs the opponent to control more monsters');
  place(e, 1, FILL);
  place(e, 1, FILL);
  check(use(e, 0) && fieldHas(e, 0, 'Destiny HERO - Diamond Dude'), 'Special Summon a lower-Level Destiny HERO');
  check(!e.canNormalSummon(0, e.player(0).hand[0]), 'only Destiny HEROes this turn');
});
T('Professor of Alchemy', () => {
  const e = sd('Professor of Alchemy');
  check(use(e, 0) && e.player(0).removed.length === 1 && fieldHas(e, 0, 'Alchemy Beast Token') && !can(e), 'banish a Level 4: an Alchemy Beast Token');
  const t = mon(e, 0, 'Alchemy Beast Token');
  check(e.untributable(t), 'the token cannot be Tributed');
});
T('Rainbow Crystal Collection', () => {
  const e = sd('Rainbow Crystal Collection', ['Crystal Beast Ruby Carbuncle']);
  const r = place(e, 0, 'Crystal Beast Ruby Carbuncle');
  kill(e, [r], 1, 'yes');
  check(zone(e, r) === 'sz', 'not destroyed: it becomes a Continuous Spell with a Crystallization Counter');
});
T('Ritual of Black Mastery', () => {
  const e = sd('Ritual of Black Mastery', ['Magician of Black Chaos']);
  check(!can(e), 'needs a Ritual Summoned BLS/MoBC');
  const m = place(e, 0, 'Magician of Black Chaos');
  (e.state.fx.ritualMats ??= {})[m.uid] = { mats: [], turn: e.state.turn };
  check(use(e, 0) && !can(e), 'activates (once)');
});
T('Royal Flush', () => {
  const e = sd('Royal Flush', ["Queen's Knight", "King's Knight"]);
  place(e, 0, "Queen's Knight");
  grab(e, 0, "King's Knight");
  e.player(0).normalSummoned = true;
  check(use(e, 0) && fieldHas(e, 0, "King's Knight") && lp(e, 0) === 3000 && !can(e), "pay 1000: Normal Summon King's Knight in addition");
});
T('Spell Proof Armor', () => {
  const e = sd('Spell Proof Armor', ['Cyber Soldier']);
  check(use(e, 0) && e.tributeNeed(0, grab(e, 0, 'Cyber Soldier')) === 0, 'Machine Normal Monsters need 1 less Tribute');
  toGY(e, 0, FILL);
  check(!e.player(0).skillRevealed, 'flips over once a non-Machine is in the GY');
});
T('Terror from the Deep!', () => {
  const e = sd('Terror from the Deep!', ['Kairyu-Shin', 'Umi']);
  const k = place(e, 0, 'Kairyu-Shin');
  check(use(e, 0, 'yes') && e.player(0).field?.name === 'Umi', 'activate Umi from the Deck');
  const n = e.player(0).hand.length;
  kill(e, [k], 1);
  check(e.player(0).hand.length === n + 2, 'Kairyu-Shin leaves the field: draw 2');
});
T('The Roids are Alright', () => {
  const e = sd('The Roids are Alright', ['Rescueroid', 'Steamroid'], [FILL]);
  check(e.tributeNeed(0, grab(e, 0, 'Rescueroid')) === 0, '"roid" monsters of Level 6 or lower need no Tribute');
  const s = place(e, 0, 'Steamroid');
  const o = place(e, 1, FILL);
  turnOf(e, 0);
  toBattle(e);
  attack(e, s, o);
  check(zone(e, o) === 'gy' && lp(e, 1) === 4000 - (1800 + 400 + 500 - 1400), 'attacking a monster: +Level x 100 ATK');
});
T('Toon Mayhem!', () => {
  const e = sd('Toon Mayhem!', ['Toon World']);
  const t = putST(e, 0, 'Toon World', true);
  kill(e, [t], 1);
  check(zone(e, t) === 'sz', 'Toon World is not destroyed the first time');
  kill(e, [t], 1);
  check(zone(e, t) === 'gy', 'the second time it is');
});
T('Unlocking the Power', () => {
  const e = sd('Unlocking the Power', ['Uria, Lord of Searing Flames', 'Archfiend Soldier', 'Toon World', 'Sangan']);
  grab(e, 0, 'Uria, Lord of Searing Flames');
  place(e, 0, 'Archfiend Soldier');
  place(e, 0, 'Sangan');
  putST(e, 0, 'Toon World', true);
  check(use(e, 0) && fieldHas(e, 0, 'Uria, Lord of Searing Flames'), 'Fiends and Continuous Spells as the cost of Uria');
});
T('Vampiric Aristocracy', () => {
  const e = sd('Vampiric Aristocracy', ['Vampire Lady']);
  const v = place(e, 0, 'Vampire Lady');
  check(use(e, 0) && e.isNamed(v, 'Vampire Lord') && !can(e), 'a Zombie Vampire becomes "Vampire Lord" (once per Duel)');
  kill(e, [v], 1);
  check(e.player(0).gy.some((c) => c.name === 'Vampire Lady'), 'its name returns when it leaves the field');
});
T('Volcanic Cannon', () => {
  const e = sd('Volcanic Cannon', ['Tri-Blaze Accelerator', 'Volcanic Doomfire']);
  putST(e, 0, 'Tri-Blaze Accelerator', true);
  check(use(e, 0) && fieldHas(e, 0, 'Volcanic Doomfire') && !can(e), 'send Tri-Blaze: Special Summon Volcanic Doomfire');
  check((e.state.fx.noEffectDamage as number[])[1] === e.state.turn, 'no effect damage to the opponent this turn');
});
T('Welcome to the Jungle', () => {
  const e = sd('Welcome to the Jungle', ['Amazoness Tiger'], ['Dark Elf']);
  const a = place(e, 0, 'Amazoness Tiger');
  const o = place(e, 1, 'Dark Elf');
  endTurn(e);
  toBattle(e);
  const n = e.atkOf(a);
  attack(e, o, a);
  check(lp(e, 0) < 4000 && e.atkOf(o) === 2000 - n, "after battle damage: the opponent's monster loses the Amazoness's ATK");
});

// ======================================================================
// The 32 Skills from the 2024 products have their targeted checks in tests/skills-2024a.test.ts and skills-2024b.test.ts.
const EXTRA_2024 = new Set((JSON.parse(readFileSync('scripts/speed-skills-extra.json', 'utf8')) as { name: string }[]).map((s) => s.name));
const missing = ALL_SKILLS.filter((s) => !tested.has(s) && !EXTRA_2024.has(s));
check(missing.length === 0, `every Skill has a targeted check (${tested.size}; missing: ${missing.join(', ')})`);
console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
if (fails) process.exit(1);
