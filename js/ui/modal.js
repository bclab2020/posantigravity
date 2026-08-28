/**
 * modal.js
 * ---------------------------------------------------------------------------
 * 旧版では API設定/専門家ログイン/メンター予約/ジャイロ許可 の4〜5個の
 * モーダルがそれぞれ似た構造のマークアップとイベント配線を個別に持っていた。
 * ここでは開閉ロジックを共通化し、各モーダル固有の処理だけを呼び出し側
 * （specialist.js / auth.js / この後の initMentorBookingModal など）に残す。
 */

export function openModal(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'block';
}

export function closeModal(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
}

/** 「閉じる」ボタンと背景クリックで閉じる、共通の配線ヘルパー */
export function wireModal(modalId, closeBtnId) {
    var closeBtn = document.getElementById(closeBtnId);
    if (closeBtn) {
        closeBtn.onclick = function () { closeModal(modalId); };
    }
}

export function initApiSettingModal() {
    var showApiBtn = document.getElementById('showApiBtn');
    var geminiApiKeyInput = document.getElementById('geminiApiKey');
    var saveApiBtn = document.getElementById('saveApiBtn');

    wireModal('apiSettingPanel', 'closeApiBtn');

    if (showApiBtn) {
        showApiBtn.onclick = function () {
            geminiApiKeyInput.value = localStorage.getItem('gemini_api_key') || '';
            openModal('apiSettingPanel');
        };
    }
    if (saveApiBtn) {
        saveApiBtn.onclick = function () {
            localStorage.setItem('gemini_api_key', geminiApiKeyInput.value.trim());
            closeModal('apiSettingPanel');
            alert("APIキーを保存しました。");
        };
    }
}

/**
 * パスワード（type="password"）入力欄すべてに「見る/隠す」トグルボタンを配線する。
 * 会員登録・ログイン・専門家ログイン・Gemini APIキー設定など、追加のたび
 * 個別配線しなくて済むよう data-target 属性ベースで汎用化してある。
 */
export function initPasswordToggles() {
    var buttons = document.querySelectorAll('.password-toggle-btn');
    buttons.forEach(function (btn) {
        var input = document.getElementById(btn.getAttribute('data-target'));
        if (!input) return;
        btn.onclick = function () {
            var nowVisible = input.type === 'password';
            input.type = nowVisible ? 'text' : 'password';
            btn.classList.toggle('is-visible', nowVisible);
            btn.setAttribute('aria-label', nowVisible ? '隠す' : '表示');
            btn.textContent = nowVisible ? '隠す' : '表示';
        };
    });
}

export function initGyroPermissionModal(requestPermissionFn) {
    var btn = document.getElementById('submitGyroPermissionBtn');
    if (btn) btn.onclick = requestPermissionFn;
}

export function initMentorBookingModal(dataService, getPatientName) {
    wireModal('mentorBookingModal', 'closeBookingBtn');

    var mentorSelect = document.getElementById('mentorSelect');
    var bookingDateInput = document.getElementById('bookingDate');
    var bookingInquiryInput = document.getElementById('bookingInquiry');
    var submitBookingBtn = document.getElementById('submitBookingBtn');

    if (submitBookingBtn) {
        submitBookingBtn.onclick = async function () {
            var mentor = mentorSelect.value;
            var mentorName = mentorSelect.options[mentorSelect.selectedIndex].text;
            var date = bookingDateInput.value;
            var inquiry = bookingInquiryInput.value.trim();

            if (!date) {
                alert("希望日時を選択してください。");
                return;
            }

            var booking = {
                id: "book_" + Date.now(),
                patientName: getPatientName() || "ゲスト",
                mentor: mentor,
                mentorName: mentorName,
                date: date,
                inquiry: inquiry,
                timestamp: Date.now()
            };

            try {
                await dataService.saveBooking(booking);
            } catch (e) {
                console.error("Booking save failed:", e);
            }

            closeModal('mentorBookingModal');
            alert("個別相談セッションのご予約を受け付けました！\n\n【予約詳細】\n担当: " + mentorName + "\n日時: " + new Date(date).toLocaleString() + "\n\n折り返し、決済リンクおよびWebミーティングの案内をメールでお送りいたします。");
        };
    }
}
