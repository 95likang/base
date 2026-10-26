import { existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { CONFIG_FILE } from './constants'

try {
  process.loadEnvFile?.()
} catch {
  // .env 可选：不存在时用系统环境变量
}

/** 生成 ${ENV_VAR} 占位符，由 loader 在读取配置时替换 */
const env = (name: string): string => `\${${name}}`

/**
 * 初始化向导：生成 apps/api/super-agent.config.json。
 * 完整写出所有可调项，敏感信息统一用 ${ENV_VAR} 占位（密钥仍放在 .env）。
 */
export async function runInit(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      console.log(question)
      rl.question('  > ', resolve)
    })

  console.log('\n  Super Agent 初始化向导\n')

  if (existsSync(CONFIG_FILE)) {
    const overwrite = await ask(`  ${CONFIG_FILE} 已存在，覆盖? (y/N): `)
    if (overwrite.trim().toLowerCase() !== 'y') {
      console.log('  已取消\n')
      rl.close()
      return
    }
  }

  const modelDefault = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5'
  const modelName = (await ask(`\n  模型名 [${modelDefault}]: `)).trim()

  const enableFeishu = (await ask('\n  启用飞书 Channel? (y/N): ')).trim().toLowerCase() === 'y'

  let maxConcurrent = 3
  while (true) {
    const input = (await ask('\n  子 Agent 最大并发数 [3]: ')).trim()
    if (!input) break
    const parsed = Number.parseInt(input, 10)
    if (parsed >= 1 && parsed <= 10) {
      maxConcurrent = parsed
      break
    }
    console.log('  请输入 1-10 之间的整数')
  }

  const enableSupabase =
    (await ask('\n  启用 supabase 示例插件? (y/N): ')).trim().toLowerCase() === 'y'

  const enableCron = (await ask('\n  启用 Cron 定时任务? (y/N): ')).trim().toLowerCase() !== 'n'

  const enableLangfuse = (await ask('\n  启用 Langfuse 追踪? (y/N): ')).trim().toLowerCase() === 'y'

  const fileConfig = {
    server: {
      port: 3000,
      corsOrigins: ['http://localhost:5173', 'http://localhost:3001'],
    },
    database: {
      url: env('DATABASE_URL'),
    },
    auth: {
      secret: env('BETTER_AUTH_SECRET'),
      baseURL: env('BETTER_AUTH_URL'),
    },
    model: {
      name: modelName,
      baseURL: env('ANTHROPIC_BASE_URL'),
      apiKey: env('ANTHROPIC_API_KEY'),
    },
    tools: {
      guard: true,
    },
    rag: {
      apiKey: env('DASHSCOPE_API_KEY'),
    },
    plugins: [{ name: 'supabase', enabled: enableSupabase }],
    channels: {
      feishu: enableFeishu
        ? {
            enabled: true,
            appId: env('FEISHU_APP_ID'),
            appSecret: env('FEISHU_APP_SECRET'),
          }
        : { enabled: false },
    },
    agents: { maxConcurrent },
    security: { adminEmails: [] },
    cron: { enabled: enableCron },
    usage: { trackingFile: '.usage/usage.jsonl' },
    observability: enableLangfuse
      ? {
          enabled: true,
          // baseUrl 非密钥：写默认区域地址，避免把可选配置变成对环境变量的硬依赖
          baseUrl: 'https://jp.cloud.langfuse.com',
          publicKey: env('LANGFUSE_PUBLIC_KEY'),
          secretKey: env('LANGFUSE_SECRET_KEY'),
        }
      : { enabled: false },
  }

  writeFileSync(CONFIG_FILE, `${JSON.stringify(fileConfig, null, 2)}\n`)
  console.log(`\n  ✓ ${CONFIG_FILE} 已生成`)
  console.log('  密钥请放在 .env（参考 .env.example）\n')
  rl.close()
}

runInit().catch((err) => {
  console.error(`  ✗ 初始化失败: ${(err as Error).message}`)
  process.exit(1)
})
