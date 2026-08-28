/**
 * shootFlow.js
 * ---------------------------------------------------------------------------
 * 「撮影」ページを 設定(setup) → 撮影(live) → 結果(result) の3ステップの
 * 単一ページ内切替として見せるための表示制御レイヤー。
 *
 * カメラ起動・姿勢推定・録画・再生といったコアロジック（core/camera.js,
 * core/recorder.js, ui/controls.js）には一切手を入れず、既存の
 * startBtn/recBtn/exitPlaybackMode 等をそのまま呼び出すだけの薄いラッパー。
 * 「設定に戻る」だけが新規の操作のため、ここでカメラストリームの停止処理を
 * 追加している。
 */

import { state, isStaticMode as isStaticModeCheck } from '../core/state.js';
import { startBtn, calibrateMatBtn } from '../core/dom.js';
import { onRoute } from './router.js';
import { warmUpCameraLabels } from '../core/camera.js';
import { startArucoQuadCalibration, stopArucoQuadCalibration, applyAndPersistCalibration, loadPersistedCalibration } from '../core/arucoCalibration.js';

var MODE_ORIENTATION_HINTS = {
    dyn_shoulder_r: '↔️ 横向き推奨（肩の可動域を画角に収めやすくなります）',
    dyn_shoulder_l: '↔️ 横向き推奨（肩の可動域を画角に収めやすくなります）'
};
var DEFAULT_HINT = '📱 縦向き推奨（全身を近距離で画角に収めます）';

var els = {};
var calibrationEntryMode = false;
// 4隅ArUco校正の入口フラグ（calibrationEntryModeと同じ考え方の別変数。
// パネルの表示・後始末をこちらだけで完結させ、既存の2点タップ校正フローに
// 影響を与えないようにする）。
var arucoCalibrationEntryMode = false;

function updateStepIndicator(activeStep) {
    var order = ['setup', 'live', 'result'];
    var activeIdx = order.indexOf(activeStep);
    document.querySelectorAll('.shoot-step').forEach(function (el) {
        var idx = order.indexOf(el.dataset.step);
        el.classList.toggle('active', idx === activeIdx);
        el.classList.toggle('done', idx > -1 && idx < activeIdx);
    });
}

function showSetup() {
    if (els.setupView) els.setupView.classList.add('active');
    if (els.liveView) els.liveView.classList.remove('active');
    if (els.resultBanner) els.resultBanner.classList.remove('active');
    // キャリブレーション目安線は設定画面に戻るたびに必ず隠す（各終了経路で
    // 個別にも消しているが、想定外の遷移経路が今後増えても表示が
    // 残り続けないよう、ここでも一括して保険をかけておく）。
    var calibGuideLines = document.getElementById('calibGuideLines');
    if (calibGuideLines) calibGuideLines.style.display = 'none';
    // ライブビュー専用の「向き優先」ナビ切替(style.css参照)を解除し、
    // 通常の画面幅ベースのナビに戻す。
    document.body.classList.remove('shoot-live-active');
    updateStepIndicator('setup');
    // 2026-08-05追加: 履歴/確認画面の閲覧を経由すると、その撮影時点の
    // 使用有無でstate.useArucoMidlineが上書きされる（pxToCmRatio等と同じ
    // 「ライブ値と履歴の撮影時点値を同じ変数で兼用する」設計のため）。
    // 設定画面に戻るたびにチェックボックスの見た目をstateへ再同期し、
    // 「トグルの見た目と実際の設定が食い違う」ことを防ぐ。
    var toggle = document.getElementById('useArucoMidlineToggle');
    if (toggle) toggle.checked = !!state.useArucoMidline;
}

function showLive(isResult) {
    if (els.setupView) els.setupView.classList.remove('active');
    if (els.liveView) els.liveView.classList.add('active');
    // ライブビュー表示中だけ、ナビの出し分けを画面幅基準から向き基準に
    // 切り替える（タブレット縦持ちで左サイドレールが画角を圧迫する問題、
    // 小型スマホ横持ちで下部バーが縦方向を圧迫する問題への対応）。
    document.body.classList.add('shoot-live-active');
    syncParamsPanelVisibility();
    if (isResult) {
        if (els.resultBanner) els.resultBanner.classList.add('active');
        updateStepIndicator('result');
    } else {
        if (els.resultBanner) els.resultBanner.classList.remove('active');
        updateStepIndicator('live');
    }
}

/**
 * 撮影設定カードの「📊 パラメーターを表示」チェックボックスの状態を、
 * ライブビュー側の表示可否に反映する。既定はオン（チェック済み）に変更した
 * （以前は「撮影中の画面を圧迫する」との声から既定オフだったが、常に見えて
 * いてほしいという要望により反転）。
 *
 * タブレット/スマホ幅（1024px以下）では.analytics-areaは常設カラムではなく
 * 画面右端の引き出し(ドロワー)になっており、#toggleAnalyticsBtn
 * （📊パラメーター/✖閉じる）を押した時だけ.analytics-openクラスで
 * スライドして出てくる作りになっている。「デフォルトで見えていてほしい」
 * という要望に対応するため、ここでパラメーター表示がオンになるタイミングで
 * 自動的に.analytics-openも付与し、わざわざボタンを押さなくても最初から
 * 開いた状態にする。ボタン自体は削除せず残す（撮影中に画面が窮屈だと
 * 感じた瞬間だけ一時的に閉じられる逃げ道として機能させるため）。
 * オフにした場合は.analytics-openも明示的に外す（残ったままだと、
 * オフにしたのにドロワーが開きっぱなしに見えるモバイル側の見た目の
 * 不整合を防ぐため）。
 * セッションをまたいだ記憶までは不要という判断のため、チェックボックスの
 * DOM状態をその都度読みに行くだけで、stateへの新規フィールド追加はしない。
 */
function syncParamsPanelVisibility() {
    var checkbox = document.getElementById('showParamsPanel');
    var enabled = !!(checkbox && checkbox.checked);
    document.body.classList.toggle('params-enabled', enabled);

    var analyticsArea = document.getElementById('analyticsArea');
    var toggleBtn = document.getElementById('toggleAnalyticsBtn');
    if (analyticsArea) analyticsArea.classList.toggle('analytics-open', enabled);
    if (toggleBtn) {
        toggleBtn.innerText = enabled ? "✖ 閉じる" : "📊 パラメーター";
        toggleBtn.style.borderColor = enabled ? "var(--accent-red)" : "var(--accent-teal)";
        toggleBtn.style.color = enabled ? "var(--accent-red)" : "var(--accent-teal)";
    }
}

function updateOrientationHint() {
    if (!els.hint || !els.modeSelect) return;
    els.hint.textContent = MODE_ORIENTATION_HINTS[els.modeSelect.value] || DEFAULT_HINT;
}

/**
 * キャリブレーション時（アルコ4隅・タップ2点の両方）だけ、カメラを
 * おおむね合わせるための目安線(#calibGuideLines)を表示する（2026-08-07追加）。
 * 通常の撮影ライブビューでは表示しない。
 */
function setCalibGuideLinesVisible(visible) {
    var el = document.getElementById('calibGuideLines');
    if (el) el.style.display = visible ? 'block' : 'none';
}

function stopCameraStream() {
    if (state.currentStream) {
        state.currentStream.getTracks().forEach(function (t) { t.stop(); });
        state.currentStream = null;
    }
    if (state.mainRenderId) { cancelAnimationFrame(state.mainRenderId); state.mainRenderId = null; }
    state.isRunning = false;
    state.isRecording = false;
    document.body.classList.remove('recording-active');
    var timerDisplay = document.getElementById('timerDisplay');
    if (timerDisplay) timerDisplay.style.display = 'none';
    var dpad = document.getElementById('dpadPanel');
    if (dpad) dpad.style.display = 'none';
}

/**
 * 撮影設定カードの「🎯 カメラキャリブレーションを取る」ボタンから呼ばれる。
 * 既存の2点タップ校正フロー（calibration.js / calibrateMatBtn）はそのまま使い、
 * ライブカメラ画面を開いた直後に自動でそのボタンを押した状態にするだけ。
 *
 * 注意: startBtn（core/camera.jsの本体起動ボタン）はAIモデル読込が終わる
 * までdisabledのままで、disabledなボタンへの.click()はブラウザ上何も
 * 起こらない。「撮影へ進む」側は waitForAiModelReady() で待機させているが、
 * このキャリブレーション入口は別経路でstartBtnを直接クリックするため、
 * 同じガードをここにも入れないと「ボタンを押しても何も起こらない」状態に
 * なってしまう（読込中にこのボタンを押した場合に発生）。
 */
function startFixedCalibrationFromSetup() {
    calibrationEntryMode = true;
    showLive(false);
    setCalibGuideLinesVisible(true);

    var modelWaitElapsed = 0;
    (function triggerCameraStart() {
        if (state.detectors && state.detectors[0]) {
            startBtn.click(); // core/camera.js の既存起動フローをそのまま利用
        } else if (modelWaitElapsed < 15000) {
            modelWaitElapsed += 200;
            setTimeout(triggerCameraStart, 200);
        } else {
            startBtn.click(); // フォールバック: 最終的には現状と同じ挙動に戻す
        }
    })();

    var waitForCamera = setInterval(function () {
        if (state.isRunning) {
            clearInterval(waitForCamera);
            if (calibrateMatBtn) calibrateMatBtn.click();
        }
    }, 150);
    setTimeout(function () { clearInterval(waitForCamera); }, 20000);
}

// ─────────────────────────────────────────────────────────────────────────
// 4隅ArUco床面キャリブレーション（2026-08-03追加）
// startFixedCalibrationFromSetup()と同じ「カメラを起動してから��ャリブ
// レーションUIへ入る」流れだが、こちらは既存の2点タップ(calibrateMatBtn)
// ではなく#arucoCalibPanelを表示し、js/core/arucoCalibration.jsの検出
// ループを回す。三脚等の固定設置専用（手持ち・簡易スタンドでは使わない）
// の追加オプションで、既存の2点タップ校正フローには一切手を入れない。
// ─────────────────────────────────────────────────────────────────────────

function resetArucoCalibPanelUI() {
    var inputs = document.getElementById('arucoCalibBoardInputs');
    var status = document.getElementById('arucoCalibDetectStatus');
    var result = document.getElementById('arucoCalibResult');
    var actions = document.getElementById('arucoCalibActions');
    if (inputs) inputs.style.display = '';
    if (status) { status.style.display = 'none'; status.innerHTML = ''; }
    if (result) { result.style.display = 'none'; result.innerHTML = ''; }
    if (actions) actions.style.display = 'none';
}

/** 設定画面・ライブ画面の「校正済み」表示を、保存済みの4隅ArUco校正結果に合わせて更新する */
function updateArucoCalibStatusHint() {
    var hint = document.getElementById('arucoCalibStatusHint');
    if (!hint) return;
    var record = loadPersistedCalibration();
    if (record) {
        var d = new Date(record.calibratedAt);
        var dateStr = d.getFullYear() + "/" + (d.getMonth() + 1).toString().padStart(2, '0') + "/" + d.getDate().toString().padStart(2, '0') + " " + d.getHours().toString().padStart(2, '0') + ":" + d.getMinutes().toString().padStart(2, '0');
        hint.style.display = 'block';
        hint.textContent = '✅ 4隅ArUco校正済み (' + dateStr + '、ボード' + record.wMm + '×' + record.hMm + 'mm)';
    } else {
        hint.style.display = 'none';
    }
}

/** マーカー準備の案内ページを新規タブで開く（外部のArUco生成サイトへのリンク付き） */
function openArucoPrintGuide() {
    var tagMm = 40; // 印刷するマーカー1枚あたりの目安サイズ(mm)。校正の計算自体には使わない(あくまで印刷時の目安)。
    var links = [0, 1, 2, 3].map(function (id) {
        var url = 'https://chev.me/arucogen/?dict=ARUCO&id=' + id + '&dim=' + tagMm;
        return '<li>ID:' + id + ' &mdash; <a href="' + url + '" target="_blank">' + url + '</a></li>';
    }).join('');
    var html =
        '<html><head><meta charset="UTF-8"><title>4隅ArUcoマーカー印刷</title>' +
        '<style>body{font-family:sans-serif;padding:24px;line-height:1.7;color:#222}' +
        'li{margin-bottom:10px}code{background:#eee;padding:2px 5px;border-radius:3px}</style></head><body>' +
        '<h2>🔲 4隅ArUcoマーカーの準備（ボード実寸を自動計測）</h2>' +
        '<ol>' +
        '<li>下記4つのリンクをそれぞれ開く（Dictionary = <strong>Original ARUCO</strong> 固定）</li>' +
        '<li>各ページでマーカー画像を印刷する（4枚とも同じサイズで揃える）</li>' +
        '<li>実寸が分かっているボード/マット（例: ヨガマット、養生シート等）の4隅に、<strong>カメラから見て</strong> ID:0=左上・ID:1=右上・ID:2=右下・ID:3=左下 の順になるように1枚ずつ貼る（この順番を守らないと、実寸への変換方向がねじれて正しく計算されません）</li>' +
        '<li>撮影アプリ側の設定画面から「🔲 4隅ArUcoで校正する」を開き、ボードの横実寸(mm)・縦実寸(mm)を入力してから「検出開始」を押す</li>' +
        '<li>4枚すべてがカメラに写るよう、カメラを固定したままボードの向き・距離を調整する</li>' +
        '</ol>' +
        '<ul>' + links + '</ul>' +
        '<p>※ Dictionary は必ず「<strong>Original ARUCO</strong>」を選択してください（4x4/5x5等は不可）</p>' +
        '</body></html>';
    var w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
}

function renderArucoDetectProgress(liveIds) {
    var status = document.getElementById('arucoCalibDetectStatus');
    if (!status) return;
    status.style.display = 'block';
    var labels = [0, 1, 2, 3].map(function (id) {
        return liveIds.indexOf(id) !== -1 ? ('✅ID' + id) : ('⬜ID' + id);
    });
    status.innerHTML = '検出中... (' + liveIds.length + '/4)<br>' + labels.join(' ');
}

function renderArucoCalibResult(result) {
    var resultEl = document.getElementById('arucoCalibResult');
    var actionsEl = document.getElementById('arucoCalibActions');
    var statusEl = document.getElementById('arucoCalibDetectStatus');
    if (statusEl) statusEl.style.display = 'none';
    if (!resultEl) return;

    var rollOk = Math.abs(result.rollDeg) <= 2;
    var perspOk = result.perspRatio >= 0.80 && result.perspRatio <= 1.20;
    var diffPct = Math.abs(result.pxPerMmW - result.pxPerMmH) / Math.min(result.pxPerMmW, result.pxPerMmH) * 100;
    var diffOk = diffPct <= 8;

    var html = 'スケール: <strong>' + result.pxPerMm.toFixed(3) + ' px/mm</strong><br>' +
        'カメラ傾き: <strong>' + result.rollDeg.toFixed(1) + '°</strong> ' +
        (rollOk ? '<span class="ok">✓</span>' : '<span class="warn">⚠ 傾きが大きいです（カメラを水平に）</span>') + '<br>' +
        '透視比(上辺/下辺): <strong>' + result.perspRatio.toFixed(2) + '</strong> ' +
        (perspOk ? '<span class="ok">✓</span>' : '<span class="warn">⚠ カメラの俯角を見直してください</span>') + '<br>' +
        '横縦スケール差: <strong>' + diffPct.toFixed(0) + '%</strong> ' +
        (diffOk ? '<span class="ok">✓</span>' : '<span class="warn">⚠ 差が大きいです（マーカー位置・入力実寸をご確認ください）</span>');
    resultEl.style.display = 'block';
    resultEl.innerHTML = html;
    if (actionsEl) actionsEl.style.display = 'flex';
}

var _arucoLastResult = null;

function startArucoDetectionFlow() {
    var wInput = document.getElementById('arucoBoardWMm');
    var hInput = document.getElementById('arucoBoardHMm');
    var wMm = parseFloat(wInput && wInput.value) || 500;
    var hMm = parseFloat(hInput && hInput.value) || 500;

    var inputs = document.getElementById('arucoCalibBoardInputs');
    if (inputs) inputs.style.display = 'none';
    var resultEl = document.getElementById('arucoCalibResult');
    var actionsEl = document.getElementById('arucoCalibActions');
    if (resultEl) resultEl.style.display = 'none';
    if (actionsEl) actionsEl.style.display = 'none';

    var statusEl = document.getElementById('arucoCalibDetectStatus');
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'ライブラリを読み込み中...'; }

    startArucoQuadCalibration(
        wMm, hMm,
        function onProgress(liveIds) { renderArucoDetectProgress(liveIds); },
        function onComplete(result) { _arucoLastResult = result; renderArucoCalibResult(result); },
        function onError(message) {
            if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = '⚠ ' + message; }
            if (inputs) inputs.style.display = '';
        }
    );
}

function closeArucoCalibPanel() {
    stopArucoQuadCalibration();
    arucoCalibrationEntryMode = false;
    _arucoLastResult = null;
    var panel = document.getElementById('arucoCalibPanel');
    if (panel) panel.style.display = 'none';
    setCalibGuideLinesVisible(false);
    stopCameraStream();
    showSetup();
}

/**
 * 撮影設定カードの「🔲 4隅ArUcoで校正する」ボタンから呼ばれる。
 * startFixedCalibrationFromSetup()と同じ手順でカメラを起動し、起動完了後に
 * 2点タップの代わりに#arucoCalibPanelを表示する。
 */
function startArucoFixedCalibrationFromSetup() {
    arucoCalibrationEntryMode = true;
    showLive(false);
    setCalibGuideLinesVisible(true);
    resetArucoCalibPanelUI();

    var modelWaitElapsed = 0;
    (function triggerCameraStart() {
        if (state.detectors && state.detectors[0]) {
            startBtn.click();
        } else if (modelWaitElapsed < 15000) {
            modelWaitElapsed += 200;
            setTimeout(triggerCameraStart, 200);
        } else {
            startBtn.click();
        }
    })();

    var waitForCamera = setInterval(function () {
        if (state.isRunning) {
            clearInterval(waitForCamera);
            var panel = document.getElementById('arucoCalibPanel');
            if (panel) panel.style.display = 'block';
        }
    }, 150);
    setTimeout(function () { clearInterval(waitForCamera); }, 20000);
}

var AI_MODEL_READY_LABEL = '撮影へ進む ▶';
var AI_MODEL_LOADING_LABEL = '🤖 AIモデル準備中...';

/**
 * 「撮影へ進む」はクリック時にライブ画面へ切替えつつ、裏で本体の起動ボタン
 * （core/camera.js の startBtn）を自動クリックして即座にカメラを起動する
 * 作りになっている。ただしAIモデル（TF/BlazePose）の読込がまだ終わって
 * いない間は startBtn が disabled のままで、disabled なボタンへの .click() は
 * ブラウザ上何も起こらないため、その場合だけライブ画面に「フルHD起動」の
 * 生ボタンが手動操作待ちの状態で取り残されてしまっていた。
 * ここでは読込完了（state.detectors[0]がセットされる）まで「撮影へ進む」
 * 自体を待機状態にし、常に自動起動が成功するようにする。
 * （名前や身長の入力を終える頃にはほぼ読込済みのため、体感的な待ちはほぼ発生しない想定）
 */
function waitForAiModelReady(shootStartBtn) {
    if (!shootStartBtn) return;
    if (state.detectors && state.detectors[0]) return; // 既に読込済みなら何もしない

    shootStartBtn.disabled = true;
    shootStartBtn.innerText = AI_MODEL_LOADING_LABEL;

    var poll = setInterval(function () {
        if (state.detectors && state.detectors[0]) {
            clearInterval(poll);
            shootStartBtn.disabled = false;
            shootStartBtn.innerText = AI_MODEL_READY_LABEL;
        }
    }, 200);

    // 万一AIモデル読込が失敗/極端に遅れた場合でも、操作不能のまま固まらないよう
    // 一定時間で強制的に解除する（フォールバック＝現状と同じ挙動に戻るだけ）
    setTimeout(function () {
        clearInterval(poll);
        if (shootStartBtn.disabled) {
            shootStartBtn.disabled = false;
            shootStartBtn.innerText = AI_MODEL_READY_LABEL;
        }
    }, 15000);
}

export function initShootFlow(dataService) {
    els.setupView = document.getElementById('shootSetupView');
    els.liveView = document.getElementById('shootLiveView');
    els.resultBanner = document.getElementById('shootResultBanner');
    els.modeSelect = document.getElementById('modeSelect');
    els.hint = document.getElementById('modeOrientationHint');
    els.calibStatusHint = document.getElementById('calibStatusHint');

    var shootStartBtn = document.getElementById('shootStartBtn');
    var backToSetupBtn = document.getElementById('shootBackToSetupBtn');
    var reshootBtn = document.getElementById('resultReshootBtn');
    var gotoConfirmBtn = document.getElementById('resultGotoConfirmBtn');
    var setupCalibrateBtn = document.getElementById('setupCalibrateBtn');
    var setupArucoCalibrateBtn = document.getElementById('setupArucoCalibrateBtn');
    var arucoStartDetectBtn = document.getElementById('arucoStartDetectBtn');
    var arucoPrintGuideBtn = document.getElementById('arucoPrintGuideBtn');
    var arucoCalibConfirmBtn = document.getElementById('arucoCalibConfirmBtn');
    var arucoCalibRetryBtn = document.getElementById('arucoCalibRetryBtn');
    var arucoCalibCancelBtn = document.getElementById('arucoCalibCancelBtn');

    updateArucoCalibStatusHint();

    // 2026-08-05追加: 研究機関向け「静止姿勢: アルコ正中線モード」トグル。
    // state.useArucoMidlineへ直接反映するだけの単純な配線（実際の有効・
    // 無効判定はjs/core/state.jsのgetEffectiveArucoMidlineXが一元的に行う）。
    var useArucoMidlineToggle = document.getElementById('useArucoMidlineToggle');
    if (useArucoMidlineToggle) {
        useArucoMidlineToggle.checked = !!state.useArucoMidline;
        useArucoMidlineToggle.onchange = function () {
            state.useArucoMidline = useArucoMidlineToggle.checked;
        };
    }

    if (els.modeSelect) els.modeSelect.addEventListener('change', updateOrientationHint);
    updateOrientationHint();

    if (shootStartBtn) {
        waitForAiModelReady(shootStartBtn);

        shootStartBtn.onclick = function () {
            calibrationEntryMode = false;
            setCalibGuideLinesVisible(false); // 通常の撮影開始時は目安線を出さない（念のための保険。
                                                // 通常は各キャリブレーション終了経路で既にfalseになっている）
            showLive(false);
            startBtn.click(); // core/camera.js の既存起動フローをそのまま利用
        };
    }

    if (setupCalibrateBtn) {
        setupCalibrateBtn.onclick = startFixedCalibrationFromSetup;
    }

    if (setupArucoCalibrateBtn) {
        setupArucoCalibrateBtn.onclick = startArucoFixedCalibrationFromSetup;
    }

    if (arucoStartDetectBtn) {
        arucoStartDetectBtn.onclick = startArucoDetectionFlow;
    }

    if (arucoPrintGuideBtn) {
        arucoPrintGuideBtn.onclick = openArucoPrintGuide;
    }

    if (arucoCalibConfirmBtn) {
        // 2点タップの「校正済み」表示(els.calibStatusHint)とは別に、4隅ArUco
        // 専用のarucoCalibStatusHintにのみ結果を出す（両者は独立した表示）。
        arucoCalibConfirmBtn.onclick = function () {
            if (!_arucoLastResult) return;
            applyAndPersistCalibration(_arucoLastResult);
            updateArucoCalibStatusHint();
            arucoCalibrationEntryMode = false;
            _arucoLastResult = null;
            var panel = document.getElementById('arucoCalibPanel');
            if (panel) panel.style.display = 'none';
            setCalibGuideLinesVisible(false);
            stopArucoQuadCalibration();
            stopCameraStream();
            showSetup();
        };
    }

    if (arucoCalibRetryBtn) {
        arucoCalibRetryBtn.onclick = function () {
            _arucoLastResult = null;
            resetArucoCalibPanelUI();
        };
    }

    if (arucoCalibCancelBtn) {
        arucoCalibCancelBtn.onclick = closeArucoCalibPanel;
    }

    if (backToSetupBtn) {
        backToSetupBtn.onclick = function () {
            // キャリブレーション途中で「設定に戻る」が押された場合に備え、
            // calibration.js側の状態・ボタン表示もidleへ戻しておく
            if (calibrationEntryMode) {
                calibrationEntryMode = false;
                state.calibState = 'idle';
                state.calibrationPoints = [];
                if (calibrateMatBtn) {
                    calibrateMatBtn.classList.remove('active');
                    calibrateMatBtn.innerText = '📏 マット校正(45cm)';
                }
                var dpad = document.getElementById('dpadPanel');
                if (dpad) dpad.style.display = 'none';
            }
            // 4隅ArUco校正の途中で「モード選択に戻る」が押された場合も同様に、
            // 検出ループを止めてパネルを隠す（2026-08-03追加）。
            if (arucoCalibrationEntryMode) {
                arucoCalibrationEntryMode = false;
                stopArucoQuadCalibration();
                _arucoLastResult = null;
                var arucoPanel = document.getElementById('arucoCalibPanel');
                if (arucoPanel) arucoPanel.style.display = 'none';
            }
            setCalibGuideLinesVisible(false);
            stopCameraStream();
            showSetup();
        };
    }

    if (reshootBtn) {
        reshootBtn.onclick = async function () {
            if (els.resultBanner) els.resultBanner.classList.remove('active');
            var controls = await import('./controls.js');
            controls.exitPlaybackMode();
            showLive(false);
        };
    }

    // 動作解析（動的種目）の「✅ 決定して確認画面へ」。撮影完了直後の結果
    // バナーは「🔁 再測定/✅ 決定して確認画面へ」の2択だけに絞り（2026-07-29
    // のご要望対応）、再生・微調整・CSV・確定・レポートといった詳しい操作は
    // ここから遷移する専用の撮影確認画面(js/ui/dynConfirm.js、静止4方向の
    // 4面確認・修正画面と同じ位置づけ)側でまとめて行う。
    if (gotoConfirmBtn) {
        gotoConfirmBtn.onclick = function () {
            if (els.resultBanner) els.resultBanner.classList.remove('active');
            if (window.__showDynConfirmScreen) window.__showDynConfirmScreen(state.activeSessionId, state.currentTab);
        };
    }

    // 撮影完了直後（録画→保存成功）に結果バナーを表示するためのフック。
    // recorder.js の initRecorder(dataService, onSaved) の onSaved から呼ばれる。
    // 静止4方向（前面/左側面/後面/右側面）は、専用の4面確認・修正画面
    // (batchReview.js)が「もう一度撮影する/確認画面へ」に相当する役割を
    // 引き継いだため、このフローティングバナーは重複表示になる上、撮影
    // ボタンの上に重なって押しにくくなるとの指摘があった。静止4方向の
    // 保存時（撮り直し含む）は出さず、動作解析（動的種目）の保存時のみ表示する。
    // 呼ばれる時点ではまだstate.currentTabは advanceToNextMeasurement で
    // 更新される前なので「今保存したポーズ」を正しく指している。
    window.__onSessionSaved = function () {
        if (state.isRetakingBatchPose) return;
        // 重心動揺は動作解析と同じ「保存直後にこのバナーを見せる」扱いにする
        // （2026-07-30、判定をstate.jsへ一本化）。
        var isStaticMode = isStaticModeCheck(state.currentTab);
        if (isStaticMode && !state.isHistoryPlaybackSession) return;
        showLive(true);
    };

    // 履歴からの再生読込・4面確認/修正画面からの個別ポーズ編集・専門家の
    // JSONインポート後に「結果」表示へ直接切替えるためのフック。
    // これらはいずれも1件の既存データを再生・微調整する画面
    // (state.isHistoryPlaybackSession===true)なので、既にplaybackControls側に
    // 再生・微調整・書き出し系ツールが表示される。この上にさらに
    // 「✓ 履歴に保存しました」のフローティングバナーが重なると見づらく、
    // 「もう一度撮影する/詳細レポートを見る」という保存直後向けの案内も
    // 文脈に合わないため、この場合は出さない。
    window.__enterShootResultView = function () {
        if (state.isHistoryPlaybackSession) {
            showLive(false);
            return;
        }
        showLive(true);
    };

    // 撮影設定カードからの固定設置キャリブレーションが完了した直後のフック。
    // calibration.js の2点タップ完了時に呼ばれる（app.js経由）。
    window.__onMatCalibrationDone = function (ratio) {
        if (!calibrationEntryMode) return;
        calibrationEntryMode = false;
        setCalibGuideLinesVisible(false);
        stopCameraStream();
        showSetup();
        if (els.calibStatusHint) {
            els.calibStatusHint.style.display = 'block';
            els.calibStatusHint.textContent = '✅ 校正済み (1px = ' + ratio.toFixed(3) + 'cm)';
        }
    };

    onRoute(function (route) {
        if (route !== 'shoot') {
            // 撮影ページから離れたら、ライブビュー専用のナビ出し分け
            // (body.shoot-live-active、style.css参照)は必ず解除する。
            // カメラ自体は裏で状態を保持したまま動き続けることがある
            // (state.isRunning維持、撮影ページに戻ると再度ライブ表示される)
            // が、それとは無関係に「今、実際にライブビューが画面に出て
            // いるか」だけを表すクラスなので、他ページ表示中までナビの
            // 位置がライブビュー仕様のままになってしまうバグ
            // （左サイドレールのはずが下部バーになる等）を防ぐため。
            document.body.classList.remove('shoot-live-active');
            return;
        }
        if (state.appMode === 'playback') {
            // location.hash経由のnavigate('shoot')は'hashchange'を非同期に
            // 発火するため、history.jsのloadSession()やdynConfirm.jsの
            // openForEdit()が「loadSession()→navigate('shoot')→
            // __enterShootResultView()」の順で同期的に呼んでも、この
            // onRouteリスナー自体は少し遅れて（次のタスクで）実行される。
            // その結果、__enterShootResultView()が正しく
            // showLive(false)（履歴/微調整の再生画面）に揃えた直後に、
            // ここが無条件でshowLive(true)を呼び直し、撮影直後専用の
            // 小さな結果バナー(🔁再測定/✅決定して確認画面へ)を再表示して
            // しまっていた。このバナーは再生コントロール（▶再生等）付近に
            // 重なる位置に出るため、押したつもりの再生ボタンがバナー側の
            // 要素に取られてしまい、「確認画面から再生しても骨格点が
            // 動かない」という不具合として報告されていた（2026-07-30）。
            // __enterShootResultView()と同じ判定式に揃え、履歴・個別
            // 微調整の再生セッションでは結果バナーを出さないようにする。
            showLive(!state.isHistoryPlaybackSession);
        } else if (state.isRunning) {
            showLive(false);
        } else {
            showSetup();
            // 「撮影」タブに実際に入って、撮影設定（モード選択）画面を
            // 表示するタイミングでのみ呼ぶ（ホーム画面表示時など他の
            // タイミングでは呼ばない）。まだ今回のセッションでカメラの
            // 許可を得ていなければ、ここで先出ししてカメラ一覧
            // （前面/背面/広角等）を最初から正しく出せるようにする
            // （camera.js側で許可済みなら何もしない実装のため安全）。
            warmUpCameraLabels();
        }
    });

    showSetup();
}
