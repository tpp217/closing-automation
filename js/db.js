/**
 * db.js - Supabase クライアント（tpp-api → Supabase 移行）
 *
 * 関数シグネチャは旧tpp-api版と完全互換。
 * app.js 側の変更は不要。
 */

'use strict';

const SUPABASE_URL  = window.SUPABASE_URL;
const SUPABASE_KEY  = window.SUPABASE_ANON_KEY;
const DB_TABLE      = 'contractor_snapshots';
const DR_DB_TABLE   = 'dr_snapshots';

// Supabase client (CDN版)
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return _supabase;
}

// ── 業務委託スナップショット ──────────────────────────────────

/**
 * スナップショット保存（同店舗・同年月を上書き）
 */
async function saveSnapshot(allPeople, storeName, periodYm, reconcileResults = []) {
  const sb = getSupabase();

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
      other_items_json:      c.otherItems ?? [],
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
      warnings_json:         c.warnings ?? []
    };
  });

  if (rows.length > 0) {
    const { error } = await sb.from(DB_TABLE).insert(rows);
    if (error) throw error;
  }
}

/**
 * 指定店舗・年月のスナップショットを取得
 */
async function getSnapshot(storeName, periodYm) {
  const sb = getSupabase();
  const { data, error } = await sb.from(DB_TABLE).select('*')
    .eq('store_name', storeName).eq('period_ym', periodYm);
  if (error) throw error;
  return (data || []).map(rowToContractor);
}

function rowToContractor(r) {
  const otherItems = typeof r.other_items_json === 'string'
    ? JSON.parse(r.other_items_json || '[]') : (r.other_items_json ?? []);
  const warnings = typeof r.warnings_json === 'string'
    ? JSON.parse(r.warnings_json || '[]') : (r.warnings_json ?? []);
  return {
    name:                r.person_name,
    personKey:           r.person_key,
    role:                r.role ?? '',
    basicPayMan:         Number(r.basic_pay_man   ?? 0),
    raiseRequestMan:     Number(r.raise_request_man ?? 0),
    oiriMan:             Number(r.oiri_man         ?? 0),
    dailyPayYen:         Number(r.daily_pay_yen    ?? 0),
    officeRentYen:       Number(r.office_rent_yen  ?? 0),
    otherItems:          otherItems,
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
    warnings:            warnings
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
  const sb = getSupabase();
  const { error } = await sb.from(DB_TABLE).delete()
    .eq('store_name', storeName).eq('period_ym', periodYm);
  if (error) throw error;
}

/**
 * 全スナップショットを削除（リセット用）
 */
async function deleteAllSnapshots() {
  const sb = getSupabase();
  const { error } = await sb.from(DB_TABLE).delete().neq('id', 0);
  if (error) throw error;
}

/**
 * 保存済みの全期間一覧を取得（一覧表示用）
 */
async function getAllPeriods() {
  const sb = getSupabase();
  const { data, error } = await sb.from(DB_TABLE).select('store_name, period_ym');
  if (error) throw error;
  const periods = new Set();
  (data || []).forEach(r => periods.add(`${r.store_name} ${r.period_ym}`));
  return Array.from(periods);
}

// ── DR スナップショット ───────────────────────────────────────

/**
 * DRスナップショット保存
 */
async function saveDRSnapshot(drList, storeName, periodYm, reconcileResults) {
  const sb = getSupabase();
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

  if (rows.length > 0) {
    const { error } = await sb.from(DR_DB_TABLE).insert(rows);
    if (error) throw error;
  }
}

/**
 * 指定店舗・年月のDRスナップショットを取得
 */
async function getDRSnapshot(storeName, periodYm) {
  const sb = getSupabase();
  const { data, error } = await sb.from(DR_DB_TABLE).select('*')
    .eq('store_name', storeName).eq('period_ym', periodYm);
  if (error) throw error;
  return (data || []).map(r => ({
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
  const sb = getSupabase();
  const { error } = await sb.from(DR_DB_TABLE).delete()
    .eq('store_name', storeName).eq('period_ym', periodYm);
  if (error) throw error;
}

/**
 * 全DRスナップショットを削除（リセット用）
 */
async function deleteAllDRSnapshots() {
  const sb = getSupabase();
  const { error } = await sb.from(DR_DB_TABLE).delete().neq('id', 0);
  if (error) throw error;
}

// ── スナップショット一覧取得（app.js の loadSnapshotList 用）──

async function getAllSnapshotRows() {
  const sb = getSupabase();
  const [staffRes, drRes] = await Promise.all([
    sb.from(DB_TABLE).select('*'),
    sb.from(DR_DB_TABLE).select('*')
  ]);
  if (staffRes.error) throw staffRes.error;
  if (drRes.error) throw drRes.error;
  return { staffRows: staffRes.data || [], drRows: drRes.data || [] };
}

// ── 業務報告データ (business_reports) ────────────────────────

const REPORT_TABLE = 'business_reports';

/**
 * 業務報告データを保存（同店舗・同年月を上書き）
 */
async function saveBusinessReport({ storeName, periodYm, reporter, salesReport, challenges, miscReport, staffChallenges }) {
  const sb = getSupabase();

  const row = {
    store_name:        storeName,
    period_ym:         periodYm,
    reporter:          reporter          ?? '',
    sales_report:      salesReport       ?? '',
    challenges:        challenges        ?? '',
    misc_report:       miscReport        ?? '',
    staff_challenges:  staffChallenges ?? [],
    saved_at:          new Date().toISOString()
  };

  const { error } = await sb.from(REPORT_TABLE)
    .upsert(row, { onConflict: 'store_name,period_ym' });
  if (error) throw error;
}

/**
 * 業務報告データを取得
 */
async function getBusinessReport(storeName, periodYm) {
  const sb = getSupabase();
  const { data, error } = await sb.from(REPORT_TABLE).select('*')
    .eq('store_name', storeName).eq('period_ym', periodYm)
    .limit(1).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data;
  const staffChallenges = typeof r.staff_challenges === 'string'
    ? JSON.parse(r.staff_challenges || '[]') : (r.staff_challenges ?? []);
  return {
    storeName:       r.store_name,
    periodYm:        r.period_ym,
    reporter:        r.reporter        ?? '',
    salesReport:     r.sales_report    ?? '',
    challenges:      r.challenges      ?? '',
    miscReport:      r.misc_report     ?? '',
    staffChallenges: staffChallenges,
    savedAt:         r.saved_at        ?? ''
  };
}

/**
 * 指定店舗・年月の業務報告データを削除
 */
async function deleteBusinessReport(storeName, periodYm) {
  const sb = getSupabase();
  const { error } = await sb.from(REPORT_TABLE).delete()
    .eq('store_name', storeName).eq('period_ym', periodYm);
  if (error) throw error;
}
