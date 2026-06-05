/**
 * db.js - データアクセス層（サーバー API 経由）
 *
 * 旧版はブラウザから匿名キーで Supabase を直叩きしていたが、機微データ
 * （口座番号・評価等）が匿名公開状態になるため、サーバー（Vercel Functions /
 * service_role）経由に変更。匿名キーはクライアントから撤去済み。
 * 関数シグネチャは従来どおりで app.js 側の変更は不要。
 */

'use strict';

// ── API 呼び出し共通 ─────────────────────────────────────────
async function apiFetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // セッション未確立・失効 → LINE ログインへ
    window.location.href = '/api/auth/line/login';
    throw new Error('未認証のためログインへリダイレクトします');
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${t.slice(0, 200)}`);
  }
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

const q = (v) => encodeURIComponent(v);

// ── 業務委託スナップショット ──────────────────────────────────

async function saveSnapshot(allPeople, storeName, periodYm, reconcileResults = []) {
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
  await apiFetch('/api/snapshots', { method: 'POST', body: { storeName, periodYm, rows } });
}

async function getSnapshot(storeName, periodYm) {
  const data = await apiFetch(`/api/snapshots?store=${q(storeName)}&period=${q(periodYm)}`);
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

async function getPrevSnapshot(storeName, periodYm) {
  const [year, month] = periodYm.split('-').map(Number);
  let prevYear = year, prevMonth = month - 1;
  if (prevMonth < 1) { prevMonth = 12; prevYear--; }
  return getSnapshot(storeName, `${prevYear}-${String(prevMonth).padStart(2, '0')}`);
}

async function deleteSnapshotsByStorePeriod(storeName, periodYm) {
  await apiFetch(`/api/snapshots?store=${q(storeName)}&period=${q(periodYm)}`, { method: 'DELETE' });
}

async function deleteAllSnapshots() {
  await apiFetch('/api/snapshots?all=1', { method: 'DELETE' });
}

async function getAllPeriods() {
  const data = await apiFetch('/api/snapshots?periods=1');
  const periods = new Set();
  (data || []).forEach(r => periods.add(`${r.store_name} ${r.period_ym}`));
  return Array.from(periods);
}

// ── DR スナップショット ───────────────────────────────────────

async function saveDRSnapshot(drList, storeName, periodYm, reconcileResults) {
  const recMap = {};
  if (reconcileResults) {
    for (const rec of reconcileResults) recMap[normalizePersonName(rec.name)] = rec;
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
  await apiFetch('/api/dr-snapshots', { method: 'POST', body: { storeName, periodYm, rows } });
}

async function getDRSnapshot(storeName, periodYm) {
  const data = await apiFetch(`/api/dr-snapshots?store=${q(storeName)}&period=${q(periodYm)}`);
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

async function getPrevDRSnapshot(storeName, periodYm) {
  const [year, month] = periodYm.split('-').map(Number);
  let prevYear = year, prevMonth = month - 1;
  if (prevMonth < 1) { prevMonth = 12; prevYear--; }
  return getDRSnapshot(storeName, `${prevYear}-${String(prevMonth).padStart(2, '0')}`);
}

async function deleteDRSnapshotsByStorePeriod(storeName, periodYm) {
  await apiFetch(`/api/dr-snapshots?store=${q(storeName)}&period=${q(periodYm)}`, { method: 'DELETE' });
}

async function deleteAllDRSnapshots() {
  await apiFetch('/api/dr-snapshots?all=1', { method: 'DELETE' });
}

// ── スナップショット一覧取得（app.js の loadSnapshotList 用）──

async function getAllSnapshotRows() {
  const [staffRows, drRows] = await Promise.all([
    apiFetch('/api/snapshots?all=1'),
    apiFetch('/api/dr-snapshots?all=1')
  ]);
  return { staffRows: staffRows || [], drRows: drRows || [] };
}

// ── 業務報告データ (business_reports) ────────────────────────

async function saveBusinessReport({ storeName, periodYm, reporter, salesReport, challenges, miscReport, staffChallenges }) {
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
  await apiFetch('/api/business-report', { method: 'POST', body: row });
}

async function getBusinessReport(storeName, periodYm) {
  const r = await apiFetch(`/api/business-report?store=${q(storeName)}&period=${q(periodYm)}`);
  if (!r) return null;
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

async function deleteBusinessReport(storeName, periodYm) {
  await apiFetch(`/api/business-report?store=${q(storeName)}&period=${q(periodYm)}`, { method: 'DELETE' });
}
