// The playmat pictures: each one an SVG for ONE duelist's half of the field (380 x 220), drawn
// once and turned into a data URL. The near edge (where the duelist sits) is the bottom, the
// middle of the board is the top; the opponent's half is the same picture turned round.
//
// A mat is two pictures: the scene (it fades back when a Field Spell's landscape takes the
// half) and the trim round its edges (it always stays). No images to download, nothing redrawn
// in a duel: the browser decodes each picture once and reuses it.

export const W = 380;
export const H = 220;
const CX = 190;
const CY = 104;

const f = (n: number) => +n.toFixed(1);

/** A small seeded random (the same scatter of stars, windows and stones every time). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** n things scattered over a box, each drawn by fn(x, y, r 0..1, i). */
function scatter(n: number, seed: number, box: [number, number, number, number], fn: (x: number, y: number, r: number, i: number) => string): string {
  const r = rng(seed);
  let out = '';
  for (let i = 0; i < n; i++) out += fn(f(box[0] + r() * box[2]), f(box[1] + r() * box[3]), r(), i);
  return out;
}
/** Points round a circle. */
function around(n: number, r: number, cx = CX, cy = CY, turn = -90): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = ((turn + (360 * i) / n) * Math.PI) / 180;
    return [f(cx + r * Math.cos(a)), f(cy + r * Math.sin(a))];
  });
}
/** A star polygon's points. */
function star(n: number, r1: number, r2: number, cx = CX, cy = CY, turn = -90): string {
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? r2 : r1;
    const a = ((turn + (180 * i) / n) * Math.PI) / 180;
    pts.push(`${f(cx + r * Math.cos(a))},${f(cy + r * Math.sin(a))}`);
  }
  return pts.join(' ');
}
/** Rays out from a point. */
function rays(n: number, r0: number, r1: number, stroke: string, width: number, opacity: number, cx = CX, cy = CY, turn = -90): string {
  const a = around(n, r0, cx, cy, turn);
  const b = around(n, r1, cx, cy, turn);
  return `<g stroke='${stroke}' stroke-width='${width}' stroke-opacity='${opacity}' stroke-linecap='round'>${a.map(([x, y], i) => `<line x1='${x}' y1='${y}' x2='${b[i][0]}' y2='${b[i][1]}'/>`).join('')}</g>`;
}
const lin = (id: string, stops: [number, string, number?][], x2 = 0, y2 = 1) =>
  `<linearGradient id='${id}' x1='0' y1='0' x2='${x2}' y2='${y2}'>${stops.map(([o, c, a]) => `<stop offset='${o}' stop-color='${c}'${a !== undefined ? ` stop-opacity='${a}'` : ''}/>`).join('')}</linearGradient>`;
const rad = (id: string, stops: [number, string, number?][], cx = '50%', cy = '50%', r = '60%') =>
  `<radialGradient id='${id}' cx='${cx}' cy='${cy}' r='${r}'>${stops.map(([o, c, a]) => `<stop offset='${o}' stop-color='${c}'${a !== undefined ? ` stop-opacity='${a}'` : ''}/>`).join('')}</radialGradient>`;
const fill = (id: string) => `<rect width='${W}' height='${H}' fill='url(#${id})'/>`;
/** The dark falloff toward the near corners, so the cards always read over the picture. */
const VIGNETTE = rad('vg', [[0.45, '#000', 0], [1, '#000', 0.55]], '50%', '40%', '75%');
const vignette = fill('vg');

function svg(defs: string, body: string): string {
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' preserveAspectRatio='xMidYMid slice'><defs>${defs}${VIGNETTE}</defs>${body}${vignette}</svg>`;
}

// ---------- emblems (centred on the half's middle, behind the Monster Zones) ----------

/** The duel-ring geometry: rings, a hexagram and a diamond (the classic mat's seal). */
function seal(color: string, op = 0.3, r = 74): string {
  return (
    `<g fill='none' stroke='${color}' stroke-opacity='${op}'>` +
    `<circle cx='${CX}' cy='${CY}' r='${r}' stroke-width='1.6'/>` +
    `<circle cx='${CX}' cy='${CY}' r='${f(r * 0.86)}' stroke-dasharray='2 5'/>` +
    `<circle cx='${CX}' cy='${CY}' r='${f(r * 0.56)}' stroke-width='2'/>` +
    `<polygon points='${star(6, r * 0.98, r * 0.98 * 0.577, CX, CY)}' stroke-width='1.1' stroke-linejoin='round' transform='rotate(30 ${CX} ${CY})'/>` +
    `<polygon points='${around(4, r * 0.5).map((p) => p.join(',')).join(' ')}' stroke-width='1'/>` +
    `<circle cx='${CX}' cy='${CY}' r='${f(r * 0.12)}' stroke-width='1.4'/>` +
    `</g>` +
    `<g fill='${color}' fill-opacity='${op * 1.4}'>${around(12, r * 0.93).map(([x, y]) => `<circle cx='${x}' cy='${y}' r='1.3'/>`).join('')}</g>`
  );
}
/** The Eye of Wdjat. */
function eye(cx: number, cy: number, w: number, color: string, iris: string, op = 1): string {
  const s = w / 60;
  const P = (x: number, y: number) => `${f(cx + x * s)} ${f(cy + y * s)}`;
  return (
    `<g opacity='${op}'><g fill='none' stroke='${color}' stroke-width='${f(3 * s)}' stroke-linecap='round' stroke-linejoin='round'>` +
    `<path d='M${P(-30, -15)} Q${P(0, -30)} ${P(30, -17)}'/>` +
    `<path d='M${P(-30, 0)} Q${P(0, -20)} ${P(30, -1)} Q${P(0, 14)} ${P(-30, 0)} Z'/>` +
    `<path d='M${P(-6, 9)} L${P(-12, 26)}'/>` +
    `<path d='M${P(8, 9)} Q${P(14, 26)} ${P(26, 24)} Q${P(33, 22)} ${P(29, 15)}'/>` +
    `</g><circle cx='${f(cx)}' cy='${f(cy - 3 * s)}' r='${f(7.5 * s)}' fill='${iris}' stroke='${color}' stroke-width='${f(1.5 * s)}'/></g>`
  );
}
/** An ankh. */
function ankh(cx: number, cy: number, h: number, color: string, op = 1): string {
  const s = h / 60;
  return `<g fill='none' stroke='${color}' stroke-opacity='${op}' stroke-width='${f(5 * s)}' stroke-linecap='round'><ellipse cx='${cx}' cy='${f(cy - 18 * s)}' rx='${f(8 * s)}' ry='${f(11 * s)}'/><path d='M${cx} ${f(cy - 7 * s)}V${f(cy + 30 * s)}M${f(cx - 16 * s)} ${f(cy - 3 * s)}H${f(cx + 16 * s)}'/></g>`;
}
/** A flame shape. */
function flame(cx: number, by: number, h: number, c: string, op = 1): string {
  const w = h * 0.42;
  return `<path d='M${f(cx)} ${f(by - h)} C${f(cx + w * 0.4)} ${f(by - h * 0.7)} ${f(cx + w)} ${f(by - h * 0.5)} ${f(cx + w * 0.8)} ${f(by - h * 0.2)} C${f(cx + w * 0.7)} ${f(by)} ${f(cx - w * 0.7)} ${f(by)} ${f(cx - w * 0.8)} ${f(by - h * 0.22)} C${f(cx - w)} ${f(by - h * 0.45)} ${f(cx - w * 0.2)} ${f(by - h * 0.55)} ${f(cx)} ${f(by - h)} Z' fill='${c}' fill-opacity='${op}'/>`;
}

// ---------- the trim round a half (left, near and right edges; the middle edge is open) ----------

type Ornament = 'diamond' | 'ankh' | 'star' | 'gem' | 'wing' | 'none';
function trim(metal: [string, string, string], accent: string, orn: Ornament = 'diamond', line = metal[0]): string {
  const o = 3.2;
  const i = 9.5;
  const corner = (x: number, sx: number) => {
    const y = H - i;
    const L = `M${x} ${y - 26}V${y}h${sx * 26}`;
    const d = x + sx * 7;
    const gem =
      orn === 'none'
        ? ''
        : orn === 'star'
          ? `<polygon points='${star(4, 5.5, 1.8, d, y - 7, 0)}' fill='${accent}'/>`
          : orn === 'ankh'
            ? ankh(d, y - 5, 13, accent)
            : orn === 'wing'
              ? `<path d='M${d - sx * 3} ${y - 3} q${sx * 9} -3 ${sx * 13} -12 q-${sx * 2} 8 -${sx * 9} 13 z' fill='${accent}'/>`
              : `<path d='M${d} ${y - 12}l5 5l-5 5l-5 -5z' fill='${accent}' stroke='${metal[0]}' stroke-width='.8'/>`;
    return `<path d='${L}' fill='none' stroke='url(#tm)' stroke-width='2.4' stroke-linecap='square'/>${gem}`;
  };
  const studs = [44, 110, 176]
    .map((y) => `<circle cx='${o + 0.2}' cy='${y}' r='2.2' fill='url(#tm)'/><circle cx='${W - o - 0.2}' cy='${y}' r='2.2' fill='url(#tm)'/>`)
    .join('');
  // the plaque at the middle of the near edge, with a gem in the mat's colour
  const plaque = `<path d='M${CX - 46} ${H - o}L${CX - 38} ${H - 11}H${CX + 38}L${CX + 46} ${H - o}Z' fill='url(#tm)' stroke='#000' stroke-opacity='.4' stroke-width='.6'/><path d='M${CX} ${H - 12.5}l4.5 4.5l-4.5 4.5l-4.5 -4.5z' fill='${accent}' stroke='#fff' stroke-opacity='.6' stroke-width='.6'/><path d='M${CX - 30} ${H - 7.5}H${CX - 9}M${CX + 9} ${H - 7.5}H${CX + 30}' stroke='#000' stroke-opacity='.35' stroke-width='1'/>`;
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' preserveAspectRatio='none'><defs>` +
    `<linearGradient id='tm' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${metal[0]}'/><stop offset='.45' stop-color='${metal[1]}'/><stop offset='.7' stop-color='${metal[2]}'/><stop offset='1' stop-color='${metal[1]}'/></linearGradient></defs>` +
    // a dark bed under the metal, the metal band, its bright lip and a fine inner line
    `<path d='M${o} 0V${H - o - 5}q0 5 5 5H${W - o - 5}q5 0 5 -5V0' fill='none' stroke='#000' stroke-opacity='.55' stroke-width='6.5'/>` +
    `<path d='M${o} 0V${H - o - 5}q0 5 5 5H${W - o - 5}q5 0 5 -5V0' fill='none' stroke='url(#tm)' stroke-width='3.4'/>` +
    `<path d='M${o - 1.2} 0V${H - o - 5}q0 6 6 6H${W - o - 5}' fill='none' stroke='#fff' stroke-opacity='.35' stroke-width='.6'/>` +
    `<path d='M${i} 0V${H - i}H${W - i}V0' fill='none' stroke='${line}' stroke-opacity='.4' stroke-width='.8'/>` +
    `<path d='M${i + 3} 0V${H - i - 3}H${W - i - 3}V0' fill='none' stroke='${line}' stroke-opacity='.18' stroke-width='.6' stroke-dasharray='1 3'/>` +
    corner(i, 1) +
    corner(W - i, -1) +
    studs +
    plaque +
    `</svg>`
  );
}
const GOLD: [string, string, string] = ['#fbe7a8', '#9a6a2a', '#f0cf7a'];
const SILVER: [string, string, string] = ['#f4f8ff', '#717c8e', '#d9e2f0'];
const BRONZE: [string, string, string] = ['#f2c79a', '#7a4422', '#d79a62'];
const OBSIDIAN: [string, string, string] = ['#b9a6e8', '#2a1f44', '#7d68b8'];
const CHROME: [string, string, string] = ['#e6fbff', '#3c6a7a', '#9fe6ff'];

// ---------- the mats ----------

/** Tournament Blue: the classic duel-ring seal on deep blue, fine grid and a sheen. */
const blue = svg(
  rad('bg', [[0, '#2a48b8'], [0.5, '#132466'], [1, '#060c2c']], '50%', '45%', '75%') +
    `<pattern id='gr' width='19' height='19' patternUnits='userSpaceOnUse'><path d='M19 0H0V19' fill='none' stroke='#9fb8ff' stroke-opacity='.09' stroke-width='.7'/></pattern>` +
    lin('sh', [[0, '#fff', 0.14], [0.3, '#fff', 0], [1, '#000', 0.3]], 0.3, 1),
  fill('bg') +
    fill('gr') +
    rays(24, 84, 260, '#8fb0ff', 0.6, 0.12) +
    seal('#cfe0ff', 0.32, 80) +
    `<circle cx='${CX}' cy='${CY}' r='30' fill='#6c94ff' fill-opacity='.12'/>` +
    `<path d='M0 150H380M0 154H380' stroke='#a9c0ff' stroke-opacity='.12'/>` +
    fill('sh'),
);
const blueTrim = trim(SILVER, '#6cc4ff', 'diamond', '#cfe0ff');

/** Crimson Arena: dark red stone, gold pinstripes and a gold eight-point star. */
const crimson = svg(
  rad('bg', [[0, '#8a1424'], [0.55, '#3c0812'], [1, '#120206']], '50%', '42%', '78%') +
    `<pattern id='ps' width='14' height='14' patternUnits='userSpaceOnUse' patternTransform='rotate(35)'><path d='M0 0V14' stroke='#ffcf6a' stroke-opacity='.08' stroke-width='1'/></pattern>` +
    rad('gl', [[0, '#ffb04a', 0.35], [1, '#ffb04a', 0]]),
  fill('bg') +
    fill('ps') +
    `<circle cx='${CX}' cy='${CY}' r='90' fill='url(#gl)'/>` +
    `<g fill='none' stroke='#f0cf7a' stroke-opacity='.45'><circle cx='${CX}' cy='${CY}' r='78' stroke-width='2'/><circle cx='${CX}' cy='${CY}' r='72' stroke-width='.8'/><circle cx='${CX}' cy='${CY}' r='40' stroke-width='1.2'/></g>` +
    `<polygon points='${star(8, 66, 30)}' fill='#f0cf7a' fill-opacity='.14' stroke='#f6dc96' stroke-opacity='.55' stroke-width='1.2' stroke-linejoin='round'/>` +
    `<polygon points='${star(8, 36, 16, CX, CY, -67.5)}' fill='#ff5a5a' fill-opacity='.3' stroke='#f6dc96' stroke-opacity='.5'/>` +
    `<circle cx='${CX}' cy='${CY}' r='9' fill='#ff3b4f' stroke='#fbe7a8' stroke-width='1.4' stroke-opacity='.8'/>` +
    `<g stroke='#f0cf7a' stroke-opacity='.25'><path d='M14 32H120M260 32H366M14 186H130M250 186H366'/></g>` +
    scatter(10, 4, [20, 20, 340, 180], (x, y) => `<path d='M${x} ${y}l3 3l-3 3l-3 -3z' fill='#f6dc96' fill-opacity='.2'/>`),
);
const crimsonTrim = trim(GOLD, '#ff3b4f', 'gem');

/** Duelist Kingdom: the island at sunset, the castle on its cliff, the sea between. */
const kingdom = svg(
  lin('sky', [[0, '#3a1e5c'], [0.18, '#c2506a'], [0.32, '#ffb36a'], [0.42, '#ffd9a0']]) +
    lin('sea', [[0, '#3a5a8a'], [1, '#0c1a3a']]) +
    lin('rock', [[0, '#7a6450'], [1, '#2a1e18']]) +
    lin('grass', [[0, '#5a7a3a'], [1, '#2a3a1a']]) +
    rad('sun', [[0, '#fff6d0'], [0.4, '#ffd27a', 0.9], [1, '#ff8a4a', 0]]),
  `<rect width='${W}' height='${H}' fill='url(#sea)'/>` +
    `<rect width='${W}' height='96' fill='url(#sky)'/>` +
    `<circle cx='250' cy='80' r='46' fill='url(#sun)'/>` +
    // far island and the castle on it
    `<path d='M60 92 Q90 70 120 74 L150 60 L176 66 L200 52 L232 70 L270 72 Q300 80 320 92 Z' fill='#4a3050'/>` +
    `<g fill='#2a1a34'><rect x='170' y='34' width='8' height='34'/><rect x='184' y='22' width='12' height='46'/><rect x='202' y='30' width='8' height='38'/><rect x='160' y='46' width='60' height='22'/>` +
    `<path d='M168 34l6 -9l6 9zM182 22l8 -12l8 12zM200 30l6 -9l6 9z'/></g>` +
    `<g fill='#ffd27a' fill-opacity='.7'><rect x='188' y='36' width='2' height='4'/><rect x='172' y='50' width='2' height='3'/><rect x='206' y='44' width='2' height='3'/></g>` +
    // the sea: light on the water and lines of swell
    `<path d='M0 96H380' stroke='#ffe2b0' stroke-opacity='.6'/>` +
    `<path d='M216 100h70M226 106h48M236 112h30' stroke='#ffd9a0' stroke-opacity='.45' stroke-width='1.4' stroke-linecap='round'/>` +
    scatter(26, 7, [0, 100, 380, 70], (x, y, r) => `<path d='M${x} ${y}q${f(6 + r * 8)} -3 ${f(14 + r * 14)} 0' fill='none' stroke='#cfe6ff' stroke-opacity='${f(0.12 + r * 0.2)}' stroke-width='1'/>`) +
    // the near cliffs on each side, grass on top, and the stone ledge in front
    `<path d='M0 118 Q34 110 62 124 L90 150 Q70 186 96 220 H0 Z' fill='url(#rock)'/>` +
    `<path d='M0 118 Q34 110 62 124 L70 132 Q36 122 0 128 Z' fill='url(#grass)'/>` +
    `<path d='M380 112 Q344 108 314 124 L290 152 Q312 186 284 220 H380 Z' fill='url(#rock)'/>` +
    `<path d='M380 112 Q344 108 314 124 L308 132 Q344 120 380 124 Z' fill='url(#grass)'/>` +
    `<path d='M60 196 Q190 168 320 196 L340 220 H40 Z' fill='#4a3a2c'/>` +
    `<path d='M60 196 Q190 168 320 196' fill='none' stroke='#c8a070' stroke-opacity='.5' stroke-width='1.2'/>` +
    scatter(16, 9, [70, 192, 240, 24], (x, y, r) => `<ellipse cx='${x}' cy='${y}' rx='${f(4 + r * 7)}' ry='${f(2 + r * 2)}' fill='#6a5440' fill-opacity='.8'/>`) +
    `<g stroke='#2a1e18' stroke-opacity='.5' fill='none'><path d='M20 150l14 10l-4 14M40 140l10 16M330 146l-12 12l6 12M350 160l-10 14'/></g>` +
    seal('#ffe2b0', 0.14, 70),
);
const kingdomTrim = trim(BRONZE, '#ffb36a', 'diamond');

/** Duel Disk Grid: dark glass, a hex grid, circuits running in to a cyan core. */
const disk = svg(
  rad('bg', [[0, '#0e3a4a'], [0.55, '#06161e'], [1, '#020608']], '50%', '45%', '75%') +
    `<pattern id='hx' width='24' height='41.6' patternUnits='userSpaceOnUse'><path d='M12 0L24 6.9V20.8L12 27.7L0 20.8V6.9ZM12 27.7V41.6' fill='none' stroke='#3ae0ff' stroke-opacity='.1' stroke-width='.8'/></pattern>` +
    rad('core', [[0, '#bff6ff'], [0.25, '#3ae0ff', 0.7], [1, '#3ae0ff', 0]]),
  fill('bg') +
    fill('hx') +
    // circuits from the edges toward the core
    `<g fill='none' stroke='#3ae0ff' stroke-opacity='.4' stroke-width='1.2' stroke-linejoin='round'>` +
    `<path d='M0 40H60L80 60H112'/><path d='M0 168H44L70 142H118'/><path d='M380 40H320L300 60H268'/><path d='M380 168H336L310 142H262'/>` +
    `<path d='M120 220V190L140 170'/><path d='M260 220V190L240 170'/><path d='M190 220V184'/>` +
    `</g>` +
    `<g fill='#9ff2ff'>${[[112, 60], [118, 142], [268, 60], [262, 142], [140, 170], [240, 170], [190, 184]].map(([x, y]) => `<circle cx='${x}' cy='${y}' r='2.4'/>`).join('')}</g>` +
    `<circle cx='${CX}' cy='${CY}' r='64' fill='url(#core)' fill-opacity='.35'/>` +
    `<g fill='none' stroke='#3ae0ff'><circle cx='${CX}' cy='${CY}' r='70' stroke-opacity='.5' stroke-width='1.4' stroke-dasharray='30 6 4 6'/><circle cx='${CX}' cy='${CY}' r='56' stroke-opacity='.3' stroke-width='6' stroke-dasharray='2 4'/><circle cx='${CX}' cy='${CY}' r='38' stroke-opacity='.6' stroke-width='1.6'/><circle cx='${CX}' cy='${CY}' r='14' stroke-opacity='.9' stroke-width='2'/></g>` +
    rays(8, 40, 54, '#9ff2ff', 1.6, 0.6) +
    `<circle cx='${CX}' cy='${CY}' r='6' fill='#e6fbff'/>` +
    `<path d='M0 104H110M270 104H380' stroke='#3ae0ff' stroke-opacity='.25' stroke-dasharray='6 4'/>`,
);
const diskTrim = trim(CHROME, '#3ae0ff', 'diamond', '#9ff2ff');

/** One of the six Attribute mats: a field of its colour, its sigil big in the middle. */
function attribute(bg: [string, string, string], ink: string, glow: string, extra: string, sigil: string, defs = ''): string {
  return svg(
    rad('bg', [[0, bg[0]], [0.55, bg[1]], [1, bg[2]]], '50%', '45%', '78%') + rad('gl', [[0, glow, 0.55], [1, glow, 0]]) + defs,
    fill('bg') +
      extra +
      `<circle cx='${CX}' cy='${CY}' r='96' fill='url(#gl)'/>` +
      `<g fill='none' stroke='${ink}'><circle cx='${CX}' cy='${CY}' r='80' stroke-opacity='.5' stroke-width='2'/><circle cx='${CX}' cy='${CY}' r='74' stroke-opacity='.3' stroke-dasharray='1 4' stroke-width='2'/><circle cx='${CX}' cy='${CY}' r='50' stroke-opacity='.25'/></g>` +
      `<g fill='${ink}' fill-opacity='.5'>${around(8, 80).map(([x, y]) => `<circle cx='${x}' cy='${y}' r='2.4'/>`).join('')}</g>` +
      sigil,
  );
}

const light = attribute(
  ['#fff6d0', '#c9a24a', '#3a2a0c'],
  '#fffbe8',
  '#fff2b0',
  rays(36, 30, 300, '#fffbe8', 1.2, 0.2) + rays(12, 90, 300, '#fff6c0', 4, 0.12, CX, CY, -75) + `<path d='M0 168H380M0 172H380' stroke='#fff2b0' stroke-opacity='.25'/>`,
  `<polygon points='${star(12, 44, 20)}' fill='#fffbe8' fill-opacity='.5' stroke='#fff' stroke-opacity='.8'/><circle cx='${CX}' cy='${CY}' r='16' fill='#fff' fill-opacity='.85'/>`,
);
const dark = attribute(
  ['#3a1a5c', '#170a2a', '#05020a'],
  '#c49bff',
  '#8a4aff',
  `<g fill='none' stroke='#b36bff' stroke-opacity='.2'><ellipse cx='${CX}' cy='${CY}' rx='170' ry='60' transform='rotate(-14 ${CX} ${CY})'/><ellipse cx='${CX}' cy='${CY}' rx='150' ry='40' transform='rotate(18 ${CX} ${CY})'/></g>` +
    scatter(40, 21, [0, 0, 380, 220], (x, y, r) => `<circle cx='${x}' cy='${y}' r='${f(0.4 + r)}' fill='#e6d0ff' fill-opacity='${f(0.2 + r * 0.4)}'/>`),
  `<circle cx='${CX}' cy='${CY}' r='34' fill='#05020a' stroke='#c49bff' stroke-opacity='.8' stroke-width='1.6'/><circle cx='${CX + 10}' cy='${CY - 8}' r='28' fill='#3a1a5c' fill-opacity='.6'/><circle cx='${CX}' cy='${CY}' r='34' fill='none' stroke='#8a4aff' stroke-width='6' stroke-opacity='.25'/>`,
);
const fire = attribute(
  ['#ff7a1a', '#7a1606', '#1a0402'],
  '#ffd27a',
  '#ff5a1a',
  // magma veins across the floor, flames along the near edge
  `<g fill='none' stroke='#ffb04a' stroke-linecap='round' stroke-opacity='.5'><path d='M0 60l40 14l20 -10l34 22l16 -6' stroke-width='1.6'/><path d='M380 54l-36 20l-24 -6l-30 24' stroke-width='1.6'/><path d='M20 140l36 -6l18 18l30 -4' stroke-width='1.2'/><path d='M360 146l-30 -10l-24 16l-26 -2' stroke-width='1.2'/></g>` +
    Array.from({ length: 14 }, (_, i) => flame(14 + i * 27.5, 222, 30 + ((i * 37) % 26), i % 2 ? '#ff7a1a' : '#ffb04a', 0.45)).join(''),
  flame(CX, CY + 40, 82, '#ff7a1a', 0.6) + flame(CX, CY + 36, 54, '#ffd27a', 0.7) + flame(CX, CY + 32, 26, '#fff6d0', 0.8),
);
const water = attribute(
  ['#3ab0e0', '#0a3a6a', '#020a1a'],
  '#cff0ff',
  '#5fd0ff',
  // caustic light and rings of swell
  `<g fill='none' stroke='#cff0ff' stroke-opacity='.13' stroke-width='1.4'>${Array.from({ length: 7 }, (_, i) => `<path d='M0 ${24 + i * 30} Q47 ${12 + i * 30} 95 ${24 + i * 30} T190 ${24 + i * 30} T285 ${24 + i * 30} T380 ${24 + i * 30}'/>`).join('')}</g>` +
    `<g fill='none' stroke='#cff0ff'><ellipse cx='${CX}' cy='${CY}' rx='120' ry='36' stroke-opacity='.18'/><ellipse cx='${CX}' cy='${CY}' rx='160' ry='52' stroke-opacity='.1'/></g>` +
    scatter(18, 33, [0, 0, 380, 220], (x, y, r) => `<circle cx='${x}' cy='${y}' r='${f(1.5 + r * 3)}' fill='none' stroke='#cff0ff' stroke-opacity='.3'/>`),
  `<path d='M${CX} ${CY - 46} C${CX + 10} ${CY - 26} ${CX + 30} ${CY - 8} ${CX + 30} ${CY + 10} A30 30 0 0 1 ${CX - 30} ${CY + 10} C${CX - 30} ${CY - 8} ${CX - 10} ${CY - 26} ${CX} ${CY - 46} Z' fill='#5fd0ff' fill-opacity='.45' stroke='#e6f8ff' stroke-opacity='.8' stroke-width='1.6'/><path d='M${CX - 14} ${CY + 6} q2 14 16 18' fill='none' stroke='#fff' stroke-opacity='.7' stroke-width='2.4' stroke-linecap='round'/>`,
);
const earth = attribute(
  ['#b88a50', '#4a3016', '#140c04'],
  '#f2d8a8',
  '#c8a060',
  `<pattern id='st' width='30' height='26' patternUnits='userSpaceOnUse'><path d='M0 13L7.5 0H22.5L30 13L22.5 26H7.5Z' fill='none' stroke='#2a1a08' stroke-opacity='.45' stroke-width='1.4'/><path d='M8 2H22' stroke='#f2d8a8' stroke-opacity='.12'/></pattern>` +
    fill('st') +
    `<g fill='none' stroke='#1a0e04' stroke-opacity='.55' stroke-width='1.4'><path d='M30 0l14 30l-10 24l16 30M350 220l-12 -30l14 -20l-8 -30M120 220l10 -20l-6 -16'/></g>`,
  `<path d='M${CX - 52} ${CY + 30} L${CX - 18} ${CY - 30} L${CX - 4} ${CY - 10} L${CX + 12} ${CY - 40} L${CX + 52} ${CY + 30} Z' fill='#6a4a22' fill-opacity='.7' stroke='#f2d8a8' stroke-opacity='.8' stroke-width='1.6' stroke-linejoin='round'/><path d='M${CX + 12} ${CY - 40} L${CX + 4} ${CY - 22} L${CX + 20} ${CY - 26} Z M${CX - 18} ${CY - 30} L${CX - 24} ${CY - 18} L${CX - 12} ${CY - 20} Z' fill='#fff6e0' fill-opacity='.75'/>`,
);
const wind = attribute(
  ['#8ae8b8', '#1e6a4a', '#04140c'],
  '#e6fff2',
  '#7ad8a4',
  `<g fill='none' stroke='#e6fff2' stroke-linecap='round' stroke-opacity='.22' stroke-width='1.6'>${Array.from({ length: 6 }, (_, i) => `<path d='M${-20 + i * 14} ${30 + i * 32} q90 -26 180 0 t180 0'/>`).join('')}</g>` +
    scatter(14, 51, [0, 0, 380, 220], (x, y, r) => `<path d='M${x} ${y}q5 -6 10 0q-5 6 -10 0z' fill='#b8f2d0' fill-opacity='.4' transform='rotate(${f(r * 360)} ${x} ${y})'/>`),
  `<g fill='none' stroke='#e6fff2' stroke-linecap='round' stroke-opacity='.85'><path d='M${CX} ${CY} m-6 0 a6 6 0 1 1 12 0 a14 14 0 1 1 -28 0 a24 24 0 1 1 48 0 a36 36 0 1 1 -72 0' stroke-width='2.4'/></g>`,
);
const lightTrim = trim(GOLD, '#fffbe8', 'star');
const darkTrim = trim(OBSIDIAN, '#b36bff', 'diamond', '#c49bff');
const fireTrim = trim(BRONZE, '#ff5a1a', 'gem');
const waterTrim = trim(SILVER, '#5fd0ff', 'gem', '#cff0ff');
const earthTrim = trim(BRONZE, '#c8a060', 'diamond');
const windTrim = trim(SILVER, '#7ad8a4', 'wing', '#e6fff2');

/** Battle City: a rooftop at night, the skyline lit up across the middle, a helipad underfoot. */
const city = svg(
  lin('sky', [[0, '#140a3a'], [0.35, '#3a1a6a'], [0.5, '#8a3a7a']]) + lin('roof', [[0, '#2a2a3e'], [1, '#0c0c16']]) + rad('glow', [[0, '#ff7ac0', 0.5], [1, '#ff7ac0', 0]], '50%', '0%', '70%'),
  `<rect width='${W}' height='${H}' fill='url(#roof)'/>` +
    `<rect width='${W}' height='100' fill='url(#sky)'/>` +
    `<rect width='${W}' height='110' fill='url(#glow)'/>` +
    scatter(30, 61, [0, 0, 380, 40], (x, y, r) => `<circle cx='${x}' cy='${y}' r='${f(0.3 + r * 0.8)}' fill='#fff' fill-opacity='${f(0.3 + r * 0.6)}'/>`) +
    // two rows of towers: the far ones dim, the near ones with lit windows
    (() => {
      const r = rng(62);
      let far = '';
      let near = '';
      let wins = '';
      for (let x = -4; x < W; ) {
        const w = 14 + r() * 22;
        const h = 30 + r() * 36;
        far += `<rect x='${f(x)}' y='${f(100 - h)}' width='${f(w)}' height='${f(h)}'/>`;
        x += w + 2;
      }
      for (let x = -8; x < W; ) {
        const w = 18 + r() * 28;
        const h = 18 + r() * 50;
        const tall = h > 52;
        near += `<rect x='${f(x)}' y='${f(102 - h)}' width='${f(w)}' height='${f(h)}'/>` + (tall ? `<rect x='${f(x + w / 2 - 0.6)}' y='${f(102 - h - 10)}' width='1.2' height='10'/>` : '');
        for (let wy = 102 - h + 5; wy < 98; wy += 6) for (let wx = x + 3; wx < x + w - 3; wx += 5) if (r() < 0.32) wins += `<rect x='${f(wx)}' y='${f(wy)}' width='2' height='2.4'/>`;
        x += w + 1 + r() * 4;
      }
      return `<g fill='#2a1a4e'>${far}</g><g fill='#0e0a1e'>${near}</g><g fill='#ffd88a' fill-opacity='.75'>${wins}</g>`;
    })() +
    `<g fill='#ff3b4f'><circle cx='96' cy='48' r='1.6'/><circle cx='262' cy='42' r='1.6'/></g>` +
    // the parapet, then roof tiles and the helipad
    `<rect y='100' width='${W}' height='8' fill='#3a3a52'/><path d='M0 100H380' stroke='#8a8ab0' stroke-opacity='.6'/>` +
    `<g stroke='#000' stroke-opacity='.35'>${Array.from({ length: 9 }, (_, i) => `<path d='M0 ${120 + i * 12}H380'/>`).join('')}${Array.from({ length: 13 }, (_, i) => `<path d='M${i * 32 - 10} 108L${i * 40 - 50} 220'/>`).join('')}</g>` +
    `<ellipse cx='${CX}' cy='162' rx='92' ry='40' fill='none' stroke='#ffd04a' stroke-opacity='.55' stroke-width='3'/>` +
    `<ellipse cx='${CX}' cy='162' rx='80' ry='34' fill='none' stroke='#ffd04a' stroke-opacity='.25' stroke-dasharray='6 6'/>` +
    `<path d='M170 146V178M210 146V178M170 162H210' stroke='#ffd04a' stroke-opacity='.55' stroke-width='5'/>` +
    `<g fill='#3ae0ff'>${around(10, 1, CX, 162).map((_, i) => { const a = (i / 10) * Math.PI * 2; return `<circle cx='${f(CX + Math.cos(a) * 92)}' cy='${f(162 + Math.sin(a) * 40)}' r='1.8'/>`; }).join('')}</g>`,
);
const cityTrim = trim(SILVER, '#ff7ac0', 'diamond', '#d8c8ff');

/** Kaiba Dome: a stadium in the dark, its stands lit in rings, spotlights crossing the floor. */
const dome = svg(
  rad('bg', [[0, '#1e3a8a'], [0.6, '#08143a'], [1, '#020614']], '50%', '0%', '110%') +
    lin('beam', [[0, '#e6f2ff', 0.38], [1, '#e6f2ff', 0]]) +
    lin('floor', [[0, '#1a2a5a'], [1, '#0a1230']]),
  fill('bg') +
    // the stands: arcs of seats and lights round the far side
    `<g fill='none'>${Array.from({ length: 5 }, (_, i) => `<path d='M-20 ${70 - i * 13} Q190 ${-10 - i * 13} 400 ${70 - i * 13}' stroke='#9fc4ff' stroke-opacity='${f(0.24 - i * 0.03)}' stroke-width='${6 - i}' stroke-dasharray='${3 + i} 2'/>`).join('')}</g>` +
    scatter(60, 71, [0, 0, 380, 60], (x, y, r) => `<circle cx='${x}' cy='${y}' r='${f(0.4 + r * 0.8)}' fill='${r > 0.85 ? '#ffd88a' : '#e6f2ff'}' fill-opacity='${f(0.3 + r * 0.6)}'/>`) +
    // the arena floor
    `<path d='M-10 84 Q190 52 390 84 V230 H-10 Z' fill='url(#floor)'/>` +
    `<path d='M-10 84 Q190 52 390 84' fill='none' stroke='#6cc4ff' stroke-opacity='.7' stroke-width='1.6'/>` +
    `<g stroke='#6cc4ff' stroke-opacity='.12'>${Array.from({ length: 11 }, (_, i) => `<path d='M${CX} 66L${i * 38 - 0} 230'/>`).join('')}${Array.from({ length: 5 }, (_, i) => `<path d='M-10 ${110 + i * 26} Q190 ${86 + i * 26} 390 ${110 + i * 26}' fill='none'/>`).join('')}</g>` +
    // spotlights from the roof
    `<path d='M60 0 L20 220 H110 Z' fill='url(#beam)'/><path d='M320 0 L270 220 H360 Z' fill='url(#beam)'/><path d='M190 0 L150 220 H230 Z' fill='url(#beam)' opacity='.6'/>` +
    // the emblem on the floor: a white dragon's wings round a blue core
    `<g transform='translate(${CX} 146) scale(1 .5)'><circle r='70' fill='none' stroke='#cfe6ff' stroke-opacity='.55' stroke-width='3'/><circle r='58' fill='none' stroke='#6cc4ff' stroke-opacity='.35' stroke-width='8' stroke-dasharray='4 4'/>` +
    `<path d='M0 -44 L14 -10 L52 -26 L24 6 L44 40 L0 22 L-44 40 L-24 6 L-52 -26 L-14 -10 Z' fill='#cfe6ff' fill-opacity='.22' stroke='#e6f2ff' stroke-opacity='.75' stroke-width='2' stroke-linejoin='round'/>` +
    `<circle r='12' fill='#6cc4ff' fill-opacity='.8'/></g>`,
);
const domeTrim = trim(CHROME, '#6cc4ff', 'wing', '#cfe6ff');

/** Pegasus's castle: the great hall, a rose window over the middle, the red carpet to your feet. */
const castle = svg(
  lin('bg', [[0, '#3a1e3a'], [1, '#120812']]) +
    rad('rose', [[0, '#fff2c0'], [0.3, '#ff9ae8', 0.8], [0.7, '#6a5aff', 0.6], [1, '#2a1a5a', 0]]) +
    lin('cp', [[0, '#a01a2a'], [1, '#5a0a14']]) +
    lin('col', [[0, '#5a4a5a'], [0.5, '#8a7a8a'], [1, '#3a2a3a']], 1, 0),
  fill('bg') +
    // arches along the far wall
    `<g fill='#1e0e1e' stroke='#c8a0c8' stroke-opacity='.25'>${Array.from({ length: 7 }, (_, i) => `<path d='M${i * 56 - 12} 92 V40 Q${i * 56 + 16} 10 ${i * 56 + 44} 40 V92 Z'/>`).join('')}</g>` +
    // the rose window
    `<circle cx='${CX}' cy='40' r='38' fill='url(#rose)'/>` +
    `<g fill='none' stroke='#2a1a2a' stroke-width='2'>${around(12, 36, CX, 40).map(([x, y]) => `<line x1='${CX}' y1='40' x2='${x}' y2='${y}'/>`).join('')}<circle cx='${CX}' cy='40' r='36'/><circle cx='${CX}' cy='40' r='22'/><circle cx='${CX}' cy='40' r='8'/></g>` +
    `<circle cx='${CX}' cy='40' r='40' fill='none' stroke='#f0cf7a' stroke-opacity='.6' stroke-width='2'/>` +
    // columns down each side
    `<g fill='url(#col)'><rect x='26' y='60' width='16' height='160'/><rect x='338' y='60' width='16' height='160'/><rect x='92' y='76' width='10' height='144' opacity='.7'/><rect x='278' y='76' width='10' height='144' opacity='.7'/></g>` +
    `<g fill='#f0cf7a' fill-opacity='.5'><rect x='22' y='56' width='24' height='5'/><rect x='334' y='56' width='24' height='5'/></g>` +
    // the floor: checked marble, the carpet down the middle with gold edges
    `<path d='M0 92H380V220H0Z' fill='#2a1a2a'/>` +
    `<g fill='#e6d0e6' fill-opacity='.06'>${Array.from({ length: 40 }, (_, i) => { const row = Math.floor(i / 10); const col = i % 10; return (row + col) % 2 ? '' : `<rect x='${col * 38}' y='${92 + row * 32}' width='38' height='32'/>`; }).join('')}</g>` +
    `<path d='M160 92 L120 220 H260 L220 92 Z' fill='url(#cp)'/>` +
    `<path d='M160 92 L120 220 M220 92 L260 220' stroke='#f0cf7a' stroke-width='2.4' stroke-opacity='.85'/>` +
    `<g fill='none' stroke='#f0cf7a' stroke-opacity='.4'><path d='M150 140h80M140 180h100'/></g>` +
    // gold candelabra light either side
    `<g fill='#ffd27a'><circle cx='34' cy='120' r='3'/><circle cx='346' cy='120' r='3'/></g>` +
    `<circle cx='34' cy='120' r='18' fill='#ffd27a' fill-opacity='.12'/><circle cx='346' cy='120' r='18' fill='#ffd27a' fill-opacity='.12'/>`,
);
const castleTrim = trim(GOLD, '#ff9ae8', 'gem');

/** Duel Academy: the island school at dawn, the crest set into the courtyard. */
const academy = svg(
  lin('sky', [[0, '#6aa8ff'], [0.4, '#ffe2b0']]) + lin('sea', [[0, '#3a8ad0'], [1, '#0e3a6a']]) + lin('yard', [[0, '#c8b890'], [1, '#6a5a40']]),
  `<rect width='${W}' height='${H}' fill='url(#yard)'/>` +
    `<rect width='${W}' height='70' fill='url(#sky)'/>` +
    `<path d='M0 62H380V82H0Z' fill='url(#sea)'/>` +
    // the volcano behind and the school's blue roofs
    `<path d='M260 66 L300 30 L312 34 L350 66 Z' fill='#6a5a7a' fill-opacity='.8'/><path d='M300 30 q6 -10 12 4' fill='none' stroke='#fff' stroke-opacity='.6'/>` +
    `<g fill='#e6e0d0'><rect x='120' y='40' width='140' height='28'/><rect x='170' y='22' width='40' height='46'/></g>` +
    `<g fill='#2a5ab0'><path d='M114 42 L190 30 L266 42 Z'/><path d='M164 24 L190 8 L216 24 Z'/></g>` +
    `<g fill='#3a6ad0' fill-opacity='.7'>${Array.from({ length: 12 }, (_, i) => `<rect x='${126 + i * 11}' y='50' width='5' height='8'/>`).join('')}</g>` +
    `<circle cx='190' cy='34' r='4' fill='#ffd04a'/>` +
    // the courtyard paving and the crest
    `<g stroke='#4a3a24' stroke-opacity='.35'>${Array.from({ length: 6 }, (_, i) => `<path d='M0 ${100 + i * 22}H380'/>`).join('')}${Array.from({ length: 12 }, (_, i) => `<path d='M${i * 34 + (i % 2) * 8} 82V220'/>`).join('')}</g>` +
    `<path d='M0 82H380' stroke='#fff' stroke-opacity='.5'/>` +
    `<g transform='translate(${CX} 146)'><path d='M0 -52 L44 -36 V4 Q44 36 0 54 Q-44 36 -44 4 V-36 Z' fill='#2a5ab0' fill-opacity='.55' stroke='#ffd04a' stroke-width='2.4' stroke-opacity='.85'/>` +
    `<polygon points='${star(5, 22, 9, 0, 0)}' fill='#ffd04a' fill-opacity='.85'/><path d='M-30 30 Q0 44 30 30' fill='none' stroke='#ffd04a' stroke-opacity='.7' stroke-width='1.6'/></g>`,
);
const academyTrim = trim(GOLD, '#2a5ab0', 'star');

/** Starfall: an observatory roof under the night sky, constellations drawn in. */
const starfall = svg(
  rad('bg', [[0, '#2a3a8a'], [0.6, '#0c1240'], [1, '#03040e']], '50%', '0%', '110%') + rad('neb', [[0, '#b07aff', 0.35], [1, '#b07aff', 0]]),
  fill('bg') +
    `<ellipse cx='110' cy='40' rx='120' ry='40' fill='url(#neb)'/><ellipse cx='300' cy='70' rx='90' ry='30' fill='url(#neb)' opacity='.6'/>` +
    scatter(90, 81, [0, 0, 380, 220], (x, y, r) => `<circle cx='${x}' cy='${y}' r='${f(0.3 + r * 1.1)}' fill='#fff' fill-opacity='${f(0.25 + r * 0.7)}'/>`) +
    // a dragon picked out in stars round the middle, and a couple of other constellations
    (() => {
      const pts: [number, number][] = [[120, 70], [150, 54], [178, 62], [206, 48], [236, 58], [258, 82], [244, 112], [214, 124], [184, 116], [160, 134], [132, 128]];
      const others: [number, number][][] = [[[30, 30], [54, 22], [70, 40], [52, 56]], [[312, 150], [336, 136], [358, 152], [340, 172]]];
      const line = (p: [number, number][]) => `<polyline points='${p.map((q) => q.join(',')).join(' ')}' fill='none' stroke='#bcd0ff' stroke-opacity='.4' stroke-width='.9'/>`;
      const dots = (p: [number, number][]) => p.map(([x, y], i) => `<circle cx='${x}' cy='${y}' r='${i % 3 ? 1.6 : 2.4}' fill='#fff'/><circle cx='${x}' cy='${y}' r='5' fill='#bcd0ff' fill-opacity='.18'/>`).join('');
      return line(pts) + others.map(line).join('') + dots(pts) + others.map(dots).join('');
    })() +
    // the observatory's brass rings across the near floor
    `<g fill='none' stroke='#e6c27a'><ellipse cx='${CX}' cy='196' rx='170' ry='44' stroke-opacity='.4' stroke-width='2'/><ellipse cx='${CX}' cy='196' rx='140' ry='34' stroke-opacity='.2'/></g>` +
    `<g fill='#e6c27a' fill-opacity='.6'>${Array.from({ length: 12 }, (_, i) => { const a = Math.PI + (i / 11) * Math.PI; return `<circle cx='${f(CX + Math.cos(a) * 170)}' cy='${f(196 + Math.sin(a) * 44)}' r='1.8'/>`; }).join('')}</g>`,
);
const starfallTrim = trim(BRONZE, '#bcd0ff', 'star', '#e6c27a');

/** The Millennium Stone: the tablet with the seven items' places, gold on sandstone. */
const millennium = svg(
  rad('bg', [[0, '#d8b878'], [0.6, '#7a5a2c'], [1, '#2a1a08']], '50%', '45%', '80%') + rad('gl', [[0, '#fff2c0', 0.6], [1, '#fff2c0', 0]]),
  fill('bg') +
    `<g stroke='#3a2a10' stroke-opacity='.25'>${Array.from({ length: 8 }, (_, i) => `<path d='M0 ${i * 28 + 10}H380'/>`).join('')}${Array.from({ length: 40 }, (_, i) => `<path d='M${(i % 5) * 80 + (Math.floor(i / 5) % 2) * 40} ${Math.floor(i / 5) * 28 + 10}v28'/>`).join('')}</g>` +
    `<circle cx='${CX}' cy='${CY}' r='90' fill='url(#gl)'/>` +
    // the stone's circle, the seven sockets round it, the Eye in the middle
    `<circle cx='${CX}' cy='${CY}' r='76' fill='#5a3a14' fill-opacity='.45' stroke='#f6dc96' stroke-width='2.4' stroke-opacity='.85'/>` +
    `<circle cx='${CX}' cy='${CY}' r='68' fill='none' stroke='#f6dc96' stroke-opacity='.4' stroke-dasharray='2 3'/>` +
    around(7, 56)
      .map(([x, y], i) => `<circle cx='${x}' cy='${y}' r='9' fill='#3a2208' stroke='#f6dc96' stroke-opacity='.8' stroke-width='1.2'/>` + (i === 0 ? `<polygon points='${x},${y - 6} ${x + 6},${y + 4} ${x - 6},${y + 4}' fill='#f6dc96'/>` : `<circle cx='${x}' cy='${y}' r='3.2' fill='#f6dc96' fill-opacity='.8'/>`))
      .join('') +
    `<polygon points='${CX},${CY - 30} ${CX + 28},${CY + 18} ${CX - 28},${CY + 18}' fill='#f6dc96' fill-opacity='.3' stroke='#fbe7a8' stroke-width='1.6'/>` +
    eye(CX, CY + 3, 30, '#2a1a08', '#fbe7a8') +
    // hieroglyph bands either side
    `<g fill='#3a2208' fill-opacity='.55'>${Array.from({ length: 6 }, (_, i) => `<rect x='18' y='${30 + i * 26}' width='12' height='4'/><circle cx='24' cy='${40 + i * 26}' r='3'/><rect x='350' y='${30 + i * 26}' width='12' height='4'/><path d='M350 ${44 + i * 26}h12l-6 -6z'/>`).join('')}</g>`,
);
const millenniumTrim = trim(GOLD, '#2aa0a0', 'ankh');

/** The Shadow Realm: violet fog over broken stone, a great eye watching from the dark. */
const shadowrealm = svg(
  rad('bg', [[0, '#4a1a6a'], [0.5, '#1a0828'], [1, '#05020a']], '50%', '30%', '85%') +
    rad('fog', [[0, '#c070ff', 0.45], [1, '#c070ff', 0]]) +
    rad('eyeg', [[0, '#ff4ad0', 0.9], [0.4, '#a020ff', 0.5], [1, '#a020ff', 0]]),
  fill('bg') +
    `<ellipse cx='${CX}' cy='40' rx='120' ry='40' fill='url(#eyeg)'/>` +
    eye(CX, 44, 70, '#f0c0ff', '#ff4ad0', 0.75) +
    // spires of rock rising through the fog
    `<g fill='#0c0414'><path d='M10 220 L30 120 L44 160 L56 104 L72 220 Z'/><path d='M310 220 L326 110 L338 150 L352 96 L370 220 Z'/><path d='M120 220 L134 168 L146 220 Z'/><path d='M240 220 L252 160 L266 220 Z'/></g>` +
    `<g fill='none' stroke='#c070ff' stroke-opacity='.3'><path d='M30 120 L44 160 L56 104M326 110 L338 150 L352 96'/></g>` +
    // the floating stone the duel stands on, cracked, with a summoning circle cut in it
    `<ellipse cx='${CX}' cy='150' rx='150' ry='46' fill='#1e0c2e' stroke='#c070ff' stroke-opacity='.45'/>` +
    `<g fill='none' stroke='#e0a0ff' stroke-opacity='.5'><ellipse cx='${CX}' cy='150' rx='100' ry='30'/><ellipse cx='${CX}' cy='150' rx='84' ry='24' stroke-dasharray='3 4'/></g>` +
    `<polygon points='${star(5, 92, 36, CX, 150).split(' ').map((p) => { const [x, y] = p.split(',').map(Number); return `${x},${f(150 + (y - 150) * 0.32)}`; }).join(' ')}' fill='none' stroke='#ff4ad0' stroke-opacity='.45' stroke-width='1.2'/>` +
    `<g stroke='#05020a' stroke-width='1.6' fill='none'><path d='M80 140l20 10l-6 14M300 136l-18 14l8 12M170 186l10 -12l14 6'/></g>` +
    `<ellipse cx='100' cy='110' rx='130' ry='30' fill='url(#fog)'/><ellipse cx='300' cy='190' rx='120' ry='30' fill='url(#fog)'/>`,
);
const shadowrealmTrim = trim(OBSIDIAN, '#ff4ad0', 'diamond', '#e0a0ff');

/** The Pharaoh's tomb: a gold-lit burial hall, pillars, wall paintings and the ankh. */
const tomb = svg(
  lin('bg', [[0, '#1a1006'], [0.45, '#5a3a14'], [1, '#2a1a08']]) + rad('torch', [[0, '#ffcf6a', 0.55], [1, '#ffcf6a', 0]]) + lin('pil', [[0, '#3a2a10'], [0.5, '#a07a3a'], [1, '#3a2a10']], 1, 0),
  fill('bg') +
    // the far wall with its painted bands
    `<rect width='${W}' height='76' fill='#3a2610'/>` +
    `<g fill='#2aa0a0' fill-opacity='.45'>${Array.from({ length: 19 }, (_, i) => `<rect x='${i * 20 + 2}' y='8' width='16' height='5'/>`).join('')}</g>` +
    `<g fill='#d0a050' fill-opacity='.55'>${Array.from({ length: 12 }, (_, i) => { const x = 14 + i * 31; return i % 3 === 0 ? `<circle cx='${x}' cy='30' r='5'/><rect x='${x - 1.5}' y='35' width='3' height='12'/>` : i % 3 === 1 ? `<path d='M${x - 6} 46 L${x} 22 L${x + 6} 46 Z'/>` : `<path d='M${x - 7} 34 q7 -12 14 0 q-7 6 -14 0z'/><rect x='${x - 1}' y='36' width='2' height='10'/>`; }).join('')}</g>` +
    `<g fill='#b02a2a' fill-opacity='.45'>${Array.from({ length: 19 }, (_, i) => `<rect x='${i * 20 + 2}' y='58' width='16' height='5'/>`).join('')}</g>` +
    `<path d='M0 76H380' stroke='#f6dc96' stroke-opacity='.6' stroke-width='1.4'/>` +
    // pillars and torchlight
    `<g fill='url(#pil)'><rect x='14' y='70' width='26' height='150'/><rect x='340' y='70' width='26' height='150'/></g>` +
    `<g fill='#2aa0a0' fill-opacity='.5'>${[96, 128, 160, 192].map((y) => `<rect x='14' y='${y}' width='26' height='4'/><rect x='340' y='${y}' width='26' height='4'/>`).join('')}</g>` +
    `<circle cx='60' cy='92' r='44' fill='url(#torch)'/><circle cx='320' cy='92' r='44' fill='url(#torch)'/>` +
    flame(60, 96, 18, '#ffcf6a', 0.9) + flame(320, 96, 18, '#ffcf6a', 0.9) +
    // the floor slabs and the great ankh between wings
    `<g stroke='#1a1006' stroke-opacity='.4'>${Array.from({ length: 5 }, (_, i) => `<path d='M40 ${100 + i * 26}H340'/>`).join('')}</g>` +
    `<g transform='translate(${CX} 140)'><path d='M-14 -6 Q-70 -30 -120 -10 Q-80 -14 -60 0 Q-90 0 -110 14 Q-60 6 -14 10 Z' fill='#f6dc96' fill-opacity='.28' stroke='#fbe7a8' stroke-opacity='.6'/><path d='M14 -6 Q70 -30 120 -10 Q80 -14 60 0 Q90 0 110 14 Q60 6 14 10 Z' fill='#f6dc96' fill-opacity='.28' stroke='#fbe7a8' stroke-opacity='.6'/></g>` +
    ankh(CX, 140, 70, '#fbe7a8', 0.9) +
    `<circle cx='${CX}' cy='117' r='4' fill='#2aa0a0'/>`,
);
const tombTrim = trim(GOLD, '#2aa0a0', 'ankh');

/** Holo Arena: rainbow foil in a fine diamond weave, stars of light. */
const holo = svg(
  lin('bg', [[0, '#ff7ad8'], [0.2, '#7ab8ff'], [0.4, '#7affd8'], [0.6, '#fff07a'], [0.8, '#ffaa7a'], [1, '#c07aff']], 1, 1) +
    rad('dk', [[0, '#1a1040', 0.45], [1, '#05030e', 0.92]], '50%', '45%', '75%') +
    `<pattern id='dm' width='16' height='16' patternUnits='userSpaceOnUse'><path d='M8 0L16 8L8 16L0 8Z' fill='none' stroke='#fff' stroke-opacity='.14' stroke-width='.8'/></pattern>`,
  fill('bg') +
    fill('dk') +
    fill('dm') +
    rays(32, 20, 260, '#fff', 0.8, 0.12) +
    `<g fill='none' stroke='#fff' stroke-opacity='.55'><circle cx='${CX}' cy='${CY}' r='78' stroke-width='2'/><circle cx='${CX}' cy='${CY}' r='60'/></g>` +
    `<polygon points='${star(4, 56, 12)}' fill='#fff' fill-opacity='.4'/><polygon points='${star(4, 40, 9, CX, CY, -45)}' fill='#fff' fill-opacity='.3'/>` +
    scatter(16, 91, [10, 10, 360, 200], (x, y, r) => `<polygon points='${star(4, 3 + r * 5, 0.8 + r, x, y)}' fill='#fff' fill-opacity='${f(0.3 + r * 0.5)}'/>`),
);
const holoTrim = trim(['#ffffff', '#b07ad8', '#7ad8ff'], '#ff9ae8', 'star', '#ffffff');

/** Heart of the Cards: warm light from a heart made of five cards, rays of trust out to the edges. */
const heart = svg(
  rad('bg', [[0, '#ffcf8a'], [0.4, '#a0442a'], [1, '#1a0806']], '50%', '45%', '80%') + rad('gl', [[0, '#fff6d0', 0.8], [1, '#fff6d0', 0]]),
  fill('bg') +
    rays(20, 50, 260, '#ffe2b0', 2.2, 0.16) +
    `<circle cx='${CX}' cy='${CY}' r='70' fill='url(#gl)'/>` +
    // five cards fanned behind the heart
    [-36, -18, 0, 18, 36].map((a) => `<rect x='${CX - 15}' y='${CY - 52}' width='30' height='44' rx='2.5' fill='#3a1a10' fill-opacity='.55' stroke='#ffe2b0' stroke-opacity='.7' transform='rotate(${a} ${CX} ${CY + 20})'/>`).join('') +
    `<path d='M${CX} ${CY + 30} C${CX - 44} ${CY + 2} ${CX - 30} ${CY - 34} ${CX} ${CY - 16} C${CX + 30} ${CY - 34} ${CX + 44} ${CY + 2} ${CX} ${CY + 30} Z' fill='#ff6a4a' fill-opacity='.8' stroke='#fff6d0' stroke-width='2'/>` +
    `<path d='M${CX - 14} ${CY - 12} q-8 8 -4 16' fill='none' stroke='#fff' stroke-opacity='.7' stroke-width='2.4' stroke-linecap='round'/>` +
    scatter(20, 101, [0, 0, 380, 220], (x, y, r) => `<circle cx='${x}' cy='${y}' r='${f(0.6 + r * 1.4)}' fill='#fff6d0' fill-opacity='${f(0.2 + r * 0.5)}'/>`),
);
const heartTrim = trim(GOLD, '#ff6a4a', 'gem');

export const PLAYMAT_SVG = {
  blue,
  crimson,
  kingdom,
  disk,
  light,
  dark,
  fire,
  water,
  earth,
  wind,
  city,
  castle,
  dome,
  academy,
  starfall,
  millennium,
  shadowrealm,
  tomb,
  holo,
  heart,
};
export type PlaymatId = keyof typeof PLAYMAT_SVG;

export const PLAYMAT_TRIM: Record<PlaymatId, string> = {
  blue: blueTrim,
  crimson: crimsonTrim,
  kingdom: kingdomTrim,
  disk: diskTrim,
  light: lightTrim,
  dark: darkTrim,
  fire: fireTrim,
  water: waterTrim,
  earth: earthTrim,
  wind: windTrim,
  city: cityTrim,
  castle: castleTrim,
  dome: domeTrim,
  academy: academyTrim,
  starfall: starfallTrim,
  millennium: millenniumTrim,
  shadowrealm: shadowrealmTrim,
  tomb: tombTrim,
  holo: holoTrim,
  heart: heartTrim,
};

// ---------- ambient motion: one small repeating tile a half, moved by CSS (transform / opacity only) ----------

export type MatFx = 'embers' | 'bubbles' | 'leaves' | 'stars' | 'fog' | 'motes' | 'sparkle' | 'scan' | 'sweep' | 'holo';

/** The tile a mat's motion repeats (null: the motion is drawn by CSS alone). */
export function fxTile(fx: MatFx, color: string): string | null {
  const T = 120;
  const tile = (body: string) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${T} ${T}' width='${T}' height='${T}'>${body}</svg>`;
  switch (fx) {
    case 'embers':
      return tile(scatter(9, 201, [0, 0, T, T], (x, y, r) => `<circle cx='${x}' cy='${y}' r='${f(0.8 + r * 1.4)}' fill='${color}' fill-opacity='${f(0.5 + r * 0.5)}'/>`));
    case 'bubbles':
      return tile(scatter(7, 203, [0, 0, T, T], (x, y, r) => `<circle cx='${x}' cy='${y}' r='${f(1.2 + r * 2.4)}' fill='none' stroke='${color}' stroke-opacity='${f(0.4 + r * 0.4)}'/>`));
    case 'leaves':
      return tile(scatter(4, 205, [0, 0, T, T], (x, y, r) => `<path d='M${x} ${y}q4 -5 8 0q-4 5 -8 0z' fill='${color}' fill-opacity='.6' transform='rotate(${f(r * 360)} ${x} ${y})'/>`));
    case 'stars':
    case 'sparkle':
      return tile(scatter(6, 207, [0, 0, T, T], (x, y, r) => `<polygon points='${star(4, 2 + r * 2.5, 0.6, x, y)}' fill='${color}' fill-opacity='${f(0.5 + r * 0.5)}'/>`));
    case 'motes':
      return tile(scatter(7, 209, [0, 0, T, T], (x, y, r) => `<circle cx='${x}' cy='${y}' r='${f(0.6 + r)}' fill='${color}' fill-opacity='${f(0.4 + r * 0.5)}'/>`));
    case 'fog':
      return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 120' width='240' height='120'><defs><radialGradient id='g'><stop offset='0' stop-color='${color}' stop-opacity='.35'/><stop offset='1' stop-color='${color}' stop-opacity='0'/></radialGradient></defs><ellipse cx='60' cy='40' rx='70' ry='22' fill='url(#g)'/><ellipse cx='180' cy='90' rx='80' ry='24' fill='url(#g)'/><ellipse cx='240' cy='40' rx='40' ry='16' fill='url(#g)'/><ellipse cx='0' cy='40' rx='40' ry='16' fill='url(#g)'/></svg>`;
    default:
      return null;
  }
}

const urls = new Map<string, string>();
const cssUrl = (svgText: string) => `url("data:image/svg+xml,${encodeURIComponent(svgText)}")`;
/** The CSS url() of a mat's scene (made once). */
export function matUrl(id: PlaymatId): string {
  let u = urls.get(id);
  if (!u) urls.set(id, (u = cssUrl(PLAYMAT_SVG[id])));
  return u;
}
/** The CSS url() of a mat's trim (made once). */
export function trimUrl(id: PlaymatId): string {
  const k = `t:${id}`;
  let u = urls.get(k);
  if (!u) urls.set(k, (u = cssUrl(PLAYMAT_TRIM[id])));
  return u;
}
/** The CSS url() of a motion tile ('none' when the motion needs none). */
export function fxUrl(fx: MatFx, color: string): string {
  const k = `f:${fx}:${color}`;
  let u = urls.get(k);
  if (!u) {
    const t = fxTile(fx, color);
    urls.set(k, (u = t ? cssUrl(t) : 'none'));
  }
  return u;
}
