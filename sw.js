/* ============================================================
   SERVICE WORKER — Quran Recitation Coach
   ============================================================
   What this SW does
   -----------------
   • Precaches the app shell (index.html) so the page opens offline.
   • Caches Google Fonts (immutable, cache-first).
   • Caches Quran API GET responses with stale-while-revalidate
     (instant on revisit, refreshed in the background).
   • Caches ayah audio files (cache-first, size-limited).
   • Uses network-first for page navigations so a new deploy
     is picked up on the next reload.

   What this SW deliberately does NOT do
   -------------------------------------
   • It NEVER touches non-GET requests. This is what lets the
     `POST /api/feedback` call reach Vercel untouched. The Cache
     API throws on non-GET requests, so without this guard every
     POST in the app would fail with "Could not send right now".
   • It NEVER touches anything under `/api/*`.
   • It NEVER touches Vercel's own `/_vercel/*` routes.

   IMPORTANT
   ---------
   Bump CACHE_VERSION on every deploy that changes index.html,
   otherwise users keep seeing the previously cached page. The
   activate handler deletes caches whose names are no longer in
   use, so old versions are cleaned up automatically.
   ============================================================ */

const CACHE_VERSION = 'v2';          // ← bump on every deploy

const SHELL_CACHE = 'qc-shell-' + CACHE_VERSION;
const FONT_CACHE  = 'qc-fonts-' + CACHE_VERSION;
const API_CACHE   = 'qc-api-'   + CACHE_VERSION;
const AUDIO_CACHE = 'qc-audio-' + CACHE_VERSION;

const SHELL_FILES = [
  './',
  './index.html'
];

const FONT_HOSTS  = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const API_HOSTS   = ['api.alquran.cloud'];
const AUDIO_HOSTS = ['everyayah.com', 'www.everyayah.com'];

/* Cap on cached audio files. 250 entries ≈ 20–40 MB typical.
   Increase if you want more offline audio; the Cache API has no
   built-in LRU, so we trim the oldest entries ourselves. */
const AUDIO_MAX_ENTRIES = 250;

/* ============================================================
   INSTALL — precache the app shell
   ============================================================ */
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .catch((err) => console.warn('[SW] shell precache failed:', err))
  );
});

/* ============================================================
   ACTIVATE — drop caches from previous versions
   ============================================================ */
self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL_CACHE, FONT_CACHE, API_CACHE, AUDIO_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ============================================================
   HELPERS
   ============================================================ */
function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

async function trimCache(cacheName, maxEntries) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length <= maxEntries) return;
    const toDelete = keys.length - maxEntries;
    for (let i = 0; i < toDelete; i++) {
      await cache.delete(keys[i]);
    }
  } catch (_) { /* non-fatal */ }
}

/* ============================================================
   FETCH HANDLER
   ============================================================ */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  /* ---- GUARD 1 — never touch non-GET / non-HEAD requests ----
     Critical for POST /api/feedback. The Cache API cannot store
     a POST, and caches.match() on a POST throws, which the
     browser surfaces to theet page as a failed fetch. */
  if (workreq.method !== 'GET' && req.method !== 'HEAD') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  /* ---- GUARD 2 — never touch /api/* ------------------------
     Our serverless functions must always hit the network. */
  if (isSameOrigin(url) && url.pathname.startsWith('/api/')) return;

  /* ---- Also skip Vercel's internal analytics route --------- */
  if (isSameOrigin(url) && url.pathname.startsWith('/_vercel/')) return;

  /* ---- Strategy dispatch ---------------------------------- */

  // 1. Google Fonts — immutable, cache-first.
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req, FONT_CACHE));
    return;
  }

  // 2. Quran API — instant from cache, refreshed in background.
  if (API_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req, API_CACHE));
    return;
  }

  // 3. Ayah audio — cache-first, size-limited.
  if (AUDIO_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req, AUDIO_CACHE, AUDIO_MAX_ENTRIES));
    return;
  }

  // 4. Same-origin requests.
  if (isSameOrigin(url)) {
    if (req.mode === 'navigate') {
      event.respondWith(nFirstShell(req));
    } else {
      event.respondWith(cacheFirst(req, SHELL_CACHE));
    }
    return;
  }

  // 5. Any other cross-origin request — let the browser handle it.
});

/* ============================================================
   CACHING PRIMITIVES
   ============================================================ */

/* Cache-first: fast, good for immutable assets (fonts, audio,
   hashed scripts). Falls back to network on a cache miss. */
async function cacheFirst(req, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;

  try {
    const res = await fetch(req);
    // Cache successful basic/cors responses, and opaque ones
    // (used by <audio> fetches that have no CORS headers).
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone())
        .then(() => { if (maxEntries) trimCache(cacheName, maxEntries); })
        .catch(() => {});
    }
    return res;
  } catch (err) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

/* Stale-while-revalidate: return cached immediately if present,
   refresh in the background. If not cached, wait for the network. */
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);

  const networkPromise = fetch(req).then((res) => {
    if (res && res.status === 200) {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  }).catch(() => null);

  if (cached) return cached;

  const res = await networkPromise;
  if (res) return res;
  return new Response('', { status: 504, statusText: 'Offline' });
}

/* Network-first for page navigations, with cached index.html as
   the offline fallback. Keeps the app fresh after every deploy. */
async function networkFirstShell(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.status === 200) {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    const shell = await cache.match('./index.html');
    if (shell) return shell;
    const root = await cache.match('./');
    if (root) return root;
    return new Response('Offline', {
      status: 504,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

/* ============================================================
   MESSAGE CHANNEL — optional page-side controls
   ============================================================ */
self.addEventListener('message', (event) => {
  if (!event.data || !event.data.type) return;
  if (event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', version: CACHE_VERSION });
  }
});