(function () {
  'use strict';

  const PAGE_SIZE = 200;
  const AUTO_REFRESH_DELAY_MS = 150;
  const ENCODING_ORDER = ['rows', 'label'];

  let worksheet = null;
  let reader = null;
  let pageIndex = 0;
  let removeSummaryListener = null;
  let removeFilterListener = null;
  let refreshTimer = null;
  let pendingRefreshReason = 'initial';
  let generation = 0;
  let mappedFields = [];
  let filterState = [];

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

  function renderTable(dataTable) {
    const table = $('dataTable');
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');

    thead.innerHTML = '';
    tbody.innerHTML = '';

    const displayColumns = resolveDisplayColumns(dataTable);

    if (!displayColumns.length) {
      return 0;
    }

    const headerRow = document.createElement('tr');

    displayColumns.forEach(({ column, fieldName }) => {
      const th = document.createElement('th');
      th.textContent =
        column.fieldName ||
        column.caption ||
        column.name ||
        fieldName;
      headerRow.appendChild(th);
    });

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
    table.querySelector('thead').innerHTML = '';
    table.querySelector('tbody').innerHTML = '';
  }

  function normalizeFilter(filter) {
    const normalized = {
      fieldName: filter.fieldName || '',
      filterType: filter.filterType || '',
      appliedValues: []
    };

    if (Array.isArray(filter.appliedValues)) {
      normalized.appliedValues = filter.appliedValues.map((value) => ({
        value:
          value && value.value !== undefined
            ? value.value
            : null,
        formattedValue:
          value && value.formattedValue !== undefined
            ? value.formattedValue
            : ''
      }));
    }

    if (filter.minValue) {
      normalized.minValue = {
        value:
          filter.minValue.value !== undefined
            ? filter.minValue.value
            : null,
        formattedValue:
          filter.minValue.formattedValue !== undefined
            ? filter.minValue.formattedValue
            : ''
      };
    }

    if (filter.maxValue) {
      normalized.maxValue = {
        value:
          filter.maxValue.value !== undefined
            ? filter.maxValue.value
            : null,
        formattedValue:
          filter.maxValue.formattedValue !== undefined
            ? filter.maxValue.formattedValue
            : ''
      };
    }

    return normalized;
  }

  async function getWorksheetFilters() {
    const filters = await worksheet.getFiltersAsync();
    return filters.map(normalizeFilter);
  }

  async function refreshFilterState() {
    try {
      filterState = await getWorksheetFilters();
    } catch (error) {
      console.warn('getFiltersAsync failed', error);
      filterState = [];
    }
  }

  async function applyCategoricalFilter(fieldName, values) {
    if (!fieldName) {
      throw new Error('フィルター対象フィールドが指定されていません。');
    }

    const normalizedValues = Array.isArray(values)
      ? values.filter((value) => value !== null && value !== undefined)
      : [];

    if (!normalizedValues.length) {
      await clearFieldFilter(fieldName);
      return;
    }

    await worksheet.applyFilterAsync(
      fieldName,
      normalizedValues,
      tableau.FilterUpdateType.Replace
    );

    scheduleRefresh('extension-filter-changed');
  }

  async function clearFieldFilter(fieldName) {
    if (!fieldName) {
      throw new Error('フィルター対象フィールドが指定されていません。');
    }

    await worksheet.clearFilterAsync(fieldName);
    scheduleRefresh('extension-filter-changed');
  }

  function updatePager() {
    const filterText =
      filterState.length > 0
        ? ' / フィルター ' + filterState.length
        : '';

    if (!reader) {
      $('status').textContent =
        mappedFields.length > 0
          ? mappedFields.length + ' 列' + filterText
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
      ' 行/ページ' +
      filterText;

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

    const isFilterRefresh =
      reason === 'filter-changed' ||
      reason === 'extension-filter-changed';

    setMessage(
      isFilterRefresh
        ? 'フィルター変更を反映しています...'
        : reason === 'summary-data-changed'
          ? 'データ変更を反映しています...'
          : 'データを読み込んでいます...',
      'loading'
    );

    await releaseReader();

    if (currentGeneration !== generation) return;

    mappedFields = await getMappedFields();

    if (currentGeneration !== generation) return;

    await refreshFilterState();

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

  // Task 5 will connect the filter UI to these shared functions.
  window.tabsdkDataViewerFilters = Object.freeze({
    getFilters: getWorksheetFilters,
    applyCategoricalFilter,
    clearFilter: clearFieldFilter
  });
})();