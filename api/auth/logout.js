// ログアウト。セッション Cookie を失効させて入口へ戻す。
//   - closing_session（自前 HMAC セッション。両モード共通）を必ず失効。
//   - wh_token（プラットフォーム版の SSO ゲート cookie）も失効（単体版では未設定なので無害）。
// 遷移先: 単体版は /login（自前ログイン）、プラットフォーム版は / （従来どおり＝me 401→SSO 誘導）。
import { setCookie, SESSION_COOKIE } from '../_lib/util.js';
import { isStandalone } from '../_lib/app-mode.js';

export default function handler(req, res) {
  setCookie(res, SESSION_COOKIE, '', { maxAge: 0 });
  setCookie(res, 'wh_token', '', { maxAge: 0 });
  res.writeHead(302, { Location: isStandalone() ? '/login' : '/' });
  res.end();
}
