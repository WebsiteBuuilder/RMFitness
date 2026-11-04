// The Duel Pass moment after a duel: a tier crossed gets the full-screen "TIER UP" (the tier
// medallion slams in, the rewards it reached fan out, claim them on the spot); XP without a new
// tier gets a short banner at the top that slides away by itself.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SpeedSave } from '../eds/speedSave';
import { buzz, playFanfare, playStar } from '../ui/sound';
import { claimAll, passSeasonName, ROAD, shownTrack, TIER_XP, TIERS, tierAt, tierProgress, type Claimed, type PassGain } from './pass';
import { ClaimCeremony, RewardPic, setPassWho } from './ui';
import './pass.css';

export function PassFlash({ gain, save, who, onSave, onClose, onOpen }: { gain: PassGain; save: SpeedSave; /** the duelist's name, for the plate previews */ who?: string; onSave: (s: SpeedSave) => void; onClose: () => void; /** opens the pass (only where it can be opened from) */ onOpen?: () => void }) {
  setPassWho(who);
  const from = tierAt(gain.from);
  const to = tierAt(gain.to);
  if (to > from) return <TierUp gain={gain} save={save} onSave={onSave} onClose={onClose} onOpen={onOpen} />;
  return <XpToast gain={gain} onClose={onClose} onOpen={onOpen} />;
}

function XpToast({ gain, onClose, onOpen }: { gain: PassGain; onClose: () => void; onOpen?: () => void }) {
  const [out, setOut] = useState(false);
  const [fill, setFill] = useState(false);
  useEffect(() => {
    const a = window.setTimeout(() => setFill(true), 250);
    const b = window.setTimeout(() => setOut(true), 3000);
    const c = window.setTimeout(onClose, 3400);
    return () => (clearTimeout(a), clearTimeout(b), clearTimeout(c));
  }, []);
  const xp = gain.to - gain.from;
  const [have] = tierProgress(fill ? gain.to : gain.from);
  const tier = tierAt(gain.to);
  return (
    <button class={`dp-toast ${out ? 'out' : ''}`} onClick={() => (onOpen ? (onClose(), onOpen()) : onClose())}>
      <span class="dp-toast-tier">
        <small>Tier</small>
        <b>{tier}</b>
      </span>
      <span class="dp-toast-mid">
        <b>Duel Pass {xp > 0 ? `+${xp} XP` : '· daily cap reached'}</b>
        <i class="dp-bar">
          <i style={{ transform: `scaleX(${tier >= TIERS ? 1 : have / TIER_XP})` }} />
        </i>
        <small>{tier >= TIERS ? 'Top tier reached!' : `${TIER_XP - have} XP to tier ${tier + 1}`}</small>
      </span>
    </button>
  );
}

function TierUp({ gain, save, onSave, onClose, onOpen }: { gain: PassGain; save: SpeedSave; onSave: (s: SpeedSave) => void; onClose: () => void; onOpen?: () => void }) {
  const from = tierAt(gain.from);
  const to = tierAt(gain.to);
  const [stage, setStage] = useState(0);
  const [got, setGot] = useState<Claimed[] | null>(null);
  const prem = shownTrack(save).prem;
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    playFanfare();
    buzz([40, 60, 120]);
    const a = window.setTimeout(() => setStage(1), 700);
    const b = window.setTimeout(() => (setStage(2), playStar()), 1300);
    return () => (clearTimeout(a), clearTimeout(b));
  }, []);
  useEffect(() => {
    if (stage === 2) btn.current?.focus({ preventScroll: true });
  }, [stage]);
  // what the tiers just crossed hold
  const reached = ROAD.slice(from, to).flatMap((t) => [...(t.free ? [{ t: t.n, lane: 'free' as const, r: t.free }] : []), { t: t.n, lane: 'prem' as const, r: t.prem }]);
  const shown = reached.slice(0, 6);
  const claim = () => {
    const r = claimAll(save);
    if (!r) return onClose();
    onSave(r.save);
    setGot(r.got);
  };
  if (got) return <ClaimCeremony got={got} season={gain.season} onDone={onClose} />;
  const multi = to - from > 1;
  return (
    <div class={`dp-up s${stage}`} role="dialog" aria-modal="true" aria-label={`Duel Pass tier ${to} reached`} onClick={() => stage < 2 && setStage(2)}>
      <div class="dp-up-rays" aria-hidden="true" />
      <div class="dp-up-flash" aria-hidden="true" />
      <div class="dp-up-hero">
        <div class="dp-up-glow" aria-hidden="true" />
        <div class="dp-up-ring" aria-hidden="true" />
        <div class="dp-up-ring r2" aria-hidden="true" />
        <div class="dp-up-medal">
          <small>Tier</small>
          <b>{to}</b>
        </div>
      </div>
      <h2 class="dp-up-title" data-text={multi ? `+${to - from} TIERS` : 'TIER UP!'}>
        {multi ? `+${to - from} TIERS` : 'TIER UP!'}
      </h2>
      <p class="dp-up-sub">Duel Pass · {passSeasonName()}</p>
      <div class="dp-up-row">
        {shown.map((x, i) => (
          <span key={`${x.lane}${x.t}`} class={`dp-up-it ${x.lane} ${x.lane === 'prem' && !prem ? 'locked' : ''}`} style={{ '--i': i } as Record<string, number>}>
            <RewardPic r={x.r} />
            {x.lane === 'prem' && !prem && <i class="dp-lock">🔒</i>}
          </span>
        ))}
        {reached.length > shown.length && <span class="dp-up-more">+{reached.length - shown.length}</span>}
      </div>
      <div class="dp-up-foot">
        <button ref={btn} class="dp-btn gold" onClick={(ev) => (ev.stopPropagation(), claim())}>
          Claim rewards
        </button>
        <button class="dp-btn ghost" onClick={(ev) => (ev.stopPropagation(), onOpen ? (onClose(), onOpen()) : onClose())}>
          {onOpen ? 'See the pass' : 'Later'}
        </button>
        {!prem && <small class="dp-up-note">🔒 Chips lane rewards wait for you: open it on the pass and claim them back to tier 1.</small>}
      </div>
    </div>
  );
}
