import type { CardInst } from '../game/types';
import { cardById, cardImageUrl } from '../data/cards';

interface Props {
  card: CardInst;
  /** whether this viewer may see the face of a face-down card */
  canPeek?: boolean;
  size?: 'zone' | 'hand' | 'list' | 'big';
  selected?: boolean;
  flash?: boolean;
  onClick?: () => void;
}

export function CardView({ card, canPeek = false, size = 'zone', selected, flash, onClick }: Props) {
  const hidden = card.faceDown && !canPeek;
  const data = cardById(card.cardId);
  const img = hidden ? null : cardImageUrl(card.cardId);
  const cls = [
    'card',
    `card-${size}`,
    card.defense ? 'defense' : '',
    card.faceDown ? 'facedown' : '',
    hidden ? 'hidden-face' : '',
    selected ? 'selected' : '',
    flash ? 'summon-flash' : '',
    card.token ? 'token' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div class={cls} onClick={onClick} role={onClick ? 'button' : undefined}>
      {hidden ? (
        <div class="card-back" />
      ) : img ? (
        <img src={img} alt={card.name} loading="lazy" draggable={false} />
      ) : (
        <div class="card-text">
          <div class="card-text-name">{card.name}</div>
          {data?.atk !== undefined && (
            <div class="card-text-stats">
              {data.level !== undefined ? `★${data.level} ` : ''}
              {data.atk}/{data.def ?? '-'}
            </div>
          )}
          {!data && card.token && <div class="card-text-stats">Token</div>}
        </div>
      )}
      {card.faceDown && canPeek && <div class="peek-tag">SET</div>}
      {card.counters > 0 && <div class="counter-badge">{card.counters}</div>}
    </div>
  );
}
