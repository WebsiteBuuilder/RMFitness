// Chain spotlight: chain links numbered, resolved one by one (run: npx tsx tests/chainspot.test.ts).
import { Engine } from '../src/eds/engine';
import { DB as APP_DB } from '../src/eds/db';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { toCues, coalesce, CHAIN_CUES, type Cue, type CardRef, type CueTrack } from '../src/art/cues';
import { Flow, pickCues } from '../src/art/flow';
import { CUE_KINDS_DRAWN } from '../src/art/runtime';
import { resolveDuration, stackDuration, END_DURATION } from '../src/art/chainRules';

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
const top = (e: Engine) => (evs(e).length ? evs(e)[evs(e).length - 1].seq : 0);



const kinds = (e: Engine, from: number) => evs(e).filter((x) => x.seq > from).map((x) => `${x.kind}${x.link ?? ''}${x.negated ? '!' : ''}`);
const cuesOf = (e: Engine, from: number, viewer: Pid = 0, track: CueTrack = { battle: null }) => coalesce(toCues(evs(e).filter((x) => x.seq > from), e.state, viewer, null, new Map(), track));

/** An attack, answered by Sakuretsu Armor, answered by `t`. */
function twoLinks(t: string) {
  const e = fight(['Dark Magician', t], ['Sakuretsu Armor']);
  const dm = place(e, 0, 'Dark Magician');
  const sa = putST(e, 1, 'Sakuretsu Armor');
  const st = putST(e, 0, t);
  toBattle(e);
  const from = top(e);
  attack(e, dm, null, { respond: 'Sakuretsu Armor' }, { respond: t });
  return { e, dm, sa, st, from };
}

// ---------- the engine numbers each link and reports each one resolving ----------
{
  const { e, sa, st, from } = twoLinks('Seven Tools of the Bandit');
  const k = kinds(e, from);
  const at = (s: string) => k.indexOf(s);
  check(at('chain1') >= 0 && at('chain2') > at('chain1'), `each link is numbered as it goes on the chain (${k.join(' ')})`);
  check(at('resolve2') > at('chain2') && at('resolve1!') > at('resolve2'), 'the chain resolves from its last link down, and the negated link says so');
  check(at('chain-end') > at('resolve1!') && at('hit') > at('chain-end'), 'the chain ends before the battle goes on');
  const r2 = evs(e).find((x) => x.seq > from && x.kind === 'resolve' && x.link === 2);
  const c1 = evs(e).find((x) => x.seq > from && x.kind === 'chain' && x.link === 1);
  check(r2?.uid === st.uid && c1?.uid === sa.uid && r2?.player === 0 && c1?.player === 1, 'the events name each link\'s card and its controller');
  check(e.state.chain.length === 0, 'the chain is empty once it has resolved');
}

// ---------- one card on its own is no chain: no spotlight ----------
{
  const e = fight(['Dark Magician'], ['Sakuretsu Armor']);
  const dm = place(e, 0, 'Dark Magician');
  putST(e, 1, 'Sakuretsu Armor');
  toBattle(e);
  const from = top(e);
  attack(e, dm, null, { respond: 'Sakuretsu Armor' });
  const k = kinds(e, from);
  check(k.includes('chain1') && !k.some((x) => x.startsWith('resolve') || x === 'chain-end'), `a lone Trap gets no resolve beats (${k.join(' ')})`);
  check(!cuesOf(e, from).some((c) => CHAIN_CUES.has(c.kind)), 'and no chain cues');
}

// ---------- cues: the chain lifts, each link resolves with what it knows, the chain folds ----------
{
  const { e, sa, st, from } = twoLinks('Seven Tools of the Bandit');
  const cues = cuesOf(e, from, 0);
  const ix = (f: (c: Cue) => boolean) => cues.findIndex(f);
  const lift = ix((c) => c.kind === 'chain');
  const act2 = ix((c) => c.kind === 'activate' && c.card.uid === st.uid);
  const r2 = ix((c) => c.kind === 'resolve' && c.n === 2);
  const r1 = ix((c) => c.kind === 'resolve' && c.n === 1);
  const end = ix((c) => c.kind === 'chainEnd');
  check(act2 >= 0 && lift > act2 && r2 > lift && r1 > r2 && end > r1, `order: the answer's activation, the lift, link 2, link 1, the fold (${cues.map((c) => c.kind).join(' ')})`);
  const L = cues[lift];
  check(L.kind === 'chain' && L.added === 2 && L.stack.length === 2 && L.stack[0].card.uid === sa.uid && L.stack[1].card.uid === st.uid, 'the lift shows both links in order, the new one marked');
  check(L.kind === 'chain' && L.stack[0].what === 'trap' && L.stack[0].who === 'B' && !L.stack[0].mine && L.stack[1].mine, 'each link knows its kind and whose it is');
  const R2 = cues[r2];
  const R1 = cues[r1];
  check(R2.kind === 'resolve' && !R2.negated && !R2.stack.find((l) => l.n === 2)!.done && !R2.stack.find((l) => l.n === 1)!.done, 'link 2 resolves first, nothing done yet');
  check(R1.kind === 'resolve' && R1.negated && R1.stack.find((l) => l.n === 2)!.done && R1.stack.find((l) => l.n === 1)!.negated, 'link 1 resolves negated, link 2 already done');
  check(L.kind === 'chain' && !L.stack[1].done, 'a cue keeps the chain as it saw it (later cues do not change it)');
  check(L.kind === 'chain' && L.stack[0].card.name === 'Sakuretsu Armor' && L.stack[0].card.faceUp, 'the cards are shown face-up by name');
  // the opponent's screen sees the same chain, from its side
  const c1 = cuesOf(e, from, 1).find((c) => c.kind === 'chain');
  check(c1?.kind === 'chain' && c1.stack[0].mine && !c1.stack[1].mine && c1.stack[1].who === 'A', 'the other seat sees the same chain, mine and theirs swapped');
}

// ---------- the chain is built over two updates (a player's response in between) ----------
{
  const { e, from } = twoLinks('Trap Jammer');
  const all = evs(e).filter((x) => x.seq > from);
  const cut = all.findIndex((x) => x.kind === 'chain' && x.link === 1) + 1;
  const track: CueTrack = { battle: null };
  const a = coalesce(toCues(all.slice(0, cut), e.state, 0, null, new Map(), track));
  const b = coalesce(toCues(all.slice(cut), e.state, 0, null, new Map(), track));
  const L = b.find((c) => c.kind === 'chain');
  check(!a.some((c) => CHAIN_CUES.has(c.kind)), 'the first link alone plays no lift');
  check(L?.kind === 'chain' && L.stack.length === 2, 'the second update lifts both links (the first was remembered)');
  check(track.chain?.length === 0, 'the track forgets the chain once it has ended');
  // a fresh chain starts over at link 1
  const again = coalesce(toCues(all.slice(0, cut), e.state, 0, null, new Map(), track));
  check(!again.length || !again.some((c) => c.kind === 'resolve'), 'a new chain does not reuse the old one');
}

// ---------- a link's own effect, not another's: MST and Sakuretsu Armor ----------
{
  const { e, dm, st, from } = twoLinks('Mystical Space Typhoon');
  const cues = cuesOf(e, from, 0);
  const mst = cues.find((c) => c.kind === 'activate' && c.card.uid === st.uid);
  check(mst?.kind === 'activate' && !(mst.field ?? []).some((f) => f.uid === dm!.uid && f.dies), 'what Sakuretsu Armor destroys as it resolves is not shown as MST\'s doing');
  check(cues.filter((c) => c.kind === 'resolve').length === 2 && !cues.some((c) => c.kind === 'resolve' && c.negated), 'MST does not negate: both links resolve');
}

// ---------- every Cinematics setting but Off shows every chain ----------
{
  const { e, from } = twoLinks('Seven Tools of the Bandit');
  const cues = cuesOf(e, from, 0);
  const n = (cs: Cue[]) => cs.filter((c) => CHAIN_CUES.has(c.kind)).length;
  const want = n(cues);
  check(want === 4, `four chain cues (lift, two links, fold): ${want}`);
  for (const v of [0, 1] as Pid[]) {
    check(n(pickCues(cues, 'big', v)) === want, `Big moments shows the chain (seat ${v})`);
    check(n(pickCues(cues, 'mine', v)) === want, `My actions shows the chain (seat ${v})`);
    check(n(pickCues(cues, 'all', v)) === want, `All shows the chain (seat ${v})`);
  }
  check(!pickCues(cues, 'off', 0).length, 'Off shows nothing');
  check(['chain', 'resolve', 'chainEnd'].every((k) => CUE_KINDS_DRAWN.includes(k as Cue['kind'])), 'the director draws every chain cue');
}

// ---------- timing ----------
{
  const ref = { uid: 1, name: 'Sakuretsu Armor', faceUp: true, controller: 0 as Pid, rect: null, def: false };
  check(stackDuration(2) >= 0.9 && stackDuration(2) <= 1.1 && stackDuration(5) < 1.8, 'the lift is about a second (a long chain a little longer)');
  check(resolveDuration({ card: ref, negated: false }) >= 1.5 && resolveDuration({ card: ref, negated: false }) <= 2.6, 'a link stays up long enough to read its first lines');
  check(resolveDuration({ card: { ...ref, name: 'Seven Tools of the Bandit' }, negated: true }) <= 1.6, 'a negated link is quick');
  check(resolveDuration({ card: { ...ref, name: 'x'.repeat(5) }, negated: false }) >= 1.5, 'an unknown card still gets its beat');
  check(END_DURATION < 0.5, 'the fold is quick');
}

// ---------- reading a card pauses the board's watchdog ----------
{
  const f = new Flow() as any;
  f.pending = [{ id: 1, state: null, cine: true, prompt: false }];
  f.setPaused(true);
  f.setDog(5000);
  check(f.dogAt === 0 && f.dogLeft === 5000, 'paused: the watchdog waits');
  f.setPaused(false);
  check(f.dogAt > 0 && f.dogLeft === -1, 'going on: the watchdog runs again with what was left');
  f.dispose();
}

console.log(fails ? `\n${fails} FAILED` : '\nchainspot: all checks passed');
if (fails) process.exit(1);
