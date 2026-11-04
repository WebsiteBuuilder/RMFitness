/* Big screens (tablets, laptops, desktops): the sizes the duel's JavaScript needs to agree with
   fitscreen.css, and keeping phones in portrait while tablets and computers turn freely. */

/** A tablet, laptop or desktop window: the same test as fitscreen.css's big-screen media query. */
export function bigScreen(): boolean {
  return typeof window !== 'undefined' && window.innerWidth >= 700 && window.innerHeight >= 600;
}

/** A landscape tablet or computer: the player bars move to the corners (fitscreen.css). */
export function landscapeBig(): boolean {
  return typeof window !== 'undefined' && window.innerWidth >= 900 && window.innerHeight >= 600 && window.innerWidth / window.innerHeight >= 1.25;
}

/** Width of a card in your hand (fitscreen.css / layout.css: --th-w). */
export function handCardW(): number {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (landscapeBig()) return Math.round(Math.min(220, Math.max(114, h * 0.19)) * 0.685);
  if (bigScreen()) return Math.round(Math.min(210, Math.max(114, h * 0.18)) * 0.685);
  return w <= 380 ? 64 : h >= 880 ? 100 : h >= 820 ? 88 : h >= 760 ? 78 : 70;
}

/** The room your hand has to fan out in (a phone column on phones, the whole width on big screens). */
export function handRoom(): number {
  const w = window.innerWidth;
  // (landscape: between the two corner bars, --fit-bar)
  if (landscapeBig()) return w - 2 * (Math.min(430, Math.max(320, w * 0.27)) + 24) - 20;
  return (bigScreen() ? w * 0.9 : Math.min(w, 560)) - 20;
}

/** Phones stay in portrait (the installed app may turn now, for tablets): a lock only takes in
    fullscreen, which is how the installed app runs; a browser tab ignores it. */
export function lockPhonePortrait() {
  if (typeof screen === 'undefined') return;
  const small = Math.min(screen.width, screen.height) < 600;
  const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
  if (small && o?.lock) o.lock('portrait').catch(() => {});
}
