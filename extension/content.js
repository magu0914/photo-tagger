// content.js
// Google フォト Web に注入される本体スクリプト。
//
// 提供 UI:
//   - 写真詳細画面：タグの追加・削除チップス
//   - 一覧画面：各サムネイルへのタグバッジ
//   - 一覧画面：タグでのフィルター（OR 条件、複数選択可）
//   - フィルター結果を全画面ギャラリーで表示
//   - 複数選択モード時：画面下部に一括タグ付けバー
//
// 設計上の制約：
//   - Google フォトは Trusted Types CSP を有効化しており、innerHTML 文字列代入は禁止
//   - 写真ID は URL から抽出した 44 文字（AF1Qip + 38 文字）を主キーとする
//   - _mappings[photoId] = { tagIds: [...], meta: { creationTime, orientation, thumbnailUrl, thumbnailData } }

(() => {
  'use strict';

  const PHOTO_ID_REGEX = /\/photo\/(AF1Qip[A-Za-z0-9_-]{38})(?:\/|$|\?)/;
  const OVERLAY_ID = 'gpt-overlay';
  const GALLERY_ID = 'gpt-gallery';
  const PROCESSED_MARKER = 'gpt-thumb-done';
  const DIMMED_CLASS = 'gpt-thumb-dimmed';

  // ---- DOM ヘルパ ---------------------------------------------------------
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

  function extractIdFromAnchor(a) {
    const href = a.href || a.getAttribute('href') || '';
    return href.match(PHOTO_ID_REGEX)?.[1] ?? null;
  }
  function extractCurrentPhotoId() {
    return location.pathname.match(PHOTO_ID_REGEX)?.[1] ?? null;
  }

  // サムネイル URL を一定サイズに正規化
  function normalizeThumbnailUrl(url, size = 240) {
    if (!url) return null;
    return url.replace(/=w\d+-h\d+(-no)?/, `=w${size}-h${size}-no`);
  }

  // ---- service worker と通信 ---------------------------------------------
  function rpc(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  // ---- ローカルキャッシュ -------------------------------------------------
  // _mappings[photoId] = { tagIds: [], meta: { creationTime, orientation, thumbnailUrl } }
  let _mappings = null;
  let _tagsIndex = null; // { tagId: tag }
  let _indexLoading = null;

  const _activeFilters = new Set(); // tagId のセット
  let _filterMode = 'and';           // 'and' = すべてのタグを含む / 'or' = いずれかを含む
  let _mediaFilter = 'all';          // 'all' | 'photo' | 'video'

  // DOM のアンカーから写真 / 動画 / GIF を判定する。
  //   GIF：aria-label や中のテキストに「GIF」「アニメーション」を含む（ベストエフォート）
  //   動画：aria-label に「動画」、または再生時間バッジ（分:秒）を持つ
  //   それ以外：写真
  function anchorMediaType(anchor) {
    const aria = anchor.getAttribute('aria-label') || '';
    const text = anchor.textContent || '';
    const blob = aria + ' ' + text;
    if (/gif|アニメーション/i.test(blob)) return 'gif';
    if (aria.includes('動画') || /\d+:\d{2}/.test(text)) return 'video';
    return 'photo';
  }

  // フィルターが 1 つでも有効か
  function isFilterActive() {
    return _activeFilters.size > 0 || _mediaFilter !== 'all';
  }

  // mappings のエントリがフィルター条件に一致するか（ギャラリー・件数用）
  function entryMatchesFilter(entry) {
    if (!entry) return false;
    if (_mediaFilter !== 'all') {
      const mt = entry.meta?.mediaType ?? 'photo';
      if (mt !== _mediaFilter) return false;
    }
    if (_activeFilters.size > 0) {
      const tagIds = entry.tagIds ?? [];
      if (_filterMode === 'and') {
        for (const f of _activeFilters) if (!tagIds.includes(f)) return false;
      } else {
        if (!tagIds.some(f => _activeFilters.has(f))) return false;
      }
    }
    return true;
  }

  async function ensureIndex() {
    if (_mappings && _tagsIndex) return;
    if (_indexLoading) return _indexLoading;
    _indexLoading = (async () => {
      try {
        const res = await rpc('get_index');
        // res.mappings は { photoId: { tagIds, meta } } 形式
        _mappings = {};
        for (const [id, entry] of Object.entries(res.mappings ?? {})) {
          _mappings[id] = {
            tagIds: entry.tagIds ?? [],
            meta: entry.meta ?? null,
          };
        }
        _tagsIndex = Object.fromEntries((res.tags ?? []).map(t => [t.id, t]));
      } finally {
        _indexLoading = null;
      }
    })();
    return _indexLoading;
  }

  function getEntry(photoId) {
    return _mappings?.[photoId] ?? null;
  }
  function getTagIdsLocal(photoId) {
    return getEntry(photoId)?.tagIds ?? [];
  }
  function getTagsForPhotoLocal(photoId) {
    if (!_mappings || !_tagsIndex) return null;
    const ids = getTagIdsLocal(photoId);
    if (ids.length === 0) return [];
    return ids.map(id => _tagsIndex[id]).filter(Boolean);
  }
  function getMetaLocal(photoId) {
    return getEntry(photoId)?.meta ?? null;
  }
  function countPhotosWithTag(tagId) {
    if (!_mappings) return 0;
    let n = 0;
    for (const entry of Object.values(_mappings)) {
      if (entry.tagIds.includes(tagId)) n++;
    }
    return n;
  }

  function applyLocalAdd(photoId, tag, meta) {
    if (!_mappings) return;
    if (_tagsIndex) _tagsIndex[tag.id] = tag;
    if (!_mappings[photoId]) _mappings[photoId] = { tagIds: [], meta: null };
    if (!_mappings[photoId].tagIds.includes(tag.id)) _mappings[photoId].tagIds.push(tag.id);
    if (meta) _mappings[photoId].meta = { ...(_mappings[photoId].meta ?? {}), ...meta };
  }
  function applyLocalRemove(photoId, tagId) {
    if (!_mappings) return;
    const entry = _mappings[photoId];
    if (!entry) return;
    entry.tagIds = entry.tagIds.filter(id => id !== tagId);
    if (entry.tagIds.length === 0) delete _mappings[photoId];
    // このタグを使う写真が 1 枚も無くなったら、ローカルのタグ一覧からも外す
    const stillUsed = Object.values(_mappings).some(e => e.tagIds.includes(tagId));
    if (!stillUsed && _tagsIndex) {
      delete _tagsIndex[tagId];
      _activeFilters.delete(tagId);
    }
  }
  function applyLocalMeta(photoId, meta) {
    if (!_mappings || !_mappings[photoId] || !meta) return;
    _mappings[photoId].meta = { ...(_mappings[photoId].meta ?? {}), ...meta };
  }

  // ---- サムネイルメタ取得（DOM から） -----------------------------------
  function metaForPhoto(photoId) {
    const a = document.querySelector(`a[href*="/photo/${photoId}"]`);
    if (!a) return null;
    return extractMetaFromAnchor(a);
  }
  function extractMetaFromAnchor(a) {
    const aria = a.getAttribute('aria-label') ?? '';
    const tsMatch = aria.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
    const orientation =
      aria.includes('縦向き') ? 'portrait'
      : aria.includes('横向き') ? 'landscape'
      : aria.includes('動画') ? 'video' : 'unknown';
    // 写真 / 動画の自動判定（フィルター用）
    const mediaType = anchorMediaType(a);
    const thumbDiv = a.querySelector('div[data-latest-bg]');
    const thumbnailUrl = thumbDiv?.getAttribute('data-latest-bg') ?? null;
    return {
      creationTime: tsMatch
        ? `${tsMatch[1]}-${tsMatch[2].padStart(2,'0')}-${tsMatch[3].padStart(2,'0')}T${tsMatch[4].padStart(2,'0')}:${tsMatch[5]}:${tsMatch[6]}`
        : null,
      orientation,
      mediaType,
      thumbnailUrl,
    };
  }

  // ---- バックフィル：既存タグ済み写真にサムネイル URL / データを補充 -------
  let _backfillTimer = null;
  const _backfillPending = new Map(); // photoId → meta（送信予定）
  const _thumbDataInFlight = new Set(); // 重複 fetch 防止
  function scheduleBackfill() {
    if (_backfillTimer) return;
    _backfillTimer = setTimeout(async () => {
      _backfillTimer = null;
      if (_backfillPending.size === 0) return;
      const updates = Array.from(_backfillPending.entries()).map(([photoId, meta]) => ({ photoId, meta }));
      _backfillPending.clear();
      try {
        await rpc('batch_update_meta', { updates });
      } catch (err) {
        console.warn('[GPT content] backfill failed', err);
      }
    }, 1500); // 1.5s 集約してまとめて送信
  }
  function queueBackfillMeta(photoId, meta) {
    const existing = _backfillPending.get(photoId) ?? {};
    _backfillPending.set(photoId, { ...existing, ...meta });
    scheduleBackfill();
  }
  function maybeBackfill(anchor) {
    if (!_mappings) return;
    const id = extractIdFromAnchor(anchor);
    if (!id) return;
    const entry = _mappings[id];
    if (!entry || entry.tagIds.length === 0) return;

    // (1) サムネイル URL または mediaType が無ければ DOM から取得
    if (!entry.meta?.thumbnailUrl || !entry.meta?.mediaType) {
      const meta = extractMetaFromAnchor(anchor);
      // 送信は変化があった分だけ。mediaType は必ず入るので更新対象になる
      const patch = {};
      if (meta.mediaType && entry.meta?.mediaType !== meta.mediaType) patch.mediaType = meta.mediaType;
      if (meta.thumbnailUrl && !entry.meta?.thumbnailUrl) patch.thumbnailUrl = meta.thumbnailUrl;
      if (meta.creationTime && !entry.meta?.creationTime) patch.creationTime = meta.creationTime;
      if (meta.orientation && !entry.meta?.orientation) patch.orientation = meta.orientation;
      if (Object.keys(patch).length > 0) {
        applyLocalMeta(id, patch);
        queueBackfillMeta(id, patch);
      }
    }

    // (2) サムネイル URL はあるが thumbnailData (base64) が無ければ取得
    if (entry.meta?.thumbnailUrl && !entry.meta?.thumbnailData) {
      maybeBackfillThumbData(id, entry.meta.thumbnailUrl);
    }
  }

  // ---- サムネイルを base64 で取得（PWA 用に mappings に埋め込む） -----------
  // photos.google.com 上で動く content script なので credentials: 'include' で
  // 同サイトの photos.fife.usercontent.google.com から認証付き fetch ができる
  async function fetchThumbnailAsBase64(thumbUrl, size = 96) {
    if (!thumbUrl) return null;
    // Google のサムネ URL のサイズ指定は「=w165-h220-no」「=s512」など複数形式がある。
    // どちらの形式でも指定サイズに正規化して原寸取得を防ぐ。
    let url;
    if (/=w\d+-h\d+/.test(thumbUrl)) {
      url = thumbUrl.replace(/=w\d+-h\d+(-[a-z]+)?/, `=w${size}-h${size}-c`);
    } else if (/=s\d+/.test(thumbUrl)) {
      url = thumbUrl.replace(/=s\d+(-[a-z]+)?/, `=s${size}-c`);
    } else {
      // サイズ指定が見当たらない場合は末尾に付与
      url = thumbUrl + `=s${size}-c`;
    }
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) {
        console.warn('[GPT content] thumb fetch failed', res.status);
        return null;
      }
      const blob = await res.blob();
      // 念のための上限（96px なら通常 5KB 前後。異常に大きいものだけ弾く）
      if (blob.size > 120_000) {
        console.warn('[GPT content] thumb too large', blob.size);
        return null;
      }
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result); // "data:image/jpeg;base64,..."
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    } catch (err) {
      console.warn('[GPT content] thumb fetch error', err);
      return null;
    }
  }

  // 並列度を抑えて thumbnailData を取得（一度に多すぎると Drive 書き込みが膨らむ）
  const MAX_CONCURRENT_THUMB_FETCH = 3;
  let _activeThumbFetches = 0;
  const _thumbFetchQueue = [];

  function maybeBackfillThumbData(photoId, thumbUrl) {
    if (_thumbDataInFlight.has(photoId)) return;
    _thumbDataInFlight.add(photoId);
    _thumbFetchQueue.push({ photoId, thumbUrl });
    drainThumbQueue();
  }
  async function drainThumbQueue() {
    while (_activeThumbFetches < MAX_CONCURRENT_THUMB_FETCH && _thumbFetchQueue.length > 0) {
      const { photoId, thumbUrl } = _thumbFetchQueue.shift();
      _activeThumbFetches++;
      (async () => {
        try {
          const data = await fetchThumbnailAsBase64(thumbUrl, 96);
          if (data) {
            applyLocalMeta(photoId, { thumbnailData: data });
            queueBackfillMeta(photoId, { thumbnailData: data });
          }
        } finally {
          _thumbDataInFlight.delete(photoId);
          _activeThumbFetches--;
          drainThumbQueue();
        }
      })();
    }
  }

  // ---- サムネイルバッジ ---------------------------------------------------
  function buildThumbBadge(tags) {
    const badge = el('div', { class: 'gpt-thumb-badge', 'aria-label': `タグ ${tags.length} 件` });
    badge.appendChild(el('span', { class: 'gpt-thumb-badge__icon', text: '🏷' }));
    const label = tags.length === 1 ? tags[0].name : `${tags[0].name} +${tags.length - 1}`;
    badge.appendChild(el('span', { class: 'gpt-thumb-badge__text', text: label }));
    return badge;
  }
  function injectBadge(anchor) {
    if (anchor.classList.contains(PROCESSED_MARKER)) return;
    const photoId = extractIdFromAnchor(anchor);
    if (!photoId) return;
    anchor.classList.add(PROCESSED_MARKER);
    // バックフィル機会
    maybeBackfill(anchor);
    const tags = getTagsForPhotoLocal(photoId);
    if (!tags || tags.length === 0) return;
    const cs = window.getComputedStyle(anchor);
    if (cs.position === 'static') anchor.style.setProperty('position', 'relative');
    anchor.appendChild(buildThumbBadge(tags));
  }
  function processVisibleThumbnails() {
    if (!_mappings) return;
    document.querySelectorAll(`a[href*="/photo/AF1Qip"]:not(.${PROCESSED_MARKER})`)
      .forEach(injectBadge);
    applyFilterToAll();
  }
  function clearAllBadges() {
    document.querySelectorAll('.gpt-thumb-badge').forEach(b => b.remove());
    document.querySelectorAll(`.${PROCESSED_MARKER}`).forEach(a => a.classList.remove(PROCESSED_MARKER));
  }
  function refreshBadgeFor(photoId) {
    document.querySelectorAll(`a[href*="/photo/${photoId}"]`).forEach(a => {
      a.querySelector('.gpt-thumb-badge')?.remove();
      a.classList.remove(PROCESSED_MARKER);
      injectBadge(a);
    });
  }

  // ---- フィルター適用 -----------------------------------------------------
  function applyFilterToAll() {
    const anchors = document.querySelectorAll('a[href*="/photo/AF1Qip"]');
    if (!isFilterActive()) {
      anchors.forEach(a => a.classList.remove(DIMMED_CLASS));
      return;
    }
    anchors.forEach(a => {
      const id = extractIdFromAnchor(a);
      if (!id) return;
      let ok = true;
      // メディア種別フィルター（DOM から直接判定できるので未タグ写真にも効く）
      if (_mediaFilter !== 'all' && anchorMediaType(a) !== _mediaFilter) ok = false;
      // タグフィルター
      if (ok && _activeFilters.size > 0) {
        const tagIds = getTagIdsLocal(id);
        ok = _filterMode === 'and'
          ? Array.from(_activeFilters).every(f => tagIds.includes(f))
          : tagIds.some(f => _activeFilters.has(f));
      }
      a.classList.toggle(DIMMED_CLASS, !ok);
    });
  }

  // フィルター条件にマッチする全写真ID（_mappings 全体）
  function getAllMatchingIds() {
    if (!_mappings || !isFilterActive()) return [];
    const result = [];
    for (const [id, entry] of Object.entries(_mappings)) {
      if (entryMatchesFilter(entry)) result.push(id);
    }
    return result;
  }

  // ---- ギャラリーモーダル -------------------------------------------------
  function openGallery() {
    closeGallery();
    if (!isFilterActive()) return;
    const matchedIds = getAllMatchingIds();
    const filterTagNames = Array.from(_activeFilters)
      .map(id => _tagsIndex?.[id]?.name)
      .filter(Boolean);
    // メディアフィルターもタイトルに含める
    if (_mediaFilter === 'photo') filterTagNames.push('画像');
    else if (_mediaFilter === 'video') filterTagNames.push('動画');

    // 撮影日時降順でソート（meta が無いものは末尾）
    const items = matchedIds
      .map(id => ({ id, ...(_mappings[id] ?? {}) }))
      .sort((a, b) => {
        const at = a.meta?.creationTime ?? '';
        const bt = b.meta?.creationTime ?? '';
        return bt.localeCompare(at);
      });

    const modal = el('div', { id: GALLERY_ID });

    // ヘッダー
    const header = el('div', { class: 'gpt-gallery__header' });
    const titleWrap = el('div', { class: 'gpt-gallery__title' });
    titleWrap.appendChild(el('span', { class: 'gpt-gallery__icon', text: '🏷' }));
    const titleText = filterTagNames.length === 0
      ? `タグ付き写真 (${items.length} 件)`
      : `${filterTagNames.join(' / ')} (${items.length} 件)`;
    titleWrap.appendChild(el('span', { class: 'gpt-gallery__title-text', text: titleText }));
    header.appendChild(titleWrap);

    // 統計
    const withThumb = items.filter(i => i.meta?.thumbnailUrl).length;
    const noThumb = items.length - withThumb;
    if (noThumb > 0) {
      header.appendChild(el('div', {
        class: 'gpt-gallery__note',
        text: `※ ${noThumb} 件はサムネイル未取得（一覧画面でスクロールすると自動取得されます）`,
      }));
    }

    header.appendChild(el('button', {
      class: 'gpt-gallery__close',
      'aria-label': '閉じる',
      text: '×',
      onclick: closeGallery,
    }));
    modal.appendChild(header);

    // グリッド
    const grid = el('div', { class: 'gpt-gallery__grid' });

    if (items.length === 0) {
      grid.appendChild(el('div', { class: 'gpt-gallery__empty', text: '該当する写真がありません' }));
    } else {
      for (const item of items) {
        const cell = buildGalleryCell(item);
        grid.appendChild(cell);
      }
    }

    modal.appendChild(grid);
    document.body.appendChild(modal);

    // Esc で閉じる
    const onKey = (e) => {
      if (e.key === 'Escape') closeGallery();
    };
    document.addEventListener('keydown', onKey);
    modal._onKey = onKey;

    // body のスクロールを止める
    document.body.style.overflow = 'hidden';
  }

  function buildGalleryCell(item) {
    const cell = el('a', {
      class: 'gpt-gallery__cell',
      href: '/photo/' + item.id,
      'aria-label': '写真を開く',
    });
    const imgWrap = el('div', { class: 'gpt-gallery__img-wrap' });
    if (item.meta?.thumbnailUrl) {
      const url = normalizeThumbnailUrl(item.meta.thumbnailUrl, 320);
      const img = el('img', {
        class: 'gpt-gallery__img',
        src: url,
        loading: 'lazy',
        alt: '',
      });
      imgWrap.appendChild(img);
    } else {
      imgWrap.classList.add('gpt-gallery__img-wrap--placeholder');
      imgWrap.appendChild(el('div', { class: 'gpt-gallery__placeholder', text: '🖼' }));
    }
    cell.appendChild(imgWrap);

    // キャプション（撮影日時）
    if (item.meta?.creationTime) {
      const date = item.meta.creationTime.split('T')[0];
      cell.appendChild(el('div', { class: 'gpt-gallery__caption', text: date }));
    } else {
      cell.appendChild(el('div', { class: 'gpt-gallery__caption gpt-gallery__caption--unknown', text: '日付不明' }));
    }

    // タグ表示
    const tags = (item.tagIds ?? []).map(id => _tagsIndex?.[id]).filter(Boolean);
    if (tags.length > 0) {
      const tagRow = el('div', { class: 'gpt-gallery__tags' });
      for (const t of tags.slice(0, 3)) {
        tagRow.appendChild(el('span', { class: 'gpt-gallery__tag', text: t.name }));
      }
      if (tags.length > 3) {
        tagRow.appendChild(el('span', { class: 'gpt-gallery__tag gpt-gallery__tag--more', text: `+${tags.length - 3}` }));
      }
      cell.appendChild(tagRow);
    }

    // クリック時：ギャラリーを閉じてから普通にナビゲート
    cell.addEventListener('click', (e) => {
      // <a> のデフォルト動作で /photo/X に遷移
      // ギャラリーは閉じる（次回戻ったときに再開閉できる）
      closeGallery();
    });

    return cell;
  }

  function closeGallery() {
    const modal = document.getElementById(GALLERY_ID);
    if (modal) {
      if (modal._onKey) document.removeEventListener('keydown', modal._onKey);
      modal.remove();
      document.body.style.overflow = '';
    }
  }

  // ---- 一覧画面のサムネイル一覧（簡易） ----------------------------------
  function listVisibleThumbnails() {
    return Array.from(document.querySelectorAll('a[href*="/photo/AF1Qip"]'))
      .map(a => extractIdFromAnchor(a))
      .filter(Boolean);
  }

  // ---- オーバーレイ枠 -----------------------------------------------------
  function buildOverlay() {
    const overlay = el('div', { id: OVERLAY_ID });
    overlay.appendChild(el('div', { class: 'gpt-overlay__title' }, [
      el('span', { text: '📌 Photo Tagger' }),
      el('button', {
        class: 'gpt-overlay__close', 'aria-label': '閉じる', text: '×',
        onclick: () => { overlay.style.display = 'none'; },
      }),
    ]));
    overlay.appendChild(el('div', { class: 'gpt-overlay__body' }));
    overlay.appendChild(el('div', { class: 'gpt-overlay__status' }));
    document.body.appendChild(overlay);
    return overlay;
  }
  function ensureOverlay() {
    return document.getElementById(OVERLAY_ID) ?? buildOverlay();
  }
  function setStatus(text, level = 'info') {
    const s = ensureOverlay().querySelector('.gpt-overlay__status');
    s.className = 'gpt-overlay__status gpt-overlay__status--' + level;
    s.textContent = text;
    if (level === 'info' || level === 'success') {
      setTimeout(() => { if (s.textContent === text) s.textContent = ''; }, 2500);
    }
  }

  // ---- フィルター UI ------------------------------------------------------
  function buildFilterChip(tag) {
    const isActive = _activeFilters.has(tag.id);
    const count = countPhotosWithTag(tag.id);
    const chip = el('button', {
      class: 'gpt-filter-chip' + (isActive ? ' gpt-filter-chip--active' : ''),
      type: 'button',
      'aria-pressed': isActive ? 'true' : 'false',
    });
    chip.appendChild(el('span', { class: 'gpt-filter-chip__name', text: tag.name }));
    chip.appendChild(el('span', { class: 'gpt-filter-chip__count', text: String(count) }));
    chip.addEventListener('click', () => {
      if (_activeFilters.has(tag.id)) _activeFilters.delete(tag.id);
      else _activeFilters.add(tag.id);
      applyFilterToAll();
      lastRenderedKey = null;
      renderListPage();
    });
    return chip;
  }

  // ---- 詳細画面のタグチップ ----------------------------------------------
  function buildTagChip(tag, photoId) {
    const chip = el('span', { class: 'gpt-chip' });
    chip.appendChild(el('span', { class: 'gpt-chip__name', text: tag.name }));
    chip.appendChild(el('button', {
      class: 'gpt-chip__remove', 'aria-label': `タグ「${tag.name}」を外す`, text: '×',
      onclick: async (e) => {
        e.stopPropagation(); e.preventDefault();
        chip.classList.add('gpt-chip--removing');
        try {
          await rpc('remove_tag_from_photo', { photoId, tagId: tag.id });
          chip.remove();
          applyLocalRemove(photoId, tag.id);
          refreshBadgeFor(photoId);
          setStatus(`タグ「${tag.name}」を外しました`, 'success');
        } catch (err) {
          chip.classList.remove('gpt-chip--removing');
          setStatus('外せませんでした: ' + err.message, 'error');
        }
      },
    }));
    return chip;
  }

  // ---- 詳細画面の描画 -----------------------------------------------------
  let lastRenderedKey = null;
  let currentRenderToken = 0;

  async function renderDetailPage(photoId) {
    const renderKey = 'detail:' + photoId;
    if (lastRenderedKey === renderKey) return;
    lastRenderedKey = renderKey;
    const myToken = ++currentRenderToken;

    const overlay = ensureOverlay();
    overlay.style.display = '';
    const body = overlay.querySelector('.gpt-overlay__body');
    clear(body);

    const debug = el('div', { class: 'gpt-debug' });
    debug.appendChild(document.createTextNode('ID: '));
    debug.appendChild(el('code', { text: photoId.substring(0, 16) + '…' }));
    body.appendChild(debug);

    const chipsContainer = el('div', { class: 'gpt-chips' });
    chipsContainer.appendChild(el('span', { class: 'gpt-chips__loading', text: '読み込み中…' }));
    body.appendChild(chipsContainer);

    const form = el('form', { class: 'gpt-input-row' });
    const input = el('input', {
      class: 'gpt-input', type: 'text', placeholder: 'タグを追加（カンマ , で複数）…',
      maxlength: '200', autocomplete: 'off', spellcheck: 'false',
    });
    const submit = el('button', { class: 'gpt-add-btn', type: 'submit', text: '追加' });
    form.appendChild(input);
    form.appendChild(submit);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      // カンマ（半角 , / 全角 、）だけで複数タグに分割（スペースはタグ名の一部として残す）
      const names = input.value
        .split(/[,、]+/)
        .map(s => s.trim())
        .filter(Boolean);
      if (names.length === 0) return;

      const meta = metaForPhoto(photoId);
      // 既に表示されているタグ名
      const existingNames = new Set(
        Array.from(chipsContainer.querySelectorAll('.gpt-chip__name')).map(n => n.textContent)
      );

      // --- 楽観的更新：即座に画面へ反映（保存は裏で行う）---
      chipsContainer.querySelector('.gpt-chips__loading')?.remove();
      chipsContainer.querySelector('.gpt-chips__empty')?.remove();
      const toAdd = [];
      for (const name of names) {
        if (existingNames.has(name)) continue;
        existingNames.add(name);
        toAdd.push(name);
        // 仮のタグオブジェクト（id は保存後に確定するが、表示・ローカルには即反映）
        const tempTag = { id: 'pending_' + name, name };
        chipsContainer.appendChild(buildTagChip(tempTag, photoId));
      }
      input.value = '';
      input.focus();
      if (toAdd.length === 0) return;
      setStatus(`「${toAdd.join('、')}」を追加中…`, 'info');

      // --- 保存は裏で（UI はブロックしない）---
      rpc('add_tags_to_photo', { photoId, names: toAdd, meta })
        .then(res => {
          // 確定したタグでローカルキャッシュを更新
          for (const tag of (res.tags ?? [])) {
            applyLocalAdd(photoId, tag, meta);
          }
          // 仮タグ（pending_*）を本物のタグに置き換えて再描画（× 削除が正しく効くように）
          if (extractCurrentPhotoId() === photoId) {
            const tags = getTagsForPhotoLocal(photoId) ?? [];
            clear(chipsContainer);
            if (tags.length === 0) {
              chipsContainer.appendChild(el('span', { class: 'gpt-chips__empty', text: 'タグなし' }));
            } else {
              for (const tag of tags) chipsContainer.appendChild(buildTagChip(tag, photoId));
            }
          }
          refreshBadgeFor(photoId);
          setStatus(`${toAdd.length} 件のタグを保存しました`, 'success');
          if (meta?.thumbnailUrl) maybeBackfillThumbData(photoId, meta.thumbnailUrl);
        })
        .catch(err => {
          setStatus('保存に失敗しました: ' + err.message, 'error');
        });
    });
    body.appendChild(form);

    try {
      const res = await rpc('get_tags_for_photo', { photoId });
      if (myToken !== currentRenderToken) return;
      clear(chipsContainer);
      if (res.tags.length === 0) {
        chipsContainer.appendChild(el('span', { class: 'gpt-chips__empty', text: 'タグなし' }));
      } else {
        for (const tag of res.tags) {
          chipsContainer.appendChild(buildTagChip(tag, photoId));
        }
      }
    } catch (err) {
      if (myToken !== currentRenderToken) return;
      clear(chipsContainer);
      chipsContainer.appendChild(el('span', { class: 'gpt-chips__error', text: 'タグ取得失敗: ' + err.message }));
    }
  }

  // ---- 一覧画面の描画 -----------------------------------------------------
  async function renderListPage() {
    if (lastRenderedKey === 'list') {
      updateListStats();
      processVisibleThumbnails();
      return;
    }
    lastRenderedKey = 'list';
    ++currentRenderToken;

    const overlay = ensureOverlay();
    overlay.style.display = '';
    const body = overlay.querySelector('.gpt-overlay__body');
    clear(body);

    body.appendChild(el('div', { class: 'gpt-debug', text: '一覧画面' }));
    body.appendChild(el('div', { class: 'gpt-list-stats' }));
    body.appendChild(el('div', { class: 'gpt-filter-section' }));
    body.appendChild(el('div', { class: 'gpt-view-results-row' }));
    body.appendChild(el('div', { class: 'gpt-hint', text: '写真をクリックでタグ追加・タグでフィルター' }));

    try {
      await ensureIndex();
      renderFilterSection();
      renderViewResultsButton();
      processVisibleThumbnails();
      updateListStats();
    } catch (err) {
      console.error('[GPT content] index load failed', err);
    }
  }

  // メディア種別セグメント（すべて / 画像 / 動画）
  function buildMediaSegment() {
    const row = el('div', { class: 'gpt-media-seg' });
    const opts = [['all', 'すべて'], ['photo', '画像'], ['video', '動画'], ['gif', 'GIF']];
    for (const [val, label] of opts) {
      const btn = el('button', {
        class: 'gpt-media-seg__btn' + (_mediaFilter === val ? ' gpt-media-seg__btn--active' : ''),
        type: 'button', text: label,
      });
      btn.addEventListener('click', () => {
        _mediaFilter = val;
        applyFilterToAll();
        lastRenderedKey = null;
        renderListPage();
      });
      row.appendChild(btn);
    }
    return row;
  }

  // AND / OR トグル
  function buildModeToggle() {
    const toggle = el('button', {
      class: 'gpt-mode-toggle', type: 'button',
      title: 'タグの組み合わせ方を切り替え',
      text: _filterMode === 'and' ? 'すべて含む (AND)' : 'いずれか (OR)',
    });
    toggle.addEventListener('click', () => {
      _filterMode = _filterMode === 'and' ? 'or' : 'and';
      applyFilterToAll();
      lastRenderedKey = null;
      renderListPage();
    });
    return toggle;
  }

  function renderFilterSection() {
    const section = ensureOverlay().querySelector('.gpt-filter-section');
    if (!section) return;
    clear(section);

    // メディア種別セグメントは常に表示（タグが無くても使える）
    section.appendChild(el('div', { class: 'gpt-filter-label', text: '種類' }));
    section.appendChild(buildMediaSegment());

    if (!_tagsIndex || Object.keys(_tagsIndex).length === 0) {
      section.appendChild(el('div', { class: 'gpt-filter-empty', text: '（まだタグがありません）' }));
      return;
    }

    // タグフィルターの見出し + AND/OR トグル
    const labelRow = el('div', { class: 'gpt-filter-label-row' });
    labelRow.appendChild(el('span', { class: 'gpt-filter-label', text: 'タグ（複数選択可）' }));
    if (_activeFilters.size >= 2) labelRow.appendChild(buildModeToggle());
    section.appendChild(labelRow);

    const chipsRow = el('div', { class: 'gpt-filter-chips' });
    const sortedTags = Object.values(_tagsIndex).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    for (const tag of sortedTags) chipsRow.appendChild(buildFilterChip(tag));
    section.appendChild(chipsRow);

    if (isFilterActive()) {
      const clearBtn = el('button', {
        class: 'gpt-filter-clear', type: 'button',
        text: 'フィルター解除',
      });
      clearBtn.addEventListener('click', () => {
        _activeFilters.clear();
        _mediaFilter = 'all';
        _filterMode = 'and';
        applyFilterToAll();
        lastRenderedKey = null;
        renderListPage();
      });
      section.appendChild(clearBtn);
    }
  }

  function renderViewResultsButton() {
    const row = ensureOverlay().querySelector('.gpt-view-results-row');
    if (!row) return;
    clear(row);
    if (!isFilterActive()) return;
    const matchedCount = getAllMatchingIds().length;
    const btn = el('button', {
      class: 'gpt-view-results-btn',
      type: 'button',
      text: `🖼  結果を一覧で見る (${matchedCount} 件)`,
    });
    btn.addEventListener('click', openGallery);
    row.appendChild(btn);
  }

  function updateListStats() {
    const stats = ensureOverlay().querySelector('.gpt-list-stats');
    if (!stats) return;
    const all = document.querySelectorAll('a[href*="/photo/AF1Qip"]').length;
    if (isFilterActive()) {
      const totalMatch = getAllMatchingIds().length;
      stats.textContent = `表示中 ${all} 件 / 条件一致 ${totalMatch} 件`;
      stats.classList.add('gpt-list-stats--filtered');
    } else {
      const tagged = _mappings ? Object.keys(_mappings).length : 0;
      stats.textContent = `表示中 ${all} 件 / 全タグ付き ${tagged} 件`;
      stats.classList.remove('gpt-list-stats--filtered');
    }
  }

  // ---- 複数選択モード検知 + 一括タグ付け ---------------------------------
  function getSelectedPhotoIds() {
    // [role="checkbox"][aria-checked="true"] のうち、写真/動画のものだけ拾う
    const checked = document.querySelectorAll('[role="checkbox"][aria-checked="true"]');
    const labels = new Set();
    for (const c of checked) {
      const label = c.getAttribute('aria-label') ?? '';
      // 「写真 - 」「動画 - 」で始まるものが個別写真。「○○の写真をすべて選択」は日付ヘッダの集約なので除外
      if (/^(写真|動画)\s*-/.test(label)) {
        labels.add(label);
      }
    }
    if (labels.size === 0) return [];
    // aria-label を anchor の aria-label と突き合わせて photoId を取得
    const ids = [];
    const idToMeta = {};
    for (const a of document.querySelectorAll('a[href*="/photo/AF1Qip"]')) {
      const aLabel = a.getAttribute('aria-label') ?? '';
      if (labels.has(aLabel)) {
        const id = extractIdFromAnchor(a);
        if (id && !idToMeta[id]) {
          ids.push(id);
          idToMeta[id] = extractMetaFromAnchor(a);
        }
      }
    }
    return ids.map(id => ({ photoId: id, meta: idToMeta[id] }));
  }

  function isInSelectionMode() {
    return getSelectedPhotoIds().length > 0;
  }

  let _bulkUiVisible = false;
  function renderBulkTagBar() {
    const items = getSelectedPhotoIds();
    const overlay = ensureOverlay();
    if (items.length === 0) {
      // 選択モード解除：一括 UI を消して通常一覧に戻す
      const bar = document.getElementById('gpt-bulk-bar');
      if (bar) bar.remove();
      _bulkUiVisible = false;
      return;
    }
    // 選択モード中は通常のオーバーレイを隠して一括バーを表示
    overlay.style.display = 'none';
    let bar = document.getElementById('gpt-bulk-bar');
    if (!bar) {
      bar = el('div', { id: 'gpt-bulk-bar' });
      bar.appendChild(el('div', { class: 'gpt-bulk-bar__count' }));
      const form = el('form', { class: 'gpt-bulk-bar__form' });
      const input = el('input', {
        class: 'gpt-bulk-bar__input',
        type: 'text',
        placeholder: '選択した写真にまとめて付けるタグ…',
        maxlength: '64',
        autocomplete: 'off',
        spellcheck: 'false',
      });
      const submit = el('button', { class: 'gpt-bulk-bar__submit', type: 'submit', text: '一括タグ付け' });
      form.appendChild(input);
      form.appendChild(submit);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        const currentItems = getSelectedPhotoIds();
        if (currentItems.length === 0) return;
        submit.disabled = true;
        try {
          const res = await rpc('bulk_add_tag', { items: currentItems, name });
          // ローカル反映 + サムネイルデータ取得（一括）
          for (const { photoId, meta } of currentItems) {
            applyLocalAdd(photoId, res.tag, meta);
            refreshBadgeFor(photoId);
            if (meta?.thumbnailUrl) {
              maybeBackfillThumbData(photoId, meta.thumbnailUrl);
            }
          }
          input.value = '';
          showBulkStatus(`タグ「${res.tag.name}」を ${res.added} 件に追加${res.alreadyHad > 0 ? `（${res.alreadyHad} 件は既に付与済み）` : ''}`, 'success');
        } catch (err) {
          showBulkStatus('失敗: ' + err.message, 'error');
        } finally {
          submit.disabled = false;
          input.focus();
        }
      });
      bar.appendChild(form);
      bar.appendChild(el('div', { class: 'gpt-bulk-bar__status' }));
      document.body.appendChild(bar);
      _bulkUiVisible = true;
    }
    bar.querySelector('.gpt-bulk-bar__count').textContent = `🏷 ${items.length} 件選択中`;
  }
  function showBulkStatus(text, level = 'info') {
    const bar = document.getElementById('gpt-bulk-bar');
    if (!bar) return;
    const s = bar.querySelector('.gpt-bulk-bar__status');
    s.className = 'gpt-bulk-bar__status' + (level === 'success' ? ' gpt-bulk-bar__status--success' : level === 'error' ? ' gpt-bulk-bar__status--error' : '');
    s.textContent = text;
    if (level === 'info' || level === 'success') {
      setTimeout(() => { if (s.textContent === text) s.textContent = ''; }, 3500);
    }
  }

  // ---- ルーティング ------------------------------------------------------
  function render() {
    const photoId = extractCurrentPhotoId();
    if (photoId) {
      // 詳細画面遷移時、ギャラリーが開いていたら閉じる
      closeGallery();
      renderDetailPage(photoId).catch(err => console.error('[GPT content] detail render failed', err));
      return;
    }
    // 一覧画面：複数選択モード優先
    if (isInSelectionMode()) {
      renderBulkTagBar();
      return;
    }
    // 通常の一覧
    if (_bulkUiVisible) {
      // 選択モードから抜けた直後：UI クリーンアップ
      renderBulkTagBar(); // items===0 なのでクリーンアップが走る
    }
    ensureOverlay().style.display = '';
    renderListPage().catch(err => console.error('[GPT content] list render failed', err));
  }

  // ---- URL 変化検知 -------------------------------------------------------
  let lastHref = location.href;
  const onUrlChange = () => {
    if (location.href !== lastHref) {
      const wasOnDetail = lastHref.match(PHOTO_ID_REGEX);
      lastHref = location.href;
      if (wasOnDetail && !extractCurrentPhotoId()) {
        clearAllBadges();
        lastRenderedKey = null;
      }
      render();
    }
  };
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args) { origPush.apply(this, args); queueMicrotask(onUrlChange); };
  history.replaceState = function (...args) { origReplace.apply(this, args); queueMicrotask(onUrlChange); };
  window.addEventListener('popstate', onUrlChange);

  // ---- DOM 変化観察 -------------------------------------------------------
  let scheduleTimer = null;
  const scheduleRender = () => {
    if (scheduleTimer) return;
    scheduleTimer = setTimeout(() => {
      scheduleTimer = null;
      render();
      if (!extractCurrentPhotoId()) {
        processVisibleThumbnails();
        updateListStats();
        renderViewResultsButton();
      }
    }, 350);
  };
  const observer = new MutationObserver(scheduleRender);
  observer.observe(document.body, { childList: true, subtree: true });

  // ---- 初回レンダリング ---------------------------------------------------
  setTimeout(render, 200);
  setTimeout(render, 800);
  setTimeout(render, 2000);

  console.log('[Photo Tagger] content script loaded');
})();
