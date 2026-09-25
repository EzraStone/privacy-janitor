/** Test the built app over loopback. Never use the user's database or provider credentials. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
  // Valid JSON that is not an object must be a clean 400, not a crash.
  for (const route of ["/api/state", "/api/actions"]) {
    for (const body of ["null", "[]", "42", '"text"']) {
      const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body })
      assert.equal(response.status, 400, `${route} rejects a ${body} body`)
    }
  }
  const empty = await (await fetch(`${base}/api/state`)).json()
  assert.deepEqual(empty.identities, [])
  const saved = await post("/api/state", { action: "save-identity", identity: { fullName: "Jordan Example", city: "Chicago", stateCode: "IL" } })
  assert.equal(saved.status, 200)
  const { identity } = await saved.json()
  // Profile fields are validated after trimming: a lone space passes an HTML
  // "required" check, and a blank value later corrupts the scoring prompt.
  const saveStatus = async (fields: Record<string, unknown>) => (await post("/api/state", {
    action: "save-identity", identity: { fullName: "Jordan Example", city: "Chicago", stateCode: "IL", ...fields },
  })).status
  assert.equal(await saveStatus({ city: "   " }), 400, "whitespace-only city rejected")
  assert.equal(await saveStatus({ fullName: " " }), 400, "whitespace-only name rejected")
  assert.equal(await saveStatus({ stateCode: "Illinois" }), 400, "state must be a two-letter code")
  assert.equal(await saveStatus({ relatives: "Casey Example" }), 400, "relatives must be a list")
  assert.equal(await saveStatus({ relatives: ["Casey", 7] }), 400, "relatives must be names")
  const tidy = await post("/api/state", { action: "save-identity", identity: {
    fullName: "  Jordan Example ", city: " Chicago", stateCode: "il ", relatives: ["  ", " Casey Example "],
  } })
  assert.equal(tidy.status, 200)
  const tidied = (await tidy.json()).identity
  assert.deepEqual([tidied.fullName, tidied.city, tidied.stateCode], ["Jordan Example", "Chicago", "IL"])
  assert.deepEqual(tidied.relatives, ["Casey Example"], "blank relatives dropped, names trimmed")
  assert.equal((await post("/api/state", { action: "delete-identity", identityId: tidied.id })).status, 200)
  for (const action of ["confirm-listing", "reject-listing", "review-listing"]) {
    assert.equal((await post("/api/state", { action, listingId: "lst_missing" })).status, 404, `${action} reports unknown listings`)
  }
  const scan = await post("/api/state", { action: "scan", identityId: identity.id })
  assert.equal(scan.status, 503, "missing setup rejected before creating a scan")
  assert.match((await scan.json()).error, /SOLARI_API_KEY/)
  const pending = await (await fetch(`${base}/api/state`)).json()
  assert.equal(pending.identities.length, 1, "profiles usable before provider setup")
  assert.deepEqual(pending.scans, [], "failed preflight must not create phantom jobs")
  assert.equal((await post("/api/state", { action: "reset-all" }, { origin: "https://unrelated.invalid" })).status, 403)
  const evidence = join(directory, "evidence")
  const evidenceStatus = async (file: string) =>
    (await fetch(`${base}/api/evidence?file=${encodeURIComponent(file)}`)).status
  mkdirSync(join(evidence, "run-1"), { recursive: true })
  writeFileSync(join(evidence, "run-1", "shot.png"), "synthetic png")
  const shot = await fetch(`${base}/api/evidence?file=${encodeURIComponent(join(evidence, "run-1", "shot.png"))}`)
  assert.equal(shot.status, 200)
  assert.equal(shot.headers.get("content-type"), "image/png")
  assert.equal(await evidenceStatus(join(evidence, "run-1", "missing.png")), 404)
  assert.equal(await evidenceStatus("../privacy-janitor.db"), 403)
  // A symlink inside the evidence tree must not serve a file from outside it.
  const outside = join(directory, "outside")
  mkdirSync(outside)
  writeFileSync(join(outside, "secret.txt"), "never served")
  symlinkSync(outside, join(evidence, "linked-dir"), "junction")
  assert.equal(await evidenceStatus(join(evidence, "linked-dir", "secret.txt")), 403, "directory symlink escape")
  try {
    symlinkSync(join(outside, "secret.txt"), join(evidence, "linked.png"), "file")
    assert.equal(await evidenceStatus(join(evidence, "linked.png")), 403, "file symlink escape")
  } catch (error) {
    // Windows needs elevated rights for file symlinks; the directory case above still runs.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error
  }
  const dashboard = await fetch(base)
  // Opening a broker listing must not reveal that the visit came from here.
  assert.equal(dashboard.headers.get("referrer-policy"), "no-referrer")
  const html = await dashboard.text()
  assert.match(html, /Setup checks/)
  assert.match(html, /Recheck setup/)
  // "Reset all" promises to delete all evidence, including files whose
  // database reference was lost; reference-based cleanup never finds those.
  mkdirSync(join(evidence, "orphaned-run"))
  writeFileSync(join(evidence, "orphaned-run", "scan-result-state.png"), "synthetic orphan")
  assert.equal((await post("/api/state", { action: "reset-all" })).status, 200)
  assert.deepEqual(readdirSync(evidence), [], "reset leaves no evidence behind")
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "never served", "reset never follows a link outside the jail")
  console.log("Local HTTP checks passed: setup endpoint, origin protections, request shapes, evidence jail, profile validation, referrer policy, synthetic profile, preflight rejection, dashboard render, full reset")
} finally {
  if (child.exitCode === null && !spawnFailed) child.kill()
  await exited.catch(() => {})
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
