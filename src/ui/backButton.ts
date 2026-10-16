import { useEffect, useRef } from 'preact/hooks';

// The newest screen's back handler, so a controller's B button can press "back" without
// touching history (src/ui/pad).
let current: { current: () => boolean } | null = null;
// Android may also turn a controller's B into a system back: only one of the two counts.
let lastPop = -1e9;
let lastPad = -1e9;
const SAME_PRESS_MS = 400;

/**
 * Android's back button (and the back swipe) would leave the site from any screen.
 * This keeps one spare history entry so back goes back inside the game instead.
 * `onBack` returns true when it handled the press; false lets the browser leave as usual.
 */
export function useBackButton(onBack: () => boolean) {
  const handler = useRef(onBack);
  handler.current = onBack;
  useEffect(() => {
    history.pushState({ edsBack: true }, '');
    current = handler;
    const pop = () => {
      // (the same press already went through the controller)
      if (performance.now() - lastPad < SAME_PRESS_MS) return void history.pushState({ edsBack: true }, '');
      lastPop = performance.now();
      if (handler.current()) history.pushState({ edsBack: true }, '');
      else history.back();
    };
    window.addEventListener('popstate', pop);
    return () => {
      window.removeEventListener('popstate', pop);
      if (current === handler) current = null;
    };
  }, []);
}

/** A controller's back press: steps back inside the game, never leaves the site. */
export function pressBack(): boolean {
  if (performance.now() - lastPop < SAME_PRESS_MS) return true;
  lastPad = performance.now();
  return current ? current.current() : false;
}
