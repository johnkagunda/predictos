const CACHE = 'betika-v1';
const PRECACHE = ['/', '/probets.html', '/manifest.json'];

// ── Install: cache shell ──────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

// ── Activate: clean old caches ────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for API, cache-first for shell ───────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) {
    // always network for API
    e.respondWith(fetch(e.request).catch(() => new Response('{"ok":false,"error":"offline"}', {
      headers: { 'Content-Type': 'application/json' }
    })));
    return;
  }
  // cache-first for static
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Push: show notification ───────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch (_) { data = { title: '🎯 Pro Bet Alert', body: e.data?.text() || '' }; }

  const options = {
    body:    data.body  || '',
    icon:    '/icon-192.png',
    badge:   '/icon-192.png',
    vibrate: [200, 100, 200],
    tag:     `probet-${data.match_id || Date.now()}`,
    renotify: true,
    data:    { url: data.url || '/probets.html' },
    actions: [
      { action: 'view', title: '📊 View Match' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  e.waitUntil(self.registration.showNotification(data.title || '🎯 Pro Bet Alert', options));
});

// ── Notification click ────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;

  const target = e.notification.data?.url || '/probets.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(target) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
