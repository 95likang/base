import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'

/**
 * 业务错误：携带机器可读的 code、人类可读的 message 和 HTTP 状态码。
 * 在任意 handler 中 throw，由全局 onError 统一转换为响应，
 * 不需要在每个路由里手写 c.json({ error: ... }, status)。
 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: ContentfulStatusCode,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * 全局错误处理：所有错误统一为 { error: { code, message } } 形状，
 * HTTP 状态码承载成败语义，前端通过 body.error.code 做业务分支。
 */
export function onError(err: unknown, c: Context) {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status)
  }
  console.error('[api] unhandled error:', err)
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500)
}

type ValidationResult = { success: true } | { success: false; error: z.core.$ZodError }

/**
 * zValidator 的统一 hook，把校验失败（400）也收敛到同一错误形状。
 * 用法：zValidator('json', schema, validationHook)
 */
export function validationHook(result: ValidationResult, c: Context) {
  if (!result.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request data.',
          details: z.flattenError(result.error).fieldErrors,
        },
      },
      400,
    )
  }
}
