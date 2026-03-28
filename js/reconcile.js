/**
 * reconcile.js - 日払い突合ロジック
 * 
 * 業務報告書の委託者（dailyPayYen）と
 * 月計表の取引入力（dailyPayEntries）を照合する。
 * 
 * 名寄せルール：
 * - 業務報告書の人物キー = normalizePersonName(name) → 苗字等
 * - 月計表の人物キー = normalizePersonName(rawLabel) → 接頭辞・日払除去後の名前
 * - 苗字（スペース前の最初のトークン）で照合
 * - 同姓が複数いる場合は警告
 * 
 * 判定ルール：
 * | 報告書日払い | 月計表日払い行  | 判定 |
 * | >0          | あり & 金額一致 | OK   |
 * | >0          | なし            | NG   |
 * | >0          | あり & 不一致   | NG   |
 * | 0           | なし/0          | OK   |
 * | 0           | あり & >0      | NG   |
 */

'use strict';

/**
 * 日払い突合を実行
 * @param {Array} contractors - 業務委託者リスト（from parser-report.js）
 * @param {Array} dailyPayEntries - 月計表の日払いリスト（from parser-monthly.js）
 * @returns {Array} reconcileResults
 * 
 * 各結果:
 * {
 *   name: string,              // 業務報告書の氏名
 *   personKey: string,         // 正規化キー
 *   reportDailyPayYen: number, // 業務報告書の日払い額
 *   monthlyDailyPayYen: number,// 月計表の日払い額（0=なし）
 *   monthlyRawLabel: string,   // 月計表の元科目文字列（なければ空）
 *   status: 'OK'|'NG',
 *   reason: string,
 *   isManualApproved: boolean  // 手動承認フラグ
 * }
 * 
 * また月計表にのみ存在する未対応エントリも追加：
 * {
 *   name: string,              // ★personKey のみ（補完なし）
 *   personKey: string,
 *   monthlyRawLabel: string,   // 元科目文字列
 *   reportDailyPayYen: null,   // 業務報告書に存在しないことを示す
 *   monthlyDailyPayYen: number,
 *   status: 'NG',
 *   reason: '月計表に日払いあり、業務報告書（業務委託）に該当者なし',
 *   isManualApproved: false
 * }
 */
function reconcile(contractors, dailyPayEntries) {
  const results = [];

  // ★ DR行（科目に「DR」接頭辞を含む）は業務委託突合から除外
  // 　 DR行は reconcileDR() で別途処理する
  const staffEntries = dailyPayEntries.filter(e => {
    const raw = e.personRawLabel ?? '';
    return !raw.startsWith('DR') && !raw.startsWith('ＤＲ');
  });

  // 月計表エントリのマップ（personKey → entry）
  const monthlyMap = buildMonthlyMap(staffEntries);

  // 業務報告書の委託者ごとに突合
  const matchedMonthlyKeys = new Set();

  for (const c of contractors) {
    const reportKey = getSurname(normalizePersonName(c.name));
    const reportDailyPayYen = Number(c.dailyPayYen ?? 0);

    // 月計表で対応するエントリを探す
    const monthlyEntries = findMonthlyEntries(monthlyMap, reportKey);
    const matched = monthlyEntries.filter(e => e.dailyPayYen > 0);

    // 照合済みにマーク
    monthlyEntries.forEach(e => matchedMonthlyKeys.add(e.personKey + '_' + e.rowIdx));

    if (reportDailyPayYen > 0) {
      // 報告書に日払いあり
      if (matched.length === 0) {
        results.push({
          name: c.name,
          personKey: reportKey,
          reportDailyPayYen,
          monthlyDailyPayYen: 0,
          monthlyRawLabel: '',
          status: 'NG',
          reason: `月計表に「${reportKey}」の日払い行がありません（漏れ）`,
          isManualApproved: false
        });
      } else {
        // 金額チェック
        const totalMonthlyAmount = matched.reduce((s, e) => s + e.dailyPayYen, 0);
        const firstMatch = matched[0];
        if (totalMonthlyAmount === reportDailyPayYen) {
          results.push({
            name: c.name,
            personKey: reportKey,
            reportDailyPayYen,
            monthlyDailyPayYen: totalMonthlyAmount,
            monthlyRawLabel: firstMatch.personRawLabel,
            status: 'OK',
            reason: '一致',
            isManualApproved: false
          });
        } else {
          results.push({
            name: c.name,
            personKey: reportKey,
            reportDailyPayYen,
            monthlyDailyPayYen: totalMonthlyAmount,
            monthlyRawLabel: firstMatch.personRawLabel,
            status: 'NG',
            reason: `金額不一致（報告書: ${formatYen(reportDailyPayYen)}、月計表: ${formatYen(totalMonthlyAmount)}）`,
            isManualApproved: false
          });
        }
      }
    } else {
      // 報告書の日払いが0
      if (matched.length > 0) {
        const totalMonthlyAmount = matched.reduce((s, e) => s + e.dailyPayYen, 0);
        results.push({
          name: c.name,
          personKey: reportKey,
          reportDailyPayYen: 0,
          monthlyDailyPayYen: totalMonthlyAmount,
          monthlyRawLabel: matched[0].personRawLabel,
          status: 'NG',
          reason: `報告書の日払いは0ですが、月計表に${formatYen(totalMonthlyAmount)}の日払い入力があります（誤入力の可能性）`,
          isManualApproved: false
        });
      } else {
        results.push({
          name: c.name,
          personKey: reportKey,
          reportDailyPayYen: 0,
          monthlyDailyPayYen: 0,
          monthlyRawLabel: '',
          status: 'OK',
          reason: '日払いなし（両方0）',
          isManualApproved: false
        });
      }
    }
  }

  // 月計表にのみ存在する未対応エントリ（DR行は除外済みなので業務委託・スタッフの漏れのみ）
  // ★ DRファイルがある場合、DR行は reconcileDR() で別途処理するため、
  //    ここでは staffEntries（DR行を除外済み）のみを対象とする
  for (const entry of staffEntries) {
    const key = entry.personKey + '_' + entry.rowIdx;
    if (!matchedMonthlyKeys.has(key) && entry.dailyPayYen > 0) {
      results.push({
        name: entry.personKey,
        personKey: entry.personKey,
        reportDailyPayYen: null,
        monthlyDailyPayYen: entry.dailyPayYen,
        monthlyRawLabel: entry.personRawLabel,
        status: 'NG',
        reason: `月計表に日払いがありますが、業務報告書（業務委託）に「${entry.personKey}」が見つかりません。DR・スタッフの場合はDRタブを確認してください。`,
        isManualApproved: false
      });
    }
  }

  // NG行を先頭に並び替え
  results.sort((a, b) => {
    if (a.status === 'NG' && b.status !== 'NG') return -1;
    if (a.status !== 'NG' && b.status === 'NG') return 1;
    return 0;
  });

  return results;
}

/**
 * 月計表エントリのマップを構築
 * キー: personKey（苗字）
 */
function buildMonthlyMap(dailyPayEntries) {
  const map = {};
  for (const entry of dailyPayEntries) {
    const key = getSurname(entry.personKey);
    if (!map[key]) map[key] = [];
    map[key].push(entry);
  }
  return map;
}

/**
 * 月計表マップから対応エントリを探す
 * 完全一致 → 部分一致の順で検索
 */
function findMonthlyEntries(monthlyMap, reportKey) {
  if (monthlyMap[reportKey]) return monthlyMap[reportKey];
  const candidates = [];
  for (const [key, entries] of Object.entries(monthlyMap)) {
    if (key.includes(reportKey) || reportKey.includes(key)) {
      candidates.push(...entries);
    }
  }
  return candidates;
}

// ============================================================
// DR 日払い突合
// ============================================================

/**
 * DRファイルの仮払精算額と月計表の「DR〇〇 日払い」を照合する
 *
 * @param {Array} drList       - parseDR() の結果
 * @param {Array} dailyPayEntries - parseMonthly() の結果（月計表全エントリ）
 * @returns {Array} drReconcileResults
 *
 * 各結果:
 * {
 *   name: string,              // DRタブの氏名
 *   drKey: string,             // 苗字キー（名寄せ用）
 *   sheetName: string,         // DRタブ名
 *   drKaribaraiYen: number,    // DRファイルの仮払精算額（絶対値）
 *   monthlyDailyPayYen: number,// 月計表の日払い額
 *   monthlyRawLabel: string,   // 月計表の元科目文字列
 *   driverReward: number,      // ドライバー報酬
 *   status: 'OK'|'NG',
 *   reason: string,
 *   isManualApproved: boolean
 * }
 */
function reconcileDR(drList, dailyPayEntries) {
  const results = [];

  // ★ DR行（科目に「DR」または「ＤＲ」接頭辞を含む）のみを対象とする
  const drEntries = dailyPayEntries.filter(e => {
    const raw = e.personRawLabel ?? '';
    return raw.startsWith('DR') || raw.startsWith('ＤＲ');
  });

  // 月計表DRエントリのマップ（苗字キー → entries）
  const monthlyMap = buildMonthlyMap(drEntries);
  const matchedMonthlyKeys = new Set();

  for (const dr of drList) {
    const drKey = getDRKey(dr.name);
    const karibaraiYen = dr.karibaraiYen ?? 0;

    // 月計表で対応するエントリを探す
    const monthlyEntries = findMonthlyEntries(monthlyMap, drKey);
    const matched = monthlyEntries.filter(e => e.dailyPayYen > 0);
    matched.forEach(e => matchedMonthlyKeys.add(e.personKey + '_' + e.rowIdx));

    if (karibaraiYen > 0) {
      // DRファイルに日払い（仮払）あり
      if (matched.length === 0) {
        results.push({
          name: dr.name, drKey, sheetName: dr.sheetName,
          drKaribaraiYen: karibaraiYen,
          monthlyDailyPayYen: 0, monthlyRawLabel: '',
          driverReward: dr.driverReward,
          status: 'NG',
          reason: `月計表に「DR${drKey} 日払い」行がありません（漏れ）`,
          isManualApproved: false
        });
      } else {
        const totalMonthly = matched.reduce((s, e) => s + e.dailyPayYen, 0);
        const firstMatch = matched[0];
        if (totalMonthly === karibaraiYen) {
          results.push({
            name: dr.name, drKey, sheetName: dr.sheetName,
            drKaribaraiYen: karibaraiYen,
            monthlyDailyPayYen: totalMonthly,
            monthlyRawLabel: firstMatch.personRawLabel,
            driverReward: dr.driverReward,
            status: 'OK', reason: '一致',
            isManualApproved: false
          });
        } else {
          results.push({
            name: dr.name, drKey, sheetName: dr.sheetName,
            drKaribaraiYen: karibaraiYen,
            monthlyDailyPayYen: totalMonthly,
            monthlyRawLabel: firstMatch.personRawLabel,
            driverReward: dr.driverReward,
            status: 'NG',
            reason: `金額不一致（DRファイル仮払: ${formatYen(karibaraiYen)}、月計表: ${formatYen(totalMonthly)}）`,
            isManualApproved: false
          });
        }
      }
    } else {
      // DRファイルに日払いなし
      if (matched.length > 0) {
        const totalMonthly = matched.reduce((s, e) => s + e.dailyPayYen, 0);
        results.push({
          name: dr.name, drKey, sheetName: dr.sheetName,
          drKaribaraiYen: 0,
          monthlyDailyPayYen: totalMonthly,
          monthlyRawLabel: matched[0].personRawLabel,
          driverReward: dr.driverReward,
          status: 'NG',
          reason: `DRファイルの仮払は0ですが、月計表に${formatYen(totalMonthly)}の日払いがあります`,
          isManualApproved: false
        });
      } else {
        results.push({
          name: dr.name, drKey, sheetName: dr.sheetName,
          drKaribaraiYen: 0,
          monthlyDailyPayYen: 0, monthlyRawLabel: '',
          driverReward: dr.driverReward,
          status: 'OK', reason: '日払いなし（両方0）',
          isManualApproved: false
        });
      }
    }
  }

  // 月計表にのみ存在するDR日払いエントリ（DRファイルに対応者なし）
  for (const entry of drEntries) {
    const key = entry.personKey + '_' + entry.rowIdx;
    if (!matchedMonthlyKeys.has(key) && entry.dailyPayYen > 0) {
      results.push({
        name: entry.personKey,
        drKey: entry.personKey,
        sheetName: '—',
        drKaribaraiYen: null,
        monthlyDailyPayYen: entry.dailyPayYen,
        monthlyRawLabel: entry.personRawLabel,
        driverReward: null,
        status: 'NG',
        reason: `月計表に日払いがありますが、DRファイルに「${entry.personKey}」のタブがありません`,
        isManualApproved: false
      });
    }
  }

  // NG先頭
  results.sort((a, b) => {
    if (a.status === 'NG' && b.status !== 'NG') return -1;
    if (a.status !== 'NG' && b.status === 'NG') return 1;
    return 0;
  });

  return results;
}
