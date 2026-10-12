import { useState } from 'preact/hooks';
import { card, imageUrl } from '../eds/db';
import type { Pid } from '../eds/types';
import { TIERS, meterOf, tierIndex } from '../level/leveling';
import { profileXpOf, rarityFor } from '../level/view';

/** Card picture with a drawn fallback when the image is missing. `owner` picks whose rarity a duel card shows. */
export function CardImg({ name, back = false, class: cls = '', owner }: { name: string; back?: boolean; class?: string; owner?: Pid }) {
  // Remember which card's picture failed, so the next card shown in the same spot still gets its picture.
  const [broken, setBroken] = useState<string | null>(null);
  if (back) return <div class={`cimg cback ${cls}`} />;
  // Card leveling (Speed Duel): a frame on the picture, and a foil layer where the card sits in a slot.
  const tier = TIERS[rarityFor(name, owner)];
  if (tier.id !== 'N') cls += ` lvr lvr-${tier.id}`;
  const fx = tier.id !== 'N' && <i class={`lvr-fx lvr-fx-${tier.id}`} data-r={tier.short} />;
  const url = broken === name ? null : imageUrl(name);
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
export function CardInfoPanel({ name }: { name: string }) {
  const info = card(name);
  return (
    <div class="cinfo">
      <CardImg name={name} class="cinfo-img" />
      <div class="cinfo-text">
        <div class="cinfo-name">{name}</div>
        {info ? (
          <>
            <div class="cinfo-type">
              {info.sub === 'Skill' ? `Skill Card · ${info.character ?? ''}` : info.kind === 'monster' ? `${info.attribute ?? ''} · ${info.race ?? ''} · ${info.sub} · Level ${info.level ?? '?'}` : `${info.sub} ${info.kind === 'spell' ? 'Magic' : 'Trap'} Card`}
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
