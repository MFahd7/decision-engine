import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The engine reads and writes the audit log at request time. Nothing here is
  // safe to prerender, and every route says so explicitly.
  experimental: {},
}

export default nextConfig
