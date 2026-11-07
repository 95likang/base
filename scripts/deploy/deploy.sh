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

echo "==> 0/5 推送 $TARGET_BRANCH 到远端"
git push origin "$TARGET_BRANCH"

echo "==> 1/5 拉取代码"
$SSH "cd $APP_DIR && git fetch origin $TARGET_BRANCH && git checkout -q -B $TARGET_BRANCH origin/$TARGET_BRANCH && git log --oneline -1"

echo "==> 2/5 安装依赖"
$SSH "cd $APP_DIR && pnpm install --frozen-lockfile"

echo "==> 3/5 构建 client（API_URL 在 build 期烘进 rewrites，必须指向内部端口）"
$SSH "cd $APP_DIR && API_URL=http://127.0.0.1:$API_PORT pnpm --filter client build"

echo "==> 4/5 构建 admin 并同步静态产物"
$SSH "cd $APP_DIR && pnpm --filter admin build && rsync -a --delete $APP_DIR/apps/admin/dist/ /var/www/base-admin/"

echo "==> 5/5 重载 pm2（先 API 后 client，避免 SSR 打到未就绪的 API）"
# 等待端口真正可用再算就绪：Next 重启后有几秒不监听，nginx 会回 502
$SSH "pm2 restart base-api --update-env && sleep 10 && pm2 restart base-client --update-env"
$SSH 'for i in $(seq 1 30); do
  curl -fsS -m 3 -o /dev/null http://127.0.0.1:3101/login && break
  sleep 2
done'

echo "==> 健康检查"
$SSH "curl -fsS -m 10 http://127.0.0.1:$API_PORT/ && echo && curl -fsS -m 10 -o /dev/null -w 'client: %{http_code}\n' http://127.0.0.1:$CLIENT_PORT/login"

echo "==> 完成：$PUBLIC_URL"
