// プッシュ通知を受け取って通知バーに表示する Service Worker（サイトの一番上の階層に置く）
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch (e) { /* ignore */ }
  const d = p.data || p.notification || p;
  event.waitUntil(self.registration.showNotification(d.title || '龍翔会ポータル', {
    body: d.body || '',
    icon: '/apple-touch-icon.png',
    data: { link: d.link || '/' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.link) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if ('focus' in c) { try { await c.navigate(url); } catch (e) { /* ignore */ } return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
