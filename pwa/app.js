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
const STATES = ['loading', 'signin', 'config-error', 'tags', 'error'];
function showState(name) {
  for (const s of STATES) {
    const elm = $('#state-' + s);
    if (elm) elm.hidden = s !== name;
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
    if (Object.keys(_mappings).length === 0) {
      $('#main-grid') && clear($('#main-grid'));
      $('#tag-empty').hidden = false;
    } else {
      $('#tag-empty').hidden = true;
      renderMain();
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

// ============================================================================
// メイン画面：全メディア一覧 + 高度な検索 + 一括タグ付け
// ============================================================================

let _mediaFilter = 'all';      // 'all' | 'photo' | 'video' | 'gif'
let _selectMode = false;
const _selectedIds = new Set();

// 互換用（refresh から呼ばれる）
function renderTagList() { renderMain(); }

// ---- 検索クエリの解析 ---------------------------------------------------
// スペース区切りで各語を AND。先頭が「-」の語は除外条件。
function parseQuery(q) {
  const tokens = (q || '').trim().split(/[\s　]+/).filter(Boolean);
  const include = [], exclude = [];
  for (const tok of tokens) {
    if ((tok.startsWith('-') || tok.startsWith('－')) && tok.length > 1) {
      exclude.push(tok.slice(1).toLowerCase());
    } else {
      include.push(tok.toLowerCase());
    }
  }
  return { include, exclude };
}
function tagIdsMatchingTerm(term) {
  return new Set(_tags.filter(t => t.name.toLowerCase().includes(term)).map(t => t.id));
}
function entryMatchesQuery(entry, include, exclude) {
  const tagIds = entry.tagIds ?? [];
  for (const term of include) {
    const set = tagIdsMatchingTerm(term);
    if (!tagIds.some(id => set.has(id))) return false;
  }
  for (const term of exclude) {
    const set = tagIdsMatchingTerm(term);
    if (tagIds.some(id => set.has(id))) return false;
  }
  return true;
}
function mediaOf(entry) { return entry.meta?.mediaType ?? 'photo'; }

// ---- メイン描画 ---------------------------------------------------------
function renderMain() {
  const query = $('#search')?.value ?? '';
  const { include, exclude } = parseQuery(query);

  let items = Object.entries(_mappings)
    .map(([id, entry]) => ({ id, ...entry }))
    .filter(item => (_mediaFilter === 'all' || mediaOf(item) === _mediaFilter))
    .filter(item => entryMatchesQuery(item, include, exclude));

  items.sort((a, b) => (b.meta?.creationTime ?? '').localeCompare(a.meta?.creationTime ?? ''));

  // メタ表示
  const meta = $('#tag-meta');
  const total = Object.keys(_mappings).length;
  if (include.length === 0 && exclude.length === 0 && _mediaFilter === 'all') {
    meta.textContent = `全 ${total} 件`;
  } else {
    const parts = [];
    if (include.length) parts.push(include.join(' + '));
    if (exclude.length) parts.push(exclude.map(e => '除外:' + e).join(' '));
    if (_mediaFilter !== 'all') parts.push({ photo: '画像', video: '動画', gif: 'GIF' }[_mediaFilter]);
    meta.textContent = `${parts.join(' / ')} → ${items.length} 件`;
  }

  const grid = $('#main-grid');
  clear(grid);
  if (items.length === 0) {
    grid.appendChild(el('div', { class: 'empty-msg', text: '条件に合うものがありません' }));
  } else {
    for (const item of items) grid.appendChild(buildPhotoCell(item));
  }
  updateBulkBar();
}

// 検索は runSearch 名でも呼べるように（refresh 互換）
function runSearch() { renderMain(); }

$('#search').addEventListener('input', renderMain);

// ---- メディア種別セグメント ---------------------------------------------
$$('#main-media-seg .media-seg__btn').forEach(btn => {
  btn.addEventListener('click', () => {
    _mediaFilter = btn.getAttribute('data-media');
    $$('#main-media-seg .media-seg__btn').forEach(b => b.classList.remove('media-seg__btn--active'));
    btn.classList.add('media-seg__btn--active');
    renderMain();
  });
});

// ---- タグ選択メニュー ---------------------------------------------------
function openTagPicker() {
  $('#tag-picker').hidden = false;
  $('#tag-picker-search').value = '';
  renderTagPickerList('');
  setTimeout(() => $('#tag-picker-search').focus(), 50);
}
function closeTagPicker() { $('#tag-picker').hidden = true; }

function renderTagPickerList(filter) {
  const list = $('#tag-picker-list');
  clear(list);
  const f = (filter || '').toLowerCase();
  const tags = _tags
    .map(t => ({ ...t, count: _tagCounts[t.id] ?? 0 }))
    .filter(t => t.count > 0)
    .filter(t => !f || t.name.toLowerCase().includes(f))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
  if (tags.length === 0) {
    list.appendChild(el('div', { class: 'tag-picker__empty', text: 'タグがありません' }));
    return;
  }
  const addTerm = (prefix, name) => {
    const cur = $('#search').value.trim();
    $('#search').value = (cur ? cur + ' ' : '') + prefix + name;
    closeTagPicker();
    renderMain();
  };
  for (const t of tags) {
    const row = el('div', { class: 'tag-picker__item' });
    // 名前部分（タップで検索に追加）
    const nameBtn = el('button', { class: 'tag-picker__name-btn', type: 'button' });
    nameBtn.appendChild(el('span', { class: 'tag-picker__name', text: t.name }));
    nameBtn.appendChild(el('span', { class: 'tag-picker__count', text: `${t.count}` }));
    nameBtn.addEventListener('click', () => addTerm('', t.name));
    row.appendChild(nameBtn);
    // 除外ボタン
    const exBtn = el('button', {
      class: 'tag-picker__exclude', type: 'button',
      title: 'このタグを含まないものを検索', text: '除外',
    });
    exBtn.addEventListener('click', () => addTerm('-', t.name));
    row.appendChild(exBtn);
    list.appendChild(row);
  }
}
$('#open-tag-picker').addEventListener('click', openTagPicker);
$('#tag-picker-close').addEventListener('click', closeTagPicker);
$('#tag-picker').addEventListener('click', (e) => { if (e.target === $('#tag-picker')) closeTagPicker(); });
$('#tag-picker-search').addEventListener('input', (e) => renderTagPickerList(e.target.value));

// ---- 一括選択モード -----------------------------------------------------
function toggleSelectMode() {
  _selectMode = !_selectMode;
  _selectedIds.clear();
  $('#toggle-select').textContent = _selectMode ? '選択解除' : '選択';
  $('#toggle-select').classList.toggle('ctrl-btn--active', _selectMode);
  renderMain();
}
function toggleSelectItem(id) {
  if (_selectedIds.has(id)) _selectedIds.delete(id);
  else _selectedIds.add(id);
  updateBulkBar();
  // セルの見た目更新
  const cell = document.querySelector(`.photo-cell[data-id="${id}"]`);
  if (cell) cell.classList.toggle('photo-cell--selected', _selectedIds.has(id));
}
function updateBulkBar() {
  const bar = $('#bulk-bar');
  if (_selectMode) {
    bar.hidden = false;
    $('#bulk-count').textContent = `${_selectedIds.size} 件選択`;
  } else {
    bar.hidden = true;
  }
}
$('#toggle-select').addEventListener('click', toggleSelectMode);
$('#bulk-cancel').addEventListener('click', () => { if (_selectMode) toggleSelectMode(); });
$('#bulk-form').addEventListener('submit', (e) => {
  e.preventDefault();
  // カンマ区切りで複数タグ対応（スペースは名前の一部）
  const names = $('#bulk-input').value.split(/[,、]+/).map(s => s.trim()).filter(Boolean);
  if (names.length === 0 || _selectedIds.size === 0) return;
  const ids = Array.from(_selectedIds);
  // 即座にローカル反映
  for (const id of ids) addTagsLocal(id, names);
  const count = ids.length;
  $('#bulk-input').value = '';
  toast(`${count} 件に ${names.length} 個のタグを付けました`, 'success');
  _selectedIds.clear();
  renderMain();
  // 保存は裏で
  persistChanges().catch(err => toast('保存に失敗しました: ' + err.message, 'error'));
});

// ---- 写真セル -----------------------------------------------------------
function buildPhotoCell(item) {
  const cell = el('button', {
    class: 'photo-cell', type: 'button', 'aria-label': 'タグを編集',
    'data-id': item.id,
    onclick: () => {
      if (_selectMode) toggleSelectItem(item.id);
      else openPhotoEditor(item);
    },
  });
  if (_selectMode && _selectedIds.has(item.id)) cell.classList.add('photo-cell--selected');

  let imgSrc = null, isInline = false;
  if (item.meta?.thumbnailData) { imgSrc = item.meta.thumbnailData; isInline = true; }
  else if (item.meta?.thumbnailUrl) { imgSrc = normalizeThumbUrl(item.meta.thumbnailUrl, 320); }

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
  // 動画/GIF バッジ
  const mt = mediaOf(item);
  if (mt === 'video' || mt === 'gif') {
    cell.appendChild(el('div', { class: 'photo-cell__type', text: mt === 'gif' ? 'GIF' : '▶' }));
  }
  if (item.meta?.creationTime) {
    cell.appendChild(el('div', { class: 'photo-cell__overlay', text: item.meta.creationTime.split('T')[0] }));
  }
  // 選択チェック
  cell.appendChild(el('div', { class: 'photo-cell__check', text: '✓' }));
  return cell;
}
function normalizeThumbUrl(url, size = 320) {
  if (!url) return null;
  return url.replace(/=w\d+-h\d+(-no)?/, `=w${size}-h${size}-no`);
}

// Android のときは Google フォトの純正アプリで開きやすくする intent URL を返す。
// intent の failback で通常の https URL に戻せるため、アプリ未インストールでも壊れない。
// PC・iPhone などでは通常の https URL を返す。
function isAndroid() {
  return /android/i.test(navigator.userAgent);
}
function googlePhotosUrl(photoId) {
  const web = `https://photos.google.com/photo/${photoId}`;
  if (!isAndroid()) return web;
  // intent スキーム：まず com.google.android.apps.photos で開こうとする。
  // 失敗時（アプリ未インストール等）は S.browser_fallback_url で web に戻る。
  const fallback = encodeURIComponent(web);
  return `intent://photos.google.com/photo/${photoId}#Intent;scheme=https;package=com.google.android.apps.photos;S.browser_fallback_url=${fallback};end`;
}

// ============================================================================
// タグ編集（既存写真へのタグ追加・削除）
// ============================================================================

// ---- Drive 書き込み -----------------------------------------------------
async function writeJsonFile(name, data) {
  const id = await findFileId(name);
  const body = JSON.stringify(data);
  if (id) {
    const res = await authedFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }
    );
    if (!res.ok) throw new Error(`保存に失敗しました (${res.status})`);
    return await res.json();
  }
  // 新規作成（appDataFolder にファイルを作る）
  const boundary = '----pt' + Math.random().toString(36).slice(2);
  const metadata = { name, parents: ['appDataFolder'], mimeType: 'application/json' };
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
    body + `\r\n--${boundary}--`;
  const res = await authedFetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart }
  );
  if (!res.ok) throw new Error(`作成に失敗しました (${res.status})`);
  return await res.json();
}

function newTagId() {
  return 'tag_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function recomputeCounts() {
  _tagCounts = {};
  for (const t of _tags) _tagCounts[t.id] = 0;
  for (const entry of Object.values(_mappings)) {
    for (const id of (entry.tagIds ?? [])) {
      if (_tagCounts[id] !== undefined) _tagCounts[id]++;
    }
  }
}

let _tagsDirty = false;
async function persistChanges() {
  const jobs = [
    writeJsonFile('mappings.json', {
      version: 1, updatedAt: new Date().toISOString(), items: _mappings,
    }),
  ];
  if (_tagsDirty) {
    jobs.push(writeJsonFile('tags.json', {
      version: 1, updatedAt: new Date().toISOString(), tags: _tags,
    }));
  }
  await Promise.all(jobs);
  _tagsDirty = false;
}

// 写真に既存 or 新規のタグを付ける
async function addTagToPhotoPWA(photoId, tagName) {
  const trimmed = tagName.trim();
  if (!trimmed) return null;
  let tag = _tags.find(t => t.name === trimmed);
  if (!tag) {
    tag = { id: newTagId(), name: trimmed, color: null, createdAt: new Date().toISOString() };
    _tags.push(tag);
    _tagsDirty = true;
  }
  const entry = _mappings[photoId];
  if (!entry) throw new Error('この写真の情報が見つかりません');
  if (!entry.tagIds.includes(tag.id)) {
    entry.tagIds.push(tag.id);
    entry.updatedAt = new Date().toISOString();
  }
  recomputeCounts();
  await persistChanges();
  return tag;
}

// 複数写真に同じタグを一括付与（保存は 1 回だけ）
async function bulkAddTagPWA(photoIds, tagName) {
  const trimmed = tagName.trim();
  if (!trimmed || photoIds.length === 0) return;
  let tag = _tags.find(t => t.name === trimmed);
  if (!tag) {
    tag = { id: newTagId(), name: trimmed, color: null, createdAt: new Date().toISOString() };
    _tags.push(tag);
    _tagsDirty = true;
  }
  for (const photoId of photoIds) {
    const entry = _mappings[photoId];
    if (!entry) continue;
    if (!entry.tagIds.includes(tag.id)) {
      entry.tagIds.push(tag.id);
      entry.updatedAt = new Date().toISOString();
    }
  }
  recomputeCounts();
  await persistChanges();
  return tag;
}

// 写真からタグを外す（空になったタグは自動削除）
async function removeTagFromPhotoPWA(photoId, tagId) {
  const entry = _mappings[photoId];
  if (!entry) return;
  entry.tagIds = entry.tagIds.filter(id => id !== tagId);
  entry.updatedAt = new Date().toISOString();
  if (entry.tagIds.length === 0) delete _mappings[photoId];
  const stillUsed = Object.values(_mappings).some(e => e.tagIds.includes(tagId));
  if (!stillUsed) {
    _tags = _tags.filter(t => t.id !== tagId);
    _tagsDirty = true;
  }
  recomputeCounts();
  await persistChanges();
}

// ---- 編集モーダル -------------------------------------------------------
let _editorPhotoId = null;

function openPhotoEditor(item) {
  _editorPhotoId = item.id;
  const modal = $('#editor');

  // サムネイル
  const thumbWrap = $('#editor-thumb');
  clear(thumbWrap);
  const src = item.meta?.thumbnailData
    ? item.meta.thumbnailData
    : (item.meta?.thumbnailUrl ? normalizeThumbUrl(item.meta.thumbnailUrl, 320) : null);
  if (src) {
    const img = el('img', { src, alt: '' });
    if (!item.meta?.thumbnailData) img.setAttribute('referrerpolicy', 'no-referrer');
    thumbWrap.appendChild(img);
  } else {
    thumbWrap.appendChild(el('div', { class: 'photo-cell__placeholder', text: '🖼' }));
  }

  // Google フォトで開くリンク
  $('#editor-open').setAttribute('href', googlePhotosUrl(item.id));

  renderEditorTags();
  $('#editor-input').value = '';
  modal.hidden = false;
}

function renderEditorTags() {
  const entry = _mappings[_editorPhotoId];
  const tagIds = entry?.tagIds ?? [];
  const wrap = $('#editor-tags');
  clear(wrap);
  if (tagIds.length === 0) {
    wrap.appendChild(el('span', { class: 'editor-tags__empty', text: 'タグなし' }));
    return;
  }
  for (const tid of tagIds) {
    const tag = _tags.find(t => t.id === tid);
    if (!tag) continue;
    const chip = el('span', { class: 'editor-chip' });
    chip.appendChild(el('span', { text: tag.name }));
    const rm = el('button', { class: 'editor-chip__remove', type: 'button', 'aria-label': `${tag.name} を外す`, text: '×' });
    rm.addEventListener('click', () => {
      // 即座に画面から外し、保存は裏で
      removeTagLocal(_editorPhotoId, tag.id);
      renderEditorTags();
      persistChanges().catch(err => toast('保存に失敗しました: ' + err.message, 'error'));
    });
    chip.appendChild(rm);
    wrap.appendChild(chip);
  }
}

// ---- ローカル即時更新（保存は別途 persistChanges で裏実行）----
function addTagsLocal(photoId, names) {
  const entry = _mappings[photoId];
  if (!entry) return [];
  const added = [];
  for (const raw of names) {
    const name = (raw || '').trim();
    if (!name) continue;
    let tag = _tags.find(t => t.name === name);
    if (!tag) {
      tag = { id: newTagId(), name, color: null, createdAt: new Date().toISOString() };
      _tags.push(tag);
      _tagsDirty = true;
    }
    if (!entry.tagIds.includes(tag.id)) entry.tagIds.push(tag.id);
    added.push(tag);
  }
  entry.updatedAt = new Date().toISOString();
  recomputeCounts();
  return added;
}
function removeTagLocal(photoId, tagId) {
  const entry = _mappings[photoId];
  if (!entry) return;
  entry.tagIds = entry.tagIds.filter(id => id !== tagId);
  entry.updatedAt = new Date().toISOString();
  if (entry.tagIds.length === 0) delete _mappings[photoId];
  const stillUsed = Object.values(_mappings).some(e => e.tagIds.includes(tagId));
  if (!stillUsed) { _tags = _tags.filter(t => t.id !== tagId); _tagsDirty = true; }
  recomputeCounts();
}

function closeEditor() {
  $('#editor').hidden = true;
  _editorPhotoId = null;
  // メイン一覧を最新の状態に更新
  renderMain();
}

// 編集モーダルの配線
$('#editor-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#editor-input');
  // カンマ（半角 , / 全角 、）だけで分割。スペースはタグ名の一部として残す。
  const names = input.value.split(/[,、]+/).map(s => s.trim()).filter(Boolean);
  if (names.length === 0 || !_editorPhotoId) return;
  // 即座に反映（保存は裏で）
  addTagsLocal(_editorPhotoId, names);
  input.value = '';
  input.focus();
  renderEditorTags();
  persistChanges().catch(err => toast('保存に失敗しました: ' + err.message, 'error'));
});
$('#editor-close').addEventListener('click', closeEditor);
$('#editor').addEventListener('click', (e) => {
  if (e.target === $('#editor')) closeEditor(); // 背景タップで閉じる
});

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
