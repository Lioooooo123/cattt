# 团子评测（聊天、托付与对比）

现有 `host/test/memory-eval/` 仍是独立的记忆专项评测，与本系统并存，本轮未迁移。

从 `host/` 执行：

```sh
bun run eval run --suite chat-couple --mode scripted
bun run eval run --suite all --mode env --case partner-attribution --out eval-runs/manual
bun run eval run --suite all --mode env --judge env
bun run eval compare --baseline eval-runs/scripted --candidate eval-runs/manual --fail-if-drop pass_rate=0.05 --fail-if-drop suite:chat-couple=0
```

`scripted` 不联网，用用例给定的回复检查管线，同时用真实 SQLite、记忆来源/撤回/更正、边界与生产上下文组装检查出站 system。它不证明模型能生成同样回复。
`env` 用 `modelConfigFromEnv(process.env)` 和 `createChatModel`；例如 `MODEL_PROVIDER=deepseek` 配 `MAOMAO_DEEPSEEK_API_KEY`，或 `MODEL_PROVIDER=openai-compatible` 配 `OPENAI_COMPAT_MODEL`、`OPENAI_COMPAT_BASE_URL`。不要把密钥写入套件。

每行 JSONL 是独立用例。成员 ID 在用例内稳定；subject/source 指向成员 ID，subject=null 表示共同事实。记忆用 source_text 建真实来源，再经 saveMemory 保存；replaces 指向前面的记忆并走 replaceMemory；withdrawn 撤回原始来源。边界须由本人提供。prior_messages 可指定其他会话来验证原话范围，sender=cat 表示猫的历史回复。单聊须指定 member；群聊不指定。

确定性 scorer 只在对应期望非空时计分；context_* 只查目标模型实际出站 system（含相关记忆分节），不把历史原话混入记忆断言。所有 scorer 通过且无执行错误才通过；没有断言的用例不产生虚构 scorer。原话范围只测试哪些会话的原话进入当前请求，不表示伴侣间存在隐私规则。

`--judge none|env` 默认 none；expect.judge 是一条中文标准或标准数组。env 使用已配置 router 槽（无模型名时回退 chat），temperature=0，逐标准严格解析 `{score:1..5, passed, reason}`，4 分起通过；JSON/schema 错误及分数矛盾都是失败 scorer。裁判 trace 标记 purpose=judge，不进入上下文确定性检查。与目标同供应商的裁判可能有共同偏差，不替代人工评审。

worker 用 scripted_steps 数组描述每步 calls（name/input），工具调用 ID 自动生成；env 使用真实 worker 槽和宿主预算。默认只提供 get_time/report，不伪造联网工具。固定时钟为上海时间 2026-11-22 11:42。expect.tool_calls 检查实际观察的工具名有序子序列；report_status/report_contains/max_steps 检查持久报告及步骤。worker 目前只支持无记忆/边界/历史的单聊用例，其他 setup 显式报错，不会静默忽略。trace 保存模型请求/响应及持久步骤中的调用、观察。

事项 goal 使用用例 description（生产限制为 60 个 Unicode 字符），完整执行指令保留为 input.text 的来源原话。worker 的模型包装走宿主预算与准入，当前短套件不启用工具历史摘要。后台临时库在单例结束后清理，持久证据以 results.jsonl 中的步骤和 trace 为准。

compare 接受运行目录或 results.jsonl，输出到候选目录 compare.md/compare.json。门禁是通过率绝对比例下降容忍值（0.05 为 5 个百分点），可重复指定；无法比较（空分母或缺套件）的已配置门禁失败。列出通过→失败、失败→通过、新增和缺失用例；总体/套件分母按各运行全部用例，新增缺失应与差值一起解释。scripted 对真实运行只能作为管线 smoke，不是等价模型质量基线。

结果在 `host/eval-runs/<时间戳>/`，含 results.jsonl、summary.json、report.md；任一用例失败退出 1，参数/解析错误也退出 1。P95 使用 nearest-rank；耗时包含建库、准备上下文及模型回复。按标签统计时一例可属于多个标签，不可相加当总数。模型 trace 保存出站 system/messages、文本、耗时和错误，可能含敏感原话，请勿提交或公开。

聊天目标只评测 ChatReplier + assembleChatRequest，不涵盖 HTTP/SSE、持久 turn、租约、HostModelRuntime 预算记账或前台工具。scripted 使用 mock provider，因此不触发生产的事实编号选择分支；env 的非 mock 模型可触发它。聊天及裁判调用有 60 秒取消信号；worker 通过 registerTicketWorkers + JobRunner + dispatchTicketCommand，最多等待报告 120 秒，随后停止作业并保留已完成步骤。目标耗时不含裁判耗时。
