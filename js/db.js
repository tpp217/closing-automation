/**
 * db.js - Table API ラッパー（スナップショット保存/取得）
 * 
 * 保存形式：
 * - テーブル名: contractor_snapshots
 *   フィールド: store_name, period_ym, person_key, person_name, basic_pay_man,
 *               daily_pay_yen, bank_name, branch_name, account_type, account_number,
 *               account_holder_kana, warnings_json
 */

'use strict';

const DB_TABLE = 'contractor_snapshots';

/**
 * スナップショットをAPIに保存
 * @param {Array} contractors - 委託者情報の配列
 * @param {string} storeName
 * @param {string} periodYm - YYYY-MM
 */
async function saveSnapshot(contractors, storeName, periodYm) {
  // 既存レコードを削除してから新規保存
  try {
    await deleteSnapshotsByStorePeriod(storeName, periodYm);
  } catch (e) {
    console.warn('既存スナップショット削除失敗:', e);
  }

  for (const c of contractors) {
    const row = {
      store_name: storeName,
      period_ym: periodYm,
      person_key: normalizePersonName(c.name),
      person_name: c.name,
      basic_pay_man: c.basicPayMan ?? 0,
      daily_pay_yen: c.dailyPayYen ?? 0,
      bank_name: c.bank?.bankName ?? '',
      branch_name: c.bank?.branchName ?? '',
      account_type: c.bank?.accountType ?? '',
      account_number: c.bank?.accountNumber ?? '',
      account_holder_kana: c.bank?.accountHolderKana ?? '',
      warnings_json: JSON.stringify(c.warnings ?? [])
    };
    try {
      await fetch(`tables/${DB_TABLE}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row)
      });
    } catch (e) {
      console.error('スナップショット保存エラー:', e);
    }
  }
}

/**
 * 指定店舗・年月のスナップショットを取得
 * @returns {Array} contractors
 */
async function getSnapshot(storeName, periodYm) {
  try {
    const res = await fetch(
      `tables/${DB_TABLE}?search=${encodeURIComponent(storeName)}&limit=200`
    );
    if (!res.ok) return [];
    const json = await res.json();
    const rows = (json.data || []).filter(r =>
      r.store_name === storeName && r.period_ym === periodYm
    );
    return rows.map(r => ({
      name: r.person_name,
      personKey: r.person_key,
      basicPayMan: Number(r.basic_pay_man ?? 0),
      dailyPayYen: Number(r.daily_pay_yen ?? 0),
      bank: {
        bankName: r.bank_name ?? '',
        branchName: r.branch_name ?? '',
        accountType: r.account_type ?? '',
        accountNumber: r.account_number ?? '',
        accountHolderKana: r.account_holder_kana ?? ''
      },
      warnings: JSON.parse(r.warnings_json || '[]')
    }));
  } catch (e) {
    console.error('スナップショット取得エラー:', e);
    return [];
  }
}

/**
 * 指定店舗・年月の直近前月のスナップショットを取得
 */
async function getPrevSnapshot(storeName, periodYm) {
  // periodYm = YYYY-MM から前月を計算
  const [year, month] = periodYm.split('-').map(Number);
  let prevYear = year, prevMonth = month - 1;
  if (prevMonth < 1) { prevMonth = 12; prevYear--; }
  const prevPeriod = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
  return getSnapshot(storeName, prevPeriod);
}

/**
 * 指定店舗・年月のスナップショットを削除
 */
async function deleteSnapshotsByStorePeriod(storeName, periodYm) {
  try {
    const res = await fetch(
      `tables/${DB_TABLE}?search=${encodeURIComponent(storeName)}&limit=200`
    );
    if (!res.ok) return;
    const json = await res.json();
    const targets = (json.data || []).filter(r =>
      r.store_name === storeName && r.period_ym === periodYm
    );
    for (const r of targets) {
      await fetch(`tables/${DB_TABLE}/${r.id}`, { method: 'DELETE' });
    }
  } catch (e) {
    console.warn('削除エラー:', e);
  }
}

/**
 * 全スナップショットを削除（リセット用）
 */
async function deleteAllSnapshots() {
  try {
    let page = 1;
    while (true) {
      const res = await fetch(`tables/${DB_TABLE}?page=${page}&limit=100`);
      if (!res.ok) break;
      const json = await res.json();
      const rows = json.data || [];
      if (rows.length === 0) break;
      for (const r of rows) {
        await fetch(`tables/${DB_TABLE}/${r.id}`, { method: 'DELETE' });
      }
      if (rows.length < 100) break;
      page++;
    }
  } catch (e) {
    console.error('全削除エラー:', e);
  }
}

// ============================================================
// DR スナップショット（dr_snapshots テーブル）
// ============================================================

const DR_DB_TABLE = 'dr_snapshots';

/**
 * DRリストをスナップショットとして保存
 * @param {Array} drList  - parseDR() の結果
 * @param {string} storeName
 * @param {string} periodYm - YYYY-MM
 */
async function saveDRSnapshot(drList, storeName, periodYm) {
  try {
    await deleteDRSnapshotsByStorePeriod(storeName, periodYm);
  } catch (e) {
    console.warn('既存DRスナップショット削除失敗:', e);
  }

  for (const dr of drList) {
    const row = {
      store_name: storeName,
      period_ym: periodYm,
      person_key: getDRKey(dr.name),
      person_name: dr.name,
      sheet_name: dr.sheetName ?? '',
      driver_reward: dr.driverReward ?? 0,
      karibara_yen: dr.karibaraiYen ?? 0,
      total_amount: dr.totalAmount ?? 0,
      bank_name: dr.bank?.bankName ?? '',
      branch_name: dr.bank?.branchName ?? '',
      account_type: dr.bank?.accountType ?? '',
      account_number: dr.bank?.accountNumber ?? '',
      account_holder_kana: dr.bank?.accountHolderKana ?? ''
    };
    try {
      await fetch(`tables/${DR_DB_TABLE}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row)
      });
    } catch (e) {
      console.error('DRスナップショット保存エラー:', e);
    }
  }
}

/**
 * 指定店舗・年月のDRスナップショットを取得
 */
async function getDRSnapshot(storeName, periodYm) {
  try {
    const res = await fetch(
      `tables/${DR_DB_TABLE}?search=${encodeURIComponent(storeName)}&limit=200`
    );
    if (!res.ok) return [];
    const json = await res.json();
    const rows = (json.data || []).filter(r =>
      r.store_name === storeName && r.period_ym === periodYm
    );
    return rows.map(r => ({
      name: r.person_name,
      personKey: r.person_key,
      sheetName: r.sheet_name,
      driverReward: Number(r.driver_reward ?? 0),
      karibaraiYen: Number(r.karibara_yen ?? 0),
      totalAmount: Number(r.total_amount ?? 0),
      bank: {
        bankName: r.bank_name ?? '',
        branchName: r.branch_name ?? '',
        accountType: r.account_type ?? '',
        accountNumber: r.account_number ?? '',
        accountHolderKana: r.account_holder_kana ?? ''
      }
    }));
  } catch (e) {
    console.error('DRスナップショット取得エラー:', e);
    return [];
  }
}

/**
 * 指定店舗・年月の直近前月DRスナップショットを取得
 */
async function getPrevDRSnapshot(storeName, periodYm) {
  const [year, month] = periodYm.split('-').map(Number);
  let prevYear = year, prevMonth = month - 1;
  if (prevMonth < 1) { prevMonth = 12; prevYear--; }
  const prevPeriod = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
  return getDRSnapshot(storeName, prevPeriod);
}

/**
 * 指定店舗・年月のDRスナップショットを削除
 */
async function deleteDRSnapshotsByStorePeriod(storeName, periodYm) {
  try {
    const res = await fetch(
      `tables/${DR_DB_TABLE}?search=${encodeURIComponent(storeName)}&limit=200`
    );
    if (!res.ok) return;
    const json = await res.json();
    const targets = (json.data || []).filter(r =>
      r.store_name === storeName && r.period_ym === periodYm
    );
    for (const r of targets) {
      await fetch(`tables/${DR_DB_TABLE}/${r.id}`, { method: 'DELETE' });
    }
  } catch (e) {
    console.warn('DR削除エラー:', e);
  }
}

/**
 * 全DRスナップショットを削除（リセット用）
 */
async function deleteAllDRSnapshots() {
  try {
    let page = 1;
    while (true) {
      const res = await fetch(`tables/${DR_DB_TABLE}?page=${page}&limit=100`);
      if (!res.ok) break;
      const json = await res.json();
      const rows = json.data || [];
      if (rows.length === 0) break;
      for (const r of rows) {
        await fetch(`tables/${DR_DB_TABLE}/${r.id}`, { method: 'DELETE' });
      }
      if (rows.length < 100) break;
      page++;
    }
  } catch (e) {
    console.error('DR全削除エラー:', e);
  }
}

/**
 * 保存済みの全期間一覧を取得
 */
async function getAllPeriods() {
  try {
    const res = await fetch(`tables/${DB_TABLE}?limit=500`);
    if (!res.ok) return [];
    const json = await res.json();
    const periods = new Set();
    (json.data || []).forEach(r => periods.add(`${r.store_name} ${r.period_ym}`));
    return Array.from(periods);
  } catch (e) {
    return [];
  }
}
