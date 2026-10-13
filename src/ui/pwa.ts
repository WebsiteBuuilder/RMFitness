// The installed app: registers the service worker (production builds only) and rolls out new versions.
import './sheets.css';

const BASE = import.meta.env.BASE_URL ?? '/';
const loadedAt = Date.now();

/** A small bar at the bottom: a new version is ready. Never reloads on its own mid-duel. */
function showUpdateBar(update: () => void) {
  if (document.querySelector('.update-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'update-bar';
  bar.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = 'A new version of the game is ready.';
  const later = document.createElement('button');
  later.textContent = 'Later';
  later.onclick = () => bar.remove();
  const go = document.createElement('button');
  go.className = 'go';
  go.textContent = 'Update';
  go.onclick = () => {
    go.disabled = true;
    go.textContent = 'Updating…';
    update();
  };
  bar.append(text, later, go);
  document.body.append(bar);
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  const start = async () => {
    // With no worker in charge yet this is the first visit: nothing old to replace.
    const hadController = !!sw.controller;
    let reloading = false;
    sw.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    let reg: ServiceWorkerRegistration;
    try {
      reg = await sw.register(`${BASE}sw.js`, { scope: BASE });
    } catch {
      return;
    }
    const offer = (w: ServiceWorker) => {
      // Just opened (title screen): switch straight away. Later on, maybe mid-duel: ask first.
      if (Date.now() - loadedAt < 10_000) w.postMessage('skip-waiting');
      else showUpdateBar(() => w.postMessage('skip-waiting'));
    };
    if (reg.waiting && hadController) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && sw.controller) offer(w);
      });
    });
    // Coming back to the app checks for a newer version.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => undefined);
    });
  };
  if (document.readyState === 'complete') void start();
  else window.addEventListener('load', () => void start(), { once: true });
}
