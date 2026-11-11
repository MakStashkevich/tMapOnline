# tMapOnline 架构

本文说明 tMapOnline 的组成，以及游戏数据如何到达浏览器中的地图。Python 服务接收并保存数据，通过 API 提供给网页地图；服务器模组则在 tModLoader 中收集游戏数据。

数据流程是：Terraria 将信息提供给模组，模组发送给服务，服务准备响应，浏览器再把响应绘制成地图和标记。浏览器和 Python 服务都不会直接读取 Terraria 进程内存。

简而言之，模组读取游戏，Python 服务接收数据，浏览器负责显示。API 是浏览器与服务交换数据的地址集合。snapshot 记录某一时刻的游戏状态。缓存保存已准备的数据，避免重复生成。

## 项目与职责边界

```text
tMapOnline/                       # 网页地图、backend 和模组
├── tmaponline/                  # Python 包及自有 tModLoader 模组
│   ├── backend/                 # 请求、响应和网页文件服务
│   ├── telemetry/               # 与游戏模组的连接
│   ├── sprite_renderer/         # 游戏纹理和 PNG 精灵图
│   ├── web/
│   │   ├── src/                 # 可编辑的界面与地图源代码
│   │   ├── assets/              # 构建生成的文件
│   │   ├── static/              # 原始图片、字体和其他资源
│   │   └── world-map/           # 网页地图入口
│   ├── tmodloader/
│   │   └── tMapOnline/          # 服务器模组 C# 源代码
│   ├── config.py                # 读取、验证 YAML 并提供默认值
│   └── runtime.py               # 服务与游戏进程的生命周期
├── docs/                        # 项目文档
├── tests/                       # Python 和网页自动检查
├── tools/                       # 网页和模组构建命令
├── config.example.yaml
├── package.json
└── pyproject.toml
```

`backend/http.py`处理浏览器请求并选择响应。`backend/store.py`为其他模块提供统一的数据访问方式，无需了解数据具体存在哪个文件。`backend/services/`按职责拆分：`player_history`负责玩家历史，`movement`负责移动，`live_telemetry`负责实时游戏数据，`monitoring`负责服务器状态，`world_map`负责地图。

通用格式和常量位于`store_common.py`。存储层由职责明确的小部分组成，而不是一个庞大的类。锁避免多个任务同时修改同一数据；缓存复用最近准备好的结果。

JSONL中每条消息占一行。服务会验证每一行，并转换为`models/telemetry.py`中的模型，也就是字段明确的数据结构。这样更容易使用数据和定位错误。程序边界会把数据转换为浏览器和其他客户端需要的格式。

更新频率写在`config.yaml`中，让快速移动的标记与大型地图不必以相同频率传输。tModLoader分别发送位置、实体和地图颜色数据。两次消息之间，模组保留每类数据的最新值。

首次请求`/api/world-map`只返回元数据，例如世界大小和可用图层说明，不包含像素块。chunk 是成品图像的一块矩形区域。需要导出等用途时，可以显式使用`?tiles=0`请求包含全部块的完整 JSON。

浏览器只绘制当前可见区域中的对象，并为每个可见玩家或对象创建带精灵图的 HTML 元素。移动地图或改变缩放时，浏览器会重新计算屏幕上应显示的标记。这只影响显示，不会在游戏中创建或移除 NPC。

地图图像分成多个金字塔层级：远景使用较小的概览块，放大后使用更详细的块。服务器提供最大 256 × 256 像素的 PNG 瓦片，并且只处理与请求区域相交的块。缓存保存已生成的 PNG，避免重复制作；它同时受条目数和总计 32 MiB 的限制。`/debug`可查看缓存命中、淘汰和图像生成耗时。

Canvas 是浏览器的绘图表面。最多同时激活 16 个地图瓦片和 4 MiB 已解码图像。地图和探索遮罩使用不同的 canvas，因此更新遮罩不会重新下载底图。切换细节层级时，旧图会保留到新图到达，以免闪现空白背景。屏幕外瓦片不会加入 DOM。只有用户明确导出时才读取完整数据集。

当前位置、死亡、金币和方块变化通过`/api/world-map/live`传输。SSE（Server-Sent Events）会保持 HTTP 连接打开，让服务无需为每个对象分别请求即可发送新消息。服务发送可见范围附近并带少量余量的数据；地图明显移动后，浏览器会重新订阅。金币图层只在高倍放大时请求。

方块变化后，服务保存更新的数据，浏览器只刷新包含该方块的图像瓦片。如果同一坐标在下一次更新前变化多次，只保留最后状态。其他瓦片会在用户移到相应区域时更新。`/debug`可查看 snapshot 频率和新鲜度、响应大小及图像生成耗时。

`telemetry/stream.py`接收按换行分隔的 JSON snapshot。模组收集服务器状态并发送到 localhost。网页不会直接访问游戏进程，而是读取统一的 API。

### 精灵图渲染

`sprite_renderer/xnb_texture.py`验证 XNB 文件头并读取`Texture2D`的 RGBA 数据。`sprite_renderer/lzx.py`负责解压 XNB，包括 32 KiB 帧；无需外部 LZX 包或 Java runtime。`PlayerSpriteRenderer`、`NpcSpriteRenderer`和`MapItemSpriteRenderer`分别组合玩家头像、NPC/首领头像和物品图标。Pillow 只用于 PNG 读写边界；缓存和图片 URL 由`StatusStore`负责。tModLoader 模组使用 C#。

为匹配游戏标记，代码会对照同一 Terraria/tModLoader 版本的反编译代码。死亡叉号来自游戏资源`Content/Images/MapDeath.xnb`；`Main.DrawPlayerDeathMarker`根据`Player.lastDeathPostion`居中绘制，并使用地图缩放。因此 tMapOnline 使用原始精灵图，不额外添加阴影或人工描边。反编译代码只作为开发参考，不包含在仓库中，运行项目也不需要它。

### tModLoader 组合与服务

遥测流按可配置的游戏 tick 间隔发送 snapshot。死亡通过`Player.KillMe`捕获，获得唯一 ID，并留在模组队列中，直到 Python 服务确认写入成功。Python 对已保存标记应用可配置的 TTL。玩家和 NPC 的方向与位置分开传输，便于 UI 重现游戏中的水平翻转。

`TMapOnlineSystem`是生命周期与组合根：它连接游戏 hook、创建服务并组装 JSON snapshot，同时保持现有 JSONL/API 协议。具体工作由职责单一的对象完成。组合根创建并连接对象；service 负责一项辅助工作；hook 是游戏因事件（例如世界变化）调用模组代码的位置。

- `TelemetryStreamServer`：TCP listener、客户端、JSONL、snapshot 确认和入站命令。
- `WorldMapScanner`：每个游戏 tick 扫描一小块底图、准备调色板并报告进度。
- `PlayerMapChangeRevealer`：生成玩家周围的已探索区域并限制重复扫描。
- `MapTileDataCapture`：序列化方块/墙壁 ID 并压缩区域。
- `MapTileNameCatalog`：解析方块/墙壁的本地化名称并随数据逐步发送。
- `PlayerAppearanceSnapshotBuilder`：收集玩家外观并导出所需纹理。
- `WorldEntitySnapshotBuilder`：收集传送塔、NPC/首领和掉落金币标记。
- `BossProgressSnapshotReader`：只读取原版进度标记。
- `CalamityBossProgressAdapter`：单独查询可选 Calamity 模组及其保存的标记。
- `BossVictoryTracker`：将重复击败记录保存到`ApplicationData/tMapOnline/boss-victories.json`。

服务只接收自身需要的状态。对`Main`、`Player`、`NPC`、瓦片、调色板和地图的读取与修改都在游戏线程同步完成。后台传输只接收序列化且不可变的 JSONL 字符串，不接收活动中的游戏对象。不会为了初始化地图而替换`Main.dedServ`。

## 网页界面结构

`web/world-map/index.html`是 tMapOnline 网页地图唯一入口。`/`和`/world-map`打开同一张地图；旧监控页面已禁用。界面、地图、分区和样式的源文件都在`web/src`。`npm run build`把 TypeScript 编译并压缩为 ES modules，把 SCSS 编译为 CSS，输出到`web/assets`。生产环境由 Python 提供这些文件，不需要 Node.js。

`src/app-shell.ts`中的`TMapOnlineApplication`按需加载分区数据，并在像素风对话框中打开。地图立即占满屏幕。`MapActionMenu`创建竖向分类与旁边的子菜单；`PixelModal`负责关闭、Escape 和键盘焦点。玩家与路线在玩家窗口中配置，并立即更新地图图层。`MapZoomControls`把像素风缩放按钮和全世界视图连接到地图控制器。`src/sections/{world,players,bosses,server,activity}.ts`及其样式只在打开菜单项时动态加载。

地图分类包括玩家与路线、世界数据与首领胜利、服务器和活动；`/debug`也可查看诊断。可在`site.sections`中启用分区。Backend 通过轻量的`/api/section-data?section=...`提供数据。首领进度包括当前首领、原版胜利标记、兼容的重复胜利计数和可选的 Calamity 状态。完整`/api/status`为兼容性保留，不作为模态窗口的数据源。模态窗口打开时地图仍继续更新。

UI 使用原生 ES modules，没有 frontend runtime 或组件库。职责边界明确：shell 管理菜单和对话框，每个分区的 SCSS 管理像素样式，`mount(root)`负责请求和渲染。开发或打包时运行 esbuild 与 Sass。用户打开相应窗口前，不加载分析数据、玩家历史和日志。

### TypeScript 对象职责

`src/map/world-map.ts`是地图页面的组合根：启用可配置功能、连接数据生命周期和显示，并更新图层。各机制由独立对象负责：

- `MapSnapshotCache`：IndexedDB 和已保存状态恢复。
- `MapChunkCodec`：解码并组合底图块和更新。
- `MapPyramidLayerRenderer`：选择细节层级、加载可见 PNG 瓦片、取消 viewport 变化后过期的 HTTP 请求，并优先加载缩放点附近瓦片；没有指定点时先加载 viewport 中心。
- `MapExplorationMask`：将导入地图和路线合并为探索遮罩。
- `MapImageExporter`：在探索遮罩启用时将其应用到 PNG 地图导出。
- `MapViewportController`：缩放、拖动、手势和 viewport 事件；把缩放点的世界坐标交给 renderer 优先请求。
- `MapZoomControls`：缩放按钮和恢复全世界视图。
- `MapEntityLayer`：玩家、NPC/首领、金币、传送塔与出生点标记；屏幕外坐标不会创建 DOM 精灵图或动画循环。
- `MapTooltipController`：悬停延迟、方块信息缓存和提示框。
- `MapPlayerPathService`：规范化玩家历史、路线缓存，并在传送点处分段探索路线。
- `MapRouteLayer`：SVG 路线与当前位置标记。
- `MapDiagnosticsPanel`：扫描器状态和诊断面板。

新增地图功能应放入职责清楚、依赖显式的独立对象。不要再把块编码、IndexedDB 生命周期、手势处理或标记 DOM 塞回`world-map.ts`。修改相关功能时逐步拆分过大的流程；避免没有自身状态或行为的薄封装类。

Frontend 命令：`npm ci`安装 lock 文件锁定的工具版本；`npm run typecheck`检查 TypeScript；`npm run build`更新`web/assets`；`npm run check:web`依次执行检查与构建。修改源文件后，在运行或打包前重新构建 assets。Python 使用 Pyright strict 模式检查（Pylance 使用同一引擎）：`npm run check:python`。本地环境先执行`python3 -m pip install -r requirements-dev.txt`，再执行`npm ci`。完整检查是`npm run check:all`。四个使用灵活 JSON 存储的现有 service 只关闭未知类型诊断；实际使用的字段仍在运行时检查，其余 strict 规则保持启用。

## 状态与配置

`config.yaml`控制启动以及页面/分区是否启用。浏览器主题、选中的玩家/图层和地图位置单独保存在`localStorage`。个人数据和缓存位于`~/Library/Application Support/tMapOnline`，不在仓库里。API 与遥测协议见[telemetry.md](telemetry.md)。

服务启动配置与页面/组件开关相互独立；用户显示偏好也与服务器参数分开保存。
