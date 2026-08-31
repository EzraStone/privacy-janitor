import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // The Solari SDK manages long-lived connections (loopback proxy, CDP
  // sessions) that must not be bundled — keep it a runtime external.
  serverExternalPackages: ["@solarisdk/browser"],
}

export default nextConfig
