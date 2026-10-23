// アプリから呼ばれる通知API：ログイン本人の確認 → 本当にその出来事が起きたか確認 → 送信
// 通知の文面は、クライアントの送った文字ではなく、Firestoreの実際のデータから作る（偽の通知を防ぐ）
const { init, admin, sendAll, normName } = require('./_lib');

const RECENT_MS = 5 * 60 * 1000;
const RL_MAX = 40;              // 1人あたり、10分間に受け付ける回数
const RL_WINDOW_MS = 10 * 60 * 1000;
const cut = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const bucket = () => Math.floor(Date.now() / (10 * 60 * 1000)); // 10分ごとに同じ出来事の再通知を許可

async function rateLimit(fs, uid) {
  const ref = fs.collection('notify_rl').doc(uid);
  return fs.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    let { n = 0, start = now } = snap.exists ? snap.data() : {};
    if (now - start > RL_WINDOW_MS) { n = 0; start = now; }
    if (n >= RL_MAX) return false;
    tx.set(ref, { n: n + 1, start });
    return true;
  });
}

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
    if (!(await rateLimit(fs, user.uid))) return res.status(429).json({ error: 'too many requests' });

    // ---- 掲示板・お手伝い募集・アンケート：本人が作った直後のものだけ通知 ----
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
      return res.status(200).json(await sendAll({ title, body: text, link, key: type + '_' + snap.id, excludeUid: user.uid }));
    }

    // ---- お手伝い募集に参加表明があった → 募集した人へ ----
    if (type === 'helpjoin') {
      const snap = await fs.collection('helper_calls').doc(String(body.id || '')).get();
      if (!snap.exists) return res.status(404).json({ error: 'not found' });
      const d = snap.data();
      const vols = d.volunteers || [];
      const me = vols.find(v => v && v.uid === user.uid);
      if (!me) return res.status(403).json({ error: 'not a volunteer' });
      if (!d.uid || d.uid === user.uid) return res.status(200).json({ sent: 0 });
      const full = d.need && vols.length >= d.need;
      return res.status(200).json(await sendAll({
        title: '🙋 お手伝いに参加表明がありました',
        body: cut(d.title, 40) + ' / ' + cut(me.name, 20) + 'さん（' + vols.length + (d.need ? '/' + d.need : '') + '名）' + (full ? ' 募集人数に達しました' : ''),
        link: '/board.html#help', key: 'hj_' + snap.id + '_' + user.uid, onlyUids: [d.uid]
      }));
    }

    // ---- アンケートに回答があった → 作成した人へ（誰が回答したかは伝えない）----
    if (type === 'pollvote') {
      const snap = await fs.collection('polls').doc(String(body.id || '')).get();
      if (!snap.exists) return res.status(404).json({ error: 'not found' });
      const d = snap.data();
      if (!(d.voters || []).includes(user.uid)) return res.status(403).json({ error: 'not a voter' });
      if (!d.uid || d.uid === user.uid) return res.status(200).json({ sent: 0 });
      return res.status(200).json(await sendAll({
        title: '📊 アンケートに回答がありました',
        body: cut(d.title, 50) + '（' + (d.voters || []).length + '人が回答）',
        link: '/board.html#poll', key: 'pv_' + snap.id + '_' + user.uid, onlyUids: [d.uid]
      }));
    }

    // ---- 参加表の更新：新年度・大会の追加/変更/中止/再開・参加者の登録・集金の確認 ----
    if (type === 'sheet') {
      const events = Array.isArray(body.events) ? body.events.slice(0, 30) : [];
      const snap = await fs.collection('apps').doc('kyudoTournament').get();
      if (!snap.exists) return res.status(404).json({ error: 'no data' });
      let years;
      try { years = JSON.parse(snap.data().data); } catch (e) { return res.status(500).json({ error: 'bad data' }); }

      const groups = { year: [], tAdded: [], tChanged: [], canceled: [], resumed: [], member: [] };
      const paid = [];          // 個別に送る（本人あて）
      let yearName = '';
      for (const ev of events) {
        const y = years[String(ev.year || '')];
        if (!y) continue;
        const yn = String(ev.year);
        const t = (y.tournaments || []).find(x => String(x.id) === String(ev.id));
        const mem = (y.members || []).find(x => String(x.id) === String(ev.id));
        if (ev.k === 'year') { groups.year.push(yn); }
        else if (ev.k === 'tAdded' && t) groups.tAdded.push({ yn, t });
        else if (ev.k === 'tChanged' && t && !t.isCanceled) groups.tChanged.push({ yn, t });
        else if (ev.k === 'canceled' && t && t.isCanceled === true) groups.canceled.push({ yn, t });
        else if (ev.k === 'resumed' && t && t.isCanceled !== true) groups.resumed.push({ yn, t });
        else if (ev.k === 'member' && mem && !mem.isExample) groups.member.push({ yn, mem });
        else if (ev.k === 'paid' && mem && !mem.isExample) {
          const tt = (y.tournaments || []).find(x => String(x.id) === String(ev.tid));
          if (tt && !tt.isCanceled && mem.records && mem.records[tt.id] === 'paid') paid.push({ yn, mem, tt });
        }
        yearName = yearName || yn;
      }

      const b = bucket();
      const idKey = (list, f) => list.map(f).sort().join(',').slice(0, 300);
      const tInfo = (t) => cut(t.name, 24) + (t.date ? '（' + cut(t.date, 10) + '）' : '');
      let sent = 0;
      const push = async (o) => { const r = await sendAll({ link: '/index.html', excludeUid: user.uid, ...o }); sent += r.sent || 0; };

      if (groups.year.length) await push({ title: '📅 新年度が作成されました', body: groups.year.join('、'), key: 'year_' + idKey(groups.year, x => x) });
      if (groups.tAdded.length) await push({ title: '🆕 大会が追加されました', body: groups.tAdded.map(x => tInfo(x.t)).join('、'), key: 'tadd_' + b + '_' + idKey(groups.tAdded, x => x.yn + x.t.id) });
      if (groups.tChanged.length) await push({
        title: '✏️ 大会の情報が更新されました',
        body: groups.tChanged.map(x => cut(x.t.name, 24) + '（開催 ' + (cut(x.t.date, 10) || '未定') + ' / 締切 ' + (cut(x.t.deadline, 10) || '未定') + ' / ¥' + (x.t.fee || 0) + '）').join('、'),
        key: 'tchg_' + b + '_' + idKey(groups.tChanged, x => x.yn + x.t.id + '|' + x.t.name + x.t.date + x.t.deadline + x.t.fee)
      });
      if (groups.canceled.length) await push({ title: '⚠️ 大会が中止になりました', body: groups.canceled.map(x => tInfo(x.t)).join('、'), key: 'cancel_' + b + '_' + idKey(groups.canceled, x => x.yn + x.t.id) });
      if (groups.resumed.length) await push({ title: '✅ 大会の中止が取り消されました', body: groups.resumed.map(x => tInfo(x.t)).join('、') + ' は開催になります', key: 'resume_' + b + '_' + idKey(groups.resumed, x => x.yn + x.t.id) });
      if (groups.member.length) await push({ title: '👤 参加表が更新されました', body: groups.member.map(x => cut(x.mem.name, 20) + 'さん').join('、') + ' が登録されました', key: 'member_' + b + '_' + idKey(groups.member, x => x.yn + x.mem.id) });

      // 集金の確認：その名前の本人にだけ送る（名前 → アカウントは users/{uid}.name で対応づけ）
      if (paid.length) {
        const users = await fs.collection('users').get();
        const byName = {};
        users.forEach(u => { const n = normName(u.data().name); if (n) (byName[n] = byName[n] || []).push(u.id); });
        for (const p of paid) {
          const uids = byName[normName(p.mem.name)];
          if (!uids) continue;
          await push({
            title: '💴 参加費の受領を確認しました',
            body: cut(p.tt.name, 30) + '（' + cut(p.yn, 12) + '）',
            key: 'paid_' + p.yn + '_' + p.mem.id + '_' + p.tt.id,
            onlyUids: uids
          });
        }
      }
      return res.status(200).json({ sent });
    }

    return res.status(400).json({ error: 'unknown type' });
  } catch (e) {
    console.error('notify failed', e);
    return res.status(500).json({ error: 'internal error' });
  }
};