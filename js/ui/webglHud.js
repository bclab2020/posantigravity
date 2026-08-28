/**
 * webglHud.js
 * ---------------------------------------------------------------------------
 * Three.jsを用いた右サイドパネルのステルスHUD（膝屈曲角度・骨盤傾斜・
 * 頸部オフセットのリアルタイム3Dオーバーレイ）。元 app.js のV2.8.0
 * WebGL Stealth HUD Core Logic を移植。
 */

import { state } from '../core/state.js';

var glCanvas, glScene, glCamera, glRenderer, glClock;
var glJoints = {};
var glMuscles = [];
var hudWidth = 640, hudHeight = 480;

export function initWebGLHUD() {
    if (typeof THREE === 'undefined') {
        setTimeout(initWebGLHUD, 500);
        return;
    }

    glCanvas = document.getElementById('webgl-canvas');
    if (!glCanvas) {
        setTimeout(initWebGLHUD, 500);
        return;
    }

    glScene = new THREE.Scene();
    glClock = new THREE.Clock();

    glCamera = new THREE.OrthographicCamera(-320, 320, 240, -240, 1, 1000);
    glCamera.position.set(0, 0, 100);

    glRenderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true });
    glRenderer.setSize(glCanvas.clientWidth, glCanvas.clientHeight);
    glRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    var resizeObserver = new ResizeObserver(function (entries) {
        entries.forEach(function (entry) {
            var w = entry.contentRect.width, h = entry.contentRect.height;
            glRenderer.setSize(w, h);
            glCamera.updateProjectionMatrix();
        });
    });
    resizeObserver.observe(glCanvas);

    var jointMat = new THREE.MeshBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0.6 });
    var sphereGeo = new THREE.SphereGeometry(6, 16, 16);

    ['nose', 'left_ear', 'right_ear', 'left_shoulder', 'right_shoulder', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle'].forEach(function (name) {
        var mesh = new THREE.Mesh(sphereGeo, jointMat);
        mesh.position.set(0, 0, -9999);
        glScene.add(mesh);
        glJoints[name] = mesh;
    });

    var cylinderGeo = new THREE.CylinderGeometry(8, 5, 1, 12, 1);
    glMuscles = [
        { name: 'trapezius_l', start: 'left_ear', end: 'left_shoulder', mesh: new THREE.Mesh(cylinderGeo, new THREE.MeshBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.3, side: THREE.DoubleSide })), barId: 'bar-cervical', maxVal: 40 },
        { name: 'rectus_femoris_l', start: 'left_hip', end: 'left_knee', mesh: new THREE.Mesh(cylinderGeo, new THREE.MeshBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.3, side: THREE.DoubleSide })), barId: 'bar-l-knee', maxVal: 105 },
        { name: 'rectus_femoris_r', start: 'right_hip', end: 'right_knee', mesh: new THREE.Mesh(cylinderGeo, new THREE.MeshBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.3, side: THREE.DoubleSide })), barId: 'bar-r-knee', maxVal: 105 },
        { name: 'erectors', start: 'left_shoulder', end: 'left_hip', mesh: new THREE.Mesh(cylinderGeo, new THREE.MeshBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.3, side: THREE.DoubleSide })), barId: 'bar-pelvic-tilt', maxVal: 17.5 }
    ];
    glMuscles.forEach(function (m) { glScene.add(m.mesh); });

    requestAnimationFrame(glRenderLoop);
}

function glRenderLoop() {
    if (!glRenderer || !glScene || !glCamera) return;
    requestAnimationFrame(glRenderLoop);

    var time = glClock.getElapsedTime();
    glMuscles.forEach(function (m) {
        m.mesh.material.opacity = m.isCritical ? (Math.sin(time * 12) * 0.15 + 0.65) : 0.3;
    });
    glRenderer.render(glScene, glCamera);
}

function mapMpToGl(x, y, w, h) {
    var normX = (x / w) * 640, normY = (y / h) * 480;
    return { x: normX - 320, y: 240 - normY };
}

window.updateWebGLPose = function (keypoints, w, h) {
    if (!glScene || !glJoints || !glMuscles || glMuscles.length < 4) return;

    hudWidth = w || 640;
    hudHeight = h || 480;

    if (!keypoints || keypoints.length === 0) {
        Object.keys(glJoints).forEach(function (k) { glJoints[k].position.set(0, 0, -9999); });
        glMuscles.forEach(function (m) { m.mesh.visible = false; });
        return;
    }

    var foundKps = {};
    keypoints.forEach(function (kp) {
        var name = kp.name;
        if (glJoints[name]) {
            if (kp.score !== undefined && kp.score < 0.55) { glJoints[name].position.set(0, 0, -9999); return; }
            var glPos = mapMpToGl(kp.x, kp.y, hudWidth, hudHeight);
            glJoints[name].position.set(glPos.x, glPos.y, 0);
            foundKps[name] = glPos;
        }
    });

    glMuscles.forEach(function (muscle) {
        var startMesh = glJoints[muscle.start], endMesh = glJoints[muscle.end];
        if (startMesh && endMesh && startMesh.position.z > -5000 && endMesh.position.z > -5000) {
            var startPos = startMesh.position, endPos = endMesh.position;
            var dir = new THREE.Vector3().subVectors(endPos, startPos);
            var len = dir.length();
            muscle.mesh.scale.set(1, len, 1);
            var midPoint = new THREE.Vector3().addVectors(startPos, endPos).multiplyScalar(0.5);
            muscle.mesh.position.copy(midPoint);
            dir.normalize();
            muscle.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
            muscle.mesh.visible = true;
        } else {
            muscle.mesh.visible = false;
        }
    });

    var getAngle = function (a, b, c) {
        var ab = { x: b.x - a.x, y: b.y - a.y }, cb = { x: b.x - c.x, y: b.y - c.y };
        var dot = ab.x * cb.x + ab.y * cb.y;
        var normAB = Math.sqrt(Math.pow(ab.x, 2) + Math.pow(ab.y, 2));
        var normCB = Math.sqrt(Math.pow(cb.x, 2) + Math.pow(cb.y, 2));
        if (normAB === 0 || normCB === 0) return 0;
        return Math.acos(dot / (normAB * normCB)) * 180 / Math.PI;
    };

    var valKneeL = 0, valKneeR = 0, valPelvic = 0, valCervical = 0;

    if (foundKps.left_hip && foundKps.left_knee && foundKps.left_ankle) valKneeL = Math.max(0, 180 - getAngle(foundKps.left_hip, foundKps.left_knee, foundKps.left_ankle));
    if (foundKps.right_hip && foundKps.right_knee && foundKps.right_ankle) valKneeR = Math.max(0, 180 - getAngle(foundKps.right_hip, foundKps.right_knee, foundKps.right_ankle));
    if (foundKps.left_shoulder && foundKps.left_hip) valPelvic = state.estimatedPelvicTilt || 4.8;
    if (foundKps.left_ear && foundKps.left_shoulder) valCervical = state.pxToCmRatio ? (Math.abs(foundKps.left_ear.x - foundKps.left_shoulder.x) * state.pxToCmRatio * 10) : 38;

    if (state.activeSessionId === 'demo_athletecore_2026') {
        var mockSquatPhase = (Math.sin(glClock.getElapsedTime() * 1.5) + 1) / 2;
        valKneeL = mockSquatPhase * 105;
        valKneeR = mockSquatPhase * 105;
        valPelvic = 4.8 + (mockSquatPhase * 12.5);
        valCervical = 25 + (mockSquatPhase * 13.0);
    }

    document.getElementById('val-l-knee').innerText = valKneeL.toFixed(1) + "°";
    document.getElementById('val-r-knee').innerText = valKneeR.toFixed(1) + "°";
    document.getElementById('val-pelvic-tilt').innerText = valPelvic.toFixed(1) + "°";
    document.getElementById('val-cervical').innerText = valCervical.toFixed(0) + " mm";

    // パラメーターパネルを縦書きレイアウト化した際、バーも横幅ベース→
    // 高さベースの表示に変更した（style.css の .bar-container/.bar-fill参照）。
    document.getElementById('bar-l-knee').style.height = Math.min(100, (valKneeL / 105) * 100) + "%";
    document.getElementById('bar-r-knee').style.height = Math.min(100, (valKneeR / 105) * 100) + "%";
    document.getElementById('bar-pelvic-tilt').style.height = Math.min(100, (valPelvic / 17.5) * 100) + "%";
    document.getElementById('bar-cervical').style.height = Math.min(100, (valCervical / 40) * 100) + "%";

    var updateColors = function (muscleIndex, ratio) {
        var m = glMuscles[muscleIndex];
        var color = new THREE.Color();
        var bar = document.getElementById(m.barId);
        if (ratio < 0.3) { color.setHex(0x333333); m.isCritical = false; bar.style.backgroundColor = '#333333'; }
        else if (ratio < 0.8) { var sub = (ratio - 0.3) / 0.5; color.lerpColors(new THREE.Color(0x333333), new THREE.Color(0xffaa00), sub); m.isCritical = false; bar.style.backgroundColor = '#ffaa00'; }
        else { var sub2 = (ratio - 0.8) / 0.2; color.lerpColors(new THREE.Color(0xffaa00), new THREE.Color(0xff3c00), sub2); m.isCritical = true; bar.style.backgroundColor = '#ff3c00'; }
        m.mesh.material.color.copy(color);
    };

    updateColors(0, valCervical / 40);
    updateColors(1, valKneeL / 105);
    updateColors(2, valKneeR / 105);
    updateColors(3, valPelvic / 17.5);
};

export function bindAnalyticsDrawerToggle() {
    var toggleBtn = document.getElementById('toggleAnalyticsBtn');
    var analyticsArea = document.getElementById('analyticsArea');
    if (!toggleBtn || !analyticsArea) return;

    // 「パラメーターを表示」は既定オンになり、撮影画面に入った時点で
    // shootFlow.js側が自動的にこのパネルを開いた状態にする。この関数の
    // トグルボタンは、撮影中に画面が窮屈だと感じた瞬間だけ一時的に閉じる
    // ための専用の逃げ道として使う。
    // 以前はパネルの外側をタップすると自動で閉じる挙動もあったが、それだと
    // 「既定で開いている」状態のまま撮影ボタンを押すなど他の操作をした
    // 瞬間に、意図せずパネルが閉じてしまう（既定オンにした意味が薄れる）
    // ため廃止し、このボタンでの明示的な開閉のみにした。
    toggleBtn.onclick = function (e) {
        e.stopPropagation();
        analyticsArea.classList.toggle('analytics-open');
        if (analyticsArea.classList.contains('analytics-open')) {
            toggleBtn.innerText = "✖ 閉じる";
            toggleBtn.style.borderColor = "var(--accent-red)";
            toggleBtn.style.color = "var(--accent-red)";
        } else {
            toggleBtn.innerText = "📊 パラメーター";
            toggleBtn.style.borderColor = "var(--accent-teal)";
            toggleBtn.style.color = "var(--accent-teal)";
        }
    };
}
