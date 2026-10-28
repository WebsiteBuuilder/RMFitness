// Art coverage by count: plays random Speed Duels, feeds every batch of new engine events
// through the art engine's toCues (as the duel screen does) and counts, per card and per
// Skill, how often it was activated / summoned and how often that produced a cue.
// Used by scripts/art-coverage.ts (the full report) and tests/art-coverage.test.ts (fast check).
import { readFileSync } from 'node:fs';
import { Engine } from '../src/eds/engine';
import { DB as APP_DB } from '../src/eds/db';
import { SKILLS as SKILL_DEFS } from '../src/eds/skills';
import type { Action, EngineEvent, Pid } from '../src/eds/types';
import { memoField, toCues, type Cue, type CueTrack } from '../src/art/cues';
import { DB, PLAYABLE, aiAction, getEffect, pick, randomAction, setSeed, shuffle } from './speedkit';

// The app's card lookup (cues.ts reads card kinds through it) reads its own map.
for (const [k, v] of DB) APP_DB.set(k, v);

export interface Tally {
  seen: number;
  cued: number;
}
export interface Coverage {
  games: number;
  fails: string[];
  /** summons by method: how -> card name -> tally */
  summons: Map<string, Map<string, Tally>>;
  /** activations ('activate' events with a card): spell / trap / monster -> card name -> tally */
  activations: Map<string, Map<string, Tally>>;
  /** triggered and continuous effects at work ('effect' events): spell / trap / monster -> card name -> tally */
  effects: Map<string, Map<string, Tally>>;
  /** Skill name -> tally of its activations (start of duel, Draw Phase, activated, End Phase) */
  skills: Map<string, Tally>;
  /** Skills brought to a duel */
  skillsBrought: Set<string>;
  /** leave / heal / effect draw: tally by kind */
  moves: Map<string, Tally>;
  /** event kinds never turned into a cue (by design: phase, turn, the normal draw...) and how many */
  quiet: Map<string, number>;
  /** player actions (activate, summon, effect, Skill...) whose whole episode made no cue at all */
  silentActions: Map<string, number>;
  /** batches where more events happened than the engine keeps (the cap of 40): events the screen never saw */
  lostEvents: number;
  lostWhere: string[];
}

const supported = PLAYABLE.filter((c) => c.vanilla || !!getEffect(c.name));
const isExtra = (sub: string) => sub === 'Fusion' || sub === 'Xyz' || sub === 'Synchro' || sub === 'Link';
const MAIN = supported.filter((c) => !isExtra(c.sub)).map((c) => c.name);
const EXTRA = supported.filter((c) => isExtra(c.sub)).map((c) => c.name);
export const SKILL_NAMES = Object.keys(SKILL_DEFS).sort();
const SKILL_TEXT: Record<string, string> = Object.fromEntries((JSON.parse(readFileSync('public/cards/speed.json', 'utf8')) as any[]).filter((r) => r.type === 'Skill Card').map((r) => [r.name, r.desc]));

const kindOf = (name: string) => DB.get(name)?.kind ?? 'spell';
const bump = <K>(m: Map<K, Tally>, k: K, cued: boolean) => {
  const t = m.get(k) ?? { seen: 0, cued: 0 };
  t.seen++;
  if (cued) t.cued++;
  m.set(k, t);
};
const sub = (m: Map<string, Map<string, Tally>>, k: string) => {
  let x = m.get(k);
  if (!x) m.set(k, (x = new Map()));
  return x;
};

/** Does this event have its cue among the batch's cues? null: the event never asks for one. */
function cueFor(ev: EngineEvent, cues: Cue[], e: Engine): boolean | null {
  const has = (f: (c: Cue) => boolean) => cues.some(f);
  switch (ev.kind) {
    case 'summon':
      return has((c) => (c.kind === 'summon' || c.kind === 'set') && c.card.uid === ev.uid);
    case 'activate':
    case 'effect':
      if (ev.uid === undefined) return has((c) => c.kind === 'skill' && c.player === ev.player);
      return has((c) => (c.kind === 'activate' || c.kind === 'target') && c.card.uid === ev.uid);
    case 'heal':
      return (ev.amount ?? 0) > 0 ? has((c) => c.kind === 'heal' && c.player === ev.player) : null;
    case 'draw':
      return ev.effect ? has((c) => c.kind === 'draw' && c.player === ev.player) : null;
    case 'to-hand':
    case 'to-gy':
      if (!ev.to) return null;
      return has((c) => c.kind === 'leave' && c.card.uid === ev.uid) || (ev.kind === 'to-gy' && has((c) => c.kind === 'destroy' && c.card.uid === ev.uid)) ? true : leaveShown(ev) ? false : null;
    default:
      return null;
  }
  void e;
}
/** The moves cues.ts promises a leave cue for (mirror of its shownLeave). */
const leaveShown = (ev: EngineEvent) => ['mz', 'sz', 'field', 'gy', 'removed'].includes(ev.zone ?? '') || (ev.zone === 'deck' && (ev.to === 'hand' || ev.to === 'banish')) || (ev.zone === 'hand' && ev.to === 'banish');

/** A deck for a duel: `want` cards that should get their turn, padded with random ones; Skill-related cards when there is a Skill. */
function deckOf(want: string[], skill: string | null): string[] {
  const text = skill ? (SKILL_TEXT[skill] ?? '') + ' ' + skill : '';
  const quoted = [...text.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1]);
  const related = quoted.length ? MAIN.filter((n) => quoted.some((q) => n.includes(q))) : [];
  const out = [...want];
  while (out.length < 24) out.push(related.length && out.length % 2 === 0 ? pick(related) : pick(MAIN));
  return out;
}

const INITIATING = new Set<Action['type']>(['SUMMON', 'SET_ST', 'ACTIVATE', 'FLIP_SUMMON', 'MONSTER_EFFECT', 'SPECIAL', 'SKILL', 'GRAVE_EFFECT', 'QUICK_EFFECT']);

/** Plays `games` duels; every card of the pool is put in some deck (round robin), every Skill brought several times. */
export function runCoverage(games: number, seed = 31): Coverage {
  setSeed(seed);
  const cov: Coverage = { games, fails: [], summons: new Map(), activations: new Map(), effects: new Map(), skills: new Map(), skillsBrought: new Set(), moves: new Map(), quiet: new Map(), silentActions: new Map(), lostEvents: 0, lostWhere: [] };
  const mainOrder = shuffle(MAIN);
  const extraOrder = shuffle(EXTRA);
  let mi = 0;
  let xi = 0;
  const take = (list: string[], n: number, at: () => number) => Array.from({ length: n }, () => list[at() % list.length]);
  for (let g = 0; g < games; g++) {
    const skills: [string, string] = [SKILL_NAMES[(2 * g) % SKILL_NAMES.length], SKILL_NAMES[(2 * g + 1) % SKILL_NAMES.length]];
    skills.forEach((s) => cov.skillsBrought.add(s));
    const decks = [0, 1].map((p) => deckOf(take(mainOrder, 6, () => mi++).flatMap((n) => [n, n, n]), skills[p])) as [string[], string[]];
    const extras = [0, 1].map(() => take(extraOrder, 6, () => xi++)) as [string[], string[]];
    const brains: ((e: Engine, p: Pid) => Action | null)[] = g % 3 === 0 ? [randomAction, randomAction] : g % 3 === 1 ? [aiAction, randomAction] : [randomAction, aiAction];
    const e = new Engine(DB);
    const track: CueTrack = { battle: null };
    let last = 0;
    let memo = memoField(e.state, 0, null);
    let episode: { what: string; cues: number } | null = null;
    const closeEpisode = () => {
      if (episode && episode.cues === 0) cov.silentActions.set(episode.what, (cov.silentActions.get(episode.what) ?? 0) + 1);
      episode = null;
    };
    const step = (act: Action) => {
      const label = (uid: number | undefined) => (uid === undefined ? '' : e.find(uid)?.card.name ?? '?');
      if (INITIATING.has(act.type)) {
        closeEpisode();
        const uid = (act as { uid?: number }).uid;
        episode = { what: `${act.type}${act.type === 'SKILL' ? ` ${e.player(act.player).skill}` : uid !== undefined ? ` ${label(uid)}` : ''}`, cues: 0 };
      }
      if (act.type === 'CANCEL') episode = null; // backed out: nothing happened
      e.apply(act);
      const evs = e.state.events ?? [];
      const fresh = evs.filter((x) => x.seq > last);
      if (fresh.length) {
        // Every event kept is new and the list is full: the engine's cap (40) dropped older ones of this batch.
        if (fresh.length === evs.length && evs.length >= 40 && last > 0) (cov.lostEvents++, cov.lostWhere.push(`${act.type}: ${fresh.slice(0, 8).map((x) => x.kind).join(',')}`));
        last = evs[evs.length - 1].seq;
      }
      const cues = toCues(fresh, e.state, 0, null, memo, track);
      memo = memoField(e.state, 0, null, memo);
      if (episode) episode.cues += cues.length;
      if (!e.state.prompt) closeEpisode();
      for (const ev of fresh) {
        const got = cueFor(ev, cues, e);
        if (got === null) {
          if (!['summon', 'activate', 'effect', 'heal', 'draw', 'to-hand', 'to-gy', 'set', 'flip', 'attack', 'hit', 'damage', 'win', 'target'].includes(ev.kind) || (ev.kind === 'draw' && !ev.effect)) {
            const k = ev.kind + (ev.kind === 'draw' ? ' (normal)' : '');
            cov.quiet.set(k, (cov.quiet.get(k) ?? 0) + 1);
          }
          continue;
        }
        const name = ev.uid !== undefined ? e.find(ev.uid)?.card.name ?? '(gone)' : '';
        // a Skill Card (Call of the Haunted (Skill Card)) or Token that vanished as it left the field: no card left to show its parting effect on
        if (got === false && ev.kind === 'effect' && name === '(gone)') continue;
        switch (ev.kind) {
          case 'summon':
            bump(sub(cov.summons, ev.how ?? '(none: control change)'), name, got);
            break;
          case 'activate':
          case 'effect':
            if (ev.uid === undefined) bump(cov.skills, e.player(ev.player ?? 0).skill ?? '?', got);
            else bump(sub(ev.kind === 'activate' ? cov.activations : cov.effects, kindOf(name)), name, got);
            break;
          case 'heal':
            bump(cov.moves, 'heal', got);
            break;
          case 'draw':
            bump(cov.moves, 'effect draw', got);
            break;
          default:
            bump(cov.moves, `leave ${ev.zone}->${ev.to}`, got);
        }
      }
    };
    try {
      step({ type: 'START', first: (g % 2) as Pid, seed: 7000 + g, names: ['A', 'B'], decks, fusions: extras, mode: 'speed', skills });
      let n = 0;
      while (e.state.winner === null && n++ < 3000) {
        const p = e.state.prompt ? e.state.prompt.player : e.state.turnPlayer;
        const act = brains[p](e, p);
        if (!act) {
          cov.fails.push(`game ${g}: no action for ${p}`);
          break;
        }
        step(act);
      }
      closeEpisode();
    } catch (err) {
      cov.fails.push(`game ${g}: ${(err as Error).stack?.split('\n').slice(0, 4).join(' | ')}`);
    }
  }
  return cov;
}

/** cards seen / with a cue every time / silent at least once (names). */
export function summary(m: Map<string, Tally>): { seen: number; always: number; silent: string[] } {
  const silent = [...m].filter(([, t]) => t.cued < t.seen).map(([n, t]) => `${n} (${t.seen - t.cued}/${t.seen})`);
  return { seen: m.size, always: m.size - silent.length, silent };
}
