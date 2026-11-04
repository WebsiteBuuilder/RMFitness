// The Duel Pass page: the season, your tier and XP, the road of 50 tiers (free lane on top, the
// Duel Chips lane under it) scrolled to where you are, claiming, opening the Chips lane, and
// wearing the titles, name plates and avatar frames the pass gives.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SpeedSave } from "../eds/speedSave";
import type { Profile } from "../eds/save";
import { chipsOf } from "../collection/economy";
import { ConfirmSheet } from "../ui/ConfirmSheet";
import { Avatar } from "../ui/Profiles";
import { buzz, playBlip, playWin } from "../ui/sound";
import { pickSleeve, chosenSleeve } from "../sleeves/sleeves";
import { pickPlaymat, chosenPlaymat } from "../playmats/playmats";
import { pickMate, chosenMate } from "../mates/roster";
import {
  cantOpenPrem,
  claimAll,
  claimTop,
  DAY_CAP,
  FRAMES,
  openPrem,
  ownedFrames,
  ownedPlates,
  ownedTitles,
  ownsReward,
  passDaysLeft,
  passOnly,
  passSeasonName,
  PLATES,
  PREM_PRICE,
  rewardName,
  ROAD,
  rollSeason,
  shownTrack,
  TIER_XP,
  TIERS,
  tierAt,
  tierProgress,
  titleName,
  TITLES,
  trackOf,
  unclaimed,
  wear,
  worn,
  XP_FIRST_WIN,
  XP_LOSS,
  XP_REQUEST,
  XP_WIN,
  type Claimed,
  type PassReward,
  type WearKind,
} from "./pass";
import { ClaimCeremony, Framed, NameBadge, RewardPic, setPassWho } from "./ui";
import "./pass.css";

type Pick = { tier: number; lane: "free" | "prem"; r: PassReward };

export function PassScreen({
  save,
  profile,
  onSave,
  onBack,
}: {
  save: SpeedSave;
  profile: Profile;
  onSave: (s: SpeedSave) => void;
  onBack: () => void;
}) {
  // A new season hands last season's unclaimed rewards over first.
  const [carried, setCarried] = useState<Claimed[] | null>(null);
  useEffect(() => {
    const r = rollSeason(save);
    if (r.save !== save) {
      onSave(r.save);
      if (r.carried.length) setCarried(r.carried);
    }
  }, []);
  setPassWho(profile.alias);
  const t = shownTrack(save);
  const frozen = !trackOf(save);
  const tier = tierAt(t.xp);
  const [have, need] = tierProgress(t.xp);
  const top = claimTop(save);
  const ready = unclaimed(t, top);
  const [got, setGot] = useState<Claimed[] | null>(null);
  const [buying, setBuying] = useState(false);
  const [look, setLook] = useState<Pick | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const road = useRef<HTMLDivElement>(null);
  const why = cantOpenPrem(save);

  // The road opens on where you are (the tier you're climbing in the middle).
  useEffect(() => {
    const el = road.current?.querySelector<HTMLElement>(
      `[data-tier="${Math.min(TIERS, tier + 1)}"]`,
    );
    const box = road.current;
    if (el && box)
      box.scrollLeft = Math.max(
        0,
        el.offsetLeft - box.clientWidth / 2 + el.offsetWidth / 2,
      );
  }, []);

  const claim = () => {
    const r = claimAll(save);
    if (!r) return;
    onSave(r.save);
    setGot(r.got);
  };
  const open = () => {
    setBuying(false);
    const next = openPrem(save);
    if (!next) return;
    onSave(next);
    playWin();
    buzz([30, 50, 90]);
    setNote(
      `The Chips lane is open for ${passSeasonName()}. ${tier > 0 ? `Tiers 1 to ${tier} are ready to claim.` : "Every tier you reach pays it too."}`,
    );
  };

  const w = worn(save);
  const wearIt = (kind: WearKind, id: string | null) => {
    const next = wear(save, kind, id);
    if (!next) return;
    playBlip();
    onSave(next);
  };
  /** Puts a sleeve, mat or Mate from the pass straight on. */
  const useIt = (r: PassReward) => {
    const next =
      r.k === "sleeve"
        ? pickSleeve(save, r.id)
        : r.k === "mat"
          ? pickPlaymat(save, r.id)
          : r.k === "mate"
            ? pickMate(save, r.id)
            : wear(
                save,
                r.k === "stitle" ? "title" : (r.k as WearKind),
                r.k === "stitle" ? `${r.id}@${t.season}` : r.id,
              );
    if (!next) return;
    playBlip();
    onSave(next);
    setLook(null);
    setNote(`${rewardName(r, t.season).name} is on.`);
  };
  const inUse = (r: PassReward) =>
    r.k === "sleeve"
      ? chosenSleeve(save) === r.id
      : r.k === "mat"
        ? chosenPlaymat(save) === r.id
        : r.k === "mate"
          ? chosenMate(save) === r.id
          : r.k === "stitle"
            ? w.title === `${r.id}@${t.season}`
            : (w as Record<string, string | null>)[r.k] === r.id;

  const titles = ownedTitles(save);
  const plates = ownedPlates(save);
  const frames = ownedFrames(save);
  const sumXp = useMemo(
    () =>
      `Win +${XP_WIN} · First win of the day +${XP_FIRST_WIN} · Duel played +${XP_LOSS} · Each Duelist Request +${XP_REQUEST}`,
    [],
  );

  return (
    <div class="screen dpass">
      <div class="dp-top">
        <button
          class="dp-back"
          onClick={() => (playBlip(), onBack())}
          aria-label="Back"
        >
          ‹
        </button>
        <b>Duel Pass</b>
        <span class="dp-chips">● {chipsOf(save)}</span>
      </div>

      <section class="dp-hero">
        <div class="dp-hero-rays" aria-hidden="true" />
        <div class="dp-medal" aria-label={`Tier ${tier}`}>
          <small>Tier</small>
          <b>{tier}</b>
        </div>
        <div class="dp-hero-txt">
          <small>Season · {passSeasonName()}</small>
          <b>
            {tier >= TIERS
              ? "Top tier reached!"
              : `Tier ${tier + 1} in ${need - have} XP`}
          </b>
          <i class="dp-bar big">
            <i style={{ transform: `scaleX(${have / need})` }} />
          </i>
          <span class="dp-hero-meta">
            <span>
              {frozen
                ? "⏸ Your phone's clock is behind: the pass waits"
                : `Today ${t.dayXp}/${DAY_CAP} XP`}
            </span>
            <span>
              {passDaysLeft()} day{passDaysLeft() === 1 ? "" : "s"} left
            </span>
          </span>
        </div>
      </section>

      <div class="dp-acts">
        {ready.length > 0 ? (
          <button class="dp-btn gold pulse" onClick={claim}>
            Claim {ready.length} reward{ready.length === 1 ? "" : "s"}
          </button>
        ) : (
          <span class="dp-acts-note">
            {tier >= TIERS
              ? "Every reward claimed. See you next season!"
              : "Win duels to climb: rewards wait at every tier."}
          </span>
        )}
        {t.prem ? (
          <span class="dp-lane-on">✦ Chips lane open</span>
        ) : (
          <button
            class="dp-btn prem"
            disabled={!!why && chipsOf(save) >= PREM_PRICE}
            onClick={() => (playBlip(), why ? setNote(why) : setBuying(true))}
          >
            ✦ Chips lane · ● {PREM_PRICE}
          </button>
        )}
      </div>
      {note && <p class="dp-note">{note}</p>}

      <div class="dp-road-wrap">
        <div class="dp-lanes" aria-hidden="true">
          <span>Free</span>
          <span class="prem">Chips</span>
        </div>
        <div class="dp-road" ref={road}>
          {ROAD.map((d) => {
            const reached = tier >= d.n;
            const cell = (lane: "free" | "prem", r: PassReward | null) => {
              if (!r)
                return (
                  <span class="dp-cell empty" aria-hidden="true">
                    ·
                  </span>
                );
              const claimed = (lane === "free" ? t.gotF : t.gotP).includes(d.n);
              const locked = lane === "prem" && !t.prem;
              const canClaim = reached && !claimed && !locked && d.n <= top;
              const own = !claimed && ownsReward(save, r, t.season);
              return (
                <button
                  class={`dp-cell ${lane} ${reached ? "reached" : ""} ${claimed ? "claimed" : ""} ${canClaim ? "ready" : ""} ${locked ? "locked" : ""} ${passOnly(r) ? "excl" : ""} r-${r.k}`}
                  onClick={() => (playBlip(), setLook({ tier: d.n, lane, r }))}
                  aria-label={`Tier ${d.n} ${lane === "free" ? "free" : "Chips lane"}: ${rewardName(r, t.season).name}${claimed ? ", claimed" : canClaim ? ", ready to claim" : ""}`}
                >
                  <RewardPic r={r} />
                  {claimed && <i class="dp-tick">✓</i>}
                  {locked && <i class="dp-lock">🔒</i>}
                  {own && !claimed && <i class="dp-own">owned</i>}
                </button>
              );
            };
            return (
              <div
                key={d.n}
                class={`dp-col ${d.big ? "big" : ""} ${reached ? "reached" : ""} ${tier + 1 === d.n ? "next" : ""}`}
                data-tier={d.n}
              >
                {cell("free", d.free)}
                <span class="dp-node">
                  <i class="dp-track" />
                  <b>{d.n}</b>
                </span>
                {cell("prem", d.prem)}
              </div>
            );
          })}
        </div>
      </div>

      <section class="dp-wear">
        <h3>Your look</h3>
        <div class="dp-me">
          <Framed frame={w.frame}>
            <Avatar p={profile} size="small" />
          </Framed>
          <NameBadge name={profile.alias} title={w.title} plate={w.plate} />
        </div>
        <p class="dp-wear-hint">
          Your title and name plate show on the duel's face-off, for your
          opponent too. Your frame shows round your picture on the menus.
        </p>
        <WearRow
          label="Title"
          none="No title"
          list={titles.map((id) => ({ id, name: titleName(id)! }))}
          on={w.title}
          onPick={(id) => wearIt("title", id)}
          total={String(TITLES.length + 2)}
        />
        <WearRow
          label="Name plate"
          none="Plain"
          list={plates.map((id) => ({
            id,
            name: PLATES.find((p) => p.id === id)!.name,
          }))}
          on={w.plate}
          onPick={(id) => wearIt("plate", id)}
          total={String(PLATES.length)}
        />
        <WearRow
          label="Avatar frame"
          none="No frame"
          list={frames.map((id) => ({
            id,
            name: FRAMES.find((f) => f.id === id)!.name,
          }))}
          on={w.frame}
          onPick={(id) => wearIt("frame", id)}
          total={String(FRAMES.length)}
        />
      </section>

      <section class="dp-how">
        <h3>How to earn Pass XP</h3>
        <p>{sumXp}.</p>
        <p>
          Up to {DAY_CAP} XP a day. Every {TIER_XP} XP is a tier. Ranked, the
          Millennium Road, the Labyrinth, Duel the Computer and Link Battles
          with your own deck all count. Practice, watching and "Anything goes"
          decks don't.
        </p>
        <p>
          A new season starts each month: rewards you reached but never claimed
          are handed over then. Everything here is just for looks: it never
          changes a duel.
        </p>
      </section>

      {look && (
        <RewardSheet
          pick={look}
          season={t.season}
          save={save}
          tier={tier}
          prem={t.prem}
          inUse={inUse(look.r)}
          onUse={() => useIt(look.r)}
          onClose={() => setLook(null)}
        />
      )}
      {buying && (
        <ConfirmSheet
          look="md"
          title="Open the Chips lane?"
          confirmLabel={`Spend ● ${PREM_PRICE}`}
          onConfirm={open}
          onCancel={() => setBuying(false)}
        >
          You have {chipsOf(save)} Duel Chips. The Chips lane adds a reward on
          every tier for {passSeasonName()}, including{" "}
          {
            ROAD.filter(
              (d) =>
                passOnly(d.prem) &&
                (d.prem.k === "sleeve" || d.prem.k === "mat"),
            ).length
          }{" "}
          pass-only sleeves and playmats.
          {tier > 0 ? ` Tiers 1 to ${tier} pay at once.` : ""}
        </ConfirmSheet>
      )}
      {got && (
        <ClaimCeremony
          got={got}
          season={t.season}
          onDone={() => setGot(null)}
        />
      )}
      {carried && (
        <ClaimCeremony
          got={carried}
          season={carried.length ? t.season : ""}
          onDone={() => setCarried(null)}
        />
      )}
    </div>
  );
}

function WearRow({
  label,
  none,
  list,
  on,
  onPick,
  total,
}: {
  label: string;
  none: string;
  list: { id: string; name: string }[];
  on: string | null;
  onPick: (id: string | null) => void;
  total: string;
}) {
  return (
    <div class="dp-wrow">
      <span class="dp-wrow-l">
        {label}{" "}
        <small>
          {list.length}/{total}
        </small>
      </span>
      <div class="dp-wrow-list">
        <button
          class={`dp-chip ${on === null ? "on" : ""}`}
          onClick={() => onPick(null)}
        >
          {none}
        </button>
        {list.map((x) => (
          <button
            key={x.id}
            class={`dp-chip ${on === x.id ? "on" : ""}`}
            onClick={() => onPick(x.id)}
          >
            {x.name}
          </button>
        ))}
        {list.length === 0 && (
          <span class="dp-wrow-none">Reach the pass's tiers to get some</span>
        )}
      </div>
    </div>
  );
}

function RewardSheet({
  pick,
  season,
  save,
  tier,
  prem,
  inUse,
  onUse,
  onClose,
}: {
  pick: Pick;
  season: string;
  save: SpeedSave;
  tier: number;
  prem: boolean;
  inUse: boolean;
  onUse: () => void;
  onClose: () => void;
}) {
  const n = rewardName(pick.r, season);
  const owns = ownsReward(save, pick.r, season);
  const state = owns
    ? inUse
      ? "★ Wearing it"
      : null
    : pick.lane === "prem" && !prem
      ? `🔒 Chips lane · tier ${pick.tier}`
      : tier >= pick.tier
        ? "Ready to claim at the top of the pass"
        : `Reach tier ${pick.tier}: ${(pick.tier * TIER_XP - shownTrack(save).xp).toLocaleString()} XP to go`;
  return (
    <div class="dp-sheet-back" onClick={onClose}>
      <div
        class={`dp-sheet ${pick.lane}`}
        role="dialog"
        aria-modal="true"
        aria-label={n.name}
        onClick={(ev) => ev.stopPropagation()}
      >
        <div class={`dp-sheet-pic r-${pick.r.k}`}>
          <RewardPic r={pick.r} />
        </div>
        <small class="dp-sheet-kind">
          Tier {pick.tier} · {pick.lane === "free" ? "Free" : "Chips lane"} ·{" "}
          {n.kind}
          {passOnly(pick.r) ? " · Duel Pass only" : ""}
        </small>
        <b class="dp-sheet-name">{n.name}</b>
        {pick.r.k === "plate" && (
          <NameBadge name="Your name" title={null} plate={pick.r.id} />
        )}
        {state && <span class="dp-sheet-state">{state}</span>}
        <div class="dp-sheet-acts">
          {owns && !inUse && (
            <button class="dp-btn gold" onClick={onUse}>
              {pick.r.k === "title" ||
              pick.r.k === "stitle" ||
              pick.r.k === "plate" ||
              pick.r.k === "frame"
                ? "Wear it"
                : "Use it"}
            </button>
          )}
          <button class="dp-btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
