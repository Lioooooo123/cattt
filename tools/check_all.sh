#!/bin/sh
# 本机能跑的全部检查，一把跑完。CI 用同一批命令（.github/workflows/checks.yml）。
# 用法（仓库根目录）：sh tools/check_all.sh
#
# 后端集成测试要本机 PG/Redis，不在这里跑：cd server && pnpm test
set -e
cd "$(dirname "$0")/.."

echo '· 仓库内容（大文件、日志、文档登记）'
python3 tools/repo_check.py --all

echo '· 跨端规则（行为表、氛围关键帧、地点、场景版本、生成物）'
python3 tools/check_shared_rules.py

echo '· iOS 世界层逻辑测试'
sh tools/check_world_logic.sh

echo '· iOS 日记存储与日期归档'
sh tools/check_diary_logic.sh
sh tools/check_sync_requests.sh

echo '· iOS 创建资料与进度恢复'
sh tools/check_creation_logic.sh

echo '· 网页：类型检查与测试'
pnpm --dir web typecheck
pnpm --dir web test:app

echo '· 后端：类型检查'
pnpm --dir server typecheck

echo '· 新宿主：安装、类型检查与存储测试'
(
  cd host
  bun install --frozen-lockfile
  bun run typecheck
  bun test
)

echo '全部通过。'

sh tools/check_identity_logic.sh
sh tools/check_followup_notifications.sh
