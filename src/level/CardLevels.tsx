// The Card Levels page in the Speed Duel menu: what the last duel did to each
// card's rarity meter, and every card's rarity and meter.
import { useState } from 'preact/hooks';
import type { SpeedSave } from '../eds/speedSave';
import { card } from '../eds/db';
import { CardImg } from '../ui/CardImg';
import { Overlay, Win } from '../ui/Window';
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

/** Roughly what a card you play and win fights with earns in one duel (for the "how long" line). */
const PTS_PER_DUEL = 130;

/** One rank's look: the card drawn at that rarity, with its name and the points it takes. */
function RankCard({ name, i, xp }: { name: string; i: number; xp: number | null }) {
  const t = TIERS[i];
  const cur = xp !== null && tierIndex(xp) === i;
  const got = xp !== null && xp >= t.at;
  return (
    <div class={`lv-rank ${cur ? 'cur' : ''} ${xp !== null && !got ? 'locked' : ''}`}>
      <div class="lv-slot">
        <CardImg name={name} tier={i} />
      </div>
      <span class={`lv-chip lv-${t.id}`}>{chipText(t.id)}</span>
      <b>{t.name}</b>
      <small>{cur ? 'Now' : got ? 'Reached ✓' : t.at === 0 ? 'Start' : `${t.at} pts`}</small>
    </div>
  );
}

/** The card sheet: the card at every rank, its meter and the points to the next rank. */
function CardSheet({ name, xp, onClose }: { name: string; xp: number; onClose: () => void }) {
  const i = tierIndex(xp);
  const t = TIERS[i];
  const next = TIERS[i + 1];
  const top = TIERS[TIERS.length - 1];
  return (
    <Overlay onClose={onClose}>
      <Win title={name} onClose={onClose} class="lv-sheet">
        <div class={`lv-now lv-t-${t.id}`}>
          <div class="lv-slot big">
            <CardImg name={name} tier={i} />
          </div>
          <div class="lv-now-text">
            <div class="lv-now-tier">
              <span class={`lv-chip lv-${t.id}`}>{chipText(t.id)}</span> <b>{t.name}</b>
            </div>
            <Meter xp={xp} />
            <div class="lv-why">{toNext(xp)}</div>
            <p class="hint">
              {next ? `${next.at - xp} more pts to ${next.name}${next.id !== 'OF' ? `, ${top.at - xp} to Overframe` : ''}.` : 'Top rarity: its art breaks out of the card.'}
            </p>
          </div>
        </div>
        <div class="lv-ladder">
          {TIERS.map((_, j) => (
            <RankCard key={j} name={name} i={j} xp={xp} />
          ))}
        </div>
        <p class="hint">Rarity is a look only: ATK, DEF and effects stay the same.</p>
      </Win>
    </Overlay>
  );
}

/** "What do ranks look like?": one card at every rank, with the points each takes. */
function RanksPreview({ name, onClose }: { name: string; onClose: () => void }) {
  const top = TIERS[TIERS.length - 1];
  return (
    <Overlay onClose={onClose}>
      <Win title="What do ranks look like?" onClose={onClose} class="lv-sheet">
        <p class="hint">
          Every card climbs the same ladder. A card you play and win fights with every duel earns about {PTS_PER_DUEL} points a duel, so Overframe ({top.at} pts) takes around {Math.round(top.at / PTS_PER_DUEL)} duels. Tap a card in the list to see its own progress.
        </p>
        <div class="lv-ladder">
          {TIERS.map((_, j) => (
            <RankCard key={j} name={name} i={j} xp={null} />
          ))}
        </div>
      </Win>
    </Overlay>
  );
}

export function CardLevels({ save, deckNames, onBack }: { save: SpeedSave; deckNames: string[]; onBack: () => void }) {
  const [tab, setTab] = useState<'last' | 'all'>(lastLevelReport(save)?.rows.length ? 'last' : 'all');
  const [open, setOpen] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const levels = cardLevels(save);
  const rep = lastLevelReport(save);
  const all = [...new Set([...Object.keys(levels), ...deckNames])].map((name) => ({ name, xp: levels[name] ?? 0 })).sort((a, b) => b.xp - a.xp || a.name.localeCompare(b.name));
  // the preview shows your best monster (or any card you have)
  const sample = all.find((c) => card(c.name)?.kind === 'monster')?.name ?? all[0]?.name ?? 'Dark Magician';
  return (
    <div class="screen">
      <Win title="Card Levels" onClose={onBack}>
        <button class="chip lv-preview-btn" onClick={() => setPreview(true)}>
          ★ What do ranks look like?
        </button>
        <p class="hint">
          Every card ranks up the more you duel with it: N, R, SR, UR, the Glossy and Royal finishes, and finally Overframe, where its art breaks out of the card. Destroying monsters, battle damage, direct attacks and burn fill the meter fast (+{XP.kill} a kill, +{XP.direct} a direct hit). Playing it fills a little. Dying or getting banished drains a little, but a card never loses a rarity it reached. Rarity is a look only: ATK, DEF and effects stay the same.
        </p>
        <p class="hint">Tap a card to see it at every rank.</p>
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
                <button key={r.name} class={`lv-row lv-t-${tierOf(r.after).id}`} onClick={() => setOpen(r.name)}>
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
                </button>
              );
            })
          )
        ) : all.length === 0 ? (
          <p class="hint">Build a deck first.</p>
        ) : (
          all.map((c) => (
            <button key={c.name} class={`lv-row lv-t-${tierOf(c.xp).id}`} onClick={() => setOpen(c.name)}>
              <CardImg name={c.name} />
              <div>
                <div class="lv-name">
                  <RarityChip xp={c.xp} /> {c.name}
                </div>
                <div class="lv-why">{toNext(c.xp)}</div>
                <Meter xp={c.xp} />
              </div>
              <span class="lv-go" aria-hidden="true">
                ›
              </span>
            </button>
          ))
        )}
      </Win>
      {open && <CardSheet name={open} xp={levels[open] ?? 0} onClose={() => setOpen(null)} />}
      {preview && <RanksPreview name={sample} onClose={() => setPreview(false)} />}
    </div>
  );
}
