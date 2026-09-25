// Plain JavaScript on purpose: the doctor's first job is telling someone their
// Node is too old, and Node releases before 22.6 cannot run the TypeScript
// doctor at all — they stop at "bad option: --experimental-strip-types".
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const [major, minor] = process.versions.node.split(".").map(Number)
if (major < 22 || (major === 22 && minor < 6)) {
  console.log("PrivacyJanitor local setup check")
  console.error(`Node ${process.versions.node}: upgrade to Node 24 or newer, then run npm install again.`)
  process.exit(1)
}
const doctor = fileURLToPath(new URL("./doctor.mts", import.meta.url))
const { status } = spawnSync(process.execPath, ["--experimental-strip-types", doctor], { stdio: "inherit" })
process.exitCode = status ?? 1
