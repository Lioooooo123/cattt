# 给 AI 助手的入口（与 CLAUDE.md 内容相同）

这个仓库是猫猫 App 的**唯一真相源**。开始任何工作前按顺序读：

1. [README.md](README.md)：项目现状、怎么跑、仓库地图。
2. [docs/README.md](docs/README.md)：文档索引。先读最新的 `docs/决策/*.md`，已经定了的事不要重新提案。
3. [docs/工作约定.md](docs/工作约定.md)：出图、收图、验收、提交的规矩。

## 硬规矩

- 方案只在用户要求时写（`docs/方案/`）；平时直接改代码、跑验证，不必每次都先出 spec。
- 世界层以 3D 为准线（`web/` 的院子与 3D 团子、`assets/yard-3d/`、`assets/tuanzi-3d/`）；Swift 2D 世界层与逐帧素材已冻结，只修阻断性 bug，不加功能、不出新帧（[决策](docs/决策/2026-09-27-3D为准线.md)）。
- 只在用户要求时提交、推送；删除和其它不好撤回的动作先确认。
- 你的会话记忆、用户的个人笔记都不是真相源。有价值的结论写进仓库，登记到文档索引。
- 出图委托与收图验收按工作约定的六条和五道关；验收先跑哈希、先量数再看图。
- 工程文件用 `ios/generate_project.py` 生成；场景配置用原地修改的脚本，不要重跑 `configure_world_v4.py`。
- 界面文案和文档用中文；没有打卡、等级、任务、连续天数这类措辞。
- 改界面（页面、控件、配色令牌、圆角尺寸、图标、导航）前，先读 [.claude/skills/maomao-ui/SKILL.md](.claude/skills/maomao-ui/SKILL.md)（也是 `maomao-ui` 技能）：那里记的是历次返工的真实原因和动手前的检查表，不是规格。
- 加背景、加场景物件、加猫的动作帧或动图前，先读 [.claude/skills/maomao-assets/SKILL.md](.claude/skills/maomao-assets/SKILL.md)（也是 `maomao-assets` 技能）：出图前量什么、判据怎么写、收图先问加工能不能吸收、三条接入清单。**这条只管 2D 世界层，而它已冻结——新素材走 3D。**

## 常用命令

```bash
# 本机能跑的全部检查（仓库内容 + 跨端规则 + iOS 世界层 + 网页 + 后端类型检查）
sh tools/check_all.sh
# 模拟器构建
xcodebuild -project ios/Maomao.xcodeproj -scheme Maomao -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath /tmp/maomao-build build
# 后端集成测试（要本机 PG）
cd server && pnpm test
# 自有评测（Bun 宿主，离线套件；真实模型与对比见 host/eval/README.md）
(cd host && bun run eval run --suite all --mode scripted)
# 提交前检查（钩子会自动跑；每台机器先设一次 git config core.hooksPath .githooks）
python3 tools/repo_check.py
```

## 每轮收尾

新决定写进决策记录并登记；过时文档从当前版本删除；状态行改成真实状态；中间产物和录屏不进暂存区；仓库外的新"真相"收进来。详见 [工作约定](docs/工作约定.md#每轮收尾清单)。
