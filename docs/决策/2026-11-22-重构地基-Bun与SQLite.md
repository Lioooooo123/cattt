# 重构地基：Bun 与 SQLite

R1 完成：`host/` 已具备 store、clock、ids、bus、runtime、gateway、jobs、leases、chat-events；旧服务与客户端尚未切换，后续业务和复制能力仍按重构阶段推进。

R2 身份完成：`host/` 已具备家庭/宿主/成员/设备身份、Actor 与访问规则、本机凭证哈希、本机 CA 与 LAN HTTPS、设备配对及解除配对、首成员引导、成员邀请与移除、回环管理 API，以及双成员真实监听端到端测试；客户端切换、会话归属授权和跨 Mac 复制仍留在后续阶段。

R3 对话完成：群聊与成员各自单聊、参与者维护、稳定历史分页、幂等发送、本机轮次与租约 fencing、SSE 回放/快照、取消/重答/取代、OpenAI 兼容与 DeepSeek 流式 ChatReplier，以及 mock 模型下的双成员 LAN HTTPS 端到端验证。聊天契约保持 snake_case 与既有形状；完整上下文、记忆、soul 和边界控制属于 R4，跨 Mac 复制另行实现。

1. 新后端放在顶层独立包 `host/`，与旧 `server/` 并行建设；旧服务保持不变，待后续导入工具完成核对后再切换。本批只建立 R1 存储地基，不接入现有客户端或宿主打包。
2. 新后端运行时使用 Bun 1.x，版本固定在 `host/.bun-version`，依赖以 `bun.lock` 锁定。SQLite 使用内置 `bun:sqlite` 和 `drizzle-orm/bun-sqlite`，替代方案中的 better-sqlite3。
3. `host/src/store/` 是 SQLite 细节的唯一归属：连接、PRAGMA、同步的立即写事务、迁移与仓储函数均在其中。业务代码通过仓储访问，不直接导入 SQLite 或使用原生 SQL 模板；schema 不反向引用业务代码。
4. 迁移从零建立新基线，不继承旧 PostgreSQL 迁移链。首个基线只有 `host_meta`；打开数据库时自动幂等迁移。旧数据导入另行实现，本批不搬迁或删除旧数据。
