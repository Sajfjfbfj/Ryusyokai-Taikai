// 一般メンバーの操作を、サーバー側で安全に参加表（apps/kyudoTournament）へ反映する API。
//  ・参加表の書き込みは管理者だけに制限したので、一般メンバーの操作はここ経由になる
//  ・できること：名簿に自分を追加／改名（register）、自分の参加・不参加の切り替え（set）、退会時の名簿削除（leave）
//  ・できないこと：○済（集金済み）にする／他人の行を変える／大会・年度の編集
// firebase-admin の初期化は notify.js と同じ ./_lib を使う
const { init, admin } = require('./_lib');
const FieldValue = () => admin.firestore.FieldValue;

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

const normName = (n) => String(n || '').normalize('NFKC').replace(/\s+/g, '');
const isExampleName = (name) => /^[（(]例[）)]/.test(normName(name)) ||
  ['龍翔太郎', '弓道花子', '的中次郎'].includes(normName(name).replace(/^[（(]例[）)]/, ''));
const MEMBER_STATUS = ['none', 'attending', 'absent'];   // 'paid'（集金済み）は含めない

function cleanName(v) {
  const n = String(v == null ? '' : v).trim().slice(0, 30);
  if (!normName(n)) throw new HttpError(400, 'bad-name', '名前を入力してください。');
  if (isExampleName(n)) throw new HttpError(400, 'bad-name', 'この名前は使えません。');
  return n;
}

function pickYear(years, key) {
  const k = String(key == null ? '' : key);
  const y = Object.prototype.hasOwnProperty.call(years, k) ? years[k] : null;
  if (!y || !Array.isArray(y.members) || !Array.isArray(y.tournaments)) throw new HttpError(404, 'no-year', '年度が見つかりません。');
  return y;
}

function newId() { return 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

// 戻り値：{ write: boolean, updatedBy?: string }
function apply(action, user, b, years, myName, doc, result) {
  if (action === 'register') {
    const y = pickYear(years, b.year);
    const newName = cleanName(b.newName);
    const key = normName(newName);
    const same = y.members.find(x => x && normName(x.name) === key);
    if (same) {
      if (same.uid && same.uid !== user.uid) throw new HttpError(409, 'name-taken', 'この名前は、すでに別のアカウントで使われています。');
      result.id = same.id;
      if (same.uid === user.uid) return { write: false };
      same.uid = user.uid;                 // 初めて名乗ったアカウントに結びつける
      return { write: true };
    }
    const old = b.oldName ? normName(b.oldName) : '';
    const target = y.members.find(x => x && x.uid === user.uid) ||
      (old ? y.members.find(x => x && normName(x.name) === old && !x.uid) : null);
    if (target) { target.name = newName; target.uid = user.uid; result.id = target.id; return { write: true }; }
    if (b.addIfMissing === true) {
      const m = { id: newId(), name: newName, records: {}, uid: user.uid };
      y.members.push(m);
      result.id = m.id; result.created = true;
      return { write: true };
    }
    return { write: false };
  }

  if (action === 'set') {
    const y = pickYear(years, b.year);
    const status = String(b.status);
    if (!MEMBER_STATUS.includes(status)) throw new HttpError(400, 'bad-status', 'この状態には変更できません。');
    const tid = String(b.tid);
    const t = y.tournaments.find(x => x && x.id === tid);
    if (!t) throw new HttpError(404, 'no-tournament', '大会が見つかりません。');
    if (t.isCanceled) throw new HttpError(409, 'canceled', 'この大会は中止になっています。');
    let m = y.members.find(x => x && x.uid === user.uid);
    let bound = false;
    if (!m && myName) {
      m = y.members.find(x => x && !x.uid && normName(x.name) === normName(myName));
      if (m) { m.uid = user.uid; bound = true; }
    }
    if (!m) throw new HttpError(404, 'not-registered', '参加表に自分の名前がありません。');
    if (!m.records || typeof m.records !== 'object') m.records = {};
    const cur = m.records[tid] || 'none';
    if (cur === 'paid') throw new HttpError(409, 'paid-locked', '集金済みのため変更できません。');
    if (cur === status) return { write: bound };
    m.records[tid] = status;
    return { write: true };
  }

  // leave（退会）
  let removed = 0;
  if (b.remove === true) {
    const key = normName(b.name || myName);
    Object.keys(years).forEach(yk => {
      const y = years[yk];
      if (!y || !Array.isArray(y.members)) return;
      const before = y.members.length;
      y.members = y.members.filter(m => !(m && (m.uid === user.uid || (!m.uid && key && normName(m.name) === key))));
      removed += before - y.members.length;
    });
  }
  result.removed = removed;
  const clearEmail = !!doc.updatedBy && !!user.email && doc.updatedBy === user.email;
  if (!removed && !clearEmail) return { write: false };
  return { write: true, updatedBy: clearEmail ? '' : (doc.updatedBy || '') };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method', message: 'POSTで呼び出してください。' });
  try {
    init();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) throw new HttpError(401, 'unauthorized', 'ログインが必要です。');
    let user;
    try { user = await admin.auth().verifyIdToken(m[1]); }
    catch (e) { throw new HttpError(401, 'unauthorized', 'ログインの有効期限が切れました。再読み込みしてください。'); }

    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b && typeof b === 'object' ? b : {};
    const action = String(b.action || '');
    if (!['register', 'set', 'leave'].includes(action)) throw new HttpError(400, 'bad-action', '不正な操作です。');

    const db = admin.firestore();
    const ref = db.doc('apps/kyudoTournament');
    const userRef = db.doc('users/' + user.uid);
    const us = await userRef.get();
    const myName = us.exists ? String(us.data().name || '').trim() : '';

    const result = {};
    await db.runTransaction(async (tx) => {
      for (const k of Object.keys(result)) delete result[k];   // 再試行に備えて初期化
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpError(404, 'no-data', '参加表のデータがありません。');
      const d = snap.data();
      let years;
      try { years = JSON.parse(d.data); } catch (e) { throw new HttpError(500, 'bad-data', 'データを読み込めません。'); }
      const r = apply(action, user, b, years, myName, d, result);
      if (!r.write) return;
      tx.set(ref, {
        data: JSON.stringify(years),
        updatedAt: FieldValue().serverTimestamp(),
        updatedBy: r.updatedBy !== undefined ? r.updatedBy : (user.email || '')
      });
    });

    if (action === 'register' && b.newName) {
      await userRef.set({ name: cleanName(b.newName), updatedAt: FieldValue().serverTimestamp() }, { merge: true }).catch(() => {});
    }
    return res.status(200).json(Object.assign({ ok: true }, result));
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('member api failed', e);
    return res.status(status).json({
      error: e.code || 'server',
      message: status === 500 ? '保存できませんでした。時間をおいてもう一度お試しください。' : e.message
    });
  }
};