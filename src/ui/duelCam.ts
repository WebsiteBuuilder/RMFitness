// The Duel Disk camera: on a summon, an attack or a blow the field pushes in a few percent
// toward the action, rolls a degree toward it and tips the far side away, then eases back, so the
// field feels like a 3D table filmed from a moving camera (Master Duel style). The Life
// Points bars and the hands stay put, as a screen's HUD does.
//
// Only what moves with the field moves: the field box itself, the 3D figures canvas
// (.art-board) and the flat copies drawn over the figures (the turn row, counter badges),
// all by the same 2D map (src/art/cam.ts), so the figures stand on their cards all the way.
// While a cinematic plays the camera keeps still (the cinematic is the camera then) and,
// as the stage hands the board back, eases out from close in.
//
// Kept cheap for phones: one compositor-only `transform` animation per element (WAAPI), no
// per-frame script, no layout reads during a shot (the resting places are measured once
// as it starts), nothing at all with the camera Off.
import { useEffect, useRef } from 'preact/hooks';
import type { DuelState } from '../eds/types';
import { getAnimSpeed, useDuelCam as useCamMode } from '../art/settings';
import { IDENTITY, camLive, setCamLive, unmapRect, type Mat } from '../art/cam';
import { STRENGTH, blowFrom, cssMatrix, fitPose, type Pose, pickMoment, type Bounds, stronger, poseMatrix, shotFor, type Moment, type Pt, type Shot } from './duelCamRules';

/** The flat layers over the figures that ride along (fixed-position: their resting top-left is offsetLeft/Top). */
const RIDERS = '.art-board, .ctrfloat, .tmid-float';
/** No shots while the field swings in as the duel opens (arena.css tmat-in). */
const OPENING_MS = 1100;
/** Easing back when a cinematic starts mid-shot. */
const BACK_MS = 180;
/** A batch shown this soon after a cinematic was what it covered: a settle, not a second full move. */
const SETTLE_WINDOW_MS = 700;
/** More events than this at once is a jump ahead, not play. */
const MAX_BATCH = 16;

interface Live {
  anims: Animation[];
  els: HTMLElement[];
  kind: string;
  /** the move's strongest pose (a blow during an attack punches in past it) */
  peak?: Pose;
}

/** Some ancestor of el (up to the duel screen) has a transform of its own. */
function tiltedAbove(el: HTMLElement): boolean {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const t = getComputedStyle(p).transform;
    if (t && t !== 'none') return true;
    if (p.classList.contains('duel')) break;
  }
  return false;
}

/** The free area for the field: between the two Life Points bars when they run across the screen (phones), else the whole screen. */
function safeArea(): Bounds {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const out: Bounds = { left: 0, top: 0, right: w, bottom: h };
  const top = document.querySelector('.duel .tbar.top, .duel .pbar.top')?.getBoundingClientRect();
  const bot = document.querySelector('.duel .tbar.bottom, .duel .pbar:not(.top)')?.getBoundingClientRect();
  if (top && top.width > w * 0.6) out.top = top.bottom;
  if (bot && bot.width > w * 0.6) out.bottom = bot.top;
  // the turn tab over the bottom bar and the hand fan (big screens) are HUD too
  // (and a choice sheet open over the lower field: the camera keeps what is above it in view)
  for (const sel of ['.duel .ttab.bottom', '.duel .thand', '.duel .tsheet']) {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    if (r && r.height > 0 && r.top > h * 0.3) out.bottom = Math.min(out.bottom, r.top);
  }
  const tt = document.querySelector('.duel .ttab.top')?.getBoundingClientRect();
  if (tt && tt.height > 0 && tt.bottom < h / 2) out.top = Math.max(out.top, tt.bottom);
  return out;
}

const artOn = () => typeof document !== 'undefined' && document.body.classList.contains('art-on');

/**
 * Runs the camera on a duel screen: `root` is the screen, `fieldSel` its field box
 * (Touch: .tboard, Classic: .field), `state` the board shown.
 */
export function useDuelCam(root: { current: HTMLElement | null }, state: DuelState, fieldSel: string): void {
  const mode = useCamMode();
  const lastSeq = useRef<number | null>(null);
  const born = useRef(typeof performance !== 'undefined' ? performance.now() : 0);
  const live = useRef<Live | null>(null);
  /** a moment that happened under a cinematic: the camera settles out from it when the stage lets go */
  const pending = useRef<Moment | null>(null);
  /** when the last cinematic let go of the board */
  const artOffAt = useRef(-1e9);
  /** the field sits inside a tilted parent (measured once, again after a resize) */
  const tilted = useRef<boolean | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const fieldEl = () => root.current?.querySelector<HTMLElement>(fieldSel) ?? null;
  const zoneEl = (uid: number) => fieldEl()?.querySelector<HTMLElement>(`[data-uid="${uid}"]`) ?? null;

  /** Stops the shot where it is (each element keeps its pose until the next animation takes over) → the poses it was at. */
  const freeze = (): Map<HTMLElement, string> => {
    const at = new Map<HTMLElement, string>();
    const l = live.current;
    if (!l) return at;
    for (const el of l.els) at.set(el, getComputedStyle(el).transform);
    for (const a of l.anims) a.cancel();
    return at;
  };

  const done = (l: Live) => {
    if (live.current !== l) return;
    live.current = null;
    for (const el of l.els) el.style.transformOrigin = '';
    setCamLive(null);
  };

  /** Plays keyframes (viewport-space poses) on the field and its riders. */
  const run = (kind: string, peak: Pose | undefined, field: HTMLElement, rest: DOMRect, poses: { at: number; m: Mat; ease: string }[], ms: number, from: Map<HTMLElement, string>) => {
    const els: HTMLElement[] = [field];
    document.querySelectorAll<HTMLElement>(RIDERS).forEach((el) => el.isConnected && els.push(el));
    const anims: Animation[] = [];
    const css = poses.map((p) => cssMatrix(p.m));
    for (const el of els) {
      // every element pivots on the viewport's corner, so one matrix moves them all alike
      // (interpolated once, the same way, on every element: they never drift apart mid-move)
      const ox = el === field ? rest.left : el.offsetLeft;
      const oy = el === field ? rest.top : el.offsetTop;
      el.style.transformOrigin = `${-ox}px ${-oy}px`;
      const frames: Keyframe[] = poses.map((p, i) => ({
        offset: p.at,
        easing: p.ease,
        transform: i === 0 && from.has(el) ? from.get(el)! : css[i],
      }));
      anims.push(el.animate(frames, { duration: ms }));
    }
    const l: Live = { anims, els, kind, peak };
    live.current = l;
    setCamLive({ el: field });
    anims[0].onfinish = () => done(l);
    anims[0].oncancel = () => done(l);
  };

  /** The field's resting box and centre (measured at rest; during a shot, mapped back). */
  const restBox = useRef<DOMRect | null>(null);
  const restOf = (field: HTMLElement): DOMRect => {
    if (camLive() && restBox.current) return restBox.current;
    const r = field.getBoundingClientRect();
    const b = camLive() ? unmapRect(r) : r;
    return (restBox.current = new DOMRect(b.left, b.top, b.width, b.height));
  };

  const centre = (uid: number | null | undefined): Pt | null => {
    if (uid == null) return null;
    const el = zoneEl(uid);
    if (!el) return null;
    const r = unmapRect(el.getBoundingClientRect());
    return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  };

  const play = (m: Moment, settle: boolean) => {
    const field = fieldEl();
    const strength = STRENGTH[modeRef.current];
    if (!field || strength <= 0 || typeof field.animate !== 'function') return;
    // (a field already leaning in 3D inside a tilted parent, the Classic big-screen layout, keeps still:
    // the figures canvas could not follow a move inside that tilt)
    if ((tilted.current ??= tiltedAbove(field))) return;
    // (one settle per hand-back: the batch arriving right after it does not start another;
    // an attack's move already lands its blow: the hit that follows does not cut it short)
    if (live.current && settle && live.current.kind !== 'rest') return;
    const rest = restOf(field);
    const box = { cx: rest.left + rest.width / 2, cy: rest.top + rest.height / 2, w: rest.width, h: rest.height };
    // (a monster the blow destroyed has left its zone: the camera looks at what is still there)
    const fight = m.kind === 'attack' || m.kind === 'direct' || m.kind === 'impact';
    const at = centre(m.uid) ?? (fight ? (centre(m.target) ?? { x: box.cx, y: box.cy }) : null);
    if (!at) return;
    let to: Pt | undefined;
    if (m.kind === 'attack') to = centre(m.target) ?? undefined;
    // a direct attack: toward the defending duelist's edge of the field
    if (m.kind === 'direct') to = { x: box.cx, y: at.y > box.cy ? rest.top + rest.height * 0.06 : rest.bottom - rest.height * 0.06 };
    // after a cinematic the camera settles out from where the action ended; a blow landing during
    // its attack's move punches in past that move's peak (never an ease back out)
    const cur = live.current;
    const shot: Shot | null = settle
      ? shotFor({ kind: 'settle' }, box, m.kind === 'attack' || m.kind === 'direct' ? (to ?? at) : at, strength)
      : m.kind === 'impact' && cur?.peak && (cur.kind === 'attack' || cur.kind === 'direct')
        ? blowFrom(cur.peak, strength)
        : shotFor(m, box, at, strength, to);
    if (!shot) return;
    const from = freeze();
    const speed = Math.sqrt(getAnimSpeed());
    // the field never slides under the Life Points bars or off the screen's sides
    const content = unmapRect((field.querySelector('.tmat') ?? field).getBoundingClientRect());
    const safe = safeArea();
    const fitted = shot.frames.map((f) => ({ ...f, pose: fitPose(f.pose, box, content, safe) }));
    const peak = fitted.reduce((a, f) => (f.pose.zoom > a.zoom ? f.pose : a), fitted[0].pose);
    const poses = fitted.map((f) => ({ at: f.at, m: poseMatrix(f.pose, box), ease: f.ease }));
    run(shot.kind, peak, field, rest, poses, Math.round(shot.ms / speed), from);
  };

  /** A cinematic is starting: back to rest at once, quickly. */
  const toRest = () => {
    const l = live.current;
    const field = fieldEl();
    if (!l || !field) return;
    const rest = restOf(field);
    const from = freeze();
    run('rest', undefined, field, rest, [{ at: 0, m: IDENTITY, ease: 'ease-out' }, { at: 1, m: IDENTITY, ease: 'linear' }], BACK_MS, from);
  };

  // new events on the board shown: the strongest moment gets a shot
  const evs = state.events ?? [];
  const top = evs.length ? evs[evs.length - 1].seq : 0;
  useEffect(() => {
    const last = lastSeq.current;
    lastSeq.current = top;
    // first look (or a rebuilt duel): nothing replays
    if (last === null || top <= last) return;
    if (modeRef.current === 'off' || document.hidden) return;
    if (performance.now() - born.current < OPENING_MS) return;
    const fresh = evs.filter((e) => e.seq > last);
    // a jump ahead (a replay seeking, a rejoined duel catching up) is not a moment to film
    if (fresh.length > MAX_BATCH) return;
    const m = pickMoment(fresh, (uid) => !!zoneEl(uid)?.matches('.tz-m, .z-m'));
    if (!m) return;
    // the board catching up with a cinematic it waited behind: the camera settles out of it
    if (artOn()) pending.current = stronger(pending.current, m);
    else play(m, performance.now() - artOffAt.current < SETTLE_WINDOW_MS);
  }, [top]);

  // a cinematic starts (body.art-on): the camera goes still; it ends: the camera settles out
  // from the moment it covered (one observer on the body's class, no polling)
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    let was = artOn();
    const mo = new MutationObserver(() => {
      const on = artOn();
      if (on === was) return;
      was = on;
      if (on) return toRest();
      artOffAt.current = performance.now();
      const m = pending.current;
      pending.current = null;
      if (m && modeRef.current !== 'off') requestAnimationFrame(() => !artOn() && play(m, true));
    });
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  // the screen turned or resized: a shot's pivot and resting places are stale, so it stops where it is
  useEffect(() => {
    let vw = window.innerWidth;
    let vh = window.innerHeight;
    const on = () => {
      const small = window.innerWidth === vw && Math.abs(window.innerHeight - vh) < vh * 0.15;
      vw = window.innerWidth;
      vh = window.innerHeight;
      tilted.current = null;
      const l = live.current;
      // (the browser's bar sliding in or out on a phone: ease home; a real resize or a turn: stop now)
      if (l && small) return toRest();
      restBox.current = null;
      if (l) {
        for (const a of l.anims) a.cancel();
        done(l);
      }
    };
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  // the camera switched off, or the screen closes: back to rest
  useEffect(() => {
    const l = live.current;
    if (mode === 'off' && l) {
      for (const a of l.anims) a.cancel();
      done(l);
    }
  }, [mode]);
  useEffect(
    () => () => {
      const l = live.current;
      if (l) {
        for (const a of l.anims) a.cancel();
        done(l);
      }
    },
    [],
  );
}
