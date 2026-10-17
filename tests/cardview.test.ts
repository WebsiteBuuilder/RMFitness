// Deck editor: a card waits for Add before it goes in, and Limited groups say no in time.
import limited from '../src/eds/data/speedLimited.json';
import { limitedGroupFull } from '../src/eds/speedSave';

let bad = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) (bad++, console.error('FAIL', what));
};
const groups = Object.entries(limited.limited as Record<string, string[]>);
for (const [n, names] of groups) {
  const lim = Number(n);
  const first = names[0];
  check(limitedGroupFull([], first) === null, `${first}: room in an empty deck`);
  const full = Array.from({ length: lim }, (_, i) => names[i % names.length]);
  check(limitedGroupFull(full, first) !== null, `${first}: Limited ${lim} group full after ${lim}`);
  check(limitedGroupFull(full.slice(1), first) === null, `${first}: room with ${lim - 1}`);
}
console.log(bad ? `cardview: ${bad} failed` : `cardview: all ok (${groups.length} Limited groups)`);
if (bad) process.exit(1);
