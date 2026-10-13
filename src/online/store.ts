// Each profile's friend code and friends list, kept on this phone.
import { newFriendCode } from './protocol';
import type { OnlineData } from './presence';

const key = (profileId: string) => `eds.online.${profileId}`;

export function loadOnline(profileId: string, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): OnlineData {
  try {
    const raw = storage.getItem(key(profileId));
    if (raw) {
      const d = JSON.parse(raw) as Partial<OnlineData>;
      if (typeof d.code === 'string' && d.code.length === 6) return { code: d.code, friends: Array.isArray(d.friends) ? d.friends : [], ignored: Array.isArray(d.ignored) ? d.ignored : [] };
    }
  } catch {
    /* a broken entry gets a fresh code below */
  }
  const fresh: OnlineData = { code: newFriendCode(), friends: [], ignored: [] };
  writeOnline(profileId, fresh, storage);
  return fresh;
}

export function writeOnline(profileId: string, d: OnlineData, storage: Pick<Storage, 'setItem'> = localStorage) {
  try {
    storage.setItem(key(profileId), JSON.stringify(d));
  } catch {
    /* storage full or blocked: the list lives for this visit */
  }
}
