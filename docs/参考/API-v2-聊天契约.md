# API v2 聊天契约

状态：**R3 已实现**：对话与消息、轮次运行、取消、重答、轮次 SSE，以及 R3-3 的真实模型 ChatReplier 与双成员 HTTPS 端到端验证。生成器仍可通过 Replier 注入，完整上下文、记忆、soul 和边界控制属于 R4；下文 R3-1 的 turn=null 描述保留为阶段边界，当前发送按所述 R3-2 行为返回回复 Turn。本篇供 iOS 协议层与 host 并行开发，不是实施方案。适用新 `host/`，不兼容旧 `server/` 的 `/v1`。依据[目标架构 §3、§4.3、§4.4、§6.1](../方案/情侣共享团子目标架构-方案-2026-11-22.md)。本契约与方案一致，细化单聊的设备 API 展示限制、幂等响应和稳定分页，不改变全量副本边界。

## 1. 通用规则

- 回环 HTTP 与 LAN HTTPS 的 `/v2` 契约相同。除身份模块的配对/邀请接受接口外，以下全部接口需要 `Authorization: Bearer <device_token>`；身份来自 Actor，不能由请求体自报作者。
- JSON 字段一律 snake_case，时间为毫秒 epoch 整数。服务端业务 ID 为 UUIDv7；client_message_id 为客户端不透明字符串，request_id 为客户端生成的合法 UUID，不要求其等于 turn.id。
- 错误形状：`{"error":{"code":"invalid_request","message":"可选说明"}}`。客户端按 code 分支，不解析 message。
- 同一命名规则也适用于身份与 `/host` 管理接口：healthz 返回 `{ok, host_id, protocol_version}`；me.actor 为 `{member_id, device_id, host_id, household_id}`；me.member、members 列表与 pair.member 为 `{id, household_id, display_name, home_host_id}`。成员引导及邀请接受保留完整成员元数据，字段为 origin_host_id、hlc、rev、created_at、updated_at、deleted_at。内部 Actor/仓储可以用 camelCase，不作为线上的 JSON 格式。

| HTTP | code | 含义 |
|---|---|---|
| 400 | invalid_request | 请求体、路径 ID、分页游标或限额不合法 |
| 401 | unauthorized | 无效、缺失或已撤销的设备凭证 |
| 404 | not_found | 资源不存在，或当前 Actor 不可见；不暴露伴侣单聊是否存在 |
| 409 | idempotency_conflict | 相同幂等键被用于不同内容或不同目标 |
| 409 | not_publisher | 写请求未到达此对话的发布宿主，不在本副本代为写入或生成 |
| 500 | internal_error | 未处理的内部故障；不返回异常堆栈或内部细节 |

认证优先于资源操作；合法 ID 对应的不可见对话先按 404 处理，不泄露其发布宿主。只读历史可来自副本，所有发送、取消、重答都须在发布宿主复核权限与幂等性。R3-1 不提供自动跨宿主转发。

## 2. 对话与可见性（R3-1 已实现）

一个家庭恰有一个 group，成员为全部活跃家庭成员；每个成员恰有一个 direct，隐含团子加该成员。participant_member_ids 只列人类成员，不为团子虚构 member_id。家庭创建时建立 group；成员创建与其 direct、group 参与关系在同一事务完成。加入/移除自动维护参与关系；启动幂等补齐 R2 已有成员。移除成员保留历史事实与参与者墓碑。

- group：Actor 必须属于该家庭且是当前参与者。
- direct：仅 owner_member_id 对应的 Actor 可见；伴侣请求该单聊及其消息、轮次均 404。**单聊不对伴侣展示是产品与设备 API 规则，不是存储保密边界**；完整业务副本仍可能包含伴侣单聊。不要用通用“同家庭可读”代替 canSeeConversation。
- direct 的 publisher_host_id 为拥有者当前 home_host_id；group 当前由建立它的本宿主发布，群聊租约与跨 Mac 归属在 R6 接入。

Conversation 字段：

| 字段 | 类型 |
|---|---|
| id | UUIDv7 |
| kind | group / direct |
| owner_member_id | UUIDv7 或 null；group 为 null |
| participant_member_ids | UUIDv7 数组，稳定按成员 ID 排序 |
| publisher_host_id | UUIDv7 |
| created_at | 毫秒整数 |
| last_message | 下节 Message 或 null；按消息排序键取最新一条 |

- `GET /v2/conversations` → 200 `{"conversations":[Conversation]}`。顺序：group，然后 Actor 自己的 direct；不返回伴侣 direct。
- `GET /v2/conversations/:id` → 200 Conversation；不可见则 404。

## 3. 消息（R3-1 已实现）

Message 字段：

| 字段 | 类型与语义 |
|---|---|
| id | UUIDv7 |
| conversation_id | UUIDv7 |
| cursor | 不透明消息排序游标；不是 SSE 游标或全局 seq |
| author | `{"kind":"member","member_id":"…"}` 或 `{"kind":"cat"}` |
| text | 文本 |
| modality | 固定 text |
| status | complete / stopped |
| client_message_id | 字符串或 null |
| reply_to_message_id | UUIDv7 或 null |
| turn_id | UUIDv7 或 null；R3-1 发送结果为 null |
| created_at | 毫秒整数 |

### 历史分页

`GET /v2/conversations/:id/messages?before=<cursor>&after=<cursor>&limit=<n>`

200 返回 `{"messages":[Message],"has_more_before":false,"has_more_after":false}`。

- 默认 limit=50，范围 1..100；超限、非整数、坏游标返回 400 invalid_request。
- 消息以 `(hlc, id)` 二进制字典序稳定排序，响应永远升序；相同物理毫秒乃至完全相同 HLC 仍用 id 决定次序。不得用 created_at 或全局递增序号代替。
- 无边界取最新一页；仅 before 取该键之前最近一页；有 after 时取该键之后最早一页。两个边界可以同时存在，此时返回开区间 `(after, before)` 内最早一页。
- before/after 均为严格边界，不重复边界消息。游标只表达排序键，不要求原消息行仍存在；客户端不构造或解析它。
- 非空页的两个 has_more 标记表示完整会话历史中是否还有早于首条、晚于末条的消息，不只针对请求窗口。空页：有 after 时 has_more_before 表示是否存在不晚于 after 的消息；有 before 时 has_more_after 表示是否存在不早于 before 的消息；其它方向为 false。空历史两者均 false。

### 幂等发送

`POST /v2/conversations/:id/messages`

```json
{"client_message_id":"本次发送的持久请求键","text":"  你好，团子  "}
```

- client_message_id 长度 1..100，不自动 trim；text trim 后长度 1..4000。只接受这两个字段，非法请求为 400 invalid_request。
- 新发送 201 `{"message":Message,"turn":null}`；同一成员、同一对话、相同 client_message_id 和规范化后 text 重放为 200，同一响应体，不新建消息或轮次。更换 text 为 409 idempotency_conflict。
- 唯一键是 `(conversation_id, author_member_id, client_message_id)`；群聊 A 与 B 即便采用相同客户端键，也分别归属各自成员，不互相去重。
- 作者取 Actor；新消息 status=complete、modality=text、reply_to_message_id=null。R3-1 只持久化用户消息，**不调用模型、不发布轮次事件，turn 始终 null**。
- R3-2 返回该次发送创建的回复 Turn；重放仍指向最初发送的响应，不改绑之后的重答轮次。轮次最新状态通过 GET Turn 刷新。以后群聊策略决定团子不回复时仍可返回 null，客户端必须支持 null。

## 4. 轮次（R3-2 已实现）

下列路径已在 R3-2 实现，R3-3 已接入 ChatReplier；接口及事件形状不变。Turn 是发布宿主的本机执行资源，不随业务事实复制后自动运行。所有嵌套资源都验证 conversation_id、可见性及 turn/message 是否确属该对话；不是只验 UUID。

Turn 字段：

| 字段 | 类型 |
|---|---|
| id | UUIDv7 |
| conversation_id | UUIDv7 |
| status | queued / generating / completed / stopped / superseded / failed |
| trigger_message_id | UUIDv7，触发它的成员消息 |
| reply_message_id | UUIDv7 或 null |
| error_code | 字符串或 null |
| stream_url | `/v2/conversations/:id/turns/:turnId/stream` 相对路径 |

`GET /v2/conversations/:id/turns/:turnId` → 200 Turn。queued 可进入 generating，二者可进入终态；completed、stopped、superseded、failed 均为终态，不被重试或迟到执行结果改回生成中。终态回复 Message.status 使用 complete/stopped，而非 Turn 的 completed。

### SSE、重放与快照

`GET /v2/conversations/:id/turns/:turnId/stream`

- `Content-Type: text/event-stream`。恢复优先取 Last-Event-ID 请求头，否则 `?last_event_id=`；都没有则从头。与消息分页 cursor 是不同命名空间。
- SSE `id` 为 R1 chat-events 的不透明 `<hostId>.<seq>` 游标；客户端原样保存。每 15 秒空闲时发送注释心跳，心跳没有业务 id。
- 合法且仍保留的游标只回放其后的事件，再接实时尾部；提交后唤醒，一秒持久轮询兜底。终态前须排空尾部，断开清理订阅。
- 非法、异宿主、越界或已过期而不可回放的游标**改走 snapshot，不把重复全文当 delta 追加，也不沿用旧占位接口的 410**。snapshot.text 替换客户端当前全文，然后继续后续增量，或补齐已有终态。
- 恢复基于持久事件/轮次快照/最终消息，而非仅靠进程内字符串；事件保留沿用终态 10 分钟、非终态自最后事件起 1 小时。终态后的断线恢复仍能从业务结果给出完整快照和终态；快照不要求旧 v1 的额外协商头。

| event | data | 处理 |
|---|---|---|
| accepted | `{turn_id, trigger_message_id}` | 绑定轮次及原消息 |
| delta | `{text}` | 追加文本 |
| snapshot | `{text}` | 替换迄今全文，不追加 |
| superseded | `{turn_id, by_turn_id}` | 终态，被新轮次取代 |
| done | `{message_id:null或UUIDv7, status:"completed"或"stopped"}` | 终态，刷新持久消息 |
| error | `{code, retryable}` | 终态；code 为错误标识，retryable 为布尔值 |

示例帧（JSON 始终单行）：

```text
id: <hostId>.<seq>
event: delta
data: {"text":"你好"}

```

### 取消与重答

- `POST /v2/conversations/:id/turns/:turnId/cancel {visible_length?}` → 200 Turn。visible_length 为非负安全整数，单位 **UTF-16 code unit**，不是码点/字素/UTF-8 字节。省略则不指定额外截断；提供时停止只保留不超过已生成文本及该可见长度的前缀，0 表示不保留回复正文，reply_message_id/message_id 可为 null。客户端应传真实显示边界。重复取消不产生第二条回复；已终态返回既有 Turn，不覆写为 stopped。
- `POST /v2/conversations/:id/messages/:messageId/reply {request_id}` → 首次 201 Turn，重复 200 同一 Turn；只对成员消息重答，不新增用户消息或改变原作者。request_id 必填合法 UUID；客户端首次请求前持久保存，回执丢失时复用，明确开启另一次重答才生成新键。同键绑定不同目标为 409 idempotency_conflict。
- 群聊里的可见成员消息不因作者是伴侣就被当成猫消息或另一个会话；所有操作仍以 Actor 和会话权限为准，不引入 Owner/唯一会话假设。

### 取代与事务边界

同一对话的新成员消息取代该对话中尚未发出首 token 的 queued/generating 轮次；群聊 B 的消息可以取代 A 的待回复轮次，新轮次上下文须同时看到 A、B 两条消息。不跨对话取代；已发首 token 的轮次不由这一规则取代。首 token 准入与取代须串行复核，不能只根据过期内存状态。

消息/轮次状态与对应持久事件先一致提交，再唤醒；回滚不得发出 accepted、delta 或终态。取消、取代和迟到模型结果竞争时终态不能被覆盖。重答和幂等发送各自有独立请求键，不把“重传”当“再回答一次”。模型输入与真实生成接入另按 R3 后续阶段推进，不在 R3-1 伪造猫回复。

## 5. 当前接入边界

R3 已可验证一个群聊、两个各自单聊、作者署名、幂等发送、历史分页、成员增删维护、取消、重答、取代及 SSE 恢复；R3-3 提供 OpenAI 兼容/DeepSeek 流式模型接入及 mock 端到端测试。MODEL_PROVIDER 未设置或 echo 时仅开发回声；mock 不发模型网络请求。旧 R1 `/v2/streams/:streamId/events` 已移除，SSE/TLS 回归已迁到本篇正式授权轮次流。iOS 新协议层只使用本篇正式资源路径。
