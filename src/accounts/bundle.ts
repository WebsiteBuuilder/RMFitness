// A profile's four saves on this phone, read and written as one bundle.
import type { Bundle, BundleKey } from './backend';

export type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const BUNDLE_KEYS: Record<BundleKey, (id: string) => string> = {
  save: (id) => `eds.save.${id}`, // Eternal Duelist Soul trunk, decks, record
  speed: (id) => `eds.speed.${id}`, // Speed Duel collection, Duel Chips, decks, levels, record
  solo: (id) => `eds.speedsolo.${id}`, // Millennium Road, Labyrinth, Legends, Requests, Stamps
  online: (id) => `eds.online.${id}`, // friend code and friends list
};
const KEYS = Object.keys(BUNDLE_KEYS) as BundleKey[];

export function readBundle(id: string, st: Store): Bundle {
  const b: Bundle = {};
  for (const k of KEYS) {
    try {
      const v = st.getItem(BUNDLE_KEYS[k](id));
      if (v != null) b[k] = v;
    } catch {
      /* storage blocked */
    }
  }
  return b;
}

/** Replaces the profile's saves on this phone with the bundle (saves missing from it are cleared). */
export function writeBundle(id: string, b: Bundle, st: Store) {
  for (const k of KEYS) {
    try {
      const v = b[k];
      if (typeof v === 'string') st.setItem(BUNDLE_KEYS[k](id), v);
      else st.removeItem(BUNDLE_KEYS[k](id));
    } catch {
      /* storage full or blocked */
    }
  }
}

export function isEmpty(b: Bundle): boolean {
  return KEYS.every((k) => b[k] == null);
}

/** A short fingerprint, to tell whether a bundle changed. */
export function hashBundle(b: Bundle): string {
  let h = 0x811c9dc5;
  const s = KEYS.map((k) => `${k}=${b[k] ?? ''}`).join('\u0001');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ':' + s.length.toString(36);
}
