// What this device can afford, judged once at startup (Performance: Auto).
//   0 = Lite      a weak or old phone: the cheapest version of every effect
//   1 = Balanced  most phones and tablets: every signature effect, drawn smaller and only when something moves
//   2 = Full      a strong phone or a computer: everything, at full resolution
// The judgement is pure (deviceTier) so it can be tested; probeDevice() reads the real browser.

export type Tier = 0 | 1 | 2;

export interface DeviceInfo {
  ua: string;
  /** navigator.deviceMemory in GB (Chrome-based browsers only; rounded, capped at 8) */
  mem?: number;
  /** navigator.hardwareConcurrency */
  cores?: number;
  /** the WebGL renderer string ("Adreno (TM) 618", "Mali-G52", "Apple GPU", ...) */
  gpu?: string;
  /** an iPad that says it is a Mac: touch points on a "Macintosh" */
  touch?: number;
}

/** GPUs that struggle with a full-screen 3D layer over a busy page. */
const WEAK_GPU = /Mali-(4\d\d|T\d+|G31|G51|G52|G57)|Adreno \(TM\) ([1-5]\d\d|60\d|61\d)|PowerVR|SwiftShader|llvmpipe|Software|Microsoft Basic/i;
/** Older laptop graphics: fine for most things, not for everything at once. */
const OLD_LAPTOP_GPU = /Intel.*\bHD Graphics\b/i;
/** GPUs a phone can draw everything on. */
const STRONG_GPU = /Adreno \(TM\) (7\d\d|6[5-9]\d|8\d\d)|Mali-G7[1-9]|Mali-G[6-9]1\d|Immortalis|Xclipse/i;

export function deviceTier(d: DeviceInfo): Tier {
  const ua = d.ua;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (d.touch ?? 0) > 1);
  const android = /Android/.test(ua);
  const mobile = ios || android || /Mobi/.test(ua);
  const gpu = d.gpu ?? '';
  if (WEAK_GPU.test(gpu)) return 0;
  // (Safari reports neither memory nor a trustworthy core count: every iPhone and iPad starts Balanced)
  if (ios) return 1;
  if ((d.mem !== undefined && d.mem <= 3) || (d.cores !== undefined && d.cores <= 4 && mobile)) return 0;
  if (mobile) return (d.mem ?? 0) >= 8 && (d.cores ?? 0) >= 8 && STRONG_GPU.test(gpu) ? 2 : 1;
  // a computer
  if (OLD_LAPTOP_GPU.test(gpu) || (d.mem !== undefined && d.mem <= 4) || (d.cores !== undefined && d.cores <= 4)) return 1;
  return 2;
}

const CACHE_KEY = 'eds.devTier';

/** Reads this browser once (a throwaway WebGL context for the GPU name) and caches the answer per browser version. */
export function probeDevice(): Tier {
  if (typeof navigator === 'undefined') return 2;
  const ua = navigator.userAgent;
  try {
    const hit = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as { ua?: string; t?: number } | null;
    if (hit && hit.ua === ua && (hit.t === 0 || hit.t === 1 || hit.t === 2)) return hit.t;
  } catch {
    /* storage blocked or garbled */
  }
  const nav = navigator as Navigator & { deviceMemory?: number };
  let gpu = '';
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl', { failIfMajorPerformanceCaveat: false }) ?? c.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) gpu = 'Software';
    else {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '';
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    /* no WebGL at all */
  }
  const t = deviceTier({ ua, mem: nav.deviceMemory, cores: nav.hardwareConcurrency || undefined, gpu, touch: navigator.maxTouchPoints });
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ua, t, gpu }));
  } catch {
    /* storage blocked */
  }
  return t;
}
