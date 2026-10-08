(function () {
  'use strict';

  const PAGE_SIZE = 200;
  const AUTO_REFRESH_DELAY_MS = 150;
  const ENCODING_ORDER = ['rows', 'label'];
  const DROPDOWN_CACHE_KEY = 'dropdownCandidateCacheV1';
  const DROPDOWN_CANDIDATE_LIMIT = 100;

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
  let dropdownCandidateCache = {};
  let lastDataTable = null;

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

  function classifyColumn(column, dataTable, cellIndex) {
    const dataType = normalizeDataType(column);

    if (
      dataType.includes('int') ||
      dataType.includes('float') ||
      dataType.includes('double') ||
      dataType.includes('decimal') ||
      dataType.includes('number') ||
      dataType.includes('numeric')
    ) {
      return 'number';
    }

    if (dataType.includes('date') || dataType.includes('time')) {
      return 'date';
    }

    if (dataType.includes('bool')) {
      return 'boolean';
    }

    for (const row of dataTable.data) {
      const value = rawValue(row[cellIndex]);

      if (value === null || value === undefined) continue;
      if (typeof value === 'number') return 'number';
      if (typeof value === 'boolean') return 'boolean';
      if (value instanceof Date) return 'date';
      break;
    }

    return 'text';
  }

  function alignmentClass(kind) {
    if (kind === 'number') return 'cell-number';
    if (kind === 'date') return 'cell-date';
    if (kind === 'boolean') return 'cell-boolean';
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

      const column = dataTable.columns[index];
      const cellIndex =
        column.index !== undefined && column.index !== null
          ? column.index
          : index;

      usedIndexes.add(index);
      resolved.push({
        column,
        cellIndex,
        fieldName:
          column.fieldName ||
          column.caption ||
          column.name ||
          mappedField.fieldName,
        kind: classifyColumn(column, dataTable, cellIndex)
      });
    });

    return resolved;
  }

  function normalizeDataValue(value) {
    if (!value) {
      return {
        value: null,
        formattedValue: ''
      };
    }

    let native = null;

    if (value.nativeValue !== undefined) {
      native = value.nativeValue;
    } else if (value.value !== undefined) {
      native = value.value;
    }

    return {
      value: native,
      formattedValue:
        value.formattedValue !== undefined && value.formattedValue !== null
          ? String(value.formattedValue)
          : native === null || native === undefined
            ? ''
            : String(native)
    };
  }

  function normalizeFilter(filter) {
    const normalized = {
      fieldName: filter.fieldName || '',
      filterType: filter.filterType || '',
      appliedValues: []
    };

    if (Array.isArray(filter.appliedValues)) {
      normalized.appliedValues =
        filter.appliedValues.map(normalizeDataValue);
    }

    if (filter.minValue) {
      normalized.minValue = normalizeDataValue(filter.minValue);
    }

    if (filter.maxValue) {
      normalized.maxValue = normalizeDataValue(filter.maxValue);
    }

    return normalized;
  }

  function loadDropdownCandidateCache() {
    const raw = tableau.extensions.settings.get(DROPDOWN_CACHE_KEY);

    if (!raw) {
      dropdownCandidateCache = {};
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      dropdownCandidateCache =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed
          : {};
    } catch (error) {
      console.warn('Dropdown candidate cache could not be parsed.', error);
      dropdownCandidateCache = {};
    }
  }

  async function saveDropdownCandidateCache(nextCache) {
    tableau.extensions.settings.set(
      DROPDOWN_CACHE_KEY,
      JSON.stringify(nextCache)
    );

    await tableau.extensions.settings.saveAsync();
    dropdownCandidateCache = nextCache;
  }

  function getDropdownCacheEntry(fieldName) {
    const entry = dropdownCandidateCache[fieldName];

    if (!entry || typeof entry !== 'object') {
      return null;
    }

    return entry;
  }

  function domainValuesFromResult(domain) {
    if (Array.isArray(domain)) {
      return domain;
    }

    if (domain && Array.isArray(domain.values)) {
      return domain.values;
    }

    if (domain && Array.isArray(domain.domainValues)) {
      return domain.domainValues;
    }

    return [];
  }

  function normalizeCandidate(value) {
    const normalized = normalizeDataValue(value);

    return {
      value: normalized.value,
      formattedValue: normalized.formattedValue
    };
  }

  function candidateKey(candidate) {
    if (candidate.value === null || candidate.value === undefined) {
      return '__NULL__';
    }

    return typeof candidate.value + ':' + String(candidate.value);
  }

  async function fetchDropdownCandidates(fieldName) {
    const rawFilters = await worksheet.getFiltersAsync();

    const categoricalFilter = rawFilters.find((filter) => {
      return (
        filter &&
        filter.fieldName === fieldName &&
        String(filter.filterType || '').toLowerCase() === 'categorical' &&
        typeof filter.getDomainAsync === 'function'
      );
    });

    if (!categoricalFilter) {
      throw new Error(
        '候補値をTableau側で取得するには「' +
          fieldName +
          '」をTableauのフィルター棚に追加してください（「すべて」のままで構いません）。'
      );
    }

    const domainType =
      tableau.FilterDomainType && tableau.FilterDomainType.Database
        ? tableau.FilterDomainType.Database
        : 'database';

    const domain = await categoricalFilter.getDomainAsync(domainType);
    const rawValues = domainValuesFromResult(domain);
    const candidates = [];
    const seen = new Set();

    for (const value of rawValues) {
      const candidate = normalizeCandidate(value);
      const key = candidateKey(candidate);

      if (seen.has(key)) continue;

      seen.add(key);
      candidates.push(candidate);

      if (candidates.length > DROPDOWN_CANDIDATE_LIMIT) {
        break;
      }
    }

    const isLimited =
      !!(domain && domain.isDomainLimited === true);

    const tooMany =
      candidates.length > DROPDOWN_CANDIDATE_LIMIT || isLimited;

    const nextEntry = tooMany
      ? {
          status: 'too-many',
          count: DROPDOWN_CANDIDATE_LIMIT + 1,
          values: [],
          updatedAt: new Date().toISOString()
        }
      : {
          status: 'ready',
          count: candidates.length,
          values: candidates,
          updatedAt: new Date().toISOString()
        };

    const nextCache = Object.assign({}, dropdownCandidateCache, {
      [fieldName]: nextEntry
    });

    await saveDropdownCandidateCache(nextCache);

    return nextEntry;
  }

  async function refreshDropdownCandidates(fieldName) {
    const previousEntry = getDropdownCacheEntry(fieldName);

    try {
      return await fetchDropdownCandidates(fieldName);
    } catch (error) {
      if (previousEntry) {
        console.warn(
          'Candidate refresh failed. Existing cache was preserved.',
          error
        );
      }

      throw error;
    }
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

  function findFilter(fieldName) {
    return filterState.find((filter) => filter.fieldName === fieldName);
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

  async function applyRangeFilter(fieldName, minValue, maxValue) {
    if (!fieldName) {
      throw new Error('フィルター対象フィールドが指定されていません。');
    }

    const options = {};

    if (minValue !== null && minValue !== undefined) {
      options.min = minValue;
    }

    if (maxValue !== null && maxValue !== undefined) {
      options.max = maxValue;
    }

    if (!Object.keys(options).length) {
      await clearFieldFilter(fieldName);
      return;
    }

    await worksheet.applyRangeFilterAsync(fieldName, options);
    scheduleRefresh('extension-filter-changed');
  }

  async function clearFieldFilter(fieldName) {
    if (!fieldName) {
      throw new Error('フィルター対象フィールドが指定されていません。');
    }

    await worksheet.clearFilterAsync(fieldName);
    scheduleRefresh('extension-filter-changed');
  }

  function toNumberOrNull(value) {
    if (value === '') return null;

    const number = Number(value);

    if (!Number.isFinite(number)) {
      throw new Error('数値フィルターに正しい数値を入力してください。');
    }

    return number;
  }

  function parseDateInput(value, endOfDay) {
    if (!value) return null;

    const parts = value.split('-').map(Number);

    if (
      parts.length !== 3 ||
      !Number.isInteger(parts[0]) ||
      !Number.isInteger(parts[1]) ||
      !Number.isInteger(parts[2])
    ) {
      throw new Error('日付フィルターに正しい日付を入力してください。');
    }

    return new Date(
      Date.UTC(
        parts[0],
        parts[1] - 1,
        parts[2],
        endOfDay ? 23 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 999 : 0
      )
    );
  }

  function toDateInputValue(value) {
    if (value === null || value === undefined || value === '') {
      return '';
    }

    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
      return '';
    }

    return date.toISOString().slice(0, 10);
  }

  function createButton(text, className, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.className = className;
    button.addEventListener('click', handler);
    return button;
  }

  function runFilterAction(action) {
    setBusy(true);
    setMessage('フィルターを適用しています...', 'loading');

    Promise.resolve()
      .then(action)
      .catch(showError);
  }

  function rerenderCurrentTable() {
    if (lastDataTable) {
      renderTable(lastDataTable);
    }
  }

  function createDropdownFilter(columnInfo, cacheEntry) {
    const wrapper = document.createElement('div');
    wrapper.className = 'filter-control filter-dropdown-control';

    const select = document.createElement('select');
    select.className = 'filter-input filter-dropdown-select';

    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'すべて';
    select.appendChild(allOption);

    cacheEntry.values.forEach((candidate, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent =
        candidate.formattedValue ||
        (candidate.value === null || candidate.value === undefined
          ? '(Null)'
          : String(candidate.value));
      select.appendChild(option);
    });

    const active = findFilter(columnInfo.fieldName);

    if (
      active &&
      active.filterType === 'categorical' &&
      active.appliedValues.length === 1
    ) {
      const activeKey = candidateKey({
        value: active.appliedValues[0].value
      });

      const selectedIndex = cacheEntry.values.findIndex(
        (candidate) => candidateKey(candidate) === activeKey
      );

      if (selectedIndex >= 0) {
        select.value = String(selectedIndex);
      }
    }

    select.addEventListener('change', () => {
      runFilterAction(() => {
        if (select.value === '') {
          return clearFieldFilter(columnInfo.fieldName);
        }

        const candidate =
          cacheEntry.values[Number(select.value)];

        if (!candidate) {
          throw new Error('選択した候補値を取得できません。');
        }

        return applyCategoricalFilter(
          columnInfo.fieldName,
          [candidate.value]
        );
      });
    });

    const refreshButton = createButton(
      '↻',
      'filter-candidate-button',
      () => {
        setBusy(true);
        setMessage('候補値を再取得しています...', 'loading');

        refreshDropdownCandidates(columnInfo.fieldName)
          .then((entry) => {
            rerenderCurrentTable();

            setMessage(
              entry.status === 'ready'
                ? '「' +
                    columnInfo.fieldName +
                    '」の候補値 ' +
                    entry.count +
                    ' 件をWorkbookに保存しました。'
                : '「' +
                    columnInfo.fieldName +
                    '」は候補値が101件以上のため、テキストフィルターを使用します。'
            );

            setBusy(false);
          })
          .catch(showError);
      }
    );
    refreshButton.title = '候補値を再取得';

    wrapper.appendChild(select);
    wrapper.appendChild(refreshButton);

    return wrapper;
  }

  function createTextFilter(columnInfo) {
    const cacheEntry = getDropdownCacheEntry(columnInfo.fieldName);

    if (
      cacheEntry &&
      cacheEntry.status === 'ready' &&
      Array.isArray(cacheEntry.values)
    ) {
      return createDropdownFilter(columnInfo, cacheEntry);
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'filter-control filter-text-control';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'filter-input';
    input.placeholder = '完全一致';

    const active = findFilter(columnInfo.fieldName);

    if (
      active &&
      active.filterType === 'categorical' &&
      active.appliedValues.length === 1
    ) {
      input.value =
        active.appliedValues[0].value === null ||
        active.appliedValues[0].value === undefined
          ? ''
          : String(active.appliedValues[0].value);
    }

    const apply = () => {
      const value = input.value.trim();

      runFilterAction(() =>
        value
          ? applyCategoricalFilter(columnInfo.fieldName, [value])
          : clearFieldFilter(columnInfo.fieldName)
      );
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        apply();
      }
    });

    wrapper.appendChild(input);
    wrapper.appendChild(
      createButton('適用', 'filter-button', apply)
    );

    const candidateButton = createButton(
      cacheEntry && cacheEntry.status === 'too-many'
        ? '101+'
        : '候補',
      'filter-candidate-button',
      () => {
        setBusy(true);
        setMessage('候補値を取得しています...', 'loading');

        refreshDropdownCandidates(columnInfo.fieldName)
          .then((entry) => {
            rerenderCurrentTable();

            setMessage(
              entry.status === 'ready'
                ? '「' +
                    columnInfo.fieldName +
                    '」の候補値 ' +
                    entry.count +
                    ' 件をWorkbookに保存しました。'
                : '「' +
                    columnInfo.fieldName +
                    '」は候補値が101件以上のため、テキストフィルターを使用します。'
            );

            setBusy(false);
          })
          .catch(showError);
      }
    );

    candidateButton.title =
      cacheEntry && cacheEntry.status === 'too-many'
        ? '候補値を再取得（現在は101件以上）'
        : 'Tableau側からDistinct候補値を取得';

    wrapper.appendChild(candidateButton);
    wrapper.appendChild(
      createButton('×', 'filter-clear', () => {
        input.value = '';
        runFilterAction(() =>
          clearFieldFilter(columnInfo.fieldName)
        );
      })
    );

    return wrapper;
  }

  function createNumberFilter(columnInfo) {
    const wrapper = document.createElement('div');
    wrapper.className = 'filter-control filter-range-control';

    const minInput = document.createElement('input');
    const maxInput = document.createElement('input');

    minInput.type = 'number';
    maxInput.type = 'number';
    minInput.className = 'filter-input filter-range-input';
    maxInput.className = 'filter-input filter-range-input';
    minInput.placeholder = '下限';
    maxInput.placeholder = '上限';

    const active = findFilter(columnInfo.fieldName);

    if (active && active.filterType === 'range') {
      if (active.minValue && active.minValue.value !== null) {
        minInput.value = String(active.minValue.value);
      }

      if (active.maxValue && active.maxValue.value !== null) {
        maxInput.value = String(active.maxValue.value);
      }
    }

    const apply = () => {
      runFilterAction(() => {
        const min = toNumberOrNull(minInput.value);
        const max = toNumberOrNull(maxInput.value);

        if (min !== null && max !== null && min > max) {
          throw new Error('数値フィルターは下限を上限以下にしてください。');
        }

        return applyRangeFilter(columnInfo.fieldName, min, max);
      });
    };

    [minInput, maxInput].forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          apply();
        }
      });
    });

    wrapper.appendChild(minInput);
    wrapper.appendChild(maxInput);
    wrapper.appendChild(
      createButton('適用', 'filter-button', apply)
    );
    wrapper.appendChild(
      createButton('×', 'filter-clear', () => {
        minInput.value = '';
        maxInput.value = '';
        runFilterAction(() =>
          clearFieldFilter(columnInfo.fieldName)
        );
      })
    );

    return wrapper;
  }

  function createDateFilter(columnInfo) {
    const wrapper = document.createElement('div');
    wrapper.className = 'filter-control filter-range-control';

    const minInput = document.createElement('input');
    const maxInput = document.createElement('input');

    minInput.type = 'date';
    maxInput.type = 'date';
    minInput.className = 'filter-input filter-date-input';
    maxInput.className = 'filter-input filter-date-input';

    const active = findFilter(columnInfo.fieldName);

    if (active && active.filterType === 'range') {
      if (active.minValue) {
        minInput.value = toDateInputValue(active.minValue.value);
      }

      if (active.maxValue) {
        maxInput.value = toDateInputValue(active.maxValue.value);
      }
    }

    const apply = () => {
      runFilterAction(() => {
        const min = parseDateInput(minInput.value, false);
        const max = parseDateInput(maxInput.value, true);

        if (min && max && min.getTime() > max.getTime()) {
          throw new Error('日付フィルターは開始日を終了日以前にしてください。');
        }

        return applyRangeFilter(columnInfo.fieldName, min, max);
      });
    };

    [minInput, maxInput].forEach((input) => {
      input.addEventListener('change', apply);
    });

    wrapper.appendChild(minInput);
    wrapper.appendChild(maxInput);
    wrapper.appendChild(
      createButton('×', 'filter-clear', () => {
        minInput.value = '';
        maxInput.value = '';
        runFilterAction(() =>
          clearFieldFilter(columnInfo.fieldName)
        );
      })
    );

    return wrapper;
  }

  function createBooleanFilter(columnInfo) {
    const wrapper = document.createElement('div');
    wrapper.className = 'filter-control filter-boolean-control';

    const select = document.createElement('select');
    select.className = 'filter-input';

    [
      ['', 'すべて'],
      ['true', 'True'],
      ['false', 'False']
    ].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    });

    const active = findFilter(columnInfo.fieldName);

    if (
      active &&
      active.filterType === 'categorical' &&
      active.appliedValues.length === 1
    ) {
      const value = active.appliedValues[0].value;

      if (value === true || String(value).toLowerCase() === 'true') {
        select.value = 'true';
      } else if (
        value === false ||
        String(value).toLowerCase() === 'false'
      ) {
        select.value = 'false';
      }
    }

    select.addEventListener('change', () => {
      runFilterAction(() => {
        if (select.value === '') {
          return clearFieldFilter(columnInfo.fieldName);
        }

        return applyCategoricalFilter(
          columnInfo.fieldName,
          [select.value === 'true']
        );
      });
    });

    wrapper.appendChild(select);

    return wrapper;
  }

  function createFilterControl(columnInfo) {
    if (columnInfo.kind === 'number') {
      return createNumberFilter(columnInfo);
    }

    if (columnInfo.kind === 'date') {
      return createDateFilter(columnInfo);
    }

    if (columnInfo.kind === 'boolean') {
      return createBooleanFilter(columnInfo);
    }

    return createTextFilter(columnInfo);
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
    headerRow.className = 'column-header-row';

    displayColumns.forEach((columnInfo) => {
      const th = document.createElement('th');
      th.textContent = columnInfo.fieldName;
      headerRow.appendChild(th);
    });

    thead.appendChild(headerRow);

    const filterRow = document.createElement('tr');
    filterRow.className = 'filter-row';

    displayColumns.forEach((columnInfo) => {
      const th = document.createElement('th');
      th.appendChild(createFilterControl(columnInfo));
      filterRow.appendChild(th);
    });

    thead.appendChild(filterRow);

    const fragment = document.createDocumentFragment();

    dataTable.data.forEach((row) => {
      const tr = document.createElement('tr');

      displayColumns.forEach((columnInfo) => {
        const td = document.createElement('td');
        td.classList.add(alignmentClass(columnInfo.kind));
        td.textContent = displayValue(row[columnInfo.cellIndex]);
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
    lastDataTable = dataTable;
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

    loadDropdownCandidateCache();

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

  window.tabsdkDataViewerFilters = Object.freeze({
    getFilters: getWorksheetFilters,
    applyCategoricalFilter,
    applyRangeFilter,
    clearFilter: clearFieldFilter,
    refreshDropdownCandidates,
    getDropdownCacheEntry
  });
})();