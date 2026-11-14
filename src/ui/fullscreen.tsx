// Full screen on every device: a button on the Speed Duel home bar, plus an item in each menu.
// Android, tablets and computers use the browser's full screen; iPadOS Safari needs the webkit
// name. iPhone Safari can't put a page full screen at all, so there the button explains how to
// add the game to the Home Screen, which opens it full screen (manifest.webmanifest).
import { useEffect, useState } from 'preact/hooks';
import { lockPhonePortrait } from './fit';
import { Menu, Overlay, Win } from './Window';

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => Promise<void> | void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

/** Fired with the reason when full screen can't start here (FullscreenHelp shows it). */
export const FULLSCREEN_HELP_EVT = 'eds-fullscreen-help';

/** Running as the installed app (Home Screen / installed PWA): already full screen, no button needed. */
export function installedApp(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  // (Chrome also reports display-mode fullscreen while our own button has the page full screen)
  return !!nav.standalone || (!isFullscreen() && !!window.matchMedia?.('(display-mode: fullscreen)').matches) || !!window.matchMedia?.('(display-mode: standalone)').matches;
}

export function isFullscreen(): boolean {
  if (typeof document === 'undefined') return false;
  const d = document as FsDoc;
  return !!(d.fullscreenElement || d.webkitFullscreenElement);
}

function canFullscreen(): boolean {
  const d = document as FsDoc;
  return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled);
}

type HelpWhy = 'iphone' | 'unsupported' | 'blocked';

/** An iPhone (or an iPad that reports itself as a Mac): Safari there has no page full screen. */
function iosDevice(): boolean {
  return /iPhone|iPod|iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

function help(reason: HelpWhy, detail?: string) {
  window.dispatchEvent(new CustomEvent(FULLSCREEN_HELP_EVT, { detail: { reason, detail } }));
}

/** Goes full screen, or back. Must run from a tap (browsers refuse it otherwise). */
export async function toggleFullscreen(): Promise<void> {
  const d = document as FsDoc;
  try {
    if (isFullscreen()) {
      await (d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.());
      return;
    }
    // (no full screen here: an iPhone gets the Home Screen steps, an in-app browser a plain note)
    if (!canFullscreen()) return help(iosDevice() ? 'iphone' : 'unsupported');
    const el = document.documentElement as FsEl;
    await (el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.());
    // phones stay upright once full screen (the lock only works there); older iPads answer later,
    // through webkitfullscreenerror, which FullscreenHelp catches
    if (isFullscreen()) lockPhonePortrait();
  } catch (err) {
    console.error('Full screen failed', err);
    help('blocked', err instanceof Error ? err.message : String(err));
  }
}

/** Whether the game is full screen right now, kept up to date (Esc or the system back leave it too). */
export function useFullscreen(): boolean {
  const [on, setOn] = useState(isFullscreen);
  useEffect(() => {
    const fn = () => setOn(isFullscreen());
    document.addEventListener('fullscreenchange', fn);
    document.addEventListener('webkitfullscreenchange', fn);
    return () => {
      document.removeEventListener('fullscreenchange', fn);
      document.removeEventListener('webkitfullscreenchange', fn);
    };
  }, []);
  return on;
}

/** The menu item every menu shares (none in the installed app, which is full screen already). */
export function fullscreenItem(on: boolean): { label: string; note: string; onPick: () => void }[] {
  if (installedApp()) return [];
  return [{ label: `Full screen: ${on ? 'On' : 'Off'}`, note: on ? 'tap to leave full screen' : 'hide the browser bars', onPick: () => void toggleFullscreen() }];
}

/** Mounted once (main.tsx): explains what to do when full screen can't start from the button. */
export function FullscreenHelp() {
  const [why, setWhy] = useState<{ reason: HelpWhy; detail?: string } | null>(null);
  useEffect(() => {
    const fn = (e: Event) => setWhy((e as CustomEvent).detail);
    // (a refusal that comes as an event instead of a rejected promise: older iPadOS)
    const refused = () => (console.error('Full screen refused'), setWhy((w) => w ?? { reason: 'blocked' }));
    window.addEventListener(FULLSCREEN_HELP_EVT, fn);
    document.addEventListener('fullscreenerror', refused);
    document.addEventListener('webkitfullscreenerror', refused);
    return () => {
      window.removeEventListener(FULLSCREEN_HELP_EVT, fn);
      document.removeEventListener('fullscreenerror', refused);
      document.removeEventListener('webkitfullscreenerror', refused);
    };
  }, []);
  if (!why) return null;
  const close = () => setWhy(null);
  return (
    <Overlay onClose={close}>
      <Win title="Full screen" onClose={close}>
        {why.reason === 'iphone' ? (
          <p class="fs-help">
            iPhone browsers can't go full screen. Add the game to your Home Screen instead: tap <b>Share</b> (the square with an arrow; tap <b>•••</b> first if you don't see it), then <b>Add to Home Screen</b> (scroll down the list if it's hidden).
            Open it from the new icon and it fills the whole screen.
          </p>
        ) : why.reason === 'unsupported' ? (
          <p class="fs-help">
            This browser can't go full screen (apps like Discord or Instagram open links in their own small browser). Open the game in <b>Chrome</b> or <b>Safari</b>, then tap the button again.
          </p>
        ) : (
          <p class="fs-help">
            This browser said no to full screen{why.detail ? ` (${why.detail})` : ''}. Tap the button again. On a computer, <b>F11</b> also works; on a phone or tablet, <b>Add to Home screen</b> or <b>Install app</b> in the browser's menu opens the game full screen every time.
          </p>
        )}
        <Menu items={[{ label: 'OK', onPick: close }]} />
      </Win>
    </Overlay>
  );
}
