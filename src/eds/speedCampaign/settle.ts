// After a solo duel: writes its result into the right mode and says what to show.
import type { SpeedSave } from '../speedSave';
import { settleCampaign, type Settled } from './campaign';
import { afterDuel, better, stopById, summaryOf, todayString, type Run, type RunSummary } from './labyrinth';
import type { SoloSave } from './save';
import { grant } from './rewards';
import { settleLegend, type LegendSettled } from './legends';
import type { DuelContext, DuelOutcome } from './types';

export type SoloReport =
  | { kind: 'practice'; outcome: DuelOutcome; ctx: Extract<DuelContext, { kind: 'practice' }> }
  | { kind: 'campaign'; outcome: DuelOutcome; nodeId: string; settled: Settled }
  | { kind: 'labyrinth'; outcome: DuelOutcome; run: Run | null; ended: RunSummary | null }
  | { kind: 'legend'; outcome: DuelOutcome; duelId: string; rematch: boolean; settled: LegendSettled };

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
        // An Anything goes run (every card unlocked) never sets the best-run record.
        best: !run.open && better(summary, lab.best) ? summary : lab.best,
        curseUnlocked: run.over === 'won' ? Math.min(10, Math.max(lab.curseUnlocked, run.curse + 1)) : lab.curseUnlocked,
      },
    },
  };
}

/**
 * Ends a run and pays its clear prize: clearing all three floors opens a booster pack, the
 * first clear at each Curse and otherwise one clear a day (so runs can't be farmed).
 * Anything goes runs and the Daily (a shared, fair race) pay nothing.
 */
export function endRunPaid(speed: SpeedSave, solo: SoloSave, run: Run, today = todayString()): { speed: SpeedSave; solo: SoloSave; summary: RunSummary } {
  const done = endRun(solo, run);
  const lab = done.solo.labyrinth;
  const firstAtCurse = !(lab.packCurses ?? []).includes(run.curse);
  if (run.over !== 'won' || run.open || run.daily || (!firstAtCurse && lab.packDay === today)) return { speed, ...done };
  const g = grant(speed, done.solo, [{ kind: 'pack' }]);
  const paid = { ...g.solo.labyrinth, packDay: today, ...(firstAtCurse ? { packCurses: [...(lab.packCurses ?? []), run.curse] } : {}) };
  return { speed: g.speed, solo: { ...g.solo, labyrinth: paid }, summary: { ...done.summary, pack: g.cards } };
}

export function settleSolo(ctx: DuelContext, o: DuelOutcome, speed: SpeedSave, solo: SoloSave): { speed: SpeedSave; solo: SoloSave; report: SoloReport } {
  if (ctx.kind === 'practice') return { speed, solo, report: { kind: 'practice', outcome: o, ctx } };
  if (ctx.kind === 'campaign') {
    // Leaving a campaign duel halfway costs nothing; you can try again.
    if (o.forfeit) return { speed, solo, report: { kind: 'campaign', outcome: o, nodeId: ctx.nodeId, settled: { speed, solo, stars: [false, false, false], newStars: [false, false, false], lines: [], cards: [], picks: [], firstWin: false, cleared: null } } };
    const settled = settleCampaign(speed, solo, ctx.nodeId, o, Date.now(), !!ctx.open);
    return { speed: settled.speed, solo: settled.solo, report: { kind: 'campaign', outcome: o, nodeId: ctx.nodeId, settled } };
  }
  if (ctx.kind === 'legend') {
    const settled = settleLegend(speed, solo, ctx.duelId, o, !!ctx.rematch, Date.now(), !!ctx.open);
    return { speed: settled.speed, solo: settled.solo, report: { kind: 'legend', outcome: o, duelId: ctx.duelId, rematch: !!ctx.rematch, settled } };
  }
  const run = solo.labyrinth.run;
  if (!run || run.id !== ctx.runId) return { speed, solo, report: { kind: 'labyrinth', outcome: o, run, ended: null } };
  // The Daily plays without upgrades, so both brothers race the same run.
  const next = afterDuel(run, o.result, run.daily ? [] : solo.labyrinth.upgrades);
  // Beating a Labyrinth boss pays a Duel Chip, at most once a day (so a quick
  // floor-1 boss and Give up can't farm them).
  const stop = run.inDuel ? stopById(run, run.inDuel) : null;
  const today = todayString();
  // A run with an Anything goes deck pays nothing.
  if (o.result === 'w' && stop?.kind === 'boss' && !run.open && solo.labyrinth.chipDay !== today) {
    const g = grant(speed, solo, [{ kind: 'chips', n: 1 }]);
    const paid = g.speed.chips !== speed.chips;
    speed = g.speed;
    solo = { ...solo, labyrinth: { ...solo.labyrinth, chipDay: today } };
    if (paid && next.pending?.kind === 'draft') next.pending = { ...next.pending, chip: true };
  }
  if (next.over) {
    const done = endRunPaid(speed, solo, next);
    return { speed: done.speed, solo: done.solo, report: { kind: 'labyrinth', outcome: o, run: next, ended: done.summary } };
  }
  return { speed, solo: { ...solo, labyrinth: { ...solo.labyrinth, run: next } }, report: { kind: 'labyrinth', outcome: o, run: next, ended: null } };
}
