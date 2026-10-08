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
- 現在のフィルター数をステータス表示

### タスク5: Extension内フィルターUI
- 各列ヘッダー下にフィルター行を表示
- 文字列: 完全一致入力
- 数値: 下限 / 上限
- 日付: 開始日 / 終了日
- Boolean: True / False / すべて
- 各条件の解除
- 数値・日付範囲は `applyRangeFilterAsync()`
- 文字列・Booleanは `applyFilterAsync()`
- フィルター適用後はReaderを再生成して1ページ目へ戻る
- 文字列の候補プルダウンと候補値キャッシュはタスク6で実装

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
- プルダウン候補値キャッシュ
- 列幅・列順・固定列設定
- 通常 / 棒グラフ / ヒートマップ
- ソート
- CSV / Clipboard / Excel エクスポート
- 設定のWorkbook保存
