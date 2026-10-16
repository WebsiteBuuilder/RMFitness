// Which button the d-pad goes to next. Pure: tests/pad.test.ts runs it under Node.

export type Dir = 'up' | 'down' | 'left' | 'right';
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const gap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));

/**
 * The best box to move to from `from` going `dir`, or -1. Boxes ahead of `from` win by
 * how close they are along the move, and lose three times as much for being off to the side
 * (so a straight line wins over a diagonal, as in Master Duel's menus).
 */
export function pickNext(from: Box, dir: Dir, boxes: Box[]): number {
  const fx = (from.left + from.right) / 2;
  const fy = (from.top + from.bottom) / 2;
  let best = -1;
  let bestScore = Infinity;
  boxes.forEach((b, i) => {
    const cx = (b.left + b.right) / 2;
    const cy = (b.top + b.bottom) / 2;
    let along: number;
    let side: number;
    let off: number;
    if (dir === 'right' || dir === 'left') {
      const d = dir === 'right' ? cx - fx : fx - cx;
      // ahead: its center past ours, and its far edge past our far edge
      // (ahead by a real step: a card raised a few pixels out of a row isn't "down" from its neighbours)
      if (d <= Math.max(2, Math.min(from.right - from.left, b.right - b.left) * 0.25) || (dir === 'right' ? b.right <= from.right : b.left >= from.left)) return;
      along = dir === 'right' ? Math.max(0, b.left - from.right) : Math.max(0, from.left - b.right);
      side = gap(from.top, from.bottom, b.top, b.bottom);
      off = Math.abs(cy - fy);
      along += d * 0.1;
    } else {
      const d = dir === 'down' ? cy - fy : fy - cy;
      if (d <= Math.max(2, Math.min(from.bottom - from.top, b.bottom - b.top) * 0.25) || (dir === 'down' ? b.bottom <= from.bottom : b.top >= from.top)) return;
      along = dir === 'down' ? Math.max(0, b.top - from.bottom) : Math.max(0, from.top - b.bottom);
      side = gap(from.left, from.right, b.left, b.right);
      off = Math.abs(cx - fx);
      along += d * 0.1;
    }
    const score = along + side * 3 + off * 0.15;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/** The box nearest a point (where to land when the focused button went away). */
export function nearest(x: number, y: number, boxes: Box[]): number {
  let best = -1;
  let bd = Infinity;
  boxes.forEach((b, i) => {
    const dx = Math.max(b.left - x, 0, x - b.right);
    const dy = Math.max(b.top - y, 0, y - b.bottom);
    const d = dx * dx + dy * dy;
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}
