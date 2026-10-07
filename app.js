(function () {
  'use strict';

  let worksheet = null;

  const $ = (id) => document.getElementById(id);

  function setMessage(text, type) {
    const el = $('message');
    el.textContent = text || '';
    el.className = 'message';
    if (type) el.classList.add('is-' + type);
    el.style.display = text ? '' : 'none';
  }

  function setInitialUi() {
    $('prev').disabled = true;
    $('next').disabled = true;
    $('refreshFilter').disabled = true;
    $('refreshFilter').textContent = 'Viz Extension';
    $('page').textContent = '-';
  }

  async function initialize() {
    setInitialUi();
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

    $('status').textContent = 'Worksheet: ' + worksheet.name;
    setMessage(
      'Viz Extension の初期化に成功しました。200行ページングは次のタスクで実装します。'
    );

    console.log('tabsdk-data-viewer initialized as Viz Extension', {
      worksheetName: worksheet.name
    });
  }

  function showError(error) {
    console.error(error);
    setMessage(
      error && error.message ? error.message : String(error),
      'error'
    );
  }

  initialize().catch(showError);
})();