// The pack opening ceremony: swipe (or tap) the foil to tear the pack, five cards slide out
// face down in your sleeve, and you turn them one at a time with a tap or a swipe. Each pull
// lights up in its rarity's colour and sound; Super Rares and better glow through their
// backs, and the pack's best card (Ultra Rare and up) waits last behind a hold-to-reveal
// that bursts it into the spotlight. Skip jumps straight to the results sheet.
//
// Cosmetic only: the pack is already opened and saved (by the Card Shop, in economy.ts) before the
// ceremony starts, so leaving half way loses nothing.
//
// Cheap on purpose: transforms and opacity only (no blur filters), a fixed handful of
// sparkle spans on the big pulls, one rotating gradient behind the stage, and every timer
// cleared when the ceremony closes.
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { owned } from '../eds/speedSave';
import type { Opened } from '../collection/economy';
import { RARITY_SHORT, rarityIn, shortSetName } from '../collection/sets';
import { chipText } from '../level/CardLevels';
import { TIERS } from '../level/leveling';
import { chosenSleeve } from '../sleeves/sleeves';
import type { SleeveId } from '../sleeves/roster';
import { CardImg, CardInfoPanel } from '../ui/CardImg';
import { Overlay, Win } from '../ui/Window';
import { buzz } from '../ui/sound';
import { GRADES, GRADE_NAME, STAR_FROM, TEASE_FROM, beatOf, flipOrder, foreshadow, gradeOf, nextToFlip, spotlight, starOf } from './grade';
import { sfxBurst, sfxCharge, sfxDeal, sfxFlip, sfxTear } from './sfx';
import './ceremony.css';

/** How long the rarest pull charges under your thumb. */
const CHARGE_MS = 850;
/** A press shorter than this is a tap: the charge finishes by itself. */
const TAP_MS = 220;
/** How far (px) a finger has to travel to count as a swipe. */
const SWIPE_PX = 36;
const BUZZ: (number | number[])[] = [0, 12, 30, [40, 30, 60], [50, 30, 90], [60, 40, 120], [70, 40, 70, 40, 160], [80, 40, 80, 40, 220]];

// ---- the active ceremony answers Android's back button (and a controller's B) ----
let backHandler: (() => void) | null = null;
/** Back while a pack is opening skips to its results, then closes it. True when it handled the press. */
export function packBack(): boolean {
  if (!backHandler) return false;
  backHandler();
  return true;
}
function useBack(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = () => ref.current();
    backHandler = h;
    return () => {
      if (backHandler === h) backHandler = null;
    };
  }, []);
}

/** Timeouts that all stop when the ceremony closes. */
function useTimers() {
  const ids = useRef<number[]>([]);
  useEffect(() => () => ids.current.forEach((t) => clearTimeout(t)), []);
  return {
    later(fn: () => void, ms: number) {
      const id = window.setTimeout(fn, ms);
      ids.current.push(id);
      return id;
    },
    clear() {
      ids.current.forEach((t) => clearTimeout(t));
      ids.current = [];
    },
  };
}

/** Keeps the floating Friends button off the stage. */
function useNoPill() {
  useEffect(() => {
    document.documentElement.classList.add('no-pill');
    return () => document.documentElement.classList.remove('no-pill');
  }, []);
}

/** The foil: swipe across it (or tap it) to tear it. */
function useTear(onTear: () => void) {
  const [p, setP] = useState(0);
  const torn = useRef(false);
  const from = useRef<{ x: number; w: number } | null>(null);
  const tappedAt = useRef(-1e9);
  const go = () => {
    if (torn.current) return;
    torn.current = true;
    setP(1);
    onTear();
  };
  return {
    progress: p,
    torn: torn.current,
    tear: go,
    props: {
      onPointerDown: (e: PointerEvent) => {
        tappedAt.current = performance.now();
        from.current = { x: e.clientX, w: (e.currentTarget as HTMLElement).getBoundingClientRect().width || 160 };
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* fine without */
        }
      },
      onPointerMove: (e: PointerEvent) => {
        const f = from.current;
        if (!f || torn.current) return;
        const q = Math.min(1, Math.abs(e.clientX - f.x) / (f.w * 0.7));
        setP(q);
        if (q >= 1) go();
      },
      onPointerUp: () => {
        const q = p;
        from.current = null;
        if (torn.current) return;
        // a tap tears it at once; a swipe most of the way across tears it too
        if (q < 0.12 || q > 0.45) go();
        else setP(0);
      },
      onPointerCancel: () => {
        from.current = null;
        if (!torn.current) setP(0);
      },
      // a controller's A (or a keyboard) clicks without a pointer
      onClick: () => {
        if (performance.now() - tappedAt.current > 600) go();
      },
    },
  };
}

/** The hold-to-reveal: press and hold the glowing card; a quick tap lets it charge by itself. */
function useCharge(later: (fn: () => void, ms: number) => number, onBurst: (i: number) => void) {
  const [at, setAt] = useState(-1);
  const st = useRef<{ i: number; t: number; timer: number; stop: () => void; auto: boolean } | null>(null);
  const [miss, setMiss] = useState(false);
  const start = (i: number, auto: boolean) => {
    if (st.current) return;
    setMiss(false);
    const stop = sfxCharge(CHARGE_MS);
    buzz(15);
    const timer = later(() => {
      const s = st.current;
      st.current = null;
      setAt(-1);
      s?.stop();
      onBurst(i);
    }, CHARGE_MS);
    st.current = { i, t: performance.now(), timer, stop, auto };
    setAt(i);
  };
  const release = () => {
    const s = st.current;
    if (!s || s.auto) return;
    if (performance.now() - s.t < TAP_MS) return void (s.auto = true);
    // let go half way: it settles back down
    clearTimeout(s.timer);
    s.stop();
    st.current = null;
    setAt(-1);
    setMiss(true);
  };
  const cancel = () => {
    const s = st.current;
    if (!s) return;
    clearTimeout(s.timer);
    s.stop();
    st.current = null;
    setAt(-1);
  };
  useEffect(() => () => st.current?.stop(), []);
  return { at, miss, start, release, cancel };
}

/** Sparkles thrown off a big pull (a fixed few, CSS only). */
const Sparks = ({ n }: { n: number }) => (
  <i class="po-sparks" aria-hidden="true">
    {Array.from({ length: n }, (_, k) => (
      <b key={k} style={{ '--a': `${(360 / n) * k + (k % 2) * 14}deg`, '--d': `${(k % 3) * 40}ms` } as Record<string, string>} />
    ))}
  </i>
);

/** The charge ring on the card that waits for a hold: it fills while you press. */
const Ring = () => (
  <svg class="po-ring" viewBox="0 0 40 40" aria-hidden="true">
    <circle class="bg" cx="20" cy="20" r="16" />
    <circle class="fg" cx="20" cy="20" r="16" pathLength="100" />
    <path class="po-ring-eye" d="M9 20 Q20 11 31 20 Q20 29 9 20 Z" />
    <circle class="po-ring-dot" cx="20" cy="20" r="3.6" />
  </svg>
);

/** The Millennium Eye behind the very rarest pulls. */
const Eye = () => (
  <svg class="po-eye" viewBox="0 0 100 64" aria-hidden="true">
    <g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 13 Q50 -4 92 10" />
      <path d="M8 30 Q50 6 92 28 Q50 46 8 30 Z" />
      <path d="M40 41 L34 60" />
      <path d="M58 40 Q66 58 80 56 Q90 54 86 46" />
    </g>
    <circle cx="50" cy="27" r="9" fill="currentColor" />
  </svg>
);

const gradeId = (g: number) => GRADES[Math.max(0, Math.min(GRADES.length - 1, g))];

/** A card's rarity mark: the finish it came out at, else its printed rarity. */
function Mark({ fin, printed }: { fin: number; printed: string }) {
  return fin > 0 ? <span class={`po-mark lv-chip lv-${TIERS[fin].id}`}>{chipText(TIERS[fin].id)}</span> : <span class="po-mark po-r">{RARITY_SHORT[printed as keyof typeof RARITY_SHORT] ?? 'C'}</span>;
}

/** The stage every opening plays on: full screen, its light tinted by the best pull. */
function Stage({ tint, flash, flashN, children, onSkip, cls = '' }: { tint: number; flash: number; flashN: number; children: ComponentChildren; onSkip?: () => void; cls?: string }) {
  return (
    <div class={`overlay po po-t-${gradeId(tint)} ${cls}`} role="dialog" aria-label="Opening a pack">
      <i class="po-rays" aria-hidden="true" />
      {flash >= 0 && <i key={flashN} class={`po-flash po-f-${gradeId(flash)}`} aria-hidden="true" />}
      {onSkip && (
        <button class="po-skip" onClick={onSkip} data-pad-back>
          Skip
        </button>
      )}
      {children}
    </div>
  );
}

/** The foil pack: art, logo, a crimp along the top that tears where your finger runs. */
function Foil({ cover, title, tear, torn, count = 1, sub }: { cover?: string; title: string; tear: ReturnType<typeof useTear>; torn: boolean; count?: number; sub?: string }) {
  return (
    <div class={`po-packwrap ${torn ? 'torn' : ''}`}>
      {count > 1 && (
        <>
          <i class="po-under u2" aria-hidden="true" />
          <i class="po-under u1" aria-hidden="true" />
        </>
      )}
      <button class="po-pack" style={{ '--tear': String(tear.progress) } as Record<string, string>} {...tear.props} aria-label="Tear the pack open">
        <span class="po-crimp" aria-hidden="true">
          <i class="po-cut" />
        </span>
        {cover && (
          <span class="po-art">
            <CardImg name={cover} />
          </span>
        )}
        <span class="po-logo">SPEED DUEL</span>
        <span class="po-name">{title}</span>
        {count > 1 && <span class="po-count">×{count}</span>}
        <i class="po-sheen" aria-hidden="true" />
      </button>
      <p class="po-help">
        <span class="touch-txt">{sub ?? 'Swipe across the top to tear it open'}</span>
        <span class="pad-txt">A to tear it open</span>
      </p>
    </div>
  );
}

/** A single pack, card by card. */
export function PackCeremony({ opened, cover, left, onAgain, onDone }: { opened: Opened; cover?: string; left: number; onAgain: (all: boolean) => void; onDone: () => void }) {
  useNoPill();
  const t = useTimers();
  const cards = opened.cards;
  const rar = useMemo(() => cards.map((n) => rarityIn(opened.set, n)), [opened]);
  const fin = useMemo(() => cards.map((_, i) => opened.finishes?.[i] ?? 0), [opened]);
  const grades = useMemo(() => cards.map((_, i) => gradeOf(rar[i], fin[i])), [opened]);
  const star = starOf(grades);
  const top = foreshadow(grades);
  const sleeve: SleeveId = chosenSleeve(opened.save);
  const [stage, setStage] = useState<'pack' | 'tear' | 'open'>('pack');
  const [up, setUp] = useState<boolean[]>(() => cards.map(() => false));
  const [flash, setFlash] = useState(-1);
  const [flashN, setFlashN] = useState(0);
  const [spot, setSpot] = useState(-1);
  const [info, setInfo] = useState<string | null>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const swipedAt = useRef(-1e9);
  const pressAt = useRef(-1e9);

  const light = (g: number) => {
    if (g < TEASE_FROM) return;
    setFlash(g);
    setFlashN((k) => k + 1);
    t.later(() => setFlash((f) => (f === g ? -1 : f)), beatOf(g));
  };
  const flipCard = (i: number, quiet = false) => {
    setUp((cur) => (cur[i] ? cur : cur.map((u, j) => u || j === i)));
    if (quiet) return;
    sfxFlip(grades[i]);
    if (BUZZ[grades[i]]) buzz(BUZZ[grades[i]]);
    light(grades[i]);
  };
  const charge = useCharge(t.later, (i) => {
    flipCard(i, true);
    sfxBurst(grades[i]);
    buzz(BUZZ[grades[i]] || 60);
    light(grades[i]);
    setSpot(i);
  });
  const tear = useTear(() => {
    sfxTear();
    buzz(30);
    setStage('tear');
    t.later(() => {
      setStage('open');
      cards.forEach((_, i) => t.later(() => sfxDeal(i), 60 + i * 70));
    }, 420);
  });

  const allUp = up.every(Boolean);
  const done = stage === 'open' && allUp && spot < 0 && charge.at < 0;

  const tapCard = (i: number) => {
    if (performance.now() - swipedAt.current < 350) return;
    // the click that ends a hold (or the tap that started a charge) isn't a second tap
    if (performance.now() - pressAt.current < 1500) return;
    if (up[i]) return setInfo(cards[i]);
    if (i === star) {
      // a finger is handled by the press itself; a controller's A charges it by itself
      charge.start(i, true);
      return;
    }
    flipCard(i);
  };
  const flipNext = () => {
    const i = nextToFlip(grades, up);
    if (i < 0) return;
    if (i === star) charge.start(i, true);
    else flipCard(i);
  };
  // Flip all: the rest in order, a little apart; the star still waits for its hold.
  const flipAll = () => {
    const rest = flipOrder(grades).filter((i) => !up[i] && i !== star);
    if (!rest.length && star >= 0 && !up[star]) return charge.start(star, true);
    rest.forEach((i, k) => t.later(() => flipCard(i), k * 120));
  };
  const skip = () => {
    t.clear();
    charge.cancel();
    setStage('open');
    setUp(cards.map(() => true));
    setSpot(-1);
    setFlash(-1);
    sfxFlip(top);
  };
  useBack(() => (done ? onDone() : skip()));

  const rowProps = {
    onPointerDown: (e: PointerEvent) => (swipe.current = { x: e.clientX, y: e.clientY }),
    onPointerUp: (e: PointerEvent) => {
      const s = swipe.current;
      swipe.current = null;
      if (!s || charge.at >= 0) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (Math.abs(dx) > SWIPE_PX || dy < -SWIPE_PX) {
        swipedAt.current = performance.now();
        flipNext();
      }
    },
  };
  const restLeft = up.filter((u, i) => !u && i !== star).length;
  const starWaits = star >= 0 && !up[star];
  const sorted = cards.map((n, i) => ({ n, i })).sort((a, b) => grades[b.i] - grades[a.i] || a.i - b.i);

  return (
    <Stage tint={stage === 'pack' ? 0 : top} flash={flash} flashN={flashN} onSkip={done ? undefined : skip} cls={`${stage} ${done ? 'done' : ''}`}>
      {stage !== 'open' ? (
        <Foil cover={cover} title={shortSetName(opened.set ?? '')} tear={tear} torn={stage === 'tear'} />
      ) : (
        <>
          <div class="po-row" {...rowProps}>
            {cards.map((n, i) => {
              const g = grades[i];
              const isStar = i === star && !up[i];
              return (
                <button
                  key={i}
                  class={`po-card g-${gradeId(g)} ${up[i] ? 'up' : ''} ${!up[i] && g >= TEASE_FROM ? 'tease' : ''} ${isStar ? 'star' : ''} ${charge.at === i ? 'charging' : ''}`}
                  style={{ '--i': String(i) } as Record<string, string>}
                  onClick={() => tapCard(i)}
                  onPointerDown={isStar ? (e: PointerEvent) => ((pressAt.current = performance.now()), e.stopPropagation(), charge.start(i, false)) : undefined}
                  onPointerUp={isStar ? () => charge.release() : undefined}
                  onPointerLeave={isStar ? () => charge.release() : undefined}
                  onPointerCancel={isStar ? () => charge.release() : undefined}
                  aria-label={up[i] ? `${n}, ${GRADE_NAME[gradeId(g)]}` : isStar ? 'Hold to reveal the best card' : 'Face-down card: tap to flip'}
                >
                  <span class="po-in">
                    <span class="po-back">
                      <CardImg name="" back sleeve={sleeve} />
                      {isStar && (
                        <Ring />
                      )}
                    </span>
                    <span class="po-face">
                      <CardImg name={n} tier={fin[i]} />
                      <Mark fin={fin[i]} printed={rar[i]} />
                      {opened.fresh.includes(n) && <span class="po-new">NEW</span>}
                    </span>
                  </span>
                  {up[i] && g >= TEASE_FROM && <Sparks n={g >= STAR_FROM ? 10 : 6} />}
                </button>
              );
            })}
          </div>
          {!done && spot < 0 && (
            <p class="po-help">
              {starWaits && !restLeft ? (
                <b class="po-hold">{charge.miss ? 'Keep holding to reveal it!' : 'Hold the glowing card to reveal it'}</b>
              ) : (
                <>
                  <span class="touch-txt">Tap a card or swipe to flip the next</span>
                  <span class="pad-txt">A to flip a card</span>
                </>
              )}
            </p>
          )}
          {!done && spot < 0 && (restLeft > 0 || starWaits) && (
            <div class="po-actions">
              <button class="rv-btn main" onClick={flipAll} disabled={charge.at >= 0}>
                {restLeft > 0 ? 'Flip all' : 'Reveal'}
              </button>
            </div>
          )}
          {done && (
            <div class="po-results" role="region" aria-label="Pack results">
              <ul class="po-list">
                {sorted.map(({ n, i }) => (
                  <li key={i} class={`g-${gradeId(grades[i])}`}>
                    <Mark fin={fin[i]} printed={rar[i]} />
                    <button class="po-lname" onClick={() => setInfo(n)}>
                      {n}
                    </button>
                    {opened.fresh.includes(n) ? <span class="po-new">NEW</span> : <span class="po-own">×{Math.min(3, owned(opened.save, n))}</span>}
                  </li>
                ))}
              </ul>
              {(top >= TEASE_FROM || opened.shards > 0) && (
                <p class="po-sum">
                  {top >= TEASE_FROM && (
                    <>
                      Best pull: <b>{GRADE_NAME[gradeId(top)]}</b>
                    </>
                  )}
                  {top >= TEASE_FROM && opened.shards > 0 && ' · '}
                  {opened.shards > 0 && `${opened.shards} shards from copies past 3`}
                </p>
              )}
              <div class="po-actions">
                {left > 0 && (
                  <button class="rv-btn main" onClick={() => onAgain(false)}>
                    Open another <small>{left} left</small>
                  </button>
                )}
                {left > 1 && (
                  <button class="rv-btn" onClick={() => onAgain(true)}>
                    Open all {left}
                  </button>
                )}
                <button class={`rv-btn ${left > 0 ? 'quiet' : 'main'}`} onClick={onDone}>
                  Done
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {spot >= 0 && <Spotlight name={cards[spot]} grade={grades[spot]} fin={fin[spot]} printed={rar[spot]} fresh={opened.fresh.includes(cards[spot])} onClose={() => setSpot(-1)} />}
      {info && (
        <Overlay onClose={() => setInfo(null)}>
          <Win title="Card Info" onClose={() => setInfo(null)}>
            <CardInfoPanel name={info} />
          </Win>
        </Overlay>
      )}
    </Stage>
  );
}

/** The rarest pull, full size in the light: tap to set it back down. */
function Spotlight({ name, grade, fin, printed, fresh, onClose, note = 'Tap to continue' }: { name: string; grade: number; fin: number; printed: string; fresh: boolean; onClose: () => void; note?: string }) {
  const g = gradeId(grade);
  return (
    <button class={`po-spot g-${g}`} onClick={onClose} aria-label={`${name}, ${GRADE_NAME[g]}. Tap to continue`}>
      <i class="po-spot-rays" aria-hidden="true" />
      {grade >= 5 && <Eye />}
      <span class="po-spot-title">{GRADE_NAME[g]}</span>
      <span class="po-spot-card">
        <CardImg name={name} tier={fin} />
        <Mark fin={fin} printed={printed} />
        {fresh && <span class="po-new">NEW</span>}
        <Sparks n={12} />
      </span>
      <span class="po-spot-name">{name}</span>
      <span class="po-spot-note">{note}</span>
    </button>
  );
}

/**
 * Several packs at once: one tear for the stack, then the batch's best pulls one by one
 * (Ultra Rare and up, best last, the very best behind a hold), then the results grid.
 */
export function PackBatch({ opened, cover, onFinish }: { opened: Opened[]; cover?: string; onFinish: () => void }) {
  useNoPill();
  const t = useTimers();
  const flat = useMemo(
    () =>
      opened.flatMap((o) =>
        o.cards.map((n, i) => {
          const r = rarityIn(o.set, n);
          const f = o.finishes?.[i] ?? 0;
          return { n, r, f, g: gradeOf(r, f), fresh: o.fresh.includes(n) };
        }),
      ),
    [opened],
  );
  const picks = useMemo(() => spotlight(flat.map((c) => c.g)), [flat]);
  const top = foreshadow(flat.map((c) => c.g));
  const sleeve = chosenSleeve(opened[opened.length - 1]?.save);
  const [stage, setStage] = useState<'pack' | 'tear' | 'show'>('pack');
  const [k, setK] = useState(0);
  const [up, setUp] = useState(false);
  const [flash, setFlash] = useState(-1);
  const [flashN, setFlashN] = useState(0);
  const finished = useRef(false);
  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    t.clear();
    charge.cancel();
    onFinish();
  };
  const light = (g: number) => {
    setFlash(g);
    setFlashN((x) => x + 1);
    t.later(() => setFlash((f) => (f === g ? -1 : f)), beatOf(g));
  };
  const cur = picks[k] !== undefined ? flat[picks[k]] : null;
  const last = k === picks.length - 1;
  const needsHold = !!cur && last && cur.g >= STAR_FROM;
  const charge = useCharge(t.later, () => {
    setUp(true);
    sfxBurst(cur?.g ?? 3);
    buzz(BUZZ[cur?.g ?? 3] || 60);
    light(cur?.g ?? 3);
  });
  const tear = useTear(() => {
    sfxTear();
    buzz(30);
    setStage('tear');
    t.later(() => {
      if (!picks.length) return finish();
      setStage('show');
      sfxDeal(0);
    }, 420);
  });
  const pressAt = useRef(-1e9);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const swipedAt = useRef(-1e9);
  const step = (fromPad = false) => {
    if (!cur || charge.at >= 0) return;
    if (!up) {
      if (needsHold) {
        if (fromPad) charge.start(0, true);
        return;
      }
      setUp(true);
      sfxFlip(cur.g);
      if (BUZZ[cur.g]) buzz(BUZZ[cur.g]);
      light(cur.g);
      return;
    }
    if (last) return finish();
    setUp(false);
    setK(k + 1);
    sfxDeal(k + 1);
  };
  useBack(finish);
  const g = cur ? gradeId(cur.g) : 'n';
  return (
    <Stage tint={stage === 'pack' ? 0 : top} flash={flash} flashN={flashN} onSkip={finish} cls={`batch ${stage}`}>
      {stage !== 'show' ? (
        <Foil cover={cover} title={`${opened.length} packs`} tear={tear} torn={stage === 'tear'} count={opened.length} sub="Swipe across the top to tear them all open" />
      ) : (
        cur && (
          <div
            class="po-solo"
            onPointerDown={(e: PointerEvent) => (swipe.current = { x: e.clientX, y: e.clientY })}
            onPointerUp={(e: PointerEvent) => {
              const s = swipe.current;
              swipe.current = null;
              if (!s || needsHold) return;
              if (Math.abs(e.clientX - s.x) > SWIPE_PX || e.clientY - s.y < -SWIPE_PX) (swipedAt.current = performance.now()), step();
            }}
          >
            <p class="po-count-line">
              Top pulls {k + 1} / {picks.length}
            </p>
            <button
              key={k}
              class={`po-card big g-${g} ${up ? 'up' : 'tease'} ${needsHold && !up ? 'star' : ''} ${charge.at >= 0 ? 'charging' : ''}`}
              onClick={() => {
                if (performance.now() - swipedAt.current < 350) return;
                // the click that ends a hold isn't a tap on the revealed card
                if (performance.now() - pressAt.current < 1500) return;
                if (needsHold && !up) {
                  charge.start(0, true);
                  return;
                }
                step();
              }}
              onPointerDown={needsHold && !up ? (e: PointerEvent) => ((pressAt.current = performance.now()), e.stopPropagation(), charge.start(0, false)) : undefined}
              onPointerUp={needsHold && !up ? () => charge.release() : undefined}
              onPointerLeave={needsHold && !up ? () => charge.release() : undefined}
              onPointerCancel={needsHold && !up ? () => charge.release() : undefined}
              aria-label={up ? `${cur.n}, ${GRADE_NAME[g]}` : needsHold ? 'Hold to reveal the best card' : 'Tap to flip'}
            >
              <span class="po-in">
                <span class="po-back">
                  <CardImg name="" back sleeve={sleeve} />
                  {needsHold && !up && (
                    <Ring />
                  )}
                </span>
                <span class="po-face">
                  <CardImg name={cur.n} tier={cur.f} />
                  <Mark fin={cur.f} printed={cur.r} />
                  {cur.fresh && <span class="po-new">NEW</span>}
                </span>
              </span>
              {up && <Sparks n={cur.g >= STAR_FROM ? 12 : 6} />}
            </button>
            <p class={`po-spot-title ${up ? 'on' : ''}`}>{up ? GRADE_NAME[g] : ' '}</p>
            <p class="po-spot-name">{up ? cur.n : ' '}</p>
            <div class="po-actions">
              {needsHold && !up ? (
                <b class="po-hold">{charge.miss ? 'Keep holding to reveal it!' : 'Hold the card to reveal the best pull'}</b>
              ) : (
                <button class="rv-btn main" onClick={() => step(true)}>
                  {!up ? 'Flip' : last ? 'See all cards' : 'Next'}
                </button>
              )}
            </div>
          </div>
        )
      )}
    </Stage>
  );
}
