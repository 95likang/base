/**
 * pm2 配置（部署到 175.178.198.182:80）
 *
 * 为什么不用 Docker：
 * - apps/api/src/skills/index.ts 把 skills 目录写死在 <cwd>/src/.skills，且路由支持上传/删除，
 *   这是用户数据，放在镜像层里迟早会丢；
 * - `tsc` 产出的 dist 因为无扩展名导入跑不起来（ERR_MODULE_NOT_FOUND），镜像里也得走 tsx；
 * - Next 的 rewrites 在 build 期就把 API_URL 烘进 routes-manifest.json，容器里改环境变量不生效。
 *
 * 关键约束：
 * - 必须 fork + 单实例。cron 用进程内 setTimeout 调度、Discord/飞书是长连接、
 *   cronService 是进程级单例，多实例会重复执行定时任务、重复建连。
 * - cwd 必须是 apps/api：.env / super-agent.config.json / workspace / .traces 都按 cwd 解析。
 */
module.exports = {
  apps: [
    {
      name: 'base-api',
      cwd: '/srv/base/apps/api',
      // 直接用 node 执行，绕开 pm2 默认的 node 套 node；interpreter: 'none' 才能把
      // `--import tsx` 当成真正的 CLI 参数传给 node。
      script: 'node',
      args: '--import tsx src/index.ts',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '1200M',
      // MCP 预热、cron 恢复、Channel 连接都在监听后异步执行，给足启动余量
      listen_timeout: 30000,
      // SIGTERM 后触发 index.ts 里的 Langfuse flush，再强杀
      kill_timeout: 8000,
      env: {
        NODE_ENV: 'production',
        PORT: 3100,
        // 网关是自签证书，Node 必须在启动前拿到 CA（.env 里写无效）
        NODE_EXTRA_CA_CERTS: './wb-gateway.crt',
      },
      error_file: '/var/log/base/api-error.log',
      out_file: '/var/log/base/api-out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'base-client',
      cwd: '/srv/base/apps/client',
      script: 'node',
      // next 的可执行入口在 client 自己的 node_modules 里（pnpm workspace 不提升）
      args: 'node_modules/next/dist/bin/next start --port 3101 --hostname 127.0.0.1',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '800M',
      env: {
        NODE_ENV: 'production',
        // 服务端组件直连 API；rewrite 目标在 build 期已烘进 manifest，这里只影响 SSR 侧请求
        API_URL: 'http://127.0.0.1:3100',
      },
      error_file: '/var/log/base/client-error.log',
      out_file: '/var/log/base/client-out.log',
      merge_logs: true,
      time: true,
    },
  ],
}
