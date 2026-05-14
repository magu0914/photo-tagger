# Photo Tagger Chrome Extension

Google フォト Web に注入され、写真へのタグ付け機能を提供する Chrome / Edge 拡張機能。

## ファイル構成

| ファイル | 内容 |
|---|---|
| `manifest.json` | 拡張機能の宣言（Manifest V3、OAuth 設定、host_permissions） |
| `background.js` | Service Worker。OAuth、Drive API クライアント、RPC ハブ |
| `content.js` | photos.google.com に注入される本体ロジック |
| `content.css` | オーバーレイ・タグチップ・ギャラリーモーダルのスタイル |
| `popup.html` | アイコンクリック時の小窓 |
| `options.html` / `.css` / `.js` | タグ管理画面（リネーム、統合、削除） |

## 主な機能

- 写真詳細画面でのタグ追加・削除
- 一覧サムネイルへのタグバッジ重ね描画
- タグでのフィルター（OR 条件、複数選択）
- フィルター結果を全画面ギャラリーで表示
- 複数選択モードでの一括タグ付け
- タグ管理画面（オプションページ）
- Drive `appDataFolder` への自動同期（debounce 集約、楽観的キャッシュ）
- サムネイルの base64 キャッシュ（PWA から読めるようにするため）

## インストール

1. `chrome://extensions/` を開く
2. デベロッパーモードを ON
3. 「パッケージ化されていない拡張機能を読み込む」 → このフォルダを選択

OAuth クライアント ID の設定は親ディレクトリの `docs/setup.md` 参照。

## 内部構成

### メッセージ経路

Content Script から Background Service Worker への RPC は次の API を提供する。

| メッセージタイプ | 内容 |
|---|---|
| `list_all_tags` | タグ一覧取得 |
| `create_tag` | タグ作成 |
| `get_tags_for_photo` | 単一写真のタグ取得 |
| `add_new_tag_to_photo` | タグ作成と写真への付与をまとめて |
| `add_tag_to_photo` / `remove_tag_from_photo` | タグの付け外し |
| `bulk_add_tag` | 複数写真への一括タグ付与 |
| `get_index` | 全 mappings の取得（一覧画面のバッジ・フィルター用） |
| `update_photo_meta` / `batch_update_meta` | サムネイルキャッシュのバックフィル |
| `rename_tag` / `delete_tag` / `merge_tags` | タグ管理画面用 |
| `list_app_data_files` / `delete_file_by_name` / `reset_cache` | デバッグ用 |

### Drive 書き込み戦略

`tags.json` と `mappings.json` の書き込みは `setTimeout(_, 400)` で debounce する。連続編集時に書き込みが集中するのを防ぐため。

ファイル更新は `multipart/related` でメタデータと内容を一回の HTTP PATCH/POST で送る。

### サムネイルキャッシュ

タグ付け時 / 一覧表示時に、photos.google.com 上の同サイト fetch（`credentials: 'include'`）で 96×96 JPEG を取得し、base64 エンコードして `mappings.json` の `meta.thumbnailData` に埋め込む。並列度は 3、1 件あたり 50KB 上限。

これにより PWA は Drive を読むだけでサムネイルを表示できる（ブラウザのクロスオリジン認証制約を回避）。
