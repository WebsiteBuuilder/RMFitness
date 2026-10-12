// Computer-vs-computer duels with the real card database and real duelist decks.
// Run: npx tsx tests/ai.test.ts
import { readFileSync } from 'node:fs';
import { Engine } from '../src/eds/engine';
import { aiAction } from '../src/eds/ai';
import { DUELISTS } from '../src/eds/campaign';
import type { CardInfo } from '../src/eds/types';
import { SCRIPTED } from '../src/eds/effects';

const raw = JSON.parse(readFileSync('public/cards/cards.json', 'utf8')) as any[];
const DB = new Map<string, CardInfo>();
for (const r of raw) {
  const t: string = r.type;
  let kind: CardInfo['kind'] = 'monster';
  let sub = 'Normal';
  if (t === 'Spell Card') (kind = 'spell'), (sub = r.race ?? 'Normal');
  else if (t === 'Trap Card') (kind = 'trap'), (sub = r.race ?? 'Normal');
  else if (/Fusion/.test(t)) sub = 'Fusion';
  else if (/Ritual/.test(t)) sub = 'Ritual';
  else if (/Effect|Flip|Spirit|Toon|Union/.test(t)) sub = 'Effect';
  const info: CardInfo = { id: r.id, name: r.name, kind, sub, atk: r.atk, def: r.def, level: r.level, attribute: r.attribute, race: kind === 'monster' ? r.race : undefined, desc: r.desc, n: r.n, password: r.password };
  DB.set(info.name, info);
  DB.set(info.name.toLowerCase(), info);
  if (r.alias) (DB.set(r.alias, info), DB.set(r.alias.toLowerCase(), info));
}
console.log('db', DB.size, 'scripted effects', SCRIPTED.length);
const unknown = new Set<string>();
for (const d of DUELISTS) for (const n of d.deck) if (!DB.has(n) && !DB.has(n.toLowerCase())) unknown.add(n);
console.log('deck names missing from db:', [...unknown]);

let failures = 0;
let totalActions = 0;
const results: string[] = [];
for (let g = 0; g < 30; g++) {
  const a = DUELISTS[g % DUELISTS.length];
  const b = DUELISTS[(g * 7 + 3) % DUELISTS.length];
  const e = new Engine(DB);
  e.apply({ type: 'START', first: (g % 2) as 0 | 1, seed: 1000 + g, names: [a.name, b.name], decks: [a.deck, b.deck], fusions: [a.fusion, b.fusion] });
  let n = 0;
  let stuck = 0;
  let lastLog = 0;
  while (e.state.winner === null && n < 1500) {
    const p = e.state.prompt ? e.state.prompt.player : e.state.turnPlayer;
    const act = aiAction(e, p);
    if (!act) {
      failures++;
      console.log(`FAIL game ${g}: no action for player ${p} in ${e.state.phase} prompt=${e.state.prompt?.kind}`);
      break;
    }
    try {
      e.apply(act);
    } catch (err) {
      failures++;
      console.log(`FAIL game ${g}: engine threw on`, act, err);
      break;
    }
    n++;
    if (e.state.log.length === lastLog && !e.state.prompt) {
      stuck++;
      if (stuck > 30) {
        failures++;
        console.log(`FAIL game ${g}: ignored actions loop`, act, e.state.phase, e.state.turn);
        break;
      }
    } else stuck = 0;
    lastLog = e.state.log.length;
  }
  totalActions += n;
  if (e.state.winner === null && n >= 1500) {
    failures++;
    console.log(`FAIL game ${g}: no result after 1500 actions (turn ${e.state.turn})`);
  }
  results.push(`${a.name} vs ${b.name}: ${e.state.winner === null ? 'unfinished' : e.state.winner === 'draw' ? 'draw' : e.state.players[e.state.winner].name + ' wins'} T${e.state.turn} (${e.state.winReason})`);
}
console.log(results.join('\n'));
console.log('avg actions', Math.round(totalActions / 30));
console.log(failures ? `${failures} FAILURES` : 'ALL OK');
process.exit(failures ? 1 : 0);
