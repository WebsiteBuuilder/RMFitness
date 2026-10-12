// Verifies every card named in the starter decks exists in the generated card database.
import { readFileSync, existsSync } from 'node:fs';

const dbPath = new URL('../public/cards/cards.json', import.meta.url);
const decksPath = new URL('../src/data/starterDecks.json', import.meta.url);

if (!existsSync(dbPath)) {
  console.log('No card database yet (public/cards/cards.json). Skipping deck check.');
  process.exit(0);
}

const norm = (s) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const db = JSON.parse(readFileSync(dbPath, 'utf8'));
const names = new Set(db.map((c) => norm(c.name)));
const decks = JSON.parse(readFileSync(decksPath, 'utf8'));

let missing = 0;
for (const deck of decks) {
  const all = [...deck.main, ...deck.extra].map(([n]) => n).concat(deck.skills);
  for (const n of all) {
    if (!names.has(norm(n))) {
      console.log(`MISSING in ${deck.title}: ${n}`);
      missing++;
    }
  }
  const mainCount = deck.main.reduce((a, [, n]) => a + n, 0);
  if (mainCount < 20 || mainCount > 30) console.log(`SIZE ${deck.title}: main deck has ${mainCount} cards`);
}
console.log(missing === 0 ? 'All starter deck cards found.' : `${missing} card name(s) not found.`);
process.exit(missing === 0 ? 0 : 1);
