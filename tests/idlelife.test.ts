// Monster idle life (src/art/idleLife.ts): every Type and Attribute in the Speed Duel pool idles
// its own way, nothing it does ever drifts far from its card, and the moods read as they should.
// Run: npx tsx tests/idlelife.test.ts
import { readFileSync } from 'node:fs';
import { GLANCE_S, glanceEnvelope, idlePoseInto, idleStyleFor, moteStyleFor, newIdlePose, presenceMotes, presenceOf, temperOf, wornAmount, WORN_FADE_MS, WORN_MS, type IdleMood } from '../src/art/idleLife';

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) (fails++, console.log(`FAIL: ${msg}`));
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
};

// every Type and Attribute printed on a Speed Duel monster has its own idle and its own motes
const pool = JSON.parse(readFileSync(new URL('../public/cards/speed.json', import.meta.url), 'utf8')) as { race?: string; attribute?: string; atk?: number }[];
const monsters = pool.filter((c) => c.race && c.atk !== undefined);
ok(monsters.length > 500, 'the Speed Duel pool has its monsters');
const races = new Set(monsters.map((c) => c.race!));
for (const r of races) ok(temperOf(r) !== 'calm', `${r} has its own way of idling`);
const attrs = new Set(monsters.map((c) => c.attribute!));
for (const a of attrs) ok(moteStyleFor(a) !== null, `${a} monsters give off motes`);
ok(moteStyleFor(undefined) === null && moteStyleFor('') === null, 'no Attribute, no motes');
ok(new Set([...attrs].map((a) => moteStyleFor(a)!.kind)).size === attrs.size, 'each Attribute has its own kind of mote');

// temperaments
ok(idleStyleFor('Fairy').hover > 0 && idleStyleFor('Winged Beast').hover > 0, 'Fairies and Winged Beasts hover');
ok(idleStyleFor('Dragon').hover === 0 && idleStyleFor('Warrior').hover === 0, 'Dragons and Warriors stand on their card');
ok(idleStyleFor('Dragon').breathAmp > idleStyleFor('Warrior').breathAmp, 'a Dragon breathes deeper than a Warrior');
ok(idleStyleFor('Machine').breathAmp === 0 && idleStyleFor('Machine').steps > 0, 'a Machine does not breathe, it turns in servo steps');
ok(idleStyleFor('Rock').swayAmp < idleStyleFor('Fiend').swayAmp, 'a Rock barely moves, a Fiend sways');
ok(idleStyleFor('Dragon', 8).breathRate < idleStyleFor('Dragon', 4).breathRate, 'a big monster breathes slower');

// presence
ok(presenceOf(4, 1800, false) === 0, 'a plain monster has no aura');
ok(presenceOf(7, 2400, false) === 1 && presenceOf(4, 2500, false) === 1, 'a boss (Level 7+ or 2500+ ATK) has an aura');
ok(presenceOf(3, 1000, true) === 2, 'the Ace always has the gold aura');
ok(presenceMotes(2) > presenceMotes(1) && presenceMotes(1) > presenceMotes(0), 'motes come thicker round a boss and an Ace');

// battle-worn wears off
ok(wornAmount(-1) === 0, 'never hit: not worn');
ok(wornAmount(0) === 1 && wornAmount(WORN_MS) === 1, 'worn right after surviving an attack');
ok(wornAmount(WORN_MS + WORN_FADE_MS / 2) > 0 && wornAmount(WORN_MS + WORN_FADE_MS / 2) < 1, 'it recovers gradually');
ok(wornAmount(WORN_MS + WORN_FADE_MS) === 0, 'and is fresh again');

// the glance turns and comes back
ok(glanceEnvelope(0) === 0 && glanceEnvelope(1) === 0, 'a glance starts and ends facing front');
ok(glanceEnvelope(0.5) === 1, 'it holds the look in the middle');
ok(GLANCE_S < 3, 'a glance is short');

// poses: sweep every temperament through time and moods; nothing drifts far from its card
const calm: IdleMood = { braced: false, worn: 0, tense: false, kneel: 0, presence: 0, glance: 0 };
const moods: IdleMood[] = [
  calm,
  { ...calm, braced: true },
  { ...calm, worn: 1 },
  { ...calm, tense: true },
  { ...calm, kneel: 1 },
  { ...calm, presence: 2, glance: 1 },
  { ...calm, worn: 1, tense: true, braced: true, presence: 1, glance: -1 },
];
const out = newIdlePose();
let maxLift = 0;
let maxTurn = 0;
let maxRoll = 0;
let maxScale = 0;
let bad = 0;
for (const r of [...races, 'Unknown'])
  for (const m of moods)
    for (let t = 0; t < 60; t += 0.037) {
      const p = idlePoseInto(out, idleStyleFor(r, 8), m, t, 377);
      for (const v of Object.values(p)) if (!Number.isFinite(v)) bad++;
      maxLift = Math.max(maxLift, p.lift);
      maxTurn = Math.max(maxTurn, Math.abs(p.turn));
      maxRoll = Math.max(maxRoll, Math.abs(p.roll));
      maxScale = Math.max(maxScale, Math.abs(p.sx - 1), Math.abs(p.sy - 1));
      if (m.kneel === 1 && p.lift > 0.03) bad++;
      if (p.float < 0 || p.float > 1 || p.aura < 0 || p.aura > 0.6 || p.dark < 0) bad++;
    }
ok(bad === 0, `every pose is finite and in range (${bad} bad)`);
ok(maxLift > 0.05 && maxLift <= 0.15, `a hover lifts it clear of the card but never off it (max ${maxLift.toFixed(3)} card widths)`);
ok(maxTurn <= 0.65, `it never turns its back (max ${maxTurn.toFixed(2)} rad)`);
ok(maxRoll <= 0.15, `it never tips over (max ${maxRoll.toFixed(2)} rad)`);
ok(maxScale > 0.015 && maxScale <= 0.06, `breathing shows but stays subtle (max ${(maxScale * 100).toFixed(1)}%)`);

// moods change the pose the right way
const at = (r: string, m: IdleMood, t: number) => ({ ...idlePoseInto(newIdlePose(), idleStyleFor(r), m, t, 11) });
ok(at('Fairy', calm, 3).lift > 0 && at('Fairy', { ...calm, kneel: 1 }, 3).lift < 0.03, 'a hovering monster lands when it kneels in Defense');
ok(at('Warrior', { ...calm, worn: 1 }, 2).lean > 0, 'battle-worn: it hunches forward');
ok(at('Warrior', { ...calm, worn: 1 }, 2).dark > 0, 'battle-worn: it looks a little dimmer');
ok(at('Warrior', { ...calm, braced: true }, 2).lean < 0, 'braced: it leans back from what is aimed at it');
ok(at('Warrior', { ...calm, glance: 1 }, 2).turn > at('Warrior', { ...calm, glance: -1 }, 2).turn + 0.5, 'a glance turns it toward the arrival');
ok(at('Dragon', { ...calm, presence: 2 }, 1).aura > 0 && at('Dragon', calm, 1).aura === 0, 'only a boss or an Ace has an aura');
// tense breathing is quicker: count breath peaks over 20 s
const peaks = (m: IdleMood) => {
  let n = 0;
  let prev = 0;
  let rising = false;
  for (let t = 0; t < 20; t += 0.01) {
    const sy = idlePoseInto(out, idleStyleFor('Warrior'), m, t, 5).sy;
    if (sy < prev && rising) n++;
    rising = sy > prev;
    prev = sy;
  }
  return n;
};
ok(peaks({ ...calm, tense: true }) > peaks(calm) * 1.4, 'in danger it breathes quicker');
ok(peaks({ ...calm, worn: 1 }) < peaks(calm), 'battle-worn it breathes slower');
// neighbours are out of step
ok(Math.abs(idlePoseInto(newIdlePose(), idleStyleFor('Warrior'), calm, 4, 1).sy - idlePoseInto(newIdlePose(), idleStyleFor('Warrior'), calm, 4, 900).sy) > 1e-4, 'two monsters do not breathe in step');

// the board, the settings and the stylesheet are wired up
const board = readFileSync(new URL('../src/art/board.ts', import.meta.url), 'utf8');
ok(board.includes('idlePoseInto(') && board.includes('emitMotes('), 'the field figures use idle life');
ok(board.includes('settling ? 16 : this.idleOn ? 50 : lean ? 33 : 66'), 'settled figures draw at 20 fps with idle life (15 without)');
ok(board.includes('calmMotion()') && board.includes('getIdle()'), 'idle life follows the menu switch and Reduce motion');
const settings = readFileSync(new URL('../src/art/settings.ts', import.meta.url), 'utf8');
ok(settings.includes('Monster idle life:'), 'the duel menu has the Monster idle life switch');
const css = readFileSync(new URL('../src/ui/idlelife.css', import.meta.url), 'utf8');
ok(css.includes('prefers-reduced-motion') && css.includes('body.art-on'), 'the table holds still for Reduce motion and under a cinematic');
ok(css.includes(':not(.pad-focus)') && css.includes(':not(.anim-draw)') && css.includes(":not([class*='anim-'])"), "idle motions never override a card's draw, summon, pick or controller-focus animation");
ok(!/body\.art-on \.duel/.test(css) && !/animation: none !important/.test(css), 'pausing and Reduce motion only touch idle life, never the other card animations');
ok(!board.includes('idle.aura * 0.22') && !/uPulse\.value = .*aura/.test(board), "the aura never borrows the attack-ready pulse");
ok(/const EMIT: Emit/.test(board) && !/pool\.emit\(\{/.test(board), 'motes reuse one scratch emit (no allocation per mote)');
ok(!/box-shadow|filter:|width:|height:|top:|left:/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'the stylesheet animates nothing that repaints or reflows');

if (fails) {
  console.log(`idlelife: ${fails} FAILED`);
  process.exit(1);
}
console.log('idlelife: all passed');
