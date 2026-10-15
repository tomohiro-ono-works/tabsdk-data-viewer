(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const log = [];
  let worksheet = null;
  let armedAt = null;
  let armedIso = null;
  let eventCount = 0;
  let probing = false;
  let eventVersion = 0;
  let configuredFields = 0;
  const stamp = () => new Date().toISOString();
  const now = () => performance.now();
  const ms = n => Math.round(n * 10) / 10;
  const clean = v => String(v == null ? "" : v).replace(/[\t\r\n]/g, " ");
  const add = (kind, detail, duration = "", extra = "") => {
    log.push({time: stamp(), kind, detail, duration, extra});
    if (log.length > 100) log.shift();
    $('logs').textContent = log.map(x => x.time + " | " + x.kind +
      " | " + x.detail + (x.duration === "" ? "" : " | " + x.duration + " ms") +
      (x.extra === "" ? "" : " | " + x.extra)).join("\n");
  };
  const measured = async (label, fn) => {
    const started = now();
    try {
      const result = await fn();
      add("API", label + " OK", ms(now() - started));
      return result;
    } catch (error) {
      add("ERROR", label + " FAILED", ms(now() - started), error.message || error);
      throw error;
    }
  };
  function extractFields(spec) {
    // The visual specification can vary by Tableau release; do not assume
    // that missing/unrecognised metadata means the worksheet is configured.
    const specs = spec && spec.marksSpecifications;
    if (!Array.isArray(specs)) return null;
    let result = [];
    for (const mark of specs) {
      for (const enc of mark.encodings || []) {
        if (enc.id !== "probe") continue;
        for (const f of enc.fields || []) result.push(f);
        if (enc.field) result.push(enc.field);
      }
    }
    return result;
  }
  async function checkFields() {
    if (!worksheet) return;
    try {
      const spec = await measured("getVisualSpecificationAsync", () =>
        worksheet.getVisualSpecificationAsync());
      const fields = extractFields(spec);
      configuredFields = fields ? fields.length : -1;
      $('mapping').textContent = fields === null ? "API応答を確認してください" :
        fields.length + " 個" + (fields.length === 1 ? "（検証可）" : "（1個にしてください）");
      $('probe').disabled = !fields || fields.length !== 1 || probing;
      add("INFO", "検証用メジャー割当数", "", fields === null ? "不明" : fields.length);
    } catch (error) {
      $('mapping').textContent = "確認エラー";
      $('probe').disabled = true;
    }
  }
  function changed(type) {
    ++eventCount;
    ++eventVersion;
    add("EVENT", type, "", "イベント回数=" + eventCount);
    if (armedAt !== null) {
      const diff = ms(now() - armedAt);
      $('wait').textContent = (diff / 1000).toFixed(2) + " 秒";
      add("WALL", "操作前記録から " + type + " まで", diff, "記録=" + armedIso);
      armedAt = null;
    }
    $('status').textContent = "データ変更を検知";
    // Some Tableau releases may emit multiple change events for one edit.
    // Do not touch underlying data automatically on those events.
    checkFields().catch(e => add("ERROR", "fields", "", e.message || e));
  }
  async function runProbe() {
    if (!worksheet || probing || configuredFields !== 1) return;
    probing = true;
    $('probe').disabled = true;
    $('rows').textContent = "測定中";
    const started = now();
    const version = eventVersion;
    let reader = null;
    try {
      const tables = await measured("getUnderlyingTablesAsync", () =>
        worksheet.getUnderlyingTablesAsync());
      if (!Array.isArray(tables) || !tables.length) {
        throw new Error("対象の論理テーブルが取得できませんでした。");
      }
      const names = tables.map(x => x.caption || "(名称なし)");
      $('tables').textContent = names.join(" / ");
      add("INFO", "論理テーブル数", "", names.length);
      if (tables.length !== 1) {
        throw new Error("論理テーブルが複数あります。曖昧なテーブル選択を避けるため取得を中止しました。");
      }
      reader = await measured("getUnderlyingTableDataReaderAsync(1000)", () =>
        worksheet.getUnderlyingTableDataReaderAsync(tables[0].id, 1000));
      add("INFO", "Reader準備", "", "総行数=" + reader.totalRowCount +
        " / ページ数=" + reader.pageCount);
      $('rows').textContent = Number(reader.totalRowCount).toLocaleString() + " 行";
      if (reader.pageCount > 0) {
        const data = await measured("Underlying.getPageAsync(0)", () => reader.getPageAsync(0));
        add("INFO", "最初のページ（値は出力しません）", "",
          "行数=" + data.data.length + " / 列数=" + data.columns.length);
      }
      if (version !== eventVersion) {
        $('status').textContent = "測定中にデータ変更。結果は無効";
        add("WARNING", "測定中にデータ変更を検知しました。結果は再計測が必要");
      } else {
        $('status').textContent = "検証取得完了（本番表示との一致は未判定）";
      }
    } catch (error) {
      $('status').textContent = "Underlying取得エラー";
      add("ERROR", "Underlying検証中止", "", error.message || error);
    } finally {
      if (reader) {
        try { await measured("reader.releaseAsync", () => reader.releaseAsync()); }
        catch (error) { add("ERROR", "releaseAsync", "", error.message || error); }
      }
      add("TOTAL", "手動Underlying取得検証", ms(now() - started));
      probing = false;
      await checkFields();
    }
  }
  async function initialize() {
    const started = now();
    try {
      await measured("extensions.initializeAsync", () =>
        tableau.extensions.initializeAsync());
      worksheet = tableau.extensions.worksheetContent?.worksheet;
      if (!worksheet) throw new Error("Viz ExtensionのWorksheetコンテキストがありません。");
      worksheet.addEventListener(
        tableau.TableauEventType.SummaryDataChanged,
        () => changed("summary-data-changed"));
      worksheet.addEventListener(
        tableau.TableauEventType.FilterChanged,
        () => changed("filter-changed"));
      add("INFO", "イベントリスナー登録");
      await checkFields();
      $('status').textContent = "準備完了";
      add("TOTAL", "拡張初期化", ms(now() - started));
    } catch (error) {
      $('status').textContent = "初期化エラー";
      add("ERROR", "初期化", "", error.message || error);
    }
  }
  $('arm').addEventListener('click', () => {
    armedAt = now();
    armedIso = stamp();
    $('wait').textContent = "計測中";
    add("MARK", "フィールド操作前の時刻を記録", "", armedIso);
  });
  $('probe').addEventListener('click', () => { runProbe().catch(error => add("ERROR", "取得", "", error)); });
  $('copy').addEventListener('click', () => {
    const rows = [["種類", "時刻", "区間", "所要時間ms", "備考"].join("\t")]
      .concat(log.map(x => [x.kind,x.time,x.detail,x.duration,x.extra].map(clean).join("\t")));
    const input = document.createElement('textarea');
    input.value = rows.join("\r\n");
    input.style.cssText = "position:fixed;left:8px;top:8px;width:1px;height:1px;opacity:.01";
    document.body.appendChild(input);
    try {
      input.focus();
      input.select();
      const copied = document.execCommand('copy');
      $('copyStatus').textContent = copied ? "計測ログをコピーしました" : "コピーに失敗しました";
    } finally { input.remove(); }
  });
  $('clear').addEventListener('click', () => {
    log.length = 0;
    $('logs').textContent = "記録なし";
  });
  initialize();
})();