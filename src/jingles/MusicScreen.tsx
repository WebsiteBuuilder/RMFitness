// The Duel Music page: your entrance jingle (heard by both duelists as a duel begins) and the
// soundtrack's theme (one always, taking turns, or picked by the moment). Every jingle and theme
// can be heard here first.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { SpeedSave } from '../eds/speedSave';
import type { SoloSave } from '../eds/speedCampaign/save';
import { Win } from '../ui/Window';
import { ConfirmSheet } from '../ui/ConfirmSheet';
import { chipsOf } from '../collection/economy';
import { playBlip, playWin, rawAudioContext, setMusicEnabled, unlockAudio, useMusicEnabled } from '../ui/sound';
import { DuelMusic, setMusicThemePref, THEME_PREFS, themeDef, useMusicThemePref, type ThemeId, type ThemePref } from '../ui/music';
import { buyJingle, cantBuyJingle, chosenJingle, hasJingle, jingleCostNote, jingleCostShort, jingleDef, JINGLES, pickJingle, type JingleId } from './jingles';
import { performJingle } from './play';
import '../mates/mates.css';
import './jingles.css';

/**
 * One thing playing at a time on this page: a jingle or a theme's preview. Every new tap (and
 * leaving the page) bumps `ticket`, so a preview still waiting for the audio to wake up never
 * starts late, and the one before it is always stopped.
 */
let stopPreview: (() => void) | null = null;
let ticket = 0;
function stopAll() {
  ticket++;
  const s = stopPreview;
  stopPreview = null;
  s?.();
}

/** Plays a jingle's preview; `onStart` gets its length once it really sounds. */
function previewJingle(id: JingleId, onStart: (secs: number) => void) {
  stopAll();
  const mine = ticket;
  unlockAudio();
  const ctx = rawAudioContext();
  if (!ctx) return;
  const go = () => {
    if (mine !== ticket) return;
    const h = performJingle(id, 0, ctx);
    if (!h) return;
    stopPreview = h.stop;
    onStart(h.len);
  };
  // (the first tap on a phone may still be waking the audio up)
  if (ctx.state === 'running') go();
  else ctx.resume().then(go, () => {});
}

function previewTheme(id: ThemeId, onEnd: () => void) {
  stopAll();
  const mine = ticket;
  unlockAudio();
  const ctx = rawAudioContext();
  if (!ctx) return onEnd();
  const start = () => {
    if (mine !== ticket) return; // another tap (or leaving) came first
    const m = new DuelMusic(ctx, Date.now(), themeDef(id));
    m.setMood({ level: 1, myTurn: true });
    const tick = setInterval(() => m.pump(), 60);
    m.pump();
    const stop = () => {
      clearInterval(tick);
      clearTimeout(done);
      m.stop();
      if (stopPreview === stop) stopPreview = null;
      onEnd();
    };
    const done = setTimeout(stop, 9000);
    stopPreview = stop;
  };
  if (ctx.state === 'running') start();
  else ctx.resume().then(start, () => mine === ticket && onEnd());
}

export function MusicScreen({ save, solo, onSave, onBack }: { save: SpeedSave; solo: SoloSave | null; onSave: (s: SpeedSave) => void; onBack: () => void }) {
  const current = chosenJingle(save, solo);
  const [look, setLook] = useState<JingleId>(current);
  const [playing, setPlaying] = useState<string | null>(null);
  const [buying, setBuying] = useState<JingleId | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const musicOn = useMusicEnabled();
  const pref = useMusicThemePref();
  const playTimer = useRef(0);
  const top = useRef<HTMLDivElement>(null);
  const def = jingleDef(look)!;
  const owned = hasJingle(save, look, solo);
  const got = JINGLES.filter((j) => hasJingle(save, j.id, solo)).length;
  useEffect(() => () => (stopAll(), clearTimeout(playTimer.current)), []);
  // open at the top (the menu below may have been scrolled down to reach the tile)
  useLayoutEffect(() => {
    for (let el = top.current?.parentElement; el; el = el.parentElement) if (el.scrollTop) el.scrollTop = 0;
    top.current?.scrollTo?.(0, 0);
  }, []);

  const mark = (key: string, secs: number) => {
    clearTimeout(playTimer.current);
    setPlaying(key);
    playTimer.current = window.setTimeout(() => setPlaying(null), secs * 1000);
  };
  const hear = (id: JingleId) => {
    clearTimeout(playTimer.current);
    setPlaying(null);
    previewJingle(id, (len) => mark(`j:${id}`, len));
  };
  const pick = (id: JingleId) => {
    setNote(null);
    setLook(id);
    hear(id);
    const r = top.current?.getBoundingClientRect();
    if (r && r.top < -40) top.current!.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const take = () => {
    const next = pickJingle(save, look, solo);
    if (!next) return;
    onSave(next);
    playBlip();
    setNote(`${def.name} is your entrance now. Your opponent hears it too as the duel begins.`);
  };
  const buy = () => {
    const id = buying;
    setBuying(null);
    const next = id && buyJingle(save, id);
    if (!next) return;
    onSave(pickJingle(next, id, solo) ?? next);
    playWin();
    setNote(`${jingleDef(id)!.name} is yours, and it's your entrance now.`);
  };
  const hearTheme = (id: ThemeId) => {
    if (playing === `t:${id}`) {
      stopAll();
      return setPlaying(null);
    }
    stopAll();
    clearTimeout(playTimer.current);
    setPlaying(`t:${id}`);
    previewTheme(id, () => setPlaying((p) => (p === `t:${id}` ? null : p)));
  };
  const choose = (p: ThemePref) => {
    playBlip();
    setMusicThemePref(p);
  };
  const price = 'chips' in def.cost ? def.cost.chips : 0;
  const why = cantBuyJingle(save, look);

  return (
    <div class="screen jgl" ref={top}>
      <Win title="Duel Music" onClose={() => (stopAll(), onBack())}>
        <div class="mt-chips">
          <b>● {chipsOf(save)} Duel Chips</b>
          <span>
            {got}/{JINGLES.length} entrances yours
          </span>
        </div>

        <h3 class="jgl-h">Your entrance</h3>
        <div class="jgl-stage" style={{ '--jgl-hue': def.hue } as Record<string, string>}>
          <button class={`jgl-big${playing === `j:${look}` ? ' on' : ''}`} aria-label={`Play ${def.name}`} onClick={() => hear(look)}>
            <i class="jgl-wave" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <i key={i} style={{ '--i': i } as Record<string, number>} />
              ))}
            </i>
            <span>▶</span>
          </button>
          <div class="jgl-info">
            <b>{def.name}</b>
            <p>{def.blurb}</p>
            {look === current ? (
              <span class="mt-cost own">★ Your entrance</span>
            ) : owned ? (
              <button class="gbtn mt-go" onClick={take}>
                Make it my entrance
              </button>
            ) : price && !why ? (
              <span class="jgl-buy">
                <button class="gbtn mt-go" onClick={() => (playBlip(), setBuying(look))}>
                  Get for {price} Duel Chips
                </button>
              </span>
            ) : price ? (
              <span class="jgl-earn">
                🔒 {price} Duel Chips · you have {chipsOf(save)}
                <small>Win {Math.max(1, price - chipsOf(save))} more in duels</small>
              </span>
            ) : (
              <span class="jgl-earn">🔒 {jingleCostNote(save, def, solo)}</span>
            )}
          </div>
        </div>
        {note && <p class="mt-note jgl-note">{note}</p>}
        {!musicOn && <p class="jgl-off">Music is Off on this phone, so you won't hear entrances in duels (your opponent still hears yours).</p>}

        <div class="jgl-list">
          {JINGLES.map((j) => {
            const has = hasJingle(save, j.id, solo);
            return (
              <button key={j.id} class={`jgl-row${look === j.id ? ' sel' : ''}${has ? '' : ' locked'}${playing === `j:${j.id}` ? ' on' : ''}`} style={{ '--jgl-hue': j.hue } as Record<string, string>} onClick={() => pick(j.id)}>
                <i class="jgl-dot" aria-hidden="true">{playing === `j:${j.id}` ? '♪' : '▶'}</i>
                <b>{j.name}</b>
                <small class={has ? 'own' : ''}>{j.id === current ? '★ Yours' : has ? 'Yours' : `🔒 ${jingleCostShort(j)}`}</small>
              </button>
            );
          })}
        </div>

        <h3 class="jgl-h">Soundtrack</h3>
        <button class={`jgl-toggle${musicOn ? ' on' : ''}`} onClick={() => (playBlip(), setMusicEnabled(!musicOn))}>
          <b>Music: {musicOn ? 'On' : 'Off'}</b>
          <span>{musicOn ? 'the duel music and entrances' : 'tap to turn the duel music on'}</span>
          <i aria-hidden="true" />
        </button>
        <div class="jgl-themes" role="radiogroup" aria-label="Which theme plays">
          {THEME_PREFS.map((p) => {
            const isTheme = p.id !== 'moment' && p.id !== 'rotate';
            return (
              <div key={p.id} class={`jgl-theme${pref === p.id ? ' sel' : ''}`}>
                <button class="jgl-theme-pick" role="radio" aria-checked={pref === p.id} onClick={() => choose(p.id)}>
                  <i class="jgl-radio" aria-hidden="true" />
                  <span>
                    <b>{p.name}</b>
                    <small>{p.note}</small>
                  </span>
                </button>
                {isTheme && (
                  <button class={`jgl-listen${playing === `t:${p.id}` ? ' on' : ''}`} aria-label={`Listen to ${p.name}`} onClick={() => hearTheme(p.id as ThemeId)}>
                    {playing === `t:${p.id}` ? '■' : '▶'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <p class="mt-foot">Every theme still reacts to the duel: drums at 2000 LP, a faster final stretch at 1000, swells for Aces. Entrances are just for show.</p>
      </Win>
      {buying && (
        <ConfirmSheet look="md" title={`Get ${jingleDef(buying)!.name}?`} confirmLabel={`Spend ${price} Duel Chips`} onConfirm={buy} onCancel={() => setBuying(null)}>
          You have {chipsOf(save)} Duel Chips. {jingleDef(buying)!.name} joins your entrances for good.
        </ConfirmSheet>
      )}
    </div>
  );
}
