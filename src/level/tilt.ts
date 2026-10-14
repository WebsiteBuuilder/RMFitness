// Finish lighting that follows you: tilting the phone (or moving a finger or mouse over
// the screen) slides the specular highlight across every Glossy, Royal and Overframe card
// and shifts Overframe's rising art a little (parallax). Two CSS variables on <html>,
// --lvr-tx and --lvr-ty (-1..1), written at most once a frame and only when they change;
// the cards read them in `translate`, so nothing is laid out or repainted.
let started = false;

export function startFinishLight() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const root = document.documentElement;
  let tx = 0;
  let ty = 0;
  let queued = false;
  const set = (x: number, y: number) => {
    tx = Math.max(-1, Math.min(1, x));
    ty = Math.max(-1, Math.min(1, y));
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      root.style.setProperty('--lvr-tx', tx.toFixed(2));
      root.style.setProperty('--lvr-ty', ty.toFixed(2));
    });
  };
  let tiltAt = 0;
  window.addEventListener(
    'deviceorientation',
    (e) => {
      if (e.gamma === null || e.beta === null) return;
      tiltAt = performance.now();
      // held upright-ish: beta ~ 45°; ±25° of tilt sweeps the light edge to edge
      set(e.gamma / 25, (e.beta - 45) / 25);
    },
    { passive: true },
  );
  window.addEventListener(
    'pointermove',
    (e) => {
      if (performance.now() - tiltAt < 1000) return; // the phone's tilt wins while it is reporting
      set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
    },
    { passive: true },
  );
}
