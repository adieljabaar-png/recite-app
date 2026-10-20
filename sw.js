/* ============================================================
   Quran Recitation Coach — Service Worker
   ============================================================
   v27 — Bumps the shell cache so the new index.html replaces
         the v26 shell on the next install event.
         Changes delivered in this version:
           • Tajweed fullscreen now shows a floating minimise
             button (⤡) in the top-right corner so the user can
             always exit fullscreen.
           • Hifz "Reveal on Mistake" mode now ignores pure
             pause / waqf marks (they are shown immediately and
             never used as speech match targets), which stops the
             recognizer from stalling between words / ayahs.
           • Home tiles (Surah index, Juz index, Play audio,
             Bookmarks) are reduced in height so the rest of the
             page sits higher on the screen.
           • Golden borders are applied around every tab / card /
             list row across all screens.
         All existing v26 functionality is kept.
   ============================================================ */

'use strict';

const VERSION = 'v27';

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

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL_URLS.map(async url => {
      try{
        const req = new Request(url, { cache: 'reload' });
        const res = await fetch(req);
        if(res && (res.ok || res.type === 'opaque')) await cache.put(url, res.clone());
      }catch(_){}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const toDelete = keys.filter(name => {
      if(VERSIONED_CACHES.includes(name)) return false;
      if(PERSISTENT_CACHES.includes(name)) return false;
      const owned = OWNED_PREFIXES.some(p => name.startsWith(p));
      if(!owned) return false;
      return true;
    });
    await Promise.all(toDelete.map(name => caches.delete(name)));
    if(self.registration && self.registration.navigationPreload){
      try{ await self.registration.navigationPreload.disable(); }catch(_){}
    }
    await self.clients.claim();
  })());
});

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
        await Promise.all([cache.delete('./manifest.json', { ignoreSearch: true }), cache.delete('./index.html', { ignoreSearch: true }), cache.delete('./', { ignoreSearch: true })]);
      }catch(_){}
      if(event.source && event.source.postMessage) event.source.postMessage({ type: 'MANIFEST_REFRESHED' });
    })());
    return;
  }
});

self.addEventListener('push', event => {
  let data = { title: 'Quran Recitation Coach', body: 'You have a new message.', url: './' };
  try{ if(event.data) data = Object.assign(data, event.data.json()); }catch(_){}
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: './icon-192.png', badge: './icon-192.png', tag: data.tag || 'qc-notification', renotify: true, data: { url: data.url } }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for(const c of list){ if(c.url.startsWith(self.location.origin) && 'focus' in c){ c.navigate(target); return c.focus(); } }
    if(clients.openWindow) return clients.openWindow(target);
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;
  let url;
  try{ url = new URL(req.url); }catch(_){ return; }
  if(url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if(url.hostname === HOST_EVERYAYAH){ event.respondWith(audioFromDownloadCache(req)); return; }
  if(url.origin === self.location.origin && url.pathname.startsWith('/my-analytics/')) return;
  if(url.hostname === HOST_GOOGLE_FONTS_CSS || url.hostname === HOST_GOOGLE_FONTS_STATIC){ event.respondWith(cacheFirst(req, FONTS_CACHE)); return; }
  if(url.hostname === HOST_QURAN_COM){ event.respondWith(networkFirst(req, TEXT_CACHE, TEXT_CACHE_MAX)); return; }
  if(url.hostname === HOST_ALQURAN){ event.respondWith(networkFirst(req, TEXT_CACHE, TEXT_CACHE_MAX)); return; }
  if(url.origin === self.location.origin){
    if(url.pathname.endsWith('/manifest.json')){ event.respondWith(manifestFresh(req)); return; }
    if(req.mode === 'navigate'){ event.respondWith(shellNavigation(req)); return; }
    event.respondWith(cacheFirst(req, RUNTIME_CACHE, RUNTIME_MAX));
    return;
  }
});

async function audioFromDownloadCache(req){
  try{
    const cache = await caches.open(AUDIO_CACHE);
    const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
    if(hit) return hit;
  }catch(_){}
  try{ return await fetch(req); }
  catch(err){ return new Response('', { status: 504, statusText: 'Gateway Timeout' }); }
}

async function cacheFirst(req, cacheName, maxEntries){
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: false });
  if(hit) return hit;
  try{
    const res = await fetch(req);
    if(res && (res.ok || res.type === 'opaque')){
      const clone = res.clone();
      cache.put(req, clone).then(() => { if(maxEntries) trimCache(cacheName, maxEntries); }).catch(() => {});
    }
    return res;
  }catch(err){ return new Response('', { status: 504, statusText: 'Gateway Timeout' }); }
}

async function networkFirst(req, cacheName, maxEntries){
  const cache = await caches.open(cacheName);
  try{
    const res = await fetch(req);
    if(res && res.ok){
      const clone = res.clone();
      cache.put(req, clone).then(() => { if(maxEntries) trimCache(cacheName, maxEntries); }).catch(() => {});
    }
    return res;
  }catch(err){
    const hit = await cache.match(req, { ignoreSearch: false });
    if(hit) return hit;
    return new Response(JSON.stringify({ code: 503, status: 'OFFLINE', data: null }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

async function manifestFresh(req){
  const cache = await caches.open(SHELL_CACHE);
  try{
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
    const res = await fetch(req, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    if(res && res.ok){ const clone = res.clone(); cache.put('./manifest.json', clone).catch(() => {}); return res; }
    throw new Error('bad response');
  }catch(_){
    const hit = await cache.match('./manifest.json', { ignoreSearch: true }) || await cache.match(req, { ignoreSearch: true });
    if(hit) return hit;
    return new Response(JSON.stringify({ name: 'Quran Recitation Coach', short_name: 'Recite', start_url: './', display: 'standalone', background_color: '#0d1119', theme_color: '#0d1119', icons: [] }), { status: 200, headers: { 'Content-Type': 'application/manifest+json' } });
  }
}

async function shellNavigation(req){
  const cache = await caches.open(SHELL_CACHE);
  try{
    const res = await fetch(req);
    if(res && res.ok && res.type === 'basic'){ const clone = res.clone(); cache.put('./index.html', clone).catch(() => {}); }
    return res;
  }catch(err){
    const hit = await cache.match(req, { ignoreSearch: true }) || await cache.match('./index.html', { ignoreSearch: true }) || await cache.match('./', { ignoreSearch: true });
    if(hit) return hit;
    return new Response('<!doctype html><meta charset="utf-8"><title>Offline</title><body style="font-family:sans-serif;padding:2rem;text-align:center;background:#0d1119;color:#e8edf7"><h2>You are offline</h2><p>Open the app once while online to enable offline mode.</p>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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