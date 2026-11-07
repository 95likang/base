#!/bin/bash
# deployer 账户的强制命令：SSH 连进来只能触发一次发布，不能开 shell。
#
# 部署位置（重要）：必须放在 **git 工作树之外**，例如
#   /usr/local/lib/base-deploy/run-as-deployer.sh
# 理由是循环依赖：authorized_keys 的 command= 指向它，而它如果放在 /srv/base 里，
# 又恰好是仓库跟踪的文件，`git checkout -B` 会因为"未跟踪文件会被覆盖"而中止，
# 于是这个文件既不能删（CD 就断了）也不能留（checkout 就断了）。
#
# 安装：
#   install -m 755 scripts/deploy/run-as-deployer.sh /usr/local/lib/base-deploy/
#   echo 'command="/usr/local/lib/base-deploy/run-as-deployer.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding <公钥>' \
#     > /home/deployer/.ssh/authorized_keys
#
# 安全边界：
# - 授权 key 带 command= 限制，无法执行任意命令
# - 分支写死在这里，不存在参数注入
# - 真正的发布以 root 执行，但 sudoers 把权限收窄到 remote-deploy.sh 一条
set -euo pipefail

# 只接受固定的触发词；空参数（直接 ssh 不跟命令）也放行，方便测试
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ] && [ "${SSH_ORIGINAL_COMMAND}" != "deploy" ]; then
  echo "拒绝执行: ${SSH_ORIGINAL_COMMAND}" >&2
  exit 1
fi

# 与 config.env 的 BRANCH 保持一致
exec sudo -n /srv/base/scripts/deploy/remote-deploy.sh feature/practice-coach
