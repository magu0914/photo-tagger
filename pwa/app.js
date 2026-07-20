// Photo Tagger Mobile (PWA)
// PC で付けたタグから写真を検索するためのモバイル向けクライアント。
// Google Drive の appDataFolder を読み取り専用で参照し、
// タグごとの写真一覧をサムネイル付きで表示する。

'use strict';

// ---- 設定読み込み -------------------------------------------------------
const CONFIG = (window.PHOTO_TAGGER_CONFIG ?? {});
const CLIENT_ID = CONFIG.GOOGLE_CLIENT_ID;

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const SCOPES = [
  'https://www.googleapis.com/auth/drive.appdata',
  'openid',
  'email',
  'profile',
].join(' ');

// すべて localStorage に保存することで PWA 再起動でも復元できるようにする。
// セキュリティ：
//   - スコープが drive.appdata 限定なので、トークン漏洩しても他データには到達不可
//   - PWA は単一オリジンに閉じ、第三者スクリプトは accounts.google.com のみ
//   - ユーザー入力をコードとして実行する箇所は無く XSS 経路がない
//   トークン期限（1 時間）が短いため、利便性重視で localStorage を採用。
const STORAGE_KEYS = {
  AUTO_SIGNIN: 'pt_auto_signin',     // 自動サインインを試みるフラグ
  LAST_USER: 'pt_last_user',         // 前回サインインしていたメール（hint 用）
  TOKEN: 'pt_token',                 // アクセストークン
  TOKEN_EXPIRY: 'pt_expiry',         // トークン有効期限（ms epoch）
  USER_INFO: 'pt_user_info',         // 取得済みユーザー情報
};

// ---- DOM ヘルパ ---------------------------------------------------------
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.appendChild(c);
  return node;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// ---- 状態管理 -----------------------------------------------------------
const STATES = ['loading', 'signin', 'config-error', 'tags', 'photos', 'error'];
function showState(name) {
  for (const s of STATES) {
    $('#state-' + s).hidden = s !== name;
  }
}

// ---- トースト -----------------------------------------------------------
let _toastTimer = null;
function toast(message, level = 'info', duration = 3000) {
  const t = $('#toast');
  t.className = 'toast' + (level === 'error' ? ' toast--error' : level === 'success' ? ' toast--success' : '');
  t.textContent = message;
  t.hidden = false;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.hidden = true; }, duration);
}

// ---- OAuth (Google Identity Services) ----------------------------------
let _accessToken = null;
let _tokenExpiry = 0;
let _tokenClient = null;
let _userInfo = null; // { sub, email, name, picture }

function safeLocal(op, key, value) {
  try {
    if (op === 'get') return localStorage.getItem(key);
    if (op === 'set') localStorage.setItem(key, value);
    if (op === 'remove') localStorage.removeItem(key);
  } catch (e) { /* ignore quota / privacy mode */ }
  return null;
}
// 互換性のため safeSession の名前を残す（実体は localStorage に統一済み）
const safeSession = safeLocal;

function initTokenClient(callbackOnSuccess) {
  if (!window.google?.accounts?.oauth2) return false;
  if (!CLIENT_ID) return false;
  _tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: async (resp) => {
      if (resp.error) {
        if (resp.error === 'popup_closed_by_user' || resp.error === 'popup_failed_to_open') {
          showState('signin');
          return;
        }
        toast('サインイン失敗: ' + resp.error, 'error');
        showState('signin');
        return;
      }
      _accessToken = resp.access_token;
      _tokenExpiry = Date.now() + (resp.expires_in ?? 3600) * 1000 - 60_000;
      safeSession('set', STORAGE_KEYS.TOKEN, _accessToken);
      safeSession('set', STORAGE_KEYS.TOKEN_EXPIRY, String(_tokenExpiry));
      safeLocal('set', STORAGE_KEYS.AUTO_SIGNIN, '1');
      try {
        const info = await fetchUserInfo();
        if (info?.email) safeLocal('set', STORAGE_KEYS.LAST_USER, info.email);
      } catch (e) { /* userinfo failed, not fatal */ }
      if (callbackOnSuccess) callbackOnSuccess();
    },
  });
  return true;
}

// インタラクティブサインイン（ボタン押下時）
function requestSignInInteractive() {
  if (!_tokenClient) return;
  _tokenClient.requestAccessToken({ prompt: 'consent' });
}

// アカウント切替（2 タップ方式）
//   GIS Token Client は prompt:'select_account' を渡しても、現在のトークンが
//   有効なときはサイレントに同じアカウントのトークンを再発行することがあり、
//   結果として「何も起きない」ように見える。
//   そのため、確実な動作を保証するために：
//     1. このボタンでサインアウト状態にする（revoke + 状態クリア + hint 削除）
//     2. ユーザーに「サインイン」ボタンを再度押してもらう
//     3. 新規認証フローで Google がアカウント選択画面を表示する
//   トーストで次の操作を案内する。
function requestSwitchAccount() {
  if (!_tokenClient) {
    toast('認証ライブラリ未初期化', 'error');
    return;
  }
  // 旧トークンを Google 側で無効化（背景で fire-and-forget）
  if (_accessToken && window.google?.accounts?.oauth2) {
    try { google.accounts.oauth2.revoke(_accessToken, () => {}); } catch (e) { /* ignore */ }
  }
  // ローカル状態をすべてクリア
  _accessToken = null;
  _tokenExpiry = 0;
  _userInfo = null;
  _tags = [];
  _mappings = {};
  _tagCounts = {};
  safeLocal('remove', STORAGE_KEYS.TOKEN);
  safeLocal('remove', STORAGE_KEYS.TOKEN_EXPIRY);
  safeLocal('remove', STORAGE_KEYS.USER_INFO);
  safeLocal('remove', STORAGE_KEYS.AUTO_SIGNIN);
  safeLocal('remove', STORAGE_KEYS.LAST_USER); // hint を削除して次回の picker を確実に出す
  // サインイン画面を表示
  showState('signin');
  $('#signin-btn').hidden = false;
  renderUserMenu(null);
  toast('別のアカウントでサインインしてください', 'info', 5000);
}

// サイレントトークン取得（既同意ユーザー向け）
function trySilentSignIn() {
  if (!_tokenClient) return;
  const lastUser = safeLocal('get', STORAGE_KEYS.LAST_USER);
  const opts = { prompt: '' };
  if (lastUser) opts.hint = lastUser;
  _tokenClient.requestAccessToken(opts);
}

// サインアウト
function signOut() {
  if (_accessToken && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(_accessToken, () => {});
  }
  _accessToken = null;
  _tokenExpiry = 0;
  _userInfo = null;
  safeSession('remove', STORAGE_KEYS.TOKEN);
  safeSession('remove', STORAGE_KEYS.TOKEN_EXPIRY);
  safeSession('remove', STORAGE_KEYS.USER_INFO);
  safeLocal('remove', STORAGE_KEYS.AUTO_SIGNIN);
  // LAST_USER は残す（次回 hint に使うため）
  showState('signin');
  renderUserMenu(null);
  $('#signin-btn').hidden = false;
}

// ---- セッション復元 -----------------------------------------------------
function loadSession() {
  const token = safeSession('get', STORAGE_KEYS.TOKEN);
  const expiry = parseInt(safeSession('get', STORAGE_KEYS.TOKEN_EXPIRY) ?? '0', 10);
  if (token && expiry > Date.now()) {
    _accessToken = token;
    _tokenExpiry = expiry;
    const userJson = safeSession('get', STORAGE_KEYS.USER_INFO);
    if (userJson) try { _userInfo = JSON.parse(userJson); } catch (e) {}
    return true;
  }
  return false;
}

// ---- ユーザー情報取得 ---------------------------------------------------
async function fetchUserInfo() {
  if (_userInfo) return _userInfo;
  const res = await authedFetch('https://www.googleapis.com/oauth2/v3/userinfo');
  if (!res.ok) throw new Error('userinfo failed: ' + res.status);
  const info = await res.json();
  _userInfo = {
    sub: info.sub,
    email: info.email,
    name: info.name,
    picture: info.picture,
  };
  safeSession('set', STORAGE_KEYS.USER_INFO, JSON.stringify(_userInfo));
  return _userInfo;
}

// ---- Drive API ---------------------------------------------------------
async function authedFetch(url, init = {}) {
  if (!_accessToken || Date.now() > _tokenExpiry) {
    return new Promise((resolve, reject) => {
      const lastUser = safeLocal('get', STORAGE_KEYS.LAST_USER);
      const orig = _tokenClient.callback;
      _tokenClient.callback = (resp) => {
        // 通常のコールバックを復元
        _tokenClient.callback = orig;
        if (resp.error) { reject(new Error(resp.error)); return; }
        _accessToken = resp.access_token;
        _tokenExpiry = Date.now() + (resp.expires_in ?? 3600) * 1000 - 60_000;
        safeSession('set', STORAGE_KEYS.TOKEN, _accessToken);
        safeSession('set', STORAGE_KEYS.TOKEN_EXPIRY, String(_tokenExpiry));
        resolve(_doFetch(url, init));
      };
      _tokenClient.requestAccessToken({ prompt: '', hint: lastUser ?? '' });
    });
  }
  return _doFetch(url, init);
}
async function _doFetch(url, init) {
  const headers = { ...(init.headers ?? {}), Authorization: 'Bearer ' + _accessToken };
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    _accessToken = null;
    safeSession('remove', STORAGE_KEYS.TOKEN);
    throw new Error('認証期限切れ。再サインインしてください');
  }
  return res;
}

async function findFileId(name) {
  const q = encodeURIComponent(`name='${name}' and trashed=false`);
  const res = await authedFetch(`${DRIVE_BASE}/files?spaces=appDataFolder&q=${q}&fields=files(id,name)`);
  if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);
  const json = await res.json();
  return json.files?.[0]?.id ?? null;
}
async function readJsonFile(name) {
  const id = await findFileId(name);
  if (!id) return null;
  const res = await authedFetch(`${DRIVE_BASE}/files/${id}?alt=media`);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Drive read failed: ${res.status}`);
  }
  return await res.json();
}

// ---- データ管理 ---------------------------------------------------------
let _tags = [];
let _mappings = {};
let _tagCounts = {};

async function loadIndex() {
  showState('loading');
  const [tagsData, mappingsData] = await Promise.all([
    readJsonFile('tags.json'),
    readJsonFile('mappings.json'),
  ]);
  _tags = tagsData?.tags ?? [];
  _mappings = {};
  for (const [id, entry] of Object.entries(mappingsData?.items ?? {})) {
    _mappings[id] = entry;
  }
  _tagCounts = {};
  for (const t of _tags) _tagCounts[t.id] = 0;
  for (const entry of Object.values(_mappings)) {
    for (const tagId of entry.tagIds ?? []) {
      if (_tagCounts[tagId] !== undefined) _tagCounts[tagId]++;
    }
  }
}

// ---- 画面遷移 ----------------------------------------------------------
async function onSignedIn() {
  $('#signin-btn').hidden = true;
  // ユーザー情報を取得して UI に反映
  try {
    const info = await fetchUserInfo();
    renderUserMenu(info);
  } catch (e) { /* ユーザー情報取得失敗してもタグは表示する */ }
  await refresh();
}

async function refresh() {
  try {
    showState('loading');
    await loadIndex();
    if (_tags.length === 0) {
      renderTagList();
      $('#tag-empty').hidden = false;
    } else {
      $('#tag-empty').hidden = true;
      // 検索ボックスに文字があればその検索結果を、無ければ通常のタグ一覧を表示
      runSearch($('#search')?.value ?? '');
    }
    showState('tags');
  } catch (err) {
    $('#error-message').textContent = err.message ?? String(err);
    showState('error');
  }
}

// ---- ユーザーメニュー描画 -----------------------------------------------
// el ヘルパに依存せず、直接 addEventListener で確実にリスナーを付ける形に書き換え。
function renderUserMenu(info) {
  const slot = $('#user-slot');
  clear(slot);
  if (!info) return;

  // アバターボタン
  const btn = document.createElement('button');
  btn.className = 'user-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'アカウントメニュー');
  btn.setAttribute('aria-haspopup', 'true');
  if (info.picture) {
    const img = document.createElement('img');
    img.className = 'user-avatar';
    img.src = info.picture;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    btn.appendChild(img);
  } else {
    const initial = document.createElement('span');
    initial.className = 'user-avatar user-avatar--initial';
    initial.textContent = (info.email?.[0] ?? '?').toUpperCase();
    btn.appendChild(initial);
  }
  slot.appendChild(btn);

  // ドロップダウンメニュー
  const menu = document.createElement('div');
  menu.className = 'user-menu';
  menu.hidden = true;

  const head = document.createElement('div');
  head.className = 'user-menu__head';
  if (info.name) {
    const nameEl = document.createElement('div');
    nameEl.className = 'user-menu__name';
    nameEl.textContent = info.name;
    head.appendChild(nameEl);
  }
  const emailEl = document.createElement('div');
  emailEl.className = 'user-menu__email';
  emailEl.textContent = info.email ?? '';
  head.appendChild(emailEl);
  menu.appendChild(head);

  // メニュー項目を作成するヘルパ
  function makeItem(text, action, danger = false) {
    const b = document.createElement('button');
    b.className = 'user-menu__item' + (danger ? ' user-menu__item--danger' : '');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = true;
      action();
    });
    return b;
  }

  menu.appendChild(makeItem('🔄 別のアカウントでログイン', requestSwitchAccount));
  menu.appendChild(makeItem('🔃 データを再読込', refresh));
  menu.appendChild(makeItem('サインアウト', signOut, true));
  slot.appendChild(menu);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', () => { menu.hidden = true; });
}

// ---- タグ一覧描画 ------------------------------------------------------
function renderTagList(searchQuery = '') {
  const grid = $('#tag-grid');
  clear(grid);
  // 0 件のタグ（どの写真にも付いていない空タグ）は表示しない
  const filtered = _tags
    .map(t => ({ ...t, count: _tagCounts[t.id] ?? 0 }))
    .filter(t => t.count > 0)
    .filter(t => !searchQuery || t.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));

  for (const t of filtered) {
    const card = el('button', {
      class: 'tag-card', type: 'button',
      onclick: () => showPhotosForTag(t.id),
    });
    card.appendChild(el('div', { class: 'tag-card__name', text: t.name }));
    card.appendChild(el('div', { class: 'tag-card__count', text: `${t.count} 件` }));
    grid.appendChild(card);
  }
  const shownTags = _tags.filter(t => (_tagCounts[t.id] ?? 0) > 0).length;
  $('#tag-meta').textContent = `${shownTags} タグ / ${Object.keys(_mappings).length} 写真`;
}

// ---- 検索（複数タグ AND） ----------------------------------------------
// 検索ボックスにスペース区切りで語を入れると、
// 「各語にマッチするタグをすべて備えた写真」だけを表示する。
let _searchMediaFilter = 'all';

function runSearch(query) {
  const terms = query.trim().split(/[\s　]+/).filter(Boolean); // 半角/全角スペース区切り
  const tagGrid = $('#tag-grid');
  const tagMeta = $('#tag-meta');
  const searchResult = $('#search-result');

  if (terms.length === 0) {
    // 検索なし → 通常のタグ一覧
    searchResult.hidden = true;
    tagGrid.hidden = false;
    tagMeta.hidden = false;
    renderTagList('');
    return;
  }

  // 各語 → その語を名前に含むタグ ID の集合
  const termTagSets = terms.map(term => {
    const lower = term.toLowerCase();
    const ids = _tags.filter(t => t.name.toLowerCase().includes(lower)).map(t => t.id);
    return new Set(ids);
  });

  // 写真が全語を満たすか：各語について、写真のタグのいずれかがその語のタグ集合に含まれる
  let items = Object.entries(_mappings)
    .filter(([_, entry]) => {
      const tagIds = entry.tagIds ?? [];
      return termTagSets.every(set => tagIds.some(id => set.has(id)));
    })
    .map(([id, entry]) => ({ id, ...entry }));

  // メディア種別フィルター
  if (_searchMediaFilter !== 'all') {
    items = items.filter(i => (i.meta?.mediaType ?? 'photo') === _searchMediaFilter);
  }

  items.sort((a, b) => (b.meta?.creationTime ?? '').localeCompare(a.meta?.creationTime ?? ''));

  // 表示切り替え：タグ一覧を隠して検索結果グリッドを出す
  tagGrid.hidden = true;
  tagMeta.hidden = false;
  tagMeta.textContent = `「${terms.join(' + ')}」 の検索結果：${items.length} 件`;
  searchResult.hidden = false;

  const grid = $('#search-grid');
  clear(grid);
  if (items.length === 0) {
    grid.appendChild(el('div', { class: 'empty-msg', text: '条件に合う写真がありません' }));
  } else {
    for (const item of items) grid.appendChild(buildPhotoCell(item));
  }
}

$('#search').addEventListener('input', (e) => {
  runSearch(e.target.value);
});

// 検索結果のメディア種別セグメント
$$('#search-media-seg .media-seg__btn').forEach(btn => {
  btn.addEventListener('click', () => {
    _searchMediaFilter = btn.getAttribute('data-media');
    $$('#search-media-seg .media-seg__btn').forEach(b => b.classList.remove('media-seg__btn--active'));
    btn.classList.add('media-seg__btn--active');
    runSearch($('#search').value);
  });
});

// ---- タグ別写真グリッド ------------------------------------------------
let _currentTagId = null;
let _mediaFilter = 'all'; // 'all' | 'photo' | 'video'

function showPhotosForTag(tagId) {
  const tag = _tags.find(t => t.id === tagId);
  if (!tag) return;
  _currentTagId = tagId;
  $('#photos-title-name').textContent = tag.name;
  renderPhotoGrid();
  showState('photos');
  history.pushState({ view: 'photos', tagId }, '', `#tag/${encodeURIComponent(tag.name)}`);
}

function renderPhotoGrid() {
  const tag = _tags.find(t => t.id === _currentTagId);
  if (!tag) return;
  let items = Object.entries(_mappings)
    .filter(([_, entry]) => entry.tagIds.includes(_currentTagId))
    .map(([id, entry]) => ({ id, ...entry }));

  // メディア種別フィルター（mediaType 未取得のものは photo 扱い）
  if (_mediaFilter !== 'all') {
    items = items.filter(i => (i.meta?.mediaType ?? 'photo') === _mediaFilter);
  }

  items.sort((a, b) => (b.meta?.creationTime ?? '').localeCompare(a.meta?.creationTime ?? ''));

  $('#photos-title-count').textContent = `${items.length} 件`;

  const noDataCount = items.filter(i => !i.meta?.thumbnailData).length;
  const noteEl = $('#photos-note');
  if (noDataCount > 0) {
    noteEl.textContent = `※ ${noDataCount} 件はサムネイル未取得。PC で Google フォトを開いて該当写真の表示エリアまでスクロールすると自動キャッシュされます。`;
    noteEl.hidden = false;
  } else {
    noteEl.hidden = true;
  }

  const grid = $('#photo-grid');
  clear(grid);
  if (items.length === 0) {
    grid.appendChild(el('div', { class: 'empty-msg', text: 'この条件の写真はありません' }));
  } else {
    for (const item of items) grid.appendChild(buildPhotoCell(item));
  }
}

// メディア種別セグメントの配線
$$('#media-seg .media-seg__btn').forEach(btn => {
  btn.addEventListener('click', () => {
    _mediaFilter = btn.getAttribute('data-media');
    $$('#media-seg .media-seg__btn').forEach(b => b.classList.remove('media-seg__btn--active'));
    btn.classList.add('media-seg__btn--active');
    renderPhotoGrid();
  });
});

function buildPhotoCell(item) {
  const cell = el('a', {
    class: 'photo-cell',
    href: `https://photos.google.com/photo/${item.id}`,
    target: '_blank',
    rel: 'noopener',
    'aria-label': '写真を開く',
  });
  let imgSrc = null;
  let isInline = false;
  if (item.meta?.thumbnailData) {
    imgSrc = item.meta.thumbnailData;
    isInline = true;
  } else if (item.meta?.thumbnailUrl) {
    imgSrc = normalizeThumbUrl(item.meta.thumbnailUrl, 320);
  }
  if (imgSrc) {
    const img = el('img', { src: imgSrc, alt: '', loading: 'lazy' });
    if (!isInline) img.setAttribute('referrerpolicy', 'no-referrer');
    img.addEventListener('error', () => {
      const placeholder = el('div', { class: 'photo-cell__placeholder', text: '🖼' });
      if (img.parentNode) img.parentNode.replaceChild(placeholder, img);
      cell.classList.add('photo-cell--no-thumb');
    });
    cell.appendChild(img);
  } else {
    cell.appendChild(el('div', { class: 'photo-cell__placeholder', text: '🖼' }));
    cell.classList.add('photo-cell--no-thumb');
  }
  if (item.meta?.creationTime) {
    cell.appendChild(el('div', {
      class: 'photo-cell__overlay',
      text: item.meta.creationTime.split('T')[0],
    }));
  }
  return cell;
}
function normalizeThumbUrl(url, size = 320) {
  if (!url) return null;
  return url.replace(/=w\d+-h\d+(-no)?/, `=w${size}-h${size}-no`);
}

$('#back-btn').addEventListener('click', () => { history.back(); });
window.addEventListener('popstate', () => { showState('tags'); });

// ---- ボタン配線 ---------------------------------------------------------
$('#signin-btn').addEventListener('click', () => requestSignInInteractive());
$('#signin-btn-large').addEventListener('click', () => requestSignInInteractive());

// ---- 起動 -------------------------------------------------------------
function checkConfig() {
  if (!CLIENT_ID || CLIENT_ID === 'YOUR_CLIENT_ID' || CLIENT_ID.includes('xxx')) {
    showState('config-error');
    return false;
  }
  return true;
}

function startup() {
  if (!checkConfig()) return;

  const waitForGsi = setInterval(() => {
    if (!window.google?.accounts?.oauth2) return;
    clearInterval(waitForGsi);
    if (!initTokenClient(onSignedIn)) {
      showState('config-error');
      return;
    }
    // (1) sessionStorage にトークンが残っていれば即復元
    if (loadSession()) {
      onSignedIn();
      return;
    }
    // (2) 過去にサインイン同意していればサイレント再認証を試行
    const autoSignin = safeLocal('get', STORAGE_KEYS.AUTO_SIGNIN);
    if (autoSignin === '1') {
      // サイレントサインインを試みる。失敗したらサインイン画面を出す。
      // 失敗ケースでは callback で showState('signin') される。
      showState('loading');
      trySilentSignIn();
      // 念のためタイムアウトでフォールバック
      setTimeout(() => {
        if (!_accessToken) showState('signin');
      }, 5000);
      return;
    }
    // (3) 完全に新規ユーザー
    showState('signin');
    $('#signin-btn').hidden = false;
  }, 50);

  setTimeout(() => {
    clearInterval(waitForGsi);
    if (!_tokenClient) {
      $('#error-message').textContent = '認証ライブラリの読み込みに失敗しました。インターネット接続を確認してください。';
      showState('error');
    }
  }, 10_000);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  });
}

// デバッグ用にウィンドウへ公開
window.__photoTagger = {
  switch: () => requestSwitchAccount(),
  signOut: () => signOut(),
  signIn: () => requestSignInInteractive(),
  refresh: () => refresh(),
  state: () => ({
    hasToken: !!_accessToken,
    expiry: _tokenExpiry,
    user: _userInfo,
    tagsCount: _tags.length,
  }),
};

startup();
