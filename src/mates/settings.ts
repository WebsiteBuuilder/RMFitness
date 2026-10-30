// The Mates setting on this phone: both Mates, only your own, or none.
import { useEffect, useState } from 'preact/hooks';

export type MatesShown = 'on' | 'mine' | 'off';
const KEY = 'eds.mates';
const EVT = 'eds-mates';

export function matesShown(): MatesShown {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'mine' || v === 'off' ? v : 'on';
  } catch {
    return 'on';
  }
}

export function setMatesShown(v: MatesShown) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* storage blocked */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVT));
}

export const NEXT_SHOWN: Record<MatesShown, MatesShown> = { on: 'mine', mine: 'off', off: 'on' };
export const SHOWN_LABEL: Record<MatesShown, string> = { on: 'On', mine: 'Only mine', off: 'Off' };

export function useMatesShown(): MatesShown {
  const [v, setV] = useState(matesShown);
  useEffect(() => {
    const on = () => setV(matesShown());
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);
  return v;
}
