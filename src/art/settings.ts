// The player's cinematic settings (stored on the device, like every other duel option).
//   Cinematics: which moments get a 3D cinematic.
//   Animation speed: how fast they play.
// The old single "3D Animations: Full / Fast / Off" option (eds.art3d) carries over:
// Off stays off, Fast becomes 1.5×.
import { useEffect, useState } from 'preact/hooks';
import type { MangaMode } from './mangaRules';
import { probeDevice, type Tier } from './tier';

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

// ---------- Performance: Auto / Lite / Balanced / Full ----------
// Three quality levels (tier.ts): 0 Lite, 1 Balanced, 2 Full. Auto (the default) picks one from the
// device (probeDevice) and steps down one level for good when the watchdog (perfGuard.ts) sees the game
// struggle. Every level keeps the signature effects (3D figures popping out of their cards, holographic
// summons, big-moment cinematics); lower levels draw them smaller, stop drawing when nothing moves,
// and drop the extras (idle life, glass blur, decorative loops, every-hit panels).
export type PerfMode = 'auto' | 'lite' | 'balanced' | 'full';
const PERF_KEY = 'eds.perf';
/** Auto's step-down after lag: the highest level this device may use ('0' or '1'). */
const PERF_CAP_KEY = 'eds.perfCap';
/** (the old watchdog's flag: '1' meant Lite) */
const PERF_AUTO_KEY = 'eds.perfAuto';
/** Set once this version's Auto has been given its chance (an old saved Full or Lite is reset to Auto once). */
const PERF_V_KEY = 'eds.perfV2';
const PERF_ORDER: PerfMode[] = ['auto', 'lite', 'balanced', 'full'];
export const PERF_NAMES: Record<PerfMode, string> = { auto: 'Auto', lite: 'Lite', balanced: 'Balanced', full: 'Full' };
export const LEVEL_NAMES: Record<Tier, string> = { 0: 'Lite', 1: 'Balanced', 2: 'Full' };

if (typeof window !== 'undefined' && read(PERF_V_KEY) !== '1') {
  try {
    // the old Auto/Full/Lite choice was made before Balanced existed: everyone starts again on Auto
    localStorage.removeItem(PERF_KEY);
    if (localStorage.getItem(PERF_AUTO_KEY) === '1') localStorage.setItem(PERF_CAP_KEY, '1');
    localStorage.removeItem(PERF_AUTO_KEY);
    localStorage.setItem(PERF_V_KEY, '1');
  } catch {
    /* storage blocked */
  }
}

export function getPerf(): PerfMode {
  const v = read(PERF_KEY);
  return v && (PERF_ORDER as string[]).includes(v) ? (v as PerfMode) : 'auto';
}
let device: Tier | null = null;
/** What Auto judged this device to be (probed once). */
export const deviceLevel = (): Tier => (device ??= typeof window === 'undefined' ? 2 : probeDevice());
const computeLevel = (): Tier => {
  const m = getPerf();
  if (m === 'lite') return 0;
  if (m === 'balanced') return 1;
  if (m === 'full') return 2;
  const cap = Number(read(PERF_CAP_KEY));
  const d = deviceLevel();
  return (cap === 0 || cap === 1 ? Math.min(d, cap) : d) as Tier;
};
// Read on every frame by the art code, so it is cached and refreshed when a setting changes.
let levelNow: Tier = typeof window === 'undefined' ? 2 : computeLevel();
let liteNow = levelNow === 0;
if (typeof window !== 'undefined') {
  const refresh = () => void ((levelNow = computeLevel()), (liteNow = levelNow === 0));
  window.addEventListener(EVT, refresh);
  window.addEventListener('storage', refresh);
}
/** The quality level in use right now: 0 Lite, 1 Balanced, 2 Full. */
export const quality = (): Tier => levelNow;
/** Is the phone running the cut-down graphics right now? */
export const isLite = (): boolean => liteNow;
/** Balanced or Lite: draw only when something moves, no decorative loops. */
export const isLean = (): boolean => levelNow < 2;
export const setPerf = (v: PerfMode) => {
  if (v === 'auto') {
    try {
      localStorage.removeItem(PERF_CAP_KEY); // a fresh start: the watchdog judges again
    } catch {
      /* storage blocked */
    }
  }
  write(PERF_KEY, v);
};
export const nextPerf = (v: PerfMode): PerfMode => PERF_ORDER[(PERF_ORDER.indexOf(v) + 1) % PERF_ORDER.length];
/** The watchdog saw sustained slow frames: in Auto, this device drops one level for good. Returns the new level when it just stepped down. */
export function noteJank(): Tier | null {
  if (getPerf() !== 'auto' || levelNow === 0) return null;
  const next = (levelNow - 1) as Tier;
  try {
    localStorage.setItem(PERF_CAP_KEY, String(next));
  } catch {
    return null;
  }
  window.dispatchEvent(new Event(EVT));
  return next;
}

export function getCinematics(): Cinematics {
  const v = read(CINE_KEY);
  const set: Cinematics = v && (CINE_ORDER as string[]).includes(v) ? (v as Cinematics) : read(LEGACY_KEY) === 'off' ? 'off' : 'big';
  // (Lite keeps the big moments, the summons that pop out, and nothing smaller)
  return liteNow && set !== 'off' ? 'big' : set;
}

export function getAnimSpeed(): AnimSpeed {
  const v = Number(read(SPEED_KEY));
  if ((SPEED_ORDER as number[]).includes(v)) return v as AnimSpeed;
  return read(LEGACY_KEY) === 'fast' ? 1.5 : 1;
}

const HOLO_KEY = 'eds.holo';
/** Holographic summons (monsters rise out of their card as a Duel Disk hologram, then solidify): on unless turned off, at every quality level (a signature effect, and cheap: a few uniforms and one quad). */
export const getHolo = (): boolean => read(HOLO_KEY) !== 'off';
export const setHolo = (on: boolean) => write(HOLO_KEY, on ? 'on' : 'off');
/** Motion kept calm (the phone's Reduce motion): no signal tearing or flicker on the holograms. */
let calmQuery: MediaQueryList | null | undefined;
export const calmMotion = (): boolean => {
  if (calmQuery === undefined) calmQuery = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  return !!calmQuery?.matches;
};

const CAM_KEY = 'eds.duelCam';
export type DuelCam = 'full' | 'soft' | 'off';
const CAM_ORDER: DuelCam[] = ['full', 'soft', 'off'];
const CAM_NAMES: Record<DuelCam, string> = { full: 'Full', soft: 'Soft', off: 'Off' };
/** The Duel Disk camera (the field pushes in and tilts on summons and attacks): Full unless changed; Soft under the phone's Reduce motion. */
export function getDuelCam(): DuelCam {
  const v = read(CAM_KEY);
  const c: DuelCam = v && (CAM_ORDER as string[]).includes(v) ? (v as DuelCam) : calmMotion() ? 'soft' : 'full';
  // (moving the whole field re-draws it on every frame of the shot: Balanced keeps it Soft, Lite still)
  return liteNow ? 'off' : levelNow < 2 && c === 'full' ? 'soft' : c;
}
export const setDuelCam = (v: DuelCam) => write(CAM_KEY, v);
const nextDuelCam = (v: DuelCam): DuelCam => CAM_ORDER[(CAM_ORDER.indexOf(v) + 1) % CAM_ORDER.length];
const IDLE_KEY = 'eds.idle';
/** Monster idle life is opt-in because it continuously animates the board and costs frames. */
export const getIdle = (): boolean => levelNow === 2 && read(IDLE_KEY) === 'on';
export const setIdle = (on: boolean) => write(IDLE_KEY, on ? 'on' : 'off');

const MANGA_KEY = 'eds.manga';
const MANGA_ORDER: MangaMode[] = ['big', 'all', 'off'];
export const MANGA_NAMES: Record<MangaMode, string> = { big: 'Big hits', all: 'Every hit', off: 'Off' };
/** Manga attack panels (mangaRules.ts): on big hits unless changed. */
export function getManga(): MangaMode {
  if (liteNow) return 'off';
  const v = read(MANGA_KEY);
  const m: MangaMode = v && (MANGA_ORDER as string[]).includes(v) ? (v as MangaMode) : 'big';
  // (Balanced keeps them for the big hits only)
  return levelNow < 2 && m === 'all' ? 'big' : m;
}
export const setManga = (v: MangaMode) => write(MANGA_KEY, v);
export const nextManga = (v: MangaMode): MangaMode => MANGA_ORDER[(MANGA_ORDER.indexOf(v) + 1) % MANGA_ORDER.length];
const CUTIN_KEY = 'eds.cutins';
/** Anime portrait cut-ins (the duelists' faces on attacks, chains and the final blow): on unless turned off. */
export const getCutins = (): boolean => read(CUTIN_KEY) !== 'off';
export const setCutins = (on: boolean) => write(CUTIN_KEY, on ? 'on' : 'off');

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
export const useDuelCam = () => useStored(getDuelCam);
export const useIdle = () => useStored(getIdle);
export const useManga = () => useStored(getManga);
export const usePerf = () => useStored(getPerf);
export const useLite = () => useStored(isLite);
export const useQuality = () => useStored(quality);
export const useCutins = () => useStored(getCutins);
/** Calls back whenever a cinematic setting changes on this phone (or in another tab); returns the unsubscribe. */
export function onArtSettings(cb: () => void): () => void {
  window.addEventListener(EVT, cb);
  window.addEventListener('storage', cb);
  return () => (window.removeEventListener(EVT, cb), window.removeEventListener('storage', cb));
}

/** The stored choice (before the quality level holds it down), for cycling in the menu. */
const rawOf = <T extends string>(key: string, order: T[], fallback: T): T => {
  const v = read(key);
  return v && (order as string[]).includes(v) ? (v as T) : fallback;
};

/** The duel-menu items (Speed Duel): tap to cycle each. */
export function useCinematicsMenu(): { label: string; note: string; onPick: () => void }[] {
  const cine = useCinematics();
  const speed = useAnimSpeed();
  const holo = useHolo();
  const cam = useDuelCam();
  const idle = useIdle();
  const manga = useManga();
  const perf = usePerf();
  const level = useStored(quality);
  const held = (by: Tier) => (level <= by ? `${LEVEL_NAMES[level]} graphics hold this down` : 'tap to change');
  const cut = useCutins();
  const perfNote =
    perf === 'auto'
      ? `picked for this device: ${LEVEL_NAMES[level]}; drops a level if the game lags`
      : perf === 'lite'
        ? 'cheapest: smooth on old phones, the big effects stay'
        : perf === 'balanced'
          ? 'every signature effect, drawn lighter'
          : 'every effect at full detail, however it runs';
  return [
    { label: `Performance: ${PERF_NAMES[perf]}${perf === 'auto' ? ` (${LEVEL_NAMES[level]})` : ''}`, note: perfNote, onPick: () => setPerf(nextPerf(perf)) },
    { label: `Cinematics: ${CINEMATICS_NAMES[cine]}`, note: held(0), onPick: () => setCinematics(nextCinematics(rawOf(CINE_KEY, CINE_ORDER, cine))) },
    { label: `Animation speed: ${speed}×`, note: 'tap to change', onPick: () => setAnimSpeed(nextAnimSpeed(speed)) },
    { label: `Hologram summons: ${holo ? 'On' : 'Off'}`, note: 'tap to change', onPick: () => setHolo(!holo) },
    { label: `Duel Disk camera: ${CAM_NAMES[cam]}`, note: held(1), onPick: () => setDuelCam(nextDuelCam(rawOf(CAM_KEY, CAM_ORDER, cam))) },
    { label: `Monster idle life: ${idle ? 'On' : 'Off'}`, note: held(1), onPick: () => setIdle(!(read(IDLE_KEY) === 'on')) },
    { label: `Manga: ${MANGA_NAMES[manga]}`, note: held(1), onPick: () => setManga(nextManga(rawOf(MANGA_KEY, MANGA_ORDER, manga))) },
    { label: `Portrait cut-ins: ${cut ? 'On' : 'Off'}`, note: 'tap to change', onPick: () => setCutins(!cut) },
  ];
}
