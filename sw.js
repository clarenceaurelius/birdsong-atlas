const CACHE = 'birdsong-atlas-4';
const SHELL = ['./','./index.html','./style.css','./app.mjs','./plot.mjs','./dsp.mjs','./dsp-worker.mjs',
  './model-worker.mjs','./manifest.webmanifest','./assets/icon.png','./assets/icon-large.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('birdsong-atlas-') && key!==CACHE)
    .map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method!=='GET' || new URL(event.request.url).origin!==location.origin) return;
  event.respondWith(fetch(event.request).catch(async()=>{
    const cache=await caches.open(CACHE);
    return await cache.match(event.request) || (event.request.mode==='navigate' && await cache.match('./')) || Response.error();
  }));
});
