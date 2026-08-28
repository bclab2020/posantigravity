/**
 * specialist.js
 * ---------------------------------------------------------------------------
 * 専門家（理学療法士・トレーナー等）向けのログイン/ログアウト、
 * 選手データのJSONインポート/エクスポート、専門家カルテ（評価コメント・
 * 処方メニュー）の保存を担当。
 *
 * 旧版はID/PASSをコード内にハードコードしていたが（specialist / athletecore2026）、
 * 新版はFirebase Authenticationの実アカウント（メール＋パスワード）に置き換えた。
 * specialists/{uid} ドキュメントを持つアカウントのみ専門家権限を得る
 * （ドキュメント自体はFirebaseコンソールから事前作成する。SETUP.md参照）。
 */

import { state, reportDataStore, getEffectiveArucoMidlineX } from '../core/state.js';
import { patientNameInput, heightInput, footSizeInput, importJsonGroup, exportSessionJsonBtn, importSessionJson } from '../core/dom.js';
import { updateModeUI, togglePlay, renderPlaybackFrame } from './controls.js';
import { navigate } from './router.js';
import apiManager from '../api.js';

export function updateAuthUI() {
    // #appHeaderTitle はライブビューを整理する際に撮影画面から撤去済み
    // （ロゴは会員登録/ログインモーダル側に移設）。要素自体がDOMに存在しない
    // ため、ここで無条件に .innerHTML を書き込むと null 参照で例外になり、
    // boot()のawaitチェーンがここで止まってinitRouter()以降(ナビ/ホームカードの
    // イベント配線含む)が一切実行されなくなってしまっていた。存在する場合だけ
    // 更新するようにガードする。
    var titleLabel = document.getElementById('appHeaderTitle');
    if (state.isSpecialist) {
        document.body.classList.add('specialist-unlocked');
        document.getElementById('modeUnlockBtn').style.display = 'none';
        document.getElementById('logoutBtn').style.display = 'flex';
        importJsonGroup.style.display = 'flex';
        exportSessionJsonBtn.style.display = 'inline-block';
        if (titleLabel) titleLabel.innerHTML = 'ATHLETECORE PRO <span class="badge" style="background:var(--accent-orange); color:#000;">Specialist Portal</span>';
    } else {
        document.body.classList.remove('specialist-unlocked');
        document.getElementById('modeUnlockBtn').style.display = 'flex';
        document.getElementById('logoutBtn').style.display = 'none';
        importJsonGroup.style.display = 'none';
        exportSessionJsonBtn.style.display = 'none';
        if (titleLabel) titleLabel.innerHTML = 'ÉLITE PERFORMANCE <span class="badge">Precision in Motion</span>';
    }
}

export function initSpecialistUI(dataService) {
    var modeUnlockBtn = document.getElementById('modeUnlockBtn');
    var logoutBtn = document.getElementById('logoutBtn');
    var specialistLoginModal = document.getElementById('specialistLoginModal');
    var closeLoginBtn = document.getElementById('closeLoginBtn');
    var submitLoginBtn = document.getElementById('submitLoginBtn');
    var specialistEmailInput = document.getElementById('specialistEmailInput');
    var specialistPassInput = document.getElementById('specialistPassInput');
    var loginErrorMsg = document.getElementById('loginErrorMsg');

    modeUnlockBtn.onclick = function () {
        loginErrorMsg.style.display = 'none';
        specialistPassInput.value = '';
        specialistLoginModal.style.display = 'block';
    };

    closeLoginBtn.onclick = function () { specialistLoginModal.style.display = 'none'; };

    submitLoginBtn.onclick = async function () {
        var email = specialistEmailInput.value.trim();
        var pass = specialistPassInput.value.trim();

        if (!dataService.isCloudEnabled()) {
            loginErrorMsg.innerText = "⚠️ Firebaseが未設定のため専門家ログインは利用できません（SETUP.md参照）。";
            loginErrorMsg.style.display = 'block';
            return;
        }

        submitLoginBtn.disabled = true;
        try {
            await dataService.loginSpecialist(email, pass);
            state.isSpecialist = true;
            specialistLoginModal.style.display = 'none';
            updateAuthUI();
            alert("専門家認証に成功しました。選手データ一覧（履歴）を表示します。");
            navigate('history');
        } catch (e) {
            loginErrorMsg.innerText = "⚠️ " + (e && e.message ? e.message : "IDまたはパスワードが正しくありません。");
            loginErrorMsg.style.display = 'block';
        } finally {
            submitLoginBtn.disabled = false;
        }
    };

    logoutBtn.onclick = async function () {
        await dataService.logout();
        state.isSpecialist = false;
        updateAuthUI();
        alert("ログアウトしました。アスリートモードに戻ります。");
        if (state.appMode === 'playback') {
            var controls = await import('./controls.js');
            controls.exitPlaybackMode();
        }
        navigate('home');
    };

    // JSON インポート
    importSessionJson.onchange = function (event) {
        var file = event.target.files[0];
        if (!file) return;

        var reader = new FileReader();
        reader.onload = function (e) {
            try {
                var data = JSON.parse(e.target.result);
                if (!data.poseData || data.poseData.length === 0) throw new Error("無効なセッションデータ構造です。");

                state.activeSessionId = data.id || "sess_" + Date.now();
                state.activePatientName = data.patientName || "ゲスト";
                patientNameInput.value = state.activePatientName;

                state.poseDataLog = data.poseData;
                state.playbackDataMP = state.poseDataLog;
                state.pxToCmRatio = data.pxToCmRatio || null;
                state.floorHomography = data.floorHomography || null;
                // 2026-08-05追加: 研究機関向け「静止姿勢: アルコ正中線モード」。
                // pxToCmRatio/floorHomographyと同じ考え方。
                state.arucoMidlineX = (typeof data.capturedArucoMidlineX === 'number') ? data.capturedArucoMidlineX : null;
                state.arucoMidlineY = (typeof data.capturedArucoMidlineY === 'number') ? data.capturedArucoMidlineY : null;
                state.useArucoMidline = typeof data.capturedArucoMidlineX === 'number';
                // 2026-08-05追加（不具合修正）: 静止4方向のroll補正（v4.6.20）を
                // js/ui/dashboard.jsのactiveSessionが読むようになったことに
                // 伴い、JSONインポート経路でも同じ考え方で揃える。旧形式の
                // JSON（この3項目を持たない）はtypeofチェックでnullに
                // フォールバックし、従来通りの無補正表示になる。
                state.activeSessionCapturedRollDeg = (typeof data.capturedRollDeg === 'number') ? data.capturedRollDeg : null;
                state.activeSessionCanvasWidth = data.canvasWidth || null;
                state.activeSessionCanvasHeight = data.canvasHeight || null;
                state.estimatedPelvicTilt = data.pelvicTilt || 0;

                heightInput.value = data.height || 170;
                footSizeInput.value = data.footSize || 25;

                state.activeExpertComment = data.expertComment || "";
                state.activeExpertExercises = data.expertExercises || "";

                if (state.playbackDataMP.length > 1) {
                    state.playbackBaseTime = state.playbackDataMP[0].time;
                    state.playbackTotalDuration = state.playbackDataMP[state.playbackDataMP.length - 1].time - state.playbackBaseTime;
                } else {
                    state.playbackBaseTime = 0;
                    state.playbackTotalDuration = 0;
                }

                var maxFrames = state.playbackDataMP.length - 1;
                document.getElementById('timelineSlider').max = maxFrames > 0 ? maxFrames : 0;
                document.getElementById('timelineSlider').value = 0;

                // history.jsのloadSession()と同様、1件だけをピンポイントで
                // 読み込んで確認している状態として扱う（静止ポーズでも
                // 再生・微調整・書き出し系ツールを常に表示するため）。
                state.isHistoryPlaybackSession = true;
                state.editReturnTarget = 'history';
                state.appMode = 'playback';
                updateModeUI(data.mode || "front");

                document.getElementById('mainControls').style.display = 'none';
                document.getElementById('playbackControls').style.display = 'flex';
                document.getElementById('downloadCsvBtn').disabled = false;

                // js/ui/history.jsのloadSession()と同じ理由で自動再生はしない
                // （v4.6.18、詳細はそちらのコメント参照）。
                renderPlaybackFrame(0);
                togglePlay(false);
                if (window.__enterShootResultView) window.__enterShootResultView();

                alert("患者データ [" + state.activePatientName + " 様 - " + apiManager.getModeNameJp(state.currentTab) + "] を正常にインポートしました。");
            } catch (err) {
                alert("JSONファイルの解析に失敗しました。ファイルが破損しているか無効な形式です。\nエラー: " + err.message);
            }
        };
        reader.readAsText(file);
        importSessionJson.value = '';
    };

    // JSON エクスポート
    exportSessionJsonBtn.onclick = function () {
        if (state.playbackDataMP.length === 0) {
            alert("書き出しできる測定データがありません。");
            return;
        }

        var sessionData = {
            id: state.activeSessionId || "sess_" + Date.now(),
            timestamp: Date.now(),
            patientName: patientNameInput.value.trim() || "ゲスト",
            mode: state.currentTab,
            height: parseFloat(heightInput.value) || 170,
            footSize: parseFloat(footSizeInput.value) || 25,
            pelvicTilt: state.estimatedPelvicTilt,
            pxToCmRatio: state.pxToCmRatio,
            floorHomography: state.floorHomography,
            // 2026-08-05追加: 研究機関向け「静止姿勢: アルコ正中線モード」。
            // getEffectiveArucoMidlineX()で「トグルON かつ静止4方向 かつ
            // 校正済み」の場合だけ値を含める（state.arucoMidlineX自体は
            // トグルOFFでも校正があれば値を保持し続けるため、素通しすると
            // 使っていないのに値が付く不整合が起こりうる）。
            capturedArucoMidlineX: getEffectiveArucoMidlineX(state.currentTab),
            capturedArucoMidlineY: (getEffectiveArucoMidlineX(state.currentTab) !== null) ? state.arucoMidlineY : null,
            // 2026-08-05追加（不具合修正）: 静止4方向のroll補正（v4.6.20）を
            // js/ui/dashboard.jsのactiveSessionが読むようになったことに
            // 伴い、JSONエクスポートにも含める。state.activeSessionCaptured
            // RollDeg等は、この画面へ辿り着くまでの経路（履歴からの読込・
            // JSONインポート等）が、いま画面に表示されているセッションの
            // 撮影時点の値へ揃えてある前提のステージングフィールド
            // （js/ui/dashboard.js参照）。
            capturedRollDeg: (typeof state.activeSessionCapturedRollDeg === 'number') ? state.activeSessionCapturedRollDeg : null,
            canvasWidth: state.activeSessionCanvasWidth || null,
            canvasHeight: state.activeSessionCanvasHeight || null,
            expertComment: state.activeExpertComment,
            expertExercises: state.activeExpertExercises,
            poseData: state.playbackDataMP
        };

        var jsonStr = JSON.stringify(sessionData, null, 2);
        var blob = new Blob([jsonStr], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = "session_" + sessionData.patientName + "_" + state.currentTab + "_" + Date.now() + ".json";
        a.click();
    };
}

export async function saveExpertComment(dataService) {
    var expComment = document.getElementById('expertCommentInput').value.trim();
    var expExercises = document.getElementById('expertExercisesInput').value.trim();

    state.activeExpertComment = expComment;
    state.activeExpertExercises = expExercises;

    if (state.activeSessionId) {
        try {
            await dataService.saveExpertReview(state.activeSessionId, expComment, expExercises);
            alert("専門家によるアセスメント（カルテ）を保存しました。");
            if (window.prepareAndPrintReport) window.prepareAndPrintReport();
        } catch (e) {
            console.error("Save expert notes failed:", e);
            alert("アセスメントの保存に失敗しました。");
        }
    } else {
        alert("保存対象の測定ログがありません。一度測定を行うか、JSONをインポートしてください。");
    }
}
