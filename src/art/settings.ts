// The player's cinematic settings (stored on the device, like every other duel option).
//   Cinematics: which moments get a 3D cinematic.
//   Animation speed: how fast they play.
// The old single "3D Animations: Full / Fast / Off" option (eds.art3d) carries over:
// Off stays off, Fast becomes 1.5×.
import { useEffect, useState } from 'preact/hooks';
import type { MangaMode } from './mangaRules';

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

// ---------- Performance: Auto / Lite / Full ----------
// Lite switches off the costly extras (3D cinematics, holograms, idle life, manga panels, blurred
// glass) and draws the 3D stage smaller. Auto can turn it on after sustained trouble; Full
// keeps the complete presentation and is the default so the game never silently loses its identity.
export type PerfMode = 'auto' | 'lite' | 'full';
const PERF_KEY = 'eds.perf';
const PERF_AUTO_KEY = 'eds.perfAuto';
const PERF_ORDER: PerfMode[] = ['auto', 'lite', 'full'];
export const PERF_NAMES: Record<PerfMode, string> = { auto: 'Auto', lite: 'Lite', full: 'Full' };

export function getPerf(): PerfMode {
  const v = read(PERF_KEY);
  return v && (PERF_ORDER as string[]).includes(v) ? (v as PerfMode) : 'full';
}
const computeLite = () => {
  const m = getPerf();
  return m === 'lite' || (m === 'auto' && read(PERF_AUTO_KEY) === '1');
};
// Read on every frame by the art code, so it is cached and refreshed when a setting changes.
let liteNow = computeLite();
if (typeof window !== 'undefined') {
  const refresh = () => void (liteNow = computeLite());
  window.addEventListener(EVT, refresh);
  window.addEventListener('storage', refresh);
}
/** Is the phone running the cut-down graphics right now? */
export const isLite = (): boolean => liteNow;
export const setPerf = (v: PerfMode) => {
  if (v === 'auto') {
    try {
      localStorage.removeItem(PERF_AUTO_KEY); // a fresh start: the watchdog judges again
    } catch {
      /* storage blocked */
    }
  }
  write(PERF_KEY, v);
};
export const nextPerf = (v: PerfMode): PerfMode => PERF_ORDER[(PERF_ORDER.indexOf(v) + 1) % PERF_ORDER.length];
/** The watchdog saw sustained slow frames: in Auto, Lite stays on for this device from now on. Returns true when it just switched. */
export function noteJank(): boolean {
  if (getPerf() !== 'auto' || read(PERF_AUTO_KEY) === '1') return false;
  try {
    localStorage.setItem(PERF_AUTO_KEY, '1');
  } catch {
    return false;
  }
  window.dispatchEvent(new Event(EVT));
  return true;
}

export function getCinematics(): Cinematics {
  if (liteNow) return 'off';
  const v = read(CINE_KEY);
  if (v && (CINE_ORDER as string[]).includes(v)) return v as Cinematics;
  return read(LEGACY_KEY) === 'off' ? 'off' : 'big';
}

export function getAnimSpeed(): AnimSpeed {
  const v = Number(read(SPEED_KEY));
  if ((SPEED_ORDER as number[]).includes(v)) return v as AnimSpeed;
  return read(LEGACY_KEY) === 'fast' ? 1.5 : 1;
}

const HOLO_KEY = 'eds.holo';
/** Holographic summons (monsters rise out of their card as a Duel Disk hologram, then solidify): on unless turned off. */
export const getHolo = (): boolean => !liteNow && read(HOLO_KEY) !== 'off';
export const setHolo = (on: boolean) => write(HOLO_KEY, on ? 'on' : 'off');
/** Motion kept calm (the phone's Reduce motion): no signal tearing or flicker on the holograms. */
let calmQuery: MediaQueryList | null | undefined;
export const calmMotion = (): boolean => {
  if (calmQuery === undefined) calmQuery = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  return !!calmQuery?.matches;
};

const IDLE_KEY = 'eds.idle';
/** Monster idle life is opt-in because it continuously animates the board and costs frames. */
export const getIdle = (): boolean => !liteNow && read(IDLE_KEY) === 'on';
export const setIdle = (on: boolean) => write(IDLE_KEY, on ? 'on' : 'off');

const MANGA_KEY = 'eds.manga';
const MANGA_ORDER: MangaMode[] = ['big', 'all', 'off'];
export const MANGA_NAMES: Record<MangaMode, string> = { big: 'Big hits', all: 'Every hit', off: 'Off' };
/** Manga attack panels (mangaRules.ts): on big hits unless changed. */
export function getManga(): MangaMode {
  if (liteNow) return 'off';
  const v = read(MANGA_KEY);
  return v && (MANGA_ORDER as string[]).includes(v) ? (v as MangaMode) : 'big';
}
export const setManga = (v: MangaMode) => write(MANGA_KEY, v);
export const nextManga = (v: MangaMode): MangaMode => MANGA_ORDER[(MANGA_ORDER.indexOf(v) + 1) % MANGA_ORDER.length];

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
export const useHolo = () => useStored(getHolo);
export const useIdle = () => useStored(getIdle);
export const useManga = () => useStored(getManga);
export const usePerf = () => useStored(getPerf);
export const useLite = () => useStored(isLite);
/** Calls back whenever a cinematic setting changes on this phone (or in another tab); returns the unsubscribe. */
export function onArtSettings(cb: () => void): () => void {
  window.addEventListener(EVT, cb);
  window.addEventListener('storage', cb);
  return () => (window.removeEventListener(EVT, cb), window.removeEventListener('storage', cb));
}

/** The duel-menu items (Speed Duel): tap to cycle each. */
export function useCinematicsMenu(): { label: string; note: string; onPick: () => void }[] {
  const cine = useCinematics();
  const speed = useAnimSpeed();
  const holo = useHolo();
  const idle = useIdle();
  const manga = useManga();
  const perf = usePerf();
  const lite = useLite();
  const held = lite ? 'Lite mode is holding this off' : 'tap to change';
  return [
    { label: `Performance: ${PERF_NAMES[perf]}${perf === 'auto' && lite ? ' (Lite is on)' : ''}`, note: perf === 'auto' ? 'Auto drops to Lite when the game lags' : perf === 'lite' ? 'cut-down graphics for a smoother game' : 'every effect, however it runs', onPick: () => setPerf(nextPerf(perf)) },
    { label: `Cinematics: ${CINEMATICS_NAMES[cine]}`, note: held, onPick: () => setCinematics(nextCinematics(cine)) },
    { label: `Animation speed: ${speed}×`, note: 'tap to change', onPick: () => setAnimSpeed(nextAnimSpeed(speed)) },
    { label: `Hologram summons: ${holo ? 'On' : 'Off'}`, note: held, onPick: () => setHolo(!holo) },
    { label: `Monster idle life: ${idle ? 'On' : 'Off'}`, note: held, onPick: () => setIdle(!idle) },
    { label: `Manga: ${MANGA_NAMES[manga]}`, note: held, onPick: () => setManga(nextManga(manga)) },
  ];
}
