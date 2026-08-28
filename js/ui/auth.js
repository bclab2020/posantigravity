/**
 * auth.js
 * ---------------------------------------------------------------------------
 * 新規追加: アスリート向けの簡易会員登録・ログインフロー、および
 * 専門家ログイン（旧: ハードコードID/PASS → 新: Firebase実アカウント）のUI配線。
 *
 * 会員登録はメールアドレス＋パスワードのみ（開発段階の検証運用のため、
 * メール確認や複雑なパスワードポリシーは設けていない）。
 * クラウド未設定（firebase-config.js未編集）の場合は、認証UI自体を
 * スキップしてゲスト扱いで従来通りローカル保存のみで動作する。
 */

import { openModal, closeModal } from './modal.js';
import { heightInput, footSizeInput, patientNameInput } from '../core/dom.js';

export function initAuthUI(dataService, onAuthResolved) {
    if (!dataService.isCloudEnabled()) {
        // Firebase未設定: 会員登録UIを出さずゲストモードのまま起動
        console.log("[auth] Firebase未設定のため、会員登録UIをスキップします（ローカル保存のみ）。");
        if (onAuthResolved) onAuthResolved(null);
        return;
    }

    // STARTボタン遷移処理（2026-08-28追加）
    var startBtn = document.getElementById('authStartBtn');
    var topScreen = document.getElementById('authTopScreen');
    var formContainer = document.getElementById('authFormContainer');
    if (startBtn && topScreen && formContainer) {
        // 毎回認証モーダルが開くたびに、TOP画面を表示状態に戻しておく
        topScreen.style.display = 'flex';
        topScreen.classList.remove('fade-out');
        formContainer.style.display = 'none';
        formContainer.classList.remove('fade-in');
        
        startBtn.onclick = function () {
            topScreen.classList.add('fade-out');
            setTimeout(function () {
                topScreen.style.display = 'none';
                formContainer.style.display = 'block';
                formContainer.classList.add('fade-in');
            }, 400); // 400msのフェードアウト後にフォームを表示
        };
    }

    var authModal = document.getElementById('authModal');
    var tabSignup = document.getElementById('authTabSignup');
    var tabLogin = document.getElementById('authTabLogin');
    var tabGuest = document.getElementById('authTabGuest');
    var signupForm = document.getElementById('authSignupForm');
    var signupConfirm = document.getElementById('authSignupConfirm');
    var loginForm = document.getElementById('authLoginForm');
    var guestForm = document.getElementById('authGuestForm');
    var errorMsg = document.getElementById('authErrorMsg');

    function showError(msg) {
        errorMsg.innerText = msg;
        errorMsg.style.display = 'block';
    }
    function clearError() {
        errorMsg.style.display = 'none';
    }
    function showSignupForm() {
        signupForm.style.display = 'block';
        signupConfirm.style.display = 'none';
    }
    var TABS = { signup: [tabSignup, signupForm], login: [tabLogin, loginForm], guest: [tabGuest, guestForm] };
    function switchTab(which) {
        clearError();
        showSignupForm(); // タブを切り替えるたびに会員登録は入力画面の状態に戻しておく（確認画面を出しっぱなしにしない）
        Object.keys(TABS).forEach(function (key) {
            var tab = TABS[key][0], panel = TABS[key][1];
            if (!tab || !panel) return;
            tab.classList.toggle('active', key === which);
            panel.style.display = (key === which) ? 'block' : 'none';
        });
    }
    if (tabSignup) tabSignup.onclick = function () { switchTab('signup'); };
    if (tabLogin) tabLogin.onclick = function () { switchTab('login'); };
    if (tabGuest) tabGuest.onclick = function () { switchTab('guest'); };

    var signupBtn = document.getElementById('authSignupBtn');
    if (signupBtn) {
        // 「確認画面へ」: この時点ではまだ登録処理を行わず、入力内容を確認画面に表示するだけ
        signupBtn.onclick = function () {
            clearError();
            var name = document.getElementById('authSignupName').value.trim();
            var email = document.getElementById('authSignupEmail').value.trim();
            var password = document.getElementById('authSignupPassword').value;
            var height = parseFloat(document.getElementById('authSignupHeight').value) || 170;
            var footSize = parseFloat(document.getElementById('authSignupFootSize').value) || 25;

            if (!name || !email || !password) {
                showError("お名前・メールアドレス・パスワードをすべて入力してください。");
                return;
            }
            if (password.length < 6) {
                showError("パスワードは6文字以上で設定してください。");
                return;
            }

            document.getElementById('confirmName').innerText = name;
            document.getElementById('confirmEmail').innerText = email;
            document.getElementById('confirmHeight').innerText = height + " cm";
            document.getElementById('confirmFootSize').innerText = footSize + " cm";

            signupForm.style.display = 'none';
            signupConfirm.style.display = 'block';
        };
    }

    var signupBackBtn = document.getElementById('authSignupBackBtn');
    if (signupBackBtn) {
        signupBackBtn.onclick = function () {
            clearError();
            showSignupForm();
        };
    }

    var signupConfirmBtn = document.getElementById('authSignupConfirmBtn');
    if (signupConfirmBtn) {
        // ここで初めて実際の登録処理を行う
        signupConfirmBtn.onclick = async function () {
            clearError();
            var name = document.getElementById('authSignupName').value.trim();
            var email = document.getElementById('authSignupEmail').value.trim();
            var password = document.getElementById('authSignupPassword').value;
            var height = parseFloat(document.getElementById('authSignupHeight').value) || 170;
            var footSize = parseFloat(document.getElementById('authSignupFootSize').value) || 25;

            signupConfirmBtn.disabled = true;
            try {
                await dataService.signUpAthlete(email, password, name, { height: height, footSize: footSize });
                patientNameInput.value = name;
                heightInput.value = height;
                footSizeInput.value = footSize;
                closeModal('authModal');
                if (onAuthResolved) onAuthResolved(dataService.getCurrentUser());
            } catch (e) {
                // 登録自体が失敗した場合は、入力し直せるようフォーム画面に戻す
                showSignupForm();
                showError(translateAuthError(e));
            } finally {
                signupConfirmBtn.disabled = false;
            }
        };
    }

    var loginBtn = document.getElementById('authLoginBtn');
    if (loginBtn) {
        loginBtn.onclick = async function () {
            clearError();
            var email = document.getElementById('authLoginEmail').value.trim();
            var password = document.getElementById('authLoginPassword').value;
            if (!email || !password) {
                showError("メールアドレスとパスワードを入力してください。");
                return;
            }
            loginBtn.disabled = true;
            try {
                await dataService.loginAthlete(email, password);
                var profile = await dataService.getCurrentUser();
                if (profile && profile.displayName) patientNameInput.value = profile.displayName;
                closeModal('authModal');
                if (onAuthResolved) onAuthResolved(dataService.getCurrentUser());
            } catch (e) {
                showError(translateAuthError(e));
            } finally {
                loginBtn.disabled = false;
            }
        };
    }

    var guestBtn = document.getElementById('authGuestBtn');
    if (guestBtn) {
        guestBtn.onclick = async function () {
            clearError();
            guestBtn.disabled = true;
            try {
                await dataService.loginAsGuest();
                closeModal('authModal');
                if (onAuthResolved) onAuthResolved(dataService.getCurrentUser());
            } catch (e) {
                showError(translateAuthError(e));
            } finally {
                guestBtn.disabled = false;
            }
        };
    }

    openModal('authModal');
}

export function initAccountBadge(dataService) {
    var badge = document.getElementById('accountBadge');
    var signOutBtn = document.getElementById('accountSignOutBtn');
    if (!badge) return;

    function refresh() {
        var user = dataService.getCurrentUser();
        if (!dataService.isCloudEnabled()) {
            badge.style.display = 'none';
            return;
        }
        badge.style.display = 'flex';
        if (!user) {
            badge.querySelector('.account-name').innerText = "未ログイン";
        } else if (user.isAnonymous) {
            badge.querySelector('.account-name').innerText = "👤 ゲスト利用中";
        } else {
            badge.querySelector('.account-name').innerText = "👤 " + (user.displayName || user.email);
        }
    }
    if (signOutBtn) {
        signOutBtn.onclick = async function () {
            await dataService.logout();
            window.location.reload();
        };
    }
    refresh();
    return refresh;
}

function translateAuthError(e) {
    var code = e && e.code ? e.code : "";
    var map = {
        'auth/email-already-in-use': "このメールアドレスは既に登録されています。ログインをお試しください。",
        'auth/invalid-email': "メールアドレスの形式が正しくありません。",
        'auth/weak-password': "パスワードは6文字以上で設定してください。",
        'auth/user-not-found': "アカウントが見つかりません。会員登録をお試しください。",
        'auth/wrong-password': "パスワードが正しくありません。",
        'auth/invalid-credential': "メールアドレスまたはパスワードが正しくありません。"
    };
    return map[code] || ("エラーが発生しました: " + (e && e.message ? e.message : e));
}
