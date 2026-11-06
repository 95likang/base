import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // The `api` workspace package ships raw TS, so Next must transpile it.
  transpilePackages: ['api'],
  // 关闭内置 gzip：/api 是 SSE 流式响应，压缩层会攒满缓冲区才 flush，
  // 导致对话要等模型全部生成完才一次性到达浏览器。
  compress: false,
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
