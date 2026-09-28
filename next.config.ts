import type { NextConfig } from "next"

// The dashboard talks only to this app. Even injected script cannot send
// profile data to another host (connect-src, img-src), load a remote script,
// or post a form elsewhere. Next's hydration scripts are inline; its
// development server also needs eval for hot reloading.
const development = process.env.NODE_ENV === "development"
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // No other site may frame the dashboard: a disguised click inside it could
  // approve a broker request. Same-origin API checks cannot help, since a
  // framed dashboard's own requests are same-origin.
  "frame-ancestors 'none'",
].join("; ")

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
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }]
  },
}

export default nextConfig
