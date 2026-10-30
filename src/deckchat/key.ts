// The duelist's Anthropic API key for deck chat: kept on this phone only (localStorage),
// never in the save, the cloud backup or the code.
const KEY = 'eds.claudeKey';
let mem = '';

export function chatKey(): string {
  try {
    return localStorage.getItem(KEY) ?? mem;
  } catch {
    return mem;
  }
}

export function setChatKey(k: string) {
  mem = k.trim();
  try {
    if (mem) localStorage.setItem(KEY, mem);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: it lasts until the game closes */
  }
}

/** Looks like an Anthropic API key (sk-ant-...). */
export const looksLikeKey = (k: string) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k.trim());
