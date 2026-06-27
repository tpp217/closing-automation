// 業務報告データ（business_reports）API。tenant_id+store_name+period_ym で upsert。
import { sbFetch, eq, requireAuth } from './_lib/util.js';
import { evaluateAuth, sendBlock, resolveTenant } from './_lib/auth-gate.js';

const TABLE = 'business_reports';

export default async function handler(req, res) {
  // workspace-hub JWT 認証ゲート（既定は監視のみ・非破壊 / AUTH_ENFORCE=on でブロック）。
  // 既存の LINE SSO セッション（requireAuth）とは独立・併存。
  const gate = await evaluateAuth({
    authHeader: req.headers.authorization,
    cookieHeader: req.headers.cookie,
    method: req.method,
    path: '/api/business-report',
  });
  if (!gate.allowed) return sendBlock(res, gate);

  if (!requireAuth(req, res)) return;

  // テナント分離（enforce とは独立・常時有効）。tenant 未解決は fail-closed。
  const tenant = await resolveTenant({
    authHeader: req.headers.authorization,
    cookieHeader: req.headers.cookie,
  });
  if (!tenant.ok) return res.status(tenant.status).json(tenant.body);
  const tenantId = tenant.tenantId;

  try {
    if (req.method === 'GET') {
      const { store, period } = req.query;
      if (!store || !period) return res.status(400).json({ error: 'store / period が必要です' });
      const rows = await sbFetch(
        `${TABLE}?tenant_id=${eq(tenantId)}&store_name=${eq(store)}&period_ym=${eq(period)}&select=*&limit=1`,
      );
      return res.status(200).json((rows && rows[0]) || null);
    }

    if (req.method === 'POST') {
      // クライアント由来の tenant_id は信用せず、JWT 由来の値で上書きする。
      const row = { ...(req.body || {}), tenant_id: tenantId };
      if (!row.store_name || !row.period_ym) return res.status(400).json({ error: 'store_name / period_ym が必要です' });
      await sbFetch(`${TABLE}?on_conflict=tenant_id,store_name,period_ym`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { store, period } = req.query;
      if (!store || !period) return res.status(400).json({ error: 'store / period が必要です' });
      await sbFetch(
        `${TABLE}?tenant_id=${eq(tenantId)}&store_name=${eq(store)}&period_ym=${eq(period)}`,
        { method: 'DELETE' },
      );
      return res.status(200).json({ ok: true });
    }

    res.status(405).json({ error: 'Method Not Allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
