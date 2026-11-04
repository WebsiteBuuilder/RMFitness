// The Sleeves page: every card sleeve, the one your cards wear, and getting the rest (Duel Chips,
// or earned through Ranked, Set Stamps, an Ace bond and Duel School). The big preview shows the
// sleeve as it sits in a duel: on your deck, and on a card held up in your hand.
import { useRef, useState } from 'preact/hooks';
import type { SpeedSave } from '../eds/speedSave';
import type { SoloSave } from '../eds/speedCampaign/save';
import { Win } from '../ui/Window';
import { ConfirmSheet } from '../ui/ConfirmSheet';
import { CardImg } from '../ui/CardImg';
import { chipsOf } from '../collection/economy';
import { playBlip, playWin } from '../ui/sound';
import { buySleeve, cantBuySleeve, chosenSleeve, hasSleeve, pickSleeve, sleeveCostNote, sleeveCostShort, sleeveDef, SLEEVES, type SleeveId } from './sleeves';
import '../mates/mates.css';
import './sleeves.css';

export function SleevesScreen({ save, solo, onSave, onBack }: { save: SpeedSave; solo: SoloSave | null; onSave: (s: SpeedSave) => void; onBack: () => void }) {
  const current = chosenSleeve(save, solo);
  const [look, setLook] = useState<SleeveId>(current);
  const [buying, setBuying] = useState<SleeveId | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [flip, setFlip] = useState(0);
  const top = useRef<HTMLDivElement>(null);
  const def = sleeveDef(look)!;
  const owned = hasSleeve(save, look, solo);
  const got = SLEEVES.filter((s) => hasSleeve(save, s.id, solo)).length;

  const pick = (id: SleeveId) => {
    playBlip();
    const r = top.current?.getBoundingClientRect();
    if (r && r.top < 0) top.current!.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setNote(null);
    setLook(id);
    setFlip((n) => n + 1);
  };
  const take = () => {
    const next = pickSleeve(save, look, solo);
    if (!next) return;
    onSave(next);
    playBlip();
    setFlip((n) => n + 1);
    setNote(`Your cards wear ${def.name} now. Your opponent sees it in Link Battles too.`);
  };
  const buy = () => {
    const id = buying;
    setBuying(null);
    const next = id && buySleeve(save, id);
    if (!next) return;
    // (a bought sleeve goes on straight away)
    onSave(pickSleeve(next, id, solo) ?? next);
    playWin();
    setFlip((n) => n + 1);
    setNote(`${sleeveDef(id)!.name} is yours, and your cards wear it now.`);
  };
  const why = cantBuySleeve(save, look);
  const price = 'chips' in def.cost ? def.cost.chips : 0;

  return (
    <div class="screen sleeves" ref={top}>
      <Win title="Sleeves" onClose={onBack}>
        <div class="mt-chips">
          <b>● {chipsOf(save)} Duel Chips</b>
          <span>
            {got}/{SLEEVES.length} sleeves yours
          </span>
        </div>
        <div class="slv-stage" style={{ '--sleeve-glow': def.glow } as Record<string, string>}>
          <div class="slv-show" aria-hidden="true">
            <i class="slv-floor" />
            <div class="slv-deck">
              <CardImg name="" back sleeve={look} class="slv-d3" />
              <CardImg name="" back sleeve={look} class="slv-d2" />
              <CardImg name="" back sleeve={look} class="slv-d1" shine />
            </div>
            <div key={flip} class="slv-held">
              <CardImg name="" back sleeve={look} shine />
            </div>
          </div>
          <div class="slv-info">
            <b>{def.name}</b>
            <p>{def.blurb}</p>
            <span class={`mt-cost ${owned ? 'own' : ''}`}>{look === current ? '★ On your cards' : owned ? 'Yours' : price ? `● ${price} Duel Chips` : '🔒 Earned'}</span>
          </div>
        </div>
        <div class="mt-act">
          {look === current ? (
            <span class="mt-hint">Your deck, your hand as your opponent sees it, and your Set cards all wear this sleeve.</span>
          ) : owned ? (
            <button class="gbtn mt-go" onClick={take}>
              Use {def.name}
            </button>
          ) : price ? (
            why && chipsOf(save) < price ? (
              <span class="mt-need">🔒 Costs {price} Duel Chips · you need {price - chipsOf(save)} more</span>
            ) : (
              <button class="gbtn mt-go" disabled={!!why} onClick={() => (playBlip(), setBuying(look))}>
                Get for {price} Duel Chips
              </button>
            )
          ) : (
            <span class="mt-hint">🔒 {sleeveCostNote(save, def, solo)} to unlock.</span>
          )}
          {note && <span class="mt-note">{note}</span>}
        </div>

        <div class="slv-grid">
          {SLEEVES.map((s) => {
            const has = hasSleeve(save, s.id, solo);
            return (
              <button key={s.id} class={`slv-card ${look === s.id ? 'on' : ''} ${has ? '' : 'locked'}`} aria-label={`${s.name}${has ? '' : ', locked'}`} onClick={() => pick(s.id)}>
                <span class="slv-pic">
                  <CardImg name="" back sleeve={s.id} />
                  {!has && <i class="slv-lock">🔒</i>}
                </span>
                <b>{s.name}</b>
                <small class={has ? 'own' : ''}>{s.id === current ? '★ Using' : has ? 'Yours' : sleeveCostShort(s)}</small>
              </button>
            );
          })}
        </div>
        <p class="mt-foot">Sleeves are just for looks: they never change a duel.</p>
      </Win>
      {buying && (
        <ConfirmSheet look="md" title={`Get ${sleeveDef(buying)!.name}?`} confirmLabel={`Spend ${price} Duel Chips`} onConfirm={buy} onCancel={() => setBuying(null)}>
          You have {chipsOf(save)} Duel Chips. {sleeveDef(buying)!.name} joins your sleeves for good.
        </ConfirmSheet>
      )}
    </div>
  );
}
