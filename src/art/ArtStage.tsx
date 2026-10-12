// The 3D art engine's only hook into the duel screens: drop <ArtStage> into a
// duel (Classic and Touch share it) and it plays a cinematic for every summon,
// set, flip, Spell/Trap, attack, hit, destruction and finish, straight from the
// engine's event feed. Speed Duel only. Tap to skip; the computer waits for it.
import { useEffect, useRef, useState } from "preact/hooks";
import type { DuelState, Pid } from "../eds/types";
import {
  memoField,
  setArtBusy,
  toCues,
  type Cue,
  type CueTrack,
  type FieldMemo,
} from "./cues";
import { shadowRealmOf } from "./shadow";
import type { Director, Ui } from "./runtime";
import type { BoardLayer, BoardMonster } from "./board";
import "./art.css";

export type ArtSetting = "full" | "fast" | "off";
const KEY = "eds.art3d";
const EVT = "eds-art3d";
export const ART_SETTING_NAMES: Record<ArtSetting, string> = {
  full: "Full",
  fast: "Fast",
  off: "Off",
};

export function getArtSetting(): ArtSetting {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "full" || v === "fast" || v === "off") return v;
  } catch {
    /* storage blocked */
  }
  return "full";
}

export function setArtSetting(v: ArtSetting) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* storage blocked */
  }
  window.dispatchEvent(new Event(EVT));
}

/** Full → Fast → Off → Full. */
export function nextArtSetting(v: ArtSetting): ArtSetting {
  return v === "full" ? "fast" : v === "fast" ? "off" : "full";
}

export function useArtSetting(): ArtSetting {
  const [v, setV] = useState(getArtSetting);
  useEffect(() => {
    const on = () => setV(getArtSetting());
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);
  return v;
}

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

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
  return {
    banner: (o) =>
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
  };
}

export function ArtStage({ state, viewer }: { state: DuelState; viewer: Pid }) {
  const enabled = state.rules?.mode === "speed";
  const setting = useArtSetting();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const dir = useRef<Director | null>(null);
  const loading = useRef(false);
  const broken = useRef(false);
  const waiting = useRef<Cue[]>([]);
  const lastSeq = useRef<number | null>(null);
  const memo = useRef<FieldMemo>(new Map());
  const track = useRef<CueTrack>({ battle: null });
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;
  const [active, setActive] = useState(false);
  const boardCanvas = useRef<HTMLCanvasElement>(null);
  const board = useRef<BoardLayer | null>(null);
  const boardLoading = useRef(false);

  const play = (cues: Cue[]) => {
    if (broken.current) return;
    if (dir.current) {
      dir.current.viewer = viewerRef.current;
      dir.current.push(cues);
      return;
    }
    waiting.current.push(...cues);
    setArtBusy(true);
    setActive(true);
    if (loading.current) return;
    loading.current = true;
    import("./runtime")
      .then(({ Director }) => {
        if (!canvas.current || !layer.current)
          throw new Error("art stage unmounted");
        const d: Director = new Director(
          canvas.current,
          getArtSetting() === "fast" ? "fast" : "full",
          makeUi(layer.current, (): number => d.stage.speed),
        );
        d.onBusy = () => (setArtBusy(true), setActive(true));
        d.onIdle = () => (setArtBusy(false), setActive(false));
        d.viewer = viewerRef.current;
        dir.current = d;
        const q = waiting.current;
        waiting.current = [];
        d.push(q);
      })
      .catch((err) => {
        // No WebGL (or the download failed): the duel simply goes on without 3D.
        console.warn("3D art engine unavailable", err);
        broken.current = true;
        waiting.current = [];
        setArtBusy(false);
        setActive(false);
      })
      .finally(() => (loading.current = false));
  };

  // New engine events → cues → the director.
  useEffect(() => {
    const evs = state.events ?? [];
    const top = evs.length ? evs[evs.length - 1].seq : 0;
    if (lastSeq.current === null || top < lastSeq.current) {
      // First look, or the duel was rebuilt from its log: start from here, replay nothing.
      lastSeq.current = top;
      memo.current = memoField(state, viewer, host.current);
      return;
    }
    const fresh = evs.filter((e) => e.seq > lastSeq.current!);
    lastSeq.current = top;
    if (enabled && setting !== "off" && fresh.length) {
      const cues = toCues(
        fresh,
        state,
        viewer,
        host.current,
        memo.current,
        track.current,
      );
      if (cues.length) play(cues);
    }
    memo.current = memoField(state, viewer, host.current);
  }, [state.lastEvent?.seq, viewer]);

  // Monsters standing on their cards: every face-up monster on the field.
  const standing: BoardMonster[] = [];
  if (enabled && setting !== "off")
    for (const p of [0, 1] as Pid[])
      for (const c of state.players[p].mz)
        if (c?.faceUp)
          standing.push({ uid: c.uid, name: c.name, def: c.pos === "def" });
  const standKey = standing
    .map((m) => `${m.uid}:${m.name}:${m.def ? 1 : 0}`)
    .join(",");
  useEffect(() => {
    if (board.current) return board.current.sync(standing);
    if (!standing.length || boardLoading.current || broken.current) return;
    boardLoading.current = true;
    import("./board")
      .then(({ BoardLayer }) => {
        if (!boardCanvas.current) return;
        board.current = new BoardLayer(boardCanvas.current);
        board.current.sync(latest.current);
      })
      .catch((err) => console.warn("3D field figures unavailable", err))
      .finally(() => (boardLoading.current = false));
  }, [standKey]);
  const latest = useRef(standing);
  latest.current = standing;

  useEffect(() => {
    if (setting === "off") dir.current?.clear();
    else dir.current?.setQuality(setting);
  }, [setting]);

  useEffect(() => {
    const onResize = () => (dir.current?.resize(), board.current?.resize());
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      dir.current?.dispose();
      dir.current = null;
      board.current?.dispose();
      board.current = null;
      setArtBusy(false);
    };
  }, []);

  // With 3D on, the cinematics stand in for the Touch screen's flat card spotlight.
  const on3d = enabled && setting !== "off";
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

  if (!enabled) return null;
  const sr = state.winner !== null ? shadowRealmOf(state) : null;
  return (
    <>
      <canvas ref={boardCanvas} class="art-board" />
      <div
        ref={host}
        class={`art-stage ${active ? "on" : ""}`}
        onPointerDown={() => active && dir.current?.skip()}
      >
        <canvas ref={canvas} class="art-canvas" />
        <div ref={layer} class="art-layer" />
        {active && <div class="art-skip">Tap to skip</div>}
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
