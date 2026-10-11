(function () {
  'use strict';

  const PAGE_SIZE = 200;
  const AUTO_REFRESH_DELAY_MS = 150;
  // Preserve rows ID for existing field assignments.
  const ENCODING_ORDER = ['rows'];
  const COLUMN_WIDTHS_KEY = 'columnWidthsV1';
  const FIXED_COLUMN_COUNT_KEY = 'fixedColumnCountV1';
  const COLUMN_DISPLAY_MODES_KEY = 'columnDisplayModesV1';
  const COLUMN_FORMATS_KEY = 'columnFormatsV1';
  const COLUMN_COLORS_KEY = 'columnColorsV1';
  const COLUMN_GRADIENTS_KEY = 'columnGradientsV1';
  const DEFAULT_GRADIENT_COLORS = {
    low: '#e8f0fe',
    mid: '#90caf9',
    high: '#1a73e8'
  };
  const GRADIENT_STOPS = ['low', 'mid', 'high'];
  const DEFAULT_VISUAL_COLOR = '#1a73e8';
  const FORMAT_PRESETS = [
    ['tableau', 'Tableau書式'],
    ['raw', '元の値'],
    ['number0', '数値（小数0桁）'],
    ['number1', '数値（小数1桁）'],
    ['number2', '数値（小数2桁）'],
    ['number3', '数値（小数3桁）'],
    ['percent0', '％（小数0桁）'],
    ['percent1', '％（小数1桁）'],
    ['percent2', '％（小数2桁）'],
    ['dateDash', '日付（YYYY-MM-DD）'],
    ['dateSlash', '日付（YYYY/MM/DD）']
  ];
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
  let pageIndex = 0;
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
  let columnFormats = {};
  let columnColors = {};
  let columnGradients = {};
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
      pageIndex >= reader.pageCount - 1;
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

  function formatValue(cell, fieldName) {
    const format = columnFormats[fieldName] || 'tableau';
    if (format === 'tableau') return displayValue(cell);
    const raw = rawValue(cell);
    if (raw === null || raw === undefined || raw === '') return '';
    if (format === 'raw') {
      return raw instanceof Date ? raw.toISOString() : String(raw);
    }
    if (/^(number|percent)[0-3]$/.test(format)) {
      const numeric = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(numeric)) return displayValue(cell);
      const percent = format.startsWith('percent');
      const digits = Number(format.slice(-1));
      return new Intl.NumberFormat('ja-JP', {
        useGrouping: true,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        style: percent ? 'percent' : 'decimal'
      }).format(numeric);
    }
    if (format === 'dateDash' || format === 'dateSlash') {
      let dateText = '';
      if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
        const year = raw.getFullYear();
        const month = String(raw.getMonth() + 1).padStart(2, '0');
        const day = String(raw.getDate()).padStart(2, '0');
        dateText = year + '-' + month + '-' + day;
      } else {
        const match = String(raw).match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:$|[T\s])/);
        if (match) {
          dateText = match[1] + '-' +
            match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');
        }
      }
      if (!dateText) return displayValue(cell);
      return format === 'dateSlash' ? dateText.replace(/-/g, '/') : dateText;
    }
    return displayValue(cell);
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

  async function getMappedFields() {
    const visualSpec = await worksheet.getVisualSpecificationAsync();

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

  function getAutoColumnWidth(columnInfo, dataTable) {
    let required = measureTextWidth(columnInfo.fieldName);

    for (const row of dataTable.data) {
      required = Math.max(
        required,
        measureTextWidth(formatValue(row[columnInfo.cellIndex], columnInfo.fieldName))
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
    const formats = new Set(FORMAT_PRESETS.map(([key]) => key));
    columnFormats = Object.fromEntries(
      Object.entries(read(COLUMN_FORMATS_KEY))
        .filter(([, value]) => formats.has(value))
    );
    columnColors = Object.fromEntries(
      Object.entries(read(COLUMN_COLORS_KEY))
        .filter(([, value]) => validHex(value))
    );
    columnGradients = read(COLUMN_GRADIENTS_KEY);
  }

  async function saveColumnPresentation() {
    tableau.extensions.settings.set(
      COLUMN_FORMATS_KEY, JSON.stringify(columnFormats)
    );
    tableau.extensions.settings.set(
      COLUMN_COLORS_KEY, JSON.stringify(columnColors)
    );
    tableau.extensions.settings.set(
      COLUMN_GRADIENTS_KEY, JSON.stringify(columnGradients)
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
    const activeFixedCount = Math.min(fixedColumnCount, cols.length);
    let left = 0;

    cols.forEach((col, index) => {
      const width = parseFloat(col.style.width);
      const cells = table.querySelectorAll(
        'thead tr > th:nth-child(' + (index + 1) +
          '), tbody tr > td:nth-child(' + (index + 1) + ')'
      );

      cells.forEach((cell) => {
        cell.classList.remove('fixed-column', 'fixed-column-boundary');
        cell.style.left = '';
      });

      if (index < activeFixedCount) {
        cells.forEach((cell) => {
          cell.classList.add('fixed-column');
          cell.style.left = left + 'px';

          if (index === activeFixedCount - 1) {
            cell.classList.add('fixed-column-boundary');
          }
        });
      }

      left += Number.isFinite(width) ? width : DEFAULT_COLUMN_WIDTH;
    });
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
    const text = formatValue(cell, fieldName);

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

  async function copySelectedCell() {
    if (!selectionBounds()) {
      hideCellMenu();
      return;
    }
    const text = selectedText();
    hideCellMenu();
    await writeClipboardText(text);
    setMessage('選択範囲をコピーしました。');
  }

  function renderTable(dataTable) {
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

    if (!displayColumns.length) {
      return 0;
    }

    const headerRow = document.createElement('tr');
    let totalWidth = 0;

    displayColumns.forEach((columnInfo) => {
      const width = resolveColumnWidth(columnInfo, dataTable);
      const col = document.createElement('col');
      col.dataset.fieldName = columnInfo.fieldName;
      col.style.width = width + 'px';
      colgroup.appendChild(col);
      totalWidth += width;

      const th = document.createElement('th');
      const label = document.createElement('span');
      label.className = 'column-header-label';
      label.textContent =
        columnInfo.column.fieldName ||
        columnInfo.column.caption ||
        columnInfo.column.name ||
        columnInfo.fieldName;

      const resizer = document.createElement('span');
      resizer.className = 'column-resizer';
      resizer.setAttribute('role', 'separator');
      resizer.setAttribute('aria-orientation', 'vertical');
      resizer.title = 'ドラッグして列幅を変更';

      attachColumnResizer(
        resizer,
        table,
        col,
        columnInfo.fieldName
      );

      th.appendChild(label);
      th.appendChild(resizer);
      headerRow.appendChild(th);
    });

    table.style.width = totalWidth + 'px';
    table.style.minWidth = totalWidth + 'px';

    thead.appendChild(headerRow);

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

    tbody.appendChild(fragment);
    updateStickyOffsets(table);

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
    return columns.map(info => escapeDelimitedValue(
      info.column.fieldName || info.column.caption ||
      info.column.name || info.fieldName, ','
    )).join(',') + '\r\n';
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
            escapeDelimitedValue(formatValue(row[info.cellIndex], info.fieldName), ',')
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

  async function writeClipboardText(text) {
    if (
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (error) {
        console.warn(
          'navigator.clipboard.writeText failed; using fallback.',
          error
        );
      }
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    const copied = document.execCommand('copy');
    textarea.remove();

    if (!copied) {
      throw new Error('クリップボードへのコピーに失敗しました。');
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
        mappedFields.length > 0
          ? mappedFields.length + ' 列'
          : '-';
      $('page').textContent = '-';
      $('prev').disabled = true;
      $('next').disabled = true;
      return;
    }

    $('status').textContent =
      reader.totalRowCount.toLocaleString() +
      ' 行 / ' +
      mappedFields.length +
      ' 列 / ' +
      PAGE_SIZE +
      ' 行/ページ';

    $('page').textContent =
      reader.pageCount === 0
        ? '0 / 0'
        : pageIndex + 1 + ' / ' + reader.pageCount;

    $('prev').disabled = pageIndex <= 0;
    $('next').disabled = pageIndex >= reader.pageCount - 1;
  }

  async function releaseReader() {
    if (!reader) return;

    const oldReader = reader;
    reader = null;

    try {
      await oldReader.releaseAsync();
    } catch (error) {
      console.warn('DataTableReader.releaseAsync failed', error);
    }
  }

  async function createReader() {
    reader = await worksheet.getSummaryDataReaderAsync(
      PAGE_SIZE,
      { ignoreSelection: true, applyWorksheetFormatting: true }
    );

    pageIndex = 0;
    updatePager();
  }

  async function loadPage(nextPage, expectedGeneration) {
    const activeReader = reader;

    if (!activeReader) return;
    if (nextPage < 0 || nextPage >= activeReader.pageCount) return;

    setBusy(true);
    setMessage('読み込み中...', 'loading');

    const dataTable = await activeReader.getPageAsync(nextPage);

    if (
      activeReader !== reader ||
      expectedGeneration !== generation
    ) {
      return;
    }

    // Intentionally preserve Tableau's worksheet ordering.
    // Do not sort only the current 200-row page in the Extension.
    pageIndex = nextPage;
    const renderedColumnCount = renderTable(dataTable);
    updatePager();

    if (renderedColumnCount === 0) {
      setMessage(
        '「表示列」に設定したフィールドをSummary Dataで確認できません。',
        'error'
      );
    } else {
      setMessage('');
    }

    setBusy(false);
  }

  async function refreshData(reason) {
    const currentGeneration = ++generation;

    setBusy(true);
    setMessage(
      reason === 'filter-changed'
        ? 'Tableauフィルター変更を反映しています...'
        : reason === 'summary-data-changed'
          ? 'データ変更を反映しています...'
          : 'データを読み込んでいます...',
      'loading'
    );

    await releaseReader();

    if (currentGeneration !== generation) return;

    mappedFields = await getMappedFields();

    if (currentGeneration !== generation) return;

    if (!mappedFields.length) {
      renderEmptyTable();
      updatePager();
      setMessage(
        'TableauのViz Extension設定で「表示列」にフィールドを追加してください。'
      );
      setBusy(false);
      return;
    }

    await createReader();

    if (currentGeneration !== generation) return;

    if (reader.pageCount === 0) {
      renderEmptyTable();
      updatePager();
      setMessage('表示対象のデータがありません。');
      setBusy(false);
      return;
    }

    await loadPage(0, currentGeneration);
  }

  function scheduleRefresh(reason) {
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
    setBusy(true);
    setMessage('Viz Extension を初期化しています...', 'loading');

    // Tableau displays 'Format Extension' in the worksheet Marks card,
    // rather than exposing settings to dashboard viewers.
    await tableau.extensions.initializeAsync({
      configure: function () {
        if (exportInProgress) return;
        openSettings();
      }
    });

    worksheet =
      tableau.extensions.worksheetContent &&
      tableau.extensions.worksheetContent.worksheet;

    if (!worksheet) {
      throw new Error(
        'Worksheet コンテキストを取得できません。Viz Extension として読み込んでください。'
      );
    }

    loadColumnWidths();
    loadFixedColumnCount();
    loadColumnDisplayModes();
    loadColumnPresentation();

    removeSummaryListener = worksheet.addEventListener(
      tableau.TableauEventType.SummaryDataChanged,
      function () {
        scheduleRefresh('summary-data-changed');
      }
    );

    removeFilterListener = worksheet.addEventListener(
      tableau.TableauEventType.FilterChanged,
      function () {
        scheduleRefresh('filter-changed');
      }
    );

    await refreshData('initial');
  }

  function setSettingsError(message) {
    const el = $('settingsError');
    el.textContent = message || '';
    el.hidden = !message;
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

      const name = document.createElement('strong');
      name.className = 'column-setting-name';
      name.textContent = fieldName;
      item.appendChild(name);

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

      selectField('表示書式','column-format-select',
        FORMAT_PRESETS,draft.formats[fieldName] || 'tableau');
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
      formats: {...columnFormats},
      gradients: Object.fromEntries(mappedFields.map(({fieldName}) =>
        [fieldName,gradientConfig(fieldName)]))
    };
    renderColumnSettings();
    const fixedInput = $('fixedColumnCount');
    fixedInput.max = String(mappedFields.length);
    fixedInput.value = String(Math.min(fixedColumnCount,mappedFields.length));
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
    const formats = {};
    const gradients = {};
    const validFormats = new Set(FORMAT_PRESETS.map(([key]) => key));

    for (const item of items) {
      const fieldName = item.dataset.fieldName;
      const numeric = numericFieldNames.has(fieldName);
      const mode = item.querySelector('.column-mode-select').value;
      const format = item.querySelector('.column-format-select').value;
      if (numeric && (mode === 'bar' || mode === 'heatmap')) {
        modes[fieldName] = mode;
      }
      if (validFormats.has(format) && format !== 'tableau') {
        formats[fieldName] = format;
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
    columnFormats = formats;
    columnGradients = gradients;
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
    copySelectedCell().catch(showError);
  });

  document.addEventListener('pointerdown', event => {
    if (!$('cellMenu').hidden && !$('cellMenu').contains(event.target)) hideCellMenu();
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hideCellMenu();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' &&
        selectionBounds() && !event.target.closest('input,textarea,select')) {
      // Let the browser dispatch a trusted copy event when available.
      // The copy handler synchronously fills clipboardData inside the iframe.
      if (!document.queryCommandSupported?.('copy')) {
        event.preventDefault();
        copySelectedCell().catch(showError);
      }
    }
  });

  document.addEventListener('copy', event => {
    if (!selectionBounds() || event.target.closest?.('input,textarea,select')) return;
    if (!event.clipboardData) return;
    event.clipboardData.setData('text/plain', selectedText());
    event.preventDefault();
    hideCellMenu();
    setMessage('選択範囲をコピーしました。');
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
  $('applySettings').addEventListener('click', function () {
    applySettings().catch(showError);
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