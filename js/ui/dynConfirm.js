/**
 * dynConfirm.js
 * ---------------------------------------------------------------------------
 * 動作解析（動的種目）の「撮影確認」画面。js/ui/batchReview.js（静止4方向の
 * 4面確認・修正画面）と全く同じ役割・同じ見た目の専用オーバーレイを、
 * 動作解析1件用に用意したもの。
 *
 * 2つの入り口を持つ（batchReview.jsの'live'/'history'の2モードと同じ考え方）:
 *   - 'live'   : 撮影完了直後（未確定、status:'draft'のまま）。結果バナーの
 *                「✅ 決定して確認画面へ」から呼ばれる。「🔍 確認」「🔁 撮り
 *                直す」＋「📊 CSV書き出し」「✅ この内容で確定してレポート
 *                作成」を出す。
 *   - 'history': 履歴一覧からこのモードのデータをタップした時（v4.6.24〜）。
 *                確定済み(final)か未確定(draft)かに応じて「📄 レポートを
 *                見る」「✅ この内容で確定してレポート作成」を出し分け、
 *                「🔁 撮り直す」の代わりに「✖ 閉じる」を出す。
 *
 * 撮影完了直後は内部的にはdraft保存のみで、履歴一覧にはまだ出さない
 * (js/data/dataService.js参照)。ここでサムネイルを確認し、「🔍 確認」で
 * 詳細な再生・微調整画面（静止4方向の「✂️ 微調整」と同じ画面）を開ける。
 * 「✅ 撮影確定」を押した時点で初めて履歴一覧に表示され（status: draft →
 * final）、レポートが自動的に開く（batchReview.jsのfinalizeBatch()と同じ
 * 挙動）。
 *
 * 2026-07-29のご要望「動作解析も静止姿勢と全く同じ、撮影→確認画面→
 * 再生/微調整/CSV/確定というフローにしたい」への対応（v4.6.23）。続けて
 * 「履歴からタップした時も同じ確認画面→レポートというフローにしたい。
 * 自分が今どの画面で何をしているか分かることが使いやすさにつながる」との
 * 追加要望を受け、履歴モードを追加した（v4.6.24）。
 */

import { state, reportDataStore, MODE_NAMES_JP } from '../core/state.js';
import { navigate } from './router.js';
import biomechanics from '../biomechanics.js';
import { drawPoseOverlay } from './controls.js';

var _dataService = null;
var _controlsMod = null;

// 'live'   : 撮影直後・未確定の撮影確認画面（従来通り、reportDataStore参照）
// 'history': 履歴一覧からこのモードのデータをタップした表示（_historySession参照）
var _viewMode = 'live';
var _currentSessionId = null;
var _currentMode = null;
var _historySession = null; // 履歴モードの時だけ、dataService.getSessionFull()の結果を保持

export function initDynConfirm(dataService, controlsMod) {
    _dataService = dataService;
    _controlsMod = controlsMod;

    var csvBtn = document.getElementById('dynConfirmCsvBtn');
    if (csvBtn) csvBtn.onclick = exportCsv;

    var finalizeBtn = document.getElementById('dynConfirmFinalizeBtn');
    if (finalizeBtn) finalizeBtn.onclick = finalizeSession;

    var reportBtn = document.getElementById('dynConfirmReportBtn');
    if (reportBtn) reportBtn.onclick = viewHistoryReport;

    var closeBtn = document.getElementById('dynConfirmCloseBtn');
    if (closeBtn) closeBtn.onclick = closeHistoryView;

    // recorder.js(撮影完了フック)・shootFlow.js(結果バナーの「決定して
    // 確認画面へ」)・history.js(履歴一覧からのタップ)・controls.js(微調整
    // 画面から戻る)からモジュールをまたいで呼べるよう window に生やす
    // （既存の window.__showBatchReviewScreen 等と同じブリッジパターン）。
    window.__showDynConfirmScreen = showDynConfirmScreen;
    window.__showDynConfirmHistoryView = showDynConfirmHistoryView;
}

/**
 * sessionId/modeを渡した時（撮影直後、結果バナーの「✅ 決定して確認画面へ」
 * から呼ばれた時）は、それをこの画面が扱う対象として記録する。省略時
 * （微調整画面から保存して戻ってきた時）は、直前に記録済みの対象をそのまま
 * 使う。
 */
function showDynConfirmScreen(sessionId, mode) {
    if (sessionId) {
        _currentSessionId = sessionId;
        _currentMode = mode;
    }
    _viewMode = 'live';
    _historySession = null;
    renderCard();
    updateHeaderForMode();
    openOverlay();
}

/**
 * 履歴一覧からこのモード（動作解析）のデータをタップした時に呼ばれる
 * （v4.6.24、js/ui/history.jsのwindow.viewDynSessionConfirm参照）。
 * sessionIdを渡した時（新規に開く時）はdataServiceから読み直し、省略時
 * （微調整画面から保存して戻ってきた時）は直前の対象を最新の状態に読み直す
 * （joint位置やstatusが変わっている可能性があるため）。
 */
async function showDynConfirmHistoryView(sessionId) {
    if (!_dataService) return;

    var targetId = sessionId || _currentSessionId;
    if (!targetId) return;

    try {
        var session = await _dataService.getSessionFull(targetId);
        if (!session) {
            alert("データの読み込みに失敗しました。");
            return;
        }
        _currentSessionId = targetId;
        _currentMode = session.mode;
        _historySession = session;
    } catch (e) {
        console.error('[dynConfirm] Failed to load session for history view', e);
        alert("データの読み込みに失敗しました。");
        return;
    }

    _viewMode = 'history';
    renderCard();
    updateHeaderForMode();
    openOverlay();
}

function openOverlay() {
    var overlay = document.getElementById('dynConfirmOverlay');
    if (overlay) overlay.style.display = 'block';

    // 撮影ライブ画面・結果バナーはこのオーバーレイの下に隠れるだけで
    // 十分だが(#dynConfirmOverlayはposition:fixed; inset:0で完全に覆う)、
    // 念のためbodyのライブビュー専用クラスも解除しておく
    // (#batchReviewOverlayを開く時と同様の考え方)。
    var liveView = document.getElementById('shootLiveView');
    if (liveView) liveView.classList.remove('active');
    var resultBanner = document.getElementById('shootResultBanner');
    if (resultBanner) resultBanner.classList.remove('active');
    document.body.classList.remove('shoot-live-active');
}

/**
 * 履歴一覧の「✖ 閉じる」から呼ばれる。batchReview.jsのcloseHistoryBatchView
 * と同じ役割。この閉じるボタンはupdateHeaderForModeにより_viewMode==='history'
 * の時にしか表示されないため、常に「履歴一覧から来た」と判断してよい。
 *
 * 2026-08-03追加: 以前はオーバーレイを隠すだけで、裏のshoot画面へは何も
 * 遷移させていなかった。ところが履歴からこの画面を開いて「🔍 確認」→
 * 「✅ 保存して確認画面へ戻る」を経由した場合、その戻り先
 * （window.__showDynConfirmHistoryView）はnavigate()を呼ばないため、
 * #shootSetupView・#shootLiveViewのどちらも.activeが付かないまま。その
 * 状態でオーバーレイを閉じると、「撮影」という見出しだけの真っ黒な画面が
 * 見えてしまっていた。navigate('history')で履歴一覧へ明示的に戻すことで、
 * 「閉じる＝元の履歴一覧へ戻る」という一貫した挙動にする。
 */
function closeHistoryView() {
    var overlay = document.getElementById('dynConfirmOverlay');
    if (overlay) overlay.style.display = 'none';
    _viewMode = 'live';
    _historySession = null;
    navigate('history');
}

/**
 * ヘッダー（タイトル・CSV/レポート/確定/閉じるボタンの出し分け）を、
 * live/historyのモードと（historyの場合は）確定済みかどうかで切り替える。
 * batchReview.jsのupdateHeaderForModeと同じ考え方。
 */
function updateHeaderForMode() {
    var titleEl = document.getElementById('dynConfirmTitle');
    var subEl = document.getElementById('dynConfirmSubtitle');
    var finalizeBtn = document.getElementById('dynConfirmFinalizeBtn');
    var reportBtn = document.getElementById('dynConfirmReportBtn');
    var closeBtn = document.getElementById('dynConfirmCloseBtn');

    if (_viewMode === 'history' && _historySession) {
        var isFinal = _historySession.status !== 'draft';
        var modeLabel = MODE_NAMES_JP[_currentMode] || _currentMode;
        var patName = _historySession.patientName || 'ゲスト';
        if (titleEl) titleEl.innerText = "📂 " + patName + " 様 — " + modeLabel;
        if (subEl) subEl.innerText = isFinal
            ? "内容を確認し、必要であればレポートを閲覧・詳細を微調整できます"
            : "まだ確定していないデータです。内容を確認し、必要であれば確定してください";
        if (finalizeBtn) finalizeBtn.style.display = isFinal ? 'none' : '';
        if (reportBtn) reportBtn.style.display = isFinal ? '' : 'none';
        if (closeBtn) closeBtn.style.display = '';
    } else {
        if (titleEl) titleEl.innerText = "🎬 撮影確認";
        if (subEl) subEl.innerText = "内容を確認し、必要であれば詳細を見てから確定してください";
        if (finalizeBtn) finalizeBtn.style.display = '';
        if (reportBtn) reportBtn.style.display = 'none';
        if (closeBtn) closeBtn.style.display = 'none';
    }
}

function renderCard() {
    var grid = document.getElementById('dynConfirmGrid');
    if (!grid || !_currentMode) return;
    grid.innerHTML = '';

    var base64;
    var kps = null;
    if (_viewMode === 'history' && _historySession) {
        base64 = (_historySession.images && _historySession.images[_currentMode]) ? _historySession.images[_currentMode] : null;
        // 2026-08-25追加: 写真が「クリーンな写真」形式（photoFormat===
        // 'clean_v1'）で、かつ骨格点データが揃っている場合のみ、その場で
        // 骨格オーバーレイを重ね描きする（js/ui/batchReview.jsのrenderGridと
        // 同じ考え方）。旧形式（骨格線等が写真に焼き込み済み）はそのまま表示。
        if (_historySession.photoFormat === 'clean_v1' && _historySession.poseData && _historySession.poseData.length > 0) {
            kps = _historySession.poseData[_historySession.poseData.length - 1].keypoints;
        }
    } else {
        var liveEntry = reportDataStore[_currentMode];
        base64 = (liveEntry && liveEntry.capturedImage) ? liveEntry.capturedImage : null;
        // ライブ撮影中はreportDataStore[mode]自体が骨格点配列（かつ末尾に
        // capturedImage等のプロパティを持つ）なので、常に最新の骨格点が
        // 入っている。
        if (liveEntry && Array.isArray(liveEntry) && liveEntry.length > 0) kps = liveEntry;
    }
    var modeLabel = MODE_NAMES_JP[_currentMode] || _currentMode;
    var isDraftInHistory = _viewMode === 'history' && _historySession && _historySession.status === 'draft';

    var actionsHtml = '<button type="button" class="btn orange-btn" id="dynConfirmEditBtn">🔍 確認</button>';
    if (_viewMode === 'live') {
        actionsHtml += '<button type="button" class="btn gray-btn" id="dynConfirmRetakeBtn">🔁 撮り直す</button>';
    }

    var card = document.createElement('div');
    card.className = 'batch-review-card';
    card.innerHTML =
        (base64
            ? '<img class="dyn-confirm-photo" src="' + base64 + '" alt="' + modeLabel + '">'
            : '<div class="batch-review-noimg">画像なし</div>') +
        '<div class="batch-review-label">' + modeLabel + (isDraftInHistory ? ' <span class="history-draft-badge">未確定</span>' : '') + '</div>' +
        '<div class="batch-review-actions">' + actionsHtml + '</div>';
    grid.appendChild(card);

    // 2026-08-25追加: 骨格点データが揃っている場合、クリーンな写真の上に
    // その場で骨格オーバーレイを重ね描きしてから差し替える（動作解析は
    // roll補正の対象外のため常にrollDeg=nullで回転はしない）。
    if (base64 && kps) {
        var currentModeForClosure = _currentMode;
        biomechanics.renderPhotoWithOverlay(base64, function (ctx, w, h) {
            drawPoseOverlay(ctx, kps, currentModeForClosure, w, h);
        }, null).then(function (composited) {
            if (!composited) return;
            var imgEl = grid.querySelector('.dyn-confirm-photo');
            if (imgEl) imgEl.src = composited;
        });
    }

    var editBtn = document.getElementById('dynConfirmEditBtn');
    if (editBtn) editBtn.onclick = openForEdit;
    var retakeBtn = document.getElementById('dynConfirmRetakeBtn');
    if (retakeBtn) retakeBtn.onclick = retake;
}

/**
 * 「🔍 確認」から呼ばれる。batchReview.jsのopenPoseForEdit()と同じ考え方で、
 * history.jsのloadSession()を再利用しつつ、戻り先だけこの画面に差し替える
 * （controls.jsのupdateModeUIがstate.editReturnTargetを見て、専用の「戻る」
 * ボタンを出す）。liveモードでは'dynConfirm'（保存時は必ずdraftのまま）、
 * historyモードでは'dynConfirmHistory'（保存時は元のstatusを維持）を使う。
 * loadSession()はstate.isHistoryPlaybackSessionを立てるため、
 * window.__enterShootResultView()は結果バナー無しの再生・微調整ツール一式の
 * 画面を出す（batchReview側の個別ポーズ確認と同じ挙動）。
 */
async function openForEdit() {
    if (!_currentSessionId || !window.loadSession) return;

    state.editReturnTarget = (_viewMode === 'history') ? 'dynConfirmHistory' : 'dynConfirm';

    var overlay = document.getElementById('dynConfirmOverlay');
    if (overlay) overlay.style.display = 'none';

    await window.loadSession(_currentSessionId);
    navigate('shoot');
    if (window.__enterShootResultView) window.__enterShootResultView();
}

/**
 * 「🔁 撮り直す」から呼ばれる（liveモードのみ）。この動作解析はまだ確定
 * していないdraftのままなので（撮り直しても新規セッションとして保存される
 * だけで、古いdraftはそのまま残る＝結果バナーの「🔁 再測定」を直接押した
 * 場合と同じ挙動）、controls.jsのexitPlaybackMode()でライブカメラへ戻す
 * だけでよい。
 */
function retake() {
    var overlay = document.getElementById('dynConfirmOverlay');
    if (overlay) overlay.style.display = 'none';

    navigate('shoot');
    if (_controlsMod && _controlsMod.exitPlaybackMode) {
        _controlsMod.exitPlaybackMode();
    }
}

/**
 * 「📊 CSV書き出し」から呼ばれる（live/history共通）。1件（動作解析1回分）
 * の生座標データをCSVで書き出す。既存のhistory.jsのwindow.exportSessionCsv
 * と同じ形式。
 */
async function exportCsv() {
    if (!_currentSessionId || !_dataService) return;

    var btn = document.getElementById('dynConfirmCsvBtn');
    var originalLabel = btn ? btn.innerText : '';
    if (btn) { btn.disabled = true; btn.innerText = '書き出し中...'; }

    try {
        var session = await _dataService.getSessionFull(_currentSessionId);
        if (session && session.poseData) {
            var rows = "Timestamp,Mode,PointID,PointName,X,Y\n";
            session.poseData.forEach(function (d) {
                (d.keypoints || []).forEach(function (kp, idx) {
                    if (kp) rows += d.time + "," + d.mode + "," + idx + "," + (kp.name || idx) + "," + kp.x.toFixed(1) + "," + kp.y.toFixed(1) + "\n";
                });
            });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([rows], { type: 'text/csv' }));
            a.download = "athletecore_data_" + (session.patientName || 'guest') + "_" + session.mode + "_" + session.timestamp + ".csv";
            a.click();
        } else {
            alert("CSVに書き出せる計測データがまだありません。");
        }
    } catch (e) {
        console.error('[dynConfirm] CSV export failed', e);
        alert("CSVの書き出しに失敗しました。通信状態をご確認のうえ、もう一度お試しください。");
    }

    if (btn) { btn.disabled = false; btn.innerText = originalLabel; }
}

/**
 * 履歴モードの「📄 レポートを見る」から呼ばれる（確定済み(final)の時だけ
 * 表示されるボタン）。batchReview.jsのviewHistoryBatchReport()と同じ考え方で、
 * _historySessionの内容を一時的にstate/reportDataStoreへ書き込んでから
 * window.prepareAndPrintReport()を呼ぶ。閉じた後はこの確認画面へ戻れるよう
 * state.dashboardReturnTargetに'dynConfirmHistory'を残す（js/ui/dashboard.js
 * 参照）。
 */
async function viewHistoryReport() {
    if (_viewMode !== 'history' || !_historySession) return;

    var reportBtn = document.getElementById('dynConfirmReportBtn');
    var originalLabel = reportBtn ? reportBtn.innerText : '';
    if (reportBtn) { reportBtn.disabled = true; reportBtn.innerText = '読込中...'; }

    try {
        if (_historySession.images && _historySession.images[_currentMode]) {
            if (!reportDataStore[_currentMode]) reportDataStore[_currentMode] = {};
            reportDataStore[_currentMode].capturedImage = _historySession.images[_currentMode];
        }

        state.currentTab = _currentMode;
        state.playbackDataMP = _historySession.poseData || [];
        state.estimatedPelvicTilt = _historySession.pelvicTilt || 0;
        state.pxToCmRatio = _historySession.pxToCmRatio || null;
        // 2026-08-03追加: 重心動揺(sway)のレポートで実寸mm指標
        // （js/api.js参照）を出すのに使う、このセッション撮影時点の
        // 4隅ArUco床面ホモグラフィ。window.prepareAndPrintReport()が
        // state.floorHomographyから組み立てるため、pxToCmRatioと同じく
        // ここで揃えておく必要がある。
        state.floorHomography = _historySession.floorHomography || null;
        // 2026-08-05追加: 研究機関向け「静止姿勢: アルコ正中線モード」。
        // pxToCmRatio/floorHomographyと同じ考え方で、このセッションが
        // 撮影された時点の値へ揃えてからprepareAndPrintReport()を呼ぶ。
        state.arucoMidlineX = (typeof _historySession.capturedArucoMidlineX === 'number') ? _historySession.capturedArucoMidlineX : null;
        state.arucoMidlineY = (typeof _historySession.capturedArucoMidlineY === 'number') ? _historySession.capturedArucoMidlineY : null;
        state.useArucoMidline = typeof _historySession.capturedArucoMidlineX === 'number';
        // 2026-08-05追加（不具合修正）: js/ui/dashboard.jsのactiveSessionが
        // capturedRollDeg/canvasWidth/Heightのステージングフィールドを読む
        // ようになったことに伴い、この画面（動作解析）でも明示的にセット
        // しておく。動作解析（動的種目）はjs/core/recorder.js側で常に
        // capturedRollDeg: nullとして保存される（roll補正は静止4方向のみ
        // 対象）ため、ここでは常にnullで揃える。以前の別セッション
        // （静止4方向の履歴レポート等）を見た際に残った値が誤って
        // 引き継がれてしまわないようにする意味もある。
        state.activeSessionCapturedRollDeg = null;
        state.activeSessionCanvasWidth = null;
        state.activeSessionCanvasHeight = null;
        state.activeExpertComment = _historySession.expertComment || "";
        state.activeExpertExercises = _historySession.expertExercises || "";
        state.activePatientName = _historySession.patientName || "ゲスト";

        var patientNameInputEl = document.getElementById('patientName');
        var heightInputEl = document.getElementById('patientHeight');
        var footSizeInputEl = document.getElementById('footSize');
        if (patientNameInputEl) patientNameInputEl.value = state.activePatientName;
        if (heightInputEl) heightInputEl.value = _historySession.height || 170;
        if (footSizeInputEl) footSizeInputEl.value = _historySession.footSize || 25;

        // レポート(dashboardOverlay)とこの確認画面(dynConfirmOverlay)は
        // 同じz-indexを使っており、両方display:blockのままだとDOM順で後の
        // dynConfirmOverlayがレポートの上に被ってしまう。ここで隠しておき、
        // レポートを閉じた時にstate.dashboardReturnTargetを見て呼び直す
        // (js/ui/batchReview.jsのhistoryBatchと同じパターン)。
        var overlay = document.getElementById('dynConfirmOverlay');
        if (overlay) overlay.style.display = 'none';
        state.dashboardReturnTarget = 'dynConfirmHistory';
        state.multiViewSessionIds = null;

        if (window.prepareAndPrintReport) await window.prepareAndPrintReport();
    } catch (e) {
        console.error('[dynConfirm] Failed to open history report', e);
        alert("レポートの表示に失敗しました。");
    } finally {
        if (reportBtn) { reportBtn.disabled = false; reportBtn.innerText = originalLabel; }
    }
}

/**
 * 「✅ この内容で確定してレポート作成」から呼ばれる（live/history共通、
 * historyモードでは未確定のデータにのみ表示される）。batchReview.jsの
 * finalizeBatch()と同じく、確定(status: draft→final)した直後に自動で
 * レポートを開く。レポートはこの時点でまだ画面上に残っている現在の
 * ライブ状態（state.playbackDataMP等、撮影直後またはopenForEdit経由の
 * 微調整後の値がそのまま残っている）を使って生成する
 * （履歴からの単独レポート表示window.viewSessionReportと同じ考え方）。
 */
async function finalizeSession() {
    if (!_currentSessionId || !_dataService) return;

    var btn = document.getElementById('dynConfirmFinalizeBtn');
    var originalLabel = btn ? btn.innerText : '';
    if (btn) { btn.disabled = true; btn.innerText = '確定中...'; }

    try {
        await _dataService.finalizeSession(_currentSessionId);
    } catch (e) {
        console.error('[dynConfirm] finalize failed', e);
    }

    if (btn) { btn.disabled = false; btn.innerText = originalLabel; }

    if (typeof window.refreshHistoryList === 'function') window.refreshHistoryList();

    var overlay = document.getElementById('dynConfirmOverlay');
    if (overlay) overlay.style.display = 'none';

    // 単独の動作解析レポートなので「4方向総合所見」は出さない
    // (js/ui/dashboard.js参照)。
    state.multiViewSessionIds = null;
    state.currentTab = _currentMode;
    // 2026-08-05追加（不具合修正）: 動作解析は常にroll補正の対象外
    // （js/core/recorder.js参照）。上のviewHistoryReport()と同じ理由で、
    // 前に見ていた別セッションの値が誤って残らないよう明示的にnullで
    // 揃える（js/ui/dashboard.js参照）。
    state.activeSessionCapturedRollDeg = null;
    state.activeSessionCanvasWidth = null;
    state.activeSessionCanvasHeight = null;

    if (window.prepareAndPrintReport) window.prepareAndPrintReport();
}
