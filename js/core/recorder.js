/**
 * recorder.js
 * ---------------------------------------------------------------------------
 * 録画開始/停止、MediaRecorderによるWebM書き出し、測定終了後のセッション
 * データ組み立て・保存（dataService経由）を担当。
 * 元 app.js の recBtn.onclick / stopRecording / startVideoExport を移植。
 */

import { state, reportDataStore, isStaticMode as isStaticModeCheck } from '../core/state.js';
import { canvasComb, recBtn, timerDisplay, startBtn, ctxMP, canvasMP, patientNameInput, heightInput, footSizeInput, durationSelect, selfTimerSelect, selfTimerCountdown } from '../core/dom.js';
import { updateModeUI, captureSkeletonImage } from '../ui/controls.js';
import { speakGuidance } from './orientation.js';
import { estimateScaleRatioFromRecordingBuffer, estimatePelvicTiltFromRecordingBuffer } from './calibration.js';
// 2026-08-25追加: state.staticBackgroundData（撮影確認画面の背景として使う
// スナップショット）も、js/ui/controls.jsのcaptureSkeletonImageと同じ理由で
// 「骨格線等の重ね書き無し」のクリーンな1枚にする必要があるため、
// captureCleanVideoFrame()を直接importして使う。camera.js側はcontrols.jsを
// importしているが、camera.js→recorder.jsのimportは存在しないため、
// recorder.js→camera.jsの直接importは循環importにならない
// （js/ui/controls.jsがcamera.jsを直接importできないのとは逆に、こちらは
// window.__xxxブリッジを介さず素直にimportできる）。
import { captureCleanVideoFrame } from './camera.js';

export function initRecorder(dataService, onSaved) {
    recBtn.onclick = function (e) {
        if (state.isRecording) return;

        // セルフタイマー（検証用・一時的機能。2026-08-24追加、後日削除予定）:
        // 一人で検証する際に「撮影」を押してから構える時間を確保できるよう、
        // 選択された秒数（3/5/10秒）だけカウントダウンしてから実際の録画を
        // 開始する。「タイマーなし」の場合は今まで通り即座に開始する。
        //
        // 2026-08-24追記（不具合修正）: 本アプリには元々、モバイルのセルフィー
        // （自撮り）モードで被写体が縦向き・画角内に収まって静止したことを
        // 検知すると、「レディ（2秒）→3・2・1・スタート」と自動で音声案内
        // カウントダウンしたうえで自動的に撮影を開始する仕組み
        // （js/core/orientation.jsのtriggerAutoRecStandby/
        // triggerAutoRecCountdown、この`recBtn.click()`呼び出しがそれ）が
        // 既にあり、まさに「一人で構えてから撮る」ケースをカバーしていた。
        // このセルフタイマー実装時、そちらの自動カウントダウン完了時の
        // `recBtn.click()`もここを素通りしてしまい、「スタート」の音声案内の
        // 後にさらにセルフタイマーの3〜10秒待たされる」という二重の待ち時間
        // が発生し、被験者が「スタート」を聞いて動き出してしまう・機材が
        // 反応していないように見えて操作をやり直してしまう、といった混乱の
        // 原因になっていた（企画者からの「4面撮影後、履歴がバラバラのまま」
        // というご報告の実機再現調査で判明）。スクリプトから`.click()`で
        // 呼び出されたクリックは`event.isTrusted`が常にfalseになる
        // （実際の指/マウスによるクリックのみtrue）という標準のブラウザ挙動を
        // 利用し、自動撮影側からの呼び出しの場合���セルフタイマーを介さず
        // 即座に撮影を開始するようにする（自動撮影側は既に自前の「構える
        // 時間」を持っているため、二重に待たせる必要が無い）。
        if (e && e.isTrusted === false) {
            startActualRecording();
            return;
        }

        var selfTimerSec = selfTimerSelect ? parseInt(selfTimerSelect.value) || 0 : 0;
        if (selfTimerSec > 0) {
            recBtn.disabled = true;
            var remaining = selfTimerSec;
            if (selfTimerCountdown) {
                selfTimerCountdown.style.display = 'block';
                selfTimerCountdown.innerText = String(remaining);
            }
            speakGuidance(remaining + "秒後に撮影を開始します");
            var countdownInterval = setInterval(function () {
                remaining -= 1;
                if (remaining <= 0) {
                    clearInterval(countdownInterval);
                    if (selfTimerCountdown) selfTimerCountdown.style.display = 'none';
                    startActualRecording();
                } else {
                    if (selfTimerCountdown) selfTimerCountdown.innerText = String(remaining);
                }
            }, 1000);
            return;
        }

        startActualRecording();
    };

    function startActualRecording() {
        state.isRecording = true;
        document.body.classList.add('recording-active');
        state.coordinateBufferMP = [];
        state.poseDataLog = [];
        state.swayHistoryMP = [];
        // 履歴からの1ポーズ確認中に誤ってここに来ることはない想定だが、
        // 念のため新規のライブ撮影開始時は必ずfalseへ戻しておく。
        state.isHistoryPlaybackSession = false;

        // 新しい4面撮影（＝これから前面を撮る）の先頭では、前回の
        // バッチ（撮り直し用ID紐付け）を必ずリセットする。ここをリセット
        // し忘れると、前の被測定者の前面レコードを次の被測定者の前面撮影が
        // 上書きしてしまう事故につながるため、撮り直し中でない・かつ
        // 前面モードでの撮影開始時に必ず通す。
        if (state.currentTab === 'front' && !state.isRetakingBatchPose) {
            state.currentBatchSessionIds = { front: null, l_side: null, back: null, r_side: null };
            // この4面ぶんの共通の目印を新規発行する。履歴一覧でこのIDを
            // キーに4面をまとめて1件として表示するために使う。
            state.currentBatchId = "batch_" + Date.now();
        }

        recBtn.disabled = true;
        recBtn.innerText = "測定中";
        timerDisplay.style.display = 'block';

        var canvasStream = canvasComb.captureStream(25);
        state.exportChunks = [];
        try {
            state.exportRecorder = new MediaRecorder(canvasStream, { mimeType: 'video/webm;codecs=vp9' });
        } catch (e) {
            try { state.exportRecorder = new MediaRecorder(canvasStream, { mimeType: 'video/webm' }); }
            catch (err) { state.exportRecorder = null; }
        }

        if (state.exportRecorder) {
            state.exportRecorder.ondataavailable = function (e) { if (e.data.size > 0) state.exportChunks.push(e.data); };
            state.exportRecorder.start();
        }

        var duration = parseInt(durationSelect.value) || 10000;
        var start = Date.now();

        var interval = setInterval(function () {
            var elapsed = Date.now() - start;
            var remaining = Math.max(0, (duration - elapsed) / 1000);
            timerDisplay.innerText = "REC " + remaining.toFixed(1) + "s";

            if (elapsed >= duration) {
                clearInterval(interval);
                stopRecording(dataService, onSaved);
            }
        }, 100);
    }
}

async function stopRecording(dataService, onSaved) {
    state.isRecording = false;
    recBtn.innerText = "撮影";
    recBtn.disabled = false;
    recBtn.style.display = 'none';
    startBtn.style.display = 'none';
    timerDisplay.style.display = 'none';

    document.body.classList.remove('recording-active');
    var gyroContainer = document.getElementById('gyroLevelContainer');
    if (gyroContainer) gyroContainer.style.display = 'none';

    if (state.exportRecorder && state.exportRecorder.state !== 'inactive') state.exportRecorder.stop();

    // 2026-08-25変更: 従来はctxMP.getImageData()でcanvasMPの内容（骨格線等の
    // 重ね書き込み済み）をそのままsnapshotしていたため、この直後に呼ばれる
    // js/ui/controls.jsのrefreshReportView()が、その上からさらに現在の
    // 骨格点をリアルタイム描画すると「線が二重に重なる」不具合になっていた。
    // captureCleanVideoFrame()（js/core/camera.js）で「映像フレームそのもの」
    // だけのcanvasを作り直し、そこからgetImageData()する（下のcaptureSkeleton
    // Image()がcapturedImageに使うクリーンな写真と、生成方法・解像度とも
    // 完全に同じにする）。
    var cleanFrameCanvas = captureCleanVideoFrame();
    if (cleanFrameCanvas) {
        state.staticBackgroundData = cleanFrameCanvas.getContext('2d').getImageData(0, 0, cleanFrameCanvas.width, cleanFrameCanvas.height);
    } else {
        // カメラ未起動時など、万一クリーンフレームが取得できない場合のみ、
        // 従来通りcanvasMPの内容へフォールバックする。
        state.staticBackgroundData = ctxMP.getImageData(0, 0, canvasMP.width, canvasMP.height);
    }
    state.isPausedForEdit = true;
    state.appMode = 'playback';

    // 新しく再生・確認画面に入るタイミングなので、前のポーズ確認時に
    // 変更していたかもしれない再生スピード・写真背景表示は毎回1倍/OFFに
    // 戻しておく（history.jsのloadSessionでも同様にリセットする）。
    state.playbackSpeed = 1;
    state.showPhotoBackground = false;
    var speedSelectEl = document.getElementById('playbackSpeedSelect');
    if (speedSelectEl) speedSelectEl.value = '1';

    updateModeUI(state.currentTab);

    captureSkeletonImage(state.currentTab);

    // 重心動揺（sway）は撮影・���録の仕組みとしては動作解析と同じ扱い
    // （バッチ確認フロー無し・スケール推定/roll補正の対象外）にする
    // （2026-07-30、重心動揺モード追加時にisStaticMode判定をstate.jsへ一本化）。
    var isStaticMode = isStaticModeCheck(state.currentTab);

    // 静止4方向は、撮影終了の今このタイミングで、後半区間のフレーム平均を
    // 使ってスケール比率を確定する（前半は構え動作でブレやすいため）。
    // マット校正済みの場合はestimateScaleRatioFromRecordingBuffer内で
    // スキップされる。この後のsessionData組み立てでstate.pxToCmRatioを
    // 保存するため、必ずそれより前に呼ぶ。
    if (isStaticMode) {
        estimateScaleRatioFromRecordingBuffer();
        // 2026-08-25追加: 骨盤傾斜角（近似値）も、スケール比率と全く同じ
        // 「後半区間フレームの平均」方式で確定する（js/core/calibration.jsの
        // estimatePelvicTiltFromRecordingBuffer参照）。ライブ描画中の毎フレーム
        // 推定（単一フレームで構え動作中のブレを受けやすい）を、より安定した
        // 値へ上書きし直す。front/backではこの中で0に揃えられる。
        estimatePelvicTiltFromRecordingBuffer();
    }

    // 静止4方向は、同じポーズを撮り直した時に新規レコードを増やさず
    // 上書きできるよう、この一連の4面撮影で既に発行済みのIDがあれば再利用する
    // (state.currentBatchSessionIds、4面確認・修正画面からの撮り直しで使う)。
    // 動作解析（動的種目）はバッチ確認フローを持たないため常に新規ID。
    var existingBatchId = isStaticMode ? state.currentBatchSessionIds[state.currentTab] : null;
    state.activeSessionId = existingBatchId || ("sess_" + Date.now());
    state.activePatientName = patientNameInput.value.trim() || "ゲスト";

    if (isStaticMode) {
        state.currentBatchSessionIds[state.currentTab] = state.activeSessionId;
    }

    var sessionImages = {};
    ['front', 'back', 'l_side', 'r_side'].forEach(function (mode) {
        if (reportDataStore[mode] && reportDataStore[mode].capturedImage) sessionImages[mode] = reportDataStore[mode].capturedImage;
    });
    // 動作解析（動的種目）は上の4方向に含まれないため、このセッション自身の
    // モードぶんの画像も別途拾っておく。撮影確認画面(js/ui/dynConfirm.js)の
    // サムネイル表示に使う（2026-07-29のご要望対応、v4.6.23）。
    if (!isStaticMode && reportDataStore[state.currentTab] && reportDataStore[state.currentTab].capturedImage) {
        sessionImages[state.currentTab] = reportDataStore[state.currentTab].capturedImage;
    }

    // ジャイロが実際に確認できている端末では、静止4方向の撮影確定の瞬間の
    // roll角度（画面の左右方向の傾き＝正中線のズレ）と、その時点のcanvas
    // サイズを記録しておく。これにより、後で報告書側の指標計算
    // （js/api.jsのextractMetrics、荷重左右比率）が「実際に構えていた角度」
    // を再現し、逆回転で補正できるようになる（静止4方向のみ対象。動作解析
    // 種目は対象外。ジャイロ未検出の端末では補正しようがないためnullのまま
    // ＝従来通り無補正）（v4.6.20、2026-07-29の正中線精度指摘への対応）。
    // 2026-08-07追加: 「4隅ArUco」床面キャリブレーション済み（三脚等の固定
    // 設置）の場合は、そちらのrollDeg（マーカー4隅の並びから直接算出した
    // カメラ自体の傾き）をジャイロより優先する。固定設置カメラ（OBSBOT等の
    // 外付けカメラ）はスマホ/タブレットのようなジャイロを持たないことが
    // 多く、従来はそのケースで常にroll補正がかからずじまいだった
    // （企画者要望、2026-08-07）。ジャイロと違い撮影のたびに測り���す値では
    // なく、キャリブレーション時点の一度きりの値を「カメラを動かしていない
    // 前提」で使い続ける点はpxToCmRatio/floorHomographyと同じ設計。
    var capturedRollDeg = null;
    if (isStaticMode) {
        if (typeof state.arucoCalibratedRollDeg === 'number') {
            capturedRollDeg = state.arucoCalibratedRollDeg;
        } else if (state.gyroSensorConfirmed) {
            capturedRollDeg = state.deviceOrientation.gamma;
        }
    }

    // 2026-08-25追加: history.js/batchReview.js/specialist.js/dynConfirm.jsの
    // loadSession等は、既存セッションを読み込むたびにstate.activeSession
    // CapturedRollDeg/CanvasWidth/CanvasHeightへ撮影時点の値を退避しているが、
    // 撮影直後（まだ一度もloadSession()を経由していない「撮影確定→そのまま
    // 確認画面を再生」の一番最初のルート）ではこの3つが空のままだった。
    // js/ui/controls.jsのrenderPlaybackFrame()がCOPレーダー用のcopCtxを
    // このstate.activeSession*から組み立てる（js/biomechanics.jsの
    // computeCopOffsetMm、レポート側=js/api.jsのextractMetrics()と同じ計算
    // に統一、2026-08-25「同じ軌跡を共有したい」指摘への対応）ため、ここでも
    // 撮影確定の瞬間の値を同じフィールドへ書いておく。
    state.activeSessionCapturedRollDeg = capturedRollDeg;
    state.activeSessionCanvasWidth = canvasMP.width;
    state.activeSessionCanvasHeight = canvasMP.height;

    var sessionData = {
        id: state.activeSessionId,
        timestamp: Date.now(),
        patientName: state.activePatientName,
        mode: state.currentTab,
        height: parseFloat(heightInput.value) || 170,
        footSize: parseFloat(footSizeInput.value) || 25,
        pelvicTilt: state.estimatedPelvicTilt,
        pxToCmRatio: state.pxToCmRatio,
        // 2026-08-03追加: 「4隅ArUco」床面キャリブレーション済みの場合の
        // 射影変換(ホモグラフィ)。pxToCmRatioと同じく撮影時点の値をそのまま
        // 保存する（js/core/arucoCalibration.js参照）。重心動揺(sway)モード
        // でのみ実際に使われるが、他モードでも保存自体は共通で行っておく
        // （pxToCmRatio/capturedRollDeg等と同じ「値を持たせておく箇所を
        // 一本化する」考え方、canvasWidth/Height参照）。
        floorHomography: state.floorHomography,
        capturedRollDeg: capturedRollDeg,
        // 2026-08-05追加: 研究機関向け「静止姿勢: アルコ正中線モード」
        // （state.useArucoMidline）が撮影確定の瞬間に有効だった場合の、
        // アルコマーカー中心の画像ピクセル座標をそのまま記録する
        // （pxToCmRatio/floorHomography/capturedRollDegと同じ「撮影時点の
        // 値をそのまま保存する」考え方）。静止4方向以外（動作解析・
        // 重心動揺）は対象外のため常にnull。トグルがOFF、またはArUco
        // 未校正だった場合もnull（この場合は従来通り両足基準で計算・保存
        // される）。js/api.jsのextractMetrics()が、この値を使って荷重
        // 左右比率の基準点を差し替える。
        capturedArucoMidlineX: (isStaticMode && state.useArucoMidline && typeof state.arucoMidlineX === 'number') ? state.arucoMidlineX : null,
        capturedArucoMidlineY: (isStaticMode && state.useArucoMidline && typeof state.arucoMidlineY === 'number') ? state.arucoMidlineY : null,
        // 撮影時点のcanvasMPの実解像度（カメラの実測解像度そのまま）を
        // 全モード共通で保存する。以前は静止4方向のみ保存しており（roll補正の
        // 計算=js/api.jsでのみ使っていたため）、動作解析では保存していなかった。
        // このため履歴/確認画面から動作解析を再生し直すと、再生時点で
        // canvasMPがたまたま持っていた解像度（カメラが起動していなければ
        // 既定値のまま等、撮影時とは別の値になりうる）のまま骨格点の生ピクセル
        // 座標をそのまま描画してしまい、実際に写っていた画角の一部だけが
        // 拡大されたように見える不具合があった（2026-07-30のご指摘）。
        // history.js側のloadSession()で、再生開始前にこの値へcanvasMPを
        // 合わせ直すことで、撮影時と同じ画角で再生できるようにする。
        canvasWidth: canvasMP.width,
        canvasHeight: canvasMP.height,
        expertComment: state.activeExpertComment,
        expertExercises: state.activeExpertExercises,
        poseData: JSON.parse(JSON.stringify(state.poseDataLog)),
        images: sessionImages,
        // 2026-08-25追加: images内の写真が「クリーンな写真（骨格線等の重ね
        // 書き無し、骨格はposeDataから毎回リアルタイムに重ね描き）」形式で
        // あることを示す目印。この目印が無い（=未設定/undefined）セッションは
        // v4.9.14以前に撮影された旧形式（骨格線等が写真に焼き込み済み）と
        // 判断し、js/ui/dashboard.js・js/ui/batchReview.js・js/ui/dynConfirm.js
        // 側でオーバーレイを二重に重ね描きしないよう、写真をそのまま（旧来
        // 通りの回転のみ）表示するフォールバック分岐に使う。
        photoFormat: 'clean_v1',
        // この4面ぶんの共通の目印（履歴一覧で4面まとめ表示するためのキー）。
        // 動作解析（動的種目）はこの概念を持たないためnull。
        batchId: isStaticMode ? state.currentBatchId : null,
        // 静止4方向・動作解析（動的種目）とも、撮影終了直後は必ずdraft
        // （下書き）扱いとし、履歴一覧には確定済みとして出さない。静止4方向は
        // 4面確認・修正画面の「✅ この内容で確定」で、動作解析は撮影結果画面の
        // 「✅ 撮影確定」（js/ui/shootFlow.js）で、それぞれ明示的にfinalへ
        // 切り替える。dataService.getAllSessions()・履歴一覧
        // （js/ui/history.js）は元々status別の汎用フィルタのため、動作解析を
        // draft対象に含めてもこれらの処理に変更は不要（2026-07-29のご要望：
        // 動作解析も静止姿勢と同じ「確認してから確定する」流れにしたい、
        // への対応。v4.6.22）。
        status: 'draft'
    };

    try {
        await dataService.saveSession(sessionData);
        console.log("Session saved successfully.");
        if (typeof onSaved === 'function') onSaved();
    } catch (e) {
        console.error("Save session failed:", e);
    }

    if (state.isRetakingBatchPose) {
        speakGuidance("撮り直しが完了しました。決定して確認画面へ戻ってください");
    } else {
        var nextLabelsAudio = {
            'front': "前面の撮影が完了しました。決定して左側面へ進んでください",
            'l_side': "左側面の撮影が完了しました。決定して後面へ進んでください",
            'back': "後面の撮影が完了しました。決定して右側面へ進んでください",
            'r_side': "すべての姿勢撮影が完了しました。決定して確認画面を表示してください"
        };
        if (nextLabelsAudio[state.currentTab]) speakGuidance(nextLabelsAudio[state.currentTab]);
    }

    // 動作解析（動的種目）を撮り直し・履歴経由でもなく「今まさに録画し終えた
    // ばかり」の場合は、静止4方向と同じ再生・微調整・CSV/動画/レポートの
    // ツール群(playbackControls)をこの場では出さない。撮影完了直後は
    // shootFlow.jsの小さな結果バナー(🔁再測定/✅決定して確認画面へ)→
    // dynConfirm.jsの専用確認画面、という流れに一本化したため（2026-07-29の
    // ご要望「撮影が終わるまでは再生とかいろんなツールは出��必要ない」への
    // 対応）。以前はここが常にplaybackControls='flex'固定だったため、結果
    // バナーの裏で再生/微調整/CSV/動画/レポートのボタン一式が出たままになる
    // 不具合があった。
    var isFreshDynamicResult = !isStaticMode && !state.isHistoryPlaybackSession && !state.isRetakingBatchPose;
    if (isFreshDynamicResult) {
        document.getElementById('mainControls').style.display = '';
        document.getElementById('playbackControls').style.display = 'none';
    } else {
        document.getElementById('mainControls').style.display = 'none';
        document.getElementById('playbackControls').style.display = 'flex';
    }
    document.getElementById('downloadCsvBtn').disabled = false;

    state.playbackDataMP = state.poseDataLog;
    var maxFrames = state.playbackDataMP.length - 1;
    document.getElementById('timelineSlider').max = maxFrames > 0 ? maxFrames : 0;
    document.getElementById('timelineSlider').value = maxFrames > 0 ? maxFrames : 0;
    document.getElementById('frameCounter').innerText = maxFrames + " / " + maxFrames;
}

export function startVideoExport() {
    if (state.exportChunks.length === 0) {
        alert("動画データがありません。");
        return;
    }
    var blob = new Blob(state.exportChunks, { type: 'video/webm' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = "athletecore_video_" + (patientNameInput.value.trim() || 'guest') + "_" + state.currentTab + "_" + Date.now() + ".webm";
    a.click();
}

// 撮影直後の確認画面にある「CSV」ボタン用。以前はボタンのdisabled切替のみ
// 実装されており、クリック時の処理が結線されていなかった（履歴画面の
// window.exportSessionCsvのみ動作する状態だった）ため、同じCSVフォーマットで
// 現在アクティブな計測(state.playbackDataMP)を書き出す処理を追加する。
export function startCsvExport() {
    if (!state.playbackDataMP || state.playbackDataMP.length === 0) {
        alert("CSVに書き出せる計測データがありません。");
        return;
    }
    var c = "Timestamp,Mode,PointID,PointName,X,Y\n";
    state.playbackDataMP.forEach(function (d) {
        d.keypoints.forEach(function (kp, idx) {
            if (kp) c += d.time + "," + d.mode + "," + idx + "," + (kp.name || idx) + "," + kp.x.toFixed(1) + "," + kp.y.toFixed(1) + "\n";
        });
    });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([c], { type: 'text/csv' }));
    a.download = "athletecore_data_" + (patientNameInput.value.trim() || 'guest') + "_" + state.currentTab + "_" + Date.now() + ".csv";
    a.click();
}
window.startVideoExport = startVideoExport;
window.startCsvExport = startCsvExport;
