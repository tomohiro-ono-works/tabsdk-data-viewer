(function () {
  'use strict';

  const PAGE_SIZE = 200;
  const AUTO_REFRESH_DELAY_MS = 150;
  const ENCODING_ORDER = ['rows', 'label'];
  const COLUMN_WIDTHS_KEY = 'columnWidthsV1';
  const COLUMN_ORDER_KEY = 'columnOrderV1';
  const FIXED_COLUMN_COUNT_KEY = 'fixedColumnCountV1';
  const COLUMN_DISPLAY_MODES_KEY = 'columnDisplayModesV1';
  const DEFAULT_COLUMN_WIDTH = 160;
  const MIN_COLUMN_WIDTH = 80;
  const MAX_COLUMN_WIDTH = 420;
  const COLUMN_HORIZONTAL_PADDING = 24;
  const CLIPBOARD_WARNING_ROWS = 20000;
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
  let savedColumnOrder = [];
  let fixedColumnCount = 0;
  let columnDisplayModes = {};
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
    $('openSettings').disabled = busy || exportInProgress;
    $('exportCsv').disabled = busy || exportInProgress || !reader;
    $('copyTsv').disabled = busy || exportInProgress || !reader;
    $('prev').disabled =
      busy || exportInProgress || !reader || pageIndex <= 0;
    $('next').disabled =
      busy ||
      exportInProgress ||
      !reader ||
      pageIndex >= reader.pageCount - 1;
  }

  function setExportBusy(busy) {
    exportInProgress = busy;
    setBusy(false);
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

    return sortDisplayColumns(resolved);
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

  function loadColumnOrder() {
    const raw = tableau.extensions.settings.get(COLUMN_ORDER_KEY);

    if (!raw) {
      savedColumnOrder = [];
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      savedColumnOrder = Array.isArray(parsed)
        ? parsed.filter((value) => typeof value === 'string')
        : [];
    } catch (error) {
      console.warn('Column order settings could not be parsed.', error);
      savedColumnOrder = [];
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

  async function saveColumnOrder() {
    tableau.extensions.settings.set(
      COLUMN_ORDER_KEY,
      JSON.stringify(savedColumnOrder)
    );

    try {
      await tableau.extensions.settings.saveAsync();
    } catch (error) {
      console.warn('Column order settings could not be saved.', error);
    }
  }

  function sortDisplayColumns(displayColumns) {
    if (!savedColumnOrder.length) return displayColumns;

    const rank = new Map(
      savedColumnOrder.map((fieldName, index) => [fieldName, index])
    );

    return displayColumns
      .map((item, originalIndex) => ({ item, originalIndex }))
      .sort((a, b) => {
        const ar = rank.has(a.item.fieldName)
          ? rank.get(a.item.fieldName)
          : Number.MAX_SAFE_INTEGER;
        const br = rank.has(b.item.fieldName)
          ? rank.get(b.item.fieldName)
          : Number.MAX_SAFE_INTEGER;

        return ar === br ? a.originalIndex - b.originalIndex : ar - br;
      })
      .map(({ item }) => item);
  }

  async function saveColumnWidths() {
    tableau.extensions.settings.set(
      COLUMN_WIDTHS_KEY,
      JSON.stringify(manualColumnWidths)
    );

    try {
      await tableau.extensions.settings.saveAsync();
    } catch (error) {
      console.warn('Column width settings could not be saved.', error);
    }
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
        saveColumnWidths();
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

  function renderValueCell(td, cell, mode, scale) {
    const text = displayValue(cell);

    if (mode === 'bar' && scale) {
      const value = numericValue(cell);
      const ratio = normalizedRatio(value, scale);

      td.classList.add('cell-visual', 'cell-bar');

      const bar = document.createElement('span');
      bar.className = 'cell-bar-fill';
      bar.style.width = Math.round(ratio * 10000) / 100 + '%';

      const label = document.createElement('span');
      label.className = 'cell-visual-label';
      label.textContent = text;

      td.appendChild(bar);
      td.appendChild(label);
      return;
    }

    if (mode === 'heatmap' && scale) {
      const value = numericValue(cell);
      const ratio = normalizedRatio(value, scale);

      td.classList.add('cell-visual', 'cell-heatmap');
      td.style.setProperty(
        '--heat-strength',
        String(0.08 + ratio * 0.42)
      );

      const label = document.createElement('span');
      label.className = 'cell-visual-label';
      label.textContent = text;
      td.appendChild(label);
      return;
    }

    td.textContent = text;
  }

  function renderTable(dataTable) {
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
          scales.get(columnInfo.fieldName)
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

  async function buildDelimitedExport(delimiter, includeBom) {
    const activeReader = reader;
    const expectedGeneration = generation;

    if (!activeReader) {
      throw new Error('エクスポート対象のReaderがありません。');
    }

    const parts = [];
    let headerWritten = false;
    let exportedRows = 0;

    if (includeBom) {
      parts.push('\uFEFF');
    }

    for (
      let exportPage = 0;
      exportPage < activeReader.pageCount;
      exportPage++
    ) {
      if (
        activeReader !== reader ||
        expectedGeneration !== generation
      ) {
        throw new Error(
          'エクスポート中にデータが更新されました。再度実行してください。'
        );
      }

      setMessage(
        'エクスポート中... ' +
          (exportPage + 1) +
          ' / ' +
          activeReader.pageCount +
          ' ページ',
        'loading'
      );

      const dataTable = await activeReader.getPageAsync(exportPage);
      const displayColumns = resolveDisplayColumns(dataTable);

      if (!displayColumns.length) {
        throw new Error('エクスポート対象の列を取得できません。');
      }

      const lines = [];

      if (!headerWritten) {
        lines.push(
          displayColumns
            .map((columnInfo) =>
              escapeDelimitedValue(
                columnInfo.column.fieldName ||
                  columnInfo.column.caption ||
                  columnInfo.column.name ||
                  columnInfo.fieldName,
                delimiter
              )
            )
            .join(delimiter)
        );
        headerWritten = true;
      }

      dataTable.data.forEach((row) => {
        lines.push(
          displayColumns
            .map((columnInfo) =>
              escapeDelimitedValue(
                displayValue(row[columnInfo.cellIndex]),
                delimiter
              )
            )
            .join(delimiter)
        );
      });

      exportedRows += dataTable.data.length;
      parts.push(lines.join('\r\n') + '\r\n');
    }

    return {
      parts,
      rowCount: exportedRows
    };
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
        CSV_PAGE_SIZE, { ignoreSelection: true });
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

  async function copyTsv() {
    if (exportInProgress) return;

    if (
      reader &&
      reader.totalRowCount > CLIPBOARD_WARNING_ROWS &&
      !window.confirm(
        reader.totalRowCount.toLocaleString() +
          ' 行あります。大量コピーはブラウザが不安定になる可能性があります。続行しますか？'
      )
    ) {
      return;
    }

    setExportBusy(true);

    try {
      const result = await buildDelimitedExport('\t', false);
      const text = result.parts.join('');

      await writeClipboardText(text);

      setMessage(
        result.rowCount.toLocaleString() +
          ' 行をクリップボードへコピーしました。'
      );
    } finally {
      setExportBusy(false);
    }
  }

  function renderEmptyTable() {
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
      { ignoreSelection: true }
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
        '「行」または「ラベル」に設定したフィールドをSummary Dataで確認できません。',
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
        'TableauのViz Extension設定で「行」または「ラベル」にフィールドを追加してください。'
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

    await tableau.extensions.initializeAsync();

    worksheet =
      tableau.extensions.worksheetContent &&
      tableau.extensions.worksheetContent.worksheet;

    if (!worksheet) {
      throw new Error(
        'Worksheet コンテキストを取得できません。Viz Extension として読み込んでください。'
      );
    }

    loadColumnWidths();
    loadColumnOrder();
    loadFixedColumnCount();
    loadColumnDisplayModes();

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

  function renderColumnOrderSettings() {
    const list = $('columnOrderList');
    list.innerHTML = '';

    const currentFields = mappedFields.map((field) => field.fieldName);
    const ordered = savedColumnOrder
      .filter((fieldName) => currentFields.includes(fieldName));

    currentFields.forEach((fieldName) => {
      if (!ordered.includes(fieldName)) ordered.push(fieldName);
    });

    ordered.forEach((fieldName) => {
      const item = document.createElement('div');
      item.className = 'column-order-item';
      item.draggable = true;
      item.dataset.fieldName = fieldName;
      const dragHandle = document.createElement('span');
      dragHandle.className = 'column-order-handle';
      dragHandle.textContent = '↕';

      const label = document.createElement('span');
      label.className = 'column-order-label';
      label.textContent = fieldName;

      const modeSelect = document.createElement('select');
      modeSelect.className = 'column-mode-select';
      modeSelect.dataset.fieldName = fieldName;

      [
        ['normal', '通常'],
        ['bar', '棒グラフ'],
        ['heatmap', 'ヒートマップ']
      ].forEach(([value, text]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;

        if (value !== 'normal' && !numericFieldNames.has(fieldName)) {
          option.disabled = true;
        }

        modeSelect.appendChild(option);
      });

      const savedMode = columnDisplayModes[fieldName] || 'normal';
      modeSelect.value =
        numericFieldNames.has(fieldName) ? savedMode : 'normal';

      modeSelect.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
      });

      modeSelect.addEventListener('dragstart', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });

      item.appendChild(dragHandle);
      item.appendChild(label);
      item.appendChild(modeSelect);

      item.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', fieldName);
        event.dataTransfer.effectAllowed = 'move';
        item.classList.add('is-dragging');
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('is-dragging');
      });

      item.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      });

      item.addEventListener('drop', (event) => {
        event.preventDefault();
        const sourceField = event.dataTransfer.getData('text/plain');
        if (!sourceField || sourceField === fieldName) return;

        const next = ordered.slice();
        const from = next.indexOf(sourceField);
        const to = next.indexOf(fieldName);
        if (from < 0 || to < 0) return;

        next.splice(from, 1);
        next.splice(to, 0, sourceField);
        savedColumnOrder = next;
        renderColumnOrderSettings();
      });

      list.appendChild(item);
    });
  }

  function openSettings() {
    renderColumnOrderSettings();

    const fixedInput = $('fixedColumnCount');
    fixedInput.max = String(mappedFields.length);
    fixedInput.value = String(
      Math.min(fixedColumnCount, mappedFields.length)
    );

    $('settingsPanel').hidden = false;
  }

  function closeSettings() {
    $('settingsPanel').hidden = true;
  }

  async function applySettings() {
    const currentFields = mappedFields.map((field) => field.fieldName);
    const itemElements = Array.from(
      $('columnOrderList').querySelectorAll('.column-order-item')
    );

    const items = itemElements.map((item) => item.dataset.fieldName);

    savedColumnOrder = items.filter((fieldName) =>
      currentFields.includes(fieldName)
    );

    const nextDisplayModes = {};

    itemElements.forEach((item) => {
      const fieldName = item.dataset.fieldName;
      const select = item.querySelector('.column-mode-select');
      const mode = select ? select.value : 'normal';

      if (mode !== 'normal' && numericFieldNames.has(fieldName)) {
        nextDisplayModes[fieldName] = mode;
      }
    });

    columnDisplayModes = nextDisplayModes;

    const requestedFixedCount = Number($('fixedColumnCount').value);
    fixedColumnCount = Number.isInteger(requestedFixedCount)
      ? Math.max(0, Math.min(requestedFixedCount, currentFields.length))
      : 0;

    await saveColumnOrder();
    await saveFixedColumnCount();
    await saveColumnDisplayModes();
    closeSettings();
    await refreshData('manual');
  }

  function resetColumnOrder() {
    savedColumnOrder = [];
    renderColumnOrderSettings();
  }

  function showError(error) {
    console.error(error);
    setMessage(
      error && error.message ? error.message : String(error),
      'error'
    );
    setBusy(false);
  }

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

  $('copyTsv').addEventListener('click', function () {
    copyTsv().catch(showError);
  });

  $('openSettings').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('cancelSettings').addEventListener('click', closeSettings);
  $('applySettings').addEventListener('click', function () {
    applySettings().catch(showError);
  });
  $('resetColumnOrder').addEventListener('click', resetColumnOrder);

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