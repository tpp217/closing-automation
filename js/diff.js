/**
 * diff.js - 前月差分チェックロジック
 * 
 * 対象: 基本給（万円）・日払い（属性/額）・口座情報
 * 
 * 判定ルール:
 * - 基本給増加: delta > 0 → INCREASE（要確認）
 * - 基本給減少: delta < 0 → DECREASE（要確認）
 * - 口座情報変更: 銀行/支店/種別/番号/名義カナのいずれか変更 → BANK_CHANGE（要確認）
 * - 日払い属性変更: 0↔>0 → DAILY_MODE_CHANGE（要確認）
 * - 新規追加: 先月なし → NEW（情報）
 * - 削除: 今月なし先月あり → REMOVED（情報）
 */

'use strict';

/**
 * 前月差分チェックを実行
 * @param {Array} currentContractors - 今月の委託者リスト
 * @param {Array} prevContractors - 先月のスナップショット（DBから取得）
 * @returns {Array} diffResults
 * 
 * 各要素:
 * {
 *   name: string,
 *   personKey: string,
 *   type: 'BASIC_PAY_INCREASE'|'BASIC_PAY_DECREASE'|'BANK_CHANGE'|'DAILY_MODE_CHANGE'|'NEW'|'REMOVED'|'NO_CHANGE',
 *   severity: 'alert'|'info'|'ok',
 *   label: string,          // 表示用ラベル
 *   before: any,
 *   after: any,
 *   details: string,
 *   isManualApproved: boolean
 * }
 */
function checkDiff(currentContractors, prevContractors) {
  const results = [];

  // 先月データをキーでマップ化
  const prevMap = {};
  for (const p of prevContractors) {
    const key = getSurname(normalizePersonName(p.name));
    prevMap[key] = p;
  }

  // 今月データをキーでマップ化
  const currMap = {};
  for (const c of currentContractors) {
    const key = getSurname(normalizePersonName(c.name));
    currMap[key] = c;
  }

  // 今月の委託者を確認
  for (const c of currentContractors) {
    const key = getSurname(normalizePersonName(c.name));
    const prev = prevMap[key];

    if (!prev) {
      // 新規（先月なし）
      results.push({
        name: c.name,
        personKey: key,
        type: 'NEW',
        severity: 'info',
        label: '新規追加',
        before: null,
        after: null,
        details: `先月のデータがありません（今月から新たに業務委託として登録）`,
        isManualApproved: false
      });
      continue;
    }

    // 基本給チェック
    const currBasic = Number(c.basicPayMan ?? 0);
    const prevBasic = Number(prev.basicPayMan ?? 0);
    if (currBasic !== prevBasic) {
      const delta = currBasic - prevBasic;
      const deltaYen = Math.round(delta * 10000);
      results.push({
        name: c.name,
        personKey: key,
        type: delta > 0 ? 'BASIC_PAY_INCREASE' : 'BASIC_PAY_DECREASE',
        severity: 'alert',
        label: delta > 0 ? '昇給（要確認）' : '減給（要確認）',
        before: `${prevBasic}万円`,
        after: `${currBasic}万円`,
        details: `差分: ${delta > 0 ? '+' : ''}${delta}万円（${delta > 0 ? '+' : ''}${deltaYen.toLocaleString()}円）`,
        isManualApproved: false
      });
    }

    // 日払い属性変更チェック（0↔>0）
    const currDaily = Number(c.dailyPayYen ?? 0);
    const prevDaily = Number(prev.dailyPayYen ?? 0);
    const currIsDaily = currDaily > 0;
    const prevIsDaily = prevDaily > 0;
    if (currIsDaily !== prevIsDaily) {
      results.push({
        name: c.name,
        personKey: key,
        type: 'DAILY_MODE_CHANGE',
        severity: 'alert',
        label: '日払い設定変更（要確認）',
        before: prevIsDaily ? `日払いあり（${formatYen(prevDaily)}）` : '日払いなし',
        after: currIsDaily ? `日払いあり（${formatYen(currDaily)}）` : '日払いなし',
        details: prevIsDaily ? '日払い → 日払いなし に変更されました' : '日払いなし → 日払い に変更されました',
        isManualApproved: false
      });
    } else if (currDaily !== prevDaily && currDaily > 0) {
      // 日払い額の変更（両方>0だが金額が違う）
      results.push({
        name: c.name,
        personKey: key,
        type: 'DAILY_AMOUNT_CHANGE',
        severity: 'alert',
        label: '日払い額変更（要確認）',
        before: formatYen(prevDaily),
        after: formatYen(currDaily),
        details: `日払い額が変更されました`,
        isManualApproved: false
      });
    }

    // 口座情報チェック
    const currBank = c.bank || {};
    const prevBank = prev.bank || {};
    const bankFields = [
      { key: 'bankName', label: '銀行名' },
      { key: 'branchName', label: '支店名' },
      { key: 'accountType', label: '口座種別' },
      { key: 'accountNumber', label: '口座番号' },
      { key: 'accountHolderKana', label: '名義カナ' }
    ];

    const bankChanges = [];
    for (const f of bankFields) {
      const curr = normText(String(currBank[f.key] ?? ''));
      const prev2 = normText(String(prevBank[f.key] ?? ''));
      if (curr !== prev2) {
        bankChanges.push({
          field: f.label,
          before: maskAccountNumber(f.key, prev2),
          after: maskAccountNumber(f.key, curr)
        });
      }
    }

    if (bankChanges.length > 0) {
      results.push({
        name: c.name,
        personKey: key,
        type: 'BANK_CHANGE',
        severity: 'alert',
        label: '口座情報変更（要確認）',
        before: bankChanges.map(b => `${b.field}: ${b.before}`).join(' / '),
        after: bankChanges.map(b => `${b.field}: ${b.after}`).join(' / '),
        details: `変更項目: ${bankChanges.map(b => b.field).join(', ')}`,
        isManualApproved: false
      });
    }
  }

  // 先月いたが今月いない委託者
  for (const p of prevContractors) {
    const key = getSurname(normalizePersonName(p.name));
    if (!currMap[key]) {
      results.push({
        name: p.name,
        personKey: key,
        type: 'REMOVED',
        severity: 'info',
        label: '委託者から削除',
        before: null,
        after: null,
        details: '先月は業務委託として登録されていましたが、今月はいません',
        isManualApproved: false
      });
    }
  }

  // 変更なし
  const alertKeys = new Set(results.filter(r => r.severity === 'alert').map(r => r.personKey));
  for (const c of currentContractors) {
    const key = getSurname(normalizePersonName(c.name));
    const prev = prevMap[key];
    if (prev && !alertKeys.has(key) && !results.some(r => r.personKey === key && r.type === 'NEW')) {
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
 * チェック項目:
 * - ドライバー報酬の増減
 * - 仮払精算（日払い）の増減
 * - 口座情報の変更
 * - 新規追加・削除
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

    // ドライバー報酬チェック
    const currReward = Number(c.driverReward ?? 0);
    const prevReward = Number(prev.driverReward ?? 0);
    if (currReward !== prevReward && (currReward > 0 || prevReward > 0)) {
      const delta = currReward - prevReward;
      results.push({
        name: c.name,
        personKey: key,
        type: delta > 0 ? 'REWARD_INCREASE' : 'REWARD_DECREASE',
        severity: 'alert',
        label: delta > 0 ? 'ドライバー報酬増加（要確認）' : 'ドライバー報酬減少（要確認）',
        before: formatYen(prevReward),
        after: formatYen(currReward),
        details: `差分: ${delta > 0 ? '+' : ''}${formatYen(delta)}`,
        isManualApproved: false
      });
    }

    // 仮払精算（日払い）チェック
    const currKari = Number(c.karibaraiYen ?? 0);
    const prevKari = Number(prev.karibaraiYen ?? 0);
    const currIsKari = currKari > 0;
    const prevIsKari = prevKari > 0;
    if (currIsKari !== prevIsKari) {
      results.push({
        name: c.name,
        personKey: key,
        type: 'KARIBARA_MODE_CHANGE',
        severity: 'alert',
        label: '仮払有無変更（要確認）',
        before: prevIsKari ? `仮払あり（${formatYen(prevKari)}）` : '仮払なし',
        after: currIsKari ? `仮払あり（${formatYen(currKari)}）` : '仮払なし',
        details: prevIsKari ? '仮払あり → 仮払なし に変更' : '仮払なし → 仮払あり に変更',
        isManualApproved: false
      });
    } else if (currKari !== prevKari && currKari > 0) {
      const delta = currKari - prevKari;
      results.push({
        name: c.name,
        personKey: key,
        type: 'KARIBARA_AMOUNT_CHANGE',
        severity: 'alert',
        label: '仮払額変更（要確認）',
        before: formatYen(prevKari),
        after: formatYen(currKari),
        details: `差分: ${delta > 0 ? '+' : ''}${formatYen(delta)}`,
        isManualApproved: false
      });
    }

    // 口座情報チェック
    const currBank = c.bank || {};
    const prevBank = prev.bank || {};
    const bankFields = [
      { key: 'bankName', label: '銀行名' },
      { key: 'branchName', label: '支店名' },
      { key: 'accountType', label: '口座種別' },
      { key: 'accountNumber', label: '口座番号' },
      { key: 'accountHolderKana', label: '名義カナ' }
    ];

    const bankChanges = [];
    for (const f of bankFields) {
      const curr = normText(String(currBank[f.key] ?? ''));
      const prev2 = normText(String(prevBank[f.key] ?? ''));
      if (curr !== prev2) {
        bankChanges.push({
          field: f.label,
          before: maskAccountNumber(f.key, prev2),
          after: maskAccountNumber(f.key, curr)
        });
      }
    }

    if (bankChanges.length > 0) {
      results.push({
        name: c.name,
        personKey: key,
        type: 'BANK_CHANGE',
        severity: 'alert',
        label: '口座情報変更（要確認）',
        before: bankChanges.map(b => `${b.field}: ${b.before}`).join(' / '),
        after: bankChanges.map(b => `${b.field}: ${b.after}`).join(' / '),
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
  const alertKeys = new Set(results.filter(r => r.severity === 'alert').map(r => r.personKey));
  for (const c of currentDrList) {
    const key = getDRKey(c.name);
    const prev = prevMap[key];
    if (prev && !alertKeys.has(key) && !results.some(r => r.personKey === key && r.type === 'NEW')) {
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
