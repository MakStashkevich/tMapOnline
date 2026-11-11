<div align="center">
  <h1 align="center"><img src="docs/images/map-markers/rabbit.png" height="32" alt="兔子" align="absmiddle"> tMapOnline</h1>
  <p><strong>实时在线 Terraria 地图——共享整个世界，也能看到此刻正在发生的事。</strong></p>
  <p>世界探索 · 玩家与 NPC · Boss · 行进路线 · 浏览器与游戏之间的 Map Ping</p>
  <p><a href="README.md">🇺🇸 English</a> · <a href="README_RU.md">🇷🇺 Русский</a> · <a href="README_UK.md">🇺🇦 Українська</a> · <a href="README_FR.md">🇫🇷 Français</a> · <a href="README_JA.md">🇯🇵 日本語</a> · <a href="README_ZH_CN.md">🇨🇳 简体中文</a> · <a href="README_KO.md">🇰🇷 한국어</a></p>
</div>

我们和朋友一起玩 Terraria。其中一个朋友特别喜欢发现新地点、探索生物群系和建造房子。有一天他问我：“能不能在一张地图上看到所有玩家探索过的地方？”我没有找到能实时显示团队探索进度和世界动态的现成地图，于是决定自己试着做一个。tMapOnline 就这样开始了。

最初它只是一个查看服务器状态的网页：服务器运行了多久、占用了多少内存。后来我加入了玩家、NPC、Boss 和他们的精灵图，最后才有了地图。现在我可以在浏览器里查看世界动态，也可以用手机帮朋友标记位置：我放置一个 Map Ping，它就会出现在对方的游戏里。我自己不必启动 Terraria。

## 地图上有什么

- 团队共享的世界探索进度，以及服务器配置指定时间段内的玩家路线；
- 玩家、NPC 和 Boss 头像、传送晶塔、硬币、出生点、死亡标记和 Map Ping；
- 实时方块变化，以及受光照影响、边缘柔和的未探索区域阴影；
- Terraria 背景纹理、像素风菜单和提示，也适用于手机；
- 玩家与会话历史、Boss 进度、服务器状态、资源负载和合并后的事件记录。

地图使用游戏内精灵图显示玩家 <img src="docs/images/map-markers/player.png" height="22" alt="玩家精灵图" align="absmiddle">、NPC 头像 <img src="docs/images/map-markers/npc-example.png" height="22" alt="NPC 精灵图" align="absmiddle"> 和 Boss，例如肉山 <img src="docs/images/map-markers/boss-wall-of-flesh.png" height="22" alt="肉山精灵图" align="absmiddle">。传送晶塔 <img src="docs/images/map-markers/pylon.png" height="22" alt="传送晶塔精灵图" align="absmiddle">、金币 <img src="docs/images/map-markers/gold-coin.png" height="22" alt="金币" align="absmiddle">、出生点 <img src="docs/images/map-markers/spawn.png" height="22" alt="出生点" align="absmiddle">、死亡地点 <img src="docs/images/map-markers/death.png" height="22" alt="死亡地点" align="absmiddle"> 和 Map Ping <img src="docs/images/map-markers/map-ping.gif" height="22" alt="Map Ping 精灵图" align="absmiddle"> 也使用对应的游戏精灵图。

显示设置保存在每个浏览器中。你可以选择显示哪些玩家和图层、是否显示路线以及移动动画。这些偏好保存在浏览器的 `localStorage` 中，不会影响其他玩家的视图。服务器地址、更新频率、数据保留时间和可用功能由服务器所有者在 YAML 配置中设置。

## 运行

需要 Python 3.9 或更高版本。如果要通过 tMapOnline 同时启动本地游戏服务器，也需要安装 tModLoader。Node.js 只用于构建网页界面。

先构建网页文件。`tmaponline/web/assets` 是构建生成的目录，不会提交到 Git：

```sh
npm ci
npm run build
```

然后安装 tMapOnline 并复制示例配置：

```sh
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -e .
cp config.example.yaml config.local.yaml
```

同时启动网页地图和本地 Terraria 服务器：

```sh
tmaponline --config config.local.yaml run
```

如果游戏服务器由其他程序管理，只启动网页服务：

```sh
tmaponline --config config.local.yaml serve
```

打开 `server.host` 和 `server.port` 指定的地址。默认是 `http://127.0.0.1:8765`。`run` 会启动配置文件中指定的游戏服务器。如果该端口已被其他进程占用，tMapOnline 不会停止那个进程。

### 服务器模组

模组只需安装在服务器的 tModLoader 配置中，玩家无需安装。它会把世界数据发送给网页服务，并将浏览器发出的 Map Ping 转发给在线玩家。

请使用与服务器相同版本的 tModLoader 构建模组：

```sh
TML_ROOT="/path/to/tModLoader" python3 tools/build-mod.py
```

构建脚本会生成 `dist/tMapOnline.tmod`，不会替换正在运行的服务器所用模组。将文件复制到服务器配置的 Mods 文件夹，启用 `tMapOnline`。只有在没有玩家在线时才重启服务器。

## 配置和数据

示例配置见 [config.example.yaml](config.example.yaml)。详细技术文档目前只有俄语版：[服务器配置](docs/configuration.md)、[架构](docs/architecture.md)、[网页地图](docs/web-map.md)、[服务器模组](docs/mod.md)、[遥测与 HTTP API](docs/telemetry.md)、[更新](docs/migration.md)。

默认数据目录是 `~/Library/Application Support/tMapOnline`，其中保存地图缓存、玩家历史、导入的地图和 Boss 进度。可以通过服务器 YAML 中的 `storage.data_dir` 修改目录。

## 许可证和署名

源代码采用 MIT License 发布。你可以使用、修改、用于商业项目并再次分发。如果创建分支或基于 tMapOnline 开发项目，请保留 [LICENSE](LICENSE) 文件，并链接到 [GitHub 源码仓库](https://github.com/MakStashkevich/tMapOnline)。

部分资源有各自的使用条件。例如，[LICENSE-lzx.txt](tmaponline/sprite_renderer/LICENSE-lzx.txt) 只适用于 LZX 组件，不代表整个项目的许可证。重新分发图片、字体或第三方工具前，请确认它们各自的许可证。
