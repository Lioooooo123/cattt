# API v2 共享院子契约

适用范围为 Bun 宿主。设备使用原有配对凭证与 LAN HTTPS。以下路径的共同前缀是 `/v2/world`。场景仍为 4，位置、活动、动作完成及降级判据沿用现有 3D 协议。院子协议注册版本为 2。

| 方法与路径 | 请求与响应 |
| --- | --- |
| `POST /sessions` | 传 `{protocol_version: 2}`。返回 `session_id`、`generation` 与当前院子视图。同一成员在同一宿主重新注册时替换上一会话。凭证绑定成员及设备。 |
| `GET /state` | 返回院子视图。发布宿主与副本均可读取。 |
| `PUT /state` | 传 `{session_id, generation, base_revision, snapshot}`。成功后返回院子视图。 |
| `PUT /profile` | 传 `{base_revision, name, appearance, temperament, traits}`，四条特征取 0–2。成功后返回院子视图。 |
| `GET /events` | 查询参数为 `session_id`、`generation`。返回 SSE。 |
| `POST /actions` | 传 `{session_id, generation, request_id, destination_id, state_version, activity?}`。本轮支持移动及可选的 `activity: "sit"`。只接受写入宿主上有新鲜观察和 SSE 心跳的执行会话。按家庭、成员及客户端 UUID 去重。同键改地点或活动返回 409。 |
| `GET /actions/:id` | 返回本人动作收据。可在本地副本读取已复制的收据。 |
| `POST /actions/:id/ack` | 传 `{session_id, generation, status, snapshot, reason?, occurred_at?}`。绑定命令原执行会话及原发布代次。`occurred_at` 为对齐宿主时间的 ISO 8601。 |

## 视图、版本和重连

院子视图包括 `world`、`behavior`、`server_time`、`publication`、`execution_available` 与 `presence`。

`snapshot` 包含 `state_version, scene_version, destination_ids, current_destination_id, target_destination_id, phase, action, paused, runnable`。可附 `companion_seat, activity, activity_fallback, mood, mood_reason, day_phase, weather, bowl_filled_today, last_drink_at, places_today`。所有外部 JSON 键使用 snake_case。设备时钟对齐和动作期限字段 `server_time, accept_before, finish_before, occurred_at` 使用 ISO 8601。业务投影时间 `adopted_at, updated_at, observed_at` 使用 Unix 毫秒。

- `world` 有家庭稳定的猫 UUIDv7、资料、`snapshot`、`observed_at` 和不透明的 `revision`。尚无共享记录时为 `null`。设备须以当前 `world.revision` 作为 `base_revision`。看到 `world_revision_conflict` 后先重新读取和应用共享状态，再上报。已被同一会话保存的相同快照可安全重试。相同 `snapshot.state_version` 必须内容相同，该版本由设备在当前会话内递增。
- `behavior` 是气质、四项特征和领养日期计算出的当前行为参数。现有外观键为 `orange/cow/black/calico`，气质键为 `slow/close/quiet/curious`。设备可继续用现有行为表。
- `publication.status` 为 `ready`、`remote` 或 `waiting`，含 `publisher_host_id`。写请求到副本返回 409 `not_publisher` 与宿主 ID。租约证据失效返回 409 `publication_lease_pending`。客户端可保持观测、等待重试，或经现有寻址和配对流程连接写入宿主。本批没有跨宿主转投院子操作。
- 单一活跃会话控制共享院子。观察超过 5 秒、成员设备撤销、会话被替换或暂停后，另一有效会话可从最新共享修订接管。活跃控制者在场时，旁观者尝试写状态收到 `world_driver_active`。提交动作还要求 3 秒内的 SSE 心跳。服务端重启清空会话与执行绑定。收到 `session_replaced` 后须重新注册。
- `presence` 是 `[{member_id}]` 的短时观察。注册、状态上报与 SSE 保活可刷新本机在场，TTL 为 12 秒。已配对宿主间通过 `GET /peer/world-presence` 的 mTLS 观察合并。在 peer 不可达时返回本机在场成员。在场和执行资格均独立于业务副本的同步水位。非写入宿主也可在开始 SSE 后保持在场。
- 成员增量的 `kind: "world"` 和 `GET /state` 的 `world` 用同一 DTO。设备可通过增量原子保存业务视图与游标。在场、租约证据、会话与凭证只走相应运行时接口。

SSE 连接先给 `world_state` 与 `presence`，随后送变化、`heartbeat`、发给当前执行会话的 `action` 和本人最近 50 条动作的 `action_status`。同会话重连时，服务端重发当前状态、动作收据及仍待接收的命令。设备按动作 ID 去重并保留未交付的原回执。较早的动作可按 ID 查收据。事件流按当前视图恢复，`Last-Event-ID` 不作全量历史游标。会话失效时发送 `world_error` 并关闭，重连前的校验失败直接返回 HTTP 错误。

接收窗口为 5 秒，完成窗口为 60 秒。陪坐成功需要真实落座且未使用降级动画。曾在期限内完成的动作可补发带时间的到达回执，且只允许恢复执行超时。旧代被封停后未完成的收据呈现 `interrupted/publication_changed`。状态快照可随更新恢复，历史动作不会重新分发。

## 复制、迁移及接入

peer 握手版本为 7。三种原生复制记录为 `world_cat`、`world_state`、`world_action`。适配器校验家庭、原始宿主、租约代次及凭据。动作完成与对应的院子观察同次提交、同组增量复制。交接历史摘要包含被封停代次的共享院子资料和动作收据。原家庭宿主负责首次认领团子。已有 0021 接管记录而原始猫仍在原宿主归档的家庭，先把发布权交回原宿主完成恢复。该场景在当前宿主返回 `world_history_pending`，并维持本机会话。

`0024_r8_shared_world` 追加在 `0023_r4_model_runtime` 之后。旧猫原 ID 保留在 `profile.legacy_id`，同一个已验证旧猫有确定的 UUIDv7。经核对的最后一次 3D 观察可恢复为静止位置和饮水、天气等事实。旧动作、执行连接及 Soul 版本留在本机导入归档。旧客户端若仍调用 `/v1/world`，继续走旧服务。iOS 已接入首帧同步和 3D 可视执行，见 [R8.16 iOS 共享小院桥接](../决策/2026-11-22-R8.16-iOS共享小院桥接.md)。R4.13 加入猫日记观察和当前成员的 `soul` 投影，见 [共享 Soul 与猫日记](API-v2-共享Soul与猫日记.md)。聊天模型世界动作工具由后续宿主工作接入。
