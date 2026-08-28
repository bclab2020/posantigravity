/**
 * app.js
 * ---------------------------------------------------------------------------
 * アプリケーションのブートストラップ。各機能モジュールを読み込み、
 * 初期化順序を制御するだけの薄いエントリーポイント。
 * (旧版は本ファイル1つに全ロジックが入っていたが、機能ごとに
 *  js/core/*, js/ui/*, js/data/* へ分割した)
 */

import { state } from './core/state.js';
import * as dataService from './data/dataService.js';

import { initCalibrationUI } from './core/calibration.js';
import { enumerateCameras, initPoseModel, bindStartButton } from './core/camera.js';
import { initRecorder } from './core/recorder.js';
import { requestDeviceOrientationPermission, speakGuidance } from './core/orientation.js';

import { initControlsUI, filterModeDropdown, syncTabButtonsForMode, updateModeUI, renderPlaybackFrame, startBatchPoseRetake, saveEditsAndReturnToBatchReview, saveEditsAndReturnToHistoryBatch, saveEditsAndReturnToDynConfirm, saveEditsAndReturnToDynConfirmHistory, exitPlaybackMode } from './ui/controls.js';
import { initSpecialistUI, updateAuthUI } from './ui/specialist.js';
import { initHistoryUI } from './ui/history.js';
import { initDashboard } from './ui/dashboard.js';
import { initBatchReview } from './ui/batchReview.js';
import { initDynConfirm } from './ui/dynConfirm.js';
import { initApiSettingModal, initGyroPermissionModal, initMentorBookingModal, initPasswordToggles } from './ui/modal.js';
import { initAuthUI, initAccountBadge } from './ui/auth.js';
import { initWebGLHUD, bindAnalyticsDrawerToggle } from './ui/webglHud.js';
import { initRouter, navigate } from './ui/router.js';
import { initHomeUI } from './ui/home.js';
import { initShootFlow } from './ui/shootFlow.js';
import biomechanics from './biomechanics.js';
import { debugViewportSizeDisplay, patientNameInput } from './core/dom.js';
import { restorePersistedCalibrationToState } from './core/arucoCalibration.js';

// controls.js と orientation.js の循環import回避用ブリッジ
window.__speakGuidance = speakGuidance;

async function boot() {
    // -1. 4隅ArUco床面キャリブレーションの復元（2026-08-03追加）。
    //     localStorageに保存済みの校正結果があれば、state.pxToCmRatio/
    //     state.floorHomographyへ反映する。dataService初期化やDOM/カメラの
    //     準備を待つ必要がない純粋な同期処理のため、最初に行う
    //     （js/core/arucoCalibration.js参照）。
    restorePersistedCalibrationToState();

    // 0. パスワード表示/非表示トグル配線（会員登録モーダルが起動直後に開くため、
    //    dataService初期化より前、他のUI配線より先にここで行っておく）
    initPasswordToggles();

    // 1. データ層（ローカルIndexedDB + Firebase）を初期化
    await dataService.init();
    await dataService.waitForAuthReady();

    // 2. 未ログインならまず会員登録/ログイン/ゲスト選択モーダルを出す
    //    (Firebase未設定の場合は auth.js 内部でスキップされ、そのまま起動する)
    await new Promise(function (resolve) {
        if (dataService.isCloudEnabled() && !dataService.getCurrentUser()) {
            initAuthUI(dataService, function () {
                // 認証モーダル（会員登録/ログイン/ゲスト）を経由した直後は、
                // ログアウト前にいたページのURLハッシュ（例: #/settings）が
                // 残っていても上書きし、必ずホームから始める。
                navigate('home');
                resolve();
            });
        } else {
            resolve(); // 既にログイン済みでモーダルを出さない場合は、既存のハッシュ（ブックマーク等）を尊重する
        }
    });

    // 2026-08-24追加（不具合修正）: 「ログインしているのに、測定結果が
    // 毎回『ゲスト』様として記録される」というご指摘の原因調査結果。
    // アカウントの表示名を被測定者名欄(patientNameInput)へ補完する処理は
    // 元々js/ui/auth.jsのログイン/会員登録ボタンのonclick内にしかなく、
    // 「今まさにログイン操作をした直後」でしか働かなかった。Firebase側に
    // 既にセッションが永続化されている状態（一度ログインした端末で
    // アプリを開き直した、通常最も多いケース）では、上のif分岐が
    // 「既にログイン済み」としてinitAuthUI自体を呼ばずスキップするため、
    // 表示名の補完も一度も走らず、被測定者名欄が空のまま
    // （＝js/core/recorder.js等の「入力が空なら“ゲスト”扱い」フォール
    // バックが常に発動）になっていた。ここで、実名アカウント（匿名/
    // ゲストログインではない）でログイン済み・かつ被測定者名欄がまだ
    // 空の場合に限り、アカウント側の表示名で補完する（アカウント
    // バッジ側の表示ロジック=js/ui/auth.jsのinitAccountBadgeと同じ
    // user.displayNameを参照）。
    var loggedInUser = dataService.getCurrentUser();
    if (loggedInUser && !loggedInUser.isAnonymous && loggedInUser.displayName && patientNameInput && !patientNameInput.value.trim()) {
        patientNameInput.value = loggedInUser.displayName;
    }

    state.isSpecialist = dataService.isSpecialistUser();
    updateAuthUI();
    initAccountBadge(dataService);

    // 3. 履歴・入力UIなどの初期表示
    // initHistoryUI()を先に呼び、history.js側が参照するdataServiceを
    // 登録してから refreshHistoryList() を呼ぶ（順序が逆だと、history.js内部の
    // 参照がまだnullのまま呼ばれてしまい、起動直後の履歴読み込みが必ず
    // エラーになる）。
    initHistoryUI(dataService);
    if (typeof window.refreshHistoryList === 'function') {
        window.refreshHistoryList();
    }

    makeRadarDraggable();
    biomechanics.clearRadar(document.getElementById('canvasRadarMP').getContext('2d'), '#ff5252');

    // 4. カメラデバイス列挙（getUserMedia自体はまだ呼ばない）
    await enumerateCameras();

    // 5. 各UIモジュールのイベント配線
    initControlsUI();
    initCalibrationUI(function () {
        // 2026-08-18修正: 以前はここでcaptureSkeletonImage(state.currentTab)を
        // 呼んでおり、骨盤傾斜スライダーを操作するたびに「今canvasMPに
        // 描画されている内容（暗い背景+骨格線）」でreportDataStore[mode]の
        // capturedImageを丸ごと上書きしてしまっていた。これにより、撮影時に
        // 保存した「実写真」が骨盤傾斜を1回でも調整した時点で永久に失われ、
        // 以降「🖼 写真を表示」を押しても（中身が実質「骨格のみ」表示と
        // 同じものに置き換わってしまっているため）見た目が変わらず「写真が
        // 出てこない」ように見える不具合の原因になっていた（企画者からの
        // ご指摘：4面確認画面で側面の微調整＝骨盤傾斜の修正をした直後から
        // 発生。「保存して4面確認へ戻る」を経由すると、この壊れた画像が
        // DBにもそのまま永続化されてしまう）。骨盤傾斜スライダーはKendall
        // アライメント等の解析線の位置を変えるだけで、保存済みの実写真とは
        // 無関係のため、ここでは「実写真を上書き保存」ではなく「今の
        // 再生フレームを再描画するだけ」のrenderPlaybackFrame()に差し替え、
        // capturedImageには一切触れないようにする。
        if (state.appMode === 'playback') {
            var slider = document.getElementById('timelineSlider');
            renderPlaybackFrame(parseInt(slider.value));
        }
    }, function (ratio) {
        if (window.__onMatCalibrationDone) window.__onMatCalibrationDone(ratio);
    });
    initSpecialistUI(dataService);
    initDashboard(dataService);
    initApiSettingModal();
    initGyroPermissionModal(requestDeviceOrientationPermission);
    initMentorBookingModal(dataService, function () { return document.getElementById('patientName').value.trim(); });
    var homeUI = initHomeUI(dataService);
    initShootFlow(dataService);
    initBatchReview(dataService, { startBatchPoseRetake: startBatchPoseRetake, updateModeUI: updateModeUI });
    initDynConfirm(dataService, { exitPlaybackMode: exitPlaybackMode });
    var backToBatchReviewBtn = document.getElementById('backToBatchReviewBtn');
    if (backToBatchReviewBtn) {
        // editReturnTargetが'historyBatch'（履歴の4面まとめ画面から個別に
        // 開き直した確定済みデータ）か、'batchReview'（撮影直後・未確定の
        // 4面確認画面）か、'dynConfirm'（動作解析の撮影確認画面から個別に
        // 開いた場合）か、'dynConfirmHistory'（動作解析を履歴一覧経由で
        // 開いた場合）かで、保存後に戻る先・保存時のstatus扱いが違うため
        // 呼び分ける（controls.js参照）。'dynConfirmHistory'の分岐が漏れて
        // おり、静止4方向用のsaveEditsAndReturnToBatchReviewが誤って呼ばれ、
        // 保存後に別画面（#batchReviewOverlay）が開いてしまう不具合が
        // あった（2026-07-29のご報告、v4.6.24で追加）。
        backToBatchReviewBtn.onclick = function () {
            if (state.editReturnTarget === 'historyBatch') {
                saveEditsAndReturnToHistoryBatch(dataService);
            } else if (state.editReturnTarget === 'dynConfirm') {
                saveEditsAndReturnToDynConfirm(dataService);
            } else if (state.editReturnTarget === 'dynConfirmHistory') {
                saveEditsAndReturnToDynConfirmHistory(dataService);
            } else {
                saveEditsAndReturnToBatchReview(dataService);
            }
        };
    }
    bindStartButton();
    initRecorder(dataService, function () {
        // 撮影→保存が完了した直後のフック（結果バナー表示、履歴/ホームの再取得）
        if (window.__onSessionSaved) window.__onSessionSaved();
        if (typeof window.refreshHistoryList === 'function') window.refreshHistoryList();
        if (homeUI && homeUI.refresh) homeUI.refresh();
    });

    // 5b. ページルーター初期化（他モジュールのDOM配線が終わった後に行う）
    initRouter();

    // 6. AIモデル（TensorFlow/BlazePose）読込
    var ok = await initPoseModel();
    if (ok) {
        filterModeDropdown();
        syncTabButtonsForMode(state.currentTab);
        updateModeUI(state.currentTab);
    }

    // 7. WebGL Stealth HUD
    setTimeout(function () {
        initWebGLHUD();
        bindAnalyticsDrawerToggle();
    }, 500);

    // 8. Service Worker（PWA）登録
    registerServiceWorker();

    // 9. 設定画面の検証用情報: 画面表示幅（CSSピクセル）
    updateDebugViewportSize();
    window.addEventListener('resize', updateDebugViewportSize);
    window.addEventListener('orientationchange', updateDebugViewportSize);
}

function updateDebugViewportSize() {
    if (!debugViewportSizeDisplay) return;
    var w = window.innerWidth;
    var h = window.innerHeight;
    var dpr = window.devicePixelRatio || 1;
    debugViewportSizeDisplay.innerText = w + " × " + h + " px (DPR " + dpr.toFixed(2) + ")";
}

function makeRadarDraggable() {
    var wrapper = document.getElementById('radarWrapperMP');
    if (!wrapper) return;
    var isDragging = false, startX, startY, initialLeft, initialTop;

    wrapper.addEventListener('mousedown', function (e) {
        isDragging = true;
        wrapper.classList.add('dragging');
        startX = e.clientX; startY = e.clientY;
        initialLeft = wrapper.offsetLeft; initialTop = wrapper.offsetTop;
        e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
        if (!isDragging) return;
        wrapper.style.left = (initialLeft + (e.clientX - startX)) + 'px';
        wrapper.style.top = (initialTop + (e.clientY - startY)) + 'px';
        wrapper.style.right = 'auto';
    });
    document.addEventListener('mouseup', function () {
        if (isDragging) { isDragging = false; wrapper.classList.remove('dragging'); }
    });

    wrapper.addEventListener('touchstart', function (e) {
        var t = e.touches[0];
        isDragging = true;
        wrapper.classList.add('dragging');
        startX = t.clientX; startY = t.clientY;
        initialLeft = wrapper.offsetLeft; initialTop = wrapper.offsetTop;
    });
    document.addEventListener('touchmove', function (e) {
        if (!isDragging) return;
        var t = e.touches[0];
        wrapper.style.left = (initialLeft + (t.clientX - startX)) + 'px';
        wrapper.style.top = (initialTop + (t.clientY - startY)) + 'px';
        wrapper.style.right = 'auto';
    });
    document.addEventListener('touchend', function () {
        if (isDragging) { isDragging = false; wrapper.classList.remove('dragging'); }
    });
}

function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('./sw.js')
                .then(function (reg) {
                    reg.onupdatefound = function () {
                        var installingWorker = reg.installing;
                        installingWorker.onstatechange = function () {
                            if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                window.location.reload();
                            }
                        };
                    };
                })
                .catch(function (err) { console.error('ServiceWorker registration failed:', err); });
        });

        var refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', function () {
            if (!refreshing) { refreshing = true; window.location.reload(); }
        });
    }
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
    boot();
} else {
    window.addEventListener('load', boot);
}
