/* ============================================================
   Quran Recitation Coach — Service Worker
   ============================================================
   v2.0.11 — Version-only release. Forces SW reinstall + clean
   cache rebuild so clients pick up the v2.0.11 index.html fixes
   (Hifz back button, Bismillah as ayah 0, prayer-alarm stop-on-
   tap, larger tab typography, coach tab icon removal).
   ============================================================ */

'use strict';

const VERSION = '2.0.11';

const SHELL_CACHE   = `qc-shell-${VERSION}`;
const TEXT_CACHE    = `qc-text-${VERSION}`;
const FONTS_CACHE   = `qc-fonts-${VERSION}`;
const RUNTIME_CACHE = `qc-runtime-${VERSION}`;

const VERSIONED_CACHES = [SHELL_CACHE, TEXT_CACHE, FONTS_CACHE, RUNTIME_CACHE];

/* Persistent caches — NEVER deleted on activation, regardless of
   version. Downloaded Quran audio and downloaded translation audio
   both live here. */
const AUDIO_CACHE = 'qc-audio';
const PERSISTENT_CACHES = [AUDIO_CACHE];

const OWNED_PREFIXES = ['qc-shell-', 'qc-text-', 'qc-fonts-', 'qc-runtime-'];

/* Pre-cache the shell, manifest, AND the real app icons so they
   are available for the install prompt and offline usage. */
const SHELL_URLS = [
  './', 
  './index.html', 
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

const HOST_ALQURAN              = 'api.alquran.cloud';
const HOST_QURAN_COM            = 'api.quran.com';
const HOST_EVERYAYAH            = 'everyayah.com';
const HOST_GOOGLE_FONTS_CSS     = 'fonts.googleapis.com';
const HOST_GOOGLE_FONTS_STATIC  = 'fonts.gstatic.com';

const TEXT_CACHE_MAX = 400;
const RUNTIME_MAX    = 120;
const MANIFEST_TIMEOUT_MS = 2000;

/* The exact Google Fonts stylesheet URL used by <link> in index.html. */
const FONT_CSS_URL = 'https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Amiri+Quran&family=Scheherazade+New:wght@400;700&family=Noto+Naskh+Arabic:wght@400;700&display=swap';
const FONT_FETCH_TIMEOUT_MS   = 8000;
const FONTS_PREFETCH_TOTAL_MS = 20000;

/* Inline SVG icon used by push notifications. */
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
    // 1. Shell — awaited (mandatory for offline open). The
    //    `cache:'reload'` marker guarantees the worker stores the
    //    exact index.html currently deployed, never a stale copy
    //    from the browser HTTP cache. Icons are cached here too.
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
   ACTIVATE — drop stale versioned caches, claim clients
   ------------------------------------------------------------
   This is the ONLY place the SW deletes anything. It deletes
   exclusively caches whose names start with an OWNED_PREFIX
   AND are not in the current VERSIONED_CACHES list. The
   persistent 'qc-audio' cache is never in that set because:
     (a) it is whitelisted in PERSISTENT_CACHES, and
     (b) it does not start with any OWNED_PREFIX.
   Both checks mean downloaded Quran audio and downloaded
   translation audio survive every version bump, forever.
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
        // Only navigate for SPECIFIC targets (e.g. "open ayah 2:255").
        // Prayer-time notifications fire with no data.url → target
        // defaults to './'. Navigating a focused app to Home on a
        // prayer-alert tap would kill any active recitation session
        // mid-flow. So for the default case, just focus.
        const isSpecific =
          target &&
          target !== './' &&
          target !== '/' &&
          target !== self.registration.scope;
        if(isSpecific){
          try{ await c.navigate(target); }catch(_){}
        }
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
    // robots.txt is the *only* file that can block Google-Extended and
    // Applebot-Extended (they share their UA with Googlebot / Applebot
    // and are indistinguishable in JS). It must always be served fresh
    // from Vercel, never from any cache.
    if(url.pathname === '/robots.txt')             return;
  }

  // Tajweed annotation requests — always try the network first so
  // newly-shipped colour fields are never hidden behind a stale
  // cache. networkFresh() caches successful responses for offline
  // fallback; if the network fails it will return the last-seen
  // cached version instead of a hard 504.
  if(url.hostname === HOST_QURAN_COM && url.search.includes('text_uthmani_tajweed')){
    event.respondWith(networkFresh(req));
    return;
  }

  // Audio from everyayah.com — served from the persistent download
  // cache first (works fully offline), network second. Respects
  // req.cache ('no-store' / 'reload') so the app's healing path can
  // actually fetch fresh bytes, and answers Range requests with a
  // proper 206 for iOS Safari.
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

  // Anything else (cdn.islamic.network audio fallback during download,
  // api.bigdatacloud.net / geocoding-api.open-meteo.com for the Prayer
  // Times screen, islamcan.com adhan fallback) is intentionally left
  // unhandled so it goes to the network normally. Download code in
  // index.html stores fallback audio under the everyayah.com URL, so
  // playback always hits qc-audio regardless of which source succeeded.
});

/* ============================================================
   Audio — persistent download cache with Range + bypass support
   ------------------------------------------------------------
   This function reads AND writes the persistent 'qc-audio'
   cache. It is the sole gateway to downloaded Quran audio and
   downloaded translation audio. The cache is not versioned
   and never deleted on activate — see PERSISTENT_CACHES.
   ============================================================ */

async function audioFromDownloadCache(req){
  // Respect explicit no-store/reload from the app. This is what makes
  // playTranslationWithHealing() actually able to refresh a broken
  // cached audio file — the heal fetch fires with `cache: 'no-store'`
  // + `?_heal=<ts>`, and without this guard the SW would keep serving
  // the same corrupt bytes from qc-audio, defeating the heal entirely.
  const bypass = req.cache === 'no-store' || req.cache === 'reload';

  if(!bypass){
    try{
      const cache = await caches.open(AUDIO_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
      if(hit){
        // <audio> sends `Range: bytes=0-` for media files. Serving the
        // full cached response with a 200 works on Chrome / Firefox,
        // but iOS Safari is strict about receiving a real 206 with a
        // valid Content-Range header. Return a proper 206 slice when
        // the client asked for a range.
        const rangeHeader = req.headers.get('range');
        if(rangeHeader) return serveRangeFromCached(hit, rangeHeader);
        return hit;
      }
    }catch(_){}
  }

  try{
    // Preserve the request's own cache mode (`no-store` / `reload` /
    // `default`) — passing the original Request object to fetch() is
    // sufficient, no need to re-wrap.
    return await fetch(req);
  }catch(_){
    // Network failed. If we bypassed the cache earlier, try it now as
    // a last resort — a slightly-stale file beats a hard 504 when the
    // user is offline mid-playback.
    if(bypass){
      try{
        const cache = await caches.open(AUDIO_CACHE);
        const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
        if(hit) return hit;
      }catch(_){}
    }
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }
}

async function serveRangeFromCached(response, rangeHeader){
  let blob;
  try{ blob = await response.blob(); }
  catch(_){ return response; }

  const size = blob.size;
  if(!size) return response;

  // Parse the standard byte-range forms: bytes=0-, bytes=N-, bytes=0-N,
  // bytes=-N (suffix range). Unparseable → return full 200.
  const m = /^bytes=(\d*)-(\d*)$/.exec((rangeHeader || '').trim());
  if(!m){
    return new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'audio/mpeg',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(size)
      }
    });
  }

  let start, end;
  if(m[1] === '' && m[2] !== ''){
    // Suffix range: bytes=-N → last N bytes
    const suffix = parseInt(m[2], 10);
    if(!isFinite(suffix) || suffix <= 0) return response;
    start = Math.max(0, size - suffix);
    end   = size - 1;
  } else if(m[1] !== '' && m[2] === ''){
    // Open range: bytes=N- → from N to end
    start = parseInt(m[1], 10);
    end   = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end   = parseInt(m[2], 10);
  }

  if(!isFinite(start) || start < 0) start = 0;
  if(!isFinite(end)   || end >= size) end = size - 1;

  if(start > end){
    return new Response('', {
      status: 416,
      statusText: 'Range Not Satisfiable',
      headers: { 'Content-Range': 'bytes */' + size }
    });
  }

  const slice = blob.slice(start, end + 1, 'audio/mpeg');
  return new Response(slice, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}

/* ============================================================
   Fetch strategies
   ============================================================ */

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

/* networkFresh — always goes to the network first (bypassing the
   browser HTTP cache entirely). Caches successful responses in
   TEXT_CACHE and falls back to them when the network fails. */
async function networkFresh(req){
  try{
    const freshReq = new Request(req, { cache: 'no-store' });
    const res = await fetch(freshReq);
    if(res && res.ok){
      try{
        const cache = await caches.open(TEXT_CACHE);
        await cache.put(req, res.clone());
        trimCache(TEXT_CACHE, TEXT_CACHE_MAX).catch(() => {});
      }catch(_){}
      return res;
    }
    throw new Error('bad response');
  }catch(_){
    try{
      const cache = await caches.open(TEXT_CACHE);
      const hit = await cache.match(req, { ignoreVary: true });
      if(hit) return hit;
    }catch(_){}
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }
}

async function manifestFresh(req){
  const cache = await caches.open(SHELL_CACHE);

  // 1. Try network with a 2 s budget.
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

  // 2. Offline — serve from cache.
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
    // index.html can never be served after a deploy.
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
      '<p>Open the app once while online to enable offline mode.</p>' +
      '<p style="font-size:.75rem;opacity:.6;margin-top:2rem">&copy; 2025 Quran Recitation Coach. All rights reserved.</p>',
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