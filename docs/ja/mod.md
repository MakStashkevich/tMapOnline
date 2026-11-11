# tMapOnlineサーバーMOD

MOD名は`tMapOnline`です。サーバー側tModLoader内で動作し、プレイヤーが別途インストールする必要はありません。ゲーム情報をWebサービスへ送り、Map Pingを双方向に届けます。

## MODの役割

MODはマップを描画せず、Webサイトも起動しません。プレイヤーの現在位置などゲームデータを読み、tMapOnlineへ送ります。アプリは保存してブラウザーに表示します。ブラウザーにPingを置くとゲームに表示され、ゲーム内Pingはブラウザーに表示されます。

## 責務と境界

MODとtMapOnlineは`127.0.0.1`のTCP接続で通信します。これは同じコンピューターのアドレスで、外部からこのポートには接続できません。各メッセージはJSONの1行です。MODはWebサーバーではなく、ブラウザー設定も変更しません。

ゲームオブジェクトの安全な読書きは、tModLoaderがワールドを更新するゲームループ内だけで行います。ネットワーク処理は準備済みのメッセージ文字列を使い、別タスクからワールドを直接操作しません。

`TMapOnlineSystem`は起動と終了を管理し、ゲームイベントhookを登録し、他コンポーネントを起動し、snapshotを定期作成し、Map Pingを受信し、終了時に接続を閉じます。

| 責務                                                   | コンポーネント                                     |
| ------------------------------------------------------ | -------------------------------------------------- |
| TCP listener、client、JSONL、snapshot ACK、受信command | `TelemetryStreamServer`                            |
| NPCとワールドentity snapshot                           | `WorldEntitySnapshotBuilder`                       |
| プレイヤー外見とMOD textureの出力                      | `PlayerAppearanceSnapshotBuilder`                  |
| マップ走査とRGB/RGBAタイル変更                         | `WorldMapScanner`, `MapTileDataCapture`            |
| タイル/壁の名称と翻訳                                  | `MapTileNameCatalog`                               |
| プレイヤーマップの探索範囲検出                         | `PlayerMapChangeRevealer`                          |
| vanilla勝利flagと旧counter                             | `BossProgressSnapshotReader`, `BossVictoryTracker` |
| Calamity専用連携                                       | `CalamityBossProgressAdapter`                      |

RGBは赤・緑・青、RGBAは透明度を追加した色形式です。`CalamityBossProgressAdapter`はCalamity対応だけを担当し、他のボス進行処理は依存しません。クラス名はソースと一致します。ゲームworldの読書きはゲームループ内に保ち、通信タスクには準備済みメッセージだけ渡してください。

## 通信と信頼性

- 既定ではlistenerは`127.0.0.1:38762`だけで待ち受けます。設定は`server.telemetry_host`と`server.telemetry_port`です。
- snapshotはJSON Lines、schema version `1`です。各行に`snapshotId`があり、tMapOnlineは同じTCP接続で受信をACKします。
- 死亡eventは安定IDを持ち、ACKまで再送され、`storage.death_retention_seconds`で制限されます。
- tMapOnline clientは切断後に再接続します。listenerは最新状態を保持し、新clientへすぐsnapshotを送ります。
- Web Map Pingはタイル座標付きcommandで、MODが接続中の全プレイヤーへ配信します。ゲーム内Pingはタイル座標付きeventとして戻ります。
- ブラウザー表示設定はMODへ送られません。間隔とPingの方向はサーバー設定で決まります。

接続方向に注意してください。MODがportを開いて待ち、Pythonサービスが接続します。接続後は双方が送信できます。サービスはMap PingとACK、MODはsnapshotとゲームeventを送ります。

schemaとendpointは[telemetry.md](telemetry.md)を参照してください。既存fieldの意味や型を変える場合はschema versionを更新して移行期間を設け、v1を黙って変更しないでください。

## ビルド

プロジェクトルートから実行します。macOSでは`TML_ROOT`にインストール先を指定します。

```sh
TML_ROOT="/path/to/tModLoader" python3 tools/build-mod.py
```

`/path/to/tModLoader`を実際のパスに置き換えます。scriptはC#プロジェクトをビルドして`dist/tMapOnline.tmod`を作ります。別の一時フォルダーを使うためprofile設定は変わりません。MODの導入や稼働中サーバーのファイル変更もしません。ビルドとサーバーのtModLoader versionは一致させてください。

サーバーにMODを認識させるには、`.tmod`をそのprofileの`Mods`へコピーし、MOD IDを有効MOD一覧`Mods/enabled.json`へ追加します。次回起動時に読み込まれます。プレイヤーが退出済みであることを確認してから再起動してください。

## MODの変更

1. `TMapOnlineSystem`でイベントhandlerを探します。ロジックが多ければ責務の明確な別classへ移します。
2. メッセージの送信元からPython serviceの受信先まで追跡します。
3. Terraria APIはゲームループ内で読みます。ネットワークtaskには準備済みメッセージを渡します。
4. 重要eventに一意IDを付け、service ACKまで再送します。
5. 対象tModLoader version向けに`python3 tools/build-mod.py`でビルドします。
6. 別途インストールと起動の依頼がない限り、稼働中profileへ`.tmod`をコピーしたりサーバーを再起動したりしません。

event handlerはブロック変更などゲームeventで呼ばれるコードです。一意IDは受信済みeventをserviceが識別するため、再送でも重複を作りません。
