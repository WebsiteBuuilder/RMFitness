// Show-style duel sounds: each one really plays, Sound Off silences them all,
// and every cue that can lack a cinematic still has its sound (run: npx tsx tests/sound.test.ts).
import { setSoundEnabled, soundEnabled, unlockAudio, playBlip } from '../src/ui/sound';
import * as sfx from '../src/ui/duelSfx';
import { cueSound, cueSting } from '../src/art/cueSound';
import type { Cue, CardRef } from '../src/art/cues';

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};

// A stand-in AudioContext that counts the sound sources started.
let started = 0;
// (and the value changes scheduled: the Life Point counter's beeps are gate steps on one pair of oscillators)
let steps = 0;
const param = () => ({ value: 0, setValueAtTime: () => steps++, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} });
const node = () => ({ connect: (n: unknown) => n });
let clockT = 0;
class FakeCtx {
  // (time moves on between sounds: counts asked for at the same moment would merge)
  get currentTime() {
    return (clockT += 0.1);
  }
  sampleRate = 8000;
  state = 'running';
  destination = node();
  resume = async () => {};
  createBuffer = (_c: number, n: number) => ({ sampleRate: 8000, getChannelData: () => new Float32Array(n) });
  createGain = () => ({ ...node(), gain: param() });
  createBiquadFilter = () => ({ ...node(), type: '', Q: param(), frequency: param() });
  createOscillator = () => ({ ...node(), type: '', frequency: param(), detune: param(), start: () => started++, stop() {} });
  createBufferSource = () => ({ ...node(), buffer: null, loop: false, start: () => started++, stop() {} });
}
(globalThis as Record<string, unknown>).AudioContext = FakeCtx;

const count = (fn: () => void) => {
  const before = started;
  fn();
  return started - before;
};

ok(count(() => sfx.attack()) === 0, 'silent before the first tap (no audio context yet)');
unlockAudio();
ok(soundEnabled(), 'Sound is on by default');

// Life Points: the show's counter rattle, as long as the roll (bigger hits roll longer), then a wail at 0
const ticks = (fn: () => void) => {
  const before = steps;
  fn();
  return steps - before;
};
const small = ticks(() => sfx.lpCount(-300, 7700, 534));
const big = ticks(() => sfx.lpCount(-3000, 5000, 1290));
ok(small >= 20 && big > small * 2, `LP drain beeps: a short roll → ${small} gate steps, a long roll → ${big}`);
ok(count(() => sfx.lpCount(-1000, 3000, 730)) <= 3, 'the rattle is one pair of oscillators, however long (cheap on a phone)');
ok(count(() => sfx.lpCount(-2000, 0, 1010)) > count(() => sfx.lpCount(-2000, 100, 1010)), 'LP hitting 0 plays the falling wail');
ok(ticks(() => sfx.lpCount(500, 8500, 590)) >= 20, 'LP gain ticks too');
ok(count(() => sfx.lpCount(0, 8000)) === 0, 'no change, no sound');

const named: [string, () => void][] = [
  ['attack', () => sfx.attack()],
  ['direct attack', () => sfx.attack(true)],
  ['clash', sfx.clash],
  ['impact', sfx.impact],
  ['shatter', () => sfx.shatter()],
  ['set', sfx.setCard],
  ['flip', sfx.flip],
  ['spell', sfx.spell],
  ['trap', sfx.trap],
  ['monster effect', sfx.monsterEffect],
  ['skill', sfx.skill],
  ['leave', sfx.leave],
  ['draw', () => sfx.draw(2)],
  ...['normal', 'tribute', 'special', 'fusion', 'ritual', 'synchro', 'xyz', 'link'].map((h) => [`${h} summon`, () => sfx.summon(h)] as [string, () => void]),
];
const silent = named.filter(([, fn]) => count(fn) === 0).map(([n]) => n);
ok(silent.length === 0, `all ${named.length} duel sounds play (${silent.join(', ') || 'none silent'})`);

// every cue kind that can skip its cinematic still sounds
const ref: CardRef = { uid: 1, name: 'Dark Magician', faceUp: true, controller: 0, rect: null, def: false };
const cues: Cue[] = [
  { kind: 'summon', card: ref, special: false },
  { kind: 'summon', card: ref, special: true, how: 'fusion' },
  { kind: 'set', card: ref, monster: true },
  { kind: 'flip', card: ref },
  { kind: 'activate', card: ref, what: 'spell' },
  { kind: 'activate', card: ref, what: 'trap' },
  { kind: 'activate', card: ref, what: 'monster' },
  { kind: 'skill', player: 0, name: 'Power of Dark' },
  { kind: 'attack', attacker: ref, target: null, defender: 1 },
  { kind: 'hit', attacker: ref, target: ref, defender: 1 },
  { kind: 'damage', player: 1, amount: 500 },
  { kind: 'destroy', card: ref },
  { kind: 'leave', card: ref, to: 'banish' },
  { kind: 'draw', player: 0, count: 2 },
];
const quiet = cues.filter((c) => count(() => cueSound(c)) === 0).map((c) => c.kind);
ok(quiet.length === 0, `all ${cues.length} cues sound without a cinematic (${quiet.join(', ') || 'none silent'})`);
ok(count(() => cueSting({ kind: 'activate', card: ref, what: 'trap' })) > 0 && count(() => cueSting({ kind: 'attack', attacker: ref, target: null, defender: 1 })) === 0, 'cinematics get the Trap sting, attacks keep their own sound');

// Sound Off silences everything, menus included; On brings it back
setSoundEnabled(false);
ok(count(() => (sfx.lpCount(-1000, 7000), sfx.trap(), sfx.summon('xyz'), playBlip(), cueSound(cues[0]))) === 0, 'Sound Off: nothing plays');
setSoundEnabled(true);
ok(count(() => sfx.lpCount(-1000, 7000)) > 0, 'Sound On again: the LP counter plays');

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
console.log('\nall sound checks passed');
