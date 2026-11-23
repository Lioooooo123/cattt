# 新宿主后端

本目录是共享版 API v2 的 Bun + SQLite 宿主，由 macOS 客户端打包和管理。旧版 Node.js 服务仍保留在 `../server/`。组件和跨 Mac 链路见[共享版架构地图](../docs/参考/共享版架构地图.md)。使用 `.bun-version` 指定的 Bun 版本。

在本目录执行：

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run db:generate
bun run build
```

`src/store/index.ts` 的 `openStore(path)` 接受文件路径或 `:memory:`，自动运行 `drizzle/` 迁移，返回 Drizzle `db`、原生 `raw` 和 `close()`。文件的父目录应已存在。文件库启用 WAL，连接启用外键、FULL 同步和 5 秒忙等待。

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

Gateway 回环监听默认为 `127.0.0.1:8788`，可通过 `CATTT_PORT` 设置端口（0 表示系统分配端口）。`GET /v2/healthz` 返回 `{ ok: true, host_id, protocol_version: 1 }`；未匹配的请求返回 `{ error: { code: "not_found", message: "未找到接口" } }`，HTTP 404。业务接口见下文。 记忆、回避和共享日记见[成员资源契约](../docs/参考/API-v2-成员资源契约.md)。

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

`leases` 提供本机运行互斥，群聊轮次同时核对家庭发布代次。跨宿主发布权由 R6.6 的持久账本和认证 `/peer/lease` 协议承接。

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

正式轮次流立即写入首段正文；后续小段从首个待写片段起等待最多 24 毫秒，累计到 256 个 UTF-16 单元时提前写出。每次写入仍在事务内复核来源许可和发布权，正常结束前写完余段，取消不发布未写入的文字。客户端以事件游标续读，不依赖模型原始分段。

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

- POST /host/pairing-codes `{ member_id }`：为本机归属的有效成员签发码，返回 code、expires_at、hosts、port、ca_fingerprint、ca_fingerprint_short、pair_url。链接为 `maomao://pair?v=2&h=...&p=...&c=...&fp=...`，版本变为 2，地址包含 IPv4 和主机名.local；不做 mDNS 发现或远程通道。
- GET /host/devices：返回本宿主未撤销的设备公开列表，包含 member_id，不包含凭证。
- DELETE /host/devices/:id：撤销本宿主设备；GET /host/status 返回 LAN 状态、CA 指纹和设备列表。

手机无需设备认证调用 POST /v2/pair `{ code, device_name }`，成功返回 `{ device_id, device_token, member, household }`，身份取自该码绑定的成员，而非共享“主人”。错误、过期或烧毁的码统一返回 401 `{ error: { code: "pairing_code_invalid" } }`。原始设备令牌只返回这一次，手机应放入 Keychain 的 ThisDeviceOnly 项，不写日志。POST /v2/device/unpair 需要 Actor，撤销当前设备，之后的认证请求返回 401。已有 SSE 连接的业务归属和后续授权仍按 R3 实现。

## R3-1 对话与消息

完整客户端参考见 [API v2 聊天契约](../docs/参考/API-v2-聊天契约.md)，R3 已实现对话、消息、Turn、SSE、取消、重答与下述真实模型接入。

conversations、participants、messages 均带可复制业务列和墓碑。家庭创建群聊，成员创建时同事务建立其单聊并加入群聊，移除时更新参与者墓碑；启动幂等补齐 R2 已有成员。通用同家庭访问规则不代替 canSeeConversation：群聊要求参与者，单聊设备 API 只对拥有者可见（伴侣请求为 404），但不承诺存储保密。

两个监听均提供 GET /v2/conversations、GET /v2/conversations/:id、GET/POST /v2/conversations/:id/messages。列表先群聊后本人单聊；历史按 HLC、ID 稳定分页，不使用全局 seq。发送以会话/作者/client_message_id 去重，同键不同文本 409；作者来自 Actor，跨宿主群聊发送的 202 语义见 R6.8。R3-1 的 turn=null 阶段已由 R3-2 下述轮次响应接续；协议仍允许群聊静默策略返回 null。

## R3-2 轮次与可注入生成器

`turns` 是**发布宿主本机执行资源，永不复制、不进 change_log**，复制 messages 不触发再生成。除轮次/控制字段外，本机持久化 draft_text、event_seq 和 superseded_by_turn_id，分别用于增量丢失后的全文快照、清扫后不复用序号、以及取代终态恢复。新发送同事务存消息、初始 Turn、accepted，并取代本会话尚未发首 token 的 queued/generating 轮次；幂等重传返回初次 queued 响应，不改绑后续重答，最新状态另查 Turn。

`HostConfig.replier` 可注入 `reply({conversation, history, trigger, signal}) → AsyncIterable<string>` 覆盖生成器。history 默认最近 50 条、最多 100 条，只来自当前会话。未显式注入时，main 的 TurnRunner 按下述模型配置选择 ChatReplier 或开发回声，不因模型缺少密钥而退回回声。

TurnRunner 使用进程内调度加持久恢复扫描，而不叠加 jobs 的重试/租期状态机：turns 已是执行真相，重答须显式 request_id，不能由队列重试悄悄再回复。250ms 轮询和提交后总线唤醒；每会话通过 `conversation:<id>` 租约串行，不同会话可并行。租期 10 秒、每 2 秒续租，单轮预算 45 秒；首 token 与取消/取代原子复核，draft/delta 同事务，最终猫消息与 terminal 同事务且 epoch-fenced。预算、轮询、心跳、历史大小可在构造参数配置以便测试。

取消正在生成的轮次先持久化控制并返回 200 Turn，运行器响应信号后以租约 fencing 提交 stopped；queued 取消可直接终止。visible_length 按 UTF-16 单元取不超过生成长度的前缀，若边界正好劈开代理对则退一单元，避免落库半个字符；0 不创建猫消息。重复/终态取消不重写结果。生成器即便忽略 signal，运行器也停止等待，迟到结果不能发布。启动将心跳旧于 60 秒的 queued/generating 标记 failed/interrupted 并持久化 retryable error；运行期间扫描 stale generating，不重跑崩溃的旧生成。停止中断等待并收尾、释放租约。

两个监听均提供契约中的 GET Turn、GET stream、POST cancel、POST messages/:messageId/reply。每个嵌套资源验证会话可见性及归属，写入复核发布宿主。SSE 优先 Last-Event-ID，否则 last_event_id；15 秒心跳（Gateway 可配置），提交后唤醒、1 秒持久轮询兜底。坏/异宿主/过期游标恢复 snapshot，而非 410；snapshot 以最新持久事件游标作为恢复水位，终态时从最终消息补齐 snapshot 与 terminal，两帧可共享该水位。断开清理订阅；旧 SSE/TLS 回归已迁移到正式轮次流。

## R4.8 模型运行时

`llm/` 用同一个自研客户端调用 OpenAI 兼容的 `POST /chat/completions`。聊天、Router 和抽取使用流式 SSE，托付工具步骤与超预算摘要使用非流式响应。ChatReplier 只发布正文，每次回复请求最多 1024 输出 token，沿用轮次的 45 秒预算、租约与取消机制。

配置从宿主进程环境读取。原项目的 `MAOMAO_DEEPSEEK_API_KEY`、`MAOMAO_OPENAI_COMPAT_API_KEY` 与槽位变量可原名传入，宿主独立程序不会加载旧服务的环境文件。

| 环境变量 | 行为 |
|---|---|
| MODEL_PROVIDER | 默认 `deepseek`，作为 chat、router、worker 的默认来源。显式 `openai-compatible` 切换这三个槽位的全局来源，`mock` 显式启用全部模拟槽位，`echo` 启用带标注的开发聊天回复 |
| CHAT_PROVIDER / CHAT_MODEL、ROUTER_PROVIDER / ROUTER_MODEL、WORKER_PROVIDER / WORKER_MODEL | 按槽位覆盖全局来源和模型。DeepSeek 默认模型是 `deepseek-flash` |
| CHAT_THINKING / ROUTER_THINKING / WORKER_THINKING / EXTRACT_THINKING | `enabled` 或 `disabled`。托付默认开启，其余默认关闭 |
| MAOMAO_DEEPSEEK_API_KEY | DeepSeek 密钥，必填 |
| MAOMAO_DEEPSEEK_BASE_URL | 默认官方 HTTPS 地址，受控协议联调可显式指定回环地址 |
| OPENAI_COMPAT_BASE_URL / OPENAI_COMPAT_MODEL / MAOMAO_OPENAI_COMPAT_API_KEY | 兼容地址、默认模型名和可选密钥。默认地址 `http://127.0.0.1:11434/v1` |
| OPENAI_COMPAT_THINKING_PARAM | `none`、`reasoning_effort`（默认）或 `chat_template_kwargs`，用于兼容服务的思考开关 |
| EXTRACT_PROVIDER / EXTRACT_MODEL / EXTRACT_BASE_URL | extract 独立覆盖。默认本机 OpenAI 兼容，自动沿用全局回环地址。显式设为 `openai-compatible` 可复用全局地址，`EXTRACT_BASE_URL` 可指定独立地址 |
| MAOMAO_EXTRACT_API_KEY | 独立兼容抽取密钥。只有两个地址相同时才沿用全局兼容密钥 |
| MODEL_DAILY_CALL_LIMIT / MODEL_DAILY_TOKEN_LIMIT | 每宿主 UTC 日默认 120 次、2,000,000 保守计费单位。每次请求以序列化输入 UTF-8 字节数加输出上限预留，失败和进程中断保留预留 |
| MODEL_LOCAL_CONCURRENCY / MODEL_CLOUD_CONCURRENCY / MODEL_MOCK_CONCURRENCY | 同供应商端点并发默认分别为 1 / 0 / 0。0 表示不限并发。等待队列前台优先，同优先级按入队顺序，已有请求可以完成 |
| MOCK_DELAY_MS | 显式 mock 模式下每个文本块的间隔，默认 40ms |

`runtime/model.ts` 对用途和槽位进行校验。聊天走 chat，研判走 router，托付走 worker，记忆抽取、召回、边界、日记读写的模型用途走 extract。群聊开口和托付已由发布权规则限于实际执行宿主，费用在该宿主记账。账本迁移 `0023_r4_model_runtime` 接在 `0022_r8_15_notifications` 后，`model_calls` 只在本库保存用途、槽位、预留、状态、关联轮次或作业及供应商返回用量。排队取消或许可失效发生在预留前。

缺配置时身份和 API 仍可用，聊天返回 `model_auth`，托付生成明确的失败汇报。错误分类沿用旧后端，401/403 为认证失败、402 为额度失败、400/422 为请求错误；限流、服务端错误和流异常遵循已有重试规则。只有显式 `MODEL_PROVIDER=mock` 启用模拟托付。

聊天、托付使用 56 KiB 输入预算。裁剪前保留当前原话、规则与必要尾部，裁剪时按旧轮次或工具调用及配对结果为单位。摘要用本次槽位、无工具、单次非流式请求，输入以有界 JSON 行提供带署名的成员原话和经过来源复核的工具观察。助手正文、计划、推理和未成功执行的工具批不作为摘要事实。临时摘要插入 user 消息，按 `context_summary` 单独记账，托付摘要用量也扣同一 run 的输出额度。摘要前、排队放行时和摘要结束后核对权限，缓存只在本轮或本次执行使用。回复只随附摘要用到的原话修订引用，来源撤回后派生回复也不再进入后续模型上下文。服务失败时可用普通裁剪继续，来源复核失败会停止使用过期输入。

旧聊天提示词入口为 `server/src/turns/run.ts` → `runtime/context.ts` 的 buildTurnContext → `runtime/persona.ts` 的 personaBlock。当前复用团子“外表有些高冷，内心十分细腻”的底色与简短聊天、少卖萌、不说教、不编造、接受更正等原措辞，不伪造工具保存凭证。群聊 system 明确列出本会话成员名称，每条成员消息逐行署名；单聊仅标明该成员，不读取另一单聊。近期消息限于当前会话，重答目标不在末尾时另附该条获准的触发原话。经 R4 许可的跨会话知识走下述来源复核。

真实模型语义验收见下文 R4 评测。真实 LAN HTTPS 的双成员测试验证两单聊与群聊独立、模型提示词无串线、分页、回复落库和错误恢复；编译产物也通过 mock 聊天及 SIGTERM 验证。

## R4 结构化知识与抽取

配置 `EXTRACT_MODEL` 或 `OPENAI_COMPAT_MODEL` 后，`startConfiguredHost` 在同一个 Bun 进程注册抽取队列。显式 `MODEL_PROVIDER=openai-compatible` 或 `EXTRACT_PROVIDER=openai-compatible` 且抽取端点为回环地址时，模型名未填则使用 `qwen3:8b`；优先级仍是 `EXTRACT_MODEL` → `OPENAI_COMPAT_MODEL` → 默认名。完全未配置或只有 DeepSeek key 时不会补本机模型名，抽取队列仍跳过；显式 DeepSeek 抽取不受影响。默认名不代表已安装或在线：须先自行启动 Ollama 并执行 `ollama pull qwen3:8b`，宿主启动不探测本机模型端点，也不自动下载。8 GB Mac 应显式设置 `EXTRACT_MODEL=qwen3:4b`（准确性降级）；16 GB+ 的记忆默认选型与评测见[决策](../docs/决策/2026-11-23-默认本机记忆模型.md)。Qwen3 抽取保留 `EXTRACT_THINKING=disabled` 与 `OPENAI_COMPAT_THINKING_PARAM=reasoning_effort`，请求传 `reasoning_effort: none` 关闭思考。显式覆盖使用 `EXTRACT_PROVIDER`、`EXTRACT_MODEL` 和 `EXTRACT_THINKING`。原创成员消息、轮次、accepted 和抽取作业同事务保存。只有首发唤醒作业，新配置生效后会扫描已有待办。复制、导入和发送重放沿用各自入口。

抽取复核原话修订、参与者及回避设置。已确认事实分别保存主体与原话来源，明确的共同事实使用一条 `subjectMemberId: null` 的家庭记录。待确认项单独保存。本人更正会保留旧行墓碑；晚到的旧抽取不能重建更正前的值。抽取作业终态、知识与依赖证明同事务提交。

`context/chat.ts` 用同一读快照组装获准聊天窗口、按真实成员分段的事实及获准日记。记忆块最多 8 条、2400 个 UTF-16 码元。每次写流式片段及最终猫消息前，复核已使用的来源修订、抽取依赖、日记许可、成员和回避设置。首次输出前的失效允许同一轮重组一次。已保存的猫回复携带记忆与日记修订引用，供后续的模型窗口再次核对。

### R5 调用契约

在 Router 先核对目标会话和实际受众，然后在准入读事务及发布写事务中调用 `assessKnowledgeUse(db, { householdId, audienceMemberIds, evidence, text })`。返回 `allowed` 才可进入下一步。`source_unavailable` 表示证明失效，`avoided_topic` 表示候选文本或引用证据命中任何受众的回避设置。群聊传当前参与者，单聊传拥有者。

`evidence` 保存当时使用的精确修订。成员原话使用 `{kind: "message", sourceMemberId, sourceMessageId, sourceRevision}`，结构化记忆和日记使用 `{kind: "memory" | "diary", id, rev}`，附件模型描述使用 `{kind: "file_description", id: fileId, rev: fileRev}`。引用派生记忆时保留记忆 ID 和修订，仓储会复核指代所依赖的原话。R5 负责目标会话授权、发布宿主、来源署名、转告意愿、频率和时段。R6.9 将回复引用证明和抽取依赖随相应业务记录原子复制。

### 模型实评复跑

使用 `.bun-version` 的 Bun，在 `host/` 下执行。受控回环测试覆盖生产入口、两种协议、前台优先、共享预算、取消、修正、摘要许可和隔离 Worker 编译。

```sh
bun --no-env-file test test/production-model.test.ts test/ticket-workers.test.ts test/binary.test.ts
```

本机模型启动后，将下面两处模型 ID 改为该服务报告的实际值，端口按实际监听填写。三轮输出记录抽取、召回及误归属结果，并按固定语料评分。

```sh
OPENAI_COMPAT_BASE_URL=http://127.0.0.1:11434/v1 \
  EXTRACT_MODEL=你的本机抽取模型 CHAT_MODEL=你的本机聊天模型 \
  bun --no-env-file test/memory-eval/r4-real.ts
```

使用已注入 `MAOMAO_DEEPSEEK_API_KEY` 的进程环境调用真实托付。脚本使用独立临时库和合成原话，三轮都须从真实 `get_time` 观察生成包含准确日期、时分的 `report ready`，且账本记录同一 worker 模型。若用本机兼容服务实评托付，显式设置 `WORKER_PROVIDER=openai-compatible`、`OPENAI_COMPAT_BASE_URL`、`WORKER_MODEL` 和兼容思考参数。

```sh
MODEL_PROVIDER=deepseek WORKER_PROVIDER=deepseek WORKER_MODEL=deepseek-flash \
  bun --no-env-file test/model-eval/worker-real.ts
```

R4.8 在受控服务验证了协议和许可。标准本机服务端口未监听，真实模型语义仍待按以上命令实评。

宿主之间通过独立 mTLS 监听复制身份、对话、共享知识与附件业务数据。写者、版本、墓碑及来源许可见 [R6.9 决策](../docs/决策/2026-11-22-R6.9共享知识复制.md)。双端结对、管理状态、暂停和持久水位见 [Peer 结对与传输契约](../docs/参考/Peer-结对与传输契约.md)。

手机在成员 home host 使用 `GET /v2/changes`，同步记忆、回避、日记、附件及模型描述、事项与信箱。游标与投影墓碑见 [API v2 成员增量契约](../docs/参考/API-v2-成员增量契约.md)。

## 成员引导、邀请与移除

首次设置由宿主携带管理口令 POST /host/members `{ display_name }`，返回 member；仅家庭创建宿主且没有活跃成员时可用，否则 409 members_already_initialized。它同样尊重邀请预留名额；成员删除后的墓碑不占活跃名额。

- 已配对成员 POST /v2/invites `{ display_name? }`，或管理员 POST /host/invites（可空体或同样的建议名称），返回 `{ invite_id, code, expires_at, invite_url }`。链接为 `maomao://invite?v=2&h=...&p=...&c=...&fp=...`，沿用本机地址、HTTPS 端口与 CA 指纹。
- 活跃成员数加仍有效、未用、未撤销、未烧毁的邀请数不能超过 maxMembers（默认值仍由配置定义）；新签发无空位时返回 409 member_limit。撤销、过期和烧毁均释放预留名额。
- 手机无需认证 POST /v2/invites/accept `{ code, display_name, device_name }`，返回 `{ member, device_id, device_token, household }`。名称由接受者最终填写，邀请中的 display_name 仅为建议。一个立即事务内复查成员上限、创建成员及设备并标记邀请已用；失败回滚全部写入。home_host 为接受邀请的本宿主。加入家庭的宿主在收到创建宿主的首成员与正式群聊后才可签发及接受邀请，未就绪返回 409 peer_sync_pending。
- DELETE /v2/invites/:id 仅允许邀请者撤销；成员不能撤销管理员或伴侣签发的邀请（403）。DELETE /host/invites/:id 允许管理员撤销本家庭邀请。
- DELETE /host/members/:id 在一个立即事务中将成员设墓碑并撤销其全部设备，其令牌立即返回 401，为该成员签发的配对码也无法再兑换。未提供 /v2 成员互删接口。

`member_invites` 是本机秘密表，不进入 change_log、复制或共享快照；只存短码哈希。邀请码与配对码共用 Crockford 格式、规范化及失败计数实现，邀请码有效期为 24 小时。格式错误返回 400、不计次数；每次合法失败累计到所有活跃未使用的邀请码，五次烧毁，单次使用。无效、过期、已用、已撤销或烧毁的邀请统一返回 401 invite_code_invalid；有效邀请在接受时若成员上限已满则返回 409 member_limit，不消耗邀请。邀请失败计数与设备配对失败计数分属各自本机表。

## R5.2 执行与汇报

`registerTicketWorkers(jobs, services)` 将 `errand` 和 `followup` 注册到主进程现有的 `JobRunner`。`main.ts` 默认通过宿主的 worker 槽位执行托付。认领租期 45 秒，运行时定期续约。重启按持久 Job 恢复，过期尝试、取消、改期及旧执行代次都失去写入资格。每个检查点和汇报的写事务校验 Job attempt、事项修订与代次、发布宿主、原话许可及上下文来源。

`run_steps` 按 run 和步号保存完整未裁剪历史，包括模型推理、工具调用与配对观察、已纳入的用户补充 ID、来源修订和用量。每代最多 20 步、8,000 输出 token、10 分钟活动时间。暂态模型故障最多重试 3 次。未知工具或对象参数结构错误先整批拒绝，再给一次修正机会，重启沿用同一额度。显式续办失败或受阻事项时开启新代次和预算，从原话及补充重新准备。

R4 可通过 `TicketWorkerServices.context.prepare` 提供共享上下文和只读工具，通过 `permits` 在事务内校验来源修订。装配的事实及工具观察应带齐依赖。宿主负责模型请求、预算预留及来源校验。worker 模型接收工具定义，隔离计算线程校验模型调用，实际只读工具由宿主执行。每次清点历史时重新复核原话、补充和工具观察的来源。

Router 可订阅 `worker:report` 并用 `listWorkerReports(db, hostId, afterSequence)` 恢复漏掉的唤醒。`sequence` 是本库递增游标，`id` 是汇报的 UUIDv7。每个事项修订最多一份汇报，保存汇报生成前后的事项修订、run 代次、目标成员/会话/宿主、会话新鲜度锚点与来源许可。结束步骤、执行状态和汇报在同一事务写入。`readCurrentReportTicket` 过滤已经变化的事项或代次，Router 仍须在发布事务内复核会话、原话与撤回、发布权、安静时段和频率，并用汇报 ID 建发布收据。

约定保留原到期及当地时区。当地 22:00–09:00 持久推迟，超过 24 小时时报告 `mailbox_only`，其他到期报告 `scheduled`。托付追问报告的 `quietAfter` 是报告生成后 24 小时，供 Router 决定是否静默等待。报告处理和可见写入属于发布 Router。`runs`、`run_steps`、`worker_reports` 是本机执行数据。群聊执行的事务复查发布宿主、事项准入代次与计算前捕获的 lease grant。

Bun 编译显式列出 `src/main.ts` 与 `src/ticket-workers/compute-worker.ts` 两个入口。计算线程只接收结构化数据，默认空环境，模型槽位和 SQLite 由宿主线程持有。事项迁移在准入迁移之后。合并并行 schema 时从合并后的完整 schema 生成 SQL、Drizzle 快照、journal 和内嵌迁移。

## R5.3 统一汇报发布与信箱

`runtime/application.ts` 启动一个 `ReportRouter`，消费原宿主创建的持久 `worker_reports`。`worker:report` 只负责及时唤醒。启动与每秒扫描按本宿主游标把汇报认入 `publication_receipts`，游标和待处理记录一次提交。等待静默、当前轮次或约定到期使用单独的持久重试时间。收据以报告 ID 唯一，重复处理读取同一终态。报告队列、游标、收据和推送 outbox 是本机执行数据。

发布事务重新校验事项修订及 run 代次、成员与会话、发布宿主、报告原话及补充的来源修订、依赖许可、回避和会话新鲜度。正常轮次结束追加的猫回复可以通过复核，新成员消息、变更的锚点或无法解释的会话修订会淘汰旧汇报。过时、撤回及拒绝报告留下终态原因，可供后续重新评估流程读取。本阶段没有自动重算。追问超过 24 小时切到 `quiet_waiting`，亲口约定超过 24 小时只留信。正常约定写聊天和信箱，托付结果正文写信箱并在聊天提示，追问和失败原因写聊天。聊天沿用 R3 消息，不创建伪 Turn，也不写入现有 Turn SSE。正文、收据和可选推送意图一次提交。

`GET /v2/mailbox?after=<上页 next_cursor>&limit=50` 返回 `{letters, next_cursor, has_more}`，按信件创建 HLC 与 ID 增序，`limit` 允许 1–100。信件含 `id`、`conversation_id`、`for_member_id`、`publisher_host_id`、`ticket_id`、`text`、`created_at`、`read_at`。两项时间用毫秒。对话参与资格与收信成员同时限定读写范围。`POST /v2/mailbox/:id/read` 返回 `{letter}`，第一次在成员 home host 写入已读时间，重复调用返回同一已读状态。跨成员信件无法通过 ID 或分页游标读取。已读修订不移动原分页位置。

接入项：

- **R4.6**：运行时默认接入 `readKnowledgeSource` 与 `assessKnowledgeUse`。事项从准入到发布使用同一原话读取策略。群聊复核当前参与者的回避设置。Worker 与 Router 共享依赖许可检查。
- **群聊发布权**：生产使用 R6 的本地续期窗口和持久发布代次。轮次和汇报携带原授权，发布事务重查该授权。`GroupPublicationAuthority` 保留为合成接口。
- **APNs**：默认关闭。仅注入 `HostConfig.publicationPush` 才生成及发送本机意图，含稳定通知 ID、成员、会话和目标资源，适配端需实时解析该成员在 home host 的有效设备，通用提示不带报告正文。调用适配端前再次复核来源、目标和安静时段，每成员当地自然日最多保留两条推送名额。可确认未发送的暂态错误可返回 `retryAt`，同日重试复用名额。进程中断留下的发送中状态标记为 `uncertain`。真实 APNs 设备登记、凭证和发送仍未接入。

## R5.4 主动推断和群聊开口

群聊里成员可以正常互聊。新消息明确呼唤团子时立即生成回复，例如“团子，你在吗？”、“@团子”或“晚上好，团子”。其余消息保存后返回 `turn:null`。单聊继续使用正常轮次。满足许可、来源与时间规则的群聊原话仍可进入主动推断候选。

`GET /v2/me/proactive` 查询本人设置。`PATCH /v2/me/proactive` 接受 `{allow_proactive: boolean, time_zone?: string}`，返回 `{allow_proactive, revision, time_zone}`。默认关闭，初始时区为 `Asia/Shanghai`。修改需在成员 home host 执行，设置变更使旧许可修订的候选失效。群聊推断需要当前参与者均已允许，信件只归原话作者。

现行 `ask_outcome` 为 v1 `observe`。规则只识别本人明确说出结束时间的面试、考试、就诊、比赛、答辩。候选随原创消息提交，引用原话 ID 和修订。配置 `ROUTER_PROVIDER`、`ROUTER_MODEL` 和 `ROUTER_THINKING` 可覆盖 Router 槽位。评估槽位输出决策与原话证据，Router 自己复核，`auto` 仅可通过宿主显式配置。发布与成员当地自然日的频率收据、聊天及信箱一起提交。安静时段为 22:00–09:00。超过结束时刻 24 小时的推断失效。

迁移顺序与下游接点见 [R5.4 合并清单](../outputs/r54-proactive-review/验收报告.md)。

## R5.5 伴侣转告

设备在来源成员的 home host 先发送「帮我转告：晚上一起吃饭」或「帮我紧急转告：请改走北门」。再用同一成员的设备凭证提交 `POST /v2/relays`，请求体为 `{"source_message_id":"<原创消息 UUIDv7>","source_revision":1}`。同一原话重试返回同一 `id`、准入时的 `source_day`、`source_time_zone`、`urgent` 和当前状态。

- 同宿主返回 `pending`、`published` 或 `dropped`。只有 `published` 带 `published_message_id`。
- 跨宿主返回 `queued`、`accepted` 或 `rejected`。`accepted` 带已校验的 `peer_receipt`，表示目标 Inbox 已准入。最终消息由接收者自己的单聊历史提供。
- `POST /v2/relays/sources/:id/withdraw` 接受 `{"source_revision":1}`。重复撤回返回同样确认，原话保持在历史里。
- 格式无效返回 400，来源身份或修订不匹配返回 404。许可不明、日额度用尽、目标不可用或 peer 未获写资格返回 409，错误码分别为 `relay_not_allowed`、`relay_daily_limit`、`relay_target_unavailable` 或 `relay_peer_unavailable`。

[授权、静默、来源代次、迁移与验证边界](../docs/决策/2026-11-22-R5.5伴侣转告.md)


## R6.6 群聊发布权

独立创建宿主可以直接发布。结对之后，单个持有宿主用本机短时窗口执行，失联到期进入等待，恢复认证通信后可续期。回环管理员在原宿主发起交接，原宿主提交封停和历史摘要，接任方核齐历史并通过对端续期后发布。单聊继续使用成员 home host。租期、管理接口、恢复步骤和并行阶段接线见[群聊发布租约契约](../docs/参考/群聊发布租约契约.md)。

## R6.8 跨宿主群聊发送

手机仍使用本方 home host 和本机设备凭证。群聊发布方在对端或发布权暂不可用时，`POST /v2/conversations/:id/messages` 可返回 202，客户端通过 `receipt_url` 查询。发送意图及可投递的 outbox 在同一事务提交。mTLS 接收方核对来源事实、参与者与发布代次后，原子写入群聊消息、适用的回复准入与持久收据。单聊保持 home host 处理，远端猫回复通过消息复制可见。见 [聊天契约](../docs/参考/API-v2-聊天契约.md#跨宿主群聊发送与查询r68) 和 [Peer 行为投递契约](../docs/参考/Peer-行为投递契约.md)。

生产启动由 `startConfiguredHost` 组装共享的 `PeerBehaviorChannel`、`GroupSends` 和 `JobRunner`，转告与群聊发送各自在同一注册表上注册。R5.4 的 `GroupReplyPolicy` 在消息事务内决定是否创建回复轮次。

## R6.10 事项和信箱复制

事项、补充、信件、已读及业务证明进入原生日志与快照。升级从 R5.5 迁移链的 0018 接续，保留旧库的待办和历史收据。群聊交接校对这一批业务历史后开放新代。见 [R6.10 决定](../docs/决策/2026-11-22-R6.10事项与信箱复制.md)。
## R7.1 附件

`/v2/files` 与对话共用回环 HTTP、LAN HTTPS 和已配对设备的 Bearer 凭证。每个附件属于一个会话，群聊成员可读群聊附件，单聊附件只在拥有者的设备接口展示。两位成员之间的存储边界沿用 [11-22 重构决定](../docs/决策/2026-11-22-情侣共享与整体重构.md)。

| 方法与路径 | 请求与响应 |
| --- | --- |
| `POST /v2/files/uploads` | JSON `{ client_upload_id, conversation_id, sha256, byte_size, file_name, media_type, description?, source_message_id?, source_message_rev? }`。`client_upload_id` 为 UUID，SHA-256 用 64 位小写十六进制，原件 1 字节至 25 MiB，JSON 请求体最多 8 KiB。首次 201，同成员同键同清单重试 200，清单改变 409 `idempotency_conflict`。 |
| `GET /v2/files/uploads/:id` | 上传者读取 `{ id, offset, byte_size, file_id }`，与创建及分块响应同形。上传完成前 `file_id` 为 null。 |
| `PATCH /v2/files/uploads/:id` | `Content-Type: application/octet-stream`，`Upload-Offset` 为本块起点，单块 1 字节至 1 MiB。成功 200 返回下一偏移。收到 409 `offset_mismatch` 或 `upload_busy` 时从响应 `error.offset` 或 GET 状态确认进度。连接中断后也可查询进度，整块未收到时保留上一个偏移。 |
| `POST /v2/files/uploads/:id/complete` | 字节不足时 409 `upload_incomplete`。首次通过完整 SHA-256 校验后返回 201 `{ file }`，重复返回 200 同一文件。校验失败返回 422 `checksum_mismatch`，从 `error.offset: 0` 重传。 |
| `GET /v2/files?conversation_id=…&after=…&limit=…` | 返回 `{ files, next_after }`。`after` 用上一页返回的 UUID，默认 50 项、最多 100 项，最后一页 `next_after` 为 null。 |
| `GET /v2/files/:id` | 返回 `{ file }`，包含归属、来源、修订、大小、哈希、媒体类型、说明和本机 `available`。 |
| `GET /v2/files/:id/content` | 原件按附件下载。支持单一字节范围、后缀、开放区间，返回 206 与 `Content-Range`。无效、多段或越界的字节范围返回 416。使用 SHA-256 ETag，`If-Range` 不匹配时返回 200 全文。原件缺失返回 404 `blob_unavailable`。 |
| `GET /v2/files/:id/thumbnail` | macOS 通过系统 `sips` 将 JPEG、PNG 或 HEIC/HEIF 转为最长边不超过 320 像素的 JPEG。类型不支持返回 415 `thumbnail_unsupported`，类型不符或解码失败返回 422 `thumbnail_failed`。 |
| `DELETE /v2/files/:id` | 上传者可在附件来源宿主撤回，重复撤回返回 204。业务行更新墓碑，其他附件仍可引用相同哈希。 |

可省略消息指针，以附件本身及其修订为来源。若关联已存在的消息，须同时提供消息 ID 和修订，消息须由上传者在同一会话发出。附件撤回或消息修订变化、撤回时，详情、清单、原件和缩略图统一按来源失效处理。

本机数据目录的 `blobs/uploads/<id>` 保存未完成的文件，`blobs/content/<sha256>` 保存验证后的原件，`blobs/thumbnails/` 保存可再生成的缩略图。宿主重启保留上传清单与磁盘偏移。当前保留完成收据和未完成上传，由后续的同步与生命周期策略管理清理。

R6.7 通过原生日志和来源快照同步 `files` 与墓碑。来源消息缺失、修订不符或已撤回时，附件不进入设备清单，也不能授权对端拉取原件。设备只在本机登记与实际原件大小匹配时报告 `available: true`。已验证的本机原件可在来源宿主离线时读取。

## R7.2 本机视觉描述

配对设备先通过 R7.1 上传 PNG、JPEG 或 WebP。附件所有者在附件来源宿主上调用 `POST /v2/files/:id/description`，提交 JSON `{"file_rev":1}`（实际修订取附件详情的 `rev`）。同一附件修订只保存一条描述，宿主重启后仍可重试。会话的可见成员通过 `GET /v2/files/:id/description` 读取当前结果，GET 和上传均无推理副作用。

| HTTP | 结果 |
| --- | --- |
| 200 | `{ status: "ready", description: { id, file_id, file_rev, sha256, source_message_id, source_message_rev, text, model_id, created_at } }`。描述可随业务同步，已有描述在本机无原件时仍可用。 |
| 200 | `{ status: "not_generated" }` 表示 GET 查不到结果且本机已有原件登记和模型配置。GET 只检查登记和文件大小。 |
| 200 | `{ status: "blob_unavailable" }` 表示缺少本机登记或文件。POST 还会重新计算本次发送字节的 SHA-256，校验不符同样返回此状态。 |
| 200 | `{ status: "model_unavailable" }` 表示配置缺失或不合规，或 POST 调用本机模型失败、超时、输出不完整。 |
| 404 / 409 / 415 | 404 表示附件或来源不可用、不可见或无生成权限。409 `file_revision_changed` 表示请求修订过期，`not_writer` 表示请求抵达另一宿主。415 `description_unsupported` 表示类型或图片文件头不支持。 |

视觉模型须单独配置。以下命令在 `host/` 执行，`CATTT_VISION_MODEL` 填入已运行的本机 OpenAI 兼容服务中的视觉模型名。地址只接受 `127.0.0.1` 与 `[::1]`，默认关闭。请求使用 `POST /chat/completions` 的 base64 `image_url`，禁用代理与重定向，调用最长 60 秒。

```bash
CATTT_VISION_BASE_URL=http://127.0.0.1:11434/v1 CATTT_VISION_MODEL=你的本机视觉模型 bun src/main.ts
```

配对、上传后，用设备 token 和测试图片的附件 ID 复现。

```bash
curl -H "Authorization: Bearer $DEVICE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"file_rev":1}' "http://127.0.0.1:8788/v2/files/$FILE_ID/description"
```

业务描述和来源保存在 `file_descriptions`，由 R6.7 复制给已配对宿主。导入描述可直接读取，不触发视觉模型，也不要求本机已有原件。R4 上下文可用 `readVerifiedFileDescription(db, { fileId, fileRev })` 当场核对来源，再按成员和会话策略消费描述。

## R6.7 对端附件同步

按 [Peer 结对契约](../docs/参考/Peer-结对与传输契约.md) 配置两台宿主。既有同步调度追齐来源元数据后，按哈希向原创宿主拉取缺少的本体。`sync.status: caught_up` 对应元数据水位，单个原件的状态取设备清单的 `available`。未完成块保存在本机 `blobs/peer-downloads/<hostId>/<sha256>`，重启或暂停后从持久字节偏移继续。完整长度和 SHA-256 通过后才安装并登记。`/peer/blobs/:sha256` 只在认证的 peer 监听器上提供，使用与设备下载相同的单一区间语义。

R6.11 保留 R6.10 的 `0000–0019`，从该尾部生成 `0020`。迁移、升级试验和客户端接点见 [R6.11 合体清单](../docs/决策/2026-11-22-R6.11宿主与成员增量合体.md)。


## R8.14 共享院子

[/v2/world 设备契约](../docs/参考/API-v2-共享院子契约.md)规定家庭猫资料、会话、状态、动作与重连。成员增量同步 `world` 业务视图，短时在场及设备执行资格通过独立连接读取。使用 `bun test test/world.test.ts` 在真实回环 HTTPS 和 mTLS 上验证两个临时宿主。

## 一次性导入旧 PostgreSQL 数据

只在 Han 的 Mac 搬迁一次，另一台 Mac 使用空宿主加入家庭。为这次导入选一个独立的空目录，并用独立 PG 只读角色准备带主机、端口、账号和数据库的 `CATTT_IMPORT_PG_URL`。源码入口在仓库根目录运行。成品使用 `host/package.json` 的 `build` 命令编译，并可将输出命名为 `cattt`。

```bash
bun --no-env-file host/src/main.ts import-pg --target-dir /绝对路径/新宿主目录
host/dist/cattt-host import-pg --target-dir /绝对路径/新宿主目录
```

新库位于目录内的 `cattt.db`。有多个旧账号且无唯一宿主主人时，加 `--legacy-user-id UUID`。导入成功后 stdout 返回 JSON 账本；用同一快照重试会返回 `verified`。核对账本后，用该目录作为 `CATTT_DATA_DIR` 启动宿主并为 Han 重新配对。旧约定要由成员手动改期，旧托付要由成员补充后续办。

用临时 PG 执行 26 条旧 SQL 迁移及 R9.1 回归：

```bash
cd host
CATTT_TEST_PG=1 bun test test/import-pg.test.ts
```

目标写入、逐表映射及后续接入见 [R9.1 旧数据导入](../docs/决策/2026-11-22-R9.1旧数据导入.md)。

### v2 APNs

默认关闭。沿用旧宿主环境配置，启用条件、设备生命周期与 SQLite 迁移见 [R8.15 通知链路](../docs/决策/2026-11-22-R8.15通知链路.md)。

## R4.13 共享 Soul 与猫日记

[共享 Soul 与猫日记契约](../docs/参考/API-v2-共享Soul与猫日记.md)记录 `/v2/soul`、`/v2/cat-diary` 和 peer 协议 8 的重新确认步骤。猫日记使用本机 `extract` 槽位。显式 `MODEL_PROVIDER=mock` 在同一准入及账本路径生成模拟日记。缺少本机模型时计划保留待恢复。日额度和队列与 R4.8 共用。

### 集成验收

在 `host/` 用 `.bun-version` 指定的 Bun 复跑。将 PostgreSQL 17 的 `initdb`、`pg_ctl`、`psql` 加入 PATH，测试会创建临时库和只读导入账号。

```sh
CATTT_TEST_PG=1 bun --no-env-file test --timeout 60000 --retry 1
bun --no-env-file run typecheck
```

Bun 1.4.5 完整运行 61 个测试文件，280 项通过，0 失败，0 跳过，没有用到重试。包含临时 PostgreSQL 17 导入。宿主类型检查、仓库检查和跨端一致性检查通过。

两套独立的 R8.18 进程先按协议 7 组成家庭，再用原数据目录启动 R4.13。验证了混合版本要求升级、两端指纹及旧日记保留、管理重连后协议 8 的 mTLS 读写、共享 Soul 复制。迁移 0000–0024 的 50 个 SQL／快照文件和 journal、内嵌的 25 条历史记录逐字节核对。新增 0025 后旧 SQLite 可重开。

R8.18 的 Bun 1.4.4 冷窗口评测曾超出测试框架的 5 秒默认上限。托付作业在高负载下也会超过夹具原有的 2.5 秒轮询上限。复跑命令使用较长的测试上限，托付夹具延长等候检查点的时间。双宿主世界夹具使用随单调时间推进的墙钟并按渲染器行为续报观察。文件 API 夹具关闭了用不上的默认 peer 监听。PG 夹具复用一个客户端连接，每条旧迁移仍单独提交，测试上限延长到 180 秒。

本次验收使用合成数据、回环模型夹具及受控 mock。真实模型语义和 Mac／iPhone 终端验收留待对应批次。
