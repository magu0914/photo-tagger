# セットアップ

ローカル環境で開発・動作確認するための手順。

## 1. Google Cloud Console の準備

### プロジェクト作成

[Google Cloud Console](https://console.cloud.google.com/) で新規プロジェクトを作成する。プロジェクト名は任意（例：`Photo Tagger`）。

### API を有効化

「APIs & Services」→「Library」で以下を有効化する。

- Google Drive API

Photos Library API は本プロジェクトでは使用しないので有効化不要。

### OAuth 同意画面の設定

「APIs & Services」→「OAuth consent screen」で次のように設定する。

| 項目 | 値 |
|---|---|
| User Type | External |
| アプリ名 | `Photo Tagger`（**`Google` や `Photos` などの単語は使えない**） |
| ユーザーサポートメール | 自分のメール |
| デベロッパー連絡先 | 自分のメール |

スコープには次の 4 つを追加する。すべて非機密スコープ。

```
https://www.googleapis.com/auth/drive.appdata
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
```

開発中はテストユーザーに自分のアカウントを登録しておく。

### OAuth クライアント ID の発行

「APIs & Services」→「Credentials」で 2 種類のクライアント ID を発行する。

#### Chrome 拡張機能用

| 項目 | 値 |
|---|---|
| Application type | Chrome 拡張機能 |
| Item ID | 拡張機能の ID（後述、拡張機能をローカルで読み込んだ後に取得） |

#### Web アプリ（PWA）用

| 項目 | 値 |
|---|---|
| Application type | Web application |
| Authorized JavaScript origins | `http://localhost:8080` |
| Authorized redirect URIs | （不要） |

発行された各クライアント ID は後で使う。

## 2. Chrome 拡張機能のインストール

1. Chrome（または Edge）で `chrome://extensions/` を開く
2. 右上の「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」をクリック → このリポジトリの `extension/` フォルダを選択
4. 拡張機能の **ID（32 文字のランダム英字）** をコピー
5. Cloud Console に戻り、Chrome 拡張機能用クライアント ID の Item ID にこの値を貼り付け

`extension/manifest.json` の `oauth2.client_id` を発行されたクライアント ID に書き換える。

```json
{
  "oauth2": {
    "client_id": "xxxxxxxxxxx.apps.googleusercontent.com",
    "scopes": ["https://www.googleapis.com/auth/drive.appdata"]
  }
}
```

`chrome://extensions/` で更新ボタンを押すと反映される。

### 動作確認

1. `https://photos.google.com/` を開く
2. 任意の写真を 1 枚クリックして詳細画面へ
3. 画面右下にオーバーレイが現れ、タグ入力欄が表示される
4. タグ名を入力 → Enter → チップが追加されれば成功

初回のみ OAuth の同意ダイアログがポップアップする。

## 3. PWA のローカル起動

### 設定ファイルの作成

`pwa/config.example.js` を `pwa/config.js` という名前でコピーし、Web アプリ用クライアント ID を埋める。

```javascript
window.PHOTO_TAGGER_CONFIG = {
  GOOGLE_CLIENT_ID: 'xxxxxxxxxxx.apps.googleusercontent.com',
};
```

### ローカルサーバー起動

PWA は HTTPS または `http://localhost` でしか動作しない（OAuth の制約）。`pwa/` ディレクトリで次のいずれかを実行する。

```bash
# Python（Windows 標準でない場合は Microsoft Store からインストール可）
python -m http.server --bind 127.0.0.1 8080

# Node.js
npx http-server -p 8080

# PHP
php -S localhost:8080
```

ブラウザで `http://localhost:8080/` を開くと PWA が表示される。

### 動作確認

1. 「Google でサインイン」をクリック
2. アカウント選択 → 同意（テストユーザーに登録したアカウントのみ可）
3. タグ一覧が表示される（PC で付けたタグが反映されているはず）
4. タグをクリック → そのタグの写真がサムネイル付きでグリッド表示
5. 写真をクリック → Google フォトの該当写真ページが新しいタブで開く

## 4. トラブルシューティング

| 症状 | 確認ポイント |
|---|---|
| 拡張機能の OAuth で `OAuth2 not granted or revoked` | OAuth 同意画面のテストユーザーに自分のアカウントが登録されているか |
| 拡張機能の OAuth で `bad client id` | manifest.json の `oauth2.client_id` と Cloud Console の Item ID（拡張機能 ID）が一致しているか |
| PWA の OAuth で `redirect_uri_mismatch` | Authorized JavaScript origins が `http://localhost:8080`（末尾スラッシュなし）になっているか |
| サムネイルが表示されない | PC 拡張機能側で photos.google.com を開き、該当写真までスクロールして自動キャッシュを走らせる |
| 詳細画面でタグ UI が出ない | 古いコードが Service Worker にキャッシュされている可能性。`chrome://extensions/` で拡張機能をリロード |
