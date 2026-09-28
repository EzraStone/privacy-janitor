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
import { DatabaseSync } from "node:sqlite"
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
// The scan that found hint-strong saved its search-results screenshot.
const searchRun = join(directory, "evidence", "scan-spokeo-run")
mkdirSync(searchRun, { recursive: true })
writeFileSync(join(searchRun, "scan-result-state.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"))
// Awaiting review: one per hint headline.
listing("hint-strong", person, null, { screenshotPath: searchRun,
  exposedData: { addresses: ["742 Evergreen Terrace, Chicago, IL"], age: "42", relatives: ["Casey Example"] } })
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
// Six earlier scans, so the history has more than it shows at first.
for (let n = 0; n < 6; n++) store.finishScanRun(store.createScanRun("id_ui", "scan"))
// A finished rescan: one of your listings, one namesake you already rejected.
listing("r-namesake", "Someone Else", false, { presenceStatus: "absent" })
const rescan = store.createScanRun("id_ui", "rescan")
rescan.results = [{ brokerId: "spokeo", ok: true, outcome: "found", listingsFound: 1, evidenceDir: searchRun }]
rescan.events = [
  { listingId: "q-still", brokerId: "spokeo", type: "still_listed", recordedAt: now },
  { listingId: "r-namesake", brokerId: "spokeo", type: "no_longer_seen", recordedAt: now },
  { listingId: "q-waiting", brokerId: "spokeo", type: "relisted", recordedAt: now },
]
store.finishScanRun(rescan)
store.closeDb()
// The waiting request started three days ago; the store stamps only "now".
const backdated = new Date(Date.now() - 3 * 86_400_000).toISOString()
const db = new DatabaseSync(join(directory, "privacy-janitor.db"))
db.prepare("UPDATE submissions SET created_at = ? WHERE id = ?").run(backdated, waiting.id)
db.close()

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
  // Groq keeps the .env.example placeholder: the state after copying it unedited.
  env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", PJ_DATA_DIR: directory, SOLARI_API_KEY: "", GROQ_API_KEY: "gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
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
const row = (page: Page, name: string): Locator =>
  page.locator("section", { hasText: "Opt-out queue" }).locator(".card", { hasText: name })
const button = (scope: Locator, name: string) => scope.getByRole("button", { name, exact: true })

let openPage: Page | undefined
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
  openPage = page
  page.setDefaultTimeout(10_000)
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  // The dashboard must run within its own Content-Security-Policy.
  page.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) pageErrors.push(message.text()) })
  await page.goto(base)
  await page.getByText(`Is this ${person}?`).waitFor()

  // Each hint headline; name and city alone must never read as strong.
  const headline = async (id: string) => (await card(page, id).locator("div.border-l p").first().innerText()).trim()
  assert.equal(await headline("hint-strong"), "Name, location and a personal detail match your profile.")
  assert.match(await headline("hint-namesake"), /so would a namesake’s/)
  assert.match(await headline("hint-contra"), /may be someone else/)
  assert.match(await headline("hint-sparse"), /Too few details/)
  assert.match(await card(page, "hint-strong").innerText(), /✓\s*Shares a relative’s name/)
  assert.match(await card(page, "hint-sparse").innerText(), /–\s*No address listed/, "unknown shows as –, not ✗")
  // Emoji mark each detail visually; assistive technology hears words instead.
  const strongCard = await card(page, "hint-strong").ariaSnapshot()
  assert.match(strongCard, /Address: 742 Evergreen Terrace/)
  assert.match(strongCard, /Age: 42/)
  assert.match(strongCard, /Relatives: Casey Example/)
  assert.doesNotMatch(strongCard, /📍|📞|👤|👥/)
  // A card links to the search results it came from, when that screenshot exists.
  const searchShot = card(page, "hint-strong").getByRole("link", { name: "Search results screenshot" })
  assert.equal(await searchShot.getAttribute("target"), "_blank")
  assert.equal((await page.request.get(new URL((await searchShot.getAttribute("href"))!, base).href)).headers()["content-type"], "image/png")
  assert.equal(await card(page, "hint-sparse").getByRole("link", { name: "Search results screenshot" }).count(), 0, "no link to missing evidence")
  console.log("ok: review cards explain which details match")
  // Keyboard focus shows as the same white ring on every control, not a
  // browser default drawn in the control's own colour.
  for (const control of [button(card(page, "hint-strong"), "This is me"), page.getByRole("button", { name: "Delete profile" })]) {
    await control.focus()
    await page.waitForTimeout(400) // buttons transition outline-color over 150ms
    const ring = await control.evaluate((el) => {
      const style = getComputedStyle(el)
      return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`
    })
    assert.equal(ring, "solid 2px rgb(255, 255, 255)")
  }
  // The selected profile is conveyed by state, not only by colour.
  await page.getByRole("button", { name: /^Jordan Example/, pressed: true }).waitFor()
  // The scan panel says what the latest scan found, next to the button that runs one.
  const scanPanel = page.locator("section", { hasText: "Run broker scan" })
  // It is a status region, so a scan finishing is announced, not only drawn.
  await scanPanel.getByRole("status").filter({ hasText: "Last rescan finished" }).waitFor()
  assert.match(await scanPanel.innerText(), new RegExp(`Last rescan finished [A-Z][a-z]{2} \\d{1,2}, \\d{4} — Spokeo: 1 listing`))
  // The queue opens with where things stand: what waits on you, on brokers, and what is gone.
  const queueSection = page.locator("section", { hasText: "Opt-out queue" })
  assert.match(await queueSection.innerText(), /4 listings: 3 need you · 1 with brokers · 0 no longer listed/)
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

  // A disabled button says why, in text anyone can see, not a hover tooltip.
  assert.ok(await page.getByRole("button", { name: "Run broker scan" }).isDisabled())
  await page.getByText("Scanning starts once setup is complete").waitFor()
  assert.ok(await button(row(page, "Queue not started"), "Prepare opt-out").isDisabled())
  assert.equal(await button(row(page, "Queue not started"), "Prepare opt-out").getAttribute("title"), null)
  await page.getByText("Enter a contact email to prepare requests").waitFor()
  await page.getByLabel("Contact email brokers will see").fill("jordan@example.com")
  assert.equal(await page.getByText("Enter a contact email to prepare requests").count(), 0, "the hint goes once filled")
  await page.getByText("Requests can be prepared once setup is complete").waitFor()
  console.log("ok: disabled actions explain themselves")

  // Request states: captions, recorded sessions, and the ways out.
  assert.match(await row(page, "Queue prepared").innerText(), /approve before we submit/)
  // The inline preview is clipped; approval must be able to see the whole form.
  const fullPreview = row(page, "Queue prepared").getByRole("link", { name: "Open the full preview" })
  assert.equal(await fullPreview.getAttribute("target"), "_blank")
  const previewResponse = await page.request.get(new URL((await fullPreview.getAttribute("href"))!, base).href)
  assert.equal(previewResponse.headers()["content-type"], "image/png", "the link opens the evidence image")
  const waitingRow = row(page, "Queue waiting")
  assert.doesNotMatch(await waitingRow.innerText(), /approve before we submit/, "only a pending preview asks for approval")
  assert.match(await waitingRow.innerText(), /Recorded Solari sessions — submit sess_submit_W/)
  // "No email after a day or two?" needs a date to count from.
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium" })
  assert.match(await waitingRow.innerText(), new RegExp(`Started ${day(backdated)} · last change ${day(now)}`))
  assert.match(await row(page, "Queue prepared").innerText(), new RegExp(`Started ${day(now)}\n`), "one date when nothing changed since")
  assert.doesNotMatch(await row(page, "Queue not started").innerText(), /Started/, "no date before any request")
  await waitingRow.getByLabel("Confirmation link from the broker’s email").waitFor()
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
  assert.match(await verification.innerText(), /Queue waiting — relisted: it was gone and came back/, "events read as sentences")
  // Brokers appear by name, never by internal id.
  assert.match(await verification.innerText(), /Spokeo: Queue still listed/)
  assert.equal((await card(page, "hint-strong").locator(".eyebrow").innerText()).trim(), "SPOKEO")
  assert.match(await page.locator("section", { hasText: "Scan history" }).innerText(), /Spokeo: found/)
  assert.match(await row(page, "Queue prepared").innerText(), /^Queue prepared\nSpokeo\n/)
  console.log("ok: the rescan diff names each listing and skips not-you records")

  // A crash page or a stopped server reads as that, not as a JSON parse error.
  const failWith = async (handler: (route: import("playwright-core").Route) => Promise<void>) => {
    await page.route("**/api/state", (route) => route.request().method() === "POST" ? handler(route) : route.continue())
    await button(card(page, "hint-strong"), "This is me").click()
  }
  await failWith((route) => route.fulfill({ status: 500, contentType: "text/html", body: "<!doctype html><title>Error</title>" }))
  await page.getByRole("alert").filter({ hasText: "The local app answered with an error (500)" }).waitFor()
  await page.unroute("**/api/state")
  await failWith((route) => route.abort())
  await page.getByRole("alert").filter({ hasText: "Could not reach the local app" }).waitFor()
  await page.unroute("**/api/state")
  console.log("ok: server errors and a stopped server are named plainly")

  // History shows the latest five scans until asked for all of them.
  const history = page.locator("section", { hasText: "Scan history" })
  assert.equal(await history.locator(".card").count(), 5)
  assert.match(await history.locator(".card").first().innerText(), /· rescan —/, "newest scan first")
  // Each broker result links to what the broker showed; the scans without evidence do not.
  const resultShot = history.locator(".card").first().getByRole("link", { name: "Spokeo results screenshot" })
  assert.equal((await page.request.get(new URL((await resultShot.getAttribute("href"))!, base).href)).status(), 200)
  assert.equal(await history.getByRole("link").count(), 1, "no links to missing evidence")
  await history.getByRole("button", { name: "Show all 7 scans" }).click()
  assert.equal(await history.locator(".card").count(), 7)
  console.log("ok: scan history stays short until expanded")

  // The selected profile's records download as a JSON file.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download records" }).click()])
  assert.match(download.suggestedFilename(), /^privacy-janitor-jordan-example-\d{4}-\d{2}-\d{2}\.json$/)
  const downloaded = JSON.parse(readFileSync((await download.path())!, "utf8"))
  assert.equal(downloaded.profile.fullName, person)
  console.log("ok: records download for the selected profile")

  // At phone width the profile actions wrap instead of pushing the page sideways.
  await page.setViewportSize({ width: 375, height: 800 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), "no horizontal scroll at 375px")
  await page.setViewportSize({ width: 1280, height: 900 })

  // Opening the profile form moves focus into it; cancelling returns it.
  const addProfile = page.getByRole("button", { name: "+ Add profile" })
  assert.equal(await addProfile.getAttribute("aria-expanded"), "false")
  await addProfile.click()
  assert.equal(await addProfile.getAttribute("aria-expanded"), "true")
  assert.equal(await page.evaluate(() => document.activeElement?.closest("label")?.textContent?.trim()), "Full name")
  // A rejected save is explained inside the form, where the fix is made.
  const profileForm = page.locator("#profile-form")
  await profileForm.getByLabel("Full name", { exact: true }).fill("Riley Sample")
  await profileForm.getByLabel("City", { exact: true }).fill("Austin")
  await profileForm.getByLabel("State", { exact: true }).fill("TX")
  await profileForm.getByLabel(/^Age range/).fill("45-40")
  await profileForm.getByRole("checkbox").check()
  await profileForm.getByRole("button", { name: "Add profile", exact: true }).click()
  await profileForm.getByRole("alert").filter({ hasText: "40-45" }).waitFor()
  assert.equal(await page.getByRole("alert").filter({ hasText: "Something went wrong" }).filter({ hasText: "40-45" }).count(), 0,
    "not in the banner above")
  await page.locator("#profile-form").getByRole("button", { name: "Cancel", exact: true }).click()
  assert.equal(await addProfile.getAttribute("aria-expanded"), "false")
  assert.ok(await addProfile.evaluate((el) => el === document.activeElement), "focus returns to the button that opened the form")
  console.log("ok: the profile form takes and returns keyboard focus")

  // With no key configured, setup advice asks for one.
  assert.match(await page.locator('section[aria-label="Setup checks"]').innerText(), /add your SOLARI_API_KEY/)
  // A key still set to the example value is not "missing": say to replace it.
  assert.match(await page.locator('section[aria-label="Setup checks"]').innerText(), /replace the example Groq key to enable/)
  assert.deepEqual(pageErrors, [], "no uncaught page errors")

  // Deletion is permanent, so its confirmation points to keeping a copy first.
  const dialogs: string[] = []
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss() })
  await page.getByRole("button", { name: "Delete profile" }).click()
  await page.getByRole("button", { name: "Reset all" }).click()
  assert.equal(dialogs.length, 2)
  for (const message of dialogs) assert.match(message, /Download records first/)
  assert.equal(await page.getByRole("button", { name: /^Jordan Example/ }).count(), 1, "dismissing deletes nothing")

  // While a scan runs, deletion waits for it, and the page says so up front
  // rather than after a confirmation dialog.
  store.createScanRun("id_ui", "scan")
  store.closeDb()
  await page.reload()
  await page.getByText("Scan running").waitFor()
  assert.ok(await page.getByRole("button", { name: "Delete profile" }).isDisabled())
  assert.ok(await page.getByRole("button", { name: "Reset all" }).isDisabled())
  await page.getByText("Deleting and resetting wait until scans and broker actions finish.").waitFor()
  console.log("ok: deletion waits for running work, and says so")

  // Another origin cannot frame the dashboard to disguise a click.
  const attacker = await browser.newPage()
  await attacker.setContent(`<iframe src="${base}/" width="800" height="600"></iframe>`)
  await attacker.waitForTimeout(1500)
  const framed = attacker.frames().find((frame) => frame !== attacker.mainFrame())
  assert.ok(!(await framed?.locator("body").innerText().catch(() => ""))?.includes("PrivacyJanitor"), "dashboard refused to render in a frame")
  console.log("ok: setup advice, no page errors, and no framing by other sites")
  console.log("UI checks passed: match hints, undo, WCAG 2.1 AA, request states, rescan diff, broker names, setup advice, framing")
} catch (error) {
  // CI uploads this screenshot so a failure can be seen, not only read; the
  // page only ever holds the synthetic profile above.
  const screenshot = process.env.PJ_UI_FAILURE_SCREENSHOT
  if (screenshot && openPage) await openPage.screenshot({ path: screenshot, fullPage: true }).catch(() => {})
  throw error
} finally {
  await browser.close()
  if (child.exitCode === null) child.kill()
  await exited.catch(() => {})
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
