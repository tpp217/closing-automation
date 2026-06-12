// contractor_snapshots / dr_snapshots 共通の認証付き CRUD。
// クエリ/操作は店舗・年月の限定フィルタのみ（任意 SQL は受け付けない）。
// この共通ハンドラは snapshots.js / dr-snapshots.js の両 api/*.js から呼ばれるため、
// JWT 認証ゲートをここに一度だけ置けば両エンドポイントの先頭をカバーできる。
import { sbFetch, eq, requireAuth } from './util.js';
import { evaluateAuth, sendBlock } from './auth-gate.js';

export async function handleSnapshotTable(req, res, table) {
  // workspace-hub JWT 認証ゲート（既定は監視のみ・非破壊 / AUTH_ENFORCE=on でブロック）。
  // 既存の LINE SSO セッション（requireAuth）とは独立・併存。
  const gate = await evaluateAuth({
    authHeader: req.headers.authorization,
    cookieHeader: req.headers.cookie,
    method: req.method,
    path: `/api/${table === 'dr_snapshots' ? 'dr-snapshots' : 'snapshots'}`,
  });
  if (!gate.allowed) return sendBlock(res, gate);

  if (!requireAuth(req, res)) return;
  try {
    if (req.method === 'GET') {
      const { store, period, all, periods } = req.query;
      let rows;
      if (all) rows = await sbFetch(`${table}?select=*`);
      else if (periods) rows = await sbFetch(`${table}?select=store_name,period_ym`);
      else if (store && period)
        rows = await sbFetch(`${table}?store_name=${eq(store)}&period_ym=${eq(period)}&select=*`);
      else return res.status(400).json({ error: 'store と period、または all/periods が必要です' });
      return res.status(200).json(rows || []);
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (body.deleteAll) {
        await sbFetch(`${table}?id=gt.0`, { method: 'DELETE' });
        return res.status(200).json({ ok: true });
      }
      const { storeName, periodYm, rows = [] } = body;
      if (!storeName || !periodYm) return res.status(400).json({ error: 'storeName / periodYm が必要です' });
      // 同店舗・同年月を上書き（delete → insert）
      await sbFetch(`${table}?store_name=${eq(storeName)}&period_ym=${eq(periodYm)}`, { method: 'DELETE' });
      if (rows.length > 0) {
        await sbFetch(table, {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(rows),
        });
      }
      return res.status(200).json({ ok: true, count: rows.length });
    }

    if (req.method === 'DELETE') {
      const { store, period, all } = req.query;
      if (all) await sbFetch(`${table}?id=gt.0`, { method: 'DELETE' });
      else if (store && period)
        await sbFetch(`${table}?store_name=${eq(store)}&period_ym=${eq(period)}`, { method: 'DELETE' });
      else return res.status(400).json({ error: 'store と period、または all が必要です' });
      return res.status(200).json({ ok: true });
    }

    res.status(405).json({ error: 'Method Not Allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
