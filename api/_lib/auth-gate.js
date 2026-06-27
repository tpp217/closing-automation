/**
 * 認証ゲート（監視モード対応）
 *
 * workspace-hub（auth.utinc.dev）が発行する JWT（RS256）を JWKS で検証する共通ヘルパ。
 * Vercel Functions（api/*.js）から import して、業務データ系エンドポイントの先頭で使う。
 *
 * ── 設計の核心：既定では「監視のみ」でブロックしない ──
 *   - 既定（AUTH_ENFORCE 未設定 / "off"）では、トークンの有無・検証可否を
 *     console に記録するだけで、リクエストは常に通す（現挙動を一切変えない）。
 *   - AUTH_ENFORCE=on のときだけ、検証失敗 / トークン欠如 / 対象システム不一致を
 *     401 / 403 でブロックする。
 *
 * ── 既存の LINE SSO セッション（SESSION_SECRET の HMAC Cookie）とは独立・併存 ──
 *   - このゲートは Authorization: Bearer の JWT を見るだけで、
 *     api/auth/* のログインフローや requireAuth（Cookie 認証）には一切触れない。
 *   - enforce を on にする前に、workspace-hub 側で当該テナントの system_access に
 *     system_key='closing'（= AUTH_SYSTEM_KEY 既定値）が付与されているかを必ず確認すること。
 *     一致しないと enforce 時に 403 で全業務 API が落ちる。
 *
 * 環境変数:
 *   - JWKS_URL            JWKS エンドポイント（既定 https://auth.utinc.dev/.well-known/jwks.json）
 *   - AUTH_EXPECTED_ISSUER 期待する発行者 iss（既定 https://auth.utinc.dev）。
 *                         署名検証に加えて iss 照合を行い、別 issuer のなりすましを弾く。
 *   - AUTH_ENFORCE    "on" でブロック有効化。それ以外（未設定含む）は監視のみ
 *   - AUTH_SYSTEM_KEY 自アプリのシステムキー（既定 "closing"）。
 *                     enforce 時、JWT の systems[] にこのキーが含まれるかを検証。
 *                     workspace-hub の SYSTEM_CATALOG / system_access.system_key と一致が必要。
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { isStandalone, standaloneTenantId } from './app-mode.js';
import { verifySession, SESSION_COOKIE } from './util.js';

const DEFAULT_JWKS_URL = 'https://auth.utinc.dev/.well-known/jwks.json';
const DEFAULT_SYSTEM_KEY = 'closing';
// workspace-hub の JWT は iss = "https://auth.utinc.dev" 固定。なりすまし二重防御として照合する。
const DEFAULT_ISSUER = 'https://auth.utinc.dev';

/** 期待する発行者（iss）。既定値で運用するため通常は環境変数の設定不要。 */
function expectedIssuer() {
  return process.env.AUTH_EXPECTED_ISSUER || DEFAULT_ISSUER;
}

/** enforce が有効か（"on" のときだけ true） */
export function isEnforcing() {
  return String(process.env.AUTH_ENFORCE || '').toLowerCase() === 'on';
}

/** 自アプリのシステムキー */
function systemKey() {
  return process.env.AUTH_SYSTEM_KEY || DEFAULT_SYSTEM_KEY;
}

// JWKS は遅延生成してプロセス内でキャッシュ（jose が内部で鍵をキャッシュ／更新する）
let _jwks = null;
function getJWKS() {
  if (!_jwks) {
    const url = process.env.JWKS_URL || DEFAULT_JWKS_URL;
    _jwks = createRemoteJWKSet(new URL(url));
  }
  return _jwks;
}

/** Authorization: Bearer <token> からトークンを取り出す（無ければ null） */
/** Cookie ヘッダから wh_token を取り出す（無ければ null）。SSO callback が張る HttpOnly cookie。 */
function extractWhTokenCookie(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'wh_token' && rest.length > 0) {
      const v = rest.join('=').trim();
      if (v.length > 0) return v;
    }
  }
  return null;
}

function extractBearer(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Cookie ヘッダ文字列から任意の cookie 値を取り出す（無ければ null）。URL デコード込み。 */
function extractCookie(cookieHeader, name) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      if (v.length > 0) { try { return decodeURIComponent(v); } catch { return v; } }
    }
  }
  return null;
}

/**
 * JWT を検証してクレームを取り出す。
 * 成功: { ok:true, claims:{ tenant_id, level, capabilities, systems } }
 * 失敗: { ok:false, reason }
 */
export async function verifyToken(token) {
  try {
    const { payload } = await jwtVerify(token, getJWKS(), { issuer: expectedIssuer() });
    return {
      ok: true,
      claims: {
        tenant_id:    payload.tenant_id ?? null,
        level:        payload.level ?? null,
        capabilities: Array.isArray(payload.capabilities) ? payload.capabilities : [],
        systems:      Array.isArray(payload.systems) ? payload.systems : [],
        sub:          payload.sub ?? null,
        line_user_id: payload.line_user_id ?? null,
        // 表示用 additive claim（workspace-hub が付与）。下流は読むだけ。
        //   is_demo:     デモ/テスト用テナント（auth_core.tenants.is_demo）なら true。
        //                フロントのモック/サンプル表示の出し分けヒント（認可境界ではない）。
        //   name:        本人氏名 / tenant_name: テナント名 / department: 主所属の部署名。
        is_demo:      typeof payload.is_demo === 'boolean' ? payload.is_demo : false,
        name:         typeof payload.name === 'string' ? payload.name : null,
        tenant_name:  typeof payload.tenant_name === 'string' ? payload.tenant_name : null,
        department:   typeof payload.department === 'string' ? payload.department : null,
      },
    };
  } catch (e) {
    return { ok: false, reason: e && e.code ? e.code : (e && e.message) || 'verify_failed' };
  }
}

/**
 * リクエストを評価し、必要なら 401/403 を返す。
 *
 * @param {object} args
 * @param {string} args.authHeader  Authorization ヘッダ値
 * @param {string} args.method      HTTP メソッド（ログ用）
 * @param {string} args.path        パス（ログ用）
 * @returns {Promise<{ allowed:boolean, status?:number, body?:object, claims?:object }>}
 *   - allowed:true  → 通す（監視モードでは常にこちら。enforce 時も検証成功ならこちら）
 *   - allowed:false → 呼び出し側で status/body を返してブロック（enforce 時のみ発生）
 */
export async function evaluateAuth({ authHeader, cookieHeader, method = '', path = '' } = {}) {
  // 単体販売版（STANDALONE=true）: wh SSO/JWT が存在しない運用のため、wh JWT 監視ゲートは使わず、
  // 自前のローカルログインで発行した closing_session（HMAC cookie）を必須にしてアクセスを塞ぐ。
  //   - closing_session が有効 → 通す（allowed:true）。
  //   - 無い / 失効 / 改竄 → 401 でブロック（フロントは 401 を見て /login へ誘導）。
  // 認可（本人確認）はローカルログイン（/api/auth/standalone-login）、テナント分離は
  // resolveTenant の固定テナント（STANDALONE_TENANT_ID）に委ねる。
  // ※プラットフォーム版（STANDALONE 未設定）はこの分岐に入らず従来どおり＝挙動不変。
  if (isStandalone()) {
    const tag = `[auth-gate][STANDALONE] ${method} ${path}`;
    const session = verifySession(extractCookie(cookieHeader, SESSION_COOKIE));
    if (!session) {
      console.warn(`${tag} no_local_session`);
      return { allowed: false, status: 401, body: { error: 'ログインが必要です' } };
    }
    return { allowed: true };
  }
  const enforce = isEnforcing();
  // ヘッダ優先・無ければ SSO ログイン済みブラウザの wh_token cookie（フロント変更不要で認証が通る）。
  const token = extractBearer(authHeader) ?? extractWhTokenCookie(cookieHeader);
  const tag = `[auth-gate]${enforce ? '[ENFORCE]' : '[monitor]'} ${method} ${path}`;

  // トークン無し
  if (!token) {
    console.warn(`${tag} no_bearer_token`);
    if (enforce) {
      return { allowed: false, status: 401, body: { error: '認証が必要です（Bearer トークン未提供）' } };
    }
    return { allowed: true }; // 監視モード: 素通り
  }

  // 検証
  const result = await verifyToken(token);
  if (!result.ok) {
    console.warn(`${tag} verify_failed reason=${result.reason}`);
    if (enforce) {
      return { allowed: false, status: 401, body: { error: 'トークンの検証に失敗しました' } };
    }
    return { allowed: true }; // 監視モード: 素通り
  }

  const { claims } = result;

  // systems[] に自アプリが含まれるか（enforce 時のみ判定）
  const key = systemKey();
  const hasSystem = claims.systems.includes(key);
  if (!hasSystem) {
    console.warn(`${tag} system_not_authorized key=${key} tenant=${claims.tenant_id} systems=${JSON.stringify(claims.systems)}`);
    if (enforce) {
      return { allowed: false, status: 403, body: { error: 'このシステムへのアクセス権がありません' }, claims };
    }
    // 監視モード: 記録だけして素通り
    return { allowed: true, claims };
  }

  console.info(`${tag} ok tenant=${claims.tenant_id} level=${claims.level}`);
  return { allowed: true, claims };
}

/**
 * Vercel / Node の res に対してブロック応答を書く小ヘルパ。
 * （allowed:false のときだけ呼ぶ想定）
 */
export function sendBlock(res, evalResult) {
  res.status(evalResult.status || 401).json(evalResult.body || { error: 'unauthorized' });
}

/**
 * テナント分離のための tenant_id 解決（enforce とは独立・常時有効）。
 *
 * ── なぜ evaluateAuth と分けるのか ──
 *   evaluateAuth は監視モード（AUTH_ENFORCE 未設定）では token 不正でも allowed:true を返す。
 *   しかしテナント分離は「クロステナント漏洩を防ぐ」セキュリティ要件であり、
 *   enforce フラグの ON/OFF に関係なく**常に**有効でなければならない。
 *   そのため永続業務テーブルを触る API は、enforce の手前で本関数により
 *   有効な tenant_id を必ず取得し、取れなければ **fail-closed**（401）でブロックする。
 *
 * トークン取得元は evaluateAuth と同じ（Authorization: Bearer 優先、無ければ wh_token cookie）。
 *
 * @returns {Promise<{ ok:true, tenantId:string } | { ok:false, status:number, body:object }>}
 */
export async function resolveTenant({ authHeader, cookieHeader } = {}) {
  // 単体販売版: wh JWT が無く tenant_id クレームを取得できないため、env の固定テナントで
  // 分離コードを成立させる（単一顧客＝1 テナント）。STANDALONE_TENANT_ID 未設定なら
  // fail-closed（誤って全テナント横断を許さない）。
  // ※プラットフォーム版（STANDALONE 未設定）はこの分岐に入らず従来どおり＝挙動不変。
  if (isStandalone()) {
    const tid = standaloneTenantId();
    if (!tid) {
      return { ok: false, status: 500, body: { error: '単体版のテナントが未設定です（STANDALONE_TENANT_ID）' } };
    }
    return { ok: true, tenantId: tid };
  }
  const token = extractBearer(authHeader) ?? extractWhTokenCookie(cookieHeader);
  if (!token) {
    return { ok: false, status: 401, body: { error: 'テナントを特定できません（認証トークン未提供）' } };
  }
  const result = await verifyToken(token);
  if (!result.ok) {
    return { ok: false, status: 401, body: { error: 'テナントを特定できません（トークン検証失敗）' } };
  }
  const tenantId = result.claims.tenant_id;
  if (!tenantId || typeof tenantId !== 'string' || tenantId.trim() === '') {
    return { ok: false, status: 403, body: { error: 'テナントが未設定のトークンです' } };
  }
  return { ok: true, tenantId: tenantId.trim() };
}
