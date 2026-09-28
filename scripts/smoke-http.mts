/** Test the built app over loopback. Never use the user's database or provider credentials. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
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
  assert.deepEqual(empty.matchHints, {}, "review hints are served, empty with no listings")
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
  // Every field is typed into broker search forms, one paid session per broker.
  assert.equal(await saveStatus({ fullName: "12345" }), 400, "a name needs letters")
  assert.equal(await saveStatus({ city: "x".repeat(101) }), 400, "overlong city rejected")
  assert.equal(await saveStatus({ relatives: Array.from({ length: 21 }, (_, n) => `Relative ${n}`) }), 400, "at most 20 relatives")
  // An age range the match hints cannot read would silently count as unknown.
  for (const ageRange of ["abc", "25 to 30", "30-25", "42", "10-20", "40-150"]) {
    assert.equal(await saveStatus({ ageRange }), 400, `age range "${ageRange}" rejected`)
  }
  const tidy = await post("/api/state", { action: "save-identity", identity: {
    fullName: "  Jordan Example ", city: " Chicago", stateCode: "il ", relatives: ["  ", " Casey Example "], ageRange: " 40 – 45 ",
  } })
  assert.equal(tidy.status, 200)
  const tidied = (await tidy.json()).identity
  assert.deepEqual([tidied.fullName, tidied.city, tidied.stateCode], ["Jordan Example", "Chicago", "IL"])
  assert.deepEqual(tidied.relatives, ["Casey Example"], "blank relatives dropped, names trimmed")
  assert.equal(tidied.ageRange, "40-45", "age range spacing and dashes normalized")
  // An edit keeps the stored creation time, whatever the form sends.
  const edited = await post("/api/state", { action: "save-identity", identity: {
    id: tidied.id, createdAt: "1999-01-01T00:00:00.000Z", fullName: "Jordan Example", city: "Evanston", stateCode: "IL",
  } })
  assert.equal(edited.status, 200)
  assert.equal((await edited.json()).identity.createdAt, tidied.createdAt, "createdAt is not client-controlled")
  assert.equal(await saveStatus({ id: 7 }), 400, "a profile id is a string")
  assert.equal((await post("/api/state", { action: "delete-identity", identityId: tidied.id })).status, 200)
  // A stale edit form, say in another tab, must not recreate a deleted profile.
  assert.equal(await saveStatus({ id: tidied.id }), 404, "saving a deleted profile does not resurrect it")
  const reopen = await fetch(`${base}/api/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reopen-removal" }) })
  assert.equal(reopen.status, 400, "reopen-removal requires the exact attempt")
  // Ids and text fields of any other type must be a 400, not reach SQLite as a 500.
  assert.equal((await post("/api/state", { action: "confirm-listing", listingId: { id: "lst_1" } })).status, 400, "object listing id")
  assert.equal((await post("/api/state", { action: "scan", identityId: ["id_1"] })).status, 400, "array profile id")
  assert.equal((await post("/api/actions", { action: "score", identityId: 7 })).status, 400, "numeric profile id")
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
  // Only screenshots are evidence: any other file there is never served.
  writeFileSync(join(evidence, "run-1", "notes.json"), '{"synthetic":true}')
  assert.equal(await evidenceStatus(join(evidence, "run-1", "notes.json")), 404, "non-screenshot files are not served")
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
  // No other site may frame the dashboard: a click inside it approves broker requests.
  // The page may talk only to this app: even injected script cannot send
  // profile data to another host, load a remote script, or post a form away.
  const policy = new Map((dashboard.headers.get("content-security-policy") ?? "").split(";")
    .map((directive) => directive.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources.join(" ")]))
  assert.equal(policy.get("frame-ancestors"), "'none'")
  assert.equal(policy.get("default-src"), "'self'")
  assert.equal(policy.get("connect-src"), "'self'")
  assert.equal(policy.get("img-src"), "'self' data: blob:")
  assert.equal(policy.get("object-src"), "'none'")
  assert.equal(policy.get("form-action"), "'self'")
  assert.equal(policy.get("base-uri"), "'self'")
  assert.doesNotMatch(policy.get("script-src") ?? "", /unsafe-eval|https?:/, "no eval or remote scripts in production")
  assert.equal(dashboard.headers.get("x-frame-options"), "DENY")
  const html = await dashboard.text()
  assert.match(html, /Setup checks/)
  assert.match(html, /Recheck setup/)
  // The database holds broker records about a real person: owner-only.
  if (process.platform !== "win32") {
    assert.equal(statSync(join(directory, "privacy-janitor.db")).mode & 0o077, 0, "a fresh database is owner-only")
  }
  // Expected failures carry their meaning: an unknown record is a 404 and a
  // state conflict a 409, never a 500 that reads as a crash. A sent request
  // is seeded straight into the test database; the server reads it next.
  process.env.PJ_DATA_DIR = directory
  const store = await import("../src/store/index.ts")
  const seededAt = new Date().toISOString()
  store.saveIdentity({ id: "id_sent", fullName: "Riley Sample", city: "Austin", stateCode: "TX", createdAt: seededAt })
  store.upsertListing({ id: "lst_sent", brokerId: "spokeo", identityId: "id_sent", url: "https://www.spokeo.com/Riley-Sample/p1",
    displayName: "Riley Sample", exposedData: {}, confirmedMine: true, firstSeenAt: seededAt, lastSeenAt: seededAt })
  const sent = store.createSubmission("lst_sent")
  store.updateSubmission(sent.id, { status: "submitted", submitSessionId: "sess_sent", previewScreenshotPath: join(evidence, "run-1", "shot.png") })
  store.closeDb()
  const actionStatus = async (body: Record<string, unknown>) => (await post("/api/actions", body)).status
  assert.equal(await actionStatus({ action: "cancel-optout", listingId: "lst_sent", submissionId: "sub_missing" }), 404, "unknown attempt")
  assert.equal(await actionStatus({ action: "reopen-removal", listingId: "lst_missing", submissionId: sent.id }), 404, "attempt of another listing")
  assert.equal((await post("/api/state", { action: "delete-identity", identityId: "id_missing" })).status, 404, "unknown profile")
  // A request in the wrong state for the action is a conflict, not a crash.
  assert.equal(await actionStatus({ action: "cancel-optout", listingId: "lst_sent", submissionId: sent.id }), 409, "a sent request cannot be cancelled")
  assert.equal(await actionStatus({ action: "reopen-removal", listingId: "lst_sent", submissionId: sent.id }), 409, "reopen waits for a rescan")
  // A profile's records download as one JSON file: what was found, decided
  // and requested, with brokers by name and no local file paths.
  const exported = await fetch(`${base}/api/export?identityId=id_sent`)
  assert.equal(exported.status, 200)
  assert.match(exported.headers.get("content-disposition") ?? "",
    /^attachment; filename="privacy-janitor-riley-sample-\d{4}-\d{2}-\d{2}\.json"$/)
  assert.equal(exported.headers.get("cache-control"), "no-store")
  const recordsText = await exported.text()
  const records = JSON.parse(recordsText)
  assert.equal(records.format, "privacy-janitor-records/1")
  assert.equal(records.profile.fullName, "Riley Sample")
  assert.deepEqual(records.listings.map((l: { broker: string; decision: string }) => [l.broker, l.decision]), [["Spokeo", "yours"]])
  assert.deepEqual(records.requests.map((r: { status: string; submitSessionId: string }) => [r.status, r.submitSessionId]), [["submitted", "sess_sent"]])
  assert.ok(!recordsText.includes(directory), "no local file paths in the export")
  assert.equal((await fetch(`${base}/api/export?identityId=id_missing`)).status, 404)
  assert.equal((await fetch(`${base}/api/export`)).status, 400)
  assert.equal((await fetch(`${base}/api/export?identityId=id_sent`, { headers: { origin: "https://unrelated.invalid" } })).status, 403)
  // "Reset all" promises to delete all evidence, including files whose
  // database reference was lost; reference-based cleanup never finds those.
  mkdirSync(join(evidence, "orphaned-run"))
  writeFileSync(join(evidence, "orphaned-run", "scan-result-state.png"), "synthetic orphan")
  assert.equal((await post("/api/state", { action: "reset-all" })).status, 200)
  assert.deepEqual(readdirSync(evidence), [], "reset leaves no evidence behind")
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "never served", "reset never follows a link outside the jail")
  console.log("Local HTTP checks passed: setup endpoint, origin protections, request shapes, status codes, evidence jail, profile validation, referrer and framing policy, record export, synthetic profile, preflight rejection, dashboard render, full reset")
} finally {
  if (child.exitCode === null && !spawnFailed) child.kill()
  await exited.catch(() => {})
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
