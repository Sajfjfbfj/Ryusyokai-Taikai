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
      // 1) 開いている画面に「このページへ移動して」と直接伝える（スマホのバックグラウンドでも確実に動く）
      try { target.postMessage({ type: 'goto', url }); } catch (e) { /* ignore */ }
      // 2) 画面を前に出す
      let focused = null;
      try { focused = await withTimeout(target.focus(), 3000); } catch (e) { /* 下で開き直す */ }
      if (focused) {
        // 3) 念のため、こちらからも移動を試みる（画面側の移動と同じ行き先なので重複しても問題ない）
        try { if (focused.url !== url) await withTimeout(focused.navigate(url), 2000); } catch (e) { /* ignore */ }
        return;
      }
    }
    try { await self.clients.openWindow(url); } catch (e) { /* ignore */ }
  })());
});