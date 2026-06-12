// GET /api/auth/login
//
// workspace-hub のログイン画面へ誘導する SSO 入口（ランチャーを経由しない直接アクセス用）。
// ログイン成功後は /api/auth/callback に one-time code 付きで戻り、wh_token セッションが確立する。
const AUTH_ORIGIN = process.env.AUTH_EXPECTED_ISSUER || 'https://auth.utinc.dev';

export default function handler(req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/callback`;
  res.statusCode = 302;
  res.setHeader('Location', `${AUTH_ORIGIN}/login?redirect_uri=${encodeURIComponent(redirectUri)}`);
  res.end();
}
