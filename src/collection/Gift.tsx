// The one-time present (see GIFT in economy.ts): a wrapped box drops in, a tap tears it
// open, confetti flies and the gift packs count up before heading to the Card Shop.
import { useEffect, useState } from 'preact/hooks';
import { CardImg } from '../ui/CardImg';
import { buzz, playFanfare, playStar, playSummon } from '../ui/sound';
import { boosterSets } from './sets';
import { card } from '../eds/db';
import type { GIFT } from './economy';
import './gift.css';

const COLORS = ['#f2c14e', '#ff5d8f', '#4fd1ff', '#7cf29a', '#b78cff', '#ffffff'];
const BITS = Array.from({ length: 44 }, (_, i) => ({
  left: (i * 37) % 100,
  delay: (i % 11) * 0.09,
  dur: 1.6 + ((i * 7) % 10) / 10,
  rot: (i * 53) % 360,
  color: COLORS[i % COLORS.length],
}));

/** five showpiece cards for the fan of packs: the rarest monster of five different sets */
const fanCards = () => {
  const sets = boosterSets();
  const out: string[] = [];
  for (const i of [0, 3, 6, 9, 12, 1, 4, 7, 10, 2, 5, 8, 11]) {
    const top = sets[i % sets.length]?.cards.find(([n, r]) => (r === 'Secret Rare' || r === 'Ultra Rare') && card(n)?.kind === 'monster' && !out.includes(n));
    if (top && out.length < 5) out.push(top[0]);
  }
  return out;
};

export function GiftReveal({ gift, onOpen, onLater }: { gift: typeof GIFT; onOpen: () => void; onLater: () => void }) {
  const [torn, setTorn] = useState(false);
  const [count, setCount] = useState(0);
  const tear = () => {
    if (torn) return;
    setTorn(true);
    playSummon();
    buzz([60, 40, 120]);
    window.setTimeout(playFanfare, 250);
  };
  // The pack count rolls up to the gift in about a second.
  useEffect(() => {
    if (!torn) return;
    const start = Date.now();
    const t = window.setInterval(() => {
      const k = Math.min(1, (Date.now() - start) / 1100);
      const n = Math.round(gift.packs * (1 - (1 - k) ** 3));
      setCount(n);
      if (n % 25 === 0 && n) playStar();
      if (k >= 1) window.clearInterval(t);
    }, 40);
    return () => window.clearInterval(t);
  }, [torn]);
  return (
    <div class={`gift-reveal ${torn ? 'torn' : ''}`} role="dialog" aria-label={gift.title}>
      {torn && (
        <div class="confetti" aria-hidden="true">
          {BITS.map((b, i) => (
            <i
              key={i}
              style={{
                left: `${b.left}%`,
                background: b.color,
                animationDelay: `${b.delay}s`,
                animationDuration: `${b.dur}s`,
                transform: `rotate(${b.rot}deg)`,
              }}
            />
          ))}
        </div>
      )}
      <div class="gift-card">
        <p class="gift-kicker">🎉 {gift.title}</p>
        {!torn ? (
          <>
            <h2>A present for you</h2>
            <p class="gift-sub">To celebrate online matchmaking, every duelist gets a surprise.</p>
            <button class="gift-wrap" onClick={tear} aria-label="Open the present">
              <span class="gift-lid" />
              <span class="gift-body" />
              <span class="gift-ribbon" />
            </button>
            <p class="gift-tap">Tap the present to open it</p>
          </>
        ) : (
          <>
            <div class="gift-fan" aria-hidden="true">
              {fanCards().map((n, i) => (
                <span key={n} class="gift-pack" style={{ ['--i' as string]: i - 2 }}>
                  <CardImg name={n} />
                  <b>SPEED DUEL</b>
                </span>
              ))}
            </div>
            <p class="gift-count">
              <b>{count}</b> packs
            </p>
            <p class="gift-sub">Any set, even locked ones. Any rarity can drop, Overframe included. Open them with your brother and hit Random deck after.</p>
            <button class="gbtn gift-go" onClick={onOpen}>
              Open packs now
            </button>
            <button class="gbtn gift-later" onClick={onLater}>
              Later
            </button>
          </>
        )}
      </div>
    </div>
  );
}
