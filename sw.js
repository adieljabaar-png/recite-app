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

   ═════════════════════════════════════════════════════════════
   ⚠️  PRAYER TIME SETTINGS ARE NEVER TOUCHED BY THIS FILE
   ═════════════════════════════════════════════════════════════
   Prayer time adjustments, chosen calculation method, Asr
   school, per-prayer ±minute offsets, alarm toggles and alarm
   sound preference are all stored by the page in
   `localStorage` under the key  `qc.prayer`.

   A Service Worker has no access to `localStorage` — it runs in
   a completely separate global scope.  Nothing in this file
   reads, writes, clears or resets any `localStorage` key, and
   nothing in this file can.  Cache Storage (what this file
   manages) and `localStorage` (what prayer settings live in)
   are two entirely independent storage systems.

   Therefore:
     • Bumping VERSION below and deleting old caches on
       `activate` does NOT reset prayer time adjustments.
     • Clearing runtime caches via the `CLEAR_CACHES` message
       does NOT reset prayer time adjustments.
     • The `REFRESH_MANIFEST` message that wipes the shell cache
       does NOT reset prayer time adjustments.
     • Re-installing the service worker does NOT reset prayer
       time adjustments.
     • The only code path in the whole app that resets prayer
       settings is the “Reset app” button in the About dialog
       (index.html → `localStorage.clear()`), which is a
       deliberate, user-initiated action.

   ═════════════════════════════════════════════════════════════
   CACHE VERSION — bumped whenever the shell changes.  That is
   what forces visitors to see the new HTML after a deploy.
   ═════════════════════════════════════════════════════════════

   v19 — Shell refreshed for the new app icon.
         • index.html now uses a new inline SVG icon: an open
           golden book inside a black rounded square.  The old
           blue-open-book, the wooden rehl (Qur'an stand) and
           the golden microphone have all been removed.
         • The same SVG is used for <link rel="icon"> and
           <link rel="apple-touch-icon">.  No new files are
           fetched — the icon is still a single inline data-URI,
           so the shell size is unchanged apart from the icon
           markup itself.
         • Nothing changed in the caching strategy, routing,
           cache names, or trim budgets.  The bump exists purely
           so clients pick up the new shell and redraw the tab /
           home-screen icon.
         • PRAYER TIME SAFETY: as with every previous bump, this
           version change only rotates Cache Storage.  It does
           NOT touch `localStorage`, and therefore it does NOT
           reset any user's prayer time adjustments, offsets,
           alarms, method, Asr school or sound choice.  See the
           block above for the full explanation.

   v18 — Shell refreshed for the previous index.html.
         • Verified against the shipped index.html — every
           external host the page touches is accounted for:
             – api.quran.com/v4   → network-first  (IndoPak
               mushaf text, page/surah/juz reads, Yusuf Ali
               translation id 203).
             – api.alquran.cloud  → network-first  (coach
               Uthmani text, page reads, Yusuf Ali
               en.yusufali translation, chapter list).
             – fonts.googleapis.com / fonts.gstatic.com
                                  → cache-first  (Amiri,
               Amiri Quran, Scheherazade New, Noto Naskh).
             – everyayah.com      → passthrough   (iOS Range
               handshake for <audio>).
             – cdn.islamic.network + islamcan.com
                                  → passthrough   (Athaan MP3s
               used by the Prayer Times alarm).
             – api.bigdatacloud.net
                                  → passthrough   (reverse
               geocode for GPS button).
             – geocoding-api.open-meteo.com
                                  → passthrough   (city search).
             – /my-analytics/*    → passthrough   (Vercel
               Analytics rewrite must stay first-party).
             – /api/feedback      → passthrough   (POST, so
               the GET guard at the top already lets it
               through).
         • No routing, cache-name, or trim-budget changes
           versus v17.  The bump existed purely so clients
           picked up the new shell.

   v17 — Manifest freshness for icon updates.
         • manifest.json is served NETWORK-FIRST (with a
           2-second fallback to cache on failure) instead of
           cache-first.  Every time Chrome, the OS launcher, or
           a manifest re-read asks for the manifest, it gets the
           current version from the server — never a stale copy
           sitting in the SW runtime cache.
         • A new postMessage handler `REFRESH_MANIFEST` lets the
           page wipe the shell cache on demand, so the next PWA
           launch is guaranteed to fetch fresh HTML + fresh
           manifest.
         • IMPORTANT — what this does NOT and cannot do:
             – It cannot change the icon of an app that is
               already installed on the user's home screen. That
               icon is owned by the OS launcher (Android
               ShortcutManager) or springboard (iOS IconState),
               both outside the reach of any web API.
             – On iOS it has zero effect on an existing install:
               Safari never re-reads the apple-touch-icon after
               the shortcut has been created.  The only reliable
               iOS fix is: delete the shortcut → clear Safari
               website data for the domain → restart the device
               → re-add to Home Screen.
             – On Android it gives Chrome the best possible
               chance of picking up a new launcher icon the next
               time the installed PWA is launched, because
               Chrome now sees the newest manifest every time
               it asks.

   v16 — Shell updated: app icon refreshed (Qur'an on a rehl
         with a golden microphone — since replaced in v19).

   v15 — Shell updated: Prayer Times feature added.
         • New Home-screen tile “🕌 Prayer Times” linking to a
           full Prayer Times screen (#screenPrayer).
         • Settings modal (⚙️) with four tabs: Location, Adjust,
           Alarms, Qibla.
         • Astronomical prayer-time calculation (PrayTimes
           algorithm) runs entirely on-device — no prayer-time
           API is contacted, so no new runtime caching is needed.
         • Per-prayer alarm bells are toggled from the main list
           and from the Alarms pane; state persists in
           localStorage under key `qc.prayer`.
         • External assets used by this feature — the Open-Meteo
           geocoding API, the BigDataCloud reverse-geocode API,
           and the two Athaan MP3 hosts — are deliberately NOT
           intercepted by the SW.

   v14 — Shell updated:
         • Follow-mode matching tuned.
           – TOL_TABLE.balanced: 5- and 6-letter words now
             allow an edit-distance of 2 (previously 1).
           – Strict no longer short-circuits to letter-exact
             Levenshtein. It now falls through to the same
             phonetic-Levenshtein and 85 % prefix/suffix overlap
             checks as Balanced and Lenient.
           – CONF_FLOOR_TABLE.strict lowered from 0.55 to 0.50.
         • Tajweed continues to be hard-locked to Strict.

   v13 — Shell updated:
         • Reciter picker converted from a horizontal chip bar to
           a proper dropdown with a scrollable list of all 20 Qaris.
         • English translation switched to Yusuf Ali
           (alquran.cloud `en.yusufali` / quran.com v4 id 203).
         • Footnote markers stripped from every translation string
           before it is rendered.
         • Reciter roster expanded from 10 to 20 Qaris.

   v12 — Shell updated with a simplified speech keepalive.
         The recognizer now performs a silent stop()/restart every
         40 s while a session is active.

   v11 — Shell updated with a speech-recognition keepalive.
         Chrome/Chromium silently stop delivering Web Speech API
         results after ~60 s of continuous recognition.

   v10 — Version bumped so browsers pick up the shell after the
         vercel.json header/rewrite fix.
   ============================================================ */

'use strict';

const VERSION        = 'v19';                    /* ← bumped from v18 */
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

/* Manifest freshness window — how long the SW will tolerate
   serving a cached manifest when the network is slow.  Kept very
   short on purpose: icon updates must propagate fast. */
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
   ACTIVATE  —  drop old cache versions and take control.
   ------------------------------------------------------------
   NOTE: this only deletes Cache Storage entries whose names are
   not in ALL_CACHES.  It never touches `localStorage`, so a
   user's saved prayer time adjustments (`qc.prayer`) are
   completely unaffected by a version bump.
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
   MESSAGE  —  page → SW control channel.
   ------------------------------------------------------------
   None of these handlers touch `localStorage`.  Prayer time
   settings live in `localStorage` under `qc.prayer` and are
   therefore completely outside the reach of this file.
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
      /* Cache Storage only — `localStorage` is untouched, so
         prayer time adjustments survive this operation. */
      if(event.source && event.source.postMessage){
        event.source.postMessage({ type: 'CACHES_CLEARED' });
      }
    })());
    return;
  }
  /* Lets the page wipe the shell cache so the next launch
     re-downloads index.html and manifest.json from the server.
     This is the strongest thing a web page can do to nudge the
     OS launcher towards reading the newest manifest. It cannot
     redraw the icon of an install that already exists — see the
     v17 header note.
     It also cannot and does not touch `localStorage`, so prayer
     time adjustments are unaffected. */
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
        entirely.  DO NOT intercept.
        (Athaan MP3 hosts used by the Prayer Times alarms are
        different hostnames and simply fall through to the
        passthrough branch below — same reasoning applies.) */
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

  /* 4. Quran.com API v4 — the reader's primary source for the
        IndoPak text with the full Tajweed symbol set, and the
        primary source for the Yusuf Ali translation
        (numeric translation id 203).
        Network-first with cache fallback. */
  if(url.hostname === HOST_QURAN_COM){
    event.respondWith(networkFirst(req, TEXT_CACHE, TEXT_CACHE_MAX));
    return;
  }

  /* 5. alquran.cloud API — coach's Uthmani text, the Yusuf Ali
        translation (en.yusufali), and the reader's fallback
        edition.  Network-first. */
  if(url.hostname === HOST_ALQURAN){
    event.respondWith(networkFirst(req, TEXT_CACHE, TEXT_CACHE_MAX));
    return;
  }

  /* 6. Same-origin requests (the app shell). */
  if(url.origin === self.location.origin){

    /* 6a. manifest.json — ALWAYS network-first, very short
           fallback timeout.  When Chrome or the OS launcher asks
           for the manifest (e.g. the next time the installed PWA
           is launched), it must see the freshest bytes so the
           newest icon and metadata are on hand. */
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

  /* 7. Anything else — passthrough.
        This deliberately includes:
          • the Open-Meteo geocoding API used by the Prayer Times
            city search (geocoding-api.open-meteo.com),
          • the BigDataCloud reverse-geocode API used by the GPS
            button (api.bigdatacloud.net),
          • the Athaan MP3 hosts used by the Prayer Times alarms
            (cdn.islamic.network, islamcan.com),
          • the /api/feedback POST endpoint (never reaches here
            because the GET guard at the top returns first, but
            listed for completeness).
        These are left to the browser so location lookups stay
        fresh and <audio> Range requests are handled natively.
        None of this touches `localStorage`, so the user's
        prayer time adjustments are unaffected. */
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

/* ------------------------------------------------------------------
   manifestFresh — manifest.json is always read from the network.
   Only if the network is unreachable (or slower than
   MANIFEST_TIMEOUT_MS) do we fall back to a cached copy, so the
   PWA still launches offline. On every successful fetch the fresh
   copy replaces the cached one.

   This is what gives Chrome the best possible chance to notice a
   new launcher icon the next time the installed PWA is opened.
   It is a nudge, not a guarantee — see the v17 header note.
   ------------------------------------------------------------------ */
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
    /* No cache either — return an empty manifest so the browser
       doesn't 404 and the app can still boot. */
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