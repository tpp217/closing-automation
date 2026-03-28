/**
 * app.js - アプリケーションコントローラー
 * 
 * 画面制御・イベント処理・ステップ間のデータ受け渡し
 */

'use strict';

// ==============================
// アプリケーション状態
// ==============================
const AppState = {
  // ステップ1: アップロード
  reportFile: null,
  monthlyFile: null,
  drFile: null,          // DR距離計算ファイル（任意）
  reportBuffer: null,
  monthlyBuffer: null,
  drBuffer: null,
  storeName: '',
  periodYm: '',

  // ステップ2: 委託者
  allPeople: [],          // 社員名簿の全員（表示用）
  contractors: [],        // 業務委託者のみ（突合・差分・出力用）
  parseWarnings: [],

  // ステップ3: 日払い突合
  dailyPayEntries: [],
  reconcileResults: [],
  drList: [],            // DR一覧
  drReconcileResults: [],// DR突合結果

  // ステップ4: 前月差分
  prevContractors: [],
  diffResults: [],
  prevDrList: [],
  drDiffResults: [],

  // 現在のステップ
  currentStep: 1
};

// ==============================
// 初期化
// ==============================
document.addEventListener('DOMContentLoaded', () => {
  setupStep1();
  setupStep2();
  setupStep3();
  setupStep4();
  setupStep5();
  setupReset();
  setupTabs();
});

// ==============================
// ステップ1: アップロード
// ==============================
function setupStep1() {
  const inputReport  = $('input-report');
  const inputMonthly = $('input-monthly');
  const inputDR      = $('input-dr');
  const dropReport   = $('drop-report');
  const dropMonthly  = $('drop-monthly');
  const dropDR       = $('drop-dr');

  inputReport.addEventListener('change',  e => handleReportFile(e.target.files[0]));
  inputMonthly.addEventListener('change', e => handleMonthlyFile(e.target.files[0]));
  inputDR.addEventListener('change',      e => handleDRFile(e.target.files[0]));

  setupDropZone(dropReport,  file => handleReportFile(file));
  setupDropZone(dropMonthly, file => handleMonthlyFile(file));
  setupDropZone(dropDR,      file => handleDRFile(file));

  $('btn-step1-next').addEventListener('click', () => goToStep(2));
}

function setupDropZone(zone, onFile) {
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  });
}

async function handleReportFile(file) {
  if (!file) return;
  AppState.reportFile = file;
  AppState.reportBuffer = await readFileAsArrayBuffer(file);
  showFileInfo('report-file-info', file.name, file.size);
  updateStep1UI();
  tryAutoDetect();
}

async function handleMonthlyFile(file) {
  if (!file) return;
  AppState.monthlyFile = file;
  AppState.monthlyBuffer = await readFileAsArrayBuffer(file);
  showFileInfo('monthly-file-info', file.name, file.size);
  updateStep1UI();
  tryAutoDetect();
}

async function handleDRFile(file) {
  if (!file) return;
  AppState.drFile = file;
  AppState.drBuffer = await readFileAsArrayBuffer(file);
  showFileInfo('dr-file-info', file.name, file.size);
  // DR検出表示
  const drItem = $('detected-dr-item');
  if (drItem) drItem.style.display = '';
  show($('detected-info'));
  showToast(`DRファイル「${file.name}」を読み込みました`, 'success');
}

function showFileInfo(elementId, name, size) {
  const el = $(elementId);
  el.innerHTML = `<div class="file-name"><i class="fas fa-file-excel"></i> ${name}</div>
  <div style="font-size:0.8rem;color:var(--gray-400);margin-top:2px">${(size / 1024).toFixed(1)} KB</div>`;
  show(el);
}

function tryAutoDetect() {
  // 両ファイルのいずれかからストア名・年月を取得
  const source = AppState.reportFile || AppState.monthlyFile;
  if (!source) return;
  const info = parseFileNameInfo(source.name);
  if (info.storeName) AppState.storeName = info.storeName;
  if (info.periodYm) AppState.periodYm = info.periodYm;

  // 表示更新
  $('detected-store').textContent = AppState.storeName || '（検出できませんでした）';
  $('detected-period').textContent = AppState.periodYm ? formatPeriodDisplay(AppState.periodYm) : '（検出できませんでした）';
  show($('detected-info'));
}

function updateStep1UI() {
  const btn = $('btn-step1-next');
  btn.disabled = !(AppState.reportBuffer && AppState.monthlyBuffer);
}

// ==============================
// ステップ2: 委託者情報取得
// ==============================
function setupStep2() {
  $('btn-step2-back').addEventListener('click', () => goToStep(1));
  $('btn-step2-next').addEventListener('click', () => goToStep(3));
}

async function runStep2() {
  show($('step2-loading'));
  hide($('contractors-list'));
  hide($('step2-warnings'));
  $('btn-step2-next').disabled = true;

  try {
    const { contractors: allPeople, warnings } = await parseReport(AppState.reportBuffer);
    AppState.allPeople   = allPeople;
    AppState.contractors = allPeople.filter(c => (c.role || '').includes('業務委託'));
    AppState.parseWarnings = warnings;

    // デバッグ用ログ（開発者ツールで確認可能）
    console.log('[Step2] 全員:', JSON.stringify(allPeople.map(c => ({
      name: c.name, role: c.role,
      basicPayMan: c.basicPayMan, dailyPayYen: c.dailyPayYen
    })), null, 2));
    if (warnings.length) console.warn('[Step2] 警告:', warnings);

    renderContractorsTable(allPeople);
    renderWarnings('step2-warnings', warnings);

    // 業務委託者が1名以上いれば次へ進める
    const contractorCount = AppState.contractors.length;
    $('btn-step2-next').disabled = contractorCount === 0;

    if (allPeople.length === 0) {
      showToast('社員名簿に人員が見つかりませんでした', 'warning');
    } else if (contractorCount === 0) {
      showToast(`${allPeople.length}名を取得しましたが業務委託者が0名です`, 'warning');
    } else {
      showToast(`${allPeople.length}名を取得（うち業務委託: ${contractorCount}名）`, 'success');
    }
  } catch (e) {
    console.error('Step2 error:', e);
    showToast('業務報告書の解析でエラーが発生しました: ' + e.message, 'error');
  } finally {
    hide($('step2-loading'));
  }
}

function renderContractorsTable(people) {
  const wrap = $('contractors-list');
  if (people.length === 0) {
    wrap.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--gray-400)">社員名簿に人員が見つかりません</div>';
    show(wrap);
    return;
  }

  const headers = [
    { label: '氏名',       key: 'name' },
    { label: '役職',       key: 'roleDisplay' },
    { label: '基本給',     key: 'basicPayManDisplay', align: 'right' },
    { label: '日払い',     key: 'dailyPayYenDisplay', align: 'right' },
    { label: '銀行名',     key: 'bankDisplay' },
    { label: '支店',       key: 'branchDisplay' },
    { label: '口座番号',   key: 'accountDisplay' },
    { label: '名義カナ',   key: 'holderDisplay' },
    { label: '警告',       key: 'warningBadge' }
  ];

  const rowData = people.map(c => ({
    ...c,
    _isContractor: (c.role || '').includes('業務委託'),
    roleDisplay:         c.role || '（不明）',
    basicPayManDisplay:  `${c.basicPayMan ?? 0}万円`,
    dailyPayYenDisplay:  c.dailyPayYen > 0 ? formatYen(c.dailyPayYen) : '¥0（なし）',
    bankDisplay:         c.bank?.bankName || '-',
    branchDisplay:       c.bank?.branchName || '-',
    accountDisplay:      c.bank?.accountNumber ? maskAccountDisplay(c.bank.accountNumber) : '-',
    holderDisplay:       c.bank?.accountHolderKana || '-',
    warningBadge:        c.warnings?.length > 0 ? `⚠️ ${c.warnings.length}件` : '✓'
  }));

  const table = buildTable(headers, rowData, row => {
    const tr = document.createElement('tr');
    // 業務委託以外はグレーアウト
    if (!row._isContractor) {
      tr.style.opacity = '0.5';
      tr.style.background = 'var(--gray-50, #f9fafb)';
    }
    headers.forEach(h => {
      const td = document.createElement('td');
      td.textContent = (row[h.key] === null || row[h.key] === undefined) ? '' : row[h.key];
      if (h.align) td.style.textAlign = h.align;
      tr.appendChild(td);
    });
    return tr;
  });

  wrap.innerHTML = '';
  wrap.appendChild(table);
  show(wrap);
}

function maskAccountDisplay(num) {
  if (!num || num.length <= 4) return num;
  return '*'.repeat(num.length - 4) + num.slice(-4);
}

function renderWarnings(elementId, warnings) {
  const el = $(elementId);
  if (!warnings || warnings.length === 0) { hide(el); return; }
  const errorWarnings = warnings.filter(w => w.level === 'error' || w.level === 'warn');
  if (errorWarnings.length === 0) { hide(el); return; }

  el.innerHTML = `
    <h4><i class="fas fa-exclamation-triangle"></i> 確認事項（${errorWarnings.length}件）</h4>
    <ul>${errorWarnings.map(w => `<li>${w.person ? `[${w.person}] ` : ''}${w.message}</li>`).join('')}</ul>
  `;
  show(el);
}

// ==============================
// ステップ3: 日払い突合
// ==============================
function setupStep3() {
  $('btn-step3-back').addEventListener('click', () => goToStep(2));
  $('btn-step3-next').addEventListener('click', () => goToStep(4));
}

async function runStep3() {
  show($('step3-loading'));
  hide($('reconcile-list'));
  hide($('dr-reconcile-list'));
  hide($('reconcile-kpi'));

  try {
    // 月計表解析
    const { dailyPayEntries, warnings } = await parseMonthly(AppState.monthlyBuffer);
    AppState.dailyPayEntries = dailyPayEntries;
    if (warnings.length > 0) warnings.forEach(w => console.warn('[月計表]', w.message));

    // 業務委託 突合
    const results = reconcile(AppState.contractors, dailyPayEntries);
    AppState.reconcileResults = results;
    renderReconcileTable(results);

    // DR突合（DRファイルがある場合）
    if (AppState.drBuffer) {
      try {
        const { drList, warnings: drW } = await parseDR(AppState.drBuffer);
        AppState.drList = drList;
        if (drW.length) drW.forEach(w => console.warn('[DR]', w.message));

        const drResults = reconcileDR(drList, dailyPayEntries);
        AppState.drReconcileResults = drResults;
        renderDRReconcileTable(drResults);

        // DRタブを表示
        $('tab-dr-btn').style.display = '';
        $('kpi-dr-card').style.display = '';
        $('kpi-dr-count').textContent = drList.length;

        const drNg = drResults.filter(r => r.status === 'NG').length;
        showToast(`DR突合完了: ${drList.length}名 / NG ${drNg}件`, drNg > 0 ? 'warning' : 'success');
      } catch (e) {
        console.error('DR parse error:', e);
        showToast('DRファイルの解析でエラー: ' + e.message, 'error');
      }
    } else {
      // DRなし時: 月計表にDR行があれば警告を表示
      const drEntries = dailyPayEntries.filter(e => {
        const raw = e.personRawLabel ?? '';
        return raw.startsWith('DR') || raw.startsWith('ＤＲ');
      });
      if (drEntries.length > 0) {
        // DRタブを表示して「未アップロード」メッセージを表示
        $('tab-dr-btn').style.display = '';
        $('kpi-dr-card').style.display = '';
        $('kpi-dr-count').textContent = drEntries.length;
        const drWrap = $('dr-reconcile-list');
        drWrap.innerHTML = `
          <div style="padding:1.5rem;background:#fff8e1;border-radius:8px;border-left:4px solid var(--warning)">
            <p style="margin:0 0 0.5rem;font-weight:600"><i class="fas fa-exclamation-triangle" style="color:var(--warning)"></i> DRファイルが未アップロードです</p>
            <p style="margin:0;font-size:0.9rem;color:var(--gray-600)">
              月計表に以下のDR日払い行が見つかりました。DRファイルをアップロードして突合してください。
            </p>
            <ul style="margin:0.5rem 0 0;padding-left:1.5rem;font-size:0.9rem">
              ${drEntries.map(e => `<li>${escapeHtml(e.personRawLabel)} — <strong>${formatYen(e.dailyPayYen)}</strong></li>`).join('')}
            </ul>
          </div>`;
        show(drWrap);
        showToast(`月計表に${drEntries.length}件のDR日払い行があります。DRファイルをアップロードしてください`, 'warning');
      } else {
        $('tab-dr-btn').style.display = 'none';
        $('kpi-dr-card').style.display = 'none';
      }
    }

    renderReconcileKPI(results);

    const ngCount = results.filter(r => r.status === 'NG').length;
    showToast(
      ngCount > 0 ? `業務委託: ${ngCount}件のNG（要確認）` : '業務委託: すべて一致',
      ngCount > 0 ? 'warning' : 'success'
    );
  } catch (e) {
    console.error('Step3 error:', e);
    showToast('日払い突合でエラーが発生しました: ' + e.message, 'error');
  } finally {
    hide($('step3-loading'));
  }
}

function renderReconcileKPI(results) {
  const okCount = results.filter(r => r.status === 'OK').length;
  const ngCount = results.filter(r => r.status === 'NG').length;
  $('kpi-ok-count').textContent = okCount;
  $('kpi-ng-count').textContent = ngCount;
  show($('reconcile-kpi'));
}

function renderReconcileTable(results) {
  const wrap = $('reconcile-list');
  if (results.length === 0) {
    wrap.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--gray-400)">突合結果がありません</div>';
    show(wrap);
    return;
  }

  const table = document.createElement('table');
  // ヘッダー
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['氏名（業務報告書）', '月計表の科目（元データ）', '報告書 日払い', '月計表 日払い', '判定', '理由', '承認'].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  results.forEach((r, idx) => {
    const tr = document.createElement('tr');
    if (r.status === 'NG') tr.classList.add('row-ng');

    // ★★★ 修正ポイント: 氏名表示 ★★★
    // reportDailyPayYen が null の場合 = 月計表にのみ存在
    // この場合は元データのpersonKeyのみ表示（補完なし）
    const nameCell = document.createElement('td');
    if (r.reportDailyPayYen === null) {
      // 業務報告書に存在しない → 月計表のpersonKeyのみ表示
      nameCell.innerHTML = `<span class="text-muted">${escapeHtml(r.name)}</span>
        <br><span style="font-size:0.75rem;color:var(--warning)">業務報告書に未登録</span>`;
    } else {
      nameCell.textContent = r.name;
    }
    tr.appendChild(nameCell);

    // 月計表の元データ
    const rawLabelCell = document.createElement('td');
    rawLabelCell.textContent = r.monthlyRawLabel || '-';
    rawLabelCell.style.fontSize = '0.85rem';
    rawLabelCell.style.color = 'var(--gray-500)';
    tr.appendChild(rawLabelCell);

    // 報告書日払い
    const reportCell = document.createElement('td');
    reportCell.style.textAlign = 'right';
    if (r.reportDailyPayYen === null) {
      reportCell.innerHTML = '<span class="text-muted">—</span>';
    } else {
      reportCell.textContent = formatYen(r.reportDailyPayYen);
    }
    tr.appendChild(reportCell);

    // 月計表日払い
    const monthlyCell = document.createElement('td');
    monthlyCell.style.textAlign = 'right';
    monthlyCell.textContent = formatYen(r.monthlyDailyPayYen);
    tr.appendChild(monthlyCell);

    // 判定
    const statusCell = document.createElement('td');
    statusCell.innerHTML = r.status === 'OK'
      ? '<span class="badge badge-ok"><i class="fas fa-check"></i> OK</span>'
      : '<span class="badge badge-ng"><i class="fas fa-times"></i> NG</span>';
    tr.appendChild(statusCell);

    // 理由
    const reasonCell = document.createElement('td');
    reasonCell.textContent = r.reason;
    reasonCell.style.fontSize = '0.85rem';
    tr.appendChild(reasonCell);

    // 承認チェック（NGのみ）
    const approveCell = document.createElement('td');
    if (r.status === 'NG') {
      const toggle = document.createElement('label');
      toggle.className = 'approve-toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = r.isManualApproved;
      checkbox.addEventListener('change', e => {
        AppState.reconcileResults[idx].isManualApproved = e.target.checked;
        if (e.target.checked) {
          tr.classList.remove('row-ng');
        } else {
          tr.classList.add('row-ng');
        }
      });
      const lbl = document.createElement('span');
      lbl.textContent = '確認OK';
      toggle.appendChild(checkbox);
      toggle.appendChild(lbl);
      approveCell.appendChild(toggle);
    } else {
      approveCell.innerHTML = '<span class="badge badge-ok">-</span>';
    }
    tr.appendChild(approveCell);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  wrap.innerHTML = '';
  wrap.appendChild(table);
  show(wrap);
}

// ==============================
// ステップ4: 前月差分チェック
// ==============================
function setupStep4() {
  $('btn-step4-back').addEventListener('click', () => goToStep(3));
  $('btn-step4-next').addEventListener('click', () => goToStep(5));
}

async function runStep4() {
  try {
    // ── 業務委託 スナップショット保存・差分チェック ──
    await saveSnapshot(AppState.contractors, AppState.storeName, AppState.periodYm);
    const prevContractors = await getPrevSnapshot(AppState.storeName, AppState.periodYm);
    AppState.prevContractors = prevContractors;

    let diffResults;
    if (prevContractors.length === 0) {
      diffResults = checkDiffFirstTime(AppState.contractors);
    } else {
      diffResults = checkDiff(AppState.contractors, prevContractors);
    }
    AppState.diffResults = diffResults;
    renderDiffTable('diff-staff-list', diffResults, prevContractors.length === 0, AppState.contractors, 'contractors');

    // ── DR スナップショット保存・差分チェック ──
    if (AppState.drList && AppState.drList.length > 0) {
      await saveDRSnapshot(AppState.drList, AppState.storeName, AppState.periodYm);
      const prevDrList = await getPrevDRSnapshot(AppState.storeName, AppState.periodYm);
      AppState.prevDrList = prevDrList;

      let drDiffResults;
      if (prevDrList.length === 0) {
        drDiffResults = checkDRDiffFirstTime(AppState.drList);
      } else {
        drDiffResults = checkDRDiff(AppState.drList, prevDrList);
      }
      AppState.drDiffResults = drDiffResults;
      renderDiffTable('diff-dr-list', drDiffResults, prevDrList.length === 0, AppState.drList, 'drList');

      // DRタブを表示
      $('tab-diff-dr-btn').style.display = '';
      const drAlerts = drDiffResults.filter(r => r.severity === 'alert').length;
      if (drAlerts > 0) showToast(`DR差分: ${drAlerts}件の要確認項目があります`, 'warning');
    } else {
      $('tab-diff-dr-btn').style.display = 'none';
      const drWrap = $('diff-dr-list');
      drWrap.innerHTML = '<div style="padding:1rem;color:var(--gray-400)">DRファイルが未アップロードのため、DR差分チェックをスキップしました。</div>';
    }

    const alerts = diffResults.filter(r => r.severity === 'alert').length;
    if (alerts > 0) showToast(`業務委託差分: ${alerts}件の要確認項目があります`, 'warning');
    else showToast('前月差分チェック完了', 'success');

  } catch (e) {
    console.error('Step4 error:', e);
    $('diff-staff-list').innerHTML = '<div style="padding:1rem;color:var(--danger)">前月差分チェックでエラーが発生しました: ' + e.message + '</div>';
    showToast('前月差分チェックでエラーが発生しました', 'error');
  }
}

function renderDiffTable(wrapperId, results, isFirstTime, currentList, stateKey) {
  const wrap = $(wrapperId);

  if (isFirstTime) {
    const summaryHtml = stateKey === 'drList'
      ? buildDRSummary(currentList)
      : buildContractorSummary(currentList);
    wrap.innerHTML = `
      <div style="padding:1.5rem">
        <div class="badge badge-info" style="margin-bottom:0.5rem"><i class="fas fa-info-circle"></i> 初回登録</div>
        <p style="font-size:0.9rem;color:var(--gray-600);margin-top:0.5rem">前月のデータがないため、今月のデータを登録しました。次月から差分チェックが有効になります。</p>
        ${summaryHtml}
      </div>`;
    show(wrap);
    return;
  }

  if (results.length === 0) {
    wrap.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--gray-400)">差分なし</div>';
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['氏名', '変更種別', '変更前', '変更後', '詳細', '承認'].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  results.forEach((r, idx) => {
    const tr = document.createElement('tr');

    [
      r.name,
    ].forEach(text => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });

    // 変更種別バッジ
    const typeTd = document.createElement('td');
    const badgeClass = r.severity === 'alert' ? 'badge-ng' : r.severity === 'info' ? 'badge-info' : 'badge-ok';
    typeTd.innerHTML = `<span class="badge ${badgeClass}">${r.label}</span>`;
    tr.appendChild(typeTd);

    // 変更前
    const beforeTd = document.createElement('td');
    beforeTd.textContent = r.before ?? '-';
    beforeTd.style.fontSize = '0.85rem';
    tr.appendChild(beforeTd);

    // 変更後
    const afterTd = document.createElement('td');
    afterTd.textContent = r.after ?? '-';
    afterTd.style.fontSize = '0.85rem';
    tr.appendChild(afterTd);

    // 詳細
    const detailTd = document.createElement('td');
    detailTd.textContent = r.details;
    detailTd.style.fontSize = '0.82rem';
    detailTd.style.color = 'var(--gray-500)';
    tr.appendChild(detailTd);

    // 承認（alertのみ）
    const approveTd = document.createElement('td');
    if (r.severity === 'alert') {
      const toggle = document.createElement('label');
      toggle.className = 'approve-toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = r.isManualApproved;
      checkbox.addEventListener('change', e => {
        const arr = stateKey === 'drList' ? AppState.drDiffResults : AppState.diffResults;
        if (arr[idx]) arr[idx].isManualApproved = e.target.checked;
      });
      const lbl = document.createElement('span');
      lbl.textContent = '確認OK';
      toggle.appendChild(checkbox);
      toggle.appendChild(lbl);
      approveTd.appendChild(toggle);
    } else {
      approveTd.innerHTML = '<span class="badge badge-gray">-</span>';
    }
    tr.appendChild(approveTd);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  wrap.innerHTML = '';
  wrap.appendChild(table);
  show(wrap);
}

function buildDRSummary(drList) {
  if (!drList || drList.length === 0) return '';
  return `<table style="margin-top:1rem;width:100%;border-collapse:collapse;font-size:0.9rem">
    <thead><tr>
      <th style="text-align:left;padding:6px;border-bottom:1px solid var(--gray-200)">氏名</th>
      <th style="text-align:right;padding:6px;border-bottom:1px solid var(--gray-200)">ドライバー報酬</th>
      <th style="text-align:right;padding:6px;border-bottom:1px solid var(--gray-200)">仮払（日払い）</th>
      <th style="text-align:right;padding:6px;border-bottom:1px solid var(--gray-200)">合計</th>
    </tr></thead>
    <tbody>${drList.map(dr => `<tr>
      <td style="padding:6px;border-bottom:1px solid var(--gray-100)">${escapeHtml(dr.name)}</td>
      <td style="padding:6px;text-align:right;border-bottom:1px solid var(--gray-100)">${formatYen(dr.driverReward)}</td>
      <td style="padding:6px;text-align:right;border-bottom:1px solid var(--gray-100)">${formatYen(dr.karibaraiYen)}</td>
      <td style="padding:6px;text-align:right;border-bottom:1px solid var(--gray-100)">${formatYen(dr.totalAmount)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function buildContractorSummary(contractors) {
  return `<table style="margin-top:1rem;width:100%;border-collapse:collapse;font-size:0.9rem">
    <thead><tr>
      <th style="text-align:left;padding:6px;border-bottom:1px solid var(--gray-200)">氏名</th>
      <th style="text-align:right;padding:6px;border-bottom:1px solid var(--gray-200)">基本給</th>
      <th style="text-align:right;padding:6px;border-bottom:1px solid var(--gray-200)">日払い</th>
    </tr></thead>
    <tbody>${contractors.map(c => `<tr>
      <td style="padding:6px;border-bottom:1px solid var(--gray-100)">${escapeHtml(c.name)}</td>
      <td style="padding:6px;text-align:right;border-bottom:1px solid var(--gray-100)">${c.basicPayMan}万円</td>
      <td style="padding:6px;text-align:right;border-bottom:1px solid var(--gray-100)">${formatYen(c.dailyPayYen)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

// ==============================
// ステップ5: 出力
// ==============================
function setupStep5() {
  $('btn-step5-back').addEventListener('click', () => goToStep(4));
  $('btn-step5-download').addEventListener('click', handleDownload);
  $('btn-step5-dr-download').addEventListener('click', handleDRDownload);
}

function runStep5() {
  // 業務委託プレビュー
  const { rows: staffRows, total: staffTotal } = buildInvoicePreviewData(AppState.contractors, AppState.periodYm);
  renderInvoicePreview('invoice-preview-staff', staffRows, staffTotal, false);

  // DRプレビュー
  if (AppState.drList && AppState.drList.length > 0) {
    const { rows: drRows, total: drTotal } = buildDRInvoicePreviewData(AppState.drList, AppState.periodYm);
    renderInvoicePreview('invoice-preview-dr', drRows, drTotal, true);
    $('tab-output-dr-btn').style.display = '';
    $('btn-step5-dr-download').style.display = '';
  } else {
    $('tab-output-dr-btn').style.display = 'none';
    $('btn-step5-dr-download').style.display = 'none';
    $('invoice-preview-dr').innerHTML = '<div style="padding:1rem;color:var(--gray-400)">DRファイルが未アップロードのため出力できません。</div>';
    show($('invoice-preview-dr'));
  }
}

function renderInvoicePreview(wrapperId, rows, total, isDR) {
  const wrap = $(wrapperId);
  if (!wrap) return;
  if (rows.length === 0) {
    wrap.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--gray-400)">データがありません</div>';
    show(wrap);
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['氏名', '種別', '金額', ''].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach(r => {
    const tr = document.createElement('tr');
    if (r.isSubtotal) {
      tr.style.background = '#f0f9ff';
      tr.style.fontWeight = 'bold';
    }
    [r.name, r.desc,
      r.amount === 0 ? '¥0' : formatYen(r.amount),
      r.isSubtotal ? '← 合計' : ''
    ].forEach(v => {
      const td = document.createElement('td');
      td.textContent = v;
      if (typeof r.amount === 'number' && v === formatYen(r.amount)) td.style.textAlign = 'right';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  // 合計行
  const totalTr = document.createElement('tr');
  totalTr.style.background = '#e0f2fe';
  totalTr.style.fontWeight = 'bold';
  totalTr.style.fontSize = '1.05em';
  ['', '総合計', formatYen(total), ''].forEach(v => {
    const td = document.createElement('td');
    td.textContent = v;
    if (v === formatYen(total)) td.style.textAlign = 'right';
    totalTr.appendChild(td);
  });
  tbody.appendChild(totalTr);

  wrap.innerHTML = '';
  wrap.appendChild(table);
  show(wrap);
}

async function handleDownload() {
  const btn = $('btn-step5-download');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 生成中...';

  try {
    const { fileName, copied } = await generateAndDownloadInvoice(
      AppState.contractors,
      AppState.reportBuffer,
      AppState.storeName,
      AppState.periodYm
    );
    showToast(`ダウンロード完了: ${fileName}（${copied}名）`, 'success');
  } catch (e) {
    console.error('Download error:', e);
    showToast('Excel生成でエラーが発生しました: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-download"></i> 内勤請求Excelをダウンロード';
  }
}

async function handleDRDownload() {
  const btn = $('btn-step5-dr-download');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 生成中...';

  try {
    const { fileName, copied } = await generateAndDownloadDRInvoice(
      AppState.drList,
      AppState.drBuffer,
      AppState.storeName,
      AppState.periodYm
    );
    showToast(`ダウンロード完了: ${fileName}（${copied}名）`, 'success');
  } catch (e) {
    console.error('DR Download error:', e);
    showToast('DR請求Excel生成でエラーが発生しました: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-car"></i> DR請求Excelをダウンロード';
  }
}

// ==============================
// ステップナビゲーション
// ==============================
function goToStep(step) {
  // 現在のステップを非表示
  const current = $(`step-${AppState.currentStep}`);
  if (current) current.classList.remove('active');

  // ステップナビ更新
  document.querySelectorAll('.step-item').forEach(item => {
    const s = parseInt(item.dataset.step);
    item.classList.remove('active', 'done');
    if (s < step) item.classList.add('done');
    else if (s === step) item.classList.add('active');
  });

  // 新しいステップを表示
  const next = $(`step-${step}`);
  if (next) next.classList.add('active');

  AppState.currentStep = step;
  window.scrollTo(0, 0);

  // ステップ固有の処理
  if (step === 2) runStep2();
  else if (step === 3) runStep3();
  else if (step === 4) runStep4();
  else if (step === 5) runStep5();
}

// ==============================
// タブ切り替え
// ==============================
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.tab;
      // ボタン
      btn.closest('.tab-bar').querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // コンテンツ
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      const target = $(targetId);
      if (target) target.classList.add('active');
    });
  });
}

// ==============================
// DR 突合テーブル描画
// ==============================
function renderDRReconcileTable(results) {
  const wrap = $('dr-reconcile-list');
  if (!results || results.length === 0) {
    wrap.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--gray-400)">DR突合結果がありません</div>';
    show(wrap);
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['DRタブ名', '氏名', '月計表の科目（元データ）', 'DRファイル仮払', '月計表 日払い', 'ドライバー報酬', '判定', '理由', '承認'].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  results.forEach((r, idx) => {
    const tr = document.createElement('tr');
    if (r.status === 'NG') tr.classList.add('row-dr-ng');

    // タブ名
    const sheetTd = document.createElement('td');
    sheetTd.textContent = r.sheetName || '—';
    sheetTd.style.fontSize = '0.85rem';
    tr.appendChild(sheetTd);

    // 氏名
    const nameTd = document.createElement('td');
    if (r.drKaribaraiYen === null) {
      nameTd.innerHTML = `<span class="text-muted">${escapeHtml(r.name)}</span><br><span style="font-size:0.75rem;color:var(--warning)">DRファイルに未登録</span>`;
    } else {
      nameTd.textContent = r.name;
    }
    tr.appendChild(nameTd);

    // 月計表元ラベル
    const rawTd = document.createElement('td');
    rawTd.textContent = r.monthlyRawLabel || '-';
    rawTd.style.fontSize = '0.85rem';
    rawTd.style.color = 'var(--gray-500)';
    tr.appendChild(rawTd);

    // DRファイル仮払
    const kariTd = document.createElement('td');
    kariTd.style.textAlign = 'right';
    kariTd.textContent = r.drKaribaraiYen === null ? '—' : formatYen(r.drKaribaraiYen);
    tr.appendChild(kariTd);

    // 月計表日払い
    const monthlyTd = document.createElement('td');
    monthlyTd.style.textAlign = 'right';
    monthlyTd.textContent = formatYen(r.monthlyDailyPayYen);
    tr.appendChild(monthlyTd);

    // ドライバー報酬
    const rewardTd = document.createElement('td');
    rewardTd.style.textAlign = 'right';
    rewardTd.textContent = r.driverReward !== null ? formatYen(r.driverReward) : '—';
    tr.appendChild(rewardTd);

    // 判定
    const statusTd = document.createElement('td');
    statusTd.innerHTML = r.status === 'OK'
      ? '<span class="badge badge-ok"><i class="fas fa-check"></i> OK</span>'
      : '<span class="badge badge-ng"><i class="fas fa-times"></i> NG</span>';
    tr.appendChild(statusTd);

    // 理由
    const reasonTd = document.createElement('td');
    reasonTd.textContent = r.reason;
    reasonTd.style.fontSize = '0.85rem';
    tr.appendChild(reasonTd);

    // 承認チェック（NGのみ）
    const approveTd = document.createElement('td');
    if (r.status === 'NG') {
      const toggle = document.createElement('label');
      toggle.className = 'approve-toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = r.isManualApproved;
      checkbox.addEventListener('change', e => {
        AppState.drReconcileResults[idx].isManualApproved = e.target.checked;
        if (e.target.checked) tr.classList.remove('row-dr-ng');
        else tr.classList.add('row-dr-ng');
      });
      const lbl = document.createElement('span');
      lbl.textContent = '確認OK';
      toggle.appendChild(checkbox);
      toggle.appendChild(lbl);
      approveTd.appendChild(toggle);
    } else {
      approveTd.innerHTML = '<span class="badge badge-ok">-</span>';
    }
    tr.appendChild(approveTd);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.innerHTML = '';
  wrap.appendChild(table);
  show(wrap);
}

// ==============================
// リセット
// ==============================
function setupReset() {
  $('btn-reset-storage').addEventListener('click', async () => {
    if (!confirmDialog('保存されているすべてのスナップショットデータを削除しますか？\n（業務委託・DRの前月差分チェックのデータがリセットされます）')) return;
    try {
      await deleteAllSnapshots();
      await deleteAllDRSnapshots();
      showToast('データをリセットしました（業務委託・DR両方）', 'success');
    } catch (e) {
      showToast('リセットに失敗しました: ' + e.message, 'error');
    }
  });
}

// ==============================
// ユーティリティ
// ==============================
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
