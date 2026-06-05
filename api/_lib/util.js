// 共通ヘルパー（サーバー専用 / 依存なし）。
// - Supabase へは service_role キーで REST を直叩き（RLS バイパスはサーバー限定）。
// - セッションは SESSION_SECRET による HMAC 署名トークンを HttpOnly Cookie で保持。
// - クライアント（ブラウザ）には service_role / anon キーを一切渡さない。

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'closing_session';
const SESSION_TTL_SEC = 60 * 60 * 12; // 12時間

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が未設定です`);
  return v;
}

// ── Supabase REST（service_role） ─────────────────────────────
// path 例: "contractor_snapshots?store_name=eq.A&select=*"
export async function sbFetch(path, init = {}) {
  const url = `${env('SUPABASE_URL')}/rest/v1/${path}`;
  const key = env('SUPABASE_SERVICE_KEY');
  const res = await fetch(url, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${body.slice(0, 300)}`);
  }
  // DELETE / 一部 POST は本文なし
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// PostgREST のフィルタ値を安全にエンコードする。
export const eq = (v) => `eq.${encodeURIComponent(v)}`;

// ── セッション（HMAC 署名トークン） ──────────────────────────
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const b64uJson = (obj) => b64u(JSON.stringify(obj));

function sign(data) {
  return crypto.createHmac('sha256', env('SESSION_SECRET')).update(data).digest('base64url');
}

export function issueSession(payload) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC };
  const p = b64uJson(body);
  return `${p}.${sign(p)}`;
}

export function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [p, sig] = token.split('.');
  // 定数時間比較
  const expected = sign(p);
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const body = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!body.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

// ── Cookie ───────────────────────────────────────────────────
export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > -1) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

export function setCookie(res, name, value, { maxAge, httpOnly = true } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'Secure',
    'SameSite=Lax',
  ];
  if (httpOnly) parts.push('HttpOnly');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(parts.join('; '));
  res.setHeader('Set-Cookie', list);
}

// ── 認証ガード ───────────────────────────────────────────────
// 認証済みならセッション本体を返す。未認証なら 401 を返して null。
export function requireAuth(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const session = verifySession(token);
  if (!session) {
    res.status(401).json({ error: 'unauthenticated' });
    return null;
  }
  return session;
}

// ── リクエスト元オリジン（LINE redirect_uri 組み立て用） ─────
export function originOf(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
