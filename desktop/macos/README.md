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

菜单显示默认来源的地址与聊天模型名；现有后台健康轮询会请求 `<base>/models`（2 秒超时，带可选 Bearer key），连接失败显示“本地服务未启动”，HTTP 错误显示状态码。可达不代表模型已下载或推理成功；缺模型名时明确显示“未配置模型名”。`MODEL_PROVIDER=deepseek` 时按 `MAOMAO_DEEPSEEK_API_KEY` 是否存在显示配置状态，菜单填写 DeepSeek key 会同时设置该 provider；`MODEL_PROVIDER=mock` 显示“测试模式”。这些状态不阻止服务启动。烟测使用全新数据目录、不设置模型 provider 或密钥，验证服务进程和健康接口。

默认数据在 `~/Library/Application Support/Cattt`，可以 `--data-dir` 或 `CATTT_DATA_DIR` 覆盖。`env` 是权限 0600 的 `KEY=VALUE` 文件（支持整行注释及引号，不执行 shell）；修改后重启宿主，或用菜单切换到 DeepSeek。测试可用 `MODEL_PROVIDER=mock`。

```sh
desktop/macos/build/Cattt.app/Contents/MacOS/CatttHost --headless --data-dir /path/to/data
# 先退出正在运行的宿主，再执行一次性操作；也可以直接使用菜单
desktop/macos/build/Cattt.app/Contents/MacOS/CatttHost --headless --data-dir /path/to/data --backup
desktop/macos/build/Cattt.app/Contents/MacOS/CatttHost --headless --data-dir /path/to/data --restore /path/to/backup
```

备份含数据库、TLS、管理令牌和模型配置（包含密钥，务必妥善保管）。保留普通备份 7 份、升级前备份 3 份。恢复前自动备份当前状态；恢复后重新运行宿主。数据库主版本不符会拒绝启动，不自动升级。
