// The 3D art engine's only hook into the duel screens: drop <ArtStage> into a
// duel (Classic and Touch share it) and it plays the cinematics the flow
// (flow.tsx: engine events → cue chains, the board kept in step) hands it.
// Speed Duel only. While the stage is on, a tap anywhere but on a prompt or a
// button skips the chain; hold or double-tap: skip all. The computer waits for it.
import { useEffect, useRef, useState } from "preact/hooks";
import type { DuelState, Pid } from "../eds/types";
import { bannerOnce, clearArtFocus, setArtBusy, type Cue } from "./cues";
import { FINISH_TAG, finishOf } from "./finish";
import { attachArtSink, boardHeld, chainCommitted, chainEnded, chainStarted, promptWaiting, releaseBoard, skipAllChains, tapToResult } from "./flow";
import { shadowRealmOf } from "./shadow";
import { getAnimSpeed, useAnimSpeed, useCinematics } from "./settings";
import type { Director, Ui } from "./runtime";
import type { BoardLayer, BoardMonster } from "./board";
import type { ArtData } from "./depth";
import { skipSpot } from "./skipspot";
import "./art.css";

export { CINEMATICS_NAMES, useCinematicsMenu } from "./settings";

/** Older name of the setting, kept for the 3D Card Viewer: 'off' when cinematics are off. */
export type ArtSetting = "full" | "fast" | "off";
export function getArtSetting(): ArtSetting {
  try {
    const c = localStorage.getItem("eds.cinematics");
    if (c === "off" || (!c && localStorage.getItem("eds.art3d") === "off")) return "off";
  } catch {
    /* storage blocked */
  }
  return "full";
}

/** Hold this long to skip everything (long enough that a slow tap never does). */
const HOLD_MS = 575;
const DOUBLE_TAP_MS = 350;

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

/** Taps on these never skip a cinematic: they belong to a prompt, a menu or a button. */
const INTERACTIVE = "button, a, input, select, textarea, label, [role=button], .tsheet, .tbtn, .topt, .taction, .tphase-btn, .tphase-item, .menu, .msgwin, .tresult, .win, .art-skip";

/** Text, numbers and flashes over the canvas. */
function makeUi(layer: HTMLDivElement, speed: () => number): Ui {
  const add = (
    cls: string,
    html: string,
    dur: number,
    style: Record<string, string> = {},
  ) => {
    const el = document.createElement("div");
    el.className = cls;
    el.innerHTML = html;
    const d = dur / speed();
    el.style.setProperty("--d", `${d}s`);
    for (const [k, v] of Object.entries(style)) el.style.setProperty(k, v);
    layer.appendChild(el);
    setTimeout(() => el.remove(), d * 1000 + 50);
  };
  const esc = (s: string) =>
    s.replace(
      /[&<>"]/g,
      (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!,
    );
  const once = bannerOnce();
  return {
    banner: (o) =>
      once(o.title) &&
      add(
        `art-banner ${o.big ? "big" : ""} pos-${o.pos ?? "bottom"}${o.finish ? ` fin-${o.finish}` : ""}`,
        `${o.finish ? `<i class="art-fin">${FINISH_TAG[o.finish] ?? ""}</i>` : ""}<b>${esc(o.title)}</b>${o.sub ? `<span>${esc(o.sub)}</span>` : ""}`,
        Math.max(0.6, o.dur),
        { "--c": hex(o.color) },
      ),
    number: (o) =>
      add(`art-number side-${o.side}`, esc(o.text), 1.3, {
        "--c": hex(o.color),
        "--s": String(o.size),
      }),
    flash: (c, s) =>
      add("art-flash", "", 0.35, { "--c": hex(c), "--s": String(s) }),
    caption: (t, dur, cls = "") => add(`art-caption ${cls}`, esc(t), dur),
    clear: () => layer.replaceChildren(),
  };
}

/** What in a bar the skip pill must not cover, as padded [left, right] spans: each child's box (a name: just its text). */
function barObstacles(bar: HTMLElement): [number, number][] {
  const out: [number, number][] = [];
  for (const c of Array.from(bar.children) as HTMLElement[]) {
    let b: DOMRect;
    if (/name/.test(c.className)) {
      const rg = document.createRange();
      rg.selectNodeContents(c);
      b = rg.getBoundingClientRect();
    } else b = c.getBoundingClientRect();
    if (b.width > 0) out.push([b.left - 6, b.right + 6]);
  }
  return out;
}

const idle = (f: () => void) => {
  const w = window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number };
  // Safari has no requestIdleCallback
  if (w.requestIdleCallback) w.requestIdleCallback(f, { timeout: 2500 });
  else setTimeout(f, 400);
};

export function ArtStage({ state, viewer }: { state: DuelState; viewer: Pid }) {
  const enabled = state.rules?.mode === "speed";
  const cine = useCinematics();
  const speed = useAnimSpeed();
  const on3d = enabled && cine !== "off";
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const dir = useRef<Director | null>(null);
  const loading = useRef<Promise<Director | null> | null>(null);
  const broken = useRef(false);
  const waiting = useRef<{ cues: Cue[]; batch: number; scales: number[] }[]>([]);
  const cineRef = useRef<string>(cine);
  cineRef.current = cine;
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;
  /** a cinematic is on screen (from its first built frame until the stage is idle) */
  const [active, setActiveState] = useState(false);
  /** a chain is on its way to the stage (the stage takes taps for the held board meanwhile) */
  const [armed, setArmed] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const pill = useRef<HTMLDivElement>(null);
  const boardCanvas = useRef<HTMLCanvasElement>(null);
  const board = useRef<BoardLayer | null>(null);
  const boardLoading = useRef(false);
  const lastTap = useRef(0);
  const holdTimer = useRef(0);

  /** The stage shows (or hides): the body class goes with it at once, not at the next render. */
  const setActive = (on: boolean) => {
    document.body.classList.toggle("art-on", on);
    if (on) placeSkip();
    setActiveState(on);
  };

  /** Loads three.js and builds the director (once). */
  const ensure = (): Promise<Director | null> => {
    if (dir.current) return Promise.resolve(dir.current);
    if (broken.current) return Promise.resolve(null);
    if (loading.current) return loading.current;
    loading.current = import("./runtime")
      .then(({ Director }) => {
        if (!canvas.current || !layer.current)
          throw new Error("art stage unmounted");
        const d: Director = new Director(
          canvas.current,
          "full",
          makeUi(layer.current, (): number => d.stage.speed * d.rate),
        );
        d.timeScale = getAnimSpeed();
        d.onBusy = () => (setArtBusy(true), setArmed(true));
        // the computer goes on (the stage may still hold the fighters for the blow, or fade out)
        d.onSettle = () => setArtBusy(false);
        d.onIdle = () => (setArtBusy(false), setArmed(false), setActive(false), clearArtFocus());
        d.onCommit = chainCommitted;
        d.onBatchEnd = chainEnded;
        // the stage turns on with the first cinematic actually built: a chain with nothing
        // to draw, or one skipped before it started, never flashes an empty stage
        d.onCueStart = (batch, seconds) => (setActive(true), chainStarted(batch, seconds));
        // no WebGL mid-cinematic: the board shows the duel as it is at once
        d.onLost = releaseBoard;
        d.viewer = viewerRef.current;
        d.cinematics = cineRef.current;
        d.hurry = promptWaiting;
        void Promise.resolve(d.prewarm?.()).catch(() => {});
        dir.current = d;
        const q = waiting.current;
        waiting.current = [];
        for (const w of q) d.push(w.cues, w.batch, w.scales);
        return d;
      })
      .catch((err) => {
        // No WebGL (or the download failed): the duel simply goes on without 3D.
        console.warn("3D art engine unavailable", err);
        broken.current = true;
        dropWaiting();
        setArtBusy(false);
        setArmed(false);
        setActive(false);
        return null;
      })
      .finally(() => (loading.current = null));
    return loading.current;
  };

  /** Builds the field figures layer (once): its WebGL context is made while the duel is quiet, not at the first summon. */
  const ensureBoard = () => {
    if (board.current || boardLoading.current || broken.current) return;
    boardLoading.current = true;
    import("./board")
      .then(({ BoardLayer }) => {
        if (!boardCanvas.current || board.current) return;
        board.current = new BoardLayer(boardCanvas.current);
        // under a cinematic's full dim only the stage draws
        board.current.covered = () => !!dir.current?.covering;
        board.current.sync(latest.current);
      })
      .catch((err) => console.warn("3D field figures unavailable", err))
      .finally(() => (boardLoading.current = false));
  };

  /** Chains that never reached the director: the board catches up with them now. */
  const dropWaiting = () => {
    const q = waiting.current;
    waiting.current = [];
    for (const w of q) chainEnded(w.batch);
  };

  const clearLayer = () => layer.current?.replaceChildren();

  /** Nothing more to play: the stage goes blank this frame and the board is released (no fade). */
  const hideNow = () => {
    if (dir.current?.hideNow()) setActive(false);
  };

  /** Tap: skip the chain on stage (after the duel is won: straight to the result). */
  const skipChain = () => {
    if (stateRef.current.winner !== null) return skipAll(false);
    tapToResult();
    clearLayer();
    if (dir.current) dir.current.skip();
    else dropWaiting();
    hideNow();
  };

  /** Hold / double tap: skip everything (and the rest of the opponent's turn). */
  const skipAll = (buzz = true) => {
    // a hold that fires: a short buzz says so
    if (buzz) navigator.vibrate?.(15);
    clearLayer();
    skipAllChains();
    dropWaiting();
    dir.current?.skipEverything();
    hideNow();
  };

  /**
   * The skip pill sits small in the opponent's bar, in the free gap between what is
   * in it (name, Skill, Life Points, the menu button) nearest the centre; when no gap
   * is wide enough (a narrow phone), just below the bar. Never over a hand's cards in
   * play or the Spell/Trap row. And the cinematic's figures keep clear of the bottom
   * bar: --art-safe-bottom (read by the director).
   */
  const placeSkip = () => {
    const bar = document.querySelector<HTMLElement>(".duel .tbar.top, .duel .pbar.top");
    const el = pill.current;
    if (el) {
      if (bar) {
        const r = bar.getBoundingClientRect();
        const cs = getComputedStyle(bar);
        const pt = parseFloat(cs.paddingTop) || 0;
        const inner = r.height - pt - (parseFloat(cs.paddingBottom) || 0);
        const spot = skipSpot(barObstacles(bar), r.left, r.right, window.innerWidth);
        // centred on the bar's content (below a notch's padding), or tucked under the bar
        el.style.top = `${Math.round(spot.below ? r.bottom + 4 : r.top + pt + Math.max(0, (inner - 24) / 2))}px`;
        el.style.left = `${Math.round(spot.left)}px`;
      } else {
        el.style.top = "";
        el.style.left = "";
      }
    }
    placeSafe();
  };
  const placeSafe = () => {
    const cv = canvas.current;
    const low = document.querySelector<HTMLElement>(".duel .tbar.bottom, .duel .pbar.bottom");
    if (!cv) return;
    const top = low?.getBoundingClientRect().top ?? 0;
    // (the stage's captions keep clear of the bar too: --art-safe-px)
    const stage = cv.parentElement;
    if (low && top > window.innerHeight * 0.5) {
      cv.style.setProperty("--art-safe-bottom", `${Math.round(window.innerHeight - top + 8)}`);
      stage?.style.setProperty("--art-safe-px", `${Math.round(window.innerHeight - top + 8)}px`);
    } else {
      cv.style.removeProperty("--art-safe-bottom");
      stage?.style.removeProperty("--art-safe-px");
    }
  };

  // Plug into the flow.
  useEffect(() => {
    if (!on3d) return;
    attachArtSink({
      ready: () => !broken.current,
      busy: () => !!dir.current?.busy || waiting.current.length > 0,
      play: (cues, batch, scales) => {
        placeSafe();
        if (dir.current) {
          dir.current.viewer = viewerRef.current;
          dir.current.push(cues, batch, scales);
          return;
        }
        waiting.current.push({ cues, batch, scales });
        setArtBusy(true);
        setArmed(true);
        void ensure();
      },
      // a choice for the player is up: everything on stage goes, at once
      skip: () => {
        clearLayer();
        // (the board already shows everything: whatever is still queued is behind it)
        dir.current?.skipEverything();
        hideNow();
      },
    });
    return () => attachArtSink(null);
  }, [on3d]);

  // Preload: three.js, the director (its shaders compile and draw once, in small
  // slices) and the figures layer as the duel opens, so the first cinematic starts
  // at once; then, in idle time, the art of every card in both decks.
  useEffect(() => {
    if (!on3d) return;
    let gone = false;
    // the director's shaders first (the first cinematic waits for them), then the figures layer's
    void ensure()
      .then((d) => d?.prewarm())
      .then(() => !gone && ensureBoard(), () => {});
    import("./board").catch(() => {});
    idle(() => {
      if (gone) return;
      ensureBoard();
      const names = new Set<string>();
      for (const p of [0, 1] as Pid[]) {
        const ps = state.players[p];
        for (const c of [...ps.mz, ...ps.hand, ...ps.deck, ...ps.fusion, ...ps.gy]) if (c?.name) names.add(c.name);
      }
      // also measure each figure's feet and look now: those small canvas reads stall a frame
      // when a monster's figure first appears mid-duel. One card per idle moment, and never
      // while a cinematic is on (a burst of reads there was a 0.6 s hitch on the first summon).
      Promise.all([import("./depth"), import("./stage")])
        .then(([{ preloadArt }, { figureFoot, artTame }]) => {
          if (gone) return;
          const q: ArtData[] = [];
          let pumping = false;
          const pump = () => {
            pumping = true;
            idle(() => {
              if (gone) return;
              if (dir.current?.onStage) return void setTimeout(pump, 500);
              const a = q.shift();
              if (a) (figureFoot(a), artTame(a));
              if (q.length) pump();
              else pumping = false;
            });
          };
          return preloadArt([...names], () => gone, (a) => {
            q.push(a);
            if (!pumping) pump();
          });
        })
        .catch(() => {});
    });
    return () => void (gone = true);
  }, [on3d]);

  // Monsters standing on their cards: every face-up monster on the field (a Token stays a flat card:
  // its art is a plain disc that rose as a smeared blob).
  // (ready: may attack in its controller's Battle Phase; hit: an attack or effect aims at it)
  const standing: BoardMonster[] = [];
  if (on3d && state.winner === null)
    for (const p of [0, 1] as Pid[])
      for (const c of state.players[p].mz)
        if (c?.faceUp && !c.token)
          standing.push({
            uid: c.uid,
            name: c.name,
            def: c.pos === "def",
            ready: state.phase === "BP" && state.turnPlayer === p && !state.firstTurn && c.pos === "atk" && !c.attacked,
            hit: state.battle?.target === c.uid || state.chain.some((l) => l.targetUid === c.uid),
            lp: state.players[p].lp,
            finish: finishOf({ name: c.name, owner: c.owner, controller: p }),
          });
  const standKey = standing
    .map((m) => `${m.uid}:${m.name}:${m.def ? 1 : 0}:${m.ready ? 1 : 0}:${m.hit ? 1 : 0}:${m.lp}:${m.finish}`)
    .join(",");
  useEffect(() => {
    if (board.current) return board.current.sync(standing);
    if (standing.length) ensureBoard();
  }, [standKey]);

  // The cards likely to star in the next cinematics (both hands, both fields): their
  // pictures go up to the stage's GPU now, one texture per frame in quiet time, so a
  // cinematic never stalls on an upload.
  const hotKey = on3d
    ? ([0, 1] as Pid[])
        .flatMap((p) => [...state.players[p].hand, ...state.players[p].mz, ...state.players[p].sz])
        .map((c) => c?.name ?? "")
        .filter(Boolean)
        .sort()
        .join("|")
    : "";
  useEffect(() => {
    if (!hotKey) return;
    let gone = false;
    const t = window.setTimeout(() => {
      void Promise.all([import("./depth"), ensure()]).then(([{ artFor }, d]) => {
        if (gone || !d) return;
        for (const name of new Set(hotKey.split("|"))) void artFor(name).then((a) => !gone && d.stage.upload(a), () => {});
      });
    }, 300);
    return () => ((gone = true), clearTimeout(t));
  }, [hotKey]);
  const latest = useRef(standing);
  latest.current = standing;

  useEffect(() => {
    if (dir.current) dir.current.cinematics = cine;
    if (cine === "off") (dir.current?.clear(), dropWaiting(), clearLayer());
  }, [cine]);
  useEffect(() => {
    if (dir.current) dir.current.timeScale = speed;
  }, [speed]);

  useEffect(() => {
    const onResize = () => (dir.current?.resize(), board.current?.resize(), placeSkip());
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(holdTimer.current);
      dir.current?.dispose();
      dir.current = null;
      board.current?.dispose();
      board.current = null;
      setArtBusy(false);
      document.body.classList.remove("art-on");
    };
  }, []);

  // With 3D on, the cinematics stand in for the Touch screen's flat card spotlight.
  useEffect(() => {
    document.body.classList.toggle("art3d-on", on3d);
    return () => document.body.classList.remove("art3d-on");
  }, [on3d]);

  // The result window waits until the finishing cinematic is over.
  const finishing = enabled && active && state.winner !== null;
  useEffect(() => {
    document.body.classList.toggle("art-finishing", finishing);
    return () => document.body.classList.remove("art-finishing");
  }, [finishing]);

  /**
   * Tap skips the chain; a second tap soon after, or holding, skips everything.
   * `own`: the tap is the stage's (it covers a held board, or the skip pill) and
   * goes no further; otherwise it also reaches the duel underneath.
   */
  const onDown = (ev: PointerEvent, own = true) => {
    if (own) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    const now = performance.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      skipAll();
      return;
    }
    lastTap.current = now;
    skipChain();
    clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(skipAll, HOLD_MS);
    let down = true;
    // a finger that moves is a drag, not a hold: it never skips everything
    const move = (e: PointerEvent) => {
      if (e.pointerId === ev.pointerId && Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY) > 12) clearTimeout(holdTimer.current);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== ev.pointerId) return;
      down = false;
      clearTimeout(holdTimer.current);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    // A touch on the stage while it held the board: the board has just caught up
    // (the chain was skipped), so step aside and hand the same touch to whatever is
    // under it, once the duel has redrawn: a drag of a hand card goes on as if the
    // cinematic had never been there.
    const el = host.current;
    if (own && el && ev.currentTarget === el) {
      el.style.pointerEvents = "none";
      // a touch is implicitly captured by the element it went down on: let it go
      const free = () => {
        for (const t of [ev.target as Element | null, el])
          try {
            t?.releasePointerCapture?.(ev.pointerId);
          } catch {
            /* not captured, or the pointer is gone */
          }
      };
      free();
      requestAnimationFrame(() => {
        free();
        if (!down) return;
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        if (!under || el.contains(under)) return;
        under.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: ev.pointerId,
            pointerType: ev.pointerType,
            isPrimary: ev.isPrimary,
            clientX: ev.clientX,
            clientY: ev.clientY,
            screenX: ev.screenX,
            screenY: ev.screenY,
            button: ev.button,
            buttons: ev.buttons,
          }),
        );
      });
    }
  };

  // While the stage is on but the board is up to date (after the impact, fading out,
  // the Shadow Realm finish), a tap anywhere but on a prompt, menu or button skips too.
  const heldRef = useRef(false);
  useEffect(() => {
    if (!active) return;
    const tap = (ev: PointerEvent) => {
      if (heldRef.current || ev.button > 0) return;
      const t = ev.target as Element | null;
      if (t?.closest?.(INTERACTIVE)) return;
      onDown(ev, false);
    };
    document.addEventListener("pointerdown", tap, true);
    return () => document.removeEventListener("pointerdown", tap, true);
  }, [active]);

  if (!enabled) return null;
  // While the board lags behind a cinematic, the whole stage takes taps (so nobody
  // acts on a board that is about to change); otherwise taps reach the duel, and
  // skip on the way unless they are meant for a prompt or a button.
  const held = (active || armed) && boardHeld();
  heldRef.current = held;
  // (a touch handed through above made the stage step aside until this redraw)
  if (host.current) host.current.style.pointerEvents = "";
  const sr = state.winner !== null ? shadowRealmOf(state) : null;
  return (
    <>
      <canvas ref={boardCanvas} class="art-board" />
      {/* over the raised Life Points bars, so it stays tappable */}
      <div ref={pill} class={`art-skip ${active ? "on" : ""}`} onPointerDown={(ev) => active && onDown(ev)}>
        Tap: skip · Hold: all
      </div>
      <div
        ref={host}
        class={`art-stage ${active ? "on" : ""} ${held ? "hold" : ""}`}
        onPointerDown={(ev) => held && onDown(ev)}
      >
        <canvas ref={canvas} class="art-canvas" />
        <div ref={layer} class="art-layer" />
        {sr && !active && (
          <div class="art-plaque">
            <b>{sr.loserName}</b> was sent to the Shadow Realm
            {sr.sealed ? (
              <>
                {" "}
                · <b>{sr.sealed}</b> is sealed until they win a duel
              </>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}
