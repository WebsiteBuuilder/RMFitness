import { useState } from 'preact/hooks';
import { card, imageUrl } from '../eds/db';

/** Card picture with a drawn fallback when the image is missing. */
export function CardImg({ name, back = false, class: cls = '' }: { name: string; back?: boolean; class?: string }) {
  const [broken, setBroken] = useState(false);
  if (back) return <div class={`cimg cback ${cls}`} />;
  const url = broken ? null : imageUrl(name);
  if (url) return <img class={`cimg ${cls}`} src={url} alt={name} draggable={false} onError={() => setBroken(true)} />;
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
              {info.kind === 'monster' ? `${info.attribute ?? ''} · ${info.race ?? ''} · ${info.sub} · Level ${info.level ?? '?'}` : `${info.sub} ${info.kind === 'spell' ? 'Magic' : 'Trap'} Card`}
            </div>
            {info.kind === 'monster' && (
              <div class="cinfo-stats">
                ATK/{info.atk} DEF/{info.def}
              </div>
            )}
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
