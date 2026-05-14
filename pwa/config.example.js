// PWA 設定ファイルのテンプレート
// 1. このファイルを `config.js` という名前にコピー
// 2. GOOGLE_CLIENT_ID を Google Cloud Console で発行した「Web 用」OAuth クライアントID に書き換える
// 3. PWA を任意の HTTPS ホスト（または localhost）で公開
//
// 詳細手順は ../06_PWA_デプロイガイド.md を参照
//
// 注意：このファイルはブラウザに公開される。クライアントIDは「Web 公開用」の前提で発行されており、
// 公開しても安全（Google の OAuth public client モデル）。クライアントシークレットは PWA では使わない。

window.PHOTO_TAGGER_CONFIG = {
  // Web 用 OAuth クライアントID（"YOUR_CLIENT_ID" のままだと設定エラーになる）
  GOOGLE_CLIENT_ID: 'YOUR_CLIENT_ID.apps.googleusercontent.com',
};
