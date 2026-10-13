// 3D Card Viewer: pick any Speed Duel card and watch its summon, attack,
// destruction or a Shadow Realm finish, outside a duel.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { card, skillCards, speedCards } from '../eds/db';
import { Win } from '../ui/Window';
import { unlockAudio } from '../ui/sound';
import { bannerOnce, type CardRef, type Cue } from './cues';
import { profileFor, SIGNATURE_CARDS } from './profile';
import { classify, FX_FAMILIES, type FxFamily } from './families';
import type { Director } from './runtime';
import { getArtSetting } from './ArtStage';
import './art.css';

const ref = (uid: number, name: string, controller: 0 | 1, faceUp = true, rect: CardRef['rect'] = null): CardRef => ({ uid, name, faceUp, controller, rect, def: false });

export function ArtLab({ onBack, initial }: { onBack: () => void; initial?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const dir = useRef<Director | null>(null);
  const [q, setQ] = useState('');
  const pool = useMemo(() => speedCards().filter((c) => c.kind === 'monster' || c.kind === 'spell' || c.kind === 'trap'), []);
  const [name, setName] = useState(initial ?? 'Blue-Eyes White Dragon');
  const [foe, setFoe] = useState('Dark Magician');
  const [error, setError] = useState<string | null>(null);
  /** cards with their own preset or signature attack (known once the engine has loaded) */
  const [showcase, setShowcase] = useState<string[]>([]);
  /** cards that play their own preset (the family showcase picks cards without one) */
  const [own, setOwn] = useState<((n: string) => boolean) | null>(null);
  const skills = useMemo(() => skillCards(), []);
  /** each effect family's cards (Spells and Traps first, then monster effects) */
  const families = useMemo(() => {
    const m = new Map<FxFamily, string[]>();
    const sorted = [...pool].sort((a, b) => (a.kind === 'monster' ? 1 : 0) - (b.kind === 'monster' ? 1 : 0));
    for (const c of sorted) {
      if (c.kind === 'monster' && c.vanilla) continue;
      const f = classify(c).family;
      const l = m.get(f) ?? [];
      l.push(c.name);
      m.set(f, l);
    }
    return m;
  }, [pool]);
  const uid = useRef(1000);

  useEffect(() => {
    let dead = false;
    import('./runtime')
      .then(({ Director, SPELL_PRESET_CARDS, SIGNATURE_ATTACK_CARDS, hasOwnPreset }) => {
        const have = new Set(pool.map((c) => c.name));
        setOwn(() => hasOwnPreset);
        setShowcase([...new Set([...SIGNATURE_ATTACK_CARDS, ...SIGNATURE_CARDS, ...SPELL_PRESET_CARDS])].filter((n) => have.has(n)));
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
        const once = bannerOnce();
        const d = new Director(canvas.current, getArtSetting() === 'fast' ? 'fast' : 'full', {
          banner: (o) => void (once(o.title) && add(`art-banner ${o.big ? 'big' : ''} pos-${o.pos ?? 'bottom'}`, `<b>${esc(o.title)}</b>${o.sub ? `<span>${esc(o.sub)}</span>` : ''}`, Math.max(0.6, o.dur), { '--c': hx(o.color) })),
          number: (o) => add(`art-number side-${o.side}`, esc(o.text), 1.3, { '--c': hx(o.color), '--s': String(o.size) }),
          flash: (c, s) => add('art-flash', '', 0.35, { '--c': hx(c), '--s': String(s) }),
          caption: (t, dur, cls = '') => add(`art-caption ${cls}`, esc(t), dur, {}),
          clear: () => ui.replaceChildren(),
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
  /** A little field for Spells and Traps to strike: two of the foe on top, one of yours below. */
  const field = (): CardRef[] => {
    const w = canvas.current?.clientWidth || 390;
    const h = canvas.current?.clientHeight || 844;
    const r = (x: number, y: number) => ({ x: x * w, y: y * h, w: w * 0.18, h: w * 0.26 });
    return [ref(++uid.current, foe, 1, true, r(0.32, 0.24)), ref(++uid.current, 'Kuriboh', 1, true, r(0.68, 0.24)), ref(++uid.current, 'Dark Magician', 0, true, r(0.5, 0.5))];
  };
  const info = card(name);
  const prof = profileFor(info, name);
  const isMonster = info?.kind === 'monster';
  const fam = info && !(isMonster && info.vanilla) ? classify(info) : null;
  const famLabel = fam ? (FX_FAMILIES.find((f) => f.id === fam.family)?.label ?? fam.family) + (fam.terrain ? ` · ${fam.terrain}` : '') : '';
  /** a family's showcase card: one without its own preset, seeded by how often it was picked */
  const pickFamily = (f: FxFamily, i: number) => {
    const l = (families.get(f) ?? []).filter((n) => !own?.(n));
    if (l.length) setName(l[i % l.length]);
  };
  const [famTurn, setFamTurn] = useState(0);
  const single = new Set<FxFamily>(['destroy', 'banish', 'bounce', 'toDeck', 'equip', 'control', 'position', 'negate', 'powerDown', 'powerUp', 'protect']);
  const matches = q.length >= 2 ? pool.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8) : [];

  const actions: { label: string; go: () => void }[] = isMonster
    ? [
        { label: 'Summon', go: () => run([{ kind: 'summon', card: me(), special: false }]) },
        ...(['tribute', 'special', 'fusion', 'ritual', 'xyz', 'synchro', 'link'] as const).map((how) => ({ label: how[0].toUpperCase() + how.slice(1), go: () => run([{ kind: 'summon', card: me(), special: how !== 'tribute', how }]) })),
        {
          label: 'Effect',
          go: () => {
            const f = field();
            const aim = fam && single.has(fam.family);
            const destroyed = fam?.family === 'destroy';
            const cues: Cue[] = [{ kind: 'activate', card: me(), what: 'monster', field: f, targets: aim ? [{ card: f[0], destroyed }] : [] }];
            if (destroyed) cues.push({ kind: 'destroy', card: f[0] });
            run(cues);
          },
        },
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
    : [
        { label: 'Activate', go: () => run([{ kind: 'activate', card: me(), what: info?.kind === 'trap' ? 'trap' : 'spell', field: field() }]) },
        {
          label: 'On a target',
          go: () => {
            const f = field();
            const destroyed = /destroy/i.test(info?.desc ?? '');
            const cues: Cue[] = [{ kind: 'activate', card: me(), what: info?.kind === 'trap' ? 'trap' : 'spell', field: f, targets: [{ card: f[0], destroyed }] }];
            if (destroyed) cues.push({ kind: 'destroy', card: f[0] });
            run(cues);
          },
        },
      ];
  if (isMonster)
    actions.push({
      label: 'Destroy',
      go: () => run([{ kind: 'destroy', card: me() }]),
    });
  // cards leaving, Life Points gained, effect draws
  const w = canvas.current?.clientWidth || 390;
  const h = canvas.current?.clientHeight || 844;
  const onField = () => ref(++uid.current, name, 0, true, { x: w * 0.5, y: h * 0.62, w: w * 0.18, h: w * 0.26 });
  actions.push(
    { label: 'Banish', go: () => run([{ kind: 'leave', card: onField(), to: 'banish' }]) },
    { label: 'To hand', go: () => run([{ kind: 'leave', card: onField(), to: 'hand' }]) },
    { label: 'To Deck', go: () => run([{ kind: 'leave', card: onField(), to: isMonster && /Fusion|Xyz|Synchro|Link/.test(info?.sub ?? '') ? 'extra' : 'deck' }]) },
    { label: 'Gain LP', go: () => run([{ kind: 'heal', player: 0, amount: 1000 }]) },
    { label: 'Draw 2', go: () => run([{ kind: 'draw', player: 0, count: 2 }]) },
  );

  return (
    <div class="artlab">
      <canvas ref={canvas} class="art-canvas" />
      <div ref={layer} class="art-layer" />
      <div class="artlab-panel">
        <Win title="3D Card Viewer" onClose={onBack}>
          {error ? <p class="warn">3D isn't available on this device ({error}).</p> : null}
          <div class="artlab-now">
            <b>{name}</b>
            <span>{isMonster ? `${prof.attackName} · ${prof.style}${prof.style2 ? ` + ${prof.style2}` : ''} · ${prof.entrance} entrance` : `${info?.sub ?? ''} ${info?.kind ?? ''}`}{famLabel ? ` · ${own?.(name) ? 'own preset' : famLabel}` : ''}</span>
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
          <details class="artlab-show">
            <summary>Effect families ({FX_FAMILIES.length})</summary>
            <div class="artlab-fams">
              {FX_FAMILIES.map((f) => (
                <button key={f.id} class={fam?.family === f.id ? 'on' : ''} onClick={() => (pickFamily(f.id, famTurn), setFamTurn(famTurn + 1))}>
                  {f.label} ({families.get(f.id)?.length ?? 0})
                </button>
              ))}
            </div>
          </details>
          <details class="artlab-show">
            <summary>Skills ({skills.length})</summary>
            <div class="artlab-list">
              {skills.map((s) => (
                <button key={s.name} onClick={() => run([{ kind: 'skill', player: 0, name: s.name }])}>
                  {s.name}
                </button>
              ))}
            </div>
          </details>
          {showcase.length > 0 && (
            <details class="artlab-show">
              <summary>Showcase ({showcase.length})</summary>
              <div class="artlab-list">
                {showcase.map((n) => (
                  <button key={n} class={n === name ? 'on' : ''} onClick={() => setName(n)}>
                    {n}
                  </button>
                ))}
              </div>
            </details>
          )}
        </Win>
      </div>
    </div>
  );
}
