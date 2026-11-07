# 服务器部署（pm2）

生产环境：`http://175.178.198.182`（nginx 80）→ client:3101 → api:3100。

## 为什么是 pm2 不是 Docker

| 原因 | 具体位置 |
| --- | --- |
| skills 是可写用户数据，落在源码目录 | `apps/api/src/skills/index.ts` 把目录写死为 `<cwd>/src/.skills`，且路由支持上传/删除 |
| `tsc` 产物跑不起来（无扩展名导入） | `apps/api/dist/index.js` 报 `ERR_MODULE_NOT_FOUND`，容器里同样得走 tsx |
| Next rewrites 在 build 期烘焙 | `apps/client/.next/routes-manifest.json` 里是硬编码的目标地址 |

待办：如果后续对外开放注册（bash 工具的风险面变大），再迁到容器做隔离。

## 拓扑

```
浏览器
  └─ nginx:80 ─┬─ /            → client:3101 (Next SSR)
               ├─ /api/        → api:3100    (Hono，SSE 不缓冲)
               └─ /admin/      → /var/www/base-admin (Vite 静态产物)
```

**不要开 pm2 cluster / 多实例**：cron 用进程内 `setTimeout` 调度，Discord/飞书是长连接，
`cronService` 是进程级单例，多实例会重复执行定时任务、重复建连。

## 文件

| 文件 | 用途 |
| --- | --- |
| `setup.sh` | 首次初始化：数据库、依赖、nginx、pm2 |
| `deploy.sh` | 日常发布：git push → 服务器 pull → 构建 → 重载 |
| `ecosystem.config.cjs` | pm2 进程定义 |
| `nginx-base.conf` | 站点配置（80 端口） |
| `config.env` | 主机、路径、端口 |

## 首次部署

```bash
# 1. 免密登录
ssh-keygen -t ed25519 -f ~/.ssh/base_deploy_ed25519 -N ''
ssh-copy-id -i ~/.ssh/base_deploy_ed25519.pub root@175.178.198.182

# 2. 服务器前置（Node 20+ / pnpm / pm2 / PostgreSQL 16）
#    已验证的安装顺序：PGDG 源换阿里云镜像 + 禁用系统 postgresql 模块
#    dnf -y install postgresql16-server postgresql16
#    su - postgres -c "/usr/pgsql-16/bin/initdb -D /var/lib/pgsql/16/data --encoding=UTF8 --locale=C.UTF-8"
#    systemctl enable --now postgresql-16

# 3. 放置 apps/api/.env（参考 .env.example，注意以下生产项）
#    PORT=3100
#    BETTER_AUTH_URL / CORS_ORIGINS / WEB_URL = http://175.178.198.182
#    TOOL_WORKSPACE_GUARD="true"   ← 公网环境必须开启

# 4. 初始化
scripts/deploy/setup.sh
```

## 日常发布

```bash
scripts/deploy/deploy.sh              # 部署当前分支
scripts/deploy/deploy.sh main         # 部署指定分支
```

脚本会先拦下有未提交改动的情况（服务器只拉 git 内容），然后 push、
在服务器上 `git pull` → `pnpm install` → 构建 → `pm2 restart`。

服务器 `/srv/base` 是普通 git checkout，**生产 `.env`、`src/.skills`、
`workspace/` 都不在 git 里**，pull 不会碰它们。

## CI

`.github/workflows/ci.yml` 在每次 push / PR 跑：lint → API 单测 → 两个前端构建。
构建不需要密钥，测试不连数据库（`DATABASE_URL` 用占位值满足 import 期的 fail-fast）。

## 运维

```bash
pm2 list
pm2 logs base-api --lines 100
pm2 restart base-api
```

## 回滚

首次部署前已备份原站点：

```bash
ls /root/backup-*            # 含 frontend/ 与 frontend.conf
cp /root/backup-*/frontend.conf /etc/nginx/conf.d/
rsync -a /root/backup-*/frontend/ /var/www/frontend/
nginx -t && systemctl reload nginx
```

## 已知限制

- **Discord 通道不可用**：服务器到 discord.com 不通（`DISCORD_PROXY_URL` 留空），
  定时任务推送会静默失败，本地开发环境不受影响。
- **MCP github server 依赖 npx 联网**，首次连接较慢（30s 超时）。
- `API_URL` 在 client build 期写入 manifest，改端口必须重新 build。
