# tMapOnlineの更新

この文書ではWebマップ、Pythonサービス（backend）、サーバーMOD `tMapOnline`の更新方法を説明します。更新でプログラムを置き換えても、保存したワールド、プレイヤー履歴、ボス進行は消さないでください。

## プロジェクトの構成

- Pythonパッケージと起動コマンドは`tmaponline`です。
- macOSのLaunchAgentは、ログイン時にプロジェクトの仮想環境から`tmaponline`を起動できるシステムサービスです。
- サーバーMODのソースとIDは`tMapOnline`です。
- ビルド成果物は`tMapOnline.tmod`です。

ソースを変更したら新しいパッケージをビルドし、tModLoaderプロファイルに導入します。プロファイルはMODとワールドを個別に持つtModLoaderのインストールです。MODを置き換える前にプレイヤーが切断済みであることを確認し、ワールドと有効MOD一覧をバックアップしてください。

## ユーザーデータ

既定のデータ保存先は`~/Library/Application Support/tMapOnline`です。`~`は現在のユーザーのホームフォルダーです。ワールドデータ、プレイヤー履歴、画像cache、ボス勝利記録`boss-victories.json`が保存されます。更新時にこのフォルダーを削除しないでください。`storage.data_dir`を変える場合は先にファイルを移し、アプリが読み取れることを確認してください。

## 更新版の導入と起動

コマンドはプロジェクトルートから実行します。Python環境はtMapOnlineのライブラリを他のプログラムと分けるフォルダーです。

1. 環境を作成または有効化して、現在のフォルダーからインストールします：`python3 -m pip install -e .`。`-e`はPythonにソースを直接使わせるため、コード変更のたびにパッケージを再ビルドする必要がありません。
2. `tmaponline --config config.local.yaml serve`または`tmaponline --config config.local.yaml run`で起動します。`--config`は設定ファイルを指定します。`serve`はWebサービスだけ、`run`は設定されていればゲームサーバーも起動します。
3. インストール済みtModLoader向けにビルドします：`TML_ROOT="/path/to/tModLoader" python3 tools/build-mod.py`。
4. `dist/tMapOnline.tmod`をテスト用プロファイルまたはワールドのコピーで確認します。ビルドはファイルを作るだけで、サーバープロファイルへ自動導入しません。
5. MOD置換前に全員が退出したことを確認し、ワールド、旧`.tmod`、有効MOD一覧を保存します。
6. `tMapOnline.tmod`をサーバープロファイルにコピーしてMODを有効化し、プレイヤーがいない安全な時間に再起動します。
7. `/healthz`でサービス応答、`/api/site-config`で有効機能、`/api/status`でサーバー状態を確認します。その後、マップ、新しいゲームデータ、双方向のMap Pingを確認します。

## ロールバック

新しいビルドが起動しない場合は通常手順で停止し、以前の`.tmod`、有効MOD一覧、サービスの旧ビルドを復元します。ロールバックは保存済みの動作版へ戻す操作です。tMapOnlineのデータフォルダーは削除しません。
