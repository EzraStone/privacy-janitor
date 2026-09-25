/**
 * Dashboard behavior in a real browser: the built app on loopback, a synthetic
 * profile, no provider credentials. Needs Chromium — `npx playwright-core
 * install chromium`, or set PJ_UI_CHROMIUM to an existing Chrome binary.
 * Without one the suite skips locally, but fails in CI (or with PJ_REQUIRE_UI).
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Locator, type Page } from "playwright-core"

const require = createRequire(import.meta.url)
const directory = mkdtempSync(join(tmpdir(), "pj-ui-test-"))
process.env.PJ_DATA_DIR = directory

// ── synthetic profile: fictional names and addresses only ──────────────────
const store = await import("../src/store/index.ts")
const now = new Date().toISOString()
const later = new Date(Date.now() + 60_000).toISOString()
const person = "Jordan Example"
store.saveIdentity({ id: "id_ui", fullName: person, city: "Chicago", stateCode: "IL", ageRange: "40-45",
  relatives: ["Casey Example"], createdAt: now })
function listing(id: string, displayName: string, confirmedMine: boolean | null, extra: Record<string, unknown> = {}) {
  store.upsertListing({ id, brokerId: "spokeo", identityId: "id_ui", url: `https://www.spokeo.com/${id}`,
    displayName, exposedData: {}, confirmedMine, firstSeenAt: now, lastSeenAt: now, ...extra })
}
// Awaiting review: one per hint headline.
listing("hint-strong", person, null, { exposedData: { addresses: ["742 Evergreen Terrace, Chicago, IL"], age: "42", relatives: ["Casey Example"] } })
listing("hint-namesake", person, null, { exposedData: { addresses: ["31 Spooner St, Chicago, IL"] } })
listing("hint-contra", "Jordan A Example", null, { exposedData: { addresses: ["1640 Riverside Dr, Austin, TX"], age: "61" } })
listing("hint-sparse", person, null)
// Opt-out queue, one listing per request state.
mkdirSync(join(directory, "evidence", "run"), { recursive: true })
const preview = join(directory, "evidence", "run", "preview.png")
writeFileSync(preview, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"))
listing("q-prepared", "Queue prepared", true)
store.commitPreparedOptOut({ listingId: "q-prepared", brokerId: "spokeo", createdAt: now,
  state: { contactEmail: "jordan@example.com", previewPath: preview, summary: "synthetic", snapshot: "x", proxySessionId: "pin" } })
listing("q-waiting", "Queue waiting", true)
const waiting = store.createSubmission("q-waiting")
store.updateSubmission(waiting.id, { status: "awaiting_email", previewScreenshotPath: preview, submitSessionId: "sess_submit_W" })
listing("q-still", "Queue still listed", true, { exposedData: { addresses: ["1 Synthetic Way, Chicago, IL"] }, lastSeenAt: later })
const still = store.createSubmission("q-still")
store.updateSubmission(still.id, { status: "confirmed" })
listing("q-fresh", "Queue not started", true)
// A finished rescan: one of your listings, one namesake you already rejected.
listing("r-namesake", "Someone Else", false, { presenceStatus: "absent" })
const rescan = store.createScanRun("id_ui", "rescan")
rescan.results = [{ brokerId: "spokeo", ok: true, outcome: "found", listingsFound: 1 }]
rescan.events = [
  { listingId: "q-still", brokerId: "spokeo", type: "still_listed", recordedAt: now },
  { listingId: "r-namesake", brokerId: "spokeo", type: "no_longer_seen", recordedAt: now },
]
store.finishScanRun(rescan)
store.closeDb()

// ── browser first: skip locally without one, but never silently in CI ──────
let browser: Browser
try {
  browser = await chromium.launch({ executablePath: process.env.PJ_UI_CHROMIUM || undefined })
} catch (error) {
  rmSync(directory, { recursive: true, force: true })
  const hint = "Install one with `npx playwright-core install chromium`, or set PJ_UI_CHROMIUM."
  if (process.env.CI || process.env.PJ_REQUIRE_UI) {
    console.error(`UI checks need Chromium. ${hint}`)
    throw error
  }
  console.log(`UI checks skipped: no Chromium found. ${hint}`)
  process.exit(0)
}

const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", "0"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", PJ_DATA_DIR: directory, SOLARI_API_KEY: "", GROQ_API_KEY: "" },
})
const exited = once(child, "exit")
let base = ""
let exitedEarly = false
child.on("exit", () => { exitedEarly = true })
child.stdout.on("data", (data) => {
  const match = String(data).match(/http:\/\/127\.0\.0\.1:(\d+)/)
  if (match) base = match[0]
})
child.stderr.on("data", () => {})

// WCAG 2.1 A/AA through axe-core. Muted text once sat at 4.2:1 against the 4.5:1
// minimum; this keeps contrast and every other automated rule from regressing.
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8")
type AxeResult = { violations: Array<{ id: string; nodes: unknown[] }> }
async function wcagViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: axeSource })
  const result = await page.evaluate(() => (window as unknown as { axe: { run: (context: Document, options: object) => Promise<AxeResult> } })
    .axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }))
  return result.violations.map((violation) => `${violation.id} ×${violation.nodes.length}`)
}

const card = (page: Page, id: string): Locator => page.locator(".card", { has: page.locator(`a[href$="/${id}"]`) })
const row = (page: Page, name: string): Locator => page.locator(".card", { hasText: name })
const button = (scope: Locator, name: string) => scope.getByRole("button", { name, exact: true })

try {
  const deadline = Date.now() + 30_000
  let ready = false
  while (Date.now() < deadline && !exitedEarly) {
    if (base) {
      try { ready = (await fetch(`${base}/api/setup`, { signal: AbortSignal.timeout(1000) })).ok } catch {}
      if (ready) break
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.ok(ready, "Built test server must start; run npm run build first")

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(10_000)
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await page.goto(base)
  await page.getByText(`Is this ${person}?`).waitFor()

  // Each hint headline; name and city alone must never read as strong.
  const headline = async (id: string) => (await card(page, id).locator("div.border-l p").first().innerText()).trim()
  assert.equal(await headline("hint-strong"), "Name, location and a personal detail match your profile.")
  assert.match(await headline("hint-namesake"), /so would a namesake’s/)
  assert.match(await headline("hint-contra"), /may be someone else/)
  assert.match(await headline("hint-sparse"), /Too few details/)
  assert.match(await card(page, "hint-sparse").innerText(), /–\s*No address listed/, "unknown shows as –, not ✗")
  console.log("ok: review cards explain which details match")
  assert.deepEqual(await wcagViolations(page), [], "dashboard meets WCAG 2.1 AA")

  // Every decision can go back to review before a request is sent.
  await button(card(page, "hint-contra"), "Not me").click()
  const rejected = page.getByText("Marked not you (1)")
  await rejected.click()
  assert.deepEqual(await wcagViolations(page), [], "dashboard with rejected listings open meets WCAG 2.1 AA")
  await button(card(page, "hint-contra"), "Review again").click()
  await button(card(page, "hint-contra"), "This is me").waitFor()
  await button(card(page, "hint-namesake"), "This is me").click()
  // Queue rows carry no listing link; this is the queue's only "Jordan Example".
  const queued = page.locator("section", { hasText: "Opt-out queue" }).locator(".card", { hasText: person })
  await button(queued, "Not me after all").click()
  await button(card(page, "hint-namesake"), "This is me").waitFor()
  console.log("ok: listing decisions can be undone; WCAG 2.1 AA holds in both views")

  // Request states: captions, recorded sessions, and the ways out.
  assert.match(await row(page, "Queue prepared").innerText(), /approve before we submit/)
  const waitingRow = row(page, "Queue waiting")
  assert.doesNotMatch(await waitingRow.innerText(), /approve before we submit/, "only a pending preview asks for approval")
  assert.match(await waitingRow.innerText(), /Recorded Solari sessions — submit sess_submit_W/)
  await button(waitingRow, "Close attempt locally").click()
  await waitingRow.getByText("Cancelled").waitFor()
  const stillRow = row(page, "Queue still listed")
  await button(stillRow, "Request removal again").click()
  await stillRow.getByText("Still listed after this request").waitFor()
  await button(row(page, "Queue not started"), "Not me after all").waitFor()
  console.log("ok: request cards show their state, evidence and ways out")

  // The rescan diff names your listing and leaves out a rejected namesake.
  const verification = page.locator(".card", { hasText: "Latest verification" })
  assert.match(await verification.innerText(), /Queue still listed \(1 Synthetic Way, Chicago, IL\) — still listed/)
  assert.doesNotMatch(await verification.innerText(), /Someone Else/)
  console.log("ok: the rescan diff names each listing and skips not-you records")

  // With no key configured, setup advice asks for one.
  assert.match(await page.locator('section[aria-label="Setup checks"]').innerText(), /add your SOLARI_API_KEY/)
  assert.deepEqual(pageErrors, [], "no uncaught page errors")

  // Another origin cannot frame the dashboard to disguise a click.
  const attacker = await browser.newPage()
  await attacker.setContent(`<iframe src="${base}/" width="800" height="600"></iframe>`)
  await attacker.waitForTimeout(1500)
  const framed = attacker.frames().find((frame) => frame !== attacker.mainFrame())
  assert.ok(!(await framed?.locator("body").innerText().catch(() => ""))?.includes("PrivacyJanitor"), "dashboard refused to render in a frame")
  console.log("ok: setup advice, no page errors, and no framing by other sites")
  console.log("UI checks passed: match hints, undo, WCAG 2.1 AA, request states, rescan diff, setup advice, framing")
} finally {
  await browser.close()
  if (child.exitCode === null) child.kill()
  await exited.catch(() => {})
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
