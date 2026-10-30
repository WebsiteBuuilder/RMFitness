// The mates' drawings: small cel-shaded SVG figures (viewBox 0 0 100 100, standing on y≈94)
// with a face that changes with the reaction: chibi takes on Speed Duel monsters.
import type { VNode } from 'preact';
import type { MateId } from './roster';

/** The face a mate pulls. */
export type Face = 'idle' | 'happy' | 'laugh' | 'wow' | 'hurt' | 'sad' | 'angry' | 'love' | 'sleep';

const INK = '#2a1a2e';

interface FaceSpot {
  x: number;
  y: number;
  /** eye spacing from the middle */
  gap: number;
  /** size */
  s: number;
  /** eye colour (robots and ghosts glow) */
  eye?: string;
  /** no cheeks (a screen face) */
  flat?: boolean;
  /** where the mouth sits, when it isn't just under the eyes (eyes on stalks) */
  mouthY?: number;
  /** eyes only (a mouth drawn by the figure itself, or none) */
  noMouth?: boolean;
  /** brows and mouth colour, on a dark face (a hood, a visor) */
  ink?: string;
}

/** Eyes, mouth and cheeks, drawn for a face. */
function FaceParts({ f, at }: { f: Face; at: FaceSpot }): VNode {
  const { x, y, gap, s } = at;
  const eye = at.eye ?? INK;
  const ink = at.ink ?? INK;
  const lx = x - gap;
  const rx = x + gap;
  const my = at.mouthY ?? y + 8 * s;
  const sw = 2.2 * s;
  const arc = (cx: number, up: boolean) => <path d={`M${cx - 4 * s} ${y + (up ? 1.5 : -1) * s} Q${cx} ${y + (up ? -4 : 3.5) * s} ${cx + 4 * s} ${y + (up ? 1.5 : -1) * s}`} stroke={eye} stroke-width={sw} fill="none" stroke-linecap="round" />;
  const dot = (cx: number, r = 1) => (
    <g>
      <ellipse cx={cx} cy={y} rx={3.4 * s * r} ry={4.4 * s * r} fill={eye} />
      <circle cx={cx + 1.1 * s} cy={y - 1.6 * s} r={1.2 * s} fill="#fff" />
    </g>
  );
  const heart = (cx: number) => <path d={`M${cx} ${y + 3.6 * s} C${cx - 6 * s} ${y - 1 * s} ${cx - 3 * s} ${y - 6 * s} ${cx} ${y - 2.4 * s} C${cx + 3 * s} ${y - 6 * s} ${cx + 6 * s} ${y - 1 * s} ${cx} ${y + 3.6 * s}Z`} fill="#ff4f86" stroke={ink} stroke-width={0.8 * s} />;
  const cheeks = !at.flat && (f === 'happy' || f === 'laugh' || f === 'love' || f === 'idle') && (
    <g opacity={f === 'idle' ? 0.35 : 0.6}>
      <ellipse cx={lx - 2.5 * s} cy={y + 5 * s} rx={3 * s} ry={1.8 * s} fill="#ff7aa2" />
      <ellipse cx={rx + 2.5 * s} cy={y + 5 * s} rx={3 * s} ry={1.8 * s} fill="#ff7aa2" />
    </g>
  );
  let eyes: VNode;
  let mouth: VNode;
  switch (f) {
    case 'happy':
      eyes = <g>{arc(lx, true)}{arc(rx, true)}</g>;
      mouth = <path d={`M${x - 3.5 * s} ${my - 1 * s} Q${x} ${my + 3.5 * s} ${x + 3.5 * s} ${my - 1 * s}`} stroke={ink} stroke-width={sw * 0.8} fill="none" stroke-linecap="round" />;
      break;
    case 'laugh':
      eyes = <g>{arc(lx, true)}{arc(rx, true)}</g>;
      mouth = <path d={`M${x - 4.5 * s} ${my - 1.5 * s} Q${x} ${my - 1.5 * s} ${x + 4.5 * s} ${my - 1.5 * s} Q${x + 4 * s} ${my + 5 * s} ${x} ${my + 5 * s} Q${x - 4 * s} ${my + 5 * s} ${x - 4.5 * s} ${my - 1.5 * s}Z`} fill="#8a1f3a" stroke={ink} stroke-width={0.8 * s} />;
      break;
    case 'wow':
      eyes = (
        <g>
          <circle cx={lx} cy={y} r={4.4 * s} fill="#fff" stroke={eye} stroke-width={1.2 * s} />
          <circle cx={rx} cy={y} r={4.4 * s} fill="#fff" stroke={eye} stroke-width={1.2 * s} />
          <circle cx={lx} cy={y} r={1.8 * s} fill={eye} />
          <circle cx={rx} cy={y} r={1.8 * s} fill={eye} />
        </g>
      );
      mouth = <ellipse cx={x} cy={my + 0.5 * s} rx={2.2 * s} ry={3 * s} fill="#8a1f3a" stroke={ink} stroke-width={0.8 * s} />;
      break;
    case 'hurt':
      eyes = (
        <g stroke={eye} stroke-width={sw} fill="none" stroke-linecap="round">
          <path d={`M${lx - 3.5 * s} ${y - 3 * s} L${lx + 3 * s} ${y} L${lx - 3.5 * s} ${y + 3 * s}`} />
          <path d={`M${rx + 3.5 * s} ${y - 3 * s} L${rx - 3 * s} ${y} L${rx + 3.5 * s} ${y + 3 * s}`} />
        </g>
      );
      mouth = <path d={`M${x - 4 * s} ${my} q${s} ${-2 * s} ${2 * s} 0 t${2 * s} 0 t${2 * s} 0 t${2 * s} 0`} stroke={ink} stroke-width={sw * 0.7} fill="none" stroke-linecap="round" />;
      break;
    case 'sad':
      eyes = (
        <g>
          {dot(lx, 0.85)}
          {dot(rx, 0.85)}
          <path d={`M${lx - 4 * s} ${y - 5 * s} L${lx + 3 * s} ${y - 7 * s}`} stroke={ink} stroke-width={sw * 0.7} stroke-linecap="round" />
          <path d={`M${rx + 4 * s} ${y - 5 * s} L${rx - 3 * s} ${y - 7 * s}`} stroke={ink} stroke-width={sw * 0.7} stroke-linecap="round" />
          <path class="mt-tear" d={`M${lx - 1 * s} ${y + 4 * s} q${-1.8 * s} ${3 * s} 0 ${4.5 * s} q${1.8 * s} ${-1.5 * s} 0 ${-4.5 * s}Z`} fill="#7cd3ff" />
        </g>
      );
      mouth = <path d={`M${x - 3.5 * s} ${my + 2 * s} Q${x} ${my - 2.5 * s} ${x + 3.5 * s} ${my + 2 * s}`} stroke={ink} stroke-width={sw * 0.8} fill="none" stroke-linecap="round" />;
      break;
    case 'angry':
      eyes = (
        <g>
          {dot(lx, 0.8)}
          {dot(rx, 0.8)}
          <path d={`M${lx - 4.5 * s} ${y - 7 * s} L${lx + 3.5 * s} ${y - 4 * s}`} stroke={ink} stroke-width={sw} stroke-linecap="round" />
          <path d={`M${rx + 4.5 * s} ${y - 7 * s} L${rx - 3.5 * s} ${y - 4 * s}`} stroke={ink} stroke-width={sw} stroke-linecap="round" />
        </g>
      );
      mouth = (
        <g>
          <rect x={x - 4 * s} y={my - 1.5 * s} width={8 * s} height={3.6 * s} rx={1.2 * s} fill="#fff" stroke={ink} stroke-width={0.9 * s} />
          <path d={`M${x - 4 * s} ${my + 0.3 * s} H${x + 4 * s} M${x - 1.3 * s} ${my - 1.5 * s} V${my + 2.1 * s} M${x + 1.3 * s} ${my - 1.5 * s} V${my + 2.1 * s}`} stroke={ink} stroke-width={0.6 * s} />
        </g>
      );
      break;
    case 'love':
      eyes = <g>{heart(lx)}{heart(rx)}</g>;
      mouth = <path d={`M${x - 3 * s} ${my - 1 * s} Q${x} ${my + 3 * s} ${x + 3 * s} ${my - 1 * s}`} stroke={ink} stroke-width={sw * 0.8} fill="none" stroke-linecap="round" />;
      break;
    case 'sleep':
      eyes = <g>{arc(lx, false)}{arc(rx, false)}</g>;
      mouth = <ellipse cx={x} cy={my + 0.5 * s} rx={1.4 * s} ry={1.8 * s} fill="#8a1f3a" />;
      break;
    default:
      eyes = (
        <g class="mt-eyes" style={{ transformOrigin: `${x}px ${y}px` }}>
          {dot(lx)}
          {dot(rx)}
        </g>
      );
      mouth = <path d={`M${x - 2.5 * s} ${my - 0.5 * s} Q${x} ${my + 2 * s} ${x + 2.5 * s} ${my - 0.5 * s}`} stroke={ink} stroke-width={sw * 0.7} fill="none" stroke-linecap="round" />;
  }
  return (
    <g class="mt-face">
      {cheeks}
      {eyes}
      {!at.noMouth && mouth}
    </g>
  );
}

const stroke = { stroke: INK, 'stroke-width': 2.2, 'stroke-linejoin': 'round' as const };

/** A soft ground shadow under every mate. */
const Shadow = ({ w = 26 }: { w?: number }) => <ellipse class="mt-shadow" cx="50" cy="95" rx={w} ry="3.6" fill="#000" opacity="0.35" />;

function grad(id: string, top: string, bottom: string) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color={top} />
      <stop offset="1" stop-color={bottom} />
    </linearGradient>
  );
}
function radial(id: string, inner: string, outer: string) {
  return (
    <radialGradient id={id} cx="0.4" cy="0.35" r="0.75">
      <stop offset="0" stop-color={inner} />
      <stop offset="1" stop-color={outer} />
    </radialGradient>
  );
}
/** A glossy highlight on a round body. */
const Gloss = ({ x, y, r }: { x: number; y: number; r: number }) => <ellipse cx={x} cy={y} rx={r} ry={r * 0.6} fill="#fff" opacity="0.45" transform={`rotate(-25 ${x} ${y})`} />;

type Draw = (f: Face) => VNode;

/** A ring of fur tufts round a body (Kuriboh, Sangan). */
const ring = (cx: number, cy: number, rx: number, ry: number, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as const;
  });
const KURI = ring(50, 60, 27, 26, 14);
const SANGAN = ring(50, 62, 27, 25, 16);

interface DragonLook {
  id: string;
  /** body light and dark */
  hi: string;
  lo: string;
  belly: string;
  wing: string;
  wingEdge: string;
  spike: string;
  eye: string;
  /** spiky horns (Red-Eyes) or little nubs */
  horns: 'spiky' | 'nubs' | 'one' | 'swept';
  big?: boolean;
  /** a long pointed snout (Blue-Eyes) instead of a round muzzle */
  snout?: boolean;
}

/** The chibi dragon the three dragons share: big head, snout, wings, a curl of tail. */
function dragon(f: Face, d: DragonLook): VNode {
  const g = `mg-${d.id}`;
  return (
    <g>
      <defs>{grad(g, d.hi, d.lo)}</defs>
      <Shadow w={30} />
      <path class="mt-wing" d={d.big ? 'M32 66 Q2 56 6 22 Q16 34 22 28 Q22 44 36 54Z' : 'M32 66 Q10 56 12 36 Q22 44 26 40 Q28 50 36 56Z'} fill={d.wing} {...stroke} />
      <path class="mt-wing r" d={d.big ? 'M68 66 Q98 56 94 22 Q84 34 78 28 Q78 44 64 54Z' : 'M68 66 Q90 56 88 36 Q78 44 74 40 Q72 50 64 56Z'} fill={d.wing} {...stroke} />
      {d.big && <path d="M10 30 Q18 44 30 52 M90 30 Q82 44 70 52" stroke={d.wingEdge} stroke-width="2" fill="none" />}
      <path d="M64 86 Q86 92 86 74 Q86 68 80 68" fill="none" stroke={INK} stroke-width="8" stroke-linecap="round" />
      <path d="M64 86 Q86 92 86 74 Q86 68 80 68" fill="none" stroke={d.lo} stroke-width="4.6" stroke-linecap="round" />
      <ellipse cx="50" cy="79" rx="18" ry="14" fill={`url(#${g})`} {...stroke} />
      <ellipse cx="50" cy="82" rx="10" ry="9.5" fill={d.belly} />
      <path d="M43 77 h14 M43 82 h14 M44 87 h12" stroke={INK} stroke-opacity="0.25" stroke-width="1.2" />
      <ellipse cx="39" cy="92" rx="5.5" ry="3.2" fill={d.lo} {...stroke} stroke-width="1.8" />
      <ellipse cx="61" cy="92" rx="5.5" ry="3.2" fill={d.lo} {...stroke} stroke-width="1.8" />
      {d.horns === 'swept' ? (
        <path d="M30 44 L6 30 L24 36 L10 18 L32 32 L24 12 L40 30 M70 44 L94 30 L76 36 L90 18 L68 32 L76 12 L60 30" fill={d.spike} {...stroke} stroke-width="1.6" />
      ) : d.horns === 'spiky' ? (
        <path d="M32 40 L20 22 L38 32 M68 40 L80 22 L62 32 M42 30 L44 18 L50 28 L56 18 L58 30" fill={d.spike} {...stroke} stroke-width="1.8" />
      ) : d.horns === 'one' ? (
        <path d="M46 30 L50 16 L54 30Z" fill={d.spike} {...stroke} stroke-width="1.8" />
      ) : (
        <path d="M34 36 l-6 -10 l10 4 M66 36 l6 -10 l-10 4" fill={d.spike} {...stroke} stroke-width="1.6" />
      )}
      <ellipse cx="50" cy="48" rx="24" ry="19" fill={`url(#${g})`} {...stroke} />
      {d.horns !== 'one' && <path d="M42 31 l3 -6 l3 5 l2 -6 l2 6 l3 -5 l3 6" fill={d.spike} stroke={INK} stroke-width="1.2" />}
      {d.snout ? (
        <g>
          <path d="M37 52 Q50 50 63 52 L54 72 Q50 76 46 72Z" fill={`url(#${g})`} {...stroke} stroke-width="1.8" />
          <path d="M41 54 L50 52 L59 54 M44 62 L50 60 L56 62" stroke={d.wingEdge} stroke-width="1.3" fill="none" opacity="0.7" />
          <circle cx="47.5" cy="69" r="0.9" fill={INK} />
          <circle cx="52.5" cy="69" r="0.9" fill={INK} />
        </g>
      ) : (
        <g>
          <ellipse cx="50" cy="58" rx="13" ry="7.5" fill={d.belly} opacity="0.85" />
          <circle cx="46" cy="56.5" r="0.9" fill={INK} />
          <circle cx="54" cy="56.5" r="0.9" fill={INK} />
        </g>
      )}
      <Gloss x={38} y={40} r={5} />
      <FaceParts f={f} at={{ x: 50, y: d.snout ? 43 : 46, gap: 10.5, s: 0.95, eye: d.eye, mouthY: d.snout ? 65 : 61 }} />
    </g>
  );
}

const ART: Record<MateId, Draw> = {
  blueeyes: (f) => dragon(f, { id: 'blueeyes', hi: '#ffffff', lo: '#9fc0ec', belly: '#8fb8ee', wing: '#d6e6fb', wingEdge: '#3d7be0', spike: '#e8f2ff', eye: '#1f6fe8', horns: 'swept', big: true, snout: true }),
  redeyes: (f) => dragon(f, { id: 'redeyes', hi: '#7a7a92', lo: '#34343f', belly: '#a2a2b6', wing: '#8a1e2a', wingEdge: '#a3242f', spike: '#9a9aa8', eye: '#ff2a2a', horns: 'spiky', big: true }),
  babydragon: (f) => dragon(f, { id: 'babydragon', hi: '#ffc36b', lo: '#e47a1c', belly: '#fff0c8', wing: '#ffb04a', wingEdge: '#c25a10', spike: '#fff0c8', eye: INK, horns: 'one' }),
  kuriboh: (f) => (
    <g>
      <defs>{radial('mg-kuriboh', '#c48a52', '#6b4320')}</defs>
      <Shadow />
      <path d="M38 88 l-4 6 M38 88 l0 7 M38 88 l4 6 M62 88 l-4 6 M62 88 l0 7 M62 88 l4 6" stroke="#4f8f2a" stroke-width="3" stroke-linecap="round" />
      <path d="M38 88 l-4 6 M38 88 l0 7 M38 88 l4 6 M62 88 l-4 6 M62 88 l0 7 M62 88 l4 6" stroke="#8fd05a" stroke-width="1.4" stroke-linecap="round" />
      <g fill="#6b4320" {...stroke}>{KURI.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="7.5" />)}</g>
      <g fill="url(#mg-kuriboh)">{KURI.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="6.2" />)}</g>
      <circle cx="50" cy="60" r="27" fill="url(#mg-kuriboh)" />
      <path d="M24 62 Q14 60 12 52 M76 62 Q86 60 88 52" stroke="#4f8f2a" stroke-width="3.6" fill="none" stroke-linecap="round" />
      <path d="M12 52 l-3 -3 M12 52 l1 -4 M88 52 l3 -3 M88 52 l-1 -4" stroke="#4f8f2a" stroke-width="2.2" stroke-linecap="round" />
      <ellipse cx="41" cy="56" rx="8.5" ry="10" fill="#fff" stroke={INK} stroke-width="1.6" />
      <ellipse cx="59" cy="56" rx="8.5" ry="10" fill="#fff" stroke={INK} stroke-width="1.6" />
      <FaceParts f={f} at={{ x: 50, y: 57, gap: 9, s: 1.2, mouthY: 72 }} />
    </g>
  ),
  wkuriboh: (f) => (
    <g>
      <defs>{radial('mg-wkuri', '#c48a52', '#6b4320')}</defs>
      <Shadow w={22} />
      <g class="mt-wing">
        <path d="M30 58 Q2 52 2 22 Q8 28 12 26 Q10 34 16 36 Q14 42 22 44 Q20 50 28 50Z" fill="#fff" {...stroke} />
        <path d="M12 26 Q16 38 26 46 M16 36 Q20 44 28 50" stroke="#c9d6f0" stroke-width="1.4" fill="none" />
      </g>
      <g class="mt-wing r">
        <path d="M70 58 Q98 52 98 22 Q92 28 88 26 Q90 34 84 36 Q86 42 78 44 Q80 50 72 50Z" fill="#fff" {...stroke} />
        <path d="M88 26 Q84 38 74 46 M84 36 Q80 44 72 50" stroke="#c9d6f0" stroke-width="1.4" fill="none" />
      </g>
      <path d="M40 86 l-3 6 M40 86 l1 6 M60 86 l-1 6 M60 86 l3 6" stroke="#4f8f2a" stroke-width="2.6" stroke-linecap="round" />
      <g fill="#6b4320" {...stroke}>{KURI.map(([x, y], i) => <circle key={i} cx={x} cy={y - 2} r="6.6" />)}</g>
      <g fill="url(#mg-wkuri)">{KURI.map(([x, y], i) => <circle key={i} cx={x} cy={y - 2} r="5.4" />)}</g>
      <circle cx="50" cy="58" r="25" fill="url(#mg-wkuri)" />
      <ellipse cx="42" cy="55" rx="8" ry="9.5" fill="#fff" stroke={INK} stroke-width="1.6" />
      <ellipse cx="58" cy="55" rx="8" ry="9.5" fill="#fff" stroke={INK} stroke-width="1.6" />
      <FaceParts f={f} at={{ x: 50, y: 56, gap: 8, s: 1.1, mouthY: 70 }} />
    </g>
  ),
  mokeymokey: (f) => (
    <g>
      <defs>{radial('mg-mokey', '#ffffff', '#d8d2c4')}</defs>
      <Shadow w={22} />
      <path class="mt-wing" d="M30 54 Q16 46 18 34 Q24 40 30 38 Q26 46 34 50Z" fill="#fff" {...stroke} stroke-width="1.8" />
      <path class="mt-wing r" d="M70 54 Q84 46 82 34 Q76 40 70 38 Q74 46 66 50Z" fill="#fff" {...stroke} stroke-width="1.8" />
      <path d="M50 26 C68 26 74 46 74 64 C74 84 64 92 50 92 C36 92 26 84 26 64 C26 46 32 26 50 26Z" fill="url(#mg-mokey)" {...stroke} />
      <ellipse class="mt-glow" cx="50" cy="20" rx="12" ry="3.5" fill="none" stroke="#ffe36e" stroke-width="2.4" />
      <path d="M38 92 v3 M62 92 v3" stroke={INK} stroke-width="2.4" stroke-linecap="round" />
      <FaceParts f={f} at={{ x: 50, y: 52, gap: 9, s: 0.7 }} />
    </g>
  ),
  ojama: (f) => (
    <g>
      <defs>{radial('mg-ojama', '#fff38a', '#e7c21a')}</defs>
      <Shadow w={24} />
      <path d="M40 40 Q36 26 38 18 M60 40 Q64 26 62 18" stroke={INK} stroke-width="5" fill="none" stroke-linecap="round" />
      <path d="M40 40 Q36 26 38 18 M60 40 Q64 26 62 18" stroke="#f2d43a" stroke-width="2.6" fill="none" stroke-linecap="round" />
      <circle cx="37" cy="16" r="8.5" fill="#fff" {...stroke} stroke-width="1.8" />
      <circle cx="63" cy="16" r="8.5" fill="#fff" {...stroke} stroke-width="1.8" />
      <path d="M50 36 C70 36 78 56 76 72 C74 86 64 90 50 90 C36 90 26 86 24 72 C22 56 30 36 50 36Z" fill="url(#mg-ojama)" {...stroke} />
      <path d="M30 78 Q50 74 70 78 L68 88 Q50 92 32 88Z" fill="#e2333f" {...stroke} stroke-width="1.8" />
      <path d="M40 90 l-2 5 M60 90 l2 5" stroke={INK} stroke-width="3" stroke-linecap="round" />
      <path d="M24 64 Q14 62 14 54 M76 64 Q86 62 86 54" stroke={INK} stroke-width="3" fill="none" stroke-linecap="round" />
      <Gloss x={38} y={48} r={5} />
      <FaceParts f={f} at={{ x: 50, y: 16, gap: 13, s: 0.95, mouthY: 60 }} />
    </g>
  ),
  sangan: (f) => (
    <g>
      <defs>{radial('mg-sangan', '#b98552', '#6a4222')}</defs>
      <Shadow />
      <g fill="#6a4222" {...stroke}>{SANGAN.map(([x, y], i) => <path key={i} d={`M${x} ${y} l${(x - 50) * 0.28} ${(y - 62) * 0.28}`} stroke-width="5" stroke-linecap="round" />)}</g>
      <circle cx="50" cy="62" r="26" fill="url(#mg-sangan)" {...stroke} />
      <path d="M26 70 Q14 74 14 84 M74 70 Q86 74 86 84" stroke={INK} stroke-width="5.6" fill="none" stroke-linecap="round" />
      <path d="M26 70 Q14 74 14 84 M74 70 Q86 74 86 84" stroke="#a0714a" stroke-width="2.6" fill="none" stroke-linecap="round" />
      <path d="M14 84 l-3 3 M14 84 l2 4 M86 84 l3 3 M86 84 l-2 4" stroke={INK} stroke-width="2.2" stroke-linecap="round" />
      <ellipse cx="50" cy="45" rx="5" ry="5.6" fill="#fff6c4" stroke={INK} stroke-width="1.4" />
      <circle cx="50" cy="45.5" r="2.4" fill="#c8102e" />
      <FaceParts f={f} at={{ x: 50, y: 58, gap: 10, s: 1.05, eye: '#c8102e', mouthY: 72 }} />
    </g>
  ),
  penguin: (f) => (
    <g>
      <defs>{grad('mg-penguin', '#5b86c8', '#1f3566')}</defs>
      <Shadow />
      <path d="M78 40 L72 78" stroke="#c9d3e3" stroke-width="4" stroke-linecap="round" />
      <path d="M78 40 L72 78" stroke={INK} stroke-width="1" />
      <path d="M68 74 h10" stroke="#d4a017" stroke-width="4" stroke-linecap="round" />
      <ellipse cx="50" cy="62" rx="24" ry="30" fill="url(#mg-penguin)" {...stroke} />
      <ellipse cx="50" cy="68" rx="16" ry="22" fill="#f5f7ff" />
      <path d="M26 58 Q16 70 24 80" fill="#1f3566" {...stroke} />
      <path d="M74 58 Q80 66 74 76" fill="#1f3566" {...stroke} />
      <path d="M32 62 Q50 70 68 62 L66 68 Q50 76 34 68Z" fill="#d63a3a" {...stroke} stroke-width="1.6" />
      <ellipse cx="41" cy="92" rx="7" ry="3" fill="#ff9d2e" {...stroke} stroke-width="1.6" />
      <ellipse cx="59" cy="92" rx="7" ry="3" fill="#ff9d2e" {...stroke} stroke-width="1.6" />
      <path d="M28 40 Q28 26 50 26 Q72 26 72 40Z" fill="#9aa8bd" {...stroke} stroke-width="1.8" />
      <path d="M50 26 q4 -10 12 -8 q-6 4 -8 10" fill="#d63a3a" {...stroke} stroke-width="1.4" />
      <FaceParts f={f} at={{ x: 50, y: 47, gap: 8, s: 0.9 }} />
      <path d="M46 55 L50 60 L54 55Z" fill="#ff9d2e" {...stroke} stroke-width="1.4" />
    </g>
  ),
  timewizard: (f) => (
    <g>
      <defs>
        {grad('mg-tw', '#9b6bff', '#4a2a9e')}
        {radial('mg-dial', '#fffdf0', '#e8dcb0')}
      </defs>
      <Shadow />
      <path d="M22 70 L12 50" stroke="#8a5a2a" stroke-width="3.4" stroke-linecap="round" />
      <circle cx="12" cy="47" r="5.5" fill="#ffd84a" {...stroke} stroke-width="1.6" />
      <path d="M12 44 v3 h2" stroke={INK} stroke-width="1.2" fill="none" />
      <circle cx="50" cy="70" r="22" fill="#d4a017" {...stroke} />
      <circle cx="50" cy="70" r="17.5" fill="url(#mg-dial)" stroke={INK} stroke-width="1.4" />
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2;
        return <circle key={i} cx={50 + Math.cos(a) * 14.5} cy={70 + Math.sin(a) * 14.5} r={i % 3 === 0 ? 1.4 : 0.8} fill={INK} />;
      })}
      <g class="mt-hands">
        <path d="M50 70 V58" stroke={INK} stroke-width="2" stroke-linecap="round" />
        <path d="M50 70 L59 74" stroke="#c8102e" stroke-width="1.6" stroke-linecap="round" />
      </g>
      <circle cx="50" cy="70" r="1.8" fill={INK} />
      <path d="M40 92 l-2 3 M60 92 l2 3" stroke={INK} stroke-width="3" stroke-linecap="round" />
      <path d="M26 50 Q24 18 50 10 Q76 18 74 50 Q62 44 50 44 Q38 44 26 50Z" fill="url(#mg-tw)" {...stroke} />
      <ellipse cx="50" cy="35" rx="15" ry="11" fill="#1a1030" />
      <FaceParts f={f} at={{ x: 50, y: 34, gap: 6.5, s: 0.75, eye: '#ffe36e', ink: '#ffe36e', flat: true, mouthY: 41 }} />
    </g>
  ),
  darkmagician: (f) => (
    <g>
      <defs>
        {grad('mg-dm', '#7a52d8', '#341c7a')}
        {grad('mg-skin', '#ffe0c8', '#e9b48f')}
      </defs>
      <Shadow />
      <path d="M78 30 L70 88" stroke="#3aa860" stroke-width="3.6" stroke-linecap="round" />
      <circle cx="78" cy="27" r="5" fill="none" stroke="#3aa860" stroke-width="3" />
      <circle cx="78" cy="27" r="2" fill="#ffe36e" />
      <path d="M32 92 Q30 72 38 64 L62 64 Q70 72 68 92Z" fill="url(#mg-dm)" {...stroke} />
      <path d="M40 66 L50 80 L60 66" fill="none" stroke="#d4a017" stroke-width="2.2" />
      <path d="M30 70 Q22 76 26 84 M70 70 Q76 74 72 82" stroke="#341c7a" stroke-width="6" fill="none" stroke-linecap="round" />
      <ellipse cx="50" cy="50" rx="18" ry="16" fill="url(#mg-skin)" {...stroke} />
      <path d="M32 50 Q30 40 36 36 L36 56Z M68 50 Q70 40 64 36 L64 56Z" fill="#5a3aa8" />
      <path d="M28 42 Q34 30 50 30 Q66 30 72 42 Q62 38 50 38 Q38 38 28 42Z" fill="#d4a017" {...stroke} stroke-width="1.6" />
      <path d="M30 38 Q34 14 54 6 Q50 14 66 22 Q70 30 70 38 Q50 30 30 38Z" fill="url(#mg-dm)" {...stroke} />
      <path d="M54 6 Q74 2 80 14 Q72 10 64 14" fill="url(#mg-dm)" {...stroke} stroke-width="1.8" />
      <FaceParts f={f} at={{ x: 50, y: 51, gap: 7.5, s: 0.85 }} />
    </g>
  ),
  dmg: (f) => (
    <g>
      <defs>
        {grad('mg-dmg', '#4a8bff', '#2a4fc4')}
        {grad('mg-skin2', '#ffe6d2', '#f0bea0')}
      </defs>
      <Shadow />
      <path d="M28 52 Q20 74 26 90 L36 84 Z M72 52 Q80 74 74 90 L64 84Z" fill="#ffd76a" {...stroke} stroke-width="1.8" />
      <path d="M76 34 L70 80" stroke="#ff5fa0" stroke-width="3" stroke-linecap="round" />
      <path d="M76 26 l2 5 l5 1 l-4 3 l1 5 l-4 -3 l-4 3 l1 -5 l-4 -3 l5 -1z" fill="#ffe36e" {...stroke} stroke-width="1.2" />
      <path d="M34 92 Q32 74 40 66 L60 66 Q68 74 66 92Z" fill="url(#mg-dmg)" {...stroke} />
      <path d="M34 92 Q50 84 66 92" fill="#ff5fa0" {...stroke} stroke-width="1.6" />
      <path d="M44 68 L50 76 L56 68" fill="#ff5fa0" stroke={INK} stroke-width="1.4" />
      <ellipse cx="50" cy="52" rx="17" ry="15" fill="url(#mg-skin2)" {...stroke} />
      <path d="M33 50 Q34 38 50 38 Q66 38 67 50 Q60 42 54 46 Q50 40 44 46 Q38 42 33 50Z" fill="#ffd76a" {...stroke} stroke-width="1.4" />
      <path d="M28 42 Q34 32 50 32 Q66 32 72 42 Q60 38 50 38 Q40 38 28 42Z" fill="#ff5fa0" {...stroke} stroke-width="1.6" />
      <path d="M32 38 Q36 16 52 8 Q50 16 64 22 Q68 30 68 38 Q50 32 32 38Z" fill="url(#mg-dmg)" {...stroke} />
      <path d="M52 8 Q70 2 76 12 Q68 10 62 14" fill="url(#mg-dmg)" {...stroke} stroke-width="1.8" />
      <FaceParts f={f} at={{ x: 50, y: 53, gap: 7.5, s: 0.85, eye: '#16935a' }} />
    </g>
  ),
  cyberdragon: (f) => (
    <g>
      <defs>{grad('mg-cyber', '#f4f8ff', '#8d9bb3')}</defs>
      <Shadow w={32} />
      <path d="M50 90 Q14 92 16 78 Q18 66 38 68 Q66 70 80 80 Q88 90 66 92" fill="none" stroke={INK} stroke-width="14" stroke-linecap="round" />
      <path d="M50 90 Q14 92 16 78 Q18 66 38 68 Q66 70 80 80 Q88 90 66 92" fill="none" stroke="url(#mg-cyber)" stroke-width="10.6" stroke-linecap="round" />
      <path d="M22 72 l4 6 M32 68 l2 7 M46 69 l1 7 M60 71 l0 7 M72 75 l-2 6" stroke="#5f6f8c" stroke-width="1.6" stroke-linecap="round" />
      <path d="M50 74 Q44 66 46 54" fill="none" stroke={INK} stroke-width="13" stroke-linecap="round" />
      <path d="M50 74 Q44 66 46 54" fill="none" stroke="url(#mg-cyber)" stroke-width="9.6" stroke-linecap="round" />
      <path d="M44 62 h8 M45 67 h7" stroke="#5f6f8c" stroke-width="1.4" />
      <path d="M50 26 L54 6 L62 24Z" fill="#b8c4d8" {...stroke} stroke-width="1.6" />
      <path d="M32 42 Q32 24 50 22 Q68 24 68 42 Q66 50 58 52 L54 68 Q50 72 46 68 L42 52 Q34 50 32 42Z" fill="url(#mg-cyber)" {...stroke} />
      <path d="M36 36 Q50 30 64 36 L62 46 Q50 42 38 46Z" fill="#14233a" stroke={INK} stroke-width="1.4" />
      <path d="M45 54 L50 52 L55 54 M46 60 L50 58 L54 60" stroke="#5f6f8c" stroke-width="1.2" fill="none" />
      <circle cx="47.5" cy="65" r="0.9" fill={INK} />
      <circle cx="52.5" cy="65" r="0.9" fill={INK} />
      <Gloss x={42} y={30} r={4} />
      <FaceParts f={f} at={{ x: 50, y: 39, gap: 7, s: 0.8, eye: '#46e0ff', flat: true, noMouth: true }} />
    </g>
  ),
  jinzo: (f) => (
    <g>
      <defs>
        {grad('mg-jinzo', '#9ad08a', '#5f9a52')}
        {grad('mg-coat', '#4a4d5c', '#22242e')}
      </defs>
      <Shadow />
      <path d="M30 92 Q28 72 36 64 L64 64 Q72 72 70 92Z" fill="url(#mg-coat)" {...stroke} />
      <path d="M36 64 L44 80 M64 64 L56 80" stroke="#6a6e80" stroke-width="2" />
      <path d="M32 68 Q24 76 28 86 M68 68 Q76 76 72 86" stroke="#22242e" stroke-width="6" fill="none" stroke-linecap="round" />
      <path d="M36 34 Q30 20 40 16 M64 34 Q70 20 60 16 M50 30 V14" stroke="#7a3a8c" stroke-width="3.4" fill="none" stroke-linecap="round" />
      <ellipse cx="50" cy="48" rx="18" ry="18" fill="url(#mg-jinzo)" {...stroke} />
      <path d="M36 40 Q50 34 64 40 Q66 46 62 50 Q50 46 38 50 Q34 46 36 40Z" fill="#e01e2e" stroke={INK} stroke-width="1.6" />
      <path d="M40 41 Q50 38 60 41" stroke="#ff9aa2" stroke-width="1.4" fill="none" />
      <FaceParts f={f} at={{ x: 50, y: 44, gap: 7, s: 0.75, eye: '#ffe36e', ink: '#2a1a2e', flat: true, mouthY: 57 }} />
    </g>
  ),
  slifer: (f) => (
    <g>
      <defs>{grad('mg-slifer', '#ff6a5a', '#b3121f')}</defs>
      <Shadow w={32} />
      <path class="mt-wing" d="M36 52 Q12 40 16 18 Q24 30 30 26 Q30 40 42 46Z" fill="#c42430" {...stroke} />
      <path class="mt-wing r" d="M64 52 Q88 40 84 18 Q76 30 70 26 Q70 40 58 46Z" fill="#c42430" {...stroke} />
      <path d="M50 90 Q16 92 18 76 Q20 62 42 66 Q70 70 78 80 Q86 92 64 92" fill="none" stroke={INK} stroke-width="13" stroke-linecap="round" />
      <path d="M50 90 Q16 92 18 76 Q20 62 42 66 Q70 70 78 80 Q86 92 64 92" fill="none" stroke="url(#mg-slifer)" stroke-width="9.6" stroke-linecap="round" />
      <path d="M24 72 l4 4 M34 66 l3 5 M60 70 l2 5 M72 76 l1 5" stroke="#ffcf6b" stroke-width="2" stroke-linecap="round" />
      <path d="M50 70 Q42 66 40 56" fill="none" stroke={INK} stroke-width="12" stroke-linecap="round" />
      <path d="M50 70 Q42 66 40 56" fill="none" stroke="url(#mg-slifer)" stroke-width="8.6" stroke-linecap="round" />
      <path d="M30 34 L22 16 L38 28 M70 34 L78 16 L62 28" fill="#ffcf6b" {...stroke} stroke-width="1.6" />
      <ellipse cx="50" cy="44" rx="22" ry="17" fill="url(#mg-slifer)" {...stroke} />
      <ellipse cx="50" cy="54" rx="13" ry="7" fill="#ff9a8a" opacity="0.8" />
      <path d="M40 60 Q50 66 60 60" stroke={INK} stroke-width="1.6" fill="#ffcf6b" />
      <path d="M44 28 l2 -6 l4 5 l4 -5 l2 6" fill="#ffcf6b" stroke={INK} stroke-width="1.2" />
      <Gloss x={40} y={36} r={5} />
      <FaceParts f={f} at={{ x: 50, y: 43, gap: 10, s: 0.9, eye: '#2a1a2e', mouthY: 53 }} />
    </g>
  ),
};

/** Mates dark enough to need a pale rim on the navy field. */
const DARK = new Set<string>(['redeyes', 'sangan', 'jinzo']);

/** A mate's figure with a face. */
export function MateArt({ id, face = 'idle', class: cls }: { id: MateId; face?: Face; class?: string }) {
  const draw = ART[id] ?? ART.blueeyes;
  return (
    <svg class={`mate-svg ${DARK.has(id) ? 'dark' : ''} ${cls ?? ''}`} viewBox="0 0 100 100" aria-hidden="true">
      {draw(face)}
    </svg>
  );
}
