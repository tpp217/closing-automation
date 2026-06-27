# CLOSING AUTO（closing-automation）

内勤締め作業の自動化システム。業務報告書・月計表・DR ファイル（Excel）を取り込み、日払い額の突合・前月差分チェック・内勤請求 Excel 出力までを 1 画面で行う。サイバーパンク UI（黒+ネオン）。

## 構成

```
closing-automation/
├── index.html          # 単一HTML（5ステップのウィザード UI）
├── css/                # スタイル
├── js/
│   ├── app.js          # 画面遷移・状態管理
│   ├── config.js
│   ├── db.js           # Supabase クライアント（スナップショット保存）
│   ├── parser-report.js  # 業務報告書パーサー
│   ├── parser-monthly.js # 月計表パーサー
│   ├── parser-dr.js      # DR距離計算フォーマットパーサー
│   ├── reconcile.js    # 日払い突合
│   ├── diff.js         # 前月差分チェック
│   ├── output.js       # 内勤請求Excel出力（書式・色・罫線を完全コピー）
│   └── utils.js
├── favicon.svg
└── vercel.json
```

ビルドステップなし。Vercel 静的配信。

## 処理フロー

1. **ファイルアップロード**: 業務報告書・月計表（必須）+ DR（任意）。ファイル名から店舗名・対象年月を自動取得
2. **委託者情報取得**: 業務報告書から業務委託者の情報を抽出
3. **日払い突合**: 業務報告書/DR の日払い額 ⇔ 月計表の取引入力を照合（OK / NG 表示）
4. **前月差分チェック**: Supabase に保存した前月スナップショットと基本給・日払い・口座情報を比較
5. **内勤請求出力**: 業務報告書・DR の個人タブをそのままコピー出力（書式・色・罫線・結合を完全保持）

## 技術スタック

- 純粋な HTML / CSS / JavaScript（フレームワーク不使用）
- Excel 操作: SheetJS（XLSX）
- 永続化: Supabase（スナップショット = 月次差分用。旧 IndexedDB から移行済み。`js/db.js` 参照）

## 注意事項

- **個人タブのコピーは書式完全一致が必須要件**: `output.js` の cell スタイル保持ロジックを壊さない
- **店舗名・年月のファイル名規約**: パーサー側で正規表現マッチしているため、命名変更時はパーサーも更新
- **スナップショットは Supabase に永続化**: 全クライアント共通で保持され、ブラウザを変えても消えない（旧 IndexedDB 版のブラウザ依存の制約は解消済み）

## 単体販売版（STANDALONE）モード

closing は 2 モードを env フラグ `STANDALONE` 1 本で住み分ける。**未設定＝プラットフォーム版（既定）で現状挙動を一切変えない**。

| 観点 | プラットフォーム版（`STANDALONE` 未設定） | 単体版（`STANDALONE=true`） |
|---|---|---|
| ログイン | wh SSO（LINE 統一・既存） | アプリ自前ログイン（Supabase Auth: email/password・`/login`） |
| 認証ゲート | wh JWT 監視ゲート（`AUTH_ENFORCE` 対応） | `closing_session`（HMAC cookie）必須＝無ければ 401 |
| テナント | wh JWT の `tenant_id` クレーム | `STANDALONE_TENANT_ID`（固定・単一顧客） |

- フラグ判定の正本は `api/_lib/app-mode.js`（`isStandalone()` / `standaloneTenantId()`）。サーバー専用。
- フロントへは `/api/auth/me` の応答に `standalone:true/false` を additive に載せて伝える。
- 単体版では `business_reports` / `*_snapshots` は固定テナントで分離され、特別な登録 UI は不要（顧客の自前データ）。
- **単体版ログイン**: `/login`（`login.html`）→ supabase-js が `signInWithPassword` → `/api/auth/standalone-login` がサーバーで token を検証し既存 `issueSession()` で `closing_session` を発行 → `evaluateAuth` の STANDALONE 分岐がその cookie を必須にする。初期ユーザーは Supabase ダッシュボードで手動作成（自動作成しない）。必要 env: `SUPABASE_URL` ＋ `SUPABASE_ANON_KEY`（公開可）。env 詳細は `.env.example` 参照。

## デプロイ

- 本番: `https://closing.utinc.dev`
- main マージで Vercel 自動デプロイ

その他 Git / Vercel / シークレット運用はグローバル `~/.claude/CLAUDE.md` に準拠。
