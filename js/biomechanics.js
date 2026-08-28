/**
 * CONNECT AI - Biomechanics Drawing & Calculation Engine
 * Contains all mathematical calculations, drawing logic, skeleton connections,
 * Kendall posture alignment, weight-bearing, dynamic movement analyses,
 * and Center of Pressure (COP) sway radar.
 */

/**
 * 2026-08-24追加: 撮影中・確認画面に表示される数値ラベル（左右荷重比率・
 * Kendallアライメント分類・動作解析の角度等）について、企画者から
 * 「小さすぎてよく見えないので大きくしてほしい」とのご要望があった。
 * ライブ撮影中（js/core/camera.js）と確認・微調整画面（js/ui/controls.js）
 * は元々この同じ描画関数群を共有しているため、ここで1箇所変更するだけで
 * 両方に反映される。今後のサイズ調整（企画者からは「まず5倍で試して、
 * あとで調整するかも」とのご依頼）を1箇所の定数変更だけで済ませられる
 * よう、基準フォントサイズに掛け合わせる倍率として一本化した。
 */
// 2026-08-24追記: 実機確認の結果「5倍は大きすぎる」とのことで、その半分の
// 2.5倍に調整（企画者からは「あとで修正するかも」との想定通りの反応）。
var OVERLAY_FONT_SCALE = 2.5;
function overlayFont(basePx, bold) {
    return (bold ? 'bold ' : '') + Math.round(basePx * OVERLAY_FONT_SCALE) + 'px sans-serif';
}

var biomechanics = {
    // MediaPipe BlazePose Connections
    skeletonConnections: [
        [11, 12], // shoulder to shoulder
        [23, 24], // hip to hip
        [11, 23], // left shoulder to left hip
        [12, 24], // right shoulder to right hip
        // Left arm
        [11, 13], [13, 15],
        // Right arm
        [12, 14], [14, 16],
        // Left leg
        [23, 25], [25, 27], [27, 29], [29, 31], [31, 27],
        // Right leg
        [24, 26], [26, 28], [28, 30], [30, 32], [32, 28]
    ],

    /**
     * Draws the complete skeleton on the canvas.
     */
    drawSkeleton: function(ctx, kps, color = '#ff5252') {
        if (!kps) return;
        
        ctx.save();
        // Draw connection lines
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        this.skeletonConnections.forEach(([p1, p2]) => {
            var kp1 = kps[p1];
            var kp2 = kps[p2];
            if (kp1 && kp2 && kp1.score > 0.3 && kp2.score > 0.3) {
                ctx.beginPath();
                ctx.moveTo(kp1.x, kp1.y);
                ctx.lineTo(kp2.x, kp2.y);
                ctx.stroke();
            }
        });

        // Draw virtual ASIS lines if they exist
        var asisL = kps.find(k => k.name === 'virtual_asis_l');
        var asisR = kps.find(k => k.name === 'virtual_asis_r');
        var lHip = kps[23];
        var rHip = kps[24];
        if (asisL && asisR) {
            // Draw ASIS line
            ctx.strokeStyle = '#673ab7'; // Purple for ASIS
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(asisL.x, asisL.y);
            ctx.lineTo(asisR.x, asisR.y);
            ctx.stroke();

            // Link ASIS to respective hips
            if (lHip) {
                ctx.beginPath(); ctx.moveTo(lHip.x, lHip.y); ctx.lineTo(asisL.x, asisL.y); ctx.stroke();
            }
            if (rHip) {
                ctx.beginPath(); ctx.moveTo(rHip.x, rHip.y); ctx.lineTo(asisR.x, asisR.y); ctx.stroke();
            }
        }

        // Draw joints
        kps.forEach((kp, idx) => {
            if (kp && kp.score > 0.3 && idx < 33) {
                ctx.fillStyle = (idx % 2 === 0) ? '#00bfff' : '#ff9100'; // Cyan/Orange joints
                ctx.beginPath();
                ctx.arc(kp.x, kp.y, 6, 0, 2 * Math.PI);
                ctx.fill();
                
                // Outline
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }
        });

        // Draw virtual ASIS nodes
        [asisL, asisR].forEach(asis => {
            if (asis) {
                ctx.fillStyle = '#ffeb3b'; // Yellow for virtual points
                ctx.beginPath();
                ctx.arc(asis.x, asis.y, 7, 0, 2 * Math.PI);
                ctx.fill();
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        });

        ctx.restore();
    },

    /**
     * Draws center vertical/horizontal grids.
     */
    drawCenterGrid: function(ctx, canvas) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 10]);
        
        // Vertical Center
        ctx.beginPath();
        ctx.moveTo(canvas.width / 2, 0);
        ctx.lineTo(canvas.width / 2, canvas.height);
        ctx.stroke();

        // Horizontal Center
        ctx.beginPath();
        ctx.moveTo(0, canvas.height / 2);
        ctx.lineTo(canvas.width, canvas.height / 2);
        ctx.stroke();
        ctx.restore();
    },

    /**
     * Draws local D-pad touch crosshair for point selection.
     */
    drawCrosshair: function(ctx, point, canvas) {
        ctx.save();
        ctx.strokeStyle = '#ffeb3b';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        // Horiz line
        ctx.moveTo(0, point.y); ctx.lineTo(canvas.width, point.y);
        // Vert line
        ctx.moveTo(point.x, 0); ctx.lineTo(point.x, canvas.height);
        ctx.stroke();
        ctx.restore();
    },

    /**
     * Computes Kendall plumbline and sagittal spinal offsets.
     */
    /**
     * @param {number} [arucoMidlineX] - 2026-08-05追加。研究機関向け「静止姿勢:
     *   アルコ正中線モード」用。指定された場合（number）、プラムライン
     *   （正中線）の基準を従来の「足首位置+外果前方オフセット」という
     *   本人の姿勢由来の近似ではなく、この絶対座標（4隅ArUcoマーカー中心の
     *   画像ピクセルX座標）に差し替える。物理的なプラムライン（下げ振り）
     *   計測法に近い、被写体の姿勢に依存しない固定基準線になる。
     *   null/undefinedの場合は従来通り足首基準（後方互換、デフォルト挙動）。
     */
    drawKendallAlignment: function(ctx, kps, pxToCmRatio, footSize, estimatedPelvicTilt, currentTab, canvasWidth, canvasHeight, arucoMidlineX) {
        if (currentTab !== 'l_side' && currentTab !== 'r_side') return;
        var isLeft = currentTab === 'l_side';
        var dir = isLeft ? -1 : 1;

        var ear = isLeft ? kps[7] : kps[8]; // Ear index
        var sh = isLeft ? kps[11] : kps[12]; // Shoulder index
        var hip = isLeft ? kps[23] : kps[24]; // Hip index
        var ankle = isLeft ? kps[27] : kps[28]; // Ankle index

        var targetAnkle = ankle && ankle.score > 0.1 ? ankle : null;
        if (!targetAnkle) {
            var heel = isLeft ? kps[29] : kps[30];
            if (heel && heel.score > 0.1) targetAnkle = heel;
        }

        if (!ear || !sh || !hip || !targetAnkle || ear.score < 0.1 || sh.score < 0.1 || hip.score < 0.1) return;

        var ratio = pxToCmRatio || 0.15;
        var footCm = footSize || 25;

        var useAruco = typeof arucoMidlineX === 'number' && isFinite(arucoMidlineX);
        var plumbX;
        if (useAruco) {
            plumbX = arucoMidlineX;
        } else {
            // Plumbline falls slightly anterior to the lateral malleolus (外果の約15%前方)
            var plumbOffsetPx = (footCm * 0.15) / ratio;
            plumbX = targetAnkle.x + (dir * plumbOffsetPx);
        }

        // Draw plumb line（アルコ正中線モード時は紫系にして区別する）
        ctx.save();
        ctx.strokeStyle = useAruco ? 'rgba(179, 136, 255, 0.85)' : 'rgba(57, 255, 20, 0.8)'; // Lime green plumbline (default) / purple (ArUco)
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(plumbX, 0); 
        ctx.lineTo(plumbX, canvasHeight); 
        ctx.stroke();

        // Calculate anatomical alignment points relative to the plumbline
        // C2: 頸椎 (ear x coordinate back translation)
        var c2 = { x: ear.x - (dir * (1.0 / ratio)), y: ear.y + (2.0 / ratio), name: "C2 (頸椎)", d0: 1.5 };
        // Th3: 胸椎 (shoulder x coordinate)
        var th3 = { x: sh.x, y: sh.y, name: "Th3 (胸椎)", d0: 1.0 };
        
        // S2: 仙骨 (computed using hip coordinate, shifted back based on pelvic tilt)
        var tiltRad = estimatedPelvicTilt * (Math.PI / 180);
        var s2OffsetZ = 3.0 / ratio;
        var s2OffsetY = 2.0 / ratio;
        var s2X = hip.x - (dir * (s2OffsetZ * Math.cos(tiltRad) - s2OffsetY * Math.sin(tiltRad)));
        var s2Y = hip.y + (s2OffsetZ * Math.sin(tiltRad) + s2OffsetY * Math.cos(tiltRad));
        var s2 = { x: s2X, y: s2Y, name: "S2 (仙骨)", d0: 1.0 };
        
        // L3: 腰椎 (computed using spinal depth curve offset by pelvic tilt)
        var lumbarDepth = (3.0 + (estimatedPelvicTilt * 0.1)) / ratio;
        var l3Y = s2.y - ((s2.y - sh.y) * 0.3);
        var l3X = s2.x + (dir * lumbarDepth);
        var l3 = { x: l3X, y: l3Y, name: "L3 (腰椎)", d0: 2.0 };
        
        // Th11: 胸腰移行部
        var th11Y = s2.y - ((s2.y - sh.y) * 0.65);
        var th11X = s2.x + (dir * (0.8 / ratio));
        var th11 = { x: th11X, y: th11Y, name: "Th11 (胸腰移行)", d0: 1.2 };

        var spinalPoints = [c2, th3, th11, l3, s2];

        // Draw spinal markers
        spinalPoints.forEach(pt => {
            var diffPx = pt.x - plumbX;
            var diffCm = diffPx * ratio * dir; // positive is forward alignment, negative is backward
            
            // Draw marker
            ctx.fillStyle = '#ffeb3b';
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 6, 0, 2*Math.PI);
            ctx.fill();
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Link line to plumbline
            ctx.strokeStyle = 'rgba(255, 235, 59, 0.4)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(pt.x, pt.y);
            ctx.lineTo(plumbX, pt.y);
            ctx.stroke();

            // Render offset labels
            ctx.fillStyle = '#deff9a';
            ctx.font = overlayFont(12, true);
            ctx.textAlign = isLeft ? 'right' : 'left';
            // 2026-08-24: フォント拡大に伴い、マーカーの点や正中線と重ならない
            // よう文字の開始位置もあわせて離す（元は12px固定オフセット）。
            var textX = pt.x + (dir * (12 + (OVERLAY_FONT_SCALE - 1) * 4));
            var labelText = `${pt.name}: ${diffCm > 0 ? '+' : ''}${diffCm.toFixed(1)}cm`;
            ctx.fillText(labelText, textX, pt.y + 4);
        });

        // Compute posture classification
        var c2Offset = (c2.x - plumbX) * ratio * dir;
        var th3Offset = (th3.x - plumbX) * ratio * dir;
        var s2Offset = (s2.x - plumbX) * ratio * dir;

        var postureClass = "アライメント計測中...";
        var textColor = "#fff";
        
        // Kendall Classification Algorithm
        if (s2Offset < -3.0 && th3Offset > 2.0) {
            postureClass = "⚠️ スウェイバック (Sway Back)";
            textColor = "#ff5252";
        } else if (s2Offset > 2.5 && th3Offset > 2.5) {
            postureClass = "⚠️ カイホシス・ロードシス (Kyphosis-Lordosis)";
            textColor = "#ff9100";
        } else if (Math.abs(s2Offset) < 2.0 && th3Offset > 3.0) {
            postureClass = "⚠️ 円背（Thoracic Kyphosis）";
            textColor = "#ff9100";
        } else if (s2Offset < -2.0 && Math.abs(th3Offset) < 2.0) {
            postureClass = "⚠️ 平背 (Flat Back)";
            textColor = "#ffc107";
        } else if (Math.abs(s2Offset) < 2.5 && Math.abs(th3Offset) < 2.5 && Math.abs(c2Offset) < 3.0) {
            postureClass = "✅ ニュートラル (Neutral Posture)";
            textColor = "#39ff14";
        } else {
            postureClass = "軽微なアライメント偏位 (Minor Deviation)";
            textColor = "#ffeb3b";
        }

        // Draw HUD overlay in bottom right
        // 2026-08-24: フォント拡大に伴い、固定サイズの背景ボックスだと文字が
        // はみ出してしまうため、実際のテキスト幅を測って箱の大きさを
        // 動的に決める（右下を基準に、テキストが長くなった分だけ左に広がる）。
        var headerText = "【ケンダル姿勢アライメント分類" + (useAruco ? '・正中線:アルコ基準' : '') + "】";
        ctx.font = overlayFont(12, false);
        var headerW = ctx.measureText(headerText).width;
        ctx.font = overlayFont(15, true);
        var classW = ctx.measureText(postureClass).width;

        var hudPadding = 15 * OVERLAY_FONT_SCALE / 5 + 15; // 余白（拡大時も程よい余白を保つ）
        var lineH1 = Math.round(12 * OVERLAY_FONT_SCALE * 1.35);
        var lineH2 = Math.round(15 * OVERLAY_FONT_SCALE * 1.35);
        var boxW = Math.max(headerW, classW) + hudPadding * 2;
        var boxH = lineH1 + lineH2 + hudPadding;
        var boxX = canvasWidth - boxW - 15;
        var boxY = canvasHeight - boxH - 15;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(boxX, boxY, boxW, boxH);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        ctx.strokeRect(boxX, boxY, boxW, boxH);

        ctx.font = overlayFont(12, false);
        ctx.fillStyle = '#aaa';
        ctx.textAlign = 'left';
        ctx.fillText(headerText, boxX + hudPadding, boxY + lineH1);

        ctx.font = overlayFont(15, true);
        ctx.fillStyle = textColor;
        ctx.fillText(postureClass, boxX + hudPadding, boxY + lineH1 + lineH2 - lineH2 * 0.15);

        ctx.restore();
    },

    /**
     * Computes weight bearing and Center of Mass (COM).
     * @param {number} [arucoMidlineX] - 2026-08-05追加。研究機関向け「静止姿勢:
     *   アルコ正中線モード」用。指定された場合（number）、基準線を従来の
     *   「両足の中心」ではなく、この絶対座標（4隅ArUcoマーカー中心の画像
     *   ピクセルX座標、js/core/arucoCalibration.js参照）に差し替える。
     *   null/undefinedの場合は従来通り両足基準（後方互換、デフォルト挙動）。
     */
    calculateWeightBearing: function(ctx, kps, canvasWidth, canvasHeight, arucoMidlineX) {
        var lAnkle = kps[27], rAnkle = kps[28];
        if (!lAnkle || !rAnkle || lAnkle.score < 0.3 || rAnkle.score < 0.3) return null;

        var nose = kps[0], lSh = kps[11], rSh = kps[12], lHip = kps[23], rHip = kps[24];
        if (!nose || !lSh || !rSh || !lHip || !rHip) return null;

        var dPx = rAnkle.x - lAnkle.x;
        if (Math.abs(dPx) < 10) return null;

        var useAruco = typeof arucoMidlineX === 'number' && isFinite(arucoMidlineX);
        var centerX = useAruco ? arucoMidlineX : (lAnkle.x + rAnkle.x) / 2;

        // Weight distribution Center of Mass (COM) models
        var upperComX = (nose.x * 0.20) + (((lSh.x + rSh.x) / 2) * 0.80);
        var lowerComX = (lHip.x + rHip.x) / 2;
        var totalComX = (upperComX * 0.6) + (lowerComX * 0.4);

        // 2026-08-05: アルコ正中線モード時は、基準点（0%地点）を「左足首」
        // から「アルコマーカー中心」に差し替える。両足の間の距離(dPx)は
        // 従来通り%のスケール（1歩幅=何%か）として使い続けるため、報告の
        // 数値の意味合い（%表記そのもの）は変えず、基準点だけを絶対座標に
        // 揃える形になる。50%地点がアルコ中心と一致する。
        var calcRatio = (comX) => {
            var pctR = useAruco
                ? (50 + ((comX - arucoMidlineX) / dPx) * 100)
                : (((comX - lAnkle.x) / dPx) * 100);
            var pctL = 100 - pctR;
            if (pctR < 0) { pctR = 0; pctL = 100; }
            if (pctR > 100) { pctR = 100; pctL = 0; }
            return { L: pctL, R: pctR };
        };

        var upperRatio = calcRatio(upperComX);
        var lowerRatio = calcRatio(lowerComX);
        var totalRatio = calcRatio(totalComX);

        // Draw HUD
        // 2026-08-24: フォント拡大に伴い、固定サイズの背景ボックスだと3行の
        // 文字がはみ出してしまうため、実際のテキスト幅・行数から箱のサイズを
        // 動的に決める（Kendallアライメント分類HUDと同じ考え方）。
        ctx.save();
        var wbLine1 = `【全身荷重${useAruco ? '・正中線:アルコ基準' : ''}】 左: ${totalRatio.L.toFixed(1)}% | 右: ${totalRatio.R.toFixed(1)}%`;
        var wbLine2 = `上半身偏位 左: ${upperRatio.L.toFixed(1)}% | 右: ${upperRatio.R.toFixed(1)}%`;
        var wbLine3 = `下半身偏位 左: ${lowerRatio.L.toFixed(1)}% | 右: ${lowerRatio.R.toFixed(1)}%`;
        ctx.font = overlayFont(14, true);
        var wbMaxW = Math.max(ctx.measureText(wbLine1).width, ctx.measureText(wbLine2).width, ctx.measureText(wbLine3).width);

        var wbPadding = 15 * OVERLAY_FONT_SCALE / 5 + 15;
        var wbLineH = Math.round(14 * OVERLAY_FONT_SCALE * 1.35);
        var wbBoxW = wbMaxW + wbPadding * 2;
        var wbBoxH = wbLineH * 3 + wbPadding;
        var wbBoxX = canvasWidth / 2 - wbBoxW / 2;
        var wbBoxY = canvasHeight - wbBoxH - 15;

        ctx.fillStyle = "rgba(0,0,0,0.8)";
        ctx.fillRect(wbBoxX, wbBoxY, wbBoxW, wbBoxH);
        ctx.strokeStyle = useAruco ? "rgba(179, 136, 255, 0.5)" : "rgba(255,255,255,0.1)";
        ctx.strokeRect(wbBoxX, wbBoxY, wbBoxW, wbBoxH);
        ctx.textAlign = "center";

        ctx.fillStyle = Math.abs(totalRatio.L - 50) > 5 ? "#ff5252" : "#39ff14";
        ctx.fillText(wbLine1, canvasWidth/2, wbBoxY + wbLineH * 1 - wbLineH * 0.15);

        ctx.fillStyle = Math.abs(upperRatio.L - 50) > 5 ? "#ff9100" : "#fff";
        ctx.fillText(wbLine2, canvasWidth/2, wbBoxY + wbLineH * 2 - wbLineH * 0.15);

        ctx.fillStyle = Math.abs(lowerRatio.L - 50) > 5 ? "#ff9100" : "#fff";
        ctx.fillText(wbLine3, canvasWidth/2, wbBoxY + wbLineH * 3 - wbLineH * 0.15);

        // Draw COM indicator line（正中線ガイド）。アルコ正中線モード時は
        // 「両足の中心」の代わりに絶対座標の基準線を使っていることが一目で
        // 分かるよう、色を紫系に変えて区別する。
        ctx.strokeStyle = useAruco ? "rgba(179, 136, 255, 0.85)" : "rgba(255,255,255,0.3)";
        ctx.setLineDash([5,5]);
        ctx.beginPath();
        ctx.moveTo(centerX, 0);
        ctx.lineTo(centerX, canvasHeight);
        ctx.stroke();
        ctx.setLineDash([]);

        // Upper body COM dot
        ctx.fillStyle = "#ff9100"; 
        ctx.beginPath(); 
        ctx.arc(upperComX, (lSh.y + rSh.y)/2, 6, 0, 2*Math.PI); 
        ctx.fill();

        // Lower body COM dot
        ctx.fillStyle = "#ff9100"; 
        ctx.beginPath(); 
        ctx.arc(lowerComX, (lHip.y + rHip.y)/2, 6, 0, 2*Math.PI); 
        ctx.fill();

        // Total body COM indicator (Yellow target symbol)
        ctx.fillStyle = "#ffeb3b"; 
        ctx.strokeStyle = "#000"; 
        ctx.lineWidth = 2.5; 
        ctx.beginPath(); 
        ctx.arc(totalComX, (lAnkle.y + rAnkle.y)/2 - 15, 9, 0, 2*Math.PI); 
        ctx.fill(); 
        ctx.stroke(); 

        ctx.restore();
        return totalRatio;
    },

    /**
     * Dynamic OHS Front Knee alignment analysis.
     */
    drawOHSFrontAnalysis: function(ctx, kps) {
        var evaluateSide = (hIdx, kIdx, aIdx, label) => {
            var h = kps[hIdx], k = kps[kIdx], a = kps[aIdx]; 
            if (!h || !k || !a || h.score < 0.3 || k.score < 0.3 || a.score < 0.3) return;
            
            // Reference line from Hip to Ankle
            var refX = h.x + (a.x - h.x) * ((k.y - h.y) / (a.y - h.y));
            // Knee flexion angle
            var angle = Math.abs(180 - Math.abs(Math.atan2(a.y-k.y, a.x-k.x) - Math.atan2(h.y-k.y, h.x-k.x)) * 180 / Math.PI);
            
            if (angle > 2.0) {
                var isIn = label === 'R' ? k.x > refX : k.x < refX;
                ctx.fillStyle = isIn ? "#ff5252" : "#ff9100"; // Red for valgus (in), Orange for varus (out)
                var labelText = (isIn ? "ニーイン " : "ニーアウト ") + angle.toFixed(1) + "°";
                // 2026-08-24: フォント拡大で文字幅が変わるため、実測して
                // 膝関節点からの位置を決める（Rは膝の左に収まるよう終端を
                // 揃え、Lは膝の右から書き始める＝どちらも画面中央寄りに出す
                // という元の意図を、固定オフセットではなく実測ベースで保つ）。
                var textW = ctx.measureText(labelText).width;
                var tx = label === 'R' ? (k.x - textW - 15) : (k.x + 15);
                ctx.fillText(labelText, tx, k.y + 4);
            }
        };
        ctx.save();
        ctx.font = overlayFont(15, true);
        evaluateSide(24, 26, 28, 'R');
        evaluateSide(23, 25, 27, 'L');
        ctx.restore();
    },

    /**
     * Dynamic OHS Side alignment analysis.
     */
    drawOHSSideAnalysis: function(ctx, kps) {
        var lS = kps[11], lH = kps[23], lK = kps[25], lA = kps[27], lW = kps[15];
        var rS = kps[12], rH = kps[24], rK = kps[26], rA = kps[28], rW = kps[16];
        // Focus on the side facing the camera (higher coordinate score)
        var isLeftActive = (lS && rS && lS.score > rS.score);
        var s = isLeftActive ? lS : rS;
        var h = isLeftActive ? lH : rH;
        var k = isLeftActive ? lK : rK;
        var a = isLeftActive ? lA : rA;
        var w = isLeftActive ? lW : rW;

        if (!s || !h || !k || !a || s.score < 0.3 || h.score < 0.3 || k.score < 0.3) return;

        // Trunk inclination from vertical
        var trunkLean = Math.abs(Math.atan2(s.x - h.x, h.y - s.y) * 180 / Math.PI);
        // Knee flexion angle
        var kneeAng = Math.abs((Math.atan2(a.y-k.y, a.x-k.x) - Math.atan2(h.y-k.y, h.x-k.x)) * 180 / Math.PI);
        if (kneeAng > 180) kneeAng = 360 - kneeAng;
        
        ctx.save();
        ctx.font = overlayFont(15, true);

        // Draw trunk lean status
        ctx.fillStyle = trunkLean > 45 ? "#ff5252" : "#39ff14";
        ctx.fillText("体幹前傾: " + trunkLean.toFixed(1) + "°", s.x - 30, s.y - 30);

        // Draw knee flexion status
        ctx.fillStyle = "#00bfff";
        ctx.fillText("膝屈曲: " + kneeAng.toFixed(1) + "°", k.x + 25, k.y + 4);

        // Draw arm alignment relative to trunk
        if (w && w.score > 0.3) {
            var armAng = Math.abs((Math.atan2(w.y-s.y, w.x-s.x) - Math.atan2(h.y-s.y, h.x-s.x)) * 180 / Math.PI);
            if (armAng > 180) armAng = 360 - armAng;
            ctx.fillStyle = armAng < 155 ? "#ff5252" : "#39ff14";
            ctx.fillText("挙上制限: " + armAng.toFixed(1) + "°", s.x + 40, s.y + 20);
            
            ctx.strokeStyle = "rgba(255,255,255,0.4)"; 
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(w.x, w.y); ctx.stroke();
        } 
        ctx.restore();
    },

    /**
     * Stand forward/backward bend flexion analysis.
     */
    drawFlexionAnalysis: function(ctx, kps, mode) {
        var lS = kps[11], lH = kps[23], lK = kps[25], rS = kps[12], rH = kps[24], rK = kps[26];
        var isLeft = (lS && rS && lS.score > rS.score);
        var s = isLeft ? lS : rS;
        var h = isLeft ? lH : rH;
        var k = isLeft ? lK : rK;
        if (!s || !h || !k || s.score < 0.3 || h.score < 0.3) return;

        // Hip flexion angle
        var hipFlexion = Math.abs(Math.atan2(s.y-h.y, s.x-h.x) - Math.atan2(k.y-h.y, k.x-h.x)) * 180 / Math.PI;
        if (hipFlexion > 180) hipFlexion = 360 - hipFlexion;

        ctx.save();
        ctx.font = overlayFont(16, true);
        ctx.fillStyle = "#39ff14";
        var labelText = mode === "dyn_flex_fwd" ? `前屈(股関節屈曲): ${hipFlexion.toFixed(1)}°` : `後屈(股関節伸展): ${hipFlexion.toFixed(1)}°`;
        ctx.fillText(labelText, h.x + 30, h.y - 10);
        ctx.restore();
    },

    /**
     * Shoulder composite mobility analysis.
     */
    drawShoulderAnalysis: function(ctx, kps, mode) {
        var lSh = kps[11], rSh = kps[12], lEl = kps[13], rEl = kps[14], lWr = kps[15], rWr = kps[16];
        var isRightUp = (mode === "dyn_shoulder_r");
        var upWr = isRightUp ? rWr : lWr;
        var loWr = isRightUp ? lWr : rWr;

        if (!upWr || !loWr || upWr.score < 0.3 || loWr.score < 0.3) return;

        // Draw distance line between wrists
        ctx.save();
        ctx.strokeStyle = "#ffeb3b";
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(upWr.x, upWr.y);
        ctx.lineTo(loWr.x, loWr.y);
        ctx.stroke();
        ctx.setLineDash([]);

        var distPx = Math.hypot(upWr.x - loWr.x, upWr.y - loWr.y);
        ctx.fillStyle = "#ffeb3b";
        ctx.font = overlayFont(16, true);
        ctx.textAlign = "center";
        ctx.fillText(`手関節間距離: ${distPx.toFixed(1)} px`, (upWr.x + loWr.x)/2, (upWr.y + loWr.y)/2 - 15);
        ctx.restore();
    },

    /**
     * Draws the background grids and circles for the COP Radar.
     */
    clearRadar: function(ctx, color = "#ff5252") {
        var w = 150, h = 150;
        ctx.clearRect(0, 0, w, h);
        
        // Draw circular grid layers
        ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
        ctx.lineWidth = 1;
        [25, 50, 75].forEach(r => {
            ctx.beginPath();
            ctx.arc(w/2, h/2, r, 0, 2*Math.PI);
            ctx.stroke();
        });

        // Draw cross lines
        ctx.beginPath();
        ctx.moveTo(w/2, 0); ctx.lineTo(w/2, h);
        ctx.moveTo(0, h/2); ctx.lineTo(w, h/2);
        ctx.stroke();
    },

    /**
     * Draws the 95% confidence ellipse on the radar canvas based on coordinate history.
     */
    drawSwayEllipse: function(ctx, history, color = "#ff5252") {
        if (history.length < 5) return;
        var w = 150, h = 150;
        
        // Calculate average
        var sumX = 0, sumY = 0;
        history.forEach(p => { sumX += p.x; sumY += p.y; });
        var avgX = sumX / history.length;
        var avgY = sumY / history.length;

        // Calculate variance and covariance
        var varX = 0, varY = 0, covXY = 0;
        history.forEach(p => {
            var diffX = p.x - avgX;
            var diffY = p.y - avgY;
            varX += diffX * diffX;
            varY += diffY * diffY;
            covXY += diffX * diffY;
        });
        var N = history.length;
        varX /= N;
        varY /= N;
        covXY /= N;

        // Calculate eigenvalues for ellipse axes
        // Trace and determinant of covariance matrix
        var tr = varX + varY;
        var det = varX * varY - covXY * covXY;
        
        // Eigenvalues lambda_1, lambda_2 = (tr +- sqrt(tr^2 - 4 * det)) / 2
        var term = Math.sqrt(Math.max(0, tr * tr - 4 * det));
        var lambda1 = (tr + term) / 2;
        var lambda2 = (tr - term) / 2;

        // Axis radii (using 2.447 standard deviations for 95% confidence ellipse)
        var scale = 2.447;
        var rX = scale * Math.sqrt(Math.max(0, lambda1));
        var rY = scale * Math.sqrt(Math.max(0, lambda2));

        // Angle of rotation (primary eigenvector angle)
        var angle = 0;
        if (covXY !== 0) {
            angle = 0.5 * Math.atan2(2 * covXY, varX - varY);
        } else if (varX < varY) {
            angle = Math.PI / 2;
        }

        // Draw ellipse
        ctx.save();
        ctx.translate(w/2 + avgX, h/2 + avgY);
        ctx.rotate(angle);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        // Limit maximum size on display radar (max radius 70px)
        ctx.ellipse(0, 0, Math.min(70, rX), Math.min(70, rY), 0, 0, 2*Math.PI);
        ctx.stroke();

        // Fill transparent color
        ctx.fillStyle = color === "#ff5252" ? "rgba(255, 82, 82, 0.1)" : "rgba(57, 255, 20, 0.1)";
        ctx.fill();
        ctx.restore();
    },

    /**
     * Appends COP position and redraws radar with sway path.
     * 2026-08-25変更: 従来の独自簡易計算（roll補正なし・pxの％値ベース）を
     * 廃止し、下のcomputeCopOffsetMm()（js/api.jsのextractMetrics()と共通）
     * を使うようにし��。mm単位の結果を、150x150pxのウィジェットに収まる
     * 固定倍率（PX_PER_MM）でpx換算するだけで、drawSwayEllipse等の既存の
     * 描画コードは（swayHistoryの中身がpxオフセットである前提のまま）
     * 変更していない。
     * @param {Object} [copCtx] - computeCopOffsetMm()に渡すコンテキスト
     *   （{rollDeg, canvasWidth, canvasHeight, floorHomography, pxToCmRatio}）。
     *   未指定の場合はroll補正・実測mm換算なしの状態（=pxToCmRatioが無ければ
     *   算出不可）になる。
     */
    updateRadar: function(kps, canvasRadar, ctxRadar, swayHistory, isRecording, color = "#ff5252", copCtx) {
        var pos = computeCopOffsetMm(kps, copCtx);
        if (!pos) return;

        // mm単位のCOPオフセットを、ウィジェット表示用の固定倍率でpxに変換する。
        // レポート側(renderCopTrajectoryImage)は軌跡全体を見てから自動で
        // 目盛りを決めるが、こちらはリアルタイムに点が増えていくウィジェット
        // のため、逐次リスケールによる見た目のガクつきを避け固定倍率にしている。
        var PX_PER_MM = 1.2;
        var rx = pos.x * PX_PER_MM;
        var ry = pos.y * PX_PER_MM;

        // Append to history
        if (isRecording) {
            swayHistory.push({ x: rx, y: ry });
            // Maintain max historical points
            if (swayHistory.length > 250) swayHistory.shift();
        }

        // Draw radar
        this.clearRadar(ctxRadar, color);
        var w = 150, h = 150;

        // Draw historical sway path line
        if (swayHistory.length > 1) {
            ctxRadar.save();
            ctxRadar.strokeStyle = color === "#ff5252" ? "rgba(255, 82, 82, 0.4)" : "rgba(57, 255, 20, 0.4)";
            ctxRadar.lineWidth = 1.5;
            ctxRadar.beginPath();
            ctxRadar.moveTo(w/2 + swayHistory[0].x, h/2 + swayHistory[0].y);
            for (var i = 1; i < swayHistory.length; i++) {
                ctxRadar.lineTo(w/2 + swayHistory[i].x, h/2 + swayHistory[i].y);
            }
            ctxRadar.stroke();
            ctxRadar.restore();
            
            // Draw ellipse
            this.drawSwayEllipse(ctxRadar, swayHistory, color);
        }

        // Current real-time COP pointer dot
        ctxRadar.save();
        ctxRadar.fillStyle = "#fff";
        ctxRadar.beginPath();
        ctxRadar.arc(w/2 + rx, h/2 + ry, 4.5, 0, 2*Math.PI);
        ctxRadar.fill();
        ctxRadar.strokeStyle = color;
        ctxRadar.lineWidth = 1.5;
        ctxRadar.stroke();
        ctxRadar.restore();
    },

    // 2026-08-19削除: 骨盤傾斜・肩の高さ差・膝の内外側偏位といった数値から
    // 「筋肉の緊張度合い（過緊張/筋力低下）」を推定して色分け表示していた
    // drawMuscleSegment()・drawMusculoskeletalAnatomy()は、企画者から
    // 「不要なのでロジックごと削除してほしい」とのご要望があり撤去した。
    // 呼び出し側（js/ui/controls.jsのrenderPlaybackFrame・refreshReportView）
    // も合わせて削除済み。ライブ撮影中の描画（js/core/camera.jsのrender()）
    // はこの関数を元々呼んでおらず、静止姿勢の撮影完了後の確認・再生画面
    // でのみ表示されていた機能だった。

    /**
     * 2026-08-24追加: 帳票（レポート）にCOP重心動揺の軌跡を絵として埋め込む
     * ための画像を生成する。撮影中に見える丸いレーダーウィジェット
     * （updateRadar/clearRadar）は撮影画面限定で帳票には含まれていなかった
     * ため、企画者から「帳票にも軌跡の絵を入れてほしい。目盛りに単位も
     * 入れてほしい」とのご要望があり追加した。時間軸の表現（グラデーション
     * 等）は不要で、単純にジグザグの経路を描くだけでよいとのご指示のため、
     * 時系列の色分けは行わない。
     * @param {Array} trajectory - [{x, y}, ...]（js/api.jsのextractMetrics()
     *   が返すmetrics.swayMetrics.trajectory。単位はmm、中心=0,0）
     * @param {boolean} precise - true: 4隅ArUco床面実測（実寸mm）
     *   false: pxToCmRatioによる近似換算（参考値）
     * @returns {string|null} PNGのdata URL。trajectoryが無ければnull。
     */
    renderCopTrajectoryImage: function(trajectory, precise) {
        if (!trajectory || trajectory.length < 2) return null;

        var size = 320;
        var canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        var ctx = canvas.getContext('2d');
        var cx = size / 2, cy = size / 2;

        // 背景
        ctx.fillStyle = '#0b1220';
        ctx.fillRect(0, 0, size, size);

        // 軌跡の広がりに応じて、目盛り間隔(mm)を自動で決める（±10/20/50/100mm等）。
        var maxAbs = 1;
        trajectory.forEach(function (p) {
            maxAbs = Math.max(maxAbs, Math.abs(p.x), Math.abs(p.y));
        });
        var candidateSteps = [2, 5, 10, 20, 50, 100, 200, 500];
        var ringStepMm = candidateSteps[candidateSteps.length - 1];
        for (var i = 0; i < candidateSteps.length; i++) {
            if (maxAbs <= candidateSteps[i] * 2.2) { ringStepMm = candidateSteps[i]; break; }
        }
        var maxRingMm = ringStepMm * 3; // 3本の目盛りリングで固定
        var pxPerMm = ((size / 2) - 28) / maxRingMm; // 端に余白(ラベル分)を残す

        // 目盛りリング＋ラベル（mm）
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'left';
        ctx.lineWidth = 1;
        for (var r = 1; r <= 3; r++) {
            var ringPx = ringStepMm * r * pxPerMm;
            ctx.beginPath();
            ctx.arc(cx, cy, ringPx, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.fillText((ringStepMm * r) + "mm", cx + 4, cy - ringPx - 3);
        }

        // 中心の十字線
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.beginPath();
        ctx.moveTo(cx, 28); ctx.lineTo(cx, size - 28);
        ctx.moveTo(28, cy); ctx.lineTo(size - 28, cy);
        ctx.stroke();

        // 軌跡（ジグザグの経路をそのまま描画。時間軸の表現はしない）
        ctx.strokeStyle = precise ? 'rgba(57, 255, 20, 0.85)' : 'rgba(255, 82, 82, 0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        trajectory.forEach(function (p, idx) {
            var px = cx + p.x * pxPerMm;
            var py = cy + p.y * pxPerMm;
            if (idx === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();

        // 中心（平均位置ではなく画像中心=0,0であることを示す小さな点）
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.beginPath();
        ctx.arc(cx, cy, 2.5, 0, 2 * Math.PI);
        ctx.fill();

        // 精度の注記（近似値の場合のみ）
        if (!precise) {
            ctx.fillStyle = 'rgba(255,255,255,0.45)';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('参考値（pxToCmRatioによる近似換算）', cx, size - 10);
        }

        return canvas.toDataURL('image/png');
    }
};

/**
 * 端末の傾き（roll。左右方向の水平からのズレ＝正中線のズレ）を補正するため、
 * キーポイント全体を画像中心を軸に回転させる。
 * ---------------------------------------------------------------------------
 * 手持ちで静止4方向を撮影する場合、必ず多少なりとも端末が傾く。荷重左右比率
 * （calculateWeightBearing）のように「画像のX軸＝実際の左右方向」という
 * 前提でピクセル座標を直接比較する指標は、この傾きの影響をそのまま受けて
 * しまい、実際は左右均等でも非対称に見えてしまう問題があった
 * （2026-07-29ご指摘、v4.6.20で対応）。
 * ジャイロから実測できたroll角度（state.deviceOrientation.gamma）が
 * 分かっている場合、その分だけ座標を逆回転させてから指標計算に使うことで、
 * 実際に構えていた角度に関わらず「まっすぐ水平に構えた場合」に近い座標に
 * 補正できる。
 * なお、膝・股関節などの関節角度（2本の線分の向きの差分で計算する指標）は
 * 画像全体が同じ角度だけ回転しても差分自体は変わらないため、この補正の
 * 対象外で問題ない（対象は「絶対的な垂直・水平を基準にする」指標のみ）。
 * @param {Array} kps - 元のキーポイント配列（{x,y,score,name,...}[]）
 * @param {number} rollDeg - 撮影時に実測されたroll角度（度）。0/null/undefined/
 *   非数値の場合は無補正でそのまま返す。
 * @param {number} w - 画像（canvas）の幅
 * @param {number} h - 画像（canvas）の高さ
 * @returns {Array} 回転補正後の新しいキーポイント配列（元の配列・要素は
 *   変更しない＝呼び出し側の元データは壊さない）
 */
export function rotateKeypointsForRoll(kps, rollDeg, w, h) {
    if (!kps || !rollDeg || !isFinite(rollDeg) || !w || !h) return kps;
    var rad = -rollDeg * Math.PI / 180;
    var cos = Math.cos(rad), sin = Math.sin(rad);
    var cx = w / 2, cy = h / 2;
    return kps.map(function (kp) {
        if (!kp) return kp;
        var dx = kp.x - cx, dy = kp.y - cy;
        var rotated = Object.assign({}, kp);
        rotated.x = cx + dx * cos - dy * sin;
        rotated.y = cy + dx * sin + dy * cos;
        return rotated;
    });
}

/**
 * 2026-08-25追加: js/api.jsのextractMetrics()が帳票用のCOP軌跡
 * （swayMetrics.trajectory）を計算するのと全く同じロジック（roll補正→
 * 4隅ArUco床面実測があればそれを最優先、無ければpxToCmRatioによる
 * mm近似換算）を1フレーム分について行う共通関数。
 *
 * 背景: 撮影確認画面の丸いレーダーウィジェット（この下のupdateRadar）は、
 * 従来「roll補正なし・pxの％値に見た目合わせの倍率をかけただけ」の簡易
 * 計算を独自に行っており、帳票に埋め込まれる軌跡画像
 * （extractMetrics→renderCopTrajectoryImage、実寸mm・roll補正済み）とは
 * 別物だった。企画者から「最後まで再生して見比べても整合性が無い。
 * 整合性が無いとアプリの信頼性に響くので同じ軌跡を共有したい」との
 * ご指摘があり、両者が同じ計算結果（mm単位のCOPオフセット）を参照する
 * ように、この関数へ一本化した（api.js側もこの関数を呼ぶよう書き換え済み。
 * rotateKeypointsForRollと同じくrotateKeypointsForRoll/computeCopOffsetMm
 * の両方をbiomechanics.jsから名前付きexportし、api.js側でimportしている）。
 *
 * js/core/arucoCalibration.jsのapplyHomography()と全く同じ行列演算だが、
 * biomechanics.js→arucoCalibration.js→camera.js→biomechanics.jsという
 * 循環importになってしまうためimportはせず、ここに複製している
 * （純粋な行列演算のみで依存が無く、変更頻度も低いためコード重複の
 * デメリットより循環import回避のメリットを優先した）。
 *
 * @param {Array} kps - 1フレーム分の骨格点配列（roll補正前の生ピクセル座標）
 * @param {Object} ctx - {
 *   rollDeg: number|null,           // session.capturedRollDeg相当
 *   canvasWidth: number|null,       // session.canvasWidth相当
 *   canvasHeight: number|null,      // session.canvasHeight相当
 *   floorHomography: Array|null,    // session.floorHomography相当（8要素）
 *   pxToCmRatio: number|null        // session.pxToCmRatio相当
 * }
 * @returns {{x:number, y:number}|null} mm単位のCOPオフセット
 *   （4隅ArUco実測時はX=左右・Y=前後の実2軸、近似時は単眼カメラでは
 *   奥行きを観測できないためX=Y=左右方向の変位を複製した値。
 *   extractMetrics()の既存の仕様と同一）。算出不可ならnull。
 */
export function computeCopOffsetMm(kps, ctx) {
    if (!kps) return null;
    ctx = ctx || {};

    var fkps = kps;
    if (typeof ctx.rollDeg === 'number' && ctx.canvasWidth && ctx.canvasHeight) {
        fkps = rotateKeypointsForRoll(fkps, ctx.rollDeg, ctx.canvasWidth, ctx.canvasHeight);
    }

    function findKp(name, numName) {
        return fkps.find(function (k) { return k && (k.name === name || k.name === numName); });
    }

    var lAnkle = findKp('left_ankle', '27');
    var rAnkle = findKp('right_ankle', '28');
    var nose = findKp('nose', '0');
    var lSh = findKp('left_shoulder', '11');
    var rSh = findKp('right_shoulder', '12');
    var lHip = findKp('left_hip', '23');
    var rHip = findKp('right_hip', '24');

    if (!lAnkle || !rAnkle || (lAnkle.score || 0) < 0.3 || (rAnkle.score || 0) < 0.3) return null;
    if (!nose || !lSh || !rSh || !lHip || !rHip) return null;

    var dPx = rAnkle.x - lAnkle.x;
    if (Math.abs(dPx) <= 5) return null;

    if (ctx.floorHomography && ctx.floorHomography.length === 8) {
        var h = ctx.floorHomography;
        var midX = (lAnkle.x + rAnkle.x) / 2;
        var midY = (lAnkle.y + rAnkle.y) / 2;
        var denom = h[6] * midX + h[7] * midY + 1;
        if (Math.abs(denom) < 1e-9) return null;
        return {
            x: (h[0] * midX + h[1] * midY + h[2]) / denom,
            y: (h[3] * midX + h[4] * midY + h[5]) / denom
        };
    } else if (ctx.pxToCmRatio) {
        var upperComX = (nose.x * 0.20) + (((lSh.x + rSh.x) / 2) * 0.80);
        var lowerComX = (lHip.x + rHip.x) / 2;
        var totalComX = (upperComX * 0.6) + (lowerComX * 0.4);
        var ankleMidX = (lAnkle.x + rAnkle.x) / 2;
        var offsetMm = (totalComX - ankleMidX) * ctx.pxToCmRatio * 10; // cm/px×10=mm/px
        return { x: offsetMm, y: offsetMm };
    }
    return null;
}

/**
 * 2026-08-25追加: 「クリーンな写真」（骨格線等の重ね書き無し、js/core/
 * camera.jsのcaptureCleanVideoFrame参照）に、指定のdrawFnコールバック
 * （通常はjs/ui/controls.jsのdrawPoseOverlay）で骨格オーバーレイを重ね描き
 * してから1枚のstatic画像として書き出す。renderUprightPhoto()と同じ
 * roll回転ロジックを続けて適用できるが、写真の回転前（生ピクセル座標のまま）
 * にオーバーレイを重ねてから、写真とオーバーレイをまとめて回転させる点が
 * 異なる（骨格点の座標自体は回転させない。renderUprightPhoto()を写真単体に
 * 使っていた旧方式だと、写真だけを先に回してしまい、無回転のまま重ねる
 * 骨格点とズレて「線が二重に・ズレて重なる」不具合になるため）。
 * @param {string} imageDataUrl - 背景に敷く「クリーンな写真」（base64 data URL）。falsyならnullを返す。
 * @param {function(CanvasRenderingContext2D, number, number)} drawFn - 写真と同じ
 *   解像度のcanvas contextへ、生ピクセル座標のままオーバーレイを描くコールバック。
 * @param {number|null} rollDeg - renderUprightPhotoと同じ意味（回転角度）。
 * @returns {Promise<string|null>} オーバーレイ＋（必要なら）回転を適用した後のdata URL。
 */
biomechanics.renderPhotoWithOverlay = function (imageDataUrl, drawFn, rollDeg) {
    return new Promise(function (resolve) {
        if (!imageDataUrl) { resolve(null); return; }
        var img = new Image();
        img.onload = function () {
            try {
                var w = img.naturalWidth || img.width;
                var h = img.naturalHeight || img.height;
                if (!w || !h) { resolve(imageDataUrl); return; }

                var flatCanvas = document.createElement('canvas');
                flatCanvas.width = w;
                flatCanvas.height = h;
                var fctx = flatCanvas.getContext('2d');
                fctx.drawImage(img, 0, 0, w, h);
                if (typeof drawFn === 'function') {
                    try { drawFn(fctx, w, h); } catch (eDraw) {
                        console.error('[biomechanics] renderPhotoWithOverlayのdrawFnでエラー:', eDraw);
                    }
                }

                if (typeof rollDeg !== 'number' || !isFinite(rollDeg) || Math.abs(rollDeg) < 0.05) {
                    resolve(flatCanvas.toDataURL('image/jpeg', 0.9));
                    return;
                }

                // 以下、renderUprightPhotoと全く同じ回転ロジック（写真単体では
                // なく、上でオーバーレイを重ね終えたflatCanvasごと回転させる）。
                var rad = -rollDeg * Math.PI / 180;
                var absCos = Math.abs(Math.cos(rad)), absSin = Math.abs(Math.sin(rad));
                var newW = Math.ceil(w * absCos + h * absSin);
                var newH = Math.ceil(w * absSin + h * absCos);
                var canvas = document.createElement('canvas');
                canvas.width = newW;
                canvas.height = newH;
                var ctx = canvas.getContext('2d');
                ctx.fillStyle = '#050811';
                ctx.fillRect(0, 0, newW, newH);
                ctx.save();
                ctx.translate(newW / 2, newH / 2);
                ctx.rotate(rad);
                ctx.drawImage(flatCanvas, -w / 2, -h / 2, w, h);
                ctx.restore();
                resolve(canvas.toDataURL('image/jpeg', 0.9));
            } catch (e) {
                console.error('[biomechanics] renderPhotoWithOverlay failed, falling back to plain photo:', e);
                resolve(imageDataUrl);
            }
        };
        img.onerror = function () {
            resolve(imageDataUrl);
        };
        img.src = imageDataUrl;
    });
};

/**
 * 2026-08-24追加: 静止4方向の撮影写真（骨格オーバーレイ込みでcanvasから
 * 書き出したJPEG）を、キャリブレーションで分かっているカメラのroll角度
 * （rotateKeypointsForRollが荷重左右比率等の数値を補正するのと全く同じ
 * 角度・同じ回転方向）ぶんだけ回転させ、見た目の垂直を実際の垂直に近づける。
 * 「カメラの傾きぶん写真を回転させて違和感を無くしたい」というご要望への
 * 対応。四隅が欠けないよう、回転後の外接矩形サイズへcanvasを拡張し、
 * はみ出す部分は背景色で余白（レターボックス）にする（トリミングしない
 * 方針で企画者確認済み）。
 * @param {string} imageDataUrl - 元の写真（base64 data URL）。falsyならnullを返す。
 * @param {number|null} rollDeg - 撮影時点のroll角度（度）。0/null/undefined/
 *   非数値、または小さすぎて視覚的に無意味な角度（0.05度未満）の場合は
 *   回転せず元画像をそのまま返す。
 * @returns {Promise<string|null>} 回転後（または元のまま）のdata URLを解決する
 *   Promise。画像の読み込み・描画に失敗した場合は元のdata URLにフォールバックする。
 */
biomechanics.renderUprightPhoto = function (imageDataUrl, rollDeg) {
    return new Promise(function (resolve) {
        if (!imageDataUrl) { resolve(imageDataUrl || null); return; }
        if (typeof rollDeg !== 'number' || !isFinite(rollDeg) || Math.abs(rollDeg) < 0.05) {
            resolve(imageDataUrl);
            return;
        }
        var img = new Image();
        img.onload = function () {
            try {
                var w = img.naturalWidth || img.width;
                var h = img.naturalHeight || img.height;
                if (!w || !h) { resolve(imageDataUrl); return; }
                // rotateKeypointsForRollと同じ符号・同じ回転方向（rad = -rollDeg）
                // に揃える。座標側と画像側を同じ方向に回すことで、両者を重ねた
                // 時に一致する（意味的な整合性の担保）。
                var rad = -rollDeg * Math.PI / 180;
                var absCos = Math.abs(Math.cos(rad)), absSin = Math.abs(Math.sin(rad));
                var newW = Math.ceil(w * absCos + h * absSin);
                var newH = Math.ceil(w * absSin + h * absCos);
                var canvas = document.createElement('canvas');
                canvas.width = newW;
                canvas.height = newH;
                var ctx = canvas.getContext('2d');
                // レターボックス部分の塗り色は、アプリのダークテーマの背景色に
                // 合わせる（renderCopTrajectoryImageの背景色とも近い濃紺〜黒系）。
                ctx.fillStyle = '#050811';
                ctx.fillRect(0, 0, newW, newH);
                ctx.save();
                ctx.translate(newW / 2, newH / 2);
                ctx.rotate(rad);
                ctx.drawImage(img, -w / 2, -h / 2, w, h);
                ctx.restore();
                resolve(canvas.toDataURL('image/jpeg', 0.9));
            } catch (e) {
                console.error('[biomechanics] renderUprightPhoto failed, falling back to original image:', e);
                resolve(imageDataUrl);
            }
        };
        img.onerror = function () {
            resolve(imageDataUrl);
        };
        img.src = imageDataUrl;
    });
};

export default biomechanics;
