// The sleeve pictures: each one an SVG card back (100 x 146), drawn once and turned into a
// data URL that every face-down card of that duelist shares. No images to download, nothing
// redrawn in a duel: the browser decodes each picture once and reuses it.

const W = 100;
const H = 146;
const CX = 50;
const CY = 73;

const f = (n: number) => +n.toFixed(2);

/** Points round a circle (for stars, rays, rings of dots). */
function around(n: number, r: number, cx = CX, cy = CY, turn = -90): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = ((turn + (360 * i) / n) * Math.PI) / 180;
    return [f(cx + r * Math.cos(a)), f(cy + r * Math.sin(a))];
  });
}
/** A star with n points (outer radius r1, inner r2). */
function star(n: number, r1: number, r2: number, cx = CX, cy = CY, turn = -90): string {
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? r2 : r1;
    const a = ((turn + (180 * i) / n) * Math.PI) / 180;
    pts.push(`${f(cx + r * Math.cos(a))},${f(cy + r * Math.sin(a))}`);
  }
  return pts.join(' ');
}
/** Rays from the middle out past the edges. */
function rays(n: number, r0: number, r1: number, stroke: string, width: number, opacity = 1, cx = CX, cy = CY): string {
  const inner = around(n, r0, cx, cy);
  const outer = around(n, r1, cx, cy);
  return `<g stroke='${stroke}' stroke-width='${width}' stroke-opacity='${opacity}' stroke-linecap='round'>${inner.map(([x, y], i) => `<line x1='${x}' y1='${y}' x2='${outer[i][0]}' y2='${outer[i][1]}'/>`).join('')}</g>`;
}

/** The printed frame every sleeve shares: a metal edge, a fine inner line and corner brackets. */
function frame(metal: [string, string, string], line: string, corners = metal[0], inset = 4.5): string {
  const i2 = inset + 2.5;
  return (
    `<linearGradient id='fm' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${metal[0]}'/><stop offset='.5' stop-color='${metal[1]}'/><stop offset='1' stop-color='${metal[2]}'/></linearGradient>` +
    `</defs>` +
    `@@BODY@@` +
    `<rect x='${inset}' y='${inset}' width='${W - inset * 2}' height='${H - inset * 2}' rx='3' fill='none' stroke='url(#fm)' stroke-width='1.6'/>` +
    `<rect x='${i2}' y='${i2}' width='${W - i2 * 2}' height='${H - i2 * 2}' rx='2' fill='none' stroke='${line}' stroke-opacity='.35' stroke-width='.6'/>` +
    `<path d='M${i2} ${i2 + 11}V${i2}h11M${W - i2} ${i2 + 11}V${i2}h-11M${i2} ${H - i2 - 11}v11h11M${W - i2} ${H - i2 - 11}v11h-11' fill='none' stroke='${corners}' stroke-width='2'/>`
  );
}

/** One full sleeve: background defs + body drawn inside the frame. */
function sleeve(defs: string, body: string, metal: [string, string, string], line: string, corners?: string): string {
  const fr = frame(metal, line, corners);
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}'><defs>${defs}${fr.replace('@@BODY@@', body)}</svg>`;
}

const radialBg = (stops: [number, string][], cx = '50%', cy = '50%', r = '70%') => `<radialGradient id='bg' cx='${cx}' cy='${cy}' r='${r}'>${stops.map(([o, c]) => `<stop offset='${o}' stop-color='${c}'/>`).join('')}</radialGradient>`;
const linearBg = (stops: [number, string][], x2 = 0, y2 = 1) => `<linearGradient id='bg' x1='0' y1='0' x2='${x2}' y2='${y2}'>${stops.map(([o, c]) => `<stop offset='${o}' stop-color='${c}'/>`).join('')}</linearGradient>`;
const BG = `<rect width='${W}' height='${H}' fill='url(#bg)'/>`;
const GOLD: [string, string, string] = ['#f6dc96', '#9a6a2a', '#eac772'];
const SILVER: [string, string, string] = ['#f2f6ff', '#7d8796', '#dfe6f2'];

/** The Eye of Wdjat, centred on (cx, cy), w wide. */
function eye(cx: number, cy: number, w: number, color: string, iris: string): string {
  const s = w / 60;
  const P = (x: number, y: number) => `${f(cx + x * s)} ${f(cy + y * s)}`;
  return (
    `<g fill='none' stroke='${color}' stroke-width='${f(3.2 * s)}' stroke-linecap='round' stroke-linejoin='round'>` +
    `<path d='M${P(-30, -15)} Q${P(0, -30)} ${P(30, -17)}'/>` +
    `<path d='M${P(-30, 0)} Q${P(0, -20)} ${P(30, -1)} Q${P(0, 14)} ${P(-30, 0)} Z'/>` +
    `<path d='M${P(-6, 9)} L${P(-12, 26)}'/>` +
    `<path d='M${P(8, 9)} Q${P(14, 26)} ${P(26, 24)} Q${P(33, 22)} ${P(29, 15)}'/>` +
    `</g><circle cx='${f(cx)}' cy='${f(cy - 3 * s)}' r='${f(7.5 * s)}' fill='${iris}' stroke='${color}' stroke-width='${f(1.6 * s)}'/>` +
    `<circle cx='${f(cx - 2 * s)}' cy='${f(cy - 5 * s)}' r='${f(2 * s)}' fill='#fff' fill-opacity='.7'/>`
  );
}

/** The original card back (graphics.css's vortex): kept here too so the picker can draw it the same way. */
const vortex = sleeve(
  `<radialGradient id='bg' cx='50%' cy='50%' r='70%'><stop offset='0' stop-color='#4a2810'/><stop offset='.55' stop-color='#241208'/><stop offset='1' stop-color='#0e0703'/></radialGradient><radialGradient id='s' cx='50%' cy='50%' r='50%'><stop offset='.3' stop-color='#ffb04a' stop-opacity='.9'/><stop offset='1' stop-color='#8a3e10' stop-opacity='.3'/></radialGradient><radialGradient id='c' cx='50%' cy='42%' r='60%'><stop offset='0' stop-color='#fff4c8'/><stop offset='.25' stop-color='#ffc04a'/><stop offset='.6' stop-color='#d0581a'/><stop offset='1' stop-color='#4a1206'/></radialGradient>`,
  BG +
    `<g>${Array.from({ length: 12 }, (_, i) => `<ellipse cx='50' cy='73' rx='40' ry='12' transform='rotate(${i * 15} 50 73)' fill='none' stroke='url(#s)' stroke-width='2'/>`).join('')}</g>` +
    `<ellipse cx='50' cy='73' rx='15' ry='22' fill='url(#c)' stroke='url(#fm)' stroke-width='2.2'/><ellipse cx='50' cy='73' rx='19.5' ry='27' fill='none' stroke='#e8c070' stroke-opacity='.55' stroke-width='.8'/><ellipse cx='46' cy='64' rx='4' ry='6' fill='#fff' fill-opacity='.35'/>`,
  ['#f2d28a', '#9a6a2a', '#e8c070'],
  '#e8c070',
  '#f2d28a',
);

const duelist = sleeve(
  radialBg([[0, '#2b5fb8'], [0.5, '#12306e'], [1, '#060f2a']]) + `<radialGradient id='core' cx='45%' cy='40%' r='60%'><stop offset='0' stop-color='#e8f6ff'/><stop offset='.4' stop-color='#6cc4ff'/><stop offset='1' stop-color='#1a4aa0'/></radialGradient><pattern id='hx' width='10' height='17.32' patternUnits='userSpaceOnUse'><path d='M5 0L10 2.89V8.66L5 11.55L0 8.66V2.89Z' fill='none' stroke='#8fc8ff' stroke-opacity='.12' stroke-width='.5'/></pattern>`,
  BG +
    `<rect width='100' height='146' fill='url(#hx)'/>` +
    `<circle cx='50' cy='73' r='34' fill='none' stroke='#9fd2ff' stroke-opacity='.35' stroke-width='.8'/><circle cx='50' cy='73' r='28' fill='none' stroke='#cfe8ff' stroke-opacity='.6' stroke-width='1.2' stroke-dasharray='2 2.5'/>` +
    `<polygon points='${star(8, 30, 9)}' fill='#0b2258' stroke='#c9e6ff' stroke-width='1'/>` +
    `<polygon points='${star(4, 22, 6)}' fill='#1d4ea8' stroke='#e8f4ff' stroke-width='.8'/>` +
    `<circle cx='50' cy='73' r='8' fill='url(#core)' stroke='#e8f4ff' stroke-width='1'/>`,
  SILVER,
  '#cfe2ff',
);

const crimson = sleeve(
  radialBg([[0, '#9c1a1e'], [0.6, '#4e0a10'], [1, '#1c0306']]) + `<pattern id='pin' width='6' height='6' patternUnits='userSpaceOnUse' patternTransform='rotate(45)'><rect width='1' height='6' fill='#ff8a80' fill-opacity='.08'/></pattern><linearGradient id='gem' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#ffb4a8'/><stop offset='.45' stop-color='#d0202a'/><stop offset='1' stop-color='#5a0510'/></linearGradient>`,
  BG +
    `<rect width='100' height='146' fill='url(#pin)'/>` +
    `<polygon points='50,24 86,73 50,122 14,73' fill='#2a0408' stroke='url(#fm)' stroke-width='2'/>` +
    `<polygon points='50,34 78,73 50,112 22,73' fill='none' stroke='#f2d28a' stroke-opacity='.5' stroke-width='.7'/>` +
    `<polygon points='50,46 68,73 50,100 32,73' fill='url(#gem)' stroke='#f6dc96' stroke-width='1.2'/>` +
    `<polygon points='50,46 59,73 50,100 41,73' fill='#fff' fill-opacity='.12'/>` +
    `<path d='M50 14v6M50 126v6M8 73h6M86 73h6' stroke='#f2d28a' stroke-width='1.4'/>`,
  GOLD,
  '#f6dc96',
);

const shadow = sleeve(
  radialBg([[0, '#2a2140'], [0.55, '#110d1c'], [1, '#040308']]) + `<radialGradient id='glow' cx='50%' cy='50%' r='50%'><stop offset='0' stop-color='#c08bff' stop-opacity='.8'/><stop offset='1' stop-color='#6a2cc0' stop-opacity='0'/></radialGradient>`,
  BG +
    around(28, 42)
      .map(([x, y], i) => `<circle cx='${x}' cy='${y}' r='${i % 2 ? 0.6 : 1.1}' fill='#b99cff' fill-opacity='.5'/>`)
      .join('') +
    `<circle cx='50' cy='73' r='34' fill='url(#glow)'/>` +
    `<circle cx='50' cy='73' r='27' fill='none' stroke='#a77bff' stroke-width='1.2'/>` +
    `<polygon points='${star(6, 26, 15)}' fill='#140c24' stroke='#d6bcff' stroke-width='1.2'/>` +
    `<polygon points='${star(6, 11, 5, 50, 73, -60)}' fill='#9a5cff' stroke='#efe2ff' stroke-width='.6'/>`,
  ['#c9b8ff', '#4b3a7a', '#a894e8'],
  '#b9a6ff',
);

const light = sleeve(
  radialBg([[0, '#fffbe6'], [0.35, '#f4dc8a'], [0.75, '#b9862e'], [1, '#5a3a0e']]),
  BG +
    rays(32, 14, 90, '#fff6d0', 1.4, 0.55) +
    `<circle cx='50' cy='73' r='22' fill='#fffdf2' stroke='#c99a3a' stroke-width='1.5'/>` +
    `<circle cx='50' cy='73' r='17' fill='none' stroke='#e2b75a' stroke-width='.8'/>` +
    `<polygon points='${star(8, 15, 6)}' fill='#f6c94e' stroke='#fff' stroke-width='.6'/>` +
    `<circle cx='50' cy='73' r='4.5' fill='#fff'/>`,
  ['#fffbe6', '#c09a50', '#fff2c0'],
  '#7a5410',
  '#fff6d8',
);

const dark = sleeve(
  radialBg([[0, '#3b0d5c'], [0.6, '#170424'], [1, '#05010a']]) + `<radialGradient id='orb' cx='40%' cy='35%' r='70%'><stop offset='0' stop-color='#6b2a9a'/><stop offset='.5' stop-color='#1a0428'/><stop offset='1' stop-color='#000'/></radialGradient>`,
  BG +
    `<g fill='none' stroke='#b36bff' stroke-linecap='round'>` +
    [0, 72, 144, 216, 288].map((a) => `<path d='M50 73 m0 -36 a36 36 0 0 1 31 18' transform='rotate(${a} 50 73)' stroke-width='2.2' stroke-opacity='.55'/>`).join('') +
    [36, 108, 180, 252, 324].map((a) => `<path d='M50 73 m0 -28 a28 28 0 0 1 24 14' transform='rotate(${a} 50 73)' stroke-width='1.2' stroke-opacity='.4'/>`).join('') +
    `</g>` +
    `<circle cx='50' cy='73' r='19' fill='url(#orb)' stroke='#c58cff' stroke-width='1.4'/>` +
    `<path d='M44 62 a13 13 0 1 0 14 20 a10 10 0 1 1 -14 -20z' fill='#d8b0ff' fill-opacity='.85'/>`,
  ['#d6a8ff', '#4a1870', '#b77aff'],
  '#c58cff',
);

const flame = (x: number, y: number, h: number, c: string, o: number) => `<path d='M${x} ${y} q${-h * 0.32} ${-h * 0.45} ${0} ${-h} q${h * 0.12} ${h * 0.42} ${h * 0.2} ${h * 0.46} q${h * 0.1} ${-h * 0.2} ${h * 0.02} ${-h * 0.42} q${h * 0.36} ${h * 0.5} ${-h * 0.22} ${h * 0.96}z' fill='${c}' fill-opacity='${o}'/>`;
const fire = sleeve(
  linearBg([[0, '#2a0502'], [0.55, '#8a1a06'], [1, '#e2530e']]) + `<radialGradient id='hot' cx='50%' cy='55%' r='50%'><stop offset='0' stop-color='#fff2b0'/><stop offset='.35' stop-color='#ffb02a'/><stop offset='1' stop-color='#c2300a' stop-opacity='0'/></radialGradient>`,
  BG +
    [8, 22, 36, 50, 64, 78, 92].map((x, i) => flame(x, 146, 34 + ((i * 7) % 16), '#ff7a1a', 0.45)).join('') +
    [15, 43, 71, 85].map((x, i) => flame(x, 146, 22 + ((i * 5) % 10), '#ffd04a', 0.5)).join('') +
    `<circle cx='50' cy='76' r='30' fill='url(#hot)'/>` +
    flame(50, 98, 50, '#ff8a1a', 0.95) +
    flame(50, 96, 34, '#ffe27a', 0.95) +
    around(10, 48, 50, 60)
      .map(([x, y], i) => `<circle cx='${x}' cy='${y}' r='${i % 3 ? 0.8 : 1.3}' fill='#ffd27a' fill-opacity='.7'/>`)
      .join(''),
  GOLD,
  '#ffc070',
);

const wave = (y: number, amp: number, c: string, o: number, w: number) => `<path d='M-5 ${y} q12.5 ${-amp} 25 0 t25 0 t25 0 t25 0 t25 0' fill='none' stroke='${c}' stroke-opacity='${o}' stroke-width='${w}' stroke-linecap='round'/>`;
const water = sleeve(
  linearBg([[0, '#0a3a6a'], [0.5, '#062a52'], [1, '#021226']]) + `<radialGradient id='drop' cx='42%' cy='38%' r='70%'><stop offset='0' stop-color='#e6fbff'/><stop offset='.4' stop-color='#4ac4f0'/><stop offset='1' stop-color='#0a4a8a'/></radialGradient>`,
  BG +
    Array.from({ length: 12 }, (_, i) => wave(12 + i * 11.5, 5 + (i % 3), i % 2 ? '#5fd0ff' : '#9fe6ff', 0.18 + (i % 3) * 0.06, 1.2)).join('') +
    `<circle cx='50' cy='73' r='26' fill='#03203e' fill-opacity='.85' stroke='#8ce0ff' stroke-width='1.2'/>` +
    `<path d='M50 50 C 40 64 36 70 36 79 a14 14 0 0 0 28 0 C 64 70 60 64 50 50z' fill='url(#drop)' stroke='#e6fbff' stroke-width='1'/>` +
    `<ellipse cx='45' cy='76' rx='3' ry='5' fill='#fff' fill-opacity='.55'/>` +
    [[20, 30, 2], [78, 40, 1.4], [82, 112, 2.2], [18, 118, 1.5], [70, 22, 1]].map(([x, y, r]) => `<circle cx='${x}' cy='${y}' r='${r}' fill='none' stroke='#bff0ff' stroke-opacity='.6' stroke-width='.6'/>`).join(''),
  SILVER,
  '#8ce0ff',
);

const earth = sleeve(
  radialBg([[0, '#6a4a26'], [0.6, '#3a2510'], [1, '#160d04']]) + `<pattern id='st' width='16' height='13.86' patternUnits='userSpaceOnUse'><path d='M4 0h8l4 6.93l-4 6.93h-8l-4 -6.93z' fill='#a07a48' fill-opacity='.1' stroke='#1a0f05' stroke-opacity='.6' stroke-width='.8'/></pattern><linearGradient id='mt' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#f0d8a0'/><stop offset='1' stop-color='#7a5226'/></linearGradient>`,
  BG +
    `<rect width='100' height='146' fill='url(#st)'/>` +
    `<circle cx='50' cy='73' r='28' fill='#24170a' stroke='#c8a060' stroke-width='1.6'/>` +
    `<path d='M28 88 L44 60 L52 72 L60 56 L74 88 Z' fill='url(#mt)' stroke='#f6e2b0' stroke-width='1' stroke-linejoin='round'/>` +
    `<path d='M44 60 L48 67 L41 71 Z M60 56 L64 64 L57 66 Z' fill='#fff' fill-opacity='.4'/>` +
    `<path d='M24 90 h52' stroke='#c8a060' stroke-width='1.4'/>`,
  ['#e8c890', '#6a4a20', '#d4b070'],
  '#c8a060',
);

const wind = sleeve(
  radialBg([[0, '#2a8a6a'], [0.6, '#0e4a3a'], [1, '#032018']]),
  BG +
    `<g fill='none' stroke='#aef0c8' stroke-linecap='round'>` +
    [
      [28, 30, 0.35],
      [76, 44, 0.3],
      [24, 112, 0.3],
      [74, 118, 0.35],
    ]
      .map(([x, y, o]) => `<path d='M${x - 12} ${y} q6 -8 14 -3 q6 5 -1 9 q-5 2 -6 -3' stroke-width='1.3' stroke-opacity='${o}'/>`)
      .join('') +
    `</g>` +
    `<circle cx='50' cy='73' r='26' fill='#06281e' stroke='#9ae8bc' stroke-width='1.2'/>` +
    `<g fill='none' stroke='#d8ffe8' stroke-width='2.2' stroke-linecap='round'>` +
    [0, 120, 240].map((a) => `<path d='M50 73 q0 -18 16 -16 q10 2 6 11' transform='rotate(${a} 50 73)'/>`).join('') +
    `</g>` +
    [30, 150, 270].map((a) => `<path d='M50 50 q6 6 0 13 q-6 -7 0 -13z' transform='rotate(${a} 50 73)' fill='#7ad8a4'/>`).join('') +
    `<circle cx='50' cy='73' r='3.5' fill='#eafff2'/>`,
  ['#d8ffe8', '#3a8a62', '#b4f0cc'],
  '#9ae8bc',
);

const chrome = sleeve(
  linearBg(
    [
      [0, '#3a4250'],
      [0.18, '#c8d0dc'],
      [0.3, '#5a6270'],
      [0.52, '#e8eef6'],
      [0.66, '#4a525e'],
      [0.84, '#b8c0cc'],
      [1, '#2a303a'],
    ],
    1,
    1,
  ) + `<radialGradient id='cy' cx='50%' cy='50%' r='50%'><stop offset='0' stop-color='#e6ffff'/><stop offset='.4' stop-color='#3ae0ff'/><stop offset='1' stop-color='#0a4a6a'/></radialGradient>`,
  BG +
    `<g fill='none' stroke='#0a2a3a' stroke-opacity='.55' stroke-width='1.1'>` +
    `<path d='M12 20h18v14h12M88 20h-14v20h-10M12 126h20v-16h10M88 126h-16v-14h-8M50 12v22M50 134v-22M12 73h14M88 73h-14'/>` +
    `</g>` +
    [[30, 34], [64, 40], [42, 110], [72, 112], [26, 73], [74, 73], [50, 34], [50, 112]].map(([x, y]) => `<circle cx='${x}' cy='${y}' r='1.6' fill='#0a2a3a' fill-opacity='.7'/>`).join('') +
    `<polygon points='${around(6, 24).map((p) => p.join(',')).join(' ')}' fill='#1a2028' stroke='#f2f6ff' stroke-width='1.4'/>` +
    `<polygon points='${around(6, 17).map((p) => p.join(',')).join(' ')}' fill='none' stroke='#3ae0ff' stroke-width='1'/>` +
    `<circle cx='50' cy='73' r='9' fill='url(#cy)'/>`,
  SILVER,
  '#e8eef6',
  '#ffffff',
);

const gold = sleeve(
  linearBg(
    [
      [0, '#5a3a0a'],
      [0.2, '#f6dc8a'],
      [0.36, '#9a6a1e'],
      [0.55, '#fff0b8'],
      [0.72, '#a8761e'],
      [0.88, '#f0cc6a'],
      [1, '#4a2e06'],
    ],
    1,
    1,
  ) + `<radialGradient id='gem' cx='40%' cy='35%' r='70%'><stop offset='0' stop-color='#ffd6e0'/><stop offset='.4' stop-color='#e8203a'/><stop offset='1' stop-color='#5a0410'/></radialGradient>`,
  BG +
    rays(24, 28, 90, '#5a3a0a', 1, 0.28) +
    `<circle cx='50' cy='73' r='27' fill='none' stroke='#5a3a0a' stroke-opacity='.6' stroke-width='1.4'/>` +
    `<circle cx='50' cy='73' r='23' fill='#c89a3a' stroke='#fff2c0' stroke-width='1.2'/>` +
    `<polygon points='${star(12, 21, 16)}' fill='#e8bc5a' stroke='#7a5216' stroke-width='.6'/>` +
    `<polygon points='50,61 59,73 50,85 41,73' fill='url(#gem)' stroke='#fff2c0' stroke-width='1'/>` +
    `<path d='M50 61 L54 73 L50 85' fill='#fff' fill-opacity='.18'/>`,
  ['#fff2c0', '#8a5a14', '#f6dc8a'],
  '#5a3a0a',
  '#fff6d0',
);

const wdjat = sleeve(
  linearBg([[0, '#0c2a6a'], [0.5, '#081c4a'], [1, '#030a20']]) + `<linearGradient id='sand' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#f8e2a0'/><stop offset='1' stop-color='#a8762a'/></linearGradient>`,
  BG +
    around(20, 44)
      .map(([x, y]) => `<circle cx='${x}' cy='${y}' r='.8' fill='#f6dc96' fill-opacity='.55'/>`)
      .join('') +
    `<polygon points='12,38 88,38 50,116' fill='url(#sand)' stroke='#fff2c0' stroke-width='1.2' stroke-linejoin='round'/>` +
    `<path d='M12 38 L50 62 L88 38 M50 62 V116' stroke='#7a5216' stroke-opacity='.35' stroke-width='.8' fill='none'/>` +
    [50, 70, 90].map((y) => `<path d='M${f(12 + (y - 38) * 0.487)} ${y} H${f(88 - (y - 38) * 0.487)}' stroke='#7a5216' stroke-opacity='.25' stroke-width='.6'/>`).join('') +
    `<path d='M50 22 v10 M44 26 h12' stroke='#f6dc96' stroke-width='1.4'/>` +
    eye(50, 58, 40, '#0a1a4a', '#0a1a4a') +
    `<path d='M30 124 h40 M38 129 h24' stroke='#f6dc96' stroke-opacity='.6' stroke-width='1'/>`,
  GOLD,
  '#f6dc96',
);

const shadowRealm = sleeve(
  radialBg([[0, '#4a1a6a'], [0.45, '#1a0628'], [1, '#000']], '50%', '55%') + `<radialGradient id='fog' cx='50%' cy='50%' r='50%'><stop offset='0' stop-color='#8a3ad0' stop-opacity='.7'/><stop offset='1' stop-color='#2a0640' stop-opacity='0'/></radialGradient><radialGradient id='iris' cx='50%' cy='50%' r='50%'><stop offset='0' stop-color='#ffe8ff'/><stop offset='.35' stop-color='#ff4ad8'/><stop offset='1' stop-color='#4a0a5a'/></radialGradient>`,
  BG +
    [
      [26, 30, 22],
      [76, 50, 18],
      [30, 110, 20],
      [72, 118, 24],
    ]
      .map(([x, y, r]) => `<circle cx='${x}' cy='${y}' r='${r}' fill='url(#fog)'/>`)
      .join('') +
    `<g fill='none' stroke='#c070ff' stroke-linecap='round'>` +
    Array.from({ length: 6 }, (_, i) => `<path d='M50 73 m-${30 - i * 4} 0 a${30 - i * 4} ${30 - i * 4} 0 1 1 ${f((30 - i * 4) * 1.6)} ${f((30 - i * 4) * 0.6)}' transform='rotate(${i * 60} 50 73)' stroke-width='${1.6 - i * 0.15}' stroke-opacity='${0.6 - i * 0.06}'/>`).join('') +
    `</g>` +
    `<ellipse cx='50' cy='73' rx='17' ry='9' fill='#0a0010' stroke='#e6a8ff' stroke-width='1.2'/>` +
    `<circle cx='50' cy='73' r='7' fill='url(#iris)'/><ellipse cx='50' cy='73' rx='1.6' ry='5' fill='#0a0010'/>`,
  ['#e6c8ff', '#4a1a6a', '#c098e8'],
  '#c070ff',
);

const glyphs = (y: number) => {
  const out: string[] = [];
  const shapes = [
    (x: number) => `<circle cx='${x}' cy='${y}' r='2'/>`,
    (x: number) => `<path d='M${x - 2} ${y + 2.5} L${x} ${y - 2.5} L${x + 2} ${y + 2.5}'/>`,
    (x: number) => `<path d='M${x - 2.4} ${y} h4.8 M${x} ${y - 2.6} v5.2'/>`,
    (x: number) => `<path d='M${x - 2.2} ${y - 2} q2.2 4 4.4 0 M${x - 2.2} ${y + 2} h4.4'/>`,
    (x: number) => `<path d='M${x} ${y - 2.6} q-2.5 1.3 0 2.6 v2.6 M${x - 2} ${y + 0.6} h4'/>`,
    (x: number) => `<rect x='${x - 1.8}' y='${y - 2.2}' width='3.6' height='4.4'/>`,
  ];
  for (let i = 0; i < 9; i++) out.push(shapes[(i * 5 + y) % shapes.length](14 + i * 9));
  return out.join('');
};
const pharaoh = sleeve(
  linearBg([[0, '#141008'], [0.5, '#0a0804'], [1, '#1a1206']]) + `<linearGradient id='au' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#fff0b0'/><stop offset='.5' stop-color='#c8962e'/><stop offset='1' stop-color='#fff0b0'/></linearGradient>`,
  BG +
    `<g fill='none' stroke='#d4a440' stroke-opacity='.45' stroke-width='.8' stroke-linecap='round'>` +
    [16, 26, 36, 110, 120, 130].map(glyphs).join('') +
    `</g>` +
    `<path d='M14 42h72M14 104h72' stroke='#d4a440' stroke-opacity='.6' stroke-width='.8'/>` +
    `<rect x='30' y='46' width='40' height='54' rx='20' fill='#16110a' stroke='url(#au)' stroke-width='2'/>` +
    `<path d='M30 104 h40' stroke='url(#au)' stroke-width='2.4'/>` +
    `<g fill='none' stroke='url(#au)' stroke-width='2.6' stroke-linecap='round'><ellipse cx='50' cy='60' rx='6' ry='7.5'/><path d='M50 67.5 V92 M40 72 H60'/></g>`,
  ['#fff0b0', '#8a6418', '#e8c060'],
  '#d4a440',
  '#fff0b0',
);

const holo = sleeve(
  linearBg(
    [
      [0, '#ff6ad5'],
      [0.18, '#c774e8'],
      [0.34, '#94d0ff'],
      [0.5, '#8cffd8'],
      [0.66, '#fff59a'],
      [0.82, '#ffb37a'],
      [1, '#ff6ad5'],
    ],
    1,
    1,
  ) + `<pattern id='dg' width='10' height='10' patternUnits='userSpaceOnUse' patternTransform='rotate(45)'><rect width='10' height='10' fill='none' stroke='#fff' stroke-opacity='.35' stroke-width='.6'/></pattern><radialGradient id='dim' cx='50%' cy='50%' r='60%'><stop offset='0' stop-color='#1a1030' stop-opacity='.15'/><stop offset='1' stop-color='#1a1030' stop-opacity='.55'/></radialGradient>`,
  BG +
    `<rect width='100' height='146' fill='url(#dim)'/><rect width='100' height='146' fill='url(#dg)'/>` +
    `<polygon points='${star(4, 34, 10)}' fill='#fff' fill-opacity='.25' stroke='#fff' stroke-width='1.2'/>` +
    `<polygon points='${star(4, 22, 7, 50, 73, -45)}' fill='#fff' fill-opacity='.35' stroke='#fff' stroke-width='.8'/>` +
    `<circle cx='50' cy='73' r='7' fill='#fff' fill-opacity='.9'/>`,
  ['#ffffff', '#b0a8d8', '#ffffff'],
  '#ffffff',
);

const soul = sleeve(
  radialBg([[0, '#ff7a3a'], [0.35, '#a01830'], [0.75, '#3a0614'], [1, '#12020a']]) + `<radialGradient id='core' cx='50%' cy='45%' r='60%'><stop offset='0' stop-color='#fff8e0'/><stop offset='.4' stop-color='#ffd04a'/><stop offset='1' stop-color='#e2400e'/></radialGradient>`,
  BG +
    rays(16, 26, 80, '#ffd27a', 2, 0.35) +
    rays(16, 30, 60, '#fff2c0', 0.8, 0.35, 50, 73) +
    `<path d='M50 96 C 22 78 26 54 40 54 C 46 54 50 60 50 63 C 50 60 54 54 60 54 C 74 54 78 78 50 96z' fill='url(#core)' stroke='#fff2c0' stroke-width='1.4'/>` +
    `<polygon points='${star(5, 9, 4, 50, 72)}' fill='#fff' fill-opacity='.9'/>`,
  GOLD,
  '#ffd27a',
);

const academy = sleeve(
  linearBg([[0, '#183a8a'], [0.6, '#0c2058'], [1, '#050c2a']]) + `<linearGradient id='sh' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#ffe27a'/><stop offset='1' stop-color='#c8862a'/></linearGradient>`,
  BG +
    `<path d='M0 20 L100 0 V12 L0 32Z M0 126 L100 114 V126 L0 138Z' fill='#ffd04a' fill-opacity='.12'/>` +
    `<path d='M50 38 L76 46 V72 C76 92 62 104 50 110 C38 104 24 92 24 72 V46 Z' fill='#0c1a4a' stroke='url(#sh)' stroke-width='2.2' stroke-linejoin='round'/>` +
    `<path d='M50 46 L69 52 V72 C69 87 59 96 50 101 C41 96 31 87 31 72 V52 Z' fill='none' stroke='#ffe27a' stroke-opacity='.45' stroke-width='.7'/>` +
    `<polygon points='${star(5, 14, 6, 50, 74)}' fill='url(#sh)' stroke='#fff6d0' stroke-width='.7'/>` +
    `<path d='M30 118 h40' stroke='#ffe27a' stroke-width='1.2' stroke-opacity='.7'/>`,
  ['#fff6d0', '#a8781e', '#ffe27a'],
  '#ffe27a',
);

const starlight = sleeve(
  radialBg([[0, '#1a2a6a'], [0.6, '#0a1236'], [1, '#02040e']], '50%', '40%') + `<radialGradient id='neb' cx='50%' cy='50%' r='50%'><stop offset='0' stop-color='#6a8aff' stop-opacity='.45'/><stop offset='1' stop-color='#2a1a6a' stop-opacity='0'/></radialGradient>`,
  BG +
    `<ellipse cx='54' cy='68' rx='40' ry='26' transform='rotate(-30 54 68)' fill='url(#neb)'/>` +
    Array.from({ length: 46 }, (_, i) => {
      const x = (i * 37.7) % 92 + 4;
      const y = (i * 61.3) % 138 + 4;
      return `<circle cx='${f(x)}' cy='${f(y)}' r='${i % 7 === 0 ? 1.1 : i % 3 === 0 ? 0.7 : 0.4}' fill='#fff' fill-opacity='${i % 7 === 0 ? 0.95 : 0.6}'/>`;
    }).join('') +
    `<g stroke='#bcd0ff' stroke-opacity='.55' stroke-width='.6' fill='none'><path d='M22 104 L34 86 L48 80 L56 64 L70 58 L78 40 M56 64 L66 76 L80 80'/></g>` +
    [[22, 104], [34, 86], [48, 80], [56, 64], [70, 58], [78, 40], [66, 76], [80, 80]].map(([x, y]) => `<polygon points='${star(4, 2.6, 0.7, x, y)}' fill='#fff'/>`).join(''),
  SILVER,
  '#bcd0ff',
);

/** The SVG source of each sleeve's picture. */
export const SLEEVE_SVG = {
  vortex,
  duelist,
  crimson,
  shadow,
  light,
  dark,
  fire,
  water,
  earth,
  wind,
  chrome,
  gold,
  wdjat,
  shadowrealm: shadowRealm,
  pharaoh,
  holo,
  soul,
  academy,
  starlight,
} as const;

export type SleeveId = keyof typeof SLEEVE_SVG;

const urls = new Map<string, string>();
/** The CSS url() of a sleeve's picture (made once). */
export function sleeveUrl(id: SleeveId): string {
  let u = urls.get(id);
  if (!u) {
    u = `url("data:image/svg+xml,${encodeURIComponent(SLEEVE_SVG[id])}")`;
    urls.set(id, u);
  }
  return u;
}
