const CACHE = 'samy-nails-v4';
const CACHE_PREFIX = 'samy-nails-';
const APP_FILES = ['./', './index.html', './app.js', './admin-manual-booking.js', './admin-push.js', './manifest.json', './assets/logo-app.png', './assets/samy-logo.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.endsWith('/supabase-config.js') || url.pathname.endsWith('/push-config.js')) return;

  const isAppShell = request.mode === 'navigate' || /\/(index\.html|app\.js|admin-manual-booking\.js|admin-push\.js|sw\.js|manifest\.json)$/.test(url.pathname);
  if (isAppShell) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        const cached = await caches.match(request);
        return cached || caches.match('./index.html');
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});

self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data?.text() || '' };
  }
  const title = payload.title || 'Novedad de Samy Nails';
  const options = {
    body: payload.body || payload.message || 'Tenés una notificación nueva en Samy Nails.',
    icon: './assets/logo-app.png',
    badge: './assets/logo-app.png',
    tag: payload.tag || payload.id || undefined,
    data: payload.data || { url: '/' },
    renotify: false,
    // Web Notifications do not expose a custom sound API. false permits the
    // browser/OS default alert sound when the platform and user settings allow it.
    silent: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        if ('navigate' in client && client.url !== target) await client.navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
