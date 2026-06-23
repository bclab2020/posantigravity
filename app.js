/* =============================================================
 * CONNECT AI - Posture & Movement Analytics Engine (app.js)
 * High-Performance Kinematics, Calibration, & IndexedDB Storage
 * ============================================================= */

// --- 1. Global Constants & Configuration ---
const DURATION_MAP = {
    'front': 5000,
    'back': 5000,
    'l_side': 5000,
    'r_side': 5000,
    'dyn_overhead': 10000,
    'dyn_overhead_side': 10000,
    'dyn_single_r': 15000,
    'dyn_single_l': 15000,
    'dyn_flex_fwd': 10000,
    'dyn_flex_bwd': 10000,
    'dyn_shoulder_r': 8000,
    'dyn_shoulder_l': 8000
};

const MODE_NAMES = {
    'front': '🧍 静的姿勢: 前面',
    'back': '🧍 静的姿勢: 後面',
    'l_side': '🧍 静的姿勢: 左側面',
    'r_side': '🧍 静的姿勢: 右側面',
    'dyn_overhead': '🏋️ OHS (前面オーバーヘッドスクワット)',
    'dyn_overhead_side': '🏋️ OHS (側面オーバーヘッドスクワット)',
    'dyn_single_r': '🦵 片脚バランス (右脚軸)',
    'dyn_single_l': '🦵 片脚バランス (左脚軸)',
    'dyn_flex_fwd': '🙇 立位体前屈 (屈曲可動性)',
    'dyn_flex_bwd': '🤸 立位体後屈 (伸展可動性)',
    'dyn_shoulder_r': '👐 肩複合可動性 (右上オーバー)',
    'dyn_shoulder_l': '👐 肩複合可動性 (左上オーバー)'
};

// BlazePose Keypoints Mapping
const BLAZEPOSE_KEYPOINTS = [
    'nose', 'left_eye_inner', 'left_eye', 'left_eye_outer', 'right_eye_inner', 'right_eye', 'right_eye_outer',
    'left_ear', 'right_ear', 'mouth_left', 'mouth_right', 'left_shoulder', 'right_shoulder',
    'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist', 'left_pinky', 'right_pinky', 'left_index', 'right_index',
    'left_thumb', 'right_thumb', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
    'left_heel', 'right_heel', 'left_foot_index', 'right_foot_index'
];

// UI Settings & App State Variables
let detector = null;
let isRunning = false;
let isRecording = false;
let isPausedForEdit = false;
let currentTab = "front";
let appMode = "camera"; // "camera" or "playback"
let isPlaying = false;
let currentStream = null;

let playbackDataMP = [];
let recordingDuration = 5000;
let poseDataLog = []; // Stores keypoints over time during recording
let playbackRafId = null;
let cameraRafId = null;

let pxToCmRatio = null; // scale factor
let estimatedPelvicTilt = 0; // calculated in degrees
let calibState = "idle"; // "idle", "wait_left", "wait_right", "adjust_left", "adjust_right"
let calibrationPoints = [];

let playbackStartTime = 0;
let playbackBaseTime = 0;
let playbackTotalDuration = 0;

let selectedJointIndex = null;
let dpadStepVal = 1;
let isEditingPlaybackFrame = false;
let swayHistoryMP = [];
let chartInstance = null;

window.customOriginMarkers = {};
window.reportDataStore = {};
window.currentAnchorPos = null;

// Initialize custom markers and data store
Object.keys(DURATION_MAP).forEach(dir => {
    window.reportDataStore[dir] = null;
    window.customOriginMarkers[dir] = null;
});

// UI Elements References
const video = document.getElementById('video');
const canvasMP = document.getElementById('canvasMP');
const ctxMP = canvasMP.getContext('2d');
const ctxRadarMP = document.getElementById('canvasRadarMP').getContext('2d');
const startBtn = document.getElementById('startBtn');
const recBtn = document.getElementById('recBtn');
const pelvicTiltSlider = document.getElementById('pelvicTiltSlider');
const tiltValDisplay = document.getElementById('tiltValDisplay');
const tiltPanel = document.getElementById('tiltPanel');
const infoPanel = document.getElementById('infoPanel');
const timerDisplay = document.getElementById('timerDisplay');
const dpadPanel = document.getElementById('dpadPanel');
const historyPanel = document.getElementById('historyPanel');
const historyListContainer = document.getElementById('historyListContainer');
const playbackControls = document.getElementById('playbackControls');
const mainControls = document.getElementById('mainControls');
const durationSelect = document.getElementById('durationSelect');
const timelineSlider = document.getElementById('timelineSlider');
const frameCounter = document.getElementById('frameCounter');
const editFrameBtn = document.getElementById('editFrameBtn');

// --- 2. IndexedDB Session Database Manager ---
const dbManager = {
    dbName: "ConnectAIDB",
    storeName: "sessions",
    db: null,

    init() {
        return new Promise((resolve) => {
            const req = indexedDB.open(this.dbName, 1);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: "id" });
                }
            };
            req.onsuccess = e => {
                this.db = e.target.result;
                resolve();
            };
            req.onerror = () => {
                console.error("IndexedDB initialization failed.");
                resolve();
            };
        });
    },

    saveSession(data) {
        return new Promise((resolve) => {
            if (!this.db) { resolve(); return; }
            const tx = this.db.transaction([this.storeName], "readwrite");
            const store = tx.objectStore(this.storeName);
            store.put(data);
            tx.oncomplete = () => resolve();
        });
    },

    getAllSessions() {
        return new Promise((resolve) => {
            if (!this.db) { resolve([]); return; }
            const tx = this.db.transaction([this.storeName], "readonly");
            const store = tx.objectStore(this.storeName);
            const req = store.getAll();
            req.onsuccess = e => {
                const list = e.target.result || [];
                resolve(list.sort((a, b) => b.timestamp - a.timestamp));
            };
            req.onerror = () => resolve([]);
        });
    },

    deleteSession(id) {
        return new Promise((resolve) => {
            if (!this.db) { resolve(); return; }
            const tx = this.db.transaction([this.storeName], "readwrite");
            const store = tx.objectStore(this.storeName);
            store.delete(id).onsuccess = () => resolve();
        });
    }
};

// --- 3. Dynamic Biomechanical Calculations & Analysis ---

/**
 * Automatically estimates pelvic tilt angle based on joint positions (AI Kinematics Prediction)
 */
function estimatePelvicTiltAutomatically(kps) {
    const getK = name => kps.find(k => k.name === name || k.name === BLAZEPOSE_KEYPOINTS.indexOf(name).toString());
    
    const isLeft = currentTab === 'l_side' || currentTab === 'dyn_overhead_side' || currentTab === 'dyn_single_l';
    const dir = isLeft ? -1 : 1;

    const sh = isLeft ? getK('left_shoulder') : getK('right_shoulder');
    const hip = isLeft ? getK('left_hip') : getK('right_hip');
    const knee = isLeft ? getK('left_knee') : getK('right_knee');
    const ankle = isLeft ? getK('left_ankle') : getK('right_ankle');

    if (!sh || !hip || !knee || !ankle || sh.score < 0.3 || hip.score < 0.3 || knee.score < 0.3 || ankle.score < 0.3) {
        return 0; // Return neutral if landmarks aren't clear
    }

    const scale = pxToCmRatio || 0.15;
    
    // 1. Pelvic Sway: Horizontal displacement between hip and ankle (in cm)
    const swayCm = (hip.x - ankle.x) * scale * dir;

    // 2. Torso lean angle (hip to shoulder line relative to absolute vertical in degrees)
    const torsoAngle = Math.atan2(sh.x - hip.x, hip.y - sh.y) * 180 / Math.PI;

    // 3. Thigh lean angle (hip to knee line relative to absolute vertical in degrees)
    const thighAngle = Math.atan2(knee.x - hip.x, hip.y - knee.y) * 180 / Math.PI;

    // Biomechanical Correlation Formula
    // Normal neutral pelvic tilt is ~10 degrees anterior.
    // Increased anterior tilt is correlated with knee hyperextension (knee pushed back relative to hip-ankle line)
    // and torso leaning forward relative to thigh. Posterior swayback tilt is correlated with hip translated forward.
    const baseTilt = 8; // base degrees
    const swayFactor = -0.5; // forward hip sway decreases anterior tilt (goes posterior)
    const curveFactor = 0.35; // difference between torso and thigh angle

    let calculatedTilt = baseTilt + (swayCm * swayFactor) + ((torsoAngle - thighAngle) * curveFactor);

    // Bound output to realistic anatomical ranges (-20 to +30 degrees)
    calculatedTilt = Math.max(-20, Math.min(30, calculatedTilt));
    return Math.round(calculatedTilt);
}

/**
 * Calculates Pelvic Tilt from manually adjusted ASIS and Hip landmarks
 */
function recalculatePelvicTiltFromASIS(asisKp, hipKp) {
    if (!asisKp || !hipKp) return;
    const isLeft = currentTab === 'l_side' || currentTab === 'dyn_overhead_side' || currentTab === 'dyn_single_l';
    const dir = isLeft ? -1 : 1;

    // Angle of hip-to-ASIS vector relative to horizontal plane
    const angleRad = Math.atan2(hipKp.y - asisKp.y, (asisKp.x - hipKp.x) * dir);
    const angleDeg = angleRad * 180 / Math.PI;

    // Anatomical normal Hip-to-ASIS line is ~55 degrees above horizontal
    const calculatedTilt = Math.round(angleDeg - 55);
    estimatedPelvicTilt = Math.max(-20, Math.min(30, calculatedTilt));

    // Sync to pelvic tilt slider
    pelvicTiltSlider.value = estimatedPelvicTilt;
    updatePelvicTiltDisplay();
}

/**
 * Generates virtual ASIS points by projecting from the hip joint
 * relative to the torso vector (Torso-Relative Local Coordinate System)
 */
function generateVirtualASIS(kps) {
    if (!kps) return kps;

    const isLeft = currentTab === 'l_side' || currentTab === 'dyn_overhead_side' || currentTab === 'dyn_single_l';
    const dir = isLeft ? -1 : 1;

    const getK = name => kps.find(k => k.name === name || k.name === BLAZEPOSE_KEYPOINTS.indexOf(name).toString());
    const hip = isLeft ? getK('left_hip') : getK('right_hip');
    const sh = isLeft ? getK('left_shoulder') : getK('right_shoulder');

    const height = parseFloat(document.getElementById('patientHeight').value) || 170;
    const scale = pxToCmRatio || 0.15;
    
    // Distance from greater trochanter (hip) to ASIS is ~8.5% of body height
    const distCm = height * 0.085;
    const distPx = distCm / scale;

    // If side view, project along torso vector
    if ((currentTab === 'l_side' || currentTab === 'r_side' || currentTab === 'dyn_overhead_side') && hip && sh && hip.score > 0.3 && sh.score > 0.3) {
        // Torso vector
        const tx = sh.x - hip.x;
        const ty = sh.y - hip.y;
        const distT = Math.hypot(tx, ty);

        if (distT > 5) {
            // Normalized upward torso vector
            const ux = tx / distT;
            const uy = ty / distT;

            // Normalized perpendicular forward vector (faces front based on view direction)
            const fx = -uy * dir;
            const fy = ux * dir;

            // Anatomy angle offset from torso line: normal neutral ASIS is ~35 degrees forward/up
            const angleDeg = 35 + estimatedPelvicTilt;
            const angleRad = angleDeg * Math.PI / 180;

            const upOffset = distPx * Math.cos(angleRad);
            const fwdOffset = distPx * Math.sin(angleRad);

            const asisX = hip.x + (upOffset * ux) + (fwdOffset * fx);
            const asisY = hip.y + (upOffset * uy) + (fwdOffset * fy);

            const asisL = { x: asisX, y: asisY, score: 1.0, name: 'virtual_asis_l' };
            const asisR = { x: asisX, y: asisY, score: 1.0, name: 'virtual_asis_r' };

            const cleanKps = kps.filter(k => k.name !== 'virtual_asis_l' && k.name !== 'virtual_asis_r');
            cleanKps.push(asisL, asisR);
            return cleanKps;
        }
    }

    // Fallback for frontal view
    const angleRad = (45 - estimatedPelvicTilt) * (Math.PI / 180);
    const upwardOffsetPx = distPx * Math.sin(angleRad);
    const forwardOffsetPx = distPx * Math.cos(angleRad);

    const lHip = getK('left_hip');
    const rHip = getK('right_hip');

    if (lHip && rHip && lHip.score > 0.3 && rHip.score > 0.3) {
        const asisL = { x: lHip.x, y: lHip.y - upwardOffsetPx, score: 1.0, name: 'virtual_asis_l' };
        const asisR = { x: rHip.x, y: rHip.y - upwardOffsetPx, score: 1.0, name: 'virtual_asis_r' };

        if (currentTab === 'r_side') { asisL.x += forwardOffsetPx; asisR.x += forwardOffsetPx; }
        else if (currentTab === 'l_side') { asisL.x -= forwardOffsetPx; asisR.x -= forwardOffsetPx; }

        const cleanKps = kps.filter(k => k.name !== 'virtual_asis_l' && k.name !== 'virtual_asis_r');
        cleanKps.push(asisL, asisR);
        return cleanKps;
    }

    return kps;
}

/**
 * Calculates angle between three joints (in degrees)
 */
function getJointAngle(p1, center, p2) {
    if (!p1 || !center || !p2 || p1.score < 0.1 || center.score < 0.1 || p2.score < 0.1) return null;
    const rad = Math.atan2(p2.y - center.y, p2.x - center.x) - Math.atan2(p1.y - center.y, p1.x - center.x);
    let deg = Math.abs(rad * 180 / Math.PI);
    if (deg > 180) deg = 360 - deg;
    return deg;
}

// --- 4. Main Rendering and Skeleton Drawing ---

function drawSkeleton(ctx, kps, color) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";

    const getK = name => kps.find(k => k.name === name || k.name === BLAZEPOSE_KEYPOINTS.indexOf(name).toString());
    
    // Bones connections mapping
    const bones = [
        ['left_shoulder', 'right_shoulder'],
        ['left_shoulder', 'left_hip'],
        ['right_shoulder', 'right_hip'],
        ['left_hip', 'right_hip'],
        ['left_shoulder', 'left_elbow'],
        ['left_elbow', 'left_wrist'],
        ['right_shoulder', 'right_elbow'],
        ['right_elbow', 'right_wrist'],
        ['left_hip', 'left_knee'],
        ['left_knee', 'left_ankle'],
        ['right_hip', 'right_knee'],
        ['right_knee', 'right_ankle']
    ];

    bones.forEach(([p1Name, p2Name]) => {
        const p1 = getK(p1Name);
        const p2 = getK(p2Name);
        if (p1 && p2 && p1.score > 0.2 && p2.score > 0.2) {
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
        }
    });

    // Draw joints
    kps.forEach(kp => {
        if (kp && kp.score > 0.2 && !kp.name.startsWith('virtual_asis')) {
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(kp.x, kp.y, 5, 0, 2 * Math.PI);
            ctx.fill();
            
            // Add subtle blue ring around major joints
            ctx.strokeStyle = varColor('--accent-cyan');
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(kp.x, kp.y, 8, 0, 2 * Math.PI);
            ctx.stroke();
        }
    });

    // Head center visual alignment
    if (currentTab === 'front' || currentTab === 'back' || currentTab === 'dyn_overhead') {
        const nose = getK('nose');
        const shL = getK('left_shoulder');
        const shR = getK('right_shoulder');
        const earL = getK('left_ear');
        const earR = getK('right_ear');

        if (earL && earR && earL.score > 0.2 && earR.score > 0.2) {
            ctx.strokeStyle = varColor('--accent-yellow');
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(earL.x, earL.y);
            ctx.lineTo(earR.x, earR.y);
            ctx.stroke();

            if (nose && nose.score > 0.2) {
                const radius = Math.hypot(earL.x - earR.x, earL.y - earR.y) * 0.55;
                ctx.strokeStyle = 'rgba(255, 215, 0, 0.4)';
                ctx.beginPath();
                ctx.arc(nose.x, nose.y, radius, 0, 2 * Math.PI);
                ctx.stroke();
            }
        }

        if (nose && shL && shR && nose.score > 0.2 && shL.score > 0.2 && shR.score > 0.2) {
            const shMidX = (shL.x + shR.x) / 2;
            const shMidY = (shL.y + shR.y) / 2;
            ctx.strokeStyle = varColor('--accent-orange');
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(shMidX, shMidY);
            ctx.lineTo(nose.x, nose.y);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }

    // Draw Virtual ASIS markers
    const asisL = getK('virtual_asis_l');
    const asisR = getK('virtual_asis_r');
    const hipL = getK('left_hip');
    const hipR = getK('right_hip');

    if (asisL && hipL && currentTab !== 'r_side' && currentTab !== 'dyn_overhead_side') {
        ctx.strokeStyle = varColor('--accent-green');
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(hipL.x, hipL.y);
        ctx.lineTo(asisL.x, asisL.y);
        ctx.stroke();
        ctx.setLineDash([]);
        
        ctx.fillStyle = varColor('--accent-green');
        ctx.beginPath();
        ctx.arc(asisL.x, asisL.y, 8, 0, 2 * Math.PI);
        ctx.fill();
    }

    if (asisR && hipR && currentTab !== 'l_side' && currentTab !== 'dyn_overhead_side') {
        ctx.strokeStyle = varColor('--accent-green');
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(hipR.x, hipR.y);
        ctx.lineTo(asisR.x, asisR.y);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = varColor('--accent-green');
        ctx.beginPath();
        ctx.arc(asisR.x, asisR.y, 8, 0, 2 * Math.PI);
        ctx.fill();
    }

    if ((currentTab === 'front' || currentTab === 'back') && asisL && asisR) {
        ctx.strokeStyle = 'rgba(57, 255, 20, 0.4)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(asisL.x, asisL.y);
        ctx.lineTo(asisR.x, asisR.y);
        ctx.stroke();

        if (pxToCmRatio) {
            const diffCm = Math.abs(asisL.y - asisR.y) * pxToCmRatio;
            ctx.fillStyle = varColor('--accent-green');
            ctx.font = "bold 14px sans-serif";
            ctx.fillText(`骨盤傾斜高低差: ${diffCm.toFixed(1)} cm`, Math.min(asisL.x, asisR.x), Math.min(asisL.y, asisR.y) - 15);
        }
    }

    ctx.restore();
}

function calculateWeightBearing(ctx, kps) {
    if (currentTab !== 'front' && currentTab !== 'back' && currentTab !== 'dyn_overhead') return;
    const getK = name => kps.find(k => k.name === name || k.name === BLAZEPOSE_KEYPOINTS.indexOf(name).toString());
    const lAnkle = getK('left_ankle');
    const rAnkle = getK('right_ankle');

    if (!lAnkle || !rAnkle || lAnkle.score < 0.2 || rAnkle.score < 0.2) return;

    const nose = getK('nose');
    const shL = getK('left_shoulder');
    const shR = getK('right_shoulder');
    const hipL = getK('left_hip');
    const hipR = getK('right_hip');

    if (!nose || !shL || !shR || !hipL || !hipR) return;

    const dPx = rAnkle.x - lAnkle.x;
    if (Math.abs(dPx) < 10) return;

    const baseMid = (lAnkle.x + rAnkle.x) / 2;

    // Compute Center of Mass (COM) proxy
    const upperComX = (nose.x * 0.20) + (((shL.x + shR.x) / 2) * 0.80);
    const lowerComX = (hipL.x + hipR.x) / 2;
    const totalComX = (upperComX * 0.6) + (lowerComX * 0.4);

    const calcRatio = (comX) => {
        let pctR = ((comX - lAnkle.x) / dPx) * 100;
        let pctL = 100 - pctR;
        pctR = Math.max(0, Math.min(100, pctR));
        pctL = 100 - pctR;
        return { L: pctL, R: pctR };
    };

    const totalRatio = calcRatio(totalComX);

    // Draw weight load indicator
    ctx.save();
    ctx.font = "bold 13px sans-serif";
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(canvasMP.width / 2 - 130, canvasMP.height - 120, 260, 45);
    
    ctx.textAlign = "center";
    const isSwayed = Math.abs(totalRatio.L - 50) > 5;
    ctx.fillStyle = isSwayed ? varColor('--accent-red') : varColor('--accent-green');
    ctx.fillText(`荷重配分  左: ${totalRatio.L.toFixed(1)}% | 右: ${totalRatio.R.toFixed(1)}%`, canvasMP.width / 2, canvasMP.height - 95);
    
    // Draw COM marker on floor
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(baseMid, 0);
    ctx.lineTo(baseMid, canvasMP.height);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = varColor('--accent-yellow');
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(totalComX, (lAnkle.y + rAnkle.y) / 2 - 5, 8, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();

    ctx.restore();
}

function drawOHSFrontAnalysis(ctx, kps) {
    if (currentTab !== 'dyn_overhead') return;
    const getK = name => kps.find(k => k.name === name || k.name === BLAZEPOSE_KEYPOINTS.indexOf(name).toString());
    
    const evaluateKnee = (hip, knee, ankle, sideLabel) => {
        if (!hip || !knee || !ankle || hip.score < 0.2 || knee.score < 0.2 || ankle.score < 0.2) return;
        
        // Vertical projection line from Hip to Ankle
        const refX = hip.x + (ankle.x - hip.x) * ((knee.y - hip.y) / (ankle.y - hip.y));
        const valgusAngle = Math.abs(180 - getJointAngle(hip, knee, ankle));

        if (valgusAngle > 3.0) {
            const isValgus = (sideLabel === 'R') ? (knee.x > refX) : (knee.x < refX);
            ctx.save();
            ctx.fillStyle = isValgus ? varColor('--accent-red') : varColor('--accent-orange');
            ctx.font = "bold 14px sans-serif";
            const text = (isValgus ? "Knee-In (内流) " : "Knee-Out (外流) ") + valgusAngle.toFixed(1) + "°";
            ctx.fillText(text, knee.x + (sideLabel === 'R' ? -120 : 20), knee.y - 10);
            
            // Draw red highlight on knee
            ctx.strokeStyle = isValgus ? varColor('--accent-red') : varColor('--accent-orange');
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(knee.x, knee.y, 12, 0, 2*Math.PI);
            ctx.stroke();
            ctx.restore();
        }
    };

    evaluateKnee(getK('right_hip'), getK('right_knee'), getK('right_ankle'), 'R');
    evaluateKnee(getK('left_hip'), getK('left_knee'), getK('left_ankle'), 'L');
}

function drawOHSSideAnalysis(ctx, kps) {
    if (currentTab !== 'dyn_overhead_side') return;
    const getK = name => kps.find(k => k.name === name || k.name === BLAZEPOSE_KEYPOINTS.indexOf(name).toString());
    
    const lS = getK('left_shoulder');
    const lH = getK('left_hip');
    const lK = getK('left_knee');
    const lA = getK('left_ankle');
    const lW = getK('left_wrist');

    const rS = getK('right_shoulder');
    const rH = getK('right_hip');
    const rK = getK('right_knee');
    const rA = getK('right_ankle');
    const rW = getK('right_wrist');

    const isLeft = lS && rS && lS.score > rS.score;
    const s = isLeft ? lS : rS;
    const h = isLeft ? lH : rH;
    const k = isLeft ? lK : rK;
    const a = isLeft ? lA : rA;
    const w = isLeft ? lW : rW;

    if (!s || !h || !k || !a || s.score < 0.2 || h.score < 0.2 || k.score < 0.2) return;

    // Torso incline angle relative to horizontal plane
    const trunkLean = Math.abs(Math.atan2(s.x - h.x, h.y - s.y) * 180 / Math.PI);
    const kneeAngle = getJointAngle(h, k, a);

    ctx.save();
    ctx.font = "bold 14px sans-serif";
    
    ctx.fillStyle = trunkLean > 40 ? varColor('--accent-red') : varColor('--accent-green');
    ctx.fillText(`体幹前傾: ${trunkLean.toFixed(1)}°`, s.x - 30, s.y - 25);

    ctx.fillStyle = varColor('--accent-cyan');
    if (kneeAngle) {
        ctx.fillText(`膝屈曲: ${kneeAngle.toFixed(1)}°`, k.x + 20, k.y);
    }

    if (w && w.score > 0.2) {
        const armAngle = getJointAngle(h, s, w);
        if (armAngle) {
            ctx.fillStyle = armAngle < 155 ? varColor('--accent-red') : varColor('--accent-green');
            ctx.fillText(`上肢アライメント: ${armAngle.toFixed(1)}°`, s.x + 35, s.y + 15);
            ctx.strokeStyle = "rgba(255,255,255,0.4)";
            ctx.beginPath();
            ctx.moveTo(s.x, s.y);
            ctx.lineTo(w.x, w.y);
            ctx.stroke();
        }
    }
    ctx.restore();
}

function drawKendallAlignment(ctx, kps) {
    if (currentTab !== 'l_side' && currentTab !== 'r_side') return;
    const getK = name => kps.find(k => k.name === name || k.name === BLAZEPOSE_KEYPOINTS.indexOf(name).toString());
    
    const isLeft = currentTab === 'l_side';
    const dir = isLeft ? -1 : 1;

    const ear = isLeft ? getK('left_ear') : getK('right_ear');
    const sh = isLeft ? getK('left_shoulder') : getK('right_shoulder');
    const hip = isLeft ? getK('left_hip') : getK('right_hip');
    const ankle = isLeft ? getK('left_ankle') : getK('right_ankle');

    let targetAnkle = (ankle && ankle.score > 0.2) ? ankle : null;
    if (!targetAnkle) {
        const heel = isLeft ? getK('left_heel') : getK('right_heel');
        if (heel && heel.score > 0.2) targetAnkle = heel;
    }

    if (!ear || !sh || !hip || !targetAnkle || ear.score < 0.2 || sh.score < 0.2 || hip.score < 0.2) return;

    const scale = pxToCmRatio || 0.15;
    // Ankle offset for plumb line positioning (about 15% anterior to malleolus/ankle)
    const plumbOffsetCm = 3.0; // cm
    const plumbX = targetAnkle.x + (dir * (plumbOffsetCm / scale));

    // Plumb line draw
    ctx.save();
    ctx.strokeStyle = varColor('--accent-green');
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(plumbX, 0);
    ctx.lineTo(plumbX, canvasMP.height);
    ctx.stroke();
    ctx.setLineDash([]);

    // 5 Spine Anatomical Landmarks estimation
    const c2 = { x: ear.x - (dir * (1.2 / scale)), y: ear.y + (2.0 / scale), name: "C2 (頸椎)", d0: 1.5 };
    const th3 = { x: sh.x, y: sh.y, name: "Th3 (胸椎)", d0: 1.0 };
    
    const tiltRad = estimatedPelvicTilt * Math.PI / 180;
    const s2OffsetZ = 3.0 / scale;
    const s2OffsetY = 2.0 / scale;
    const s2X = hip.x - (dir * (s2OffsetZ * Math.cos(tiltRad) - s2OffsetY * Math.sin(tiltRad)));
    const s2Y = hip.y + (s2OffsetZ * Math.sin(tiltRad) + s2OffsetY * Math.cos(tiltRad));
    const s2 = { x: s2X, y: s2Y, name: "S2 (仙骨)", d0: 1.0 };

    const lumbarDepth = (3.5 + (estimatedPelvicTilt * 0.12)) / scale;
    const l3Y = s2.y - ((s2.y - th3.y) * 0.32);
    const l3X = s2.x + (dir * lumbarDepth);
    const l3 = { x: l3X, y: l3Y, name: "L3 (腰椎)", d0: 2.2 };

    const th11Y = s2.y - ((s2.y - th3.y) * 0.65);
    const kyphosisDepth = (1.5 + (estimatedPelvicTilt * 0.05)) / scale;
    const straightTh11X = l3.x + (th3.x - l3.x) * ((l3.y - th11Y) / (l3.y - th3.y));
    const th11X = straightTh11X - (dir * kyphosisDepth);
    const th11 = { x: th11X, y: th11Y, name: "Th11 (胸腰部)", d0: 1.2 };

    const spinePoints = [c2, th3, th11, l3, s2];

    // Spine Spine curve draw
    ctx.strokeStyle = varColor('--accent-orange');
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(c2.x, c2.y);
    ctx.bezierCurveTo(c2.x, th3.y, th3.x, c2.y, th3.x, th3.y);
    ctx.bezierCurveTo(th3.x, th11.y, th11.x, th3.y, th11.x, th11.y);
    ctx.bezierCurveTo(th11.x, l3.y, l3.x, th11.y, l3.x, l3.y);
    ctx.bezierCurveTo(l3.x, s2.y, s2.x, l3.y, s2.x, s2.y);
    ctx.stroke();

    // Render deviation metrics on canvas
    ctx.font = "bold 12px sans-serif";
    spinePoints.forEach(pt => {
        ctx.fillStyle = varColor('--accent-orange');
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 6, 0, 2*Math.PI);
        ctx.fill();

        // Deviation calculation in cm
        const devCm = (pt.x - plumbX) * scale * dir;
        const stressPct = Math.abs(((pt.d0 + devCm) / pt.d0) * 100);
        const isAcceptable = Math.abs(devCm) <= pt.d0 * 1.5;
        const statusColor = isAcceptable ? varColor('--accent-green') : varColor('--accent-red');

        const labelText = `${pt.name}: ${devCm > 0 ? "+" : ""}${devCm.toFixed(1)} cm`;
        
        ctx.fillStyle = "rgba(0,0,0,0.8)";
        const width = ctx.measureText(labelText).width;
        const drawX = pt.x + (dir === 1 ? -width - 15 : 15);
        ctx.fillRect(drawX - 4, pt.y - 11, width + 8, 16);

        ctx.fillStyle = statusColor;
        ctx.fillText(labelText, drawX, pt.y + 1);

        // Reference dashed line
        ctx.strokeStyle = statusColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(plumbX, pt.y);
        ctx.stroke();
        ctx.setLineDash([]);
    });

    ctx.fillStyle = varColor('--accent-green');
    ctx.fillText("重力基準線 (Plumb Line)", plumbX + 10, 40);
    ctx.restore();
}

function updateRadar(kps) {
    const nose = kps.find(k => k.name === 'nose' || k.name === '0');
    if (!nose) return;

    let originX = canvasMP.width / 2;
    let originY = canvasMP.height;

    // Use current tab custom anchor if defined
    if (window.currentAnchorPos) {
        originX = window.currentAnchorPos.x;
        originY = window.currentAnchorPos.y;
    }

    const copX = nose.x - originX;
    const hDist = originY - nose.y;

    if (swayHistoryMP.length === 0 || swayHistoryMP.baseHDist === undefined) {
        swayHistoryMP.baseHDist = hDist;
    }
    const copY = swayHistoryMP.baseHDist - hDist;

    swayHistoryMP.push({ x: copX, y: copY });
    if (swayHistoryMP.length > 150) swayHistoryMP.shift();

    drawRadarVisualization(ctxRadarMP, swayHistoryMP, varColor('--accent-red'));
}

function drawRadarVisualization(ctx, history, color) {
    if (!ctx) return;
    ctx.clearRect(0, 0, 150, 150);

    // Background targets circles
    ctx.save();
    ctx.strokeStyle = "rgba(255, 82, 82, 0.2)";
    ctx.lineWidth = 1;
    
    ctx.beginPath(); ctx.arc(75, 75, 25, 0, 2*Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.arc(75, 75, 50, 0, 2*Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.arc(75, 75, 70, 0, 2*Math.PI); ctx.stroke();
    
    ctx.beginPath();
    ctx.moveTo(75, 5); ctx.lineTo(75, 145);
    ctx.moveTo(5, 75); ctx.lineTo(145, 75);
    ctx.stroke();

    if (history.length < 2) {
        ctx.restore();
        return;
    }

    // Draw sway trace
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    
    history.forEach((pt, idx) => {
        // Map offset values to radar coordinate limits
        let drawX = 75 + (pt.x * 0.45);
        let drawY = 75 + (pt.y * 0.45);
        const dist = Math.hypot(drawX - 75, drawY - 75);
        if (dist > 70) {
            drawX = 75 + ((drawX - 75) * 70 / dist);
            drawY = 75 + ((drawY - 75) * 70 / dist);
        }
        if (idx === 0) ctx.moveTo(drawX, drawY);
        else ctx.lineTo(drawX, drawY);
    });
    ctx.stroke();

    // Draw current COP marker
    const lastPt = history[history.length - 1];
    let markerX = 75 + (lastPt.x * 0.45);
    let markerY = 75 + (lastPt.y * 0.45);
    const dist = Math.hypot(markerX - 75, markerY - 75);
    if (dist > 70) {
        markerX = 75 + ((markerX - 75) * 70 / dist);
        markerY = 75 + ((markerY - 75) * 70 / dist);
    }
    
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(markerX, markerY, 5, 0, 2*Math.PI);
    ctx.fill();
    ctx.stroke();

    ctx.restore();
}

function drawAnchorGuides(ctx, getK) {
    let originX, originY;
    
    if (window.customOriginMarkers[currentTab]) {
        originX = window.customOriginMarkers[currentTab].x;
        originY = window.customOriginMarkers[currentTab].y;
    } else {
        const footKps = ['left_ankle', 'right_ankle', 'left_heel', 'right_heel', 'left_foot_index', 'right_foot_index'];
        const validX = [], validY = [];
        footKps.forEach(name => {
            const p = getK(name);
            if (p && p.score > 0.2) {
                validX.push(p.x);
                validY.push(p.y);
            }
        });
        if (validX.length >= 2) {
            originX = (Math.min(...validX) + Math.max(...validX)) / 2;
            originY = Math.max(...validY);
        }
    }

    if (originX !== undefined && originY !== undefined) {
        window.currentAnchorPos = { x: originX, y: originY };
        
        ctx.save();
        ctx.fillStyle = "rgba(0, 191, 255, 0.4)";
        ctx.strokeStyle = varColor('--accent-cyan');
        ctx.lineWidth = 2.5;
        
        ctx.beginPath();
        ctx.arc(originX, originY, 15, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();

        // Target center grid vertical axis
        ctx.strokeStyle = "rgba(0, 191, 255, 0.35)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(originX, 0);
        ctx.lineTo(originX, canvasMP.height);
        ctx.stroke();
        ctx.restore();
    }
}

// --- 5. Application Setup & Camera Loop Control ---

async function initPoseDetection() {
    startBtn.innerText = "⏳ 推定モデル読込中...";
    try {
        await tf.ready();
        await tf.setBackend('webgl');
        
        detector = await poseDetection.createDetector(
            poseDetection.SupportedModels.BlazePose,
            {
                runtime: 'mediapipe',
                modelType: 'full',
                solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/pose'
            }
        );

        startBtn.innerText = "🚀 カメラ開始";
        startBtn.disabled = false;
        await detectCameras();
    } catch (err) {
        console.error("AI Pose model initialization error: ", err);
        startBtn.innerText = "❌ 起動エラー";
        customAlert("初期化エラー", "TensorFlow / MediaPipe のロードに失敗しました。再読み込みしてください。");
    }
}

async function detectCameras() {
    const selector = document.getElementById('videoSource');
    selector.innerHTML = "";
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        if (videoDevices.length === 0) {
            selector.innerHTML = "<option value=''>カメラが見つかりません</option>";
            return;
        }
        videoDevices.forEach((device, index) => {
            const opt = document.createElement('option');
            opt.value = device.deviceId;
            opt.innerText = device.label || `カメラ ${index + 1}`;
            selector.appendChild(opt);
        });
    } catch (e) {
        selector.innerHTML = "<option value=''>カメラ検索に失敗</option>";
    }
}

async function startCamera() {
    if (currentStream) {
        stopCamera();
    }

    const deviceId = document.getElementById('videoSource').value;
    const constraints = {
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
        audio: false
    };

    try {
        currentStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = currentStream;
        await new Promise(resolve => video.onloadedmetadata = () => resolve());
        video.play();

        canvasMP.width = video.videoWidth;
        canvasMP.height = video.videoHeight;
        
        isRunning = true;
        appMode = "camera";
        startBtn.innerText = "⏹️ カメラ停止";
        startBtn.style.background = "linear-gradient(135deg, #e53935 0%, #c62828 100%)";
        recBtn.disabled = false;
        
        runCameraLoop();
    } catch (e) {
        console.error("Failed to start camera: ", e);
        customAlert("カメラ起動エラー", "カメラの起動に失敗しました。プライバシー設定をご確認ください。");
    }
}

function stopCamera() {
    isRunning = false;
    if (cameraRafId) cancelAnimationFrame(cameraRafId);
    if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
        currentStream = null;
    }
    video.srcObject = null;
    startBtn.innerText = "🚀 カメラ開始";
    startBtn.style.background = "linear-gradient(135deg, #1e88e5 0%, #1565c0 100%)";
    recBtn.disabled = true;
}

function runCameraLoop() {
    if (!isRunning) return;

    const render = async () => {
        if (!isRunning) return;

        // Render current camera frame
        ctxMP.drawImage(video, 0, 0, canvasMP.width, canvasMP.height);

        try {
            const poses = await detector.estimatePoses(video, { flipHorizontal: false });
            if (poses && poses.length > 0) {
                let kps = poses[0].keypoints;
                
                // 1. Estimate Pelvic Tilt dynamically
                estimatedPelvicTilt = estimatePelvicTiltAutomatically(kps);
                pelvicTiltSlider.value = estimatedPelvicTilt;
                updatePelvicTiltDisplay();

                // 2. Generate ASIS virtual keypoints
                kps = generateVirtualASIS(kps);

                // 3. Draw alignment guidelines
                drawAnchorGuides(ctxMP, name => kps.find(k => k.name === name || k.name === BLAZEPOSE_KEYPOINTS.indexOf(name).toString()));
                
                // 4. Draw overlay skeleton bones
                drawSkeleton(ctxMP, kps, "rgba(0, 191, 255, 0.8)");

                // 5. Weight bearing / postural evaluation overlays
                calculateWeightBearing(ctxMP, kps);
                drawOHSFrontAnalysis(ctxMP, kps);
                drawOHSSideAnalysis(ctxMP, kps);
                drawKendallAlignment(ctxMP, kps);
                updateRadar(kps);

                // Draw calibration markers if active
                drawCalibrationOverlay();

                // Draw adjustment target pointer
                if (selectedJointIndex !== null) {
                    const kp = kps[selectedJointIndex];
                    if (kp) drawTargetCrosshair(ctxMP, kp);
                }

                // If recording active, store frame data
                if (isRecording) {
                    poseDataLog.push({
                        timestamp: Date.now(),
                        keypoints: JSON.parse(JSON.stringify(kps)),
                        pelvicTilt: estimatedPelvicTilt
                    });
                }
            }
        } catch (e) {
            console.error("Inference frame error: ", e);
        }

        cameraRafId = requestAnimationFrame(render);
    };

    cameraRafId = requestAnimationFrame(render);
}

// --- 6. Recording & Playback Mechanisms ---

function startRecording() {
    if (!isRunning) return;

    poseDataLog = [];
    isRecording = true;
    recBtn.disabled = true;
    recBtn.classList.add('recording');
    recBtn.innerText = "🔴 記録中...";

    const duration = parseInt(durationSelect.value) || 5000;
    const recStartTime = Date.now();
    timerDisplay.style.display = "block";

    const countdown = setInterval(() => {
        const remaining = Math.max(0, duration - (Date.now() - recStartTime));
        timerDisplay.innerText = `REC ${(remaining / 1000).toFixed(1)}s`;
        if (remaining <= 0) {
            clearInterval(countdown);
            stopRecording();
        }
    }, 100);
}

function stopRecording() {
    isRecording = false;
    recBtn.classList.remove('recording');
    recBtn.innerText = "🔴 録画スタート";
    recBtn.disabled = false;
    timerDisplay.style.display = "none";

    if (poseDataLog.length > 0) {
        playbackDataMP = JSON.parse(JSON.stringify(poseDataLog));
        
        // Save current tab report baseline dataset
        window.reportDataStore[currentTab] = JSON.parse(JSON.stringify(playbackDataMP[playbackDataMP.length - 1].keypoints));
        
        enterPlaybackMode();
        saveSessionToDatabase();
    } else {
        customAlert("エラー", "姿勢データを保存できませんでした。カメラ位置を確認してください。");
    }
}

function enterPlaybackMode() {
    appMode = "playback";
    stopCamera();

    // Toggle control panels
    mainControls.style.display = "none";
    playbackControls.style.display = "flex";
    tiltPanel.style.display = "block"; // Show tilt panel for matching silhouettes

    timelineSlider.max = playbackDataMP.length - 1;
    timelineSlider.value = 0;
    renderPlaybackFrame(0);
}

function exitPlaybackMode() {
    appMode = "camera";
    playbackControls.style.display = "none";
    mainControls.style.display = "flex";
    tiltPanel.style.display = "none";
    dpadPanel.style.display = "none";
    selectedJointIndex = null;
    isEditingPlaybackFrame = false;
    editFrameBtn.innerText = "✂️ 微調整";
    editFrameBtn.style.background = varColor('--accent-orange');

    startCamera();
}

function renderPlaybackFrame(frameIdx) {
    if (frameIdx < 0 || frameIdx >= playbackDataMP.length) return;

    const frameData = playbackDataMP[frameIdx];
    let kps = frameData.keypoints;
    estimatedPelvicTilt = frameData.pelvicTilt;

    // Adjust Pelvis display based on loaded coordinates
    pelvicTiltSlider.value = estimatedPelvicTilt;
    updatePelvicTiltDisplay();

    // Redraw black video frame canvas background
    ctxMP.fillStyle = "#0c0f12";
    ctxMP.fillRect(0, 0, canvasMP.width, canvasMP.height);

    const getK = name => kps.find(k => k.name === name || k.name === BLAZEPOSE_KEYPOINTS.indexOf(name).toString());
    
    // Draw alignment guidelines
    drawAnchorGuides(ctxMP, getK);

    // Draw skeleton bone maps
    drawSkeleton(ctxMP, kps, "rgba(0, 191, 255, 0.85)");

    // Static / Dynamic analysis calculations
    calculateWeightBearing(ctxMP, kps);
    drawOHSFrontAnalysis(ctxMP, kps);
    drawOHSSideAnalysis(ctxMP, kps);
    drawKendallAlignment(ctxMP, kps);
    drawPlaybackRadar(playbackDataMP, frameIdx);

    // D-Pad micro adjustments visual highlight
    if (selectedJointIndex !== null) {
        const kp = kps[selectedJointIndex];
        if (kp) drawTargetCrosshair(ctxMP, kp);
    }

    frameCounter.innerText = `${frameIdx + 1} / ${playbackDataMP.length}`;
}

function drawPlaybackRadar(historyArray, currentIdx) {
    const list = [];
    let baseHDist = null;
    let originX = canvasMP.width / 2;
    let originY = canvasMP.height;

    if (window.currentAnchorPos) {
        originX = window.currentAnchorPos.x;
        originY = window.currentAnchorPos.y;
    }

    for (let i = 0; i <= currentIdx; i++) {
        const frame = historyArray[i];
        if (!frame) continue;
        const nose = frame.keypoints.find(k => k.name === 'nose' || k.name === '0');
        if (nose) {
            const copX = nose.x - originX;
            const hDist = originY - nose.y;
            if (baseHDist === null) baseHDist = hDist;
            const copY = baseHDist - hDist;
            list.push({ x: copX, y: copY });
        }
    }
    drawRadarVisualization(ctxRadarMP, list, varColor('--accent-red'));
}

function togglePlay(force) {
    if (appMode !== 'playback') return;
    
    const playBtn = document.getElementById('playPauseBtn');
    
    if (force === false || isPlaying) {
        isPlaying = false;
        playBtn.innerText = "▶ 再生";
        if (playbackRafId) cancelAnimationFrame(playbackRafId);
    } else {
        isPlaying = true;
        playBtn.innerText = "⏸ 停止";
        
        let startFrame = parseInt(timelineSlider.value);
        if (startFrame >= playbackDataMP.length - 1) startFrame = 0;
        
        let lastTime = performance.now();
        const frameInterval = 1000 / 15; // Target 15 fps for skeleton timeline playback

        const loop = (timestamp) => {
            if (!isPlaying) return;
            
            const elapsed = timestamp - lastTime;
            if (elapsed >= frameInterval) {
                lastTime = timestamp - (elapsed % frameInterval);
                startFrame++;
                if (startFrame >= playbackDataMP.length) {
                    startFrame = 0;
                }
                timelineSlider.value = startFrame;
                renderPlaybackFrame(startFrame);
            }
            playbackRafId = requestAnimationFrame(loop);
        };
        playbackRafId = requestAnimationFrame(loop);
    }
}

// --- 7. Manual Micro-Adjustment D-Pad Mechanics ---

function handleCanvasClick(e) {
    if (appMode !== 'playback' && !isPausedForEdit) return;

    const rect = canvasMP.getBoundingClientRect();
    const clickX = ((e.clientX - rect.left) / rect.width) * canvasMP.width;
    const clickY = ((e.clientY - rect.top) / rect.height) * canvasMP.height;

    // Matte calibration points handler overrides
    if (calibState === "wait_left") {
        calibrationPoints = [{ x: clickX, y: clickY }];
        calibState = "adjust_left";
        selectedJointIndex = null;
        dpadPanel.style.display = 'flex';
        document.getElementById('calibrateMatBtn').innerText = "📍 左微調整完了";
        return;
    } else if (calibState === "wait_right") {
        calibrationPoints.push({ x: clickX, y: clickY });
        calibState = "adjust_right";
        selectedJointIndex = null;
        dpadPanel.style.display = 'flex';
        document.getElementById('calibrateMatBtn').innerText = "📍 右微調整完了";
        return;
    }

    // Standard bone joints coordinate selector
    let currentKps = [];
    if (appMode === 'playback') {
        const frameIdx = parseInt(timelineSlider.value);
        if (playbackDataMP[frameIdx]) currentKps = playbackDataMP[frameIdx].keypoints;
    } else {
        currentKps = window.reportDataStore[currentTab];
    }

    if (!currentKps || currentKps.length === 0) return;

    // Detect closest landmark tap position
    let closestIndex = null;
    let minDist = 25; // max tap boundary radius in px

    currentKps.forEach((kp, idx) => {
        const d = Math.hypot(kp.x - clickX, kp.y - clickY);
        if (d < minDist) {
            minDist = d;
            closestIndex = idx;
        }
    });

    if (closestIndex !== null) {
        selectedJointIndex = closestIndex;
        dpadPanel.style.display = 'flex';
        
        // Populate current selected landmark details
        const selectedKp = currentKps[selectedJointIndex];
        const labelText = selectedKp.name ? selectedKp.name.toUpperCase().replace('_', ' ') : `JOINT ${selectedJointIndex}`;
        document.getElementById('dpadTitle').innerText = `🎯 ${labelText}`;
        
        if (appMode === 'playback') {
            renderPlaybackFrame(parseInt(timelineSlider.value));
        } else {
            refreshReportView();
        }
    } else {
        selectedJointIndex = null;
        dpadPanel.style.display = 'none';
        if (appMode === 'playback') {
            renderPlaybackFrame(parseInt(timelineSlider.value));
        }
    }
}

function nudgeJoint(dx, dy) {
    if (calibState === "adjust_left" && calibrationPoints[0]) {
        calibrationPoints[0].x += dx;
        calibrationPoints[0].y += dy;
    } else if (calibState === "adjust_right" && calibrationPoints[1]) {
        calibrationPoints[1].x += dx;
        calibrationPoints[1].y += dy;
    } else if (selectedJointIndex !== null) {
        if (appMode === 'playback') {
            const frameIdx = parseInt(timelineSlider.value);
            const currentFrame = playbackDataMP[frameIdx];
            if (currentFrame && currentFrame.keypoints[selectedJointIndex]) {
                const kp = currentFrame.keypoints[selectedJointIndex];
                kp.x += dx;
                kp.y += dy;

                // Sync left/right virtual ASIS if edited directly
                if (kp.name === 'virtual_asis_l' || kp.name === 'virtual_asis_r') {
                    const oppositeName = kp.name === 'virtual_asis_l' ? 'virtual_asis_r' : 'virtual_asis_l';
                    const oppKp = currentFrame.keypoints.find(k => k.name === oppositeName);
                    if (oppKp) { oppKp.x += dx; oppKp.y += dy; }
                    
                    const isLeft = currentTab === 'l_side' || currentTab === 'dyn_overhead_side' || currentTab === 'dyn_single_l';
                    const hipName = isLeft ? 'left_hip' : 'right_hip';
                    const hipKp = currentFrame.keypoints.find(k => k.name === hipName);
                    recalculatePelvicTiltFromASIS(kp, hipKp);
                    currentFrame.pelvicTilt = estimatedPelvicTilt;
                }
                
                renderPlaybackFrame(frameIdx);
            }
        } else if (isPausedForEdit) {
            const baselineKps = window.reportDataStore[currentTab];
            if (baselineKps && baselineKps[selectedJointIndex]) {
                baselineKps[selectedJointIndex].x += dx;
                baselineKps[selectedJointIndex].y += dy;
                refreshReportView();
            }
        }
    }
}

function drawTargetCrosshair(ctx, kp) {
    ctx.save();
    ctx.strokeStyle = varColor('--accent-cyan');
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, kp.y); ctx.lineTo(canvasMP.width, kp.y);
    ctx.moveTo(kp.x, 0); ctx.lineTo(kp.x, canvasMP.height);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = varColor('--accent-cyan');
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(kp.x, kp.y, 14, 0, 2*Math.PI);
    ctx.stroke();
    
    ctx.fillStyle = "rgba(0, 191, 255, 0.25)";
    ctx.beginPath();
    ctx.arc(kp.x, kp.y, 14, 0, 2*Math.PI);
    ctx.fill();
    ctx.restore();
}

// --- 8. Calibration Matte Core Logic ---

function drawCalibrationOverlay() {
    if (calibState === "idle") return;
    
    ctxMP.save();
    ctxMP.fillStyle = varColor('--accent-yellow');
    ctxMP.strokeStyle = varColor('--accent-yellow');
    ctxMP.lineWidth = 2;

    calibrationPoints.forEach((pt, idx) => {
        ctxMP.beginPath();
        ctxMP.arc(pt.x, pt.y, 6, 0, 2*Math.PI);
        ctxMP.fill();
        ctxMP.font = "bold 12px sans-serif";
        ctxMP.fillText(`校正点 ${idx + 1}`, pt.x + 10, pt.y - 10);
    });

    if (calibrationPoints.length === 2) {
        ctxMP.beginPath();
        ctxMP.moveTo(calibrationPoints[0].x, calibrationPoints[0].y);
        ctxMP.lineTo(calibrationPoints[1].x, calibrationPoints[1].y);
        ctxMP.stroke();
    }
    ctxMP.restore();
}

// --- 9. Database & Dynamic Report Generation ---

async function saveSessionToDatabase() {
    const session = {
        id: `sess_${Date.now()}`,
        timestamp: Date.now(),
        mode: currentTab,
        height: parseFloat(document.getElementById('patientHeight').value) || 170,
        pelvicTilt: estimatedPelvicTilt,
        pxToCmRatio: pxToCmRatio,
        playbackData: playbackDataMP
    };
    await dbManager.saveSession(session);
    console.log("Session saved successfully.");
}

async function refreshHistoryList() {
    const list = await dbManager.getAllSessions();
    historyListContainer.innerHTML = "";
    if (list.length === 0) {
        historyListContainer.innerHTML = "<div style='color:#666; font-size:12px; text-align:center; margin-top:20px;'>保存された履歴はありません</div>";
        return;
    }

    list.forEach(sess => {
        const item = document.createElement('div');
        item.className = "history-item";
        
        const dateStr = new Date(sess.timestamp).toLocaleString('ja-JP', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
        });

        const name = MODE_NAMES[sess.mode] || sess.mode;

        item.innerHTML = `
            <div>
                <div class="history-mode">${name}</div>
                <div class="history-date">${dateStr} (${sess.height}cm)</div>
            </div>
            <div class="history-actions">
                <button class="history-action-btn vid" onclick="loadHistorySession('${sess.id}')">📂 開く</button>
                <button class="history-action-btn del" onclick="deleteHistorySession(event, '${sess.id}')">✖ 削除</button>
            </div>
        `;
        historyListContainer.appendChild(item);
    });
}

window.loadHistorySession = async function(id) {
    const list = await dbManager.getAllSessions();
    const session = list.find(s => s.id === id);
    if (!session) return;

    playbackDataMP = session.playbackData;
    currentTab = session.mode;
    document.getElementById('modeSelect').value = currentTab;
    document.getElementById('patientHeight').value = session.height;
    estimatedPelvicTilt = session.pelvicTilt;
    pxToCmRatio = session.pxToCmRatio;

    // Load final frame into report store baseline
    window.reportDataStore[currentTab] = JSON.parse(JSON.stringify(playbackDataMP[playbackDataMP.length - 1].keypoints));

    enterPlaybackMode();
    historyPanel.style.display = 'none';
};

window.deleteHistorySession = async function(e, id) {
    e.stopPropagation();
    customConfirm("データ削除", "この測定履歴を完全に削除しますか？", async () => {
        await dbManager.deleteSession(id);
        await refreshHistoryList();
    });
};

/**
 * Switch report tab trigger from mode select selector
 */
window.switchReportTab = function(val) {
    currentTab = val;
    // Set recording duration from preset mappings
    recordingDuration = DURATION_MAP[currentTab] || 5000;
}

// --- 10. Dashboard Report Builder & Printable Document ---

window.prepareAndPrintReport = function() {
    // Generate biomechanical charts data
    document.getElementById('dashboardOverlay').style.display = 'block';
    
    const grid = document.getElementById('dashGrid');
    grid.innerHTML = "";

    // Gathers baseline points
    let baselineKps = [];
    if (appMode === 'playback' && playbackDataMP.length > 0) {
        baselineKps = playbackDataMP[playbackDataMP.length - 1].keypoints;
    } else if (window.reportDataStore[currentTab]) {
        baselineKps = window.reportDataStore[currentTab];
    }

    if (baselineKps.length === 0) {
        grid.innerHTML = "<div class='dash-card' style='grid-column:1/-1; text-align:center; color:#aaa;'>姿勢の測定データが見つかりません。カメラで計測するか履歴から開いてください。</div>";
        return;
    }

    const getK = name => baselineKps.find(k => k.name === name || k.name === BLAZEPOSE_KEYPOINTS.indexOf(name).toString());
    const scale = pxToCmRatio || 0.15;

    // 1. Static Alignment Metrics card
    const shL = getK('left_shoulder');
    const shR = getK('right_shoulder');
    const hipL = getK('left_hip');
    const hipR = getK('right_hip');
    const kneeL = getK('left_knee');
    const kneeR = getK('right_knee');

    let shoulderTilt = 0, hipTilt = 0, weightBal = "50 / 50";
    if (shL && shR && shL.score > 0.2 && shR.score > 0.2) {
        shoulderTilt = Math.abs(Math.atan2(shR.y - shL.y, shR.x - shL.x) * 180 / Math.PI);
    }
    if (hipL && hipR && hipL.score > 0.2 && hipR.score > 0.2) {
        hipTilt = Math.abs(Math.atan2(hipR.y - hipL.y, hipR.x - hipL.x) * 180 / Math.PI);
    }

    // Weight bearing load calculation
    const ankleL = getK('left_ankle');
    const ankleR = getK('right_ankle');
    const nose = getK('nose');
    if (ankleL && ankleR && nose && ankleL.score > 0.2 && ankleR.score > 0.2) {
        const dPx = ankleR.x - ankleL.x;
        if (Math.abs(dPx) > 10) {
            const upperComX = (nose.x * 0.20) + (((shL.x + shR.x) / 2) * 0.80);
            const lowerComX = (hipL.x + hipR.x) / 2;
            const totalComX = (upperComX * 0.6) + (lowerComX * 0.4);
            const pctR = ((totalComX - ankleL.x) / dPx) * 100;
            const pctL = 100 - pctR;
            weightBal = `${pctL.toFixed(1)}% / ${pctR.toFixed(1)}%`;
        }
    }

    const card1 = document.createElement('div');
    card1.className = 'dash-card';
    card1.innerHTML = `
        <h3>🧍 静的アライメント評価</h3>
        <div class="dash-metric"><span>測定モード</span><span class="val">${MODE_NAMES[currentTab] || currentTab}</span></div>
        <div class="dash-metric"><span>左右肩関節の傾き</span><span class="val ${shoulderTilt > 2.5 ? 'warn' : 'good'}">${shoulderTilt.toFixed(1)}°</span></div>
        <div class="dash-metric"><span>左右骨盤の傾き</span><span class="val ${hipTilt > 2.5 ? 'warn' : 'good'}">${hipTilt.toFixed(1)}°</span></div>
        <div class="dash-metric"><span>左右荷重バランス（左/右）</span><span class="val">${weightBal}</span></div>
        <div class="dash-metric"><span>設定骨盤前後傾角度</span><span class="val">${estimatedPelvicTilt > 0 ? '+' : ''}${estimatedPelvicTilt}°</span></div>
    `;
    grid.appendChild(card1);

    // 2. Sagittal Kendall alignment assessment
    const ear = currentTab === 'l_side' ? getK('left_ear') : getK('right_ear');
    const shoulder = currentTab === 'l_side' ? getK('left_shoulder') : getK('right_shoulder');
    const hip = currentTab === 'l_side' ? getK('left_hip') : getK('right_hip');
    const ankle = currentTab === 'l_side' ? getK('left_ankle') : getK('right_ankle');

    if ((currentTab === 'l_side' || currentTab === 'r_side') && ear && shoulder && hip && ankle) {
        const dir = currentTab === 'l_side' ? -1 : 1;
        const plumbX = ankle.x + (dir * (3.0 / scale));
        
        const c2Dev = (ear.x - (dir * (1.2 / scale)) - plumbX) * scale * dir;
        const th3Dev = (shoulder.x - plumbX) * scale * dir;
        const s2Dev = (hip.x - (dir * (3.0 / scale)) - plumbX) * scale * dir; // rough estimate offset

        // Kendall postural classifier
        let postureType = "正常アライメント (Optimal)";
        let postureDesc = "重力基準線に対して頭椎、胸椎、仙骨が正常なアライメントを維持しています。バランスが取れた理想的な姿勢です。";
        
        if (c2Dev > 4.0) {
            postureType = "フォワードヘッド (Forward Head)";
            postureDesc = "頭部が重力線より前方に著しく突出しています。首回り（胸鎖乳突筋、僧帽筋）の過緊張や肩こり、頭痛のリスクがあります。";
        } else if (th3Dev > 3.0 && s2Dev < -2.0) {
            postureType = "円背・平背型 (Sway-back / Flat-back)";
            postureDesc = "骨盤が前方にスライドし、胸椎の湾曲が平坦化または過弯曲しています。骨盤の後傾と大腿後面のタイトネスが疑われます。";
        } else if (estimatedPelvicTilt > 12) {
            postureType = "骨盤前傾・反り腰型 (Kyphosis-Lordosis)";
            postureDesc = "骨盤の過度な前傾により腰椎の前弯が強くなり、お腹とお尻が突き出た姿勢（反り腰）になっています。腰椎すべり症や腰痛に注意が必要です。";
        }

        const card2 = document.createElement('div');
        card2.className = 'dash-card';
        card2.innerHTML = `
            <h3>📐 矢状面アライメント（ケンダル分析）</h3>
            <div class="dash-metric"><span>姿勢分類判定</span><span class="val warn" style="color:var(--accent-orange); font-size:15px;">${postureType}</span></div>
            <div class="dash-metric"><span>C2(頸椎) 基準線乖離</span><span class="val ${Math.abs(c2Dev) > 2.0 ? 'warn' : 'good'}">${c2Dev.toFixed(1)} cm</span></div>
            <div class="dash-metric"><span>Th3(胸椎) 基準線乖離</span><span class="val ${Math.abs(th3Dev) > 2.0 ? 'warn' : 'good'}">${th3Dev.toFixed(1)} cm</span></div>
            <div class="dash-metric"><span>S2(仙骨) 基準線乖離</span><span class="val ${Math.abs(s2Dev) > 2.0 ? 'warn' : 'good'}">${s2Dev.toFixed(1)} cm</span></div>
            <p style="font-size:12px; color:#aaa; line-height:1.5; margin-top:12px;">${postureDesc}</p>
        `;
        grid.appendChild(card2);
    }

    // 3. OHS Dynamic movement scorecard
    if (currentTab.startsWith('dyn_overhead') && playbackDataMP.length > 0) {
        let maxKneeFlex = 180;
        let maxTrunkLean = 0;
        let kneeValgusOccurred = false;

        playbackDataMP.forEach(frame => {
            const fkps = frame.keypoints;
            const fgetK = name => fkps.find(k => k.name === name || k.name === BLAZEPOSE_KEYPOINTS.indexOf(name).toString());

            // 1. Knee flexion depth tracker
            const fs = fgetK('left_shoulder') || fgetK('right_shoulder');
            const fh = fgetK('left_hip') || fgetK('right_hip');
            const fk = fgetK('left_knee') || fgetK('right_knee');
            const fa = fgetK('left_ankle') || fgetK('right_ankle');

            if (fh && fk && fa) {
                const angle = getJointAngle(fh, fk, fa);
                if (angle && angle < maxKneeFlex) maxKneeFlex = angle;
            }

            // 2. Trunk forward incline tracker
            if (fs && fh) {
                const lean = Math.abs(Math.atan2(fs.x - fh.x, fh.y - fs.y) * 180 / Math.PI);
                if (lean > maxTrunkLean) maxTrunkLean = lean;
            }
        });

        const card3 = document.createElement('div');
        card3.className = 'dash-card';
        card3.innerHTML = `
            <h3>🏋️ スクワット動作評価 (OHS)</h3>
            <div class="dash-metric"><span>最大膝関節屈曲角度 (深さ)</span><span class="val">${maxKneeFlex.toFixed(1)}°</span></div>
            <div class="dash-metric"><span>最大体幹前傾角度</span><span class="val ${maxTrunkLean > 40 ? 'warn' : 'good'}">${maxTrunkLean.toFixed(1)}°</span></div>
            <div class="dash-metric"><span>判定評価</span><span class="val">${maxKneeFlex < 100 ? '十分な深さ' : '浅い（可動制限あり）'}</span></div>
            <p style="font-size:12px; color:#aaa; line-height:1.5; margin-top:12px;">オーバーヘッドスクワットの軌道から、股関節・足関節の硬さや下肢の筋力バランスを評価します。</p>
        `;
        grid.appendChild(card3);
    }

    // 4. Center of Pressure (COP) Stability Visualizer card
    if (playbackDataMP.length > 0) {
        const cardSway = document.createElement('div');
        cardSway.className = 'dash-card';
        cardSway.innerHTML = `
            <h3>📈 重心動揺度（COP軌跡）</h3>
            <div class="chart-container">
                <canvas id="copChartCanvas" style="width:100%; height:100%;"></canvas>
            </div>
        `;
        grid.appendChild(cardSway);

        // Build sway charts on dashboard render using requestAnimationFrame
        requestAnimationFrame(() => {
            renderCopChart(playbackDataMP);
        });
    }

    // 5. Automated AI Biomechanical Analysis Report card
    const cardAi = document.createElement('div');
    cardAi.className = 'dash-card dash-card-wide';
    cardAi.id = 'aiEvalCard';
    
    // AI Evaluation narrative generation
    let aiComment = `【総合評価】\n左右のアライメント偏位は軽微であり、全体的に良好な直立アライメントが保たれています。`;
    if (shoulderTilt > 3.0 || hipTilt > 3.0) {
        aiComment = `【総合評価】\n左右の非対称性がみられます（肩の傾き:${shoulderTilt.toFixed(1)}° / 骨盤の傾き:${hipTilt.toFixed(1)}°）。\n患側の腰方形筋や中殿筋の筋緊張不均衡、または日常の荷重の偏り（片脚立ち等）が影響している可能性が高いです。\n\n【アプローチ提案】\n1. 骨盤高位側の腰方形筋ストレッチ\n2. 低位側への中殿筋アクティベーショントレーニング`;
    } else if (estimatedPelvicTilt > 15) {
        aiComment = `【総合評価】\n骨盤の著しい前傾（反り腰姿勢）が認められます。\n腸腰筋・脊柱起立筋の過緊張と、腹直筋・大殿筋の出力低下による骨盤のアンバランスが生じています。\n\n【アプローチ提案】\n1. 股関節前部（腸腰筋）のリリース\n2. 骨盤後傾を意識したコア（ドローイン）およびヒップリフトエクササイズ`;
    }

    cardAi.innerHTML = `
        <h3>🤖 AI バイオメカニクス運動指導レポート</h3>
        <button id="generateAiEvalBtn" class="ui-top-btn" onclick="generatePremiumAIReport()" style="margin-bottom: 12px; border-radius: 6px; padding: 6px 12px;">✨ レポート生成</button>
        <div class="ai-eval-content" id="aiEvalContent">${aiComment}</div>
    `;
    grid.appendChild(cardAi);
};

function renderCopChart(dataArray) {
    const canvas = document.getElementById('copChartCanvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (chartInstance) {
        chartInstance.destroy();
    }

    let originX = canvasMP.width / 2;
    if (window.currentAnchorPos) originX = window.currentAnchorPos.x;

    // Compile time series dataset
    const labels = [];
    const swayData = [];

    dataArray.forEach((frame, idx) => {
        const nose = frame.keypoints.find(k => k.name === 'nose' || k.name === '0');
        if (nose) {
            labels.push(`${(idx * 0.066).toFixed(1)}s`); // Approx 15 fps
            swayData.push((nose.x - originX) * (pxToCmRatio || 0.15));
        }
    });

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: '重心の左右動揺 (cm)',
                data: swayData,
                borderColor: varColor('--accent-cyan'),
                borderWidth: 2,
                backgroundColor: 'rgba(0, 191, 255, 0.1)',
                tension: 0.3,
                fill: true,
                pointRadius: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    grid: { color: 'rgba(255,255,255,0.06)' },
                    ticks: { color: '#8a99ad' }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#8a99ad', maxTicksLimit: 10 }
                }
            }
        }
    });
}

window.generatePremiumAIReport = function() {
    const textBlock = document.getElementById('aiEvalContent');
    textBlock.innerText = "⚡ バイオメカニクス解析AIが分析中...";

    setTimeout(() => {
        let text = `【バイオメカニクス統合評価レポート】\n\n`;
        text += `1. アライメント分析:\n`;
        
        let baselineKps = [];
        if (appMode === 'playback') {
            baselineKps = playbackDataMP[playbackDataMP.length - 1].keypoints;
        } else if (window.reportDataStore[currentTab]) {
            baselineKps = window.reportDataStore[currentTab];
        }

        const getK = name => baselineKps.find(k => k.name === name || k.name === BLAZEPOSE_KEYPOINTS.indexOf(name).toString());
        const shL = getK('left_shoulder');
        const shR = getK('right_shoulder');
        const hipL = getK('left_hip');
        const hipR = getK('right_hip');

        let shoulderTilt = 0, hipTilt = 0;
        if (shL && shR && shL.score > 0.2 && shR.score > 0.2) {
            shoulderTilt = Math.abs(Math.atan2(shR.y - shL.y, shR.x - shL.x) * 180 / Math.PI);
        }
        if (hipL && hipR && hipL.score > 0.2 && hipR.score > 0.2) {
            hipTilt = Math.abs(Math.atan2(hipR.y - hipL.y, hipR.x - hipL.x) * 180 / Math.PI);
        }

        if (shoulderTilt > 2.0) {
            text += `・左右の肩関節高低差は ${shoulderTilt.toFixed(1)}° となっており、やや偏りがあります。日常の利き腕の過剰使用や脊柱側弯傾向が疑われます。\n`;
        } else {
            text += `・左右の肩関節傾きは ${shoulderTilt.toFixed(1)}° であり、良好な対称性を有しています。\n`;
        }

        if (hipTilt > 2.0) {
            text += `・骨盤の傾きは ${hipTilt.toFixed(1)}° で偏位があります。骨盤底筋群および左右中殿筋の筋出力の不均衡、骨盤ねじれが生じている可能性があります。\n`;
        } else {
            text += `・骨盤のアライメントは左右均等に維持されています。\n`;
        }

        text += `\n2. 運動連鎖（キネマティックチェーン）評価:\n`;
        if (estimatedPelvicTilt > 12) {
            text += `・骨盤の前傾姿勢（${estimatedPelvicTilt}°）により下部腰椎に持続的な剪断ストレスが加わっています。大腿直筋・腸腰筋のタイトネスと、腹筋群・殿筋群の抑制性弱化を呈する「下位交差症候群（Lower Crossed Syndrome）」のパターンです。\n`;
        } else if (estimatedPelvicTilt < -5) {
            text += `・骨盤の後傾姿勢（${estimatedPelvicTilt}°）となっており、腰椎の前弯カーブが消失しています。椎間板の内圧が高まりやすく、椎間板ヘルニアのトリガーとなるリスクがあります。ハムストリングスの柔軟性向上と大腰筋のアクティベートが必要です。\n`;
        } else {
            text += `・骨盤の前後傾角は ${estimatedPelvicTilt}° と生理的弯曲（ニュートラル）を綺麗に保っています。\n`;
        }

        text += `\n3. 介入アプローチプラン（推奨運動療法）:\n`;
        if (estimatedPelvicTilt > 12) {
            text += `・股関節屈筋群（腸腰筋、大腿直筋）の静的ストレッチ（各30秒×3セット）\n・グルートブリッジ（臀筋群の強化：15回×3セット）\n・プランク（深部体幹筋の強化：30秒維持×3セット）`;
        } else if (estimatedPelvicTilt < -5) {
            text += `・大腿後面（ハムストリングス）のリリースおよびストレッチ（30秒×3セット）\n・キャット＆カウ（脊柱可動性の回復）\n・ヒップヒンジトレーニング（股関節主導での前屈の再学習）`;
        } else {
            text += `・全身アライメント維持のための体幹安定化トレーニング（コアスタビリティの維持）`;
        }

        textBlock.innerText = text;
    }, 1000);
};

// --- 11. Modal Dialog Helper functions ---

function customAlert(title, message) {
    document.getElementById('modalTitle').innerText = title;
    document.getElementById('modalMessage').innerText = message;
    document.getElementById('modalCancelBtn').style.display = 'none';
    document.getElementById('modalOkBtn').onclick = () => {
        document.getElementById('customModal').style.display = 'none';
    };
    document.getElementById('customModal').style.display = 'flex';
}

function customConfirm(title, message, onConfirm) {
    document.getElementById('modalTitle').innerText = title;
    document.getElementById('modalMessage').innerText = message;
    document.getElementById('modalCancelBtn').style.display = 'block';
    document.getElementById('modalCancelBtn').onclick = () => {
        document.getElementById('customModal').style.display = 'none';
    };
    document.getElementById('modalOkBtn').onclick = () => {
        document.getElementById('customModal').style.display = 'none';
        if (onConfirm) onConfirm();
    };
    document.getElementById('customModal').style.display = 'flex';
}

// --- 12. Helper Utility functions ---

function varColor(cssVarName) {
    return getComputedStyle(document.documentElement).getPropertyValue(cssVarName).trim();
}

function updatePelvicTiltDisplay() {
    if (pelvicTiltSlider && tiltValDisplay) {
        tiltValDisplay.innerText = estimatedPelvicTilt === 0 ? "0° (ニュートラル)" : 
            (estimatedPelvicTilt > 0 ? `+${estimatedPelvicTilt}° (前傾)` : `${estimatedPelvicTilt}° (後傾)`);
    }
}

function refreshReportView() {
    if (appMode === 'playback') return;
    
    // Draw static report frame
    ctxMP.fillStyle = "#0c0f12";
    ctxMP.fillRect(0, 0, canvasMP.width, canvasMP.height);

    const baselineKps = window.reportDataStore[currentTab];
    if (baselineKps && baselineKps.length > 0) {
        const getK = name => baselineKps.find(k => k.name === name || k.name === BLAZEPOSE_KEYPOINTS.indexOf(name).toString());
        drawAnchorGuides(ctxMP, getK);
        drawSkeleton(ctxMP, baselineKps, "rgba(0, 191, 255, 0.85)");
        calculateWeightBearing(ctxMP, baselineKps);
        drawOHSFrontAnalysis(ctxMP, baselineKps);
        drawOHSSideAnalysis(ctxMP, baselineKps);
        drawKendallAlignment(ctxMP, baselineKps);

        if (selectedJointIndex !== null) {
            const kp = baselineKps[selectedJointIndex];
            if (kp) drawTargetCrosshair(ctxMP, kp);
        }
    }
}

// --- 13. Event Listeners Setup ---

document.addEventListener('DOMContentLoaded', async () => {
    await dbManager.init();
    await initPoseDetection();

    // Start/Stop Camera trigger
    startBtn.onclick = () => {
        if (isRunning) {
            stopCamera();
        } else {
            startCamera();
        }
    };

    // Recording trigger
    recBtn.onclick = () => {
        if (!isRecording) {
            startRecording();
        }
    };

    // Playback Timeline scrub trigger
    timelineSlider.oninput = () => {
        togglePlay(false);
        const fIdx = parseInt(timelineSlider.value);
        renderPlaybackFrame(fIdx);
    };

    // Close buttons
    document.getElementById('closeHistoryBtn').onclick = () => {
        historyPanel.style.display = 'none';
    };

    document.getElementById('showHistoryBtn').onclick = async () => {
        if (historyPanel.style.display === 'flex') {
            historyPanel.style.display = 'none';
        } else {
            await refreshHistoryList();
            historyPanel.style.display = 'flex';
        }
    };

    // Hide/Show controls layer trigger
    document.getElementById('toggleUiBtn').onclick = (e) => {
        const controls = document.getElementById('controlsBox');
        if (controls.style.display === 'none') {
            controls.style.display = 'flex';
            e.target.innerText = "🔽 UIを隠す";
        } else {
            controls.style.display = 'none';
            e.target.innerText = "🔼 UIを表示";
        }
    };

    // Matte calibration triggers
    const calibrateBtn = document.getElementById('calibrateMatBtn');
    calibrateBtn.onclick = () => {
        if (calibState === "idle") {
            calibState = "wait_left";
            calibrationPoints = [];
            calibrateBtn.classList.add('active');
            calibrateBtn.innerText = "📍 左タップして指定";
            customAlert("マット校正", "1. 画面上のマットの左端をタップしてください。\n2. 次に右端をタップします。\n3. D-Padで位置を微調整して『校正完了』を押します。");
        } else if (calibState === "adjust_left") {
            calibState = "wait_right";
            calibrateBtn.innerText = "📍 右タップして指定";
        } else if (calibState === "adjust_right") {
            if (calibrationPoints.length === 2) {
                // Known mat distance = 45.0 cm
                const distPx = Math.hypot(calibrationPoints[1].x - calibrationPoints[0].x, calibrationPoints[1].y - calibrationPoints[0].y);
                if (distPx > 10) {
                    pxToCmRatio = 45.0 / distPx;
                    console.log(`Calibrated scale: ${pxToCmRatio.toFixed(4)} cm/px`);
                    infoPanel.innerHTML = `マット校正完了<br>スケール: ${pxToCmRatio.toFixed(3)} cm/px`;
                }
            }
            calibState = "idle";
            calibrateBtn.classList.remove('active');
            calibrateBtn.innerText = "✅ 校正完了";
            dpadPanel.style.display = 'none';
            setTimeout(() => {
                if (calibState === 'idle') calibrateBtn.innerText = "📏 マット校正";
            }, 2000);
        } else {
            calibState = "idle";
            calibrateBtn.classList.remove('active');
            calibrateBtn.innerText = "📏 マット校正";
            dpadPanel.style.display = 'none';
        }
    };

    // Pelvic Tilt slider adjustment trigger
    pelvicTiltSlider.oninput = (e) => {
        estimatedPelvicTilt = parseInt(e.target.value);
        updatePelvicTiltDisplay();
        
        // Re-generate Virtual ASIS with updated tilt
        if (appMode === 'playback') {
            const fIdx = parseInt(timelineSlider.value);
            const currentFrame = playbackDataMP[fIdx];
            if (currentFrame) {
                currentFrame.keypoints = generateVirtualASIS(currentFrame.keypoints);
                currentFrame.pelvicTilt = estimatedPelvicTilt;
                renderPlaybackFrame(fIdx);
            }
        } else if (isPausedForEdit) {
            window.reportDataStore[currentTab] = generateVirtualASIS(window.reportDataStore[currentTab]);
            refreshReportView();
        }
    };

    // D-Pad adjustment step toggle
    const dpadStep = document.getElementById('dpadStep');
    dpadStep.onclick = () => {
        dpadStepVal = dpadStepVal === 1 ? 5 : 1;
        dpadStep.innerText = `${dpadStepVal}px`;
    };

    // D-Pad direction clicks
    document.getElementById('dpadUp').onclick = () => nudgeJoint(0, -dpadStepVal);
    document.getElementById('dpadDown').onclick = () => nudgeJoint(0, dpadStepVal);
    document.getElementById('dpadLeft').onclick = () => nudgeJoint(-dpadStepVal, 0);
    document.getElementById('dpadRight').onclick = () => nudgeJoint(dpadStepVal, 0);
    
    document.getElementById('dpadClose').onclick = () => {
        selectedJointIndex = null;
        dpadPanel.style.display = 'none';
        if (calibState.startsWith('adjust')) {
            calibState = "idle";
            calibrateBtn.classList.remove('active');
            calibrateBtn.innerText = "📏 マット校正";
        }
        if (appMode === 'playback') renderPlaybackFrame(parseInt(timelineSlider.value));
        else refreshReportView();
    };

    // Edit Frame mode trigger
    editFrameBtn.onclick = () => {
        if (!isEditingPlaybackFrame && appMode === 'playback') {
            togglePlay(false);
            isEditingPlaybackFrame = true;
            editFrameBtn.innerText = "✅ 編集完了";
            editFrameBtn.style.background = varColor('--accent-green');
            customAlert("微調整モード", "骨画上のずれている骨関節点をタップし、開いたD-Padで1pxずつ正しい位置に移動してください。");
        } else {
            isEditingPlaybackFrame = false;
            editFrameBtn.innerText = "✂️ 微調整";
            editFrameBtn.style.background = varColor('--accent-orange');
            selectedJointIndex = null;
            dpadPanel.style.display = 'none';
            if (appMode === 'playback') renderPlaybackFrame(parseInt(timelineSlider.value));
        }
    };

    // Playback timeline go back to camera mode
    document.getElementById('backToCamBtn').onclick = () => {
        exitPlaybackMode();
    };

    // Canvas click register
    canvasMP.addEventListener('mousedown', handleCanvasClick);
    canvasMP.addEventListener('touchstart', (e) => {
        if (e.touches.length > 0) {
            handleCanvasClick(e.touches[0]);
        }
    });

    // Radar COP Dragging handler
    const radarWrapper = document.getElementById('radarWrapperMP');
    let isDraggingRadar = false;
    let dragStartX = 0, dragStartY = 0;
    
    radarWrapper.addEventListener('mousedown', (e) => {
        isDraggingRadar = true;
        radarWrapper.classList.add('dragging');
        dragStartX = e.clientX - radarWrapper.offsetLeft;
        dragStartY = e.clientY - radarWrapper.offsetTop;
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDraggingRadar) return;
        radarWrapper.style.left = `${e.clientX - dragStartX}px`;
        radarWrapper.style.top = `${e.clientY - dragStartY}px`;
        radarWrapper.style.right = 'auto'; // Break CSS absolute lock
    });

    document.addEventListener('mouseup', () => {
        isDraggingRadar = false;
        radarWrapper.classList.remove('dragging');
    });

    // Touch support for Radar drag
    radarWrapper.addEventListener('touchstart', (e) => {
        if (e.touches.length > 0) {
            isDraggingRadar = true;
            radarWrapper.classList.add('dragging');
            dragStartX = e.touches[0].clientX - radarWrapper.offsetLeft;
            dragStartY = e.touches[0].clientY - radarWrapper.offsetTop;
        }
    });

    radarWrapper.addEventListener('touchmove', (e) => {
        if (!isDraggingRadar || e.touches.length === 0) return;
        radarWrapper.style.left = `${e.touches[0].clientX - dragStartX}px`;
        radarWrapper.style.top = `${e.touches[0].clientY - dragStartY}px`;
        radarWrapper.style.right = 'auto';
    });

    radarWrapper.addEventListener('touchend', () => {
        isDraggingRadar = false;
        radarWrapper.classList.remove('dragging');
    });

    // WebM / MP4 video export trigger
    document.getElementById('exportVideoBtn').onclick = async () => {
        if (playbackDataMP.length === 0) return;

        const btn = document.getElementById('exportVideoBtn');
        btn.innerText = "🎬 動画生成中...";
        btn.disabled = true;

        try {
            // Setup capture stream from main canvas (at 15 fps)
            const stream = canvasMP.captureStream(15);
            let options = { mimeType: 'video/webm;codecs=vp9' };
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options = { mimeType: 'video/webm' };
            }

            const recorder = new MediaRecorder(stream, options);
            const chunks = [];
            
            recorder.ondataavailable = e => {
                if (e.data && e.data.size > 0) chunks.push(e.data);
            };

            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: 'video/webm' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `posture_analysis_${Date.now()}.webm`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                btn.innerText = "🎥 動画出力";
                btn.disabled = false;
            };

            // Run artificial high speed rendering sweep to generate video
            recorder.start();
            
            let frameIdx = 0;
            const playSweep = () => {
                if (frameIdx >= playbackDataMP.length) {
                    recorder.stop();
                    return;
                }
                renderPlaybackFrame(frameIdx);
                frameIdx++;
                setTimeout(playSweep, 1000 / 15);
            };
            playSweep();

        } catch (err) {
            console.error("Video export failed: ", err);
            btn.innerText = "🎥 出力エラー";
            btn.disabled = false;
        }
    };
});
