// Deck editor search: every card, forgiving words, type words and ATK/DEF (run: npx tsx tests/decksearch.test.ts).
import { cardMatches, matchRank, normSearch, parseQuery } from '../src/ui/deckSearch';
import type { CardInfo } from '../src/eds/types';

let failed = 0;
function ok(cond: boolean, msg: string) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!cond) failed++;
}
const bewd: CardInfo = { id: 1, name: 'Blue-Eyes White Dragon', kind: 'monster', sub: 'Normal', atk: 3000, def: 2500, level: 8, attribute: 'LIGHT', race: 'Dragon', desc: 'This legendary dragon is a powerful engine of destruction.' } as CardInfo;
const dm: CardInfo = { id: 2, name: 'Dark Magician', kind: 'monster', sub: 'Normal', atk: 2500, def: 2100, level: 7, attribute: 'DARK', race: 'Spellcaster', desc: 'The ultimate wizard in terms of attack and defense.' } as CardInfo;
const pot: CardInfo = { id: 3, name: 'Pot of Greed', kind: 'spell', sub: 'Normal', desc: 'Draw 2 cards.' } as CardInfo;
const sk: CardInfo = { id: 4, name: 'Peak Performance (Skill Card)', kind: 'spell', sub: 'Skill', character: 'Seto Kaiba', desc: 'Once per Duel, you can draw.' } as CardInfo;
const m = (c: CardInfo, q: string, text = false) => cardMatches(c, parseQuery(q), text);

ok(normSearch('Blue-Eyes  White') === 'blue eyes white', 'hyphens and case are ignored');
ok(m(bewd, 'blue eyes') && m(bewd, 'blueeyes') && m(bewd, 'BLUE-EYES'), 'Blue-Eyes is found however it is typed');
ok(m(bewd, 'white blue'), 'words can come in any order');
ok(m(bewd, 'dragon light') && !m(dm, 'dragon'), 'type and attribute words work');
ok(m(dm, 'dark spellcaster') && m(dm, 'lv7') && m(dm, 'level 7'), 'level words work');
ok(m(pot, 'spell') && !m(bewd, 'spell'), 'card kind words work');
ok(m(bewd, 'atk>2500') && !m(dm, 'atk>2500') && m(dm, 'atk>=2500') && m(dm, 'atk 2500'), 'ATK words compare');
ok(m(dm, 'def<2200') && !m(pot, 'def<2200'), 'DEF words only find monsters');
ok(m(bewd, 'dragon atk>2000'), 'words and stats together');
ok(!m(pot, 'draw') && m(pot, 'draw', true), 'card text is searched only with In text on');
ok(m(sk, 'kaiba') && m(sk, 'skill'), 'Skills are found by their duelist');
ok(m(bewd, 'dragon atk>') && m(dm, 'dark def') && m(bewd, 'atk dragon') && m(bewd, 'atk> dragon'), 'a half-typed stat word waits for its number');
ok(!m(bewd, 'zzz'), 'a word nowhere finds nothing');
ok(matchRank(dm, parseQuery('dark magician')) < matchRank(bewd, parseQuery('dragon')), 'an exact name ranks first');

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
