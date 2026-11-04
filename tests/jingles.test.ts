// Entrance jingles: the roster and its economy (free, Duel Chips, earned), each score playable
// and short, the duel's jingles per side, the jingle riding a room's JOIN, and the music themes.
import assert from 'node:assert/strict';
import { buyJingle, cantBuyJingle, chosenJingle, DEFAULT_JINGLE, duelJingleOf, hasJingle, isJingle, jingleForName, jingleFromWire, jingleLength, JINGLES, pickJingle, showDuelJingles } from '../src/jingles/jingles';
import { performJingle, playJingle, stopAllJingles } from '../src/jingles/play';
import { pickTheme, THEMES, THEME_PREFS, themeDef, DuelMusic } from '../src/ui/music';
import { DuelSession } from '../src/eds/session';
import { MemoryAdapter } from '../src/sync/memory';
import { newSpeedSave, type SpeedSave } from '../src/eds/speedSave';
import { newSoloSave, type SoloSave } from '../src/eds/speedCampaign/save';
import { newRanked, RANKED_TIERS, tierFloor } from '../src/eds/speedCampaign/ranked';
import { LESSONS } from '../src/eds/tutorial';

let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log(`ok ${name}`);
};
const withChips = (s: SpeedSave, chips: number) => ({ ...s, chips }) as SpeedSave;
const soloAt = (tierId: string): SoloSave => {
  const step = tierFloor(RANKED_TIERS.findIndex((x) => x.id === tierId));
  return { ...newSoloSave(), ranked: { ...newRanked('2026-11'), step, peak: step } };
};

// a stand-in AudioContext that logs what starts
const log: { type?: string; f?: number; t: number }[] = [];
const param = (v = 0) => ({ value: v, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} });
const node = () => ({ connect: (x: unknown) => x, disconnect() {} });
class FakeCtx {
  currentTime = 0;
  sampleRate = 8000;
  state = 'running';
  destination = node();
  createBuffer = (_c: number, len: number) => ({ sampleRate: 8000, getChannelData: () => new Float32Array(len) });
  createGain = () => ({ ...node(), gain: param(1) });
  createDynamicsCompressor = () => ({ ...node(), threshold: param(), ratio: param() });
  createConvolver = () => ({ ...node(), buffer: null });
  createBiquadFilter = () => ({ ...node(), type: '', Q: param(), frequency: param() });
  createOscillator = () => {
    const o: Record<string, unknown> = { ...node(), type: '', detune: param() };
    o.frequency = { ...param(), setValueAtTime: (f: number) => (o.f = f) };
    o.start = (at: number) => log.push({ type: o.type as string, f: o.f as number, t: at });
    o.stop = () => {};
    return o;
  };
  createBufferSource = () => ({ ...node(), buffer: null, loop: false, start: (at: number) => log.push({ type: 'noise', t: at }), stop() {} });
}
const ctx = new FakeCtx() as unknown as AudioContext;

t('12 jingles, unique ids, 3 free, some bought, some earned', () => {
  assert.equal(JINGLES.length, 12);
  assert.equal(new Set(JINGLES.map((j) => j.id)).size, JINGLES.length);
  assert.equal(JINGLES.filter((j) => 'free' in j.cost).length, 3);
  assert.ok(JINGLES.filter((j) => 'chips' in j.cost).length >= 3);
  assert.ok(JINGLES.filter((j) => !('free' in j.cost) && !('chips' in j.cost)).length >= 4);
  for (const j of JINGLES) {
    assert.ok(isJingle(j.id));
    assert.match(j.hue, /^#[0-9a-f]{6}$/i);
  }
});

t('every jingle is short (about 3 s) and plays real notes', () => {
  for (const j of JINGLES) {
    const len = jingleLength(j);
    assert.ok(len >= 1.5 && len <= 3.5, `${j.id}: ${len.toFixed(2)} s`);
    const before = log.length;
    const got = playJingle(j.id, 0, ctx);
    assert.ok(Math.abs(got - len) < 1e-9);
    const notes = log.slice(before);
    assert.ok(notes.length >= 5, `${j.id}: ${notes.length} sounds`);
    assert.ok(notes.every((x) => x.t >= 0 && x.t <= len + 0.1), `${j.id}: a note outside its length`);
    for (const x of notes) if (x.f !== undefined) assert.ok(x.f > 20 && x.f < 12000, `${j.id}: ${x.f} Hz`);
  }
});

t('a jingle can be cut short: it fades and lets go, once; leaving a duel cuts them all', () => {
  const g: { ramps: number; gone: number } = { ramps: 0, gone: 0 };
  const c2 = Object.assign(new FakeCtx(), {
    createGain: () => ({ connect: (x: unknown) => x, disconnect: () => g.gone++, gain: { ...param(1), linearRampToValueAtTime: () => g.ramps++ } }),
  }) as unknown as AudioContext;
  const a = performJingle('duelist', 0, c2)!;
  const b = performJingle('magic', 0.5, c2)!;
  assert.ok(a.len > 1.5 && b.len > 1.5);
  a.stop();
  a.stop(); // twice is harmless
  assert.equal(g.ramps, 1);
  stopAllJingles(); // only b is left
  assert.equal(g.ramps, 2);
  assert.equal(performJingle('nope', 0, c2), null);
});

t('nothing plays while the audio is not running (no late bursts)', () => {
  const sleepy = Object.assign(new FakeCtx(), { state: 'suspended' }) as unknown as AudioContext;
  const before = log.length;
  assert.equal(playJingle('duelist', 0, sleepy), 0);
  assert.equal(playJingle('nope', 0, ctx), 0);
  assert.equal(log.length, before);
});

t('free ones are everyone’s; the default is Duelist’s Call', () => {
  const s = newSpeedSave();
  assert.equal(chosenJingle(s), DEFAULT_JINGLE);
  for (const j of JINGLES) assert.equal(hasJingle(s, j.id), 'free' in j.cost, j.id);
});

t('buying: needs the chips, takes them once, then it can be picked', () => {
  const s = newSpeedSave();
  const id = JINGLES.find((j) => 'chips' in j.cost)!.id;
  const price = (JINGLES.find((j) => j.id === id)!.cost as { chips: number }).chips;
  assert.ok(cantBuyJingle(withChips(s, price - 1), id));
  assert.equal(buyJingle(withChips(s, price - 1), id), null);
  assert.equal(pickJingle(s, id), null);
  const bought = buyJingle(withChips(s, price + 2), id)!;
  assert.equal(bought.chips, 2);
  assert.ok(hasJingle(bought, id));
  assert.ok(cantBuyJingle(bought, id));
  assert.equal(chosenJingle(pickJingle(bought, id)!), id);
  assert.ok(cantBuyJingle(withChips(s, 99), 'pharaoh'), 'earned ones are never sold');
});

t('earned: Ranked tiers, Duel School; a lost one falls back to the default', () => {
  const s = newSpeedSave();
  assert.ok(!hasJingle(s, 'pharaoh', soloAt('silver')));
  assert.ok(hasJingle(s, 'pharaoh', soloAt('gold')));
  assert.ok(hasJingle(s, 'shadowgame', soloAt('king')));
  assert.ok(!hasJingle(s, 'academy'));
  assert.ok(hasJingle({ ...s, school: LESSONS.map((l) => l.id) } as unknown as SpeedSave, 'academy'));
  const picked = pickJingle(s, 'pharaoh', soloAt('gold'))!;
  assert.equal(chosenJingle(picked, soloAt('gold')), 'pharaoh');
  assert.equal(chosenJingle(picked, soloAt('bronze')), DEFAULT_JINGLE);
  assert.equal(chosenJingle({ ...s, jingle: 'made-up' } as SpeedSave), DEFAULT_JINGLE);
});

t('computer duelists have their own, the same every time', () => {
  assert.equal(jingleForName('Yami Yugi'), 'pharaoh');
  assert.equal(jingleForName('Seto Kaiba'), 'dragon');
  assert.equal(jingleForName('Marik Ishtar'), 'shadowgame');
  assert.equal(jingleForName('Some Duelist'), jingleForName('Some Duelist'));
  assert.ok(isJingle(jingleForName('Some Duelist')));
});

t('the jingle rides a room JOIN; junk is dropped', () => {
  const ses = new DuelSession(new MemoryAdapter());
  ses.send({ type: 'JOIN', player: 0, name: 'A', deck: [], fusion: [], mode: 'speed', jingle: 'toon' });
  ses.send({ type: 'JOIN', player: 1, name: 'B', deck: [], fusion: [], mode: 'speed', jingle: 'x'.repeat(40) });
  const seats = (ses as unknown as { seats: { jingle?: string }[] }).seats;
  assert.equal(jingleFromWire(seats[0].jingle), 'toon');
  assert.equal(seats[1].jingle, undefined);
  assert.equal(jingleFromWire('not-a-jingle'), null);
  showDuelJingles(['toon', null]);
  assert.equal(duelJingleOf(0), 'toon');
  assert.equal(duelJingleOf(1), null);
  showDuelJingles(null);
  assert.equal(duelJingleOf(0), null);
});

t('themes: four, each different in key or tempo, all play', () => {
  assert.equal(THEMES.length, 4);
  assert.equal(new Set(THEMES.map((x) => `${x.key}/${x.tempo}`)).size, 4);
  for (const th of THEMES) {
    const m = new DuelMusic(ctx, 3, th);
    const before = log.length;
    m.setMood({ level: 1, myTurn: true });
    m.pump(12);
    assert.ok(log.length - before > 60, `${th.id} plays`);
    assert.equal(m.keyShift, th.key);
    m.stop();
  }
  assert.equal(themeDef('nope').id, 'classic');
  assert.ok(THEME_PREFS.some((p) => p.id === 'moment') && THEME_PREFS.some((p) => p.id === 'rotate'));
});

t('a calm Battle City has a beat; a calm Duelist has none', () => {
  const quiet = (id: string) => {
    const c = new FakeCtx() as unknown as AudioContext;
    const m = new DuelMusic(c, 5, themeDef(id));
    const before = log.length;
    m.pump(8);
    return log.slice(before).filter((x) => x.type === 'noise').length;
  };
  assert.equal(quiet('classic'), 0);
  assert.ok(quiet('battle') > 5);
});

t('theme by the moment, taking turns, or fixed', () => {
  assert.equal(pickTheme('shadow', { ranked: true }, 'Kaiba', 12, 0), 'shadow');
  assert.equal(pickTheme('moment', { raid: true }, 'Boss', 12, 0), 'kingdom');
  assert.equal(pickTheme('moment', {}, 'Marik Ishtar', 12, 0), 'shadow');
  assert.equal(pickTheme('moment', { ranked: true }, 'Joey', 12, 0), 'battle');
  assert.equal(pickTheme('moment', { online: true }, 'Bro', 12, 0), 'battle');
  assert.equal(pickTheme('moment', {}, 'Seto Kaiba', 12, 0), 'battle');
  assert.equal(pickTheme('moment', {}, 'Yami Yugi', 12, 0), 'kingdom');
  assert.equal(pickTheme('moment', {}, 'Some Duelist', 23, 0), 'shadow');
  assert.equal(pickTheme('moment', {}, 'Some Duelist', 3, 0), 'shadow');
  const day = new Set([0, 1, 2, 3].map((n) => pickTheme('moment', {}, 'Some Duelist', 14, n)));
  assert.equal(day.size, 4, 'daytime duels take turns');
  const rot = [0, 1, 2, 3, 4].map((n) => pickTheme('rotate', { ranked: true }, 'Marik', 23, n));
  assert.deepEqual(rot.slice(0, 4).sort(), THEMES.map((x) => x.id).sort());
  assert.equal(rot[4], rot[0]);
});

console.log(`jingles: all ${n} passed`);
