/**
 * utils.js - ユーティリティ関数群
 * 正規化・フォーマット・DOM操作など
 */

'use strict';

// ==============================
// テキスト正規化
// ==============================

/**
 * セル値を文字列に変換し、全角/半角スペース、制御文字を除去して正規化
 */
function normText(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  // 全角スペース → 半角スペース、タブ文字 → 半角スペース、連続スペースを1つに
  return s.replace(/\u3000/g, ' ').replace(/\t/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 人物名を名寄せ用に正規化
 * - 全角スペース → 半角スペース
 * - 先頭の接頭辞（DR、スタッフ等）を除去
 * - 末尾の「日払」「日払い」等を除去
 * - 連続スペース整理
 */
function normalizePersonName(v) {
  if (!v) return '';
  let s = normText(v);
  // 接頭辞除去
  s = s.replace(/^(DR|ＤＲ|スタッフ|STAFF)\s*/i, '');
  // 「日払い」「日払」を末尾から除去
  s = s.replace(/[\s　]*(日払い|日払)[\s　]*$/g, '');
  // 連続スペース整理
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * 苗字のみ取得（スペース前の部分）
 */
function getSurname(fullName) {
  const n = normText(fullName);
  const parts = n.split(/\s+/);
  return parts[0] || n;
}

/**
 * ファイル名から店舗名と年月を抽出
 * パターン例：【西川口】内勤請求2026.2.xlsx
 *             【立川】業務報告書2026.2.xlsx
 *             nishikawaguchi_gyomu_hokokusho_2026-02.xlsx
 */
function parseFileNameInfo(fileName) {
  let storeName = '';
  let periodYm = ''; // YYYY-MM 形式

  // 【店舗名】パターン
  const storeMatch = fileName.match(/【([^】]+)】/);
  if (storeMatch) storeName = storeMatch[1];

  // YYYY.M または YYYY.MM パターン
  const periodMatch = fileName.match(/(\d{4})[.\-_](\d{1,2})/);
  if (periodMatch) {
    const year = periodMatch[1];
    const month = String(parseInt(periodMatch[2])).padStart(2, '0');
    periodYm = `${year}-${month}`;
  }

  return { storeName, periodYm };
}

/**
 * periodYm (YYYY-MM) を表示用「YYYY.M」に変換
 */
function formatPeriodDisplay(periodYm) {
  if (!periodYm) return '';
  const m = periodYm.match(/(\d{4})-(\d{2})/);
  if (!m) return periodYm;
  return `${m[1]}.${parseInt(m[2])}`;
}

// ==============================
// 数値フォーマット
// ==============================

/**
 * 円表示（例: 260,000円）
 */
function formatYen(value) {
  const n = Number(value);
  if (isNaN(n)) return '¥-';
  return '¥' + n.toLocaleString('ja-JP');
}

/**
 * 万円 → 円換算（整数）
 */
function manYenToYen(manYen) {
  return Math.round(Number(manYen) * 10000);
}

// ==============================
// DOM ユーティリティ
// ==============================

function $(id) { return document.getElementById(id); }
function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden'); }
function toggleHidden(el, visible) {
  if (visible) show(el); else hide(el);
}

/**
 * トースト通知を表示
 * @param {string} message
 * @param {'success'|'error'|'warning'|'info'} type
 * @param {number} duration ms
 */
function showToast(message, type = 'info', duration = 3000) {
  const container = $('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icons = { success: 'fa-check-circle', error: 'fa-times-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' };
  toast.innerHTML = `<i class="fas ${icons[type] || 'fa-info-circle'}"></i><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity .3s';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/**
 * 確認ダイアログ
 */
function confirmDialog(message) {
  return window.confirm(message);
}

// ==============================
// テーブルビルダー
// ==============================

/**
 * 汎用テーブル生成
 * @param {Array} headers - {label, key, align?} の配列
 * @param {Array} rows - データ配列
 * @param {Function} renderRow - 各行のTR要素を返す関数（省略時デフォルト）
 */
function buildTable(headers, rows, renderRow = null) {
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headers.forEach(h => {
    const th = document.createElement('th');
    th.textContent = h.label;
    if (h.align) th.style.textAlign = h.align;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach(row => {
    if (renderRow) {
      const tr = renderRow(row);
      if (tr) tbody.appendChild(tr);
    } else {
      const tr = document.createElement('tr');
      headers.forEach(h => {
        const td = document.createElement('td');
        const val = row[h.key];
        td.textContent = (val === null || val === undefined) ? '' : val;
        if (h.align) td.style.textAlign = h.align;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  });
  table.appendChild(tbody);
  return table;
}

// ==============================
// ファイル読み込みユーティリティ
// ==============================

/**
 * FileオブジェクトをArrayBufferとして読み込む
 */
function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('ファイル読み込みエラー'));
    reader.readAsArrayBuffer(file);
  });
}

// ==============================
// SheetJS ヘルパー
// ==============================

/**
 * SheetJSのワークシートから全セルを {r, c, value} の配列で取得
 */
function getAllCells(ws) {
  const cells = [];
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (cell) {
        cells.push({ r, c, value: cell.v !== undefined ? cell.v : null });
      }
    }
  }
  return cells;
}

/**
 * セル値を取得（安全版）
 */
function getCellValue(ws, r, c) {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = ws[addr];
  if (!cell || cell.v === undefined) return null;
  return cell.v;
}

/**
 * シート内で指定テキストを含む最初のセルを返す {r, c} / null
 */
function findCellContaining(ws, needle, caseSensitive = false) {
  if (!needle || !ws || !ws['!ref']) return null;
  const cells = getAllCells(ws);
  const target = caseSensitive ? needle : needle.toLowerCase();
  for (const cell of cells) {
    const text = normText(String(cell.value ?? ''));
    const compare = caseSensitive ? text : text.toLowerCase();
    if (compare.includes(target)) return { r: cell.r, c: cell.c };
  }
  return null;
}

/**
 * シート内のすべての行を {rowIdx, values[]} として取得
 */
function getSheetRows(ws) {
  if (!ws || !ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rows = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const values = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      values.push(getCellValue(ws, r, c));
    }
    rows.push({ rowIdx: r, values });
  }
  return rows;
}
