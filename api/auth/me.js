// 認証状態を返す。フロントの初期ゲート用。
//
// 二層で認証を見る:
//   1) 自前セッション（closing_session）の有無 → ログイン済み判定（従来どおり）。
//   2) workspace-hub の wh_token cookie（あれば auth-gate で JWKS 検証）
//      → is_demo / 氏名 / テナント名 / 部署 を additive に返す（表示用）。
//
// wh_token が無い / 検証失敗でも、自前セッションが有効なら 200（identity は空のまま）。
// どちらも無ければ 401（従来どおりログインへ誘導）。
import { parseCookies, verifySession, SESSION_COOKIE } from '../_lib/util.js';
import { verifyToken } from '../_lib/auth-gate.js';
import { isStandalone } from '../_lib/app-mode.js';

export default async function handler(req, res) {
  const cookies = parseCookies(req);
  const session = verifySession(cookies[SESSION_COOKIE]);

  // 単体販売版（STANDALONE=true）: wh SSO を使わない。フロントがログイン導線を
  // 自前側へ向けられるよう、応答に standalone:true を additive に載せる。
  // ※単体版の自前ログインは未整備（要実装）。整備されるまでは fail-open で 200 を返し、
  //   フロントの SSO リダイレクト（/api/auth/login=SSO）を抑止する（誤って SSO へ飛ばさない）。
  //   自前ログイン実装後は、ここを「session 必須 → 無ければ 401」に締めること。
  if (isStandalone()) {
    return res.status(200).json({
      authenticated: !!session,
      standalone: true,
      name: (session && session.name) || '',
      is_demo: false,
      tenant_name: '',
      department: '',
    });
  }

  // workspace-hub JWT（wh_token cookie）があれば検証して表示用 claim を取り出す。
  // 失敗・未提供は identity 空のまま続行（自前セッションが正なら 200）。
  let identity = { is_demo: false, name: '', tenant_name: '', department: '' };
  const whToken = cookies['wh_token'];
  if (whToken) {
    const verified = await verifyToken(whToken);
    if (verified.ok) {
      const c = verified.claims;
      identity = {
        is_demo: c.is_demo === true,
        name: c.name || '',
        tenant_name: c.tenant_name || '',
        department: c.department || '',
      };
    }
  }

  // 自前セッションも wh_token も無ければ未認証。
  if (!session && !whToken) {
    return res.status(401).json({ authenticated: false });
  }

  res.status(200).json({
    authenticated: true,
    standalone: false, // プラットフォーム版（既定）。フロントが常にこのフィールドを読めるよう明示。
    // 氏名は wh の表示用 claim を優先し、無ければ自前セッションの name。
    name: identity.name || (session && session.name) || '',
    is_demo: identity.is_demo,
    tenant_name: identity.tenant_name,
    department: identity.department,
  });
}
