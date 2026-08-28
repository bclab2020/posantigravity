/**
 * CONNECT AI - API & Clinical Report Engine
 * Integrates Google Gemini API for advanced biomechanical clinical reports.
 * Falls back to an offline expert rule-based report if no API key is provided.
 */

import { rotateKeypointsForRoll, computeCopOffsetMm } from './biomechanics.js';
import { STATIC_MODES, shouldShowCopRadar } from './core/state.js';

/**
 * 静止4方向（前面/後面/左右側面）専用: 録画バッファの後半区間
 * （js/core/calibration.jsのestimateScaleRatioFromRecordingBuffer()、
 * スケール係数算出と全く同じ考え方）にある複数フレームで、同名の骨格点
 * ごとに座標を平均する。
 *
 * 背景: 荷重左右比率・関節角度は従来「撮影終了時点の最終1フレームのみ」を
 * 使っていたが、①スケール係数はすでに後半区間の複数フレーム平均を採用して
 * おり同じ「数秒間静止姿勢を保持してもらう」撮影設計の中で一貫性が無い、
 * ②姿勢推定（BlazePose）は単一フレームだと多少のブレ（ジッター）が乗る
 * ため、本来動いていないはずの静止姿勢では複数フレームの平均を取る方が
 * 統計的に安定した値が得られる、という2点から、企画者と相談のうえ
 * 変更した（2026-08-19）。動作解析（動的種目）は一連の動きそのものを
 * 撮っているため対象外とし、従来通り最終フレーム（確認済みの代表フレーム）
 * をそのまま使う（呼び出し側でSTATIC_MODESのみに限定して呼んでいる）。
 *
 * 名前の無い点・スコアが0.3以下のフレームはその点の平均対象から除外し、
 * 後半区間で一度も有効な値が取れなかった点は、録画の最終フレームの値へ
 * フォールバックする（従来の単一フレーム方式と同じ完全性を保つため）。
 * 保存済みの実写真（reportDataStore[mode].capturedImage）・骨格オーバーレイ
 * 表示は引き続き最終フレームのスナップショットのままで、この関数の対象は
 * あくまでレポートに載る数値（荷重左右比率）のみ。
 *
 * @param {Array} dataPoints - session.poseData（{time, mode, keypoints}[]）
 * @returns {Array|null} 平均後のキーポイント配列（元の配列・要素は変更しない）。
 *   dataPointsが空ならnull。
 */
function averageKeypointsBackHalf(dataPoints) {
    if (!dataPoints || dataPoints.length === 0) return null;

    var lastFrameKps = dataPoints[dataPoints.length - 1].keypoints || [];
    if (dataPoints.length === 1) return lastFrameKps;

    var firstTime = dataPoints[0].time;
    var lastTime = dataPoints[dataPoints.length - 1].time;
    var midTime = firstTime + (lastTime - firstTime) / 2;

    var latterHalf = dataPoints.filter(function (d) { return d.time >= midTime; });
    if (latterHalf.length === 0) latterHalf = dataPoints;

    return lastFrameKps.map(function (refKp) {
        if (!refKp || !refKp.name) return refKp;
        var sumX = 0, sumY = 0, sumScore = 0, n = 0;
        latterHalf.forEach(function (entry) {
            var frameKps = entry.keypoints || [];
            var kp = frameKps.find(function (k) { return k && k.name === refKp.name; });
            if (kp && typeof kp.x === 'number' && typeof kp.y === 'number' && (typeof kp.score !== 'number' || kp.score > 0.3)) {
                sumX += kp.x; sumY += kp.y; sumScore += (typeof kp.score === 'number' ? kp.score : 0); n++;
            }
        });
        if (n === 0) return refKp;
        return Object.assign({}, refKp, { x: sumX / n, y: sumY / n, score: sumScore / n });
    });
}

var apiManager = {
    /**
     * Generates a clinical report.
     * @param {Object} session - The recorded session data.
     * @param {string} apiKey - The Gemini API key (optional).
     * @returns {Promise<string>} - The clinical report in Markdown format.
     */
    generateReport: async function(session, apiKey) {
        // Prepare biomechanical summaries for the prompt/rules
        var metrics = this.extractMetrics(session);
        var report = "";
        
        if (apiKey && apiKey.trim() !== "") {
            try {
                report = await this.fetchGeminiReport(metrics, apiKey);
            } catch (e) {
                console.error("Gemini API Error, falling back to offline analysis:", e);
                report = this.generateOfflineReport(metrics, "⚠️ [APIエラーによりオフライン生成されました: " + e + "]\n\n");
            }
        } else {
            report = this.generateOfflineReport(metrics);
        }

        // Append expert evaluation if present!
        if (session.expertComment && session.expertComment.trim() !== "") {
            report += `\n\n---\n\n## 👩‍⚕️ 担当専門家・メンターによる評価カルテ\n`;
            report += `**指導者アセスメント**:\n${session.expertComment}\n\n`;
            if (session.expertExercises && session.expertExercises.trim() !== "") {
                report += `**指導者処方リハビリメニュー**:\n${session.expertExercises}\n`;
            }
        }
        return report;
    },

    /**
     * Extracts coordinates, angles, and sway data into a clean analysis structure.
     */
    extractMetrics: function(session) {
        var mode = session.mode;
        var dataPoints = session.poseData || [];
        if (dataPoints.length === 0) return { mode: mode, count: 0 };

        // Basic details
        var result = {
            mode: mode,
            timestamp: session.timestamp,
            height: session.height || 170,
            footSize: session.footSize || 25,
            frameCount: dataPoints.length,
            pelvicTilt: session.pelvicTilt || 0,
            weightBearing: null,
            swayMetrics: null,
            jointAngles: {}
        };

        // Calculate averages or select the representative frame
        // 静止4方向（front/back/l_side/r_side）: 荷重左右比率・関節角度の
        // 元になる骨格点は、録画バッファ後半区間の平均値を使う
        // （averageKeypointsBackHalf()。スケール係数の後半区間平均と同じ考え方。
        // 2026-08-20実装、ユーザー承認済み）。動作解析種目（スクワット等）は
        // 動きの途中経過に意味があるため、従来通り最終フレームのみを使う。
        var lastFrame = dataPoints[dataPoints.length - 1];
        var kps;
        if (STATIC_MODES.indexOf(mode) !== -1) {
            kps = averageKeypointsBackHalf(dataPoints) || lastFrame.keypoints;
        } else {
            kps = lastFrame.keypoints;
        }

        // 静止4方向でジャイロが実際に確認できていた端末は、撮影確定時点の
        // roll角度（session.capturedRollDeg）を記録している。荷重左右比率は
        // 画像のX軸をそのまま左右の基準線として使うため、手持ち撮影で端末が
        // 傾いていると、実際は左右均等でも非対称な数値になってしまう
        // （2026-07-29ご指摘）。ここで逆回転した座標に補正してから、以降の
        // 計算（荷重左右比率）に使う。角度が記録されていない場合
        // （ジャイロ未検出の端末、または動作解析種目）はそのまま無補正。
        if (typeof session.capturedRollDeg === 'number' && session.canvasWidth && session.canvasHeight) {
            kps = rotateKeypointsForRoll(kps, session.capturedRollDeg, session.canvasWidth, session.canvasHeight);
        }

        // 2026-08-05追加: 研究機関向け「静止姿勢: アルコ正中線モード」。
        // session.capturedArucoMidlineX/Yは撮影時点の生のピクセル座標
        // （roll補正前）のため、kpsと同じ座標系で比較できるよう、kpsと
        // 全く同じroll補正を（該当する場合は）この点にも適用してから使う
        // （2026-08-04のArUco×縦置き回転補正での座標系不一致バグと同種の
        // 問題を防ぐため）。
        var arucoMidlineXForCalc = null;
        if (typeof session.capturedArucoMidlineX === 'number' && typeof session.capturedArucoMidlineY === 'number') {
            var arucoMidlinePt = { x: session.capturedArucoMidlineX, y: session.capturedArucoMidlineY };
            if (typeof session.capturedRollDeg === 'number' && session.canvasWidth && session.canvasHeight) {
                arucoMidlinePt = rotateKeypointsForRoll([arucoMidlinePt], session.capturedRollDeg, session.canvasWidth, session.canvasHeight)[0];
            }
            arucoMidlineXForCalc = arucoMidlinePt.x;
        }

        // Extract weight bearing if applicable (from the last frame or average)
        var lAnkle = kps.find(k=>k.name==='left_ankle'||k.name==='27');
        var rAnkle = kps.find(k=>k.name==='right_ankle'||k.name==='28');
        var nose = kps.find(k=>k.name==='nose'||k.name==='0');
        var lSh = kps.find(k=>k.name==='left_shoulder'||k.name==='11');
        var rSh = kps.find(k=>k.name==='right_shoulder'||k.name==='12');
        var lHip = kps.find(k=>k.name==='left_hip'||k.name==='23');
        var rHip = kps.find(k=>k.name==='right_hip'||k.name==='24');

        if (lAnkle && rAnkle && lAnkle.score > 0.3 && rAnkle.score > 0.3) {
            var dPx = rAnkle.x - lAnkle.x;
            if (Math.abs(dPx) > 5) {
                var upperComX = (nose.x * 0.20) + (((lSh.x + rSh.x) / 2) * 0.80);
                var lowerComX = (lHip.x + rHip.x) / 2;
                var totalComX = (upperComX * 0.6) + (lowerComX * 0.4);

                // アルコ正中線モード時は基準点（0%地点ではなく50%地点）を
                // 「両足の中心」からアルコマーカー中心へ差し替える
                // （js/biomechanics.jsのcalculateWeightBearingのライブHUD
                // 表示と全く同じ考え方・同じ式に揃えてある。ライブ表示と
                // 最終レポートの数値が食い違わないようにするため）。
                var calcPct = (comX) => {
                    var pctR = (arucoMidlineXForCalc !== null)
                        ? (50 + ((comX - arucoMidlineXForCalc) / dPx) * 100)
                        : (((comX - lAnkle.x) / dPx) * 100);
                    var pctL = 100 - pctR;
                    return { L: Math.max(0, Math.min(100, pctL)), R: Math.max(0, Math.min(100, pctR)) };
                };
                result.weightBearing = {
                    total: calcPct(totalComX),
                    upper: calcPct(upperComX),
                    lower: calcPct(lowerComX)
                };
                result.usedArucoMidline = arucoMidlineXForCalc !== null;
            }
        }

        // Calculate dynamic specific parameters
        if (mode === 'dyn_overhead') {
            // Knee Valgus/Varus (knee-in/out)
            var calcAngle = (a, b, c) => {
                var ang = Math.abs(Math.atan2(c.y-b.y, c.x-b.x) - Math.atan2(a.y-b.y, a.x-b.x)) * 180 / Math.PI;
                return ang > 180 ? 360 - ang : ang;
            };
            var lKnee = kps.find(k=>k.name==='left_knee'||k.name==='25');
            var rKnee = kps.find(k=>k.name==='right_knee'||k.name==='26');
            if (lHip && lKnee && lAnkle) result.jointAngles.leftKneeAngle = calcAngle(lHip, lKnee, lAnkle);
            if (rHip && rKnee && rAnkle) result.jointAngles.rightKneeAngle = calcAngle(rHip, rKnee, rAnkle);
        } else if (mode === 'dyn_overhead_side') {
            var lKnee = kps.find(k=>k.name==='left_knee'||k.name==='25');
            var rKnee = kps.find(k=>k.name==='right_knee'||k.name==='26');
            var lWrist = kps.find(k=>k.name==='left_wrist'||k.name==='15');
            var rWrist = kps.find(k=>k.name==='right_wrist'||k.name==='16');
            var isLeft = (lSh && rSh && lSh.score > rSh.score);
            var s = isLeft ? lSh : rSh, h = isLeft ? lHip : rHip, k = isLeft ? lKnee : rKnee, a = isLeft ? lAnkle : rAnkle, w = isLeft ? lWrist : rWrist;
            
            if (s && h && k && a) {
                var trunkLean = Math.abs(Math.atan2(s.x - h.x, h.y - s.y) * 180 / Math.PI);
                var kneeAng = Math.abs((Math.atan2(a.y-k.y, a.x-k.x) - Math.atan2(h.y-k.y, h.x-k.x)) * 180 / Math.PI);
                if(kneeAng > 180) kneeAng = 360 - kneeAng;
                result.jointAngles.trunkLean = trunkLean;
                result.jointAngles.kneeFlexion = kneeAng;

                if (w && w.score > 0.3) {
                    var armAng = Math.abs((Math.atan2(w.y-s.y, w.x-s.x) - Math.atan2(h.y-s.y, h.x-s.x)) * 180 / Math.PI);
                    if(armAng > 180) armAng = 360 - armAng;
                    result.jointAngles.shoulderArmAngle = armAng;
                }
            }
        } else if (mode.startsWith('dyn_flex_')) {
            var lKnee = kps.find(k=>k.name==='left_knee'||k.name==='25');
            var isLeft = (lSh && rSh && lSh.score > rSh.score);
            var s = isLeft ? lSh : rSh, h = isLeft ? lHip : rHip, k = isLeft ? lKnee : rKnee;
            if (s && h && k) {
                var hipFlexion = Math.abs(Math.atan2(s.y-h.y, s.x-h.x) - Math.atan2(k.y-h.y, k.x-h.x)) * 180 / Math.PI;
                if(hipFlexion > 180) hipFlexion = 360 - hipFlexion;
                result.jointAngles.hipFlexion = hipFlexion;
            }
        }

        // Calculate COP Sway Metrics if there are multiple frames
        // 2026-08-24追加: 静止4方向のうち正面(front)以外（back/l_side/
        // r_side）はCOP動揺（重心動揺）を評価しない（js/core/state.jsの
        // shouldShowCopRadar参照。企画者からのご要望: 4方向をそれぞれ
        // 個別にCOP評価するのは意味が薄く、ユーザーにも伝わりにくいため）。
        // 重心動揺専用モード(sway)・動作解析(dyn_*)は従来通り対象。
        //
        // 2026-08-24追加（単位統一）: 従来は「4隅ArUco床面実測のmm値」と
        // 「簡易推定のpx/%値」を二重表記していたが、企画者から「できれば
        // すべてmmで統一したい」とのご要望があり、常にmm単位1本にまとめる。
        // 4隅ArUco床面キャリブレーション済み（floorHomography）の場合は
        // そのまま実測mm（最も正確）を使い、未校正の場合はpxToCmRatio
        // （アルコ/手動タップ校正、または身長からの自動推定のいずれかで
        // ほぼ常に値がある）で近似変換する。precise:falseの場合は帳票側で
        // 「参考値」である旨を小さく添える。
        if (dataPoints.length > 5 && shouldShowCopRadar(mode)) {
            var hasFloorHomography = !!(session.floorHomography && session.floorHomography.length === 8);
            // 2026-08-25変更: フレームごとのroll補正・4隅ArUco実測/pxToCmRatio
            // 近似の分岐ロジックを、js/biomechanics.jsのcomputeCopOffsetMm()
            // へ切り出した。撮影確認画面のCOPレーダーウィジェット
            // （updateRadar、同じくcomputeCopOffsetMm()を使用）と、この帳票用
            // 軌跡が同じ計算結果を共有するようにするため（企画者から「最後まで
            // 再生して見比べても整合性が無い。信頼性に関わるので同じ軌跡を
            // 共有したい」とのご指摘への対応）。挙動・結果は変更していない
            // （既存ロジックをそのまま関数化しただけ）。
            var copCtx = {
                rollDeg: (typeof session.capturedRollDeg === 'number') ? session.capturedRollDeg : null,
                canvasWidth: session.canvasWidth,
                canvasHeight: session.canvasHeight,
                floorHomography: hasFloorHomography ? session.floorHomography : null,
                pxToCmRatio: session.pxToCmRatio
            };
            var copTrajectory = [];
            dataPoints.forEach(frame => {
                var pos = computeCopOffsetMm(frame.keypoints, copCtx);
                if (pos) copTrajectory.push({ x: pos.x, y: pos.y, t: frame.time });
            });

            if (copTrajectory.length > 0) {
                var sumX = 0, sumY = 0;
                copTrajectory.forEach(p => { sumX += p.x; sumY += p.y; });
                var avgX = sumX / copTrajectory.length;
                var avgY = sumY / copTrajectory.length;

                var pathLength = 0;
                for (var i = 1; i < copTrajectory.length; i++) {
                    pathLength += Math.hypot(copTrajectory[i].x - copTrajectory[i-1].x, copTrajectory[i].y - copTrajectory[i-1].y);
                }

                var varX = 0, varY = 0;
                copTrajectory.forEach(p => {
                    varX += Math.pow(p.x - avgX, 2);
                    varY += Math.pow(p.y - avgY, 2);
                });
                var stdX = Math.sqrt(varX / copTrajectory.length);
                var stdY = Math.sqrt(varY / copTrajectory.length);

                // Sway area: approximate 95% Confidence Ellipse area (pi * 2 * stdX * 2 * stdY)
                var swayArea = Math.PI * 2 * stdX * 2 * stdY;

                var durationSec = (copTrajectory[copTrajectory.length - 1].t - copTrajectory[0].t) / 1000;
                var swaySpeed = durationSec > 0 ? (pathLength / durationSec) : null;

                result.swayMetrics = {
                    avgDeviationX: avgX, // mm。正の値=右寄り
                    swayArea: swayArea, // mm²（95%信頼楕円近似）
                    pathLength: pathLength, // mm
                    swaySpeed: swaySpeed, // mm/s
                    // 4隅ArUco床面実測(true)か、pxToCmRatioによる近似(false)かの
                    // 精度フラグ。帳票側で近似の場合のみ小さく注記するために使う。
                    precise: hasFloorHomography,
                    // 帳票に埋め込む軌跡画像（js/biomechanics.jsのrenderCopTrajectoryImage
                    // 参照）用の生の軌跡点列（mm単位）。時間軸そのものは表現せず、
                    // 単純にジグザグの経路として描画する想定（企画者のご要望）。
                    trajectory: copTrajectory.map(function (p) { return { x: p.x, y: p.y }; })
                };
            }
        }

        return result;
    },

    /**
     * Call the Gemini API.
     */
    fetchGeminiReport: async function(metrics, apiKey) {
        var model = "gemini-2.5-flash";
        var url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        // 2026-08-24更新: mm単位に統一（4隅ArUco床面実測ならprecise:true、
        // pxToCmRatioによる近似ならprecise:falseで精度の注記のみ添える。
        // 従来のmm/px二重表記はやめた）。
        var swayText = "";
        if (metrics.swayMetrics) {
            var sw = metrics.swayMetrics;
            swayText = `- 足底圧中心 (COP) 重心動揺データ（単位: mm${sw.precise ? '・4隅ArUco床面実測' : '・参考値、pxToCmRatioによる近似換算'}）:
  - 左右の平均偏位: ${sw.avgDeviationX.toFixed(1)} mm (${sw.avgDeviationX > 0 ? "右寄り" : "左寄り"})
  - 重心動揺面積 (95%信頼楕円近似): ${sw.swayArea.toFixed(1)} mm²
  - 総軌跡長: ${sw.pathLength.toFixed(1)} mm
  - 平均動揺速度: ${sw.swaySpeed !== null ? sw.swaySpeed.toFixed(1) + " mm/s" : "算出不可"}`;
        }

        var prompt = `あなたは理学療法士、バイオメカニクス研究者、およびAI臨床姿勢分析の専門家です。
以下の姿勢・動作計測データに基づいて、極めて詳細で専門的な臨床バイオメカニクス評価レポートを日本語で作成してください。

【計測データ】
- 測定項目: ${metrics.mode} (${this.getModeNameJp(metrics.mode)})
- 被測定者の身長: ${metrics.height} cm
- 被測定者の足サイズ: ${metrics.footSize} cm
- 総計測フレーム数: ${metrics.frameCount}

${metrics.weightBearing ? `- 左右荷重比率: 
  - 全身: 左 ${metrics.weightBearing.total.L.toFixed(1)}% | 右 ${metrics.weightBearing.total.R.toFixed(1)}%
  - 上半身偏位: 左 ${metrics.weightBearing.upper.L.toFixed(1)}% | 右 ${metrics.weightBearing.upper.R.toFixed(1)}%
  - 下半身偏位: 左 ${metrics.weightBearing.lower.L.toFixed(1)}% | 右 ${metrics.weightBearing.lower.R.toFixed(1)}%` : ""}

${swayText}

${Object.keys(metrics.jointAngles).length > 0 ? `- 主要関節・セグメント角度:
  ${JSON.stringify(metrics.jointAngles)}` : ""}

${(metrics.mode === 'l_side' || metrics.mode === 'r_side') ? `- 骨盤の傾斜角: ${Math.abs(metrics.pelvicTilt).toFixed(1)}°（${metrics.pelvicTilt > 0 ? "前傾" : (metrics.pelvicTilt < 0 ? "後傾" : "ニュートラル")}）` : ""}

${STATIC_MODES.indexOf(metrics.mode) !== -1 ? `【レポート要件】
1. マークダウン形式で出力すること。
2. 本測定は静止姿勢（前面/後面/左右側面のいずれか1方向）のみが対象のため、動作解析（スクワット等の動的種目）や可動域テストの話題には一切触れないこと。以下の3つのセクションを必ず含めること：
   - ## 📋 静止姿勢アライメント評価 (Static Posture Alignment Assessment)
     姿勢・荷重左右比率・COP重心動揺データ「のみ」に基づいて、測定データの要約と、全体的なアライメントの崩れの有無・分類（ケンダルの姿勢分類に基づくニュートラル、ロードシス、カイホシス・ロードシス、フラットバック、スウェイバック等への言及）を明確に述べること。
   - ## 🔍 検出された偏位・アンバランスの詳細 (Detected Deviations & Imbalances)
     荷重左右差、COP重心動揺に見られる詳細な問題点を指摘し、重症度（軽度、中等度、重度）を判定すること。
   - ## 🏋️ 所見に基づく推奨改善アプローチ (Recommended Corrective Approach)
     上記①②で述べた所見「から導かれる」、具体的なストレッチ・筋力トレーニングメニュー（ターゲット部位、回数、セット数を含む）を提案すること。所見と直接関係の無い一般論は書かないこと。
3. トーンはプロフェッショナルで、アカデミックかつ実用的なものにすること。専門用語を適切に使用しつつ、クライアント向けの説明としても十分に理解できる表現にしてください。
` : `【レポート要件】
1. マークダウン形式で出力すること。
2. 以下の4つのセクションを必ず含めること：
   - ## 📋 姿勢・アライメント総合評価 (Summary of Posture Alignment)
     測定データの要約、全体的なアライメントの崩れの有無と分類（ケンダルの姿勢分類に基づくニュートラル、ロードシス、カイホシス・ロードシス、フラットバック、スウェイバック等への言及）。
   - ## 🔍 バイオメカニクス的逸脱 (Biomechanical Deviations)
     荷重左右差、関節角度、動揺データに見られる詳細な問題点を指摘し、重症度（軽度、中等度、重度）を判定。
   - ## ⚡ 臨床的インプリケーションと潜在的障害リスク (Clinical Implications & Impairment Risks)
     このアライメントが日常生活や動作時に与える腰椎、頸椎、膝関節、足関節への負担、発生し得る具体的な痛みのリスク。
   - ## 🏋️ 推奨されるアプローチ・リハビリ運動療法 (Recommended Corrective Exercise Protocol)
     このアライメント不良を改善するための具体的なストレッチや筋力トレーニングのメニュー（ターゲット部位、回数、セット数を含む）。
3. トーンはプロフェッショナルで、アカデミックかつ実用的なものにすること。専門用語を適切に使用しつつ、クライアント向けの説明としても十分に理解できる表現にしてください。
`}`;

        var response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.2 }
            })
        });

        if (!response.ok) {
            var errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText}`);
        }

        var json = await response.json();
        return json.candidates[0].content.parts[0].text;
    },

    /**
     * 2026-08-24追加: 静止4方向（front/back/l_side/r_side）専用のオフライン
     * レポート。企画者から「静止姿勢の場合は静止姿勢（姿勢・荷重・COP動揺）
     * の評価にフォーカスを絞ったうえで、その所見に基づく改善アプローチ
     * （運動療法）を提案する構成にしたい」とのご要望があり、動作解析・
     * 重心動揺専用モードと同じ4セクション構成から切り離して新設した
     * （2026-08-24）。静止4方向は元々jointAngles・動作解析系の値を持たない
     * ため、それらへの言及は行わない。
     */
    generateOfflineStaticReport: function(metrics, prefix = "") {
        var mode = metrics.mode;
        var wb = metrics.weightBearing;
        var sway = metrics.swayMetrics;
        var tilt = metrics.pelvicTilt;

        var report = prefix + `# 📊 バイオメカニクス簡易評価レポート (CONNECT AI Expert Local Engine)\n\n`;
        report += `**測定項目**: ${this.getModeNameJp(mode)}  \n`;
        report += `**計測日時**: ${new Date(metrics.timestamp).toLocaleString()}  \n\n`;

        // 1. 静止姿勢アライメント評価（姿勢・荷重・COP動揺のみに基づく）
        report += `## 📋 静止姿勢アライメント評価\n`;
        if (mode === 'front' || mode === 'back') {
            report += `前面/後面アライメント測定において、冠状面（左右）での対称性と荷重分布を評価しました。\n`;
            if (metrics.usedArucoMidline) {
                report += `※ 本測定は「アルコマーカー正中線モード」（4隅ArUco校正済みの固定設置環境における絶対基準線）で評価しています。基準点は左右の足の中点ではなく、校正済みマーカーボード中心の投影位置です。\n`;
            }
            if (wb) {
                var diff0 = Math.abs(wb.total.L - wb.total.R);
                if (diff0 < 5) {
                    report += `左右の荷重バランスは極めて良好（左右差 ${diff0.toFixed(1)}%）で、ほぼ均等に荷重が分散されています。骨格にかかる静的負荷は対称的です。\n`;
                } else if (diff0 < 12) {
                    report += `左右の荷重に軽度な非対称性（左右差 ${diff0.toFixed(1)}%）が観察されます。荷重偏位側は **${wb.total.L > wb.total.R ? "左脚" : "右脚"}** です。\n`;
                } else {
                    report += `左右の荷重に顕著な非対称性（左右差 ${diff0.toFixed(1)}%）が見られます。**${wb.total.L > wb.total.R ? "左脚" : "右脚"}** に過剰な荷重がかかっており、代償動作や関節の局所的ストレスの原因となります。\n`;
                }
            }
        } else {
            report += `矢状面（側面）アライメント測定において、ケンダルの姿勢分類に基づく評価を行いました。\n`;
            if (typeof tilt === 'number') {
                report += `骨盤の傾斜角: **${Math.abs(tilt).toFixed(1)}°**（${tilt > 0 ? "前傾側" : (tilt < 0 ? "後傾側" : "ニュートラル")}）\n`;
            }
        }
        if (sway) {
            report += `静止中の足底圧中心（COP）の動揺${sway.precise ? '（4隅ArUco床面実測）' : '（参考値・pxToCmRatioによる近似換算）'}も評価対象に含めています。\n`;
        }
        report += `\n`;

        // 2. 検出された偏位・アンバランスの詳細
        report += `## 🔍 検出された偏位・アンバランスの詳細\n`;
        var hasDeviations0 = false;

        if (wb && Math.abs(wb.total.L - wb.total.R) > 5) {
            var diff1 = Math.abs(wb.total.L - wb.total.R);
            var severity1 = diff1 > 12 ? "【重度】" : "【軽度〜中等度】";
            report += `- **荷重バランス非対称性 ${severity1}**: 荷重中心が ${wb.total.L > wb.total.R ? "左側" : "右側"} に ${diff1.toFixed(1)}% 偏位しています。\n`;
            hasDeviations0 = true;
        }

        if (sway && sway.swayArea > 800) {
            report += `- **COP重心動揺領域の増大 【中等度】**: 動揺面積が ${sway.swayArea.toFixed(1)} mm²${sway.precise ? '（4隅ArUco床面実測）' : '（参考値・pxToCmRatioによる近似換算）'}と広く、静的バランスの維持における安定性低下（足底受容器・前庭系・視覚によるフィードバックの遅れや足関節の剛性不足）を示しています。\n`;
            hasDeviations0 = true;
        }

        if (!hasDeviations0) {
            report += `顕著なバイオメカニクス的逸脱は検出されませんでした。すべてアライメント指標は安全基準範囲内です。\n`;
        }
        report += `\n`;

        // 3. 所見に基づく推奨改善アプローチ（運動療法）
        report += `## 🏋️ 所見に基づく推奨改善アプローチ\n`;
        if (!hasDeviations0) {
            report += `### 全身のコアスタビリティの維持\n`;
            report += `- **バードドッグ (Bird-Dog)**\n`;
            report += `  - ターゲット: 脊柱起立筋、多裂筋、臀筋、コアの対角支持性\n`;
            report += `  - アプローチ: 四つん這いから右手と左脚（または左手と右脚）を水平に伸ばし、3秒維持します。左右交互に15回×3セット。\n`;
        }

        if (wb && Math.abs(wb.total.L - wb.total.R) > 5) {
            var weakSide0 = wb.total.L > wb.total.R ? "右" : "左";
            report += `### 荷重左右差の是正\n`;
            report += `- **${weakSide0}脚の片脚デッドリフト (Single-Leg Romanian Deadlift)**\n`;
            report += `  - ターゲット: ${weakSide0}側の大臀筋、ハムストリングス、骨盤の水平安定性\n`;
            report += `  - アプローチ: 片脚で立ち、背部を伸ばしたまま股関節から上体を前に倒します。10回×3セット。\n`;
        }

        if (sway && sway.swayArea > 800) {
            report += `### 静的バランス（COP動揺）の改善\n`;
            report += `- **片脚立位バランストレーニング (Single-Leg Balance)**\n`;
            report += `  - ターゲット: 足底受容器・足関節周囲筋の固有受容感覚\n`;
            report += `  - アプローチ: 裸足で片脚立ちを30秒キープ。慣れてきたら目を閉じる、不安定な床（クッション等）の上で行うなど難易度を上げます。左右各3セット。\n`;
        }

        return report;
    },

    /**
     * Offline local expert evaluation system.
     * 2026-08-24更新: 静止4方向（front/back/l_side/r_side）は上記の
     * generateOfflineStaticReport()（3セクション構成）へ切り出したため、
     * この関数は動作解析（動的種目）・重心動揺専用モードのみを扱う
     * （従来通りの4セクション構成）。
     */
    generateOfflineReport: function(metrics, prefix = "") {
        var mode = metrics.mode;
        if (STATIC_MODES.indexOf(mode) !== -1) {
            return this.generateOfflineStaticReport(metrics, prefix);
        }
        var height = metrics.height;
        var wb = metrics.weightBearing;
        var sway = metrics.swayMetrics;
        var ja = metrics.jointAngles;
        var tilt = metrics.pelvicTilt;

        var report = prefix + `# 📊 バイオメカニクス簡易評価レポート (CONNECT AI Expert Local Engine)\n\n`;
        report += `**測定項目**: ${this.getModeNameJp(mode)}  \n`;
        report += `**計測日時**: ${new Date(metrics.timestamp).toLocaleString()}  \n\n`;

        // 1. Summary
        report += `## 📋 姿勢・アライメント総合評価\n`;
        if (mode === 'front' || mode === 'back') {
            report += `前面/後面アライメント測定において、冠状面（左右）での対称性と荷重分布を評価しました。\n`;
            if (metrics.usedArucoMidline) {
                report += `※ 本測定は「アルコマーカー正中線モード」（4隅ArUco校正済みの固定設置環境における絶対基準線）で評価しています。基準点は左右の足の中点ではなく、校正済みマーカーボード中心の投影位置です。\n`;
            }
            if (wb) {
                var diff = Math.abs(wb.total.L - wb.total.R);
                if (diff < 5) {
                    report += `左右の荷重バランスは極めて良好（左右差 ${diff.toFixed(1)}%）で、ほぼ均等に荷重が分散されています。骨格にかかる静的負荷は対称的です。\n`;
                } else if (diff < 12) {
                    report += `左右の荷重に軽度な非対称性（左右差 ${diff.toFixed(1)}%）が観察されます。荷重偏位側は **${wb.total.L > wb.total.R ? "左脚" : "右脚"}** です。\n`;
                } else {
                    report += `左右の荷重に顕著な非対称性（左右差 ${diff.toFixed(1)}%）が見られます。**${wb.total.L > wb.total.R ? "左脚" : "右脚"}** に過剰な荷重がかかっており、代償動作や関節の局所的ストレスの原因となります。\n`;
                }
            }
        } else if (mode === 'l_side' || mode === 'r_side') {
            report += `矢状面（側面）アライメント測定において、ケンダルの姿勢分類に基づく評価を行いました。\n`;
            report += `骨盤の傾斜角は **${tilt === 0 ? "0°（ニュートラル）" : (tilt > 0 ? "前傾 " + tilt + "°" : "後傾 " + Math.abs(tilt) + "°")}** です。\n`;
            
            if (tilt > 8) {
                report += `骨盤の過度な前傾が認められ、腰椎前弯の亢進に伴う「反り腰（Lordosis）」または「カイホシス・ロードシス（円背・反り腰）」アライメントの傾向にあります。\n`;
            } else if (tilt < -5) {
                report += `骨盤の後傾が認められ、フラットバック（平背）またはスウェイバック（骨盤前方偏位・後傾）姿勢の傾向にあります。\n`;
            } else {
                report += `骨盤傾斜角はほぼ正常範囲内です。体幹セグメントおよび頭部、肩、大転子、外果のアライメントラインはおおむね良好な垂直アライメント（Plumb-line）を維持しています。\n`;
            }
        } else if (mode.startsWith('dyn_overhead')) {
            report += `動的動作（オーバーヘッドスクワット）におけるアライメントを評価しました。スクワット動作は股関節・膝関節・足関節の協調運動と、体幹の支持性を総合的に示す機能的評価です。\n`;
        } else {
            report += `動的機能および可動性テストを実施し、アライメント偏位を測定しました。\n`;
        }
        report += `\n`;

        // 2. Deviations
        report += `## 🔍 バイオメカニクス的逸脱\n`;
        var hasDeviations = false;
        
        if (wb && Math.abs(wb.total.L - wb.total.R) > 5) {
            var diff = Math.abs(wb.total.L - wb.total.R);
            var severity = diff > 12 ? "【重度】" : "【軽度〜中等度】";
            report += `- **荷重バランス非対称性 ${severity}**: 荷重中心が ${wb.total.L > wb.total.R ? "左側" : "右側"} に ${diff.toFixed(1)}% 偏位しています。\n`;
            hasDeviations = true;
        }

        if (tilt > 8 || tilt < -5) {
            var severity = Math.abs(tilt) > 15 ? "【重度】" : "【中等度】";
            report += `- **骨盤アライメント異常 ${severity}**: 骨盤が ${tilt > 0 ? "前傾" : "後傾"} に ${Math.abs(tilt)}° 傾斜しています。\n`;
            hasDeviations = true;
        }

        if (ja.leftKneeAngle && ja.rightKneeAngle && mode === 'dyn_overhead') {
            var kneeDiff = Math.abs(ja.leftKneeAngle - ja.rightKneeAngle);
            if (kneeDiff > 5) {
                report += `- **膝関節屈曲非対称性 【中等度】**: スクワット時の膝関節角度に ${kneeDiff.toFixed(1)}° の左右差があります（左: ${ja.leftKneeAngle.toFixed(1)}° / 右: ${ja.rightKneeAngle.toFixed(1)}°）。\n`;
                hasDeviations = true;
            }
        }

        if (ja.trunkLean && mode === 'dyn_overhead_side') {
            if (ja.trunkLean > 40) {
                report += `- **体幹前傾の過多 【中等度〜重度】**: 体幹の前傾角が ${ja.trunkLean.toFixed(1)}° と深く、股関節および大腿四頭筋の硬さ、あるいは体幹深層筋の支持性低下を示唆します。\n`;
                hasDeviations = true;
            }
            if (ja.shoulderArmAngle && ja.shoulderArmAngle < 155) {
                report += `- **上腕挙上不足 【中等度】**: スクワット中の腕と体幹のなす角度が ${ja.shoulderArmAngle.toFixed(1)}° と狭く、広背筋や大胸筋の硬さ、または肩甲骨周囲筋の機能低下を示します。\n`;
                hasDeviations = true;
            }
        }

        if (sway) {
            // 2026-08-24更新: mm単位に統一。閾値(800mm²)は実測データがまだ
            // 十分に無い暫定値のため、被験者計測が進み次第見直す前提。
            if (sway.swayArea > 800) {
                report += `- **COP重心動揺領域の増大 【中等度】**: 動揺面積が ${sway.swayArea.toFixed(1)} mm²${sway.precise ? '（4隅ArUco床面実測）' : '（参考値・pxToCmRatioによる近似換算）'}と広く、静的バランスの維持における安定性低下（足底受容器・前庭系・視覚によるフィードバックの遅れや足関節の剛性不足）を示しています。\n`;
                hasDeviations = true;
            }
        }

        if (!hasDeviations) {
            report += `顕著なバイオメカニクス的逸脱は検出されませんでした。すべてアライメント指標は安全基準範囲内です。\n`;
        }
        report += `\n`;

        // 3. Clinical Implications
        report += `## ⚡ 臨床的インプリケーションと潜在的障害リスク\n`;
        if (wb && Math.abs(wb.total.L - wb.total.R) > 5) {
            var dominantSide = wb.total.L > wb.total.R ? "左" : "右";
            var lightSide = wb.total.L > wb.total.R ? "右" : "左";
            report += `- **${dominantSide}膝・股関節・足関節の過負荷**: 荷重が増大している側の関節における軟骨・靭帯への機械的ストレスが増大し、長期的に変形性関節症や腱炎のリスクが高まります。\n`;
            report += `- **${lightSide}腰背部の筋筋膜性ストレス**: 荷重非対称性を代償するために、反対側の腰椎周囲筋（腰方形筋、脊柱起立筋）が過剰に緊張し、非特異的腰痛を発症しやすくなります。\n`;
        }

        if (tilt > 8) {
            report += `- **仙腸関節および腰椎椎間関節症**: 骨盤の前傾は腰椎の過前弯を引き起こし、椎間関節の圧迫ストレス（腰痛）や、大腿四頭筋・腸腰筋の短縮、ハムストリングスの伸張性過緊張を誘発します。\n`;
        } else if (tilt < -5) {
            report += `- **椎間板ヘルニアおよびフラットバック症候群**: 骨盤の後傾は脊椎本来の緩衝機能を司るS字カーブを消失させ、椎間板（特にL4/L5-S1）への軸圧ストレスを増大させ、ヘルニアや坐骨神経痛のリスクとなります。\n`;
        }

        if (ja.trunkLean && ja.trunkLean > 40 && mode === 'dyn_overhead_side') {
            report += `- **腰部・膝関節蓋大腿関節への代償ストレス**: 体幹の過度な前傾は、大腿四頭筋への依存を強め、膝蓋腱炎（ジャンパー膝）や膝前面痛の原因となります。また、腰椎部のモーメントアームが長くなり、脊柱起立筋への負担が極端に増加します。\n`;
        }

        if (wb === null && tilt === 0 && !ja.trunkLean) {
            report += `- **一般的な姿勢維持機能の維持**: 現在は良好な状態ですが、デスクワークなどの持続的な同姿勢によりインナーマッスル（コア）が弱化すると、アライメント不良へ移行する可能性があります。\n`;
        }
        report += `\n`;

        // 4. Corrective Exercise
        report += `## 🏋️ 推奨されるアプローチ・リハビリ運動療法\n`;
        
        if (wb && Math.abs(wb.total.L - wb.total.R) > 5) {
            var weakSide = wb.total.L > wb.total.R ? "右" : "左";
            report += `### 1. 荷重左右差の是正\n`;
            report += `- **${weakSide}脚の片脚デッドリフト (Single-Leg Romanian Deadlift)**\n`;
            report += `  - ターゲ���ト: ${weakSide}側の大臀筋、ハムストリングス、骨盤の水平安定性\n`;
            report += `  - アプローチ: 片脚で立ち、背部を伸ばしたまま股関節から上体を前に倒します。10回×3セット。\n`;
        }

        if (tilt > 8) {
            report += `### 2. 骨盤前傾・反り腰の改善\n`;
            report += `- **腸腰筋・大腿四頭筋のストレッチ**\n`;
            report += `  - アプローチ: 片膝立ちになり、骨盤を後傾させながら前方に体重を移動し、股関節前面を伸ばします。左右各30秒×3回。\n`;
            report += `- **プランク (Plank) & ドローイン**\n`;
            report += `  - アプローチ: 前腕とつま先で体を支え、腹横筋を意識して骨盤をニュートラルに維持します。30〜60秒×3セット。\n`;
        } else if (tilt < -5) {
            report += `### 2. 骨盤後傾・平背の改善\n`;
            report += `- **ハムストリングスの動的ストレッチ**\n`;
            report += `  - アプローチ: 仰向けに寝て片膝を抱え、そこから膝をゆっくり伸ばして太もも裏側を伸ばします。左右各20回×2セット。\n`;
            report += `- **キャット＆カウ (Cat & Cow)**\n`;
            report += `  - アプローチ: 四つん這いになり、骨盤から背骨を一つずつ動かすように、丸める・反らすを繰り返します。15回×2セット。\n`;
        }

        if (ja.trunkLean && ja.trunkLean > 40 && mode === 'dyn_overhead_side') {
            report += `### 3. オーバーヘッドスクワットパターンの改善\n`;
            report += `- **ヒップヒンジの練習 (Hip Hinge Practice with Wall)**\n`;
            report += `  - アプローチ: 壁から足1足分前に立ち、お尻を後ろの壁にタッチさせるように股関節から屈曲します。膝を前に出さない感覚を養います。15回×3セット。\n`;
            report += `- **胸椎の伸展・回旋モビリティ**\n`;
            report += `  - アプローチ: 四つん這いから片手を頭の後ろにあて、胸を横に開くように体幹を回旋します。上腕の挙上可動域を改善します。左右各10回×3セット。\n`;
        }

        if (!wb && tilt === 0 && !ja.trunkLean) {
            report += `### 1. 全身のコアスタビリティの維持\n`;
            report += `- **バードドッグ (Bird-Dog)**\n`;
            report += `  - ターゲット: 脊柱起立筋、多裂筋、臀筋、コアの対角支持性\n`;
            report += `  - アプローチ: 四つん這いから右手と左脚（または左手と右脚）を水平に伸ばし、3秒維持します。左右交互に15回×3セット。\n`;
        }

        return report;
    },

    /**
     * 4方向総合所見 (Multi-view synthesis)
     * ---------------------------------------------------------------------
     * v4.6.16で追加。前面・後面・左側面・右側面のうち2方向以上のデータが
     * 揃っている場合に、既存のレポート（代表1ポーズの指標に基づく従来通り
     * の4セクション）に追加する形で、方向を横断した所見をまとめる。
     * 既存のgenerateReport/extractMetricsは一切変更していない
     * （PRODUCT_REQUIREMENTS.md 4節・5節を参照）。
     *
     * @param {Object} metricsByMode - { mode: extractMetrics()の戻り値 }
     * @param {string} apiKey
     * @returns {Promise<string>} Markdown本文（見出しなし）
     */
    generateMultiViewReport: async function(metricsByMode, apiKey) {
        if (apiKey && apiKey.trim() !== "") {
            try {
                return await this.fetchGeminiMultiViewSynthesis(metricsByMode, apiKey);
            } catch (e) {
                console.error("Gemini Multi-View API Error, falling back to offline analysis:", e);
                return "⚠️ [APIエラーによりオフライン生成されました: " + e + "]\n\n" + this.generateOfflineMultiViewSynthesis(metricsByMode);
            }
        }
        return this.generateOfflineMultiViewSynthesis(metricsByMode);
    },

    fetchGeminiMultiViewSynthesis: async function(metricsByMode, apiKey) {
        var model = "gemini-2.5-flash";
        var url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        var self = this;

        var modeOrder = ['front', 'l_side', 'back', 'r_side'];
        var availableModes = modeOrder.filter(m => !!metricsByMode[m]);
        var missingModes = modeOrder.filter(m => !metricsByMode[m]);

        var sectionsText = availableModes.map(function (mode) {
            var m = metricsByMode[mode];
            var lines = ["■ " + self.getModeNameJp(mode)];
            if (m.weightBearing) {
                lines.push("- 左右荷重比率: 全身 左 " + m.weightBearing.total.L.toFixed(1) + "% / 右 " + m.weightBearing.total.R.toFixed(1) + "%");
            }
            if (m.swayMetrics) {
                lines.push("- 重心動揺面積: " + m.swayMetrics.swayArea.toFixed(1) + " mm²" + (m.swayMetrics.precise ? "" : "（参考値）"));
            }
            if ((mode === 'l_side' || mode === 'r_side') && typeof m.pelvicTilt === 'number') {
                lines.push("- 骨盤の傾斜角: " + Math.abs(m.pelvicTilt).toFixed(1) + "°（" + (m.pelvicTilt > 0 ? "前傾" : (m.pelvicTilt < 0 ? "後傾" : "ニュートラル")) + "）");
            }
            return lines.join("\n");
        }).join("\n\n");

        var prompt = `あなたは理学療法士、バイオメカニクス研究者、およびAI臨床姿勢分析の専門家です。
以下は、同一の被測定者を静止姿勢で複数方向（前面・後面・左側面・右側面のうち一部、または全部）から撮影した計測データです。各方向ごとの個別の詳細評価（静止姿勢アライメント評価・検出された偏位・所見に基づく推奨改善アプローチの3セクション構成）は別途出力済みのため、ここでは方向を横断して初めて見えてくる所見に絞り、簡潔な「4方向総合所見」を日本語で作成してください。姿勢・荷重・COP重心動揺「以外」（動作解析・可動域テスト等）の話題には触れないこと。

【計測済みの方向】
${sectionsText}

${missingModes.length > 0 ? "【未計測の方向】\n" + missingModes.map(m => self.getModeNameJp(m)).join("、") + "\n" : ""}

【出力要件】
1. マークダウン形式。ただし大見出し(#, ##)は付けないこと（呼び出し側で見出しを付与するため、本文のみを出力する）。
2. 以下の2点を、合わせて6〜9文程度でまとめること：
   (a) 方向を横断して初めて言える姿勢・荷重・COP動揺のアライメント所見の統合（例: 前面・後面で見られた荷重偏位と、側面で見られた所見との関連性など）。単に各方向の結果を再掲しないこと。方向間で矛盾する所見があれば、その旨も指摘すること。
   (b) (a)の統合所見から導かれる、複数方向を踏まえた総合的な改善アプローチ（運動療法）の提案。各方向の個別レポートで既に提案した内容の単純な再掲ではなく、方向を横断したからこそ言える優先順位や関連性を踏まえること。
3. 断定的すぎる表現は避け、「傾向が見られます」「示唆されます」等の丁寧な臨床トーンを保つこと。
4. 未計測の方向がある場合は、それを踏まえた参考情報である旨に軽く触れること。
`;

        var response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.2 }
            })
        });

        if (!response.ok) {
            var errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText}`);
        }

        var json = await response.json();
        return json.candidates[0].content.parts[0].text;
    },

    /**
     * オフライン（APIキー未設定・API失敗時）向けの、ルールベースな4方向
     * 横断所見。前面/後面の荷重偏位の一貫性など、単一方向の指標だけでは
     * 言えない簡易的なクロスチェックを行う。
     */
    generateOfflineMultiViewSynthesis: function(metricsByMode) {
        var self = this;
        var modeOrder = ['front', 'l_side', 'back', 'r_side'];
        var availableModes = modeOrder.filter(m => !!metricsByMode[m]);
        var missingModes = modeOrder.filter(m => !metricsByMode[m]);

        var lines = [];
        lines.push("本セッションでは" + availableModes.map(m => self.getModeNameJp(m).replace('静止姿勢・', '')).join("・") + "の" + availableModes.length + "方向を計測しました。");

        // 2026-08-25追加: 左右の骨盤傾斜角は平均化せず側面ごとに独立して
        // 保存しているため（企画者の「左右別に扱いたい」とのご要望）、
        // 両側面が揃っている場合はここで左右を並べて明示する。
        if (metricsByMode['l_side'] && metricsByMode['r_side'] &&
            typeof metricsByMode['l_side'].pelvicTilt === 'number' && typeof metricsByMode['r_side'].pelvicTilt === 'number') {
            var tiltL = metricsByMode['l_side'].pelvicTilt;
            var tiltR = metricsByMode['r_side'].pelvicTilt;
            var tiltLLabel = tiltL > 0 ? "前傾" : (tiltL < 0 ? "後傾" : "ニュートラル");
            var tiltRLabel = tiltR > 0 ? "前傾" : (tiltR < 0 ? "後傾" : "ニュートラル");
            lines.push("骨盤の傾斜角は左側面 " + Math.abs(tiltL).toFixed(1) + "°（" + tiltLLabel + "）、右側面 " + Math.abs(tiltR).toFixed(1) + "°（" + tiltRLabel + "）でした。");
        }

        // 2026-08-24追加: 総合所見から導かれる改善アプローチを最後にまとめる
        // ためのフラグ（企画者からの「所見に基づく改善アプローチも入れて
        // ほしい」とのご要望対応）。
        var consistentWbSide = null;

        // 前面/後面の荷重偏位の一貫性チェック
        var wbModes = availableModes.filter(m => metricsByMode[m].weightBearing);
        if (wbModes.length > 0) {
            var sides = wbModes.map(function (m) {
                var wb = metricsByMode[m].weightBearing.total;
                var diff = wb.L - wb.R;
                if (Math.abs(diff) < 3) return 'N';
                return diff > 0 ? 'L' : 'R';
            });
            var nonNeutral = sides.filter(s => s !== 'N');
            if (nonNeutral.length > 1 && nonNeutral.every(s => s === nonNeutral[0])) {
                lines.push(wbModes.map(m => self.getModeNameJp(m).replace('静止姿勢・', '')).join("・") + "のいずれにおいても" + (nonNeutral[0] === 'L' ? "左" : "右") + "側への荷重偏位が確認されており、単一方向の測定誤差ではなく、一貫した左右非対称のパターンが疑われます。");
                consistentWbSide = nonNeutral[0];
            } else if (nonNeutral.length > 1) {
                lines.push("方向ごとに荷重の偏位傾向が一致していません。単発の測定誤差である可能性もありますが、動作に伴う重心移動の影響も考えられるため、複数回の再測定での確認を推奨します。");
            }
        }

        // 2026-08-24追加: 統合所見から導かれる、複数方向を踏まえた総合的な
        // 改善アプローチの提案（各方向の個別レポートの単純な再掲ではなく、
        // 方向を横断して優先度が高いと考えられるものを1〜2点に絞って挙げる）。
        if (consistentWbSide) {
            var approachLines = [];
            var weakSideM = consistentWbSide === 'L' ? '右' : '左';
            approachLines.push((consistentWbSide === 'L' ? '左' : '右') + "側への荷重偏位が複数方向で一貫しているため、" + weakSideM + "脚の片脚デッドリフト等、" + weakSideM + "側の支持性を高めるトレーニングを優先することが望まれます。");
            lines.push("**所見に基づく総合的な改善アプローチ**: " + approachLines.join(" "));
        }

        if (missingModes.length > 0) {
            lines.push("※ 今回は" + missingModes.map(m => self.getModeNameJp(m).replace('静止姿勢・', '')).join("・") + "のデータが揃っていないため、上記はあくまで参考情報としてご確認ください。");
        }

        return lines.join("\n\n");
    },

    /**
     * Translates mode strings to Japanese names.
     */
    getModeNameJp: function(mode) {
        var names = {
            'front': '静止姿勢・前面',
            'back': '静止姿勢・後面',
            'l_side': '静止姿勢・左側面',
            'r_side': '静止姿勢・右側面',
            'dyn_overhead': 'オーバーヘッドスクワット (前面)',
            'dyn_overhead_side': 'オーバーヘッドスクワット (側面)',
            'dyn_single_r': '片脚立位バランス (右軸脚)',
            'dyn_single_l': '片脚立位バランス (左軸脚)',
            'dyn_flex_fwd': '立位体前屈テスト',
            'dyn_flex_bwd': '立位体後屈テスト',
            'dyn_shoulder_r': '肩複合可動性 (右上)',
            'dyn_shoulder_l': '肩複合可動性 (左上)'
        };
        return names[mode] || mode;
    }
};

export default apiManager;
