/**
 * router.js
 * ---------------------------------------------------------------------------
 * v4.0.0 で導入したページ遷移（ホーム/撮影/履歴/設定）を担当する、
 * URLハッシュベースの軽量ルーター。
 *
 * 元の実装は「1画面にモーダル・ドロワーを重ねる」構成だったため、カメラ/
 * 姿勢推定ループなどコアロジックはページの出し入れに一切関知しない。
 * ルーターはあくまで `.app-page` の表示/非表示と `.nav-item` の
 * アクティブ状態を切り替えるだけの薄い層。
 */

var ROUTES = ['home', 'shoot', 'history', 'settings'];
var listeners = [];

function getRouteFromHash() {
    var h = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
    return ROUTES.indexOf(h) !== -1 ? h : 'home';
}

export function currentRoute() {
    return getRouteFromHash();
}

export function navigate(route) {
    if (ROUTES.indexOf(route) === -1) route = 'home';
    if (getRouteFromHash() === route) {
        applyRoute(); // 既に同じルートでも表示を再同期する（例: 履歴から戻ってきた時）
        return;
    }
    location.hash = '#/' + route;
}

/** ルート変更時に呼ばれるコールバックを登録する。引数はルート名。 */
export function onRoute(fn) {
    if (typeof fn === 'function') listeners.push(fn);
}

function applyRoute() {
    var route = getRouteFromHash();

    document.querySelectorAll('.app-page').forEach(function (page) {
        page.classList.toggle('active', page.id === 'page-' + route);
    });
    document.querySelectorAll('.nav-item').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.route === route);
    });

    listeners.forEach(function (fn) {
        try { fn(route); } catch (e) { console.error('[router] route listener error:', e); }
    });
}

export function initRouter() {
    document.querySelectorAll('.nav-item').forEach(function (btn) {
        btn.onclick = function () { navigate(btn.dataset.route); };
    });
    window.addEventListener('hashchange', applyRoute);
    applyRoute();
}
