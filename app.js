(function () {
  'use strict';

  const PAGE_SIZE = 200;

  let worksheet = null;
  let reader = null;
  let pageIndex = 0;
  let filterDirty = false;
  let removeFilterListener = null;

  const $ = (id) => document.getElementById(id);

  function setMessage(text, type) {
    const el = $('message');
    el.textContent = text || '';
    el.className = 'message';
    if (type) el.classList.add('is-' + type);
    el.style.display = text ? '' : 'none';
  }

  function setFilterDirty(dirty) {
    filterDirty = dirty;
    const button = $('refreshFilter');
    button.disabled = !dirty;
    button.textContent = dirty ? 'フィルタ未更新' : '更新済';
    button.classList.toggle('is-stale', dirty);
  }

  function normalizeValue(cell) {
    if (!cell) return '';
    let value = cell.nativeValue !== undefined ? cell.nativeValue : cell.value;
    if (value == null) return '';
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }

  function renderTable(dataTable) {
    const thead = $('dataTable').querySelector('thead');
    const tbody = $('dataTable').querySelector('tbody');
    thead.innerHTML = '';
    tbody.innerHTML = '';

    const headerRow = document.createElement('tr');
    dataTable.columns.forEach((column) => {
      const th = document.createElement('th');
      th.textContent = column.fieldName || column.caption || '';
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);

    const fragment = document.createDocumentFragment();

    dataTable.data.forEach((row) => {
      const tr = document.createElement('tr');

      dataTable.columns.forEach((column, index) => {
        const td = document.createElement('td');
        const cellIndex = column.index != null ? column.index : index;
        td.textContent = normalizeValue(row[cellIndex]);
        tr.appendChild(td);
      });

      fragment.appendChild(tr);
    });

    tbody.appendChild(fragment);
  }

  async function releaseReader() {
    if (!reader) return;

    const oldReader = reader;
    reader = null;

    try {
      await oldReader.releaseAsync();
    } catch (error) {
      console.warn('releaseAsync failed', error);
    }
  }

  async function createReader() {
    const tables = await worksheet.getUnderlyingTablesAsync();

    if (!tables.length) {
      throw new Error('Underlying Logical Table がありません。');
    }

    const logicalTable = tables[0];

    reader = await worksheet.getUnderlyingTableDataReaderAsync(
      logicalTable.id,
      PAGE_SIZE,
      {
        ignoreAliases: false,
        ignoreSelection: true
      }
    );
  }

  async function loadPage(nextPage) {
    if (!reader) return;
    if (nextPage < 0 || nextPage >= reader.pageCount) return;

    setMessage('読み込み中...', 'loading');

    const dataTable = await reader.getPageAsync(nextPage);
    pageIndex = nextPage;

    renderTable(dataTable);

    $('status').textContent =
      reader.totalRowCount.toLocaleString() + ' 行 / 1ページ ' + PAGE_SIZE + ' 行';

    $('page').textContent =
      (pageIndex + 1) + ' / ' + reader.pageCount;

    $('prev').disabled = pageIndex <= 0;
    $('next').disabled = pageIndex >= reader.pageCount - 1;

    setMessage('');
  }

  async function refreshForCurrentFilters() {
    setMessage('フィルターを反映中...', 'loading');

    await releaseReader();
    await createReader();
    await loadPage(0);

    setFilterDirty(false);
  }

  async function initialize() {
    await tableau.extensions.initializeAsync();

    const dashboard = tableau.extensions.dashboardContent.dashboard;

    if (!dashboard.worksheets.length) {
      throw new Error('Dashboard に Worksheet がありません。');
    }

    worksheet = dashboard.worksheets[0];

    removeFilterListener = worksheet.addEventListener(
      tableau.TableauEventType.FilterChanged,
      function () {
        setFilterDirty(true);
      }
    );

    await createReader();
    await loadPage(0);
    setFilterDirty(false);
  }

  function showError(error) {
    console.error(error);
    setMessage(error && error.message ? error.message : String(error), 'error');
  }

  $('prev').addEventListener('click', function () {
    loadPage(pageIndex - 1).catch(showError);
  });

  $('next').addEventListener('click', function () {
    loadPage(pageIndex + 1).catch(showError);
  });

  $('refreshFilter').addEventListener('click', function () {
    if (!filterDirty) return;
    refreshForCurrentFilters().catch(showError);
  });

  window.addEventListener('beforeunload', function () {
    try {
      if (removeFilterListener) removeFilterListener();
    } catch (_) {}

    if (reader) {
      reader.releaseAsync().catch(function () {});
    }
  });

  initialize().catch(showError);
})();