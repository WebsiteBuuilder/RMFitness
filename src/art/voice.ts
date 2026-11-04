// The callout voice: the phone's own speech engine says a monster's shout as it attacks.
//
// A shout is only worth hearing while its attack is on screen. Phone speech engines queue: on
// Android a busy, paused or still-waking Google speech engine (or a tab that went to the
// background) holds every shout and plays the lot later, sometimes minutes after the attacks.
// So a shout here is "now or never":
//  - each new shout cancels whatever is still said or waiting (only one is ever in the queue),
//  - a shout that has not started within MAX_LATE_MS is cancelled, and one that starts late
//    anyway is cut the moment it starts (onstart), so nothing is ever heard late,
//  - a shout still going after MAX_LEN_MS (a stuck engine) is cut, which also unsticks the queue,
//  - the page going to the background drops it,
//  - the engine is woken once, silently, on the first tap, so the first real shout is not the
//    one that pays for the engine starting up.
// It costs nothing per frame: two timers per shout, no audio buffers.

/** A shout that has not started this long after it was asked for is dropped. */
export const MAX_LATE_MS = 900;
/** A shout still going after this long is cut (shouts are about a second). */
export const MAX_LEN_MS = 3500;

interface Utter {
  text: string;
  voice: SpeechSynthesisVoice | null;
  lang: string;
  pitch: number;
  rate: number;
  volume: number;
  onstart: ((e?: unknown) => void) | null;
  onend: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
}
interface Synth {
  speak(u: Utter): void;
  cancel(): void;
  resume?(): void;
  paused?: boolean;
  getVoices?(): SpeechSynthesisVoice[];
  addEventListener?(type: string, fn: () => void): void;
}
/** What the voice runs on (the browser's, or a fake in the tests). */
export interface VoiceEnv {
  synth: Synth | null;
  Utterance: (new (text: string) => Utter) | null;
  now(): number;
  later(fn: () => void, ms: number): unknown;
  stop(t: unknown): void;
  hidden(): boolean;
}

function browserEnv(): VoiceEnv {
  const w = typeof window !== 'undefined' ? window : undefined;
  return {
    synth: (w?.speechSynthesis as unknown as Synth) ?? null,
    Utterance: typeof SpeechSynthesisUtterance !== 'undefined' ? (SpeechSynthesisUtterance as unknown as new (text: string) => Utter) : null,
    now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    later: (fn, ms) => setTimeout(fn, ms),
    stop: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  };
}

let env: VoiceEnv | null = null;
const E = () => (env ??= browserEnv());
/** Tests swap the browser for a fake (null puts the browser back). */
export function setVoiceEnv(e: VoiceEnv | null) {
  env = e;
  live = null;
  pick = undefined;
  warmed = false;
}

interface Live {
  /** held so the browser cannot garbage-collect it mid-shout (Chrome then never ends the queue) */
  u: Utter;
  asked: number;
  started: boolean;
  late: unknown;
  long: unknown;
}
let live: Live | null = null;

/** Lets go of the current shout's timers (the utterance itself is done or cancelled). */
function release(me: Live) {
  const e = E();
  e.stop(me.late);
  e.stop(me.long);
  if (live === me) live = null;
}

/** Cancels the shout being said and anything queued behind it. */
function drop() {
  const e = E();
  if (live) release(live);
  try {
    e.synth?.cancel();
  } catch {
    /* no speech on this phone */
  }
}

// ---------- the voice it speaks with ----------
let pick: SpeechSynthesisVoice | null | undefined;
let listening = false;
function englishVoice(): SpeechSynthesisVoice | null {
  const ss = E().synth;
  if (ss && !listening && ss.addEventListener) {
    listening = true;
    // voices arrive late on Chrome: pick again once they are in
    ss.addEventListener('voiceschanged', () => (pick = undefined));
  }
  if (pick !== undefined) return pick;
  const vs = ss?.getVoices?.() ?? [];
  if (!vs.length) return null;
  // a phone's own English voice (Google's on Android, Siri's on iPhone): offline ones first,
  // since a network voice can take seconds to answer
  const en = vs.filter((v) => /^en[-_]/i.test(v.lang));
  pick = en.find((v) => v.localService && /US|GB/i.test(v.lang)) ?? en.find((v) => v.localService) ?? en[0] ?? null;
  return pick;
}

function utter(text: string, pitch: number, rate: number, volume: number): Utter | null {
  const { Utterance } = E();
  if (!Utterance) return null;
  const u = new Utterance(text);
  const v = englishVoice();
  if (v) u.voice = v;
  u.lang = v?.lang ?? 'en-US';
  u.pitch = pitch;
  u.rate = rate;
  u.volume = volume;
  return u;
}

/** Says the shout now, or not at all (nothing when the phone has no speech engine). */
export function speakShout(text: string, pitch: number, rate = 1.12): void {
  try {
    const e = E();
    const ss = e.synth;
    if (!ss) return;
    drop();
    if (e.hidden()) return;
    // Chrome can leave the engine paused (a call, the tab in the background): it would hold the shout
    if (ss.paused) ss.resume?.();
    const u = utter(text, pitch, rate, 1);
    if (!u) return;
    const me: Live = { u, asked: e.now(), started: false, late: null, long: null };
    u.onstart = () => {
      // a shout from an attack already gone, or this one but too late: cut it, never play it late
      if (live !== me || e.now() - me.asked > MAX_LATE_MS) {
        // (a newer shout already being said is left alone: this was only a late event)
        if (!live?.started) drop();
        return;
      }
      me.started = true;
    };
    u.onend = u.onerror = () => release(me);
    me.late = e.later(() => {
      if (live === me && !me.started) drop();
    }, MAX_LATE_MS);
    me.long = e.later(() => {
      if (live === me) drop();
    }, MAX_LEN_MS);
    live = me;
    ss.speak(u);
  } catch {
    /* no speech on this phone */
  }
}

/** Stops a shout still being said, and any still waiting (the duel left, a skip, the result screen). */
export function stopShout(): void {
  drop();
}

let warmed = false;
/** Wakes the speech engine silently (called on a tap, so the browser allows it), once. */
export function warmVoice(): void {
  if (warmed) return;
  try {
    const ss = E().synth;
    if (!ss || live) return;
    const u = utter(' ', 1, 1, 0);
    if (!u) return;
    warmed = true;
    ss.speak(u);
  } catch {
    /* no speech on this phone */
  }
}

// A shout never waits for the page to come back.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') drop();
  });
  window.addEventListener('pagehide', () => drop());
}
