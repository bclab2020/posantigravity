/**
 * arucoCalibration.js
 * ---------------------------------------------------------------------------
 * 「4隅ArUco」床面キャリブレーション。三脚等でカメラを完全固定した場合に、
 * 実寸が分かっているボード/マットの4隅にそれぞれ1枚ずつArUcoマーカー
 * （ID:0〜3）を貼って撮影すると、
 *   1) 横/縦スケール(px/mm)の平均・カメラのロール角(傾き)・透視比(俯角の
 *      目安)を算出し、state.pxToCmRatioへ反映する（→全モード共通で使われる）。
 *   2) 4隅の画像ピクセル座標→床面実寸mm座標への射影変換(ホモグラフィ)を
 *      算出し、state.floorHomographyへ反映する（→重心動揺(sway)モードの
 *      足首位置を実寸2軸(mm)で測定するために使う）。
 *
 * 手持ち・簡易スタンド撮影など、4隅マーカーを使わない場合は今まで通り
 * 「📏 マット校正(45cm)」の2点タップ校正（js/core/calibration.js）が
 * そのまま使える。両者は独立しており、ArUco校正は「より精度が高く実寸2軸
 * 測定もできる、固定設置専用の追加オプション」という位置づけ
 * （2026-08-03、企画者との相談により決定）。
 *
 * 検出ライブラリは jcmellado/js-aruco（Original ARUCO辞書）を、npm未配布の
 * ためGitHub本家からjsDelivrのGitHub CDN機能経由で動的に読み込む
 * （raw.githackへのフォールバック付き）。マーカー画像自体はアプリ内に
 * 持たず、外部の生成サイト(chev.me/arucogen)へのリンクを案内する。
 *
 * カメラを動かした場合は再校正が必要（自動検知はしない）。校正結果は
 * ブラウザのlocalStorageに保存し、次回アプリ起動時も校正済みの状態が
 * 引き継がれるようにする（毎回のボード実寸入力は必要だが、校正自体は
 * カメラを動かさない限りやり直し不要、というご要望に対応）。
 */

import { state } from './state.js';
import { video } from './dom.js';
import { updateInfoPanel } from './calibration.js';
import { getUprightVideoFrame, getEffectiveFrameSize } from './camera.js';

var LOCAL_STORAGE_KEY = 'athletecore_aruco_floor_calibration_v1';

// ─────────────────────────────────────────────────────────────────────────
// ライブラリ読み込み（js-aruco: cv.js → aruco.js の順で読み込む必要がある。
// dictionary.jsは実在しない・辞書データはaruco.js内蔵、という点に注意）
// ─────────────────────────────────────────────────────────────────────────
var _arucoLibsPromise = null;
var _arucoDetector = null;

function loadScript(src) {
    return new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.crossOrigin = 'anonymous';
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

async function loadScriptWithFallback(urls) {
    var lastErr;
    for (var i = 0; i < urls.length; i++) {
        try { await loadScript(urls[i]); return; } catch (e) { lastErr = e; }
    }
    throw lastErr;
}

export function loadArucoLibs() {
    if (_arucoLibsPromise) return _arucoLibsPromise;
    _arucoLibsPromise = (async function () {
        if (window.AR && window.AR.Detector) return true;
        try {
            await loadScriptWithFallback([
                'https://cdn.jsdelivr.net/gh/jcmellado/js-aruco@master/src/cv.js',
                'https://raw.githack.com/jcmellado/js-aruco/master/src/cv.js'
            ]);
            await loadScriptWithFallback([
                'https://cdn.jsdelivr.net/gh/jcmellado/js-aruco@master/src/aruco.js',
                'https://raw.githack.com/jcmellado/js-aruco/master/src/aruco.js'
            ]);
            return true;
        } catch (e) {
            console.error('[arucoCalibration] Failed to load js-aruco library:', e);
            _arucoLibsPromise = null; // 次回また読み直せるようにする
            return false;
        }
    })();
    return _arucoLibsPromise;
}

// ─────────────────────────────────────────────────────────────────────────
// 幾何計算（DOM非依存の純粋関数群。js/api.jsからも直接importして使う）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 4隅の画像ピクセル座標 [左上,右上,右下,左下] と、ボードの実寸(横mm・縦mm)
 * から、横/縦スケール(px/mm)の平均・カメラのロール角(度)・透視比を求める。
 * 透視比は校正時の品質チェック（カメラの俯角の目安表示）専用。ロール角は
 * 校正画面の警告表示に加えて、2026-08-07以降はstate.arucoCalibratedRollDeg
 * 経由で撮影確定時のroll補正にも使われる（三脚等の固定設置カメラはジャイロ
 * を持たないことが多いため。ジャイロが使える場合は従来通りそちらが担当。
 * js/core/recorder.js参照）。
 */
export function calcCalibDataFromCorners(corners, wMm, hMm) {
    var c = corners; // [TL, TR, BR, BL]
    var topW = Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y);
    var botW = Math.hypot(c[2].x - c[3].x, c[2].y - c[3].y);
    var leftH = Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y);
    var rightH = Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y);

    var pxPerMmW = ((topW + botW) / 2) / wMm;
    var pxPerMmH = ((leftH + rightH) / 2) / hMm;
    var pxPerMm = (pxPerMmW + pxPerMmH) / 2;
    var rollDeg = Math.atan2(c[1].y - c[0].y, c[1].x - c[0].x) * 180 / Math.PI;
    var perspRatio = topW / Math.max(botW, 0.1);

    return { pxPerMm: pxPerMm, pxPerMmW: pxPerMmW, pxPerMmH: pxPerMmH, rollDeg: rollDeg, perspRatio: perspRatio };
}

/**
 * 4隅の画像ピクセル座標 [左上,右上,右下,左下] から、対角線（左上⇔右下、
 * 右上⇔左下）の交点を求める。ボードは実世界では長方形（対角線が中点で
 * 交わる図形）なので、この交点は「ボードの物理的な中心が画像上のどこに
 * 投影されているか」を表す。直線の交点はどんな射影変換（ホモグラフィ）
 * でも保存される性質（直線は直線に、交点は交点に写る）を利用しており、
 * カメラの俯角・距離に関わらず数学的に正確な値になる（近似ではない）。
 * ホモグラフィの逆変換を計算する必要が無く、既に検出済みの4隅の座標だけ
 * から求まるため、計算コストもごくわずか（2026-08-05、研究機関向け
 * 「アルコマーカー正中線」機能のために追加）。
 * @param {Array} corners [TL, TR, BR, BL]の4点（{x,y}）
 * @returns {{x:number,y:number}|null} 交点の画像ピクセル座標。4隅が一直線に
 *   近い等の縮退ケースでは null（通常のArUco検出結果では起こらない想定）。
 */
export function computeQuadCenterFromDiagonals(corners) {
    if (!corners || corners.length !== 4) return null;
    var p1 = corners[0], p2 = corners[2]; // 左上→右下
    var p3 = corners[1], p4 = corners[3]; // 右上→左下
    var denom = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
    if (Math.abs(denom) < 1e-9) return null;
    var a = p1.x * p2.y - p1.y * p2.x;
    var b = p3.x * p4.y - p3.y * p4.x;
    var x = (a * (p3.x - p4.x) - (p1.x - p2.x) * b) / denom;
    var y = (a * (p3.y - p4.y) - (p1.y - p2.y) * b) / denom;
    return { x: x, y: y };
}

/** n=8元連立1次方程式 A・h = b を、部分ピボット選択付きガウス・ジョルダン消去法で解く */
function solveLinearSystem8(A, b) {
    var n = 8;
    var M = A.map(function (row, i) { return row.concat([b[i]]); });
    for (var col = 0; col < n; col++) {
        var piv = col;
        for (var r = col + 1; r < n; r++) {
            if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        }
        if (Math.abs(M[piv][col]) < 1e-10) return null; // 特異行列（4隅が一直線に近い等）
        var tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
        var pivVal = M[col][col];
        for (var c = col; c <= n; c++) M[col][c] /= pivVal;
        for (var rr = 0; rr < n; rr++) {
            if (rr === col) continue;
            var factor = M[rr][col];
            if (factor === 0) continue;
            for (var cc = col; cc <= n; cc++) M[rr][cc] -= factor * M[col][cc];
        }
    }
    return M.map(function (row) { return row[n]; });
}

/**
 * 4組の対応点(src=画像px座標, dst=実寸mm座標)から、平面射影変換
 * (ホモグラフィ、8要素配列)を求める。
 */
export function computeHomography(src, dst) {
    if (!src || !dst || src.length !== 4 || dst.length !== 4) return null;
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
        var x = src[i].x, y = src[i].y, X = dst[i].x, Y = dst[i].y;
        A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
        A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
    }
    return solveLinearSystem8(A, b);
}

/** ホモグラフィhを画像ピクセル座標(x,y)へ適用し、床面実寸mm座標{X,Y}を返す */
export function applyHomography(h, x, y) {
    if (!h) return null;
    var denom = h[6] * x + h[7] * y + 1;
    if (Math.abs(denom) < 1e-9) return null;
    return {
        X: (h[0] * x + h[1] * y + h[2]) / denom,
        Y: (h[3] * x + h[4] * y + h[5]) / denom
    };
}

// ─────────────────────────────────────────────────────────────────────────
// 検出ループ（#videoのライブ映像に対して実行する。DOM依存）
// ─────────────────────────────────────────────────────────────────────────

var ARUCO_QUAD_ID_ROLE = { 0: 0, 1: 1, 2: 2, 3: 3 }; // ArUco ID → corners配列インデックス(TL,TR,BR,BL)
var ARUCO_QUAD_STALE_MS = 2500; // この時間内に検出されたIDのみ有効とみなす（4枚が同時に1フレームに写らなくても良い）

var _quadLoopTimer = null;
var _quadState = null; // { detected: {id: {x,y,t}}, wMm, hMm, onProgress, onComplete, done }

/**
 * srcElからtargetW幅に縮小した検出用canvasを作る。srcElは<video>要素、
 * または（縦置き回転補正時の）回転済みcanvasのどちらも受け取れるよう、
 * サイズは.videoWidth/.videoHeightを直接読むのではなく引数(srcW, srcH)
 * で明示的に渡す形にしている（canvas要素には.videoWidth/.videoHeightが
 * 存在しないため、2026-08-04の縦置き対応で変更）。
 */
function buildDetectCanvas(srcEl, srcW, srcH, targetW) {
    if (!srcW || !srcH) return null;
    var scale = targetW / srcW;
    var cw = Math.max(1, Math.round(srcW * scale));
    var ch = Math.max(1, Math.round(srcH * scale));
    var canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(srcEl, 0, 0, cw, ch);
    return { canvas: canvas, scale: scale };
}

function quadDetectTick() {
    if (!_quadState || _quadState.done) return;
    try {
        detectQuadMarkersOnce();
    } catch (e) {
        console.error('[arucoCalibration] detection tick error:', e);
    }
    if (_quadState && !_quadState.done) {
        _quadLoopTimer = setTimeout(quadDetectTick, 150);
    }
}

function detectQuadMarkersOnce() {
    // readyStateは常に生の<video>要素で確認する（回転補正用canvasには
    // この概念が無いため）。実際に検出に使うフレーム自体は
    // getUprightVideoFrame()（縦置き設置時は回転補正済みcanvas、横置き時は
    // 従来通りvideo要素そのまま）を使うことで、4隅の検出座標が姿勢推定・
    // 表示描画と同じ「直立フレーム」の座標系になり、床面ホモグラフィの
    // 計算がどちらの向きでも正しく成立する（2026-08-04、縦置き対応時に変更）。
    if (!video || video.readyState < 2) return;
    var frameSource = getUprightVideoFrame();
    var effSize = getEffectiveFrameSize();
    var vw = effSize.width || 0;
    if (!vw) return;

    // ボード全体に散らばる小さいマーカーを拾うため、実解像度に近い大きめの
    // スケールから試す（縮小しすぎるとタグが潰れて検出できなくなるため）。
    var scales = [vw, Math.round(vw * 0.75), Math.round(vw * 0.5), 640];
    var now = Date.now();
    var found = false;

    for (var s = 0; s < scales.length; s++) {
        var det = buildDetectCanvas(frameSource, effSize.width, effSize.height, Math.min(scales[s], vw));
        if (!det) continue;
        var markers;
        try {
            markers = _arucoDetector.detect(det.canvas.getContext('2d').getImageData(0, 0, det.canvas.width, det.canvas.height));
        } catch (e) { continue; }
        if (!markers || markers.length === 0) continue;

        for (var m = 0; m < markers.length; m++) {
            var marker = markers[m];
            if (!(marker.id in ARUCO_QUAD_ID_ROLE)) continue; // ID 0-3以外は無視
            var cx = 0, cy = 0;
            for (var k = 0; k < 4; k++) { cx += marker.corners[k].x; cy += marker.corners[k].y; }
            cx = (cx / 4) / det.scale;
            cy = (cy / 4) / det.scale;
            _quadState.detected[marker.id] = { x: cx, y: cy, t: now };
            found = true;
        }
        if (found) break; // この解像度で見つかれば他のスケールは試さない
    }

    var ids = [0, 1, 2, 3];
    var live = ids.filter(function (id) {
        return _quadState.detected[id] && (now - _quadState.detected[id].t) <= ARUCO_QUAD_STALE_MS;
    });

    if (typeof _quadState.onProgress === 'function') _quadState.onProgress(live);

    if (live.length === 4) {
        var corners = ids.map(function (id) { return { x: _quadState.detected[id].x, y: _quadState.detected[id].y }; });
        var calib = calcCalibDataFromCorners(corners, _quadState.wMm, _quadState.hMm);
        var dstMm = [
            { x: 0, y: 0 }, { x: _quadState.wMm, y: 0 },
            { x: _quadState.wMm, y: _quadState.hMm }, { x: 0, y: _quadState.hMm }
        ];
        var homography = computeHomography(corners, dstMm);
        var centerPx = computeQuadCenterFromDiagonals(corners);

        _quadState.done = true;
        if (_quadLoopTimer) { clearTimeout(_quadLoopTimer); _quadLoopTimer = null; }

        if (typeof _quadState.onComplete === 'function') {
            _quadState.onComplete({
                corners: corners,
                pxPerMm: calib.pxPerMm,
                pxPerMmW: calib.pxPerMmW,
                pxPerMmH: calib.pxPerMmH,
                rollDeg: calib.rollDeg,
                perspRatio: calib.perspRatio,
                homography: homography,
                centerPx: centerPx,
                wMm: _quadState.wMm,
                hMm: _quadState.hMm
            });
        }
    }
}

/**
 * 4隅ArUco検出を開始する。#video（core/dom.js）に既にライブ映像が
 * 出ている前提（呼び出し元がstartBtn等でカメラを起動しておく）。
 * @param {number} wMm ボードの横実寸(mm)
 * @param {number} hMm ボードの縦実寸(mm)
 * @param {Function} onProgress (liveIds:number[]) => void  検出済みID(0-3)の配列
 * @param {Function} onComplete (result) => void  4/4検出完了���に1回だけ呼ばれる
 * @param {Function} onError (message:string) => void  ライブラリ読込失敗等
 */
export async function startArucoQuadCalibration(wMm, hMm, onProgress, onComplete, onError) {
    stopArucoQuadCalibration();

    if (!_arucoDetector) {
        var ok = await loadArucoLibs();
        if (!ok) {
            if (typeof onError === 'function') onError('ArUcoライブラリの読み込みに失敗しました（ネット接続をご確認ください）');
            return;
        }
        try {
            _arucoDetector = new window.AR.Detector();
        } catch (e) {
            if (typeof onError === 'function') onError('ArUco検出器の初期化に失敗しました');
            return;
        }
    }

    _quadState = { detected: {}, wMm: wMm, hMm: hMm, onProgress: onProgress, onComplete: onComplete, done: false };
    quadDetectTick();
}

export function stopArucoQuadCalibration() {
    if (_quadLoopTimer) { clearTimeout(_quadLoopTimer); _quadLoopTimer = null; }
    _quadState = null;
}

// ─────────────────────────────────────────────────────────────────────────
// 永続化（localStorage）。カメラを動かさない限り、次回アプリ起動時も
// この校正結果を使い続ける（ボード実寸は校正のたびに毎回入力してもらう
// 運用のため、ここでは結果だけを保存する）。
// ─────────────────────────────────────────────────────────────────────────

/**
 * 校正完了コールバック(onComplete)の結果を受け取り、state.pxToCmRatio /
 * state.floorHomographyへ反映しつつ、localStorageへ保存する。
 */
export function applyAndPersistCalibration(result) {
    // pxToCmRatio は cm/px。result.pxPerMmは px/mm なので、
    // cm/px = 1 / (px/mm * 10mm/cm) = 1 / (pxPerMm * 10)
    var pxToCmRatio = result.pxPerMm > 0 ? (1 / (result.pxPerMm * 10)) : null;

    state.pxToCmRatio = pxToCmRatio;
    state.floorHomography = result.homography;
    // 2026-08-05追加: 「静止姿勢: アルコ正中線モード」用の中心座標
    // （js/core/arucoCalibration.jsのcomputeQuadCenterFromDiagonals参照）。
    state.arucoMidlineX = result.centerPx ? result.centerPx.x : null;
    state.arucoMidlineY = result.centerPx ? result.centerPx.y : null;
    // 2026-08-07追加: このrollDegを撮影確定時のroll補正でジャイロより優先
    // して使う（js/core/recorder.js参照、js/core/state.jsのコメントも参照）。
    state.arucoCalibratedRollDeg = (typeof result.rollDeg === 'number' && isFinite(result.rollDeg)) ? result.rollDeg : null;
    updateInfoPanel();

    var record = {
        pxToCmRatio: pxToCmRatio,
        homography: result.homography,
        centerPx: result.centerPx || null,
        rollDeg: result.rollDeg,
        perspRatio: result.perspRatio,
        wMm: result.wMm,
        hMm: result.hMm,
        calibratedAt: Date.now()
    };
    try {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(record));
    } catch (e) {
        console.warn('[arucoCalibration] Failed to persist calibration to localStorage:', e);
    }
    return record;
}

/** 保存済みの4隅ArUco校正結果を読む（無ければnull）。state反映は行わない。 */
export function loadPersistedCalibration() {
    try {
        var raw = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (!raw) return null;
        var record = JSON.parse(raw);
        if (!record || typeof record.pxToCmRatio !== 'number' || !record.homography) return null;
        return record;
    } catch (e) {
        console.warn('[arucoCalibration] Failed to read persisted calibration:', e);
        return null;
    }
}

/**
 * アプリ起動時に呼ぶ。保存済みの4隅ArUco校正結果があれば、
 * state.pxToCmRatio / state.floorHomographyへ復元する
 * （js/app.jsのboot()から、他の校正関連処理より前に呼ぶこと）。
 */
export function restorePersistedCalibrationToState() {
    var record = loadPersistedCalibration();
    if (!record) return null;
    state.pxToCmRatio = record.pxToCmRatio;
    state.floorHomography = record.homography;
    // 2026-08-05追加: centerPxが無い（この機能を追加する前に保存された）
    // 旧形式の校正データの場合はnullのままとし、「静止姿勢: アルコ正中線
    // モード」は自動的に従来方式（両足基準）へフォールバックする
    // （一度この校正をやり直せばcenterPxが保存され利用可能になる）。
    state.arucoMidlineX = (record.centerPx && typeof record.centerPx.x === 'number') ? record.centerPx.x : null;
    state.arucoMidlineY = (record.centerPx && typeof record.centerPx.y === 'number') ? record.centerPx.y : null;
    // 2026-08-07追加: 旧形式（rollDegを保存する前）の校正データの場合は
    // nullのままとし、撮影確定時は従来通りジャイロへ自動フォールバックする
    // （一度この校正をやり直せばrollDegが保存され利用可能になる）。
    state.arucoCalibratedRollDeg = (typeof record.rollDeg === 'number' && isFinite(record.rollDeg)) ? record.rollDeg : null;
    updateInfoPanel();
    return record;
}

/** 校正をクリアする（設定画面の「校正をクリア」操作用）。 */
export function clearPersistedCalibration() {
    try { localStorage.removeItem(LOCAL_STORAGE_KEY); } catch (e) { /* ignore */ }
    state.floorHomography = null;
    state.arucoMidlineX = null;
    state.arucoMidlineY = null;
    state.arucoCalibratedRollDeg = null;
    // pxToCmRatioは2点タップ校正でも使う共用の値のため、ここでは
    // クリアしない（ユーザーが明示的に「マット校正」をやり直すか、
    // 別途リセット操作をするまでそのまま残す）。
}
