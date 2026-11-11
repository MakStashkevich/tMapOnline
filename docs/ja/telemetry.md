# テレメトリとAPI

テレメトリはMODがゲーム中にWebサービスへ自動送信するゲームデータです。サービスは受信・検証し、必要な履歴を保存して、ブラウザー向けの応答を準備します。Map Pingも同じ接続でゲームからブラウザーへ、ブラウザーからゲームへ送られます。

## MODデータストリーム

MODは`server.telemetry_host`のアドレスで`server.telemetry_port`を開き、接続を待ちます。PythonクライアントがTCP（プログラム間のネットワーク接続）で接続すると、MODがデータを送ります。各JSON行が1レコードとなるJSONL形式です。`schemaVersion: 1`はレコード形式のバージョンを示します。サーバー、ワールド、プレイヤー、NPC、マップオブジェクトの状態が入ります。切断後、Pythonクライアントは自動再接続し、不正な行を飛ばして読み込みを続けます。

各完全レコード（現在状態のsnapshot）には`snapshotId`があります。Pythonクライアントが読み込みと保存に成功すると、受理を知らせるACKを返します：`{"ackSnapshotId":123}`。死亡はsnapshot間で発生するため独自`id`を持ちます。MODは未確認イベントを再送し、ACK後にのみキューから削除します。マーカー保持期間は`storage.death_retention_seconds`で、`0`は自動削除なしです。

プレイヤーとNPCは`Player.direction`と`NPC.spriteDirection`の向きを送り、ブラウザーで正しく左右反転できるようにします。任意の`respawnPending`は死亡中または復活後の座標未更新を示します。`true`の間は古い位置の通常マーカーを隠し、死亡クロスだけを残します。

payloadはMODが送る1レコードの内容です。互換性を保つ変更では任意フィールドを追加し、古い受信側が無視できるようにします。既存フィールドの意味や型を変える場合はschema versionを上げ、移行期間は新旧両方を読めるようにします。パスワードやtokenなどの秘密を含めないでください。

## HTTP endpoints

HTTPはブラウザーがサーバーへページやデータを要求する一般的な方式です。`GET`は読み取り、`POST`は送信、`DELETE`は指定データの削除です。`?`の後ろはクエリパラメーターです。`x=10&y=20`ならタイル座標です。この表の`x`と`y`はゲーム内タイル単位です。

`id`はプレイヤーID、`world`はワールド名、`days`は履歴日数、`since`はそれ以降の変更だけを要求する基準です。feature flagは機能が利用可能かをUIへ伝えます。

| Endpoint                                                   | 目的                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| `GET /api/status`                                          | サーバー、プレイヤー、ボス、履歴の概要。                      |
| `GET /api/world-map`                                       | メタデータとレイヤー。全ピクセルチャンクは含まない。          |
| `GET /api/world-map?tiles=0`                               | ピクセルチャンクを含む互換性のある完全なmap JSON。            |
| `GET /api/world-map?since=...`                             | マップ更新差分。                                              |
| `GET /api/world-map/tile-info?x=...&y=...`                 | ブロック/壁のローカライズ説明。                               |
| `GET /api/world-map/exploration?id=...&world=...`          | プレイヤー探索画像。                                          |
| `POST /api/world-map/import-player-map?id=...`             | debugページから`.map`を読み込み、新たに探索したタイルを統合。 |
| `POST /api/world-map/export-player-map?id=...`             | 保存情報から`.map`を出力。                                    |
| `DELETE /api/world-map/import-player-map?id=...&world=...` | 読み込んだ範囲だけを消去。                                    |
| `GET /api/resource-history?days=...`                       | サーバーリソース履歴。                                        |
| `GET /healthz`                                             | HTTPサーバーへのローカル接続確認。                            |
| `GET /api/site-config`                                     | UIのfeature flag。                                            |

静的UIファイル（CSS、JavaScript、固定画像）は`/assets/`にあります。プレイヤー、NPC、ボスの画像はデータフォルダーから別のAPI URLで配信されます。

手動確認ではブラウザーで開くか、コマンドラインからリクエストします。まず`/healthz`でHTTPサービスの稼働を確かめます。ただしMOD接続やマップ受信までは証明しないため、続けて`/api/status`と`/api/world-map`を確認します。
