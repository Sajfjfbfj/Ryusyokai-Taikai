// 通知送信の共通処理（Vercel Functions / firebase-admin）
const admin = require('firebase-admin');

function init() {
  if (admin.apps.length) return admin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  return admin;
}

const BAD_TOKEN = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'];

// 登録済みの全端末へ通知を送る。
//  key      : 同じ出来事を二重に通知しないための印（省略可）
//  excludeUid: 操作した本人には送らない
//  onlyUids : 指定した人だけに送る（省略すると全員）
async function sendAll({ title, body, link, key, excludeUid, onlyUids }) {
  init();
  const fs = admin.firestore();

  if (key) {
    try {
      await fs.collection('notify_log').doc(key).create({ at: admin.firestore.FieldValue.serverTimestamp() });
    } catch (e) {
      if (e && (e.code === 6 || e.code === 'already-exists')) return { skipped: true };
      throw e;
    }
  }

  const snap = await fs.collection('push_tokens').get();
  const docs = snap.docs.filter(d => {
    const u = d.data().uid;
    if (u === excludeUid) return false;
    return !onlyUids || onlyUids.includes(u);
  });
  const tokens = docs.map(d => d.id);
  let sent = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const res = await admin.messaging().sendEachForMulticast({
      tokens: chunk,
      data: { title: String(title).slice(0, 80), body: String(body).slice(0, 160), link: link || '/' },
      webpush: { headers: { Urgency: 'high', TTL: '86400' } }
    });
    const dead = [];
    res.responses.forEach((r, idx) => {
      if (r.success) sent++;
      else if (r.error && BAD_TOKEN.includes(r.error.code)) dead.push(chunk[idx]);
    });
    await Promise.allSettled(dead.map(t => fs.collection('push_tokens').doc(t).delete()));
  }
  return { sent };
}

// "6/10" や "６／１０" → { m: 6, d: 10 }
function parseMD(s) {
  const t = String(s || '').normalize('NFKC').trim();
  const m = /^(\d{1,2})\s*[\/月]\s*(\d{1,2})/.exec(t);
  return m ? { m: +m[1], d: +m[2] } : null;
}

// 最新の年度（令和N年度のNが最大）のデータを返す
function latestYear(years) {
  let best = null, bestN = -1;
  Object.keys(years || {}).forEach(name => {
    const mm = /令和\s*(\d+)/.exec(name.normalize('NFKC'));
    const n = mm ? +mm[1] : 0;
    if (n > bestN) { bestN = n; best = name; }
  });
  return best ? { name: best, data: years[best] } : null;
}

const normName = (n) => String(n || '').normalize('NFKC').replace(/\s+/g, '');

module.exports = { init, admin, sendAll, parseMD, latestYear, normName };