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

// ---------- shared depth: grain, light from the far left, haze, floor seals ----------

/** Each mat's grain strength (stone, sand, felt). The grain is NOT in the scene: an SVG filter
 *  would be rasterised again on the CPU at every new size the picture is drawn at. It is one small
 *  filter-free tile of dots (grainTile) that CSS repeats over the scene at this opacity. */
const GRAIN = new Map<string, number>();
/** Light from the far left corner, falling off toward you. */
const LIGHT_DEF = lin('lt', [[0, '#fff', 0.16], [0.45, '#fff', 0], [1, '#000', 0.25]], 0.6, 1);
const light = fill('lt');
/** Something drawn round the half's middle, laid flat on the floor (seen at the field's angle). */
const onFloor = (cy: number, k: number, body: string, r = 0) => `<g transform='translate(${CX} ${cy}) scale(1 ${k}) rotate(${r}) translate(${-CX} ${-CY})'>${body}</g>`;
/** A glow spot. */
const glowDef = (id: string, c: string, a = 0.6) => rad(id, [[0, c, a], [1, c, 0]]);
const spot = (id: string, cx: number, cy: number, rx: number, ry = rx) => `<ellipse cx='${cx}' cy='${cy}' rx='${rx}' ry='${ry}' fill='url(#${id})'/>`;

function scene(defs: string, body: string, opts: { grain?: number; light?: boolean } = {}): string {
  const out = svg(defs + (opts.light === false ? '' : LIGHT_DEF), body + (opts.light === false ? '' : light));
  GRAIN.set(out, opts.grain ?? 0);
  return out;
}
/** Inner glow along a path (drawn twice: a wide soft stroke, then a bright core). */
const glowLine = (d: string, c: string, w: number, core = '#fff') =>
  `<path d='${d}' fill='none' stroke='${c}' stroke-opacity='.35' stroke-width='${w * 3}' stroke-linecap='round' stroke-linejoin='round'/><path d='${d}' fill='none' stroke='${c}' stroke-width='${w}' stroke-linecap='round' stroke-linejoin='round'/><path d='${d}' fill='none' stroke='${core}' stroke-opacity='.7' stroke-width='${f(w * 0.35)}' stroke-linecap='round' stroke-linejoin='round'/>`;

// ---------- the mats ----------

/** Tournament Blue: the tournament felt, its duel ring laid on the floor, a lit grid running to the middle. */
const blue = scene(
  lin('bg', [[0, '#0e1a52'], [0.35, '#2648b4'], [1, '#0e1c4c']]) +
    glowDef('g1', '#7ea2ff', 0.8) +
    glowDef('g2', '#9fc0ff', 0.45) +
    `<pattern id='gr' width='19' height='19' patternUnits='userSpaceOnUse'><path d='M19 0H0V19' fill='none' stroke='#9fb8ff' stroke-opacity='.1' stroke-width='.7'/></pattern>`,
  fill('bg') +
    fill('gr') +
    // a perspective grid toward the middle, and the light where the halves meet
    `<g stroke='#8fb0ff' stroke-opacity='.14'>${Array.from({ length: 15 }, (_, i) => `<path d='M${CX} -40L${i * 30 - 20} 220'/>`).join('')}</g>` +
    spot('g1', CX, 0, 240, 60) +
    spot('g2', CX, 140, 150, 60) +
    onFloor(140, 0.55, seal('#e6efff', 0.75, 96) + `<circle cx='${CX}' cy='${CY}' r='40' fill='#7ea2ff' fill-opacity='.3'/>`) +
    onFloor(140, 0.55, `<circle cx='${CX}' cy='${CY}' r='104' fill='none' stroke='#9fc4ff' stroke-opacity='.25' stroke-width='6'/>`) +
    `<path d='M0 70H380' stroke='#cfe0ff' stroke-opacity='.18'/><path d='M0 74H380' stroke='#cfe0ff' stroke-opacity='.08'/>`,
  { grain: 0.15 },
);
const blueTrim = trim(SILVER, '#6cc4ff', 'diamond', '#cfe0ff');

/** Crimson Arena: a red stone arena floor under banners, the gold star set into it. */
const crimson = scene(
  lin('bg', [[0, '#1a0206'], [0.3, '#5a0a16'], [1, '#2a040a']]) +
    glowDef('g1', '#ffb04a', 0.45) +
    lin('ban', [[0, '#8a1424'], [1, '#4a0610']]) +
    `<pattern id='fl' width='38' height='20' patternUnits='userSpaceOnUse'><path d='M0 20H38M19 0V20' fill='none' stroke='#000' stroke-opacity='.35'/></pattern>`,
  fill('bg') +
    // banners hanging on the far wall
    [40, 110, 270, 340].map((x) => `<path d='M${x - 14} 0V40L${x} 50L${x + 14} 40V0Z' fill='url(#ban)' stroke='#f0cf7a' stroke-opacity='.6'/><polygon points='${star(8, 6, 3, x, 22)}' fill='#f0cf7a' fill-opacity='.8'/>`).join('') +
    `<path d='M0 58H380' stroke='#f0cf7a' stroke-opacity='.5' stroke-width='1.4'/>` +
    `<rect y='58' width='${W}' height='162' fill='url(#fl)'/>` +
    spot('g1', CX, 140, 170, 70) +
    onFloor(142, 0.55, `<g fill='none' stroke='#f0cf7a' stroke-opacity='.6'><circle cx='${CX}' cy='${CY}' r='96' stroke-width='3'/><circle cx='${CX}' cy='${CY}' r='88'/><circle cx='${CX}' cy='${CY}' r='46' stroke-width='1.6'/></g>` +
      `<polygon points='${star(8, 82, 36)}' fill='#f0cf7a' fill-opacity='.18' stroke='#f6dc96' stroke-opacity='.7' stroke-width='1.6' stroke-linejoin='round'/>` +
      `<polygon points='${star(8, 42, 18, CX, CY, -67.5)}' fill='#ff3b4f' fill-opacity='.45' stroke='#f6dc96' stroke-opacity='.6'/>` +
      `<circle cx='${CX}' cy='${CY}' r='11' fill='#ff3b4f' stroke='#fbe7a8' stroke-width='2'/>` +
      `<g fill='#f6dc96'>${around(16, 92).map(([x, y]) => `<circle cx='${x}' cy='${y}' r='2'/>`).join('')}</g>`) +
    `<g fill='#ffcf6a'>${[[16, 90], [364, 90]].map(([x, y]) => flame(x, y, 16, '#ffcf6a', 0.9)).join('')}</g>`,
  { grain: 0.24 },
);
const crimsonTrim = trim(GOLD, '#ff3b4f', 'gem');

/** Duelist Kingdom: the island at sunset, the castle lit on its cliff, the sea below your ledge. */
const kingdom = scene(
  lin('sky', [[0, '#2a1650'], [0.4, '#b0486a'], [0.75, '#ffa060'], [1, '#ffd9a0']]) +
    lin('sea', [[0, '#5a6a9a'], [0.3, '#2a3a6a'], [1, '#0a1430']]) +
    lin('rock', [[0, '#8a6a50'], [0.5, '#4a3424'], [1, '#1a120c']], 1, 1) +
    lin('cast', [[0, '#5a3a5a'], [1, '#2a1a34']], 1, 0) +
    lin('grass', [[0, '#7a9a4a'], [1, '#2a3a1a']]) +
    rad('sun', [[0, '#fffbe0'], [0.3, '#ffe0a0', 0.9], [1, '#ff8a4a', 0]]),
  `<rect width='${W}' height='${H}' fill='url(#sea)'/>` +
    `<rect width='${W}' height='96' fill='url(#sky)'/>` +
    // clouds lit from below
    `<g fill='#ffc0a0' fill-opacity='.35'><ellipse cx='70' cy='30' rx='60' ry='6'/><ellipse cx='120' cy='22' rx='40' ry='4'/><ellipse cx='320' cy='40' rx='70' ry='5'/></g>` +
    `<circle cx='262' cy='84' r='54' fill='url(#sun)'/>` +
    // far island, then the castle: lit faces toward the sun, shadow faces away
    `<path d='M40 96 Q70 76 104 78 L140 62 L170 66 L196 50 L234 66 L276 70 Q308 80 336 96 Z' fill='#5a3a5a'/>` +
    `<path d='M196 50 L234 66 L276 70 Q308 80 336 96 L250 96 Z' fill='#7a4a5a' opacity='.6'/>` +
    `<g fill='url(#cast)'><rect x='166' y='32' width='9' height='36'/><rect x='182' y='18' width='14' height='50'/><rect x='204' y='28' width='9' height='40'/><rect x='156' y='44' width='66' height='24'/></g>` +
    `<g fill='#2a1a34'><path d='M164 32l6.5 -10l6.5 10zM180 18l9 -14l9 14zM202 28l6.5 -10l6.5 10z'/></g>` +
    `<g fill='#ffb070' fill-opacity='.55'><rect x='194' y='18' width='2' height='50'/><rect x='211' y='28' width='2' height='40'/><rect x='173' y='32' width='2' height='36'/></g>` +
    `<g fill='#ffe2a0'><rect x='187' y='34' width='3' height='5'/><rect x='170' y='48' width='2' height='3'/><rect x='207' y='42' width='2' height='3'/><rect x='196' y='54' width='3' height='4'/></g>` +
    `<path d='M190 4v-4' stroke='#2a1a34'/><path d='M190 2h7l-2 2h-5z' fill='#ff5a5a'/>` +
    // the sea: a path of sunlight and the swell
    `<path d='M0 96H380' stroke='#ffe2b0' stroke-opacity='.7'/>` +
    `<path d='M226 100h72M234 106h56M244 112h36M252 118h20' stroke='#ffe9b8' stroke-opacity='.55' stroke-width='1.6' stroke-linecap='round'/>` +
    scatter(30, 7, [0, 100, 380, 76], (x, y, r) => `<path d='M${x} ${y}q${f(6 + r * 8)} -3 ${f(14 + r * 14)} 0' fill='none' stroke='#cfe6ff' stroke-opacity='${f(0.1 + r * 0.2)}' stroke-width='1'/>`) +
    // the near cliffs either side, lit on their sunward edges, and the stone ledge you stand on
    `<path d='M0 116 Q34 108 64 122 L92 150 Q72 186 98 220 H0 Z' fill='url(#rock)'/>` +
    `<path d='M64 122 L92 150 Q72 186 98 220' fill='none' stroke='#ffc890' stroke-opacity='.45' stroke-width='1.6'/>` +
    `<path d='M0 116 Q34 108 64 122 L72 132 Q36 120 0 126 Z' fill='url(#grass)'/>` +
    `<path d='M380 110 Q344 106 314 122 L288 152 Q310 186 282 220 H380 Z' fill='url(#rock)'/>` +
    `<path d='M314 122 L288 152 Q310 186 282 220' fill='none' stroke='#ffc890' stroke-opacity='.3' stroke-width='1.2'/>` +
    `<path d='M380 110 Q344 106 314 122 L306 130 Q344 118 380 122 Z' fill='url(#grass)'/>` +
    `<g stroke='#1a120c' stroke-opacity='.55' fill='none'><path d='M20 150l14 10l-4 14M40 140l10 16M330 146l-12 12l6 12M350 160l-10 14'/></g>` +
    `<path d='M56 194 Q190 166 324 194 L344 220 H36 Z' fill='#4a3a2c'/>` +
    `<path d='M56 194 Q190 166 324 194' fill='none' stroke='#ffc890' stroke-opacity='.55' stroke-width='1.4'/>` +
    scatter(18, 9, [70, 190, 240, 26], (x, y, r) => `<ellipse cx='${x}' cy='${y}' rx='${f(4 + r * 7)}' ry='${f(2 + r * 2)}' fill='#6a5440'/><ellipse cx='${x - 1}' cy='${y - 1}' rx='${f(2 + r * 4)}' ry='1' fill='#a08060' fill-opacity='.5'/>`),
  { grain: 0.18 },
);
const kingdomTrim = trim(BRONZE, '#ffb36a', 'diamond');

/** Duel Disk Grid: dark glass, a hex grid, circuits running in to a cyan core that sits on the floor. */
const disk = scene(
  rad('bg', [[0, '#0e3a4a'], [0.55, '#06161e'], [1, '#020608']], '50%', '60%', '80%') +
    `<pattern id='hx' width='24' height='41.6' patternUnits='userSpaceOnUse'><path d='M12 0L24 6.9V20.8L12 27.7L0 20.8V6.9ZM12 27.7V41.6' fill='none' stroke='#3ae0ff' stroke-opacity='.12' stroke-width='.8'/></pattern>` +
    glowDef('core', '#3ae0ff', 0.55),
  fill('bg') +
    fill('hx') +
    // lit hex cells here and there
    scatter(10, 301, [10, 10, 360, 200], (x, y, r) => `<polygon points='${around(6, 10 + r * 4, x, y, 0).map((p) => p.join(',')).join(' ')}' fill='#3ae0ff' fill-opacity='${f(0.06 + r * 0.12)}'/>`) +
    // the circuits, glowing
    glowLine('M0 40H60L80 60H120', '#3ae0ff', 1.2) +
    glowLine('M0 176H44L70 150H112', '#3ae0ff', 1.2) +
    glowLine('M380 40H320L300 60H260', '#3ae0ff', 1.2) +
    glowLine('M380 176H336L310 150H268', '#3ae0ff', 1.2) +
    glowLine('M190 220V196', '#3ae0ff', 1.4) +
    `<g fill='#e6fbff'>${[[120, 60], [112, 150], [260, 60], [268, 150], [190, 196]].map(([x, y]) => `<circle cx='${x}' cy='${y}' r='2.6'/>`).join('')}</g>` +
    spot('core', CX, 140, 130, 60) +
    onFloor(140, 0.55, `<g fill='none' stroke='#3ae0ff'><circle cx='${CX}' cy='${CY}' r='96' stroke-opacity='.6' stroke-width='2' stroke-dasharray='40 8 6 8'/><circle cx='${CX}' cy='${CY}' r='78' stroke-opacity='.35' stroke-width='10' stroke-dasharray='3 5'/><circle cx='${CX}' cy='${CY}' r='52' stroke-opacity='.8' stroke-width='2.4'/><circle cx='${CX}' cy='${CY}' r='20' stroke-opacity='1' stroke-width='3'/></g>` + rays(12, 56, 74, '#9ff2ff', 2.4, 0.7) + `<circle cx='${CX}' cy='${CY}' r='9' fill='#e6fbff'/>`) +
    // the glass's reflection
    `<path d='M0 0L120 0L20 220H0Z' fill='#fff' opacity='.03'/>`,
  { grain: 0 },
);
const diskTrim = trim(CHROME, '#3ae0ff', 'diamond', '#9ff2ff');

/** LIGHT: a sky temple. Columns recede toward a gate of light; a marble floor with gold inlay. */
const lightMat = scene(
  lin('sky', [[0, '#fffbe8'], [0.5, '#e6c878'], [1, '#8a6a2a']]) +
    lin('fl', [[0, '#b8984e'], [1, '#3a2a0e']]) +
    lin('col', [[0, '#fff6d8'], [0.6, '#c8a860'], [1, '#6a4a1a']], 1, 0) +
    glowDef('gate', '#fffbe8', 0.95),
  `<rect width='${W}' height='${H}' fill='url(#fl)'/>` +
    `<rect width='${W}' height='84' fill='url(#sky)'/>` +
    spot('gate', CX, 40, 120, 70) +
    rays(28, 20, 200, '#fff', 1.4, 0.25, CX, 40) +
    // columns on both sides, smaller toward the middle
    [[20, 26, 220], [70, 18, 170], [108, 12, 130], [380 - 46, 26, 220], [380 - 88, 18, 170], [380 - 120, 12, 130]]
      .map(([x, w, h]) => `<rect x='${x}' y='${f(220 - h)}' width='${w}' height='${h}' fill='url(#col)'/><rect x='${x - 3}' y='${f(220 - h - 4)}' width='${w + 6}' height='5' fill='#fff6d8'/><rect x='${x + w * 0.3}' y='${f(220 - h)}' width='1.2' height='${h}' fill='#fff' fill-opacity='.5'/>`)
      .join('') +
    // the marble floor: inlaid gold lines toward the gate
    `<g stroke='#fff2b0' stroke-opacity='.35'>${Array.from({ length: 9 }, (_, i) => `<path d='M${CX} 84L${i * 60 - 50} 220'/>`).join('')}${[110, 140, 178].map((y) => `<path d='M0 ${y}H380'/>`).join('')}</g>` +
    `<path d='M0 84H380' stroke='#fff' stroke-opacity='.7' stroke-width='1.4'/>` +
    onFloor(158, 0.5, `<polygon points='${star(12, 70, 34)}' fill='#fffbe8' fill-opacity='.35' stroke='#fff' stroke-opacity='.8' stroke-width='1.6'/><circle cx='${CX}' cy='${CY}' r='88' fill='none' stroke='#fff6c0' stroke-opacity='.7' stroke-width='2.4'/><circle cx='${CX}' cy='${CY}' r='20' fill='#fff' fill-opacity='.85'/>`) +
    // and a dim pass over all of it, so the cards stay the brightest thing
    `<rect width='${W}' height='${H}' fill='#2a1a04' opacity='.22'/>`,
  { grain: 0.12 },
);

/** DARK: a ruined chapel at night under an eclipse, violet mist across the flagstones. */
const darkMat = scene(
  lin('sky', [[0, '#05020a'], [0.6, '#2a0e44'], [1, '#4a1a6a']]) +
    lin('fl', [[0, '#2e1a4c'], [1, '#120a20']]) +
    glowDef('cor', '#c88aff', 0.85) +
    glowDef('mist', '#a56aff', 0.5) +
    glowDef('rune', '#b36bff', 0.5),
  `<rect width='${W}' height='${H}' fill='url(#fl)'/>` +
    `<rect width='${W}' height='90' fill='url(#sky)'/>` +
    scatter(30, 401, [0, 0, 380, 70], (x, y, r) => `<circle cx='${x}' cy='${y}' r='${f(0.3 + r * 0.9)}' fill='#e6d0ff' fill-opacity='${f(0.3 + r * 0.5)}'/>`) +
    // the eclipse
    spot('cor', CX, 36, 70) +
    `<circle cx='${CX}' cy='36' r='22' fill='#05020a' stroke='#e6d0ff' stroke-width='1.2'/><path d='M${CX - 21} 30 A22 22 0 0 1 ${CX + 6} 14' fill='none' stroke='#fff' stroke-width='2' stroke-linecap='round'/>` +
    // broken arches and spires
    `<g fill='#0a0414'><path d='M0 90V30L14 10L28 30V90Z'/><path d='M40 90V44Q60 20 80 44V90H72V50Q60 36 48 50V90Z'/><path d='M300 90V44Q320 20 340 44V90H332V50Q320 36 308 50V90Z'/><path d='M352 90V26L366 6L380 26V90Z'/><path d='M100 90V64L108 56L116 64V90Z'/><path d='M264 90V60L272 50L280 60V90Z'/></g>` +
    `<path d='M0 90H380' stroke='#b36bff' stroke-opacity='.45'/>` +
    // flagstones, a rune circle, and mist
    `<g stroke='#000' stroke-opacity='.5'>${[106, 128, 154, 186].map((y) => `<path d='M0 ${y}H380'/>`).join('')}${Array.from({ length: 11 }, (_, i) => `<path d='M${CX} 90L${i * 44 - 30} 220'/>`).join('')}</g>` +
    spot('rune', CX, 150, 130, 50) +
    onFloor(150, 0.5, `<g fill='none' stroke='#d6b6ff'><circle cx='${CX}' cy='${CY}' r='94' stroke-opacity='.8' stroke-width='2'/><circle cx='${CX}' cy='${CY}' r='80' stroke-opacity='.35' stroke-dasharray='2 5' stroke-width='3'/></g><polygon points='${star(5, 78, 30)}' fill='none' stroke='#d0a0ff' stroke-opacity='.9' stroke-width='1.8'/><circle cx='${CX}' cy='${CY}' r='22' fill='#05020a' stroke='#c49bff' stroke-width='2'/>`) +
    spot('mist', 80, 120, 150, 26) +
    spot('mist', 300, 196, 150, 26),
  { grain: 0.21 },
);

/** FIRE: a volcanic field. Volcanoes on the horizon, cracked basalt with lava in the seams. */
const fireMat = scene(
  lin('sky', [[0, '#1a0402'], [0.6, '#6a1406'], [1, '#d0501a']]) +
    lin('fl', [[0, '#2a0e08'], [1, '#0e0402']]) +
    glowDef('lava', '#ff7a1a', 0.7) +
    lin('volc', [[0, '#2a0a06'], [1, '#120402']]),
  `<rect width='${W}' height='${H}' fill='url(#fl)'/>` +
    `<rect width='${W}' height='80' fill='url(#sky)'/>` +
    // volcanoes, one erupting, with lava running down
    `<path d='M-10 80L50 40L66 44L120 80Z' fill='url(#volc)'/><path d='M240 80L300 26L318 28L390 80Z' fill='url(#volc)'/><path d='M120 80L170 56L200 80Z' fill='#1a0604'/>` +
    glowLine('M308 28Q312 46 300 60Q294 70 298 80', '#ff7a1a', 1.6, '#ffe0a0') +
    glowLine('M56 42Q60 58 52 80', '#ff7a1a', 1.2, '#ffe0a0') +
    spot('lava', 309, 22, 40, 26) +
    `<g fill='#ffb04a' fill-opacity='.7'>${scatter(8, 501, [280, 0, 60, 24], (x, y) => `<circle cx='${x}' cy='${y}' r='1.4'/>`)}</g>` +
    `<path d='M0 80H380' stroke='#ff9a4a' stroke-opacity='.5'/>` +
    // cracked basalt plates with lava seams
    glowLine('M0 104L40 98L74 110', '#ff5a1a', 0.9, '#ffd27a') +
    glowLine('M380 100L338 96L300 108', '#ff5a1a', 0.9, '#ffd27a') +
    glowLine('M0 170L34 160L60 176L96 168', '#ff5a1a', 1.1, '#ffd27a') +
    glowLine('M380 166L346 156L318 172L284 164', '#ff5a1a', 1.1, '#ffd27a') +
    glowLine('M40 98L48 128L36 160M338 96L330 126L346 156', '#ff5a1a', 0.7, '#ffd27a') +
    glowLine('M130 210L150 196L176 204M250 212L232 198L206 206', '#ff5a1a', 0.7, '#ffd27a') +
    spot('lava', CX, 160, 120, 40) +
    onFloor(162, 0.5, `<circle cx='${CX}' cy='${CY}' r='70' fill='none' stroke='#ffd27a' stroke-opacity='.55' stroke-width='2'/>` + flame(CX, CY + 42, 96, '#ff7a1a', 0.55) + flame(CX, CY + 38, 62, '#ffd27a', 0.6) + flame(CX, CY + 34, 30, '#fff6d0', 0.8)) +
    Array.from({ length: 14 }, (_, i) => flame(14 + i * 27.5, 224, 22 + ((i * 37) % 20), i % 2 ? '#ff7a1a' : '#ffb04a', 0.5)).join(''),
  { grain: 0.27 },
);

/** WATER: the sea floor. Light from the surface, kelp either side, a sigil cut in the sand. */
const waterMat = scene(
  lin('bg', [[0, '#7adcff'], [0.25, '#2280c0'], [0.7, '#124680'], [1, '#081e40']]) +
    lin('sand', [[0, '#3a6688'], [1, '#12284a']]) +
    lin('ray', [[0, '#e6f8ff', 0.4], [1, '#e6f8ff', 0]]) +
    glowDef('gl', '#7adcff', 0.65) +
    `<pattern id='cs' width='60' height='40' patternUnits='userSpaceOnUse'><path d='M0 20Q15 6 30 20T60 20M0 40Q15 26 30 40' fill='none' stroke='#cff0ff' stroke-opacity='.14' stroke-width='1.4'/></pattern>`,
  fill('bg') +
    // shafts of light from the surface
    [[60, 30], [150, 22], [250, 34], [330, 18]].map(([x, w]) => `<path d='M${x - w / 2} 0L${x + w / 2} 0L${x + w * 1.6} 220L${x - w * 0.4} 220Z' fill='url(#ray)'/>`).join('') +
    `<rect width='${W}' height='120' fill='url(#cs)'/>` +
    // the sea floor, rocks and coral
    `<path d='M0 120Q95 104 190 116T380 112V220H0Z' fill='url(#sand)'/>` +
    `<path d='M0 120Q95 104 190 116T380 112' fill='none' stroke='#9fdcff' stroke-opacity='.4'/>` +
    `<g fill='#08182a'><path d='M0 220V150Q20 136 34 150L40 220Z'/><path d='M348 220L352 140Q370 128 380 140V220Z'/><ellipse cx='110' cy='196' rx='26' ry='10'/><ellipse cx='280' cy='204' rx='30' ry='9'/></g>` +
    `<g fill='#ff7a9a' fill-opacity='.55'><path d='M100 190q-4 -14 2 -22q2 10 6 4q0 10 -4 18z'/><path d='M286 198q-6 -12 0 -20q4 8 6 2q2 10 -2 18z'/></g>` +
    // kelp
    `<g fill='none' stroke='#2aa87a' stroke-opacity='.75' stroke-width='3' stroke-linecap='round'><path d='M14 220Q4 180 18 150T10 90'/><path d='M28 220Q38 186 26 160T34 112'/><path d='M366 220Q376 184 362 152T372 96'/><path d='M352 220Q344 190 356 166'/></g>` +
    spot('gl', CX, 160, 120, 40) +
    onFloor(160, 0.5, `<g fill='none' stroke='#cff0ff'><circle cx='${CX}' cy='${CY}' r='90' stroke-opacity='.55' stroke-width='2'/><circle cx='${CX}' cy='${CY}' r='76' stroke-opacity='.3' stroke-dasharray='2 4' stroke-width='3'/></g><path d='M${CX} ${CY - 54} C${CX + 12} ${CY - 30} ${CX + 36} ${CY - 10} ${CX + 36} ${CY + 12} A36 36 0 0 1 ${CX - 36} ${CY + 12} C${CX - 36} ${CY - 10} ${CX - 12} ${CY - 30} ${CX} ${CY - 54} Z' fill='#5fd0ff' fill-opacity='.4' stroke='#e6f8ff' stroke-opacity='.85' stroke-width='2'/>`) +
    scatter(16, 33, [40, 0, 300, 200], (x, y, r) => `<circle cx='${x}' cy='${y}' r='${f(1.2 + r * 2.6)}' fill='none' stroke='#e6f8ff' stroke-opacity='.35'/>`),
  { grain: 0.12 },
);

/** EARTH: a canyon floor. Layered cliff walls either side, a mesa far off, cracked dry earth. */
const earthMat = scene(
  lin('sky', [[0, '#e6a060'], [1, '#ffd8a0']]) +
    lin('fl', [[0, '#8a5a2a'], [1, '#2a1808']]) +
    lin('wall', [[0, '#a06a34'], [0.25, '#7a4a20'], [0.5, '#b07a40'], [0.75, '#6a3e1a'], [1, '#3a2010']]) +
    glowDef('gl', '#ffd8a0', 0.4),
  `<rect width='${W}' height='${H}' fill='url(#fl)'/>` +
    `<rect width='${W}' height='60' fill='url(#sky)'/>` +
    `<path d='M130 60V40H150L156 34H226L232 40H250V60Z' fill='#8a5a3a'/><path d='M130 40H250' stroke='#ffd8a0' stroke-opacity='.5'/>` +
    // the canyon walls, in strata, shadowed on their inner faces
    `<path d='M0 0H70L90 60L100 120L80 220H0Z' fill='url(#wall)'/><path d='M70 0L90 60L100 120L80 220' fill='none' stroke='#2a1408' stroke-opacity='.6' stroke-width='3'/>` +
    `<path d='M380 0H310L290 60L280 120L300 220H380Z' fill='url(#wall)'/><path d='M310 0L290 60L280 120L300 220' fill='none' stroke='#ffd8a0' stroke-opacity='.35' stroke-width='2'/>` +
    `<g stroke='#2a1408' stroke-opacity='.4'>${[24, 52, 86, 130, 176].map((y) => `<path d='M0 ${y}H${f(76 + y * 0.1)}M${f(304 - y * 0.1)} ${y}H380'/>`).join('')}</g>` +
    // cracked earth toward you
    `<g fill='none' stroke='#1a0e04' stroke-opacity='.6' stroke-width='1.4'>${scatter(14, 601, [96, 70, 190, 140], (x, y, r) => `<path d='M${x} ${y}l${f(10 + r * 14)} ${f(4 - r * 8)}l${f(6 + r * 6)} ${f(10 + r * 6)}M${x} ${y}l${f(-4 - r * 6)} ${f(12 + r * 8)}'/>`)}</g>` +
    spot('gl', CX, 150, 120, 46) +
    onFloor(156, 0.5, `<g fill='none' stroke='#f2d8a8'><circle cx='${CX}' cy='${CY}' r='92' stroke-opacity='.6' stroke-width='3'/><polygon points='${around(6, 80).map((p) => p.join(',')).join(' ')}' stroke-opacity='.4' stroke-width='1.6'/></g>` +
      `<path d='M${CX - 56} ${CY + 34} L${CX - 20} ${CY - 34} L${CX - 4} ${CY - 12} L${CX + 14} ${CY - 46} L${CX + 56} ${CY + 34} Z' fill='#6a4a22' fill-opacity='.75' stroke='#f2d8a8' stroke-width='2' stroke-linejoin='round'/><path d='M${CX + 14} ${CY - 46} L${CX + 4} ${CY - 26} L${CX + 22} ${CY - 30} Z M${CX - 20} ${CY - 34} L${CX - 27} ${CY - 20} L${CX - 13} ${CY - 22} Z' fill='#fff6e0' fill-opacity='.8'/>`) +
    scatter(10, 602, [100, 170, 180, 46], (x, y, r) => `<ellipse cx='${x}' cy='${y}' rx='${f(3 + r * 5)}' ry='${f(1.6 + r * 2)}' fill='#4a2e14'/><path d='M${f(x - 2)} ${f(y - 1.2)}h${f(3 + r * 3)}' stroke='#d8a870' stroke-opacity='.5'/>`),
  { grain: 0.3 },
);

/** WIND: a stone platform above the clouds, banners streaming, the sky going on forever. */
const windMat = scene(
  lin('sky', [[0, '#3aa0d8'], [0.5, '#8ad8e8'], [1, '#d8f8f0']]) +
    lin('stone', [[0, '#6a8a7a'], [1, '#1e3a30']]) +
    glowDef('cl', '#ffffff', 0.85) +
    glowDef('gl', '#b8f2d0', 0.45),
  `<rect width='${W}' height='${H}' fill='url(#sky)'/>` +
    // banks of cloud, back to front
    [[40, 40, 90, 18], [180, 30, 120, 16], [330, 46, 100, 18], [100, 74, 160, 22], [300, 80, 140, 22]].map(([x, y, rx, ry]) => spot('cl', x, y, rx, ry)).join('') +
    `<g fill='none' stroke='#fff' stroke-opacity='.6' stroke-width='1.6' stroke-linecap='round'><path d='M20 20q40 -10 80 0M250 60q40 -10 90 0M120 52q30 -8 60 0'/></g>` +
    // the floating platform: a disc of stone with a lit rim
    `<path d='M-20 110Q190 84 400 110V220H-20Z' fill='url(#stone)'/>` +
    `<path d='M-20 110Q190 84 400 110' fill='none' stroke='#e6fff2' stroke-opacity='.7' stroke-width='2'/>` +
    `<g stroke='#0e2018' stroke-opacity='.4'>${Array.from({ length: 11 }, (_, i) => `<path d='M${CX} 70L${i * 44 - 30} 220'/>`).join('')}${[126, 150, 182].map((y) => `<path d='M0 ${y}H380'/>`).join('')}</g>` +
    // banners streaming on poles
    [[24, 1], [356, -1]].map(([x, d]) => `<path d='M${x} 220V96' stroke='#d8e8e0' stroke-width='2.4'/><path d='M${x} 100q${d * 30} 4 ${d * 52} -2q${d * -10} 10 0 18q${d * -28} -2 ${d * -52} 4z' fill='#2aa87a' stroke='#e6fff2' stroke-opacity='.6'/>`).join('') +
    spot('gl', CX, 160, 120, 40) +
    onFloor(160, 0.5, `<circle cx='${CX}' cy='${CY}' r='92' fill='none' stroke='#e6fff2' stroke-opacity='.6' stroke-width='2.4'/><g fill='none' stroke='#e6fff2' stroke-linecap='round' stroke-opacity='.85'><path d='M${CX} ${CY} m-7 0 a7 7 0 1 1 14 0 a17 17 0 1 1 -34 0 a28 28 0 1 1 56 0 a42 42 0 1 1 -84 0' stroke-width='3'/></g>`) +
    scatter(12, 51, [0, 0, 380, 220], (x, y, r) => `<path d='M${x} ${y}q5 -6 10 0q-5 6 -10 0z' fill='#2aa87a' fill-opacity='.7' transform='rotate(${f(r * 360)} ${x} ${y})'/>`) +
    `<rect width='${W}' height='${H}' fill='#0a2a20' opacity='.18'/>`,
  { grain: 0.09 },
);
const lightTrim = trim(GOLD, '#fffbe8', 'star');
const darkTrim = trim(OBSIDIAN, '#b36bff', 'diamond', '#c49bff');
const fireTrim = trim(BRONZE, '#ff5a1a', 'gem');
const waterTrim = trim(SILVER, '#5fd0ff', 'gem', '#cff0ff');
const earthTrim = trim(BRONZE, '#c8a060', 'diamond');
const windTrim = trim(SILVER, '#7ad8a4', 'wing', '#e6fff2');

/** Battle City: a rooftop at night, the skyline lit up across the middle, a helipad underfoot. */
const city = scene(
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
    `<path d='M174 150V174M206 150V174M174 162H206' stroke='#ffd04a' stroke-opacity='.75' stroke-width='6'/>` +
    // rooftop props: a water tower, vents, a railing along the parapet
    `<g fill='#1a1a2a'><rect x='22' y='118' width='34' height='26' rx='3'/><path d='M18 118L39 104L60 118Z'/><rect x='24' y='144' width='3' height='20'/><rect x='51' y='144' width='3' height='20'/><rect x='320' y='130' width='40' height='22'/><rect x='300' y='176' width='26' height='16'/></g>` +
    `<g stroke='#8a8ab0' stroke-opacity='.45'><path d='M22 118H56M320 130H360'/></g>` +
    `<g stroke='#6a6a90' stroke-opacity='.6'>${Array.from({ length: 20 }, (_, i) => `<path d='M${i * 20} 100V92'/>`).join('')}<path d='M0 92H380'/></g>` +
    `<g fill='#3ae0ff'>${around(10, 1, CX, 162).map((_, i) => { const a = (i / 10) * Math.PI * 2; return `<circle cx='${f(CX + Math.cos(a) * 92)}' cy='${f(162 + Math.sin(a) * 40)}' r='1.8'/>`; }).join('')}</g>`,
);
const cityTrim = trim(SILVER, '#ff7ac0', 'diamond', '#d8c8ff');

/** Kaiba Dome: a stadium in the dark, its stands lit in rings, spotlights crossing the floor. */
const dome = scene(
  rad('bg', [[0, '#2a50b0'], [0.6, '#0e1e52'], [1, '#040a20']], '50%', '0%', '110%') +
    lin('beam', [[0, '#e6f2ff', 0.5], [1, '#e6f2ff', 0.04]]) +
    lin('floor', [[0, '#24407e'], [1, '#101c46']]) +
    glowDef('em', '#8fd0ff', 0.55),
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
    spot('em', CX, 146, 120, 52) +
    `<g transform='translate(${CX} 146) scale(1 .5)'><circle r='70' fill='none' stroke='#cfe6ff' stroke-opacity='.55' stroke-width='3'/><circle r='58' fill='none' stroke='#6cc4ff' stroke-opacity='.35' stroke-width='8' stroke-dasharray='4 4'/>` +
    `<path d='M0 -44 L14 -10 L52 -26 L24 6 L44 40 L0 22 L-44 40 L-24 6 L-52 -26 L-14 -10 Z' fill='#cfe6ff' fill-opacity='.22' stroke='#e6f2ff' stroke-opacity='.75' stroke-width='2' stroke-linejoin='round'/>` +
    `<circle r='12' fill='#6cc4ff' fill-opacity='.8'/></g>`,
);
const domeTrim = trim(CHROME, '#6cc4ff', 'wing', '#cfe6ff');

/** Pegasus's castle: the great hall at dusk. Light from the rose window falls across the marble to the red carpet at your feet. */
const castle = scene(
  lin('bg', [[0, '#2a1430'], [1, '#0e0610']]) +
    rad('rose', [[0, '#fff2c0'], [0.3, '#ff9ae8', 0.85], [0.7, '#6a5aff', 0.6], [1, '#2a1a5a', 0]]) +
    lin('shaft', [[0, '#ffd0f0', 0.35], [1, '#ffd0f0', 0]]) +
    lin('cp', [[0, '#7a0e1c'], [1, '#c02238']]) +
    lin('col', [[0, '#3a2a3a'], [0.35, '#b8a0b8'], [0.6, '#7a6a7a'], [1, '#2a1a2a']], 1, 0) +
    lin('fl', [[0, '#3a2a3a'], [1, '#140a14']]) +
    glowDef('cand', '#ffd27a', 0.55),
  fill('bg') +
    // the far wall: a row of arched windows, deep in shadow, with the rose window in the middle
    `<g fill='#160a18' stroke='#c8a0c8' stroke-opacity='.3'>${[0, 1, 2, 4, 5, 6].map((i) => `<path d='M${i * 56 - 10} 84V40Q${i * 56 + 16} 12 ${i * 56 + 42} 40V84Z'/>`).join('')}</g>` +
    `<g fill='#6a5aff' fill-opacity='.18'>${[0, 1, 2, 4, 5, 6].map((i) => `<path d='M${i * 56 - 2} 84V44Q${i * 56 + 16} 22 ${i * 56 + 34} 44V84Z'/>`).join('')}</g>` +
    `<circle cx='${CX}' cy='42' r='40' fill='url(#rose)'/>` +
    `<g fill='none' stroke='#1a0a1a' stroke-width='2'>${around(12, 37, CX, 42).map(([x, y]) => `<line x1='${CX}' y1='42' x2='${x}' y2='${y}'/>`).join('')}<circle cx='${CX}' cy='42' r='37'/><circle cx='${CX}' cy='42' r='22'/><circle cx='${CX}' cy='42' r='8'/></g>` +
    `<circle cx='${CX}' cy='42' r='41' fill='none' stroke='#f0cf7a' stroke-opacity='.7' stroke-width='2.4'/>` +
    // light from the window falling across the hall
    `<path d='M160 60L220 60L300 220H80Z' fill='url(#shaft)'/>` +
    // the floor: polished marble with the window's reflection, the carpet down the middle
    `<rect y='84' width='${W}' height='136' fill='url(#fl)'/>` +
    `<g stroke='#e6d0e6' stroke-opacity='.12'>${Array.from({ length: 13 }, (_, i) => `<path d='M${CX} 40L${i * 36 - 26} 220'/>`).join('')}${[100, 122, 152, 192].map((y) => `<path d='M0 ${y}H380'/>`).join('')}</g>` +
    `<ellipse cx='${CX}' cy='120' rx='30' ry='8' fill='#ff9ae8' fill-opacity='.25'/>` +
    `<path d='M172 84L138 220H242L208 84Z' fill='url(#cp)'/>` +
    `<path d='M172 84L138 220M208 84L242 220' stroke='#f0cf7a' stroke-width='2.4'/>` +
    `<g fill='#f0cf7a' fill-opacity='.55'>${[110, 140, 176].map((y) => { const k = (y - 84) / 136; const w = 18 + k * 34; return `<path d='M${f(CX - w / 3)} ${y}l${f(w / 3)} -4l${f(w / 3)} 4l${f(-w / 3)} 4z'/>`; }).join('')}</g>` +
    // columns down each side, lit on the window side
    [[22, 20, 60], [338, 20, 60], [88, 12, 76], [280, 12, 76]].map(([x, w, y]) => `<rect x='${x}' y='${y}' width='${w}' height='${220 - y}' fill='url(#col)'/><rect x='${x - 3}' y='${y - 5}' width='${w + 6}' height='6' fill='#f0cf7a' fill-opacity='.65'/><rect x='${x - 3}' y='${y + 4}' width='${w + 6}' height='2' fill='#000' fill-opacity='.4'/>`).join('') +
    // candelabras
    [[52, 112], [328, 112]].map(([x, y]) => spot('cand', x, y, 34, 26) + `<path d='M${x} ${y + 24}V${y}M${x - 9} ${y + 2}Q${x} ${y + 10} ${x + 9} ${y + 2}' fill='none' stroke='#f0cf7a' stroke-width='1.6'/>` + flame(x - 9, y + 1, 7, '#ffe2a0') + flame(x, y - 1, 8, '#ffe2a0') + flame(x + 9, y + 1, 7, '#ffe2a0')).join(''),
  { grain: 0.15 },
);
const castleTrim = trim(GOLD, '#ff9ae8', 'gem');

/** Duel Academy: the island school at dawn over the sea, the crest inlaid in the courtyard. */
const academy = scene(
  lin('sky', [[0, '#4a88e0'], [0.6, '#ffc8a0'], [1, '#ffe8c0']]) +
    lin('sea', [[0, '#4a9ad8'], [1, '#0e3a6a']]) +
    lin('yard', [[0, '#a89870'], [1, '#4a3e2a']]) +
    lin('wallF', [[0, '#f4efe2'], [1, '#c8c0a8']]) +
    lin('wallS', [[0, '#b8b0a0'], [1, '#8a8270']]) +
    lin('roof', [[0, '#4a7ae0'], [1, '#1a3a8a']]) +
    glowDef('sun', '#fff2c0', 0.9) +
    glowDef('gl', '#ffe27a', 0.45),
  `<rect width='${W}' height='${H}' fill='url(#yard)'/>` +
    `<rect width='${W}' height='76' fill='url(#sky)'/>` +
    spot('sun', 70, 64, 70, 40) +
    `<g fill='#fff' fill-opacity='.5'><ellipse cx='300' cy='22' rx='50' ry='5'/><ellipse cx='110' cy='30' rx='40' ry='4'/></g>` +
    // the volcano, the sea, the cliffs the school sits on
    `<path d='M268 68L304 30Q310 26 316 30L356 68Z' fill='#7a6a8a'/><path d='M304 30Q310 26 316 30L326 44L312 40L300 46Z' fill='#e8e0f0' fill-opacity='.8'/><path d='M310 24q4 -10 -2 -16q8 2 6 14' fill='#fff' fill-opacity='.5'/>` +
    `<rect y='64' width='${W}' height='18' fill='url(#sea)'/><path d='M40 70h60M150 74h40' stroke='#fff' stroke-opacity='.4'/>` +
    // the school: lit front, shaded side, blue roofs, a gold-domed tower
    `<rect x='118' y='42' width='136' height='30' fill='url(#wallF)'/><path d='M254 42L270 48V72H254Z' fill='url(#wallS)'/>` +
    `<rect x='170' y='22' width='38' height='50' fill='url(#wallF)'/><path d='M208 22L218 27V72H208Z' fill='url(#wallS)'/>` +
    `<path d='M112 44L190 32L268 44L274 48L254 42H118Z' fill='url(#roof)'/><path d='M164 24L189 10L214 24Z' fill='url(#roof)'/>` +
    `<ellipse cx='189' cy='10' rx='6' ry='4' fill='#ffd04a'/><path d='M189 6V0' stroke='#ffd04a'/>` +
    `<g fill='#2a5ab0'>${Array.from({ length: 11 }, (_, i) => `<rect x='${124 + i * 12}' y='50' width='5' height='9' fill-opacity='${i % 3 ? 0.8 : 0.5}'/>`).join('')}<rect x='182' y='34' width='14' height='18' rx='7'/></g>` +
    `<rect x='182' y='56' width='14' height='16' fill='#6a4a2a'/>` +
    `<path d='M0 82H380' stroke='#fff' stroke-opacity='.6'/>` +
    // courtyard paving in perspective, and the crest
    `<g stroke='#3a2e1a' stroke-opacity='.35'>${Array.from({ length: 13 }, (_, i) => `<path d='M${CX} 60L${i * 36 - 26} 220'/>`).join('')}${[98, 120, 150, 190].map((y) => `<path d='M0 ${y}H380'/>`).join('')}</g>` +
    spot('gl', CX, 156, 120, 44) +
    onFloor(156, 0.52, `<circle cx='${CX}' cy='${CY}' r='94' fill='none' stroke='#ffe27a' stroke-opacity='.7' stroke-width='3'/><circle cx='${CX}' cy='${CY}' r='84' fill='#1a3a8a' fill-opacity='.35'/>` +
      `<path d='M${CX} ${CY - 60} L${CX + 48} ${CY - 42} V${CY + 4} Q${CX + 48} ${CY + 40} ${CX} ${CY + 60} Q${CX - 48} ${CY + 40} ${CX - 48} ${CY + 4} V${CY - 42} Z' fill='#2a5ab0' fill-opacity='.8' stroke='#ffd04a' stroke-width='3'/>` +
      `<polygon points='${star(5, 26, 11)}' fill='#ffd04a'/><path d='M${CX - 34} ${CY + 30} Q${CX} ${CY + 46} ${CX + 34} ${CY + 30}' fill='none' stroke='#ffd04a' stroke-width='2.4'/>`),
  { grain: 0.18 },
);
const academyTrim = trim(GOLD, '#2a5ab0', 'star');

/** Starfall: the observatory under the night sky, a dragon drawn in the stars, the brass floor rings. */
const starfall = scene(
  rad('bg', [[0, '#2a3a8a'], [0.6, '#0c1240'], [1, '#03040e']], '50%', '0%', '110%') +
    glowDef('neb', '#b07aff', 0.4) +
    glowDef('neb2', '#4ad0ff', 0.25) +
    lin('dome', [[0, '#5a6aa0'], [1, '#1a2040']], 1, 0) +
    glowDef('gl', '#e6c27a', 0.4),
  fill('bg') +
    spot('neb', 110, 40, 130, 42) +
    spot('neb2', 290, 60, 100, 30) +
    `<path d='M-10 70Q190 30 390 70' fill='none' stroke='#fff' stroke-opacity='.06' stroke-width='40'/>` +
    scatter(80, 81, [0, 0, 380, 120], (x, y, r) => `<circle cx='${x}' cy='${y}' r='${f(0.3 + r * 1)}' fill='#fff' fill-opacity='${f(0.25 + r * 0.7)}'/>`) +
    (() => {
      const pts: [number, number][] = [[70, 52], [100, 34], [130, 40], [158, 26], [190, 34], [214, 54], [204, 76], [176, 84], [150, 74]];
      const line = `<polyline points='${pts.map((q) => q.join(',')).join(' ')}' fill='none' stroke='#bcd0ff' stroke-opacity='.55' stroke-width='1'/>`;
      return line + pts.map(([x, y], i) => `<circle cx='${x}' cy='${y}' r='6' fill='#bcd0ff' fill-opacity='.2'/><circle cx='${x}' cy='${y}' r='${i % 3 ? 1.6 : 2.6}' fill='#fff'/>`).join('');
    })() +
    // the observatory: its dome open, the telescope pointing at the dragon's head
    `<path d='M250 96V74A36 36 0 0 1 322 74V96Z' fill='url(#dome)'/><path d='M276 42L290 40L292 74H278Z' fill='#05060e'/>` +
    `<path d='M286 66L246 26' stroke='#c8b080' stroke-width='6' stroke-linecap='round'/><path d='M286 66L246 26' stroke='#fff' stroke-opacity='.4' stroke-width='1.4'/>` +
    `<rect x='244' y='94' width='84' height='6' fill='#2a3058'/>` +
    `<g fill='#ffd88a'><rect x='262' y='80' width='4' height='6'/><rect x='306' y='80' width='4' height='6'/></g>` +
    // the floor: dark wood and the brass rings of an orrery
    `<rect y='100' width='${W}' height='120' fill='#120e1a'/>` +
    `<g stroke='#000' stroke-opacity='.5'>${Array.from({ length: 11 }, (_, i) => `<path d='M${CX} 60L${i * 44 - 30} 220'/>`).join('')}</g>` +
    `<path d='M0 100H380' stroke='#e6c27a' stroke-opacity='.4'/>` +
    spot('gl', CX, 160, 140, 46) +
    onFloor(160, 0.5, `<g fill='none' stroke='#e6c27a'><circle cx='${CX}' cy='${CY}' r='96' stroke-opacity='.75' stroke-width='3'/><circle cx='${CX}' cy='${CY}' r='70' stroke-opacity='.5' stroke-width='1.6'/><circle cx='${CX}' cy='${CY}' r='40' stroke-opacity='.5'/></g>` +
      `<g fill='#e6c27a'>${around(12, 96).map(([x, y]) => `<circle cx='${x}' cy='${y}' r='2.4'/>`).join('')}</g><circle cx='${CX + 70}' cy='${CY}' r='7' fill='#bcd0ff'/><circle cx='${CX - 28}' cy='${CY - 28}' r='5' fill='#ff9a6a'/><circle cx='${CX}' cy='${CY}' r='12' fill='#ffd88a'/>`),
  { grain: 0.15 },
);
const starfallTrim = trim(BRONZE, '#bcd0ff', 'star', '#e6c27a');

/** The Millennium Stone: the tablet with the seven items' places, gold on sandstone. */
const millennium = scene(
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
  { grain: 0.18 },
);
const millenniumTrim = trim(GOLD, '#2aa0a0', 'ankh');

/** The Shadow Realm: an eye in a violet sky, broken stone plates hanging in the void, chains, and fog. */
const shadowrealm = scene(
  rad('bg', [[0, '#5a1a7a'], [0.5, '#1e0a30'], [1, '#05020a']], '50%', '15%', '90%') +
    glowDef('fog', '#c070ff', 0.4) +
    rad('eyeg', [[0, '#ff4ad0', 0.9], [0.4, '#a020ff', 0.5], [1, '#a020ff', 0]]) +
    lin('plate', [[0, '#3a2050'], [1, '#120820']]) +
    glowDef('rune', '#ff4ad0', 0.5),
  fill('bg') +
    `<ellipse cx='${CX}' cy='34' rx='130' ry='40' fill='url(#eyeg)'/>` +
    eye(CX, 38, 72, '#f0c0ff', '#ff4ad0', 0.85) +
    `<g fill='none' stroke='#e0a0ff' stroke-opacity='.25'>${[60, 80, 100].map((r) => `<ellipse cx='${CX}' cy='38' rx='${r * 1.6}' ry='${r * 0.32}'/>`).join('')}</g>` +
    // spires far off, with violet rim light
    `<g fill='#0c0414' stroke='#c070ff' stroke-opacity='.6' stroke-width='1.2'><path d='M0 120L18 60L28 90L40 50L56 120Z'/><path d='M324 120L340 56L350 86L364 44L380 120Z'/></g>` +
    // stone plates hanging in the void, lit along their top edges, the duel's plate in the middle
    [[40, 150, 46, 14], [334, 140, 40, 12], [100, 204, 40, 10], [290, 206, 44, 10]].map(([x, y, rx, ry]) => `<ellipse cx='${x}' cy='${y + 6}' rx='${rx}' ry='${ry}' fill='#05020a'/><ellipse cx='${x}' cy='${y}' rx='${rx}' ry='${ry}' fill='url(#plate)' stroke='#c070ff' stroke-opacity='.6'/>`).join('') +
    `<ellipse cx='${CX}' cy='160' rx='132' ry='42' fill='#05020a'/><ellipse cx='${CX}' cy='152' rx='132' ry='42' fill='url(#plate)' stroke='#e0a0ff' stroke-opacity='.7' stroke-width='1.4'/>` +
    `<g stroke='#05020a' stroke-width='1.6' fill='none'><path d='M90 140l20 10l-6 14M296 136l-18 14l8 12M176 184l10 -12l14 6'/></g>` +
    spot('rune', CX, 152, 110, 34) +
    onFloor(152, 0.32, `<g fill='none' stroke='#ff4ad0' stroke-opacity='.75'><circle cx='${CX}' cy='${CY}' r='100' stroke-width='2.4'/><circle cx='${CX}' cy='${CY}' r='86' stroke-dasharray='3 5' stroke-width='2'/></g><polygon points='${star(5, 96, 38)}' fill='none' stroke='#ff4ad0' stroke-opacity='.7' stroke-width='2'/>`) +
    // chains down into the dark
    `<g fill='none' stroke='#8a6aa8' stroke-opacity='.6' stroke-width='1.6'>${[70, 312].map((x) => Array.from({ length: 6 }, (_, i) => `<ellipse cx='${x}' cy='${96 + i * 9}' rx='2.4' ry='4.6'/>`).join('')).join('')}</g>` +
    spot('fog', 90, 112, 140, 22) +
    spot('fog', 300, 196, 140, 24),
  { grain: 0.2 },
);
const shadowrealmTrim = trim(OBSIDIAN, '#ff4ad0', 'diamond', '#e0a0ff');

/** The Pharaoh's tomb: a gold-lit burial hall, pillars, wall paintings and the ankh. */
const tomb = scene(
  lin('bg', [[0, '#1a1006'], [0.45, '#5a3a14'], [1, '#2a1a08']]) + rad('torch', [[0, '#ffcf6a', 0.55], [1, '#ffcf6a', 0]]) + lin('pil', [[0, '#3a2a10'], [0.5, '#a07a3a'], [1, '#3a2a10']], 1, 0),
  fill('bg') +
    // the far wall: dark stone with one thin painted band (no frieze: the opponent's half turns it round at the seam)
    `<rect width='${W}' height='76' fill='#24180a'/>` +
    `<rect y='62' width='${W}' height='4' fill='#2aa0a0' fill-opacity='.45'/>` +
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
  { grain: 0.18 },
);
const tombTrim = trim(GOLD, '#2aa0a0', 'ankh');

/** Holo Arena: a mirrored foil stage, rainbow light washing across it, prism shards hanging over the horizon. */
const holo = scene(
  lin('bg', [[0, '#ff7ad8'], [0.2, '#7ab8ff'], [0.4, '#7affd8'], [0.6, '#fff07a'], [0.8, '#ffaa7a'], [1, '#c07aff']], 1, 0.4) +
    lin('fl', [[0, '#1a1040', 0.3], [1, '#05030e', 0.8]]) +
    lin('sky', [[0, '#05030e', 0.85], [1, '#1a1040', 0.4]]) +
    glowDef('gl', '#ffffff', 0.5) +
    `<pattern id='dm' width='16' height='16' patternUnits='userSpaceOnUse'><path d='M8 0L16 8L8 16L0 8Z' fill='none' stroke='#fff' stroke-opacity='.16' stroke-width='.8'/></pattern>`,
  fill('bg') +
    `<rect width='${W}' height='80' fill='url(#sky)'/>` +
    `<rect y='80' width='${W}' height='140' fill='url(#fl)'/>` +
    `<rect y='80' width='${W}' height='140' fill='url(#dm)'/>` +
    // prism shards floating over the horizon, each splitting light
    [[60, 40, 14, -12], [130, 26, 10, 18], [250, 34, 12, -20], [320, 46, 16, 10], [190, 18, 8, 0]]
      .map(([x, y, r, a]) => `<g transform='rotate(${a} ${x} ${y})'><polygon points='${x},${y - r * 1.6} ${x + r},${y} ${x},${y + r * 1.6} ${x - r},${y}' fill='#fff' fill-opacity='.3' stroke='#fff' stroke-opacity='.85'/><path d='M${x} ${y - r * 1.6}V${y + r * 1.6}' stroke='#fff' stroke-opacity='.5'/></g>`)
      .join('') +
    `<path d='M0 80H380' stroke='#fff' stroke-opacity='.7' stroke-width='1.4'/>` +
    `<g stroke='#fff' stroke-opacity='.12'>${Array.from({ length: 13 }, (_, i) => `<path d='M${CX} 40L${i * 36 - 26} 220'/>`).join('')}</g>` +
    spot('gl', CX, 156, 150, 46) +
    onFloor(156, 0.5, `<g fill='none' stroke='#fff'><circle cx='${CX}' cy='${CY}' r='96' stroke-opacity='.75' stroke-width='2.6'/><circle cx='${CX}' cy='${CY}' r='80' stroke-opacity='.4'/></g><polygon points='${star(4, 70, 14)}' fill='#fff' fill-opacity='.45'/><polygon points='${star(4, 50, 10, CX, CY, -45)}' fill='#fff' fill-opacity='.3'/>`) +
    scatter(14, 91, [10, 90, 360, 120], (x, y, r) => `<polygon points='${star(4, 3 + r * 4, 0.8 + r, x, y)}' fill='#fff' fill-opacity='${f(0.3 + r * 0.5)}'/>`),
);
const holoTrim = trim(['#ffffff', '#b07ad8', '#7ad8ff'], '#ff9ae8', 'star', '#ffffff');

/** Heart of the Cards: dusk over a field of light, a deck on a stone pedestal sending up a pillar of warm light. */
const heart = scene(
  lin('sky', [[0, '#2a0e2a'], [0.5, '#a0402a'], [1, '#ffb070']]) +
    lin('fl', [[0, '#5a2a14'], [1, '#1a0806']]) +
    lin('pil', [[0, '#fff6d0', 0], [0.5, '#fff6d0', 0.7], [1, '#fff6d0', 0]], 1, 0) +
    glowDef('gl', '#fff2c0', 0.8) +
    glowDef('fl2', '#ffb04a', 0.45) +
    lin('ped', [[0, '#a07a5a'], [1, '#3a2010']], 1, 0),
  `<rect width='${W}' height='${H}' fill='url(#fl)'/>` +
    `<rect width='${W}' height='92' fill='url(#sky)'/>` +
    scatter(20, 701, [0, 0, 380, 50], (x, y, r) => `<circle cx='${x}' cy='${y}' r='${f(0.4 + r * 0.8)}' fill='#fff' fill-opacity='${f(0.3 + r * 0.5)}'/>`) +
    `<g fill='#5a2030' fill-opacity='.7'><path d='M0 92Q60 76 120 86T260 82T380 90V92Z'/></g>` +
    // the pillar of light and the glow round it
    `<rect x='${CX - 26}' y='0' width='52' height='96' fill='url(#pil)'/>` +
    spot('gl', CX, 84, 90, 46) +
    // the pedestal and the deck on it, edge lit
    `<path d='M${CX - 26} 102H${CX + 26}L${CX + 20} 92H${CX - 20}Z' fill='url(#ped)'/><rect x='${CX - 30}' y='102' width='60' height='6' fill='#3a2010'/>` +
    `<g opacity='1'>${[3, 2, 1, 0].map((i) => `<rect x='${CX - 11 + i}' y='${70 - i * 1.6}' width='22' height='22' rx='2' fill='${i ? '#3a1a10' : '#5a2a14'}' stroke='#ffe2b0' stroke-opacity='${i ? 0.3 : 0.9}'/>`).join('')}</g>` +
    `<path d='M${CX} 86 C${CX - 8} 80 ${CX - 6} 74 ${CX} 77 C${CX + 6} 74 ${CX + 8} 80 ${CX} 86 Z' fill='#ffcf8a'/>` +
    // the field of light toward you
    `<g stroke='#ffe2b0' stroke-opacity='.18'>${Array.from({ length: 13 }, (_, i) => `<path d='M${CX} 92L${i * 36 - 26} 220'/>`).join('')}</g>` +
    `<path d='M0 92H380' stroke='#ffe2b0' stroke-opacity='.55'/>` +
    spot('fl2', CX, 160, 170, 54) +
    onFloor(160, 0.5, `<circle cx='${CX}' cy='${CY}' r='94' fill='none' stroke='#ffe2b0' stroke-opacity='.7' stroke-width='2.4'/><circle cx='${CX}' cy='${CY}' r='80' fill='none' stroke='#ffe2b0' stroke-opacity='.35' stroke-dasharray='2 5' stroke-width='3'/>${rays(16, 30, 76, '#ffe2b0', 2, 0.45)}<path d='M${CX} ${CY + 26} C${CX - 36} ${CY + 2} ${CX - 24} ${CY - 26} ${CX} ${CY - 12} C${CX + 24} ${CY - 26} ${CX + 36} ${CY + 2} ${CX} ${CY + 26} Z' fill='#ff7a4a' fill-opacity='.35' stroke='#ffe2b0' stroke-opacity='.7' stroke-width='1.6'/>`) +
    scatter(22, 101, [0, 92, 380, 128], (x, y, r) => `<circle cx='${x}' cy='${y}' r='${f(0.6 + r * 1.4)}' fill='#fff6d0' fill-opacity='${f(0.2 + r * 0.5)}'/>`),
  { grain: 0.15 },
);
const heartTrim = trim(GOLD, '#ff6a4a', 'gem');

export const PLAYMAT_SVG = {
  blue,
  crimson,
  kingdom,
  disk,
  light: lightMat,
  dark: darkMat,
  fire: fireMat,
  water: waterMat,
  earth: earthMat,
  wind: windMat,
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
/** How strong each mat's grain lies over its scene (0: none). */
export const PLAYMAT_GRAIN = Object.fromEntries(Object.entries(PLAYMAT_SVG).map(([k, v]) => [k, GRAIN.get(v) ?? 0])) as Record<PlaymatId, number>;
/** The grain: 96 px of fixed dots, light and dark, no filter (cheap at any size). */
export function grainTile(): string {
  const T = 96;
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${T} ${T}' width='${T}' height='${T}'>${scatter(340, 77, [0, 0, T, T], (x, y, r, i) => `<rect x='${x}' y='${y}' width='${r > 0.8 ? 2 : 1}' height='1' fill='${i % 3 ? '#000' : '#fff'}' opacity='${f(0.25 + r * 0.6)}'/>`)}</svg>`;
}

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
/** The CSS url() of the grain tile (made once). */
export function grainUrl(): string {
  let u = urls.get('grain');
  if (!u) urls.set('grain', (u = cssUrl(grainTile())));
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
