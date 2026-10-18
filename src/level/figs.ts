// Which cards have a figure matte (public/cards/fig/<id>.webp, the monster cut out of its art,
// covering ART_BOX in src/art/depth.ts). Overframe and Millennium cards lift that cut-out
// out of the card, so the monster's own outline steps over the frame, not a rectangle.
import { useEffect, useState } from 'preact/hooks';
import { card } from '../eds/db';

const BASE = import.meta.env?.BASE_URL ?? '/';
let ids: Set<string> | null = null;
let loading: Promise<void> | null = null;
const waiting = new Set<() => void>();

function load(): void {
  loading ??= fetch(`${BASE}cards/fig/index.json`)
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))
    .then((j: Record<string, unknown>) => {
      ids = new Set(Object.keys(j));
      for (const f of waiting) f();
      waiting.clear();
    });
}

/** The card's figure matte, or null (no matte, or the list isn't loaded yet). */
export function figUrl(name: string): string | null {
  const id = card(name)?.id;
  return ids && id && ids.has(String(id)) ? `${BASE}cards/fig/${id}.webp` : null;
}

/** Re-renders the caller once the matte list arrives (only while `want` is set). */
export function useFigs(want: boolean): void {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!want || ids) return;
    load();
    const f = () => tick((n) => n + 1);
    waiting.add(f);
    return () => void waiting.delete(f);
  }, [want]);
}
