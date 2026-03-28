/**
 * parser-monthly.js - 月計表（.xls/.xlsx）パーサー
 * 
 * ★★★ 重要な設計方針 ★★★
 * 月計表の科目欄から取れる人物名は「DR能條」「スタッフ折原」などの
 * 不完全な文字列です。
 * このパーサーは【元データの文字列だけを使用】し、
 * フルネームへの補完・変換・推測は一切行いません。
 * 
 * 抽出結果の personRawLabel には「DR能條　日払い」などの
 * 元の科目文字列をそのまま保持し、
 * personKey には接頭辞と「日払」を除去した正規化名のみ入れます。
 * personName は personKey と同値（補完なし）です。
 * 
 * 処理内容：
 * 1. 「月計表」シートを特定
 * 2. 「取引入力」セクションを探索
 * 3. 「取引入力」セクション内のヘッダー行（科目/出金[円]等）を検出
 * 4. 日払い行（科目に「日払」「日払い」を含む）を抽出
 * 5. 出金[円]列から金額を取得
 */

'use strict';

// 月計表シート名の候補
const MONTHLY_SHEET_NAMES = ['月計表', '月計', '月次'];

// ヘッダー同義語辞書
const SUBJECT_SYNONYMS = ['科目', '摘要', '内容', '項目'];
const INCOME_SYNONYMS = ['入金', '入金[円]', '入金(円)', '収入'];
const EXPENSE_SYNONYMS = ['出金', '出金[円]', '出金(円)', '支出', '支払', '支払額', '出費'];

/**
 * 月計表Excelを解析して日払い一覧を返す
 * @param {ArrayBuffer} buffer
 * @returns {{ dailyPayEntries: Array, warnings: Array }}
 * 
 * dailyPayEntries の各要素:
 * {
 *   personRawLabel: string,  // 元の科目文字列（例: "DR能條　日払い"）
 *   personKey: string,       // 正規化名（接頭辞・日払除去後）（例: "能條"）
 *   personName: string,      // personKey と同じ（補完なし）
 *   dailyPayYen: number,     // 出金[円]列の金額
 *   rowIdx: number           // デバッグ用行インデックス
 * }
 */
async function parseMonthly(buffer) {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: false });
  const warnings = [];
  let dailyPayEntries = [];

  // Step1: 月計表シートを特定
  const monthlySheetName = findMonthlySheet(wb);
  if (!monthlySheetName) {
    warnings.push({ level: 'error', message: '「月計表」シートが見つかりません。' });
    return { dailyPayEntries, warnings };
  }

  const ws = wb.Sheets[monthlySheetName];
  if (!ws || !ws['!ref']) {
    warnings.push({ level: 'error', message: '「月計表」シートが空です。' });
    return { dailyPayEntries, warnings };
  }

  // Step2: 「取引入力」セクションを探索
  const torihikiCell = findCellContaining(ws, '取引入力');
  if (!torihikiCell) {
    warnings.push({ level: 'warn', message: '月計表に「取引入力」セクションが見つかりません。' });
    return { dailyPayEntries, warnings };
  }

  // Step3: 取引入力セクション内のヘッダー行を検出
  const sectionResult = detectTransactionHeader(ws, torihikiCell.r);
  if (!sectionResult) {
    warnings.push({ level: 'warn', message: '取引入力セクションのヘッダー行が検出できませんでした。' });
    return { dailyPayEntries, warnings };
  }

  const { headerRow, subjectCol, expenseCol, incomeCol } = sectionResult;

  // Step4: 日払い行を抽出
  const range = XLSX.utils.decode_range(ws['!ref']);
  const scanEnd = Math.min(headerRow + 60, range.e.r);

  for (let r = headerRow + 1; r <= scanEnd; r++) {
    const subjectVal = normText(String(getCellValue(ws, r, subjectCol) ?? ''));
    if (!subjectVal) continue;

    // 「日払い」または「日払」を含む行のみ対象
    if (!subjectVal.includes('日払い') && !subjectVal.includes('日払')) continue;

    // 金額を出金列から取得（出金が空なら入金列を確認）
    let amount = 0;
    if (expenseCol >= 0) {
      const expVal = getCellValue(ws, r, expenseCol);
      if (expVal !== null && expVal !== undefined && expVal !== '') {
        amount = Math.abs(parseFloat(expVal) || 0);
      }
    }
    if (amount === 0 && incomeCol >= 0) {
      const incVal = getCellValue(ws, r, incomeCol);
      if (incVal !== null && incVal !== undefined && incVal !== '') {
        amount = Math.abs(parseFloat(incVal) || 0);
      }
    }

    // ★★★ 重要：元データの文字列のまま保持、補完なし ★★★
    const personRawLabel = subjectVal;  // 例: "DR能條　日払い"

    // 接頭辞と「日払」を除去した正規化キー
    const personKey = normalizePersonName(subjectVal);  // 例: "能條"

    // personName = personKey と完全に同値（フルネーム補完は行わない）
    const personName = personKey;

    dailyPayEntries.push({
      personRawLabel,  // 元の文字列
      personKey,       // 正規化名（これが照合キー）
      personName,      // 表示名 = personKey（補完なし）
      dailyPayYen: amount,
      rowIdx: r
    });
  }

  return { dailyPayEntries, warnings };
}

/**
 * 月計表シート名を特定
 */
function findMonthlySheet(wb) {
  for (const name of MONTHLY_SHEET_NAMES) {
    if (wb.SheetNames.includes(name)) return name;
  }
  return wb.SheetNames.find(n => n.includes('月計') || n.includes('月次')) || null;
}

/**
 * 取引入力セクションのヘッダー行と列インデックスを検出
 * @param {object} ws - ワークシート
 * @param {number} sectionStartRow - 「取引入力」ラベルの行
 * @returns {object|null} { headerRow, subjectCol, expenseCol, incomeCol }
 */
function detectTransactionHeader(ws, sectionStartRow) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  const scanEnd = Math.min(sectionStartRow + 10, range.e.r);

  for (let r = sectionStartRow; r <= scanEnd; r++) {
    let subjectCol = -1;
    let expenseCol = -1;
    let incomeCol = -1;
    let foundCount = 0;

    for (let c = 0; c <= range.e.c; c++) {
      const v = normText(String(getCellValue(ws, r, c) ?? ''));
      if (!v) continue;

      // 科目/摘要列
      if (SUBJECT_SYNONYMS.some(s => normText(s) === v || v.includes(s.replace('[', '').replace(']', '').replace('(', '').replace(')', '')))) {
        if (subjectCol === -1) {
          subjectCol = c;
          foundCount++;
        }
      }

      // 出金列
      if (EXPENSE_SYNONYMS.some(s => {
        const ns = normText(s).replace('[', '').replace(']', '').replace('(', '').replace(')', '');
        const nv = v.replace('[', '').replace(']', '').replace('(', '').replace(')', '');
        return ns === nv || v === normText(s);
      })) {
        if (expenseCol === -1) {
          expenseCol = c;
          foundCount++;
        }
      }

      // 入金列
      if (INCOME_SYNONYMS.some(s => {
        const ns = normText(s).replace('[', '').replace(']', '').replace('(', '').replace(')', '');
        const nv = v.replace('[', '').replace(']', '').replace('(', '').replace(')', '');
        return ns === nv || v === normText(s);
      })) {
        if (incomeCol === -1) {
          incomeCol = c;
          foundCount++;
        }
      }
    }

    if (foundCount >= 2 && subjectCol >= 0) {
      return { headerRow: r, subjectCol, expenseCol, incomeCol };
    }
  }

  // ヘッダーが見つからない場合、「取引入力」ラベルの周辺を直接スキャン
  // 科目列は「取引入力」ラベルと同じ列か近くにあると仮定
  return detectTransactionHeaderFallback(ws, sectionStartRow);
}

/**
 * フォールバック: 取引入力行の近くにある「日払」行から列を逆算
 */
function detectTransactionHeaderFallback(ws, sectionStartRow) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  const scanEnd = Math.min(sectionStartRow + 20, range.e.r);

  // 「日払」が最初に出現する行を探し、そこから列位置を確定
  for (let r = sectionStartRow; r <= scanEnd; r++) {
    for (let c = 0; c <= range.e.c; c++) {
      const v = normText(String(getCellValue(ws, r, c) ?? ''));
      if (v.includes('日払')) {
        // この行の列構造を分析
        // 科目列 = c
        // 出金列と入金列は右側に探す
        let expenseCol = -1;
        let incomeCol = -1;

        for (let cc = c + 1; cc <= Math.min(c + 10, range.e.c); cc++) {
          const amt = getCellValue(ws, r, cc);
          if (typeof amt === 'number' && amt !== 0) {
            if (expenseCol === -1) expenseCol = cc;
            else if (incomeCol === -1) incomeCol = cc;
          }
        }

        // ヘッダー行はr-1からさかのぼって探す
        const headerRow = sectionStartRow;
        return { headerRow, subjectCol: c, expenseCol: expenseCol >= 0 ? expenseCol : c + 1, incomeCol };
      }
    }
  }

  // 最終フォールバック: 取引入力ラベルの位置を基準に固定列を返す
  const torihikiCell = findCellContaining(ws, '取引入力');
  if (torihikiCell) {
    return {
      headerRow: torihikiCell.r,
      subjectCol: torihikiCell.c,    // 科目列
      expenseCol: torihikiCell.c + 1, // 出金列（右隣）
      incomeCol: torihikiCell.c + 2   // 入金列
    };
  }

  return null;
}
