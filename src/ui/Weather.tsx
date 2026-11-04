// Weather and time of day on the duel field (Speed Duels, Touch board). Cosmetic only:
// nothing here takes a tap, and the Weather setting in the duel Menu turns it all off.
//   WeatherSky sits in the arena behind the mat: the light of the hour (afternoon, gold,
//     dusk, night with stars) and the clouds rolling in.
//   WeatherFront sits over the field (never the hand): the hour's light on the cards, the
//     rain / ash / sand canvas (src/art/weather.ts), lightning bolts and their flash.
// What the sky does is in weatherRules.ts: it follows the soundtrack's levels, and its
// lightning lands on the music's bar lines (onMusicBar); with Music off it keeps the
// same tempo by itself. Thunder is a sound effect, so the Sound setting silences it.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DuelState } from '../eds/types';
import { weatherFor, type Sky } from './weatherRules';
import { WeatherFx } from '../art/weather';
import { BPM, onMusicBar } from './music';
import { thunder } from './duelSfx';
import './weather.css';

// ------------------------------------------------------------ the Weather setting

const KEY = 'eds.weather';
const EVT = 'eds-weather';
let off = (() => {
  try {
    return localStorage.getItem(KEY) === 'off';
  } catch {
    return false;
  }
})();

export const weatherEnabled = () => !off;

export function setWeatherEnabled(on: boolean) {
  off = !on;
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* storage blocked */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVT));
}

export function useWeatherEnabled(): boolean {
  const [on, setOn] = useState(weatherEnabled);
  useEffect(() => {
    const fn = () => setOn(weatherEnabled());
    window.addEventListener(EVT, fn);
    return () => window.removeEventListener(EVT, fn);
  }, []);
  return on;
}

// ------------------------------------------------------------ the sky behind the mat

const TODS = ['day', 'golden', 'dusk', 'night'] as const;

export function WeatherSky({ state }: { state: DuelState }) {
  const on = useWeatherEnabled();
  if (!on) return null;
  const w = weatherFor(state);
  return (
    <div class={`wx-sky sky-${w.sky} pre-${w.precip}`} aria-hidden="true">
      {TODS.map((t) => (
        <i key={t} class={`wx-tod ${t}${w.tod === t ? ' on' : ''}`} />
      ))}
      <i class="wx-stars" />
      <i class="wx-cloud a" />
      <i class="wx-cloud b" />
    </div>
  );
}

// ------------------------------------------------------------ over the field

/** how hard it falls for each sky */
const AMOUNT: Record<Sky, number> = { clear: 0, rain: 0.42, storm: 1 };
/** the shortest gap between two strikes (ms) */
const STRIKE_GAP = 1800;

export function WeatherFront({ state }: { state: DuelState }) {
  const on = useWeatherEnabled();
  const w = weatherFor(state);
  const canvas = useRef<HTMLCanvasElement>(null);
  const flash = useRef<HTMLElement>(null);
  const fx = useRef<WeatherFx | null>(null);
  const sky = useRef<Sky>(w.sky);
  sky.current = w.sky;
  const lastStrike = useRef(0);
  const minLp = Math.min(...state.players.map((p) => p.lp));
  const lastLp = useRef(minLp);

  /** a strike now: a bolt, the flash and thunder (near), or a far flash and a low roll */
  const strike = (near: boolean) => {
    const now = performance.now();
    if (now - lastStrike.current < STRIKE_GAP) return;
    if (document.hidden || document.body.classList.contains('art-on')) return;
    lastStrike.current = now;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (near) fx.current?.bolt();
    if (!reduced) {
      const a = near ? 0.2 : 0.07;
      flash.current?.animate([{ opacity: 0 }, { opacity: a, offset: 0.08 }, { opacity: a * 0.2, offset: 0.25 }, { opacity: a * 0.75, offset: 0.4 }, { opacity: 0 }], {
        duration: near ? 520 : 700,
        easing: 'ease-out',
      });
    }
    thunder(near);
  };
  const strikeRef = useRef(strike);
  strikeRef.current = strike;

  useEffect(() => {
    if (!on || !canvas.current) return;
    try {
      fx.current = new WeatherFx(canvas.current);
    } catch {
      fx.current = null;
    }
    // hold still under a cinematic
    const mo = new MutationObserver(() => fx.current?.pause(document.body.classList.contains('art-on')));
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // the lightning keeps the soundtrack's time: on its bar lines when it plays...
    let heard = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number, f: () => void) => {
      const id = setTimeout(() => (timers.delete(id), f()), Math.max(0, ms));
      timers.add(id);
    };
    const onBar = (inSec: number, bar: number) => {
      heard = performance.now();
      const s = sky.current;
      if (s === 'storm' && bar % 2 === 0 && Math.random() < 0.7) later(inSec * 1000, () => strikeRef.current(true));
      else if (s === 'rain' && bar % 4 === 0 && Math.random() < 0.5) later(inSec * 1000, () => strikeRef.current(false));
    };
    const stop = onMusicBar((inSec, bar) => onBar(inSec, bar));
    if (location.search.includes('debug')) (window as unknown as Record<string, unknown>).__wx = { fx: fx.current, strike: (near: boolean) => ((lastStrike.current = 0), strikeRef.current(near)) };
    // ...and at the same tempo by itself when Music is off (or the music has not started yet)
    let bar = 0;
    let nextBar = performance.now() + 1500;
    const own = setInterval(() => {
      const now = performance.now();
      if (now - heard < 4000 || now < nextBar) return;
      const lv = sky.current === 'storm' ? 2 : sky.current === 'rain' ? 1 : 0;
      nextBar = now + (60 / BPM[lv]) * 4 * 1000;
      onBar(0, ++bar);
    }, 250);
    return () => {
      stop();
      clearInterval(own);
      for (const id of timers) clearTimeout(id);
      mo.disconnect();
      fx.current?.dispose();
      fx.current = null;
    };
  }, [on]);

  useEffect(() => {
    fx.current?.set(w.precip, AMOUNT[w.sky]);
  }, [on, w.precip, w.sky]);

  // a big hit in the storm brings a strike right away
  useEffect(() => {
    if (on && sky.current === 'storm' && minLp < lastLp.current) strikeRef.current(true);
    lastLp.current = minLp;
  }, [minLp]);

  // (body classes, so other layers can react: wet ground, darker sheen)
  useEffect(() => {
    const b = document.body.classList;
    b.toggle('wx-rain', on && w.sky === 'rain');
    b.toggle('wx-storm', on && w.sky === 'storm');
    b.toggle(`wx-${w.tod}`, on);
    return () => {
      b.remove('wx-rain', 'wx-storm', `wx-${w.tod}`);
    };
  }, [on, w.sky, w.tod]);

  if (!on) return null;
  return (
    <div class={`wx-front tod-${w.tod} sky-${w.sky}`} aria-hidden="true">
      <i class="wx-light" />
      <canvas ref={canvas} class="wx-fall" />
      <i ref={flash} class="wx-flash" />
    </div>
  );
}
