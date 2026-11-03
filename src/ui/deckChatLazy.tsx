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
  const [failed, setFailed] = useState(false);
  const load = () => {
    setFailed(false);
    preloadDeckChat().then(setM, () => setFailed(true));
  };
  useEffect(() => {
    if (!m) load();
  }, []);
  if (m) return <m.DeckChat {...p} />;
  // (still downloading: a moment at most, it started when the editor opened)
  if (!failed) return null;
  return (
    <div role="alert" style="position:fixed;left:50%;bottom:18%;transform:translateX(-50%);z-index:70;display:flex;flex-wrap:wrap;justify-content:center;gap:8px 10px;align-items:center;width:min(92vw,360px);padding:12px 14px;border-radius:12px;background:#0d1236f2;border:1px solid #ffffff30;color:#e8ecff;font-size:14px;box-shadow:0 8px 24px #0008">
      <span>Chat couldn't load. Check your connection.</span>
      <button class="gbtn" onClick={load}>
        Try again
      </button>
      <button class="gbtn" onClick={p.onClose}>
        Close
      </button>
    </div>
  );
}

/** Where a deck's chat is saved on the phone (DeckChat.tsx uses the same key). */
export const chatStoreKey = (deckId: string) => `eds.deckChat.${deckId}`;

/** A deleted deck's chat goes with it (its saved copy, even if the chat never opened this session). */
export function forgetDeckChat(deckId: string) {
  if (mod) return mod.forgetDeckChat(deckId);
  try {
    localStorage.removeItem(chatStoreKey(deckId));
  } catch {
    /* nothing saved */
  }
}

/** Stops the chat's running turn; false when nothing runs (or the chat never loaded). */
export const stopDeckChat = () => mod?.stopDeckChat() ?? false;
