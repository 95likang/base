import { redirectToLogin } from './auth-redirect'

/** 服务端统一错误体：{ error: { code, message } } */
type ErrorBody = { error?: { message?: string } }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * 客户端请求统一入口：
 * - 401 直接跳登录页（middleware 只查 cookie 存在性，失效 session 只能靠业务请求兜底）
 * - 其余非 2xx 抛带服务端文案的 ApiError，调用方决定怎么展示
 *
 * 只用于浏览器端；路径一律写相对地址，走 next.config.ts 的同源 rewrite。
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)

  if (res.status === 401) {
    redirectToLogin(`${window.location.pathname}${window.location.search}`)
    throw new ApiError(401, '登录已过期，请重新登录。')
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ErrorBody | null
    throw new ApiError(res.status, body?.error?.message ?? `请求失败（${res.status}）`)
  }

  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}
