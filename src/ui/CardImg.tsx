import { useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { card, imageUrl } from '../eds/db';
import type { Pid } from '../eds/types';
import { TIERS, meterOf, tierIndex } from '../level/leveling';
import { figUrl, useFigs } from '../level/figs';
import { profileXpOf, rarityFor } from '../level/view';
import { spellWord } from './gameUi';

/** The tier chip's text on a card (Glossy and Royal are Ultra Rares with a mark). */
const CHIP: Record<string, string> = { GL: 'UR✦', RO: 'UR♛' };
/** The Millennium Eye (Wedjat) on a Millennium card's plate. */
const EyeMark = () => (
  <svg class="ofx-eye" viewBox="0 0 100 64" aria-hidden="true">
    <defs>
      <linearGradient id="ofx-gold" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff6d8" />
        <stop offset="0.5" stop-color="#ffd56a" />
        <stop offset="1" stop-color="#a8740c" />
      </linearGradient>
    </defs>
    <g fill="none" stroke="url(#ofx-gold)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 13 Q50 -4 92 10" />
      <path d="M8 30 Q50 6 92 28 Q50 46 8 30 Z" />
      <path d="M40 41 L34 60" />
      <path d="M58 40 Q66 58 80 56 Q90 54 86 46" />
    </g>
    <circle cx="50" cy="27" r="9" fill="url(#ofx-gold)" />
  </svg>
);
const GLINTS = (
  <>
    <b class="lvr-spec" />
    <b class="lvr-glint g1" />
    <b class="lvr-glint g2" />
    <b class="lvr-glint g3" />
  </>
);

/** Card picture with a drawn fallback when the image is missing. `owner` picks whose rarity a duel card shows. */
// Memoized: a duel re-renders on every move, and an unchanged card needn't be diffed again.
export const CardImg = memo(CardImgView);

function CardImgView({ name, back = false, class: cls = '', owner, tier: forceTier }: { name: string; back?: boolean; class?: string; owner?: Pid; /** show this rarity tier (index into TIERS) instead of the owner's */ tier?: number }) {
  // Remember which card's picture failed, so the next card shown in the same spot still gets its picture.
  const [broken, setBroken] = useState<string | null>(null);
  // Card leveling (Speed Duel): a frame on the picture, and a foil layer where the card sits in a slot.
  const tier = TIERS[back ? 0 : (forceTier ?? rarityFor(name, owner))];
  const full = tier.id === 'OF' || tier.id === 'MI';
  useFigs(full);
  if (back) return <div class={`cimg cback ${cls}`} />;
  if (tier.id !== 'N') cls += ` lvr lvr-${tier.id}`;
  const fx = tier.id !== 'N' && (
    <i class={`lvr-fx lvr-fx-${tier.id}`} data-r={CHIP[tier.id] ?? tier.short}>
      {/* Glossy and Royal: twinkling glints on the clear coat */}
      {(tier.id === 'GL' || tier.id === 'RO') && GLINTS}
    </i>
  );
  const url = broken === name ? null : imageUrl(name);
  // Overframe and Millennium: full-art cards. The art fills the card, and the monster's own cut-out
  // (where it has one) steps out over the top of it, anywhere the card shows.
  if (url && full) {
    const mi = tier.id === 'MI';
    const info = card(name);
    const fig = figUrl(name);
    const mark = info?.kind === 'monster' ? (info.level ? '★'.repeat(Math.min(info.level, 12)) : '') : info?.kind === 'spell' ? spellWord().toUpperCase() : info?.kind === 'trap' ? 'TRAP' : '';
    const kind = !info ? '' : info.kind === 'monster' ? `${info.race ?? ''}${info.sub && info.sub !== 'Normal' ? ` / ${info.sub}` : ''}` : `${info.sub ?? ''} ${info.kind === 'spell' ? spellWord() : 'Trap'}`;
    // the name is sized to fit the card's width (long names shrink instead of being cut off)
    const vars = { '--ofimg': `url("${url}")`, '--ofname': `${Math.min(6.6, 92 / (name.length * 0.56)).toFixed(2)}cqw`, ...(fig ? { '--offig': `url("${fig}")` } : {}) } as Record<string, string>;
    return (
      <span class={`lvr-of ${mi ? 'lvr-mi' : ''} ${fig ? 'has-fig' : ''} ${cls.replace(/\blvr(-OF|-MI)?\b/g, '')}`} style={vars}>
        <i class="lvr-rays" />
        <i class="lvr-ofrim" />
        <img class={`cimg lvr lvr-${tier.id}`} src={url} alt={name} draggable={false} onError={() => setBroken(name)} />
        <i class="ofx-bg" />
        {mi && <i class="ofx-glyphs" />}
        <i class="ofx-art" />
        <i class="ofx-txt">
          <b>{kind}</b>
          <span>{info?.desc}</span>
          {info?.kind === 'monster' && (
            <em>
              ATK/{info.atk ?? '?'} DEF/{info.def ?? '?'}
            </em>
          )}
        </i>
        <i class="ofx-name">
          <b>{name}</b>
          {mark && <i>{mark}</i>}
        </i>
        {fx}
        <b class="lvr-spec of" />
        {fig && <b class="lvr-pop" />}
        <i class="lvr-spk s1" />
        <i class="lvr-spk s2" />
        <i class="lvr-spk s3" />
        <i class="lvr-chip">
          {mi && <EyeMark />}
          {mi ? 'MILLENNIUM' : 'OVERFRAME'}
        </i>
      </span>
    );
  }
  if (url)
    return (
      <>
        <img class={`cimg ${cls}`} src={url} alt={name} draggable={false} onError={() => setBroken(name)} />
        {fx}
      </>
    );
  const info = card(name);
  const kind = info?.kind ?? 'monster';
  const sub = info?.sub ?? 'Normal';
  return (
    <div class={`cimg ctext ${cls} k-${kind} s-${sub.toLowerCase().replace(/[^a-z]/g, '')}`}>
      <div class="ctext-name">{name}</div>
      {info?.atk !== undefined && (
        <div class="ctext-stats">
          {info.atk}/{info.def}
        </div>
      )}
      {fx}
    </div>
  );
}

/** Full card readout. */
export function CardInfoPanel({ name, owner }: { name: string; /** in a duel: whose copy (its finish shows) */ owner?: Pid }) {
  const info = card(name);
  return (
    <div class="cinfo">
      <span class="cinfo-pic">
        <CardImg name={name} class="cinfo-img" owner={owner} />
      </span>
      <div class="cinfo-text">
        <div class="cinfo-name">{name}</div>
        {info ? (
          <>
            <div class="cinfo-type">
              {info.sub === 'Skill' ? `Skill Card · ${info.character ?? ''}` : info.kind === 'monster' ? `${info.attribute ?? ''} · ${info.race ?? ''} · ${info.sub} · Level ${info.level ?? '?'}` : `${info.sub} ${info.kind === 'spell' ? spellWord() : 'Trap'} Card`}
            </div>
            {info.kind === 'monster' && (
              <div class="cinfo-stats">
                ATK/{info.atk} DEF/{info.def}
              </div>
            )}
            <LevelLine name={name} />
            <p class="cinfo-desc">{info.desc}</p>
            {info.n !== undefined && <div class="cinfo-num">No. {String(info.n).padStart(3, '0')}{info.password ? ` · Password ${info.password}` : ''}</div>}
          </>
        ) : (
          <p class="cinfo-desc">Card data not loaded yet.</p>
        )}
      </div>
    </div>
  );
}

/** Card leveling (Speed Duel screens only): this profile's rarity and meter for the card. */
function LevelLine({ name }: { name: string }) {
  const xp = profileXpOf(name);
  if (xp === null || card(name)?.sub === 'Skill') return null;
  const i = tierIndex(xp);
  const t = TIERS[i];
  const next = TIERS[i + 1];
  return (
    <div class={`cinfo-lv lv-t-${t.id}`}>
      <span class={`lv-chip lv-${t.id}`}>{t.id === 'GL' ? 'UR✦' : t.id === 'RO' ? 'UR♛' : t.short}</span> {t.name}
      <span class="lv-why"> · {next ? `${xp}/${next.at} to ${next.name}` : 'top rarity'}</span>
      <div class="lv-meter">
        <i style={{ width: `${Math.round(meterOf(xp) * 100)}%` }} />
      </div>
    </div>
  );
}
