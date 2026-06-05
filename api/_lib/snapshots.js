// contractor_snapshots / dr_snapshots 共通の認証付き CRUD。
// クエリ/操作は店舗・年月の限定フィルタのみ（任意 SQL は受け付けない）。
import { sbFetch, eq, requireAuth } from './util.js';

export async function handleSnapshotTable(req, res, table) {
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
