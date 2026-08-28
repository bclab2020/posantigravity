/**
 * dataService.js
 * ---------------------------------------------------------------------------
 * アプリの唯一のデータアクセス窓口。旧 app.js が直接呼んでいた
 * `dbManager.saveSession()` 等は、すべてこのモジュールの同名メソッドに
 * 置き換える（呼び出し側のシグネチャはほぼ互換のまま）。
 *
 * ローカルファースト同期戦略:
 *   1. 保存は必ずまず localStore（IndexedDB）へ即時書き込み → 体育館などの
 *      オフライン環境でも撮影・保存が止まらない
 *   2. Firebaseが設定済み・かつオンラインなら、続けてクラウドへも同期する
 *   3. クラウド同期に失敗した場合は syncQueue に積み、次回オンライン時や
 *      アプリ起動時に再試行する（syncPendingItems）
 *   4. 読み込みはオンライン＋ログイン中ならクラウド優先、それ以外は
 *      ローカルキャッシュに���ォールバックする
 */

import * as localStore from './localStore.js';
import * as cloudStore from './cloudStore.js';

var currentUser = null;
var currentUserIsSpecialist = false;
var authReadyPromise = null;

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

export async function init() {
    await localStore.init();
    var cloudReady = await cloudStore.initFirebase();

    if (cloudReady) {
        authReadyPromise = new Promise(function (resolve) {
            cloudStore.onAuthChange(async function (user) {
                currentUser = user;
                currentUserIsSpecialist = user ? await cloudStore.isSpecialist(user.uid) : false;
                resolve();
                // オンライン復帰・ログイン時に未同期データを流す
                if (user) syncPendingItems().catch(function (e) { console.warn("Background sync failed:", e); });
            });
        });
        window.addEventListener('online', function () {
            syncPendingItems().catch(function (e) { console.warn("Background sync failed:", e); });
        });
    } else {
        authReadyPromise = Promise.resolve();
    }

    await seedDemoDataIfEmpty();
}

export function waitForAuthReady() {
    return authReadyPromise || Promise.resolve();
}

export function isCloudEnabled() {
    return cloudStore.isConfigured();
}

export function getCurrentUser() {
    return currentUser;
}

export function isSpecialistUser() {
    return currentUserIsSpecialist;
}

// ---------------------------------------------------------------------------
// 認証（会員登録・ログイン）
// ---------------------------------------------------------------------------

export async function signUpAthlete(email, password, displayName, profile) {
    var user = await cloudStore.signUpAthlete(email, password, displayName, profile);
    currentUser = user;
    currentUserIsSpecialist = false;
    return user;
}

export async function loginAthlete(email, password) {
    var user = await cloudStore.loginAthlete(email, password);
    currentUser = user;
    currentUserIsSpecialist = await cloudStore.isSpecialist(user.uid);
    return user;
}

export async function loginAsGuest() {
    var user = await cloudStore.loginAsGuest();
    currentUser = user;
    currentUserIsSpecialist = false;
    return user;
}

export async function loginSpecialist(email, password) {
    var result = await cloudStore.loginSpecialist(email, password);
    currentUser = result.user;
    currentUserIsSpecialist = true;
    return result;
}

export async function logout() {
    await cloudStore.logout();
    currentUser = null;
    currentUserIsSpecialist = false;
}

// ---------------------------------------------------------------------------
// セッション保存・取得・削除
// ---------------------------------------------------------------------------

/**
 * @param {Object} sessionData - 旧db.jsと同じ形状
 *   { id, timestamp, patientName, mode, height, footSize, pelvicTilt,
 *     pxToCmRatio, expertComment, expertExercises, poseData, images }
 */
export async function saveSession(sessionData) {
    if (currentUser && !sessionData.athleteId) {
        sessionData.athleteId = currentUser.uid;
    }

    // 1. ローカルへ即時保存（常に成功させる = オフラインでも撮影データを失わない）
    await localStore.saveSession(sessionData);

    // 2. クラウド同期を試行
    if (cloudStore.isConfigured() && currentUser && navigator.onLine) {
        try {
            await syncSessionToCloud(sessionData);
            await localStore.dequeueSync(sessionData.id);
        } catch (e) {
            console.warn("[dataService] Cloud sync failed, queued for retry:", e);
            await localStore.enqueueSync(sessionData.id, "upsert");
        }
    } else if (cloudStore.isConfigured() && currentUser) {
        // オフライン: 後で同期
        await localStore.enqueueSync(sessionData.id, "upsert");
    }
}

async function syncSessionToCloud(sessionData) {
    var blobs = await cloudStore.uploadSessionBlobs(sessionData.id, sessionData.poseData, sessionData.images);
    var meta = {
        id: sessionData.id,
        athleteId: sessionData.athleteId,
        timestamp: sessionData.timestamp,
        patientName: sessionData.patientName,
        mode: sessionData.mode,
        height: sessionData.height,
        footSize: sessionData.footSize,
        pelvicTilt: sessionData.pelvicTilt,
        pxToCmRatio: sessionData.pxToCmRatio,
        floorHomography: sessionData.floorHomography || null,
        // 2026-08-05追加: 研究機関向け「静止姿勢: アルコ正中線モード」。
        // pxToCmRatio/floorHomographyと同じく、クラウド同期時にここへ
        // 含め忘れると、ローカルキャッシュが無い端末でこのセッションを
        // 開いた時に値が失われる（既知の欠落パターン、5節/8節参照）。
        capturedArucoMidlineX: (typeof sessionData.capturedArucoMidlineX === 'number') ? sessionData.capturedArucoMidlineX : null,
        capturedArucoMidlineY: (typeof sessionData.capturedArucoMidlineY === 'number') ? sessionData.capturedArucoMidlineY : null,
        // 2026-08-24追加（不具合修正）: 「4面撮影後、履歴が各方向バラバラに
        // 戻る」というご報告を実機で調査した結果、原因はセルフタイマー等の
        // タイミング競合ではなく、このクラウド同期メタデータにbatchId
        // （4面まとめ表示用の共通の目印）が含まれていなかったこと自体だと
        // 判明した。dataService.jsのgetAllSessions()はローカルキャッシュと
        // クラウドを取得し、クラウド側の内容でローカルを上書きするマージを
        // 行うため（他端末での更新を反映するため）、ログイン済み・オンラインで
        // 履歴を開くたびに、正しくbatchId付きで保存されていたはずの
        // ローカルデータが、batchId無しのクラウドデータで上書きされてしまい、
        // 毎回必ずグルーピングに失敗していた（クラウド同期を使っている限り
        // 100%再現する不具合で、セルフタイマー・自動撮影とは無関係だった）。
        // capturedRollDeg・canvasWidth・canvasHeightも同じ既知の欠落パターン
        // （5節/8節参照）のため、まとめてここに追加する（欠けたままだと、
        // v4.9.11で追加した撮影写真のroll回転補正も、クラウド経由で開いた
        // 履歴では常に無効化されてしまっていたはず）。
        batchId: sessionData.batchId || null,
        capturedRollDeg: (typeof sessionData.capturedRollDeg === 'number') ? sessionData.capturedRollDeg : null,
        canvasWidth: sessionData.canvasWidth || null,
        canvasHeight: sessionData.canvasHeight || null,
        // 2026-08-25追加: 上のbatchId等と全く同じ既知の欠落パターン
        // （このmetaオブジェクトへ明示的に含めないと、クラウド経由で開いた
        // 履歴からこの値が失われる）。写真の形式（'clean_v1'＝骨格線等の
        // 重ね書き無し／未設定＝旧形式）を判定するのに使うため、これが
        // クラウド同期で失われると、ログイン中の端末では常に「旧形式」判定に
        // 落ちてしまい、レポート・サムネイルの骨格オーバーレイ重ね描きが
        // 常に無効化されてしまう（js/core/state.jsのactiveSessionPhotoFormat・
        // js/ui/dashboard.js・js/ui/batchReview.js・js/ui/dynConfirm.js参照）。
        photoFormat: sessionData.photoFormat || null,
        expertComment: sessionData.expertComment || "",
        expertExercises: sessionData.expertExercises || "",
        // 'draft': 4面確認・修正画面で「確定」されるまでの内部保存（���歴一覧には出さない）。
        // 'final': 確定済み、または動作解析など元々バッチ確認フローを持たないモード。
        // 未指定（旧データ）はfinal相当として扱う（getAllSessions側のフィルタ参照）。
        status: sessionData.status || "final",
        poseDataUrl: blobs.poseDataUrl,
        imageRefs: blobs.imageRefs
    };
    await cloudStore.saveSessionMeta(meta);
}

/**
 * 4面確認・修正画面の「確定」操作から呼ばれる。draft保存済みのセッションを
 * 履歴一覧に表示されるstatus='final'へ切り替える。poseData/画像は既に
 * saveSession()で保存済みのため、ここでは軽量なステータス更新のみ行う。
 */
export async function finalizeSession(id) {
    var local = await localStore.getSession(id);
    if (local) {
        local.status = "final";
        await localStore.saveSession(local);
    }
    if (cloudStore.isConfigured() && currentUser && navigator.onLine) {
        try {
            await cloudStore.updateSessionStatus(id, "final");
            await localStore.dequeueSync(id);
        } catch (e) {
            console.warn("[dataService] Cloud finalize failed, queued for retry:", e);
            await localStore.enqueueSync(id, "upsert");
        }
    } else if (cloudStore.isConfigured() && currentUser) {
        await localStore.enqueueSync(id, "upsert");
    }
}

/**
 * 履歴一覧を取得する。
 * @param {boolean} [includeDrafts=false] - trueの場合、4面確認・修正画面で
 *   「確定」される前のdraftセッションも含めて返す（履歴画面の「未確定も表示」
 *   トグル用。確定し忘れて撮影データが見えなくなったと勘違いするのを防ぐ）。
 *
 * ローカル（IndexedDB）とクラウド（Firestore）をIDでマージして返す。
 * 以前は「クラウドが使えるならクラウドの結果をそのまま使い、resultが
 * null/undefinedの時だけローカルにフォールバックする」実装だったが、
 * クラウド側に該当データが1件も無い場合（例: firebase-config.jsが一時的に
 * 無い間はローカルのみに保存されていた等）でも空配列 [] が返る＝「null
 * ではない」ため、実際にはローカルにあるデータが丸ごと無視され、履歴が
 * 「何も無い」ように見えてしまう不具合があった。ローカル保存は常に
 * saveSession()の最初のステップで行われる（保存の正であるため）、
 * ローカル・クラウド両方の結果を必ずマージすることで解消する。
 */
export async function getAllSessions(includeDrafts) {
    var localSessions = await localStore.getAllSessions();
    var cloudSessions = [];

    if (cloudStore.isConfigured() && currentUser && navigator.onLine) {
        try {
            cloudSessions = currentUserIsSpecialist
                ? await cloudStore.getAllSessions()
                : await cloudStore.getSessionsForAthlete(currentUser.uid);
        } catch (e) {
            console.warn("[dataService] Cloud fetch failed, using local cache only:", e);
        }
    }

    var merged = {};
    localSessions.forEach(function (s) { merged[s.id] = s; });
    // クラウド同期済みのものはクラウド側の内容（専門家コメント等、他端末での
    // 更新を含む）を優先しつつ上書きする。
    cloudSessions.forEach(function (s) { merged[s.id] = s; });

    var sessions = Object.keys(merged).map(function (id) { return merged[id]; });
    sessions.sort(function (a, b) {
        var tA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        var tB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return tB - tA;
    });

    if (includeDrafts) return sessions;

    // 4面確認・修正画面で「確定」されるまでのdraftは履歴一覧に出さない。
    // statusフィールドが無い（=このバッチレビュー機能より前に保存された）
    // 既存データ・���モデータはfinal相当として扱い、従来通り表示する。
    return sessions.filter(function (s) { return s.status !== "draft"; });
}

/**
 * 個別セッションの完全なデータ（poseData含む）を取得する。
 * クラウド上のセッションメタデータには poseDataUrl のみが入っているため、
 * 必要に応じて Storage から実データをダウンロードする。
 */
export async function getSessionFull(id) {
    var local = await localStore.getSession(id);
    if (local && local.poseData) return local;

    if (cloudStore.isConfigured() && navigator.onLine) {
        var meta = await cloudStore.getSessionById(id);
        if (meta) {
            var poseData = meta.poseDataUrl ? await cloudStore.downloadPoseData(meta.poseDataUrl) : [];
            var full = Object.assign({}, meta, { poseData: poseData, images: meta.imageRefs || {} });
            // 次回以降オフラインでも見られるようローカルにもキャッシュ
            await localStore.saveSession(full);
            return full;
        }
    }
    return local || null;
}

export async function deleteSession(id) {
    await localStore.deleteSession(id);
    if (cloudStore.isConfigured() && currentUser && navigator.onLine) {
        try {
            await cloudStore.deleteSessionCloud(id);
        } catch (e) {
            console.warn("[dataService] Cloud delete failed:", e);
        }
    }
}

export async function saveExpertReview(sessionId, expertComment, expertExercises) {
    var local = await localStore.getSession(sessionId);
    if (local) {
        local.expertComment = expertComment;
        local.expertExercises = expertExercises;
        await localStore.saveSession(local);
    }
    if (cloudStore.isConfigured() && currentUser && navigator.onLine) {
        await cloudStore.saveExpertReview(sessionId, expertComment, expertExercises, currentUser.uid);
    }
}

// ---------------------------------------------------------------------------
// メンター予約
// ---------------------------------------------------------------------------

export async function saveBooking(bookingData) {
    if (currentUser) bookingData.athleteId = currentUser.uid;
    if (cloudStore.isConfigured() && currentUser && navigator.onLine) {
        return await cloudStore.saveBooking(bookingData);
    }
    // クラウド未設定/オフライン時は簡易的にlocalStorageへ退避（旧実装踏襲のフォールバック）
    var bookings = JSON.parse(localStorage.getItem('mentor_bookings_pending') || '[]');
    bookings.push(bookingData);
    localStorage.setItem('mentor_bookings_pending', JSON.stringify(bookings));
    return null;
}

// ---------------------------------------------------------------------------
// 同期キューの処理
// ---------------------------------------------------------------------------

export async function syncPendingItems() {
    if (!cloudStore.isConfigured() || !currentUser || !navigator.onLine) return;
    var pending = await localStore.getPendingSyncItems();
    for (var i = 0; i < pending.length; i++) {
        var item = pending[i];
        try {
            if (item.action === 'upsert') {
                var session = await localStore.getSession(item.sessionId);
                if (session) await syncSessionToCloud(session);
            } else if (item.action === 'delete') {
                await cloudStore.deleteSessionCloud(item.sessionId);
            }
            await localStore.dequeueSync(item.sessionId);
        } catch (e) {
            console.warn("[dataService] Retry sync failed for", item.sessionId, e);
        }
    }
}

// ---------------------------------------------------------------------------
// デモデータのシード（スキーマ不整合バグを修正）
//
// 旧実装は demoSession のスキーマ（athleteName/measurements/history）が
// 実測定セッションのスキーマ（patientName/poseData/pelvicTilt/images）と
// 一致しておらず、履歴一覧・読込処理で不整合を起こしていた。
// ここ���は実セッションと完全に同じ形状でシードすることで解消する。
// ---------------------------------------------------------------------------

var DEMO_SESSION_ID = "demo_athletecore_2026";

async function seedDemoDataIfEmpty() {
    try {
        var sessions = await localStore.getAllSessions();
        if (sessions.some(function (s) { return s.id === DEMO_SESSION_ID; })) return;

        var poseData = [];
        for (var f = 0; f < 60; f++) {
            var ratio = f / 59;
            var squatPhase = (Math.sin(ratio * Math.PI) + 1) / 2;
            var kps = buildDemoKeypoints(squatPhase);
            poseData.push({ time: Date.now() + f * 33, mode: "dyn_overhead_side", keypoints: kps });
        }

        var demoSession = {
            id: DEMO_SESSION_ID,
            timestamp: Date.now(),
            patientName: "デモ選手",
            mode: "dyn_overhead_side",
            height: 170,
            footSize: 25,
            pelvicTilt: 4.8,
            pxToCmRatio: null,
            expertComment: "",
            expertExercises: "",
            poseData: poseData,
            images: {}
        };

        await localStore.saveSession(demoSession);
        console.log("[dataService] Demo data seeded (schema-consistent).");
    } catch (e) {
        console.error("[dataService] Error seeding demo data:", e);
    }
}

function buildDemoKeypoints(squatPhase) {
    var kneeShift = squatPhase * 20;
    return [
        { name: "nose", x: 320, y: 120 + squatPhase * 30, score: 0.95 },
        { name: "left_ear", x: 310, y: 110 + squatPhase * 30, score: 0.9 },
        { name: "right_ear", x: 330, y: 110 + squatPhase * 30, score: 0.9 },
        { name: "left_shoulder", x: 290, y: 160 + squatPhase * 30, score: 0.95 },
        { name: "right_shoulder", x: 350, y: 160 + squatPhase * 30, score: 0.95 },
        { name: "left_hip", x: 295, y: 260 + squatPhase * 15, score: 0.95 },
        { name: "right_hip", x: 345, y: 260 + squatPhase * 15, score: 0.95 },
        { name: "left_knee", x: 290 - kneeShift, y: 340 + squatPhase * 5, score: 0.9 },
        { name: "right_knee", x: 350 + kneeShift, y: 340 + squatPhase * 5, score: 0.9 },
        { name: "left_ankle", x: 295, y: 420, score: 0.9 },
        { name: "right_ankle", x: 345, y: 420, score: 0.9 },
        { name: "left_wrist", x: 270, y: 220 + squatPhase * 10, score: 0.7 },
        { name: "right_wrist", x: 370, y: 220 + squatPhase * 10, score: 0.7 }
    ];
}
