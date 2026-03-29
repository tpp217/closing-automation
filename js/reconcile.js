/**
 * reconcile.js - 日払い突合ロジック
 * 
 * 業務報告書の全員（委託者＋社員）の dailyPayYen と
 * 月計表の取引入力（dailyPayEntries）を照合する。
 * 
 * 結果の _isContractor フラグで業務委託か社員かを判別し、
 * UI 側で表示を切り分ける。
 */

'use strict';

/**
 * 日払い突合を実行
 * @param {Array} allPeople       - 全員リスト（業務委託＋社員、from parser-report.js）
 * @param {Array} dailyPayEntries - 月計表の日払いリスト（from parser-monthly.js）
 * @returns {Array} reconcileResults
 */
function reconcile(allPeople, dailyPayEntries) {
  const results = [];

  // DR行（科目に「DR」接頭辞を含む）は業務委託突合から除外
  const staffEntries = dailyPayEntries.filter(e => {
    const raw = e.personRawLabel ?? '';
    return !raw.startsWith('DR') && !raw.startsWith('ＤＲ');
  });

  // 月計表エントリのマップ（personKey → entry）
  const monthlyMap = buildMonthlyMap(staffEntries);

  // 全員ごとに突合
  const matchedMonthlyKeys = new Set();

  for (const c of allPeople) {
    const isContractor    = (c.role || '').includes('業務委託');
    const reportKey       = getSurname(normalizePersonName(c.name));
    const reportFullKey   = normalizePersonName(c.name);
    const reportDailyPayYen = Number(c.dailyPayYen ?? 0);

    // 月計表で対応するエントリを探す（フルネーム優先→苗字フォールバック）
    const monthlyEntries = findMonthlyEntries(monthlyMap, reportKey, reportFullKey);
    const matched = monthlyEntries.filter(e => e.dailyPayYen > 0);

    // 同姓が複数いる場合に警告ログ
    const surnameMatches = monthlyMap[reportKey] ?? [];
    if (surnameMatches.length > matched.length && matched.length > 0) {
      console.warn(`[reconcile] 同姓複数マッチ: ${c.name} (苗字:${reportKey}) → フルネーム照合で絞り込み済み`);
    }

    // 照合済みにマーク
    monthlyEntries.forEach(e => matchedMonthlyKeys.add(e.personKey + '_' + e.rowIdx));

    if (reportDailyPayYen > 0) {
      // 報告書に日払いあり
      if (matched.length === 0) {
        results.push({
          name: c.name, personKey: reportKey,
          _isContractor: isContractor,
          reportDailyPayYen,
          monthlyDailyPayYen: 0, monthlyRawLabel: '',
          status: 'NG',
          reason: `月計表に「${reportKey}」の日払い行がありません（漏れ）`,
          isManualApproved: false
        });
      } else {
        const totalMonthlyAmount = matched.reduce((s, e) => s + e.dailyPayYen, 0);
        const firstMatch = matched[0];
        if (totalMonthlyAmount === reportDailyPayYen) {
          results.push({
            name: c.name, personKey: reportKey,
            _isContractor: isContractor,
            reportDailyPayYen,
            monthlyDailyPayYen: totalMonthlyAmount,
            monthlyRawLabel: firstMatch.personRawLabel,
            status: 'OK', reason: '一致',
            isManualApproved: false
          });
        } else {
          results.push({
            name: c.name, personKey: reportKey,
            _isContractor: isContractor,
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
          name: c.name, personKey: reportKey,
          _isContractor: isContractor,
          reportDailyPayYen: 0,
          monthlyDailyPayYen: totalMonthlyAmount,
          monthlyRawLabel: matched[0].personRawLabel,
          status: 'NG',
          reason: `報告書の日払いは0ですが、月計表に${formatYen(totalMonthlyAmount)}の日払い入力があります（誤入力の可能性）`,
          isManualApproved: false
        });
      } else {
        results.push({
          name: c.name, personKey: reportKey,
          _isContractor: isContractor,
          reportDailyPayYen: 0,
          monthlyDailyPayYen: 0, monthlyRawLabel: '',
          status: 'OK', reason: '日払いなし（両方0）',
          isManualApproved: false
        });
      }
    }
  }

  // 月計表にのみ存在する未対応エントリ
  for (const entry of staffEntries) {
    const key = entry.personKey + '_' + entry.rowIdx;
    if (!matchedMonthlyKeys.has(key) && entry.dailyPayYen > 0) {
      results.push({
        name: entry.personKey,
        personKey: entry.personKey,
        _isContractor: false,
        reportDailyPayYen: null,
        monthlyDailyPayYen: entry.dailyPayYen,
        monthlyRawLabel: entry.personRawLabel,
        status: 'NG',
        reason: `月計表に日払いがありますが、業務報告書に「${entry.personKey}」が見つかりません。DRの場合はDRタブを確認してください。`,
        isManualApproved: false
      });
    }
  }

  // NG先頭・業務委託優先で並び替え
  results.sort((a, b) => {
    // NGを先頭
    if (a.status === 'NG' && b.status !== 'NG') return -1;
    if (a.status !== 'NG' && b.status === 'NG') return 1;
    // 同じステータス内では業務委託を先
    if (a._isContractor && !b._isContractor) return -1;
    if (!a._isContractor && b._isContractor) return 1;
    return 0;
  });

  return results;
}

/**
 * 月計表エントリのマップを構築
 * キー: normalizePersonName した文字列（スペース除去済み）
 */
function buildMonthlyMap(dailyPayEntries) {
  const map = {};
  for (const entry of dailyPayEntries) {
    const key = normalizePersonName(entry.personKey).replace(/\s+/g, '');
    if (!map[key]) map[key] = [];
    map[key].push(entry);
  }
  return map;
}

/**
 * 月計表マップから対応エントリを探す
 *
 * 月計表の表記パターン:
 *   - 通常    : 「鈴木」（苗字のみ）
 *   - 同姓時  : 「鈴木隆」「鈴木た」など（苗字＋名前の一部）
 *
 * 照合優先順位:
 *   1. 月計表キーが 報告書フルネームの前方部分と一致（例: 「鈴木隆」⊂「鈴木隆宏」）
 *   2. 月計表キーが 報告書苗字と完全一致（例: 「鈴木」=「鈴木」）
 *   3. 報告書フルネームが 月計表キーを含む（部分一致フォールバック）
 */
function findMonthlyEntries(monthlyMap, surnameKey, fullKey) {
  const normFull    = (fullKey    || '').replace(/\s+/g, '');
  const normSurname = (surnameKey || '').replace(/\s+/g, '');

  const seen = new Set();
  const dedup = entries => entries.filter(e => {
    const id = e.personKey + '_' + e.rowIdx;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  // 1. 月計表キーが報告書フルネームの前方一致（苗字+名前の一部）
  const prefixMatches = [];
  for (const [key, entries] of Object.entries(monthlyMap)) {
    if (key.length > normSurname.length && normFull.startsWith(key)) {
      prefixMatches.push(...entries);
    }
  }
  if (prefixMatches.length > 0) return dedup(prefixMatches);

  // 2. 苗字完全一致
  if (monthlyMap[normSurname]) return dedup(monthlyMap[normSurname]);

  // 3. フルネームが月計表キーを含む（フォールバック）
  const fallback = [];
  for (const [key, entries] of Object.entries(monthlyMap)) {
    if (normFull && normFull.includes(key) && key.length >= 2) {
      fallback.push(...entries);
    }
  }
  return dedup(fallback);
}

// ============================================================
// DR 日払い突合
// ============================================================

/**
 * DRファイルの仮払精算額と月計表の「DR〇〇 日払い」を照合する
 */
function reconcileDR(drList, dailyPayEntries) {
  const results = [];

  // DR行（科目に「DR」または「ＤＲ」接頭辞を含む）のみを対象とする
  const drEntries = dailyPayEntries.filter(e => {
    const raw = e.personRawLabel ?? '';
    return raw.startsWith('DR') || raw.startsWith('ＤＲ');
  });

  // 月計表DRエントリのマップ（苗字キー → entries）
  const monthlyMap = buildMonthlyMap(drEntries);
  const matchedMonthlyKeys = new Set();

  for (const dr of drList) {
    const drKey     = getDRKey(dr.name);
    const drFullKey = normalizePersonName(dr.name);
    const karibaraiYen = dr.karibaraiYen ?? 0;

    // 適格請求支払手数料チェック: driverReward × 2%（端数 ±1円許容）
    const feeExpected = Math.round((dr.driverReward ?? 0) * 0.02);
    const feeActual   = dr.actualFee ?? 0;
    const feeCheck    = {
      expected: feeExpected,
      actual:   feeActual,
      ok:       Math.abs(feeActual - feeExpected) <= 1
    };

    // 月計表で対応するエントリを探す
    const monthlyEntries = findMonthlyEntries(monthlyMap, drKey, drFullKey);
    const matched = monthlyEntries.filter(e => e.dailyPayYen > 0);
    matched.forEach(e => matchedMonthlyKeys.add(e.personKey + '_' + e.rowIdx));

    if (karibaraiYen > 0) {
      if (matched.length === 0) {
        results.push({
          name: dr.name, drKey, sheetName: dr.sheetName,
          drKaribaraiYen: karibaraiYen,
          monthlyDailyPayYen: 0, monthlyRawLabel: '',
          driverReward: dr.driverReward,
          feeCheck,
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
            feeCheck,
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
            feeCheck,
            status: 'NG',
            reason: `金額不一致（DRファイル仮払: ${formatYen(karibaraiYen)}、月計表: ${formatYen(totalMonthly)}）`,
            isManualApproved: false
          });
        }
      }
    } else {
      if (matched.length > 0) {
        const totalMonthly = matched.reduce((s, e) => s + e.dailyPayYen, 0);
        results.push({
          name: dr.name, drKey, sheetName: dr.sheetName,
          drKaribaraiYen: 0,
          monthlyDailyPayYen: totalMonthly,
          monthlyRawLabel: matched[0].personRawLabel,
          driverReward: dr.driverReward,
          feeCheck,
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
          feeCheck,
          status: 'OK', reason: '日払いなし（両方0）',
          isManualApproved: false
        });
      }
    }
  }

  // 月計表にのみ存在するDR日払いエントリ
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
        feeCheck: null,
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
