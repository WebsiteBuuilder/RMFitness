// The Shadow Realm page in the Speed Duel menu: the cards this profile has sealed
// away, the computer duelists' cards they sealed, and who was sent there lately.
import type { SpeedSave } from '../eds/speedSave';
import { CardImg } from '../ui/CardImg';
import { Win } from '../ui/Window';
import { MAX_SEALED, OVERKILL_MARGIN, sealedCards, shadowLog, type SealedCard } from './shadow';

const when = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function ShadowRealmScreen({ save, onBack }: { save: SpeedSave; onBack: () => void }) {
  const mine = sealedCards(save);
  const theirs = Object.entries((save as SpeedSave & { cpuSealed?: Record<string, SealedCard[]> }).cpuSealed ?? {}).filter(([, l]) => l.length);
  const log = shadowLog();
  return (
    <div class="screen">
      <Win title="Shadow Realm" onClose={onBack}>
        <p class="hint">
          Finish a duel with {OVERKILL_MARGIN.toLocaleString()} or more damage past 0 and the loser is sent to the Shadow Realm. Their strongest monster is sealed there and sits out every duel until they win one. Up to {MAX_SEALED} cards can be sealed at once.
        </p>
        <h3 class="sr-h">Your sealed cards</h3>
        {mine.length === 0 ? (
          <p class="hint">None. Keep it that way.</p>
        ) : (
          <div class="sr-cards">
            {mine.map((s, i) => (
              <div class="sr-card" key={s.name}>
                <CardImg name={s.name} />
                <span>
                  <b>{s.name}</b>
                  <br />
                  sealed by {s.by} · {when(s.at)}
                  {i === 0 ? <em> · freed by your next win</em> : null}
                </span>
              </div>
            ))}
          </div>
        )}
        {theirs.length > 0 && (
          <>
            <h3 class="sr-h">Cards you sealed from the computer</h3>
            {theirs.map(([who, list]) => (
              <p key={who}>
                <b>{who}</b>: {list.map((s) => s.name).join(', ')}
              </p>
            ))}
          </>
        )}
        <h3 class="sr-h">Sent to the Shadow Realm</h3>
        {log.length === 0 ? (
          <p class="hint">Nobody yet.</p>
        ) : (
          <ul class="log sr-log">
            {log.slice(0, 20).map((e) => (
              <li key={e.at}>
                <span class="lt">{when(e.at)}</span> <b>{e.loser}</b> by {e.winner} (+{e.excess}){e.card ? ` · lost ${e.card}` : ''}
              </li>
            ))}
          </ul>
        )}
      </Win>
    </div>
  );
}
