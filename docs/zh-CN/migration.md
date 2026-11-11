# 更新 tMapOnline

本文说明如何更新网页地图、Python 服务（backend）和服务器模组`tMapOnline`。更新替换程序，但不应删除已保存的世界、玩家历史或首领进度。

## 项目组成

- Python 包和启动命令名为`tmaponline`。
- macOS LaunchAgent 是系统服务，可在登录时从项目虚拟环境启动`tmaponline`。
- 服务器模组的源代码和 ID 名为`tMapOnline`。
- 构建产物名为`tMapOnline.tmod`。

修改源代码后，构建新包并安装到 tModLoader 配置档。配置档是拥有独立模组和世界的 tModLoader 安装。替换模组前，确认玩家已断开连接，并备份世界和已启用模组列表。

## 用户数据

默认情况下，网页地图和模组数据位于`~/Library/Application Support/tMapOnline`。`~`表示当前用户的主目录。该目录保存世界数据、玩家历史、图片缓存以及记录首领胜利进度的`boss-victories.json`。更新时不要删除此目录。如果修改`storage.data_dir`，先将文件移到新位置，并确认程序能够读取。

## 安装并运行更新版本

从项目根目录执行命令。Python 环境是单独存放 tMapOnline 库的目录，避免与电脑上的其他程序混在一起。

1. 创建或激活环境，并从当前目录安装：`python3 -m pip install -e .`。`-e`让 Python 直接使用这里的源代码，因此改动后无需重新构建安装包。
2. 使用`tmaponline --config config.local.yaml serve`或`tmaponline --config config.local.yaml run`启动。`--config`指定配置文件。`serve`只启动网页服务；如果配置了游戏服务器，`run`也会启动它。
3. 为已安装的 tModLoader 版本构建模组：`TML_ROOT="/path/to/tModLoader" python3 tools/build-mod.py`。
4. 在测试配置档或世界副本中检查`dist/tMapOnline.tmod`。构建只生成模组文件，不会自动安装到服务器配置档。
5. 替换模组前确认玩家已离开，并备份世界、旧`.tmod`和启用模组列表。
6. 将`tMapOnline.tmod`复制到服务器配置档，启用模组，并在没有玩家在线时重启服务器。
7. 打开`/healthz`检查服务是否响应，打开`/api/site-config`查看启用功能，打开`/api/status`查看服务器状态。随后检查地图、最新游戏数据以及双向 Map Ping。

## 回滚

如果新版本无法启动，正常停止服务并恢复旧`.tmod`、启用模组列表和旧版服务。回滚就是恢复已保存的可用版本。不要删除 tMapOnline 数据目录。
