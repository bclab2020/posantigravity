/**
 * localStore.js
 * ---------------------------------------------------------------------------
 * IndexedDBの薄いラッパー。オフライン（体育館等、通信が不安定な現場）でも
 * 測定・保存が続けられるよう、「即時書き込み用ローカルキャッシュ」として使う。
 * クラウドへの実同期は dataService.js が担当し、このモジュールは
 * 純粋なローカル永続化のみに責務を絞る（旧 db.js を縮小したもの）。
 *
 * オブジェクトストア:
 *   sessions   … 測定セッション全体（poseData・画像を含む、旧db.jsと互換）
 *   syncQueue  … クラウド未同期のセッションIDを保持する同期待ちキュー
 *
 * 接続の自動再確立について（2026-07-29のタブレット実機ログで発覚した不具合対応）:
 *   タブレットのバックグラウンド遷移等でブラウザがIndexedDB接続を静かに
 *   閉じてしまうことがあり、その後に保存操作を行うと
 *   `InvalidStateError: The database connection is closing` が発生して
 *   保存自体が失敗し、しかも例外がここで握りつぶされずそのまま呼び出し元まで
 *   伝播するため、撮影データが保存されないまま確認バナーも出ないという
 *   データ消失リスクのある不具合になっていた。dbInstanceが閉じられたら
 *   即座にnullへ戻し、次回アクセス時に自動で再openするensureDb()を
 *   全公開関数の入口に統一した。
 */

var DB_NAME = "AthletecoreLocalDB";
var DB_VERSION = 2;
var STORE_SESSIONS = "sessions";
var STORE_SYNC_QUEUE = "syncQueue";

var dbInstance = null;
var initFlight = null;

export function init() {
    if (initFlight) return initFlight;

    initFlight = new Promise(function (resolve, reject) {
        var request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = function (event) {
            var db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
                db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
            }
            if (!db.objectStoreNames.contains(STORE_SYNC_QUEUE)) {
                db.createObjectStore(STORE_SYNC_QUEUE, { keyPath: "sessionId" });
            }
        };

        request.onsuccess = function (event) {
            dbInstance = event.target.result;
            // ブラウザが端末事情（バックグラウンド化・メモリ逼迫等）で接続を
            // 勝手に閉じた場合、キャッシュを破棄し次回アクセス時にensureDb()が
            // 再openできるようにしておく。
            dbInstance.onclose = function () {
                dbInstance = null;
                initFlight = null;
            };
            // 他タブでのDB更新（バージョンアップ等）が走った場合も同様に手放す。
            dbInstance.onversionchange = function () {
                dbInstance.close();
                dbInstance = null;
                initFlight = null;
            };
            resolve(dbInstance);
        };

        request.onerror = function (event) {
            initFlight = null;
            reject("IndexedDB error: " + event.target.errorCode);
        };
    });

    return initFlight;
}

function ensureDb() {
    if (dbInstance) return Promise.resolve(dbInstance);
    return init();
}

export async function saveSession(sessionData) {
    var db = await ensureDb();
    return new Promise(function (resolve, reject) {
        var tx = db.transaction([STORE_SESSIONS], "readwrite");
        var store = tx.objectStore(STORE_SESSIONS);
        var request = store.put(sessionData);
        request.onsuccess = function () { resolve(); };
        request.onerror = function (e) { reject("Error saving session: " + e.target.error); };
    });
}

export async function getAllSessions() {
    var db = await ensureDb();
    return new Promise(function (resolve, reject) {
        var tx = db.transaction([STORE_SESSIONS], "readonly");
        var store = tx.objectStore(STORE_SESSIONS);
        var request = store.getAll();
        request.onsuccess = function (event) {
            var results = event.target.result || [];
            results.sort(function (a, b) {
                var tA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
                var tB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
                return tB - tA;
            });
            resolve(results);
        };
        request.onerror = function (e) { reject("Error fetching sessions: " + e.target.error); };
    });
}

export async function getSession(id) {
    var db = await ensureDb();
    return new Promise(function (resolve, reject) {
        var tx = db.transaction([STORE_SESSIONS], "readonly");
        var store = tx.objectStore(STORE_SESSIONS);
        var request = store.get(id);
        request.onsuccess = function (event) { resolve(event.target.result || null); };
        request.onerror = function (e) { reject("Error fetching session: " + e.target.error); };
    });
}

export async function deleteSession(id) {
    var db = await ensureDb();
    return new Promise(function (resolve, reject) {
        var tx = db.transaction([STORE_SESSIONS], "readwrite");
        var store = tx.objectStore(STORE_SESSIONS);
        var request = store.delete(id);
        request.onsuccess = function () { resolve(); };
        request.onerror = function (e) { reject("Error deleting session: " + e.target.error); };
    });
}

// ---------------------------------------------------------------------------
// 同期待ちキュー（クラウド未反映のセッションを管理）
// ---------------------------------------------------------------------------

export async function enqueueSync(sessionId, action) {
    var db = await ensureDb();
    return new Promise(function (resolve, reject) {
        var tx = db.transaction([STORE_SYNC_QUEUE], "readwrite");
        var store = tx.objectStore(STORE_SYNC_QUEUE);
        var request = store.put({ sessionId: sessionId, action: action || "upsert", queuedAt: Date.now(), attempts: 0 });
        request.onsuccess = function () { resolve(); };
        request.onerror = function (e) { reject("Error queueing sync: " + e.target.error); };
    });
}

export async function dequeueSync(sessionId) {
    var db = await ensureDb();
    return new Promise(function (resolve, reject) {
        var tx = db.transaction([STORE_SYNC_QUEUE], "readwrite");
        var store = tx.objectStore(STORE_SYNC_QUEUE);
        var request = store.delete(sessionId);
        request.onsuccess = function () { resolve(); };
        request.onerror = function (e) { reject("Error dequeueing sync: " + e.target.error); };
    });
}

export async function getPendingSyncItems() {
    var db = await ensureDb();
    return new Promise(function (resolve, reject) {
        var tx = db.transaction([STORE_SYNC_QUEUE], "readonly");
        var store = tx.objectStore(STORE_SYNC_QUEUE);
        var request = store.getAll();
        request.onsuccess = function (event) { resolve(event.target.result || []); };
        request.onerror = function (e) { reject("Error reading sync queue: " + e.target.error); };
    });
}
