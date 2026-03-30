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
  setupSnapshotModal(); // モーダルのイベント設定
  loadSnapshotList();   // 起動時にスナップショット一覧を表示
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
      basicPayMan: c.basicPayMan, dailyPayYen: c.dailyPayYen,
      companyName: c.companyName, representativeName: c.representativeName
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
    { label: '氏名',           key: 'name' },
    { label: '名義カナ',       key: 'holderDisplay' },
    { label: '役職',           key: 'roleDisplay' },
    { label: '基本給',         key: 'basicPayManDisplay',    align: 'right' },
    { label: '昇給希望額',     key: 'raiseRequestDisplay',   align: 'right' },
    { label: '大入り',         key: 'oiriDisplay',           align: 'right' },
    { label: '日払い',         key: 'dailyPayYenDisplay',    align: 'right' },
    { label: '事務所レンタル', key: 'officeRentDisplay',     align: 'right' },
    { label: 'その他',         key: 'otherDisplay' },
    { label: '警告',           key: 'warningBadge' }
  ];

  const rowData = people.map(c => ({
    ...c,
    _isContractor:        (c.role || '').includes('業務委託'),
    roleDisplay:          c.role || '（不明）',
    basicPayManDisplay:   `${c.basicPayMan ?? 0}万円`,
    raiseRequestDisplay:  (c.raiseRequestMan ?? 0) > 0 ? `${c.raiseRequestMan}万円` : '-',
    oiriDisplay:          (c.oiriMan ?? 0) > 0 ? `${c.oiriMan}万円` : '-',
    dailyPayYenDisplay:   (c.dailyPayYen ?? 0) > 0 ? formatYen(c.dailyPayYen) : '-',
    officeRentDisplay:    (c.officeRentYen ?? 0) > 0 ? formatYen(c.officeRentYen) : '-',
    otherDisplay:         (c.otherItems ?? []).length > 0
                            ? c.otherItems.map(o => `${o.label}:${formatYen(o.amount)}`).join(' / ')
                            : '-',
    holderDisplay:        c.bank?.accountHolderKana || '-',
    warningBadge:         (c.warnings?.length ?? 0) > 0 ? `⚠ ${c.warnings.length}件` : '✓'
  }));

  // タブ分け用: 業務委託 / その他（それ以外）
  const contractors = rowData.filter(r => r._isContractor);
  const others      = rowData.filter(r => !r._isContractor);

  // 件数サマリー
  const summary = document.createElement('div');
  summary.style.cssText = 'padding:0.7rem 1rem; border-bottom:1px solid var(--border); display:flex; gap:1rem; align-items:center; font-size:0.78rem;';
  summary.innerHTML = `
    <span style="color:var(--text-muted)">合計 <strong style="color:var(--text-primary)">${rowData.length}名</strong></span>
    <span class="badge badge-ok">業務委託 ${contractors.length}名</span>
    <span class="badge badge-gray">その他 ${others.length}名</span>
  `;

  // テーブル生成ヘルパー
  function buildPeopleTable(rows) {
    const table = buildTable(headers, rows, row => {
      const tr = document.createElement('tr');
      headers.forEach(h => {
        const td = document.createElement('td');
        if (h.key === 'roleDisplay') {
          const span = document.createElement('span');
          span.className = row._isContractor ? 'badge badge-ok' : 'badge badge-gray';
          span.textContent = row[h.key];
          span.title = row[h.key];
          td.style.whiteSpace = 'nowrap';
          td.appendChild(span);
        } else if (h.key === 'warningBadge') {
          const span = document.createElement('span');
          const hasWarn = (row.warnings?.length > 0);
          span.className = hasWarn ? 'badge badge-warn' : 'badge badge-ok';
          span.textContent = row[h.key];
          td.appendChild(span);
        } else if (h.key === 'name') {
          td.textContent = row[h.key] ?? '';
          td.style.fontWeight = '600';
        } else if (h.key === 'otherDisplay') {
          td.className = 'td-wrap';
          td.textContent = (row[h.key] === null || row[h.key] === undefined) ? '' : row[h.key];
        } else {
          td.textContent = (row[h.key] === null || row[h.key] === undefined) ? '' : row[h.key];
        }
        if (h.align) td.style.textAlign = h.align;
        tr.appendChild(td);
      });
      return tr;
    });
    return table;
  }

  // タブなし・全員を1枚テーブルで表示
  wrap.innerHTML = '';
  wrap.appendChild(summary);
  if (rowData.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:1.5rem;text-align:center;color:var(--gray-400)';
    empty.textContent = '社員名簿に人員が見つかりません';
    wrap.appendChild(empty);
  } else {
    wrap.appendChild(buildPeopleTable(rowData));
  }
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

    // 業務委託 突合（allPeople 全員を渡して社員も表示、reconcile内でフラグ付与）
    const results = reconcile(AppState.allPeople, dailyPayEntries);
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
  const staffNg = results.filter(r => r.status === 'NG').length;
  const staffOk = results.filter(r => r.status === 'OK').length;
  const drNg = (AppState.drReconcileResults || []).filter(r => r.status === 'NG').length;
  const drOk = (AppState.drReconcileResults || []).filter(r => r.status === 'OK').length;
  $('kpi-ok-count').textContent = staffOk + drOk;
  $('kpi-ng-count').textContent = staffNg + drNg;
  show($('reconcile-kpi'));
}

function renderReconcileTable(results) {
  const wrap = $('reconcile-list');
  if (results.length === 0) {
    wrap.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--gray-400)">突合結果がありません</div>';
    show(wrap);
    return;
  }

  // サマリー（業務委託 / 社員 / 未登録）
  const contractorCount = results.filter(r => r._isContractor && r.reportDailyPayYen !== null).length;
  const employeeCount   = results.filter(r => !r._isContractor && r.reportDailyPayYen !== null).length;
  const unmatchedCount  = results.filter(r => r.reportDailyPayYen === null).length;
  const ngCount         = results.filter(r => r.status === 'NG').length;
  const summary = document.createElement('div');
  summary.style.cssText = 'padding:0.7rem 1rem; border-bottom:1px solid var(--border); display:flex; gap:1rem; align-items:center; flex-wrap:wrap; font-size:0.78rem;';
  summary.innerHTML = `
    <span class="badge badge-ok">業務委託 ${contractorCount}名</span>
    <span class="badge badge-gray">社員 ${employeeCount}名</span>
    ${unmatchedCount > 0 ? `<span class="badge badge-warn">名簿未登録 ${unmatchedCount}件</span>` : ''}
    <span style="margin-left:auto" class="badge ${ngCount > 0 ? 'badge-ng' : 'badge-ok'}">NG ${ngCount}件</span>
  `;

  const table = document.createElement('table');
  // ヘッダー
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['氏名（業務報告書）', '区分', '月計表の科目（元データ）', '報告書 日払い', '月計表 日払い', '判定', '理由', '承認'].forEach(label => {
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
    // 社員行はミュート
    if (!r._isContractor && r.reportDailyPayYen !== null) tr.style.opacity = '0.6';

    // 氏名列
    const nameCell = document.createElement('td');
    if (r.reportDailyPayYen === null) {
      nameCell.innerHTML = `<span class="text-muted">${escapeHtml(r.name)}</span>
        <br><span style="font-size:0.75rem;color:var(--warning)">業務報告書に未登録</span>`;
    } else {
      nameCell.textContent = r.name;
      if (r._isContractor) nameCell.style.fontWeight = '700';
    }
    tr.appendChild(nameCell);

    // 区分バッジ
    const roleCell = document.createElement('td');
    if (r.reportDailyPayYen === null) {
      roleCell.innerHTML = '<span class="badge badge-warn">未登録</span>';
    } else if (r._isContractor) {
      roleCell.innerHTML = '<span class="badge badge-ok">委託</span>';
    } else {
      roleCell.innerHTML = '<span class="badge badge-gray">社員</span>';
    }
    tr.appendChild(roleCell);

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

    // 理由（折り返しあり）
    const reasonCell = document.createElement('td');
    reasonCell.className = 'td-wrap';
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
  wrap.appendChild(summary);
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
    // allPeople（全員）＋突合結果を一緒に保存
    await saveSnapshot(AppState.allPeople, AppState.storeName, AppState.periodYm, AppState.reconcileResults);
    const prevContractors = await getPrevSnapshot(AppState.storeName, AppState.periodYm);
    AppState.prevContractors = prevContractors;

    let diffResults;
    if (prevContractors.length === 0) {
      diffResults = checkDiffFirstTime(AppState.allPeople);
    } else {
      diffResults = checkDiff(AppState.allPeople, prevContractors);
    }
    AppState.diffResults = diffResults;
    renderDiffTable('diff-staff-list', diffResults, prevContractors.length === 0, AppState.contractors, 'contractors');

    // ── DR スナップショット保存・差分チェック ──
    if (AppState.drList && AppState.drList.length > 0) {
      await saveDRSnapshot(AppState.drList, AppState.storeName, AppState.periodYm, AppState.drReconcileResults);
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

    // スナップショット一覧を更新
    loadSnapshotList();

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
  $('btn-step5-restart').addEventListener('click', () => goToStep(1));
}

function runStep5() {
  // DRファイルがある場合のみDRダウンロードボタンを表示
  if (AppState.drBuffer) {
    $('btn-step5-dr-download').style.display = '';
  } else {
    $('btn-step5-dr-download').style.display = 'none';
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
  ['DRタブ名', '氏名', '月計表の科目（元データ）', 'DRファイル仮払', '月計表 日払い', 'ドライバー報酬', '２％チェック', '判定', '理由', '承認'].forEach(label => {
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

    // 適格請求支払手数料チェック
    const feeTd = document.createElement('td');
    feeTd.style.textAlign = 'center';
    if (!r.feeCheck) {
      feeTd.innerHTML = '<span class="badge badge-gray">—</span>';
    } else if (r.feeCheck.ok) {
      feeTd.innerHTML = `<span class="badge badge-ok"><i class="fas fa-check"></i> OK</span>
        <div style="font-size:0.75rem;color:var(--gray-500);margin-top:2px">${formatYen(r.feeCheck.actual)}</div>`;
    } else {
      feeTd.innerHTML = `<span class="badge badge-ng"><i class="fas fa-times"></i> NG</span>
        <div style="font-size:0.75rem;color:var(--danger);margin-top:2px">実: ${formatYen(r.feeCheck.actual)} / 期待: ${formatYen(r.feeCheck.expected)}</div>`;
    }
    tr.appendChild(feeTd);

    // 判定
    const statusTd = document.createElement('td');
    statusTd.innerHTML = r.status === 'OK'
      ? '<span class="badge badge-ok"><i class="fas fa-check"></i> OK</span>'
      : '<span class="badge badge-ng"><i class="fas fa-times"></i> NG</span>';
    tr.appendChild(statusTd);

    // 理由（折り返しあり）
    const reasonTd = document.createElement('td');
    reasonTd.className = 'td-wrap';
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
      await loadSnapshotList(); // 一覧を再読み込み
    } catch (e) {
      showToast('リセットに失敗しました: ' + e.message, 'error');
    }
  });
}

// ==============================
// スナップショット一覧表示
// ==============================
async function loadSnapshotList() {
  const listEl   = $('snapshot-list');
  const statusEl = $('snapshot-status');
  if (!listEl) return;

  listEl.innerHTML = '<div class="snapshot-empty"><i class="fas fa-spinner fa-spin"></i> 読み込み中...</div>';

  try {
    // IndexedDB から両テーブルを取得
    const { staffRows, drRows } = await getAllSnapshotRows();

    // 年月単位でグループ化
    // periodGroups[periodYm][storeName] = { staffCount, drCount }
    const periodGroups = {};
    for (const r of staffRows) {
      if (!periodGroups[r.period_ym]) periodGroups[r.period_ym] = {};
      if (!periodGroups[r.period_ym][r.store_name]) periodGroups[r.period_ym][r.store_name] = { staffCount: 0, drCount: 0 };
      periodGroups[r.period_ym][r.store_name].staffCount++;
    }
    for (const r of drRows) {
      if (!periodGroups[r.period_ym]) periodGroups[r.period_ym] = {};
      if (!periodGroups[r.period_ym][r.store_name]) periodGroups[r.period_ym][r.store_name] = { staffCount: 0, drCount: 0 };
      periodGroups[r.period_ym][r.store_name].drCount++;
    }

    const periods = Object.keys(periodGroups).sort((a, b) => b.localeCompare(a));

    if (periods.length === 0) {
      listEl.innerHTML = '<div class="snapshot-empty">[ NO DATA ] 保存済みスナップショットはありません</div>';
      if (statusEl) statusEl.textContent = '0 records';
      return;
    }

    const totalStores = Object.values(periodGroups).reduce((n, g) => n + Object.keys(g).length, 0);
    if (statusEl) statusEl.textContent = `${periods.length} period(s) / ${totalStores} store(s)`;

    listEl.innerHTML = '';
    for (const periodYm of periods) {
      const stores = periodGroups[periodYm];
      const storeNames = Object.keys(stores).sort();
      const [y, m] = (periodYm || '').split('-');
      const periodLabel = y && m ? `${y}年${m}月` : periodYm;

      const row = document.createElement('div');
      row.className = 'snapshot-row';

      // 年月ラベル
      const periodSpan = document.createElement('span');
      periodSpan.className = 'snapshot-period';
      periodSpan.textContent = periodLabel;
      row.appendChild(periodSpan);

      // 店舗チップ群（クリックで詳細モーダル）
      const storesWrap = document.createElement('span');
      storesWrap.className = 'snapshot-stores';
      for (const storeName of storeNames) {
        const chip = document.createElement('span');
        chip.className = 'snapshot-store-chip';
        chip.innerHTML = `<i class="fas fa-store"></i> ${escapeHtml(storeName || '店舗名不明')}`;
        chip.title = `${periodLabel} / ${storeName} — クリックして詳細表示`;
        chip.addEventListener('click', () => openSnapshotModal(storeName, periodYm, periodLabel));
        storesWrap.appendChild(chip);
      }
      row.appendChild(storesWrap);
      listEl.appendChild(row);
    }
  } catch (e) {
    console.error('スナップショット一覧取得エラー:', e);
    listEl.innerHTML = '<div class="snapshot-empty">[ ERROR ] データの読み込みに失敗しました</div>';
    if (statusEl) statusEl.textContent = 'error';
  }
}

// ==============================
// スナップショット詳細モーダル
// ==============================
function setupSnapshotModal() {
  const overlay = $('snapshot-modal');
  const closeBtn = $('snap-modal-close');

  closeBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.style.display = 'none'; });

  // タブ切り替え
  overlay.querySelectorAll('.snap-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.snap-tab-btn').forEach(b => b.classList.remove('active'));
      overlay.querySelectorAll('.snap-tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const target = $(btn.dataset.snapTab);
      if (target) target.classList.add('active');
    });
  });
}

async function openSnapshotModal(storeName, periodYm, periodLabel) {
  const overlay = $('snapshot-modal');
  $('snap-modal-title').textContent = `${periodLabel}  //  ${storeName}`;
  $('snap-modal-sub').textContent   = `STORE: ${storeName}  |  PERIOD: ${periodYm}`;

  // タブを委託者情報に戻す
  document.querySelectorAll('.snap-tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.snap-tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('.snap-tab-btn[data-snap-tab="snap-tab-people"]').classList.add('active');
  $('snap-tab-people').classList.add('active');

  // ローディング表示
  ['snap-tab-people', 'snap-tab-reconcile', 'snap-tab-diff'].forEach(id => {
    $(id).innerHTML = '<div style="padding:1.5rem;text-align:center;font-family:var(--font-mono);font-size:0.75rem;color:var(--text-muted)"><i class="fas fa-spinner fa-spin"></i> 読み込み中...</div>';
  });
  overlay.style.display = 'flex';

  try {
    // IndexedDB から該当レコード取得
    const { staffRows: allStaff, drRows: allDR } = await getAllSnapshotRows();
    const allRows = allStaff.filter(r => r.store_name === storeName && r.period_ym === periodYm);
    const drRows  = allDR.filter(r => r.store_name === storeName && r.period_ym === periodYm);

    // 前月スナップショット（差分用）
    const [y, mo] = periodYm.split('-').map(Number);
    let prevY = y, prevMo = mo - 1;
    if (prevMo < 1) { prevMo = 12; prevY--; }
    const prevYm  = `${prevY}-${String(prevMo).padStart(2, '0')}`;
    const prevRows   = allStaff.filter(r => r.store_name === storeName && r.period_ym === prevYm);
    const prevDrRows = allDR.filter(r => r.store_name === storeName && r.period_ym === prevYm);

    renderSnapPeopleTab(allRows);
    renderSnapReconcileTab(allRows, drRows);
    renderSnapDiffTab(allRows, prevRows, prevYm, drRows, prevDrRows);

  } catch (e) {
    console.error('モーダルデータ取得エラー:', e);
    $('snap-tab-people').innerHTML = `<div style="padding:1rem;color:var(--danger)">データ取得エラー: ${e.message}</div>`;
  }
}

function renderSnapPeopleTab(rows) {
  const el = $('snap-tab-people');
  if (!rows.length) { el.innerHTML = '<div style="padding:1rem;color:var(--text-muted)">データがありません</div>'; return; }

  // ステップ2と同じ並び順・項目で表示
  // 業務委託を上、社員を下にソート
  const sorted = [...rows].sort((a, b) => {
    const aIsC = (a.role || '').includes('業務委託');
    const bIsC = (b.role || '').includes('業務委託');
    if (aIsC && !bIsC) return -1;
    if (!aIsC && bIsC) return 1;
    return 0;
  });

  // サマリーバー
  const contractorCount = sorted.filter(r => (r.role || '').includes('業務委託')).length;
  const employeeCount   = sorted.length - contractorCount;
  const summary = document.createElement('div');
  summary.style.cssText = 'padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);display:flex;gap:0.75rem;align-items:center;font-size:0.72rem;margin-bottom:0.5rem;';
  summary.innerHTML = `
    <span style="color:var(--text-muted)">合計 <strong style="color:var(--text-primary)">${sorted.length}名</strong></span>
    <span class="badge badge-ok">業務委託 ${contractorCount}名</span>
    <span class="badge badge-gray">社員 ${employeeCount}名</span>
  `;

  // テーブル（ステップ2と同じ列順）
  // 氏名 / 名義カナ / 役職 / 基本給 / 昇給希望額 / 大入り / 日払い / 事務所レンタル / その他 / 警告
  const t = document.createElement('table');
  t.innerHTML = `<thead><tr>
    <th>氏名</th>
    <th>名義カナ</th>
    <th>役職</th>
    <th style="text-align:right">基本給</th>
    <th style="text-align:right">昇給希望額</th>
    <th style="text-align:right">大入り</th>
    <th style="text-align:right">日払い</th>
    <th style="text-align:right">事務所レンタル</th>
    <th>その他</th>
    <th>警告</th>
  </tr></thead>`;
  const tb = document.createElement('tbody');

  for (const r of sorted) {
    const isContractor = (r.role || '').includes('業務委託');
    const tr = document.createElement('tr');
    if (!isContractor) tr.classList.add('snap-row-employee');

    const otherItems = JSON.parse(r.other_items_json || '[]');
    const otherText  = otherItems.length
      ? otherItems.map(o => `${o.label}:${formatYen(o.amount)}`).join(' / ')
      : '-';
    const warnCount = JSON.parse(r.warnings_json || '[]').length;
    const warnText  = warnCount > 0 ? `⚠ ${warnCount}件` : '✓';

    // 列定義（ステップ2と同じ順）
    const cols = [
      { v: r.person_name,   bold: isContractor },
      { v: r.account_holder_kana || '-' },
      { v: r.role || '（不明）', badge: true, isC: isContractor },
      { v: Number(r.basic_pay_man) > 0 ? `${r.basic_pay_man}万円` : `${r.basic_pay_man ?? 0}万円`, align: 'right' },
      { v: Number(r.raise_request_man) > 0 ? `${r.raise_request_man}万円` : '-', align: 'right' },
      { v: Number(r.oiri_man) > 0 ? `${r.oiri_man}万円` : '-',             align: 'right' },
      { v: Number(r.daily_pay_yen) > 0 ? formatYen(r.daily_pay_yen) : '-', align: 'right' },
      { v: Number(r.office_rent_yen) > 0 ? formatYen(r.office_rent_yen) : '-', align: 'right' },
      { v: otherText, wrap: true },
      { v: warnText, warnBadge: true, hasWarn: warnCount > 0 }
    ];

    cols.forEach(col => {
      const td = document.createElement('td');
      if (col.align) td.style.textAlign = col.align;
      if (col.wrap) td.className = 'td-wrap';

      if (col.badge) {
        // 役職バッジ（ステップ2と同じスタイル）
        const span = document.createElement('span');
        span.className = col.isC ? 'badge badge-ok' : 'badge badge-gray';
        span.textContent = col.v;
        span.title = col.v;
        td.style.whiteSpace = 'nowrap';
        td.appendChild(span);
      } else if (col.warnBadge) {
        const span = document.createElement('span');
        span.className = col.hasWarn ? 'badge badge-warn' : 'badge badge-ok';
        span.textContent = col.v;
        td.appendChild(span);
      } else {
        td.textContent = col.v;
        if (col.bold) td.style.fontWeight = '700';
      }
      tr.appendChild(td);
    });

    tb.appendChild(tr);
  }
  t.appendChild(tb);

  el.innerHTML = '';
  el.appendChild(summary);
  el.appendChild(t);
}

function renderSnapReconcileTab(rows, drRows) {
  const el = $('snap-tab-reconcile');
  el.innerHTML = '';

  const staffWithRec = rows.filter(r => r.reconcile_status && r.reconcile_status !== 'NONE');

  if (!staffWithRec.length) {
    el.innerHTML = '<div style="padding:1.5rem;color:var(--text-muted);font-family:var(--font-mono);font-size:0.75rem;">突合結果が保存されていません。<br>次回ステップ4を実行すると保存されます。</div>';
    return;
  }

  // サマリー（NG件数 / 業務委託 / 社員）
  const ngCount  = staffWithRec.filter(r => r.reconcile_status === 'NG').length;
  const cCount   = staffWithRec.filter(r => (r.role || '').includes('業務委託')).length;
  const eCount   = staffWithRec.length - cCount;
  const summary  = document.createElement('div');
  summary.style.cssText = 'padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);display:flex;gap:0.75rem;align-items:center;font-size:0.72rem;margin-bottom:0.5rem;flex-wrap:wrap;';
  summary.innerHTML = `
    <span class="badge badge-ok">業務委託 ${cCount}名</span>
    <span class="badge badge-gray">社員 ${eCount}名</span>
    <span style="margin-left:auto" class="badge ${ngCount > 0 ? 'badge-ng' : 'badge-ok'}">NG ${ngCount}件</span>
  `;
  el.appendChild(summary);

  // NG先頭・業務委託優先ソート（ステップ3と同じ）
  const sorted = [...staffWithRec].sort((a, b) => {
    if (a.reconcile_status === 'NG' && b.reconcile_status !== 'NG') return -1;
    if (a.reconcile_status !== 'NG' && b.reconcile_status === 'NG') return 1;
    const aC = (a.role || '').includes('業務委託');
    const bC = (b.role || '').includes('業務委託');
    if (aC && !bC) return -1;
    if (!aC && bC) return 1;
    return 0;
  });

  // ステップ3と同じ列順：氏名 / 区分 / 報告書日払い / 月計表日払い / 判定 / 理由
  const t = document.createElement('table');
  t.innerHTML = `<thead><tr>
    <th>氏名</th>
    <th>区分</th>
    <th style="text-align:right">報告書 日払い</th>
    <th style="text-align:right">月計表 日払い</th>
    <th>判定</th>
    <th>理由</th>
  </tr></thead>`;
  const tb = document.createElement('tbody');

  sorted.forEach(r => {
    const isContractor = (r.role || '').includes('業務委託');
    const tr = document.createElement('tr');
    if (r.reconcile_status === 'NG') tr.classList.add('snap-row-ng');
    if (!isContractor) tr.classList.add('snap-row-employee');

    // 氏名
    const nameTd = document.createElement('td');
    nameTd.textContent = r.person_name;
    if (isContractor) nameTd.style.fontWeight = '700';
    tr.appendChild(nameTd);

    // 区分バッジ
    const roleTd = document.createElement('td');
    roleTd.innerHTML = isContractor
      ? '<span class="badge badge-ok">委託</span>'
      : '<span class="badge badge-gray">社員</span>';
    tr.appendChild(roleTd);

    // 報告書日払い
    const repTd = document.createElement('td');
    repTd.style.textAlign = 'right';
    repTd.textContent = Number(r.daily_pay_yen) > 0 ? formatYen(r.daily_pay_yen) : '-';
    tr.appendChild(repTd);

    // 月計表日払い
    const monTd = document.createElement('td');
    monTd.style.textAlign = 'right';
    monTd.textContent = Number(r.reconcile_monthly_yen) > 0 ? formatYen(r.reconcile_monthly_yen) : '-';
    tr.appendChild(monTd);

    // 判定バッジ
    const stTd = document.createElement('td');
    stTd.innerHTML = r.reconcile_status === 'OK'
      ? '<span class="badge badge-ok"><i class="fas fa-check"></i> OK</span>'
      : '<span class="badge badge-ng"><i class="fas fa-times"></i> NG</span>';
    tr.appendChild(stTd);

    // 理由（折り返しあり）
    const reTd = document.createElement('td');
    reTd.className = 'td-wrap';
    reTd.textContent = r.reconcile_reason || '-';
    reTd.style.fontSize = '0.78rem';
    tr.appendChild(reTd);

    tb.appendChild(tr);
  });
  t.appendChild(tb);
  el.appendChild(t);

  // DR情報（DRスナップショットがある場合）— 業務委託と同じ列で表示
  if (drRows.length) {
    const h2 = document.createElement('div');
    h2.style.cssText = 'padding:1rem 0 0.3rem;font-family:var(--font-mono);font-size:0.67rem;color:var(--info);letter-spacing:0.1em;border-top:1px solid var(--border);margin-top:0.75rem;';
    const drNgCount = drRows.filter(r => r.reconcile_status === 'NG').length;
    h2.innerHTML = `▸ DR ${drRows.length}名　<span class="badge ${drNgCount > 0 ? 'badge-ng' : 'badge-ok'}" style="vertical-align:middle">NG ${drNgCount}件</span>`;
    el.appendChild(h2);

    // 業務委託と同じ列順：氏名 / 区分 / 報告書日払い（仮払） / 月計表日払い / 判定 / 理由
    const t2 = document.createElement('table');
    t2.innerHTML = `<thead><tr>
      <th>氏名</th>
      <th>区分</th>
      <th style="text-align:right">DRファイル仮払</th>
      <th style="text-align:right">月計表 日払い</th>
      <th>判定</th>
      <th>理由</th>
    </tr></thead>`;
    const tb2 = document.createElement('tbody');
    const drSorted = [...drRows].sort((a, b) => {
      if (a.reconcile_status === 'NG' && b.reconcile_status !== 'NG') return -1;
      if (a.reconcile_status !== 'NG' && b.reconcile_status === 'NG') return 1;
      return 0;
    });
    drSorted.forEach(r => {
      const tr = document.createElement('tr');
      if (r.reconcile_status === 'NG') tr.classList.add('snap-row-ng');

      // 氏名
      const nameTd = document.createElement('td');
      nameTd.textContent = r.person_name;
      nameTd.style.fontWeight = '700';
      tr.appendChild(nameTd);

      // 区分バッジ
      const roleTd = document.createElement('td');
      roleTd.innerHTML = '<span class="badge badge-info">DR</span>';
      tr.appendChild(roleTd);

      // DRファイル仮払
      const kariTd = document.createElement('td');
      kariTd.style.textAlign = 'right';
      kariTd.textContent = Number(r.karibara_yen) > 0 ? formatYen(r.karibara_yen) : '-';
      tr.appendChild(kariTd);

      // 月計表日払い
      const monTd = document.createElement('td');
      monTd.style.textAlign = 'right';
      const monYen = Number(r.reconcile_monthly_yen ?? 0);
      monTd.textContent = monYen > 0 ? formatYen(monYen) : '-';
      tr.appendChild(monTd);

      // 判定バッジ
      const stTd = document.createElement('td');
      const st = r.reconcile_status ?? 'NONE';
      if (st === 'OK') stTd.innerHTML = '<span class="badge badge-ok"><i class="fas fa-check"></i> OK</span>';
      else if (st === 'NG') stTd.innerHTML = '<span class="badge badge-ng"><i class="fas fa-times"></i> NG</span>';
      else stTd.innerHTML = '<span class="badge badge-gray">—</span>';
      tr.appendChild(stTd);

      // 理由
      const reTd = document.createElement('td');
      reTd.className = 'td-wrap';
      reTd.textContent = r.reconcile_reason || '-';
      reTd.style.fontSize = '0.78rem';
      tr.appendChild(reTd);

      tb2.appendChild(tr);
    });
    t2.appendChild(tb2);
    el.appendChild(t2);
  }
}

function renderSnapDiffTab(currentRows, prevRows, prevYm, currentDrRows, prevDrRows) {
  const el = $('snap-tab-diff');
  if (!prevRows.length) {
    const [py, pm] = (prevYm || '').split('-');
    const prevLabel = py && pm ? `${py}年${pm}月` : prevYm;
    el.innerHTML = `<div style="padding:1.5rem;font-family:var(--font-mono);font-size:0.75rem;color:var(--text-muted)">
      前月（${prevLabel}）のスナップショットがないため差分を表示できません。
    </div>`;
    return;
  }

  // 前月マップ（person_keyで照合）
  const prevMap = {};
  prevRows.forEach(r => { prevMap[r.person_key] = r; });

  const diffs = [];

  for (const r of currentRows) {
    const prev = prevMap[r.person_key];
    if (!prev) {
      diffs.push({ name: r.person_name, label: '新規追加', before: '-', after: r.role || '-', severity: 'info' });
      continue;
    }

    let hasChange = false;

    // 役職
    if ((r.role || '') !== (prev.role || '')) {
      diffs.push({ name: r.person_name, label: '役職変更', before: prev.role || '（空）', after: r.role || '（空）', severity: 'alert' });
      hasChange = true;
    }
    // 基本給
    if (Number(r.basic_pay_man) !== Number(prev.basic_pay_man)) {
      diffs.push({ name: r.person_name, label: '基本給変更', before: `${prev.basic_pay_man}万円`, after: `${r.basic_pay_man}万円`, severity: 'alert' });
      hasChange = true;
    }
    // 振込先（銀行名・支店名・口座種別・口座番号・名義カナ）
    const bankFields = [
      { key: 'bank_name',           label: '銀行名' },
      { key: 'branch_name',         label: '支店名' },
      { key: 'account_type',        label: '口座種別' },
      { key: 'account_number',      label: '口座番号' },
      { key: 'account_holder_kana', label: '名義カナ' }
    ];
    for (const f of bankFields) {
      const cv = String(r[f.key] ?? '');
      const pv = String(prev[f.key] ?? '');
      if (cv !== pv) {
        const dispBefore = f.key === 'account_number' ? ('****' + pv.slice(-4)) : (pv || '-');
        const dispAfter  = f.key === 'account_number' ? ('****' + cv.slice(-4)) : (cv || '-');
        diffs.push({ name: r.person_name, label: `振込先変更（${f.label}）`, before: dispBefore, after: dispAfter, severity: 'alert' });
        hasChange = true;
      }
    }
    // 会社名
    if ((r.company_name || '') !== (prev.company_name || '')) {
      diffs.push({ name: r.person_name, label: '会社名変更', before: prev.company_name || '（空）', after: r.company_name || '（空）', severity: 'alert' });
      hasChange = true;
    }
    // 代表者名（日付は毎月変わるため対象外）
    if ((r.representative_name || '') !== (prev.representative_name || '')) {
      diffs.push({ name: r.person_name, label: '代表者名変更', before: prev.representative_name || '（空）', after: r.representative_name || '（空）', severity: 'alert' });
      hasChange = true;
    }

    if (!hasChange) {
      diffs.push({ name: r.person_name, label: '変更なし', before: '-', after: '-', severity: 'ok' });
    }
  }

  // 退職者（今月いない人）
  const currentKeys = new Set(currentRows.map(r => r.person_key));
  for (const r of prevRows) {
    if (!currentKeys.has(r.person_key))
      diffs.push({ name: r.person_name, label: '削除', before: r.role || '-', after: '-', severity: 'info' });
  }

  // alertを先頭に
  const order = { alert: 0, info: 1, ok: 2 };
  diffs.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

  const t = document.createElement('table');
  t.innerHTML = `<thead><tr><th>氏名</th><th>変更種別</th><th>変更前</th><th>変更後</th></tr></thead>`;
  const tb = document.createElement('tbody');
  diffs.forEach(d => {
    const tr = document.createElement('tr');
    if (d.severity === 'alert') tr.classList.add('snap-row-ng');
    [d.name].forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
    const labelTd = document.createElement('td');
    const badgeClass = d.severity === 'alert' ? 'badge-ng' : d.severity === 'info' ? 'badge-gray' : 'badge-ok';
    labelTd.innerHTML = `<span class="badge ${badgeClass}">${escapeHtml(d.label)}</span>`;
    tr.appendChild(labelTd);
    [d.before, d.after].forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  el.innerHTML = '';
  el.appendChild(t);

  // ── DR差分セクション ──
  if (currentDrRows && currentDrRows.length) {
    const h2 = document.createElement('div');
    h2.style.cssText = 'padding:1rem 0 0.3rem;font-family:var(--font-mono);font-size:0.67rem;color:var(--info);letter-spacing:0.1em;border-top:1px solid var(--border);margin-top:1rem;';

    const drDiffs = [];
    const prevDrMap = {};
    (prevDrRows || []).forEach(r => { prevDrMap[r.person_key] = r; });

    for (const r of currentDrRows) {
      const prev = prevDrMap[r.person_key];
      if (!prev) {
        drDiffs.push({ name: r.person_name, label: '新規追加', before: '-', after: '-', severity: 'info' });
        continue;
      }
      let hasChange = false;
      // ドライバー報酬は毎月変動するため差分チェック対象外
      // 振込先
      const drBankFields = [
        { key: 'bank_name', label: '銀行名' }, { key: 'branch_name', label: '支店名' },
        { key: 'account_type', label: '口座種別' }, { key: 'account_number', label: '口座番号' },
        { key: 'account_holder_kana', label: '名義カナ' }
      ];
      for (const f of drBankFields) {
        const cv = String(r[f.key] ?? ''), pv = String(prev[f.key] ?? '');
        if (cv !== pv) {
          const db = f.key === 'account_number' ? ('****' + pv.slice(-4)) : (pv || '-');
          const da = f.key === 'account_number' ? ('****' + cv.slice(-4)) : (cv || '-');
          drDiffs.push({ name: r.person_name, label: `振込先変更（${f.label}）`, before: db, after: da, severity: 'alert' });
          hasChange = true;
        }
      }
      if (!hasChange) drDiffs.push({ name: r.person_name, label: '変更なし', before: '-', after: '-', severity: 'ok' });
    }
    (prevDrRows || []).forEach(r => {
      if (!currentDrRows.find(c => c.person_key === r.person_key))
        drDiffs.push({ name: r.person_name, label: '削除', before: '-', after: '-', severity: 'info' });
    });

    drDiffs.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
    const alertCount = drDiffs.filter(d => d.severity === 'alert').length;
    h2.innerHTML = `▸ DR差分 ${currentDrRows.length}名　<span class="badge ${alertCount > 0 ? 'badge-ng' : 'badge-ok'}" style="vertical-align:middle">要確認 ${alertCount}件</span>`;
    el.appendChild(h2);

    if (!prevDrRows || !prevDrRows.length) {
      const msg = document.createElement('div');
      msg.style.cssText = 'padding:0.75rem;font-size:0.78rem;color:var(--text-muted);';
      msg.textContent = '前月DRスナップショットがないため差分を表示できません。';
      el.appendChild(msg);
    } else {
      const t2 = document.createElement('table');
      t2.innerHTML = `<thead><tr><th>氏名</th><th>変更種別</th><th>変更前</th><th>変更後</th></tr></thead>`;
      const tb2 = document.createElement('tbody');
      drDiffs.forEach(d => {
        const tr = document.createElement('tr');
        if (d.severity === 'alert') tr.classList.add('snap-row-ng');
        [d.name].forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
        const labelTd = document.createElement('td');
        const bc = d.severity === 'alert' ? 'badge-ng' : d.severity === 'info' ? 'badge-gray' : 'badge-ok';
        labelTd.innerHTML = `<span class="badge ${bc}">${escapeHtml(d.label)}</span>`;
        tr.appendChild(labelTd);
        [d.before, d.after].forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
        tb2.appendChild(tr);
      });
      t2.appendChild(tb2);
      el.appendChild(t2);
    }
  }
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
