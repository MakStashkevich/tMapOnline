# tMapOnline Webマップ

この文書ではWebマップの仕組みを説明します。ブラウザーはTerrariaへ直接接続せず、Pythonサービスからマップとゲームデータを受け取ります。tModLoader MODがゲーム情報をサービスへ送り、サービスがAPI応答、画像、履歴を準備します。

tileはTerrariaのゲーム内1マス、chunkはブラウザーが個別取得する完成画像の矩形部分です。

## APIからピクセルまで

1. `web/src/map/world-map.ts`がマップを作り、`/api/site-config`からmoduleを読み込み、ワールドmetadataを取得してrendererとcontrollerを接続します。
2. サーバーは完成済みPNG断片を`GET /api/world-map/tile?world=…&level=…&x=…&y=…`で返します。ブラウザーはRGB配列を転送せず、起動ごとに全体を塗り直しません。
3. `MapSnapshotCache`はsnapshot/chunkをIndexedDBに保存します。`MapPyramidLayerRenderer`は粗い概要を保持してzoomに適した詳細度を選びます。表示中のchunkを優先し、古いrequestをキャンセルします。
4. `MapViewportController`はwheel、pinch、dragをviewport座標へ変換します。zoom点のワールド座標が通信requestの優先度に影響します。
5. 軽量live requestがプレイヤーとentityを更新します。NPC、pillarなどのmarkerは地図画像上の別DOM layerに描画します。
6. tile変更はtelemetry deltaとして届き、backend storageを更新して該当するbaseおよびpyramid PNG chunkに反映されます。

rendererはデータを描き、controllerはユーザー操作とrequestを調整します。deltaは全体ではなく変更だけを含む小さなメッセージです。

レイヤーは独立して更新します。baseはワールド画像、explorationは探索済み領域、maskは表示範囲を決める白黒画像です。他のlayerは位置、route、Map Ping、背景、UI操作を示します。新しいlayerにはAPIデータと描画componentが必要です。1つのlayer変更で他を再ロードしてはいけません。

## 状態の所有者

| 状態                                          | 正本                                | ページ再読み込み後も保持？               |
| --------------------------------------------- | ----------------------------------- | ---------------------------------------- |
| サーバー機能、収集間隔、route履歴期間         | `config.yaml`と`/api/site-config`   | はい                                     |
| layer、smoothness、表示頻度                   | browser `localStorage`              | このbrowser profile内で保持              |
| chunkとclient cache                           | browser IndexedDB                   | site data削除まで保持                    |
| 探索地図、player/session履歴、event、boss進行 | tMapOnline data directoryのファイル | browserとは独立して保持                  |
| live位置と現在NPC                             | 新しいserver MOD snapshot           | いいえ。source停止や古いデータで期限切れ |
| map texture/maskとPNG pyramid                 | world/profile別のbackend storage    | はい                                     |

`localStorage`は小さな永続設定、IndexedDBはchunkなど大きなデータを保存します。どちらもそのbrowserと端末に属するため、別のスマートフォンへ自動同期しません。server data directoryはtMapOnlineを実行するPC上のファイルです。

Webの表示設定はbrowser利用者のものです。server global設定ではなく、端末間で同期しません。サーバー設定でlayerを全面禁止できます。browser toggleはserverが無効化した機能を有効化できません。

## 主なコンポーネント

- `app-shell.ts`、`core/modules.ts`：menu、設定可能なaction/section、共通extension point。
- `components/map-display-settings.ts`：ローカル地図設定と変更通知。
- `components/map-action-menu.ts`、`components/pixel-modal.ts`、`components/map-zoom-controls.ts`：再利用可能なmenu/modal UIと動作。
- `map/world-map.ts`：map composition root。chunk codec、gesture、cache、全DOM layerを再び抱え込まない。
- `map/map-snapshot-cache.ts`、`map/map-tile-bitmap-cache.ts`、`map/map-tile-pyramid-renderer.ts`：画像取得とcache。
- `map/map-viewport-controller.ts`：座標変換、gesture、zoom、可視範囲request。
- `map/map-entity-layer.ts`、`map/map-tooltip-controller.ts`：live markerとゲームtooltip。
- `map/map-player-path-service.ts`、`map/map-route-layer.ts`、`map/map-exploration-mask.ts`：route選択、探索mask、route線。

composition rootはcomponentを作って接続します。codecはデータをpack/unpackします。ファイルは`web/src`を検索してください。配置が変わってもcomponentの責務は小さく明確に保ちます。

## 性能とSafari/iOS

- zoom時にワールド全体の巨大canvas/bitmapを作らず、見えているchunkを使い、詳細が届くまで粗いlayerを保ちます。
- 詳細度変更時に描画済みlayerを消さず、新画像が届くまで旧画像を表示して空白flashを防ぎます。
- 古いrequestをキャンセルし、前viewportの応答を新領域へ適用しません。pinch中はgesture中央付近のchunkを優先します。
- pinch animation中にlayer/markerの寸法とtransformを安定させます。zoom変更ごとにNPC DOM spriteを作り直しません。
- bitmapサイズに適切な上限を設け、大きなpixel arrayの不要なcopyを避けます。iOS Safariの上限はdesktop browserと異なります。
- 変更後はSafari iOSでwheel相当のzoomとpinchを個別確認してください。build成功だけでは端末のちらつきがない証拠になりません。

## マップの変更方法

1. ページのdata取得元を探し、APIとcacheまで流れを追います。
2. 大きなマップはviewport単位で遅延取得し、world/version/profile/level/coordinatesでcacheします。
3. 大データは小さなlive snapshotと別に取得します。頻繁なpollへ全履歴を追加しません。
4. user設定はbrowserへ、server interval、機能可否、履歴期間はserver configへ保存します。
5. UI追加には再利用componentと既存pixel tokenを使い、keyboard/mobile操作を考慮します。
6. protocol変更ではTypeScript consumer、backend handler/store、MOD producerを同時に更新します。
7. TypeScript/SCSS変更後に`npm run build`でassetsを再生成します。

## 現在の制限

画像はPNG chunkで転送されます。tile arrayは再画像化とtooltip用のサーバー正本です。未探索領域の本当の地形はクライアントへ送らず、サーバー側でmaskします。live entityは新しいMOD snapshotに依存し、古いsnapshotの座標は表示に使いません。
