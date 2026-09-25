import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // The Solari SDK manages long-lived connections (loopback proxy, CDP
  // sessions) that must not be bundled — keep it a runtime external.
  serverExternalPackages: ["@solarisdk/browser"],
  outputFileTracingExcludes: {
    "/*": ["./data/**/*", "./.env*", "./docs/assets/**/*"],
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        // Opening a broker listing must not tell the broker the visit came from
        // a local removal dashboard, so no navigation carries a Referer header.
        { key: "Referrer-Policy", value: "no-referrer" },
        // No other site may frame the dashboard: a disguised click inside it
        // could approve a broker request. Same-origin API checks cannot help,
        // since a framed dashboard's own requests are same-origin.
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }]
  },
}

export default nextConfig
