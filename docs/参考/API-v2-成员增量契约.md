# API v2 成员增量契约

宿主的设备 API 提供 `GET /v2/changes`。手机通过已固定 CA 的 LAN HTTPS 和配对取得的 Bearer token 请求本人的 home host。回环管理环境也可用同一设备接口。聊天仍走会话历史和轮次 SSE。附件字节、缩略图和描述生成走现有 `/v2/files`。

## 请求和响应

| 参数 | 约定 |
| --- | --- |
| `cursor` | 首次拉取或收到 reset 后省略。之后原样使用上一次成功提交的 `next`。空串、重复参数和未定义的查询参数为 400。 |
| `limit` | 可选，十进制正整数 1–100，默认 50。它限制单页条数，续页允许调整。 |

HTTP 200 JSON 包含 `generation: String`、`reset: false`、`changes: [MemberChange]`、`next: String`、`has_more: Bool`。返回 `Cache-Control: private, no-store`。`next` 始终有值，空页也要提交它。游标加密并验真，绑定家庭、成员、本机 home host、该宿主恢复世代和服务端分页状态。同一成员重新配对后可以继续使用该范围内的游标。

| 状态 | JSON 与客户端处理 |
| --- | --- |
| 400 | `{ "error": { "code": "invalid_request" } }`。请求格式无效。 |
| 401 | `{ "error": { "code": "unauthorized" } }`。使用原配对流程处理凭证，保留待发送的本地操作。 |
| 409 | `{ "error": { "code": "wrong_home_host", "writer_host_id": "…" } }`。当前设备凭证可验证，但宿主不是成员的 home host。切回已配对且已核验的 home host。 |
| 409 | `{ "error": { "code": "cursor_reset_required" }, "reset": true, "generation": "…" }`。格式有效的游标无法验真，或游标范围、世代、服务端版本或位置已不可用。清理这份远端缓存和游标后省略 `cursor` 重拉。 |
| 500 / 网络失败 | 保持上次成功落盘的缓存和游标，从同一游标重试。 |

## 变更 DTO

每个条目含 `kind`、`id`（资源 UUID）、`sequence`（正整数，可解码为 `Int64`）和 `op`（`upsert` 或 `delete`）。`upsert` 带完整 `value`，其 `id` 与信封一致。墓碑只带四个信封字段。`sequence` 是该成员在该 host 和世代里的设备投影顺序，可能跳号。它与业务 `revision` 或 `rev` 独立，后者继续用于提交写请求或读取特定附件版本。

| `kind` | `value` 字段和可见范围 |
| --- | --- |
| `memory` | `id, revision, updated_at, deleted_at, subject_member_id, predicate, value, source, can_edit`。本人主体和共同记忆。来源或提取依赖失效、事实屏蔽时撤下。 |
| `boundary` | `id, revision, updated_at, deleted_at, subject_member_id, description, source`。本人回避。其依据不可用时撤下。 |
| `diary` | `id, revision, updated_at, deleted_at, owner_member_id, text, recorded_at, local_day, time_zone, cat_allowed, cat_readable, source, can_edit`。家庭活跃成员可读共享内容。原话用途撤回后保留正文，由新的投影更新 `source` 和 `cat_readable`。 |
| `file` | `id, owner_member_id, conversation_id, source_message_id, source_message_rev, sha256, byte_size, file_name, media_type, description, rev, created_at, updated_at, available`。与附件详情一致，仅来自本人可读的会话。 |
| `file_description` | `id, revision, file_id, file_rev, sha256, source_message_id, source_message_rev, text, model_id, created_at`。按描述自身的 `id` 缓存，展示时关联 `file_id + file_rev`。原话用途撤回可单独移除模型描述，同时保留附件。 |
| `ticket` | `id, revision, conversation_id, for_member_id, publisher_host_id, kind, mandate_kind, source_message_id, source_revision, goal, status, stage, due_at, time_zone, ended_reason`。本人且仍可见会话内的所有事项状态，包括结束与可续办状态。 |
| `mailbox_letter` | `id, revision, conversation_id, for_member_id, publisher_host_id, ticket_id, text, created_at, read_at`。本人且仍可见会话内的来信。已读可只推进投影序号，业务修订仍为信件修订。 |
| `world` | `id, revision, adopted_at, updated_at, observed_at, profile, snapshot`。家庭活跃成员可读，同一家庭使用稳定猫 ID。见 [API v2 共享院子契约](API-v2-共享院子契约.md)。 |

记忆、回避、日记的 `deleted_at` 在 upsert 中恒为 null。时间用 Unix 毫秒。知识出处 `source` 可为 null，非空时含 `member_id, conversation_id, message_id, revision`。伴侣单聊出处会被隐去。对于授权操作，日记 `cat_allowed` 是作者开关，`cat_readable` 是复核来源后的实际值。字段形状和写入条件见 [API v2 成员资源契约](API-v2-成员资源契约.md)。

`available` 表示本次投影时当前 home host 有通过完整哈希校验后登记的原件，且磁盘文件仍存在、尺寸匹配。未完成下载或仅有对端清单时为 false。下载完成、磁盘丢失和重新获得原件都会更新投影，即使文件 `rev` 相同。下载前仍须请求 `/v2/files/:id/content`；该请求会再次检查当时的访问和原件状态。

## 分页、重试和重置

每轮从宿主当时的投影水位起步，以 `sequence` 升序分页。首次以当前活跃记录建立缓存。分页中有新版本或撤回时，旧版本随即从可读索引移除，最新 DTO 或墓碑排到该轮水位之后。一个页可以没有变更但 `has_more: true`，表示当前范围已经排空，下一页继续追新水位。持续请求至 `has_more: false`，下次进入前台或重连仍从那一页的 `next` 增量拉取。

同一旧游标的重试可能返回更新后的当前投影。客户端用 `(kind, id)` 作为主键，以 `sequence` 判定该世代内同一键的先后。较新的 upsert 完整替换 DTO，避免保留已被裁掉的出处或权限。较新的墓碑清除内容及展示索引，并保留该键的最近序号，避免旧页重放复活。一次本机事务中提交资源、墓碑和 `next`，包括空页。每个同步空间串行追页，过时请求的响应不得回退空间游标。

远端缓存按配对确认的 `(household_id, host_id, member_id)` 隔离，和设备本地模拟空间、未上传的草稿及出队请求分开。重置时只清该空间的远端副本、设备变更序号和游标，保留未上传日记、未确认写入和待同步的撤回及其请求键。重新构建后以资源写入契约查询最新业务版次并处理冲突。若配对切换或请求已经被替换，忽略旧响应。

## iOS 接入

- 通过 `V2Vault` / `V2Connection` 复用凭证和固定 CA 的会话，使用配对结果的家庭、成员和 home host 建立存储键。续接前可用 `V2Client.me()` 校验当前 Actor。
- 在 `V2Client` 以 `URLQueryItem` 传入原始游标，在 `V2Models` 以 `kind + op` 解码资源或墓碑。当前通用 `V2Client.validate` 只抛错误码。changes 接入需要保留 409 响应体，读取 `reset`、`generation`，并和 `wrong_home_host` 区分。
- 同步任务可在前台进入、重连和资源写入确认后唤醒，按空间串行追页。远端副本落盘后再刷新界面。墓碑出现后，针对该旧对象的待发改写或授权按冲突处理，保留单独排队的用户撤回和未上传草稿。
- 旧端可跳过尚不支持的 `kind` 并照常提交该页。客户端升级并新增缓存类型时，从无游标重新建立该空间的远端缓存，补齐此前跳过的资源。

## 宿主适配入口

Gateway 挂载 `memberChangesRoutes`。适配器遵循 `MemberProjectionReader`，接收同一 SQLite 读视图和已验证的 `Actor`，输出经过现有 API 权限筛选的当前活跃 DTO。R6.11 将 `ticket` 和 `mailbox_letter` 注册在同一 reader 列表，复用事项与信箱的成员及会话范围查询。已读和权限变化经当前 DTO 或墓碑进入同一游标。设备接收业务视图，peer 日志、转投收据和作业状态保留在各自的接口和存储。

统一迁移 `0020_r6_11_knowledge_files_member_projection` 新增本机投影表。宿主每次读页在同一 SQLite 事务重算成员可见投影，按 DTO 指纹分配变更序号。索引只保存 ID、指纹、水位顺序及墓碑，页面从当前业务视图读取内容。重启沿用索引及验真密钥。备份恢复通过 `rotateReplicationGeneration` 换宿主世代再开放接口，旧手机游标会收到显式 reset。对端复制的世代更新由本机作为业务合并处理，手机仍从本机水位跟进。业务备份决定能恢复哪些原创记录与撤回证明。

## 验证

见 [R6.11 合体清单](../决策/2026-11-22-R6.11宿主与成员增量合体.md) 中的测试与环境记录。
