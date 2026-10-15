// Rematch: after a duel both phones get the call at the top of the screen, over the result.
// One tap each and the same room deals again: same decks, same bets, and the loser of the
// last duel picks who goes first. Against the computer it's one tap.
import { useEffect, useState } from 'preact/hooks';
import { useDuelSession, type DuelSession, type Series } from '../eds/session';
import { other } from '../eds/engine';
import type { Pid } from '../eds/types';
import { buzz, playBlip, playVs } from './sound';
import './toss.css';

export type Dock =
  /** a room (online, or two players on this phone) kept open after its duel */
  | { kind: 'room'; session: DuelSession; mySeat: Pid; hotseat: boolean; onClose: () => void }
  /** a duel against the computer: start it again */
  | { kind: 'cpu'; me: string; opp: string; series: Series; again: () => void; onClose: () => void };

class RematchDock {
  dock: Dock | null = null;
  private listeners = new Set<() => void>();
  set(d: Dock | null) {
    this.dock = d;
    for (const l of this.listeners) l();
  }
  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const rematchDock = new RematchDock();

export function RematchLayer() {
  const [, tick] = useState(0);
  useEffect(() => rematchDock.subscribe(() => tick((n) => n + 1)), []);
  const d = rematchDock.dock;
  if (!d) return null;
  return d.kind === 'room' ? <RoomDock key={d.session.round} d={d} /> : <CpuDock d={d} />;
}

const score = (s: Series, me: Pid) => `${s.wins[me]}–${s.wins[other(me)]}${s.draws ? `, ${s.draws} draw${s.draws > 1 ? 's' : ''}` : ''}`;

function CpuDock({ d }: { d: Extract<Dock, { kind: 'cpu' }> }) {
  const lost = d.series.last === 1;
  return (
    <div class="rematch-dock" role="region" aria-label="Rematch">
      <div class="rematch-top">
        <span class="rematch-series">
          ⚔ {d.me} vs {d.opp} · {score(d.series, 0)}
        </span>
        <button class="rematch-x" aria-label="No rematch" onClick={d.onClose}>
          ✕
        </button>
      </div>
      <p class="rematch-msg">
        {lost ? `Run it back against ${d.opp}?` : `Duel ${d.opp} again?`}
        <small>{d.series.last === 'draw' ? 'Rock-paper-scissors for who goes first.' : lost ? 'You lost, so you pick who goes first.' : `${d.opp} lost, so they pick who goes first.`}</small>
      </p>
      <button class="rematch-go" onClick={() => (playBlip(), d.again())}>
        {lost ? 'REMATCH!' : 'Rematch'}
      </button>
    </div>
  );
}

function RoomDock({ d }: { d: Extract<Dock, { kind: 'room' }> }) {
  const view = useDuelSession(d.session);
  const me = d.mySeat;
  const them = other(me);
  const names = view.state.players.map((p) => p.name) as [string, string];
  const mine = view.rematch[me];
  const theirs = view.rematch[them];
  const gone = theirs === 'no' || (!d.hotseat && view.status !== 'connected');
  const both = view.rematch[0] === 'yes' && view.rematch[1] === 'yes';
  const iWon = view.series.last === me;
  const iLost = view.series.last === them;
  const whoPicks = iWon ? `${names[them]} lost, so they pick who goes first.` : iLost ? 'You lost, so you pick who goes first.' : 'Rock-paper-scissors for who goes first.';

  // They called it first: a buzz so it isn't missed.
  useEffect(() => {
    if (theirs === 'yes' && mine === null) {
      buzz([40, 60, 40]);
      playBlip();
    }
  }, [theirs]);
  useEffect(() => {
    if (both) {
      playVs();
      buzz([30, 40, 90]);
    }
  }, [both]);

  const want = () => {
    playBlip();
    for (const p of d.hotseat ? ([0, 1] as Pid[]) : [me]) d.session.send({ type: 'REMATCH', player: p, want: true });
  };

  if (both)
    return (
      <div class="rematch-slam" role="status">
        <h1>REMATCH!</h1>
        <p>It's time to duel!</p>
      </div>
    );

  let msg: preact.ComponentChildren;
  let btn: preact.ComponentChildren = null;
  if (gone) msg = d.hotseat ? 'No rematch this time.' : `${names[them]} left the room.`;
  else if (d.hotseat) {
    msg = (
      <>
        Rematch on this phone?
        <small>{view.series.last === 'draw' ? 'A coin toss decides who goes first.' : `${names[(view.series.last === 0 ? 1 : 0) as Pid]} lost, so they pick who goes first.`}</small>
      </>
    );
    btn = (
      <button class="rematch-go" onClick={want}>
        REMATCH!
      </button>
    );
  } else if (mine === 'yes')
    msg = (
      <>
        Waiting for {names[them]}…<small>{whoPicks}</small>
      </>
    );
  else if (theirs === 'yes') {
    msg = (
      <>
        {names[them]} {iWon ? 'demands a rematch!' : 'wants a rematch!'}
        <small>{whoPicks}</small>
      </>
    );
    btn = (
      <button class="rematch-go" onClick={want}>
        {iWon ? 'Accept the challenge' : "It's time to duel!"}
      </button>
    );
  } else {
    msg = (
      <>
        {iLost ? `Run it back against ${names[them]}?` : `Rematch ${names[them]}?`}
        <small>Same room, same decks, same bets. {whoPicks}</small>
      </>
    );
    btn = (
      <button class="rematch-go" onClick={want}>
        {iLost ? 'Demand a rematch!' : 'Rematch'}
      </button>
    );
  }

  return (
    <div class={`rematch-dock ${theirs === 'yes' && mine === null && !gone ? 'called' : ''}`} role="region" aria-label="Rematch" aria-live="polite">
      <div class="rematch-top">
        <span class="rematch-series">
          ⚔ Series {d.hotseat ? `${names[0]} ${score(view.series, 0)} ${names[1]}` : `${score(view.series, me)} vs ${names[them]}`}
        </span>
        <button class="rematch-x" aria-label="No rematch" onClick={d.onClose}>
          ✕
        </button>
      </div>
      <p class="rematch-msg">{msg}</p>
      {btn}
      {mine === 'yes' && !gone && (
        <button class="rematch-go wait" disabled>
          Rematch called ✓
        </button>
      )}
    </div>
  );
}
