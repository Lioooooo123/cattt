# macOS 团子宿主

F 批已实施：SwiftPM 宿主、无界面运行、应用打包、状态菜单、手机配对窗口和模型设置；云部署交付物已移除，保留 `server/docker-compose.yml` 供源码开发使用。

宿主初始化、健康轮询、备份恢复及退出都在后台串行队列运行；菜单通过可观察状态更新，不等待数据库或网络请求。菜单提供各组件状态、启动错误、配对、DeepSeek 密钥设置、备份恢复、目录入口和登录自启动。普通备份的每日到期时间以现有最新完整普通备份的修改时间为准，不因重新启动宿主而延期。

配对窗口按服务端接口请求配对码和设备列表；旧版服务端返回 404 时显示“这个版本的服务端还不支持配对”。二维码、有效期、证书短指纹与移除设备接口已接入，当前 main 的真实配对流程需等服务端对应批次合入后再联调。

登录自启动使用 `SMAppService.mainApp`，首次打开尝试注册。已在本机将临时签名应用安装到 `/Applications/Cattt.app`，验证注册和菜单开关的取消注册／重新注册；系统记录分别为 enabled、disabled、enabled。未通过退出登录再登录验证真正的登录启动。自定义 `--data-dir` 参数不由系统登录项保留，登录项会使用默认数据目录。

需要 Apple Silicon、macOS 14+、Xcode 命令行工具、pnpm；先在 `server` 运行 `pnpm install --frozen-lockfile`。

```sh
swift test --package-path desktop/macos
bash desktop/macos/scripts/build-app.sh
bash desktop/macos/scripts/smoke-host.sh
```

构建使用缓存中经过 SHA256 验证的 Node 22.16.0 和 EDB PostgreSQL 17.7；输出 `build/Cattt.app` 和 DMG，仅临时签名，未公证。
当前构建为 ad-hoc 签名，下载副本会被 Gatekeeper 拦截。确认来源可信后可右键打开，或对应用执行 `xattr -dr com.apple.quarantine /path/to/Cattt.app`。正式分发需要 Developer ID 签名和 Apple 公证（notarization）。
烟测不启动或依赖 Redis；运行前要求没有 `redis-server` 进程，并验证健康 JSON 中 `ok=true`、`db=true` 且无 `redis` 字段。它使用自己的新数据目录，但仍需空闲的 8787、8788 和 54329 端口；不要与运行中的宿主同时执行。

首次启动无需模型密钥：API 和 worker 照常运行，不内置开发者密钥，也不会自动切换 mock。未设置 `MODEL_PROVIDER` 时与服务端一致使用 `openai-compatible`，默认 `OPENAI_COMPAT_BASE_URL=http://127.0.0.1:11434/v1`（Ollama，也可指向 LM Studio 等兼容服务）。填 `OPENAI_COMPAT_MODEL` 设置共用模型名，聊天槽位的 `CHAT_MODEL` 优先；`MAOMAO_OPENAI_COMPAT_API_KEY` 可选，本机服务通常不需要。

菜单分别显示“本地模型”和“DeepSeek”，并在对应行标出全局默认来源。本地行显示共用模型名、在线／未启动／服务错误；配置了本地模型时，无论全局 provider 是什么，后台都会请求 `<base>/models`（2 秒超时，带可选 Bearer key）。可达不代表模型已下载或推理成功；DeepSeek“已配置”只表示已保存 key，不代表远程验证通过。`MODEL_PROVIDER=mock` 会标为默认测试模式。这些状态不阻止服务启动。烟测使用全新数据目录、不设置模型 provider 或密钥，验证服务进程和健康接口。

保存 DeepSeek key 或本地模型设置成功后，宿主会重新计算 `<data>/env` 的分工并重启 API/worker，不需要切换模式：

| 已配置来源 | 宿主写入规则 |
|---|---|
| 本地模型与 DeepSeek key 都有 | `MODEL_PROVIDER=openai-compatible`，保留 `OPENAI_COMPAT_MODEL` 与当前 `OPENAI_COMPAT_BASE_URL`（未设则为 `http://127.0.0.1:11434/v1`），保留 `MAOMAO_DEEPSEEK_API_KEY`；写 `CHAT_PROVIDER=deepseek`、`ROUTER_PROVIDER=deepseek`、`WORKER_PROVIDER=deepseek` |
| 只有本地模型 | `MODEL_PROVIDER=openai-compatible`，保留本地模型与地址；清除上述三个 provider 覆盖 |
| 只有 DeepSeek key | `MODEL_PROVIDER=deepseek`；清除上述三个 provider 覆盖 |

记忆提取、边界摘要和模型辅助回忆走 EXTRACT，默认继承全局本地来源；聊天、路由和后台处理用 DeepSeek。宿主在这两种保存操作中管理 CHAT/ROUTER/WORKER 的 provider（旧覆盖会被替换或清除），**不改任何槽位的 `*_MODEL`、`EXTRACT_PROVIDER`、思考或并发参数**；用户已有覆盖仍优先，菜单角色标签按实际 provider 显示。填 key 不会删除本地模型，设置本地模型不会删除 key，env 权限保持 0600。两者均未配置时继续使用服务端默认语义，不内置 key。

双来源与单来源转换、保留覆盖、状态和写入权限由 `ModelConfigurationTests` 覆盖。可选的 `testBundledMixedConfiguration` 会用占位 key 启动实际随附服务，并验证两种保存路径重启后的健康状态；需先重建应用，将 `scripts/model-config-probe.ts` 按服务端相同的 esbuild 参数打包，再设置 `CATTT_HYBRID_CHECK_RESOURCES`（应用 Resources）、`CATTT_HYBRID_MODEL_PROBE`（探针 bundle）与 `CATTT_HYBRID_CHECK_DATA_ROOT`（新的烟测数据父目录）运行该测试。探针直接调用服务端 `modelConfigProblems` 与 `slotSpec`，不发起收费模型请求。端口要求与烟测相同；数据目录路径须足够短，以容纳 PostgreSQL 的 Unix socket。

“设置本地模型…”会先检测硬件，显示 Qwen2.5 推荐标签与下载量，再由用户点击“下载并测试”明确同意。首次没有本地模型名和 DeepSeek key 时自动打开一次（`host-state.json` 的 `modelSetupPrompted`，升级保留）；缺配置或本地服务未启动时菜单标为推荐入口。Ollama 必须自行从 https://ollama.com/download 安装并启动，窗口可重新检测；宿主不会安装或捆绑 Ollama。

打包包含 `Resources/server/model-setup.mjs`，由随附 Node 运行 `--json --env-file <data>/env`，确认下载后才加 `--yes --model <推荐标签>`。子进程继承当前数据目录配置和密钥，PATH 包含 `/usr/sbin:/sbin` 以识别 Apple Silicon。窗口显示下载进度及中文回复／工具调用烟测结果；仅收到“配置已保存”才按上表计算分工、重载配置并重启 API/worker，退出码 0 本身不代表切换成功。取消或关闭运行中的设置窗口会终止子进程并恢复原 env（已下载的数据可由 Ollama 缓存），不会自动换模型；失败可填写 DeepSeek key。下载独立于宿主监督队列，退出应用会先取消设置再停服务。

默认数据在 `~/Library/Application Support/Cattt`，可以 `--data-dir` 或 `CATTT_DATA_DIR` 覆盖。`env` 是权限 0600 的 `KEY=VALUE` 文件（支持整行注释及引号，不执行 shell）；修改后重启宿主，或用菜单切换到 DeepSeek。测试可用 `MODEL_PROVIDER=mock`。

```sh
desktop/macos/build/Cattt.app/Contents/MacOS/CatttHost --headless --data-dir /path/to/data
# 先退出正在运行的宿主，再执行一次性操作；也可以直接使用菜单
desktop/macos/build/Cattt.app/Contents/MacOS/CatttHost --headless --data-dir /path/to/data --backup
desktop/macos/build/Cattt.app/Contents/MacOS/CatttHost --headless --data-dir /path/to/data --restore /path/to/backup
```

备份含数据库、TLS、管理令牌和模型配置（包含密钥，务必妥善保管）。保留普通备份 7 份、升级前备份 3 份。恢复前自动备份当前状态；恢复后重新运行宿主。数据库主版本不符会拒绝启动，不自动升级。
