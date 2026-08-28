/**
 * batchReview.js
 * ---------------------------------------------------------------------------
 * 前面・左側面・後面・右側面の4方向を撮り終えた直後に出す「確認・修正」
 * 画面。撮影中は各ポーズが内部的には都度draft保存されており（履歴一覧には
 * まだ出さない）、ここで4枚を並べて確認し、気になるポーズがあれば
 * 「🔍 詳細を見る」（再生・D-padでの関節点微調整・動画/CSV書き出し・
 * レポート閲覧ができる個別ポーズの詳細画面を開く。2026-08-25、旧ラベル
 * 「✂️ 微調整」からリネーム。実際には微調整だけでなく詳細確認全般の
 * 入口になっているため）や「🔁 撮り直す」（1ポーズだけ再撮影・上書き）が
 * できる。「✅ この内容で確定」を押した時点で初めて履歴一覧に表示され
 * （status: draft → final）、レポートが生成される。
 *
 * v4.6.14より、同じ画面（同じグリッドUI）を履歴側からも呼べるようにした
 * （履歴の「4面まとめ」表示から個別ポーズを閲覧・微調整する用途、
 * _viewMode==='history'）。確定済みデータの閲覧なので「🔁 撮り直す」
 * 「✅ この内容で確定」は表示せず、代わりに「✖ 閉じる」を出す。
 */

import { state, reportDataStore } from '../core/state.js';
import { navigate } from './router.js';
import biomechanics from '../biomechanics.js';
import { drawPoseOverlay } from './controls.js';

var MODE_LABELS = { front: '前面', l_side: '左側面', back: '後面', r_side: '右側面' };
var MODE_ORDER = ['front', 'l_side', 'back', 'r_side'];

var _dataService = null;
var _controlsMod = null;

// 'live'   : 撮影直後・未確定の4面確認画面（従来通り、state.currentBatchSessionIds参照）
// 'history': 履歴の4面まとめ表示（確定済み、_historyBatchIds/_historyImages参照）
var _viewMode = 'live';
var _historyBatchIds = null;
var _historyImages = {};
// 2026-08-24追加: _historyImagesと対になる、各方向自身のセッションが
// 持つroll角度のキャッシュ（js/biomechanics.jsのrenderUprightPhoto用）。
var _historyRollDegs = {};
var _historyPatientName = '';
// 2026-08-25追加: _historyImagesと対になる、各方向自身のセッションが
// 持つposeData（骨格点の最終フレーム）とphotoFormat（'clean_v1'/旧形式）の
// キャッシュ。骨格オーバーレイをサムネイル・レポートへその場で重ね描き
// する（js/ui/controls.jsのdrawPoseOverlay・js/biomechanics.jsの
// renderPhotoWithOverlay）ために使う。photoFormatが'clean_v1'でない
// （＝v4.9.14以前の旧形式で、写真に骨格線等が既に焼き込み済み）場合は、
// 重ね描きすると二重になってしまうため使わない（renderGrid/
// viewHistoryBatchReport参照）。
var _historyPoseData = {};
var _historyPhotoFormat = {};

export function initBatchReview(dataService, controlsMod) {
    _dataService = dataService;
    _controlsMod = controlsMod;

    var finalizeBtn = document.getElementById('batchReviewFinalizeBtn');
    if (finalizeBtn) finalizeBtn.onclick = finalizeBatch;

    var csvBtn = document.getElementById('batchReviewCsvBtn');
    if (csvBtn) csvBtn.onclick = exportBatchCsv;

    var closeBtn = document.getElementById('batchReviewCloseBtn');
    if (closeBtn) closeBtn.onclick = closeHistoryBatchView;

    var reportBtn = document.getElementById('batchReviewReportBtn');
    if (reportBtn) reportBtn.onclick = viewHistoryBatchReport;

    // recorder.js(撮影完了フック)・controls.js(撮り直し確認画面)・
    // history.js(履歴の4面まとめ表示)から モジュールをまたいで呼べるよう
    // window に生やす（既存の window.__onSessionSaved 等と同じブリッジ
    // パターン）。
    window.__showBatchReviewScreen = showBatchReviewScreen;
    window.__showHistoryBatchView = showHistoryBatchView;
}

function showBatchReviewScreen() {
    _viewMode = 'live';
    renderGrid();
    updateHeaderForMode();
    var overlay = document.getElementById('batchReviewOverlay');
    if (overlay) overlay.style.display = 'block';
}

/**
 * 履歴の「4面まとめ」一覧から呼ばれる。idsを渡した時（新規に開く時）は
 * 各ポーズ自身の保存済み画像を取得し直す。ids省略時（微調整画面から
 * 保存して戻ってきた時）は、直前に取得済みのキャッシュをそのまま使う。
 */
export async function showHistoryBatchView(ids, patientName) {
    if (ids) {
        _historyBatchIds = ids;
        _historyPatientName = patientName || 'ゲスト';
        _historyImages = {};
        _historyRollDegs = {};
        _historyPoseData = {};
        _historyPhotoFormat = {};
        for (var i = 0; i < MODE_ORDER.length; i++) {
            var mode = MODE_ORDER[i];
            var sid = ids[mode];
            if (!sid || !_dataService) continue;
            try {
                var session = await _dataService.getSessionFull(sid);
                // 各ポーズ自身のセッションレコードは、必ずそのポーズ自身の
                // 画像を持っている（撮影直後にcaptureSkeletonImageしてから
                // 保存されるため）。他のモードの画像が混ざっていないか気に
                // せず、常に「そのmodeのid」→「そのmodeの画像」で引く。
                if (session && session.images && session.images[mode]) _historyImages[mode] = session.images[mode];
                // 2026-08-24追加: 写真とセットで、そのポーズ自身が撮影された
                // 時点のroll角度も控えておく（js/biomechanics.jsの
                // renderUprightPhoto用）。
                if (session) _historyRollDegs[mode] = (typeof session.capturedRollDeg === 'number') ? session.capturedRollDeg : null;
                // 2026-08-25追加: 骨格オーバーレイをその場で重ね描きするための
                // posedata・photoFormatも控えておく（上のコメント参照）。
                if (session) {
                    _historyPoseData[mode] = session.poseData || [];
                    _historyPhotoFormat[mode] = session.photoFormat || null;
                }
            } catch (e) {
                console.error('[batchReview] Failed to load history batch image for', mode, e);
            }
        }
    }
    _viewMode = 'history';
    renderGrid();
    updateHeaderForMode();
    var overlay = document.getElementById('batchReviewOverlay');
    if (overlay) overlay.style.display = 'block';
}

/**
 * 2026-08-03追加: 以前はオーバーレイを隠すだけで、裏のshoot画面へは何も
 * 遷移させていなかった（dynConfirm.jsのcloseHistoryViewと同じ経緯・同じ
 * 修正、詳細はそちら参照）。この閉じるボタンはupdateHeaderForModeにより
 * _viewMode==='history'の時にしか表示されないため、常に「履歴一覧から
 * 来た」と判断してよく、navigate('history')で履歴一覧へ明示的に戻す。
 */
function closeHistoryBatchView() {
    var overlay = document.getElementById('batchReviewOverlay');
    if (overlay) overlay.style.display = 'none';
    _viewMode = 'live';
    _historyBatchIds = null;
    _historyImages = {};
    _historyRollDegs = {};
    _historyPoseData = {};
    _historyPhotoFormat = {};
    _historyPatientName = '';
    navigate('history');
}

function updateHeaderForMode() {
    var titleEl = document.getElementById('batchReviewTitle');
    var subEl = document.getElementById('batchReviewSubtitle');
    var finalizeBtn = document.getElementById('batchReviewFinalizeBtn');
    var closeBtn = document.getElementById('batchReviewCloseBtn');
    var reportBtn = document.getElementById('batchReviewReportBtn');

    if (_viewMode === 'history') {
        if (titleEl) titleEl.innerText = "📂 " + _historyPatientName + " 様 — 4面測定データ";
        if (subEl) subEl.innerText = "各ポーズの微調整や、4面まとめてのCSV書き出し・レポート閲覧ができます（確定済みデータの閲覧）";
        if (finalizeBtn) finalizeBtn.style.display = 'none';
        if (closeBtn) closeBtn.style.display = '';
        if (reportBtn) reportBtn.style.display = '';
    } else {
        if (titleEl) titleEl.innerText = "✅ 4面 撮影完了 — 確認・修正";
        if (subEl) subEl.innerText = "気になるポーズがあれば、確定する前に個別に微調整・撮り直しができます";
        if (finalizeBtn) finalizeBtn.style.display = '';
        if (closeBtn) closeBtn.style.display = 'none';
        if (reportBtn) reportBtn.style.display = 'none';
    }
}

/**
 * 履歴の4面まとめ画面の「📄 レポートを見る」から呼ばれる。4面のうち
 * なるべく前面(front)を代表として使い、その1ポーズぶんの指標(荷重
 * バランス等)でレポートを生成する。画像ギャラリーだけは4面ぶん表示される
 * （window.prepareAndPrintReportが元々reportDataStoreの4モード分を見る
 * 作りのため）。4面まとめての統合指標計算は今回のスコープ外
 * （PRODUCT_REQUIREMENTS.md参照）。ライブ確定直後に出るレポートも同じ
 * 「代表1ポーズの指標＋4面分の画像」という構成のため、挙動に一貫性がある。
 */
async function viewHistoryBatchReport() {
    if (_viewMode !== 'history' || !_historyBatchIds || !_dataService) return;

    var reportBtn = document.getElementById('batchReviewReportBtn');
    var originalLabel = reportBtn ? reportBtn.innerText : '';
    if (reportBtn) { reportBtn.disabled = true; reportBtn.innerText = '読込中...'; }

    try {
        var repMode = MODE_ORDER.filter(function (m) { return !!_historyBatchIds[m]; })[0];
        if (!repMode) {
            alert("レポートに使えるデータがありません。");
            return;
        }
        var repSession = await _dataService.getSessionFull(_historyBatchIds[repMode]);
        if (!repSession) {
            alert("データの読み込みに失敗しました。");
            return;
        }

        // レポートの画像ギャラリー(4方向)はreportDataStoreを参照する作りに
        // なっているため、履歴側でキャッシュ済みの画像(_historyImages)を
        // ここで一時的に書き込む。
        MODE_ORDER.forEach(function (m) {
            if (_historyImages[m]) {
                // 2026-08-25変更: 写真が「クリーンな写真」形式で、かつ骨格点
                // データが揃っている場合は、reportDataStore[m]自体を骨格点の
                // 配列にする（ライブ撮影中と同じ形＝配列＋capturedImage等の
                // 付随プロパティ）。js/ui/dashboard.js側がこの配列の有無で
                // 「その場で骨格オーバーレイを重ね描きできるか」を判定する
                // （js/ui/controls.jsのdrawPoseOverlay・js/biomechanics.jsの
                // renderPhotoWithOverlay参照）。旧形式・骨格点データ無しの
                // 場合は従来通り空配列のままにし、レポート側は写真をそのまま
                // （回転のみ）表示するフォールバックへ自動的に回る。
                var useClean = _historyPhotoFormat[m] === 'clean_v1' && _historyPoseData[m] && _historyPoseData[m].length > 0;
                reportDataStore[m] = useClean ? _historyPoseData[m][_historyPoseData[m].length - 1].keypoints : [];
                reportDataStore[m].capturedImage = _historyImages[m];
                // 2026-08-24追加: 写真の回転（js/ui/dashboard.jsの
                // renderUprightPhoto呼び出し）が使えるよう、そのポーズ自身の
                // roll角度も一緒に渡す。
                reportDataStore[m].capturedRollDeg = _historyRollDegs[m];
            }
        });

        state.currentTab = repMode;
        state.playbackDataMP = repSession.poseData || [];
        state.estimatedPelvicTilt = repSession.pelvicTilt || 0;
        state.pxToCmRatio = repSession.pxToCmRatio || null;
        // 2026-08-05追加: 研究機関向け「静止姿勢: アルコ正中線モード」。
        // pxToCmRatioと同じ考え方で、代表セッションが撮影された時点の値へ
        // 揃えてからprepareAndPrintReport()を呼ぶ（js/ui/dashboard.js参照）。
        state.arucoMidlineX = (typeof repSession.capturedArucoMidlineX === 'number') ? repSession.capturedArucoMidlineX : null;
        state.arucoMidlineY = (typeof repSession.capturedArucoMidlineY === 'number') ? repSession.capturedArucoMidlineY : null;
        state.useArucoMidline = typeof repSession.capturedArucoMidlineX === 'number';
        // 2026-08-05追加（不具合修正）: 静止4方向のroll補正（v4.6.20）が
        // js/ui/dashboard.jsのactiveSessionにcapturedRollDeg/canvasWidth/
        // Heightが元々含まれていなかったため実質発動していなかった問題の
        // 修正。pxToCmRatio/arucoMidlineX等と同じく、代表セッション
        // （repSession）が撮影された時点の値へ揃えてからprepareAndPrintReport()
        // を呼ぶ（js/ui/dashboard.jsの`activeSessionCapturedRollDeg`等の
        // ステージングフィールド参照）。
        state.activeSessionCapturedRollDeg = (typeof repSession.capturedRollDeg === 'number') ? repSession.capturedRollDeg : null;
        state.activeSessionCanvasWidth = repSession.canvasWidth || null;
        state.activeSessionCanvasHeight = repSession.canvasHeight || null;
        state.activeExpertComment = repSession.expertComment || "";
        state.activeExpertExercises = repSession.expertExercises || "";
        state.activePatientName = repSession.patientName || _historyPatientName || "ゲスト";

        var patientNameInputEl = document.getElementById('patientName');
        var heightInputEl = document.getElementById('patientHeight');
        var footSizeInputEl = document.getElementById('footSize');
        if (patientNameInputEl) patientNameInputEl.value = state.activePatientName;
        if (heightInputEl) heightInputEl.value = repSession.height || 170;
        if (footSizeInputEl) footSizeInputEl.value = repSession.footSize || 25;

        // レポート(dashboardOverlay)とこの4面まとめ画面(batchReviewOverlay)は
        // 同じz-indexを使っており、両方display:blockのままだとDOM順で後の
        // batchReviewOverlayがレポートの上に被ってしまう。ここで隠しておき、
        // レポートを閉じた時にstate.dashboardReturnTargetを見て呼び直す
        // (js/ui/dashboard.js参照)。
        var overlay = document.getElementById('batchReviewOverlay');
        if (overlay) overlay.style.display = 'none';
        state.dashboardReturnTarget = 'historyBatch';

        // 4方向のうちデータが揃っている分のセッションIDを渡しておくと、
        // レポート側(js/ui/dashboard.js)が2方向以上揃っている場合に
        // 「4方向総合所見」セクションを追加生成する（v4.6.16で追加）。
        var mvIds = {};
        MODE_ORDER.forEach(function (m) { if (_historyBatchIds[m]) mvIds[m] = _historyBatchIds[m]; });
        state.multiViewSessionIds = mvIds;

        if (window.prepareAndPrintReport) await window.prepareAndPrintReport();
    } catch (e) {
        console.error('[batchReview] Failed to open history batch report', e);
        alert("レポートの表示に失敗しました。");
    } finally {
        if (reportBtn) { reportBtn.disabled = false; reportBtn.innerText = originalLabel; }
    }
}

function currentIdsSource() {
    return _viewMode === 'history' ? (_historyBatchIds || {}) : state.currentBatchSessionIds;
}

function renderGrid() {
    var grid = document.getElementById('batchReviewGrid');
    if (!grid) return;
    grid.innerHTML = '';

    var idsSource = currentIdsSource();

    MODE_ORDER.forEach(function (mode) {
        var hasId = !!idsSource[mode];
        var base64 = _viewMode === 'history'
            ? (_historyImages[mode] || null)
            : ((reportDataStore[mode] && reportDataStore[mode].capturedImage) ? reportDataStore[mode].capturedImage : null);

        var actionsHtml = '<button type="button" class="btn orange-btn batch-edit-btn" data-mode="' + mode + '"' + (hasId ? '' : ' disabled') + '>🔍 詳細を見る</button>';
        if (_viewMode === 'live') {
            actionsHtml += '<button type="button" class="btn gray-btn batch-retake-btn" data-mode="' + mode + '">🔁 撮り直す</button>';
        }

        var card = document.createElement('div');
        card.className = 'batch-review-card';
        card.innerHTML =
            (base64
                ? '<img class="batch-review-photo" data-mode="' + mode + '" src="' + base64 + '" alt="' + MODE_LABELS[mode] + '">'
                : '<div class="batch-review-noimg">' + (hasId ? '画像なし' : '未測定') + '</div>') +
            '<div class="batch-review-label">🧍 ' + MODE_LABELS[mode] + '</div>' +
            '<div class="batch-review-actions">' + actionsHtml + '</div>';
        grid.appendChild(card);
    });

    // 2026-08-24追加: まずは元の写真をそのまま即座に表示し（上のループ）、
    // カメラのroll角度ぶん回転させた版は非同期で生成してから差し替える
    // （renderGridの呼び出し元を同期のまま保つための進行的な差し替え方式。
    // js/ui/controls.jsのgetCachedPhotoImgと同じ考え方）。回転角度が
    // 無い/小さい場合はbiomechanics.renderUprightPhotoが元画像をそのまま
    // 返すため、この段階での見た目の変化は無い。
    MODE_ORDER.forEach(function (mode) {
        var base64 = _viewMode === 'history'
            ? (_historyImages[mode] || null)
            : ((reportDataStore[mode] && reportDataStore[mode].capturedImage) ? reportDataStore[mode].capturedImage : null);
        if (!base64) return;
        var rollDeg = _viewMode === 'history'
            ? _historyRollDegs[mode]
            : ((reportDataStore[mode] && typeof reportDataStore[mode].capturedRollDeg === 'number') ? reportDataStore[mode].capturedRollDeg : null);

        // 2026-08-25追加: 写真が「クリーンな写真」形式（photoFormat===
        // 'clean_v1'）で、かつ骨格点データが揃っている場合のみ、その場で
        // 骨格オーバーレイを重ね描きする。旧形式（骨格線等が写真に焼き込み
        // 済み）のデータに対して重ね描きすると二重になってしまうため、その
        // 場合は従来通り写真をそのまま（回転のみ）表示する。ライブ撮影中は
        // reportDataStore[mode]自体が骨格点配列（かつ末尾にcapturedImage等の
        // プロパティを持つ）なので、常に最新（=新形式）のデータが入っている。
        var kps = null;
        if (_viewMode === 'history') {
            if (_historyPhotoFormat[mode] === 'clean_v1' && _historyPoseData[mode] && _historyPoseData[mode].length > 0) {
                kps = _historyPoseData[mode][_historyPoseData[mode].length - 1].keypoints;
            }
        } else {
            var liveEntry = reportDataStore[mode];
            if (liveEntry && Array.isArray(liveEntry) && liveEntry.length > 0) kps = liveEntry;
        }

        var renderPromise = kps
            ? biomechanics.renderPhotoWithOverlay(base64, function (ctx, w, h) { drawPoseOverlay(ctx, kps, mode, w, h); }, rollDeg)
            : biomechanics.renderUprightPhoto(base64, rollDeg);

        renderPromise.then(function (uprightSrc) {
            if (!uprightSrc) return;
            var imgEl = grid.querySelector('.batch-review-photo[data-mode="' + mode + '"]');
            if (imgEl) imgEl.src = uprightSrc;
        });
    });

    Array.prototype.forEach.call(grid.querySelectorAll('.batch-edit-btn'), function (btn) {
        btn.onclick = function () { openPoseForEdit(btn.dataset.mode); };
    });
    if (_viewMode === 'live') {
        Array.prototype.forEach.call(grid.querySelectorAll('.batch-retake-btn'), function (btn) {
            btn.onclick = function () { retakePose(btn.dataset.mode); };
        });
    }
}

async function openPoseForEdit(mode) {
    var idsSource = currentIdsSource();
    var id = idsSource[mode];
    if (!id || !window.loadSession) return;

    // history.jsのloadSession()を再利用しつつ、戻り先だけこの画面に
    // 差し替える（controls.jsのupdateModeUIがこのフラグを見て、
    // 「🔙 再測定へ」ではなく専用の「戻る」ボタンを出す）。historyモードでは
    // 'historyBatch'にして、保存時にstatusをdraftへ戻さない専用の保存関数
    // （saveEditsAndReturnToHistoryBatch）を通す。
    state.editReturnTarget = (_viewMode === 'history') ? 'historyBatch' : 'batchReview';

    var overlay = document.getElementById('batchReviewOverlay');
    if (overlay) overlay.style.display = 'none';

    await window.loadSession(id);
    navigate('shoot');
    if (window.__enterShootResultView) window.__enterShootResultView();
}

function retakePose(mode) {
    if (_viewMode === 'history') return; // 履歴モードでは撮り直しボタン自体を出していない（念のための保険）

    var overlay = document.getElementById('batchReviewOverlay');
    if (overlay) overlay.style.display = 'none';

    navigate('shoot');
    if (_controlsMod && _controlsMod.startBatchPoseRetake) {
        _controlsMod.startBatchPoseRetake(mode);
    }
}

/**
 * 4面確認・修正画面（live）/ 履歴の4面まとめ画面（history）共通の
 * 「📊 CSV書き出し(4面分)」から呼ばれる。個別ポーズの微調整画面にあった
 * 1ポーズ分だけのCSVボタンは廃止し、こちらへ一本化した（前面/左側面/
 * 後面/右側面をまとめて1つのCSVに）。まだ撮影・微調整していないポーズ
 * （IDが無い）はスキップする。
 */
async function exportBatchCsv() {
    var csvBtn = document.getElementById('batchReviewCsvBtn');
    var originalLabel = csvBtn ? csvBtn.innerText : '';
    if (csvBtn) { csvBtn.disabled = true; csvBtn.innerText = '書き出し中...'; }

    try {
        var idsSource = currentIdsSource();
        var rows = "Timestamp,Mode,PointID,PointName,X,Y\n";
        var foundAny = false;

        for (var i = 0; i < MODE_ORDER.length; i++) {
            var mode = MODE_ORDER[i];
            var id = idsSource[mode];
            if (!id || !_dataService) continue;

            var session = await _dataService.getSessionFull(id);
            if (!session || !session.poseData) continue;
            foundAny = true;

            session.poseData.forEach(function (d) {
                (d.keypoints || []).forEach(function (kp, idx) {
                    if (!kp) return;
                    rows += d.time + "," + d.mode + "," + idx + "," + (kp.name || idx) + "," + kp.x.toFixed(1) + "," + kp.y.toFixed(1) + "\n";
                });
            });
        }

        if (!foundAny) {
            alert("CSVに書き出せる計測データがまだありません。少なくとも1ポーズは撮影してください。");
            return;
        }

        var patientName = (_viewMode === 'history' ? _historyPatientName : state.activePatientName) || "guest";
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([rows], { type: 'text/csv' }));
        a.download = "athletecore_data_4men_" + patientName + "_" + Date.now() + ".csv";
        a.click();
    } catch (e) {
        console.error('[batchReview] CSV export failed', e);
        alert("CSVの書き出しに失敗しました。通信状態をご確認のうえ、もう一度お試しください。");
    } finally {
        if (csvBtn) { csvBtn.disabled = false; csvBtn.innerText = originalLabel; }
    }
}

async function finalizeBatch() {
    if (_viewMode === 'history') return; // 履歴モードでは確定ボタン自体を隠している（念のための保険）

    var finalizeBtn = document.getElementById('batchReviewFinalizeBtn');
    var originalLabel = finalizeBtn ? finalizeBtn.innerText : '';
    if (finalizeBtn) { finalizeBtn.disabled = true; finalizeBtn.innerText = '確定中...'; }

    var ids = MODE_ORDER.map(function (m) { return state.currentBatchSessionIds[m]; }).filter(Boolean);
    try {
        for (var i = 0; i < ids.length; i++) {
            await _dataService.finalizeSession(ids[i]);
        }
    } catch (e) {
        console.error('[batchReview] finalize failed', e);
    }

    if (finalizeBtn) { finalizeBtn.disabled = false; finalizeBtn.innerText = originalLabel; }

    var overlay = document.getElementById('batchReviewOverlay');
    if (overlay) overlay.style.display = 'none';

    if (typeof window.refreshHistoryList === 'function') window.refreshHistoryList();
    // 直前に履歴の4面まとめ画面からレポートを開いていた場合の
    // dashboardReturnTargetが万一残っていても、この確定直後のレポートは
    // 単純に閉じるだけでよいのでクリアしておく。
    state.dashboardReturnTarget = null;

    // 4方向のうち確定できたぶんのセッションIDを渡しておくと、レポート側
    // (js/ui/dashboard.js)が2方向以上揃っている場合に「4方向総合所見」
    // セクションを追加生成する（v4.6.16で追加）。下の行でstate.currentBatch
    // SessionIdsをリセットする前に、ここでスナップショットを取っておく。
    var mvIds = {};
    MODE_ORDER.forEach(function (m) { if (state.currentBatchSessionIds[m]) mvIds[m] = state.currentBatchSessionIds[m]; });
    state.multiViewSessionIds = mvIds;

    // 2026-08-05追加（不具合修正）: 静止4方向のroll補正（v4.6.20）が、
    // js/ui/dashboard.jsのactiveSessionにcapturedRollDeg/canvasWidth/
    // Heightが元々含まれていなかったため、撮影確定直後にその場で開く
    // このレポート（企画者が最も頻繁に通る経路）で実質発動していなかった
    // 問題の修正。capturedRollDegは撮影ポーズごとに凍結される値
    // （js/core/recorder.js参照）なので、state.pxToCmRatio等のような
    // 「今のライブ値をそのまま使う」では代表ポーズ（state.currentTab）が
    // 実際に撮影された時の値と食い違う可能性がある。確定済みの代表
    // セッションを保存先から読み直し、その撮影時点の値へ揃えてから
    // レポートを生成する（js/ui/batchReview.jsのviewHistoryBatchReport()と
    // 同じ考え方）。
    var repIdForRoll = state.currentBatchSessionIds[state.currentTab];
    try {
        var repSessionForRoll = repIdForRoll ? await _dataService.getSessionFull(repIdForRoll) : null;
        state.activeSessionCapturedRollDeg = (repSessionForRoll && typeof repSessionForRoll.capturedRollDeg === 'number') ? repSessionForRoll.capturedRollDeg : null;
        state.activeSessionCanvasWidth = (repSessionForRoll && repSessionForRoll.canvasWidth) || null;
        state.activeSessionCanvasHeight = (repSessionForRoll && repSessionForRoll.canvasHeight) || null;
    } catch (e) {
        console.error('[batchReview] Failed to load representative session for roll correction', e);
        state.activeSessionCapturedRollDeg = null;
        state.activeSessionCanvasWidth = null;
        state.activeSessionCanvasHeight = null;
    }

    if (window.prepareAndPrintReport) window.prepareAndPrintReport();

    // 次の新規4面計測に備え、このバッチのID紐付けをリセットする
    // （recorder.js側でも前面の撮影開始時に同様のリセットを行っているが、
    // ここでも明示的にクリアしておく）。
    MODE_ORDER.forEach(function (m) { state.currentBatchSessionIds[m] = null; });

    // 「◀ モード選択に戻る」は、確定前のcurrentBatchSessionIdsが1つでも
    // 残っている間はcontrols.jsのupdateModeUIが非表示にしている。確定完了で
    // リセットした直後にここで明示的にupdateModeUIを呼び直しておかないと、
    // 直前に表示していたポーズの画面の「非表示」状態がそのまま残ってしまい、
    // レポートを閉じて撮影画面に戻った時に、確定済みなのにボタンが出ない
    // ままになってしまう。
    if (_controlsMod && _controlsMod.updateModeUI) _controlsMod.updateModeUI(state.currentTab);
}
