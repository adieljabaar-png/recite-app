/* ============================================================
   Quran Recitation Coach — Service Worker
   ============================================================
   Bump VERSION whenever this file changes to force a fresh cache.
   The old caches are automatically cleaned up on activation.

   Strategy summary
   ----------------
   • App shell (HTML / icons)            → network-first, cache fallback
   • Quran API  (api.alquran.cloud)      → stale-while-revalidate
   • Ayah audio (everyayah.com)          → cache-first (bounded LRU)
   • Google Fonts (googleapis/gstatic)   → cache-first
   • Same-origin static assets           → network-first, cache fallback
   • Everything else                     → pass through
   ============================================================ */

const VERSION = 'v3';

const SHELL_CACHE = 'qc-shell-'  + VERSION;
const API_CACHE   = 'qc-api-'    + VERSION;
const AUDIO_CACHE = 'qc-audio-'  + VERSION;
const FONT_CACHE  = 'qc-fonts-'  + VERSION;

/* Soft caps — the LRU trimmer runs after every successful write. */
const MAX_API_ENTRIES   = 300;   /* ≈ 15 MB of JSON at most  */
const MAX_AUDIO_ENTRIES = 200;   /* ≈ 25 MB of mp3  at most  */
const MAX_FONT_ENTRIES  =  40;

/* Files to precache on install. `./` and `./index.html` both map to
   the single-page app on every major host (Vercel, Netlify, static). */
const SHELL_ASSETS = [
  './',
  './index.html'
];

/* External hosts we look after. */
const QURAN_API_HOSTS = ['api.alquran.cloud'];
const AUDIO_HOSTS     = ['everyayah.com', 'audio.everyayah.com', 'www.everyayah.com'];
const FONT_HOSTS      = ['fonts.googleapis.com', 'fonts.gstatic.com'];

/* ------------------------------------------------------------
   install — precache the app shell and take over immediately.
   ------------------------------------------------------------ */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.allSettled(
      SHELL_ASSETS.map(url =>
        cache.add(new Request(url, { cache: 'reload' }))
      )
    );
    await self.skipWaiting();
  })());
});

/* ------------------------------------------------------------
   activate — drop old qc-* caches and claim open clients.
   ------------------------------------------------------------ */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, API_CACHE, AUDIO_CACHE, FONT_CACHE]);
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => n.startsWith('qc-') && !keep.has(n))
        .map(n => caches.delete(n))
    );
    /* Navigation preload is not needed — our shell strategy already
       does network-first. Disable it so we do not double-fetch. */
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (_) {}
    }
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------
   Helpers
   ------------------------------------------------------------ */

/** Drop the oldest N entries from a cache when it grows past the cap.
    Cache-keys() returns entries in insertion order, so this is a
    simple FIFO eviction. */
async function trimCache(cacheName, maxEntries) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length <= maxEntries) return;
    const drop = keys.length - maxEntries;
    for (let i = 0; i < drop; i++) {
      try { await cache.delete(keys[i]); } catch (_) {}
    }
  } catch (_) {}
}

/** Store a response only if it is a full 200 and a basic/cors type.
    Anything else (opaque, redirect, error) is skipped. */
function isCacheableResponse(res) {
  if (!res) return false;
  if (res.status !== 200) return false;
  if (res.type !== 'basic' && res.type !== 'cors') return false;
  return true;
}

/* ------------------------------------------------------------
   Strategies
   ------------------------------------------------------------ */

/** Network-first with cache fallback.
    For navigation requests, falls back to the cached shell so the
    app still boots offline. */
async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(request);
    if (isCacheableResponse(fresh)) {
      cache.put(request, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (_) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell =
        (await cache.match('./index.html')) ||
        (await cache.match('./'));
      if (shell) return shell;
    }
    return new Response(
      'Offline — this page is not cached yet. Connect to the internet and try again.',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }
}

/** Stale-while-revalidate. Serves cached JSON immediately (so pages
    open instantly offline), then quietly refreshes it in the
    background for the next visit. */
async function staleWhileRevalidate(cacheName, request, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then((res) => {
      if (isCacheableResponse(res)) {
        cache.put(request, res.clone()).catch(() => {});
        trimCache(cacheName, maxEntries);
      }
      return res;
    })
    .catch(() => null);

  if (cached) {
    /* Refresh in the background; do not await. */
    networkPromise.catch(() => {});
    return cached;
  }

  const fresh = await networkPromise;
  if (fresh) return fresh;

  return new Response(
    JSON.stringify({ code: 503, status: 'OFFLINE', data: null }),
    { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
  );
}

/** Cache-first. Returns the cached copy if present; otherwise fetches,
    stores, and returns. Falls back to a 504 when truly offline and
    nothing is cached. */
async function cacheFirst(cacheName, request, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const fresh = await fetch(request);
    if (isCacheableResponse(fresh)) {
      cache.put(request, fresh.clone()).catch(() => {});
      trimCache(cacheName, maxEntries);
    }
    return fresh;
  } catch (_) {
    return new Response('', { status: 504 });
  }
}

/* ------------------------------------------------------------
   Fetch router
   ------------------------------------------------------------ */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  /* Only GET is handled. POSTs to /api/feedback are untouched. */
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  /* Ignore non-http(s) schemes (chrome-extension, blob, data, …) */
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* 1) Navigation → network-first shell */
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstShell(req));
    return;
  }

  const sameOrigin = url.origin === self.location.origin;

  /* 2) Quran API JSON → stale-while-revalidate */
  if (QURAN_API_HOSTS.includes(url.hostname)) {
    event.respondWith(
      staleWhileRevalidate(API_CACHE, req, MAX_API_ENTRIES)
    );
    return;
  }

  /* 3) Ayah audio → cache-first with LRU cap */
  if (
    AUDIO_HOSTS.includes(url.hostname) ||
    AUDIO_HOSTS.some(h => url.hostname.endsWith('.' + h))
  ) {
    event.respondWith(
      cacheFirst(AUDIO_CACHE, req, MAX_AUDIO_ENTRIES)
    );
    return;
  }

  /* 4) Google Fonts (CSS + woff2 files) → cache-first */
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(
      cacheFirst(FONT_CACHE, req, MAX_FONT_ENTRIES)
    );
    return;
  }

  /* 5) Same-origin static assets (icons, analytics script, …) →
        network-first with cache fallback so redeploys take effect
        on the next visit but the app still works offline. */
  if (sameOrigin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const fresh = await fetch(req);
        if (isCacheableResponse(fresh)) {
          cache.put(req, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (_) {
        const cached = await cache.match(req);
        if (cached) return cached;
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  /* 6) Everything else (analytics, telemetry, third-party APIs) →
        let the browser handle it directly. */
});

/* ------------------------------------------------------------
   Message channel — optional cache controls
   ------------------------------------------------------------
   page → worker:
     postMessage({ type: 'SKIP_WAITING' })
     postMessage({ type: 'CLEAR_API_CACHE' })
     postMessage({ type: 'CLEAR_AUDIO_CACHE' })
     postMessage({ type: 'CLEAR_ALL' })
   ------------------------------------------------------------ */
self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'CLEAR_API_CACHE') {
    event.waitUntil(caches.delete(API_CACHE));
    return;
  }
  if (data.type === 'CLEAR_AUDIO_CACHE') {
    event.waitUntil(caches.delete(AUDIO_CACHE));
    return;
  }
  if (data.type === 'CLEAR_ALL') {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter(n => n.startsWith('qc-')).map(n => caches.delete(n))
      );
    })());
  }
});