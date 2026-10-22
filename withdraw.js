// 退会（アカウント削除）— index.html / board.html / participants.html 共通
// 各ページの cloudWithdraw() から必要になったときだけ読み込まれます。
import { getAuth, deleteUser, reauthenticateWithCredential, reauthenticateWithPopup, EmailAuthProvider, GoogleAuthProvider }
  from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import { getFirestore, collection, query, where, getDocs, deleteDoc, updateDoc, arrayRemove, doc, runTransaction, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

const CONFIRM_WORD = '退会';
const NAME_KEY = 'ryusyokai_my_name';
const LOCAL_KEYS = [NAME_KEY, 'kyudo_cloud_linked', 'kyudo_tournament_app_v3', 'kyudo_tournament_app_v3_backup_before_cloud'];
const normName = (n) => String(n || '').normalize('NFKC').replace(/\s+/g, '');

// 登録している名前（この端末の表示名。無ければアカウントの表示名）
function myRegisteredName(user) {
  let n = '';
  try { n = (localStorage.getItem(NAME_KEY) || '').trim(); } catch (e) { /* ignore */ }
  return n || (user.displayName || '').trim();
}

// 共有の名簿（参加表）から、自分の名前のメンバーを全年度分削除する。
// 共有データに残る「最終更新者＝自分のメール」も消す。削除した件数を返す。
async function removeFromRoster(db, user, name) {
  const key = normName(name);
  const ref = doc(db, 'apps', 'kyudoTournament');
  let removed = 0;
  await runTransaction(db, async (tx) => {
    removed = 0;
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const d = snap.data();
    let years;
    try { years = JSON.parse(d.data); } catch (e) { return; }
    if (key) {
      Object.values(years || {}).forEach(y => {
        if (!y || !Array.isArray(y.members)) return;
        const before = y.members.length;
        y.members = y.members.filter(m => !(m && normName(m.name) === key));
        removed += before - y.members.length;
      });
    }
    const clearEmail = !!d.updatedBy && d.updatedBy === user.email;
    if (!removed && !clearEmail) return;
    tx.set(ref, {
      data: removed ? JSON.stringify(years) : d.data,
      updatedAt: serverTimestamp(),
      updatedBy: clearEmail ? '' : (d.updatedBy || '')
    });
  });
  return removed;
}
const RED = '#ED0006';

function errText(code) {
  switch (code) {
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials': return 'パスワードが違います。';
    case 'auth/too-many-requests': return '試行回数が多すぎます。しばらくしてからお試しください。';
    case 'auth/network-request-failed': return 'ネットワークに接続できません。';
    case 'auth/popup-blocked': return 'ポップアップがブロックされました。許可してもう一度お試しください。';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request': return 'Googleでの本人確認が完了しませんでした。もう一度お試しください。';
    case 'auth/operation-not-supported-in-this-environment': return 'このブラウザではGoogleでの本人確認を使えません。Chrome・Safariなど通常のブラウザで開いてください。';
    case 'auth/user-mismatch': return '別のGoogleアカウントが選択されました。ログイン中のアカウントを選んでください。';
    case 'auth/requires-recent-login': return '本人確認の有効期限が切れました。もう一度お試しください。';
    default: return '退会できませんでした（' + (code || 'unknown') + '）。';
  }
}

// 自分が作成したデータ・参加表明を削除（個々の失敗は無視して続行）
async function cleanupMyData(db, uid) {
  const jobs = [];
  for (const col of ['board_posts', 'helper_calls', 'polls']) {
    const snap = await getDocs(query(collection(db, col), where('uid', '==', uid)));
    snap.forEach(d => jobs.push(deleteDoc(d.ref)));
  }
  // 他の人の募集に出していた「参加表明」を取り消す
  const helps = await getDocs(collection(db, 'helper_calls'));
  helps.forEach(d => {
    const data = d.data();
    if (data.uid === uid) return; // 自分の募集は上で削除済み
    (data.volunteers || []).filter(v => v && v.uid === uid)
      .forEach(v => jobs.push(updateDoc(d.ref, { volunteers: arrayRemove(v) })));
  });
  const results = await Promise.allSettled(jobs);
  return results.filter(r => r.status === 'rejected').length;
}

export function openWithdraw(opts = {}) {
  const auth = getAuth();
  const user = auth.currentUser;
  if (!user) { alert('ログインしていません。'); return; }
  if (document.getElementById('withdrawOverlay')) return;

  const hasPassword = user.providerData.some(p => p.providerId === 'password');
  const hasGoogle = user.providerData.some(p => p.providerId === 'google.com');
  const rosterName = myRegisteredName(user);

  const ov = document.createElement('div');
  ov.id = 'withdrawOverlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px;font-family:"Noto Sans JP",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
  const inputCss = 'width:100%;box-sizing:border-box;padding:10px;border:1px solid #111;font:inherit;font-size:16px;margin-top:4px;';
  const labelCss = 'display:block;font-size:11px;font-weight:900;color:#767676;letter-spacing:.1em;margin-top:14px;';
  ov.innerHTML = `
    <div role="dialog" aria-modal="true" style="background:#fff;border:2px solid #111;max-width:440px;width:100%;max-height:92vh;overflow:auto;color:#111;">
      <div style="background:${RED};color:#fff;padding:12px 16px;font-weight:900;font-size:15px;letter-spacing:.04em;">退会（アカウント削除）</div>
      <div style="padding:16px;font-size:13px;line-height:1.7;">
        <p style="margin:0 0 8px;font-weight:900;color:${RED};">この操作は取り消せません。</p>
        <div style="font-weight:900;">削除されるもの</div>
        <ul style="margin:2px 0 10px;padding-left:20px;">
          <li>ログインアカウント（${esc(user.email || '')}）</li>
          <li>自分が投稿した掲示板・お手伝い募集・アンケート</li>
          ${rosterName ? `<li>名簿（参加表）に登録した自分の名前「${esc(rosterName)}」と、全年度の参加・集金の記録（下のチェックで残すこともできます）</li>` : ''}
          <li>他の募集への「参加表明」</li>
          <li>この端末に保存した表示名</li>
        </ul>
        <div style="font-weight:900;">削除されないもの</div>
        <ul style="margin:2px 0 0;padding-left:20px;">
          <li>アンケートの匿名の回答（誰の回答か分からない形で保存されています）</li>
        </ul>
        ${rosterName ? `<label style="display:flex;gap:8px;align-items:flex-start;margin-top:14px;font-size:12px;font-weight:700;cursor:pointer;">
          <input id="wdRoster" type="checkbox" checked style="margin-top:3px;width:16px;height:16px;">
          <span>名簿（参加表）から「${esc(rosterName)}」を削除する<br><span style="font-weight:400;color:#767676;">集金済みの記録も消えます。会計に必要な場合はチェックを外してください。</span></span></label>` : ''}
        ${hasPassword ? `<div id="wdPwBlock"><label style="${labelCss}">PASSWORD / 本人確認のためパスワードを入力
          <input id="wdPassword" type="password" autocomplete="current-password" style="${inputCss}"></label></div>` : ''}
        ${hasGoogle ? `<p id="wdGoogleNote" style="margin:14px 0 0;font-size:12px;color:#767676;">「退会する」を押すと、本人確認のためGoogleのログイン画面が開きます。ログイン中のGoogleアカウント（${esc(user.email || '')}）を選んでください。</p>` : ''}
        ${hasPassword && hasGoogle ? `<button id="wdSwitch" type="button" style="margin-top:8px;background:none;border:none;padding:0;font:inherit;font-size:12px;font-weight:700;color:#111;text-decoration:underline;cursor:pointer;"></button>` : ''}
        <label style="${labelCss}">確認のため「${CONFIRM_WORD}」と入力
          <input id="wdConfirm" type="text" autocomplete="off" style="${inputCss}"></label>
        <div id="wdError" style="color:${RED};font-weight:700;font-size:12px;min-height:18px;margin-top:10px;"></div>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button id="wdCancel" type="button" style="flex:1;padding:10px;background:#fff;color:#111;border:1px solid #111;font:inherit;font-size:13px;font-weight:900;cursor:pointer;">キャンセル</button>
          <button id="wdGo" type="button" disabled style="flex:1;padding:10px;background:${RED};color:#fff;border:1px solid ${RED};font:inherit;font-size:13px;font-weight:900;cursor:pointer;opacity:.4;">退会する</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const $ = (id) => ov.querySelector('#' + id);
  const goBtn = $('wdGo'), cancelBtn = $('wdCancel'), errEl = $('wdError');
  const confirmEl = $('wdConfirm'), pwEl = $('wdPassword');
  let busy = false;
  let method = hasPassword ? 'password' : 'google';
  const pwBlock = $('wdPwBlock'), gNote = $('wdGoogleNote'), swBtn = $('wdSwitch');
  const applyMethod = () => {
    if (pwBlock) pwBlock.style.display = method === 'password' ? '' : 'none';
    if (gNote) gNote.style.display = method === 'google' ? '' : 'none';
    if (swBtn) swBtn.textContent = method === 'password' ? 'Googleアカウントで本人確認する' : 'パスワードで本人確認する';
  };
  if (swBtn) swBtn.addEventListener('click', () => { method = method === 'password' ? 'google' : 'password'; errEl.textContent = ''; applyMethod(); refresh(); });

  const close = () => { if (!busy) ov.remove(); };
  const refresh = () => {
    const ok = confirmEl.value.trim() === CONFIRM_WORD && (method !== 'password' || (pwEl && pwEl.value.length > 0));
    goBtn.disabled = !ok || busy;
    goBtn.style.opacity = (ok && !busy) ? '1' : '.4';
  };
  confirmEl.addEventListener('input', refresh);
  if (pwEl) pwEl.addEventListener('input', refresh);
  cancelBtn.addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  document.addEventListener('keydown', function esc_(e) {
    if (!document.body.contains(ov)) { document.removeEventListener('keydown', esc_); return; }
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && !goBtn.disabled) goBtn.click();
  });

  goBtn.addEventListener('click', async () => {
    if (goBtn.disabled) return;
    busy = true; errEl.textContent = ''; goBtn.disabled = true; cancelBtn.disabled = true;
    goBtn.textContent = '処理中…';
    try {
      // 1) 本人確認（データを消す前に済ませる）
      if (method === 'password') {
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, pwEl.value));
      } else {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        await reauthenticateWithPopup(user, provider);
      }
      // 2) 名簿から自分の名前を削除 → 自分の投稿などを削除
      let rosterFailed = false, rosterRemoved = 0;
      const rosterChk = $('wdRoster');
      try { rosterRemoved = await removeFromRoster(getFirestore(), user, rosterChk && !rosterChk.checked ? '' : rosterName); }
      catch (e) { console.error('roster removal failed', e); rosterFailed = true; }
      let failed = 0;
      try { failed = await cleanupMyData(getFirestore(), user.uid); }
      catch (e) { console.error('withdraw cleanup failed', e); failed = -1; }
      // 3) アカウント削除
      await deleteUser(user);
      LOCAL_KEYS.forEach(k => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } });
      alert('退会しました。ご利用ありがとうございました。' +
            (rosterRemoved ? '\n名簿から ' + rosterRemoved + ' 件削除しました。' : '') +
            (rosterFailed ? '\n（名簿からの削除に失敗しました。管理表で手動で削除してください）' : '') +
            (failed !== 0 ? '\n（一部の投稿が削除できなかった可能性があります）' : ''));
      if (typeof opts.onDone === 'function') opts.onDone(); else location.href = 'index.html';
    } catch (e) {
      console.error('withdraw failed', e);
      busy = false; cancelBtn.disabled = false; goBtn.textContent = '退会する';
      errEl.textContent = errText(e && e.code);
      refresh();
    }
  });

  applyMethod(); refresh();
  setTimeout(() => (method === 'password' && pwEl ? pwEl : confirmEl).focus(), 50);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}