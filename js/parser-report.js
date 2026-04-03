/**
 * parser-report.js - 業務報告書（.xlsx）パーサー
 *
 * ★ 実際のシート構造（調査済み）:
 *
 * 社員名簿＆査定シートの1人分ブロック例（折原 浩, 行75〜92）:
 *
 *   R75 A(c=0): "氏名"    F(c=5): "ふりがな"  K(c=10): "生年月日"  T(c=19): "役職"
 *   R76 A(c=0): "折原　浩"  F(c=5): "おりはら…"             T(c=19): "業務委託"
 *   R77 A(c=0): "現住所"
 *   R78 A(c=0): "埼玉県…"
 *   R80 A(c=0): "基本給"  E(c=4): "大入り"
 *   R81 A(c=0): 26         D(c=3): "万"
 *   R84 A(c=0): "昇給希望額"  E(c=4): "日払い"
 *   R85 A(c=0): 0           D(c=3): "万"   E(c=4): 0   H(c=7): "円"
 *
 * つまり:
 *   - 「氏名」ラベル: A列(c=0)
 *   - 氏名の値:       次の行のA列(c=0)
 *   - 役職の値:       氏名ラベル行と同じ行のT列(c=19) ← ヘッダー行に「役職」があり値もその行
 *                     実際は: ヘッダー行(R75)のT列="役職", 値行(R76)のT列="業務委託"
 *   - 「基本給」ラベル: A列(c=0)、ブロック内に出現
 *   - 基本給の値:       「基本給」ラベルの次の行のA列(c=0)
 *   - 「日払い」ラベル: E列(c=4)、「昇給希望額」ラベルと同じ行
 *   - 日払いの値:       「日払い」ラベルの次の行のE列(c=4)
 */

'use strict';

const ROSTER_SHEET_NAMES = ['社員名簿＆査定', '社員名簿&査定', '社員名簿', '名簿'];

const EXCLUDE_SHEET_PATTERNS = [
  /^[①②③④⑤⑥⑦⑧⑨⑩]/,
  /^ルール$/,
  /^\d{4}\.\d{1,2}$/,
  /^社員名簿/,
  /^名簿/,
  /^管理/,
  /^テンプレ/
];

// 列インデックス定数（調査結果より）
const COL_NAME     = 0;   // A列: 氏名ラベル・氏名値・基本給ラベル・基本給値
const COL_ROLE     = 19;  // T列: 役職ラベル・役職値

// 個人タブの件名行（C12）の位置定数
const PERSON_NAME_ROW = 11; // row index (0始まり) = 12行目
const PERSON_NAME_COL = 2;  // col index (0始まり) = C列
const COL_DAILY    = 4;   // E列: 日払いラベル・日払い値

// 個人タブの明細で「その他」とみなさない既知の業務内容ラベル
const KNOWN_DETAIL_LABELS = ['業務報酬', '大入手当', '大入り手当', '事務所レンタル料', '事務所レント', '日払い', '日払'];

// 明細行の検索範囲（個人タブ内）
const DETAIL_SEARCH_START = 10; // 行インデックス（0始まり）
const DETAIL_SEARCH_END   = 60;

async function parseReport(buffer) {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: false });
  const warnings = [];
  let contractors = [];

  const rosterSheet = findRosterSheet(wb);
  if (!rosterSheet) {
    warnings.push({ level: 'error', message: '「社員名簿＆査定」シートが見つかりません。' });
    return { contractors, warnings };
  }

  const { people, warnings: rosterWarnings } = extractContractorsFromRoster(wb.Sheets[rosterSheet]);
  warnings.push(...(rosterWarnings || []));

  for (const person of people) {
    const bankResult = extractBankFromPersonSheet(wb, person.name);
    person.bank          = bankResult.bank;
    person.sheetName     = bankResult.sheetName || null;
    person.companyName        = bankResult.companyName        ?? null;
    person.representativeName = bankResult.representativeName ?? null;
    person.officeRentYen = bankResult.officeRentYen ?? 0;
    person.otherItems    = bankResult.otherItems  ?? [];
    if (bankResult.warnings.length) {
      warnings.push(...bankResult.warnings.map(w => ({ ...w, person: person.name })));
    }
    contractors.push(person);
  }

  return { contractors, warnings };
}

function findRosterSheet(wb) {
  for (const name of ROSTER_SHEET_NAMES) {
    if (wb.SheetNames.includes(name)) return name;
  }
  return wb.SheetNames.find(n => n.includes('社員') || n.includes('名簿')) || null;
}

/**
 * 社員名簿＆査定シートから業務委託者を抽出
 *
 * ブロック構造:
 *   - A列(c=0) に "氏名" がある行 → ブロックのヘッダー行
 *   - ヘッダー行の次の行に氏名値(A列)・役職値(T列=c=19)がある
 *   - ブロック内のA列に "基本給" がある行の次の行A列 → 基本給値（万円）
 *   - ブロック内のE列(c=4) に "日払い" がある行の次の行E列(c=4) → 日払い値（円）
 */
function extractContractorsFromRoster(ws) {
  const warnings = [];
  const people = [];

  if (!ws || !ws['!ref']) {
    warnings.push({ level: 'error', message: '社員名簿シートが空です。' });
    return { people, warnings };
  }

  const range = XLSX.utils.decode_range(ws['!ref']);
  const maxRow = range.e.r;

  // A列(c=0) に「氏名」があるブロック開始行を収集
  const blockHeaderRows = [];
  for (let r = range.s.r; r <= maxRow; r++) {
    const v = normText(String(getCellValue(ws, r, COL_NAME) ?? ''));
    if (v === '氏名' || v === '氏　名') {
      blockHeaderRows.push(r);
    }
  }

  if (blockHeaderRows.length === 0) {
    warnings.push({ level: 'warn', message: '社員名簿シートに「氏名」ブロックが見つかりません。' });
    return { people, warnings };
  }

  for (let bi = 0; bi < blockHeaderRows.length; bi++) {
    const headerRow = blockHeaderRows[bi];
    const nextBlockStart = bi + 1 < blockHeaderRows.length ? blockHeaderRows[bi + 1] : maxRow + 1;
    const blockEnd = nextBlockStart - 1;

    // ★ 氏名の値: ヘッダー行の次の行のA列(c=0)
    const nameRow = headerRow + 1;
    const personName = normText(String(getCellValue(ws, nameRow, COL_NAME) ?? ''));
    if (!personName) continue;

    // ★ 役職の値: 氏名と同じ行(nameRow)のT列(c=19)
    const roleRaw = normText(String(getCellValue(ws, nameRow, COL_ROLE) ?? ''));

    // ★ 基本給の値: ブロック内でA列(c=0)に「基本給」が出現する行の次の行のA列
    let basicPayMan = 0;
    for (let r = headerRow; r <= blockEnd; r++) {
      const v = normText(String(getCellValue(ws, r, COL_NAME) ?? ''));
      if (v === '基本給' || v === '基　本　給') {
        // 次の行のA列が数値
        const val = getCellValue(ws, r + 1, COL_NAME);
        if (val !== null && val !== undefined && val !== '') {
          basicPayMan = parseFloat(val) || 0;
        }
        break;
      }
    }

    // ★ 日払いの値: ブロック内でE列(c=4)に「日払い」が出現する行の次の行のE列
    let dailyPayYen = 0;
    for (let r = headerRow; r <= blockEnd; r++) {
      const v = normText(String(getCellValue(ws, r, COL_DAILY) ?? ''));
      if (v === '日払い' || v === '日払') {
        const val = getCellValue(ws, r + 1, COL_DAILY);
        if (val !== null && val !== undefined && val !== '') {
          dailyPayYen = parseFloat(val) || 0;
        }
        break;
      }
    }

    // ★ 大入りの値: ブロック内でE列(c=4)に「大入り」が出現する行の次の行のE列
    let oiriMan = 0;  // 大入り（万円単位）
    for (let r = headerRow; r <= blockEnd; r++) {
      const v = normText(String(getCellValue(ws, r, COL_DAILY) ?? ''));
      if (v === '大入り' || v === '大入') {
        const val = getCellValue(ws, r + 1, COL_DAILY);
        if (val !== null && val !== undefined && val !== '') {
          oiriMan = parseFloat(val) || 0;
        }
        break;
      }
    }

    // ★ 昇給希望額: ブロック内でA列(c=0)に「昇給希望額」が出現する行の次の行のA列
    let raiseRequestMan = 0;
    for (let r = headerRow; r <= blockEnd; r++) {
      const v = normText(String(getCellValue(ws, r, COL_NAME) ?? ''));
      if (v.includes('昇給希望')) {
        const val = getCellValue(ws, r + 1, COL_NAME);
        if (val !== null && val !== undefined && val !== '') {
          raiseRequestMan = parseFloat(val) || 0;
        }
        break;
      }
    }

    // ★ ふりがな (F列=5)
    const furigana = normText(String(getCellValue(ws, nameRow, 5) ?? ''));
    // ★ 生年月日 (K列=10)
    const birthdate = getCellValue(ws, nameRow, 10) ?? '';
    // ★ 現住所 (nameRow+2 のA列が現住所ラベル、nameRow+3 が値)
    let address = '';
    for (let r = headerRow; r <= Math.min(headerRow + 6, blockEnd); r++) {
      const v = normText(String(getCellValue(ws, r, COL_NAME) ?? ''));
      if (v === '現住所') {
        address = normText(String(getCellValue(ws, r + 1, COL_NAME) ?? ''));
        break;
      }
    }

    people.push({
      name: personName,
      furigana,
      birthdate,
      address,
      role: roleRaw,
      basicPayMan,
      raiseRequestMan,
      oiriMan,
      dailyPayYen,
      officeRentYen: 0,   // 個人タブから後で取得
      otherItems: [],      // 個人タブから後で取得
      bank: null,
      warnings: []
    });
  }

  return { people, warnings };
}

// ─────────────────────────────────────────────
// 以下、口座情報取得（変更なし）
// ─────────────────────────────────────────────

function extractBankFromPersonSheet(wb, personName) {
  const warnings = [];
  const emptyBank = {
    bankName: '', branchName: '', accountType: '',
    accountNumber: '', accountHolderKana: ''
  };

  // まず全個人タブをスキャンしてC12の氏名で完全一致検索
  const sheetName = findSheetByPersonName(wb, personName)
                 || findSheetBySurname(wb, getSurname(personName));

  if (!sheetName) {
    warnings.push({
      level: 'warn',
      message: `個人タブ「${personName}」が見つかりません（口座情報未取得）`,
      code: 'SHEET_NOT_FOUND'
    });
    return { bank: emptyBank, sheetName: null, warnings };
  }

  const ws = wb.Sheets[sheetName];
  if (!ws || !ws['!ref']) {
    warnings.push({ level: 'warn', message: `個人タブ「${sheetName}」が空です`, code: 'SHEET_EMPTY' });
    return { bank: emptyBank, sheetName, warnings };
  }

  const furikomiCell = findCellContaining(ws, 'お振込先');
  if (!furikomiCell) {
    warnings.push({
      level: 'warn',
      message: `「${sheetName}」タブに「お振込先」が見つかりません`,
      code: 'BANK_BLOCK_NOT_FOUND'
    });
    return { bank: emptyBank, sheetName, warnings };
  }

  const bank = extractBankBlock(ws, furikomiCell.r, furikomiCell.c);

  const missing = [];
  if (!bank.bankName) missing.push('銀行名');
  if (!bank.branchName) missing.push('支店名');
  if (!bank.accountNumber) missing.push('口座番号');
  if (!bank.accountHolderKana) missing.push('名義カナ');

  if (missing.length > 0) {
    warnings.push({
      level: 'warn',
      message: `口座情報が一部不足（欠け: ${missing.join(', ')}）`,
      code: 'BANK_INCOMPLETE'
    });
  }

  // ── 個人タブの明細から事務所レンタル料・その他を取得 ──
  const { officeRentYen, otherItems } = extractDetailItems(ws);

  const { companyName, representativeName } = extractCompanyAndDate(ws);
  return { bank, sheetName, officeRentYen, otherItems, companyName, representativeName, warnings };
}

// C12検索用除外パターン（丸数字シートは除外しない＝C12で氏名を持つ個人タブを検索対象にする）
const EXCLUDE_FOR_C12_SEARCH = [
  /^ルール$/,
  /^\d{4}\.\d{1,2}$/,   // 年月シート
  /^社員名簿/,
  /^名簿/,
  /^管理/,
  /^テンプレ/
];

/**
 * 全個人タブをスキャンして、C12セルの氏名が personName と一致するシートを返す
 * 完全一致優先 → 苗字一致でフォールバック
 * ※ 丸数字（①②…）シートも検索対象に含める
 */
function findSheetByPersonName(wb, personName) {
  const normTarget = normText(personName);
  if (!normTarget) return null;

  // 「件名」行（PERSON_NAME_ROW=11）のC列（PERSON_NAME_COL=2）を読む
  for (const name of wb.SheetNames) {
    if (EXCLUDE_FOR_C12_SEARCH.some(pat => pat.test(name))) continue;
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const cellVal = normText(String(getCellValue(ws, PERSON_NAME_ROW, PERSON_NAME_COL) ?? ''));
    if (!cellVal) continue;
    // 完全一致（スペース正規化後）
    if (cellVal === normTarget) return name;
    // 苗字が一致
    const cellSurname = getSurname(cellVal);
    const targetSurname = getSurname(normTarget);
    if (cellSurname && targetSurname && cellSurname === targetSurname) return name;
  }
  return null;
}

function findSheetBySurname(wb, surname) {
  const normSurname = normText(surname);
  // 苗字が空の場合はマッチさせない
  if (!normSurname) return null;

  // パス1: シート名と苗字が完全一致
  for (const name of wb.SheetNames) {
    if (EXCLUDE_SHEET_PATTERNS.some(pat => pat.test(name))) continue;
    if (normText(name) === normSurname) return name;
  }

  // パス2: シート名が苗字を含む（例: "★能條" に "能條" が含まれる）
  // ただし苗字がシート名に含まれる逆方向マッチは禁止
  // （例: 苗字"原" が シート名"折原" に含まれるのは誤マッチ）
  for (const name of wb.SheetNames) {
    if (EXCLUDE_SHEET_PATTERNS.some(pat => pat.test(name))) continue;
    const normName = normText(name);
    // シート名が苗字を含む場合のみ（苗字 2文字以上を要求して短すぎる苗字の誤マッチを減らす）
    if (normName.includes(normSurname) && normSurname.length >= 2) return name;
  }

  // パス3: 苗字がシート名を含む（シート名が苗字の略称の場合、2文字以上）
  for (const name of wb.SheetNames) {
    if (EXCLUDE_SHEET_PATTERNS.some(pat => pat.test(name))) continue;
    const normName = normText(name);
    if (normSurname.includes(normName) && normName.length >= 2) return name;
  }

  return null;
}

/**
 * 「お振込先」ラベルを起点に口座情報を読み取る
 *
 * 調査済み構造（折原タブ R38〜R42）:
 *   R38 A: "お振込先："  B: "セブン銀行"
 *   R39                  B: "カトレア支店(111)"
 *   R40                  B: "普通"  C: "0704011"
 *   R41                  B: "名義（カナ）"  C: "オリハラ　ヒロシ"
 */
function extractBankBlock(ws, startRow, startCol) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  const maxRow = Math.min(startRow + 15, range.e.r);

  let bankName = '';
  let branchName = '';
  let accountType = '';
  let accountNumber = '';
  let accountHolderKana = '';

  // お振込先ラベルの行: B列(startCol+1)が銀行名
  const r0v = normText(String(getCellValue(ws, startRow, startCol + 1) ?? ''));
  if (r0v && !r0v.includes('お振込') && !r0v.includes('振込先')) {
    bankName = r0v;
  }

  // 以降の行をスキャン（startRow+1〜+8行）
  for (let r = startRow + 1; r <= Math.min(startRow + 8, maxRow); r++) {
    // B列(startCol+1)から読む
    for (let dc = 1; dc <= 4; dc++) {
      const v = normText(String(getCellValue(ws, r, startCol + dc) ?? ''));
      if (!v) continue;

      // 銀行名（まだなければ）
      if (!bankName && !isLabelText(v)) {
        bankName = v;
        continue;
      }

      // 支店名
      if (!branchName && v.includes('支店')) {
        branchName = v;
        continue;
      }

      // 名義ラベル
      if (v.includes('名義') || v === 'カナ') {
        // 右隣が名義値（ラベルテキストでなければ採用）
        const right = normText(String(getCellValue(ws, r, startCol + dc + 1) ?? ''));
        if (right && !right.includes('名義') && right !== 'カナ' && !isLabelText(right)) {
          accountHolderKana = right;
        }
        continue;
      }

      // 口座種別
      if ((v === '普通' || v === '当座' || v === '貯蓄') && !accountType) {
        accountType = v;
        // 右隣が口座番号
        const right = normText(String(getCellValue(ws, r, startCol + dc + 1) ?? ''));
        if (right && /^\d+$/.test(right)) {
          accountNumber = right;
        }
        continue;
      }

      // 口座番号（数字のみ）
      if (!accountNumber && /^\d{6,8}$/.test(v)) {
        accountNumber = v;
        continue;
      }
    }
  }

  return { bankName, branchName, accountType, accountNumber, accountHolderKana };
}

function isLabelText(v) {
  const labels = ['お振込先', '振込先', '銀行', '支店', '種別', '口座', '名義', '事業者', '登録番号'];
  return labels.some(l => v.includes(l));
}

/**
 * 個人タブの明細行から事務所レンタル料・その他項目を抽出
 *
 * 明細の構造（想定）:
 *   A列 or B列: 業務内容ラベル（業務報酬、大入手当、事務所レンタル料 など）
 *   右隣の列:   金額（数値）
 *
 * 既知ラベル（KNOWN_DETAIL_LABELS）以外のラベル＋金額を「その他」として収集
 */
function extractDetailItems(ws) {
  let officeRentYen = 0;
  const otherItems  = [];

  if (!ws || !ws['!ref']) return { officeRentYen, otherItems };

  const range = XLSX.utils.decode_range(ws['!ref']);
  const endRow = Math.min(DETAIL_SEARCH_END, range.e.r);

  for (let r = DETAIL_SEARCH_START; r <= endRow; r++) {
    // A〜D列を走査してラベルを探す
    for (let c = 0; c <= 3; c++) {
      const label = normText(String(getCellValue(ws, r, c) ?? ''));
      if (!label || label.length < 2) continue;

      // 事務所レンタル料
      if (label.includes('事務所') && (label.includes('レンタル') || label.includes('レント'))) {
        // 同じ行の右側から金額を探す
        const amt = findAmountInRow(ws, r, c + 1, range.e.c);
        if (amt !== null) officeRentYen = amt;
        break;
      }

      // その他: 既知ラベル以外で明細っぽいもの
      const isKnown = KNOWN_DETAIL_LABELS.some(kl => label.includes(kl));
      if (!isKnown && isDetailLabel(label)) {
        const amt = findAmountInRow(ws, r, c + 1, range.e.c);
        if (amt !== null && amt !== 0) {
          // 重複チェック
          if (!otherItems.some(o => o.label === label)) {
            otherItems.push({ label, amount: amt });
          }
        }
        break;
      }
    }
  }

  return { officeRentYen, otherItems };
}

/**
 * 個人タブから会社名・明細日付を取得
 * 個人タブの先頭付近（行0〜30）に「株式会社」「有限会社」等が含まれるセルを会社名とみなす
 * 日付は「年」を含む数値セルまたは日付セルを探す
 */
function extractCompanyAndDate(ws) {
  if (!ws || !ws['!ref']) return { companyName: null, representativeName: null };
  const range = XLSX.utils.decode_range(ws['!ref']);
  const endRow = Math.min(30, range.e.r);
  let companyName = null;
  let representativeName = null;

  for (let r = 0; r <= endRow; r++) {
    for (let c = 0; c <= range.e.c; c++) {
      const v = getCellValue(ws, r, c);
      if (!v) continue;
      const s = String(v).trim();

      // 会社名: 株式会社・有限会社・合同会社 等を含む
      if (!companyName && /株式会社|有限会社|合同会社|合名会社|合資会社/.test(s)) {
        companyName = s;
      }

      // 代表者名: 「代表取締役」「取締役」「代表」などを含むセル
      if (!representativeName && /代表取締役|取締役|代表社員|代表/.test(s)) {
        // 「様」を除去してトリム
        representativeName = s.replace(/\s*様\s*$/, '').trim();
      }
    }
    if (companyName && representativeName) break;
  }
  return { companyName, representativeName };
}

/** 行の指定列以降を走査して最初に見つかった数値を返す */
function findAmountInRow(ws, row, startCol, endCol) {
  for (let c = startCol; c <= Math.min(startCol + 5, endCol); c++) {
    const val = getCellValue(ws, row, c);
    if (val !== null && val !== undefined && val !== '' && !isNaN(parseFloat(val))) {
      return parseFloat(val);
    }
  }
  return null;
}

/** 明細ラベルらしい文字列かどうか判定（短すぎる・数字のみ・記号のみ・合計行は除外） */
function isDetailLabel(v) {
  if (!v || v.length < 2) return false;
  if (/^\d+$/.test(v)) return false;           // 数字のみ
  if (/^[¥￥\-=＝]+$/.test(v)) return false;  // 記号のみ
  // 合計・小計・計 などの集計行は除外
  if (/^(合計|小計|総計|計|subtotal|total)/i.test(v)) return false;
  if (v === '合計' || v === '小計' || v === '計') return false;
  if (v.includes('氏名') || v.includes('住所') || v.includes('生年')) return false;
  // 業務・手当・料・費・金 などを含む場合は明細ラベルとみなす
  return /[業務手当料費金払給賞報酬]/.test(v);
}

// ==============================
// 業務報告書サマリー抽出
// ==============================

/**
 * 日付シート（例: "2024.12"）から業務報告書のサマリーを抽出する
 * 抽出対象:
 *   - A13: "報告事項・当月の売上について・問題点" ラベル → A14 が内容
 *   - A24: "課題・対策・目標へのアプローチ" ラベル → A25 が内容
 *   - A51: "報告事項" ラベル → A52 が内容
 *   - エリア: F5、報告者: M5
 */
function extractReportSummary(ws) {
  if (!ws || !ws['!ref']) return null;

  const range = XLSX.utils.decode_range(ws['!ref']);
  const maxRow = range.e.r;

  // エリア・報告者
  const area     = normText(String(getCellValue(ws, 4, 5) ?? ''));   // F5
  const reporter = normText(String(getCellValue(ws, 4, 12) ?? '')); // M5

  // ラベルを検索して次の行の値を取得するユーティリティ
  function findSectionContent(labelPattern, contentCol = 0) {
    for (let r = 0; r <= maxRow; r++) {
      const v = normText(String(getCellValue(ws, r, 0) ?? ''));
      if (labelPattern.test(v)) {
        // 次の行から内容を取得（空行をスキップしながら最初の非空セルを結合）
        const lines = [];
        for (let rr = r + 1; rr <= Math.min(r + 15, maxRow); rr++) {
          const cellVal = getCellValue(ws, rr, contentCol);
          if (cellVal !== null && cellVal !== undefined && String(cellVal).trim()) {
            lines.push(String(cellVal).trim());
          } else if (lines.length > 0) {
            // 一度内容が始まったら空行で終了
            break;
          }
        }
        return lines.join('\n') || null;
      }
    }
    return null;
  }

  const salesReport  = findSectionContent(/報告事項[・・]当月の売上/);
  const challenges   = findSectionContent(/課題[・・]対策[・・]目標/);
  const miscReport   = findSectionContent(/^報告事項$/);

  return { area, reporter, salesReport, challenges, miscReport };
}

/**
 * 社員名簿＆査定シートから各スタッフの「今後の課題」を抽出する
 * T列(c=19)に「今後の課題」ラベルがある行の次の行T列が内容
 */
function extractStaffChallenges(ws) {
  if (!ws || !ws['!ref']) return [];

  const range = XLSX.utils.decode_range(ws['!ref']);
  const maxRow = range.e.r;
  const COL_T = 19; // T列

  const results = [];

  // A列(c=0)に「氏名」ラベル → 氏名値を取得するブロック構造を利用
  const blockHeaderRows = [];
  for (let r = range.s.r; r <= maxRow; r++) {
    const v = normText(String(getCellValue(ws, r, 0) ?? ''));
    if (v === '氏名' || v === '氏　名') {
      blockHeaderRows.push(r);
    }
  }

  for (let bi = 0; bi < blockHeaderRows.length; bi++) {
    const headerRow = blockHeaderRows[bi];
    const nextBlockStart = bi + 1 < blockHeaderRows.length ? blockHeaderRows[bi + 1] : maxRow + 1;
    const blockEnd = nextBlockStart - 1;

    const nameRow = headerRow + 1;
    const personName = normText(String(getCellValue(ws, nameRow, 0) ?? ''));
    if (!personName) continue;

    // ブロック内でT列(c=19)に「今後の課題」または「昇給理由」ラベルを探す
    let challenge = null;
    let challengeLabel = '今後の課題';
    for (let r = headerRow; r <= blockEnd; r++) {
      const v = normText(String(getCellValue(ws, r, COL_T) ?? ''));
      if (v === '今後の課題' || v.includes('今後の課題')) {
        challengeLabel = '今後の課題';
        const val = getCellValue(ws, r + 1, COL_T);
        if (val !== null && val !== undefined && String(val).trim()) {
          challenge = String(val).trim();
        }
        break;
      } else if (v === '昇給理由' || v.includes('昇給理由')) {
        challengeLabel = '昇給理由';
        const val = getCellValue(ws, r + 1, COL_T);
        if (val !== null && val !== undefined && String(val).trim()) {
          challenge = String(val).trim();
        }
        break;
      }
    }

    // 役職取得 (T列 nameRow)
    const role = normText(String(getCellValue(ws, nameRow, COL_T) ?? ''));

    results.push({ name: personName, role, challenge, challengeLabel });
  }

  return results;
}

/**
 * 業務報告書バッファからサマリーと課題を一括抽出
 */
async function parseReportSummary(buffer) {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: false });

  // 日付シート（例: 2024.12）を検索
  const dateSheetName = wb.SheetNames.find(n => /^\d{4}\.\d{1,2}$/.test(n.trim()));
  const reportSummary = dateSheetName ? extractReportSummary(wb.Sheets[dateSheetName]) : null;

  // 社員名簿シートを検索
  const rosterName = wb.SheetNames.find(n =>
    ['社員名簿＆査定', '社員名簿&査定', '社員名簿', '名簿'].includes(n) ||
    n.includes('社員') || n.includes('名簿')
  );
  const staffChallenges = rosterName ? extractStaffChallenges(wb.Sheets[rosterName]) : [];

  return { reportSummary, staffChallenges, dateSheetName, rosterName };
}
