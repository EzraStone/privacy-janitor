import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSetupStatus, keyStatus, probeStorage } from "../src/config/setup.ts"
import { launchResilient } from "../src/engine/solari.ts"
import type { Solari } from "@solarisdk/browser"

assert.equal(keyStatus(undefined), "missing")
assert.equal(keyStatus("   "), "missing")
for (const key of ["slr_live_" + "x".repeat(24), "gsk_" + "x".repeat(24), "YOUR_KEY_HERE", "<insert key>"]) assert.equal(keyStatus(key), "placeholder")
const secret = "synthetic-key-never-displayed"
const env = { SOLARI_API_KEY: secret, GROQ_API_KEY: secret }
const storageProbe = () => ({ writable: true, message: "synthetic writable folder" })
for (const version of ["22.8.0", "20.1.0", "unknown"]) assert.equal(getSetupStatus({ env, nodeVersion: version, storageProbe }).canStartScan, false)
for (const version of ["24.0.0", "26.0.0"]) assert.equal(getSetupStatus({ env, nodeVersion: version, storageProbe }).canStartScan, true)
assert.equal(getSetupStatus({ env: {}, nodeVersion: "24.0.0", storageProbe }).canStartScan, false)
assert.equal(getSetupStatus({ env: { SOLARI_API_KEY: secret }, nodeVersion: "24.0.0", storageProbe }).canStartScan, true, "Groq is optional")
assert.equal(getSetupStatus({ env, nodeVersion: "24.0.0", storageProbe: () => ({ writable: false, message: "synthetic permission denial" }) }).canStartScan, false)
assert.ok(!JSON.stringify(getSetupStatus({ env, storageProbe })).includes(secret), "no key values in API payloads")
const directory = mkdtempSync(join(tmpdir(), "pj-setup-test-"))
try {
  assert.equal(probeStorage(directory).writable, true)
  assert.deepEqual(readdirSync(directory), [], "probe leaves no files behind")
  const file = join(directory, "not-a-directory")
  writeFileSync(file, "synthetic")
  assert.equal(probeStorage(file).writable, false)
  assert.deepEqual(readdirSync(directory), ["not-a-directory"], "failed probe does not touch existing content")
} finally {
  rmSync(directory, { recursive: true, force: true })
}
let launches = 0
const denied = { async launch() { launches++; throw new Error("FeatureRequiresPlan: paid plan") } } as unknown as Solari
await assert.rejects(launchResilient(denied, "fixture"), /provider plan/)
assert.equal(launches, 1, "no silent paid-capability downgrade or second session")
// `npm run doctor` goes through a plain-JS launcher so old Node gets a clear
// answer; run it from an empty folder so no local .env can leak into the result.
const doctorHome = mkdtempSync(join(tmpdir(), "pj-doctor-"))
try {
  const doctor = spawnSync(process.execPath, [fileURLToPath(new URL("./run-doctor.mjs", import.meta.url))], {
    cwd: doctorHome, encoding: "utf8",
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", PJ_DATA_DIR: join(doctorHome, "data") },
  })
  assert.match(doctor.stdout, /PrivacyJanitor local setup check/)
  assert.match(doctor.stdout, /Solari key: missing/)
  assert.equal(doctor.status, 1, "a missing key needs attention")
} finally {
  rmSync(doctorHome, { recursive: true, force: true })
}
console.log("Setup checks passed: Node, key placeholders, optional scoring, local storage, safe output, provider-plan errors, doctor launcher")
