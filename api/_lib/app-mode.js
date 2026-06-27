/**
 * モードフラグ（単体販売版 / プラットフォーム版の住み分け）
 *
 * closing は静的サイト + Vercel Functions（api/*.js）構成のため、本ヘルパは
 * **サーバー（api）側専用**。クライアント（ブラウザ）は env を直接読めないので、
 * /api/auth/me の応答にモードを additive に載せてフロントへ伝える（後述 me.js）。
 *
 * ── 設計の核心：完全後方互換 ──
 *   STANDALONE 未設定＝**現状のプラットフォーム挙動を一切変えない**。
 *   単体版の分岐は「ON（1/true/on/yes のいずれか）」のときだけ効く。
 *   それ以外（未設定・空・off など）はすべて false を返す＝従来ロジックに縮退。
 *
 * 環境変数:
 *   - STANDALONE            "true"/"1"/"on"/"yes" で単体版。未設定＝プラットフォーム版（既定）。
 *   - STANDALONE_TENANT_ID  単体版の固定テナント UUID。wh JWT が無くても
 *                           この値でテナント分離コードを成立させる（auth-gate.resolveTenant が参照）。
 */

/** 真値の判定（ON 系の文字列のみ true。それ以外＝未設定含む＝ false） */
function truthy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
}

/** 単体販売版か（サーバー側の正本判定） */
export function isStandalone() {
  return truthy(process.env.STANDALONE);
}

/** 単体版の固定テナント ID（未設定なら null） */
export function standaloneTenantId() {
  const v = process.env.STANDALONE_TENANT_ID;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
