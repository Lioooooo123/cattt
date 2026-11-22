# API v2 成员资源契约

R4.7 在现有 Gateway 上提供记忆、回避和成员日记资源，HTTP 回环与 LAN HTTPS 使用同一份契约。设备用配对取得的 Bearer token，服务端从凭证确定家庭、成员、设备和宿主，请求体不接受归属字段。带聊天来源的操作同时核对会话可见性、消息归属和消息修订。

## 路由

下表路径均以 `/v2` 开头。列表返回当前可见记录。新建成功为 HTTP 201，本机更正、撤回及其同键重试为 HTTP 200。跨宿主记忆操作的受理及查询见下文。

| 方法与路径 | 请求体中的业务字段 | 回包 |
|---|---|---|
| GET `/memories` | | `{ memories }` |
| GET `/memories/:id` | | `{ memory }` |
| PATCH `/memories/:id` | `value` | `{ memory }` 或 `{ action }` |
| DELETE `/memories/:id` | | `{ memory }` 或 `{ action }` |
| GET `/memories/:id/requests/:requestId` | | `{ action }` |
| GET `/boundaries` | | `{ boundaries }` |
| GET `/boundaries/:id` | | `{ boundary }` |
| POST `/boundaries` | `description`、`source` | `{ boundary }` |
| PATCH `/boundaries/:id` | `description` | `{ boundary }` |
| DELETE `/boundaries/:id` | | `{ boundary }` |
| GET `/conversations/:conversationId/messages/:messageId/usage` | | `{ source }` |
| POST `/conversations/:conversationId/messages/:messageId/withdraw` | | `{ source }` |
| GET `/diary` | | `{ entries }` |
| GET `/diary/:id` | | `{ entry }` |
| POST `/diary` | `text`、`recorded_at`、`local_day`、`time_zone`，可选 `cat_allowed`、`source` | `{ entry }` |
| PATCH `/diary/:id` | `text` | `{ entry }` |
| PATCH `/diary/:id/cat-allowed` | `cat_allowed` | `{ entry }` |
| DELETE `/diary/:id` | | `{ entry }` |

所有写入的 JSON 体包含 UUID `request_id`。修改、授权和撤回还需要正整数 `expected_revision`。新建资源修订从 1 起，署名来自 Actor。日期、时间及来源锚点在日记创建时固定。时间值使用 Unix 毫秒，`local_day` 使用 `YYYY-MM-DD`，按 `time_zone` 核对日期并保留传入时区标识。日记正文保留空白，最多 20,000 字符并须有非空白字符。记忆更正和回避说明去掉首尾空白后限 1–2,000 字符。

## 读写权限和投影

活跃资源共有 `id`、`revision`、`updated_at` 和值为 `null` 的 `deleted_at`。写入成功后的墓碑只返回 `id`、`revision` 与毫秒值 `deleted_at`。

- **记忆**含 `subject_member_id`、`predicate`、`value`、`source`、`can_edit`。两人各自可见关于自己的记忆和共同记忆。本人可更正或撤回关于自己的记忆，来源成员可更正或撤回自己提供的共同记忆。共同主体用 `subject_member_id: null` 表示。更正保留原来源，更新该行的值和修订。撤回屏蔽同主体、同指纹的旧事实，并为本宿主原创的已有记录写墓碑。共同主体的操作范围还按来源成员隔开。共同记忆由双方联合确认或更正的规则留给后续产品决定。
- **回避**含 `subject_member_id`、`description`、`source`。本人读写自己的规则。新建规则锚定本人发出的有效消息，同一消息修订只能建立一条。撤回后旧消息修订无法重新创建该规则。回避通过现有 `assessKnowledgeUse` 按受众生效。
- **日记**含 `owner_member_id`、`text`、`recorded_at`、`local_day`、`time_zone`、`cat_allowed`、`cat_readable`、`source`、`can_edit`。同家庭的有效成员可以互读，作者可修改正文、变更许可和撤回。默认 `cat_allowed: false`。该字段保留作者的开关状态，`cat_readable` 还核验关联聊天来源是否有效。来源撤回时，日记正文仍供成员读取，团子读权限立即失效。保留原有 `assessKnowledgeUse` 对团子候选引用的修订、来源和回避复核。
- **来源**引用提交 `{ conversation_id, message_id, revision }`。资源中可展示的出处为 `{ member_id, conversation_id, message_id, revision }`。伴侣单聊、已停用来源及无聊天出处的日记返回 `source: null`。资源回包均省去原话。查看来源用途和撤回由消息作者操作，回包为 `{ conversation_id, message_id, revision, allowed }`。撤回保留聊天历史和消息修订，另记知识来源撤回行。

## 冲突和重试

错误使用 `{ error: { code } }`。设备凭证无效返回 401 `unauthorized`，格式或日记日期无效返回 400 `invalid_request`。不存在、不可读、无权改写或已删除目标返回 404 `not_found`。已授权目标的期望修订不匹配返回 409 `revision_conflict`。重复创建同一回避锚点也使用这个状态。成员使用同一个请求键改写业务参数、操作或路径返回 409 `idempotency_conflict`。本人可见的聊天来源撤回后，用它创建资源或再次开启日记许可返回 409 `source_unavailable`。

客户端在网络结果未知时持久保存原请求键和原业务字段。宿主在一个 SQLite 事务内保存变更与收据，收到相同请求后重新投影当前状态。较早的授权回执会反映后续撤销，较早的创建回执可以返回墓碑，投影已失效时返回 404。遇到修订冲突时重新读取，用户确认新变更后使用新键。按当前修订重复设置同一团子读取许可时保持该修订。

## 跨宿主记忆更正与撤回

设备只在当前成员的 home host 提交或查询。访问其它宿主返回 HTTP 409 `wrong_home_host`，`error.writer_host_id` 指回本人 home host。home host 在校验设备、成员、事实来源、用途许可和预期修订后，按事实的 `origin_host_id` 固定目标，在同一事务持久化 peer outbox、重试作业和设备请求收据。已配对的原创宿主离线时仍可受理。缺少可写结对或该原创宿主的复制水位时返回 HTTP 409 `peer_write_unavailable`，手机继续保留原请求。

`{ action }` 始终包含 `request_id`、`memory_id`、`writer_host_id`、`receipt_url`、`status`。同一成员可在原配对 HTTPS origin 下查询该相对路径。重复提交同键与相同内容也会返回这条请求的当前状态。查询不返回记忆值、原话正文、来源消息 ID 或会话 ID，内容仍从 `/v2/changes` 读取。

| HTTP | 状态 | 意义 |
|---|---|---|
| 202 | `queued` | 本人宿主已持久受理，等待投递 |
| 202 | `waiting_for_peer` | 仍在重试投递或等待有效回执 |
| 202 | `waiting_for_replication` | 已确认原创提交，正在等待本方落盘或看到原创修订 |
| 200 | `applied` | 已完成，`resulting_revision` 是此次操作提交的修订 |
| 200 | `rejected` | 原创宿主或投递协议拒绝，`error_code` 说明原因 |

两台宿主通过 mTLS 的 `/peer/inbox` 投递 `memory_action`，信封中的 `source` 为 `{ kind: "memory", id, rev }`，幂等键为 `memory_action:<memberId>:<requestId>`。负载含 `operation`（`memory.revise` 或 `memory.forget`）、`actor_member_id`、`request_id`、`source_member_id`、`source_message_id`、`source_revision`、`memory_hlc`、`writer_generation`，更正还含 `value`。原创收据的 `admission_id` 为目标记忆 ID，`memory_write` 含此次提交的 `revision` 和 `hlc`。

来源宿主须为操作者的 home host。原创宿主在写事务中复核家庭、成员资格、主体或共同来源、原话修订、用途许可、事实 HLC 及原创复制世代。更正保留事实来源。撤回为目标修订写墓碑，收到原创收据后由主体 home host 落盘同指纹屏蔽。两者分别沿现有增量通道复制。原创修改和 Inbox 成功收据在同一事务提交，回执丢失时同键重放返回该收据。复制世代变化、已有更正或删除会拒绝旧请求（`revision_conflict`）。来源用途失效返回 `source_unavailable`，成员已无权返回 `not_found`。

手机沿用现有待提交档案。首次 202 后持久化相对查询路径，重新打开或查询时使用原配对 origin 和同一请求键。网络中断、未完成和终态拒绝保留原草稿或待撤回记录。收到 `applied` 后清理该待提交项，并刷新成员增量。

## 通用同步接入

R6.9 复制 `memories`、`memory_blocks`、`boundaries`、`diary_entries` 和 `knowledge_source_withdrawals` 的稳定 ID、归属、`rev`、`hlc` 与墓碑，附带抽取及回复证明。成员 HTTP 收据以宿主本地 SQLite 持久化。

设备投影使用 `host/src/member-resources/projections.ts`，输入经过可用资源仓储筛选。来源撤回、来源修订变化、提取依赖失效或屏蔽可改变同业务修订的投影。R8.7 的 `/v2/changes` 会撤下受影响的记忆和回避，并刷新日记的 `source` 和 `cat_readable`。iOS 接入、DTO 和游标见 [API v2 成员增量契约](API-v2-成员增量契约.md)。

## R8.17 旧手机日记接续

- `GET /v2/diary/legacy` 返回 `{ source_account_id }`。只有 R9.1 已导入收据的家庭、宿主、成员与当前认证设备一致时，才返回旧账号 UUID；其余有效成员收到 `null`。iOS 先与已有 v1 配对的账号 ID 核对，然后读取该配对的日记文件。
- `PUT /v2/diary/legacy` 接受 `request_id`、`source_account_id`、`client_id`，另可携带 `cloud_id`、`revoke_cat_access` 或 `draft`。已知云端 ID 的操作不携带草稿。草稿字段为 `text`、`recorded_at`、`local_day`、`time_zone`、`cat_allowed`，校验与新建日记一致。宿主在写入事务中复核身份，成功返回当前 `{ entry }`，支持墓碑回包。归属或明确来源不匹配时返回 `not_found`。
- 宿主沿用 PG 归档中的旧 ID 和旧 `client_id` 对齐稳定资源 ID。有先前云端 ID 时核对两者；手机未收到 v1 写入回执时按 `client_id` 对齐。存在对应资源时保留 v2 当前正文、日期、阅读许可和墓碑，只有待同步的阅读撤回可关闭当前许可。同键重试使用原收据，回包反映当前版本。
- 手机独有的草稿按旧成员与 `client_id` 映射到同一 v2 日记 ID。成功接续后沿用 `/v2/changes` 获取正文、权限和删除更新。宿主从已存在的 R9.1 收据及归档读取身份和映射。
