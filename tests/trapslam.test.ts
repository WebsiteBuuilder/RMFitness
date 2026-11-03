// "Not so fast!" trap slam and the finishing blow's slow-motion replay
// (run: npx tsx tests/trapslam.test.ts).
import { Engine } from '../src/eds/engine';
import { DB as APP_DB } from '../src/eds/db';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { toCues, coalesce, type Cue, type CardRef } from '../src/art/cues';
import { attachArtSink, finishingReplay, Flow, pickCues } from '../src/art/flow';
import { CUE_KINDS_DRAWN, cueOwner, REPLAY_WARP, SLAM_WARP, Timeline } from '../src/art/runtime';
import { DB } from './speedkit';

for (const [k, v] of DB) APP_DB.set(k, v);

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};
const FILL = 'Celtic Guardian';

// ---------- duel kit (from tests/batch-20.test.ts) ----------
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
/** A duel whose current turn (player `first`) may already conduct a Battle Phase. */
function fight(d0: string[], d1: string[] = [], first: Pid = 0, x0: string[] = [], x1: string[] = []): Engine {
  const e = duel(d0, d1, x0, x1, first);
  e.state.firstTurn = false;
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
/** Sends a card of `p` (deck or hand) to the GY. */
function toGy(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.sendToGrave(c.uid, 'cost'));
  return c;
}
/** Banishes a card of `p` from the deck or hand. */
function toBanished(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  e.banish(c.uid);
  return c;
}
/** Special Summons a card of `p` from wherever it is (Extra Deck included). Null when it did not arrive. */
function place(e: Engine, p: Pid, name: string, pos: Pos = 'atk', faceUp = true, ...ans: Ans[]): FieldCard | null {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.gy, ...ps.fusion, ...ps.hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.specialSummon(c.uid, p, pos, faceUp), ...ans);
  const f = e.fieldCard(c.uid);
  if (f) f.placedTurn = -1;
  return f;
}
/** Puts a card face-down in a Spell/Trap Zone (ready to be activated this turn). */
function putST(e: Engine, p: Pid, name: string): FieldCard {
  const c = grab(e, p, name);
  const ps = e.player(p);
  ps.hand.splice(ps.hand.findIndex((x) => x.uid === c.uid), 1);
  const z = ps.sz.findIndex((x) => x === null);
  const fc: FieldCard = { ...c, pos: 'atk', faceUp: false, placedTurn: -1, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
  ps.sz[z] = fc;
  return fc;
}
const act = (e: Engine, p: Pid, uid: number, ...ans: Ans[]) => {
  e.apply({ type: 'ACTIVATE', player: p, uid, zone: e.player(p).sz.findIndex((z) => z === null) });
  return settle(e, ...ans);
};
/** Activates a Spell from the hand (it is fetched there first). */
function playSpell(e: Engine, p: Pid, name: string, ...ans: Ans[]): FieldCard | null {
  const c = grab(e, p, name);
  act(e, p, c.uid, ...ans);
  return e.fieldCard(c.uid);
}
/** Sets a Trap and activates it in the Main Phase. */
function playTrap(e: Engine, p: Pid, name: string, ...ans: Ans[]): FieldCard | null {
  const fc = putST(e, p, name);
  act(e, p, fc.uid, ...ans);
  return e.fieldCard(fc.uid);
}
function summon(e: Engine, p: Pid, name: string, faceUp = true, ...ans: Ans[]): FieldCard | null {
  const c = grab(e, p, name);
  e.player(p).normalSummoned = false;
  e.apply({ type: 'SUMMON', player: p, uid: c.uid, zone: e.player(p).mz.findIndex((z) => z === null), pos: faceUp ? 'atk' : 'def', faceUp });
  settle(e, ...ans);
  return e.fieldCard(c.uid);
}
const kill = (e: Engine, cards: (Card | null | undefined)[], by?: Pid, ...ans: Ans[]) => {
  const uids = cards.filter((c): c is Card => !!c).map((c) => c.uid);
  return run(e, by === undefined ? e.destroy(uids) : e.as(by, e.destroy(uids)), ...ans);
};
const endTurn = (e: Engine, ...ans: Ans[]) => {
  e.apply({ type: 'END_TURN', player: e.state.turnPlayer });
  return settle(e, ...ans);
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

const evs = (e: Engine) => e.state.events ?? [];
const cuesOf = (e: Engine, from: number, viewer: Pid = 0) => coalesce(toCues(evs(e).filter((x) => x.seq > from), e.state, viewer, null, new Map()));
const top = (e: Engine) => (evs(e).length ? evs(e)[evs(e).length - 1].seq : 0);

// ---------- the engine names the card a response answers ----------
{
  const e = fight(['Dark Magician'], ['Sakuretsu Armor']);
  const dm = place(e, 0, 'Dark Magician');
  const sa = putST(e, 1, 'Sakuretsu Armor');
  toBattle(e);
  const from = top(e);
  attack(e, dm, null, { respond: 'Sakuretsu Armor' });
  const act = evs(e).find((x) => x.seq > from && x.kind === 'activate' && x.uid === sa.uid);
  check(act?.answers === dm!.uid, `Sakuretsu Armor's activation answers the attacker (${act?.answers} vs ${dm!.uid})`);
  const cues = cuesOf(e, from);
  const i = cues.findIndex((c) => c.kind === 'slam');
  const slam = cues[i];
  check(slam?.kind === 'slam' && slam.trap.uid === sa.uid && slam.onto.uid === dm!.uid, 'a slam cue: the Trap meets the attacker');
  check(cues[i + 1]?.kind === 'activate' && (cues[i + 1] as { card: CardRef }).card.uid === sa.uid, "the Trap's own activation plays right after its slam");
  check(cueOwner(slam!) === 1, 'the slam belongs to the Trap\'s controller');
  check(pickCues(cues, 'big', 0).some((c) => c.kind === 'slam'), 'Big moments plays the slam');
  check(pickCues(cues, 'mine', 1).some((c) => c.kind === 'slam') && !pickCues(cues, 'off', 1).length, 'My actions plays it for its owner; Off plays nothing');
}

// ---------- a Trap activated on its own gets no slam ----------
{
  // own trap activated in your own Main Phase: no slam
  const e = duel(['Waboku']);
  const from = top(e);
  const w = putST(e, 0, 'Waboku');
  e.apply({ type: 'ACTIVATE', player: 0, uid: w.uid, zone: 0 });
  settle(e);
  check(!cuesOf(e, from).some((c) => c.kind === 'slam'), 'a Trap activated in its own Main Phase gets no slam');
}

// ---------- the finishing blow replay ----------
const ref = (uid: number, name: string, controller: Pid): CardRef => ({ uid, name, faceUp: true, controller, rect: null, def: false });
{
  const a = ref(1, 'Blue-Eyes White Dragon', 0);
  const t = ref(2, 'Celtic Guardian', 1);
  const atk: Cue = { kind: 'attack', attacker: a, target: t, defender: 1 };
  const chain: Cue[] = [
    { kind: 'hit', attacker: a, target: t, defender: 1, dmg: { player: 1, amount: 1600 } },
    { kind: 'destroy', card: t },
    { kind: 'win', winner: 0, shadow: null },
  ];
  const r = finishingReplay(chain, atk);
  check(r.map((c) => c.kind).join() === 'attack,hit,destroy' && r.every((c) => c.replay), `the replay: the attack, its blow and what it destroyed, all marked replay (${r.map((c) => c.kind)})`);
  check(!chain.some((c) => c.replay) && !atk.replay, 'the original cues are left as they were');
  check(finishingReplay(chain, { ...atk, attacker: ref(9, 'Kuriboh', 0) } as Cue).map((c) => c.kind).join() === 'hit,destroy', 'an attack by another monster is not replayed');
  check(finishingReplay([{ kind: 'win', winner: 'draw', shadow: null }], atk).length === 0, 'a draw has no replay');
  check(finishingReplay([{ kind: 'damage', player: 1, amount: 500 }, { kind: 'win', winner: 0, shadow: null }], null).length === 1, 'damage alone replays itself');
  const burn: Cue[] = [{ kind: 'activate', card: ref(5, 'Ookazi', 0), what: 'spell' }, { kind: 'damage', player: 1, amount: 800 }, { kind: 'win', winner: 0, shadow: null }];
  check(finishingReplay(burn, null).map((c) => c.kind).join() === 'activate,damage', 'a burn finish replays the card that dealt it');
  check(finishingReplay([chain[0]], atk).length === 0, 'no win, no replay');
}

// ---------- a real duel won by an attack: the flow puts the replay before the finish ----------
{
  const played: { cues: Cue[]; scales: number[] }[] = [];
  attachArtSink({ ready: () => true, busy: () => false, play: (cues, _b, scales) => played.push({ cues, scales }), skip: () => {} });
  const e = fight(['Blue-Eyes White Dragon']);
  const f = new Flow();
  f.update(e.state, 0);
  const b = place(e, 0, 'Blue-Eyes White Dragon');
  e.player(1).lp = 2000;
  f.update(e.state, 0);
  f.drawn();
  toBattle(e);
  f.update(e.state, 0);
  f.drawn();
  e.apply({ type: 'ATTACK', player: 0, uid: b!.uid, target: null });
  f.update(e.state, 0);
  f.drawn();
  settle(e);
  f.update(e.state, 0);
  f.drawn();
  check(e.state.winner === 0, 'the direct attack wins the duel');
  const all = played.flatMap((p) => p.cues);
  const w = all.findIndex((c) => c.kind === 'win');
  const reps = all.filter((c) => c.replay);
  check(w > 0 && reps.length >= 1 && all.slice(w - reps.length, w).every((c) => c.replay), `the replay comes right before the finish (${all.map((c) => c.kind + (c.replay ? '*' : '')).join()})`);
  check(reps.some((c) => c.kind === 'hit'), 'the blow is in the replay');
  const last = played.find((p) => p.cues.some((c) => c.kind === 'win'))!;
  check(last.scales.length === last.cues.length, 'one scale per cue');
  f.dispose();
  attachArtSink(null);
}

// ---------- the director draws it ----------
check(CUE_KINDS_DRAWN.includes('slam'), 'the slam is drawn by the director');
check(SLAM_WARP > 0.2 && SLAM_WARP < 0.6 && REPLAY_WARP.hit < REPLAY_WARP.attack, 'slow motion: the slam crawls, the replayed blow is the slowest part');
{
  const stage = { add: (x: unknown) => x, remove: () => {} } as never;
  const tl = new Timeline(1, stage);
  check(tl.slow === 1, 'a cinematic runs in real time unless it says otherwise');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
if (fails) process.exit(1);
