// Holographic summons (src/art/holo.ts): the hologram's beats fit inside the summon (it is never
// made longer), bigger summons get the bigger show, and the field figures' arrival ends solid.
// Run: npx tsx tests/holo.test.ts
import { boardHolo, flickerAt, glitchAt, holoPlan, holoPower, holoReveal } from '../src/art/holo';

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) (fails++, console.log(`FAIL: ${msg}`));
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
};

// power by summon method
ok(holoPower(undefined, {}) === 0, 'a Normal Summon is the small show');
ok(holoPower('normal', {}) === 0, 'normal is small');
ok(holoPower(undefined, { tribute: true }) === 1, 'a Tribute Summon is the middle show');
ok(holoPower('special', {}) === 1, 'a Special Summon is the middle show');
for (const m of ['fusion', 'ritual', 'xyz', 'synchro', 'link'] as const) ok(holoPower(m, {}) === 2, `${m} is the big show`);
ok(holoPower(undefined, { over: true }) === 2, 'Overframe is the big show');
ok(holoPower(undefined, { ace: true }) === 2, "an Ace's entrance is the big show");

// the summon's real windows (runtime.ts): E = [1.35, 1.55, 1.85, 2.15][tier] + extras; reveal 0.42 / 0.62 (Overframe) (+0.2 Fusion/Ritual, +0.1 materialize)
// every E the summon can have: tier base + Fusion-ish 0.3 + Overframe 0.3 + Millennium 0.35 + Ace extras
const Es: number[] = [];
for (const base of [1.35, 1.55, 1.85, 2.15])
  for (const fus of [0, 0.3])
    for (const ov of [0, 0.3, 0.65])
      for (const ace of [0, 0.4, 0.8, 1.2]) Es.push(+(base + fus + ov + ace).toFixed(2));
const reveals = [...new Set(['rise', 'descend', 'erupt', 'splash', 'materialize', 'portal', 'fusion', 'ritual'].flatMap((e) => [holoReveal(e, false), holoReveal(e, true)]))];
ok(reveals.length >= 5, 'reveal times come from the shared helper');
for (const p of [0, 1, 2] as const)
  for (const E of Es)
    for (const rv of reveals) {
      const h = holoPlan(p, rv, E);
      const tag = `power ${p} E ${E} reveal ${rv}`;
      ok(h.solidEnd <= E - 0.3 + 1e-9, `${tag}: solid before it flies to its card`);
      ok(h.solidAt > rv && h.solidAt < h.solidEnd, `${tag}: the front climbs after the reveal`);
      ok(h.beamAt < rv && h.beamAt >= 0.28, `${tag}: the beam fires just before the monster shows, after the card lands`);
      ok(h.beamEnd <= E, `${tag}: the beam is gone before the flight ends`);
      ok(h.glitches.length >= 1 && h.glitches.length <= p + 1, `${tag}: up to ${p + 1} signal tears`);
      ok(h.glitches.every(([a, d]) => a >= rv - 1e-9 && a + d <= h.solidEnd + 1e-9), `${tag}: tears happen while it is a hologram`);
    }
// bigger shows hold the hologram longer when there is room
const a = holoPlan(0, 0.42, 2.15);
const c = holoPlan(2, 0.42, 2.15);
ok(c.solidEnd > a.solidEnd, 'the big show stays a hologram longer');

// tearing and flicker are bounded and deterministic
const h = holoPlan(2, 0.42, 2.15);
ok(h.glitches.length === 3, 'a roomy big show tears three times');
let maxG = 0;
for (let t = 0; t < 2.2; t += 0.005) maxG = Math.max(maxG, glitchAt(h, t));
ok(maxG > 0.9 && maxG <= 1, 'tearing peaks at 1');
ok(glitchAt(h, 0) === 0 && glitchAt(h, h.solidEnd + 0.01) === 0, 'no tearing before or after');
let drops = 0;
for (let t = 0; t < 10; t += 0.01) {
  const f = flickerAt(t, 3);
  ok(f >= 0 && f <= 0.45, 'flicker in range');
  if (f > 0) drops++;
}
ok(drops > 20 && drops < 400, `flicker is short dropouts, not constant (${drops}/1000)`);
ok(flickerAt(1.234, 7) === flickerAt(1.234, 7), 'flicker is deterministic');

// a field figure's arrival: projected first, front climbing, solid at the end
ok(boardHolo(0).holo === 1 && boardHolo(0).line < 0, 'arrives as light');
ok(boardHolo(0.3).line < 0 && boardHolo(0.3).reveal > 0.7, 'projected in quickly, still a hologram');
ok(boardHolo(0.7).line > 0 && boardHolo(0.7).line < 1, 'the front climbs');
ok(boardHolo(0.97).line >= 1, 'solid just before the end');
ok(boardHolo(1).holo === 0 && boardHolo(1).reveal === 1, 'solid at the end');

if (fails) {
  console.log(`holo: ${fails} failed`);
  process.exit(1);
}
console.log('holo: all passed');
