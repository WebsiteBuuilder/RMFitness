import { useEffect, useState } from 'preact/hooks';

// Tiny synthesized sounds (no audio files). iPhones only allow audio after a
// user gesture, so the context is created lazily on the first interaction.
let ctx: AudioContext | null = null;
let primed = false;

// The Sound setting (on by default), stored on the device like the other duel options.
const SOUND_KEY = 'eds.sound';
const SOUND_EVT = 'eds-sound';
let soundOff = (() => {
  try {
    return localStorage.getItem(SOUND_KEY) === 'off';
  } catch {
    return false; // storage blocked (or no browser)
  }
})();

export const soundEnabled = () => !soundOff;

export function setSoundEnabled(on: boolean) {
  soundOff = !on;
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    /* storage blocked */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SOUND_EVT));
}

/** The Sound setting as a hook (re-renders when it changes). */
export function useSoundEnabled(): boolean {
  const [on, setOn] = useState(soundEnabled);
  useEffect(() => onSoundChange(() => setOn(soundEnabled())), []);
  return on;
}

/** Calls `fn` whenever the Sound setting changes; returns the unsubscribe. */
export function onSoundChange(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(SOUND_EVT, fn);
  return () => window.removeEventListener(SOUND_EVT, fn);
}

/** iOS suspends (or "interrupts") the context on calls, lock and backgrounding: wake it. */
function wake() {
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
}

/** iOS Safari only really starts output once a sound plays inside a gesture: a 1-sample silence. */
function prime() {
  if (!ctx || primed) return;
  primed = true;
  try {
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    primed = false;
  }
}

export function unlockAudio() {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      ctx = null;
      return;
    }
  }
  wake();
  prime();
}

// Every tap is a chance to (re)start audio; so is coming back to the tab.
if (typeof window !== 'undefined') {
  const onGesture = () => {
    if (!ctx) return;
    wake();
    prime();
  };
  window.addEventListener('pointerdown', onGesture, { capture: true, passive: true });
  window.addEventListener('touchend', onGesture, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wake();
  });
}

function tone(freq: number, duration: number, type: OscillatorType, gain: number, when = 0) {
  if (!ctx || soundOff) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime + when);
  g.gain.setValueAtTime(gain, ctx.currentTime + when);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + when + duration);
  osc.connect(g).connect(ctx.destination);
  osc.start(ctx.currentTime + when);
  osc.stop(ctx.currentTime + when + duration);
}

/** Heavy thump for a face-up monster landing on the field. */
export function playSummon() {
  if (!ctx) return;
  tone(70, 0.35, 'sine', 0.6);
  tone(140, 0.2, 'triangle', 0.25, 0.02);
}

/** Short hit for a life point loss. */
export function playHit() {
  if (!ctx) return;
  tone(220, 0.12, 'square', 0.15);
  tone(110, 0.25, 'sawtooth', 0.12, 0.05);
}

/** Alert for the Wait button. */
export function playAlert() {
  if (!ctx) return;
  tone(880, 0.1, 'square', 0.15);
  tone(880, 0.1, 'square', 0.15, 0.15);
  tone(1174, 0.2, 'square', 0.15, 0.3);
}

/** GBA-style cursor blip. */
export function playBlip() {
  if (!ctx) return;
  tone(1200, 0.04, 'square', 0.08);
}

/** Card draw swish. */
export function playDraw() {
  if (!ctx) return;
  tone(600, 0.06, 'triangle', 0.1);
  tone(900, 0.06, 'triangle', 0.1, 0.05);
}

/** Victory jingle. */
export function playWin() {
  if (!ctx) return;
  [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'square', 0.12, i * 0.14));
}

/** Rising fanfare for a won duel. */
export function playFanfare() {
  if (!ctx) return;
  [523, 659, 784, 1046].forEach((f, i) => tone(f, i === 3 ? 0.5 : 0.14, 'square', 0.12, i * 0.12));
}

/** Falling tones for a lost duel or a lost heart. */
export function playLose() {
  if (!ctx) return;
  [392, 330, 262].forEach((f, i) => tone(f, 0.22, 'triangle', 0.16, i * 0.18));
}

/** Sparkle for a star or a revealed card. */
export function playStar(when = 0) {
  if (!ctx) return;
  tone(1568, 0.08, 'sine', 0.12, when);
  tone(2093, 0.16, 'sine', 0.1, when + 0.06);
}

/** The clash before a duel. */
export function playVs() {
  if (!ctx) return;
  tone(110, 0.5, 'sawtooth', 0.14);
  tone(55, 0.6, 'sine', 0.5, 0.02);
  tone(880, 0.25, 'square', 0.08, 0.1);
}

/** A short buzz on phones that allow it (Android; iPhones ignore it). */
export function buzz(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported */
  }
}

/** The shared audio context (null until the first tap), for the 3D art engine's sounds. */
export function audioContext(): AudioContext | null {
  return soundOff ? null : ctx;
}

/** A Mate's chirp: a little two-note call in its own voice, shaped by the reaction. */
export function playMate(voice: number, mood: 'up' | 'down' | 'flat' = 'up') {
  if (!ctx) return;
  const a = mood === 'down' ? voice : voice * 0.8;
  const b = mood === 'down' ? voice * 0.7 : mood === 'up' ? voice * 1.25 : voice;
  tone(a, 0.07, 'triangle', 0.07);
  tone(b, 0.1, 'triangle', 0.07, 0.07);
}
