# アーキテクチャ

## 設計の出発点

Google フォトには「ユーザーが任意のキーワードでタグ付けする」機能が標準で存在しない。整理手段はアルバム作成しかなく、写真 1 枚を複数の文脈で分類しようとするとアルバムが乱立する。本プロジェクトは、Google フォトの外側にタグデータベースを持ち、Web UI に重ねるかたちでこの不便を解消することを目的とする。

設計上の核心となる制約は次の 3 点。

1. Google Photos Library API は写真にカスタムキーワードを書き込む機能を提供していない。タグは外部に保存するしかない。
2. 2025 年 3 月以降の API 制約により、第三者アプリは「自アプリがアップロードした写真」しか管理できない。既存ユーザーライブラリへの読み書きは不可。
3. iOS / Android の Google フォト純正アプリには、サードパーティから組み込む API がない。モバイル対応は別アプリとして実装するしかない。

これらを踏まえ、PC では Chrome 拡張機能で Web 版 Google フォトに UI を注入し、モバイルでは独立した PWA として実装する役割分担を採用した。

## 全体構成

```
┌── PC（Chrome / Edge）─────────────────────────────────────┐
│                                                           │
│  ┌── photos.google.com ──────────────────────────────┐   │
│  │  Content Script                                   │   │
│  │   ・写真詳細画面にタグ入力 UI を重ねる            │   │
│  │   ・一覧サムネイルにタグバッジを描画              │   │
│  │   ・複数選択モードで一括タグ付けバーを表示        │   │
│  │   ・サムネイルを base64 化してキャッシュ          │   │
│  └────────────┬──────────────────────────────────────┘   │
│               │ chrome.runtime.sendMessage                │
│               ▼                                           │
│  ┌──────────────────────────────────────────────────┐    │
│  │  Service Worker                                  │    │
│  │   ・chrome.identity で OAuth トークン取得        │    │
│  │   ・Drive クライアント（読み書き、debounce 集約）│    │
│  │   ・タグ操作の RPC ハブ                          │    │
│  │   ・楽観的キャッシュ                             │    │
│  └────────────────────────┬─────────────────────────┘    │
│                           │ HTTPS                         │
│  ┌── Options ページ ──┐   │                               │
│  │ タグ管理            │   │                               │
│  │  リネーム / 統合 /  │   │                               │
│  │  削除               │   │                               │
│  └─────────────────────┘   │                               │
└────────────────────────────┼───────────────────────────────┘
                             ▼
                  ┌── Google Drive appDataFolder ──┐
                  │  tags.json                     │
                  │  mappings.json（タグ紐付け +    │
                  │   meta + base64 サムネイル）   │
                  └──────────────┬─────────────────┘
                                 │ HTTPS
                                 ▼
┌── スマホ（iOS / Android）────────────────────────┐
│  PWA                                             │
│   ・Google Identity Services でサインイン        │
│   ・Drive 読み取りクライアント                   │
│   ・タグ別写真ビュー（base64 サムネイル表示）    │
│   ・Google フォト純正アプリへのディープリンク    │
└──────────────────────────────────────────────────┘
```

## データモデル

すべてのデータはユーザー自身の Google Drive `appDataFolder` に保存される。`appDataFolder` は OAuth クライアント（本プロジェクト）のみがアクセスでき、ユーザーからも他のアプリからも見えない隠し領域。

### tags.json

```jsonc
{
  "version": 1,
  "updatedAt": "2026-05-09T10:23:00Z",
  "tags": [
    {
      "id": "tag_01HZ...",          // ULID
      "name": "京都旅行2024",
      "color": null,                 // 将来の色分け用
      "createdAt": "2026-05-09T10:23:00Z",
      "parentId": null               // 階層タグの予約フィールド
    }
  ]
}
```

### mappings.json

```jsonc
{
  "version": 1,
  "updatedAt": "2026-05-09T10:25:00Z",
  "items": {
    "AF1QipM4cLywWd36hqNlof-AJvvn3WhxuosvKDCJ_tvc": {
      "tagIds": ["tag_01HZ...", "tag_01HZ..."],
      "updatedAt": "2026-05-09T10:25:00Z",
      "meta": {
        "creationTime": "2026-04-27T21:58:45",
        "orientation": "portrait",
        "thumbnailUrl": "https://photos.fife.usercontent.google.com/pw/...",
        "thumbnailData": "data:image/jpeg;base64,/9j/4AAQ..."  // 96x96, ~4KB
      },
      "libraryApiId": null            // PWA で Library API を併用する場合の予約
    }
  }
}
```

写真の主キーには Google フォト Web の URL に含まれる ID（`AF1Qip` で始まる 44 文字）をそのまま使う。Photos Library API の `mediaItemId` とは別系統だが、本プロジェクトの用途では Web 側の ID で完結する。

## モジュール構成

### Chrome 拡張機能

| モジュール | 責務 |
|---|---|
| `background.js` | Service Worker。OAuth、Drive 読み書き、メモリキャッシュ、Content Script からの RPC を受ける |
| `content.js` | photos.google.com に注入される本体。DOM 監視、タグ UI、サムネイルキャッシュ、フィルター、ギャラリー |
| `content.css` | オーバーレイ・チップ・ギャラリーモーダルのスタイル |
| `options.html` / `.js` / `.css` | タグ管理画面（リネーム、統合、削除、検索、ソート） |
| `popup.html` | アイコンクリック時の小窓 |

### PWA

| モジュール | 責務 |
|---|---|
| `index.html` | エントリー、状態（loading / signin / tags / photos / error）に応じて表示切り替え |
| `app.js` | OAuth、Drive 読み取り、ユーザー情報取得、タグ・写真の描画、アカウント切り替え |
| `styles.css` | モバイル最適化されたダーク UI、セーフエリア対応 |
| `sw.js` | Service Worker（PWA インストーラビリティ要件 + シェルキャッシュ） |
| `manifest.webmanifest` | ホーム画面追加用メタデータ |
| `privacy.html` | プライバシーポリシー（OAuth 同意画面の本番化に必須） |

## OAuth スコープ

すべて非機密スコープのみで構成し、Google の検証プロセスを経ずに本番公開可能な状態にしている。

| スコープ | 利用箇所 | 内容 |
|---|---|---|
| `drive.appdata` | 拡張機能 / PWA | アプリ専用フォルダの読み書き。他のファイルは不可 |
| `openid` | PWA | OAuth 標準のユーザー識別 |
| `email` | PWA | サインイン後のアカウント表示 |
| `profile` | PWA | サインイン後のアバター・名前表示 |

機密スコープ（`drive`、`photoslibrary` など）は一切使用しない。

## 同期と競合解決

複数 PC で同時編集する可能性に備え、書き込みは debounce して 1 件のリクエストに集約。各 mapping エントリに `updatedAt` を持ち、競合時は写真ID 単位で last-write-wins。

PWA は読み取り専用のため書き込み競合は発生しない。

## なぜサーバーを持たないか

サーバーを介さない構成には次の利点がある。

- ユーザーのデータがすべて自身の Drive 内に閉じる。第三者の運営者がデータを保有しない
- 運営コストがゼロ
- スケーラビリティの心配が無い（各ユーザーの Drive が独立）
- プライバシーポリシーがシンプルになる

トレードオフとして、サーバーサイドでしかできない処理（重い集計、API キーを伴う外部連携）が必要になった時点で構成を見直す必要がある。本プロジェクトの範囲ではすべてクライアントサイドで完結する。
