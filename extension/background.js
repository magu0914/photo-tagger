// background.js (Service Worker)
// Drive API クライアント + タグ操作 RPC ハブ。
//
// 役割：
//   - chrome.identity による OAuth トークン取得（drive.appdata スコープ）
//   - Drive appDataFolder 内の tags.json / mappings.json 読み書き
//   - メモリ上のキャッシュとデバウンス書き込み
//   - content script からのメッセージを RPC として受信
//
// 注意：Service Worker は idle で停止する。再起動時にキャッシュは破棄されるが、
//       次回呼び出し時に Drive から再ロードされるため動作には影響しない。

'use strict';

// ============================================================================
// Drive API helpers
// ============================================================================

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const APP_DATA = 'appDataFolder';

const FILES = {
  tags: 'tags.json',
  mappings: 'mappings.json',
};

// メモリキャッシュ（fileId, content, modifiedTime）
const cache = {
  tags: null,
  mappings: null,
  fileIds: { tags: null, mappings: null },
};

// ---- 認証 -------------------------------------------------------------------
async function getToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'no token'));
      } else {
        resolve(token);
      }
    });
  });
}

async function authedFetch(url, init = {}) {
  const token = await getToken(false).catch(() => null) ?? await getToken(true);
  const headers = { ...(init.headers ?? {}), Authorization: 'Bearer ' + token };
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    // トークン失効。キャッシュから削除して再取得
    chrome.identity.removeCachedAuthToken({ token });
    const newToken = await getToken(true);
    const retryHeaders = { ...(init.headers ?? {}), Authorization: 'Bearer ' + newToken };
    return fetch(url, { ...init, headers: retryHeaders });
  }
  return res;
}

// ---- ファイル探索 -----------------------------------------------------------
async function findFileId(name) {
  if (cache.fileIds[fileKey(name)]) return cache.fileIds[fileKey(name)];
  const url = `${DRIVE_BASE}/files?spaces=appDataFolder&q=${encodeURIComponent(`name='${name}' and trashed=false`)}&fields=files(id,name,modifiedTime)`;
  const res = await authedFetch(url);
  if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);
  const json = await res.json();
  const id = json.files?.[0]?.id ?? null;
  if (id) cache.fileIds[fileKey(name)] = id;
  return id;
}

function fileKey(name) {
  return name === FILES.tags ? 'tags' : 'mappings';
}

// ---- 読み込み（無ければ空オブジェクト） -------------------------------------
async function readJson(name) {
  const id = await findFileId(name);
  if (!id) return null;
  const res = await authedFetch(`${DRIVE_BASE}/files/${id}?alt=media`);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Drive read failed: ${res.status}`);
  }
  return await res.json();
}

// ---- 書き込み（multipart で metadata + content を一発送信） -----------------
async function writeJson(name, data) {
  const existingId = await findFileId(name);
  const body = JSON.stringify(data);
  const metadata = existingId
    ? { name } // update の場合は parents は不要
    : { name, parents: [APP_DATA], mimeType: 'application/json' };

  const boundary = '-------gpt-' + Math.random().toString(36).slice(2);
  const multipartBody =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    `--${boundary}\r\n` +
    'Content-Type: application/json\r\n\r\n' +
    body + '\r\n' +
    `--${boundary}--`;

  const url = existingId
    ? `${DRIVE_UPLOAD}/files/${existingId}?uploadType=multipart&fields=id,modifiedTime`
    : `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`;

  const res = await authedFetch(url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipartBody,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Drive write failed: ${res.status} ${txt}`);
  }
  const json = await res.json();
  cache.fileIds[fileKey(name)] = json.id;
  return json;
}

// ============================================================================
// データモデル操作
// ============================================================================

function emptyTagsFile() {
  return { version: 1, updatedAt: new Date().toISOString(), tags: [] };
}
function emptyMappingsFile() {
  return { version: 1, updatedAt: new Date().toISOString(), items: {} };
}

function newTagId() {
  return 'tag_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function loadTags() {
  if (cache.tags) return cache.tags;
  const data = await readJson(FILES.tags);
  cache.tags = data ?? emptyTagsFile();
  return cache.tags;
}
async function loadMappings() {
  if (cache.mappings) return cache.mappings;
  const data = await readJson(FILES.mappings);
  cache.mappings = data ?? emptyMappingsFile();
  return cache.mappings;
}

// ---- debounce 書き込み ------------------------------------------------------
const writeTimers = { tags: null, mappings: null };
const writePromises = { tags: null, mappings: null };

function scheduleWrite(which) {
  if (writeTimers[which]) clearTimeout(writeTimers[which]);
  writeTimers[which] = setTimeout(async () => {
    writeTimers[which] = null;
    const data = which === 'tags' ? cache.tags : cache.mappings;
    if (!data) return;
    data.updatedAt = new Date().toISOString();
    try {
      const result = await writeJson(FILES[which], data);
      console.log(`[GPT bg] ${which} saved`, result.modifiedTime);
    } catch (e) {
      console.error(`[GPT bg] ${which} save failed`, e);
    }
  }, 400);
}

// ---- API 関数 ---------------------------------------------------------------
async function listAllTags() {
  const tags = await loadTags();
  return tags.tags;
}

async function createTag(name, color) {
  const tags = await loadTags();
  const trimmed = name.trim();
  if (!trimmed) throw new Error('tag name required');
  // 重複チェック
  const existing = tags.tags.find(t => t.name === trimmed);
  if (existing) return existing;
  const tag = {
    id: newTagId(),
    name: trimmed,
    color: color ?? null,
    createdAt: new Date().toISOString(),
  };
  tags.tags.push(tag);
  scheduleWrite('tags');
  return tag;
}

async function getTagsForPhoto(photoId) {
  const [tags, mappings] = await Promise.all([loadTags(), loadMappings()]);
  const ids = mappings.items[photoId]?.tagIds ?? [];
  const idSet = new Set(ids);
  return tags.tags.filter(t => idSet.has(t.id));
}

async function addTagToPhoto(photoId, tagId, meta) {
  const mappings = await loadMappings();
  let entry = mappings.items[photoId];
  if (!entry) {
    entry = { tagIds: [], updatedAt: new Date().toISOString(), meta: meta ?? null, libraryApiId: null };
    mappings.items[photoId] = entry;
  }
  if (!entry.tagIds.includes(tagId)) {
    entry.tagIds.push(tagId);
    entry.updatedAt = new Date().toISOString();
    if (meta) entry.meta = { ...(entry.meta ?? {}), ...meta };
    scheduleWrite('mappings');
  }
  return entry;
}

async function removeTagFromPhoto(photoId, tagId) {
  const mappings = await loadMappings();
  const entry = mappings.items[photoId];
  if (!entry) return null;
  const before = entry.tagIds.length;
  entry.tagIds = entry.tagIds.filter(id => id !== tagId);
  if (entry.tagIds.length !== before) {
    entry.updatedAt = new Date().toISOString();
    // タグを付けた写真が 1 枚も無くなったら、空タグをマスターからも削除する
    await pruneTagIfEmpty(tagId, mappings);
    scheduleWrite('mappings');
  }
  return entry;
}

// 指定タグを使う写真が 1 枚も無ければ tags.json から削除する
async function pruneTagIfEmpty(tagId, mappings) {
  const stillUsed = Object.values(mappings.items).some(e => e.tagIds.includes(tagId));
  if (stillUsed) return false;
  const tags = await loadTags();
  const before = tags.tags.length;
  tags.tags = tags.tags.filter(t => t.id !== tagId);
  if (tags.tags.length !== before) {
    scheduleWrite('tags');
    return true;
  }
  return false;
}

// 既存の空タグ（どの写真にも付いていないタグ）を一括削除する
async function pruneEmptyTags() {
  const [tags, mappings] = await Promise.all([loadTags(), loadMappings()]);
  const used = new Set();
  for (const entry of Object.values(mappings.items)) {
    for (const id of entry.tagIds) used.add(id);
  }
  const before = tags.tags.length;
  const removed = tags.tags.filter(t => !used.has(t.id)).map(t => t.name);
  tags.tags = tags.tags.filter(t => used.has(t.id));
  if (tags.tags.length !== before) scheduleWrite('tags');
  return { removed, count: removed.length };
}

// タグ管理：リネーム
async function renameTag(tagId, newName) {
  const tags = await loadTags();
  const trimmed = newName.trim();
  if (!trimmed) throw new Error('tag name required');
  const tag = tags.tags.find(t => t.id === tagId);
  if (!tag) throw new Error('tag not found');
  // 既に同名タグがあればエラー（その場合は merge を案内）
  const dup = tags.tags.find(t => t.id !== tagId && t.name === trimmed);
  if (dup) throw new Error(`同名タグ「${trimmed}」が既に存在します。統合機能をご使用ください`);
  tag.name = trimmed;
  scheduleWrite('tags');
  return tag;
}

// タグ管理：削除（mappings からも除去）
async function deleteTag(tagId) {
  const [tags, mappings] = await Promise.all([loadTags(), loadMappings()]);
  const before = tags.tags.length;
  tags.tags = tags.tags.filter(t => t.id !== tagId);
  if (tags.tags.length === before) return { deletedTag: false, affectedPhotos: 0 };
  // mappings からも除去
  let affected = 0;
  for (const [photoId, entry] of Object.entries(mappings.items)) {
    const idx = entry.tagIds.indexOf(tagId);
    if (idx !== -1) {
      entry.tagIds.splice(idx, 1);
      entry.updatedAt = new Date().toISOString();
      affected++;
      if (entry.tagIds.length === 0) delete mappings.items[photoId];
    }
  }
  scheduleWrite('tags');
  if (affected > 0) scheduleWrite('mappings');
  return { deletedTag: true, affectedPhotos: affected };
}

// タグ管理：統合（source の写真群を target に集約 → source は削除）
async function mergeTags(sourceTagId, targetTagId) {
  if (sourceTagId === targetTagId) throw new Error('同じタグ同士は統合できません');
  const [tags, mappings] = await Promise.all([loadTags(), loadMappings()]);
  const source = tags.tags.find(t => t.id === sourceTagId);
  const target = tags.tags.find(t => t.id === targetTagId);
  if (!source) throw new Error('source タグが見つかりません');
  if (!target) throw new Error('target タグが見つかりません');
  let affected = 0;
  for (const entry of Object.values(mappings.items)) {
    const idx = entry.tagIds.indexOf(sourceTagId);
    if (idx !== -1) {
      entry.tagIds.splice(idx, 1);
      if (!entry.tagIds.includes(targetTagId)) entry.tagIds.push(targetTagId);
      entry.updatedAt = new Date().toISOString();
      affected++;
    }
  }
  // source を削除
  tags.tags = tags.tags.filter(t => t.id !== sourceTagId);
  scheduleWrite('tags');
  if (affected > 0) scheduleWrite('mappings');
  return { mergedFrom: source, mergedTo: target, affectedPhotos: affected };
}

// 一括タグ付け：複数写真に同じタグを付与
async function bulkAddTag(photoIdMetaPairs, tagName, color) {
  if (!Array.isArray(photoIdMetaPairs) || photoIdMetaPairs.length === 0) {
    throw new Error('photo list required');
  }
  const tag = await createTag(tagName, color);
  const mappings = await loadMappings();
  let added = 0, alreadyHad = 0;
  for (const { photoId, meta } of photoIdMetaPairs) {
    let entry = mappings.items[photoId];
    if (!entry) {
      entry = { tagIds: [], updatedAt: new Date().toISOString(), meta: meta ?? null, libraryApiId: null };
      mappings.items[photoId] = entry;
    }
    if (entry.tagIds.includes(tag.id)) {
      alreadyHad++;
      continue;
    }
    entry.tagIds.push(tag.id);
    entry.updatedAt = new Date().toISOString();
    if (meta) entry.meta = { ...(entry.meta ?? {}), ...meta };
    added++;
  }
  if (added > 0) scheduleWrite('mappings');
  return { tag, added, alreadyHad, total: photoIdMetaPairs.length };
}

// 写真の meta（撮影日時・サムネイル URL 等）のみを更新する
// バックフィル用途：既存のタグ付け済み写真にサムネイル URL を後から追記
async function updatePhotoMeta(photoId, meta) {
  if (!meta) return null;
  const mappings = await loadMappings();
  const entry = mappings.items[photoId];
  if (!entry) return null; // タグが付いていない写真の meta は更新しない
  const before = JSON.stringify(entry.meta ?? null);
  entry.meta = { ...(entry.meta ?? {}), ...meta };
  const after = JSON.stringify(entry.meta);
  if (before !== after) {
    entry.updatedAt = new Date().toISOString();
    scheduleWrite('mappings');
  }
  return entry;
}

// ============================================================================
// メッセージハブ
// ============================================================================

const handlers = {
  ping: async () => ({ pong: Date.now() }),
  list_all_tags: async () => ({ tags: await listAllTags() }),
  create_tag: async ({ name, color }) => ({ tag: await createTag(name, color) }),
  get_tags_for_photo: async ({ photoId }) => ({ tags: await getTagsForPhoto(photoId) }),
  add_tag_to_photo: async ({ photoId, tagId, meta }) => ({ entry: await addTagToPhoto(photoId, tagId, meta) }),
  remove_tag_from_photo: async ({ photoId, tagId }) => ({ entry: await removeTagFromPhoto(photoId, tagId) }),
  // タグ作成 + 写真への付与をまとめて
  add_new_tag_to_photo: async ({ photoId, name, color, meta }) => {
    const tag = await createTag(name, color);
    const entry = await addTagToPhoto(photoId, tag.id, meta);
    return { tag, entry };
  },
  // 一覧画面で全サムネイルにバッジを付ける + ギャラリー描画のための一括取得
  get_index: async () => {
    const [tags, mappings] = await Promise.all([loadTags(), loadMappings()]);
    return {
      tags: tags.tags,
      // photoId: { tagIds, meta } を返す（サムネイル URL 等を含む）
      mappings: Object.fromEntries(
        Object.entries(mappings.items).map(([id, entry]) => [id, {
          tagIds: entry.tagIds,
          meta: entry.meta ?? null,
        }])
      ),
    };
  },
  // バックフィル：既存写真の meta（サムネイル URL 等）を更新
  update_photo_meta: async ({ photoId, meta }) => ({ entry: await updatePhotoMeta(photoId, meta) }),
  // 複数件まとめて meta 更新（仮想スクロール対応用）
  batch_update_meta: async ({ updates }) => {
    const results = [];
    for (const u of (updates ?? [])) {
      const e = await updatePhotoMeta(u.photoId, u.meta);
      if (e) results.push({ photoId: u.photoId, ok: true });
    }
    return { results, count: results.length };
  },
  // タグ管理画面用
  rename_tag: async ({ tagId, newName }) => ({ tag: await renameTag(tagId, newName) }),
  delete_tag: async ({ tagId }) => await deleteTag(tagId),
  merge_tags: async ({ sourceTagId, targetTagId }) => await mergeTags(sourceTagId, targetTagId),
  // 空タグ（どの写真にも付いていないタグ）を一括削除
  prune_empty_tags: async () => await pruneEmptyTags(),
  // 一括タグ付け（複数選択モード用）
  bulk_add_tag: async ({ items, name, color }) => await bulkAddTag(items, name, color),
  // デバッグ用：キャッシュクリア
  reset_cache: async () => {
    cache.tags = null;
    cache.mappings = null;
    cache.fileIds = { tags: null, mappings: null };
    return { ok: true };
  },
  // デバッグ用：appDataFolder のファイル一覧
  list_app_data_files: async () => {
    const url = `${DRIVE_BASE}/files?spaces=appDataFolder&fields=files(id,name,modifiedTime,size)`;
    const res = await authedFetch(url);
    return await res.json();
  },
  // デバッグ用：名前でファイル削除（OAuth テストで作った test.json 用）
  delete_file_by_name: async ({ name }) => {
    const url = `${DRIVE_BASE}/files?spaces=appDataFolder&q=${encodeURIComponent(`name='${name}' and trashed=false`)}&fields=files(id,name)`;
    const res = await authedFetch(url);
    const json = await res.json();
    const deleted = [];
    for (const f of (json.files ?? [])) {
      const delRes = await authedFetch(`${DRIVE_BASE}/files/${f.id}`, { method: 'DELETE' });
      if (delRes.ok || delRes.status === 204) deleted.push(f);
    }
    return { deleted };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) {
    sendResponse({ error: `unknown message type: ${msg?.type}` });
    return false;
  }
  // 非同期応答
  (async () => {
    try {
      const result = await handler(msg.payload ?? {});
      sendResponse({ ok: true, ...result });
    } catch (e) {
      console.error(`[GPT bg] handler ${msg.type} failed`, e);
      sendResponse({ error: e.message ?? String(e) });
    }
  })();
  return true; // async
});

console.log('[GPT bg] service worker ready');
