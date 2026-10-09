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

### タスク4: Tableau標準フィルター連動
- `FilterChanged` を監視
- Tableau標準フィルター変更時にReaderを破棄・再生成
- フィルター変更後は1ページ目へ戻る
- `SummaryDataChanged` と `FilterChanged` の再取得をデバウンス
- Extension内には独自フィルターUIを持たない

### タスク5-6: 独自フィルターは廃止
- Extension内フィルターUIは削除
- Distinct候補取得・候補キャッシュも削除
- フィルター操作はTableau標準機能に統一

### タスク7-1: 列幅
- 初期幅: 160px
- 現在表示中の200行とヘッダーから必要幅を計算
- 内容が収まらない場合は自動拡張
- 自動拡張・手動変更とも最大420px
- 最小80px
- ページ移動時は自動幅を縮めず、必要なら追加で拡張
- 列境界をマウス / タッチでドラッグして手動変更
- 手動変更後は自動拡張より優先
- 手動幅は `tableau.extensions.settings` に保存し、Workbook再表示時に復元

## 廃止した機能
- Extension内の文字列 / 数値 / 日付 / Booleanフィルター
- `applyFilterAsync()` / `applyRangeFilterAsync()` による独自フィルター操作
- Distinct候補値取得
- プルダウン候補キャッシュ
- フィルター用Workbook設定

## 目標構成

```text
BigQuery / CSV / Excel / DB
          ↓
       Tableau
          ↓
  Tableau標準フィルター
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

### タスク7-2: 列順
- 初期順はTableau側のフィールド順
- 設定画面でドラッグして列順を変更
- 変更した列順は `tableau.extensions.settings` に保存
- Workbook再表示時に復元
- 新しく追加されたフィールドは保存済み列の後ろにTableau順で追加
- 「Tableau順に戻す」で保存順をリセット

### タスク7-3: 固定列
- 設定画面で「左から固定する列数」を指定
- デフォルト0（固定なし）
- 固定列数は `tableau.extensions.settings` に保存
- Workbook再表示時に復元
- 可変列幅に合わせて固定列の `left` を計算
- 列幅ドラッグ中も固定位置を再計算
- 最後の固定列に境界線を表示

## 次の予定
- 通常 / 棒グラフ / ヒートマップ
- ソート
- CSV / Clipboard / Excel エクスポート
