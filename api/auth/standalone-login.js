// POST /api/auth/standalone-login
//
// 単体販売版（STANDALONE）専用のローカルログイン受け口。
//
// ── 流れ ──
//   1) ブラウザ（/login）が Supabase Auth（email/password）で signInWithPassword し、
//      取得した access_token（Supabase 発行の JWT）を本 API に渡す。
//   2) サーバーが access_token を Supabase の /auth/v1/user で検証する
//      （anon キーを apikey、access_token を Bearer に載せる＝Supabase 側で署名・失効を判定）。
//      検証 OK ＝本物のログイン済みユーザー。NG ＝401。
//   3) 検証に通ったら、既存の HMAC セッション基盤（issueSession）で closing_session cookie を
//      発行する＝以後 evaluateAuth（STANDALONE 分岐）がこの cookie を必須にしてアクセスを塞ぐ。
//
// ── 設計の核心：完全後方互換 ──
//   本エンドポイントは **STANDALONE=true のときだけ**機能する。
//   プラットフォーム版（STANDALONE 未設定）では即 404 を返して何もしない
//   ＝ wh SSO 経路（callback.js）に一切影響しない。
//
// ── なぜ Supabase の access_token を「ユーザーが取りに行く」のか ──
//   service_role / Supabase の JWT 秘密鍵をサーバーに置かずに本人確認するため。
//   anon キー（公開可）で signInWithPassword → サーバーは /auth/v1/user で
//   その token の正当性だけを確認する（パスワードはサーバーを通らない）。
//   anon キーが漏れても RLS と Supabase 側のレート制限で守られる（公開可キーの前提どおり）。
import { issueSession, setCookie, SESSION_COOKIE } from '../_lib/util.js';
import { isStandalone } from '../_lib/app-mode.js';

// SUPABASE_ANON_KEY を優先し、無ければ SUPABASE_PUBLISHABLE_KEY を使う（新旧キー形式の両対応）。
// いずれも公開可キー。service_role はここでは使わない（本人確認は Supabase に委ねる）。
function anonKey() {
  return process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
}

// リクエスト本文を JSON として読む（Vercel が body を未パースで渡す場合のフォールバック付き）。
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length > 0) {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  // ストリームから読む（保険）。
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  // プラットフォーム版では存在しないものとして扱う（wh SSO 経路に影響を与えない）。
  if (!isStandalone()) {
    return res.status(404).json({ error: 'not_found' });
  }

  const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
  const key = anonKey().trim();

  // GET: ログイン画面（/login）に渡す公開設定（Supabase URL ＋ anon キー）を返す。
  //   anon / publishable キーはブラウザ配信可（公開可）。service_role はここでは絶対に返さない。
  //   フロントはこの値で supabase-js クライアントを作り、signInWithPassword する。
  if (req.method === 'GET') {
    if (!supabaseUrl || !key) {
      return res.status(500).json({ error: 'サーバー設定が未完了です（SUPABASE_URL / SUPABASE_ANON_KEY）' });
    }
    return res.status(200).json({ supabase_url: supabaseUrl, anon_key: key });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST のみ' });
  }

  if (!supabaseUrl || !key) {
    console.warn('[standalone-login] SUPABASE_URL / SUPABASE_ANON_KEY が未設定です');
    return res.status(500).json({ error: 'サーバー設定が未完了です（SUPABASE_URL / SUPABASE_ANON_KEY）' });
  }

  const body = await readJsonBody(req);
  const accessToken = body && typeof body.access_token === 'string' ? body.access_token.trim() : '';
  if (!accessToken) {
    return res.status(400).json({ error: 'access_token が必要です' });
  }

  // Supabase に access_token の正当性を問い合わせる（署名・失効・取り消しを Supabase 側で判定）。
  let user;
  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!r.ok) {
      console.warn(`[standalone-login] verify_failed status=${r.status}`);
      return res.status(401).json({ error: 'ログインに失敗しました（トークンが無効です）' });
    }
    user = await r.json();
  } catch (e) {
    console.warn('[standalone-login] verify_error', e instanceof Error ? e.message : String(e));
    return res.status(502).json({ error: '認証サーバーに接続できませんでした' });
  }

  const uid = user && typeof user.id === 'string' ? user.id : '';
  if (!uid) {
    return res.status(401).json({ error: 'ログインに失敗しました（ユーザー不明）' });
  }

  // 既存 HMAC セッション基盤で closing_session を発行（プラットフォーム版と同一機構）。
  // 表示名は email を控えめに使う（無ければ空）。
  const name = user && typeof user.email === 'string' ? user.email : '';
  const sessionToken = issueSession({ uid, name });
  setCookie(res, SESSION_COOKIE, sessionToken, { maxAge: 60 * 60 * 12 });

  return res.status(200).json({ ok: true });
}
