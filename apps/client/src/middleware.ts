import { getSessionCookie } from 'better-auth/cookies'
import { type NextRequest, NextResponse } from 'next/server'

/**
 * 全站强制登录：除 /login 外，没有 session cookie 一律跳登录页，并带上回跳地址。
 * Edge 无法查库，这里只判断 cookie 是否存在；cookie 失效时由服务端页面收到 401 后
 * 再跳登录页。因此 /login 不再反向踢回业务页——否则失效 cookie 会把用户困在错误页。
 */
/**
 * 反代后的真实对外地址。
 * Next 自己拼的 request.url 用的是进程监听地址（next start 下是 localhost:3101），
 * 直接用它会跳转到 http://localhost:3101/login——浏览器根本连不上。
 * 走 nginx 时以转发头为准，本地直连时回落到 nextUrl。
 */
function publicOrigin(request: NextRequest): string {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  if (!host) return request.nextUrl.origin
  const proto =
    request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '')
  return `${proto}://${host}`
}

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  if (pathname === '/login') {
    return NextResponse.next()
  }

  if (!getSessionCookie(request)) {
    const url = new URL('/login', publicOrigin(request))
    url.searchParams.set('redirect', `${pathname}${search}`)
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  // 静态资源与 API 代理不参与登录跳转（API 自己会返回 401）
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
