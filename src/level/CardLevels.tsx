// The Card Levels page in the Speed Duel menu: what the last duel did to each
// card's rarity meter, and every card's rarity and meter.
import { useState } from 'preact/hooks';
import type { SpeedSave } from '../eds/speedSave';
import { CardImg } from '../ui/CardImg';
import { Win } from '../ui/Window';
import { TIERS, XP, cardLevels, lastLevelReport, meterOf, tierIndex, tierOf, type LevelRow } from './leveling';

/** The short label on a rarity chip. */
export const chipText = (id: string) => (id === 'GL' ? 'UR✦' : id === 'RO' ? 'UR♛' : TIERS.find((t) => t.id === id)!.short);

export function RarityChip({ xp }: { xp: number }) {
  const t = tierOf(xp);
  return (
    <span class={`lv-chip lv-${t.id}`} title={t.name}>
      {chipText(t.id)}
    </span>
  );
}

function Meter({ xp }: { xp: number }) {
  return (
    <div class="lv-meter">
      <i style={{ width: `${Math.round(meterOf(xp) * 100)}%` }} />
    </div>
  );
}

function toNext(xp: number): string {
  const i = tierIndex(xp);
  if (i === TIERS.length - 1) return `${xp} pts · top rarity`;
  return `${xp} / ${TIERS[i + 1].at} pts to ${TIERS[i + 1].name}`;
}

/** Cards whose rarity went up in this report. */
export function rankUps(rows: LevelRow[]): LevelRow[] {
  return rows.filter((r) => tierIndex(r.after) > tierIndex(r.before));
}

/** One line for the Speed Duel menu after a duel, or null. */
export function levelHeadline(save: SpeedSave): string | null {
  const rep = lastLevelReport(save);
  if (!rep || rep.rows.length === 0) return null;
  const ups = rankUps(rep.rows);
  if (ups.length) return `${ups.map((r) => `${r.name} is now ${tierOf(r.after).name}`).slice(0, 2).join(' · ')}${ups.length > 2 ? ` and ${ups.length - 2} more` : ''}!`;
  const best = rep.rows[0];
  return best.after > best.before ? `${best.name} gained the most: +${best.after - best.before}` : null;
}

export function CardLevels({ save, deckNames, onBack }: { save: SpeedSave; deckNames: string[]; onBack: () => void }) {
  const [tab, setTab] = useState<'last' | 'all'>(lastLevelReport(save)?.rows.length ? 'last' : 'all');
  const levels = cardLevels(save);
  const rep = lastLevelReport(save);
  const all = [...new Set([...Object.keys(levels), ...deckNames])].map((name) => ({ name, xp: levels[name] ?? 0 })).sort((a, b) => b.xp - a.xp || a.name.localeCompare(b.name));
  return (
    <div class="screen">
      <Win title="Card Levels" onClose={onBack}>
        <p class="hint">
          Every card ranks up the more you duel with it: N, R, SR, UR, then the Glossy and Royal finishes. Destroying monsters, battle damage, direct attacks and burn fill the meter fast (+{XP.kill} a kill, +{XP.direct} a direct hit). Playing it fills a little. Dying or getting banished drains a little, but a card never loses a rarity it reached. Rarity is a look only: ATK, DEF and effects stay the same.
        </p>
        <div class="lv-filter">
          <button class={`chip ${tab === 'last' ? 'sel' : ''}`} onClick={() => setTab('last')}>
            Last duel
          </button>
          <button class={`chip ${tab === 'all' ? 'sel' : ''}`} onClick={() => setTab('all')}>
            All cards ({all.filter((c) => c.xp > 0).length} leveled)
          </button>
        </div>
        {tab === 'last' ? (
          !rep || rep.rows.length === 0 ? (
            <p class="hint">Finish a Speed Duel to see your cards level up.</p>
          ) : (
            rep.rows.map((r) => {
              const d = r.after - r.before;
              const up = tierIndex(r.after) > tierIndex(r.before);
              return (
                <div key={r.name} class={`lv-row lv-t-${tierOf(r.after).id}`}>
                  <CardImg name={r.name} />
                  <div>
                    <div class="lv-name">
                      <RarityChip xp={r.after} /> {r.name}
                    </div>
                    <div class="lv-why">{r.why}</div>
                    <Meter xp={r.after} />
                  </div>
                  <div class="lv-delta">
                    <span class={d > 0 ? 'lv-up' : d < 0 ? 'lv-down' : ''}>{d > 0 ? `+${d}` : d}</span>
                    {up && <div class="lv-rankup">RANK UP!</div>}
                  </div>
                </div>
              );
            })
          )
        ) : all.length === 0 ? (
          <p class="hint">Build a deck first.</p>
        ) : (
          all.map((c) => (
            <div key={c.name} class={`lv-row lv-t-${tierOf(c.xp).id}`}>
              <CardImg name={c.name} />
              <div>
                <div class="lv-name">
                  <RarityChip xp={c.xp} /> {c.name}
                </div>
                <div class="lv-why">{toNext(c.xp)}</div>
                <Meter xp={c.xp} />
              </div>
              <div />
            </div>
          ))
        )}
      </Win>
    </div>
  );
}
