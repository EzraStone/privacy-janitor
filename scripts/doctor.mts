import { createRequire } from "node:module"
import { getSetupStatus } from "../src/config/setup.ts"

// Match Next's .env.local/.env.development/.env precedence, without printing keys.
const require = createRequire(import.meta.url)
const { loadEnvConfig } = require("@next/env")
loadEnvConfig(process.cwd(), true, { info() {}, error() {} })
const status = getSetupStatus()
console.log("PrivacyJanitor local setup check")
console.log(`Node ${status.node.version}: ${status.node.supported ? "supported" : "upgrade to Node 24 or newer"}`)
console.log(`Solari key: ${status.solari}`)
console.log(`Groq key: ${status.groq} (optional scoring)`)
console.log(status.storage.message)
console.log("Provider access and plan capabilities: not checked. No browser session was opened.")
console.log("After changing .env, restart the app. Do not share API keys or local evidence in bug reports.")
if (!status.canStartScan) {
  console.error("Setup needs attention. Add a real Solari key and resolve any Node/storage issue above.")
  process.exitCode = 1
} else {
  console.log("Local setup is ready for a first scan; provider authentication and broker compatibility are still unverified.")
}
