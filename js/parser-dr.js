/**
 * parser-dr.js - DR距離計算フォーマット（.xlsx）パーサー
 *
 * ★ 実際のシート構造（調査済み）:
 *
 * 【個人タブ（加藤・★能條・石割 等）】 ← 42行 × 8列
 *   R1  F列(c=5): 対象年月シリアル値
 *   R12 B列(c=1): "件名"  C列(c=2): 氏名（例:"加藤　忠治"）
 *   R13 B列(c=1): "合計金額"  C列(c=2): 合計金額
 *   R17 ヘッダー行: 業務内容/対象月/請負金額/料率/数量/単価/金額
 *   R18 A列: "ドライバー報酬"  H列(c=7): 報酬金額
 *   R19 A列: "仮払精算"        H列(c=7): 仮払額（マイナス。絶対値=日払い額）
 *   R20 A列: "適格請求支払手数料"
 *   R28 A列: "合      計"     H列(c=7): 合計金額
 *   R38 A列: "お振込先："     B列(c=1): 銀行名
 *   R39                        B列(c=1): 支店名
 *   R40                        B列(c=1): 口座種別  C列(c=2): 口座番号
 *   R41                        B列(c=1): "名義（カナ）"  C列(c=2): 名義カナ
 *
 * 【入力シート】← 各DRの日次データ＋集計
 *   R4  B列(c=1): "氏名"  C列(c=2): DR1名前
 *       K列(c=10): "氏名" L列(c=11): DR2名前  ...（9列おきに次のDR）
 *   R38 I列(c=8): DR1賃金（報酬）合計
 *   R41 G列(c=6): "日払い"  H列(c=7): 日払い単価  I列(c=8): 日払い合計
 *       P列(c=15): "日払い" Q列(c=16): 日払い単価  R列(c=17): 日払い合計（DR2）
 *   ※ 各DRブロックは約47行間隔で繰り返す
 *
 * 突合の考え方:
 *   - 個人タブの「仮払精算」H列の絶対値 = その人への日払い額
 *   - 月計表の「DR〇〇 日払い」出金額と照合
 */

'use strict';

// DRファイルで除外するシート
const DR_EXCLUDE_SHEETS = ['ルール', 'シフト', '入力'];
// 数字（半角・全角）や丸数字で始まるシートは空欄テンプレとして除外
// ※ 漢数字（一二三…）は苗字の可能性があるため除外しない
const DR_EXCLUDE_PATTERN = /^[0-9０-９①-⑳]/;

// 個人タブの固定行（調査済み）
const DR_ROW_NAME       = 11; // R12 → index 11: 氏名行
const DR_COL_NAME       = 2;  // C列(c=2): 氏名値
const DR_ROW_DETAIL_HDR = 16; // R17 → index 16: 明細ヘッダー行
const DR_COL_AMOUNT     = 7;  // H列(c=7): 金額列

/**
 * DRファイルを解析してDRリストを返す
 * @param {ArrayBuffer} buffer
 * @returns {{ drList: Array, warnings: Array }}
 *
 * drList の各要素:
 * {
 *   name: string,           // 氏名（元データ）
 *   sheetName: string,      // シート名
 *   driverReward: number,   // ドライバー報酬
 *   karibaraiYen: number,   // 仮払精算額（絶対値＝日払い額）
 *   totalAmount: number,    // 合計金額
 *   bank: object,           // 口座情報
 *   warnings: Array
 * }
 */
async function parseDR(buffer) {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: false });
  const warnings = [];
  const drList = [];

  // 個人タブを特定（除外シート以外）
  const personalSheets = wb.SheetNames.filter(name => {
    if (DR_EXCLUDE_SHEETS.includes(name)) return false;
    if (DR_EXCLUDE_PATTERN.test(name)) return false;
    return true;
  });

  for (const sheetName of personalSheets) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws['!ref']) continue;

    const result = parseDRPersonalSheet(ws, sheetName);
    if (!result) continue;

    if (result.warnings.length) {
      warnings.push(...result.warnings.map(w => ({ ...w, sheet: sheetName })));
    }
    drList.push(result);
  }

  if (drList.length === 0) {
    warnings.push({ level: 'warn', message: 'DRの個人タブが見つかりませんでした。' });
  }

  return { drList, warnings };
}

/**
 * DR個人タブを解析
 * @returns {object|null}
 */
function parseDRPersonalSheet(ws, sheetName) {
  const warnings = [];
  const range = XLSX.utils.decode_range(ws['!ref']);

  // ★ 氏名: R12(index=11) C列(c=2)
  const nameRaw = normText(String(getCellValue(ws, DR_ROW_NAME, DR_COL_NAME) ?? ''));
  if (!nameRaw) return null; // 空シートはスキップ

  // ★ 明細行を走査（R18〜R28: index 17〜27）
  let driverReward = 0;
  let karibaraiYen = 0;  // 仮払精算の絶対値 = 日払い額
  let actualFee    = 0;  // 適格請求支払手数料の実額
  let totalAmount  = 0;

  for (let r = DR_ROW_DETAIL_HDR + 1; r <= Math.min(range.e.r, 35); r++) {
    const descRaw = normText(String(getCellValue(ws, r, 0) ?? ''));
    const amtRaw  = getCellValue(ws, r, DR_COL_AMOUNT);
    const amt     = parseFloat(amtRaw) || 0;

    if (descRaw.includes('ドライバー報酬') || descRaw.includes('DR報酬')) {
      driverReward = Math.round(amt);
    } else if (descRaw.includes('仮払精算') || descRaw.includes('仮払い精算')) {
      // 仮払精算はマイナスで記載 → 絶対値が日払い額
      karibaraiYen = Math.round(Math.abs(amt));
    } else if (descRaw.includes('適格請求支払手数料')) {
      actualFee = Math.round(Math.abs(amt));
    } else if (descRaw.includes('合') && descRaw.replace(/\s/g,'').includes('計')) {
      totalAmount = Math.round(Math.abs(amt));
    }
  }

  // 「合計」行（R28=index27）を再確認
  const totalAmt = getCellValue(ws, 27, DR_COL_AMOUNT);
  if (totalAmt !== null && totalAmt !== undefined) {
    totalAmount = Math.round(Math.abs(parseFloat(totalAmt) || 0));
  }

  // ★ 口座情報: R38〜R41（index 37〜40）
  const bank = extractDRBankBlock(ws);

  // ★ 会社名・代表者名（業務報告書と同じロジック）
  const range2 = XLSX.utils.decode_range(ws['!ref']);
  const endRow2 = Math.min(30, range2.e.r);
  let companyName = null, representativeName = null;
  for (let r2 = 0; r2 <= endRow2; r2++) {
    for (let c2 = 0; c2 <= range2.e.c; c2++) {
      const v2 = getCellValue(ws, r2, c2);
      if (!v2) continue;
      const s2 = String(v2).trim();
      if (!companyName && /株式会社|有限会社|合同会社|合名会社|合資会社|Plus/.test(s2)) companyName = s2;
      if (!representativeName && /代表取締役|取締役|代表社員|代表/.test(s2))
        representativeName = s2.replace(/\s*様\s*$/, '').trim();
    }
    if (companyName && representativeName) break;
  }

  // 氏名の検証
  if (!nameRaw) {
    warnings.push({ level: 'warn', message: `シート「${sheetName}」に氏名が見つかりません`, code: 'NAME_NOT_FOUND' });
    return null;
  }

  return {
    name: nameRaw,
    sheetName,
    driverReward,
    karibaraiYen,
    actualFee,
    totalAmount,
    bank,
    companyName,
    representativeName,
    warnings
  };
}

/**
 * DR個人タブの口座情報を取得（R38〜R41）
 * R38 A: "お振込先："  B: 銀行名
 * R39                  B: 支店名
 * R40                  B: 口座種別  C: 口座番号
 * R41                  B: "名義（カナ）"  C: 名義カナ
 */
function extractDRBankBlock(ws) {
  const bank = {
    bankName: '', branchName: '', accountType: '',
    accountNumber: '', accountHolderKana: ''
  };

  // 「お振込先」ラベルを探索（固定行 R38=index37 付近）
  const furikomiCell = findCellContaining(ws, 'お振込先');
  if (!furikomiCell) return bank;

  const sr = furikomiCell.r;
  const sc = furikomiCell.c;

  // R38 B列: 銀行名
  bank.bankName     = normText(String(getCellValue(ws, sr,   sc+1) ?? ''));
  // R39 B列: 支店名
  bank.branchName   = normText(String(getCellValue(ws, sr+1, sc+1) ?? ''));
  // R40 B列: 種別  C列: 口座番号
  bank.accountType   = normText(String(getCellValue(ws, sr+2, sc+1) ?? ''));
  bank.accountNumber = normText(String(getCellValue(ws, sr+2, sc+2) ?? ''));
  // R41 B列: "名義（カナ）"  C列: 名義カナ
  bank.accountHolderKana = normText(String(getCellValue(ws, sr+3, sc+2) ?? ''));

  return bank;
}

/**
 * DR名寄せ用キー生成
 * フルネームで照合して同姓の別人（例: 鈴木 隆宏 / 鈴木 潤）を区別する
 */
function getDRKey(name) {
  return normalizePersonName(normText(name));
}
