// skills-2024a: the Speed Duel: Battle City Finals Skills (run: npx tsx tests/skills-2024a.test.ts). Duel kit from tests/audit-skills.test.ts.
import { Engine } from '../src/eds/engine';
import type { Card, CardInfo, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';
import { aiAction } from '../src/eds/ai';
import { SKILLS, getSkill, PLAYABLE_SKILLS } from '../src/eds/skills';

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
  if (!ok && process.env.DBG && cur) console.log(cur.state.log.slice(-25).map((l) => '    ' + l.text).join('\n'));
};
let cur: Engine | null = null;
const FILL = 'Celtic Guardian';

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

const summon = (e: Engine, p: Pid, name: string, ...ans: Ans[]) => {
  const c = grab(e, p, name);
  e.apply({ type: 'SUMMON', player: p, uid: c.uid, zone: e.player(p).mz.findIndex((z) => z === null), pos: 'atk', faceUp: true });
  settle(e, ...ans);
  return e.fieldCard(c.uid);
};
const tag = (m: FieldCard) => (m.tags ??= {});
const bottom = (e: Engine, p: Pid) => e.player(p).deck[e.player(p).deck.length - 1]?.name;

T('Sky God Revelation', () => {
  let e = sd('Sky God Revelation', ['Slifer the Sky Dragon']);
  grab(e, 0, 'Slifer the Sky Dragon');
  const n = e.player(0).hand.length;
  check(use(e, 0) && bottom(e, 0) === 'Slifer the Sky Dragon' && e.player(0).hand.length === n, 'reveal Slifer, place it on the bottom of the Deck, draw 1');
  e = sd('Sky God Revelation', ['Slifer the Sky Dragon']);
  for (let i = 0; i < 3; i++) place(e, 0, FILL);
  const s = summon(e, 0, 'Slifer the Sky Dragon', 'yes', 'yes');
  check(!!s && e.player(0).hand.length === 6 && e.player(1).hand.length === 6, 'Normal Summoning a Level 10 ? ATK monster: each player draws up to 6');
});

T('Executive Privilege', () => {
  const e = sd('Executive Privilege', ['Obelisk the Tormentor'], ['Mystical Elf', 'Kuriboh']);
  turnOf(e, 0);
  const o = place(e, 0, 'Obelisk the Tormentor');
  const a = place(e, 1, 'Mystical Elf', 'def');
  const b = place(e, 1, 'Kuriboh', 'def');
  toBattle(e);
  attack(e, o, a);
  attack(e, o, b);
  check(zone(e, a) === 'gy' && zone(e, b) === 'gy', 'Obelisk attacks every monster the opponent controls');
  check(!e.canAttackWith(0, o), 'once each (no further attack)');
});

T('Battle City Slugger', () => {
  const e = sd('Battle City Slugger', ['Gilford the Lightning']);
  const a = place(e, 0, FILL);
  place(e, 0, FILL);
  check(e.atkOf(a) === 1600, 'Warriors gain 100 ATK for each Warrior you control');
  check(use(e, 0) && handHas(e, 0, 'Gilford the Lightning'), 'discard 1, add "Gilford the Lightning"');
  e.player(0).normalSummoned = true;
  check(e.canNormalSummon(0, grab(e, 0, 'Gilford the Lightning'), true), 'may Tribute Summon a Warrior in addition to the Normal Summon');
});

T('Advent of Ra', () => {
  const e = sd('Advent of Ra', ['The Winged Dragon of Ra', 'Blue-Eyes White Dragon', 'Summoned Skull', 'Archfiend Soldier']);
  place(e, 0, 'Blue-Eyes White Dragon');
  place(e, 0, 'Summoned Skull');
  place(e, 0, 'Archfiend Soldier');
  const ra = summon(e, 0, 'The Winged Dragon of Ra', 'no');
  check(!!ra && e.atkOf(ra) === 7400 && e.defOf(ra) === 5200, `Ra's original ATK/DEF = the Tributes' combined (${ra && e.atkOf(ra)}/${ra && e.defOf(ra)})`);
});

T('Fear of the Dark', () => {
  const e = sd('Fear of the Dark', ['Destiny Board', 'Spirit Message "I"', 'Spirit Message "N"', 'Spirit Message "A"', 'Spirit Message "L"', 'Dark Necrofear'], ['Vorse Raider']);
  const board = putST(e, 0, 'Destiny Board', true);
  putST(e, 0, 'Spirit Message "I"', true);
  putST(e, 0, 'Spirit Message "N"', true);
  const nf = place(e, 0, 'Dark Necrofear');
  kill(e, [board], 1);
  check(!!e.fieldCard(board.uid), 'with Dark Necrofear, Destiny Board is unaffected by the opponent\'s effects');
  run(e, e.sendToGrave(nf.uid, 'cost'));
  endTurn(e);
  endTurn(e, 'yes'); // the opponent's End Phase (turn 2): "A" is Special Summoned as a monster
  const a = e.monsters(0).find((m) => m.name === 'Spirit Message "A"');
  check(!!a && e.raceOf(a) === 'Fiend' && e.atkOf(a) === 0, '"Spirit Message A" is Special Summoned as a Fiend Normal Monster');
  endTurn(e);
  const v = place(e, 1, 'Vorse Raider');
  toBattle(e);
  check(e.legalTargets(1, v).length === 0 && e.canAttackDirectly(v), 'it cannot be attacked, but the opponent can attack directly');
  endTurn(e, 'yes');
  check(e.state.winner === 0, 'Destiny Board + Fear of the Dark wins the Duel (F-I-N-A-L)');
});

T('As I Predicted...!', () => {
  const e = sd('As I Predicted...!', ['Dark Elf', 'Gemini Elf', 'Exchange of the Spirit']);
  turnOf(e, 0, 'yes', { pick: ['Gemini Elf'] });
  check(handHas(e, 0, 'Gemini Elf') && gyHas(e, 0, 'Dark Elf'), 'look at the top 2: add 1, the other to the GY');
  const m = place(e, 0, FILL);
  toBattle(e);
  check(!e.canAttackWith(0, m), 'the Battle Phase is skipped');
  toGY(e, 0, ...Array(15).fill(FILL), 'Exchange of the Spirit');
  const x = e.player(0).gy.find((c) => c.name === 'Exchange of the Spirit')!;
  const deckBefore = e.player(0).deck.length;
  e.state.phase = 'M1';
  check(use(e, 0) && zone(e, x) === 'removed' && e.player(0).gy.length === deckBefore, 'banish Exchange of the Spirit from the GY: GY and Deck swap');
  const e2 = sd('As I Predicted...!', ['Exchange of the Spirit']);
  toGY(e2, 0, ...Array(15).fill(FILL));
  turnOf(e2, 0, 'no');
  const t = putST(e2, 0, 'Exchange of the Spirit');
  check(e2.player(1).gy.length < 15 && e2.canActivateMain(0, t.uid), 'only you need 15 cards in the GY to activate Exchange of the Spirit');
});

T('Royal Temple of the Kings', () => {
  const e = sd('Royal Temple of the Kings', ['Mystical Beast of Serket', 'Embodiment of Apophis']);
  check(e.player(0).field?.name === 'Royal Temple of the Kings', 'placed in the Field Zone');
  const s = place(e, 0, 'Mystical Beast of Serket');
  settle(e);
  check(!!e.fieldCard(s.uid), 'Serket is not destroyed by its own effect');
  const ap = grab(e, 0, 'Embodiment of Apophis');
  e.apply({ type: 'SET_ST', player: 0, uid: ap.uid, zone: e.player(0).sz.findIndex((z) => z === null) });
  settle(e);
  check(!e.canActivateMain(0, ap.uid), 'normally not the turn it was Set');
  check(use(e, 0) && lp(e, 0) === 3500 && e.canActivateMain(0, ap.uid), 'pay 500 LP: the Trap can be activated the turn it was Set');
  act(e, 0, ap.uid);
  check(fieldHas(e, 0, 'Embodiment of Apophis'), 'Embodiment of Apophis Special Summons itself');
});

T('Tribal Unity', () => {
  const e = sd('Tribal Unity', ['Harpie Lady', 'Amazoness Swords Woman', 'Dark Magician']);
  toGY(e, 0, 'Harpie Lady');
  const hl = e.player(0).gy.find((c) => c.name === 'Harpie Lady')!;
  const a = place(e, 0, 'Amazoness Swords Woman');
  check(e.nameHas(hl, 'Amazoness') && e.isNamed(hl, 'Harpie Lady') && e.nameHas(a, 'Harpie') && e.isNamed(a, 'Amazoness Swords Woman'), 'Harpie <-> Amazoness on the field and in the GY');
  grab(e, 0, 'Dark Magician');
  check(use(e, 0, { pick: ['Dark Magician'] }) && e.atkOf(a) === 1500 + 1400, 'discard a Level 7: +1400 ATK');
  // Only a card in a GY takes the slow path: name checks on cards elsewhere never ask the Skill.
  let asked = 0;
  const fx = (e as any).skillFx.bind(e);
  (e as any).skillFx = () => (asked++, fx());
  const inDeck = e.player(0).deck.find((c) => c.name === FILL)!;
  e.nameHas(inDeck, 'Amazoness');
  e.isNamed(inDeck, FILL);
  const deckAsks = asked;
  check(e.nameHas(hl, 'Amazoness') && asked > deckAsks && deckAsks === 0, 'name checks on cards outside the GY skip the Skill lookup');
});

T('Ever Faithful Companions', () => {
  const e = sd('Ever Faithful Companions', ['Dark Magician', 'Thousand Knives'], ['Vorse Raider']);
  place(e, 1, 'Vorse Raider');
  grab(e, 0, 'Dark Magician');
  check(use(e, 0) && fieldHas(e, 0, 'Dark Magician'), 'only the opponent controls a monster: Special Summon Dark Magician from the hand');
  check(use(e, 0) && handHas(e, 0, 'Thousand Knives'), 'controlling Dark Magician: add a card that mentions it');
  check(!can(e), 'each once');
});

T('Symbol of Pride', () => {
  const e = sd('Symbol of Pride', ['Blue-Eyes White Dragon', 'Pot of Greed', 'Blue-Eyes White Dragon'], ['Vorse Raider', 'Kuriboh']);
  const t = place(e, 0, FILL);
  tag(t).tribS = 1;
  check(e.tributeNeed(0, grab(e, 0, 'Blue-Eyes White Dragon')) === 1, 'Blue-Eyes can be Tribute Summoned with 1 Tribute Summoned monster');
  const b = place(e, 0, 'Blue-Eyes White Dragon');
  place(e, 1, 'Vorse Raider');
  place(e, 1, 'Kuriboh');
  grab(e, 0, 'Pot of Greed');
  check(use(e, 0) && e.monsters(1).length === 0 && gyHas(e, 0, 'Pot of Greed'), 'discard a Spell: destroy all monsters the opponent controls');
  check(getSkill('Symbol of Pride')!.mayAttack!(e, 0, b) === false, 'Blue-Eyes cannot attack this turn');
});
T('Red-Eye Inferno', () => {
  const e = sd('Red-Eye Inferno', ['Red-Eyes Black Dragon', 'Pot of Greed'], ['Vorse Raider', 'Kuriboh']);
  place(e, 1, 'Vorse Raider');
  place(e, 1, 'Kuriboh');
  check(e.tributeNeed(0, grab(e, 0, 'Red-Eyes Black Dragon')) === 0, 'Red-Eyes needs 1 less Tribute for each opponent monster');
  place(e, 0, 'Red-Eyes Black Dragon');
  grab(e, 0, 'Pot of Greed');
  check(use(e, 0) && lp(e, 1) === 3200, 'discard a Spell: 800 damage');
});

T('Pulling the Strings', () => {
  const e = sd('Pulling the Strings');
  const m = place(e, 0, FILL);
  check(use(e, 0) && e.controller(m.uid) === 1 && e.untributable(m), 'give control of a monster to the opponent; it cannot be Tributed');
  endTurn(e);
  endTurn(e, 'yes');
  check(zone(e, m) === 'gy' && lp(e, 1) === 3500, "opponent's End Phase: destroy it, 500 damage");
});

T('Malevolence of the Millennium Ring', () => {
  const e = sd('Malevolence of the Millennium Ring', ['Archfiend Soldier', 'Summoned Skull']);
  place(e, 0, 'Archfiend Soldier');
  check(use(e, 0) && gyHas(e, 0, 'Summoned Skull') && lp(e, 0) === 4000 - 1200, 'send a Fiend from the Deck to the GY, lose Level x 200 LP');
});

T('Keeper of the Valley', () => {
  const e = sd('Keeper of the Valley', ['Rite of Spirit'], [FILL]);
  toGY(e, 0, 'Rite of Spirit');
  toGY(e, 1, FILL);
  e.placeSkillCard('Necrovalley', 1, 'field');
  check(!e.graveLocked(e.player(0).gy[0].uid) && e.graveLocked(e.player(1).gy[0].uid), 'your GY is unaffected by Necrovalley');
  check(use(e, 0) && handHas(e, 0, 'Rite of Spirit'), 'discard 1: add a Spell/Trap that mentions "Necrovalley" from the GY');
});

T('Deserts Peril', () => {
  const e = sd('Deserts Peril', ['Dark Elf', 'Gemini Elf']);
  const a = place(e, 0, 'Dark Elf');
  const b = place(e, 0, 'Gemini Elf');
  check(use(e, 0, 'no') && !a.faceUp && !b.faceUp && a.pos === 'def', 'flip all your monsters face-down and shuffle them');
  turnOf(e, 0);
  check(use(e, 0, 'yes') && e.monsters(0).filter((m) => m.faceUp).length === 1, 'twice per Duel; then change the position of 1 monster (flipped face-up)');
  turnOf(e, 0);
  check(!can(e), 'not a third time');
});

T("Harpie's Kaleidoscope", () => {
  const e = sd("Harpie's Kaleidoscope", ['Harpie Lady Sisters', 'Harpie Lady', 'Birdface'], ['Vorse Raider']);
  place(e, 0, 'Harpie Lady Sisters');
  toGY(e, 0, 'Harpie Lady', 'Birdface');
  const v = place(e, 1, 'Vorse Raider');
  check(use(e, 0) && zone(e, v) === 'hand' && !gyHas(e, 0, 'Harpie Lady') && !gyHas(e, 0, 'Birdface'), '2 WIND Winged Beasts to the Deck bottom: return an opponent monster');
});

T('See Me Rolling', () => {
  const e = sd('See Me Rolling', ['Graceful Dice']);
  const u = use(e, 0, { pick: [FILL] });
  check(u && handHas(e, 0, 'Graceful Dice') && e.player(0).hand.length === 4, 'add a die card, place 1 card on the bottom of the Deck');
  // The re-roll is asked ("you may re-roll"), only of the Skill's owner, once per turn.
  const seq = [0, 0.99, 0.99, 0, 0];
  (e as any).rand = () => seq.shift() ?? 0;
  let got = 0;
  const roll = (p: Pid, ...ans: Ans[]) => {
    got = 0;
    const titles: string[] = [];
    (e as any).run((function* () {
      got = yield* e.rollDie(p, (v) => v >= 4);
    })());
    if (e.state.prompt?.kind === 'yesno') titles.push(e.state.prompt.title);
    settle(e, ...ans);
    return titles;
  };
  const t1 = roll(0, 'no');
  check(t1[0] === 'See Me Rolling: re-roll the 1?' && got === 1, 'a 1: asked whether to re-roll; declining keeps the 1');
  const t2 = roll(1);
  check(t2.length === 0 && got === 6, "the opponent's roll: no question");
  const t3 = roll(0, 'yes');
  check(t3.length === 1 && got === 1, 'any result may be re-rolled: yes re-rolls the 6 (into a 1)');
  const t4 = roll(0);
  check(t4.length === 0 && got === 1, 'once per turn');
  // The computer re-rolls only a result that is bad for the effect being resolved.
  const e2 = sd('See Me Rolling', ['Graceful Dice']);
  const seq2 = [0.99, 0];
  (e2 as any).rand = () => seq2.shift() ?? 0;
  (e2 as any).run((function* () {
    yield* e2.rollDie(0, (v) => v >= 4);
  })());
  check(e2.state.prompt?.kind === 'yesno' && aiAction(e2, 0)?.type === 'NO', 'computer: a 6 for Graceful Dice is kept');
  settle(e2, 'no');
  const e3 = sd('See Me Rolling', ['Graceful Dice']);
  (e3 as any).rand = () => 0;
  (e3 as any).run((function* () {
    yield* e3.rollDie(0, (v) => v >= 4);
  })());
  check(e3.state.prompt?.kind === 'yesno' && aiAction(e3, 0)?.type === 'YES', 'computer: a 1 for Graceful Dice is re-rolled');
  settle(e3, 'no');
  // In a duel: Graceful Dice asks its activator.
  const e4 = sd('See Me Rolling', ['Graceful Dice', 'Vorse Raider']);
  const v = place(e4, 0, 'Vorse Raider');
  const seq4 = [0, 0.99];
  (e4 as any).rand = () => seq4.shift() ?? 0;
  const gd = grab(e4, 0, 'Graceful Dice');
  act(e4, 0, gd.uid, 'yes');
  check(logHas(e4, 'See Me Rolling') && e4.atkOf(v) === 1900 + 600, 'Graceful Dice: the 1 is re-rolled on request (a 6: +600 ATK)');
});

T('Battle City Bestie', () => {
  const e = sd('Battle City Bestie', ['Vorse Raider', FILL], ['Dark Elf', 'Trap Hole']);
  turnOf(e, 0);
  const m = place(e, 0, FILL);
  const d = place(e, 1, 'Dark Elf');
  toBattle(e);
  attack(e, m, d);
  check(lp(e, 0) === 4000, 'no battle damage during your turn');
  const e2 = sd('Battle City Bestie', ['Vorse Raider'], ['Trap Hole']);
  putST(e2, 1, 'Trap Hole');
  summon(e2, 0, 'Vorse Raider', { respond: 'Trap Hole' });
  const n = e2.player(0).hand.length;
  check(gyHas(e2, 1, 'Trap Hole'), '(the opponent activated Trap Hole)');
  endTurn(e2);
  check(e2.player(0).hand.length === n + 1 && logHas(e2, 'Battle City Bestie'), 'End Phase: draw 1 if the opponent activated a card');
});

T('Even the Odds', () => {
  const e = sd('Even the Odds', ['Pot of Greed'], ['Vorse Raider', 'Kuriboh', 'Dark Elf']);
  check(!can(e), 'not unless the opponent controls exactly 3 cards');
  place(e, 1, 'Vorse Raider');
  place(e, 1, 'Kuriboh');
  place(e, 1, 'Dark Elf');
  check(use(e, 0, { pick: ['Pot of Greed'] }, { pick: [FILL] }) && handHas(e, 0, 'Pot of Greed') && bottom(e, 0) === FILL, 'add any card, place 1 on the bottom');
});

T("Noah's Arc", () => {
  const e = sd("Noah's Arc", ["Shinato's Ark", 'Asura Priest', 'Hino-Kagu-Tsuchi']);
  check(use(e, 0, { pick: ['Add "Shinato'] }, { pick: ["Shinato's Ark"] }, { pick: [FILL] }) && handHas(e, 0, "Shinato's Ark"), 'add "Shinato\'s Ark", place 1 card on the bottom');
  toGY(e, 0, 'Asura Priest');
  place(e, 0, 'Hino-Kagu-Tsuchi');
  check(use(e, 0) && handHas(e, 0, 'Asura Priest'), 'with a Level 5+ Spirit: add a Spirit from the GY');
  const e2 = sd("Noah's Arc", ['Asura Priest', 'Dark Elf']);
  summon(e2, 0, 'Asura Priest');
  turnOf(e2, 0);
  check(handHas(e2, 0, 'Asura Priest'), '(Asura Priest returned to the hand)');
  summon(e2, 0, 'Dark Elf');
  check(use(e2, 0) && fieldHas(e2, 0, 'Asura Priest'), 'Normal Summon the same Spirit again in addition to the Normal Summon');
});

console.log(`\n${fails ? fails + ' FAILED' : 'all passed'}`);
process.exit(fails ? 1 : 0);
