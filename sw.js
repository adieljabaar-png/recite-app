/* ============================================================
   Quran Recitation Coach — Service Worker
   ============================================================
   v38 — Single-word Tajweed grading release.

   Ships the rewritten gradeFull() engine in index.html:

     • Every spoken token is now graded against ONE word at a time
       — no merged-token shortcut, no split-token shortcut. Each
       word therefore passes individually through runStrict1Checks()
       (madd timing, ghunnah presence, ghunnah length).
     • On a lookahead hit, only the word that was actually attempted
       (and failed) is marked `skipped` and counted as an error.
       Intermediate words the reciter never reached are left
       untouched — they are neither marked wrong nor counted.
     • The Tajweed / strict confidence floor has been lowered from
       0.40 to 0.35, so fewer legitimate final results get filtered
       out in Tajweed mode.

   The new client code lives in index.html; this version bump
   forces the browser to discard every qc-*-v37 cache on activate
   so the updated HTML is served on next open.

   All fetch-strategy behaviour from v37 is preserved:
     - Tajweed annotations (networkFresh).
     - Audio requests from everyayah.com (audioFromDownloadCache).
     - Google Fonts pre-cache at install.
     - Shell navigation with cache:'reload' (never serves stale HTML).
     - Manifest with a 2 s network budget.

   NOTE ON DEPLOY: after shipping v38, fully close the PWA (or
   close every tab showing the site) and reopen it. The browser
   fetches sw.js on navigation; the new worker's install calls
   skipWaiting() and its activate calls clients.claim(), so the
   next open runs the new code path. Caches qc-*-v37 are deleted
   on activate; qc-audio (downloads) is preserved.
   ============================================================ */

'use strict';

const VERSION = 'v38';

const SHELL_CACHE   = `qc-shell-${VERSION}`;
const TEXT_CACHE    = `qc-text-${VERSION}`;
const FONTS_CACHE   = `qc-fonts-${VERSION}`;
const RUNTIME_CACHE = `qc-runtime-${VERSION}`;

const VERSIONED_CACHES = [SHELL_CACHE, TEXT_CACHE, FONTS_CACHE, RUNTIME_CACHE];

const AUDIO_CACHE = 'qc-audio';
const PERSISTENT_CACHES = [AUDIO_CACHE];

const OWNED_PREFIXES = ['qc-shell-', 'qc-text-', 'qc-fonts-', 'qc-runtime-'];

const SHELL_URLS = ['./', './index.html', './manifest.json'];

const HOST_ALQURAN              = 'api.alquran.cloud';
const HOST_QURAN_COM            = 'api.quran.com';
const HOST_EVERYAYAH            = 'everyayah.com';
const HOST_GOOGLE_FONTS_CSS     = 'fonts.googleapis.com';
const HOST_GOOGLE_FONTS_STATIC  = 'fonts.gstatic.com';

const TEXT_CACHE_MAX = 400;
const RUNTIME_MAX    = 120;
const MANIFEST_TIMEOUT_MS = 2000;

/* The exact Google Fonts stylesheet URL used by <link> in index.html.
   Pre-cached during install so the stylesheet is available offline
   on the very first cold open — not just on the second visit. */
const FONT_CSS_URL = 'https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Amiri+Quran&family=Scheherazade+New:wght@400;700&family=Noto+Naskh+Arabic:wght@400;700&display=swap';
const FONT_FETCH_TIMEOUT_MS  = 8000;
const FONTS_PREFETCH_TOTAL_MS = 20000;

/* Inline SVG icon used by push notifications. The deploy ships no
   icon-192.png / badge-72.png raster files — the app itself uses
   SVG data URIs in <link rel="icon"> / <link rel="apple-touch-icon">.
   Reusing the same artwork here means the OS notification banner
   actually shows the Recite logo instead of a broken-image marker. */
const NOTIFICATION_ICON = "data:image/svg+xml," + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 180 180'>" +
    "<rect width='180' height='180' rx='40' fill='#000000'/>" +
    "<path d='M90 62 Q58 48 28 50 L28 118 Q58 116 90 130 Z' fill='#F5C542'/>" +
    "<path d='M90 62 Q122 48 152 50 L152 118 Q122 116 90 130 Z' fill='#D9A32B'/>" +
  "</svg>"
);

/* ============================================================
   INSTALL — cache shell + pre-cache Google Fonts
   ============================================================ */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // 1. Shell — awaited (mandatory for offline open)
    try{
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(SHELL_URLS.map(async url => {
        try{
          const req = new Request(url, { cache: 'reload' });
          const res = await fetch(req);
          if(res && (res.ok || res.type === 'opaque')) await cache.put(url, res.clone());
        }catch(_){}
      }));
    }catch(_){}

    // 2. Google Fonts — best-effort, bounded to 20 s so install
    //    can never hang if the network is slow or the CDN is down.
    try{
      await Promise.race([
        prefetchFonts().catch(() => {}),
        new Promise(r => setTimeout(r, FONTS_PREFETCH_TOTAL_MS))
      ]);
    }catch(_){}

    // 3. Activate immediately
    try{ await self.skipWaiting(); }catch(_){}
  })());
});

/* ============================================================
   ACTIVATE — drop every stale versioned cache, claim clients
   ============================================================ */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try{
      const keys = await caches.keys();
      const toDelete = keys.filter(name => {
        if(VERSIONED_CACHES.includes(name)) return false;
        if(PERSISTENT_CACHES.includes(name)) return false;
        const owned = OWNED_PREFIXES.some(p => name.startsWith(p));
        if(!owned) return false;
        return true;
      });
      await Promise.all(toDelete.map(name => caches.delete(name)));
    }catch(_){}

    if(self.registration && self.registration.navigationPreload){
      try{ await self.registration.navigationPreload.disable(); }catch(_){}
    }
    try{ await self.clients.claim(); }catch(_){}
  })());
});

/* ============================================================
   MESSAGES — SKIP_WAITING / CLEAR_CACHES / CLEAR_AUDIO_CACHE /
              REFRESH_MANIFEST
   ============================================================ */
self.addEventListener('message', event => {
  const data = event.data || {};
  if(data.type === 'SKIP_WAITING'){ self.skipWaiting(); return; }
  if(data.type === 'CLEAR_CACHES'){
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      if(event.source && event.source.postMessage) event.source.postMessage({ type: 'CACHES_CLEARED' });
    })());
    return;
  }
  if(data.type === 'CLEAR_AUDIO_CACHE'){
    event.waitUntil((async () => {
      try{ await caches.delete(AUDIO_CACHE); }catch(_){}
      if(event.source && event.source.postMessage) event.source.postMessage({ type: 'AUDIO_CACHE_CLEARED' });
    })());
    return;
  }
  if(data.type === 'REFRESH_MANIFEST'){
    event.waitUntil((async () => {
      try{
        const cache = await caches.open(SHELL_CACHE);
        await Promise.all([
          cache.delete('./manifest.json', { ignoreSearch: true }),
          cache.delete('./index.html',    { ignoreSearch: true }),
          cache.delete('./',              { ignoreSearch: true })
        ]);
      }catch(_){}
      if(event.source && event.source.postMessage) event.source.postMessage({ type: 'MANIFEST_REFRESHED' });
    })());
    return;
  }
});

/* ============================================================
   PUSH — show notification with the Recite logo
   ============================================================ */
self.addEventListener('push', event => {
  let data = { title: 'Quran Recitation Coach', body: 'You have a new message.', url: './' };
  try{ if(event.data) data = Object.assign(data, event.data.json()); }catch(_){}
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_ICON,
    tag: data.tag || 'qc-notification',
    renotify: true,
    data: { url: data.url }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for(const c of list){
      if(c.url.startsWith(self.location.origin) && 'focus' in c){
        try{ c.navigate(target); }catch(_){}
        return c.focus();
      }
    }
    if(clients.openWindow) return clients.openWindow(target);
  })());
});

/* ============================================================
   FETCH — strategy dispatch
   ============================================================ */
self.addEventListener('fetch', event => {
  const req = event.request;

  // Only intercept GET. POST / PUT / DELETE — including Vercel Analytics
  // view events, /api/feedback and /api/subscribe — must go straight to
  // the network untouched.
  if(req.method !== 'GET') return;

  let url;
  try{ url = new URL(req.url); }catch(_){ return; }
  if(url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Same-origin paths that must NEVER be intercepted by the SW.
  if(url.origin === self.location.origin){
    if(url.pathname.startsWith('/my-analytics/')) return;   // proxied Vercel Web Analytics
    if(url.pathname.startsWith('/_vercel/'))       return;   // native Vercel Analytics / Speed Insights
    if(url.pathname.startsWith('/api/'))           return;   // serverless functions
    if(url.pathname === '/sw.js')                  return;   // the service worker itself
  }

  // Tajweed annotation requests — forced fresh, never cached.
  // This is the fix for "Tajweed colour coding doesn't update":
  // the client always receives live Tajweed data, and a stale
  // TEXT_CACHE or HTTP-cached response can never silently hide
  // newly-shipped colour fields.
  if(url.hostname === HOST_QURAN_COM && url.search.includes('text_uthmani_tajweed')){
    event.respondWith(networkFresh(req));
    return;
  }

  // Audio from everyayah.com — served from the persistent download
  // cache first (works fully offline), network second.
  if(url.hostname === HOST_EVERYAYAH){
    event.respondWith(audioFromDownloadCache(req));
    return;
  }

  // Google Fonts — cache-first, pre-populated at install.
  if(url.hostname === HOST_GOOGLE_FONTS_CSS || url.hostname === HOST_GOOGLE_FONTS_STATIC){
    event.respondWith(cacheFirst(req, FONTS_CACHE));
    return;
  }

  // Quran text APIs — network-first with cache fallback.
  if(url.hostname === HOST_QURAN_COM || url.hostname === HOST_ALQURAN){
    event.respondWith(networkFirst(req, TEXT_CACHE, TEXT_CACHE_MAX));
    return;
  }

  // Same-origin
  if(url.origin === self.location.origin){
    if(url.pathname.endsWith('/manifest.json')){
      event.respondWith(manifestFresh(req));
      return;
    }
    if(req.mode === 'navigate'){
      event.respondWith(shellNavigation(req));
      return;
    }
    event.respondWith(cacheFirst(req, RUNTIME_CACHE, RUNTIME_MAX));
    return;
  }
});

/* ============================================================
   Fetch strategies
   ============================================================ */

async function audioFromDownloadCache(req){
  try{
    const cache = await caches.open(AUDIO_CACHE);
    const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
    if(hit) return hit;
  }catch(_){}
  try{
    return await fetch(req);
  }catch(_){
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }
}

async function cacheFirst(req, cacheName, maxEntries){
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if(hit) return hit;
  try{
    const res = await fetch(req);
    if(res && (res.ok || res.type === 'opaque')){
      const clone = res.clone();
      cache.put(req, clone)
        .then(() => { if(maxEntries) trimCache(cacheName, maxEntries); })
        .catch(() => {});
    }
    return res;
  }catch(_){
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }
}

async function networkFirst(req, cacheName, maxEntries){
  const cache = await caches.open(cacheName);
  try{
    const res = await fetch(req);
    if(res && res.ok){
      const clone = res.clone();
      cache.put(req, clone)
        .then(() => { if(maxEntries) trimCache(cacheName, maxEntries); })
        .catch(() => {});
    }
    return res;
  }catch(_){
    const hit = await cache.match(req);
    if(hit) return hit;
    return new Response(
      JSON.stringify({ code: 503, status: 'OFFLINE', data: null }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/* networkFresh — always goes to the network, bypasses the browser's
   HTTP cache entirely, and never falls back to any cache. Used for
   Tajweed annotation requests where freshness is more important than
   offline availability (Tajweed colouring requires network anyway). */
async function networkFresh(req){
  try{
    const freshReq = new Request(req, { cache: 'no-store' });
    const res = await fetch(freshReq);
    if(res) return res;
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }catch(_){
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }
}

async function manifestFresh(req){
  const cache = await caches.open(SHELL_CACHE);

  // 1. Try network with a 2 s budget (manifest changes must reach the
  //    client quickly, but offline must never hang on the request).
  try{
    const controller = new AbortController();
    const timer = setTimeout(() => { try{ controller.abort(); }catch(_){} }, MANIFEST_TIMEOUT_MS);
    let res;
    try{
      res = await fetch(req, { signal: controller.signal, cache: 'no-store' });
    } finally {
      clearTimeout(timer);
    }
    if(res && res.ok){
      const clone = res.clone();
      cache.put('./manifest.json', clone).catch(() => {});
      return res;
    }
    throw new Error('bad response');
  }catch(_){ /* fall through to cache */ }

  // 2. Offline — serve from cache. Try both the canonical key and the
  //    request's own URL, since the navigation may hit either one.
  try{
    let hit = await cache.match('./manifest.json', { ignoreSearch: true });
    if(!hit) hit = await cache.match(req, { ignoreSearch: true });
    if(hit) return hit;
  }catch(_){}

  // 3. Last resort — inline fallback manifest so installation never fails.
  return new Response(
    JSON.stringify({
      name: 'Quran Recitation Coach',
      short_name: 'Recite',
      start_url: './',
      scope: './',
      display: 'standalone',
      background_color: '#0d1119',
      theme_color: '#0d1119',
      icons: []
    }),
    { status: 200, headers: { 'Content-Type': 'application/manifest+json; charset=utf-8' } }
  );
}

async function shellNavigation(req){
  const cache = await caches.open(SHELL_CACHE);
  try{
    // Force a fresh fetch — bypass the browser HTTP cache so a stale
    // index.html can never be served after a deploy. This is the fix
    // for "my Tajweed fix didn't reach the app": even with network
    // available, HTTP-cached HTML was silently masking new client code.
    const freshReq = new Request(req, { cache: 'reload' });
    const res = await fetch(freshReq);
    if(res && res.ok && res.type === 'basic'){
      const clone = res.clone();
      cache.put('./index.html', clone).catch(() => {});
    }
    return res;
  }catch(_){
    let hit = null;
    try{
      hit = await cache.match(req, { ignoreSearch: true })
         || await cache.match('./index.html', { ignoreSearch: true })
         || await cache.match('./', { ignoreSearch: true });
    }catch(_){}
    if(hit) return hit;
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
      '<body style="font-family:sans-serif;padding:2rem;text-align:center;background:#0d1119;color:#e8edf7">' +
      '<h2>You are offline</h2>' +
      '<p>Open the app once while online to enable offline mode.</p>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function trimCache(cacheName, maxEntries){
  try{
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    const over = keys.length - maxEntries;
    if(over <= 0) return;
    for(let i = 0; i < over; i++) await cache.delete(keys[i]);
  }catch(_){}
}

/* ============================================================
   Google Fonts pre-cache (bounded, best-effort)
   ============================================================
   Fetches the exact stylesheet URL used by index.html, stores it
   in FONTS_CACHE, then parses every `url(...)` entry it contains
   and fetches each font file in parallel. Any individual failure
   is ignored so one slow font file can never abort the whole
   pre-cache. Total operation is wrapped in a 20 s outer timeout
   by the caller.
   ============================================================ */

async function fetchWithTimeout(url, ms){
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try{ ctrl.abort(); }catch(_){} }, ms);
  try{
    return await fetch(url, {
      signal: ctrl.signal,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store'
    });
  } finally {
    clearTimeout(timer);
  }
}

async function prefetchFonts(){
  let cache;
  try{ cache = await caches.open(FONTS_CACHE); }catch(_){ return; }

  // 1. Fetch and cache the CSS stylesheet
  let cssText = '';
  try{
    const cssRes = await fetchWithTimeout(FONT_CSS_URL, FONT_FETCH_TIMEOUT_MS);
    if(cssRes && cssRes.ok){
      cssText = await cssRes.clone().text();
      try{ await cache.put(FONT_CSS_URL, cssRes); }catch(_){}
    }
  }catch(_){}

  if(!cssText) return;

  // 2. Extract every absolute url(...) referenced from the stylesheet
  const urls = [];
  const re = /url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g;
  let m;
  while((m = re.exec(cssText)) !== null){
    const u = m[2];
    if(u && /^https?:\/\//i.test(u)) urls.push(u);
  }

  // 3. Fetch each font file in parallel, skipping ones already cached
  const unique = Array.from(new Set(urls));
  await Promise.all(unique.map(async u => {
    try{
      const existing = await cache.match(u, { ignoreSearch: true });
      if(existing) return;
      const r = await fetchWithTimeout(u, FONT_FETCH_TIMEOUT_MS);
      if(r && (r.ok || r.type === 'opaque')){
        try{ await cache.put(u, r); }catch(_){}
      }
    }catch(_){}
  }));
}