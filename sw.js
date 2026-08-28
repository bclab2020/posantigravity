const CACHE_NAME = "athletecore-cache-v4.9.21";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.json",
  "./js/app.js",
  "./js/api.js",
  "./js/biomechanics.js",
  "./js/core/state.js",
  "./js/core/dom.js",
  "./js/core/calibration.js",
  "./js/core/arucoCalibration.js",
  "./js/core/camera.js",
  "./js/core/recorder.js",
  "./js/core/orientation.js",
  "./js/data/localStore.js",
  "./js/data/dataService.js",
  "./js/data/cloudStore.js",
  "./js/ui/controls.js",
  "./js/ui/specialist.js",
  "./js/ui/history.js",
  "./js/ui/dashboard.js",
  "./js/ui/modal.js",
  "./js/ui/auth.js",
  "./js/ui/webglHud.js",
  "./js/ui/router.js",
  "./js/ui/home.js",
  "./js/ui/shootFlow.js",
  "./js/ui/batchReview.js",
  "./icon-192.png",
  "./icon-512.png",
  "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&family=Inter:wght@300;400;600;700&family=Roboto+Mono:wght@300;400;500;700&display=swap"
];

// Install Event
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("Caching application assets...");
      // firebase-config.js はユーザー環境によって有無が変わるため、
      // addAll失敗でインストール全体が失敗しないよう個別にベストエフォート追加する
      return cache.addAll(ASSETS).catch((e) => console.warn("Some assets failed to precache:", e));
    }).then(() => self.skipWaiting())
  );
});

// Activate Event
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log("Removing old cache:", key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event (Network falling back to cache)
// Firebase(Auth/Firestore/Storage)へのクロスオリジンAPI呼び出しは
// キャッシュ対象から除外し、素通しする（誤ったキャッシュ動作を防ぐため）。
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  var requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin && !requestUrl.hostname.endsWith("fonts.googleapis.com") && !requestUrl.hostname.endsWith("fonts.gstatic.com")) {
    return; // 他ドメイン(Firebase/CDN/MediaPipe等)はService Workerが関与しない
  }

  // 重要: index.html/style.cssにはキャッシュバスティング用のバージョン
  // クエリ文字列(?v=)を付けているが、jsフォルダ内のESモジュール群(import文で
  // 読み込まれるファイル)には付けていない。素の fetch(event.request) だと
  // ブラウザ自体のHTTPキャッシュ層で「更新前のファイル」を再利用してしまい、
  // Service Workerが気づかないまま古いJSを配信し続けることがあった
  // （コードは修正済みなのに実機で反映されない、という症状の主因）。
  // { cache: "no-store" } を明示し、常に実ネットワークへ問い合わせて
  // 最新のバイト列を取得するようにする。
  event.respondWith(
    fetch(new Request(event.request, { cache: "no-store" }))
      .then((response) => {
        if (response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          if (event.request.mode === "navigate") {
            return caches.match("./index.html");
          }
        });
      })
  );
});
