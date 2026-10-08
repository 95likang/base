import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // The `api` workspace package ships raw TS, so Next must transpile it.
  transpilePackages: ['api'],
}

export default nextConfig
