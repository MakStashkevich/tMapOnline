# tMapOnline 网页地图

本文说明网页地图的工作方式。浏览器从 Python 服务获取地图和游戏数据，不会直接连接 Terraria。tModLoader 模组向服务发送游戏信息；服务准备 API 响应、图像和历史记录。

“瓦片”和“chunk”表示不同内容：瓦片是 Terraria 中的一个游戏方格；chunk 是浏览器单独加载的成品图像矩形区域。

## 从 API 到像素

1. `web/src/map/world-map.ts`创建地图，从`/api/site-config`读取模块，获取世界元数据，并连接 renderer 与 controller。
2. 服务通过`GET /api/world-map/tile?world=…&level=…&x=…&y=…`发送已栅格化的 PNG。浏览器不会传输 RGB 数组，也不会每次打开时重新着色整张地图。
3. `MapSnapshotCache`将客户端 snapshot/chunk 保存到 IndexedDB。`MapPyramidLayerRenderer`保留粗略概览，并按缩放选择细节层级。优先加载可见块，并取消过时请求。
4. `MapViewportController`把滚轮、pinch 和拖动转换成 viewport 坐标。缩放点对应的世界坐标会影响网络请求优先级。
5. 独立的轻量 live 请求更新玩家和实体。NPC、传送塔等对象标记在地图图像上方的独立 DOM 图层中绘制。
6. 瓦片变化以 telemetry delta 传入，更新 backend 存储，并影响对应的底图与金字塔 PNG 块。

Renderer 负责绘制数据，controller 负责处理用户操作和协调请求。delta 是只包含改动的小消息，不是整张地图。

地图图层独立更新。底图图层是世界图像；探索图层显示已发现区域；mask 是决定图层显示位置的黑白图像。其他图层显示当前位置、路线、Map Ping、背景和界面控件。添加图层时，浏览器从 API 取得数据并交给绘制组件。改变一个图层不应迫使其他图层重新加载。

## 状态归属

| 状态                                      | 权威来源                          | 刷新页面后保留？             |
| ----------------------------------------- | --------------------------------- | ---------------------------- |
| 服务器功能、采集间隔、路线历史期限        | `config.yaml`和`/api/site-config` | 是                           |
| 图层、平滑度和显示频率                    | 浏览器`localStorage`              | 是，仅限当前浏览器配置档     |
| chunk 与客户端缓存状态                    | 浏览器 IndexedDB                  | 是，直到浏览器清除站点数据   |
| 已探索地图、玩家/会话历史、事件、首领进度 | tMapOnline 数据目录中的文件       | 是，与浏览器无关             |
| 实时位置和当前 NPC                        | 最新服务器模组 snapshot           | 否；来源停止或数据过期后失效 |
| 地图纹理/遮罩和 PNG 金字塔                | 按世界和配置档区分的 backend 存储 | 是                           |

`localStorage`保存较小的浏览器偏好，IndexedDB保存较大的数据（例如 chunk）。它们属于特定浏览器和设备，不会自动同步到另一部手机。服务器数据目录是运行 tMapOnline 的电脑上的普通文件。

网页显示设置属于浏览器用户，不是全局服务器设置，也不会跨设备同步。服务器配置可以完全禁用某一图层；浏览器开关不能启用服务器关闭的功能。

## 主要组件

- `app-shell.ts`和`core/modules.ts`：菜单、可配置操作/分区和通用扩展点。
- `components/map-display-settings.ts`：本地地图偏好及变更通知。
- `components/map-action-menu.ts`、`components/pixel-modal.ts`、`components/map-zoom-controls.ts`：可复用的菜单和模态窗口样式与行为。
- `map/world-map.ts`：地图组合根，不应再次接管 chunk codec、手势、缓存和所有 DOM 图层。
- `map/map-snapshot-cache.ts`、`map/map-tile-bitmap-cache.ts`、`map/map-tile-pyramid-renderer.ts`：图像加载和缓存。
- `map/map-viewport-controller.ts`：坐标转换、手势、缩放和可见区域请求。
- `map/map-entity-layer.ts`与`map/map-tooltip-controller.ts`：实时标记和游戏提示。
- `map/map-player-path-service.ts`、`map/map-route-layer.ts`、`map/map-exploration-mask.ts`：路线选择、探索遮罩和路线线条。

组合根负责创建并连接组件；codec 负责打包和解包数据。请在`web/src`中搜索文件位置：文件可能移动，但组件职责应保持狭窄清晰。

## 性能与 Safari/iOS

- 缩放时不要创建覆盖整个世界的巨大 canvas/bitmap。只处理可见 chunk，在详细图准备好前保留粗略图层。
- 改变细节层级时不要清空已绘制图层。新图到达前保留旧/粗略 bitmap，避免闪出空白背景。
- 取消过时请求，不把旧 viewport 的响应应用到新区域。pinch 时优先加载手势中心附近的 chunk。
- pinch 动画期间保持图层和标记的尺寸、transform 稳定。不要在每次缩放变化时销毁并重建 NPC DOM 精灵图。
- 给 bitmap 设定合理上限，避免无必要地复制大型像素数组：iOS Safari 的限制与桌面浏览器不同。
- 修改后分别在 iOS Safari 检查普通缩放和 pinch。构建成功本身不能证明手机没有闪烁。

## 如何修改地图

1. 找出页面的数据来源，并追踪到 API 与缓存。
2. 大地图按需加载：根据 viewport 请求，并按世界/版本/配置档/层级/坐标缓存。
3. 大数据与紧凑的 live snapshot 分开请求。不要把完整历史放进高频轮询。
4. 用户偏好保存在浏览器；服务器间隔、功能可用性和历史期限保存在服务器配置中。
5. 使用可复用组件和现有像素 token 实现新 UI，并考虑键盘和移动端操作。
6. 修改协议时，同时更新 TypeScript consumer、backend handler/store 和模组 producer。
7. 修改 TypeScript/SCSS 后运行`npm run build`重新生成 assets。

## 当前限制

地图以 PNG chunk 传输。瓦片数组留在服务器作为权威数据，用于重新生成图像和提示。未探索区域不会把真实地形发送给客户端，而是在服务端进行遮罩。实时实体依赖最新模组 snapshot；过期 snapshot 不用于显示坐标。
