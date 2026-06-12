// GET /api/auth/callback?code=...
//
// workspace-hub（auth.utinc.dev）の SSO 着地。one-time code を JWT に交換し、
// HttpOnly cookie（wh_token）としてブラウザに保持する。以後、ページの fetch に
// cookie が自動で載り、API の認証ゲート（evaluateAuth の cookie フォールバック）で
// 検証できる＝enforce 解禁の前提。検証に通らない限り cookie は一切張らない。
import { verifyToken } from '../_lib/auth-gate.js';

const AUTH_ORIGIN = process.env.AUTH_EXPECTED_ISSUER || 'https://auth.utinc.dev';
const SYSTEM_KEY = process.env.AUTH_SYSTEM_KEY || 'closing';

export default async function handler(req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = `${proto}://${host}`;

  const fail = (reason) => {
    res.statusCode = 302;
    res.setHeader('Location', `/?sso_error=${encodeURIComponent(reason)}`);
    res.end();
  };

  const code = typeof req.query?.code === 'string' ? req.query.code : '';
  if (!code) return fail('missing_code');

  const exchangeSecret = process.env.SSO_EXCHANGE_SECRET;
  if (!exchangeSecret) {
    console.warn('[sso/callback] SSO_EXCHANGE_SECRET が未設定です');
    return fail('not_configured');
  }

  // redirect_uri バインド照合用: 発行時にバインドされた「自分自身の callback URL」。
  const redirectUri = `${origin}/api/auth/callback`;

  let accessToken;
  let expiresIn = 15 * 60;
  try {
    const r = await fetch(`${AUTH_ORIGIN}/api/auth/sso/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${exchangeSecret}`,
      },
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
    });
    if (!r.ok) return fail('exchange_failed');
    const data = await r.json();
    if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
      return fail('exchange_failed');
    }
    accessToken = data.access_token;
    if (typeof data.expires_in === 'number' && data.expires_in > 0) {
      expiresIn = data.expires_in;
    }
  } catch {
    return fail('exchange_failed');
  }

  // JWKS 検証 + systems[] に自システムキーが含まれることの確認（gate と同一ロジックを共用）。
  const verified = await verifyToken(accessToken);
  if (!verified.ok) return fail('invalid_token');
  if (!verified.claims.systems.includes(SYSTEM_KEY)) return fail('system_forbidden');

  res.statusCode = 302;
  res.setHeader('Set-Cookie',
    `wh_token=${accessToken}; HttpOnly; Secure; SameSite=Lax; Max-Age=${expiresIn}; Path=/`);
  res.setHeader('Location', '/');
  res.end();
}
