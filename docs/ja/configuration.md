# 設定とWebセクション

この文書ではサーバー設定を説明します。YAMLはインデントを使うテキスト形式で、スペースが設定の所属グループを示します。サーバー設定は収集するデータと有効にする機能を決め、全訪問者で共有されます。ズームやレイヤー表示は各ブラウザーの`localStorage`に個別保存されます。

設定ファイルは起動前に`tmaponline/config.py`が読み込み、検証します。省略した項目には既定値が使われます。編集後はサービスを再起動してください。再起動しない場合は古い設定のまま動きます。

```yaml
site:
  world_map:
    route_history_days: 7 # ルート履歴の日数 (1–365)
  pages:
    world_map: { enabled: true }
  sections:
    world: true
    players: true
    bosses: true
    server: true
    activity: true
  modules:
    world_map.exploration: true
    world_map.entities: true
```

例の`site`グループはWebマップとセクションの設定です。ほかに`storage`と`telemetry`があります。コロンの後ろが値で、`true`は有効、`false`は無効です。`7`なら直近7日分のルートを要求します。インデントのスペースは所属グループを決めるため、そのまま保ってください。

プレイヤーカードで「ルート履歴」を有効にすると、`site.world_map.route_history_days`の日数分の保存ポイントをマップが自動取得します。1〜365を指定してください。

以下は履歴保存期間と更新間隔の設定です。テレメトリは、ゲーム中にMODがサービスへ自動送信する情報です。

```yaml
storage:
  death_retention_seconds: 3600 # 0 — 死亡を無期限保存
  event_retention_seconds: 2592000 # 30日; 0 — 期間制限なし
  event_max_entries: 5000 # イベント最大件数
telemetry:
  player_position_interval_ticks: 6 # プレイヤー位置、6 tick ≈ 100 ms
  entity_interval_ticks: 6 # NPC、ボス、コイン、ピラー
  map_capture_interval_ticks: 30 # プレイヤー周辺の色付きマップ情報
  map_tile_update_interval_ticks: 1 # 変更タイルと壁、爆発を含む
  map_pings_from_players_to_web: true # ゲーム内pingをWebマップに表示
  map_pings_from_web_to_players: true # Web pingをプレイヤーへ送信
  initial_world_scan_enabled: true # tMapOnline起動時に全ワールドを走査
  world_scan_interval_ticks: 1 # scannerのチャンク処理間隔
  browser_live_poll_interval_ms: 50 # 軽量なliveデータ取得間隔
  browser_overview_poll_interval_ms: 250 # 全体表示時のlive更新間隔
  browser_map_poll_interval_ms: 5000 # マップ更新取得間隔
  browser_debug_poll_interval_ms: 1000 # debug設定表示中のマップ間隔
```

保存期間はすでに保存済みの死亡記録にも適用されます。MODは死亡ごとに安定IDを送り、PythonサービスのACKを待ちます。接続が切れるとイベントはキューに残り、再送されます。

イベントログは起動時と追加後に自動整理されます。`storage.event_retention_seconds`より古い記録を削除し、`storage.event_max_entries`件以内の最新記録を残します。期間を`0`にしても件数上限は適用されます。

一部の間隔はゲームtick単位です。tickはゲームの1ステップで、1秒60tickなら6tickは約100msです。tMapOnlineはこの値をMODへ渡します。ブラウザーの間隔はミリ秒で、1000msが1秒です。大きなマップは別に取得し、位置・オブジェクト・小さなブロック変更は`/api/world-map/live`から受け取るため、マップ全体を繰り返しダウンロードしません。

利用可能な設定と既定値は`config.example.yaml`にあります。実際のファイルは`--config`で渡します。例：`tmaponline --config config.local.yaml serve`。

| キー                                          | 役割                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `site.pages.world_map.enabled`                | tMapOnline Webマップを有効化。                                                                        |
| `site.sections.*`                             | world、players、bosses、server、activity各セクションを有効化。開いたときにデータを要求。              |
| `site.modules.world_map.*`                    | 探索、ルート、プレイヤー、エンティティ、コイン、ピラー、出現地点、tooltip、診断の各レイヤーを有効化。 |
| `storage.death_retention_seconds`             | 死亡マーカーの保存秒数。`0`は自動削除なし。既定値3600。                                               |
| `storage.event_retention_seconds`             | ログ保存秒数。`0`は期間制限なし。既定値2592000（30日）。                                              |
| `storage.event_max_entries`                   | 最新ログの最大件数。既定値5000。                                                                      |
| `telemetry.player_position_interval_ticks`    | ゲームtick単位の位置送信間隔。ローカルサーバーは`1`。                                                 |
| `telemetry.entity_interval_ticks`             | NPC、ボス、コイン、ピラーの間隔。ローカルサーバーは`1`。                                              |
| `telemetry.map_capture_interval_ticks`        | プレイヤー周辺の色付きマップ取得間隔。                                                                |
| `telemetry.initial_world_scan_enabled`        | 起動時の全ワールド走査を有効化。移動やタイル変更の更新を試す場合は無効化。                            |
| `telemetry.world_scan_interval_ticks`         | world scannerのチャンク処理間隔。                                                                     |
| `telemetry.map_tile_update_interval_ticks`    | 変更タイル/壁の送信間隔。hookが破壊、設置、爆発を追跡。                                               |
| `telemetry.map_pings_from_players_to_web`     | プレイヤーのpingをWebマップへ送信。                                                                   |
| `telemetry.map_pings_from_web_to_players`     | Webマップpingをサーバーのプレイヤーへ送信。                                                           |
| `telemetry.browser_live_poll_interval_ms`     | 軽量ブラウザー問い合わせ。滑らかなマーカー移動の既定値は50ms。                                        |
| `telemetry.browser_overview_poll_interval_ms` | 縮小表示時のlive間隔。マーカーはフレーム単位でなく段階的に動く。既定値250ms。                         |
| `telemetry.browser_map_poll_interval_ms`      | ブラウザーがチャンクを取得する間隔。現在5000ms。                                                      |
| `telemetry.browser_debug_poll_interval_ms`    | debug設定表示中のマップ更新間隔。現在1000ms。                                                         |

無効なページは`404`を返します。無効なセクションはメニューから消え、データも読み込みません。無効なレイヤーは描画されません。レイヤー追加時は既定値を設定し、`tmaponline/web/src/core/modules.ts`に登録してこの文書にも追記します。ブラウザー側の設定はYAMLへ保存されません。

## UIのビルド

編集するWeb UIは`tmaponline/web/src`にあります。動作はTypeScript、`styles`内のSCSSが見た目を定義します。ビルドコマンド：

```sh
npm ci
npm run format
npm run check:web
```

ビルドはminify済みES moduleとCSSを`tmaponline/web/assets`へ出力します。本番でPythonが配信するためNode.jsは不要です。マップ、プレイヤー、ボス、サーバー、アクティビティの各セクションは個別の動的チャンクとCSSになります。

`npm ci`はlockファイルの固定バージョンを導入します。`npm run format`はプロジェクト形式に整え、`npm run check:web`はWebコードを検査してビルドします。`assets`は生成物なので編集せず、`src`または`static`を変更してください。
