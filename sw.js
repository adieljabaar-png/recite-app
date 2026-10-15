/* ============================================================
   Quran Recitation Coach — Service Worker
   ============================================================
   Responsibilities:
     • Cache the app shell (index.html + manifest.json + icons)
       so the PWA launches offline.
     • Runtime-cache Quran text / translation responses from
       api.quran.com (v4) and api.alquran.cloud (fallback).
     • Cache Google Fonts.
     • NEVER intercept everyayah.com audio — iOS Safari needs the
       raw HTTP Range handshake to play <audio>.
     • NEVER intercept /my-analytics/* — the Vercel Analytics
       proxy must reach the network untouched so the request
       still looks like a normal first-party asset.
     • Never cache POST requests (feedback submissions).

   Cache version is bumped whenever the shell changes — that
   is what forces visitors to see the new HTML after a deploy.

   v10 — Version bumped so browsers pick up the new shell after
         the vercel.json header/rewrite fix.  The vercel.json now
         forces sw.js and index.html to revalidate on every load
         and correctly proxies /my-analytics/* to Vercel, which
         was previously being rewritten to index.html by the
         catch-all rule and breaking both Analytics and the SW
         registration silently.
   ============================================================ */

'use strict';

const VERSION        = 'v10';                    /* ← bumped from v9 */
const SHELL_CACHE    = `qc-shell-${VERSION}`;
const TEXT_CACHE     = `qc-text-${VERSION}`;
const FONTS_CACHE    = `qc-fonts-${VERSION}`;
const RUNTIME_CACHE  = `qc-runtime-${VERSION}`;

const ALL_CACHES = [SHELL_CACHE, TEXT_CACHE, FONTS_CACHE, RUNTIME_CACHE];

/* Shell assets that must always be available offline. */
const SHELL_URLS = [
  './',
  './index.html',
  './manifest.json'
];

/* Hosts we recognise. */
const HOST_ALQURAN              = 'api.alquran.cloud';
const HOST_QURAN_COM            = 'api.quran.com';
const HOST_EVERYAYAH            = 'everyayah.com';
const HOST_GOOGLE_FONTS_CSS     = 'fonts.googleapis.com';
const HOST_GOOGLE_FONTS_STATIC  = 'fonts.gstatic.com';

/* Budgets — keep the caches from growing without bound. */
const TEXT_CACHE_MAX  = 400;
const RUNTIME_MAX     = 120;

/* ------------------------------------------------------------
   INSTALL
   ------------------------------------------------------------ */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL_URLS.map(async url => {
      try{
        const req = new Request(url, { cache: 'reload' });
        const res = await fetch(req);
        if(res && (res.ok || res.type === 'opaque')){
          await cache.put(url, res.clone());
        }
      }catch(_){ /* offline installs can still proceed */ }
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

  /* Only GET is cached.  Feedback POSTs always hit the network. */
  if(req.method !== 'GET') return;

  let url;
  try{ url = new URL(req.url); }
  catch(_){ return; }

  /* Skip non-http(s) — data:, blob:, chrome-extension:, etc. */
  if(url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* 1. everyayah.com audio — let the browser fetch it directly.
        iOS Safari is very picky about <audio> and Range requests,
        and a Service Worker in the middle can break playback
        entirely.  DO NOT intercept. */
  if(url.hostname === HOST_EVERYAYAH){
    return;
  }

  /* 2. Vercel Analytics proxy — must reach the network as a
        normal same-origin request.  No SW caching, no rewriting.
        The vercel.json rewrite sends this to va.vercel-scripts.com
        so the request still looks like a normal first-party asset
        from the browser's point of view. */
  if(url.origin === self.location.origin && url.pathname.startsWith('/my-analytics/')){
    return;
  }

  /* 3. Google Fonts — cache-first, they're immutable. */
  if(url.hostname === HOST_GOOGLE_FONTS_CSS || url.hostname === HOST_GOOGLE_FONTS_STATIC){
    event.respondWith(cacheFirst(req, FONTS_CACHE));
    return;
  }

  /* 4. Quran.com API v4 — the reader’s primary source for the
        IndoPak text with the full Tajweed symbol set.
        Network-first with cache fallback. */
  if(url.hostname === HOST_QURAN_COM){
    event.respondWith(networkFirst(req, TEXT_CACHE, TEXT_CACHE_MAX));
    return;
  }

  /* 5. alquran.cloud API — coach’s Uthmani text, English
        translation, and the reader’s fallback edition.
        Network-first. */
  if(url.hostname === HOST_ALQURAN){
    event.respondWith(networkFirst(req, TEXT_CACHE, TEXT_CACHE_MAX));
    return;
  }

  /* 6. Same-origin requests (the app shell). */
  if(url.origin === self.location.origin){
    if(req.mode === 'navigate'){
      event.respondWith(shellNavigation(req));
      return;
    }
    event.respondWith(cacheFirst(req, RUNTIME_CACHE, RUNTIME_MAX));
    return;
  }

  /* 7. Anything else — passthrough. */
});

/* ------------------------------------------------------------
   STRATEGIES
   ------------------------------------------------------------ */

async function cacheFirst(req, cacheName, maxEntries){
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: false });
  if(hit) return hit;
  try{
    const res = await fetch(req);
    if(res && (res.ok || res.type === 'opaque')){
      const clone = res.clone();
      cache.put(req, clone).then(() => {
        if(maxEntries) trimCache(cacheName, maxEntries);
      }).catch(() => {});
    }
    return res;
  }catch(err){
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }
}

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
    for(let i = 0; i < over; i++){
      await cache.delete(keys[i]);
    }
  }catch(_){}
}