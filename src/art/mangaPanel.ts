// The manga attack panel's DOM (rules in mangaRules.ts, look in manga.css): an inked panel of
// the attacker with screentone and focus lines, a slammed-in sound word, and a small inset of
// what it hit. Built ahead of the impact (its art copied while the blow travels), shown when the
// blow lands, gone on its own after the hold or at once on a tap. Transforms and opacity only.
import './manga.css';

export interface MangaPanelOpts {
  /** the attacker's cropped art (square), or null when it has none */
  art: HTMLCanvasElement | null;
  /** the defender's art, when the blow destroys a face-up monster */
  inset: HTMLCanvasElement | null;
  /** the damage ('-2400') or 'DESTROYED' */
  insetText: string | null;
  word: string;
  kana: string;
  /** [fill, glow] of the word (by Attribute) */
  ink: [string, string];
  /** the attacker's side: the panel leans its way */
  side: 'near' | 'far';
  mega: boolean;
  direct: boolean;
}

export interface MangaHandle {
  /** shows it for `dur` real seconds; `onGone` runs once as it goes (on its own, on a tap or dropped) */
  show(dur: number, onGone?: () => void): boolean;
  /** a tap: it whips away now */
  end(): void;
  /** gone at once (skipped before or while it showed) */
  drop(): void;
  readonly showing: boolean;
}

/** The art at most this wide in the panel's copy (a small canvas: cheap to composite). */
const ART_PX = 320;

function copy(src: HTMLCanvasElement | null, px: number): HTMLCanvasElement | null {
  if (!src || !src.width || !src.height) return null;
  const c = document.createElement('canvas');
  const k = Math.min(1, px / Math.max(src.width, src.height));
  c.width = Math.max(1, Math.round(src.width * k));
  c.height = Math.max(1, Math.round(src.height * k));
  try {
    c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
  } catch {
    return null;
  }
  return c;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

export function prepManga(layer: HTMLElement, o: MangaPanelOpts): MangaHandle {
  const el = document.createElement('div');
  el.className = `art-manga side-${o.side}${o.mega ? ' mega' : ''}${o.direct ? ' direct' : ''}`;
  el.style.setProperty('--ink', o.ink[0]);
  el.style.setProperty('--glow', o.ink[1]);
  // (a long word sets smaller so it never runs off a narrow phone)
  el.style.setProperty('--wl', String(Math.max(0.55, Math.min(1, 8.4 / Math.max(5, o.word.length)))));
  el.innerHTML =
    '<i class="mg-veil"></i><div class="mg-frame">' +
    '<div class="mg-panel mg-main"><div class="mg-art"></div><i class="mg-tone"></i><i class="mg-lines"></i></div>' +
    (o.inset || o.insetText ? `<div class="mg-panel mg-inset${o.inset ? '' : ' text-only'}"><div class="mg-art"></div><i class="mg-crack"></i>${o.insetText ? `<b class="mg-burst"><span>${esc(o.insetText)}</span></b>` : ''}</div>` : '') +
    `<b class="mg-word">${esc(o.word)}</b><span class="mg-kana">${esc(o.kana)}</span>` +
    '</div><i class="mg-flash"></i>';
  const main = copy(o.art, ART_PX);
  if (main) el.querySelector('.mg-main .mg-art')!.appendChild(main);
  else el.classList.add('no-art');
  const ins = copy(o.inset, 200);
  if (ins) el.querySelector('.mg-inset .mg-art')?.appendChild(ins);
  layer.appendChild(el);
  let state: 'prep' | 'on' | 'gone' = 'prep';
  let timer = 0;
  let gone: (() => void) | undefined;
  const leave = () => {
    const f = gone;
    gone = undefined;
    f?.();
  };
  const done = () => {
    leave();
    if (state === 'gone') return;
    state = 'gone';
    clearTimeout(timer);
    el.remove();
    document.body.classList.remove('art-manga-on');
  };
  return {
    get showing() {
      return state === 'on' && !el.classList.contains('out');
    },
    show(dur: number, onGone?: () => void) {
      // (cleared off the layer meanwhile: nothing to show, nothing to hold for)
      if (state !== 'prep' || !el.isConnected) return (done(), false);
      state = 'on';
      gone = onGone;
      el.style.setProperty('--d', `${dur}s`);
      el.classList.add('on');
      document.body.classList.add('art-manga-on');
      // (dev builds: a UI test can hold the panel to shoot it)
      if (!(import.meta.env.DEV && (window as { __mangaHold?: boolean }).__mangaHold)) timer = window.setTimeout(done, dur * 1000 + 40);
      return true;
    },
    end() {
      if (state !== 'on') return done();
      leave();
      clearTimeout(timer);
      el.classList.add('out');
      timer = window.setTimeout(done, 170);
    },
    drop: done,
  };
}
