// options.js ― タグ管理画面ロジック
'use strict';

// ---- DOM ヘルパ ----------------------------------------------------------
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

// ---- service worker と通信 ----------------------------------------------
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

// ---- 状態 ---------------------------------------------------------------
let _allTags = [];
let _tagCounts = {}; // tagId → 件数
let _searchQuery = '';
let _sortMode = 'count-desc';

// ---- データ取得 ---------------------------------------------------------
async function loadAll() {
  showState('loading');
  try {
    const res = await rpc('get_index');
    _allTags = res.tags ?? [];
    _tagCounts = {};
    for (const tag of _allTags) _tagCounts[tag.id] = 0;
    for (const entry of Object.values(res.mappings ?? {})) {
      for (const tagId of entry.tagIds ?? []) {
        if (_tagCounts[tagId] !== undefined) _tagCounts[tagId]++;
      }
    }
    renderTable();
    updateMeta();
  } catch (err) {
    showState('error', err.message);
  }
}

function showState(state, message = '') {
  $('#loading').hidden = state !== 'loading';
  $('#tags-table').hidden = state !== 'table';
  $('#empty').hidden = state !== 'empty';
  const errEl = $('#error');
  errEl.hidden = state !== 'error';
  if (state === 'error') errEl.textContent = '読み込み失敗: ' + message;
}

function updateMeta() {
  const totalTags = _allTags.length;
  const totalPhotos = Object.keys(_tagCounts).length === 0
    ? 0
    : Math.max(0, _allTags.length); // 単純な目安。実際の写真数は別計算が必要
  // appDataFolder のサイズ目安などは後回し
  $('#page-meta').textContent = `${totalTags} タグ`;
}

function renderTable() {
  const filtered = _allTags
    .filter(t => !_searchQuery || t.name.toLowerCase().includes(_searchQuery.toLowerCase()))
    .map(t => ({ ...t, count: _tagCounts[t.id] ?? 0 }));

  filtered.sort((a, b) => {
    switch (_sortMode) {
      case 'name': return a.name.localeCompare(b.name, 'ja');
      case 'count-asc': return a.count - b.count || a.name.localeCompare(b.name, 'ja');
      case 'count-desc': return b.count - a.count || a.name.localeCompare(b.name, 'ja');
      case 'created-asc': return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
      case 'created-desc': return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
      default: return 0;
    }
  });

  if (_allTags.length === 0) { showState('empty'); return; }

  const tbody = $('#tags-body');
  clear(tbody);
  for (const t of filtered) {
    tbody.appendChild(buildRow(t));
  }
  showState('table');
}

function buildRow(tag) {
  const tr = el('tr');
  tr.appendChild(el('td', { class: 'tag-name', text: tag.name }));
  const countTd = el('td', {
    class: 'tag-count' + (tag.count === 0 ? ' tag-count--zero' : ''),
    text: String(tag.count),
  });
  tr.appendChild(countTd);
  const created = tag.createdAt ? tag.createdAt.split('T')[0] : '―';
  tr.appendChild(el('td', { class: 'tag-created', text: created }));

  const actions = el('td', { class: 'tag-actions' });
  actions.appendChild(el('button', {
    type: 'button', text: 'リネーム',
    onclick: () => openRenameDialog(tag),
  }));
  actions.appendChild(el('button', {
    type: 'button', text: '統合',
    onclick: () => openMergeDialog(tag),
  }));
  actions.appendChild(el('button', {
    type: 'button', class: 'danger', text: '削除',
    onclick: () => openDeleteDialog(tag),
  }));
  tr.appendChild(actions);
  return tr;
}

// ---- モーダル基盤 -------------------------------------------------------
function openModal({ title, bodyBuilder, okText = 'OK', okClass = 'btn-primary', onConfirm }) {
  const modal = $('#modal');
  $('#modal-title').textContent = title;
  const body = $('#modal-body');
  clear(body);
  bodyBuilder(body);
  const okBtn = $('#modal-ok');
  okBtn.textContent = okText;
  okBtn.className = okClass;
  // 既存のリスナー削除
  const newOk = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOk, okBtn);
  newOk.addEventListener('click', async () => {
    newOk.disabled = true;
    try {
      await onConfirm();
      closeModal();
    } catch (err) {
      toast('失敗: ' + err.message, 'error');
    } finally {
      newOk.disabled = false;
    }
  });
  $('#modal-cancel').onclick = closeModal;
  modal.hidden = false;
}
function closeModal() { $('#modal').hidden = true; }

// ---- 操作ダイアログ -----------------------------------------------------
function openRenameDialog(tag) {
  let inputEl;
  openModal({
    title: 'タグをリネーム',
    bodyBuilder: (body) => {
      body.appendChild(el('div', { text: `「${tag.name}」を新しい名前に変更します。` }));
      inputEl = el('input', { type: 'text', maxlength: '64' });
      inputEl.value = tag.name;
      body.appendChild(inputEl);
      setTimeout(() => { inputEl.focus(); inputEl.select(); }, 50);
    },
    okText: 'リネーム',
    onConfirm: async () => {
      const newName = inputEl.value.trim();
      if (!newName || newName === tag.name) { closeModal(); return; }
      const res = await rpc('rename_tag', { tagId: tag.id, newName });
      toast(`「${tag.name}」を「${res.tag.name}」に変更しました`, 'success');
      await loadAll();
    },
  });
}

function openMergeDialog(sourceTag) {
  let selectEl;
  openModal({
    title: 'タグを統合',
    bodyBuilder: (body) => {
      body.appendChild(el('div', {
        text: `「${sourceTag.name}」を別のタグに統合します。「${sourceTag.name}」が付いていた写真は統合先のタグに移り、「${sourceTag.name}」自体は削除されます。`,
      }));
      selectEl = el('select');
      selectEl.appendChild(el('option', { value: '', text: '統合先タグを選択…' }));
      const others = _allTags
        .filter(t => t.id !== sourceTag.id)
        .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
      for (const t of others) {
        const opt = el('option', { value: t.id, text: `${t.name} (${_tagCounts[t.id] ?? 0} 件)` });
        selectEl.appendChild(opt);
      }
      body.appendChild(selectEl);
    },
    okText: '統合する',
    onConfirm: async () => {
      const targetId = selectEl.value;
      if (!targetId) throw new Error('統合先タグを選択してください');
      const res = await rpc('merge_tags', { sourceTagId: sourceTag.id, targetTagId: targetId });
      toast(`${res.affectedPhotos} 件の写真を「${res.mergedTo.name}」に統合しました`, 'success');
      await loadAll();
    },
  });
}

function openDeleteDialog(tag) {
  const count = _tagCounts[tag.id] ?? 0;
  openModal({
    title: 'タグを削除',
    bodyBuilder: (body) => {
      body.appendChild(el('div', {
        text: `タグ「${tag.name}」を削除します。${count > 0 ? `現在 ${count} 件の写真にこのタグが付いていますが、写真自体は削除されません（タグの紐付けだけが解除されます）。` : 'このタグはどの写真にも付いていません。'}`,
      }));
      body.appendChild(el('div', { class: 'warn', text: 'この操作は取り消せません。' }));
    },
    okText: '削除',
    okClass: 'btn-primary btn-primary--danger',
    onConfirm: async () => {
      const res = await rpc('delete_tag', { tagId: tag.id });
      toast(`「${tag.name}」を削除しました（${res.affectedPhotos} 件の写真から外しました）`, 'success');
      await loadAll();
    },
  });
}

// ---- トースト -----------------------------------------------------------
let _toastTimer = null;
function toast(text, level = 'info') {
  const t = $('#toast');
  t.className = 'toast' + (level === 'success' ? ' toast--success' : level === 'error' ? ' toast--error' : '');
  t.textContent = text;
  t.hidden = false;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

// ---- イベント ----------------------------------------------------------
$('#search').addEventListener('input', (e) => {
  _searchQuery = e.target.value;
  renderTable();
});
$('#sort').addEventListener('change', (e) => {
  _sortMode = e.target.value;
  renderTable();
});
$('#refresh').addEventListener('click', () => {
  // キャッシュもクリアして再取得
  rpc('reset_cache').finally(() => loadAll());
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
});

// ---- 起動 -------------------------------------------------------------
loadAll();
