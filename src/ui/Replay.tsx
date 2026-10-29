// Duel replays: the list of this duelist's last duels and the player that shows one again on the
// duel board, move by move (pause, 1x/2x/4x, skip to the next turn).
import { useEffect, useRef, useState } from 'preact/hooks';
import { DuelSession, useDuelSession } from '../eds/session';
import { deleteReplay, loadReplays, ReplayAdapter, startIndex, type Replay } from '../eds/replays';
import type { Action } from '../eds/types';
import type { ControlStyle } from '../eds/save';
import { artBusy } from '../art/cues';
import { Duel } from './Duel';
import { Win } from './Window';
import { ConfirmSheet } from './ConfirmSheet';
import './replay.css';

/** ms between moves at 1x (a question answered goes quicker: it's a tap, not a play) */
const MOVE_MS = 1000;
const QUICK_MS = 450;
const quick = (a: Action) => a.type === 'PASS' || a.type === 'NEXT_PHASE' || a.type === 'YES' || a.type === 'NO';

function ReplayBoard({ session, seat, controls, onClose }: { session: DuelSession; seat: 0 | 1; controls: ControlStyle; onClose: () => void }) {
  const view = useDuelSession(session);
  // (Continue on the result closes the replay; a duel given up ends on its board instead of
  // closing by itself, so the end can be seen: ↺ and ✕ are on the bar)
  const finished = () => !/surrendered$/.test(session.state.winReason) && onClose();
  return <Duel session={session} view={view} mySeat={seat} hotseat={false} controlsFor={() => controls} onLeave={onClose} onFinished={finished} spectator />;
}

/** Index of the first move of the next turn after `from` (or the end). */
function nextTurnAt(r: Replay, from: number): number {
  const a = new ReplayAdapter();
  const s = new DuelSession(a);
  a.push(r.moves.slice(0, from));
  const turn = s.state.turn;
  let i = from;
  while (i < r.moves.length && s.state.turn === turn && s.state.winner === null) a.push([r.moves[i++]]);
  s.close();
  return i;
}

export function ReplayPlayer({ replay, controls, onClose }: { replay: Replay; controls: ControlStyle; onClose: () => void }) {
  const [speed, setSpeed] = useState(1);
  const [paused, setPaused] = useState(false);
  // a fresh board for each jump (playing many moves at once on a live board would queue every cinematic)
  const build = (upto: number) => {
    const a = new ReplayAdapter();
    const s = new DuelSession(a);
    a.push(replay.moves.slice(0, upto));
    return { a, s, pos: upto, epoch: Math.random() };
  };
  const [cur, setCur] = useState(() => build(startIndex(replay) + 1));
  const pos = useRef(cur.pos);
  // (redraws the bar as the moves go by: the board redraws itself)
  const [, setShown] = useState(0);
  const done = pos.current >= replay.moves.length;

  useEffect(() => () => cur.s.close(), [cur]);
  useEffect(() => {
    if (paused) return;
    let t = 0;
    const step = () => {
      if (pos.current >= replay.moves.length) return;
      // (a cinematic on screen: wait for it, as in a live duel)
      if (artBusy()) return void (t = window.setTimeout(step, 150));
      const m = replay.moves[pos.current++];
      cur.a.push([m]);
      setShown(pos.current);
      const next = replay.moves[pos.current];
      t = window.setTimeout(step, (next && quick(next) ? QUICK_MS : MOVE_MS) / speed);
    };
    t = window.setTimeout(step, MOVE_MS / speed);
    return () => clearTimeout(t);
  }, [cur, paused, speed]);

  const jump = (to: number) => {
    const next = build(to);
    pos.current = next.pos;
    setCur(next);
  };
  const skip = () => jump(nextTurnAt(replay, pos.current));
  const restart = () => jump(startIndex(replay) + 1);
  const st = cur.s.state;

  return (
    <div class="replay">
      <ReplayBoard key={cur.epoch} session={cur.s} seat={replay.seat} controls={controls} onClose={onClose} />
      <div class="so-watchbar rp-bar" role="toolbar" aria-label="Replay controls">
        <span class="rp-tag">REPLAY · T{st.turn}</span>
        <button onClick={() => setPaused(!paused)} aria-label={paused ? 'Play' : 'Pause'}>
          {paused ? '▶' : '❚❚'}
        </button>
        {[1, 2, 4].map((n) => (
          <button key={n} class={speed === n ? 'on' : ''} onClick={() => setSpeed(n)}>
            {n}x
          </button>
        ))}
        {done ? (
          <button onClick={restart} aria-label="Watch again">
            ↺
          </button>
        ) : (
          <button onClick={skip} aria-label="Skip to the next turn">
            ⏭
          </button>
        )}
        <button onClick={onClose} aria-label="Close the replay">
          ✕
        </button>
      </div>
    </div>
  );
}

const ago = (at: number, now = Date.now()) => {
  const m = Math.round((now - at) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
};
const KIND: Record<Replay['kind'], string> = { cpu: 'vs computer', online: 'online', hotseat: 'one phone' };

/** The last duels kept on this phone for this duelist; tap one to watch it. */
export function ReplayList({ profileId, controls, onBack }: { profileId: string; controls: ControlStyle; onBack: () => void }) {
  const [list, setList] = useState(() => loadReplays(profileId));
  const [watching, setWatching] = useState<Replay | null>(null);
  const [del, setDel] = useState<Replay | null>(null);
  replayBack = watching ? () => (setWatching(null), true) : null;
  useEffect(() => () => void (replayBack = null), []);
  if (watching) return <ReplayPlayer replay={watching} controls={controls} onClose={() => setWatching(null)} />;
  return (
    <div class="screen">
      <Win title="Replays" onClose={onBack}>
        <p class="hint">Your last {list.length > 1 ? `${list.length} ` : ''}duels on this phone. Watch any of them again from your side of the board.</p>
        {list.length === 0 ? (
          <p class="rp-empty">No duels yet. Finish a Speed Duel and it shows up here.</p>
        ) : (
          <ul class="rp-list">
            {list.map((r) => {
              const won = r.winner === r.seat;
              const res = r.winner === 'draw' ? 'Draw' : won ? 'Win' : 'Loss';
              return (
                <li key={r.id}>
                  <button class="rp-row" onClick={() => setWatching(r)}>
                    <span class={`rp-res ${r.winner === 'draw' ? 'draw' : won ? 'win' : 'loss'}`}>{res}</span>
                    <span class="rp-who">
                      <b>vs {r.names[r.seat === 0 ? 1 : 0]}</b>
                      <small>
                        {KIND[r.kind]} · {r.turns} turns · {ago(r.at)}
                      </small>
                    </span>
                    <span class="rp-play" aria-hidden="true">
                      ▶
                    </span>
                  </button>
                  <button class="rp-del" aria-label={`Delete the replay vs ${r.names[r.seat === 0 ? 1 : 0]}`} onClick={() => setDel(r)}>
                    🗑
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Win>
      {del && (
        <ConfirmSheet look="md" title="Delete this replay?" confirmLabel="Delete" cancelLabel="Keep it" danger onCancel={() => setDel(null)} onConfirm={() => (deleteReplay(profileId, del.id), setList(loadReplays(profileId)), setDel(null))}>
          The duel vs {del.names[del.seat === 0 ? 1 : 0]} won't be on this phone any more.
        </ConfirmSheet>
      )}
    </div>
  );
}

/** Android back while a replay plays: back to the list (Speed hub's back asks this first). */
export let replayBack: (() => boolean) | null = null;
