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
- Better Auth 报 `Drizzle schema mismatch: Missing tables user, session, account, verification` → Better Auth 使用 Drizzle Adapter 时需要在 schema 中暴露其标准的认证表与关联 → 使用 `@better-auth/cli generate` 生成对应 Drizzle 表结构并合并到 `src/db/schema.ts`。

