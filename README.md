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

### タスク7-4: 通常 / 棒グラフ / ヒートマップ
- 列ごとに表示方式を設定
- デフォルトは通常
- 棒グラフ / ヒートマップは数値列のみ
- 値の文字列はそのまま表示
- スケールは現在ページ200行のmin / maxを使用
- ページ移動時はそのページの200行で再計算
- 表示方式は `tableau.extensions.settings` に保存
- Workbook再表示時に復元

### タスク8: ソート
- Extension側では現在ページ200行だけのクライアントソートを行わない
- Tableau Extensions APIにはWorksheet全件のソート順を書き換える汎用APIがないため、ソートはTableau側で設定
- DataTableReaderはTableau側で確定した並び順をそのままページング表示
- フィルター変更・再読み込み後もTableau側の並び順を使用

### タスク9-1: CSV / Clipboard エクスポート
- 通常表示は200行ページングのまま維持
- エクスポート時のみ現在のDataTableReaderを全ページ順次取得
- Tableau標準フィルター適用後の全行を対象
- Tableau側で確定した並び順を維持
- Extensionの現在の列順を維持
- 値は `formattedValue` を使用
- CSVはUTF-8 BOM付き
- ClipboardはExcel貼り付け向けTSV
- 20,000行超のClipboardは警告を表示
- エクスポート中はページ進捗を表示
- エクスポート中にデータ更新を検知した場合は中断

## 次の予定
- Excel（.xlsx）エクスポート
- 性能・異常系検証

### タスク9-2: 大容量CSVの安定出力
- 表示用Reader（200行/ページ）を解放し、CSV出力用Reader（5,000行/ページ）に切り替える。複数Readerは同時保持しない
- CSVは1ファイル最大10万行、または32MiBを超える前の5,000行単位で分割。分割CSVには毎回UTF-8 BOMと列ヘッダーを付ける
- 出力は表示中の列順・書式付き表示値、Tableau標準のフィルター・ソートを使用
- 各ファイルを生成後、ユーザーが「このCSVを保存」を押して保存。保存を確認してから次のファイルを生成。複数ファイルの自動ダウンロードは行わない
- ページ取得はエラー時に最大3回まで試行し、最終取得行数をReader.totalRowCountと照合する
- 進捗表示、中止操作、フィルター変更時の無効化、通常表示Readerへの復帰を実装
- メモリ負荷を抑えるため、パートの保存後に前のBlobを解放。ダウンロード用object URLは30秒後に破棄
- ブラウザのダウンロード保存「完了」までは判定できない。操作画面では保存開始と区別する
- 30万行のTableau Cloud実機負荷・復旧テストは未実施

### CSV出力の自動テスト（Tableau APIモック）
- 1行 / 5,000行 / 100,000行 / 100,001行 / 300,000行の分割と出力件数
- 30万行では10万行×3ファイル、Reader取得60ページ（再試行1回なら61呼び出し）
- 単一Readerページが32MiBを超える場合もページ途中で分割し、行の重複・欠落がないこと
- UTF-8 BOM、引用符・改行・カンマのエスケープ、Unicode、NULL
- 一時的なページ取得失敗からの復旧、最大回数失敗時のエラー表示・Reader解放
- 途中キャンセル、フィルター変更・SummaryDataChangedでの中断と画面復帰
- 実際のTableau Cloud / Chromeでの負荷・保存完了テストはユーザー実施予定
