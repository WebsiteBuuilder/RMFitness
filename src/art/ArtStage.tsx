// The 3D art engine's only hook into the duel screens: drop <ArtStage> into a
// duel (Classic and Touch share it) and it plays the cinematics the flow
// (flow.tsx: engine events → cue chains, the board kept in step) hands it.
// Speed Duel only. While the stage is on, a tap anywhere but on a prompt or a
// button skips the chain; hold or double-tap: skip all. The computer waits for it.
import { useEffect, useRef, useState } from "preact/hooks";
import type { DuelState, Pid } from "../eds/types";
import { bannerOnce, clearArtFocus, setArtBusy, type Cue } from "./cues";
import { attachArtSink, boardHeld, chainCommitted, chainEnded, chainStarted, releaseBoard, skipAllChains } from "./flow";
import { shadowRealmOf } from "./shadow";
import { getAnimSpeed, useAnimSpeed, useCinematics } from "./settings";
import type { Director, Ui } from "./runtime";
import type { BoardLayer, BoardMonster } from "./board";
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

const HOLD_MS = 400;
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
        `art-banner ${o.big ? "big" : ""} pos-${o.pos ?? "bottom"}`,
        `<b>${esc(o.title)}</b>${o.sub ? `<span>${esc(o.sub)}</span>` : ""}`,
        Math.max(0.6, o.dur),
        { "--c": hex(o.color) },
      ),
    number: (o) =>
      add(`art-number side-${o.side}`, esc(o.text), 0.9, {
        "--c": hex(o.color),
        "--s": String(o.size),
      }),
    flash: (c, s) =>
      add("art-flash", "", 0.35, { "--c": hex(c), "--s": String(s) }),
    caption: (t, dur, cls = "") => add(`art-caption ${cls}`, esc(t), dur),
    clear: () => layer.replaceChildren(),
  };
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
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;
  const [active, setActive] = useState(false);
  const boardCanvas = useRef<HTMLCanvasElement>(null);
  const board = useRef<BoardLayer | null>(null);
  const boardLoading = useRef(false);
  const lastTap = useRef(0);
  const holdTimer = useRef(0);

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
        d.onBusy = () => (setArtBusy(true), setActive(true));
        // the computer goes on (the stage may still hold the fighters for the blow, or fade out)
        d.onSettle = () => setArtBusy(false);
        d.onIdle = () => (setArtBusy(false), setActive(false), clearArtFocus());
        d.onCommit = chainCommitted;
        d.onBatchEnd = chainEnded;
        d.onCueStart = chainStarted;
        // no WebGL mid-cinematic: the board shows the duel as it is at once
        d.onLost = releaseBoard;
        d.viewer = viewerRef.current;
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

  /** Tap: skip the chain on stage. */
  const skipChain = () => {
    clearLayer();
    if (dir.current) dir.current.skip();
    else dropWaiting();
  };

  /** Hold / double tap: skip everything (and the rest of the opponent's turn). */
  const skipAll = () => {
    clearLayer();
    skipAllChains();
    dropWaiting();
    dir.current?.skipEverything();
  };

  // Plug into the flow.
  useEffect(() => {
    if (!on3d) return;
    attachArtSink({
      ready: () => !broken.current,
      busy: () => !!dir.current?.busy || waiting.current.length > 0,
      play: (cues, batch, scales) => {
        if (dir.current) {
          dir.current.viewer = viewerRef.current;
          dir.current.push(cues, batch, scales);
          return;
        }
        waiting.current.push({ cues, batch, scales });
        setArtBusy(true);
        setActive(true);
        void ensure();
      },
      skip: () => (clearLayer(), dir.current?.skip()),
    });
    return () => attachArtSink(null);
  }, [on3d]);

  // Preload: three.js, the director (its shaders compile and draw once, in small
  // slices) and the figures layer as the duel opens, so the first cinematic starts
  // at once; then, in idle time, the art of every card in both decks.
  useEffect(() => {
    if (!on3d) return;
    let gone = false;
    void ensure();
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
      // when a monster's figure first appears mid-duel
      Promise.all([import("./depth"), import("./stage")])
        .then(([{ preloadArt }, { figureFoot, artTame }]) =>
          gone ? undefined : preloadArt([...names], () => gone, (a) => (figureFoot(a), artTame(a))),
        )
        .catch(() => {});
    });
    return () => void (gone = true);
  }, [on3d]);

  // Monsters standing on their cards: every face-up monster on the field.
  // (ready: may attack in its controller's Battle Phase; hit: an attack or effect aims at it)
  const standing: BoardMonster[] = [];
  if (on3d && state.winner === null)
    for (const p of [0, 1] as Pid[])
      for (const c of state.players[p].mz)
        if (c?.faceUp)
          standing.push({
            uid: c.uid,
            name: c.name,
            def: c.pos === "def",
            ready: state.phase === "BP" && state.turnPlayer === p && !state.firstTurn && c.pos === "atk" && !c.attacked,
            hit: state.battle?.target === c.uid || state.chain.some((l) => l.targetUid === c.uid),
            lp: state.players[p].lp,
          });
  const standKey = standing
    .map((m) => `${m.uid}:${m.name}:${m.def ? 1 : 0}:${m.ready ? 1 : 0}:${m.hit ? 1 : 0}:${m.lp}`)
    .join(",");
  useEffect(() => {
    if (board.current) return board.current.sync(standing);
    if (standing.length) ensureBoard();
  }, [standKey]);
  const latest = useRef(standing);
  latest.current = standing;

  useEffect(() => {
    if (cine === "off") (dir.current?.clear(), dropWaiting(), clearLayer());
  }, [cine]);
  useEffect(() => {
    if (dir.current) dir.current.timeScale = speed;
  }, [speed]);

  useEffect(() => {
    const onResize = () => (dir.current?.resize(), board.current?.resize());
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(holdTimer.current);
      dir.current?.dispose();
      dir.current = null;
      board.current?.dispose();
      board.current = null;
      setArtBusy(false);
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
  const held = active && boardHeld();
  heldRef.current = held;
  // (a touch handed through above made the stage step aside until this redraw)
  if (host.current) host.current.style.pointerEvents = "";
  const sr = state.winner !== null ? shadowRealmOf(state) : null;
  return (
    <>
      <canvas ref={boardCanvas} class="art-board" />
      <div
        ref={host}
        class={`art-stage ${active ? "on" : ""} ${held ? "hold" : ""}`}
        onPointerDown={(ev) => held && onDown(ev)}
      >
        <canvas ref={canvas} class="art-canvas" />
        <div ref={layer} class="art-layer" />
        {active && (
          <div class="art-skip" onPointerDown={(ev) => !held && onDown(ev)}>
            Tap: skip · Hold: skip all
          </div>
        )}
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
