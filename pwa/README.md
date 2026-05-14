# Photo Tagger PWA

PC で付与したタグから写真をスマホで検索するためのモバイルクライアント。

## ファイル構成

| ファイル | 内容 |
|---|---|
| `index.html` | エントリー（モバイル最適化、Safe Area 対応） |
| `app.js` | OAuth、Drive 読み取り、UI ロジック、アカウント切り替え |
| `styles.css` | ダーク UI、グリッドレイアウト |
| `manifest.webmanifest` | PWA メタデータ（ホーム画面追加用） |
| `sw.js` | Service Worker（シェルキャッシュ、PWA インストール要件充足） |
| `icon-192.svg` / `icon-512.svg` | アプリアイコン |
| `privacy.html` | プライバシーポリシー（OAuth 本番化に必須） |
| `config.example.js` | 設定ファイルのテンプレート |

## 動作仕様

### 認証

Google Identity Services Token Client を使用。

- 初回サインイン時にトークンと「自動サインインフラグ」を保存
- 次回起動時、`prompt: ''` でサイレント再認証を試行
- 失敗したらサインイン画面を表示
- アカウント切り替えは `prompt: 'select_account'` でアカウント選択ダイアログを再度表示

トークンは `sessionStorage`（タブ閉じで消える）、自動サインインフラグと最後に使ったメールアドレスは `localStorage` に保存。

### スコープ

- `drive.appdata`：Drive の `appDataFolder` 読み書き
- `openid` / `email` / `profile`：ユーザー情報取得

すべて非機密スコープ。Google の検証プロセス無しで本番公開できる。

### データ取得

`drive/v3/files?spaces=appDataFolder&q=name='tags.json'` で `tags.json` と `mappings.json` を取得。サムネイルは `mappings.json` 内の `meta.thumbnailData`（data URI）をそのまま `<img src>` に渡す。

Google フォト CDN への直接アクセスは行わない（クロスオリジン認証制約のため）。

## ローカル起動

```bash
python -m http.server --bind 127.0.0.1 8080
# または npx http-server -p 8080
```

ブラウザで `http://localhost:8080/` を開く。`config.js` がない場合は設定エラー画面が表示される。

## デプロイ

GitHub Pages、Cloudflare Pages、Vercel、Netlify など任意の静的ホスティングに `pwa/` 配下のファイルを配置するだけで動く。

## 機能しないこと

API 制約により、以下は対応できない。

- 新規タグの作成・付与（PC で行う）
- Google フォト純正アプリへの組み込み（API が提供されていない）
- 既存写真への直接アクセス（Photos Library API は 2025 年 3 月以降、自アプリがアップロードした写真しか扱えない）
