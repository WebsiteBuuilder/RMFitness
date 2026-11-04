// Damage counter pop: how hard a Life Points change lands (lpHitRules.ts).
import { crackPaths, emitLpHit, lpCountMs, lpHit, lpListeners, sparkCount } from '../src/ui/lpHitRules';

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};

ok(lpHit(4000, 4000, true) === null, 'no change, no hit');
const scratch = lpHit(4000, 3900, true)!;
const big = lpHit(4000, 1500, true)!;
const huge = lpHit(4000, 1000, true)!;
ok(scratch.kind === 'damage' && scratch.amount === 100 && scratch.tier === 0, 'a 100 LP scratch is tier 0');
ok(big.tier === 3 && big.sev === 1, '2500 of 4000 LP is a crushing blow');
ok(scratch.shake < big.shake && scratch.rays < big.rays && scratch.reach < big.reach && scratch.scale < big.scale, 'everything scales with the hit');
ok(scratch.shake >= 2 && big.shake <= 16, 'shake stays between a twitch and a jolt');
const into = lpHit(1500, 900, true)!;
const plain = lpHit(2100, 1500, true)!;
ok(into.danger && into.intoDanger && !plain.danger, 'dropping to 1000 or less is danger');
ok(into.shake > plain.shake && into.rays > plain.rays, 'a hit into danger shakes and cracks harder than the same hit above it');
ok(lpHit(900, 700, true)!.danger && !lpHit(900, 700, true)!.intoDanger, 'already in danger: no new DANGER tag');
ok(huge.danger && huge.intoDanger, 'exactly 1000 LP counts as danger (same as the Danger state)');
const ko = lpHit(800, 0, true)!;
ok(ko.ko && !ko.danger, 'reaching 0 is a KO, not danger');
const heal = lpHit(1000, 1500, true)!;
ok(heal.kind === 'heal' && heal.shake === 0 && heal.rays === 0, 'a heal neither shakes nor cracks');
ok(lpHit(8000, 7000, false)!.sev === lpHit(4000, 3500, true)!.sev, 'the 8000 LP game scales the same way');
ok(sparkCount(into) > 0 && sparkCount(ko) > 0 && sparkCount(plain) === 0 && sparkCount(heal) === 0, 'sparks only when the gauge breaks under 1000 (or hits 0)');

// cracks: inside the bar, the same every time for the same seed
const a = crackPaths(big, 300, 40, 400, 50, 42);
const b = crackPaths(big, 300, 40, 400, 50, 42);
ok(JSON.stringify(a) === JSON.stringify(b), 'cracks are seeded');
const nums = a.flatMap((c) => c.d.match(/-?[\d.]+/g)!.map(Number));
const xs = nums.filter((_, i) => i % 2 === 0);
const ys = nums.filter((_, i) => i % 2 === 1);
ok(Math.min(...xs) >= 0 && Math.max(...xs) <= 400 && Math.min(...ys) >= 0 && Math.max(...ys) <= 50, 'cracks stay inside the bar');
ok(a.filter((c) => c.main).length === big.rays, 'one main crack per ray');

// the bus: a counter coming back from 0 (a new duel) is not a heal
const seen: number[] = [];
const l = (_w: 0 | 1, f: number, t: number) => void seen.push(t - f);
lpListeners.add(l);
emitLpHit(0, 4000, 3000);
emitLpHit(0, 0, 4000);
emitLpHit(1, 1000, 1500);
lpListeners.delete(l);
ok(seen.join() === '-1000,500', 'hits reach listeners; a reset from 0 does not');

// the counter rolls longer for bigger changes, like the show's
ok(lpCountMs(-100) < lpCountMs(-1000) && lpCountMs(-1000) < lpCountMs(-3000), 'bigger change, longer roll');
ok(lpCountMs(-50) >= 450 && lpCountMs(-8000) === 1500 && lpCountMs(500) === lpCountMs(-500), 'roll between 0.45 s and 1.5 s, same for gains');

if (fails) {
  console.log(`${fails} failed`);
  process.exit(1);
}
console.log('lphit: all ok');
