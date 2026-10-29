// Duel School: the beginner tutorial's screens. Pick a coach, then five lessons in order:
// a few picture pages, a real Speed Duel with the coach talking you through every move
// (src/eds/tutorial.ts says what each step allows), and a short quiz. Offline, no key, and
// each lesson's one pack pays only the first time.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DuelSession, useDuelSession } from '../eds/session';
import { MemoryAdapter } from '../sync/memory';
import type { Action, Pid } from '../eds/types';
import { imageUrl } from '../eds/db';
import { CardImg } from './CardImg';
import { Duel } from './Duel';
import { playBlip, unlockAudio } from './sound';
import { cpuDelay, spotUid, spotlight } from './cpuPace';
import { artBusy, onArtChange, whenArtIdle } from '../art/cues';
import { getAnimSpeed } from '../art/settings';
import type { SpeedSave } from '../eds/speedSave';
import { COACHES, LESSONS, allowed, coachMayMove, coachOf, finishLesson, lessonOpen, lessonsDone, nextStep, schoolCoach, textOf, withCoach, LESSON_PACKS, type Coach, type Lesson, type QuizQ, type TutStep } from '../eds/tutorial';
import './tutorial.css';

type Stage = { kind: 'map' } | { kind: 'coach' } | { kind: 'slides' | 'duel' | 'quiz'; lesson: Lesson } | { kind: 'done'; lesson: Lesson; packs: number; score: number };

/** Android back inside Duel School: steps back to the lesson list first */
let back: (() => boolean) | null = null;
export const schoolBack = (): boolean => (back ? back() : false);

export function DuelSchool({ name, save, onSave, onExit, start }: { name: string; save: SpeedSave; onSave: (s: SpeedSave) => void; onExit: () => void; start?: 'first' }) {
  const coach = coachOf(schoolCoach(save));
  const [stage, setStage] = useState<Stage>(() => (!schoolCoach(save) ? { kind: 'coach' } : start === 'first' && !lessonsDone(save).length ? { kind: 'slides', lesson: LESSONS[0] } : { kind: 'map' }));
  const begin = (l: Lesson) => (playBlip(), setStage({ kind: 'slides', lesson: l }));
  const finish = (l: Lesson, s: number) => {
    const r = finishLesson(save, l.id);
    if (r.packs) onSave(r.save);
    setStage({ kind: 'done', lesson: l, packs: r.packs, score: s });
  };
  useEffect(() => {
    back = () => {
      if (stage.kind === 'map' || (stage.kind === 'coach' && !schoolCoach(save))) return false;
      setStage({ kind: 'map' });
      return true;
    };
    return () => {
      back = null;
    };
  });
  // the duel screen's own hints and the Friends button stay out of the coach's way
  useEffect(() => {
    document.documentElement.classList.add('in-school');
    return () => document.documentElement.classList.remove('in-school');
  }, []);

  if (stage.kind === 'coach')
    return (
      <CoachPick
        current={schoolCoach(save)}
        onPick={(c) => {
          onSave(withCoach(save, c.id));
          setStage(lessonsDone(save).length || !start ? { kind: 'map' } : { kind: 'slides', lesson: LESSONS[0] });
        }}
        onBack={schoolCoach(save) ? () => setStage({ kind: 'map' }) : onExit}
      />
    );
  if (stage.kind === 'slides') return <Slides key={stage.lesson.id} lesson={stage.lesson} coach={coach} onDone={() => setStage(stage.lesson.duel ? { kind: 'duel', lesson: stage.lesson } : { kind: 'quiz', lesson: stage.lesson })} onBack={() => setStage({ kind: 'map' })} />;
  if (stage.kind === 'duel') return <LessonDuel key={stage.lesson.id} lesson={stage.lesson} coach={coach} name={name} onWon={() => setStage({ kind: 'quiz', lesson: stage.lesson })} onLeave={() => setStage({ kind: 'map' })} />;
  if (stage.kind === 'quiz') return <Quiz key={stage.lesson.id} lesson={stage.lesson} coach={coach} onDone={(s) => finish(stage.lesson, s)} />;
  if (stage.kind === 'done') {
    const i = LESSONS.indexOf(stage.lesson);
    const next = LESSONS[i + 1];
    return <Done lesson={stage.lesson} coach={coach} packs={stage.packs} score={stage.score} next={next} onNext={() => (next ? begin(next) : onExit())} onMap={() => setStage({ kind: 'map' })} />;
  }
  return <SchoolMap save={save} coach={coach} onLesson={begin} onCoach={() => setStage({ kind: 'coach' })} onBack={onExit} />;
}

// ---------- the coach's face and a line from them ----------
function Face({ coach, size = 'm' }: { coach: Coach; size?: 's' | 'm' | 'l' }) {
  const url = imageUrl(coach.art);
  return <span class={`ds-face ${size}`} style={url ? { backgroundImage: `url("${url}")` } : undefined} aria-hidden="true" />;
}
function Says({ coach, children }: { coach: Coach; children: preact.ComponentChildren }) {
  return (
    <div class="ds-says">
      <Face coach={coach} />
      <div class="ds-says-box">
        <b>{coach.name}</b>
        <p>{children}</p>
      </div>
    </div>
  );
}
function Top({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header class="ds-top">
      <button class="ds-back" onClick={() => (playBlip(), onBack())} aria-label="Back">
        ‹
      </button>
      <b>{title}</b>
    </header>
  );
}

// ---------- picking a coach ----------
function CoachPick({ current, onPick, onBack }: { current?: string; onPick: (c: Coach) => void; onBack: () => void }) {
  const [on, setOn] = useState(current ?? COACHES[0].id);
  const c = coachOf(on);
  return (
    <div class="ds">
      <Top title="Duel School" onBack={onBack} />
      <main class="ds-page">
        <h1 class="ds-h1">Who should teach you?</h1>
        <p class="ds-dim">Pick a coach. They'll explain everything as you go: no Yu-Gi-Oh! knowledge needed.</p>
        <div class="ds-coaches">
          {COACHES.map((x) => (
            <button key={x.id} class={`ds-coach ${x.id === on ? 'on' : ''}`} onClick={() => (playBlip(), setOn(x.id))}>
              <span class="ds-coach-pic">
                <CardImg name={x.art} />
              </span>
              <b>{x.name}</b>
            </button>
          ))}
        </div>
        <Says coach={c}>{c.hello}</Says>
        <button class="ds-go" onClick={() => (unlockAudio(), playBlip(), onPick(c))}>
          Learn with {c.name}
        </button>
      </main>
    </div>
  );
}

// ---------- the lesson list ----------
function SchoolMap({ save, coach, onLesson, onCoach, onBack }: { save: SpeedSave; coach: Coach; onLesson: (l: Lesson) => void; onCoach: () => void; onBack: () => void }) {
  const done = lessonsDone(save);
  const next = LESSONS.find((l) => !done.includes(l.id));
  return (
    <div class="ds">
      <Top title="Duel School" onBack={onBack} />
      <main class="ds-page">
        <Says coach={coach}>{next ? (done.length ? `Next up: ${next.title}. Ready?` : coach.hello) : "You've finished every lesson! Play any of them again whenever you like."}</Says>
        <div class="ds-progress" aria-label={`${done.length} of ${LESSONS.length} lessons done`}>
          {LESSONS.map((l) => (
            <i key={l.id} class={done.includes(l.id) ? 'on' : ''} />
          ))}
          <span>
            {done.length}/{LESSONS.length}
          </span>
        </div>
        <ol class="ds-lessons">
          {LESSONS.map((l, i) => {
            const open = lessonOpen(save, l.id);
            const isDone = done.includes(l.id);
            const url = imageUrl(l.art);
            return (
              <li key={l.id}>
                <button class={`ds-lesson ${isDone ? 'done' : ''} ${l === next ? 'next' : ''}`} disabled={!open} onClick={() => onLesson(l)}>
                  <span class="ds-lesson-art" style={url ? { backgroundImage: `url("${url}")` } : undefined} />
                  <span class="ds-lesson-n">{isDone ? '✓' : open ? i + 1 : '🔒'}</span>
                  <span class="ds-lesson-txt">
                    <b>{l.title}</b>
                    <small>{l.blurb}</small>
                    <em>{isDone ? 'Done · play again' : open ? `${l.duel ? 'Duel + quiz' : 'Pages + quiz'} · prize: ${LESSON_PACKS} card pack` : 'Finish the lesson before'}</em>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <button class="ds-link" onClick={() => (playBlip(), onCoach())}>
          Change coach
        </button>
      </main>
    </div>
  );
}

// ---------- picture pages ----------
function Slides({ lesson, coach, onDone, onBack }: { lesson: Lesson; coach: Coach; onDone: () => void; onBack: () => void }) {
  const [i, setI] = useState(0);
  const s = lesson.slides[i];
  const last = i === lesson.slides.length - 1;
  return (
    <div class="ds">
      <Top title={`Lesson ${LESSONS.indexOf(lesson) + 1}: ${lesson.title}`} onBack={onBack} />
      <main class="ds-page ds-slide" key={i}>
        <h1 class="ds-h1">{s.title}</h1>
        {s.cards && (
          <div class={`ds-cards n${s.cards.length}`}>
            {s.cards.map((c) => (
              <figure key={c.name}>
                <CardImg name={c.name} />
                <figcaption>{c.label}</figcaption>
              </figure>
            ))}
          </div>
        )}
        <Says coach={coach}>{s.text}</Says>
        <div class="ds-dots">
          {lesson.slides.map((_, j) => (
            <i key={j} class={j === i ? 'on' : ''} />
          ))}
        </div>
        <div class="ds-nav">
          {i > 0 && (
            <button class="ds-btn" onClick={() => (playBlip(), setI(i - 1))}>
              Back
            </button>
          )}
          <button class="ds-go" onClick={() => (unlockAudio(), playBlip(), last ? onDone() : setI(i + 1))}>
            {last ? (lesson.duel ? "Let's duel!" : 'Take the quiz') : 'Next'}
          </button>
        </div>
        {!last && (
          <button class="ds-link" onClick={() => (playBlip(), onDone())}>
            Skip to the {lesson.duel ? 'duel' : 'quiz'}
          </button>
        )}
      </main>
    </div>
  );
}

// ---------- the guided duel ----------
const THINK = 300;

function LessonDuel({ lesson, coach, name, onWon, onLeave }: { lesson: Lesson; coach: Coach; name: string; onWon: () => void; onLeave: () => void }) {
  const d = lesson.duel!;
  const session = useMemo(() => {
    const s = new DuelSession(new MemoryAdapter());
    const a = d.start(name, coach.name) as Extract<Action, { type: 'START' }>;
    for (const p of [0, 1] as Pid[]) s.send({ type: 'JOIN', player: p, name: a.names[p], deck: a.decks[p], fusion: a.fusions[p], mode: 'speed', skill: a.skills?.[p] ?? null });
    s.send(a);
    return s;
  }, []);
  useEffect(() => () => session.close(), []);
  const view = useDuelSession(session);
  const st = view.state;
  const steps = d.steps;
  const [idx, setIdx] = useState(() => nextStep(steps, 0, session.engine.state));
  const idxRef = useRef(idx);
  idxRef.current = idx;
  const [nudge, setNudge] = useState<{ text: string; key: number } | null>(null);
  const [cheer, setCheer] = useState<{ text: string; key: number } | null>(null);
  const cheers = useRef(0);

  // a step that's over moves on (a move the step asked for gets a cheer)
  useEffect(() => {
    const j = nextStep(steps, idx, session.engine.state);
    if (j === idx) return;
    if (steps[idx]?.kind === 'do') {
      setCheer({ text: coach.cheers[cheers.current++ % coach.cheers.length], key: Date.now() });
      setNudge(null);
    }
    setIdx(j);
  }, [view.moves, idx]);
  useEffect(() => {
    if (!cheer) return;
    const t = setTimeout(() => setCheer(null), 1400);
    return () => clearTimeout(t);
  }, [cheer?.key]);

  // the coach plays its part a beat after each change, never in the middle of a cinematic
  const turnAt = useRef({ turn: -1, at: 0 });
  if (st.turn !== turnAt.current.turn) turnAt.current = { turn: st.turn, at: Date.now() };
  useEffect(() => {
    if (!coachMayMove(steps, idx, session.engine.state)) return;
    let t = 0;
    let dead = false;
    const stop = whenArtIdle(
      () =>
        (t = window.setTimeout(() => {
          if (dead || !coachMayMove(steps, idxRef.current, session.engine.state)) return;
          const a = d.coach(session.engine);
          if (!a) return;
          const s = session.engine.state;
          const pace = cpuDelay(a, { sinceTurn: Date.now() - turnAt.current.at, firstTurn: s.turn === 1, ownTurn: s.turnPlayer === 1 && !s.prompt, animSpeed: getAnimSpeed() });
          t = window.setTimeout(() => {
            if (dead) return;
            session.send(a);
            const uid = spotUid(a);
            if (uid !== null) spotlight(uid);
          }, Math.max(0, pace - THINK));
        }, THINK)),
    );
    return () => ((dead = true), stop(), clearTimeout(t));
  }, [view.moves, idx]);

  const vet = (move: Parameters<DuelSession['send']>[0]) => {
    const a = move as Action;
    if (allowed(steps, idxRef.current, a, session.engine.state)) return true;
    const s = steps[idxRef.current];
    navigator.vibrate?.(30);
    setNudge({ text: s?.kind === 'do' ? (s.nudge ?? textOf(s, session.engine.state)) : s?.kind === 'info' ? 'Read this first, then tap Next.' : "Wait a moment: it's the coach's move.", key: Date.now() });
    return false;
  };
  const step = steps[idx];
  return (
    <>
      <Duel session={session} view={view} mySeat={0} hotseat={false} controlsFor={() => 'touch'} onLeave={onLeave} onFinished={(w) => (w === 0 ? onWon() : onLeave())} vet={vet} />
      {st.winner === null && step && (
        <CoachBubble
          key={step.id}
          coach={coach}
          step={step}
          n={idx}
          total={steps.length}
          text={textOf(step, st)}
          aim={step.aim ? (on) => step.aim!(session.engine.state, on) : undefined}
          nudge={nudge}
          onNext={() => (playBlip(), setNudge(null), setIdx(nextStep(steps, idx + 1, session.engine.state)))}
          onSkip={onLeave}
        />
      )}
      {cheer && (
        <div key={cheer.key} class="ds-cheer">
          <Face coach={coach} size="s" />
          <b>{cheer.text}</b>
        </div>
      )}
    </>
  );
}

/** The coach's line over the duel, and a ring around what to tap. */
function CoachBubble({ coach, step, n, total, text, aim, nudge, onNext, onSkip }: { coach: Coach; step: TutStep; n: number; total: number; text: string; aim?: (on: (sel: string) => boolean) => string | null; nudge: { text: string; key: number } | null; onNext: () => void; onSkip: () => void }) {
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(artBusy());
  // a window over the duel (card text, a pile, the menu): the coach steps aside until it closes
  const [covered, setCovered] = useState(false);
  const hidden = busy || covered;
  const [askSkip, setAskSkip] = useState(false);
  useEffect(() => onArtChange(() => setBusy(artBusy())), []);
  useEffect(() => {
    const t = setInterval(() => setCovered(!!document.querySelector('.overlay')), 250);
    return () => clearInterval(t);
  }, []);
  // follow the target: the board moves (hand fans, sheets open), so look again a few times a second
  useLayoutEffect(() => {
    if (!aim) return setRect(null);
    const on = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return !!el && el.getClientRects().length > 0;
    };
    const find = () => {
      const sel = aim(on);
      const el = sel ? (document.querySelector(sel) as HTMLElement | null) : null;
      const r = el?.getBoundingClientRect();
      const next = r && r.width > 0 ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
      setRect((cur) => (cur?.x === next?.x && cur?.y === next?.y && cur?.w === next?.w && cur?.h === next?.h ? cur : next));
    };
    find();
    const t = setInterval(find, 220);
    return () => clearInterval(t);
  }, [aim, step.id]);
  if (hidden) return null;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  // the bubble sits on the half of the screen away from what it points at
  const low = !!rect && rect.y + rect.h / 2 < vh * 0.42;
  const pad = 6;
  return (
    <>
      {rect &&
        (() => {
          const L = rect.x - pad, T = rect.y - pad, R = rect.x + rect.w + pad, B = rect.y + rect.h + pad;
          const f = step.kind === 'info' ? ' focus' : '';
          return (
            <>
              <i class={`ds-shade${f}`} style={{ left: 0, right: 0, top: 0, height: `${Math.max(0, T)}px` }} />
              <i class={`ds-shade${f}`} style={{ left: 0, right: 0, top: `${B}px`, bottom: 0 }} />
              <i class={`ds-shade${f}`} style={{ left: 0, width: `${Math.max(0, L)}px`, top: `${T}px`, height: `${B - T}px` }} />
              <i class={`ds-shade${f}`} style={{ left: `${R}px`, right: 0, top: `${T}px`, height: `${B - T}px` }} />
            </>
          );
        })()}
      {rect && (
        <div class={`ds-ring ${step.kind === 'info' ? 'focus' : ''}`} style={{ left: `${rect.x - pad}px`, top: `${rect.y - pad}px`, width: `${rect.w + pad * 2}px`, height: `${rect.h + pad * 2}px` }}>
          {step.kind === 'do' && <i class={`ds-finger ${rect.y > vh * 0.6 ? 'up' : ''}`}>👆</i>}
        </div>
      )}
      <div class={`ds-bubble ${low ? 'low' : 'high'} ${step.kind}`} key={nudge?.key ?? 0} onClick={(ev) => ev.stopPropagation()}>
        <div class="ds-bubble-top">
          <Face coach={coach} size="s" />
          <b>{step.title}</b>
          {step.choice && <span class="ds-choice">Your choice</span>}
          <button class="ds-skip" onClick={() => (playBlip(), setAskSkip(true))}>
            Leave
          </button>
        </div>
        <p>{text}</p>
        {nudge && (
          <p class="ds-nudge">
            {step.kind === 'do' ? `${coach.oops} ` : ''}
            {nudge.text}
          </p>
        )}
        <div class="ds-bubble-foot">
          <i class="ds-bar">
            <i style={{ width: `${Math.round(((n + 1) / total) * 100)}%` }} />
          </i>
          {step.kind === 'info' ? (
            <button class="ds-next" onClick={onNext}>
              Next ›
            </button>
          ) : step.kind === 'watch' ? (
            <span class="ds-wait">
              <i />
              <i />
              <i />
            </span>
          ) : (
            <span class="ds-yourmove">Your move</span>
          )}
        </div>
        {askSkip && (
          <div class="ds-ask">
            <span>Leave this lesson? You can start it again any time.</span>
            <button class="ds-btn" onClick={() => setAskSkip(false)}>
              Keep going
            </button>
            <button class="ds-btn bad" onClick={onSkip}>
              Leave
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// ---------- the quiz ----------
function Quiz({ lesson, coach, onDone }: { lesson: Lesson; coach: Coach; onDone: (score: number) => void }) {
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [right, setRight] = useState(0);
  const q: QuizQ = lesson.quiz[i];
  const last = i === lesson.quiz.length - 1;
  const answer = (k: number) => {
    if (picked !== null) return;
    playBlip();
    navigator.vibrate?.(k === q.right ? 20 : [30, 40, 30]);
    setPicked(k);
    if (k === q.right) setRight((r) => r + 1);
  };
  return (
    <div class="ds">
      <header class="ds-top">
        <b>Quick quiz · {i + 1} of {lesson.quiz.length}</b>
      </header>
      <main class="ds-page" key={i}>
        <h1 class="ds-h1 ds-q">{q.q}</h1>
        <div class="ds-answers">
          {q.options.map((o, k) => (
            <button key={k} class={`ds-answer ${picked === null ? '' : k === q.right ? 'right' : k === picked ? 'wrong' : 'off'}`} onClick={() => answer(k)}>
              <i>{'ABC'[k]}</i>
              <span>{o}</span>
            </button>
          ))}
        </div>
        {picked !== null && (
          <>
            <Says coach={coach}>
              {picked === q.right ? `${coach.cheers[i % coach.cheers.length]} ` : 'Not quite! '}
              {q.why}
            </Says>
            <button class="ds-go" onClick={() => (playBlip(), last ? onDone(right) : (setI(i + 1), setPicked(null)))}>
              {last ? 'Finish the lesson' : 'Next question'}
            </button>
          </>
        )}
      </main>
    </div>
  );
}

// ---------- lesson complete ----------
function Done({ lesson, coach, packs, score, next, onNext, onMap }: { lesson: Lesson; coach: Coach; packs: number; score: number; next?: Lesson; onNext: () => void; onMap: () => void }) {
  const all = lesson.quiz.length;
  const stars = score === all ? 3 : score >= all - 1 ? 2 : 1;
  return (
    <div class="ds">
      <main class="ds-page ds-done">
        <div class="ds-trophy">{next ? '🏅' : '🎓'}</div>
        <h1 class="ds-h1">{next ? 'Lesson complete!' : 'You graduated from Duel School!'}</h1>
        <div class="ds-stars" aria-label={`${stars} of 3 stars`}>
          {[0, 1, 2].map((k) => (
            <i key={k} class={k < stars ? 'on' : ''}>
              ★
            </i>
          ))}
        </div>
        <p class="ds-dim">
          Quiz: {score} of {all} right
        </p>
        {packs > 0 && (
          <div class="ds-prize">
            <span class="ds-prize-pack" />
            <b>
              +{packs} card pack{packs === 1 ? '' : 's'}
            </b>
            <small>Open it in the Shop tab</small>
          </div>
        )}
        <Says coach={coach}>{next ? `${coach.win} Next: ${next.title}.` : `${coach.win} Now go duel for real: try VS Computer or a Practice Duel, or challenge your brother!`}</Says>
        <button class="ds-go" onClick={() => (playBlip(), onNext())}>
          {next ? `Next lesson: ${next.title}` : 'Back to Speed Duel'}
        </button>
        <button class="ds-btn" onClick={() => (playBlip(), onMap())}>
          All lessons
        </button>
      </main>
    </div>
  );
}
