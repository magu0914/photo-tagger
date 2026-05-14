# Photo Tagger

Google フォトの写真にユーザー独自のタグを付けて、PC とスマホの両方から検索できるようにするツール。

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4)
![Vanilla JS](https://img.shields.io/badge/Vanilla_JS-f7df1e?logo=javascript&logoColor=000)
![PWA](https://img.shields.io/badge/PWA-5A0FC8)
![License: MIT](https://img.shields.io/badge/License-MIT-green)
![Version](https://img.shields.io/badge/version-1.0.0-blue)

> Google フォトの曖昧な AI 検索とアルバムベースの整理だけでは、撮りためた数千枚〜数万枚の中から目的の写真にたどり着くのは難しい。本プロジェクトは「タグ」という馴染みのある概念を Google フォトに後付けし、PC では Chrome 拡張機能、スマホでは PWA という役割分担で運用する。

## デモ

<!-- TODO: スクリーンショット or 動画埋め込み -->

| PC（拡張機能） | モバイル（PWA） |
|---|---|
| 写真にタグ付け、フィルター、ギャラリー表示 | タグから写真を検索、Google フォトで開く |

タグデータはユーザー自身の Google Drive の隠しフォルダに保存されるため、サーバーサイドの実装を持たない構成で完結している。

## 機能

**Chrome / Edge 拡張機能**
- 写真詳細画面でタグの追加・削除
- 一覧画面のサムネイルにタグバッジ
- タグで絞り込み（OR 条件、複数選択）
- フィルター結果の全画面ギャラリー
- 複数選択モードでの一括タグ付け
- タグ管理画面（リネーム・統合・削除）

**モバイル PWA**
- スマホからタグを起点に写真検索
- 写真クリックで Google フォト純正アプリへ遷移
- 永続ログイン・複数アカウント切り替え

## 技術構成

| 領域 | 採用技術 |
|---|---|
| Chrome 拡張機能 | Manifest V3、Service Worker、Content Script、Vanilla JS |
| モバイルクライアント | PWA、Service Worker、Web App Manifest（ビルドステップなし） |
| 認証 | OAuth 2.0、Google Identity Services Token Client、`chrome.identity` |
| データストア | Google Drive `appDataFolder`（アプリ専用の隠し領域、ユーザーごと独立） |
| API | Google Drive API v3 |
| デプロイ | 静的ホスティング（GitHub Pages）、サーバー不要 |
| CI/CD | GitHub Actions（PWA の自動デプロイ） |

## アーキテクチャ

```
[PC: Chrome / Edge]                 [スマホ: iOS / Android]
  Chrome 拡張機能                       PWA
  ├ Content Script                      ├ Google Identity Services
  │  └ photos.google.com の DOM 操作    │   └ サイレント再認証で永続ログイン
  ├ Service Worker                      └ Drive API クライアント
  │  ├ chrome.identity で OAuth                ↑
  │  ├ Drive クライアント                       │ 読み取り
  │  └ サムネイル base64 キャッシュ             │
  └ Options ページ（タグ管理）                 │
            │ 書き込み                          │
            ▼                                   │
       Google Drive appDataFolder ──────────────┘
        ├ tags.json
        └ mappings.json（写真ID → タグID + メタ + base64 サムネイル）
```

PC で写真にタグを付けると、その時点でサムネイル画像（96×96 JPEG, 約 4KB）も同時にキャッシュされる。スマホ側はこのキャッシュを Drive 経由で読むだけで動作するため、Google フォト本体への直接アクセスや写真本体の転送は不要。

## このプロジェクトで取り組んだ技術課題

- **写真の同一性の確定**：Photos Library API の制約下で、Web 側 ID（`AF1Qip` で始まる 44 文字）を主キーとし、撮影日時を補助情報として併用する設計に至った経緯。
- **Trusted Types CSP への対応**：Google フォトに採用されている Trusted Types 環境下では `innerHTML` への文字列代入が禁止されるため、すべての UI を `createElement` ベースで構築。
- **クロスオリジンでの画像取得**：`Cross-Origin-Resource-Policy: same-site` および Cookie の `SameSite` 制約により、PWA から Google フォト CDN を直接読めないことを特定し、Chrome 拡張機能側でサムネイルを base64 エンコードしてデータ層に埋め込む方式で解決。
- **SPA ナビゲーションと MutationObserver の競合**：`setTimeout` 発火時に最新 URL を再評価することでレースバグを修正。

## ディレクトリ構成

```
.
├── README.md
├── CHANGELOG.md
├── SECURITY.md
├── LICENSE
├── .gitignore
├── .github/workflows/
│   └── deploy-pwa.yml          GitHub Pages 自動デプロイ
├── docs/
│   ├── architecture.md         アーキテクチャと設計判断
│   ├── setup.md                Google Cloud Console 設定 / ローカル開発
│   └── usage.md                スマホでの利用方法
├── extension/                  Chrome 拡張機能
│   ├── manifest.json
│   ├── background.js           Service Worker / Drive クライアント / RPC ハブ
│   ├── content.js              DOM 注入 / タグ UI / バックフィル
│   ├── content.css
│   ├── popup.html
│   ├── options.html / .css / .js
│   └── README.md
└── pwa/                        モバイル向け PWA
    ├── index.html
    ├── privacy.html
    ├── app.js
    ├── styles.css
    ├── manifest.webmanifest
    ├── sw.js
    ├── icon-192.svg / icon-512.svg
    ├── config.example.js
    └── README.md
```

## セットアップ

[docs/setup.md](docs/setup.md) を参照。Google Cloud Console での OAuth クライアント発行、拡張機能のインストール、PWA のローカル起動までを記載。

## ライセンス

MIT License。詳細は [LICENSE](LICENSE) を参照。
