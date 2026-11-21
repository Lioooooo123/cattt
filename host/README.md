# 新宿主后端

R1 地基：存储、时间、单进程组件运行时与健康检查 Gateway。与 `../server/` 并行建设，尚未接入客户端或 macOS 宿主。使用 `.bun-version` 指定的 Bun 版本。

在本目录执行：

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run db:generate
bun run build
```

`src/store/index.ts` 的 `openStore(path)` 接受文件路径或 `:memory:`，自动运行 `drizzle/` 迁移，返回 Drizzle `db`、原生 `raw` 和 `close()`。文件的父目录应已存在。文件库启用 WAL，连接启用外键、NORMAL 同步和 5 秒忙等待。

业务代码通过 `src/store/` 的仓储函数访问数据，例如 `getHostMeta`、`setHostMeta`。`writeTransaction(store, callback)` 使用立即写事务；回调必须同步，不得进行异步操作，抛错时回滚。连接用毕调用 `close()`。

设计边界见[重构地基决策](../docs/决策/2026-11-22-重构地基-Bun与SQLite.md)。

## 时间与标识

应用通过 `Clock` 读取墙钟、签发 HLC 和合并远端 HLC。`SystemClock` 使用系统时间，`ManualClock` 可设置或推进时间。远端时间默认最多超前墙钟 5 分钟，可通过 `maxDriftMs` 调整；超出时抛出 `ClockDriftError`，不改变本地 HLC 状态。

HLC 包含 48 位非负物理毫秒、32 位逻辑计数与节点标识。节点标识为 1 至 64 位 ASCII 字母、数字、下划线或连字符。`encodeHlc` 编码为 `<12 位小写十六进制毫秒>-<8 位小写十六进制计数>-<原样节点标识>`，共 23 至 86 字符，按字节排序与 `compareHlc` 一致；`parseHlc` 只接受规范编码。逻辑计数溢出时物理时间推进 1 毫秒，物理时间超出范围则报错。

`uuidv7(clock)` 使用该时钟的墙钟毫秒与加密随机数，同一个 Clock 实例共享递增状态；同毫秒或墙钟倒退时仍按创建顺序排序。状态只在进程内保留，重启后不保证与重启前的同毫秒标识单调。HLC 同样是实例内状态，持久化恢复由后续接入层负责。

## 运行与生命周期

```sh
bun src/main.ts
# 或运行编译后的独立程序
./dist/cattt-host
```

默认数据目录为用户主目录下的 `~/.cattt/host`，可用 `CATTT_DATA_DIR` 覆盖；运行时自动创建目录，数据库为其中的 `cattt.db`。`host_meta` 的 `host_id` 键首次启动用 Clock 生成 UUIDv7，之后重用。

Gateway 回环监听默认为 `127.0.0.1:8788`，可通过 `CATTT_PORT` 设置端口（0 表示系统分配端口）。`GET /v2/healthz` 返回 `{ ok: true, host_id, protocol_version: 1 }`；未匹配的请求返回 `{ error: { code: "not_found", message: "未找到接口" } }`，HTTP 404。业务接口见下文。

`startHost(config, components)` 按顺序启动组件，共享 store、bus、clock、hostId 和 config。启动失败时逆序停止已启动组件；组件自身须清理尚未完成的启动。`stop()` 可重复调用，逆序停止组件并隔离、报告各停止错误，最后关闭数据库。SIGINT/SIGTERM 触发停止后以 0 退出。

`EventBus<Events>` 在进程内按主题分发类型化负载，发布不等待异步处理。每次发布使用订阅快照；取消订阅只影响后续发布。处理器抛错或拒绝交给构造时的 `onError`，不会影响其它处理器或发布者；错误回调自身的失败也被隔离。总线不持久化、不重放。

将来合并旧 x509/mTLS 代码时，`main.ts` 的第一个导入必须是 `import "reflect-metadata"`；当前尚未引入该依赖。

## 编译与迁移

`bun run db:generate` 仍用 drizzle-kit 创作迁移，随后运行 `scripts/embed-migrations.ts`，将 SQL、时间戳和哈希生成到 `src/store/migrations.generated.ts`。迁移文件与生成文件一起提交；手动编辑既有迁移后也须运行该脚本。漂移测试逐项对比内嵌数据与 `drizzle/`。

打开数据库使用内嵌迁移和 Drizzle 的同步迁移器，不读取磁盘迁移目录。`bun run build` 将入口编译为 `dist/cattt-host`，无需随附 `drizzle/` 或 `node_modules/`。测试会实际编译程序，在不含迁移目录的临时工作目录启动、访问健康检查，并验证 SIGTERM 正常退出。

## 后台作业

旧后端以 `async_jobs` 保存真实状态、pg-boss 只负责投递；新后端由单一 SQLite `jobs` 表同时承担状态与投递，不再需要 pg-boss 或单独的投递恢复扫描。旧 `server/` 保持不变，本批不导入旧作业。

`store/jobs.ts` 的入队、领取、完成和失败写入均使用立即事务。活跃的同队列去重键只保留一条，完成或死亡后可再次入队。领取按到期时间排序，过期运行租约可重领并增加尝试次数；次数耗尽则标死。完成与失败都须提交领取时的 `{ id, attempts }`，并同时检查运行状态和租约未过期，防止旧尝试覆盖新尝试。时间均来自 Clock。

将 `JobRunner` 作为组件传给 `startHost`，启动前用 `register(queue, { schema, handler, concurrency, timeoutMs?, maxAttempts?, backoff? })` 注册队列。处理器接收校验后的负载及宿主上下文，另含本次 `job` 和协作取消用的 `signal`。负载不通过 zod 时立即标死；处理失败默认最多尝试 3 次，退避依次为 1 秒、2 秒、4 秒，最长 60 秒。自定义 `backoff(attempts)` 返回非负整数延迟毫秒。

租期与处理超时默认 300 秒，`errand` 默认 660 秒。超时不再等待处理器，保留运行行供租约恢复，并通知 `signal`；不会强制终止 JavaScript 或撤销处理器已产生的外部副作用，业务处理器仍须幂等。默认每 250 毫秒轮询，`runner.enqueue(queue, payload, options?)` 在提交后通过 `jobs:wake` 立即唤醒。直接通过仓储入队由下一次轮询发现。并发上限按队列计算，已超时但未自行结束的旧处理器不占新的领取名额。

`stop()` 先停止领取，默认等待在途处理最多 5 秒；可用构造参数 `pollIntervalMs`、`graceMs` 调整。宽限到期后通知取消，迟到处理结果不再写库，未完成行由下一次启动按过期租约恢复。处理器应响应取消，不应在宿主停止后继续使用上下文中的数据库。当前入口尚未注册业务队列。

## 本地租约与 fencing

`leases` 为对话锁、群聊租约、单一写者和未来模型准入提供统一的本地基础。本批不迁移旧 advisory lock，也不实现跨 Mac 的 `/peer/lease` 协议；后者留给 R6。

`store/leases.ts` 的获取、续租和释放使用立即事务。首次获取 epoch 为 1；其它持有者只有在墙钟严格超过 `expires_at + skewMs` 后才能接管，默认时钟宽限 5 秒，可设为 0。接管递增 epoch 并从 Clock 签发新的 `acquired_hlc`。同一持有者通过 `acquireLease` 可重获或续租未释放的租约，epoch 与取得 HLC 不变；`renewLease` 则严格要求持有者、epoch 匹配且租约尚未到期。宽限只延迟接管，不延长旧持有者的写权限。

释放不删除历史行，而将 `expires_at` 置为 0。此标记允许立即重新获取，无需再等宽限；包括同一持有者在内的下一次获取都会递增 epoch，避免旧 token 在释放后复活。

业务写入须在自己的 `writeTransaction` 内调用 `assertLeaseHeld(db, clock, name, holder, epoch)`，与受保护的写入共用事务；不匹配或到期抛出 `LeaseLostError`，事务回滚。事务外的检查不能替代这道 fencing。

`LeaseKeeper` 可作为运行时组件使用。启动后调用 `hold(name, { ttlMs, renewEveryMs })`，续租间隔须小于租期。默认持有者为 hostId，构造参数 `worker` 可追加为 `<hostId>:<worker>`，`skewMs` 可覆盖接管宽限。重复持有同名有效租约复用原维护配置；`epoch(name)` 校验并返回当前 token，失效返回 undefined。维护器发布带名称、持有者和 epoch 的 `lease:acquired` / `lease:lost`；续租失败后不自动抢回，停止时释放持有租约并发布 lost。

`withLease(name, fn)` 要求事先持有租约，在调用前及完成后检查持有权，并向回调传入 epoch。它不自动获取或释放，不会取消回调或撤销外部副作用；数据库写入仍须使用上述事务内断言。当前入口尚未启用具体租约角色。

## 聊天事件与 SSE 回放

`chat_events` 是本地持久事件日志；每个 stream 的 seq 从 1 递增，terminal 事件之后拒绝追加。streamId 应为一次性轮次标识，清扫后也不要复用。数据必须可 JSON 序列化，事件类型不能包含换行或空字符。

`store/chat-events.ts` 提供 `appendChatEvent(db, clock, input)`，可独立运行或放入调用方的立即写事务；`readChatEvents(db, clock, streamId, afterSeq, limit)` 显式接收 Clock，读取时即过滤过期数据。保留窗口沿用旧 PG 语义：从流内最后事件时间（最大 created_at）起，终态保留 10 分钟，非终态保留 1 小时，到达边界即过期。清扫按整条流删除，不删除仍有效流的早期事件。入口注册 `ChatEventSweeper`，每 60 秒按 Clock 清扫一次。

业务推荐使用 `new ChatEvents(ctx).append(input)`；需要与其它业务写入原子提交时，使用 `events.write((db, append) => { ... })`。该同步回调中的 append 与业务写入共用立即事务，只有最外层提交成功后才发布 `chat:event { streamId, seq }`；回滚不唤醒。不要在其它事务中调用这两个服务方法（会拒绝），应由 events.write 拥有最外层事务。直接调用 store 的追加函数不发布通知。

`events.subscribe(streamId, cursor?, signal?)` 返回 `status: "ok"` 和异步迭代器，或 `status: "unknown"`。迭代器先回放后等待总线唤醒，并以 1 秒轮询兜底；跨批次排空尾部事件，到 terminal 后结束。通过 AbortSignal 中止等待并清理订阅。游标为不透明的 `<hostId>.<seq>`；不带游标从头读取。异宿主、格式错误、超出流尾、未知或过期的流返回 unknown，调用方应恢复快照；已读到终态的有效游标直接结束。订阅过程中流过期则结束，不伪造终态。

R1 的 `/v2/streams/:streamId/events` 占位接口已移除。R3-2 改为下述具有会话授权、快照恢复的正式轮次流，未知游标不再返回 410；R1 的底层 ChatEvents 仍以 unknown 通知调用方恢复。

## 身份、家庭和设备凭证

R2-1 增加 households、hosts、members、devices。业务行均有 UUIDv7 id、origin_host_id、编码 HLC、rev、创建/更新时间和 deleted_at 墓碑；hosts.id 与 host_meta 的运行时 hostId 一致。启动时幂等建立本宿主的家庭与 host 行，householdId 进入组件上下文；重启不改名、不重建身份，也不自动创建成员或设备。家庭/宿主名称可由配置 householdName、hostName 或环境 CATTT_HOUSEHOLD_NAME、CATTT_HOST_NAME 指定，默认“我们的家”“我的 Mac”。

成员模型按 N 设计，默认上限只在 runtime/config.ts 的 DEFAULT_MAX_MEMBERS 中定义；调用方可通过 maxMembers 配置和 createMember 参数扩容。成员的 home_host_id 与设备宿主必须属于对应家庭。仓储使用立即事务计数和创建，活跃成员才计入上限，listMembers 不返回墓碑。

devices 是可复制的设备生命周期记录（含 last_seen_at、revoked_at），不含任何令牌。device_credentials 是**本机秘密表**，仅包含 device_id 与唯一 SHA-256 token_hash，永不进入 change_log、复制或共享快照。createDevice 只在创建时返回一次 `mm_dvc_` 加 32 随机字节 base64url 的原始令牌；不要写入日志。推送 token 列和其本机存储归属留给后续阶段，此处不提前加入业务设备表。

resolveDeviceToken 仅接受归属本地 host_meta.host_id 的有效设备，拒绝未知/撤销/墓碑设备、墓碑成员及失效家庭/宿主；成功时通过 Clock 更新 last_seen_at、HLC 与 rev。Actor 为 `{ memberId, deviceId, hostId, householdId }`，由身份中间件建立，不从客户端自报字段推导。

Gateway 使用 Hono，`GET /v2/healthz` 仍公开。`GET /v2/me` 返回 actor、成员公开资料和家庭；`GET /v2/members` 返回该家庭的成员公开资料。这些接口及 SSE 通过 `Authorization: Bearer mm_dvc_...` 认证，失败统一返回 401 `{ error: { code: "unauthorized" } }`。设备凭证通过下述配对或成员邀请接口发放，不提供无短码的设备注册。

`/v2` 与 `/host` 的 JSON 请求/响应均为 snake_case，不直接序列化内部 camelCase Actor 或数据库行。me.actor 为 `{ member_id, device_id, host_id, household_id }`；me.member、members 列表及 pair.member 为 `{ id, household_id, display_name, home_host_id }`。成员引导与邀请接受原有的完整成员记录另外含 origin_host_id、hlc、rev、created_at、updated_at、deleted_at。devices/status、短码/邀请与聊天响应保持原有 snake_case。所有错误统一 `{ error: { code, message? } }`：格式错误为 400 invalid_request，未知路由为 404 not_found；未处理故障返回 500 internal_error，不把内部异常细节发给客户端，并通过 onError 上报。

`identity/access.ts` 的 can/ assertCan 要求同家庭；成员归属字段不是伴侣之间的隐私边界，两人均可读取家庭成员资源。canWriteAs 只允许以自己的 memberId 写入，跨家庭断言抛出 AccessDeniedError。对话、轮次及 SSE 使用 R3 的 canSeeConversation；同家庭不代表能通过设备 API 读取伴侣单聊。

## 局域网 HTTPS 与成员设备配对

回环 HTTP 保持 `127.0.0.1:8788`（CATTT_PORT），同时服务 `/v2/*` 和 `/host/*`；管理监听拒绝非回环地址。局域网 HTTPS 默认绑定 `0.0.0.0:8789`，由 CATTT_LAN_HTTPS_PORT 配置，设为 0 关闭；它只挂载 `/v2/*`，携带正确管理口令访问 `/host/*` 也只会得到 404。测试使用 Gateway 构造参数 lanPort: 0 请求系统分配临时 HTTPS 端口，与环境端口 0 关闭监听的语义区分。

`identity/tls.ts` 用固定版本 @peculiar/x509 1.12.3 建立 ECDSA P-256 本机 CA（10 年，只建一次），签发 365 天服务端证书。SAN 包含 localhost、127.0.0.1、主机名.local 和局域网 IPv4；每 60 秒检查 IP 变化或剩余不足 30 天并重签。主入口的第一个 import 必须是 reflect-metadata。

两个监听均使用 Bun.serve 与 Hono app.fetch，不依赖 Node 服务适配器。Bun 1.4.5 不支持原地替换 TLS 上下文，因此证书刷新时调用旧监听 stop(false)，立即以新证书重绑定同一端口。旧连接（包括 SSE）继续排空，不重启进程；IP 变化或临近到期的罕见更新期间，新连接可能有几毫秒遭拒，客户端应重试。绑定失败会上报 onError（gateway:tls），以 25ms 间隔再试三次；仍失败则暂停接受新 LAN 连接，保留回环管理和已有连接，下次 60 秒检查继续恢复，不让宿主崩溃。

数据目录下 tls/ 为 0700，ca.key、ca.crt、server.key、server.crt 和 host-admin.token 均为 0600，数据目录收紧为 0700。管理口令为首次生成的 32 随机字节 base64url，重启复用。CA 残缺或损坏时失败，不悄悄替换；备份和升级必须保留整套 tls/ 与管理口令。CA 指纹为 DER 的 SHA-256 小写十六进制，短指纹取前 16 位分四组。手机应核对指纹，仅以匹配 CA 为信任锚并校验主机名，不信任任意自签证书或系统根证书替代物。

`pairing_codes` 是本机秘密表，永不进入 change_log、复制或共享快照；只存码的 SHA-256，绑定 member_id。8 位 Crockford Base32 显示为 XXXX-XXXX，忽略大小写和连字符；10 分钟、单次使用。每次格式合法但验证失败，对所有仍有效、未使用且未烧毁的码累计一次 failures，达到 5 次即烧毁；格式错误返回 400 不计数，新码不作废旧码。码的核验、使用标记、设备创建与凭证哈希在同一立即事务提交，失败不留半成品。

宿主先读取 host-admin.token，通过 `Authorization: Bearer <口令>` 调用回环接口，口令错误统一 401：

- POST /host/pairing-codes `{ member_id }`：为现有有效成员签发码，返回 code、expires_at、hosts、port、ca_fingerprint、ca_fingerprint_short、pair_url。链接为 `maomao://pair?v=2&h=...&p=...&c=...&fp=...`，版本变为 2，地址包含 IPv4 和主机名.local；不做 mDNS 发现或远程通道。
- GET /host/devices：返回本宿主未撤销的设备公开列表，包含 member_id，不包含凭证。
- DELETE /host/devices/:id：撤销本宿主设备；GET /host/status 返回 LAN 状态、CA 指纹和设备列表。

手机无需设备认证调用 POST /v2/pair `{ code, device_name }`，成功返回 `{ device_id, device_token, member, household }`，身份取自该码绑定的成员，而非共享“主人”。错误、过期或烧毁的码统一返回 401 `{ error: { code: "pairing_code_invalid" } }`。原始设备令牌只返回这一次，手机应放入 Keychain 的 ThisDeviceOnly 项，不写日志。POST /v2/device/unpair 需要 Actor，撤销当前设备，之后的认证请求返回 401。已有 SSE 连接的业务归属和后续授权仍按 R3 实现。

## R3-1 对话与消息

完整客户端参考见 [API v2 聊天契约](../docs/参考/API-v2-聊天契约.md)，R3-2 已实现其中的 Turn、SSE、取消与重答；真实模型尚未接入。

conversations、participants、messages 均带可复制业务列和墓碑。家庭创建群聊，成员创建时同事务建立其单聊并加入群聊，移除时更新参与者墓碑；启动幂等补齐 R2 已有成员。通用同家庭访问规则不代替 canSeeConversation：群聊要求参与者，单聊设备 API 只对拥有者可见（伴侣请求为 404），但不承诺存储保密。

两个监听均提供 GET /v2/conversations、GET /v2/conversations/:id、GET/POST /v2/conversations/:id/messages。列表先群聊后本人单聊；历史按 HLC、ID 稳定分页，不使用全局 seq。发送以会话/作者/client_message_id 去重，同键不同文本 409；作者来自 Actor，非发布宿主写入 409 not_publisher。R3-1 的 turn=null 阶段已由 R3-2 下述轮次响应接续；协议仍允许未来静默策略返回 null。

## R3-2 轮次与可注入生成器

`turns` 是**发布宿主本机执行资源，永不复制、不进 change_log**，复制 messages 不触发再生成。除轮次/控制字段外，本机持久化 draft_text、event_seq 和 superseded_by_turn_id，分别用于增量丢失后的全文快照、清扫后不复用序号、以及取代终态恢复。新发送同事务存消息、初始 Turn、accepted，并取代本会话尚未发首 token 的 queued/generating 轮次；幂等重传返回初次 queued 响应，不改绑后续重答，最新状态另查 Turn。

`HostConfig.replier` 注入 `reply({conversation, history, trigger, signal}) → AsyncIterable<string>`。history 默认最近 50 条、最多 100 条，只来自当前会话。**当前没有真实模型调用**；main 仅在没有配置 replier 时选择清楚标记的 DevelopmentEchoReplier，回复带“开发回复，未接入模型”。R3-3 替换这条开发生成路径。

TurnRunner 使用进程内调度加持久恢复扫描，而不叠加 jobs 的重试/租期状态机：turns 已是执行真相，重答须显式 request_id，不能由队列重试悄悄再回复。250ms 轮询和提交后总线唤醒；每会话通过 `conversation:<id>` 租约串行，不同会话可并行。租期 10 秒、每 2 秒续租，单轮预算 45 秒；首 token 与取消/取代原子复核，draft/delta 同事务，最终猫消息与 terminal 同事务且 epoch-fenced。预算、轮询、心跳、历史大小可在构造参数配置以便测试。

取消正在生成的轮次先持久化控制并返回 200 Turn，运行器响应信号后以租约 fencing 提交 stopped；queued 取消可直接终止。visible_length 按 UTF-16 单元取不超过生成长度的前缀，若边界正好劈开代理对则退一单元，避免落库半个字符；0 不创建猫消息。重复/终态取消不重写结果。生成器即便忽略 signal，运行器也停止等待，迟到结果不能发布。启动将心跳旧于 60 秒的 queued/generating 标记 failed/interrupted 并持久化 retryable error；运行期间扫描 stale generating，不重跑崩溃的旧生成。停止中断等待并收尾、释放租约。

两个监听均提供契约中的 GET Turn、GET stream、POST cancel、POST messages/:messageId/reply。每个嵌套资源验证会话可见性及归属，写入复核发布宿主。SSE 优先 Last-Event-ID，否则 last_event_id；15 秒心跳（Gateway 可配置），提交后唤醒、1 秒持久轮询兜底。坏/异宿主/过期游标恢复 snapshot，而非 410；snapshot 以最新持久事件游标作为恢复水位，终态时从最终消息补齐 snapshot 与 terminal，两帧可共享该水位。断开清理订阅；旧 SSE/TLS 回归已迁移到正式轮次流。

## 成员引导、邀请与移除

首次设置由宿主携带管理口令 POST /host/members `{ display_name }`，返回 member；仅家庭没有活跃成员时可用，否则 409 members_already_initialized。它同样尊重邀请预留名额；成员删除后的墓碑不占活跃名额。

- 已配对成员 POST /v2/invites `{ display_name? }`，或管理员 POST /host/invites（可空体或同样的建议名称），返回 `{ invite_id, code, expires_at, invite_url }`。链接为 `maomao://invite?v=2&h=...&p=...&c=...&fp=...`，沿用本机地址、HTTPS 端口与 CA 指纹。
- 活跃成员数加仍有效、未用、未撤销、未烧毁的邀请数不能超过 maxMembers（默认值仍由配置定义）；新签发无空位时返回 409 member_limit。撤销、过期和烧毁均释放预留名额。
- 手机无需认证 POST /v2/invites/accept `{ code, display_name, device_name }`，返回 `{ member, device_id, device_token, household }`。名称由接受者最终填写，邀请中的 display_name 仅为建议。一个立即事务内复查成员上限、创建成员及设备并标记邀请已用；失败回滚全部写入。当前 home_host 为接受邀请的本宿主，跨 Mac 归属留给 R6。
- DELETE /v2/invites/:id 仅允许邀请者撤销；成员不能撤销管理员或伴侣签发的邀请（403）。DELETE /host/invites/:id 允许管理员撤销本家庭邀请。
- DELETE /host/members/:id 在一个立即事务中将成员设墓碑并撤销其全部设备，其令牌立即返回 401，为该成员签发的配对码也无法再兑换。未提供 /v2 成员互删接口。

`member_invites` 是本机秘密表，不进入 change_log、复制或共享快照；只存短码哈希。邀请码与配对码共用 Crockford 格式、规范化及失败计数实现，邀请码有效期为 24 小时。格式错误返回 400、不计次数；每次合法失败累计到所有活跃未使用的邀请码，五次烧毁，单次使用。无效、过期、已用、已撤销或烧毁的邀请统一返回 401 invite_code_invalid；有效邀请在接受时若成员上限已满则返回 409 member_limit，不消耗邀请。邀请失败计数与设备配对失败计数分属各自本机表。
