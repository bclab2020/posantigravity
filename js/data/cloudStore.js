/**
 * cloudStore.js
 * ---------------------------------------------------------------------------
 * Firebase (Firestore + Storage + Authentication) の薄いラッパー層。
 *
 * 設計方針:
 *  - このモジュール単体では UI に一切関与しない（呼び出し側は dataService.js）
 *  - firebase-config.js が存在しない/プレースホルダーのままの場合は
 *    isConfigured() が false を返し、呼び出し側（dataService.js）が
 *    自動的にローカルキャッシュのみで動作するようフォールバックする
 *  - Firestoreには「軽量なメタデータ」のみを保存し、フレーム座標配列や
 *    キャプチャ画像などの重いデータは Cloud Storage に保存する
 *
 * Firestore コレクション構成:
 *   athletes/{uid}          … 選手プロフィール
 *   specialists/{uid}       … 専門家アカウント（存在すれば専門家権限とみなす）
 *   sessions/{sessionId}    … 測定セッションのメタデータ
 *   bookings/{bookingId}    … 専門家メンター予約
 *
 * Cloud Storage 構成:
 *   sessions/{sessionId}/poseData.json
 *   sessions/{sessionId}/images/{mode}.jpg
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
    getAuth,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signInAnonymously,
    signOut,
    onAuthStateChanged,
    updateProfile
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import {
    getFirestore,
    doc,
    setDoc,
    getDoc,
    addDoc,
    updateDoc,
    deleteDoc,
    collection,
    query,
    where,
    orderBy,
    getDocs,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import {
    getStorage,
    ref,
    uploadString,
    uploadBytes,
    getDownloadURL,
    deleteObject
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js';

var app = null, auth = null, db = null, storage = null;
var initError = null;
var firebaseConfig = null;

function isPlaceholderConfig() {
    return !firebaseConfig || !firebaseConfig.apiKey || firebaseConfig.apiKey === "YOUR_API_KEY";
}

/**
 * Firebaseを初期化する。firebase-config.js が未設定/未配置の場合は何もせず
 * falseを返す。(dataService.js はこれを見てクラウド同期の要否を判断する)
 *
 * firebase-config.js の読み込みは、あえて静的import(ファイル先頭)ではなく
 * ここでの動的import()にしている。静的importだとファイルが1つでも欠けている
 * だけでモジュール全体の読み込みが失敗し、アプリが（撮影画面もナビゲーション
 * も含めて）まるごと真っ白/真っ黒になって動かなくなってしまう
 * （実際にファイル配布時の取りこぼしでこの症状が発生したことがある）。
 * 動的importなら、このファイルが無い/壊れている場合でも例外をここで
 * 握りつぶし、クラウド同期なし（ローカル保存のみ）で残りの機能は
 * 問題なく動作できる。
 */
export async function initFirebase() {
    if (app) return true; // already initialized
    try {
        var configModule = await import('./firebase-config.js');
        firebaseConfig = configModule.firebaseConfig;
    } catch (e) {
        console.warn("[cloudStore] firebase-config.js の読み込みに失敗しました（未配置の可能性）。ローカル保存のみで動作します。", e);
        return false;
    }
    if (isPlaceholderConfig()) {
        console.warn("[cloudStore] firebase-config.js が未設定のため、クラウド同期は無効です。ローカル保存のみで動作します。");
        return false;
    }
    try {
        app = initializeApp(firebaseConfig);
        auth = getAuth(app);
        db = getFirestore(app);
        storage = getStorage(app);
        return true;
    } catch (e) {
        initError = e;
        console.error("[cloudStore] Firebase initialization failed:", e);
        return false;
    }
}

export function isConfigured() {
    return !!app;
}

export function getInitError() {
    return initError;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * 簡易会員登録（アスリート向け）。メールアドレス＋パスワードでアカウントを作成し、
 * athletes/{uid} プロフィールドキュメントを同時に作成する。
 */
export async function signUpAthlete(email, password, displayName, profile) {
    if (!auth) throw new Error("Firebase未初期化です");
    var cred = await createUserWithEmailAndPassword(auth, email, password);
    if (displayName) {
        await updateProfile(cred.user, { displayName: displayName });
    }
    await setDoc(doc(db, 'athletes', cred.user.uid), Object.assign({
        displayName: displayName || "",
        email: email,
        createdAt: serverTimestamp()
    }, profile || {}));
    return cred.user;
}

export async function loginAthlete(email, password) {
    if (!auth) throw new Error("Firebase未初期化です");
    var cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user;
}

/** 会員登録なしで試したいユーザー向けのゲストログイン(匿名認証) */
export async function loginAsGuest() {
    if (!auth) throw new Error("Firebase未初期化です");
    var cred = await signInAnonymously(auth);
    return cred.user;
}

/**
 * 専門家ログイン。認証成功後、specialists/{uid} ドキュメントの存在確認を行い、
 * 専門家として登録されたアカウントでなければサインアウトしてエラーを投げる。
 * (specialists コレクションへのドキュメント作成はFirebaseコンソール、
 *  もしくは管理用スクリプトから事前に行う想定 — SETUP.md参照)
 */
export async function loginSpecialist(email, password) {
    if (!auth) throw new Error("Firebase未初期化です");
    var cred = await signInWithEmailAndPassword(auth, email, password);
    var specDoc = await getDoc(doc(db, 'specialists', cred.user.uid));
    if (!specDoc.exists()) {
        await signOut(auth);
        throw new Error("このアカウントには専門家権限がありません。");
    }
    return { user: cred.user, profile: specDoc.data() };
}

export async function logout() {
    if (!auth) return;
    await signOut(auth);
}

export function onAuthChange(callback) {
    if (!auth) return function () {};
    return onAuthStateChanged(auth, callback);
}

export function getCurrentUser() {
    return auth ? auth.currentUser : null;
}

export async function isSpecialist(uid) {
    if (!db || !uid) return false;
    var specDoc = await getDoc(doc(db, 'specialists', uid));
    return specDoc.exists();
}

// ---------------------------------------------------------------------------
// Firestore: Athlete profile
// ---------------------------------------------------------------------------

export async function getAthleteProfile(uid) {
    if (!db) return null;
    var snap = await getDoc(doc(db, 'athletes', uid));
    return snap.exists() ? Object.assign({ id: uid }, snap.data()) : null;
}

export async function upsertAthleteProfile(uid, data) {
    if (!db) return;
    await setDoc(doc(db, 'athletes', uid), data, { merge: true });
}

// ---------------------------------------------------------------------------
// Firestore + Storage: Sessions
// ---------------------------------------------------------------------------

/**
 * セッションのメタデータをFirestoreに保存する。poseData / images は含めない
 * (別途 uploadSessionBlobs で Storage に保存する)。
 * @param {Object} sessionMeta - id を含む場合は上書き保存、含まない場合は新規作成
 * @returns {Promise<string>} 保存されたセッションID
 */
export async function saveSessionMeta(sessionMeta) {
    if (!db) throw new Error("Firebase未初期化です");
    var data = Object.assign({}, sessionMeta, { updatedAt: serverTimestamp() });
    if (sessionMeta.id) {
        await setDoc(doc(db, 'sessions', sessionMeta.id), data, { merge: true });
        return sessionMeta.id;
    } else {
        var ref2 = await addDoc(collection(db, 'sessions'), Object.assign(data, { createdAt: serverTimestamp() }));
        return ref2.id;
    }
}

/** アスリート本人の測定履歴一覧（新しい順）を取得 */
export async function getSessionsForAthlete(athleteId) {
    if (!db) return [];
    var q = query(collection(db, 'sessions'), where('athleteId', '==', athleteId), orderBy('timestamp', 'desc'));
    var snap = await getDocs(q);
    var results = [];
    snap.forEach(function (d) { results.push(Object.assign({ id: d.id }, d.data())); });
    return results;
}

/** 専門家向け: 全セッション一覧（JSONインポートに依らずクラウド上で直接閲覧する場合） */
export async function getAllSessions() {
    if (!db) return [];
    var q = query(collection(db, 'sessions'), orderBy('timestamp', 'desc'));
    var snap = await getDocs(q);
    var results = [];
    snap.forEach(function (d) { results.push(Object.assign({ id: d.id }, d.data())); });
    return results;
}

export async function getSessionById(sessionId) {
    if (!db) return null;
    var snap = await getDoc(doc(db, 'sessions', sessionId));
    return snap.exists() ? Object.assign({ id: sessionId }, snap.data()) : null;
}

export async function deleteSessionCloud(sessionId) {
    if (!db) return;
    await deleteDoc(doc(db, 'sessions', sessionId));
    // ベストエフォートでStorage側も削除（存在しなくてもエラーにしない）
    try { await deleteObject(ref(storage, 'sessions/' + sessionId + '/poseData.json')); } catch (e) {}
    var modes = ['front', 'back', 'l_side', 'r_side'];
    for (var i = 0; i < modes.length; i++) {
        try { await deleteObject(ref(storage, 'sessions/' + sessionId + '/images/' + modes[i] + '.jpg')); } catch (e) {}
    }
}

/**
 * 4面確認・修正画面での「確定」操作用。poseData/画像の再アップロードを
 * 伴わない軽量な部分更新（status フィールドのみ）。
 */
export async function updateSessionStatus(sessionId, status) {
    if (!db) return;
    await updateDoc(doc(db, 'sessions', sessionId), {
        status: status,
        updatedAt: serverTimestamp()
    });
}

export async function saveExpertReview(sessionId, expertComment, expertExercises, specialistId) {
    if (!db) return;
    await updateDoc(doc(db, 'sessions', sessionId), {
        expertComment: expertComment,
        expertExercises: expertExercises,
        specialistId: specialistId,
        reviewedAt: serverTimestamp()
    });
}

/**
 * フレーム座標配列(poseData)と4方向キャプチャ画像をCloud Storageにアップロードし、
 * Firestoreドキュメントに保存すべき参照情報 { poseDataUrl, imageRefs } を返す。
 */
export async function uploadSessionBlobs(sessionId, poseData, images) {
    if (!storage) throw new Error("Firebase未初期化です");
    var poseDataRef = ref(storage, 'sessions/' + sessionId + '/poseData.json');
    await uploadString(poseDataRef, JSON.stringify(poseData || []), 'raw', { contentType: 'application/json' });
    var poseDataUrl = await getDownloadURL(poseDataRef);

    var imageRefs = {};
    if (images) {
        var modes = Object.keys(images);
        for (var i = 0; i < modes.length; i++) {
            var mode = modes[i];
            var base64 = images[mode];
            if (!base64) continue;
            var blob = base64ToBlob(base64);
            var imgRef = ref(storage, 'sessions/' + sessionId + '/images/' + mode + '.jpg');
            await uploadBytes(imgRef, blob, { contentType: 'image/jpeg' });
            imageRefs[mode] = await getDownloadURL(imgRef);
        }
    }
    return { poseDataUrl: poseDataUrl, imageRefs: imageRefs };
}

export async function downloadPoseData(poseDataUrl) {
    if (!poseDataUrl) return [];
    var res = await fetch(poseDataUrl);
    if (!res.ok) throw new Error("poseDataの取得に失敗しました: HTTP " + res.status);
    return await res.json();
}

function base64ToBlob(base64) {
    var parts = base64.split(',');
    var mimeMatch = parts[0].match(/:(.*?);/);
    var mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    var byteString = atob(parts[1]);
    var arr = new Uint8Array(byteString.length);
    for (var i = 0; i < byteString.length; i++) arr[i] = byteString.charCodeAt(i);
    return new Blob([arr], { type: mime });
}

// ---------------------------------------------------------------------------
// Firestore: Mentor bookings
// ---------------------------------------------------------------------------

export async function saveBooking(bookingData) {
    if (!db) throw new Error("Firebase未初期化です");
    var data = Object.assign({}, bookingData, { createdAt: serverTimestamp() });
    var ref3 = await addDoc(collection(db, 'bookings'), data);
    return ref3.id;
}

export async function getBookingsForAthlete(athleteId) {
    if (!db) return [];
    var q = query(collection(db, 'bookings'), where('athleteId', '==', athleteId), orderBy('createdAt', 'desc'));
    var snap = await getDocs(q);
    var results = [];
    snap.forEach(function (d) { results.push(Object.assign({ id: d.id }, d.data())); });
    return results;
}
