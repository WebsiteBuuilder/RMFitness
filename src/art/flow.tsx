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
import { coalesce, cueUids, focusArt, memoField, setArtBusy, toCues, type Cue, type CueTrack, type FieldMemo } from './cues';
import { profileFor, SIGNATURE_CARDS } from './profile';
import { getCinematics, type Cinematics } from './settings';

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
const stageEl = () => (typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.art-stage'));
const SIGNATURES = new Set(SIGNATURE_CARDS);

interface Pending {
  id: number;
  state: DuelState;
  /** a cinematic plays for it (otherwise it just waits its turn behind one) */
  cine: boolean;
  /** the new state asks the player something: show it when the chain is over, not mid-way */
  prompt: boolean;
}

/** Spots a change in the engine's (in-place) state. */
const signature = (s: DuelState) => {
  const p = s.prompt as { kind?: string; player?: number; title?: string } | null;
  const ev = s.events ?? [];
  return [ev.length ? ev[ev.length - 1].seq : 0, s.log.length, s.phase, s.turn, s.turnPlayer, s.winner, s.players[0].lp, s.players[1].lp, p ? `${p.kind}${p.player}${p.title}` : ''].join('|');
};
const copy = (s: DuelState): DuelState => (typeof structuredClone === 'function' ? structuredClone(s) : JSON.parse(JSON.stringify(s)));

const humanPrompt = (s: DuelState, seat: Pid | null) => !!s.prompt && (seat === null || s.prompt.player === seat);

/** A summon worth a cinematic under "Big moments": level 7+, Fusion, Ritual, or a signature card. */
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
      return bigCard(c.card.name);
    case 'activate':
      return SIGNATURES.has(c.card.name);
    case 'damage':
      return c.amount >= 1000;
    case 'set':
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
      return c.card.controller;
    case 'skill':
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
  /** hold to skip all: no cinematics until this opponent turn is over */
  private skipTurn: number | null = null;
  private watchdog = 0;
  /** when the watchdog fires (performance.now() ms), and what was left of it when the tab was hidden */
  private dogAt = 0;
  private dogLeft = -1;
  private promptSkipped: unknown = null;
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
    this.snap = copy(real);
    const evs = real.events ?? [];
    const top = evs.length ? evs[evs.length - 1].seq : 0;
    const host = stageEl();
    const viewer: Pid = seat ?? real.prompt?.player ?? real.turnPlayer;
    if (this.lastSeq === null || top < this.lastSeq || !before) {
      // First look, or the duel was rebuilt from its log: start from here, replay nothing.
      this.lastSeq = top;
      this.flushAll();
      this.shown = real;
      this.memo = memoField(real, viewer, host);
      return real;
    }
    const fresh = evs.filter((e) => e.seq > this.lastSeq!);
    this.lastSeq = top;
    if (this.skipTurn !== null && (real.turn !== this.skipTurn || real.winner !== null)) this.skipTurn = null;
    let cues: Cue[] = [];
    if (fresh.length && real.rules?.mode === 'speed' && sink?.ready() && this.skipTurn === null) {
      cues = coalesce(toCues(fresh, real, viewer, host, this.memo, this.track));
      cues = pickCues(cues, getCinematics(), viewer);
    }
    this.memo = memoField(real, viewer, host, this.memo);
    if (cues.length) {
      const batch = this.nextId++;
      const scales = cues.map((c) => {
        if (c.kind !== 'summon' && c.kind !== 'flip') return 1;
        if (!c.card.name) return 1;
        const again = this.summoned.has(c.card.name);
        this.summoned.add(c.card.name);
        return again ? 2 : 1;
      });
      // the board keeps showing the duel as it was before this chain
      if (!this.pending.length) this.shown = before;
      this.pending.push({ id: batch, state: this.snap, cine: true, prompt: humanPrompt(real, seat) });
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
    } else this.shown = real;
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
    if (!end && this.pending[i].prompt) return;
    this.advance(i);
  }

  /** Shows the state of pending[i] (and of the quiet updates right behind it). */
  private advance(i: number) {
    let j = i;
    while (j + 1 < this.pending.length && !this.pending[j + 1].cine) j++;
    // all caught up: back to the live state
    this.shown = j === this.pending.length - 1 && this.real ? this.real : this.pending[j].state;
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

  dispose() {
    clearTimeout(this.watchdog);
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
  if (!ref.current) ref.current = new Flow();
  const f = ref.current;
  const [, force] = useReducer((x: number) => x + 1, 0);
  f.rerender = () => force(0);
  flow = f;
  const shown = f.update(real, seat);
  useLayoutEffect(() => {
    flow = f;
    f.drawn();
  });
  useEffect(() => f.afterRender());
  useEffect(
    () => () => {
      f.dispose();
      if (flow === f) flow = null;
    },
    [],
  );
  return shown;
}

/** Life Points that count down (or up) over 0.6 s, flashing red when they drop. */
export function LpCount({ value }: { value: number }) {
  const [v, setV] = useState(value);
  const [hits, setHits] = useState(0);
  const cur = useRef(value);
  useEffect(() => {
    const from = cur.current;
    if (from === value) return;
    if (value < from) setHits((h) => h + 1);
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 600);
      const e = 1 - (1 - k) ** 3;
      cur.current = Math.round(from + (value - from) * e);
      setV(cur.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <span key={hits} class={`lp-count ${hits ? 'lp-hit' : ''}`}>
      {v}
    </span>
  );
}
