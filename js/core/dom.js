/**
 * dom.js
 * ---------------------------------------------------------------------------
 * よく使うDOM要素参照を1箇所に集約する。index.html のID構造は旧版から
 * 踏襲しているため、既存のCSSセレクタとの対応関係もそのまま使える。
 */

export var video = document.getElementById('video');
export var canvasMP = document.getElementById('canvasMP');
export var ctxMP = canvasMP.getContext('2d');
export var canvasComb = document.getElementById('canvasCombined');
export var ctxComb = canvasComb.getContext('2d');
export var radarWrapperMP = document.getElementById('radarWrapperMP');
export var canvasRadarMP = document.getElementById('canvasRadarMP');
export var ctxRadarMP = canvasRadarMP.getContext('2d');

export var startBtn = document.getElementById('startBtn');
export var recBtn = document.getElementById('recBtn');
export var durationSelect = document.getElementById('durationSelect');
export var timerDisplay = document.getElementById('timerDisplay');
// セルフタイマー（検証用・一時的機能。2026-08-24追加、後日削除予定）
export var selfTimerSelect = document.getElementById('selfTimerSelect');
export var selfTimerCountdown = document.getElementById('selfTimerCountdown');
export var downloadCsvBtn = document.getElementById('downloadCsvBtn');
export var showSwayAlertCheckbox = document.getElementById('showSwayAlert');
export var videoSource = document.getElementById('videoSource');

export var patientNameInput = document.getElementById('patientName');
export var heightInput = document.getElementById('patientHeight');
export var footSizeInput = document.getElementById('footSize');
export var calibrateMatBtn = document.getElementById('calibrateMatBtn');
// 撮影画面の「スケール未校正」「骨盤傾斜: 0°」表示（旧infoPanel/scaleStatus/
// pelvicStatus）はv4.6.13で撮影画面から削除した。骨盤傾斜は自動計算されて
// いない値のため表示不要と判断（企画者確認済み）。スケール係数は一般利用者
// には内部データとして持っていれば十分だが、検証段階の確認用として設定
// 画面にのみ残す（debugScaleRatioDisplay）。
export var debugScaleRatioDisplay = document.getElementById('debugScaleRatio');
// カメラ起動時に実際に取得できた映像解像度（video.videoWidth/videoHeight）を
// 表示する検証用の行。「撮影した写真が荒い」という報告の切り分けのため、
// リクエストしている解像度(1920x1080希望)と実際にカメラ/ブラウザが応答した
// 解像度が一致しているかを確認できるようにした（v4.6.17で追加、
// js/core/camera.js参照）。
export var debugCameraResolutionDisplay = document.getElementById('debugCameraResolution');
// 画面表示幅（CSSピクセル、devicePixelRatio正規化後）の検証用表示。
// タブレットの機種・向きによっては物理的な画面サイズとCSS表示幅が比例せず、
// スマホ向けのレイアウト調整が大き目のタブレットに誤って適用されてしまう
// ことがあったため（v4.6.27）、非技術者でも実測値を自己診断できるよう
// 設定画面に追加した（js/app.jsのupdateDebugViewportSize()参照）。
export var debugViewportSizeDisplay = document.getElementById('debugViewportSize');

export var toggleUiBtn = document.getElementById('toggleUiBtn');
export var controlsBox = document.getElementById('controlsBox');

export var importSessionJson = document.getElementById('importSessionJson');
export var importJsonGroup = document.getElementById('importJsonGroup');
export var exportSessionJsonBtn = document.getElementById('exportSessionJsonBtn');
