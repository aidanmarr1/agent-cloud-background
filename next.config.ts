import type { NextConfig } from 'next'

const projectRoot = process.cwd()

const nextConfig: NextConfig = {
  outputFileTracingRoot: projectRoot,
  serverExternalPackages: ['@sparticuz/chromium', 'esbuild', 'playwright'],
  outputFileTracingIncludes: {
    '/api/internal/browser-health': ['./node_modules/@sparticuz/chromium/**/*'],
  },
  turbopack: {
    root: projectRoot,
  },
  webpack: (config, { dev }) => {
    if (dev) {
      config.cache = false
    }

    return config
  },
}

export default nextConfig
