# tabsdk-data-viewer

Tableau Viz Extension（Worksheet Extension）用の大容量帳票ビューアです。

## 実装済み

### タスク1: Viz Extension化
- `worksheet-extension` マニフェスト
- `tableau.extensions.worksheetContent.worksheet` を利用

### タスク2: 200行ページング
- `getSummaryDataReaderAsync(200)`
- `getPageAsync()`
- 前へ / 次へ
- 総件数 / 総ページ数
- `releaseAsync()`
- `SummaryDataChanged` 時にReaderを再生成

### タスク3: フィールドから表列へのマッピング
- Viz Extensionに「行」「ラベル」のフィールド置き場
- 表示順は「行」→「ラベル」
- Tableau側のフィールド順を維持
- `formattedValue` を優先
- Nullは空欄
- 文字列は左寄せ
- 数値は右寄せ
- 日付 / Booleanは中央寄せ

### タスク4: フィルター基盤
- `FilterChanged` を監視
- Tableau標準フィルター変更時にReaderを破棄・再生成
- フィルター変更後は1ページ目へ戻る
- `SummaryDataChanged` と `FilterChanged` の再取得をデバウンス
- 現在のWorksheetフィルター状態を取得
- カテゴリフィルター共通関数
  - `applyFilterAsync(..., FilterUpdateType.Replace)`
  - `clearFilterAsync()`
- 現在のフィルター数をステータス表示
- タスク5用に共通フィルターAPIを用意

## 目標構成

```text
BigQuery / CSV / Excel / DB
          ↓
       Tableau
          ↓
      Worksheet
          ↓
     Viz Extension
          ↓
 DataTableReader
  200 rows/page
          ↓
 tabsdk-data-viewer
```

## 次の予定

- Extension内フィルターUI
- プルダウン候補値キャッシュ
- 列幅・列順・固定列設定
- 通常 / 棒グラフ / ヒートマップ
- ソート
- CSV / Clipboard / Excel エクスポート
- 設定のWorkbook保存
