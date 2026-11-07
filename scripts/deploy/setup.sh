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

cd "$(dirname "$0")/../.."
source scripts/deploy/config.env

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=15 $HOST"
SCP="scp -i $SSH_KEY -o StrictHostKeyChecking=no"

echo "==> 1/7 基础目录与运行时检查"
$SSH "mkdir -p /srv/base /var/log/base /var/www/base-admin
  command -v node >/dev/null || echo '  ⚠ 缺 node'
  command -v pnpm >/dev/null || echo '  ⚠ 缺 pnpm'
  command -v pm2  >/dev/null || echo '  ⚠ 缺 pm2'
  node -v; pnpm -v; pm2 -v | tail -1"

echo "==> 2/7 PostgreSQL 初始化（已初始化则跳过）"
# initdb 拒绝以 root 运行，必须 su 到 postgres；
# pg_isready 没有被 alternatives 链接到 /usr/bin，必须用绝对路径（否则 127 让 set -e 中止）
$SSH 'set -e
PG_BIN=/usr/pgsql-16/bin
if [ ! -s /var/lib/pgsql/16/data/PG_VERSION ]; then
  mkdir -p /var/lib/pgsql/16/data
  chown -R postgres:postgres /var/lib/pgsql
  su - postgres -c "$PG_BIN/initdb -D /var/lib/pgsql/16/data --encoding=UTF8 --locale=C.UTF-8" >/dev/null
  echo "  initdb 完成"
else
  echo "  已初始化，跳过"
fi
systemctl enable postgresql-16 >/dev/null 2>&1 || true
systemctl reset-failed postgresql-16 >/dev/null 2>&1 || true
systemctl start postgresql-16
for _ in $(seq 1 15); do
  $PG_BIN/pg_isready -q && break
  sleep 1
done
$PG_BIN/pg_isready -q && echo "  PostgreSQL ready"'

echo "==> 3/7 建库建用户（幂等）"
# 密码从本地 apps/api/.env 的 DATABASE_URL 取，保证两边一致
DB_PASS=$(grep -oE 'postgresql://postgres:[^@]*@' apps/api/.env 2>/dev/null | head -1 | sed -E 's#postgresql://postgres:##; s#@$##')
DB_PASS=${DB_PASS:-postgres}
$SSH "su - postgres -c \"psql -tAc \\\"SELECT 1 FROM pg_roles WHERE rolname='postgres'\\\"\" >/dev/null 2>&1 || true
  su - postgres -c \"psql -c \\\"ALTER USER postgres PASSWORD '$DB_PASS';\\\"\" >/dev/null
  su - postgres -c \"psql -tAc \\\"SELECT 1 FROM pg_database WHERE datname='app'\\\"\" | grep -q 1 || su - postgres -c 'createdb app'
  echo '  数据库 app 就绪'"

echo "==> 4/7 拉取代码"
# 仓库是公开的，服务器可直接 clone；safe.directory 用来放行 root 以外的属主
$SSH "set -e
git config --global --add safe.directory $APP_DIR 2>/dev/null || true
if [ -d $APP_DIR/.git ]; then
  cd $APP_DIR && git fetch origin $BRANCH && git checkout -q -B $BRANCH origin/$BRANCH
else
  git clone -b $BRANCH https://github.com/95likang/base.git $APP_DIR
fi
cd $APP_DIR && git log --oneline -1"

echo "==> 5/7 安装依赖并检查环境变量"
$SSH "cd $APP_DIR && pnpm install --frozen-lockfile"

# .env 必须在 db:push 之前就位：drizzle.config.ts 靠 process.loadEnvFile() 取 DATABASE_URL。
# 顺序不能颠倒，否则 push 会以 "connection url required" 失败。
if ! $SSH "test -f $APP_DIR/apps/api/.env"; then
  cat >&2 <<EOF
❌ 服务器上还没有 $APP_DIR/apps/api/.env

代码已克隆到服务器，现在去把生产环境变量放上去（参考 .env.example）：

  PORT=3100
  DATABASE_URL="postgresql://postgres:<密码>@localhost:5432/app"
  BETTER_AUTH_URL / CORS_ORIGINS / WEB_URL = http://<你的地址>
  DASHSCOPE_API_KEY="sk-xxx"     # 必填，缺失时 API 启动即崩
  ADMIN_EMAILS="you@example.com" # 公网部署必配，否则任何登录用户都能切角色
  TOOL_WORKSPACE_GUARD="true"    # 公网环境必须开启

放好后重新执行本脚本，它会从断点继续（已完成的步骤都是幂等的）。
EOF
  exit 1
fi

echo "==> 6/7 推送 schema"
# db:push 需要 TTY 确认变更，非交互环境必须加 --force
$SSH "cd $APP_DIR/apps/api && ./node_modules/.bin/drizzle-kit push --force"

# 原 80 端口站点（坚强莓）先备份再停用，回滚方式见 README
$SSH 'set -e
if [ -f /etc/nginx/conf.d/frontend.conf ]; then
  B=/root/backup-$(date +%Y%m%d-%H%M%S); mkdir -p $B
  cp -a /var/www/frontend $B/frontend 2>/dev/null || true
  mv /etc/nginx/conf.d/frontend.conf $B/
  echo "  旧站点已备份到 $B"
fi'

$SCP "scripts/deploy/nginx-base.conf" "$HOST:/etc/nginx/conf.d/base.conf"
$SSH "nginx -t && systemctl reload nginx"

echo "==> 7/7 构建前端并启动 pm2"
# setup.sh 会覆盖服务器上的 nginx 配置，所以配置要在仓库里改，别直接改服务器上的文件
$SSH "cd $APP_DIR && API_URL=http://127.0.0.1:$API_PORT pnpm --filter client build"
$SSH "cd $APP_DIR && pnpm --filter admin build && mkdir -p /var/www/base-admin && rsync -a --delete apps/admin/dist/ /var/www/base-admin/"
$SSH "cd $APP_DIR && pm2 start scripts/deploy/ecosystem.config.cjs && pm2 save"
$SSH "pm2 startup systemd -u root --hp /root | tail -1 || true; systemctl enable pm2-root 2>/dev/null || true"

echo "==> 完成，检查：pm2 list && curl -I $PUBLIC_URL"
