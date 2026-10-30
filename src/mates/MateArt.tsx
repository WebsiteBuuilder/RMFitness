// The mates' drawings: small cel-shaded SVG figures (viewBox 0 0 100 100, standing on y≈94)
// with a face that changes with the reaction. All original designs.
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
}

/** Eyes, mouth and cheeks, drawn for a face. */
function FaceParts({ f, at }: { f: Face; at: FaceSpot }): VNode {
  const { x, y, gap, s } = at;
  const eye = at.eye ?? INK;
  const lx = x - gap;
  const rx = x + gap;
  const my = y + 8 * s;
  const sw = 2.2 * s;
  const arc = (cx: number, up: boolean) => <path d={`M${cx - 4 * s} ${y + (up ? 1.5 : -1) * s} Q${cx} ${y + (up ? -4 : 3.5) * s} ${cx + 4 * s} ${y + (up ? 1.5 : -1) * s}`} stroke={eye} stroke-width={sw} fill="none" stroke-linecap="round" />;
  const dot = (cx: number, r = 1) => (
    <g>
      <ellipse cx={cx} cy={y} rx={3.4 * s * r} ry={4.4 * s * r} fill={eye} />
      <circle cx={cx + 1.1 * s} cy={y - 1.6 * s} r={1.2 * s} fill="#fff" />
    </g>
  );
  const heart = (cx: number) => <path d={`M${cx} ${y + 3.6 * s} C${cx - 6 * s} ${y - 1 * s} ${cx - 3 * s} ${y - 6 * s} ${cx} ${y - 2.4 * s} C${cx + 3 * s} ${y - 6 * s} ${cx + 6 * s} ${y - 1 * s} ${cx} ${y + 3.6 * s}Z`} fill="#ff4f86" stroke={INK} stroke-width={0.8 * s} />;
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
      mouth = <path d={`M${x - 3.5 * s} ${my - 1 * s} Q${x} ${my + 3.5 * s} ${x + 3.5 * s} ${my - 1 * s}`} stroke={INK} stroke-width={sw * 0.8} fill="none" stroke-linecap="round" />;
      break;
    case 'laugh':
      eyes = <g>{arc(lx, true)}{arc(rx, true)}</g>;
      mouth = <path d={`M${x - 4.5 * s} ${my - 1.5 * s} Q${x} ${my - 1.5 * s} ${x + 4.5 * s} ${my - 1.5 * s} Q${x + 4 * s} ${my + 5 * s} ${x} ${my + 5 * s} Q${x - 4 * s} ${my + 5 * s} ${x - 4.5 * s} ${my - 1.5 * s}Z`} fill="#8a1f3a" stroke={INK} stroke-width={0.8 * s} />;
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
      mouth = <ellipse cx={x} cy={my + 0.5 * s} rx={2.2 * s} ry={3 * s} fill="#8a1f3a" stroke={INK} stroke-width={0.8 * s} />;
      break;
    case 'hurt':
      eyes = (
        <g stroke={eye} stroke-width={sw} fill="none" stroke-linecap="round">
          <path d={`M${lx - 3.5 * s} ${y - 3 * s} L${lx + 3 * s} ${y} L${lx - 3.5 * s} ${y + 3 * s}`} />
          <path d={`M${rx + 3.5 * s} ${y - 3 * s} L${rx - 3 * s} ${y} L${rx + 3.5 * s} ${y + 3 * s}`} />
        </g>
      );
      mouth = <path d={`M${x - 4 * s} ${my} q${s} ${-2 * s} ${2 * s} 0 t${2 * s} 0 t${2 * s} 0 t${2 * s} 0`} stroke={INK} stroke-width={sw * 0.7} fill="none" stroke-linecap="round" />;
      break;
    case 'sad':
      eyes = (
        <g>
          {dot(lx, 0.85)}
          {dot(rx, 0.85)}
          <path d={`M${lx - 4 * s} ${y - 5 * s} L${lx + 3 * s} ${y - 7 * s}`} stroke={INK} stroke-width={sw * 0.7} stroke-linecap="round" />
          <path d={`M${rx + 4 * s} ${y - 5 * s} L${rx - 3 * s} ${y - 7 * s}`} stroke={INK} stroke-width={sw * 0.7} stroke-linecap="round" />
          <path class="mt-tear" d={`M${lx - 1 * s} ${y + 4 * s} q${-1.8 * s} ${3 * s} 0 ${4.5 * s} q${1.8 * s} ${-1.5 * s} 0 ${-4.5 * s}Z`} fill="#7cd3ff" />
        </g>
      );
      mouth = <path d={`M${x - 3.5 * s} ${my + 2 * s} Q${x} ${my - 2.5 * s} ${x + 3.5 * s} ${my + 2 * s}`} stroke={INK} stroke-width={sw * 0.8} fill="none" stroke-linecap="round" />;
      break;
    case 'angry':
      eyes = (
        <g>
          {dot(lx, 0.8)}
          {dot(rx, 0.8)}
          <path d={`M${lx - 4.5 * s} ${y - 7 * s} L${lx + 3.5 * s} ${y - 4 * s}`} stroke={INK} stroke-width={sw} stroke-linecap="round" />
          <path d={`M${rx + 4.5 * s} ${y - 7 * s} L${rx - 3.5 * s} ${y - 4 * s}`} stroke={INK} stroke-width={sw} stroke-linecap="round" />
        </g>
      );
      mouth = (
        <g>
          <rect x={x - 4 * s} y={my - 1.5 * s} width={8 * s} height={3.6 * s} rx={1.2 * s} fill="#fff" stroke={INK} stroke-width={0.9 * s} />
          <path d={`M${x - 4 * s} ${my + 0.3 * s} H${x + 4 * s} M${x - 1.3 * s} ${my - 1.5 * s} V${my + 2.1 * s} M${x + 1.3 * s} ${my - 1.5 * s} V${my + 2.1 * s}`} stroke={INK} stroke-width={0.6 * s} />
        </g>
      );
      break;
    case 'love':
      eyes = <g>{heart(lx)}{heart(rx)}</g>;
      mouth = <path d={`M${x - 3 * s} ${my - 1 * s} Q${x} ${my + 3 * s} ${x + 3 * s} ${my - 1 * s}`} stroke={INK} stroke-width={sw * 0.8} fill="none" stroke-linecap="round" />;
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
      mouth = <path d={`M${x - 2.5 * s} ${my - 0.5 * s} Q${x} ${my + 2 * s} ${x + 2.5 * s} ${my - 0.5 * s}`} stroke={INK} stroke-width={sw * 0.7} fill="none" stroke-linecap="round" />;
  }
  return (
    <g class="mt-face">
      {cheeks}
      {eyes}
      {mouth}
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

/** Pip's fluff: little puffs round its body. */
const PUFFS = Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * Math.PI * 2;
  return [50 + Math.cos(a) * 26, 62 + Math.sin(a) * 25] as const;
});

const ART: Record<MateId, Draw> = {
  pip: (f) => {
    const puffs = (r: number) =>
      PUFFS.map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r={r} />);
    return (
      <g>
        <defs>{radial('mg-pip', '#fff6e4', '#f3b07e')}</defs>
        <Shadow />
        <ellipse cx="40" cy="91" rx="6" ry="3.5" fill="#c9774a" {...stroke} />
        <ellipse cx="60" cy="91" rx="6" ry="3.5" fill="#c9774a" {...stroke} />
        <g fill="#f3b07e" {...stroke}>{puffs(8)}</g>
        <g fill="url(#mg-pip)">{puffs(6.6)}</g>
        <circle cx="50" cy="62" r="26" fill="url(#mg-pip)" />
        <path d="M46 35 q-6 -10 2 -12 q-2 6 4 6 q4 -8 9 -3 q-6 1 -5 9" fill="#f3b07e" {...stroke} />
        <Gloss x={38} y={48} r={7} />
        <FaceParts f={f} at={{ x: 50, y: 62, gap: 9, s: 1.1 }} />
      </g>
    );
  },
  ember: (f) => (
    <g>
      <defs>
        {grad('mg-ember', '#ff8a3d', '#d8411f')}
        {grad('mg-flame', '#fff27a', '#ff6a00')}
      </defs>
      <Shadow w={28} />
      <path d="M66 80 Q86 82 84 64 Q83 56 78 54" fill="none" stroke={INK} stroke-width="9" stroke-linecap="round" />
      <path d="M66 80 Q86 82 84 64 Q83 56 78 54" fill="none" stroke="#e2552a" stroke-width="5.5" stroke-linecap="round" />
      <path class="mt-flame" d="M78 56 q-9 -8 -2 -20 q1 7 6 8 q2 -9 8 -12 q-2 10 3 16 q2 8 -6 10 z" fill="url(#mg-flame)" {...stroke} stroke-width="1.6" />
      <ellipse cx="50" cy="80" rx="19" ry="14" fill="url(#mg-ember)" {...stroke} />
      <ellipse cx="50" cy="83" rx="11" ry="9" fill="#ffd29a" />
      <ellipse cx="38" cy="91" rx="6" ry="3.6" fill="#c73a1a" {...stroke} />
      <ellipse cx="62" cy="91" rx="6" ry="3.6" fill="#c73a1a" {...stroke} />
      <ellipse cx="50" cy="50" rx="25" ry="21" fill="url(#mg-ember)" {...stroke} />
      <path d="M36 32 l4 -8 l4 7 M56 31 l4 -8 l4 8" fill="#ffd29a" {...stroke} stroke-width="1.6" />
      <Gloss x={38} y={40} r={6} />
      <FaceParts f={f} at={{ x: 50, y: 50, gap: 10, s: 1.05 }} />
    </g>
  ),
  bolt: (f) => (
    <g>
      <defs>
        {grad('mg-bolt', '#cfe0f5', '#7f97b8')}
        {grad('mg-boltb', '#a9bcd6', '#5d7393')}
      </defs>
      <Shadow />
      <line x1="50" y1="26" x2="50" y2="14" stroke={INK} stroke-width="2.4" />
      <circle class="mt-blink" cx="50" cy="12" r="4.5" fill="#ffd84a" {...stroke} stroke-width="1.6" />
      <rect x="35" y="70" width="30" height="20" rx="5" fill="url(#mg-boltb)" {...stroke} />
      <circle cx="50" cy="80" r="3.5" fill="#46e0ff" stroke={INK} stroke-width="1.2" />
      <path d="M35 76 q-10 2 -10 10 M65 76 q10 2 10 10" fill="none" stroke={INK} stroke-width="4" stroke-linecap="round" />
      <rect x="24" y="26" width="52" height="44" rx="12" fill="url(#mg-bolt)" {...stroke} />
      <rect x="30" y="33" width="40" height="30" rx="8" fill="#0f2235" stroke={INK} stroke-width="1.6" />
      <rect x="20" y="40" width="5" height="14" rx="2" fill="#7f97b8" {...stroke} stroke-width="1.6" />
      <rect x="75" y="40" width="5" height="14" rx="2" fill="#7f97b8" {...stroke} stroke-width="1.6" />
      <Gloss x={33} y={30} r={4} />
      <FaceParts f={f} at={{ x: 50, y: 46, gap: 9, s: 0.95, eye: '#46e0ff', flat: true }} />
    </g>
  ),
  sprout: (f) => (
    <g>
      <defs>{radial('mg-sprout', '#f4ffe0', '#9fd472')}</defs>
      <Shadow w={22} />
      <path d="M50 38 Q48 26 50 20" stroke="#3f8a2e" stroke-width="3" fill="none" />
      <path class="mt-leaf" d="M50 22 Q34 8 24 20 Q36 30 50 22Z" fill="#6cc24a" {...stroke} stroke-width="1.8" />
      <path class="mt-leaf r" d="M50 22 Q66 6 78 18 Q64 30 50 22Z" fill="#7fd458" {...stroke} stroke-width="1.8" />
      <path d="M50 36 C74 36 80 60 74 76 C70 88 30 88 26 76 C20 60 26 36 50 36Z" fill="url(#mg-sprout)" {...stroke} />
      <path d="M40 88 l-2 6 M50 89 v6 M60 88 l2 6" stroke="#8a6a3a" stroke-width="2.2" stroke-linecap="round" />
      <Gloss x={38} y={50} r={6} />
      <FaceParts f={f} at={{ x: 50, y: 62, gap: 9, s: 1 }} />
    </g>
  ),
  wisp: (f) => (
    <g>
      <defs>{grad('mg-wisp', '#c9f4ff', '#3d7dff')}</defs>
      <Shadow w={18} />
      <path class="mt-wisp" d="M50 14 C58 26 78 36 76 60 C75 76 64 86 56 84 C60 90 52 94 48 88 C44 94 36 90 40 84 C30 84 24 72 25 60 C26 42 42 34 50 14Z" fill="url(#mg-wisp)" {...stroke} opacity="0.95" />
      <path d="M50 34 C56 44 66 50 64 64 C62 74 38 74 36 64 C35 52 46 46 50 34Z" fill="#e9fbff" opacity="0.55" />
      <FaceParts f={f} at={{ x: 50, y: 60, gap: 8.5, s: 1, eye: '#1a2350' }} />
    </g>
  ),
  pebble: (f) => (
    <g>
      <defs>{radial('mg-pebble', '#c7c3bd', '#7b746c')}</defs>
      <Shadow w={30} />
      <path d="M20 86 C14 66 22 40 44 36 C66 30 84 48 82 72 C82 88 70 92 50 92 C34 92 24 92 20 86Z" fill="url(#mg-pebble)" {...stroke} />
      <path d="M30 44 C38 34 56 30 66 38 C60 40 50 38 46 44 C40 42 34 46 30 44Z" fill="#5fae4e" {...stroke} stroke-width="1.6" />
      <circle cx="62" cy="34" r="3" fill="#ffe14d" stroke={INK} stroke-width="1.2" />
      <path d="M70 78 l6 -4 M26 72 l5 2 M64 54 l5 -3" stroke="#5c564f" stroke-width="1.8" stroke-linecap="round" />
      <Gloss x={36} y={54} r={5} />
      <FaceParts f={f} at={{ x: 51, y: 64, gap: 10, s: 1.05 }} />
    </g>
  ),
  mimic: (f) => (
    <g>
      <defs>
        {grad('mg-mimic', '#b9733a', '#6e3c1a')}
        {grad('mg-gold', '#ffe58a', '#c8901c')}
      </defs>
      <Shadow w={30} />
      <rect x="20" y="58" width="60" height="34" rx="4" fill="url(#mg-mimic)" {...stroke} />
      <rect x="20" y="58" width="60" height="7" fill="url(#mg-gold)" {...stroke} stroke-width="1.6" />
      <rect x="44" y="62" width="12" height="12" rx="2" fill="url(#mg-gold)" {...stroke} stroke-width="1.6" />
      <rect x="22" y="44" width="56" height="16" fill="#1c0c12" />
      <path class="mt-tongue" d="M44 58 q6 14 14 2" fill="#ff5d7a" {...stroke} stroke-width="1.6" />
      <path d="M24 58 l4 -6 l4 6 l4 -6 l4 6 M60 58 l4 -6 l4 6 l4 -6 l4 6" fill="#fff" stroke={INK} stroke-width="1.2" />
      <g class="mt-lid">
        <path d="M18 44 Q18 22 50 22 Q82 22 82 44 Z" fill="url(#mg-mimic)" {...stroke} />
        <path d="M18 44 H82" stroke={INK} stroke-width="2.2" />
        <path d="M30 25 V44 M70 25 V44" stroke="url(#mg-gold)" stroke-width="5" />
        <path d="M24 44 l4 6 l4 -6 l4 6 l4 -6 M60 44 l4 6 l4 -6 l4 6 l4 -6" fill="#fff" stroke={INK} stroke-width="1.2" />
      </g>
      <FaceParts f={f} at={{ x: 50, y: 32, gap: 9, s: 0.85, eye: '#ffd23f', flat: true }} />
    </g>
  ),
  hoot: (f) => (
    <g>
      <defs>
        {grad('mg-hoot', '#a57a55', '#5d3d27')}
        {grad('mg-hat', '#8c6bff', '#3d2a99')}
      </defs>
      <Shadow />
      <ellipse cx="50" cy="66" rx="25" ry="27" fill="url(#mg-hoot)" {...stroke} />
      <ellipse cx="50" cy="74" rx="14" ry="15" fill="#f1dcb8" />
      <path d="M44 70 l3 3 l3 -3 l3 3 l3 -3 M44 78 l3 3 l3 -3 l3 3 l3 -3" stroke="#b38a5d" stroke-width="1.4" fill="none" />
      <path d="M26 62 Q16 74 26 84" fill="#5d3d27" {...stroke} />
      <path d="M74 62 Q84 74 74 84" fill="#5d3d27" {...stroke} />
      <circle cx="41" cy="54" r="9" fill="#fff4dc" {...stroke} stroke-width="1.6" />
      <circle cx="59" cy="54" r="9" fill="#fff4dc" {...stroke} stroke-width="1.6" />
      <path d="M47 61 L50 67 L53 61Z" fill="#ffb02e" {...stroke} stroke-width="1.4" />
      <path d="M40 92 l-3 3 M44 92 v3 M56 92 v3 M60 92 l3 3" stroke="#ffb02e" stroke-width="2.4" stroke-linecap="round" />
      <path d="M26 44 Q50 36 74 44 L72 40 Q60 30 54 8 Q40 22 30 40Z" fill="url(#mg-hat)" {...stroke} />
      <path d="M50 22 l1.6 3.4 l3.6 .4 l-2.7 2.4 l.8 3.6 l-3.3 -1.9 l-3.3 1.9 l.8 -3.6 l-2.7 -2.4 l3.6 -.4z" fill="#ffe14d" />
      <FaceParts f={f} at={{ x: 50, y: 54, gap: 9, s: 0.85 }} />
    </g>
  ),
  chill: (f) => {
    const shades = f === 'idle';
    return (
      <g>
        <defs>{grad('mg-chill', '#3a4660', '#141a28')}</defs>
        <Shadow />
        <ellipse cx="50" cy="60" rx="25" ry="32" fill="url(#mg-chill)" {...stroke} />
        <ellipse cx="50" cy="66" rx="17" ry="24" fill="#f5f7ff" />
        <path d="M25 58 Q14 70 22 80" fill="#141a28" {...stroke} />
        <path d="M75 58 Q86 70 78 80" fill="#141a28" {...stroke} />
        <ellipse cx="41" cy="92" rx="7" ry="3" fill="#ff9d2e" {...stroke} stroke-width="1.6" />
        <ellipse cx="59" cy="92" rx="7" ry="3" fill="#ff9d2e" {...stroke} stroke-width="1.6" />
        <FaceParts f={f} at={{ x: 50, y: 48, gap: 8, s: 0.9 }} />
        <path d="M46 56 L50 61 L54 56Z" fill="#ff9d2e" {...stroke} stroke-width="1.4" />
        <g transform={shades ? '' : 'translate(0 -12)'}>
          <path d="M33 44 H67 M35 44 q0 8 7 8 q6 0 6 -8 M52 44 q0 8 6 8 q7 0 7 -8" fill="#0a0a12" stroke={INK} stroke-width="2" />
          <path d="M37 46 l4 3 M54 46 l4 3" stroke="#7ee0ff" stroke-width="1.4" />
        </g>
        <Gloss x={38} y={34} r={5} />
      </g>
    );
  },
  scarab: (f) => (
    <g>
      <defs>
        {radial('mg-scarab', '#fff1a6', '#c58a12')}
        {grad('mg-scarabh', '#2a7f8a', '#11414a')}
      </defs>
      <Shadow w={30} />
      <path d="M26 70 l-10 -4 M26 78 l-12 2 M28 86 l-8 6 M74 70 l10 -4 M74 78 l12 2 M72 86 l8 6" stroke={INK} stroke-width="2.6" stroke-linecap="round" />
      <ellipse cx="50" cy="74" rx="26" ry="19" fill="url(#mg-scarab)" {...stroke} />
      <path d="M50 56 V93" stroke={INK} stroke-width="2" />
      <path d="M36 68 q4 -6 10 -6 M64 68 q-4 -6 -10 -6" stroke="#fff6c8" stroke-width="2" fill="none" opacity="0.7" />
      <path d="M50 30 q-3 -12 4 -18 q-2 10 2 14" fill="#2a7f8a" {...stroke} stroke-width="1.6" />
      <ellipse cx="50" cy="44" rx="19" ry="15" fill="url(#mg-scarabh)" {...stroke} />
      <Gloss x={42} y={38} r={4} />
      <FaceParts f={f} at={{ x: 50, y: 45, gap: 7.5, s: 0.85, eye: '#ffe17a', flat: true }} />
    </g>
  ),
  sphinx: (f) => (
    <g>
      <defs>
        {grad('mg-sphinx', '#f6d9a2', '#d39e5c')}
        {grad('mg-nemes', '#3a67d8', '#1f3a8a')}
      </defs>
      <Shadow w={28} />
      <path d="M68 86 Q86 86 84 70" fill="none" stroke={INK} stroke-width="7" stroke-linecap="round" />
      <path d="M68 86 Q86 86 84 70" fill="none" stroke="#d39e5c" stroke-width="3.8" stroke-linecap="round" />
      <ellipse cx="50" cy="80" rx="18" ry="13" fill="url(#mg-sphinx)" {...stroke} />
      <path d="M22 70 Q20 36 50 30 Q80 36 78 70 L68 74 Q66 60 50 60 Q34 60 32 74Z" fill="url(#mg-nemes)" {...stroke} />
      <path d="M26 58 H74 M24 66 H34 M66 66 H76 M30 46 Q50 38 70 46" stroke="#ffd84a" stroke-width="3" fill="none" />
      <path d="M33 34 l-4 -14 l12 8 M67 34 l4 -14 l-12 8" fill="#d39e5c" {...stroke} stroke-width="1.8" />
      <ellipse cx="50" cy="52" rx="18" ry="15" fill="url(#mg-sphinx)" {...stroke} />
      <path d="M44 33 h12 l-2 8 h-8z" fill="#ffd84a" {...stroke} stroke-width="1.4" />
      <path d="M33 56 h-8 M33 59 h-7 M67 56 h8 M67 59 h7" stroke={INK} stroke-width="1.1" />
      <FaceParts f={f} at={{ x: 50, y: 50, gap: 7.5, s: 0.85 }} />
    </g>
  ),
  gloop: (f) => (
    <g>
      <defs>{radial('mg-gloop', '#d8ffd0', '#33b85a')}</defs>
      <Shadow w={30} />
      <path class="mt-gloop" d="M18 90 C14 70 26 38 50 38 C74 38 86 70 82 90 C76 94 70 88 64 92 C58 96 54 90 48 93 C40 96 36 90 30 93 C24 95 20 93 18 90Z" fill="url(#mg-gloop)" {...stroke} opacity="0.94" />
      <circle cx="66" cy="78" r="3" fill="#fff" opacity="0.5" />
      <circle cx="31" cy="80" r="2" fill="#fff" opacity="0.5" />
      <Gloss x={36} y={50} r={7} />
      <FaceParts f={f} at={{ x: 50, y: 64, gap: 10, s: 1.05 }} />
    </g>
  ),
  kitsu: (f) => (
    <g>
      <defs>{grad('mg-kitsu', '#ffb15c', '#e2661c')}</defs>
      <Shadow w={28} />
      <path class="mt-tail" d="M62 84 Q88 86 86 60 Q84 48 76 46 Q82 62 66 74Z" fill="#e2661c" {...stroke} />
      <path d="M86 60 Q84 48 76 46 Q80 54 79 60Z" fill="#fff" />
      <path class="mt-tail r" d="M38 84 Q12 86 14 60 Q16 48 24 46 Q18 62 34 74Z" fill="#e2661c" {...stroke} />
      <path d="M14 60 Q16 48 24 46 Q20 54 21 60Z" fill="#fff" />
      <ellipse cx="50" cy="80" rx="15" ry="12" fill="url(#mg-kitsu)" {...stroke} />
      <ellipse cx="50" cy="83" rx="8" ry="7" fill="#fff4e6" />
      <path d="M28 46 L26 18 L44 34Z M72 46 L74 18 L56 34Z" fill="url(#mg-kitsu)" {...stroke} />
      <path d="M30 38 L29 24 L39 33Z M70 38 L71 24 L61 33Z" fill="#5a2a14" />
      <path d="M24 52 Q24 30 50 30 Q76 30 76 52 Q76 68 50 70 Q24 68 24 52Z" fill="url(#mg-kitsu)" {...stroke} />
      <path d="M34 60 Q50 74 66 60 Q62 70 50 70 Q38 70 34 60Z" fill="#fff4e6" />
      <path d="M44 36 l3 -4 l3 4 l3 -4 l3 4" stroke="#b8360f" stroke-width="1.4" fill="none" />
      <FaceParts f={f} at={{ x: 50, y: 51, gap: 9, s: 0.95 }} />
    </g>
  ),
  nova: (f) => (
    <g>
      <defs>
        {radial('mg-nova', '#fffbe0', '#ffc21f')}
        <radialGradient id="mg-novaglow">
          <stop offset="0.3" stop-color="#ffe88a" stop-opacity="0.45" />
          <stop offset="1" stop-color="#ffe88a" stop-opacity="0" />
        </radialGradient>
      </defs>
      <circle class="mt-glow" cx="50" cy="56" r="40" fill="url(#mg-novaglow)" />
      <Shadow w={18} />
      <path d="M50 18 Q56 40 60 42 Q80 42 86 46 Q70 58 68 62 Q74 82 72 90 Q56 78 50 78 Q44 78 28 90 Q26 82 32 62 Q30 58 14 46 Q20 42 40 42 Q44 40 50 18Z" fill="url(#mg-nova)" {...stroke} />
      <Gloss x={42} y={46} r={5} />
      <FaceParts f={f} at={{ x: 50, y: 56, gap: 8, s: 0.95 }} />
      <circle class="mt-twinkle" cx="80" cy="24" r="2.2" fill="#fff" />
      <circle class="mt-twinkle b" cx="20" cy="30" r="1.6" fill="#fff" />
    </g>
  ),
  drake: (f) => (
    <g>
      <defs>
        {grad('mg-drake', '#8fa2ff', '#4b4fc4')}
        {grad('mg-gold2', '#fff0a0', '#d49a18')}
      </defs>
      <Shadow w={28} />
      <path class="mt-wing" d="M30 64 Q8 52 10 32 Q22 40 26 36 Q28 48 36 54Z" fill="#6f78e8" {...stroke} />
      <path class="mt-wing r" d="M70 64 Q92 52 90 32 Q78 40 74 36 Q72 48 64 54Z" fill="#6f78e8" {...stroke} />
      <path d="M64 86 Q84 90 86 76" fill="none" stroke={INK} stroke-width="7" stroke-linecap="round" />
      <path d="M64 86 Q84 90 86 76" fill="none" stroke="#5c62d6" stroke-width="3.8" stroke-linecap="round" />
      <ellipse cx="50" cy="78" rx="18" ry="15" fill="url(#mg-drake)" {...stroke} />
      <ellipse cx="50" cy="81" rx="10" ry="10" fill="#ffe7b0" />
      <path d="M50 70 v20 M44 74 h12 M44 80 h12 M45 86 h10" stroke="#e8c27c" stroke-width="1.2" />
      <path d="M33 36 l-6 -10 l10 4 M67 36 l6 -10 l-10 4" fill="#ffe7b0" {...stroke} stroke-width="1.6" />
      <ellipse cx="50" cy="50" rx="22" ry="18" fill="url(#mg-drake)" {...stroke} />
      <path d="M38 33 l3 -10 l6 6 l3 -9 l3 9 l6 -6 l3 10z" fill="url(#mg-gold2)" {...stroke} stroke-width="1.6" />
      <circle cx="50" cy="27" r="1.8" fill="#ff4f6d" />
      <Gloss x={40} y={42} r={5} />
      <FaceParts f={f} at={{ x: 50, y: 51, gap: 9, s: 0.95 }} />
    </g>
  ),
};

/** A mate's figure with a face. */
export function MateArt({ id, face = 'idle', class: cls }: { id: MateId; face?: Face; class?: string }) {
  const draw = ART[id] ?? ART.pip;
  return (
    <svg class={`mate-svg ${cls ?? ''}`} viewBox="0 0 100 100" aria-hidden="true">
      {draw(face)}
    </svg>
  );
}
