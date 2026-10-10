import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // The `api` workspace package ships raw TS, so Next must transpile it.
  transpilePackages: ['api'],
  // 把 /api/* 代理到 Hono 服务器，与 admin 的 Vite proxy 同构：
  // 浏览器侧同源请求，cookie 自动携带，无 CORS 问题。
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_URL ?? 'http://localhost:3000'}/api/:path*`,
      },
    ]
  },
}

export default nextConfig
