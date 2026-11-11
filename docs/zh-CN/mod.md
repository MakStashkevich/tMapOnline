# tMapOnline 服务器模组

模组名为`tMapOnline`。它运行在服务器端 tModLoader 中，玩家不需要单独安装。模组向网页服务发送游戏数据，并双向传递 Map Ping。

## 模组的作用

模组不负责绘制地图，也不启动网站。它读取游戏数据（例如玩家当前位置）并发送给 tMapOnline 应用。应用保存数据并在浏览器中显示。浏览器放置的 Map Ping 会出现在游戏里；游戏里放置的 ping 会出现在浏览器中。

## 职责与边界

模组与 tMapOnline 通过`127.0.0.1`上的 TCP 连接交换消息。这是本机地址，外部设备不能连接该端口。每条消息占一行 JSON。模组不是 Web 服务器，也不会修改浏览器设置。

只有在 tModLoader 更新世界的游戏循环中，才可以安全读取或修改游戏对象。网络任务使用已经准备好的消息文本，不从其他任务访问游戏世界。

`TMapOnlineSystem`管理模组的启动和停止：连接游戏事件 hook、启动其他模块、定期准备 snapshot、接收 Map Ping，并在停止时关闭连接。

| 职责                                                 | 组件                                               |
| ---------------------------------------------------- | -------------------------------------------------- |
| TCP listener、客户端、JSONL、snapshot 确认和入站命令 | `TelemetryStreamServer`                            |
| NPC 和世界实体 snapshot                              | `WorldEntitySnapshotBuilder`                       |
| 玩家外观和模组纹理导出                               | `PlayerAppearanceSnapshotBuilder`                  |
| 地图扫描与 RGB/RGBA 瓦片变化                         | `WorldMapScanner`, `MapTileDataCapture`            |
| 瓦片/墙壁名称及本地化                                | `MapTileNameCatalog`                               |
| 发现玩家地图中的探索区域                             | `PlayerMapChangeRevealer`                          |
| 原版胜利标记与旧计数                                 | `BossProgressSnapshotReader`, `BossVictoryTracker` |
| Calamity 专用集成                                    | `CalamityBossProgressAdapter`                      |

RGB 是像素的红、绿、蓝颜色值；RGBA 还包含透明度。`CalamityBossProgressAdapter`只服务于 Calamity 集成，其余首领进度逻辑不依赖它。表中的名称与源代码一致。读取和修改游戏对象时要留在游戏循环；网络任务只能使用已准备的消息。

## 传输与可靠性

- 默认 listener 只监听`127.0.0.1:38762`。通过`server.telemetry_host`和`server.telemetry_port`配置。
- snapshot 使用 JSON Lines，schema version 为`1`。每行含`snapshotId`；tMapOnline通过同一 TCP 连接确认接收。
- 死亡事件有稳定 ID，在确认前会重发，并受`storage.death_retention_seconds`限制。
- tMapOnline 客户端断线后会重连。listener 保存最新状态，使新客户端立即收到当前 snapshot。
- 网页 Map Ping 是包含瓦片坐标的命令，模组会广播给已连接玩家。游戏内 Map Ping 作为包含瓦片坐标的事件返回。
- 浏览器显示偏好不会发送给模组。发送间隔与 ping 方向由服务器启动配置决定。

注意连接方向：模组打开端口并等待，Python 服务连接到该端口。连接后双方都能发送消息：服务发送 Map Ping 和确认，模组发送 snapshot 与游戏事件。

schema 和 endpoint 见[telemetry.md](telemetry.md)。字段含义或类型变化时应使用新 schema 版本并提供兼容迁移期，不要悄悄修改 v1。

## 构建

从项目根目录运行。macOS 上可通过`TML_ROOT`指定已安装的 tModLoader 目录：

```sh
TML_ROOT="/path/to/tModLoader" python3 tools/build-mod.py
```

将`/path/to/tModLoader`替换为游戏实际路径。脚本构建 C# 项目并输出`dist/tMapOnline.tmod`。它使用独立临时目录，不修改配置档设置，也不会安装模组或触碰运行中服务器的文件。构建和服务器使用的 tModLoader 版本必须一致。

要让服务器加载模组，将`.tmod`复制到该配置档的`Mods`目录，并将模组 ID 加入已启用列表`Mods/enabled.json`。模组会在下次服务器启动时加载。重启前确认玩家已退出，以免中断游戏。

## 修改模组

1. 在`TMapOnlineSystem`中找到相关事件 handler。如果逻辑过多，移到职责清楚的独立类中。
2. 从头到尾追踪消息：谁发送、Python 服务的谁接收。
3. 在游戏循环中读取 Terraria API。向网络任务传递已准备好的消息。
4. 为重要事件添加唯一 ID，并在服务确认前重发。
5. 使用`python3 tools/build-mod.py`为目标 tModLoader 版本构建。
6. 未单独收到安装和启动请求时，不要把`.tmod`复制到运行中服务器配置档，也不要重启服务器。

事件 handler 是游戏事件发生时运行的代码，例如方块变化。唯一 ID 能让服务识别已接收的事件，避免重发时生成重复记录。
