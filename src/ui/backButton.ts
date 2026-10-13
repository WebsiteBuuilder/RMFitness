import { useEffect, useRef } from 'preact/hooks';

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
    const pop = () => {
      if (handler.current()) history.pushState({ edsBack: true }, '');
      else history.back();
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
}
