/**
 * camera.js
 * ---------------------------------------------------------------------------
 * カメラストリームの起動、MediaPipe/TensorFlow.js による姿勢推定ループ、
 * ライブ描画（骨格・Kendallアライメント・荷重・COPレーダー等）を担当。
 * 元 app.js の init()（AIモデル読込部分）/ startBtn.onclick / render() /
 * checkAthleteVisibility / Auto-REC 判定ロジックを移植。
 */

import { state, getModeCategory, getEffectiveArucoMidlineX, shouldShowCopRadar } from './state.js';
import { video, canvasMP, ctxMP, canvasComb, ctxComb, canvasRadarMP, ctxRadarMP, radarWrapperMP, startBtn, recBtn, videoSource, heightInput, footSizeInput, debugCameraResolutionDisplay, selfTimerSelect } from './dom.js';
import biomechanics from '../biomechanics.js';
import { autoEstimateScaleRatio, updateInfoPanel } from './calibration.js';
import { generateVirtualASIS, estimatePelvicTiltFromKeypoints } from './calibration.js';
import { reportDataStore } from './state.js';
import { updateModeUI, checkDeviceType, updateCameraModeBadge } from '../ui/controls.js';
import { requestDeviceOrientationPermission, resetAutoRecCountdown, triggerAutoRecStandby, updateDigitalLevel } from './orientation.js';

var detectorsReady = false;
var cameraLabelsUnlocked = false; // getUserMedia許可前は端末名(前面/背面/広角等)が空文字になるため、許可後に一度だけ再取得する

export async function initPoseModel() {
    try {
        startBtn.innerText = "⏳ AIモデル読込中...";
        startBtn.disabled = true;

        await tf.setBackend('webgl');
        await tf.ready();

        state.detectors[0] = await poseDetection.createDetector(poseDetection.SupportedModels.BlazePose, {
            runtime: 'mediapipe',
            solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/pose',
            modelType: 'full'
        });

        detectorsReady = true;
        startBtn.innerText = "📷 フルHD起動";
        startBtn.disabled = false;
        updateInfoPanel();
        updateCameraModeBadge();
        return true;
    } catch (e) {
        startBtn.innerText = "❌ 起動エラー";
        console.error("AI Initialization Error:", e);
        return false;
    }
}

export async function enumerateCameras() {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        try {
            var devices = await navigator.mediaDevices.enumerateDevices();
            var previousValue = videoSource.value; // カメラ権限許可後の再列挙で選択を維持するため
            videoSource.innerHTML = '';
            var camCount = 1, hasCam = false;
            devices.forEach(function (d) {
                if (d.kind === 'videoinput') {
                    // 権限許可前は d.label が空文字になるブラウザが多いため、
                    // その場合は「カメラ1」等の連番にフォールバックする。
                    videoSource.appendChild(new Option(d.label || "カメラ " + camCount++, d.deviceId));
                    hasCam = true;
                }
            });
            if (!hasCam) {
                videoSource.innerHTML = '<option value="">カメラなし</option>';
            } else if (previousValue && Array.prototype.some.call(videoSource.options, function (o) { return o.value === previousValue; })) {
                videoSource.value = previousValue;
            }
        } catch (e) {
            console.warn("Could not enumerate devices directly on load:", e);
            videoSource.innerHTML = '<option value="">カメラ検出スキップ</option>';
        }
    } else {
        videoSource.innerHTML = '<option value="">⚠️ HTTPS必須 (デプロイ環境)</option>';
    }
}

/**
 * 撮影設定（モード選択）画面に来た���点で、カメラの正式な許可
 * (getUserMedia)を一度も得ていなければ、ここで一瞬だけ許可を求めて
 * すぐに手放す（映像は使わず即座にトラックを停止する）。
 *
 * 許可前のenumerateDevices()はカメラの名前どころか正確な台数すら
 * 返せない（プライバシー保護のためのブラウザ共通の仕様）ため、これまでは
 * 「撮影へ進む」を押して実際にgetUserMediaが呼ばれる＝1回撮影の
 * ライブ画面まで進んで初めて、設定画面に戻った時に全カメラが選べる
 * ようになっていた（モード選択画面の最初の表示ではカメラが1台しか
 * 出ない、という問い合わせの原因）。
 * この関数を撮影設定画面の表示時に呼ぶことで、その場で先出しして
 * 解消する。既に許可済み(cameraLabelsUnlocked)なら何もしない。
 * ユーザーが許可を拒否した場合もエラー表示はせず、従来通りの
 * フォールバック表示（カメラ1、等）のままにする。
 */
export async function warmUpCameraLabels() {
    if (cameraLabelsUnlocked) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    try {
        var stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach(function (t) { t.stop(); });
        cameraLabelsUnlocked = true;
        await enumerateCameras();
    } catch (e) {
        console.warn("[camera] Camera label warm-up failed (permission denied or unavailable):", e);
    }
}

/**
 * 現在カメラ欄(#videoSource)で選択されている機種名にOBSBOTが含まれるかを
 * 判定する（機種名によるフレームレート最適化の適用可否判定専用、
 * 2026-08-04追加）。ラベル(機種名)は許可前は空文字のため、
 * cameraLabelsUnlocked（許可済み）になるまではfalseを返す。
 * OBSBOT以外のカメラ・タブレット/スマホ内蔵カメラでは常にfalseになり、
 * それらの起動条件には一切影響しない。
 */
function isObsbotCameraSelected() {
    if (!cameraLabelsUnlocked || !videoSource || videoSource.selectedIndex < 0) return false;
    var opt = videoSource.options[videoSource.selectedIndex];
    return !!(opt && opt.text && opt.text.toUpperCase().indexOf('OBSBOT') !== -1);
}

// ─────────────────────────────────────────────────────────────────────────
// カメラ縦置き設置時の回転補正（2026-08-04追加）。詳細はstate.jsの
// cameraRotationDeg定義コメント参照。ここで生の<video>フレームを
// state.cameraRotationDegに応じて回転補正した「直立フレーム」に変換し、
// 姿勢推定・表示描画・（js/core/arucoCalibration.jsの）ArUcoマーカー
// 検出のすべてがこの関数の戻り値を共通の入力として使うことで、回転補正の
// ロジックを1箇所に閉じ込め、床面ホモグラフィ等の座標系のズレを防ぐ。
// ─────────────────────────────────────────────────────────────────────────
var _rotatedSourceCanvas = null;
var _rotatedSourceCtx = null;

/**
 * 現在の回転設定を反映した、実効フレームサイズ{width, height}を返す。
 * 90度/-90度回転時は幅と高さが入れ替わる。
 */
export function getEffectiveFrameSize() {
    var rot = state.cameraRotationDeg || 0;
    var rawW = video.videoWidth || 0, rawH = video.videoHeight || 0;
    return (rot === 90 || rot === -90) ? { width: rawH, height: rawW } : { width: rawW, height: rawH };
}

/**
 * 生の<video>フレームを回転補正した「直立フレーム」を返す。
 * 回転なし(0度、既定)の場合は追加コスト無しでvideo要素をそのまま返す
 * （従来通りの挙動、既存の横置き運用には一切影響しない）。
 * 90度/-90度��場合のみ、隠しcanvasへ回転描画してそれを返す。
 */
export function getUprightVideoFrame() {
    var rot = state.cameraRotationDeg || 0;
    if (rot !== 90 && rot !== -90) return video;
    var rawW = video.videoWidth || 0, rawH = video.videoHeight || 0;
    if (!rawW || !rawH) return video;
    if (!_rotatedSourceCanvas) {
        _rotatedSourceCanvas = document.createElement('canvas');
        _rotatedSourceCtx = _rotatedSourceCanvas.getContext('2d');
    }
    _rotatedSourceCanvas.width = rawH;
    _rotatedSourceCanvas.height = rawW;
    _rotatedSourceCtx.save();
    _rotatedSourceCtx.translate(rawH / 2, rawW / 2);
    _rotatedSourceCtx.rotate(rot * Math.PI / 180); // canvas.rotate()は正の値で時計回り
    _rotatedSourceCtx.drawImage(video, -rawW / 2, -rawH / 2, rawW, rawH);
    _rotatedSourceCtx.restore();
    return _rotatedSourceCanvas;
}

// ─────────────────────────────────────────────────────────────────────────
// 「クリーンな写真」キャプチャ（2026-08-25追加）。
// 従来のcaptureSkeletonImage()（js/ui/controls.js）は、骨格線・正中線等の
// オーバーレイまで焼き込み済みのcanvasMP全体をtoDataURL()していたため、
// 確認画面（写真を表示トグル）でその上からさらに現在の骨格点をリアルタイム
// 描画すると「線が二重に重なる」不具合になっていた（企画者からのご指摘、
// 2026-08-24）。また一度確定した写真は撮影時点の骨格線のまま固定されて
// しまうため、D-padで関節点を微調整した後もレポート・サムネイルの画像には
// 反映されない、という別の不具合の原因にもなっていた。
// この関数は「映像フレームそのもの（骨格線等の重ね書き無し）」だけを
// 切り出して返す。render()の映像描画ロジック（セルフィー時の左右反転含む）
// と全く同じ内容を、別の隠しcanvasに複製するだけで、canvasMP自体（ライブ
// 描画用）には一切手を加えない。
// 骨格オーバーレイは、この「クリーンな写真」の上に、保存済みのposeData
// （関節点座標）から表示のたびに毎回リアルタイムで重ね描きする方式に統一する
// （js/ui/controls.jsのrenderPlaybackFrame/refreshReportView/drawPoseOverlay、
// js/ui/dashboard.js・js/ui/batchReview.js・js/ui/dynConfirm.jsの各表示箇所）。
// これにより「二重に重なる」不具合が構造的に起きなくなり、かつD-pad修正後の
// 最新の関節点がレポート等にも自動的に反映されるようになる（写真自体は
// 撮影時点のまま変わらないため、サーバー容量が余分に増えることもない）。
// ─────────────────────────────────────────────────────────────────────────
export function captureCleanVideoFrame() {
    var frameSource = getUprightVideoFrame();
    var effSize = getEffectiveFrameSize();
    var w = effSize.width, h = effSize.height;
    if (!w || !h) return null;

    var off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    var octx = off.getContext('2d');

    if (state.isSelfie) {
        octx.save();
        octx.translate(w, 0);
        octx.scale(-1, 1);
        octx.drawImage(frameSource, 0, 0, w, h);
        octx.restore();
    } else {
        octx.drawImage(frameSource, 0, 0, w, h);
    }
    return off;
}

// js/ui/controls.jsは既にこのファイル（camera.js）からimportされているため
// （updateModeUI等）、逆方向にcontrols.js→camera.jsをimportすると循環importに
// なってしまう。既存のwindow.__speakGuidance（app.js）と同じブリッジパターンで、
// controls.jsのcaptureSkeletonImage()からdataURLとして呼べるようにする。
window.__captureCleanVideoFrameDataUrl = function (quality) {
    var off = captureCleanVideoFrame();
    if (!off) return null;
    try {
        return off.toDataURL('image/jpeg', quality || 0.85);
    } catch (e) {
        console.error('[camera] captureCleanVideoFrame dataURL変換に失敗:', e);
        return null;
    }
};

export function bindStartButton(onStarted) {
    startBtn.onclick = async function () {
        state.renderSessionId++;
        var currentSession = state.renderSessionId;

        if (state.mainRenderId) { cancelAnimationFrame(state.mainRenderId); state.mainRenderId = null; }
        if (state.currentStream) {
            state.currentStream.getTracks().forEach(function (t) { t.stop(); });
            video.pause();
            video.srcObject = null;
        }

        state.swayHistoryMP = [];
        state.selectedJointIndex = null;
        state.isPausedForEdit = false;
        state.staticBackgroundData = null;
        state.appMode = "camera";

        state.activeExpertComment = "";
        state.activeExpertExercises = "";
        state.activeSessionId = null;

        document.getElementById('playbackControls').style.display = 'none';
        document.getElementById('mainControls').style.display = 'flex';
        document.getElementById('startBtn').style.display = 'none';
        document.getElementById('recBtn').style.display = 'flex';
        document.getElementById('recBtn').disabled = false;
        updateCameraModeBadge();

        setTimeout(async function () {
            if (currentSession !== state.renderSessionId) return;

            try {
                // 「撮影した写真が荒い」という報告を受けて、単なる希望(ideal)だけでなく
                // 下限(min)も指定することで、カメラ/ブラウザ側にできるだけ高い解像度で
                // 応答するよう促す（v4.6.17）。ただしminは古い/安価なWebカメラ等では
                // 満たせずgetUserMediaが失敗することがあるため、失敗時は下のcatchで
                // 従来通りminなし(ideal希望のみ)に緩めて再試行する。
                var constraints = { video: { width: { ideal: 1920, min: 1280 }, height: { ideal: 1080, min: 720 } } };

                // OBSBOT Meet SE使用時のみ、フルHD(1920×1080=16:9)でカメラ実機の
                // 最大フレームレート（公式仕様: 1080p@100fps）を明示的に希望する。
                // frameRateは「min/exact」ではなく「ideal」指定のため、対応できない
                // 機種（それ以外のWebカメラ・タブレット/スマホ内蔵カメラ）では単に
                // 無視され、今まで通りの挙動のまま変化しない。あえて全カメラ共通に
                // せず機種名判定（isObsbotCameraSelected）で絞っているのは、複数の
                // 解像度/フレームレートの組み合わせを持つ一部の多機能カメラで、
                // width/height/frameRateを同時にidealで満たそうとするブラウザの
                // フィッティング処理が意図しない組み合わせ（解像度を落として
                // フレームレートを優先する等）を選んでしまう可能性を避けるため
                // （企画者との相談・合意、2026-08-04）。
                if (isObsbotCameraSelected()) {
                    constraints.video.frameRate = { ideal: 100 };
                }

                // 重要: 撮影設定カードの「撮影スタイル」でセルフ撮影を選んだ場合は、
                // カメラ欄に前回選択済みのdeviceId（背面レンズ等）が残っていても
                // それより facingMode:"user" を優先する。そうしないと、一度でも
                // 通常撮影で背面カメラを使った後は videoSource.value に背面カメラの
                // deviceIdが残り続け、以降ずっとその背面カメラのdeviceIdが優先されて
                // しまい、セルフ撮影を選んでも実際には前面カメラに切り替わらない
                // （＝選んでも反映されないように見える）不具合があった。
                if (state.isSelfie) {
                    constraints.video.facingMode = { exact: "user" };
                } else if (videoSource.value && cameraLabelsUnlocked) {
                    // 重要: カメラ許可が一度も下りていない最初の1回は、たとえ videoSource.value に
                    // 値が入っていても deviceId を名指ししない。許可前のenumerateDevices()は
                    // iOS等では不正確な「1台だけ」の情報しか返さないことがあり、その不正確な1台を
                    // 名指しで許可してしまうと、許可後もその1台にしかアクセスできない状態に
                    // ロックされてしまう端末がある（=カメラ選択肢が増えない原因）。
                    // ラベル取得済み(cameraLabelsUnlocked)になって初めて、ユーザーが選んだ
                    // deviceId を信頼して使う。
                    constraints.video.deviceId = { exact: videoSource.value };
                } else if (state.isMobileView) {
                    constraints.video.facingMode = { exact: state.cameraFacingMode };
                } else {
                    constraints.video.facingMode = { ideal: "environment" };
                }

                try {
                    state.currentStream = await navigator.mediaDevices.getUserMedia(constraints);
                } catch (err) {
                    // facingMode:exact が満たせない端末、またはwidth/heightのmin
                    // (1280x720)を満たせないカメラのどちらでも、ここに落ちてくる。
                    // 原因を厳密に切り分けず、両方まとめて緩めて1回だけ再試行する
                    // （従来のfacingMode緩和に加え、v4.6.17でmin解像度指定も撤回）。
                    console.warn("Camera constraint failed (facingMode or min resolution too strict), retrying with relaxed constraints:", err);
                    if (constraints.video.facingMode) constraints.video.facingMode = { ideal: state.cameraFacingMode };
                    if (constraints.video.deviceId) delete constraints.video.deviceId;
                    constraints.video.width = { ideal: 1920 };
                    constraints.video.height = { ideal: 1080 };
                    state.currentStream = await navigator.mediaDevices.getUserMedia(constraints);
                }
                video.srcObject = state.currentStream;
                if (!cameraLabelsUnlocked) {
                    // 初回のカメラ許可が下りたことで、スマホなら前面/背面/広角など
                    // 複数レンズがラベル付きで選べるようになる。設定画面に戻った
                    // 時点でちゃんと選べるよう、一覧を1回だけ取り直しておく。
                    cameraLabelsUnlocked = true;
                    enumerateCameras();
                }
                video.onloadeddata = function () {
                    // 縦置き回転補正時(state.cameraRotationDeg = ±90)は幅と高さが
                    // 入れ替わった「実効サイズ」でキャンバスを確保する。以降の
                    // 骨格描画・COPレーダー等はすべてこのキャンバスサイズを基準に
                    // 動くため、ここで一度だけ正しいサイズに合わせておけばよい。
                    var effSize = getEffectiveFrameSize();
                    canvasMP.width = effSize.width;
                    canvasMP.height = effSize.height;
                    canvasComb.width = effSize.width;
                    canvasComb.height = effSize.height;
                    state.isRunning = true;
                    video.play();

                    // 検証用: カメラ/ブラウザが実際に応答してきた解像度・フレームレートを
                    // 設定画面で確認できるようにする（「撮影した写真が荒い」という報告の
                    // 切り分け用。リクエストしている1920x1080希望と実際の値が
                    // 一致しているとは限らないため、実測値をそのまま表示する）。
                    // フレームレートはideal指定（希望値、必須ではない）のため、
                    // OBSBOT側で実際に何fpsが返ってきたかをここで併記し、
                    // 「最大フレームレートを使いたい」という要望が実機で本当に
                    // 満たせているかを確認できるようにする（2026-08-04追加）。
                    if (debugCameraResolutionDisplay) {
                        var resText = video.videoWidth + " × " + video.videoHeight + " px";
                        try {
                            var track = state.currentStream && state.currentStream.getVideoTracks && state.currentStream.getVideoTracks()[0];
                            var settings = track && track.getSettings ? track.getSettings() : null;
                            if (settings && typeof settings.frameRate === 'number') {
                                resText += " @ " + settings.frameRate.toFixed(1) + "fps";
                            }
                        } catch (e) { /* getSettings未対応ブラウザでは無視 */ }
                        debugCameraResolutionDisplay.innerText = resText;
                    }

                    document.getElementById('startBtn').style.display = 'none';
                    document.getElementById('recBtn').style.display = 'flex';
                    document.getElementById('recBtn').disabled = false;

                    var isMobileOrTablet = window.innerWidth < 1024;
                    if (isMobileOrTablet) {
                        var settings = document.getElementById('settingsWrapper');
                        var btn = document.getElementById('toggleUiBtn');
                        if (settings && btn) {
                            settings.style.display = 'none';
                            btn.innerText = '🔼 UIを表示';
                        }
                    }

                    // 以前は「画面幅768px未満＝スマホ」の時だけジャイロの許可を
                    // 求めていたが、タブレットは横向き・大画面だと768px以上に
                    // なりがちで、実際にジャイロを搭載していても許可すら求めず
                    // 水準器が一切使えない不具合があった。v4.6.19より画面幅に
                    // 関係なく許可を試み、実際にセンサーからデータが取れた端末
                    // だけ水準器UIを表示する方式に変更した
                    // （state.gyroSensorConfirmed、js/core/orientation.js参照）。
                    if (!state.isGyroEnabled) {
                        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
                            document.getElementById('gyroPermissionModal').style.display = 'block';
                        } else {
                            requestDeviceOrientationPermission();
                        }
                    }
                    checkDeviceType();
                    render(currentSession);
                    if (typeof onStarted === 'function') onStarted();
                };
            } catch (e) {
                console.error("Camera startup failed:", e);
                document.getElementById('startBtn').style.display = 'flex';
                document.getElementById('recBtn').style.display = 'none';
                alert("カメラの起動に失敗しました。カメラパーミッションを確認してください。");
            }
        }, 150);
    };
}

async function render(sessionId) {
    if (sessionId !== state.renderSessionId) return;

    if (!state.isRunning || state.appMode === 'playback' || state.isPausedForEdit) {
        if (state.isRunning) state.mainRenderId = requestAnimationFrame(function () { render(sessionId); });
        return;
    }

    if (video.readyState < 2) {
        state.mainRenderId = requestAnimationFrame(function () { render(sessionId); });
        return;
    }

    // frameSourceは「回転補正済みの直立フレーム」（縦置き設置時のみ隠し
    // canvas、横置き時は従来通りvideo要素そのまま）。姿勢推定・表示描画の
    // 両方がこれを共通の入力として使うことで、骨格座標系を一致させる
    // （state.cameraRotationDeg、2026-08-04追加）。
    var frameSource = getUprightVideoFrame();
    var effSize = getEffectiveFrameSize();
    var w = effSize.width, h = effSize.height;

    if (state.isSelfie) {
        ctxMP.save();
        ctxMP.translate(w, 0);
        ctxMP.scale(-1, 1);
        ctxMP.drawImage(frameSource, 0, 0, w, h);
        ctxMP.restore();
    } else {
        ctxMP.drawImage(frameSource, 0, 0, w, h);
    }

    biomechanics.drawCenterGrid(ctxMP, canvasMP);

    if (state.calibState !== "idle") {
        ctxMP.fillStyle = "#ffeb3b";
        if (state.calibrationPoints[0]) {
            ctxMP.beginPath(); ctxMP.arc(state.calibrationPoints[0].x, state.calibrationPoints[0].y, 8, 0, 2 * Math.PI); ctxMP.fill();
            if (state.calibState === "adjust_left") biomechanics.drawCrosshair(ctxMP, state.calibrationPoints[0], canvasMP);
        }
        if (state.calibrationPoints[1]) {
            ctxMP.beginPath(); ctxMP.arc(state.calibrationPoints[1].x, state.calibrationPoints[1].y, 8, 0, 2 * Math.PI); ctxMP.fill();
            if (state.calibState === "adjust_right") biomechanics.drawCrosshair(ctxMP, state.calibrationPoints[1], canvasMP);
        }
    }

    var poses = [];
    try {
        poses = await state.detectors[0].estimatePoses(frameSource);
    } catch (e) {
        console.error("Pose estimation error:", e);
    }

    if (poses.length > 0) {
        var kps = poses[0].keypoints;

        // 2026-08-25追加: 骨盤傾斜角（近似値）を、左右側面撮影中のみ毎フレーム
        // 推定してstate.estimatedPelvicTiltへ反映する。generateVirtualASIS()は
        // この値を使って仮想ASIS点を投影するため、必ずその直前に呼ぶ
        // （js/core/calibration.jsのestimatePelvicTiltFromKeypoints参照。
        // カメラのロール補正はこの関数内では不要 - 詳細は同関数のコメント参照）。
        // 信頼度不足等でnullが返った場合は、前フレームの値をそのまま維持する
        // （いきなり0へ戻して仮想ASIS表示がガクつくのを防ぐため）。l_side/
        // r_side以外のモードでは常に0が返るため、側面撮影から他モードへ
        // 切り替えた時に前の値が残ったままになることもない。
        var pelvicTiltEstimate = estimatePelvicTiltFromKeypoints(kps, state.currentTab);
        if (pelvicTiltEstimate !== null) state.estimatedPelvicTilt = pelvicTiltEstimate;

        kps = generateVirtualASIS(kps);
        reportDataStore[state.currentTab] = kps;

        autoEstimateScaleRatio(kps);

        if (state.isRecording) {
            state.coordinateBufferMP.push(kps);
            state.poseDataLog.push({ time: Date.now(), mode: state.currentTab, keypoints: JSON.parse(JSON.stringify(kps)) });
        }

        var drawKps = JSON.parse(JSON.stringify(kps));
        if (state.isSelfie) {
            drawKps.forEach(function (kp) { if (kp) kp.x = w - kp.x; });
        }

        // 骨格点の色は「連続録画系（重心動揺・動作解析）は緑、静止姿勢は赤」で
        // 統一する（2026-07-30、重心動揺モード追加時にgetModeCategoryへ一本化）。
        var color = getModeCategory(state.currentTab) !== 'static' ? '#39ff14' : '#ff5252';
        biomechanics.drawSkeleton(ctxMP, drawKps, color);
        if (window.updateWebGLPose) window.updateWebGLPose(drawKps, w, h);

        if (state.currentTab === 'l_side' || state.currentTab === 'r_side') {
            biomechanics.drawKendallAlignment(ctxMP, drawKps, state.pxToCmRatio, parseFloat(footSizeInput.value), state.estimatedPelvicTilt, state.currentTab, w, h, getEffectiveArucoMidlineX(state.currentTab));
        } else if (state.currentTab === 'front' || state.currentTab === 'back' || state.currentTab === 'dyn_overhead') {
            biomechanics.calculateWeightBearing(ctxMP, drawKps, w, h, getEffectiveArucoMidlineX(state.currentTab));
        }

        if (state.currentTab === 'dyn_overhead') {
            biomechanics.drawOHSFrontAnalysis(ctxMP, drawKps);
        } else if (state.currentTab === 'dyn_overhead_side') {
            biomechanics.drawOHSSideAnalysis(ctxMP, drawKps);
        } else if (state.currentTab.startsWith('dyn_flex_')) {
            biomechanics.drawFlexionAnalysis(ctxMP, drawKps, state.currentTab);
        } else if (state.currentTab.startsWith('dyn_shoulder_')) {
            biomechanics.drawShoulderAnalysis(ctxMP, drawKps, state.currentTab);
        }

        // 2026-08-24: COPレーダーは静止4方向のうち正面(front)以外
        // （back/l_side/r_side）では表示・データ収集しない（js/core/state.js
        // のshouldShowCopRadar参照）。ウィジェット自体の表示切替は
        // モード切替のタイミングで一度だけ行う（js/ui/controls.jsの
        // updateModeUI）ため、ここでは毎フレームの更新呼び出しだけをスキップする。
        // 2026-08-25: レポートに書き込まれる軌跡とライブ表示の軌跡が別計算式
        // だったため見た目が食い違う、との指摘を受け、ロール補正込みの
        // computeCopOffsetMm()（js/biomechanics.js）に一本化。ライブ撮影中は
        // その場の校正値（state.arucoCalibratedRollDeg優先、無ければ
        // ジャイロのgamma）を渡す。レポート側（js/api.jsのextractMetrics）と
        // 同じcopCtx形状。
        if (shouldShowCopRadar(state.currentTab)) {
            var liveRollDeg = (typeof state.arucoCalibratedRollDeg === 'number')
                ? state.arucoCalibratedRollDeg
                : (state.gyroSensorConfirmed ? state.deviceOrientation.gamma : null);
            var liveCopCtx = {
                rollDeg: liveRollDeg,
                canvasWidth: canvasMP.width,
                canvasHeight: canvasMP.height,
                floorHomography: state.floorHomography,
                pxToCmRatio: state.pxToCmRatio
            };
            biomechanics.updateRadar(drawKps, canvasRadarMP, ctxRadarMP, state.swayHistoryMP, state.isRecording, getModeCategory(state.currentTab) !== 'static' ? '#39ff14' : '#ff5252', liveCopCtx);
        }

        if (state.appMode === 'camera' && state.isRunning) {
            checkAthleteVisibility(kps);
            // セルフタイマー（js/core/recorder.js、検証用・一時的機能）と、この
            // 自動撮影（一人で構えると自動で「レディ→3・2・1・スタート」と
            // 撮影を開始する既存機能）は、どちらも「一人で構えてから撮る」を
            // カバーする独立した仕組みのため、同時に有効なままだと、その場の
            // タイミング次第でどちらが先に発火するかが変わってしまう
            // （2026-08-24追記・不具合再調査）。片方が実際にボタンのクリックへ
            // 到達する直前まで両者は完全に独立して動いており、片方が
            // 撮影ボタンを無効化する（disabled化する）タイミング次第で、
            // もう片方の発火が黙って握りつぶされたり、意図と違うタイミングで
            // 撮影が始まったりする余地が残っていた（実機での「セルフタイマーを
            // 使ったのに4面確認画面が出ない・履歴がバラバラになる」という
            // ご報告の根本原因の可能性が高いと判断）。ここでセルフタイマーが
            // 選択されている間は自動撮影の待機・カウントダウン自体を一切
            // 開始しないようにし、2つの「一人で構えて撮る」仕組みが同時に
            // 動く状況自体を無くす（セルフタイマー未選択＝「タイマーなし」の
            // 時は、従来通りこの自動撮影がそのまま働く）。
            var selfTimerEngaged = !!(selfTimerSelect && (parseInt(selfTimerSelect.value) || 0) > 0);
            if (state.isMobileView && state.isSelfie && state.isDeviceVertical && state.isAthleteFullyVisible && !state.isRecording && !selfTimerEngaged) {
                if (!state.isAutoRecActive && !state.isAutoRecReady) {
                    triggerAutoRecStandby();
                }
            } else if (state.isMobileView && (!state.isSelfie || !state.isDeviceVertical || !state.isAthleteFullyVisible || selfTimerEngaged)) {
                resetAutoRecCountdown();
            }
        }
    }

    ctxComb.drawImage(canvasMP, 0, 0, w, h);
    state.mainRenderId = requestAnimationFrame(function () { render(sessionId); });
}

function checkAthleteVisibility(kps) {
    var requiredJoints = ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle'];
    var visibleCount = 0;
    var idxMap = { 'left_shoulder': 11, 'right_shoulder': 12, 'left_hip': 23, 'right_hip': 24, 'left_knee': 25, 'right_knee': 26, 'left_ankle': 27, 'right_ankle': 28 };

    requiredJoints.forEach(function (name) {
        var kp = kps.find(function (k) { return k.name === name; });
        if (!kp) kp = kps[idxMap[name]];
        if (kp && kp.score > 0.5) visibleCount++;
    });

    state.isAthleteFullyVisible = (visibleCount === requiredJoints.length);
}
