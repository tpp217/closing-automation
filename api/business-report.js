// 業務報告データ（business_reports）API。store_name+period_ym で upsert。
import { sbFetch, eq, requireAuth } from './_lib/util.js';
import { evaluateAuth, sendBlock } from './_lib/auth-gate.js';

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
  try {
    if (req.method === 'GET') {
      const { store, period } = req.query;
      if (!store || !period) return res.status(400).json({ error: 'store / period が必要です' });
      const rows = await sbFetch(`${TABLE}?store_name=${eq(store)}&period_ym=${eq(period)}&select=*&limit=1`);
      return res.status(200).json((rows && rows[0]) || null);
    }

    if (req.method === 'POST') {
      const row = req.body || {};
      if (!row.store_name || !row.period_ym) return res.status(400).json({ error: 'store_name / period_ym が必要です' });
      await sbFetch(`${TABLE}?on_conflict=store_name,period_ym`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { store, period } = req.query;
      if (!store || !period) return res.status(400).json({ error: 'store / period が必要です' });
      await sbFetch(`${TABLE}?store_name=${eq(store)}&period_ym=${eq(period)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    res.status(405).json({ error: 'Method Not Allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
