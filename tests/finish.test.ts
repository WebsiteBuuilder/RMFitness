// Card finishes in the duel's 3D scenes: whose finish a card shows, the colors, and
// that a Glossy-or-better summon always gets its cinematic under "Big moments".
import { pickCues } from '../src/art/flow';
import { FIN, finishGlow, finishId, finishOf, finishPalette } from '../src/art/finish';
import type { Cue } from '../src/art/cues';
import { showDuelRarity } from '../src/level/duelRarity';

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};

showDuelRarity([{ 'Battle Ox': FIN.OF, 'Lord of D.': FIN.GL }, { 'Battle Ox': FIN.UR }]);
ok(finishOf({ name: 'Battle Ox', controller: 0 }) === FIN.OF, "a card shows its controller's finish");
ok(finishOf({ name: 'Battle Ox', controller: 0, owner: 1 }) === FIN.UR, "a taken card shows its owner's finish");
ok(finishOf({ name: 'Battle Ox', controller: 0, faceUp: false }) === 0, 'a face-down card shows no finish');
ok(finishOf({ name: '', controller: 0 }) === 0, 'a hidden card shows no finish');
ok(finishId(FIN.OF) === 'OF' && finishId(FIN.GL) === 'GL' && finishId(2) === '', 'finish ids for the name plate');
ok(finishPalette(2) === null && (finishPalette(FIN.OF)?.length ?? 0) >= 6, 'Overframe sparks in the full rainbow');
const hues = new Set([0, 0.7, 1.4, 2.1].map((t) => finishGlow(FIN.OF, t)));
ok(hues.size === 4, 'the Overframe glow turns through colors');
ok(finishGlow(1, 0) === -1, 'a Rare keeps its own colors');

const summon = (name: string): Cue => ({ kind: 'summon', special: false, card: { uid: 1, name, faceUp: true, controller: 0, rect: null, def: false } });
ok(pickCues([summon('Lord of D.')], 'big', 0).length === 1, 'a Glossy level-4 summon plays under Big moments');
ok(pickCues([summon('Battle Ox')], 'big', 0).length === 1, 'an Overframe level-4 summon plays under Big moments');
ok(pickCues([summon('Kaibaman')], 'big', 0).length === 0, 'a plain level-3 summon still skips');
showDuelRarity(null);
ok(finishOf({ name: 'Battle Ox', controller: 0 }) === 0, 'outside a duel nothing is left over');

if (fails) {
  console.log(`${fails} FAILED`);
  process.exit(1);
}
console.log('ALL OK');
