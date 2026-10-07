# tabsdk-data-viewer

Tableau Viz Extension（Worksheet Extension）用の大容量帳票ビューアです。

## 現在の状態

タスク1として Dashboard Extension から Viz Extension へ移行済みです。

- `worksheet-extension` マニフェストへ変更
- `tableau.extensions.worksheetContent.worksheet` を利用
- GitHub Pages から HTTPS 配信
- DataTableReader による 200 行ページングは次タスクで実装

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

## 計画中の機能

- 1ページ 200行
- Tableau フィルター連動
- Extension 内フィルター
- 列幅・列順・固定列設定
- 通常 / 棒グラフ / ヒートマップ
- CSV / Clipboard / Excel エクスポート
- 設定の Workbook 保存

## 配置

静的ファイルを HTTPS で配信し、`tabsdk-data-viewer.trex` の
`source-location` からその URL を参照します。
