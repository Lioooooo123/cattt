# macOS 团子客户端与宿主

DMG、签名、公证与首次启动：[发布说明 / Releasing](RELEASING.md)。

F 批宿主能力继续保留：SwiftPM 宿主、无界面运行、应用打包、状态菜单、手机配对窗口和模型设置；本版在同一个 `Cattt.app` 增加 Dock 可见的小院与聊天主窗口。主窗口直接加载已打包的 3D 小院，聊天使用宿主 loopback API 和一次性配对码；设备凭证按数据目录归属保存在 macOS 钥匙串中。没有新增服务端接口，也不把管理令牌或设备凭证交给网页。云部署交付物已移除，保留 `server/docker-compose.yml` 供源码开发使用。

宿主初始化、健康轮询、备份恢复及退出都在后台串行队列运行；菜单通过可观察状态更新，不等待数据库或网络请求。菜单提供各组件状态、启动错误、配对、DeepSeek 密钥设置、备份恢复、目录入口和登录自启动。普通备份的每日到期时间以现有最新完整普通备份的修改时间为准，不因重新启动宿主而延期。

配对窗口按服务端接口请求配对码和设备列表；二维码、有效期、证书短指纹与移除设备接口已接入。小院聊天使用 `host-admin.token` 生成配对码，再通过 `/pair` 换取同一宿主账号的设备凭证；后续聊天只向 `127.0.0.1:8787` 发送设备凭证，身份失效时只自动重新配对一次。

登录自启动使用 `SMAppService.mainApp`，首次打开尝试注册。已在本机将临时签名应用安装到 `/Applications/Cattt.app`，验证注册和菜单开关的取消注册／重新注册；系统记录分别为 enabled、disabled、enabled。未通过退出登录再登录验证真正的登录启动。自定义 `--data-dir` 参数不由系统登录项保留，登录项会使用默认数据目录。

需要 Apple Silicon、macOS 14+、Xcode 命令行工具、pnpm；先安装网页与服务端依赖：

```sh
pnpm --dir web install --frozen-lockfile
pnpm --dir server install --frozen-lockfile
```

```sh
swift test --package-path desktop/macos
bash desktop/macos/scripts/build-app.sh
bash desktop/macos/scripts/smoke-host.sh
```

构建使用缓存中经过 SHA256 验证的 Node 22.16.0 和 EDB PostgreSQL 17.7；`build-app.sh` 输出 `build/Cattt.app` 和开发 DMG，仅临时签名，未公证。正式发布或生成可安装开发镜像请使用下面的发布流程。
构建脚本执行 `pnpm --dir web build:ios`，并将输出复制到 `Cattt.app/Contents/Resources/YardWeb`；运行时不需要网页开发服务器。正常启动会显示小院主窗口；关闭窗口不会退出菜单栏宿主，Dock 重开和菜单中的「打开小院」均可重新打开。宿主就绪后自动加载聊天历史；网络中断后按事件游标续接，未确认接收时用稳定 `client_message_id` 重试，已接收的消息改走既有回复接口。停止回复时，按屏幕已显示的 UTF-16 长度保存。
发送时可停止等待，尚未确认送达的消息可安全重试。本机聊天连接空闲 12 秒超时，健康连接上的 SSE 心跳不会打断模型生成。客户端收到文本增量即显示；后端允许调用工具的阶段会先缓冲文本，可能整段送达。
开发 DMG 未公证，从浏览器下载后可能被 Gatekeeper 拦截。正式分发需要 Developer ID 签名和 Apple 公证（notarization）。开发试用无需更改 Gatekeeper：从源码构建后直接打开本机生成的应用。

### 不配置模型也能试用聊天

先退出任何已运行的团子宿主（客户端仍使用 8787、8788 和 54329）。在仓库根目录安装上述依赖并运行构建命令，然后运行：

```sh
TRIAL_DIR=$(mktemp -d "${TMPDIR:-/tmp}/cattt-trial.XXXXXX")
(umask 077; printf 'MODEL_PROVIDER=mock\n' > "$TRIAL_DIR/env")
open desktop/macos/build/Cattt.app --args --data-dir "$TRIAL_DIR"
```

小院加载后，可以点击团子让它动动耳朵；等聊天旁显示已连接即可发消息。模拟模型不会联网，回复是预设的；这次对话只存入试用目录。退出 App 后在同一终端重跑 `open` 命令可查看试用记录。日常使用时正常打开本机应用，从窗口的「设置」选择模型，不传 `--data-dir`。

### 宿主烟测

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

备份含数据库、TLS、管理令牌和模型配置（包含密钥，务必妥善保管）。保留普通备份 7 份、升级前及恢复前备份 3 份。恢复前暂停服务并备份当前状态，应用备份后验证本机 API 和 HTTPS。恢复出错时尝试自动回退，回退也失败时保留恢复前备份并报告其名称。数据库主版本不符会拒绝启动，不自动升级。

恢复后的宿主用新的日记同步世代让已配对的新版 iOS 重新拉取，手机保留尚未上传的内容，旧分享需要重新确认。若备份早于当前手机的配对，手机需重新配对。菜单的「局域网 HTTPS」验证本机 TLS 监听和证书，手机到电脑的网络可达性由手机连接确认。worker 状态来自最近的队列检查，可显示投递失败或有待办积压。

## Bun 成品与共享小院

Apple Silicon、macOS 14+。Bun 版本见 `host/.bun-version`。应用包内运行一个 Bun 进程，随包提供 SQLite 迁移、隔离计算入口和 `Contents/Resources/YardWeb`。

```sh
pnpm --dir web install --frozen-lockfile
bash desktop/macos/scripts/build-bun-app.sh
APP=desktop/macos/build/CatttBunHost.app
codesign --verify --deep --strict "$APP"
```

菜单栏可打开小院、共享设置、备份和恢复。共享设置中先交换 Mac 描述符并核对完整指纹，在已有家庭的 Mac 上批准，再到另一台 Mac 连接并加入。手机配对码、邀请与同步水位也在此查看。聊天面板使用本机成员的设备凭证，保存于 macOS 钥匙串。本机管理请求走回环，设备请求走本人宿主的固定 CA HTTPS，Mac 复制使用独立 mTLS。

小院窗口显示宿主确认的位置、环境和在场成员。有发布权且取得执行资格的设备可邀请团子移动或陪坐。小院以 3D 实际就位或 `sit_idle` 回报，并在宿主确认后显示成功。副本继续展示已同步状态。相同成员在另一设备重新注册会替换当前会话，Mac 在自动重连一次后交给用户决定是否重连。

### 独立试用、备份与恢复

```sh
TRIAL_DIR=$(mktemp -d "${TMPDIR:-/tmp}/cattt-bun-trial.XXXXXX")
(umask 077; printf 'MODEL_PROVIDER=mock\n' > "$TRIAL_DIR/env")
open -n "$APP" --args --data-dir "$TRIAL_DIR" --port 28788 --lan-port 28789 --peer-port 28790
LAUNCHER="$APP/Contents/MacOS/CatttBunHost"
"$LAUNCHER" --headless --data-dir "$TRIAL_DIR" --port 28788 --lan-port 28789 --peer-port 28790 --backup
# 退出当前试用宿主后，将下方路径换成上一步返回的目录
"$LAUNCHER" --headless --data-dir "$TRIAL_DIR" --port 28788 --lan-port 28789 --peer-port 28790 --restore /path/to/backup
```

默认端口分别为 18788、18789、18790。无界面模式必须显式指定数据目录。备份包含 SQLite 快照、TLS、配置、已完成的本机附件和未完成上传的续传字节，附带 SHA-256 清单。包内应用和小院静态资源随构建交付。恢复期间暂停业务，验证回环和可信 HTTPS 后再开放请求。恢复更换手机同步世代，较新的已确认业务可能由恢复前的数据库保留。备份目录含本机私钥和模型配置。

### R8.24 合体与复验

默认构建当前工作树的 `host/` 和 `web/`。R8.18 的 iOS/Web 桥、共享世界、peer v7、通知、模型和 `import-pg` 随包构建。R8.24 接入 R8.11 备份恢复、R8.20 桌面管理、成员与邀请读取。mTLS 的维护响应有 `X-Cattt-Peer-Version`，旧成员游标和旧轮次 SSE 游标各按自己的契约处理。迁移继续使用 R8.18 的 0000–0024，合体接续见 [R8.24 决策](../../docs/决策/2026-11-22-R8.24桌面宿主合体.md)。

```sh
CATTT_R85_TEST_APP="$PWD/$APP" swift test --package-path desktop/macos
pnpm --dir web test:app
python3 desktop/macos/scripts/smoke-bun-host.py
python3 desktop/macos/scripts/smoke-bun-backup.py
python3 desktop/macos/scripts/smoke-bun-yard.py --fixture-renderer --chat-actions --skip-build
```

固定帧运行覆盖 Swift 桥到真实 HTTPS 的移动、陪坐和宿主回执。`--chat-actions` 用回环模型协议桩额外通过聊天发送「去池塘」，核对原话 ID 对应的动作和宿主快照。真实画面需在可用 macOS 桌面主动运行 `python3 desktop/macos/scripts/smoke-bun-yard.py --visible-window --skip-build`，命令会前置一个临时 XCTest 窗口。默认后台模式保留启动诊断。后台窗口已重现 `ready=true` 且无 `visualReady`，视口为 960×660、绘图缓冲为 1440×990、WebGL 上下文未丢失，页面处于 `hidden` 且探针收不到 `requestAnimationFrame`。前置窗口、界面布局、菜单操作和系统钥匙串弹窗仍待人工复验。
