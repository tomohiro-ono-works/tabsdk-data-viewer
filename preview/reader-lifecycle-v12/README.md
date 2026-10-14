# Reader ライフサイクル検証 V12（Tableau Public Desktop）

V11 の性能計測を継承した隔離された比較版です。V10/V11と本番版のコードは変更していません。

## 検証仮説
- H1: Excel50万行×13列で、同じReaderのページを再取得する場合は Reader生成・解放を省略できる。これを手動「再読み込み」と比較する。ただし **既存Reader再取得は最新データの再取得を意味せず、手動再読み込みの代用にはできない**。
- H2: `applyWorksheetFormatting` (true / false) がReader生成・200行取得の時間に影響するか。これは **ワークシートレベルの数値・日付書式** を切り替えるオプションで、フィールドの全書式を無効化するものではありません。
- H3: SummaryDataChanged/FilterChanged などデータ変更イベントを受け取った際は、古いReaderを再利用せず、解放→再生成することが必要となる。実装では安全のため常に再生成する。**Tableau実機で古いReaderが有効か・何を返すかを積極的には試験しません**。

## 実験手順（Excel・同一50万行×13列で）

1. `../reader-lifecycle-v12.trex` をTableau Public Desktopへ追加。必要な13列を指定して初回ロードが完了するまで待つ。
2. 「計測結果」を開き、**既存Readerで同じページを取得** を3回実行。Reader生成・解放の計測が増えず、getPageAsyncと描画だけの計測が増えることを確認。
3. **Reader再生成：ワークシート書式ON** を3回実行。Reader解放、getVisualSpecificationAsync、Reader生成、getPageAsync、描画の時間を記録。
4. **Reader再生成：ワークシート書式OFF** を3回実行。上記と同じ区間の時間を記録。
5. 再度「ワークシート書式ON」を試して、前後の負荷やキャッシュによる偏りを確認。
6. Tableauの表示列を1列追加／削除してSummaryDataChangedを発生させ、計測履歴に自動再読み込みのトレースが残ることを確認。書式状態は自動更新時ONへ戻る。
7. 全結果をTSVコピーして比較。TSV列末尾に「書式適用」ON/OFFが付加されています。

## 判定
- 「既存Readerの同じページを取得」が前回のページ移動と同程度に速ければ、リーダーを使い続ける方式は通常の再表示に有効。
- 「Reader再生成」で大部分がreader.releaseAsync + getSummaryDataReaderAsyncなら、再生成が必要な操作の待機はAPIの制約となる。**手動更新を既存Reader取得で置き換えてもデータの鮮度が保証されない**。
- 書式ON/OFFの差が小さければ、ワークシート書式処理は主因ではない可能性が高い。結果は実測で判断する。
- 直前の50万行×13列のV11ログでは手動再読み込み平均1,552ms、Reader生成約1,123ms、解放約323ms、通常ページ移動約104ms。これらは比較用の過去実測値であってV12の実測値ではありません。

## 実装と制限
- 既存Readerテストは、Tableauデータ変更イベントを受信した時点で実行不可とします。イベント処理待ち中もボタンを無効化します。
- API仕様はReaderが1つしか同時有効にならない制約があるため、Readerを再生成する前には解放します。
- Tableauイベント後の更新、手動「再読み込み」は常に `applyWorksheetFormatting:true` に戻ります。
- 約60分無操作のReaderは自動解放され、ページ取得に失敗する可能性があります。既存Readerの再取得に失敗した場合は最新化が必要なので手動再読み込みで復旧してください。
- すべての計測時間はJavaScript側の呼び出し開始から完了までであり、Tableauの内部処理／通信／転送の詳細を分離できません。イベント到着前のTableau処理時間、ユーザー操作時間、厳密なGPU画面描画時間は測定範囲外です。
- 計測結果の列幅算出はヘッダー生成の内数、renderTable合計は描画の内訳の総和です。二重計上しないでください。
- TSVは時間／操作／表示行・列数等の情報であり、セルのデータ値は含まれません。

## コード検証
- JavaScript構文、DOM-ID整合性、TREX参照先
- 模擬Tableauレスポンスに対する 初回ロード→既存Reader再利用→書式OFF生成→書式ON生成→SummaryDataChanged自動更新
- Reader最大同時有効数1、データ更新イベント後に既存Reader再利用禁止、イベント後の書式ON復帰
- 実機での性能評価は未実施。ユーザーがExcelとTableau Public Desktopで測定した結果をもとに判断する

関連仕様: https://help.tableau.com/current/api/embedding_api/en-us/reference/interfaces/DataTableReader.html
