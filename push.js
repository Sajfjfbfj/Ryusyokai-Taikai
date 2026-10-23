// プッシュ通知（端末の通知バー）— index.html / board.html / participants.html 共通
//  ・通知のON/OFF（この端末の登録）
//  ・出来事が起きたときに、サーバー（/api/notify）へ送信を依頼
import { getAuth } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import { getFirestore, doc, setDoc, deleteDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { getMessaging, getToken, deleteToken, isSupported }
  from "https://www.gstatic.com/firebasejs/13.0.0/firebase-messaging.js";

// Firebaseの「ウェブプッシュ証明書」の公開キー（公開して問題ありません）
const VAPID_KEY = 'BFP6vAEtvicCSp5VKREKI7rwv1kgi0r25rA9Myg5h1M9F0otC2XqRlkDICmgp7DnXlyi16j-hhxBhDizCmnrsu8';

// 通知をタップしたとき、サービスワーカーから「このページへ移動して」と伝えられたら移動する
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'goto' || typeof d.url !== 'string') return;
    try {
      const u = new URL(d.url, location.origin);
      if (u.origin === location.origin && u.href !== location.href) location.href = u.href;
    } catch (err) { /* ignore */ }
  });
}

const FLAG = 'ryusyokai_push';
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const getFlag = () => { try { return localStorage.getItem(FLAG) === '1'; } catch (e) { return false; } };
const setFlag = (on) => { try { on ? localStorage.setItem(FLAG, '1') : localStorage.removeItem(FLAG); } catch (e) { /* ignore */ } };

async function canUse() {
  try {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && await isSupported();
  } catch (e) { return false; }
}

async function getMyToken() {
  const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
  await navigator.serviceWorker.ready;
  return getToken(getMessaging(), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
}

async function saveToken(token) {
  const u = getAuth().currentUser;
  if (!u || !token) return;
  await setDoc(doc(getFirestore(), 'push_tokens', token), {
    uid: u.uid, ua: navigator.userAgent.slice(0, 120), updatedAt: serverTimestamp()
  });
}

export async function refreshPushButton() {
  const btn = document.getElementById('pushToggleBtn');
  if (!btn) return;
  const ok = await canUse();
  if (!ok) {
    // iPhoneは「ホーム画面に追加」したアプリでのみ通知できる。それ以外の非対応ブラウザではボタンを隠す
    btn.style.display = (isIOS && !isStandalone) ? '' : 'none';
    btn.textContent = '🔔 通知（ホーム画面に追加すると使えます）';
    return;
  }
  btn.style.display = '';
  const on = getFlag() && Notification.permission === 'granted';
  btn.textContent = on ? '🔔 通知：ON（タップでオフ）' : '🔕 通知：OFF（タップでオン）';
}

// ログイン後に呼ぶ：ONの端末は登録を最新に保ち、ボタンの表示を更新する
export async function initPush() {
  try {
    await refreshPushButton();
    if (getFlag() && Notification.permission === 'granted' && await canUse() && !VAPID_KEY.startsWith('ここに')) {
      await saveToken(await getMyToken());
    }
  } catch (e) { console.warn('initPush failed', e); }
}

export async function togglePush() {
  if (!(await canUse())) {
    alert(isIOS && !isStandalone
      ? 'iPhoneで通知を受け取るには、Safariの共有ボタンから「ホーム画面に追加」をして、そのアイコンから開いてください。'
      : 'このブラウザは通知に対応していません。Chromeなどの通常のブラウザでお試しください。');
    return;
  }
  if (VAPID_KEY.startsWith('ここに')) { alert('通知の設定がまだ完了していません（管理者の設定が必要です）。'); return; }

  const on = getFlag() && Notification.permission === 'granted';
  try {
    if (on) {
      await unregisterThisDevice();
      setFlag(false);
      alert('この端末の通知をオフにしました。');
    } else {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        alert('通知が許可されませんでした。ブラウザの設定で、このサイトの通知を「許可」にしてからもう一度お試しください。');
        return;
      }
      await saveToken(await getMyToken());
      setFlag(true);
      alert('通知をオンにしました。掲示板・お手伝い募集・アンケート・参加表の更新・大会の中止や締切をお知らせします。');
    }
  } catch (e) {
    console.error('togglePush failed', e);
    alert('通知の設定に失敗しました。時間をおいてもう一度お試しください。');
  }
  refreshPushButton();
}

// この端末の登録を解除（ログアウト・通知オフのとき）
export async function unregisterThisDevice() {
  try {
    if (!(await canUse()) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.getRegistration('/firebase-messaging-sw.js');
    if (!reg) return;
    const messaging = getMessaging();
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (token) {
      await deleteDoc(doc(getFirestore(), 'push_tokens', token)).catch(() => {});
      await deleteToken(messaging).catch(() => {});
    }
  } catch (e) { console.warn('unregister failed', e); }
}

// 出来事をサーバーに伝えて、他の人へ通知してもらう（失敗しても画面の動作には影響しない）
export async function sendNotify(payload, delayMs) {
  try {
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    const u = getAuth().currentUser;
    if (!u) return;
    const idToken = await u.getIdToken();
    await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body: JSON.stringify(payload)
    });
  } catch (e) { console.warn('sendNotify failed', e); }
}