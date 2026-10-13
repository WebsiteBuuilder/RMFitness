// After a solo duel: writes its result into the right mode and says what to show.
import type { SpeedSave } from '../speedSave';
import { settleCampaign, type Settled } from './campaign';
import { afterDuel, better, stopById, summaryOf, todayString, type Run, type RunSummary } from './labyrinth';
import type { SoloSave } from './save';
import { grant } from './rewards';
import type { DuelContext, DuelOutcome } from './types';

export type SoloReport =
  | { kind: 'practice'; outcome: DuelOutcome; ctx: Extract<DuelContext, { kind: 'practice' }> }
  | { kind: 'campaign'; outcome: DuelOutcome; nodeId: string; settled: Settled }
  | { kind: 'labyrinth'; outcome: DuelOutcome; run: Run | null; ended: RunSummary | null };

/** Ends a run: pays its Soul Fragments, files it in the history, unlocks the next Curse. */
export function endRun(solo: SoloSave, run: Run): { solo: SoloSave; summary: RunSummary } {
  const summary = summaryOf(run);
  const lab = solo.labyrinth;
  return {
    summary,
    solo: {
      ...solo,
      labyrinth: {
        ...lab,
        run: null,
        fragments: lab.fragments + summary.fragments,
        history: [summary, ...lab.history].slice(0, 30),
        best: better(summary, lab.best) ? summary : lab.best,
        curseUnlocked: run.over === 'won' ? Math.min(10, Math.max(lab.curseUnlocked, run.curse + 1)) : lab.curseUnlocked,
      },
    },
  };
}

export function settleSolo(ctx: DuelContext, o: DuelOutcome, speed: SpeedSave, solo: SoloSave): { speed: SpeedSave; solo: SoloSave; report: SoloReport } {
  if (ctx.kind === 'practice') return { speed, solo, report: { kind: 'practice', outcome: o, ctx } };
  if (ctx.kind === 'campaign') {
    // Leaving a campaign duel halfway costs nothing; you can try again.
    if (o.forfeit) return { speed, solo, report: { kind: 'campaign', outcome: o, nodeId: ctx.nodeId, settled: { speed, solo, stars: [false, false, false], newStars: [false, false, false], lines: [], cards: [], picks: [], firstWin: false, cleared: null } } };
    const settled = settleCampaign(speed, solo, ctx.nodeId, o);
    return { speed: settled.speed, solo: settled.solo, report: { kind: 'campaign', outcome: o, nodeId: ctx.nodeId, settled } };
  }
  const run = solo.labyrinth.run;
  if (!run || run.id !== ctx.runId) return { speed, solo, report: { kind: 'labyrinth', outcome: o, run, ended: null } };
  // The Daily plays without upgrades, so both brothers race the same run.
  const next = afterDuel(run, o.result, run.daily ? [] : solo.labyrinth.upgrades);
  // Beating a Labyrinth boss pays a Duel Chip, at most once a day (so a quick
  // floor-1 boss and Give up can't farm them).
  const stop = run.inDuel ? stopById(run, run.inDuel) : null;
  const today = todayString();
  if (o.result === 'w' && stop?.kind === 'boss' && solo.labyrinth.chipDay !== today) {
    const g = grant(speed, solo, [{ kind: 'chips', n: 1 }]);
    const paid = g.speed.chips !== speed.chips;
    speed = g.speed;
    solo = { ...solo, labyrinth: { ...solo.labyrinth, chipDay: today } };
    if (paid && next.pending?.kind === 'draft') next.pending = { ...next.pending, chip: true };
  }
  if (next.over) {
    const done = endRun(solo, next);
    return { speed, solo: done.solo, report: { kind: 'labyrinth', outcome: o, run: next, ended: done.summary } };
  }
  return { speed, solo: { ...solo, labyrinth: { ...solo.labyrinth, run: next } }, report: { kind: 'labyrinth', outcome: o, run: next, ended: null } };
}
