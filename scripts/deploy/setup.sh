#!/bin/bash
# 首次初始化服务器（只跑一次）：装 runtimes、建库、放 nginx 配置、启动 pm2
#
# 本机前置：免密登录。
#   ssh-keygen -t ed25519 -f ~/.ssh/base_deploy_ed25519 -N ''
#   ssh-copy-id -i ~/.ssh/base_deploy_ed25519.pub root@175.178.198.182
#
# 用法（在本地仓库根目录执行）：
#   scripts/deploy/setup.sh
set -euo pipefail

cd "$(dirname "$0")"
source ./config.env

SSH="ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 $HOST"
SCP="scp -o StrictHostKeyChecking=no"

echo "==> 1/7 基础目录与运行时检查"
$SSH "mkdir -p /srv/base /var/log/base /var/www/base-admin
  command -v node >/dev/null || echo '  ⚠ 缺 node'
  command -v pnpm >/dev/null || echo '  ⚠ 缺 pnpm'
  command -v pm2  >/dev/null || echo '  ⚠ 缺 pm2'
  node -v; pnpm -v; pm2 -v | tail -1"

echo "==> 2/7 PostgreSQL 初始化（已初始化则跳过）"
$SSH 'set -e
if [ ! -s /var/lib/pgsql/16/data/PG_VERSION ]; then
  /usr/pgsql-16/bin/initdb -D /var/lib/pgsql/16/data --encoding=UTF8 --locale=C.UTF-8 >/dev/null
  echo "  initdb 完成"
else
  echo "  已初始化，跳过"
fi
systemctl enable --now postgresql-16 >/dev/null 2>&1
pg_isready -q && echo "  PostgreSQL ready"'

echo "==> 3/7 建库建用户（幂等）"
# 密码从本地 apps/api/.env 的 DATABASE_URL 取，保证两边一致
DB_PASS=$(grep -oE 'postgresql://postgres:[^@]*@' apps/api/.env 2>/dev/null | head -1 | sed -E 's#postgresql://postgres:##; s#@$##')
DB_PASS=${DB_PASS:-postgres}
$SSH "su - postgres -c \"psql -tAc \\\"SELECT 1 FROM pg_roles WHERE rolname='postgres'\\\"\" >/dev/null 2>&1 || true
  su - postgres -c \"psql -c \\\"ALTER USER postgres PASSWORD '$DB_PASS';\\\"\" >/dev/null
  su - postgres -c \"psql -tAc \\\"SELECT 1 FROM pg_database WHERE datname='app'\\\"\" | grep -q 1 || su - postgres -c 'createdb app'
  echo '  数据库 app 就绪'"

echo "==> 4/7 同步代码"
# 服务器访问不到 github.com，代码由本地 rsync 推送（与 deploy.sh 同一套规则）
rsync -az --delete \
  --exclude 'node_modules' --exclude '.next' --exclude 'dist' --exclude '.turbo' \
  --exclude '.git' --exclude '.usage' --exclude '.traces' --exclude 'workspace' \
  --exclude '.env' --exclude '.env.*' --exclude 'super-agent.config.json' \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
  "$(pwd)/" "$HOST:$APP_DIR/"

echo "==> 5/7 安装依赖并推送 schema"
# db:push 需要 TTY 确认变更，非交互环境必须加 --force
$SSH "cd $APP_DIR && pnpm install --frozen-lockfile && cd apps/api && ./node_modules/.bin/drizzle-kit push --force"

echo "==> 6/7 放置运行环境文件"
$SSH "cd $APP_DIR && test -f apps/api/.env || echo '  ⚠ apps/api/.env 不存在，需手动放置'"

# 原 80 端口站点（坚强莓）先备份再停用，回滚方式见 README
$SSH 'set -e
if [ -f /etc/nginx/conf.d/frontend.conf ]; then
  B=/root/backup-$(date +%Y%m%d-%H%M%S); mkdir -p $B
  cp -a /var/www/frontend $B/frontend 2>/dev/null || true
  mv /etc/nginx/conf.d/frontend.conf $B/
  echo "  旧站点已备份到 $B"
fi'

$SCP "$(dirname "$0")/nginx-base.conf" "$HOST:/etc/nginx/conf.d/base.conf"
$SSH "nginx -t && systemctl reload nginx"

echo "==> 7/7 构建前端并启动 pm2"
$SSH "cd $APP_DIR && API_URL=http://127.0.0.1:$API_PORT pnpm --filter client build"
$SSH "cd $APP_DIR && pnpm --filter admin build && mkdir -p /var/www/base-admin && rsync -a --delete apps/admin/dist/ /var/www/base-admin/"
$SSH "cd $APP_DIR && pm2 start scripts/deploy/ecosystem.config.cjs && pm2 save"
$SSH "pm2 startup systemd -u root --hp /root | tail -1 || true; systemctl enable pm2-root 2>/dev/null || true"

echo "==> 完成，检查：pm2 list && curl -I $PUBLIC_URL"
