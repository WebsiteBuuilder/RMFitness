// 3D Card Viewer: pick any Speed Duel card and watch its summon, attack,
// destruction or a Shadow Realm finish, outside a duel.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { card, speedCards } from '../eds/db';
import { Win } from '../ui/Window';
import { unlockAudio } from '../ui/sound';
import type { CardRef, Cue } from './cues';
import { profileFor } from './profile';
import type { Director } from './runtime';
import { getArtSetting } from './ArtStage';
import './art.css';

const ref = (uid: number, name: string, controller: 0 | 1, faceUp = true): CardRef => ({ uid, name, faceUp, controller, rect: null, def: false });

export function ArtLab({ onBack, initial }: { onBack: () => void; initial?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const dir = useRef<Director | null>(null);
  const [q, setQ] = useState('');
  const pool = useMemo(() => speedCards().filter((c) => c.kind === 'monster' || c.kind === 'spell' || c.kind === 'trap'), []);
  const [name, setName] = useState(initial ?? 'Blue-Eyes White Dragon');
  const [foe, setFoe] = useState('Dark Magician');
  const [error, setError] = useState<string | null>(null);
  const uid = useRef(1000);

  useEffect(() => {
    let dead = false;
    import('./runtime')
      .then(({ Director }) => {
        if (dead || !canvas.current || !layer.current) return;
        const ui = layer.current;
        const add = (cls: string, html: string, dur: number, style: Record<string, string>) => {
          const el = document.createElement('div');
          el.className = cls;
          el.innerHTML = html;
          el.style.setProperty('--d', `${dur}s`);
          for (const [k, v] of Object.entries(style)) el.style.setProperty(k, v);
          ui.appendChild(el);
          setTimeout(() => el.remove(), dur * 1000 + 50);
        };
        const hx = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
        const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
        const d = new Director(canvas.current, getArtSetting() === 'fast' ? 'fast' : 'full', {
          banner: (o) => add(`art-banner ${o.big ? 'big' : ''} pos-${o.pos ?? 'bottom'}`, `<b>${esc(o.title)}</b>${o.sub ? `<span>${esc(o.sub)}</span>` : ''}`, Math.max(0.6, o.dur), { '--c': hx(o.color) }),
          number: (o) => add(`art-number side-${o.side}`, esc(o.text), 0.9, { '--c': hx(o.color), '--s': String(o.size) }),
          flash: (c, s) => add('art-flash', '', 0.35, { '--c': hx(c), '--s': String(s) }),
          caption: (t, dur, cls = '') => add(`art-caption ${cls}`, esc(t), dur, {}),
        });
        dir.current = d;
        void d.prewarm();
        // Test hook for automated browser checks.
        (window as unknown as { __artLab?: Director }).__artLab = d;
      })
      .catch((e) => setError(String(e?.message ?? e)));
    const onResize = () => dir.current?.resize();
    window.addEventListener('resize', onResize);
    return () => {
      dead = true;
      window.removeEventListener('resize', onResize);
      dir.current?.dispose();
    };
  }, []);

  const run = (cues: Cue[]) => {
    unlockAudio();
    dir.current?.clear();
    dir.current?.push(cues);
  };
  const me = () => ref(++uid.current, name, 0);
  const them = () => ref(++uid.current, foe, 1);
  const info = card(name);
  const prof = profileFor(info, name);
  const isMonster = info?.kind === 'monster';
  const matches = q.length >= 2 ? pool.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8) : [];

  const actions: { label: string; go: () => void }[] = isMonster
    ? [
        { label: 'Summon', go: () => run([{ kind: 'summon', card: me(), special: false }]) },
        {
          label: 'Attack',
          go: () => {
            const a = me();
            const t = them();
            run([
              { kind: 'attack', attacker: a, target: t, defender: 1 },
              { kind: 'hit', attacker: a, target: t, defender: 1 },
              { kind: 'destroy', card: t },
            ]);
          },
        },
        {
          label: 'Direct',
          go: () => {
            const a = me();
            run([
              { kind: 'attack', attacker: a, target: null, defender: 1 },
              { kind: 'hit', attacker: a, target: null, defender: 1 },
              { kind: 'damage', player: 1, amount: info?.atk ?? 1000 },
            ]);
          },
        },
        {
          label: 'Shadow Realm',
          go: () => {
            const a = me();
            run([
              { kind: 'attack', attacker: a, target: null, defender: 1 },
              { kind: 'hit', attacker: a, target: null, defender: 1 },
              { kind: 'damage', player: 1, amount: info?.atk ?? 3000 },
              { kind: 'win', winner: 0, shadow: { loser: 1, winner: 0, loserName: 'Rival', winnerName: 'You', excess: 1700, sealed: foe } },
            ]);
          },
        },
      ]
    : [{ label: 'Activate', go: () => run([{ kind: 'activate', card: me(), what: info?.kind === 'trap' ? 'trap' : 'spell' }]) }];

  return (
    <div class="artlab">
      <canvas ref={canvas} class="art-canvas" />
      <div ref={layer} class="art-layer" />
      <div class="artlab-panel">
        <Win title="3D Card Viewer" onClose={onBack}>
          {error ? <p class="warn">3D isn't available on this device ({error}).</p> : null}
          <div class="artlab-now">
            <b>{name}</b>
            <span>{isMonster ? `${prof.attackName} · ${prof.style}${prof.style2 ? ` + ${prof.style2}` : ''} · ${prof.entrance} entrance` : `${info?.sub ?? ''} ${info?.kind ?? ''}`}</span>
          </div>
          <input class="artlab-q" placeholder="Find a card…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          {matches.length > 0 && (
            <div class="artlab-list">
              {matches.map((c) => (
                <button key={c.name} onClick={() => (setName(c.name), setQ(''))}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
          <div class="artlab-btns">
            {actions.map((a) => (
              <button key={a.label} class="gbtn" onClick={a.go}>
                {a.label}
              </button>
            ))}
            {isMonster && (
              <button class="gbtn" onClick={() => setFoe(pool.filter((c) => c.kind === 'monster')[Math.floor(Math.random() * pool.length * 0.6)]?.name ?? foe)}>
                New foe
              </button>
            )}
          </div>
          {isMonster && <p class="hint">Opponent: {foe}</p>}
        </Win>
      </div>
    </div>
  );
}
