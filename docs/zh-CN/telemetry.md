# 遥测与 API

遥测是模组自动发送给网页服务的游戏数据。服务接收并验证数据、保存需要的历史，并向浏览器提供整理后的响应。Map Ping 也通过同一通道在游戏与浏览器之间双向传输。

## 模组数据流

模组在`server.telemetry_host`指定的地址上打开`server.telemetry_port`并等待连接。Python 客户端通过 TCP（两个程序间的网络连接）连接。连接成功后，模组开始发送数据。每行 JSON 是一条记录，这种格式称为 JSONL。`schemaVersion: 1`标识记录格式版本。记录包含服务器、世界、玩家、NPC 和地图对象状态。断线后 Python 客户端会自动重试；遇到格式错误的行会跳过并继续读取。

每条完整记录（某一时刻状态的 snapshot）都有`snapshotId`。Python 客户端成功读取并保存后会返回 ACK，即接收确认：`{"ackSnapshotId":123}`。死亡事件可能发生在两次 snapshot 之间，因此有独立的`id`。模组会重发未确认事件，收到 ACK 后才从队列移除。死亡标记保留时间由`storage.death_retention_seconds`设置；`0`表示不自动清理。

玩家和 NPC 会发送`Player.direction`与`NPC.spriteDirection`中的方向，供浏览器正确翻转精灵图。可选字段`respawnPending`表示玩家仍处于死亡状态，或复活后坐标尚未变化。值为`true`时，地图隐藏旧位置的普通玩家标记，但保留死亡叉号。

payload 是模组发送的一条记录内容。兼容性变更可添加可选字段，旧接收端可以忽略。如果修改已有字段的含义或类型，应提升 schema 版本，并在迁移期间让接收端同时读取新旧版本。不要在消息中加入密码、token 等秘密。

## HTTP endpoints

HTTP 是浏览器向服务器请求网页或数据的常见方式。`GET`读取数据，`POST`发送数据，`DELETE`删除指定数据。`?`之后是查询参数，例如`x=10&y=20`表示瓦片坐标。本表中的`x`和`y`以游戏瓦片为单位。

表中`id`表示玩家 ID，`world`表示世界名，`days`表示历史天数，`since`表示只获取该标记之后的新变化。feature flag用于告诉界面某项功能是否可用。

| Endpoint                                                   | 用途                                      |
| ---------------------------------------------------------- | ----------------------------------------- |
| `GET /api/status`                                          | 服务器、玩家、首领和历史的汇总状态。      |
| `GET /api/world-map`                                       | 地图元数据和图层，不包含完整像素块。      |
| `GET /api/world-map?tiles=0`                               | 兼容的完整地图 JSON，包含像素块。         |
| `GET /api/world-map?since=...`                             | 地图更新差异。                            |
| `GET /api/world-map/tile-info?x=...&y=...`                 | 本地化方块/墙壁说明。                     |
| `GET /api/world-map/exploration?id=...&world=...`          | 玩家探索图像。                            |
| `POST /api/world-map/import-player-map?id=...`             | 从 debug 页面导入`.map`并合并新探索瓦片。 |
| `POST /api/world-map/export-player-map?id=...`             | 根据已保存数据导出`.map`。                |
| `DELETE /api/world-map/import-player-map?id=...&world=...` | 仅清除地图中导入的部分。                  |
| `GET /api/resource-history?days=...`                       | 服务器资源历史。                          |
| `GET /healthz`                                             | 本地检查 HTTP 服务是否可访问。            |
| `GET /api/site-config`                                     | 界面功能开关。                            |

静态界面文件（CSS、JavaScript 和固定图片）位于`/assets/`。玩家、NPC 和首领图片从数据目录通过独立 API 地址提供。

手动检查时，可在浏览器打开地址或从命令行发送请求。先访问`/healthz`确认 HTTP 服务运行；这不能证明模组已连接或地图已收到。之后再检查`/api/status`和`/api/world-map`。
