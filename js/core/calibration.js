/**
 * calibration.js
 * ---------------------------------------------------------------------------
 * マット校正（実寸45cm基準のスケール比率算出）、身長ベースの自動スケール推定、
 * 仮想ASIS（上前腸骨棘）ランドマーク生成を担当。
 * 元 app.js の calibrateMatBtn / autoEstimateScaleRatio /
 * generateVirtualASIS / updateInfoPanel をそのまま移植。
 */

import { state, isStaticMode as isStaticModeCheck } from './state.js';
import { calibrateMatBtn, heightInput, footSizeInput, debugScaleRatioDisplay } from './dom.js';

// v4.6.13で撮影画面の「スケール未校正」「骨盤傾斜: 0°」表示を廃止した
// （骨盤傾斜は自動計算されていない値のため不要、スケール係数は一般利用者に
// 見せる必要はなく内部データとして持っていれば十分、との企画判断）。
// ただし検証段階のみ、直近のスケール係数を確認できるよう設定��面に
// 1行だけ残しており、この関数はそこだけを更新する（骨盤傾斜側は更新対象から
// 外した）。
// 2026-08-04: 以前はここを「1px = X.XXXcm」(cm/px)表示にしていたが、4隅ArUco
// 校正結果パネル（js/ui/shootFlow.jsのrenderArucoCalibResult()）は
// 「X.XXX px/mm」表示のため、同じ校正結果を指しているのに単位が違って見え
// 「値が食い違っているのでは」という誤解を招いていた（実際には
// state.pxToCmRatio自体は計算全体で使う内部値としてそのまま維持しつつ、
// 表示のためだけにpx/mmへ逆算する）。企画者のご要望により、こちらも
// px/mmへ表示単位を統一する。内部計算(js/api.js・biomechanics.js等)は
// 引き続きcm/px基準のstate.pxToCmRatioを使い続けるため、この変更は表示
// 文字列のみに閉じており、計算結果には一切影響しない。
export function updateInfoPanel() {
    if (!debugScaleRatioDisplay) return;
    if (state.pxToCmRatio) {
        // cm/px → px/mm の逆算。ArUco校正側(js/core/arucoCalibration.js)の
        // 「pxToCmRatio = 1 / (pxPerMm * 10)」の逆変換で、常に往復一致する。
        var pxPerMm = 1 / (state.pxToCmRatio * 10);
        debugScaleRatioDisplay.innerText = pxPerMm.toFixed(3) + " px/mm";
    } else {
        debugScaleRatioDisplay.innerText = "未校正";
    }
}

/** 身長ベースの自動スケール比率推定（マット校正が未実施の場合のフォールバック） */
export function autoEstimateScaleRatio(kps) {
    if (state.pxToCmRatio) return; // 手動校正済みならスキップ

    // 静止4方向（前面/後面/左右側面）は、撮影(既定5秒)が終わった瞬間に
    // estimateScaleRatioFromRecordingBuffer()が後半区間のフレーム平均で
    // 確定させる専用ロジックを使うため、ここ（ライブプレビュー中の毎フレーム
    // 即時単一フレーム推定）ではスキップする。動作解析（動的種目）・重心動揺は
    // 従来通りこちらのロジックのままとする（2026-07-30、判定をstate.jsへ一本化）。
    if (isStaticModeCheck(state.currentTab)) return;

    var nose = kps.find(function (k) { return k.name === 'nose' || k.name === '0'; });
    var lAnkle = kps.find(function (k) { return k.name === 'left_ankle' || k.name === '27'; });
    var rAnkle = kps.find(function (k) { return k.name === 'right_ankle' || k.name === '28'; });

    if (nose && lAnkle && rAnkle && nose.score > 0.4 && lAnkle.score > 0.4 && rAnkle.score > 0.4) {
        var ankleY = (lAnkle.y + rAnkle.y) / 2;
        var heightPx = ankleY - nose.y;
        if (heightPx > 50) {
            var heightCm = parseFloat(heightInput.value) || 170;
            var estimatedTotalHeightPx = heightPx / 0.86;
            state.pxToCmRatio = heightCm / estimatedTotalHeightPx;
            updateInfoPanel();
        }
    }
}

/**
 * 静止4方向（前面/後面/左右側面）専用: 1ポーズの撮影(既定5秒、durationSelect
 * で変更可)が終わった直後に、その録画バッファ(state.poseDataLog。recBtn押下時に
 * 毎回リセットされるため、このポーズ1回分のフレームだけが入っている)のうち、
 * 時間軸で後半にあたるフレームだけを使ってスケール比率を確定する。
 *
 * 理由: 構え始めた直後（前半）はまだ姿勢が安定せず座標がブレやすいが、後半に
 * なるほど静止姿勢として安定してくると見込まれるため、後半区間の複数フレームを
 * 平均することで、単一フレームの一発推定より安定した値が得られると考えられる
 * （2026-07-27、企画者との相談により決定）。
 *
 * 手動でマット校正済みの場合、またはこのポーズで有効なフレームが1つも
 * 取れなかった場合は何もしない（従来通り未校正のまま。呼び出し元
 * recorder.jsのstopRecordingでは静止4方向の時だけ呼ばれる）。
 */
export function estimateScaleRatioFromRecordingBuffer() {
    if (state.pxToCmRatio) return; // 手動校正済みならスキップ（念のための二重ガード）

    var log = state.poseDataLog;
    if (!log || log.length === 0) return;

    var firstTime = log[0].time;
    var lastTime = log[log.length - 1].time;
    var midTime = firstTime + (lastTime - firstTime) / 2;

    var collectHeights = function (entries) {
        var heights = [];
        entries.forEach(function (entry) {
            var kps = entry.keypoints;
            if (!kps) return;
            var nose = kps.find(function (k) { return k.name === 'nose' || k.name === '0'; });
            var lAnkle = kps.find(function (k) { return k.name === 'left_ankle' || k.name === '27'; });
            var rAnkle = kps.find(function (k) { return k.name === 'right_ankle' || k.name === '28'; });
            if (nose && lAnkle && rAnkle && nose.score > 0.4 && lAnkle.score > 0.4 && rAnkle.score > 0.4) {
                var ankleY = (lAnkle.y + rAnkle.y) / 2;
                var heightPx = ankleY - nose.y;
                if (heightPx > 50) heights.push(heightPx);
            }
        });
        return heights;
    };

    var latterHalfEntries = log.filter(function (entry) { return entry.time >= midTime; });
    var heights = collectHeights(latterHalfEntries);

    // 後半区間で有効なフレームが1つも取れなかった場合の保険として、
    // 撮影全体（前半含む）から取り直す。
    if (heights.length === 0) heights = collectHeights(log);
    if (heights.length === 0) return; // それでも取れなければ従来通り未校正のまま

    var avgHeightPx = heights.reduce(function (a, b) { return a + b; }, 0) / heights.length;
    var heightCm = parseFloat(heightInput.value) || 170;
    var estimatedTotalHeightPx = avgHeightPx / 0.86;
    state.pxToCmRatio = heightCm / estimatedTotalHeightPx;
    updateInfoPanel();
}

/**
 * 骨盤傾斜角（近似値）を、膝→股関節ベクトルと股関節→肩ベクトルの、鉛直線
 * からの角度差から推定する（企画者と相談のうえで決定したロジック、
 * 2026-08-25）。静止4方向のうち左右側面(l_side/r_side)撮影時のみ意味を持つ。
 *
 * 本当の意味での骨盤傾斜角（ASIS-PSIS間の角度）は、骨盤という「板」の回転
 * なので、骨盤上の前後2点が無いと原理的に測れない。BlazePoseの股関節
 * キーポイントは関節の中心点そのもので、骨盤が前後に傾いてもこの点自体は
 * ほとんど動かないため、股関節1点の座標だけでは骨盤の回転を検出できない。
 * そこで、股関節を挟んだ「下（膝→股関節、大腿骨セグメント）」と「上
 * （股関節→肩、体幹セグメント）」が、まっすぐ一直線に対してどれ���け
 * 折れ曲がっているかを鉛直線基準の角度差として測ることで、骨盤傾斜の
 * 近似値（プロキシ）とする。当初は足首→股関節ベクトルを「下」に使う案
 * だったが、膝の伸展具合・体重の乗せ方で余計なブレが入りやすいとの
 * ご指摘（企画者、2026-08-25）を受け、股関節に直接つながる大腿骨
 * セグメント（膝→股関節）に変更した。
 *
 * 左右側面はそれぞれ独立したセッションとして保存されるため、l_side/r_side
 * それぞれ自分自身のキーポイントから自分自身の値を計算する（平均等の合成は
 * 行わない。左右で骨盤傾斜が異なる可能性を尊重するため、企画者との相談で
 * この方針に決定、2026-08-25）。
 *
 * @param {Array} kps - 生ピクセル座標のキーポイント配列（BlazePose 33点）
 * @param {string} mode - state.currentTab。'l_side'/'r_side'以外は常に0
 *   （中立）を返す（前面・後面・動作解析等でstate.estimatedPelvicTiltへ
 *   側面撮影時の値が残ったままにならないようにするため）。
 * @returns {number|null} 推定骨盤傾斜角（度）。プラス＝前傾寄り、
 *   マイナス＝後傾寄り（generateVirtualASISの符号規約に合わせてある。
 *   下記参照）。l_side/r_sideで、関連キーポイントの信頼度が不足している
 *   場合のみnullを返す（呼び出し側はnullの場合、前フレームの値を維持する
 *   運用を想定）。
 *
 * ロール（カメラの傾き）補正について: 当初は撮影時のroll角度ぶん3点を
 * 事前回転させる処理を入れていたが、テストで検証したところ本来不要と
 * 判明したため削除した。この関数は膝→股関節・股関節→肩という「同じ3点」を
 * 使った2つの角度の"差"を返す設計のため、画面全体が任意の角度だけ回転
 * （＝カメラが傾いている）していても、2つの角度の両方に全く同じ回転量が
 * 加わるだけで、その差は数学的に変化しない（回転はベクトルの差に対して
 * 線形に作用するため）。そのためロール補正を入れても入れなくても結果は
 * 一致し、素通しのままで正しい。
 *
 * 符号の向きについて: この関数の出力は理屈上「プラス＝前傾寄り」となる
 * よう設計したが（generateVirtualASISの`angleRad = (45 - estimatedPelvicTilt)`
 * ＝プラスの値が仮想ASIS点をより前方へ投影する、という既存の符号規約に
 * 合わせた）、机上の推論であり実機で意図的に前傾・後傾させたポーズでの
 * 検証はまだ行っていない。もし逆向きに見える場合は、この関数の戻り値に
 * -1を掛けるだけで直せる（呼び出し側のロジックには影響しない）。
 */
export function estimatePelvicTiltFromKeypoints(kps, mode) {
    if (!kps) return null;
    if (mode !== 'l_side' && mode !== 'r_side') return 0;

    var isLeft = (mode === 'l_side');
    var MIN_SCORE = 0.3;

    function findKp(name, numName) {
        return kps.find(function (k) { return k && (k.name === name || k.name === numName); });
    }

    var hip = isLeft ? findKp('left_hip', '23') : findKp('right_hip', '24');
    var knee = isLeft ? findKp('left_knee', '25') : findKp('right_knee', '26');
    var shoulder = isLeft ? findKp('left_shoulder', '11') : findKp('right_shoulder', '12');

    if (!hip || !knee || !shoulder) return null;
    if ((hip.score || 0) < MIN_SCORE || (knee.score || 0) < MIN_SCORE || (shoulder.score || 0) < MIN_SCORE) return null;

    // 鉛直線（真上方向）からの角度（度）。dxが右向きプラス、dyが下向きプラスの
    // canvas座標系で、「fromから見てtoが真上にある」時を0度とする。
    function angleFromVertical(from, to) {
        return Math.atan2(to.x - from.x, from.y - to.y) * 180 / Math.PI;
    }

    var thetaLower = angleFromVertical(knee, hip);      // 大腿骨セグメント
    var thetaUpper = angleFromVertical(hip, shoulder);  // 体幹セグメント

    // l_side/r_sideはカメラが左右逆から撮るため、「前方向」をそろえるための
    // 符号反転。generateVirtualASISと同じ規約（r_side→前方向=+x、
    // l_side→前方向=−x）に合わせてある。
    var dir = (mode === 'r_side') ? 1 : -1;

    return (thetaLower - thetaUpper) * dir;
}

/**
 * 静止4方向専用: 1ポーズの撮影が終わった直後に、その録画バッファ
 * （state.poseDataLog）のうち後半区間のフレームだけを使って骨盤傾斜角
 * （近似値）を確定する。estimateScaleRatioFromRecordingBuffer()と全く同じ
 * 考え方（前半は構え動作でブレやすいため、後半区間の複数フレームを平均
 * することでより安定した値にする）。l_side/r_side以外（front/back）は
 * estimatePelvicTiltFromKeypoints()が常に0を返すため、呼んでも実質
 * state.estimatedPelvicTiltが0に揃うだけになる。
 *
 * ライブ描画中（js/core/camera.jsのrender()ループ）は毎フレーム
 * state.estimatedPelvicTiltを更新しているが、単一フレームだと構え動作中の
 * ブレの影響を受けやすいため、撮影確定のこのタイミングで後半区間の平均へ
 * 上書きし直す（js/core/recorder.jsのstopRecordingから呼ばれる）。
 */
export function estimatePelvicTiltFromRecordingBuffer() {
    var log = state.poseDataLog;
    if (!log || log.length === 0) return;

    var mode = state.currentTab;
    if (mode !== 'l_side' && mode !== 'r_side') { state.estimatedPelvicTilt = 0; return; }

    var firstTime = log[0].time;
    var lastTime = log[log.length - 1].time;
    var midTime = firstTime + (lastTime - firstTime) / 2;

    var collectTilts = function (entries) {
        var tilts = [];
        entries.forEach(function (entry) {
            var t = estimatePelvicTiltFromKeypoints(entry.keypoints, mode);
            if (t !== null) tilts.push(t);
        });
        return tilts;
    };

    var latterHalfEntries = log.filter(function (entry) { return entry.time >= midTime; });
    var tilts = collectTilts(latterHalfEntries);

    // 後半区間で有効なフレームが1つも取れなかった場合の保険として、
    // 撮影全体（前半含む）から取り直す（estimateScaleRatioFromRecordingBuffer
    // と同じフォールバック方針）。
    if (tilts.length === 0) tilts = collectTilts(log);
    if (tilts.length === 0) return; // それでも取れなければライブ推定の最終値をそのまま残す

    state.estimatedPelvicTilt = tilts.reduce(function (a, b) { return a + b; }, 0) / tilts.length;
}

/** 骨盤の仮想ASISランドマークを生成する（drawKendallAlignment等で使用） */
export function generateVirtualASIS(kps) {
    if (!kps) return kps;
    var height = parseFloat(heightInput.value) || 170;
    var distanceCm = height * 0.085;
    var ratio = state.pxToCmRatio || 0.15;
    var distancePx = distanceCm / ratio;

    var angleRad = (45 - state.estimatedPelvicTilt) * (Math.PI / 180);
    var upwardOffsetPx = distancePx * Math.sin(angleRad);
    var forwardOffsetPx = distancePx * Math.cos(angleRad);

    var lHip = kps.find(function (k) { return k.name === 'left_hip' || k.name === '23'; });
    var rHip = kps.find(function (k) { return k.name === 'right_hip' || k.name === '24'; });

    if (lHip && rHip && lHip.score > 0.5 && rHip.score > 0.5) {
        var asisL = { x: lHip.x, y: lHip.y - upwardOffsetPx, score: 1.0, name: 'virtual_asis_l' };
        var asisR = { x: rHip.x, y: rHip.y - upwardOffsetPx, score: 1.0, name: 'virtual_asis_r' };

        if (state.currentTab === 'r_side') {
            asisL.x += forwardOffsetPx;
            asisR.x += forwardOffsetPx;
        } else if (state.currentTab === 'l_side') {
            asisL.x -= forwardOffsetPx;
            asisR.x -= forwardOffsetPx;
        }

        var newKps = JSON.parse(JSON.stringify(kps));
        newKps.push(asisL);
        newKps.push(asisR);
        return newKps;
    }
    return kps;
}

export function initCalibrationUI(onCalibrationChange, onMatCalibrationDone) {
    calibrateMatBtn.onclick = function () {
        if (state.calibState === "idle") {
            state.calibState = "wait_left";
            state.calibrationPoints = [];
            calibrateMatBtn.classList.add('active');
            calibrateMatBtn.innerText = "📍 マット左端をタップ";
        } else if (state.calibState === "adjust_left") {
            state.calibState = "wait_right";
            document.getElementById('dpadPanel').style.display = 'none';
            calibrateMatBtn.innerText = "📍 マット右端をタップ";
        } else if (state.calibState === "adjust_right") {
            var distPx = Math.hypot(state.calibrationPoints[1].x - state.calibrationPoints[0].x, state.calibrationPoints[1].y - state.calibrationPoints[0].y);
            if (distPx > 10) {
                state.pxToCmRatio = 45.0 / distPx;
            }
            state.calibState = "idle";
            calibrateMatBtn.classList.remove('active');
            document.getElementById('dpadPanel').style.display = 'none';
            calibrateMatBtn.innerText = "✅ 校正完了";
            updateInfoPanel();
            setTimeout(function () {
                if (state.calibState === "idle") calibrateMatBtn.innerText = "📏 マット校正(45cm)";
            }, 2000);
            if (distPx > 10 && typeof onMatCalibrationDone === 'function') onMatCalibrationDone(state.pxToCmRatio);
        } else {
            state.calibState = "idle";
            state.calibrationPoints = [];
            calibrateMatBtn.classList.remove('active');
            document.getElementById('dpadPanel').style.display = 'none';
            calibrateMatBtn.innerText = "📏 マット校正(45cm)";
        }
    };

}
