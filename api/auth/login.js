// GET /api/auth/login
//
// workspace-hub の authorize へ誘導する SSO 入口（LINE 直ログイン廃止＝SSO 一本化の唯一の入口）。
// ログイン成功後は /api/auth/callback に one-time code 付きで戻り、wh_token セッションが確立する。
const AUTH_ORIGIN = process.env.AUTH_EXPECTED_ISSUER || 'https://auth.utinc.dev';

export default function handler(req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/callback`;
  res.statusCode = 302;
  // authorize 経由: wh に 24h セッションがあれば無音で code 発行（再ログイン不要）。未ログインは /login へ流れる。
  res.setHeader('Location', `${AUTH_ORIGIN}/api/auth/sso/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`);
  res.end();
}
