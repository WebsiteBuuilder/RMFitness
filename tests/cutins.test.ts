// Anime portrait cut-ins: which moments get one, what is shouted, and how the director plays it
// (run: npx tsx tests/cutins.test.ts).
import { DB as APP_DB } from '../src/eds/db';
import type { Pid } from '../src/eds/types';
import type { CardRef, ChainCard, Cue } from '../src/art/cues';
import { attackLine, bestMonster, chainLine, CUTIN_DUR, CUTIN_OVERLAP, CutInPlan, duelFace, facesReady, finalLine, shoutName, showDuelFaces, showFaceHints } from '../src/art/cutins';
import { lineSize } from '../src/art/cutinDom';
import { CUE_KINDS_DRAWN, cueOwner } from '../src/art/runtime';
import { showDuelAces } from '../src/ace/ace';
import { getCutins, setCutins, useCinematicsMenu } from '../src/art/settings';
import { DB } from './speedkit';
import { readFileSync } from 'node:fs';

for (const [k, v] of DB) APP_DB.set(k, v);
// (the settings live in the phone's storage)
const store = new Map<string, string>();
Object.assign(globalThis, { window: { dispatchEvent: () => true }, localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};

const ref = (uid: number, name: string, controller: Pid, owner?: Pid): CardRef => ({ uid, name, faceUp: true, controller, owner, rect: null, def: false });
const attack = (a: CardRef, t: CardRef | null): Cue => ({ kind: 'attack', attacker: a, target: t, defender: a.controller === 0 ? 1 : 0 });
const link = (n: number, c: CardRef, what: ChainCard['what']): ChainCard => ({ n, card: c, what, who: '', mine: c.controller === 0, done: false, negated: false }) as ChainCard;
const cutsOf = (cs: Cue[]) => cs.filter((c): c is Extract<Cue, { kind: 'cutin' }> => c.kind === 'cutin');

const DM = ref(1, 'Dark Magician', 0);
const BE = ref(2, 'Blue-Eyes White Dragon', 1);
const CG = ref(3, 'Celtic Guardian', 0);

// ---------- faces ----------
showDuelFaces(null);
check(!facesReady(), 'no faces: no cut-ins');
check(cutsOf(new CutInPlan().plan([attack(DM, BE)], 1).cues).length === 0, 'without faces nothing is added');
showDuelFaces([
  { name: 'Jammy', art: 'Dark Magician', title: '' },
  { name: 'Seto Kaiba', art: bestMonster(['Celtic Guardian', 'Blue-Eyes White Dragon', 'Pot of Greed']), title: '' },
]);
check(bestMonster(['Celtic Guardian', 'Blue-Eyes White Dragon', 'Pot of Greed']) === 'Blue-Eyes White Dragon', 'a player with no Ace shows their strongest monster');
check(facesReady(), 'both faces known');
showFaceHints([null, { art: 'Blue-Eyes White Dragon', title: 'Duel Monsters Champion' }]);
check(duelFace(1)?.title === 'Duel Monsters Champion' && duelFace(1)?.name === 'Seto Kaiba', 'a computer duelist gets its VS portrait and title, its name stays');
showFaceHints([null, { art: 'No Such Card Anywhere', title: 'x' }]);
check(duelFace(1)?.art === 'Blue-Eyes White Dragon', 'an unknown portrait card falls back to the seat face');
showFaceHints(null);

// ---------- attacks ----------
{
  const plan = new CutInPlan();
  const r1 = plan.plan([attack(DM, BE)], 3);
  const c1 = cutsOf(r1.cues);
  check(c1.length === 1 && r1.cues[0].kind === 'cutin' && r1.cues[1].kind === 'attack', "a duelist's first attack of the turn: a cut-in just before it");
  check(c1[0].seat === 0 && c1[0].foe === 1 && c1[0].why === 'attack', 'it is the attacker who shouts, the defender who takes it');
  check(r1.added.length === 1 && r1.added[0] === 0, 'its position is reported (the flow gives it a scale)');
  check(c1[0].line.includes('Dark Magician'), `the shout names the attacker ("${c1[0].line}")`);
  const r2 = plan.plan([attack(CG, null)], 3);
  check(cutsOf(r2.cues).length === 0, 'a second attack the same turn: no cut-in (the duel stays quick)');
  const r3 = plan.plan([attack(BE, DM)], 4);
  check(cutsOf(r3.cues).length === 1 && cutsOf(r3.cues)[0].seat === 1, "the opponent's first attack of their turn gets one, with their face");
  const r4 = plan.plan([attack(DM, null)], 5);
  check(cutsOf(r4.cues).length === 1, 'a new turn: a new first attack');
  check(cutsOf(plan.plan([{ ...attack(DM, BE), replay: true } as Cue], 6).cues).length === 0, 'a replayed attack never gets one');
}
{
  // an Ace attacks every time with its cut-in; a borrowed one does not count as the taker's Ace
  showDuelAces([{ name: 'Dark Magician', lv: 3, wins: 10 }, null]);
  const plan = new CutInPlan();
  plan.plan([attack(CG, BE)], 3);
  const r = plan.plan([attack(DM, BE)], 3);
  check(cutsOf(r.cues).length === 1 && /Ace|Rise|moment/i.test(cutsOf(r.cues)[0].line), `the Ace gets its cut-in on every attack, with its own shout ("${cutsOf(r.cues)[0]?.line}")`);
  const plan2 = new CutInPlan();
  plan2.plan([attack(ref(9, 'Celtic Guardian', 1), DM)], 3);
  const stolen = plan2.plan([attack(ref(1, 'Dark Magician', 1, 0), null)], 3);
  check(cutsOf(stolen.cues).length === 0, "a taken Ace is not the taker's Ace");
  showDuelAces(null);
}

// ---------- chains ----------
{
  const plan = new CutInPlan();
  const TRAP = ref(20, 'Mirror Force', 1);
  const SPELL = ref(21, 'Mystical Space Typhoon', 0);
  const chain2: Cue = { kind: 'chain', stack: [link(1, ref(22, 'Pot of Greed', 0), 'spell'), link(2, TRAP, 'trap')], added: 2 };
  const r = plan.plan([chain2], 2);
  const c = cutsOf(r.cues);
  check(c.length === 1 && c[0].seat === 1 && c[0].why === 'chain', 'the other duelist answers a chain: their face cuts in');
  check(c[0].line.includes('Mirror Force'), `the shout names the card ("${c[0].line}")`);
  const self: Cue = { kind: 'chain', stack: [link(1, ref(22, 'Pot of Greed', 0), 'spell'), link(2, SPELL, 'spell')], added: 2 };
  check(cutsOf(plan.plan([self], 2).cues).length === 0, 'chaining onto your own card: no cut-in');
  const slam: Cue[] = [{ kind: 'slam', trap: TRAP, onto: DM }, chain2];
  check(cutsOf(plan.plan(slam, 2).cues).length === 0, 'a "Not so fast!" slam already has the moment: no cut-in');
  const long: Cue = { kind: 'chain', stack: [link(1, DM, 'monster'), link(2, TRAP, 'trap'), link(3, SPELL, 'spell'), link(4, ref(23, 'Waboku', 1), 'trap')], added: 4 };
  check(cutsOf(plan.plan([long], 2).cues).length === 0, 'a long back-and-forth: the first answer and the counter only');
  const two: Cue[] = [chain2, { kind: 'chain', stack: [link(1, ref(22, 'Pot of Greed', 0), 'spell'), link(2, TRAP, 'trap'), link(3, SPELL, 'spell')], added: 3 }];
  check(cutsOf(plan.plan(two, 2).cues).length === 1, 'one chain cut-in per update at most');
}

// ---------- the final blow ----------
{
  const plan = new CutInPlan();
  const hit: Cue = { kind: 'hit', attacker: DM, target: null, defender: 1, dmg: { player: 1, amount: 2500 } };
  const cues: Cue[] = [hit, { kind: 'damage', player: 1, amount: 2500 }, { ...hit, replay: true } as Cue, { kind: 'win', winner: 0, shadow: null }];
  const r = plan.plan(cues, 7);
  const c = cutsOf(r.cues);
  check(c.length === 1 && c[0].why === 'final' && c[0].seat === 0 && c[0].foe === 1, 'the final blow: the winner leads, the loser takes it');
  const at = r.cues.findIndex((x) => x.kind === 'cutin');
  check(r.cues[at + 1]?.replay === true, 'it plays right before the replay (and before an ending cutscene)');
  check(c[0].about === 'Dark Magician', 'it knows the finishing card');
  const fin: Cue[] = [hit, { kind: 'finale', card: DM, line: 'x', lv: 1, ace: true, replay: true } as Cue, { ...hit, replay: true } as Cue, { kind: 'win', winner: 0, shadow: null }];
  const rf = plan.plan(fin, 7);
  check(rf.cues[rf.cues.findIndex((x) => x.kind === 'cutin') + 1]?.kind === 'finale', 'with an ending cutscene: faces first, then the monster');
  const deckout: Cue[] = [{ kind: 'win', winner: 0, shadow: null }];
  check(cutsOf(plan.plan(deckout, 7).cues).length === 0, 'a win with no blow to replay: no cut-in');
  const draw: Cue[] = [{ ...hit, replay: true } as Cue, { kind: 'win', winner: 'draw', shadow: null }];
  check(cutsOf(plan.plan(draw, 7).cues).length === 0, 'a draw: no cut-in');
}

// ---------- shouts ----------
check(shoutName('Raviel, Lord of Phantasms') === 'Raviel', 'a long name is shouted short');
check(attackLine('Jinzo', { ace: false, direct: true }, 0).includes('directly'), 'a direct attack says so');
check(new Set([0, 1, 2, 3].map((i) => attackLine('Jinzo', { ace: false, direct: false }, i))).size === 4, 'attack shouts vary');
check(chainLine(link(2, ref(5, 'Trap Hole', 1), 'trap'), 0).startsWith('Trap card'), 'a Trap is opened');
check(chainLine(link(2, ref(5, '', 1), 'trap'), 0).length > 0, "a card the viewer can't know still gets a shout");
check(finalLine(0) !== finalLine(1), 'final shouts vary');
check(lineSize('Go, Jinzo!') === 1 && lineSize('Straight at you! Go, Blue-Eyes White Dragon!') < 0.6, 'long shouts are drawn smaller');

// ---------- the director and the settings ----------
check(CUE_KINDS_DRAWN.includes('cutin'), 'the director draws the cut-in');
check(cueOwner({ kind: 'cutin', why: 'attack', seat: 1, foe: 0, line: '', about: '' }) === 1, 'a cut-in belongs to the duelist shouting');
check(Object.values(CUTIN_DUR).every((d) => d < 1 && d > CUTIN_OVERLAP), 'every cut-in lasts under a second');
check(getCutins(), 'cut-ins are on by default');
setCutins(false);
check(!getCutins(), 'the Menu turns them off');
setCutins(true);
const src = readFileSync(new URL('../src/art/settings.ts', import.meta.url), 'utf8');
check(src.includes('Portrait cut-ins:') && typeof useCinematicsMenu === 'function', 'the duel Menu has a "Portrait cut-ins" item');
const css = readFileSync(new URL('../src/art/cutin.css', import.meta.url), 'utf8');
const anims = [...css.matchAll(/@keyframes[^{]+\{([\s\S]*?)\n\}/g)].map((m) => m[1]);
check(anims.length > 5 && anims.every((b) => !/(^|\s)(width|height|left|top|right|bottom|clip-path|filter|box-shadow|background)\s*:/.test(b)), 'the cut-in animates transforms and opacity only (cheap on a mid-range phone)');
check(!/infinite/.test(css), 'nothing loops forever');
const flow = readFileSync(new URL('../src/art/flow.tsx', import.meta.url), 'utf8');
check(flow.includes('getCutins()') && flow.includes('this.cutins.plan'), 'the flow plans cut-ins only when they are on');

console.log(fails ? `\n${fails} FAILED` : '\nall cut-in checks passed');
if (fails) process.exit(1);
