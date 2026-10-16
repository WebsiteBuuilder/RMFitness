// Controller support: every kind of pad reads as the same buttons, and the d-pad picks
// the button a player would expect. Run: npx tsx tests/pad.test.ts
import { familyOf, readPad, hatDirs, glyph, type PadLike } from '../src/ui/pad/map';
import { pickNext, nearest, type Box } from '../src/ui/pad/nav';
import { rumble } from '../src/ui/pad/rumble';

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) {
    fails++;
    console.log(`FAIL: ${msg}`);
  }
};

const pad = (id: string, mapping: string, pressed: number[], axes: number[] = [0, 0, 0, 0], n = 17): PadLike => ({
  id,
  mapping,
  buttons: Array.from({ length: n }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })),
  axes,
});

// ---- which controller (ids as Android Chrome, iPhone Safari and desktop browsers report them)
ok(familyOf('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)') === 'xbox', 'Xbox Series pad');
ok(familyOf('Xbox Wireless Controller') === 'xbox', 'Xbox on iPhone (no vendor id)');
ok(familyOf('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)') === 'ps', 'PS5 pad');
ok(familyOf('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)') === 'ps', 'PS4 pad on Android');
ok(familyOf('DUALSHOCK 4 Wireless Controller') === 'ps', 'PS4 pad on iPhone');
ok(familyOf('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)') === 'nintendo', 'Switch Pro');
ok(familyOf('Joy-Con (L/R) (STANDARD GAMEPAD Vendor: 057e Product: 200e)') === 'nintendo', 'Joy-Con pair');
ok(familyOf('Backbone One (STANDARD GAMEPAD)') === 'xbox', 'Backbone grip uses Xbox letters');
ok(familyOf('Razer Kishi V2') === 'xbox', 'Kishi grip uses Xbox letters');
ok(familyOf('USB Gamepad (Vendor: 0079 Product: 0011)') === 'generic', 'cheap USB pad');

// ---- standard mapping: bottom confirms, right goes back
const xb = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)';
ok(readPad(pad(xb, 'standard', [0])).held.has('a'), 'Xbox A is A');
ok(readPad(pad(xb, 'standard', [1])).held.has('b'), 'Xbox B is B');
ok(readPad(pad(xb, 'standard', [12])).held.has('up'), 'd-pad up');
ok(readPad(pad(xb, 'standard', [15])).held.has('right'), 'd-pad right');
ok(readPad(pad(xb, 'standard', [9])).held.has('start'), 'start');
ok(readPad(pad(xb, 'standard', [4, 5])).held.has('lb') && readPad(pad(xb, 'standard', [4, 5])).held.has('rb'), 'bumpers');
ok(readPad(pad('DualSense (Vendor: 054c)', 'standard', [0])).held.has('a'), 'PlayStation cross confirms');
// Nintendo prints A on the right: A still confirms, B (bottom) goes back
const ns = 'Pro Controller (STANDARD GAMEPAD Vendor: 057e)';
ok(readPad(pad(ns, 'standard', [1])).held.has('a'), 'Switch A (right) confirms');
ok(readPad(pad(ns, 'standard', [0])).held.has('b'), 'Switch B (bottom) goes back');
ok(glyph('nintendo', 'start') === '+' && glyph('ps', 'a') === '✕' && glyph('xbox', 'lb') === 'LB', 'button names per controller');
// analog triggers half-pressed count
{
  const p = pad(xb, 'standard', []);
  (p.buttons as { pressed: boolean; value: number }[])[7] = { pressed: false, value: 0.8 };
  ok(readPad(p).held.has('rt'), 'analog trigger past half counts');
}

// ---- sticks: left stick moves, with a little stickiness so it doesn't flicker
ok(readPad(pad(xb, 'standard', [], [0.9, 0, 0, 0])).held.has('right'), 'stick right');
ok(readPad(pad(xb, 'standard', [], [0, -0.8, 0, 0])).held.has('up'), 'stick up');
ok(!readPad(pad(xb, 'standard', [], [0.4, 0, 0, 0])).held.has('right'), 'small push is nothing');
ok(readPad(pad(xb, 'standard', [], [0.4, 0, 0, 0]), new Set(['right'])).held.has('right'), 'easing back stays held');
ok(readPad(pad(xb, 'standard', [], [0, 0, 0, 0.7])).sy > 0.5, 'right stick scrolls');
ok(readPad(pad(xb, 'standard', [], [0, 0, 0.1, 0.1])).sy === 0, 'right stick dead zone');

// ---- pads the browser can't map
const gen = 'Generic USB Joystick';
ok(readPad(pad(gen, '', [0], [0, 0], 12)).held.has('a'), 'generic first button confirms');
ok(readPad(pad(gen, '', [], [0, 0, 0, 0, 0, 0, -1, 0], 12)).held.has('left'), 'generic d-pad on axes 6/7');
ok(readPad(pad(gen, '', [], [0, 0, 0, 0, 0, 0, 0, 1], 12)).held.has('down'), 'generic d-pad down on axis 7');
ok(readPad(pad(gen, '', [], [0, 0, 0, 0, 0, 0, 0, 0, 0, -1], 12)).held.has('up'), 'hat switch up');
ok(hatDirs(1.2857).length === 0, 'hat at rest');
ok(hatDirs(-1 + 2 / 7).join() === 'up,right', 'hat diagonal');
ok(hatDirs(1).join() === 'left' || hatDirs(1).join() === 'up,left', 'hat end of range');
ok(readPad(pad(gen, '', [], [0, 0, 0.9, 0.9], 12)).sy === 0, 'unknown pads never scroll from axes 2/3 (often triggers)');

// ---- d-pad navigation
const b = (left: number, top: number, w = 80, h = 40): Box => ({ left, top, right: left + w, bottom: top + h });
// a 3x3 grid of buttons
const grid: Box[] = [];
for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) grid.push(b(20 + c * 100, 20 + r * 60));
const center = grid[4];
const others = grid.filter((x) => x !== center);
const at = (i: number) => grid.indexOf(others[i]);
ok(at(pickNext(center, 'right', others)) === 5, 'grid right');
ok(at(pickNext(center, 'left', others)) === 3, 'grid left');
ok(at(pickNext(center, 'up', others)) === 1, 'grid up');
ok(at(pickNext(center, 'down', others)) === 7, 'grid down');
ok(pickNext(grid[2], 'right', grid.filter((_, i) => i !== 2)) === -1, 'nothing past the edge');
// a fanned hand: cards overlap
const hand = [0, 1, 2, 3, 4].map((i) => b(40 + i * 44, 600, 70, 102));
ok(pickNext(hand[2], 'right', [hand[0], hand[1], hand[3], hand[4]]) === 2, 'overlapping hand: next card right');
ok(pickNext(hand[2], 'left', [hand[0], hand[1], hand[3], hand[4]]) === 1, 'overlapping hand: next card left');
// a straight line beats a closer diagonal
ok(pickNext(b(100, 100), 'down', [b(260, 150), b(100, 260)]) === 1, 'straight down beats a diagonal off to the side');
// up from the hand reaches the field row above it
const field = [b(60, 420, 70, 90), b(150, 420, 70, 90), b(240, 420, 70, 90)];
ok(pickNext(hand[2], 'up', field) === 1, 'up from the middle card goes to the middle zone');
// the picked card sits 8px above the rest of the hand: down still goes below the hand, not sideways
{
  const raised = b(122, 656, 52, 76);
  const row = [b(65, 664, 52, 76), b(179, 664, 52, 76)];
  const menu = b(20, 742, 370, 30);
  ok(pickNext(raised, 'down', [...row, menu]) === 2, 'down from a raised hand card goes to the menu below');
  ok(pickNext(raised, 'left', [...row, menu]) === 0, 'left from a raised hand card is its neighbour');
}
ok(nearest(150, 40, grid) === 1, 'nearest box to a point');
ok(nearest(0, 0, []) === -1, 'nothing to land on');

// ---- rumble is safe without a controller (or a browser)
rumble(1, 1, 100);
ok(true, 'rumble without a controller');

console.log(fails ? `${fails} FAILED` : 'pad: all checks passed');
if (fails) process.exit(1);
