// Service Worker for Photo Tagger PWA
// 役割：
//   - PWA インストール可能性の前提条件を満たす
//   - シェル（HTML/CSS/JS）を最低限キャッシュしてオフライン起動を可能にする
//   - Google Photos CDN の画像リクエストを横取りして CORP を回避（v4）
//
// CORP 回避の仕組み：
//   ブラウザの <img> 直接ロードでは Cross-Origin-Resource-Policy: same-site で蹴られるが、
//   SW が同一オリジンとして fetch を仲介すると、SW から見ると相手は別ホストでも、
//   ブラウザから返却するときは「同一オリジンの SW が出力したレスポンス」として扱われる。
//   これによって CORP の制限を実質的に回避できる。

const CACHE_NAME = 'pt-shell-v15';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './privacy.html',
  './manifest.webmanifest',
  './icon-192.svg',
  './icon-512.svg',
];

// Google フォトのサムネイルが配信されるホスト群
const PHOTO_HOST_PATTERN = /^([a-z]+\d?\.)?(googleusercontent\.com|fife\.usercontent\.google\.com)$/i;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1) 自オリジン（PWA）のリソース：ネットワーク優先
  //    オンラインなら常に最新を取得してキャッシュも更新。
  //    ネットワークが使えないときだけキャッシュにフォールバックする。
  //    これにより「古いコードがキャッシュに残り続ける」問題を防ぐ。
  if (url.origin === location.origin) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          return cached || caches.match('./index.html');
        })
    );
    return;
  }

  // 2) Google Photos CDN：CORP を回避するため SW で仲介
  if (PHOTO_HOST_PATTERN.test(url.host)) {
    event.respondWith(handlePhotoFetch(req));
    return;
  }

  // 3) その他のクロスオリジン：そのまま通す
});

async function handlePhotoFetch(request) {
  try {
    // no-cors モードで再 fetch
    // - opaque レスポンスが返るが、<img> 描画には十分
    // - credentials: 'include' で Google にログインしている場合は Cookie が送られる
    //   （PWA 自体のオリジンが Google でなければ送られないが、害はない）
    const upstream = await fetch(request.url, {
      mode: 'no-cors',
      credentials: 'include',
      cache: 'force-cache', // 同じ URL は積極的にキャッシュ
    });
    return upstream;
  } catch (e) {
    // フォールバック：透明 1x1 PNG を返す（壊れた画像アイコンを抑制）
    return new Response(transparentPng(), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    });
  }
}

// 1x1 透明 PNG のバイナリ
function transparentPng() {
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
