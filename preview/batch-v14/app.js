(function () {
  'use strict';

  const PAGE_SIZE = 200; // Number of rows displayed per UI page.
  const READER_PAGE_SIZE = 1000; // Number of rows fetched from Tableau per Reader page.
  const UI_PAGES_PER_READER_PAGE = READER_PAGE_SIZE / PAGE_SIZE;
  const AUTO_REFRESH_DELAY_MS = 150;
  // Preserve rows ID for existing field assignments.
  const ENCODING_ORDER = ['rows'];
  const COLUMN_WIDTHS_KEY = 'columnWidthsV1';
  const FIXED_COLUMN_COUNT_KEY = 'fixedColumnCountV1';
  const COLUMN_DISPLAY_MODES_KEY = 'columnDisplayModesV1';
  const COLUMN_COLORS_KEY = 'columnColorsV1';
  const COLUMN_GRADIENTS_KEY = 'columnGradientsV1';
  const COLUMN_HEADER_LABELS_KEY = 'columnHeaderLabelsV1';
  const COLUMN_HEADER_GROUPS_KEY = 'columnHeaderGroupsV1';
  const HEADER_COLORS_KEY = 'headerColorsV1';
  const HEADER_CELL_COLORS_KEY = 'headerCellColorsV1';
  const DEFAULT_HEADER_COLORS = {
    upper: { background: '#f1f3f4', text: '#202124' },
    lower: { background: '#f1f3f4', text: '#202124' }
  };
  const DEFAULT_GRADIENT_COLORS = {
    low: '#e8f0fe',
    mid: '#90caf9',
    high: '#1a73e8'
  };
  const GRADIENT_STOPS = ['low', 'mid', 'high'];
  const DEFAULT_VISUAL_COLOR = '#1a73e8';
  const DEFAULT_COLUMN_WIDTH = 160;
  const MIN_COLUMN_WIDTH = 80;
  const MAX_COLUMN_WIDTH = 420;
  const COLUMN_HORIZONTAL_PADDING = 24;
  const CSV_PAGE_SIZE = 5000;
  const CSV_MAX_ROWS = 100000;
  const CSV_MAX_BYTES = 32 * 1024 * 1024;
  const CSV_PAGE_RETRIES = 3;

  let worksheet = null;
  let reader = null;
  let cachedReaderPage = null; // Keep only one 1,000-row Reader page in memory.
  let dataEventVersion = 0;
  let pageIndex = 0; // The 200-row UI page index, not Tableau Reader page index.
  let removeSummaryListener = null;
  let removeFilterListener = null;
  let refreshTimer = null;
  let pendingRefreshReason = 'initial';
  let generation = 0;
  let mappedFields = [];
  let manualColumnWidths = {};
  let autoColumnWidths = {};
  let fixedColumnCount = 0;
  let columnDisplayModes = {};
  let columnColors = {};
  let columnGradients = {};
  let columnHeaderLabels = {};
  let columnHeaderGroups = {};
  let headerColors = {
    upper: {...DEFAULT_HEADER_COLORS.upper},
    lower: {...DEFAULT_HEADER_COLORS.lower}
  };
  let headerCellColors = { upper: {}, lower: {} };
  let selectedCell = null;
  let selectionAnchor = null;
  let selectionFocus = null;
  let pointerSelecting = false;
  let pendingColumnSettings = null;
  let numericFieldNames = new Set();
  let textMeasureContext = null;
  let exportInProgress = false;
  let csvSession = null;

  const $ = (id) => document.getElementById(id);

  // V11-only instrumentation. Each report uses its own trace, not shared timers.
  const perfReports = [];
  const perfEvents = [];
  let perfId = 0;
  const perfNow = () => performance.now();
  const perfMs = (value) => Math.round(value * 100) / 100;

  function perfStart(reason, category) {
    const trace = {
      id: ++perfId, reason, category, wallTime: new Date().toISOString(),
      start: perfNow(), phases: [], info: { pageSize: PAGE_SIZE, readerPageSize: READER_PAGE_SIZE },
      status: '計測中'
    };
    perfReports.unshift(trace);
    if (perfReports.length > 40) perfReports.pop();
    perfRender();
    return trace;
  }

  function perfPhase(trace, label, started, info) {
    if (!trace) return;
    trace.phases.push({
      label, ms: perfMs(perfNow() - started),
      ...(info ? {info} : {})
    });
  }

  async function perfAsync(trace, label, callback) {
    const started = perfNow();
    try {
      return await callback();
    } catch (error) {
      if (trace) trace.status = 'エラー';
      throw error;
    } finally {
      perfPhase(trace, label, started);
    }
  }

  function perfSync(trace, label, callback) {
    const started = perfNow();
    try {
      return callback();
    } catch (error) {
      if (trace) trace.status = 'エラー';
      throw error;
    } finally {
      perfPhase(trace, label, started);
    }
  }

  function perfFinish(trace) {
    if (!trace || trace.ended) return;
    trace.ended = perfNow();
    trace.totalMs = perfMs(trace.ended - trace.start);
    if (trace.status === '計測中') trace.status = '完了';
    perfRender();
  }

  function perfEvent(reason) {
    perfEvents.unshift({ time: new Date().toISOString(), reason });
    if (perfEvents.length > 40) perfEvents.pop();
  }

  // Approximate frame scheduling, not browser paint completion. Ignore when the tab is hidden.
  function perfFrameProbe(trace) {
    if (typeof window.requestAnimationFrame !== 'function') return;
    const started = perfNow();
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        perfPhase(trace, '参考: 次々フレームまで（描画完了ではない）', started);
        if (trace.ended) perfRender();
      });
    });
  }

  function perfExportText() {
    const lines = [
      '種類\tID\t実行時刻\t操作\t状態\t区間\t所要時間ms\t行数\t表示列数\t表示セル数\t総行数\tReaderページ数\t表示ページ数\tReader取得行数\tReaderキャッシュ'
    ];
    for (const trace of [...perfReports].reverse()) {
      const inf = trace.info;
      const values = (phase, ms) => [
        '計測', trace.id, trace.wallTime, trace.reason, trace.status,
        phase, ms === undefined ? '' : ms,
        inf.displayRows ?? '', inf.displayColumns ?? '',
        inf.displayCells ?? '', inf.totalRows ?? '',
        inf.pageCount ?? '', inf.uiPageCount ?? '',
        inf.readerPageRows ?? '', inf.readerCache ?? ''
      ].map(x => String(x).replace(/[\t\r\n]/g, ' ')).join('\t');
      lines.push(values('処理全体（計測対象区間）', trace.totalMs));
      for (const phase of trace.phases) lines.push(values(phase.label, phase.ms));
    }
    for (const evt of [...perfEvents].reverse()) {
      lines.push(['イベント', '', evt.time, evt.reason, '', '', '', '', '', '', '', '', '', ''].join('\t'));
    }
    return lines.join('\r\n');
  }

  function perfRender() {
    const root = $('perfResults');
    if (!root || $('perfPanel').hidden) return;
    root.replaceChildren();
    if (!perfReports.length) {
      root.textContent = '計測記録はまだありません。初回表示・ページ移動・再読み込みを実行してください。';
      return;
    }
    for (const trace of perfReports) {
      const section = document.createElement('details');
      section.className = 'perf-run';
      section.open = trace === perfReports[0];
      const summary = document.createElement('summary');
      summary.textContent = '#' + trace.id + ' ' + trace.reason +
        ' / ' + trace.status + ' / ' +
        (trace.totalMs === undefined ? '計測中' : trace.totalMs + ' ms');
      section.appendChild(summary);
      const meta = document.createElement('div');
      meta.className = 'perf-meta';
      meta.textContent = '表示: ' + (trace.info.displayRows ?? '-') + ' 行 × ' +
        (trace.info.displayColumns ?? '-') + ' 列 / 総行数: ' +
        (trace.info.totalRows ?? '-') + ' / Readerページ数: ' +
        (trace.info.pageCount ?? '-') + ' / 表示ページ数: ' +
        (trace.info.uiPageCount ?? '-') + ' / 取得行数: ' +
        (trace.info.readerPageRows ?? '-') + ' / cache: ' +
        (trace.info.readerCache ?? '-') + ' / ' + trace.wallTime;
      section.appendChild(meta);
      const candidates = trace.phases.filter(phase =>
        phase.label.startsWith('API:') ||
        phase.label === '描画: renderTable合計' ||
        phase.label === '設定: ローカル設定の読み込み' ||
        phase.label === 'イベント: 登録'
      );
      if (candidates.length && trace.totalMs !== undefined) {
        const largest = candidates.reduce((a, b) => a.ms >= b.ms ? a : b);
        const summaryLine = document.createElement('div');
        summaryLine.className = 'perf-bottleneck';
        const share = trace.totalMs > 0
          ? Math.round(largest.ms / trace.totalMs * 100) : 0;
        summaryLine.textContent = '最長の単独区間: ' + largest.label +
          ' / ' + largest.ms.toFixed(2) + ' ms（全体の約' + share +
          '%）。実測区間の比較であり、原因の断定ではありません。';
        section.appendChild(summaryLine);
      }
      const table = document.createElement('table');
      table.className = 'perf-table';
      const head = document.createElement('tr');
      for (const h of ['計測区間', '所要時間(ms)']) {
        const th = document.createElement('th');
        th.textContent = h;
        head.appendChild(th);
      }
      table.appendChild(head);
      for (const phase of trace.phases) {
        const row = document.createElement('tr');
        const label = document.createElement('td');
        label.textContent = phase.label;
        const value = document.createElement('td');
        value.textContent = phase.ms.toFixed(2);
        row.append(label, value);
        table.appendChild(row);
      }
      section.appendChild(table);
      root.appendChild(section);
    }
    $('perfEvents').textContent = '自動更新イベント: ' + perfEvents.length +
      ' 件記録（直近40件まで）。' + (perfEvents.length ?
        ' 最新: ' + perfEvents[0].reason + ' ' + perfEvents[0].time : '');
  }


  function setMessage(text, type) {
    const el = $('message');
    el.textContent = text || '';
    el.className = 'message';
    if (type) el.classList.add('is-' + type);
    el.style.display = text ? '' : 'none';
  }

  function setBusy(busy) {
    $('refreshData').disabled = busy || exportInProgress;
    $('exportCsv').disabled = busy || exportInProgress || !reader;
    $('prev').disabled =
      busy || exportInProgress || !reader || pageIndex <= 0;
    $('next').disabled =
      busy ||
      exportInProgress ||
      !reader ||
      pageIndex >= Math.ceil(reader.totalRowCount / PAGE_SIZE) - 1;
  }

  function rawValue(cell) {
    if (!cell) return null;

    if (cell.nativeValue !== undefined) {
      return cell.nativeValue;
    }

    if (cell.value !== undefined) {
      return cell.value;
    }

    return null;
  }

  function displayValue(cell) {
    if (!cell) return '';

    const raw = rawValue(cell);

    if (raw === null || raw === undefined) {
      return '';
    }

    if (cell.formattedValue !== undefined && cell.formattedValue !== null) {
      return String(cell.formattedValue);
    }

    return String(raw);
  }

  function visualColor(fieldName) {
    const color = columnColors[fieldName];
    return /^#[0-9a-fA-F]{6}$/.test(color || '')
      ? color.toLowerCase() : DEFAULT_VISUAL_COLOR;
  }

  function visualRgba(fieldName, opacity) {
    const hex = visualColor(fieldName);
    return 'rgba(' +
      parseInt(hex.slice(1, 3), 16) + ',' +
      parseInt(hex.slice(3, 5), 16) + ',' +
      parseInt(hex.slice(5, 7), 16) + ',' + opacity + ')';
  }

  function normalizeDataType(column) {
    return String(column && column.dataType ? column.dataType : '')
      .trim()
      .toLowerCase();
  }

  function alignmentClass(column, dataTable, cellIndex) {
    const dataType = normalizeDataType(column);

    if (
      dataType.includes('int') ||
      dataType.includes('float') ||
      dataType.includes('double') ||
      dataType.includes('decimal') ||
      dataType.includes('number') ||
      dataType.includes('numeric')
    ) {
      return 'cell-number';
    }

    if (dataType.includes('date') || dataType.includes('time')) {
      return 'cell-date';
    }

    if (dataType.includes('bool')) {
      return 'cell-boolean';
    }

    for (const row of dataTable.data) {
      const value = rawValue(row[cellIndex]);

      if (value === null || value === undefined) continue;
      if (typeof value === 'number') return 'cell-number';
      if (typeof value === 'boolean') return 'cell-boolean';
      if (value instanceof Date) return 'cell-date';

      break;
    }

    return 'cell-text';
  }

  async function getMappedFields(trace) {
    const visualSpec = await perfAsync(trace, 'API: getVisualSpecificationAsync', () =>
      worksheet.getVisualSpecificationAsync()
    );

    if (
      !visualSpec ||
      visualSpec.activeMarksSpecificationIndex === undefined ||
      visualSpec.activeMarksSpecificationIndex < 0
    ) {
      return [];
    }

    const marksCard =
      visualSpec.marksSpecifications[
        visualSpec.activeMarksSpecificationIndex
      ];

    if (!marksCard || !Array.isArray(marksCard.encodings)) {
      return [];
    }

    const result = [];
    const seen = new Set();

    ENCODING_ORDER.forEach((encodingId) => {
      marksCard.encodings.forEach((encoding) => {
        if (!encoding || encoding.id !== encodingId || !encoding.field) {
          return;
        }

        const fieldName =
          encoding.field.name ||
          encoding.field.fieldName ||
          encoding.field.caption ||
          '';

        if (!fieldName || seen.has(fieldName)) {
          return;
        }

        seen.add(fieldName);
        result.push({
          encodingId,
          fieldName
        });
      });
    });

    return result;
  }

  function resolveDisplayColumns(dataTable) {
    const resolved = [];
    const usedIndexes = new Set();

    mappedFields.forEach((mappedField) => {
      const index = dataTable.columns.findIndex((column, columnIndex) => {
        if (usedIndexes.has(columnIndex)) return false;

        const names = [
          column.fieldName,
          column.caption,
          column.name
        ].filter(Boolean);

        return names.includes(mappedField.fieldName);
      });

      if (index < 0) {
        console.warn(
          'Mapped field was not found in summary data:',
          mappedField.fieldName
        );
        return;
      }

      usedIndexes.add(index);
      resolved.push({
        column: dataTable.columns[index],
        cellIndex:
          dataTable.columns[index].index !== undefined &&
          dataTable.columns[index].index !== null
            ? dataTable.columns[index].index
            : index,
        fieldName: mappedField.fieldName
      });
    });

    return resolved;
  }

  function clampColumnWidth(width) {
    return Math.max(
      MIN_COLUMN_WIDTH,
      Math.min(MAX_COLUMN_WIDTH, Math.round(width))
    );
  }

  function getTextMeasureContext() {
    if (textMeasureContext) return textMeasureContext;

    const canvas = document.createElement('canvas');
    textMeasureContext = canvas.getContext('2d');

    if (textMeasureContext) {
      const bodyStyle = window.getComputedStyle(document.body);
      textMeasureContext.font =
        bodyStyle.font || '13px Arial, "Noto Sans JP", sans-serif';
    }

    return textMeasureContext;
  }

  function measureTextWidth(text) {
    const value = text === null || text === undefined ? '' : String(text);
    const context = getTextMeasureContext();

    if (!context) {
      return value.length * 8;
    }

    return context.measureText(value).width;
  }

  function sourceHeaderLabel(info) {
    return (info.column && (info.column.fieldName ||
      info.column.caption || info.column.name)) || info.fieldName;
  }

  function displayHeaderLabel(info) {
    const alias = columnHeaderLabels[info.fieldName];
    return typeof alias === 'string' && alias.trim() ? alias : sourceHeaderLabel(info);
  }

  function upperHeaderLabel(fieldName) {
    const group = columnHeaderGroups[fieldName];
    return typeof group === 'string' ? group.trim() : '';
  }

  function sanitizeCellColors(value) {
    const result = { upper: {}, lower: {} };
    for (const level of ['upper', 'lower']) {
      const entries = value?.[level];
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
      for (const [fieldName, saved] of Object.entries(entries)) {
        if (!saved || typeof saved !== 'object') continue;
        result[level][fieldName] = {};
        for (const kind of ['background', 'text']) {
          if (validHex(saved[kind])) result[level][fieldName][kind] = saved[kind].toLowerCase();
        }
      }
    }
    return result;
  }

  function headerCellPalette(level, fieldName, overrides = headerCellColors) {
    const cell = overrides[level]?.[fieldName] || {};
    const base = headerColors[level] || DEFAULT_HEADER_COLORS[level];
    return {
      background: validHex(cell.background) ? cell.background : base.background,
      text: validHex(cell.text) ? cell.text : base.text
    };
  }

  function styleHeaderCell(th, level, fieldName) {
    const colors = headerCellPalette(level, fieldName);
    th.style.backgroundColor = colors.background;
    th.style.color = colors.text;
  }

  function upperHeaderRuns(fields, groupFor, fixedCount) {
    const runs = [];
    for (let start = 0; start < fields.length;) {
      const label = groupFor(fields[start].fieldName).trim();
      if (!label) {
        start++;
        continue;
      }
      let end = start + 1;
      while (end < fields.length && end !== fixedCount &&
             groupFor(fields[end].fieldName).trim() === label) end++;
      runs.push({
        fieldName: fields[start].fieldName,
        label,
        start,
        end
      });
      start = end;
    }
    return runs;
  }

  function getAutoColumnWidth(columnInfo, dataTable) {
    let required = measureTextWidth(displayHeaderLabel(columnInfo));

    for (const row of dataTable.data) {
      required = Math.max(
        required,
        measureTextWidth(displayValue(row[columnInfo.cellIndex]))
      );

      if (required + COLUMN_HORIZONTAL_PADDING >= MAX_COLUMN_WIDTH) {
        return MAX_COLUMN_WIDTH;
      }
    }

    return clampColumnWidth(
      Math.max(DEFAULT_COLUMN_WIDTH, required + COLUMN_HORIZONTAL_PADDING)
    );
  }

  function resolveColumnWidth(columnInfo, dataTable) {
    const fieldName = columnInfo.fieldName;
    const savedWidth = Number(manualColumnWidths[fieldName]);

    if (Number.isFinite(savedWidth)) {
      return clampColumnWidth(savedWidth);
    }

    const measuredWidth = getAutoColumnWidth(columnInfo, dataTable);
    const previousAutoWidth = Number(autoColumnWidths[fieldName]);
    const width = Number.isFinite(previousAutoWidth)
      ? Math.max(previousAutoWidth, measuredWidth)
      : measuredWidth;

    autoColumnWidths[fieldName] = clampColumnWidth(width);

    return autoColumnWidths[fieldName];
  }

  function loadColumnWidths() {
    const raw = tableau.extensions.settings.get(COLUMN_WIDTHS_KEY);

    if (!raw) {
      manualColumnWidths = {};
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      manualColumnWidths =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed
          : {};
    } catch (error) {
      console.warn('Column width settings could not be parsed.', error);
      manualColumnWidths = {};
    }
  }

  function loadFixedColumnCount() {
    const raw = tableau.extensions.settings.get(FIXED_COLUMN_COUNT_KEY);
    const parsed = Number(raw);

    fixedColumnCount =
      Number.isInteger(parsed) && parsed >= 0
        ? parsed
        : 0;
  }

  function loadColumnDisplayModes() {
    const raw = tableau.extensions.settings.get(COLUMN_DISPLAY_MODES_KEY);

    if (!raw) {
      columnDisplayModes = {};
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      columnDisplayModes =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed
          : {};
    } catch (error) {
      console.warn('Column display settings could not be parsed.', error);
      columnDisplayModes = {};
    }
  }

  function loadColumnPresentation() {
    const read = (key) => {
      try {
        const parsed = JSON.parse(tableau.extensions.settings.get(key) || '{}');
        return parsed && typeof parsed === 'object' &&
          !Array.isArray(parsed) ? parsed : {};
      } catch (error) {
        console.warn('列の表示設定を復元できません。', key, error);
        return {};
      }
    };
    columnColors = Object.fromEntries(
      Object.entries(read(COLUMN_COLORS_KEY))
        .filter(([, value]) => validHex(value))
    );
    columnGradients = read(COLUMN_GRADIENTS_KEY);
    columnHeaderLabels = Object.fromEntries(
      Object.entries(read(COLUMN_HEADER_LABELS_KEY))
        .filter(([, value]) => typeof value === 'string')
    );
    columnHeaderGroups = Object.fromEntries(
      Object.entries(read(COLUMN_HEADER_GROUPS_KEY))
        .filter(([, value]) => typeof value === 'string')
    );
    const savedColors = read(HEADER_COLORS_KEY);
    headerColors = Object.fromEntries(['upper', 'lower'].map(level => [
      level,
      Object.fromEntries(['background', 'text'].map(key => {
        const value = savedColors[level]?.[key];
        return [key, validHex(value) ? value.toLowerCase() :
          DEFAULT_HEADER_COLORS[level][key]];
      }))
    ]));
    headerCellColors = sanitizeCellColors(read(HEADER_CELL_COLORS_KEY));
  }

  async function saveColumnPresentation() {
    tableau.extensions.settings.set(
      COLUMN_COLORS_KEY, JSON.stringify(columnColors)
    );
    tableau.extensions.settings.set(
      COLUMN_GRADIENTS_KEY, JSON.stringify(columnGradients)
    );
    tableau.extensions.settings.set(
      COLUMN_HEADER_LABELS_KEY, JSON.stringify(columnHeaderLabels)
    );
    tableau.extensions.settings.set(
      COLUMN_HEADER_GROUPS_KEY, JSON.stringify(columnHeaderGroups)
    );
    tableau.extensions.settings.set(
      HEADER_COLORS_KEY, JSON.stringify(headerColors)
    );
    tableau.extensions.settings.set(
      HEADER_CELL_COLORS_KEY, JSON.stringify(headerCellColors)
    );
    await tableau.extensions.settings.saveAsync();
  }

  async function saveColumnDisplayModes() {
    tableau.extensions.settings.set(
      COLUMN_DISPLAY_MODES_KEY,
      JSON.stringify(columnDisplayModes)
    );

    try {
      await tableau.extensions.settings.saveAsync();
    } catch (error) {
      console.warn('Column display settings could not be saved.', error);
    }
  }

  async function saveFixedColumnCount() {
    tableau.extensions.settings.set(
      FIXED_COLUMN_COUNT_KEY,
      String(fixedColumnCount)
    );

    try {
      await tableau.extensions.settings.saveAsync();
    } catch (error) {
      console.warn('Fixed column settings could not be saved.', error);
    }
  }

  async function saveColumnWidths() {
    tableau.extensions.settings.set(
      COLUMN_WIDTHS_KEY,
      JSON.stringify(manualColumnWidths)
    );

    await tableau.extensions.settings.saveAsync();
  }

  function updateStickyOffsets(table) {
    const cols = Array.from(table.querySelectorAll('colgroup col'));
    const fixedCount = Math.min(fixedColumnCount, cols.length);
    const leftOffsets = [0];
    cols.forEach(col => {
      const width = parseFloat(col.style.width);
      leftOffsets.push(leftOffsets[leftOffsets.length - 1] +
        (Number.isFinite(width) ? width : DEFAULT_COLUMN_WIDTH));
    });

    // With colSpan and rowSpan, nth-child no longer means the data-column index.
    // Every header cell carries its actual underlying column range.
    table.querySelectorAll('thead th').forEach(th => {
      const start = Number(th.dataset.startCol);
      const end = Number(th.dataset.endCol);
      th.classList.remove('fixed-column', 'fixed-column-boundary');
      th.style.left = '';
      if (Number.isInteger(start) && Number.isInteger(end) &&
          end < fixedCount) {
        th.classList.add('fixed-column');
        th.style.left = leftOffsets[start] + 'px';
        if (end === fixedCount - 1) th.classList.add('fixed-column-boundary');
      }
    });

    for (const row of table.tBodies[0].rows) {
      for (let index = 0; index < row.cells.length; index++) {
        const cell = row.cells[index];
        cell.classList.remove('fixed-column', 'fixed-column-boundary');
        cell.style.left = '';
        if (index < fixedCount) {
          cell.classList.add('fixed-column');
          cell.style.left = leftOffsets[index] + 'px';
          if (index === fixedCount - 1) cell.classList.add('fixed-column-boundary');
        }
      }
    }
  }

  function applyColumnWidth(table, colElement, width) {
    const nextWidth = clampColumnWidth(width);
    colElement.style.width = nextWidth + 'px';

    const cols = Array.from(table.querySelectorAll('colgroup col'));
    const totalWidth = cols.reduce((sum, col) => {
      const current = parseFloat(col.style.width);
      return sum + (Number.isFinite(current) ? current : DEFAULT_COLUMN_WIDTH);
    }, 0);

    table.style.width = totalWidth + 'px';
    table.style.minWidth = totalWidth + 'px';
    updateStickyOffsets(table);

    return nextWidth;
  }

  function attachColumnResizer(handle, table, colElement, fieldName) {
    handle.addEventListener('pointerdown', function (event) {
      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      const startWidth =
        parseFloat(colElement.style.width) || DEFAULT_COLUMN_WIDTH;

      try {
        handle.setPointerCapture(event.pointerId);
      } catch (_) {}

      document.body.classList.add('is-column-resizing');

      const onMove = function (moveEvent) {
        const width = startWidth + (moveEvent.clientX - startX);
        applyColumnWidth(table, colElement, width);
      };

      const onEnd = function (endEvent) {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
        document.body.classList.remove('is-column-resizing');

        try {
          handle.releasePointerCapture(endEvent.pointerId);
        } catch (_) {}

        const finalWidth = clampColumnWidth(
          parseFloat(colElement.style.width) || startWidth
        );

        manualColumnWidths[fieldName] = finalWidth;
        saveColumnWidths().catch(showError);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onEnd);
      handle.addEventListener('pointercancel', onEnd);
    });
  }

  function numericValue(cell) {
    const value = rawValue(cell);

    if (value === null || value === undefined || value === '') {
      return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function getNumericScale(columnInfo, dataTable) {
    let min = Infinity;
    let max = -Infinity;

    for (const row of dataTable.data) {
      const value = numericValue(row[columnInfo.cellIndex]);

      if (value === null) continue;

      min = Math.min(min, value);
      max = Math.max(max, value);
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return null;
    }

    return { min, max };
  }

  function normalizedRatio(value, scale) {
    if (value === null || !scale) return 0;

    if (scale.max === scale.min) {
      return 1;
    }

    return Math.max(
      0,
      Math.min(1, (value - scale.min) / (scale.max - scale.min))
    );
  }

  function validHex(hex) {
    return typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex);
  }

  function gradientConfig(fieldName) {
    const saved = columnGradients[fieldName] || {};
    const savedColors = saved.colors || {};
    const legacyHigh = columnColors[fieldName];
    const colors = {};
    GRADIENT_STOPS.forEach(stop => {
      const value = savedColors[stop] ||
        (stop === 'high' ? legacyHigh : null) ||
        DEFAULT_GRADIENT_COLORS[stop];
      colors[stop] = validHex(value) ?
        value.toLowerCase() : DEFAULT_GRADIENT_COLORS[stop];
    });
    const savedBounds = saved.bounds || {};
    const bounds = {};
    GRADIENT_STOPS.forEach(stop => {
      const value = savedBounds[stop];
      bounds[stop] = Number.isFinite(value) ? value : null;
    });
    return { colors, bounds };
  }

  function hexTriplet(hex) {
    return [1,3,5].map(index => parseInt(hex.slice(index,index+2),16));
  }

  function interpolateRgb(a,b,ratio) {
    const t = Math.max(0,Math.min(1,ratio));
    const left = hexTriplet(a);
    const right = hexTriplet(b);
    return left.map((x,i) => Math.round(x + (right[i] - x) * t));
  }

  function valueColor(fieldName, value, scale) {
    const config = gradientConfig(fieldName);
    const bounds = config.bounds;
    const manual = GRADIENT_STOPS.every(stop => bounds[stop] !== null);
    const low = manual ? bounds.low : scale.min;
    const mid = manual ? bounds.mid : (scale.min + scale.max) / 2;
    const high = manual ? bounds.high : scale.max;
    if (high <= low) return hexTriplet(config.colors.high);
    if (value <= low) return hexTriplet(config.colors.low);
    if (value >= high) return hexTriplet(config.colors.high);
    if (value <= mid) {
      const t = mid === low ? 1 : (value - low) / (mid - low);
      return interpolateRgb(config.colors.low,config.colors.mid,t);
    }
    const t = high === mid ? 1 : (value - mid) / (high - mid);
    return interpolateRgb(config.colors.mid,config.colors.high,t);
  }

  function heatColor(fieldName, value, scale) {
    if (value === null) return '';
    const rgb = valueColor(fieldName,value,scale);
    return 'rgba(' + rgb.join(',') + ',0.48)';
  }

  function displayScale(fieldName, scale) {
    const bounds = gradientConfig(fieldName).bounds;
    return GRADIENT_STOPS.every(stop => bounds[stop] !== null) ?
      {min:bounds.low,max:bounds.high} : scale;
  }

  function renderValueCell(td, cell, mode, scale, fieldName) {
    const text = displayValue(cell);

    if (mode === 'bar' && scale) {
      const value = numericValue(cell);
      const ratio = normalizedRatio(value, displayScale(fieldName,scale));

      td.classList.add('cell-visual', 'cell-bar');

      const bar = document.createElement('span');
      bar.className = 'cell-bar-fill';
      bar.style.width = Math.round(ratio * 10000) / 100 + '%';
      bar.style.backgroundColor = heatColor(fieldName,value,scale);

      const label = document.createElement('span');
      label.className = 'cell-visual-label';
      label.textContent = text;

      td.appendChild(bar);
      td.appendChild(label);
      return;
    }

    if (mode === 'heatmap' && scale) {
      const value = numericValue(cell);
      td.classList.add('cell-visual', 'cell-heatmap');
      td.style.backgroundColor = heatColor(fieldName,value,scale);

      const label = document.createElement('span');
      label.className = 'cell-visual-label';
      label.textContent = text;
      td.appendChild(label);
      return;
    }

    td.textContent = text;
  }

  function hideCellMenu() {
    $('cellMenu').hidden = true;
  }

  function cellPosition(td) {
    const row = td && td.parentElement;
    const body = row && row.parentElement;
    if (!body || body.tagName !== 'TBODY') return null;
    return { row: row.sectionRowIndex, col: td.cellIndex };
  }

  function selectionBounds() {
    if (!selectionAnchor || !selectionFocus) return null;
    return {
      top: Math.min(selectionAnchor.row, selectionFocus.row),
      bottom: Math.max(selectionAnchor.row, selectionFocus.row),
      left: Math.min(selectionAnchor.col, selectionFocus.col),
      right: Math.max(selectionAnchor.col, selectionFocus.col)
    };
  }

  function isInSelection(td) {
    const pos = cellPosition(td);
    const b = selectionBounds();
    return !!(pos && b && pos.row >= b.top && pos.row <= b.bottom &&
      pos.col >= b.left && pos.col <= b.right);
  }

  function paintSelection() {
    const body = $('dataTable').tBodies[0];
    const b = selectionBounds();
    for (const tr of body.rows) {
      for (const td of tr.cells) {
        const on = !!(b && tr.sectionRowIndex >= b.top &&
          tr.sectionRowIndex <= b.bottom && td.cellIndex >= b.left &&
          td.cellIndex <= b.right);
        td.classList.toggle('is-selected-cell', on);
        td.setAttribute('aria-selected', String(on));
      }
    }
    let indicator = $('selectionIndicator');
    if (!indicator) {
      indicator = document.createElement('span');
      indicator.id = 'selectionIndicator';
      indicator.style.cssText = 'font-size:12px;font-weight:600;color:#174ea6;white-space:nowrap';
      $('page').parentElement.appendChild(indicator);
    }
    indicator.textContent = b ? ((b.bottom-b.top+1) + '行 × ' + (b.right-b.left+1) + '列 選択中') : '';
  }

  function clearCellSelection() {
    selectionAnchor = null;
    selectionFocus = null;
    selectedCell = null;
    pointerSelecting = false;
    hideCellMenu();
    paintSelection();
  }

  function selectCell(td, extend) {
    const pos = cellPosition(td);
    if (!pos) return;
    if (!extend || !selectionAnchor) selectionAnchor = pos;
    selectionFocus = pos;
    selectedCell = td;
    paintSelection();
    if (typeof td.focus === 'function') td.focus({ preventScroll: true });
  }

  function selectedText() {
    const b = selectionBounds();
    if (!b) return '';
    const rows = $('dataTable').tBodies[0].rows;
    const output = [];
    for (let r = b.top; r <= b.bottom; r++) {
      const cells = [];
      for (let c = b.left; c <= b.right; c++) {
        cells.push((rows[r].cells[c]?.textContent || '').replace(/\r?\n/g, ' '));
      }
      output.push(cells.join('\t'));
    }
    return output.join('\r\n');
  }

  function copySelectedCell() {
    if (!selectionBounds()) {
      hideCellMenu();
      return;
    }
    const text = selectedText();
    hideCellMenu();
    writeClipboardText(text);
    setMessage('選択範囲をコピーしました。');
  }

  function renderTable(dataTable, trace) {
    const resetStarted = perfNow();
    clearCellSelection();
    const table = $('dataTable');
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    let colgroup = table.querySelector('colgroup');

    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      table.insertBefore(colgroup, thead);
    }

    colgroup.innerHTML = '';
    thead.innerHTML = '';
    tbody.innerHTML = '';

    const displayColumns = resolveDisplayColumns(dataTable);
    perfPhase(trace, '描画: 表の初期化・列対応', resetStarted);

    if (!displayColumns.length) {
      return 0;
    }

    const headerStarted = perfNow();
    let columnWidthMs = 0;
    const hasUpperHeaders = displayColumns.some(
      info => upperHeaderLabel(info.fieldName) !== ''
    );
    const upperRow = document.createElement('tr');
    upperRow.className = 'header-group-row';
    const detailRow = document.createElement('tr');
    detailRow.className = hasUpperHeaders ? 'header-detail-row' : 'header-single-row';
    const leafHeaders = [];
    let totalWidth = 0;

    displayColumns.forEach((columnInfo, index) => {
      const widthStart = perfNow();
      const width = resolveColumnWidth(columnInfo, dataTable);
      columnWidthMs += perfNow() - widthStart;
      const col = document.createElement('col');
      col.dataset.fieldName = columnInfo.fieldName;
      col.style.width = width + 'px';
      colgroup.appendChild(col);
      totalWidth += width;

      const th = document.createElement('th');
      th.dataset.startCol = String(index);
      th.dataset.endCol = String(index);
      styleHeaderCell(th, 'lower', columnInfo.fieldName);
      const label = document.createElement('span');
      label.className = 'column-header-label';
      label.textContent = displayHeaderLabel(columnInfo);

      const resizer = document.createElement('span');
      resizer.className = 'column-resizer';
      resizer.setAttribute('role', 'separator');
      resizer.setAttribute('aria-orientation', 'vertical');
      resizer.title = 'ドラッグして列幅を変更';
      attachColumnResizer(resizer, table, col, columnInfo.fieldName);

      th.appendChild(label);
      th.appendChild(resizer);
      leafHeaders.push(th);
    });

    table.style.width = totalWidth + 'px';
    table.style.minWidth = totalWidth + 'px';

    if (!hasUpperHeaders) {
      leafHeaders.forEach(th => detailRow.appendChild(th));
      thead.appendChild(detailRow);
    } else {
      const runs = upperHeaderRuns(
        displayColumns, upperHeaderLabel, fixedColumnCount
      );
      const runByStart = new Map(runs.map(run => [run.start, run]));
      for (let index = 0; index < displayColumns.length;) {
        const run = runByStart.get(index);
        if (!run) {
          const th = leafHeaders[index];
          th.rowSpan = 2;
          upperRow.appendChild(th);
          index++;
          continue;
        }
        const parent = document.createElement('th');
        parent.className = 'header-group-cell';
        styleHeaderCell(parent, 'upper', run.fieldName);
        parent.colSpan = run.end - run.start;
        parent.dataset.startCol = String(run.start);
        parent.dataset.endCol = String(run.end - 1);
        parent.textContent = run.label;
        upperRow.appendChild(parent);
        for (let c = run.start; c < run.end; c++) {
          detailRow.appendChild(leafHeaders[c]);
        }
        index = run.end;
      }
      thead.appendChild(upperRow);
      thead.appendChild(detailRow);
    }
    perfPhase(trace, '描画: ヘッダー生成（列幅算出を含む）', headerStarted);
    if (trace) trace.phases.push({
      label: '描画: 列幅算出（ヘッダー生成の内数）',
      ms: perfMs(columnWidthMs)
    });

    const prepareStarted = perfNow();
    const alignmentClasses = displayColumns.map(
      ({ column, cellIndex }) =>
        alignmentClass(column, dataTable, cellIndex)
    );

    numericFieldNames = new Set(
      displayColumns
        .filter((_, index) => alignmentClasses[index] === 'cell-number')
        .map((columnInfo) => columnInfo.fieldName)
    );

    const scales = new Map();

    displayColumns.forEach((columnInfo, index) => {
      const mode = columnDisplayModes[columnInfo.fieldName] || 'normal';

      if (
        alignmentClasses[index] === 'cell-number' &&
        (mode === 'bar' || mode === 'heatmap')
      ) {
        scales.set(
          columnInfo.fieldName,
          getNumericScale(columnInfo, dataTable)
        );
      }
    });

    perfPhase(trace, '描画: データ型判定・スケール計算', prepareStarted);
    const cellsStarted = perfNow();
    const fragment = document.createDocumentFragment();

    dataTable.data.forEach((row) => {
      const tr = document.createElement('tr');

      displayColumns.forEach((columnInfo, displayIndex) => {
        const td = document.createElement('td');
        td.tabIndex = -1;
        td.classList.add(alignmentClasses[displayIndex]);

        const requestedMode =
          columnDisplayModes[columnInfo.fieldName] || 'normal';
        const mode =
          alignmentClasses[displayIndex] === 'cell-number'
            ? requestedMode
            : 'normal';

        renderValueCell(
          td,
          row[columnInfo.cellIndex],
          mode,
          scales.get(columnInfo.fieldName),
          columnInfo.fieldName
        );

        tr.appendChild(td);
      });

      fragment.appendChild(tr);
    });

    perfPhase(trace, '描画: セルDOM生成', cellsStarted);
    const appendStarted = perfNow();
    tbody.appendChild(fragment);
    perfPhase(trace, '描画: DOMへの追加', appendStarted);
    const fixedStarted = perfNow();
    updateStickyOffsets(table);
    perfPhase(trace, '描画: 固定列位置計算', fixedStarted);

    return displayColumns.length;
  }


  function escapeDelimitedValue(value, delimiter) {
    const text =
      value === null || value === undefined
        ? ''
        : String(value);

    if (
      text.includes('"') ||
      text.includes('\n') ||
      text.includes('\r') ||
      text.includes(delimiter)
    ) {
      return '"' + text.replace(/"/g, '""') + '"';
    }

    return text;
  }

  function createExportFileName(extension) {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');

    return (
      'tabsdk-data-viewer-' +
      now.getFullYear() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      '-' +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds()) +
      '.' +
      extension
    );
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    // Avoid revoking the URL before the browser starts the download.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function csvStatus(message) {
    $('csvStatus').textContent = message;
  }

  function checkCsvSession(s) {
    if (s !== csvSession || s.cancelled || s.invalidated ||
        s.generation !== generation) {
      throw new Error('データ変更または中止によりCSV出力を中断しました。最初から再実行してください。');
    }
  }

  async function getCsvPage(s, index) {
    let lastError;
    for (let attempt = 1; attempt <= CSV_PAGE_RETRIES; attempt++) {
      checkCsvSession(s);
      try {
        const page = await s.reader.getPageAsync(index);
        checkCsvSession(s);
        return page;
      } catch (error) {
        checkCsvSession(s);
        lastError = error;
        if (attempt === CSV_PAGE_RETRIES) break;
        csvStatus('ページ ' + (index + 1) + ' の取得を再試行しています（' + attempt + '回目）');
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
      }
    }
    throw new Error('ページ ' + (index + 1) + ' の取得に失敗しました（' +
      CSV_PAGE_RETRIES + '回）。' +
      (lastError && lastError.message ? lastError.message : ''));
  }

  function csvColumnHeader(columns) {
    // CSV stays one header row. Use the edited leaf labels only.
    return columns.map(info =>
      escapeDelimitedValue(displayHeaderLabel(info), ',')
    ).join(',') + '\r\n';
  }

  async function buildNextCsvPart(s) {
    checkCsvSession(s);
    s.creating = true;
    s.ready = null;
    $('csvSavePart').disabled = true;
    $('csvNextPart').disabled = true;
    $('csvFinish').textContent = '中止';

    const chunks = ['\uFEFF'];
    let bytes = 3;
    let count = 0;
    const fromRow = s.processed + 1;
    try {
      while (s.nextPage < s.reader.pageCount || s.pendingPage) {
        checkCsvSession(s);
        const page = s.pendingPage || await getCsvPage(s, s.nextPage);
        checkCsvSession(s);
        const columns = resolveDisplayColumns(page);
        if (!columns.length) throw new Error('CSV列を取得できません。');
        const signature = columns.map(info =>
          info.fieldName + ':' + info.cellIndex).join('\u001f');
        if (s.signature && signature !== s.signature) {
          throw new Error('出力中にCSVの列構成が変わりました。');
        }
        if (!s.signature) {
          s.signature = signature;
          s.header = csvColumnHeader(columns);
        }
        if (chunks.length === 1) {
          chunks.push(s.header);
          bytes += new Blob([s.header]).size;
        }
        // A Reader page can be larger than the CSV file-size budget.
        // Retain the unconsumed rows to start the next CSV part.
        const offset = s.pendingOffset || 0;
        const lines = page.data.slice(offset).map(row =>
          columns.map(info =>
            escapeDelimitedValue(displayValue(row[info.cellIndex]), ',')
          ).join(',') + '\r\n'
        );
        if (!lines.length) {
          s.pendingPage = null;
          s.pendingOffset = 0;
          s.nextPage++;
          continue;
        }

        const spaceBytes = CSV_MAX_BYTES - bytes;
        const rowLimit = CSV_MAX_ROWS - count;
        let acceptedRows = Math.min(lines.length, rowLimit);
        let text = lines.slice(0, acceptedRows).join('');
        let acceptedBytes = new Blob([text]).size;

        if (acceptedBytes > spaceBytes) {
          // Binary search is only needed when the file-size budget is hit.
          let low = 0;
          let high = acceptedRows;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            const sample = lines.slice(0, middle).join('');
            if (new Blob([sample]).size <= spaceBytes) {
              low = middle;
            } else {
              high = middle - 1;
            }
          }
          acceptedRows = low;
          text = lines.slice(0, acceptedRows).join('');
          acceptedBytes = new Blob([text]).size;
        }

        if (acceptedRows === 0) {
          if (count === 0) {
            throw new Error('CSVの単一行が32MiBを超えるため分割できません。');
          }
          s.pendingPage = page;
          s.pendingOffset = offset;
          break;
        }

        chunks.push(text);
        bytes += acceptedBytes;
        count += acceptedRows;
        s.processed += acceptedRows;
        const nextOffset = offset + acceptedRows;
        if (nextOffset < page.data.length) {
          s.pendingPage = page;
          s.pendingOffset = nextOffset;
        } else {
          s.pendingPage = null;
          s.pendingOffset = 0;
          s.nextPage++;
        }

        csvStatus(s.processed.toLocaleString() + ' / ' +
          s.totalRows.toLocaleString() + ' 行を取得中');
        if (s.pendingPage || count >= CSV_MAX_ROWS) break;
      }
      checkCsvSession(s);
      if (!count) throw new Error('出力可能な行がありません。');
      const finished = s.nextPage === s.reader.pageCount && !s.pendingPage;
      if (s.processed > s.totalRows || (finished && s.processed !== s.totalRows)) {
        throw new Error('取得したCSVの行数がTableauの総件数と一致しません。');
      }
      const blob = new Blob(chunks, { type: 'text/csv;charset=utf-8' });
      s.part++;
      const fileName = s.baseName + '-part-' +
        String(s.part).padStart(3, '0') + '.csv';
      s.ready = {
        blob, fileName, fromRow, toRow: s.processed, saved: false
      };
      $('csvDetails').textContent = fileName + '（' +
        fromRow.toLocaleString() + '～' + s.processed.toLocaleString() +
        ' 行、' + (blob.size / 1024 / 1024).toFixed(1) + ' MiB）';
      csvStatus('CSVを生成しました。保存ボタンを押してください。');
      $('csvSavePart').disabled = false;
    } finally {
      s.creating = false;
    }
  }

  function saveCsvPart() {
    const s = csvSession;
    if (!s || s.creating || s.cancelled || s.invalidated || !s.ready) return;
    // Invoke directly within the user's click to retain user activation.
    downloadBlob(s.ready.blob, s.ready.fileName);
    s.ready.saved = true;
    const last = s.nextPage === s.reader.pageCount && !s.pendingPage;
    $('csvNextPart').disabled = last;
    $('csvFinish').textContent = last ? '完了して閉じる' : '中止';
    csvStatus('保存を開始しました。ブラウザで確認後、' +
      (last ? '「完了して閉じる」' : '「次のファイルを作成」') +
      'を押してください。同じファイルを再保存することもできます。');
  }

  async function closeCsvExport(message) {
    const s = csvSession;
    if (!s) return;
    csvSession = null;
    if (s.ready) {
      s.ready.blob = null;
      s.ready = null;
    }
    s.pendingPage = null;
    s.pendingOffset = 0;
    if (s.reader) {
      try { await s.reader.releaseAsync(); }
      catch (error) { console.warn('CSV reader release failed', error); }
    }
    exportInProgress = false;
    $('csvPanel').hidden = true;
    $('tableWrap').hidden = false;
    await refreshData('manual');
    if (message) setMessage(message);
  }

  async function onCsvFailure(error) {
    const cancelled = !!(csvSession && csvSession.cancelled);
    try { await closeCsvExport(); }
    catch (restoreError) { console.error('Restore failed', restoreError); }
    if (cancelled) setMessage('CSV出力を中止しました。');
    else showError(error);
  }

  async function startCsvExport() {
    if (exportInProgress || !reader) return;
    exportInProgress = true;
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    const s = {
      reader: null, creating: true, cancelled: false, invalidated: false,
      generation, nextPage: 0, pendingPage: null, pendingOffset: 0, processed: 0,
      totalRows: 0, part: 0, signature: null, header: null, ready: null,
      baseName: createExportFileName('csv').replace(/\.csv$/, '')
    };
    csvSession = s;
    setBusy(true);
    $('csvPanel').hidden = false;
    $('tableWrap').hidden = true;
    $('csvSavePart').disabled = true;
    $('csvNextPart').disabled = true;
    $('csvFinish').disabled = false;
    $('csvFinish').textContent = '中止';
    $('csvDetails').textContent = '';
    csvStatus('CSV出力用Readerを準備中...');
    try {
      await releaseReader();
      checkCsvSession(s);
      renderEmptyTable();
      s.reader = await worksheet.getSummaryDataReaderAsync(
        CSV_PAGE_SIZE, {
          ignoreSelection: true,
          applyWorksheetFormatting: true
        });
      checkCsvSession(s);
      s.totalRows = s.reader.totalRowCount;
      if (!s.totalRows) throw new Error('出力対象の行がありません。');
      await buildNextCsvPart(s);
    } catch (error) {
      await onCsvFailure(error);
    }
  }

  async function nextCsvPart() {
    const s = csvSession;
    if (!s || s.creating || !s.ready || !s.ready.saved) return;
    s.ready.blob = null;
    s.ready = null;
    $('csvDetails').textContent = '';
    csvStatus('次のCSVを生成しています...');
    try { await buildNextCsvPart(s); }
    catch (error) { await onCsvFailure(error); }
  }

  async function cancelCsvExport() {
    const s = csvSession;
    if (!s) return;
    const last = !!(s.ready && s.ready.saved &&
      s.nextPage === s.reader.pageCount && !s.pendingPage);
    if (last) {
      await closeCsvExport('CSV出力を終了しました。');
      return;
    }
    s.cancelled = true;
    $('csvSavePart').disabled = true;
    $('csvNextPart').disabled = true;
    $('csvFinish').disabled = true;
    if (s.creating) {
      csvStatus('中止処理中...');
      return;
    }
    await closeCsvExport('CSV出力を中止しました。');
  }

  function writeClipboardText(text) {
    // Tableau Public Desktop: synchronous copy was verified on user interaction.
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText =
      'position:fixed;left:8px;top:8px;width:1px;height:1px;opacity:.01';
    document.body.appendChild(textarea);
    try {
      textarea.focus();
      textarea.select();
      if (!document.execCommand('copy')) {
        throw new Error('クリップボードへのコピーに失敗しました。');
      }
    } finally {
      textarea.remove();
    }
  }

  function renderEmptyTable() {
    clearCellSelection();
    const table = $('dataTable');
    const colgroup = table.querySelector('colgroup');

    if (colgroup) {
      colgroup.innerHTML = '';
    }

    table.querySelector('thead').innerHTML = '';
    table.querySelector('tbody').innerHTML = '';
    table.style.width = '';
    table.style.minWidth = '';
  }

  function updatePager() {
    if (!reader) {
      $('status').textContent =
        mappedFields.length > 0 ? mappedFields.length + ' 列' : '-';
      $('page').textContent = '-';
      $('prev').disabled = true;
      $('next').disabled = true;
      return;
    }

    const uiPageCount = Math.ceil(reader.totalRowCount / PAGE_SIZE);
    $('status').textContent =
      reader.totalRowCount.toLocaleString() + ' 行 / ' +
      mappedFields.length + ' 列 / ' +
      PAGE_SIZE + ' 行/画面 / ' +
      READER_PAGE_SIZE + ' 行/取得';

    $('page').textContent =
      uiPageCount === 0 ? '0 / 0' : (pageIndex + 1) + ' / ' + uiPageCount;

    $('prev').disabled = pageIndex <= 0;
    $('next').disabled = pageIndex >= uiPageCount - 1;
  }

  async function releaseReader(trace) {
    cachedReaderPage = null;
    if (!reader) return;

    const oldReader = reader;
    reader = null;
    try {
      await perfAsync(trace, 'API: reader.releaseAsync', () => oldReader.releaseAsync());
    } catch (error) {
      console.warn('DataTableReader.releaseAsync failed', error);
    }
  }

  async function createReader(trace) {
    cachedReaderPage = null;
    reader = await perfAsync(trace, 'API: getSummaryDataReaderAsync(1000)', () =>
      worksheet.getSummaryDataReaderAsync(
        READER_PAGE_SIZE, { ignoreSelection: true, applyWorksheetFormatting: true }
      )
    );
    if (trace) {
      trace.info.totalRows = reader.totalRowCount;
      trace.info.pageCount = reader.pageCount;
      trace.info.uiPageCount = Math.ceil(reader.totalRowCount / PAGE_SIZE);
    }
    pageIndex = 0;
    updatePager();
  }

  // One Reader page (1,000 rows) backs up to five UI pages (200 rows each).
  async function loadPage(nextPage, expectedGeneration, parentTrace) {
    const activeReader = reader;
    if (!activeReader) return;
    const uiPageCount = Math.ceil(activeReader.totalRowCount / PAGE_SIZE);
    if (nextPage < 0 || nextPage >= uiPageCount) return;

    const trace = parentTrace || perfStart('ページ移動: ' + (nextPage + 1), 'page');
    const eventAtStart = dataEventVersion;
    const readerPageIndex = Math.floor(nextPage / UI_PAGES_PER_READER_PAGE);
    const localStart = (nextPage % UI_PAGES_PER_READER_PAGE) * PAGE_SIZE;
    try {
      setBusy(true);
      setMessage('読み込み中...', 'loading');

      const cached = cachedReaderPage &&
        cachedReaderPage.reader === activeReader &&
        cachedReaderPage.generation === expectedGeneration &&
        cachedReaderPage.eventVersion === eventAtStart &&
        cachedReaderPage.readerPageIndex === readerPageIndex;

      let readerTable;
      if (cached) {
        readerTable = cachedReaderPage.dataTable;
        trace.phases.push({label: 'キャッシュ: 取得済み1,000行を再利用', ms: 0});
      } else {
        readerTable = await perfAsync(
          trace, 'API: getPageAsync(' + readerPageIndex + ') [1,000行]',
          () => activeReader.getPageAsync(readerPageIndex)
        );
      }

      // A Tableau change event invalidates the data immediately, even before
      // its debounced refresh begins. Never display or cache an older page.
      if (activeReader !== reader || expectedGeneration !== generation ||
          eventAtStart !== dataEventVersion) {
        trace.status = '更新により破棄';
        return;
      }

      if (!readerTable || !Array.isArray(readerTable.data) ||
          !Array.isArray(readerTable.columns)) {
        throw new Error('Readerの戻り値に表示用のデータ配列または列情報がありません。');
      }

      if (!cached) {
        cachedReaderPage = {
          reader: activeReader,
          readerPageIndex,
          generation: expectedGeneration,
          eventVersion: eventAtStart,
          dataTable: readerTable
        };
      }

      // Preserve Tableau column metadata and row ordering while slicing only
      // the UI-visible rows. Do not create another Reader for subpages.
      const visibleTable = {
        columns: readerTable.columns,
        data: readerTable.data.slice(localStart, localStart + PAGE_SIZE)
      };

      trace.info.readerCache = cached ? 'HIT' : 'MISS';
      trace.info.readerPageRows = readerTable.data.length;
      trace.info.readerPageNumber = readerPageIndex + 1;
      trace.info.displayRows = visibleTable.data.length;
      trace.info.sourceColumns = visibleTable.columns.length;
      trace.info.pageNumber = nextPage + 1;
      trace.info.totalRows = activeReader.totalRowCount;
      trace.info.pageCount = activeReader.pageCount;
      trace.info.uiPageCount = uiPageCount;

      pageIndex = nextPage;
      const renderedColumnCount = perfSync(trace, '描画: renderTable合計', () =>
        renderTable(visibleTable, trace)
      );
      trace.info.displayColumns = renderedColumnCount;
      trace.info.displayCells = visibleTable.data.length * renderedColumnCount;

      const pagerStarted = perfNow();
      updatePager();
      if (renderedColumnCount === 0) {
        setMessage('「表示列」に設定したフィールドをSummary Dataで確認できません。', 'error');
      } else {
        setMessage('');
      }
      setBusy(false);
      perfPhase(trace, '描画: ページ情報・状態表示', pagerStarted);
      perfFrameProbe(trace);
    } catch (error) {
      trace.status = 'エラー';
      throw error;
    } finally {
      if (!parentTrace) perfFinish(trace);
    }
  }

  async function refreshData(reason, parentTrace) {
    const trace = parentTrace || perfStart('再読み込み: ' + reason, 'refresh');
    const currentGeneration = ++generation;
    try {
      setBusy(true);
      setMessage(
        reason === 'filter-changed'
          ? 'Tableauフィルター変更を反映しています...'
          : reason === 'summary-data-changed'
            ? 'データ変更を反映しています...'
            : 'データを読み込んでいます...',
        'loading'
      );

      await releaseReader(trace);
      if (currentGeneration !== generation) {
        trace.status = '更新により破棄';
        return;
      }

      mappedFields = await perfAsync(trace, '設定: フィールド対応全体', () =>
        getMappedFields(trace)
      );
      trace.info.mappedFields = mappedFields.length;
      if (currentGeneration !== generation) {
        trace.status = '更新により破棄';
        return;
      }
      if (!mappedFields.length) {
        renderEmptyTable();
        updatePager();
        setMessage('TableauのViz Extension設定で「表示列」にフィールドを追加してください。');
        setBusy(false);
        return;
      }

      await createReader(trace);
      if (currentGeneration !== generation) {
        trace.status = '更新により破棄';
        return;
      }

      if (reader.pageCount === 0) {
        renderEmptyTable();
        updatePager();
        setMessage('表示対象のデータがありません。');
        setBusy(false);
        return;
      }
      await loadPage(0, currentGeneration, trace);
    } catch (error) {
      trace.status = 'エラー';
      throw error;
    } finally {
      if (!parentTrace) perfFinish(trace);
    }
  }

  function scheduleRefresh(reason) {
    dataEventVersion++;
    cachedReaderPage = null;
    if (!exportInProgress) setBusy(true);
    if (exportInProgress) {
      if (csvSession) {
        csvSession.invalidated = true;
        csvStatus('Tableauのデータ変更を検知しました。CSV出力を中止します。');
        $('csvSavePart').disabled = true;
        $('csvNextPart').disabled = true;
        if (!csvSession.creating) {
          closeCsvExport('データ変更のためCSV出力を中止しました。').catch(showError);
        }
      }
      return;
    }
    perfEvent(reason || 'summary-data-changed');
    pendingRefreshReason = reason || 'summary-data-changed';

    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }

    refreshTimer = setTimeout(function () {
      const reasonToUse = pendingRefreshReason;
      refreshTimer = null;
      pendingRefreshReason = 'summary-data-changed';
      refreshData(reasonToUse).catch(showError);
    }, AUTO_REFRESH_DELAY_MS);
  }

  async function initialize() {
    const trace = perfStart('初回表示（V14のロード後）', 'initial');
    try {
      setBusy(true);
      setMessage('Viz Extension を初期化しています...', 'loading');

      await perfAsync(trace, 'API: extensions.initializeAsync', () =>
        tableau.extensions.initializeAsync({
          configure: function () {
            if (exportInProgress) return;
            openSettings();
          }
        })
      );
      worksheet = tableau.extensions.worksheetContent &&
        tableau.extensions.worksheetContent.worksheet;
      if (!worksheet) {
        throw new Error('Worksheet コンテキストを取得できません。Viz Extension として読み込んでください。');
      }

      perfSync(trace, '設定: ローカル設定の読み込み', () => {
        loadColumnWidths();
        loadFixedColumnCount();
        loadColumnDisplayModes();
        loadColumnPresentation();
      });

      perfSync(trace, 'イベント: 登録', () => {
        removeSummaryListener = worksheet.addEventListener(
          tableau.TableauEventType.SummaryDataChanged,
          function () { scheduleRefresh('summary-data-changed'); }
        );
        removeFilterListener = worksheet.addEventListener(
          tableau.TableauEventType.FilterChanged,
          function () { scheduleRefresh('filter-changed'); }
        );
      });
      await refreshData('initial', trace);
    } catch (error) {
      trace.status = 'エラー';
      throw error;
    } finally {
      perfFinish(trace);
    }
  }

  function setSettingsError(message) {
    const el = $('settingsError');
    el.textContent = message || '';
    el.hidden = !message;
  }

  function createHeaderColorControls(level, fieldName, palette, container, onInput) {
    const group = document.createElement('div');
    group.className = 'header-cell-color-controls';
    for (const [kind, caption] of [['background', '背景色'], ['text', '文字色']]) {
      const label = document.createElement('label');
      label.className = 'header-cell-color-label';
      const title = document.createElement('span');
      title.textContent = caption;
      const input = document.createElement('input');
      input.type = 'color';
      input.className = 'header-cell-color-input';
      input.value = palette[kind];
      input.setAttribute('aria-label', fieldName + ' ' +
        (level === 'upper' ? '上位' : '下位') + ' ' + caption);
      input.addEventListener('input', () => onInput(kind, input.value));
      label.append(title, input);
      group.appendChild(label);
    }
    container.appendChild(group);
  }

  function renderUpperHeaderColorSettings() {
    const container = $('upperHeaderColorList');
    if (!container || !pendingColumnSettings) return;
    container.innerHTML = '';
    const fields = mappedFields;
    const groups = pendingColumnSettings.groups;
    const fixedCount = Math.min(fields.length, Math.max(0,
      Math.trunc(Number($('fixedColumnCount').value) || 0)));
    const runs = upperHeaderRuns(fields, field => groups[field] || '', fixedCount);
    if (!runs.length) {
      const empty = document.createElement('div');
      empty.className = 'header-color-empty';
      empty.textContent = '上位ヘッダーを設定すると、ここにセルごとの色設定が表示されます。';
      container.appendChild(empty);
    }
    for (const run of runs) {
      const item = document.createElement('div');
      item.className = 'upper-color-item';
      const title = document.createElement('strong');
      title.textContent = run.label + '（列' + (run.start + 1) +
        (run.end > run.start + 1 ? '～' + run.end : '') + '）';
      item.appendChild(title);
      const colorMap = pendingColumnSettings.cellColors;
      const palette = headerCellPalette('upper', run.fieldName, colorMap);
      createHeaderColorControls('upper', run.fieldName, palette, item, (kind, color) => {
        if (!colorMap.upper[run.fieldName]) colorMap.upper[run.fieldName] = {};
        colorMap.upper[run.fieldName][kind] = color;
      });
      container.appendChild(item);
    }
  }

  function renderColumnSettings() {
    const list = $('columnSettingsList');
    list.innerHTML = '';

    mappedFields.forEach(({fieldName}) => {
      const numeric = numericFieldNames.has(fieldName);
      const draft = pendingColumnSettings;
      const item = document.createElement('div');
      item.className = 'column-setting-item';
      item.dataset.fieldName = fieldName;

      const source = document.createElement('div');
      source.className = 'column-source-name';
      const sourceTitle = document.createElement('span');
      sourceTitle.textContent = '元の項目名';
      const sourceValue = document.createElement('strong');
      sourceValue.textContent = fieldName;
      source.append(sourceTitle, sourceValue);
      item.appendChild(source);

      const headerFields = document.createElement('div');
      headerFields.className = 'column-header-fields';
      const createTextField = (caption, cls, initial, placeholder) => {
        const field = document.createElement('label');
        field.className = 'column-setting-field column-header-field';
        const title = document.createElement('span');
        title.textContent = caption;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = cls;
        input.value = initial;
        input.placeholder = placeholder;
        input.setAttribute('aria-label', fieldName + ' ' + caption);
        field.append(title, input);
        headerFields.appendChild(field);
      };

      // Upper header is on the left; bottom header can be renamed freely.
      createTextField('上位ヘッダー', 'column-header-group-input',
        draft.groups[fieldName] || '', '未指定');
      createTextField('項目名', 'column-header-label-input',
        draft.labels[fieldName] || fieldName, fieldName);
      item.appendChild(headerFields);

      const groupInput = item.querySelector('.column-header-group-input');
      groupInput.addEventListener('input', () => {
        draft.groups[fieldName] = groupInput.value.trim();
        renderUpperHeaderColorSettings();
      });

      const lowerColors = document.createElement('div');
      lowerColors.className = 'lower-header-colors';
      const lowerTitle = document.createElement('strong');
      lowerTitle.textContent = '下位ヘッダーの色';
      lowerColors.appendChild(lowerTitle);
      createHeaderColorControls('lower', fieldName,
        headerCellPalette('lower', fieldName, draft.cellColors),
        lowerColors, (kind, color) => {
          if (!draft.cellColors.lower[fieldName]) draft.cellColors.lower[fieldName] = {};
          draft.cellColors.lower[fieldName][kind] = color;
        });
      item.appendChild(lowerColors);

      const selectField = (caption,cssClass,options,chosen) => {
        const field = document.createElement('label');
        field.className = 'column-setting-field';
        const description = document.createElement('span');
        description.textContent = caption;
        field.appendChild(description);
        const select = document.createElement('select');
        select.className = cssClass;
        options.forEach(([value,label]) => {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = label;
          if (cssClass === 'column-mode-select' &&
              value !== 'normal' && !numeric) opt.disabled = true;
          select.appendChild(opt);
        });
        select.value = chosen;
        field.appendChild(select);
        item.appendChild(field);
        return select;
      };

      const mode = selectField('表示方式','column-mode-select',
        [['normal','通常'],['bar','棒グラフ'],['heatmap','ヒートマップ']],
        numeric ? (draft.modes[fieldName] || 'normal') : 'normal');

      const config = draft.gradients[fieldName] || gradientConfig(fieldName);
      const block = document.createElement('div');
      block.className = 'column-gradient-settings';
      const intro = document.createElement('div');
      intro.className = 'column-gradient-description';
      intro.textContent = '境界値は3つすべて入力すると固定、空欄なら自動です。値の間は色を補間します。';
      block.appendChild(intro);

      [['low','下限'],['mid','中間'],['high','上限']].forEach(([stop,label]) => {
        const row = document.createElement('div');
        row.className = 'column-gradient-stop';
        const title = document.createElement('span');
        title.className = 'column-gradient-label';
        title.textContent = label;
        row.appendChild(title);

        const boundary = document.createElement('input');
        boundary.className = 'column-gradient-boundary';
        boundary.dataset.stop = stop;
        boundary.type = 'number';
        boundary.step = 'any';
        boundary.placeholder = '自動';
        boundary.setAttribute('aria-label',fieldName + ' ' + label + 'の境界値');
        boundary.value = config.bounds[stop] === null ||
          config.bounds[stop] === undefined ? '' : String(config.bounds[stop]);
        row.appendChild(boundary);

        const color = document.createElement('input');
        color.className = 'column-gradient-color';
        color.dataset.stop = stop;
        color.type = 'color';
        color.value = config.colors[stop];
        color.setAttribute('aria-label',fieldName + ' ' + label + 'の色');
        row.appendChild(color);
        block.appendChild(row);
      });
      block.hidden = !numeric || mode.value === 'normal';
      mode.addEventListener('change',() => {
        block.hidden = !numeric || mode.value === 'normal';
      });
      item.appendChild(block);
      list.appendChild(item);
    });
  }

  function openSettings() {
    pendingColumnSettings = {
      modes: {...columnDisplayModes},
      labels: {...columnHeaderLabels},
      groups: {...columnHeaderGroups},
      cellColors: sanitizeCellColors(headerCellColors),
      gradients: Object.fromEntries(mappedFields.map(({fieldName}) =>
        [fieldName,gradientConfig(fieldName)]))
    };
    const fixedInput = $('fixedColumnCount');
    fixedInput.max = String(mappedFields.length);
    fixedInput.value = String(Math.min(fixedColumnCount,mappedFields.length));
    renderColumnSettings();
    renderUpperHeaderColorSettings();
    setSettingsError('');
    $('settingsPanel').hidden = false;
    hideCellMenu();
  }

  function closeSettings() {
    pendingColumnSettings = null;
    setSettingsError('');
    $('settingsPanel').hidden = true;
  }

  async function applySettings() {
    const items = Array.from(
      $('columnSettingsList').querySelectorAll('.column-setting-item')
    );
    const modes = {};
    const gradients = {};
    const labels = {};
    const groups = {};
    const cellColors = sanitizeCellColors(pendingColumnSettings.cellColors);

    for (const item of items) {
      const fieldName = item.dataset.fieldName;
      const numeric = numericFieldNames.has(fieldName);
      const mode = item.querySelector('.column-mode-select').value;
      const label = item.querySelector('.column-header-label-input').value.trim();
      const group = item.querySelector('.column-header-group-input').value.trim();
      if (label && label !== fieldName) labels[fieldName] = label;
      if (group) groups[fieldName] = group;
      if (numeric && (mode === 'bar' || mode === 'heatmap')) {
        modes[fieldName] = mode;
      }
      if (!numeric) continue;

      const config = {bounds:{},colors:{}};
      item.querySelectorAll('.column-gradient-stop').forEach(row => {
        const boundary = row.querySelector('.column-gradient-boundary');
        const color = row.querySelector('.column-gradient-color');
        const stop = boundary.dataset.stop;
        const text = String(boundary.value).trim();
        config.bounds[stop] = text === '' ? null : Number(text);
        config.colors[stop] = color.value;
      });
      const count = GRADIENT_STOPS.filter(
        stop => config.bounds[stop] !== null
      ).length;
      if (count !== 0 && count !== 3) {
        setSettingsError('「' + fieldName + '」の境界値は、3つとも空欄か、3つとも入力してください。');
        return;
      }
      if (count === 3 && !(Number.isFinite(config.bounds.low) &&
          Number.isFinite(config.bounds.mid) &&
          Number.isFinite(config.bounds.high) &&
          config.bounds.low < config.bounds.mid &&
          config.bounds.mid < config.bounds.high)) {
        setSettingsError('「' + fieldName + '」は「下限 < 中間 < 上限」の順に数値を指定してください。');
        return;
      }
      gradients[fieldName] = config;
    }

    const requestedFixedCount = Number($('fixedColumnCount').value);
    const newFixedCount = Number.isInteger(requestedFixedCount)
      ? Math.max(0,Math.min(requestedFixedCount,mappedFields.length)) : 0;

    columnDisplayModes = modes;
    columnGradients = gradients;
    columnHeaderLabels = labels;
    columnHeaderGroups = groups;
    headerCellColors = cellColors;
    fixedColumnCount = newFixedCount;
    await saveFixedColumnCount();
    await saveColumnDisplayModes();
    await saveColumnPresentation();
    closeSettings();
    await refreshData('manual');
  }

  function showError(error) {
    console.error(error);
    setMessage(
      error && error.message ? error.message : String(error),
      'error'
    );
    setBusy(false);
  }

  const dataTableElement = $('dataTable');
  dataTableElement.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const td = event.target.closest('tbody td');
    if (!td) return;
    hideCellMenu();
    selectCell(td, event.shiftKey);
    pointerSelecting = true;
    event.preventDefault(); // Prevent native text selection while dragging cells.
  });

  dataTableElement.addEventListener('pointerover', event => {
    if (!pointerSelecting) return;
    const td = event.target.closest('tbody td');
    if (td) selectCell(td, true);
  });

  document.addEventListener('pointerup', () => { pointerSelecting = false; });
  document.addEventListener('pointercancel', () => { pointerSelecting = false; });

  dataTableElement.addEventListener('contextmenu', event => {
    const td = event.target.closest('tbody td');
    if (!td) return;
    event.preventDefault();
    if (!isInSelection(td)) selectCell(td, false);
    const menu = $('cellMenu');
    menu.style.left = Math.max(8, Math.min(event.clientX, window.innerWidth - 145)) + 'px';
    menu.style.top = Math.max(8, Math.min(event.clientY, window.innerHeight - 50)) + 'px';
    menu.hidden = false;
    $('copyCell').focus();
  });

  $('copyCell').addEventListener('click', () => {
    try { copySelectedCell(); } catch (error) { showError(error); }
  });

  document.addEventListener('pointerdown', event => {
    if (!$('cellMenu').hidden && !$('cellMenu').contains(event.target)) hideCellMenu();
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hideCellMenu();
  });

  $('prev').addEventListener('click', function () {
    loadPage(pageIndex - 1, generation).catch(showError);
  });

  $('next').addEventListener('click', function () {
    loadPage(pageIndex + 1, generation).catch(showError);
  });

  $('refreshData').addEventListener('click', function () {
    refreshData('manual').catch(showError);
  });

  $('exportCsv').addEventListener('click', function () {
    startCsvExport().catch(onCsvFailure);
  });
  $('csvSavePart').addEventListener('click', saveCsvPart);
  $('csvNextPart').addEventListener('click', function () {
    nextCsvPart().catch(onCsvFailure);
  });
  $('csvFinish').addEventListener('click', function () {
    cancelCsvExport().catch(showError);
  });

  $('closeSettings').addEventListener('click', closeSettings);
  $('cancelSettings').addEventListener('click', closeSettings);
  $('fixedColumnCount').addEventListener('input', renderUpperHeaderColorSettings);
  $('applySettings').addEventListener('click', function () {
    applySettings().catch(showError);
  });

  $('perfToggle').addEventListener('click', () => {
    $('perfPanel').hidden = !$('perfPanel').hidden;
    perfRender();
  });
  $('perfClose').addEventListener('click', () => { $('perfPanel').hidden = true; });
  $('perfCopy').addEventListener('click', () => {
    try {
      writeClipboardText(perfExportText());
      $('perfCopyStatus').textContent = '計測結果（TSV）をコピーしました。';
    } catch (error) {
      $('perfCopyStatus').textContent = 'コピー失敗: ' + error.message;
    }
  });
  $('perfClear').addEventListener('click', () => {
    perfReports.length = 0;
    perfEvents.length = 0;
    $('perfCopyStatus').textContent = '';
    perfRender();
  });

  window.addEventListener('beforeunload', function () {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }

    try {
      if (removeSummaryListener) removeSummaryListener();
    } catch (_) {}

    try {
      if (removeFilterListener) removeFilterListener();
    } catch (_) {}

    if (reader) {
      reader.releaseAsync().catch(function () {});
    }
    if (csvSession && csvSession.reader) {
      csvSession.reader.releaseAsync().catch(function () {});
    }
  });

  initialize().catch(showError);
})();