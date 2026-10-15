# Tableau Data Viewer — 本番版の所在と33秒レイアウト計算のAPI調査（2026-10-15）

## 1. 本番基準の固定

本番用はGitHub `main` のリポジトリ直下の以下4ファイル。
- `tabsdk-data-viewer.trex` — `extension-version="0.15.0"`, extension ID `com.example.tabsdk-data-viewer`
- `index.html`
- `app.js`
- `app.css`

本番URL: https://tomohiro-ono-works.github.io/tabsdk-data-viewer/

確認時点の本番ファイル blob SHA:
- `tabsdk-data-viewer.trex`: `e50dcdddda18e5b9c367394d2613ceb25969ca70`
- `index.html`: `b830190acadbe9088a2ae19bc85c2a228e9f346f`
- `app.js`: `1642aacb55e92481033f7adf3af68863be0fdcb6`
- `app.css`: `eb4417d68fc238f8d62472cc09d8a3f3e76767f0`

`preview/`以下は独立した検証版。V10〜V15を本番と取り違えない。特にV14とV15は本番に未反映。本書のコミットでは本番コード・TREX・既存プレビューを変更しない。

## 2. 既存仕様と計測の基準

50万行×15列のExcelをTableau Public Desktopで使用。ユーザー観測のレイアウト計算: **33秒**。V14のReader生成、先頭1,000行取得、200行DOM表示を含むイベント後の処理: 約**1.53秒**（同条件を完全固定した比較ではない）。最適化対象はレイアウト計算区間であり、単なるReaderページ移動ではない。

現行本番 `app.js` では、`worksheet.getSummaryDataReaderAsync(PAGE_SIZE=200,{ignoreSelection:true,applyWorksheetFormatting:true})` を利用し、`SummaryDataChanged` / `FilterChanged` を監視。CSVは別Readerを5,000行単位で使用。データ表示には`formattedValue`を優先し、Tableau側のフィルターおよび行・列の意味論に依存する。

**維持が必要な性質:** 15列・フィールド対応、50万行の閲覧／ページング、同じ業務フィルター結果、集計・計算フィールド・行順・書式の整合性、既存の列幅・固定列・複数段ヘッダー・色・セルコピー・CSV。仕様の縮小や権限変更は事前合意が必要。

## 3. APIごとの成立性

### A. Worksheet.getSummaryDataReaderAsync（現行、本命の整合性あり）
- TableauのワークシートのSummary（集計後・ビュー結果）をページで取得できる。
- ワークシートに割り当てたフィールドとTableauで確定した結果を利用できるので、**現行仕様の再現には最も近い**。
- しかし `pageRowCount` はReader APIの返却ページサイズであり、Tableauにビュー全体のレイアウト計算を省略させる指定ではない。`200→1000`に変えるだけで33秒が減る根拠はない（V14でも長い待機が残った）。
- Tableau公式ドキュメントには「元の15列を維持しながら、ビューのレイアウト計算だけを省略するSummary Reader指定」は確認できなかった。**不可能だと証明されたわけではない。**

### B. Worksheet.getUnderlyingTableDataReaderAsync（明細の取得は可能、等価性は未確認）
- ワークシートに関連する論理テーブルの「Underlying（基礎データ）」を取得。50万行は標準行数上限100万行の範囲内（ほかの制約・権限は残る）。
- `getUnderlyingTablesAsync`が返す論理テーブルはワークシートで参照するメジャーに依存。1つの集計メジャーだけを割り当てた軽量Vizで、元の15列、複数論理テーブル、計算フィールドを再現できる保証はない。
- `applyWorksheetFormatting`が利用できる環境では、数値・日付のワークシート書式をAPI側で適用可能。ただし、Summaryでの集計、表計算、行順、現在のフィルターと完全一致する保証にはならない。
- Underlyingデータ取得にはマニフェストへのFull Data権限の宣言とユーザー許可が必要。既存本番では要求していないため、**無承認の切替は不可**。
- 同等のビュー結果を計算済みで取得するAPIとは異なる。JS側への集計移管には全明細の読み込み・処理費用が発生する。33秒の代替になり得るか未計測。

### C. Datasource.getLogicalTableDataReaderAsync（データソースの論理明細）
- データソースの論理テーブル明細をページ取得する経路は存在する。
- ワークシートのフィルター適用結果・集計・表計算・ビューの並び順と自動的に一致することを前提にはできない。権限・データモデルと追加処理の影響もある。
- 現行の「Tableau標準フィルターを使って確定した表示結果」をそのまま返す代替APIとは評価できない。

### D. Worksheet.getSummaryDataAsync(maxRows:200)（旧API、V13で検証済）
- `getSummaryDataAsync`はdeprecated。V13の限定先行取得では約1.5〜1.8秒かかり、Reader準備も別途必要で、先行取得の優位性を確認できなかった。
- `maxRows=200`はTableau内部の表レイアウト計算を200行に制限する保証ではない。再検証の優先度は低い。

### E. マーク数の削減／1メジャーのみ
- マーク生成・レイアウト計算の負担を減らす仮説は成立するが、**元の15列の結果を保持したまま減らせることは未証明**。見せる列・集計粒度・計算・フィルターを変更してしまえば採用できない。
- V15は性能切り分け専用で、表・集計・フィルター・ソート・書式の完全な比較はできず、本番置換を承認したものではない。

## 4. 結論と判断ゲート

**調査時点では、現行の15列・フィルター・集計・書式・行順を完全に保ったまま、33秒のレイアウト計算を回避できることが公式API仕様から保証されるデータ取得経路は確認できない。** これは「絶対に実現不可能」という意味ではない。

優先順位：
1. 仕様不変で可能なこと／意味論の変更が必要なことを明確に区別。
2. Underlying採用の検討は、対象列・業務フィルター後の件数/値・集計/計算・順序・書式・Full Data許諾の整合性が設計上確認できてから。
3. 同一50万行×15列・同一条件で、Tableau Performance RecordingのComputing Layoutsと操作後の総待ち時間を比較。Readerだけの数値改善を勝ちとしない。
4. 根拠と合格条件が整うまでは、ユーザーにV15の実験を依頼しない。本番への変更・既存プレビューの変更・権限要求の追加は、事前の明示承認なしに実施しない。

## 5. 公式資料（2026-10-15調査）
- Tableau Extensions API / Getting Data from the Workbook: https://tableau.github.io/extensions-api/docs/core/trex_getdata/
- Tableau Viz Extension manifest and encodings: https://tableau.github.io/extensions-api/docs/vizext/trex_viz_manifest/
- Accessing Underlying Data / full-data permissions: https://tableau.github.io/extensions-api/docs/security/trex_data_access/
- Extensions API release notes / applyWorksheetFormatting: https://tableau.github.io/extensions-api/docs/trex_release-notes/
- Embedding API: Worksheet methods and options (API概念の参照): https://help.tableau.com/current/api/embedding_api/en-us/reference/interfaces/Worksheet.html
- Embedding API: GetUnderlyingDataOptions: https://help.tableau.com/current/api/embedding_api/en-us/reference/interfaces/GetUnderlyingDataOptions.html
- Embedding API: DataSource logical table retrieval: https://help.tableau.com/current/api/embedding_api/en-us/docs/embedding_api_data.html

（Embedding APIとViz Extensions APIは別ライブラリ。比較時に、呼び出し環境の対応バージョンを確認すること。）
