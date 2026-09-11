/** Test the built app over loopback. Never use the user's database or provider credentials. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"

const require = createRequire(import.meta.url)
const directory = mkdtempSync(join(tmpdir(), "pj-http-test-"))
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", "0"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", PJ_DATA_DIR: directory, SOLARI_API_KEY: "", GROQ_API_KEY: "" },
})
const exited = once(child, "exit")
let base = ""
let exitedEarly = false
let spawnFailed = false
child.on("exit", () => { exitedEarly = true })
child.on("error", () => { spawnFailed = true })
child.stdout.on("data", (data) => {
  const match = String(data).match(/http:\/\/127\.0\.0\.1:(\d+)/)
  if (match) base = match[0]
})
// Drain output without logging credentials, environment files, or runtime data.
child.stderr.on("data", () => {})
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
}
try {
  const deadline = Date.now() + 30_000
  let ready = false
  while (Date.now() < deadline && !exitedEarly && !spawnFailed) {
    if (base) {
      try { ready = (await fetch(`${base}/api/setup`, { signal: AbortSignal.timeout(1000) })).ok } catch {}
      if (ready) break
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.ok(ready, "Built test server must start; run npm run build first")
  const setupResponse = await fetch(`${base}/api/setup`)
  assert.equal(setupResponse.headers.get("cache-control"), "no-store")
  const setup = await setupResponse.json()
  assert.equal(setup.solari, "missing")
  assert.equal(setup.groq, "missing")
  assert.equal(setup.canStartScan, false)
  assert.equal(setup.providerAccess, "not_checked")
  assert.equal((await fetch(`${base}/api/setup`, { headers: { origin: "https://unrelated.invalid" } })).status, 403)
  assert.equal((await fetch(`${base}/api/setup`, { headers: { "sec-fetch-site": "cross-site" } })).status, 403)
  const empty = await (await fetch(`${base}/api/state`)).json()
  assert.deepEqual(empty.identities, [])
  const saved = await post("/api/state", { action: "save-identity", identity: { fullName: "Jordan Example", city: "Chicago", stateCode: "IL" } })
  assert.equal(saved.status, 200)
  const { identity } = await saved.json()
  const scan = await post("/api/state", { action: "scan", identityId: identity.id })
  assert.equal(scan.status, 503, "missing setup rejected before creating a scan")
  assert.match((await scan.json()).error, /SOLARI_API_KEY/)
  const pending = await (await fetch(`${base}/api/state`)).json()
  assert.equal(pending.identities.length, 1, "profiles usable before provider setup")
  assert.deepEqual(pending.scans, [], "failed preflight must not create phantom jobs")
  assert.equal((await post("/api/state", { action: "reset-all" }, { origin: "https://unrelated.invalid" })).status, 403)
  const html = await (await fetch(base)).text()
  assert.match(html, /Setup checks/)
  assert.match(html, /Recheck setup/)
  console.log("Local HTTP checks passed: setup endpoint, origin protections, synthetic profile, preflight rejection, dashboard render")
} finally {
  if (child.exitCode === null && !spawnFailed) child.kill()
  await exited.catch(() => {})
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
