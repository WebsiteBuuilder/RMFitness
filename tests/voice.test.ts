// The callout voice is "now or never": a shout the phone's speech engine holds back (busy,
// paused, still waking, the tab in the background) is dropped, never heard late.
// A fake speech engine that queues like Android's, and a fake clock.
import assert from 'node:assert/strict';
import { MAX_LATE_MS, MAX_LEN_MS, setVoiceEnv, speakShout, stopShout, warmVoice, type VoiceEnv } from '../src/art/voice';

let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log(`ok ${name}`);
};

class U {
  voice = null;
  lang = '';
  pitch = 1;
  rate = 1;
  volume = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

function rig(opts: { cancelWorks?: boolean } = {}) {
  const cancelWorks = opts.cancelWorks ?? true;
  let now = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let ids = 0;
  const queue: U[] = [];
  let speaking: U | null = null;
  let cancels = 0;
  const heard: { text: string; late: number; volume: number }[] = [];
  const asked = new Map<U, number>();
  const synth = {
    paused: false,
    resumed: 0,
    speak(u: U) {
      asked.set(u, now);
      queue.push(u);
    },
    cancel() {
      cancels++;
      if (!cancelWorks) return;
      const all = [...queue, ...(speaking ? [speaking] : [])];
      queue.length = 0;
      speaking = null;
      for (const u of all) u.onerror?.();
    },
    resume() {
      this.paused = false;
      this.resumed++;
    },
    getVoices: () => [],
    get speaking() {
      return !!speaking;
    },
    get pending() {
      return queue.length > 0;
    },
  };
  let hidden = false;
  const env: VoiceEnv = {
    synth,
    Utterance: U as never,
    now: () => now,
    later: (fn, ms) => {
      const id = ++ids;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    stop: (id) => (timers = timers.filter((x) => x.id !== id)),
    hidden: () => hidden,
  };
  setVoiceEnv(env);
  /** time passes (timers fire in order) */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      now = next.at;
      next.fn();
    }
    now = end;
  };
  /** the engine gets round to the head of its queue: is it heard, or cut the moment it starts? */
  const engineStarts = () => {
    if (speaking) return;
    const u = queue.shift();
    if (!u) return;
    speaking = u;
    const before = cancels;
    u.onstart?.();
    if (cancels > before && cancelWorks) return; // cut at once: never heard
    heard.push({ text: u.text, late: now - asked.get(u)!, volume: u.volume });
  };
  const engineEnds = () => {
    const u = speaking;
    speaking = null;
    u?.onend?.();
  };
  /** the engine says it without ever sending onstart (some Android engines) */
  const engineStartsSilently = () => {
    const u = queue.shift();
    if (u) speaking = u;
  };
  /** the browser sends a start event for an utterance (even one already cancelled) */
  const strayStart = (u: U) => u.onstart?.();
  const lastAsked = () => [...asked.keys()].at(-1)!;
  return { engineStartsSilently, strayStart, lastAsked, synth, advance, engineStarts, engineEnds, heard, queue: () => queue.length, setHidden: (h: boolean) => (hidden = h), cancels: () => cancels };
}

t('a shout the engine starts at once is heard, on time', () => {
  const r = rig();
  speakShout('White Lightning!', 0.6);
  r.advance(120);
  r.engineStarts();
  r.advance(900);
  r.engineEnds();
  assert.deepEqual(r.heard.map((h) => h.text), ['White Lightning!']);
  assert.ok(r.heard[0].late <= MAX_LATE_MS);
});

t('only one shout ever waits: a new attack cancels the last one', () => {
  const r = rig();
  for (let i = 0; i < 30; i++) {
    speakShout(`Shout ${i}!`, 1);
    r.advance(50);
  }
  assert.equal(r.queue(), 1);
  r.engineStarts();
  assert.deepEqual(r.heard.map((h) => h.text), ['Shout 29!']);
});

t('a stuck engine that wakes minutes later says nothing old', () => {
  const r = rig();
  for (let i = 0; i < 20; i++) {
    speakShout(`Shout ${i}!`, 1);
    r.advance(1500); // the engine is stuck: nothing starts
  }
  r.advance(3 * 60_000);
  r.engineStarts();
  assert.equal(r.heard.length, 0);
});

t('a shout that starts after the deadline is cut the moment it starts', () => {
  const r = rig({ cancelWorks: true });
  speakShout('Dark Magic Attack!', 1);
  // the deadline timer drops it... but say the engine had already pulled it off the queue
  r.advance(MAX_LATE_MS - 1);
  r.advance(2);
  r.engineStarts();
  assert.equal(r.heard.length, 0);
});

t('even an engine whose cancel does nothing never plays an old shout unchecked', () => {
  // (some Android builds ignore cancel() while the engine is busy: every shout then queues)
  const r = rig({ cancelWorks: false });
  for (let i = 0; i < 10; i++) {
    speakShout(`Shout ${i}!`, 1);
    r.advance(2000);
  }
  const before = r.cancels();
  r.advance(60_000);
  r.engineStarts();
  // the old shout asked to be cut as it started (all this engine allows)
  assert.ok(r.cancels() > before);
});

t('a shout stuck speaking is cut after MAX_LEN_MS, freeing the queue', () => {
  const r = rig();
  speakShout('Cyber Energy Shock!', 1);
  r.advance(100);
  r.engineStarts();
  const c = r.cancels();
  r.advance(MAX_LEN_MS + 10);
  assert.ok(r.cancels() > c);
  speakShout('Lightning Strike!', 1);
  r.advance(100);
  r.engineStarts();
  assert.deepEqual(r.heard.map((h) => h.text), ['Cyber Energy Shock!', 'Lightning Strike!']);
});

t('the background: no shout is asked for, and a paused engine is resumed', () => {
  const r = rig();
  r.setHidden(true);
  speakShout('White Lightning!', 1);
  assert.equal(r.queue(), 0);
  r.setHidden(false);
  r.synth.paused = true;
  speakShout('White Lightning!', 1);
  assert.equal(r.synth.resumed, 1);
  assert.equal(r.queue(), 1);
});

t('stopShout empties the queue; a late start after it is cut', () => {
  const r = rig({ cancelWorks: false });
  speakShout('Inferno Fire Blast!', 1);
  stopShout();
  const c = r.cancels();
  r.advance(100);
  r.engineStarts();
  assert.ok(r.cancels() > c);
});

t('the engine wakes silently, once', () => {
  const r = rig();
  warmVoice();
  warmVoice();
  assert.equal(r.queue(), 1);
  r.engineStarts();
  assert.equal(r.heard[0].volume, 0);
  r.engineEnds();
  // and the first real shout cancels a warm-up still going
  warmVoice();
  speakShout('White Lightning!', 1);
  assert.equal(r.queue(), 1);
});

t('a shout while the warm-up is still being said replaces it', () => {
  setVoiceEnv(null);
  const r = rig();
  warmVoice();
  r.engineStarts();
  speakShout('Neutron Blast!', 1);
  r.advance(50);
  r.engineStarts();
  assert.deepEqual(r.heard.map((h) => h.text), [' ', 'Neutron Blast!']);
});

t('an idle engine is not cancelled before a shout (iOS can swallow speak right after cancel)', () => {
  const r = rig();
  speakShout('White Lightning!', 1);
  assert.equal(r.cancels(), 0);
  r.engineStarts();
  r.engineEnds();
  speakShout('Lightning Strike!', 1);
  assert.equal(r.cancels(), 0);
});

t('an engine that never sends onstart keeps a shout it is plainly saying', () => {
  const r = rig();
  speakShout('Chaos Blade!', 1);
  r.advance(200);
  r.engineStartsSilently();
  const c = r.cancels();
  r.advance(MAX_LATE_MS + 50);
  assert.equal(r.cancels(), c);
});

t('a stray start event from a replaced shout does not cut the new one', () => {
  const r = rig();
  speakShout('Old!', 1);
  const old = r.lastAsked();
  r.advance(100);
  speakShout('New!', 1);
  const c = r.cancels();
  r.strayStart(old);
  assert.equal(r.cancels(), c);
  r.advance(100);
  r.engineStarts();
  assert.deepEqual(r.heard.map((h) => h.text), ['New!']);
});

t('a shout gets its full length counted from when it starts', () => {
  const r = rig();
  speakShout('Super Strident Blaze!', 1);
  r.advance(MAX_LATE_MS - 100);
  r.engineStarts();
  const c = r.cancels();
  r.advance(MAX_LEN_MS - 200); // past MAX_LEN_MS from the ask, not from the start
  assert.equal(r.cancels(), c);
  r.advance(400);
  assert.ok(r.cancels() > c);
});

t('a warm-up the browser refuses (no gesture yet) is tried again on the next tap', () => {
  const r = rig();
  warmVoice();
  const u = r.lastAsked();
  u.onerror?.(); // not-allowed
  warmVoice();
  assert.notEqual(r.lastAsked(), u);
});

t('an engine that ignores cancel() never builds a backlog', () => {
  const r = rig({ cancelWorks: false });
  for (let i = 0; i < 10; i++) {
    speakShout(`Shout ${i}!`, 1, 1.5, 4);
    r.advance(500);
  }
  // at most one shout ever waits in the engine
  assert.ok(r.queue() <= 1, `queue ${r.queue()}`);
  r.advance(60_000);
  for (let i = 0; i < 12; i++) {
    r.engineStarts();
    r.engineEnds();
  }
  assert.ok(r.heard.length <= 1);
});

t('at 4x the deadline is shorter', () => {
  const r = rig();
  speakShout('White Lightning!', 1, 1.7, 4);
  r.advance(700);
  r.engineStarts();
  assert.equal(r.heard.length, 0);
  speakShout('White Lightning!', 1, 1.7, 4);
  r.advance(200);
  r.engineStarts();
  assert.equal(r.heard.length, 1);
});

t('a shout assumed started (Chrome says speaking while a cold engine wakes) is cut if it really starts late', () => {
  const r = rig();
  speakShout('Dark Magic Attack!', 1);
  r.advance(100);
  r.engineStartsSilently(); // speaking=true, no onstart yet
  r.advance(MAX_LATE_MS + 50); // assumed started
  const c = r.cancels();
  r.strayStart(r.lastAsked()); // the real start, 1 s late
  assert.ok(r.cancels() > c);
});

t('a warm-up the engine never answers is retried after a moment', () => {
  const r = rig();
  warmVoice();
  const u = r.lastAsked();
  warmVoice();
  assert.equal(r.lastAsked(), u);
  r.advance(1600);
  warmVoice();
  assert.notEqual(r.lastAsked(), u);
});

setVoiceEnv(null);
console.log(`${n} voice tests passed`);
