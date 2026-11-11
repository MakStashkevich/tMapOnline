# tMapOnlineのアーキテクチャ

この文書では、tMapOnlineの構成と、ゲームのデータがブラウザーのマップに届くまでを説明します。Pythonサービスがデータを受け取って保存し、API経由でWebマップに返します。サーバーMODはtModLoader内でゲームのデータを収集します。

データの流れは、TerrariaからMODへ、MODからサービスへ、サービスで応答を準備し、ブラウザーがマップやマーカーとして表示する順です。ブラウザーもPythonサービスも、Terrariaプロセスのメモリーを直接読み取りません。

つまり、MODがゲームを読み、Pythonサービスがデータを受け取り、ブラウザーが表示します。APIはブラウザーとサービスがデータをやり取りするためのアドレスです。snapshotは特定の時点のゲーム状態を記録したものです。cacheは準備済みデータを保存し、再生成を避けます。

## プロジェクトと責務の境界

```text
tMapOnline/                       # Webマップ、backend、MOD
├── tmaponline/                  # PythonパッケージとtModLoader MOD
│   ├── backend/                 # リクエスト、応答、Webファイルの配信
│   ├── telemetry/               # ゲームMODとの接続
│   ├── sprite_renderer/         # ゲームテクスチャとPNGスプライト
│   ├── web/
│   │   ├── src/                 # UIとマップの編集可能なソース
│   │   ├── assets/              # ビルドで生成されるファイル
│   │   ├── static/              # 元画像、フォントなどのリソース
│   │   └── world-map/           # Webマップの入口ページ
│   ├── tmodloader/
│   │   └── tMapOnline/          # サーバーMODのC#ソース
│   ├── config.py                # YAMLの読込、検証、既定値
│   └── runtime.py               # サービスとゲームプロセスの起動・停止
├── docs/                        # プロジェクト文書
├── tests/                       # PythonとWebの自動チェック
├── tools/                       # WebとMODのビルドコマンド
├── config.example.yaml
├── package.json
└── pyproject.toml
```

`backend/http.py`はブラウザーのリクエストを処理して応答を選びます。`backend/store.py`は保存先のファイル構成を知らなくても各部分がデータを扱える共通窓口です。`backend/services/`では責務を分割しています。`player_history`はプレイヤー履歴、`movement`は移動、`live_telemetry`は最新ゲームデータ、`monitoring`はサーバー状態、`world_map`はマップを担当します。

共通形式と定数は`store_common.py`にあります。巨大なクラスにまとめず、小さな機能単位に分けています。ロックは複数タスクが同じデータを同時に変更するのを防ぎ、キャッシュは最近準備した結果を再利用します。

JSONLでは1メッセージを1行に記録します。サービスは検証後、既知のフィールドを持つ`models/telemetry.py`のモデルへ変換します。これによりデータを扱いやすくし、エラーも見つけやすくします。プログラム境界では、ブラウザーや他のクライアントが期待する形式に変換します。

更新間隔は`config.yaml`で設定します。動くマーカーと大きなマップを同じ頻度で送信する必要はありません。tModLoaderは位置、エンティティ、色付きマップデータを別々に送信し、MODは各カテゴリの最新値を保持します。

最初の`/api/world-map`リクエストは、ワールドの大きさと利用可能なレイヤーの説明などのメタデータを返し、ピクセルチャンクは含みません。チャンクは完成画像の矩形部分です。全チャンクを含むJSONは、エクスポートなどで`?tiles=0`を明示して要求できます。

ブラウザーは画面内のオブジェクトだけを描きます。表示対象のプレイヤーやオブジェクトごとにスプライト付きHTML要素を作り、マップ移動やズーム時に表示対象を再計算します。これは表示だけに影響し、ゲーム内のNPCを出現・消去させません。

マップ画像はピラミッド状の複数解像度に分かれています。縮小時は小さな概要タイル、拡大時は詳細タイルを使います。サーバーは最大256 × 256ピクセルのPNGタイルを配信し、要求範囲と交差するチャンクだけを準備します。完成PNGをキャッシュして再生成を避けます。キャッシュは件数と合計32 MiBに制限され、`/debug`ではヒット、追い出し、画像準備時間を確認できます。

canvasはブラウザーで画像を描く面です。アクティブなマップタイルは最大16個、デコード済み画像は最大4 MiBです。マップと探索マスクは別のcanvasを使うため、マスク更新でベース画像を再取得しません。詳細度変更中は新しい画像が届くまで古い画像を表示し、空白のちらつきを防ぎます。画面外のタイルはDOMに追加しません。全データは明示的なエクスポート時のみ読み込みます。

現在位置、死亡、コイン、ブロック変更は`/api/world-map/live`から届きます。SSE (Server-Sent Events)はHTTP接続を開いたままにし、オブジェクトごとに別リクエストを送らずに新着データを受け取る仕組みです。サーバーは表示範囲と少しの余白のデータを送り、大きく移動するとブラウザーが購読を更新します。コインのレイヤーは大きく拡大したときだけ要求します。

ブロックが変わると、サーバーがデータを保存し、ブラウザーは該当ブロックを含む画像タイルだけ更新します。同じ座標が次回更新前に複数回変わった場合は最新状態を使います。他のタイルは表示範囲に入ったとき更新されます。`/debug`ではsnapshotの頻度と鮮度、応答サイズ、画像準備時間を確認できます。

`telemetry/stream.py`は改行区切りJSON snapshotを受け取ります。MODはサーバー状態を集めてlocalhostに送信します。Webはゲームプロセスへ直接アクセスせず、共通APIを読み込みます。

### スプライト描画

`sprite_renderer/xnb_texture.py`はXNBヘッダーを検証し、`Texture2D`のRGBAデータを読みます。圧縮XNBは`sprite_renderer/lzx.py`が32 KiBフレームを含めて展開するため、外部LZXパッケージやJava runtimeは不要です。`PlayerSpriteRenderer`、`NpcSpriteRenderer`、`MapItemSpriteRenderer`はプレイヤーアバター、NPC/ボスの顔、アイコンを合成します。PillowはPNG読み書きの境界にのみ使用し、キャッシュと画像URLは`StatusStore`が管理します。tModLoader MODはC#です。

ゲーム内マーカーに合わせるため、同じバージョンのTerraria/tModLoaderの逆コンパイルコードと照合します。死亡マークは`Content/Images/MapDeath.xnb`から取得し、`Main.DrawPlayerDeathMarker`が`Player.lastDeathPostion`を基準にマップ倍率で中央配置します。そのためtMapOnlineは人工的な影や縁取りを加えず元スプライトを使います。逆コンパイルコードは開発時の参照であり、リポジトリにも実行環境にも含まれません。

### tModLoaderの構成とサービス

テレメトリは設定可能なゲームtick間隔でsnapshotを送ります。死亡は`Player.KillMe`で取得し、一意IDを付け、Pythonサービスが保存を確認するまでMODのキューに残します。Pythonは設定されたTTLを保存済みマーカーに適用します。プレイヤーとNPCの向きは位置とは別に送られ、UIがゲームと同じ左右反転を行います。

`TMapOnlineSystem`はライフサイクルとcomposition rootを担当します。ゲームhookを接続し、サービスを作り、既存のJSONL/API契約を保ってJSON snapshotを構成します。詳細は責務の小さいオブジェクトへ分割されています。

composition rootはオブジェクトを作成して接続する中心です。serviceは一つの仕事を担う補助要素です。hookはワールド変更などのイベントに応じてゲームがMODコードを呼び出す箇所です。

- `TelemetryStreamServer` — TCP listener、クライアント、JSONL、snapshot ACK、受信コマンド。
- `WorldMapScanner` — 毎tick、小さなベースマップチャンクを走査し、paletteを準備して進捗を報告。
- `PlayerMapChangeRevealer` — プレイヤー周囲の探索範囲を作り、同じ領域の再取得を制限。
- `MapTileDataCapture` — ブロック/壁IDをシリアライズし、範囲を圧縮。
- `MapTileNameCatalog` — ブロック/壁のローカライズ名を解決して順次送信。
- `PlayerAppearanceSnapshotBuilder` — プレイヤー外見を収集し必要なテクスチャを出力。
- `WorldEntitySnapshotBuilder` — ピラー、NPC/ボス、ドロップコインのマーカーを収集。
- `BossProgressSnapshotReader` — vanillaの進行フラグだけを読み取る。
- `CalamityBossProgressAdapter` — オプションのCalamity MODと保存フラグを個別に照会。
- `BossVictoryTracker` — 再勝利を`ApplicationData/tMapOnline/boss-victories.json`へ保存。

各サービスには必要な状態だけを渡します。`Main`、`Player`、`NPC`、タイル、palette、マップの読み書きはゲームスレッド上で同期的に行います。バックグラウンド通信にはシリアライズ済みで変更不能なJSONL文字列を渡し、ゲームオブジェクトを直接渡しません。マップ初期化のために`Main.dedServ`を置き換えません。

## Web UIの構成

`web/world-map/index.html`はtMapOnline Webマップの唯一の入口です。`/`と`/world-map`は同じマップを開き、旧監視画面は無効です。UI、マップ、セクション、スタイルのソースは`web/src`にあります。`npm run build`はTypeScriptをminify済みES moduleへ、SCSSをCSSへ変換して`web/assets`に出力します。本番ではPythonが配信し、Node.jsは不要です。

`src/app-shell.ts`の`TMapOnlineApplication`は必要時にセクションデータを読み、pixel dialogで表示します。マップはすぐ全画面になります。`MapActionMenu`は縦カテゴリと隣接サブメニューを作り、`PixelModal`は閉じる操作、Escape、キーボードフォーカスを管理します。プレイヤーとルートの設定はプレイヤー画面にあり、変更はすぐマップに反映されます。`MapZoomControls`はpixelボタンと全体表示をマップcontrollerへ接続します。`src/sections/{world,players,bosses,server,activity}.ts`と各CSSは項目を開いたときだけ動的に読み込みます。

メニューはプレイヤー/ルート、ワールド情報/ボス勝利、サーバー、アクティビティをまとめます。診断は`/debug`でも利用できます。セクションは`site.sections`で有効化します。Backendは`/api/section-data?section=...`から軽量データを返します。ボス進行にはアクティブなボス、vanilla勝利フラグ、互換性のある再勝利カウンター、任意のCalamity状態が含まれます。完全な`/api/status`は互換性のために残されていますが、モーダルのデータ元ではありません。モーダルを開いていてもマップ更新は続きます。

UIはfrontend runtimeやcomponent libraryを使わず、標準ES moduleを使います。shellはメニューとモーダル、各sectionのSCSSはpixel表示、`mount(root)`はデータ要求と描画を担当します。開発・パッケージ時にesbuildとSassを実行します。分析、プレイヤー履歴、ログは対応する画面を開くまで読み込みません。

### TypeScriptオブジェクトの責務

`src/map/world-map.ts`はマップページのcomposition rootであり、設定済み機能を有効化し、データと表示のライフサイクルを接続してレイヤーを更新します。個別機能は専用オブジェクトが担当します。

- `MapSnapshotCache` — IndexedDBと保存状態の復元。
- `MapChunkCodec` — ベースチャンクと差分の展開・合成。
- `MapPyramidLayerRenderer` — 詳細度選択、表示中のPNGタイル読込、viewport変更時の古いHTTPリクエスト取消、ズーム点付近の優先。指定点がなければviewport中央を先に読み込む。
- `MapExplorationMask` — インポート地図とルートを探索マスクに統合。
- `MapImageExporter` — 探索マスクが有効なら適用してPNG出力。
- `MapViewportController` — zoom、pan、gesture、viewportイベント。ズーム位置のワールド座標をrendererに渡して該当タイルを優先する。
- `MapZoomControls` — zoomボタンと全体表示への復帰。
- `MapEntityLayer` — プレイヤー、NPC/ボス、コイン、ピラー、出現地点のマーカー。画面外の座標ではDOMスプライトやアニメーションループを作らない。
- `MapTooltipController` — hover待ち時間、ブロック情報cache、tooltip。
- `MapPlayerPathService` — 履歴正規化、ルートcache、teleport前後で探索区間を分割。
- `MapRouteLayer` — SVGルートと現在位置マーカー。
- `MapDiagnosticsPanel` — scanner状態と診断画面。

マップ機能は明確な役割と明示的な依存関係を持つオブジェクトに追加します。チャンクcodec、IndexedDB、gesture処理、markerのHTMLを`world-map.ts`へ戻さないでください。大きな処理は関連機能を変更する際に分割し、状態も動作もない薄いwrapper classは作らないでください。

Frontendコマンド：`npm ci`はlockファイル固定のツールを導入、`npm run typecheck`はTypeScriptを検査、`npm run build`は`web/assets`を更新、`npm run check:web`は両方を続けて実行します。ソース変更後、起動・パッケージ前にassetsを再ビルドします。PythonはPyrightの`strict`で確認します（Pylanceも同じエンジン）：`npm run check:python`。ローカル環境では`python3 -m pip install -r requirements-dev.txt`、続けて`npm ci`を実行します。全チェックは`npm run check:all`です。JSON形式が可変な既存4サービスでは未知型の診断だけを無効化していますが、使用フィールドは実行時に確認され、他のstrictルールは有効です。

## 状態と設定

`config.yaml`は起動とページ/セクションの有効化を制御します。ブラウザーのテーマ、選択したプレイヤー/レイヤー、マップ位置は`localStorage`に別途保存します。個人データとcacheはリポジトリではなく`~/Library/Application Support/tMapOnline`にあります。APIとテレメトリの仕様は[telemetry.md](telemetry.md)を参照してください。

設定ではサービスの起動とページ・コンポーネントの有効化を分けています。ユーザーの表示設定もサーバー設定とは別です。
