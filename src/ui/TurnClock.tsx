// The online duel's turn timer on screen: one runner per duel ticks the clock (src/eds/turnClock.ts)
// and plays the move for this phone when its time is up; each player bar shows a small pill.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DuelState, Pid } from '../eds/types';
import { actor, CLAIM_GRACE_MS, clockKey, pointOf, clockText, expired, newClock, show, tick, URGENT_MS, type Clock, type ClockShow } from '../eds/turnClock';
import { artBusy } from '../art/cues';
import './clock.css';

/** A move played because the time ran out: who, and when (for the "Time's up" note). */
export interface TimeOut {
  who: Pid;
  at: number;
}

/** Where a duel's clock is kept on this phone, so a reload or a rejoin can't hand out fresh time. */
const STORE = 'eds.clock';
/** Longer than this between two steps is a gap, not a tick. */
const GAP_MS = 2000;
interface Saved {
  key: string;
  clock: Clock;
  turns: [string, number][];
  at: number;
}

export class ClockRunner {
  clock: Clock = newClock();
  shown: ClockShow | null = null;
  out: TimeOut | null = null;
  /** the other player's time ran out a while ago and nothing came: this phone may take the win */
  claimable = false;
  private turns = new Map<string, number>();
  private last = Date.now();
  private retryAt = 0;
  /** moves played for this phone at one point of the duel that didn't land */
  private tries = 0;
  private zeroSince = 0;
  private zeroAt = '';
  private savedSec = '';
  private listeners = new Set<() => void>();

  /** `duel`: the room and duel the clock belongs to (a saved clock for it picks up where it was, time away included). */
  constructor(private readonly duel: string) {
    try {
      const raw = localStorage.getItem(STORE);
      const saved = raw ? (JSON.parse(raw) as Saved) : null;
      if (saved && saved.key === duel && saved.clock && Array.isArray(saved.turns)) {
        this.clock = saved.clock;
        this.turns = new Map(saved.turns);
        this.last = Math.min(Date.now(), saved.at);
      }
    } catch {
      /* a fresh clock */
    }
  }

  private save() {
    try {
      const v: Saved = { key: this.duel, clock: this.clock, turns: [...this.turns].slice(-6), at: this.last };
      localStorage.setItem(STORE, JSON.stringify(v));
    } catch {
      /* storage full or off: the clock still runs */
    }
  }

  /**
   * One step: `live` false (reconnecting) or a cinematic on screen holds the clock. `play` makes
   * the move for this phone; it runs again after a few seconds if that move didn't land.
   */
  step(s: DuelState, moves: number, live: boolean, me: Pid, play: (attempt: number) => void, now = Date.now()) {
    let dt = now - this.last;
    this.last = now;
    // A gap (the app was in the background, or closed and opened again): it counts only when the
    // same allowance is still running; when moves came in meanwhile nobody can tell whose it was.
    if (dt > GAP_MS && clockKey(s) !== this.clock.key) dt = 0;
    this.clock = tick(this.clock, s, moves, live && !artBusy() ? dt : 0, this.turns);
    const who = actor(s);
    if (who !== null && expired(this.clock, s, moves)) {
      this.clock = { ...this.clock, spent: pointOf(s) };
      this.tries = 0;
      this.out = { who, at: now };
      if (who === me) {
        this.retryAt = now + 4000;
        play(0);
      }
    } else if (who === me && this.clock.spent === pointOf(s) && show(this.clock, s)?.left === 0 && now > this.retryAt && live) {
      // (the move played for them didn't land: try again)
      this.retryAt = now + 4000;
      play(++this.tries);
    }
    const next = show(this.clock, s);
    // The other phone owes a move, its time is gone and nothing comes (closed, frozen, asleep):
    // after a grace this phone may take the win.
    const stalled = who !== null && who !== me && next?.left === 0 && live;
    const at = pointOf(s);
    if (!stalled || this.zeroAt !== at) this.zeroSince = stalled ? now : 0;
    this.zeroAt = at;
    const claim = stalled && this.zeroSince > 0 && now - this.zeroSince >= CLAIM_GRACE_MS;
    const claimChanged = claim !== this.claimable;
    this.claimable = claim;
    // (your own clock reaching the last seconds: a short buzz, once per allowance)
    if (next && next.who === me && next.left <= URGENT_MS && this.shown && this.shown.who === me && this.shown.left > URGENT_MS) {
      try {
        navigator.vibrate?.(120);
      } catch {
        /* no vibration on this phone */
      }
    }
    const sec = (v: ClockShow | null) => (v ? `${v.who}:${Math.ceil(v.left / 1000)}:${v.bank ? 1 : 0}` : '');
    const changed = sec(next) !== sec(this.shown) || claimChanged;
    this.shown = next;
    if (sec(next) !== this.savedSec) {
      this.savedSec = sec(next);
      this.save();
    }
    if (changed) for (const cb of this.listeners) cb();
  }

  listen(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

/** Runs the clock while the duel is on (an online duel between two phones only). */
export function useClockRunner(on: boolean, duel: string, s: DuelState, moves: number, live: boolean, me: Pid, play: (attempt: number) => void): ClockRunner | null {
  const runner = useRef<ClockRunner | null>(null);
  if (on && !runner.current) runner.current = new ClockRunner(duel);
  const latest = useRef({ s, moves, live, me, play });
  latest.current = { s, moves, live, me, play };
  useEffect(() => {
    if (!on || !runner.current) return;
    const r = runner.current;
    const run = () => {
      const l = latest.current;
      r.step(l.s, l.moves, l.live, l.me, l.play);
    };
    run();
    const id = setInterval(run, 250);
    return () => clearInterval(id);
  }, [on]);
  return on ? runner.current : null;
}

/** The pill on a player's bar: shows while that player's clock runs (amber in the bank, red near zero). */
export function ClockPill({ runner, who, me }: { runner: ClockRunner; who: Pid; me: Pid }) {
  const [, redraw] = useState(0);
  useEffect(() => runner.listen(() => redraw((n) => n + 1)), [runner]);
  const v = runner.shown;
  const out = runner.out && runner.out.who === who && Date.now() - runner.out.at < 2500;
  if (out) return <span class="tclock out">Time's up</span>;
  if (!v || v.who !== who) return null;
  const urgent = v.left <= URGENT_MS;
  return (
    <span class={`tclock ${v.bank ? 'bank' : ''} ${urgent ? 'urgent' : ''}`} aria-label={who === me ? 'Your time left' : 'Their time left'} title={v.bank ? 'Reserve time' : 'Turn time'}>
      <i aria-hidden="true">⏱</i>
      {clockText(v.left)}
    </span>
  );
}

/** Over the board when the other player's time ran out and their phone went quiet: take the win. */
export function ClaimWin({ runner, name, onClaim }: { runner: ClockRunner; name: string; onClaim: () => void }) {
  const [, redraw] = useState(0);
  useEffect(() => runner.listen(() => redraw((n) => n + 1)), [runner]);
  if (!runner.claimable) return null;
  return (
    <div class="tclock-claim" role="alert">
      <span>{name}'s time ran out and their phone isn't answering.</span>
      <button onClick={onClaim}>Take the win</button>
    </div>
  );
}
