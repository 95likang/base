#!/bin/bash
# 日常发布：本地 rsync 推代码 → 装依赖 → 构建 → 重载 pm2
#
# 用法（在本地仓库根目录执行）：
#   scripts/deploy/deploy.sh
#
# 为什么不用服务器 git pull：这台机器访问不到 github.com（实测超时），
# 私有仓库也没有服务器侧的凭据，所以统一由本地推送。
set -euo pipefail

cd "$(dirname "$0")/../.."
source scripts/deploy/config.env

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=15 $HOST"
RSYNC_SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

echo "==> 1/5 同步代码到 $APP_DIR"
# .env 不覆盖：生产配置只存在服务器上，本地没有
rsync -az --delete \
  --exclude 'node_modules' --exclude '.next' --exclude 'dist' --exclude '.turbo' \
  --exclude '.git' --exclude '.usage' --exclude '.traces' --exclude 'workspace' \
  --exclude '.env' --exclude '.env.*' --exclude 'super-agent.config.json' \
  -e "$RSYNC_SSH" ./ "$HOST:$APP_DIR/"

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
