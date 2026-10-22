// アプリから呼ばれる通知API：ログイン本人の確認 → 本当にその出来事が起きたか確認 → 全員へ送信
const { init, admin, sendAll } = require('./_lib');

const RECENT_MS = 5 * 60 * 1000;
const cut = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  try {
    init();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ error: 'unauthorized' });
    const user = await admin.auth().verifyIdToken(m[1]);
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { type } = body;
    const fs = admin.firestore();

    // 掲示板・お手伝い募集・アンケート：本人が作った直後のものだけ通知する
    const COLS = { post: 'board_posts', help: 'helper_calls', poll: 'polls' };
    if (COLS[type]) {
      const snap = await fs.collection(COLS[type]).doc(String(body.id || '')).get();
      if (!snap.exists) return res.status(404).json({ error: 'not found' });
      const d = snap.data();
      if (d.uid !== user.uid) return res.status(403).json({ error: 'forbidden' });
      const created = d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : 0;
      if (Date.now() - created > RECENT_MS) return res.status(400).json({ error: 'too old' });

      const who = cut(d.name, 20) || 'メンバー';
      let title, text, link;
      if (type === 'post') {
        title = '📝 掲示板に新しい投稿';
        text = who + 'さん：' + (cut(d.title, 40) || cut(d.body, 40));
        link = '/board.html';
      } else if (type === 'help') {
        title = '🙋 お手伝い募集';
        text = cut(d.title, 40) + (d.date ? '（' + cut(d.date, 20) + '）' : '') + ' / ' + who + 'さん';
        link = '/board.html#help';
      } else {
        title = '📊 新しいアンケート';
        text = cut(d.title, 50) + ' / ' + who + 'さん';
        link = '/board.html#poll';
      }
      const r = await sendAll({ title, body: text, link, key: type + '_' + snap.id, excludeUid: user.uid });
      return res.status(200).json(r);
    }

    // 大会の中止：実際に中止になっている大会だけ通知する
    if (type === 'cancel') {
      const year = String(body.year || '');
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 10).map(String) : [];
      const snap = await fs.collection('apps').doc('kyudoTournament').get();
      if (!snap.exists) return res.status(404).json({ error: 'no data' });
      let years;
      try { years = JSON.parse(snap.data().data); } catch (e) { return res.status(500).json({ error: 'bad data' }); }
      const y = years && years[year];
      if (!y || !Array.isArray(y.tournaments)) return res.status(404).json({ error: 'no year' });
      let sent = 0;
      for (const t of y.tournaments) {
        if (!ids.includes(String(t.id)) || t.isCanceled !== true) continue;
        const r = await sendAll({
          title: '⚠️ 大会が中止になりました',
          body: cut(year, 12) + ' ' + cut(t.name, 40) + (t.date ? '（' + cut(t.date, 12) + '）' : ''),
          link: '/index.html',
          key: 'cancel_' + year + '_' + t.id,
          excludeUid: user.uid
        });
        sent += r.sent || 0;
      }
      return res.status(200).json({ sent });
    }

    return res.status(400).json({ error: 'unknown type' });
  } catch (e) {
    console.error('notify failed', e);
    return res.status(500).json({ error: 'internal error' });
  }
};
