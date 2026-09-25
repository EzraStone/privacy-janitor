import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // The Solari SDK manages long-lived connections (loopback proxy, CDP
  // sessions) that must not be bundled — keep it a runtime external.
  serverExternalPackages: ["@solarisdk/browser"],
  outputFileTracingExcludes: {
    "/*": ["./data/**/*", "./.env*", "./docs/assets/**/*"],
  },
  // Opening a broker listing must not tell the broker the visit came from a
  // local removal dashboard, so no navigation carries a Referer header.
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] }]
  },
}

export default nextConfig
