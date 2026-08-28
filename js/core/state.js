/**
 * state.js
 * ---------------------------------------------------------------------------
 * 旧 app.js に散らばっていたグローバル変数を、1つの共有ステートオブジェクトに
 * まとめたもの。各モジュールはこれを import して読み書きする。
 * (モジュール分割にあたり「グローバル変数だらけ」を解消しつつ、
 *  元のロジックとの対応関係が追いやすいよう、変数名は極力踏襲している)
 */

export var state = {
    detectors: [],
    isRunning: false,
    isRecording: false,
    isPausedForEdit: false,
    currentTab: "front",
    currentStream: null,
    appMode: "camera", // 'camera' or 'playback'
    isPlaying: false,

    // isGyroEnabled: OS/ブラウザの傾きセンサー利用許可が下りた（またはそもそも
    // 許可を必要としない）かどうか。ただし許可が下りただけでは、その端末に
    // 実際にジャイロセンサーが搭載されているとは限らない（許可を求める処理
    // 自体は実行できてしまうため）。
    isGyroEnabled: false,
    // gyroSensorConfirmed: 実際に'deviceorientation'イベントから有効な
    // （nullでない）beta/gamma値を1回でも受信できたかどうか。水準器UI
    // （#gyroLevelContainer）の表示可否は、以前は画面幅(768px未満=スマホと
    // 決め打ち)で判定していたが、タブレットは横向き・大画面だと768px以上に
    // なりがちで、実際にジャイロを搭載していても表示されない不具合があった。
    // v4.6.19より、画面幅ではなく「実際にセンサーからデータが取れたか」で
    // 判定する方式に変更した（js/core/orientation.js参照）。
    gyroSensorConfirmed: false,
    deviceOrientation: { beta: 90, gamma: 0 },
    isDeviceVertical: false,
    isAthleteFullyVisible: false,
    autoRecCountdownTimer: null,
    autoRecCountdownVal: 3,
    isAutoRecActive: false,
    isMobileView: false,
    isSelfie: false,
    cameraFacingMode: "environment",
    // 2026-08-04追加: カメラを縦向き(ポートレート)に固定設置した場合の
    // 回転補正角度。0=横置き(補正なし、既定)、90=時計回りに90度回転して
    // 補正、-90=反時計回り���90度回転して補正。OBSBOT等の一部カメラは
    // 「縦置きで自動的に映像も縦になる」と案内されているが、実機検証の
    // 結果、ブラウザが直接受け取る映像(getUserMedia経由)には自動回転が
    // 適用されないことが判明したため、アプリ側でこの値を使って回転補正を
    // 行う（js/core/camera.jsのgetUprightVideoFrame()参照）。姿勢推定
    // (BlazePose)は被写体がほぼ直立した向きでないと正しく検出できないため、
    // 表示だけでなく姿勢推定の入力フレームそのものをこの値で補正する。
    cameraRotationDeg: 0,
    isAutoRecReady: false,
    autoRecStandbyTimer: null,
    currentCategory: "static",

    // 履歴画面から特定の1ポーズ（例:前面のみ）を読み込んで確認・微調整して
    // いる最中かどうか。前面→左側面→後面→右側面と連続撮影中のライブフロー
    // (appMode==='playback'だが撮影直後)と、履歴からピンポイントで1件だけ
    // 読み込んだ確認(見た目は同じappMode==='playback')を区別するためのフラグ。
    // これが立っている間は「決定して次へ」の連続撮影プロンプトを出さず、
    // 再生・微調整・書き出し系ツールは常に���示する（updateModeUI参照）。
    isHistoryPlaybackSession: false,

    // 前面/左側面/後面/右側面の4方向を撮り終えた直後に出す「確認・修正」画面
    // (batchReview.js) 用の状態。
    //  - currentBatchSessionIds: 今の一連の4面撮影で、各ポーズが実際に
    //    保存されているセッションID。同じポーズを撮り直した時にこのIDを
    //    再利用することで「新規追加」ではなく「上書き」にする。新しい4面
    //    撮影を始める(=前面をこれから撮る)タイミングでnullにリセットする。
    //  - isRetakingBatchPose: 確認・修正画面の「🔁 撮り直す」から、特定の
    //    1ポーズだけを再撮影している最中かどうか。trueの間は連続撮影の
    //    「決定して次へ」チェーンに入らず、撮影完了後は確認・修正画面へ
    //    戻る。
    //  - editReturnTarget: 再生・微調整画面を「どこから開いたか」
    //    ('batchReview'なら確認・修正画面、'historyBatch'なら履歴の4面
    //    まとめ表示画面、それ以外は履歴画面など従来通りライブカメラへ
    //    戻る)。戻り先のボタン出し分けに使う。
    //  - currentBatchId: 今の一連の4面撮影1回分に共通で付与���るID
    //    (前面をこれから撮る＝新しいバッチを始めるタイミングで新規発行)。
    //    保存される各ポーズのセッションデータにも同じ値を持たせることで、
    //    履歴一覧で「この4面は同じ1回の測定」と機械的に束ねられるようにする
    //    (v4.6.14で追加。これより前に保存された過去データにはこの値が
    //    無いため、履歴側では従来通り1件ずつ表示する)。
    currentBatchSessionIds: { front: null, l_side: null, back: null, r_side: null },
    currentBatchId: null,
    // loadSession()で読み込んだセッションが持っていたbatchId（4面まとめ表示用の
    // 共通の目印）を一時的に控えておく変数。微調整して保存し直す時に、
    // このbatchIdを引き継いで保存するために使う（controls.js参照）。
    activeSessionBatchId: null,
    // loadSession()で読み込んだセッションが持っていたstatus（'draft'/'final'）を
    // 一時的に控えておく変数。saveEditsAndReturnToHistoryBatch/
    // saveEditsAndReturnToDynConfirmHistoryが、微調整して保存し直す時に
    // 元の確定状態を維持するために使う（controls.js参照）。
    activeSessionStatus: null,
    // 2026-08-03追加: loadSession()で読み込んだセッションが持っていた
    // capturedRollDeg・canvasWidth/Heightを一時的に控えておく変数。
    // saveEditsAndReturnTo*系（controls.js）が、この画面を経由しただけ
    // （何も微調整しなくても）で保存の全置換によりこれらの値を消して
    // しまわないよう、引き継ぐために使う。これらを含め忘れたことが原因で、
    // 重心動揺モードなどで一度「🔍 確認」の再生画面を開いて戻るだけで、
    // 後で履歴から見た時に骨格点の座標とcanvasMPの解像度が食い違い、
    // 棒人間が表示されなくなる不具合があった（2026-08-03のご指摘）。
    activeSessionCapturedRollDeg: null,
    activeSessionCanvasWidth: null,
    activeSessionCanvasHeight: null,
    // 2026-08-05追加: activeSessionCapturedRollDegと同じ理由（controls.jsの
    // saveEditsAndReturnTo*系が、微調整して保存し直す時にこのセッションが
    // 撮影時点に持っていたアルコ正中線座標を消してしまわないよう控えて
    // おく）。js/ui/history.jsのloadSession()がセットする。
    activeSessionCapturedArucoMidlineX: null,
    activeSessionCapturedArucoMidlineY: null,
    // 2026-08-25追加: activeSessionCapturedRollDegと同じ「引��継ぎ用の一時
    // ステージング変数」パターン���loadSession()で読み込んだセッションが
    // 持っていたphotoFormat（'clean_v1'＝骨格線等の重ね書き無しの写真、
    // 未設定＝v4.9.14以前の旧形式＝骨格線等が写真に焼き込み済み）を控えて
    // おき、saveEditsAndReturnTo*系（controls.js）がD-pad微調整後に保存し
    // 直す際、写真自体は変えていないのにphotoFormatだけ誤って'clean_v1'へ
    // 書き換えてしまわないようにする（旧形式の写真に対して新形式のつもりで
    // 骨格オーバーレイを重ね描きすると、二重に重なって表示されてしまうため）。
    activeSessionPhotoFormat: null,
    isRetakingBatchPose: false,
    editReturnTarget: null,
    // レポート画面（dashboardOverlay）を「✖ 閉じる」で閉じた時に、ただ
    // 閉じるだけでなく元の画面へ戻す必要がある場合に使う。'historyBatch'なら
    // 履歴の4面まとめ表示画面を再度開く（js/ui/dashboard.js参照）。
    dashboardReturnTarget: null,
    // レポート画面(js/ui/dashboard.js)が「4方向総合所見」セクションを
    // 追加表示するために参照する、{mode: sessionId}形式のオブジェクト。
    // 4面(静止姿勢)のデータが本当に揃っている文脈でレポート���開く時だけ、
    // 呼び出し側(js/ui/batchReview.jsのfinalizeBatch/viewHistoryBatchReport)
    // が明示的にセットする。単独セッションのレポート表示(履歴の個別
    // レポート・動作解析モードのレポート等)では必ずnullのままにしておく
    // （v4.6.16で追加）。
    multiViewSessionIds: null,

    playbackDataMP: [],
    mainRenderId: null,
    recordingDuration: 5000,
    coordinateBufferMP: [],
    poseDataLog: [],
    playbackRafId: null,

    // 再生スピード倍率（0.25/0.5/1/2倍）。静止4方向・動作解析どちらの
    // 再生・微調整画面でも共通で使う（renderPlaybackFrame/playLoopは
    // モードを問わず同じ実装のため）。新しいセッションを読み込む・撮影
    // 完了直後に再生画面へ入る際は必ず1倍へ戻す（history.js/recorder.js参照）。
    playbackSpeed: 1,

    // 微調整画面の背景に、撮影時の実写真（骨格オーバーレイ済み）を
    // 敷くかどうか。静止4方向のみ撮影完了時に1枚だけ写真を保存しており
    // （動作解析は元々写真を保存しない）、trueの間はrenderPlaybackFrameが
    // 単色背景の代わりにその写真を描画してから骨格を重ねる。
    showPhotoBackground: false,

    selectedJointIndex: null,
    dpadStepVal: 1,
    isEditingPlaybackFrame: false,
    swayHistoryMP: [],

    pxToCmRatio: null,
    // 2026-08-03追加: 「4隅ArUco」床面キャリブレーション（js/core/arucoCalibration.js）
    // で4隅マーカーから求めた「画像ピクセル→床面実寸mm」の射影変換
    // （ホモグラフィ、8要素の配列）。null = 未校正（従来通りpxToCmRatioの
    // 等方スケールのみで計算する）。固定設置カメラでのみ意味を持つため、
    // 手持ち撮影ではnullのままで問題ない（後方互換）。重心動揺(sway)モードの
    // 足首位置を実寸2軸(mm)に変換するためだけに使う（他モードのスケール
    // 校正は引き続きpxToCmRatioの等方スケールを使う。射影変換自体は4隅
    // マーカーが置かれた床面上の点にしか正しく適用できないため）。
    floorHomography: null,
    // 2026-08-07追加: 「4隅ArUco」床面キャリブレーション時に、マーカー4隅の
    // 並びから算出したカメラのroll角度（度）。従来は校正画面の警告表示
    // （「⚠ 傾きが大きいです」）にしか使っていなかったが、三脚等の固定設置
    // カメラ（ジャイロを持たないことが多い）でもroll補正が効くよう、
    // 撮影確定時（js/core/recorder.js）にジャイロより優先して使う
    // （企画者要望、2026-08-07）。null = 未校正、または校正済みだがこの値が
    // 保存されていない旧形式データ（この場合は従来通りジャイロにフォール
    // バックする）。floorHomography/pxToCmRatioと同じく「ライブ校正時の
    // 現在値」を持つだけの変数で、撮影確定の瞬間にcapturedRollDegへ
    // 凍結コピーされた後は、履歴側の伝播はcapturedRollDeg側の既存の仕組み
    // （v4.9.1）がそのまま担う。
    arucoCalibratedRollDeg: null,
    // 2026-08-05追加: 「4隅ArUco」床面キャリブレーションのボード4隅の対角線
    // 交点＝ボードの物理的な中心が、画像上のどのピクセル座標に映っているか
    // （js/core/arucoCalibration.jsのcomputeQuadCenterFromDiagonals参照）。
    // null = 未校正、または校正済みだが中心座標が保存されていない旧形式の
    // 校正データ（この場合は従来方式へ自動フォールバックする）。
    // floorHomography/pxToCmRatioと同じく「ライブ校正時の現在値」と
    // 「履歴から読み込んだ撮影時点の値」を同じ変数で兼用する
    // （js/ui/history.jsのloadSession()等が読込時に上書きする）。
    // 研究機関向け「静止姿勢: アルコ正中線モード」（useArucoMidline）専用の
    // 参照点で、既存の「両足の中心」基準の計算とは独立している。
    arucoMidlineX: null,
    arucoMidlineY: null,
    // 上記useArucoMidlineトグル。ONの場合、静止4方向（前面/後面/左右側面）
    // でのみ、荷重左右比率・ケンダルのプラムラインの基準点を「両足の中心」
    // から「アルコマーカー中心」に差し替える（研究機関からの要望、
    // 2026-08-05）。ArUco未校正時（arucoMidlineXがnull）は、このトグルが
    // ONでも自動的に従来方式（両足基準）へフォールバックする。
    // pxToCmRatio/floorHomographyと同じく、ライブ撮影中の操作トグルと、
    // 履歴から読み込んだ撮影時点の使用有無フラグを兼用する。
    useArucoMidline: false,
    estimatedPelvicTilt: 0,
    calibState: "idle",
    calibrationPoints: [],

    activeSessionId: null,
    activePatientName: "ゲスト",
    activeExpertComment: "",
    activeExpertExercises: "",

    isSpecialist: false,

    exportRecorder: null,
    exportChunks: [],
    isExportingVideo: false,

    renderSessionId: 0,
    playbackStartTime: 0,
    playbackBaseTime: 0,
    playbackTotalDuration: 0,
    playbackStartFrame: 0,

    staticBackgroundData: null,

    currentAnchorPos: null,
    customOriginMarkers: {},
    anchorStatus: "unlocked"
};

export var DURATION_MAP = {
    'front': 5000, 'back': 5000, 'l_side': 5000, 'r_side': 5000,
    'sway': 30000,
    'dyn_overhead': 15000, 'dyn_overhead_side': 15000,
    'dyn_single_r': 15000, 'dyn_single_l': 15000,
    'dyn_flex_fwd': 10000, 'dyn_flex_bwd': 10000,
    'dyn_shoulder_r': 10000, 'dyn_shoulder_l': 10000
};

export var JOINT_NAMES_JP = {
    0: "鼻", 11: "左肩", 12: "右肩", 13: "左肘", 14: "右肘", 15: "左手首", 16: "右手首",
    23: "左股関節", 24: "右股関節", 25: "左膝", 26: "右膝", 27: "左足首", 28: "右足首",
    29: "左踵", 30: "右踵", 31: "左つま先", 32: "右つま先", 33: "左ASIS (仮想)", 34: "右ASIS (仮想)"
};

export var MODE_NAMES_JP = {
    'front': '🧍 前面', 'back': '🧍 後面', 'l_side': '🧍 左側面', 'r_side': '🧍 右側面',
    'sway': '⚖️ 重心動揺',
    'dyn_overhead': '🏋️ OHS [前面]', 'dyn_overhead_side': '🏋️ OHS [側面]',
    'dyn_single_r': '🦵 片脚 [右]', 'dyn_single_l': '🦵 片脚 [左]',
    'dyn_flex_fwd': '🙇 立位前屈', 'dyn_flex_bwd': '🤸 立位後屈',
    'dyn_shoulder_r': '👐 肩複合 [右上]', 'dyn_shoulder_l': '👐 肩複合 [左上]'
};

/* =============================================================================
   測定カテゴリー判定（静止姿勢／重心動揺／動作解析）
   -----------------------------------------------------------------------------
   以前は「isStaticMode = ['front','back','l_side','r_side'].includes(mode)」
   という同じ判定式が、controls.js・recorder.js・calibration.js・shootFlow.js
   の4箇所にそれぞれ個別に書かれていた。「重心動揺」を3つ目のカテゴリーとして
   追加するにあたり、この判定を毎回2択→3択に書き換える必要が生じるため、
   1箇所でも直し漏れると（COP sway計算が複数箇所に重複していて片方だけ
   直してしまったv4.6.21のときと同種の）見落としバグにつながりやすい。
   判定ロジックをここに一本化し、各モジュールはgetModeCategory()を呼ぶだけに
   する（2026-07-30、重心動揺モード追加時に整理）。
   ========================================================================== */
export var STATIC_MODES = ['front', 'back', 'l_side', 'r_side'];
export var SWAY_MODES = ['sway'];

// 'static' | 'sway' | 'dynamic' のいずれかを返す。
// 重心動揺は録画・骨格ログ・再生画面など撮影まわりの仕組みは動作解析と
// ほぼ同じ（4方向の合成を行う「静止姿勢バッチ」の対象ではない）ため、
// isStaticMode()は重心動揺をfalse（＝動作解析寄り）として扱う。
// カテゴリー分け（タブ・ドロップダウン・表示名）が必要な箇所でのみ
// getModeCategory()の3値を使う。
export function getModeCategory(mode) {
    if (STATIC_MODES.indexOf(mode) !== -1) return 'static';
    if (SWAY_MODES.indexOf(mode) !== -1) return 'sway';
    return 'dynamic';
}

export function isStaticMode(mode) {
    return STATIC_MODES.indexOf(mode) !== -1;
}

// 2026-08-24追加: COPレーダー（重心動揺の丸いウィジェット・データ収集）を
// 表示・収集してよいかどうかの判定を1箇所に一本化する（getModeCategory()と
// 同じ考え方）。企画者から「静止4方向は正面を向いている前提でしか左右の
// 荷重比較に意味が無く、後面・側面まで含めて評価するのはユーザーにも
// 伝わりにくい」とのご指摘があり、静止4方向のうち前面(front)以外
// （back/l_side/r_side）ではCOPレーダーのウィジェット非表示・データ収集
// 停止・帳票のCOP動揺項目非表示とする（2026-08-24）。重心動揺専用モード
// （sway）・動作解析（dyn_*）は���象外（従来通り表示・収集する）。
export function shouldShowCopRadar(mode) {
    return !(STATIC_MODES.indexOf(mode) !== -1 && mode !== 'front');
}

// 2026-08-05追加: 「静止姿勢: アルコ正中線モード」が今、実際に有効かどうかの
// 判定を1箇所に一本化する（同種の判定ロジックを複数箇所に個別コピーすると
// 直し漏れの温床になるため、getModeCategory()と同じ考え方で共通化）。
// 呼び出し側（js/core/camera.js・js/ui/controls.js）は、この関数が返した
// 値（アルコ中心の画像ピクセルX座標、または無効ならnull）を
// biomechanics.calculateWeightBearing/drawKendallAlignmentへそのまま渡す。
// 対象は静止4方向（前面/後面/左右側面）のみ（動作解析・重心動揺は対象外）。
// ArUco未校正（state.arucoMidlineXがnull）の場合は、トグルがONでも
// 自動的に従来方式（両足基準）へフォールバックする。
export function getEffectiveArucoMidlineX(mode) {
    if (!state.useArucoMidline) return null;
    if (STATIC_MODES.indexOf(mode) === -1) return null;
    if (typeof state.arucoMidlineX !== 'number' || !isFinite(state.arucoMidlineX)) return null;
    return state.arucoMidlineX;
}

export var reportDataStore = {};
Object.keys(DURATION_MAP).forEach(function (dir) {
    reportDataStore[dir] = null;
    state.customOriginMarkers[dir] = null;
});
