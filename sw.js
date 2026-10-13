/* ============================================================
   Quran Recitation Coach — Service Worker
   ------------------------------------------------------------
   Caching strategy per request type:

     • Navigations (index.html)
         Network-first with a short timeout, falling back to the
         cached shell when the network is slow or offline. The
         fresh copy, when it arrives, updates the shell cache.

     • Google Fonts (fonts.googleapis.com / fonts.gstatic.com)
         Cache-first. Fonts are immutable — once fetched they are
         reused forever.

     • Quran API (api.alquran.cloud)
         Stale-while-revalidate. Cached JSON is served instantly
         while a fresh copy is fetched in the background.
         Covers /surah, /page, /juz, /ayah, /surah/{n}/{edition}.

     • Ayah audio (everyayah.com)
         Cache-first with a bounded entry cap so the cache cannot
         grow without limit.

     • Everything else (same-origin static, misc cross-origin)
         Stale-while-revalidate for same-origin, plain network
         with cache fallback for cross-origin.

   The worker deliberately ignores:

     • Non-GET requests       — so POST /api/feedback is never touched.
     • /_vercel/insights/*    — analytics must always reach the network.

   Cache invalidation is automatic: bumping VERSION retires every
   cache from the previous version on the next activate event.
   ============================================================ */

const VERSION        = 'v1';
const SHELL_CACHE    = `recite-shell-${VERSION}`;
const FONTS_CACHE    = `recite-fonts-${VERSION}`;
const API_CACHE      = `recite-api-${VERSION}`;
const AUDIO_CACHE    = `recite-audio-${VERSION}`;
const RUNTIME_CACHE  = `recite-runtime-${VERSION}`;

const CURRENT_CACHES = new Set([
  SHELL_CACHE,
  FONTS_CACHE,
  API_CACHE,
  AUDIO_CACHE,
  RUNTIME_CACHE
]);

/* The offline bootstrap. Both entries resolve to the same HTML. */
const SHELL_URLS = ['./', './index.html'];

/* Safety caps so a heavy reader cannot exhaust the origin quota. */
const AUDIO_MAX_ENTRIES   = 200;
const RUNTIME_MAX_ENTRIES = 120;

/* How long to wait for the network before falling back to the
   cached shell. Long enough for a slow 3G round-trip, short
   enough that an offline user is not left staring at a blank
   screen. */
const SHELL_NETWORK_TIMEOUT_MS = 3000;

/* ============================================================
   INSTALL — precache the app shell.
   Per-URL failures are swallowed so a bad network at install
   time still lets the worker activate and serve from cache.
   ============================================================ */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(
        SHELL_URLS.map(url =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
        )
      );
    } catch (_) { /* keep going */ }
    await self.skipWaiting();
  })());
});

/* ============================================================
   ACTIVATE — drop old caches, take control immediately.
   ============================================================ */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys.map(k => (CURRENT_CACHES.has(k) ? null : caches.delete(k)))
      );
    } catch (_) { /* keep going */ }

    /* We do not use navigation preload — the app relies on its
       own fetch orchestration and preload adds nothing here. */
    if (self.registration && self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (_) {}
    }

    await self.clients.claim();
  })());
});

/* ============================================================
   HELPERS
   ============================================================ */

/* Drop the oldest N entries when a cache exceeds its cap.
   Cache keys are iterated in insertion order, so the front of
   the list is the oldest. */
async function trimCache(cacheName, maxEntries) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length <= maxEntries) return;
    const drop = keys.length - maxEntries;
    for (let i = 0; i < drop; i++) {
      await cache.delete(keys[i]);
    }
  } catch (_) { /* non-fatal */ }
}

function isNavigationRequest(request) {
  if (request.mode === 'navigate') return true;
  if (request.method !== 'GET') return false;
  const accept = request.headers.get('accept');
  return !!(accept && accept.includes('text/html'));
}

function isGoogleFont(url) {
  return url.hostname === 'fonts.googleapis.com' ||
         url.hostname === 'fonts.gstatic.com';
}

function isQuranApi(url) {
  return url.hostname === 'api.alquran.cloud';
}

function isAyahAudio(url) {
  return url.hostname === 'everyayah.com';
}

function isAnalytics(url) {
  return url.pathname.startsWith('/_vercel/');
}

function isFeedbackEndpoint(url) {
  return url.pathname === '/api/feedback';
}

/* Only cache responses that are safe to replay. */
function isCacheable(response) {
  if (!response) return false;
  if (response.type === 'opaque') return true;   /* cross-origin no-cors */
  if (response.ok) return true;
  return false;
}

/* ============================================================
   STRATEGIES
   ============================================================ */

/* Cache-first with background revalidation. Ideal for stable,
   versionable resources such as API JSON and static assets. */
async function staleWhileRevalidate(request, cacheName, opts) {
  opts = opts || {};
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((response) => {
      if (isCacheable(response)) {
        cache.put(request, response.clone())
          .then(() => {
            if (opts.trim) return trimCache(cacheName, opts.trim);
          })
          .catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) return cached;

  const fresh = await fetchPromise;
  if (fresh) return fresh;
  return Response.error();
}

/* Cache-first without revalidation. Best for immutable assets:
   fonts and ayah audio. The trim cap keeps storage bounded. */
async function cacheFirst(request, cacheName, opts) {
  opts = opts || {};
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    if (opts.trim) trimCache(cacheName, opts.trim);
    return cached;
  }

  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      cache.put(request, response.clone())
        .then(() => {
          if (opts.trim) return trimCache(cacheName, opts.trim);
        })
        .catch(() => {});
    }
    return response;
  } catch (_) {
    return Response.error();
  }
}

/* Network-first with a timeout, used for the HTML shell.
   When the network wins, the shell cache is refreshed.
   When the timeout wins, we return the cached shell immediately
   while the network fetch continues in the background. */
async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);

  let timedOut = false;
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, SHELL_NETWORK_TIMEOUT_MS);
  });

  const fetchPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  const winner = await Promise.race([fetchPromise, timeoutPromise]);
  if (winner) return winner;

  /* Timeout fired first — serve from cache if we have one. */
  const cached =
    (await cache.match(request)) ||
    (await cache.match('./index.html')) ||
    (await cache.match('./'));
  if (cached) return cached;

  /* No cached shell yet — wait for the network to finish. */
  const fresh = await fetchPromise;
  if (fresh) return fresh;

  /* Truly nothing to serve. */
  if (timedOut) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
      '<body style="font-family:sans-serif;padding:2rem;text-align:center">' +
      '<h1>You are offline</h1>' +
      '<p>This page has not been saved for offline use yet. ' +
      'Reconnect to the internet and try again.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  return Response.error();
}

/* Plain network with a cache fallback. Used only for the
   "everything else" tail so unexpected requests still degrade
   gracefully when offline. */
async function networkWithCacheFallback(request, cacheName) {
  try {
    return await fetch(request);
  } catch (_) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;
    return Response.error();
  }
}

/* ============================================================
   FETCH ROUTER
   ============================================================ */
self.addEventListener('fetch', (event) => {
  const request = event.request;

  /* Never touch non-GET verbs. POST /api/feedback, PUT, DELETE…
     all bypass the worker entirely. */
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (_) { return; }

  /* Skip schemes the Cache API cannot store. */
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* Analytics must always reach the network untouched. */
  if (isAnalytics(url)) return;

  /* The feedback relay is POST-only, but guard the GET path too. */
  if (isFeedbackEndpoint(url)) return;

  /* 1. HTML navigations — network-first with a cached shell. */
  if (isNavigationRequest(request)) {
    event.respondWith(networkFirstShell(request));
    return;
  }

  /* 2. Google Fonts — immutable, cache-first forever. */
  if (isGoogleFont(url)) {
    event.respondWith(cacheFirst(request, FONTS_CACHE));
    return;
  }

  /* 3. Quran API — stale-while-revalidate for snappy + offline. */
  if (isQuranApi(url)) {
    event.respondWith(staleWhileRevalidate(request, API_CACHE));
    return;
  }

  /* 4. Ayah audio — cache-first with a bounded entry cap. */
  if (isAyahAudio(url)) {
    event.respondWith(
      cacheFirst(request, AUDIO_CACHE, { trim: AUDIO_MAX_ENTRIES })
    );
    return;
  }

  /* 5. Same-origin statics (icons, manifest, sw.js, etc.). */
  if (url.origin === self.location.origin) {
    event.respondWith(
      staleWhileRevalidate(request, RUNTIME_CACHE, {
        trim: RUNTIME_MAX_ENTRIES
      })
    );
    return;
  }

  /* 6. Anything else — network, with a cache fallback. */
  event.respondWith(networkWithCacheFallback(request, RUNTIME_CACHE));
});

/* ============================================================
   MESSAGES
   ============================================================
   The app does not currently post messages to the worker, but
   these commands are useful for manual control and debugging. */
self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'CLEAR_CACHES') {
    event.waitUntil(
      caches.keys().then(keys =>
        Promise.all(keys.map(k => caches.delete(k)))
      )
    );
    return;
  }

  if (data.type === 'CLEAR_CACHE' && typeof data.name === 'string') {
    event.waitUntil(caches.delete(data.name));
    return;
  }
});