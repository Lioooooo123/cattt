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

Gateway 默认只监听 `127.0.0.1:8788`，可通过 `CATTT_PORT` 设置端口（0 表示系统分配端口）。`GET /v2/healthz` 返回 `{ ok: true, hostId, protocolVersion: 1 }`；其它请求返回 JSON 404。目前不提供业务接口。

`startHost(config, components)` 按顺序启动组件，共享 store、bus、clock、hostId 和 config。启动失败时逆序停止已启动组件；组件自身须清理尚未完成的启动。`stop()` 可重复调用，逆序停止组件并隔离、报告各停止错误，最后关闭数据库。SIGINT/SIGTERM 触发停止后以 0 退出。

`EventBus<Events>` 在进程内按主题分发类型化负载，发布不等待异步处理。每次发布使用订阅快照；取消订阅只影响后续发布。处理器抛错或拒绝交给构造时的 `onError`，不会影响其它处理器或发布者；错误回调自身的失败也被隔离。总线不持久化、不重放。

将来合并旧 x509/mTLS 代码时，`main.ts` 的第一个导入必须是 `import "reflect-metadata"`；当前尚未引入该依赖。

## 编译与迁移

`bun run db:generate` 仍用 drizzle-kit 创作迁移，随后运行 `scripts/embed-migrations.ts`，将 SQL、时间戳和哈希生成到 `src/store/migrations.generated.ts`。迁移文件与生成文件一起提交；手动编辑既有迁移后也须运行该脚本。漂移测试逐项对比内嵌数据与 `drizzle/`。

打开数据库使用内嵌迁移和 Drizzle 的同步迁移器，不读取磁盘迁移目录。`bun run build` 将入口编译为 `dist/cattt-host`，无需随附 `drizzle/` 或 `node_modules/`。测试会实际编译程序，在不含迁移目录的临时工作目录启动、访问健康检查，并验证 SIGTERM 正常退出。
