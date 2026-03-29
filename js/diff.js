/**
 * diff.js - 前月差分チェックロジック
 *
 * チェック項目（仕様）:
 * - 役職（role）
 * - 基本給（basicPayMan）
 * - 振込先情報（bank全体）
 * - 新規追加 / 削除
 *
 * 判定: 先月と違うかどうか（アラートレベル細分化なし）
 */

'use strict';

/**
 * 前月差分チェックを実行
 * @param {Array} currentContractors - 今月の全員リスト（業務委託＋社員）
 * @param {Array} prevContractors - 先月のスナップショット（DBから取得）
 * @returns {Array} diffResults
 *
 * 各要素:
 * {
 *   name: string,
 *   personKey: string,
 *   type: 'ROLE_CHANGE'|'BASIC_PAY_CHANGE'|'BANK_CHANGE'|'NEW'|'REMOVED'|'NO_CHANGE',
 *   severity: 'alert'|'info'|'ok',
 *   label: string,
 *   before: any,
 *   after: any,
 *   details: string,
 *   isManualApproved: boolean
 * }
 */
function checkDiff(currentContractors, prevContractors) {
  const results = [];

  // 先月データをキーでマップ化（同姓考慮）
  const prevMap = buildPersonMap(prevContractors);
  const currMap = buildPersonMap(currentContractors);

  // 今月の全員を確認
  for (const c of currentContractors) {
    const key = resolvePersonKey(c.name, currMap);
    const prev = prevMap[key];

    if (!prev) {
      results.push({
        name: c.name,
        personKey: key,
        type: 'NEW',
        severity: 'info',
        label: '新規追加',
        before: null,
        after: c.role || null,
        details: '先月のデータがありません（今月から新たに登録）',
        isManualApproved: false
      });
      continue;
    }

    // ── 役職チェック ──
    const currRole = normText(String(c.role ?? ''));
    const prevRole = normText(String(prev.role ?? ''));
    if (currRole !== prevRole) {
      results.push({
        name: c.name,
        personKey: key,
        type: 'ROLE_CHANGE',
        severity: 'alert',
        label: '役職変更（要確認）',
        before: prevRole || '（空）',
        after:  currRole || '（空）',
        details: '役職が変更されました',
        isManualApproved: false
      });
    }

    // ── 基本給チェック ──
    const currBasic = Number(c.basicPayMan ?? 0);
    const prevBasic = Number(prev.basicPayMan ?? 0);
    if (currBasic !== prevBasic) {
      const delta    = currBasic - prevBasic;
      const deltaYen = Math.round(delta * 10000);
      results.push({
        name: c.name,
        personKey: key,
        type: 'BASIC_PAY_CHANGE',
        severity: 'alert',
        label: '基本給変更（要確認）',
        before: `${prevBasic}万円`,
        after:  `${currBasic}万円`,
        details: `差分: ${delta > 0 ? '+' : ''}${delta}万円（${delta > 0 ? '+' : ''}${deltaYen.toLocaleString()}円）`,
        isManualApproved: false
      });
    }

    // ── 振込先情報チェック（bank全体） ──
    const currBank = c.bank || {};
    const prevBank = prev.bank || {};
    const bankFields = [
      { key: 'bankName',          label: '銀行名' },
      { key: 'branchName',        label: '支店名' },
      { key: 'accountType',       label: '口座種別' },
      { key: 'accountNumber',     label: '口座番号' },
      { key: 'accountHolderKana', label: '名義カナ' }
    ];
    const bankChanges = [];
    for (const f of bankFields) {
      const curr2 = normText(String(currBank[f.key] ?? ''));
      const prev2 = normText(String(prevBank[f.key] ?? ''));
      if (curr2 !== prev2) {
        bankChanges.push({
          field: f.label,
          before: maskAccountNumber(f.key, prev2),
          after:  maskAccountNumber(f.key, curr2)
        });
      }
    }
    if (bankChanges.length > 0) {
      results.push({
        name: c.name,
        personKey: key,
        type: 'BANK_CHANGE',
        severity: 'alert',
        label: '振込先変更（要確認）',
        before: bankChanges.map(b => `${b.field}: ${b.before}`).join(' / '),
        after:  bankChanges.map(b => `${b.field}: ${b.after}`).join(' / '),
        details: `変更項目: ${bankChanges.map(b => b.field).join(', ')}`,
        isManualApproved: false
      });
    }

    // ── 会社名（明細書）チェック ──
    const currCompany = normText(String(c.companyName ?? ''));
    const prevCompany = normText(String(prev.companyName ?? ''));
    if (currCompany !== prevCompany) {
      results.push({
        name: c.name, personKey: key,
        type: 'COMPANY_CHANGE',
        severity: 'alert',
        label: '会社名変更（要確認）',
        before: prevCompany || '（空）',
        after:  currCompany || '（空）',
        details: '明細書の会社名が変更されました',
        isManualApproved: false
      });
    }

    // ── 日付（明細書）チェック ──
    const currDate = normText(String(c.invoiceDate ?? ''));
    const prevDate = normText(String(prev.invoiceDate ?? ''));
    if (currDate !== prevDate) {
      results.push({
        name: c.name, personKey: key,
        type: 'DATE_CHANGE',
        severity: 'alert',
        label: '日付変更（要確認）',
        before: prevDate || '（空）',
        after:  currDate || '（空）',
        details: '明細書の日付が変更されました',
        isManualApproved: false
      });
    }
  }

  // 先月いたが今月いない人
  for (const p of prevContractors) {
    const key = resolvePersonKey(p.name, prevMap);
    if (!currMap[key]) {
      results.push({
        name: p.name,
        personKey: key,
        type: 'REMOVED',
        severity: 'info',
        label: '削除',
        before: p.role || null,
        after: null,
        details: '先月は登録されていましたが、今月はいません',
        isManualApproved: false
      });
    }
  }

  // 変更なしを付与
  const changedKeys = new Set(results.map(r => r.personKey));
  for (const c of currentContractors) {
    const key = resolvePersonKey(c.name, currMap);
    if (prevMap[key] && !changedKeys.has(key)) {
      results.push({
        name: c.name,
        personKey: key,
        type: 'NO_CHANGE',
        severity: 'ok',
        label: '変更なし',
        before: null,
        after: null,
        details: '前月から変更がありません',
        isManualApproved: false
      });
    }
  }

  // alertを先頭に
  results.sort((a, b) => {
    const order = { alert: 0, info: 1, ok: 2 };
    return (order[a.severity] ?? 9) - (order[b.severity] ?? 9);
  });

  return results;
}

/**
 * 人名→キーのマップを作成（同姓がいる場合は名前の一部まで含む）
 * getSurname() / normalizePersonName() の既存ロジックを活用
 */
function buildPersonMap(people) {
  const map = {};
  for (const p of people) {
    const key = getSurname(normalizePersonName(p.name));
    map[key] = p;
  }
  return map;
}

/**
 * 人物のキーを解決する
 * 同姓が複数いる可能性を考慮し、苗字キーを返す
 */
function resolvePersonKey(name, personMap) {
  return getSurname(normalizePersonName(name));
}

/**
 * 口座番号をマスク（下4桁以外を*に置換）
 */
function maskAccountNumber(fieldKey, value) {
  if (fieldKey !== 'accountNumber' || !value) return value;
  if (value.length <= 4) return value;
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

/**
 * 先月データが存在しない（初回処理）の場合の処理
 */
function checkDiffFirstTime(currentContractors) {
  return currentContractors.map(c => ({
    name: c.name,
    personKey: getSurname(normalizePersonName(c.name)),
    type: 'NEW',
    severity: 'info',
    label: '初回登録',
    before: null,
    after: null,
    details: '初回データのため前月比較はありません',
    isManualApproved: false
  }));
}

// ============================================================
// DR 前月差分チェック
// ============================================================

/**
 * DRの前月差分チェックを実行
 * @param {Array} currentDrList  - 今月の parseDR() 結果
 * @param {Array} prevDrList     - 先月のDRスナップショット
 * @returns {Array} drDiffResults
 *
 * チェック項目（仕様）:
 * - ドライバー報酬（基本給相当）の変更
 * - 振込先情報（bank全体）の変更
 * - 新規追加・削除
 * 判定: 先月と違うかどうか（アラートレベル細分化なし）
 */
function checkDRDiff(currentDrList, prevDrList) {
  const results = [];

  const prevMap = {};
  for (const p of prevDrList) {
    prevMap[p.personKey ?? getDRKey(p.name)] = p;
  }

  const currMap = {};
  for (const c of currentDrList) {
    currMap[getDRKey(c.name)] = c;
  }

  // 今月のDR
  for (const c of currentDrList) {
    const key = getDRKey(c.name);
    const prev = prevMap[key];

    if (!prev) {
      results.push({
        name: c.name,
        personKey: key,
        type: 'NEW',
        severity: 'info',
        label: '新規追加',
        before: null,
        after: null,
        details: '先月のDRデータがありません（今月から新たに登録）',
        isManualApproved: false
      });
      continue;
    }

    // ── 振込先情報チェック ──
    const currBank = c.bank || {};
    const prevBank = prev.bank || {};
    const bankFields = [
      { key: 'bankName',          label: '銀行名' },
      { key: 'branchName',        label: '支店名' },
      { key: 'accountType',       label: '口座種別' },
      { key: 'accountNumber',     label: '口座番号' },
      { key: 'accountHolderKana', label: '名義カナ' }
    ];
    const bankChanges = [];
    for (const f of bankFields) {
      const curr2 = normText(String(currBank[f.key] ?? ''));
      const prev2 = normText(String(prevBank[f.key] ?? ''));
      if (curr2 !== prev2) {
        bankChanges.push({
          field: f.label,
          before: maskAccountNumber(f.key, prev2),
          after:  maskAccountNumber(f.key, curr2)
        });
      }
    }
    if (bankChanges.length > 0) {
      results.push({
        name: c.name,
        personKey: key,
        type: 'BANK_CHANGE',
        severity: 'alert',
        label: '振込先変更（要確認）',
        before: bankChanges.map(b => `${b.field}: ${b.before}`).join(' / '),
        after:  bankChanges.map(b => `${b.field}: ${b.after}`).join(' / '),
        details: `変更項目: ${bankChanges.map(b => b.field).join(', ')}`,
        isManualApproved: false
      });
    }
  }

  // 先月いたが今月いないDR
  for (const p of prevDrList) {
    const key = p.personKey ?? getDRKey(p.name);
    if (!currMap[key]) {
      results.push({
        name: p.name,
        personKey: key,
        type: 'REMOVED',
        severity: 'info',
        label: 'DR削除',
        before: null,
        after: null,
        details: '先月はDRとして登録されていましたが、今月はいません',
        isManualApproved: false
      });
    }
  }

  // 変更なし
  const changedKeys = new Set(results.map(r => r.personKey));
  for (const c of currentDrList) {
    const key = getDRKey(c.name);
    if (prevMap[key] && !changedKeys.has(key)) {
      results.push({
        name: c.name,
        personKey: key,
        type: 'NO_CHANGE',
        severity: 'ok',
        label: '変更なし',
        before: null,
        after: null,
        details: '前月から変更がありません',
        isManualApproved: false
      });
    }
  }

  // alertを先頭に
  results.sort((a, b) => {
    const order = { alert: 0, info: 1, ok: 2 };
    return (order[a.severity] ?? 9) - (order[b.severity] ?? 9);
  });

  return results;
}

/**
 * DR初回処理（先月データなし）
 */
function checkDRDiffFirstTime(currentDrList) {
  return currentDrList.map(dr => ({
    name: dr.name,
    personKey: getDRKey(dr.name),
    type: 'NEW',
    severity: 'info',
    label: '初回登録',
    before: null,
    after: null,
    details: '初回データのため前月比較はありません',
    isManualApproved: false
  }));
}
