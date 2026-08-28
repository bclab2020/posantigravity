/**
 * history.js
 * ---------------------------------------------------------------------------
 * 測定履歴ドロワー: 一覧表示、個別セッションの読込・削除・CSV/動画書き出し。
 * dataService経由でクラウド（Firestore+Storage）優先、オフライン時は
 * ローカルIndexedDBキャッシュにフォールバックする。
 */

import { state, reportDataStore, MODE_NAMES_JP, STATIC_MODES } from '../core/state.js';
import { patientNameInput, heightInput, footSizeInput, canvasMP } from '../core/dom.js';
import { updateModeUI, renderPlaybackFrame, togglePlay } from './controls.js';
import { startVideoExport } from '../core/recorder.js';
import { navigate } from './router.js';

var _dataService = null;

// 静止4方向（前面/後面/左右側面）のうち、batchIdを持つ確定済み(final)の
// セッションだけを、履歴一覧で「4面まとめ」の1件として表示する
// （v4.6.14〜）。draft（未確定）はこれまで通り1件ずつ表示し、既存の
// 「未確定を手動で確定する」救済フローを変えない。batchIdを持たない
// 過去データ・重心動揺・動作解析（動的種目）のデータも、これまで通り1件ずつ
// 表示する（企画者確認済み: 過去データは無理にグルーピングしない。
// STATIC_MODESはstate.jsの定義を使う。重心動揺モード追加時に一本化）。
// batchId -> { front: id|null, l_side: id|null, back: id|null, r_side: id|null }
// 「4面まとめ」カードのクリック・削除ハンドラ（window.viewHistoryBatch等）が
// 参照するためのキャッシュ。refreshHistoryList()の描画のたびに作り直す。
var _batchIdsCache = {};
var _batchPatientNameCache = {};

export function initHistoryUI(dataService) {
    _dataService = dataService;
    // 履歴パネルは v4.0.0 よりドロワーではなく「履歴」ページそのものになった
    // ため、開閉トグルは不要（router.js がページ表示/非表示を担当する）。
    // closeHistoryBtn はCSSで非表示にした旧UIの名残りなので配線しない。

    var draftsCheckbox = document.getElementById('historyShowDraftsCheckbox');
    if (draftsCheckbox) {
        draftsCheckbox.onchange = function () { window.refreshHistoryList(); };
    }
}

window.refreshHistoryList = async function () {
    var historyListContainer = document.getElementById('historyListContainer');
    var draftsCheckbox = document.getElementById('historyShowDraftsCheckbox');
    var includeDrafts = !!(draftsCheckbox && draftsCheckbox.checked);

    historyListContainer.innerHTML = '<div style="color:#8892b0; text-align:center; margin-top:20px;">読込中...</div>';
    try {
        var sessions = await _dataService.getAllSessions(includeDrafts);
        historyListContainer.innerHTML = '';
        if (sessions.length === 0) {
            historyListContainer.innerHTML = '<div style="color:#8892b0; text-align:center; margin-top:20px;">保存データがありません。</div>';
            return;
        }

        _batchIdsCache = {};
        _batchPatientNameCache = {};

        var batches = {}; // batchId -> [session, ...]
        var singles = [];

        sessions.forEach(function (session) {
            // 2026-08-24追記（不具合再調査）: 以前はここで「確定済み(final)の
            // セッションだけをグルーピング対象にする」としていたが、企画者から
            // 「4面撮影後、履歴が各方向バラバラに戻る」という報告が繰り返し
            // あり、原因を実機で特定しきれていない。原因がどこにあるにせよ、
            // 同じbatchId（撮影時に発行される4面共通の目印、記録自体は
            // js/core/recorder.jsのstopRecording内で毎回確実に行われている
            // ことをテストで確認済み）を持つセッションは、確定(final)されて
            // いなくても「同じ4面撮影の一部」であることに変わりはないため、
            // 未確定(draft)のままでもグルーピング対象にする。これにより、
            // 万一この後の確定処理（finalizeBatch等）が何らかの理由で
            // 完走しなかった場合でも、履歴上は「4面バラバラの単独項目」では
            // なく「4面測定（未確定）」の1件としてまとまって見えるようになる
            // （原因調査中の暫定対応だが、UX上も単独表示よりまとまっている
            // 方が分かりやすいため恒久的にこの挙動でよい）。未確定セッションの
            // 「確定する」救済導線は、下のbuildBatchHistoryItem内に統合した
            // （単独表示側の既存の「✅ 確定する」ボタンと同じ処理を、4面分
            // まとめて呼ぶ形）。
            var isGroupable = !!session.batchId && STATIC_MODES.indexOf(session.mode) !== -1;
            if (isGroupable) {
                if (!batches[session.batchId]) batches[session.batchId] = [];
                batches[session.batchId].push(session);
            } else {
                singles.push(session);
            }
        });

        // 単独表示（従来通り）とグループ表示（4面まとめ）を、それぞれの
        // 代表時刻で1つの表示順（新しい順）にまとめ直す。
        var displayEntries = singles.map(function (s) {
            return { type: 'single', session: s, time: s.timestamp ? new Date(s.timestamp).getTime() : 0 };
        });
        Object.keys(batches).forEach(function (batchId) {
            var group = batches[batchId];
            var times = group.map(function (s) { return s.timestamp ? new Date(s.timestamp).getTime() : 0; });
            displayEntries.push({ type: 'batch', batchId: batchId, sessions: group, time: Math.min.apply(null, times) });
        });
        displayEntries.sort(function (a, b) { return b.time - a.time; });

        displayEntries.forEach(function (entry) {
            historyListContainer.appendChild(
                entry.type === 'single' ? buildSingleHistoryItem(entry.session) : buildBatchHistoryItem(entry.batchId, entry.sessions)
            );
        });
    } catch (e) {
        console.error(e);
        historyListContainer.innerHTML = '<div style="color:var(--accent-red); text-align:center; margin-top:20px;">エラーが発生しました。</div>';
    }
};

function buildSingleHistoryItem(session) {
    // 動作解析（動的種目）は静止4方向のような「4面まとめ」の概念を持たず
    // 常にここ（単独表示）に来るが、静止姿勢の4面確認・修正画面と同じ
    // 「タップすると専用の確認画面に飛ぶ」体験を統一したいというご要望
    // （2026-07-29、「自分が今どの画面で何をしているか分かることが使い
    // やすさにつながる」）を受け、動作解析だけは専用の行を使う
    // （v4.6.24、buildDynamicHistoryItem参照）。静止姿勢の単独表示（4面まとめ
    // に至らなかった古いデータ等）は、これまで通りこの関数のまま。
    if (STATIC_MODES.indexOf(session.mode) === -1) {
        return buildDynamicHistoryItem(session);
    }

    var date = new Date(session.timestamp);
    var dateStr = date.getFullYear() + "/" + (date.getMonth() + 1).toString().padStart(2, '0') + "/" + date.getDate().toString().padStart(2, '0') + " " + date.getHours().toString().padStart(2, '0') + ":" + date.getMinutes().toString().padStart(2, '0');
    var modeName = MODE_NAMES_JP[session.mode] || session.mode;
    var patName = session.patientName || "ゲスト";
    var isDraft = session.status === 'draft';

    // 2026-08-24追記（不具合再調査用の一時的な診断表示）: 「4面撮影後、履歴が
    // 各方向バラバラに戻る」報告の実機での原因特定用。この単独表示に来ている
    // ということは「batchIdが無い」か「他の3方向とbatchIdが一致していない」
    // かのどちらかのはずなので、実際どちらなのかをそのまま出す。
    var debugLine = 'batchId=' + (session.batchId || '(なし)') + ' status=' + (session.status || 'final');

    var item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML =
        '<div class="history-info" onclick="window.viewSessionPlayback(\'' + session.id + '\')">' +
        '<span class="history-mode">' + patName + ' 様 - ' + modeName +
        (isDraft ? ' <span class="history-draft-badge">未確定</span>' : '') + '</span>' +
        '<span class="history-date">' + dateStr + '</span>' +
        '<span class="history-debug-line" style="display:block; font-size:10px; color:#8892b0; opacity:0.7;">' + debugLine + '</span>' +
        '</div>' +
        '<div class="history-actions">' +
        (isDraft ? '<button class="history-action-btn finalize" onclick="window.finalizeSessionFromHistory(\'' + session.id + '\')">✅ 確定する</button>' : '') +
        '<button class="history-action-btn" onclick="window.viewSessionReport(\'' + session.id + '\')">📄 レポート</button>' +
        '<button class="history-action-btn vid" onclick="window.viewSessionPlayback(\'' + session.id + '\')">🎞 再生</button>' +
        '<button class="history-action-btn" onclick="window.exportSessionCsv(\'' + session.id + '\')">CSV</button>' +
        '<button class="history-action-btn del" onclick="window.deleteSessionFromList(\'' + session.id + '\')">削除</button>' +
        '</div>';
    return item;
}

/**
 * 動作解析（動的種目）の履歴一覧の行。静止4方向の「4面まとめ」行
 * （buildBatchHistoryItem、タップすると#batchReviewOverlayが開く）と同じ
 * 考え方で、タップすると動作解析用の撮影確認画面(js/ui/dynConfirm.js の
 * 履歴モード)が開く。再生・レポート・CSV・確定といった個別の操作は、
 * すべてその確認画面側にまとめてあるため、この行自体には行き先が1つ
 * （確認画面を見る）＋削除だけを置く（v4.6.24）。
 */
function buildDynamicHistoryItem(session) {
    var date = new Date(session.timestamp);
    var dateStr = date.getFullYear() + "/" + (date.getMonth() + 1).toString().padStart(2, '0') + "/" + date.getDate().toString().padStart(2, '0') + " " + date.getHours().toString().padStart(2, '0') + ":" + date.getMinutes().toString().padStart(2, '0');
    var modeName = MODE_NAMES_JP[session.mode] || session.mode;
    var patName = session.patientName || "ゲスト";
    var isDraft = session.status === 'draft';

    var item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML =
        '<div class="history-info" onclick="window.viewDynSessionConfirm(\'' + session.id + '\')">' +
        '<span class="history-mode">' + patName + ' 様 - ' + modeName +
        (isDraft ? ' <span class="history-draft-badge">未確定</span>' : '') + '</span>' +
        '<span class="history-date">' + dateStr + '</span>' +
        '</div>' +
        '<div class="history-actions">' +
        '<button class="history-action-btn vid" onclick="window.viewDynSessionConfirm(\'' + session.id + '\')">📂 確認画面を見る</button>' +
        '<button class="history-action-btn del" onclick="window.deleteSessionFromList(\'' + session.id + '\')">削除</button>' +
        '</div>';
    return item;
}

/**
 * 動作解析（動的種目）の履歴一覧の行から呼ばれる。js/ui/dynConfirm.jsの
 * 履歴モード（#dynConfirmOverlayを、確定済みなら「📄 レポートを見る」、
 * 未確定なら「✅ この内容で確定してレポート作成」を出す形で再利用）を開く。
 */
window.viewDynSessionConfirm = function (id) {
    if (window.__showDynConfirmHistoryView) window.__showDynConfirmHistoryView(id);
};

/**
 * 静止4方向（前面/後面/左右側面）で、同じbatchId（撮影時に発行される
 * 4面共通の目印。v4.6.14〜）を持つ確定済みセッションをまとめて1行として
 * 表示する。タップすると、js/ui/batchReview.js の4面グリッド画面を
 * 「履歴モード」で開く（撮り直し・確定ボタンなしの閲覧・微調整・
 * まとめてCSV書き出し版）。
 */
function buildBatchHistoryItem(batchId, sessionsInGroup) {
    var byMode = {};
    sessionsInGroup.forEach(function (s) { byMode[s.mode] = s; });

    var representative = sessionsInGroup.slice().sort(function (a, b) {
        return (a.timestamp || 0) - (b.timestamp || 0);
    })[0];
    var date = new Date(representative.timestamp);
    var dateStr = date.getFullYear() + "/" + (date.getMonth() + 1).toString().padStart(2, '0') + "/" + date.getDate().toString().padStart(2, '0') + " " + date.getHours().toString().padStart(2, '0') + ":" + date.getMinutes().toString().padStart(2, '0');
    var patName = representative.patientName || "ゲスト";

    var poseCount = STATIC_MODES.filter(function (m) { return !!byMode[m]; }).length;
    var ids = {};
    STATIC_MODES.forEach(function (m) { ids[m] = byMode[m] ? byMode[m].id : null; });

    // 2026-08-24追記（不具合再調査）: グルーピング対象にdraftも含めるように
    // したため、グループ内に未確定セッションが1件でもあれば「未確定」バッジと、
    // グループ全件をまとめて確定する救済ボタンを出す（単独表示側の
    // 「✅ 確定する」と同じ考え方）。
    var hasDraft = sessionsInGroup.some(function (s) { return s.status === 'draft'; });

    _batchIdsCache[batchId] = ids;
    _batchPatientNameCache[batchId] = patName;

    // 2026-08-24追記（不具合再調査用の一時的な診断表示）: 「4面撮影後、履歴が
    // 各方向バラバラに戻る」報告の実機での原因特定に、batchId・各方向の
    // status（final/draft/欠落）が手がかりになるため、小さく併記しておく。
    // 検証用の暫定表示（本開発ではセキュリティ・UI磨き込みを優先しない前提の
    // ため、そのまま残しても実害は無い）。
    var debugStatusParts = STATIC_MODES.map(function (m) {
        return m + ':' + (byMode[m] ? (byMode[m].status || 'final') : '欠落');
    });
    var debugLine = 'batchId=' + batchId + ' [' + debugStatusParts.join(', ') + ']';

    var item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML =
        '<div class="history-info" onclick="window.viewHistoryBatch(\'' + batchId + '\')">' +
        '<span class="history-mode">' + patName + ' 様 - 🧍 4面測定（' + poseCount + '/4）' +
        (hasDraft ? ' <span class="history-draft-badge">未確定</span>' : '') + '</span>' +
        '<span class="history-date">' + dateStr + '</span>' +
        '<span class="history-debug-line" style="display:block; font-size:10px; color:#8892b0; opacity:0.7;">' + debugLine + '</span>' +
        '</div>' +
        '<div class="history-actions">' +
        (hasDraft ? '<button class="history-action-btn finalize" onclick="window.finalizeHistoryBatch(\'' + batchId + '\')">✅ すべて確定する</button>' : '') +
        '<button class="history-action-btn vid" onclick="window.viewHistoryBatch(\'' + batchId + '\')">📂 4面を見る</button>' +
        '<button class="history-action-btn del" onclick="window.deleteHistoryBatch(\'' + batchId + '\')">削除</button>' +
        '</div>';
    return item;
}

/**
 * 2026-08-24追加: グルーピング対象にdraftを含めるようにしたことに伴う
 * 救済ボタン。単独表示側のwindow.finalizeSessionFromHistoryと同じ処理を、
 * グループ内の���確定セッション全件にまとめて行う。
 */
window.finalizeHistoryBatch = async function (batchId) {
    var ids = _batchIdsCache[batchId];
    if (!ids) return;
    var idList = STATIC_MODES.map(function (m) { return ids[m]; }).filter(Boolean);
    try {
        for (var i = 0; i < idList.length; i++) {
            await _dataService.finalizeSession(idList[i]);
        }
        window.refreshHistoryList();
    } catch (e) {
        console.error('[history] Failed to finalize batch:', batchId, e);
        alert("確定処理に失敗しました。\nエラー詳細: " + e.message);
    }
};

window.viewHistoryBatch = function (batchId) {
    var ids = _batchIdsCache[batchId];
    if (!ids) return;
    if (window.__showHistoryBatchView) window.__showHistoryBatchView(ids, _batchPatientNameCache[batchId]);
};

window.deleteHistoryBatch = async function (batchId) {
    var ids = _batchIdsCache[batchId];
    if (!ids) return;
    if (!confirm("この4面まとめてのデータを削除しますか？（4件すべて削除され、元に戻せません）")) return;

    var idList = STATIC_MODES.map(function (m) { return ids[m]; }).filter(Boolean);
    for (var i = 0; i < idList.length; i++) {
        try {
            await _dataService.deleteSession(idList[i]);
        } catch (e) {
            console.error('[history] Failed to delete session in batch:', idList[i], e);
        }
    }
    window.refreshHistoryList();
};

/**
 * 未確定（draft）のまま残ってしまったセッションを、履歴画面から個別に
 * 確定させる救済手段。4面確認・修正画面の「微調整」中に誤って「📄 レポート」
 * から抜けてしまった場合などに、撮影データ自体は消えていないことを確認し、
 * 手動で確定できるようにする。
 */
window.finalizeSessionFromHistory = async function (id) {
    try {
        await _dataService.finalizeSession(id);
        window.refreshHistoryList();
    } catch (e) {
        console.error(e);
        alert("確定処理に失敗しました。\nエラー詳細: " + e.message);
    }
};

window.deleteSessionFromList = async function (id) {
    if (confirm("このセッションデータを削除しますか？")) {
        await _dataService.deleteSession(id);
        window.refreshHistoryList();
    }
};

window.exportSessionCsv = async function (id) {
    try {
        var session = await _dataService.getSessionFull(id);
        if (session) {
            var c = "Timestamp,Mode,PointID,PointName,X,Y\n";
            session.poseData.forEach(function (d) {
                d.keypoints.forEach(function (kp, idx) {
                    if (kp) c += d.time + "," + d.mode + "," + idx + "," + (kp.name || idx) + "," + kp.x.toFixed(1) + "," + kp.y.toFixed(1) + "\n";
                });
            });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([c], { type: 'text/csv' }));
            a.download = "athletecore_data_" + (session.patientName || 'guest') + "_" + session.mode + "_" + session.timestamp + ".csv";
            a.click();
        }
    } catch (e) {
        console.error(e);
    }
};

window.exportSessionVideo = async function (id) {
    document.getElementById('historyPanel').style.display = 'none';
    state.editReturnTarget = 'history';
    await window.loadSession(id);
    setTimeout(startVideoExport, 500);
};

window.loadSession = async function (id) {
    try {
        var session = await _dataService.getSessionFull(id);
        if (session) {
            state.activeSessionId = session.id;
            state.activePatientName = session.patientName || "ゲスト";
            // このポーズを微調整して保存し直す時（controls.jsの
            // saveEditsAndReturnToBatchReview/saveEditsAndReturnToHistoryBatch/
            // saveEditsAndReturnToDynConfirmHistory）に、元のセッションが
            // 持っていたbatchId（4面まとめ表示用の共通の目印）・status
            // （動作解析の撮影確認画面・履歴モードで、保存時に元の確定状態
            // を保存し忘れて消してしまわないよう）を、ここで一時的に控えておく。
            state.activeSessionBatchId = session.batchId || null;
            state.activeSessionStatus = session.status || 'draft';
            // 2026-08-03追加: capturedRollDeg・canvasWidth/Heightも同じ理由
            // （saveEditsAndReturnTo*系での保存し忘れ防止）で控えておく
            // （js/core/state.jsのコメント・js/ui/controls.js参照）。
            state.activeSessionCapturedRollDeg = (typeof session.capturedRollDeg === 'number') ? session.capturedRollDeg : null;
            state.activeSessionCanvasWidth = session.canvasWidth || null;
            state.activeSessionCanvasHeight = session.canvasHeight || null;
            // 2026-08-25追加: capturedRollDeg等と同じ理由（js/core/state.jsの
            // activeSessionPhotoFormatのコメント参照）で、写真の形式（'clean_v1'/
            // 旧形式）も一時的に控えておく。
            state.activeSessionPhotoFormat = session.photoFormat || null;
            // 2026-08-05追加: 上と同じ理由で、アルコ正中線座標も控えておく
            // （js/core/state.jsのコメント・js/ui/controls.js参照）。
            state.activeSessionCapturedArucoMidlineX = (typeof session.capturedArucoMidlineX === 'number') ? session.capturedArucoMidlineX : null;
            state.activeSessionCapturedArucoMidlineY = (typeof session.capturedArucoMidlineY === 'number') ? session.capturedArucoMidlineY : null;

            if (session.images) {
                Object.keys(session.images).forEach(function (mode) {
                    if (!reportDataStore[mode]) reportDataStore[mode] = {};
                    reportDataStore[mode].capturedImage = (id === 'demo_athletecore_2026') ? null : session.images[mode];
                    // 2026-08-24追加: このセッション（4方向のうち1つ）が撮影
                    // された時点のroll角度を、同時に保存されている他の3方向
                    // ぶんの写真にも適用する。4方向は同じカメラ設置のまま
                    // 連続で撮るため、roll角度は共通という前提（実際の
                    // 数値補正でも同じ考え方で代表セッション1件のroll角度を
                    // 使っている、js/ui/batchReview.jsのviewHistoryBatchReport
                    // 参照）。
                    reportDataStore[mode].capturedRollDeg = state.activeSessionCapturedRollDeg;
                });
            } else {
                ['front', 'back', 'l_side', 'r_side'].forEach(function (mode) {
                    if (reportDataStore[mode]) reportDataStore[mode].capturedImage = null;
                });
            }
            patientNameInput.value = state.activePatientName;

            state.poseDataLog = session.poseData;
            state.pxToCmRatio = session.pxToCmRatio || null;
            // 2026-08-03追加: 4隅ArUco床面ホモグラフィもpxToCmRatioと同じ
            // 理由で、このセッションが撮影された時点の値へ揃える
            // （js/core/arucoCalibration.js参照）。
            state.floorHomography = session.floorHomography || null;
            // 2026-08-05追加: 研究機関向け「静止姿勢: アルコ正中線モード」。
            // pxToCmRatio/floorHomographyと同じ考え方で、このセッションが
            // 撮影された時点に実際に使われていた値（無ければnull＝
            // このセッションでは従来の両足基準だった）へ揃える。
            state.arucoMidlineX = (typeof session.capturedArucoMidlineX === 'number') ? session.capturedArucoMidlineX : null;
            state.arucoMidlineY = (typeof session.capturedArucoMidlineY === 'number') ? session.capturedArucoMidlineY : null;
            state.useArucoMidline = typeof session.capturedArucoMidlineX === 'number';
            state.estimatedPelvicTilt = session.pelvicTilt || 0;

            state.activeExpertComment = session.expertComment || "";
            state.activeExpertExercises = session.expertExercises || "";

            heightInput.value = session.height || 170;
            footSizeInput.value = session.footSize || 25;

            state.playbackDataMP = state.poseDataLog.filter(function (d) { return d.mode === session.mode; });
            if (state.playbackDataMP.length === 0) state.playbackDataMP = state.poseDataLog;

            document.getElementById('historyPanel').style.display = 'none';
            if (state.playbackDataMP.length > 1) {
                state.playbackBaseTime = state.playbackDataMP[0].time;
                state.playbackTotalDuration = state.playbackDataMP[state.playbackDataMP.length - 1].time - state.playbackBaseTime;
            } else {
                state.playbackBaseTime = 0;
                state.playbackTotalDuration = 0;
            }

            var maxFrames = state.playbackDataMP.length - 1;
            document.getElementById('timelineSlider').max = maxFrames > 0 ? maxFrames : 0;
            document.getElementById('timelineSlider').value = 0;

            // 骨格点の座標は撮影時点のcanvasMPの実解像度（カメラの実測解像度）を
            // そのままの生ピクセル値で記録されている。再生時のcanvasMPが
            // その解像度と異なると（例:履歴を開いた時点でカメラが起動しておらず
            // canvasMPが既定値のままの場合)、撮影時に写っていた画角のごく
            // 一部だけが拡大されたように描画されてしまう（2026-07-30の
            // ご指摘）。canvasMPはCSS側で常にobject-fit:containで表示枠に
            // 収める作りのため、内部解像度を撮影時と同じ値に戻すだけで、
            // 元の画角のまま正しく再生できるようになる。
            //
            // 2026-08-03の追加対応: canvasMPはアプリ全体で使い回される共有の
            // canvas要素のため、session.canvasWidth/Heightを持たない古いデータ
            // （v4.6.25より前に保存されたもの）を開いた場合、これまでは
            // if文の条件を満たさずcanvasMPの解像度を一切変更していなかった。
            // その結果、直前に別の（解像度が異なる）セッションを見ていた場合
            // その時の解像度がそのまま残ってしまい、今回のセッションの骨格点
            // 座標とcanvasMPの解像度が食い違って、骨格が想定より大きく
            // ズレた位置（最悪の場合は表示枠の外）に描画され、「COPレーダーは
            // 動くのに棒人間だけ表示されない」ように見える不具合につながって
            // いた（重心動揺モードの検証中に発覚。COPレーダーは相対的な
            // パーセンテージで位置を計算するため解像度のズレの影響を受けないが、
            // 骨格点の描画は生のピクセル座標をそのまま使うため直接影響を受ける）。
            // 「そのままにしておく」のではなく、解像度情報が無い場合は
            // アプリが通常カメラにリクエストしている解像度(1920x1080)へ
            // 明示的にリセットすることで、少なくとも「直前に見ていた別
            // セッションの解像度を誤って引き継ぐ」ことは無くす。
            if (session.canvasWidth && session.canvasHeight) {
                canvasMP.width = session.canvasWidth;
                canvasMP.height = session.canvasHeight;
            } else {
                canvasMP.width = 1920;
                canvasMP.height = 1080;
            }

            // 履歴から特定の1ポーズ（前面/左側面/後面/右側面いずれか）を
            // ピンポイントで読み込んで確認している状態であることを明示する。
            // これによりupdateModeUI側で「連続撮影中の次へプロンプト」を出さず、
            // 再生・微調整・書き出し系ツールを常に表示できる。
            state.isHistoryPlaybackSession = true;
            state.appMode = 'playback';

            // 新しくセッションを読み込むタイミングなので、再生スピード・
            // 写真背景表示は毎回1倍/OFFへ戻す（recorder.jsのstopRecordingでも
            // 同様にリセットする）。
            state.playbackSpeed = 1;
            state.showPhotoBackground = false;
            var speedSelectEl = document.getElementById('playbackSpeedSelect');
            if (speedSelectEl) speedSelectEl.value = '1';

            updateModeUI(session.mode);

            document.getElementById('mainControls').style.display = 'none';
            document.getElementById('playbackControls').style.display = 'flex';
            document.getElementById('startBtn').style.display = 'none';
            document.getElementById('recBtn').style.display = 'none';
            document.getElementById('downloadCsvBtn').disabled = false;

            // 撮影直後の確認画面（js/core/recorder.jsのstopRecording）は自動再生
            // せず、最後のフレームを静止表示した状態で「▶ 再生」を押すのを待つ
            // 作りになっている。ここも合わせて自動再生はせず、frame 0を静止
            // 表示するだけにする（v4.6.18）。
            // 以前はここでtogglePlay(true)により自動再生していたが、これだと
            // 画面を開いた瞬間から既に再生中（ボタン表示は「⏸ 一時停止」）に
            // なるため、ユーザーが「▶ 再生」のつもりでボタンを押すと実際には
            // 一時停止してしまい、その状態で「🖼 写真を表示」をONにすると、
            // 停止したフレームの上に写真が重なって表示されるだけで骨格点が
            // 全く動かないように見える、という報告があった（企画者確認・
            // 2026-07-28）。togglePlay(false)を明示的に呼び、ボタン表示・
            // isPlaying・進行中のアニメーションフレームを確実に「未再生」の
            // 状態に揃えておく。
            renderPlaybackFrame(0);
            togglePlay(false);
        }
    } catch (e) {
        console.error("Load session error", e);
        alert("データの読み込みに失敗しました。\nエラー詳細: " + e.message);
    }
};

/**
 * 履歴の「レポート」アクション: AIレポート(ダッシュボード)はページ遷移に
 * 依存しない全画面オーバーレイなので、履歴ページに留まったまま開ける。
 */
window.viewSessionReport = async function (id) {
    state.editReturnTarget = 'history';
    // 直前に履歴の4面まとめ画面からレポートを開いていた場合の
    // dashboardReturnTargetが万一残っていても、この単独セッションの
    // レポートは単純に閉じるだけでよいのでクリアしておく
    // （js/ui/batchReview.js参照）。
    state.dashboardReturnTarget = null;
    // 同様に、multiViewSessionIdsが万一残っていても、この単独セッションの
    // レポートには「4方向総合所見」を出さない（js/ui/dashboard.js参照）。
    state.multiViewSessionIds = null;
    await window.loadSession(id);
    if (window.prepareAndPrintReport) window.prepareAndPrintReport();
};

/**
 * 履歴の「再生」アクション: 骨格再生・タイムライン操作は撮影ページの
 * canvasMP上で行うため、撮影ページへ遷移したうえで結果ビューを表示する。
 */
window.viewSessionPlayback = async function (id) {
    state.editReturnTarget = 'history';
    await window.loadSession(id);
    navigate('shoot');
    if (window.__enterShootResultView) window.__enterShootResultView();
};
