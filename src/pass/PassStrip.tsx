// The Duel Pass strip on the result screen: the XP the duel earned, the bar filling, and a
// "TIER UP" burst for each tier it crossed. It only shows what finishDuel already saved.
import { useEffect, useRef, useState } from 'preact/hooks';
import { playStar } from '../ui/sound';
import { TIER_XP, TIERS, tierAt, tierProgress, type PassGain } from './pass';
import './pass.css';

export function PassStrip({ gain, delay }: { gain: PassGain; delay: number }) {
  const fromTier = tierAt(gain.from);
  const toTier = tierAt(gain.to);
  const [tier, setTier] = useState(fromTier);
  const [pct, setPct] = useState(() => (100 * tierProgress(gain.from)[0]) / TIER_XP);
  const [snap, setSnap] = useState(false);
  const [burst, setBurst] = useState(0);
  const t = useRef<number[]>([]);
  useEffect(() => {
    const at = (ms: number, fn: () => void) => t.current.push(window.setTimeout(fn, ms));
    let ms = delay;
    // one fill per tier crossed, then the last part
    for (let n = fromTier; n < toTier; n++) {
      at(ms, () => (setSnap(false), setPct(100)));
      ms += 520;
      at(ms, () => {
        setTier(n + 1);
        setBurst((b) => b + 1);
        playStar();
        setSnap(true);
        setPct(0);
      });
      ms += 280;
    }
    const end = toTier >= TIERS ? 100 : (100 * tierProgress(gain.to)[0]) / TIER_XP;
    at(ms, () => (setSnap(false), setPct(end)));
    return () => t.current.forEach(clearTimeout);
  }, []);
  const xp = gain.to - gain.from;
  return (
    <div class={`dp-strip ${burst ? 'up' : ''}`} aria-label={`Duel Pass: ${xp} XP, tier ${toTier}`}>
      <span class="dp-strip-tier" key={tier}>
        <small>Tier</small>
        <b>{tier}</b>
      </span>
      <span class="dp-strip-mid">
        <span class="dp-strip-top">
          <b>Duel Pass</b>
          <span>{xp > 0 ? `+${xp} XP` : 'Daily XP cap reached'}</span>
        </span>
        <i class="dp-bar">
          <i class={snap ? 'snap' : ''} style={{ transform: `scaleX(${pct / 100})` }} />
        </i>
        <span class="dp-strip-parts">
          {gain.parts.map((p) => `+${p.xp} ${p.label.replace('First win today', 'First win').replace('Duelist Request done', 'Request').replace(/Duelist Requests done/, 'Requests')}`).join(' · ')}
          {gain.capped && xp > 0 ? ' · daily cap reached' : ''}
        </span>
      </span>
      {burst > 0 && (
        <span class="dp-strip-burst" key={`b${burst}`}>
          TIER UP!
        </span>
      )}
    </div>
  );
}
