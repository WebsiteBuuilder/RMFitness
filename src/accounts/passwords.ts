// Profile passwords. Each phone keeps a salted fingerprint of the password of every
// profile on it (never the password itself), so logging in works even with no signal.
import type { Store } from './bundle';

export const PASSWORD_MIN = 4;
export const PASSWORD_MAX = 32;
const LOCKS_KEY = 'eds.locks';

interface Lock {
  salt: string;
  hash: string;
}

function readLocks(st: Store): Record<string, Lock> {
  try {
    const v = JSON.parse(st.getItem(LOCKS_KEY) ?? 'null');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function writeLocks(st: Store, l: Record<string, Lock>) {
  try {
    st.setItem(LOCKS_KEY, JSON.stringify(l));
  } catch {
    /* storage blocked */
  }
}

async function digest(s: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // No Web Crypto (an http:// test server): a slower home-made mix.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let r = 0; r < 2000; r++) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  }
  return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
}

function salt(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function hasLock(id: string, st: Store): boolean {
  return !!readLocks(st)[id];
}

export async function setLock(id: string, password: string, st: Store) {
  const s = salt();
  const hash = await digest(`${s}|${password}`);
  writeLocks(st, { ...readLocks(st), [id]: { salt: s, hash } });
}

/** true or false, or null when the profile has no password on this phone */
export async function checkLock(id: string, password: string, st: Store): Promise<boolean | null> {
  const l = readLocks(st)[id];
  if (!l) return null;
  return (await digest(`${l.salt}|${password}`)) === l.hash;
}

export function dropLock(id: string, st: Store) {
  const l = readLocks(st);
  delete l[id];
  writeLocks(st, l);
}

export function passwordProblem(pw: string): string | null {
  if (pw.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters (a 4-digit PIN is fine).`;
  if (pw.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}

/** The shared store wants 6+ characters; a 4-digit PIN is stretched the same way on every phone. */
export function cloudPassword(pw: string): string {
  return `eds-duel:${pw}`;
}

/** The sign-in id for a new account, made from the duelist name. */
export function loginFor(alias: string, n = 0): string {
  let slug = '';
  for (const ch of alias.trim().toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) slug += ch;
    else slug += '-' + ch.codePointAt(0)!.toString(16);
  }
  return `${slug || 'duelist'}${n ? `.${n}` : ''}@duelist.eds-remake.app`;
}
