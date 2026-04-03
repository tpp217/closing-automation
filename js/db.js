/**
 * db.js - tpp-api クライアント（IndexedDB → tpp-api 移行）
 *
 * 関数シグネチャは旧IndexedDB版と完全互換。
 * app.js 側の変更は不要。
 *
 * API: https://zvtfabus.gensparkclaw.com/api/teppei/closing-automation/
 *   collections:
 *     contractor_snapshots  - 業務委託・社員スナップショット
 *     dr_snapshots          - DRスナップショット
 */

'use strict';

const API_BASE    = 'https://zvtfabus.gensparkclaw.com/api/teppei/closing-automation';
const API_KEY     = window.TPP_API_KEY ?? '';
const DB_TABLE    = 'contractor_snapshots';
const DR_DB_TABLE = 'dr_snapshots';

// ── 共通フェッチ ──────────────────────────────────────────────

async function apiGet(collection, query = {}) {
  const params = new URLSearchParams(query).toString();
  const url    = `${API_BASE}/${collection}${params ? '?' + params : ''}`;
  const res    = await fetch(url, { headers: { 'X-Api-Key': API_KEY } });
  if (!res.ok) throw new Error(`GET ${collection} failed: ${res.status}`);
  const json = await res.json();
  return json.data ?? [];
}

async function apiPost(collection, payload) {
  const res = await fetch(`${API_BASE}/${collection}`, {
    method:  'POST',
    headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`POST ${collection} failed: ${res.status}`);
  return res.json();
}

async function apiDelete(collection, id = null) {
  const url = id ? `${API_BASE}/${collection}/${id}` : `${API_BASE}/${collection}`;
  const res = await fetch(url, {
    method:  'DELETE',
    headers: { 'X-Api-Key': API_KEY }
  });
  if (!res.ok) throw new Error(`DELETE ${collection} failed: ${res.status}`);
  return res.json();
}

// ── 業務委託スナップショット ──────────────────────────────────

/**
 * スナップショット保存（同店舗・同年月を上書き）
 */
async function saveSnapshot(allPeople, storeName, periodYm, reconcileResults = []) {
  // 既存の同店舗・同年月を削除
  await deleteSnapshotsByStorePeriod(storeName, periodYm);

  const reconcileMap = {};
  for (const r of reconcileResults) {
    if (r.name) reconcileMap[normalizePersonName(r.name)] = r;
  }

  const rows = allPeople.map(c => {
    const personKey = normalizePersonName(c.name);
    const rec = reconcileMap[personKey] || {};
    return {
      store_name:            storeName,
      period_ym:             periodYm,
      person_key:            personKey,
      person_name:           c.name,
      role:                  c.role ?? '',
      basic_pay_man:         c.basicPayMan ?? 0,
      raise_request_man:     c.raiseRequestMan ?? 0,
      oiri_man:              c.oiriMan ?? 0,
      daily_pay_yen:         c.dailyPayYen ?? 0,
      office_rent_yen:       c.officeRentYen ?? 0,
      other_items_json:      JSON.stringify(c.otherItems ?? []),
      bank_name:             c.bank?.bankName ?? '',
      branch_name:           c.bank?.branchName ?? '',
      account_type:          c.bank?.accountType ?? '',
      account_number:        c.bank?.accountNumber ?? '',
      account_holder_kana:   c.bank?.accountHolderKana ?? '',
      company_name:          c.companyName          ?? '',
      representative_name:   c.representativeName   ?? '',
      reconcile_status:      rec.status ?? 'NONE',
      reconcile_reason:      rec.reason ?? '',
      reconcile_monthly_yen: rec.monthlyDailyPayYen ?? 0,
      warnings_json:         JSON.stringify(c.warnings ?? [])
    };
  });

  if (rows.length > 0) await apiPost(DB_TABLE, rows);
}

/**
 * 指定店舗・年月のスナップショットを取得
 */
async function getSnapshot(storeName, periodYm) {
  const rows = await apiGet(DB_TABLE, { store_name: storeName, period_ym: periodYm });
  return rows.map(rowToContractor);
}

function rowToContractor(r) {
  return {
    name:                r.person_name,
    personKey:           r.person_key,
    role:                r.role ?? '',
    basicPayMan:         Number(r.basic_pay_man   ?? 0),
    raiseRequestMan:     Number(r.raise_request_man ?? 0),
    oiriMan:             Number(r.oiri_man         ?? 0),
    dailyPayYen:         Number(r.daily_pay_yen    ?? 0),
    officeRentYen:       Number(r.office_rent_yen  ?? 0),
    otherItems:          JSON.parse(r.other_items_json || '[]'),
    bank: {
      bankName:          r.bank_name           ?? '',
      branchName:        r.branch_name         ?? '',
      accountType:       r.account_type        ?? '',
      accountNumber:     r.account_number      ?? '',
      accountHolderKana: r.account_holder_kana ?? ''
    },
    companyName:         r.company_name          ?? '',
    representativeName:  r.representative_name   ?? '',
    reconcileStatus:     r.reconcile_status      ?? 'NONE',
    reconcileReason:     r.reconcile_reason      ?? '',
    reconcileMonthlyYen: Number(r.reconcile_monthly_yen ?? 0),
    warnings:            JSON.parse(r.warnings_json || '[]')
  };
}

/**
 * 直近前月のスナップショットを取得
 */
async function getPrevSnapshot(storeName, periodYm) {
  const [year, month] = periodYm.split('-').map(Number);
  let prevYear = year, prevMonth = month - 1;
  if (prevMonth < 1) { prevMonth = 12; prevYear--; }
  return getSnapshot(storeName, `${prevYear}-${String(prevMonth).padStart(2, '0')}`);
}

/**
 * 指定店舗・年月のスナップショットを削除
 */
async function deleteSnapshotsByStorePeriod(storeName, periodYm) {
  // 該当レコードのidを取得してから1件ずつ削除
  const rows = await apiGet(DB_TABLE, { store_name: storeName, period_ym: periodYm });
  await Promise.all(rows.map(r => apiDelete(DB_TABLE, r.id)));
}

/**
 * 全スナップショットを削除（リセット用）
 */
async function deleteAllSnapshots() {
  await apiDelete(DB_TABLE);
}

/**
 * 保存済みの全期間一覧を取得（一覧表示用）
 */
async function getAllPeriods() {
  const rows = await apiGet(DB_TABLE);
  const periods = new Set();
  rows.forEach(r => periods.add(`${r.store_name} ${r.period_ym}`));
  return Array.from(periods);
}

// ── DR スナップショット ───────────────────────────────────────

/**
 * DRスナップショット保存
 */
async function saveDRSnapshot(drList, storeName, periodYm, reconcileResults) {
  await deleteDRSnapshotsByStorePeriod(storeName, periodYm);

  const recMap = {};
  if (reconcileResults) {
    for (const rec of reconcileResults) {
      recMap[normalizePersonName(rec.name)] = rec;
    }
  }

  const rows = drList.map(dr => {
    const rec = recMap[normalizePersonName(dr.name)];
    return {
      store_name:            storeName,
      period_ym:             periodYm,
      person_key:            normalizePersonName(dr.name),
      person_name:           dr.name,
      sheet_name:            dr.sheetName   ?? '',
      driver_reward:         dr.driverReward  ?? 0,
      karibara_yen:          dr.karibaraiYen  ?? 0,
      total_amount:          dr.totalAmount   ?? 0,
      reconcile_status:      rec?.status      ?? 'NONE',
      reconcile_reason:      rec?.reason      ?? '',
      reconcile_monthly_yen: rec?.monthlyDailyPayYen ?? 0,
      company_name:          dr.companyName          ?? '',
      representative_name:   dr.representativeName   ?? '',
      bank_name:             dr.bank?.bankName           ?? '',
      branch_name:           dr.bank?.branchName         ?? '',
      account_type:          dr.bank?.accountType        ?? '',
      account_number:        dr.bank?.accountNumber      ?? '',
      account_holder_kana:   dr.bank?.accountHolderKana  ?? ''
    };
  });

  if (rows.length > 0) await apiPost(DR_DB_TABLE, rows);
}

/**
 * 指定店舗・年月のDRスナップショットを取得
 */
async function getDRSnapshot(storeName, periodYm) {
  const rows = await apiGet(DR_DB_TABLE, { store_name: storeName, period_ym: periodYm });
  return rows.map(r => ({
    name:                r.person_name,
    personKey:           r.person_key,
    sheetName:           r.sheet_name,
    driverReward:        Number(r.driver_reward  ?? 0),
    karibaraiYen:        Number(r.karibara_yen   ?? 0),
    totalAmount:         Number(r.total_amount   ?? 0),
    reconcileStatus:     r.reconcile_status      ?? 'NONE',
    reconcileReason:     r.reconcile_reason      ?? '',
    reconcileMonthlyYen: Number(r.reconcile_monthly_yen ?? 0),
    companyName:         r.company_name          ?? '',
    representativeName:  r.representative_name   ?? '',
    bank: {
      bankName:          r.bank_name           ?? '',
      branchName:        r.branch_name         ?? '',
      accountType:       r.account_type        ?? '',
      accountNumber:     r.account_number      ?? '',
      accountHolderKana: r.account_holder_kana ?? ''
    }
  }));
}

/**
 * 直近前月のDRスナップショットを取得
 */
async function getPrevDRSnapshot(storeName, periodYm) {
  const [year, month] = periodYm.split('-').map(Number);
  let prevYear = year, prevMonth = month - 1;
  if (prevMonth < 1) { prevMonth = 12; prevYear--; }
  return getDRSnapshot(storeName, `${prevYear}-${String(prevMonth).padStart(2, '0')}`);
}

/**
 * 指定店舗・年月のDRスナップショットを削除
 */
async function deleteDRSnapshotsByStorePeriod(storeName, periodYm) {
  const rows = await apiGet(DR_DB_TABLE, { store_name: storeName, period_ym: periodYm });
  await Promise.all(rows.map(r => apiDelete(DR_DB_TABLE, r.id)));
}

/**
 * 全DRスナップショットを削除（リセット用）
 */
async function deleteAllDRSnapshots() {
  await apiDelete(DR_DB_TABLE);
}

// ── スナップショット一覧取得（app.js の loadSnapshotList 用）──

async function getAllSnapshotRows() {
  const [staffRows, drRows] = await Promise.all([
    apiGet(DB_TABLE),
    apiGet(DR_DB_TABLE)
  ]);
  return { staffRows, drRows };
}

// ── 業務報告データ (business_reports) ────────────────────────

const REPORT_TABLE = 'business_reports';

/**
 * 業務報告データを保存（同店舗・同年月を上書き）
 */
async function saveBusinessReport({ storeName, periodYm, reporter, salesReport, challenges, miscReport, staffChallenges }) {
  // 既存の同店舗・同年月を削除
  await deleteBusinessReport(storeName, periodYm);

  const row = {
    store_name:        storeName,
    period_ym:         periodYm,
    reporter:          reporter          ?? '',
    sales_report:      salesReport       ?? '',
    challenges:        challenges        ?? '',
    misc_report:       miscReport        ?? '',
    staff_challenges:  JSON.stringify(staffChallenges ?? []),
    saved_at:          new Date().toISOString()
  };

  return apiPost(REPORT_TABLE, [row]);
}

/**
 * 業務報告データを取得
 */
async function getBusinessReport(storeName, periodYm) {
  const rows = await apiGet(REPORT_TABLE, { store_name: storeName, period_ym: periodYm });
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    storeName:       r.store_name,
    periodYm:        r.period_ym,
    reporter:        r.reporter        ?? '',
    salesReport:     r.sales_report    ?? '',
    challenges:      r.challenges      ?? '',
    miscReport:      r.misc_report     ?? '',
    staffChallenges: JSON.parse(r.staff_challenges || '[]'),
    savedAt:         r.saved_at        ?? ''
  };
}

/**
 * 指定店舗・年月の業務報告データを削除
 */
async function deleteBusinessReport(storeName, periodYm) {
  const rows = await apiGet(REPORT_TABLE, { store_name: storeName, period_ym: periodYm });
  await Promise.all(rows.map(r => apiDelete(REPORT_TABLE, r.id)));
}
