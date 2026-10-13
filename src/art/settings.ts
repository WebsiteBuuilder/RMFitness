// The player's cinematic settings (stored on the device, like every other duel option).
//   Cinematics: which moments get a 3D cinematic.
//   Animation speed: how fast they play.
// The old single "3D Animations: Full / Fast / Off" option (eds.art3d) carries over:
// Off stays off, Fast becomes 1.5×.
import { useEffect, useState } from 'preact/hooks';

export type Cinematics = 'big' | 'all' | 'mine' | 'off';
export type AnimSpeed = 1 | 1.5 | 2;

const CINE_KEY = 'eds.cinematics';
const SPEED_KEY = 'eds.animSpeed';
const LEGACY_KEY = 'eds.art3d';
const EVT = 'eds-art3d';

export const CINEMATICS_NAMES: Record<Cinematics, string> = {
  big: 'Big moments',
  all: 'All',
  mine: 'My actions only',
  off: 'Off',
};
const CINE_ORDER: Cinematics[] = ['big', 'all', 'mine', 'off'];
const SPEED_ORDER: AnimSpeed[] = [1, 1.5, 2];

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null; // storage blocked
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage blocked */
  }
  window.dispatchEvent(new Event(EVT));
};

export function getCinematics(): Cinematics {
  const v = read(CINE_KEY);
  if (v && (CINE_ORDER as string[]).includes(v)) return v as Cinematics;
  return read(LEGACY_KEY) === 'off' ? 'off' : 'big';
}

export function getAnimSpeed(): AnimSpeed {
  const v = Number(read(SPEED_KEY));
  if ((SPEED_ORDER as number[]).includes(v)) return v as AnimSpeed;
  return read(LEGACY_KEY) === 'fast' ? 1.5 : 1;
}

export const setCinematics = (v: Cinematics) => write(CINE_KEY, v);
export const setAnimSpeed = (v: AnimSpeed) => write(SPEED_KEY, String(v));
export const nextCinematics = (v: Cinematics): Cinematics => CINE_ORDER[(CINE_ORDER.indexOf(v) + 1) % CINE_ORDER.length];
export const nextAnimSpeed = (v: AnimSpeed): AnimSpeed => SPEED_ORDER[(SPEED_ORDER.indexOf(v) + 1) % SPEED_ORDER.length];

function useStored<T>(get: () => T): T {
  const [v, setV] = useState(get);
  useEffect(() => {
    const on = () => setV(get);
    window.addEventListener(EVT, on);
    window.addEventListener('storage', on);
    return () => (window.removeEventListener(EVT, on), window.removeEventListener('storage', on));
  }, []);
  return v;
}

export const useCinematics = () => useStored(getCinematics);
export const useAnimSpeed = () => useStored(getAnimSpeed);

/** The two duel-menu items (Speed Duel): tap to cycle each. */
export function useCinematicsMenu(): { label: string; note: string; onPick: () => void }[] {
  const cine = useCinematics();
  const speed = useAnimSpeed();
  return [
    { label: `Cinematics: ${CINEMATICS_NAMES[cine]}`, note: 'tap to change', onPick: () => setCinematics(nextCinematics(cine)) },
    { label: `Animation speed: ${speed}×`, note: 'tap to change', onPick: () => setAnimSpeed(nextAnimSpeed(speed)) },
  ];
}
