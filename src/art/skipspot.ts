// Where the art stage's skip pill goes in the opponent's bar (pure: tested in tests/flow.test.ts).

/** the skip pill's width (art.css) */
export const SKIP_W = 116;

/**
 * Where the skip pill goes in a bar spanning `left`..`right` whose contents cover
 * these [left, right] spans: in the free gap nearest the centre of a `vw` wide
 * screen (as central as the gap allows), or, with no gap wide enough, below the
 * bar, centred.
 */
export function skipSpot(obstacles: [number, number][], left: number, right: number, vw: number, w = SKIP_W): { left: number; below: boolean } {
  const obs = [...obstacles].sort((a, b) => a[0] - b[0]);
  const mid = vw / 2;
  let best: { left: number; d: number } | null = null;
  let x = Math.max(4, left);
  for (const [a, b] of [...obs, [Math.min(vw - 4, right), Infinity] as [number, number]]) {
    if (a - x >= w) {
      const l = Math.max(x, Math.min(a - w, mid - w / 2));
      const d = Math.abs(l + w / 2 - mid);
      if (!best || d < best.d) best = { left: l, d };
    }
    x = Math.max(x, b);
  }
  return best ? { left: best.left, below: false } : { left: Math.max(4, mid - w / 2), below: true };
}
