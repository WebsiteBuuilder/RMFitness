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
import { buySleeve, cantBuySleeve, chosenSleeve, hasSleeve, pickSleeve, sleeveCostNote, sleeveCostShort, sleeveDef, sleeveProgress, SLEEVES, type SleeveId } from './sleeves';
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
  const prog = owned ? null : sleeveProgress(save, def, solo);
  // Drag over the preview: the held card tilts toward the finger and its sheen slides (no re-render).
  const held = useRef<HTMLDivElement>(null);
  const tilt = (ev: PointerEvent) => {
    const el = held.current;
    const box = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    if (!el || !box.width) return;
    const x = Math.max(-1, Math.min(1, ((ev.clientX - box.left) / box.width) * 2 - 1));
    const y = Math.max(-1, Math.min(1, ((ev.clientY - box.top) / box.height) * 2 - 1));
    el.style.setProperty('--tx', x.toFixed(3));
    el.style.setProperty('--ty', y.toFixed(3));
    el.classList.add('live');
  };
  const untilt = () => held.current?.classList.remove('live');

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
          <div class="slv-show" aria-hidden="true" onPointerMove={tilt} onPointerLeave={untilt} onPointerUp={untilt} onPointerCancel={untilt}>
            <i class="slv-floor" />
            <div class="slv-deck">
              <CardImg name="" back sleeve={look} class="slv-d3" />
              <CardImg name="" back sleeve={look} class="slv-d2" />
              <CardImg name="" back sleeve={look} class="slv-d1" shine />
            </div>
            <div key={flip} class="slv-held">
              <div class="slv-tilt" ref={held}>
                <CardImg name="" back sleeve={look} />
                <i class="slv-sheen" />
              </div>
            </div>
          </div>
          <div class="slv-info">
            <b>{def.name}</b>
            <p>{def.blurb}</p>
            {look === current ? (
              <span class="mt-cost own">★ On your cards</span>
            ) : owned ? (
              <button class="gbtn mt-go slv-go" onClick={take}>
                Use this sleeve
              </button>
            ) : price ? (
              chipsOf(save) < price ? (
                <span class="mt-need">🔒 {price} Duel Chips · {price - chipsOf(save)} more to go</span>
              ) : (
                <button class="gbtn mt-go slv-go" disabled={!!why} onClick={() => (playBlip(), setBuying(look))}>
                  Get for ● {price}
                </button>
              )
            ) : (
              <span class="slv-earn">
                <span class="slv-earn-t">🔒 {sleeveCostNote(save, def, solo)}</span>
                {prog && (
                  <i class="slv-bar">
                    <i style={{ width: `${Math.round((100 * prog[0]) / Math.max(1, prog[1]))}%` }} />
                  </i>
                )}
              </span>
            )}
          </div>
        </div>
        <div class="mt-act">
          {look === current && <span class="mt-hint">Your deck, your Set cards and your hand as your opponent sees it all wear this sleeve.</span>}
          {note && <span class="mt-note">{note}</span>}
        </div>

        <div class="slv-grid">
          {SLEEVES.map((s) => {
            const has = hasSleeve(save, s.id, solo);
            return (
              <button key={s.id} class={`slv-card${look === s.id ? ' on' : ''}${s.id === current ? ' using' : ''}${has ? '' : ' locked'}`} aria-label={`${s.name}${has ? '' : ', locked'}`} onClick={() => pick(s.id)}>
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
