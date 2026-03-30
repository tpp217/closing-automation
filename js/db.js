/**
 * db.js - IndexedDB ラッパー（スナップショット保存/取得）
 *
 * Genspark Table API から IndexedDB へ完全移行。
 * 関数シグネチャは旧APIと完全互換を維持。
 *
 * DB構造:
 *   dbName : 'billingCheckDB'
 *   version: 2
 *   stores :
 *     contractor_snapshots  - 業務委託・社員スナップショット
 *     dr_snapshots          - DRスナップショット
 */

'use strict';

const IDB_NAME    = 'billingCheckDB';
const IDB_VERSION = 2;

// ── IndexedDB 初期化 ──────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);

    req.onupgradeneeded = e => {
      const db = e.target.result;

      // contractor_snapshots
      if (!db.objectStoreNames.contains('contractor_snapshots')) {
        const s = db.createObjectStore('contractor_snapshots', {
          keyPath: 'id', autoIncrement: true
        });
        s.createIndex('by_store_period', ['store_name', 'period_ym']);
        s.createIndex('by_store',        'store_name');
      }

      // dr_snapshots
      if (!db.objectStoreNames.contains('dr_snapshots')) {
        const s = db.createObjectStore('dr_snapshots', {
          keyPath: 'id', autoIncrement: true
        });
        s.createIndex('by_store_period', ['store_name', 'period_ym']);
        s.createIndex('by_store',        'store_name');
      }
    };

    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

/** ストアから全件取得 */
function getAllFromStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

/** ストアにレコードを追加 */
function addToStore(db, storeName, record) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** ストアからidで1件削除 */
function deleteFromStore(db, storeName, id) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/** ストアの全件削除 */
function clearStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ── 業務委託スナップショット ──────────────────────────────────
const DB_TABLE = 'contractor_snapshots';

/**
 * スナップショット保存
 * @param {Array}  allPeople        - 全員リスト（業務委託＋社員）
 * @param {string} storeName
 * @param {string} periodYm         - YYYY-MM
 * @param {Array}  reconcileResults - 突合結果（省略可）
 */
async function saveSnapshot(allPeople, storeName, periodYm, reconcileResults = []) {
  const db = await openDB();

  // 既存の同店舗・同年月を削除
  await deleteSnapshotsByStorePeriod(storeName, periodYm);

  // 突合結果を氏名キーでマップ化
  const reconcileMap = {};
  for (const r of reconcileResults) {
    if (r.name) reconcileMap[normalizePersonName(r.name)] = r;
  }

  for (const c of allPeople) {
    const personKey = normalizePersonName(c.name);
    const rec = reconcileMap[personKey] || {};
    const row = {
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
    await addToStore(db, DB_TABLE, row);
  }
}

/**
 * 指定店舗・年月のスナップショットを取得
 */
async function getSnapshot(storeName, periodYm) {
  const db   = await openDB();
  const rows = await getAllFromStore(db, DB_TABLE);
  return rows
    .filter(r => r.store_name === storeName && r.period_ym === periodYm)
    .map(rowToContractor);
}

function rowToContractor(r) {
  return {
    name:                 r.person_name,
    personKey:            r.person_key,
    role:                 r.role ?? '',
    basicPayMan:          Number(r.basic_pay_man   ?? 0),
    raiseRequestMan:      Number(r.raise_request_man ?? 0),
    oiriMan:              Number(r.oiri_man         ?? 0),
    dailyPayYen:          Number(r.daily_pay_yen    ?? 0),
    officeRentYen:        Number(r.office_rent_yen  ?? 0),
    otherItems:           JSON.parse(r.other_items_json || '[]'),
    bank: {
      bankName:           r.bank_name           ?? '',
      branchName:         r.branch_name         ?? '',
      accountType:        r.account_type        ?? '',
      accountNumber:      r.account_number      ?? '',
      accountHolderKana:  r.account_holder_kana ?? ''
    },
    companyName:          r.company_name          ?? '',
    representativeName:   r.representative_name   ?? '',
    reconcileStatus:      r.reconcile_status      ?? 'NONE',
    reconcileReason:      r.reconcile_reason      ?? '',
    reconcileMonthlyYen:  Number(r.reconcile_monthly_yen ?? 0),
    warnings:             JSON.parse(r.warnings_json || '[]')
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
  const db   = await openDB();
  const rows = await getAllFromStore(db, DB_TABLE);
  const targets = rows.filter(r => r.store_name === storeName && r.period_ym === periodYm);
  for (const r of targets) await deleteFromStore(db, DB_TABLE, r.id);
}

/**
 * 全スナップショットを削除（リセット用）
 */
async function deleteAllSnapshots() {
  const db = await openDB();
  await clearStore(db, DB_TABLE);
}

/**
 * 保存済みの全期間一覧を取得（一覧表示用）
 */
async function getAllPeriods() {
  const db   = await openDB();
  const rows = await getAllFromStore(db, DB_TABLE);
  const periods = new Set();
  rows.forEach(r => periods.add(`${r.store_name} ${r.period_ym}`));
  return Array.from(periods);
}

// ── DR スナップショット ───────────────────────────────────────
const DR_DB_TABLE = 'dr_snapshots';

/**
 * DRスナップショット保存
 */
async function saveDRSnapshot(drList, storeName, periodYm, reconcileResults) {
  const db = await openDB();
  await deleteDRSnapshotsByStorePeriod(storeName, periodYm);

  // 突合結果をDR名キーでマップ化
  const recMap = {};
  if (reconcileResults) {
    for (const rec of reconcileResults) {
      recMap[normalizePersonName(rec.name)] = rec;
    }
  }

  for (const dr of drList) {
    const rec = recMap[normalizePersonName(dr.name)];
    const row = {
      store_name:           storeName,
      period_ym:            periodYm,
      person_key:           normalizePersonName(dr.name),
      person_name:          dr.name,
      sheet_name:           dr.sheetName   ?? '',
      driver_reward:        dr.driverReward  ?? 0,
      karibara_yen:         dr.karibaraiYen  ?? 0,
      total_amount:         dr.totalAmount   ?? 0,
      reconcile_status:     rec?.status      ?? 'NONE',
      reconcile_reason:     rec?.reason      ?? '',
      reconcile_monthly_yen: rec?.monthlyDailyPayYen ?? 0,
      bank_name:            dr.bank?.bankName           ?? '',
      branch_name:          dr.bank?.branchName         ?? '',
      account_type:         dr.bank?.accountType        ?? '',
      account_number:       dr.bank?.accountNumber      ?? '',
      account_holder_kana:  dr.bank?.accountHolderKana  ?? ''
    };
    await addToStore(db, DR_DB_TABLE, row);
  }
}

/**
 * 指定店舗・年月のDRスナップショットを取得
 */
async function getDRSnapshot(storeName, periodYm) {
  const db   = await openDB();
  const rows = await getAllFromStore(db, DR_DB_TABLE);
  return rows
    .filter(r => r.store_name === storeName && r.period_ym === periodYm)
    .map(r => ({
      name:                r.person_name,
      personKey:           r.person_key,
      sheetName:           r.sheet_name,
      driverReward:        Number(r.driver_reward  ?? 0),
      karibaraiYen:        Number(r.karibara_yen   ?? 0),
      totalAmount:         Number(r.total_amount   ?? 0),
      reconcileStatus:     r.reconcile_status      ?? 'NONE',
      reconcileReason:     r.reconcile_reason      ?? '',
      reconcileMonthlyYen: Number(r.reconcile_monthly_yen ?? 0),
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
  const db   = await openDB();
  const rows = await getAllFromStore(db, DR_DB_TABLE);
  const targets = rows.filter(r => r.store_name === storeName && r.period_ym === periodYm);
  for (const r of targets) await deleteFromStore(db, DR_DB_TABLE, r.id);
}

/**
 * 全DRスナップショットを削除（リセット用）
 */
async function deleteAllDRSnapshots() {
  const db = await openDB();
  await clearStore(db, DR_DB_TABLE);
}

// ── スナップショット一覧取得（app.js の loadSnapshotList 用）──
/**
 * 業務委託・DR 両方の全レコードを返す
 * app.js 側で periodGroups を組み立てる
 */
async function getAllSnapshotRows() {
  const db        = await openDB();
  const staffRows = await getAllFromStore(db, DB_TABLE);
  const drRows    = await getAllFromStore(db, DR_DB_TABLE);
  return { staffRows, drRows };
}
