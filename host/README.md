# 新宿主后端

R1 存储地基，与 `../server/` 并行建设，尚未接入客户端或 macOS 宿主。使用 `.bun-version` 指定的 Bun 版本。

在本目录执行：

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run db:generate
```

`src/store/index.ts` 的 `openStore(path)` 接受文件路径或 `:memory:`，自动运行 `drizzle/` 迁移，返回 Drizzle `db`、原生 `raw` 和 `close()`。文件的父目录应已存在。文件库启用 WAL，连接启用外键、NORMAL 同步和 5 秒忙等待。

业务代码通过 `src/store/` 的仓储函数访问数据，例如 `getHostMeta`、`setHostMeta`。`writeTransaction(store, callback)` 使用立即写事务；回调必须同步，不得进行异步操作，抛错时回滚。连接用毕调用 `close()`。

设计边界见[重构地基决策](../docs/决策/2026-11-22-重构地基-Bun与SQLite.md)。
