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
const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} });
const node = () => ({ connect: (n: unknown) => n });
class FakeCtx {
  currentTime = 0;
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

// Life Points: the counter's ticks scale with the hit, and a finish wails
const small = count(() => sfx.lpCount(-300, 7700));
const big = count(() => sfx.lpCount(-3000, 5000));
ok(small >= 10 && big > small, `LP drain ticks: 300 damage → ${small} sounds, 3000 damage → ${big}`);
ok(count(() => sfx.lpCount(-2000, 0)) > count(() => sfx.lpCount(-2000, 100)) - 2, 'LP hitting 0 plays the falling wail');
ok(count(() => sfx.lpCount(500, 8500)) >= 10, 'LP gain ticks upward');
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
