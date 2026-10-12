import { useState } from 'preact/hooks';
import type { CardInst } from '../game/types';
import { cardById, cardImageUrl } from '../data/cards';

interface Props {
  card: CardInst;
  /** whether this viewer may see the face of a face-down card */
  canPeek?: boolean;
  size?: 'zone' | 'hand' | 'list' | 'big';
  selected?: boolean;
  flash?: boolean;
  dragging?: boolean;
  onClick?: () => void;
  onPointerDown?: (e: PointerEvent) => void;
}

/** Card art with a text fallback when the image is missing or fails to load. */
export function CardFace({ card, hidden }: { card: CardInst; hidden: boolean }) {
  const [broken, setBroken] = useState(false);
  const data = cardById(card.cardId);
  const img = hidden || broken ? null : cardImageUrl(card.cardId);
  if (hidden) return <div class="card-back" />;
  if (img) return <img src={img} alt={card.name} draggable={false} onError={() => setBroken(true)} />;
  return (
    <div class={`card-text frame-${data?.frame ?? 'token'}`}>
      <div class="card-text-name">{card.name}</div>
      {data?.atk !== undefined && (
        <div class="card-text-stats">
          {data.level !== undefined ? `★${data.level} ` : ''}
          {data.atk}/{data.def ?? '-'}
        </div>
      )}
      {!data && card.token && <div class="card-text-stats">Token</div>}
    </div>
  );
}

export function CardView({ card, canPeek = false, size = 'zone', selected, flash, dragging, onClick, onPointerDown }: Props) {
  const hidden = card.faceDown && !canPeek;
  const cls = [
    'card',
    `card-${size}`,
    card.defense ? 'defense' : '',
    card.faceDown ? 'facedown' : '',
    hidden ? 'hidden-face' : '',
    selected ? 'selected' : '',
    flash ? 'summon-flash' : '',
    dragging ? 'dragging' : '',
    card.token ? 'token' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div class={cls} data-iid={card.iid} onClick={onClick} onPointerDown={onPointerDown} role={onClick ? 'button' : undefined}>
      <CardFace card={card} hidden={hidden} />
      {card.faceDown && canPeek && <div class="peek-tag">SET</div>}
      {card.counters > 0 && <div class="counter-badge">{card.counters}</div>}
    </div>
  );
}
