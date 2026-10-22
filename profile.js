// アカウントに紐づく「表示名」の同期 — index.html / board.html / participants.html 共通
// 名前は Firestore の users/{自分のuid} に保存し、別の端末でログインしたときも同じ名前を使います。
import { getAuth } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

const NAME_KEY = 'ryusyokai_my_name';

function getLocal() { try { return (localStorage.getItem(NAME_KEY) || '').trim(); } catch (e) { return ''; } }
function setLocal(v) { try { localStorage.setItem(NAME_KEY, v); } catch (e) { /* ignore */ } }

// ログイン直後に呼ぶ。アカウントに保存された名前があればこの端末に反映し、名前を返す。
// （クラウドの名前を優先。未保存なら、この端末の名前をクラウドへ保存する）
export async function syncMyName(user) {
  if (!user) return '';
  try { await user.reload(); } catch (e) { /* オフライン等は無視 */ }
  const ref = doc(getFirestore(), 'users', user.uid);
  let cloud = '', readOk = false;
  try {
    const snap = await getDoc(ref);
    readOk = true;
    cloud = snap.exists() ? String(snap.data().name || '').trim() : '';
  } catch (e) { console.warn('profile read failed', e); }

  if (cloud) { setLocal(cloud); return cloud; }

  const local = getLocal();
  if (local) {
    if (readOk) setDoc(ref, { name: local, updatedAt: serverTimestamp() }).catch(() => {});
    return local;
  }
  // 旧方式（アカウントの表示名）への対応。パスワード登録のアカウントは、表示名＝アプリで登録した名前。
  const dn = (user.displayName || '').trim();
  if (dn && user.providerData.some(p => p.providerId === 'password')) {
    setLocal(dn);
    if (readOk) setDoc(ref, { name: dn, updatedAt: serverTimestamp() }).catch(() => {});
    return dn;
  }
  return '';
}

// 名前を変更したときに呼ぶ。
export async function saveMyNameToCloud(name) {
  const u = getAuth().currentUser;
  if (!u || !name) return;
  await setDoc(doc(getFirestore(), 'users', u.uid), { name, updatedAt: serverTimestamp() });
}
