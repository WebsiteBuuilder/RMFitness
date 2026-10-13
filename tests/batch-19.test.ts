// Speed Duel card scripts, batch 19: Synchro and Link Monsters (run: npx tsx tests/batch-19.test.ts)
// One targeted check per card: its main effect really happens in a duel.
import { Engine } from '../src/eds/engine';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';
import { getEffect } from '../src/eds/effects';

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};
const FILL = 'Celtic Guardian';

// ---------- duel kit ----------
type Ans = 'yes' | 'no' | 'pass' | { pick: string[] } | { respond: string };
/** Answers every pending prompt: planned answers first (in order), then pass / no / the first options. Returns how many planned answers were not used. */
function settle(e: Engine, ...ans: Ans[]): number {
  const q = [...ans];
  for (let i = 0; i < 400 && e.state.prompt && e.state.winner === null; i++) {
    const pr = e.state.prompt;
    const h = q[0];
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
        const k = pr.options.findIndex((o, j) => o.label === l && !picks.includes(j));
        if (k >= 0) picks.push(k);
      }
      e.apply({ type: 'CHOOSE', player: pr.player, picks });
    } else e.apply({ type: 'CHOOSE', player: pr.player, picks: pr.options.map((_, j) => j).slice(0, Math.max(1, pr.min)) });
  }
  return q.length;
}
function duel(d0: string[], d1: string[] = [], x0: string[] = [], x1: string[] = [], first: Pid = 0): Engine {
  const e = new Engine(DB);
  e.shuffle = <T,>(a: T[]) => a.slice();
  const pad = (d: string[]) => [...Array(4).fill(FILL), ...d, ...Array(Math.max(0, 30 - d.length)).fill(FILL)];
  e.apply({ type: 'START', first, seed: 1, names: ['A', 'B'], decks: [pad(d0), pad(d1)], fusions: [x0, x1], mode: 'speed', skills: [null, null] });
  settle(e);
  return e;
}
const run = (e: Engine, step: Generator<any, any, any>, ...ans: Ans[]) => {
  (e as any).run(step);
  return settle(e, ...ans);
};
const zone = (e: Engine, c: Card | null | undefined) => (c ? e.find(c.uid)?.loc.zone : undefined);
/** Moves a card of `p` (deck, GY, banished or hand) into the hand. */
function grab(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.hand, ...ps.deck, ...ps.gy, ...ps.removed].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  if (zone(e, c) !== 'hand') e.toHandOf(c.uid, p);
  return c;
}
/** Special Summons a card of `p` from wherever it is (Extra Deck included). Null when it did not arrive. */
function place(e: Engine, p: Pid, name: string, pos: Pos = 'atk', faceUp = true, ...ans: Ans[]): FieldCard | null {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.gy, ...ps.fusion, ...ps.hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.specialSummon(c.uid, p, pos, faceUp), ...ans);
  const f = e.fieldCard(c.uid);
  if (f && !faceUp) f.placedTurn = -1;
  return f;
}

const proc = (e: Engine, p: Pid, name: string, ...ans: Ans[]) => {
  const c = e.player(p).fusion.find((x) => x.name === name)!;
  const can = e.canSpecialProc(p, c);
  if (can) {
    e.apply({ type: 'SPECIAL', player: p, uid: c.uid });
    settle(e, ...ans);
  }
  return { can, fc: e.fieldCard(c.uid) };
};
const toMain = (e: Engine) => {
  while (e.state.phase !== 'M1') (e.apply({ type: 'NEXT_PHASE', player: e.state.turnPlayer }), settle(e));
};

const mine = (e: Engine, p: Pid, name: string) => e.monsters(p).find((m) => m.name === name) ?? null;
/** Synchro Summons `name` from the Extra Deck with these monsters (Engine.extraSummon, as the procedure does). */
const synchro = (e: Engine, p: Pid, name: string, mats: (FieldCard | null)[], ...ans: Ans[]) => {
  const c = e.player(p).fusion.find((x) => x.name === name)!;
  run(e, e.extraSummon(p, c.uid, mats.map((m) => m!.uid), 'Synchro'), ...ans);
  return e.fieldCard(c.uid);
};
const effect = (e: Engine, p: Pid, m: FieldCard | null, ...ans: Ans[]) => {
  check(!!m && e.canUseMonsterEffect(p, m), `${m?.name ?? '?'}: its effect can be used`);
  e.apply({ type: 'MONSTER_EFFECT', player: p, uid: m!.uid });
  settle(e, ...ans);
};
/** Passes phases until it is `p`'s `phase`. */
const toPhase = (e: Engine, p: Pid, phase: string) => {
  for (let i = 0; i < 40 && !(e.state.turnPlayer === p && e.state.phase === phase); i++) (e.apply({ type: 'NEXT_PHASE', player: e.state.turnPlayer }), settle(e));
};
const ONI = 'Assault Blackwing - Onimaru the Divine Thunder';

// Assault Blackwing - Onimaru: Synchro Summoned with a Blackwing it becomes a Tuner; it cannot be destroyed by card effects.
{
  const e = duel(['Blackwing - Calima the Haze', 'Lady of the Lake'], [], [ONI]);
  toMain(e);
  const o = synchro(e, 0, ONI, [place(e, 0, 'Blackwing - Calima the Haze'), place(e, 0, 'Lady of the Lake')]);
  check(o?.tags?.synS === 1 && o.tags.tuner === 1, 'Onimaru: Synchro Summoned with a Blackwing, it is treated as a Tuner');
  run(e, e.destroy([o!.uid]));
  check(!!e.fieldCard(o!.uid), 'Onimaru: not destroyed by a card effect');
}
// Beelzeus: the opponent's monster's ATK becomes 0 and you gain its original ATK.
{
  const e = duel([], [], ['Beelzeus of the Diabolic Dragons']);
  toMain(e);
  const b = place(e, 0, 'Beelzeus of the Diabolic Dragons');
  const g = place(e, 1, FILL)!;
  effect(e, 0, b);
  check(e.atkOf(g) === 0 && e.player(0).lp === 4000 + 1400, "Beelzeus: the opponent's monster has 0 ATK and its owner gained 1400 LP");
}
// Chaos Angel: 2 Level 5 DARK non-Tuners (one treated as a Tuner) Synchro Summon it; it banishes a card on the field.
{
  const e = duel(['Blackwing - Brisote the Tailwind', 'Blackwing - Brisote the Tailwind'], [], ['Chaos Angel']);
  toMain(e);
  place(e, 0, 'Blackwing - Brisote the Tailwind');
  place(e, 0, 'Blackwing - Brisote the Tailwind');
  const g = place(e, 1, FILL)!;
  const { can, fc } = proc(e, 0, 'Chaos Angel', 'yes', { pick: [FILL] });
  check(can && fc?.tags?.synS === 1 && zone(e, g) === 'removed', 'Chaos Angel: Synchro Summoned treating a DARK monster as a Tuner, and it banished a card');
}
// Chaos Beast: gains 1000 ATK once a card has been banished this turn.
{
  const e = duel([], [], ['Chaos Beast']);
  toMain(e);
  const b = place(e, 0, 'Chaos Beast')!;
  const before = e.atkOf(b);
  e.banish(e.player(0).deck[0].uid);
  check(before === 2000 && e.atkOf(b) === 3000, 'Chaos Beast: 3000 ATK after a card was banished');
}
// Chaos Ruler: when Synchro Summoned, excavates 5, adds a LIGHT/DARK monster, sends the rest to the GY.
{
  const e = duel(['Core of Chaos'], [], ['Chaos Ruler, the Chaotic Magical Dragon']);
  toMain(e);
  const mats = [place(e, 0, FILL), place(e, 0, FILL)];
  const deck = e.player(0).deck.length;
  const gy = e.player(0).gy.length;
  synchro(e, 0, 'Chaos Ruler, the Chaotic Magical Dragon', mats, 'yes', { pick: ['Core of Chaos'] });
  check(e.player(0).hand.some((c) => c.name === 'Core of Chaos') && e.player(0).deck.length === deck - 5 && e.player(0).gy.length === gy + 2 + 4, 'Chaos Ruler: added Core of Chaos and sent the other 4 to the GY');
}
// Cloudcastle: when Synchro Summoned, Special Summons a Level 9 monster from the GY.
{
  const e = duel(['Moisture Creature'], [], ['Cloudcastle']);
  toMain(e);
  run(e, e.sendToGrave(e.player(0).deck.find((c) => c.name === 'Moisture Creature')!.uid, 'cost'));
  synchro(e, 0, 'Cloudcastle', [place(e, 0, FILL), place(e, 0, FILL)], 'yes', { pick: ['Moisture Creature'] });
  check(!!mine(e, 0, 'Moisture Creature') && !!mine(e, 0, 'Cloudcastle'), 'Cloudcastle: Moisture Creature came back from the GY');
}
// Cosmic Quasar Dragon: negates the effects of a face-up card.
{
  const e = duel([], [], ['Cosmic Quasar Dragon']);
  toMain(e);
  const q = place(e, 0, 'Cosmic Quasar Dragon');
  const g = place(e, 1, FILL)!;
  effect(e, 0, q, { pick: [FILL] });
  check(e.isNegated(g), "Cosmic Quasar Dragon: the opponent's monster's effects are negated");
}
// Crystal Clear Wing Synchro Dragon: negates the opponent's Spell and destroys it.
{
  const e = duel([], ['Dian Keto the Cure Master'], ['Crystal Clear Wing Synchro Dragon'], [], 1);
  toMain(e);
  place(e, 0, 'Crystal Clear Wing Synchro Dragon');
  const dk = grab(e, 1, 'Dian Keto the Cure Master');
  e.apply({ type: 'ACTIVATE', player: 1, uid: dk.uid, zone: 0 });
  settle(e, { respond: 'Crystal Clear Wing' });
  check(e.player(1).lp === 4000 && zone(e, dk) === 'gy', 'Crystal Clear Wing: Dian Keto was negated and destroyed (no LP gained)');
}
// Dragocytos: in the Standby Phase, halves an opponent's monster's ATK and burns for the lost ATK.
{
  const e = duel([], [], ['Dragocytos Corrupted Nethersoul Dragon']);
  toMain(e);
  const d = place(e, 0, 'Dragocytos Corrupted Nethersoul Dragon')!;
  const g = place(e, 1, FILL)!;
  run(e, getEffect(d.name)!.onStandby!(e, d, 0), 'yes');
  check(e.atkOf(g) === 700 && e.player(1).lp === 4000 - 700, 'Dragocytos: 1400 ATK became 700 and the opponent took 700');
}
// Hi-Speedroid Puzzle: doubles its ATK battling a Special Summoned monster.
{
  const e = duel([], [], ['Hi-Speedroid Puzzle'], [], 1);
  toMain(e);
  const g = place(e, 1, FILL)!;
  const pz = place(e, 0, 'Hi-Speedroid Puzzle')!;
  toPhase(e, 0, 'BP');
  e.apply({ type: 'ATTACK', player: 0, uid: pz.uid, target: g.uid });
  settle(e);
  check(zone(e, g) === 'gy' && e.player(1).lp === 4000 - (2600 - 1400), 'Hi-Speedroid Puzzle: 2600 ATK destroyed a 1400 ATK Special Summoned monster');
}
// Psychic Nightmare: calling the type of a card in the opponent's hand right gives 1000 ATK.
{
  const e = duel([], [], ['Psychic Nightmare']);
  toMain(e);
  const n = place(e, 0, 'Psychic Nightmare')!;
  effect(e, 0, n, { pick: ['Monster'] });
  check(e.atkOf(n) === 3400, 'Psychic Nightmare: called Monster right, 3400 ATK');
}
// Red Nova Dragon: 500 ATK for each Tuner in the GY.
{
  const e = duel(['Lady of the Lake', 'Converging Wills Dragon'], [], ['Red Nova Dragon']);
  toMain(e);
  const r = place(e, 0, 'Red Nova Dragon')!;
  for (const n of ['Lady of the Lake', 'Converging Wills Dragon']) run(e, e.sendToGrave(e.player(0).deck.find((c) => c.name === n)!.uid, 'cost'));
  check(e.atkOf(r) === 4500, 'Red Nova Dragon: 3500 + 2 Tuners in the GY = 4500 ATK');
}
// Shiranui Sunsaga: returns a Zombie Synchro from the GY to the Extra Deck and destroys an opponent's card.
{
  const e = duel([], [], ['Shiranui Sunsaga', 'Shiranui Sunsaga']);
  toMain(e);
  const g = place(e, 1, FILL)!;
  run(e, e.sendToGrave(e.player(0).fusion[0].uid, 'cost'));
  const s = e.player(0).fusion[0];
  run(e, e.specialSummon(s.uid, 0, 'atk'), 'yes', { pick: ['Shiranui Sunsaga'] }, 'yes', { pick: [FILL] });
  check(zone(e, s) === 'mz' && e.player(0).fusion.length === 1 && zone(e, g) === 'gy', 'Shiranui Sunsaga: 1 returned to the Extra Deck, 1 opponent card destroyed');
}
// Cosmic Slicer Zer'oll: the opponent's monsters with A-Counters go to Defense Position.
{
  const e = duel([], [], ["Cosmic Slicer Zer'oll"]);
  toMain(e);
  const g = place(e, 1, FILL)!;
  (g.tags ??= {}).aCounter = 1;
  place(e, 0, "Cosmic Slicer Zer'oll");
  check(g.pos === 'def', "Zer'oll: a monster with an A-Counter was changed to Defense Position");
}
// Dark Infant @Ignister: Link Summoned with Danmari; when a 2300-ATK Cyberse activates its effect it moves to the next zone and changes Attribute.
{
  const e = duel(['Danmari @Ignister'], ['Danmari @Ignister'], ['Dark Infant @Ignister']);
  toMain(e);
  place(e, 0, 'Danmari @Ignister');
  const { can, fc } = proc(e, 0, 'Dark Infant @Ignister');
  check(can && fc?.tags?.linkS === 1, 'Dark Infant @Ignister: Link Summoned with Danmari @Ignister');
  const dm = place(e, 1, 'Danmari @Ignister')!;
  const from = e.find(fc!.uid)!.loc.index;
  const q = getEffect('Dark Infant @Ignister')!.quick!;
  const link = { card: dm, loc: e.find(dm.uid)!.loc, player: 1 as Pid, label: dm.name, negated: false };
  const ok = q.can(e, fc!, 0, 'effect', { link });
  run(e, q.run(e, fc!, 0, { card: fc!, loc: e.find(fc!.uid)!.loc, player: 0, label: fc!.name, negated: false }), { pick: ['LIGHT'] });
  check(ok && Math.abs(e.find(fc!.uid)!.loc.index - from) === 1 && e.state.fx.declAttr?.[fc!.uid] === 'LIGHT', 'Dark Infant @Ignister: moved to the next Monster Zone and became LIGHT');
}

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
