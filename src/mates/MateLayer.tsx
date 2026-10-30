// The Mates on the duel screen, like Master Duel's: yours stands in the empty spot left of
// your monsters, theirs in the spot right of theirs. Tap yours and it reacts (both phones see
// it); hold it for a row of emotes; tap theirs to poke it (only you see that). Both react by
// themselves to Summons, hits, lost monsters, the win and the loss. Nothing here touches the duel.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DuelSession, SessionView } from '../eds/session';
import type { DuelState, EngineEvent, Pid } from '../eds/types';
import { card as cardInfo } from '../eds/db';
import { MateArt } from './MateArt';
import { EMOTES, isMate, isReact, mateDef, type MateId, type MateReact } from './roster';
import { canSend, cuesFor, endCues, REACT_SPEC, tapReact } from './react';
import { useMatesShown } from './settings';
import { playMate, unlockAudio } from '../ui/sound';
import './mates.css';

export interface MatePlan {
  /** an online room: this phone's seat (its Mate and reactions go into the room's log); null: every Mate lives on this phone */
  sendSeat: Pid | null;
  /** the Mate of a seat this phone fills in: its own duelist's, the computer's, player 2's on one phone */
  idFor: (p: Pid) => MateId;
}

interface Box {
  x: number;
  /** where its feet stand */
  y: number;
  size: number;
}

interface Playing {
  react: MateReact | null;
  key: number;
}

const HOLD_MS = 420;
/** quiet this long and the waiting duelist's Mate dozes off */
const DOZE_MS = 28_000;

const other = (p: Pid): Pid => (p === 0 ? 1 : 0);

const BIG_HOW = new Set(['fusion', 'ritual', 'synchro', 'xyz', 'link']);

export function MateLayer({ session, view, state, acting, plan, touch }: { session: DuelSession; view: SessionView; state: DuelState; acting: Pid; plan: MatePlan; touch: boolean }) {
  const shown = useMatesShown();
  const own: Pid = plan.sendSeat ?? acting;
  const seats: Pid[] = shown === 'off' ? [] : shown === 'mine' ? [own] : [acting, other(acting)];

  // ----- which Mate each seat has -----
  useEffect(() => {
    const send = plan.sendSeat;
    if (send !== null) {
      const mine = plan.idFor(send);
      if (view.mates[send]?.id !== mine) session.send({ type: 'MATE', player: send, mate: mine });
    } else for (const p of [0, 1] as Pid[]) if (!view.mates[p]) session.localMate(p, plan.idFor(p));
  }, [view.mates[0]?.id, view.mates[1]?.id, view.round]);
  const idOf = (p: Pid): MateId | null => {
    const id = view.mates[p]?.id;
    return isMate(id) ? id : null;
  };

  // ----- what each one is doing -----
  const [playing, setPlaying] = useState<[Playing, Playing]>([
    { react: null, key: 0 },
    { react: null, key: 0 },
  ]);
  const timers = useRef<[number, number]>([0, 0]);
  const lastTap = useRef<[MateReact | null, MateReact | null]>([null, null]);
  const quietSince = useRef(Date.now());
  const seatsRef = useRef(seats);
  seatsRef.current = seats;
  const play = (p: Pid, r: MateReact, voice = true) => {
    quietSince.current = Date.now();
    const spec = REACT_SPEC[r];
    clearTimeout(timers.current[p]);
    setPlaying((cur) => {
      const next = [...cur] as [Playing, Playing];
      next[p] = { react: r, key: cur[p].key + 1 };
      return next;
    });
    if (!spec.loop)
      timers.current[p] = window.setTimeout(
        () =>
          setPlaying((cur) => {
            if (cur[p].react !== r) return cur;
            const next = [...cur] as [Playing, Playing];
            next[p] = { react: null, key: cur[p].key };
            return next;
          }),
        spec.ms,
      );
    const id = idOf(p);
    if (voice && id && seatsRef.current.includes(p)) playMate(mateDef(id)!.voice, r === 'sad' || r === 'hurt' || r === 'lose' ? 'down' : r === 'sleep' ? 'flat' : 'up');
  };
  useEffect(() => () => (clearTimeout(timers.current[0]), clearTimeout(timers.current[1])), []);

  // The other phone's reactions as they arrive in the room's log (never this phone's own: it played them at once).
  const seenN = useRef<[number, number]>([view.mates[0]?.n ?? 0, view.mates[1]?.n ?? 0]);
  useEffect(() => {
    for (const p of [0, 1] as Pid[]) {
      const m = view.mates[p];
      if (!m || m.n === seenN.current[p]) continue;
      seenN.current[p] = m.n;
      if (m.old || p === plan.sendSeat || !isReact(m.react) || state.winner !== null) continue;
      play(p, m.react);
    }
  }, [view.mates[0]?.n, view.mates[1]?.n]);

  // Reactions of their own to the duel: Summons, damage, monsters lost.
  const lastSeq = useRef((state.events ?? []).reduce((m, x) => Math.max(m, x.seq), 0));
  const monsters = (s: DuelState): [number, number] => [s.players[0].mz.filter(Boolean).length, s.players[1].mz.filter(Boolean).length];
  const lastCount = useRef(monsters(state));
  const topSeq = state.events?.length ? state.events[state.events.length - 1].seq : 0;
  useEffect(() => {
    const fresh = (state.events ?? []).filter((x) => x.seq > lastSeq.current);
    const now = monsters(state);
    const was = lastCount.current;
    lastCount.current = now;
    if (topSeq < lastSeq.current) lastSeq.current = topSeq; // the duel was rebuilt from its log
    if (!fresh.length || state.winner !== null) return;
    lastSeq.current = fresh[fresh.length - 1].seq;
    const summoned = (p: Pid) => fresh.filter((x) => x.kind === 'summon' && x.player === p).length;
    const lost: [number, number] = [Math.max(0, was[0] + summoned(0) - now[0]), Math.max(0, was[1] + summoned(1) - now[1])];
    for (const c of cuesFor(fresh, bigSummon(state), lost)) play(c.player, c.react);
    quietSince.current = Date.now();
  }, [topSeq]);

  // The duel's end: the winner's Mate celebrates, the loser's slumps.
  useEffect(() => {
    if (state.winner === null) return;
    for (const c of endCues(state.winner)) play(c.player, c.react);
  }, [state.winner]);

  // Hello at the start of the duel, and a doze when nothing has happened for a while.
  useEffect(() => {
    const hi = state.turn <= 1 ? window.setTimeout(() => (play(0, 'wave', false), play(1, 'wave', false)), 1400) : 0;
    const doze = window.setInterval(() => {
      if (state.winner !== null || Date.now() - quietSince.current < DOZE_MS) return;
      play(other(session.engine.state.turnPlayer), 'sleep', false);
    }, 4000);
    return () => (clearTimeout(hi), clearInterval(doze));
  }, []);

  // ----- where they stand -----
  const [boxes, setBoxes] = useState<[Box | null, Box | null]>([null, null]);
  const measure = () => {
    const root = document.querySelector(touch ? '.duel.touch' : '.duel');
    if (!root) return;
    const place = (bottom: boolean): Box | null => {
      if (touch) {
        const sp = root.querySelectorAll('.tmat .tz-spacer')[bottom ? 1 : 0];
        const r = sp?.getBoundingClientRect();
        if (!r || r.width < 8) return null;
        const size = Math.round(Math.max(44, Math.min(92, r.width * 1.05, r.height * 0.95)));
        // (theirs stands a little higher: the phase button sits just under its spot)
        return { x: Math.round(r.left + r.width / 2), y: Math.round(bottom ? r.bottom - r.height * 0.06 : r.top + r.height * 0.8), size };
      }
      const bar = root.querySelector(bottom ? '.pbar.bottom' : '.pbar.top')?.getBoundingClientRect();
      if (!bar || bar.width < 8) return null;
      const size = 46;
      return bottom ? { x: Math.round(bar.left + size * 0.75), y: Math.round(bar.top + 4), size } : { x: Math.round(bar.right - size * 1.9), y: Math.round(bar.bottom + size - 4), size };
    };
    const next: [Box | null, Box | null] = [null, null];
    next[acting] = place(true);
    next[other(acting)] = place(false);
    setBoxes((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
  };
  useLayoutEffect(() => {
    measure();
    const ts = [150, 700, 1300, 2200].map((ms) => window.setTimeout(measure, ms));
    window.addEventListener('resize', measure);
    const mat = document.querySelector('.duel .tmat');
    const ro = typeof ResizeObserver !== 'undefined' && mat ? new ResizeObserver(measure) : null;
    if (ro && mat) ro.observe(mat);
    return () => (ts.forEach(clearTimeout), window.removeEventListener('resize', measure), ro?.disconnect());
  }, [touch, acting]);

  // ----- taps -----
  const [wheel, setWheel] = useState(false);
  const lastSent = useRef(0);
  const hold = useRef<{ t: number; fired: boolean; id: number } | null>(null);
  /** this phone's own reaction: played at once, and sent to the room for the other phone */
  const react = (p: Pid, r: MateReact) => {
    const id = idOf(p);
    if (!id) return;
    if (p === plan.sendSeat) {
      if (!canSend(lastSent.current)) return;
      lastSent.current = Date.now();
      session.send({ type: 'MATE', player: p, mate: id, react: r });
    }
    play(p, r);
  };
  const quickTap = (p: Pid) => {
    const id = idOf(p);
    if (!id) return;
    unlockAudio();
    // (theirs: a poke only this phone sees)
    if (p !== own) return play(p, 'wow');
    const r = tapReact(mateDef(id)!.taps, lastTap.current[p]);
    lastTap.current[p] = r;
    react(p, r);
  };
  const down = (ev: PointerEvent, p: Pid) => {
    ev.stopPropagation();
    if (p !== own) return;
    const id = ev.pointerId;
    hold.current = {
      id,
      fired: false,
      t: window.setTimeout(() => {
        if (hold.current?.id !== id) return;
        hold.current.fired = true;
        navigator.vibrate?.(15);
        setWheel(true);
      }, HOLD_MS),
    };
  };
  const up = (ev: PointerEvent, p: Pid) => {
    ev.stopPropagation();
    const h = hold.current;
    hold.current = null;
    if (h) clearTimeout(h.t);
    if (!h?.fired) quickTap(p);
  };
  const cancel = () => {
    if (hold.current) clearTimeout(hold.current.t);
    hold.current = null;
  };
  useEffect(() => {
    if (state.winner !== null) setWheel(false);
  }, [state.winner]);

  if (!seats.length) return null;
  const ownBox = boxes[own];
  return (
    <div class={`mates-layer ${touch ? 'on-touch' : 'on-classic'}`}>
      {seats.map((p) => {
        const id = idOf(p);
        const b = boxes[p];
        if (!id || !b) return null;
        const pl = playing[p];
        const spec = pl.react ? REACT_SPEC[pl.react] : null;
        const top = p !== acting;
        const mine = p === own;
        return (
          <div
            key={p}
            class={`mate-spot ${top ? 'top' : 'bottom'} ${mine ? 'mine' : 'theirs'}`}
            style={{ left: `${b.x}px`, top: `${b.y}px`, '--ms': `${b.size}px` } as Record<string, string>}
            role="button"
            aria-label={mine ? `Your mate ${mateDef(id)!.name}: tap to react, hold for emotes` : `${mateDef(id)!.name}, their mate`}
            onPointerDown={(ev) => down(ev, p)}
            onPointerUp={(ev) => up(ev, p)}
            onPointerCancel={cancel}
            onPointerLeave={cancel}
            onClick={(ev) => ev.stopPropagation()}
            onContextMenu={(ev) => ev.preventDefault()}
          >
            <div key={pl.key} class={`mate-act ${pl.react ? `r-${pl.react}` : 'r-idle'}`}>
              <MateArt id={id} face={spec?.face ?? 'idle'} class={top ? 'flip' : ''} />
            </div>
            {spec?.emote && <Emote key={`e${pl.key}`} kind={spec.emote} />}
          </div>
        );
      })}
      {wheel && ownBox && idOf(own) && (
        <>
          <div class="mate-catch" onPointerDown={(ev) => (ev.stopPropagation(), setWheel(false))} onClick={(ev) => ev.stopPropagation()} />
          <div class={`mate-wheel ${own === acting ? 'up' : 'down'}`} style={{ left: `${Math.min(window.innerWidth - 150, Math.max(150, ownBox.x))}px`, top: `${own === acting ? ownBox.y - ownBox.size - 6 : ownBox.y + 8}px` }} onClick={(ev) => ev.stopPropagation()}>
            {EMOTES.map((e) => (
              <button key={e.react} class="mate-emo" onClick={() => (setWheel(false), react(own, e.react))}>
                <MateArt id={idOf(own)!} face={REACT_SPEC[e.react].face} />
                <span>{e.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** A Summon worth a cheer: level 7 or more, or a Fusion, Ritual, Synchro, Xyz or Link Summon. */
function bigSummon(state: DuelState) {
  return (ev: EngineEvent): boolean => {
    if (ev.how && BIG_HOW.has(ev.how)) return true;
    if (ev.uid === undefined) return false;
    const c = [...state.players[0].mz, ...state.players[1].mz].find((m) => m?.uid === ev.uid);
    const info = c ? cardInfo(c.name) : undefined;
    return (info?.level ?? 0) >= 7;
  };
}

/** The little symbol over a Mate's head. */
function Emote({ kind }: { kind: NonNullable<(typeof REACT_SPEC)[MateReact]['emote']> }) {
  const body =
    kind === 'sweat' ? (
      <svg viewBox="0 0 20 20">
        <path d="M10 2 C14 9 16 12 16 14 a6 6 0 0 1 -12 0 C4 12 6 9 10 2Z" fill="#8fdcff" stroke="#1d3b5c" stroke-width="1.4" />
      </svg>
    ) : kind === 'anger' ? (
      <svg viewBox="0 0 20 20">
        <path d="M3 8 Q8 8 8 3 M12 3 Q12 8 17 8 M17 12 Q12 12 12 17 M8 17 Q8 12 3 12" fill="none" stroke="#ff3b4e" stroke-width="2.6" stroke-linecap="round" />
      </svg>
    ) : (
      <span>{{ note: '♪', star: '★', bang: '!', dots: '…', heart: '♥', zzz: 'z z', ha: 'ha!' }[kind]}</span>
    );
  return <div class={`mate-emote em-${kind}`}>{body}</div>;
}
