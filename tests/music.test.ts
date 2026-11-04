// The duel soundtrack: calm with no drums at the start, drums at 2000 LP or less, a harder
// drive at 1000 or less, a swell for an ace, a cadence at the end, and the Music setting
// (run: npx tsx tests/music.test.ts).
import { DuelMusic, levelFor, isAceSummon, BPM, onMusicBar } from '../src/ui/music';
import { musicEnabled, setMusicEnabled, soundEnabled } from '../src/ui/sound';

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};

const log: { kind: string; type?: string; f?: number; t: number }[] = [];
const param = (v = 0) => ({ value: v, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} });
const node = () => ({ connect: (n: unknown) => n, disconnect() {} });
class FakeCtx {
  currentTime = 0;
  sampleRate = 8000;
  state = 'running';
  destination = node();
  createBuffer = (_c: number, n: number) => ({ sampleRate: 8000, getChannelData: () => new Float32Array(n) });
  createGain = () => ({ ...node(), gain: param(1) });
  createDynamicsCompressor = () => ({ ...node(), threshold: param(), ratio: param() });
  createConvolver = () => ({ ...node(), buffer: null });
  createBiquadFilter = () => ({ ...node(), type: '', Q: param(), frequency: param() });
  createOscillator = () => {
    const o = { ...node(), type: '', frequency: { ...param(), setValueAtTime: (f: number) => ((o as { f?: number }).f = f) }, detune: param(), start: (t: number) => log.push({ kind: 'osc', type: o.type, f: (o as { f?: number }).f, t }), stop() {} };
    return o;
  };
  createBufferSource = () => ({ ...node(), buffer: null, loop: false, start: (t: number) => log.push({ kind: 'noise', t }), stop() {} });
}

const between = (a: number, b: number) => log.filter((x) => x.t >= a && x.t < b);
const ctx = new FakeCtx();
const m = new DuelMusic(ctx as unknown as AudioContext, 7);

// calm: 16 s, no drums (no noise), pads and arpeggios playing
m.setMood({ level: 0, myTurn: true });
m.pump(16);
const calm = between(0, 16);
ok(calm.filter((x) => x.kind === 'osc').length > 40, `calm music plays (${calm.length} notes in 16 s)`);
ok(calm.filter((x) => x.kind === 'noise').length === 0, 'no drums while both duelists are above 2000 LP');
ok(m.playingLevel === 0, 'calm level');

// someone falls to 2000: drums from the next bar
m.setMood({ level: levelFor([2000, 4000]), myTurn: true });
m.pump(32);
ok(m.playingLevel === 1, 'drums level at 2000 LP');
const drums = between(19, 32).filter((x) => x.kind === 'noise').length;
ok(drums > 30, `drums play under 2000 LP (${drums} hits)`);

// a lead line comes in with the drums (square voices only play in the lead and plucks' attack)
const leads = between(19, 32).filter((x) => x.type === 'square' && (x.f ?? 0) > 250 && (x.f ?? 0) < 1100).length;
ok(leads > 10, `a lead melody plays once the drums are in (${leads} notes)`);

// final stretch: denser
ok(m.keyShift === 0, 'the drums level stays in D minor');
m.setMood({ level: levelFor([900, 3000]), myTurn: true });
m.pump(48);
ok(m.playingLevel === 2, 'final stretch at 1000 LP or less');
const hard = between(35, 48).filter((x) => x.kind === 'noise').length;
ok(hard > drums, `final stretch hits harder (${hard} vs ${drums})`);
ok(BPM[2] > BPM[1] && BPM[1] > BPM[0], 'the tempo rises with the danger');
ok(m.keyShift === 2, 'the final stretch lifts the key a step (D to E)');

// opponent's turn: the arpeggio drops lower
const avgTri = (a: number, b: number) => {
  const t = between(a, b).filter((x) => x.kind === 'osc' && x.type === 'triangle' && (x.f ?? 0) > 150);
  return t.reduce((s, x) => s + (x.f ?? 0), 0) / Math.max(1, t.length);
};
const mine = avgTri(40, 48);
m.setMood({ level: 2, myTurn: false });
m.pump(60);
ok(avgTri(52, 60) < mine * 0.8, `opponent's turn sounds darker (arp ${Math.round(avgTri(52, 60))} Hz vs ${Math.round(mine)} Hz)`);

// an ace: brass swell (many saws) right away
ctx.currentTime = 60;
const before = log.length;
m.ace(true);
const swell = log.slice(before);
ok(swell.filter((x) => x.type === 'sawtooth').length >= 20, `an ace summon swells (${swell.length} voices)`);
const again = log.length;
m.ace(false);
ok(log.length === again, 'one swell at a time');
ctx.currentTime = 66;
const b2 = log.length;
m.ace(false);
ok(log.length > b2, "the opponent's ace gets its own swell later");

// ace rules
ok(isAceSummon({ kind: 'monster', level: 8, atk: 3000 }, 'tribute'), 'Blue-Eyes is an ace');
ok(isAceSummon({ kind: 'monster', level: 7, atk: 2500 }, 'tribute'), 'Dark Magician (Level 7) is an ace');
ok(isAceSummon({ kind: 'monster', level: 4, atk: 2600 }, 'special'), 'a 2600 ATK Level 4 is an ace');
ok(!isAceSummon({ kind: 'monster', level: 1, atk: 300 }, 'normal'), 'Kuriboh is not');
ok(isAceSummon(undefined, 'fusion'), 'any Fusion Summon is an ace');

// the end: a cadence then nothing more
const b3 = log.length;
m.end('win');
ok(log.length > b3, 'a win plays a closing cadence');
const b4 = log.length;
m.pump(90);
m.ace(true);
ok(log.length === b4, 'no more music after the end');

// a cinematic after the end does not undo the fade
const m3 = new DuelMusic(ctx as unknown as AudioContext, 5);
m3.end('lose');
const ends = log.length;
m3.duck(true);
m3.duck(false);
ok(m3.isEnded && log.length === ends, 'ducking after the end changes nothing');

// a phone that was locked: no burst of catch-up notes
const m2 = new DuelMusic(ctx as unknown as AudioContext, 3);
ctx.currentTime = 200;
const b5 = log.length;
m2.pump(200.3);
ok(log.length - b5 < 30, `after a long sleep it restarts instead of catching up (${log.length - b5} notes)`);
const [, stepNow, nextAt] = m2.position;
const n16 = (nextAt - (66 + 0.15)) / (60 / BPM[0] / 4);
ok(Math.abs(n16 - Math.round(n16)) < 1e-6 && stepNow === Math.round(n16) % 16, `the beat stays on its grid after a sleep (16th #${Math.round(n16)}, step ${stepNow})`);
m2.stop();
const b6 = log.length;
m2.pump(210);
ok(log.length === b6, 'stopped music stays stopped');

// the weather hears each bar line ahead of time, in the music's tempo
{
  const bars: [number, number, number][] = [];
  const stop = onMusicBar((inSec, bar, level) => bars.push([inSec, bar, level]));
  const m4 = new DuelMusic(ctx as unknown as AudioContext, 11);
  ctx.currentTime = 300;
  m4.setMood({ level: 2, myTurn: true });
  m4.pump(310);
  stop();
  m4.pump(320);
  const barLen = (60 / BPM[2]) * 4;
  const gaps = bars.slice(1).map((b, i) => b[0] - bars[i][0]);
  ok(bars.length >= 4 && bars.every((b) => b[0] >= 0 && b[2] === 2), `bar lines heard ahead of time at the storm level (${bars.length})`);
  ok(gaps.length > 2 && gaps.slice(1).every((g) => Math.abs(g - barLen) < 0.01), 'bar lines arrive one bar apart');
  ok(bars.length < 10, 'a listener that left hears nothing more');
  m4.stop();
}

// the Music setting
ok(musicEnabled(), 'Music is on by default');
setMusicEnabled(false);
ok(!musicEnabled() && soundEnabled(), 'Music Off leaves Sound on');
setMusicEnabled(true);

if (fails) {
  console.log(`${fails} failed`);
  process.exit(1);
}
console.log('music: all passed');
