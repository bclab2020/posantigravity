/**
 * controls.js
 * ---------------------------------------------------------------------------
 * モード切替（静止4方向・動的8種）、解析カテゴリタブ、再生コントロール
 * （タイムライン・再生/一時停止）、D-padによる関節点微調整、
 * カメラ⇔再生モードの往復といった「メインUI操作」全般を担当。
 * 元 app.js の該当ハンドラ群を移植。
 */

import { state, DURATION_MAP, JOINT_NAMES_JP, reportDataStore, getModeCategory, isStaticMode as isStaticModeCheck, STATIC_MODES, getEffectiveArucoMidlineX, shouldShowCopRadar } from '../core/state.js';
import { canvasMP, ctxMP, canvasRadarMP, ctxRadarMP, radarWrapperMP, startBtn, footSizeInput, heightInput } from '../core/dom.js';
import biomechanics from '../biomechanics.js';

export function updateCameraModeBadge() {
    var badge = document.getElementById('cameraModeBadge');
    // 通常撮影/セルフ撮影の切替は撮影設定カード内のタブ選択（setupNormalShootBtn/
    // setupSelfieShootBtn）に統一したため、ここではライブ画面の状態バッジ表示と
    // 設定カード側タブのactive状態の同期のみを行う。
    var setupNormalBtn = document.getElementById('setupNormalShootBtn');
    var setupSelfieBtn = document.getElementById('setupSelfieShootBtn');

    if (badge) {
        if (state.isSelfie) {
            badge.innerText = "🤳 セルフ撮影（鏡像）";
            badge.classList.add('selfie-active');
        } else {
            badge.innerText = "🧍 通常撮影（標準）";
            badge.classList.remove('selfie-active');
        }
    }
    if (setupNormalBtn && setupSelfieBtn) {
        setupNormalBtn.classList.toggle('active', !state.isSelfie);
        setupSelfieBtn.classList.toggle('active', state.isSelfie);
    }
}

// 2026-08-03: 履歴・撮影確認画面からの再生・微調整中に、操作パネル
// (#uiFloatingLayer)が棒人間の描画エリア(#canvasMP)の上に浮いて重なり、
// 一部が隠れてしまうというご指摘への対応。ライブ撮影中(state.appMode
// ==='camera')の画面はこれまで通り変更しない。#uiFloatingLayerの高さは
// 画面幅・表示中のボタン構成によって大きく変わる（このプロジェクトでは
// 実機のタブレット機種ごとにCSS表示幅がズレる問題を何度も経験している）
// ため、ブレークポイントごとに隠す高さをハードコードするのではなく、
// ResizeObserverで実測してCSS変数へ反映する方式にする
// （style.cssのbody.review-playback-active参照）。
var _reviewControlsResizeObserver = null;
function ensureReviewControlsHeightObserver() {
    if (_reviewControlsResizeObserver || typeof ResizeObserver === 'undefined') return;
    var floatingLayer = document.getElementById('uiFloatingLayer');
    if (!floatingLayer) return;
    _reviewControlsResizeObserver = new ResizeObserver(function () {
        syncReviewControlsHeightVar();
    });
    _reviewControlsResizeObserver.observe(floatingLayer);
}

function syncReviewControlsHeightVar() {
    if (!document.body.classList.contains('review-playback-active')) return;
    var floatingLayer = document.getElementById('uiFloatingLayer');
    var visualArea = document.querySelector('.visual-area');
    if (!floatingLayer || !visualArea) return;

    var floatingRect = floatingLayer.getBoundingClientRect();
    var visualRect = visualArea.getBoundingClientRect();
    if (floatingRect.height <= 0 || visualRect.height <= 0) {
        visualArea.style.setProperty('--review-controls-height', '0px');
        return;
    }

    // 専門家モード（PCの広い画面、body.specialist-unlocked かつ
    // min-width:1024px・マウス操作環境）では#uiFloatingLayerが画像の右側に
    // 縦長のサイドパネルとして配置され、そもそも画像の上に重ならない
    // （既存の唯一の「重ならない」レイアウト、style.cssのbody.
    // specialist-unlocked #uiFloatingLayer参照）。この条件と完全に揃えて
    // 判定することで、画面幅の実測値から間接的に推測するより確実に
    // 「サイドパネル配置かどうか」を見分けられるようにする（幅の実測値
    // だけで判定すると、非常に横長のデスクトップ画面で通常の下部バンドを
    // 誤ってサイドパネル扱いしてしまう恐れがあるため）。
    var isSidePanelLayout = document.body.classList.contains('specialist-unlocked') &&
        window.matchMedia('(min-width: 1024px) and (hover: hover) and (pointer: fine)').matches;
    if (isSidePanelLayout) {
        visualArea.style.setProperty('--review-controls-height', '0px');
        return;
    }

    // #uiFloatingLayerは画面幅・ブレークポイントによって、画像の下端に
    // 直接くっついて浮いていたり(bottom:20px等)、ナビゲーションバーぶん
    // 上に余白を取って浮いていたり(bottom:var(--nav-size)等)と、下端からの
    // オフセットの取り方がまちまち。#uiFloatingLayer自身の高さだけを
    // 引くと、そのオフセット分だけ計算が合わずcanvasの下端と操作パネルの
    // 上端がずれて重なりが残ってしまう（実機検証前のPlaywright確認で発覚）。
    // 「.visual-areaの下端から#uiFloatingLayerの上端までの実際の距離」を
    // そのまま使うことで、下端オフセットの取り方によらず正しく画角を
    // 詰められるようにする。
    var gap = visualRect.bottom - floatingRect.top;
    if (gap < 0) gap = 0;
    // 万一の計算不整合で画角のほとんどを潰してしまわないよう安全弁を掛けておく
    // （通常の操作パネルの高さはここまで大きくならない想定）。
    var maxGap = visualRect.height * 0.75;
    if (gap > maxGap) gap = maxGap;

    visualArea.style.setProperty('--review-controls-height', (gap > 0 ? (gap + 12) : 0) + 'px');
}

function updateReviewLayoutMode() {
    ensureReviewControlsHeightObserver();
    var isReview = state.appMode === 'playback';
    document.body.classList.toggle('review-playback-active', isReview);
    if (isReview) syncReviewControlsHeightVar();
}

export function checkDeviceType() {
    state.isMobileView = window.innerWidth < 768;
    var container = document.getElementById('gyroLevelContainer');
    if (container) {
        // 水準器UIの表示可否は、以前は画面幅(768px未満=スマホ想定)で判定して
        // いたが、タブレットは横向き・大画面だと768px以上になりがちで、実際に
        // ジャイロを搭載していても表示されない不具合があった。v4.6.19より、
        // 画面幅ではなく「実際に'deviceorientation'から有効な値を受信できたか」
        // (state.gyroSensorConfirmed、js/core/orientation.js参照)で判定する。
        container.style.display = (state.gyroSensorConfirmed && state.isRunning && state.appMode === 'camera') ? 'flex' : 'none';
    }
}
window.addEventListener('resize', checkDeviceType);

export function updateModeUI(mode) {
    state.currentTab = mode;
    state.recordingDuration = DURATION_MAP[state.currentTab] || 10000;

    var durationSelect = document.getElementById('durationSelect');
    if (durationSelect) durationSelect.value = state.recordingDuration.toString();

    // 2026-08-24追加: COPレーダーウィジェットは静止4方向のうち正面(front)
    // 以外（back/l_side/r_side）では非表示にする（js/core/state.jsの
    // shouldShowCopRadar参照）。毎フレームではなくモード切替のタイミングで
    // 一度だけ切り替える。
    if (radarWrapperMP) {
        radarWrapperMP.style.display = shouldShowCopRadar(mode) ? '' : 'none';
    }

    syncTabButtonsForMode(state.currentTab);

    var modeSelect = document.getElementById('modeSelect');
    if (modeSelect) modeSelect.value = state.currentTab;

    var nextBtn = document.getElementById('nextMeasureBtn');
    var isStaticMode = isStaticModeCheck(mode);
    // 履歴、または4面確認・修正画面から1ポーズだけ読み込んで確認中は、
    // 連続撮影中の「決定して次へ」プロンプトを出さない（次のポーズへ
    // 進む操作ではないため）。撮り直し中も同様に専用の戻るプロンプトを使う。
    var isLiveStaticChain = isStaticMode && !state.isHistoryPlaybackSession && !state.isRetakingBatchPose;
    if (nextBtn) {
        if (state.isRetakingBatchPose && state.appMode === 'playback') {
            nextBtn.style.display = 'flex';
            nextBtn.innerText = '✅ 4面確認へ戻る';
        } else if (isLiveStaticChain && state.appMode === 'playback') {
            nextBtn.style.display = 'flex';
            var labels = { 'front': '決定して左側面へ ➡', 'l_side': '決定して後面へ ➡', 'back': '決定して右側面へ ➡', 'r_side': '決定して確認画面へ ➡' };
            nextBtn.innerText = labels[mode] || '決定して次へ';
        } else {
            nextBtn.style.display = 'none';
        }
    }

    // 前面/左側面/後面と連続で撮っていく間の確認画面は「再測定へ/決定して次へ」
    // だけに絞り、再生・微調整・書き出し系(動画/CSV/レポート)は4面確認・修正
    // 画面や、動的種目(動作解析)の確認画面だけに残す。どちらの画面も内部的には
    // state.currentTab単位のデータしか書き出せない仕様のため、機能自体を削る
    // のではなく「毎回は出さない」対応に留めている。
    // ただし履歴/4面確認・修正画面から特定の1ポーズ（例:前面だけ）を読み込んで
    // 確認・微調整している場合は、そのポーズがどれであっても常にツール一式を出す
    // （四面撮り終えた後に「前面だけ直す」といった個別修正ができるように）。
    // 撮り直し中は連続撮影の途中確認画面と同様シンプルに保つ。
    var reviewExtraTools = document.getElementById('reviewExtraTools');
    if (reviewExtraTools) {
        // 以前は動的種目(!isStaticMode)であれば無条件でtrueにしていたため、
        // 撮影完了直後の未確定な結果（履歴/4面確認画面経由ではない、撮ったばかりの
        // 状態）でもツール一式が出てしまっていた。動作解析は静止4方向と同じく、
        // 履歴・4面/確認画面から個別に開き直した場合(isHistoryPlaybackSession)
        // だけツール一式を出す扱いに統一する（2026-07-29のご指摘対応）。
        var showExtraTools = state.isHistoryPlaybackSession && !state.isRetakingBatchPose;
        reviewExtraTools.classList.toggle('tools-hidden', !showExtraTools);
    }

    // 4面確認・修正画面（撮影直後・未確定 batchReview、または履歴の4面
    // まとめ画面・確定済み historyBatch）から個別のポーズを「🔍 詳細を見る」
    // （2026-08-25、旧ラベル「✂️ 微調整」からリネーム）で
    // 開いている間は、ここでの「📄 レポート」を隠す。batchReview側は
    // このレポートボタンを押しただけでは確定されないため、ここから直接
    // レポートへ抜けると「レポートは見られたのに履歴には出てこない」という
    // 混乱のもとになる（確定は必ず4面確認・修正画面側の「✅ この内容で確定」
    // を経由させる）。historyBatch側はすでに確定済みだが、4面まとめての
    // レポートは今回のスコープ外のため、一貫性を保つ意味でも同様に隠す。
    // 'dynConfirm'/'dynConfirmHistory'は動作解析（動的種目）の撮影確認画面
    // (js/ui/dynConfirm.js)から「🔍 確認」で個別に開いている状態（前者は
    // 撮影直後・未確定、後者は履歴一覧からのタップ）。静止4方向のbatchReview/
    // historyBatchと同じ「専用の戻るボタンを出す・単独CSV/レポートボタンは
    // 隠す(確認画面側にまとめる)」扱いにする（2026-07-29のご要望対応）。
    var isBatchStyleFineTune = (state.editReturnTarget === 'batchReview' || state.editReturnTarget === 'historyBatch' ||
        state.editReturnTarget === 'dynConfirm' || state.editReturnTarget === 'dynConfirmHistory');
    var printReportBtn = document.getElementById('printReportBtn');
    if (printReportBtn) {
        printReportBtn.style.display = isBatchStyleFineTune ? 'none' : '';
    }

    // 「📊 CSV」（このポーズ1つ分の生座標データ書き出し）も、上記と同じ理由で
    // 4面確認・修正画面/履歴の4面まとめ画面から個別のポーズを開いている間
    // だけ隠す。4面分は代わりにそれぞれの画面側の「📊 CSV書き出し(4面分)」
    // でまとめて書き出せるため。履歴からの単独再生・動作解析（動的種目）の
    // 結果画面では、まとめる対象がそもそも無い（1件単位のデータのため）ので、
    // 引き続きこのボタンを使う。
    var downloadCsvBtn = document.getElementById('downloadCsvBtn');
    if (downloadCsvBtn) {
        downloadCsvBtn.style.display = isBatchStyleFineTune ? 'none' : '';
    }

    // 「🖼 写真を表示」トグルは、実写真を保存している静止4方向でだけ意味を
    // 持つ（動作解析は撮影完了時に写真を保存しないため対象外）。写真データが
    // 無いポーズ（旧データ等）ではdisabledにして、押しても何も変わらない
    // 状態を防ぐ。ラベルは現在のON/OFF状態に常に同期させる。
    var togglePhotoBgBtn = document.getElementById('togglePhotoBgBtn');
    if (togglePhotoBgBtn) {
        var hasPhotoForTab = isStaticMode && !!(reportDataStore[mode] && reportDataStore[mode].capturedImage);
        togglePhotoBgBtn.style.display = isStaticMode ? '' : 'none';
        togglePhotoBgBtn.disabled = !hasPhotoForTab;
        togglePhotoBgBtn.innerText = state.showPhotoBackground ? "🦴 骨格のみ表示" : "🖼 写真を表示";
    }

    // 再生・微調整画面の「戻る」ボタンは、4面確認・修正画面（batchReview）
    // または履歴の4面まとめ画面（historyBatch）から開いた場合だけ専用ボタン
    // （保存してそちらへ戻る）に差し替える。それ以外（履歴からの単独再生等）
    // は従来通り「🔙 再測定へ」でライブカメラに戻る。実際にどちらの画面へ
    // 戻すか（保存処理の違いも含む）はapp.js側のonclickで振り分ける。
    var backToCamBtn = document.getElementById('backToCamBtn');
    var backToBatchReviewBtn = document.getElementById('backToBatchReviewBtn');
    if (backToCamBtn && backToBatchReviewBtn) {
        var showBatchReturnBtn = isBatchStyleFineTune && state.appMode === 'playback' && !state.isRetakingBatchPose;
        backToCamBtn.style.display = showBatchReturnBtn ? 'none' : 'flex';
        backToBatchReviewBtn.style.display = showBatchReturnBtn ? 'flex' : 'none';
        if (showBatchReturnBtn) {
            backToBatchReviewBtn.innerText = (state.editReturnTarget === 'historyBatch') ? "✅ 保存して4面データへ戻る" :
                (state.editReturnTarget === 'dynConfirm' || state.editReturnTarget === 'dynConfirmHistory') ? "✅ 保存して確認画面へ戻る" : "✅ 保存して4面確認へ戻る";
        }
    }

    // 「◀ モード選択に戻る」は、4面（前面/左側面/後面/右側面）のうち
    // まだ「✅ この内容で確定」を経ていないポーズが1つでも残っている間は隠す。
    // このボタンはカメラを止めて設定画面まで一気に戻ってしまうため、押すと
    // 4面確認・修正画面や微調整中の修正内容を経由せずに離脱でき、残りの
    // ポーズが未確定drafts（履歴には出ない状態）のまま宙に浮いてしまう
    // 導線になっていた。「今の4面をやり切る（確定する）まで、次の新しい
    // モードへは進めない」という方針のため、確定 or まだ1ポーズも撮って
    // いない状態でのみ表示する（state.currentBatchSessionIdsは
    // finalizeBatch()完了時・新規に前面から撮り始めた時にすべてnullへ戻る）。
    var backToSetupBtn = document.getElementById('shootBackToSetupBtn');
    if (backToSetupBtn) {
        var hasIncompleteBatch = Object.keys(state.currentBatchSessionIds).some(function (m) {
            return !!state.currentBatchSessionIds[m];
        });
        // 2026-08-03: 履歴からの確認・微調整画面(isBatchStyleFineTune、
        // このボタンより上で定義済み)では非表示にする。このボタンは保存を
        // 一切経由せずカメラを止めて最初の設定画面まで一気に戻ってしまう
        // ため、同じ画面にある「✅ 保存して確認画面へ戻る」等の専用の
        // 戻るボタンと役割が重複するうえ、押すとD-padでの微調整内容が
        // 保存されないまま消えてしまう紛らわしい導線だった
        // （2026-08-03のご相談）。ライブ撮影・マット校正中の役割は
        // 従来通り残す。
        backToSetupBtn.style.display = (hasIncompleteBatch || isBatchStyleFineTune) ? 'none' : '';
    }

    state.swayHistoryMP = [];
    // 骨格点の色は「連続録画系（重心動揺・動作解析）は緑、静止姿勢は赤」で
    // 統一する。以前は'dyn_'プレフィックスの有無だけで判定していたが、
    // 重心動揺モード追加にあたりカテゴリー判定（getModeCategory）に一本化した。
    biomechanics.clearRadar(ctxRadarMP, getModeCategory(state.currentTab) !== 'static' ? '#39ff14' : '#ff5252');

    updateReviewLayoutMode();
}

/**
 * 静止姿勢は前面→左側面→後面→右側面と、撮影に進んだ後に自動で順送りされる
 * 仕組みなので、設定画面の時点でどれから始めるかを選ばせる意味がない
 * （動作解析側は種目ごとに独立した測定なので、引き続き選択が必要）。
 * 重心動揺も測定モードが「重心動揺」の1つしか無く選ぶ意味が無いため、
 * 静止姿勢と同様に「測定モード」欄自体を非表示にする
 * （2026-07-30、重心動揺モード追加時に対象を拡張）。
 */
function updateModeSelectVisibility(category) {
    var group = document.getElementById('modeSelectGroup');
    if (group) group.style.display = (category === 'static' || category === 'sway') ? 'none' : 'flex';
}

// 3つの測定カテゴリータブ（静止姿勢/重心動揺/動作解析）のactive表示切り替え。
// switchAnalysisTab（タブクリック時）とsyncTabButtonsForMode（モード自体が
// 外部から変わった時、例:履歴からの読込）の両方から呼ばれるため、
// タブのactive切替ロジックをここに一本化する。
function setActiveTabButtons(category) {
    var tabStatic = document.getElementById('tabStaticBtn');
    var tabSway = document.getElementById('tabSwayBtn');
    var tabDynamic = document.getElementById('tabDynamicBtn');
    if (tabStatic) tabStatic.classList.toggle('active', category === 'static');
    if (tabSway) tabSway.classList.toggle('active', category === 'sway');
    if (tabDynamic) tabDynamic.classList.toggle('active', category === 'dynamic');
}

export function switchAnalysisTab(category) {
    if (category !== 'static' && category !== 'sway' && category !== 'dynamic') return;
    state.currentCategory = category;

    setActiveTabButtons(category);

    filterModeDropdown();
    updateModeSelectVisibility(category);

    var modeSelect = document.getElementById('modeSelect');
    if (modeSelect) {
        var firstVal = (category === 'static') ? 'front' : (category === 'sway') ? 'sway' : 'dyn_overhead';
        modeSelect.value = firstVal;
        updateModeUI(firstVal);
    }
}
window.switchAnalysisTab = switchAnalysisTab; // HTML内の動的onclickから呼ばれるため

export function filterModeDropdown() {
    var modeSelect = document.getElementById('modeSelect');
    if (!modeSelect) return;
    modeSelect.innerHTML = "";

    if (state.currentCategory === 'static') {
        var optGroup = document.createElement('optgroup');
        optGroup.label = "■ 静止姿勢アライメント (順序順)";
        [
            { val: 'front', label: '🧍 前面' }, { val: 'l_side', label: '🧍 左側面' },
            { val: 'back', label: '🧍 後面' }, { val: 'r_side', label: '🧍 右側面' }
        ].forEach(function (opt) {
            var el = document.createElement('option');
            el.value = opt.val; el.innerText = opt.label;
            optGroup.appendChild(el);
        });
        modeSelect.appendChild(optGroup);
    } else if (state.currentCategory === 'sway') {
        var optGroupSway = document.createElement('optgroup');
        optGroupSway.label = "■ 重心動揺";
        var elSway = document.createElement('option');
        elSway.value = 'sway'; elSway.innerText = '⚖️ 重心動揺';
        optGroupSway.appendChild(elSway);
        modeSelect.appendChild(optGroupSway);
    } else {
        var optGroup2 = document.createElement('optgroup');
        optGroup2.label = "■ 動的機能評価";
        [
            { val: 'dyn_overhead', label: '🏋️ OHS [前面]' }, { val: 'dyn_overhead_side', label: '🏋️ OHS [側面]' },
            { val: 'dyn_single_r', label: '🦵 片脚バランス [右軸]' }, { val: 'dyn_single_l', label: '🦵 片脚バランス [左軸]' },
            { val: 'dyn_flex_fwd', label: '🙇 立位体前屈' }, { val: 'dyn_flex_bwd', label: '🤸 立位体後屈' },
            { val: 'dyn_shoulder_r', label: '👐 肩複合可動性 [右上]' }, { val: 'dyn_shoulder_l', label: '👐 肩複合可動性 [左上]' }
        ].forEach(function (opt) {
            var el = document.createElement('option');
            el.value = opt.val; el.innerText = opt.label;
            optGroup2.appendChild(el);
        });
        modeSelect.appendChild(optGroup2);
    }
}

export function syncTabButtonsForMode(mode) {
    var category = getModeCategory(mode);

    if (state.currentCategory !== category) {
        state.currentCategory = category;
        filterModeDropdown();
    }
    updateModeSelectVisibility(category);
    setActiveTabButtons(category);
}

// ---------------------------------------------------------------------------
// 静止画キャプチャ／レポート表示用の骨格スナップショット
// ---------------------------------------------------------------------------

export function captureSkeletonImage(mode) {
    // 以前は静止4方向のみ対象にしていたが、動作解析（動的種目）も同じ
    // 「撮影確認」画面でサムネイルを表示したいというご要望（2026-07-29）
    // に対応するため、全モード対象に変更した。呼び出し側
    // (js/core/recorder.jsのstopRecording、advanceToNextMeasurement)は
    // 元々どのモードでも呼んでいたため、ここのガードを外すだけでよい。
    // 2026-08-25変更: 骨格線等を焼き込み済みのcanvasMP全体（従来の
    // canvasMP.toDataURL()）ではなく、js/core/camera.jsのブリッジ
    // (window.__captureCleanVideoFrameDataUrl、循環import回避のため
    // window経由)経由で「映像フレームそのもの」だけを取得する。骨格線・
    // 正中線オーバーレイは、この写真を表示するすべての画面
    // （renderPlaybackFrame・refreshReportView・レポート・4面/動作解析の
    // サムネイル）側で、保存済みのposeDataから毎回リアルタイムに重ね描き
    // する（drawPoseOverlay参照）。理由の詳細はcamera.js側のコメント参照。
    if (canvasMP) {
        try {
            var base64 = (typeof window.__captureCleanVideoFrameDataUrl === 'function')
                ? window.__captureCleanVideoFrameDataUrl(0.85)
                : null;
            // ブリッジが万一使えない場合（カメラ未起動時の呼び出し等）は、
            // 従来通りcanvasMPの内容をフォールバックとして使う（骨格線が
            // 焼き込まれる可能性はあるが、写真が全く保存されないよりまし）。
            if (!base64) base64 = canvasMP.toDataURL('image/jpeg', 0.85);
            if (!reportDataStore[mode]) reportDataStore[mode] = [];
            reportDataStore[mode].capturedImage = base64;
            // 2026-08-24追加: この写真をレポート等で「垂直が自然に見える」
            // 向きへ回転表示できるよう、撮影時点のroll角度も写真とセットで
            // 控えておく（js/biomechanics.jsのrenderUprightPhoto参照）。
            // 優先順位はjs/core/recorder.jsのcapturedRollDeg算出と同じ
            // （アルコ校正＞ジャイロ）。静止4方向以外（動作解析）はroll補正の
            // 対象外のため常にnullのまま（回転もされない）。
            reportDataStore[mode].capturedRollDeg = isStaticModeCheck(mode)
                ? (typeof state.arucoCalibratedRollDeg === 'number' ? state.arucoCalibratedRollDeg
                    : (state.gyroSensorConfirmed ? state.deviceOrientation.gamma : null))
                : null;
        } catch (e) {
            console.error("Failed to capture image:", e);
        }
    }
}

export function refreshReportView() {
    var w = document.getElementById('video').videoWidth || canvasMP.width;
    var h = document.getElementById('video').videoHeight || canvasMP.height;

    if (state.staticBackgroundData) {
        ctxMP.putImageData(state.staticBackgroundData, 0, 0);
    } else {
        ctxMP.fillStyle = "#111";
        ctxMP.fillRect(0, 0, w, h);
    }

    var kps = reportDataStore[state.currentTab];
    if (kps) {
        // 2026-08-19削除: 骨盤傾斜・膝の内外側偏位等から推定した「筋肉の
        // 緊張度合い」の色分けオーバーレイ（旧drawMusculoskeletalAnatomy）は、
        // 企画者から「不要なのでロジックごと削除してほしい」とのご要望が
        // あり撤去した（biomechanics.js側の関数定義自体も削除済み）。
        biomechanics.drawSkeleton(ctxMP, kps, getModeCategory(state.currentTab) !== 'static' ? '#39ff14' : '#ff5252');
        biomechanics.drawKendallAlignment(ctxMP, kps, state.pxToCmRatio, parseFloat(footSizeInput.value), state.estimatedPelvicTilt, state.currentTab, w, h, getEffectiveArucoMidlineX(state.currentTab));
        biomechanics.calculateWeightBearing(ctxMP, kps, w, h, getEffectiveArucoMidlineX(state.currentTab));

        if (state.selectedJointIndex !== null) {
            var kp = (state.selectedJointIndex === 33) ? kps.find(function (k) { return k.name === 'virtual_asis_l'; }) :
                (state.selectedJointIndex === 34) ? kps.find(function (k) { return k.name === 'virtual_asis_r'; }) : kps[state.selectedJointIndex];
            if (kp) biomechanics.drawCrosshair(ctxMP, kp, canvasMP);
        }
    }
}

/**
 * 「クリーンな写真」＋保存済みposeDataから、骨格線・正中線・荷重バランス等の
 * オーバーレイをその場で重ね描きするための共通ヘルパー（2026-08-25追加）。
 * renderPlaybackFrame()が画面上のcanvasMPに対して行っている重ね描きロジック
 * （モードに応じた分岐）を、任意のcanvasコンテキストに対しても使えるよう
 * 切り出したもの。js/ui/dashboard.js（レポートの画像ギャラリー）・
 * js/ui/batchReview.js（4面確認のサムネイル）・js/ui/dynConfirm.js（動作解析の
 * サムネイル）が、写真（js/biomechanics.jsのrenderPhotoWithOverlay）へ骨格を
 * 焼き込んで1枚のstatic画像として書き出す際に使う。
 * ctx/kps/mode/w/hはrenderPlaybackFrameと同じ意味（kpsは生ピクセル座標、
 * w/hはその写真自体の幅高さ）。
 */
export function drawPoseOverlay(ctx, kps, mode, w, h) {
    if (!ctx || !kps) return;
    var color = getModeCategory(mode) !== 'static' ? '#39ff14' : '#ff5252';
    biomechanics.drawSkeleton(ctx, kps, color);

    if (mode === 'l_side' || mode === 'r_side') {
        biomechanics.drawKendallAlignment(ctx, kps, state.pxToCmRatio, parseFloat(footSizeInput.value), state.estimatedPelvicTilt, mode, w, h, getEffectiveArucoMidlineX(mode));
    } else if (mode === 'front' || mode === 'back' || mode === 'dyn_overhead') {
        biomechanics.calculateWeightBearing(ctx, kps, w, h, getEffectiveArucoMidlineX(mode));
    }

    if (mode === 'dyn_overhead') {
        biomechanics.drawOHSFrontAnalysis(ctx, kps);
    } else if (mode === 'dyn_overhead_side') {
        biomechanics.drawOHSSideAnalysis(ctx, kps);
    } else if (mode.indexOf('dyn_flex_') === 0) {
        biomechanics.drawFlexionAnalysis(ctx, kps, mode);
    } else if (mode.indexOf('dyn_shoulder_') === 0) {
        biomechanics.drawShoulderAnalysis(ctx, kps, mode);
    }
}

// ---------------------------------------------------------------------------
// 再生（プレイバック）
// ---------------------------------------------------------------------------
// STATIC_MODESはstate.jsの定義（重心動揺モード追加時に一本化）をそのまま使う。

// 微調整画面の「写真を背景に表示」用の画像キャッシュ。base64文字列を
// 毎フレームcanvasに描くたびnew Image()でデコードし直すと重いため、
// モードごとに1つだけ保持し、base64が変わった時だけ作り直す。
// デコードは非同期のため、間に合わなかったフレームはonload完了後に
// 現在表示中のフレームを再描画して反映する。
// 2026-08-24追加→同日修正: 一度、キャッシュ作成時にbiomechanics.
// renderUprightPhoto()でcapturedRollDegぶん回転させた画像を使うようにして
// いたが、この画面（renderPlaybackFrame）は「写真を背景に敷いた上から、
// 今の骨格点(kps、無回転の生ピクセル座標)をリアルタイムに重ねて描く」
// 唯一の画面のため、写真だけを回転させると、写真に元々焼き込み済みの
// 骨格線・正中線（撮影確定時点のもの）と、この場で新たに描く骨格線・
// 正中線が噛み合わなくなり「線が二重に・ズレて重なる」不具合になった
// （企画者からのご指摘、2026-08-24）。最終レポート・4面確認画面の
// サムネイルは写真1枚だけを表示する（この場での骨格の再描画をしない）ため
// 回転しても問題ないが、この「写真を表示」トグルの画面だけは撮影時のまま
// （無回転）の写真を使い、これまで通り現在の骨格点とピクセル単位で正しく
// 一致させることを優先する。写真自体がカメラの傾きぶん傾いて見える点は
// 元の仕様（v4.9.10以前）と同じに戻るのみで、新規の不具合ではない。
var photoImgCache = {};
function getCachedPhotoImg(mode, base64) {
    var entry = photoImgCache[mode];
    if (!entry || entry.src !== base64) {
        var img = new Image();
        img.src = base64;
        entry = photoImgCache[mode] = { src: base64, img: img };
    }
    return (entry.img.complete && entry.img.naturalWidth > 0) ? entry.img : null;
}

export function renderPlaybackFrame(frameIdx) {
    if (!state.playbackDataMP[frameIdx]) return;
    var frame = state.playbackDataMP[frameIdx];
    var kps = frame.keypoints;
    var w = canvasMP.width;
    var h = canvasMP.height;

    // 静止4方向のみ、撮影完了時の実写真（骨格オーバーレイ済み）が
    // reportDataStore[mode].capturedImageに保存されている。トグルが
    // オンの間はこれを背景に敷き、その上から現在フレームの骨格点を
    // 重ねて描く（動作解析は元々写真を保存しないため対象外）。
    var capturedImage = (STATIC_MODES.includes(state.currentTab) && state.showPhotoBackground &&
        reportDataStore[state.currentTab] && reportDataStore[state.currentTab].capturedImage) || null;
    var photoImg = capturedImage ? getCachedPhotoImg(state.currentTab, capturedImage) : null;

    if (photoImg) {
        ctxMP.drawImage(photoImg, 0, 0, w, h);
    } else {
        ctxMP.fillStyle = "#050811";
        ctxMP.fillRect(0, 0, w, h);
    }

    // 2026-08-19削除: 「筋肉の緊張度合い」推定オーバーレイ（旧
    // drawMusculoskeletalAnatomy）はここでも撤去済み（上のrefreshReportView
    // と同じ理由、biomechanics.js側の関数定義自体も削除済み）。

    var color = getModeCategory(state.currentTab) !== 'static' ? '#39ff14' : '#ff5252';
    biomechanics.drawSkeleton(ctxMP, kps, color);
    if (window.updateWebGLPose) window.updateWebGLPose(kps, w, h);

    if (state.currentTab === 'l_side' || state.currentTab === 'r_side') {
        biomechanics.drawKendallAlignment(ctxMP, kps, state.pxToCmRatio, parseFloat(footSizeInput.value), state.estimatedPelvicTilt, state.currentTab, w, h, getEffectiveArucoMidlineX(state.currentTab));
    } else if (state.currentTab === 'front' || state.currentTab === 'back' || state.currentTab === 'dyn_overhead') {
        biomechanics.calculateWeightBearing(ctxMP, kps, w, h, getEffectiveArucoMidlineX(state.currentTab));
    }

    if (state.currentTab === 'dyn_overhead') {
        biomechanics.drawOHSFrontAnalysis(ctxMP, kps);
    } else if (state.currentTab === 'dyn_overhead_side') {
        biomechanics.drawOHSSideAnalysis(ctxMP, kps);
    } else if (state.currentTab.startsWith('dyn_flex_')) {
        biomechanics.drawFlexionAnalysis(ctxMP, kps, state.currentTab);
    } else if (state.currentTab.startsWith('dyn_shoulder_')) {
        biomechanics.drawShoulderAnalysis(ctxMP, kps, state.currentTab);
    }

    // 2026-08-24: COPレーダーは静止4方向のうち正面(front)以外では表示・
    // データ収集しない（js/core/state.jsのshouldShowCopRadar参照）。
    // 2026-08-25: レポートと軌跡の見た目が食い違う、との指摘を受け、ロール
    // 補正込みのcomputeCopOffsetMm()（js/biomechanics.js）に一本化。再生中は
    // セッション読み込み時にstate.activeSession*へ退避された撮影時の値
    // （history.js/batchReview.js/specialist.js/dynConfirm.js/recorder.jsが
    // 設定）を使い、レポート側（js/api.jsのextractMetrics）と同じ条件で
    // 計算する。
    if (shouldShowCopRadar(state.currentTab)) {
        var playbackCopCtx = {
            rollDeg: (typeof state.activeSessionCapturedRollDeg === 'number') ? state.activeSessionCapturedRollDeg : null,
            canvasWidth: state.activeSessionCanvasWidth || canvasMP.width,
            canvasHeight: state.activeSessionCanvasHeight || canvasMP.height,
            floorHomography: state.floorHomography,
            pxToCmRatio: state.pxToCmRatio
        };
        biomechanics.updateRadar(kps, canvasRadarMP, ctxRadarMP, state.swayHistoryMP, true, getModeCategory(state.currentTab) !== 'static' ? '#39ff14' : '#ff5252', playbackCopCtx);
    }

    // 2026-08-03: 「撮影直後は下半身が映るのに、確定して履歴から開き直すと
    // 下半身が映らない」というご報告の原因調査用に、再生中のcanvasMPの
    // 内部解像度（骨格点の生ピクセル座標の基準になっている値）を暫定的に
    // 画面へ表示する。原因が分かり次第、このデバッグ表示は削除する予定。
    document.getElementById('frameCounter').innerText = frameIdx + " / " + (state.playbackDataMP.length - 1) + "  [canvas " + canvasMP.width + "×" + canvasMP.height + "]";

    if (state.selectedJointIndex !== null && state.isEditingPlaybackFrame) {
        var kp = (state.selectedJointIndex === 33) ? kps.find(function (k) { return k.name === 'virtual_asis_l'; }) :
            (state.selectedJointIndex === 34) ? kps.find(function (k) { return k.name === 'virtual_asis_r'; }) : kps[state.selectedJointIndex];
        if (kp) biomechanics.drawCrosshair(ctxMP, kp, canvasMP);
    }
}

export function togglePlay(forcePlay) {
    state.isPlaying = (forcePlay !== undefined) ? forcePlay : !state.isPlaying;

    var btn = document.getElementById('playPauseBtn');
    if (state.isPlaying) {
        btn.innerText = "⏸ 一時停止";
        state.playbackStartTime = Date.now();
        var slider = document.getElementById('timelineSlider');
        state.playbackStartFrame = parseInt(slider.value);
        if (state.playbackStartFrame >= state.playbackDataMP.length - 1) {
            state.playbackStartFrame = 0;
            slider.value = 0;
        }
        playLoop();
    } else {
        btn.innerText = "▶ 再生";
        if (state.playbackRafId) { cancelAnimationFrame(state.playbackRafId); state.playbackRafId = null; }
    }
}

function playLoop() {
    if (!state.isPlaying) return;

    var slider = document.getElementById('timelineSlider');
    var elapsedMs = Date.now() - state.playbackStartTime;

    var frameIntervalMs = 33.3;
    if (state.playbackDataMP.length > 1 && state.playbackDataMP[1].time && state.playbackDataMP[0].time) {
        var totalMs = state.playbackDataMP[state.playbackDataMP.length - 1].time - state.playbackDataMP[0].time;
        frameIntervalMs = totalMs / (state.playbackDataMP.length - 1);
    }

    var currentFrame = state.playbackStartFrame + Math.floor((elapsedMs * state.playbackSpeed) / frameIntervalMs);

    if (currentFrame >= state.playbackDataMP.length) {
        currentFrame = 0;
        state.playbackStartTime = Date.now();
        state.playbackStartFrame = 0;
        slider.value = 0;
    }

    slider.value = currentFrame;
    renderPlaybackFrame(currentFrame);
    state.playbackRafId = requestAnimationFrame(playLoop);
}

export function exitPlaybackMode() {
    if (state.playbackRafId) { cancelAnimationFrame(state.playbackRafId); state.playbackRafId = null; }

    state.appMode = "camera";
    state.isPausedForEdit = false;
    state.isPlaying = false;
    state.selectedJointIndex = null;
    state.isEditingPlaybackFrame = false;
    state.isHistoryPlaybackSession = false;
    state.editReturnTarget = null;

    checkDeviceType();
    updateModeUI(state.currentTab);
    updateCameraModeBadge();

    document.getElementById('dpadPanel').style.display = 'none';
    document.getElementById('playbackControls').style.display = 'none';
    document.getElementById('mainControls').style.display = 'flex';
    document.getElementById('startBtn').style.display = 'flex';
    document.getElementById('recBtn').style.display = 'none';
    document.getElementById('editFrameBtn').innerText = "✂️ 微調整";
    document.getElementById('editFrameBtn').style.background = "var(--accent-orange)";
    document.getElementById('editFrameBtn').style.color = "#000";

    startBtn.click();
}

export async function advanceToNextMeasurement(speakGuidanceFn) {
    captureSkeletonImage(state.currentTab);

    // 4面確認・修正画面からの「🔁 撮り直す」経由の場合は、連続撮影チェーンには
    // 入らず、この1ポーズの撮影完了後にそのまま確認・修正画面へ戻る。
    if (state.isRetakingBatchPose) {
        state.isRetakingBatchPose = false;
        document.getElementById('dpadPanel').style.display = 'none';
        document.getElementById('playbackControls').style.display = 'none';
        if (window.__showBatchReviewScreen) window.__showBatchReviewScreen();
        return;
    }

    var nextModeMap = { 'front': 'l_side', 'l_side': 'back', 'back': 'r_side', 'r_side': 'report' };
    var nextMode = nextModeMap[state.currentTab];
    if (!nextMode) return;

    if (nextMode === 'report') {
        // 右側面まで撮り終えた直後は、いきなりレポートではなく4面確認・
        // 修正画面を挟む（気になるポーズがあれば確定前に直せるように）。
        document.getElementById('dpadPanel').style.display = 'none';
        document.getElementById('playbackControls').style.display = 'none';
        if (window.__showBatchReviewScreen) {
            window.__showBatchReviewScreen();
        } else {
            // ここに来るのは js/ui/batchReview.js が読み込まれていない
            // （ファイルの更新が一部だけ反映されていない等）場合のみのはず。
            // 黙って古い動作(直接レポート)に戻すと不具合に気づきにくいため、
            // はっきり分かるよう警告してから、フォールバックとして
            // 従来通りレポートを表示する。
            alert("確認・修正画面の読み込みに失敗しました。アプリのファイルが最新の状態になっていない可能性があります。すべてのファイルを最新版で上書きしてから、もう一度お試しください。");
            // このフォールバック経路は直前に撮影した1ポーズ分の単独レポート
            // なので、「4方向総合所見」は出さない（js/ui/dashboard.js参照）。
            state.multiViewSessionIds = null;
            // 2026-08-05追加（不具合修正）: js/ui/dashboard.jsのactiveSession
            // がcapturedRollDeg/canvasWidth/Heightのステージングフィールドを
            // 読むようになったことに伴い、この既に異常系（batchReview.js
            // 未読込）のフォールバック経路でも、前のセッションの値が誤って
            // 残らないよう明示的にnullで揃えておく（このフォールバック自体が
            // 本来通らない想定の保険経路のため、確定済みセッションを読み直す
            // 処理までは行わず、従来通りの無補正表示にとどめる）。
            state.activeSessionCapturedRollDeg = null;
            state.activeSessionCanvasWidth = null;
            state.activeSessionCanvasHeight = null;
            if (window.prepareAndPrintReport) window.prepareAndPrintReport();
        }
        return;
    }

    var guideTexts = {
        'l_side': "左側面を向いて、次の測定を始めてください",
        'back': "後面を向いて、次の測定を始めてください",
        'r_side': "右側面を向いて、次の測定を始めてください"
    };
    if (guideTexts[nextMode] && typeof speakGuidanceFn === 'function') speakGuidanceFn(guideTexts[nextMode]);

    var modeSelect = document.getElementById('modeSelect');
    if (modeSelect) { syncTabButtonsForMode(nextMode); modeSelect.value = nextMode; }

    state.appMode = "camera";
    state.isPausedForEdit = false;
    state.isPlaying = false;
    state.selectedJointIndex = null;
    state.isEditingPlaybackFrame = false;
    state.isHistoryPlaybackSession = false;

    updateModeUI(nextMode);

    document.getElementById('dpadPanel').style.display = 'none';
    document.getElementById('playbackControls').style.display = 'none';
    document.getElementById('mainControls').style.display = 'flex';
    document.getElementById('editFrameBtn').innerText = "✂️ 微調整";
    document.getElementById('editFrameBtn').style.background = "var(--accent-orange)";
    document.getElementById('editFrameBtn').style.color = "#000";

    startBtn.click();
}

/**
 * 4面確認・修正画面の「🔁 撮り直す」から呼ばれる。指定したポーズ1つだけを
 * ライブカメラで再撮影する状態に入る。advanceToNextMeasurement()の連続撮影
 * 用の遷移処理から、対象モードを固定にした形で切り出したもの。
 * 撮影完了後（recorder.jsのstopRecording→advanceToNextMeasurement）は、
 * state.isRetakingBatchPoseが立っているため連続撮影チェーンには入らず、
 * この1ポーズの確認画面を経て4面確認・修正画面へ戻る。
 */
export function startBatchPoseRetake(mode) {
    state.appMode = "camera";
    state.isPausedForEdit = false;
    state.isPlaying = false;
    state.selectedJointIndex = null;
    state.isEditingPlaybackFrame = false;
    state.isHistoryPlaybackSession = false;
    state.editReturnTarget = null;
    state.isRetakingBatchPose = true;

    var modeSelect = document.getElementById('modeSelect');
    if (modeSelect) { syncTabButtonsForMode(mode); modeSelect.value = mode; }

    updateModeUI(mode);

    document.getElementById('dpadPanel').style.display = 'none';
    document.getElementById('playbackControls').style.display = 'none';
    document.getElementById('mainControls').style.display = 'flex';
    document.getElementById('recBtn').style.display = 'none';
    document.getElementById('editFrameBtn').innerText = "✂️ 微調整";
    document.getElementById('editFrameBtn').style.background = "var(--accent-orange)";
    document.getElementById('editFrameBtn').style.color = "#000";

    startBtn.click();
}

/**
 * 4面確認・修正画面から「🔍 詳細を見る」（2026-08-25、旧ラベル
 * 「✂️ 微調整」からリネーム）で個別のポーズを開いた後、
 * 「✅ 保存して4面確認へ戻る」で呼ばれる。D-padでの関節点修正はこれまで
 * メモリ上（state.playbackDataMP）でしか反映されず保存し直されていなかった
 * ため、その場限りの修正になってしまっていた。ここで同じセッションIDに
 * 上書き保存してから確認・修正画面へ戻すことで、修正内容が確定後の
 * データにも反映されるようにする。
 */
export async function saveEditsAndReturnToBatchReview(dataService) {
    var mode = state.currentTab;
    var id = state.currentBatchSessionIds[mode];

    if (id && dataService) {
        var sessionImages = {};
        ['front', 'back', 'l_side', 'r_side'].forEach(function (m) {
            if (reportDataStore[m] && reportDataStore[m].capturedImage) sessionImages[m] = reportDataStore[m].capturedImage;
        });
        var sessionData = {
            id: id,
            timestamp: Date.now(),
            patientName: state.activePatientName,
            mode: mode,
            height: parseFloat(heightInput.value) || 170,
            footSize: parseFloat(footSizeInput.value) || 25,
            pelvicTilt: state.estimatedPelvicTilt,
            pxToCmRatio: state.pxToCmRatio,
            // 2026-08-03追加: 他のsaveEditsAndReturn*系と同じ理由(capturedRollDeg/
            // canvasWidth/Height参照)で、4隅ArUco床面ホモグラフィもここで
            // 含め忘れると保存の全置換で消えてしまうため引き継ぐ
            // （js/core/arucoCalibration.js参照）。
            floorHomography: state.floorHomography,
            // 2026-08-03の修正: capturedRollDeg・canvasWidth/Heightをここで
            // 含め忘れると、保存はIDキー全置換（put）のため、この画面を
            // 経由しただけ（何も微調整しなくても）で元の値が消えてしまい、
            // 後で履歴から再生した時に骨格点の生ピクセル座標とcanvasMPの
            // 解像度が食い違って表示がおかしくなる不具合があった
            // （state.activeSessionCapturedRollDeg/CanvasWidth/CanvasHeightは
            // loadSession()がこの画面に入る直前に控えている値）。
            capturedRollDeg: (typeof state.activeSessionCapturedRollDeg === 'number') ? state.activeSessionCapturedRollDeg : null,
            // 2026-08-05追加: 上と全く同じ理由（保存の全置換で消えてしまう
            // のを防ぐ）で、アルコ正中線座標も引き継ぐ
            // （state.activeSessionCapturedArucoMidlineX/Yはloadsession()が
            // 控えている値、js/core/state.jsのコメント参照）。
            capturedArucoMidlineX: (typeof state.activeSessionCapturedArucoMidlineX === 'number') ? state.activeSessionCapturedArucoMidlineX : null,
            capturedArucoMidlineY: (typeof state.activeSessionCapturedArucoMidlineY === 'number') ? state.activeSessionCapturedArucoMidlineY : null,
            canvasWidth: state.activeSessionCanvasWidth || canvasMP.width,
            canvasHeight: state.activeSessionCanvasHeight || canvasMP.height,
            expertComment: state.activeExpertComment,
            expertExercises: state.activeExpertExercises,
            poseData: state.playbackDataMP,
            images: sessionImages,
            // 2026-08-25追加: 他のcapturedRollDeg等と同じ理由（保存の全置換で
            // 消えてしまうのを防ぐ）で、写真の形式（'clean_v1'/旧形式）も
            // loadSession()が控えておいた値のまま引き継ぐ。ここで安易に
            // 'clean_v1'を決め打ちすると、旧形式の写真（骨格線が焼き込み
            // 済み）を微調整・保存し直しただけで新形式扱いになってしまい、
            // 実際は変わっていない写真の上にさらに骨格を重ね描きして二重に
            // 表示されてしまう（js/core/state.jsのactiveSessionPhotoFormat
            // コメント参照）。
            photoFormat: state.activeSessionPhotoFormat || null,
            // 保存はIDをキーにした全置換（IndexedDBのput）のため、ここで
            // batchIdを含め忘れると、撮影時に発行された4面まとめ表示用の
            // 目印が消えてしまう。loadSession()が控えておいた値を引き継ぐ。
            batchId: state.activeSessionBatchId || null,
            status: 'draft'
        };
        try {
            await dataService.saveSession(sessionData);
        } catch (e) {
            console.error('[controls] Failed to save pose edits:', e);
            alert('修正内容の保存に失敗しました。通信状態をご確認のうえ、もう一度お試しください。');
        }
    }

    if (state.playbackRafId) { cancelAnimationFrame(state.playbackRafId); state.playbackRafId = null; }
    state.appMode = "camera";
    state.isPausedForEdit = false;
    state.isPlaying = false;
    state.selectedJointIndex = null;
    state.isEditingPlaybackFrame = false;
    state.isHistoryPlaybackSession = false;
    state.editReturnTarget = null;

    document.getElementById('dpadPanel').style.display = 'none';
    document.getElementById('playbackControls').style.display = 'none';
    document.getElementById('editFrameBtn').innerText = "✂️ 微調整";
    document.getElementById('editFrameBtn').style.background = "var(--accent-orange)";
    document.getElementById('editFrameBtn').style.color = "#000";

    updateReviewLayoutMode();
    if (window.__showBatchReviewScreen) window.__showBatchReviewScreen();
}

/**
 * 履歴の「4面まとめ」画面（すでに確定済みのデータ）から個別ポーズを
 * 微調整して戻る版。saveEditsAndReturnToBatchReview（撮影直後・未確定の
 * 4面確認画面用）とほぼ同じだが、こちらはstatusを'draft'に戻さない
 * （すでに確定済みのデータを閲覧・修正しているだけなので、確定状態を
 * 維持したまま履歴一覧に出続けるようにする）。
 * 元のstatus（loadSession()がstate.activeSessionStatusに控えている）を
 * そのまま維持する（'final'を決め打ちすると、万一まだdraftのままの
 * セッションをここ経由で開いた場合に誤って確定させてしまうため。
 * saveEditsAndReturnToDynConfirmHistoryと同じ考え方）。
 */
export async function saveEditsAndReturnToHistoryBatch(dataService) {
    var id = state.activeSessionId;

    if (id && dataService) {
        var sessionImages = {};
        ['front', 'back', 'l_side', 'r_side'].forEach(function (m) {
            if (reportDataStore[m] && reportDataStore[m].capturedImage) sessionImages[m] = reportDataStore[m].capturedImage;
        });
        var sessionData = {
            id: id,
            timestamp: Date.now(),
            patientName: state.activePatientName,
            mode: state.currentTab,
            height: parseFloat(heightInput.value) || 170,
            footSize: parseFloat(footSizeInput.value) || 25,
            pelvicTilt: state.estimatedPelvicTilt,
            pxToCmRatio: state.pxToCmRatio,
            // 2026-08-03追加: 他のsaveEditsAndReturn*系と同じ理由(capturedRollDeg/
            // canvasWidth/Height参照)で、4隅ArUco床面ホモグラフィもここで
            // 含め忘れると保存の全置換で消えてしまうため引き継ぐ
            // （js/core/arucoCalibration.js参照）。
            floorHomography: state.floorHomography,
            // 2026-08-03の修正: 他のsaveEditsAndReturn*系と同じ理由で、
            // capturedRollDeg・canvasWidth/Heightをここで含め忘れると
            // 保存の全置換で消えてしまうため引き継ぐ。
            capturedRollDeg: (typeof state.activeSessionCapturedRollDeg === 'number') ? state.activeSessionCapturedRollDeg : null,
            // 2026-08-05追加: 上と全く同じ理由（保存の全置換で消えてしまう
            // のを防ぐ）で、アルコ正中線座標も引き継ぐ
            // （state.activeSessionCapturedArucoMidlineX/Yはloadsession()が
            // 控えている値、js/core/state.jsのコメント参照）。
            capturedArucoMidlineX: (typeof state.activeSessionCapturedArucoMidlineX === 'number') ? state.activeSessionCapturedArucoMidlineX : null,
            capturedArucoMidlineY: (typeof state.activeSessionCapturedArucoMidlineY === 'number') ? state.activeSessionCapturedArucoMidlineY : null,
            canvasWidth: state.activeSessionCanvasWidth || canvasMP.width,
            canvasHeight: state.activeSessionCanvasHeight || canvasMP.height,
            expertComment: state.activeExpertComment,
            expertExercises: state.activeExpertExercises,
            poseData: state.playbackDataMP,
            images: sessionImages,
            // 2026-08-25追加: 他のcapturedRollDeg等と同じ理由でphotoFormatも
            // loadSession()が控えておいた値のまま引き継ぐ（js/core/state.jsの
            // activeSessionPhotoFormatコメント参照）。
            photoFormat: state.activeSessionPhotoFormat || null,
            batchId: state.activeSessionBatchId || null,
            status: state.activeSessionStatus || 'final'
        };
        try {
            await dataService.saveSession(sessionData);
        } catch (e) {
            console.error('[controls] Failed to save pose edits (history batch):', e);
            alert('修正内容の保存に失敗しました。通信状態をご確認のうえ、もう一度お試しください。');
        }
    }

    if (state.playbackRafId) { cancelAnimationFrame(state.playbackRafId); state.playbackRafId = null; }
    state.appMode = "camera";
    state.isPausedForEdit = false;
    state.isPlaying = false;
    state.selectedJointIndex = null;
    state.isEditingPlaybackFrame = false;
    state.isHistoryPlaybackSession = false;
    state.editReturnTarget = null;

    document.getElementById('dpadPanel').style.display = 'none';
    document.getElementById('playbackControls').style.display = 'none';
    document.getElementById('editFrameBtn').innerText = "✂️ 微調整";
    document.getElementById('editFrameBtn').style.background = "var(--accent-orange)";
    document.getElementById('editFrameBtn').style.color = "#000";

    updateReviewLayoutMode();
    if (typeof window.refreshHistoryList === 'function') window.refreshHistoryList();
    if (window.__showHistoryBatchView) window.__showHistoryBatchView();
}

/**
 * 動作解析（動的種目）の撮影確認画面(js/ui/dynConfirm.js)から「🔍 確認」で
 * 個別のポーズを開いた後、「✅ 保存して確認画面へ戻る」で呼ばれる。
 * saveEditsAndReturnToBatchReviewとほぼ同じだが、静止4方向のような
 * 4面まとめの概念（batchId・4面共通のsessionImages収集）を持たないため、
 * このモード1件分だけを対象にする。撮影確認画面へ戻るまでは未確定のため
 * status: 'draft'のまま（js/core/recorder.js参照）。
 */
export async function saveEditsAndReturnToDynConfirm(dataService) {
    var mode = state.currentTab;
    var id = state.activeSessionId;

    if (id && dataService) {
        var sessionImages = {};
        if (reportDataStore[mode] && reportDataStore[mode].capturedImage) sessionImages[mode] = reportDataStore[mode].capturedImage;
        var sessionData = {
            id: id,
            timestamp: Date.now(),
            patientName: state.activePatientName,
            mode: mode,
            height: parseFloat(heightInput.value) || 170,
            footSize: parseFloat(footSizeInput.value) || 25,
            pelvicTilt: state.estimatedPelvicTilt,
            pxToCmRatio: state.pxToCmRatio,
            // 2026-08-03追加: 他のsaveEditsAndReturn*系と同じ理由(capturedRollDeg/
            // canvasWidth/Height参照)で、4隅ArUco床面ホモグラフィもここで
            // 含め忘れると保存の全置換で消えてしまうため引き継ぐ
            // （js/core/arucoCalibration.js参照）。
            floorHomography: state.floorHomography,
            // 2026-08-03の修正: 他のsaveEditsAndReturn*系と同じ理由で、
            // capturedRollDeg・canvasWidth/Heightをここで含め忘れると
            // 保存の全置換で消えてしまうため引き継ぐ（重心動揺モードで、
            // 未確定のまま確認画面を一度見ただけで棒人間が表示されなくなる
            // 不具合の原因だった）。
            capturedRollDeg: (typeof state.activeSessionCapturedRollDeg === 'number') ? state.activeSessionCapturedRollDeg : null,
            // 2026-08-05追加: 上と全く同じ理由（保存の全置換で消えてしまう
            // のを防ぐ）で、アルコ正中線座標も引き継ぐ
            // （state.activeSessionCapturedArucoMidlineX/Yはloadsession()が
            // 控えている値、js/core/state.jsのコメント参照）。
            capturedArucoMidlineX: (typeof state.activeSessionCapturedArucoMidlineX === 'number') ? state.activeSessionCapturedArucoMidlineX : null,
            capturedArucoMidlineY: (typeof state.activeSessionCapturedArucoMidlineY === 'number') ? state.activeSessionCapturedArucoMidlineY : null,
            canvasWidth: state.activeSessionCanvasWidth || canvasMP.width,
            canvasHeight: state.activeSessionCanvasHeight || canvasMP.height,
            expertComment: state.activeExpertComment,
            expertExercises: state.activeExpertExercises,
            poseData: state.playbackDataMP,
            images: sessionImages,
            // 2026-08-25追加: 他のcapturedRollDeg等と同じ理由でphotoFormatも
            // loadSession()が控えておいた値のまま引き継ぐ（js/core/state.jsの
            // activeSessionPhotoFormatコメント参照）。
            photoFormat: state.activeSessionPhotoFormat || null,
            batchId: null,
            status: 'draft'
        };
        try {
            await dataService.saveSession(sessionData);
        } catch (e) {
            console.error('[controls] Failed to save dynamic-mode edits:', e);
            alert('修正内容の保存に失敗しました。通信状態をご確認のうえ、もう一度お試しください。');
        }
    }

    if (state.playbackRafId) { cancelAnimationFrame(state.playbackRafId); state.playbackRafId = null; }
    state.appMode = "camera";
    state.isPausedForEdit = false;
    state.isPlaying = false;
    state.selectedJointIndex = null;
    state.isEditingPlaybackFrame = false;
    state.isHistoryPlaybackSession = false;
    state.editReturnTarget = null;

    document.getElementById('dpadPanel').style.display = 'none';
    document.getElementById('playbackControls').style.display = 'none';
    document.getElementById('editFrameBtn').innerText = "✂️ 微調整";
    document.getElementById('editFrameBtn').style.background = "var(--accent-orange)";
    document.getElementById('editFrameBtn').style.color = "#000";

    updateReviewLayoutMode();
    if (window.__showDynConfirmScreen) window.__showDynConfirmScreen();
}

/**
 * 動作解析（動的種目）を履歴一覧経由で開いた確認画面(js/ui/dynConfirm.js、
 * historyモード)から「🔍 確認」で個別のポーズを開いた後、「✅ 保存して
 * 確認画面へ戻る」で呼ばれる。saveEditsAndReturnToDynConfirmとほぼ同じだが、
 * こちらはすでに確定済み(またはdraftの)既存データを開き直しているだけなので、
 * 元のstatus（loadSession()がstate.activeSessionStatusに控えている）を
 * そのまま維持する点（saveEditsAndReturnToHistoryBatchと同じ考え方）。
 */
export async function saveEditsAndReturnToDynConfirmHistory(dataService) {
    var mode = state.currentTab;
    var id = state.activeSessionId;

    if (id && dataService) {
        var sessionImages = {};
        if (reportDataStore[mode] && reportDataStore[mode].capturedImage) sessionImages[mode] = reportDataStore[mode].capturedImage;
        var sessionData = {
            id: id,
            timestamp: Date.now(),
            patientName: state.activePatientName,
            mode: mode,
            height: parseFloat(heightInput.value) || 170,
            footSize: parseFloat(footSizeInput.value) || 25,
            pelvicTilt: state.estimatedPelvicTilt,
            pxToCmRatio: state.pxToCmRatio,
            // 2026-08-03追加: 他のsaveEditsAndReturn*系と同じ理由(capturedRollDeg/
            // canvasWidth/Height参照)で、4隅ArUco床面ホモグラフィもここで
            // 含め忘れると保存の全置換で消えてしまうため引き継ぐ
            // （js/core/arucoCalibration.js参照）。
            floorHomography: state.floorHomography,
            // 2026-08-03の修正: 他のsaveEditsAndReturn*系と同じ理由で、
            // capturedRollDeg・canvasWidth/Heightをここで含め忘れると
            // 保存の全置換で消えてしまうため引き継ぐ（重心動揺モードで、
            // 確定後に履歴から開き直すと棒人間が表示されなくなる不具合の
            // 直接の原因だった。ここを経由しなくても確定はできるため、
            // 「未確定の間は表示される」という報告と一致する）。
            capturedRollDeg: (typeof state.activeSessionCapturedRollDeg === 'number') ? state.activeSessionCapturedRollDeg : null,
            // 2026-08-05追加: 上と全く同じ理由（保存の全置換で消えてしまう
            // のを防ぐ）で、アルコ正中線座標も引き継ぐ
            // （state.activeSessionCapturedArucoMidlineX/Yはloadsession()が
            // 控えている値、js/core/state.jsのコメント参照）。
            capturedArucoMidlineX: (typeof state.activeSessionCapturedArucoMidlineX === 'number') ? state.activeSessionCapturedArucoMidlineX : null,
            capturedArucoMidlineY: (typeof state.activeSessionCapturedArucoMidlineY === 'number') ? state.activeSessionCapturedArucoMidlineY : null,
            canvasWidth: state.activeSessionCanvasWidth || canvasMP.width,
            canvasHeight: state.activeSessionCanvasHeight || canvasMP.height,
            expertComment: state.activeExpertComment,
            expertExercises: state.activeExpertExercises,
            poseData: state.playbackDataMP,
            images: sessionImages,
            // 2026-08-25追加: 他のcapturedRollDeg等と同じ理由でphotoFormatも
            // loadSession()が控えておいた値のまま引き継ぐ（js/core/state.jsの
            // activeSessionPhotoFormatコメント参照）。
            photoFormat: state.activeSessionPhotoFormat || null,
            batchId: null,
            status: state.activeSessionStatus || 'final'
        };
        try {
            await dataService.saveSession(sessionData);
        } catch (e) {
            console.error('[controls] Failed to save dynamic-mode edits (history):', e);
            alert('修正内容の保存に失敗しました。通信状態をご確認のうえ、もう一度お試しください。');
        }
    }

    if (state.playbackRafId) { cancelAnimationFrame(state.playbackRafId); state.playbackRafId = null; }
    state.appMode = "camera";
    state.isPausedForEdit = false;
    state.isPlaying = false;
    state.selectedJointIndex = null;
    state.isEditingPlaybackFrame = false;
    state.isHistoryPlaybackSession = false;
    state.editReturnTarget = null;

    document.getElementById('dpadPanel').style.display = 'none';
    document.getElementById('playbackControls').style.display = 'none';
    document.getElementById('editFrameBtn').innerText = "✂️ 微調整";
    document.getElementById('editFrameBtn').style.background = "var(--accent-orange)";
    document.getElementById('editFrameBtn').style.color = "#000";

    updateReviewLayoutMode();
    if (typeof window.refreshHistoryList === 'function') window.refreshHistoryList();
    if (window.__showDynConfirmHistoryView) window.__showDynConfirmHistoryView();
}

// ---------------------------------------------------------------------------
// D-pad（関節点の微調整）
// ---------------------------------------------------------------------------

function moveJoint(dx, dy) {
    if (state.calibState === "adjust_left" && state.calibrationPoints[0]) {
        state.calibrationPoints[0].x += dx; state.calibrationPoints[0].y += dy;
    } else if (state.calibState === "adjust_right" && state.calibrationPoints[1]) {
        state.calibrationPoints[1].x += dx; state.calibrationPoints[1].y += dy;
    } else if (state.selectedJointIndex !== null) {
        var kp = null;
        if (state.appMode === 'playback') {
            var fIdx = parseInt(document.getElementById('timelineSlider').value);
            if (state.playbackDataMP[fIdx]) {
                if (state.selectedJointIndex === 33) kp = state.playbackDataMP[fIdx].keypoints.find(function (k) { return k.name === 'virtual_asis_l'; });
                else if (state.selectedJointIndex === 34) kp = state.playbackDataMP[fIdx].keypoints.find(function (k) { return k.name === 'virtual_asis_r'; });
                else kp = state.playbackDataMP[fIdx].keypoints[state.selectedJointIndex];
            }
        } else if (state.isPausedForEdit) {
            if (state.selectedJointIndex === 33) kp = reportDataStore[state.currentTab].find(function (k) { return k.name === 'virtual_asis_l'; });
            else if (state.selectedJointIndex === 34) kp = reportDataStore[state.currentTab].find(function (k) { return k.name === 'virtual_asis_r'; });
            else kp = reportDataStore[state.currentTab][state.selectedJointIndex];
        }
        if (kp) { kp.x += dx; kp.y += dy; }
    }

    if (state.appMode === 'playback') {
        renderPlaybackFrame(parseInt(document.getElementById('timelineSlider').value));
    } else if (state.isPausedForEdit) {
        refreshReportView();
    }
}

function closeDpad() {
    if (state.calibState === "adjust_left") {
        state.calibState = "wait_left";
        document.getElementById('calibrateMatBtn').innerText = "📍 左端をタップ";
        state.calibrationPoints = [];
        document.getElementById('dpadPanel').style.display = 'none';
        if (state.isPausedForEdit) refreshReportView();
        return;
    }
    if (state.calibState === "adjust_right") {
        state.calibState = "wait_right";
        document.getElementById('calibrateMatBtn').innerText = "📍 右端をタップ";
        state.calibrationPoints.pop();
        document.getElementById('dpadPanel').style.display = 'none';
        if (state.isPausedForEdit) refreshReportView();
        return;
    }
    state.selectedJointIndex = null;
    document.getElementById('dpadPanel').style.display = 'none';
    if (state.appMode === 'playback') {
        renderPlaybackFrame(parseInt(document.getElementById('timelineSlider').value));
    } else if (state.isPausedForEdit) {
        refreshReportView();
    }
}

// ---------------------------------------------------------------------------
// 初期化: 各種イベント配線
// ---------------------------------------------------------------------------

export function initControlsUI() {
    // AIモデル読込完了を待たず、起動直後から現在のカテゴリ（デフォルトは
    // 静止姿勢）に応じた「測定モード」欄の表示/非表示を確定させておく
    updateModeSelectVisibility(state.currentCategory);

    var toggleUiBtn = document.getElementById('toggleUiBtn');
    if (toggleUiBtn) {
        toggleUiBtn.onclick = function () {
            var settings = document.getElementById('settingsWrapper');
            if (settings) {
                if (settings.style.display === 'none') { settings.style.display = 'flex'; toggleUiBtn.innerText = '🔽 UIを隠す'; }
                else { settings.style.display = 'none'; toggleUiBtn.innerText = '🔼 UIを表示'; }
            }
        };
    }

    // 通常撮影/セルフ撮影は撮影設定カード内で事前に選んでおく方式にしたため、
    // カメラ未起動の設定画面で選ぶだけでよい（起動中の切替はサポートしない＝
    // 変更したい場合は「◀ モード選択に戻る」で設定に戻ってから選び直す）。
    var setupNormalShootBtn = document.getElementById('setupNormalShootBtn');
    var setupSelfieShootBtn = document.getElementById('setupSelfieShootBtn');
    function setCameraFacingMode(mode) {
        state.cameraFacingMode = mode; // "environment" | "user"
        state.isSelfie = (mode === "user");
        updateCameraModeBadge();
        if (state.isRunning) startBtn.click(); // 撮影中の変更にも一応対応しておく
    }
    if (setupNormalShootBtn) setupNormalShootBtn.onclick = function () { setCameraFacingMode("environment"); };
    if (setupSelfieShootBtn) setupSelfieShootBtn.onclick = function () { setCameraFacingMode("user"); };

    // カメラの向き（縦置き設置時の回転補正、2026-08-04追加）。撮影スタイルと
    // 同じく、カメラ未起動の設定画面で事前に選んでおく方式にする
    // （js/core/state.jsのcameraRotationDeg定義コメント、js/core/camera.jsの
    // getUprightVideoFrame()参照）。
    var setupOrientNormalBtn = document.getElementById('setupOrientNormalBtn');
    var setupOrientCwBtn = document.getElementById('setupOrientCwBtn');
    var setupOrientCcwBtn = document.getElementById('setupOrientCcwBtn');
    function setCameraRotation(deg) {
        state.cameraRotationDeg = deg; // 0 | 90 | -90
        if (setupOrientNormalBtn) setupOrientNormalBtn.classList.toggle('active', deg === 0);
        if (setupOrientCwBtn) setupOrientCwBtn.classList.toggle('active', deg === 90);
        if (setupOrientCcwBtn) setupOrientCcwBtn.classList.toggle('active', deg === -90);
        // 撮影中に向きを変えた場合も、カメラを再起動してキャンバスサイズ
        // （幅高さ入れ替え）から作り直す（撮影スタイル切替と同じ考え方）。
        if (state.isRunning) startBtn.click();
    }
    if (setupOrientNormalBtn) setupOrientNormalBtn.onclick = function () { setCameraRotation(0); };
    if (setupOrientCwBtn) setupOrientCwBtn.onclick = function () { setCameraRotation(90); };
    if (setupOrientCcwBtn) setupOrientCcwBtn.onclick = function () { setCameraRotation(-90); };

    var modeSelect = document.getElementById('modeSelect');
    if (modeSelect) modeSelect.onchange = function (e) { updateModeUI(e.target.value); };

    var tabStaticBtn = document.getElementById('tabStaticBtn');
    var tabSwayBtn = document.getElementById('tabSwayBtn');
    var tabDynamicBtn = document.getElementById('tabDynamicBtn');
    if (tabStaticBtn) tabStaticBtn.onclick = function () { switchAnalysisTab('static'); };
    if (tabSwayBtn) tabSwayBtn.onclick = function () { switchAnalysisTab('sway'); };
    if (tabDynamicBtn) tabDynamicBtn.onclick = function () { switchAnalysisTab('dynamic'); };

    document.getElementById('dpadStep').onclick = function (e) {
        state.dpadStepVal = state.dpadStepVal === 1 ? 5 : 1;
        e.target.innerText = state.dpadStepVal + 'px';
    };
    document.getElementById('dpadUp').onclick = function () { moveJoint(0, -state.dpadStepVal); };
    document.getElementById('dpadDown').onclick = function () { moveJoint(0, state.dpadStepVal); };
    document.getElementById('dpadLeft').onclick = function () { moveJoint(-state.dpadStepVal, 0); };
    document.getElementById('dpadRight').onclick = function () { moveJoint(state.dpadStepVal, 0); };
    document.getElementById('dpadClose').onclick = closeDpad;

    canvasMP.onclick = function (e) {
        var rect = canvasMP.getBoundingClientRect();
        var clickX = (e.clientX - rect.left) * (canvasMP.width / rect.width);
        var clickY = (e.clientY - rect.top) * (canvasMP.height / rect.height);

        if (state.calibState === "wait_left") {
            state.calibrationPoints[0] = { x: clickX, y: clickY };
            state.calibState = "adjust_left";
            document.getElementById('calibrateMatBtn').innerText = "📍 左端調整中...";
            state.selectedJointIndex = null;
            document.getElementById('dpadPanel').style.display = 'block';
            return;
        }
        if (state.calibState === "wait_right") {
            state.calibrationPoints[1] = { x: clickX, y: clickY };
            state.calibState = "adjust_right";
            document.getElementById('calibrateMatBtn').innerText = "📍 右端調整中...";
            state.selectedJointIndex = null;
            document.getElementById('dpadPanel').style.display = 'block';
            return;
        }
        if (state.calibState === "adjust_left" || state.calibState === "adjust_right") return;

        if (state.isPausedForEdit || (state.appMode === 'playback' && state.isEditingPlaybackFrame)) {
            var kps = null;
            if (state.appMode === 'playback') {
                var fIdx = parseInt(document.getElementById('timelineSlider').value);
                if (state.playbackDataMP[fIdx]) kps = state.playbackDataMP[fIdx].keypoints;
            } else {
                kps = reportDataStore[state.currentTab];
            }
            if (!kps) return;

            var closestIdx = null;
            var minDist = 30.0;
            kps.forEach(function (kp, idx) {
                if (kp && kp.score > 0.1) {
                    var displayIdx = idx;
                    if (kp.name === 'virtual_asis_l') displayIdx = 33;
                    if (kp.name === 'virtual_asis_r') displayIdx = 34;
                    var dist = Math.hypot(kp.x - clickX, kp.y - clickY);
                    if (dist < minDist) { minDist = dist; closestIdx = displayIdx; }
                }
            });

            if (closestIdx !== null) {
                state.selectedJointIndex = closestIdx;
                var jpName = JOINT_NAMES_JP[state.selectedJointIndex] || "関節点 " + state.selectedJointIndex;
                document.querySelector('#dpadPanel .dpad-header span').innerText = "🎯 微調整: " + jpName;
                document.getElementById('dpadPanel').style.display = 'block';

                if (state.appMode === 'playback') renderPlaybackFrame(parseInt(document.getElementById('timelineSlider').value));
                else refreshReportView();
            }
        }
    };

    document.getElementById('editFrameBtn').onclick = function () {
        if (!state.isEditingPlaybackFrame) {
            togglePlay(false);
            state.isEditingPlaybackFrame = true;
            this.innerText = "✅ 編集完了";
            this.style.background = "var(--accent-green)";
            this.style.color = "#000";
        } else {
            state.isEditingPlaybackFrame = false;
            this.innerText = "✂️ 微調整";
            this.style.background = "var(--accent-orange)";
            this.style.color = "#000";
            closeDpad();
        }
    };

    document.getElementById('playPauseBtn').onclick = function () { togglePlay(); };
    document.getElementById('backToCamBtn').onclick = function () { exitPlaybackMode(); };
    document.getElementById('timelineSlider').oninput = function () {
        togglePlay(false);
        renderPlaybackFrame(parseInt(document.getElementById('timelineSlider').value));
    };

    // 再生スピード（0.25/0.5/1/2倍）。再生中に変更した場合は、その瞬間の
    // フレーム位置を基準に再生開始時刻を取り直すことで、速度切替時に
    // 表示がガクッと飛ばないようにする。
    var speedSelect = document.getElementById('playbackSpeedSelect');
    if (speedSelect) {
        speedSelect.onchange = function () {
            if (state.isPlaying) {
                var slider = document.getElementById('timelineSlider');
                state.playbackStartFrame = parseInt(slider.value);
                state.playbackStartTime = Date.now();
            }
            state.playbackSpeed = parseFloat(speedSelect.value) || 1;
        };
    }

    // 微調整画面の「写真を背景に表示」トグル。静止4方向のみ対象
    // （表示可否・disabled切替はupdateModeUI側で行う）。
    var togglePhotoBgBtn = document.getElementById('togglePhotoBgBtn');
    if (togglePhotoBgBtn) {
        togglePhotoBgBtn.onclick = function () {
            state.showPhotoBackground = !state.showPhotoBackground;
            togglePhotoBgBtn.innerText = state.showPhotoBackground ? "🦴 骨格のみ表示" : "🖼 写真を表示";
            if (state.appMode === 'playback') {
                renderPlaybackFrame(parseInt(document.getElementById('timelineSlider').value));
            }
        };
    }

    var nextMeasureBtn = document.getElementById('nextMeasureBtn');
    if (nextMeasureBtn) {
        nextMeasureBtn.onclick = function () {
            var speakGuidanceFn = window.__speakGuidance || null;
            advanceToNextMeasurement(speakGuidanceFn);
        };
    }
}
