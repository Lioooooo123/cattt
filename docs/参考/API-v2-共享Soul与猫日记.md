# API v2 共享 Soul 与猫日记

统一宿主追加 `0025_r4_shared_soul_diary.sql`，前 25 条迁移沿用 R8.18。宿主间 peer 协议 8 增加 `cat_fact`，保留原有行为和在场接口。事实带猫、家庭、创作宿主、发布 epoch 与 grant。读请求支持任一已同步副本，写请求由当前发布宿主处理。

协议 7 配对升级后，既有记录会显示 `sync.status: "upgrade_required"`。升级两台宿主并保留各自的数据目录。在宿主 A 的回环管理接口读取 `GET /host/peer-identity`，核对原指纹及当前地址后，在宿主 B 的同一管理入口调用 `POST /host/peers/connect`。请求体使用 A 的描述符作为 `identity`，A 的指纹作为 `confirmed_fingerprint`，省略 `join_household`。若 B 的地址也已更换，先在 A 用 `PUT /host/peers/:id` 核对并保存 B 的地址和描述符。两端 `GET /host/peers` 应显示协议 8、`access: "read_write"`，同步完成后可执行需要共享发布权的操作。详见[宿主管理接口](../../host/README.md)。

## Soul

| 接口 | 请求或返回 |
| --- | --- |
| `GET /v2/soul` | `{ soul }`，包含 `version`、`core`、共享 `habits`、`runtime`、可用条目及当前成员的 `relationship` |
| `POST /v2/soul` | `{ expected_version, source: { message_id, revision }, change }`。确认者必须是来源原话的成员 |
| `POST /v2/soul/withdraw` | `{ expected_version, entry_id }`。只有对应条目的确认者可以撤回 |
| `GET /v2/world/state` 及世界状态 SSE | 在现有世界响应中附带调用成员的 `soul` |

Soul 版本从 1 起。一个来源只能提交一次某个维度。`change` 的 `kind` 为 `response_length`、`advice`、`cat_expression`、`nickname`、`relationship` 或 `state`。前五项使用 `value`。称呼可设为 `null`，关系为 `getting_to_know` 或 `familiar`。临时状态使用 `energy`、`willingness` 和 1–1440 的 `duration_minutes`。有效期的 `expires_at` 为 Unix 毫秒。已导入的习惯可用原消息撤回接口失效。聊天将来源附在已有的回复许可检查上。

## 猫日记

| 接口 | 请求或返回 |
| --- | --- |
| `GET /v2/cat-diary` | `{ entries, calendar }`。新作带 `origin: "daily"`、稳定 ID、归档日、时区、正文、模型标识、输入摘要及当前仍可证明的引用。旧作带 `origin: "legacy"` 和旧归属 |
| `POST /v2/cat-diary/sources` | `{ kind: "message" \| "diary", id, revision }`。只确认本人仍可供团子使用的修订。重复确认同一修订返回原确认 ID |
| `PUT /v2/cat-diary/time-zone` | `{ time_zone, expected_version }`。作用于共享日历，初始设置版本为 0 |

已有的鉴权、日记逐条许可和消息来源撤回生效。根据当前本地副本的权限实时渲染，跨机更新按复制链路到达。日记内容撤回不改日期、日记标识或出版收据。来源清单使用事实卡 ID 与正文摘要，不返回聊天引用的跳转链接。状态冲突返回 `version_conflict`。无效来源返回 `source_unavailable`。群聊发布凭据错误按小院契约返回 409 与当前 `publisher_host_id`。

## 模型与预算

`HostConfig.dailyDiaryModel` 接受受控测试用的 [DailyDiaryModel](../../host/src/soul/diary-writer.ts)。适配器收到日历日期、团子人格和已许可事实卡，返回待校验的 `{ reflection, fact_ids }`。调用参数包含 `purpose: "cat_diary"`、以日期计划 ID 为准的稳定 `operationId`、输入及输出预算和取消信号。等待模型槽位后实际派发前调用 `canUse()`。计算队列提交本机持久草稿，Router 出版队列再复核作业认领、租约、事实卡和输入摘要，同事务写共享日记收据。

默认适配器使用 R4.8 的 `HostModelRuntime.text("cat_diary", { slot: "extract", jobId })`。模型来源限回环 OpenAI 兼容端点或显式 `MODEL_PROVIDER=mock`。HTTP 跳转会失败，等待和生成共享 15 秒超时，单次输入保守上限 3000 token、输出上限 1600 token。同端点使用同一队列，空位优先给前台；预留计入同一宿主的 UTC 日账本。超出单次输入或日额度、模型输出无效或调用失败时出模板。缺少本机 extract 时作业保留待恢复，配置完成并重启后可续办。等待中发生撤回时，作业重新读取来源后才能派发。

真实本机模型通过严格 JSON Schema 返回 `{ feeling, fact_ids }`，在有限的感受词和已审核卡片中选择。四张以内按输入顺序全部保留，超过四张时模型最多选择四张。卡片短编号仅在该次调用内有效，宿主校验后按审核卡原顺序映射回原卡片 ID。宿主把模型所选感受写成第一人称短句，并从当前可用的审核卡逐字渲染地点和带署名的引文。出版记录中的 `writer` 标识提供选择的模型。若模型见过的卡片后来不可用，读取时用安静短句替换原感受，保留仍然有效的引用与原出版记录。

## 宿主接点

| 接点 | 实现 |
| --- | --- |
| 设备 API 和调度 | [Soul 和猫日记路由](../../host/src/soul/routes.ts)挂在 Gateway 的 v2 鉴权下。[统一入口](../../host/src/runtime/application.ts)注册日历、计算和 Router 出版队列 |
| 聊天上下文与小院 | [currentSoul](../../host/src/store/soul.ts)提供可见的相处信息和来源引用，[聊天上下文](../../host/src/context/chat.ts)将其纳入出版复核。[小院仓储](../../host/src/store/world.ts)在观察和到达确认时写猫日记事实 |
| 模型 | [日记适配器](../../host/src/soul/diary-writer.ts)调用[宿主模型运行时](../../host/src/runtime/model.ts)中的 `cat_diary`，使用已有队列和模型账本 |
| 复制与交接 | [猫事实适配器](../../host/src/store/cat-fact-replica.ts)查验来源依赖。[发布仓储](../../host/src/store/publication.ts)将猫事实计入现有历史摘要 |
| 旧数据 | [旧 Soul 投影](../../host/src/store/legacy-soul.ts)读取已验证的导入归档，[猫日记仓储](../../host/src/store/cat-diary.ts)合并旧猫日记和新日记 |

### 相对 R8.18 的文件清单

以下代码路径相对于 `host/`。

- 迁移在 `drizzle/0025_r4_shared_soul_diary.sql`、`drizzle/meta/0025_snapshot.json`、`drizzle/meta/_journal.json` 和 `src/store/migrations.generated.ts`。
- Soul、猫日记与出版在 `src/soul/{daily-diary,diary-date,diary-writer,facts,routes,rules}.ts`、`src/router/cat-diary.ts` 和 `src/store/{cat-diary,cat-fact-replica,cat-facts,cat-source,legacy-soul,soul}.ts`。
- 整合入口在 `src/context/chat.ts`、`src/gateway/index.ts`、`src/llm/mock.ts`、`src/member-resources/routes.ts`、`src/peer/protocol.ts`、`src/runtime/{application,index,model}.ts` 和 `src/turns/chat-replier.ts`。
- 仓储整合在 `src/store/{publication,replica-records,world-replicas,world}.ts` 和 `src/store/schema/{cat-facts,index}.ts`。
- 回归在 `test/{binary,cat-diary-admission,files-gateway,import-pg,migrations,soul-diary,ticket-workers,world}.test.ts` 和 `test/fixtures/import-pg.sql`。

文档包括本契约、[文档索引](../README.md)、[R4.9 决定](../决策/2026-11-22-R4.9共享Soul与猫日记.md)、[R4.13 决定](../决策/2026-11-22-R4.13统一宿主共享Soul与猫日记.md)、[共享院子契约](API-v2-共享院子契约.md)和[宿主说明](../../host/README.md)。
