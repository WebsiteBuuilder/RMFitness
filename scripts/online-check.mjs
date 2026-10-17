// Checks the live online service from outside: sign-in and the duelist list. Prints no names or data.
// Run by .github/workflows/online-check.yml (the cloud container can't reach the database).
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/sync/firebaseConfig.ts', import.meta.url), 'utf8');
const pick = (k) => (new RegExp(`${k}: '([^']+)'`).exec(src) ?? [])[1];
const apiKey = pick('apiKey');
const db = pick('databaseURL');
if (!apiKey || !db) {
  console.log('No Firebase config: online play stays phone to phone.');
  process.exit(0);
}
const lines = [];
const say = (ok, what) => (lines.push(`${ok ? '✅' : '❌'} ${what}`), console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`));

const signUp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ returnSecureToken: true }),
});
const user = await signUp.json();
say(signUp.ok, signUp.ok ? 'Anonymous sign-in is on' : `Anonymous sign-in failed: ${user?.error?.message}`);
const token = user.idToken;

const list = await fetch(`${db}/duelists.json?shallow=true`);
const names = list.ok ? Object.keys((await list.json()) ?? {}).length : -1;
say(list.ok, list.ok ? `Database reachable, ${names} shared duelist account(s)` : `Duelist list not readable (HTTP ${list.status})`);

if (token) {
  // leave no test account behind
  await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: token }),
  });
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Online service\n\n${lines.join('\n\n')}\n`);
}
