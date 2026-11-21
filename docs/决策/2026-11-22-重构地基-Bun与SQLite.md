# 重构地基：Bun 与 SQLite

1. 新后端放在顶层独立包 `host/`，与旧 `server/` 并行建设；旧服务保持不变，待后续导入工具完成核对后再切换。本批只建立 R1 存储地基，不接入现有客户端或宿主打包。
2. 新后端运行时使用 Bun 1.x，版本固定在 `host/.bun-version`，依赖以 `bun.lock` 锁定。SQLite 使用内置 `bun:sqlite` 和 `drizzle-orm/bun-sqlite`，替代方案中的 better-sqlite3。
3. `host/src/store/` 是 SQLite 细节的唯一归属：连接、PRAGMA、同步的立即写事务、迁移与仓储函数均在其中。业务代码通过仓储访问，不直接导入 SQLite 或使用原生 SQL 模板；schema 不反向引用业务代码。
4. 迁移从零建立新基线，不继承旧 PostgreSQL 迁移链。首个基线只有 `host_meta`；打开数据库时自动幂等迁移。旧数据导入另行实现，本批不搬迁或删除旧数据。
