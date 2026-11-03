// Deck chat's code (its local deck helper alone is ~190 KB) loads only when a deck editor
// opens, not with the rest of the game at startup. Same props and helpers as ./DeckChat.
import { useEffect, useState } from 'preact/hooks';
import type { ComponentProps } from 'preact';

type Mod = typeof import('./DeckChat');
let mod: Mod | null = null;
let loading: Promise<Mod> | null = null;

/** Starts the download (the deck editor calls this as it opens, so the chat is ready to tap). */
export function preloadDeckChat(): Promise<Mod> {
  return (loading ??= import('./DeckChat').then(
    (m) => (mod = m),
    (err) => {
      loading = null; // offline and not cached yet: the next open tries again
      throw err;
    },
  ));
}

export function DeckChat(p: ComponentProps<Mod['DeckChat']>) {
  const [m, setM] = useState<Mod | null>(mod);
  useEffect(() => {
    if (!m) preloadDeckChat().then(setM, () => {});
  }, []);
  return m ? <m.DeckChat {...p} /> : null;
}

/** A deleted deck's chat goes with it (its saved copy, even if the chat never opened this session). */
export function forgetDeckChat(deckId: string) {
  if (mod) return mod.forgetDeckChat(deckId);
  try {
    localStorage.removeItem(`eds.deckChat.${deckId}`);
  } catch {
    /* nothing saved */
  }
}

/** Stops the chat's running turn; false when nothing runs (or the chat never loaded). */
export const stopDeckChat = () => mod?.stopDeckChat() ?? false;
