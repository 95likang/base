# 部署手册

本文档描述本项目的完整部署方式。**换一个新项目时，按这份文档从头做一遍即可。**

当前生产实例：`http://175.178.198.182`（腾讯云 OpenCloudOS 8.10）

---

## 一、整体架构

```
浏览器
  |
  v
nginx :80
  |- /          -> client :3101   (Next.js SSR)
  |- /api/      -> api    :3100   (Hono, SSE 流式)
  '- /admin/    -> /var/www/base-admin  (Vite 构建的静态文件)

进程管理：pm2（fork 模式，每个应用单实例）
数据库：  PostgreSQL 16（本机 5432）
```

### 三个关键约束

1. **不能开 pm2 cluster / 多实例**
   cron 用进程内 `setTimeout` 调度，Discord/飞书是长连接，`cronService` 是进程级单例。
   多实例会重复执行定时任务、重复建连。 所以 `exec_mode: 'fork'`, `instances: 1`

2. **`API_URL` 在 client 构建期烘进产物**
   `next build` 把 rewrite 目标写死进 `.next/routes-manifest.json`（实测为
   `http://127.0.0.1:3100/api/:path*`）。构建时漏传，线上就是错的。
   所以所有构建入口都必须带 `API_URL=http://127.0.0.1:3100`

3. **`tsc` 产出的 dist 跑不起来**
   源码用无扩展名导入（`import { auth } from './auth'`），`moduleResolution: Bundler`，
   Node ESM 要求 `.js` 后缀，直接 `node dist/index.js` 报 `ERR_MODULE_NOT_FOUND`。
   所以 API 用 `node --import tsx src/index.ts` 直接跑源码

### 为什么用 pm2 而不是 Docker

| 原因 | 具体位置 |
| --- | --- |
| skills 是可写用户数据，落在源码目录 | `apps/api/src/skills/index.ts` 写死 `<cwd>/src/.skills`，路由支持上传/删除 |
| `dist` 跑不起来，镜像里也得走 tsx | 见上面第 3 点，多阶段构建的优势大半用不上 |
| Next rewrites 在 build 期烘焙 | 容器里改环境变量不生效，只能重新 build 镜像 |

> 待办：如果后续对外开放注册，bash 工具的风险面会变大
> （`security/bash-classifier.ts` 明确写了"不是沙箱"），届时再迁容器做隔离。

---

## 二、服务器准备（新机器只做一次）

### 2.1 安装运行时

```bash
# Node 20+（本项目实测 v20.20.2）
node -v

# pnpm
npm i -g pnpm

# pm2
npm i -g pm2
```

### 2.2 安装 PostgreSQL 16

系统源里通常没有 PG，需要 PGDG 源。**官方源在国内很慢；腾讯云镜像会报 GPG 校验失败，
实测阿里云镜像可用：**

```bash
dnf -y install https://download.postgresql.org/pub/repos/yum/reporpms/EL-8-x86_64/pgdg-redhat-repo-latest.noarch.rpm

# 换成阿里云镜像
sed -i 's#https://download.postgresql.org/pub/repos/yum/#https://mirrors.aliyun.com/postgresql/repos/yum/#g' \
  /etc/yum.repos.d/pgdg-redhat-all.repo

# 关键：禁用系统自带的 postgresql module，否则包会被模块过滤挡掉
dnf -y module disable postgresql

dnf -y install postgresql16-server postgresql16
```

初始化（**必须以 postgres 用户执行，initdb 拒绝 root**）：

```bash
mkdir -p /var/lib/pgsql/16/data
chown -R postgres:postgres /var/lib/pgsql
su - postgres -c "/usr/pgsql-16/bin/initdb -D /var/lib/pgsql/16/data --encoding=UTF8 --locale=C.UTF-8"
systemctl enable --now postgresql-16
/usr/pgsql-16/bin/pg_isready
```

> 踩坑：initdb 之后如果 systemd 仍报 "data/ is missing or empty"，
> 先 `systemctl reset-failed postgresql-16` 再 start（服务在 initdb 完成前尝试过启动）。

### 2.3 建库

```bash
su - postgres -c "psql -c \"ALTER USER postgres PASSWORD '<你的密码>';\""
su - postgres -c 'createdb app'
```

### 2.4 目录与 nginx

```bash
mkdir -p /srv/base /var/log/base /var/www/base-admin
```

把 `scripts/deploy/nginx-base.conf` 放到 `/etc/nginx/conf.d/base.conf`，
改掉里面的 IP 和端口，然后：

```bash
nginx -t && systemctl reload nginx
```

---

## 三、仓库内的部署文件

新项目需要复制这 8 个文件，然后按自己的情况改：

| 文件 | 作用 | 需要改什么 |
| --- | --- | --- |
| `scripts/deploy/config.env` | 主机、路径、端口 | IP、分支名、端口 |
| `scripts/deploy/ecosystem.config.cjs` | pm2 进程定义 | 应用名、`cwd`、端口、**运行时 env** |
| `scripts/deploy/nginx-base.conf` | nginx 站点 | IP、upstream 端口、静态目录 |
| `scripts/deploy/setup.sh` | 首次初始化 | 数据库名、PG 版本路径 |
| `scripts/deploy/deploy.sh` | 本地一键发布 | 一般不用改 |
| `scripts/deploy/remote-deploy.sh` | 服务器侧发布（本地和 CI 共用） | 分支名、端口、应用名 |
| `scripts/deploy/run-as-deployer.sh` | CI 账户的强制命令 | 分支名（**须与 remote-deploy 一致**）；**安装到 git 工作树外**，见 §6.4 |
| `.github/workflows/deploy.yml` | CI/CD | 分支名 |

> **端口和应用名有两份真相，必须手工同步**：`remote-deploy.sh` 跑在服务器上，
> 读不到 `config.env`，所以它的 `API_PORT` / `CLIENT_PORT` / `APP_DIR` 是硬编码的。
> 应用名 `base-api` / `base-client` 同样硬编码在 `ecosystem.config.cjs` 和
> `remote-deploy.sh` 里。改端口或改名时，三处一起改。

### 3.1 `config.env`

注意 `SSH_KEY` 只有 `deploy.sh` 和 `setup.sh` 用；`remote-deploy.sh` 跑在服务器上不读它。

```bash
HOST=root@<服务器IP>
APP_DIR=/srv/base
SSH_KEY=~/.ssh/base_deploy_ed25519
BRANCH=<发布分支>
API_PORT=3100
CLIENT_PORT=3101
PUBLIC_URL=http://<服务器IP>
```

### 3.2 `ecosystem.config.cjs` 要点

```js
{
  name: 'base-api',
  cwd: '/srv/base/apps/api',      // 必须是 apps/api：.env/workspace/.traces 按 cwd 解析
  script: 'node',
  args: '--import tsx src/index.ts',
  interpreter: 'none',            // 关键：否则 pm2 会 node 套 node
  exec_mode: 'fork',
  instances: 1,                   // 关键：见架构约束 1
  env: {
    NODE_ENV: 'production',
    PORT: 3100,
    // 用到自签证书的网关时必须有：Node 只在启动时读该变量，写在 .env 里无效
    NODE_EXTRA_CA_CERTS: './wb-gateway.crt',
  },
  error_file: '/var/log/base/api-error.log',
}
```

client 那项有两处容易漏：

1. next 的可执行入口在 **client 自己的** `node_modules` 里
   （pnpm workspace 不提升），路径是 `node_modules/next/dist/bin/next`
2. **运行时也要注入 `API_URL`**：

```js
env: { NODE_ENV: 'production', API_URL: 'http://127.0.0.1:3100' },
```

原因：`apps/client/src/lib/api.ts` 在**运行时**读 `process.env.API_URL`
（默认回落 `http://localhost:3000`），供 Server Component 直连 API。
构建期的 `API_URL` 管的是浏览器侧 rewrite，两者不是同一件事，都要配。

### 3.3 `nginx-base.conf` 要点

```nginx
# SSE 流式响应：必须关掉一切缓冲与压缩
location ^~ /api/ {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    proxy_read_timeout 3600s;
}

# 主应用：X-Forwarded-Host 必须传，否则 Next 的重定向会指向内部端口
location / {
    proxy_pass http://base_client;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
}

# 静态 SPA（如 admin）：alias 必须以 / 结尾，index 由 try_files 兜底
location ^~ /admin/ {
    alias /var/www/base-admin/;
    try_files $uri $uri/ /admin/index.html;
}

# 图片以 base64 塞在 POST 请求体里，默认 1m 会被拦掉
client_max_body_size 60m;
```

### 3.3.1 `server_name` 必须匹配实际访问地址

服务器上通常已经有一个 nginx 自带的默认站点：

```nginx
listen 80 default_server;
server_name _;
root /usr/share/nginx/html;
```

本项目的配置是 `listen 80;` + `server_name <IP>;`，**Host 对不上就落到那个默认站点**，
表现为整站 404（实测 `curl -H 'Host: example.com' /login` → 404）。
所以：

- 用 IP 访问 → `server_name <IP>`
- 用域名访问 → `server_name 你的域名`，或直接 `server_name _` 并在前面加 `default_server`

另外，**配置要在仓库里改**：`setup.sh` 会用 `scp` 把
`scripts/deploy/nginx-base.conf` 覆盖到服务器，直接在服务器上改会被冲掉。

---

## 四、首次部署流程

### 步骤 1：配置本地免密登录

```bash
ssh-keygen -t ed25519 -f ~/.ssh/base_deploy_ed25519 -N ''
ssh-copy-id -i ~/.ssh/base_deploy_ed25519.pub root@<服务器IP>
ssh -i ~/.ssh/base_deploy_ed25519 root@<服务器IP> 'echo ok'
```

> 如果 `ssh-copy-id` 之后仍然 `Permission denied (publickey)`，
> 检查服务器 `/root/.ssh/authorized_keys` 是不是被写成了两行
> （key 和注释分开）。用 `wc -l` 确认，必须是每个 key 一行。

### 步骤 2：第一次执行初始化脚本（会停在放 .env 那步）

```bash
scripts/deploy/setup.sh
```

它做 7 件事：建目录 → 初始化 PG → 建库 → **clone 代码** → 装依赖 →
**检查 `.env`** → 推 schema → 放 nginx 配置 → 构建 + 启动 pm2 + 开机自启。

**顺序有讲究**：`.env` 必须在 `db:push` 之前就位（`drizzle.config.ts` 靠
`process.loadEnvFile()` 取 `DATABASE_URL`），而 `/srv/base` 又是 clone 出来的，
所以第一次跑注定停在检查 `.env` 那一步并给出提示——这是设计如此，不是 bug。

### 步骤 3：放好 `.env` 后重跑

在服务器上创建 `/srv/base/apps/api/.env`（**不从本地同步，生产配置只存在服务器上**）：

```bash
PORT=3100
DATABASE_URL="postgresql://postgres:<密码>@localhost:5432/app"
BETTER_AUTH_URL="http://<服务器IP>"
BETTER_AUTH_SECRET="<openssl rand -base64 32>"
CORS_ORIGINS="http://<服务器IP>"
WEB_URL="http://<服务器IP>"
TOOL_WORKSPACE_GUARD="true"    # 公网环境必须开启

# 必填：缺了 API 直接启动失败（rag/service.ts 顶层就创建 embedder）
DASHSCOPE_API_KEY="sk-xxx"

# 公网部署必填：不配则任何登录用户都能切换全局角色（owner/collaborator/guest）
ADMIN_EMAILS="you@example.com"

# 其余按需：ANTHROPIC_*、FEISHU_*、DISCORD_* 等
```

再执行一次同一个脚本，已完成的步骤都是幂等的，会从断点继续：

```bash
scripts/deploy/setup.sh
```

> 注意：`drizzle-kit push` 在非 TTY 环境下会卡在交互确认，
> 脚本里用的是 `drizzle-kit push --force`。
>
> `setup.sh` 建库用的密码取自**本地** `apps/api/.env` 的 `DATABASE_URL`，
> 与服务器上那份不一致会导致 API 连不上库。新项目没有本地 `.env` 时会回落到
> `postgres`，此时务必保证服务器 `.env` 里也是同一个密码。

### 步骤 4：验证

```bash
curl -I http://<服务器IP>
pm2 list
```

---

## 五、日常发布

### 方式 A：自动（推荐）

```bash
git add -A && git commit -m "..." && git push origin <发布分支>
```

推送后自动执行：

```
push
 |
 +-> check 任务（约 1-2 分钟）
 |     装依赖 -> lint -> 单测 -> client 构建 -> admin 构建
 |
 +-> deploy 任务（仅在 check 全绿时执行）
       SSH 到服务器 -> 拉代码 -> 装依赖 -> 构建 -> 重启 pm2 -> 健康检查
```

**只有配置里指定的发布分支会触发部署**，其他分支只跑检查。

### 方式 B：手动

```bash
scripts/deploy/deploy.sh              # 部署当前分支
scripts/deploy/deploy.sh main         # 部署指定分支
```

脚本会先拦下有未提交改动的情况（服务器只拉 git 内容，本地改动不会被部署）。

---

## 六、CI/CD 配置（GitHub Actions）

### 6.1 关键限制

**`workflow_run` 类型的 workflow 必须存在于默认分支才会触发。**

本项目的默认分支是 `main`，开发在 `feature/practice-coach`，所以最初把 CI 和 CD
拆成两个文件时，Deploy 永远不会跑。解决方式：**合并成一个 `deploy.yml`**，
只需要这一份在默认分支上。

### 6.2 结构

```yaml
on:
  push:
    branches: [main, 'feature/**']
  pull_request:

jobs:
  check:      # 所有分支都跑
    ...
  deploy:     # 只有发布分支的 push 才跑
    needs: check
    if: github.event_name == 'push' && github.ref == 'refs/heads/<发布分支>'
    ...
```

> 踩坑：job 级别的 `if` **不能引用 workflow 级 `env`**（env 上下文在 if 中不可用）。
> 一旦引用，整个 workflow 校验失败，0 个 job，只显示 "This run likely failed
> because of a workflow file issue"。分支名必须直接写死。

### 6.3 必须配置的 Secrets

仓库 Settings -> Secrets and variables -> Actions：

| Secret | 值 |
| --- | --- |
| `DEPLOY_SSH_KEY` | 部署专用私钥**完整内容**（含 BEGIN/END 行） |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -t ed25519 <IP>` 的输出 |
| `DEPLOY_HOST` | `deployer@<IP>` |
| `DEPLOY_PUBLIC_URL` | `http://<IP>` |

> 添加时注意 GitHub 弹窗有两个框：**Name 只填大写变量名**（只允许字母数字下划线），
> **Secret 才粘私钥**。粘错位置会报 "can only contain alphanumeric characters"。

### 6.4 服务器侧的部署账户

不要用 root 给 CI。建一个受限账户：

```bash
useradd -m -s /bin/bash deployer
mkdir -p /home/deployer/.ssh && chmod 700 /home/deployer/.ssh

# 【关键】强制命令脚本放在 git 工作树之外。
# 放在 /srv/base 里会产生循环依赖：authorized_keys 指向它，而它又是仓库跟踪的文件，
# `git checkout -B` 会因"未跟踪文件会被覆盖 / 无法切换"而中止 —— 删了 CD 断，留着 checkout 断。
install -m 755 -D scripts/deploy/run-as-deployer.sh /usr/local/lib/base-deploy/run-as-deployer.sh

echo 'command="/usr/local/lib/base-deploy/run-as-deployer.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding <公钥>' \
  > /home/deployer/.ssh/authorized_keys
chmod 600 /home/deployer/.ssh/authorized_keys
chown -R deployer:deployer /home/deployer/.ssh
```

`run-as-deployer.sh`（两端卡口，仓库里有同名文件，安装到上面的路径）：

```bash
#!/bin/bash
set -euo pipefail
# 只接受固定的参数，杜绝命令注入
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ] && [ "${SSH_ORIGINAL_COMMAND}" != "deploy" ]; then
  echo "拒绝执行: ${SSH_ORIGINAL_COMMAND}" >&2
  exit 1
fi
exec sudo -n /srv/base/scripts/deploy/remote-deploy.sh <发布分支>
```

`/etc/sudoers.d/deployer`（权限收窄到一条）：

```
deployer ALL=(root) NOPASSWD: /srv/base/scripts/deploy/remote-deploy.sh
```

```bash
chmod 440 /etc/sudoers.d/deployer
visudo -c -f /etc/sudoers.d/deployer
```

---

## 七、运维

### 常用命令

```bash
pm2 list                    # 进程状态
pm2 logs base-api --lines 100
pm2 restart base-api
pm2 reload base-client      # 尝试优雅重载
pm2 save                    # 保存当前列表（重启后恢复）
pm2 startup systemd -u root --hp /root   # 开机自启
```

### 日志位置

| 文件 | 内容 |
| --- | --- |
| `/var/log/base/api-out.log` | API 标准输出 |
| `/var/log/base/api-error.log` | API 错误 |
| `/var/log/base/client-out.log` | Next 标准输出 |
| `/var/log/base/client-error.log` | Next 错误 |

### 数据目录（重装时别删）

| 路径 | 在 git 里？ | 内容 |
| --- | --- | --- |
| `apps/api/.env` | ❌ 否 | 生产环境变量 |
| `apps/api/workspace/` | ❌ 否 | 文件工具工作区 |
| `apps/api/.usage/` `apps/api/.traces/` | ❌ 否 | 用量与跟踪日志 |
| `apps/api/src/.skills/` | ⚠️ 部分 | 种子技能在仓库里；**用户上传的是未跟踪文件** |
| `apps/api/wb-gateway.crt` | ✅ 是 | 自签网关 CA（公开证书，可提交） |

> `git checkout -B` 不会删未跟踪文件，所以上传的技能是安全的；
> 但 `git clean -xdf` 会把它们连同 `run-as-deployer.sh` 一起删掉，别在 `/srv/base` 上跑。

### 回滚

**完整回滚（推荐）**：重新推一次旧提交，走一遍 CI——

```bash
git revert <坏提交>        # 或 git reset 后强推（不推荐）
git push
```

**只回滚 API（快速止血）**：

```bash
cd /srv/base
git checkout <上一个提交>
pm2 restart base-api       # API 跑的是源码（tsx），restart 即生效
```

> 注意这条路**只回滚后端**。client 服务的是构建产物 `.next/`，admin 服务的是
> `/var/www/base-admin/` 里的静态文件，`git checkout` 都不会重建它们，
> 所以前后端版本会不一致。要回滚前端必须重新构建。

---

## 八、踩坑记录（照做时容易翻车的地方）

| 现象 | 原因 | 正确做法 |
| --- | --- | --- |
| `node dist/index.js` 报 `ERR_MODULE_NOT_FOUND` | tsc 产物保留无扩展名导入 | 用 `node --import tsx src/index.ts` |
| pm2 启动后进程反复重启 | `interpreter` 默认会用 node 再套一层 | 设 `interpreter: 'none'` |
| `initdb` 报"不能使用 root 用户运行" | initdb 拒绝 root | `su - postgres -c "..."` |
| `dnf install postgresql16-server` 报"没有任何匹配" | 系统 postgresql module 过滤 | `dnf -y module disable postgresql` |
| PGDG 源下载极慢 / GPG 校验失败 | 官方源慢、腾讯镜像签名问题 | 换 `mirrors.aliyun.com` |
| `drizzle-kit push` 报 "Interactive prompts require a TTY" | 非交互环境 | 加 `--force` |
| 浏览器被跳到 `http://localhost:3101/login` | Next 用 `request.url` 拼绝对地址 | middleware 改从 `x-forwarded-host` 取 origin；nginx 传 `X-Forwarded-Host` |
| admin 页面白屏、资源 404 | Vite `base` 未设子路径，产物引用 `/assets/` | `vite.config.ts` 设 `base: '/admin/'` |
| 部署后操作报 502 数秒 | Next 重启后有几秒不监听 | 发布脚本轮询端口直到可用 |
| workflow 立即失败、0 个 job | job 级 `if` 引用了 `env` 上下文 | 分支名直接写死 |
| workflow 完全不触发 | workflow 不在默认分支 | 把 workflow 合并到默认分支 |
| `initdb: 错误: 不能使用root用户运行` | initdb 拒绝 root | `su - postgres -c "initdb ..."` |
| `pg_isready: 未找到命令` | 未被 alternatives 链接到 /usr/bin | 用 `/usr/pgsql-16/bin/pg_isready` |
| 访问任意路径都是 404（nginx 默认页） | Host 不匹配 `server_name`，落到 `default_server` | `server_name` 写实际访问地址，或用域名 |
| API 启动即崩、pm2 无限重启 | `DASHSCOPE_API_KEY` 缺失（rag 模块顶层抛错） | 配好该 key，它是必填项 |
| 部署脚本报 `Empty reply from server`（约 90s 后） | 到 github.com 的连接偶发阻塞 | `git fetch` 带重试（`remote-deploy.sh` 已内置） |
| `checkout` 报 `untracked working tree files would be overwritten` | 仓库新增了服务器上已存在的未跟踪文件 | 把该文件移出 git 工作树（部署脚本同理） |
| `git checkout` 报"可疑的仓库所有权" | 文件属主与运行 git 的用户不同 | `git config --global --add safe.directory <路径>` |
| `pnpm install` 后 tsx 不可用 | esbuild 的构建脚本被跳过 | 一般仍可用；不行就 `pnpm approve-builds` |
| SSE 对话要等全部生成完才显示 | 压缩/缓冲层攒满才 flush | `compress: false`、nginx `proxy_buffering off` 与 `gzip off` |

---

## 九、已知限制（本项目特有）

- **Discord 通道不可用**：服务器到 discord.com 不通，定时任务的 Discord 推送会静默失败。
  飞书长连接正常。
- **MCP github server 依赖 npx 联网**，首次连接较慢（30s 超时）。
- **admin 与 client 共享登录态**：同源部署，登录任意一个另一个也登录。
  如需隔离，要拆 Cookie 前缀或改用子域名。
- **部署无人工确认**：推到发布分支就会自动上线。
  如需审批，可在仓库创建 `production` environment 并指定审核人，
  再在 deploy job 上挂 `environment: production`。
- **仓库是公开的**：`.env` 在 `.gitignore` 里且历史中从未提交，
  但注意不要 `git add -f` 任何凭据文件。

---

## 十、新项目迁移清单

按顺序做：

- [ ] 复制 `scripts/deploy/` 整个目录（8 个文件，含 `run-as-deployer.sh`）
- [ ] 复制 `.github/workflows/deploy.yml`
- [ ] 改 `config.env`：IP、分支、端口
- [ ] 改 `ecosystem.config.cjs`：应用名、cwd、端口、**运行时 `API_URL` 和 `NODE_EXTRA_CA_CERTS`**
- [ ] 改 `nginx-base.conf`：IP、`server_name`（必须匹配访问地址）、端口、静态目录
- [ ] 改 `remote-deploy.sh` 和 `run-as-deployer.sh` 里的分支名与端口（与 `config.env` 手工同步）
- [ ] 服务器装 Node / pnpm / pm2 / PostgreSQL
- [ ] 建 `deployer` 账户 + authorized_keys（指向 `run-as-deployer.sh`）+ sudoers
- [ ] 本地生成部署密钥并 ssh-copy-id
- [ ] 第一次跑 `scripts/deploy/setup.sh`（会停在放 `.env` 那步）
- [ ] 服务器放 `apps/api/.env`（含必填的 `DASHSCOPE_API_KEY` 与 `ADMIN_EMAILS`）
- [ ] 再跑一次 `scripts/deploy/setup.sh` 完成剩余步骤
- [ ] GitHub 配 4 个 Secrets
- [ ] push 一次验证自动部署
