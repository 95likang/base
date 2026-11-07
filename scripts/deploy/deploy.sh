#!/bin/bash
# 日常发布：服务器 git pull → 装依赖 → 构建 → 重载 pm2
#
# 用法（在本地仓库根目录执行）：
#   scripts/deploy/deploy.sh              # 部署当前分支的最新提交
#   scripts/deploy/deploy.sh <branch>     # 部署指定分支
#
# 前置：本地改动必须先 commit 并 push，服务器只认 git 里的内容。
# 生产环境的 .env / skills 不在 git 里，不会被 pull 影响。
set -euo pipefail

cd "$(dirname "$0")/../.."
source scripts/deploy/config.env

TARGET_BRANCH="${1:-$(git branch --show-current)}"

# 未提交的改动不会被部署，提前拦住比部署完发现没生效好
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "❌ 有未提交的改动，请先 commit（服务器只拉 git 内容）："
  git status --short --untracked-files=no
  exit 1
fi

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=15 $HOST"

echo "==> 1/2 推送 $TARGET_BRANCH 到远端"
git push origin "$TARGET_BRANCH"

# 与 GitHub Actions 共用同一份服务器脚本，避免两边流程漂移
echo "==> 2/2 在服务器执行发布脚本"
$SSH "cat > /tmp/remote-deploy.sh" < scripts/deploy/remote-deploy.sh
$SSH "chmod +x /tmp/remote-deploy.sh && bash /tmp/remote-deploy.sh $TARGET_BRANCH"

echo "==> 完成：$PUBLIC_URL"
