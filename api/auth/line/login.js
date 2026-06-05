// LINE Login の認可エンドポイントへリダイレクトする。
// state / nonce を短命 HttpOnly Cookie に保存し、callback で CSRF 検証する。
import crypto from 'node:crypto';
import { setCookie, originOf } from '../../_lib/util.js';

export default function handler(req, res) {
  const channelId = process.env.LINE_CHANNEL_ID;
  if (!channelId) return res.status(500).json({ error: 'LINE_CHANNEL_ID 未設定' });

  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  setCookie(res, 'line_state', state, { maxAge: 600 });
  setCookie(res, 'line_nonce', nonce, { maxAge: 600 });

  const redirectUri = `${originOf(req)}/api/auth/line/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: channelId,
    redirect_uri: redirectUri,
    state,
    scope: 'profile openid',
    nonce,
  });
  res.writeHead(302, { Location: `https://access.line.me/oauth2/v2.1/authorize?${params}` });
  res.end();
}
