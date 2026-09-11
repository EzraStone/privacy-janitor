import { spawn } from "node:child_process"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error("PrivacyJanitor requires Node.js 24 or newer. Update Node, then run npm install again.")
  process.exit(1)
}
const [command, ...args] = process.argv.slice(2)
if (!["dev", "build", "start"].includes(command)) {
  console.error("Usage: node scripts/run-next.mjs <dev|build|start>")
  process.exit(2)
}
// Set this before Next starts, including production builds; do not rely on a
// user's .env or machine-wide telemetry preference.
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), command, ...args], {
  stdio: "inherit",
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
})
child.on("error", () => { console.error("Could not start Next.js."); process.exitCode = 1 })
child.on("exit", (code) => { process.exitCode = code ?? 1 })
