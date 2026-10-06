# tabsdk-data-viewer

Tableau Dashboard Extension 用の大容量帳票ビューア PoC です。

## 目的

Tableau Extensions API の DataTableReader を使い、
Underlying Logical Table のデータを 200 行単位でブラウザへ渡して表示します。

```text
BigQuery / CSV / Excel / DB
          ↓
       Tableau
          ↓
       Worksheet
          ↓
    Logical Table
          ↓
DataTableReader
  200 rows/page
          ↓
 tabsdk-data-viewer
```

## PoC仕様

- 1ページ 200行
- 最初の Worksheet を対象
- 最初の Logical Table を対象
- 前へ / 次へ
- Tableau フィルター変更検知
- フィルター変更後は「フィルタ未更新」
- 更新ボタン押下で Reader を再生成
- Reader 再生成後は 0 ページ目へ戻る

## 未実装

- Worksheet 選択UI
- Logical Table 選択UI
- 表示フィールド選択
- ページ番号一覧
- CSV 全件出力
- XLSX 全件出力
- 作成者設定画面

## 配置

静的ファイルを HTTPS で配信し、
`tabsdk-data-viewer.trex` の `source-location` を
実際の配信URLへ変更してください。

リポジトリ固有のユーザー名・個人名・個人URLは、
このプロジェクト内には記載しません。