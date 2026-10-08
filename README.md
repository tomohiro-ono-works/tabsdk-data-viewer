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

- Viz Extensionに「行」「ラベル」のフィールド置き場を用意
- 表示順は「行」→「ラベル」
- 各置き場内ではTableau側のフィールド順を維持
- 表示値はTableauの `formattedValue` を優先
- Nullは空欄
- 文字列は左寄せ
- 数値は右寄せ
- 日付 / Booleanは中央寄せ

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

- Tableauフィルター連動基盤
- Extension内フィルター
- 列幅・列順・固定列設定
- 通常 / 棒グラフ / ヒートマップ
- CSV / Clipboard / Excel エクスポート
- 設定のWorkbook保存
