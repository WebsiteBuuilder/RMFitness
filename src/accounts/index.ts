// The game's one Accounts object: shared when a Firebase config is set, phone-only otherwise.
import { firebaseConfig } from '../sync/firebaseConfig';
import { Accounts } from './accounts';
import { FirebaseBackend } from './firebaseBackend';

const store: Storage | undefined = (() => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
})();

const memory = new Map<string, string>();
const fallback: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
  getItem: (k) => memory.get(k) ?? null,
  setItem: (k, v) => void memory.set(k, v),
  removeItem: (k) => void memory.delete(k),
};

export const accounts = new Accounts(firebaseConfig ? new FirebaseBackend(firebaseConfig) : null, store ?? fallback);
export type { Tile, LoginResult, CloudState } from './accounts';
