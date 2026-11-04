// The Duel Disk camera (src/ui/duelCamRules.ts, src/art/cam.ts): the right moment of a batch
// gets the move, every move starts and ends at rest and stays slight, it leans toward the
// action, and a card seen through the camera maps back to where it rests (so the 3D figures
// stand on their cards all the way through a shot).
// Run: npx tsx tests/duelcam.test.ts
import { STRENGTH, fitPose, pickMoment, poseMatrix, shotFor, cssMatrix, type ShotKind } from '../src/ui/duelCamRules';
import { IDENTITY, apply, invert, isIdentity, mul, parseMatrix, unmapWith } from '../src/art/cam';
import type { EngineEvent } from '../src/eds/types';

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) (fails++, console.log(`FAIL: ${msg}`));
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
};
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

let seq = 0;
const ev = (kind: string, extra: Partial<EngineEvent> = {}): EngineEvent => ({ kind, seq: ++seq, ...extra });
const field = (uid: number) => uid < 100;

// ----- which moment -----
ok(pickMoment([], field) === null, 'nothing happened: no move');
ok(pickMoment([ev('draw', { uid: 5 })], field) === null, 'a draw gets no move');
ok(pickMoment([ev('summon', { uid: 5, player: 0 })], field)?.kind === 'summon', 'a Normal Summon pushes in');
ok(pickMoment([ev('summon', { uid: 5, how: 'tribute' })], field)?.kind === 'bigSummon', 'a Tribute Summon is the bigger push');
ok(pickMoment([ev('summon', { uid: 5, how: 'fusion' })], field)?.kind === 'bigSummon', 'a Fusion Summon is the bigger push');
ok(pickMoment([ev('summon', { uid: 500 })], field) === null, 'a summon that is not on the field any more gets nothing');
ok(pickMoment([ev('set', { uid: 7 })], field)?.kind === 'set', 'a monster Set is a small nudge');
ok(pickMoment([ev('set', { uid: 700 })], field) === null, 'a Spell/Trap Set (not a monster zone) gets nothing');
ok(pickMoment([ev('flip', { uid: 7 })], field)?.kind === 'summon', 'a flip pushes in like a summon');
const atk = pickMoment([ev('summon', { uid: 5 }), ev('attack', { uid: 5, target: 9, player: 0 }), ev('hit', { uid: 9 })], field);
ok(atk?.kind === 'attack' && atk.uid === 5 && atk.target === 9, 'an attack outranks the summon before it and the blow after it');
ok(pickMoment([ev('attack', { uid: 5, target: null })], field)?.kind === 'direct', 'a direct attack');
ok(pickMoment([ev('hit', { uid: 9 })], field)?.kind === 'impact', 'a blow on its own is a kick');
ok(pickMoment([ev('summon', { uid: 5 }), ev('summon', { uid: 6 })], field)?.uid === 6, 'two summons: the latest');

// ----- the moves -----
const box = { cx: 200, cy: 300, w: 360, h: 420 };
const kinds: ShotKind[] = ['set', 'summon', 'bigSummon', 'attack', 'direct', 'impact', 'settle'];
for (const k of kinds) {
  const s = shotFor({ kind: k }, box, { x: 320, y: 400 }, 1, { x: 120, y: 160 })!;
  ok(!!s, `${k}: a move`);
  ok(s.frames[0].at === 0 && s.frames[s.frames.length - 1].at === 1, `${k}: frames cover the whole shot`);
  const end = poseMatrix(s.frames[s.frames.length - 1].pose, box);
  ok(isIdentity(end), `${k}: ends at rest`);
  ok(isIdentity(poseMatrix(s.frames[0].pose, box)), `${k}: starts at rest`);
  ok(s.ms >= 400 && s.ms <= 1700, `${k}: short (${s.ms} ms)`);
  for (const f of s.frames) {
    ok(f.pose.zoom <= 1.09 && f.pose.zoom >= 1, `${k}: slight push (${f.pose.zoom})`);
    ok(Math.abs(f.pose.roll) <= 3, `${k}: slight roll (${f.pose.roll})`);
    ok(f.pose.pitch >= 0 && f.pose.pitch <= 16, `${k}: a few degrees of tilt (${f.pose.pitch})`);
  }
  ok(shotFor({ kind: k }, box, { x: 320, y: 400 }, 0) === null, `${k}: Off moves nothing`);
}
const peak = (k: ShotKind, st: number) => Math.max(...shotFor({ kind: k }, box, { x: 320, y: 400 }, st, { x: 120, y: 160 })!.frames.map((f) => f.pose.zoom));
ok(peak('set', 1) < peak('summon', 1) && peak('summon', 1) < peak('bigSummon', 1), 'Set < summon < big summon');
ok(peak('summon', STRENGTH.soft) - 1 < (peak('summon', STRENGTH.full) - 1) * 0.6, 'Soft is about half of Full');
const rollOf = (x: number) => Math.max(...shotFor({ kind: 'summon' }, box, { x, y: 400 }, 1)!.frames.map((f) => f.pose.roll));
ok(rollOf(350) > 0, 'a summon right of the middle rolls clockwise');
ok(Math.min(...shotFor({ kind: 'summon' }, box, { x: 50, y: 400 }, 1)!.frames.map((f) => f.pose.roll)) < 0, '...left of it, the other way');
const lean = shotFor({ kind: 'attack' }, box, { x: 300, y: 420 }, 1, { x: 100, y: 180 })!;
ok(Math.min(...lean.frames.map((f) => f.pose.roll)) < 0, 'an attack toward the left leans left');
ok(Math.abs(lean.frames[1].pose.focus.x - 300) < 40 && lean.frames[2].pose.focus.x === 100, 'an attack leans on the attacker, then swings to the target');
ok(Math.sign(lean.frames[1].pose.roll) !== Math.sign(lean.frames[2].pose.roll), '...rolling across as it swings');
const blowEv = pickMoment([ev('attack', { uid: 5, target: 9 }), ev('hit', { uid: 9 })], field)!;
ok(blowEv.blow === true, 'a blow in the same batch rides on the attack');
ok(shotFor(blowEv, box, { x: 300, y: 420 }, 1, { x: 100, y: 180 })!.frames.length > lean.frames.length, '...as an extra punch in');

// ----- the map -----
const s1 = shotFor({ kind: 'bigSummon' }, box, { x: 330, y: 420 }, 1)!;
const P = s1.frames[2].pose;
const m = poseMatrix(P, box);
const [fx, fy] = apply(m, P.focus.x, P.focus.y);
ok(near(fx, P.focus.x + (box.cx - P.focus.x) * P.pull, 0.01) && near(fy, P.focus.y + (box.cy - P.focus.y) * P.pull, 0.01), 'the focus drifts toward the middle by its pull');
// the tilt: the far side (above the focus) comes out narrower than the near side
const [tlx] = apply(m, P.focus.x - 100, P.focus.y - 150);
const [trx] = apply(m, P.focus.x + 100, P.focus.y - 150);
const [blx] = apply(m, P.focus.x - 100, P.focus.y + 150);
const [brx] = apply(m, P.focus.x + 100, P.focus.y + 150);
ok(trx - tlx < brx - blx - 2, `the far side leans away (${(trx - tlx).toFixed(1)} < ${(brx - blx).toFixed(1)})`);
ok(isIdentity(poseMatrix({ ...P, zoom: 1, roll: 0, pitch: 0, pull: 0 }, box)), 'a resting pose is the identity');
// a card seen through the camera maps back to its resting place
const rest = { left: 300, top: 390, width: 60, height: 86, right: 360, bottom: 476 };
const pts = [[300, 390], [360, 390], [300, 476], [360, 476]].map(([x, y]) => apply(m, x, y));
const xs = pts.map((q) => q[0]);
const ys = pts.map((q) => q[1]);
const seen = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys), width: 0, height: 0 };
seen.width = seen.right - seen.left;
seen.height = seen.bottom - seen.top;
const back = unmapWith(seen, m);
ok(near(back.left + back.width / 2, 330, 1.5) && near(back.top + back.height / 2, 433, 1.5), `unmap: a card under the camera maps back to where it rests (${back.left.toFixed(1)},${back.top.toFixed(1)})`);
ok(Math.abs(back.width - 60) < 6 && Math.abs(back.height - 86) < 6, `unmap: about its resting size (${back.width.toFixed(1)}x${back.height.toFixed(1)})`);
ok(unmapWith(rest, IDENTITY) === rest, 'unmap at rest is free (the same rectangle)');
ok(mul(m, invert(m)).every((v, i) => near(v / mul(m, invert(m))[8], IDENTITY[i], 1e-6)), 'invert');
// CSS round trips (matrix3d when tilted, matrix when flat)
const css = cssMatrix(m);
ok(css.startsWith('matrix3d('), 'a tilted pose is a matrix3d');
const pm = parseMatrix(css);
const [qx, qy] = apply(pm, 123, 456);
const [rx, ry] = apply(m, 123, 456);
ok(near(qx, rx, 0.01) && near(qy, ry, 0.01), 'parse matrix3d(...) gives the same map');
const flat = poseMatrix({ ...P, pitch: 0 }, box);
ok(cssMatrix(flat).startsWith('matrix('), 'a flat pose is a plain matrix');
const pf = parseMatrix(cssMatrix(flat));
ok(near(apply(pf, 50, 60)[0], apply(flat, 50, 60)[0], 0.01), 'parse matrix(...)');
ok(parseMatrix('none') === IDENTITY, 'parse none');

// ----- the field stays in the free area -----
{
  const fb = { cx: 206, cy: 380, w: 400, h: 520 };
  const content = { left: 10, top: 130, right: 402, bottom: 630 };
  const safe = { left: 0, top: 120, right: 412, bottom: 640 };
  const sh = shotFor({ kind: 'attack' }, fb, { x: 300, y: 560 }, 1, { x: 110, y: 200 })!;
  for (const f of sh.frames) {
    const q = fitPose(f.pose, fb, content, safe);
    const m2 = poseMatrix(q, fb);
    const pts2 = [[10, 130], [402, 130], [10, 630], [402, 630]].map(([x, y]) => apply(m2, x, y));
    ok(pts2.every(([x, y]) => x >= -6.6 && x <= 418.6 && y >= 119.4 && y <= 640.6), `fit: corners stay in the free area at ${f.at}`);
    ok(q.zoom <= f.pose.zoom + 1e-9 && Math.abs(q.pitch) <= Math.abs(f.pose.pitch) + 1e-9, 'fit only ever scales back');
  }
  const roomy = fitPose(sh.frames[2].pose, fb, content, { left: -500, top: -500, right: 1500, bottom: 1500 });
  ok(roomy === sh.frames[2].pose, 'fit leaves a pose with room as it is');
}

if (fails) {
  console.log(`duelcam: ${fails} failed`);
  process.exit(1);
}
console.log('duelcam: all passed');
