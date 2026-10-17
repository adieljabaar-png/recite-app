/* ============================================================
   Quran Recitation Coach — Service Worker
   ============================================================
   v21 — Update-safe caches.

   WHAT CHANGED
   ------------
   • Offline surah audio is now stored in a PERSISTENT cache
     called `qc-audio`. This cache is NEVER deleted by a version
     update.
   • The activate handler no longer wipes every unknown cache.
     It only deletes caches that (a) belong to this app — i.e.
     their name starts with qc-shell- / qc-text- / qc-fonts- /
     qc-runtime- — AND (b) do not match the current VERSION.
   • `qc-audio` is served back to the <audio> element when the
     device is offline, so downloaded surahs really play.
   • localStorage (prayer adjustments, progress, bookmarks,
     settings) is never touched by a service worker — that
     guarantee is unchanged and now documented below.

   USER DATA THAT SURVIVES EVERY UPDATE
   ------------------------------------
   • qc.prayer            → prayer time adjustments / method
   • qc.progress.follow   → saved Follow session
   • qc.progress.tajweed  → saved Tajweed session
   • qc.bookmarks         → bookmarks
   • qc.*                 → theme, reciter, volume, etc.
   • Cache "qc-audio"     → downloaded surah audio
   ============================================================ */

'use strict';

/* ---------------- Version ---------------- */
const VERSION = 'v21';

/* ---------------- App-owned caches (rebuilt on release) ---------------- */
const SHELL_CACHE   = `qc-shell-${VERSION}`;
const TEXT_CACHE    = `qc-text-${VERSION}`;
const FONTS_CACHE   = `qc-fonts-${VERSION}`;
const RUNTIME_CACHE = `qc-runtime-${VERSION}`;

const VERSIONED_CACHES = [SHELL_CACHE, TEXT_CACHE, FONTS_CACHE, RUNTIME_CACHE];

/* ---------------- User-data caches (NEVER purged) ---------------- */
const AUDIO_CACHE = 'qc-audio';
const PERSISTENT_CACHES = [AUDIO_CACHE];

/* ---------------- Prefixes this app owns ----------------
   Only a cache whose name begins with one of these prefixes may
   ever be deleted during an upgrade. Any cache we did not create
   (including qc-audio) is left completely alone.                */
const OWNED_PREFIXES = ['qc-shell-', 'qc-text-', 'qc-fonts-', 'qc-runtime-'];

/* ---------------- Shell assets ---------------- */
const SHELL_URLS = [
  './',
  './index.html',
  './manifest.json'
];

/* ---------------- Recognised hosts ---------------- */
const HOST_ALQURAN              = 'api.alquran.cloud';
const HOST_QURAN_COM            = 'api.quran.com';
const HOST_EVERYAYAH            = 'everyayah.com';
const HOST_GOOGLE_FONTS_CSS     = 'fonts.googleapis.com';
const HOST_GOOGLE_FONTS_STATIC  = 'fonts.gstatic.com';

/* ---------------- Cache budgets ---------------- */
const TEXT_CACHE_MAX = 400;
const RUNTIME_MAX    = 120;

/* ---------------- Manifest freshness window ---------------- */
const MANIFEST_TIMEOUT_MS = 2000;

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
   ACTIVATE  —  drop ONLY stale app-owned caches.

   qc-audio (downloaded surahs) is explicitly protected, and any
   cache whose name is not one of ours is never touched.
   ------------------------------------------------------------ */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    const toDelete = keys.filter(name => {
      /* 1. Current-version app caches — keep. */
      if(VERSIONED_CACHES.includes(name)) return false;

      /* 2. User-data caches — keep forever. */
      if(PERSISTENT_CACHES.includes(name)) return false;

      /* 3. Anything not created by this app — keep. */
      const owned = OWNED_PREFIXES.some(p => name.startsWith(p));
      if(!owned) return false;

      /* 4. Old-version app cache — safe to delete. */
      return true;
    });

    await Promise.all(toDelete.map(name => caches.delete(name)));

    if(self.registration && self.registration.navigationPreload){
      try{ await self.registration.navigationPreload.disable(); }catch(_){}
    }

    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------
   MESSAGE  —  page → SW control channel.
   ------------------------------------------------------------ */
self.addEventListener('message', event => {
  const data = event.data || {};

  if(data.type === 'SKIP_WAITING'){
    self.skipWaiting();
    return;
  }

  /* Full wipe — only used by the explicit "Reset app" button.
     This DOES remove downloads, because the user asked for a
     complete reset. A normal update never reaches this path. */
  if(data.type === 'CLEAR_CACHES'){
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      if(event.source && event.source.postMessage){
        event.source.postMessage({ type: 'CACHES_CLEARED' });
      }
    })());
    return;
  }

  if(data.type === 'CLEAR_AUDIO_CACHE'){
    event.waitUntil((async () => {
      try{ await caches.delete(AUDIO_CACHE); }catch(_){}
      if(event.source && event.source.postMessage){
        event.source.postMessage({ type: 'AUDIO_CACHE_CLEARED' });
      }
    })());
    return;
  }

  if(data.type === 'REFRESH_MANIFEST'){
    event.waitUntil((async () => {
      try{
        const cache = await caches.open(SHELL_CACHE);
        await Promise.all([
          cache.delete('./manifest.json', { ignoreSearch: true }),
          cache.delete('./index.html',   { ignoreSearch: true }),
          cache.delete('./',             { ignoreSearch: true })
        ]);
      }catch(_){}
      if(event.source && event.source.postMessage){
        event.source.postMessage({ type: 'MANIFEST_REFRESHED' });
      }
    })());
    return;
  }
});

/* ------------------------------------------------------------
   PUSH NOTIFICATIONS
   ------------------------------------------------------------ */
self.addEventListener('push', event => {
  let data = {
    title: 'Quran Recitation Coach',
    body:  'You have a new message.',
    url:   './'
  };
  try{
    if(event.data) data = Object.assign(data, event.data.json());
  }catch(_){}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: data.tag || 'qc-notification',
      renotify: true,
      data: { url: data.url }
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';

  event.waitUntil((async () => {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for(const c of list){
      if(c.url.startsWith(self.location.origin) && 'focus' in c){
        c.navigate(target);
        return c.focus();
      }
    }
    if(clients.openWindow) return clients.openWindow(target);
  })());
});

/* ------------------------------------------------------------
   FETCH  —  routing
   ------------------------------------------------------------ */
self.addEventListener('fetch', event => {
  const req = event.request;

  if(req.method !== 'GET') return;

  let url;
  try{ url = new URL(req.url); }
  catch(_){ return; }

  if(url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* ---- Ayah audio: serve from the persistent download cache ---- */
  if(url.hostname === HOST_EVERYAYAH){
    event.respondWith(audioFromDownloadCache(req));
    return;
  }

  if(url.origin === self.location.origin && url.pathname.startsWith('/my-analytics/')){
    return;
  }

  if(url.hostname === HOST_GOOGLE_FONTS_CSS || url.hostname === HOST_GOOGLE_FONTS_STATIC){
    event.respondWith(cacheFirst(req, FONTS_CACHE));
    return;
  }

  if(url.hostname === HOST_QURAN_COM){
    event.respondWith(networkFirst(req, TEXT_CACHE, TEXT_CACHE_MAX));
    return;
  }

  if(url.hostname === HOST_ALQURAN){
    event.respondWith(networkFirst(req, TEXT_CACHE, TEXT_CACHE_MAX));
    return;
  }

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

/* ------------------------------------------------------------
   AYAH AUDIO  —  cache-first from qc-audio, network otherwise.
   ------------------------------------------------------------
   Downloaded ayahs live under their everyayah.com URL. When the
   device is offline the cached copy is returned; when it is
   online but the ayah has not been downloaded, the request is
   passed straight through to the network WITHOUT being stored
   (so streaming never inflates the download cache).
   ------------------------------------------------------------ */
async function audioFromDownloadCache(req){
  try{
    const cache = await caches.open(AUDIO_CACHE);
    const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
    if(hit){
      /* Range requests: hand back the full cached body so the
         media element can still play it offline. */
      return hit;
    }
  }catch(_){}

  try{
    return await fetch(req);
  }catch(err){
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }
}

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

async function manifestFresh(req){
  const cache = await caches.open(SHELL_CACHE);
  try{
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
    const res = await fetch(req, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    if(res && res.ok){
      const clone = res.clone();
      cache.put('./manifest.json', clone).catch(() => {});
      return res;
    }
    throw new Error('bad response');
  }catch(_){
    const hit =
      await cache.match('./manifest.json', { ignoreSearch: true }) ||
      await cache.match(req,                 { ignoreSearch: true });
    if(hit) return hit;
    return new Response(
      JSON.stringify({
        name: 'Quran Recitation Coach',
        short_name: 'Recite',
        start_url: './',
        display: 'standalone',
        background_color: '#0d1119',
        theme_color: '#0d1119',
        icons: []
      }),
      { status: 200, headers: { 'Content-Type': 'application/manifest+json' } }
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