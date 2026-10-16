// Keeps the duel board in step with the 3D cinematics.
//
// While a chain of cues (the cues of one engine update) plays, the duel screen
// keeps showing the state from before it, and moves on to the new state at the
// chain's impact or landing (a monster lands, a blow hits, damage, a shatter),
// or at the latest when the chain ends, is skipped, is cleared, fails, or when
// its watchdog runs out (armed when the chain's cinematic actually starts, for
// its own length + 1.5 s; paused while the tab is hidden). So Life Points drop as the attack lands and a summoned monster appears in
// its zone as it lands, never before.
//
// The player never acts on a stale board: while the board lags, the art stage
// covers the screen and a tap there skips the chain (the board catches up at
// once). While the stage is on, a tap anywhere but on a prompt or button skips too. A choice for the player waits for the end of its chain and then shows
// straight away, with whatever is left on stage skipped.
//
// The duel screens use it as `const state = useShownState(view.state, seat)`.
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'preact/hooks';
import { card } from '../eds/db';
import type { DuelState, Pid } from '../eds/types';
import { lpCount as lpCountSound } from '../ui/duelSfx';
import { cueSound } from './cueSound';
import { coalesce, cueUids, focusArt, memoField, setArtBusy, toCues, type Cue, type CueTrack, type FieldMemo } from './cues';
import { profileFor, SIGNATURE_CARDS } from './profile';
import { getCinematics, type Cinematics } from './settings';
import { FIN, finishOf } from './finish';

/** How the art stage plays what the flow hands it. */
export interface ArtSink {
  /** false once 3D turned out to be unavailable (no WebGL) */
  ready(): boolean;
  play(cues: Cue[], batch: number, scales: number[]): void;
  /** finish whatever is on stage now (a choice for the player is up) */
  skip(): void;
  /** a cinematic is on stage or on its way */
  busy(): boolean;
}

/** A chain whose cinematic has not started this long after it was queued (3D still loading, say) lets the board go. */
export const START_GRACE_MS = 4000;
/** Once a chain's cinematic is playing, the board waits at most its length plus this. */
export const WATCHDOG_SLACK_MS = 1500;
/** An opponent's summon that is not a big one plays this much faster (a short version). */
export const OPP_SUMMON_SCALE = 2.5;
/** Life Points count to their new value over this long (LpCount). */
export const LP_TICK_MS = 600;
/** The result shows this long after the Life Points have finished counting down. */
export const WIN_AFTER_LP_MS = 250;
/** ...but never waits longer than this after the Life Points changed. */
export const WIN_MAX_WAIT_MS = 4000;
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
/** The Life Points counters on screen read `s`'s values (a player with no counter counts as done). */
const lpCounted = (s: DuelState) => s.players.every((p, k) => (lpShown.get(k as Pid) ?? p.lp) === p.lp);
const stageEl = () => (typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.art-stage'));
const SIGNATURES = new Set(SIGNATURE_CARDS);

interface Pending {
  id: number;
  state: DuelState;
  /** a cinematic plays for it (otherwise it just waits its turn behind one) */
  cine: boolean;
  /** the new state asks the player something: show it when the chain is over, not mid-way */
  prompt: boolean;
  /**
   * The monsters this chain summons, each with the count of commits (impacts, landings)
   * the chain reaches by its own landing: an earlier commit (a Tribute's destruction
   * before the Tribute Summon, say) shows the board without them, so a summoned card
   * never sits in its zone before its own cinematic lands it.
   */
  lands?: { uid: number; at: number }[];
  /** commits reached so far */
  commits?: number;
}

/** The cinematics that mark a commit (runtime: tl.commit), in chain order. */
const COMMITS = new Set<Cue['kind']>(['summon', 'hit', 'damage', 'destroy']);

/** Where each monster summoned by `cues` lands, counted in commits (see Pending.lands). */
export function landings(cues: Cue[]): { uid: number; at: number }[] {
  let n = 0;
  const out: { uid: number; at: number }[] = [];
  for (const c of cues) {
    if (COMMITS.has(c.kind)) n++;
    if (c.kind === 'summon' && n > 1) out.push({ uid: c.card.uid, at: n });
  }
  return out;
}

/** `s` without the monsters `uids` on the field (their zones as empty). */
const without = (s: DuelState, uids: Set<number>): DuelState => ({
  ...s,
  players: s.players.map((p) => (p.mz.some((m) => m && uids.has(m.uid)) ? { ...p, mz: p.mz.map((m) => (m && uids.has(m.uid) ? null : m)) } : p)) as DuelState['players'],
});

/** Spots a change in the engine's (in-place) state. */
const signature = (s: DuelState) => {
  const p = s.prompt as { kind?: string; player?: number; title?: string } | null;
  const ev = s.events ?? [];
  return [ev.length ? ev[ev.length - 1].seq : 0, s.log.length, s.phase, s.turn, s.turnPlayer, s.winner, s.players[0].lp, s.players[1].lp, p ? `${p.kind}${p.player}${p.title}` : ''].join('|');
};
const copy = (s: DuelState): DuelState => (typeof structuredClone === 'function' ? structuredClone(s) : JSON.parse(JSON.stringify(s)));

const humanPrompt = (s: DuelState, seat: Pid | null) => !!s.prompt && (seat === null || s.prompt.player === seat);
const lpOf = (s: DuelState) => `${s.players[0].lp}|${s.players[1].lp}`;
/** `s` with the Life Points of `from` (the rest of the board as it is). */
const withLp = (s: DuelState, from: DuelState): DuelState => ({
  ...s,
  players: s.players.map((p, k) => (p.lp === from.players[k].lp ? p : { ...p, lp: from.players[k].lp })) as DuelState['players'],
});

/** A summon worth a cinematic under "Big moments": level 7+, Fusion, Ritual, or a signature card (or a Glossy-or-better finish, isBig). */
function bigCard(name: string): boolean {
  const info = card(name);
  if (!info || info.kind !== 'monster') return false;
  if ((info.level ?? 0) >= 7 || info.sub === 'Fusion' || info.sub === 'Ritual') return true;
  return SIGNATURES.has(name) && profileFor(info, name).tier >= 2;
}

function isBig(c: Cue): boolean {
  switch (c.kind) {
    case 'summon':
    case 'flip':
      // a Glossy, Royal or Overframe card always gets its entrance: the finish is the show
      return bigCard(c.card.name) || finishOf(c.card) >= FIN.GL;
    case 'activate':
      // every Spell and Trap the moment it is activated (Dark Hole, Mirror Force, Waboku...);
      // monster effects and continuous effects at work only for the signature cards
      return (c.what !== 'monster' && !c.lazy) || SIGNATURES.has(c.card.name);
    case 'target': {
      const k = card(c.card.name)?.kind;
      return k === 'spell' || k === 'trap' || SIGNATURES.has(c.card.name);
    }
    case 'damage':
      return c.amount >= 1000;
    case 'set':
    case 'leave':
    case 'heal':
    case 'draw':
      return false;
    default:
      // skills, attacks, hits, destruction, the finish
      return true;
  }
}

/** Who a cue belongs to (null: it follows whatever caused it). */
function owner(c: Cue): Pid | null {
  switch (c.kind) {
    case 'summon':
    case 'set':
    case 'flip':
    case 'activate':
    case 'target':
    case 'leave':
      return c.card.controller;
    case 'skill':
    case 'heal':
    case 'draw':
      return c.player;
    case 'attack':
      return c.attacker.controller;
    case 'hit':
      return c.attacker?.controller ?? (c.defender === 0 ? 1 : 0);
    default:
      return null;
  }
}

/** The cues a chain plays under the Cinematics setting. */
export function pickCues(cues: Cue[], mode: Cinematics, viewer: Pid): Cue[] {
  if (mode === 'off') return [];
  if (mode === 'all') return cues;
  if (mode === 'big') return cues.filter(isBig);
  // My actions only: what I do, and what follows from it (its damage, its destruction, the finish).
  const mine = cues.some((c) => owner(c) === viewer);
  return cues.filter((c) => c.kind === 'win' || owner(c) === viewer || (owner(c) === null && mine));
}

/** The board-sync logic behind useShownState (exported for the tests). */
export class Flow {
  shown: DuelState | null = null;
  private real: DuelState | null = null;
  private sig = '';
  /** a copy of the state at the last update: the board to keep showing when a chain starts */
  private snap: DuelState | null = null;
  private pending: Pending[] = [];
  private outbox: { cues: Cue[]; batch: number; scales: number[] }[] = [];
  private nextId = 1;
  private lastSeq: number | null = null;
  private memo: FieldMemo = new Map();
  private track: CueTrack = { battle: null };
  /** card names already summoned with a cinematic this duel (a repeat plays a short version) */
  private summoned = new Set<string>();
  /** Spells/Traps that already played their activation (a face-up card using its effect again stays quiet under Big moments) */
  private activated = new Set<number>();
  /** Spell/Trap names already seen activated this duel (a repeat plays faster) */
  private stSeen = new Set<string>();
  /** hold to skip all: no cinematics until this opponent turn is over */
  private skipTurn: number | null = null;
  private watchdog = 0;
  /** when the watchdog fires (performance.now() ms), and what was left of it when the tab was hidden */
  private dogAt = 0;
  private dogLeft = -1;
  private promptSkipped: unknown = null;
  /** when the Life Points on screen last changed (performance.now() ms) */
  private lpAt = -1e9;
  /** the won duel waiting for its Life Points to finish counting before the result shows */
  private winHeld: DuelState | null = null;
  private winTimer = 0;
  /** the copy of the live state taken at the update before this one */
  private prevSnap: DuelState | null = null;
  seat: Pid | null = null;
  rerender: () => void = () => {};

  constructor() {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** The watchdog sleeps while the tab is hidden (nothing draws, so no cinematic can finish). */
  private onVisibility = () => {
    if (document.hidden) {
      if (this.dogAt) {
        this.dogLeft = Math.max(0, this.dogAt - performance.now());
        clearTimeout(this.watchdog);
        this.dogAt = 0;
      }
    } else if (this.dogLeft >= 0) {
      const left = this.dogLeft;
      this.dogLeft = -1;
      this.setDog(left);
    }
  };

  /** Called while the duel screen renders: the state it should show. */
  update(real: DuelState, seat: Pid | null): DuelState {
    this.seat = seat;
    // The engine changes its state in place, so changes are spotted by a signature,
    // and the boards to show later are copies.
    const sig = signature(real);
    if (real === this.real && sig === this.sig && this.shown) return this.shown;
    this.real = real;
    this.sig = sig;
    const before = this.snap;
    this.prevSnap = before;
    this.snap = copy(real);
    const evs = real.events ?? [];
    const top = evs.length ? evs[evs.length - 1].seq : 0;
    const host = stageEl();
    const viewer: Pid = seat ?? real.prompt?.player ?? real.turnPlayer;
    if (this.lastSeq === null || top < this.lastSeq || !before) {
      // First look, or the duel was rebuilt from its log: start from here, replay nothing.
      this.lastSeq = top;
      this.flushAll();
      this.show(real);
      this.memo = memoField(real, viewer, host);
      return real;
    }
    const fresh = evs.filter((e) => e.seq > this.lastSeq!);
    this.lastSeq = top;
    if (this.skipTurn !== null && (real.turn !== this.skipTurn || real.winner !== null)) this.skipTurn = null;
    let cues: Cue[] = [];
    if (fresh.length && real.rules?.mode === 'speed' && this.skipTurn === null) {
      const all = coalesce(toCues(fresh, real, viewer, host, this.memo, this.track));
      const mode = getCinematics();
      cues = sink?.ready() ? pickCues(all, mode, viewer) : [];
      // Big moments: a Spell/Trap plays when it is activated, not each time a face-up one uses its effect again
      if (mode === 'big') cues = cues.filter((c) => !(c.kind === 'activate' && c.what !== 'monster' && !SIGNATURES.has(c.card.name) && this.activated.has(c.card.uid)));
      for (const c of all) {
        if (c.kind === 'activate' && c.what !== 'monster') this.activated.add(c.card.uid);
        // a card that leaves the field or is Set again starts over: its next activation plays
        else if (c.kind === 'leave' || c.kind === 'destroy' || c.kind === 'set') this.activated.delete(c.card.uid);
      }
      // what gets no cinematic still makes its sound, a beat apart
      all.filter((c) => !cues.includes(c)).forEach((c, i) => cueSound(c, i * 0.12));
    }
    this.memo = memoField(real, viewer, host, this.memo);
    if (cues.length) {
      const batch = this.nextId++;
      const scales = cues.map((c) => {
        if (c.kind === 'activate' && c.what !== 'monster') {
          const again = this.stSeen.has(c.card.name);
          this.stSeen.add(c.card.name);
          // the opponent's everyday Spell/Trap (a Continuous, Field or Equip card that strikes nothing): a short version
          const strikes = !!c.targets?.length || !!c.field?.some((f) => f.dies);
          if (c.card.controller !== viewer && !strikes && !SIGNATURES.has(c.card.name)) return OPP_SUMMON_SCALE;
          return again ? 1.6 : 1;
        }
        if (c.kind !== 'summon' && c.kind !== 'flip') return 1;
        if (!c.card.name) return 1;
        const again = this.summoned.has(c.card.name);
        this.summoned.add(c.card.name);
        // the opponent's everyday summon: a short version (~1.3 s), so their turn keeps moving
        if (c.card.controller !== viewer && !isBig(c)) return OPP_SUMMON_SCALE;
        return again ? 2 : 1;
      });
      // the board keeps showing the duel as it was before this chain
      if (!this.pending.length) this.show(before);
      const lands = landings(cues);
      this.pending.push({ id: batch, state: this.snap, cine: true, prompt: humanPrompt(real, seat), lands, commits: 0 });
      this.outbox.push({ cues, batch, scales });
      // the computer waits from this very moment; the field figures in it step aside
      setArtBusy(true);
      focusArt(cues.flatMap(cueUids));
      if (this.pending.length === 1) this.armWatchdog();
    } else if (this.pending.length) {
      // Nothing to watch here, but it comes after what is still playing.
      const last = this.pending[this.pending.length - 1];
      if (!last.cine) last.state = this.snap;
      else this.pending.push({ id: this.nextId++, state: this.snap, cine: false, prompt: false });
    } else this.show(real);
    return this.shown ?? real;
  }

  /** After the screen has drawn: note where every monster is drawn, hand the new chains to the art stage. */
  drawn() {
    if (this.real) this.memo = memoField(this.real, this.seat ?? this.real.prompt?.player ?? this.real.turnPlayer, stageEl(), this.memo);
    const out = this.outbox;
    this.outbox = [];
    for (const o of out) {
      if (sink?.ready()) sink.play(o.cues, o.batch, o.scales);
      else this.commit(o.batch, true);
    }
    if (!this.pending.length && !sink?.busy()) setArtBusy(false);
  }

  /** A choice for the player is up: nothing on stage may stand in its way. */
  afterRender() {
    const s = this.shown;
    if (!s || !humanPrompt(s, this.seat) || this.pending.length) return;
    if (this.promptSkipped === s.prompt) return;
    this.promptSkipped = s.prompt;
    sink?.skip();
  }

  /** The director reached a chain's impact (`end` false) or its end. */
  commit(batch: number, end: boolean) {
    const i = this.pending.findIndex((p) => p.id === batch);
    if (i < 0) return;
    const p = this.pending[i];
    if (!end && p.lands?.length) {
      // a monster of this chain has not landed yet: the board moves on without it
      const n = (p.commits = (p.commits ?? 0) + 1);
      const hide = new Set(p.lands.filter((l) => l.at > n).map((l) => l.uid));
      if (hide.size && i === 0) {
        const s = this.shown;
        this.show(p.prompt && s ? withLp(s, p.state) : without(p.state, hide));
        this.rerender();
        return;
      }
    }
    if (!end && p.prompt) {
      // The choice waits for the end of the chain, but the blow's damage lands now:
      // the Life Points tick down at the hit, not all at once when the stage closes.
      const s = this.shown;
      const at = this.pending[i].state;
      if (s && lpOf(s) !== lpOf(at)) {
        this.show(withLp(s, at));
        this.rerender();
      }
      return;
    }
    this.advance(i);
  }

  /**
   * Puts `next` on screen. A duel that has just been won shows its last Life Points
   * first and its result only once they have counted down (LP_TICK_MS + WIN_AFTER_LP_MS).
   */
  private show(next: DuelState) {
    // (the live state changes in place: what it showed before is the copy taken at the last update)
    const prev = this.shown === this.real && this.prevSnap ? this.prevSnap : this.shown;
    const now = clock();
    if (prev && lpOf(prev) !== lpOf(next)) this.lpAt = now;
    clearTimeout(this.winTimer);
    this.winHeld = null;
    if (prev && next.winner !== null && prev.winner === null) {
      const wait = this.lpAt + LP_TICK_MS + WIN_AFTER_LP_MS - now;
      if (wait > 0) {
        this.winHeld = next;
        this.shown = { ...next, winner: null };
        this.winTimer = setTimeout(() => this.revealWin(), wait) as unknown as number;
        return;
      }
    }
    this.shown = next;
  }

  /**
   * The won duel's result goes up once its Life Points have counted down on screen
   * (on a struggling device the count can run late: it is checked, not assumed;
   * WIN_MAX_WAIT_MS at most). `now`: at once.
   */
  private revealWin(now = false) {
    const w = this.winHeld;
    if (!w) return;
    clearTimeout(this.winTimer);
    if (!now && !lpCounted(w) && clock() - this.lpAt < WIN_MAX_WAIT_MS) {
      this.winTimer = setTimeout(() => {
        if (lpCounted(w)) this.winTimer = setTimeout(() => this.revealWin(true), WIN_AFTER_LP_MS) as unknown as number;
        else this.revealWin();
      }, 80) as unknown as number;
      return;
    }
    this.winHeld = null;
    this.shown = w;
    this.rerender();
  }

  /** The result is waiting for the Life Points to count down. */
  get winPending() {
    return this.winHeld !== null;
  }

  /** Shows the state of pending[i] (and of the quiet updates right behind it). */
  private advance(i: number) {
    let j = i;
    while (j + 1 < this.pending.length && !this.pending[j + 1].cine) j++;
    // all caught up: back to the live state
    this.show(j === this.pending.length - 1 && this.real ? this.real : this.pending[j].state);
    this.pending.splice(0, j + 1);
    this.armWatchdog();
    this.rerender();
  }

  /** Watches the chain at the front: START_GRACE_MS until its cinematic starts (see started()). */
  private armWatchdog() {
    this.setDog(this.pending.length ? START_GRACE_MS : -1);
  }

  private setDog(ms: number) {
    clearTimeout(this.watchdog);
    this.dogAt = 0;
    this.dogLeft = -1;
    if (ms < 0 || !this.pending.length) return;
    if (typeof document !== 'undefined' && document.hidden) {
      this.dogLeft = ms;
      return;
    }
    this.dogAt = performance.now() + ms;
    this.watchdog = setTimeout(() => {
      this.dogAt = 0;
      if (this.pending.length) this.advance(0);
    }, ms) as unknown as number;
  }

  /** A cinematic of chain `batch` started and lasts `seconds` (at its playback rate): the board waits that long + slack. */
  started(batch: number, seconds: number) {
    if (this.pending[0]?.id !== batch) return;
    this.setDog(Math.max(0, seconds) * 1000 + WATCHDOG_SLACK_MS);
  }

  /** Shows the real state now (skip all, errors, leaving). */
  flushAll() {
    this.outbox = [];
    if (this.pending.length) this.advance(this.pending.length - 1);
    // a tap once the Life Points read their last value goes straight to the result
    else if (this.winHeld && clock() >= this.lpAt + LP_TICK_MS && lpCounted(this.winHeld)) this.revealWin(true);
  }

  /** Hold to skip all: during the opponent's turn, no more cinematics until it ends. */
  skipAll() {
    const r = this.real;
    this.skipTurn = r && this.seat !== null && r.turnPlayer !== this.seat ? r.turn : null;
    this.flushAll();
  }

  get holding() {
    return this.pending.length > 0;
  }

  /** A choice for the player is waiting behind the stage (or already up). */
  get promptWaiting() {
    return this.pending.some((p) => p.prompt) || (!!this.shown && humanPrompt(this.shown, this.seat));
  }

  dispose() {
    clearTimeout(this.watchdog);
    clearTimeout(this.winTimer);
    this.winHeld = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    this.pending = [];
    this.outbox = [];
  }
}

// One duel screen at a time.
let flow: Flow | null = null;
let sink: ArtSink | null = null;

/** The art stage plugs in here (null when it goes away). */
export function attachArtSink(s: ArtSink | null) {
  sink = s;
  if (!s) flow?.flushAll();
}

/** The director's chain callbacks. */
export function chainCommitted(batch: number) {
  flow?.commit(batch, false);
}
export function chainEnded(batch: number) {
  flow?.commit(batch, true);
}
/** A cinematic of chain `batch` is now playing, for `seconds` (its watchdog starts now). */
export function chainStarted(batch: number, seconds: number) {
  flow?.started(batch, seconds);
}
/** 3D just failed under the cinematic (WebGL context lost): the board shows the duel as it is, now. */
export function releaseBoard() {
  flow?.flushAll();
}

/** Long press / double tap on the art stage. */
export function skipAllChains() {
  flow?.skipAll();
}

/** A tap while a won duel waits for its Life Points: once they read their last value, the result shows at once. */
export function tapToResult() {
  if (flow?.winPending) flow.flushAll();
}

/** A choice for the player waits for the stage: what is left on it fades out fast. */
export function promptWaiting(): boolean {
  return !!flow?.promptWaiting;
}

/** True while the board lags behind a cinematic (the stage then takes every tap). */
export function boardHeld(): boolean {
  return !!flow?.holding;
}

/**
 * The duel state the screen should draw: the real state, except while a
 * cinematic chain plays, when it is the state from before the chain until the
 * chain's impact (see the top of this file). `seat` is the player at this
 * screen, or null when both seats are human (hotseat).
 */
export function useShownState(real: DuelState, seat: Pid | null): DuelState {
  const ref = useRef<Flow | null>(null);
  if (!ref.current) {
    ref.current = new Flow();
    // a new duel screen: Life Points start where they are
    lpShown.clear();
  }
  const f = ref.current;
  const [, force] = useReducer((x: number) => x + 1, 0);
  f.rerender = () => force(0);
  flow = f;
  const shown = f.update(real, seat);
  useLayoutEffect(() => {
    flow = f;
    f.drawn();
    // before the paint: a prompt never shows over a cinematic, not even for a frame
    f.afterRender();
  });
  useEffect(
    () => () => {
      f.dispose();
      if (flow === f) flow = null;
    },
    [],
  );
  return shown;
}

/** The Life Points last on screen per player: a remounted counter ticks on from there instead of jumping. */
const lpShown = new Map<Pid, number>();
/** A drop never lands in fewer than this many drawn steps (a stalled frame advances it by at most 1/n). */
const LP_MIN_STEPS = 6;

/**
 * Life Points that count down (or up) over 0.6 s, flashing red when they drop.
 * `who`: the player, so the count carries over a remount. Timed by the wall clock
 * (a timer backs up requestAnimationFrame), so it lands on time even when frames are throttled.
 */
export function LpCount({ value, who }: { value: number; who?: Pid }) {
  const start = (who !== undefined ? lpShown.get(who) : undefined) ?? value;
  const [v, setV] = useState(start);
  const [hits, setHits] = useState(0);
  const cur = useRef(start);
  useEffect(() => {
    const from = cur.current;
    const show = (n: number) => {
      cur.current = n;
      if (who !== undefined) lpShown.set(who, n);
      setV(n);
    };
    if (from === value) return void (who !== undefined && lpShown.set(who, value));
    if (value < from) setHits((h) => h + 1);
    lpCountSound(value - from, value, LP_TICK_MS);
    const t0 = performance.now();
    let raf = 0;
    let k = 0;
    let frameAt = t0;
    const tick = (frame: boolean) => {
      const now = performance.now();
      if (frame) frameAt = now;
      // wall time, but a drawn frame moves it at most 1/LP_MIN_STEPS: after a long frame
      // the count still visibly ticks instead of landing at once (never past 2.5× its time,
      // though). Frames that stopped coming (a hidden tab): the backup timer lands it on time.
      const t = Math.min(1, (now - t0) / LP_TICK_MS);
      k = frame ? (now - t0 > LP_TICK_MS * 2.5 ? t : Math.min(t, k + 1 / LP_MIN_STEPS)) : now - frameAt > 1000 ? t : k;
      show(Math.round(from + (value - from) * (1 - (1 - k) ** 3)));
      return k >= 1;
    };
    const step = () => {
      raf = tick(true) ? 0 : requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    const backup = setInterval(() => tick(false) && clearInterval(backup), 100);
    return () => (cancelAnimationFrame(raf), clearInterval(backup));
  }, [value]);
  return (
    <span key={hits} class={`lp-count ${hits ? 'lp-hit' : ''}`}>
      {v}
    </span>
  );
}
