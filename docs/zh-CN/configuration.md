# 配置与网页分区

本文说明服务器设置。YAML 是使用缩进的文本格式，空格表示参数属于哪个分组。服务器配置决定收集哪些数据、启用哪些功能，所有访客共享。缩放与图层可见性由每个浏览器单独保存在`localStorage`中。

`tmaponline/config.py`在启动前读取并验证文件。未填写的参数使用默认值。编辑后需要重启服务，否则仍会使用旧设置。

```yaml
site:
  world_map:
    route_history_days: 7 # 路线历史天数（1–365）
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

示例中的`site`组配置网页地图和分区；文件还包含`storage`与`telemetry`组。冒号后的值决定状态：`true`启用，`false`禁用。数字`7`表示地图请求最近七天的路线。请保留缩进空格，因为它决定参数所属分组。

玩家卡片启用“路线历史”后，地图会自动请求`site.world_map.route_history_days`指定时段内保存的坐标。范围为 1 到 365 天。

下面是历史保留期限和更新频率设置。遥测是模组在游戏期间自动发送给服务的数据。

```yaml
storage:
  death_retention_seconds: 3600 # 0 — 无限期保留死亡标记
  event_retention_seconds: 2592000 # 30 天；0 — 不按时间清理
  event_max_entries: 5000 # 事件数量上限
telemetry:
  player_position_interval_ticks: 6 # 玩家位置，6 tick ≈ 100 毫秒
  entity_interval_ticks: 6 # NPC、首领、金币和传送塔
  map_capture_interval_ticks: 30 # 玩家周围的地图颜色数据
  map_tile_update_interval_ticks: 1 # 变化的瓦片和墙，包括爆炸
  map_pings_from_players_to_web: true # 在地图上显示游戏内 ping
  map_pings_from_web_to_players: true # 将网页 ping 发给玩家
  initial_world_scan_enabled: true # tMapOnline 启动时扫描整个世界
  world_scan_interval_ticks: 1 # 扫描器处理瓦片的间隔
  browser_live_poll_interval_ms: 50 # 轻量实时数据轮询频率
  browser_overview_poll_interval_ms: 250 # 全图概览时的实时更新间隔
  browser_map_poll_interval_ms: 5000 # 地图更新获取间隔
  browser_debug_poll_interval_ms: 1000 # 打开 debug 设置时的地图间隔
```

保留期限也作用于已经保存的死亡事件。模组为每次死亡发送稳定 ID，并等待 Python 服务确认。如果连接中断，事件会留在队列并重发。

事件日志在启动时和每次新增后自动清理：先删除早于`storage.event_retention_seconds`的记录，再只保留最近的`storage.event_max_entries`条。期限设为`0`时不按时间清理，但数量上限仍生效。

部分间隔以游戏 tick 表示。tick 是一个游戏步骤；每秒 60 tick 时，6 tick 约为 100 毫秒。tMapOnline 将这些值传给模组。浏览器间隔以毫秒表示，1000 毫秒为一秒。大型地图单独加载，位置、对象和小范围方块变化通过`/api/world-map/live`获取，因此无需反复下载整张地图。

所有可用设置和默认值见`config.example.yaml`。运行时配置文件通过`--config`指定，例如：`tmaponline --config config.local.yaml serve`。

| 键                                            | 用途                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `site.pages.world_map.enabled`                | 启用 tMapOnline 网页地图。                                               |
| `site.sections.*`                             | 启用世界、玩家、首领、服务器和活动分区。打开分区时才请求数据。           |
| `site.modules.world_map.*`                    | 启用探索、路线、玩家、实体、金币、传送塔、出生点、提示和诊断等地图图层。 |
| `storage.death_retention_seconds`             | 死亡标记保留秒数。`0`禁用自动清理。默认 3600。                           |
| `storage.event_retention_seconds`             | 日志事件保留秒数。`0`禁用按时间清理。默认 2592000（30 天）。             |
| `storage.event_max_entries`                   | 最新日志条数上限。默认 5000。                                            |
| `telemetry.player_position_interval_ticks`    | 游戏 tick 单位的位置发送间隔。本地服务器为`1`。                          |
| `telemetry.entity_interval_ticks`             | NPC、首领、金币和传送塔间隔。本地服务器为`1`。                           |
| `telemetry.map_capture_interval_ticks`        | 捕获玩家周边地图颜色数据的间隔。                                         |
| `telemetry.initial_world_scan_enabled`        | 启用初始全图扫描。测试玩家移动和瓦片变化带来的更新时可关闭。             |
| `telemetry.world_scan_interval_ticks`         | 世界扫描器处理瓦片的间隔。                                               |
| `telemetry.map_tile_update_interval_ticks`    | 变化瓦片和墙的发送间隔；hook 会检测挖掘、放置和爆炸。                    |
| `telemetry.map_pings_from_players_to_web`     | 将玩家 ping 发送到网页地图。                                             |
| `telemetry.map_pings_from_web_to_players`     | 将网页地图 ping 发送给服务器玩家。                                       |
| `telemetry.browser_live_poll_interval_ms`     | 浏览器轻量请求间隔。默认 50 毫秒以平滑移动标记。                         |
| `telemetry.browser_overview_poll_interval_ms` | 缩小查看时的实时请求间隔。标记按步移动，不逐帧动画。默认 250 毫秒。      |
| `telemetry.browser_map_poll_interval_ms`      | 浏览器获取地图块的间隔。当前 5000 毫秒。                                 |
| `telemetry.browser_debug_poll_interval_ms`    | 打开 debug 设置时的地图更新间隔。当前 1000 毫秒。                        |

禁用的页面会返回`404`。禁用的分区会从菜单消失，也不会加载数据；禁用的图层不会绘制。新增图层时，设置默认值，在`tmaponline/web/src/core/modules.ts`中注册，并补充本文档。用户在浏览器切换的偏好不会写入此 YAML 文件。

## 构建界面

可编辑的网页源代码位于`tmaponline/web/src`：TypeScript负责行为，`styles`中的 SCSS 负责外观。执行以下命令构建：

```sh
npm ci
npm run format
npm run check:web
```

构建会把压缩后的 ES modules 和 CSS 写入`tmaponline/web/assets`；生产环境由 Python 提供，不需要 Node.js。地图、玩家、首领、服务器和活动分区分别作为动态 chunk 加载，并各自使用 CSS。

`npm ci`安装 lock 文件固定的工具版本。`npm run format`按项目规范格式化源代码。`npm run check:web`检查网页代码并构建界面。`assets`是生成文件，请修改`src`中的源代码或`static`中的资源。
