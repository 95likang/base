/**
 * 客户端接口返回 401 时回登录页。
 * middleware 只校验 cookie 是否存在，失效 session 需要业务请求自己兜底。
 */
export function redirectToLogin(redirect: string): void {
  window.location.assign(`/login?redirect=${encodeURIComponent(redirect)}`)
}
