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

### タスク7-2: 列順（仕様変更）
- 初期順・表示順はTableau側の「表示列」のフィールド順
- 拡張機能側の並べ替え操作は廃止
- 過去に保存した列順設定は適用しない

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

### タスク9-1: CSVエクスポート（現行はタスク9-2の方式）
- 通常表示は200行ページングのまま維持
- 出力時のみCSV用Readerに切り替え、ページごとに逐次取得
- Tableau標準フィルター適用後の全行を対象
- Tableau側で確定した並び順を維持
- 列順はTableauの「表示列」順を使用
- CSVの値は列ごとの表示書式を反映、UTF-8 BOM付き
- コピーの全件TSV生成・クリップボード処理はv0.15で削除
- エクスポート中にデータ更新を検知した場合は中断

## 次の予定
- Tableau Cloudでの30万行CSV出力・性能・異常系検証

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


### タスク10: 表示列の統一・書式と色の設定
- TREXの「行」を「表示列」に変更（内部IDはrowsを継続）。「ラベル」は廃止。以前ラベルに置いたフィールドは表示列へ再配置する
- 設定 > 列設定で各列の表示書式を選択（Tableau書式 / 元の値 / 数値小数0～3桁 / %小数0～2桁 / 日付YYYY-MM-DD・YYYY/MM/DD）
- 数値書式は桁区切り、小数桁数を固定。％は生値0.125を12.5％と解釈する
- getSummaryDataReaderAsyncにapplyWorksheetFormatting: trueを設定。Tableau書式は表示値を優先
- 棒グラフ・ヒートマップの色を列ごとにカラーピッカーで指定（初期値は青）。色はTableauのExtension Settingsに保存
- 列の書式設定は表の表示・列幅計算・CSV・TSVに同一適用
- Tableau上での配置・書式反映の実機テストは別途必要


### タスク11: 3点グラデーションとセル単位コピー
- Tableau内の列の順序を採用。Extension内のドラッグ列順変更・保存・リセットUIを廃止。過去に保存された列順設定も適用しない
- 棒グラフとヒートマップに「下限・中間・上限」の色と数値境界を列ごとに設定できる
- 境界値を3つとも空欄にすると現在ページ200行の最小・中間・最大を自動使用。指定時は3つとも入力し下限 < 中間 < 上限を検証
- 値が境界の間にある場合はRGB線形補間、境界外は端の色に固定。棒グラフの長さは下限～上限の値を使用
- Tableau Extension SettingsのcolumnGradientsV1に列別設定を保存。旧1色指定は初回の上限色の初期値として扱う
- 表のセルをクリック・ドラッグ・Shift+クリックで矩形範囲選択し、右クリック「選択したセルをコピー」で表示値をTSV形式でコピー（Ctrl+Cは非対応）
- 列幅のドラッグ保存時に設定保存の失敗を画面に表示。Tableauワークブック側の保存／パブリッシュは別途必要
- 実機のTableau Cloud/Chromeでの操作検証は未実施


### v0.15: ダッシュボード表示時の操作UI修正
- 旧「コピー」ボタンと全件TSVコピー処理を削除。選択範囲のコピーは右クリックメニューから実行（Ctrl+Cは非対応）
- ページ数・前へ・次へ・総件数を表の上部へ移し、Tableauのダッシュボードで下端の横スクロールと競合しない構成に変更
- Tableau Viz Extensionの「設定」ボタンを表から撤去。TREXにconfigure-context-menu-itemを追加し、ワークシートのマークカード「Format Extension（拡張機能の書式設定）」から既存の列設定を開く
- Vue等の外部フレームワークは追加せず、200行ページングとCSVの5,000行ずつの取得構成を維持
- 全30万行のソートは未対応。Viz Extension APIからワークシート全体をソートする汎用メソッドは提供されないため、200行だけの不正確なソートは実装せず、Tableauで並び順を設定する
- Tableau Cloud/ダッシュボードでの実機表示検証は未実施

### 現行の検証仕様：セル範囲コピー（Tableau Public Desktop）
- 選択方法はセルクリック、ドラッグによる矩形選択、Shift+クリック
- コピー操作は右クリックの「選択したセルをコピー」のみ
- `Ctrl+C` はTableau Public Desktop上で正常動作しないため非対応。キーイベントをフックしない
- Clipboard APIの`writeText()`は検証環境で完了しなかったため使用せず、動作が確認できた`execCommand('copy')`を使用
- 現行の`preview/`で検証中。本番ルートの`app.js`への反映は未実施
