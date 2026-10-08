(function () {
  'use strict';

  const PAGE_SIZE = 200;
  const AUTO_REFRESH_DELAY_MS = 150;
  const ENCODING_ORDER = ['rows', 'label'];
  const COLUMN_WIDTHS_KEY = 'columnWidthsV1';
  const DEFAULT_COLUMN_WIDTH = 160;
  const MIN_COLUMN_WIDTH = 80;
  const MAX_COLUMN_WIDTH = 420;
  const COLUMN_HORIZONTAL_PADDING = 24;

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
  let textMeasureContext = null;

  const $ = (id) => document.getElementById(id);

  function setMessage(text, type) {
    const el = $('message');
    el.textContent = text || '';
    el.className = 'message';
    if (type) el.classList.add('is-' + type);
    el.style.display = text ? '' : 'none';
  }

  function setBusy(busy) {
    $('refreshData').disabled = busy;
    $('prev').disabled = busy || !reader || pageIndex <= 0;
    $('next').disabled =
      busy || !reader || pageIndex >= reader.pageCount - 1;
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

    const fragment = document.createDocumentFragment();

    dataTable.data.forEach((row) => {
      const tr = document.createElement('tr');

      displayColumns.forEach(({ cellIndex }, displayIndex) => {
        const td = document.createElement('td');
        td.classList.add(alignmentClasses[displayIndex]);
        td.textContent = displayValue(row[cellIndex]);
        tr.appendChild(td);
      });

      fragment.appendChild(tr);
    });

    tbody.appendChild(fragment);

    return displayColumns.length;
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
  });

  initialize().catch(showError);
})();