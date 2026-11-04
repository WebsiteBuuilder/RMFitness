// The Playmats page: every mat, the one under your half, and getting the rest (Duel Chips, or
// earned through Ranked, Set Stamps, an Ace bond and Duel School). The big preview is a small
// field as it sits in a duel: your half on the mat with its zones, its trim and its motion, and
// the opponent's half beyond it.
import { useState, useRef } from 'preact/hooks';
import type { SpeedSave } from '../eds/speedSave';
import type { SoloSave } from '../eds/speedCampaign/save';
import { Win } from '../ui/Window';
import { ConfirmSheet } from '../ui/ConfirmSheet';
import { CardImg } from '../ui/CardImg';
import { chipsOf } from '../collection/economy';
import { playBlip, playWin } from '../ui/sound';
import { chosenSleeve } from '../sleeves/sleeves';
import { buyPlaymat, cantBuyPlaymat, chosenPlaymat, hasPlaymat, pickPlaymat, playmatClass, playmatCostNote, playmatCostShort, playmatDef, playmatProgress, PLAYMATS, type PlaymatId } from './playmats';
import { matUrl } from './art';
import '../mates/mates.css';
import '../sleeves/sleeves.css';
import './playmats.css';

/** A row of zones as the duel draws them (a monster row, or a back row with the Field Zone and the deck). */
function Row({ back, opp, sleeve }: { back: boolean; opp?: boolean; sleeve: ReturnType<typeof chosenSleeve> }) {
  const z = [
    back ? <span key="f" class="pmp-z field" /> : <span key="g" class="pmp-z gap" />,
    <span key="a" class="pmp-z" />,
    <span key="b" class="pmp-z" />,
    <span key="c" class="pmp-z" />,
    <span key="p" class="pmp-z pile">{back && <CardImg name="" back sleeve={opp ? 'vortex' : sleeve} />}</span>,
  ];
  // (the opponent sits across the table: their row runs the other way)
  return <div class="pmp-row">{opp ? z.reverse() : z}</div>;
}

export function PlaymatsScreen({ save, solo, onSave, onBack }: { save: SpeedSave; solo: SoloSave | null; onSave: (s: SpeedSave) => void; onBack: () => void }) {
  const current = chosenPlaymat(save, solo);
  const [look, setLook] = useState<PlaymatId>(current);
  const [buying, setBuying] = useState<PlaymatId | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [swap, setSwap] = useState(0);
  const top = useRef<HTMLDivElement>(null);
  const def = playmatDef(look)!;
  const owned = hasPlaymat(save, look, solo);
  const got = PLAYMATS.filter((m) => hasPlaymat(save, m.id, solo)).length;
  const sleeve = chosenSleeve(save, solo);

  const pick = (id: PlaymatId) => {
    playBlip();
    const r = top.current?.getBoundingClientRect();
    if (r && r.top < 0) top.current!.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setNote(null);
    setLook(id);
    setSwap((n) => n + 1);
  };
  const take = () => {
    const next = pickPlaymat(save, look, solo);
    if (!next) return;
    onSave(next);
    playBlip();
    setNote(`Your half of the field lies on ${def.name} now. Your opponent sees it in Link Battles too.`);
  };
  const buy = () => {
    const id = buying;
    setBuying(null);
    const next = id && buyPlaymat(save, id);
    if (!next) return;
    // (a bought mat goes down straight away)
    onSave(pickPlaymat(next, id, solo) ?? next);
    playWin();
    setNote(`${playmatDef(id)!.name} is yours, and your half of the field lies on it now.`);
  };
  const why = cantBuyPlaymat(save, look);
  const price = 'chips' in def.cost ? def.cost.chips : 0;
  const prog = owned ? null : playmatProgress(save, def, solo);
  const cls = playmatClass(look);
  const isAttr = /^[A-Z]+$/.test(def.name);

  return (
    <div class="screen sleeves playmats" ref={top}>
      <Win title="Playmats" onClose={onBack}>
        <div class="mt-chips">
          <b>● {chipsOf(save)} Duel Chips</b>
          <span>
            {got}/{PLAYMATS.length} playmats yours
          </span>
        </div>
        <div class="pmp-stage" style={{ '--pm-glow': def.glow } as Record<string, string>}>
          <div class="pmp-board" aria-hidden="true">
            <div key={swap} class="pmp-mat">
              <div class={`pm-half opp${cls}`}>
                <i class="pm-art" />
                <i class="pm-fx" />
                <i class="pm-trim" />
              </div>
              <div class={`pm-half me${cls}`}>
                <i class="pm-art" />
                <i class="pm-fx" />
                <i class="pm-trim" />
              </div>
              <div class={`pmp-rows${cls}`}>
                <Row back opp sleeve={sleeve} />
                <Row back={false} opp sleeve={sleeve} />
                <i class="pmp-mid" />
                <Row back={false} sleeve={sleeve} />
                <Row back sleeve={sleeve} />
              </div>
            </div>
          </div>
        </div>
        <div class="slv-info pmp-info">
          <b>{isAttr ? `${def.name} Attribute` : def.name}</b>
          <p>{def.blurb}</p>
          {look === current ? (
            <span class="mt-cost own">★ Under your cards</span>
          ) : owned ? (
            <button class="gbtn mt-go slv-go" onClick={take}>
              Use this playmat
            </button>
          ) : price ? (
            chipsOf(save) < price ? (
              <span class="slv-buy-wait">
                <button class="gbtn mt-go slv-go" disabled>
                  Get for ● {price}
                </button>
                <small>Win {price - chipsOf(save)} more Duel Chips in duels</small>
              </span>
            ) : (
              <button class="gbtn mt-go slv-go" disabled={!!why} onClick={() => (playBlip(), setBuying(look))}>
                Get for ● {price}
              </button>
            )
          ) : (
            <span class="slv-earn">
              <span class="slv-earn-t">🔒 {playmatCostNote(save, def, solo)}</span>
              {prog && (
                <i class="slv-bar" style={{ '--n': prog[1] } as Record<string, string | number>}>
                  <i style={{ width: `${Math.round((100 * prog[0]) / Math.max(1, prog[1]))}%` }} />
                </i>
              )}
            </span>
          )}
        </div>
        <div class="mt-act">
          {look === current && <span class="mt-hint">Your half of the field lies on this mat in Speed Duels. Your opponent's half lies on theirs.</span>}
          {note && <span class="mt-note">{note}</span>}
        </div>

        <div class="pmp-grid">
          {PLAYMATS.map((m) => {
            const has = hasPlaymat(save, m.id, solo);
            return (
              <button key={m.id} class={`slv-card pmp-card${look === m.id ? ' on' : ''}${m.id === current ? ' using' : ''}${has ? '' : ' locked'}`} aria-label={`${m.name}${has ? '' : ', locked'}`} onClick={() => pick(m.id)}>
                <span class="pmp-pic" style={{ backgroundImage: matUrl(m.id) }}>
                  {!has && <i class="slv-lock">🔒</i>}
                </span>
                <b>{m.name}</b>
                <small class={has ? 'own' : ''}>{m.id === current ? '★ Using' : has ? 'Yours' : playmatCostShort(m)}</small>
              </button>
            );
          })}
        </div>
        <p class="mt-foot">Playmats are just for looks: they never change a duel.</p>
      </Win>
      {buying && (
        <ConfirmSheet look="md" title={`Get ${playmatDef(buying)!.name}?`} confirmLabel={`Spend ${price} Duel Chips`} onConfirm={buy} onCancel={() => setBuying(null)}>
          You have {chipsOf(save)} Duel Chips. {playmatDef(buying)!.name} joins your playmats for good.
        </ConfirmSheet>
      )}
    </div>
  );
}
