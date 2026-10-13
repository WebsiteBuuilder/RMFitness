/* Service worker for the installed app. Built by the `pwa` plugin in vite.config.ts,
 * which fills in the build id and the list of app files.
 *
 * - App shell (the page, scripts, styles, icons): saved per build, so the app opens with
 *   no signal; old builds' copies are deleted when a new build takes over.
 * - Card pictures and 3D figure maps (cards/img, cards/fig): saved the first time each one
 *   is shown and never downloaded again, so a duel doesn't eat mobile data. They are named
 *   by card id and never change, so this cache is kept from build to build.
 * - Card data (*.json): always asked from the network first (the app adds ?v=<build id>);
 *   the saved copy is only used when there is no connection at all.
 */
const BUILD = '__BUILD_ID__';
const SHELL = '__SHELL__'; // replaced by a JSON array of app files, relative to the scope
const SHELL_CACHE = `eds-shell-${BUILD}`;
const DATA_CACHE = `eds-data-${BUILD}`;
const IMG_CACHE = 'eds-cards-img-v1';
const FONT_CACHE = 'eds-fonts-v1';
const KEEP = [SHELL_CACHE, DATA_CACHE, IMG_CACHE, FONT_CACHE];

const scope = new URL(self.registration.scope);
const local = (path) => new URL(path, scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(JSON.parse(SHELL).map(local)))
      .catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('eds-') && !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The page asks for the new version to take over (see src/ui/pwa.ts).
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone()).catch(() => undefined);
  return res;
}

async function networkFirst(req, name, fallback) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(fallback ?? req, res.clone()).catch(() => undefined);
    return res;
  } catch (err) {
    const hit = await cache.match(fallback ?? req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Fonts (Google Fonts): they never change for a given URL.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req, FONT_CACHE));
    return;
  }
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const path = url.pathname.slice(scope.pathname.length);

  // Opening the app: the newest page when online, the saved one offline.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, SHELL_CACHE, local('./')));
    return;
  }
  // Card data: network first, every time. Its own cache, per build, keyed with the ?v= query.
  if (path.endsWith('.json')) {
    event.respondWith(networkFirst(req, DATA_CACHE));
    return;
  }
  // Card pictures and figure maps: once downloaded, kept.
  if (/^cards\/(img|fig)\/.+\.(webp|png|jpe?g)$/.test(path)) {
    event.respondWith(cacheFirst(req, IMG_CACHE));
    return;
  }
  // Build files have the content hash in their names; icons and the manifest are tiny.
  if (path.startsWith('assets/') || path.startsWith('icons/') || path === 'manifest.webmanifest' || path === 'favicon.ico') {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
  }
});
