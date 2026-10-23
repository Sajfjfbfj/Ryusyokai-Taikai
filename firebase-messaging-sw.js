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
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = list.find(c => c.url.startsWith(self.location.origin));
    if (target) {
      // スマホでバックグラウンドにあった画面は、切り替えに失敗することがある。
      // 失敗したときは必ず新しく開き直す（何も起きないままにしない）。
      try {
        const focused = await withTimeout(target.focus(), 3000);
        const w = focused || target;
        if (w.url === url) return;                       // すでにそのページ
        await withTimeout(w.navigate(url), 3000);
        return;
      } catch (e) { /* 下で開き直す */ }
    }
    try { await self.clients.openWindow(url); } catch (e) { /* ignore */ }
  })());
});