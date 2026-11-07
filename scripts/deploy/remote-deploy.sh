#!/bin/bash
# 在服务器上执行的发布脚本（本地 deploy.sh 和 GitHub Actions 共用同一份）
#
# 用法：
#   remote-deploy.sh <branch>
#
# 为什么单独抽出来：本地发布和 CI 发布如果各写一套，迟早会漂移
# （比如忘了带 API_URL 构建参数，rewrites 就会指向错误的端口）。
set -euo pipefail

BRANCH="${1:?用法: remote-deploy.sh <branch>}"
APP_DIR=/srv/base
API_PORT=3100
CLIENT_PORT=3101

cd "$APP_DIR"

echo "==> 1/5 拉取 $BRANCH"
# 这台机器到 github.com 的连接偶发超时（表现为 90 秒后 "Empty reply from server"），
# 实测重试即可成功，所以带重试并放宽 HTTP 超时，避免一次抖动就让整次发布失败。
fetch_ok=0
for attempt in 1 2 3; do
  if git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 fetch -q origin "$BRANCH"; then
    fetch_ok=1
    break
  fi
  echo "  fetch 第 $attempt 次失败，5 秒后重试..."
  sleep 5
done
if [ "$fetch_ok" -ne 1 ]; then
  echo "  [错误] 连续 3 次拉取失败，放弃本次发布（未改动任何文件）" >&2
  exit 1
fi
git checkout -q -B "$BRANCH" "origin/$BRANCH"
git log --oneline -1

echo "==> 2/5 安装依赖"
pnpm install --frozen-lockfile

# API_URL 在 build 期烘进 Next 的 rewrites，漏了就会指向 localhost:3000
echo "==> 3/5 构建 client"
API_URL="http://127.0.0.1:$API_PORT" pnpm --filter client build

echo "==> 4/5 构建 admin"
pnpm --filter admin build
mkdir -p /var/www/base-admin
rsync -a --delete "$APP_DIR/apps/admin/dist/" /var/www/base-admin/

echo "==> 5/5 重载 pm2"
# 先 API 后 client：client 的 rewrite 目标要保持可用
pm2 restart base-api --update-env
sleep 10
pm2 restart base-client --update-env

# Next 重启后有数秒不监听，nginx 会回 502，必须等端口真正可用。
# curl 的报错在等待期间是正常的，用 -s 静音，stderr 也丢掉，只保留最终结论。
ready=0
for _ in $(seq 1 30); do
  if curl -fs -m 3 -o /dev/null "http://127.0.0.1:$CLIENT_PORT/login" 2>/dev/null; then
    ready=1
    echo "  client 已就绪"
    break
  fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  echo "  ❌ client 60 秒内未就绪，请查 /var/log/base/client-error.log" >&2
  exit 1
fi

echo "==> 健康检查"
curl -fsS -m 10 "http://127.0.0.1:$API_PORT/"
echo
curl -fsS -m 10 -o /dev/null -w "client: %{http_code}\n" "http://127.0.0.1:$CLIENT_PORT/login"
echo "==> 发布完成：$(git log --oneline -1)"
