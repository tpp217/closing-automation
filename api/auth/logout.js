// ログアウト。セッション Cookie を失効させてトップへ。
import { setCookie, SESSION_COOKIE } from '../_lib/util.js';

export default function handler(req, res) {
  setCookie(res, SESSION_COOKIE, '', { maxAge: 0 });
  res.writeHead(302, { Location: '/' });
  res.end();
}
