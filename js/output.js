/**
 * output.js - 内勤請求 / DR請求 Excel出力
 *
 * ★★★ 方針: JSZip による ZIP直接操作方式 ★★★
 *
 * ExcelJS / SheetJS でモデルコピーすると書式・罫線・色・結合が消える問題を回避するため、
 * XLSX ファイルの ZIP を直接操作してシートXMLをバイト単位でコピーする。
 *
 * 手順:
 *  1) JSZip で元ファイルを解凍
 *  2) workbook.xml からシート一覧（id・name・sheetId）を取得
 *  3) 対象シートの XML ファイル (xl/worksheets/sheetN.xml) を特定
 *  4) 新しいZIPに必要なファイルをコピー:
 *     - [Content_Types].xml  (コピー対象シートのみ残す)
 *     - _rels/.rels          (そのまま)
 *     - xl/workbook.xml      (対象シートのみ)
 *     - xl/_rels/workbook.xml.rels (対象シートのみ)
 *     - xl/worksheets/sheetN.xml  (対象シートのみ、XML無変更)
 *     - xl/styles.xml        (そのまま)
 *     - xl/sharedStrings.xml (そのまま)
 *     - xl/theme/theme1.xml  (そのまま)
 *     - docProps/            (そのまま)
 *
 * 依存: JSZip, file-saver
 */

'use strict';

// ============================================================
// 業務委託 請求Excel
// ============================================================

/**
 * @param {Array}       contractors   - contractors[] (.sheetName が必要)
 * @param {ArrayBuffer} reportBuffer  - 業務報告書の ArrayBuffer
 * @param {string}      storeName
 * @param {string}      periodYm      - "YYYY-MM"
 */
async function generateAndDownloadInvoice(contractors, reportBuffer, storeName, periodYm) {
  const periodDisplay = formatPeriodDisplay(periodYm);
  const fileName = `【${storeName}】内勤請求${periodDisplay}.xlsx`;

  const sheetNames = contractors
    .map(c => c.sheetName)
    .filter(n => !!n);

  if (sheetNames.length === 0) {
    throw new Error('個人タブ名が取得できていません。業務報告書を再読み込みしてください。');
  }

  const outBuf = await extractSheetsFromXlsx(reportBuffer, sheetNames);
  saveAs(new Blob([outBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName);

  const total = contractors.reduce((s, c) => s + calcContractorTotal(c), 0);
  return { fileName, totalAmount: total, copied: sheetNames.length };
}

function calcContractorTotal(c) {
  const basicYen = Math.round((c.basicPayMan ?? 0) * 10000);
  const rentYen  = Math.round(basicYen * 0.1);
  const dailyYen = Math.round(c.dailyPayYen ?? 0);
  return basicYen - rentYen - dailyYen;
}

// ============================================================
// DR 請求Excel
// ============================================================

/**
 * @param {Array}       drList    - drList[] (.sheetName が必要)
 * @param {ArrayBuffer} drBuffer  - DR距離計算フォーマットの ArrayBuffer
 * @param {string}      storeName
 * @param {string}      periodYm
 */
async function generateAndDownloadDRInvoice(drList, drBuffer, storeName, periodYm) {
  const periodDisplay = formatPeriodDisplay(periodYm);
  const fileName = `【${storeName}】DR請求${periodDisplay}.xlsx`;

  if (!drBuffer) {
    throw new Error('DRファイルがアップロードされていません。');
  }

  const sheetNames = drList
    .map(dr => dr.sheetName)
    .filter(n => !!n);

  if (sheetNames.length === 0) {
    throw new Error('DR個人タブ名が取得できていません。DRファイルを再読み込みしてください。');
  }

  const outBuf = await extractSheetsFromXlsx(drBuffer, sheetNames);
  saveAs(new Blob([outBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName);

  const total = drList.reduce((s, dr) => s + Math.round(dr.totalAmount ?? 0), 0);
  return { fileName, totalAmount: total, copied: sheetNames.length };
}

// ============================================================
// JSZip によるシートXML直接コピー
// ============================================================

/**
 * 元 XLSX の ZIP から指定シートを抽出し、新しい XLSX として返す。
 * シートXML・styles・sharedStrings・theme をすべてそのまま流用するため
 * 書式・罫線・色・結合・行高・列幅がすべて保持される。
 *
 * @param {ArrayBuffer} srcBuffer   - 元 XLSX の ArrayBuffer
 * @param {string[]}    targetNames - 抽出したいシート名の配列
 * @returns {Promise<ArrayBuffer>}
 */
async function extractSheetsFromXlsx(srcBuffer, targetNames) {
  // ----- 1) 元ファイルを JSZip で開く -----
  const srcZip = await JSZip.loadAsync(srcBuffer);

  // ----- 2) workbook.xml を解析してシート一覧を取得 -----
  const wbXml = await srcZip.file('xl/workbook.xml').async('string');
  const sheetInfoList = parseWorkbookXmlSheets(wbXml);
  // sheetInfoList: [{name, sheetId, rId}]

  // workbook.xml.rels を解析して rId → target の対応を得る
  const relsXml = await srcZip.file('xl/_rels/workbook.xml.rels').async('string');
  const relsMap  = parseRelsXml(relsXml);
  // relsMap: {rId: target}  例: {rId1: 'worksheets/sheet1.xml'}

  // ----- 3) 対象シートをフィルタ -----
  const targetSet = new Set(targetNames);
  const selected  = sheetInfoList.filter(s => targetSet.has(s.name));

  if (selected.length === 0) {
    throw new Error(`元ファイルに対象シートが見つかりません: ${targetNames.join(', ')}`);
  }

  // ----- 4) 新しい ZIP を構築 -----
  const outZip = new JSZip();

  // --- [Content_Types].xml ---
  const ctXml = await srcZip.file('[Content_Types].xml').async('string');
  const newCtXml = rebuildContentTypes(ctXml, selected);
  outZip.file('[Content_Types].xml', newCtXml);

  // --- _rels/.rels ---
  // 最小限の内容で生成（officeDocument参照のみ）
  const dotRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
  outZip.file('_rels/.rels', dotRelsXml);

  // --- xl/workbook.xml ---
  const newWbXml = rebuildWorkbookXml(wbXml, selected);
  outZip.file('xl/workbook.xml', newWbXml);

  // --- xl/_rels/workbook.xml.rels ---
  const newRelsXml = rebuildWorkbookRels(relsXml, selected);
  outZip.file('xl/_rels/workbook.xml.rels', newRelsXml);

  // --- xl/worksheets/sheetN.xml ---
  // シートXMLはテキストとして読み込み、他シート参照数式を除去してから保存する。
  // 数式タグ <f>...</f> を残すと、出力ブックに参照先シートがないため
  // Excelが「問題が見つかり可能な限り内容を回復」エラーを出す。
  // <f> タグを削除しても <v>（計算済み値）は残るので表示値は変わらない。
  for (let i = 0; i < selected.length; i++) {
    const info    = selected[i];
    const origTarget = relsMap[info.rId]; // e.g. "worksheets/sheet8.xml"
    const srcPath = 'xl/' + origTarget;   // e.g. "xl/worksheets/sheet8.xml"
    const dstPath = `xl/worksheets/sheet${i + 1}.xml`;

    // テキストとして読み込み、<f>タグを除去
    let sheetXml = await srcZip.file(srcPath).async('string');
    sheetXml = removeFormulaTags(sheetXml);
    outZip.file(dstPath, sheetXml);

    // シートに対する .rels があればコピー
    const origSheetName = origTarget.replace('worksheets/', ''); // e.g. "sheet8.xml"
    const origRelsPath  = `xl/worksheets/_rels/${origSheetName}.rels`;
    const sheetRelsFile = srcZip.file(origRelsPath);
    if (sheetRelsFile) {
      const sheetRelsContent = await sheetRelsFile.async('uint8array');
      outZip.file(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, sheetRelsContent);

      // .rels の中で参照されている printerSettings などのバイナリも一緒にコピー
      const sheetRelsStr = await sheetRelsFile.async('string');
      const refTargets = [...sheetRelsStr.matchAll(/Target="([^"]+)"/g)].map(m => m[1]);
      for (const refTarget of refTargets) {
        // 相対パス (../printerSettings/xxx.bin 等) を xl/ からの絶対パスに変換
        const absPath = resolveRelPath('xl/worksheets/', refTarget);
        if (absPath) {
          await copyZipFile(srcZip, outZip, absPath);
        }
      }
    }
  }

  // --- xl/styles.xml ---
  await copyZipFile(srcZip, outZip, 'xl/styles.xml');

  // --- xl/sharedStrings.xml ---
  // count属性を出力シートの実際参照数に修正（不整合でExcelが回復エラーを出す）
  const ssFile = srcZip.file('xl/sharedStrings.xml');
  if (ssFile) {
    // 出力シート全体でのt="s"参照総数を数える
    let ssRefCount = 0;
    for (let i = 0; i < selected.length; i++) {
      const dstPath = `xl/worksheets/sheet${i + 1}.xml`;
      const sheetStr = await outZip.file(dstPath).async('string');
      ssRefCount += [...sheetStr.matchAll(/<c [^>]*t="s"[^>]*>/g)].length;
    }
    let ssXml = await ssFile.async('string');
    // count="566" → 実際の参照数に置換、uniqueCountはそのまま
    ssXml = ssXml.replace(/(<sst[^>]*\bcount=")\d+(")/,
      (_, pre, post) => `${pre}${ssRefCount}${post}`);
    outZip.file('xl/sharedStrings.xml', ssXml);
  }

  // --- xl/theme/theme1.xml ---
  const themeFile = srcZip.file('xl/theme/theme1.xml');
  if (themeFile) {
    await copyZipFile(srcZip, outZip, 'xl/theme/theme1.xml');
  }

  // --- xl/theme/ 以下のすべてのファイル ---
  for (const relPath of Object.keys(srcZip.files)) {
    if (relPath.startsWith('xl/theme/') && !srcZip.files[relPath].dir) {
      await copyZipFile(srcZip, outZip, relPath);
    }
  }

  // calcChain.xml は数式参照が壊れる原因になるため意図的に除外
  // (Excelが開いた際に自動再生成される)

  // --- docProps/ ---
  // app.xml の HeadingPairs / TitlesOfParts を出力シート数に合わせて再構築
  for (const relPath of Object.keys(srcZip.files)) {
    if (srcZip.files[relPath].dir) continue;
    if (!relPath.startsWith('docProps/')) continue;
    if (relPath === 'docProps/app.xml') {
      let appXml = await srcZip.file(relPath).async('string');
      appXml = rebuildAppXml(appXml, selected);
      outZip.file(relPath, appXml);
    } else {
      await copyZipFile(srcZip, outZip, relPath);
    }
  }

  // --- xl/drawings/, xl/ctrlProps/, xl/comments*, xl/vmlDrawing* などをコピー ---
  // シートXMLが参照する可能性があるすべてのxl/配下ファイルをコピーする。
  // ただし以下は除外:
  //   - xl/worksheets/        （既に処理済み）
  //   - xl/persons/           （workbook.xml.relsから参照削除済み）
  //   - xl/theme/             （既にコピー済み）
  //   - xl/workbook.xml       （rebuildWorkbookXmlで生成済み・上書き禁止）
  //   - xl/_rels/workbook.xml.rels （rebuildWorkbookRelsで生成済み・上書き禁止）
  //   - xl/styles.xml         （既にコピー済み）
  //   - xl/sharedStrings.xml  （既に処理済み）
  //   - xl/calcChain.xml      （意図的に除外）
  const SKIP_PREFIXES = ['xl/worksheets/', 'xl/persons/', 'xl/theme/'];
  const SKIP_FILES    = [
    'xl/calcChain.xml',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/sharedStrings.xml',
  ];
  for (const relPath of Object.keys(srcZip.files)) {
    if (srcZip.files[relPath].dir) continue;
    if (!relPath.startsWith('xl/')) continue;
    if (SKIP_PREFIXES.some(p => relPath.startsWith(p))) continue;
    if (SKIP_FILES.includes(relPath)) continue;
    await copyZipFile(srcZip, outZip, relPath);
  }

  // ----- 5) 出力 -----
  const outBuf = await outZip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });

  return outBuf;
}

/**
 * シートXMLから <f>...</f> 数式タグを除去する。
 * <v>（計算済み値）は残すので表示値は変わらない。
 * これにより、出力ブックに参照先シートがなくても Excelがエラーを出さない。
 *
 * ケース1: <f>数式</f>  → 削除
 * ケース2: <f t="shared" ...>数式</f>  → 削除
 * ケース3: <f/> （空数式）→ 削除
 *
 * セル型属性 t="str"（文字列数式）の場合、<v>がないと空セルになるが
 * 通常は計算済みキャッシュ <v> が存在するので問題なし。
 */
function removeFormulaTags(xml) {
  // <f ...>...</f> を削除（複数行対応）
  xml = xml.replace(/<f\b[^>]*>[\s\S]*?<\/f>/g, '');
  // <f/> または <f .../> を削除
  xml = xml.replace(/<f\b[^>]*\/>/g, '');
  return xml;
}

/**
 * 相対パスを絶対パス（ZIPキー）に解決する
 * @param {string} relPath   - 相対パス (e.g. '../printerSettings/printerSettings8.bin')
 * @returns {string|null}    - ZIPキー (e.g. 'xl/printerSettings/printerSettings8.bin')
 */
function resolveRelPath(basePath, relPath) {
  if (!relPath) return null;
  // http:// 等の絶対URLは無視
  if (/^https?:\/\//.test(relPath)) return null;
  // 絶対パス（/で始まる）はそのまま（先頭スラッシュ除去）
  if (relPath.startsWith('/')) return relPath.slice(1);

  // 相対パスを解決
  const parts = (basePath + relPath).split('/');
  const resolved = [];
  for (const part of parts) {
    if (part === '..') {
      resolved.pop();
    } else if (part !== '.') {
      resolved.push(part);
    }
  }
  return resolved.join('/');
}

// ============================================================
// XML パース・再構築 ヘルパー
// ============================================================

/**
 * workbook.xml の <sheet> 要素一覧を取得
 * @returns {Array<{name:string, sheetId:string, rId:string}>}
 */
function parseWorkbookXmlSheets(xml) {
  const results = [];
  // <sheet name="..." sheetId="..." r:Id="rId1"/> または <sheet .../>
  const re = /<sheet\s([^>]+?)\/>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const name    = attrVal(attrs, 'name');
    const sheetId = attrVal(attrs, 'sheetId');
    const rId     = attrVal(attrs, 'r:Id') || attrVal(attrs, 'r:id');
    if (name && sheetId && rId) {
      results.push({ name, sheetId, rId });
    }
  }
  return results;
}

/**
 * workbook.xml.rels の <Relationship> 一覧を取得
 * @returns {Object} {Id: Target}  e.g. {"rId1": "worksheets/sheet1.xml"}
 */
function parseRelsXml(xml) {
  const map = {};
  const re = /<Relationship\s([^>]+?)\/>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs  = m[1];
    const id     = attrVal(attrs, 'Id');
    const target = attrVal(attrs, 'Target');
    if (id && target) {
      map[id] = target;
    }
  }
  return map;
}

/** XML属性値を取得するユーティリティ */
function attrVal(attrs, name) {
  const re = new RegExp(`${name}="([^"]*)"`, 'i');
  const m  = re.exec(attrs);
  return m ? unescapeXml(m[1]) : null;
}

function unescapeXml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * [Content_Types].xml を再構築する。
 *
 * - worksheetのOverrideは新しいシート番号に置き換える
 * - persons/calcChain等の不要なOverrideは除外
 * - それ以外のOverride（styles,theme,sharedStrings,docProps等）は元ファイルから引き継ぐ
 * - Defaultは元ファイルをそのまま引き継ぐ（ctrlPropsのxml等に対応）
 */
function rebuildContentTypes(ctXml, selected) {
  const WS_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

  // 除外するOverrideのPartName（出力ZIPに含まれないファイル）
  const EXCLUDE_PART_PATTERNS = [
    /\/xl\/persons\//,
    /\/xl\/calcChain\.xml/,
    /\/xl\/worksheets\//,   // 後で新しいパスで追加
  ];

  // 元ファイルのDefaultをすべて引き継ぐ
  const defaults = (ctXml.match(/<Default\s[^>]+?\/>/g) || []);

  // 元ファイルのOverrideから安全なものを引き継ぐ
  const keptOverrides = [];
  for (const ov of (ctXml.match(/<Override\s[^>]+?\/>/g) || [])) {
    const partName = attrVal(ov, 'PartName') || '';
    if (EXCLUDE_PART_PATTERNS.some(p => p.test(partName))) continue;
    keptOverrides.push(ov);
  }

  // 新しいシートのOverrideを追加
  const sheetOverrides = selected.map((_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${WS_CT}"/>`
  );

  const allOverrides = [...sheetOverrides, ...keptOverrides];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n${defaults.join('\n')}\n${allOverrides.join('\n')}\n</Types>`;
}

/**
 * xl/workbook.xml を最小限の安全な内容で生成する。
 *
 * 元ファイルを流用すると xr:revisionPtr, extLst, bookViews の activeTab など
 * 不整合な要素が残り Excel が回復エラーを出す場合がある。
 * そのため必要最低限の要素だけで新規生成する。
 */
function rebuildWorkbookXml(wbXml, selected) {
  const sheetsBlock = selected.map((s, i) =>
    `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
  ).join('\n    ');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="29127"/>
  <workbookPr defaultThemeVersion="166925"/>
  <bookViews>
    <workbookView xWindow="0" yWindow="0" windowWidth="16384" windowHeight="8192"/>
  </bookViews>
  <sheets>
    ${sheetsBlock}
  </sheets>
  <calcPr calcId="191029"/>
</workbook>`;
}

/**
 * xl/_rels/workbook.xml.rels を最小限の安全な内容で生成する。
 *
 * 元ファイルを流用すると persons, calcChain, externalLinks など
 * 出力ZIPに存在しないファイルへの参照が残りExcelが回復エラーを出す。
 * そのため必要なファイルのみ参照する新規ファイルを生成する。
 *
 * 含む: styles, theme, sharedStrings（存在する場合）, 各シート
 */
function rebuildWorkbookRels(relsXml, selected) {
  const NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const rels = [];
  let nextId = selected.length + 1;

  // 必須: styles
  rels.push(`<Relationship Id="rId${nextId++}" Type="${NS}/styles" Target="styles.xml"/>`);
  // 必須: theme
  rels.push(`<Relationship Id="rId${nextId++}" Type="${NS}/theme" Target="theme/theme1.xml"/>`);
  // 任意: sharedStrings（元ファイルに存在する場合のみ）
  const hasSharedStrings = relsXml.includes('sharedStrings');
  if (hasSharedStrings) {
    rels.push(`<Relationship Id="rId${nextId++}" Type="${NS}/sharedStrings" Target="sharedStrings.xml"/>`);
  }

  // シート（rId1 〜 rIdN）
  const sheetRels = selected.map((s, i) =>
    `<Relationship Id="rId${i + 1}" Type="${NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  );

  const allRels = [...sheetRels, ...rels];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n${allRels.join('\n')}\n</Relationships>`;
}

/**
 * srcZip から outZip へファイルをコピー
 */
async function copyZipFile(srcZip, outZip, path) {
  const file = srcZip.file(path);
  if (!file) return;
  const content = await file.async('uint8array');
  outZip.file(path, content);
}

// ============================================================
// ユーティリティ
// ============================================================

/**
 * docProps/app.xml の HeadingPairs / TitlesOfParts を
 * 出力シート数・シート名に合わせて書き換える。
 * これが元ファイルのまま（11シート分）だと Excel が整合性エラーを出す。
 */
function rebuildAppXml(appXml, selected) {
  const count = selected.length;
  const names = selected.map(s => `<vt:lpstr>${escapeXml(s.name)}</vt:lpstr>`).join('');

  // <HeadingPairs> 内の <vt:i4> をシート数に書き換え
  appXml = appXml.replace(
    /(<HeadingPairs>[\s\S]*?<vt:variant>\s*<vt:i4>)\d+(<\/vt:i4>)/,
    `$1${count}$2`
  );

  // <TitlesOfParts> 内を全置換
  appXml = appXml.replace(
    /<TitlesOfParts>[\s\S]*?<\/TitlesOfParts>/,
    `<TitlesOfParts><vt:vector size="${count}" baseType="lpstr">${names}</vt:vector></TitlesOfParts>`
  );

  return appXml;
}

// formatPeriodDisplay は utils.js で定義（"YYYY.M" 形式を返す）

// ============================================================
// プレビューデータ生成（画面表示用）
// ============================================================

function buildInvoicePreviewData(contractors, periodYm) {
  const rows = [];
  let total = 0;

  for (const c of contractors) {
    const basicYen = Math.round((c.basicPayMan ?? 0) * 10000);
    const rentYen  = Math.round(basicYen * 0.1);
    const dailyYen = Math.round(c.dailyPayYen ?? 0);
    const subTotal = basicYen - rentYen - dailyYen;

    rows.push({ name: c.name, desc: '業務報酬',           amount: basicYen  });
    rows.push({ name: '',     desc: '大入手当',            amount: 0         });
    rows.push({ name: '',     desc: '事務所レンタル料',    amount: -rentYen  });
    rows.push({ name: '',     desc: '仮払精算（日払い）',  amount: -dailyYen });
    rows.push({ name: c.name, desc: '【小計】',            amount: subTotal, isSubtotal: true });
    total += subTotal;
  }
  return { rows, total };
}

function buildDRInvoicePreviewData(drList, periodYm) {
  const rows = [];
  let total = 0;

  for (const dr of drList) {
    const driverReward = Math.round(dr.driverReward ?? 0);
    const karibaraiYen = Math.round(dr.karibaraiYen ?? 0);
    const totalYen     = Math.round(dr.totalAmount ?? 0);
    const feeYen       = totalYen - driverReward + karibaraiYen;

    rows.push({ name: dr.name, desc: 'ドライバー報酬',        amount: driverReward   });
    rows.push({ name: '',      desc: '仮払精算',               amount: -karibaraiYen  });
    rows.push({ name: '',      desc: '適格請求支払手数料',     amount: feeYen         });
    rows.push({ name: dr.name, desc: '【小計】',               amount: totalYen, isSubtotal: true });
    total += totalYen;
  }
  return { rows, total };
}
