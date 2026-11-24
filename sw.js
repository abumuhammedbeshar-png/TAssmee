/* عامل الخدمة: يجعل التطبيق يعمل دون اتصال بعد أول فتح */
const VERSION = 'tasmee-v6';
const SHELL = [
  './', 'index.html', 'config.js', 'css/style.css', 'js/matcher.js', 'js/pdftext.js', 'js/asr.js', 'js/asr-worker.js', 'js/cloud.js', 'js/app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const RUNTIME = 'tasmee-runtime';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // نص المصحف يُحفظ في IndexedDB، والتلاوات تُبثّ مباشرةً
  if (url.hostname === 'api.alquran.cloud' || url.hostname === 'cdn.islamic.network') return;
  const sameOrigin = url.origin === self.location.origin;
  const cacheable = sameOrigin || /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname) || url.hostname === 'cdn.jsdelivr.net' || (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/'));
  if (!cacheable) return;

  // ملف الإعدادات: من الشبكة أولاً كي يظهر أثر تعديله فوراً
  if (sameOrigin && url.pathname.endsWith('/config.js')) {
    e.respondWith(fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; }).catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }

  // الأحدث أولاً مع الرجوع للنسخة المحفوظة (stale-while-revalidate)
  e.respondWith((async () => {
    const cache = await caches.open(sameOrigin && !url.pathname.includes('/lib/') ? VERSION : RUNTIME);
    const hit = await cache.match(req, { ignoreSearch: sameOrigin });
    const net = fetch(req).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const res = await net;
    if (res) return res;
    if (req.mode === 'navigate') return (await caches.match('index.html')) || Response.error();
    return Response.error();
  })());
});
