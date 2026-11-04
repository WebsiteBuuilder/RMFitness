// The Duel Disk camera's rules (no DOM): which moment of a batch of engine events gets a
// camera move, and the move itself as poses over time. src/ui/duelCam.ts plays them.
//
// The camera is a slight push and tilt of the whole field: it zooms a few percent toward
// the action, drifts the action toward the middle, rolls a degree toward it and pitches a
// few degrees (the far side of the table leans away, seen in perspective, as if the camera
// dips toward it). Everything is one plane-to-plane map (src/art/cam.ts), so the 3D figures
// canvas can follow it exactly.
import type { EngineEvent, Pid } from '../eds/types';
import { mul, type Mat } from '../art/cam';

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
const IN_OUT = 'cubic-bezier(.45,0,.25,1)';
const KICK = 'cubic-bezier(.2,1.4,.4,1)';

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
  switch (m.kind) {
    case 'set': {
      const p = pose(at, 1.018, 0.25 * side(at), 1.5, 0.3);
      return { kind: m.kind, ms: 640, frames: [{ at: 0, pose: rest, ease: OUT }, { at: 0.35, pose: p, ease: IN_OUT }, { at: 1, pose: rest, ease: 'linear' }] };
    }
    case 'summon': {
      const p = pose(at, 1.05, 0.7 * side(at), 5, 0.35);
      return { kind: m.kind, ms: 1250, frames: [{ at: 0, pose: rest, ease: OUT }, { at: 0.34, pose: p, ease: 'linear' }, { at: 0.5, pose: p, ease: IN_OUT }, { at: 1, pose: rest, ease: 'linear' }] };
    }
    case 'bigSummon': {
      // a bigger push and a lower camera, with a small extra push as it lands
      const p1 = pose(at, 1.075, 1.0 * side(at), 8, 0.45);
      const p2 = pose(at, 1.085, 1.1 * side(at), 9, 0.45);
      return { kind: m.kind, ms: 1600, frames: [{ at: 0, pose: rest, ease: OUT }, { at: 0.3, pose: p1, ease: KICK }, { at: 0.42, pose: p2, ease: 'linear' }, { at: 0.58, pose: p2, ease: IN_OUT }, { at: 1, pose: rest, ease: 'linear' }] };
    }
    case 'attack':
    case 'direct': {
      // the camera looks along the attack: at the middle of the line, rolled toward the target
      const tgt = to ?? { x: field.cx, y: field.cy - field.h / 2 };
      const mid = { x: at.x * 0.45 + tgt.x * 0.55, y: at.y * 0.45 + tgt.y * 0.55 };
      const lean = Math.max(-1, Math.min(1, (tgt.x - at.x) / (field.w / 2 || 1)));
      const p1 = pose(mid, 1.06, 1.2 * lean + 0.3 * side(mid), 7, 0.4);
      const p2 = pose(mid, 1.075, 1.4 * lean + 0.3 * side(mid), 8, 0.45);
      return { kind: m.kind, ms: 1500, frames: [{ at: 0, pose: rest, ease: OUT }, { at: 0.3, pose: p1, ease: 'linear' }, { at: 0.55, pose: p2, ease: IN_OUT }, { at: 1, pose: rest, ease: 'linear' }] };
    }
    case 'impact': {
      const p = pose(at, 1.03, 0.6 * side(at), 3, 0.2);
      return { kind: m.kind, ms: 520, frames: [{ at: 0, pose: rest, ease: KICK }, { at: 0.22, pose: p, ease: IN_OUT }, { at: 1, pose: rest, ease: 'linear' }] };
    }
    case 'settle': {
      // a cinematic just handed the board back: a short lean in where it ended, then back out
      const p = pose(at, 1.03, 0.5 * side(at), 3, 0.3);
      return { kind: m.kind, ms: 820, frames: [{ at: 0, pose: rest, ease: OUT }, { at: 0.28, pose: p, ease: IN_OUT }, { at: 1, pose: rest, ease: 'linear' }] };
    }
  }
}

/** Perspective distance of the camera, from the field's size (px). */
export const persp = (field: { w: number; h: number }): number => Math.max(field.w, field.h) * 2.2;

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
