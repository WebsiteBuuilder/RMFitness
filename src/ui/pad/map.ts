// Turns any controller the browser sees into the same named buttons.
// Pure (no DOM): tests/pad.test.ts runs it under Node.

export type Family = 'xbox' | 'ps' | 'nintendo' | 'generic';
export type Btn = 'a' | 'b' | 'x' | 'y' | 'lb' | 'rb' | 'lt' | 'rt' | 'select' | 'start' | 'ls' | 'rs' | 'home' | 'up' | 'down' | 'left' | 'right';

export interface PadLike {
  id: string;
  mapping: string;
  buttons: readonly { pressed: boolean; value: number }[];
  axes: readonly number[];
}

export interface PadRead {
  held: Set<Btn>;
  /** right stick, for scrolling (-1..1) */
  sx: number;
  sy: number;
}

/** Which kind of controller, from the name the browser reports (and its USB vendor id). */
export function familyOf(id: string): Family {
  const s = id.toLowerCase();
  if (/045e|xbox|xinput/.test(s)) return 'xbox';
  if (/054c|playstation|dualshock|dualsense|ps[345]|wireless controller/.test(s)) return 'ps';
  if (/057e|nintendo|pro controller|joy-?con|switch/.test(s)) return 'nintendo';
  if (/microsoft|backbone|kishi|razer|8bitdo/.test(s)) return 'xbox';
  return 'generic';
}

// The standard layout, by position: 0 bottom, 1 right, 2 left, 3 top face button.
const STANDARD: (Btn | null)[] = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'select', 'start', 'ls', 'rs', 'up', 'down', 'left', 'right', 'home'];
// Nintendo prints A on the right and B on the bottom; players confirm with A.
const NINTENDO: (Btn | null)[] = ['b', 'a', 'y', 'x', 'lb', 'rb', 'lt', 'rt', 'select', 'start', 'ls', 'rs', 'up', 'down', 'left', 'right', 'home'];
// Most plain Bluetooth/USB pads that the browser can't map: four face buttons, shoulders,
// triggers, select, start, stick clicks (a d-pad, if it is buttons, after them).
const GENERIC: (Btn | null)[] = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'select', 'start', 'ls', 'rs', 'up', 'down', 'left', 'right', 'home'];

const STICK_ON = 0.55;
const STICK_HOLD = 0.35;

/** A hat switch on one axis (old DirectInput pads): -1 up, then clockwise in 2/7 steps; ~1.28 at rest. */
export function hatDirs(v: number): Btn[] {
  if (!(v >= -1.05 && v <= 1.05)) return [];
  const i = Math.round(((v + 1) * 7) / 2);
  return ([['up'], ['up', 'right'], ['right'], ['down', 'right'], ['down'], ['down', 'left'], ['left'], ['up', 'left']] as Btn[][])[i] ?? [];
}

/** Read one controller. `prev` (what it held last frame) keeps a stick from flickering at the edge. */
export function readPad(p: PadLike, prev?: Set<Btn>): PadRead {
  const held = new Set<Btn>();
  const std = p.mapping === 'standard';
  const fam = familyOf(p.id);
  const table = std ? (fam === 'nintendo' ? NINTENDO : STANDARD) : GENERIC;
  p.buttons.forEach((b, i) => {
    const name = table[i];
    if (!name || !b) return;
    // (triggers are analog: half-way counts)
    if (b.pressed || b.value > 0.5) held.add(name);
  });
  const stick = (v: number, neg: Btn, pos: Btn) => {
    const t = (d: Btn) => (prev?.has(d) ? STICK_HOLD : STICK_ON);
    if (v <= -t(neg)) held.add(neg);
    else if (v >= t(pos)) held.add(pos);
  };
  const ax = p.axes;
  if (ax.length >= 2) {
    stick(ax[0] ?? 0, 'left', 'right');
    stick(ax[1] ?? 0, 'up', 'down');
  }
  let sx = 0;
  let sy = 0;
  if (std && ax.length >= 4) {
    sx = Math.abs(ax[2]) > 0.2 ? ax[2] : 0;
    sy = Math.abs(ax[3]) > 0.2 ? ax[3] : 0;
  }
  if (!std) {
    // a d-pad reported as two axes (6/7 on most Android and Linux pads) or a hat (axis 9)
    if (ax.length >= 8 && p.buttons.length < 16) {
      if (ax[6] <= -0.5) held.add('left');
      else if (ax[6] >= 0.5) held.add('right');
      if (ax[7] <= -0.5) held.add('up');
      else if (ax[7] >= 0.5) held.add('down');
    }
    if (ax.length >= 10) for (const d of hatDirs(ax[9])) held.add(d);
  }
  return { held, sx, sy };
}

/** What each button is called on this kind of controller. */
export function glyph(f: Family, b: Btn): string {
  if (f === 'ps') return ({ a: '✕', b: '○', x: '□', y: '△', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', start: 'OPTIONS', select: 'SHARE' } as Partial<Record<Btn, string>>)[b] ?? b.toUpperCase();
  if (f === 'nintendo') return ({ lb: 'L', rb: 'R', lt: 'ZL', rt: 'ZR', start: '+', select: '−' } as Partial<Record<Btn, string>>)[b] ?? b.toUpperCase();
  return ({ lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', start: '☰', select: '⧉' } as Partial<Record<Btn, string>>)[b] ?? b.toUpperCase();
}

export function familyName(f: Family): string {
  return f === 'xbox' ? 'Xbox-style controller' : f === 'ps' ? 'PlayStation controller' : f === 'nintendo' ? 'Nintendo controller' : 'Controller';
}
