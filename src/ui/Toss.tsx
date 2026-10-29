// Who goes first, shown on every phone: rock-paper-scissors (online and against the computer),
// a coin toss (two players on one phone), or the loser's call (a rematch). The winner picks
// first or second. Everything here is sent to the duel's log, so both phones play it out alike.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DuelSession, SessionView } from '../eds/session';
import type { Action, Pid } from '../eds/types';
import { flipCoin, randomHand, type CoinSide, type Hand } from '../eds/toss';
import { other } from '../eds/engine';
import { buzz, playBlip, playFanfare, playVs } from './sound';
import { clash } from './duelSfx';
import './toss.css';

const ICON: Record<Hand, string> = { rock: '✊', paper: '✋', scissors: '✌️' };
const LABEL: Record<Hand, string> = { rock: 'Rock', paper: 'Paper', scissors: 'Scissors' };
/** seconds to throw or pick before the game does it for you (nobody waits on a phone left on the table) */
const THROW_SECS = 10;
/** ...and against the computer, where nobody else is waiting to see your throw */
const CPU_SECS = 5;
/** how long a throw's reveal stays up, and the "X goes first" banner before the duel starts */
const REVEAL_MS = 1700;
const GO_MS = 800;

export function TossScreen({
  session,
  view,
  mySeat,
  hotseat,
  cpuSeat,
  buildStart,
  rival,
}: {
  session: DuelSession;
  view: SessionView;
  mySeat: Pid;
  hotseat: boolean;
  /** the seat the computer plays, in a duel against it */
  cpuSeat: Pid | null;
  /** the START for this duel once who goes first is known (sent by the host) */
  buildStart: (first: Pid) => Action;
  /** a duel with another player: your all-time record with them */
  rival?: { w: number; l: number; d: number; streak: number } | null;
}) {
  const t = view.toss!;
  const names = view.seats.map((s, i) => s.name || `Player ${i + 1}`) as [string, string];
  const you = (p: Pid) => (hotseat || p !== mySeat ? names[p] : 'You');
  const iControl = (p: Pid) => hotseat || p === mySeat;

  // A throw just resolved: play the "Rock, paper, scissors... shoot!" reveal before anything else.
  const seen = useRef(t.rounds.length);
  const [reveal, setReveal] = useState<number | null>(null);
  useEffect(() => {
    if (t.rounds.length > seen.current) {
      seen.current = t.rounds.length;
      setReveal(t.rounds.length - 1);
      const id = window.setTimeout(() => setReveal(null), REVEAL_MS);
      return () => clearTimeout(id);
    }
  }, [t.rounds.length]);
  /** the fists have pumped three times: the hands show */
  const [shot, setShot] = useState(false);
  useEffect(() => {
    setShot(false);
    if (reveal === null) return;
    const shoot = window.setTimeout(() => {
      setShot(true);
      clash();
      buzz(40);
    }, 900);
    return () => clearTimeout(shoot);
  }, [reveal]);

  // The coin spins before it says who won.
  const [spinning, setSpinning] = useState(false);
  const coinSeen = useRef(!!t.coin);
  useEffect(() => {
    if (t.coin && !coinSeen.current) {
      coinSeen.current = true;
      setSpinning(true);
      playBlip();
      const id = window.setTimeout(() => (setSpinning(false), buzz(30)), 1400);
      return () => clearTimeout(id);
    }
  }, [!!t.coin]);

  const busy = reveal !== null || spinning;
  const throwing = t.how === 'rps' && t.chooser === null && !busy;
  const choosing = t.chooser !== null && t.first === null && !busy;

  // The countdown for whatever this phone has to do next.
  const myTurnToThrow = throwing && !t.hands[mySeat] && cpuSeat !== mySeat && !hotseat;
  const myTurnToChoose = choosing && iControl(t.chooser!) && t.chooser !== cpuSeat;
  const secs = cpuSeat !== null ? CPU_SECS : THROW_SECS;
  const [left, setLeft] = useState(secs);
  const key = `${t.round}:${myTurnToThrow}:${myTurnToChoose}`;
  useEffect(() => {
    if (!myTurnToThrow && !myTurnToChoose) return;
    setLeft(secs);
    const started = Date.now();
    const id = window.setInterval(() => {
      const l = secs - Math.floor((Date.now() - started) / 1000);
      setLeft(Math.max(0, l));
      if (l <= 0) {
        clearInterval(id);
        if (myTurnToThrow) throwHand(randomHand());
        else pick(t.chooser!, t.chooser!);
      }
    }, 250);
    return () => clearInterval(id);
  }, [key]);

  const throwHand = (h: Hand) => {
    if (session.toss?.hands[mySeat] || session.toss?.chooser !== null) return;
    playBlip();
    session.send({ type: 'RPS', player: mySeat, hand: h, round: t.round });
  };
  const pick = (chooser: Pid, first: Pid) => {
    if (session.toss?.first !== null) return;
    playBlip();
    session.send({ type: 'FIRST', player: chooser, first });
  };
  const call = (c: CoinSide) => {
    if (session.toss?.coin) return;
    session.send({ type: 'COIN', player: 0, call: c, result: flipCoin() });
  };

  // The computer throws once you have, and when it wins it goes first.
  useEffect(() => {
    if (cpuSeat === null || !throwing || t.hands[cpuSeat] || !t.hands[other(cpuSeat)]) return;
    // (never the same hand as yours: no tie rounds against the computer, still a fair 50/50)
    const yours = t.hands[other(cpuSeat)];
    const hands = (['rock', 'paper', 'scissors'] as Hand[]).filter((h) => h !== yours);
    const id = window.setTimeout(() => session.send({ type: 'RPS', player: cpuSeat, hand: hands[Math.floor(Math.random() * hands.length)], round: t.round }), 450);
    return () => clearTimeout(id);
  }, [throwing, t.round, !!t.hands[other(cpuSeat ?? 0)]]);
  useEffect(() => {
    if (cpuSeat === null || !choosing || t.chooser !== cpuSeat) return;
    const id = window.setTimeout(() => pick(cpuSeat, cpuSeat), 800);
    return () => clearTimeout(id);
  }, [choosing, t.chooser]);

  // Once it's decided: a beat for the banner, then the host deals.
  useEffect(() => {
    if (t.first === null) return;
    playFanfare();
    if (!session.adapter.isHost) return;
    const id = window.setTimeout(() => {
      if (!session.state.started && session.toss?.first !== null && session.toss?.first !== undefined) session.send(buildStart(session.toss.first));
    }, GO_MS);
    return () => clearTimeout(id);
  }, [t.first]);
  useEffect(() => playVs(), []);

  const series = view.series;
  const played = series.wins[0] + series.wins[1] + series.draws;
  const head = t.how === 'loser' ? "LOSER'S CALL" : t.how === 'coin' ? 'COIN TOSS' : 'ROCK · PAPER · SCISSORS';

  const shown = reveal !== null ? t.rounds[reveal] : null;
  return (
    <div class={`toss toss-by-${t.how}`} role="dialog" aria-modal="true" aria-labelledby="toss-head">
      <div class="toss-rays" aria-hidden="true" />
      {played > 0 && (
        <p class="toss-series">
          {view.round > 0 ? 'Rematch · ' : ''}Series {names[mySeat === 1 && !hotseat ? 1 : 0]} {series.wins[mySeat === 1 && !hotseat ? 1 : 0]} – {series.wins[mySeat === 1 && !hotseat ? 0 : 1]} {names[mySeat === 1 && !hotseat ? 0 : 1]}
          {series.draws ? ` · ${series.draws} draw${series.draws > 1 ? 's' : ''}` : ''}
        </p>
      )}
      {rival && !hotseat && rival.w + rival.l + rival.d > 0 && (
        <p class="toss-series toss-alltime">
          All time: You {rival.w} – {rival.l} {names[other(mySeat)]}
          {rival.d > 0 ? ` · ${rival.d} ${rival.d === 1 ? 'draw' : 'draws'}` : ''}
          {rival.streak >= 2 ? ` · 🔥 ${rival.streak} wins in a row` : rival.streak <= -2 ? ` · ${-rival.streak} losses in a row` : ''}
        </p>
      )}
      <h1 id="toss-head" class="toss-head">
        {head}
      </h1>
      <p class="toss-sub">Who goes first?</p>

      {/* the two duelists, opponent on top like the duel field */}
      <div class="toss-duelists">
        {([other(hotseat ? 0 : mySeat), hotseat ? 0 : mySeat] as Pid[]).map((p) => {
          const h = shown ? shown.hands[p] : t.how === 'rps' && t.chooser !== null && t.rounds.length ? t.rounds[t.rounds.length - 1].hands[p] : null;
          const won = (shown ? shown.winner === p : t.chooser === p && !busy) || t.first === p;
          const lost = shown ? shown.winner !== null && shown.winner !== p : t.chooser !== null && t.chooser !== p && !busy;
          const thrown = !!t.hands[p];
          return (
            <div key={p} class={`toss-side ${p === mySeat && !hotseat ? 'me' : 'them'} ${won ? 'won' : ''} ${lost ? 'lost' : ''}`}>
              <span class="toss-name">{names[p]}</span>
              {t.how === 'rps' && (
                <span class={`toss-hand ${shown ? 'shake' : ''} ${p === (hotseat ? 0 : mySeat) ? 'mine' : 'theirs'}`} aria-label={h ? LABEL[h] : thrown ? 'ready' : 'thinking'}>
                  {shown ? <span class={shot ? 'toss-pop' : 'toss-shake'}>{shot ? ICON[h!] : '✊'}</span> : h ? ICON[h] : thrown ? (p === mySeat && !hotseat ? ICON[t.hands[p]!] : '✔') : '…'}
                </span>
              )}
              {t.first === p && <span class="toss-badge">GOES FIRST</span>}
              {t.first !== null && t.first !== p && <span class="toss-badge second">SECOND</span>}
            </div>
          );
        })}
      </div>

      {t.how === 'coin' && (
        <div class="toss-coinbox">
          <div class={`toss-coin ${spinning ? 'spin' : ''} ${t.coin && !spinning ? t.coin.result : ''}`} aria-hidden="true">
            <span class="face heads">H</span>
            <span class="face tails">T</span>
          </div>
          {t.coin && !spinning && (
            <p class="toss-line">
              {t.coin.result === 'heads' ? 'Heads' : 'Tails'}! {names[t.coin.by]} called {t.coin.call}: {names[t.chooser!]} wins the toss.
            </p>
          )}
          {!t.coin && (
            <>
              <p class="toss-line">{names[0]}, call it!</p>
              <div class="toss-btns">
                <button class="toss-btn" onClick={() => call('heads')}>
                  Heads
                </button>
                <button class="toss-btn" onClick={() => call('tails')}>
                  Tails
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {shown && !shot && <p class="toss-line big">Rock… paper… scissors…</p>}
      {shown && shot && <p class="toss-line big">{shown.winner === null ? 'Draw! Throw again!' : `${you(shown.winner)} win${you(shown.winner) === 'You' ? '' : 's'}!`}</p>}

      {throwing && (
        <div class="toss-throw">
          {t.round > 0 && <p class="toss-line">Round {t.round + 1}</p>}
          {myTurnToThrow ? (
            <>
              <div class="toss-pick">
                {(['rock', 'paper', 'scissors'] as Hand[]).map((h) => (
                  <button key={h} class="toss-pickbtn" onClick={() => throwHand(h)} aria-label={LABEL[h]}>
                    <span class="ic">{ICON[h]}</span>
                    <span class="lb">{LABEL[h]}</span>
                  </button>
                ))}
              </div>
              <Countdown left={left} />
            </>
          ) : (
            <p class="toss-line">{cpuSeat !== null ? `${names[cpuSeat]} is throwing…` : `Waiting for ${names[other(mySeat)]} to throw…`}</p>
          )}
        </div>
      )}

      {t.how === 'loser' && t.first === null && (
        <p class="toss-line">
          {you(t.chooser!) === 'You' ? 'You lost the last duel, so you pick.' : `${names[t.chooser!]} lost the last duel and picks.`}
        </p>
      )}

      {choosing &&
        (myTurnToChoose ? (
          <div class="toss-choose">
            <p class="toss-line">{hotseat ? `${names[t.chooser!]}: go first or second?` : t.how === 'loser' ? 'Go first or second?' : 'You won! Go first or second?'}</p>
            <div class="toss-btns">
              <button class="toss-btn gold" onClick={() => pick(t.chooser!, t.chooser!)}>
                Go first
              </button>
              <button class="toss-btn" onClick={() => pick(t.chooser!, other(t.chooser!))}>
                Go second
              </button>
            </div>
            <Countdown left={left} note={hotseat ? `then ${names[t.chooser!]} goes first` : 'then you go first'} />
          </div>
        ) : (
          <p class="toss-line">{names[t.chooser!]} is choosing…</p>
        ))}

      {t.first !== null && <p class="toss-line big go">{t.first === mySeat && !hotseat ? 'You go first!' : `${names[t.first]} goes first!`}</p>}
    </div>
  );
}

function Countdown({ left, note }: { left: number; note?: string }) {
  return (
    <p class={`toss-timer ${left <= 3 ? 'hurry' : ''}`}>
      {left}s{note ? ` · ${note}` : ''}
    </p>
  );
}
