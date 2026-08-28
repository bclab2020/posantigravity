/**
 * home.js
 * ---------------------------------------------------------------------------
 * v4.0.0 で新設した「ホーム」ページ。ログイン直後の起点として、
 * 新規測定・履歴への導線と直近の測定サマリーだけを見せる。
 * （2026-08-26: 「専門家に相談する」カードは企画者の依頼により撤去。
 * 3カード構成だった名残でファイル冒頭のコメントも合わせて更新。）
 */

import { state, MODE_NAMES_JP } from '../core/state.js';
import { navigate } from './router.js';

export function initHomeUI(dataService) {
    var shootCard = document.getElementById('homeShootCard');
    var historyCard = document.getElementById('homeHistoryCard');
    var greeting = document.getElementById('homeGreeting');
    var sub = document.getElementById('homeSub');
    var recentSummary = document.getElementById('homeRecentSummary');

    if (shootCard) shootCard.onclick = function () { navigate('shoot'); };
    if (historyCard) historyCard.onclick = function () { navigate('history'); };
    // 2026-08-26削除: 「🩺 専門家に相談する」カード(homeMentorCard)は
    // 企画者の依頼により撤去したため、このカードのクリック配線
    // （mentorBookingModalを開く処理）も不要になり削除した。

    function refreshGreeting() {
        var user = dataService.getCurrentUser();
        var name = "ゲスト";
        if (user) {
            if (state.isSpecialist) name = "専門家";
            else if (!user.isAnonymous) name = user.displayName || user.email;
        }
        if (greeting) greeting.textContent = "こんにちは、" + name + "さん";
        if (sub) sub.textContent = state.isSpecialist ? "担当選手の測定データを確認しましょう。" : "今日のコンディションを記録しましょう。";
    }

    async function refreshRecent() {
        if (!recentSummary) return;
        try {
            var sessions = await dataService.getAllSessions();
            if (!sessions || sessions.length === 0) {
                recentSummary.textContent = "まだ測定データがありません";
                return;
            }
            sessions.sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });

            if (state.isSpecialist) {
                recentSummary.textContent = sessions.length + "件のセッションが登録されています";
            } else {
                var latest = sessions[0];
                var date = new Date(latest.timestamp);
                var dateStr = (date.getMonth() + 1) + "/" + date.getDate();
                var modeName = MODE_NAMES_JP[latest.mode] || latest.mode;
                recentSummary.textContent = dateStr + " " + modeName + "（全" + sessions.length + "件保存済み）";
            }
        } catch (e) {
            console.error("[home] recent session summary failed:", e);
            recentSummary.textContent = "読込に失敗しました";
        }
    }

    refreshGreeting();
    refreshRecent();

    return {
        refresh: function () { refreshGreeting(); refreshRecent(); }
    };
}
