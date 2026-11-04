// The Duel Pass's small pieces shared by its screens: a reward's picture, the claim ceremony,
// avatar frames and name plates.
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { CardImg } from "../ui/CardImg";
import { MateArt } from "../mates/MateArt";
import { matUrl, trimUrl } from "../playmats/art";
import { buzz, playStar, playWin } from "../ui/sound";
import {
  frameDef,
  passOnly,
  plateDef,
  rewardName,
  ROAD,
  SEASON_TITLES,
  titleName,
  type Claimed,
  type PassReward,
} from "./pass";
import "./pass.css";

/** A reward's picture, sized by its box. */
/** Whose name the plate and frame previews show (set by the pass screens). */
let who = "Duelist";
export const setPassWho = (name: string | null | undefined) => {
  if (name?.trim()) who = name.trim().slice(0, 14);
};

export function RewardPic({ r }: { r: PassReward }) {
  switch (r.k) {
    case "sleeve":
      return (
        <span class="dp-pic dp-pic-sleeve">
          <CardImg name="" back sleeve={r.id} />
        </span>
      );
    case "mat":
      return (
        <span
          class="dp-pic dp-pic-mat"
          style={{ backgroundImage: `${trimUrl(r.id)}, ${matUrl(r.id)}` }}
        />
      );
    case "mate":
      return (
        <span class="dp-pic dp-pic-mate">
          <MateArt id={r.id} />
        </span>
      );
    case "frame":
      return (
        <span class="dp-pic dp-pic-frame">
          <Framed frame={r.id}>
            <span class="dp-face">{who.charAt(0).toUpperCase()}</span>
          </Framed>
        </span>
      );
    case "plate":
      return (
        <span class="dp-pic dp-pic-plate">
          <Plate plate={r.id} small>
            <b>{who}</b>
          </Plate>
        </span>
      );
    case "title":
    case "stitle": {
      const words = r.k === "title" ? titleName(r.id) : SEASON_TITLES[r.id];
      return (
        <span class={`dp-pic dp-pic-title ${r.k === "stitle" ? "season" : ""}`}>
          <span class="dp-ribbon">
            <small>Title</small>
            <b>{words}</b>
          </span>
        </span>
      );
    }
  }
}

/** An avatar inside its frame (no frame: just the avatar). */
export function Framed({
  frame,
  children,
  size,
}: {
  frame: string | null | undefined;
  children: ComponentChildren;
  size?: "small" | "big";
}) {
  const d = frameDef(frame);
  if (!d) return <>{children}</>;
  return (
    <span
      class={`dp-frame ${d.spin ? "spin" : ""} ${size ?? ""}`}
      style={
        {
          "--ring": `conic-gradient(${[...d.ring, d.ring[0]].join(",")})`,
          "--fglow": d.glow,
        } as Record<string, string>
      }
    >
      <i class="dp-ring" aria-hidden="true" />
      {children}
    </span>
  );
}

/** A name plate: the banner behind a name and title. */
export function Plate({
  plate,
  children,
  small,
}: {
  plate: string | null | undefined;
  children: ComponentChildren;
  small?: boolean;
}) {
  const d = plateDef(plate);
  return (
    <span
      class={`dp-plate ${d ? "on" : "none"} ${d?.shine ? "shine" : ""} ${small ? "small" : ""}`}
      style={
        d
          ? ({ "--pbg": d.bg, "--pedge": d.edge } as Record<string, string>)
          : undefined
      }
    >
      {children}
    </span>
  );
}

/** A duelist's name with their title under it, on their plate. */
export function NameBadge({
  name,
  title,
  plate,
  small,
}: {
  name: string;
  title: string | null;
  plate: string | null;
  small?: boolean;
}) {
  const t = titleName(title);
  return (
    <Plate plate={plate} small={small}>
      <b class="dp-pname">{name}</b>
      {t && <small class="dp-ptitle">{t}</small>}
    </Plate>
  );
}

/**
 * The claim ceremony: each reward flies out of the light one after another, flips to face you
 * and lands in a row, its name under it. Tap to hurry it along; Done when they're all out.
 */
export function ClaimCeremony({
  got,
  season,
  onDone,
}: {
  got: Claimed[];
  season: string;
  onDone: () => void;
}) {
  const [shown, setShown] = useState(0);
  const timer = useRef(0);
  const fresh = got.filter((g) => !g.dup);
  const list = [...fresh, ...got.filter((g) => g.dup)];
  // a big claim opens on its best rewards, one at a time and full size (the big tiers, pass-only first)
  const best = (g: Claimed) =>
    (ROAD[g.tier - 1]?.big ? 4 : 0) +
    (passOnly(g.reward) ? 2 : 0) +
    (g.lane === "prem" ? 1 : 0) +
    g.tier / 100;
  const heroes = useMemo(
    () =>
      fresh.length > 3
        ? [...fresh].sort((a, b) => best(b) - best(a)).slice(0, 2)
        : [],
    [],
  );
  const [hero, setHero] = useState(0);
  const inHero = hero < heroes.length;
  useEffect(() => {
    if (!inHero) return;
    playStar();
    buzz(25);
    const h = window.setTimeout(() => setHero((n) => n + 1), 1400);
    return () => clearTimeout(h);
  }, [hero]);
  const all = shown >= list.length;
  useEffect(() => {
    if (inHero || all) return;
    const first = shown === 0;
    timer.current = window.setTimeout(
      () => {
        setShown((n) => n + 1);
        playStar();
        if (
          list[shown] &&
          !list[shown].dup &&
          (list[shown].tier % 5 === 0 || list.length <= 3)
        )
          buzz(20);
      },
      first ? 650 : list.length > 8 ? 160 : 320,
    );
    return () => clearTimeout(timer.current);
  }, [shown, all, inHero]);
  useEffect(() => {
    if (all) {
      playWin();
      buzz([30, 40, 60]);
    }
  }, [all]);
  const hurry = () =>
    inHero ? setHero((n) => n + 1) : all ? undefined : setShown(list.length);
  const big = list.length <= 3;
  return (
    <div
      class="dp-claim"
      role="dialog"
      aria-modal="true"
      aria-label="Duel Pass rewards"
      onClick={hurry}
    >
      <div class="dp-claim-rays" aria-hidden="true" />
      <div class="dp-claim-head">
        <small>Duel Pass</small>
        <b>
          {fresh.length
            ? `${fresh.length} new reward${fresh.length === 1 ? "" : "s"}!`
            : "Rewards claimed"}
        </b>
      </div>
      {inHero ? (
        <div key={`h${hero}`} class={`dp-claim-hero ${heroes[hero].lane}`}>
          <span class="dp-claim-card">
            <RewardPic r={heroes[hero].reward} />
            <i class="dp-claim-shine" aria-hidden="true" />
          </span>
          <small>
            {
              rewardName(heroes[hero].reward, heroes[hero].season || season)
                .kind
            }
          </small>
          <b>
            {
              rewardName(heroes[hero].reward, heroes[hero].season || season)
                .name
            }
          </b>
        </div>
      ) : (
        <div class={`dp-claim-row ${big ? "big" : ""}`}>
          {list.slice(0, shown).map((g, i) => {
            const n = rewardName(g.reward, g.season || season);
            return (
              <div
                key={`${g.lane}${g.tier}`}
                class={`dp-claim-it ${g.dup ? "dup" : ""} ${g.lane}`}
                style={{ "--i": i } as Record<string, number>}
              >
                <span class="dp-claim-card">
                  <RewardPic r={g.reward} />
                  <i class="dp-claim-shine" aria-hidden="true" />
                </span>
                <small>{n.kind}</small>
                <b>{n.name}</b>
                {g.dup && <em>Already yours</em>}
              </div>
            );
          })}
        </div>
      )}
      <div class="dp-claim-foot">
        {all ? (
          <button
            class="dp-btn gold"
            onClick={(ev) => (ev.stopPropagation(), onDone())}
          >
            {fresh.some((g) =>
              ["title", "stitle", "plate", "frame"].includes(g.reward.k),
            )
              ? "Done · wear them on the pass"
              : "Done"}
          </button>
        ) : (
          <span class="dp-claim-skip">
            {inHero ? "Tap for the next" : "Tap to show them all"}
          </span>
        )}
      </div>
    </div>
  );
}

/** A duelist's title on its name plate under their name on the duel's face-off. */
export function FaceOffBadge({
  b,
}: {
  b: { title: string | null; plate: string | null };
}) {
  const t = titleName(b.title);
  return (
    <span class="fo-badge">
      <Plate plate={b.plate} small>
        <small class="dp-ptitle">{t ?? "Duelist"}</small>
      </Plate>
    </span>
  );
}
