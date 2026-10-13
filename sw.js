/* ============================================================
   Quran Recitation Coach — Service Worker
   ============================================================
   Responsibilities:
     • Cache the app shell (the HTML page + manifest + icons)
       so the PWA launches offline.
     • Runtime-cache Quran text / translation responses from
       api.alquran.cloud so previously read surahs & pages
       stay available offline.
     • Cache Google Fonts.
     • Cache audio responses from everyayah.com — but ONLY full
       200 responses, and always let the request fall through to
       the network first.  iOS Safari issues HTTP Range requests
       for <audio> and mis-handles Service-Worker-supplied 206
       responses; we deliberately do NOT synthesise ranges here.
     • Never cache POST requests (feedback submissions).

   Cache version is bumped whenever the shell changes.
   ============================================================ */

'use strict';

const VERSION        = 'v3';
const SHELL_CACHE    = `qc-shell-${VERSION}`;
const TEXT_CACHE     = `qc-text-${VERSION}`;
const FONTS_CACHE    = `qc-fonts-${VERSION}`;
const AUDIO_CACHE    = `qc-audio-${VERSION}`;
const RUNTIME_CACHE  = `qc-runtime-${VERSION}`;

const ALL_CACHES = [SHELL_CACHE, TEXT_CACHE, FONTS_CACHE, AUDIO_CACHE, RUNTIME_CACHE];

/* Shell assets that must always be available offline. */
const SHELL_URLS = [
  './',
  './index.html',
  './manifest.webmanifest'
];

/* Hosts we recognise. */
const HOST_ALQURAN = 'api.alquran.cloud';
const HOST_EVERYAYAH = 'everyayah.com';
const HOST_GOOGLE_FONTS_CSS = 'fonts.googleapis.com';
const HOST_GOOGLE_FONTS_STATIC = 'fonts.gstatic.com';

/* Budgets — keep the caches from growing without bound. */
const TEXT_CACHE_MAX  = 400;   /* ~400 API responses */
const AUDIO_CACHE_MAX = 250;   /* ~250 ayah mp3s */
const RUNTIME_MAX     = 120;

/* ------------------------------------------------------------
   INSTALL
   ------------------------------------------------------------ */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    /* Pre-cache the shell.  Use individual puts so a single 404
       doesn't abort the whole install. */
    await Promise.all(SHELL_URLS.map(async url => {
      try{
        const req = new Request(url, { cache: 'reload' });
        const res = await fetch(req);
        if(res && (res.ok || res.type === 'opaque')){
          await cache.put(url, res.clone());
        }
      }catch(_){ /* ignore — offline installs can still proceed */ }
    }));
    await self.skipWaiting();
  })());
});

/* ------------------------------------------------------------
   ACTIVATE  —  drop old cache versions and take control.
   ------------------------------------------------------------ */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => !ALL_CACHES.includes(k))
        .map(k => caches.delete(k))
    );
    if(self.registration && self.registration.navigationPreload){
      try{ await self.registration.navigationPreload.disable(); }catch(_){}
    }
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------
   MESSAGE  —  allow the page to ask for a cache clear.
   ------------------------------------------------------------ */
self.addEventListener('message', event => {
  const data = event.data || {};
  if(data.type === 'SKIP_WAITING'){
    self.skipWaiting();
    return;
  }
  if(data.type === 'CLEAR_CACHES'){
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      if(event.source && event.source.postMessage){
        event.source.postMessage({ type: 'CACHES_CLEARED' });
      }
    })());
  }
});

/* ------------------------------------------------------------
   FETCH  —  routing
   ------------------------------------------------------------ */
self.addEventListener('fetch', event => {
  const req = event.request;

  /* Only GET is cached.  Feedback POSTs, etc., always hit the network. */
  if(req.method !== 'GET') return;

  let url;
  try{ url = new URL(req.url); }
  catch(_){ return; }

  /* Skip non-http(s) — data:, blob:, chrome-extension:, etc. */
  if(url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* 1. everyayah.com audio — let the browser fetch it directly.
        iOS Safari is very picky about <audio> and Range requests,
        and a Service Worker in the middle can break playback
        entirely.  We therefore DO NOT intercept audio requests. */
  if(url.hostname === HOST_EVERYAYAH){
    return; /* browser default behaviour */
  }

  /* 2. Google Fonts — cache-first, they're immutable. */
  if(url.hostname === HOST_GOOGLE_FONTS_CSS || url.hostname === HOST_GOOGLE_FONTS_STATIC){
    event.respondWith(cacheFirst(req, FONTS_CACHE));
    return;
  }

  /* 3. alquran.cloud API — network-first, fall back to cache.
        The Quran text is immutable, so a stale fallback is always
        correct.  A short-lived background revalidation keeps the
        cache fresh when online. */
  if(url.hostname === HOST_ALQURAN){
    event.respondWith(networkFirst(req, TEXT_CACHE, TEXT_CACHE_MAX));
    return;
  }

  /* 4. Same-origin requests (the app shell). */
  if(url.origin === self.location.origin){
    /* Navigations — try the cached shell first, then network. */
    if(req.mode === 'navigate'){
      event.respondWith(shellNavigation(req));
      return;
    }
    /* Static same-origin assets — cache-first. */
    event.respondWith(cacheFirst(req, RUNTIME_CACHE, RUNTIME_MAX));
    return;
  }

  /* 5. Anything else — passthrough. */
});

/* ------------------------------------------------------------
   STRATEGIES
   ------------------------------------------------------------ */

/* Cache-first with an optional max-entry trim. */
async function cacheFirst(req, cacheName, maxEntries){
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: false });
  if(hit){
    return hit;
  }
  try{
    const res = await fetch(req);
    /* Only cache successful, non-opaque-by-accident responses.
       Opaque responses (status 0) from a cross-origin CDN are OK
       to store — we just can't inspect them. */
    if(res && (res.ok || res.type === 'opaque')){
      /* Clone before we return, then put in the background. */
      const clone = res.clone();
      cache.put(req, clone).then(() => {
        if(maxEntries) trimCache(cacheName, maxEntries);
      }).catch(() => {});
    }
    return res;
  }catch(err){
    /* Offline and not in cache — return a minimal error response
       rather than throwing, so the page sees a clean failure. */
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }
}

/* Network-first with cache fallback. */
async function networkFirst(req, cacheName, maxEntries){
  const cache = await caches.open(cacheName);
  try{
    const res = await fetch(req);
    if(res && res.ok){
      const clone = res.clone();
      cache.put(req, clone).then(() => {
        if(maxEntries) trimCache(cacheName, maxEntries);
      }).catch(() => {});
    }
    return res;
  }catch(err){
    const hit = await cache.match(req, { ignoreSearch: false });
    if(hit) return hit;
    return new Response(
      JSON.stringify({ code: 503, status: 'OFFLINE', data: null }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/* Navigation — serve the cached shell instantly when offline;
   otherwise let the network serve it and update the cache. */
async function shellNavigation(req){
  const cache = await caches.open(SHELL_CACHE);
  try{
    const res = await fetch(req);
    if(res && res.ok && res.type === 'basic'){
      const clone = res.clone();
      cache.put('./index.html', clone).catch(() => {});
    }
    return res;
  }catch(err){
    const hit =
      await cache.match(req, { ignoreSearch: true }) ||
      await cache.match('./index.html', { ignoreSearch: true }) ||
      await cache.match('./', { ignoreSearch: true });
    if(hit) return hit;
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
      '<body style="font-family:sans-serif;padding:2rem;text-align:center;background:#0d1119;color:#e8edf7">' +
      '<h2>You are offline</h2><p>Open the app once while online to enable offline mode.</p>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

/* ------------------------------------------------------------
   CACHE TRIMMING  —  FIFO by insertion order.
   ------------------------------------------------------------ */
async function trimCache(cacheName, maxEntries){
  try{
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    const over = keys.length - maxEntries;
    if(over <= 0) return;
    /* keys() returns in insertion order in every current browser. */
    for(let i = 0; i < over; i++){
      await cache.delete(keys[i]);
    }
  }catch(_){}
}