// The Shadow Realm bail-out: "I'm wack, give me my monster back" frees sealed cards
// for free, counts the confession as a record only, and leaves wins and rescues working.
// Run: npx tsx tests/shadow-release.test.ts
import { bailoutsOf, releaseSealed, sealedCards, unsealedDeck, withShadow, type ShadowResult } from '../src/art/shadow';
import { newSpeedSave, withSpeedResult } from '../src/eds/speedSave';
import { stakesFor } from '../src/collection/stakes';
import { chipsOf } from '../src/collection/economy';

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) console.log(`FAIL: ${msg}`);
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
  if (!c) fails++;
};

const sent = (card: string): ShadowResult => ({ loser: 0, winner: 1, loserName: 'Jammy', winnerName: 'Bro', excess: 1500, sealed: card });
let s = newSpeedSave();
for (const [i, c] of ['Dark Magician', 'Blue-Eyes White Dragon', 'Summoned Skull'].entries()) s = withShadow(s, 'l', sent(c), 0, 'Bro', false, i + 1).save;
ok(sealedCards(s).length === 3, 'three losses by overkill seal three cards');
ok(bailoutsOf(s) === 0, 'nobody has begged yet');

// beg for one
const before = { ...s, chips: chipsOf(s) };
let r = releaseSealed(s, 'Blue-Eyes White Dragon');
ok(r.freed.length === 1 && r.freed[0] === 'Blue-Eyes White Dragon', 'begging for one card frees exactly that card');
ok(sealedCards(r.save).map((x) => x.name).join() === 'Dark Magician,Summoned Skull', 'the other sealed cards stay sealed, in order');
ok(bailoutsOf(r.save) === 1, 'the bail-out is counted');
ok(chipsOf(r.save) === before.chips && r.save.wins === s.wins && r.save.losses === s.losses, 'it costs nothing and changes no record but the bail-out count');
ok(unsealedDeck(r.save, { main: ['Blue-Eyes White Dragon', 'Dark Magician'] }).main.join() === 'Blue-Eyes White Dragon', 'the freed card is back in the deck for the next duel');
ok(!stakesFor(r.save, false).sealed.some((x) => x.name === 'Blue-Eyes White Dragon'), 'a freed card is no longer offered as a rescue stake');

// begging for a card that is not sealed does nothing
const none = releaseSealed(r.save, 'Kuriboh');
ok(none.freed.length === 0 && none.save === r.save, 'begging for a card that is not sealed changes nothing');

// beg for all
const all = releaseSealed(r.save, null);
ok(all.freed.length === 2 && sealedCards(all.save).length === 0, 'begging for all frees every sealed card');
ok(bailoutsOf(all.save) === 3, 'one bail-out counted per card freed');
ok(releaseSealed(all.save, null).freed.length === 0, 'nothing left to beg for');

// the proud way still works after a bail-out
s = withShadow(all.save, 'l', sent('Dark Magician'), 0, 'Bro', false, 9).save;
s = withShadow(withSpeedResult(s, 'w', 'Bro'), 'w', null, 0, 'Bro', false, 10).save;
ok(sealedCards(s).length === 0 && bailoutsOf(s) === 3, 'a win still frees a sealed card, and does not count as begging');

if (fails) {
  console.log(`${fails} failure(s)`);
  process.exit(1);
}
console.log('shadow-release: all checks pass');
