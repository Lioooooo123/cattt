# Cattt · 猫猫

一款以猫为伴的 iOS App。团子住在毛毡小院里，有自己的性格、作息和小情绪。你可以来看看它、聊会儿天，或记下一天里的小事；几天不来，它也不会催你。

项目包含 SwiftUI 客户端、Three.js 3D 小院和支持长期记忆与异步托付的后端。后端运行在用户自己的 macOS 电脑上，由菜单栏宿主管理；不提供云托管部署包。目前处于开发阶段，设备验收与联调边界见[项目文档](docs/README.md)。

## 主要功能

- **3D 小院**：团子会散步、喝水、休息和玩耍，院子随时段与天气变化；支持拖动、缩放和找团子。
- **聊天与记忆**：流式对话、历史回看和断线恢复；可查看、更正或撤回记忆，设置不想再聊的话题。
- **私人日记**：按日记录和回看，默认私密。只有主动允许团子阅读的日记，才会用于回应或留言。
- **约定与托付**：约好之后再聊，也可以让团子在后台整理想法。失败或受阻的托付可在聊天中补充后继续原事项。
- **猫的个性**：气质影响团子在院子里的活动与聊天方式；团子也会写自己的日记。

院子是 App 首页，聊天、日记和“我的”从场景进入。产品围绕陪伴展开，不设置打卡、等级或喂养任务。

## 技术栈与架构

| 部分 | 技术 |
| --- | --- |
| iOS 客户端 | Swift、SwiftUI、WKWebView，最低 iOS 17 |
| macOS 电脑端宿主 | SwiftPM、SwiftUI MenuBarExtra，最低 macOS 14，Apple Silicon |
| 3D 世界与展示页 | TypeScript、Three.js、Vite |
| 服务端 | Node.js、TypeScript、Hono、AI SDK |
| 数据与后台执行 | PostgreSQL、Drizzle ORM、pg-boss |
| 实时消息 | SSE、Redis |
| 模型与资源 | DeepSeek / mock 模型、Blender 3D 资源 |

SwiftUI 承载原生页面，WKWebView 渲染小院，首页与聊天共享同一个世界。后端分为 API 和 worker 两个进程：API 处理聊天与最终回应，worker 执行后台托付、记忆提取和日记处理，再提交持久化汇报。API 发布前重新检查上下文、用户许可和安静时段。

PostgreSQL 保存业务状态、执行检查点与汇报，pg-boss 投递后台工作；Redis 用于聊天事件流和断线续传。Agent 的事项与执行分离设计参考了 [DeepSeek Super-agent](https://github.com/deepseek-ai/dsh-superagent-prototype)，实现按 Cattt 的陪伴场景组织。

## 快速开始

以下命令从仓库根目录执行，标有 `cd server` 的代码块除外。

### 环境要求

- Node.js 22.12+、pnpm 11。
- 构建 iOS：macOS、Xcode、Python 3。
- 运行后端：PostgreSQL、Redis；仓库提供 Docker Compose 配置。
- 修改 3D 源资源时需要 Blender，运行现有资源不需要。

安装依赖：

```bash
pnpm --dir web install --frozen-lockfile
pnpm --dir server install --frozen-lockfile
```

### 运行 iOS App

安装依赖后打开 Xcode 工程；每次构建会自动打包内嵌小院：

```bash
open ios/Maomao.xcodeproj
```

在 Xcode 中选择 `Maomao` scheme 和 iPhone 模拟器运行。真机运行需配置自己的签名团队。新机器若缺少 Metal 工具链，执行 `xcodebuild -downloadComponent MetalToolchain`。

App 默认使用本地模拟，可先体验小院和界面。需要真实后端时，按下一节启动服务，再在 App 调试面板中切换到本机后端并填入开发 token。

### 运行本机后端

电脑端应用的构建、菜单、备份恢复与烟测见 [macOS 宿主说明](desktop/macos/README.md)。应用随附 Node 22 与 PostgreSQL 17；当前服务端仍需独立 Redis，通过数据目录的 `env` 配置 `REDIS_URL`，不会将 Redis 打包进应用。

以下为不使用宿主的源码开发流程，保留的 `server/docker-compose.yml` 只用于开发数据库：

启动 Docker；macOS 使用 Colima 时先执行 `colima start`。首次配置：

```bash
cd server
cp .env.example .env
docker compose up -d --wait
pnpm db:migrate
MODEL_PROVIDER=mock pnpm create-dev-user dev
MODEL_PROVIDER=mock pnpm dev
```

已有 `.env` 时保留原文件。`create-dev-user` 会创建开发账号并输出一次 token，`pnpm dev` 同时启动 API 和 worker；API 默认地址为 `http://localhost:8787`。iOS 模拟器可直接连接此地址。

上面的命令使用固定回复的 mock 模型，无需模型密钥。连接真实模型时，在 `server/.env` 中设置：

```dotenv
MODEL_PROVIDER=deepseek
MAOMAO_DEEPSEEK_API_KEY=你的密钥
```

然后用 `pnpm dev` 启动。模型、数据库、身份与推送配置见 [server/.env.example](server/.env.example)，更多后端说明见 [server/README.md](server/README.md)。

### 运行网页展示页

```bash
pnpm --dir web dev
```

打开 `http://localhost:5173` 查看小院，`/tuanzi.html` 为团子调试页。网页用于 3D 展示，不提供完整 App 的聊天和日记功能。

## 测试与构建

在 macOS 开发环境运行仓库检查：

```bash
sh tools/check_all.sh
```

包括仓库规范、跨端规则、iOS 逻辑测试、网页测试和前后端类型检查。后端集成测试另需一套已迁移的独立测试数据库与 Redis，配置 `DATABASE_URL`、`REDIS_URL` 后执行：

```bash
MODEL_PROVIDER=mock pnpm --dir server test --maxWorkers=1
```

常用的单项命令：

```bash
pnpm --dir web typecheck
pnpm --dir web test:app
pnpm --dir web build
pnpm --dir server typecheck
```

iOS 增删源文件后，在 `ios/` 目录运行 `python3 generate_project.py` 更新工程；小院网页由 Xcode 构建阶段自动打包。版本号、跳过网页构建与归档命令见 [iOS 构建说明](ios/README.md#release-与-testflight-归档准备)。

## 目录结构

```text
.
├── ios/          SwiftUI App 与 Xcode 工程生成脚本
├── web/          3D 小院、团子运行时与网页展示页
├── server/       API、后台执行、数据模型与数据库迁移
├── desktop/macos/ macOS 菜单栏宿主、应用打包与备份恢复
├── assets/       3D 模型、美术源文件与资源工具
├── docs/         产品文档、架构决策与开发约定
├── outputs/      资源交付与验收记录
├── tools/        仓库检查与验证脚本
└── .githooks/    提交前检查
```

## 文档与开发约定

- [文档索引](docs/README.md)：当前决策、实施记录和验收证据。
- [产品文档](docs/产品/)：产品需求、页面清单和猫的个性设计。
- [iOS 开发说明](ios/README.md)、[后端说明](server/README.md)、[macOS 宿主说明](desktop/macos/README.md)。
- [小院资源](assets/yard-3d/README.md)、[团子资源](assets/tuanzi-3d/README.md)：模型与资源的生成方式。
- [工作约定](docs/工作约定.md)、[AGENTS.md](AGENTS.md)：开发、资源验收和提交规则。

仓库是项目事实的唯一来源，历史交付与性能数据保留在对应文档中。开发使用独立 worktree，保持 main 干净；世界层以 3D 为准，旧 Swift 2D 层与逐帧素材已冻结。
