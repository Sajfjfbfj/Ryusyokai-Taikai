// 毎朝（日本時間9時）に実行：締切の3日前・当日の大会を全員へ通知
const { init, admin, sendAll, parseMD, latestYear } = require('./_lib');

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== 'Bearer ' + secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    init();
    const snap = await admin.firestore().collection('apps').doc('kyudoTournament').get();
    if (!snap.exists) return res.status(200).json({ sent: 0 });
    const years = JSON.parse(snap.data().data);
    const cur = latestYear(years);
    if (!cur || !Array.isArray(cur.data.tournaments)) return res.status(200).json({ sent: 0 });

    // 日本時間の「今日」
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const at = (k) => { const d = new Date(jst.getTime() + k * 86400000); return { m: d.getUTCMonth() + 1, d: d.getUTCDate() }; };
    const today = at(0), in3 = at(3);

    let sent = 0;
    for (const t of cur.data.tournaments) {
      if (t.isCanceled) continue;
      const dl = parseMD(t.deadline);
      if (!dl) continue;
      let when = null;
      if (dl.m === today.m && dl.d === today.d) when = '本日';
      else if (dl.m === in3.m && dl.d === in3.d) when = '3日後';
      if (!when) continue;
      const r = await sendAll({
        title: when === '本日' ? '⏰ 今日が申込締切です' : '⏰ 申込締切まであと3日',
        body: t.name + '（締切 ' + dl.m + '/' + dl.d + '）参加の登録はお済みですか？',
        link: '/index.html',
        key: 'deadline_' + cur.name + '_' + t.id + '_' + (when === '本日' ? 0 : 3)
      });
      sent += r.sent || 0;
    }
    return res.status(200).json({ sent });
  } catch (e) {
    console.error('cron failed', e);
    return res.status(500).json({ error: 'internal error' });
  }
};
