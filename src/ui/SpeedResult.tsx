// Speed Duel result screen, Master Duel style: VICTORY / DEFEAT, the final LP, then what
// the duel paid out, one reward at a time. It only shows what finishDuel (App.tsx) already
// settled; nothing here changes a save.
import { useEffect, useRef, useState } from 'preact/hooks';
import { CardImg } from './CardImg';
import { buzz, playLose, playWin } from './sound';
import './result.css';

export type ResultReward =
  | { kind: 'chips'; n: number }
  | { kind: 'packs'; n: number }
  | { kind: 'rank'; card: string; tier: string; tierName: string }
  | { kind: 'xp'; cards: number }
  | { kind: 'card'; card: string; won: boolean; who?: string }
  | { kind: 'line'; text: string };

export interface SpeedResultData {
  outcome: 'win' | 'lose' | 'draw';
  /** VICTORY, DEFEAT, DRAW, or "<name> WINS" on one phone */
  title: string;
  reason?: string;
  /** final Life Points, this player first */
  lp: { name: string; lp: number }[];
  turns: number;
  rewards: ResultReward[];
}

/** When the first reward appears, and the longest wait before Continue can be tapped (ms). */
const FIRST = 1200;
const READY_MAX = 3600;

export function SpeedResult({ data, onContinue, onRematch }: { data: SpeedResultData; onContinue: () => void; /** a computer duel: run it back */ onRematch?: () => void }) {
  const n = data.rewards.length;
  const step = n ? Math.min(280, 2000 / n) : 0;
  const readyAt = Math.min(READY_MAX, FIRST + n * step + 300);
  const [skipped, setSkipped] = useState(false);
  const [ready, setReady] = useState(false);
  const cont = useRef<HTMLButtonElement>(null);
  const done = useRef(false);

  useEffect(() => {
    if (data.outcome === 'win') playWin();
    else if (data.outcome === 'lose') playLose();
    buzz(data.outcome === 'win' ? [30, 60, 30, 60, 120] : [80]);
    const t = window.setTimeout(() => setReady(true), readyAt);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (ready) cont.current?.focus({ preventScroll: true });
  }, [ready]);

  const skip = () => {
    setSkipped(true);
    setReady(true);
  };
  const go = () => {
    if (!ready || done.current) return;
    done.current = true;
    onContinue();
  };

  return (
    <div class={`mdres res-${data.outcome} ${skipped ? 'res-skipped' : ''}`} role="dialog" aria-modal="true" aria-labelledby="mdres-title" onClick={() => (ready ? undefined : skip())}>
      <div class="mdres-rays" aria-hidden="true" />
      <div class="mdres-head">
        <h1 id="mdres-title" class="mdres-title" data-text={data.title}>
          {data.title}
        </h1>
        {data.reason && <p class="mdres-reason">{data.reason}</p>}
      </div>
      <div class="mdres-lp">
        {data.lp.map((p, i) => (
          <div key={i} class={`mdres-lpbox ${i === 0 ? 'lp-me' : 'lp-them'} ${p.lp <= 0 ? 'lp-zero' : ''}`}>
            <span class="mdres-name">{p.name}</span>
            <span class="mdres-lpn">
              <small>LP</small> {Math.max(0, p.lp)}
            </span>
          </div>
        ))}
        <div class="mdres-turns">Turn {data.turns}</div>
      </div>
      <div class="mdres-rewards">
        {n > 0 && <div class="mdres-rhead">Rewards</div>}
        <ul>
          {data.rewards.map((r, i) => (
            <li key={i} class={`mdres-r r-${r.kind} ${r.kind === 'card' ? (r.won ? 'r-won' : 'r-lost') : ''}`} style={{ animationDelay: skipped ? '0ms' : `${FIRST + i * step}ms` }}>
              <Reward r={r} />
            </li>
          ))}
        </ul>
      </div>
      <div class="mdres-foot">
        <button ref={cont} type="button" class={`mdres-go ${ready ? 'go-ready' : ''}`} aria-disabled={!ready} onClick={(ev) => (ev.stopPropagation(), ready ? go() : skip())}>
          Continue
        </button>
        {onRematch && ready && (
          <button type="button" class="mdres-again" onClick={(ev) => (ev.stopPropagation(), done.current || ((done.current = true), onRematch()))}>
            {data.outcome === 'lose' ? 'REMATCH!' : 'Rematch'}
          </button>
        )}
        {!ready && <p class="mdres-skip">Tap to skip</p>}
      </div>
    </div>
  );
}

function Reward({ r }: { r: ResultReward }) {
  switch (r.kind) {
    case 'chips':
      return (
        <>
          <span class="mdres-icon i-chip" aria-hidden="true">◆</span>
          <span class="mdres-rt">
            <b>+{r.n}</b> Duel Chip{r.n === 1 ? '' : 's'}
          </span>
        </>
      );
    case 'packs':
      return (
        <>
          <span class="mdres-icon i-pack" aria-hidden="true" />
          <span class="mdres-rt">
            <b>+{r.n}</b> Booster Pack{r.n === 1 ? '' : 's'}
          </span>
        </>
      );
    case 'rank':
      return (
        <>
          <span class="mdres-card">
            <CardImg name={r.card} />
          </span>
          <span class="mdres-rt">
            <span>
              <span class={`mdres-tier t-${r.tier}`}>{r.tier}</span> {r.card}
            </span>
            <small>Rank up! Now {r.tierName}</small>
          </span>
        </>
      );
    case 'xp':
      return (
        <>
          <span class="mdres-icon i-xp" aria-hidden="true">★</span>
          <span class="mdres-rt">
            {r.cards} card{r.cards === 1 ? '' : 's'} earned level points
          </span>
        </>
      );
    case 'card':
      return (
        <>
          <span class="mdres-card">
            <CardImg name={r.card} />
          </span>
          <span class="mdres-rt">
            {r.card}
            <small>{r.who ? `${r.who} ` : ''}{r.won ? 'won this card' : 'lost this card'}</small>
          </span>
        </>
      );
    default:
      return <span class="mdres-rt r-text">{r.text}</span>;
  }
}
