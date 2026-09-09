import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrokerAdapter, BrokerPage, Identity, Listing } from "../src/types.ts"
import type { withBrokerSession } from "../src/engine/solari.ts"

const directory = mkdtempSync(join(tmpdir(), "pj-workflow-"))
process.env.PJ_DATA_DIR = directory
const store = await import("../src/store/index.ts")
const { createOptOutService } = await import("../src/engine/optouts.ts")
const now = new Date().toISOString()
const identity: Identity = { id: "test-person", fullName: "Jordan Example", city: "Chicago", stateCode: "IL", createdAt: now }
let preparedCount = 0
let submittedCount = 0
let confirmedCount = 0
let throwAfterSubmit = false
let throwOnClose = false
const pins: string[] = []
const page = { screenshot: async () => Buffer.from("synthetic") } as BrokerPage
const adapter: BrokerAdapter = {
  id: "spokeo", name: "Synthetic broker", homepage: "https://www.spokeo.com", optOutInfo: "Test only",
  expectsEmailConfirmation: true,
  scan: async () => ({ outcome: "inconclusive", listings: [] }),
  verifyMatch: () => 1,
  async prepareOptOut() { preparedCount++; return { screenshot: Buffer.from("synthetic"), summary: "Synthetic preview" } },
  async submitOptOut() {
    submittedCount++
    if (throwAfterSubmit) throw new Error("connection dropped after click")
    return { ok: true, message: "Request received", needsEmailConfirmation: true }
  },
  async confirmByEmail() { confirmedCount++ },
}
const withSession: typeof withBrokerSession = async (name, callback, options = {}) => {
  const evidence = {
    runId: name, evidenceDir: join(directory, name), sessionId: "synthetic-session",
    proxySessionId: options.proxySessionId ?? "synthetic-pin", stealth: false,
    screenshot: (label: string) => join(directory, name, `${label}.png`),
  }
  pins.push(evidence.proxySessionId)
  const result = await callback(page, evidence, {} as never)
  if (throwOnClose) throw new Error("browser close failed")
  return { result, evidence }
}
const service = createOptOutService({ withSession, adapterFor: () => adapter })
function listing(id: string, confirmedMine: boolean | null = true): Listing {
  const record: Listing = {
    id, identityId: identity.id, brokerId: adapter.id, url: `https://www.spokeo.com/test/${id}`,
    displayName: identity.fullName, exposedData: {}, confirmedMine, firstSeenAt: now, lastSeenAt: now,
  }
  store.upsertListing(record)
  return record
}

try {
  store.saveIdentity(identity)
  listing("happy")
  const [first, duplicate] = await Promise.all([
    service.prepare("happy", "jordan@example.com"), service.prepare("happy", "jordan@example.com"),
  ])
  assert.equal(first.id, duplicate.id)
  assert.equal(preparedCount, 1, "double preparation shares one browser run")
  assert.equal(store.getPreparedOptOut("happy")?.submissionId, first.id)
  service.approve("happy", first.id)
  service.approve("happy", first.id)
  await service.waitForIdle()
  assert.equal(submittedCount, 1, "duplicate approval cannot click twice")
  assert.equal(store.getSubmission(first.id)?.status, "awaiting_email")
  assert.equal(pins[0], pins[1], "prepare and submit keep the persisted proxy label")
  assert.equal(store.getPreparedOptOut("happy"), undefined)
  assert.throws(() => service.confirm("happy", first.id, "https://evil.example/confirm"))
  service.confirm("happy", first.id, "https://www.spokeo.com/confirm?test=synthetic")
  service.confirm("happy", first.id, "https://www.spokeo.com/confirm?test=synthetic")
  await service.waitForIdle()
  assert.equal(confirmedCount, 1)
  assert.equal(store.getSubmission(first.id)?.status, "confirmed")
  console.log("ok: concurrent preparation, approval and confirmation are idempotent")

  listing("unconfirmed", null)
  await assert.rejects(service.prepare("unconfirmed", "jordan@example.com"), /confirm/)
  listing("changed")
  const changed = await service.prepare("changed", "jordan@example.com")
  store.saveIdentity({ ...identity, city: "Austin" })
  assert.throws(() => service.approve("changed", changed.id), /changed/)
  store.cancelSubmission("changed", changed.id)
  assert.equal(store.getPreparedOptOut("changed"), undefined)
  assert.equal(store.getSubmission(changed.id)?.status, "cancelled")
  store.saveIdentity(identity)
  const fresh = await service.prepare("changed", "jordan@example.com")
  assert.notEqual(fresh.id, changed.id)
  assert.throws(() => service.approve("changed", changed.id), /superseded/)
  store.cancelSubmission("changed", fresh.id)
  console.log("ok: confirmation, preview freshness, cancellation and exact attempt checks")

  listing("uncertain")
  const uncertain = await service.prepare("uncertain", "jordan@example.com")
  throwAfterSubmit = true
  service.approve("uncertain", uncertain.id)
  await service.waitForIdle()
  assert.equal(store.getSubmission(uncertain.id)?.status, "attention_required")
  assert.throws(() => service.approve("uncertain", uncertain.id), /acknowledge/)
  const countBeforeResume = submittedCount
  service.resume()
  await service.waitForIdle()
  assert.equal(submittedCount, countBeforeResume, "uncertain actions never auto-resume")
  throwAfterSubmit = false
  service.approve("uncertain", uncertain.id, true)
  await service.waitForIdle()
  assert.equal(store.getSubmission(uncertain.id)?.status, "awaiting_email")
  assert.equal(store.getSubmission(uncertain.id)?.lastError, undefined)
  assert.equal(store.getSubmission(uncertain.id)?.attempts, 2)
  console.log("ok: ambiguous broker failures require explicit retry and clear old errors")

  listing("restart")
  const restart = await service.prepare("restart", "jordan@example.com")
  store.transitionSubmission(restart.id, "prepared", "approved")
  store.transitionSubmission(restart.id, "approved", "submitting")
  store.closeDb()
  assert.equal(store.getSubmission(restart.id)?.status, "attention_required")
  assert.equal(store.getSubmission(restart.id)?.attentionOperation, "submit")
  assert.equal(store.getPreparedOptOut("restart")?.submissionId, restart.id)
  const afterRestart = submittedCount
  service.resume()
  await service.waitForIdle()
  assert.equal(submittedCount, afterRestart)
  console.log("ok: restart converts in-flight work into a reviewable state")

  listing("queued")
  const queued = await service.prepare("queued", "jordan@example.com")
  store.transitionSubmission(queued.id, "prepared", "approved")
  store.closeDb()
  assert.equal(store.getSubmission(queued.id)?.status, "approved")
  throwOnClose = true
  service.resume()
  await service.waitForIdle()
  assert.equal(store.getSubmission(queued.id)?.status, "awaiting_email", "cleanup failure cannot overwrite a saved receipt")
  throwOnClose = false
  console.log("ok: approved work resumes; a browser-close failure retains the receipt")
} finally {
  await service.waitForIdle()
  store.closeDb()
  rmSync(directory, { recursive: true, force: true })
}
