// LINE Login コールバック。
// 1) state を Cookie と照合（CSRF 対策）
// 2) 認可コードをトークンに交換し、プロフィール（userId）を取得
// 3) ALLOWED_LINE_USER_IDS（カンマ区切り）に含まれる userId だけ許可
// 4) 許可ならセッション Cookie を発行してトップへ。未許可なら userId を提示（許可リスト登録用）
import { parseCookies, setCookie, issueSession, originOf, SESSION_COOKIE } from '../../_lib/util.js';

export default async function handler(req, res) {
  const { code, state } = req.query;
  const cookies = parseCookies(req);

  if (!code || !state || state !== cookies.line_state) {
    return res.status(400).send('認証に失敗しました（state 不一致）。再度お試しください。');
  }
  // 使い捨て state/nonce を失効
  setCookie(res, 'line_state', '', { maxAge: 0 });
  setCookie(res, 'line_nonce', '', { maxAge: 0 });

  const channelId = process.env.LINE_CHANNEL_ID;
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const redirectUri = `${originOf(req)}/api/auth/line/callback`;

  // 認可コード → アクセストークン
  const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: channelId,
      client_secret: channelSecret,
    }),
  });
  if (!tokenRes.ok) return res.status(502).send('LINE トークン交換に失敗しました。');
  const token = await tokenRes.json();

  // プロフィール取得（userId / displayName）
  const profRes = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!profRes.ok) return res.status(502).send('LINE プロフィール取得に失敗しました。');
  const profile = await profRes.json();

  const allow = (process.env.ALLOWED_LINE_USER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  if (!allow.includes(profile.userId)) {
    // 未許可。初回セットアップ用に自分の userId を表示（本人にしか見えない）。
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(403).send(
      `<meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem">` +
      `<h2>アクセス権がありません</h2>` +
      `<p>あなたの LINE userId:</p>` +
      `<pre style="background:#eee;padding:1rem;user-select:all">${profile.userId}</pre>` +
      `<p>この値を環境変数 <code>ALLOWED_LINE_USER_IDS</code> に追加すると利用できます。</p>` +
      `</body>`
    );
  }

  const sessionToken = issueSession({ uid: profile.userId, name: profile.displayName || '' });
  setCookie(res, SESSION_COOKIE, sessionToken, { maxAge: 60 * 60 * 12 });
  res.writeHead(302, { Location: '/' });
  res.end();
}
