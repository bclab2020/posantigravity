/**
 * orientation.js
 * ---------------------------------------------------------------------------
 * スマホの傾きセンサー（ジャイロ）を使ったデジタル水準器、自撮り時の
 * 自動録画（スタンバイ→カウントダウン→撮影開始）、音声ガイダンスを担当。
 * 元 app.js の handleOrientation / updateDigitalLevel / requestDeviceOrientationPermission /
 * triggerAutoRecStandby / triggerAutoRecCountdown / resetAutoRecCountdown / speakGuidance を移植。
 */

import { state } from './state.js';
import { recBtn } from './dom.js';
import { checkDeviceType } from '../ui/controls.js';

var smoothOrientation = { beta: 90, gamma: 0 };
// 許可が下りた（またはそもそも許可不要な）直後に一定時間待っても
// 'deviceorientation'から有効な値が1回も来なければ、その端末には実際には
// ジャイロセンサーが無いと判断する（v4.6.19）。この間だけ使うタイマーなので
// モジュール内に閉じたローカル変数で十分。
var gyroDetectionTimer = null;
var GYRO_DETECTION_TIMEOUT_MS = 2000;
// 水準器の描画（updateDigitalLevel経由のDOM更新）をrequestAnimationFrameで
// 間引くためのフラグ（v4.9.2、ロール方向センサーの体感過敏さ改善）。
// 'deviceorientation'イベントは端末によっては非常に高頻度で発火するため、
// 毎回同期的にDOMへ書き込むとちらつき・過敏な反応に見えることがある。
// state.deviceOrientationへの反映自体は下のhandleOrientation内で毎回
// 同期的に行うため、capturedRollDeg等の記録精度には影響しない。
var levelRenderScheduled = false;

export function requestDeviceOrientationPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
            .then(function (permissionState) {
                if (permissionState === 'granted') {
                    window.addEventListener('deviceorientation', handleOrientation);
                    state.isGyroEnabled = true;
                    document.getElementById('gyroPermissionModal').style.display = 'none';
                    startGyroSensorDetection();
                } else {
                    alert("傾きセンサーの利用が拒否されました。手持ち測定水準器は無効化されます。");
                    document.getElementById('gyroPermissionModal').style.display = 'none';
                }
            })
            .catch(function (err) {
                console.error("DeviceOrientation permission error:", err);
                document.getElementById('gyroPermissionModal').style.display = 'none';
            });
    } else {
        window.addEventListener('deviceorientation', handleOrientation);
        state.isGyroEnabled = true;
        document.getElementById('gyroPermissionModal').style.display = 'none';
        startGyroSensorDetection();
    }
}

/**
 * 許可が下りた直後に呼ぶ。許可が下りること自体は「その端末にジャイロが
 * 載っているか」とは無関係（PCやジャイロ無しタブレットでも許可API自体は
 * 通ってしまうことがある）なので、ここでは水準器UIをまだ表示しない。
 * 実際に有効な値がhandleOrientation側で1回でも観測できた時点で
 * state.gyroSensorConfirmed=trueとなり、checkDeviceType()経由でUIが
 * 表示される。一定時間たっても観測できなければ「センサー無し」として
 * 諦める（UIは表示されないまま。エラー扱いにはしない＝機能が使えないだけ
 * で、他の操作は通常通り行える）。
 */
function startGyroSensorDetection() {
    if (state.gyroSensorConfirmed || gyroDetectionTimer) return;
    gyroDetectionTimer = setTimeout(function () {
        gyroDetectionTimer = null;
    }, GYRO_DETECTION_TIMEOUT_MS);
}

function handleOrientation(event) {
    if (event.beta !== null) smoothOrientation.beta = smoothOrientation.beta * 0.85 + event.beta * 0.15;
    if (event.gamma !== null) smoothOrientation.gamma = smoothOrientation.gamma * 0.85 + event.gamma * 0.15;

    // 水準器の描画用（smoothOrientation、このファイル内だけで使用）とは別に、
    // 他のモジュール（撮影確定時に角度を記録するjs/core/recorder.js等）からも
    // 「今の傾き」を参照できるよう、平滑化済みの値をstateにも反映しておく
    // （v4.6.20、正中線roll補正機能の基盤）。この代入は毎イベント同期的に
    // 行い、下のrAF間引きの影響を受けないようにする（capturedRollDeg等の
    // 記録精度を落とさないため、v4.9.2）。
    state.deviceOrientation.beta = smoothOrientation.beta;
    state.deviceOrientation.gamma = smoothOrientation.gamma;

    if (!state.gyroSensorConfirmed && event.beta !== null && event.gamma !== null) {
        state.gyroSensorConfirmed = true;
        if (gyroDetectionTimer) { clearTimeout(gyroDetectionTimer); gyroDetectionTimer = null; }
        // 水準器UI(#gyroLevelContainer)の表示可否を再評価させる
        // （js/ui/controls.jsのcheckDeviceType参照）。
        checkDeviceType();
    }

    // DOM描画（水準器ドットの位置・aligned判定）はrAFで間引く（v4.9.2）。
    // 高頻度イベントでも描画は1フレームにつき最大1回のみ。
    if (!levelRenderScheduled) {
        levelRenderScheduled = true;
        requestAnimationFrame(function () {
            levelRenderScheduled = false;
            updateDigitalLevel();
        });
    }
}

export function updateDigitalLevel() {
    var dot = document.getElementById('gyroLevelDot');
    var container = document.getElementById('gyroLevelContainer');
    if (!dot || !container) return;

    var pitchErr = smoothOrientation.beta - 90;
    var rollErr = smoothOrientation.gamma;

    if (state.isSelfie) rollErr = -rollErr;

    var scaleFactor = 3.5;
    var dx = rollErr * scaleFactor;
    var dy = pitchErr * scaleFactor;

    var dist = Math.hypot(dx, dy);
    var maxDist = 38;
    if (dist > maxDist) {
        dx = (dx / dist) * maxDist;
        dy = (dy / dist) * maxDist;
    }

    dot.style.transform = "translate(calc(-50% + " + dx + "px), calc(-50% + " + dy + "px))";

    // ロール方向（rollErr、gammaベース）が従来±5°と非常にセンシティブで
    // 合わせにくいという要望を受け、許容幅を広げるとともに、境界付近での
    // ちらつき（aligned⇔not alignedの頻繁な切替）を防ぐためヒステリシスを
    // 導入した（v4.9.2）。既にaligned状態のときは少し緩い閾値（外れる判定を
    // 甘くする）、not aligned状態のときは通常の閾値（入る判定）を使う。
    // なお、この判定はstate.isDeviceVerticalを介して自動録画の待機/カウント
    // ダウン開始トリガーにのみ影響し、実際に記録されるcapturedRollDegの
    // 精度自体には影響しない。
    var wasAligned = state.isDeviceVertical;
    var pitchTolerance = wasAligned ? 17 : 15;
    var rollTolerance = wasAligned ? 10 : 8;

    if (Math.abs(pitchErr) <= pitchTolerance && Math.abs(rollErr) <= rollTolerance) {
        container.classList.add('aligned');
        document.getElementById('gyroLevelStatus').innerText = "📐 垂直・水平OK！全身を収めてください";
        state.isDeviceVertical = true;
    } else {
        container.classList.remove('aligned');
        document.getElementById('gyroLevelStatus').innerText = "📐 カメラを垂直・水平に保ってください";
        state.isDeviceVertical = false;
        resetAutoRecCountdown();
    }
}

export function speakGuidance(text) {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        var utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'ja-JP';
        utterance.volume = 1.0;
        utterance.rate = 1.2;
        window.speechSynthesis.speak(utterance);
    }
}

export function triggerAutoRecStandby() {
    if (state.isAutoRecReady || state.isAutoRecActive || state.isRecording) return;
    state.isAutoRecReady = true;

    speakGuidance("レディ");

    var readyMsg = document.getElementById('autoRecReadyMessage');
    if (readyMsg) {
        readyMsg.innerText = "Ready... 静止してください";
        readyMsg.style.display = 'block';
    }

    state.autoRecStandbyTimer = setTimeout(function () {
        if (state.isAutoRecReady) {
            if (readyMsg) readyMsg.style.display = 'none';
            state.isAutoRecReady = false;
            triggerAutoRecCountdown();
        }
    }, 2000);
}

function triggerAutoRecCountdown() {
    state.isAutoRecActive = true;
    state.autoRecCountdownVal = 3;
    var overlay = document.getElementById('autoRecCountdown');
    overlay.innerText = state.autoRecCountdownVal;
    overlay.style.display = 'block';

    document.body.classList.add('recording-active');

    speakGuidance("さん");

    state.autoRecCountdownTimer = setInterval(function () {
        state.autoRecCountdownVal--;
        if (state.autoRecCountdownVal > 0) {
            overlay.innerText = state.autoRecCountdownVal;
            var countWords = { 2: "にい", 1: "いち" };
            if (countWords[state.autoRecCountdownVal]) speakGuidance(countWords[state.autoRecCountdownVal]);
        } else {
            clearInterval(state.autoRecCountdownTimer);
            state.autoRecCountdownTimer = null;
            overlay.style.display = 'none';
            state.isAutoRecActive = false;
            speakGuidance("スタート");
            recBtn.click();
        }
    }, 1000);
}

export function resetAutoRecCountdown() {
    var wasActive = state.isAutoRecReady || state.isAutoRecActive;

    if (state.isAutoRecReady) {
        clearTimeout(state.autoRecStandbyTimer);
        state.autoRecStandbyTimer = null;
        state.isAutoRecReady = false;
        var readyMsg = document.getElementById('autoRecReadyMessage');
        if (readyMsg) readyMsg.style.display = 'none';
    }

    if (state.isAutoRecActive) {
        clearInterval(state.autoRecCountdownTimer);
        state.autoRecCountdownTimer = null;
        state.isAutoRecActive = false;
        var overlay = document.getElementById('autoRecCountdown');
        if (overlay) overlay.style.display = 'none';
        if (!state.isRecording) document.body.classList.remove('recording-active');
    }

    if (wasActive) speakGuidance("リセット");
}
