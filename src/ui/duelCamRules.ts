// The Duel Disk camera's rules (no DOM): which moment of a batch of engine events gets a
// camera move, and the move itself as poses over time. src/ui/duelCam.ts plays them.
//
// The camera is a slight push and tilt of the whole field: it zooms a few percent toward
// the action, drifts the action toward the middle, rolls a degree toward it and pitches a
// few degrees (the far side of the table leans away, seen in perspective, as if the camera
// dips toward it). Everything is one plane-to-plane map (src/art/cam.ts), so the 3D figures
// canvas can follow it exactly.
import type { EngineEvent, Pid } from '../eds/types';
import { apply, mul, type Mat } from '../art/cam';

import type { DuelCam } from '../art/settings';

export type ShotKind = 'summon' | 'bigSummon' | 'set' | 'attack' | 'direct' | 'impact' | 'settle';

export interface Moment {
  kind: ShotKind;
  /** the card it is about (the summoned monster, the attacker) */
  uid: number;
  /** attack: its target (null: a direct attack) */
  target?: number | null;
  /** whose action: the camera rolls toward their opponent on an attack */
  player?: Pid;
}

const RANK: Record<ShotKind, number> = { settle: 0, set: 1, summon: 2, impact: 3, bigSummon: 4, attack: 5, direct: 5 };
const BIG_HOW = new Set(['tribute', 'special', 'fusion', 'ritual', 'xyz', 'synchro', 'link']);

/** The stronger of two moments (on a tie, the later one: b). */
export const stronger = (a: Moment | null, b: Moment | null): Moment | null => (!a ? b : !b ? a : RANK[b.kind] >= RANK[a.kind] ? b : a);

/**
 * The one moment of a batch the camera moves for (the strongest; on a tie the latest),
 * or null. `onField(uid)` says whether a card is in a Monster Zone now (a Spell/Trap Set
 * gets no move).
 */
export function pickMoment(events: EngineEvent[], onField: (uid: number) => boolean): Moment | null {
  let best: Moment | null = null;
  const take = (m: Moment) => {
    if (!best || RANK[m.kind] >= RANK[best.kind]) best = m;
  };
  for (const e of events) {
    if (e.uid === undefined) continue;
    const p = e.player === 0 || e.player === 1 ? e.player : undefined;
    switch (e.kind) {
      case 'summon':
        if (onField(e.uid)) take({ kind: e.how && BIG_HOW.has(e.how) ? 'bigSummon' : 'summon', uid: e.uid, player: p });
        break;
      case 'flip':
        if (onField(e.uid)) take({ kind: 'summon', uid: e.uid, player: p });
        break;
      case 'set':
        if (onField(e.uid)) take({ kind: 'set', uid: e.uid, player: p });
        break;
      case 'attack':
        take({ kind: e.target == null ? 'direct' : 'attack', uid: e.uid, target: e.target ?? null, player: p });
        break;
      case 'hit':
        // the blow lands: a short kick (an attack in the same batch keeps its own, bigger move)
        take({ kind: 'impact', uid: e.uid, player: p });
        break;
    }
  }
  return best;
}

export interface Pt {
  x: number;
  y: number;
}

export interface Pose {
  /** zoom (1 = rest) */
  zoom: number;
  /** roll, degrees (positive: clockwise) */
  roll: number;
  /** lowered camera: the field tips away by this many degrees around the focus, in perspective */
  pitch: number;
  /** the point the camera looks at (viewport px) and how far it drifts toward the field's middle (0..1) */
  focus: Pt;
  pull: number;
}

export interface Shot {
  kind: ShotKind;
  /** poses at offsets 0..1 of the shot, with its easing per segment */
  frames: { at: number; pose: Pose; ease: string }[];
  ms: number;
}

/** How strong each mode is (Soft: half the move, a little quicker). */
export const STRENGTH: Record<DuelCam, number> = { full: 1, soft: 0.5, off: 0 };

const OUT = 'cubic-bezier(.22,.8,.3,1)';
const KICK = 'cubic-bezier(.2,1.4,.4,1)';
/** the glide home: quick to leave, long and soft to arrive */
const BACK = 'cubic-bezier(.3,0,.12,1)';
/** the swing along an attack */
const SWING = 'cubic-bezier(.5,0,.2,1)';

/**
 * The move for a moment. `field` is the field's resting rectangle; `at` the card it is
 * about, `to` the attack's target (or the defending side's edge on a direct attack), both
 * resting centres. Rolls lean toward the action: right of centre rolls clockwise.
 */
export function shotFor(m: Moment | { kind: ShotKind }, field: { cx: number; cy: number; w: number; h: number }, at: Pt, strength: number, to?: Pt): Shot | null {
  if (strength <= 0) return null;
  const s = strength;
  const rest: Pose = { zoom: 1, roll: 0, pitch: 0, focus: { x: field.cx, y: field.cy }, pull: 0 };
  // which way the action sits from the field's middle (-1..1), for the roll
  const side = (p: Pt) => Math.max(-1, Math.min(1, (p.x - field.cx) / (field.w / 2 || 1)));
  const pose = (focus: Pt, zoom: number, roll: number, pitch: number, pull: number): Pose => ({ zoom: 1 + (zoom - 1) * s, roll: roll * s, pitch: pitch * s, focus, pull });
  // after the peak the camera keeps creeping in a touch (never a dead stop), then glides back out
  const creep = (p: Pose, more: number): Pose => ({ ...p, zoom: p.zoom + more * s, pitch: p.pitch + more * 60 * s });
  switch (m.kind) {
    case 'set': {
      const p = pose(at, 1.012, 0.3 * side(at), 4, 0.2);
      return { kind: m.kind, ms: 700, frames: [{ at: 0, pose: rest, ease: OUT }, { at: 0.35, pose: p, ease: BACK }, { at: 1, pose: rest, ease: 'linear' }] };
    }
    case 'summon': {
      const p = pose(at, 1.035, 0.8 * side(at), 11, 0.25);
      return { kind: m.kind, ms: 1300, frames: [{ at: 0, pose: rest, ease: OUT }, { at: 0.3, pose: p, ease: 'linear' }, { at: 0.48, pose: creep(p, 0.005), ease: BACK }, { at: 1, pose: rest, ease: 'linear' }] };
    }
    case 'bigSummon': {
      // a deeper dip, with a small extra push as it lands
      const p1 = pose(at, 1.05, 1.1 * side(at), 14, 0.3);
      const p2 = pose(at, 1.06, 1.2 * side(at), 15, 0.3);
      return { kind: m.kind, ms: 1650, frames: [{ at: 0, pose: rest, ease: OUT }, { at: 0.28, pose: p1, ease: KICK }, { at: 0.4, pose: p2, ease: 'linear' }, { at: 0.55, pose: creep(p2, 0.004), ease: BACK }, { at: 1, pose: rest, ease: 'linear' }] };
    }
    case 'attack':
    case 'direct': {
      // two beats: the camera leans on the attacker, then swings along the attack to the target
      const tgt = to ?? { x: field.cx, y: field.cy - field.h / 2 };
      const lean = Math.max(-1, Math.min(1, (tgt.x - at.x) / (field.w / 2 || 1)));
      const p1 = pose(at, 1.03, 0.5 * lean + 0.4 * side(at), 9, 0);
      const p2 = pose(tgt, 1.055, 1.4 * lean + 0.3 * side(tgt), 13, 0);
      return { kind: m.kind, ms: 1550, frames: [{ at: 0, pose: rest, ease: OUT }, { at: 0.24, pose: p1, ease: SWING }, { at: 0.46, pose: p2, ease: 'linear' }, { at: 0.6, pose: creep(p2, 0.005), ease: BACK }, { at: 1, pose: rest, ease: 'linear' }] };
    }
    case 'impact': {
      const p = pose(at, 1.02, 0.6 * side(at), 5, 0);
      return { kind: m.kind, ms: 560, frames: [{ at: 0, pose: rest, ease: KICK }, { at: 0.2, pose: p, ease: BACK }, { at: 1, pose: rest, ease: 'linear' }] };
    }
    case 'settle': {
      // a cinematic just handed the board back: a short lean in where it ended, then back out
      const p = pose(at, 1.02, 0.5 * side(at), 7, 0.2);
      return { kind: m.kind, ms: 900, frames: [{ at: 0, pose: rest, ease: OUT }, { at: 0.26, pose: p, ease: BACK }, { at: 1, pose: rest, ease: 'linear' }] };
    }
  }
}

/** A pose eased toward rest by k (0 = rest, 1 = the pose as planned). */
export const scalePose = (p: Pose, k: number): Pose => ({ zoom: 1 + (p.zoom - 1) * k, roll: p.roll * k, pitch: p.pitch * k, focus: p.focus, pull: p.pull * k });

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The pose, scaled back just enough that the field's corners stay inside the screen's free
 * area (between the Life Points bars, inside the screen sides, `slack` px of give on the
 * sides): a corner already past an edge at rest may not go further out. One small search a
 * pose, once a shot.
 */
export function fitPose(p: Pose, field: { cx: number; cy: number; w: number; h: number }, content: Bounds, safe: Bounds, slack = 6): Pose {
  const corners: [number, number][] = [[content.left, content.top], [content.right, content.top], [content.left, content.bottom], [content.right, content.bottom]];
  const lim = { l: Math.min(content.left, safe.left - slack), r: Math.max(content.right, safe.right + slack), t: Math.min(content.top, safe.top), b: Math.max(content.bottom, safe.bottom) };
  const fits = (q: Pose) => {
    const m = poseMatrix(q, field);
    return corners.every(([x, y]) => {
      const [u, v] = apply(m, x, y);
      return u >= lim.l - 0.5 && u <= lim.r + 0.5 && v >= lim.t - 0.5 && v <= lim.b + 0.5;
    });
  };
  if (fits(p)) return p;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 7; i++) {
    const k = (lo + hi) / 2;
    if (fits(scalePose(p, k))) lo = k;
    else hi = k;
  }
  return scalePose(p, lo);
}

/** Perspective distance of the camera, from the field's size (px). */
export const persp = (field: { w: number; h: number }): number => Math.max(field.w, field.h) * 1.25;

/** A pose as one viewport-space homography (src/art/cam.ts): tilt in perspective about the focus, then push, roll and drift. */
export function poseMatrix(p: Pose, field: { cx: number; cy: number; w: number; h: number }): Mat {
  const F = p.focus;
  // pitch about the horizontal line through F: X = D·dx + Fx·w, Y = D·cosθ·dy + Fy·w, w = D − sinθ·dy
  const th = (p.pitch * Math.PI) / 180;
  const D = persp(field);
  const ct = Math.cos(th);
  const st = Math.sin(th);
  const P: Mat = [D, 0, -D * F.x, 0, D * ct, -D * ct * F.y, 0, -st, D + st * F.y];
  // P sends F to (D·Fx', ..) / w: shift so F stays put: w(F) = D, X(F) = 0 → add F·w
  const Pf: Mat = [P[0] + F.x * P[6], P[1] + F.x * P[7], P[2] + F.x * P[8], P[3] + F.y * P[6], P[4] + F.y * P[7], P[5] + F.y * P[8], P[6], P[7], P[8]];
  const r = (p.roll * Math.PI) / 180;
  const a = Math.cos(r) * p.zoom;
  const b = Math.sin(r) * p.zoom;
  // the focus F lands at F + (C − F)·pull
  const fx = F.x + (field.cx - F.x) * p.pull;
  const fy = F.y + (field.cy - F.y) * p.pull;
  const A: Mat = [a, -b, fx - (a * F.x - b * F.y), b, a, fy - (b * F.x + a * F.y), 0, 0, 1];
  const m = mul(A, Pf);
  const k = m[8] || 1;
  return m.map((v) => v / k) as Mat;
}

export { cssOf as cssMatrix } from '../art/cam';
