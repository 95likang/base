# base

此项目是一个通用的前后端系统

## 约定

- 用最简单的方式实现，不要考虑本次需求之外的扩展性，能用现有依赖和工具函数就不要造轮子。
- 每次完成需求需要开一个subagent检查：这段实现里，哪些代码是可以删掉的？哪些抽象是本次需求用不到的？
- 完成需求后用code-review-expert这个skills 进行code review

## 错误题本

> 踩坑后追加一行：现象 → 原因 → 正确做法。给未来的 AI 和人看。

- `api:build` 报 `TS6059: File 'drizzle.config.ts' is not under 'rootDir' 'src'` → `drizzle.config.ts` 位于 `apps/api` 根目录而 tsconfig 指定了 `rootDir: "./src"` → `tsconfig.json` 的 `include` 只包含 `src/**/*.ts`，`drizzle.config.ts` 由 `drizzle-kit` 单独解析，无需纳入 app 编译。
- Hono RPC 客户端解析 `res.json()` 报 `Property does not exist on type 'ZodSafeParseError | ...'` → 使用 `@hono/zod-validator` 时，未校验 `res.ok` 会保留校验失败联合类型 → 解构数据前必须加 `if (!res.ok) { ... }` 状态收窄。
- Hono RPC 客户端调用带 Query 参数接口报 `Type 'number' is not assignable to type 'string | ...'` → HTTP Query 参数在传入网络层时均为字符串（由后端 `z.coerce.number()` 转换） → 客户端传参需使用字符串字面量（如 `{ limit: '10' }`）。
- API 启动报 `DATABASE_URL is not set` → ESM `import` 静态分析优先于顶层代码执行，且 Node 默认不自动加载 `.env` → 在 `src/db/index.ts` 校验环境变量前调用 `process.loadEnvFile?.()`，并确保创建 `apps/api/.env` 文件。
- Better Auth 报 `Drizzle schema mismatch: Missing tables user, session, account, verification` → Better Auth 使用 Drizzle Adapter 时需要在 schema 中暴露其标准的认证表与关联 → 使用 `@better-auth-cli generate` 生成对应 Drizzle 表结构并合并到 `src/db/schema.ts`。
- glob 工具能列出工作区外的文件 → fast-glob 对绝对路径模式会忽略 `cwd`（文档化行为），只校验 path 参数拦不住 pattern → glob 工具必须自行校验 pattern（`isAbsolute`、盘符前缀 `C:`、`..` 段），否则工作区守卫被绕过。
- LLM 触发的 bash 工具执行期间整个 API 无响应 → `execSync` 同步阻塞事件循环，命令跑多久所有请求就挂多久 → 用 `promisify(exec)` 异步执行，并透传 `abortSignal` 让客户端断开时能 kill 命令。
- Windows 上 tsx watch 重启后偶发遗留 MCP stdio 子进程（npx）→ Windows 无真实 POSIX 信号，强杀/重启时 `SIGINT`/`SIGTERM` 处理器不执行，`client.close()` 清理代码跑不到 → 依赖 MCP server 子进程监听 stdin 断开自动退出；仍遗留时用 `taskkill /F /PID <pid>` 手动清理（与 tsx 遗留进程同源，可用 `Get-Process node,npx` 排查）。
- 并发跑两个 `pnpm add` 后 `package.json` 丢失新装依赖 → 两个 pnpm 进程同时改写同一 `package.json` / `pnpm-lock.yaml`，后写入者覆盖 → 同一 workspace 的依赖安装必须串行，等上一个进程结束再执行下一个。
- 安装 `@langfuse/otel` 报 peer 冲突（`@opentelemetry/core` 3.0.0 vs `^2.0.1`、`api` 1.10.0 vs `<1.10.0`）→ 最新 `@opentelemetry/sdk-node@0.300` 依赖 core 3.x，与 Langfuse 6.0.2 的 peer 不兼容 → 固定 `@opentelemetry/sdk-node@0.211.0` 与 `@opentelemetry/api@1.9.1`。
- 纯图消息（无文字）模型称"收到截断的 base64 文本、无视觉能力" → Anthropic 协议网关按用户消息 text 意图路由视觉通道，无文字或泛化词（"图片"/`[图片]`）触发降级，图片被转成 ~850 tok 的截断文本（对照 trace usage：降级 4313 vs 视觉 3466 inputTokens）→ 后端给 image-only 消息补明确识图指令（`ensureTextPartForImageOnlyMessages`，chat.ts），仅内存不落库。

