// The two card-earning screens on the Speed Duel menu: Duelist Requests (three characters'
// asks for today) and Set Stamps (a stamp card for every real booster set).
import { useState } from 'preact/hooks';
import type { SpeedSave } from '../eds/speedSave';
import { CardImg, CardInfoPanel } from '../ui/CardImg';
import { Overlay, Win } from '../ui/Window';
import { playBlip, playWin } from '../ui/sound';
import { boardOf, giverByName, requestText, rewardPool, swapRequest, PER_DAY } from './requests';
import { STAMPS, STAMP_TEXT, claimStamp, stampCards, stampOffer, topCard, type StampCard } from './stamps';
import { shortSetName } from './sets';
import './earn.css';

export function RequestsScreen({ save, onSave, onBack }: { save: SpeedSave; onSave: (s: SpeedSave) => void; onBack: () => void }) {
  const [look, setLook] = useState<string | null>(null);
  const b = boardOf(save);
  const done = b ? b.list.filter((r) => r.done).length : 0;
  return (
    <div class="screen earn">
      <Win title="Duelist Requests" onClose={onBack}>
        <p class="hint">
          Three duelists ask for something every day. Do it in the Millennium Road, the Labyrinth, Duel the Computer or against your brother (with a collection deck) and they give you a card from their deck you don't own yet. All {PER_DAY} done: a booster pack too. New requests every day, the same for everyone, so you can race your brother.
        </p>
        {!b && <div class="warn">Your phone's clock reads earlier than the last day you played. Requests come back once the real date catches up.</div>}
        {b && (
          <>
            <div class="req-sum">
              {done}/{PER_DAY} done today{b.bonus ? ' · bonus pack paid ✓' : ' · finish all 3 for a bonus pack'}
            </div>
            {b.list.map((r, i) => {
              const g = giverByName(r.giver);
              const pct = Math.round((100 * r.have) / r.need);
              const canSwap = !b.swapped && !r.done && r.have === 0;
              return (
                <div key={`${r.giver}-${r.kind}`} class={`req ${r.done ? 'done' : ''}`}>
                  <button class="req-face" onClick={() => g && setLook(r.reward ?? g.face)} aria-label={`${r.giver}'s card`}>
                    <CardImg name={r.reward ?? g?.face ?? ''} />
                  </button>
                  <div class="req-body">
                    <b>{r.giver}</b>
                    {g && <span class="req-title">{g.title}</span>}
                    <span class="req-text">{requestText(r)}</span>
                    <span class="req-bar" aria-hidden="true">
                      <i style={{ width: `${pct}%` }} />
                    </span>
                    <span class="req-prog">
                      {r.done ? (r.reward ? `Done: you got ${r.reward}` : 'Done: you got a booster pack') : r.need > 1 ? `${r.have}/${r.need}` : 'Not done yet'}
                      {!r.done && g ? ` · pays 1 of ${rewardPool(g).length} cards from ${r.giver.split(' ')[0]}'s deck` : ''}
                    </span>
                    {canSwap && (
                      <button
                        class="chip req-swap"
                        onClick={() => {
                          const next = swapRequest(save, i);
                          if (next) (playBlip(), onSave(next));
                        }}
                      >
                        Ask someone else (once a day)
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </Win>
      {look && (
        <Overlay onClose={() => setLook(null)}>
          <Win title={look} onClose={() => setLook(null)}>
            <CardInfoPanel name={look} />
          </Win>
        </Overlay>
      )}
    </div>
  );
}

export function StampsScreen({ save, onSave, onBack }: { save: SpeedSave; onSave: (s: SpeedSave) => void; onBack: () => void }) {
  const [picking, setPicking] = useState<StampCard | null>(null);
  const [got, setGot] = useState<{ line: string; cards: string[] } | null>(null);
  const cards = stampCards(save);
  const claim = (c: StampCard, pick?: string) => {
    const r = claimStamp(save, c.set.code, pick);
    if (!r) return;
    playWin();
    onSave(r.save);
    setPicking(null);
    setGot({ line: r.line, cards: r.cards });
  };
  /** Every stamp that needs no choice, in one tap (the pick-a-card stamps wait for their pick). */
  const claimAll = () => {
    let s = save;
    const lines: string[] = [];
    const won: string[] = [];
    for (const c of cards)
      for (let r = claimStamp(s, c.set.code); r; r = claimStamp(s, c.set.code)) {
        s = r.save;
        lines.push(r.line);
        won.push(...r.cards);
      }
    if (!lines.length) return;
    playWin();
    onSave(s);
    setGot({ line: lines.length === 1 ? lines[0] : `${lines.length} stamps claimed. ${lines.join('. ')}.`, cards: won });
  };
  const quick = cards.filter((c) => c.reached > c.claimed && Math.min(c.claimed, STAMPS - 1) !== 1).length;
  return (
    <div class="screen earn">
      <Win title="Set Stamps" onClose={onBack}>
        <p class="hint">Every Speed Duel booster set has a stamp card. Own a third of its cards for a pack, two thirds to pick 1 of 3 cards you're missing, and the whole set to get its top card at Overframe plus 2 Duel Chips. Each stamp pays once.</p>
        {quick > 1 && (
          <button class="gbtn stamp-all" onClick={claimAll}>
            Claim all ({quick} sets)
          </button>
        )}
        <div class="stamp-list">
          {cards.map((c) => {
            const ready = c.reached > c.claimed;
            const next = Math.min(c.claimed, STAMPS - 1);
            const top = topCard(c.set);
            return (
              <div key={c.set.code} class={`stamp ${ready ? 'ready' : ''} ${c.claimed >= STAMPS ? 'full' : ''}`}>
                <div class="stamp-top">
                  {top && (
                    <span class="stamp-card">
                      <CardImg name={top} />
                    </span>
                  )}
                  <div>
                    <b>{shortSetName(c.set.name)}</b>
                    <span class="stamp-count">
                      {c.have}/{c.total} cards
                    </span>
                    <span class="stamp-marks" aria-label={`${c.claimed} of ${STAMPS} stamps`}>
                      {c.marks.map((m, i) => (
                        <i key={i} class={i < c.claimed ? 'on' : i < c.reached ? 'due' : ''} title={`${m} cards: ${STAMP_TEXT[i]}`}>
                          {i < c.claimed ? '★' : m}
                        </i>
                      ))}
                    </span>
                  </div>
                </div>
                {c.claimed >= STAMPS ? (
                  <span class="stamp-next">Complete!</span>
                ) : ready ? (
                  <button class="gbtn stamp-claim" onClick={() => (next === 1 ? (playBlip(), setPicking(c)) : claim(c))}>
                    Claim: {STAMP_TEXT[next]}
                  </button>
                ) : (
                  <span class="stamp-next">
                    {c.marks[next] - c.have} more for {STAMP_TEXT[next]}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </Win>
      {picking && (
        <Overlay onClose={() => setPicking(null)}>
          <Win title={`${shortSetName(picking.set.name)}: pick one`} onClose={() => setPicking(null)}>
            <p class="hint">Tap the card you want. The other two stay in the set for packs.</p>
            <div class="stamp-pick">
              {stampOffer(save, picking.set).map((n) => (
                <button key={n} class="stamp-opt" onClick={() => claim(picking, n)}>
                  <CardImg name={n} />
                  <span>{n}</span>
                </button>
              ))}
            </div>
            {stampOffer(save, picking.set).length === 0 && (
              <button class="gbtn" onClick={() => claim(picking)}>
                Take a Duel Chip
              </button>
            )}
          </Win>
        </Overlay>
      )}
      {got && (
        <Overlay onClose={() => setGot(null)}>
          <Win title="Stamp claimed" onClose={() => setGot(null)}>
            {got.cards.length > 0 && (
              <div class="stamp-pick">
                {got.cards.map((n) => (
                  <span key={n} class="stamp-opt">
                    <CardImg name={n} />
                  </span>
                ))}
              </div>
            )}
            <p>{got.line}</p>
            <button class="gbtn" onClick={() => setGot(null)}>
              OK
            </button>
          </Win>
        </Overlay>
      )}
    </div>
  );
}
