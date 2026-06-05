// 認証状態を返す。フロントの初期ゲート用。
import { parseCookies, verifySession, SESSION_COOKIE } from '../_lib/util.js';

export default function handler(req, res) {
  const session = verifySession(parseCookies(req)[SESSION_COOKIE]);
  if (!session) return res.status(401).json({ authenticated: false });
  res.status(200).json({ authenticated: true, name: session.name || '' });
}
